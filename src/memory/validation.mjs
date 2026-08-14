// src/memory/validation.mjs
//
// CBM-2 — Memory Contract v1: structured validators.
//
// Every validator returns a STRUCTURED result（never an unclassified throw）:
//   { valid, errors, warnings, derivedIdentity?, securityFindings? }
// error codes follow the contract（§13）:
//   SCHEMA_INVALID, IDENTITY_MISMATCH, CANONICALIZATION_FAILED,
//   TRUST_TRANSITION_INVALID, VALIDITY_SCOPE_INVALID, EVIDENCE_MISSING,
//   SECRET_DETECTED, PATH_NOT_ALLOWED, JOURNAL_CHAIN_INVALID,
//   MIGRATION_INVALID, CONFLICT_UNREPRESENTED

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { scanForSecrets, sha256Text, truncateFreeText, DEFAULT_MAX_FREE_TEXT_BYTES } from "../evidence/run-evidence-store.mjs";
import { recursiveCanonicalJson, contentHash, CanonicalizationError } from "./canonical.mjs";
import {
  MEMORY_RECORD_SCHEMA,
  MEMORY_JOURNAL_EVENT_SCHEMA,
  RECORD_TYPES,
  TRUST_STATES,
  TRUST_RANK,
  VALIDITY_STATUSES,
  LIFECYCLE_EVENT_TYPES,
  SCOPES,
  SOURCES,
  RELATIONSHIP_TYPES,
  KNOWLEDGE_KINDS,
  RESULT_KINDS,
  DECISION_TYPES,
  DECISION_STATUSES,
  AUTHORITIES,
  CONTENT_KINDS,
  NOT_APPLICABLE,
  NOT_APPLICABLE_LEGAL,
  ENVELOPE_FIELDS,
} from "./contract.mjs";
import { specFieldsFor } from "./schema.mjs";
import { deriveMemoryRecordId, deriveLogicalKey, deriveContentHash } from "./identity.mjs";

export const MEMORY_ERRORS = Object.freeze({
  SCHEMA_INVALID: "SCHEMA_INVALID",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  CANONICALIZATION_FAILED: "CANONICALIZATION_FAILED",
  TRUST_TRANSITION_INVALID: "TRUST_TRANSITION_INVALID",
  VALIDITY_SCOPE_INVALID: "VALIDITY_SCOPE_INVALID",
  EVIDENCE_MISSING: "EVIDENCE_MISSING",
  SECRET_DETECTED: "SECRET_DETECTED",
  PATH_NOT_ALLOWED: "PATH_NOT_ALLOWED",
  JOURNAL_CHAIN_INVALID: "JOURNAL_CHAIN_INVALID",
  MIGRATION_INVALID: "MIGRATION_INVALID",
  CONFLICT_UNREPRESENTED: "CONFLICT_UNREPRESENTED",
});

const HEX64 = /^[0-9a-f]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function isRfc3339Utc(s) {
  if (typeof s !== "string" || !RFC3339.test(s)) return false;
  return !Number.isNaN(new Date(s).getTime());
}

function ok(extra = {}) {
  return { valid: true, errors: [], warnings: [], securityFindings: [], ...extra };
}

function fail(errors, extra = {}) {
  return { valid: false, errors: [...errors], warnings: [], securityFindings: [], ...extra };
}

