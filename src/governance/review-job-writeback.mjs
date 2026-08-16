// src/governance/review-job-writeback.mjs
//
// AUTOLOOP-REVART-IMPL1 — Flow 2 review-job writeback gate.
//
// Owns the mechanical half of the review artifact lifecycle:
//   capture → normalize → validate → persist → digest → bind → state → stage
//
// It does NOT own ACCEPTED. The reviewer supplies semantic content only and
// never decides whether persistence occurs, the artifact path/filename, the
// schema, the lifecycle state, the digest, acceptance, staging, or downstream
// admission (I2/I3/I5).
//
// Persistence primitives: exclusive-create for immutable generation artifacts
// (same-bytes replay = idempotent; different bytes = REJECT); atomic
// replace-under-lock + monotonic stateVersion CAS for review-job.json.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { sha256Text } from "../evidence/run-evidence-store.mjs";
import { validateAgainstSchema } from "./lifecycle-authorization.mjs";
import {
  writeExclusiveCreate,
} from "../c2d/fs-atomic.mjs";
import {
  REVIEW_FINDINGS_SCHEMA,
  REVIEW_FINDINGS_SCHEMA_ID,
  REVIEW_VERDICT_SCHEMA,
  REVIEW_VERDICT_SCHEMA_ID,
  readReviewJob,
  updateReviewJob,
  findingsPath,
  verdictPath,
  reviewJobPath,
} from "./review-job.mjs";

export function serializeArtifact(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

/**
 * Exclusive-create an immutable generation artifact with deterministic replay
 * semantics:
 *   - absent            → created
 *   - exists, same bytes → RESUME / IDEMPOTENT_SUCCESS
 *   - exists, diff bytes → REJECT / CONFLICTING_REPLAY
 */
export function writeImmutableExclusive(path, bytes) {
  try {
    writeExclusiveCreate(path, bytes);
    return { ok: true, path, idempotent: false };
  } catch (e) {
    const existed = e && (e.code === "JOURNAL_OUT_OF_ORDER" || e?.details?.errno === "EEXIST");
    if (!existed) throw e;
    let existing;
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      throw e;
    }
    if (existing === bytes) {
      return { ok: true, path, idempotent: true };
    }
    return { ok: false, code: "REVIEW_ARTIFACT_CONFLICTING_REPLAY", path };
  }
}

function isTerminalHeld(state) {
  return state === "SUPERSEDED" || state === "HOLD";
}

/** Build the findings object from reviewer content + job bindings. */
export function buildFindingsObject({ job, reviewerIdentity, findings, summary }) {
  return {
    schemaVersion: REVIEW_FINDINGS_SCHEMA_ID,
    jobId: job.jobId,
    lineageId: job.lineageId,
    generation: job.generation,
    candidateIdentity: job.candidateIdentity,
    specIdentity: { specId: job.specId, specDigest: job.specDigest },
    reviewerIdentity,
    findings: Array.isArray(findings) ? findings : [],
    summary: summary ?? "",
    createdAt: new Date().toISOString(),
  };
}

