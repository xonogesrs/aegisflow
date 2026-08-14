// src/memory/schema.mjs
//
// CBM-2 — Memory Contract v1: per-record-type field requirements.
//
// The MemoryRecordV1 envelope（top-level fields, fixed order-free）:
//   schema, recordId, recordType, identity, subject, content, source, scope,
//   trust, validity, lifecycle, timestamps, evidence, security, metadata
//
// recordId derivation input（identity.mjs）:
//   sha256(recursiveCanonical({ schema, recordType, identity, subject, scope,
//   sourceIdentity }))  — metadata / lifecycle / evidence / timestamps /
//   security changes never affect the identity.

export const CODE_FIELDS = Object.freeze({
  identity: {
    required: ["repositoryIdentity", "commitSha", "treeSha", "path", "knowledgeKind"],
    optional: ["worktreeIdentity", "symbol"],
    description: "CODE identity anchors: repo + commit/tree + path (+ worktree/symbol when applicable). path is a key component — a rename is a NEW identity（old record tombstoned, optional alias relationship）. Same content at a different path shares contentHash but NOT identity（content dedup never bypasses scope isolation）.",
  },
  subject: {
    required: ["statement", "contentHash", "language"],
    optional: [],
    description: "subject.statement = the knowledge statement; subject.contentHash = sha256('content:'+canonical(content)); subject.language = source language (NOT_APPLICABLE when none).",
  },
  content: { required: ["kind"], optional: ["text", "data"], description: "kind ∈ TEXT | STRUCTURED; TEXT → content.text（bounded）; STRUCTURED → content.data（bounded object）." },
});

export const EXECUTION_FIELDS = Object.freeze({
  identity: {
    required: ["graphRunId", "taskIdentity", "executorKind"],
    optional: ["nodeId", "phaseExecutionId", "agentExecutionId", "attempt"],
    description: "EXECUTION identity anchors: graphRunId（execution memory is ALWAYS graphRun-bound — never reused across runs without review）; taskIdentity; node/phase/agent/attempt when applicable（NOT_APPLICABLE legal）.",
  },
  subject: {
    required: ["resultKind", "status", "startedAt", "completedAt", "evidenceManifestDigest"],
    optional: ["summary"],
    description: "subject.resultKind ∈ RESULT_KINDS; subject.status = PASS/REPAIR/HOLD-style outcome; timestamps RFC3339 UTC; evidenceManifestDigest binds the result to its evidence manifest.",
  },
  content: { required: ["kind"], optional: ["text", "data"], description: "structured result payload（bounded）. stdout is NEVER automatically treated as trusted fact — only schema-bound structured fields promote." },
});

export const DECISION_FIELDS = Object.freeze({
  identity: {
    required: ["decisionId", "decisionType"],
    optional: [],
    description: "decisionId（Controller/governance-issued）; decisionType ∈ DECISION_TYPES.",
  },
  subject: {
    required: ["statement", "rationale", "alternatives", "status", "authority", "effectiveScope"],
    optional: ["supersedes"],
    description: "subject.status ∈ proposed|accepted|rejected|superseded|revoked; subject.authority ∈ AUTHORITIES; subject.supersedes = list of decisionIds（NOT_APPLICABLE legal when none）; superseded decisions are NEVER deleted.",
  },
  content: { required: ["kind"], optional: ["text", "data"], description: "decision payload." },
});

/** Per-type required/optional envelope + sub-field rules（single authority）. */
export const RECORD_TYPE_SCHEMAS = Object.freeze({
  CODE: CODE_FIELDS,
  EXECUTION: EXECUTION_FIELDS,
  DECISION: DECISION_FIELDS,
});

/** Validate the recordId derivation against the spec（identity.mjs）. */
export function specFieldsFor(recordType) {
  return RECORD_TYPE_SCHEMAS[recordType] ?? null;
}
