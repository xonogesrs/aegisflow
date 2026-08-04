// test/governance/test-integration-commit-gate.mjs
// Integration-approved commit gate (§8.2): reads the harness-owned result
// artifact, recomputes identities, requires verdict PASS + fresh verification.
// neg 1: self-declared PASS cannot pass
// neg 2: missing result artifact cannot commit an integration checkpoint
// neg 3/4/5/6: bundle / patch / changed-tree / card-run mismatches block

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateIntegrationCommitGate,
  buildIntegrationFooter,
  integrationViolationsToHold,
} from "../../src/governance/integration-commit-gate.mjs";
import { normalizeAuthority } from "../../src/governance/lifecycle-authorization.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";
import { entryBlock, validResult, currentContext, CARD_ID, RUN_ID, BRANCH, AUTHORIZED_PATHS } from "./helpers.mjs";

const auth = normalizeAuthority(entryBlock());
const result = validResult();
const current = currentContext();

const ok = {
  authority: auth,
  result,
  current,
  lifecycleState: "EXTERNAL_REVIEW_PASS",
  verificationPassed: true,
  branch: BRANCH,
  expectedPaths: [...AUTHORIZED_PATHS],
  changedPaths: ["src/governance/holds.mjs"],
  stagedPaths: [],
  diffCheckClean: true,
  artifactIdentity: "sha256:abc",
  evidenceDigest: "e".repeat(64),
  reviewBlockingFindings: [],
  repairConverged: true,
  secretLikeValues: [],
  cardId: CARD_ID,
  runId: RUN_ID,
  milestoneId: "integration",
};

test("[neg 1] self-declared PASS (agent as reviewer) cannot pass", () => {
  const self = validResult({ reviewer_identity: "pi-deepseek-v4-flash" });
  const g = evaluateIntegrationCommitGate({ ...ok, result: self });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("self-declared") || v.includes("agent itself")));
  const err = integrationViolationsToHold(g.violations);
  assert.equal(err.code, GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH);
});

test("[neg 2] missing result artifact cannot commit integration checkpoint", () => {
  const g = evaluateIntegrationCommitGate({ ...ok, result: null });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("result_artifact_present")));
  const err = integrationViolationsToHold(g.violations);
  assert.equal(err.code, GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH);
});

test("[neg 3] bundle digest mismatch blocks integration commit", () => {
  const tampered = validResult({ bundle_sha256: "0".repeat(64) });
  const g = evaluateIntegrationCommitGate({ ...ok, result: tampered });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("bundle_sha256")));
});

test("[neg 4] patch digest mismatch blocks integration commit", () => {
  const tampered = validResult({ patch_sha256: "0".repeat(64) });
  const g = evaluateIntegrationCommitGate({ ...ok, result: tampered });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("patch_sha256")));
});

test("[neg 5] changed-tree mismatch blocks integration commit", () => {
  const tampered = validResult({ changed_tree_identity: "0".repeat(64) });
  const g = evaluateIntegrationCommitGate({ ...ok, result: tampered });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("changed_tree_identity")));
});

test("[neg 6] result card/run mismatch blocks integration commit", () => {
  const wrongCard = validResult({ card_id: "OTHER" });
  const g = evaluateIntegrationCommitGate({ ...ok, result: wrongCard });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("card_id")));
  const wrongRun = validResult({ run_id: "run-x" });
  assert.equal(evaluateIntegrationCommitGate({ ...ok, result: wrongRun }).allowed, false);
});

test("REPAIR verdict never passes integration gate", () => {
  const g = evaluateIntegrationCommitGate({ ...ok, result: validResult({ verdict: "REPAIR" }) });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("verdict")));
});

test("lifecycle state must be EXTERNAL_REVIEW_PASS / INTEGRATION_READY", () => {
  const g = evaluateIntegrationCommitGate({ ...ok, lifecycleState: "WAITING_FOR_EXTERNAL_REVIEW" });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("lifecycle_state_integration_ready")));
  assert.equal(evaluateIntegrationCommitGate({ ...ok, lifecycleState: "INTEGRATION_READY" }).allowed, true);
});

test("fresh full verification is mandatory", () => {
  const g = evaluateIntegrationCommitGate({ ...ok, verificationPassed: false });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("fresh_full_verification_pass")));
});

test("local conditions still apply (scope, branch, secrets)", () => {
  const badScope = evaluateIntegrationCommitGate({ ...ok, changedPaths: ["outside/x.txt"] });
  assert.equal(badScope.allowed, false);
  const badBranch = evaluateIntegrationCommitGate({ ...ok, branch: "main" });
  assert.equal(badBranch.allowed, false);
  const secrets = evaluateIntegrationCommitGate({ ...ok, secretLikeValues: ["AKIA-secret"] });
  assert.equal(secrets.allowed, false);
});

test("fully verified PASS passes the integration gate", () => {
  const g = evaluateIntegrationCommitGate(ok);
  assert.equal(g.allowed, true, g.violations.join("; "));
  assert.match(g.footer, /Review-Result: /);
});

test("integration footer binds review-result digest", () => {
  const f = buildIntegrationFooter({ cardId: "C", runId: "R", evidenceDigest: "d".repeat(64), reviewResultDigest: "c".repeat(64) });
  assert.match(f, /AutoLoop-Card: C/);
  assert.match(f, /Review-Result: c+/);
});
