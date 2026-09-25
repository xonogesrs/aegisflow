// hold-taxonomy.mjs
//
// AURACORE-AUTOLOOP-RUNTIME-BASELINE-AND-HOLD-TAXONOMY-1 Part B.
//
// Structured, additive classification layered on top of existing free-text
// HOLD verdict/reason strings. Does NOT replace, rename, or become a second
// authority over any existing verdict/reason string (run-card.mjs's
// "verdict" field, c2d's C3B_HOLD / fs-atomic HOLD constants, etc. are all
// untouched) — this only attaches an optional `hold` object alongside them.
//
// Classification is a deterministic lookup from an explicit, closed-set
// `failureOrigin` that the call site must name — never a guess derived from
// free-text message content.

export const HOLD_TYPES = Object.freeze([
  "CODE_FAILURE",
  "EVIDENCE_FAILURE",
  "CARD_DRIFT",
  "ENVIRONMENT_FAILURE",
  "SCOPE_EXPANSION_REQUIRED",
]);

// Bounded repair Finding E: VALIDATION_COMMAND_FAILED, MUTATION_EVIDENCE_
// NOT_EXECUTED, FINAL_EVIDENCE_INCOMPLETE, and AUTHORIZED_SCOPE_INSUFFICIENT
// were removed here — grep-confirmed zero production call sites anywhere in
// the repository (they were aspirational entries for HOLD origins this
// runtime-baseline card never wires up). Per card §10.4 boundary: this card
// only owns runtime-baseline origins; classifying every other AegisFlow HOLD
// site is explicitly out of scope, so speculative entries for that future
// work don't belong here either. CODE_FAILURE and SCOPE_EXPANSION_REQUIRED
// remain valid HOLD_TYPES values (reachable once a real call site is wired),
// just not currently produced by any origin below.
const ORIGIN_TO_HOLD_TYPE = Object.freeze({
  START_HEAD_MISMATCH: "CARD_DRIFT",
  START_HEAD_INVALID: "CARD_DRIFT",
  INITIAL_HEAD_ORIGIN_MISMATCH: "CARD_DRIFT",
  INITIAL_ORIGIN_REMOTE_MISMATCH: "CARD_DRIFT",
  INITIAL_HEAD_REMOTE_MISMATCH: "CARD_DRIFT",
  HEAD_OR_REMOTE_CHANGED: "CARD_DRIFT",
  BRANCH_MISMATCH: "CARD_DRIFT",
  BRANCH_DIVERGED: "CARD_DRIFT",
  DIRTY_SET_CHANGED: "CARD_DRIFT",
  STAGED_OR_UNTRACKED_PRESENT: "CARD_DRIFT",
  PROTECTED_DIGEST_CHANGED: "CARD_DRIFT",
  UNAUTHORIZED_UNTRACKED_PATH: "CARD_DRIFT",
  GIT_REMOTE_UNAVAILABLE: "ENVIRONMENT_FAILURE",
  REQUIRED_TOOL_UNAVAILABLE: "ENVIRONMENT_FAILURE",
});

// Unknown/unregistered failureOrigin fails closed to EVIDENCE_FAILURE with an
// explicit UNCLASSIFIED_HOLD code — never silently defaults to CODE_FAILURE,
// and never rewrites a non-HOLD (success) verdict.
export function classifyHold({ failureOrigin, message = "", repairableWithinScope = false, recommendedNextAction = "" } = {}) {
  const holdType = ORIGIN_TO_HOLD_TYPE[failureOrigin];
  return {
    hold_type: holdType || "EVIDENCE_FAILURE",
    code: holdType ? failureOrigin : "UNCLASSIFIED_HOLD",
    message,
    repairable_within_scope: !!repairableWithinScope,
    recommended_next_action: recommendedNextAction,
  };
}