/** Build the verdict object from reviewer judgment + job bindings. */
export function buildVerdictObject({ job, reviewerIdentity, findingsDigest, verdict, summary, recommendedNextAction }) {
  return {
    schemaVersion: REVIEW_VERDICT_SCHEMA_ID,
    jobId: job.jobId,
    lineageId: job.lineageId,
    generation: job.generation,
    candidateIdentity: job.candidateIdentity,
    specIdentity: { specId: job.specId, specDigest: job.specDigest },
    findingsDigest,
    reviewerIdentity,
    verdict,
    summary: summary ?? "",
    recommendedNextAction: recommendedNextAction ?? "",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Persist findings (RUNNING → FINDINGS_CAPTURED).
 * Session-only findings never satisfy this: the artifact must exist at the
 * canonical path, validate, and its digest be recomputed from persisted bytes.
 */
export function persistFindings({ cardId, reviewerIdentity, findings = [], summary = "" }, opts = {}) {
  const current = readReviewJob(cardId, opts);
  if (!current.ok) return current;
  const job = current.job;
  if (isTerminalHeld(job.state)) {
    return { ok: false, code: "REVIEW_JOB_STALE_OR_HELD", state: job.state, job, path: current.path };
  }
  if (job.state === "FINDINGS_CAPTURED" || job.state === "VERDICT_PRODUCED" || job.state === "PERSISTED" || job.state === "STAGED") {
    // resume: findings already persisted; verify identity and return idempotent.
    if (!job.findingsDigest) {
      return { ok: false, code: "REVIEW_JOB_FINDINGS_DIGEST_UNBOUND", job, path: current.path };
    }
    return { ok: true, idempotent: true, findingsDigest: job.findingsDigest, job, path: current.path };
  }
  if (job.state !== "RUNNING") {
    return { ok: false, code: "REVIEW_JOB_STATE_MISMATCH", expected: "RUNNING", actual: job.state, job, path: current.path };
  }

  const obj = buildFindingsObject({ job, reviewerIdentity, findings, summary });
  const errors = validateAgainstSchema(REVIEW_FINDINGS_SCHEMA, obj, "review-findings");
  if (errors.length > 0) {
    return { ok: false, code: "REVIEW_FINDINGS_SCHEMA_INVALID", errors, job, path: current.path };
  }
  const serialized = serializeArtifact(obj);
  const digest = sha256Text(serialized);

  const target = findingsPath(cardId, job.generation, opts);
  const wrote = writeImmutableExclusive(target, serialized);
  if (!wrote.ok) return { ...wrote, job, path: current.path };

  const updated = updateReviewJob(cardId, {
    expectedStateVersion: job.stateVersion,
    patch: { state: "FINDINGS_CAPTURED", findingsDigest: digest },
  }, opts);
  if (!updated.ok) return { ...updated, artifactPath: target };
  return { ok: true, findingsDigest: digest, artifactPath: target, idempotent: wrote.idempotent, job: updated.job };
}

/**
 * Persist verdict (FINDINGS_CAPTURED → VERDICT_PRODUCED).
 * The verdict value is the reviewer's JUDGMENT; its durable writeback is
 * mechanical. A verdict cannot be authoritative without the exact findings
 * binding (findingsDigest) and without the persisted findings digest matching.
 */
export function persistVerdict({ cardId, reviewerIdentity, verdict, summary = "", recommendedNextAction = "" }, opts = {}) {
  const current = readReviewJob(cardId, opts);
  if (!current.ok) return current;
  const job = current.job;
  if (isTerminalHeld(job.state)) {
    return { ok: false, code: "REVIEW_JOB_STALE_OR_HELD", state: job.state, job, path: current.path };
  }
  if (job.state === "VERDICT_PRODUCED" || job.state === "PERSISTED" || job.state === "STAGED") {
    if (!job.verdictDigest) {
      return { ok: false, code: "REVIEW_JOB_VERDICT_DIGEST_UNBOUND", job, path: current.path };
    }
    return { ok: true, idempotent: true, verdictDigest: job.verdictDigest, job, path: current.path };
  }
  if (job.state !== "FINDINGS_CAPTURED") {
    return { ok: false, code: "REVIEW_JOB_STATE_MISMATCH", expected: "FINDINGS_CAPTURED", actual: job.state, job, path: current.path };
  }
  if (!job.findingsDigest) {
    return { ok: false, code: "REVIEW_JOB_FINDINGS_DIGEST_UNBOUND", job, path: current.path };
  }

  // Verify the persisted findings bytes still match the bound digest.
  const fpath = findingsPath(cardId, job.generation, opts);
  let fbytes;
  try {
    fbytes = readFileSync(fpath, "utf8");
  } catch {
    return { ok: false, code: "REVIEW_FINDINGS_ARTIFACT_MISSING", job, path: current.path };
  }
  const recomputedFindingsDigest = sha256Text(fbytes);
  if (recomputedFindingsDigest !== job.findingsDigest) {
    return { ok: false, code: "REVIEW_FINDINGS_DIGEST_MISMATCH", bound: job.findingsDigest, recomputed: recomputedFindingsDigest, job, path: current.path };
  }

  const obj = buildVerdictObject({ job, reviewerIdentity, findingsDigest: job.findingsDigest, verdict, summary, recommendedNextAction });
  const errors = validateAgainstSchema(REVIEW_VERDICT_SCHEMA, obj, "review-verdict");
  if (errors.length > 0) {
    return { ok: false, code: "REVIEW_VERDICT_SCHEMA_INVALID", errors, job, path: current.path };
  }
  const serialized = serializeArtifact(obj);
  const digest = sha256Text(serialized);

  const target = verdictPath(cardId, job.generation, opts);
  const wrote = writeImmutableExclusive(target, serialized);
  if (!wrote.ok) return { ...wrote, job, path: current.path };

  const updated = updateReviewJob(cardId, {
    expectedStateVersion: job.stateVersion,
    patch: { state: "VERDICT_PRODUCED", verdictDigest: digest },
  }, opts);
  if (!updated.ok) return { ...updated, artifactPath: target };
  return { ok: true, verdictDigest: digest, artifactPath: target, idempotent: wrote.idempotent, job: updated.job };
}

/**
 * Re-verify both artifacts are present, immutable, and digest-bound
 * (VERDICT_PRODUCED → PERSISTED). Mechanical; no judgment.
 */
export function finalizePersisted({ cardId }, opts = {}) {
  const current = readReviewJob(cardId, opts);
  if (!current.ok) return current;
  const job = current.job;
  if (job.state === "PERSISTED" || job.state === "STAGED" || job.state === "ACCEPTED" || job.state === "DOWNSTREAM_AUTHORIZED") {
    return { ok: true, idempotent: true, job, path: current.path };
  }
  if (job.state !== "VERDICT_PRODUCED") {
    return { ok: false, code: "REVIEW_JOB_STATE_MISMATCH", expected: "VERDICT_PRODUCED", actual: job.state, job, path: current.path };
  }
  if (!job.findingsDigest || !job.verdictDigest) {
    return { ok: false, code: "REVIEW_JOB_DIGESTS_UNBOUND", job, path: current.path };
  }
  // Re-read both artifacts and recompute digests from persisted bytes.
  let fbytes, vbytes;
  try {
    fbytes = readFileSync(findingsPath(cardId, job.generation, opts), "utf8");
    vbytes = readFileSync(verdictPath(cardId, job.generation, opts), "utf8");
  } catch {
    return { ok: false, code: "REVIEW_ARTIFACT_MISSING", job, path: current.path };
  }
  if (sha256Text(fbytes) !== job.findingsDigest) {
    return { ok: false, code: "REVIEW_FINDINGS_DIGEST_MISMATCH", job, path: current.path };
  }
  if (sha256Text(vbytes) !== job.verdictDigest) {
    return { ok: false, code: "REVIEW_VERDICT_DIGEST_MISMATCH", job, path: current.path };
  }
  return updateReviewJob(cardId, {
    expectedStateVersion: job.stateVersion,
    patch: { state: "PERSISTED" },
  }, opts);
}

/**
 * Stage the exact lifecycle artifacts (PERSISTED → STAGED).
 * Stages only the canonical review-job/findings/verdict files; never the
 * AUTH1 candidate. Verifies the staged set equals the authorized set.
 * STAGED is a prerequisite to ACCEPTED.
 */
export function stageArtifacts({ cardId, git, repoRoot }, opts = {}) {
  const current = readReviewJob(cardId, opts);
  if (!current.ok) return current;
  const job = current.job;
  if (job.state === "STAGED" || job.state === "ACCEPTED" || job.state === "DOWNSTREAM_AUTHORIZED") {
    return { ok: true, idempotent: true, job, path: current.path };
  }
  if (job.state !== "PERSISTED") {
    return { ok: false, code: "REVIEW_JOB_STATE_MISMATCH", expected: "PERSISTED", actual: job.state, job, path: current.path };
  }
  // RC2 freeze §4.2 — STAGED must mean real, verified Git-staged state.
  if (typeof git !== "function") {
    return { ok: false, code: "REVIEW_STAGING_GIT_MISSING", job, path: current.path };
  }
  // Re-verify finalized artifact digests from disk (TOCTOU between finalize and stage).
  if (!job.findingsDigest || !job.verdictDigest) {
    return { ok: false, code: "REVIEW_JOB_DIGESTS_UNBOUND", job, path: current.path };
  }
  let fbytes, vbytes;
  try {
    fbytes = readFileSync(findingsPath(cardId, job.generation, opts), "utf8");
    vbytes = readFileSync(verdictPath(cardId, job.generation, opts), "utf8");
  } catch {
    return { ok: false, code: "REVIEW_ARTIFACT_MISSING", job, path: current.path };
  }
  if (sha256Text(fbytes) !== job.findingsDigest) {
    return { ok: false, code: "REVIEW_FINDINGS_DIGEST_MISMATCH", job, path: current.path };
  }
  if (sha256Text(vbytes) !== job.verdictDigest) {
    return { ok: false, code: "REVIEW_VERDICT_DIGEST_MISMATCH", job, path: current.path };
  }
  // Canonical artifact paths (repo-relative when repoRoot is provided; the
  // orchestrator always supplies it so git add + staged-set equality align).
  const authorized = [
    reviewJobPath(cardId, opts),
    findingsPath(cardId, job.generation, opts),
    verdictPath(cardId, job.generation, opts),
  ].map((p) => (repoRoot ? relative(repoRoot, p) : p));
  for (const p of authorized) git(["add", p]);
  const staged = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean).sort();
  const expected = [...authorized].sort();
  // Bidirectional staged-set equality: no unexpected, no missing.
  const unexpected = staged.filter((p) => !expected.includes(p));
  if (unexpected.length > 0) {
    return { ok: false, code: "REVIEW_STAGING_UNEXPECTED_MATERIAL", unexpected, job, path: current.path };
  }
  const missing = expected.filter((p) => !staged.includes(p));
  if (missing.length > 0) {
    return { ok: false, code: "REVIEW_STAGING_INCOMPLETE", missing, job, path: current.path };
  }
  return updateReviewJob(cardId, {
    expectedStateVersion: job.stateVersion,
    patch: { state: "STAGED" },
  }, opts);
}

export { sha256Text };
