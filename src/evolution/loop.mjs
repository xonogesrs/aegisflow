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
  EVOLUTION_TRIGGER_SCHEMA,
} from "./trigger.mjs";

export const EVOLUTION_LOOP_SCHEMA = "autoloop.evolution-loop/v1";

/** Every terminal `loop_verdict` one cycle can return (closed set) — the
 *  contract the production consumer's outcome log and the operator view read. */
export const EVOLUTION_LOOP_VERDICTS = Object.freeze([
  "HOLD",                        // failed closed at a stage (see hold_code / stage)
  "NO_TRIGGER",                  // no signal crossed its threshold
  "CANDIDATE_EXISTS",            // already derived for this signature@baseline
  "AWAITING_OPERATOR_PROMOTION", // MEDIUM: evaluated autonomously, promotion is the operator boundary
  "ROLLED_BACK",                 // canary regressed; the evolution branch was restored
  "PROMOTED",                    // committed + promoted + canary window open
]);

// PRODUCTION ACTIVATION (Section H): the explicit kill switch. SUSPENDED
// prevents NEW evolution cycles only — NORMAL_OPERATION, telemetry and
// in-flight graph execution are untouched, and no source change is needed
// to flip it (durable marker or env; see kill-switch.mjs).
import { readEvolutionSuspension } from "./kill-switch.mjs";
import { produceImprovementPlan } from "./plan-producer.mjs";
import { deriveStrategyCandidate, classifyStrategyRisk } from "./candidate-strategy.mjs";
import { evaluateStrategyFitness } from "./fitness-strategy.mjs";
import { readStrategyPolicy, activateStrategyValue } from "./strategy-store.mjs";

export const EVOLUTION_LOOP_HOLD = Object.freeze({
  SUSPENDED: "HOLD / EVOLUTION_SUSPENDED",
  POLICY_UNAVAILABLE: "HOLD / EVOLUTION_LOOP_POLICY_UNAVAILABLE",
  TRIGGER_INVALID: "HOLD / EVOLUTION_LOOP_TRIGGER_INVALID",
  TRIGGER_GATED: "HOLD / EVOLUTION_LOOP_TRIGGER_GATED",
  CANDIDATE_UNSUPPORTED: "HOLD / EVOLUTION_LOOP_CANDIDATE_UNSUPPORTED",
  CANDIDATE_INCONCLUSIVE: "HOLD / EVOLUTION_LOOP_CANDIDATE_INCONCLUSIVE",
  MUTATION_FAILED: "HOLD / EVOLUTION_LOOP_MUTATION_FAILED",
  FITNESS_REJECTED: "HOLD / EVOLUTION_LOOP_FITNESS_REJECTED",
  PROMOTION_HELD: "HOLD / EVOLUTION_LOOP_PROMOTION_HELD",
});

function hold(code, reason, extra = {}) {
  return { loop_verdict: "HOLD", stage: extra.stage ?? null, hold_code: code, reason, ...extra };
}

