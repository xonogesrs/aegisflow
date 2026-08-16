// src/memory/writeback/candidate.mjs
//
// CBM-4 — Stage 2: write-back candidate contract
//（autoloop.memory-writeback-candidate/v1）.
//
// A candidate is NOT yet a memory record. It carries everything the write-back
// gate needs to decide（identity / authority / evidence / trust intent /
// lifecycle intent / provenance）and FAILS CLOSED when any binding is missing.
//
// Deterministic identity: candidateId = sha256(canonical({schema, graphRunId,
// originatingNode, sourceResultIdentity, proposedRecordType, proposedIdentity,
// lifecycleIntent})) — NEVER timestamp / rowid / mtime / nondeterministic
// ordering / free-form stdout. Same canonical source ⇒ same candidateId.

import { createHash } from "node:crypto";

export const WRITEBACK_CANDIDATE_SCHEMA = "autoloop.memory-writeback-candidate/v1";
export const WRITEBACK_CANDIDATE_SCHEMA_VERSION = 1;

export const WRITEBACK_RECORD_TYPES = Object.freeze(["EXECUTION", "CODE", "DECISION"]);
export const WRITEBACK_TRUST_INTENTS = Object.freeze(["UNVERIFIED", "VERIFIED", "REVIEWED"]);
// CONFIRMED is NOT a legal write-back intent（Controller-only; card stage 4）.
export const WRITEBACK_LIFECYCLE_INTENTS = Object.freeze([
  "CREATE",        // brand-new logical memory
  "SUPERSEDE",     // evidence-proven replacement of an existing CURRENT record
  "INVALIDATE",    // evidence-proven invalidation of an existing CURRENT record
  "DUPLICATE",     // same logicalKey + same contentHash（idempotent）
]);
export const WRITEBACK_ORIGINS = Object.freeze([
  "graph_closeout", "executor", "writer", "verifier", "independent_reviewer", "controller",
]);

export class WritebackCandidateError extends Error {
  constructor(reasons) {
    super(`writeback_candidate_violation: ${reasons.join("; ")}`);
    this.name = "WritebackCandidateError";
    this.reasons = reasons;
  }
}

export function sha256Hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

/** Canonical（sorted-key）JSON — deterministic identity base. */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Deterministic candidate identity（same canonical source ⇒ same id）.
 * Independent of timestamps / rowid / mtime / ordering / free text.
 */
export function candidateIdFor({ graphRunId, originatingNode, sourceResultIdentity, proposedRecordType, proposedIdentity, lifecycleIntent = "CREATE" }) {
  return sha256Hex(canonicalJson({
    schema: WRITEBACK_CANDIDATE_SCHEMA,
    graphRunId,
    originatingNode,
    sourceResultIdentity,
    proposedRecordType,
    proposedIdentity,
    lifecycleIntent,
  }));
}

/**
 * Build a candidate with a deterministic id.
 * @param {object} o
 * @param {string} o.graphRunId
 * @param {string} o.taskCardId - card identity
 * @param {string} o.originatingNode - nodeId
 * @param {string} o.sourceResultIdentity - result identity the candidate derives from
 * @param {string} o.proposedRecordType - EXECUTION | CODE | DECISION
 * @param {object} o.proposedIdentity - record identity anchors（repo/tree/path…）
 * @param {string} o.proposedSubjectStatement - the knowledge statement（bounded）
 * @param {object} [o.proposedContent] - { kind, text?|data? } bounded payload
 * @param {object} o.proposedScope - record scope（repo/worktree/tree/path）
 * @param {string[]} o.evidenceReferences - evidence identity refs
 * @param {string} o.proposedTrust - UNVERIFIED | VERIFIED | REVIEWED
 * @param {string[]} [o.proposedRelationships]
 * @param {string} [o.lifecycleIntent] - CREATE | SUPERSEDE | INVALIDATE | DUPLICATE
 * @param {string} [o.origin] - who proposed it（trust gate checks this）
 */
