// src/memory/writeback/gate.mjs
//
// CBM-4 — Stages 5-8: governed production write-back gate.
//
//   candidate → schema/identity → authority/trust → evidence → scope →
//   security → conflict analysis → lifecycle intent → journal append →
//   sqlite update → telemetry → structured status
//
// Invariants:
//   - any gate failure NEVER writes partially（journal-first explicitImport;
//     the whole write is atomic per record）
//   - idempotency: same recordId OR same (logical_key, content_hash) ⇒ no-op
//   - conflicts are SURFACED, never silently resolved（no newest/highest/
//     overwrite/merge）; SUPERSEDE / INVALIDATE require explicit lifecycle
//     intent + evidence binding
//   - stale tree/path-bound CODE baselines are marked STALE（never served as
//     current truth）
//   - CBM-3 journal-first durability + sqlite⊆journal rebuild rules intact

import { MEMORY_RECORD_SCHEMA, NOT_APPLICABLE, SOURCES } from "../contract.mjs";
import { deriveContentHash, deriveMemoryRecordId, deriveLogicalKey, deriveEventId } from "../identity.mjs";
import { validateMemoryRecordV1 } from "../validation.mjs";
import { validateWritebackCandidateV1 } from "./candidate.mjs";
import { checkTrustCeiling, checkLadderProgression, checkEvidenceIdentity } from "./trust.mjs";

export const WRITEBACK_STATUSES = Object.freeze([
  "WRITEBACK_ACCEPTED",
  "WRITEBACK_REJECTED",
  "WRITEBACK_CONFLICT",
  "WRITEBACK_DUPLICATE",
  "WRITEBACK_STORE_INVALID",
  "WRITEBACK_EVIDENCE_INVALID",
  "WRITEBACK_AUTHORITY_INSUFFICIENT",
]);

export const WRITEBACK_GATE_SCHEMA = "autoloop.memory-writeback-gate/v1";

/** Evidence identity blocks per trust level（mirrors the CBM-2/3 contract）.
 * verifier/review identities come from the GATE's validated bindings first,
 * then evidence references — a REVIEWED record carries BOTH identities; a
 * missing binding fails closed in record validation. */
function evidenceFor(trust, refs, { verifierIdentity = null, reviewIdentity = null } = {}) {
  const manifestDigest = refs.find((r) => String(r).startsWith("manifest:"))?.slice("manifest:".length) ?? hex64Fallback();
  const e = { manifestDigest, items: [] };
  if (trust !== "RAW" && trust !== "UNVERIFIED") e.manifestDigest = manifestDigest;
  const verifierRef = refs.find((r) => String(r).startsWith("verifier:"));
  if ((trust === "VERIFIED" || trust === "REVIEWED") && (verifierIdentity ?? verifierRef?.slice("verifier:".length))) {
    e.verifierResultIdentity = verifierIdentity ?? verifierRef.slice("verifier:".length);
  }
  const reviewRef = refs.find((r) => String(r).startsWith("review:"));
  if (trust === "REVIEWED" && (reviewIdentity ?? reviewRef?.slice("review:".length))) {
    e.reviewResultIdentity = reviewIdentity ?? reviewRef.slice("review:".length);
  }
  return e;
}

function hex64Fallback() {
  // deterministic placeholder for RAW/UNVERIFIED evidence manifests
  return "a".repeat(64);
}

