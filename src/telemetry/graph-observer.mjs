// src/telemetry/graph-observer.mjs
//
// COST-1 — passive graph observer（card stage 4）.
//
// Runs AFTER the graph result + closeout gate are final, consuming ONLY the
// structured result（nodeResults / scheduler / transitions / memoryContext /
// closeout）. It NEVER:
//   - changes task semantics, scheduler ordering, writer lease, review
//     verdict, repair budget, retrieval ranking, model or context selection
//   - records memory bodies, prompts, responses, stdout/stderr, secrets
//
// Failure semantics: any recording failure is caught and surfaced as a
// telemetry.availability event（TELEMETRY_UNAVAILABLE）— the graph outcome is
// never altered. A corrupt store throws TelemetryStoreError
// （TELEMETRY_STORE_INVALID）to the caller（the graph still completes; the
// caller decides whether missing canonical metrics must fail closed）.

import { createTelemetryEvent, TELEMETRY_HOLD_CODES } from "./contract.mjs";
import { classifyVerification } from "./security.mjs";
import { TelemetryStoreError } from "./store.mjs";

function nodeTiming(node) {
  const startedAt = node?.startedAt ? new Date(node.startedAt).toISOString() : null;
  const completedAt = node?.completedAt ? new Date(node.completedAt).toISOString() : null;
  const durationMs = node?.resultIdentity?.latencyMs ?? (startedAt && completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : null);
  return { startedAt, completedAt, durationMs: durationMs !== null ? Math.max(0, durationMs) : null };
}

function retrievalFromMemoryContext(mc) {
  if (!mc || typeof mc !== "object") {
    return { invoked: false, state: null, selectedCount: null, conflictCount: null, truncated: null, maxRecords: null, maxBytes: null, byteCount: null, retrievalDigest: null, storeSnapshotDigest: null };
  }
  const counts = mc.counts ?? {};
  return {
    invoked: mc.state === "AVAILABLE" || mc.state === "EMPTY_MEMORY" || mc.state === "INVALID",
    state: mc.state ?? null,
    selectedCount: counts.selected ?? null,
    conflictCount: Array.isArray(mc.conflictGroups) ? mc.conflictGroups.length : null,
    truncated: mc.truncated ?? null,
    maxRecords: mc.limits?.maxRecords ?? null,
    maxBytes: mc.limits?.maxBytes ?? null,
    byteCount: mc.byteCount ?? null,
    retrievalDigest: mc.retrievalDigest ?? null,
    storeSnapshotDigest: mc.storeSnapshotDigest ?? null,
  };
}

/**
 * Record telemetry events for a completed graph run（passive observer）.
 *
 * @param {object} opts
 * @param {object} opts.graphResult — runColimaGraph result（structured）
 * @param {object} [opts.closeout]  — closeout config（card identity）
 * @param {object} opts.store       — TelemetryStore（open）
 * @param {object} [opts.verification] — [{suite, tests, passed, failed,
 *        durationMs}] measured verification results
 * @returns {Promise<{ok: boolean, events: number, holdCode: string|null}>}
 *          — NEVER throws（all failures degrade to TELEMETRY_UNAVAILABLE）.
 */
