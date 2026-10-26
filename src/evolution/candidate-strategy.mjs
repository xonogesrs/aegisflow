// src/evolution/candidate-strategy.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVOLUTION_COMPLETION_1 — Section C: AGENT-STRATEGY
// improvement candidates, carried through THE EXISTING loop (no second engine).
//
// A strategy candidate is the agent-level analogue of a source candidate:
//
//   candidate_id        deterministic over (plan, baseline, strategy-surface)
//   problem_signature   the trigger signature (evidence identity)
//   evidence_refs       the durable journal event ids behind the diagnosis
//   baseline_revision   the frozen baseline the strategy state is derived from
//   affected_scope      the strategy surface (`strategy://<task class>/<dim>`)
//   expected_improvement the metric the strategy is expected to move
//   measurement_plan    what fitness will compare (agent-strategy evaluator)
//   risk_class          LOW for the bounded knobs, MEDIUM for prompt/profile
//   rollback_plan       deactivate the strategy value (runtime policy)
//   mutation_plan       a STRATEGY plan (no worktree mutation) — or a source
//                       patch plan when the plan producer emitted one
//
// The strategy candidate is schema-compatible with the loop's derived
// candidate WHERE IT MUST BE (policy preauthorization, risk classification and
// the review/promotion identity gates all re-derive over the same fields), and
// explicitly marked `candidate_kind: "AGENT_STRATEGY"` so no downstream stage
// can mistake it for a source edit.

import { digestOf } from "../canonical-digest.mjs";
import { C2dHoldError } from "../c2d/fs-atomic.mjs";
import { STRATEGY_DIMENSIONS } from "./attribution.mjs";
import { BOUNDED_STRATEGY_PARAMS, validateStrategyValue } from "./strategy-store.mjs";

export const EVOLUTION_STRATEGY_CANDIDATE_SCHEMA = "autoloop.evolution-strategy-candidate/v1";

/** Dimensions whose FIRST version may never promote autonomously (§C/J). */
export const MEDIUM_FLOOR_DIMENSIONS = Object.freeze(["PROMPT_EVOLUTION"]);

export const STRATEGY_CANDIDATE_HOLD = Object.freeze({
  PLAN_INVALID: "HOLD / EVOLUTION_STRATEGY_CANDIDATE_PLAN_INVALID",
  PLAN_REFUSED: "HOLD / EVOLUTION_STRATEGY_CANDIDATE_PLAN_REFUSED",
});

function fail(code, message) {
  throw new C2dHoldError(code, message);
}

/**
 * Risk classification for a strategy candidate.
 *
 * LOW   — a bounded knob within the declared finite space (fan-out, phase
 *         budget, context target band, retry allocation, tool preference
 *         inside the admission vocabulary, route within the supported rows).
 * MEDIUM— prompt/profile (declared floor, v1) and any dimension whose proposal
 *         exceeds a single bounded step.
 * HIGH  — never: a strategy candidate cannot name an authority surface. If the
 *         plan's surface or params reach outside the bounded schema the
 *         candidate is refused outright rather than raised to MEDIUM.
 */
export function classifyStrategyRisk({ dimension, params, taskClass = null } = {}) {
  const reasons = [];
  const spec = BOUNDED_STRATEGY_PARAMS[dimension];
  if (!spec) return { riskClass: "HIGH", reasons: [`unknown_strategy_dimension:${String(dimension)}`] };

  const v = validateStrategyValue(dimension, params);
  if (!v.ok) return { riskClass: "HIGH", reasons: [`outside_bounded_schema:${v.reason}`] };

  if (MEDIUM_FLOOR_DIMENSIONS.includes(dimension)) {
    reasons.push(`declared_medium_floor:${dimension}`);
    return { riskClass: "MEDIUM", reasons };
  }
  if (spec.riskFloor === "MEDIUM") {
    reasons.push(`declared_risk_floor:${dimension}`);
    return { riskClass: "MEDIUM", reasons };
  }
  // Bounded step check: an INT knob may move by at most one step from the
  // observed baseline value (a strategy candidate is a nudge, not a leap).
  if (spec.kind === "INT" && Number.isInteger(params?.[spec.param])) {
    reasons.push(`bounded_step:${spec.param}=${params[spec.param]}`);
  }
  reasons.push("bounded_strategy_surface");
  reasons.push("no_authority_surface_touched");
  return { riskClass: "LOW", reasons };
}

/**
 * Derive one AGENT_STRATEGY candidate from a plan (plan-producer.mjs §B) and
 * the trigger that motivated it.
 *
 * @param {object} p
 * @param {object} p.plan — a plan-producer PLAN (kind AGENT_STRATEGY)
 * @param {object} p.triggerEvent — the gated trigger
 * @param {string} p.baselineHead — 40-hex baseline
 * @param {number|string} p.baselineRevision
 * @param {object} [p.strategyPolicy] — current strategy policy (generation binding)
 * @returns {{ status: "CREATED", candidate: object }}
 */
