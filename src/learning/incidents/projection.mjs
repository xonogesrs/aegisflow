// src/learning/incidents/projection.mjs
//
// Stage E incident observation projection: a deterministic, ephemeral,
// NON_AUTHORITATIVE read model built from chain-valid transfer-event raw bytes.
//
// Not a source authority, lifecycle outcome authority, current revocation
// authority, pattern authority, retrieval authority, planning/verification
// authority, or PASS/HOLD authority. Storage is ephemeral only: callers keep the
// returned object or canonical bytes in memory. Nothing is persisted here, no
// second index/durable engine exists, and the raw log is never modified.

import { createHash } from "node:crypto";

import { compareCodePoints } from "../../memory/canonical.mjs";
import {
  AUTHORITY_EVENT_TYPE,
  EVIDENCE_REF_KINDS,
  EVENT_TYPES,
  EVENT_TYPES_V2,
  FORBIDDEN_PAYLOAD_KEYS,
  GENESIS_DIGEST,
  INCIDENT_COMPLETENESS_WRITE_CLASSES,
  INCIDENT_OBS_SCHEMA,
  INCIDENT_OBSERVED_FORBIDDEN_KEYS,
  INCIDENT_OBSERVED_OUTCOME_CLASSES,
  INCIDENT_SOURCE_CLASSES,
  LOG_SCHEMA,
  LOG_SCHEMA_V2,
  MAX_EVIDENCE_REFS,
  MAX_EVENT_BYTES,
  MAX_STRING_BYTES_PER_FIELD,
  PRINCIPAL_ROLES,
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2,
  TRANSFER_CODES,
  TransferMetricsError,
  canonical,
  computeEventDigest,
  deriveEvidenceSetDigest,
  deriveIncidentId,
  deriveSourceIdentityKey,
  digestOf,
  isolateCallerEvent,
  isHex64,
  validateAuthorityRecord,
} from "../transfer-metrics/schema.mjs";
import { scanTransferPayload } from "../transfer-metrics/redact.mjs";

// FROZEN schema / policy versions (PROJECTION-DESIGN-FREEZE.md §5).
export const PROJECTION_SCHEMA_VERSION = "autoloop.incident-projection/v1";
export const PROJECTION_ALGORITHM_VERSION =
  "autoloop.incident-projection-algorithm/v1";
export const QUERY_POLICY_VERSION = "autoloop.incident-projection-query/v1";
export const CURRENT_AUTHORITY_POLICY_VERSION =
  "autoloop.incident-projection-current/v1";

// FROZEN bounds (PROJECTION-DESIGN-FREEZE.md §3/§9).
export const PROJECTION_MAX_INPUT_BYTES = 9437184;
export const PROJECTION_MAX_INPUT_EVENTS = 65536;
export const PROJECTION_DEFAULT_LIMIT = 50;
export const PROJECTION_MAX_LIMIT = 500;
export const PROJECTION_MAX_OUTPUT_BYTES = 1048576;
export const PROJECTION_MAX_EVIDENCE_REFS_PER_ITEM = MAX_EVIDENCE_REFS;
export const PROJECTION_MAX_CURSOR_BYTES = 4096;
export const PROJECTION_MAX_FILTER_VALUES = 64;
export const PROJECTION_MAX_STRING_FIELD_BYTES = MAX_STRING_BYTES_PER_FIELD;
export const PROJECTION_MAX_LINE_BYTES = MAX_EVENT_BYTES;

// The seven-value current-authority enum is frozen by the architecture freeze.
// Only NOT_EVALUATED is settable in the first slice; every other value is
// reserved for a separate current-verification admission.
export const CURRENT_AUTHORITY_POLICY_V1_STATUSES = Object.freeze([
  "VERIFIED_CURRENT",
  "STALE_GENERATION",
  "REVOKED",
  "SOURCE_MISSING",
  "SOURCE_CONFLICT",
  "IDENTITY_MISMATCH",
  "NOT_EVALUATED",
]);
export const CURRENT_AUTHORITY_STATUS_NOT_EVALUATED = "NOT_EVALUATED";

// Closed failure-code inventory (PROJECTION-DESIGN-FREEZE.md §14). Never fold
// these into a generic INVALID/empty result.
export const PROJECTION_CODES = Object.freeze({
  PROJECTION_INPUT_MISSING: "PROJECTION_INPUT_MISSING",
  PROJECTION_INPUT_TOO_LARGE: "PROJECTION_INPUT_TOO_LARGE",
  PROJECTION_EVENT_LIMIT_EXCEEDED: "PROJECTION_EVENT_LIMIT_EXCEEDED",
  PROJECTION_LINE_TOO_LARGE: "PROJECTION_LINE_TOO_LARGE",
  PROJECTION_LOG_CHAIN_INVALID: "PROJECTION_LOG_CHAIN_INVALID",
  PROJECTION_EVENT_DIGEST_INVALID: "PROJECTION_EVENT_DIGEST_INVALID",
  PROJECTION_SCHEMA_UNSUPPORTED: "PROJECTION_SCHEMA_UNSUPPORTED",
  PROJECTION_EVENT_TYPE_UNSUPPORTED: "PROJECTION_EVENT_TYPE_UNSUPPORTED",
  PROJECTION_PROFILE_INVALID: "PROJECTION_PROFILE_INVALID",
  PROJECTION_IDENTITY_CONFLICT: "PROJECTION_IDENTITY_CONFLICT",
  PROJECTION_SOURCE_CONFLICT: "PROJECTION_SOURCE_CONFLICT",
  PROJECTION_SNAPSHOT_RACE: "PROJECTION_SNAPSHOT_RACE",
  PROJECTION_PATH_REPLACED: "PROJECTION_PATH_REPLACED",
  PROJECTION_NON_REGULAR_INPUT: "PROJECTION_NON_REGULAR_INPUT",
  PROJECTION_STALE_GENERATION: "PROJECTION_STALE_GENERATION",
  PROJECTION_SOURCE_MISSING: "PROJECTION_SOURCE_MISSING",
  PROJECTION_REVOKED: "PROJECTION_REVOKED",
  PROJECTION_CURRENT_STATUS_NOT_VERIFIED:
    "PROJECTION_CURRENT_STATUS_NOT_VERIFIED",
  PROJECTION_CURSOR_INVALID: "PROJECTION_CURSOR_INVALID",
  PROJECTION_CURSOR_STALE: "PROJECTION_CURSOR_STALE",
  PROJECTION_FILTER_INVALID: "PROJECTION_FILTER_INVALID",
  PROJECTION_LIMIT_INVALID: "PROJECTION_LIMIT_INVALID",
  PROJECTION_OUTPUT_TOO_LARGE: "PROJECTION_OUTPUT_TOO_LARGE",
  PROJECTION_SECRET_REJECTED: "PROJECTION_SECRET_REJECTED",
  PROJECTION_INTERNAL_CONTRACT_VIOLATION:
    "PROJECTION_INTERNAL_CONTRACT_VIOLATION",
});

// Individual exports of the capture-path codes consumed by writer.mjs
// (freeze §2.1 PLACEMENT: writer.mjs imports exactly these six names).
export const PROJECTION_INPUT_MISSING = PROJECTION_CODES.PROJECTION_INPUT_MISSING;
export const PROJECTION_INPUT_TOO_LARGE = PROJECTION_CODES.PROJECTION_INPUT_TOO_LARGE;
export const PROJECTION_NON_REGULAR_INPUT = PROJECTION_CODES.PROJECTION_NON_REGULAR_INPUT;
export const PROJECTION_PATH_REPLACED = PROJECTION_CODES.PROJECTION_PATH_REPLACED;
export const PROJECTION_SNAPSHOT_RACE = PROJECTION_CODES.PROJECTION_SNAPSHOT_RACE;

