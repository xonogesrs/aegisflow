#!/usr/bin/env node
// scripts/multi-session-pre-wp1-worker.mjs
//
// PRE-WP1 A4 worker — runs runSubagentGraph (PRODUCTION durable path) OR
// resumeSubagentGraph (PRODUCTION fresh-process resume entry) in a CHILD
// process so the probe can SIGKILL real processes at a journal boundary.
//
//   node scripts/multi-session-pre-wp1-worker.mjs --config <cfg.json>

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runSubagentGraph, resumeSubagentGraph } from "../src/subagent/subagent-graph-runner.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null; };
const cfg = JSON.parse(readFileSync(arg("--config"), "utf8"));

const SCOPE = "docs/pi-graph-output";
const PARENT = { scope: { allowed_paths: [SCOPE], forbidden_paths: [".git"] } };

// Canonical sub-agent phase names (SA-R1 ‖ SA-R2 -> SA-W1 -> SA-V1) — the
// live production contract keys the writer/verifier agent programs and the
// review agent onto exactly these node ids.
function saReadonlyPhase(phaseId, taskType) {
  return {
    phase_id: phaseId,
    depends_on: [],
    effects: { artifact_mutation: "none" },
    runtime: {
      mode: "subagent",
      taskType,
      objective: `read-only ${taskType} over /src/docs`,
      expect: { stdoutContains: [`SUBAGENT_DONE:${taskType}`] },
      limits: { memoryMiB: 256, timeoutMs: 60000 },
      sleep: 1,
      agentRole: "readonly-analyst",
    },
  };
}

function saWriterPhase(dependsOn = ["SA-R1", "SA-R2"]) {
  return {
    phase_id: "SA-W1",
    depends_on: dependsOn,
    effects: { artifact_mutation: "required", boundaries: { artifact: [SCOPE] } },
    runtime: {
      mode: "subagent",
      agentRole: "writer",
      taskType: "write_report",
      objective: `writer write_report over /work/${SCOPE} using dependency results`,
      expect: { stdoutContains: ["SUBAGENT_DONE:write_report"] },
      limits: { memoryMiB: 256, timeoutMs: 60000 },
      sleep: 1,
    },
  };
}

function saVerifierPhase(dependsOn = ["SA-W1"]) {
  return {
    phase_id: "SA-V1",
    depends_on: dependsOn,
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
}

const buildIr = () => ({
  verdict: "PASS",
  phases: [saReadonlyPhase("SA-R1", "count_todos"), saReadonlyPhase("SA-R2", "inventory_markdown"), saWriterPhase(), saVerifierPhase()],
  dispositions: [],
});

const common = {
  parent: PARENT,
  manifest: [{ requirement_id: "r1", text: "pre-wp1 A4 durability probe" }],
  cwd: cfg.repoPath,
  repoPath: cfg.repoPath,
  scratchRoot: cfg.scratchRoot,
  maxRepairAttempts: 0,
  timeoutMs: 180000,
  signal: undefined,
  dirtyScope: [],
  persistence: { root: cfg.persistenceRoot },
};

async function main() {
  mkdirSync(cfg.scratchRoot, { recursive: true });

  if (cfg.mode === "run") {
    const hooks = {
      // crash-injection seam（same contract the durable layer exposes）:
      // self-SIGKILL before the checkpoint that follows the target event.
      onDurableEvent: async ({ event_type, phase_id }) => {
        if (cfg.crashOn && event_type === cfg.crashOn && (!cfg.crashOnPhase || phase_id === cfg.crashOnPhase)) {
          console.log(`CRASH_TRIGGERED:${event_type}:${phase_id ?? "-"}`);
          process.kill(process.pid, "SIGKILL");
        }
      },
    };
    const result = await runSubagentGraph({ ...common, ir: buildIr(), executionId: cfg.executionId, hooks });
    console.log(`RUN_FINAL:${result.final}`);
    process.exit(result.final === "PASS" ? 0 : 1);
  }

  if (cfg.mode === "resume") {
    // PRODUCTION FRESH-PROCESS RESUME ENTRY: re-injects the sub-agent wiring
    // (resultsDir persistence hooks + dispatchers) and continues the SAME
    // graph identity from durable truth only.
    const result = await resumeSubagentGraph({
      ...common,
      executionId: cfg.executionId,
      hooks: {},
    });
    console.log(`RESUME_FINAL:${result.final}`);
    console.log(`RESUME_REASON:${result.reason ?? ""}`);
    process.exit(0);
  }

  process.exit(2);
}

main().catch((e) => { console.error(`WORKER_ERROR:${e?.code || e?.name || "unknown"}:${(e?.message || "").slice(0, 200)}`); process.exit(1); });
