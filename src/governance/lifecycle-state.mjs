// src/governance/lifecycle-state.mjs
//
// Review-unit lifecycle state machine (AUTOLOOP-GOVERNANCE-REVIEW-UNIT-
// FINALIZATION-1 §10).
//
//   AUTHORIZED
//   → EXECUTING → INTERNAL_MILESTONE_PASS → INTERNAL_CHECKPOINT_COMMITTED
//   → EXECUTING (next milestone) → ... → FULL_VERIFICATION_PASS
//   → REVIEW_BUNDLE_READY → WAITING_FOR_EXTERNAL_REVIEW
//
// External verdicts:
//   PASS   → EXTERNAL_REVIEW_PASS → INTEGRATION_READY
//   REPAIR → EXTERNAL_REVIEW_REPAIR → BOUNDED_REPAIR → FULL_VERIFICATION_PASS
//            → REVIEW_BUNDLE_READY → WAITING_FOR_EXTERNAL_REVIEW
//   HOLD   → CONTROLLER_REQUIRED (stop, return to Controller)
//
// Irreversible / external states PR_READY, MERGED, RELEASED, FINAL_SEAL are
// NOT reachable by this reversible lifecycle. Any attempt to enter them is
// invalid (HOLD / LIFECYCLE_TRANSITION_INVALID). PR_READY → FINAL_SEAL is
// removed; every seal transition belongs to the highest governance layer.

import { GOV_HOLD, hold } from "./holds.mjs";

export const LIFECYCLE_STATES = Object.freeze([
  "AUTHORIZED",
  "EXECUTING",
  "INTERNAL_MILESTONE_PASS",
  "INTERNAL_CHECKPOINT_COMMITTED",
  "FULL_VERIFICATION_PASS",
  "REVIEW_BUNDLE_READY",
  "WAITING_FOR_EXTERNAL_REVIEW",
  "EXTERNAL_REVIEW_REPAIR",
  "BOUNDED_REPAIR",
  "EXTERNAL_REVIEW_PASS",
  "INTEGRATION_READY",
  "CONTROLLER_REQUIRED",
]);

// Declared but never reachable from this reversible lifecycle.
export const IRREVERSIBLE_OR_EXTERNAL_STATES = Object.freeze([
  "PR_READY", "MERGED", "RELEASED", "FINAL_SEAL",
]);

export const STATE_ORDER = Object.freeze(
  Object.fromEntries(LIFECYCLE_STATES.map((s, i) => [s, i])),
);

// Allowed transitions (a state may repeat itself idempotently where noted).
const TRANSITIONS = Object.freeze({
  AUTHORIZED: ["AUTHORIZED", "EXECUTING"],
  EXECUTING: ["EXECUTING", "INTERNAL_MILESTONE_PASS", "FULL_VERIFICATION_PASS"],
  INTERNAL_MILESTONE_PASS: ["INTERNAL_MILESTONE_PASS", "EXECUTING", "INTERNAL_CHECKPOINT_COMMITTED", "FULL_VERIFICATION_PASS"],
  INTERNAL_CHECKPOINT_COMMITTED: ["INTERNAL_CHECKPOINT_COMMITTED", "EXECUTING", "FULL_VERIFICATION_PASS"],
  FULL_VERIFICATION_PASS: ["FULL_VERIFICATION_PASS", "REVIEW_BUNDLE_READY", "INTERNAL_CHECKPOINT_COMMITTED"],
  REVIEW_BUNDLE_READY: ["REVIEW_BUNDLE_READY", "WAITING_FOR_EXTERNAL_REVIEW"],
  WAITING_FOR_EXTERNAL_REVIEW: ["WAITING_FOR_EXTERNAL_REVIEW", "EXTERNAL_REVIEW_REPAIR", "EXTERNAL_REVIEW_PASS", "CONTROLLER_REQUIRED"],
  EXTERNAL_REVIEW_REPAIR: ["EXTERNAL_REVIEW_REPAIR", "BOUNDED_REPAIR"],
  BOUNDED_REPAIR: ["BOUNDED_REPAIR", "FULL_VERIFICATION_PASS"],
  EXTERNAL_REVIEW_PASS: ["EXTERNAL_REVIEW_PASS", "INTEGRATION_READY"],
  INTEGRATION_READY: ["INTEGRATION_READY"],
  CONTROLLER_REQUIRED: ["CONTROLLER_REQUIRED"],
});

export function isValidLifecycleState(s) {
  return typeof s === "string" && STATE_ORDER[s] !== undefined;
}

/** True for states outside the reversible machine (never auto-entered). */
export function isIrreversibleOrExternalState(s) {
  return typeof s === "string" && IRREVERSIBLE_OR_EXTERNAL_STATES.includes(s);
}

export function assertLifecycleTransition(from, to) {
  if (isIrreversibleOrExternalState(to) || isIrreversibleOrExternalState(from)) {
    throw hold(GOV_HOLD.LIFECYCLE_TRANSITION_INVALID, `state outside reversible lifecycle: ${from} -> ${to}`);
  }
  if (!isValidLifecycleState(from) || !isValidLifecycleState(to)) {
    throw hold(GOV_HOLD.LIFECYCLE_TRANSITION_INVALID, `unknown lifecycle state: ${from} -> ${to}`);
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw hold(GOV_HOLD.LIFECYCLE_TRANSITION_INVALID, `transition not declared: ${from} -> ${to}`);
  }
  return to;
}

export const LIFECYCLE_SEMANTICS = Object.freeze({
  INTERNAL_CHECKPOINT_COMMITTED_DOES_NOT_IMPLY_EXTERNAL_REVIEW_PASS: true,
  REVIEW_BUNDLE_READY_DOES_NOT_IMPLY_PASS: true,
  EXTERNAL_REVIEW_PASS_DOES_NOT_IMPLY_MERGE_ALLOWED: true,
  INTEGRATION_READY_DOES_NOT_IMPLY_MERGE_ALLOWED: true,
  MERGED_RELEASED_FINAL_SEAL_NEVER_AUTO_ENTERED: true,
  PR_READY_TO_FINAL_SEAL_REMOVED: true,
});

export function describeLifecycle(authority, state) {
  return {
    state,
    next: TRANSITIONS[state] ?? [],
    merge_allowed: false,
    release_allowed: false,
    seal_allowed: false,
    waiting_external_review: state === "WAITING_FOR_EXTERNAL_REVIEW",
    external_review_pass: state === "EXTERNAL_REVIEW_PASS",
    integration_ready: state === "INTEGRATION_READY",
    controller_required: state === "CONTROLLER_REQUIRED",
    semantics: LIFECYCLE_SEMANTICS,
  };
}