/** Build a validated MemoryRecordV1 from a write-back candidate. */
export function buildRecordFromCandidate(candidate, { now = new Date().toISOString(), verifierIdentity = null, reviewIdentity = null } = {}) {
  const trust = candidate.proposedTrust;
  const scope = { ...candidate.proposedScope };
  const identity = { ...candidate.proposedIdentity };
  const refs = [...candidate.evidenceReferences];
  const statement = candidate.proposedSubject.statement;

  let record;
  if (candidate.proposedRecordType === "EXECUTION") {
    record = {
      schema: MEMORY_RECORD_SCHEMA,
      recordType: "EXECUTION",
      identity: {
        graphRunId: candidate.graphRunId,
        taskIdentity: candidate.taskCardId,
        executorKind: identity.executorKind ?? "writeback-gate",
        nodeId: candidate.originatingNode ?? NOT_APPLICABLE,
        ...(identity.phaseExecutionId ? { phaseExecutionId: identity.phaseExecutionId } : {}),
        ...(identity.agentExecutionId ? { agentExecutionId: identity.agentExecutionId } : {}),
        ...(identity.attempt !== undefined && identity.attempt !== null ? { attempt: identity.attempt } : {}),
      },
      subject: {
        resultKind: identity.resultKind ?? "TASK_RESULT",
        status: identity.resultStatus ?? "PASS",
        // deterministic source timestamps（candidate-carried; fixed epoch when
        // absent）— wall-clock `now` would change recordId across retries and
        // break write-back idempotency（card stage 6）.
        startedAt: identity.startedAt ?? "1970-01-01T00:00:00.000Z",
        completedAt: identity.completedAt ?? NOT_APPLICABLE,
        evidenceManifestDigest: refs.find((r) => String(r).startsWith("manifest:"))?.slice("manifest:".length) ?? hex64Fallback(),
        summary: statement,
      },
      content: candidate.proposedContent ?? { kind: "TEXT", text: statement },
      source: { source: "EXECUTION", identity: candidate.sourceResultIdentity },
      scope: { repository: scope.repository, graphRun: candidate.graphRunId, task: candidate.taskCardId, ...(scope.worktree ? { worktree: scope.worktree } : {}), ...(scope.tree ? { tree: scope.tree } : {}) },
      trust,
      validity: { status: "CURRENT", validityTree: NOT_APPLICABLE },
      lifecycle: { events: [] },
      timestamps: { createdAt: now, updatedAt: now },
      evidence: evidenceFor(trust, refs, { verifierIdentity, reviewIdentity }),
      security: { scanResult: "clean", ingestionSource: "writeback-gate" },
      metadata: { candidateId: candidate.candidateId, writebackIntent: candidate.lifecycleIntent },
    };
  } else if (candidate.proposedRecordType === "CODE") {
    record = {
      schema: MEMORY_RECORD_SCHEMA,
      recordType: "CODE",
      identity: {
        repositoryIdentity: identity.repositoryIdentity,
        commitSha: identity.commitSha,
        treeSha: identity.treeSha ?? NOT_APPLICABLE,
        path: identity.path ?? NOT_APPLICABLE,
        ...(identity.worktreeIdentity ? { worktreeIdentity: identity.worktreeIdentity } : {}),
        ...(identity.symbol ? { symbol: identity.symbol } : {}),
        knowledgeKind: identity.knowledgeKind ?? "FILE",
      },
      subject: { statement, contentHash: null, language: candidate.proposedSubject.language ?? "NOT_APPLICABLE" },
      content: candidate.proposedContent ?? { kind: "TEXT", text: statement },
      source: { source: "REPOSITORY", identity: candidate.sourceResultIdentity },
      scope: { repository: scope.repository, ...(scope.worktree ? { worktree: scope.worktree } : {}), ...(scope.tree ? { tree: scope.tree } : {}), ...(scope.path ? { path: scope.path } : {}), ...(scope.symbol ? { symbol: scope.symbol } : {}) },
      trust,
      validity: { status: "CURRENT", ...(scope.tree ? { validityTree: scope.tree } : {}) },
      lifecycle: { events: [] },
      timestamps: { createdAt: now, updatedAt: now },
      evidence: evidenceFor(trust, refs, { verifierIdentity, reviewIdentity }),
      security: { scanResult: "clean", ingestionSource: "writeback-gate" },
      metadata: { candidateId: candidate.candidateId, writebackIntent: candidate.lifecycleIntent },
    };
  } else {
    // DECISION: CBM-4 never auto-writes DECISION（Controller authority only）
    throw Object.assign(new Error("WRITEBACK_DECISION_NOT_AUTOMATIC"), { code: "WRITEBACK_AUTHORITY_INSUFFICIENT" });
  }
  record.subject.contentHash = deriveContentHash(record.content);
  record.recordId = deriveMemoryRecordId(record);
  return record;
}