function walkPaths(value, path = "", out = []) {
  if (value === NOT_APPLICABLE) out.push(path);
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walkPaths(v, `${path}[${i}]`, out));
    } else {
      for (const k of Object.keys(value)) walkPaths(value[k], path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

// ---------------------------------------------------------------------------
// validateMemoryRecordV1
// ---------------------------------------------------------------------------

/**
 * Validate a MemoryRecordV1 envelope. Recomputes recordId / contentHash /
 * logicalKey and returns them as `derivedIdentity`. Never trusts writer
 * claims: recordId must equal the derived identity, contentHash must equal
 * the content digest, schema/type/trust/validity must be fixed enums.
 */
export function validateMemoryRecordV1(record, { authorizedDirs = [] } = {}) {
  const errors = [];
  const warnings = [];
  const securityFindings = [];

  if (!isPlainObject(record)) return fail([`${MEMORY_ERRORS.SCHEMA_INVALID}:record_not_object`]);
  if (record.schema !== MEMORY_RECORD_SCHEMA) {
    return fail([`${MEMORY_ERRORS.SCHEMA_INVALID}:unknown_schema:${String(record.schema)}`]);
  }
  for (const k of Object.keys(record)) {
    if (!ENVELOPE_FIELDS.includes(k)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:unknown_envelope_field:${k}`);
  }
  if (!RECORD_TYPES.includes(record.recordType)) {
    errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:recordType_invalid:${String(record.recordType)}`);
    return fail(errors);
  }
  const type = record.recordType;
  const spec = specFieldsFor(type);
  if (!spec) return fail([`${MEMORY_ERRORS.SCHEMA_INVALID}:no_schema_for_type:${type}`]);

  // required sub-objects
  for (const sub of ["identity", "subject", "content", "source", "scope", "validity", "lifecycle", "timestamps", "evidence", "security", "metadata"]) {
    if (!isPlainObject(record[sub])) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:${sub}_must_be_object`);
  }
  if (errors.length) return fail(errors);

  // per-type required fields（dot paths）
  const requiredPaths = [
    ...spec.identity.required.map((f) => `identity.${f}`),
    ...spec.subject.required.map((f) => `subject.${f}`),
    ...spec.content.required.map((f) => `content.${f}`),
  ];
  for (const p of requiredPaths) {
    const parts = p.split(".");
    let cur = record;
    for (const part of parts) {
      cur = cur?.[part];
    }
    if (cur === undefined || cur === null || cur === "") {
      errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:missing_required:${p}`);
    }
  }
  // optional fields must be objects/arrays/strings as declared（basic type guard）
  for (const p of spec.identity.optional) {
    const parts = p.split(".");
    let cur = record;
    for (const part of parts) cur = cur?.[part];
    if (cur === undefined) continue; // optional absent is fine
    if (cur !== NOT_APPLICABLE && typeof cur !== "string" && typeof cur !== "number" && !Array.isArray(cur)) {
      errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:optional_field_type:${p}`);
    }
  }

  // NOT_APPLICABLE only in declared-legal fields
  const legalSet = new Set(NOT_APPLICABLE_LEGAL[type] ?? []);
  for (const p of walkPaths(record)) {
    if (!legalSet.has(p)) {
      errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:not_applicable_not_legal:${p}`);
    }
  }

  // fixed enums
  if (!TRUST_STATES.includes(record.trust)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:trust_invalid:${String(record.trust)}`);
  if (!VALIDITY_STATUSES.includes(record.validity?.status)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:validity_status_invalid:${String(record.validity?.status)}`);
  if (!SOURCES.includes(record.source?.source)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:source_invalid:${String(record.source?.source)}`);
  if (!CONTENT_KINDS.includes(record.content?.kind)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:content_kind_invalid:${String(record.content?.kind)}`);

  // per-type sub-enums
  if (type === "CODE") {
    if (!KNOWLEDGE_KINDS.includes(record.identity?.knowledgeKind)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:knowledgeKind_invalid:${String(record.identity?.knowledgeKind)}`);
  }
  if (type === "EXECUTION") {
    if (!RESULT_KINDS.includes(record.subject?.resultKind)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:resultKind_invalid:${String(record.subject?.resultKind)}`);
    if (record.identity?.graphRunId === NOT_APPLICABLE || !record.identity?.graphRunId) {
      errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:execution_requires_graphRunId`);
    }
  }
  if (type === "DECISION") {
    if (!DECISION_TYPES.includes(record.identity?.decisionType)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:decisionType_invalid:${String(record.identity?.decisionType)}`);
    if (!DECISION_STATUSES.includes(record.subject?.status)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:decision_status_invalid:${String(record.subject?.status)}`);
    if (!AUTHORITIES.includes(record.subject?.authority)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:decision_authority_invalid:${String(record.subject?.authority)}`);
  }

  // timestamps RFC3339
  for (const t of ["createdAt", "updatedAt"]) {
    if (!isRfc3339Utc(record.timestamps?.[t])) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:timestamp_invalid:${t}`);
  }

  // validity.scope consistency: a tree-bound record must carry validityTree
  const scopeTree = record.scope?.tree;
  if (scopeTree && scopeTree !== NOT_APPLICABLE && !record.validity?.validityTree) {
    errors.push(`${MEMORY_ERRORS.VALIDITY_SCOPE_INVALID}:tree_bound_without_validityTree`);
  }

  // scope keys must be from SCOPES（no arbitrary scope semantics）
  if (record.scope) {
    for (const k of Object.keys(record.scope)) {
      if (!SCOPES.includes(k)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:unknown_scope_key:${k}`);
    }
  }

  // ── identity（recomputed, never trusted）──────────────────────────────
  let derivedIdentity = null;
  try {
    const derivedId = deriveMemoryRecordId(record);
    const logicalKey = deriveLogicalKey(record);
    const derivedContentHash = deriveContentHash(record.content);
    derivedIdentity = { recordId: derivedId, logicalKey, contentHash: derivedContentHash };
    if (record.recordId !== derivedId) errors.push(`${MEMORY_ERRORS.IDENTITY_MISMATCH}:recordId`);
    if (!HEX64.test(String(record.recordId))) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:recordId_not_hex`);
    const subjectHash = record.subject?.contentHash;
    if (subjectHash !== derivedContentHash) errors.push(`${MEMORY_ERRORS.IDENTITY_MISMATCH}:contentHash`);
    if (!HEX64.test(String(subjectHash))) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:contentHash_not_hex`);
  } catch (e) {
    if (e instanceof CanonicalizationError) {
      errors.push(`${MEMORY_ERRORS.CANONICALIZATION_FAILED}:${e.message}`);
    } else {
      errors.push(`${MEMORY_ERRORS.CANONICALIZATION_FAILED}:${String(e?.message ?? e)}`);
    }
  }

  // ── trust-gated source identity ────────────────────────────────────────
  if (TRUST_RANK[record.trust] >= TRUST_RANK.UNVERIFIED && !record.source?.identity) {
    errors.push(`${MEMORY_ERRORS.EVIDENCE_MISSING}:non_raw_without_source_identity`);
  }

  // ── evidence（manifest / items / trust-gated identities）───────────────
  const evidence = record.evidence ?? {};
  if (TRUST_RANK[record.trust] >= TRUST_RANK.UNVERIFIED && !HEX64.test(String(evidence.manifestDigest ?? ""))) {
    errors.push(`${MEMORY_ERRORS.EVIDENCE_MISSING}:manifest_digest_required`);
  }
  if (TRUST_RANK[record.trust] >= TRUST_RANK.VERIFIED && !HEX64.test(String(evidence.verifierResultIdentity ?? ""))) {
    errors.push(`${MEMORY_ERRORS.EVIDENCE_MISSING}:verifier_result_identity_required`);
  }
  if (TRUST_RANK[record.trust] >= TRUST_RANK.REVIEWED && !HEX64.test(String(evidence.reviewResultIdentity ?? ""))) {
    errors.push(`${MEMORY_ERRORS.EVIDENCE_MISSING}:review_result_identity_required`);
  }
  if (TRUST_RANK[record.trust] >= TRUST_RANK.CONFIRMED && !HEX64.test(String(evidence.controllerRulingIdentity ?? ""))) {
    errors.push(`${MEMORY_ERRORS.EVIDENCE_MISSING}:controller_ruling_identity_required`);
  }
  if (!Array.isArray(evidence.items)) {
    if (TRUST_RANK[record.trust] >= TRUST_RANK.VERIFIED) errors.push(`${MEMORY_ERRORS.EVIDENCE_MISSING}:evidence_items_required`);
  } else {
    for (const [i, item] of evidence.items.entries()) {
      const base = `evidence.items[${i}]`;
      if (!isPlainObject(item) || typeof item.path !== "string" || !HEX64.test(String(item.sha256 ?? ""))) {
        errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:${base}_malformed`);
        continue;
      }
      const v = validateEvidencePath(item.path, { authorizedDirs });
      if (!v.ok) errors.push(`${MEMORY_ERRORS.PATH_NOT_ALLOWED}:${base}:${v.reason}`);
      else {
        const actual = fileSha256(item.path);
        if (actual !== item.sha256) errors.push(`${MEMORY_ERRORS.IDENTITY_MISMATCH}:${base}_hash`);
      }
    }
  }

  // ── lifecycle events ──────────────────────────────────────────────────
  if (!Array.isArray(record.lifecycle?.events)) {
    errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:lifecycle_events_required`);
  } else {
    for (const [i, ev] of record.lifecycle.events.entries()) {
      const r = validateLifecycleEvent(ev);
      if (!r.valid) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:lifecycle.events[${i}]:${r.errors.join(";")}`);
    }
  }

  // ── security: secret scan on RAW string fields（never the JSON-escaped
  // form — escaping would break quote-sensitive patterns like env_key_assignment）──
  try {
    const scan = scanFreeTextFields({ content: record.content, subject: record.subject, metadata: record.metadata });
    if (!scan.safe) {
      securityFindings.push(...scan.matches);
      errors.push(`${MEMORY_ERRORS.SECRET_DETECTED}:${scan.matches.join(",")}`);
    }
  } catch (e) {
    errors.push(`${MEMORY_ERRORS.CANONICALIZATION_FAILED}:scan:${String(e?.message ?? e)}`);
  }

  // ── bounded free text ─────────────────────────────────────────────────
  if (typeof record.content?.text === "string") {
    const t = truncateFreeText(record.content.text);
    if (t.truncated) {
      warnings.push(`content.text_truncated:${t.original_bytes}>${t.max_bytes}`);
    }
  }
  if (typeof record.subject?.statement === "string") {
    const t = truncateFreeText(record.subject.statement, { maxBytes: 16 * 1024 });
    if (t.truncated) warnings.push(`subject.statement_truncated:${t.original_bytes}>${t.max_bytes}`);
  }

  if (errors.length) return fail(errors, { derivedIdentity, securityFindings, warnings });
  return ok({ derivedIdentity, securityFindings, warnings });
}

export function fileSha256(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/**
 * Scan every raw string field in an object tree（never the JSON-escaped
 * serialization — escaping breaks quote-sensitive secret patterns）.
 */
export function scanFreeTextFields(value) {
  const strings = [];
  const walk = (v) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  const matches = [];
  for (const s of strings) {
    const r = scanForSecrets(s);
    if (!r.safe) for (const m of r.matches) if (!matches.includes(m)) matches.push(m);
  }
  return { safe: matches.length === 0, matches };
}

/**
 * Evidence path safety: must be a regular file（no symlink）, inside an
 * authorized dir（no path escape）, resolvable, readable.
 */
export function validateEvidencePath(path, { authorizedDirs = [] } = {}) {
  if (typeof path !== "string" || path.length === 0) return { ok: false, reason: "empty_path" };
  if (isAbsolute(path) === false && authorizedDirs.length === 0) return { ok: false, reason: "relative_path_without_authorized_dirs" };
  const abs = isAbsolute(path) ? path : resolve(path);
  if (authorizedDirs.length > 0) {
    const inside = authorizedDirs.some((dir) => {
      const root = resolve(dir);
      return abs === root || abs.startsWith(root + "/");
    });
    if (!inside) return { ok: false, reason: "path_outside_authorized_dirs" };
  }
  if (!existsSync(abs)) return { ok: false, reason: "missing" };
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "symlink_not_allowed" };
  if (!st.isFile()) return { ok: false, reason: "not_regular_file" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// validateTrustTransition
// ---------------------------------------------------------------------------

const PROMOTION_CLAIMERS = Object.freeze({
  "system": "SYSTEM_DERIVED",
  "verifier": "VERIFIER",
  "reviewer": "INDEPENDENT_REVIEWER",
  "controller": "CONTROLLER",
});

/**
 * Validate a trust transition. Promotions are evidence-gated:
 *   RAW→UNVERIFIED        : schema/identity/security validation passed（system）
 *   UNVERIFIED→VERIFIED   : verifier PASS + verifier result identity + manifest digest
 *   VERIFIED→REVIEWED     : independent review PASS + empty blocking findings + review identity
 *   REVIEWED→CONFIRMED    : Controller ruling identity
 * Skip-level promotions are forbidden unless `importContract` is explicitly
 * set（Controller import / migration contract）.
 * Writer / repair self-promotion is ALWAYS forbidden.
 * Downgrades are allowed with reason + authority and produce a DOWNGRADED
 * lifecycle event（history preserved — never overwritten）.
 */
export function validateTrustTransition(from, to, {
  evidence = {},
  claimedBy,
  reason = null,
  importContract = false,
  blockingFindings = [],
} = {}) {
  const errors = [];
  const warnings = [];
  if (!TRUST_STATES.includes(from)) errors.push(`${MEMORY_ERRORS.TRUST_TRANSITION_INVALID}:from_invalid:${String(from)}`);
  if (!TRUST_STATES.includes(to)) errors.push(`${MEMORY_ERRORS.TRUST_TRANSITION_INVALID}:to_invalid:${String(to)}`);
  if (errors.length) return fail(errors);

  const rf = TRUST_RANK[from];
  const rt = TRUST_RANK[to];
  if (rt === rf) return ok({ transitionType: "noop", warnings: [...warnings, "no_trust_change"] });

  const isPromotion = rt > rf;

  // writer / repair self-promotion is forbidden（card §4 / CBM-1 rule）
  if (isPromotion && (claimedBy === "writer" || claimedBy === "repair")) {
    errors.push(`${MEMORY_ERRORS.TRUST_TRANSITION_INVALID}:self_promotion_by_${claimedBy}`);
  }

  if (isPromotion) {
    // skip-level guard
    if (rt - rf > 1 && importContract !== true) {
      errors.push(`${MEMORY_ERRORS.TRUST_TRANSITION_INVALID}:skipped_level:${from}->${to}`);
    }
    if (to === "UNVERIFIED") {
      if (evidence.validationPassed !== true) errors.push(`${MEMORY_ERRORS.EVIDENCE_MISSING}:validation_passed_required`);
      if (!["system", "controller"].includes(claimedBy)) errors.push(`${MEMORY_ERRORS.TRUST_TRANSITION_INVALID}:unverified_requires_system_or_controller`);
    }
    if (to === "VERIFIED") {
      if (!/^[0-9a-f]{64}$/.test(String(evidence.verifierResultIdentity ?? ""))) errors.push(`${MEMORY_ERRORS.EVIDENCE_MISSING}:verifier_result_identity`);
      if (!/^[0-9a-f]{64}$/.test(String(evidence.manifestDigest ?? ""))) errors.push(`${MEMORY_ERRORS.EVIDENCE_MISSING}:manifest_digest`);
      if (claimedBy !== "verifier" && claimedBy !== "system" && claimedBy !== "controller") {
        errors.push(`${MEMORY_ERRORS.TRUST_TRANSITION_INVALID}:verified_requires_verifier_evidence`);
      }
    }
    if (to === "REVIEWED") {
      if (!/^[0-9a-f]{64}$/.test(String(evidence.reviewResultIdentity ?? ""))) errors.push(`${MEMORY_ERRORS.EVIDENCE_MISSING}:review_result_identity`);
      if (Array.isArray(blockingFindings) && blockingFindings.length > 0) {
        errors.push(`${MEMORY_ERRORS.TRUST_TRANSITION_INVALID}:reviewed_with_blocking_findings`);
      }
      if (claimedBy !== "reviewer" && claimedBy !== "controller") {
        errors.push(`${MEMORY_ERRORS.TRUST_TRANSITION_INVALID}:reviewed_requires_independent_review`);
      }
    }
    if (to === "CONFIRMED") {
      if (!/^[0-9a-f]{64}$/.test(String(evidence.controllerRulingIdentity ?? ""))) errors.push(`${MEMORY_ERRORS.EVIDENCE_MISSING}:controller_ruling_identity`);
      if (claimedBy !== "controller") errors.push(`${MEMORY_ERRORS.TRUST_TRANSITION_INVALID}:confirmed_requires_controller`);
    }
    if (errors.length) return fail(errors);
    return ok({
      transitionType: "promotion",
      lifecycleEventType: "PROMOTED",
      lifecycleEvent: buildLifecycleEvent({ recordId: evidence.recordId, eventType: "PROMOTED", previousState: from, newState: to, reason: reason ?? `promote ${from}->${to}`, authority: PROMOTION_CLAIMERS[claimedBy] ?? claimedBy, evidenceIdentity: evidence.evidenceIdentity ?? null }),
    });
  }

  // downgrade
  if (!reason) {
    return fail([`${MEMORY_ERRORS.TRUST_TRANSITION_INVALID}:downgrade_requires_reason`]);
  }
  const authority = PROMOTION_CLAIMERS[claimedBy] ?? claimedBy;
  if (!AUTHORITIES.includes(authority) && claimedBy !== "controller") {
    errors.push(`${MEMORY_ERRORS.TRUST_TRANSITION_INVALID}:downgrade_authority_invalid:${String(authority)}`);
    if (errors.length) return fail(errors);
  }
  return ok({
    transitionType: "downgrade",
    lifecycleEventType: "DOWNGRADED",
    lifecycleEvent: buildLifecycleEvent({ recordId: evidence.recordId, eventType: "DOWNGRADED", previousState: from, newState: to, reason, authority, evidenceIdentity: evidence.evidenceIdentity ?? null }),
  });
}

// ---------------------------------------------------------------------------
// evaluateValidity
// ---------------------------------------------------------------------------

/**
 * Evaluate a record's validity against the CURRENT observation context.
 * TOMBSTONED / INVALIDATED stay excluded; STALE is derived from scope
 * baselines（tree / commit / worktree / content hash / dependency versions）.
 * STALE records are never a trusted final answer by themselves.
 */
export function evaluateValidity(record, {
  currentTree = null,
  currentCommit = null,
  currentWorktree = null,
  currentContentHash = null,
  currentDependencyVersions = null,
} = {}) {
  const reasons = [];
  const status = record?.validity?.status;
  if (status === "TOMBSTONED" || status === "INVALIDATED") {
    return { status, applicable: false, excluded: true, reasons: [`already_${status.toLowerCase()}`] };
  }
  if (status === "CONFLICTED") {
    return { status, applicable: false, excluded: true, reasons: ["conflicted_until_resolved"] };
  }
  const scope = record?.scope ?? {};
  const validityTree = record?.validity?.validityTree ?? null;
  if (scope.tree && currentTree && scope.tree !== currentTree) reasons.push("tree_changed");
  if (validityTree && currentTree && validityTree !== currentTree) reasons.push("validity_tree_changed");
  if (scope.commit && currentCommit && scope.commit !== currentCommit) reasons.push("commit_changed");
  if (scope.worktree && currentWorktree && scope.worktree !== currentWorktree) reasons.push("worktree_changed");
  if (scope.content && currentContentHash && record?.subject?.contentHash && record.subject.contentHash !== currentContentHash) {
    reasons.push("content_changed");
  }
  if (currentDependencyVersions && scope.path && record?.subject?.statement && typeof currentDependencyVersions === "object") {
    // dependency-scoped CODE records: caller may pass { "<dep>": "<version>" }
    const depKey = record.subject.statement.slice(0, 40);
    if (typeof currentDependencyVersions[depKey] === "string") reasons.push("dependency_version_changed");
  }
  if (reasons.length) {
    return { status: "STALE", applicable: false, excluded: false, stale: true, reasons };
  }
  return { status: "CURRENT", applicable: true, excluded: false, reasons: [] };
}

// ---------------------------------------------------------------------------
// validateLifecycleEvent
// ---------------------------------------------------------------------------

export function buildLifecycleEvent({ recordId, eventId, eventType, previousState, newState, reason, authority, evidenceIdentity = null, timestamp = new Date().toISOString() }) {
  return {
    eventId: eventId ?? `evt_${sha256Text(JSON.stringify({ recordId, eventType, previousState, newState, timestamp }))}`.slice(0, 24),
    recordId,
    eventType,
    previousState,
    newState,
    reason,
    authority,
    evidenceIdentity: evidenceIdentity ?? NOT_APPLICABLE,
    timestamp,
  };
}

export function validateLifecycleEvent(event) {
  const errors = [];
  if (!isPlainObject(event)) return fail([`${MEMORY_ERRORS.SCHEMA_INVALID}:lifecycle_event_not_object`]);
  for (const k of ["eventId", "recordId", "eventType", "previousState", "newState", "reason", "authority", "evidenceIdentity", "timestamp"]) {
    if (!(k in event)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:lifecycle_missing_${k}`);
  }
  if (!LIFECYCLE_EVENT_TYPES.includes(event.eventType)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:lifecycle_eventType_invalid:${String(event.eventType)}`);
  if (!AUTHORITIES.includes(event.authority)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:lifecycle_authority_invalid:${String(event.authority)}`);
  if (!isRfc3339Utc(event.timestamp)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:lifecycle_timestamp_invalid`);
  if (event.eventType === "PROMOTED" && TRUST_RANK[event.newState] !== undefined && TRUST_RANK[event.previousState] !== undefined) {
    if (TRUST_RANK[event.newState] <= TRUST_RANK[event.previousState]) {
      errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:promoted_not_an_upgrade`);
    }
  }
  if (event.eventType === "DOWNGRADED" && TRUST_RANK[event.newState] !== undefined && TRUST_RANK[event.previousState] !== undefined) {
    if (TRUST_RANK[event.newState] >= TRUST_RANK[event.previousState]) {
      errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:downgraded_not_a_downgrade`);
    }
  }
  if (event.eventType === "DOWNGRADED" && (!event.reason || typeof event.reason !== "string")) {
    errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:downgrade_requires_reason`);
  }
  if (errors.length) return fail(errors);
  return ok();
}

