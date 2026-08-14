// test/memory/test-snapshot.mjs
//
// CBM-3 §17 — Store Snapshot Digest contract:
//   deterministic projection（recordId/logicalKey/contentHash/recordType/trust/
//   validity/scope/relationship/conflict state）; excludes rowid / WAL position /
//   mtime / absolute DB path / FTS score / latency / wall-clock timing;
//   insertion-order invariant; rebuild invariant.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalMemoryStore,
  MEMORY_QUERY_SCHEMA,
  insertRelationship,
  applyLifecycleEvent,
  buildLifecycleEvent,
} from "../../src/memory/index.mjs";
import { codeRecord, relationship, REPO, TREE } from "./helpers-cbm3.mjs";

const ROOTS = [];
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "cbm3-snap-"));
  ROOTS.push(root);
  return root;
}
const silent = { info() {}, warn() {}, error() {} };
function store(root) {
  return new LocalMemoryStore({ stateRoot: root, log: silent });
}

before(() => {});
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

test("N1. snapshot digest covers records in recordId order (canonical)", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const a = codeRecord({ path: "src/a.mjs" });
  const b = codeRecord({ path: "src/b.mjs" });
  s.explicitImport(a);
  s.explicitImport(b);
  const snap = s.snapshot();
  assert.match(snap.storeSnapshotDigest, /^[0-9a-f]{64}$/);
  assert.equal(snap.recordCount, 2);
  const proj = snapshotProjectionPublic(s.db);
  assert.deepEqual(proj.records.map((r) => r.recordId), [a.recordId, b.recordId].sort(), "records ordered by recordId");
  s.close();
});

import { snapshotProjection } from "../../src/memory/index.mjs";
function snapshotProjectionPublic(db) {
  return snapshotProjection(db);
}

test("N2. snapshot digest is insertion-order invariant (A,B,C,D vs D,B,A,C)", () => {
  const recs = [
    codeRecord({ path: "src/a.mjs", statement: "A" }),
    codeRecord({ path: "src/b.mjs", statement: "B" }),
    codeRecord({ path: "src/c.mjs", statement: "C" }),
    codeRecord({ path: "src/d.mjs", statement: "D" }),
  ];
  const rootA = freshRoot();
  const rootB = freshRoot();
  const s1 = store(rootA);
  s1.open();
  const s2 = store(rootB);
  s2.open();
  for (const r of recs) s1.explicitImport(r);
  for (const r of [recs[3], recs[1], recs[0], recs[2]]) s2.explicitImport(r);
  assert.equal(s1.snapshot().storeSnapshotDigest, s2.snapshot().storeSnapshotDigest, "insertion order must not change the snapshot digest");
  s1.close();
  s2.close();
});

test("N3. relationships and conflict state are part of the digest", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const a = codeRecord({ path: "src/a.mjs" });
  const b = codeRecord({ path: "src/b.mjs" });
  s.explicitImport(a);
  s.explicitImport(b);
  const before = s.snapshot().storeSnapshotDigest;
  insertRelationship(s.db, relationship({ id: "r1", recordId: a.recordId, targetRecordId: b.recordId, type: "SUPERSEDES" }));
  const afterRel = s.snapshot().storeSnapshotDigest;
  assert.notEqual(afterRel, before, "relationship state must be digest-relevant");
  s.close();
});

test("N4. lifecycle state change (promotion) changes the digest", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const a = codeRecord({ path: "src/a.mjs", trust: "VERIFIED" });
  s.explicitImport(a);
  const before = s.snapshot().storeSnapshotDigest;
  const ev = buildLifecycleEvent({
    recordId: a.recordId,
    eventType: "PROMOTED",
    previousState: "VERIFIED",
    newState: "REVIEWED",
    reason: "independent review PASS",
    authority: "INDEPENDENT_REVIEWER",
    evidenceIdentity: "e".repeat(64),
  });
  applyLifecycleEvent(s.db, ev);
  const after = s.snapshot().storeSnapshotDigest;
  assert.notEqual(after, before, "trust state is digest-relevant");
  s.close();
});

test("N5. tampered sqlite (trust column) changes the digest — digest detects store drift", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const a = codeRecord({ path: "src/a.mjs", trust: "VERIFIED" });
  s.explicitImport(a);
  const before = s.snapshot().storeSnapshotDigest;
  s.db.prepare("UPDATE memory_records SET trust = 'CONFIRMED', trust_rank = 4 WHERE record_id = ?").run(a.recordId);
  const after = s.snapshot().storeSnapshotDigest;
  assert.notEqual(after, before, "sqlite drift must be observable via the digest");
  s.close();
});

test("N6. digest excludes absolute path / mtime / WAL internals", () => {
  const rootA = freshRoot();
  const rootB = freshRoot();
  const s1 = store(rootA);
  s1.open();
  const s2 = store(rootB);
  s2.open();
  const rec = codeRecord({ path: "src/a.mjs" });
  s1.explicitImport(rec);
  s2.explicitImport(rec);
  assert.equal(s1.snapshot().storeSnapshotDigest, s2.snapshot().storeSnapshotDigest, "absolute state root must NOT enter the digest");
  s1.close();
  s2.close();
});
