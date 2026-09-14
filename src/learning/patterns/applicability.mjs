// src/learning/patterns/applicability.mjs
//
// R2 O6 — APPLICABILITY CLASSIFICATION (Stage-F R2 chain; [CT §1 R6]).
//
// Produces the machine-testable applicability boundary a PATTERN candidate
// carries and the EVALUATOR the O7 retrieval slice consults (boundary
// consultation; [CT §4] mechanism/applicability primary matching).
//
// Hard rules (frozen):
//   - boundary fields: appliesWhen / doesNotApplyWhen / mechanismSignature;
//   - boundary must be PRESENT + MACHINE-TESTABLE: structured conditions
//     only ({field, op, value} over PATTERN_BOUNDARY_OPERATORS) — NEVER
//     lexical-similarity-only ([CT §1 R6] NG, verbatim);
//   - a vacuous boundary ("applies everywhere") is REJECTED (fine code
//     boundary_vacuous — SCHEMA_INVALID class; PHASE-3 STEP 1c);
//   - evaluation is DETERMINISTIC and READ-ONLY: the record's stored
//     boundary evaluated against structured query selectors; a required
//     match that evaluates false makes the record NON-ELIGIBLE (a
//     deterministic filter with a reason — NOT an error);
//   - consultation NEVER writes anything (durable effect NONE);
//   - a boundary that cannot re-derive from stored fields fails closed
//     (SCHEMA_INVALID class / boundary_vacuous);
//   - NON-AUTHORITATIVE: eligibility is a ranking/eligibility input, never
//     an authority grant; no promotion semantics exist here.
//
// PROHIBITED HERE: activation · adoption · promotion · policy mutation ·
// free-text/lexical matching · harness/session/provider identity inputs.

import {
  PATTERN_BOUNDARY_OPERATORS,
  PATTERN_MECHANISM_SIGNATURE_FIELDS,
  NOT_APPLICABLE,
} from "../../memory/contract.mjs";

export const APPLICABILITY_SCHEMA = "autoloop.pattern-applicability/v1";

export const APPLICABILITY_REJECT = Object.freeze({
  VACUOUS: "boundary_vacuous",
  MALFORMED: "APPLICABILITY_MALFORMED",
});

export class ApplicabilityError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "ApplicabilityError";
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Validate ONE boundary condition ({field, op, value}; structured only). */
export function validateBoundaryCondition(cond) {
  if (!isPlainObject(cond)) throw new ApplicabilityError(APPLICABILITY_REJECT.VACUOUS, "boundary condition must be an object", { reason: "boundary_condition_not_object" });
  for (const k of Object.keys(cond)) {
    if (!["field", "op", "value"].includes(k)) {
      throw new ApplicabilityError(APPLICABILITY_REJECT.VACUOUS, `unknown boundary condition field ${k}`, { reason: `boundary_unknown_field:${k}` });
    }
  }
  if (typeof cond.field !== "string" || cond.field.length === 0) {
    throw new ApplicabilityError(APPLICABILITY_REJECT.VACUOUS, "boundary condition field required", { reason: "boundary_field_required" });
  }
  if (!PATTERN_BOUNDARY_OPERATORS.includes(cond.op)) {
    throw new ApplicabilityError(APPLICABILITY_REJECT.VACUOUS, `non-machine-testable op ${String(cond.op)}`, { reason: `boundary_op_invalid:${String(cond.op)}` });
  }
  const v = cond.value;
  const ok = (typeof v === "string" && v.length > 0)
    || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0));
  if (!ok) {
    throw new ApplicabilityError(APPLICABILITY_REJECT.VACUOUS, "boundary condition value must be a non-empty string or non-empty string array", { reason: "boundary_value_invalid" });
  }
}

/**
 * Validate + normalize an applicability boundary (O6). Throws
 * ApplicabilityError (boundary_vacuous) when vacuous/non-testable.
 *
 * @returns normalized boundary { appliesWhen, doesNotApplyWhen, mechanismSignature }
 */
export function classifyApplicability({ appliesWhen, doesNotApplyWhen = [], mechanismSignature }) {
  if (!Array.isArray(appliesWhen) || appliesWhen.length === 0) {
    throw new ApplicabilityError(APPLICABILITY_REJECT.VACUOUS, "appliesWhen must be a non-empty array of structured conditions — a pattern that 'applies everywhere' is vacuous", { reason: "applies_when_empty_or_missing" });
  }
  for (const c of appliesWhen) validateBoundaryCondition(c);
  if (doesNotApplyWhen !== undefined && doesNotApplyWhen !== null) {
    if (!Array.isArray(doesNotApplyWhen)) {
      throw new ApplicabilityError(APPLICABILITY_REJECT.MALFORMED, "doesNotApplyWhen must be an array");
    }
    for (const c of doesNotApplyWhen) validateBoundaryCondition(c);
  }
  if (!isPlainObject(mechanismSignature)) {
    throw new ApplicabilityError(APPLICABILITY_REJECT.VACUOUS, "mechanismSignature object required", { reason: "mechanism_signature_missing" });
  }
  const msKeys = Object.keys(mechanismSignature).filter((k) => mechanismSignature[k] !== undefined && mechanismSignature[k] !== null);
  if (msKeys.length === 0) {
    throw new ApplicabilityError(APPLICABILITY_REJECT.VACUOUS, "mechanismSignature must carry at least one element", { reason: "mechanism_signature_empty" });
  }
  for (const k of msKeys) {
    if (!PATTERN_MECHANISM_SIGNATURE_FIELDS.includes(k)) {
      throw new ApplicabilityError(APPLICABILITY_REJECT.MALFORMED, `unknown mechanismSignature element ${k}`);
    }
  }
  return {
    schema: APPLICABILITY_SCHEMA,
    appliesWhen: appliesWhen.map((c) => ({ ...c })),
    doesNotApplyWhen: (doesNotApplyWhen ?? []).map((c) => ({ ...c })),
    mechanismSignature: { ...mechanismSignature },
  };
}

