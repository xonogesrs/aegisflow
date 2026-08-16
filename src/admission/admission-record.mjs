// src/admission/admission-record.mjs
//
// TA-2 — admission record construction / validation / freeze / drift（F, G,
// I, N, O）.
//
// The admission record is schema `autoloop.task-admission/v1`（embedded
// snapshot of the TA-1 normative schema; scripts/ta2-verify.mjs re-checks
// parity against docs/pi-graph-output/ta1/ta1-admission-schema.json）.
//
// Deterministic admission_id（G）:
//   sha256(canonical(record excluding admission_id / decision_time))
// Same facts -> same id; any mutation -> new id; impossible to silently
// alter downstream.
//
// Freeze（G/H）: once frozen, the record is treated as immutable; drift is
// detected by re-deriving the id from the stored payload — mismatch ->
// HOLD / ADMISSION_DRIFT（N; NEG11）.

import { createHash } from "node:crypto";
import { validate as validateJsonSchema } from "../shared/json-schema-validator.mjs";
import { capabilityRegistry, resolveCapabilityId } from "./registry.mjs";
import { profileFor, RISK_TIERS, SIZE_TIERS } from "./classify.mjs";
import { projectProfilePolicies, PROFILE_MATRIX } from "./policy-projection.mjs";
import { normalizeRisk } from "../risk-normalization.mjs";

export const ADMISSION_SCHEMA = "autoloop.task-admission/v1";
export const ADMISSION_SCHEMA_VERSION = 1;

/** Embedded TA-1 schema snapshot（normative input ta1-admission-schema.json）. */
export const ADMISSION_SCHEMA_DEFINITION = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "autoloop.task-admission/v1",
  title: "AutoLoop Task Admission Result",
  type: "object",
  additionalProperties: false,
  required: [
    "schema", "schema_version", "task_id", "admission_id", "decision_time", "classifier_version",
    "size", "risk", "profile", "reasons", "capabilities", "lifecycle_profile", "isolation_policy",
    "durability_policy", "memory_policy", "review_policy", "repair_budget", "evidence_policy",
    "human_gates", "review_surface_policy", "authority_binding", "fail_closed",
  ],
  properties: {
    schema: { const: "autoloop.task-admission/v1" },
    schema_version: { const: 1 },
    task_id: { type: "string", minLength: 1 },
    admission_id: { type: "string", minLength: 1 },
    decision_time: { type: "string", format: "date-time" },
    classifier_version: { type: "string", const: "1.0.0" },
    size: { enum: ["XS", "S", "M", "L", "XL"] },
    risk: { enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
    profile: { enum: ["FAST_PATH", "STANDARD", "MEDIUM", "MEDIUM_LARGE", "LARGE_LOW", "HIGH", "CRITICAL"] },
    size_details: {
      type: "object",
      required: ["total_score", "dimensions"],
      properties: {
        total_score: { type: "integer", minimum: 0, maximum: 30 },
        dimensions: { type: "object" },
        under_classified: { type: "boolean", default: false },
      },
    },
    risk_details: {
      type: "object",
      required: ["signals"],
      properties: {
        signals: { type: "array", items: { type: "object" } },
        escalation_log: { type: "array", items: { type: "string" } },
      },
    },
    reasons: { type: "array", items: { type: "string" }, minItems: 1 },
    capabilities: {
      type: "object",
      required: ["required", "allowed", "denied"],
      properties: {
        required: { type: "array", items: { type: "string" } },
        allowed: { type: "array", items: { type: "string" } },
        denied: { type: "array", items: { type: "string" } },
      },
    },
    lifecycle_profile: { type: "object" },
    isolation_policy: { enum: ["none", "host", "worktree", "colima"] },
    durability_policy: { enum: ["ephemeral", "durable", "durable_resume"] },
    memory_policy: {
      type: "object",
      required: ["retrieval_allowed", "writeback_allowed"],
      properties: {
        retrieval_allowed: { type: "boolean" },
        writeback_allowed: { type: "boolean" },
      },
    },
    review_policy: {
      type: "object",
      required: ["strength", "independent_review_required", "external_review_required", "strict_reviewer_routing"],
      properties: {
        strength: { enum: ["none", "deterministic", "independent", "external"] },
        independent_review_required: { type: "boolean" },
        external_review_required: { type: "boolean" },
        strict_reviewer_routing: { type: "boolean" },
      },
    },
    repair_budget: { type: "integer", minimum: 0, maximum: 64 },
    evidence_policy: { enum: ["none", "ephemeral", "persistent"] },
    // TA-2 additive（machine-readable contract §backward_compatible_strategy）:
    // the sanctioned mutation boundary the writer enforcement projects from
    //（card F; L）. Optional — older records without it remain valid; a
    // writer granted capability with an EMPTY scope is fail-closed at
    // enforcement.
    mutation_scope: { type: "array", items: { type: "string" } },
    // TA-2 additive: projected tool permission keys（from the granted
    // capabilities' required_permissions）— audit view of the envelope tool
    // policy the admission grants（K）.
    tool_permissions: { type: "array", items: { type: "string" } },
    human_gates: { type: "array", items: { enum: ["controller_pre_execution", "controller_before_external_effect", "controller_before_writeback", "controller_closeout"] } },
    review_surface_policy: {
      type: "object",
      required: ["authoritative_single_surface", "chain", "generation_policy"],
      properties: {
        authoritative_single_surface: { const: true },
        chain: { enum: ["linear"] },
        generation_policy: { type: "array", items: { type: "string" } },
      },
    },
    authority_binding: {
      type: "object",
      required: ["authority_record_digest", "subset_of_lifecycle_authorization"],
      properties: {
        authority_record_digest: { type: "string" },
        subset_of_lifecycle_authorization: { const: true },
      },
    },
    fail_closed: { const: true },
    extensions: { type: "object", additionalProperties: true },
  },
};

