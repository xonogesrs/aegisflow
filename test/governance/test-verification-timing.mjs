// test/governance/test-verification-timing.mjs
//
// VCA-1 W1A (S2) — real timing instrumentation for verification evidence.
//
// Proves:
//   1. timingFields produces structured startedAt/completedAt/wallMs with
//      timingSource "MEASURED" from real instants（never fabricated）;
//   2. parseNodeTestOut parses node --test accounting;
//   3. runSuiteSync records REAL elapsed wallMs for an actual suite run
//      (>= 0, startedAt <= completedAt, timingSource MEASURED);
//   4. aggregateTiming sums measured records and never estimates.
//
// Run: node --test test/governance/test-verification-timing.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  timingFields,
  parseNodeTestOut,
  runSuiteSync,
  aggregateTiming,
} from "../../src/governance/verification-timing.mjs";

const REPO = "/Volumes/NVM2T/Development/autoloop";

test("S2/1: timingFields records MEASURED start/completed/wallMs from real instants", () => {
  const start = Date.now() - 1234;
  const done = Date.now();
  const t = timingFields(start, done);
  assert.equal(t.timingSource, "MEASURED");
  assert.equal(t.wallMs, 1234);
  assert.equal(t.startedAt, new Date(start).toISOString());
  assert.equal(t.completedAt, new Date(done).toISOString());
  assert.ok(t.completedAt >= t.startedAt);
});

test("S2/2: timingFields never fabricates negative wall time", () => {
  const t = timingFields(Date.now(), Date.now() - 5000);
  assert.equal(t.wallMs, 0);
  assert.equal(t.timingSource, "MEASURED");
});

test("S2/3: parseNodeTestOut extracts tests/pass/fail", () => {
  const out = "ℹ tests 3\nℹ suites 1\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 42\n";
  const p = parseNodeTestOut(out);
  assert.deepEqual(p, { tests: 3, passed: 3, failed: 0 });
});

test("S2/4: runSuiteSync runs a real suite and records measured wallMs", () => {
  const r = runSuiteSync(["node", "--test", "test/governance/test-git-status-parsing.mjs"], { cwd: REPO, timeoutMs: 120000 });
  assert.equal(r.ok, true);
  assert.equal(r.failed, 0);
  assert.ok(r.tests > 0, "suite ran tests");
  assert.equal(r.timingSource, "MEASURED");
  assert.ok(r.wallMs >= 0, "wallMs is a real measured value");
  assert.ok(r.startedAt <= r.completedAt);
  assert.ok(r.completedAt >= r.startedAt);
});

test("S2/5: runSuiteSync failure still returns parsed output + real timing", () => {
  const r = runSuiteSync(["node", "--test", "test/governance/does-not-exist.mjs"], { cwd: REPO, timeoutMs: 30000 });
  assert.equal(r.ok, false);
  assert.equal(r.timingSource, "MEASURED");
  assert.ok(r.wallMs >= 0);
});

test("S2/6: aggregateTiming sums measured wallMs without estimating", () => {
  const a = aggregateTiming([
    { wallMs: 100, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.100Z" },
    { wallMs: 250, startedAt: "2026-01-01T00:00:01.000Z", completedAt: "2026-01-01T00:00:01.250Z" },
  ]);
  assert.equal(a.wallMs, 350);
  assert.equal(a.timingSource, "MEASURED");
  const empty = aggregateTiming([]);
  assert.equal(empty.wallMs, 0);
  assert.equal(empty.timingSource, "NONE");
});
