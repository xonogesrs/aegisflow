// src/v2/phase-task-card.mjs
//
// C2 — Phase task-card bridge: maps one IR phase to a standalone AutoLoop
// task card consumable by lifecycle-runner.mjs.
//
// Authority mapping rules (hard gates, structured fields only):
//  - Writer lease eligibility is decided ONLY by data (artifact_mutation /
//    persistent evidence with repo boundary) via runner.mjs
//    requiresWriterLease — never by title/summary/responsibility strings.
//  - allowedPaths for a writer phase come ONLY from effects.boundaries.artifact
//    and must be canonical repository-relative paths within parent authority.
//  - A writer phase without a valid artifact boundary is a fail-closed
//    HOLD (PHASE_MUTATION_BOUNDARY_MISSING) — the bridge never guesses a
//    scope, never expands authority, never repairs.

import { createHash } from "node:crypto";
import { requiresWriterLease } from "./runner.mjs";
import { canonicalRepositoryPath } from "../c2d/mutation-scope.mjs";
import {
  buildExecutorFinalResponseContract,
  buildReviewerFinalResponseContract,
  buildPhaseExecutionPrompt,
} from "./phase-response-contract.mjs";

export const PHASE_CARD_ERRORS = Object.freeze({
  MUTATION_BOUNDARY_MISSING: "PHASE_MUTATION_BOUNDARY_MISSING",
  INVALID_ARTIFACT_PATH: "PHASE_ARTIFACT_PATH_INVALID",
  OUT_OF_PARENT_SCOPE: "PHASE_ARTIFACT_OUT_OF_PARENT_SCOPE",
  IN_FORBIDDEN_PATH: "PHASE_ARTIFACT_IN_FORBIDDEN_PATH",
});

export class PhaseCardError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.name = "PhaseCardError";
  }
}

/** Deterministic per-phase execution id, stable for a given parent run. */
export function phaseExecutionId(parentExecutionId, phaseId) {
  const digest = createHash("sha256").update(`${parentExecutionId}:${phaseId}`).digest("hex");
  return `exec_${digest.slice(0, 32)}`;
}

/**
 * Mechanical subtree expansion of a canonical concrete boundary for the
 * sealed glob-based scope gate (c2d/mutation-scope.mjs matches full file
 * paths against glob patterns). `p` stays the exact canonical boundary;
 * `p + "/**"` only matches paths STRICTLY under it — this never widens
 * authority beyond the boundary's own subtree.
 */
export function deriveScopePatterns(paths) {
  const out = [];
  for (const p of paths || []) {
    if (!out.includes(p)) out.push(p);
    const nested = `${p}/**`;
    if (!out.includes(nested)) out.push(nested);
  }
  return out;
}

function pathWithinScope(childPath, parentPaths) {
  const n = String(childPath).replace(/\/+$/, "");
  return parentPaths.some((p) => {
    const np = String(p).replace(/\/+$/, "");
    return n === np || n.startsWith(np + "/");
  });
}

/**
 * Build the task card for one IR phase.
 *
 * @param {object} opts
 * @param {object} opts.phase — IR phase (purpose/effects/covers/depends_on/verification_plan)
 * @param {object} opts.parent — { scope: { allowed_paths, forbidden_paths } }
 * @param {string} opts.executionId — parent run execution id
 * @param {string} opts.cwd — repository root
 * @param {number} opts.maxRepairAttempts
 * @param {string} [opts.expectedReviewerModel]
 * @param {object} [opts.toolPolicy]
 * @param {string[]} [opts.environmentAllowlist]
 * @returns {object} task card (mutationScope is attached by the caller at
 *   execution time so the baseline snapshot is taken immediately before the
 *   phase runs)
 */
