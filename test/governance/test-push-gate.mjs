// test/governance/test-push-gate.mjs
// Feature-branch push gate (§8/§13): only after a verified digest-bound
// external review PASS. neg 1: self-declared PASS rejected; neg 8: no push
// without verified result artifact (PENDING blocks); remote safety fail-closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePushGate, pushViolationsToHold } from "../../src/governance/feature-branch-push-gate.mjs";
import { normalizeAuthority, defaultDenyAuthority } from "../../src/governance/lifecycle-authorization.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";
import { entryBlock, validResult, currentContext, BRANCH } from "./helpers.mjs";

const auth = normalizeAuthority(entryBlock());
const result = validResult();
const current = currentContext();

const ok = {
  authority: auth,
  branch: BRANCH,
  remoteBranch: `origin/${BRANCH}`,
  remoteReachable: true,
  remoteBranchKnown: true,
  upstream: `origin/${BRANCH}`,
  fastForwardOnly: true,
  force: false,
  result,
  current,
  lifecycleState: "EXTERNAL_REVIEW_PASS",
};

test("[neg 1] self-declared PASS rejected at push gate", () => {
  const self = validResult({ reviewer_identity: "pi-deepseek-v4-flash" });
  const g = evaluatePushGate({ ...ok, result: self });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("self-declared") || v.includes("agent itself")));
  const err = pushViolationsToHold(g.violations);
  assert.equal(err.code, GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH);
});

test("[neg 8] no verified result artifact (PENDING) blocks push", () => {
  const g = evaluatePushGate({ ...ok, result: null });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("external_review_result_verified")));
  const err = pushViolationsToHold(g.violations);
  assert.equal(err.code, GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH);
});

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

test("13.6 unknown upstream / unreachable remote → HOLD", () => {
  assert.equal(evaluatePushGate({ ...ok, upstream: "" }).allowed, false);
  const g = evaluatePushGate({ ...ok, remoteReachable: false });
  const err = pushViolationsToHold(g.violations, false);
  assert.equal(err.code, GOV_HOLD.REMOTE_BRANCH_DIVERGED);
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

test("13.4 force push always blocked", () => {
  const g = evaluatePushGate({ ...ok, force: true });
  assert.equal(g.allowed, false);
});

test("drifted HEAD vs reviewed head blocked", () => {
  const g = evaluatePushGate({ ...ok, current: currentContext({ currentHead: "9".repeat(40) }) });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("drifted")));
});

test("lifecycle state must be EXTERNAL_REVIEW_PASS / INTEGRATION_READY", () => {
  const g = evaluatePushGate({ ...ok, lifecycleState: "WAITING_FOR_EXTERNAL_REVIEW" });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("lifecycle_state")));
  assert.equal(evaluatePushGate({ ...ok, lifecycleState: "INTEGRATION_READY" }).allowed, true);
});

test("valid verified fast-forward push passes", () => {
  const g = evaluatePushGate(ok);
  assert.equal(g.allowed, true, g.violations.join("; "));
});

test("new branch (no remote head) is a valid fast-forward with verified result", () => {
  const g = evaluatePushGate({ ...ok, remoteBranch: null, remoteBranchKnown: true, fastForwardOnly: true });
  assert.equal(g.allowed, true, g.violations.join("; "));
});
