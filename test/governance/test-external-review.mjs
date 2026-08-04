// test/governance/test-external-review.mjs
// External review statuses, bundle digest contract, harness-owned
// external-review-result artifact (§9) and digest-bound verification
// (neg 3/4/5/6/13/14 at the artifact level).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_REVIEW_STATUSES,
  isValidExternalReviewStatus,
  requireExternalReviewPass,
  externalReviewRequired,
  digestOfPayload,
  digestOfChangeSet,
  buildBundleHeader,
  renderProhibitedActions,
  EXTERNAL_REVIEW_STOP,
  RESULT_ARTIFACT_SCHEMA,
  validateExternalReviewResult,
  verifyExternalReviewResult,
  isExternalReviewPassed,
} from "../../src/governance/external-review.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";
import { validResult, currentContext, CARD_ID, RUN_ID } from "./helpers.mjs";

test("A-8: status enum is closed", () => {
  assert.deepEqual(EXTERNAL_REVIEW_STATUSES, ["PENDING", "PASS", "REPAIR", "HOLD"]);
  assert.equal(isValidExternalReviewStatus("PENDING"), true);
  assert.equal(isValidExternalReviewStatus("MERGE"), false);
});

test("A-8: requireExternalReviewPass fails closed on non-PASS when required", () => {
  const auth = { external_review: { required: true } };
  assert.throws(() => requireExternalReviewPass("PENDING", auth), (e) => e.code === GOV_HOLD.DRAFT_PR_GATE_VIOLATION);
  assert.equal(requireExternalReviewPass("PASS", auth), "PASS");
});

test("A-8: externalReviewRequired reflects authority", () => {
  assert.equal(externalReviewRequired({ external_review: { required: true } }), true);
  assert.equal(externalReviewRequired({}), false);
});

test("A-8: digests are computed, not trust-input", () => {
  assert.match(digestOfPayload("abc"), /^[0-9a-f]{64}$/);
  const changes = [
    { path: "a.mjs", status: "ADDED", digest: digestOfPayload("x") },
    { path: "b.mjs", status: "MODIFIED", digest: digestOfPayload("y") },
  ];
  const d1 = digestOfChangeSet(changes);
  assert.match(d1, /^[0-9a-f]{64}$/);
  assert.equal(d1, digestOfChangeSet(changes));
  const d2 = digestOfChangeSet([{ path: "a.mjs", status: "ADDED", digest: digestOfPayload("z") }, changes[1]]);
  assert.notEqual(d1, d2);
});

test("A-8: bundle header carries schema identity", () => {
  const h = buildBundleHeader({ cardId: "C1", cardTitle: "T", repository: "r", branch: "b", baseBranch: "main", baseHead: "0".repeat(40), currentHead: "1".repeat(40), worktree: "CLEAN", agent: "test" });
  assert.equal(h.bundle_schema, "autoloop.external-review-bundle/v1");
});

test("A-8: prohibited actions section declares NO on all irreversible ops", () => {
  const text = renderProhibitedActions({ bounded_repair: { max_rounds: 2 } });
  assert.match(text, /COMMIT_AUTHORIZED: NO/);
  assert.match(text, /PUSH_AUTHORIZED: NO/);
  assert.match(text, /DRAFT_PR_AUTHORIZED: NO/);
  assert.match(text, /MERGE_AUTHORIZED: NO/);
  assert.match(text, /RELEASE_AUTHORIZED: NO/);
  assert.match(text, /SEAL_AUTHORIZED: NO/);
});

test("A-8: wait-for-external-review stop code is fixed", () => {
  assert.equal(EXTERNAL_REVIEW_STOP.WAITING, "HOLD / WAITING_FOR_EXTERNAL_REVIEW");
});

// ---------------------------------------------------------------------------
// Result artifact (§9)
// ---------------------------------------------------------------------------

test("result artifact schema identity is pinned", () => {
  assert.equal(RESULT_ARTIFACT_SCHEMA, "autoloop.external-review-result/v1");
});

test("valid result artifact passes validation", () => {
  assert.equal(validateExternalReviewResult(validResult()).valid, true);
});

