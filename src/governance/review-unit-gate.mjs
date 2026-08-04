// src/governance/review-unit-gate.mjs
//
// Review-unit task boundary (AUTOLOOP-GOVERNANCE-REVIEW-UNIT-FINALIZATION-1
// §5). One coherent review unit is the default execution unit: up to three
// internal milestones, local checkpoint commits, one final text bundle.
// The gate enforces the effective review_unit limits at runtime and the
// explicit "must stop early" conditions. Fail-closed: any exceeded limit or
// triggered early-stop condition → HOLD / REVIEW_UNIT_LIMIT_EXCEEDED with a
// concrete reason. Never expands scope on its own.

import { GOV_HOLD, hold } from "./holds.mjs";
import { effectiveRepairCap, repairCapConflict } from "./lifecycle-authorization.mjs";

// Default limits (§5) — mirrors the card's default caps. An entry card may
// declare higher values in its review_unit block (schema sanity bounds above);
// the review-unit gate always enforces the EFFECTIVE (declared) limits.
export const REVIEW_UNIT_DEFAULTS = Object.freeze({
  repository_count: 1,
  worktree_count: 1,
  parent_card_count: 1,
  architecture_goal_count: 1,
  maximum_internal_milestones: 3,
  maximum_changed_paths: 25,
  maximum_patch_lines: 3000,
  maximum_repair_rounds: 2,
});

export const REVIEW_UNIT_LIMIT_FIELDS = Object.freeze(Object.keys(REVIEW_UNIT_DEFAULTS));

// Mapping from the measured-actual names (§5) to the limit field names.
export const REVIEW_UNIT_ACTUAL_TO_LIMIT = Object.freeze({
  internal_milestones: "maximum_internal_milestones",
  changed_paths: "maximum_changed_paths",
  patch_lines: "maximum_patch_lines",
  repair_rounds: "maximum_repair_rounds",
});

// Early-stop conditions that must never expand a review unit (§5).
export const REVIEW_UNIT_STOP_CONDITIONS = Object.freeze({
  CROSS_REPOSITORY_CHANGE_REQUIRED: "requires cross-repository change",
  SECOND_WORKTREE_REQUIRED: "requires a second worktree",
  ARCHITECTURE_DECISION_PENDING: "major architecture choice not yet decided",
  WRITABLE_SCOPE_EXPANSION_REQUIRED: "requires expanding the authorized writable scope",
  SECRET_OR_PRODUCTION_ACCESS_REQUIRED: "requires secret, credential or production access",
  PHYSICAL_DEVICE_OPERATION_REQUIRED: "requires operating a physical device",
  EXTERNAL_SERVICE_WRITE_REQUIRED: "requires writing to an external service",
  PRODUCTION_MIGRATION_REQUIRED: "involves a production migration",
  MERGE_RELEASE_SEAL_REQUIRED: "involves merge, release or seal",
  REMOTE_DIVERGENCE: "remote divergence detected",
  REPAIR_ROUNDS_EXCEEDED: "repair rounds exceed the budget",
  TEST_RESULT_NOT_REPRODUCIBLE: "test results are not reproducible",
  EVIDENCE_IDENTITY_NOT_FIXED: "evidence identity cannot be fixed",
  REVIEW_BUNDLE_CANNOT_FULLY_OUTPUT: "review bundle cannot be fully output",
  PATCH_TOO_LARGE_FOR_REVIEW: "patch too large for a reliable single-pass review",
});

/**
 * Evaluate the review-unit boundary for the current execution.
 *
 * @param {object} args
 * @param {object} args.authority — effective lifecycle authority
 * @param {object} [args.actual] — measured counts:
 *   { repository_count, worktree_count, parent_card_count, architecture_goal_count,
 *     internal_milestones, changed_paths, patch_lines, repair_rounds }
 * @param {string[]} [args.stopConditions] — early-stop condition keys already hit
 * @returns {{allowed: boolean, violations: string[], limits: object}}
 */
export function evaluateReviewUnitGate({ authority, actual = {}, stopConditions = [] }) {
  const cap = authority?.review_unit ?? { allowed: false };
  const limits = {};
  for (const f of REVIEW_UNIT_LIMIT_FIELDS) limits[f] = cap[f] ?? REVIEW_UNIT_DEFAULTS[f];
  const violations = [];

  if (cap.allowed !== true) violations.push("review_unit.allowed is false (fail-closed)");

  // Round 5 finding: the repair budget has TWO declared caps
  // (bounded_repair.max_rounds and review_unit.maximum_repair_rounds). The
  // canonical cap is their strict intersection; the rendered limit and the
  // enforcement below use that single effective cap. A finite mismatch
  // between the two declarations is itself an authority conflict.
  const repairCap = effectiveRepairCap(authority);
  limits.maximum_repair_rounds = repairCap;
  const conflict = repairCapConflict(authority);
  if (conflict) violations.push(`repair_cap_authority_conflict: ${conflict}`);

  const limitOf = (key) => {
    if (REVIEW_UNIT_LIMIT_FIELDS.includes(key)) return key;
    return REVIEW_UNIT_ACTUAL_TO_LIMIT[key] ?? null;
  };

  for (const key of Object.keys(actual)) {
    const limitKey = limitOf(key);
    const value = actual[key];
    if (!limitKey || value === undefined || value === null) continue;
    if (typeof value === "number" && value > limits[limitKey]) {
      violations.push(`review_unit.${limitKey}: ${value} exceeds limit ${limits[limitKey]}`);
    }
  }

  for (const key of stopConditions) {
    if (REVIEW_UNIT_STOP_CONDITIONS[key]) {
      violations.push(`early_stop:${key}: ${REVIEW_UNIT_STOP_CONDITIONS[key]}`);
    }
  }

  return { allowed: violations.length === 0, violations, limits };
}

export function reviewUnitViolationsToHold(violations) {
  if (!violations || violations.length === 0) return null;
  return hold(GOV_HOLD.REVIEW_UNIT_LIMIT_EXCEEDED, violations.join("; "));
}

/** Recommended HOLD code for an early-stop condition. */
export function earlyStopHold(key) {
  if (!REVIEW_UNIT_STOP_CONDITIONS[key]) return null;
  return hold(GOV_HOLD.REVIEW_UNIT_LIMIT_EXCEEDED, `early_stop:${key}: ${REVIEW_UNIT_STOP_CONDITIONS[key]}`);
}
