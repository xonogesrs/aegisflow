// src/evolution/attribution.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVOLUTION_COMPLETION_1 — Section A: execution
// evidence ATTRIBUTION.
//
// Before this module the evolution subsystem could only see a run as
// anonymous failure counts: the durable journal carries `phase_id` and a
// terminal verdict, so a trigger could say "repairs repeat" but never "THIS
// agent, on THIS route, with THIS decomposition, repairs more than that one".
// Without attribution no agent-strategy claim is falsifiable, and
// cross-agent optimization cannot be honestly claimed
// (AUTOLOOP_CROSS_AGENT_EVOLUTION_APPLICATION_AUDIT_1 §B).
//
// This module derives a bounded, provenance-bound attribution record from
// evidence that ALREADY exists in the run's durable journal, plus the run's
// real admitted provider binding (admission is the only provider authority):
//
//   agent identity          phase_id / stage (the durable agent execution identity)
//   parent identity         execution_id + the phase's parent phase (dependency)
//   provider / model        the ADMITTED provider_binding (authoritative, never caller-claimed)
//   task class              deployment-declared per run (bounded token)
//   decomposition identity  digest over (phase_count, ir_sha256, dag_sha256)
//   tool usage summary      TOOL_USAGE_OBSERVED rows (canonical tool ids only)
//   retry / repair          PHASE_REPAIR_REQUESTED count + attempts
//   context / token usage   PROVIDER_USAGE_OBSERVED occupancy (provider-reported)
//   latency                 measured from durable event timestamps
//   success/HOLD/failure    terminal verdict rows
//   generation              rollover session generation (max observed)
//   fan-out / fan-in        DAG phase count + measured max phase concurrency
//
// Hard rules:
//   - NEVER secret content, NEVER free-text reasoning, NEVER raw prompts. Only
//     bounded identifiers, digests, enums and numbers are copied out; the
//     journal's own secret-scan/redaction already ran at write time and this
//     module copies nothing the redactor would have flagged.
//   - DETERMINISTIC: identical journal + identical admitted binding ⇒ byte
//     identical attribution (so its digest is a stable provenance key).
//   - READ-ONLY over the journal: this module never writes to a run's evidence.

import { digestOf } from "../canonical-digest.mjs";

export const EVOLUTION_ATTRIBUTION_SCHEMA = "autoloop.evolution-attribution/v1";

/** The attribution axes §A requires. Every field is always present; an axis
 *  with no durable evidence is `null` (never guessed). */
export const ATTRIBUTION_AXES = Object.freeze([
  "agent_identity",
  "parent_identity",
  "provider",
  "model",
  "adapter_kind",
  "task_class",
  "decomposition_strategy",
  "tool_usage",
  "retry_repair",
  "context_token",
  "latency",
  "outcome",
  "generation",
  "fanout",
]);

/** Strategy dimensions a candidate may act on (§C). Each maps to the
 *  attribution facts that identify the CURRENT strategy value. */
export const STRATEGY_DIMENSIONS = Object.freeze([
  "MODEL_ROUTING",
  "DECOMPOSITION",
  "CONTEXT_ALLOCATION",
  "RETRY_REPAIR",
  "FANOUT_PARALLELISM",
  "TOOL_SELECTION",
  "PROMPT_EVOLUTION",
]);

const TERMINAL_OUTCOMES = Object.freeze({
  RUN_PASSED: "PASS",
  RUN_HELD: "HOLD",
  RUN_NOT_BENEFICIAL: "NOT_BENEFICIAL",
});

const BOUNDED_ID_RE = /^[A-Za-z0-9_.:@/-]{1,160}$/;
const TASK_CLASS_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Bounded identifier or null — never a free-text passthrough. */
function boundedId(v) {
  return typeof v === "string" && BOUNDED_ID_RE.test(v) ? v : null;
}

function boundedNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Canonicalize a deployment-declared task class. Absent/invalid ⇒ UNCLASSIFIED
 *  (a real value — it groups evidence rather than inventing a class). */
