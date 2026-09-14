// src/learning/transfer-metrics/schema.mjs
//
// Transfer-event schema owner. V1 (autoloop.transfer-event/v1) is the legacy
// 14-type measurement allowlist (LEGACY_READ_ONLY authority semantics); V2
// (autoloop.transfer-event/v2) adds exactly one authority event type
// (LEARNING_AUTHORITY_STATE_CHANGED). Not PASS / Spec / runtime / pattern /
// retrieval / outcome authority.

import { recursiveCanonicalJson, canonicalSha256, compareCodePoints } from "../../memory/canonical.mjs";
import { sha256Text } from "../../evidence/run-evidence-store.mjs";
import { timingSafeEqual } from "node:crypto";

export const SCHEMA_VERSION = "autoloop.transfer-event/v1";
export const SCHEMA_VERSION_NUMBER = 1;
export const LOG_SCHEMA = "autoloop.transfer-event-log/v1";
export const FORMULA_VERSION = "transfer-metrics-formulas/v1";
export const GENESIS_PREIMAGE = "autoloop.transfer-event/genesis/v1";
export const GENESIS_DIGEST = sha256Text(GENESIS_PREIMAGE);
export const SCHEMA_VERSION_V2 = "autoloop.transfer-event/v2";
export const SCHEMA_VERSION_NUMBER_V2 = 2;
export const LOG_SCHEMA_V2 = "autoloop.transfer-event-log/v2";
export const AUTHORITY_DOMAIN = "learning-authority/v1";
export const AUTHORITY_EVENT_TYPE = "LEARNING_AUTHORITY_STATE_CHANGED";

export const MAX_STRING_BYTES_PER_FIELD = 65536;
export const MAX_EVENT_BYTES = 262144;
export const MAX_EVIDENCE_REFS = 32;
export const MAX_LOG_ACTIVE_BYTES = 8388608;
export const MAX_DERIVED_BYTES = 1048576;
export const MAX_REDUCER_EVENTS = 65536;
export const CLOCK_SKEW_SECONDS = 300;

export const ALLOWED_ROOT_PREFIX = "/Volumes/NVM2T/Development/";

export const EVENT_TYPES = Object.freeze([
  "INCIDENT_OBSERVED",
  "PATTERN_CANDIDATE_CREATED",
  "PATTERN_QUALIFIED",
  "PATTERN_RETRIEVED",
  "PATTERN_REJECTED",
  "PATTERN_USED_IN_PLANNING",
  "PATTERN_USED_IN_VERIFICATION",
  "OUTCOME_OBSERVED",
  "TRANSFER_ADJUDICATED",
  "PATTERN_DEMOTED",
  "PATTERN_ARCHIVED",
  "PATTERN_REMOVED",
  "STALE_PATTERN_REJECTED",
  "ROLLBACK_OBSERVED",
]);
export const SOURCE_IDENTITY_DOMAIN = "autoloop.incident-source-identity/v1";

// V2 allowlist: the 14 measurement types + exactly one authority event type.
// The V1 allowlist above stays closed at 14 and can never contain an authority
// event. A 16th type requires a new spec amendment.
export const EVENT_TYPES_V2 = Object.freeze([...EVENT_TYPES, AUTHORITY_EVENT_TYPE]);

export const AUTHORITY_SUBJECT_KINDS = Object.freeze(["WRITER_PRINCIPAL", "CITED_TRUTH"]);
export const AUTHORITY_OPERATIONS = Object.freeze(["REVOKE", "SET_GENERATION"]);
export const AUTHORITY_STATES = Object.freeze(["CURRENT", "REVOKED"]);
export const AUTHORITY_REASONS = Object.freeze([
  "OPERATOR_REQUEST",
  "INDEPENDENT_REVIEW_FINDING",
  "ADMISSION_HOLD",
  "UNSPECIFIED",
]);

export const INCIDENT_OBS_SCHEMA = "autoloop.incident-observation/v1";
export const INCIDENT_ID_DOMAIN = "autoloop.incident-id/v1";
export const EVIDENCE_SET_DOMAIN = "autoloop.incident-evidence-set/v1";
// GATE-B-COMPLETION-1: candidate profile discriminator (conditional profile,
// same mechanism as INCIDENT_OBS_SCHEMA). Absent profile_version ⇒ legacy
// 4-key shape; present ⇒ extended candidate profile. Domains per the frozen
// identity model: identity-key excludes content/digests; candidate_id binds
// identity key + incident + content + source/evidence digests.
export const CANDIDATE_OBS_SCHEMA = "autoloop.pattern-candidate/v1";
export const CANDIDATE_IDENTITY_KEY_DOMAIN = "autoloop.candidate-identity-key/v1";
export const CANDIDATE_ID_DOMAIN = "autoloop.candidate-id/v1";
export const CANDIDATE_SLOT_DOMAIN = "autoloop.candidate-slot/v1";
export const CANDIDATE_MAX_SLOTS = 8;

export const INCIDENT_SOURCE_CLASSES = Object.freeze([
  "LIFECYCLE_TERMINAL",
  "FORMAL_ORACLE_NOT_PASS",
  "VERIFIER_FAILURE",
  "INDEPENDENT_REVIEW_FINDING",
  "INVARIANT_VIOLATION",
  "REGRESSION_TEST_FAILURE",
  "HARNESS_OWNED_TEST_FAILURE",
  "CRASH_RESTART",
  "AUTHORITY_REVOCATION_REJECTION",
  "ENVIRONMENT_FAILURE",
  "ENVIRONMENT_ADJUDICATION",
  "REPAIRED_CREDIBLE_FINDING",
  "ADMISSION_HOLD",
  "RECONCILE_OR_ROLLOVER_FAILURE",
  "TIMEOUT_OR_BUDGET_EXHAUSTION",
  "EXECUTION_EXCEPTION",
]);

export const INCIDENT_OBSERVED_OUTCOME_CLASSES = Object.freeze([
  "HOLD",
  "NOT_PASS",
  "TEST_FAIL",
  "INVARIANT_HOLD",
  "EXCEPTION",
  "TIMEOUT",
  "REVOCATION_REJECT",
  "CRASH",
  "RESTART",
  "ADMISSION_HOLD",
  "RECONCILE_FAIL",
  "ENVIRONMENT_FAIL",
  "REPAIRED_FINDING",
  "REVIEW_FINDING",
]);

export const INCIDENT_COMPLETENESS_WRITE_CLASSES = Object.freeze(["COMPLETE", "INCOMPLETE"]);

export const INCIDENT_OBSERVED_REQUIRED_PAYLOAD_KEYS = Object.freeze([
  "profile_version",
  "source_class",
  "source_record_id",
  "source_authority_identity",
  "source_authority_generation",
  "failure_finding_discriminator",
  "source_record_digest",
  "evidence_set_digest",
  "evidence_completeness_class",
  "source_identity_key",
  "observed_outcome_class",
]);

export const INCIDENT_OBSERVED_OPTIONAL_PAYLOAD_KEYS = Object.freeze([
  "source_linkage",
  "excluded_from_product_defect",
  "repaired",
  "source_error_code",
  "source_invariant_id",
]);

export const INCIDENT_OBSERVED_FORBIDDEN_KEYS = Object.freeze([
  "root_cause",
  "root_cause_id",
  "mechanism",
  "mechanism_id",
  "mechanism_digest",
  "family",
  "incident_family_id",
  "pattern",
  "pattern_id",
  "applicability_group_id",
  "pass",
  "hold_mutation",
  "planning_instruction",
  "verification_instruction",
  "executable",
  "output_path",
  "note",
  "NON_AUTHORITATIVE_NOTE",
]);

const INCIDENT_FILLABLE_KEYS = Object.freeze(["source_identity_key", "evidence_set_digest"]);

export const SOURCE_LINKAGE_DIRECTIONS = Object.freeze(["PARENT", "CHILD"]);

export const PRINCIPAL_ROLES = Object.freeze([
  "executor",
  "system",
  "reviewer",
  "operator",
  "fixture",
]);

