// src/evolution/fitness.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Section F: baseline-
// relative fitness evaluation. THE missing seam between "tests pass" and
// "this is an improvement".
//
// Contract (card §F):
//   BASELINE vs CANDIDATE comparison over:
//     - correctness/regression  (validation results: candidate must not regress)
//     - the original trigger metric (failure/repair count, latency, tokens)
//   candidate is promotable ONLY when:
//     REGRESSION = PASS  AND  TARGET_METRIC = IMPROVED
//   UNCHANGED / REGRESSED / INCONCLUSIVE ⇒ REJECT.
//
// Honest measurement semantics (mirrors telemetry aggregate): when a metric
// cannot be measured for one side, the comparison is INCONCLUSIVE — never
// fabricated, never defaulted to improvement. A candidate that only "passes
// tests" with no measurable metric delta is UNCHANGED ⇒ REJECT.
//
// Deterministic: identical evidence ⇒ identical verdict.

import { C2dHoldError } from "../c2d/fs-atomic.mjs";
import { digestOf } from "../canonical-digest.mjs";

export const EVOLUTION_FITNESS_SCHEMA = "autoloop.evolution-fitness/v1";

export const FITNESS_VERDICTS = Object.freeze(["IMPROVED", "UNCHANGED", "REGRESSED", "INCONCLUSIVE"]);
export const FITNESS_DECISIONS = Object.freeze(["ACCEPT", "REJECT"]);

export const FITNESS_HOLD = Object.freeze({
  EVIDENCE_INVALID: "HOLD / EVOLUTION_FITNESS_EVIDENCE_INVALID",
  MEASUREMENT_PLAN_MISSING: "HOLD / EVOLUTION_FITNESS_MEASUREMENT_PLAN_MISSING",
});

function fail(code, message) {
  throw new C2dHoldError(code, message);
}

/**
 * Compare one numeric metric between baseline and candidate observations.
 * Returns { verdict, delta, ratio } — INCONCLUSIVE when either side lacks a
 * finite measurement.
 *
 * direction: "decrease" (lower is better) | "increase" (higher is better)
 * tolerance: relative epsilon below which the delta counts as UNCHANGED.
 */
export function compareMetric({ baseline, candidate, direction = "decrease", tolerance = 0.02 }) {
  const b = Number(baseline);
  const c = Number(candidate);
  if (baseline === null || baseline === undefined || candidate === null || candidate === undefined
      || !Number.isFinite(b) || !Number.isFinite(c)) {
    return { verdict: "INCONCLUSIVE", delta: null, ratio: null };
  }
  if (b === 0 && c === 0) return { verdict: "UNCHANGED", delta: 0, ratio: 1 };
  const delta = c - b;
  const ratio = b === 0 ? (c > 0 ? Infinity : 1) : c / b;
  const relDelta = b === 0 ? (delta === 0 ? 0 : Math.sign(delta) * Infinity) : Math.abs(delta) / Math.abs(b);
  if (relDelta <= tolerance) return { verdict: "UNCHANGED", delta, ratio };
  if (direction === "decrease") return { verdict: delta < 0 ? "IMPROVED" : "REGRESSED", delta, ratio };
  return { verdict: delta > 0 ? "IMPROVED" : "REGRESSED", delta, ratio };
}

/**
 * Extract the validation (regression) outcome from a C3B mutation result.
 * REGRESSION = PASS requires: the mutation reached READY_FOR_REVIEW /
 * CANDIDATE_VERIFIED AND every required validation command exited 0.
 */
export function regressionVerdict(mutationResult) {
  if (!mutationResult || typeof mutationResult !== "object") return { verdict: "INCONCLUSIVE", reason: "no mutation result" };
  const ok = mutationResult.outcome_state === "READY_FOR_REVIEW" || mutationResult.outcome_state === "CANDIDATE_VERIFIED";
  if (!ok) {
    return { verdict: "REGRESSED", reason: `mutation outcome ${mutationResult.outcome_state}` };
  }
  const results = mutationResult.evidence?.validation_results ?? [];
  const failedRequired = results.filter((r) => r.required !== false && r.exit_code !== 0);
  if (failedRequired.length > 0) {
    return { verdict: "REGRESSED", reason: `${failedRequired.length} required validation command(s) failed` };
  }
  if (results.length === 0) {
    return { verdict: "INCONCLUSIVE", reason: "no validation results recorded" };
  }
  return { verdict: "PASS", reason: null };
}

