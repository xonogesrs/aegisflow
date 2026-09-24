// src/evolution/loop.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — orchestration: THE
// closed improvement loop over the existing authority machinery.
//
//   NORMAL_OPERATION (runAdmittedGraph — untouched)
//     → telemetry/evidence (durable journal — untouched)
//     → improvement trigger        (trigger.mjs — gated, dedup'd, provenance-bound)
//     → candidate derivation       (candidate.mjs — deterministic, dedup'd)
//     → risk classification        (policy.mjs — LOW/MEDIUM/HIGH)
//     → policy preauthorization    (policy.mjs — durable artifact; LOW only)
//     → isolated mutation          (mutation.mjs → C3B runMutation)
//     → validation                 (C3B runValidationPlan — inherited)
//     → fitness comparison         (fitness.mjs — baseline-relative)
//     → accept/reject              (fitness decision; REJECT discards worktree)
//     → independent review         (promotion.mjs — durable PASS artifact)
//     → autonomous commit          (promotion.mjs — evolution/<id> branch only)
//     → autonomous promotion       (promotion.mjs — LOW risk, all gates)
//     → canary                     (canary.mjs — bounded window)
//     → accept OR rollback         (canary.mjs — automatic, ref-only)
//     → NEW_NORMAL_OPERATION
//
// Fail-closed boundaries (card §M — nothing bypassed):
//   - the loop NEVER touches main/master; integration stays with the human
//     PGMA1/push-gate chain.
//   - MEDIUM candidates stop before promotion (operator boundary).
//   - HIGH candidates never mutate.
//   - the circuit breaker suspends the whole loop without touching
//     NORMAL_OPERATION (evolution failure is never a run failure).
//   - every stage is driven by durable evidence; a stage that cannot prove
//     its inputs HOLDs the candidate, never guesses.

import { C2dHoldError } from "../c2d/fs-atomic.mjs";
import { digestOf } from "../canonical-digest.mjs";
import { readEvolutionPolicy, authorizeUnderPolicy, EVOLUTION_POLICY_HOLD } from "./policy.mjs";
import { deriveImprovementCandidate, readCandidate } from "./candidate.mjs";
import { issueCandidateMutationAuthorization, runCandidateMutation } from "./mutation.mjs";
import { evaluateFitness } from "./fitness.mjs";
import {
  commitCandidateToEvolutionBranch, bindEvolutionReview,
  evaluateAutonomousPromotion, evolutionBranchFor,
} from "./promotion.mjs";
import { openCanaryWindow, evaluateCanary, rollbackCandidate, recordCandidateOutcome, readCanary } from "./canary.mjs";
import {
  readTriggerState, writeTriggerState, applyTriggerGates, recordTrigger,
  buildTriggerEvent, extractTriggerObservations, evaluateSignals,
} from "./trigger.mjs";

export const EVOLUTION_LOOP_SCHEMA = "autoloop.evolution-loop/v1";

// PRODUCTION ACTIVATION (Section H): the explicit kill switch. SUSPENDED
// prevents NEW evolution cycles only — NORMAL_OPERATION, telemetry and
// in-flight graph execution are untouched, and no source change is needed
// to flip it (durable marker or env; see kill-switch.mjs).
import { readEvolutionSuspension } from "./kill-switch.mjs";

export const EVOLUTION_LOOP_HOLD = Object.freeze({
  SUSPENDED: "HOLD / EVOLUTION_SUSPENDED",
  POLICY_UNAVAILABLE: "HOLD / EVOLUTION_LOOP_POLICY_UNAVAILABLE",
  TRIGGER_GATED: "HOLD / EVOLUTION_LOOP_TRIGGER_GATED",
  CANDIDATE_UNSUPPORTED: "HOLD / EVOLUTION_LOOP_CANDIDATE_UNSUPPORTED",
  MUTATION_FAILED: "HOLD / EVOLUTION_LOOP_MUTATION_FAILED",
  FITNESS_REJECTED: "HOLD / EVOLUTION_LOOP_FITNESS_REJECTED",
  PROMOTION_HELD: "HOLD / EVOLUTION_LOOP_PROMOTION_HELD",
});

