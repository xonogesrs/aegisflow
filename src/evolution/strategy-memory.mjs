// src/evolution/strategy-memory.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVOLUTION_COMPLETION_1 — Section D: bounded,
// provenance-bound strategy PERFORMANCE MEMORY.
//
//   task class × strategy dimension × strategy value → observations
//
// Each observation is one attributed execution (attribution.mjs), keyed by a
// deterministic identity so a replayed/duplicated observation can never
// double-count. The memory answers exactly the questions a strategy
// candidate needs to be falsifiable:
//
//   success rate · HOLD rate · repair rate · latency · token/context
//   consumption · sample count · evidence sufficiency
//
// Hard rules:
//   - NO LEARNING FROM A SINGLE EXECUTION: `MIN_SAMPLES_FOR_SUFFICIENCY` is 3
//     and every summary reports `evidence_sufficient` per value; the candidate
//     derivation refuses a comparison whose either side is insufficient.
//   - BOUNDED: a fixed observation cap (oldest dropped) and fixed ref counts —
//     memory growth can never become an unbounded resource path.
//   - PROVENANCE-BOUND: every observation carries the run's execution id, its
//     admission id and the durable journal event ids it was derived from. An
//     observation without provenance is rejected, not stored.
//   - SECRET-FREE BY CONSTRUCTION: it stores the attribution record (already
//     bounded to identifiers/digests/enums/numbers) plus derived scalars.
//   - DETERMINISTIC reads: identical store ⇒ identical summaries.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { C2dHoldError } from "../c2d/fs-atomic.mjs";
import { digestOf } from "../canonical-digest.mjs";
import { STRATEGY_DIMENSIONS, strategyAxesOf } from "./attribution.mjs";

export const EVOLUTION_STRATEGY_MEMORY_SCHEMA = "autoloop.evolution-strategy-memory/v1";
export const EVOLUTION_STRATEGY_OBSERVATION_SCHEMA = "autoloop.evolution-strategy-observation/v1";

export const STRATEGY_MEMORY_HOLD = Object.freeze({
  INVALID: "HOLD / EVOLUTION_STRATEGY_MEMORY_INVALID",
  PROVENANCE_MISSING: "HOLD / EVOLUTION_STRATEGY_MEMORY_PROVENANCE_MISSING",
});

/** Bounded store size (oldest observations dropped beyond the cap). */
export const MAX_STRATEGY_OBSERVATIONS = 2000;
/** Bounded provenance refs kept per observation. */
export const MAX_OBSERVATION_EVIDENCE_REFS = 32;
/** An observation is never learned from alone: 3 is the floor below which a
 *  value's summary is INSUFFICIENT for any comparison. */
export const MIN_SAMPLES_FOR_SUFFICIENCY = 3;
/** Sample count at which the bounded confidence ratio saturates. */
export const CONFIDENCE_SATURATION_SAMPLES = 8;

function fail(code, message) {
  throw new C2dHoldError(code, message);
}

export function strategyMemoryPath(storeRoot) {
  return join(storeRoot, "strategy-memory.json");
}

function emptyMemory() {
  return { schema: EVOLUTION_STRATEGY_MEMORY_SCHEMA, version: 1, observations: [], updated_at: null };
}

/** Fail-open read (absent/corrupt ⇒ empty): the memory is advisory state, and
 *  the candidate derivation fails closed on insufficient evidence anyway. */
export function readStrategyMemory(storeRoot) {
  const p = strategyMemoryPath(storeRoot);
  if (!existsSync(p)) return emptyMemory();
  try {
    const m = JSON.parse(readFileSync(p, "utf8"));
    if (m?.schema !== EVOLUTION_STRATEGY_MEMORY_SCHEMA || !Array.isArray(m.observations)) return emptyMemory();
    return m;
  } catch { return emptyMemory(); }
}

function writeStrategyMemory(storeRoot, memory) {
  const p = strategyMemoryPath(storeRoot);
  mkdirSync(storeRoot, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(memory, null, 2) + "\n", "utf8");
    renameSync(tmp, p);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  return p;
}

/**
 * Deterministic DURABLE observation identity.
 *
 * The identity binds the AUTHORITATIVE RUN — its execution id when present,
 * otherwise its graph run id. It deliberately does NOT include the attribution
 * content digest: a resumed run appends journal rows, so its recomputed
 * attribution differs while it is still THE SAME authoritative run. Binding
 * the run (not the content) is what makes resume / observer retry / process
 * restart / duplicate terminal observation idempotent (§D): one authoritative
 * run contributes at most ONE observation. A second recording under the same
 * identity with different content is refused as an identity conflict
 * (`OBSERVATION_REJECTED` at the production feed) rather than double counted.
 */
export function strategyObservationId(attribution) {
  const runIdentity = attribution?.execution_id ?? attribution?.graph_run_id ?? null;
  if (runIdentity === null) return null;
  return `sobs_${digestOf({ run_identity: runIdentity }).slice(0, 40)}`;
}

