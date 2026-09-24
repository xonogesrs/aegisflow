// src/evolution/fitness-strategy.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVOLUTION_COMPLETION_1 — Section H: AGENT-STRATEGY
// fitness.
//
// The existing fitness evaluator (fitness.mjs) compares a SOURCE PATCH's
// effect on one metric. It structurally cannot answer "is this agent strategy
// better than the one we run?", because a strategy changes nothing in the
// worktree — it changes how future work is routed, decomposed and budgeted.
//
// This evaluator compares two STRATEGY ARMS over comparable, attributed
// observations:
//
//   BASELINE  = observations of task class T under strategy value Vb
//   CANDIDATE = observations of task class T under strategy value Vc
//
// (An A/B by construction: an observation carries exactly one value per
// dimension, so the two arms are disjoint evidence sets. A caller may also
// supply explicit arms — `baselineRows` / `candidateRows` — which is how a
// CONTROLLED REPLAY after activation is evaluated with this same evaluator.)
//
// ACCEPT requires ALL THREE (§H):
//   1. REGRESSION PASS      — hold rate and repair rate must not worsen beyond
//                             tolerance (correctness of the strategy choice).
//   2. TARGET IMPROVED      — the success rate must improve beyond tolerance.
//   3. EVIDENCE SUFFICIENT  — both arms at/above MIN_SAMPLES_FOR_SUFFICIENCY.
// Anything else is REJECT with the specific verdict recorded (UNCHANGED /
// REGRESSED / INCONCLUSIVE) — never fabricated, never defaulted to accept.

import { digestOf } from "../canonical-digest.mjs";
import { compareMetric } from "./fitness.mjs";
import { MIN_SAMPLES_FOR_SUFFICIENCY, readStrategyMemory } from "./strategy-memory.mjs";
import { STRATEGY_DIMENSIONS } from "./attribution.mjs";

export const EVOLUTION_STRATEGY_FITNESS_SCHEMA = "autoloop.evolution-strategy-fitness/v1";

export const STRATEGY_FITNESS_VERDICTS = Object.freeze(["IMPROVED", "UNCHANGED", "REGRESSED", "INCONCLUSIVE"]);
export const STRATEGY_FITNESS_DECISIONS = Object.freeze(["ACCEPT", "REJECT"]);

/** Non-regression tolerance for the guard metrics (declared, not tuned). */
export const STRATEGY_REGRESSION_TOLERANCE = 0.05;

/** Guard metrics: a strategy that improves success while doubling repairs is
 *  NOT an improvement — these must not worsen. */
export const STRATEGY_GUARD_METRICS = Object.freeze([
  { metric: "hold_rate", direction: "decrease" },
  { metric: "repair_rate", direction: "decrease" },
]);

function side(rows, label) {
  const samples = rows.length;
  const succeeded = rows.filter((r) => r.succeeded === true).length;
  return {
    label,
    samples,
    success_rate: samples > 0 ? succeeded / samples : null,
    hold_rate: samples > 0 ? rows.filter((r) => r.held === true).length / samples : null,
    repair_rate: samples > 0 ? rows.filter((r) => (r.repairs ?? 0) > 0).length / samples : null,
  };
}

/**
 * Evaluate one strategy candidate against its baseline arm.
 *
 * @param {object} p
 * @param {string} p.storeRoot — evolution store (strategy memory)
 * @param {string} p.taskClass
 * @param {string} p.dimension — STRATEGY_DIMENSIONS member
 * @param {string} p.baselineValue — the strategy value currently in force
 * @param {string} p.candidateValue — the proposed value
 * @param {object[]} [p.baselineRows] — explicit baseline arm (controlled replay)
 * @param {object[]} [p.candidateRows] — explicit candidate arm (controlled replay)
 * @param {object|null} [p.memory] — pre-read memory
 * @param {object|null} [p.measurementPlan] — the candidate's measurement plan
 * @returns {object} fitness record (verdict + decision + per-metric comparison)
 */
