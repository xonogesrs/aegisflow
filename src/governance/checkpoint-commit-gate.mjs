// src/governance/checkpoint-commit-gate.mjs
//
// Checkpoint commit gate (§7). A checkpoint commit is *not* final approval,
// not merge, not seal, not release. The gate evaluates 12 fail-closed
// conditions against the effective lifecycle authority, the live repository
// state and the pending change set. Pure evaluation — this module never
// executes git; the thin CLI (scripts/gov-commit-checkpoint.mjs) runs git
// only after the gate returns allowed.

import { GOV_HOLD, hold } from "./holds.mjs";
import { matchesPattern } from "./lifecycle-authorization.mjs";

export const CHECKPOINT_GATE_CONDITIONS = Object.freeze([
  "branch_matches_authorized_pattern",
  "branch_not_protected",
  "changed_paths_within_authorized_scope",
  "no_unknown_staged_paths",
  "diff_check_clean",
  "verification_passed",
  "artifact_identity_fixed",
  "evidence_digest_established",
  "no_blocking_review_finding",
  "repair_converged_or_honest_negative",
  "no_secret_like_values",
  "commit_message_has_identity",
]);

// Scope check. `scope` entries may be exact file paths, directories with a
// trailing slash, or bare directory prefixes. Changed paths may be collapsed
// to a directory by git for fully-untracked dirs (e.g. "docs/").
function pathInScope(p, scope) {
  return scope.some((allowed) => {
    if (allowed === p) return true;
    if (allowed.endsWith("/") && p.startsWith(allowed)) return true;
    if (p.startsWith(allowed + "/")) return true;
    if (p.endsWith("/")) {
      // collapsed directory: any authorized path inside it counts
      return allowed.startsWith(p) || allowed === p.slice(0, -1);
    }
    return false;
  });
}

/**
 * Evaluate the checkpoint commit gate.
 *
 * @param {object} args
 * @param {object} args.authority — effective lifecycle authority (normalized)
 * @param {string} args.branch — current branch name
 * @param {string[]} [args.protectedBranches=["main","master"]] — protected refs
 * @param {string[]} args.expectedPaths — paths authorized to change
 * @param {string[]} args.changedPaths — actual paths to be committed
 * @param {string[]} args.stagedPaths — paths currently staged in the index
 * @param {boolean} args.diffCheckClean — `git diff --check` result
 * @param {boolean} args.verificationPassed — required tests/verification passed
 * @param {string} args.artifactIdentity — fixed artifact identity (digest)
 * @param {string} args.evidenceDigest — evidence digest (established)
 * @param {string[]} args.reviewBlockingFindings — blocking review findings (must be empty)
 * @param {boolean} args.repairConverged — repair converged, or honest negative result
 * @param {string[]} args.secretLikeValues — real secret-like values detected (must be empty)
 * @param {string} args.cardId — card identity for the commit footer
 * @param {string} [args.runId] — run identity
 * @param {string} [args.milestoneId] — milestone identity
 * @returns {{allowed: boolean, violations: string[], footer: string}}
 */
export function evaluateCheckpointCommitGate({
  authority,
  branch,
  protectedBranches = ["main", "master"],
  expectedPaths = [],
  changedPaths = [],
  stagedPaths = [],
  diffCheckClean = false,
  verificationPassed = false,
  artifactIdentity = "",
  evidenceDigest = "",
  reviewBlockingFindings = [],
  repairConverged = false,
  secretLikeValues = [],
  cardId = "",
  runId = "",
  milestoneId = "",
}) {
  const violations = [];
  const cap = authority?.checkpoint_commit ?? { allowed: false };

  if (cap.allowed !== true) violations.push("checkpoint_commit.allowed is false (fail-closed)");
  if (cap.require_local_gates_pass !== true) violations.push("checkpoint_commit.require_local_gates_pass must be true");
  if (cap.require_clean_index_before_stage !== true) violations.push("checkpoint_commit.require_clean_index_before_stage must be true");
  if (cap.require_expected_paths_only !== true) violations.push("checkpoint_commit.require_expected_paths_only must be true");

  // 1. branch matches authorized pattern
  const branchPattern = authority?.feature_branch_push?.branch_pattern ?? "";
  if (typeof branch !== "string" || branch.length === 0) violations.push("branch_matches_authorized_pattern: branch unknown");
  else if (!matchesPattern(branchPattern, branch)) violations.push(`branch_matches_authorized_pattern: ${branch} not in pattern ${branchPattern}`);

  // 2. not on protected branch
  if (protectedBranches.includes(branch)) violations.push(`branch_not_protected: ${branch} is protected`);

  // 3. changed paths within authorized scope
  const scope = expectedPaths;
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) violations.push("changed_paths_within_authorized_scope: no changed paths");
  else {
    for (const p of changedPaths) {
      if (!pathInScope(p, scope)) {
        violations.push(`changed_paths_within_authorized_scope: ${p} outside scope`);
      }
    }
  }

  // 4. no unknown staged paths (index must be empty or exactly expected)
  if (cap.require_clean_index_before_stage === true) {
    const staged = stagedPaths ?? [];
    if (staged.length !== 0) violations.push(`no_unknown_staged_paths: ${staged.length} staged path(s) present`);
  }

  // 5. diff check clean
  if (diffCheckClean !== true) violations.push("diff_check_clean: git diff --check not clean");

  // 6. verification passed
  if (verificationPassed !== true) violations.push("verification_passed: required tests/verification not passed");

  // 7. artifact identity fixed
  if (typeof artifactIdentity !== "string" || artifactIdentity.length === 0) violations.push("artifact_identity_fixed: artifact identity not fixed");

  // 8. evidence digest established
  if (!/^[0-9a-f]{64}$/.test(evidenceDigest || "")) violations.push("evidence_digest_established: evidence digest missing/invalid");

  // 9. no blocking review finding
  if (!Array.isArray(reviewBlockingFindings) || reviewBlockingFindings.length > 0) violations.push("no_blocking_review_finding: blocking findings present");

  // 10. repair converged or honest negative
  if (repairConverged !== true) violations.push("repair_converged_or_honest_negative: repair not converged and not an honest negative result");

  // 11. no secret-like real values
  if (!Array.isArray(secretLikeValues) || secretLikeValues.length > 0) violations.push(`no_secret_like_values: ${(secretLikeValues ?? []).length} secret-like value(s)`);

  // 12. commit message identity
  if (typeof cardId !== "string" || cardId.length === 0) violations.push("commit_message_has_identity: card_id missing");

  const footer = buildCommitFooter({ cardId, runId, milestoneId, evidenceDigest });
  return { allowed: violations.length === 0, violations, footer };
}

export function buildCommitFooter({ cardId, runId, milestoneId, evidenceDigest }) {
  const lines = [];
  if (cardId) lines.push(`AutoLoop-Card: ${cardId}`);
  if (runId) lines.push(`AutoLoop-Run: ${runId}`);
  if (milestoneId) lines.push(`AutoLoop-Milestone: ${milestoneId}`);
  if (evidenceDigest) lines.push(`Evidence-Digest: ${evidenceDigest}`);
  return lines.length ? `\n\n${lines.join("\n")}\n` : "";
}

export function checkpointCommitViolationsToHold(violations) {
  if (!violations || violations.length === 0) return null;
  return hold(GOV_HOLD.COMMIT_GATE_VIOLATION, violations.join("; "));
}