export const PRODUCER_KINDS = Object.freeze(["measurement-writer", "fixture"]);
export const APPLICABILITY = Object.freeze(["APPLICABLE", "NOT_APPLICABLE", "UNKNOWN"]);
export const ATTRIBUTION_GRADES = Object.freeze(["A", "B", "C", "D"]);
export const CITATION_KINDS = Object.freeze(["explicit_reference", "none"]);
export const TERMINAL_FINALS = Object.freeze(["PASS", "HOLD"]);
export const EVIDENCE_REF_KINDS = Object.freeze([
  "evidence_event",
  "evidence_manifest",
  "artifact",
  "retrieval_digest",
  "planning_artifact",
  "verification_artifact",
  "counterfactual_record",
]);

export const FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
  "prompt",
  "response",
  "stdout",
  "stderr",
  "body",
  "content",
  "secret",
  "password",
  "tokenValue",
  "env",
  "credentials",
]);

export const ENVELOPE_FIELDS = Object.freeze([
  "schema_version",
  "event_id",
  "event_type",
  "occurred_at",
  "recorded_at",
  "project_identity",
  "task_identity",
  "attempt_identity",
  "incident_identity",
  "pattern_identity",
  "retrieval_event_id",
  "evidence_refs",
  "evidence_complete",
  "missing_predecessor",
  "producer_kind",
  "writer",
  "authority",
  "revocation_generation",
  "applicability_decision",
  "subject_event_id",
  "outcome_ref",
  "redaction_status",
  "payload",
  "idempotency_key",
  "payload_digest",
  "journal_sequence",
  "previous_digest",
  "event_digest",
]);

export const WRITER_ASSIGNED_FIELDS = Object.freeze([
  "event_id",
  "recorded_at",
  "idempotency_key",
  "payload_digest",
  "journal_sequence",
  "previous_digest",
  "event_digest",
  "redaction_status",
]);

const PAYLOAD_ALLOWLIST = Object.freeze({
  INCIDENT_OBSERVED: [
    "profile_version",
    "source_class",
    "source_record_id",
    "source_authority_identity",
    "source_authority_generation",
    "failure_finding_discriminator",
    "source_record_digest",
    "evidence_set_digest",
    "evidence_completeness_class",
    "source_identity_key",
    "observed_outcome_class",
    "source_linkage",
    "excluded_from_product_defect",
    "repaired",
    "source_error_code",
    "source_invariant_id",
  ],
  PATTERN_CANDIDATE_CREATED: [
    "lifecycle_state",
    "mechanism_digest",
    "applicability_digest",
    "constituent_incident_set_digest",
    // GATE-B-COMPLETION-1 extended profile keys (candidate/v1 only — the
    // projection allowlist stays frozen at the legacy 4-key shape).
    "profile_version",
    "candidate_identity_key",
    "candidate_id",
    "candidate_slot",
    "candidate_profile_version",
    "phase_identity",
    "source_record_digest",
    "evidence_set_digest",
    "publication_artifact_digest",
    "publication_link_digest",
    "publication_generation",
    "current_verification_facts",
  ],
  PATTERN_QUALIFIED: [
    "lifecycle_state",
    "mechanism_digest",
    "applicability_digest",
    "lifecycle_event_digest",
  ],
  PATTERN_DEMOTED: [
    "lifecycle_state",
    "mechanism_digest",
    "applicability_digest",
    "lifecycle_event_digest",
  ],
  PATTERN_ARCHIVED: [
    "lifecycle_state",
    "mechanism_digest",
    "applicability_digest",
    "lifecycle_event_digest",
  ],
  PATTERN_REMOVED: [
    "lifecycle_state",
    "mechanism_digest",
    "applicability_digest",
    "lifecycle_event_digest",
  ],
  PATTERN_RETRIEVED: ["retrievalDigest", "storeSnapshotDigest", "rank", "truncated"],
  PATTERN_REJECTED: ["rejection_code", "retrievalDigest"],
  STALE_PATTERN_REJECTED: ["rejection_code", "retrievalDigest"],
  PATTERN_USED_IN_PLANNING: ["artifact_digest", "citation_kind"],
  PATTERN_USED_IN_VERIFICATION: ["artifact_digest", "citation_kind"],
  OUTCOME_OBSERVED: ["final", "hold_code", "repair_attempts", "evidence_manifest_digest"],
  TRANSFER_ADJUDICATED: [
    "attribution_grade",
    "benefit_claimed",
    "adjudicator_role",
    "counterfactual_digest",
    "detected_earlier",
    "unnecessary_gate",
    "overlay_applicability",
  ],
  ROLLBACK_OBSERVED: ["from_generation", "to_generation", "reason_code"],
});

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const TRANSFER_CODES = Object.freeze({
  EVENT_UNKNOWN_TYPE: "TRANSFER_EVENT_UNKNOWN_TYPE",
  EVENT_UNKNOWN_SCHEMA: "TRANSFER_EVENT_UNKNOWN_SCHEMA",
  PAYLOAD_MALFORMED: "TRANSFER_PAYLOAD_MALFORMED",
  PAYLOAD_UNSAFE: "TRANSFER_PAYLOAD_UNSAFE",
  SECRET_RISK: "TRANSFER_SECRET_RISK",
  AUTHORITY_FORGED: "TRANSFER_AUTHORITY_FORGED",
  AUTHORITY_INSUFFICIENT: "TRANSFER_AUTHORITY_INSUFFICIENT",
  TASK_UNBOUND: "TRANSFER_TASK_UNBOUND",
  ADMISSION_DRIFT: "TRANSFER_ADMISSION_DRIFT",
  ATTEMPT_UNBOUND: "TRANSFER_ATTEMPT_UNBOUND",
  PROJECT_UNBOUND: "TRANSFER_PROJECT_UNBOUND",
  EVIDENCE_MISSING: "TRANSFER_EVIDENCE_MISSING",
  EVIDENCE_INCOMPLETE: "TRANSFER_EVIDENCE_INCOMPLETE",
  STALE_GENERATION: "TRANSFER_STALE_GENERATION",
  WRONG_GENERATION: "WRONG_GENERATION",
  RETRIEVAL_UNBOUND: "TRANSFER_RETRIEVAL_UNBOUND",
  SUBJECT_UNBOUND: "TRANSFER_SUBJECT_UNBOUND",
  OUTCOME_MISMATCH: "TRANSFER_OUTCOME_MISMATCH",
  CLOCK_ANOMALY: "TRANSFER_CLOCK_ANOMALY",
  TIME_UNBOUND: "TRANSFER_TIME_UNBOUND",
  WRITER_REVOKED: "TRANSFER_WRITER_REVOKED",
  IDEMPOTENCY_CONFLICT: "EVENT_IDEMPOTENCY_CONFLICT",
  LOG_CHAIN_INVALID: "TRANSFER_LOG_CHAIN_INVALID",
  LOG_PARTIAL_TAIL: "TRANSFER_LOG_PARTIAL_TAIL",
  FORMULA_MIXED: "TRANSFER_FORMULA_MIXED",
  PATH_UNSAFE: "TRANSFER_PATH_UNSAFE",
  AUTHORITY_EVENT_SCHEMA_INVALID: "TRANSFER_AUTHORITY_EVENT_SCHEMA_INVALID",
  AUTHORITY_SUBJECT_INVALID: "TRANSFER_AUTHORITY_SUBJECT_INVALID",
  AUTHORITY_ISSUER_FORGED: "TRANSFER_AUTHORITY_ISSUER_FORGED",
  AUTHORITY_ISSUER_REVOKED: "TRANSFER_AUTHORITY_ISSUER_REVOKED",
  AUTHORITY_STALE_GENERATION: "TRANSFER_AUTHORITY_STALE_GENERATION",
  AUTHORITY_GENERATION_CONFLICT: "TRANSFER_AUTHORITY_GENERATION_CONFLICT",
  AUTHORITY_MUTATION_CONFLICT: "TRANSFER_AUTHORITY_MUTATION_CONFLICT",
  AUTHORITY_STATE_ROLLBACK: "TRANSFER_AUTHORITY_STATE_ROLLBACK",
  AUTHORITY_ALREADY_SATISFIED: "TRANSFER_AUTHORITY_ALREADY_SATISFIED",
  AUTHORITY_LOG_CHAIN_INVALID: "TRANSFER_AUTHORITY_LOG_CHAIN_INVALID",
  AUTHORITY_LOG_CORRUPT: "TRANSFER_AUTHORITY_LOG_CORRUPT",
  AUTHORITY_UNAVAILABLE: "TRANSFER_AUTHORITY_UNAVAILABLE",
  AUTHORITY_SUBJECT_NOT_FOUND: "TRANSFER_AUTHORITY_SUBJECT_NOT_FOUND",
  AUTHORITY_SECRET_REJECTED: "TRANSFER_AUTHORITY_SECRET_REJECTED",
  AUTHORITY_INTERNAL_CONTRACT_VIOLATION: "TRANSFER_AUTHORITY_INTERNAL_CONTRACT_VIOLATION",
  AUTHORITY_SUBJECT_TERMINAL: "TRANSFER_AUTHORITY_SUBJECT_TERMINAL",
  PATTERN_REMOVED: "TRANSFER_PATTERN_REMOVED",
  DISABLED: "DISABLED",
  INCIDENT_SOURCE_IDENTITY_MISMATCH: "TRANSFER_PAYLOAD_MALFORMED",
  INCIDENT_IDENTITY_MISMATCH: "TRANSFER_PAYLOAD_MALFORMED",
  INCIDENT_SOURCE_IDENTITY_CONFLICT: "EVENT_IDEMPOTENCY_CONFLICT",
  INCIDENT_PAYLOAD_CONFLICT: "EVENT_IDEMPOTENCY_CONFLICT",
});

