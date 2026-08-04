// src/governance/draft-pr-lifecycle.mjs
//
// Draft PR lifecycle (AUTOLOOP-GOVERNANCE-REVIEW-UNIT-FINALIZATION-1 §13).
// Draft PR is integration record + CI carrier ONLY — it is allowed only in
// EXTERNAL_REVIEW_PASS / INTEGRATION_READY and only with a verified
// digest-bound external-review-result artifact.
//
// Before any CREATE/UPDATE the gate verifies:
//   - repository identity      (result.repository === authority.repository)
//   - head branch              (result.branch === head)
//   - base branch              (result.base_branch === requested base === authority)
//   - parent card identity     (result.card_id === cardId)
//   - review-result digest     (verified PASS against recomputed identity)
//   - PR draft state           (a non-draft PR on the same head is never
//     directly updated → HOLD)
//
// The PR is never marked ready, never merged, never auto-merge enabled.

import { GOV_HOLD, hold } from "./holds.mjs";
import { verifyExternalReviewResult } from "./external-review.mjs";

export const DRAFT_PR_ACTIONS = Object.freeze(["CREATE", "UPDATE", "NONE"]);

/**
 * True when an existing PR body is bound to this parent card: it must
 * reference the card id and the reviewed result digest.
 */
export function prBoundToParentCard({ body, cardId, reviewResultDigest }) {
  const text = String(body ?? "");
  if (typeof cardId !== "string" || cardId.length === 0) return false;
  if (typeof reviewResultDigest !== "string" || reviewResultDigest.length === 0) return false;
  return text.includes(cardId) && text.includes(reviewResultDigest);
}

/**
 * Decide the Draft PR action for the current head branch.
 *
 * @param {object} args
 * @param {object} args.authority — effective lifecycle authority
 * @param {object|null} args.result — validated external-review-result artifact
 * @param {object} args.current — recomputed identities ({ bundleSha256, ... })
 * @param {boolean} args.existingPrForParent — a PR already exists for this parent card
 * @param {boolean|null} args.existingPrDraft — true=draft, false=non-draft, null=unknown
 * @param {string} args.headBranch — local head branch
 * @param {string} args.baseBranch — requested base
 * @param {string} args.cardId — parent card identity
 * @param {boolean} args.readyForReviewRequested — must never be true
 * @param {string} [args.lifecycleState="EXTERNAL_REVIEW_PASS"]
 * @returns {{action: string, violations: string[]}}
 */
export function decideDraftPrAction({
  authority,
  result = null,
  current,
  existingPrForParent = false,
  existingPrDraft = null,
  headBranch = "",
  baseBranch = "",
  cardId = "",
  readyForReviewRequested = false,
  lifecycleState = "EXTERNAL_REVIEW_PASS",
}) {
  const violations = [];
  const cap = authority?.draft_pr ?? { allowed: false };

  if (cap.allowed !== true) violations.push("draft_pr.allowed is false (fail-closed)");
  if (cap.draft_only !== true) violations.push("draft_pr.draft_only must be true");
  if (readyForReviewRequested === true) violations.push("draft_pr: ready-for-review must not be requested automatically");

  // Draft PR is post-external-review integration only — digest-bound result
  // artifact required (self-declared PASS rejected).
  if (!["EXTERNAL_REVIEW_PASS", "INTEGRATION_READY"].includes(lifecycleState)) {
    violations.push(`lifecycle_state: Draft PR requires EXTERNAL_REVIEW_PASS/INTEGRATION_READY, state is ${lifecycleState}`);
  }
  if (!result) {
    violations.push("external_review_result: no verified result artifact (self-declared PASS rejected)");
  } else {
    if (result.verdict !== "PASS") violations.push(`external_review_result: verdict is ${result.verdict}`);
    const identityViolations = verifyExternalReviewResult({ result, current });
    violations.push(...identityViolations.map((v) => `external_review_result: ${v}`));
    if (authority?.repository && result.repository && authority.repository !== result.repository) {
      violations.push(`external_review_result: repository ${result.repository} != authority ${authority.repository}`);
    }
    if (cardId && result.card_id !== cardId) violations.push(`external_review_result: card ${result.card_id} != ${cardId}`);
    if (headBranch && result.branch !== headBranch) violations.push(`external_review_result: head branch ${result.branch} != ${headBranch}`);
  }

  const authorizedBase = cap.base_branch ?? "";
  if (authorizedBase && baseBranch !== authorizedBase) violations.push(`draft_pr.base_branch mismatch: ${baseBranch} != ${authorizedBase}`);
  if (typeof headBranch !== "string" || headBranch.length === 0) violations.push("draft_pr.head_branch missing");

  if (violations.length > 0) return { action: "NONE", violations };

  if (existingPrForParent === true) {
    // Never directly update a non-draft PR on the same head.
    if (existingPrDraft === false) violations.push("draft_pr: existing PR on head is NOT a draft — direct UPDATE denied");
    if (existingPrDraft === null) violations.push("draft_pr: existing PR draft state unknown — HOLD");
    if (cap.update_if_present !== true) violations.push("draft_pr.update_if_present must be true to update");
    if (violations.length > 0) return { action: "NONE", violations };
    return { action: "UPDATE", violations };
  }
  if (cap.create_if_missing !== true) violations.push("draft_pr.create_if_missing must be true to create");
  if (violations.length > 0) return { action: "NONE", violations };
  return { action: "CREATE", violations };
}

/**
 * Build the Draft PR body (mandated sections from §9 + result binding).
 */
export function buildDraftPrBody({
  cardId,
  runId,
  parentGoal,
  currentMilestone,
  completed = [],
  pending = [],
  limitations = [],
  verificationSummary = "",
  commitEvidence = [],
  evidenceDigests = [],
  irreversibleStatement,
  reviewResultDigest = "",
  bundlePath = "",
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
    `\n## External Review Result\nCard: ${cardId || "(未填)"}\nRun: ${runId || "(未填)"}\nReview-Result Digest: ${reviewResultDigest || "(未填)"}\nReview Bundle: ${bundlePath || "(未填)"}`,
    `\n## 不可逆操作聲明\n${irreversibleStatement || "merge／force-push／release／seal 仍被禁止；本 PR 保持 draft。"}`,
  ].join("\n");
  return body;
}

export function prViolationsToHold(violations) {
  if (!violations || violations.length === 0) return null;
  if (violations.some((v) => v.includes("external_review_result"))) {
    return hold(GOV_HOLD.EVIDENCE_IDENTITY_MISMATCH, violations.join("; "));
  }
  return hold(GOV_HOLD.DRAFT_PR_GATE_VIOLATION, violations.join("; "));
}
