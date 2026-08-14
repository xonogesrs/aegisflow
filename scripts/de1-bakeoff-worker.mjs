// scripts/de1-bakeoff-worker.mjs
//
// DE-1 Stage 7 — bake-off WORKER child process. Runs the EXISTING durable
// AutoLoop pipeline (runDurableAutoLoop, Candidate A) over the shared
// workload and writes a marker file so the harness can kill it at precise
// points. The harness never runs this interactively except for the baseline
// (no-kill) run.
//
// Usage: node scripts/de1-bakeoff-worker.mjs <config.json>
// config.json: { root, executionId, sidefxDir, writerResult?, readyFile }

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runDurableAutoLoop } from "../src/v2/durable-execution.mjs";
import { bakeoffIr, decompositionAdapterFor, makeAdapterFactories, SOURCE, PARENT, MANIFEST_REQ, HARNESS_HOOKS } from "./de1-bakeoff-workload.mjs";

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: node scripts/de1-bakeoff-worker.mjs <config.json>");
  process.exit(2);
}
const cfg = JSON.parse((await import("node:fs")).readFileSync(configPath, "utf8"));

// Signal readiness so the harness knows the process is up.
mkdirSync(dirname(cfg.readyFile), { recursive: true });
writeFileSync(cfg.readyFile, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");

const ir = bakeoffIr();
const factories = makeAdapterFactories({ sidefxDir: cfg.sidefxDir, writerResult: cfg.writerResult ?? "PASS", executorSleepMs: cfg.executorSleepMs ?? 0 });
const hooks = { ...HARNESS_HOOKS };

try {
  const result = await runDurableAutoLoop({
    source: SOURCE,
    parent: PARENT,
    manifest: MANIFEST_REQ,
    cwd: cfg.repo,
    decompositionAdapter: decompositionAdapterFor(ir),
    executorAdapterFactory: factories.executorAdapterFactory,
    reviewerAdapterFactory: factories.reviewerAdapterFactory,
    maxRepairAttempts: cfg.maxRepairAttempts ?? 0,
    timeoutMs: 30000,
    signal: undefined,
    hooks,
    persistence: { root: cfg.root, executionId: cfg.executionId },
  });
  writeFileSync(cfg.doneFile, JSON.stringify({ final: result.final, stage: result.stage, reason: result.reason, executionId: result.executionId }, null, 2), "utf8");
  process.exit(result.final === "PASS" ? 0 : 1);
} catch (e) {
  writeFileSync(cfg.doneFile, JSON.stringify({ error: String(e?.message ?? e), code: e?.code ?? null }), "utf8");
  process.exit(2);
}