export class TransferMetricsError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "TransferMetricsError";
    this.code = code;
    this.details = details;
  }
}

export function isHex64(value) {
  return typeof value === "string" && HEX64.test(value);
}

export function isIsoUtc(value) {
  return typeof value === "string" && ISO_UTC.test(value);
}

export function canonical(value) {
  return recursiveCanonicalJson(value);
}

export function digestOf(value) {
  return canonicalSha256(value);
}

export function digestText(text) {
  return sha256Text(text);
}

export function parseIsoMs(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new TransferMetricsError(TRANSFER_CODES.CLOCK_ANOMALY, `unparseable timestamp ${value}`);
  }
  return ms;
}

function fail(code, message, details) {
  throw new TransferMetricsError(code, message, details);
}

function rejectDangerousKey(key, label) {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} forbidden key ${key}`);
  }
}

export function isolateCallerEvent(value, label = "event", depth = 0) {
  if (depth > 32) fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} nesting exceeds 32`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} non-finite number`);
    return value;
  }
  if (typeof value !== "object") {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be a plain array`);
    }
    return value.map((item, i) => isolateCallerEvent(item, `${label}[${i}]`, depth + 1));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be a plain object`);
  }
  const out = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    rejectDangerousKey(key, label);
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || typeof desc.get === "function" || typeof desc.set === "function" || desc.enumerable !== true) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label}.${key} must be an enumerable data property`);
    }
    out[key] = isolateCallerEvent(desc.value, `${label}.${key}`, depth + 1);
  }
  return out;
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be a plain object`);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    rejectDangerousKey(key, label);
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc && (typeof desc.get === "function" || typeof desc.set === "function")) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label}.${key} getter/setter rejected`);
    }
  }
}

function assertKnownKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} unknown field: ${key}`);
    }
  }
}

function walkForbiddenKeys(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkForbiddenKeys(item, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `forbidden key ${key} at ${path}.${key}`);
      }
      walkForbiddenKeys(child, `${path}.${key}`);
    }
  }
}

function assertHex64(value, label) {
  if (!isHex64(value)) fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be 64-hex`);
}

function assertIso(value, label) {
  if (!isIsoUtc(value)) fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be ISO-8601 UTC`);
}

function assertInt(value, label, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be integer >= ${min}`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be a non-empty string`);
  }
}

export function timingSafeHexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function assertBoundedString(value, label) {
  assertString(value, label);
  if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES_PER_FIELD) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} exceeds ${MAX_STRING_BYTES_PER_FIELD} bytes`);
  }
  if (/[\u0000\r\n]/.test(value)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must not contain NUL/CR/LF`);
  }
}

function assertNotAbsolutePath(value, label) {
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must not be an absolute local path`);
  }
}

function sortEvidenceTuples(refs) {
  return refs
    .map((ref) => ({ kind: ref.kind, identity: ref.identity, digest: ref.digest }))
    .sort((a, b) => {
      const kindCmp = compareCodePoints(a.kind, b.kind);
      if (kindCmp !== 0) return kindCmp;
      const idCmp = compareCodePoints(a.identity, b.identity);
      if (idCmp !== 0) return idCmp;
      return compareCodePoints(a.digest, b.digest);
    });
}

export function normalizeIncidentEvidenceRefs(refs) {
  if (!Array.isArray(refs)) fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "evidence_refs must be an array");
  if (refs.length > MAX_EVIDENCE_REFS) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `evidence_refs exceeds ${MAX_EVIDENCE_REFS}`);
  }
  const seenExact = new Set();
  const byIdentity = new Map();
  for (const ref of refs) {
    const identityKey = `${ref.kind}\n${ref.identity}`;
    const exactKey = `${identityKey}\n${ref.digest}`;
    if (seenExact.has(exactKey)) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "duplicate exact evidence reference");
    }
    seenExact.add(exactKey);
    const prior = byIdentity.get(identityKey);
    if (prior && prior !== ref.digest) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "same evidence identity with different digest");
    }
    byIdentity.set(identityKey, ref.digest);
  }
  const sorted = sortEvidenceTuples(refs);
  return sorted;
}

export function deriveEvidenceSetDigest(refs) {
  const tuples = sortEvidenceTuples(refs ?? []);
  return digestOf({
    domain: EVIDENCE_SET_DOMAIN,
    schema_version: INCIDENT_OBS_SCHEMA,
    refs: tuples,
  });
}

export function deriveSourceIdentityKey(event) {
  const payload = event.payload ?? {};
  return digestOf({
    domain: SOURCE_IDENTITY_DOMAIN,
    schema_version: INCIDENT_OBS_SCHEMA,
    source_class: payload.source_class,
    source_authority_identity: payload.source_authority_identity,
    source_authority_generation: payload.source_authority_generation,
    project_identity: event.project_identity,
    task_identity: event.task_identity,
    attempt_identity: event.attempt_identity,
    source_record_id: payload.source_record_id,
    failure_finding_discriminator: payload.failure_finding_discriminator,
  });
}

export function deriveIncidentId(sourceIdentityKey, sourceRecordDigest, evidenceSetDigest) {
  return digestOf({
    domain: INCIDENT_ID_DOMAIN,
    schema_version: INCIDENT_OBS_SCHEMA,
    source_identity_key: sourceIdentityKey,
    source_record_digest: sourceRecordDigest,
    evidence_set_digest: evidenceSetDigest,
  });
}

function compareOrFillHex(supplied, derived, label, reason) {
  if (supplied == null) return derived;
  if (typeof supplied !== "string" || supplied.length === 0) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be a non-empty 64-hex string`, { reason });
  }
  assertHex64(supplied, label);
  if (!timingSafeHexEqual(supplied, derived)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} does not match derived value`, { reason });
  }
  return derived;
}

export function applyIncidentObservedProfile(event) {
  const payload = event.payload;
  event.evidence_refs = normalizeIncidentEvidenceRefs(event.evidence_refs);
  const completeness = payload.evidence_completeness_class;
  if (completeness === "COMPLETE") {
    if (event.evidence_complete !== true || event.evidence_refs.length < 1) {
      fail(TRANSFER_CODES.EVIDENCE_INCOMPLETE, "COMPLETE requires evidence_complete=true and >=1 evidence_refs");
    }
  } else if (completeness === "INCOMPLETE") {
    if (event.evidence_refs.length < 1 && event.evidence_complete !== false) {
      fail(TRANSFER_CODES.EVIDENCE_INCOMPLETE, "INCOMPLETE with empty evidence_refs requires evidence_complete=false");
    }
  }
  const evidenceSetDigest = deriveEvidenceSetDigest(event.evidence_refs);
  payload.evidence_set_digest = compareOrFillHex(
    payload.evidence_set_digest,
    evidenceSetDigest,
    "payload.evidence_set_digest",
    "INCIDENT_IDENTITY_MISMATCH",
  );
  const sourceKey = deriveSourceIdentityKey(event);
  payload.source_identity_key = compareOrFillHex(
    payload.source_identity_key,
    sourceKey,
    "payload.source_identity_key",
    "INCIDENT_SOURCE_IDENTITY_MISMATCH",
  );
  const incidentId = deriveIncidentId(sourceKey, payload.source_record_digest, evidenceSetDigest);
  if (event.incident_identity == null) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "incident_identity required");
  }
  if (event.incident_identity.incident_id == null) {
    event.incident_identity.incident_id = incidentId;
  } else {
    event.incident_identity.incident_id = compareOrFillHex(
      event.incident_identity.incident_id,
      incidentId,
      "incident_identity.incident_id",
      "INCIDENT_IDENTITY_MISMATCH",
    );
  }
  return event;
}

