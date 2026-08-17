// src/memory/inheritance-cbm.mjs
//
// DECOMP-OPT1-PC1 — CBM-first inheritance retrieval（S / C）.
//
// The decomposition-inheritance manifest is RECORDED into CBM as a CODE
// memory record（scope-bound to repository + tree + manifest path）through
// the EXISTING governed write-back gate（UNVERIFIED trust, writer origin —
// the harness writes the manifest artifact; no self-promotion）and QUERIED
// deterministically（exact scope path; ordered by record_id）.
//
// Rules（card §C）:
//   - CBM reliable hit（verified manifest, same tree）→ REUSE the manifest
//   - hit requiring freshness（tree changed）→ REVALIDATE（caller rebuilds）
//   - miss → bounded source build（never unbounded fallback）
//   - conflict（2+ CURRENT records, different contentHash）→ SURFACED; live
//     authority wins; caller rebuilds fresh（never silent pick）
//   - corrupt / tampered record（manifest digest mismatch）→ fail closed;
//     caller rebuilds fresh and the stale record is surfaced
//
// Every outcome is structured; failures NEVER change task semantics（the
// manifest is an optimization layer, the live observation is the authority）.
// If the write-back gate has no path for this record, the caller records
// CBM_DECOMP_INHERITANCE_WRITEBACK_GAP（never fabricates a hit）.

import { createWritebackCandidate } from "./writeback/candidate.mjs";
import { runWritebackGate } from "./writeback/gate.mjs";
import { verifyManifestIntegrity, DECOMPOSITION_INHERITANCE_SCHEMA } from "../v2/decomposition-inheritance.mjs";

export const INHERITANCE_MANIFEST_PATH_PREFIX = "autoloop.decomposition-inheritance";
export const INHERITANCE_CBM_SCHEMA = "autoloop.inheritance-cbm/v1";

export function inheritanceManifestPath(parentCardId) {
  return `${INHERITANCE_MANIFEST_PATH_PREFIX}/${String(parentCardId).replace(/[^A-Za-z0-9_.-]/g, "_")}/manifest.json`;
}

/**
 * Query CBM for a recorded inheritance manifest for（repository, parentCardId）.
 * Deterministic: exact scope path + repository scope, ORDER BY record_id.
 *
 * @param {object} opts
 * @param {object} opts.store — open LocalMemoryStore
 * @param {string} opts.repositoryIdentity — hex64 repository identity
 * @param {string} opts.parentCardId
 * @param {string} opts.treeSha — current tree（freshness signal）
 * @returns {{ status: "HIT"|"STALE"|"CONFLICT"|"MISS"|"CORRUPT",
 *             manifest?: object, records: object[], reason: string }}
 */
export function queryInheritanceManifest({ store, repositoryIdentity, parentCardId, treeSha }) {
  if (!store || typeof store.db?.prepare !== "function") {
    return { status: "MISS", records: [], reason: "store_not_open" };
  }
  if (typeof repositoryIdentity !== "string" || !/^[0-9a-f]{64}$/.test(repositoryIdentity)) {
    return { status: "MISS", records: [], reason: "repository_identity_malformed" };
  }
  const path = inheritanceManifestPath(parentCardId);
  let rows;
  try {
    rows = store.db
      .prepare(
        "SELECT json FROM memory_records WHERE validity_status = 'CURRENT' AND record_type = 'CODE'" +
        " AND json_extract(json, '$.scope.repository') = ? AND json_extract(json, '$.scope.path') = ?" +
        " ORDER BY record_id"
      )
      .all(repositoryIdentity, path);
  } catch (e) {
    return { status: "MISS", records: [], reason: `query_failed:${e?.code ?? e?.name ?? "error"}` };
  }
  const records = rows.map((r) => JSON.parse(r.json));

  const candidates = [];
  const corrupt = [];
  for (const rec of records) {
    const text = typeof rec?.content?.text === "string" ? rec.content.text : null;
    if (!text) continue;
    let manifest = null;
    try {
      manifest = JSON.parse(text);
    } catch {
      corrupt.push(rec.recordId);
      continue;
    }
    if (!manifest || manifest.schema !== DECOMPOSITION_INHERITANCE_SCHEMA) {
      corrupt.push(rec.recordId);
      continue;
    }
    const iv = verifyManifestIntegrity(manifest);
    if (!iv.ok) {
      corrupt.push(rec.recordId);
      continue;
    }
    candidates.push({ recordId: rec.recordId, manifest });
  }

  if (corrupt.length > 0 && candidates.length === 0) {
    return { status: "CORRUPT", records, reason: `record(s) present but manifest digest/parse failed: ${corrupt.slice(0, 3).join(",")}` };
  }
  if (candidates.length === 0) {
    return { status: "MISS", records, reason: "no current inheritance manifest record" };
  }
  // Freshness is tree-bound: only records whose manifest tree equals the LIVE
  // tree are reuse candidates. Older-tree records ⇒ STALE（revalidate）.
  // A real conflict is TWO records for the SAME tree with different content.
  const fresh = treeSha
    ? candidates.filter((c) => (c.manifest.repositoryIdentity?.expected_tree ?? null) === treeSha)
    : candidates;
  if (fresh.length === 0) {
    return { status: "STALE", manifest: candidates[0].manifest, records, reason: `no recorded manifest matches the live tree ${treeSha ? treeSha.slice(0, 12) : "?"}…（freshness expired）` };
  }
  if (fresh.length > 1) {
    const distinct = new Set(fresh.map((c) => c.manifest.manifestSha256));
    if (distinct.size > 1) {
      // Same tree, different content — surfaced, live authority wins.
      return {
        status: "CONFLICT",
        records,
        reason: `conflicting CURRENT manifest records for the same tree: ${fresh.map((c) => c.recordId).join(",")}`,
      };
    }
    return { status: "HIT", manifest: fresh[0].manifest, records, reason: "duplicate identical records; single verified manifest reused" };
  }
  const manifest = fresh[0].manifest;
  return { status: "HIT", manifest, records, reason: "verified manifest record matches the live tree" };
}

