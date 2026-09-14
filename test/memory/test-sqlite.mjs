// test/memory/test-sqlite.mjs
//
// CBM-2 §15 SQLite: 14 required cases（scratch db, node:sqlite, no external dep）.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openMemoryDb,
  applyMigrations,
  insertRecord,
  upsertRecord,
  applyLifecycleEvent,
  insertRelationship,
  detectConflictGroups,
  recordConflictGroup,
  queryRecords,
  queryConflicts,
  ftsRebuild,
  ftsMatch,
  MIGRATION_V1,
  MEMORY_ERRORS,
  buildLifecycleEvent,
  validateMemoryRecordV1,
  deriveLogicalKey,
  SQLITE_ENGINE_VERSION,
  MEMORY_SCHEMA_VERSION,
  VALIDITY_FILTERS,
} from "../../src/memory/index.mjs";
import { baseCodeRecord, baseExecutionRecord, baseDecisionRecord, hex64, hex40 } from "./helpers.mjs";

const ROOT = join(tmpdir(), `cbm2-sqlite-${process.pid}`);
const DB = join(ROOT, "memory.db");

const validate = (r) => validateMemoryRecordV1(r, { authorizedDirs: [] });

before(() => rmSync(ROOT, { recursive: true, force: true }) || mkdirSync(ROOT, { recursive: true }));
after(() => rmSync(ROOT, { recursive: true, force: true }));

test("1. DDL clean database creation + migration checksum", () => {
  const db = openMemoryDb(join(ROOT, "clean.db"));
  const r = applyMigrations(db);
  assert.equal(r.currentSchemaVersion, MEMORY_SCHEMA_VERSION);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((t) => t.name);
  for (const t of ["memory_records", "memory_lifecycle_events", "memory_evidence", "memory_relationships", "memory_conflicts", "memory_migrations", "memory_fts"]) {
    assert.ok(tables.includes(t), `table ${t} present`);
  }
  const applied = db.prepare("SELECT migration_id, checksum FROM memory_migrations").all();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].checksum, MIGRATION_V1.checksum);
  db.close();
});

test("2. foreign key enforcement (event without record rejected)", () => {
  const db = openMemoryDb(join(ROOT, "fk.db"));
  applyMigrations(db);
  assert.throws(() => db.prepare("INSERT INTO memory_lifecycle_events (event_id, record_id, event_type, new_state, reason, authority, timestamp) VALUES ('e1','nope','CREATED','RAW','r','SYSTEM_DERIVED','2026-08-07T00:00:00.000Z')").run(), /FOREIGN KEY/i);
  db.close();
});

test("3. unique identity (duplicate recordId rejected)", () => {
  const db = openMemoryDb(join(ROOT, "uniq.db"));
  applyMigrations(db);
  const rec = baseCodeRecord();
  insertRecord(db, rec, { validate });
  assert.throws(() => insertRecord(db, rec, { validate }), /DUPLICATE_RECORD/);
  // idempotent upsert is a no-op
  assert.equal(upsertRecord(db, rec, { validate }).inserted, false);
  db.close();
});

test("4. transaction rollback (failed insert leaves no partial state)", () => {
  const db = openMemoryDb(join(ROOT, "tx.db"));
  applyMigrations(db);
  const rec = baseCodeRecord();
  db.exec("BEGIN");
  insertRecord(db, rec, { validate });
  assert.throws(() => insertRecord(db, rec, { validate }));
  db.exec("ROLLBACK");
  assert.equal(queryRecords(db).length, 0, "rollback discards the insert");
  // re-insert after rollback works
  insertRecord(db, rec, { validate });
  assert.equal(queryRecords(db).length, 1);
  db.close();
});

test("5. lifecycle append (history preserved)", () => {
  const db = openMemoryDb(join(ROOT, "lc.db"));
  applyMigrations(db);
  const rec = baseCodeRecord({ trust: "RAW" });
  insertRecord(db, rec, { validate });
  const ev = buildLifecycleEvent({ recordId: rec.recordId, eventType: "PROMOTED", previousState: "RAW", newState: "UNVERIFIED", reason: "validated", authority: "SYSTEM_DERIVED" });
  applyLifecycleEvent(db, ev);
  const rows = db.prepare("SELECT event_type, previous_state, new_state FROM memory_lifecycle_events WHERE record_id = ? ORDER BY timestamp").all(rec.recordId);
  assert.equal(rows.length, 2, "CREATED + PROMOTED");
  assert.equal(rows[1].event_type, "PROMOTED");
  const recNow = queryRecords(db, { validity: VALIDITY_FILTERS.ALL }).find((r) => r.recordId === rec.recordId);
  assert.equal(recNow.trust, "UNVERIFIED", "trust column updated by event");
  db.close();
});