export function assertIncidentDerivedIdentities(event) {
  const sourceKey = deriveSourceIdentityKey(event);
  const evidenceSetDigest = deriveEvidenceSetDigest(event.evidence_refs);
  const incidentId = deriveIncidentId(sourceKey, event.payload.source_record_digest, evidenceSetDigest);
  if (!timingSafeHexEqual(event.payload.source_identity_key, sourceKey)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.source_identity_key does not match derived value", {
      reason: "INCIDENT_SOURCE_IDENTITY_MISMATCH",
    });
  }
  if (!timingSafeHexEqual(event.payload.evidence_set_digest, evidenceSetDigest)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.evidence_set_digest does not match derived value", {
      reason: "INCIDENT_IDENTITY_MISMATCH",
    });
  }
  if (!timingSafeHexEqual(event.incident_identity?.incident_id, incidentId)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "incident_identity.incident_id does not match derived value", {
      reason: "INCIDENT_IDENTITY_MISMATCH",
    });
  }
}


export function computeLogicalDedupeKey(event) {
  const type = event.event_type;
  const payload = event.payload ?? {};
  const pattern = event.pattern_identity;
  switch (type) {
    case "INCIDENT_OBSERVED":
      return deriveSourceIdentityKey(event);
    case "PATTERN_CANDIDATE_CREATED":
      return {
        pattern_id: pattern?.pattern_id ?? null,
        constituent_incident_set_digest: payload.constituent_incident_set_digest ?? null,
      };
    case "PATTERN_QUALIFIED":
      return {
        pattern_id: pattern?.pattern_id ?? null,
        generation: pattern?.generation ?? null,
        reviewer_identity: event.authority?.identity ?? null,
      };
    case "PATTERN_RETRIEVED":
      return {
        retrievalDigest: payload.retrievalDigest ?? null,
        pattern_id: pattern?.pattern_id ?? null,
      };
    case "PATTERN_REJECTED":
      return {
        retrievalDigest: payload.retrievalDigest ?? null,
        pattern_id: pattern?.pattern_id ?? null,
        rejection_code: payload.rejection_code ?? null,
      };
    case "PATTERN_USED_IN_PLANNING":
      return {
        retrieval_event_id: event.retrieval_event_id ?? null,
        planning_artifact_digest: payload.artifact_digest ?? null,
      };
    case "PATTERN_USED_IN_VERIFICATION":
      return {
        retrieval_event_id: event.retrieval_event_id ?? null,
        verification_artifact_digest: payload.artifact_digest ?? null,
      };
    case "OUTCOME_OBSERVED":
      return event.attempt_identity?.execution_id ?? null;
    case "TRANSFER_ADJUDICATED":
      return {
        subject_event_id: event.subject_event_id ?? null,
        adjudicator_identity: event.authority?.identity ?? null,
        attribution_grade: payload.attribution_grade ?? null,
      };
    case "PATTERN_DEMOTED":
    case "PATTERN_ARCHIVED":
    case "PATTERN_REMOVED":
      return {
        pattern_id: pattern?.pattern_id ?? null,
        generation: pattern?.generation ?? null,
        lifecycle_event_digest: payload.lifecycle_event_digest ?? null,
      };
    case "STALE_PATTERN_REJECTED":
      return {
        pattern_id: pattern?.pattern_id ?? null,
        generation: pattern?.generation ?? null,
        retrievalDigest: payload.retrievalDigest ?? null,
      };
    case "ROLLBACK_OBSERVED":
      return {
        pattern_id: pattern?.pattern_id ?? null,
        from_generation: payload.from_generation ?? null,
        to_generation: payload.to_generation ?? null,
      };
    default:
      fail(TRANSFER_CODES.EVENT_UNKNOWN_TYPE, `unknown event_type ${String(type)}`);
  }
}

export function computeIdempotencyKey(event) {
  if (event.event_type === "INCIDENT_OBSERVED") {
    return digestOf({
      schema_version: event.schema_version,
      event_type: event.event_type,
      project_identity: event.project_identity,
      task_identity: event.task_identity,
      attempt_identity: event.attempt_identity,
      incident_identity: null,
      pattern_identity: null,
      retrieval_event_id: null,
      producer_kind: event.producer_kind,
      logical_dedupe_key: computeLogicalDedupeKey(event),
    });
  }
  return digestOf({
    schema_version: event.schema_version,
    event_type: event.event_type,
    project_identity: event.project_identity,
    task_identity: event.task_identity,
    attempt_identity: event.attempt_identity,
    incident_identity: event.incident_identity ?? null,
    pattern_identity: event.pattern_identity ?? null,
    retrieval_event_id: event.retrieval_event_id ?? null,
    producer_kind: event.producer_kind,
    logical_dedupe_key: computeLogicalDedupeKey(event),
  });
}
export function computeEventId(idempotencyKey) {
  return digestOf(idempotencyKey);
}

export function computePayloadDigest(payload) {
  return digestOf(payload ?? {});
}

export function computeEventDigest({ journal_sequence, event_id, event_type, payload_digest, previous_digest }) {
  return digestOf({
    journal_sequence,
    event_id,
    event_type,
    payload_digest,
    previous_digest,
  });
}

function validateProjectIdentity(value) {
  assertPlainObject(value, "project_identity");
  assertKnownKeys(value, ["repository_root_identity", "git_common_dir_identity"], "project_identity");
  assertString(value.repository_root_identity, "project_identity.repository_root_identity");
  assertString(value.git_common_dir_identity, "project_identity.git_common_dir_identity");
}

export function validateTaskIdentity(value) {
  assertPlainObject(value, "task_identity");
  assertKnownKeys(value, ["task_id", "admission_id"], "task_identity");
  assertString(value.task_id, "task_identity.task_id");
  assertHex64(value.admission_id, "task_identity.admission_id");
}

export function validateAttemptIdentity(value) {
  assertPlainObject(value, "attempt_identity");
  assertKnownKeys(value, ["execution_id", "attempt"], "attempt_identity");
  assertString(value.execution_id, "attempt_identity.execution_id");
  assertInt(value.attempt, "attempt_identity.attempt", { min: 0 });
}

function validateIncidentIdentity(value, required, { allowMissingId = false } = {}) {
  if (value == null) {
    if (required) fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "incident_identity required");
    return;
  }
  assertPlainObject(value, "incident_identity");
  assertKnownKeys(value, ["incident_id", "incident_id_kind"], "incident_identity");
  if (value.incident_id == null) {
    if (!allowMissingId) fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "incident_identity.incident_id required");
  } else {
    assertString(value.incident_id, "incident_identity.incident_id");
  }
  if (value.incident_id_kind != null) {
    if (!["record", "evidence_bound", "fixture"].includes(value.incident_id_kind)) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "incident_id_kind invalid");
    }
  }
}

function validatePatternIdentity(value, required) {
  if (value == null) {
    if (required) fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "pattern_identity required");
    return;
  }
  assertPlainObject(value, "pattern_identity");
  assertKnownKeys(value, ["pattern_id", "generation"], "pattern_identity");
  assertString(value.pattern_id, "pattern_identity.pattern_id");
  assertInt(value.generation, "pattern_identity.generation", { min: 0 });
}