export class ProjectionError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "ProjectionError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ProjectionError(code, message, details ?? {});
}

export const INCIDENT_PROJECTION_ITEM_IDENTITY_DOMAIN =
  "autoloop.incident-projection-item/v1";

const RAW_APPEND_ORDINAL_FILTER = "raw_append_ordinal";
const OCCURRED_AT_FILTER = "occurred_at";
const RECORDED_AT_FILTER = "recorded_at";
const CURRENT_STATUS_FILTER = "current_authority_status";

// Exact-match filter allowlist (PROJECTION-DESIGN-FREEZE.md §9). No free text,
// substring, regex, glob, fuzzy, vector, semantic, or caller-predicate surface.
export const PROJECTION_FILTER_ALLOWLIST = Object.freeze([
  "project_repository_root_identity",
  "project_git_common_dir_identity",
  "task_id",
  "admission_id",
  "attempt_execution_id",
  "attempt_number",
  "incident_observation_id",
  "incident_id",
  "source_identity_key",
  "source_system",
  "source_record_type",
  "source_record_id",
  "recorded_completeness",
  "observed_outcome_class",
  CURRENT_STATUS_FILTER,
  RAW_APPEND_ORDINAL_FILTER,
  OCCURRED_AT_FILTER,
  RECORDED_AT_FILTER,
]);

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const RANGE_FILTER_KEYS = Object.freeze({
  [RAW_APPEND_ORDINAL_FILTER]: Object.freeze(["min", "max"]),
  [OCCURRED_AT_FILTER]: Object.freeze(["start", "end"]),
  [RECORDED_AT_FILTER]: Object.freeze(["start", "end"]),
});

const CURSOR_FIELDS = Object.freeze([
  "cv",
  "av",
  "ld",
  "qp",
  "fd",
  "sd",
  "lo",
  "le",
]);

// ---------------------------------------------------------------------------
// Snapshot handling
// ---------------------------------------------------------------------------

function projectionErrorFromSnapshot(err) {
  // Reader throws are mapped positionally: corruption at a complete line →
  // PROJECTION_LOG_CHAIN_INVALID; partial trailing line → PROJECTION_SNAPSHOT_RACE.
  if (err instanceof ProjectionError) return err;
  if (err instanceof TransferMetricsError) {
    if (err.code === TRANSFER_CODES.PATH_UNSAFE) {
      return new ProjectionError(
        PROJECTION_CODES.PROJECTION_NON_REGULAR_INPUT,
        err.message,
      );
    }
    if (err.code === TRANSFER_CODES.LOG_PARTIAL_TAIL) {
      return new ProjectionError(
        PROJECTION_CODES.PROJECTION_SNAPSHOT_RACE,
        err.message,
      );
    }
    if (err.code === TRANSFER_CODES.LOG_CHAIN_INVALID) {
      const message = String(err.message ?? "");
      if (message.includes("idempotency key collision")) {
        // Unreachable via the public reader mapping (the projection re-derives
        // idempotency collisions itself), kept fail-closed regardless.
        return new ProjectionError(
          PROJECTION_CODES.PROJECTION_IDENTITY_CONFLICT,
          message,
        );
      }
      if (message.includes("partial trailing line")) {
        return new ProjectionError(
          PROJECTION_CODES.PROJECTION_SNAPSHOT_RACE,
          message,
        );
      }
      return new ProjectionError(
        PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID,
        message,
      );
    }
    return new ProjectionError(
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
      err.message,
    );
  }
  return err;
}

function isZeroByteActiveFile(file) {
  return (
    file.name === "transfer-events.jsonl" && file.byte_length === 0
  );
}

/**
 * Verify one JSONL file of captured bytes. The reader's partial-tail rule is
 * re-derived here so a partial tail captured at the snapshot linearization
 * point fails closed instead of being treated as EOF.
 */
function parseFileLines(file, bytes, { isActive }) {
  if (bytes.length === 0) {
    // A 0-byte active file is a valid empty log (log.mjs exempts it from the
    // header check). A 0-byte archive is corrupt: it must have had a header.
    if (isActive) return { lines: [], partialTrailingLine: false, sawHeader: false };
    fail(PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID, "empty archive file");
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID, "log is not valid UTF-8");
  }

  const lines = text.split("\n");
  // A trailing "" element means the file ended with a newline; drop it.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
    return { lines, partialTrailingLine: false, sawHeader: lines.length > 0 };
  }

  const lastLine = lines[lines.length - 1];
  if (isActive) {
    // Captured partial tail: never repaired, never treated as EOF.
    fail(
      PROJECTION_CODES.PROJECTION_SNAPSHOT_RACE,
      "partial trailing line captured in active log file",
    );
  }
  if (lastLine === undefined) {
    fail(PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID, "empty archive file");
  }
  fail(
    PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID,
    "partial trailing line in archive file",
  );
}

function parseHeaderLine(line) {
  let header;
  try {
    header = JSON.parse(line);
  } catch {
    fail(PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID, "log header is not valid JSON");
  }
  // Generation = header: …-log/v1 + 1 ⇒ GEN-1; …-log/v2 + 2 ⇒ GEN-2.
  if (header?.schema === LOG_SCHEMA && header?.schema_version === 1) return 1;
  if (header?.schema === LOG_SCHEMA_V2 && header?.schema_version === 2) return 2;
  fail(PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID, "log header schema mismatch");
}

function assertBoundedString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, `${label} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > PROJECTION_MAX_STRING_FIELD_BYTES) {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, `${label} exceeds max bytes`);
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, `${label} must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, `${label} must be a plain object`);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      fail(
        PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
        `${label} forbidden key ${key}`,
      );
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc && (typeof desc.get === "function" || typeof desc.set === "function")) {
      fail(
        PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
        `${label} must own its data descriptors`,
      );
    }
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(
        PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
        `${label} unexpected field ${key}`,
      );
    }
  }
}

function assertNonNegativeInt(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, `${label} must be an integer >= 0`);
  }
}

function assertHex64Field(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, `${label} must be a 64-hex string`);
  }
}


function assertIsoUtc(value, label) {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value)) {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, `${label} must be ISO-8601 UTC`);
  }
}

