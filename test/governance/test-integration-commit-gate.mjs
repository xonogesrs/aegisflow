// test/governance/test-integration-commit-gate.mjs
//
// R-11 canonical authority migration — integration-approved commit gate
// (§8.2). Authority derives from the CANONICAL promotion chain (review-job
// ACCEPTED → delivery PASS bound to the delivered bundle digest → recomputed
// candidate identity), evaluated by the SAME evaluatePromotionAuthority the
// push gate uses. The RC1A-retired external-review-result.json is NEVER read
// and grants nothing — a forged PASS copy of it cannot authorize integration
// (reverse control), and tampering it cannot revoke a valid canonical
// authorization (RC-D).
//
// Negatives: promotion not allowed / wrong delivery card / missing
// promotion / lifecycle / fresh verification / dirty worktree / local
// checkpoint conditions.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateIntegrationCommitGate,
  buildIntegrationFooter,
  integrationViolationsToHold,
} from "../../src/governance/integration-commit-gate.mjs";
import { normalizeAuthority } from "../../src/governance/lifecycle-authorization.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";
import { entryBlock, currentContext, CARD_ID, RUN_ID, BRANCH, AUTHORIZED_PATHS } from "./helpers.mjs";

const HEX64 = "0123456789abcdef".repeat(4);

const auth = normalizeAuthority(entryBlock());
const current = currentContext();

// Canonical promotion authority result as evaluatePromotionAuthority returns
// it for a fully matching chain (integration-neutral remote shape).
const allowedPromotion = {
  allowed: true,
  status: "PROMOTION_AUTHORIZED",
  identity: HEX64,
  violations: [],
};

const ok = {
  authority: auth,
  promotion: allowedPromotion,
  deliveryCardId: CARD_ID,
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

test("[neg A] promotion not allowed (delivery PENDING) blocks integration", () => {
  const held = { allowed: false, status: "HOLD", identity: HEX64, violations: ["HOLD / DELIVERY_NOT_PASS: externalReviewStatus/verdict is not PASS"] };
  const g = evaluateIntegrationCommitGate({ ...ok, promotion: held });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("delivery_pass_bound") && v.includes("DELIVERY_NOT_PASS")));
  const err = integrationViolationsToHold(g.violations);
  assert.equal(err.code, GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH);
});

test("[neg B] missing promotion result blocks integration (fail closed)", () => {
  const g = evaluateIntegrationCommitGate({ ...ok, promotion: null });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("delivery_pass_bound")));
  const err = integrationViolationsToHold(g.violations);
  assert.equal(err.code, GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH);
});

test("[neg C] wrong delivery card (Current rotated to another card) blocks", () => {
  const g = evaluateIntegrationCommitGate({ ...ok, deliveryCardId: "OTHER-CARD" });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("delivery_card_binding") && v.includes("OTHER-CARD")));
  const err = integrationViolationsToHold(g.violations);
  assert.equal(err.code, GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH);
});

test("[neg D] candidate identity mismatch inside promotion blocks", () => {
  const drifted = { ...allowedPromotion, allowed: false, status: "HOLD", violations: ["HOLD / CANDIDATE_IDENTITY_MISMATCH: recomputed tree != review-job"] };
  const g = evaluateIntegrationCommitGate({ ...ok, promotion: drifted });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("CANDIDATE_IDENTITY_MISMATCH")));
});

test("[neg E] base drift inside promotion blocks", () => {
  const drifted = { ...allowedPromotion, allowed: false, status: "HOLD", violations: ["HOLD / CANDIDATE_IDENTITY_MISMATCH: recomputed baseHead != review-job baseHead"] };
  assert.equal(evaluateIntegrationCommitGate({ ...ok, promotion: drifted }).allowed, false);
});

test("[neg F] HEAD drift inside promotion blocks", () => {
  const drifted = { ...allowedPromotion, allowed: false, status: "HOLD", violations: ["HOLD / HEAD_MISMATCH_LOCAL: local HEAD != reviewed"] };
  assert.equal(evaluateIntegrationCommitGate({ ...ok, promotion: drifted }).allowed, false);
});

test("[neg G] branch drift inside promotion blocks", () => {
  const drifted = { ...allowedPromotion, allowed: false, status: "HOLD", violations: ["HOLD / DELIVERY_STALE: branch != review-job branch"] };
  assert.equal(evaluateIntegrationCommitGate({ ...ok, promotion: drifted }).allowed, false);
});

test("[RC-B] retired artifact PASS + canonical PENDING cannot integrate", () => {
  // The gate sees ONLY the canonical promotion result; a retired artifact
  // claiming PASS is structurally invisible — the held canonical chain is
  // what blocks. This is the gate-level half of the reverse control.
  const held = { allowed: false, status: "HOLD", identity: HEX64, violations: ["HOLD / DELIVERY_NOT_PASS: PENDING"] };
  const g = evaluateIntegrationCommitGate({ ...ok, promotion: held });
  assert.equal(g.allowed, false);
});

test("[RC-C] forged retired artifact + broken canonical chain blocks", () => {
  // Forged artifact is never read; the broken chain alone decides.
  const broken = { allowed: false, status: "HOLD", identity: HEX64, violations: ["HOLD / REVIEW_JOB_NOT_ACCEPTED"] };
  const g = evaluateIntegrationCommitGate({ ...ok, promotion: broken });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("REVIEW_JOB_NOT_ACCEPTED")));
});

test("[RC-D] tampered retired artifact cannot revoke valid canonical authorization", () => {
  // The gate has no retired-artifact input at all: a tampered legacy file on
  // disk cannot appear in the decision. Canonical allowed → allowed.
  const g = evaluateIntegrationCommitGate(ok);
  assert.equal(g.allowed, true, g.violations.join("; "));
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

test("dirty worktree at integration time blocks (no new commit after review)", () => {
  const g = evaluateIntegrationCommitGate({ ...ok, worktreeDirty: true });
  assert.equal(g.allowed, false);
  assert.ok(g.violations.some((v) => v.includes("worktree_dirty")));
});

test("local conditions still apply (scope, branch, secrets)", () => {
  const badScope = evaluateIntegrationCommitGate({ ...ok, changedPaths: ["outside/x.txt"] });
  assert.equal(badScope.allowed, false);
  const badBranch = evaluateIntegrationCommitGate({ ...ok, branch: "main" });
  assert.equal(badBranch.allowed, false);
  const secrets = evaluateIntegrationCommitGate({ ...ok, secretLikeValues: ["AKIA-secret"] });
  assert.equal(secrets.allowed, false);
});

test("fully verified canonical chain passes the integration gate", () => {
  const g = evaluateIntegrationCommitGate(ok);
  assert.equal(g.allowed, true, g.violations.join("; "));
  assert.match(g.footer, /Review-Result: /);
  assert.match(g.footer, new RegExp(CARD_ID.replace(/[-]/g, "\\-")));
});

test("integration footer binds the canonical authority identity", () => {
  const f = buildIntegrationFooter({ cardId: "C", runId: "R", evidenceDigest: "d".repeat(64), reviewResultDigest: HEX64 });
  assert.match(f, /AutoLoop-Card: C/);
  assert.match(f, /Review-Result: /);
});

test("integration footer derives identity from canonical inputs only", () => {
  // current.cardId/runId (record-bound) — never a retired artifact field.
  const g = evaluateIntegrationCommitGate(ok);
  assert.match(g.footer, new RegExp(RUN_ID.replace(/[-]/g, "\\-")));
});
