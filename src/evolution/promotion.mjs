// src/evolution/promotion.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Sections G + H + I:
// autonomous commit, independent review, and policy-gated promotion for
// LOW-risk evolution candidates.
//
// Authority model (card §G/§H/§I/§M — extends, never bypasses):
//   - The candidate mutates in an ISOLATED C3B worktree; the production
//     checkout is untouched until promotion.
//   - AUTONOMOUS COMMIT (LOW risk + fitness PASS only): the candidate's
//     verified tree is committed to a dedicated evolution branch
//     (refs/heads/evolution/<candidate-id>) — NEVER main/master. The commit
//     binds candidate identity, baseline, evidence and validation results.
//   - INDEPENDENT REVIEW: the existing review machinery stays authoritative.
//     For the autonomous path the reviewer is the same independent reviewer
//     surface (review-verdict artifact with reviewerIdentity != implementer),
//     machine-verifiable PASS required. The reviewer is never the mutation
//     authority (it receives the candidate handoff, it cannot issue
//     authorizations).
//   - AUTONOMOUS PROMOTION (LOW risk only) requires ALL of:
//       policy preauthorization + fitness PASS + regression PASS +
//       independent review PASS + candidate identity match +
//       live HEAD/base match + semantic drift gate PASS.
//     Any mismatch → FAIL CLOSED (HOLD).
//   - MEDIUM: autonomous mutation/evaluation allowed; promotion requires the
//     operator (existing commit-authorization boundary, unchanged).
//   - HIGH: never mutates (refused upstream at policy classification).
//
// The promotion itself is a FAST-FORLOW-RISK branch advance recorded in the
// evolution ledger; main/master integration stays with the existing human
// gates (PGMA1 / push gate) — autonomous promotion NEVER touches them.

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { C2dHoldError, writeJsonExclusiveCreate, assertNotSymlink } from "../c2d/fs-atomic.mjs";
import { canonicalize, digestOf } from "../canonical-digest.mjs";
import { EVOLUTION_POLICY_HOLD } from "./policy.mjs";

export const EVOLUTION_PROMOTION_SCHEMA = "autoloop.evolution-promotion/v1";
export const EVOLUTION_PROMOTION_HOLD = Object.freeze({
  NOT_LOW_RISK: "HOLD / EVOLUTION_PROMOTION_NOT_LOW_RISK",
  FITNESS_NOT_PASS: "HOLD / EVOLUTION_PROMOTION_FITNESS_NOT_PASS",
  REGRESSION_NOT_PASS: "HOLD / EVOLUTION_PROMOTION_REGRESSION_NOT_PASS",
  REVIEW_NOT_PASS: "HOLD / EVOLUTION_PROMOTION_REVIEW_NOT_PASS",
  REVIEWER_NOT_INDEPENDENT: "HOLD / EVOLUTION_PROMOTION_REVIEWER_NOT_INDEPENDENT",
  IDENTITY_MISMATCH: "HOLD / EVOLUTION_PROMOTION_IDENTITY_MISMATCH",
  HEAD_MISMATCH: "HOLD / EVOLUTION_PROMOTION_HEAD_MISMATCH",
  SEMANTIC_DRIFT: "HOLD / EVOLUTION_PROMOTION_SEMANTIC_DRIFT",
  POLICY_NOT_AUTHORIZED: "HOLD / EVOLUTION_PROMOTION_POLICY_NOT_AUTHORIZED",
  MEDIUM_REQUIRES_OPERATOR: "HOLD / EVOLUTION_PROMOTION_MEDIUM_REQUIRES_OPERATOR",
  COMMIT_FAILED: "HOLD / EVOLUTION_PROMOTION_COMMIT_FAILED",
  BRANCH_REFUSED: "HOLD / EVOLUTION_PROMOTION_BRANCH_REFUSED",
});

function fail(code, message) {
  throw new C2dHoldError(code, message);
}

function git(repoRoot, args) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: r.stderr ?? "" };
}