function hold(code, reason, extra = {}) {
  return { loop_verdict: "HOLD", stage: extra.stage ?? null, hold_code: code, reason, ...extra };
}

/**
 * Run ONE full improvement cycle for a repository at a frozen baseline.
 * Isolated by construction: the production checkout is only READ (fingerprint);
 * every mutation happens inside the C3B worktree; every promotion is a
 * dedicated evolution branch.
 *
 * @param {object} p
 * @param {string} p.repoRoot — production repository (READ-ONLY here)
 * @param {string} p.policyRoot — durable store root (policy + candidates + reviews + canary)
 * @param {string} p.checkpointRoot — C2D checkpoint root for evolution executions
 * @param {string} p.baselineHead — frozen baseline (40-hex)
 * @param {number} p.baselineRevision — durable revision at trigger time
 * @param {object[]} p.baselineEvents — pre-mutation journal events (baseline side)
 * @param {object} p.fingerprint — collectFingerprint(repoRoot) at baseline
 * @param {object} [p.thresholds] — trigger thresholds (policy-raised only)
 * @param {object} [p.latencyBaseline] / [p.tokenBaseline]
 * @param {string[]} [p.scopeHints] — evidence-derived affected paths
 * @param {object} [p.measurement] — measurement plan override
 * @param {object} [p.usage] — { mutationRuns, evolutionsInWindow } budget counters
 * @param {string} [p.reviewerIdentity] — independent reviewer identity for the review bind
 * @param {string} [p.reviewVerdict] / [p.reviewSummary]
 * @param {object} [p.mutationCommandOverride] — explicit bounded mutation command
 * @param {number} [p.canaryWindowMs]
 * @param {object} [p.postEvents] / [p.postMutationResult] — canary evidence
 * @param {object} [p.declaredContract] / [p.boundContractDigest] — semantic drift inputs
 * @param {object} [p.env] — env override for the kill switch (tests); default process.env
 * @param {boolean} [p.storeSuspended] — precomputed suspension (tests); when absent the
 *        durable marker under policyRoot is read
 */