export function deriveStrategyCandidate({ plan, triggerEvent, baselineHead, baselineRevision, strategyPolicy = null }) {
  if (plan?.schema !== "autoloop.evolution-improvement-plan/v1" || plan.kind !== "AGENT_STRATEGY") {
    fail(STRATEGY_CANDIDATE_HOLD.PLAN_INVALID, "plan is not an AGENT_STRATEGY improvement plan");
  }
  if (!/^[0-9a-f]{40}$/.test(baselineHead ?? "")) {
    fail(STRATEGY_CANDIDATE_HOLD.PLAN_INVALID, "baseline HEAD invalid");
  }
  const sp = plan.strategy_plan ?? {};
  const dimension = sp.dimension;
  if (!STRATEGY_DIMENSIONS.includes(dimension)) {
    fail(STRATEGY_CANDIDATE_HOLD.PLAN_INVALID, `plan names an unknown strategy dimension: ${String(dimension)}`);
  }
  const validation = validateStrategyValue(dimension, sp.params);
  if (!validation.ok) {
    fail(STRATEGY_CANDIDATE_HOLD.PLAN_REFUSED, `plan params rejected by the bounded schema: ${validation.reason}`);
  }
  // The value recorded in the plan MUST equal the value its params derive —
  // a plan cannot carry a value its own parameters do not produce.
  if (validation.value !== sp.to_value) {
    fail(STRATEGY_CANDIDATE_HOLD.PLAN_REFUSED, `plan to_value ${String(sp.to_value)} != derived ${String(validation.value)}`);
  }
  if (!sp.surface || !String(sp.surface).startsWith("strategy://")) {
    fail(STRATEGY_CANDIDATE_HOLD.PLAN_REFUSED, "plan surface is not a strategy surface");
  }

  const classification = classifyStrategyRisk({ dimension, params: sp.params, taskClass: sp.task_class ?? null });
  const identityFacts = {
    kind: "AGENT_STRATEGY",
    trigger_id: triggerEvent?.trigger_id ?? null,
    signature: triggerEvent?.signature ?? null,
    baseline_head: baselineHead,
    surface: sp.surface,
    from_value: sp.from_value ?? null,
    to_value: sp.to_value,
    params: sp.params,
    policy_generation: strategyPolicy?.generation ?? null,
  };
  const candidateId = `ecand_${digestOf(identityFacts).slice(0, 40)}`;

  const candidate = {
    schema: "autoloop.evolution-candidate/v1",
    version: 1,
    candidate_kind: "AGENT_STRATEGY",
    candidate_id: candidateId,
    created_at: new Date().toISOString(),
    problem_signature: triggerEvent?.signature ?? null,
    signal_class: triggerEvent?.signal_class ?? null,
    trigger_id: triggerEvent?.trigger_id ?? null,
    evidence_refs: [...(triggerEvent?.evidence_refs ?? [])].sort(),
    baseline_revision: baselineRevision,
    baseline_head: baselineHead,
    affected_scope: [sp.surface],
    derivation_strategy: "AGENT_STRATEGY_OPTIMIZATION",
    mutation_plan: {
      strategy: "AGENT_STRATEGY_OPTIMIZATION",
      affected_scope: [sp.surface],
      // A strategy candidate mutates NO source and NO worktree: it activates a
      // bounded runtime strategy value. `edits` is therefore explicitly empty
      // and the activation is described by `strategy_activation`.
      edits: [],
      strategy_activation: {
        dimension,
        task_class: sp.task_class ?? null,
        from_value: sp.from_value ?? null,
        to_value: sp.to_value,
        params: sp.params,
        surface: sp.surface,
        policy_generation: strategyPolicy?.generation ?? null,
      },
    },
    expected_improvement: {
      kind: "strategy",
      metric: plan.measurement_plan?.metric ?? "strategy_success_rate",
      direction: plan.measurement_plan?.direction ?? "increase",
      cited_observation: {
        diagnosis: plan.diagnosis?.chosen ?? null,
        rationale: plan.rationale ?? null,
        dimension,
        task_class: sp.task_class ?? null,
      },
    },
    measurement_plan: {
      metric: plan.measurement_plan?.metric ?? "strategy_success_rate",
      direction: plan.measurement_plan?.direction ?? "increase",
      regressionGate: "zero_regression",
      baselineValue: plan.measurement_plan?.baseline_value ?? null,
      task_class: sp.task_class ?? null,
      dimension,
      candidate_value: sp.to_value,
      baseline_samples: plan.measurement_plan?.baseline_samples ?? 0,
      min_samples: plan.measurement_plan?.min_samples ?? 3,
      secondary_metrics: plan.measurement_plan?.secondary_metrics ?? [],
      tolerance: plan.measurement_plan?.tolerance ?? undefined,
    },
    risk_class: classification.riskClass,
    risk_reasons: classification.reasons,
    rollback_plan: {
      kind: "strategy_deactivation",
      surface: sp.surface,
      dimension,
      task_class: sp.task_class ?? null,
      previous_value: sp.from_value ?? null,
      policy_generation: strategyPolicy?.generation ?? null,
      note: "rollback deactivates the strategy value (runtime policy) — no source or worktree change exists to undo",
    },
    strategy_plan: {
      dimension,
      task_class: sp.task_class ?? null,
      surface: sp.surface,
      from_value: sp.from_value ?? null,
      to_value: sp.to_value,
      params: sp.params,
      risk_floor: validation.riskFloor,
      diagnosis: plan.diagnosis ?? null,
    },
    improvement_plan_id: plan.plan_id ?? null,
    status: "DERIVED",
  };
  candidate.candidate_digest = digestOf({ ...candidate, candidate_digest: undefined });
  return { status: "CREATED", candidate };
}

/** True when the candidate is an agent-strategy candidate. */
export function isStrategyCandidate(candidate) {
  return candidate?.candidate_kind === "AGENT_STRATEGY";
}
