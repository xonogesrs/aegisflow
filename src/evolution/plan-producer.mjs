// src/evolution/plan-producer.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVOLUTION_COMPLETION_1 — Section B: THE NATURAL PLAN
// PRODUCER.
//
// This is the content gap the previous card left open: production evidence
// could qualify a trigger, but nothing turned qualified evidence into an
// EXECUTABLE bounded plan, so every natural derivation ended UNSUPPORTED. The
// only path that produced a plan was a human (or a test) hand-feeding
// `patchPlan` / `affectedScope` into the observation.
//
//   qualified natural evidence
//     → diagnosis          (deterministic rule table over attributed evidence)
//     → bounded proposal   (a value from a DECLARED finite knob space)
//     → affectedScope      (the strategy surface, or the cited source path)
//     → patchPlan | strategyPlan
//     → measurementPlan
//
// Hard rules (§B, and the card's "不得讓 LLM 猜測"):
//   - DETERMINISTIC. There is no model in this path. Every proposal comes from
//     a declared rule over measured evidence, so the same evidence always
//     produces the same plan and the plan is auditable by inspection.
//   - EVIDENCE-GATED. A rule fires only when its evidence is SUFFICIENT
//     (sample floors). Insufficient evidence ⇒ `INCONCLUSIVE` (evidence is
//     thin) or `NO_CANDIDATE` (evidence is sufficient and shows nothing
//     deficient). Neither is a failure; both are honest and recorded.
//   - NO FABRICATED REPAIR. A source-repair plan is emitted ONLY from a
//     bounded patch the durable evidence itself carries. This module never
//     invents patch text and never guesses a file to edit.
//   - BOUNDED PROPOSAL SPACE. A strategy proposal is always a value from
//     `BOUNDED_STRATEGY_PARAMS` (strategy-store.mjs) — finite, reviewable,
//     and validated before it can ever be activated.

import { digestOf } from "../canonical-digest.mjs";
import { STRATEGY_DIMENSIONS, contextBandOf, CONTEXT_BANDS } from "./attribution.mjs";
import {
  BOUNDED_STRATEGY_PARAMS, validateStrategyValue, allowedCanonicalToolIds,
} from "./strategy-store.mjs";
import { SUPPORTED_ROUTE_VALUES, defaultRoute } from "./strategy-routing.mjs";
import { summarizeStrategyDimension, MIN_SAMPLES_FOR_SUFFICIENCY } from "./strategy-memory.mjs";

export const EVOLUTION_PLAN_SCHEMA = "autoloop.evolution-improvement-plan/v1";

/** Declared diagnosis thresholds (bounded constants, not tuned by anything). */
export const DIAGNOSIS_THRESHOLDS = Object.freeze({
  holdRateDeficient: 0.30,
  repairRateDeficient: 0.40,
  successRateDeficient: 0.60,
  occupancyHighBands: Object.freeze(["BAND_75_90", "BAND_90_100"]),
  maxAttemptExhausted: 3,
  minSamples: MIN_SAMPLES_FOR_SUFFICIENCY,
});

/** Statuses the producer can return. `PLAN` is the only one carrying a plan. */
export const PLAN_STATUSES = Object.freeze(["PLAN", "INCONCLUSIVE", "NO_CANDIDATE"]);

function plan(p) {
  const body = {
    schema: EVOLUTION_PLAN_SCHEMA,
    version: 1,
    plan_id: null,
    produced_at: new Date().toISOString(),
    ...p,
  };
  body.plan_id = `eplan_${digestOf({ ...body, plan_id: undefined, produced_at: undefined }).slice(0, 40)}`;
  return body;
}

function refuse(status, reason, detail = {}) {
  return { status, plan: null, reason, ...detail };
}

/**
 * Diagnose ONE strategy dimension for one task class from the memory.
 * @returns {{ dimension, baseline, deficient: boolean, signals: string[], alternative: object|null }}
 */
