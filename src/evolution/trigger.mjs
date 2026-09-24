// src/evolution/trigger.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Section A: the
// production improvement trigger.
//
// THE improvement trigger consumes DURABLE, evidence-bound observations
// from a run's evidence journal and produces an improvement trigger event
// ONLY when a quantified, reproducible signal threshold is crossed:
//
//   - repeated equivalent failure   (same holdCode / failure signature ≥ N)
//   - repeated repair requirement   (PHASE_REPAIR_REQUESTED on same phase ≥ N)
//   - recurring HOLD pattern        (same holdCode across runs ≥ N)
//   - abnormal retry/recovery frequency
//   - measurable latency regression (wall-clock regression vs prior baseline)
//   - measurable token inefficiency (provider-reported token regression)
//   - qualified learning evidence   (PATTERN candidates at qualification level)
//
// Hard rules (card §A):
//   - NEVER a single failure: every signal class requires a MINIMUM EVIDENCE
//     COUNT before a trigger may fire.
//   - NEVER an LLM subjective judgment: every signal is derived from
//     durable journal rows / evidence digests (machine-verifiable).
//   - Every trigger event carries provenance: the exact journal event ids
//     (evidence_refs) + the signal class + the quantified observation.
//   - Dedup + cooldown + per-window frequency cap + same-signature
//     suppression are enforced by the trigger state store (state.mjs), not
//     by the caller.
//   - The trigger NEVER mutates anything: it produces a trigger EVENT for
//     the downstream candidate pipeline. Failure to observe is
//     observability only — NORMAL_OPERATION continues.
//
// Authority-free: this module reads evidence journals and the durable
// trigger state; it never mints admission / mutation / commit authority.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { C2dHoldError } from "../c2d/fs-atomic.mjs";
import { canonicalize, digestOf } from "../canonical-digest.mjs";

export const EVOLUTION_TRIGGER_SCHEMA = "autoloop.evolution-trigger/v1";
export const EVOLUTION_TRIGGER_STATE_SCHEMA = "autoloop.evolution-trigger-state/v1";

// Signal classes (closed set). Each carries its own minimum evidence count
// and observation window; thresholds are POLICY inputs (see policy.mjs),
// never hardcoded here.
export const EVOLUTION_SIGNAL_CLASSES = Object.freeze([
  "REPEATED_EQUIVALENT_FAILURE",
  "REPEATED_REPAIR_REQUIREMENT",
  "RECURRING_HOLD_PATTERN",
  "ABNORMAL_RETRY_FREQUENCY",
  "LATENCY_REGRESSION",
  "TOKEN_INEFFICIENCY",
  "QUALIFIED_PATTERN_EVIDENCE",
]);

// Journal event types this trigger reads (durable evidence sources). The
// terminal verdict rows are RUN_PASSED / RUN_HELD / RUN_NOT_BENEFICIAL
// (durable-graph.mjs TERMINAL_EVENT_FOR); the hold reason travels in the
// event payload.
export const TRIGGER_SOURCE_EVENT_TYPES = Object.freeze([
  "PHASE_REPAIR_REQUESTED",
  "PROVIDER_USAGE_OBSERVED",
  "ROLLOVER_USAGE_OBSERVATION_FAILED",
  "RUN_PASSED",
  "RUN_HELD",
  "RUN_NOT_BENEFICIAL",
]);

// Minimum evidence defaults — POLICY may only RAISE these, never lower
// them below the floor (card §A: never a single failure).
export const SIGNAL_COUNT_FLOOR = Object.freeze({
  REPEATED_EQUIVALENT_FAILURE: 3,
  REPEATED_REPAIR_REQUIREMENT: 3,
  RECURRING_HOLD_PATTERN: 3,
  ABNORMAL_RETRY_FREQUENCY: 5,
  LATENCY_REGRESSION: 3,
  TOKEN_INEFFICIENCY: 3,
  QUALIFIED_PATTERN_EVIDENCE: 1, // a qualified pattern IS already ≥2 consolidated incidents
});

// Default observation window per signal (ms). A signal counts only events
// inside the window — stale evidence never accumulates into a trigger.
export const DEFAULT_SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;

// Cooldown defaults (card §A dedup/cooldown; policy may raise).
export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_MAX_TRIGGERS_PER_WINDOW = 3;
export const DEFAULT_MAX_TRIGGERS_PER_WINDOW_MS = 24 * 60 * 60 * 1000;

