// src/memory/contract.mjs
//
// CBM-2 — Memory Contract v1: fixed enums, schemas and envelope field
// definitions. Frozen constants only — the memory system never invents
// free-text record types, trust levels or validity statuses.

export const MEMORY_RECORD_SCHEMA = "autoloop.memory-record/v1";
export const MEMORY_JOURNAL_EVENT_SCHEMA = "autoloop.memory-journal-event/v1";
export const MEMORY_SCHEMA_VERSION = 1;

export const RECORD_TYPES = Object.freeze(["CODE", "EXECUTION", "DECISION", "PATTERN"]);

// R2 PATTERN record type (Stage-F R2 chain; [CT §1 R2] schema-extension).
// PATTERN-specific frozen enums — applicability boundary vocabulary and
// mechanism-sig requirement. Additive only; existing enums untouched.
export const PATTERN_APPLICABILITY_DECISIONS = Object.freeze([
  "APPLIES",
  "DOES_NOT_APPLY",
  "REQUIRES_QUALIFICATION",
]);

// The machine-testable applicability boundary operator enum (O6: a boundary
// is present + machine-testable — these are the only legal operators).
export const PATTERN_BOUNDARY_OPERATORS = Object.freeze([
  "PATH_PREFIX",
  "SYMBOL_EQUALS",
  "TREE_MATCHES",
  "TOOL_EQUALS",
  "ERROR_CLASS_IN",
  "LANGUAGE_EQUALS",
]);

// Mechanism signature element keys (structured; never free text).
export const PATTERN_MECHANISM_SIGNATURE_FIELDS = Object.freeze([
  "errorClass",
  "tool",
  "language",
  "invariant",
]);

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
  // PATTERN (R2): boundary/counterexample/qualification fields are legal to
  // mark NOT_APPLICABLE when structurally absent for this pattern; the
  // required mechanism/applicability digests are NOT exempt (fence 5 rejects
  // a PATTERN record missing them — boundary_vacuous / missing_required).
  PATTERN: Object.freeze([
    "identity.worktreeIdentity",
    "identity.symbol",
    "subject.language",
    "subject.completedAt",
    "content.data.counterexamples",
    "evidence.manifestDigest",
    "validity.validityTree",
  ]),
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

// ===========================================================================
// STAGE-F LIFECYCLE — RUNG-6 Step 1 (ADDITIVE CONSTANTS ONLY)
//
// Authority: AUTOLOOP-V1-STAGE-F-LIFECYCLE-IMPLEMENTATION-ADMISSION-1-20260909T155807Z
//   (MUTATION-SURFACE-FREEZE §1 E2 row; FINE-CODE-CLASS-FREEZE A5;
//    SUCCESSOR-DERIVATION P-4; SPEC-1 O1-O7-IMPLEMENTATION-MAP §Mapping
//    completeness + FAILURE-TAXONOMY constant-authority ledger).
// Scope: the closed 5-kind lifecycle event-kind set (PROMOTE / DEMOTE /
//   ARCHIVE / REMOVE + OP_CANCEL operation boundary — journaled as
//   LIFECYCLE_EVENT operations per JOURNAL_OPERATIONS) + the two
//   admission-authorized fine-code constants + the frozen HOLD-class label.
// FORBIDDEN (frozen): touching RECORD_TYPES / TRUST_STATES / TRUST_RANK /
//   VALIDITY_STATUSES / LIFECYCLE_EVENT_TYPES or any other existing export ·
//   an 8th lifecycle state name (the 7-state enum is declared ONCE in
//   src/learning/lifecycle/state-machine.mjs — never here) · any fine code
//   beyond this admission-authorized set · any logic or I/O (this module
//   stays declarative).
// ===========================================================================

/** Closed lifecycle event-kind set (5 kinds; COUNTS-FREEZE §1). A kind
 * outside this set is UNREGISTERED ⇒ REJECT, never defaulted. */
export const LIFECYCLE_EVENT_KINDS = Object.freeze([
  "PROMOTE",    // T1/T2/T3 (R14/R15/R16) — upward edges
  "DEMOTE",     // T4/T5/T6 (R18) — evidence-required demotion
  "ARCHIVE",    // T7–T11 (R19) — retirement
  "REMOVE",     // T12 (R20) — human-authority removal
  "OP_CANCEL",  // cancellation operation-boundary (NOT a record state; Layer-2)
]);

/** Admission-authorized fine-code constant (exact frozen value). */
export const LIFECYCLE_TRANSITION_ILLEGAL = "LIFECYCLE_TRANSITION_ILLEGAL";

/** Admission-authorized fine-code constant (exact frozen value). */
export const LIFECYCLE_TERMINAL_IMMUTABLE = "LIFECYCLE_TERMINAL_IMMUTABLE";

/** Frozen HOLD-class label (FINE-CODE-CLASS-FREEZE A4.4 — zero live hits;
 * meaning NOT reinterpreted: attempt to change protected lifecycle semantics
 * ⇒ HOLD / SPEC_AMENDMENT_REQUIRED, never a gate. NO production consumption
 * path is authorized by this declaration). */
export const SPEC_AMENDMENT_REQUIRED = "SPEC_AMENDMENT_REQUIRED";