export function diagnoseDimension({ storeRoot, taskClass, dimension, memory = null, baselineValue = null }) {
  const t = DIAGNOSIS_THRESHOLDS;
  const dim = summarizeStrategyDimension({ storeRoot, taskClass, dimension, memory });
  const signals = [];

  // The baseline value is what the task class ACTUALLY runs under. A caller
  // that knows the deployment's current strategy passes `baselineValue`; the
  // default is the most-observed value (ties break lexicographically, so the
  // diagnosis is deterministic). Either way it is an OBSERVED value — never
  // an assumed one.
  const baseline = baselineValue !== null
    ? (dim.values.find((v) => v.value === baselineValue) ?? null)
    : (dim.values[0] ?? null);
  if (baselineValue !== null && baseline === null) {
    return { dimension, baseline: null, deficient: false, signals: [`baseline_value_unobserved:${String(baselineValue)}`], evidence_sufficient: false, alternative: null };
  }
  if (!baseline || baseline.samples < t.minSamples) {
    return { dimension, baseline, deficient: false, signals, evidence_sufficient: false, alternative: null };
  }

  if (baseline.hold_rate !== null && baseline.hold_rate >= t.holdRateDeficient) signals.push(`hold_rate:${baseline.hold_rate.toFixed(3)}`);
  if (baseline.repair_rate !== null && baseline.repair_rate >= t.repairRateDeficient) signals.push(`repair_rate:${baseline.repair_rate.toFixed(3)}`);
  if (baseline.success_rate !== null && baseline.success_rate < t.successRateDeficient) signals.push(`success_rate:${baseline.success_rate.toFixed(3)}`);

  let alternative = null;

  // ── dimension-specific rule table ───────────────────────────────────────
  if (dimension === "MODEL_ROUTING") {
    // Route deficiency is only actionable when ANOTHER supported route has
    // SUFFICIENT comparable evidence — otherwise re-routing is a guess.
    const candidates = dim.values.filter((v) => v.value !== baseline.value && SUPPORTED_ROUTE_VALUES.includes(v.value));
    const better = candidates
      .filter((v) => v.evidence_sufficient)
      .sort((a, b) => (b.success_rate - a.success_rate) || (a.hold_rate - b.hold_rate) || String(a.value).localeCompare(String(b.value)))[0];
    const deficientRouting = signals.includes("success_rate")
      || signals.some((s) => s.startsWith("hold_rate"))
      || signals.some((s) => s.startsWith("repair_rate"));
    if (better && deficientRouting && (better.success_rate ?? 0) > (baseline.success_rate ?? 0)) {
      alternative = {
        params: { route: better.value },
        rationale: `route ${better.value} shows success ${(better.success_rate ?? 0).toFixed(3)} vs ${(baseline.success_rate ?? 0).toFixed(3)} with ${better.samples} samples on ${taskClass}`,
        compared_evidence: better,
      };
    } else if (deficientRouting && candidates.length > 0) {
      // The route is deficient, but no supported alternative has BETTER
      // success evidence to justify moving: re-routing would be a guess.
      signals.push("no_route_with_better_success");
    } else if (deficientRouting) {
      signals.push("no_comparable_route_evidence");
    }
  } else if (dimension === "CONTEXT_ALLOCATION") {
    const high = t.occupancyHighBands.includes(baseline.value);
    if (high) {
      const idx = CONTEXT_BANDS.findIndex((b) => b.id === baseline.value);
      const target = CONTEXT_BANDS[Math.max(0, idx - 1)];
      alternative = {
        params: { target_band: target.id },
        rationale: `occupancy sits in ${baseline.value}; target ${target.id} (one band lower, bounded)`,
        compared_evidence: baseline,
      };
    }
  } else if (dimension === "RETRY_REPAIR") {
    const exhausted = baseline.repairs_total >= baseline.samples * t.maxAttemptExhausted;
    if (exhausted || baseline.repair_rate === null || baseline.repair_rate >= t.repairRateDeficient) {
      const n = Number.parseInt(String(baseline.value).replace("max_attempt_", ""), 10);
      if (Number.isInteger(n) && n + 1 <= BOUNDED_STRATEGY_PARAMS.RETRY_REPAIR.max) {
        alternative = {
          params: { max_attempts: n + 1 },
          rationale: `repairs recur (${baseline.repairs_total} repairs over ${baseline.samples} runs); one more bounded attempt`,
          compared_evidence: baseline,
        };
      }
    }
  } else if (dimension === "FANOUT_PARALLELISM") {
    const n = Number.parseInt(String(baseline.value).replace("concurrency_", ""), 10);
    const stressed = signals.some((s) => s.startsWith("hold_rate")) || signals.some((s) => s.startsWith("repair_rate"));
    if (Number.isInteger(n) && n - 1 >= BOUNDED_STRATEGY_PARAMS.FANOUT_PARALLELISM.min) {
      // Only NARROW the width: a bounded reduction is the safe direction for a
      // stressed task class. Widening is never proposed from failure evidence.
      if (stressed) {
        alternative = {
          params: { max_concurrent: n - 1 },
          rationale: `task class stressed (${signals.join(",")}) at concurrency ${n}; narrow by one`,
          compared_evidence: baseline,
        };
      }
    }
  } else if (dimension === "DECOMPOSITION") {
    const n = Number.parseInt(String(baseline.value).replace("max_phases_", ""), 10);
    const contextPressured = baseline.occupancy_avg !== null && t.occupancyHighBands.includes(contextBandOf(baseline.occupancy_avg));
    if (Number.isInteger(n) && n - 1 >= BOUNDED_STRATEGY_PARAMS.DECOMPOSITION.min && (contextPressured || signals.length > 0)) {
      alternative = {
        params: { max_phases: n - 1 },
        rationale: `phase budget ${n} with ${contextPressured ? "high context occupancy" : signals.join(",")}; reduce by one`,
        compared_evidence: baseline,
      };
    }
  } else if (dimension === "TOOL_SELECTION") {
    const better = dim.values
      .filter((v) => v.value !== baseline.value && v.evidence_sufficient)
      .sort((a, b) => (b.success_rate - a.success_rate) || String(a.value).localeCompare(String(b.value)))[0];
    // A digest alone cannot be turned back into a tool set, so the plan carries
    // the tool ids ONLY when the caller supplies the historically better set
    // (evidence-bound). Otherwise this dimension is representable but not
    // derivable from the memory alone — recorded, never guessed.
    if (better) signals.push("tool_selection_alternative_present_but_ids_not_durable");
  } else if (dimension === "PROMPT_EVOLUTION") {
    // Prompts are not readable from durable execution evidence, so the axis is
    // only ever populated by a DEPLOYMENT-DECLARED prompt profile
    // (attribution.prompt_profile). A candidate therefore requires a declared
    // ALTERNATIVE profile with sufficient, better evidence — never a guess
    // about prompt text. The candidate is MEDIUM by construction (§C/J) and
    // can never promote autonomously.
    signals.push("prompt_axis_declared_only");
    const better = dim.values
      .filter((v) => v.value !== baseline.value && v.evidence_sufficient)
      .sort((a, b) => (b.success_rate - a.success_rate) || (a.hold_rate - b.hold_rate) || String(a.value).localeCompare(String(b.value)))[0];
    if (better && (better.success_rate ?? 0) > (baseline.success_rate ?? 0)) {
      alternative = {
        params: { prompt_profile: String(better.value).replace(/^prompt_/, "") },
        rationale: `declared profile ${better.value} shows success ${(better.success_rate ?? 0).toFixed(3)} vs ${(baseline.success_rate ?? 0).toFixed(3)} on ${taskClass}`,
        compared_evidence: better,
      };
    }
  }

  return {
    dimension,
    baseline,
    deficient: signals.length > 0,
    signals,
    evidence_sufficient: true,
    alternative,
  };
}