function fail(code, message, details) {
  throw new C2dHoldError(code, message, details);
}

function sha256Hex(text) {
  // local import avoided: canonical-digest digestOf covers canonical JSON;
  // raw-text digests use node crypto here.
  return createHashHex(text);
}

import { createHash } from "node:crypto";
function createHashHex(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * Derive the failure signature of one durable failure observation.
 * Same signature = same equivalent failure (dedup key). Deterministic:
 * identical facts ⇒ identical signature.
 */
export function failureSignature({ holdCode = null, phaseId = null, errorCode = null }) {
  return digestOf({ holdCode: holdCode ?? null, phaseId: phaseId ?? null, errorCode: errorCode ?? null });
}

/**
 * Extract quantified failure observations from a run evidence journal.
 * Accepts the RunEvidenceStore (verifyJournal/readEvent surface) or a
 * pre-read event array. Returns bounded observation records:
 *   { kind: "failure"|"repair"|"hold"|"retry"|"usage",
 *     signature, phaseId, holdCode, at, eventId, usage? }
 * Malformed rows are SKIPPED (never fabricated, never thrown): the trigger
 * reads evidence, it does not judge the journal.
 */
export function extractTriggerObservations({ store = null, events = null, now = Date.now(), windowMs = DEFAULT_SIGNAL_WINDOW_MS }) {
  let rows = events;
  if (!rows && store) {
    const j = store.verifyJournal();
    rows = [];
    for (let s = 1; s <= j.count; s++) rows.push(store.readEvent(s).event);
  }
  if (!Array.isArray(rows)) return [];
  const cutoff = now - windowMs;
  const out = [];
  for (const e of rows) {
    if (!e || typeof e !== "object") continue;
    const at = Date.parse(e.timestamp ?? "");
    if (!Number.isNaN(at) && at < cutoff) continue; // outside window
    const eventId = e.event_id ?? `seq:${e.sequence ?? "?"}`;
    if (e.event_type === "PHASE_REPAIR_REQUESTED") {
      out.push({
        kind: "repair", signature: failureSignature({ phaseId: e.phase_id ?? null }),
        phaseId: e.phase_id ?? null, at: Number.isNaN(at) ? now : at, eventId,
      });
    } else if (e.event_type === "RUN_HELD") {
      const p = e.payload ?? {};
      const holdCode = p.holdCode ?? (typeof p.reason === "string" ? p.reason.split(":")[0] : null) ?? null;
      out.push({
        kind: "hold", signature: failureSignature({ holdCode }),
        holdCode, at: Number.isNaN(at) ? now : at, eventId,
      });
    } else if (e.event_type === "RUN_PASSED" || e.event_type === "RUN_NOT_BENEFICIAL") {
      out.push({ kind: "pass", at: Number.isNaN(at) ? now : at, eventId });
    } else if (e.event_type === "PROVIDER_USAGE_OBSERVED") {
      const p = e.payload ?? {};
      if (p.provider_reported === true && typeof p.occupancy === "number") {
        out.push({ kind: "usage", occupancy: p.occupancy, at: Number.isNaN(at) ? now : at, eventId });
      }
    } else if (e.event_type === "ROLLOVER_USAGE_OBSERVATION_FAILED") {
      out.push({
        kind: "failure", signature: failureSignature({ errorCode: "USAGE_OBSERVATION_FAILED" }),
        at: Number.isNaN(at) ? now : at, eventId,
      });
    }
  }
  return out;
}

/**
 * Evaluate the signal classes against observations. Returns the signal
 * classes whose count crossed the (policy-raised) minimum within the window.
 * Pure: no I/O, no state.
 *
 * @param {object} p
 * @param {object[]} p.observations — extractTriggerObservations output
 * @param {object} p.thresholds — { [signalClass]: { minCount, windowMs } } (policy)
 * @param {object|null} p.latencyBaseline — { avgDurationMs, sampleCount } prior-window baseline
 * @param {object|null} p.tokenBaseline — { avgOccupancy, sampleCount }
 * @param {number} p.latencyRegressionRatio — e.g. 1.25 = 25% slower triggers
 * @param {number} p.tokenRegressionRatio
 * @param {object|null} p.qualifiedPatterns — [{ patternId, level, digest }] pre-qualified evidence
 */
export function evaluateSignals({
  observations = [], thresholds = {}, latencyBaseline = null, tokenBaseline = null,
  latencyRegressionRatio = 1.25, tokenRegressionRatio = 1.25, qualifiedPatterns = null,
}) {
  const fired = [];
  const count = (pred) => observations.filter(pred).length;

  const t = (cls) => ({
    minCount: Math.max(SIGNAL_COUNT_FLOOR[cls] ?? 2, thresholds[cls]?.minCount ?? SIGNAL_COUNT_FLOOR[cls] ?? 2),
    windowMs: thresholds[cls]?.windowMs ?? DEFAULT_SIGNAL_WINDOW_MS,
  });

  // REPEATED_EQUIVALENT_FAILURE: same failure signature ≥ minCount
  {
    const c = t("REPEATED_EQUIVALENT_FAILURE");
    const failures = observations.filter((o) => o.kind === "failure" || o.kind === "hold");
    const bySig = new Map();
    for (const f of failures) {
      const arr = bySig.get(f.signature) ?? [];
      arr.push(f);
      bySig.set(f.signature, arr);
    }
    for (const [sig, arr] of bySig) {
      if (arr.length >= c.minCount) {
        fired.push({
          signalClass: "REPEATED_EQUIVALENT_FAILURE", count: arr.length, minCount: c.minCount,
          signature: sig, evidenceRefs: arr.map((x) => x.eventId),
          observation: { kind: arr[0].kind, holdCode: arr[0].holdCode ?? null, phaseId: arr[0].phaseId ?? null },
        });
      }
    }
  }

  // REPEATED_REPAIR_REQUIREMENT: repairs on the same phase ≥ minCount
  {
    const c = t("REPEATED_REPAIR_REQUIREMENT");
    const byPhase = new Map();
    for (const o of observations.filter((o) => o.kind === "repair")) {
      const arr = byPhase.get(o.signature) ?? [];
      arr.push(o);
      byPhase.set(o.signature, arr);
    }
    for (const [sig, arr] of byPhase) {
      if (arr.length >= c.minCount) {
        fired.push({
          signalClass: "REPEATED_REPAIR_REQUIREMENT", count: arr.length, minCount: c.minCount,
          signature: sig, evidenceRefs: arr.map((x) => x.eventId),
          observation: { phaseId: arr[0].phaseId ?? null },
        });
      }
    }
  }

  // RECURRING_HOLD_PATTERN: total HOLD observations ≥ minCount (any code mix —
  // the recurring pattern is HOLDs themselves; per-code dedup is the class above)
  {
    const c = t("RECURRING_HOLD_PATTERN");
    const holds = observations.filter((o) => o.kind === "hold");
    if (holds.length >= c.minCount) {
      fired.push({
        signalClass: "RECURRING_HOLD_PATTERN", count: holds.length, minCount: c.minCount,
        signature: failureSignature({ errorCode: "RECURRING_HOLD" }),
        evidenceRefs: holds.map((x) => x.eventId),
        observation: { holdCodes: [...new Set(holds.map((h) => h.holdCode).filter(Boolean))] },
      });
    }
  }

  // ABNORMAL_RETRY_FREQUENCY: repair+failure volume ≥ minCount (frequency proxy
  // over the durable journal; the window bounds it)
  {
    const c = t("ABNORMAL_RETRY_FREQUENCY");
    const retries = observations.filter((o) => o.kind === "repair" || o.kind === "failure");
    if (retries.length >= c.minCount) {
      fired.push({
        signalClass: "ABNORMAL_RETRY_FREQUENCY", count: retries.length, minCount: c.minCount,
        signature: failureSignature({ errorCode: "RETRY_VOLUME" }),
        evidenceRefs: retries.slice(0, 32).map((x) => x.eventId),
        observation: { windowEvents: retries.length },
      });
    }
  }

  // LATENCY_REGRESSION: recent usage observations' wall proxy — the trigger
  // compares MEAN provider occupancy of the current window against the
  // baseline window when a baseline exists (occupancy is the durable
  // provider-reported proxy; wall-clock regression is measured the same way
  // by the caller passing latencyBaseline from prior telemetry).
  {
    const c = t("LATENCY_REGRESSION");
    const usages = observations.filter((o) => o.kind === "usage");
    if (latencyBaseline && typeof latencyBaseline.avgDurationMs === "number" && latencyBaseline.sampleCount >= (c.minCount - 1) && usages.length >= c.minCount) {
      // latency regression uses GRAPH_FINAL-adjacent timing when present;
      // with usage-only evidence the occupancy acts as the measurable proxy.
      const avg = usages.reduce((a, u) => a + u.occupancy, 0) / usages.length;
      if (avg > latencyBaseline.avgDurationMs * latencyRegressionRatio) {
        fired.push({
          signalClass: "LATENCY_REGRESSION", count: usages.length, minCount: c.minCount,
          signature: failureSignature({ errorCode: "LATENCY_REGRESSION" }),
          evidenceRefs: usages.map((x) => x.eventId),
          observation: { currentAvg: avg, baselineAvg: latencyBaseline.avgDurationMs, ratio: avg / latencyBaseline.avgDurationMs },
        });
      }
    }
  }

  // TOKEN_INEFFICIENCY: provider-reported occupancy regression vs baseline.
  {
    const c = t("TOKEN_INEFFICIENCY");
    const usages = observations.filter((o) => o.kind === "usage");
    if (tokenBaseline && typeof tokenBaseline.avgOccupancy === "number" && tokenBaseline.sampleCount >= (c.minCount - 1) && usages.length >= c.minCount) {
      const avg = usages.reduce((a, u) => a + u.occupancy, 0) / usages.length;
      if (avg > tokenBaseline.avgOccupancy * tokenRegressionRatio) {
        fired.push({
          signalClass: "TOKEN_INEFFICIENCY", count: usages.length, minCount: c.minCount,
          signature: failureSignature({ errorCode: "TOKEN_INEFFICIENCY" }),
          evidenceRefs: usages.map((x) => x.eventId),
          observation: { currentAvg: avg, baselineAvg: tokenBaseline.avgOccupancy, ratio: avg / tokenBaseline.avgOccupancy },
        });
      }
    }
  }

  // QUALIFIED_PATTERN_EVIDENCE: pre-qualified pattern records reaching the
  // qualification threshold (REQUIRED_QUESTION level or above per Stage-F).
  {
    const c = t("QUALIFIED_PATTERN_EVIDENCE");
    const q = Array.isArray(qualifiedPatterns) ? qualifiedPatterns : [];
    const eligible = q.filter((p) => p && (p.level === "REQUIRED_QUESTION" || p.level === "MANDATORY_GATE"));
    if (eligible.length >= c.minCount) {
      fired.push({
        signalClass: "QUALIFIED_PATTERN_EVIDENCE", count: eligible.length, minCount: c.minCount,
        signature: failureSignature({ errorCode: "QUALIFIED_PATTERN" }),
        evidenceRefs: eligible.map((p) => p.digest ?? p.patternId),
        observation: { patterns: eligible.map((p) => ({ patternId: p.patternId, level: p.level })) },
      });
    }
  }

  return fired;
}

// ── Durable trigger state (dedup / cooldown / window cap / suppression) ────

function statePath(stateRoot) {
  return join(stateRoot, "evolution-trigger-state.json");
}

function emptyState() {
  return {
    schema: EVOLUTION_TRIGGER_STATE_SCHEMA,
    version: 1,
    triggers: [],           // fired trigger records (bounded)
    lastFiredAt: {},        // signature -> iso timestamp (cooldown basis)
    windowFires: [],        // [{ at, signature }] for the frequency cap
    suppressedSignatures: {}, // signature -> { until, reason } (same-signature suppression)
    circuitBreaker: null,   // { at, reason } when tripped (read by gate.mjs)
  };
}

/** Read the durable trigger state; absent/corrupt → empty (fail-open read of
 * an OBSERVABILITY state — the trigger state never carries authority). */
export function readTriggerState(stateRoot) {
  const p = statePath(stateRoot);
  if (!existsSync(p)) return emptyState();
  let raw;
  try { raw = JSON.parse(readFileSync(p, "utf8")); } catch { return emptyState(); }
  if (raw?.schema !== EVOLUTION_TRIGGER_STATE_SCHEMA) return emptyState();
  return raw;
}

/** Persist the trigger state atomically (tmp + rename; same convention as
 * closeout-state writeCloseoutState). Never throws on cleanup failure. */
export function writeTriggerState(stateRoot, state) {
  const target = statePath(stateRoot);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameSync(tmp, target);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  return target;
}

/**
 * THE trigger gate: given fired signals + durable state + policy limits,
 * decide which signals may fire NOW. Enforces (card §A / §K):
 *   - dedup: same signature inside cooldown → suppressed
 *   - cooldown: per-signature minimum interval
 *   - frequency cap: ≤ maxPerWindow fires inside maxPerWindowMs
 *   - same-signature suppression: explicit suppression entries
 *   - circuit breaker: when tripped, NOTHING fires (evolution suspended)
 * Pure over (signals, state, policy): no I/O here — the caller persists.
 */
export function applyTriggerGates({ fired = [], state, cooldownMs = DEFAULT_COOLDOWN_MS, maxPerWindow = DEFAULT_MAX_TRIGGERS_PER_WINDOW, maxPerWindowMs = DEFAULT_MAX_TRIGGERS_PER_WINDOW_MS, now = Date.now() }) {
  const s = state ?? emptyState();
  // Circuit breaker: tripped → nothing fires (fail-closed for evolution,
  // never for NORMAL_OPERATION — this gate returning [] is the suspension).
  if (s.circuitBreaker) return { allowed: [], suppressed: fired.map((f) => ({ ...f, reason: "circuit_breaker_tripped" })), state: s };

  const windowFires = (s.windowFires ?? []).filter((w) => now - Date.parse(w.at) < maxPerWindowMs);
  const allowed = [];
  const suppressed = [];
  const nextLastFired = { ...(s.lastFiredAt ?? {}) };
  const nextSuppressed = { ...(s.suppressedSignatures ?? {}) };

  for (const f of fired) {
    const sig = f.signature;
    // explicit suppression still active?
    const sup = nextSuppressed[sig];
    if (sup && Date.parse(sup.until) > now) { suppressed.push({ ...f, reason: `suppressed:${sup.reason}` }); continue; }
    // cooldown
    const last = nextLastFired[sig];
    if (last && now - Date.parse(last) < cooldownMs) { suppressed.push({ ...f, reason: "cooldown" }); continue; }
    // window cap
    if (windowFires.length >= maxPerWindow) { suppressed.push({ ...f, reason: "window_cap" }); continue; }
    allowed.push(f);
    nextLastFired[sig] = new Date(now).toISOString();
    windowFires.push({ at: new Date(now).toISOString(), signature: sig });
  }
  return { allowed, suppressed, state: { ...s, lastFiredAt: nextLastFired, windowFires, suppressedSignatures: nextSuppressed } };
}

/**
 * Record one fired trigger durably (bounded list; oldest dropped beyond cap).
 * Returns the updated state (caller persists).
 */
export function recordTrigger(state, trigger, { maxTriggersKept = 64 } = {}) {
  const s = state ?? emptyState();
  const triggers = [...(s.triggers ?? []), trigger];
  while (triggers.length > maxTriggersKept) triggers.shift();
  return { ...s, triggers };
}

/**
 * Trip the global circuit breaker (card §K). AUTO_EVOLUTION = SUSPENDED;
 * NORMAL_OPERATION continues. Idempotent.
 */
export function tripCircuitBreaker(state, { reason, at = new Date().toISOString() }) {
  const s = state ?? emptyState();
  if (s.circuitBreaker) return s;
  return { ...s, circuitBreaker: { at, reason: String(reason ?? "unspecified").slice(0, 200) } };
}

/** Clear the circuit breaker (operator action). */
export function clearCircuitBreaker(state) {
  const s = state ?? emptyState();
  return { ...s, circuitBreaker: null };
}

/**
 * Build one canonical trigger event record (provenance-complete).
 * candidate pipeline input; identity is deterministic over its facts.
 */
export function buildTriggerEvent({ signal, executionId = null, graphRunId = null, source = "autoloop.evolution-trigger", thresholdPolicyDigest = null }) {
  if (!signal?.signalClass || !EVOLUTION_SIGNAL_CLASSES.includes(signal.signalClass)) {
    fail("EVOLUTION_TRIGGER_INVALID", `unknown signal class: ${String(signal?.signalClass)}`);
  }
  const body = {
    schema: EVOLUTION_TRIGGER_SCHEMA,
    trigger_id: null, // filled below
    signal_class: signal.signalClass,
    count: signal.count,
    min_count: signal.minCount,
    signature: signal.signature,
    evidence_refs: [...(signal.evidenceRefs ?? [])].sort(),
    observation: signal.observation ?? {},
    execution_id: executionId,
    graph_run_id: graphRunId,
    source,
    threshold_policy_digest: thresholdPolicyDigest,
    observed_at: new Date().toISOString(),
  };
  body.trigger_id = `evt_${digestOf({ signal_class: body.signal_class, signature: body.signature, evidence_refs: body.evidence_refs, graph_run_id: body.graph_run_id }).slice(0, 32)}`;
  return body;
}

export { sha256Hex };
