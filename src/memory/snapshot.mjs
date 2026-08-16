// src/memory/snapshot.mjs
//
// CBM-3 — Store Snapshot Digest（autoloop.memory-store-snapshot/v1）.
//
// A deterministic digest of EVERYTHING that can affect retrieval, over a
// canonical projection:
//
//   records:
//     { recordId, logicalKey, contentHash, recordType, trust,
//       validityStatus, scope（sorted keys）, inConflictTable }
//   relationships:
//     { relationshipId, recordId, targetRecordId, relationshipType }
//   conflicts:
//     { conflictGroupId, recordId, logicalKey }
//
// Ordering is ALWAYS recordId / relationshipId / conflictGroupId ascending
// （canonical digest order）— never rowid / insertion order / WAL order.
// Explicitly EXCLUDED from the digest（card §17）:
//   SQLite rowid, WAL position, filesystem mtime, absolute DB path,
//   FTS bm25 score, query latency, wall-clock execution timing.
//
// Two stores built from the same logical records in ANY insertion order
// produce the same snapshot digest. A SQLite rebuilt from the canonical
// journal produces the same snapshot digest.

import { recursiveCanonicalJson } from "./canonical.mjs";
import { sha256Text } from "../evidence/run-evidence-store.mjs";
import { MEMORY_SNAPSHOT_DIGEST_SCHEMA, MEMORY_STORE_IDENTITY_SCHEMA } from "./query-schema.mjs";
import { MEMORY_SCHEMA_VERSION } from "./contract.mjs";

export const CONFLICT_TABLE_STATUS = "CONFLICTED";

/**
 * Deterministic projection of the store state（sorted, canonical）. Returns
 * the projection object — the digest is sha256(canonical(projection)).
 */
export function snapshotProjection(db) {
  const records = db.prepare(`
    SELECT record_id, logical_key, content_hash, record_type, trust, validity_status,
           scope_repository, scope_worktree, scope_commit, scope_tree, scope_path,
           scope_symbol, scope_content_hash, scope_graph_run, scope_task, scope_global,
           json
    FROM memory_records
    ORDER BY record_id ASC
  `).all().map((r) => {
    const rec = JSON.parse(r.json);
    const scope = { ...(rec.scope ?? {}) };
    // canonical scope projection（no undefined; plain values only）
    const scopeClean = {};
    for (const k of Object.keys(scope).sort()) {
      const v = scope[k];
      if (v !== undefined && v !== null) scopeClean[k] = v;
    }
    return {
      recordId: r.record_id,
      logicalKey: r.logical_key,
      contentHash: r.content_hash,
      recordType: r.record_type,
      trust: r.trust,
      validityStatus: r.validity_status,
      scope: scopeClean,
      inConflictTable: false, // filled below
    };
  });
  const byRecord = new Map(records.map((r) => [r.recordId, r]));
  const conflictRows = db.prepare("SELECT conflict_group_id, record_id, logical_key FROM memory_conflicts ORDER BY conflict_group_id ASC, record_id ASC").all();
  for (const c of conflictRows) {
    const rec = byRecord.get(c.record_id);
    if (rec) rec.inConflictTable = true;
  }
  const relationships = db.prepare(`
    SELECT relationship_id, record_id, target_record_id, relationship_type
    FROM memory_relationships
    ORDER BY relationship_id ASC
  `).all().map((r) => ({
    relationshipId: r.relationship_id,
    recordId: r.record_id,
    targetRecordId: r.target_record_id,
    relationshipType: r.relationship_type,
  }));
  const conflicts = conflictRows.map((c) => ({
    conflictGroupId: c.conflict_group_id,
    recordId: c.record_id,
    logicalKey: c.logical_key,
  }));
  return {
    schema: MEMORY_SNAPSHOT_DIGEST_SCHEMA,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    records,
    relationships,
    conflicts,
  };
}

/** sha256(canonical(projection)) — the storeSnapshotDigest. */
export function storeSnapshotDigest(db) {
  return sha256Text(recursiveCanonicalJson(snapshotProjection(db)));
}

/** Convenience stats（for result accounting; deterministic）. */
export function snapshotStats(db) {
  const records = db.prepare("SELECT COUNT(*) n FROM memory_records").get().n;
  const relationships = db.prepare("SELECT COUNT(*) n FROM memory_relationships").get().n;
  const conflicts = db.prepare("SELECT COUNT(*) n FROM memory_conflicts").get().n;
  return { recordCount: records, relationshipCount: relationships, conflictCount: conflicts };
}

/**
 * In-memory sqlite replay of a journal — used for parity checks and
 * rebuild verification WITHOUT touching the on-disk store.
 */
export function replayJournalToDigest(journalPath, { openMemoryDb, applyMigrations, replayJournal }) {
  const db = openMemoryDb(":memory:");
  applyMigrations(db);
  const { applied, partialTrailingLine } = replayJournal({ db, journalPath });
  const digest = storeSnapshotDigest(db);
  db.close();
  return { digest, appliedCount: applied.length, partialTrailingLine };
}

export { MEMORY_STORE_IDENTITY_SCHEMA };
