// src/memory/sqlite-schema.mjs
//
// CBM-2 — Memory Contract v1: SQLite schema, migrations and minimal store
// helpers（contract test basis only — retrieval engine is CBM-3）.
//
// Decisions（documented, not implicit）:
//   - SQLite primary store（node:sqlite, ZERO external dependency）
//   - `PRAGMA foreign_keys = ON`（hard referential integrity）
//   - `PRAGMA journal_mode = WAL`（durable; reader concurrency）— WAL
//     sidecar files are expected in the store dir
//   - `PRAGMA synchronous = NORMAL`（WAL-safe durability）
//   - FTS5 ADOPTED with PINNED tokenizer `unicode61 remove_diacritics 0`
//     （SQLite 3.53.2 — diacritics kept, case folding per unicode61）;
//     contentless external-content table; the retrieval DIGEST never
//     includes FTS internals（FTS only narrows candidates; ordering and
//     digest use canonical record fields in deterministic order）
//   - schema version + migration checksum table; unknown FUTURE version
//     fails closed（MIGRATION_INVALID）
//   - tombstone / invalidated records excluded from default retrieval;
//     trust rank filterable; conflicts surfaced as first-class data

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { recursiveCanonicalJson, contentHash, utcNowIso } from "./canonical.mjs";
import { MEMORY_SCHEMA_VERSION, MEMORY_RECORD_SCHEMA, RECORD_TYPES, TRUST_RANK, TRUST_STATES, VALIDITY_STATUSES, RELATIONSHIP_TYPES } from "./contract.mjs";
import { MEMORY_ERRORS, validateLifecycleEvent } from "./validation.mjs";
import { deriveLogicalKey } from "./identity.mjs";

export const SQLITE_ENGINE_VERSION = "sqlite-3.53.2";