function walkForbiddenKeys(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkForbiddenKeys(item, `${label}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
        fail(
          PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
          `forbidden key ${key} at ${label}.${key}`,
        );
      }
      walkForbiddenKeys(child, `${label}.${key}`);
    }
  }
}

function assertEvidenceRefs(refs, evidenceComplete) {
  if (!Array.isArray(refs)) {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, "evidence_refs must be an array");
  }
  if (refs.length > PROJECTION_MAX_EVIDENCE_REFS_PER_ITEM) {
    fail(
      PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
      `evidence_refs exceeds ${PROJECTION_MAX_EVIDENCE_REFS_PER_ITEM}`,
    );
  }
  const seenExact = new Set();
  const byIdentity = new Map();
  for (const ref of refs) {
    assertPlainObject(ref, "evidence_refs[]");
    assertExactKeys(ref, ["kind", "identity", "digest"], "evidence_refs[]");
    if (!EVIDENCE_REF_KINDS.includes(ref.kind)) {
      fail(
        PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
        `unknown evidence_refs.kind ${String(ref.kind)}`,
      );
    }
    assertBoundedString(ref.identity, "evidence_refs[].identity");
    assertHex64Field(ref.digest, "evidence_refs[].digest");
    const identityKey = `${ref.kind}\n${ref.identity}`;
    const exactKey = `${identityKey}\n${ref.digest}`;
    if (seenExact.has(exactKey)) {
      fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, "duplicate exact evidence reference");
    }
    seenExact.add(exactKey);
    const prior = byIdentity.get(identityKey);
    if (prior && prior !== ref.digest) {
      fail(
        PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
        "same evidence identity with different digest",
      );
    }
    byIdentity.set(identityKey, ref.digest);
  }
  if (evidenceComplete === true && refs.length < 1) {
    fail(
      PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
      "evidence_complete=true requires at least one evidence ref",
    );
  }
}

function validatePrincipalShapes(event) {
  const writer = event.writer;
  assertPlainObject(writer, "writer");
  assertExactKeys(writer, ["writer_id", "writer_generation"], "writer");
  assertBoundedString(writer.writer_id, "writer.writer_id");
  assertNonNegativeInt(writer.writer_generation, "writer.writer_generation");

  const authority = event.authority;
  assertPlainObject(authority, "authority");
  assertExactKeys(authority, ["identity", "role"], "authority");
  assertBoundedString(authority.identity, "authority.identity");
  if (!PRINCIPAL_ROLES.includes(authority.role)) {
    fail(
      PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
      `unknown authority.role ${String(authority.role)}`,
    );
  }
}

function assertProfileIdentityDerivations(event) {
  const payload = event.payload;
  const derivedSourceIdentityKey = deriveSourceIdentityKey(event);
  if (!timingSafeEqualStrings(payload.source_identity_key, derivedSourceIdentityKey)) {
    fail(
      PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
      "payload.source_identity_key does not match derived value",
    );
  }
  const derivedEvidenceSetDigest = deriveEvidenceSetDigest(event.evidence_refs);
  if (!timingSafeEqualStrings(payload.evidence_set_digest, derivedEvidenceSetDigest)) {
    fail(
      PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
      "payload.evidence_set_digest does not match derived value",
    );
  }
  const derivedIncidentId = deriveIncidentId(
    derivedSourceIdentityKey,
    payload.source_record_digest,
    derivedEvidenceSetDigest,
  );
  if (!timingSafeEqualStrings(event.incident_identity?.incident_id, derivedIncidentId)) {
    fail(
      PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
      "incident_identity.incident_id does not match derived value",
    );
  }
}

function timingSafeEqualStrings(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqualBytes(leftBytes, rightBytes);
}

// node:crypto timingSafeEqual re-exported through a helper keeps the crypto
// import in one place.
import { timingSafeEqual as timingSafeEqualBytes } from "node:crypto";

function validateIncidentProfile(event) {
  const payload = event.payload;
  for (const key of [
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
  ]) {
    if (payload[key] == null) {
      fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, `payload.${key} required`);
    }
  }
  if (payload.profile_version !== INCIDENT_OBS_SCHEMA) {
    fail(
      PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
      "payload.profile_version must be " + INCIDENT_OBS_SCHEMA,
    );
  }
  if (!INCIDENT_SOURCE_CLASSES.includes(payload.source_class)) {
    fail(
      PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
      `unknown payload.source_class ${String(payload.source_class)}`,
    );
  }
  assertBoundedString(payload.source_record_id, "payload.source_record_id");
  assertBoundedString(
    payload.source_authority_identity,
    "payload.source_authority_identity",
  );
  if (PRINCIPAL_ROLES.includes(payload.source_authority_identity)) {
    fail(
      PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
      "payload.source_authority_identity must not be a role name",
    );
  }
  assertNonNegativeInt(
    payload.source_authority_generation,
    "payload.source_authority_generation",
  );
  assertBoundedString(
    payload.failure_finding_discriminator,
    "payload.failure_finding_discriminator",
  );
  assertHex64Field(payload.source_record_digest, "payload.source_record_digest");
  assertHex64Field(payload.evidence_set_digest, "payload.evidence_set_digest");
  assertHex64Field(payload.source_identity_key, "payload.source_identity_key");
  if (!INCIDENT_COMPLETENESS_WRITE_CLASSES.includes(payload.evidence_completeness_class)) {
    fail(
      PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
      "payload.evidence_completeness_class must be COMPLETE or INCOMPLETE",
    );
  }
  if (!INCIDENT_OBSERVED_OUTCOME_CLASSES.includes(payload.observed_outcome_class)) {
    fail(
      PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
      `invalid payload.observed_outcome_class ${String(payload.observed_outcome_class)}`,
    );
  }
  const sourceLinkage = payload.source_linkage;
  if (sourceLinkage != null) {
    assertPlainObject(sourceLinkage, "payload.source_linkage");
    assertExactKeys(
      sourceLinkage,
      ["parent_source_record_id", "direction"],
      "payload.source_linkage",
    );
    assertBoundedString(
      sourceLinkage.parent_source_record_id,
      "payload.source_linkage.parent_source_record_id",
    );
    if (!["PARENT", "CHILD"].includes(sourceLinkage.direction)) {
      fail(
        PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
        "payload.source_linkage.direction must be PARENT|CHILD",
      );
    }
  }
  for (const key of ["excluded_from_product_defect", "repaired"]) {
    if (payload[key] != null && typeof payload[key] !== "boolean") {
      fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, `payload.${key} must be boolean`);
    }
  }
  for (const key of ["source_error_code", "source_invariant_id"]) {
    if (payload[key] != null) {
      assertBoundedString(payload[key], `payload.${key}`);
    }
  }
  assertProfileIdentityDerivations(event);
}

const PAYLOAD_ALLOWLIST = Object.freeze({
  INCIDENT_OBSERVED: Object.freeze([
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
  ]),
  PATTERN_CANDIDATE_CREATED: Object.freeze([
    "lifecycle_state",
    "mechanism_digest",
    "applicability_digest",
    "constituent_incident_set_digest",
  ]),
  PATTERN_QUALIFIED: Object.freeze([
    "lifecycle_state",
    "mechanism_digest",
    "applicability_digest",
    "lifecycle_event_digest",
  ]),
  PATTERN_DEMOTED: Object.freeze([
    "lifecycle_state",
    "mechanism_digest",
    "applicability_digest",
    "lifecycle_event_digest",
  ]),
  PATTERN_ARCHIVED: Object.freeze([
    "lifecycle_state",
    "mechanism_digest",
    "applicability_digest",
    "lifecycle_event_digest",
  ]),
  PATTERN_REMOVED: Object.freeze([
    "lifecycle_state",
    "mechanism_digest",
    "applicability_digest",
    "lifecycle_event_digest",
  ]),
  PATTERN_RETRIEVED: Object.freeze([
    "retrievalDigest",
    "storeSnapshotDigest",
    "rank",
    "truncated",
  ]),
  PATTERN_REJECTED: Object.freeze(["rejection_code", "retrievalDigest"]),
  STALE_PATTERN_REJECTED: Object.freeze(["rejection_code", "retrievalDigest"]),
  PATTERN_USED_IN_PLANNING: Object.freeze(["artifact_digest", "citation_kind"]),
  PATTERN_USED_IN_VERIFICATION: Object.freeze(["artifact_digest", "citation_kind"]),
  OUTCOME_OBSERVED: Object.freeze([
    "final",
    "hold_code",
    "repair_attempts",
    "evidence_manifest_digest",
  ]),
  TRANSFER_ADJUDICATED: Object.freeze([
    "attribution_grade",
    "benefit_claimed",
    "adjudicator_role",
    "counterfactual_digest",
    "detected_earlier",
    "unnecessary_gate",
    "overlay_applicability",
  ]),
  ROLLBACK_OBSERVED: Object.freeze([
    "from_generation",
    "to_generation",
    "reason_code",
  ]),
});

function validateOtherEventPayload(event) {
  const payload = event.payload;
  const allowed = PAYLOAD_ALLOWLIST[event.event_type];
  if (allowed === undefined) {
    fail(
      PROJECTION_CODES.PROJECTION_EVENT_TYPE_UNSUPPORTED,
      `unknown event_type ${String(event.event_type)}`,
    );
  }
  assertExactKeys(payload, allowed, "payload");
  for (const [key, expected] of [
    ["mechanism_digest", "hex64"],
    ["applicability_digest", "hex64"],
    ["lifecycle_event_digest", "hex64"],
    ["constituent_incident_set_digest", "hex64"],
    ["retrievalDigest", "hex64"],
    ["storeSnapshotDigest", "hex64"],
    ["artifact_digest", "hex64"],
    ["evidence_manifest_digest", "hex64"],
    ["counterfactual_digest", "hex64-or-null"],
  ]) {
    if (payload[key] === undefined) continue;
    if (expected === "hex64") assertHex64Field(payload[key], `payload.${key}`);
    else if (payload[key] != null) assertHex64Field(payload[key], `payload.${key}`);
  }
  for (const [key, check] of [
    ["lifecycle_state", (v) => typeof v === "string" && v.length > 0],
    ["rejection_code", (v) => typeof v === "string" && v.length > 0],
    ["rank", (v) => Number.isInteger(v) && v >= 0],
    ["truncated", (v) => typeof v === "boolean"],
    ["citation_kind", (v) => v === "explicit_reference" || v === "none"],
    ["final", (v) => v === "PASS" || v === "HOLD"],
    ["hold_code", (v) => v == null || (typeof v === "string" && v.length > 0)],
    ["repair_attempts", (v) => Number.isInteger(v) && v >= 0],
    ["attribution_grade", (v) => ["A", "B", "C", "D"].includes(v)],
    ["benefit_claimed", (v) => typeof v === "boolean"],
    ["adjudicator_role", (v) => v === "reviewer" || v === "operator"],
    ["detected_earlier", (v) => v == null || typeof v === "boolean"],
    ["unnecessary_gate", (v) => v == null || typeof v === "boolean"],
    ["overlay_applicability", (v) => v == null || ["APPLICABLE", "NOT_APPLICABLE"].includes(v)],
    ["from_generation", (v) => Number.isInteger(v) && v >= 0],
    ["to_generation", (v) => Number.isInteger(v) && v >= 0],
    ["reason_code", (v) => typeof v === "string" && v.length > 0],
  ]) {
    if (payload[key] === undefined) continue;
    if (payload[key] == null && (key === "hold_code" || key === "detected_earlier" || key === "unnecessary_gate" || key === "overlay_applicability" || key === "counterfactual_digest")) {
      continue;
    }
    if (!check(payload[key])) {
      fail(
        PROJECTION_CODES.PROJECTION_PROFILE_INVALID,
        `payload.${key} is invalid for ${event.event_type}`,
      );
    }
  }
}

/**
 * Full 15-step fail-closed validation of one durable record (freeze §4). Any
 * failure aborts the whole build: no skip-and-continue, no partial projection.
 */
function validateDurableRecord({ event, expectedSequence, previousDigest, generation }) {
  assertPlainObject(event, "event");
  assertExactKeys(
    event,
    [
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
    ],
    "event",
  );

  // Per-generation type gate [A62/T83]: the projection consults a
  // PER-GENERATION allowlist, so widening the shared EVENT_TYPES list alone
  // can never admit a v1-typed authority record (or any cross-generation
  // stamp) through this gate.
  if (generation === 2 && event.event_type === AUTHORITY_EVENT_TYPE) {
    // Full closed-schema validation of the V2 authority record; authority
    // events never materialize as projection items (caller skips them).
    validateAuthorityRecord(event);
    return;
  }
  const version = generation === 1 ? SCHEMA_VERSION : SCHEMA_VERSION_V2;
  const typeAllowlist = generation === 1 ? EVENT_TYPES : EVENT_TYPES_V2;
  if (event.schema_version !== version) {
    fail(
      PROJECTION_CODES.PROJECTION_SCHEMA_UNSUPPORTED,
      `unsupported schema_version ${String(event.schema_version)}`,
    );
  }
  if (!typeAllowlist.includes(event.event_type)) {
    fail(
      PROJECTION_CODES.PROJECTION_EVENT_TYPE_UNSUPPORTED,
      `unsupported event_type ${String(event.event_type)}`,
    );
  }
  assertIsoUtc(event.occurred_at, "occurred_at");
  assertIsoUtc(event.recorded_at, "recorded_at");

  const projectIdentity = event.project_identity;
  assertPlainObject(projectIdentity, "project_identity");
  assertExactKeys(
    projectIdentity,
    ["repository_root_identity", "git_common_dir_identity"],
    "project_identity",
  );
  assertBoundedString(
    projectIdentity.repository_root_identity,
    "project_identity.repository_root_identity",
  );
  assertBoundedString(
    projectIdentity.git_common_dir_identity,
    "project_identity.git_common_dir_identity",
  );

  const taskIdentity = event.task_identity;
  assertPlainObject(taskIdentity, "task_identity");
  assertExactKeys(taskIdentity, ["task_id", "admission_id"], "task_identity");
  assertBoundedString(taskIdentity.task_id, "task_identity.task_id");
  assertHex64Field(taskIdentity.admission_id, "task_identity.admission_id");

  const attemptIdentity = event.attempt_identity;
  assertPlainObject(attemptIdentity, "attempt_identity");
  assertExactKeys(attemptIdentity, ["execution_id", "attempt"], "attempt_identity");
  assertBoundedString(attemptIdentity.execution_id, "attempt_identity.execution_id");
  assertNonNegativeInt(attemptIdentity.attempt, "attempt_identity.attempt");

  if (event.event_type === "INCIDENT_OBSERVED") {
    const incidentIdentity = event.incident_identity;
    assertPlainObject(incidentIdentity, "incident_identity");
    assertExactKeys(
      incidentIdentity,
      ["incident_id", "incident_id_kind"],
      "incident_identity",
    );
    if (incidentIdentity.incident_id == null) {
      fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, "incident_identity.incident_id required");
    }
    assertHex64Field(incidentIdentity.incident_id, "incident_identity.incident_id");
    if (
      incidentIdentity.incident_id_kind != null
      && !["record", "evidence_bound", "fixture"].includes(incidentIdentity.incident_id_kind)
    ) {
      fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, "incident_id_kind invalid");
    }
  }

  if (typeof event.evidence_complete !== "boolean") {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, "evidence_complete must be boolean");
  }
  if (typeof event.missing_predecessor !== "boolean") {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, "missing_predecessor must be boolean");
  }
  assertEvidenceRefs(event.evidence_refs, event.evidence_complete);

  if (event.producer_kind !== "measurement-writer" && event.producer_kind !== "fixture") {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, "producer_kind invalid");
  }
  validatePrincipalShapes(event);

  // Generation + revocation fields are historical copies only; the projection
  // never re-validates them against a live registry.
  assertNonNegativeInt(event.writer.writer_generation, "writer.writer_generation");
  if (event.revocation_generation != null) {
    assertNonNegativeInt(event.revocation_generation, "revocation_generation");
  }
  if (!["APPLICABLE", "NOT_APPLICABLE", "UNKNOWN"].includes(event.applicability_decision)) {
    fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, "applicability_decision invalid");
  }
  if (event.retrieval_event_id != null) {
    assertHex64Field(event.retrieval_event_id, "retrieval_event_id");
  }
  if (event.subject_event_id != null) {
    assertHex64Field(event.subject_event_id, "subject_event_id");
  }
  if (event.outcome_ref != null) {
    const outcomeRef = event.outcome_ref;
    assertPlainObject(outcomeRef, "outcome_ref");
    assertExactKeys(outcomeRef, ["execution_id", "final", "attempt"], "outcome_ref");
    assertBoundedString(outcomeRef.execution_id, "outcome_ref.execution_id");
    if (outcomeRef.final !== "PASS" && outcomeRef.final !== "HOLD") {
      fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, "outcome_ref.final must be PASS or HOLD");
    }
    assertNonNegativeInt(outcomeRef.attempt, "outcome_ref.attempt");
  }

  const redactionStatus = event.redaction_status;
  assertPlainObject(redactionStatus, "redaction_status");
  assertExactKeys(redactionStatus, ["scanned", "truncated", "secret_hit"], "redaction_status");
  for (const key of ["scanned", "truncated", "secret_hit"]) {
    if (typeof redactionStatus[key] !== "boolean") {
      fail(PROJECTION_CODES.PROJECTION_PROFILE_INVALID, `redaction_status.${key} must be boolean`);
    }
  }

  walkForbiddenKeys(event.payload, "payload");
  if (event.event_type === "INCIDENT_OBSERVED") {
    for (const key of Object.keys(event.payload)) {
      if (INCIDENT_OBSERVED_FORBIDDEN_KEYS.includes(key)) {
        fail(
          PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
          `forbidden key ${key} at payload.${key}`,
        );
      }
    }
  }
  const payloadAllowed = PAYLOAD_ALLOWLIST[event.event_type];
  if (payloadAllowed === undefined) {
    fail(
      PROJECTION_CODES.PROJECTION_EVENT_TYPE_UNSUPPORTED,
      `unsupported event_type ${String(event.event_type)}`,
    );
  }
  assertExactKeys(event.payload, payloadAllowed, "payload");
  if (event.event_type === "INCIDENT_OBSERVED") {
    validateIncidentProfile(event);
  } else {
    validateOtherEventPayload(event);
  }

  const payloadDigest = digestOf(event.payload ?? {});
  if (!timingSafeEqualStrings(event.payload_digest, payloadDigest)) {
    fail(
      PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID,
      `payload_digest mismatch at sequence ${expectedSequence}`,
    );
  }
  if (event.journal_sequence !== expectedSequence) {
    fail(
      PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID,
      `sequence gap/duplicate: expected ${expectedSequence}, got ${String(event.journal_sequence)}`,
    );
  }
  const expectedPreviousDigest = previousDigest ?? GENESIS_DIGEST;
  if (!timingSafeEqualStrings(event.previous_digest, expectedPreviousDigest)) {
    fail(
      PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID,
      `previous_digest mismatch at sequence ${expectedSequence}`,
    );
  }
  const recomputedEventDigest = computeEventDigest({
    journal_sequence: event.journal_sequence,
    event_id: event.event_id,
    event_type: event.event_type,
    payload_digest: event.payload_digest,
    previous_digest: event.previous_digest,
  });
  if (!timingSafeEqualStrings(event.event_digest, recomputedEventDigest)) {
    fail(
      PROJECTION_CODES.PROJECTION_EVENT_DIGEST_INVALID,
      `event_digest mismatch at sequence ${expectedSequence}`,
    );
  }
  assertHex64Field(event.event_id, "event_id");
  assertHex64Field(event.idempotency_key, "idempotency_key");
  assertHex64Field(event.payload_digest, "payload_digest");
}

// ---------------------------------------------------------------------------
// Projection build
// ---------------------------------------------------------------------------

function snapshotFileList(snapshot) {
  const files = snapshot?.files;
  if (!Array.isArray(files) || files.length === 0) {
    fail(PROJECTION_CODES.PROJECTION_INPUT_MISSING, "snapshot has no captured log files");
  }
  const bytes = snapshot?.bytes;
  if (!Array.isArray(bytes) || bytes.length !== files.length) {
    fail(
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
      "snapshot bytes do not match captured files",
    );
  }
  if (snapshot.snapshot_algorithm_version !== 1) {
    fail(
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
      "unsupported snapshot_algorithm_version",
    );
  }
  if (
    snapshot.linearization?.lock_acquired !== true
    || snapshot.linearization?.capture_point !== "EOF_UNDER_WRITER_LOCK"
  ) {
    fail(
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
      "snapshot was not captured under the writer lock",
    );
  }
  if (snapshot.total_bytes > PROJECTION_MAX_INPUT_BYTES) {
    fail(PROJECTION_CODES.PROJECTION_INPUT_TOO_LARGE, "snapshot exceeds max input bytes");
  }
  return { files, bytes };
}

function assertSnapshotDigest(snapshot, rawInputDigest) {
  const expected = sha256Hex(
    canonical(
      snapshot.files.map((file) => ({
        name: file.name,
        byte_length: file.byte_length,
        sha256: file.sha256,
      })),
    ),
  );
  if (!timingSafeEqualStrings(rawInputDigest, expected)) {
    fail(
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
      "snapshot raw_input_digest does not match captured files",
    );
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildProjectionItem(event) {
  const payload = event.payload;
  const projectIdentity = {
    repository_root_identity: event.project_identity.repository_root_identity,
    git_common_dir_identity: event.project_identity.git_common_dir_identity,
  };
  const evidenceRefs = event.evidence_refs
    .map((ref) => ({ kind: ref.kind, identity: ref.identity, digest: ref.digest }))
    .sort((a, b) => {
      const kindCmp = compareCodePoints(a.kind, b.kind);
      if (kindCmp !== 0) return kindCmp;
      const identityCmp = compareCodePoints(a.identity, b.identity);
      if (identityCmp !== 0) return identityCmp;
      return compareCodePoints(a.digest, b.digest);
    });

  const item = {
    projection_item_id: sha256Hex(
      canonical({
        domain: INCIDENT_PROJECTION_ITEM_IDENTITY_DOMAIN,
        projection_schema_version: PROJECTION_SCHEMA_VERSION,
        projection_algorithm_version: PROJECTION_ALGORITHM_VERSION,
        incident_observation_id: event.event_id,
        journal_sequence: event.journal_sequence,
        raw_event_digest: event.event_digest,
      }),
    ),
    incident_observation_id: event.event_id,
    incident_id: event.incident_identity.incident_id,
    source_identity_key: payload.source_identity_key,
    source_system: payload.source_authority_identity,
    source_record_type: payload.source_class,
    source_record_id: payload.source_record_id,
    source_record_digest: payload.source_record_digest,
    evidence_set_digest: payload.evidence_set_digest,
    evidence_refs: evidenceRefs,
    project_identity: projectIdentity,
    worktree_identity: projectIdentity.repository_root_identity,
    task_identity: {
      task_id: event.task_identity.task_id,
      admission_id: event.task_identity.admission_id,
    },
    admission_id: event.task_identity.admission_id,
    attempt_identity: {
      execution_id: event.attempt_identity.execution_id,
      attempt: event.attempt_identity.attempt,
    },
    authority_generation: payload.source_authority_generation,
    revocation_generation: event.revocation_generation,
    recorded_completeness: payload.evidence_completeness_class,
    observed_outcome_class: payload.observed_outcome_class,
    failure_finding_discriminator: payload.failure_finding_discriminator,
    occurred_at: event.occurred_at,
    recorded_at: event.recorded_at,
    raw_append_ordinal: event.journal_sequence,
    raw_event_digest: event.event_digest,
    current_authority_status: CURRENT_AUTHORITY_STATUS_NOT_EVALUATED,
    current_authority_receipt_reference: null,
    current_authority_checked_generation: null,
    redaction_status: {
      scanned: event.redaction_status.scanned,
      truncated: event.redaction_status.truncated,
      secret_hit: event.redaction_status.secret_hit,
    },
  };
  return item;
}

function serializeProjection(envelope) {
  const bytes = Buffer.from(canonical(envelope), "utf8");
  if (bytes.length > PROJECTION_MAX_OUTPUT_BYTES) {
    fail(PROJECTION_CODES.PROJECTION_OUTPUT_TOO_LARGE, "projection exceeds max output bytes");
  }
  return bytes;
}

/**
 * Build the ephemeral incident projection from a `captureRawLogSnapshot`
 * result (or a test-only synthetic snapshot handed to the same entry point).
 * Same captured bytes + same frozen versions → byte-identical projection.
 */
export function buildIncidentProjection(snapshot) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    fail(PROJECTION_CODES.PROJECTION_INPUT_MISSING, "snapshot required");
  }
  // PROJECTION-1R R144: raw_input_digest is read from the caller-supplied
  // snapshot EXACTLY ONCE, verified here, and only the verified local value is
  // used for the envelope. A second property read would let a getter/Proxy
  // desynchronize envelope.input_log_digest from the verified bytes.
  const { files, bytes } = snapshotFileList(snapshot);
  const rawInputDigest = snapshot.raw_input_digest;
  assertSnapshotDigest(snapshot, rawInputDigest);

  const rawSchemaVersions = new Set();
  const items = [];
  const seenEventIds = new Set();
  const idempotencyPayloadDigests = new Map();
  let expectedSequence = 1;
  let previousDigest = GENESIS_DIGEST;
  let lastGeneration = null;
  let firstEventDigest = null;
  let finalEventDigest = null;
  let incidentEventCount = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const fileBytes = bytes[fileIndex];
    if (fileBytes.length !== file.byte_length) {
      fail(
        PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
        `captured byte length mismatch for ${file.name}`,
      );
    }
    if (!timingSafeEqualStrings(sha256Bytes(fileBytes), file.sha256)) {
      fail(
        PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
        `captured bytes do not match digest for ${file.name}`,
      );
    }
    const isActive = fileIndex === files.length - 1;
    const { lines } = parseFileLines(file, fileBytes, { isActive });
    if (lines.length === 0) continue;

    // Root chain order: GEN-1 files may precede GEN-2 files (rotation
    // order); a GEN-1 file after a GEN-2 file fails closed.
    const fileGeneration = parseHeaderLine(lines[0]);
    if (fileGeneration === 1 && lastGeneration === 2) {
      fail(PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID, "GEN-1 file after GEN-2 file in root chain");
    }
    if (fileGeneration != null) lastGeneration = fileGeneration;
    for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.length === 0) {
        fail(PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID, "empty line in captured log");
      }
      if (Buffer.byteLength(line, "utf8") > PROJECTION_MAX_LINE_BYTES) {
        fail(PROJECTION_CODES.PROJECTION_LINE_TOO_LARGE, "captured log line too large");
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        fail(PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID, "captured log line is not valid JSON");
      }
      // Canonical re-serialization must reproduce the stored line byte-for-byte.
      if (canonical(event) !== line) {
        fail(
          PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID,
          "captured log line is not canonical JSON",
        );
      }

      validateDurableRecord({
        event,
        expectedSequence,
        previousDigest,
        generation: fileGeneration,
      });

      if (seenEventIds.has(event.event_id)) {
        fail(
          PROJECTION_CODES.PROJECTION_IDENTITY_CONFLICT,
          `duplicate event_id in captured log: ${event.event_id}`,
        );
      }
      seenEventIds.add(event.event_id);

      const priorPayloadDigest = idempotencyPayloadDigests.get(event.idempotency_key);
      if (priorPayloadDigest && priorPayloadDigest !== event.payload_digest) {
        fail(
          PROJECTION_CODES.PROJECTION_IDENTITY_CONFLICT,
          "idempotency key collision in captured log",
        );
      }
      idempotencyPayloadDigests.set(event.idempotency_key, event.payload_digest);

      rawSchemaVersions.add(event.schema_version);
      if (firstEventDigest === null) firstEventDigest = event.event_digest;
      finalEventDigest = event.event_digest;
      if (expectedSequence > PROJECTION_MAX_INPUT_EVENTS) {
        fail(PROJECTION_CODES.PROJECTION_EVENT_LIMIT_EXCEEDED, "captured log exceeds max events");
      }
      if (event.event_type === "INCIDENT_OBSERVED") {
        items.push(buildProjectionItem(event));
        incidentEventCount += 1;
      }

      expectedSequence += 1;
      previousDigest = event.event_digest;
    }
  }

  if (items.length !== incidentEventCount) {
    fail(
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
      "projection cardinality mismatch",
    );
  }
  if (items.length > 0) {
    const serialized = Buffer.from(canonical({ items }), "utf8");
    if (serialized.length > PROJECTION_MAX_OUTPUT_BYTES) {
      fail(PROJECTION_CODES.PROJECTION_OUTPUT_TOO_LARGE, "projection exceeds max output bytes");
    }
  }

  // Canonical order: raw_append_ordinal DESC → event_id code-point ASC.
  const orderedItems = items.sort((a, b) => {
    const ordinalCmp = b.raw_append_ordinal - a.raw_append_ordinal;
    if (ordinalCmp !== 0) return ordinalCmp;
    return compareCodePoints(a.incident_observation_id, b.incident_observation_id);
  });

  const envelope = {
    projection_schema_version: PROJECTION_SCHEMA_VERSION,
    projection_algorithm_version: PROJECTION_ALGORITHM_VERSION,
    raw_schema_versions: [...rawSchemaVersions].sort(compareCodePoints),
    input_log_digest: rawInputDigest,
    input_first_event_digest: firstEventDigest,
    input_final_event_digest: finalEventDigest,
    input_byte_range: files.map((file) => ({
      name: file.name,
      byte_offset: file.byte_offset,
      byte_length: file.byte_length,
    })),
    input_event_count: expectedSequence - 1,
    incident_event_count: incidentEventCount,
    projection_item_count: orderedItems.length,
    query_policy_version: QUERY_POLICY_VERSION,
    current_authority_policy_version: CURRENT_AUTHORITY_POLICY_VERSION,
    items: orderedItems,
    projection_digest: null,
  };

  // DATA MINIMIZATION: the serialized projection body is re-scanned for secret
  // patterns before it can leave the build (freeze §13).
  const scanBody = canonical(envelope);
  const scan = scanTransferPayload(scanBody);
  if (!scan.safe) {
    fail(PROJECTION_CODES.PROJECTION_SECRET_REJECTED, "projection output contains secret patterns");
  }

  // SELF-EXCLUSION: the digest's own preimage carries a null projection_digest.
  envelope.projection_digest = sha256Hex(canonical(envelope));
  const canonicalBytes = serializeProjection(envelope);

  return {
    envelope,
    canonical_bytes: canonicalBytes,
    input_log_digest: envelope.input_log_digest,
    projection_digest: envelope.projection_digest,
  };
}

// ---------------------------------------------------------------------------
// Bounded read-only query
// ---------------------------------------------------------------------------

function normalizeFilters(filters) {
  if (filters === undefined || filters === null) return {};
  const isolated = isolateCallerEvent(filters, "filters");
  if (typeof isolated !== "object" || Array.isArray(isolated) || isolated === null) {
    fail(PROJECTION_CODES.PROJECTION_FILTER_INVALID, "filters must be an object");
  }
  const normalized = {};
  for (const [name, rawValue] of Object.entries(isolated)) {
    if (!PROJECTION_FILTER_ALLOWLIST.includes(name)) {
      fail(PROJECTION_CODES.PROJECTION_FILTER_INVALID, `unknown filter ${name}`);
    }
    if (name in RANGE_FILTER_KEYS) {
      normalized[name] = normalizeRangeFilter(name, rawValue);
      continue;
    }
    if (name === CURRENT_STATUS_FILTER) {
      if (rawValue !== CURRENT_AUTHORITY_STATUS_NOT_EVALUATED) {
        fail(
          PROJECTION_CODES.PROJECTION_FILTER_INVALID,
          `${name} only accepts ${CURRENT_AUTHORITY_STATUS_NOT_EVALUATED} in this policy version`,
        );
      }
      normalized[name] = rawValue;
      continue;
    }
    let values;
    if (Array.isArray(rawValue)) {
      if (rawValue.length === 0) {
        fail(PROJECTION_CODES.PROJECTION_FILTER_INVALID, `${name} has no values`);
      }
      if (rawValue.length > PROJECTION_MAX_FILTER_VALUES) {
        fail(
          PROJECTION_CODES.PROJECTION_FILTER_INVALID,
          `${name} exceeds ${PROJECTION_MAX_FILTER_VALUES} values`,
        );
      }
      values = rawValue;
    } else {
      values = [rawValue];
    }
    for (const value of values) {
      assertFilterScalar(name, value);
    }
    // PROJECTION-1R R154: freeze §9 — an UNKNOWN ENUM VALUE in a closed-enum
    // filter is PROJECTION_FILTER_INVALID (REJECT, never an empty-result match).
    const enumValues = ENUM_FILTER_VALUES[name];
    if (enumValues) {
      for (const value of values) {
        if (!enumValues.includes(value)) {
          fail(PROJECTION_CODES.PROJECTION_FILTER_INVALID, `${name} unknown enum value ${String(value)}`);
        }
      }
    }
    const unique = [...new Set(values.map((value) => canonicalFilterValue(value)))];
    unique.sort(compareCodePoints);
    normalized[name] = unique.length === 1 ? unique[0] : unique;
  }
  return normalized;
}

// Closed-enum filters (freeze §9): every value must be a member of the frozen
// enum; unknown values are PROJECTION_FILTER_INVALID, never a silent empty set.
const ENUM_FILTER_VALUES = Object.freeze({
  recorded_completeness: INCIDENT_COMPLETENESS_WRITE_CLASSES,
  observed_outcome_class: INCIDENT_OBSERVED_OUTCOME_CLASSES,
  source_record_type: INCIDENT_SOURCE_CLASSES,
});


function assertFilterScalar(name, value) {
  if (name === "attempt_number" || name === RAW_APPEND_ORDINAL_FILTER) {
    if (!Number.isInteger(value) || value < 0) {
      fail(PROJECTION_CODES.PROJECTION_FILTER_INVALID, `${name} must be a non-negative integer`);
    }
    return;
  }
  if (name === OCCURRED_AT_FILTER || name === RECORDED_AT_FILTER) {
    // PROJECTION-1R R155: format-regex alone admits calendar-invalid strings
    // ("2026-13-45T99:00:00Z"); Date.parse then yields NaN whose comparisons
    // silently match every item. Calendar validity is part of the freeze's
    // "invalid date rejected" rule -> PROJECTION_FILTER_INVALID.
    if (typeof value !== "string" || !ISO_UTC_RE.test(value) || !Number.isFinite(Date.parse(value))) {
      fail(PROJECTION_CODES.PROJECTION_FILTER_INVALID, `${name} must be ISO-8601 UTC`);
    }
    return;
  }
  if (typeof value !== "string" || value.length === 0) {
    fail(PROJECTION_CODES.PROJECTION_FILTER_INVALID, `${name} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > PROJECTION_MAX_STRING_FIELD_BYTES) {
    fail(PROJECTION_CODES.PROJECTION_FILTER_INVALID, `${name} exceeds max bytes`);
  }
}

