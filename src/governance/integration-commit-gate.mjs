// src/governance/integration-commit-gate.mjs
//
// Integration-approved commit gate (AUTOLOOP-GOVERNANCE-REVIEW-UNIT-
// FINALIZATION-1 §8.2). Distinct from the internal checkpoint gate: this one
// authorizes the commit of the *reviewed* review unit after external PASS.
//
// The gate refuses to trust:
//   - `--external-review-status PASS`            (self-declaration)
//   - `--reviewed-artifact-identity <caller>`    (caller-supplied identity)
//
// It reads the harness-owned external-review-result artifact, RECOMPUTES the
// current identities (bundle / patch / changed tree / card / run / review
// round / head / base / repo / branch) and compares. Any mismatch →
// HOLD / EVIDENCE_IDENTITY_MISMATCH. Fresh full verification is mandatory.

import { GOV_HOLD, hold } from "./holds.mjs";
import { evaluateCheckpointCommitGate } from "./checkpoint-commit-gate.mjs";
import { verifyExternalReviewResult } from "./external-review.mjs";

export const INTEGRATION_GATE_CONDITIONS = Object.freeze([
  "result_artifact_present",
  "verdict_is_pass",
  "bundle_digest_matches",
  "patch_digest_matches",
  "changed_tree_identity_matches",
  "card_run_review_round_match",
  "head_base_repo_branch_match",
  "reviewer_not_self_declared",
  "lifecycle_state_integration_ready",
  "local_conditions_pass",
  "fresh_full_verification_pass",
]);

/**
 * Evaluate the integration-approved commit gate.
 *
 * @param {object} args — combine checkpoint-style conditions with result
 *   artifact verification:
 *   result    — validated external-review-result artifact
 *   current   — recomputed { bundleSha256, patchSha256, changedTreeIdentity,
 *                cardId, runId, reviewRound, currentHead, baseHead,
 *                repository, branch, baseBranch, agentIdentity }
 *   plus all evaluateCheckpointCommitGate args (branch, expectedPaths, ...).
 * @returns {{allowed: boolean, violations: string[], footer: string}}
 */
export function evaluateIntegrationCommitGate({
  authority,
  result,
  current,
  lifecycleState = "EXTERNAL_REVIEW_PASS",
  verificationPassed = false,
  ...checkpointArgs
}) {
  const violations = [];

  if (!result) {
    violations.push("result_artifact_present: external-review-result missing");
  } else {
    if (result.verdict !== "PASS") violations.push(`verdict_is_pass: verdict is ${result.verdict}`);
    const identityViolations = verifyExternalReviewResult({ result, current });
    violations.push(...identityViolations.map((v) => `identity:${v}`));
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
    cardId: result?.card_id ?? checkpointArgs.cardId ?? "",
    runId: result?.run_id ?? checkpointArgs.runId ?? "",
    evidenceDigest: checkpointArgs.evidenceDigest ?? "",
    reviewResultDigest: result?.changed_tree_identity ?? "",
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
  const identityHits = violations.filter((v) => v.startsWith("identity:") || v.includes("result_artifact") || v.includes("verdict_is_pass"));
  if (identityHits.length > 0) {
    return hold(GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH, identityHits.join("; "));
  }
  return hold(GOV_HOLD.INTEGRATION_GATE_VIOLATION, violations.join("; "));
}