export async function recordGraphTelemetry({ graphResult, closeout = null, store = null, verification = [] } = {}) {
  if (!graphResult || !store) return { ok: false, events: 0, holdCode: TELEMETRY_HOLD_CODES.UNAVAILABLE };
  let events = 0;
  let dropped = 0;
  const emit = (ev) => {
    try {
      store.append(ev);
      events++;
      return true;
    } catch (e) {
      if (e instanceof TelemetryStoreError && e.code === TELEMETRY_HOLD_CODES.STORE_INVALID) throw e; // rethrow store corruption
      dropped++;
      return false;
    }
  };
  try {
    const executionId = graphResult.executionId ?? "graph-unknown";
    const seq = { n: 0 };
    const next = () => seq.n++;

    // ── graph.run ─────────────────────────────────────────────────────────
    const nodes = Array.isArray(graphResult.nodeResults) ? graphResult.nodeResults : [];
    const started = nodes.map((n) => n?.startedAt).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const completed = nodes.map((n) => n?.completedAt).filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
    const graphEvent = createTelemetryEvent({ graphRunId: executionId, eventType: "graph.run", sequence: next() });
    graphEvent.graph = {
      graphRunId: executionId,
      cardId: closeout?.cardId ?? null,
      cardTitle: closeout?.cardTitle ?? null,
      cardType: closeout?.cardType ?? null,
    };
    graphEvent.timing = {
      startedAt: started.length ? new Date(started[0]).toISOString() : null,
      completedAt: completed.length ? new Date(completed[0]).toISOString() : null,
      durationMs: started.length && completed.length ? Math.max(0, completed[0] - started[0]) : null,
    };
    graphEvent.agent = {
      subAgentCount: nodes.filter((n) => n?.subagentEnvelope || n?.subagentResult).length,
      fanOut: nodes.length,
      attempts: nodes.reduce((a, n) => a + ((n?.attempt ?? 0) + 1), 0),
      repairCount: (graphResult.transitions ?? []).filter((t) => Array.isArray(t.lifecycleTransitions) && t.lifecycleTransitions.some((lt) => String(lt.status).toUpperCase() === "REPAIR")).length,
      reviewerCount: (graphResult.transitions ?? []).filter((t) => Array.isArray(t.lifecycleTransitions) && t.lifecycleTransitions.some((lt) => lt.phase === "reviewer" || lt.phase === "reviewer_verdict")).length,
      skippedNodes: nodes.filter((n) => n?.skipped === true).length,
      finalVerdict: graphResult.final ?? null,
      holdCode: graphResult.holdCode ?? null,
    };
    graphEvent.retrieval = retrievalFromMemoryContext(graphResult.memoryContext);
    graphEvent.identity.taskType = "graph";
    // TA-2（X）: admission quality telemetry — every graph.run event carries
    // the admission identity + profile; aggregates compute overkill /
    // under-classification / escalation frequency from these fields.
    if (graphResult.admission && typeof graphResult.admission === "object") {
      graphEvent.admission = {
        admissionId: graphResult.admission.admission_id ?? null,
        size: graphResult.admission.size ?? null,
        risk: graphResult.admission.risk ?? null,
        profile: graphResult.admission.profile ?? null,
        fastPath: graphResult.admission.profile === "FAST_PATH",
        repairBudget: graphResult.admission.repair_budget ?? null,
        escalationCount: Array.isArray(graphResult.admission.risk_details?.escalation_log) ? graphResult.admission.risk_details.escalation_log.length : null,
        underClassified: graphResult.admission.size_details?.under_classified === true,
        externalReviewRequired: graphResult.admission.review_policy?.external_review_required === true,
      };
    } else {
      graphEvent.admission = { admissionId: null, size: null, risk: null, profile: null, fastPath: false, repairBudget: null, escalationCount: null, underClassified: null, externalReviewRequired: null };
    }
    // DE-2 D7 — recovery provenance（replay-aware; never double-counts）.
    graphEvent.recovery = {
      executionAttempt: graphResult.recovery?.executionAttempt ?? null,
      recoveryGeneration: graphResult.recovery?.recoveryGeneration ?? null,
      replayOf: graphResult.recovery?.replayOf ?? null,
      resumed: graphResult.recovery?.resumed ?? null,
      recovered: graphResult.recovery?.recovered ?? null,
      duplicateSuppressed: graphResult.recovery?.duplicateSuppressed ?? null,
    };
    emit(graphEvent);

    // ── node.run + node.repair（per node; IR order is deterministic）──────
    for (const n of nodes) {
      const timing = nodeTiming(n);
      const nodeEvent = createTelemetryEvent({ graphRunId: executionId, eventType: "node.run", sequence: next() });
      nodeEvent.graph = { graphRunId: executionId, cardId: closeout?.cardId ?? null, cardTitle: closeout?.cardTitle ?? null, cardType: closeout?.cardType ?? null };
      nodeEvent.identity = {
        nodeId: n.nodeId ?? null,
        phaseExecutionId: n.phaseExecutionId ?? null,
        agentExecutionId: n.subagentEnvelope?.agentExecutionId ?? null,
        attempt: n.attempt ?? null,
        stage: n.subagentEnvelope?.stage ?? null,
        taskType: n.taskType ?? null,
        risk: null,
      };
      nodeEvent.timing = timing;
      nodeEvent.agent = { finalVerdict: n.final ?? null, holdCode: n.reason ?? null };
      nodeEvent.retrieval = retrievalFromMemoryContext(n.memoryContext ?? graphResult.memoryContext);
      emit(nodeEvent);
    }

    // repair transitions -> node.repair events
    for (const t of graphResult.transitions ?? []) {
      if (!Array.isArray(t.lifecycleTransitions)) continue;
      for (const lt of t.lifecycleTransitions) {
        if (String(lt.status).toUpperCase() !== "REPAIR" && String(lt.phase).toUpperCase() !== "REPAIR") continue;
        const repairEvent = createTelemetryEvent({ graphRunId: executionId, eventType: "node.repair", sequence: next() });
        repairEvent.graph = { graphRunId: executionId, cardId: closeout?.cardId ?? null, cardTitle: closeout?.cardTitle ?? null, cardType: closeout?.cardType ?? null };
        repairEvent.identity = { nodeId: t.phaseId ?? null, phaseExecutionId: null, agentExecutionId: null, attempt: lt.attempt ?? null, stage: "repair", taskType: null, risk: null };
        repairEvent.agent = { finalVerdict: "REPAIR" };
        emit(repairEvent);
      }
    }

    // ── graph.closeout（bundle identity, not the bundle text）─────────────
    const co = graphResult.closeout ?? {};
    if (co.applied === true || closeout?.requiresReview === true) {
      const closeoutEvent = createTelemetryEvent({ graphRunId: executionId, eventType: "graph.closeout", sequence: next() });
      closeoutEvent.graph = { graphRunId: executionId, cardId: closeout?.cardId ?? null, cardTitle: closeout?.cardTitle ?? null, cardType: closeout?.cardType ?? null };
      closeoutEvent.identity.taskType = "closeout";
      closeoutEvent.agent = {
        finalVerdict: co.final ?? graphResult.final ?? null,
        holdCode: co.holdCode ?? null,
      };
      emit(closeoutEvent);
    }

    // ── verification.recorded（measured results provided by the caller）───
    for (const v of verification ?? []) {
      if (!v || typeof v !== "object") continue;
      const vEvent = createTelemetryEvent({ graphRunId: executionId, eventType: "verification.recorded", sequence: next() });
      vEvent.graph = { graphRunId: executionId, cardId: closeout?.cardId ?? null, cardTitle: closeout?.cardTitle ?? null, cardType: closeout?.cardType ?? null };
      vEvent.identity.taskType = "verification";
      vEvent.verification = {
        suite: v.suite ?? null,
        tests: v.tests ?? null,
        passed: v.passed ?? null,
        failed: v.failed ?? null,
        durationMs: v.durationMs ?? null,
        classification: v.classification ?? (v.suite ? classifyVerification(v.suite) : null),
      };
      emit(vEvent);
    }

    return { ok: events > 0 && dropped === 0, events, holdCode: dropped > 0 ? TELEMETRY_HOLD_CODES.UNAVAILABLE : null };
  } catch (e) {
    // store corruption must be surfaced（TELEMETRY_STORE_INVALID）— the caller
    // decides fail-closed semantics; the graph itself already completed.
    if (e instanceof TelemetryStoreError) {
      return { ok: false, events, holdCode: e.code };
    }
    return { ok: false, events, holdCode: TELEMETRY_HOLD_CODES.UNAVAILABLE };
  }
}