function canonicalFilterValue(value) {
  return typeof value === "string" ? value : canonical(value);
}

function normalizeRangeFilter(name, rawValue) {
  if (rawValue === null || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    fail(PROJECTION_CODES.PROJECTION_FILTER_INVALID, `${name} must be a range object`);
  }
  const isolated = isolateCallerEvent(rawValue, `${name} range`);
  const allowedKeys = RANGE_FILTER_KEYS[name];
  for (const key of Object.keys(isolated)) {
    if (!allowedKeys.includes(key)) {
      fail(
        PROJECTION_CODES.PROJECTION_FILTER_INVALID,
        `${name} range has unknown bound ${key}`,
      );
    }
  }
  const range = {};
  for (const key of allowedKeys) {
    if (isolated[key] === undefined) continue;
    assertFilterScalar(name, isolated[key]);
    range[key] = isolated[key];
  }
  if (allowedKeys.includes("min") && range.min !== undefined && range.max !== undefined
    && range.min > range.max) {
    fail(PROJECTION_CODES.PROJECTION_FILTER_INVALID, `${name} range min is greater than max`);
  }
  if (allowedKeys.includes("start") && range.start !== undefined && range.end !== undefined
    && Date.parse(range.start) > Date.parse(range.end)) {
    fail(PROJECTION_CODES.PROJECTION_FILTER_INVALID, `${name} range start is after end`);
  }
  return range;
}

