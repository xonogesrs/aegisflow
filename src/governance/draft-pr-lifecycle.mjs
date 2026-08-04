// src/governance/draft-pr-lifecycle.mjs
//
// Draft PR lifecycle (§9). One Draft PR per parent card, always on the same
// head branch, always draft, never marked ready, never merged. Builds the PR
// body with the mandated sections. Pure logic — GitHub API calls live in the
// thin CLI (scripts/gov-draft-pr.mjs) which is dry-run by default.

import { GOV_HOLD, hold } from "./holds.mjs";

export const DRAFT_PR_ACTIONS = Object.freeze(["CREATE", "UPDATE", "NONE"]);

/**
 * Decide the Draft PR action for the current head branch.
 *
 * @param {object} args
 * @param {object} args.authority — effective lifecycle authority
 * @param {boolean} args.existingPrForParent — a PR already exists for this parent card
 * @param {string} args.headBranch — local head branch
 * @param {string} args.baseBranch — requested base
 * @param {boolean} args.readyForReviewRequested — must never be true
 * @returns {{action: string, violations: string[]}}
 */
export function decideDraftPrAction({
  authority,
  existingPrForParent = false,
  headBranch = "",
  baseBranch = "",
  readyForReviewRequested = false,
}) {
  const violations = [];
  const cap = authority?.draft_pr ?? { allowed: false };

  if (cap.allowed !== true) violations.push("draft_pr.allowed is false (fail-closed)");
  if (cap.draft_only !== true) violations.push("draft_pr.draft_only must be true");
  if (readyForReviewRequested === true) violations.push("draft_pr: ready-for-review must not be requested automatically");

  const authorizedBase = cap.base_branch ?? "";
  if (authorizedBase && baseBranch !== authorizedBase) violations.push(`draft_pr.base_branch mismatch: ${baseBranch} != ${authorizedBase}`);
  if (typeof headBranch !== "string" || headBranch.length === 0) violations.push("draft_pr.head_branch missing");

  if (violations.length > 0) return { action: "NONE", violations };

  if (existingPrForParent === true) {
    if (cap.update_if_present !== true) violations.push("draft_pr.update_if_present must be true to update");
    if (violations.length > 0) return { action: "NONE", violations };
    return { action: "UPDATE", violations };
  }
  if (cap.create_if_missing !== true) violations.push("draft_pr.create_if_missing must be true to create");
  if (violations.length > 0) return { action: "NONE", violations };
  return { action: "CREATE", violations };
}

/**
 * Build the Draft PR body (mandated sections from §9).
 */
export function buildDraftPrBody({
  cardId,
  parentGoal,
  currentMilestone,
  completed = [],
  pending = [],
  limitations = [],
  verificationSummary = "",
  commitEvidence = [],
  evidenceDigests = [],
  irreversibleStatement,
}) {
  const section = (title, items) => items.length
    ? `\n## ${title}\n${items.map((i) => `- ${i}`).join("\n")}`
    : "";
  const body = [
    `## 研究案／父卡目標\n${parentGoal || "(未填)"}`,
    `\n## 目前 Milestone\n${currentMilestone || "(未填)"}`,
    section("已完成項目", completed),
    section("尚未完成項目", pending),
    section("已知限制", limitations),
    `\n## 驗證摘要\n${verificationSummary || "(未填)"}`,
    section("Commit 與 Evidence 關係", commitEvidence),
    section("Evidence Digests", evidenceDigests),
    `\n## 不可逆操作聲明\n${irreversibleStatement || "merge／force-push／release／seal 仍被禁止；本 PR 保持 draft。"}`,
  ].join("\n");
  return body;
}

export function prViolationsToHold(violations) {
  if (!violations || violations.length === 0) return null;
  return hold(GOV_HOLD.DRAFT_PR_GATE_VIOLATION, violations.join("; "));
}
