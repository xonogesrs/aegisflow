// src/governance/external-review.mjs
//
// External review governance (A-8 + AUTOLOOP-GOVERNANCE-REVIEW-UNIT-
// FINALIZATION-1 §9):
//
//   Agent 實作＋測試 → 產生桌面 review bundle → HOLD / WAITING_FOR_EXTERNAL_REVIEW
//   → Controller 上傳 → 外部 reviewer 判定 → PASS 後才允許 integration commit／push／Draft PR。
//
// Draft PR 不再作為首次外部 review 的必要前置條件；external review PASS 之後
// Draft PR 僅作為整合紀錄與 CI 載體。
//
// The external-review result artifact is harness-owned and digest-bound.
// Gates must READ the artifact and RECOMPUTE current identities, never
// accept `--external-review-status PASS` or caller-supplied artifact
// identity as final authority. An Agent can never self-declare PASS.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GOV_HOLD, hold } from "./holds.mjs";
import { sha256Text } from "../evidence/run-evidence-store.mjs";
import { assertNotSymlink } from "../c2d/fs-atomic.mjs";
import { validateAgainstSchema } from "./lifecycle-authorization.mjs";

export const EXTERNAL_REVIEW_STATUSES = Object.freeze([
  "PENDING", "PASS", "REPAIR", "HOLD",
]);

export const EXTERNAL_REVIEW_STOP = Object.freeze({
  WAITING: "HOLD / WAITING_FOR_EXTERNAL_REVIEW",
});

export const RESULT_ARTIFACT_SCHEMA = "autoloop.external-review-result/v1";

// Schema for the harness-owned result artifact (§9). Round ≥ 2 results MUST
// bind the previous round's bundle digest and findings digest, and every
// result must carry the Controller authorization source.
export const EXTERNAL_REVIEW_RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "schema", "card_id", "run_id", "verdict",
    "bundle_sha256", "patch_sha256", "changed_tree_identity",
    "reviewer_identity", "reviewed_at", "review_round", "findings_digest",
    "authorization_source",
    "current_head", "base_head", "repository", "branch", "base_branch", "bundle_path",
  ],
  properties: {
    schema: { type: "string", const: RESULT_ARTIFACT_SCHEMA },
    card_id: { type: "string", minLength: 1, maxLength: 128 },
    run_id: { type: "string", minLength: 1, maxLength: 128 },
    verdict: { type: "string", enum: ["PASS", "REPAIR", "HOLD"] },
    bundle_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    patch_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    changed_tree_identity: { type: "string", pattern: "^[0-9a-f]{64}$" },
    reviewer_identity: { type: "string", minLength: 1, maxLength: 256 },
    reviewed_at: { type: "string", format: "date-time" },
    review_round: { type: "integer", minimum: 1 },
    findings_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    authorization_source: { type: "string", minLength: 1, maxLength: 512 },
    prior_bundle_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    prior_findings_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    current_head: { type: "string", pattern: "^[0-9a-f]{40}$" },
    base_head: { type: "string", pattern: "^[0-9a-f]{40}$" },
    repository: { type: "string", minLength: 1, maxLength: 256 },
    branch: { type: "string", minLength: 1, maxLength: 128 },
    base_branch: { type: "string", minLength: 1, maxLength: 128 },
    bundle_path: { type: "string", minLength: 1, maxLength: 1024 },
    // Flow 2 review-job bindings (IMPL1 §15) — optional; present when the
    // acceptance record carries review-job identity. Verified against the
    // recomputed values supplied by the acceptance entrypoint.
    job_id: { type: "string", minLength: 1, maxLength: 256 },
    generation: { type: "integer", minimum: 1 },
    spec_id: { type: "string", minLength: 1 },
    spec_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
});

export function isValidExternalReviewStatus(s) {
  return EXTERNAL_REVIEW_STATUSES.includes(s);
}

export function requireExternalReviewPass(status, authority) {
  const req = authority?.external_review;
  if (req && req.required === true && status !== "PASS") {
    throw hold(GOV_HOLD.DRAFT_PR_GATE_VIOLATION, `external review required but status is ${status}`);
  }
  return status;
}

/** True when the authority declares external review required. */
export function externalReviewRequired(authority) {
  return authority?.external_review?.required === true;
}

// ---------------------------------------------------------------------------
// Bundle digest contract (§8): identities are computed, never trust-input.
// ---------------------------------------------------------------------------

/** SHA-256 of an arbitrary patch/artifact payload. */
export function digestOfPayload(payload) {
  return sha256Text(String(payload));
}