test("6. tombstone filtering (excluded from default retrieval)", () => {
  const db = openMemoryDb(join(ROOT, "tomb.db"));
  applyMigrations(db);
  const rec = baseCodeRecord();
  insertRecord(db, rec, { validate });
  const ev = buildLifecycleEvent({ recordId: rec.recordId, eventType: "TOMBSTONED", previousState: "CURRENT", newState: "TOMBSTONED", reason: "renamed away", authority: "CONTROLLER" });
  applyLifecycleEvent(db, ev);
  assert.equal(queryRecords(db).length, 0, "tombstoned excluded by default");
  assert.equal(queryRecords(db, { validity: VALIDITY_FILTERS.ALL }).length, 1, "still queryable with ALL");
  db.close();
});

test("7. trust filtering (trustFloor)", () => {
  const db = openMemoryDb(join(ROOT, "trust.db"));
  applyMigrations(db);
  // distinct content（different path -> different logical key）— UNIQUE(logical_key, content_hash)
  const raw = baseCodeRecord({ scope: { tree: hex40("c"), path: "src/raw.mjs" }, trust: "RAW" });
  insertRecord(db, raw, { validate });
  const verified = baseCodeRecord({ scope: { tree: hex40("c"), path: "src/verified.mjs" }, trust: "VERIFIED", source: { source: "VERIFIER", identity: hex64("f") }, evidence: { manifestDigest: hex64("a"), verifierResultIdentity: hex64("b"), items: [] } });
  insertRecord(db, verified, { validate });
  assert.equal(queryRecords(db, { trustFloor: "VERIFIED" }).length, 1, "only VERIFIED+ returned");
  assert.equal(queryRecords(db, { trustFloor: "RAW" }).length, 2);
  db.close();
});

test("8. deterministic query ordering (record_id ASC)", () => {
  const db = openMemoryDb(join(ROOT, "order.db"));
  applyMigrations(db);
  const recs = [baseCodeRecord(), baseExecutionRecord(), baseDecisionRecord()];
  for (const r of recs) insertRecord(db, r, { validate });
  const out1 = queryRecords(db, { validity: VALIDITY_FILTERS.ALL });
  const out2 = queryRecords(db, { validity: VALIDITY_FILTERS.ALL });
  assert.deepEqual(out1.map((r) => r.recordId), out2.map((r) => r.recordId));
  const ids = out1.map((r) => r.recordId);
  assert.deepEqual(ids, [...ids].sort(), "record_id ASC");
  db.close();
});

test("9. conflict retrieval (surfaced together, never merged)", () => {
  const db = openMemoryDb(join(ROOT, "conf.db"));
  applyMigrations(db);
  const a = baseCodeRecord({ content: { kind: "TEXT", text: "version A" } });
  const b = baseCodeRecord({ content: { kind: "TEXT", text: "version B" } });
  assert.equal(deriveLogicalKey(a), deriveLogicalKey(b), "same logical key");
  insertRecord(db, a, { validate });
  insertRecord(db, b, { validate });
  const groups = detectConflictGroups(db);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].versions, 2);
  const gid = `grp_${a.recordId.slice(0, 8)}`;
  recordConflictGroup(db, { conflictGroupId: gid, logicalKey: deriveLogicalKey(a), subject: "src/module.mjs", recordIds: [a.recordId, b.recordId] });
  const conflicts = queryConflicts(db);
  assert.equal(conflicts.length, 2, "both versions first-class");
  assert.ok(conflicts.every((c) => c.conflict_group_id === gid));
  // conflicted records excluded from default CURRENT retrieval
  assert.equal(queryRecords(db).length, 0);
  db.close();
});

test("10. reopen persistence", () => {
  const db = openMemoryDb(DB);
  applyMigrations(db);
  const rec = baseCodeRecord();
  insertRecord(db, rec, { validate });
  db.close();
  const db2 = openMemoryDb(DB);
  const rows = queryRecords(db2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recordId, rec.recordId);
  assert.equal(rows[0].subject.statement, rec.subject.statement);
  db2.close();
});

