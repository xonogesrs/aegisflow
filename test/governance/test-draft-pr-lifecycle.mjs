// test/governance/test-draft-pr-lifecycle.mjs
// §13.2 explicit allow (create/update, one PR per parent) · §13.4 irreversible

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDraftPrAction, buildDraftPrBody } from "../../src/governance/draft-pr-lifecycle.mjs";
import { normalizeAuthority, defaultDenyAuthority } from "../../src/governance/lifecycle-authorization.mjs";

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
  existingPrForParent: false,
  headBranch: "governance/reversible-lifecycle-draft-pr",
  baseBranch: "main",
  readyForReviewRequested: false,
};

test("13.1 default deny: no draft_pr authorization blocks PR actions", () => {
  const d = decideDraftPrAction({ ...ok, authority: defaultDenyAuthority() });
  assert.equal(d.action, "NONE");
  assert.ok(d.violations.some((v) => v.startsWith("draft_pr.allowed")));
});

test("13.2 draft PR create allowed when authorized and none exists", () => {
  const d = decideDraftPrAction(ok);
  assert.equal(d.action, "CREATE");
  assert.equal(d.violations.length, 0);
});

test("13.2 draft PR update allowed when already exists (same head branch)", () => {
  const d = decideDraftPrAction({ ...ok, existingPrForParent: true });
  assert.equal(d.action, "UPDATE");
});

test("13.2 one PR per parent card: existing PR is reused, never duplicated", () => {
  // the decision surface has no "CREATE another" path when a PR exists
  const d = decideDraftPrAction({ ...ok, existingPrForParent: true });
  assert.notEqual(d.action, "CREATE");
});

test("13.2 draft_only and base branch are enforced", () => {
  const wrongBase = decideDraftPrAction({ ...ok, baseBranch: "master" });
  assert.equal(wrongBase.action, "NONE");
  assert.ok(wrongBase.violations.some((v) => v.includes("base_branch mismatch")));
  const laxAuth = normalizeAuthority({
    ...auth,
    draft_pr: { allowed: true, base_branch: "main", draft_only: false, create_if_missing: true, update_if_present: true },
  });
  const lax = decideDraftPrAction({ ...ok, authority: laxAuth });
  assert.equal(lax.action, "NONE");
  assert.ok(lax.violations.some((v) => v.includes("draft_only")));
});

test("13.2 ready-for-review is never requested automatically", () => {
  const d = decideDraftPrAction({ ...ok, readyForReviewRequested: true });
  assert.equal(d.action, "NONE");
  assert.ok(d.violations.some((v) => v.includes("ready-for-review")));
});

test("13.4 draft PR never implies merge", () => {
  // decision has no merge path at all; authority merge_main is locked false
  assert.equal(auth.merge_main.allowed, false);
});

test("PR body contains all mandated sections", () => {
  const body = buildDraftPrBody({
    cardId: "C1",
    parentGoal: "Goal",
    currentMilestone: "M1",
    completed: ["a"],
    pending: ["b"],
    limitations: ["c"],
    verificationSummary: "tests pass",
    commitEvidence: ["abc"],
    evidenceDigests: ["d".repeat(64)],
    irreversibleStatement: "no merge",
  });
  for (const section of ["研究案／父卡目標", "目前 Milestone", "已完成項目", "尚未完成項目", "已知限制", "驗證摘要", "Commit 與 Evidence 關係", "Evidence Digests", "不可逆操作聲明"]) {
    assert.match(body, new RegExp(section));
  }
});
