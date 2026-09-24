// src/evolution/attribution-feed.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVIDENCE_FEED_REPAIR_1 — Sections A/B/C/D/H.
//
// THE every-run production evidence feed: strategy attribution +
// performance-memory observation for EVERY eligible production run.
//
// THE DEFECT this module repairs
// ------------------------------
// Attribution + performance-memory recording used to live INSIDE the
// production consumer's `scheduleCycle` — i.e. strictly downstream of
// `NO_QUALIFIED_TRIGGER` and of every trigger gate. Only runs that crossed a
// signal threshold and won a scheduling slot were ever attributed, so the
// strategy memory contained a pure DEFICIENT-RUN sample: healthy runs (and
// every non-firing run) were structurally absent. That is a selection bias,
// and it made a genuine baseline-vs-candidate fitness comparison unreachable —
// the baseline (healthy) arm could never accumulate enough samples to clear
// `MIN_SAMPLES_FOR_SUFFICIENCY`.
//
// THE ORDER (card §A) — attribution NEVER requires a trigger:
//
//   runAdmittedGraph terminal result
//     → durable evidence journal (ONE read; the same snapshot the observer sees)
//     → strategy attribution        (attribution.mjs)
//     → performance-memory write    (strategy-memory.mjs)   ← THIS MODULE
//     → evolution trigger evaluation (production-observer.mjs)
//     → optional cycle scheduling   (production-consumer.mjs)
//
// A run is fed whether it PASSED, HELD, repaired, fired a trigger or not.
//
// Hard rules:
//   - INDEPENDENT OF THE TRIGGER: no trigger, no candidate and no scheduled
//     cycle are required (or consulted) for an observation to be recorded.
//   - EXPLICIT ELIGIBILITY: every run receives a disposition from the CLOSED
//     set below. An exclusion names its reason; nothing is dropped silently
//     and nothing is fabricated to fill the memory. Test-only synthetic
//     records, malformed evidence, missing attribution identity and non-agent
//     administrative runs are EXCLUDED — each with a named disposition.
//   - FAIL-OPEN: this module never throws, never rewrites the caller's result
//     and never turns a successful run into HOLD/FAIL (§H). A feed failure is
//     recorded on the envelope AND durably in the feed log, so the operator
//     can see it (`scripts/evolution-operator.mjs`).
//   - DURABLE IDENTITY: the observation identity binds the AUTHORITATIVE RUN
//     (strategy-memory.mjs), so resume / observer retry / process restart /
//     duplicate terminal observation can never double count (§D).
//   - NO SECRETS: the attribution record is already bounded to
//     identifiers/digests/enums/numbers — no prompt text, no credentials.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deriveAttribution } from "./attribution.mjs";
import { buildStrategyObservation, recordStrategyObservation } from "./strategy-memory.mjs";

export const EVOLUTION_FEED_SCHEMA = "autoloop.evolution-attribution-feed/v1";
export const EVOLUTION_FEED_VERSION = 1;
export const EVOLUTION_FEED_LOG_SCHEMA = "autoloop.evolution-attribution-feed-log/v1";
/** Bounded durable feed log (newest-last disposition records). */
export const MAX_FEED_RECENT = 64;
/** Bounded in-process feed log for the verification/operator drain. */
export const MAX_FEED_STATE = 128;

/**
 * Every disposition the feed can report — a CLOSED set. `RECORDED`/`EXISTING`
 * are the only two that mean "an observation is in the memory"; every other
 * member is an explicit, reasoned exclusion or failure (§B).
 */
export const STRATEGY_FEED_DISPOSITIONS = Object.freeze([
  "RECORDED",                // observation durably written
  "EXISTING",                // this authoritative run was already observed (dedup, §D)
  "DISABLED",                // evolution execution inputs not declared (inert deployment)
  "SUSPENDED",               // kill switch: no new evolution state accumulates (§E)
  "NO_DURABLE_EVIDENCE",     // evidence root / journal absent or integrity-failed
  "EMPTY_EVIDENCE",          // journal carries no usable rows
  "SYNTHETIC_RECORD",        // the run declares test-only synthetic provenance (§B)
  "NOT_AGENT_RUN",           // no agent execution identity in the evidence (§B)
  "NO_ATTRIBUTION_IDENTITY", // no run/agent identity derivable from the evidence (§B/C)
  "OBSERVATION_REJECTED",    // the memory boundary refused the observation (provenance/schema/conflict)
  "FEED_FAILED",             // unexpected failure — recorded, never propagated (§H)
]);

/** Dispositions that mean an observation is in the memory. */
const RECORDING_DISPOSITIONS = Object.freeze(["RECORDED", "EXISTING"]);
export const strategyFeedRecorded = (disposition) => RECORDING_DISPOSITIONS.includes(disposition);