export const DDL_V1 = Object.freeze([
  // ── migrations ───────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS memory_migrations (
    migration_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`,
  // ── records ──────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS memory_records (
    record_id TEXT PRIMARY KEY,
    logical_key TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    record_type TEXT NOT NULL CHECK (record_type IN ('CODE','EXECUTION','DECISION','PATTERN')),
    trust TEXT NOT NULL CHECK (trust IN ('RAW','UNVERIFIED','VERIFIED','REVIEWED','CONFIRMED')),
    trust_rank INTEGER NOT NULL,
    validity_status TEXT NOT NULL CHECK (validity_status IN ('CURRENT','STALE','INVALIDATED','TOMBSTONED','CONFLICTED')),
    scope_repository TEXT,
    scope_worktree TEXT,
    scope_commit TEXT,
    scope_tree TEXT,
    scope_path TEXT,
    scope_symbol TEXT,
    scope_content_hash TEXT,
    scope_graph_run TEXT,
    scope_task TEXT,
    scope_global INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    source_identity TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    json TEXT NOT NULL,
    UNIQUE (logical_key, content_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_records_tree ON memory_records(scope_tree)`,
  `CREATE INDEX IF NOT EXISTS idx_records_worktree ON memory_records(scope_worktree)`,
  `CREATE INDEX IF NOT EXISTS idx_records_content_hash ON memory_records(content_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_records_trust_rank ON memory_records(trust_rank)`,
  `CREATE INDEX IF NOT EXISTS idx_records_type_validity ON memory_records(record_type, validity_status)`,
  `CREATE INDEX IF NOT EXISTS idx_records_graph_run ON memory_records(scope_graph_run)`,
  `CREATE INDEX IF NOT EXISTS idx_records_created ON memory_records(created_at)`,
  // ── lifecycle events（append-only history; never overwritten）──────────────
  `CREATE TABLE IF NOT EXISTS memory_lifecycle_events (
    event_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES memory_records(record_id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN ('CREATED','VALIDATED','PROMOTED','DOWNGRADED','MARKED_STALE','INVALIDATED','TOMBSTONED','SUPERSEDED','RESTORED','MIGRATED')),
    previous_state TEXT,
    new_state TEXT NOT NULL,
    reason TEXT NOT NULL,
    authority TEXT NOT NULL,
    evidence_identity TEXT,
    timestamp TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_record ON memory_lifecycle_events(record_id, timestamp)`,
  // ── evidence（per-record manifest + item hashes）─────────────────────────
  `CREATE TABLE IF NOT EXISTS memory_evidence (
    record_id TEXT NOT NULL REFERENCES memory_records(record_id) ON DELETE RESTRICT,
    manifest_digest TEXT NOT NULL,
    item_path TEXT NOT NULL,
    item_sha256 TEXT NOT NULL,
    review_result_identity TEXT,
    verifier_result_identity TEXT,
    controller_ruling_identity TEXT,
    PRIMARY KEY (record_id, item_path)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_manifest ON memory_evidence(manifest_digest)`,
  // ── relationships（first-class, identity-bearing）────────────────────────
  `CREATE TABLE IF NOT EXISTS memory_relationships (
    relationship_id TEXT PRIMARY KEY,
    record_id TEXT NOT NULL REFERENCES memory_records(record_id) ON DELETE RESTRICT,
    target_record_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL CHECK (relationship_type IN ('DERIVED_FROM','VERIFIES','REVIEWS','SUPERSEDES','INVALIDATES','CONFLICTS_WITH','APPLIES_TO','PRODUCED_BY')),
    identity TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_relationships_record ON memory_relationships(record_id)`,
  `CREATE INDEX IF NOT EXISTS idx_relationships_target ON memory_relationships(target_record_id)`,
  `CREATE INDEX IF NOT EXISTS idx_relationships_type ON memory_relationships(relationship_type)`,
  // ── conflicts（NEVER silently resolved; first-class queryable）────────────
  `CREATE TABLE IF NOT EXISTS memory_conflicts (
    conflict_group_id TEXT NOT NULL,
    record_id TEXT NOT NULL REFERENCES memory_records(record_id) ON DELETE RESTRICT,
    logical_key TEXT NOT NULL,
    subject TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    PRIMARY KEY (conflict_group_id, record_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conflicts_key ON memory_conflicts(logical_key)`,
  // ── FTS5（PINNED tokenizer; NORMAL table for v1 — content stored in the
  // FTS index so rebuild is a deterministic DELETE+INSERT; contentless
  // external-content with triggers deferred to CBM-3 if storage demands）──
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    record_id UNINDEXED,
    content,
    tokenize = 'unicode61 remove_diacritics 0'
  )`,
]);

export const MIGRATION_V1 = Object.freeze({
  id: "cbm2-v1",
  schemaVersion: MEMORY_SCHEMA_VERSION,
  ddl: DDL_V1,
  checksum: sha256Hex(recursiveCanonicalJson(DDL_V1)),
  description: "Memory Contract v1 baseline: records / lifecycle / evidence / relationships / conflicts / migrations + pinned-tokenizer FTS5.",
});

export function sha256Hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

export class MemoryStoreError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "MemoryStoreError";
    this.code = code;
  }
}

/** Open（or create）a memory SQLite database at path. */
export function openMemoryDb(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

/**
 * Apply pending migrations. v1 baseline only; an unknown FUTURE version or a
 * checksum mismatch fails closed（MIGRATION_INVALID）.
 */
export function applyMigrations(db, { migrations = [MIGRATION_V1] } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_migrations (
    migration_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = db.prepare("SELECT migration_id, checksum FROM memory_migrations").all();
  const appliedIds = new Set(applied.map((r) => r.migration_id));
  for (const m of migrations) {
    if (appliedIds.has(m.id)) {
      const rec = applied.find((r) => r.migration_id === m.id);
      if (rec.checksum !== m.checksum) {
        throw new MemoryStoreError(MEMORY_ERRORS.MIGRATION_INVALID, `migration ${m.id} checksum mismatch (applied ${rec.checksum}, expected ${m.checksum})`);
      }
      continue;
    }
    db.exec("BEGIN");
    try {
      for (const ddl of m.ddl) db.exec(ddl);
      db.prepare("INSERT INTO memory_migrations (migration_id, schema_version, checksum, applied_at) VALUES (?, ?, ?, ?)")
        .run(m.id, m.schemaVersion, m.checksum, utcNowIso());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new MemoryStoreError(MEMORY_ERRORS.MIGRATION_INVALID, `migration ${m.id} failed: ${String(e?.message ?? e)}`);
    }
  }
  // fail-closed on unknown FUTURE versions
  const maxApplied = db.prepare("SELECT MAX(schema_version) v FROM memory_migrations").get().v ?? 0;
  if (maxApplied > MEMORY_SCHEMA_VERSION) {
    throw new MemoryStoreError(MEMORY_ERRORS.MIGRATION_INVALID, `db schema version ${maxApplied} is NEWER than supported ${MEMORY_SCHEMA_VERSION}`);
  }
  return { currentSchemaVersion: maxApplied, migrationsApplied: appliedIds.size + migrations.filter((m) => !appliedIds.has(m.id)).length };
}

// ---------------------------------------------------------------------------
// Minimal CRUD + query helpers（contract test basis; retrieval = CBM-3）
// ---------------------------------------------------------------------------

/** Insert a validated record（throws on duplicate recordId — idempotency is explicit）. */
export function insertRecord(db, record, { validate = null } = {}) {
  const v = validate ? validate(record) : record;
  if (v && typeof v === "object" && v.valid === false) {
    throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, v.errors.join(";"));
  }
  const rec = v && typeof v === "object" && v.valid === true ? v.record ?? record : record;
  const scope = rec.scope ?? {};
  const now = utcNowIso();
  try {
    db.prepare(`INSERT INTO memory_records (
      record_id, logical_key, schema_version, record_type, trust, trust_rank, validity_status,
      scope_repository, scope_worktree, scope_commit, scope_tree, scope_path, scope_symbol,
      scope_content_hash, scope_graph_run, scope_task, scope_global,
      content_hash, source, source_identity, created_at, updated_at, json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      rec.recordId,
      v?.derivedIdentity?.logicalKey ?? deriveLogicalKey(rec),
      rec.schema,
      rec.recordType,
      rec.trust,
      TRUST_RANK[rec.trust] ?? -1,
      rec.validity?.status ?? "CURRENT",
      scope.repository ?? null,
      scope.worktree ?? null,
      scope.commit ?? null,
      scope.tree ?? null,
      scope.path ?? null,
      scope.symbol ?? null,
      scope.content ?? null,
      scope.graphRun ?? null,
      scope.task ?? null,
      scope.global === true ? 1 : 0,
      rec.subject?.contentHash ?? null,
      rec.source?.source ?? "DERIVED",
      rec.source?.identity ?? null,
      rec.timestamps?.createdAt ?? now,
      rec.timestamps?.updatedAt ?? now,
      recursiveCanonicalJson(rec),
    );
    // evidence rows
    for (const item of rec.evidence?.items ?? []) {
      db.prepare(`INSERT OR IGNORE INTO memory_evidence (
        record_id, manifest_digest, item_path, item_sha256, review_result_identity, verifier_result_identity, controller_ruling_identity
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        rec.recordId,
        rec.evidence?.manifestDigest ?? null,
        item.path,
        item.sha256,
        rec.evidence?.reviewResultIdentity ?? null,
        rec.evidence?.verifierResultIdentity ?? null,
        rec.evidence?.controllerRulingIdentity ?? null,
      );
    }
    // lifecycle CREATED event（append-only; history preserved）
    db.prepare(`INSERT INTO memory_lifecycle_events (event_id, record_id, event_type, previous_state, new_state, reason, authority, evidence_identity, timestamp)
      VALUES (?, ?, 'CREATED', ?, ?, 'record inserted', 'SYSTEM_DERIVED', ?, ?)`).run(
      `evt_created_${rec.recordId.slice(0, 16)}`,
      rec.recordId,
      null,
      rec.trust,
      rec.evidence?.manifestDigest ?? null,
      now,
    );
  } catch (e) {
    if (String(e?.message ?? "").includes("UNIQUE constraint failed")) {
      throw new MemoryStoreError("DUPLICATE_RECORD", rec.recordId);
    }
    throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, String(e?.message ?? e));
  }
  return rec.recordId;
}

/** Idempotent upsert: existing recordId / (logical_key, content_hash) is a no-op. */
export function upsertRecord(db, record, opts = {}) {
  const existing = db.prepare("SELECT record_id FROM memory_records WHERE record_id = ?").get(record.recordId);
  if (existing) return { inserted: false, recordId: record.recordId };
  const dup = db.prepare("SELECT record_id FROM memory_records WHERE logical_key = ? AND content_hash = ?").get(deriveLogicalKey(record), record.subject?.contentHash ?? null);
  if (dup) return { inserted: false, recordId: dup.record_id };
  insertRecord(db, record, opts);
  return { inserted: true, recordId: record.recordId };
}

/** Apply a validated lifecycle event: append to history AND update record state. */
export function applyLifecycleEvent(db, event, { validate = validateLifecycleEvent } = {}) {
  const v = validate(event);
  if (!v.valid) throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, v.errors.join(";"));
  const rec = db.prepare("SELECT json FROM memory_records WHERE record_id = ?").get(event.recordId);
  if (!rec) throw new MemoryStoreError(MEMORY_ERRORS.EVIDENCE_MISSING, `record ${event.recordId} not found`);
  db.exec("BEGIN");
  try {
    db.prepare(`INSERT INTO memory_lifecycle_events (event_id, record_id, event_type, previous_state, new_state, reason, authority, evidence_identity, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.eventId, event.recordId, event.eventType, event.previousState ?? null, event.newState,
      event.reason, event.authority, event.evidenceIdentity ?? null, event.timestamp,
    );
    // keep the json column in sync with the current state（rebuild-identity
    // equality: json always reflects the latest lifecycle-applied state）
    const cur = JSON.parse(rec.json);
    if (event.eventType === "PROMOTED" || event.eventType === "DOWNGRADED") {
      if (!TRUST_STATES.includes(event.newState)) throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, `bad trust state ${event.newState}`);
      cur.trust = event.newState;
      cur.timestamps = { ...(cur.timestamps ?? {}), updatedAt: event.timestamp };
      db.prepare("UPDATE memory_records SET trust = ?, trust_rank = ?, json = ?, updated_at = ? WHERE record_id = ?")
        .run(event.newState, TRUST_RANK[event.newState], recursiveCanonicalJson(cur), event.timestamp, event.recordId);
    } else if (["INVALIDATED", "TOMBSTONED", "MARKED_STALE", "RESTORED", "SUPERSEDED", "CONFLICTED"].includes(event.eventType)) {
      const st = event.eventType === "RESTORED" ? "CURRENT" : event.eventType === "MARKED_STALE" ? "STALE" : event.eventType === "SUPERSEDED" ? "INVALIDATED" : event.eventType;
      cur.validity = { ...(cur.validity ?? {}), status: st };
      cur.timestamps = { ...(cur.timestamps ?? {}), updatedAt: event.timestamp };
      db.prepare("UPDATE memory_records SET validity_status = ?, json = ?, updated_at = ? WHERE record_id = ?")
        .run(st, recursiveCanonicalJson(cur), event.timestamp, event.recordId);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, String(e?.message ?? e));
  }
  return true;
}

