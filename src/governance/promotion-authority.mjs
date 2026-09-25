// src/governance/promotion-authority.mjs
//
// AUTOLOOP-PGMA1 — canonical promotion authority shared by the push gate and
// the draft-PR gate. Replaces the RC1A-retired `external-review-result.json`
// dependency (RC1A §7.2: any read of it for production acceptance is a
// violation).
//
// Frozen inputs (docs/pi-graph-output/pgma1/autoloop-pgma1-card-spec.md,
// RC1A §7/§8/§17/T8):
//   1. review-job ACCEPTED      — docs/pi-graph-output/<card>/review-job.json
//   2. external delivery PASS   — <surface>/delivery.json verdict bound to the
//                                 CURRENT bundle identity+sha256; bundle body
//                                 digest recomputed from the delivered file
//   3. recomputed candidate identity — buildChangeInventory with the harness's
//                                 own candidateDomain classifier (E1-A); must
//                                 equal the review-job candidate identity
//   4. live branch/remote HEAD exact match — reviewed currentHead == local
//                                 HEAD == remote refs/heads/<branch>
//
// Both gates verify the SAME evidence set and compute the SAME promotion
// identity; neither may judge a different authority set. The retired artifact
// is NEVER read and its presence grants nothing.
//
// Fail-closed: any missing/mismatched/stale input → HOLD with a specific code.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256Text } from "../evidence/run-evidence-store.mjs";
import { readConfigEnv } from "../shared/autoloop-paths.mjs";
import { readReviewJob } from "./review-job.mjs";

export const PROMOTION_AUTHORITY_HOLDS = Object.freeze({
  REVIEW_JOB_MISSING: "HOLD / PROMOTION_AUTHORITY_REVIEW_JOB_MISSING",
  REVIEW_JOB_INVALID: "HOLD / PROMOTION_AUTHORITY_REVIEW_JOB_INVALID",
  REVIEW_JOB_NOT_ACCEPTED: "HOLD / PROMOTION_AUTHORITY_REVIEW_JOB_NOT_ACCEPTED",
  DELIVERY_MISSING: "HOLD / PROMOTION_AUTHORITY_DELIVERY_MISSING",
  DELIVERY_INVALID: "HOLD / PROMOTION_AUTHORITY_DELIVERY_INVALID",
  DELIVERY_NOT_PASS: "HOLD / PROMOTION_AUTHORITY_DELIVERY_NOT_PASS",
  DELIVERY_VERDICT_UNBOUND: "HOLD / PROMOTION_AUTHORITY_DELIVERY_VERDICT_UNBOUND",
  DELIVERY_BUNDLE_DIGEST_MISMATCH: "HOLD / PROMOTION_AUTHORITY_DELIVERY_BUNDLE_DIGEST_MISMATCH",
  DELIVERY_STALE: "HOLD / PROMOTION_AUTHORITY_DELIVERY_STALE",
  CANDIDATE_IDENTITY_MISMATCH: "HOLD / PROMOTION_AUTHORITY_CANDIDATE_IDENTITY_MISMATCH",
  HEAD_MISMATCH_LOCAL: "HOLD / PROMOTION_AUTHORITY_HEAD_MISMATCH_LOCAL",
  HEAD_MISMATCH_REMOTE: "HOLD / PROMOTION_AUTHORITY_HEAD_MISMATCH_REMOTE",
  REMOTE_UNREACHABLE: "HOLD / PROMOTION_AUTHORITY_REMOTE_UNREACHABLE",
  REMOTE_DIVERGED: "HOLD / PROMOTION_AUTHORITY_REMOTE_DIVERGED",
});

export const PROMOTION_STATUS = Object.freeze({
  AUTHORIZED: "PROMOTION_AUTHORIZED",
  ALREADY_SATISFIED: "PROMOTION_ALREADY_SATISFIED",
});

const REVIEW_JOB_ROOT = join("docs", "pi-graph-output");

/** Fail-closed read of the canonical review-job record (must be ACCEPTED). */
export function readReviewJobEvidence(cardId, { cwd = process.cwd(), root = null } = {}) {
  const base = root
    ? resolve(root)
    : (readConfigEnv(process.env, "AEGISFLOW_PI_GRAPH_OUTPUT")
        ? resolve(readConfigEnv(process.env, "AEGISFLOW_PI_GRAPH_OUTPUT").value)
        : resolve(join(cwd, REVIEW_JOB_ROOT)));
  const r = readReviewJob(cardId, { root: base });
  if (!r.ok) {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.REVIEW_JOB_MISSING, errors: [`review-job for ${cardId}: ${r.code ?? "unavailable"}`] };
  }
  const job = r.job;
  if (!job || typeof job !== "object") {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.REVIEW_JOB_INVALID, errors: ["review-job record is not an object"] };
  }
  if (job.state !== "ACCEPTED") {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.REVIEW_JOB_NOT_ACCEPTED, errors: [`review-job state is ${job.state}, not ACCEPTED`] };
  }
  const ci = job.candidateIdentity ?? {};
  for (const f of ["changedTreeIdentity", "patchSha256", "currentHead", "baseHead", "repository", "branch"]) {
    if (typeof ci[f] !== "string" || ci[f].length === 0) {
      return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.REVIEW_JOB_INVALID, errors: [`candidateIdentity.${f} missing on ACCEPTED review-job`] };
    }
  }
  if (typeof job.jobId !== "string" || job.jobId.length === 0 || !Number.isInteger(job.generation)) {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.REVIEW_JOB_INVALID, errors: ["jobId/generation missing on ACCEPTED review-job"] };
  }
  return { ok: true, record: job };
}

