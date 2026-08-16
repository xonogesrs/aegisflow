// src/governance/review-artifact-gate.mjs
//
// REVIEW-ROUTING-R1/R1A — mandatory review-artifact enforcement + live binding.
//
// The single mechanical authority chain from a production review-required
// task to exactly one accepted review-job artifact:
//
//   task (execution instance)
//     → authority_record_digest → card_id (lifecycle-authorization/v2)
//     → review job (lineageId = card_id)
//     → findings + verdict → state ACCEPTED
//     → live candidate identity == job candidate identity   (R1A)
//     → live spec digest        == job spec digest          (R1A)
//     → verdict may be consumed
//
// review-required is derived from admission.review_policy.strength ∈
// {independent, external} — the existing policy authority; never duplicated.
// For such a task, the LIVE candidate/spec identity is REQUIRED at verdict
// consumption (an ACCEPTED artifact for a stale candidate must NOT satisfy the
// gate). Console/terminal PASS has zero authority.
//
// Reuses IMPL1 capabilities only (readReviewJob / candidateDrift / specDrift /
// deriveReviewJobContext); no new artifact format, no new identity owner.

import { resolve } from "node:path";
import { readReviewJob, jobIdFor } from "./review-job.mjs";
import { candidateDrift, specDrift, deriveReviewJobContext } from "./review-job-context.mjs";

export const REVIEW_ARTIFACT_HOLD = "HOLD / REVIEW_ARTIFACT_REQUIRED_BUT_MISSING_OR_INVALID";

/** Review is mandatory iff the admitted policy demands independent/external review. */
export function reviewRequired(admission) {
  const strength = admission?.review_policy?.strength ?? null;
  return strength === "independent" || strength === "external";
}

/**
 * Derive the LIVE candidate/spec binding from the existing authoritative
 * context (the lifecycle-authorization record + live git + the authority-bound
 * canonical spec path). This is the ONLY way to obtain the live identity —
 * it delegates to deriveReviewJobContext (IMPL1); it never accepts
 * caller-invented values.
 *
 * Mirrors scripts/gov-review-job-orchestrator.mjs mapping:
 *   baseBranch = record.base, specPath = record.spec_path, repository = record.repository.
 *
 * @returns {{ candidateIdentity: object, specDigest: string }}
 */
export function deriveLiveReviewBinding({
  git,
  cwd,
  record = {},
  specId,
  candidateDomainPolicy,
} = {}) {
  const repository = record.repository ?? "";
  const base = record.base ?? "main";
  const boundSpecPath = record.spec_path ?? "";
  if (!boundSpecPath) {
    throw new Error("AUTHORITY_SPEC_PATH_MISSING: authority record spec_path binding required");
  }
  const ctx = deriveReviewJobContext({
    git,
    cwd,
    baseBranch: base,
    specId,
    specPath: resolve(cwd, boundSpecPath),
    authority: { repository, spec_path: boundSpecPath },
    candidateDomainPolicy,
  });
  return {
    candidateIdentity: ctx.candidateIdentity,
    specDigest: ctx.specIdentity.specDigest,
  };
}

/**
 * Fail-closed verdict-acceptance gate.
 *
 * @param {object} opts
 * @param {object|null} opts.admission — frozen admission (owns review_policy)
 * @param {string|null} opts.cardId — canonical review unit (resolved from the
 *        authority record via authority_record_digest; NEVER caller-invented)
 * @param {object|null} opts.candidateIdentity — REQUIRED for review-required;
 *        the live-recomputed candidate identity (from deriveLiveReviewBinding)
 * @param {string|null} opts.specDigest — REQUIRED for review-required; the
 *        live-recomputed spec digest (from deriveLiveReviewBinding)
 * @param {object} [opts.opts] — reviewJobRoot opts ({ root })
 * @returns {{ok:true, reviewRequired:boolean, job?:object}
 *           | {ok:false, holdCode:string, reason:string}}
 */
