// src/governance/feature-branch-push-gate.mjs
//
// Feature-branch push gate (AUTOLOOP-GOVERNANCE-REVIEW-UNIT-FINALIZATION-1
// §8/§13). Push is only allowed after a *verified* external review PASS
// backed by the harness-owned result artifact. The gate never accepts
// `--external-review-status PASS` or a caller-supplied reviewed-artifact
// identity as authority: it reads the result artifact, recomputes current
// identities and compares. Remote divergence is never auto-resolved:
// HOLD / REMOTE_BRANCH_DIVERGED.

import { GOV_HOLD, hold } from "./holds.mjs";
import { matchesPattern } from "./lifecycle-authorization.mjs";
import { verifyExternalReviewResult } from "./external-review.mjs";

export const PUSH_GATE_CONDITIONS = Object.freeze([
  "push_allowed_by_authority",
  "remote_reachable",
  "remote_branch_state_known",
  "local_has_expected_upstream",
  "target_branch_matches_pattern",
  "not_protected_branch",
  "no_non_fast_forward",
  "no_force_push",
  "external_review_result_verified",
  "commit_matches_reviewed_head",
]);

/**
 * Evaluate the feature-branch push gate.
 *
 * @param {object} args
 * @param {object} args.authority — effective lifecycle authority
 * @param {string} args.branch — local branch
 * @param {string} [args.remoteBranch] — remote branch (if known)
 * @param {boolean} args.remoteReachable — probe result
 * @param {boolean} args.remoteBranchKnown — remote branch state known
 * @param {string} [args.upstream] — expected upstream tracking branch
 * @param {string[]} [args.protectedBranches=["main","master"]]
 * @param {boolean} args.fastForwardOnly — local is ancestor of remote (or remote empty)
 * @param {boolean} args.force — force flag requested (must be false)
 * @param {object|null} args.result — validated external-review-result artifact
 * @param {object} args.current — recomputed { bundleSha256, patchSha256,
 *   changedTreeIdentity, cardId, runId, reviewRound, currentHead, baseHead,
 *   repository, branch, baseBranch, agentIdentity }
 * @param {string} [args.lifecycleState="EXTERNAL_REVIEW_PASS"]
 * @returns {{allowed: boolean, violations: string[]}}
 */
export function evaluatePushGate({
  authority,
  branch,
  remoteBranch,
  remoteReachable = false,
  remoteBranchKnown = false,
  upstream,
  protectedBranches = ["main", "master"],
  fastForwardOnly = false,
  force = false,
  result = null,
  current,
  lifecycleState = "EXTERNAL_REVIEW_PASS",
}) {
  const violations = [];
  const cap = authority?.feature_branch_push ?? { allowed: false };

  if (cap.allowed !== true) violations.push("push_allowed_by_authority: feature_branch_push.allowed is false (fail-closed)");
  if (cap.force_push === true) violations.push("no_force_push: authority force_push must be false");

  if (remoteReachable !== true) violations.push("remote_reachable: remote not reachable");
  if (remoteBranchKnown !== true) violations.push("remote_branch_state_known: remote branch state unknown");
  if (typeof upstream !== "string" || upstream.length === 0) violations.push("local_has_expected_upstream: no expected upstream");

  const pattern = cap.branch_pattern ?? "";
  if (!matchesPattern(pattern, branch)) violations.push(`target_branch_matches_pattern: ${branch} not in ${pattern}`);
  if (protectedBranches.includes(branch)) violations.push(`not_protected_branch: ${branch} is protected`);

  if (force === true) violations.push("no_force_push: force requested");
  if (fastForwardOnly !== true) violations.push("no_non_fast_forward: local is not a fast-forward of remote");

  // External review result — digest-bound, never caller-declared.
  if (!result) {
    violations.push("external_review_result_verified: no external-review-result artifact (self-declared PASS rejected)");
  } else {
    if (result.verdict !== "PASS") violations.push(`external_review_result_verified: verdict is ${result.verdict}`);
    if (!current || typeof current.currentHead !== "string") {
      violations.push("commit_matches_reviewed_head: current head unknown");
    } else {
      if (result.current_head !== current.currentHead) {
        violations.push(`commit_matches_reviewed_head: HEAD ${current.currentHead} drifted from reviewed ${result.current_head}`);
      }
      const identityViolations = verifyExternalReviewResult({ result, current });
      violations.push(...identityViolations.map((v) => `external_review_result_verified: ${v}`));
    }
  }

  if (!["EXTERNAL_REVIEW_PASS", "INTEGRATION_READY"].includes(lifecycleState)) {
    violations.push(`lifecycle_state: push requires EXTERNAL_REVIEW_PASS/INTEGRATION_READY, state is ${lifecycleState}`);
  }

  return { allowed: violations.length === 0, violations };
}

export function pushViolationsToHold(violations, diverged = false) {
  if (!violations || violations.length === 0) return null;
  if (diverged || violations.some((v) => v.includes("non_fast_forward") || v.includes("remote_branch_state_unknown") || v.includes("remote not reachable"))) {
    return hold(GOV_HOLD.REMOTE_BRANCH_DIVERGED, violations.join("; "));
  }
  if (violations.some((v) => v.includes("external_review_result_verified") || v.includes("commit_matches_reviewed_head"))) {
    return hold(GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH, violations.join("; "));
  }
  return hold(GOV_HOLD.PUSH_GATE_VIOLATION, violations.join("; "));
}
