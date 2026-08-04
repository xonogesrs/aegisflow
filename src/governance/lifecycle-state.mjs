// src/governance/lifecycle-state.mjs
//
// Formal lifecycle state layers for reversible governance.
//
//   NODE_PASS           单节点通过（不代表父卡完成）
//   CARD_PASS           单卡通过（不代表 milestone 可提交）
//   MILESTONE_PASS      milestone 通过（可進入 checkpoint commit）
//   CHECKPOINT_COMMITTED checkpoint 已提交（不代表外部 review 通過）
//   DRAFT_PR_UPDATED    Draft PR 已建立/更新（不代表 PR ready）
//   PR_READY            PR 可標記 ready（不代表可 merge）
//   FINAL_SEAL          最終 seal（獨立、最高層級治理，本授權永不自動）
//
// Fail-closed transition rules: every transition must be declared below;
// anything else is invalid (HOLD / LIFECYCLE_TRANSITION_INVALID).

import { GOV_HOLD, hold } from "./holds.mjs";

export const LIFECYCLE_STATES = Object.freeze([
  "NODE_PASS",
  "CARD_PASS",
  "MILESTONE_PASS",
  "CHECKPOINT_COMMITTED",
  "DRAFT_PR_UPDATED",
  "PR_READY",
  "FINAL_SEAL",
]);

// Ordered depth. FINAL_SEAL is terminal and never reached by this
// authorization family (merge_main/release/seal are denied).
export const STATE_ORDER = Object.freeze(
  Object.fromEntries(LIFECYCLE_STATES.map((s, i) => [s, i])),
);

// Allowed forward transitions (a state may also repeat itself idempotently,
// e.g. DRAFT_PR_UPDATED → DRAFT_PR_UPDATED on the next checkpoint).
const TRANSITIONS = Object.freeze({
  NODE_PASS: ["NODE_PASS", "CARD_PASS"],
  CARD_PASS: ["CARD_PASS", "MILESTONE_PASS"],
  MILESTONE_PASS: ["MILESTONE_PASS", "CHECKPOINT_COMMITTED"],
  CHECKPOINT_COMMITTED: ["CHECKPOINT_COMMITTED", "DRAFT_PR_UPDATED"],
  DRAFT_PR_UPDATED: ["DRAFT_PR_UPDATED", "PR_READY"],
  PR_READY: ["PR_READY", "FINAL_SEAL"],
  FINAL_SEAL: ["FINAL_SEAL"],
});

export function isValidLifecycleState(s) {
  return typeof s === "string" && STATE_ORDER[s] !== undefined;
}

export function assertLifecycleTransition(from, to) {
  if (!isValidLifecycleState(from) || !isValidLifecycleState(to)) {
    throw hold(GOV_HOLD.LIFECYCLE_TRANSITION_INVALID, `unknown lifecycle state: ${from} -> ${to}`);
  }
  if (STATE_ORDER[to] < STATE_ORDER[from] && from !== to) {
    throw hold(GOV_HOLD.LIFECYCLE_TRANSITION_INVALID, `regression not allowed: ${from} -> ${to}`);
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw hold(GOV_HOLD.LIFECYCLE_TRANSITION_INVALID, `transition not declared: ${from} -> ${to}`);
  }
  return to;
}

// The card's §6 rules as explicit predicates (used by tests and gates).
export const LIFECYCLE_SEMANTICS = Object.freeze({
  NODE_PASS_DOES_NOT_IMPLY_CARD_PASS: true,
  CARD_PASS_DOES_NOT_IMPLY_MILESTONE: true,
  CHECKPOINT_COMMITTED_DOES_NOT_IMPLY_EXTERNAL_REVIEW_PASS: true,
  DRAFT_PR_UPDATED_DOES_NOT_IMPLY_PR_READY: true,
  PR_READY_DOES_NOT_IMPLY_MERGE_ALLOWED: true,
  FINAL_SEAL_REQUIRES_INDEPENDENT_HIGHEST_GOVERNANCE: true,
});

export function describeLifecycle(authority, state) {
  return {
    state,
    next: TRANSITIONS[state] ?? [],
    merge_allowed: false,
    release_allowed: false,
    seal_allowed: false,
    checkpoint_committed: STATE_ORDER[state] >= STATE_ORDER.CHECKPOINT_COMMITTED,
    draft_pr_updated: STATE_ORDER[state] >= STATE_ORDER.DRAFT_PR_UPDATED,
    pr_ready: STATE_ORDER[state] >= STATE_ORDER.PR_READY,
    semantics: LIFECYCLE_SEMANTICS,
  };
}
