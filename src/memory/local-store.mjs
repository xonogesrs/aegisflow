// src/memory/local-store.mjs
//
// CBM-3 — LocalMemoryStore（SQLite primary + append-only JSONL hash-chain
// journal）.
//
// Store location（card §6）: no pre-existing AutoLoop memory state root exists,
// so this card establishes `~/.autoloop/memory/` with the env override
// `AUTOLOOP_MEMORY_STATE_ROOT`（tests / CI always use an isolated tmpdir —
// never the production root, never inside a git worktree）.
//
//   <root>/
//     memory.db      SQLite primary store（WAL sidecars expected）
//     journal.jsonl  append-only hash-chain journal（canonical authority）
//
// Durability / crash model:
//   - explicitImport appends the journal event FIRST（fsync per line, CBM-2
//     contract）then applies the same mutation to SQLite.
//   - on open: journal chain is validated（corrupt middle / dup / gap →
//     MEMORY_STORE_INVALID, fail closed）. A MISSING sqlite with a valid
//     journal is rebuilt from the journal（recovery）. A PRESENT sqlite that
//     is a strict SUBSET of the journal（crash between journal append and
//     sqlite insert）is rebuilt from the journal（lossless — our write path
//     never writes sqlite without journal-first）. A sqlite that is NOT a
//     subset of the journal（records not in the journal — cannot reconcile
//     without data loss）→ MEMORY_STORE_INVALID.
//   - explicit rebuildFromJournal() deletes sqlite and replays the journal;
//     rebuild identity equality（same snapshot digest / same retrieval
//     digest）is a REQUIRED regression.
//
// API: open / close / initialize / migrate / validate / get / query /
// snapshot / rebuildFromJournal / verifyJournalParity / explicitImport.
// Automatic write-back is OUT OF SCOPE（CBM-4）— explicitImport is the only
// write path and it is always validated.

import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { openMemoryDb, applyMigrations, upsertRecord, ftsInsert, ftsRebuild, applyLifecycleEvent, insertRelationship, MemoryStoreError, MIGRATION_V1 } from "./sqlite-schema.mjs";
import { readJournal, replayJournal, appendJournalEvent, JOURNAL_GENESIS_DIGEST, JournalError, MEMORY_JOURNAL_EVENT_SCHEMA } from "./jsonl-journal.mjs";
import { validateMemoryRecordV1, MEMORY_ERRORS } from "./validation.mjs";
import { storeSnapshotDigest, snapshotStats, replayJournalToDigest } from "./snapshot.mjs";
import { retrieveMemory } from "./retrieval.mjs";
import { validateMemoryQueryV1 } from "./query-schema.mjs";
import { MEMORY_STORE_IDENTITY_SCHEMA } from "./query-schema.mjs";
import { MEMORY_SCHEMA_VERSION } from "./contract.mjs";
import { deriveEventId } from "./identity.mjs";
import { recursiveCanonicalJson, utcNowIso } from "./canonical.mjs";
import { sha256Text } from "../evidence/run-evidence-store.mjs";

export const MEMORY_STATE_ROOT_ENV = "AUTOLOOP_MEMORY_STATE_ROOT";
export const DEFAULT_MEMORY_STATE_ROOT = join(homedir(), ".autoloop", "memory");
export const MEMORY_STORE_FILES = Object.freeze(["memory.db", "journal.jsonl"]);

export const MEMORY_STORE_HOLD_CODES = Object.freeze({
  MEMORY_STORE_INVALID: "MEMORY_STORE_INVALID",
  EMPTY_MEMORY: "EMPTY_MEMORY",
});

export class MemoryStoreInvalidError extends MemoryStoreError {
  constructor(code, message) {
    super(code, message);
    this.name = "MemoryStoreInvalidError";
    this.code = code;
  }
}

/** Resolve the memory state root（env override wins; never inside a worktree）. */
export function resolveMemoryStateRoot(root = null) {
  if (root) return resolve(root);
  const env = process.env[MEMORY_STATE_ROOT_ENV];
  return resolve(env && env.trim().length > 0 ? env : DEFAULT_MEMORY_STATE_ROOT);
}

/**
 * Store identity — fixed for the contract（journal genesis + schema
 * version + backend）; NOT stored in a mutable file, so a rebuilt store has
 * the same identity. Never includes paths / mtimes / sqlite internals.
 */
export function deriveStoreIdentity() {
  return sha256Text(recursiveCanonicalJson({
    schema: MEMORY_STORE_IDENTITY_SCHEMA,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    journalGenesisDigest: JOURNAL_GENESIS_DIGEST,
    backend: "sqlite+jsonl",
  }));
}

