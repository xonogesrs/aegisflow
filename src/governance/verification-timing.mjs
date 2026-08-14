// src/governance/verification-timing.mjs
//
// VCA-1 W1A (S2) — real timing instrumentation for verification evidence.
//
// Before this module, verification evidence（*-verification.json）carried
// only a `verifiedAt` timestamp — no wall time. Historical per-gate cost was
// therefore NOT_INSTRUMENTED（VCA-1 R2 finding）. This module is the single
// place that turns a measured start/end into structured timing fields so
// every verify gate and accounting consumer records the SAME honest shape:
//
//   startedAt  — ISO instant when the work began
//   completedAt— ISO instant when the work ended
//   wallMs     — real elapsed milliseconds（completedAt - startedAt）
//   timingSource — "MEASURED"（never fabricated）
//
// `runSuiteSync` runs a node --test command and returns pass/fail accounting
// PLUS measured timing — used by the V17 regression loops and by the
// colima-all scope gate. It never invents durations: a suite that fails to
// run records whatever the process reported and the real elapsed wall time.

import { execFileSync } from "node:child_process";

/**
 * Structured timing fields from two measured instants. Never called with
 * fabricated values — callers must pass real Date.now() snapshots.
 */
export function timingFields(startedAtMs, completedAtMs) {
  const s = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  const e = Number.isFinite(completedAtMs) ? completedAtMs : Date.now();
  return {
    startedAt: new Date(s).toISOString(),
    completedAt: new Date(e).toISOString(),
    wallMs: Math.max(0, Math.round(e - s)),
    timingSource: "MEASURED",
  };
}

/** Parse node --test output into { tests, passed, failed }. */
export function parseNodeTestOut(out) {
  const m = String(out ?? "").match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
  const tests = m ? Number(m[1]) : 0;
  const passed = m ? Number(m[2]) : 0;
  const failed = m ? Number(m[3]) : -1;
  return { tests, passed, failed: failed < 0 ? tests - passed : failed };
}

/**
 * Run a node --test suite synchronously and return accounting + REAL timing.
 * `cmd` is an argv array（e.g. ["node", "--test", "test/governance/*.mjs"]）.
 * A non-zero exit still returns the parsed output（callers decide green-ness
 * via `ok && tests > 0 && failed === 0`, preserving the verify gates'
 * semantics）. The child env is sanitized of the parent test-runner context
 * vars（NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID）so a suite spawned from
 * inside a node --test run still produces real output.
 */
export function runSuiteSync(cmd, { cwd, timeoutMs = 1800000 } = {}) {
  const startedAtMs = Date.now();
  let out = "";
  let ok = false;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  try {
    out = execFileSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8", timeout: timeoutMs, env });
    ok = true;
  } catch (e) {
    out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
  }
  const completedAtMs = Date.now();
  return { ok, out, ...parseNodeTestOut(out), ...timingFields(startedAtMs, completedAtMs) };
}

/**
 * Aggregate timing across a list of measured records（e.g. a V17 suite run）.
 * Returns the sum of wallMs plus the bounded window; never estimates.
 */
export function aggregateTiming(records = []) {
  const measured = records.filter((r) => r && Number.isFinite(r.wallMs) && r.wallMs >= 0);
  const wallMs = measured.reduce((a, r) => a + r.wallMs, 0);
  const startedAt = records.find((r) => r && r.startedAt)?.startedAt ?? null;
  const completedAt = records.find((r) => r && r.completedAt)?.completedAt ?? null;
  return { wallMs, startedAt, completedAt, timingSource: records.length ? "MEASURED" : "NONE" };
}
