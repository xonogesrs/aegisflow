// test/governance/test-push-gate.mjs
// §13.6 remote safety · §13.1 default deny

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePushGate, pushViolationsToHold } from "../../src/governance/feature-branch-push-gate.mjs";
import { normalizeAuthority, defaultDenyAuthority } from "../../src/governance/lifecycle-authorization.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";

const auth = normalizeAuthority({
  decomposition: { allowed: true, max_depth: 1, max_total_nodes: 16 },
  independent_review: { allowed: true, require_fresh_session: true, require_same_artifact_digest: true },
  bounded_repair: { allowed: true, max_rounds: 2, scope_expansion: false },
  checkpoint_commit: { allowed: true, require_local_gates_pass: true, require_clean_index_before_stage: true, require_expected_paths_only: true },
  feature_branch_push: { allowed: true, branch_pattern: "governance/*", force_push: false, require_remote_ancestor_check: true },
  draft_pr: { allowed: true, base_branch: "main", draft_only: true, create_if_missing: true, update_if_present: true },
  merge_main: { allowed: false },
  release: { allowed: false },
  seal: { allowed: false },
});

const ok = {
  authority: auth,
  branch: "governance/reversible-lifecycle-draft-pr",
  remoteBranch: "origin/governance/reversible-lifecycle-draft-pr",
  remoteReachable: true,
  remoteBranchKnown: true,
  upstream: "origin/governance/reversible-lifecycle-draft-pr",
  fastForwardOnly: true,
  force: false,
  commitIdentity: "c".repeat(40),
  reviewedArtifactIdentity: "c".repeat(40),
};

test("13.1 default deny: no push authorization blocks push", () => {
  const g = evaluatePushGate({ ...ok, authority: defaultDenyAuthority() });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.startsWith("push_allowed_by_authority")));
});

test("13.6 remote diverged → HOLD / REMOTE_BRANCH_DIVERGED", () => {
  const g = evaluatePushGate({ ...ok, fastForwardOnly: false });
  assert.equal(g.allowed, false);
  const err = pushViolationsToHold(g.violations, true);
  assert.equal(err.code, GOV_HOLD.REMOTE_BRANCH_DIVERGED);
});

test("13.6 unknown upstream → HOLD", () => {
  const g = evaluatePushGate({ ...ok, upstream: "" });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("local_has_expected_upstream")));
});

test("13.6 push target not authorized branch → HOLD", () => {
  const g = evaluatePushGate({ ...ok, branch: "feature/other" });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("target_branch_matches_pattern")));
});

test("13.6 protected branch push blocked", () => {
  const g = evaluatePushGate({ ...ok, branch: "main" });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("not_protected_branch")));
});

test("13.6 remote unreachable → blocked", () => {
  const g = evaluatePushGate({ ...ok, remoteReachable: false });
  assert.equal(g.allowed, false);
  const err = pushViolationsToHold(g.violations, false);
  assert.equal(err.code, GOV_HOLD.REMOTE_BRANCH_DIVERGED);
});

test("13.6 remote branch state unknown → blocked", () => {
  const g = evaluatePushGate({ ...ok, remoteBranchKnown: false });
  assert.equal(g.allowed, false);
});

test("13.4 force push always blocked", () => {
  const g = evaluatePushGate({ ...ok, force: true });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("no_force_push")));
});

test("13.5 commit identity must match reviewed artifact", () => {
  const g = evaluatePushGate({ ...ok, commitIdentity: "a".repeat(40), reviewedArtifactIdentity: "b".repeat(40) });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("commit does not match")));
});

test("valid fast-forward push passes", () => {
  const g = evaluatePushGate(ok);
  assert.equal(g.allowed, true, g.violations.join("; "));
});

test("new branch (no remote head) is a valid fast-forward", () => {
  const g = evaluatePushGate({ ...ok, remoteBranch: null, remoteBranchKnown: true, fastForwardOnly: true });
  assert.equal(g.allowed, true, g.violations.join("; "));
});
