// test/governance/test-checkpoint-commit-gate.mjs
// §13.1 default deny · §13.4 irreversible gates · §13.5 artifact & review

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCheckpointCommitGate, buildCommitFooter } from "../../src/governance/checkpoint-commit-gate.mjs";
import { normalizeAuthority, defaultDenyAuthority, validateLifecycleAuthorization } from "../../src/governance/lifecycle-authorization.mjs";
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
  expectedPaths: ["src/governance/", "src/schema/lifecycle-authorization.schema.json", "scripts/", "test/governance/", "docs/governance/"],
  changedPaths: ["src/governance/holds.mjs"],
  stagedPaths: [],
  diffCheckClean: true,
  verificationPassed: true,
  artifactIdentity: "sha256:abc",
  evidenceDigest: "e".repeat(64),
  reviewBlockingFindings: [],
  repairConverged: true,
  secretLikeValues: [],
  cardId: "AUTOLOOP-GOVERNANCE-REVERSIBLE-LIFECYCLE-1",
  runId: "run-1",
  milestoneId: "m1",
};

test("13.1 default deny: absent authorization blocks commit", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, authority: defaultDenyAuthority() });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.startsWith("checkpoint_commit.allowed")));
});

test("valid checkpoint commit passes the full 12-condition gate", () => {
  const g = evaluateCheckpointCommitGate(ok);
  assert.equal(g.allowed, true, g.violations.join("; "));
  assert.equal(g.violations.length, 0);
  assert.match(g.footer, /AutoLoop-Card: /);
  assert.match(g.footer, /Evidence-Digest: /);
});

test("§7 condition: branch must match pattern and not be protected", () => {
  const badBranch = evaluateCheckpointCommitGate({ ...ok, branch: "main" });
  assert.equal(badBranch.allowed, false);
  assert.ok(badBranch.violations.some((v) => v.includes("branch_not_protected")));
  const noPattern = evaluateCheckpointCommitGate({ ...ok, branch: "feature/x" });
  assert.equal(noPattern.allowed, false);
  assert.ok(noPattern.violations.some((v) => v.includes("branch_matches_authorized_pattern")));
});

test("§7 condition: changed paths outside scope blocked", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, changedPaths: ["outside/secret.txt"] });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("changed_paths_within_authorized_scope")));
});

test("§7 condition: unknown staged paths blocked (require_clean_index_before_stage)", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, stagedPaths: ["src/unexpected.mjs"] });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("no_unknown_staged_paths")));
});

test("§7 condition: diff check must be clean", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, diffCheckClean: false });
  assert.equal(g.allowed, false);
});

test("§7 condition: verification must pass", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, verificationPassed: false });
  assert.equal(g.allowed, false);
});

test("13.5 §7 condition: reviewer blocking finding blocks commit", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, reviewBlockingFindings: ["scope violation"] });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("no_blocking_review_finding")));
});

test("13.5 §7 condition: artifact identity must be fixed", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, artifactIdentity: "" });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("artifact_identity_fixed")));
});

test("13.5 §7 condition: evidence digest must be established", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, evidenceDigest: "not-a-digest" });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("evidence_digest_established")));
});

test("13.5 §7 condition: repair must converge or be an honest negative", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, repairConverged: false });
  assert.equal(g.allowed, false);
});

test("§7 condition: secret-like values block commit", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, secretLikeValues: ["secret-placeholder-not-real"] });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("no_secret_like_values")));
});

test("§7 condition: commit message must carry card identity", () => {
  const g = evaluateCheckpointCommitGate({ ...ok, cardId: "" });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("commit_message_has_identity")));
});

test("13.4 irreversible sections never pass: merge/release/seal locked false", () => {
  const eff = auth;
  assert.equal(eff.merge_main.allowed, false);
  assert.equal(eff.release.allowed, false);
  assert.equal(eff.seal.allowed, false);
  // schema validation rejects any attempt to flip them
  const badMerge = { ...rawAuth(), merge_main: { allowed: true } };
  assert.equal(validateLifecycleAuthorization(badMerge).valid, false);
  const badSeal = { ...rawAuth(), seal: { allowed: true } };
  assert.equal(validateLifecycleAuthorization(badSeal).valid, false);
});

test("commit footer carries card/run/milestone/evidence identity", () => {
  const f = buildCommitFooter({ cardId: "C", runId: "R", milestoneId: "M", evidenceDigest: "d".repeat(64) });
  assert.match(f, /AutoLoop-Card: C/);
  assert.match(f, /AutoLoop-Run: R/);
  assert.match(f, /AutoLoop-Milestone: M/);
  assert.match(f, /Evidence-Digest: d+/);
});

function rawAuth() {
  return {
    decomposition: { allowed: true, max_depth: 1, max_total_nodes: 16 },
    independent_review: { allowed: true, require_fresh_session: true, require_same_artifact_digest: true },
    bounded_repair: { allowed: true, max_rounds: 2, scope_expansion: false },
    checkpoint_commit: { allowed: true, require_local_gates_pass: true, require_clean_index_before_stage: true, require_expected_paths_only: true },
    feature_branch_push: { allowed: true, branch_pattern: "governance/*", force_push: false, require_remote_ancestor_check: true },
    draft_pr: { allowed: true, base_branch: "main", draft_only: true, create_if_missing: true, update_if_present: true },
    merge_main: { allowed: false },
    release: { allowed: false },
    seal: { allowed: false },
  };
}
