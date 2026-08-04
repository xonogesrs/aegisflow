// test/governance/test-lifecycle-state.mjs
// §6 lifecycle state layering and transition rules

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIFECYCLE_STATES,
  isValidLifecycleState,
  assertLifecycleTransition,
  describeLifecycle,
  LIFECYCLE_SEMANTICS,
} from "../../src/governance/lifecycle-state.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";

test("state layer order is canonical", () => {
  assert.deepEqual(LIFECYCLE_STATES, [
    "NODE_PASS", "CARD_PASS", "MILESTONE_PASS",
    "CHECKPOINT_COMMITTED", "DRAFT_PR_UPDATED", "PR_READY", "FINAL_SEAL",
  ]);
});

test("valid forward transitions", () => {
  assert.equal(assertLifecycleTransition("NODE_PASS", "CARD_PASS"), "CARD_PASS");
  assert.equal(assertLifecycleTransition("CARD_PASS", "MILESTONE_PASS"), "MILESTONE_PASS");
  assert.equal(assertLifecycleTransition("MILESTONE_PASS", "CHECKPOINT_COMMITTED"), "CHECKPOINT_COMMITTED");
  assert.equal(assertLifecycleTransition("CHECKPOINT_COMMITTED", "DRAFT_PR_UPDATED"), "DRAFT_PR_UPDATED");
  assert.equal(assertLifecycleTransition("DRAFT_PR_UPDATED", "PR_READY"), "PR_READY");
});

test("§6: NODE_PASS does not imply card pass; checkpoint does not imply review pass", () => {
  assert.equal(LIFECYCLE_SEMANTICS.NODE_PASS_DOES_NOT_IMPLY_CARD_PASS, true);
  assert.equal(LIFECYCLE_SEMANTICS.CHECKPOINT_COMMITTED_DOES_NOT_IMPLY_EXTERNAL_REVIEW_PASS, true);
  assert.equal(LIFECYCLE_SEMANTICS.PR_READY_DOES_NOT_IMPLY_MERGE_ALLOWED, true);
});

test("regression and undeclared transitions are rejected", () => {
  assert.throws(() => assertLifecycleTransition("CARD_PASS", "NODE_PASS"), (e) => e.code === GOV_HOLD.LIFECYCLE_TRANSITION_INVALID);
  assert.throws(() => assertLifecycleTransition("NODE_PASS", "CHECKPOINT_COMMITTED"), (e) => e.code === GOV_HOLD.LIFECYCLE_TRANSITION_INVALID);
  assert.throws(() => assertLifecycleTransition("BOGUS", "CARD_PASS"), (e) => e.code === GOV_HOLD.LIFECYCLE_TRANSITION_INVALID);
});

test("describeLifecycle exposes fail-closed merge/release/seal", () => {
  const d = describeLifecycle({}, "CHECKPOINT_COMMITTED");
  assert.equal(d.merge_allowed, false);
  assert.equal(d.release_allowed, false);
  assert.equal(d.seal_allowed, false);
  assert.equal(d.checkpoint_committed, true);
  assert.equal(d.pr_ready, false);
});

test("FINAL_SEAL is terminal", () => {
  assert.equal(assertLifecycleTransition("FINAL_SEAL", "FINAL_SEAL"), "FINAL_SEAL");
  assert.equal(isValidLifecycleState("FINAL_SEAL"), true);
});