function validateEvidenceRefs(refs, evidenceComplete) {
  if (!Array.isArray(refs)) fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "evidence_refs must be an array");
  if (refs.length > MAX_EVIDENCE_REFS) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `evidence_refs exceeds ${MAX_EVIDENCE_REFS}`);
  }
  for (const ref of refs) {
    assertPlainObject(ref, "evidence_refs[]");
    assertKnownKeys(ref, ["kind", "identity", "digest"], "evidence_refs[]");
    if (!EVIDENCE_REF_KINDS.includes(ref.kind)) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `unknown evidence_refs.kind ${ref.kind}`);
    }
    assertString(ref.identity, "evidence_refs[].identity");
    assertHex64(ref.digest, "evidence_refs[].digest");
  }
  if (evidenceComplete === true) {
    if (refs.length < 1 || refs.some((r) => !isHex64(r.digest))) {
      fail(TRANSFER_CODES.EVIDENCE_INCOMPLETE, "evidence_complete=true requires >=1 64-hex evidence_refs");
    }
  }
}

function validateWriter(value) {
  assertPlainObject(value, "writer");
  assertKnownKeys(value, ["writer_id", "writer_generation"], "writer");
  assertString(value.writer_id, "writer.writer_id");
  assertInt(value.writer_generation, "writer.writer_generation", { min: 0 });
}

function validateAuthority(value) {
  assertPlainObject(value, "authority");
  assertKnownKeys(value, ["identity", "role"], "authority");
  assertString(value.identity, "authority.identity");
  if (!PRINCIPAL_ROLES.includes(value.role)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `unknown authority.role ${value.role}`);
  }
}

function validateOutcomeRef(value, required) {
  if (value == null) {
    if (required) fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "outcome_ref required");
    return;
  }
  assertPlainObject(value, "outcome_ref");
  assertKnownKeys(value, ["execution_id", "final", "attempt"], "outcome_ref");
  assertString(value.execution_id, "outcome_ref.execution_id");
  if (!TERMINAL_FINALS.includes(value.final)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "outcome_ref.final must be PASS or HOLD");
  }
  assertInt(value.attempt, "outcome_ref.attempt", { min: 0 });
}

function validatePayload(type, payload) {
  assertPlainObject(payload, "payload");
  walkForbiddenKeys(payload, "payload");
  if (type === "INCIDENT_OBSERVED") {
    for (const key of Object.keys(payload)) {
      if (INCIDENT_OBSERVED_FORBIDDEN_KEYS.includes(key)) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `forbidden key ${key} at payload.${key}`);
      }
    }
  }
  const allowed = PAYLOAD_ALLOWLIST[type];
  assertKnownKeys(payload, allowed, "payload");
  switch (type) {
    case "INCIDENT_OBSERVED": {
      for (const key of Object.keys(payload)) {
        if (INCIDENT_OBSERVED_FORBIDDEN_KEYS.includes(key)) {
          fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `forbidden key ${key} at payload.${key}`);
        }
      }
      for (const key of INCIDENT_OBSERVED_REQUIRED_PAYLOAD_KEYS) {
        if (INCIDENT_FILLABLE_KEYS.includes(key) && payload[key] == null) continue;
        if (payload[key] == null) {
          fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `payload.${key} required`);
        }
      }
      if (payload.profile_version !== INCIDENT_OBS_SCHEMA) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.profile_version must be autoloop.incident-observation/v1");
      }
      if (!INCIDENT_SOURCE_CLASSES.includes(payload.source_class)) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `unknown payload.source_class ${payload.source_class}`);
      }
      assertBoundedString(payload.source_record_id, "payload.source_record_id");
      assertNotAbsolutePath(payload.source_record_id, "payload.source_record_id");
      assertBoundedString(payload.source_authority_identity, "payload.source_authority_identity");
      if (PRINCIPAL_ROLES.includes(payload.source_authority_identity)) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.source_authority_identity must not be a role name");
      }
      assertInt(payload.source_authority_generation, "payload.source_authority_generation", { min: 0 });
      assertBoundedString(payload.failure_finding_discriminator, "payload.failure_finding_discriminator");
      assertHex64(payload.source_record_digest, "payload.source_record_digest");
      if (payload.evidence_set_digest != null) assertHex64(payload.evidence_set_digest, "payload.evidence_set_digest");
      if (payload.source_identity_key != null) assertHex64(payload.source_identity_key, "payload.source_identity_key");
      if (!INCIDENT_COMPLETENESS_WRITE_CLASSES.includes(payload.evidence_completeness_class)) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.evidence_completeness_class must be COMPLETE or INCOMPLETE");
      }
      if (!INCIDENT_OBSERVED_OUTCOME_CLASSES.includes(payload.observed_outcome_class)) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.observed_outcome_class invalid");
      }
      if (payload.source_linkage != null) {
        assertPlainObject(payload.source_linkage, "payload.source_linkage");
        assertKnownKeys(payload.source_linkage, ["parent_source_record_id", "direction"], "payload.source_linkage");
        assertBoundedString(payload.source_linkage.parent_source_record_id, "payload.source_linkage.parent_source_record_id");
        if (!SOURCE_LINKAGE_DIRECTIONS.includes(payload.source_linkage.direction)) {
          fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.source_linkage.direction must be PARENT|CHILD");
        }
      }
      if (payload.excluded_from_product_defect != null && typeof payload.excluded_from_product_defect !== "boolean") {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.excluded_from_product_defect boolean");
      }
      if (payload.repaired != null && typeof payload.repaired !== "boolean") {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.repaired boolean");
      }
      if (payload.source_error_code != null) assertBoundedString(payload.source_error_code, "payload.source_error_code");
      if (payload.source_invariant_id != null) assertBoundedString(payload.source_invariant_id, "payload.source_invariant_id");
      break;
    }
    case "PATTERN_CANDIDATE_CREATED":
      if (payload.lifecycle_state != null) assertString(payload.lifecycle_state, "payload.lifecycle_state");
      assertHex64(payload.mechanism_digest, "payload.mechanism_digest");
      assertHex64(payload.applicability_digest, "payload.applicability_digest");
      assertHex64(payload.constituent_incident_set_digest, "payload.constituent_incident_set_digest");
      // GATE-B-COMPLETION-1: conditional extended profile. Exactly like the
      // INCIDENT_OBSERVED profile_version gate: absent ⇒ legacy 4-key shape
      // (validated above, unchanged); present ⇒ candidate/v1 shape.
      if (payload.profile_version != null) {
        if (payload.profile_version !== CANDIDATE_OBS_SCHEMA) {
          fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `payload.profile_version must be ${CANDIDATE_OBS_SCHEMA}`);
        }
        for (const key of ["candidate_identity_key", "candidate_id", "source_record_digest", "evidence_set_digest", "publication_artifact_digest", "publication_link_digest"]) {
          if (payload[key] != null) assertHex64(payload[key], `payload.${key}`);
        }
        if (payload.candidate_slot != null) {
          assertInt(payload.candidate_slot, "payload.candidate_slot", { min: 0 });
          if (payload.candidate_slot > CANDIDATE_MAX_SLOTS) {
            fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `payload.candidate_slot exceeds ${CANDIDATE_MAX_SLOTS}`);
          }
        }
        if (payload.candidate_profile_version != null) {
          assertString(payload.candidate_profile_version, "payload.candidate_profile_version");
        }
        if (payload.phase_identity != null) {
          assertPlainObject(payload.phase_identity, "payload.phase_identity");
          assertKnownKeys(payload.phase_identity, ["execution_id", "phase_id"], "payload.phase_identity");
          assertBoundedString(payload.phase_identity.execution_id, "payload.phase_identity.execution_id");
          assertNotAbsolutePath(payload.phase_identity.execution_id, "payload.phase_identity.execution_id");
          assertBoundedString(payload.phase_identity.phase_id, "payload.phase_identity.phase_id");
          assertNotAbsolutePath(payload.phase_identity.phase_id, "payload.phase_identity.phase_id");
        }
        if (payload.publication_generation != null) {
          assertInt(payload.publication_generation, "payload.publication_generation", { min: 1 });
        }
        if (payload.current_verification_facts != null) {
          // Sealed CV receipt facts (current-verification.mjs receipt.facts()):
          // a closed, digest/bounded-identity-only document — mirrors the
          // phase_identity gate: exact keys, hex64 digests, bounded identity
          // strings, no free text. Present only under the candidate/v1 profile.
          assertPlainObject(payload.current_verification_facts, "payload.current_verification_facts");
          assertKnownKeys(
            payload.current_verification_facts,
            [
              "projection_digest",
              "projection_item_id",
              "incident_id",
              "source_record_id",
              "source_record_digest",
              "execution_id",
              "phase_id",
              "verified_generation",
              "writer_state_digest",
              "cited_state_digest",
              "writer_generation",
              "cited_generation",
            ],
            "payload.current_verification_facts",
          );
          for (const key of ["projection_digest", "projection_item_id", "incident_id", "source_record_digest", "writer_state_digest", "cited_state_digest"]) {
            if (payload.current_verification_facts[key] != null) {
              assertHex64(payload.current_verification_facts[key], `payload.current_verification_facts.${key}`);
            }
          }
          for (const key of ["source_record_id", "execution_id", "phase_id"]) {
            if (payload.current_verification_facts[key] != null) {
              assertBoundedString(payload.current_verification_facts[key], `payload.current_verification_facts.${key}`);
              assertNotAbsolutePath(payload.current_verification_facts[key], `payload.current_verification_facts.${key}`);
            }
          }
          for (const key of ["verified_generation", "writer_generation", "cited_generation"]) {
            if (payload.current_verification_facts[key] != null) {
              assertInt(payload.current_verification_facts[key], `payload.current_verification_facts.${key}`, { min: 0 });
            }
          }
        }
      }
      break;
    case "PATTERN_QUALIFIED":
    case "PATTERN_DEMOTED":
    case "PATTERN_ARCHIVED":
    case "PATTERN_REMOVED":
      if (payload.lifecycle_state != null) assertString(payload.lifecycle_state, "payload.lifecycle_state");
      assertHex64(payload.mechanism_digest, "payload.mechanism_digest");
      assertHex64(payload.applicability_digest, "payload.applicability_digest");
      assertHex64(payload.lifecycle_event_digest, "payload.lifecycle_event_digest");
      break;
    case "PATTERN_RETRIEVED":
      assertHex64(payload.retrievalDigest, "payload.retrievalDigest");
      assertHex64(payload.storeSnapshotDigest, "payload.storeSnapshotDigest");
      assertInt(payload.rank, "payload.rank", { min: 0 });
      if (typeof payload.truncated !== "boolean") fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.truncated boolean");
      break;
    case "PATTERN_REJECTED":
    case "STALE_PATTERN_REJECTED":
      assertString(payload.rejection_code, "payload.rejection_code");
      assertHex64(payload.retrievalDigest, "payload.retrievalDigest");
      break;
    case "PATTERN_USED_IN_PLANNING":
    case "PATTERN_USED_IN_VERIFICATION":
      assertHex64(payload.artifact_digest, "payload.artifact_digest");
      if (!CITATION_KINDS.includes(payload.citation_kind)) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.citation_kind invalid");
      }
      break;
    case "OUTCOME_OBSERVED":
      if (!TERMINAL_FINALS.includes(payload.final)) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.final must be PASS or HOLD");
      }
      if (payload.hold_code != null) assertString(payload.hold_code, "payload.hold_code");
      assertInt(payload.repair_attempts, "payload.repair_attempts", { min: 0 });
      assertHex64(payload.evidence_manifest_digest, "payload.evidence_manifest_digest");
      break;
    case "TRANSFER_ADJUDICATED":
      if (!ATTRIBUTION_GRADES.includes(payload.attribution_grade)) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.attribution_grade invalid");
      }
      if (typeof payload.benefit_claimed !== "boolean") {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.benefit_claimed boolean");
      }
      if (!["reviewer", "operator"].includes(payload.adjudicator_role)) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.adjudicator_role must be reviewer|operator");
      }
      if (payload.counterfactual_digest != null) assertHex64(payload.counterfactual_digest, "payload.counterfactual_digest");
      if (payload.detected_earlier != null && typeof payload.detected_earlier !== "boolean") {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.detected_earlier boolean|null");
      }
      if (payload.unnecessary_gate != null && typeof payload.unnecessary_gate !== "boolean") {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.unnecessary_gate boolean|null");
      }
      if (payload.overlay_applicability != null && !["APPLICABLE", "NOT_APPLICABLE"].includes(payload.overlay_applicability)) {
        fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.overlay_applicability invalid");
      }
      if ((payload.attribution_grade === "C" || payload.attribution_grade === "D") && payload.attribution_grade === "C") {
        if (!isHex64(payload.counterfactual_digest)) {
          fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "grade C requires counterfactual_digest");
        }
      }
      break;
    case "ROLLBACK_OBSERVED":
      assertInt(payload.from_generation, "payload.from_generation", { min: 0 });
      assertInt(payload.to_generation, "payload.to_generation", { min: 0 });
      assertString(payload.reason_code, "payload.reason_code");
      break;
    default:
      fail(TRANSFER_CODES.EVENT_UNKNOWN_TYPE, `unknown event_type ${type}`);
  }
}