/** Insert a first-class relationship. */
export function insertRelationship(db, { relationshipId, recordId, targetRecordId, relationshipType, identity }) {
  if (!RELATIONSHIP_TYPES.includes(relationshipType)) {
    throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, `bad relationship type ${relationshipType}`);
  }
  db.prepare(`INSERT OR IGNORE INTO memory_relationships (relationship_id, record_id, target_record_id, relationship_type, identity)
    VALUES (?, ?, ?, ?, ?)`).run(relationshipId, recordId, targetRecordId, relationshipType, identity);
  return relationshipId;
}

/**
 * Detect conflict groups: CURRENT records sharing a logical_key with >1
 * distinct content_hash. Returns groups（never silently merges）.
 */
export function detectConflictGroups(db) {
  const rows = db.prepare(`
    SELECT logical_key, COUNT(DISTINCT content_hash) versions, COUNT(*) records
    FROM memory_records
    WHERE validity_status = 'CURRENT'
    GROUP BY logical_key
    HAVING versions > 1
    ORDER BY logical_key
  `).all();
  const groups = [];
  for (const g of rows) {
    const members = db.prepare(`
      SELECT record_id, content_hash FROM memory_records
      WHERE logical_key = ? AND validity_status = 'CURRENT'
      ORDER BY record_id
    `).all(g.logical_key);
    groups.push({ logicalKey: g.logical_key, versions: g.versions, members });
  }
  return groups;
}

