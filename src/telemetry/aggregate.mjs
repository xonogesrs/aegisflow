// src/telemetry/aggregate.mjs
//
// COST-1 — task/run aggregate（autoloop.telemetry-aggregate/v1）.
//
// Answers the run-level questions（card stage 6）: total duration, reported
// tokens, token coverage ratio, tool-call count, retrieval counts/bytes,
// sub-agent count, repair count, verification duration, final verdict.
//
// Honest cost semantics: when providers report nothing, the aggregate NEVER
// fabricates a total. It outputs:
//   reportedTokens        — sum of PROVIDER_REPORTED tokens（0 when none）
//   tokenCoverage         — reportedTokenEvents / tokenObservableEvents
//   unknownUsageCount     — tokenObservableEvents - reportedTokenEvents
//   tokenSource           — "NOT_REPORTED" when coverage is 0
// so downstream budget work sees coverage before it trusts any number.

import { TELEMETRY_AGGREGATE_SCHEMA, canonicalJson, sha256Hex } from "./contract.mjs";

export function aggregateGraphRun({ events = [], graphRunId = null } = {}) {
  const run = events.filter((e) => e?.graph?.graphRunId === graphRunId || !graphRunId);
  const runEvents = run.length ? run : events;

  const started = runEvents
    .map((e) => e.timing?.startedAt ? Date.parse(e.timing.startedAt) : null)
    .filter((v) => v !== null && !Number.isNaN(v))
    .sort((a, b) => a - b);
  const completed = runEvents
    .map((e) => e.timing?.completedAt ? Date.parse(e.timing.completedAt) : null)
    .filter((v) => v !== null && !Number.isNaN(v))
    .sort((a, b) => b - a);

  const totalDurationMs = started.length && completed.length
    ? Math.max(0, completed[0] - started[0])
    : runEvents.reduce((acc, e) => acc + (e.timing?.durationMs ?? 0), 0);

  const tokenEvents = runEvents.filter((e) => e.model && typeof e.model === "object");
  const reportedTokenEvents = tokenEvents.filter((e) => e.model.tokenSource === "PROVIDER_REPORTED");
  const reportedTokens = {
    input: reportedTokenEvents.reduce((a, e) => a + (e.model.inputTokens ?? 0), 0),
    output: reportedTokenEvents.reduce((a, e) => a + (e.model.outputTokens ?? 0), 0),
    cachedInput: reportedTokenEvents.reduce((a, e) => a + (e.model.cachedInputTokens ?? 0), 0),
    total: reportedTokenEvents.reduce((a, e) => a + (e.model.totalTokens ?? 0), 0),
  };
  const tokenCoverage = tokenEvents.length > 0 ? reportedTokenEvents.length / tokenEvents.length : 0;
  const unknownUsageCount = tokenEvents.length - reportedTokenEvents.length;

  const nodeEvents = runEvents.filter((e) => e.eventType === "node.run");
  const repairEvents = runEvents.filter((e) => e.eventType === "node.repair");
  const graphEvents = runEvents.filter((e) => e.eventType === "graph.run");
  const retrievalEvents = runEvents.filter((e) => e.eventType === "retrieval.observed" || (e.eventType === "node.run" && e.retrieval?.invoked));
  const verificationEvents = runEvents.filter((e) => e.eventType === "verification.recorded");

  const graph = graphEvents[0] ?? {};
  const agent = graph.agent ?? {};

  const retrieval = {
    invoked: retrievalEvents.length > 0,
    state: retrievalEvents[0]?.retrieval?.state ?? null,
    selectedCount: retrievalEvents.reduce((a, e) => a + (e.retrieval?.selectedCount ?? 0), 0),
    conflictCount: retrievalEvents.reduce((a, e) => a + (e.retrieval?.conflictCount ?? 0), 0),
    truncated: retrievalEvents.some((e) => e.retrieval?.truncated === true),
    byteCount: retrievalEvents.reduce((a, e) => a + (e.retrieval?.byteCount ?? 0), 0),
    maxRecords: retrievalEvents[0]?.retrieval?.maxRecords ?? null,
    maxBytes: retrievalEvents[0]?.retrieval?.maxBytes ?? null,
    retrievalDigest: retrievalEvents.find((e) => e.retrieval?.retrievalDigest)?.retrieval?.retrievalDigest ?? null,
    storeSnapshotDigest: retrievalEvents.find((e) => e.retrieval?.storeSnapshotDigest)?.retrieval?.storeSnapshotDigest ?? null,
  };

  const verification = {
    suites: verificationEvents.map((e) => e.verification?.suite).filter(Boolean),
    totalTests: verificationEvents.reduce((a, e) => a + (e.verification?.tests ?? 0), 0),
    passed: verificationEvents.reduce((a, e) => a + (e.verification?.passed ?? 0), 0),
    failed: verificationEvents.reduce((a, e) => a + (e.verification?.failed ?? 0), 0),
    durationMs: verificationEvents.reduce((a, e) => a + (e.verification?.durationMs ?? 0), 0),
  };

  const toolEvents = runEvents.filter((e) => e.tools && typeof e.tools === "object");
  const reportedToolEvents = toolEvents.filter((e) => e.tools.toolCallSource === "REPORTED");
  const reportedToolCalls = reportedToolEvents.reduce((a, e) => a + (e.tools.toolCallCount ?? 0), 0);
  const reportedToolFailures = reportedToolEvents.reduce((a, e) => a + (e.tools.failures ?? 0), 0);
  const toolCallCoverage = toolEvents.length > 0 ? reportedToolEvents.length / toolEvents.length : 0;
  const unknownToolUsageCount = toolEvents.length - reportedToolEvents.length;

  const aggregate = {
    schema: TELEMETRY_AGGREGATE_SCHEMA,
    graphRunId: graph.graph?.graphRunId ?? graphRunId ?? null,
    cardId: graph.graph?.cardId ?? null,
    finalVerdict: agent.finalVerdict ?? graph.agent?.finalVerdict ?? null,
    holdCode: agent.holdCode ?? null,
    totalDurationMs,
    nodeCount: nodeEvents.length,
    subAgentCount: agent.subAgentCount ?? nodeEvents.filter((e) => e.identity?.agentExecutionId).length,
    fanOut: agent.fanOut ?? nodeEvents.length,
    attempts: nodeEvents.reduce((a, e) => a + (e.identity?.attempt ?? 0), 0) + nodeEvents.length,
    repairCount: repairEvents.length,
    reviewerCount: agent.reviewerCount ?? nodeEvents.filter((e) => e.identity?.stage === "reviewer").length,
    skippedNodes: agent.skippedNodes ?? 0,
    reportedTokens,
    tokenCoverage: Math.round(tokenCoverage * 1000) / 1000,
    unknownUsageCount,
    tokenSource: reportedTokenEvents.length === 0 ? "NOT_REPORTED" : "PROVIDER_REPORTED",
    // Honest tool-call semantics（same as tokens）: when no tool-use report
    // exists, toolCallCount is null and the coverage trio carries the truth.
    // 0 is NEVER emitted for an unknown（"unknown" ≠ "measured zero"）.
    toolCallSource: reportedToolEvents.length === 0 ? "NOT_REPORTED" : "REPORTED",
    toolCallCount: reportedToolEvents.length === 0 ? null : reportedToolCalls,
    reportedToolCalls,
    toolCallCoverage: Math.round(toolCallCoverage * 1000) / 1000,
    unknownToolUsageCount,
    toolFailures: reportedToolEvents.length === 0 ? null : reportedToolFailures,
    retrieval,
    verification,
    security: { sensitiveDataDetected: runEvents.some((e) => e.security?.sensitiveDataDetected === true) },
    eventCount: runEvents.length,
  };
  aggregate.aggregateIdentity = sha256Hex(canonicalJson(aggregate));
  return aggregate;
}