/** Fail-closed read of the surface delivery record (must carry a bound PASS). */
export function readDeliveryEvidence(surfaceDir) {
  const p = join(resolve(surfaceDir), "delivery.json");
  if (!existsSync(p)) {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.DELIVERY_MISSING, errors: [`delivery record missing: ${p}`] };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.DELIVERY_INVALID, errors: [`delivery record unreadable: ${p}`] };
  }
  if (raw?.externalReviewStatus !== "PASS") {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.DELIVERY_NOT_PASS, errors: [`externalReviewStatus is ${raw?.externalReviewStatus ?? "missing"}, not PASS`] };
  }
  const v = raw.verdict;
  const d = raw.delivery;
  const bound =
    v && v.verdict === "PASS" &&
    typeof v.bundleIdentity === "string" && /^[0-9a-f]{64}$/.test(v.bundleIdentity) &&
    typeof v.bundleSha256 === "string" && /^[0-9a-f]{64}$/.test(v.bundleSha256) &&
    d && d.reviewBundleIdentity === v.bundleIdentity &&
    d.reviewBundleSha256 === v.bundleSha256;
  if (!bound) {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.DELIVERY_VERDICT_UNBOUND, errors: ["delivery verdict PASS is not bound to a consistent current bundle identity+sha256"] };
  }
  if (typeof raw.cardId !== "string" || raw.cardId.length === 0) {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.DELIVERY_INVALID, errors: ["delivery record cardId missing"] };
  }
  return { ok: true, record: raw };
}

/**
 * Recompute the delivered bundle body digest (content above the
 * `REVIEW_BUNDLE_SHA256:` footer line) from the surface bundle file and
 * compare it with the bound digest. Fail-closed on missing file/mismatch.
 */
export function verifyDeliveryBundleDigest(surfaceDir, { expectedSha256, expectedIdentity } = {}) {
  const p = join(resolve(surfaceDir), "review-bundle.txt");
  if (!existsSync(p)) {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.DELIVERY_BUNDLE_DIGEST_MISMATCH, errors: [`delivered bundle missing: ${p}`] };
  }
  const data = readFileSync(p, "utf8");
  const marker = "REVIEW_BUNDLE_SHA256:";
  const idx = data.lastIndexOf(marker);
  const body = idx >= 0 ? data.slice(0, idx) : data;
  const actual = sha256Text(body);
  const identityMatch = !expectedIdentity || data.includes(expectedIdentity);
  if (expectedSha256 && actual !== expectedSha256) {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.DELIVERY_BUNDLE_DIGEST_MISMATCH, errors: [`delivered bundle body sha256 ${actual} != bound ${expectedSha256}`] };
  }
  if (expectedIdentity && !identityMatch) {
    return { ok: false, code: PROMOTION_AUTHORITY_HOLDS.DELIVERY_VERDICT_UNBOUND, errors: ["delivered bundle does not carry the bound bundle identity"] };
  }
  return { ok: true, sha256: actual };
}

/**
 * Single promotion-authority identity shared by the push gate and the
 * draft-PR gate. Both gates compute this from the SAME canonical evidence.
 */
export function computePromotionIdentity({ reviewJob, delivery, bundleSha256 }) {
  const ci = reviewJob?.candidateIdentity ?? {};
  const v = delivery?.verdict ?? {};
  const d = delivery?.delivery ?? {};
  const canonical = {
    cardId: reviewJob?.lineageId ?? "",
    jobId: reviewJob?.jobId ?? "",
    generation: reviewJob?.generation ?? null,
    changedTreeIdentity: ci.changedTreeIdentity ?? "",
    patchSha256: ci.patchSha256 ?? "",
    currentHead: ci.currentHead ?? "",
    baseHead: ci.baseHead ?? "",
    repository: ci.repository ?? "",
    branch: ci.branch ?? "",
    verdict: v.verdict ?? "",
    bundleIdentity: d.reviewBundleIdentity ?? "",
    bundleSha256: bundleSha256 ?? d.reviewBundleSha256 ?? "",
  };
  return sha256Text(JSON.stringify(canonical));
}

/**
 * Evaluate the canonical promotion authority.
 *
 * @param {object} args
 * @param {object} args.reviewJob — ACCEPTED review-job record
 * @param {object} args.delivery — PASS delivery record
 * @param {string} args.bundleSha256 — recomputed delivered bundle body digest
 * @param {object} args.inventory — candidate-domain change inventory
 * @param {string} args.localHead — recomputed local HEAD
 * @param {string|null} args.remoteHead — remote refs/heads/<branch> head (null = unknown)
 * @param {boolean} args.remoteReachable — remote probe result
 * @param {boolean} args.fastForwardOnly — remote head is an ancestor of the
 *   reviewed head (or remote branch absent)
 * @returns {{allowed: boolean, status: string, identity: string, violations: string[]}}
 */