export function evaluateStrategyFitness({
  storeRoot = null, taskClass, dimension, baselineValue, candidateValue,
  baselineRows = null, candidateRows = null, memory = null, measurementPlan = null,
  candidateId = null,
} = {}) {
  if (!STRATEGY_DIMENSIONS.includes(dimension)) {
    throw new Error(`STRATEGY_FITNESS_INVALID: unknown strategy dimension ${String(dimension)}`);
  }
  const fail = (reason) => ({
    schema: EVOLUTION_STRATEGY_FITNESS_SCHEMA,
    version: 1,
    kind: "AGENT_STRATEGY",
    candidate_id: candidateId,
    task_class: taskClass ?? null,
    dimension,
    evaluated_at: new Date().toISOString(),
    regression: { verdict: "INCONCLUSIVE", reason },
    targetMetric: { metric: "success_rate", baseline: null, candidate: null, verdict: "INCONCLUSIVE" },
    guards: [],
    verdict: "INCONCLUSIVE",
    decision: "REJECT",
    reason,
  });

  const baseRows = Array.isArray(baselineRows) ? baselineRows : strategyArmRows({ storeRoot, taskClass, dimension, value: baselineValue, memory });
  const candRows = Array.isArray(candidateRows) ? candidateRows : strategyArmRows({ storeRoot, taskClass, dimension, value: candidateValue, memory });

  const b = side(baseRows, `baseline:${baselineValue}`);
  const c = side(candRows, `candidate:${candidateValue}`);

  // ── 3. EVIDENCE SUFFICIENCY (checked first: it gates the other two) ───────
  if (b.samples < MIN_SAMPLES_FOR_SUFFICIENCY || c.samples < MIN_SAMPLES_FOR_SUFFICIENCY) {
    return {
      ...fail(`insufficient evidence: baseline ${b.samples}/${MIN_SAMPLES_FOR_SUFFICIENCY}, candidate ${c.samples}/${MIN_SAMPLES_FOR_SUFFICIENCY}`),
      baseline: b, candidate: c,
    };
  }

  // ── 1. REGRESSION GUARD (hold / repair must not worsen) ───────────────────
  const guards = STRATEGY_GUARD_METRICS.map((g) => {
    const cmp = compareMetric({
      baseline: b[g.metric], candidate: c[g.metric],
      direction: g.direction, tolerance: STRATEGY_REGRESSION_TOLERANCE,
    });
    return { ...g, baseline: b[g.metric], candidate: c[g.metric], ...cmp };
  });
  const regressed = guards.filter((g) => g.verdict === "REGRESSED");
  const regression = regressed.length > 0
    ? { verdict: "REGRESSED", reason: regressed.map((g) => `${g.metric}:${g.baseline}->${g.candidate}`).join(";") }
    : { verdict: "PASS", reason: null };

  // ── 2. TARGET METRIC (success rate must improve) ──────────────────────────
  const target = compareMetric({
    baseline: b.success_rate, candidate: c.success_rate,
    direction: "increase", tolerance: measurementPlan?.tolerance ?? STRATEGY_REGRESSION_TOLERANCE,
  });

  const evidence = { sufficient: true, min_samples: MIN_SAMPLES_FOR_SUFFICIENCY, baseline_samples: b.samples, candidate_samples: c.samples };
  let decision;
  if (regression.verdict !== "PASS") decision = "REJECT";
  else if (target.verdict === "IMPROVED") decision = "ACCEPT";
  else decision = "REJECT";

  const record = {
    schema: EVOLUTION_STRATEGY_FITNESS_SCHEMA,
    version: 1,
    kind: "AGENT_STRATEGY",
    candidate_id: candidateId,
    task_class: taskClass ?? null,
    dimension,
    baseline_value: baselineValue ?? null,
    candidate_value: candidateValue ?? null,
    baseline: b,
    candidate: c,
    evidence,
    regression,
    targetMetric: { metric: "success_rate", baseline: b.success_rate, candidate: c.success_rate, ...target },
    guards,
    verdict: regression.verdict !== "PASS" ? "REGRESSED" : target.verdict,
    decision,
    evaluated_at: new Date().toISOString(),
  };
  record.fitness_digest = digestOf({ ...record, fitness_digest: undefined });
  return record;
}

/** The observation rows of ONE strategy arm (task class × dimension × value).
 *  This IS the A/B unit: an observation carries exactly one value per
 *  dimension, so the two arms never share a row. */
export function strategyArmRows({ storeRoot, taskClass, dimension, value, memory = null }) {
  const m = memory ?? readStrategyMemory(storeRoot);
  return (m.observations ?? []).filter((o) => o.task_class === taskClass && o.strategy?.[dimension] === value);
}
