// test/governance/test-checkpoint-commit-gate.mjs
// Internal checkpoint commit gate (§8.1): local rollback point, NO external
// review PASS requirement (neg 7), never pushed (push has its own post-PASS
// gate), full fail-closed local conditions + review-unit boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCheckpointCommitGate, buildCommitFooter } from "../../src/governance/checkpoint-commit-gate.mjs";
import { defaultDenyAuthority } from "../../src/governance/lifecycle-authorization.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";
import { entryBlock, entryRecord, CARD_ID, RUN_ID, BRANCH, AUTHORIZED_PATHS } from "./helpers.mjs";
import { normalizeAuthority } from "../../src/governance/lifecycle-authorization.mjs";

const auth = normalizeAuthority(entryBlock());

const ok = {
  authority: auth,
  branch: BRANCH,
  expectedPaths: [...AUTHORIZED_PATHS],
  changedPaths: ["src/governance/holds.mjs"],
  stagedPaths: [],
  diffCheckClean: true,
  verificationPassed: true,
  artifactIdentity: "sha256:abc",
  evidenceDigest: "e".repeat(64),
  reviewBlockingFindings: [],
  repairConverged: true,
  secretLikeValues: [],
  cardId: CARD_ID,
  runId: RUN_ID,
  milestoneId: "m1",
};

test("[neg 7] internal checkpoint does NOT require external review PASS", () => {
  // No externalReviewStatus concept exists in the checkpoint gate — the gate
  // passes with PENDING/absent external review state.
  const g = evaluateCheckpointCommitGate(ok);
  assert.equal(g.allowed, true, g.violations.join("; "));
  assert.equal(g.violations.length, 0);
  assert.ok(g.violations.every((v) => !v.includes("external_review")));
});

test("13.1 default deny: absent authorization blocks commit", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, authority: defaultDenyAuthority() });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.startsWith("checkpoint_commit.allowed")));
});

test("valid checkpoint commit passes all local conditions", () => {
  const g = evaluateCheckpointCommitGate(ok);
  assert.equal(g.allowed, true, g.violations.join("; "));
  assert.match(g.footer, /AutoLoop-Card: /);
  assert.match(g.footer, /Evidence-Digest: /);
});

test("branch must match pattern and not be protected", () => {
  const badBranch = evaluateCheckpointCommitGate({ ...ok, branch: "main" });
  assert.equal(badBranch.allowed, false);
  assert.ok(badBranch.violations.some((v) => v.includes("branch_not_protected")));
  const noPattern = evaluateCheckpointCommitGate({ ...ok, branch: "feature/x" });
  assert.equal(noPattern.allowed, false);
  assert.ok(noPattern.violations.some((v) => v.includes("branch_matches_authorized_pattern")));
});

test("changed paths outside scope blocked", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, changedPaths: ["outside/secret.txt"] });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("changed_paths_within_authorized_scope")));
});

test("unknown staged paths blocked (require_clean_index_before_stage)", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, stagedPaths: ["src/unexpected.mjs"] });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("no_unknown_staged_paths")));
});

test("diff check must be clean", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, diffCheckClean: false });
  assert.equal(g.allowed, false);
});

test("verification must pass", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, verificationPassed: false });
  assert.equal(g.allowed, false);
});

test("reviewer blocking finding blocks commit", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, reviewBlockingFindings: ["scope violation"] });
  assert.equal(g.allowed, false);
});

test("artifact identity must be fixed; evidence digest established", () => {
  assert.equal(evaluateCheckpointCommitGate({ ...ok, artifactIdentity: "" }).allowed, false);
  assert.equal(evaluateCheckpointCommitGate({ ...ok, evidenceDigest: "not-a-digest" }).allowed, false);
});

test("repair must converge or be an honest negative", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, repairConverged: false });
  assert.equal(g.allowed, false);
});

test("secret-like values block commit", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, secretLikeValues: ["AKIA-secret"] });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("no_secret_like_values")));
});

test("commit message must carry card identity", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, cardId: "" });
  assert.equal(g.allowed, false);
});

test("review-unit limits are enforced at runtime (neg 21 at gate level)", () => {
  const g = evaluateCheckpointCommitGate({
    ...ok,
    reviewUnitActual: {
      repository_count: 1, worktree_count: 1, parent_card_count: 1, architecture_goal_count: 1,
      internal_milestones: 4, changed_paths: 1, patch_lines: 10, repair_rounds: 0,
    },
  });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("review_unit.maximum_internal_milestones")));
});

test("[neg 22] repair budget exhausted blocks checkpoint", () => {
  const g = evaluateCheckpointCommitGate({
    ...ok,
    reviewUnitActual: {
      repository_count: 1, worktree_count: 1, parent_card_count: 1, architecture_goal_count: 1,
      internal_milestones: 1, changed_paths: 1, patch_lines: 10, repair_rounds: 3,
    },
  });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("maximum_repair_rounds")));
});

test("commit footer carries card/run/milestone/evidence identity", () => {
  const f = buildCommitFooter({ cardId: "C", runId: "R", milestoneId: "M", evidenceDigest: "d".repeat(64) });
  assert.match(f, /AutoLoop-Card: C/);
  assert.match(f, /AutoLoop-Run: R/);
  assert.match(f, /AutoLoop-Milestone: M/);
  assert.match(f, /Evidence-Digest: d+/);
});

test("irreversible sections never pass: merge/release/seal locked false", () => {
  const eff = auth;
  assert.equal(eff.merge_main.allowed, false);
  assert.equal(eff.release.allowed, false);
  assert.equal(eff.seal.allowed, false);
});
