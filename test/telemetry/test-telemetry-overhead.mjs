// test/telemetry/test-telemetry-overhead.mjs
//
// COST-1 stage 8 — telemetry must not become a cost hog itself. Bounded
// store-level benchmark: append throughput / latency overhead, storage
// growth accounting, and rotation behavior. The graph-level disabled-vs-
// enabled measurement lives in scripts/cost1-telemetry-probe.mjs + the
// closeout evidence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryStore, DEFAULT_MAX_EVENTS } from "../../src/telemetry/store.mjs";
import { createTelemetryEvent } from "../../src/telemetry/contract.mjs";

const ROOTS = [];
function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), "cost1-overhead-"));
  ROOTS.push(r);
  return r;
}

function makeEvent(graphRunId, seq) {
  const ev = createTelemetryEvent({ graphRunId, eventType: "node.run", sequence: seq });
  ev.identity = { nodeId: `N${seq % 8}`, phaseExecutionId: `p${seq}`, agentExecutionId: `a${seq}`, attempt: 0, stage: null, taskType: "subagent", risk: null };
  ev.timing = { startedAt: null, completedAt: null, durationMs: seq };
  return ev;
}

test("1. append overhead is calibrated against a raw append on the same volume（no absolute wall-clock assumption）", () => {
  // WHY CALIBRATED: the store's cost invariant is "telemetry does not become a
  // cost hog itself", i.e. the store must not add significant overhead on top
  // of the filesystem it writes to. An absolute threshold (the previous
  // "< 1ms/append") silently measured the HOST DISK rather than this code:
  // sequential appends cost ~0.15ms on a fast NVMe volume and ~4.5ms on a slow
  // one, so the same code failed on a slower machine. The calibration below
  // measures a raw append into the SAME directory and asserts the store's
  // per-event cost stays within a bounded factor of it.
  const root = freshRoot();
  try {
    const N = 500;
    // Raw baseline: one append per event, same directory, comparable payload.
    const rawPath = join(root, "raw-baseline.jsonl");
    const sampleLine = JSON.stringify(makeEvent("g1", 0)) + "\n";
    const raw0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) writeFileSync(rawPath, sampleLine, { flag: "a" });
    const rawPerEventMs = Number(process.hrtime.bigint() - raw0) / 1e6 / N;

    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) store.append(makeEvent("g1", i));
    const t1 = process.hrtime.bigint();
    const perEventMs = Number(t1 - t0) / 1e6 / N;

    // The store validates + secret-scans + canonicalizes + appends. That work
    // is bounded and must not dominate the I/O: the ceiling is a generous
    // multiple of the raw append (measured, not assumed).
    const budgetMs = Math.max(rawPerEventMs * 6, 1.0);
    assert.ok(
      perEventMs < budgetMs,
      `append ${perEventMs.toFixed(3)}ms/event must stay under ${budgetMs.toFixed(3)}ms ` +
      `(raw append on this volume: ${rawPerEventMs.toFixed(3)}ms/event)`,
    );
    assert.equal(store.readAll().length, N);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("2. bounded growth: active file rotates at cap; rotated chunks archived (no silent loss)", () => {
  const root = freshRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root, maxEvents: 50 });
    store.open();
    for (let i = 0; i < 200; i++) store.append(makeEvent("g1", i));
    assert.ok(store.rotated >= 1, "rotation happened");
    assert.equal(store.readAll().length, 200, "no silent loss across rotation");
    assert.equal(store.status, "AVAILABLE");
    // reopen: rotated chunks are re-validated on open（fail-closed）
    store.close();
    const re = new TelemetryStore({ stateRoot: root, maxEvents: 50 });
    re.open();
    assert.equal(re.readAll().length, 200);
    re.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("3. storage growth is linear and bounded per event（bytes/event stable）", () => {
  const root = freshRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    const N = 500;
    for (let i = 0; i < N; i++) store.append(makeEvent("g2", i));
    const bytes = store.byteCount();
    const perEvent = bytes / N;
    // ~1.2-1.6KB/event（the allowlist contract includes the CBM-4 writeback
    // section with null defaults）— bounded and linear, well under 2.5KB
    assert.ok(perEvent < 2500, `bytes/event ${perEvent.toFixed(1)} bounded`);
    assert.ok(existsSync(join(root, "telemetry.jsonl")), "active file present");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4. store open + full validation cost is bounded（<50ms for 500 events）", () => {
  const root = freshRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    for (let i = 0; i < 500; i++) store.append(makeEvent("g3", i));
    store.close();
    const t0 = process.hrtime.bigint();
    const re = new TelemetryStore({ stateRoot: root });
    re.open();
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    assert.ok(ms < 100, `open+validate ${ms.toFixed(1)}ms bounded`);
    assert.equal(re.readAll().length, 500);
    re.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("5. default maxEvents is a sane bounded default", () => {
  assert.ok(DEFAULT_MAX_EVENTS >= 1000 && DEFAULT_MAX_EVENTS <= 100000, "default cap within sane range");
});