const PATTERN_TYPES = new Set([
  "PATTERN_CANDIDATE_CREATED",
  "PATTERN_QUALIFIED",
  "PATTERN_RETRIEVED",
  "PATTERN_REJECTED",
  "PATTERN_USED_IN_PLANNING",
  "PATTERN_USED_IN_VERIFICATION",
  "PATTERN_DEMOTED",
  "PATTERN_ARCHIVED",
  "PATTERN_REMOVED",
  "STALE_PATTERN_REJECTED",
  "ROLLBACK_OBSERVED",
]);

const USED_TYPES = new Set(["PATTERN_USED_IN_PLANNING", "PATTERN_USED_IN_VERIFICATION"]);

export function validateMeasurementEvent(event, schemaVersion = SCHEMA_VERSION) {
  event = isolateCallerEvent(event, "event");
  assertPlainObject(event, "event");
  assertKnownKeys(event, ENVELOPE_FIELDS, "event");
  if (event.schema_version !== schemaVersion) {
    fail(TRANSFER_CODES.EVENT_UNKNOWN_SCHEMA, `schema_version ${String(event.schema_version)}`);
  }
  // The V1 allowlist stays closed at 14; the authority event type is
  // validated only by validateAuthorityRecord (V2, sealed-issuer path).
  if (!EVENT_TYPES.includes(event.event_type)) {
    fail(TRANSFER_CODES.EVENT_UNKNOWN_TYPE, `event_type ${String(event.event_type)}`);
  }
  assertIso(event.occurred_at, "occurred_at");
  validateProjectIdentity(event.project_identity);
  validateTaskIdentity(event.task_identity);
  validateAttemptIdentity(event.attempt_identity);
  validateIncidentIdentity(event.incident_identity, event.event_type === "INCIDENT_OBSERVED", {
    allowMissingId: event.event_type === "INCIDENT_OBSERVED",
  });
  validatePatternIdentity(event.pattern_identity, PATTERN_TYPES.has(event.event_type));
  if (event.retrieval_event_id != null) assertHex64(event.retrieval_event_id, "retrieval_event_id");
  if (USED_TYPES.has(event.event_type) && !isHex64(event.retrieval_event_id)) {
    fail(TRANSFER_CODES.RETRIEVAL_UNBOUND, "USED_* requires retrieval_event_id");
  }
  if (typeof event.evidence_complete !== "boolean") {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "evidence_complete boolean");
  }
  if (typeof event.missing_predecessor !== "boolean") {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "missing_predecessor boolean");
  }
  if (event.missing_predecessor === true && event.evidence_complete !== false) {
    fail(TRANSFER_CODES.EVIDENCE_INCOMPLETE, "missing_predecessor=true forces evidence_complete=false");
  }
  validateEvidenceRefs(event.evidence_refs, event.evidence_complete);
  if (!PRODUCER_KINDS.includes(event.producer_kind)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "producer_kind invalid");
  }
  validateWriter(event.writer);
  validateAuthority(event.authority);
  if (event.revocation_generation != null) {
    assertInt(event.revocation_generation, "revocation_generation", { min: 0 });
  }
  if (!APPLICABILITY.includes(event.applicability_decision)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "applicability_decision invalid");
  }
  if (event.subject_event_id != null) assertHex64(event.subject_event_id, "subject_event_id");
  if (event.event_type === "TRANSFER_ADJUDICATED" && !isHex64(event.subject_event_id)) {
    fail(TRANSFER_CODES.SUBJECT_UNBOUND, "TRANSFER_ADJUDICATED requires subject_event_id");
  }
  validateOutcomeRef(event.outcome_ref, event.event_type === "OUTCOME_OBSERVED");
  validatePayload(event.event_type, event.payload);
  if (event.event_type === "INCIDENT_OBSERVED") {
    applyIncidentObservedProfile(event);
  }
  if (event.event_type === "OUTCOME_OBSERVED") {
    if (event.outcome_ref.execution_id !== event.attempt_identity.execution_id) {
      fail(TRANSFER_CODES.OUTCOME_MISMATCH, "outcome_ref.execution_id must match attempt_identity");
    }
    if (event.outcome_ref.final !== event.payload.final) {
      fail(TRANSFER_CODES.OUTCOME_MISMATCH, "outcome_ref.final must match payload.final");
    }
  }
  return event;
}