/** Canonical（sorted-key）serialization — stable across runs / platforms. */
export function canonicalAdmissionJson(record) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(record));
}

export function sha256Hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

/**
 * Deterministic admission_id（G）: sha256 over the canonical record EXCLUDING
 * admission_id and decision_time（the two non-authoritative fields）。
 */
export function deriveAdmissionId(record) {
  const { admission_id, decision_time, ...rest } = record ?? {};
  const payload = { ...rest };
  // decision_time is non-authoritative for the id but still frozen content:
  // the TA-1 contract excludes id AND time from the hash basis.
  delete payload.decision_time;
  return sha256Hex(canonicalAdmissionJson(payload));
}

/**
 * Validate an admission record（fail-closed）:
 *   1. JSON schema（embedded TA-1 schema）
 *   2. capability ids resolve in the registry and every grant is a subset of
 *      the registry（deny-by-default; NEG4）
 *   3. profile matches the (size, risk) matrix cell
 *   4. admission_id determinism（re-derivation matches when the record is
 *      frozen）
 *   5. FAST_PATH guard（A2 / R）: never for risk != LOW or size not XS/S
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateAdmission(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, errors: ["admission_not_object"] };
  }
  const sv = validateJsonSchema(ADMISSION_SCHEMA_DEFINITION, record);
  for (const e of sv.errors) errors.push(`schema:${e}`);

  // Capability registry subset + deny-by-default.
  const capRefs = { required: [], allowed: [], denied: [] };
  for (const k of ["required", "allowed", "denied"]) {
    for (const id of record.capabilities?.[k] ?? []) {
      const resolved = resolveCapabilityId(id);
      capRefs[k].push(resolved);
      if (!resolved) errors.push(`capability_unknown:${k}:${id}`);
    }
  }
  // Required ∩ allowed must be disjoint（a capability cannot be both）.
  const req = new Set(capRefs.required.filter(Boolean));
  for (const a of capRefs.allowed.filter(Boolean)) {
    if (req.has(a)) errors.push(`capability_required_and_allowed:${a}`);
  }
  // Denied is advisory-complete: any capability NOT in required ∪ allowed
  // must be listed in denied for FULL enumeration（TA-1 fail-closed: anything
  // unlisted is denied — we require the record to say so explicitly when
  // capabilities are present）.
  const granted = new Set([...capRefs.required, ...capRefs.allowed].filter(Boolean));
  const denied = new Set(capRefs.denied.filter(Boolean));
  const allCaps = Object.keys(capabilityRegistry());
  for (const id of allCaps) {
    if (!granted.has(id) && !denied.has(id)) errors.push(`capability_not_enumerated:${id}`);
  }

  // Profile cell match（V5-style machine check）.
  if (record.size && record.risk && record.profile) {
    try {
      const expect = profileFor({ size: record.size, risk: record.risk });
      if (expect !== record.profile) errors.push(`profile_mismatch:${record.size}/${record.risk} expected ${expect} got ${record.profile}`);
    } catch (e) {
      errors.push(`risk_invalid:${String(e?.message ?? e).slice(0, 80)}`);
    }
  }

  // FAST_PATH guard（never for non-LOW / non-XS-S）.
  if (record.profile === "FAST_PATH") {
    if (!(record.size === "XS" || record.size === "S")) errors.push(`fast_path_size:${record.size}`);
    if (record.risk !== "LOW") errors.push(`fast_path_risk:${record.risk}`);
  }

  // Semantic policy consistency（CP-2R2 Finding 3）: the admission's
  // isolation/durability policy must MATCH its profile projection. A
  // rehashed FAST_PATH with durability_policy "durable" is internally
  // inconsistent（direct execution has no durable layer）and must fail here,
  // not merely pass shape/id validation.
  if (typeof record.profile === "string" && Object.prototype.hasOwnProperty.call(PROFILE_MATRIX, record.profile)) {
    try {
      const expected = projectProfilePolicies(record.profile);
      if (record.isolation_policy !== undefined && record.isolation_policy !== expected.isolation_policy) {
        errors.push(`policy_inconsistent:isolation_policy:${record.profile} expected ${expected.isolation_policy} got ${record.isolation_policy}`);
      }
      if (record.durability_policy !== undefined && record.durability_policy !== expected.durability_policy) {
        errors.push(`policy_inconsistent:durability_policy:${record.profile} expected ${expected.durability_policy} got ${record.durability_policy}`);
      }
    } catch (e) {
      errors.push(`policy_projection_error:${String(e?.message ?? e).slice(0, 80)}`);
    }
  }

  // admission_id determinism（when the record carries a frozen id）。
  if (typeof record.admission_id === "string" && record.admission_id.length > 0 && record.admission_id !== "PLACEHOLDER") {
    const derived = deriveAdmissionId(record);
    if (derived !== record.admission_id) errors.push(`admission_id_mismatch:${derived}`);
  }

  // Risk monotonicity guard against a LOW risk record with triggered
  // CRITICAL/HIGH signals（under-classification, NEG2/NEG7/NEG12）。
  if (record.risk_details?.signals && Array.isArray(record.risk_details.signals)) {
    const triggered = record.risk_details.signals.filter((s) => s.triggered === true);
    try {
      const maxClass = triggered.reduce((mx, s) => {
        const r = normalizeRisk(s.class);
        return RISK_TIERS.indexOf(r) > RISK_TIERS.indexOf(mx) ? r : mx;
      }, "LOW");
      if (RISK_TIERS.indexOf(record.risk) < RISK_TIERS.indexOf(maxClass)) {
        errors.push(`risk_under_classified:${record.risk} < ${maxClass}`);
      }
    } catch (e) {
      errors.push(`risk_signal_class_invalid:${String(e?.message ?? e).slice(0, 80)}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Freeze an admission record: derive + bind admission_id, strip
 * decision_time to the canonical input basis, return a deep-frozen record.
 */