/**
 * THE plan producer (§B). Consumes qualified evidence + attribution + memory.
 *
 * @param {object} p
 * @param {object} p.triggerEvent — the gated trigger (provenance + counts)
 * @param {object} [p.attribution] — deriveAttribution output (when available)
 * @param {string} [p.taskClass] — task class to diagnose (defaults to attribution's)
 * @param {string} p.storeRoot — evolution store (strategy memory)
 * @param {string[]} [p.dimensions] — dimensions to consider (default: all)
 * @param {object|null} [p.memory] — pre-read memory (tests/one-shot reads)
 * @returns {{ status, plan, reason?, diagnosis? }}
 */
export function produceImprovementPlan({
  triggerEvent = null, attribution = null, taskClass = null, storeRoot = null,
  dimensions = STRATEGY_DIMENSIONS, memory = null, baselineValues = null,
} = {}) {
  // ── 1. Source-repair plan: ONLY from a bounded patch the evidence carries ──
  // The evidence-bound extraction (trigger.mjs) already refused oversized /
  // malformed / traversal-carrying plans, so what arrives here is a bounded,
  // cited patch — never a hand-feed requirement, never an invented one.
  const patchPlan = triggerEvent?.observation?.patchPlan ?? null;
  const affectedScope = Array.isArray(triggerEvent?.observation?.affectedScope) ? triggerEvent.observation.affectedScope : [];
  if (patchPlan?.patch && affectedScope.length > 0) {
    return {
      status: "PLAN",
      plan: plan({
        kind: "SOURCE_REPAIR",
        dimension: null,
        signal_class: triggerEvent?.signal_class ?? null,
        problem_signature: triggerEvent?.signature ?? null,
        evidence_refs: [...(triggerEvent?.evidence_refs ?? [])],
        affected_scope: [...affectedScope].sort(),
        patch_plan: { patch: patchPlan.patch },
        strategy_plan: null,
        rationale: "bounded repair carried by the durable evidence",
        diagnosis: { source: "evidence_bound_patch", declared_risk_markers: triggerEvent?.observation?.declaredRiskMarkers ?? [] },
        measurement_plan: {
          metric: triggerEvent?.signal_class === "LATENCY_REGRESSION" ? "wall_duration_ms" : "failure_or_repair_count",
          direction: "decrease",
          regression_gate: "zero_regression",
          baseline_value: triggerEvent?.count ?? null,
        },
      }),
    };
  }

  // ── 2. Agent-strategy plan: deterministic diagnosis over attributed memory ─
  const tc = taskClass ?? attribution?.task_class ?? null;
  if (!storeRoot || !tc) {
    return refuse("INCONCLUSIVE", "no task class / strategy memory available for an agent-strategy diagnosis", {
      diagnosis: { task_class: tc, reason: "no attributable evidence scope" },
    });
  }

  // `dimensions` may arrive as an explicit null (an unconfigured deployment):
  // default-parameter syntax only applies to `undefined`, so normalize here.
  const considered = (Array.isArray(dimensions) ? dimensions : STRATEGY_DIMENSIONS)
    .filter((d) => STRATEGY_DIMENSIONS.includes(d));
  const diagnoses = considered.map((d) => diagnoseDimension({
    storeRoot, taskClass: tc, dimension: d, memory,
    baselineValue: baselineValues?.[d] ?? null,
  }));

  const withAlternative = diagnoses.filter((d) => d.alternative);
  if (withAlternative.length === 0) {
    const anySufficient = diagnoses.some((d) => d.evidence_sufficient);
    const anyDeficient = diagnoses.some((d) => d.deficient);
    // Distinguish honest thinness from honest absence.
    if (!anySufficient) {
      return refuse("INCONCLUSIVE", `insufficient attributed evidence for ${tc} (below ${DIAGNOSIS_THRESHOLDS.minSamples} samples per strategy value)`, { diagnosis: { task_class: tc, dimensions: diagnoses } });
    }
    return refuse("NO_CANDIDATE", anyDeficient
      ? `evidence sufficient for ${tc} but no bounded alternative can be justified from the declared knob space`
      : `evidence sufficient for ${tc} and no dimension is deficient`, { diagnosis: { task_class: tc, dimensions: diagnoses } });
  }

  // Deterministic selection among the dimensions that produced an alternative:
  // the strongest deficiency signal first (success rate, then hold, then
  // repair), then the declared dimension order.
  const severity = (d) => {
    let s = 0;
    if (d.signals.some((x) => x.startsWith("success_rate"))) s += 4;
    if (d.signals.some((x) => x.startsWith("hold_rate"))) s += 2;
    if (d.signals.some((x) => x.startsWith("repair_rate"))) s += 1;
    return s;
  };
  const chosen = withAlternative
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (severity(b.d) - severity(a.d)) || (a.i - b.i))[0].d;

  const dimension = chosen.dimension;
  const params = chosen.alternative.params;
  const validation = validateStrategyValue(dimension, params);
  if (!validation.ok) {
    return refuse("NO_CANDIDATE", `proposed ${dimension} value rejected by the bounded schema: ${validation.reason}`, { diagnosis: { task_class: tc, dimensions: diagnoses } });
  }

  const baselineValue = chosen.baseline?.value ?? null;
  const surface = `strategy://${tc}/${dimension}`;
  return {
    status: "PLAN",
    plan: plan({
      kind: "AGENT_STRATEGY",
      dimension,
      task_class: tc,
      signal_class: triggerEvent?.signal_class ?? null,
      problem_signature: triggerEvent?.signature ?? null,
      evidence_refs: [...(triggerEvent?.evidence_refs ?? [])],
      affected_scope: [surface],
      patch_plan: null,
      strategy_plan: {
        surface,
        dimension,
        task_class: tc,
        from_value: baselineValue,
        to_value: validation.value,
        params,
        risk_floor: validation.riskFloor,
        rationale: chosen.alternative.rationale,
      },
      rationale: chosen.alternative.rationale,
      diagnosis: { task_class: tc, chosen: { dimension, signals: chosen.signals, baseline: chosen.baseline }, dimensions: diagnoses },
      measurement_plan: {
        metric: "strategy_success_rate",
        direction: "increase",
        regression_gate: "zero_regression",
        baseline_value: baselineValue,
        baseline_samples: chosen.baseline?.samples ?? 0,
        min_samples: DIAGNOSIS_THRESHOLDS.minSamples,
        secondary_metrics: [
          { metric: "hold_rate", direction: "decrease" },
          { metric: "repair_rate", direction: "decrease" },
          { metric: "latency_avg_ms", direction: "decrease" },
          { metric: "occupancy_avg", direction: "decrease" },
        ],
        task_class: tc,
        dimension,
        candidate_value: validation.value,
      },
    }),
  };
}

/** Every value a dimension may be set to (the reviewable knob space). */
export function knobSpaceOf(dimension) {
  const spec = BOUNDED_STRATEGY_PARAMS[dimension];
  if (!spec) return [];
  switch (spec.kind) {
    case "ROUTE": return [...SUPPORTED_ROUTE_VALUES];
    case "INT": return Array.from({ length: spec.max - spec.min + 1 }, (_, i) => spec.min + i);
    case "ENUM": return [...spec.values];
    case "TOOLS": return [allowedCanonicalToolIds()];
    case "NONE": return [];
    default: return [];
  }
}

export { defaultRoute };