function itemMatchesFilters(item, filters) {
  for (const [name, expected] of Object.entries(filters)) {
    const actual = filterValueForItem(item, name);
    const candidates = Array.isArray(expected) ? expected : [expected];
    if (!candidates.some((candidate) => rangeOrScalarMatches(name, candidate, actual))) {
      return false;
    }
  }
  return true;
}

function filterValueForItem(item, name) {
  switch (name) {
    case "project_repository_root_identity":
      return item.project_identity.repository_root_identity;
    case "project_git_common_dir_identity":
      return item.project_identity.git_common_dir_identity;
    case "task_id":
      return item.task_identity.task_id;
    case "admission_id":
      return item.admission_id;
    case "attempt_execution_id":
      return item.attempt_identity.execution_id;
    case "attempt_number":
      return item.attempt_identity.attempt;
    case "incident_observation_id":
      return item.incident_observation_id;
    default:
      return item[name];
  }
}

function rangeOrScalarMatches(name, expected, actual) {
  if (name in RANGE_FILTER_KEYS) {
    if (actual === undefined || actual === null) return false;
    if (name === RAW_APPEND_ORDINAL_FILTER) {
      if (expected.min !== undefined && actual < expected.min) return false;
      if (expected.max !== undefined && actual > expected.max) return false;
      return true;
    }
    const actualMs = Date.parse(actual);
    if (!Number.isFinite(actualMs)) return false;
    if (expected.start !== undefined && actualMs < Date.parse(expected.start)) return false;
    if (expected.end !== undefined && actualMs > Date.parse(expected.end)) return false;
    return true;
  }
  return actual === expected;
}