export function canonicalTaskClass(v) {
  if (typeof v !== "string") return "UNCLASSIFIED";
  const t = v.trim();
  if (!TASK_CLASS_RE.test(t)) return "UNCLASSIFIED";
  return t.toUpperCase();
}

/** Digest-bound identity of a decomposition shape. Two runs with the same
 *  phase count and the same IR/DAG digests share a decomposition identity —
 *  that identity, not the raw IR, is what a strategy candidate names. */
export function decompositionIdentity({ phaseCount = null, irSha = null, dagSha = null } = {}) {
  return digestOf({ phase_count: phaseCount, ir_sha256: irSha, dag_sha256: dagSha }).slice(0, 24);
}

function ts(e) {
  const t = Date.parse(e?.timestamp ?? "");
  return Number.isNaN(t) ? null : t;
}

/**
 * Measured phase concurrency over durable PHASE_STARTED → PHASE_*end rows.
 * This is the observed fan-out WIDTH (distinct from the DAG's declared phase
 * count), derived by interval overlap — no guessing.
 */
function measureConcurrency(events) {
  const open = new Map();
  const intervals = [];
  for (const e of events) {
    const id = e?.phase_id;
    if (typeof id !== "string") continue;
    const t = ts(e);
    if (t === null) continue;
    if (e.event_type === "PHASE_STARTED") { if (!open.has(id)) open.set(id, t); continue; }
    if (e.event_type === "PHASE_PASSED" || e.event_type === "PHASE_HELD" || e.event_type === "PHASE_FAILED") {
      const start = open.get(id);
      if (start !== undefined) { intervals.push([start, t]); open.delete(id); }
    }
  }
  for (const [id, start] of open) intervals.push([start, start]); // still-open phase: zero-width
  if (intervals.length === 0) return { max_concurrent: null, phase_count_observed: 0 };
  const points = [];
  for (const [s, e] of intervals) { points.push([s, 1]); points.push([e, -1]); }
  points.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1])); // end-before-start at equal ts
  let cur = 0; let max = 0;
  for (const [, d] of points) { cur += d; if (cur > max) max = cur; }
  return { max_concurrent: max, phase_count_observed: intervals.length };
}

/**
 * Derive the attribution record for ONE execution.
 *
 * @param {object} p
 * @param {object[]} p.events — the run's durable journal events (read-only)
 * @param {object|null} [p.admittedBinding] — the admitted provider_binding
 *        ({ adapterKind, providerKind, modelId }) — the ONLY provider authority
 * @param {string} [p.taskClass] — deployment-declared task class
 * @param {string} [p.executionId] / [p.graphRunId] / [p.admissionId]
 * @returns {object} attribution record (schema + all axes + digest)
 */