/** Record a detected conflict group as first-class data. */
export function recordConflictGroup(db, { conflictGroupId, logicalKey, subject, recordIds }) {
  db.exec("BEGIN");
  try {
    for (const rid of recordIds) {
      db.prepare(`INSERT OR IGNORE INTO memory_conflicts (conflict_group_id, record_id, logical_key, subject, detected_at)
        VALUES (?, ?, ?, ?, ?)`).run(conflictGroupId, rid, logicalKey, subject, utcNowIso());
      db.prepare(`UPDATE memory_records SET validity_status = 'CONFLICTED', updated_at = ? WHERE record_id = ?`).run(utcNowIso(), rid);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, String(e?.message ?? e));
  }
  return conflictGroupId;
}

export const VALIDITY_FILTERS = Object.freeze({
  DEFAULT: "CURRENT",      // default retrieval excludes stale/invalidated/tombstoned/conflicted
  INCLUDE_STALE: "INCLUDE_STALE",
  ALL: "ALL",
});

/**
 * Deterministic record query（CBM-2 test basis）. Ordering is ALWAYS
 * record_id ASC（canonical digest order）— never insertion/completion order.
 */
export function queryRecords(db, {
  recordType = null,
  trustFloor = "RAW",
  validity = VALIDITY_FILTERS.DEFAULT,
  scopeTree = null,
  scopeWorktree = null,
  scopeGraphRun = null,
  limit = null,
} = {}) {
  const where = [];
  const args = [];
  if (recordType) { where.push("record_type = ?"); args.push(recordType); }
  if (trustFloor && trustFloor !== "RAW") { where.push("trust_rank >= ?"); args.push(TRUST_RANK[trustFloor]); }
  if (validity === VALIDITY_FILTERS.DEFAULT) { where.push("validity_status = 'CURRENT'"); }
  else if (validity === VALIDITY_FILTERS.INCLUDE_STALE) { where.push("validity_status IN ('CURRENT','STALE')"); }
  if (scopeTree) { where.push("scope_tree = ?"); args.push(scopeTree); }
  if (scopeWorktree) { where.push("scope_worktree = ?"); args.push(scopeWorktree); }
  if (scopeGraphRun) { where.push("scope_graph_run = ?"); args.push(scopeGraphRun); }
  let sql = "SELECT record_id, record_type, trust, validity_status, json FROM memory_records";
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY record_id ASC";
  if (limit) sql += ` LIMIT ${Math.max(0, Number(limit))}`;
  return db.prepare(sql).all(...args).map((r) => ({ ...JSON.parse(r.json), _row: { record_id: r.record_id, trust: r.trust, validity_status: r.validity_status } }));
}

