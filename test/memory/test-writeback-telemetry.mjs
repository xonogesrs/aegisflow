// test/memory/test-writeback-telemetry.mjs
//
// CBM-4 Stage 10 — memory.write-back telemetry（COST-1 substrate）:
// counters + identities + digests only（never memory content）; honest
// unknown semantics preserved; a broken telemetry store never changes the
// write-back result.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryStore } from "../../src/telemetry/store.mjs";
import { validateTelemetryEventV1 } from "../../src/telemetry/contract.mjs";
import { buildWritebackTelemetryEvent, recordWritebackTelemetry } from "../../src/memory/writeback/telemetry.mjs";

const ROOTS = [];
function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), "cbm4-tel-"));
  ROOTS.push(r);
  return r;
}
before(() => {});
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function outcomes() {
  return [
    { status: "WRITEBACK_ACCEPTED", recordId: "1".repeat(64), candidateType: "EXECUTION", resultingTrust: "REVIEWED", evidenceIdentityDigest: "2".repeat(64) },
    { status: "WRITEBACK_ACCEPTED", recordId: "3".repeat(64), candidateType: "CODE", resultingTrust: "REVIEWED", evidenceIdentityDigest: "2".repeat(64) },
    { status: "WRITEBACK_DUPLICATE", recordId: "1".repeat(64) },
    { status: "WRITEBACK_CONFLICT" },
    { status: "WRITEBACK_REJECTED" },
  ];
}

test("T1. memory.writeback event carries counters + identities, NEVER content", () => {
  const ev = buildWritebackTelemetryEvent({ graphRunId: "g1", outcomes: outcomes(), bytesWritten: 2048, durationMs: 37 });
  const v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(ev.eventType, "memory.writeback");
  assert.equal(ev.writeback.attemptedCount, 5);
  assert.equal(ev.writeback.acceptedCount, 2);
  assert.equal(ev.writeback.duplicateCount, 1);
  assert.equal(ev.writeback.conflictCount, 1);
  assert.equal(ev.writeback.rejectedCount, 1);
  assert.equal(ev.writeback.recordsWritten, 2);
  assert.equal(ev.writeback.bytesWritten, 2048);
  assert.equal(ev.writeback.durationMs, 37);
  assert.equal(ev.writeback.candidateType, "EXECUTION");
  assert.equal(ev.writeback.resultingTrust, "REVIEWED");
  assert.equal(ev.writeback.memoryRecordIdentity, "1".repeat(64));
  assert.equal(ev.writeback.failureCode, "WRITEBACK_CONFLICT");
  // no memory content anywhere（only counters + identities + digests）
  const ser = JSON.stringify(ev);
  assert.ok(!ser.includes("final PASS"), "no memory content");
  assert.ok(!ser.includes("text"), "no content fields");
});

test("T2. store round-trip: memory.writeback event appends + revalidates on reopen", () => {
  const root = freshRoot();
  const store = new TelemetryStore({ stateRoot: root });
  store.open();
  const ev = buildWritebackTelemetryEvent({ graphRunId: "g1", outcomes: outcomes() });
  store.append(ev);
  store.close();
  const re = new TelemetryStore({ stateRoot: root });
  re.open();
  const all = re.readAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].eventType, "memory.writeback");
  assert.equal(re.streamDigest(), re.streamDigest(), "digest stable");
  re.close();
});

test("T3. recordWritebackTelemetry is best-effort（broken store never changes write-back semantics）", () => {
  const root = freshRoot();
  const store = new TelemetryStore({ stateRoot: root });
  // store NOT opened -> append throws -> telemetry unavailable, not fatal
  const r = recordWritebackTelemetry({ telemetryStore: store, graphRunId: "g1", outcomes: outcomes() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "TELEMETRY_UNAVAILABLE");
  // without a telemetry store: no-op, still non-fatal
  const r2 = recordWritebackTelemetry({ telemetryStore: null, graphRunId: "g1", outcomes: [] });
  assert.equal(r2.ok, false);
});

test("T4. honest unknown semantics preserved（token/tool usage stay NOT_REPORTED）", () => {
  const ev = buildWritebackTelemetryEvent({ graphRunId: "g1", outcomes: outcomes() });
  assert.equal(ev.model.tokenSource, "NOT_REPORTED");
  assert.equal(ev.model.totalTokens, null);
  assert.equal(ev.tools.toolCallSource, "NOT_REPORTED");
  assert.equal(ev.tools.toolCallCount, null);
  const v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, true);
});

test("T5. secret-shaped content in write-back telemetry is rejected by the store", () => {
  const root = freshRoot();
  const store = new TelemetryStore({ stateRoot: root });
  store.open();
  const ev = buildWritebackTelemetryEvent({ graphRunId: "g1", outcomes: [] });
  ev.graph.cardTitle = "leak sk-abcdefghijklmnopqrstuvwxyz0123456789";
  assert.throws(() => store.append(ev), (e) => e.code === "TELEMETRY_SECRET_DETECTED");
  assert.equal(store.readAll().length, 0);
  store.close();
});
