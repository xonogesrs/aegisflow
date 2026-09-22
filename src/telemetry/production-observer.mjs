// src/telemetry/production-observer.mjs
//
// R-06 — canonical production graph telemetry instrumentation.
//
// Card: AUTOLOOP_R06_PRODUCTION_GRAPH_TELEMETRY_LARGE_IMPLEMENTATION_AND_CLOSEOUT_1.
// S16 remains THE authority contract; this module implements its
// instrumentation mandate (R-06: the opt-in observer becomes the DEFAULT
// production seam).
//
// What this module IS:
//   - THE single shared production telemetry seam. runAdmittedGraph resolves
//     ONE run-scoped telemetry store through resolveTelemetryStateRoot()
//     (S16 canonical namespace / validated AUTOLOOP_TELEMETRY_STATE_ROOT
//     override) and forwards it to the graph runners; no production writer
//     invents its own persistent root, no repo-local fallback, no cwd
//     fallback (Phase E fence).
//   - The canonical lifecycle timeline emitter: bounded lifecycle.observed
//     events at dispatch / phase start / provider usage / rollover /
//     dependency consumption / retry / resume / final / closeout (Phase C).
//   - Fail-open observability (Phase D authority fence): telemetry failure is
//     surfaced diagnostically on the result envelope (result.telemetry /
//     result.telemetryDisabled) and NEVER changes admission, budget,
//     lifecycle, retrieval, writeback, rollover, dependency authority,
//     closeout, verdict, or promotion. TELEMETRY_AUTHORITY_LEAKS = 0.
//
// What this module is NOT:
//   - not a second truth source: the durable evidence store / checkpoints /
//     budget ledger / closeout state remain the only authorities; telemetry
//     copies identities and counters only (Phase C — no artifact duplication).
//   - not a GC participant: retention stays with src/telemetry/gc.mjs
//     (lifecycle classes R1/R2; active stream protected while the run is
//     non-terminal).
//
// Explicit disable (Phase F): a caller may set opts.telemetry = false to
// disable instrumentation. It is explicit, it does not change execution
// semantics, and it is observable: the result envelope carries
// telemetryDisabled = true. There is NO implicit disable path: a caller that
// passes nothing gets telemetry (default-on), and a null `telemetry` opt
// forwarded from a runner is indistinguishable from "not wired" — the
// disable signal is the explicit `false` at the production gate only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTelemetryStateRoot, TELEMETRY_STATE_ROOT_ENV } from "./location.mjs";
import { TelemetryStore } from "./store.mjs";
import { createTelemetryEvent, LIFECYCLE_OBSERVED_STAGES, TELEMETRY_HOLD_CODES } from "./contract.mjs";

const INIT_MARKER = "telemetry-init.json";

function isTestRun(env = process.env) {
  return env?.NODE_TEST_CONTEXT !== undefined || env?.NODE_TEST_WORKER_ID !== undefined;
}

function trimDetail(v, max = 160) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Resolve the run-scoped telemetry root for one production run (S16 §5).
 * NEVER creates directories and NEVER falls back — a resolution failure is
 * an ordinary error surfaced as TELEMETRY_UNAVAILABLE by the caller.
 */
export function resolveProductionTelemetryRoot({ graphRunId, env = process.env } = {}) {
  return resolveTelemetryStateRoot({ graphRunId, env });
}

/**
 * Initialize the canonical production telemetry state for one graphRunId.
 *
 * Default-on (Phase F): returns an open store bound to the S16 canonical
 * run-scoped root. Crash/replay-safe (Phase I): an init marker records the
 * creation epoch; an existing store is re-opened, never re-created — a
 * resumed era appends to the SAME run-scoped stream and the marker records
 * that the init replayed (idempotent).
 *
 * @returns {{ ok: true, store, stateRoot, created: boolean, replayedInit: boolean }
 *          | { ok: false, holdCode: string, reason: string }}
 */