// ── evaluation (O7 boundary consultation; deterministic, read-only) ─────────

function valueAtPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function conditionMatches(condition, context) {
  const actual = valueAtPath(context, condition.field);
  if (actual === undefined || actual === null || actual === NOT_APPLICABLE) return false;
  const expected = condition.value;
  switch (condition.op) {
    case "PATH_PREFIX": {
      const a = String(actual);
      const vals = Array.isArray(expected) ? expected : [expected];
      return vals.some((v) => a === v || a.startsWith(v.endsWith("/") ? v : `${v}/`) || a.startsWith(`${v}/`));
    }
    case "SYMBOL_EQUALS": {
      const vals = Array.isArray(expected) ? expected : [expected];
      return vals.includes(String(actual));
    }
    case "TREE_MATCHES": {
      const vals = Array.isArray(expected) ? expected : [expected];
      return vals.includes(String(actual));
    }
    case "TOOL_EQUALS": {
      const vals = Array.isArray(expected) ? expected : [expected];
      return vals.includes(String(actual));
    }
    case "ERROR_CLASS_IN": {
      const a = String(actual);
      const vals = Array.isArray(expected) ? expected : [expected];
      return vals.includes(a);
    }
    case "LANGUAGE_EQUALS": {
      const vals = Array.isArray(expected) ? expected : [expected];
      return vals.includes(String(actual));
    }
    default:
      return false; // unknown op never matches (fail-closed)
  }
}

/**
 * Evaluate a stored boundary against structured query selectors.
 *
 * @param {object} boundary — the record's STORED applicability boundary
 * @param {object} selectors — { appliesWhen?, doesNotApplyWhen?, mechanismSignature? }
 *        (structured query fields; never free text)
 * @returns {{ eligible: boolean, reasons: string[] }}
 *   eligible=false is a DETERMINISTIC FILTER with recorded reasons (NOT an
 *   error). The record is eligible iff every query appliesWhen condition is
 *   accepted by the boundary's appliesWhen (mechanism/applicability
 *   compatibility), no query appliesWhen condition is rejected by the
 *   boundary's doesNotApplyWhen, and mechanismSignature selectors do not
 *   contradict the record's mechanism signature.
 */
export function evaluateBoundary(boundary, selectors = {}) {
  if (!isPlainObject(boundary) || !Array.isArray(boundary.appliesWhen) || boundary.appliesWhen.length === 0) {
    // boundary cannot re-derive from stored fields ⇒ fail closed
    throw new ApplicabilityError(APPLICABILITY_REJECT.VACUOUS, "stored boundary missing/non-derivable", { reason: "applicability_boundary_missing" });
  }
  const reasons = [];
  const queryApplies = Array.isArray(selectors.appliesWhen) ? selectors.appliesWhen : [];
  const queryExcludes = Array.isArray(selectors.doesNotApplyWhen) ? selectors.doesNotApplyWhen : [];
  const queryMechanism = isPlainObject(selectors.mechanismSignature) ? selectors.mechanismSignature : null;

  for (const [i, cond] of queryApplies.entries()) {
    validateBoundaryCondition(cond);
    const accepted = boundary.appliesWhen.some((b) => sameConditionSemantics(b, cond));
    if (!accepted) {
      // does the boundary EXPLICITLY exclude it?
      const excluded = Array.isArray(boundary.doesNotApplyWhen)
        && boundary.doesNotApplyWhen.some((b) => sameConditionSemantics(b, cond));
      reasons.push(excluded ? `excluded_by_does_not_apply_when[${i}]` : `not_covered_by_applies_when[${i}]`);
    }
  }
  for (const [i, cond] of queryExcludes.entries()) {
    validateBoundaryCondition(cond);
    // the caller asserts this context should NOT match; if the boundary's
    // appliesWhen WOULD match it, the pattern is non-eligible for a query
    // that demands exclusion
    const wouldApply = boundary.appliesWhen.some((b) => sameConditionSemantics(b, cond));
    if (wouldApply) reasons.push(`query_excludes_but_boundary_applies[${i}]`);
  }
  if (queryMechanism) {
    for (const [k, v] of Object.entries(queryMechanism)) {
      if (v === null || v === undefined) continue;
      const stored = boundary.mechanismSignature?.[k];
      if (stored === undefined || stored === null) {
        reasons.push(`mechanism_signature_missing_element:${k}`);
        continue;
      }
      const s = Array.isArray(stored) ? stored : [stored];
      const q = Array.isArray(v) ? v : [v];
      if (!q.every((qv) => s.includes(qv))) reasons.push(`mechanism_signature_mismatch:${k}`);
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

/** Structural equality of two conditions (op + value semantics). */
function sameConditionSemantics(a, b) {
  if (a.op !== b.op) return false;
  const av = Array.isArray(a.value) ? a.value : [a.value];
  const bv = Array.isArray(b.value) ? b.value : [b.value];
  return av.every((v) => bv.includes(v));
}