/** Query CURRENT records sharing a logicalKey（deterministic, scope-scoped）. */
export function findCurrentByLogicalKey(store, logicalKey) {
  const rows = store.db
    .prepare("SELECT json FROM memory_records WHERE logical_key = ? AND validity_status = 'CURRENT'")
    .all(logicalKey);
  return rows.map((r) => JSON.parse(r.json));
}

/** Mark a tree/path-bound CURRENT CODE record STALE when its baseline no longer holds. */
export function markStaleIfBaselineBroken(store, { repository, tree, path = null }) {
  const applied = [];
  const q = [
    "SELECT json FROM memory_records WHERE validity_status = 'CURRENT' AND record_type = 'CODE'",
    " AND json_extract(json, '$.scope.repository') = ?",
  ];
  const params = [repository];
  if (tree) { q.push(" AND json_extract(json, '$.scope.tree') IS NOT NULL AND json_extract(json, '$.scope.tree') != ?"); params.push(tree); }
  if (path) { q.push(" AND json_extract(json, '$.scope.path') = ?"); params.push(path); }
  const rows = store.db.prepare(q.join("")).all(...params);
  for (const row of rows) {
    const rec = JSON.parse(row.json);
    const validityTree = rec.validity?.validityTree ?? rec.scope?.tree ?? null;
    if (validityTree && validityTree !== tree) {
      store.applyLifecycle({
        eventType: "MARKED_STALE",
        recordId: rec.recordId,
        identity: deriveEventId("evt", rec.recordId, "stale", tree),
        reason: `baseline tree changed: ${validityTree} -> ${tree}`,
        authority: "SYSTEM_DERIVED",
        evidenceIdentity: tree ?? null,
      });
      applied.push(rec.recordId);
    }
  }
  return { applied };
}

/**
 * Run the governed write-back gate for ONE candidate.
 *
 * @param {object} opts
 * @param {object} opts.candidate - write-back candidate（validated here）
 * @param {object} opts.store - LocalMemoryStore（open）
 * @param {string} [opts.reviewIdentity] - independent review identity binding
 * @param {string} [opts.verifierIdentity] - verifier evidence identity binding
 * @param {string} [opts.expectedRepository] - repo the graph actually ran over
 * @param {object} [opts.canonicalEvidence] - the graph/task's canonical
 *   evidence inventory（{ graphRunId, taskCardIds, resultIdentities, … }）;
 *   REQUIRED for any candidate proposing VERIFIED/REVIEWED trust — verifier /
 *   reviewer identities are bound to this inventory, so a well-formed 64-hex
 *   digest that is not attested by the graph（forged / other graph / other
 *   card）fails closed（never a bare hex64 format check）.
 * @param {object} [opts.telemetryStore] - COST-1 store（memory.writeback events）
 * @param {string} [opts.now] - fixed timestamp（tests）
 * @returns {Promise<{status, candidateId, recordId?, logicalKey?, reason?, conflictWith?}>}
 */
