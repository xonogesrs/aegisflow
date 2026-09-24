// src/evolution/production-observer.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1 — Section C: the
// production trigger wiring.
//
//   NORMAL_OPERATION (runAdmittedGraph — UNTOUCHED semantics)
//     → telemetry/evidence (durable journal — UNTOUCHED)
//     → EVOLUTION TRIGGER OBSERVER (this module, post-result)
//
// What this module IS:
//   - THE single production observation seam between runAdmittedGraph's
//     terminal evidence and the evolution trigger pipeline. Wired INSIDE
//     runAdmittedGraph after the runner returns (post-result, exactly like
//     the R-06 telemetry disposition attach): it reads the run's DURABLE
//     evidence journal, extracts qualified observations, and evaluates the
//     evolution signal classes against them.
//   - Fail-open to NORMAL_OPERATION (authority fence, same shape as R-06):
//     EVERY failure path — journal unreadable, trigger state corrupt,
//     observer throwing — degrades to an evolutionObservation disposition
//     on the result envelope and NEVER changes admission, budget, lifecycle,
//     closeout, verdict, or promotion semantics. The observer mints NO
//     authority: a fired signal becomes a CANDIDATE only through the full
//     downstream loop (policy → mutation → fitness → review → promotion).
//   - Kill-switch aware (Section H): when AUTO_EVOLUTION = SUSPENDED
//     (explicit env AUTO_EVOLUTION=SUSPENDED or the durable suspension
//     marker), the observer records NOTHING and fires NOTHING — it does not
//     even accumulate trigger state. NORMAL_OPERATION is untouched either way.
//
// What this module is NOT:
//   - not a second journal: it reads the EXISTING RunEvidenceStore journal
//     (the terminal authority), never writes to it.
//   - not the loop: runEvolutionCycle is invoked by the evolution operator
//     surface / scheduled caller, NOT inline in the production run. The
//     production run only OBSERVES. This keeps the mutation/commit machinery
//     entirely outside the NORMAL_OPERATION call stack.
//
// Qualified-evidence rule (card §C): only evidence that crosses a signal
// class's MINIMUM COUNT within its observation window can form a candidate.
// A single failure NEVER triggers a mutation (SIGNAL_COUNT_FLOOR ≥ 3 for
// every countable class; QUALIFIED_PATTERN_EVIDENCE ≥ 1 is itself ≥2
// consolidated incidents by construction).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { RunEvidenceStore } from "../evidence/run-evidence-store.mjs";
import { extractTriggerObservations, evaluateSignals, readTriggerState } from "./trigger.mjs";
import { EVOLUTION_SUSPENSION_SCHEMA, readEvolutionSuspension } from "./kill-switch.mjs";

export const EVOLUTION_OBSERVATION_SCHEMA = "autoloop.evolution-observation/v1";

/** The kill switch (Section H). ENABLED unless explicitly suspended. */
export function evolutionSwitchState({ env = process.env, storeRoot = null } = {}) {
  if (String(env?.AUTO_EVOLUTION ?? "").toUpperCase() === "SUSPENDED") {
    return { state: "SUSPENDED", reason: "env:AUTO_EVOLUTION=SUSPENDED" };
  }
  if (storeRoot && existsSync(join(storeRoot, "evolution-suspended.json"))) {
    const s = readEvolutionSuspension(storeRoot);
    if (s) return { state: "SUSPENDED", reason: s.reason ?? "durable suspension marker" };
  }
  return { state: "ENABLED", reason: null };
}

/**
 * THE production trigger observation (Section C).
 *
 * Reads the run's durable evidence journal (read-only) and evaluates the
 * evolution signal classes. Returns an observation RECORD — it never runs
 * the loop, never mutates the repo, never writes trigger state (trigger
 * state is written by the loop entry when a cycle actually runs, so a
 * suspended/broken observer can never corrupt it).
 *
 * @param {object} p
 * @param {string} p.evidenceRoot — the run's durable evidence root
 * @param {string} p.executionId — the run's execution id (journal owner)
 * @param {string} p.graphRunId — the production graph run id
 * @param {object} [p.thresholds] — policy-raised thresholds only
 * @param {object} [p.latencyBaseline] / [p.tokenBaseline]
 * @param {object[]} [p.qualifiedPatterns]
 * @param {string} [p.storeRoot] — evolution store root (kill-switch check)
 * @param {object} [p.env]
 * @returns {{ schema, graph_run_id, switch_state, observed: number,
 *             fired: object[], baseline_events: number, at: string }}
 *   Total: every field present; `fired` is the qualified signal list (may
 *   be empty — most runs produce NO trigger).
 */
export function observeRunForEvolutionTriggers(p) {
  const at = new Date().toISOString();
  const out = {
    schema: EVOLUTION_OBSERVATION_SCHEMA,
    version: 1,
    graph_run_id: p.graphRunId ?? null,
    execution_id: p.executionId ?? null,
    switch_state: evolutionSwitchState({ env: p.env, storeRoot: p.storeRoot ?? null }),
    observed: 0,
    fired: [],
    baseline_events: 0,
    at,
  };
  // Kill switch: suspended → observe nothing at all (no state reads, no
  // signal evaluation). NORMAL_OPERATION continues unaffected.
  if (out.switch_state.state === "SUSPENDED") return out;

  let events = [];
  try {
    const store = new RunEvidenceStore({
      root: p.evidenceRoot,
      executionId: p.executionId,
      chainId: p.chainId ?? `observer:${p.executionId}`,
      checkpointId: p.checkpointId ?? `observer:${p.executionId}`,
    });
    store.init();
    const j = store.verifyJournal();
    if (!j.ok) return out; // integrity failure: observe nothing, never judge a broken journal
    out.baseline_events = j.count;
    for (let s = 1; s <= j.count; s++) events.push(store.readEvent(s).event);
  } catch {
    return out; // journal unreadable → no observation (fail-open to NORMAL_OPERATION)
  }

  try {
    const observations = extractTriggerObservations({ events });
    out.observed = observations.length;
    out.fired = evaluateSignals({
      observations,
      thresholds: p.thresholds ?? {},
      latencyBaseline: p.latencyBaseline ?? null,
      tokenBaseline: p.tokenBaseline ?? null,
      qualifiedPatterns: p.qualifiedPatterns ?? null,
    });
  } catch {
    out.fired = []; // evaluation failure → no trigger (never blocks the run)
  }
  return out;
}

/**
 * Attach the evolution observation to a production result envelope
 * (observability only — NEVER mutates any other field, NEVER throws;
 * same conventions as attachTelemetryDisposition).
 */
export function attachEvolutionObservation(result, observation) {
  try {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      result.evolutionObservation = observation;
    }
  } catch { /* observability only */ }
  return result;
}