// ── Module state (per process; verification/operator drain) ─────────────────

const FEED_STATE = [];

function remember(record) {
  FEED_STATE.push(record);
  while (FEED_STATE.length > MAX_FEED_STATE) FEED_STATE.shift();
}

/** Read-only in-process feed state (bounded, newest-last). */
export function attributionFeedState() {
  return {
    schema: EVOLUTION_FEED_SCHEMA,
    version: EVOLUTION_FEED_VERSION,
    recent: [...FEED_STATE],
    counts: FEED_STATE.reduce((acc, r) => { acc[r.disposition] = (acc[r.disposition] ?? 0) + 1; return acc; }, {}),
  };
}

// ── Durable feed log (operator visibility for feed/attribution failure, §H) ──

export function strategyFeedLogPath(storeRoot) {
  return join(storeRoot, "attribution-feed.json");
}

function emptyFeedLog() {
  return {
    schema: EVOLUTION_FEED_LOG_SCHEMA,
    version: 1,
    counters: {},
    failures: { total: 0, last: null },
    recent: [],
    updated_at: null,
  };
}

/** Fail-open read (absent/corrupt ⇒ empty): the log is operator observability. */
export function readStrategyFeedLog(storeRoot) {
  const p = strategyFeedLogPath(storeRoot);
  if (!existsSync(p)) return emptyFeedLog();
  try {
    const log = JSON.parse(readFileSync(p, "utf8"));
    if (log?.schema !== EVOLUTION_FEED_LOG_SCHEMA || !Array.isArray(log.recent)) return emptyFeedLog();
    return log;
  } catch { return emptyFeedLog(); }
}

function writeStrategyFeedLog(storeRoot, log) {
  const p = strategyFeedLogPath(storeRoot);
  mkdirSync(storeRoot, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(log, null, 2) + "\n", "utf8");
    renameSync(tmp, p);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  return p;
}

/** Bounded, serializable view of one feed record (the durable log entry). */
export function feedRecordView(record) {
  return {
    at: record.at,
    disposition: record.disposition,
    recorded: record.recorded === true,
    reason: record.reason ?? null,
    execution_id: record.execution_id ?? null,
    graph_run_id: record.graph_run_id ?? null,
    task_class: record.task_class ?? null,
    observation_id: record.observation_id ?? null,
    observation_status: record.observation_status ?? null,
    journal_events: record.journal_events ?? 0,
    conflict: record.conflict === true,
    failure: record.failure === true,
  };
}

/**
 * Persist one feed disposition into the durable feed log. FAIL-OPEN: this is
 * operator observability, never a run failure — the caller keeps the
 * in-memory record and the envelope disposition either way.
 *
 * @returns {{ ok: boolean, path: string|null, error: string|null }}
 */