function resolveLimit(limit) {
  // OMITTED limit (property absent / undefined) -> DEFAULT_LIMIT (freeze §9).
  // An explicitly passed null is NOT omitted: it is a non-integer explicit
  // value and must fail closed (PROJECTION-1R R156; card Phase 21 "null rejected").
  if (limit === undefined) return PROJECTION_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > PROJECTION_MAX_LIMIT) {
    fail(PROJECTION_CODES.PROJECTION_LIMIT_INVALID, "limit must be an integer between 1 and 500");
  }
  return limit;
}

function encodeCursorToken(cursor) {
  const token = Buffer.from(canonical(cursor), "utf8").toString("base64url");
  if (token.length > PROJECTION_MAX_CURSOR_BYTES) {
    fail(PROJECTION_CODES.PROJECTION_CURSOR_INVALID, "cursor exceeds max bytes");
  }
  return token;
}

function decodeCursorToken(token) {
  if (typeof token !== "string" || token.length === 0) {
    fail(PROJECTION_CODES.PROJECTION_CURSOR_INVALID, "cursor required");
  }
  if (token.length > PROJECTION_MAX_CURSOR_BYTES) {
    fail(PROJECTION_CODES.PROJECTION_CURSOR_INVALID, "cursor exceeds max bytes");
  }
  let decoded;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    fail(PROJECTION_CODES.PROJECTION_CURSOR_INVALID, "cursor is not valid base64url");
  }
  let cursor;
  try {
    cursor = JSON.parse(decoded);
  } catch {
    fail(PROJECTION_CODES.PROJECTION_CURSOR_INVALID, "cursor is not valid JSON");
  }
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
    fail(PROJECTION_CODES.PROJECTION_CURSOR_INVALID, "cursor must be an object");
  }
  // Own-data parsing only: reject getters/prototypes/extra fields.
  const isolated = isolateCallerEvent(cursor, "cursor");
  assertExactKeys(isolated, CURSOR_FIELDS, "cursor");
  return isolated;
}