export function initProductionTelemetry({ graphRunId, env = process.env } = {}) {
  try {
    const stateRoot = resolveProductionTelemetryRoot({ graphRunId, env });
    const markerPath = join(stateRoot, INIT_MARKER);
    const existed = existsSync(stateRoot);
    let replayedInit = false;
    if (existed && existsSync(markerPath)) {
      try {
        const marker = JSON.parse(readFileSync(markerPath, "utf8"));
        replayedInit = marker?.schema === "autoloop.telemetry-init/v1" && marker.graphRunId === graphRunId;
      } catch { replayedInit = false; }
    }
    const store = new TelemetryStore({ stateRoot });
    store.open(); // may throw TelemetryStoreError on corrupt prior state (Phase J: STORE_INVALID)
    if (!existed) {
      mkdirSync(stateRoot, { recursive: true });
      writeFileSync(markerPath, JSON.stringify({
        schema: "autoloop.telemetry-init/v1",
        graphRunId,
        createdAt: new Date().toISOString(),
      }) + "\n", "utf8");
    } else if (!existsSync(markerPath)) {
      // Store predates the marker (pre-R-06 store or torn init): write the
      // marker WITHOUT clobbering the stream; init stays idempotent.
      try { writeFileSync(markerPath, JSON.stringify({
        schema: "autoloop.telemetry-init/v1",
        graphRunId,
        createdAt: new Date().toISOString(),
        adopted: true,
      }) + "\n", "utf8"); } catch { /* marker is best-effort observability */ }
    }
    return { ok: true, store, stateRoot, created: !existed, replayedInit };
  } catch (e) {
    return {
      ok: false,
      holdCode: e?.code === TELEMETRY_HOLD_CODES.STORE_INVALID ? TELEMETRY_HOLD_CODES.STORE_INVALID : TELEMETRY_HOLD_CODES.UNAVAILABLE,
      reason: trimDetail(e?.message ?? e) ?? "telemetry init failed",
    };
  }
}

/**
 * THE shared production lifecycle emitter.
 *
 * One instance per run; every emission is best-effort: a failed append
 * increments droppedCount and never throws (Phase D — observability loss
 * must not stop execution). Duplicate replay (Phase G): the deterministic
 * eventId (graphRunId + stage + phaseId + attempt + sequence) makes a
 * replayed event byte-identical; the store tolerates duplicate lines as
 * observability and no consumer treats them as authority.
 */
export function createLifecycleEmitter({ store, graphRunId, sessionId = null, generation = 0, env = process.env } = {}) {
  let seq = 0;
  let dropped = 0;
  let emitted = 0;
  const emit = (stage, { phaseId = null, attempt = null, outcome = null, detail = null, sessionId: sid = sessionId, generation: gen = generation } = {}) => {
    if (!LIFECYCLE_OBSERVED_STAGES.includes(stage)) {
      dropped++;
      return false; // bounded vocabulary — never an unbounded label
    }
    try {
      const ev = createTelemetryEvent({ graphRunId, eventType: "lifecycle.observed", sequence: seq++ });
      ev.identity = { ...ev.identity, nodeId: phaseId, attempt };
      ev.lifecycle = {
        stage,
        sessionId: sid,
        generation: Number.isInteger(gen) && gen >= 0 ? gen : 0,
        outcome: trimDetail(outcome, 64),
        detail: trimDetail(detail),
      };
      store.append(ev);
      emitted++;
      return true;
    } catch {
      dropped++;
      return false;
    }
  };
  return {
    emit,
    get counts() { return { emitted, dropped }; },
    graphRunId,
    sessionId,
    generation,
    env,
  };
}

/**
 * Build the canonical telemetry wiring forwarded to the graph runners.
 *
 * Production default: { observer } (post-result closeout observation — the
 * pre-existing COST-1 passive observer contract) PLUS { lifecycle } (the
 * mid-run lifecycle emitter wired into the runners' hook seams).
 *
 * @param {object} p
 * @param {string} p.graphRunId — run identity (durable execution id when durable)
 * @param {string|null} p.sessionId — durable session identity (rollover era)
 * @param {number} p.generation — durable graph generation (0 fresh)
 * @param {object} p.env — process env (override + test detection)
 * @returns {{ ok: true, wiring, stateRoot, created }
 *          | { ok: false, holdCode, reason }}
 */