/** Query conflicts for a logical key（first-class; never silently resolved）. */
export function queryConflicts(db, logicalKey = null) {
  const where = logicalKey ? "WHERE logical_key = ?" : "";
  const args = logicalKey ? [logicalKey] : [];
  return db.prepare(`SELECT conflict_group_id, record_id, logical_key, subject, detected_at FROM memory_conflicts ${where} ORDER BY conflict_group_id, record_id`).all(...args);
}

// ── FTS5（pinned tokenizer; contentless; explicit insert/rebuild）─────────

/** Insert searchable text for a record（explicit — no triggers）. */
export function ftsInsert(db, recordId, text) {
  db.prepare("INSERT INTO memory_fts(record_id, content) VALUES (?, ?)").run(recordId, text);
  return recordId;
}

/** Rebuild FTS content from memory_records（deterministic: record_id order）. */
export function ftsRebuild(db) {
  db.exec("DELETE FROM memory_fts");
  const rows = db.prepare("SELECT record_id, json FROM memory_records ORDER BY record_id").all();
  for (const r of rows) {
    const rec = JSON.parse(r.json);
    const text = [
      rec.subject?.statement ?? "",
      typeof rec.content?.text === "string" ? rec.content.text : "",
      rec.scope?.path ?? "",
      rec.scope?.symbol ?? "",
    ].filter(Boolean).join(" ");
    if (text.length) db.prepare("INSERT INTO memory_fts(record_id, content) VALUES (?, ?)").run(r.record_id, text);
  }
  return rows.length;
}

/** FTS match（returns recordIds; ordering deterministic by record_id）. */
export function ftsMatch(db, query) {
  return db.prepare("SELECT record_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY record_id").all(query).map((r) => r.record_id);
}

export { contentHash };