export function deriveAttribution({
  events = [], admittedBinding = null, taskClass = null, executionId = null, graphRunId = null, admissionId = null,
  promptProfile = null,
} = {}) {
  const rows = Array.isArray(events) ? events.filter((e) => e && typeof e === "object") : [];
  const boundedPromptProfile = typeof promptProfile === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(promptProfile) ? promptProfile : null;

  // ── terminal outcome + reason class ──────────────────────────────────────
  let outcome = "UNKNOWN";
  let terminalHoldCode = null;
  for (const e of rows) {
    const mapped = TERMINAL_OUTCOMES[e.event_type];
    if (mapped) {
      outcome = mapped;
      if (mapped === "HOLD") {
        const r = e.payload?.holdCode ?? e.payload?.reason ?? null;
        terminalHoldCode = typeof r === "string" ? r.split(":")[0].slice(0, 64) : null;
      }
    }
  }

  // ── retry / repair ───────────────────────────────────────────────────────
  const repairs = rows.filter((e) => e.event_type === "PHASE_REPAIR_REQUESTED");
  const attempts = rows.map((e) => (Number.isInteger(e.attempt) ? e.attempt : 0));
  const maxAttempt = attempts.length > 0 ? Math.max(...attempts) : 0;

  // ── provider usage (provider-reported occupancy only) ────────────────────
  const occ = rows
    .filter((e) => e.event_type === "PROVIDER_USAGE_OBSERVED" && e.payload?.provider_reported === true)
    .map((e) => boundedNumber(e.payload?.occupancy))
    .filter((v) => v !== null);
  const usageFailures = rows.filter((e) => e.event_type === "ROLLOVER_USAGE_OBSERVATION_FAILED").length;

  // ── decomposition / fan-out ──────────────────────────────────────────────
  const dag = rows.find((e) => e.event_type === "DAG_ACCEPTED")?.payload ?? null;
  const phaseCount = Number.isInteger(dag?.phase_count) ? dag.phase_count : null;
  const concurrency = measureConcurrency(rows);

  // ── generation (rollover session generation, max observed) ───────────────
  let generation = null;
  for (const e of rows) {
    const g = boundedNumber(e.payload?.sessionGeneration) ?? boundedNumber(e.payload?.generation) ?? boundedNumber(e.payload?.target_generation);
    if (g !== null && (generation === null || g > generation)) generation = g;
  }

  // ── agent identity (the durable agent execution identity) ────────────────
  const phaseIds = [...new Set(rows.map((e) => e.phase_id).filter((p) => typeof p === "string" && p.length > 0))].sort();
  const stages = [...new Set(rows.map((e) => e.stage).filter((s) => typeof s === "string" && s.length > 0))].sort();
  // Parent identity: the durable execution that owns the journal. A phase's
  // parent is the run itself; the run's parent is declared by the caller.
  const parentIdentity = boundedId(graphRunId ?? null) ?? boundedId(executionId ?? null);

  // ── tool usage (only when durable rows exist; no inference) ──────────────
  const toolRows = rows.filter((e) => e.event_type === "TOOL_USAGE_OBSERVED");
  let toolUsage = null;
  if (toolRows.length > 0) {
    const counts = {};
    for (const e of toolRows) {
      const ids = Array.isArray(e.payload?.canonical_tool_ids) ? e.payload.canonical_tool_ids : [];
      for (const id of ids) {
        const cid = boundedId(id);
        if (cid) counts[cid] = (counts[cid] ?? 0) + 1;
      }
    }
    const selection = Object.keys(counts).sort();
    toolUsage = {
      available: true,
      rows: toolRows.length,
      selection_digest: digestOf(selection).slice(0, 24),
      tools: selection,
      counts,
    };
  } else {
    // Explicitly unavailable rather than silently absent: a strategy candidate
    // over TOOL_SELECTION is NOT derivable from evidence lacking this axis.
    toolUsage = { available: false, rows: 0, selection_digest: null, tools: [], counts: {} };
  }

  // ── latency (measured from durable timestamps) ───────────────────────────
  const times = rows.map(ts).filter((t) => t !== null);
  const latency = times.length >= 2
    ? { measured: true, wall_ms: Math.max(...times) - Math.min(...times), first_at: new Date(Math.min(...times)).toISOString(), last_at: new Date(Math.max(...times)).toISOString() }
    : { measured: false, wall_ms: null, first_at: null, last_at: null };

  const record = {
    schema: EVOLUTION_ATTRIBUTION_SCHEMA,
    version: 1,
    execution_id: boundedId(executionId ?? null),
    graph_run_id: boundedId(graphRunId ?? null),
    admission_id: boundedId(admissionId ?? null),
    agent_identity: phaseIds.length > 0 ? { phase_ids: phaseIds.slice(0, 64), stages: stages.slice(0, 16) } : { phase_ids: [], stages },
    parent_identity: parentIdentity,
    provider: boundedId(admittedBinding?.providerKind ?? null),
    model: boundedId(admittedBinding?.modelId ?? null),
    adapter_kind: boundedId(admittedBinding?.adapterKind ?? null),
    task_class: canonicalTaskClass(taskClass),
    prompt_profile: boundedPromptProfile,
    decomposition_strategy: {
      identity: decompositionIdentity({ phaseCount, irSha: dag?.ir_sha256 ?? null, dagSha: dag?.dag_sha256 ?? null }),
      phase_count: phaseCount,
      declared: dag !== null,
    },
    tool_usage: toolUsage,
    retry_repair: { repairs: repairs.length, max_attempt: maxAttempt, repaired_phases: [...new Set(repairs.map((e) => e.phase_id).filter(Boolean))].sort().slice(0, 64) },
    context_token: {
      reported: occ.length > 0,
      occupancy_avg: occ.length > 0 ? occ.reduce((a, v) => a + v, 0) / occ.length : null,
      occupancy_max: occ.length > 0 ? Math.max(...occ) : null,
      samples: occ.length,
      observation_failures: usageFailures,
    },
    latency,
    outcome,
    terminal_hold_code: terminalHoldCode,
    generation,
    fanout: {
      phase_count: phaseCount,
      observed_phase_count: concurrency.phase_count_observed,
      max_concurrent: concurrency.max_concurrent,
    },
    journal_events: rows.length,
  };
  record.attribution_digest = digestOf({ ...record, attribution_digest: undefined });
  return record;
}