export async function runEvolutionCycle(p) {
  const startedAt = new Date().toISOString();
  const trace = { startedAt, stages: [] };
  const step = (name, data) => trace.stages.push({ stage: name, at: new Date().toISOString(), ...data });

  // ── Stage −1: kill switch (Section H) — before ANY evolution work ────────
  if (String(p.env?.AUTO_EVOLUTION ?? "").toUpperCase() === "SUSPENDED") {
    return { ...hold(EVOLUTION_LOOP_HOLD.SUSPENDED, "AUTO_EVOLUTION=SUSPENDED (env)", { stage: "kill_switch" }), trace };
  }
  const suspension = p.storeSuspended === true || readEvolutionSuspension(p.policyRoot);
  if (suspension) {
    return { ...hold(EVOLUTION_LOOP_HOLD.SUSPENDED, `AUTO_EVOLUTION=SUSPENDED (${suspension.reason ?? "durable marker"})`, { stage: "kill_switch" }), trace };
  }

  // ── Stage 0: policy availability (the loop is OFF without it) ───────────
  let policy;
  try {
    policy = readEvolutionPolicy(p.policyRoot);
  } catch (e) {
    return { ...hold(EVOLUTION_LOOP_HOLD.POLICY_UNAVAILABLE, String(e?.message ?? e), { stage: "policy" }), trace };
  }
  step("policy", { policy_id: policy.policy_id });

  // ── Stage 1: trigger (observe → evaluate → gate) ─────────────────────────
  const observations = extractTriggerObservations({ events: p.baselineEvents ?? [] });
  const fired = evaluateSignals({
    observations,
    thresholds: p.thresholds ?? {},
    latencyBaseline: p.latencyBaseline ?? null,
    tokenBaseline: p.tokenBaseline ?? null,
    qualifiedPatterns: p.qualifiedPatterns ?? null,
  });
  if (fired.length === 0) {
    return { loop_verdict: "NO_TRIGGER", reason: "no signal crossed its threshold", trace };
  }
  let state = readTriggerState(p.policyRoot);
  const gated = applyTriggerGates({ fired, state });
  state = gated.state;
  if (gated.allowed.length === 0) {
    writeTriggerState(p.policyRoot, state);
    return { ...hold(EVOLUTION_LOOP_HOLD.TRIGGER_GATED, `all ${gated.suppressed.length} signal(s) suppressed: ${gated.suppressed[0]?.reason ?? "gated"}`, { stage: "trigger" }), trace };
  }
  const triggerEvent = buildTriggerEvent({ signal: gated.allowed[0], graphRunId: p.graphRunId ?? null, thresholdPolicyDigest: policy.policy_digest });
  state = recordTrigger(state, triggerEvent);
  writeTriggerState(p.policyRoot, state);
  step("trigger", { trigger_id: triggerEvent.trigger_id, signal_class: triggerEvent.signal_class, suppressed: gated.suppressed.length });

  // ── Stage 2: candidate derivation ────────────────────────────────────────
  const derived = deriveImprovementCandidate({
    triggerEvent, baselineHead: p.baselineHead, baselineRevision: p.baselineRevision,
    storeRoot: p.policyRoot, scopeHints: p.scopeHints ?? [], measurement: p.measurement ?? null,
  });
  if (derived.status === "UNSUPPORTED") {
    return { ...hold(EVOLUTION_LOOP_HOLD.CANDIDATE_UNSUPPORTED, derived.reason, { stage: "candidate" }), trace };
  }
  const candidate = derived.candidate;
  step("candidate", { candidate_id: candidate.candidate_id, risk_class: candidate.risk_class, dedup: derived.status === "EXISTING" });
  if (derived.status === "EXISTING") {
    return { loop_verdict: "CANDIDATE_EXISTS", candidate_id: candidate.candidate_id, reason: "already derived for this signature@baseline", trace };
  }

  // ── Stage 3: risk classification + policy preauthorization ──────────────
  const classification = { riskClass: candidate.risk_class, reasons: candidate.risk_reasons };
  let authorization;
  try {
    authorization = authorizeUnderPolicy({
      policy, classification,
      mutationPaths: candidate.affected_scope,
      baselineHead: p.baselineHead,
      usage: p.usage ?? {},
    });
  } catch (e) {
    const st = recordCandidateOutcome({ state: readTriggerState(p.policyRoot), outcome: "REJECTED", candidateId: candidate.candidate_id, signature: candidate.problem_signature });
    writeTriggerState(p.policyRoot, st.state);
    return { ...hold(EVOLUTION_POLICY_HOLD.RISK_CLASS_REFUSED, String(e?.message ?? e), { stage: "authorization", risk_class: classification.riskClass }), trace };
  }
  step("authorization", { risk_class: authorization.riskClass, promotionRequiresOperator: authorization.promotionRequiresOperator });

  // ── Stage 4: isolated mutation + validation (C3B) ────────────────────────
  const executionId = `exec_${digestOf({ candidate: candidate.candidate_id, baseline: p.baselineHead }).slice(0, 32)}`;
  let issued;
  try {
    issued = issueCandidateMutationAuthorization({
      checkpointRoot: p.checkpointRoot, executionId, fingerprint: p.fingerprint,
      candidate, authorization, expiresAt: policy.expires_at,
    });
  } catch (e) {
    return { ...hold(EVOLUTION_POLICY_HOLD.INVALID, `authorization artifact: ${String(e?.message ?? e)}`, { stage: "authorization" }), trace };
  }
  let mutation;
  try {
    mutation = await runCandidateMutation({
      repoRoot: p.repoRoot, checkpointRoot: p.checkpointRoot, executionId,
      candidate, authorization: issued.authorization,
      maxRepairAttempts: 1, mutationCommandOverride: p.mutationCommandOverride ?? null,
    });
  } catch (e) {
    return { ...hold(EVOLUTION_LOOP_HOLD.MUTATION_FAILED, String(e?.message ?? e).slice(0, 300), { stage: "mutation" }), trace };
  }
  step("mutation", { outcome_state: mutation.outcome_state, attempts: mutation.attempts?.length ?? 1, repaired: mutation.repaired === true });
  if (mutation.outcome_state !== "READY_FOR_REVIEW" && mutation.outcome_state !== "CANDIDATE_VERIFIED") {
    const st = recordCandidateOutcome({ state: readTriggerState(p.policyRoot), outcome: "REJECTED", candidateId: candidate.candidate_id, signature: candidate.problem_signature });
    writeTriggerState(p.policyRoot, st.state);
    return {
      ...hold(EVOLUTION_LOOP_HOLD.MUTATION_FAILED, `mutation outcome ${mutation.outcome_state}`, { stage: "mutation", outcome_state: mutation.outcome_state }),
      mutation_attempts: mutation.attempts,
      trace,
    };
  }

  // ── Stage 5: fitness evaluation (baseline-relative) ─────────────────────
  const fitness = evaluateFitness({
    candidate,
    baselineEvidence: { events: p.baselineEvents ?? [] },
    candidateEvidence: { events: p.postEvents ?? [], mutationResult: mutation },
  });
  step("fitness", { verdict: fitness.verdict, decision: fitness.decision, metric: fitness.targetMetric.metric });
  if (fitness.decision !== "ACCEPT") {
    const st = recordCandidateOutcome({ state: readTriggerState(p.policyRoot), outcome: "REJECTED", candidateId: candidate.candidate_id, signature: candidate.problem_signature });
    writeTriggerState(p.policyRoot, st.state);
    return {
      ...hold(EVOLUTION_LOOP_HOLD.FITNESS_REJECTED, `fitness ${fitness.verdict} (${fitness.targetMetric.metric})`, { stage: "fitness" }),
      fitness, trace,
    };
  }

  // ── Stage 6: independent review (durable PASS artifact) ──────────────────
  let review = null;
  if (p.reviewerIdentity) {
    try {
      review = bindEvolutionReview({
        storeRoot: p.policyRoot, candidate, fitness,
        reviewerIdentity: p.reviewerIdentity, verdict: p.reviewVerdict ?? "PASS",
        summary: p.reviewSummary ?? `autonomous evolution review for ${candidate.candidate_id}`,
      });
    } catch (e) {
      return { ...hold(EVOLUTION_LOOP_HOLD.PROMOTION_HELD, `review bind: ${String(e?.message ?? e)}`, { stage: "review" }), fitness, trace };
    }
    step("review", { reviewer: p.reviewerIdentity, verdict: review.review_verdict });
  }

  // ── Stage 7: promotion gate (LOW only) + autonomous commit ──────────────
  if (authorization.promotionRequiresOperator) {
    // MEDIUM: autonomous mutation/evaluation done; promotion is the operator
    // boundary (existing commit-authorization machinery, unchanged).
    return {
      loop_verdict: "AWAITING_OPERATOR_PROMOTION",
      candidate_id: candidate.candidate_id,
      reason: "MEDIUM-risk candidate evaluated autonomously; promotion requires operator authorization",
      fitness, review, trace,
    };
  }
  let promotionGate;
  try {
    promotionGate = evaluateAutonomousPromotion({
      policy, authorization, candidate, fitness, storeRoot: p.policyRoot,
      liveBaselineHead: p.baselineHead,
      declaredContract: p.declaredContract ?? null,
      boundContractDigest: p.boundContractDigest ?? null,
    });
  } catch (e) {
    const st = recordCandidateOutcome({ state: readTriggerState(p.policyRoot), outcome: "REJECTED", candidateId: candidate.candidate_id, signature: candidate.problem_signature });
    writeTriggerState(p.policyRoot, st.state);
    return { ...hold(EVOLUTION_LOOP_HOLD.PROMOTION_HELD, String(e?.message ?? e).slice(0, 300), { stage: "promotion" }), fitness, review, trace };
  }
  if (!p.reviewerIdentity) {
    // No reviewer supplied: autonomous promotion requires the review PASS.
    return { ...hold(EVOLUTION_LOOP_HOLD.PROMOTION_HELD, "autonomous promotion requires an independent review PASS (none bound)", { stage: "review" }), fitness, trace };
  }
  // The verified tree: from the C3B candidate capture when present, else the
  // mutation evidence's diff is the tree identity source. The C3B capture is
  // the authority; without it the tree is derived from the evidence diff via
  // the isolated worktree's index — but autonomous promotion REQUIRES the
  // durable capture (tree identity proven).
  const candidateTree = mutation.evidence?.candidate?.candidate_tree ?? null;
  if (!candidateTree) {
    return { ...hold(EVOLUTION_LOOP_HOLD.PROMOTION_HELD, "no durable candidate tree (C3B capture required for autonomous commit)", { stage: "promotion" }), fitness, review, trace };
  }
  let commit;
  try {
    commit = commitCandidateToEvolutionBranch({
      repoRoot: p.repoRoot, candidate, candidateTree,
      baselineHead: p.baselineHead, fitness, mutationEvidence: mutation.evidence,
    });
  } catch (e) {
    return { ...hold(EVOLUTION_LOOP_HOLD.PROMOTION_HELD, `commit: ${String(e?.message ?? e).slice(0, 300)}`, { stage: "commit" }), fitness, review, trace };
  }
  step("commit", { branch: commit.branch, commit_oid: commit.commit_oid });

  // ── Stage 8: canary window + evaluation ─────────────────────────────────
  const baselineMetric = {
    metric: fitness.targetMetric.metric,
    value: fitness.targetMetric.baseline.value,
  };
  let canary;
  try {
    canary = openCanaryWindow({ storeRoot: p.policyRoot, candidate, promotion: commit, fitness, windowMs: p.canaryWindowMs, baselineMetric });
  } catch (e) {
    return { ...hold(EVOLUTION_LOOP_HOLD.PROMOTION_HELD, `canary open: ${String(e?.message ?? e)}`, { stage: "canary" }), commit, fitness, review, trace };
  }
  step("canary_open", { closes_at: canary.closes_at });
  if (p.postEvents || p.postMutationResult) {
    try {
      canary = evaluateCanary({
        storeRoot: p.policyRoot, candidate,
        postEvents: p.postEvents ?? [], postMutationResult: p.postMutationResult ?? null,
        declaredContract: p.declaredContract ?? null, state,
      });
      step("canary_evaluate", { verdict: canary.verdict, reasons: canary.reasons ?? [] });
      if (canary.verdict === "REGRESSED") {
        const rb = rollbackCandidate({ repoRoot: p.repoRoot, storeRoot: p.policyRoot, candidate });
        step("rollback", { restored_to: rb.restored_to });
        const st = recordCandidateOutcome({ state: readTriggerState(p.policyRoot), outcome: "ROLLED_BACK", candidateId: candidate.candidate_id, signature: candidate.problem_signature });
        writeTriggerState(p.policyRoot, st.state);
        return {
          loop_verdict: "ROLLED_BACK", candidate_id: candidate.candidate_id,
          canary_reasons: canary.reasons, rollback: rb, fitness, review, commit, trace,
        };
      }
    } catch (e) {
      // Canary evaluation failure: the promoted branch stays, the loop records
      // the observability gap. Never blocks NORMAL_OPERATION.
      step("canary_error", { error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  const st = recordCandidateOutcome({ state: readTriggerState(p.policyRoot), outcome: "PROMOTED", candidateId: candidate.candidate_id, signature: candidate.problem_signature });
  writeTriggerState(p.policyRoot, st.state);

  return {
    loop_verdict: "PROMOTED",
    candidate_id: candidate.candidate_id,
    branch: commit.branch,
    commit_oid: commit.commit_oid,
    canary: { closes_at: canary.closes_at, verdict: canary.verdict },
    fitness_digest: fitness.fitness_digest,
    review_digest: review?.review_digest ?? null,
    promotion_gates: promotionGate.gates,
    completedAt: new Date().toISOString(),
    trace,
  };
}
