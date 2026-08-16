// src/governance/review-job-context.mjs
//
// AUTOLOOP-REVART-IMPL1-RC2 — authoritative review-job context derivation.
//
// This module is an ADAPTER/DELEGATOR, not a new authority implementation.
// It reuses the existing Flow-1 owners and only assembles their outputs into
// the review-job binding shape:
//
//   buildChangeInventory  → changedTreeIdentity / patchSha256 / head /
//                           baseHead / branch        (git-derived)
//   computeReviewContext  → single code path for context identity assembly
//   collectFingerprint    → live repository/worktree/remote facts
//   spec-identity         → canonical spec digest (D1)
//
// The Git runner is injected by the caller (scripts layer owns the runner).
// Nothing here reimplements changedTree/patch/branch/HEAD/baseHead/repository
// fingerprint algorithms.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildChangeInventory } from "./change-inventory.mjs";
import { computeReviewContext } from "./review-context.mjs";
import { collectFingerprint } from "../c2d/fingerprint.mjs";
import { specDigestOf } from "./spec-identity.mjs";
import { candidateDomain } from "./candidate-domain-policy.mjs";

export class ReviewJobContextError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "ReviewJobContextError";
    this.code = code;
  }
}

const CANDIDATE_FIELDS = Object.freeze([
  "changedTreeIdentity", "patchSha256", "currentHead", "baseHead", "repository", "branch",
]);

/**
 * Derive the authoritative review-job context from live git state + the
 * canonical spec file. Fail-closed on any authority-bearing datum it cannot
 * establish.
 *
 * @param {object} env
 * @param {(args: string[]) => string} env.git — git runner (throws on error)
 * @param {string} env.cwd — repository root
 * @param {string} env.baseBranch — authority record base (NEVER a bare "main")
 * @param {string} env.specId — nominal spec identifier (locator)
 * @param {string} env.specPath — canonical spec file path (locator); digest is
 *   derived from its bytes, never caller-supplied
 * @param {object} env.authority — authority record (repository binding)
 * @returns {object} authoritative context
 */
export function deriveReviewJobContext({
  git, cwd, baseBranch, specId, specPath = null, authority = {},
  candidateDomainPolicy = candidateDomain,
} = {}) {
  if (typeof git !== "function") {
    throw new ReviewJobContextError("REVIEW_CONTEXT_GIT_MISSING", "git runner required");
  }
  if (!cwd || typeof cwd !== "string") {
    throw new ReviewJobContextError("REVIEW_CONTEXT_CWD_MISSING", "cwd (repository root) required");
  }

  // S1 (Freeze-R2): the canonical spec path is authority-owned. Resolve from
  // authority.spec_path (repo-relative or absolute), never from caller input.
  const boundSpecPath = authority.spec_path ?? "";
  const effectiveSpecPath = boundSpecPath
    ? resolve(cwd, boundSpecPath)
    : (specPath ? resolve(specPath) : "");
  if (!effectiveSpecPath) {
    throw new ReviewJobContextError("REVIEW_CONTEXT_SPEC_PATH_MISSING", "authority.spec_path binding required (S1)");
  }
  // S1.1: a caller-supplied locator must not redirect the authority binding.
  if (boundSpecPath && specPath && resolve(specPath) !== effectiveSpecPath) {
    throw new ReviewJobContextError("REVIEW_CONTEXT_SPEC_PATH_REDIRECT", `spec locator ${specPath} != authority spec_path ${effectiveSpecPath}`);
  }

  // H2 (Freeze-R2): candidate identity consumes the authority-owned domain
  // policy (generated governance/evidence excluded globally).
  const inventory = buildChangeInventory({ git, cwd, baseBranch, candidateDomain: candidateDomainPolicy });
  const context = computeReviewContext({ authority, inventory });

  const repository = context.repository ?? "";
  if (!repository) {
    throw new ReviewJobContextError("REVIEW_CONTEXT_REPOSITORY_MISSING", "authority.repository required (empty)");
  }

  const candidateIdentity = {
    changedTreeIdentity: context.changedTreeIdentity,
    patchSha256: context.patchSha256,
    currentHead: context.currentHead,
    baseHead: context.baseHead,
    repository,
    branch: context.branch,
  };

  // Live repository/worktree/remote facts (derived verification evidence).
  let live = null;
  try {
    live = collectFingerprint(cwd);
  } catch (e) {
    throw new ReviewJobContextError("REVIEW_CONTEXT_LIVE_MISSING", `cannot establish live repository context: ${e?.message ?? e}`);
  }

  // Canonical spec identity — digest derived from bytes at the authority-
  // bound locator path (never from caller-supplied bytes).
  let specBytes;
  try {
    specBytes = readFileSync(effectiveSpecPath);
  } catch (e) {
    throw new ReviewJobContextError("REVIEW_CONTEXT_SPEC_MISSING", `cannot read canonical spec at ${effectiveSpecPath}: ${e?.message ?? e}`);
  }
  const specDigest = specDigestOf(specBytes); // throws SpecIdentityError on invalid UTF-8

  return {
    candidateIdentity,
    specIdentity: { specId, specDigest },
    repositoryRemote: live?.origin_url ?? "",
    worktreeIdentity: live?.worktree_identity ?? "",
    liveHead: live?.expected_head ?? "",
    liveBranch: live?.expected_ref ?? "",
    inventory,
  };
}

/**
 * Field-level candidate drift: returns the authority-bearing fields that
 * differ between the expected (job-bound) and actual (recomputed) candidate
 * identity. Empty array = no drift.
 */
export function candidateDrift(expected, actual) {
  return CANDIDATE_FIELDS.filter((f) => (expected?.[f] ?? "") !== (actual?.[f] ?? ""));
}

/**
 * Candidate CONTENT integrity fields (review-provenance-model-v2 §1.3):
 * the fields that prove the reviewed candidate bytes are intact. `currentHead`
 * is deliberately EXCLUDED — it is a recorded frozen fact (the candidate
 * commit), and governance/evidence commits may legitimately advance live HEAD
 * after the candidate freeze without redefining the candidate.
 */
export const CANDIDATE_INTEGRITY_FIELDS = Object.freeze([
  "changedTreeIdentity", "patchSha256", "baseHead", "repository", "branch",
]);

/**
 * Content-based candidate integrity drift (model v2 §3): compares only the
 * integrity fields. Governance-only HEAD advancement must never produce drift
 * here. Empty array = candidate content intact.
 */
export function candidateIntegrityDrift(expected, actual) {
  return CANDIDATE_INTEGRITY_FIELDS.filter((f) => (expected?.[f] ?? "") !== (actual?.[f] ?? ""));
}

/** Spec drift: true when the recomputed digest differs from the bound digest. */
export function specDrift(expectedDigest, actualDigest) {
  return (expectedDigest ?? "") !== (actualDigest ?? "");
}
