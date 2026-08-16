// scripts/de2-crash-worker.mjs
//
// DE-2 crash-matrix worker — runs runDurableGraph OR resumeDurableGraph in a
// CHILD process so the matrix can SIGKILL real processes (Stage 18/25).
//
//   node scripts/de2-crash-worker.mjs --config <cfg.json>
//
// cfg: {
//   mode: "run" | "resume",
//   point, executionId, repoPath, scratchRoot, persistenceRoot,
//   crashOn: <event_type|null>,        // run mode: self-SIGKILL before the
//                                      // checkpoint that follows this event
//   crashDelayMs: <ms|null>,           // run mode: kill N ms after start
//   irVariant: "normal" | "repair",    // run mode
// }
//
// Self-SIGKILL is a REAL process death（no cleanup, no exit handlers）.

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createColimaExecutorAdapter } from "../src/runtime/colima-executor-adapter.mjs";
import { createColimaReviewerAdapter } from "../src/runtime/colima-reviewer-adapter.mjs";
import { runDurableGraph, resumeDurableGraph } from "../src/v2/durable-graph.mjs";

const HOME = homedir();
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null; };
const cfg = JSON.parse(readFileSync(arg("--config"), "utf8"));

const PROFILE = "autoloop-graph";
const REPO_A = cfg.repoPath;
const SCRATCH = cfg.scratchRoot;
mkdirSync(SCRATCH, { recursive: true });

const PARENT = { scope: { allowed_paths: ["docs/"], forbidden_paths: [".git"] } };

const roCommand = (nodeId, sleep) => [
  `sleep ${sleep}`,
  `echo "${nodeId}_DONE"`,
  'touch /src/.de2-probe 2>&1 && echo SRC_WRITABLE || echo SRC_WRITE_DENIED',
  'touch /scratch/probe.txt && echo SCRATCH_OK',
].join("; ");

const roPhase = (phaseId, dependsOn = [], sleep = 5) => ({
  phase_id: phaseId,
  depends_on: dependsOn,
  effects: { artifact_mutation: "none" },
  runtime: { mode: "readonly", command: roCommand(phaseId, sleep), expect: { stdoutContains: [`${phaseId}_DONE`, "SRC_WRITE_DENIED"] }, limits: { memoryMiB: 256, timeoutMs: 60000 } },
});

const writerPhase = (phaseId, dependsOn = [], sleep = 5, expectOk = true) => ({
  phase_id: phaseId,
  depends_on: dependsOn,
  effects: { artifact_mutation: "required", boundaries: { artifact: ["docs/de2-crash-output"] } },
  runtime: {
    mode: "writer",
    command: `sleep ${sleep}; mkdir -p /work/docs/de2-crash-output && echo "W1_OUTPUT_$(date -u +%s)" > /work/docs/de2-crash-output/w1.md && cat /work/docs/de2-crash-output/w1.md; touch /src/.w1-probe 2>&1 || echo SRC_WRITE_DENIED`,
    expect: { stdoutContains: expectOk ? ["W1_OUTPUT", "SRC_WRITE_DENIED"] : ["NEVER_MATCHES_XYZ"] },
    limits: { memoryMiB: 256, timeoutMs: 60000 },
  },
});

function buildIr(variant) {
  if (variant === "repair") {
    // R1 expects a marker that never appears -> reviewer NEEDS_SUPPLEMENT ->
    // repair -> PHASE_REPAIR_REQUESTED（robust command: no /src probe）.
    return {
      verdict: "PASS",
      phases: [
        { ...roPhase("R1", [], 3), runtime: { mode: "readonly", command: "sleep 3; echo R1_DONE", expect: { stdoutContains: ["R1_NEVER_MARKER"] }, limits: { memoryMiB: 256, timeoutMs: 60000 } } },
      ],
      dispositions: [],
    };
  }
  return {
    verdict: "PASS",
    phases: [roPhase("R1", [], 5), writerPhase("W1", ["R1"], 5), roPhase("V1", ["W1"], 3)],
    dispositions: [],
  };
}

const execFactory = ({ resultSink } = {}) => () => createColimaExecutorAdapter({
  profile: PROFILE,
  repoPath: REPO_A,
  scratchRoot: SCRATCH,
  resultSink: resultSink ?? (() => {}),
});
const revFactory = () => createColimaReviewerAdapter();

async function main() {
  const common = {
    parent: PARENT,
    manifest: [{ requirement_id: "r1", text: "de2 crash matrix" }],
    cwd: REPO_A,
    repoPath: REPO_A,
    scratchRoot: SCRATCH,
    maxRepairAttempts: 1,
    timeoutMs: 120000,
    signal: undefined,
    executorAdapterFactory: execFactory,
    reviewerAdapterFactory: revFactory,
    dirtyScope: [],
    closeout: null, memory: null, telemetry: null, writeback: null,
    preserveInstance: cfg.preserveInstance ?? false,
  };

  if (cfg.mode === "run") {
    const hooks = {
      // crash-injection seam: self-SIGKILL before the checkpoint that
      // follows the target event（journal->checkpoint sub-window crash）.
      onDurableEvent: async ({ event_type }) => {
        if (cfg.crashOn) {
          if (event_type === cfg.crashOn) {
            cfg._count = (cfg._count ?? 0) + 1;
            if ((cfg.crashOnCount ?? 1) <= cfg._count) {
              console.log(`CRASH_TRIGGERED:${event_type}#${cfg._count}`);
              process.stdout.write("");
              process.kill(process.pid, "SIGKILL");
            }
          }
        }
      },
    };
    if (cfg.crashDelayMs) {
      console.log(`CRASH_DELAY_ARMED:${cfg.crashDelayMs}`);
      setTimeout(() => process.kill(process.pid, "SIGKILL"), cfg.crashDelayMs);
    }
    const result = await runDurableGraph({
      ...common,
      ir: buildIr(cfg.irVariant ?? "normal"),
      persistence: { root: cfg.persistenceRoot, executionId: cfg.executionId },
      hooks,
    });
    console.log(`RUN_FINAL:${result.final}`);
    process.exit(0);
  }

  if (cfg.mode === "resume") {
    const result = await resumeDurableGraph({
      ...common,
      persistenceRoot: cfg.persistenceRoot,
      executionId: cfg.executionId,
      hooks: {},
    });
    console.log(`RESUME_FINAL:${result.final}`);
    console.log(`RESUME_RECOVERY:${JSON.stringify(result.recovery ?? {})}`);
    console.log(`RESUME_EVIDENCE:${JSON.stringify({ checkpoint_revision: result.evidence?.checkpoint_revision, final_verdict: result.evidence?.final_verdict, recovery_manifest: !!result.evidence?.recovery_manifest })}`);
    process.exit(result.final === "PASS" ? 0 : 0); // matrix decides; never hide result
  }

  process.exit(2);
}

main().catch((e) => { console.error(`WORKER_ERROR:${e?.code || e?.name || "unknown"}:${(e?.message || "").slice(0, 200)}`); process.exit(1); });