export function createWritebackCandidate(o) {
  const errors = [];
  for (const k of ["graphRunId", "taskCardId", "originatingNode", "sourceResultIdentity", "proposedRecordType", "proposedSubjectStatement", "proposedTrust", "origin"]) {
    if (!o?.[k]) errors.push(`${k}_required`);
  }
  if (o?.proposedRecordType && !WRITEBACK_RECORD_TYPES.includes(o.proposedRecordType)) errors.push(`bad_proposedRecordType:${o.proposedRecordType}`);
  if (o?.proposedTrust && !WRITEBACK_TRUST_INTENTS.includes(o.proposedTrust)) errors.push(`bad_proposedTrust:${o.proposedTrust}（CONFIRMED is Controller-only and never an automatic write-back intent）`);
  if (o?.lifecycleIntent && !WRITEBACK_LIFECYCLE_INTENTS.includes(o.lifecycleIntent)) errors.push(`bad_lifecycleIntent:${o.lifecycleIntent}`);
  if (o?.origin && !WRITEBACK_ORIGINS.includes(o.origin)) errors.push(`bad_origin:${o.origin}`);
  if (!o?.proposedIdentity || typeof o.proposedIdentity !== "object") errors.push("proposedIdentity_required");
  if (!o?.proposedScope || typeof o.proposedScope !== "object") errors.push("proposedScope_required");
  if (!Array.isArray(o?.evidenceReferences) || o.evidenceReferences.length === 0) errors.push("evidenceReferences_required");
  if (errors.length) throw new WritebackCandidateError(errors);

  const proposedIdentity = { ...o.proposedIdentity };
  const proposedScope = { ...o.proposedScope };
  const candidate = {
    schema: WRITEBACK_CANDIDATE_SCHEMA,
    schemaVersion: WRITEBACK_CANDIDATE_SCHEMA_VERSION,
    candidateId: candidateIdFor({
      graphRunId: o.graphRunId,
      originatingNode: o.originatingNode,
      sourceResultIdentity: o.sourceResultIdentity,
      proposedRecordType: o.proposedRecordType,
      proposedIdentity,
      lifecycleIntent: o.lifecycleIntent ?? "CREATE",
    }),
    graphRunId: o.graphRunId,
    taskCardId: o.taskCardId,
    originatingNode: o.originatingNode,
    sourceResultIdentity: o.sourceResultIdentity,
    proposedRecordType: o.proposedRecordType,
    proposedIdentity,
    proposedSubject: { statement: o.proposedSubjectStatement },
    proposedContent: o.proposedContent ?? { kind: "TEXT", text: null },
    proposedScope,
    evidenceReferences: [...o.evidenceReferences],
    proposedTrust: o.proposedTrust,
    proposedRelationships: Array.isArray(o.proposedRelationships) ? o.proposedRelationships.slice() : [],
    lifecycleIntent: o.lifecycleIntent ?? "CREATE",
    origin: o.origin,
    provenance: {
      graphRunId: o.graphRunId,
      nodeId: o.originatingNode,
      sourceResultIdentity: o.sourceResultIdentity,
      taskCardId: o.taskCardId,
    },
  };
  return candidate;
}

/**
 * Validate a candidate（allowlist; unknown fields fail closed）.
 */
export function validateWritebackCandidateV1(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== "object") return { valid: false, errors: ["candidate_missing"] };
  const allowed = new Set([
    "schema", "schemaVersion", "candidateId", "graphRunId", "taskCardId", "originatingNode",
    "sourceResultIdentity", "proposedRecordType", "proposedIdentity", "proposedSubject",
    "proposedContent", "proposedScope", "evidenceReferences", "proposedTrust",
    "proposedRelationships", "lifecycleIntent", "origin", "provenance",
  ]);
  for (const k of Object.keys(candidate)) if (!allowed.has(k)) errors.push(`unknown_field:${k}`);
  if (candidate.schema !== WRITEBACK_CANDIDATE_SCHEMA) errors.push(`schema_mismatch:${String(candidate.schema)}`);
  if (candidate.schemaVersion !== WRITEBACK_CANDIDATE_SCHEMA_VERSION) errors.push("schemaVersion_mismatch");
  if (!WRITEBACK_RECORD_TYPES.includes(candidate.proposedRecordType)) errors.push(`bad_proposedRecordType:${String(candidate.proposedRecordType)}`);
  if (!WRITEBACK_TRUST_INTENTS.includes(candidate.proposedTrust)) errors.push(`bad_proposedTrust:${String(candidate.proposedTrust)}`);
  if (!WRITEBACK_LIFECYCLE_INTENTS.includes(candidate.lifecycleIntent)) errors.push(`bad_lifecycleIntent:${String(candidate.lifecycleIntent)}`);
  if (!WRITEBACK_ORIGINS.includes(candidate.origin)) errors.push(`bad_origin:${String(candidate.origin)}`);
  if (typeof candidate.graphRunId !== "string" || !candidate.graphRunId) errors.push("graphRunId_required");
  if (typeof candidate.originatingNode !== "string" || !candidate.originatingNode) errors.push("originatingNode_required");
  if (typeof candidate.sourceResultIdentity !== "string" || !candidate.sourceResultIdentity) errors.push("sourceResultIdentity_required");
  if (!Array.isArray(candidate.evidenceReferences) || candidate.evidenceReferences.length === 0) errors.push("evidenceReferences_required");
  if (!candidate.proposedIdentity || typeof candidate.proposedIdentity !== "object") errors.push("proposedIdentity_required");
  if (!candidate.proposedScope || typeof candidate.proposedScope !== "object") errors.push("proposedScope_required");
  // recompute the deterministic id — any drift fails closed
  if (candidate.candidateId !== candidateIdFor({
    graphRunId: candidate.graphRunId,
    originatingNode: candidate.originatingNode,
    sourceResultIdentity: candidate.sourceResultIdentity,
    proposedRecordType: candidate.proposedRecordType,
    proposedIdentity: candidate.proposedIdentity,
    lifecycleIntent: candidate.lifecycleIntent,
  })) errors.push("candidateId_identity_mismatch");
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] };
}
