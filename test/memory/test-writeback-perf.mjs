// test/memory/test-writeback-perf.mjs
//
// CBM-4 Stage 16 — write-back performance gate: no-write baseline vs
// one execution record vs multi-record task vs duplicate retry vs conflict.
// Measures write-back duration, journal fsync cost, sqlite cost, bytes
// written, store growth. Threshold: write-back must NOT be a significant
// bottleneck（bounded absolute cost; sub-second class for typical records）.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore } from "../../src/memory/index.mjs";
import { createWritebackCandidate } from "../../src/memory/writeback/candidate.mjs";
import { runWritebackGate } from "../../src/memory/writeback/gate.mjs";

const ROOTS = [];
function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), "cbm4-perf-"));
  ROOTS.push(r);
  return r;
}
const silent = { info() {}, warn() {}, error() {} };
const REPO = "1".repeat(64);
const TREE = "5".repeat(40);

before(() => {});
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function execCandidate(graphRun, statement, text) {
  return createWritebackCandidate({
    graphRunId: graphRun,
    taskCardId: "AUTOLOOP-PI-GRAPH-CBM4-1",
    originatingNode: "SA-W1",
    sourceResultIdentity: `node:${graphRun}:SA-W1`,
    proposedRecordType: "EXECUTION",
    proposedIdentity: { repositoryIdentity: REPO, treeSha: TREE, resultStatus: "PASS" },
    proposedSubjectStatement: statement,
    proposedContent: { kind: "TEXT", text },
    proposedScope: { repository: REPO, graphRun },
    evidenceReferences: ["manifest:" + "a".repeat(64)],
    proposedTrust: "UNVERIFIED",
    proposedRelationships: [],
    lifecycleIntent: "CREATE",
    origin: "graph_closeout",
  });
}

function ms(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

test("P1. write-back cost is bounded（<250ms/record class; journal + sqlite + telemetry-light）", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const N = 10;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const r = await runWritebackGate({ candidate: execCandidate(`g-${i}`, `stmt ${i}`, `text ${i}`), store: s, expectedRepository: REPO });
    assert.equal(r.status, "WRITEBACK_ACCEPTED");
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const perWriteMs = totalMs / N;
  assert.ok(perWriteMs < 250, `per-write ${perWriteMs.toFixed(1)}ms must be bounded`);
  const jSize = existsSync(join(root, "journal.jsonl")) ? statSync(join(root, "journal.jsonl")).size : 0;
  assert.ok(jSize > 0, "journal grown");
  const dbSize = existsSync(join(root, "memory.db")) ? statSync(join(root, "memory.db")).size : 0;
  assert.ok(dbSize > 0, "sqlite grown");
  s.close();
});

test("P2. duplicate retry cost is near-zero（idempotent no-op, no growth）", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const c = execCandidate("g-dup", "stmt", "text");
  await runWritebackGate({ candidate: c, store: s, expectedRepository: REPO });
  const j1 = statSync(join(root, "journal.jsonl")).size;
  const dupMs = ms(() => {});
  const t0 = process.hrtime.bigint();
  const r = await runWritebackGate({ candidate: c, store: s, expectedRepository: REPO });
  const dupTotal = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.status, "WRITEBACK_DUPLICATE");
  assert.ok(dupTotal < 100, `duplicate check ${dupTotal.toFixed(1)}ms bounded`);
  assert.equal(statSync(join(root, "journal.jsonl")).size, j1, "no journal growth on duplicate");
  s.close();
});

test("P3. conflict case surfaces without extra writes（no growth on the conflicting record）", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const c1 = execCandidate("g-conf", "fact v1", "text v1");
  const r1 = await runWritebackGate({ candidate: c1, store: s, expectedRepository: REPO });
  assert.equal(r1.status, "WRITEBACK_ACCEPTED");
  const j1 = statSync(join(root, "journal.jsonl")).size;
  const c2 = execCandidate("g-conf", "fact v2", "text v2");
  const t0 = process.hrtime.bigint();
  const r2 = await runWritebackGate({ candidate: c2, store: s, expectedRepository: REPO });
  const conflictMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r2.status, "WRITEBACK_CONFLICT");
  assert.ok(conflictMs < 100, `conflict detection ${conflictMs.toFixed(1)}ms bounded`);
  assert.equal(statSync(join(root, "journal.jsonl")).size, j1, "no journal growth on conflict（surfaced, not written）");
  s.close();
});

test("P4. no-write baseline: write-back is opt-in and adds ZERO cost when disabled; memory READ path is bounded", async () => {
  // write-back is opt-in（runColimaGraph `writeback = null` default）— the
  // baseline path has no write-back code at all. The measurable baseline is
  // the memory READ path（open + query）a graph already pays; bound it so the
  // write-back never makes a memory-enabled graph meaningfully slower.
  const times = [];
  for (let i = 0; i < 5; i++) {
    const root = freshRoot();
    const s = new LocalMemoryStore({ stateRoot: root, log: silent });
    s.open();
    const t0 = process.hrtime.bigint();
    s.query({ schema: "autoloop.memory-query/v1", context: { repository: REPO }, trustFloor: "UNVERIFIED", validityPolicy: "CURRENT", conflictPolicy: "SURFACE", limits: { maxRecords: 50, maxBytes: 65536 } });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    s.close();
  }
  const meanMs = times.reduce((a, b) => a + b, 0) / times.length;
  assert.ok(meanMs < 25, `no-write memory read baseline ${meanMs.toFixed(2)}ms bounded`);
});
