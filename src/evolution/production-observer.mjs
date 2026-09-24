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
//   - not the loop, and not the consumer: this module only OBSERVES. Since
//     AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_WIRING_REPAIR_1 the production
//     path continues into src/evolution/production-consumer.mjs, which records
//     the durable trigger and SCHEDULES runEvolutionCycle (never awaited, never
//     on the run's stack). Every mutation/commit/promotion stage therefore
//     still runs entirely outside the NORMAL_OPERATION call stack.
//   - not a writer of trigger state: the durable trigger record is written by
//     the consumer / the loop entry when a qualified signal actually exists,
//     so a suspended or broken observer can never corrupt it.
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
 * Read a run's durable evidence journal (READ-ONLY, integrity-verified).
 *
 * THE one journal reader for the evolution subsystem (the observer and the
 * production consumer both use it) — never a second journal, never a
 * re-implementation of the C3 read path.
 *
 * `chainId`/`checkpointId` are READER-scoped identity labels only: the store
 * re-derives its head from the journal directory on init, so a reader never
 * needs the writer's identifiers and never trusts them.
 *
 * @returns {{ ok: boolean, reason: string|null, events: object[], count: number }}
 *   Total: `ok:false` carries the reason and an empty event list; a caller
 *   never has to distinguish an absent journal from a corrupt one to stay safe.
 */
export function readObservationJournal({ evidenceRoot = null, executionId = null, chainId = null, checkpointId = null } = {}) {
  if (!evidenceRoot || !executionId) return { ok: false, reason: "no_evidence_root", events: [], count: 0 };
  try {
    const store = new RunEvidenceStore({
      root: evidenceRoot,
      executionId,
      chainId: chainId ?? `observer:${executionId}`,
      checkpointId: checkpointId ?? `observer:${executionId}`,
    });
    store.init();
    const j = store.verifyJournal();
    if (!j.ok) return { ok: false, reason: "journal_integrity", events: [], count: 0 };
    const events = [];
    for (let s = 1; s <= j.count; s++) events.push(store.readEvent(s).event);
    return { ok: true, reason: null, events, count: j.count };
  } catch {
    return { ok: false, reason: "journal_unreadable", events: [], count: 0 };
  }
}

/**
 * THE production trigger observation (Section C).
 *
 * Reads the run's durable evidence journal (read-only) and evaluates the
 * evolution signal classes. Returns an observation RECORD — it never runs
 * the loop, never mutates the repo, never writes trigger state (the durable
 * trigger record is written by the production consumer / loop entry when a
 * qualified signal actually exists, so a suspended or broken observer can
 * never corrupt it).
 *
 * PRODUCTION SNAPSHOT SEAM (AUTOLOOP_AGENT_STRATEGY_EVIDENCE_FEED_REPAIR_1 §A):
 * the production gate pre-reads the journal ONCE and resolves the kill switch
 * ONCE per run, then hands both to this observer and to the every-run evidence
 * feed — so the trigger evaluation and the strategy observation are derived
 * from the SAME durable snapshot (no torn view, no second read). Both params
 * are OPTIONAL: a direct caller without them gets the original behaviour
 * (this module reads the journal and resolves the switch itself).
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
 * @param {object} [p.journal] — pre-read readObservationJournal output (gate seam)
 * @param {object} [p.switchState] — pre-resolved evolutionSwitchState (gate seam)
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
    switch_state: p.switchState ?? evolutionSwitchState({ env: p.env, storeRoot: p.storeRoot ?? null }),
    observed: 0,
    fired: [],
    baseline_events: 0,
    at,
  };
  // Kill switch: suspended → observe nothing at all (no state reads, no
  // signal evaluation). NORMAL_OPERATION continues unaffected.
  if (out.switch_state.state === "SUSPENDED") return out;

  // The run's REAL durable evidence journal. THE shared reader (also used by
  // the production consumer for the fitness baseline side) — one journal
  // contract, never a second journal.
  const journal = (p.journal && typeof p.journal === "object" && typeof p.journal.ok === "boolean")
    ? p.journal
    : readObservationJournal({
      evidenceRoot: p.evidenceRoot,
      executionId: p.executionId,
      chainId: p.chainId ?? null,
      checkpointId: p.checkpointId ?? null,
    });
  if (!journal.ok) return out; // unreadable/broken journal → no observation (fail-open)
  const events = journal.events;
  out.baseline_events = journal.count;

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
