// src/governance/integration-commit-gate.mjs
//
// Integration-approved commit gate (AUTOLOOP-GOVERNANCE-REVIEW-UNIT-
// FINALIZATION-1 §8.2). Distinct from the internal checkpoint gate: this one
// attests the *reviewed* review unit after the CANONICAL external review
// PASS (R-11 migration: the RC1A-retired `external-review-result.json` is
// NEVER read and grants nothing — RC1A §7.2).
//
// The gate refuses to trust:
//   - `--external-review-status PASS`            (self-declaration)
//   - `--reviewed-artifact-identity <caller>`    (caller-supplied identity)
//   - the retired external-review-result artifact (any content, any state)
//
// Authority derives from the canonical chain supplied by the caller (the
// attestation CLI evaluates it with the SAME promotion-authority module the
// push gate uses): review-job ACCEPTED → delivery PASS bound to the
// delivered bundle digest → recomputed candidate identity == review-job
// candidate identity. Any mismatch → HOLD / EVIDENCE_IDENTITY_MISMATCH.
// Fresh full verification is mandatory.


import { GOV_HOLD, hold } from "./holds.mjs";
import { evaluateCheckpointCommitGate } from "./checkpoint-commit-gate.mjs";

export const INTEGRATION_GATE_CONDITIONS = Object.freeze([
  "review_job_accepted",
  "delivery_pass_bound",
  "delivered_bundle_digest_matches",
  "candidate_identity_matches",
  "head_base_branch_match",
  "delivery_card_binding",
  "lifecycle_state_integration_ready",
  "local_conditions_pass",
  "fresh_full_verification_pass",
]);

/**
 * Evaluate the integration-approved commit gate.
 *
 * @param {object} args — combine checkpoint-style conditions with the
 *   canonical promotion authority result:
 *   promotion       — result of evaluatePromotionAuthority (canonical
 *                     chain: review-job ACCEPTED + delivery PASS bound to
 *                     the delivered bundle digest + recomputed candidate
 *                     identity/head/base/branch). Must be allowed.
 *   deliveryCardId  — cardId of the canonical delivery record; must match
 *                     the attested card (card/candidate mismatch fails
 *                     closed — Current-surface rotation safety).
 *   current         — recomputed { cardId, runId, ... } from the live
 *                     inventory (identity fields already compared inside
 *                     evaluatePromotionAuthority).
 *   plus all evaluateCheckpointCommitGate args (branch, expectedPaths, ...).
 * @returns {{allowed: boolean, violations: string[], footer: string}}
 */
export function evaluateIntegrationCommitGate({
  authority,
  promotion,
  deliveryCardId,
  current,
  lifecycleState = "EXTERNAL_REVIEW_PASS",
  verificationPassed = false,
  worktreeDirty = false,
  ...checkpointArgs
}) {
  const violations = [];

  if (worktreeDirty) {
    violations.push("worktree_dirty: reviewed tree must not drift — no new commit is permitted after review");
  }

  // Canonical authority leg (R-11): the retired result artifact plays no
  // role. `promotion` must be an ALLOWED evaluation of the canonical chain;
  // anything else (missing, HOLD, wrong card binding) fails closed.
  if (!promotion || promotion.allowed !== true) {
    violations.push(`delivery_pass_bound: canonical promotion authority not satisfied${promotion?.violations?.length ? ` (${promotion.violations.join("; ")})` : ""}`);
  } else if (deliveryCardId && current?.cardId && deliveryCardId !== current.cardId) {
    violations.push(`delivery_card_binding: delivery cardId ${deliveryCardId} != attested card ${current.cardId}`);
  }

  if (!["EXTERNAL_REVIEW_PASS", "INTEGRATION_READY"].includes(lifecycleState)) {
    violations.push(`lifecycle_state_integration_ready: state is ${lifecycleState}`);
  }

  // Local conditions (scope, branch pattern, index, diff-check, no secrets,
  // review-unit limits) — same rigor as the checkpoint gate.
  const local = evaluateCheckpointCommitGate({ ...checkpointArgs, authority, verificationPassed });
  violations.push(...local.violations);

  if (verificationPassed !== true) violations.push("fresh_full_verification_pass: fresh full verification not passed");

  const footer = buildIntegrationFooter({
    cardId: current?.cardId ?? checkpointArgs.cardId ?? "",
    runId: current?.runId ?? checkpointArgs.runId ?? "",
    evidenceDigest: checkpointArgs.evidenceDigest ?? "",
    reviewResultDigest: promotion?.identity ?? "",
  });
  return { allowed: violations.length === 0, violations, footer };
}

export function buildIntegrationFooter({ cardId, runId, evidenceDigest, reviewResultDigest }) {
  const lines = [];
  if (cardId) lines.push(`AutoLoop-Card: ${cardId}`);
  if (runId) lines.push(`AutoLoop-Run: ${runId}`);
  if (evidenceDigest) lines.push(`Evidence-Digest: ${evidenceDigest}`);
  if (reviewResultDigest) lines.push(`Review-Result: ${reviewResultDigest}`);
  return lines.length ? `\n\n${lines.join("\n")}\n` : "";
}

export function integrationViolationsToHold(violations) {
  if (!violations || violations.length === 0) return null;
  const identityHits = violations.filter((v) => v.includes("delivery_") || v.includes("delivery_pass_bound") || v.includes("delivery_card_binding"));
  if (identityHits.length > 0) {
    return hold(GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH, identityHits.join("; "));
  }
  return hold(GOV_HOLD.INTEGRATION_GATE_VIOLATION, violations.join("; "));
}
