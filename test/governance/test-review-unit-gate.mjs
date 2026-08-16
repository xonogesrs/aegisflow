// test/governance/test-review-unit-gate.mjs
// Review-unit task boundary (§5): one coherent review unit, hard caps on
// repository/worktree/parent/architecture counts and milestones/paths/lines/
// repair rounds; explicit early-stop conditions; fail-closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReviewUnitGate,
  reviewUnitViolationsToHold,
  earlyStopHold,
  REVIEW_UNIT_DEFAULTS,
  REVIEW_UNIT_STOP_CONDITIONS,
  REVIEW_UNIT_LIMIT_FIELDS,
} from "../../src/governance/review-unit-gate.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";
import { entryBlock } from "./helpers.mjs";

const authority = { review_unit: entryBlock().review_unit };

const within = {
  repository_count: 1,
  worktree_count: 1,
  parent_card_count: 1,
  architecture_goal_count: 1,
  internal_milestones: 3,
  changed_paths: 25,
  patch_lines: 3000,
  repair_rounds: 2,
};

test("defaults match the card caps", () => {
  assert.equal(REVIEW_UNIT_DEFAULTS.repository_count, 1);
  assert.equal(REVIEW_UNIT_DEFAULTS.worktree_count, 1);
  assert.equal(REVIEW_UNIT_DEFAULTS.parent_card_count, 1);
  assert.equal(REVIEW_UNIT_DEFAULTS.architecture_goal_count, 1);
  assert.equal(REVIEW_UNIT_DEFAULTS.maximum_internal_milestones, 3);
  assert.equal(REVIEW_UNIT_DEFAULTS.maximum_changed_paths, 25);
  assert.equal(REVIEW_UNIT_DEFAULTS.maximum_patch_lines, 3000);
  assert.equal(REVIEW_UNIT_DEFAULTS.maximum_repair_rounds, 2);
});

test("within limits passes", () => {
  const g = evaluateReviewUnitGate({ authority, actual: within });
  assert.equal(g.allowed, true, g.violations.join("; "));
});

test("fail-closed: no review_unit authority → denied", () => {
  const g = evaluateReviewUnitGate({ authority: {}, actual: within });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("review_unit.allowed")));
});

test("[neg 21] any exceeded limit → HOLD / REVIEW_UNIT_LIMIT_EXCEEDED", () => {
  const cases = [
    { repository_count: 2 },
    { worktree_count: 2 },
    { parent_card_count: 2 },
    { architecture_goal_count: 2 },
    { internal_milestones: 4 },
    { changed_paths: 26 },
    { patch_lines: 3001 },
  ];
  for (const over of cases) {
    const g = evaluateReviewUnitGate({ authority, actual: { ...within, ...over } });
    assert.equal(g.allowed, false, JSON.stringify(over));
    const err = reviewUnitViolationsToHold(g.violations);
    assert.equal(err.code, GOV_HOLD.REVIEW_UNIT_LIMIT_EXCEEDED);
  }
});

test("[neg 22] repair budget exhausted → HOLD", () => {
  const g = evaluateReviewUnitGate({ authority, actual: { ...within, repair_rounds: 3 } });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("maximum_repair_rounds")));
});

test("[neg 23] repair caps must intersect: bounded_repair.max_rounds ∩ review_unit.maximum_repair_rounds (round 5 finding)", () => {
  // self-contradictory card: bounded_repair.max_rounds=2 vs
  // review_unit.maximum_repair_rounds=3 — the effective cap is min(2,3)=2
  const conflicted = {
    bounded_repair: entryBlock().bounded_repair, // max_rounds 2
    review_unit: { ...entryBlock().review_unit, maximum_repair_rounds: 3 },
  };
  // repair 3 is within review_unit.maximum_repair_rounds but exceeds the
  // effective cap → must be rejected, and the conflict itself is flagged
  const g = evaluateReviewUnitGate({ authority: conflicted, actual: { ...within, repair_rounds: 3 } });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("repair_cap_authority_conflict")));
  assert.ok(g.violations.some((v) => v.includes("maximum_repair_rounds")));
  assert.equal(g.limits.maximum_repair_rounds, 2, "effective cap = min(2,3)");

  // a consistent card (both caps 4) admits repair 4 and rejects repair 5
  const consistent = {
    bounded_repair: { ...entryBlock().bounded_repair, max_rounds: 4 },
    review_unit: { ...entryBlock().review_unit, maximum_repair_rounds: 4 },
  };
  const ok4 = evaluateReviewUnitGate({ authority: consistent, actual: { ...within, repair_rounds: 4 } });
  assert.equal(ok4.allowed, true, ok4.violations.join("; "));
  assert.equal(ok4.limits.maximum_repair_rounds, 4);
  const over4 = evaluateReviewUnitGate({ authority: consistent, actual: { ...within, repair_rounds: 5 } });
  assert.equal(over4.allowed, false);
  assert.ok(over4.violations.some((v) => v.includes("maximum_repair_rounds")));
});

test("early-stop conditions never expand the unit", () => {
  const stopKeys = Object.keys(REVIEW_UNIT_STOP_CONDITIONS);
  assert.ok(stopKeys.length >= 10);
  for (const key of stopKeys) {
    const g = evaluateReviewUnitGate({ authority, actual: within, stopConditions: [key] });
    assert.equal(g.allowed, false, key);
    const err = earlyStopHold(key);
    assert.equal(err.code, GOV_HOLD.REVIEW_UNIT_LIMIT_EXCEEDED);
  }
});

test("measured counts are rendered in limits shape", () => {
  const g = evaluateReviewUnitGate({ authority, actual: within });
  for (const f of REVIEW_UNIT_LIMIT_FIELDS) {
    assert.equal(typeof g.limits[f], "number");
  }
});