/**
 * Build one strategy observation from an attribution record.
 *
 * @param {object} p
 * @param {object} p.attribution — deriveAttribution output
 * @param {string[]} [p.evidenceRefs] — durable journal event ids (provenance)
 * @returns {object} observation record
 */
export function buildStrategyObservation({ attribution, evidenceRefs = [] } = {}) {
  if (attribution?.schema !== "autoloop.evolution-attribution/v1") {
    fail(STRATEGY_MEMORY_HOLD.INVALID, "attribution record missing or wrong schema");
  }
  const refs = (Array.isArray(evidenceRefs) ? evidenceRefs : [])
    .filter((r) => typeof r === "string" && r.length > 0 && r.length <= 160)
    .slice(0, MAX_OBSERVATION_EVIDENCE_REFS);
  const executionId = attribution.execution_id ?? null;
  const observationId = strategyObservationId(attribution);
  if (observationId === null) {
    fail(STRATEGY_MEMORY_HOLD.PROVENANCE_MISSING, "observation requires an authoritative run identity (execution id or graph run id); an unkeyed observation cannot be deduped");
  }
  if (!executionId && refs.length === 0) {
    fail(STRATEGY_MEMORY_HOLD.PROVENANCE_MISSING, "observation requires an execution id or durable evidence refs");
  }
  const axes = strategyAxesOf(attribution);
  const observation = {
    schema: EVOLUTION_STRATEGY_OBSERVATION_SCHEMA,
    version: 1,
    observation_id: observationId,
    at: new Date().toISOString(),
    task_class: attribution.task_class ?? "UNCLASSIFIED",
    execution_id: executionId,
    admission_id: attribution.admission_id ?? null,
    graph_run_id: attribution.graph_run_id ?? null,
    attribution_digest: attribution.attribution_digest ?? null,
    // The measured outcome facts (all scalars; no free text, no secrets).
    outcome: attribution.outcome ?? "UNKNOWN",
    succeeded: attribution.outcome === "PASS",
    held: attribution.outcome === "HOLD",
    repairs: attribution.retry_repair?.repairs ?? 0,
    max_attempt: attribution.retry_repair?.max_attempt ?? 0,
    latency_ms: attribution.latency?.measured ? attribution.latency.wall_ms : null,
    occupancy_avg: attribution.context_token?.occupancy_avg ?? null,
    occupancy_samples: attribution.context_token?.samples ?? 0,
    fanout: attribution.fanout?.max_concurrent ?? null,
    phase_count: attribution.fanout?.phase_count ?? null,
    generation: attribution.generation ?? null,
    // The strategy VALUES this execution ran under, per dimension (§C names
    // these dimensions; a null value means the axis was unobservable).
    strategy: axes,
    // §C ATTRIBUTION IDENTITY: a bounded projection of the attribution record
    // (identifiers/digests/enums only — never prompt text, never secrets) so
    // one observation is self-describing: run identity, agent identity,
    // parent/subagent relation, provider/model, decomposition identity and
    // the terminal outcome travel WITH the sample.
    attribution_identity: {
      agent_identity: {
        phase_ids: (attribution.agent_identity?.phase_ids ?? []).slice(0, 64),
        stages: (attribution.agent_identity?.stages ?? []).slice(0, 16),
      },
      parent_identity: attribution.parent_identity ?? null,
      provider: attribution.provider ?? null,
      model: attribution.model ?? null,
      adapter_kind: attribution.adapter_kind ?? null,
      task_class: attribution.task_class ?? null,
      decomposition_identity: attribution.decomposition_strategy?.identity ?? null,
      terminal_outcome: attribution.outcome ?? null,
      terminal_hold_code: attribution.terminal_hold_code ?? null,
      generation: attribution.generation ?? null,
    },
    provenance: {
      evidence_refs: refs,
      journal_events: attribution.journal_events ?? 0,
      admission_id: attribution.admission_id ?? null,
      execution_id: executionId,
    },
  };
  observation.observation_digest = digestOf({ ...observation, observation_digest: undefined, at: undefined });
  return observation;
}

/**
 * Record one attributed execution into the bounded memory.
 * Idempotent by observation identity (re-recording returns EXISTING).
 *
 * @returns {{ status: "RECORDED"|"EXISTING", observation: object, size: number }}
 */
export function recordStrategyObservation({ storeRoot, observation, maxObservations = MAX_STRATEGY_OBSERVATIONS }) {
  if (observation?.schema !== EVOLUTION_STRATEGY_OBSERVATION_SCHEMA) {
    fail(STRATEGY_MEMORY_HOLD.INVALID, "observation missing or wrong schema");
  }
  const memory = readStrategyMemory(storeRoot);
  const existing = memory.observations.find((o) => o.observation_id === observation.observation_id);
  if (existing) {
    // Identical identity ⇒ no double count. A DIFFERENT payload under the same
    // identity is a provenance conflict (fail closed, never silently overwrite).
    if (existing.observation_digest !== observation.observation_digest) {
      fail(STRATEGY_MEMORY_HOLD.INVALID, `observation identity conflict for ${observation.observation_id}`);
    }
    return { status: "EXISTING", observation: existing, size: memory.observations.length };
  }
  const observations = [...memory.observations, observation];
  while (observations.length > maxObservations) observations.shift();
  const next = { ...memory, observations, updated_at: new Date().toISOString() };
  writeStrategyMemory(storeRoot, next);
  return { status: "RECORDED", observation, size: observations.length };
}