export function buildProductionTelemetryWiring({ graphRunId, sessionId = null, generation = 0, env = process.env } = {}) {
  const init = initProductionTelemetry({ graphRunId, env });
  if (!init.ok) return init;
  const emitter = createLifecycleEmitter({ store: init.store, graphRunId, sessionId, generation, env });
  return {
    ok: true,
    stateRoot: init.stateRoot,
    created: init.created,
    replayedInit: init.replayedInit,
    wiring: {
      store: init.store,
      observer: recordGraphTelemetryShim,
      lifecycle: emitter,
    },
  };
}

// Post-result passive observation: delegates to the existing COST-1 observer
// (graph.run / node.run / node.repair / graph.closeout / verification
// events). Kept as a stable function reference so the wiring object stays
// serializable-shape and the runner contract is unchanged.
async function recordGraphTelemetryShim({ graphResult, closeout = null, store = null, verification = [] } = {}) {
  const { recordGraphTelemetry } = await import("./graph-observer.mjs");
  return recordGraphTelemetry({ graphResult, closeout, store, verification });
}

/**
 * Attach the telemetry disposition to a graph result envelope (Phase D/J).
 * NEVER mutates any other field; NEVER throws.
 */
export function attachTelemetryDisposition(result, disposition) {
  if (!result || typeof result !== "object") return result;
  try {
    result.telemetry = {
      ...(result.telemetry ?? {}),
      ...disposition,
    };
  } catch { /* non-extensible result — disposition is observability only */ }
  return result;
}

/**
 * Production-gate default wiring resolution (Phase E/F).
 *
 * Resolution order:
 *   1. caller telemetry opt === false  → explicit disable (observable)
 *   2. caller telemetry opt is object  → caller-provided wiring (compat:
 *      existing tests/probes that pass their own observer/store)
 *   3. otherwise                       → canonical default-on wiring
 *
 * In a node:test context the canonical default is DISABLED unless the
 * AUTOLOOP_TELEMETRY_STATE_ROOT override is set: node --test child processes
 * would otherwise write every suite's graph runs into the canonical
 * production namespace. This is a TEST-CONTEXT-ONLY refinement of the
 * default — never a production behavior change.
 *
 * @returns {Promise<{ mode: "canonical"|"caller"|"disabled"|"test-default-off",
 *                     wiring: object|null, disposition: object|null, error?: object }>}
 */
export async function resolveProductionTelemetryWiring({ telemetryOpt, graphRunId, sessionId = null, generation = 0, env = process.env } = {}) {
  if (telemetryOpt === false) {
    return {
      mode: "disabled",
      wiring: null,
      disposition: { disabled: true, observed: false, events: 0, holdCode: null },
    };
  }
  if (telemetryOpt && typeof telemetryOpt === "object") {
    return { mode: "caller", wiring: telemetryOpt, disposition: null };
  }
  const overrideSet = typeof env?.[TELEMETRY_STATE_ROOT_ENV] === "string" && env[TELEMETRY_STATE_ROOT_ENV].trim().length > 0;
  if (!overrideSet && isTestRun(env)) {
    return {
      mode: "test-default-off",
      wiring: null,
      disposition: { disabled: true, disabledReason: "TEST_DEFAULT_OFF", observed: false, events: 0, holdCode: null },
    };
  }
  if (typeof graphRunId !== "string" || graphRunId.trim().length === 0) {
    return {
      mode: "disabled",
      wiring: null,
      disposition: { disabled: true, disabledReason: "NO_RUN_IDENTITY", observed: false, events: 0, holdCode: null },
    };
  }
  const built = buildProductionTelemetryWiring({ graphRunId, sessionId, generation, env });
  if (!built.ok) {
    // Degraded observability (Phase J): the run continues; the disposition
    // records WHY telemetry is unavailable. Never an execution failure.
    return {
      mode: "degraded",
      wiring: null,
      disposition: { disabled: false, observed: false, events: 0, holdCode: built.holdCode, reason: built.reason },
      error: built,
    };
  }
  return { mode: "canonical", wiring: built.wiring, disposition: { disabled: false, observed: null, events: 0, holdCode: null, stateRoot: built.stateRoot } };
}
