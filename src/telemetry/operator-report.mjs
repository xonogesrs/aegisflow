// src/telemetry/operator-report.mjs
//
// R-07 — canonical read-only operator surface over the production telemetry
// backbone.
//
// Card: AUTOLOOP_R07_TELEMETRY_AGGREGATE_OPERATOR_SURFACE_LARGE_IMPLEMENTATION_AND_CLOSEOUT_1.
// Authority contract: docs/governance/autoloop-s16-telemetry-authority-location-and-retention-contract.md
// (S16 remains THE authority contract). Instrumentation: R-06
// (production-observer.mjs). Aggregation: aggregate.mjs (COST-1) — REUSED,
// never duplicated.
//
// What this module IS:
//   - THE canonical telemetry reader for one graphRunId. Storage resolves
//     ONLY through resolveTelemetryStateRoot() (S16 §5): the canonical
//     namespace child or the validated AUTOLOOP_TELEMETRY_STATE_ROOT
//     override. No arbitrary root, no cwd fallback, no repo-local fallback.
//   - Bounded: reads ONLY the run-scoped namespace (no traversal outside the
//     graphRunId namespace), a bounded chunk count and byte budget; over the
//     budget the read stops and the report carries an explicit diagnostic.
//   - Retention-aware: rotated-chunk sequence gaps are surfaced as explicit
//     RETENTION_GAP diagnostics (legitimately GC'd R2 history); absence of
//     telemetry is UNKNOWN, never synthesized failure or fabricated state.
//   - Honest: every report field carries an explicit epistemic tag
//     (OBSERVED / DERIVED / UNKNOWN / NOT_APPLICABLE). Missing telemetry
//     never becomes certainty.
//
// What this module is NOT (Phase D authority fence):
//   - NOT execution, lifecycle, admission, budget, rollover, closeout,
//     verdict, or promotion authority. It performs ZERO writes (no mkdir,
//     no append, no rename, no unlink); the only filesystem operations are
//     readdir/lstat/stat/read — read-only by construction.
//   - NOT a consumer input: no production authority path reads the operator
//     report (verified by call-site census; the only aggregate consumer
//     remains the advisory coordinator seam from S16 §C).
//   - NOT a second truth source: it reads telemetry only — never the durable
//     evidence store, durable snapshots, budget ledger, or closeout state.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { resolveTelemetryStateRoot } from "./location.mjs";
import { validateTelemetryEventV1, canonicalJson, sha256Hex } from "./contract.mjs";
import { aggregateGraphRun } from "./aggregate.mjs";

export const OPERATOR_REPORT_SCHEMA = "autoloop.telemetry-operator-report/v1";

// Bounded-read budgets (Phase N). The S16 retained telemetry set per run is
// already bounded by the store (8 MiB active cap + bounded rotated window);
// these bounds are the reader's own defense against a pathological root.
export const OPERATOR_MAX_CHUNKS = 64;
export const OPERATOR_MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MiB

const STORE_SCHEMA = "autoloop.telemetry-store/v1";
const ACTIVE_CHUNK = "telemetry.jsonl";
const INIT_MARKER = "telemetry-init.json";
const ROTATED_CHUNK_RE = /^telemetry-(\d+)\.jsonl$/;

// Epistemic tags (Phase C contract).
export const EVIDENCE_TAGS = Object.freeze(["OBSERVED", "DERIVED", "UNKNOWN", "NOT_APPLICABLE"]);

function tag(value, evidence) {
  return { value, evidence };
}

/**
 * Read the retained telemetry for one graphRunId — bounded, fail-closed,
 * read-only. NEVER throws for ordinary absence/degradation: every failure
 * mode becomes an explicit diagnostic in the returned record.
 *
 * @returns {{
 *   ok: boolean,                       // true when at least the root resolved
 *   stateRoot: string|null,
 *   initMarker: { createdAt: string|null, adopted: boolean }|null,
 *   events: object[],                  // validated, parseable events
 *   durableIdAliases: string[],        // run-scoped store holds events minted under a durable execution id (same-run identity alias)
 *   diagnostics: object[],             // { code, detail } — degradation/gaps
 *   chunks: { active: {present,bytes,lines,valid,malformed}, rotated: [{seq,bytes,lines,valid,malformed,header}] },
 *   retentionGaps: number[],           // missing rotated-chunk sequence numbers
 *   readBounds: { chunksRead, bytesRead, chunkLimit, byteLimit, exceeded },
 * }}
 */
