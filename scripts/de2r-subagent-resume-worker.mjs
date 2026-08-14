// scripts/de2r-subagent-resume-worker.mjs
//
// DE-2R sub-agent resume probe worker — runs runSubagentGraph（PRODUCTION
// durable path）OR resumeSubagentGraph（PRODUCTION fresh-process resume
// entry）in a CHILD process so the probe can SIGKILL real processes
//（Stage 18/25-style genuine process death; no cleanup, no exit handlers）.
//
//   node scripts/de2r-subagent-resume-worker.mjs --config <cfg.json>
//
// cfg: {
//   mode: "run" | "resume",
//   point, executionId, repoPath, scratchRoot, persistenceRoot,
//   crashOn: <event_type|null>,        // run mode: self-SIGKILL before the
//                                      // checkpoint that follows this event
//   crashOnPhase: <phase_id|null>,     // run mode: only crash for this phase
//   crashOnCount: <n|null>,            // run mode: crash on the n-th match
// }
//
// The sub-agent graph mirrors the production Autonomous-Research graph shape:
// SA-R1 ‖ SA-R2（read-only analysts）-> SA-W1（writer sub-agent + independent
// review agent）-> SA-V1（read-only verifier over the shared results dir）.

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runSubagentGraph, resumeSubagentGraph } from "../src/subagent/subagent-graph-runner.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null; };
const cfg = JSON.parse(readFileSync(arg("--config"), "utf8"));

const PROFILE = "autoloop-graph";
const SCOPE = "docs/pi-graph-output/de2r-crash-output";
const PARENT = { scope: { allowed_paths: [SCOPE], forbidden_paths: [".git"] } };

function roPhase(phaseId, taskType, dependsOn = []) {
  return {
    phase_id: phaseId,
    depends_on: dependsOn,
    effects: { artifact_mutation: "none" },
    runtime: {
      mode: "subagent",
      taskType,
      objective: `read-only ${taskType} over /src/docs`,
      expect: { stdoutContains: [`SUBAGENT_DONE:${taskType}`] },
      limits: { memoryMiB: 256, timeoutMs: 60000 },
      sleep: 3,
      agentRole: "readonly-analyst",
    },
  };
}

function writerPhase(phaseId, dependsOn) {
  return {
    phase_id: phaseId,
    depends_on: dependsOn,
    effects: { artifact_mutation: "required", boundaries: { artifact: [SCOPE] } },
    runtime: {
      mode: "subagent",
      agentRole: "writer",
      taskType: "write_report",
      objective: `writer write_report over /work/${SCOPE} using dependency results`,
      expect: { stdoutContains: ["SUBAGENT_DONE:write_report"] },
      limits: { memoryMiB: 256, timeoutMs: 60000 },
      sleep: 3,
    },
  };
}

const verifierPhase = {
  phase_id: "SA-V1",
  depends_on: ["SA-W1"],
  effects: { artifact_mutation: "none" },
  runtime: {
    mode: "subagent",
    agentRole: "verifier",
    taskType: "verify_writer",
    objective: "verify writer SA-W1 diff/tests/scope from /results artifacts",
    expect: { stdoutContains: ["SUBAGENT_DONE:verify_writer"] },
    limits: { memoryMiB: 256 },
  },
};

function buildIr() {
  return {
    verdict: "PASS",
    phases: [
      roPhase("SA-R1", "count_todos"),
      roPhase("SA-R2", "inventory_markdown"),
      writerPhase("SA-W1", ["SA-R1", "SA-R2"]),
      verifierPhase,
    ],
    dispositions: [],
  };
}

const common = {
  parent: PARENT,
  manifest: [{ requirement_id: "r1", text: "de2r sub-agent resume probe" }],
  cwd: cfg.repoPath,
  repoPath: cfg.repoPath,
  scratchRoot: cfg.scratchRoot,
  maxRepairAttempts: 1,
  timeoutMs: 120000,
  signal: undefined,
  dirtyScope: [],
  preserveInstance: true,
  closeout: null, memory: null, telemetry: null, writeback: null,
  persistence: { root: cfg.persistenceRoot },
};

async function main() {
  mkdirSync(cfg.scratchRoot, { recursive: true });

  if (cfg.mode === "run") {
    const hooks = {
      // crash-injection seam（same contract the durable layer exposes）:
      // self-SIGKILL before the checkpoint that follows the target event.
      onDurableEvent: async ({ event_type, phase_id }) => {
        if (cfg.crashOn) {
          if (event_type === cfg.crashOn && (!cfg.crashOnPhase || phase_id === cfg.crashOnPhase)) {
            cfg._count = (cfg._count ?? 0) + 1;
            if ((cfg.crashOnCount ?? 1) <= cfg._count) {
              console.log(`CRASH_TRIGGERED:${event_type}:${phase_id ?? "-"}#${cfg._count}`);
              process.stdout.write("");
              process.kill(process.pid, "SIGKILL");
            }
          }
        }
      },
    };
    const result = await runSubagentGraph({
      ...common,
      ir: buildIr(),
      executionId: cfg.executionId,
      hooks,
    });
    console.log(`RUN_FINAL:${result.final}`);
    process.exit(result.final === "PASS" ? 0 : 1);
  }

  if (cfg.mode === "resume") {
    // ── PRODUCTION FRESH-PROCESS RESUME ENTRY ───────────────────────────
    // resumeSubagentGraph re-injects the sub-agent wiring（resultsDir
    // persistence hooks + executor/reviewer dispatchers + independent review
    // agent）and continues the SAME graph identity from durable truth only.
    const result = await resumeSubagentGraph({
      ...common,
      executionId: cfg.executionId,
      hooks: {},
    });
    console.log(`RESUME_FINAL:${result.final}`);
    console.log(`RESUME_REASON:${result.reason ?? ""}`);
    console.log(`RESUME_RECOVERY:${JSON.stringify(result.recovery ?? {})}`);
    console.log(`RESUME_EVIDENCE:${JSON.stringify({ checkpoint_revision: result.evidence?.checkpoint_revision ?? null, final_verdict: result.evidence?.final_verdict ?? null, state: result.evidence?.state ?? null, recovery_manifest: !!result.evidence?.recovery_manifest })}`);
    // The probe decides; never hide the result behind an exit code.
    process.exit(0);
  }

  process.exit(2);
}

main().catch((e) => { console.error(`WORKER_ERROR:${e?.code || e?.name || "unknown"}:${(e?.message || "").slice(0, 200)}`); process.exit(1); });
