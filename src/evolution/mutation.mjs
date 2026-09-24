// src/evolution/mutation.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Section E: the mutation
// stage. Composes THE existing C3B machinery (createIsolatedWorktree /
// runMutation / runValidationPlan / runBoundedCommand) — never a second
// mutation engine.
//
// What this module adds on top of C3B:
//   - policy-derived authorization INPUT: for a policy-authorized LOW-risk
//     candidate, the pipeline issues the durable C3B mutation authorization
//     artifact through createMutationAuthorization with authorized_by bound
//     to the POLICY (policy_id + digest), not to a per-attempt operator
//     action. The C3B durable-artifact contract, expiry, baseline binding,
//     scope fencing and validation-plan identity are INHERITED unchanged —
//     this is authority substitution at the issuer, not a bypass.
//   - candidate→authorization binding: card_id = candidate_id, the allowed
//     paths are the candidate's exact affected scope, the validation plan is
//     the policy's plan.
//   - bounded repair: a VALIDATION_FAILED / MUTATION_FAILED outcome may be
//     retried ONCE (default) with a repair patch from the candidate plan —
//     never more (card §E).
//
// The production checkout is NEVER touched: runMutation already creates an
// isolated worktree at the frozen baseline and discards it on failure.

import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createMutationAuthorization } from "../c2d/mutation-authority.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// The apply helper lives in THIS repository (AutoLoop), never in the target
// repo the candidate mutates — the mutation target may be any fixture/repo.
export const EVOLUTION_APPLY_PATCH_SCRIPT = join(HERE, "..", "..", "scripts", "evolution-apply-patch.mjs");
import { collectFingerprint } from "../c2d/fingerprint.mjs";
import { initExecutionDir } from "../c2d/checkpoint-store.mjs";
import { mintExecutionId } from "../c2d/execution-id.mjs";
import { C2dHoldError } from "../c2d/fs-atomic.mjs";
import { EVOLUTION_POLICY_HOLD } from "./policy.mjs";

export const EVOLUTION_MUTATION_SCHEMA = "autoloop.evolution-mutation/v1";

function fail(code, message) {
  throw new C2dHoldError(code, message);
}

/**
 * Issue the durable C3B mutation authorization for ONE candidate under the
 * policy authority. The candidate's risk class must already be authorized
 * (authorizeUnderPolicy); this function only translates the policy decision
 * into the C3B artifact format — every C3B validation still runs at
 * authorizeMutation time inside runMutation.
 *
 * @param {object} p
 * @param {string} p.checkpointRoot — C2D checkpoint root for the evolution execution
 * @param {string} p.executionId — the evolution execution id (exec_…)
 * @param {object} p.fingerprint — collectFingerprint(repoRoot) at the frozen baseline
 * @param {object} p.candidate — derived candidate
 * @param {object} p.authorization — authorizeUnderPolicy result
 * @param {string} p.expiresAt — authorization expiry (ISO)
 */
export function issueCandidateMutationAuthorization({ checkpointRoot, executionId, fingerprint, candidate, authorization, expiresAt }) {
  if (!authorization?.authorized) fail(EVOLUTION_POLICY_HOLD.INVALID, "candidate is not policy-authorized");
  if (authorization.riskClass === "HIGH") fail(EVOLUTION_POLICY_HOLD.RISK_CLASS_REFUSED, "HIGH-risk candidates never mutate");
  const execDir = initExecutionDir(checkpointRoot, executionId);
  const input = {
    execution_id: executionId,
    card_id: candidate.candidate_id,
    card_revision: String(candidate.candidate_digest ?? "1").slice(0, 64) || "1",
    allowed_paths: [...candidate.affected_scope],
    forbidden_paths: ["src/governance/**", "src/admission/**", "src/evolution/**", ".git/**", "docs/governance/**"],
    validation_plan_id: authorization.validationPlanId,
    authorized_by: `evolution-policy:${authorization.policyId}`,
    authorization_ref: `evolution-policy://${authorization.policyId}/${authorization.policyDigest.slice(0, 16)}`,
    expires_at: expiresAt,
  };
  const r = createMutationAuthorization(execDir, input, fingerprint);
  if (r.status !== "AUTHORIZED_CREATED" && r.status !== "AUTHORIZED_EXISTING_IDENTICAL") {
    fail(EVOLUTION_POLICY_HOLD.INVALID, `unexpected authorization status ${r.status}`);
  }
  return {
    execDir,
    authorization: r.authorization,
    validationPlan: authorization.validationPlan ?? null,
    mutationAuthorityDigest: r.authorization.canonical_digest,
    expiresAt,
  };
}