function gitOk(repoRoot, args, code, message) {
  const r = git(repoRoot, args);
  if (r.status !== 0) fail(code, `${message ?? `git ${args[0]} failed`}: ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}

/**
 * The evolution branch name for one candidate. Dedicated namespace — never
 * main/master, never an existing feature branch.
 */
export function evolutionBranchFor(candidateId) {
  if (!/^ecand_[0-9a-f]{40}$/.test(candidateId || "")) {
    fail(EVOLUTION_PROMOTION_HOLD.BRANCH_REFUSED, `candidate id invalid for branch naming: ${candidateId}`);
  }
  return `evolution/${candidateId}`;
}

/**
 * AUTONOMOUS COMMIT (Section G). Commits the candidate's verified tree to
 * the dedicated evolution branch. Refuses main/master unconditionally.
 *
 * The candidate tree comes from the C3B candidate capture (retention ref
 * refs/autoloop/candidates/<id>) — the exact verified tree, never a
 * re-derived approximation.
 *
 * @param {object} p
 * @param {string} p.repoRoot
 * @param {object} p.candidate — derived candidate
 * @param {string} p.candidateTree — 40-hex verified tree oid (C3B capture)
 * @param {string} p.baselineHead — the frozen baseline the tree sits on
 * @param {object} p.fitness — evaluateFitness result (decision must be ACCEPT)
 * @param {object} p.mutationEvidence — C3B evidence bundle (validation results bound)
 */
export function commitCandidateToEvolutionBranch({ repoRoot, candidate, candidateTree, baselineHead, fitness, mutationEvidence }) {
  if (fitness?.decision !== "ACCEPT") {
    fail(EVOLUTION_PROMOTION_HOLD.FITNESS_NOT_PASS, `fitness decision ${fitness?.decision ?? "missing"} — only ACCEPT commits`);
  }
  const branch = evolutionBranchFor(candidate.candidate_id);
  // NEVER main/master (card §G).
  for (const protectedRef of ["main", "master", "refs/heads/main", "refs/heads/master"]) {
    if (branch === protectedRef) fail(EVOLUTION_PROMOTION_HOLD.BRANCH_REFUSED, `protected ref ${protectedRef} is never an evolution target`);
  }
  // Tree identity must be proven against the baseline.
  const entries = gitOk(repoRoot, ["diff-tree", "-r", "--raw", "--no-renames", baselineHead, candidateTree], EVOLUTION_PROMOTION_HOLD.IDENTITY_MISMATCH, "candidate tree unverifiable");
  if (!entries) fail(EVOLUTION_PROMOTION_HOLD.IDENTITY_MISMATCH, "empty tree diff");
  // commit-tree the verified tree onto the baseline.
  const subject = `evolution: ${candidate.candidate_id} (${candidate.signal_class})`;
  const body = [
    `candidate: ${candidate.candidate_id}`,
    `candidate_digest: ${candidate.candidate_digest}`,
    `baseline: ${baselineHead}`,
    `trigger: ${candidate.trigger_id} (${candidate.signal_class})`,
    `evidence_refs: ${candidate.evidence_refs.join(",")}`,
    `fitness: ${fitness.fitness_digest} (${fitness.verdict})`,
    `validation: ${(mutationEvidence?.validation_results ?? []).length} command(s)`,
    `derivation_strategy: ${candidate.derivation_strategy}`,
    `risk_class: ${candidate.risk_class}`,
  ].join("\n");
  const env = {
    GIT_AUTHOR_NAME: "autoloop-evolution", GIT_AUTHOR_EMAIL: "evolution@autoloop.local",
    GIT_COMMITTER_NAME: "autoloop-evolution", GIT_COMMITTER_EMAIL: "evolution@autoloop.local",
  };
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "commit-tree", candidateTree, "-p", baselineHead, "-m", `${subject}\n\n${body}`], {
    cwd: repoRoot, encoding: "utf8", env,
  });
  if (r.status !== 0 || !/^[0-9a-f]{40}$/.test((r.stdout ?? "").trim())) {
    fail(EVOLUTION_PROMOTION_HOLD.COMMIT_FAILED, `commit-tree failed: ${(r.stderr ?? "").trim().slice(0, 300)}`);
  }
  const commitOid = r.stdout.trim();
  // Advance ONLY the evolution branch (fast-forward create/update from baseline).
  const cur = git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (cur.status === 0 && cur.stdout !== baselineHead) {
    fail(EVOLUTION_PROMOTION_HOLD.HEAD_MISMATCH, `evolution branch ${branch} is at ${cur.stdout}, expected baseline ${baselineHead}`);
  }
  const upd = git(repoRoot, ["update-ref", `refs/heads/${branch}`, commitOid, cur.status === 0 ? cur.stdout : `${"0".repeat(40)}`]);
  if (upd.status !== 0) fail(EVOLUTION_PROMOTION_HOLD.COMMIT_FAILED, `branch update failed: ${upd.stderr.trim().slice(0, 300)}`);
  return { branch, commit_oid: commitOid, parent: baselineHead, tree: candidateTree };
}

/**
 * Independent review binding (Section H). The reviewer artifact follows the
 * existing reviewed-commit-candidate conventions: a durable, digest-bound
 * verdict bound to the candidate identity. The reviewer identity must differ
 * from the implementer (the evolution pipeline) — SELF-APPROVAL fence.
 *
 * @param {object} p
 * @param {string} p.storeRoot — evolution store root
 * @param {object} p.candidate
 * @param {object} p.fitness
 * @param {string} p.reviewerIdentity — independent reviewer identity (never agent:self)
 * @param {"PASS"|"REPAIR"|"HOLD"} p.verdict
 * @param {string} p.summary
 */
export function bindEvolutionReview({ storeRoot, candidate, fitness, reviewerIdentity, verdict, summary }) {
  if (!reviewerIdentity || /^agent:/i.test(reviewerIdentity) || reviewerIdentity === "autoloop-evolution") {
    fail(EVOLUTION_PROMOTION_HOLD.REVIEWER_NOT_INDEPENDENT, `reviewer identity not independent: ${reviewerIdentity}`);
  }
  const artifact = {
    schema: "autoloop.evolution-review/v1",
    candidate_id: candidate.candidate_id,
    candidate_digest: candidate.candidate_digest,
    fitness_digest: fitness.fitness_digest,
    fitness_verdict: fitness.verdict,
    reviewer_identity: reviewerIdentity,
    review_verdict: verdict,
    summary: String(summary ?? "").slice(0, 2000),
    reviewed_at: new Date().toISOString(),
  };
  artifact.review_digest = digestOf({ ...artifact, review_digest: undefined });
  mkdirSync(join(storeRoot, "reviews"), { recursive: true });
  const p = join(storeRoot, "reviews", `${candidate.candidate_id}.json`);
  if (existsSync(p)) {
    assertNotSymlink(p);
    const old = JSON.parse(readFileSync(p, "utf8"));
    if (old.review_digest !== artifact.review_digest) {
      fail(EVOLUTION_PROMOTION_HOLD.IDENTITY_MISMATCH, "conflicting review artifact for candidate");
    }
    return old;
  }
  writeJsonExclusiveCreate(p, artifact);
  return artifact;
}

function readEvolutionReview(storeRoot, candidateId) {
  const p = join(storeRoot, "reviews", `${candidateId}.json`);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  try {
    const a = JSON.parse(readFileSync(p, "utf8"));
    if (a?.schema !== "autoloop.evolution-review/v1") return null;
    if (a.review_digest !== digestOf({ ...a, review_digest: undefined })) return null;
    return a;
  } catch { return null; }
}

/**
 * Semantic drift gate for the evolution path (Section I / §M): the
 * candidate's declared success contract must match the digest bound in the
 * promotion record — reuse THE canonical digest conventions
 * (closeout-state.mjs successContractDigestOf semantics via canonicalize).
 */
export function semanticDriftCheck({ declaredContract, boundDigest }) {
  if (boundDigest == null) return { ok: true, reason: "no_freeze" };
  if (!declaredContract) return { ok: false, reason: "SEMANTIC_DRIFT:contract_removed_after_binding" };
  const live = digestOf(declaredContract);
  if (live !== boundDigest) {
    return { ok: false, reason: `SEMANTIC_DRIFT:bound ${String(boundDigest).slice(0, 12)}… live ${live.slice(0, 12)}…` };
  }
  return { ok: true, reason: null };
}

/**
 * AUTONOMOUS PROMOTION decision (Section I). ALL gates must pass; any
 * mismatch fails closed. This DECIDES; the caller performs the branch
 * advance via commitCandidateToEvolutionBranch (or, for an already-committed
 * candidate, verifies the branch state).
 *
 * @param {object} p
 * @param {object} p.policy — readEvolutionPolicy result (must still be valid)
 * @param {object} p.authorization — authorizeUnderPolicy result for THIS candidate
 * @param {object} p.candidate
 * @param {object} p.fitness — evaluateFitness result
 * @param {string} p.storeRoot
 * @param {string} p.liveBaselineHead — the CURRENT production HEAD (must equal candidate baseline)
 * @param {object} [p.declaredContract] — the candidate's declared success contract
 * @param {string} [p.boundContractDigest] — digest bound at derivation time
 */
export function evaluateAutonomousPromotion({ policy, authorization, candidate, fitness, storeRoot, liveBaselineHead, declaredContract = null, boundContractDigest = null }) {
  // 1. policy preauthorization (re-read, re-verified — never trusted stale).
  if (!authorization?.authorized || authorization.policyId !== policy.policy_id) {
    fail(EVOLUTION_PROMOTION_HOLD.POLICY_NOT_AUTHORIZED, "candidate is not authorized under the CURRENT policy");
  }
  // 2. risk class: LOW only for autonomous promotion.
  if (candidate.risk_class !== "LOW") {
    if (candidate.risk_class === "MEDIUM") {
      fail(EVOLUTION_PROMOTION_HOLD.MEDIUM_REQUIRES_OPERATOR, "MEDIUM-risk promotion requires operator authorization");
    }
    fail(EVOLUTION_PROMOTION_HOLD.NOT_LOW_RISK, `risk class ${candidate.risk_class} cannot promote autonomously`);
  }
  // 3. fitness PASS (decision ACCEPT ⇒ regression PASS + metric IMPROVED).
  if (fitness?.decision !== "ACCEPT" || fitness?.candidate_id !== candidate.candidate_id) {
    fail(EVOLUTION_PROMOTION_HOLD.FITNESS_NOT_PASS, `fitness decision ${fitness?.decision ?? "missing"} for ${candidate.candidate_id}`);
  }
  if (fitness.regression?.verdict !== "PASS") {
    fail(EVOLUTION_PROMOTION_HOLD.REGRESSION_NOT_PASS, `regression verdict ${fitness.regression?.verdict ?? "missing"}`);
  }
  // 4. independent review PASS (durable artifact; independence enforced at bind).
  const review = readEvolutionReview(storeRoot, candidate.candidate_id);
  if (!review || review.review_verdict !== "PASS") {
    fail(EVOLUTION_PROMOTION_HOLD.REVIEW_NOT_PASS, "no durable independent review PASS for candidate");
  }
  if (review.candidate_digest !== candidate.candidate_digest || review.fitness_digest !== fitness.fitness_digest) {
    fail(EVOLUTION_PROMOTION_HOLD.IDENTITY_MISMATCH, "review artifact does not bind this candidate/fitness");
  }
  // 5. candidate identity match (digest re-derivation).
  const recomputedDigest = digestOf({ ...candidate, candidate_digest: undefined });
  if (recomputedDigest !== candidate.candidate_digest) {
    fail(EVOLUTION_PROMOTION_HOLD.IDENTITY_MISMATCH, "candidate digest does not re-derive (tampered or stale candidate)");
  }
  // 6. live HEAD/base match: promotion only from the exact frozen baseline.
  if (liveBaselineHead !== candidate.baseline_head) {
    fail(EVOLUTION_PROMOTION_HOLD.HEAD_MISMATCH, `live HEAD ${liveBaselineHead} != candidate baseline ${candidate.baseline_head}`);
  }
  // 7. semantic drift gate.
  const drift = semanticDriftCheck({ declaredContract, boundDigest: boundContractDigest });
  if (!drift.ok) fail(EVOLUTION_PROMOTION_HOLD.SEMANTIC_DRIFT, drift.reason);

  return {
    authorized: true,
    branch: evolutionBranchFor(candidate.candidate_id),
    gates: {
      policy: true, risk_low: true, fitness_pass: true, regression_pass: true,
      review_pass: true, identity_match: true, head_match: true, semantic_drift_pass: true,
    },
    review_digest: review.review_digest,
  };
}
