// src/memory/contract.mjs
//
// CBM-2 — Memory Contract v1: fixed enums, schemas and envelope field
// definitions. Frozen constants only — the memory system never invents
// free-text record types, trust levels or validity statuses.

export const MEMORY_RECORD_SCHEMA = "autoloop.memory-record/v1";
export const MEMORY_JOURNAL_EVENT_SCHEMA = "autoloop.memory-journal-event/v1";
export const MEMORY_SCHEMA_VERSION = 1;

export const RECORD_TYPES = Object.freeze(["CODE", "EXECUTION", "DECISION"]);

export const TRUST_STATES = Object.freeze(["RAW", "UNVERIFIED", "VERIFIED", "REVIEWED", "CONFIRMED"]);
export const TRUST_RANK = Object.freeze({
  RAW: 0,
  UNVERIFIED: 1,
  VERIFIED: 2,
  REVIEWED: 3,
  CONFIRMED: 4,
});

export const VALIDITY_STATUSES = Object.freeze([
  "CURRENT",
  "STALE",
  "INVALIDATED",
  "TOMBSTONED",
  "CONFLICTED",
]);

export const LIFECYCLE_EVENT_TYPES = Object.freeze([
  "CREATED",
  "VALIDATED",
  "PROMOTED",
  "DOWNGRADED",
  "MARKED_STALE",
  "INVALIDATED",
  "TOMBSTONED",
  "SUPERSEDED",
  "RESTORED",
  "MIGRATED",
]);

export const SCOPES = Object.freeze([
  "repository",
  "worktree",
  "commit",
  "tree",
  "path",
  "symbol",
  "content",
  "graphRun",
  "task",
  "global",
]);

export const SOURCES = Object.freeze([
  "REPOSITORY",
  "EXECUTION",
  "VERIFIER",
  "INDEPENDENT_REVIEW",
  "CONTROLLER",
  "IMPORT",
  "DERIVED",
]);

export const RELATIONSHIP_TYPES = Object.freeze([
  "DERIVED_FROM",
  "VERIFIES",
  "REVIEWS",
  "SUPERSEDES",
  "INVALIDATES",
  "CONFLICTS_WITH",
  "APPLIES_TO",
  "PRODUCED_BY",
]);

export const KNOWLEDGE_KINDS = Object.freeze([
  "FILE",
  "SYMBOL",
  "API",
  "INVARIANT",
  "TEST",
  "CONFIGURATION",
  "DEPENDENCY",
  "ARCHITECTURE",
]);

export const RESULT_KINDS = Object.freeze([
  "TASK_RESULT",
  "TEST_RESULT",
  "VERIFIER_RESULT",
  "REVIEW_RESULT",
  "REPAIR_RESULT",
  "CHECKPOINT_RESULT",
]);

export const DECISION_TYPES = Object.freeze([
  "ARCHITECTURE",
  "SELECTION",
  "STANDARD",
  "LIMITATION",
  "ROLLBACK_CONDITION",
]);

export const DECISION_STATUSES = Object.freeze([
  "proposed",
  "accepted",
  "rejected",
  "superseded",
  "revoked",
]);

export const AUTHORITIES = Object.freeze([
  "SYSTEM_DERIVED",
  "VERIFIER",
  "INDEPENDENT_REVIEWER",
  "CONTROLLER",
]);

export const CONTENT_KINDS = Object.freeze(["TEXT", "STRUCTURED"]);

/** The literal marker used for fields that are legitimately not applicable. */
export const NOT_APPLICABLE = "NOT_APPLICABLE";

/**
 * Fields where the literal `NOT_APPLICABLE` string is legal, per record type.
 * Anything else containing `NOT_APPLICABLE` is a schema violation.
 * `evidence.manifestDigest` is legal for every type（the "no manifest" marker
 * for RAW records; the trust-gated evidence checks still enforce it for
 * non-RAW records）.
 */
export const NOT_APPLICABLE_LEGAL = Object.freeze({
  CODE: Object.freeze(["identity.worktreeIdentity", "identity.symbol", "subject.language", "evidence.manifestDigest", "validity.validityTree"]),
  EXECUTION: Object.freeze([
    "identity.nodeId",
    "identity.phaseExecutionId",
    "identity.agentExecutionId",
    "identity.attempt",
    "subject.completedAt",
    "evidence.manifestDigest",
    "validity.validityTree",
  ]),
  DECISION: Object.freeze(["subject.supersedes", "evidence.manifestDigest", "validity.validityTree"]),
});

/** Envelope top-level fields（fixed; extra fields are rejected）. */
export const ENVELOPE_FIELDS = Object.freeze([
  "schema",
  "recordId",
  "recordType",
  "identity",
  "subject",
  "content",
  "source",
  "scope",
  "trust",
  "validity",
  "lifecycle",
  "timestamps",
  "evidence",
  "security",
  "metadata",
]);

/** Record types that may carry an optional `research` marker block. */
export const RESEARCH_MARKERS = Object.freeze([
  "SOURCE",
  "DERIVED",
  "INFERENCE",
  "RECOMMENDATION",
  "IMPLEMENTED_CONTRACT",
  "TEST_VERIFIED",
]);