/** Bounded confidence ratio (a declared heuristic, never a statistical claim). */
export function confidenceOf(samples) {
  if (!Number.isInteger(samples) || samples <= 0) return 0;
  return Math.min(1, samples / CONFIDENCE_SATURATION_SAMPLES);
}

function mean(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function summarizeRows(rows, { taskClass, dimension, value }) {
  const samples = rows.length;
  const succeeded = rows.filter((r) => r.succeeded === true).length;
  const held = rows.filter((r) => r.held === true).length;
  const repaired = rows.filter((r) => (r.repairs ?? 0) > 0).length;
  return {
    task_class: taskClass,
    dimension,
    value,
    samples,
    success_rate: samples > 0 ? succeeded / samples : null,
    hold_rate: samples > 0 ? held / samples : null,
    repair_rate: samples > 0 ? repaired / samples : null,
    repairs_total: rows.reduce((a, r) => a + (r.repairs ?? 0), 0),
    latency_avg_ms: mean(rows.map((r) => r.latency_ms)),
    occupancy_avg: mean(rows.map((r) => r.occupancy_avg)),
    fanout_avg: mean(rows.map((r) => r.fanout)),
    evidence_sufficient: samples >= MIN_SAMPLES_FOR_SUFFICIENCY,
    min_samples_required: MIN_SAMPLES_FOR_SUFFICIENCY,
    confidence: confidenceOf(samples),
    last_observed_at: rows.length > 0 ? rows[rows.length - 1].at : null,
  };
}

/**
 * Summarize every observed strategy value for one (task class, dimension).
 * Rows whose value is null for this dimension are excluded (unobservable
 * evidence is not evidence of a strategy).
 */
export function summarizeStrategyDimension({ storeRoot, taskClass, dimension, memory = null }) {
  if (!STRATEGY_DIMENSIONS.includes(dimension)) {
    fail(STRATEGY_MEMORY_HOLD.INVALID, `unknown strategy dimension: ${String(dimension)}`);
  }
  const m = memory ?? readStrategyMemory(storeRoot);
  const tc = taskClass ?? null;
  const rows = m.observations.filter((o) => o.task_class === tc && o.strategy?.[dimension] != null);
  const byValue = new Map();
  for (const r of rows) {
    const v = r.strategy[dimension];
    const arr = byValue.get(v) ?? [];
    arr.push(r);
    byValue.set(v, arr);
  }
  const values = [...byValue.entries()]
    .map(([value, rs]) => summarizeRows(rs, { taskClass: tc, dimension, value }))
    .sort((a, b) => (b.samples - a.samples) || String(a.value).localeCompare(String(b.value)));
  return {
    task_class: tc,
    dimension,
    total_observations: m.observations.length,
    matching_observations: rows.length,
    values,
  };
}

/** The summary for ONE strategy value (the comparison unit of §H). */
export function summarizeStrategyValue({ storeRoot, taskClass, dimension, value, memory = null }) {
  const dim = summarizeStrategyDimension({ storeRoot, taskClass, dimension, memory });
  return dim.values.find((v) => v.value === value) ?? summarizeRows([], { taskClass, dimension, value });
}

/** Every dimension's summaries for one task class (used for diagnosis). */
export function summarizeTaskClass({ storeRoot, taskClass, memory = null }) {
  const m = memory ?? readStrategyMemory(storeRoot);
  return Object.fromEntries(STRATEGY_DIMENSIONS.map((d) => [d, summarizeStrategyDimension({ storeRoot, taskClass, dimension: d, memory: m })]));
}

/** Read-only operator/verification view of the memory. */
export function strategyMemoryView({ storeRoot, limit = 32 }) {
  const m = readStrategyMemory(storeRoot);
  const byTaskClass = {};
  for (const o of m.observations) {
    byTaskClass[o.task_class] = (byTaskClass[o.task_class] ?? 0) + 1;
  }
  return {
    schema: EVOLUTION_STRATEGY_MEMORY_SCHEMA,
    total: m.observations.length,
    updated_at: m.updated_at,
    by_task_class: byTaskClass,
    latest: m.observations.slice(-limit).map((o) => ({
      observation_id: o.observation_id,
      at: o.at,
      task_class: o.task_class,
      outcome: o.outcome,
      model: o.strategy?.MODEL_ROUTING ?? null,
      provider: o.attribution_identity?.provider ?? null,
      agent: (o.attribution_identity?.agent_identity?.phase_ids ?? []).join(",") || null,
      latency_ms: o.latency_ms,
      occupancy_avg: o.occupancy_avg,
      repairs: o.repairs,
      evidence_refs: (o.provenance?.evidence_refs ?? []).length,
    })),
  };
}
