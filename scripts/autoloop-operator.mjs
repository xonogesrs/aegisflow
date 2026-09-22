#!/usr/bin/env node
// scripts/autoloop-operator.mjs
//
// R-07 — THE supported operator entrypoint over the production telemetry
// backbone.
//
// Card: AUTOLOOP_R07_TELEMETRY_AGGREGATE_OPERATOR_SURFACE_LARGE_IMPLEMENTATION_AND_CLOSEOUT_1.
//
//   node scripts/autoloop-operator.mjs --run <graphRunId> [--json] [--root <dir>]
//
//   --run <graphRunId>   REQUIRED — the run identity to inspect.
//   --json               machine-readable report (autoloop.telemetry-operator-report/v1).
//                        Default: human-readable summary.
//   --root <dir>         OPTIONAL explicit telemetry root override. It flows
//                        through THE existing validated S16 semantics
//                        (AUTOLOOP_TELEMETRY_STATE_ROOT as consumed by
//                        src/telemetry/location.mjs): the override is the
//                        EXACT store root (absolute, never $HOME, never a
//                        repo worktree) — no new validation regime. Without
//                        it the canonical namespace child for graphRunId is
//                        used.
//
// READ ONLY / ADVISORY (Phase D authority fence): the command performs zero
// writes and zero mutations; it never retries, repairs, triggers rollover,
// changes budget, or touches lifecycle/closeout/verdict/promotion. No
// downstream production authority consumes its output. Safe to execute
// against an active run, a completed run, a partially retained run, a
// telemetry-disabled run, and an unknown graphRunId.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildOperatorReport, renderOperatorReportText } from "../src/telemetry/operator-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

const usage = () => {
  console.error("usage:");
  console.error("  node scripts/autoloop-operator.mjs --run <graphRunId> [--json] [--root <dir>]");
  process.exit(2);
};

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
const graphRunId = arg("--run");
if (!graphRunId || graphRunId.trim().length === 0) usage();
const asJson = process.argv.includes("--json");
const rootOverride = arg("--root");

// S16 override semantics require an ABSOLUTE root; a relative --root would
// resolve against the CLI's cwd and silently create a repo-local fallback —
// exactly the fallback the S16 fence forbids. Fail closed instead.
if (rootOverride && !rootOverride.startsWith("/")) usage();
const env = rootOverride
  ? { ...process.env, AUTOLOOP_TELEMETRY_STATE_ROOT: resolve(rootOverride) }
  : process.env;

const report = buildOperatorReport({ graphRunId, env });

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderOperatorReportText(report));
}

// Advisory surface: exit 0 whenever a safe report was produced (including
// UNKNOWN/diagnostic outcomes — an absent or degraded run is a valid
// operator answer, not a command failure). Exit nonzero only when even a
// safe report could not be constructed.
process.exit(report && report.schema ? 0 : 1);