/**
 * The current strategy VALUE per dimension, as named by one attribution
 * record. This is what a strategy candidate compares against a proposed
 * alternative, and what the performance memory is keyed by.
 *
 * A dimension whose evidence axis is unavailable is `null` — the memory and
 * the derivation both refuse to reason about a dimension they cannot observe.
 */
export function strategyAxesOf(attribution) {
  const a = attribution ?? {};
  return {
    MODEL_ROUTING: a.provider && a.model ? `${a.provider}/${a.model}` : null,
    // The DECOMPOSITION axis is the TUNABLE knob (the declared phase budget),
    // not the decomposition's identity digest — a digest is not a value a
    // strategy can move. `attribution.decomposition_strategy.identity` keeps
    // the identity for provenance.
    DECOMPOSITION: Number.isInteger(a.decomposition_strategy?.phase_count) ? `max_phases_${a.decomposition_strategy.phase_count}` : null,
    CONTEXT_ALLOCATION: a.context_token?.reported ? contextBandOf(a.context_token.occupancy_avg) : null,
    RETRY_REPAIR: Number.isInteger(a.retry_repair?.max_attempt) ? `max_attempt_${a.retry_repair.max_attempt}` : null,
    FANOUT_PARALLELISM: Number.isInteger(a.fanout?.max_concurrent) ? `concurrency_${a.fanout.max_concurrent}` : null,
    TOOL_SELECTION: a.tool_usage?.available ? a.tool_usage.selection_digest : null,
    // A prompt/profile identity is only observable when the deployment
    // declares it per run — there is no way to read a prompt out of durable
    // execution evidence, and inventing one would be fabrication.
    PROMPT_EVOLUTION: typeof a.prompt_profile === "string" && a.prompt_profile.length > 0 ? `prompt_${a.prompt_profile}` : null,
  };
}

/** Bounded occupancy band — a strategy value must be a small closed token, not
 *  a raw measurement (raw values are not comparable across runs). */
export const CONTEXT_BANDS = Object.freeze([
  { id: "BAND_0_40", max: 0.40 },
  { id: "BAND_40_60", max: 0.60 },
  { id: "BAND_60_75", max: 0.75 },
  { id: "BAND_75_90", max: 0.90 },
  { id: "BAND_90_100", max: Infinity },
]);

export function contextBandOf(occupancy) {
  if (typeof occupancy !== "number" || !Number.isFinite(occupancy)) return null;
  for (const b of CONTEXT_BANDS) if (occupancy < b.max) return b.id;
  return CONTEXT_BANDS[CONTEXT_BANDS.length - 1].id;
}