/**
 * Extract the trigger-metric observation for one side from its evidence.
 * The metric kind comes from the candidate's measurement plan.
 *
 * Supported metrics (v1):
 *   failure_or_repair_count — count of RUN_HELD/repair events in the side's window
 *   wall_duration_ms        — mean provider-occupancy proxy or reported duration
 *   provider_occupancy      — mean provider-reported occupancy
 */
export function metricObservation({ measurementPlan, events = [], mutationResult = null }) {
  const metric = measurementPlan?.metric ?? "failure_or_repair_count";
  if (metric === "failure_or_repair_count") {
    const failures = events.filter((e) => e.event_type === "RUN_HELD").length;
    const repairs = events.filter((e) => e.event_type === "PHASE_REPAIR_REQUESTED").length;
    return { value: failures + repairs, samples: failures + repairs, source: "journal" };
  }
  if (metric === "provider_occupancy" || metric === "wall_duration_ms") {
    // Post-mutation side: the validation runs' own wall time is the honest
    // in-worktree measurement; pre/post journal events are used when present.
    const usages = events
      .filter((e) => e.event_type === "PROVIDER_USAGE_OBSERVED")
      .map((e) => e.payload?.occupancy)
      .filter((v) => typeof v === "number" && Number.isFinite(v));
    if (mutationResult && metric === "wall_duration_ms") {
      const totalMs = (mutationResult.evidence?.validation_results ?? [])
        .reduce((a, r) => a + (typeof r.duration_ms === "number" ? r.duration_ms : 0), 0);
      if (totalMs > 0) return { value: totalMs, samples: (mutationResult.evidence?.validation_results ?? []).length, source: "validation" };
    }
    if (usages.length > 0) {
      return { value: usages.reduce((a, v) => a + v, 0) / usages.length, samples: usages.length, source: "journal" };
    }
    return { value: null, samples: 0, source: "journal" };
  }
  return { value: null, samples: 0, source: "unknown_metric" };
}

/**
 * THE fitness verdict (card §F). Pure over the evidence.
 *
 * @param {object} p
 * @param {object} p.candidate — derived candidate (measurement_plan required)
 * @param {object} p.baselineEvidence — { events, mutationResult? } pre-mutation side
 * @param {object} p.candidateEvidence — { events, mutationResult } post-mutation side
 * @returns {{ schema, candidate_id, regression, targetMetric, verdict, decision,
 *             comparison, fitness_digest, evaluated_at }}
 */
export function evaluateFitness({ candidate, baselineEvidence, candidateEvidence }) {
  if (!candidate?.measurement_plan) fail(FITNESS_HOLD.MEASUREMENT_PLAN_MISSING, "candidate has no measurement plan");
  if (!candidateEvidence?.mutationResult) fail(FITNESS_HOLD.EVIDENCE_INVALID, "candidate evidence missing (mutation result required)");

  // 1. Regression gate — mandatory PASS.
  const regression = regressionVerdict(candidateEvidence.mutationResult);

  // 2. Target metric comparison — baseline vs candidate.
  const plan = candidate.measurement_plan;
  const base = metricObservation({ measurementPlan: plan, events: baselineEvidence?.events ?? [], mutationResult: baselineEvidence?.mutationResult ?? null });
  const cand = metricObservation({ measurementPlan: plan, events: candidateEvidence?.events ?? [], mutationResult: candidateEvidence.mutationResult });
  const comparison = compareMetric({
    baseline: base.value,
    candidate: cand.value,
    direction: plan.direction ?? "decrease",
    tolerance: plan.tolerance ?? 0.02,
  });

  // 3. Decision: REGRESSION=PASS AND TARGET_METRIC=IMPROVED ⇒ ACCEPT.
  let decision;
  if (regression.verdict !== "PASS") {
    decision = "REJECT";
  } else if (comparison.verdict === "IMPROVED") {
    decision = "ACCEPT";
  } else {
    // UNCHANGED / REGRESSED / INCONCLUSIVE — all REJECT (card §F).
    decision = "REJECT";
  }
  const targetMetric = {
    metric: plan.metric,
    baseline: { value: base.value, samples: base.samples, source: base.source },
    candidate: { value: cand.value, samples: cand.samples, source: cand.source },
    ...comparison,
  };
  const record = {
    schema: EVOLUTION_FITNESS_SCHEMA,
    version: 1,
    candidate_id: candidate.candidate_id,
    regression: { verdict: regression.verdict, reason: regression.reason },
    targetMetric,
    verdict: comparison.verdict,
    decision,
    evaluated_at: new Date().toISOString(),
  };
  record.fitness_digest = digestOf({ ...record, fitness_digest: undefined });
  return record;
}
