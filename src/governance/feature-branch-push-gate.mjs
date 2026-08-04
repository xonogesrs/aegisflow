// src/governance/feature-branch-push-gate.mjs
//
// Feature-branch push gate (§8). Only pushes to the entry-card-authorized
// feature branch are allowed. Pure evaluation; the CLI runs git only after
// the gate returns allowed. Remote divergence is never auto-resolved:
// HOLD / REMOTE_BRANCH_DIVERGED.

import { GOV_HOLD, hold } from "./holds.mjs";
import { matchesPattern } from "./lifecycle-authorization.mjs";

export const PUSH_GATE_CONDITIONS = Object.freeze([
  "push_allowed_by_authority",
  "remote_reachable",
  "remote_branch_state_known",
  "local_has_expected_upstream",
  "target_branch_matches_pattern",
  "not_protected_branch",
  "no_non_fast_forward",
  "no_force_push",
  "commit_identity_matches_reviewed_artifact",
]);

/**
 * Evaluate the feature-branch push gate.
 *
 * @param {object} args
 * @param {object} args.authority — effective lifecycle authority
 * @param {string} args.branch — local branch
 * @param {string} [args.remoteBranch] — remote branch (if known)
 * @param {string} args.remoteReachable — boolean (probe result)
 * @param {boolean} args.remoteBranchKnown — remote branch state known
 * @param {string} [args.upstream] — expected upstream tracking branch
 * @param {string[]} [args.protectedBranches=["main","master"]]
 * @param {boolean} args.fastForwardOnly — local is ancestor of remote (or remote empty)
 * @param {boolean} args.force — force flag requested
 * @param {string} args.commitIdentity — identity of the commit to push
 * @param {string} args.reviewedArtifactIdentity — identity of the reviewed artifact
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
  commitIdentity = "",
  reviewedArtifactIdentity = "",
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

  if (typeof commitIdentity !== "string" || commitIdentity.length === 0) violations.push("commit_identity_matches_reviewed_artifact: commit identity missing");
  if (typeof reviewedArtifactIdentity !== "string" || reviewedArtifactIdentity.length === 0) violations.push("commit_identity_matches_reviewed_artifact: reviewed artifact identity missing");
  if (commitIdentity && reviewedArtifactIdentity && commitIdentity !== reviewedArtifactIdentity) {
    violations.push("commit_identity_matches_reviewed_artifact: commit does not match reviewed artifact");
  }

  return { allowed: violations.length === 0, violations };
}

export function pushViolationsToHold(violations, diverged = false) {
  if (!violations || violations.length === 0) return null;
  if (diverged || violations.some((v) => v.includes("non_fast_forward") || v.includes("remote_branch_state_unknown") || v.includes("remote not reachable"))) {
    return hold(GOV_HOLD.REMOTE_BRANCH_DIVERGED, violations.join("; "));
  }
  return hold(GOV_HOLD.PUSH_GATE_VIOLATION, violations.join("; "));
}