export function buildPhaseTaskCard({
  phase,
  parent,
  executionId,
  cwd,
  maxRepairAttempts,
  expectedReviewerModel = "",
  toolPolicy,
  environmentAllowlist,
}) {
  if (!phase || typeof phase !== "object" || Array.isArray(phase)) {
    throw new PhaseCardError("PHASE_INVALID", "phase must be a non-array object");
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new PhaseCardError("PHASE_CWD_INVALID", "cwd (repository root) required");
  }
  const parentAllowed = Array.isArray(parent?.scope?.allowed_paths) ? parent.scope.allowed_paths : [];
  const parentForbidden = Array.isArray(parent?.scope?.forbidden_paths) ? parent.scope.forbidden_paths : [];

  const effects = (phase.effects && typeof phase.effects === "object" && !Array.isArray(phase.effects))
    ? phase.effects : {};
  const boundaries = (effects.boundaries && typeof effects.boundaries === "object" && !Array.isArray(effects.boundaries))
    ? effects.boundaries : {};

  const isWriter = requiresWriterLease(phase);

  // allowedPaths for a writer come ONLY from effects.boundaries.artifact.
  // Read-only phases declare no mutation authority (empty allowlist => any
  // repo change by a read-only executor is a scope violation).
  const rawArtifactPaths = isWriter && Array.isArray(boundaries.artifact) ? boundaries.artifact : [];

  const allowedPaths = [];
  for (const raw of rawArtifactPaths) {
    if (typeof raw !== "string") {
      throw new PhaseCardError(PHASE_CARD_ERRORS.INVALID_ARTIFACT_PATH, `artifact boundary is not a string: ${String(raw)}`);
    }
    // Additive normalization: strip trailing slashes before canonicalization,
    // matching H5/checkPathArray semantics ("src/auth/" ≡ "src/auth").
    const stripped = raw.replace(/\/+$/, "");
    if (stripped.length === 0) {
      throw new PhaseCardError(PHASE_CARD_ERRORS.INVALID_ARTIFACT_PATH,
        `artifact boundary "${raw}" is not a canonical repository-relative path (no leading /, no .., no wildcards, no empty, no traversal)`);
    }
    const canonical = canonicalRepositoryPath(stripped, cwd);
    if (!canonical) {
      throw new PhaseCardError(PHASE_CARD_ERRORS.INVALID_ARTIFACT_PATH,
        `artifact boundary "${raw}" is not a canonical repository-relative path (no leading /, no .., no wildcards, no empty, no traversal)`);
    }
    if (!pathWithinScope(canonical, parentAllowed)) {
      throw new PhaseCardError(PHASE_CARD_ERRORS.OUT_OF_PARENT_SCOPE,
        `artifact boundary "${canonical}" is outside parent authority (allowed: ${JSON.stringify(parentAllowed)})`);
    }
    for (const fp of parentForbidden) {
      const nfp = fp.replace(/\/+$/, "");
      if (canonical === nfp || canonical.startsWith(nfp + "/")) {
        throw new PhaseCardError(PHASE_CARD_ERRORS.IN_FORBIDDEN_PATH,
          `artifact boundary "${canonical}" intersects parent forbidden_path "${fp}"`);
      }
    }
    if (!allowedPaths.includes(canonical)) allowedPaths.push(canonical);
  }

  if (isWriter && allowedPaths.length === 0) {
    throw new PhaseCardError(PHASE_CARD_ERRORS.MUTATION_BOUNDARY_MISSING,
      `${phase.phase_id}: writer phase (artifact_mutation=${effects.artifact_mutation}) has no valid artifact boundary`);
  }

  const card = {
    executionId: phaseExecutionId(executionId, phase.phase_id),
    parentExecutionId: executionId,
    phaseId: phase.phase_id,
    title: typeof phase.title === "string" ? phase.title : "",
    summary: typeof phase.summary === "string" ? phase.summary : "",
    responsibility: typeof phase.responsibility === "string" ? phase.responsibility : "",
    purpose: phase.purpose,
    effects,
    covers: Array.isArray(phase.covers) ? phase.covers.map((c) => ({ ...c })) : [],
    dependsOn: Array.isArray(phase.depends_on) ? phase.depends_on.slice() : [],
    verificationPlan: phase.verification_plan ?? null,
    // Colima pipeline wiring: the per-phase runtime spec（mode/command/expect/
    // limits/worktreePath/scratchPath）is carried verbatim so the Colima
    // executor adapter can run the phase's real task in an isolated container.
    runtime: phase?.runtime ?? null,
    repositoryRoot: cwd,
    allowedPaths,
    forbiddenPaths: parentForbidden.slice(),
    maxRepairAttempts,
    expectedReviewerModel,
    toolPolicy,
    environmentAllowlist,
  };

  // C4R — the operative phase prompt and the structured final-response
  // contracts are part of the TASK CARD itself, so the sealed Pi RPC
  // adapter（which serializes the whole card into the child message）
  // delivers them to the model without any adapter change.
  const executorContract = buildExecutorFinalResponseContract();
  const reviewerContract = buildReviewerFinalResponseContract({ expectedReviewerModel });
  const baseForPrompt = { ...card };
  card.executor_final_response_contract = executorContract;
  card.reviewer_final_response_contract = reviewerContract;
  card.model_prompt = {
    executor: buildPhaseExecutionPrompt({ phase, taskCard: baseForPrompt, lifecyclePhase: "executor", attempt: 0 }),
    reviewer: buildPhaseExecutionPrompt({ phase, taskCard: baseForPrompt, lifecyclePhase: "reviewer", attempt: 0 }),
  };
  card.prompt_usage =
    "Your role is the top-level \"phase\" field of this message (\"executor\" or \"reviewer\"). " +
    "Read the matching model_prompt.<role> section as your operative instruction. " +
    "The FINAL RESPONSE CONTRACT at the end of it is mandatory.";
  return card;
}