// ---------------------------------------------------------------------------
// Repository / worktree / tree identity（graph retrieval context）
// ---------------------------------------------------------------------------

function gitOrNull(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Resolve the CURRENT repository/worktree/tree identity for a repo path
 * （graph-time context）. repositoryIdentity = sha256(canonical({ remote,
 * canonicalPath })) — stable for a given repo; remote/canonical path changes
 * produce a NEW identity（old records no longer match — correct isolation）.
 */
export function resolveRepositoryIdentity(repoPath) {
  const canonicalPath = resolve(repoPath);
  const remote = gitOrNull(repoPath, ["remote", "get-url", "origin"]);
  const repositoryIdentity = sha256Text(recursiveCanonicalJson({ remote: remote ?? null, canonicalPath }));
  const worktreeIdentity = sha256Text(recursiveCanonicalJson({ repositoryIdentity, worktreePath: canonicalPath }));
  return {
    repositoryIdentity,
    worktreeIdentity,
    commitSha: gitOrNull(repoPath, ["rev-parse", "HEAD"]),
    treeSha: gitOrNull(repoPath, ["rev-parse", "HEAD^{tree}"]),
    branch: gitOrNull(repoPath, ["branch", "--show-current"]),
    canonicalPath,
    remote,
  };
}

// ---------------------------------------------------------------------------
// LocalMemoryStore
// ---------------------------------------------------------------------------

export class LocalMemoryStore {
  /**
   * @param {object} opts
   * @param {string} [opts.stateRoot] — store root; defaults to env / ~/.autoloop/memory
   * @param {string[]} [opts.authorizedDirs] — evidence-path authorized dirs for explicitImport
   * @param {object} [opts.log] — logger（default console）
   */
  constructor({ stateRoot = null, authorizedDirs = [], log = console } = {}) {
    this.stateRoot = resolveMemoryStateRoot(stateRoot);
    this.dbPath = join(this.stateRoot, "memory.db");
    this.journalPath = join(this.stateRoot, "journal.jsonl");
    this.authorizedDirs = [...authorizedDirs];
    this.log = log;
    this.storeIdentity = deriveStoreIdentity();
    this.db = null;
    this.lastRecovery = null;
    this._journalState = null;
  }

  /** True when the state root has any store file. */
  exists() {
    return existsSync(this.dbPath) || existsSync(this.journalPath);
  }

  /**
   * Open the store（fail-closed validation + crash recovery）.
   * Returns this. Throws MemoryStoreInvalidError on:
   *   - journal chain invalid（corrupt middle line / dup / gap）
   *   - sqlite schema version NEWER than supported（MIGRATION_INVALID）
   *   - sqlite present with records NOT in the journal（cannot reconcile）
   * Missing sqlite + valid journal → automatic rebuild（crash recovery）.
   */
  open() {
    mkdirSync(this.stateRoot, { recursive: true });
    const journalExists = existsSync(this.journalPath);
    let journal = null;
    if (journalExists) {
      try {
        journal = readJournal(this.journalPath);
      } catch (e) {
        if (e instanceof JournalError) {
          throw new MemoryStoreInvalidError(MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, `journal invalid: ${e.message}`);
        }
        throw e;
      }
    }
    let opened = null;
    try {
      opened = openMemoryDb(this.dbPath);
    } catch (e) {
      throw new MemoryStoreInvalidError(
        MEMORY_ERRORS.JOURNAL_CHAIN_INVALID,
        `sqlite unreadable: ${String(e?.message ?? e).slice(0, 300)}`,
      );
    }
    this.db = opened;
    try {
      applyMigrations(this.db);
    } catch (e) {
      if (this.db) {
        try { this.db.close(); } catch { /* best effort */ }
        this.db = null;
      }
      if (e instanceof MemoryStoreInvalidError) throw e;
      throw new MemoryStoreInvalidError(
        e?.code === MEMORY_ERRORS.MIGRATION_INVALID ? MEMORY_ERRORS.MIGRATION_INVALID : MEMORY_ERRORS.JOURNAL_CHAIN_INVALID,
        `store invalid: ${String(e?.message ?? e).slice(0, 300)}`,
      );
    }

    if (journalExists) {
      this._journalState = journal.state;
      const journalHasEvents = journal.events.length > 0;
      const sqliteCount = this.db.prepare("SELECT COUNT(*) n FROM memory_records").get().n;
      if (sqliteCount === 0 && journalHasEvents) {
        // crash before any sqlite insert → rebuild（recovery）
        this.rebuildFromJournal({ quiet: true });
      } else if (sqliteCount > 0) {
        // parity check: sqlite must be a SUBSET of the journal（our write path
        // is journal-first）. A strict subset → rebuild（lossless）. Records
        // missing from the journal → cannot reconcile → fail closed.
        const parity = this.verifyJournalParity();
        if (!parity.ok) {
          const journalIds = new Set(parity.journalRecordIds ?? []);
          const sqliteIds = parity.sqliteRecordIds ?? [];
          const missingFromJournal = sqliteIds.filter((id) => !journalIds.has(id));
          if (missingFromJournal.length === 0) {
            // sqlite ⊆ journal → safe lossless rebuild
            this.rebuildFromJournal({ quiet: true });
          } else {
            this.db.close();
            this.db = null;
            throw new MemoryStoreInvalidError(
              MEMORY_ERRORS.JOURNAL_CHAIN_INVALID,
              `sqlite contains ${missingFromJournal.length} record(s) absent from the journal — cannot reconcile without data loss`,
            );
          }
        }
      }
    } else {
      // no journal: fresh store is fine; a sqlite WITH records cannot be
      // reconciled（journal is the canonical authority）
      const sqliteCount = this.db.prepare("SELECT COUNT(*) n FROM memory_records").get().n;
      if (sqliteCount > 0) {
        this.db.close();
        this.db = null;
        throw new MemoryStoreInvalidError(
          MEMORY_ERRORS.JOURNAL_CHAIN_INVALID,
          `sqlite has ${sqliteCount} record(s) but no journal — cannot reconcile`,
        );
      }
    }
    return this;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    return this;
  }

  /** Ensure migrations are applied（idempotent; fail-closed on future schema）. */
  initialize() {
    if (!this.db) throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, "store not open");
    return applyMigrations(this.db);
  }

  /** Alias of initialize() — migrations are the only store migration. */
  migrate() {
    return this.initialize();
  }

  /**
   * Full store validation（card §23）:
   *   - journal chain integrity
   *   - migration / schema version
   *   - sqlite ↔ journal parity（sqlite ⊆ journal）
   * Returns { ok, errors, ... }. Never throws（caller decides HOLD）.
   */
  validate() {
    const errors = [];
    let journal = null;
    try {
      journal = existsSync(this.journalPath) ? readJournal(this.journalPath) : { events: [], state: { lastSequence: 0, previousDigest: null } };
    } catch (e) {
      errors.push(`journal:${String(e?.message ?? e)}`);
    }
    let migrationInfo = null;
    try {
      const db = this.db ?? openMemoryDb(this.dbPath);
      migrationInfo = applyMigrations(db);
      if (!this.db) db.close();
    } catch (e) {
      errors.push(`migration:${String(e?.message ?? e)}`);
    }
    let parity = null;
    try {
      const db = this.db ?? openMemoryDb(this.dbPath);
      parity = this._parityCheck(db, journal);
      if (!this.db) db.close();
      if (!parity.ok) errors.push(`parity:${parity.reason}`);
    } catch (e) {
      errors.push(`parity_check_failed:${String(e?.message ?? e)}`);
    }
    const ok = errors.length === 0;
    return {
      ok,
      errors,
      storeIdentity: this.storeIdentity,
      exists: this.exists(),
      migration: migrationInfo,
      journal: journal ? { events: journal.events.length, partialTrailingLine: journal.partialTrailingLine } : null,
      parity,
    };
  }

  /** Exact recordId lookup（returns the record envelope or null）. */
  get(recordId) {
    if (!this.db) throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, "store not open");
    const row = this.db.prepare("SELECT json FROM memory_records WHERE record_id = ?").get(recordId);
    return row ? JSON.parse(row.json) : null;
  }

  /**
   * Deterministic retrieval. `query` may be the raw contract input（validated
   * here, fail-closed）or an already-validated normalized query.
   */
  query(query) {
    if (!this.db) throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, "store not open");
    const v = validateMemoryQueryV1(query);
    if (!v.valid) {
      throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, `invalid memory query: ${v.errors.join(";")}`);
    }
    return retrieveMemory({ db: this.db, query: v.query });
  }

  /** Store snapshot digest + stats（deterministic）. */
  snapshot() {
    if (!this.db) throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, "store not open");
    return { storeSnapshotDigest: storeSnapshotDigest(this.db), storeIdentity: this.storeIdentity, ...snapshotStats(this.db) };
  }

  _parityCheck(db, journal = null) {
    const sqliteDigest = storeSnapshotDigest(db);
    const sqliteRecordIds = db.prepare("SELECT record_id FROM memory_records ORDER BY record_id").all().map((r) => r.record_id);
    let journalRecordIds = [];
    let journalDigest = null;
    try {
      const replay = replayJournalToDigest(this.journalPath, { openMemoryDb, applyMigrations, replayJournal });
      journalDigest = replay.digest;
      journalRecordIds = [];
      // recompute journal ids from the replay events
      const { events } = readJournal(this.journalPath);
      for (const ev of events) {
        if (ev.operation === "UPSERT_RECORD" && ev.payload?.record?.recordId) journalRecordIds.push(ev.payload.record.recordId);
      }
      journalRecordIds.sort();
    } catch (e) {
      return { ok: false, reason: `journal_replay_failed:${String(e?.message ?? e)}`, sqliteDigest, sqliteRecordIds, journalRecordIds, journalDigest: null };
    }
    const ok = sqliteDigest === journalDigest;
    return { ok, reason: ok ? null : "sqlite_digest_mismatch_vs_journal_replay", sqliteDigest, journalDigest, sqliteRecordIds, journalRecordIds };
  }

  /**
   * sqlite ↔ journal parity（journal replay in-memory vs on-disk sqlite）.
   */
  verifyJournalParity() {
    if (!this.db) throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, "store not open");
    return this._parityCheck(this.db);
  }

  /**
   * Rebuild sqlite from the canonical journal. Deletes the sqlite files,
   * recreates the schema, replays the journal, rebuilds FTS. The journal is
   * untouched. After rebuild the storeSnapshotDigest / retrieval digests are
   * identical to the pre-delete state（REQUIRED regression）.
   */
  rebuildFromJournal({ quiet = false } = {}) {
    if (!existsSync(this.journalPath)) {
      throw new MemoryStoreInvalidError(MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "rebuild requires a journal file");
    }
    // validate the journal BEFORE deleting anything（never destroy on bad chain）
    let journal;
    try {
      journal = readJournal(this.journalPath);
    } catch (e) {
      if (e instanceof JournalError) throw new MemoryStoreInvalidError(MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, e.message);
      throw e;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    for (const f of readdirSync(this.stateRoot)) {
      if (f === "memory.db" || f === "memory.db-wal" || f === "memory.db-shm") {
        rmSync(join(this.stateRoot, f), { force: true });
      }
    }
    this.db = openMemoryDb(this.dbPath);
    applyMigrations(this.db);
    const applied = replayJournal({ db: this.db, journalPath: this.journalPath });
    ftsRebuild(this.db);
    this.lastRecovery = {
      action: "rebuilt_from_journal",
      reason: quiet ? "recovery" : "explicit",
      appliedCount: applied.count,
      at: new Date().toISOString(),
    };
    this._journalState = journal.state;
    if (!quiet) this.log.info?.(`memory store rebuilt from journal: ${applied.count} event(s) applied`);
    return {
      rebuilt: true,
      appliedCount: applied.count,
      storeIdentity: this.storeIdentity,
      snapshotDigest: storeSnapshotDigest(this.db),
    };
  }

  /**
   * EXPLICIT VALIDATED IMPORT（card §7）— the ONLY write path in CBM-3.
   * Automatic Graph result → long-term memory is OUT OF SCOPE（CBM-4）.
   *
   * Validation（all CBM-2 checks, fail-closed）: schema validation, canonical
   * identity validation, secret scan, scope validation, evidence validation,
   * journal validation. Then: journal append（fsync）→ sqlite upsert → FTS.
   * Idempotent for an identical recordId / (logicalKey, contentHash).
   */
  explicitImport(record, { authorizedDirs = this.authorizedDirs, source = "IMPORT" } = {}) {
    if (!this.db) throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, "store not open");
    const v = validateMemoryRecordV1(record, { authorizedDirs });
    if (!v.valid) {
      throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, `import validation failed: ${v.errors.join(";")}`);
    }
    // journal append FIRST（durability; crash-safe）. The journal chain state
    // is cached on the instance after the first read（open validates the full
    // chain once）— re-reading + re-validating the whole journal per import
    // would be O(N²) for bulk ingestion.
    let state = this._journalState ?? { lastSequence: 0, previousDigest: null };
    if (!this._journalState && existsSync(this.journalPath)) {
      const j = readJournal(this.journalPath);
      state = j.state;
    }
    let journalResult;
    try {
      journalResult = appendJournalEvent({
        journalPath: this.journalPath,
        state,
        operation: "UPSERT_RECORD",
        recordId: record.recordId,
        payload: { record, source },
      });
    } catch (e) {
      if (e instanceof JournalError) {
        throw new MemoryStoreError(e.code, `journal append failed: ${e.message}`);
      }
      throw e;
    }
    this._journalState = journalResult.state;
    // sqlite apply（idempotent）.
    const res = upsertRecord(this.db, record, { validate: null });
    if (res.inserted) {
      ftsInsert(this.db, record.recordId, [
        record.subject?.statement ?? "",
        typeof record.content?.text === "string" ? record.content.text : "",
        record.scope?.path ?? "",
        record.scope?.symbol ?? "",
      ].filter(Boolean).join(" "));
    }
    return {
      recordId: record.recordId,
      imported: res.inserted,
      journalSequence: journalResult.event.journalSequence,
    };
  }

  /**
   * CBM-4 — governed lifecycle transition（journal-first, crash-safe）.
   * Appends a LIFECYCLE_EVENT journal line FIRST（fsync）then applies to
   * sqlite — the same journal-first durability as explicitImport; a crash
   * between the two is losslessly replayed on open/rebuild.
   * @param {object} event - { eventType, recordId, identity, reason }
   * @returns {{ applied: boolean, journalSequence: number, event }}
   */
  applyLifecycle(event) {
    if (!this.db) throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, "store not open");
    if (!event || typeof event !== "object" || !event.eventType || !event.recordId) {
      throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, "lifecycle event requires eventType + recordId");
    }
    // full CBM-2 lifecycle event shape（previousState derived from the current
    // record; newState mapped from the eventType; authority/evidence passed by
    // the governed caller）.
    const row = this.db.prepare("SELECT json FROM memory_records WHERE record_id = ?").get(event.recordId);
    if (!row) throw new MemoryStoreError(MEMORY_ERRORS.EVIDENCE_MISSING, `record ${event.recordId} not found`);
    const cur = JSON.parse(row.json);
    const newState = event.eventType === "RESTORED" ? "CURRENT" : event.eventType === "MARKED_STALE" ? "STALE" : event.eventType === "SUPERSEDED" ? "INVALIDATED" : event.eventType;
    const full = {
      eventId: event.identity ?? deriveEventId("evt", event.recordId, event.eventType),
      recordId: event.recordId,
      eventType: event.eventType,
      previousState: cur.validity?.status ?? "CURRENT",
      newState,
      reason: event.reason ?? "writeback lifecycle transition",
      authority: event.authority ?? "SYSTEM_DERIVED",
      evidenceIdentity: event.evidenceIdentity ?? null,
      timestamp: event.timestamp ?? utcNowIso(),
    };
    let state = this._journalState ?? { lastSequence: 0, previousDigest: null };
    if (!this._journalState && existsSync(this.journalPath)) {
      const j = readJournal(this.journalPath);
      state = j.state;
    }
    let journalResult;
    try {
      journalResult = appendJournalEvent({
        journalPath: this.journalPath,
        state,
        operation: "LIFECYCLE_EVENT",
        recordId: full.recordId,
        payload: { event: full },
      });
    } catch (e) {
      if (e instanceof JournalError) throw new MemoryStoreError(e.code, `journal append failed: ${e.message}`);
      throw e;
    }
    this._journalState = journalResult.state;
    applyLifecycleEvent(this.db, journalResult.event.payload.event);
    return { applied: true, journalSequence: journalResult.event.journalSequence, event: journalResult.event.payload.event };
  }

  /**
   * CBM-4 — governed relationship insertion（journal-first, crash-safe）.
   * @param {object} rel - { relationshipId, recordId, targetRecordId, relationshipType, identity }
   */
  addRelationship(rel) {
    if (!this.db) throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, "store not open");
    if (!rel || !rel.relationshipId || !rel.recordId || !rel.targetRecordId || !rel.relationshipType) {
      throw new MemoryStoreError(MEMORY_ERRORS.SCHEMA_INVALID, "relationship requires id + record + target + type");
    }
    let state = this._journalState ?? { lastSequence: 0, previousDigest: null };
    if (!this._journalState && existsSync(this.journalPath)) {
      const j = readJournal(this.journalPath);
      state = j.state;
    }
    let journalResult;
    try {
      journalResult = appendJournalEvent({
        journalPath: this.journalPath,
        state,
        operation: "RELATIONSHIP",
        recordId: rel.recordId,
        payload: { relationship: rel },
      });
    } catch (e) {
      if (e instanceof JournalError) throw new MemoryStoreError(e.code, `journal append failed: ${e.message}`);
      throw e;
    }
    this._journalState = journalResult.state;
    insertRelationship(this.db, rel);
    return { applied: true, journalSequence: journalResult.event.journalSequence };
  }
}

export { openMemoryDb, applyMigrations, MIGRATION_V1, MEMORY_JOURNAL_EVENT_SCHEMA };