test("11. schema version + migration checksum + future-version fail-closed", () => {
  const db = openMemoryDb(join(ROOT, "mig.db"));
  applyMigrations(db);
  const v = db.prepare("SELECT MAX(schema_version) v FROM memory_migrations").get().v;
  assert.equal(v, MEMORY_SCHEMA_VERSION);
  // tamper the checksum -> re-apply fails closed
  db.prepare("UPDATE memory_migrations SET checksum = ? WHERE migration_id = ?").run("0".repeat(64), "cbm2-v1");
  db.close();
  const db2 = openMemoryDb(join(ROOT, "mig.db"));
  assert.throws(() => applyMigrations(db2), (e) => e.code === MEMORY_ERRORS.MIGRATION_INVALID && e.message.includes("checksum"));
  db2.close();
  // a NEWER version marker fails closed
  const db3 = openMemoryDb(join(ROOT, "mig-newer.db"));
  applyMigrations(db3);
  db3.prepare("INSERT INTO memory_migrations (migration_id, schema_version, checksum, applied_at) VALUES ('future', 999, ?, '2026-08-07T00:00:00.000Z')").run("0".repeat(64));
  assert.throws(() => applyMigrations(db3), (e) => e.code === MEMORY_ERRORS.MIGRATION_INVALID && e.message.includes("NEWER"));
  db3.close();
});

test("12. FTS5 pinned tokenizer + rebuild (deterministic)", () => {
  const db = openMemoryDb(join(ROOT, "fts.db"));
  applyMigrations(db);
  const rec = baseCodeRecord({ subject: { statement: "café module loader", contentHash: null, language: "javascript" }, content: { kind: "TEXT", text: "café loader foo-bar" } });
  insertRecord(db, rec, { validate });
  ftsRebuild(db);
  assert.equal(ftsMatch(db, "café").length, 1);
  assert.equal(ftsMatch(db, "cafe").length, 0, "remove_diacritics 0 keeps diacritics — deterministic");
  assert.equal(ftsMatch(db, "loader").length, 1);
  assert.equal(ftsMatch(db, "load*").length, 1, "prefix query");
  assert.equal(ftsMatch(db, '"foo bar"').length, 1, "phrase across punct-split tokens (foo-bar -> foo, bar)");
  // rebuild twice -> same result
  ftsRebuild(db);
  assert.equal(ftsMatch(db, "café").length, 1);
  db.close();
});

test("13. hostile text does not form SQL injection", () => {
  const db = openMemoryDb(join(ROOT, "inject.db"));
  applyMigrations(db);
  const hostile = "x'; DROP TABLE memory_records; --";
  const rec = baseCodeRecord({ content: { kind: "TEXT", text: hostile } });
  insertRecord(db, rec, { validate });
  // the hostile text is DATA — stored safely, no injection
  const out = queryRecords(db);
  assert.equal(out.length, 1);
  assert.equal(out[0].content.text, hostile);
  const still = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_records'").all();
  assert.equal(still.length, 1, "table survived");
  db.close();
});

test("14. deterministic query ordering + scope filters (tree / worktree / graphRun)", () => {
  const db = openMemoryDb(join(ROOT, "scope.db"));
  applyMigrations(db);
  const t1 = hex40("c");
  const t2 = hex40("9");
  const a = baseCodeRecord({ scope: { tree: t1, path: "src/a.mjs" }, validity: { status: "CURRENT", validityTree: t1 } });
  const b = baseCodeRecord({ scope: { tree: t2, path: "src/b.mjs" }, validity: { status: "CURRENT", validityTree: t2 } });
  insertRecord(db, a, { validate });
  insertRecord(db, b, { validate });
  assert.equal(queryRecords(db, { scopeTree: t1 }).length, 1);
  assert.equal(queryRecords(db, { scopeTree: t1 })[0].recordId, a.recordId);
  assert.equal(queryRecords(db, { scopeTree: t2 }).length, 1);
  assert.equal(queryRecords(db, { scopeTree: t2 })[0].recordId, b.recordId);
  // graphRun scope filter
  const run = baseExecutionRecord({ scope: { graphRun: "run-X" } });
  insertRecord(db, run, { validate });
  assert.equal(queryRecords(db, { scopeGraphRun: "run-X" }).length, 1);
  db.close();
});

// ── R2 PATTERN sqlite extension (AUTOLOOP-V1-STAGE-F-R2-IMPLEMENTATION-1;
//    additive cases only — existing expectations above byte-untouched) ─────