/** Accept either a producer result or a bare plan record. */
function normalizePlanInput(input) {
  if (!input || typeof input !== "object") return null;
  if (input.schema === "autoloop.evolution-improvement-plan/v1") {
    return { status: "PLAN", plan: input, reason: null };
  }
  if (typeof input.status === "string") return input;
  return null;
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
 * @param {string[]} [p.strategyDimensions] — strategy dimensions the plan
 *        producer may consider (default: all declared dimensions)
 * @param {object} [p.strategyBaselineValues] — { <DIMENSION>: <observed value> }
 *        the strategy each task class currently runs under, when the
 *        deployment knows it (the producer's default is most-observed)
 * @param {object} [p.plan] — a plan-producer result (or bare plan record) to
 *        use instead of producing one; the RESULT shape is normalized here
 * @param {object[]} [p.replayArm] — explicit post-activation observations that
 *        replace the memory-derived candidate arm (a controlled replay)
 * @param {object} [p.triggerEvent] — a PRE-GATED, already-durably-recorded
 *        trigger event (production-consumer.mjs). When present the loop skips
 *        trigger derivation/gating/recording (the consumer owns that) and
 *        proceeds from candidate derivation. Absent ⇒ the loop derives its own.
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

  // ── Stage 1: trigger ─────────────────────────────────────────────────────
  // Two entry modes:
  //   (a) PRODUCTION CONSUMER (production-consumer.mjs): the trigger was
  //       already evaluated against the real journal, gated (dedup/cooldown/
  //       window cap/breaker) and DURABLY RECORDED by the consumer. It is
  //       injected here so the loop does NOT re-evaluate and re-gate it —
  //       re-gating would re-apply cooldown against the record the consumer
  //       just wrote and suppress the very trigger it just produced.
  //   (b) direct/test/operator invocation: the loop derives, gates and
  //       records the trigger itself (unchanged behaviour).
  let triggerEvent;
  let state = readTriggerState(p.policyRoot);
  if (p.triggerEvent) {
    if (p.triggerEvent.schema !== EVOLUTION_TRIGGER_SCHEMA) {
      return { ...hold(EVOLUTION_LOOP_HOLD.TRIGGER_INVALID, `injected trigger event is not ${EVOLUTION_TRIGGER_SCHEMA}`, { stage: "trigger" }), trace };
    }
    triggerEvent = p.triggerEvent;
    step("trigger", { trigger_id: triggerEvent.trigger_id, signal_class: triggerEvent.signal_class, source: "production-consumer" });
  } else {
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
    const gated = applyTriggerGates({ fired, state });
    state = gated.state;
    if (gated.allowed.length === 0) {
      writeTriggerState(p.policyRoot, state);
      return { ...hold(EVOLUTION_LOOP_HOLD.TRIGGER_GATED, `all ${gated.suppressed.length} signal(s) suppressed: ${gated.suppressed[0]?.reason ?? "gated"}`, { stage: "trigger" }), trace };
    }
    triggerEvent = buildTriggerEvent({ signal: gated.allowed[0], graphRunId: p.graphRunId ?? null, thresholdPolicyDigest: policy.policy_digest });
    state = recordTrigger(state, triggerEvent);
    writeTriggerState(p.policyRoot, state);
    step("trigger", { trigger_id: triggerEvent.trigger_id, signal_class: triggerEvent.signal_class, suppressed: gated.suppressed.length });
  }

  // ── Stage 2: candidate derivation ────────────────────────────────────────
  // Two candidate families share this loop (§C/§M — never a second engine):
  //   AGENT_STRATEGY — a bounded runtime strategy value (the plan producer's
  //                    §B output); no source mutation, no worktree.
  //   SOURCE         — a bounded source patch (the pre-existing family).
  // A plan produced by the natural plan producer is used when supplied;
  // otherwise the source derivation runs exactly as before.
  // The plan input may be the producer's RESULT ({ status, plan }) or a bare
  // plan record (a caller that already unwrapped it). Both are normalized to
  // the RESULT shape here so neither form can silently miss the strategy path.
  const plan = normalizePlanInput(p.plan) ?? produceImprovementPlan({
    triggerEvent,
    attribution: p.attribution ?? null,
    taskClass: p.taskClass ?? p.attribution?.task_class ?? null,
    storeRoot: p.policyRoot,
    dimensions: p.strategyDimensions,
    baselineValues: p.strategyBaselineValues ?? null,
  });
  step("diagnosis", { plan_status: plan?.status ?? null, plan_kind: plan?.plan?.kind ?? null, dimension: plan?.plan?.dimension ?? null });

  let candidate;
  let isStrategy = false;
  if (plan?.status === "PLAN" && plan.plan.kind === "AGENT_STRATEGY") {
    let derived;
    try {
      derived = deriveStrategyCandidate({
        plan: plan.plan, triggerEvent,
        baselineHead: p.baselineHead, baselineRevision: p.baselineRevision,
        strategyPolicy: readStrategyPolicy(p.policyRoot),
      });
    } catch (e) {
      return { ...hold(EVOLUTION_LOOP_HOLD.CANDIDATE_UNSUPPORTED, String(e?.message ?? e).slice(0, 300), { stage: "candidate" }), plan, trace };
    }
    candidate = derived.candidate;
    isStrategy = true;
  } else if (plan?.status === "PLAN") {
    // A SOURCE_REPAIR plan from the producer (evidence-bound patch).
    const derived = deriveImprovementCandidate({
      triggerEvent: {
        ...triggerEvent,
        observation: {
          ...(triggerEvent.observation ?? {}),
          patchPlan: plan.plan.patch_plan,
          affectedScope: plan.plan.affected_scope,
        },
      },
      baselineHead: p.baselineHead, baselineRevision: p.baselineRevision,
      storeRoot: p.policyRoot, scopeHints: p.scopeHints ?? [], measurement: p.measurement ?? null,
    });
    if (derived.status === "UNSUPPORTED") {
      return { ...hold(EVOLUTION_LOOP_HOLD.CANDIDATE_UNSUPPORTED, derived.reason, { stage: "candidate" }), plan, trace };
    }
    candidate = derived.candidate;
    if (derived.status === "EXISTING") {
      return { loop_verdict: "CANDIDATE_EXISTS", candidate_id: candidate.candidate_id, reason: "already derived for this signature@baseline", plan, trace };
    }
  } else {
    // The producer had no actionable plan: honest, recorded, and NOT a
    // fabricated mutation (§B). The supplied-plan path (p.plan undefined) keeps
    // the pre-existing derivation as the fallback when no store/task class is
    // known to the producer.
    const derived = deriveImprovementCandidate({
      triggerEvent, baselineHead: p.baselineHead, baselineRevision: p.baselineRevision,
      storeRoot: p.policyRoot, scopeHints: p.scopeHints ?? [], measurement: p.measurement ?? null,
    });
    if (derived.status === "UNSUPPORTED") {
      return {
        ...hold(plan?.status === "INCONCLUSIVE" ? EVOLUTION_LOOP_HOLD.CANDIDATE_INCONCLUSIVE : EVOLUTION_LOOP_HOLD.CANDIDATE_UNSUPPORTED,
          `${plan?.status ?? "NO_PLAN"}: ${plan?.reason ?? derived.reason}`, { stage: "candidate", plan_status: plan?.status ?? null }),
        plan, trace,
      };
    }
    candidate = derived.candidate;
    if (derived.status === "EXISTING") {
      return { loop_verdict: "CANDIDATE_EXISTS", candidate_id: candidate.candidate_id, reason: "already derived for this signature@baseline", plan, trace };
    }
  }
  step("candidate", {
    candidate_id: candidate.candidate_id, candidate_kind: candidate.candidate_kind ?? "SOURCE",
    risk_class: candidate.risk_class, dimension: candidate.strategy_plan?.dimension ?? null,
  });

  // ── Stage 3: risk classification + policy preauthorization ──────────────
  // The classification is RE-DERIVED here (never trusted from the candidate
  // alone) — for a strategy candidate from its own bounded schema, for a source
  // candidate from the path-based classifier.
  const classification = isStrategy
    ? classifyStrategyRisk({
      dimension: candidate.strategy_plan.dimension,
      params: candidate.strategy_plan.params,
      taskClass: candidate.strategy_plan.task_class,
    })
    : { riskClass: candidate.risk_class, reasons: candidate.risk_reasons };
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
    // Surface the POLICY's own hold code when it carries one: collapsing every
    // authorization refusal into RISK_CLASS_REFUSED hid the real reason (a
    // scope/authority refusal read as a risk-class refusal), which made the
    // operator unable to tell "this candidate is too risky" from "this policy
    // never preauthorized this surface".
    const code = (e instanceof C2dHoldError && typeof e.code === "string" && e.code.startsWith("HOLD / "))
      ? e.code
      : EVOLUTION_POLICY_HOLD.RISK_CLASS_REFUSED;
    return { ...hold(code, String(e?.message ?? e), { stage: "authorization", risk_class: classification.riskClass }), trace };
  }
  step("authorization", { risk_class: authorization.riskClass, promotionRequiresOperator: authorization.promotionRequiresOperator });

  // ── Stage 4: bounded work ────────────────────────────────────────────────
  // SOURCE candidate   → isolated C3B worktree mutation + validation.
  // AGENT_STRATEGY     → NO mutation exists to perform: the candidate's
  //                      "mutation" is a bounded runtime strategy value, so the
  //                      stage is a no-op that still has to prove its inputs
  //                      (the bounded schema + the strategy generation it was
  //                      derived against). Nothing is applied here; activation
  //                      happens at promotion (stage 7) and only then.
  const executionId = `exec_${digestOf({ candidate: candidate.candidate_id, baseline: p.baselineHead }).slice(0, 32)}`;
  if (isStrategy) {
    const strategyPolicy = readStrategyPolicy(p.policyRoot);
    const expected = candidate.mutation_plan?.strategy_activation?.policy_generation ?? null;
    if (expected !== null && expected !== strategyPolicy.generation) {
      return {
        ...hold(EVOLUTION_LOOP_HOLD.MUTATION_FAILED,
          `strategy generation moved since derivation (${expected} -> ${strategyPolicy.generation})`,
          { stage: "strategy_activation" }),
        trace,
      };
    }
    step("strategy_stage", { dimension: candidate.strategy_plan.dimension, from: candidate.strategy_plan.from_value, to: candidate.strategy_plan.to_value, generation: strategyPolicy.generation });
  }
  let issued = null;
  try {
    if (!isStrategy) issued = issueCandidateMutationAuthorization({
      checkpointRoot: p.checkpointRoot, executionId, fingerprint: p.fingerprint,
      candidate, authorization, expiresAt: policy.expires_at,
    });
  } catch (e) {
    return { ...hold(EVOLUTION_POLICY_HOLD.INVALID, `authorization artifact: ${String(e?.message ?? e)}`, { stage: "authorization" }), trace };
  }
  if (isStrategy) step("strategy_stage", { issuance: "none (a strategy candidate has no source mutation to authorize)" });
  let mutation = null;
  try {
    if (isStrategy) {
      // No source mutation for a strategy candidate — by construction.
      mutation = null;
    } else {
    mutation = await runCandidateMutation({
      repoRoot: p.repoRoot, checkpointRoot: p.checkpointRoot, executionId,
      candidate, authorization: issued.authorization,
      // The issued artifacts MUST travel with the run: without the policy's
      // validation plan the C3B boundary cannot validate the candidate, and
      // without the authority digests the durable candidate capture cannot be
      // bound to the policy authorization that licensed the mutation. The
      // production route therefore failed closed at MUTATION_FAILED /
      // ENVIRONMENT_FAILURE for every candidate until the wiring repair
      // (AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_WIRING_REPAIR_1) forwarded
      // them — the earlier closed-loop evidence had supplied them BY HAND.
      validationPlan: issued.validationPlan,
      policyDigest: authorization.policyDigest,
      mutationAuthorityDigest: issued.mutationAuthorityDigest,
      expiresAt: issued.expiresAt,
      maxRepairAttempts: 1, mutationCommandOverride: p.mutationCommandOverride ?? null,
    });
    }
  } catch (e) {
    return { ...hold(EVOLUTION_LOOP_HOLD.MUTATION_FAILED, String(e?.message ?? e).slice(0, 300), { stage: "mutation" }), trace };
  }
  if (!isStrategy) step("mutation", { outcome_state: mutation.outcome_state, attempts: mutation.attempts?.length ?? 1, repaired: mutation.repaired === true });
  if (!isStrategy && mutation.outcome_state !== "READY_FOR_REVIEW" && mutation.outcome_state !== "CANDIDATE_VERIFIED") {
    const st = recordCandidateOutcome({ state: readTriggerState(p.policyRoot), outcome: "REJECTED", candidateId: candidate.candidate_id, signature: candidate.problem_signature });
    writeTriggerState(p.policyRoot, st.state);
    return {
      ...hold(EVOLUTION_LOOP_HOLD.MUTATION_FAILED, `mutation outcome ${mutation.outcome_state}`, { stage: "mutation", outcome_state: mutation.outcome_state }),
      mutation_attempts: mutation.attempts,
      trace,
    };
  }

  // ── Stage 5: fitness evaluation ─────────────────────────────────────────
  // SOURCE candidate    → baseline-relative source fitness (fitness.mjs).
  // AGENT_STRATEGY      → AGENT-STRATEGY fitness (fitness-strategy.mjs): a
  //                       real BASELINE STRATEGY vs CANDIDATE STRATEGY
  //                       comparison over comparable attributed evidence, with
  //                       explicit evidence-sufficiency gating.
  let fitness;
  if (isStrategy) {
    const dim = candidate.strategy_plan.dimension;
    const tc = candidate.strategy_plan.task_class;
    const fromValue = candidate.strategy_plan.from_value;
    const toValue = candidate.strategy_plan.to_value;
    // A controlled A/B: the candidate's own arm is measured over the memory
    // EXCLUDING the baseline arm; an explicit replay arm (p.replayArm) is used
    // when the caller ran one.
    fitness = evaluateStrategyFitness({
      storeRoot: p.policyRoot, taskClass: tc, dimension: dim,
      baselineValue: fromValue, candidateValue: toValue,
      candidateRows: Array.isArray(p.replayArm) ? p.replayArm : null,
      measurementPlan: candidate.measurement_plan,
      candidateId: candidate.candidate_id,
    });
  } else {
    fitness = evaluateFitness({
      candidate,
      baselineEvidence: { events: p.baselineEvents ?? [] },
      candidateEvidence: { events: p.postEvents ?? [], mutationResult: mutation },
    });
  }
  step("fitness", { verdict: fitness.verdict, decision: fitness.decision, metric: fitness.targetMetric.metric, kind: isStrategy ? "AGENT_STRATEGY" : "SOURCE" });
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
      candidate_kind: isStrategy ? "AGENT_STRATEGY" : "SOURCE",
      candidate_id: candidate.candidate_id,
      risk_class: classification.riskClass,
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
  let commit;
  if (isStrategy) {
    // ── AGENT_STRATEGY promotion: ACTIVATE the bounded strategy value ───────
    // Compare-and-swap on the strategy store generation: the activation only
    // succeeds if the store is still at the generation the candidate was
    // derived against (a newer activation wins; this candidate fails closed).
    const activationSpec = candidate.mutation_plan.strategy_activation;
    try {
      const act = activateStrategyValue({
        storeRoot: p.policyRoot,
        taskClass: activationSpec.task_class,
        dimension: activationSpec.dimension,
        params: activationSpec.params,
        candidateId: candidate.candidate_id,
        expectedGeneration: activationSpec.policy_generation,
        evidenceDigest: candidate.candidate_digest,
      });
      commit = {
        kind: "AGENT_STRATEGY",
        candidate_id: candidate.candidate_id,
        surface: activationSpec.surface,
        dimension: activationSpec.dimension,
        task_class: activationSpec.task_class,
        from_value: activationSpec.from_value,
        to_value: activationSpec.to_value,
        generation: act.generation,
        baseline_head: p.baselineHead,
      };
    } catch (e) {
      const st = recordCandidateOutcome({ state: readTriggerState(p.policyRoot), outcome: "REJECTED", candidateId: candidate.candidate_id, signature: candidate.problem_signature });
      writeTriggerState(p.policyRoot, st.state);
      return { ...hold(EVOLUTION_LOOP_HOLD.PROMOTION_HELD, `strategy activation: ${String(e?.message ?? e).slice(0, 300)}`, { stage: "strategy_activation" }), fitness, review, trace };
    }
    step("strategy_activation", { surface: commit.surface, from: commit.from_value, to: commit.to_value, generation: commit.generation });
  } else {
    // The verified tree: from the C3B candidate capture when present, else the
    // mutation evidence's diff is the tree identity source. The C3B capture is
    // the authority; without it the tree is derived from the evidence diff via
    // the isolated worktree's index — but autonomous promotion REQUIRES the
    // durable capture (tree identity proven).
    const candidateTree = mutation.evidence?.candidate?.candidate_tree ?? null;
    if (!candidateTree) {
      return { ...hold(EVOLUTION_LOOP_HOLD.PROMOTION_HELD, "no durable candidate tree (C3B capture required for autonomous commit)", { stage: "promotion" }), fitness, review, trace };
    }
    try {
      commit = commitCandidateToEvolutionBranch({
        repoRoot: p.repoRoot, candidate, candidateTree,
        baselineHead: p.baselineHead, fitness, mutationEvidence: mutation.evidence,
      });
    } catch (e) {
      return { ...hold(EVOLUTION_LOOP_HOLD.PROMOTION_HELD, `commit: ${String(e?.message ?? e).slice(0, 300)}`, { stage: "commit" }), fitness, review, trace };
    }
    step("commit", { branch: commit.branch, commit_oid: commit.commit_oid });
  }

  // ── Stage 8: canary window + evaluation ─────────────────────────────────
  // The source fitness reports `baseline` as { value, samples, source }; the
  // agent-strategy fitness reports a plain number. Both are the pre-promotion
  // observation the canary compares against.
  const baselineMetric = {
    metric: fitness.targetMetric.metric,
    value: typeof fitness.targetMetric.baseline === "number"
      ? fitness.targetMetric.baseline
      : (fitness.targetMetric.baseline?.value ?? null),
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
          loop_verdict: "ROLLED_BACK",
          candidate_kind: isStrategy ? "AGENT_STRATEGY" : "SOURCE",
          candidate_id: candidate.candidate_id,
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
    candidate_kind: isStrategy ? "AGENT_STRATEGY" : "SOURCE",
    candidate_id: candidate.candidate_id,
    branch: isStrategy ? null : commit.branch,
    commit_oid: isStrategy ? null : commit.commit_oid,
    strategy_activation: isStrategy
      ? { surface: commit.surface, dimension: commit.dimension, task_class: commit.task_class, from_value: commit.from_value, to_value: commit.to_value, generation: commit.generation }
      : null,
    canary: { closes_at: canary.closes_at, verdict: canary.verdict },
    fitness_digest: fitness.fitness_digest,
    review_digest: review?.review_digest ?? null,
    promotion_gates: promotionGate.gates,
    completedAt: new Date().toISOString(),
    trace,
  };
}