export function readRunTelemetry({ graphRunId, env = process.env } = {}) {
  const diagnostics = [];
  const diag = (code, detail) => diagnostics.push({ code, detail });

  let stateRoot = null;
  try {
    stateRoot = resolveTelemetryStateRoot({ graphRunId, env });
  } catch (e) {
    // S16 resolver semantics: malformed identity / rejected override. The
    // caller surfaces this as an explicit UNKNOWN report, never a mutation.
    return { ok: false, stateRoot: null, reason: `ROOT_RESOLUTION_REFUSED:${String(e?.message ?? e).slice(0, 160)}` };
  }

  let dirents;
  try {
    dirents = readdirSync(stateRoot, { withFileTypes: true });
  } catch (e) {
    if (e?.code === "ENOENT") {
      // Legitimate absence: unknown graphRunId or telemetry-disabled run.
      // UNKNOWN — never fabricated state, never a failure to repair.
      return { ok: true, stateRoot, absent: true, reason: "NO_TELEMETRY_ROOT", events: [], durableIdAliases: [], diagnostics: [{ code: "NO_TELEMETRY_ROOT", detail: `no telemetry namespace for graphRunId ${graphRunId}` }], initMarker: null, chunks: { active: null, rotated: [] }, retentionGaps: [], readBounds: { chunksRead: 0, bytesRead: 0, chunkLimit: OPERATOR_MAX_CHUNKS, byteLimit: OPERATOR_MAX_TOTAL_BYTES, exceeded: false } };
    }
    return { ok: false, stateRoot, reason: `ROOT_READ_FAILED:${e?.code ?? e}` };
  }

  // Fail-closed read boundary: a symlinked entry inside the run root is an
  // escape vector (same fence as the GC engine) — reported, never followed.
  const activeEntry = dirents.find((d) => d.name === ACTIVE_CHUNK);
  const rotatedEntries = [];
  let initMarkerEntry = null;
  for (const d of dirents) {
    const p = join(stateRoot, d.name);
    if (d.isSymbolicLink()) {
      const kind = d.name === ACTIVE_CHUNK || ROTATED_CHUNK_RE.test(d.name) ? "telemetry-chunk" : "entry";
      diag("SYMLINK_ENTRY_SKIPPED", `${d.name} (symlinked ${kind} inside the run root — content not read; escape vector fail-closed)`);
      continue;
    }
    if (d.name === ACTIVE_CHUNK || ROTATED_CHUNK_RE.test(d.name)) {
      if (d.name !== ACTIVE_CHUNK) {
        const m = ROTATED_CHUNK_RE.exec(d.name);
        rotatedEntries.push({ name: d.name, seq: Number(m[1]), path: p });
      }
      continue;
    }
    if (d.name === INIT_MARKER) { initMarkerEntry = p; continue; }
    diag("UNRECOGNIZED_ENTRY", d.name);
  }

  rotatedEntries.sort((a, b) => a.seq - b.seq);
  if (rotatedEntries.length > OPERATOR_MAX_CHUNKS) {
    diag("READ_BOUNDS_CHUNKS", `${rotatedEntries.length} rotated chunks present; reading newest ${OPERATOR_MAX_CHUNKS}`);
  }
  // Read the NEWEST chunks within the budget (bounded window, newest-first
  // relevance for an operational view).
  const selected = rotatedEntries.slice(-OPERATOR_MAX_CHUNKS);

  let initMarker = null;
  if (initMarkerEntry) {
    try {
      const marker = JSON.parse(readFileSync(initMarkerEntry, "utf8"));
      initMarker = {
        createdAt: typeof marker?.createdAt === "string" ? marker.createdAt : null,
        adopted: marker?.adopted === true,
      };
      if (marker?.schema !== "autoloop.telemetry-init/v1") {
        diag("INIT_MARKER_SCHEMA_UNKNOWN", String(marker?.schema ?? "missing"));
      }
    } catch (e) {
      diag("INIT_MARKER_UNREADABLE", String(e?.message ?? e).slice(0, 120));
    }
  } else {
    diag("INIT_MARKER_ABSENT", "run predates R-06 instrumentation or marker was lost");
  }

  const chunks = { active: null, rotated: [] };
  const events = [];
  const durableIdAliases = new Set();
  let bytesRead = 0;
  let chunksRead = 0;
  let exceeded = false;

  const readChunk = (path, seq /* null = active */) => {
    let st;
    try {
      st = statSync(path);
    } catch (e) {
      diag(seq == null ? "ACTIVE_CHUNK_UNREADABLE" : "CHUNK_UNREADABLE", `${basename(path)}: ${e?.code ?? e}`);
      return null;
    }
    bytesRead += st.size;
    chunksRead++;
    if (bytesRead > OPERATOR_MAX_TOTAL_BYTES) {
      exceeded = true;
      diag("READ_BOUNDS_BYTES", `byte budget ${OPERATOR_MAX_TOTAL_BYTES} exceeded at ${basename(path)}; read truncated (partial view)`);
    }
    let raw = null;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      diag(seq == null ? "ACTIVE_CHUNK_UNREADABLE" : "CHUNK_UNREADABLE", `${basename(path)}: ${e?.code ?? e}`);
      return { lines: 0, valid: 0, malformed: 0, headerOk: false, bytes: st.size };
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let headerOk = false;
    let valid = 0;
    let malformed = 0;
    for (let i = 0; i < lines.length; i++) {
      let parsed = null;
      try { parsed = JSON.parse(lines[i]); } catch {
        malformed++;
        if (exceeded) continue;
        diag(seq == null ? "TORN_LINE_ACTIVE" : "TORN_LINE_CHUNK", `${basename(path)} line ${i + 1} unparseable (torn write or corruption)`);
        continue;
      }
      if (i === 0 && parsed && typeof parsed === "object" && parsed.schema !== undefined) {
        headerOk = parsed.schema === STORE_SCHEMA && parsed.schemaVersion === 1;
        if (!headerOk) diag("CHUNK_HEADER_UNKNOWN", `${basename(path)}: schema ${String(parsed.schema)}`);
        continue;
      }
      const v = validateTelemetryEventV1(parsed);
      if (!v.valid) {
        malformed++;
        if (!exceeded) diag("MALFORMED_EVENT", `${basename(path)} line ${i + 1}: ${v.errors.slice(0, 2).join(";")}`);
        continue;
      }
      if (exceeded) continue; // budget exceeded: stop retaining content
      const evRunId = parsed?.graph?.graphRunId;
      if (evRunId !== undefined && evRunId !== graphRunId) {
        // A run store can legitimately carry events minted under the DURABLE
        // execution id (the post-result observer binds graph.run/node.run to
        // graphResult.executionId — the durable id) while the run-scoped
        // store directory is named by the caller's logical executionId.
        // Same-store, same-run identity aliasing: include them in the run
        // view but record the alias explicitly. Truly foreign stores cannot
        // occur here (this IS the run's own namespace); a foreign run's
        // events would only appear through manual file placement, which the
        // alias diagnostic still makes visible.
        durableIdAliases.add(evRunId);
        events.push(v.event);
      } else {
        events.push(v.event);
      }
    }
    return { lines: lines.length, valid, malformed, headerOk, bytes: st.size };
  };

  for (const c of selected) {
    if (exceeded) break;
    const m = ROTATED_CHUNK_RE.exec(c.name);
    const r = readChunk(c.path, Number(m[1]));
    chunks.rotated.push({ seq: Number(m[1]), ...(r ?? { lines: 0, valid: 0, malformed: 0, headerOk: false, bytes: 0 }) });
  }
  if (activeEntry && !exceeded) {
    const r = readChunk(join(stateRoot, ACTIVE_CHUNK), null);
    chunks.active = { present: true, ...(r ?? { lines: 0, valid: 0, malformed: 0, headerOk: false, bytes: 0 }) };
  } else if (!activeEntry) {
    chunks.active = { present: false, lines: 0, valid: 0, malformed: 0, headerOk: false, bytes: 0 };
    diag("ACTIVE_CHUNK_ABSENT", "no active telemetry.jsonl in the run root");
  }

  // Retention gaps: missing sequence numbers in the rotated-chunk set. A gap
  // is the explicit signature of legitimately GC'd R2 history (S16 §7) —
  // surfaced, never treated as a read failure.
  const seqs = chunks.rotated.map((c) => c.seq).sort((a, b) => a - b);
  const retentionGaps = [];
  for (let i = 1; i < seqs.length; i++) {
    for (let s = seqs[i - 1] + 1; s < seqs[i]; s++) retentionGaps.push(s);
  }
  if (retentionGaps.length > 0) {
    diag("RETENTION_GAP", `rotated chunk sequence gap(s): ${retentionGaps.join(",")} (GC'd R2 history)`);
  }
  if (selected.length < rotatedEntries.length) {
    diag("ROTATED_CHUNKS_NOT_READ", `${rotatedEntries.length - selected.length} oldest chunks outside the read window (bounded view)`);
  }

  return {
    ok: true,
    stateRoot,
    absent: false,
    initMarker,
    events,
    durableIdAliases: [...durableIdAliases],
    diagnostics,
    chunks,
    retentionGaps,
    readBounds: { chunksRead, bytesRead, chunkLimit: OPERATOR_MAX_CHUNKS, byteLimit: OPERATOR_MAX_TOTAL_BYTES, exceeded },
  };
}