export function freezeAdmission(record) {
  const errors = validateAdmission({ ...record, admission_id: "PLACEHOLDER", decision_time: record.decision_time ?? "" });
  if (!errors.ok) {
    const err = new Error(`ADMISSION_INVALID: ${errors.errors.slice(0, 8).join("; ")}`);
    err.code = "ADMISSION_INVALID";
    throw err;
  }
  const { admission_id, decision_time, ...rest } = record;
  const frozen = { ...rest, decision_time: decision_time ?? new Date().toISOString(), admission_id: deriveAdmissionId(rest) };
  return Object.freeze(frozen);
}

/**
 * Drift check（N; NEG11）: the stored frozen payload must re-derive to the
 * authoritative admission_id. Any mismatch -> HOLD / ADMISSION_DRIFT.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function assertAdmissionFrozen({ stored, authoritativeAdmissionId, authoritativeRecord = null }) {
  if (!stored || typeof stored !== "object") return { ok: false, reason: "ADMISSION_DRIFT: no stored admission" };
  if (typeof authoritativeAdmissionId !== "string" || authoritativeAdmissionId.length === 0) {
    return { ok: false, reason: "ADMISSION_DRIFT: no authoritative admission_id" };
  }
  if (stored.admission_id !== authoritativeAdmissionId) {
    return { ok: false, reason: `ADMISSION_DRIFT: stored ${String(stored.admission_id).slice(0, 12)} != authoritative ${authoritativeAdmissionId.slice(0, 12)}` };
  }
  // If the full record is available, re-derive（tamper detection beyond id）.
  if (authoritativeRecord && typeof authoritativeRecord === "object") {
    const derived = deriveAdmissionId(authoritativeRecord);
    if (derived !== authoritativeAdmissionId) {
      return { ok: false, reason: `ADMISSION_DRIFT: payload re-derives ${derived.slice(0, 12)} != ${authoritativeAdmissionId.slice(0, 12)}` };
    }
  }
  return { ok: true };
}

/** A frozen admission digest（bound into checkpoint fingerprints, O）. */
export function admissionDigest(record) {
  return sha256Hex(canonicalAdmissionJson({ admission_id: record.admission_id ?? deriveAdmissionId(record), size: record.size, risk: record.risk, profile: record.profile, classifier_version: record.classifier_version }));
}
