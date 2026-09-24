// src/evolution/strategy-store.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVOLUTION_COMPLETION_1 — Sections C/F/G: the
// bounded AGENT-STRATEGY activation surface.
//
// A promoted strategy candidate becomes ACTIVE here. This is a runtime policy
// store (not a source edit), for one reason that is a hard constraint rather
// than a convenience: the admitted provider_binding and the admission tool
// authority are execution-time AUTHORITY, so agent-strategy adaptation must
// live beside them as a bounded, reversible runtime policy — never as a
// rewrite of admission/governance source.
//
//   strategy-policy.json
//     generation (compare-and-swap basis)
//     active: { <TASK_CLASS>: { <DIMENSION>: { value, params, candidate_id,
//                                            at, evidence_digest } } }
//     history: [ bounded activation/deactivation records ]
//
// Hard rules (§F/§G/J):
//   - BOUNDED KNOBS ONLY: every dimension has a declared parameter schema with
//     hard ranges/enums. A value outside the schema cannot be activated — the
//     parameter space is finite and reviewable by construction.
//   - TOOL_SELECTION stays INSIDE the admission tool vocabulary: the canonical
//     tool ids a strategy may name are exactly the ACTIVE pi-builtin mapping
//     rows. The strategy never adds a tool, and the execution-time selector
//     (`projectToolSelection` / `validateToolSelection`) remains the authority.
//   - MODEL_ROUTING stays INSIDE the supported capability rows
//     (strategy-routing.mjs).
//   - NO GOVERNANCE SEMANTICS: the knob set below touches fan-out, context
//     target band, retry allocation, tool preference, decomposition phase
//     budget and route preference. Nothing here changes admission, budget,
//     review, closeout, promotion or semantic-drift semantics.
//   - REVERSIBLE: deactivation restores the previous value (or absence) and is
//     idempotent — this is what the canary rollback performs.
//   - DETERMINISTIC identity: value/params/digest are pure functions of the
//     plan, so replay yields the same activation.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { C2dHoldError } from "../c2d/fs-atomic.mjs";
import { digestOf } from "../canonical-digest.mjs";
import { CONTEXT_BANDS, STRATEGY_DIMENSIONS } from "./attribution.mjs";
import { TOOL_SELECTION_MAPPING, PI_ADAPTER_KIND } from "../admission/policy-projection.mjs";
import { isSupportedRouteValue, validateRoutingPreference, selectRouteForTaskClass } from "./strategy-routing.mjs";

export const EVOLUTION_STRATEGY_POLICY_SCHEMA = "autoloop.evolution-strategy-policy/v1";

export const STRATEGY_STORE_HOLD = Object.freeze({
  INVALID: "HOLD / EVOLUTION_STRATEGY_INVALID",
  GENERATION_CONFLICT: "HOLD / EVOLUTION_STRATEGY_GENERATION_CONFLICT",
  OUT_OF_BOUNDS: "HOLD / EVOLUTION_STRATEGY_OUT_OF_BOUNDS",
  TOOL_NOT_ALLOWED: "HOLD / EVOLUTION_STRATEGY_TOOL_NOT_ALLOWED",
  ROUTE_NOT_SUPPORTED: "HOLD / EVOLUTION_STRATEGY_ROUTE_NOT_SUPPORTED",
  DIMENSION_UNSUPPORTED: "HOLD / EVOLUTION_STRATEGY_DIMENSION_UNSUPPORTED",
});

export const MAX_STRATEGY_HISTORY = 128;

/** The canonical tool ids an agent-strategy candidate may name: exactly the
 *  ACTIVE pi-builtin mapping rows (never `bash`, which V1 leaves unmapped). */
export function allowedCanonicalToolIds() {
  return [...new Set(
    TOOL_SELECTION_MAPPING
      .filter((r) => r.status === "ACTIVE" && r.adapterKind === PI_ADAPTER_KIND)
      .map((r) => r.canonicalToolId),
  )].sort();
}

export function toolSelectionValueOf(canonicalToolIds) {
  return digestOf([...canonicalToolIds].sort()).slice(0, 24);
}

/**
 * THE bounded parameter schema per strategy dimension (§F/§G). `kind` decides
 * validation; every dimension declares its own finite space.
 */