/**
 * Query CBM for prior evidence locations for one child phase（§H reference
 * inheritance）. Records are EXECUTION/CODE records scoped to
 * `.../evidence/<childCardId>/`; each record's content.text carries the
 * evidence identity（sha256）. Deterministic: scope-path exact, ORDER BY
 * record_id.
 *
 * @returns {{ status: "HIT"|"MISS"|"CONFLICT", refs?: string[], reason: string }}
 */
export function queryChildEvidenceRefs({ store, repositoryIdentity, parentCardId, childCardId }) {
  if (!store || typeof store.db?.prepare !== "function") {
    return { status: "MISS", refs: [], reason: "store_not_open" };
  }
  if (typeof repositoryIdentity !== "string" || !/^[0-9a-f]{64}$/.test(repositoryIdentity)) {
    return { status: "MISS", refs: [], reason: "repository_identity_malformed" };
  }
  const prefix = `${INHERITANCE_MANIFEST_PATH_PREFIX}/${String(parentCardId).replace(/[^A-Za-z0-9_.-]/g, "_")}/evidence/${String(childCardId).replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  let rows;
  try {
    rows = store.db
      .prepare(
        "SELECT json FROM memory_records WHERE validity_status = 'CURRENT'" +
        " AND json_extract(json, '$.scope.repository') = ?" +
        " AND json_extract(json, '$.scope.path') LIKE ?" +
        " ORDER BY record_id"
      )
      .all(repositoryIdentity, `${prefix}%`);
  } catch (e) {
    return { status: "MISS", refs: [], reason: `query_failed:${e?.code ?? e?.name ?? "error"}` };
  }
  const refs = [];
  const seen = new Set();
  for (const r of rows) {
    const rec = JSON.parse(r.json);
    const text = typeof rec?.content?.text === "string" ? rec.content.text : null;
    if (text && /^[0-9a-f]{64}$/.test(text) && !seen.has(text)) {
      seen.add(text);
      refs.push(text);
    }
  }
  if (refs.length === 0) return { status: "MISS", refs: [], reason: "no prior evidence refs recorded" };
  return { status: "HIT", refs, reason: `resolved ${refs.length} prior evidence ref(s) by identity` };
}

/**
 * Record the inheritance manifest into CBM through the governed write-back
 * gate（origin "writer", UNVERIFIED — the harness writes the manifest
 * artifact; never self-promotes）. Failures are structured outcomes, never
 * exceptions.
 *
 * @param {object} opts
 * @param {object} opts.store — open LocalMemoryStore
 * @param {object} opts.manifest — verified inheritance manifest
 * @param {string} opts.graphRunId — parent run identity
 * @param {string} opts.repositoryIdentity — hex64（from resolveRepositoryIdentity）
 * @param {string} [opts.expectedRepository] — same as repositoryIdentity
 * @returns {Promise<{ ok: boolean, status: string, recordId?: string, logicalKey?: string, reason?: string }>}
 */
export async function recordInheritanceManifest({ store, manifest, graphRunId, repositoryIdentity, expectedRepository = null }) {
  const integrity = verifyManifestIntegrity(manifest);
  if (!integrity.ok) {
    return { ok: false, status: "WRITEBACK_REJECTED", reason: `manifest_integrity:${integrity.code}` };
  }
  if (!store || typeof store.explicitImport !== "function") {
    return { ok: false, status: "WRITEBACK_STORE_INVALID", reason: "store_not_open" };
  }
  const path = inheritanceManifestPath(manifest.parentCardId);
  const statement = `decomposition-inheritance manifest ${manifest.manifestIdentity} for parent ${manifest.parentCardId} @ ${manifest.repositoryIdentity?.expected_head ?? "?"}`;

  let candidate;
  try {
    candidate = createWritebackCandidate({
      graphRunId,
      taskCardId: "parent-run",
      originatingNode: "parent-run",
      sourceResultIdentity: manifest.manifestSha256,
      proposedRecordType: "CODE",
      proposedIdentity: {
        repositoryIdentity,
        commitSha: manifest.repositoryIdentity?.expected_head ?? null,
        treeSha: manifest.repositoryIdentity?.expected_tree ?? null,
        path,
        knowledgeKind: "FILE",
      },
      proposedSubjectStatement: statement,
      proposedContent: { kind: "TEXT", text: JSON.stringify(manifest) },
      proposedScope: {
        repository: repositoryIdentity,
        tree: manifest.repositoryIdentity?.expected_tree ?? null,
        path,
      },
      evidenceReferences: [manifest.manifestSha256],
      proposedTrust: "UNVERIFIED",
      lifecycleIntent: "CREATE",
      origin: "writer",
    });
  } catch (e) {
    return { ok: false, status: "WRITEBACK_REJECTED", reason: `candidate_invalid:${String(e?.message ?? e).slice(0, 200)}` };
  }

  try {
    const outcome = await runWritebackGate({
      candidate,
      store,
      expectedRepository: expectedRepository ?? repositoryIdentity,
    });
    return {
      ok: outcome.status === "WRITEBACK_ACCEPTED" || outcome.status === "WRITEBACK_DUPLICATE",
      status: outcome.status,
      recordId: outcome.recordId ?? null,
      logicalKey: outcome.logicalKey ?? null,
      reason: outcome.reason ?? null,
    };
  } catch (e) {
    return { ok: false, status: "WRITEBACK_EXCEPTION", reason: String(e?.message ?? e).slice(0, 200) };
  }
}