function parseUsageDetail(detail) {
  // provider.usage detail format: input=N output=N cacheRead=N cacheWrite=N
  const out = { input: null, output: null, cacheRead: null, cacheWrite: null };
  if (typeof detail !== "string") return out;
  for (const m of detail.matchAll(/(input|output|cacheRead|cacheWrite)=(\d+)/g)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

/**
 * Build the operator report for one graphRunId from retained telemetry ALONE.
 *
 * Determinism: for the same retained telemetry bytes the report body is
 * byte-identical (sorted-key canonical identity; `generatedAt` is report
 * METADATA, excluded from the identity). No wall-clock, no randomness, no
 * cwd dependence enters the derived content.
 */
export function buildOperatorReport({ graphRunId, env = process.env } = {}) {
  const read = readRunTelemetry({ graphRunId, env });
  if (!read.ok) {
    // Resolution refused (malformed identity / rejected override): a safe
    // UNKNOWN report with the refusal reason — fail-closed, no mutation.
    // The shape mirrors the full report (every section present, every field
    // UNKNOWN/NOT_APPLICABLE) so the human renderer stays total.
    const unknown = (value) => ({ value: value ?? null, evidence: "UNKNOWN" });
    const notApplicable = (value) => ({ value: value ?? null, evidence: "NOT_APPLICABLE" });
    const refused = {
      schema: OPERATOR_REPORT_SCHEMA,
      graphRunId: graphRunId ?? null,
      generatedAt: new Date().toISOString(),
      availability: { state: "UNAVAILABLE", reason: read.reason ?? "ROOT_RESOLUTION_REFUSED", stateRoot: null, evidence: "OBSERVED" },
      identity: { graphRunId: unknown(graphRunId ?? null), cardId: unknown(null), durableExecutionIds: notApplicable([]), storeCreatedAt: unknown(null) },
      runStatus: {
        status: unknown("UNKNOWN"),
        observedStart: unknown(null),
        latestObservedStage: unknown(null),
        observedFinalState: unknown(null),
        closeoutObservation: notApplicable(null),
      },
      phases: { count: 0, detail: {}, repairsTotal: notApplicable(0) },
      usage: {
        providerUsageObservations: notApplicable({ count: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
        subagentActivity: unknown(null),
        retrieval: notApplicable({ observations: 0, invoked: false }),
        writeback: notApplicable({ observations: 0 }),
      },
      multiSession: {
        rolloverTransitions: notApplicable([]),
        rolloverObserved: notApplicable(false),
        generations: unknown([]),
        generationTransitions: unknown(null),
        successorSessions: notApplicable(null),
        dependencyConsumption: notApplicable([]),
        resumeObservations: notApplicable([]),
        fanOutFanIn: unknown(null),
      },
      timing: { observedStart: unknown(null), observedEnd: unknown(null), elapsedMs: unknown(null), graphDurationMs: unknown(null), perPhaseDurations: notApplicable({}) },
      diagnostics: { count: 1, items: [{ code: "ROOT_RESOLUTION_REFUSED", detail: read.reason ?? "unknown" }] },
      retentionGaps: [],
      readBounds: { chunksRead: 0, bytesRead: 0, chunkLimit: OPERATOR_MAX_CHUNKS, byteLimit: OPERATOR_MAX_TOTAL_BYTES, exceeded: false },
      eventCount: unknown(0),
      durableIdAliases: notApplicable([]),
      aggregate: unknown(null),
    };
    const refusedBody = { ...refused };
    delete refusedBody.generatedAt;
    refused.reportIdentity = sha256Hex(canonicalJson(refusedBody));
    return refused;
  }

  const diagnostics = read.diagnostics.slice();
  const events = read.events;
  const lc = events.filter((e) => e.eventType === "lifecycle.observed" && e.lifecycle);
  const graphRunEvents = events.filter((e) => e.eventType === "graph.run");
  const nodeRunEvents = events.filter((e) => e.eventType === "node.run");
  const repairEvents = events.filter((e) => e.eventType === "node.repair");

  // ── RUN IDENTITY ─────────────────────────────────────────────────────────
  const graphEvent = graphRunEvents[0] ?? null;
  const durableRunIds = read.durableIdAliases.slice();
  const identity = {
    graphRunId: tag(graphRunId, "OBSERVED"),
    cardId: graphEvent
      ? tag(graphEvent.graph?.cardId ?? null, graphEvent.graph?.cardId ? "OBSERVED" : "NOT_APPLICABLE")
      : tag(null, events.length ? "UNKNOWN" : "UNKNOWN"),
    durableExecutionIds: durableRunIds.length
      ? tag(durableRunIds, "OBSERVED") // graph.run/node.run events minted under the durable execution id
      : tag([], "NOT_APPLICABLE"),
    storeCreatedAt: read.initMarker
      ? tag(read.initMarker.createdAt, "OBSERVED")
      : tag(null, "UNKNOWN"),
  };

  // ── RUN STATUS (observed states only — never synthesized certainty) ─────
  const lifecycleTimes = lc.map((e) => Date.parse(e.occurredAt)).filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  const finalEvent = [...lc].reverse().find((e) => e.lifecycle.stage === "run.final");
  const closeoutEvent = [...lc].reverse().find((e) => e.lifecycle.stage === "run.closeout");
  const latestLifecycle = lc.length ? lc[lc.length - 1] : null;
  const observedStartMs = lifecycleTimes.length
    ? lifecycleTimes[0]
    : (read.initMarker?.createdAt ? Date.parse(read.initMarker.createdAt) : null);
  const observedEndMs = lifecycleTimes.length ? lifecycleTimes[lifecycleTimes.length - 1] : null;

  let statusValue;
  let statusEvidence;
  if (finalEvent) {
    statusValue = "OBSERVED_TERMINAL";
    statusEvidence = `run.final outcome=${finalEvent.lifecycle.outcome ?? "unknown"} at ${finalEvent.occurredAt}`;
  } else if (lc.length > 0) {
    statusValue = "OBSERVED_ACTIVE_OR_INCOMPLETE";
    statusEvidence = `no run.final observed; latest observed stage=${latestLifecycle.lifecycle.stage} at ${latestLifecycle.occurredAt}`;
  } else if (read.absent) {
    statusValue = "UNKNOWN";
    statusEvidence = "NO_TELEMETRY_ROOT";
  } else if (events.length > 0) {
    // Post-result COST-1 events exist but no lifecycle timeline (pre-R-06 store).
    statusValue = "UNKNOWN";
    statusEvidence = `store holds ${events.length} non-lifecycle event(s); no lifecycle timeline observed`;
  } else {
    statusValue = "UNKNOWN";
    statusEvidence = "empty store";
  }

  const runStatus = {
    status: tag(statusValue, statusEvidence.startsWith("run.final") || statusValue === "OBSERVED_ACTIVE_OR_INCOMPLETE" ? "OBSERVED" : "UNKNOWN"),
    observedStart: observedStartMs != null && !Number.isNaN(observedStartMs)
      ? tag(new Date(observedStartMs).toISOString(), "OBSERVED")
      : tag(null, "UNKNOWN"),
    latestObservedStage: latestLifecycle
      ? tag({ stage: latestLifecycle.lifecycle.stage, outcome: latestLifecycle.lifecycle.outcome ?? null, at: latestLifecycle.occurredAt }, "OBSERVED")
      : tag(null, events.length ? "UNKNOWN" : "UNKNOWN"),
    observedFinalState: finalEvent
      ? tag({ outcome: finalEvent.lifecycle.outcome ?? null, detail: finalEvent.lifecycle.detail ?? null, at: finalEvent.occurredAt }, "OBSERVED")
      : tag(null, "UNKNOWN"),
    closeoutObservation: closeoutEvent
      ? tag({ outcome: closeoutEvent.lifecycle.outcome ?? null, detail: closeoutEvent.lifecycle.detail ?? null, at: closeoutEvent.occurredAt }, "OBSERVED")
      : tag(null, lc.length ? "UNKNOWN" : "NOT_APPLICABLE"),
  };

  // ── PHASE SUMMARY ────────────────────────────────────────────────────────
  // Phase identity = lifecycle phase events + node.run nodeIds. provider.usage
  // emissions carry the AGENT execution id (exec_*) as nodeId — that is
  // usage identity, not a phase; usage is reported under USAGE, and such ids
  // are folded into the usage observations, never into the phase table.
  const isPhaseId = (id) => typeof id === "string" && !/^exec_[0-9a-f]{32}$/.test(id);
  const phaseIds = new Set();
  for (const e of lc) if (isPhaseId(e.identity?.nodeId)) phaseIds.add(e.identity.nodeId);
  for (const e of nodeRunEvents) if (isPhaseId(e.identity?.nodeId)) phaseIds.add(e.identity.nodeId);
  const phases = {};
  for (const phaseId of [...phaseIds].sort()) {
    const started = lc.filter((e) => e.identity?.nodeId === phaseId && e.lifecycle.stage === "phase.start");
    const dispatched = lc.filter((e) => e.identity?.nodeId === phaseId && e.lifecycle.stage === "phase.dispatch");
    const terminals = lc.filter((e) => e.identity?.nodeId === phaseId && e.lifecycle.stage === "phase.terminal");
    const repairs = lc.filter((e) => e.identity?.nodeId === phaseId && e.lifecycle.stage === "phase.repair");
    const nodeEvents = nodeRunEvents.filter((e) => e.identity?.nodeId === phaseId);
    // The mid-run emitter (phase.terminal) and the post-result observer
    // (node.run) describe the SAME terminal transitions — never sum them.
    // The lifecycle timeline is the primary observation; node.run fills in
    // only when no lifecycle terminal was observed (pre-R-06 stores).
    const passed = Math.max(
      terminals.filter((e) => e.lifecycle.outcome === "PASS").length,
      nodeEvents.filter((e) => e.agent?.finalVerdict === "PASS").length,
    );
    const failedOrHeld = Math.max(
      terminals.filter((e) => e.lifecycle.outcome && e.lifecycle.outcome !== "PASS").length,
      nodeEvents.filter((e) => e.agent?.finalVerdict && e.agent.finalVerdict !== "PASS" && e.agent.finalVerdict !== "SKIPPED_DUE_TO_DEPENDENCY").length,
    );
    const skipped = nodeEvents.filter((e) => e.agent?.finalVerdict === "SKIPPED_DUE_TO_DEPENDENCY").length;
    const attempts = new Set(nodeEvents.map((e) => e.identity?.attempt ?? 0).filter((v) => v !== null));
    phases[phaseId] = {
      started: tag(started.length, started.length ? "OBSERVED" : "UNKNOWN"),
      dispatched: tag(dispatched.length, dispatched.length ? "OBSERVED" : "UNKNOWN"),
      completed: tag(passed, passed ? "OBSERVED" : "UNKNOWN"),
      failedOrHeld: tag(failedOrHeld, failedOrHeld ? "OBSERVED" : "UNKNOWN"),
      skipped: tag(skipped, skipped ? "OBSERVED" : "NOT_APPLICABLE"),
      repairs: tag(repairs.length, repairs.length ? "OBSERVED" : "NOT_APPLICABLE"),
      distinctAttempts: tag(attempts.size, nodeEvents.length ? "OBSERVED" : "UNKNOWN"),
      lastOutcome: (() => {
        const lastT = terminals[terminals.length - 1];
        const lastN = nodeEvents[nodeEvents.length - 1];
        if (lastT) return tag(lastT.lifecycle.outcome ?? null, "OBSERVED");
        if (lastN) return tag(lastN.agent?.finalVerdict ?? null, "OBSERVED");
        return tag(null, "UNKNOWN");
      })(),
    };
  }
  const repairTotal = repairEvents.length + lc.filter((e) => e.lifecycle.stage === "phase.repair").length;

  // ── USAGE ────────────────────────────────────────────────────────────────
  const usageEvents = lc.filter((e) => e.lifecycle.stage === "provider.usage");
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const e of usageEvents) {
    const u = parseUsageDetail(e.lifecycle.detail);
    usageTotals.input += u.input ?? 0;
    usageTotals.output += u.output ?? 0;
    usageTotals.cacheRead += u.cacheRead ?? 0;
    usageTotals.cacheWrite += u.cacheWrite ?? 0;
  }
  const retrievalEvents = events.filter((e) => e.eventType === "retrieval.observed" || (e.eventType === "node.run" && e.retrieval?.invoked === true));
  const writebackEvents = events.filter((e) => e.eventType === "memory.writeback");
  const usage = {
    providerUsageObservations: usageEvents.length
      ? tag({ count: usageEvents.length, totals: usageTotals }, usageEvents.length ? "OBSERVED" : "NOT_APPLICABLE")
      : tag({ count: 0, totals: usageTotals }, "NOT_APPLICABLE"),
    subagentActivity: (() => {
      const dispatchedSubagent = lc.filter((e) => e.lifecycle.stage === "phase.dispatch" && e.lifecycle.detail === "subagent").length;
      const subAgentCount = graphEvent?.agent?.subAgentCount ?? null;
      if (dispatchedSubagent === 0 && subAgentCount == null) return tag(null, "UNKNOWN");
      return tag({ dispatches: dispatchedSubagent, subAgentCount }, "OBSERVED");
    })(),
    retrieval: retrievalEvents.length
      ? tag({ observations: retrievalEvents.length, invoked: retrievalEvents.some((e) => e.retrieval?.invoked === true) }, "OBSERVED")
      : tag({ observations: 0, invoked: false }, "NOT_APPLICABLE"),
    writeback: writebackEvents.length
      ? tag({ observations: writebackEvents.length }, "OBSERVED")
      : tag({ observations: 0 }, "NOT_APPLICABLE"),
  };

  // ── MULTI-SESSION ────────────────────────────────────────────────────────
  const rolloverStages = lc.filter((e) => e.lifecycle.stage.startsWith("rollover."));
  const generations = [...new Set(lc.map((e) => e.lifecycle.generation).filter((v) => Number.isInteger(v)))].sort((a, b) => a - b);
  const sessionIds = [...new Set(lc.map((e) => e.lifecycle.sessionId).filter((v) => typeof v === "string" && v.length > 0))];
  const dependencyEvents = lc.filter((e) => e.lifecycle.stage === "dependency.consumed");
  const resumeEvents = lc.filter((e) => e.lifecycle.stage === "resume.start");
  const multiSession = {
    rolloverTransitions: rolloverStages.length
      ? tag(rolloverStages.map((e) => ({ stage: e.lifecycle.stage, outcome: e.lifecycle.outcome ?? null, detail: e.lifecycle.detail ?? null, at: e.occurredAt })), "OBSERVED")
      : tag([], "NOT_APPLICABLE"),
    rolloverObserved: tag(rolloverStages.length > 0, rolloverStages.length ? "OBSERVED" : "NOT_APPLICABLE"),
    generations: generations.length
      ? tag(generations, "OBSERVED")
      : tag([], "UNKNOWN"),
    generationTransitions: generations.length > 1
      ? tag(generations, "OBSERVED")
      : tag(null, generations.length === 1 ? "NOT_APPLICABLE" : "UNKNOWN"),
    successorSessions: (() => {
      // The successor era's session identity is durable truth, not telemetry.
      // Telemetry observes rollover transitions; a successor era that ran
      // with R-07-era wiring emits its own lifecycle events into the SAME
      // store (generation ≥ 1). Absence of generation ≥ 1 events = the
      // successor era is UNKNOWN from telemetry alone.
      const successorGen = generations.filter((g) => g > 0);
      if (successorGen.length > 0) return tag({ generations: successorGen, sessionIds }, "OBSERVED");
      const handover = rolloverStages.find((e) => e.lifecycle.stage === "rollover.handover" && e.lifecycle.outcome === "OWNERSHIP_TRANSFER_COMMITTED");
      if (handover) {
        const m = /successorGen=(\d+)/.exec(handover.lifecycle.detail ?? "");
        if (m) return tag({ successorGeneration: Number(m[1]), eraEventsObserved: false }, "OBSERVED");
        return tag(null, "UNKNOWN");
      }
      return tag(null, "NOT_APPLICABLE");
    })(),
    dependencyConsumption: dependencyEvents.length
      ? tag(dependencyEvents.map((e) => ({ phaseId: e.identity?.nodeId ?? null, consumed: e.lifecycle.detail ?? null, generation: e.lifecycle.generation ?? null, at: e.occurredAt })), "OBSERVED")
      : tag([], "NOT_APPLICABLE"),
    resumeObservations: resumeEvents.length
      ? tag(resumeEvents.map((e) => ({ outcome: e.lifecycle.outcome ?? null, detail: e.lifecycle.detail ?? null, generation: e.lifecycle.generation ?? null, at: e.occurredAt })), "OBSERVED")
      : tag([], "NOT_APPLICABLE"),
    fanOutFanIn: (() => {
      const fanOut = graphEvent?.agent?.fanOut ?? null;
      const subAgentCount = graphEvent?.agent?.subAgentCount ?? null;
      const dispatched = lc.filter((e) => e.lifecycle.stage === "phase.dispatch");
      const fanned = dispatched.length > 1;
      if (fanOut == null && !fanned) return tag(null, "UNKNOWN");
      return tag({
        fanOut: fanOut ?? (fanned ? dispatched.length : null),
        subAgentCount,
        parallelDispatchObserved: fanned,
        completionOrderAuthoritative: false, // completion ordering is NEVER authority (Phase F invariant, restated)
      }, "OBSERVED");
    })(),
  };

  // ── TIMING ───────────────────────────────────────────────────────────────
  const timing = {
    observedStart: runStatus.observedStart,
    observedEnd: observedEndMs != null
      ? tag(new Date(observedEndMs).toISOString(), "OBSERVED")
      : tag(null, "UNKNOWN"),
    elapsedMs: (observedStartMs != null && observedEndMs != null && observedEndMs >= observedStartMs)
      ? tag(observedEndMs - observedStartMs, "DERIVED")
      : tag(null, "UNKNOWN"),
    graphDurationMs: graphEvent?.timing?.durationMs != null
      ? tag(graphEvent.timing.durationMs, "OBSERVED")
      : tag(null, "UNKNOWN"),
    perPhaseDurations: (() => {
      const out = {};
      for (const e of nodeRunEvents) {
        if (e.identity?.nodeId && e.timing?.durationMs != null) {
          out[e.identity.nodeId] = tag(e.timing.durationMs, "OBSERVED");
        }
      }
      return Object.keys(out).length ? out : tag({}, "NOT_APPLICABLE");
    })(),
  };

  // ── DIAGNOSTICS (degradation honesty) ────────────────────────────────────
  const availabilityEvents = events.filter((e) => e.eventType === "telemetry.availability");
  for (const e of availabilityEvents) {
    diagnostics.push({ code: "TELEMETRY_AVAILABILITY_EVENT", detail: String(e.agent?.holdCode ?? e.occurredAt).slice(0, 120) });
  }
  if (read.durableIdAliases.length > 0) {
    const aliasCount = events.filter((e) => read.durableIdAliases.includes(e.graph?.graphRunId)).length;
    diagnostics.push({ code: "DURABLE_ID_ALIAS_EVENTS", detail: `${aliasCount} event(s) minted under a durable execution id (${read.durableIdAliases.join(",")}) inside this run store — same-run identity alias, included in the run view` });
  }
  // Duplicate-event census (deterministic eventId — duplicates are tolerated
  // observability per S16 §J, but the operator sees them).
  const idCounts = new Map();
  for (const e of events) {
    if (!e.eventId) continue;
    idCounts.set(e.eventId, (idCounts.get(e.eventId) ?? 0) + 1);
  }
  const duplicates = [...idCounts.entries()].filter(([, n]) => n > 1);
  if (duplicates.length > 0) {
    diagnostics.push({ code: "DUPLICATE_EVENTS", detail: `${duplicates.length} duplicate eventId(s) (tolerated observability; replay-safe)` });
  }
  // Missing expected observations: a phase that started but the run reached
  // run.final without that phase ever reaching phase.terminal.
  if (finalEvent) {
    const terminalPhases = new Set(lc.filter((e) => e.lifecycle.stage === "phase.terminal").map((e) => e.identity?.nodeId));
    const startedPhases = new Set(lc.filter((e) => e.lifecycle.stage === "phase.start").map((e) => e.identity?.nodeId));
    const missing = [...startedPhases].filter((p) => p && !terminalPhases.has(p));
    if (missing.length > 0) {
      diagnostics.push({ code: "MISSING_EXPECTED_OBSERVATIONS", detail: `phase(s) started but never observed terminal before run.final: ${missing.join(",")}` });
    }
  }
  // Stale/foreign generation census (generation binding retained, never
  // interpreted as current authority).
  if (generations.length > 1) {
    diagnostics.push({ code: "MULTI_GENERATION_TIMELINE", detail: `lifecycle events span generations ${generations.join(",")} — era binding is observational only` });
  }

  // ── AGGREGATE (canonical COST-1 aggregation — REUSED) ────────────────────
  let aggregate = null;
  let aggregateEvidence = "NOT_APPLICABLE";
  if (events.length > 0) {
    try {
      // The store is run-scoped: every event in it belongs to THIS run
      // (including durable-id alias events). graphRunId=null makes the
      // canonical aggregate consume the whole run store so the graph.run
      // summary (minted under the durable id) is included.
      aggregate = aggregateGraphRun({ events, graphRunId: null });
      aggregateEvidence = "DERIVED";
    } catch (e) {
      diagnostics.push({ code: "AGGREGATE_FAILED", detail: String(e?.message ?? e).slice(0, 120) });
      aggregateEvidence = "UNKNOWN";
    }
  }

  const report = {
    schema: OPERATOR_REPORT_SCHEMA,
    graphRunId,
    generatedAt: new Date().toISOString(), // metadata only — excluded from reportIdentity
    availability: {
      state: read.absent ? "ABSENT" : (read.readBounds.exceeded ? "PARTIAL" : "AVAILABLE"),
      reason: read.absent ? "NO_TELEMETRY_ROOT" : (read.readBounds.exceeded ? "READ_BOUNDS_EXCEEDED" : null),
      stateRoot: read.stateRoot,
      evidence: "OBSERVED",
    },
    identity,
    runStatus,
    phases: { count: Object.keys(phases).length, detail: phases, repairsTotal: tag(repairTotal, repairTotal ? "OBSERVED" : "NOT_APPLICABLE") },
    usage,
    multiSession,
    timing,
    diagnostics: { count: diagnostics.length, items: diagnostics },
    retentionGaps: read.retentionGaps,
    readBounds: read.readBounds,
    eventCount: tag(events.length, "OBSERVED"),
    durableIdAliases: tag(read.durableIdAliases, read.durableIdAliases.length ? "OBSERVED" : "NOT_APPLICABLE"),
    aggregate: aggregate === null ? tag(null, aggregateEvidence) : tag(aggregate, aggregateEvidence),
  };

  // Deterministic identity over the report body (generatedAt excluded).
  const identityBody = { ...report };
  delete identityBody.generatedAt;
  report.reportIdentity = sha256Hex(canonicalJson(identityBody));
  return report;
}

/**
 * Human-readable bounded summary (Phase G output shape 1).
 */
export function renderOperatorReportText(report) {
  const lines = [];
  const t = (x) => `${x.value ?? "—"} [${x.evidence ?? "?"}]`;
  lines.push(`AutoLoop operator report — ${report.graphRunId}`);
  lines.push(`availability: ${report.availability.state}${report.availability.reason ? ` (${report.availability.reason})` : ""} root=${report.availability.stateRoot ?? "—"}`);
  lines.push(`status: ${t(report.runStatus.status)}`);
  if (report.runStatus.observedFinalState.value) {
    const f = report.runStatus.observedFinalState.value;
    lines.push(`final state: ${f.outcome ?? "—"}${f.detail ? ` (${f.detail})` : ""} at ${f.at} [${report.runStatus.observedFinalState.evidence}]`);
  } else {
    lines.push(`latest observed: ${report.runStatus.latestObservedStage.value ? `${report.runStatus.latestObservedStage.value.stage}@${report.runStatus.latestObservedStage.value.at}` : "—"} [${report.runStatus.latestObservedStage.evidence}]`);
  }
  if (report.runStatus.closeoutObservation.value) {
    const c = report.runStatus.closeoutObservation.value;
    lines.push(`closeout: ${c.outcome ?? "—"}${c.detail ? ` (${c.detail})` : ""} at ${c.at} [${report.runStatus.closeoutObservation.evidence}]`);
  }
  lines.push(`phases: ${report.phases.count} observed, repairs=${t(report.phases.repairsTotal)}`);
  for (const [phaseId, p] of Object.entries(report.phases.detail)) {
    lines.push(`  ${phaseId}: started=${p.started.value} completed=${p.completed.value} failed/held=${p.failedOrHeld.value} skipped=${p.skipped.value} repairs=${p.repairs.value} last=${p.lastOutcome.value ?? "—"} [${p.lastOutcome.evidence}]`);
  }
  if (report.usage.providerUsageObservations.value?.count) {
    const u = report.usage.providerUsageObservations.value.totals;
    lines.push(`provider usage (${report.usage.providerUsageObservations.value.count} observations) [${report.usage.providerUsageObservations.evidence}]: input=${u.input} output=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite}`);
  } else {
    lines.push(`provider usage: none observed [${report.usage.providerUsageObservations.evidence}]`);
  }
  if (report.usage.retrieval.value?.observations) lines.push(`retrieval: ${report.usage.retrieval.value.observations} observation(s) [${report.usage.retrieval.evidence}]`);
  if (report.usage.writeback.value?.observations) lines.push(`writeback: ${report.usage.writeback.value.observations} observation(s) [${report.usage.writeback.evidence}]`);
  if (report.multiSession.rolloverObserved.value) {
    lines.push(`rollover: ${report.multiSession.rolloverTransitions.value.length} transition event(s) [${report.multiSession.rolloverTransitions.evidence}]`);
    for (const r of report.multiSession.rolloverTransitions.value) {
      lines.push(`  ${r.at} ${r.stage} ${r.outcome ?? ""} ${r.detail ?? ""}`);
    }
    lines.push(`successor sessions: ${report.multiSession.successorSessions.value ? JSON.stringify(report.multiSession.successorSessions.value) : "—"} [${report.multiSession.successorSessions.evidence}]`);
  }
  if (report.multiSession.dependencyConsumption.value.length) {
    for (const d of report.multiSession.dependencyConsumption.value) {
      lines.push(`dependency consumed: ${d.phaseId} <- ${d.consumed} (gen ${d.generation}) [${report.multiSession.dependencyConsumption.evidence}]`);
    }
  }
  if (report.timing.elapsedMs.value != null) lines.push(`elapsed: ${report.timing.elapsedMs.value}ms [${report.timing.elapsedMs.evidence}]`);
  if (report.diagnostics.count > 0) {
    lines.push(`diagnostics (${report.diagnostics.count}):`);
    for (const d of report.diagnostics.items) lines.push(`  ${d.code}: ${d.detail}`);
  } else {
    lines.push("diagnostics: none");
  }
  if (report.retentionGaps.length > 0) lines.push(`retention gaps (GC'd chunks): ${report.retentionGaps.join(",")}`);
  lines.push(`events: ${report.eventCount.value} read; bounds: ${report.readBounds.chunksRead} chunks / ${report.readBounds.bytesRead} bytes${report.readBounds.exceeded ? " (BOUNDS EXCEEDED — partial view)" : ""}`);
  if (report.durableIdAliases.value?.length) lines.push(`durable-id aliases: ${report.durableIdAliases.value.join(",")} [${report.durableIdAliases.evidence}]`);
  lines.push(`aggregate: ${report.aggregate.value ? `schema=${report.aggregate.value.schema} verdict=${report.aggregate.value.finalVerdict ?? "—"} events=${report.aggregate.value.eventCount}` : "—"} [${report.aggregate.evidence}]`);
  lines.push(`reportIdentity: ${report.reportIdentity}`);
  return lines.join("\n");
}