/** Digest of a list of file entries [{path, status, digest}] + mode flags. */
export function digestOfChangeSet(changes) {
  const canonical = changes
    .map((c) => `${c.status}\t${c.path}\t${c.digest}${c.mode ? `\t${c.mode}` : ""}`)
    .sort()
    .join("\n");
  return digestOfPayload(canonical);
}

/** Bundle header fields (schema autoloop.external-review-bundle/v1). */
export function buildBundleHeader({ cardId, cardTitle, repository, branch, baseBranch, baseHead, currentHead, worktree, agent }) {
  return {
    bundle_schema: "autoloop.external-review-bundle/v1",
    card_id: cardId,
    card_title: cardTitle,
    generated_at: new Date().toISOString(),
    repository,
    branch,
    base_branch: baseBranch,
    base_head: baseHead,
    current_head: currentHead,
    worktree,
    agent,
    requested_review_verdict: "PASS / REPAIR / HOLD",
  };
}

/** Render the "1. AUTHORIZATION AND PROHIBITED ACTIONS" section. */
export function renderProhibitedActions(authority, extraDeclarations = []) {
  const lines = [
    "AUTHORIZED_SCOPE: " + (authority?.scope || "(see card)"),
    "AUTHORIZED_PATHS: " + (authority?.paths ? JSON.stringify(authority.paths) : "(see card)"),
    "REPAIR_BUDGET: " + (authority?.bounded_repair?.max_rounds ?? 0),
    "COMMIT_AUTHORIZED: NO",
    "PUSH_AUTHORIZED: NO",
    "DRAFT_PR_AUTHORIZED: NO",
    "MERGE_AUTHORIZED: NO",
    "RELEASE_AUTHORIZED: NO",
    "SEAL_AUTHORIZED: NO",
    "",
    "Agent 聲明：",
    "- 外部 review PASS 前：未 commit（本 bundle 涵蓋之變更）",
    "- 未 push",
    "- 未建立或更新 Draft PR",
    "- 未 merge / 未 release / 未 seal",
    "- 未修改授權範圍外檔案",
    ...extraDeclarations,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// External review result artifact (§9) — harness-owned, digest-bound
// ---------------------------------------------------------------------------

/**
 * Controller-owned result path, DERIVED from the review bundle directory
 * (which lives outside the executor's writable scope — e.g.
 * ~/Desktop/AutoLoop-Review). Executor CLIs only READ this path; the
 * artifact is created exclusively by the Controller ingestion entry
 * (scripts/controller/ingest-review-result.mjs).
 */
export function externalReviewResultPath(bundleDir) {
  return join(bundleDir, "governance", "external-review-result.json");
}

/**
 * Validate a raw result artifact. Strict parity with EXTERNAL_REVIEW_RESULT_SCHEMA.
 * Round ≥ 2 results must bind the previous round (prior_bundle_sha256 +
 * prior_findings_digest) and the Controller authorization source is always
 * required.
 */
export function validateExternalReviewResult(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, errors: ["result:type"] };
  }
  const errors = validateAgainstSchema(EXTERNAL_REVIEW_RESULT_SCHEMA, raw, "result");
  if (Number.isInteger(raw.review_round) && raw.review_round > 1) {
    if (typeof raw.prior_bundle_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.prior_bundle_sha256)) {
      errors.push("result.prior_bundle_sha256 required for round > 1");
    }
    if (typeof raw.prior_findings_digest !== "string" || !/^[0-9a-f]{64}$/.test(raw.prior_findings_digest)) {
      errors.push("result.prior_findings_digest required for round > 1");
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Read + validate the harness-owned result artifact (fail-closed). */
export function readExternalReviewResult(execDir) {
  const p = externalReviewResultPath(execDir);
  if (!existsSync(p)) throw hold(GOV_HOLD.EXTERNAL_REVIEW_RESULT_MISSING, "external-review-result.json missing");
  assertNotSymlink(p);
  let raw;
  try { raw = JSON.parse(readFileSync(p, "utf8")); } catch {
    throw hold(GOV_HOLD.EXTERNAL_REVIEW_RESULT_INVALID, "external-review-result.json unreadable");
  }
  const check = validateExternalReviewResult(raw);
  if (!check.valid) throw hold(GOV_HOLD.EXTERNAL_REVIEW_RESULT_INVALID, check.errors.join(","));
  return raw;
}

/**
 * Verify the result artifact against *recomputed* current identities.
 * Any mismatch → violations (caller maps to HOLD / EVIDENCE_IDENTITY_MISMATCH).
 *
 * @param {object} args
 * @param {object} args.result — validated result artifact
 * @param {object} args.current — recomputed current state:
 *   bundleSha256, patchSha256, changedTreeIdentity, cardId, runId, reviewRound,
 *   currentHead, baseHead, repository, branch, baseBranch, agentIdentity
 * @returns {string[]} violations (empty = fully verified PASS)
 */
export function verifyExternalReviewResult({ result, current }) {
  const violations = [];
  if (result.verdict !== "PASS") violations.push(`result.verdict is ${result.verdict}, not PASS`);
  if (result.bundle_sha256 !== current.bundleSha256) violations.push("result.bundle_sha256 does not match recomputed bundle digest");
  if (result.patch_sha256 !== current.patchSha256) violations.push("result.patch_sha256 does not match recomputed patch digest");
  if (result.changed_tree_identity !== current.changedTreeIdentity) violations.push("result.changed_tree_identity does not match recomputed inventory identity");
  if (result.card_id !== current.cardId) violations.push(`result.card_id ${result.card_id} != ${current.cardId}`);
  if (result.run_id !== current.runId) violations.push(`result.run_id ${result.run_id} != ${current.runId}`);
  if (result.review_round !== current.reviewRound) violations.push(`result.review_round ${result.review_round} != ${current.reviewRound}`);
  if (result.review_round > 1) {
    if (!/^[0-9a-f]{64}$/.test(result.prior_bundle_sha256 ?? "")) violations.push("result.prior_bundle_sha256 missing for round > 1");
    if (!/^[0-9a-f]{64}$/.test(result.prior_findings_digest ?? "")) violations.push("result.prior_findings_digest missing for round > 1");
    if (current.priorBundleSha256 && result.prior_bundle_sha256 !== current.priorBundleSha256) {
      violations.push(`result.prior_bundle_sha256 ${result.prior_bundle_sha256} != known ${current.priorBundleSha256}`);
    }
    if (current.priorFindingsDigest && result.prior_findings_digest !== current.priorFindingsDigest) {
      violations.push(`result.prior_findings_digest ${result.prior_findings_digest} != known ${current.priorFindingsDigest}`);
    }
  }
  if (typeof result.authorization_source !== "string" || result.authorization_source.length === 0) {
    violations.push("result.authorization_source missing (Controller authorization required)");
  }
  // REVIEW-PROVENANCE-MODEL-V2 (§3): the reviewed object is the CANDIDATE.
  // When the caller supplies the frozen candidate commit (frozenCandidateHead
  // from the review-job), the result must bind THAT — never an arbitrary live
  // HEAD advanced by governance/evidence commits.
  if (result.current_head !== (current.frozenCandidateHead ?? current.currentHead)) violations.push(`result.current_head ${result.current_head} != ${current.frozenCandidateHead ?? current.currentHead}`);
  if (result.base_head !== current.baseHead) violations.push(`result.base_head ${result.base_head} != ${current.baseHead}`);
  if (result.repository !== current.repository) violations.push(`result.repository ${result.repository} != ${current.repository}`);
  if (result.branch !== current.branch) violations.push(`result.branch ${result.branch} != ${current.branch}`);
  if (result.base_branch !== current.baseBranch) violations.push(`result.base_branch ${result.base_branch} != ${current.baseBranch}`);
  if (current.bundlePath && result.bundle_path !== current.bundlePath) violations.push(`result.bundle_path ${result.bundle_path} != ${current.bundlePath}`);
  if (current.agentIdentity && result.reviewer_identity === current.agentIdentity) {
    violations.push("result.reviewer_identity is the agent itself — self-declared PASS rejected");
  }
  if (/^agent:/i.test(result.reviewer_identity)) {
    violations.push("result.reviewer_identity looks self-declared — rejected");
  }
  // Flow 2 findings/job/generation/spec verification (IMPL1 §15).
  // Enforced only when the caller supplies the recomputed expected values —
  // never trusted from the result fields alone.
  if (current.findingsDigest && result.findings_digest !== current.findingsDigest) {
    violations.push("result.findings_digest does not match recomputed findings digest");
  }
  if (current.jobId && result.job_id !== current.jobId) {
    violations.push(`result.job_id ${result.job_id} != ${current.jobId}`);
  }
  if (current.generation && result.generation !== current.generation) {
    violations.push(`result.generation ${result.generation} != ${current.generation}`);
  }
  if (current.specDigest && result.spec_digest !== current.specDigest) {
    violations.push(`result.spec_digest ${result.spec_digest} != ${current.specDigest}`);
  }
  return violations;
}

/** True only when the result is a verified PASS against current state. */
export function isExternalReviewPassed({ result, current }) {
  return result.verdict === "PASS" && verifyExternalReviewResult({ result, current }).length === 0;
}