/**
 * Run the candidate's mutation through THE C3B boundary.
 *
 * @param {object} p
 * @param {string} p.repoRoot — production repository (read-only from the mutation's perspective)
 * @param {string} p.checkpointRoot
 * @param {string} p.executionId
 * @param {object} p.candidate
 * @param {object} p.authorization — issueCandidateMutationAuthorization result.authorization
 * @param {number} [p.maxRepairAttempts=1] — bounded repair budget (card §E)
 * @param {object} [p.mutationCommandOverride] — { cmd, args, timeout_ms } when the
 *        candidate's plan is command-shaped; otherwise the edits are applied
 *        by the candidate's patch (applied via a bounded node script inside
 *        the worktree).
 * @returns runMutation's result ({ outcome_state, evidence, … })
 */
export async function runCandidateMutation({
  repoRoot, checkpointRoot, executionId, candidate, authorization,
  validationPlan = null, policyDigest = null, mutationAuthorityDigest = null, expiresAt = null,
  maxRepairAttempts = 1, mutationCommandOverride = null, inputManifest = {},
}) {
  const { runMutation } = await import("../c2d/mutation-run.mjs");
  const attempts = [];
  let lastResult = null;
  // Materialize the candidate patch ONCE into a caller-owned temp file (the
  // bounded command never carries patch content; the helper reads + deletes it).
  let patchFile = null;
  if (!mutationCommandOverride) {
    const patch = candidate.mutation_plan?.edits?.find((e) => e.kind === "patch_apply")?.patch;
    if (!patch) fail(EVOLUTION_POLICY_HOLD.INVALID, "candidate has no patch to apply");
    patchFile = join(tmpdir(), `evolution-patch-${candidate.candidate_id}-${randomBytes(4).toString("hex")}.patch`);
    writeFileSync(patchFile, patch, { mode: 0o600 });
  }
  try {
    for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
      const execId = attempt === 0 ? executionId : mintExecutionId(); // repair = fresh execution identity (exec id format is closed)
      const mutationCommand = mutationCommandOverride ?? {
        cmd: process.execPath,
        args: [EVOLUTION_APPLY_PATCH_SCRIPT, patchFile],
        timeout_ms: 60000,
      };
      try {
        lastResult = await runMutation({
          repoRoot,
          checkpointRoot,
          actorId: `evolution:${candidate.candidate_id.slice(0, 24)}`,
          executionId: execId,
          authorization: undefined, // inline authorization forbidden — durable artifact only
          validationPlanId: authorization.validation_plan_id,
          validationPlan,
          mutationCommand,
          inputManifest: {
            ...inputManifest,
            evolution_candidate: candidate.candidate_id,
            evolution_attempt: attempt,
            // C3B candidate capture lineage: the durable facts this candidate
            // chain is bound to (policy authority + candidate identity + the
            // mutation authorization digest from THIS execDir's artifact).
            reviewed_candidate: true,
            candidate_lineage: {
              authority_record_digest: policyDigest,
              execution_context_digest: candidate.candidate_digest,
              mutation_authority_digest: mutationAuthorityDigest,
              expires_at: expiresAt,
            },
          },
        });
        attempts.push({ attempt, outcome_state: lastResult.outcome_state });
        if (lastResult.outcome_state === "READY_FOR_REVIEW" || lastResult.outcome_state === "CANDIDATE_VERIFIED") {
          return { ...lastResult, attempts, repaired: attempt > 0 };
        }
        // VALIDATION_FAILED / MUTATION_FAILED / SCOPE_VIOLATION: a scope
        // violation is NEVER repaired (the plan itself was wrong) — fail closed.
        if (lastResult.outcome_state === "SCOPE_VIOLATION") {
          return { ...lastResult, attempts, repaired: false, repairRefused: "scope_violation_never_repaired" };
        }
      } catch (e) {
        attempts.push({ attempt, error: String(e?.message ?? e).slice(0, 200) });
        lastResult = { outcome_state: "ENVIRONMENT_FAILURE", error: e };
        // Environment failures are not candidate defects: do not burn the
        // repair budget — surface immediately.
        if (e instanceof C2dHoldError && String(e.code ?? "").includes("ENVIRONMENT_FAILURE")) {
          return { outcome_state: "ENVIRONMENT_FAILURE", attempts, repaired: false, error: e };
        }
      }
    }
    return { ...(lastResult ?? { outcome_state: "MUTATION_FAILED" }), attempts, repaired: false, repairExhausted: true };
  } finally {
    if (patchFile) { try { unlinkSync(patchFile); } catch { /* best-effort */ } }
  }
}