export function validateCallerEvent(event) {
  return validateMeasurementEvent(event, SCHEMA_VERSION);
}

/**
 * Validate a caller event against a specific log generation's rules.
 * GEN-1: v1 measurement rules with v1 pin. GEN-2: v2 pin; measurement
 * events validate under the same conditional profiles; the single authority
 * event type validates against the closed V2 authority schema. Unknown
 * generation fails closed.
 */
export function validateEventForGeneration(event, generation) {
  if (generation === 1) {
    // The closed 14-type V1 allowlist can never contain an authority event:
    // reject with EVENT_UNKNOWN_TYPE (T5) before the schema pin.
    if (!EVENT_TYPES.includes(event.event_type)) {
      fail(TRANSFER_CODES.EVENT_UNKNOWN_TYPE, `event_type ${String(event.event_type)}`);
    }
    return validateMeasurementEvent(event, SCHEMA_VERSION);
  }
  if (generation === 2) {
    if (event.event_type === AUTHORITY_EVENT_TYPE) return validateAuthorityRecord(event);
    return validateMeasurementEvent(event, SCHEMA_VERSION_V2);
  }
  fail(TRANSFER_CODES.EVENT_UNKNOWN_SCHEMA, `unknown log generation ${String(generation)}`);
}

// ---------------------------------------------------------------------------
// V2 authority event (LEARNING_AUTHORITY_STATE_CHANGED) — closed payload
// allowlist, writer-recomputed digests, subject-identity validation.
// ---------------------------------------------------------------------------

export const AUTHORITY_REQUIRED_PAYLOAD_FIELDS = Object.freeze([
  "authority_domain",
  "subject_kind",
  "subject_identity",
  "operation",
  "previous_generation",
  "new_generation",
  "previous_state",
  "new_state",
  "expected_previous_generation",
  "issuer_principal_digest",
  "issuer_authority_generation",
  "issuer_revocation_generation",
  "mutation_id",
]);

export const AUTHORITY_OPTIONAL_PAYLOAD_FIELDS = Object.freeze(["evidence_refs", "reason"]);

export const AUTHORITY_ISSUER_WRITER_ID = "learning-authority-issuer";

function assertAuthoritySubjectKeys(identity, allowed) {
  for (const key of Object.keys(identity)) {
    if (!allowed.includes(key)) {
      fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, `subject_identity unknown field: ${key}`);
    }
  }
}

function assertAuthorityKnownKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `${label} unknown field: ${key}`);
    }
  }
}

function walkAuthorityForbiddenKeys(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkAuthorityForbiddenKeys(item, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
        fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `forbidden key ${key} at ${path}.${key}`);
      }
      walkAuthorityForbiddenKeys(child, `${path}.${key}`);
    }
  }
}

function assertAuthorityInt(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `${label} must be a safe integer >= 0`);
  }
}

function assertAuthorityBoundedString(value, label) {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES_PER_FIELD
    || /[\u0000\r\n]/.test(value)) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `${label} must be a bounded non-empty string`);
  }
}

export function validateAuthoritySubjectIdentity(identity, subjectKind) {
  assertPlainObject(identity, "subject_identity");
  walkAuthorityForbiddenKeys(identity, "subject_identity");
  if (identity.authority_domain !== AUTHORITY_DOMAIN) {
    fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, "subject_identity.authority_domain mismatch");
  }
  if (identity.subject_kind !== subjectKind) {
    fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, "subject_identity.subject_kind mismatch");
  }
  if (subjectKind === "WRITER_PRINCIPAL") {
    assertAuthoritySubjectKeys(
      identity,
      ["authority_domain", "subject_kind", "writer_id", "project_identity", "writer_storage_identity"],
    );
    assertAuthorityBoundedString(identity.writer_id, "subject_identity.writer_id");
    validateProjectIdentity(identity.project_identity);
    assertAuthorityBoundedString(identity.writer_storage_identity, "subject_identity.writer_storage_identity");
    if (!identity.writer_storage_identity.startsWith(ALLOWED_ROOT_PREFIX)) {
      fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, "subject_identity.writer_storage_identity outside NVM2T boundary");
    }
    return;
  }
  assertAuthoritySubjectKeys(
    identity,
    ["authority_domain", "subject_kind", "cited_key", "project_identity", "task_admission_identity"],
  );
  assertAuthorityBoundedString(identity.cited_key, "subject_identity.cited_key");
  validateProjectIdentity(identity.project_identity);
  assertPlainObject(identity.task_admission_identity, "subject_identity.task_admission_identity");
  assertKnownKeys(identity.task_admission_identity, ["task_id", "admission_id"], "subject_identity.task_admission_identity");
  assertAuthorityBoundedString(identity.task_admission_identity.task_id, "subject_identity.task_admission_identity.task_id");
  assertHex64(identity.task_admission_identity.admission_id, "subject_identity.task_admission_identity.admission_id");
}

export function validateAuthorityPayload(payload) {
  assertPlainObject(payload, "payload");
  walkAuthorityForbiddenKeys(payload, "payload");
  assertAuthorityKnownKeys(
    payload,
    [...AUTHORITY_REQUIRED_PAYLOAD_FIELDS, ...AUTHORITY_OPTIONAL_PAYLOAD_FIELDS],
    "payload",
  );
  for (const key of AUTHORITY_REQUIRED_PAYLOAD_FIELDS) {
    if (payload[key] === undefined) {
      fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `payload.${key} required`);
    }
  }
  if (payload.authority_domain !== AUTHORITY_DOMAIN) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "payload.authority_domain mismatch");
  }
  if (!AUTHORITY_SUBJECT_KINDS.includes(payload.subject_kind)) {
    fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, `unknown subject_kind ${String(payload.subject_kind)}`);
  }
  validateAuthoritySubjectIdentity(payload.subject_identity, payload.subject_kind);
  if (!AUTHORITY_OPERATIONS.includes(payload.operation)) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `unknown operation ${String(payload.operation)}`);
  }
  assertAuthorityInt(payload.previous_generation, "payload.previous_generation");
  assertAuthorityInt(payload.new_generation, "payload.new_generation");
  if (payload.new_generation !== payload.previous_generation + 1) {
    fail(TRANSFER_CODES.AUTHORITY_GENERATION_CONFLICT, "new_generation must equal previous_generation + 1");
  }
  if (payload.previous_state !== null && !AUTHORITY_STATES.includes(payload.previous_state)) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "payload.previous_state invalid");
  }
  if (!AUTHORITY_STATES.includes(payload.new_state)) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `unknown new_state ${String(payload.new_state)}`);
  }
  if (payload.new_state === "REVOKED" && payload.operation !== "REVOKE") {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "REVOKED requires operation REVOKE");
  }
  if (payload.new_state === "CURRENT" && payload.operation !== "SET_GENERATION") {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "CURRENT requires operation SET_GENERATION");
  }
  assertAuthorityInt(payload.expected_previous_generation, "payload.expected_previous_generation");
  assertHex64(payload.issuer_principal_digest, "payload.issuer_principal_digest");
  assertAuthorityInt(payload.issuer_authority_generation, "payload.issuer_authority_generation");
  assertAuthorityInt(payload.issuer_revocation_generation, "payload.issuer_revocation_generation");
  assertAuthorityBoundedString(payload.mutation_id, "payload.mutation_id");
  if (payload.evidence_refs != null) {
    if (!Array.isArray(payload.evidence_refs) || payload.evidence_refs.length > MAX_EVIDENCE_REFS) {
      fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `payload.evidence_refs must be an array <= ${MAX_EVIDENCE_REFS}`);
    }
    for (const ref of payload.evidence_refs) {
      assertPlainObject(ref, "payload.evidence_refs[]");
      assertKnownKeys(ref, ["kind", "identity", "digest"], "payload.evidence_refs[]");
      if (!EVIDENCE_REF_KINDS.includes(ref.kind)) {
        fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `unknown evidence_refs.kind ${String(ref.kind)}`);
      }
      assertAuthorityBoundedString(ref.identity, "payload.evidence_refs[].identity");
      assertNotAbsolutePath(ref.identity, "payload.evidence_refs[].identity");
      assertHex64(ref.digest, "payload.evidence_refs[].digest");
    }
  }
  if (payload.reason != null && !AUTHORITY_REASONS.includes(payload.reason)) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `unknown reason ${String(payload.reason)}`);
  }
  return payload;
}