test("result artifact rejects missing/extra fields and bad verdicts", () => {
  const missing = validResult();
  delete missing.findings_digest;
  assert.equal(validateExternalReviewResult(missing).valid, false);
  const badVerdict = validResult({ verdict: "MERGE" });
  assert.equal(validateExternalReviewResult(badVerdict).valid, false);
  const extra = validResult({ agent_says_pass: true });
  assert.equal(validateExternalReviewResult(extra).valid, false);
  const badDigest = validResult({ bundle_sha256: "not-a-digest" });
  assert.equal(validateExternalReviewResult(badDigest).valid, false);
});

test("verified PASS requires recomputed identities to match", () => {
  assert.equal(isExternalReviewPassed({ result: validResult(), current: currentContext() }), true);
});

test("[neg 3] bundle digest mismatch → identity violation", () => {
  const tampered = validResult({ bundle_sha256: "0".repeat(64) });
  const violations = verifyExternalReviewResult({ result: tampered, current: currentContext() });
  assert.ok(violations.some((v) => v.includes("bundle_sha256")));
  assert.equal(isExternalReviewPassed({ result: tampered, current: currentContext() }), false);
});

test("[neg 4] patch digest mismatch → identity violation", () => {
  const tampered = validResult({ patch_sha256: "0".repeat(64) });
  const violations = verifyExternalReviewResult({ result: tampered, current: currentContext() });
  assert.ok(violations.some((v) => v.includes("patch_sha256")));
});

test("[neg 5] changed-tree mismatch → identity violation", () => {
  const tampered = validResult({ changed_tree_identity: "0".repeat(64) });
  const violations = verifyExternalReviewResult({ result: tampered, current: currentContext() });
  assert.ok(violations.some((v) => v.includes("changed_tree_identity")));
});

test("[neg 6] result card/run mismatch → identity violation", () => {
  const wrongCard = validResult({ card_id: "OTHER-CARD" });
  const wrongRun = validResult({ run_id: "run-other" });
  assert.ok(verifyExternalReviewResult({ result: wrongCard, current: currentContext() }).some((v) => v.includes("card_id")));
  assert.ok(verifyExternalReviewResult({ result: wrongRun, current: currentContext() }).some((v) => v.includes("run_id")));
});

test("[neg 13] repo/branch/base/head mismatch → identity violation", () => {
  const ctx = currentContext();
  const cases = [
    validResult({ repository: "other/repo" }),
    validResult({ branch: "main" }),
    validResult({ base_branch: "master" }),
    validResult({ current_head: "0".repeat(40) }),
    validResult({ base_head: "0".repeat(40) }),
  ];
  for (const r of cases) {
    const violations = verifyExternalReviewResult({ result: r, current: ctx });
    assert.ok(violations.length > 0, JSON.stringify(r));
    assert.equal(isExternalReviewPassed({ result: r, current: ctx }), false);
  }
});

test("[neg 14] bundle path mismatch → identity violation", () => {
  const tampered = validResult({ bundle_path: "/elsewhere/READY_FOR_REVIEW.txt" });
  const ctx = currentContext({ bundlePath: "~/Desktop/AutoLoop-Review/READY_FOR_REVIEW.txt" });
  const violations = verifyExternalReviewResult({ result: tampered, current: ctx });
  assert.ok(violations.some((v) => v.includes("bundle_path")), violations.join("; "));
});

test("review round mismatch → identity violation", () => {
  const stale = validResult({ review_round: 2 });
  const violations = verifyExternalReviewResult({ result: stale, current: currentContext({ reviewRound: 1 }) });
  assert.ok(violations.some((v) => v.includes("review_round")));
});

test("[neg 1] self-declared PASS (agent identity) is rejected", () => {
  const self = validResult({ reviewer_identity: "pi-deepseek-v4-flash" });
  const violations = verifyExternalReviewResult({ result: self, current: currentContext({ agentIdentity: "pi-deepseek-v4-flash" }) });
  assert.ok(violations.some((v) => v.includes("self-declared") || v.includes("agent itself")));
  assert.equal(isExternalReviewPassed({ result: self, current: currentContext({ agentIdentity: "pi-deepseek-v4-flash" }) }), false);
  const agentPrefix = validResult({ reviewer_identity: "agent:external" });
  assert.ok(verifyExternalReviewResult({ result: agentPrefix, current: currentContext() }).length > 0);
});

test("REPAIR verdict is never a PASS", () => {
  const repair = validResult({ verdict: "REPAIR" });
  assert.equal(isExternalReviewPassed({ result: repair, current: currentContext() }), false);
  assert.ok(verifyExternalReviewResult({ result: repair, current: currentContext() }).some((v) => v.includes("verdict")));
});
