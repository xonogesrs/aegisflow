// test/memory/test-rebuild-determinism.mjs
//
// CBM-3 §25-§27 — Deterministic Rebuild / Restart / Insertion-order evidence:
//   Store A → query Q → R1/D1; delete sqlite → rebuild from canonical JSONL →
//   Store B → same Q → R2/D2 with R1==R2 and D1==D2.
//   open→query→close→open→same query → identical result + digest.
//   Same records in different legal insertion orders → identical selection /
//   conflict groups / snapshot digest / retrieval digest.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalMemoryStore,
  MEMORY_QUERY_SCHEMA,
  validateMemoryQueryV1,
} from "../../src/memory/index.mjs";
import { codeRecord, conflictPair, REPO, TREE } from "./helpers-cbm3.mjs";

const ROOTS = [];
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "cbm3-det-"));
  ROOTS.push(root);
  return root;
}
const silent = { info() {}, warn() {}, error() {} };
function store(root) {
  return new LocalMemoryStore({ stateRoot: root, log: silent });
}
const q = (over = {}) => validateMemoryQueryV1({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO, tree: TREE }, ...over }).query;

before(() => {});
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

test("D1. restart determinism: open→query→close→open→same query gives identical result + digest", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ path: "src/a.mjs", trust: "VERIFIED" }));
  s.explicitImport(codeRecord({ path: "src/b.mjs", trust: "REVIEWED" }));
  s.explicitImport(codeRecord({ path: "src/c.mjs", trust: "CONFIRMED" }));
  const query = q({ terms: "statement" });
  const r1 = s.query(query);
  s.close();
  const s2 = store(root);
  s2.open();
  const r2 = s2.query(query);
  s2.close();
  assert.equal(r2.retrievalDigest, r1.retrievalDigest, "retrieval digest identical across restart");
  assert.equal(r2.storeSnapshotDigest, r1.storeSnapshotDigest, "snapshot digest identical across restart");
  assert.deepEqual(r2.selectedRecords.map((x) => x.recordId), r1.selectedRecords.map((x) => x.recordId));
  assert.deepEqual(r2.conflictGroups, r1.conflictGroups);
});

test("D2. sqlite rebuild from JSONL: R1==R2 and D1==D2 (card §25)", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const recs = [
    codeRecord({ path: "src/a.mjs", statement: "alpha binding" }),
    codeRecord({ path: "src/b.mjs", statement: "beta binding" }),
    codeRecord({ path: "src/c.mjs", statement: "gamma binding" }),
  ];
  for (const r of recs) s.explicitImport(r);
  const query = q({ terms: "binding" });
  const r1 = s.query(query);
  const snap1 = s.snapshot();
  const journalPath = s.journalPath;
  s.close();
  // delete rebuildable sqlite; journal remains
  rmSync(join(root, "memory.db"), { force: true });
  rmSync(join(root, "memory.db-wal"), { force: true });
  rmSync(join(root, "memory.db-shm"), { force: true });
  // Store B: fresh open triggers rebuild from canonical JSONL
  const s2 = store(root);
  s2.open();
  const r2 = s2.query(query);
  const snap2 = s2.snapshot();
  s2.close();
  assert.deepEqual(r2.selectedRecords.map((x) => x.recordId), r1.selectedRecords.map((x) => x.recordId), "R1 == R2");
  assert.equal(r2.retrievalDigest, r1.retrievalDigest, "D1 == D2 (retrieval digest)");
  assert.equal(snap2.storeSnapshotDigest, snap1.storeSnapshotDigest, "snapshot digest identical after rebuild");
  assert.ok(journalPath.length > 0);
});

test("D3. insertion-order determinism: same records, different legal order → identical everything", () => {
  const recs = [
    codeRecord({ path: "src/a.mjs", statement: "alpha" }),
    codeRecord({ path: "src/b.mjs", statement: "beta" }),
    codeRecord({ path: "src/c.mjs", statement: "gamma" }),
    codeRecord({ path: "src/d.mjs", statement: "delta" }),
  ];
  const [ca, cb] = conflictPair();
  const rootA = freshRoot();
  const rootB = freshRoot();
  const s1 = store(rootA);
  s1.open();
  const s2 = store(rootB);
  s2.open();
  // Store A insertion order: A,B,C,D + conflict pair
  for (const r of [...recs, ca, cb]) s1.explicitImport(r);
  // Store B insertion order: D,B,A,C + conflict pair reversed
  for (const r of [recs[3], recs[1], recs[0], recs[2], cb, ca]) s2.explicitImport(r);
  const query = q({ terms: "binding" });
  const r1 = s1.query(query);
  const r2 = s2.query(query);
  assert.equal(r1.storeSnapshotDigest, r2.storeSnapshotDigest, "snapshot digest insertion-order invariant");
  assert.deepEqual(r1.selectedRecords.map((x) => x.recordId), r2.selectedRecords.map((x) => x.recordId), "selected order identical");
  assert.deepEqual(r1.conflictGroups, r2.conflictGroups, "conflict groups identical");
  assert.equal(r1.retrievalDigest, r2.retrievalDigest, "retrieval digest identical");
  s1.close();
  s2.close();
});

test("D4. FTS matching + tie-break: same query with FTS terms stays deterministic across rebuild", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  for (let i = 0; i < 8; i++) {
    s.explicitImport(codeRecord({ path: `src/tie-${String(i).padStart(2, "0")}.mjs`, statement: "deterministic retrieval engine", text: "shared text body" }));
  }
  const query = q({ terms: "deterministic retrieval" });
  const r1 = s.query(query);
  const ids1 = r1.selectedRecords.map((x) => x.recordId);
  assert.equal(ids1.length, 8, "all records match the lexical terms");
  // tie-break: all records equal on every rank element → recordId ascending
  const sorted = [...ids1].sort();
  assert.deepEqual(ids1, sorted, "stable recordId tie-break");
  // rebuild → identical order
  const rb = s.rebuildFromJournal();
  const r2 = s.query(query);
  assert.deepEqual(r2.selectedRecords.map((x) => x.recordId), ids1);
  assert.equal(r2.retrievalDigest, r1.retrievalDigest);
  s.close();
});

test("D5. retrieval digest binds query identity + snapshot + selection + conflicts + exclusions", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ path: "src/a.mjs" }));
  const q1 = q({ terms: "alpha" });
  const q2 = q({ terms: "beta" });
  const r1 = s.query(q1);
  const r2 = s.query(q2);
  assert.notEqual(r1.retrievalDigest, r2.retrievalDigest, "different queries → different retrieval digest");
  // adding a record changes the snapshot → digest changes for the same query
  s.explicitImport(codeRecord({ path: "src/b.mjs", statement: "another alpha binding" }));
  const r3 = s.query(q1);
  assert.notEqual(r3.retrievalDigest, r1.retrievalDigest, "store change → different retrieval digest");
  assert.notEqual(r3.storeSnapshotDigest, r1.storeSnapshotDigest);
  s.close();
});
