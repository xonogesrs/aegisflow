// test/governance/test-draft-pr-lifecycle.mjs
// Draft PR lifecycle (§13): post-external-PASS integration record only.
// neg 1: self-declared PASS rejected; neg 19: a non-draft PR on the same
// head is never directly updated; never ready / never merge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDraftPrAction, buildDraftPrBody, prViolationsToHold } from "../../src/governance/draft-pr-lifecycle.mjs";
import { normalizeAuthority, defaultDenyAuthority } from "../../src/governance/lifecycle-authorization.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";
import { entryBlock, validResult, currentContext, CARD_ID, BRANCH } from "./helpers.mjs";

const auth = normalizeAuthority(entryBlock());
const result = validResult();
const current = currentContext();

const ok = {
  authority: auth,
  result,
  current,
  existingPrForParent: false,
  existingPrDraft: null,
  headBranch: BRANCH,
  baseBranch: "main",
  cardId: CARD_ID,
  readyForReviewRequested: false,
  lifecycleState: "EXTERNAL_REVIEW_PASS",
};

test("[neg 1] self-declared PASS rejected at Draft PR gate", () => {
  const self = validResult({ reviewer_identity: "pi-deepseek-v4-flash" });
  const d = decideDraftPrAction({ ...ok, result: self });
  assert.equal(d.action, "NONE");
  assert.ok(d.violations.some((v) => v.includes("self-declared") || v.includes("agent itself")));
  const err = prViolationsToHold(d.violations);
  assert.equal(err.code, GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH);
});

test("no verified result artifact (PENDING) blocks Draft PR", () => {
  const d = decideDraftPrAction({ ...ok, result: null });
  assert.equal(d.action, "NONE");
  assert.ok(d.violations.some((v) => v.includes("external_review_result")));
});

test("13.1 default deny: no draft_pr authorization blocks PR actions", () => {
  const d = decideDraftPrAction({ ...ok, authority: defaultDenyAuthority() });
  assert.equal(d.action, "NONE");
  assert.ok(d.violations.some((v) => v.startsWith("draft_pr.allowed")));
});

test("13.2 draft PR create allowed when authorized, verified and none exists", () => {
  const d = decideDraftPrAction(ok);
  assert.equal(d.action, "CREATE");
  assert.equal(d.violations.length, 0);
});

test("13.2 draft PR update allowed when verified and existing PR is draft", () => {
  const d = decideDraftPrAction({ ...ok, existingPrForParent: true, existingPrDraft: true });
  assert.equal(d.action, "UPDATE");
});

test("[neg 19] non-draft existing PR on same head → direct UPDATE denied", () => {
  const d = decideDraftPrAction({ ...ok, existingPrForParent: true, existingPrDraft: false });
  assert.equal(d.action, "NONE");
  assert.ok(d.violations.some((v) => v.includes("NOT a draft")));
  const unknown = decideDraftPrAction({ ...ok, existingPrForParent: true, existingPrDraft: null });
  assert.equal(unknown.action, "NONE");
  assert.ok(unknown.violations.some((v) => v.includes("draft state unknown")));
});

test("13.2 one PR per parent card: existing PR is reused, never duplicated", () => {
  const d = decideDraftPrAction({ ...ok, existingPrForParent: true, existingPrDraft: true });
  assert.notEqual(d.action, "CREATE");
});

test("13.2 draft_only and base branch are enforced", () => {
  const wrongBase = decideDraftPrAction({ ...ok, baseBranch: "master" });
  assert.equal(wrongBase.action, "NONE");
  assert.ok(wrongBase.violations.some((v) => v.includes("base_branch mismatch")));
});

test("13.2 ready-for-review is never requested automatically", () => {
  const d = decideDraftPrAction({ ...ok, readyForReviewRequested: true });
  assert.equal(d.action, "NONE");
  assert.ok(d.violations.some((v) => v.includes("ready-for-review")));
});

test("lifecycle state must be EXTERNAL_REVIEW_PASS / INTEGRATION_READY", () => {
  const d = decideDraftPrAction({ ...ok, lifecycleState: "WAITING_FOR_EXTERNAL_REVIEW" });
  assert.equal(d.action, "NONE");
  assert.ok(d.violations.some((v) => v.includes("lifecycle_state")));
  assert.equal(decideDraftPrAction({ ...ok, lifecycleState: "INTEGRATION_READY" }).action, "CREATE");
});

test("repository / card / head binding mismatch blocks Draft PR", () => {
  const repo = decideDraftPrAction({ ...ok, result: validResult({ repository: "other/repo" }) });
  assert.equal(repo.action, "NONE");
  const card = decideDraftPrAction({ ...ok, result: validResult({ card_id: "OTHER" }) });
  assert.equal(card.action, "NONE");
  const head = decideDraftPrAction({ ...ok, result: validResult({ branch: "other/branch" }) });
  assert.equal(head.action, "NONE");
});

test("13.4 draft PR never implies merge", () => {
  assert.equal(auth.merge_main.allowed, false);
});

test("PR body contains all mandated sections + review result binding", () => {
  const body = buildDraftPrBody({
    cardId: CARD_ID,
    runId: "run-1",
    parentGoal: "Goal",
    currentMilestone: "M1",
    completed: ["a"],
    pending: ["b"],
    limitations: ["c"],
    verificationSummary: "tests pass",
    commitEvidence: ["abc"],
    evidenceDigests: ["d".repeat(64)],
    irreversibleStatement: "no merge",
    reviewResultDigest: "c".repeat(64),
    bundlePath: "~/Desktop/AutoLoop-Review/READY_FOR_REVIEW.txt",
  });
  for (const sectionName of ["研究案／父卡目標", "目前 Milestone", "已完成項目", "尚未完成項目", "已知限制", "驗證摘要", "Commit 與 Evidence 關係", "Evidence Digests", "External Review Result", "不可逆操作聲明"]) {
    assert.match(body, new RegExp(sectionName));
  }
  assert.match(body, new RegExp(`Review-Result Digest: c+`));
});
