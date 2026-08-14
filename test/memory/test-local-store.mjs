// test/memory/test-local-store.mjs
//
// CBM-3 §5-§7, §23-§24 — LocalMemoryStore: open/close/initialize/migrate/
// validate/get/query/snapshot/rebuildFromJournal/verifyJournalParity/
// explicitImport; crash recovery; fail-closed corruption handling; isolated
// temp state roots（never the production store, never a git worktree）.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalMemoryStore,
  MemoryStoreInvalidError,
  MEMORY_ERRORS,
  MEMORY_STORE_IDENTITY_SCHEMA,
  deriveStoreIdentity,
  MEMORY_QUERY_SCHEMA,
  validateMemoryRecordV1,
  readJournal,
  openMemoryDb,
  applyMigrations,
  insertRecord,
} from "../../src/memory/index.mjs";
import { codeRecord, executionRecord, decisionRecord, REPO, TREE } from "./helpers-cbm3.mjs";

const ROOTS = [];
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "cbm3-store-"));
  ROOTS.push(root);
  return root;
}
const silent = { info() {}, warn() {}, error() {} };
const ctx = () => ({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO, tree: TREE } });

before(() => {});
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function makeStore(root) {
  return new LocalMemoryStore({ stateRoot: root, log: silent });
}

test("S1. open creates isolated store root with sqlite + journal + identity", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  assert.ok(existsSync(join(root, "memory.db")), "memory.db created");
  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((t) => t.name);
  for (const t of ["memory_records", "memory_fts", "memory_migrations"]) assert.ok(tables.includes(t));
  assert.equal(s.storeIdentity, deriveStoreIdentity());
  assert.ok(/^[0-9a-f]{64}$/.test(s.storeIdentity));
  assert.equal(s.exists(), true);
  s.close();
});

test("S2. explicitImport validates + journals + stores; journal-first durability", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  const rec = codeRecord({ trust: "VERIFIED" });
  const v = validateMemoryRecordV1(rec, { authorizedDirs: [] });
  assert.equal(v.valid, true, v.errors.join(";"));
  const imp = s.explicitImport(rec);
  assert.equal(imp.imported, true);
  assert.equal(imp.journalSequence, 1);
  // journal file exists with 1 line
  const journal = readFileSync(join(root, "journal.jsonl"), "utf8");
  assert.equal(journal.trim().split("\n").length, 1);
  // get() returns the envelope
  assert.equal(s.get(rec.recordId).recordId, rec.recordId);
  s.close();
});

test("S3. explicitImport rejects invalid records (no journal append, no sqlite row)", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  const rec = codeRecord();
  delete rec.subject.contentHash; // invalidate
  assert.throws(() => s.explicitImport(rec), (e) => e.code === MEMORY_ERRORS.SCHEMA_INVALID);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM memory_records").get().n, 0);
  s.close();
});

test("S4. secret-bearing record rejected before journal append", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  const rec = codeRecord();
  rec.content.text = "export const KEY = \"sk-abcdefghijklmnopqrstuvwxyz123\";";
  rec.subject.contentHash = null; // will be recomputed but scan fails first
  assert.throws(() => s.explicitImport(rec), (e) => e.code === MEMORY_ERRORS.SECRET_DETECTED || e.code === MEMORY_ERRORS.SCHEMA_INVALID);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM memory_records").get().n, 0);
  assert.equal(existsSync(join(root, "journal.jsonl")), false, "journal must not exist after rejected import");
  s.close();
});

test("S5. explicitImport is idempotent for identical recordId", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  const rec = codeRecord();
  s.explicitImport(rec);
  const again = s.explicitImport(rec);
  assert.equal(again.imported, false, "duplicate upsert is a no-op");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM memory_records").get().n, 1);
  s.close();
});

test("S6. crash recovery: delete sqlite → reopen rebuilds from valid journal", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  for (const rec of [codeRecord({ path: "a.mjs" }), codeRecord({ path: "b.mjs" }), executionRecord()]) {
    s.explicitImport(rec);
  }
  const beforeSnap = s.snapshot();
  s.close();
  // simulate crash: remove sqlite (keep journal)
  rmSync(join(root, "memory.db"), { force: true });
  rmSync(join(root, "memory.db-wal"), { force: true });
  rmSync(join(root, "memory.db-shm"), { force: true });
  const s2 = makeStore(root);
  s2.open(); // must rebuild silently
  const afterSnap = s2.snapshot();
  assert.equal(afterSnap.storeSnapshotDigest, beforeSnap.storeSnapshotDigest, "rebuild must preserve snapshot digest");
  assert.equal(afterSnap.recordCount, 3);
  assert.equal(s2.lastRecovery?.action, "rebuilt_from_journal");
  s2.close();
});

test("S7. verifyJournalParity ok on a healthy store", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  s.explicitImport(codeRecord());
  const p = s.verifyJournalParity();
  assert.equal(p.ok, true);
  assert.equal(p.sqliteDigest, p.journalDigest);
  s.close();
});

