// test/governance/test-lifecycle-state.mjs
// Review-unit lifecycle state machine (§10):
//   AUTHORIZED → EXECUTING → INTERNAL_MILESTONE_PASS →
//   INTERNAL_CHECKPOINT_COMMITTED → FULL_VERIFICATION_PASS →
//   REVIEW_BUNDLE_READY → WAITING_FOR_EXTERNAL_REVIEW
//   PASS → EXTERNAL_REVIEW_PASS → INTEGRATION_READY
//   REPAIR → EXTERNAL_REVIEW_REPAIR → BOUNDED_REPAIR → FULL_VERIFICATION_PASS ...
//   HOLD → CONTROLLER_REQUIRED
// Irreversible / external states (PR_READY, MERGED, RELEASED, FINAL_SEAL)
// are never auto-entered; PR_READY → FINAL_SEAL is removed.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIFECYCLE_STATES,
  IRREVERSIBLE_OR_EXTERNAL_STATES,
  isValidLifecycleState,
  isIrreversibleOrExternalState,
  assertLifecycleTransition,
  describeLifecycle,
  LIFECYCLE_SEMANTICS,
} from "../../src/governance/lifecycle-state.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";

test("state layer order is canonical (12 reversible states)", () => {
  assert.deepEqual(LIFECYCLE_STATES, [
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
});

test("valid forward transitions", () => {
  assert.equal(assertLifecycleTransition("AUTHORIZED", "EXECUTING"), "EXECUTING");
  assert.equal(assertLifecycleTransition("EXECUTING", "INTERNAL_MILESTONE_PASS"), "INTERNAL_MILESTONE_PASS");
  assert.equal(assertLifecycleTransition("INTERNAL_MILESTONE_PASS", "INTERNAL_CHECKPOINT_COMMITTED"), "INTERNAL_CHECKPOINT_COMMITTED");
  assert.equal(assertLifecycleTransition("INTERNAL_CHECKPOINT_COMMITTED", "EXECUTING"), "EXECUTING");
  assert.equal(assertLifecycleTransition("INTERNAL_CHECKPOINT_COMMITTED", "FULL_VERIFICATION_PASS"), "FULL_VERIFICATION_PASS");
  assert.equal(assertLifecycleTransition("FULL_VERIFICATION_PASS", "REVIEW_BUNDLE_READY"), "REVIEW_BUNDLE_READY");
  assert.equal(assertLifecycleTransition("REVIEW_BUNDLE_READY", "WAITING_FOR_EXTERNAL_REVIEW"), "WAITING_FOR_EXTERNAL_REVIEW");
});

test("external verdict transitions", () => {
  assert.equal(assertLifecycleTransition("WAITING_FOR_EXTERNAL_REVIEW", "EXTERNAL_REVIEW_PASS"), "EXTERNAL_REVIEW_PASS");
  assert.equal(assertLifecycleTransition("EXTERNAL_REVIEW_PASS", "INTEGRATION_READY"), "INTEGRATION_READY");
  assert.equal(assertLifecycleTransition("WAITING_FOR_EXTERNAL_REVIEW", "EXTERNAL_REVIEW_REPAIR"), "EXTERNAL_REVIEW_REPAIR");
  assert.equal(assertLifecycleTransition("EXTERNAL_REVIEW_REPAIR", "BOUNDED_REPAIR"), "BOUNDED_REPAIR");
  assert.equal(assertLifecycleTransition("WAITING_FOR_EXTERNAL_REVIEW", "CONTROLLER_REQUIRED"), "CONTROLLER_REQUIRED");
});

test("bounded repair loop returns to bundle-ready/waiting", () => {
  assert.equal(assertLifecycleTransition("BOUNDED_REPAIR", "FULL_VERIFICATION_PASS"), "FULL_VERIFICATION_PASS");
  assert.equal(assertLifecycleTransition("FULL_VERIFICATION_PASS", "REVIEW_BUNDLE_READY"), "REVIEW_BUNDLE_READY");
  assert.equal(assertLifecycleTransition("REVIEW_BUNDLE_READY", "WAITING_FOR_EXTERNAL_REVIEW"), "WAITING_FOR_EXTERNAL_REVIEW");
});

test("[neg 18] PR_READY → FINAL_SEAL is removed/blocked", () => {
  assert.equal(isIrreversibleOrExternalState("PR_READY"), true);
  assert.equal(isIrreversibleOrExternalState("FINAL_SEAL"), true);
  assert.equal(isIrreversibleOrExternalState("MERGED"), true);
  assert.equal(isIrreversibleOrExternalState("RELEASED"), true);
  assert.throws(() => assertLifecycleTransition("PR_READY", "FINAL_SEAL"), (e) => e.code === GOV_HOLD.LIFECYCLE_TRANSITION_INVALID);
  // no reversible state may auto-enter an irreversible state
  for (const from of LIFECYCLE_STATES) {
    for (const to of IRREVERSIBLE_OR_EXTERNAL_STATES) {
      assert.throws(() => assertLifecycleTransition(from, to), (e) => e.code === GOV_HOLD.LIFECYCLE_TRANSITION_INVALID);
    }
  }
});

test("undeclared transitions are rejected", () => {
  assert.throws(() => assertLifecycleTransition("AUTHORIZED", "FULL_VERIFICATION_PASS"), (e) => e.code === GOV_HOLD.LIFECYCLE_TRANSITION_INVALID);
  assert.throws(() => assertLifecycleTransition("EXECUTING", "REVIEW_BUNDLE_READY"), (e) => e.code === GOV_HOLD.LIFECYCLE_TRANSITION_INVALID);
  assert.throws(() => assertLifecycleTransition("EXTERNAL_REVIEW_PASS", "EXECUTING"), (e) => e.code === GOV_HOLD.LIFECYCLE_TRANSITION_INVALID);
  assert.throws(() => assertLifecycleTransition("BOGUS", "EXECUTING"), (e) => e.code === GOV_HOLD.LIFECYCLE_TRANSITION_INVALID);
});

test("checkpoint does not imply external review PASS; PASS does not imply merge", () => {
  assert.equal(LIFECYCLE_SEMANTICS.INTERNAL_CHECKPOINT_COMMITTED_DOES_NOT_IMPLY_EXTERNAL_REVIEW_PASS, true);
  assert.equal(LIFECYCLE_SEMANTICS.EXTERNAL_REVIEW_PASS_DOES_NOT_IMPLY_MERGE_ALLOWED, true);
  assert.equal(LIFECYCLE_SEMANTICS.MERGED_RELEASED_FINAL_SEAL_NEVER_AUTO_ENTERED, true);
  assert.equal(LIFECYCLE_SEMANTICS.PR_READY_TO_FINAL_SEAL_REMOVED, true);
});

test("describeLifecycle exposes fail-closed merge/release/seal + stage flags", () => {
  const d = describeLifecycle({}, "WAITING_FOR_EXTERNAL_REVIEW");
  assert.equal(d.merge_allowed, false);
  assert.equal(d.release_allowed, false);
  assert.equal(d.seal_allowed, false);
  assert.equal(d.waiting_external_review, true);
  assert.equal(d.external_review_pass, false);
  const i = describeLifecycle({}, "INTEGRATION_READY");
  assert.equal(i.integration_ready, true);
  const c = describeLifecycle({}, "CONTROLLER_REQUIRED");
  assert.equal(c.controller_required, true);
});

test("idempotent self-transitions are allowed where declared", () => {
  assert.equal(assertLifecycleTransition("EXECUTING", "EXECUTING"), "EXECUTING");
  assert.equal(assertLifecycleTransition("CONTROLLER_REQUIRED", "CONTROLLER_REQUIRED"), "CONTROLLER_REQUIRED");
});
