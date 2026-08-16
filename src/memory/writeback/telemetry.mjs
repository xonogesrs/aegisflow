// src/memory/writeback/telemetry.mjs
//
// CBM-4 — Stage 10: memory.write-back telemetry（COST-1 substrate）.
//
// Counters + identities + digests ONLY — memory content is NEVER copied into
// telemetry. Unknown token/tool usage keeps the COST-1 honest-unknown
// semantics（NOT_REPORTED, never measured 0）.

import { createTelemetryEvent } from "../../telemetry/contract.mjs";

/**
 * Build a memory.writeback telemetry event from gate outcomes.
 * @param {object} o
 * @param {string} o.graphRunId
 * @param {object[]} o.outcomes - gate results（status per candidate）
 * @param {number} [o.bytesWritten]
 * @param {number} [o.durationMs]
 */
export function buildWritebackTelemetryEvent({ graphRunId, outcomes = [], bytesWritten = 0, durationMs = 0 }) {
  const ev = createTelemetryEvent({ graphRunId, eventType: "memory.writeback", sequence: 0 });
  ev.identity.taskType = "writeback";
  ev.timing.durationMs = durationMs;
  const statusCount = (prefix) => outcomes.filter((o) => o.status?.startsWith(prefix)).length;
  const accepted = outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED");
  ev.writeback = {
    attemptedCount: outcomes.length,
    acceptedCount: statusCount("WRITEBACK_ACCEPTED"),
    rejectedCount: statusCount("WRITEBACK_REJECTED") + statusCount("WRITEBACK_AUTHORITY_INSUFFICIENT") + statusCount("WRITEBACK_EVIDENCE_INVALID"),
    duplicateCount: statusCount("WRITEBACK_DUPLICATE"),
    conflictCount: statusCount("WRITEBACK_CONFLICT"),
    recordsWritten: accepted.length,
    bytesWritten,
    durationMs,
    candidateType: accepted[0]?.candidateType ?? null,
    resultingTrust: accepted[0]?.resultingTrust ?? null,
    evidenceIdentityDigest: accepted[0]?.evidenceIdentityDigest ?? null,
    memoryRecordIdentity: accepted[0]?.recordId ?? null,
    failureCode: outcomes.find((o) => o.status !== "WRITEBACK_ACCEPTED" && o.status !== "WRITEBACK_DUPLICATE")?.status ?? null,
  };
  return ev;
}

/**
 * Append memory.writeback telemetry events（best-effort; NEVER throws and
 * NEVER affects write-back semantics — a broken telemetry store only means
 * the write-back itself is not observed）.
 */
export function recordWritebackTelemetry({ telemetryStore, graphRunId, outcomes = [], bytesWritten = 0, durationMs = 0 }) {
  if (!telemetryStore || typeof telemetryStore.append !== "function") return { ok: false, reason: "TELEMETRY_UNAVAILABLE" };
  try {
    const ev = buildWritebackTelemetryEvent({ graphRunId, outcomes, bytesWritten, durationMs });
    telemetryStore.append(ev);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.code ?? "TELEMETRY_UNAVAILABLE" };
  }
}