function normalizedFiltersDigest(normalizedFilters) {
  return sha256Hex(canonical(normalizedFilters));
}

/**
 * Encode a stateless, input-digest-bound cursor.
 */
export function encodeProjectionCursor({
  input_log_digest,
  filters = {},
  last_raw_append_ordinal,
  last_event_id,
}) {
  const normalized = normalizeFilters(filters);
  return encodeCursorToken({
    cv: PROJECTION_SCHEMA_VERSION,
    av: PROJECTION_ALGORITHM_VERSION,
    ld: input_log_digest,
    qp: QUERY_POLICY_VERSION,
    fd: normalizedFiltersDigest(normalized),
    sd: "DESC",
    lo: last_raw_append_ordinal,
    le: last_event_id,
  });
}

function parseCursor({ cursor, inputLogDigest, normalizedFilters }) {
  const decoded = decodeCursorToken(cursor);
  if (
    decoded.cv !== PROJECTION_SCHEMA_VERSION
    || decoded.av !== PROJECTION_ALGORITHM_VERSION
    || decoded.qp !== QUERY_POLICY_VERSION
    || decoded.sd !== "DESC"
  ) {
    fail(PROJECTION_CODES.PROJECTION_CURSOR_INVALID, "cursor policy mismatch");
  }
  if (!isHex64(decoded.ld) || !isHex64(decoded.fd) || !isHex64(decoded.le)) {
    fail(PROJECTION_CODES.PROJECTION_CURSOR_INVALID, "cursor fields are malformed");
  }
  if (!Number.isInteger(decoded.lo) || decoded.lo < 0) {
    fail(PROJECTION_CODES.PROJECTION_CURSOR_INVALID, "cursor ordinal is malformed");
  }
  if (decoded.ld !== inputLogDigest) {
    fail(PROJECTION_CODES.PROJECTION_CURSOR_STALE, "cursor belongs to a different snapshot");
  }
  if (decoded.fd !== normalizedFiltersDigest(normalizedFilters)) {
    fail(PROJECTION_CODES.PROJECTION_CURSOR_INVALID, "cursor filters do not match query filters");
  }
  return decoded;
}