export const BOUNDED_STRATEGY_PARAMS = Object.freeze({
  MODEL_ROUTING: Object.freeze({ kind: "ROUTE", riskFloor: "LOW", knob: "route preference within the supported capability rows" }),
  DECOMPOSITION: Object.freeze({ kind: "INT", param: "max_phases", min: 1, max: 16, riskFloor: "LOW", knob: "declared phase budget" }),
  CONTEXT_ALLOCATION: Object.freeze({ kind: "ENUM", param: "target_band", values: Object.freeze(CONTEXT_BANDS.map((b) => b.id)), riskFloor: "LOW", knob: "target context occupancy band" }),
  RETRY_REPAIR: Object.freeze({ kind: "INT", param: "max_attempts", min: 0, max: 5, riskFloor: "LOW", knob: "bounded repair attempts" }),
  FANOUT_PARALLELISM: Object.freeze({ kind: "INT", param: "max_concurrent", min: 1, max: 8, riskFloor: "LOW", knob: "maximum concurrent phases" }),
  TOOL_SELECTION: Object.freeze({ kind: "TOOLS", riskFloor: "LOW", knob: "preferred tool selection inside the admission vocabulary" }),
  // §C: prompt/profile mutation is MEDIUM in v1 — representable and
  // evaluable, never autonomously promotable.
  PROMPT_EVOLUTION: Object.freeze({ kind: "NONE", riskFloor: "MEDIUM", knob: "prompt/profile revision (operator promotion boundary in v1)" }),
});

/** Derive the canonical, comparable VALUE for (dimension, params). */
export function strategyValueOf(dimension, params) {
  switch (dimension) {
    case "MODEL_ROUTING": return typeof params?.route === "string" ? params.route : null;
    case "DECOMPOSITION": return Number.isInteger(params?.max_phases) ? `max_phases_${params.max_phases}` : null;
    case "CONTEXT_ALLOCATION": return typeof params?.target_band === "string" ? params.target_band : null;
    case "RETRY_REPAIR": return Number.isInteger(params?.max_attempts) ? `max_attempt_${params.max_attempts}` : null;
    case "FANOUT_PARALLELISM": return Number.isInteger(params?.max_concurrent) ? `concurrency_${params.max_concurrent}` : null;
    case "TOOL_SELECTION": return Array.isArray(params?.canonical_tool_ids) ? toolSelectionValueOf(params.canonical_tool_ids) : null;
    case "PROMPT_EVOLUTION": return typeof params?.prompt_profile === "string" ? `prompt_${params.prompt_profile}` : null;
    default: return null;
  }
}

/**
 * Validate ONE (dimension, params) pair against the bounded schema.
 * @returns {{ ok: boolean, value: string|null, reason: string|null, riskFloor: string }}
 */
export function validateStrategyValue(dimension, params) {
  const spec = BOUNDED_STRATEGY_PARAMS[dimension];
  if (!spec) return { ok: false, value: null, reason: `unknown strategy dimension: ${String(dimension)}`, riskFloor: "HIGH" };
  const riskFloor = spec.riskFloor ?? "MEDIUM";
  const bad = (reason) => ({ ok: false, value: null, reason, riskFloor });
  const value = strategyValueOf(dimension, params);
  if (value === null) return bad(`params do not produce a value for ${dimension}`);

  if (spec.kind === "ROUTE") {
    const v = validateRoutingPreference(params.route);
    if (!v.ok) return bad(`route refused: ${v.reason}`);
    if (!isSupportedRouteValue(params.route)) return bad(`route not a supported capability row: ${params.route}`);
    return { ok: true, value, reason: null, riskFloor };
  }
  if (spec.kind === "INT") {
    const n = params[spec.param];
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
      return bad(`${spec.param}=${String(n)} outside bounded range [${spec.min}..${spec.max}]`);
    }
    return { ok: true, value, reason: null, riskFloor };
  }
  if (spec.kind === "ENUM") {
    if (!spec.values.includes(params[spec.param])) {
      return bad(`${spec.param}=${String(params[spec.param])} outside ${spec.values.join("|")}`);
    }
    return { ok: true, value, reason: null, riskFloor };
  }
  if (spec.kind === "TOOLS") {
    const ids = params.canonical_tool_ids;
    if (!Array.isArray(ids) || ids.length === 0) return bad("canonical_tool_ids must be a non-empty array");
    const allowed = new Set(allowedCanonicalToolIds());
    const outside = ids.filter((id) => !allowed.has(id));
    if (outside.length > 0) return bad(`tool(s) outside the admission vocabulary: ${outside.join(",")}`);
    const canon = [...new Set(ids)].sort();
    if (JSON.stringify(canon) !== JSON.stringify(ids)) return bad("canonical_tool_ids must be sorted and unique");
    return { ok: true, value, reason: null, riskFloor };
  }
  if (spec.kind === "NONE") {
    // Representable but not autonomously actionable in v1 (§C/J): a
    // PROMPT_EVOLUTION value is MEDIUM and must never be activated by an
    // autonomous promotion. `validateStrategyValue` reports it as valid so the
    // candidate can exist and be evaluated; the RISK FLOOR is what stops it.
    const profile = params?.prompt_profile;
    if (typeof profile !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(profile)) return bad("prompt_profile must be a bounded token");
    return { ok: true, value, reason: null, riskFloor };
  }
  return bad(`unsupported parameter kind: ${spec.kind}`);
}