export function recordFeedDisposition({ storeRoot = null, record }) {
  if (!storeRoot) return { ok: false, path: null, error: "no store root" };
  try {
    const log = readStrategyFeedLog(storeRoot);
    const counters = { ...(log.counters ?? {}) };
    counters[record.disposition] = (counters[record.disposition] ?? 0) + 1;
    const entry = feedRecordView(record);
    const recent = [...(log.recent ?? []), entry];
    while (recent.length > MAX_FEED_RECENT) recent.shift();
    const failures = record.failure === true
      ? { total: (log.failures?.total ?? 0) + 1, last: entry }
      : (log.failures ?? { total: 0, last: null });
    writeStrategyFeedLog(storeRoot, {
      schema: EVOLUTION_FEED_LOG_SCHEMA,
      version: 1,
      counters,
      failures,
      recent,
      updated_at: new Date().toISOString(),
    });
    return { ok: true, path: strategyFeedLogPath(storeRoot), error: null };
  } catch (e) {
    return { ok: false, path: null, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Read-only operator/verification view of the durable feed log. */
export function strategyFeedView({ storeRoot, limit = 16 }) {
  const log = readStrategyFeedLog(storeRoot);
  const counters = log.counters ?? {};
  return {
    schema: EVOLUTION_FEED_LOG_SCHEMA,
    counters,
    failures: log.failures ?? { total: 0, last: null },
    total: Object.values(counters).reduce((a, b) => a + b, 0),
    // How many dispositions actually put (or confirmed) an observation in the
    // strategy memory — the operator's direct read of "is the every-run feed
    // recording, or only excluding?".
    recorded: Object.entries(counters)
      .filter(([d]) => strategyFeedRecorded(d))
      .reduce((a, [, n]) => a + n, 0),
    latest: (log.recent ?? []).slice(-limit),
    updated_at: log.updated_at ?? null,
  };
}

// ── §B eligibility ─────────────────────────────────────────────────────────

/**
 * Does the evidence carry an AGENT execution identity? A run with no phase /
 * decomposition / tool evidence never executed an agent, so no agent strategy
 * is observable from it — it is a non-agent administrative run, excluded
 * explicitly rather than recorded as an UNKNOWN observation.
 */
export function hasAgentExecutionIdentity(events) {
  return (Array.isArray(events) ? events : []).some((e) => {
    if (!e || typeof e !== "object") return false;
    if (typeof e.phase_id === "string" && e.phase_id.length > 0) return true;
    const t = e.event_type;
    return typeof t === "string" && (t.startsWith("PHASE_") || t === "DAG_ACCEPTED" || t === "TOOL_USAGE_OBSERVED");
  });
}

/**
 * Test-only synthetic provenance. Detection is DECLARED, never guessed: either
 * the deployment declares itself synthetic, or the durable evidence declares
 * the record synthetic. A record that declares neither is production evidence.
 */
export function syntheticEvidenceReason({ config = null, events = [] } = {}) {
  if (config?.synthetic === true) return "declared_by_deployment";
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.event_type === "SYNTHETIC_EVIDENCE") return "declared_by_evidence_event";
    if (e.payload?.synthetic === true) return "declared_by_evidence_payload";
    if (e.payload?.test_only === true) return "declared_by_evidence_test_only";
  }
  return null;
}

// ── §A/§B/§C/§D the every-run feed ────────────────────────────────────────

function baseRecord(config, extra) {
  return {
    schema: EVOLUTION_FEED_SCHEMA,
    version: EVOLUTION_FEED_VERSION,
    at: new Date().toISOString(),
    disposition: null,
    recorded: false,
    failure: false,
    reason: null,
    store_root: config?.storeRoot ?? null,
    execution_id: null,
    graph_run_id: null,
    task_class: config?.taskClass ?? null,
    observation_id: null,
    observation_status: null,
    conflict: false,
    journal_events: 0,
    feed_log_written: false,
    ...extra,
  };
}

/**
 * Feed ONE production run's durable evidence into the strategy memory (§A/§B).
 *
 * SYNCHRONOUS, bounded, total: it never throws and never touches the caller's
 * result semantics. The returned object carries the serializable feed
 * `record` plus the derived `attribution`, which the caller forwards to the
 * cycle scheduler so the loop's plan inputs come from the SAME attribution
 * this observation was built from (one derivation, two consumers).
 *
 * @param {object} p
 * @param {object|null} p.journal — readObservationJournal output (pre-read snapshot)
 * @param {object} p.config — resolveEvolutionProductionConfig output
 * @param {string|null} [p.executionId] — the AUTHORITATIVE run execution id
 * @param {string|null} [p.graphRunId]
 * @param {object|null} [p.admission] — the frozen admission (provider authority)
 * @param {object|null} [p.switchState] — pre-resolved kill-switch state (§E)
 * @returns {{ record: object, attribution: object|null }}
 */
export function feedStrategyObservationForProduction({
  journal = null, config = null, executionId = null, graphRunId = null,
  admission = null, switchState = null,
} = {}) {
  let record;
  let attribution = null;
  try {
    if (!config?.enabled) {
      record = baseRecord(config, {
        disposition: "DISABLED",
        reason: `evolution execution inputs not declared: ${(config?.missing ?? ["config"]).join(",")}`,
      });
    } else if (switchState?.state === "SUSPENDED") {
      // §E kill switch: an explicitly suspended deployment accumulates NO new
      // evolution state. The disposition is explicit and visible (never a
      // silent drop), and NORMAL_OPERATION is untouched.
      record = baseRecord(config, {
        disposition: "SUSPENDED",
        reason: switchState.reason ?? "AUTO_EVOLUTION=SUSPENDED",
        execution_id: executionId ?? null,
        graph_run_id: graphRunId ?? null,
      });
    } else if (!journal || journal.ok !== true) {
      record = baseRecord(config, {
        disposition: "NO_DURABLE_EVIDENCE",
        reason: journal?.reason ?? "no durable evidence journal for this run",
        execution_id: executionId ?? null,
        graph_run_id: graphRunId ?? null,
      });
    } else {
      const events = Array.isArray(journal.events) ? journal.events : [];
      record = baseRecord(config, {
        execution_id: executionId ?? null,
        graph_run_id: graphRunId ?? null,
        journal_events: events.length,
      });
      if (events.length === 0) {
        record.disposition = "EMPTY_EVIDENCE";
        record.reason = "the durable journal carries no rows";
      } else {
        const synthetic = syntheticEvidenceReason({ config, events });
        if (synthetic) {
          record.disposition = "SYNTHETIC_RECORD";
          record.reason = `test-only synthetic record excluded (${synthetic})`;
        } else if (!hasAgentExecutionIdentity(events)) {
          record.disposition = "NOT_AGENT_RUN";
          record.reason = "no agent execution identity in the evidence (non-agent administrative run)";
        } else {
          attribution = deriveAttribution({
            events,
            // The frozen admission is the ONLY provider authority (§C/E).
            admittedBinding: admission?.extensions?.rollover?.provider_binding ?? null,
            taskClass: config.taskClass,
            executionId,
            graphRunId,
            admissionId: admission?.admission_id ?? null,
            promptProfile: config.promptProfile,
          });
          record.task_class = attribution.task_class ?? config.taskClass ?? null;
          if (!attribution.execution_id && !attribution.graph_run_id) {
            // No authoritative run identity: the observation could never be
            // deduped, so it is refused AND the attribution is not handed on
            // (an unkeyed attribution must not reach a cycle either).
            attribution = null;
            record.disposition = "NO_ATTRIBUTION_IDENTITY";
            record.reason = "no run identity (execution id / graph run id) derivable from the evidence";
          } else {
            // The memory boundary can REFUSE (missing durable provenance,
            // wrong schema, or a run-identity conflict) or FAIL (an I/O error
            // writing the memory). A refusal is an explicit disposition —
            // never a silent drop, never a fabricated observation — and an
            // identity conflict is dedup, not a failure; a write failure is a
            // feed failure (§H).
            let observation = null;
            try {
              observation = buildStrategyObservation({
                attribution,
                evidenceRefs: events.map((e) => e?.event_id).filter(Boolean),
              });
            } catch (e) {
              record.disposition = "OBSERVATION_REJECTED";
              record.failure = true;
              record.reason = `observation refused: ${String(e?.code ?? e?.message ?? e).slice(0, 240)}`;
            }
            if (observation) {
              try {
                const written = recordStrategyObservation({ storeRoot: config.storeRoot, observation });
                record.disposition = written.status === "EXISTING" ? "EXISTING" : "RECORDED";
                record.recorded = true;
                record.observation_id = observation.observation_id;
                record.observation_status = written.status;
                record.reason = written.status === "EXISTING"
                  ? "this authoritative run was already observed (deduped by durable run identity)"
                  : null;
              } catch (e) {
                const code = String(e?.code ?? "");
                const conflict = /identity conflict/.test(String(e?.message ?? ""));
                const refused = conflict || code.startsWith("HOLD / EVOLUTION_STRATEGY_MEMORY_");
                record.observation_id = observation.observation_id;
                if (!refused) {
                  // An I/O failure writing the durable memory is a FEED
                  // failure: fail-open, recorded, visible to the operator.
                  record.disposition = "FEED_FAILED";
                  record.failure = true;
                  record.reason = `strategy memory write failed: ${String(e?.code ?? e?.message ?? e).slice(0, 240)}`;
                } else {
                  record.disposition = "OBSERVATION_REJECTED";
                  record.conflict = conflict;
                  record.failure = !conflict;
                  record.reason = conflict
                    ? `authoritative run already observed with different content (deduped, never double counted): ${String(e?.message ?? e).slice(0, 200)}`
                    : `memory refused: ${String(e?.code ?? e?.message ?? e).slice(0, 240)}`;
                }
              }
            }
          }
        }
      }
    }
  } catch (e) {
    // §B/§H: a refused/failed observation is EXPLICIT, never a silent drop and
    // never a fabricated record; a feed failure is never a run failure.
    attribution = null;
    record = baseRecord(config, {
      disposition: "FEED_FAILED",
      failure: true,
      reason: `${String(e?.code ?? "").trim()}${e?.code ? ": " : ""}${String(e?.message ?? e).slice(0, 300)}`,
      execution_id: executionId ?? null,
      graph_run_id: graphRunId ?? null,
    });
  }

  const persisted = recordFeedDisposition({ storeRoot: config?.storeRoot ?? null, record });
  record.feed_log_written = persisted.ok;
  if (!persisted.ok && persisted.error && record.reason === null) record.reason = `feed log: ${persisted.error}`;
  remember(record);
  return { record, attribution };
}

/**
 * Attach the feed disposition to a production result envelope (observability
 * only — NEVER mutates any other field, NEVER throws; same conventions as
 * attachEvolutionObservation).
 */
export function attachStrategyAttribution(result, record) {
  try {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      result.strategyAttribution = record;
    }
  } catch { /* observability only */ }
  return result;
}