/**
 * Read-only, bounded, exact-match query over an already built projection.
 * Stateless: every call re-filters and re-sorts the full bounded item array.
 */
export function queryIncidentProjection(projection, {
  filters = {},
  limit = undefined,
  cursor = undefined,
} = {}) {
  const normalizedFilters = normalizeFilters(filters);
  const resolvedLimit = resolveLimit(limit);

  let startOrdinal = null;
  let startEventId = null;
  if (cursor !== undefined && cursor !== null) {
    const parsed = parseCursor({
      cursor,
      inputLogDigest: projection.input_log_digest,
      normalizedFilters,
    });
    startOrdinal = parsed.lo;
    startEventId = parsed.le;
  }

  const envelope = projection.envelope ?? projection;
  const allItems = envelope.items;
  if (!Array.isArray(allItems)) {
    fail(PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION, "projection has no items");
  }

  const matching = allItems.filter((item) => itemMatchesFilters(item, normalizedFilters));
  let startIndex = 0;
  if (startOrdinal !== null) {
    startIndex = matching.findIndex(
      (item) => item.raw_append_ordinal === startOrdinal
        && item.incident_observation_id === startEventId,
    );
    if (startIndex === -1) {
      fail(
        PROJECTION_CODES.PROJECTION_CURSOR_INVALID,
        "cursor position is not present in this projection",
      );
    }
    startIndex += 1;
  }

  const page = matching.slice(startIndex, startIndex + resolvedLimit);
  if (Buffer.byteLength(canonical({ items: page }), "utf8") > PROJECTION_MAX_OUTPUT_BYTES) {
    fail(PROJECTION_CODES.PROJECTION_OUTPUT_TOO_LARGE, "query result exceeds max output bytes");
  }

  const lastItem = page.length > 0 ? page[page.length - 1] : null;
  const nextCursor = lastItem === null
    ? null
    : encodeCursorToken({
      cv: PROJECTION_SCHEMA_VERSION,
      av: PROJECTION_ALGORITHM_VERSION,
      ld: projection.input_log_digest,
      qp: QUERY_POLICY_VERSION,
      fd: normalizedFiltersDigest(normalizedFilters),
      sd: "DESC",
      lo: lastItem.raw_append_ordinal,
      le: lastItem.incident_observation_id,
    });

  return {
    items: page,
    next_cursor: nextCursor,
    has_more: startIndex + page.length < matching.length,
    total_matching: matching.length,
  };
}