// ---------------------------------------------------------------------------
// validateJournalEvent
// ---------------------------------------------------------------------------

export const JOURNAL_OPERATIONS = Object.freeze([
  "UPSERT_RECORD",
  "LIFECYCLE_EVENT",
  "RELATIONSHIP",
  "CONFLICT",
  "MIGRATION",
]);

/**
 * Validate one journal event against the previous digest and expected
 * sequence（chain integrity）. `eventDigest` is recomputed from the canonical
 * chain payload（never trusted input）.
 */
export function validateJournalEvent(event, { previousDigest, expectedSequence } = {}) {
  const errors = [];
  if (!isPlainObject(event)) return fail([`${MEMORY_ERRORS.JOURNAL_CHAIN_INVALID}:event_not_object`]);
  if (event.schema !== MEMORY_JOURNAL_EVENT_SCHEMA) {
    errors.push(`${MEMORY_ERRORS.JOURNAL_CHAIN_INVALID}:unknown_schema:${String(event.schema)}`);
  }
  for (const k of ["journalSequence", "eventId", "recordId", "operation", "payload", "payloadDigest", "previousDigest", "eventDigest", "timestamp"]) {
    if (!(k in event)) errors.push(`${MEMORY_ERRORS.JOURNAL_CHAIN_INVALID}:missing_${k}`);
  }
  if (expectedSequence !== undefined && event.journalSequence !== expectedSequence) {
    errors.push(`${MEMORY_ERRORS.JOURNAL_CHAIN_INVALID}:sequence_mismatch:expected_${expectedSequence}_got_${String(event.journalSequence)}`);
  }
  if (previousDigest !== undefined && event.previousDigest !== previousDigest) {
    errors.push(`${MEMORY_ERRORS.JOURNAL_CHAIN_INVALID}:previous_digest_mismatch`);
  }
  if (!JOURNAL_OPERATIONS.includes(event.operation)) {
    errors.push(`${MEMORY_ERRORS.JOURNAL_CHAIN_INVALID}:operation_invalid:${String(event.operation)}`);
  }
  try {
    const computedPayloadDigest = sha256Text(recursiveCanonicalJson(event.payload));
    if (computedPayloadDigest !== event.payloadDigest) {
      errors.push(`${MEMORY_ERRORS.JOURNAL_CHAIN_INVALID}:payload_digest_mismatch`);
    }
    const chainPayload = {
      journalSequence: event.journalSequence,
      eventId: event.eventId,
      recordId: event.recordId,
      operation: event.operation,
      payloadDigest: event.payloadDigest,
      previousDigest: event.previousDigest,
    };
    const computedEventDigest = sha256Text(recursiveCanonicalJson(chainPayload));
    if (computedEventDigest !== event.eventDigest) {
      errors.push(`${MEMORY_ERRORS.JOURNAL_CHAIN_INVALID}:event_digest_mismatch`);
    }
  } catch (e) {
    errors.push(`${MEMORY_ERRORS.CANONICALIZATION_FAILED}:journal:${String(e?.message ?? e)}`);
  }
  if (!isRfc3339Utc(event.timestamp)) errors.push(`${MEMORY_ERRORS.SCHEMA_INVALID}:journal_timestamp_invalid`);
  const scan = scanFreeTextFields(event.payload ?? {});
  if (!scan.safe) errors.push(`${MEMORY_ERRORS.SECRET_DETECTED}:journal_payload:${scan.matches.join(",")}`);

  if (errors.length) return fail(errors);
  return ok();
}

export { ok as validResult, fail as invalidResult, isPlainObject };