export function assertReviewArtifactEnforced({
  admission,
  cardId,
  candidateIdentity = null,
  specDigest = null,
  opts = {},
} = {}) {
  if (!reviewRequired(admission)) {
    return { ok: true, reviewRequired: false };
  }

  if (!cardId || typeof cardId !== "string" || cardId.length === 0) {
    return { ok: false, holdCode: REVIEW_ARTIFACT_HOLD, reason: "REVIEW_ARTIFACT_REQUIRED_BUT_MISSING_OR_INVALID: review-required but no cardId binding resolved" };
  }

  // R1A: live identity is MANDATORY for review-required tasks. Omitting it
  // (or caller-invented arbitrary values) cannot pass — the drift check below
  // additionally rejects any value that does not equal the accepted job's
  // git-derived identity.
  if (!candidateIdentity || typeof candidateIdentity !== "object" || Array.isArray(candidateIdentity)) {
    return { ok: false, holdCode: REVIEW_ARTIFACT_HOLD, reason: "REVIEW_ARTIFACT_REQUIRED_BUT_MISSING_OR_INVALID: live candidate identity missing" };
  }
  if (specDigest == null || typeof specDigest !== "string" || specDigest.length === 0) {
    return { ok: false, holdCode: REVIEW_ARTIFACT_HOLD, reason: "REVIEW_ARTIFACT_REQUIRED_BUT_MISSING_OR_INVALID: live spec digest missing" };
  }

  const current = readReviewJob(cardId, opts);
  if (!current.ok) {
    return { ok: false, holdCode: REVIEW_ARTIFACT_HOLD, reason: `REVIEW_ARTIFACT_REQUIRED_BUT_MISSING_OR_INVALID: ${current.code}` };
  }
  const job = current.job;

  // Exact card binding: the review unit must be the card the task resolves to.
  if (job.lineageId !== cardId) {
    return { ok: false, holdCode: REVIEW_ARTIFACT_HOLD, reason: `REVIEW_ARTIFACT_REQUIRED_BUT_MISSING_OR_INVALID: lineageId ${job.lineageId} != cardId ${cardId}` };
  }

  // Ambiguous / forged review identity: jobId must re-derive from lineage+generation.
  if (job.jobId !== jobIdFor(cardId, job.generation)) {
    return { ok: false, holdCode: REVIEW_ARTIFACT_HOLD, reason: `REVIEW_ARTIFACT_REQUIRED_BUT_MISSING_OR_INVALID: jobId ${job.jobId} != ${jobIdFor(cardId, job.generation)}` };
  }

  // Only an ACCEPTED review job has authority.
  if (job.state !== "ACCEPTED") {
    return { ok: false, holdCode: REVIEW_ARTIFACT_HOLD, reason: `REVIEW_ARTIFACT_REQUIRED_BUT_MISSING_OR_INVALID: review job state ${job.state} != ACCEPTED` };
  }

  // Stale / superseded jobs never satisfy the gate.
  if (job.supersededBy) {
    return { ok: false, holdCode: REVIEW_ARTIFACT_HOLD, reason: `REVIEW_ARTIFACT_REQUIRED_BUT_MISSING_OR_INVALID: review job superseded by ${job.supersededBy}` };
  }

  // R1A: exact live candidate/spec binding (mandatory, not optional).
  const drift = candidateDrift(job.candidateIdentity, candidateIdentity);
  if (drift.length > 0) {
    return { ok: false, holdCode: REVIEW_ARTIFACT_HOLD, reason: `REVIEW_ARTIFACT_REQUIRED_BUT_MISSING_OR_INVALID: candidate drift [${drift.join(",")}]` };
  }
  if (specDrift(job.specDigest, specDigest)) {
    return { ok: false, holdCode: REVIEW_ARTIFACT_HOLD, reason: "REVIEW_ARTIFACT_REQUIRED_BUT_MISSING_OR_INVALID: spec drift" };
  }

  return { ok: true, reviewRequired: true, job };
}