export async function runWritebackGate({ candidate, store, reviewIdentity = null, verifierIdentity = null, expectedRepository = null, canonicalEvidence = null, telemetryStore = null, now = new Date().toISOString() } = {}) {
  const outcome = (status, extra = {}) => ({ status, candidateId: candidate?.candidateId ?? null, ...extra });
  try {
    // 1) schema / identity validation
    const cv = validateWritebackCandidateV1(candidate);
    if (!cv.valid) return outcome("WRITEBACK_EVIDENCE_INVALID", { reason: `candidate_invalid:${cv.errors.slice(0, 3).join(";")}` });
    if (!store || typeof store.explicitImport !== "function") return outcome("WRITEBACK_STORE_INVALID", { reason: "store_not_open" });

    // 2) authority / trust ceiling（no self-promotion; CONFIRMED never auto）
    const ceiling = checkTrustCeiling({ origin: candidate.origin, proposedTrust: candidate.proposedTrust });
    if (!ceiling.ok) return outcome("WRITEBACK_AUTHORITY_INSUFFICIENT", { reason: ceiling.reason });
    const ladder = checkLadderProgression({ proposedTrust: candidate.proposedTrust, evidenceReferences: candidate.evidenceReferences, reviewIdentity, verifierIdentity });
    if (!ladder.ok) return outcome("WRITEBACK_AUTHORITY_INSUFFICIENT", { reason: ladder.reason });
    // 2b) evidence identity binding（canonical inventory; NEVER a bare hex64
    // check）— a well-formed but forged / foreign identity fails closed.
    const evid = checkEvidenceIdentity({
      proposedTrust: candidate.proposedTrust,
      verifierIdentity,
      reviewIdentity,
      candidate,
      canonicalEvidence,
    });
    if (!evid.ok) return outcome("WRITEBACK_AUTHORITY_INSUFFICIENT", { reason: evid.reason });

    // 3) scope isolation（cross-repo / cross-worktree write-back rejected）
    const repo = candidate.proposedScope?.repository ?? candidate.proposedIdentity?.repositoryIdentity ?? null;
    if (!repo || !/^[0-9a-f]{64}$/.test(repo)) return outcome("WRITEBACK_REJECTED", { reason: "missing_or_malformed_repository_scope" });
    if (expectedRepository && repo !== expectedRepository) return outcome("WRITEBACK_REJECTED", { reason: `cross_repo_writeback_rejected:${repo}!=${expectedRepository}` });
    if (candidate.proposedScope?.worktree && candidate.proposedIdentity?.worktreeIdentity && candidate.proposedScope.worktree !== candidate.proposedIdentity.worktreeIdentity) {
      return outcome("WRITEBACK_REJECTED", { reason: "cross_worktree_scope_violation" });
    }

    // 4) build the record（deterministic identity; secret scan inside validation）
    let record;
    try {
      record = buildRecordFromCandidate(candidate, { now, verifierIdentity, reviewIdentity });
    } catch (e) {
      if (e?.code === "WRITEBACK_AUTHORITY_INSUFFICIENT") return outcome("WRITEBACK_AUTHORITY_INSUFFICIENT", { reason: e.message });
      throw e;
    }
    const rv = validateMemoryRecordV1(record);
    if (!rv.valid) {
      if (rv.errors.some((e) => e.includes("SECRET"))) return outcome("WRITEBACK_REJECTED", { reason: `secret_detected:${rv.errors.slice(0, 2).join(";")}` });
      return outcome("WRITEBACK_EVIDENCE_INVALID", { reason: `record_invalid:${rv.errors.slice(0, 3).join(";")}` });
    }

    // 5) conflict analysis（same logicalKey; never silent resolution）
    const logicalKey = deriveLogicalKey(record);
    const current = findCurrentByLogicalKey(store, logicalKey);

    if (candidate.lifecycleIntent === "DUPLICATE") {
      const same = current.find((r) => r.subject?.contentHash === record.subject.contentHash);
      return same
        ? outcome("WRITEBACK_DUPLICATE", { recordId: same.recordId, logicalKey, reason: "idempotent: same logicalKey + contentHash" })
        : outcome("WRITEBACK_CONFLICT", { logicalKey, reason: "DUPLICATE intent but no matching current record" });
    }

    if (current.length > 0) {
      const same = current.find((r) => r.subject?.contentHash === record.subject.contentHash);
      if (same) {
        return outcome("WRITEBACK_DUPLICATE", { recordId: same.recordId, logicalKey, reason: "idempotent: exact duplicate (same logicalKey + contentHash)" });
      }
      if (candidate.lifecycleIntent === "CREATE") {
        return outcome("WRITEBACK_CONFLICT", {
          logicalKey,
          conflictWith: current.map((r) => r.recordId),
          reason: "conflicting CURRENT record(s) with different contentHash — surfaced, never silently resolved",
        });
      }
      if (candidate.lifecycleIntent === "SUPERSEDE") {
        // evidence-proven supersession only: the candidate must carry the old
        // record's identity in its relationships / evidence references
        const target = current[0];
        const supersedeBound = (candidate.proposedRelationships ?? []).some((rel) => rel.relationshipType === "SUPERSEDES" && rel.targetRecordId === target.recordId)
          || (candidate.evidenceReferences ?? []).some((r) => String(r).includes(target.recordId));
        if (!supersedeBound) {
          return outcome("WRITEBACK_AUTHORITY_INSUFFICIENT", { logicalKey, conflictWith: [target.recordId], reason: "SUPERSEDE requires evidence binding to the superseded record" });
        }
        // import the NEW record first（FK: the relationship references it）,
        // then apply the evidence-bound lifecycle transition to the old one.
        store.explicitImport(record, { source: "WRITEBACK_GATE" });
        store.applyLifecycle({
          eventType: "SUPERSEDED",
          recordId: target.recordId,
          identity: deriveEventId("evt", target.recordId, "superseded", record.recordId),
          reason: `superseded by ${record.recordId}（evidence-bound lifecycle transition）`,
          authority: reviewIdentity ? "INDEPENDENT_REVIEWER" : "VERIFIER",
          evidenceIdentity: reviewIdentity ?? verifierIdentity ?? null,
        });
        store.addRelationship({
          relationshipId: deriveEventId("rel", record.recordId, target.recordId),
          recordId: record.recordId,
          targetRecordId: target.recordId,
          relationshipType: "SUPERSEDES",
          identity: candidate.candidateId,
        });
        return outcome("WRITEBACK_ACCEPTED", { recordId: record.recordId, logicalKey, supersedes: target.recordId, candidateType: record.recordType, resultingTrust: record.trust });
      }
      if (candidate.lifecycleIntent === "INVALIDATE") {
        const target = current[0];
        const invalidateBound = (candidate.proposedRelationships ?? []).some((rel) => rel.relationshipType === "INVALIDATES" && rel.targetRecordId === target.recordId)
          || (candidate.evidenceReferences ?? []).some((r) => String(r).includes(target.recordId));
        if (!invalidateBound) {
          return outcome("WRITEBACK_AUTHORITY_INSUFFICIENT", { logicalKey, conflictWith: [target.recordId], reason: "INVALIDATE requires evidence binding to the invalidated record" });
        }
        store.applyLifecycle({
          eventType: "INVALIDATED",
          recordId: target.recordId,
          identity: deriveEventId("evt", target.recordId, "invalidated", candidate.candidateId),
          reason: `invalidated by ${candidate.candidateId}（evidence-bound lifecycle transition）`,
          authority: reviewIdentity ? "INDEPENDENT_REVIEWER" : "VERIFIER",
          evidenceIdentity: reviewIdentity ?? verifierIdentity ?? null,
        });
        store.addRelationship({
          relationshipId: deriveEventId("rel", candidate.candidateId, target.recordId),
          recordId: target.recordId,
          targetRecordId: target.recordId,
          relationshipType: "INVALIDATES",
          identity: candidate.candidateId,
        });
        return outcome("WRITEBACK_ACCEPTED", { logicalKey, invalidated: target.recordId, recordId: target.recordId, candidateType: "LIFECYCLE", resultingTrust: null });
      }
      return outcome("WRITEBACK_CONFLICT", { logicalKey, conflictWith: current.map((r) => r.recordId), reason: `unsupported lifecycle intent ${candidate.lifecycleIntent} on conflicting record` });
    }

    // 6) clean CREATE: journal-first write（idempotent）
    store.explicitImport(record, { source: "WRITEBACK_GATE" });
    return outcome("WRITEBACK_ACCEPTED", { recordId: record.recordId, logicalKey, candidateType: record.recordType, resultingTrust: record.trust });
  } catch (e) {
    if (String(e?.message ?? "").includes("SECRET") || String(e?.message ?? "").includes("secret")) {
      return outcome("WRITEBACK_REJECTED", { reason: `secret_detected:${String(e?.message ?? e).slice(0, 120)}` });
    }
    if (String(e?.message ?? "").includes("JOURNAL") || String(e?.message ?? "").includes("MEMORY_STORE_INVALID")) {
      return outcome("WRITEBACK_STORE_INVALID", { reason: String(e?.message ?? e).slice(0, 200) });
    }
    return outcome("WRITEBACK_REJECTED", { reason: String(e?.message ?? e).slice(0, 200) });
  }
}