export function evaluatePromotionAuthority({
  reviewJob,
  delivery,
  bundleSha256,
  inventory,
  localHead,
  remoteHead = null,
  remoteReachable = false,
  fastForwardOnly = false,
}) {
  const violations = [];
  const ci = reviewJob.candidateIdentity;

  // Fail-closed on malformed canonical evidence (never crash, never pass).
  if (!delivery || delivery.externalReviewStatus !== "PASS" || !delivery.verdict || delivery.verdict.verdict !== "PASS") {
    violations.push(`${PROMOTION_AUTHORITY_HOLDS.DELIVERY_NOT_PASS}: externalReviewStatus/verdict is not PASS`);
  }
  if (!delivery || !delivery.delivery || typeof delivery.delivery.reviewBundleIdentity !== "string" || typeof delivery.delivery.reviewBundleSha256 !== "string") {
    violations.push(`${PROMOTION_AUTHORITY_HOLDS.DELIVERY_VERDICT_UNBOUND}: delivery record lacks a bound bundle identity/sha256`);
  }

  // Frozen input 3: recomputed candidate identity must equal the review-job's.
  if (inventory.changedTreeIdentity !== ci.changedTreeIdentity || inventory.patchSha256 !== ci.patchSha256) {
    violations.push(`${PROMOTION_AUTHORITY_HOLDS.CANDIDATE_IDENTITY_MISMATCH}: recomputed tree ${inventory.changedTreeIdentity}/patch ${inventory.patchSha256} != review-job ${ci.changedTreeIdentity}/${ci.patchSha256}`);
  }
  // The candidate identity contract (RC1A §8) includes baseHead: an advance of
  // the base after review is staleness, even when the change set is unchanged.
  if (inventory.baseHead !== ci.baseHead) {
    violations.push(`${PROMOTION_AUTHORITY_HOLDS.CANDIDATE_IDENTITY_MISMATCH}: recomputed baseHead ${inventory.baseHead} != review-job baseHead ${ci.baseHead}`);
  }
  // Frozen input 4: reviewed HEAD must equal the local HEAD.
  if (localHead !== ci.currentHead) {
    violations.push(`${PROMOTION_AUTHORITY_HOLDS.HEAD_MISMATCH_LOCAL}: local HEAD ${localHead} != reviewed ${ci.currentHead}`);
  }
  if (inventory.head !== ci.currentHead) {
    violations.push(`${PROMOTION_AUTHORITY_HOLDS.HEAD_MISMATCH_LOCAL}: inventory head ${inventory.head} != reviewed ${ci.currentHead}`);
  }
  if (inventory.branch !== ci.branch) {
    violations.push(`${PROMOTION_AUTHORITY_HOLDS.DELIVERY_STALE}: branch ${inventory.branch} != review-job branch ${ci.branch}`);
  }
  // Delivery staleness: delivery card must match the review-job lineage.
  if (delivery.cardId !== reviewJob.lineageId) {
    violations.push(`${PROMOTION_AUTHORITY_HOLDS.DELIVERY_STALE}: delivery cardId ${delivery.cardId} != review-job lineage ${reviewJob.lineageId}`);
  }

  if (violations.length > 0) {
    return { allowed: false, status: "HOLD", identity: computePromotionIdentity({ reviewJob, delivery, bundleSha256 }), violations };
  }

  const identity = computePromotionIdentity({ reviewJob, delivery, bundleSha256 });

  // Frozen input 4 (remote leg): remote must be reachable and, when known,
  // either already exactly the reviewed head (already satisfied) or an
  // ancestor (fast-forward push possible). Diverged/unknown → HOLD.
  if (!remoteReachable) {
    return { allowed: false, status: "HOLD", identity, violations: [`${PROMOTION_AUTHORITY_HOLDS.REMOTE_UNREACHABLE}: remote probe failed`] };
  }
  if (remoteHead === null) {
    // Reachable remote with no ref yet: the FIRST push creates the branch
    // at the reviewed head — pure addition, nothing to diverge from. The
    // reviewed head lands exactly on the new remote ref (exact-head holds).
    return { allowed: true, status: PROMOTION_STATUS.AUTHORIZED, identity, violations: [] };
  }
  if (remoteHead === ci.currentHead) {
    return { allowed: true, status: PROMOTION_STATUS.ALREADY_SATISFIED, identity, violations: [] };
  }
  // Not equal: the remote must be an ancestor of the reviewed head (pure
  // fast-forward). Divergence is never auto-resolved.
  if (fastForwardOnly) {
    return { allowed: true, status: PROMOTION_STATUS.AUTHORIZED, identity, violations: [] };
  }
  return {
    allowed: false,
    status: "HOLD",
    identity,
    violations: [`${PROMOTION_AUTHORITY_HOLDS.REMOTE_DIVERGED}: remote refs/heads/${ci.branch} ${remoteHead} is not an ancestor of reviewed head ${ci.currentHead}`],
  };
}
