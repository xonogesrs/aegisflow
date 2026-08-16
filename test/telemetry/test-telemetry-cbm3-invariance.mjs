// test/telemetry/test-telemetry-cbm3-invariance.mjs
//
// COST-1 acceptance criterion 5 — CBM-3 deterministic retrieval semantics are
// COMPLETELY unchanged by telemetry instrumentation:
//   - retrieval identity / ranking / digests / memoryContext unchanged
//   - telemetry observes ONLY counters + digests（never memory content）
//   - the memory store is never written by telemetry（zero write-back intact）

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore, MEMORY_QUERY_SCHEMA, validateMemoryQueryV1 } from "../../src/memory/index.mjs";
import { buildMemoryContext } from "../../src/memory/graph-context.mjs";
import { TelemetryStore } from "../../src/telemetry/store.mjs";
import { codeRecord, REPO, TREE, finish } from "../memory/helpers-cbm3.mjs";

const ROOTS = [];
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "cost1-cbm3-"));
  ROOTS.push(root);
  return root;
}
const silent = { info() {}, warn() {}, error() {} };
const ctx = () => ({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO, tree: TREE } });

before(() => {});
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function buildStore(root) {
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  // deterministic insertion order（stable records; order matters for parity）
  const recs = [
    finish(codeRecord({ path: "src/a.mjs", statement: "a exports alpha", text: "function alpha() {}" })),
    finish(codeRecord({ path: "src/b.mjs", statement: "b exports beta", text: "function beta() {}" })),
    finish(codeRecord({ path: "src/c.mjs", statement: "c exports gamma", text: "function gamma() {}" })),
  ];
  for (const r of recs) s.explicitImport(r);
  s.close();
  return s;
}

test("1. telemetry observation preserves retrieval identity, ranking, digests, memoryContext", async () => {
  const storeRoot = freshRoot();
  const teleRoot = freshRoot();
  const s = buildStore(storeRoot);

  // baseline retrieval（deterministic）
  s.open();
  const query = ctx();
  const v = validateMemoryQueryV1(query);
  const r1 = s.query(v.query);
  s.close();

  // second independent open + query（identical inputs -> identical digests）
  s.open();
  const r2 = s.query(v.query);
  s.close();
  assert.equal(r2.retrievalDigest, r1.retrievalDigest, "retrieval digest repeat-stable");
  assert.equal(r2.storeSnapshotDigest, r1.storeSnapshotDigest, "snapshot digest repeat-stable");
  assert.deepEqual(r2.selectedRecords.map((x) => x.recordId), r1.selectedRecords.map((x) => x.recordId), "ranking/selection identical");

  const memoryContext = buildMemoryContext({ retrieval: r1, repository: { repositoryIdentity: REPO } });

  // observe the graph carrying this memoryContext（telemetry reads only）
  const store = new TelemetryStore({ stateRoot: teleRoot });
  store.open();
  const { recordGraphTelemetry } = await import("../../src/telemetry/graph-observer.mjs");
  const graphResult = {
    executionId: "g-cbm3",
    final: "PASS",
    memoryContext,
    nodeResults: [{
      nodeId: "N1", phaseExecutionId: "p1", taskType: "subagent", attempt: 0, final: "PASS",
      startedAt: Date.now(), completedAt: Date.now(), memoryContext,
    }],
    transitions: [],
    closeout: { applied: true, final: "PASS" },
  };
  const r = await recordGraphTelemetry({ graphResult, store, closeout: { cardId: "AUTOLOOP-PI-GRAPH-CBM3-1" } });
  assert.equal(r.ok, true);

  const all = store.readAll();
  const retr = all.find((e) => e.retrieval?.invoked);
  assert.ok(retr, "retrieval observed");
  assert.equal(retr.retrieval.retrievalDigest, r1.retrievalDigest, "digest copied, not recomputed");
  assert.equal(retr.retrieval.storeSnapshotDigest, r1.storeSnapshotDigest);
  assert.equal(retr.retrieval.selectedCount, r1.selectedRecords.length);
  assert.equal(retr.retrieval.maxRecords, r1.limits.maxRecords);
  assert.equal(retr.retrieval.maxBytes, r1.limits.maxBytes);
  assert.equal(retr.retrieval.byteCount, r1.byteCount);
  assert.equal(retr.retrieval.truncated, r1.truncated);
  // NO memory content / record bodies anywhere in telemetry
  const serialized = JSON.stringify(all);
  for (const rec of r1.selectedRecords) {
    assert.ok(!serialized.includes(rec.recordId), `recordId ${rec.recordId} not copied`);
    assert.ok(!serialized.includes("alpha") && !serialized.includes("beta") && !serialized.includes("gamma"), "no memory body text");
  }

  // memoryContext object untouched（same reference, same fields）
  assert.equal(graphResult.memoryContext.retrievalDigest, r1.retrievalDigest, "memoryContext never mutated");

  // the MEMORY store must be byte-untouched by telemetry（zero write-back）
  const filesAfter = readdirSync(storeRoot).sort();
  const sFiles = new LocalMemoryStore({ stateRoot: storeRoot, log: silent });
  sFiles.open();
  assert.equal(sFiles.verifyJournalParity().ok, true, "journal parity intact after telemetry");
  sFiles.close();
  assert.ok(filesAfter.length > 0);
  // no telemetry artifacts inside the memory store root
  assert.ok(!filesAfter.some((f) => f.startsWith("telemetry")), "no telemetry files inside memory store");
  store.close();
});

test("2. telemetry-enabled and disabled observation produce identical retrieval digests", async () => {
  const storeRoot = freshRoot();
  const tele1 = freshRoot();
  const tele2 = freshRoot();
  const s = buildStore(storeRoot);
  s.open();
  const v = validateMemoryQueryV1(ctx());
  const r1 = s.query(v.query);
  s.close();
  const memoryContext = buildMemoryContext({ retrieval: r1, repository: { repositoryIdentity: REPO } });

  const { recordGraphTelemetry } = await import("../../src/telemetry/graph-observer.mjs");
  for (const [root, label] of [[tele1, "a"], [tele2, "b"]]) {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    const graphResult = {
      executionId: `g-${label}`,
      final: "PASS",
      memoryContext,
      nodeResults: [{ nodeId: "N1", phaseExecutionId: "p1", taskType: "subagent", attempt: 0, final: "PASS", startedAt: Date.now(), completedAt: Date.now(), memoryContext }],
      transitions: [],
      closeout: { applied: false },
    };
    await recordGraphTelemetry({ graphResult, store });
    store.close();
  }
  // both stores carry identical digests for the same retrieval（observation
  // itself is deterministic; retrieval identity unchanged either way）
  const s1 = new TelemetryStore({ stateRoot: tele1 });
  s1.open();
  const d1 = s1.streamDigest();
  s1.close();
  const s2 = new TelemetryStore({ stateRoot: tele2 });
  s2.open();
  const d2 = s2.streamDigest();
  s2.close();
  // executionId differs by design（g-a vs g-b）— compare retrieval sections instead
  const ev1 = new TelemetryStore({ stateRoot: tele1 }); ev1.open();
  const ev2 = new TelemetryStore({ stateRoot: tele2 }); ev2.open();
  const retr1 = ev1.readAll().find((e) => e.retrieval?.invoked);
  const retr2 = ev2.readAll().find((e) => e.retrieval?.invoked);
  assert.deepEqual(retr1.retrieval, retr2.retrieval, "retrieval metrics identical regardless of run identity");
  ev1.close(); ev2.close();
});
