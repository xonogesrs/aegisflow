// src/governance/checkpoint-commit-gate.mjs
//
// Internal checkpoint commit gate (AUTOLOOP-GOVERNANCE-REVIEW-UNIT-
// FINALIZATION-1 §8.1). A checkpoint commit is a *local* rollback point /
// milestone boundary: it does NOT require external review PASS, and it must
// never be pushed (push has its own gate, post-PASS). This gate is
// deliberately distinct from the integration-approved commit gate
// (integration-commit-gate.mjs) — one gate never represents both commit
// classes.
//
// Pure evaluation — this module never executes git; the thin CLI
// (scripts/gov-commit-checkpoint.mjs) runs git only after the gate returns
// allowed.

import { GOV_HOLD, hold } from "./holds.mjs";
import { matchesPattern, scopeCovers } from "./lifecycle-authorization.mjs";
import { evaluateReviewUnitGate } from "./review-unit-gate.mjs";

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
  "review_unit_within_limits",
  "local_only_no_push",
]);

/**
 * Evaluate the internal checkpoint commit gate.
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
 * @param {object} [args.reviewUnitActual] — measured review-unit counts
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
  reviewUnitActual,
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
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) violations.push("changed_paths_within_authorized_scope: no changed paths");
  else {
    for (const p of changedPaths) {
      if (!scopeCovers(p, expectedPaths)) {
        violations.push(`changed_paths_within_authorized_scope: ${p} outside scope`);
      }
    }
  }

  // 4. no unknown staged paths (index must be empty before staging)
  const staged = stagedPaths ?? [];
  if (staged.length !== 0) violations.push(`no_unknown_staged_paths: ${staged.length} staged path(s) present`);

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

  // 13. review-unit boundary (§5) — runtime enforcement when measured.
  if (reviewUnitActual && typeof reviewUnitActual === "object") {
    const ru = evaluateReviewUnitGate({ authority, actual: reviewUnitActual });
    violations.push(...ru.violations);
  }

  // 14. checkpoint commits are local-only; push requires the post-PASS gate.
  //     (No external review PASS requirement here — that is the point of the
  //      internal/local separation.)

  const footer = buildCommitFooter({ cardId, runId, milestoneId, evidenceDigest });
  return { allowed: violations.length === 0, violations, footer };
}

export function buildCommitFooter({ cardId, runId, milestoneId, evidenceDigest, reviewResultDigest }) {
  const lines = [];
  if (cardId) lines.push(`AutoLoop-Card: ${cardId}`);
  if (runId) lines.push(`AutoLoop-Run: ${runId}`);
  if (milestoneId) lines.push(`AutoLoop-Milestone: ${milestoneId}`);
  if (evidenceDigest) lines.push(`Evidence-Digest: ${evidenceDigest}`);
  if (reviewResultDigest) lines.push(`Review-Result: ${reviewResultDigest}`);
  return lines.length ? `\n\n${lines.join("\n")}\n` : "";
}

export function checkpointCommitViolationsToHold(violations) {
  if (!violations || violations.length === 0) return null;
  return hold(GOV_HOLD.COMMIT_GATE_VIOLATION, violations.join("; "));
}