test("S8. journal middle corruption → open fails closed (MEMORY_STORE_INVALID)", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  s.explicitImport(codeRecord({ path: "a.mjs" }));
  s.explicitImport(codeRecord({ path: "b.mjs" }));
  s.close();
  // corrupt the FIRST line (middle corruption semantics — any line that is
  // not the trailing partial line is a fail-closed chain break)
  const lines = readFileSync(join(root, "journal.jsonl"), "utf8").trim().split("\n");
  lines[0] = "{ corrupted JSON";
  writeFileSync(join(root, "journal.jsonl"), lines.join("\n") + "\n");
  assert.throws(() => makeStore(root).open(), (e) => e instanceof MemoryStoreInvalidError);
});

test("S9. journal sequence gap → open fails closed", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  s.explicitImport(codeRecord({ path: "a.mjs" }));
  s.explicitImport(codeRecord({ path: "b.mjs" }));
  s.close();
  const lines = readFileSync(join(root, "journal.jsonl"), "utf8").trim().split("\n");
  const ev = JSON.parse(lines[1]);
  ev.journalSequence = 99;
  lines[1] = JSON.stringify(ev);
  writeFileSync(join(root, "journal.jsonl"), lines.join("\n") + "\n");
  assert.throws(() => makeStore(root).open(), (e) => e instanceof MemoryStoreInvalidError && e.code === MEMORY_ERRORS.JOURNAL_CHAIN_INVALID);
});

test("S10. partial trailing line is defined behavior (recovery, not fatal)", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  s.explicitImport(codeRecord({ path: "a.mjs" }));
  s.close();
  // append a partial trailing line (crash mid-append)
  writeFileSync(join(root, "journal.jsonl"), readFileSync(join(root, "journal.jsonl"), "utf8") + "{\"truncated");
  const s2 = makeStore(root);
  s2.open(); // must NOT throw; trailing partial excluded
  const r = readJournal(join(root, "journal.jsonl"));
  assert.equal(r.partialTrailingLine, true);
  assert.equal(s2.snapshot().recordCount, 1);
  s2.close();
});

test("S11. sqlite with records but no journal → MEMORY_STORE_INVALID", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  s.explicitImport(codeRecord());
  s.close();
  rmSync(join(root, "journal.jsonl"), { force: true });
  assert.throws(() => makeStore(root).open(), (e) => e instanceof MemoryStoreInvalidError);
});

test("S12. sqlite ahead of journal (records absent from journal) → MEMORY_STORE_INVALID", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  s.explicitImport(codeRecord({ path: "a.mjs" }));
  s.close();
  // add a sqlite-only record by reopening the db directly
  const db = openMemoryDb(join(root, "memory.db"));
  applyMigrations(db);
  insertRecord(db, codeRecord({ path: "ghost.mjs" }), { validate: null });
  db.close();
  assert.throws(() => makeStore(root).open(), (e) => e instanceof MemoryStoreInvalidError);
});

test("S13. explicit rebuildFromJournal preserves retrieval identity", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  for (const rec of [codeRecord({ path: "a.mjs", trust: "VERIFIED" }), codeRecord({ path: "b.mjs", trust: "REVIEWED" })]) {
    s.explicitImport(rec);
  }
  const r1 = s.query(ctx());
  const snap1 = s.snapshot();
  const rb = s.rebuildFromJournal();
  assert.equal(rb.rebuilt, true);
  const r2 = s.query(ctx());
  assert.deepEqual(r2.selectedRecords.map((x) => x.recordId), r1.selectedRecords.map((x) => x.recordId));
  assert.equal(r2.retrievalDigest, r1.retrievalDigest, "retrieval digest equal after rebuild");
  assert.equal(s.snapshot().storeSnapshotDigest, snap1.storeSnapshotDigest);
  s.close();
});

test("S14. store identity is stable and schema-bound", () => {
  assert.equal(deriveStoreIdentity(), deriveStoreIdentity());
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  assert.equal(s.storeIdentity, deriveStoreIdentity());
  s.close();
});

test("S15. get() on missing record returns null", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  assert.equal(s.get("0".repeat(64)), null);
  s.close();
});

test("S16. validate() reports healthy store ok", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  s.explicitImport(codeRecord());
  const v = s.validate();
  assert.equal(v.ok, true, v.errors.join(";"));
  assert.equal(v.parity.ok, true);
  s.close();
});

test("S17. resolveRepositoryIdentity derives deterministic repo/worktree/tree identity", async () => {
  const { resolveRepositoryIdentity } = await import("../../src/memory/index.mjs");
  const id1 = resolveRepositoryIdentity("/Volumes/NVM2T/Development/autoloop");
  const id2 = resolveRepositoryIdentity("/Volumes/NVM2T/Development/autoloop");
  assert.deepEqual(id1, id2);
  assert.ok(/^[0-9a-f]{64}$/.test(id1.repositoryIdentity));
  assert.ok(/^[0-9a-f]{64}$/.test(id1.worktreeIdentity));
  assert.ok(/^[0-9a-f]{40}$/.test(id1.treeSha));
});

test("S18. decision (global) and execution records import cleanly", () => {
  const root = freshRoot();
  const s = makeStore(root);
  s.open();
  s.explicitImport(decisionRecord({ global: true }));
  s.explicitImport(executionRecord({ graphRun: "run-xyz" }));
  assert.equal(s.snapshot().recordCount, 2);
  s.close();
});