// ── Durable strategy policy ────────────────────────────────────────────────

export function strategyPolicyPath(storeRoot) {
  return join(storeRoot, "strategy-policy.json");
}

function emptyPolicy() {
  return { schema: EVOLUTION_STRATEGY_POLICY_SCHEMA, version: 1, generation: 0, active: {}, history: [], updated_at: null };
}

/** Fail-open read (absent/corrupt ⇒ empty = no strategy adaptation active). */
export function readStrategyPolicy(storeRoot) {
  const p = strategyPolicyPath(storeRoot);
  if (!existsSync(p)) return emptyPolicy();
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    if (s?.schema !== EVOLUTION_STRATEGY_POLICY_SCHEMA || typeof s.active !== "object" || s.active === null) return emptyPolicy();
    if (!Number.isInteger(s.generation) || s.generation < 0) return emptyPolicy();
    return s;
  } catch { return emptyPolicy(); }
}

function writeStrategyPolicy(storeRoot, policy) {
  const p = strategyPolicyPath(storeRoot);
  mkdirSync(storeRoot, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  const next = { ...policy, updated_at: new Date().toISOString() };
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    renameSync(tmp, p);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  return next;
}

/**
 * ACTIVATE one strategy value for (task class, dimension).
 *
 * Compare-and-swap on the store generation: a stale caller (one that derived
 * against an older strategy state) fails closed rather than clobbering a
 * newer activation.
 *
 * @param {object} p
 * @param {string} p.storeRoot
 * @param {string} p.taskClass
 * @param {string} p.dimension
 * @param {object} p.params
 * @param {string} p.candidateId
 * @param {number} p.expectedGeneration — the generation the caller derived against
 * @returns {{ policy: object, activation: object, generation: number, previous: object|null }}
 */
export function activateStrategyValue({ storeRoot, taskClass, dimension, params, candidateId, expectedGeneration = null, evidenceDigest = null }) {
  if (!STRATEGY_DIMENSIONS.includes(dimension)) {
    throw new C2dHoldError(STRATEGY_STORE_HOLD.DIMENSION_UNSUPPORTED, `unknown strategy dimension: ${String(dimension)}`);
  }
  const v = validateStrategyValue(dimension, params);
  if (!v.ok) {
    const code = dimension === "MODEL_ROUTING" ? STRATEGY_STORE_HOLD.ROUTE_NOT_SUPPORTED
      : dimension === "TOOL_SELECTION" ? STRATEGY_STORE_HOLD.TOOL_NOT_ALLOWED
        : STRATEGY_STORE_HOLD.OUT_OF_BOUNDS;
    throw new C2dHoldError(code, `refused activation of ${dimension}: ${v.reason}`);
  }
  const policy = readStrategyPolicy(storeRoot);
  if (expectedGeneration !== null && policy.generation !== expectedGeneration) {
    throw new C2dHoldError(
      STRATEGY_STORE_HOLD.GENERATION_CONFLICT,
      `strategy policy generation ${policy.generation} != expected ${expectedGeneration}`,
    );
  }
  const scoped = policy.active[taskClass] ?? {};
  const previous = scoped[dimension] ?? null;
  const activation = {
    dimension,
    value: v.value,
    params,
    candidate_id: candidateId ?? null,
    risk_floor: v.riskFloor,
    evidence_digest: evidenceDigest,
    generation: policy.generation + 1,
    at: new Date().toISOString(),
  };
  const next = {
    ...policy,
    generation: policy.generation + 1,
    active: { ...policy.active, [taskClass]: { ...scoped, [dimension]: activation } },
    history: [...policy.history, { kind: "ACTIVATE", task_class: taskClass, ...activation }].slice(-MAX_STRATEGY_HISTORY),
  };
  const written = writeStrategyPolicy(storeRoot, next);
  return { policy: written, activation, generation: written.generation, previous };
}

/**
 * DEACTIVATE one strategy value (the canary ROLLBACK action; § reversible).
 * Restores the previous value when the activation recorded one — idempotent.
 */
export function deactivateStrategyValue({ storeRoot, taskClass, dimension, expectedGeneration = null }) {
  const policy = readStrategyPolicy(storeRoot);
  if (expectedGeneration !== null && policy.generation !== expectedGeneration) {
    throw new C2dHoldError(
      STRATEGY_STORE_HOLD.GENERATION_CONFLICT,
      `strategy policy generation ${policy.generation} != expected ${expectedGeneration}`,
    );
  }
  const scoped = policy.active[taskClass] ?? {};
  const current = scoped[dimension] ?? null;
  if (!current) return { policy, deactivated: false, reason: "no active strategy for this (task class, dimension)" };
  const rest = { ...scoped };
  delete rest[dimension];
  const next = {
    ...policy,
    generation: policy.generation + 1,
    active: { ...policy.active, [taskClass]: rest },
    history: [...policy.history, {
      kind: "DEACTIVATE", task_class: taskClass, dimension,
      value: current.value, candidate_id: current.candidate_id, at: new Date().toISOString(),
      generation: policy.generation + 1,
    }].slice(-MAX_STRATEGY_HISTORY),
  };
  const written = writeStrategyPolicy(storeRoot, next);
  return { policy: written, deactivated: true, previous: current, generation: written.generation };
}

/** The ACTIVE strategy value for (task class, dimension), or null. */
export function resolveStrategyPreference({ storeRoot, taskClass, dimension }) {
  const policy = readStrategyPolicy(storeRoot);
  const a = policy.active?.[taskClass]?.[dimension] ?? null;
  return a ? { value: a.value, params: a.params, candidate_id: a.candidate_id, generation: a.generation, at: a.at } : null;
}

/** The ACTIVE model-routing preference for a task class (§E). */
export function resolveRoutePreference({ storeRoot, taskClass }) {
  return resolveStrategyPreference({ storeRoot, taskClass, dimension: "MODEL_ROUTING" });
}

/**
 * §E/§I: resolve the route for ONE task class at ADMISSION-CONSTRUCTION time.
 *
 * This is the seam a deployment calls when it builds an admission and left the
 * provider binding open. An authority-supplied binding still wins — the seam
 * can only choose within the supported capability rows.
 */
export function resolveProductionRoute({ storeRoot, taskClass = null, explicitBinding = null, allowlist = null }) {
  const pref = resolveRoutePreference({ storeRoot, taskClass: taskClass ?? "UNCLASSIFIED" });
  return selectRouteForTaskClass({
    strategyPreference: pref?.value ?? null,
    explicitBinding,
    allowlist,
  });
}

/** Read-only operator view. */
export function strategyPolicyView(storeRoot) {
  const p = readStrategyPolicy(storeRoot);
  return {
    schema: EVOLUTION_STRATEGY_POLICY_SCHEMA,
    generation: p.generation,
    updated_at: p.updated_at,
    task_classes: Object.keys(p.active).sort(),
    active: p.active,
    history: p.history.slice(-16),
    allowed_canonical_tool_ids: allowedCanonicalToolIds(),
  };
}