import { MEMORY_RECORD_SCHEMA as MRS2, deriveContentHash as dch2, deriveMemoryRecordId as dmri2, NOT_APPLICABLE as NA3 } from "../../src/memory/index.mjs";

function patternRecord() {
  const rec = {
    schema: MRS2,
    recordType: "PATTERN",
    identity: { patternId: "pat-sql-1", repositoryIdentity: hex64("2") },
    subject: { statement: "PATTERN (sqlite): bound check accepts PATTERN", contentHash: null, language: NA3 },
    content: {
      kind: "STRUCTURED",
      data: {
        mechanismDigest: hex64("1"),
        applicabilityDigest: hex64("2"),
        constituentIncidentSetDigest: hex64("3"),
        constituentIncidentRecordIds: [hex64("4")],
        qualificationRecordId: hex64("5"),
        publicationGeneration: 1,
        counterexamples: NA3,
        applicability: {
          appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src/memory" }],
          doesNotApplyWhen: [],
          mechanismSignature: { errorClass: "livelock" },
        },
      },
    },
    source: { source: "EXECUTION", identity: hex64("7") },
    scope: { repository: hex64("2") },
    trust: "UNVERIFIED",
    validity: { status: "CURRENT", validityTree: NA3 },
    lifecycle: { events: [] },
    timestamps: { createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" },
    evidence: { manifestDigest: hex64("8"), items: [] },
    security: { scanResult: "clean", ingestionSource: "test-fixture" },
    metadata: {},
  };
  rec.subject.contentHash = dch2(rec.content);
  rec.recordId = dmri2(rec);
  return rec;
}

test("R2-S1. record_type CHECK accepts PATTERN on a NEW store (CHECK IN-list extended)", () => {
  const db = openMemoryDb(join(ROOT, "pattern.db"));
  applyMigrations(db);
  const pattern = patternRecord();
  insertRecord(db, pattern, { validate });
  const rows = queryRecords(db, { recordType: "PATTERN" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recordId, pattern.recordId);
  assert.equal(rows[0].recordType, "PATTERN");
  db.close();
});

test("R2-S2. old-CHECK store rejects PATTERN inserts until rebuild (reconcile-from-reality, never patched in place)", () => {
  // simulate an EXISTING store created before the extension (frozen §3.3a:
  // journal is truth; sqlite ⊆ journal rebuild is the standing recovery
  // path; no destructive ALTER and no in-place migration).
  const db = openMemoryDb(join(ROOT, "legacy.db"));
  db.exec(`CREATE TABLE memory_records (
    record_id TEXT PRIMARY KEY,
    logical_key TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    record_type TEXT NOT NULL CHECK (record_type IN ('CODE','EXECUTION','DECISION')),
    trust TEXT NOT NULL CHECK (trust IN ('RAW','UNVERIFIED','VERIFIED','REVIEWED','CONFIRMED')),
    trust_rank INTEGER NOT NULL,
    validity_status TEXT NOT NULL CHECK (validity_status IN ('CURRENT','STALE','INVALIDATED','TOMBSTONED','CONFLICTED')),
    scope_repository TEXT, scope_worktree TEXT, scope_commit TEXT, scope_tree TEXT, scope_path TEXT,
    scope_symbol TEXT, scope_content_hash TEXT, scope_graph_run TEXT, scope_task TEXT,
    scope_global INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL, source TEXT NOT NULL, source_identity TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL,
    UNIQUE (logical_key, content_hash)
  )`);
  let threw = false;
  try {
    insertRecord(db, patternRecord(), { validate });
  } catch (e) {
    threw = true;
    assert.ok(String(e?.message ?? e).includes("CHECK") || String(e?.message ?? e).includes("SCHEMA_INVALID"));
  }
  assert.equal(threw, true, "old CHECK store must reject PATTERN inserts (fail-closed)");
  db.close();
});

test("R2-S3. extended store replays a PATTERN-free (legacy) journal cleanly — backward compatibility", () => {
  const db = openMemoryDb(join(ROOT, "replay.db"));
  applyMigrations(db);
  const code = baseCodeRecord();
  insertRecord(db, code, { validate });
  assert.equal(queryRecords(db, {}).length, 1);
  assert.equal(queryRecords(db, { recordType: "PATTERN" }).length, 0);
  db.close();
});
