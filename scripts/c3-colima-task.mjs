#!/usr/bin/env node
// scripts/c3-colima-task.mjs
//
// OFFICIAL C3 entrypoint for running a Colima-backed task through the AegisFlow
// lifecycle pipeline (read-only tasks AND isolated-worktree writer tasks).
// The bake-off test runner is NOT part of this path.
//
// Usage:
//   node scripts/c3-colima-task.mjs --card ./task-card.json [--profile autoloop-c3]
//                                   [--scratch <dir>] [--repo <checkout>]
//                                   [--out <dir>] [--timeout-ms 90000]
//
//   --card path.json       task card with { id?, executionId?, runtime: {...} }
//                          runtime.mode = "readonly" | "writer"; runtime.command
//                          runs via `sh -c` inside the isolated container;
//                          runtime.expect.stdoutContains = [...markers] for the
//                          deterministic reviewer.
//   --out <dir>            where the structured result JSON is written
//                          (default: $AEGISFLOW_C3_RESULTS_DIR, else <AEGISFLOW_HOME>/review/governance/c3-results
//                          falls back to ./c3-results)
//
// Exit code 0 iff final === PASS; 1 otherwise.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runColimaTask } from "../src/runtime/colima-pipeline.mjs";
import { fileURLToPath } from "node:url";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOME = homedir();
const cardPath = arg("--card", null);
const profile = arg("--profile", "autoloop-c3");
const repoPath = arg("--repo", fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, ""));
const scratchRoot = arg("--scratch", `${HOME}/autoloop-runtime`);
const timeoutMs = Number(arg("--timeout-ms", "90000"));
// Brand name wins; AUTOLOOP_C3_RESULTS_DIR is the pre-rename fallback.
const outDir = arg("--out", join(
  process.env.AEGISFLOW_C3_RESULTS_DIR
    ?? process.env.AUTOLOOP_C3_RESULTS_DIR
    ?? join(homedir(), ".autoloop", "review", "governance", "c3-results"),
));

if (!cardPath) {
  console.error("usage: node scripts/c3-colima-task.mjs --card <task-card.json> [--profile autoloop-c3] [--repo ...] [--scratch ...] [--out ...] [--timeout-ms ...]");
  process.exit(2);
}

const { readFileSync } = await import("node:fs");
let taskCard;
try {
  taskCard = JSON.parse(readFileSync(cardPath, "utf8"));
} catch (e) {
  console.error(`cannot read/parse --card ${cardPath}: ${e.message}`);
  process.exit(2);
}

const result = await runColimaTask({ taskCard, profile, repoPath, scratchRoot, timeoutMs });
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${result.executionId}.json`);
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

console.log(`\nC3 result (${result.mode}): final=${result.final} executionId=${result.executionId}`);
console.log(`  phaseExecutionId: ${result.phaseExecutionId}`);
console.log(`  instance: ${result.instance.profile} @ ${result.instance.socket}`);
if (result.reason) console.log(`  reason: ${result.reason}`);
if (result.output?.worktree) {
  console.log(`  worktree files: ${result.output.worktree.files.length} | diff: ${result.output.worktree.diff || "(empty)"}`);
}
if (result.cleanup) {
  console.log(`  cleanup: containersFound=${result.cleanup.containersFound} removed=${result.cleanup.containersRemoved} worktreeRevoked=${result.cleanup.worktreeRevoked} instanceAlive=${result.cleanup.instanceAlive}`);
}
console.log(`result file: ${outPath}`);
process.exit(result.final === "PASS" ? 0 : 1);