export function computeAuthorityIdempotencyKey(payload) {
  return digestOf({
    authority_domain: payload.authority_domain,
    subject_kind: payload.subject_kind,
    subject_identity: payload.subject_identity,
    operation: payload.operation,
    previous_generation: payload.previous_generation,
    new_generation: payload.new_generation,
    mutation_id: payload.mutation_id,
  });
}

export function computeAuthorityPayloadDigest(payload) {
  return digestOf(payload);
}

/**
 * Full closed-schema validation of one durable V2 authority record (read
 * side: chain readers, reducer, projection, replay). The writer-recomputed
 * payload digest and idempotency/event-id derivation are re-verified; a
 * caller-supplied digest is never authority.
 */
export function validateAuthorityRecord(event) {
  event = isolateCallerEvent(event, "event");
  assertPlainObject(event, "event");
  assertKnownKeys(event, ENVELOPE_FIELDS, "event");
  for (const key of ENVELOPE_FIELDS) {
    if (event[key] === undefined) {
      fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `event.${key} required`);
    }
  }
  if (event.schema_version !== SCHEMA_VERSION_V2) {
    fail(TRANSFER_CODES.EVENT_UNKNOWN_SCHEMA, `schema_version ${String(event.schema_version)}`);
  }
  if (event.event_type !== AUTHORITY_EVENT_TYPE) {
    fail(TRANSFER_CODES.EVENT_UNKNOWN_TYPE, `event_type ${String(event.event_type)}`);
  }
  assertIso(event.occurred_at, "occurred_at");
  assertIso(event.recorded_at, "recorded_at");
  validateProjectIdentity(event.project_identity);
  validateTaskIdentity(event.task_identity);
  if (event.attempt_identity != null) validateAttemptIdentity(event.attempt_identity);
  if (event.incident_identity !== null) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "authority record incident_identity must be null");
  }
  if (event.pattern_identity !== null) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "authority record pattern_identity must be null");
  }
  if (event.retrieval_event_id !== null || event.subject_event_id !== null || event.outcome_ref !== null) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "authority record carries no measurement linkage");
  }
  validateWriter(event.writer);
  if (event.writer.writer_id !== AUTHORITY_ISSUER_WRITER_ID) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "authority record writer must be the sealed issuer identity");
  }
  assertPlainObject(event.authority, "authority");
  assertKnownKeys(event.authority, ["identity", "role"], "authority");
  assertAuthorityInt(event.revocation_generation, "revocation_generation");
  if (event.applicability_decision !== "UNKNOWN") {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "authority record applicability_decision must be UNKNOWN");
  }
  if (!Array.isArray(event.evidence_refs) || event.evidence_refs.length !== 0) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "authority record envelope evidence_refs must be empty");
  }
  assertPlainObject(event.redaction_status, "redaction_status");
  validateAuthorityPayload(event.payload);
  if (event.revocation_generation !== event.payload.new_generation) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "revocation_generation must equal payload.new_generation");
  }
  const key = computeAuthorityIdempotencyKey(event.payload);
  if (event.idempotency_key !== key) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "idempotency_key does not match writer derivation");
  }
  if (event.event_id !== digestOf(key)) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "event_id does not match writer derivation");
  }
  if (event.payload_digest !== computeAuthorityPayloadDigest(event.payload)) {
    fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "payload_digest does not match writer recomputation");
  }
  const recomputed = computeEventDigest({
    journal_sequence: event.journal_sequence,
    event_id: event.event_id,
    event_type: event.event_type,
    payload_digest: event.payload_digest,
    previous_digest: event.previous_digest,
  });
  if (event.event_digest !== recomputed) {
    fail(TRANSFER_CODES.AUTHORITY_LOG_CHAIN_INVALID, "event_digest chain mismatch");
  }
  return event;
}

export function headerObjectFor(createdAt, generation) {
  if (generation === SCHEMA_VERSION_NUMBER_V2) {
    return { created_at: createdAt, schema: LOG_SCHEMA_V2, schema_version: SCHEMA_VERSION_NUMBER_V2 };
  }
  return headerObject(createdAt);
}

export function assertPrincipalBinding(event, principal) {
  assertPlainObject(principal, "principal");
  assertKnownKeys(principal, ["identity", "role"], "principal");
  if (!PRINCIPAL_ROLES.includes(principal.role)) {
    fail(TRANSFER_CODES.AUTHORITY_FORGED, `unknown principal.role ${principal.role}`);
  }
  assertString(principal.identity, "principal.identity");
  if (event.authority.identity !== principal.identity || event.authority.role !== principal.role) {
    fail(TRANSFER_CODES.AUTHORITY_FORGED, "event.authority must equal append principal");
  }
}

export function assertRolePermissions(event, principal, { allowFixture }) {
  const role = principal.role;
  const type = event.event_type;
  if (role === "fixture") {
    if (event.producer_kind !== "fixture" || !allowFixture) {
      fail(TRANSFER_CODES.AUTHORITY_INSUFFICIENT, "fixture principal requires fixture producer_kind and fixture root");
    }
    return;
  }
  if (event.producer_kind !== "measurement-writer") {
    fail(TRANSFER_CODES.AUTHORITY_INSUFFICIENT, "non-fixture principal cannot set producer_kind=fixture");
  }
  if (type === "OUTCOME_OBSERVED" && role !== "system") {
    fail(TRANSFER_CODES.AUTHORITY_INSUFFICIENT, "OUTCOME_OBSERVED requires principal.role=system");
  }
  if (type === "TRANSFER_ADJUDICATED") {
    if (role !== "reviewer" && role !== "operator") {
      fail(TRANSFER_CODES.AUTHORITY_INSUFFICIENT, "TRANSFER_ADJUDICATED requires reviewer|operator");
    }
    const grade = event.payload.attribution_grade;
    if ((grade === "C" || grade === "D") && event.payload.adjudicator_role !== role) {
      fail(TRANSFER_CODES.AUTHORITY_INSUFFICIENT, "C/D adjudicator_role must equal principal.role");
    }
  }
  if (role === "executor") {
    if (type === "OUTCOME_OBSERVED" || type === "TRANSFER_ADJUDICATED") {
      fail(TRANSFER_CODES.AUTHORITY_INSUFFICIENT, "executor cannot write OUTCOME or ADJUDICATED");
    }
    if (event.applicability_decision !== "UNKNOWN") {
      fail(TRANSFER_CODES.AUTHORITY_INSUFFICIENT, "executor cannot write APPLICABLE/NOT_APPLICABLE");
    }
    if (event.payload?.attribution_grade === "C" || event.payload?.attribution_grade === "D") {
      fail(TRANSFER_CODES.AUTHORITY_INSUFFICIENT, "executor cannot write D/C attribution");
    }
  }
  if (role === "system") {
    if (type === "TRANSFER_ADJUDICATED") {
      fail(TRANSFER_CODES.AUTHORITY_INSUFFICIENT, "system cannot self-promote to adjudication");
    }
    if (type === "PATTERN_RETRIEVED" && event.applicability_decision !== "UNKNOWN") {
      fail(TRANSFER_CODES.AUTHORITY_INSUFFICIENT, "system PATTERN_RETRIEVED must leave applicability UNKNOWN");
    }
  }
}

export function headerObject(createdAt) {
  return {
    created_at: createdAt,
    schema: LOG_SCHEMA,
    schema_version: SCHEMA_VERSION_NUMBER,
  };
}
