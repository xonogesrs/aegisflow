// src/telemetry/contract.mjs
//
// COST-1 — Cost-Aware Telemetry Foundation: contract v1.
//
// autoloop.telemetry-event/v1 — a bounded, allowlisted, identity-bound
// observation record. It stores ONLY identities + counters + timings +
// bounded structured metadata（never prompts, model responses, memory
// bodies, source blobs, stdout/stderr, secrets, or user data）.
//
// Token usage policy（measure-first, never fabricate）:
//   - tokenSource "NOT_REPORTED" is the ONLY legal value while the
//     execution layer exposes no provider usage metadata（audit: executor =
//     "colima-container", reviewer = "deterministic-c3"; sub-agent results
//     carry no token/tool counters）. Derived estimates are NOT recorded as
//     real tokens — aggregates surface reportedTokens / tokenCoverage /
//     unknownUsageCount instead.
//
// Contract invariants:
//   - allowlist schema: unknown fields / versions fail validation（an
//     unrecognised field can never smuggle sensitive data into the store）
//   - deterministic eventId: sha256(canonical({graphRunId, eventType,
//     nodeId, attempt, sequence})) — reruns of the same graph produce the
//     same event stream identity where inputs are identical
//   - telemetry is NEVER a task authority: recording failures surface as
//     TELEMETRY_UNAVAILABLE / TELEMETRY_STORE_INVALID and cannot change any
//     task semantic.

import { createHash } from "node:crypto";

export const TELEMETRY_EVENT_SCHEMA = "autoloop.telemetry-event/v1";
export const TELEMETRY_AGGREGATE_SCHEMA = "autoloop.telemetry-aggregate/v1";
export const TELEMETRY_BUDGET_SCHEMA = "autoloop.telemetry-budget/v1";

export const TELEMETRY_EVENT_SCHEMA_VERSION = 1;
export const TELEMETRY_STORE_SCHEMA = "autoloop.telemetry-store/v1";
export const TELEMETRY_STORE_SCHEMA_VERSION = 1;

export const TELEMETRY_HOLD_CODES = Object.freeze({
  STORE_INVALID: "TELEMETRY_STORE_INVALID",
  UNAVAILABLE: "TELEMETRY_UNAVAILABLE",
  EVENT_INVALID: "TELEMETRY_EVENT_INVALID",
  SECRET_DETECTED: "TELEMETRY_SECRET_DETECTED",
  BUDGET_INVALID: "TELEMETRY_BUDGET_INVALID",
});

// Event types（explicit enum — unknown eventType fails validation）.
export const TELEMETRY_EVENT_TYPES = Object.freeze([
  "graph.run",
  "node.run",
  "node.repair",
  "graph.closeout",
  "retrieval.observed",
  "verification.recorded",
  "telemetry.availability",
  "telemetry.overhead",
  // CBM-4: governed memory write-back observation（counters + identities
  // ONLY — never memory content）; additive, existing semantics unchanged.
  "memory.writeback",
]);

export const TOKEN_SOURCES = Object.freeze(["NOT_REPORTED", "PROVIDER_REPORTED"]);
// No "DERIVED_ESTIMATE": without a provider report the ONLY honest source is
// NOT_REPORTED. Estimates would be fabricated cost data（card stage 2）.

export const VERIFICATION_CLASSIFICATIONS = Object.freeze(["canonical", "full", "targeted", "focused"]);

export const TELEMETRY_STORE_STATUSES = Object.freeze(["AVAILABLE", "UNAVAILABLE", "INVALID"]);

export class TelemetryContractError extends Error {
  constructor(reasons) {
    super(`telemetry_contract_violation: ${reasons.join("; ")}`);
    this.name = "TelemetryContractError";
    this.reasons = reasons;
  }
}

export function sha256Hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

/** Canonical（sorted-key）JSON — deterministic identity base. */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Deterministic event id（repeat/restart/rebuild invariant where inputs are
 * identical）. sequence must be deterministic for a given graph run（node
 * order = IR declaration order; transitions in scheduler order）.
 */
export function telemetryEventId({ graphRunId, eventType, nodeId = null, attempt = null, sequence = 0 }) {
  return sha256Hex(canonicalJson({ graphRunId, eventType, nodeId, attempt, sequence })).slice(0, 16);
}

/** Build a fresh, fully-allowlisted event skeleton（all optional fields null）. */
export function createTelemetryEvent({ graphRunId, eventType, sequence = 0, occurredAt = null }) {
  if (!graphRunId || !TELEMETRY_EVENT_TYPES.includes(eventType)) {
    throw new TelemetryContractError([`graphRunId_required_or_unknown_eventType:${String(eventType)}`]);
  }
  return {
    schema: TELEMETRY_EVENT_SCHEMA,
    schemaVersion: TELEMETRY_EVENT_SCHEMA_VERSION,
    eventId: null, // filled by validate/build with the deterministic id
    eventType,
    sequence,
    occurredAt: occurredAt ?? new Date().toISOString(),
    graph: {
      graphRunId,
      cardId: null,
      cardTitle: null,
      cardType: null,
    },
    identity: {
      nodeId: null,
      phaseExecutionId: null,
      agentExecutionId: null,
      attempt: null,
      stage: null,
      taskType: null,
      risk: null, // nullable: no risk classification flows today
    },
    timing: {
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
    // Model/provider usage: audit shows the execution layer reports NO LLM
    // usage metadata — model/provider stay null and tokenSource is
    // NOT_REPORTED until a real provider surface exposes them.
    model: {
      model: null,
      provider: null,
      tokenSource: "NOT_REPORTED",
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      totalTokens: null,
    },
    tools: {
      toolCallCount: null,
      toolCategories: [],
      failures: null,
      // Honest unknown semantics（same principle as tokenSource）: without a
      // real tool-use report the ONLY legal value is NOT_REPORTED with null
      // counters — "unknown" must never be presented as a measured 0.
      toolCallSource: "NOT_REPORTED",
    },
    retrieval: {
      invoked: false,
      state: null, // AVAILABLE | EMPTY_MEMORY | INVALID | not-applicable
      selectedCount: null,
      conflictCount: null,
      truncated: null,
      maxRecords: null,
      maxBytes: null,
      byteCount: null,
      retrievalDigest: null,
      storeSnapshotDigest: null,
    },
    agent: {
      subAgentCount: null,
      fanOut: null,
      attempts: null,
      repairCount: null,
      reviewerCount: null,
      skippedNodes: null,
      finalVerdict: null,
      holdCode: null,
    },
    // DE-2 D7 — recovery provenance（COST-1 replay awareness）: distinguishes
    // original execution / retry / resume / replay / recovered completion /
    // duplicate-suppressed operation. Null when never recovered.
    recovery: {
      executionAttempt: null,
      recoveryGeneration: null,
      replayOf: null,
      resumed: null,
      recovered: null,
      duplicateSuppressed: null,
    },
    verification: {
      suite: null,
      tests: null,
      passed: null,
      failed: null,
      durationMs: null,
      classification: null,
    },
    // CBM-4 write-back observation（counters + identities; never content）
    writeback: {
      attemptedCount: null,
      acceptedCount: null,
      rejectedCount: null,
      duplicateCount: null,
      conflictCount: null,
      recordsWritten: null,
      bytesWritten: null,
      durationMs: null,
      candidateType: null,
      resultingTrust: null,
      evidenceIdentityDigest: null,
      memoryRecordIdentity: null,
      failureCode: null,
    },
    security: {
      sensitiveDataDetected: false,
    },
  };
}

const NON_NULL_STRING_FIELDS = new Set([
  "schema", "eventType", "occurredAt",
]);
const NULLABLE_STRING_FIELDS = new Set([
  "cardId", "cardTitle", "cardType", "nodeId", "phaseExecutionId", "agentExecutionId",
  "stage", "taskType", "risk", "startedAt", "completedAt", "model", "provider",
  "tokenSource", "state", "retrievalDigest", "storeSnapshotDigest", "suite",
  "classification", "finalVerdict", "holdCode",
]);
const NULLABLE_NUMBER_FIELDS = new Set([
  "sequence", "attempt", "durationMs", "inputTokens", "outputTokens",
  "cachedInputTokens", "totalTokens", "toolCallCount", "failures",
  "selectedCount", "conflictCount", "maxRecords", "maxBytes", "byteCount",
  "subAgentCount", "fanOut", "attempts", "repairCount", "reviewerCount",
  "skippedNodes", "tests", "passed", "failed",
]);

function checkObjectShape(value, key, allowlist) {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object" || Array.isArray(value)) return [`${key}_must_be_object`];
  const errors = [];
  for (const k of Object.keys(value)) {
    if (!allowlist.has(k)) errors.push(`${key}_unknown_field:${k}`);
  }
  return errors;
}

function checkLeaf(value, key) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" && NON_NULL_STRING_FIELDS.has(key)) return [];
  if (typeof value === "string" && NULLABLE_STRING_FIELDS.has(key)) return [];
  if (typeof value === "number" && Number.isFinite(value) && NULLABLE_NUMBER_FIELDS.has(key)) return [];
  if (typeof value === "boolean" && ["invoked", "truncated", "sensitiveDataDetected"].includes(key)) return [];
  if (Array.isArray(value) && ["toolCategories", "excludedSummary"].includes(key)) return [];
  return [`${key}_invalid_type_or_not_in_allowlist`];
}

/**
 * Validate a telemetry event against the allowlist contract.
 * Unknown fields / versions / malformed identities FAIL CLOSED — an
 * unrecognised field can never carry data into the store.
 */
export function validateTelemetryEventV1(event) {
  const errors = [];
  if (!event || typeof event !== "object") return { valid: false, errors: ["event_missing"] };
  // top-level allowlist: any unrecognised top-level field fails closed
  errors.push(...checkObjectShape(event, "event", new Set([
    "schema", "schemaVersion", "eventId", "eventType", "sequence", "occurredAt",
    "graph", "identity", "timing", "model", "tools", "retrieval", "agent", "recovery", "verification", "writeback", "security",
    // TA-2（X）: admission quality telemetry（admission_id / profile / size /
    // risk + overkill / under-classification inputs）.
    "admission",
  ])));
  if (event.schema !== TELEMETRY_EVENT_SCHEMA) errors.push(`schema_mismatch:${String(event.schema)}`);
  if (event.schemaVersion !== TELEMETRY_EVENT_SCHEMA_VERSION) errors.push(`schemaVersion_mismatch:${String(event.schemaVersion)}`);
  if (!TELEMETRY_EVENT_TYPES.includes(event.eventType)) errors.push(`unknown_eventType:${String(event.eventType)}`);
  if (typeof event.sequence !== "number" || !Number.isInteger(event.sequence) || event.sequence < 0) errors.push("sequence_invalid");
  if (typeof event.occurredAt !== "string" || Number.isNaN(Date.parse(event.occurredAt))) errors.push("occurredAt_invalid");

  const graph = event.graph ?? null;
  if (!graph || typeof graph.graphRunId !== "string" || graph.graphRunId.length === 0) errors.push("graphRunId_required");
  errors.push(...checkObjectShape(graph, "graph", new Set(["graphRunId", "cardId", "cardTitle", "cardType"])));
  for (const k of ["cardId", "cardTitle", "cardType"]) {
    if (graph?.[k] !== null && graph?.[k] !== undefined && typeof graph[k] !== "string") errors.push(`graph_${k}_invalid`);
  }

  const id = event.identity ?? null;
  if (!id) errors.push("identity_required");
  errors.push(...checkObjectShape(id, "identity", new Set(["nodeId", "phaseExecutionId", "agentExecutionId", "attempt", "stage", "taskType", "risk"])));
  if (id) {
    if (id.attempt !== null && id.attempt !== undefined && (!Number.isInteger(id.attempt) || id.attempt < 0)) errors.push("identity_attempt_invalid");
  }

  const timing = event.timing ?? null;
  errors.push(...checkObjectShape(timing, "timing", new Set(["startedAt", "completedAt", "durationMs"])));

  const model = event.model ?? null;
  errors.push(...checkObjectShape(model, "model", new Set(["model", "provider", "tokenSource", "inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"])));
  if (model) {
    if (model.tokenSource !== "NOT_REPORTED" && model.tokenSource !== "PROVIDER_REPORTED") {
      errors.push(`model_tokenSource_invalid:${String(model.tokenSource)}`);
    }
    // hard rule: if the source is NOT_REPORTED, token counters MUST be null
    if (model.tokenSource === "NOT_REPORTED") {
      for (const k of ["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"]) {
        if (model[k] !== null && model[k] !== undefined) errors.push(`model_${k}_must_be_null_when_NOT_REPORTED`);
      }
    }
    for (const k of ["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"]) {
      if (model[k] !== null && model[k] !== undefined && (!Number.isInteger(model[k]) || model[k] < 0)) errors.push(`model_${k}_invalid`);
    }
  }

  const tools = event.tools ?? null;
  errors.push(...checkObjectShape(tools, "tools", new Set(["toolCallCount", "toolCategories", "failures", "toolCallSource"])));
  if (tools) {
    if (tools.toolCallSource !== "NOT_REPORTED" && tools.toolCallSource !== "REPORTED") {
      errors.push(`tools_toolCallSource_invalid:${String(tools.toolCallSource)}`);
    }
    // hard rule: NOT_REPORTED tool usage -> counters MUST be null（never a 0
    // that could be read as "measured zero calls"）
    if (tools.toolCallSource === "NOT_REPORTED") {
      for (const k of ["toolCallCount", "failures"]) {
        if (tools[k] !== null && tools[k] !== undefined) errors.push(`tools_${k}_must_be_null_when_NOT_REPORTED`);
      }
    }
    if (tools.toolCallCount !== null && tools.toolCallCount !== undefined && (!Number.isInteger(tools.toolCallCount) || tools.toolCallCount < 0)) errors.push("tools_toolCallCount_invalid");
    if (tools.failures !== null && tools.failures !== undefined && (!Number.isInteger(tools.failures) || tools.failures < 0)) errors.push("tools_failures_invalid");
    if (!Array.isArray(tools.toolCategories)) errors.push("tools_toolCategories_must_be_array");
    else for (const c of tools.toolCategories) if (typeof c !== "string") errors.push("tools_toolCategories_string_only");
  }

  const retr = event.retrieval ?? null;
  errors.push(...checkObjectShape(retr, "retrieval", new Set(["invoked", "state", "selectedCount", "conflictCount", "truncated", "maxRecords", "maxBytes", "byteCount", "retrievalDigest", "storeSnapshotDigest"])));
  if (retr && typeof retr.invoked !== "boolean") errors.push("retrieval_invoked_must_be_boolean");

  const agent = event.agent ?? null;
  errors.push(...checkObjectShape(agent, "agent", new Set(["subAgentCount", "fanOut", "attempts", "repairCount", "reviewerCount", "skippedNodes", "finalVerdict", "holdCode"])));

  // TA-2（X）admission quality allowlist.
  const admission = event.admission ?? null;
  errors.push(...checkObjectShape(admission, "admission", new Set(["admissionId", "size", "risk", "profile", "fastPath", "repairBudget", "escalationCount", "underClassified", "externalReviewRequired"])));
  if (admission) {
    if (admission.admissionId !== null && admission.admissionId !== undefined && typeof admission.admissionId !== "string") errors.push("admission_admissionId_invalid");
    if (admission.fastPath !== null && admission.fastPath !== undefined && typeof admission.fastPath !== "boolean") errors.push("admission_fastPath_invalid");
    if (admission.repairBudget !== null && admission.repairBudget !== undefined && !Number.isInteger(admission.repairBudget)) errors.push("admission_repairBudget_invalid");
    if (admission.escalationCount !== null && admission.escalationCount !== undefined && !Number.isInteger(admission.escalationCount)) errors.push("admission_escalationCount_invalid");
    if (admission.underClassified !== null && admission.underClassified !== undefined && typeof admission.underClassified !== "boolean") errors.push("admission_underClassified_invalid");
    if (admission.externalReviewRequired !== null && admission.externalReviewRequired !== undefined && typeof admission.externalReviewRequired !== "boolean") errors.push("admission_externalReviewRequired_invalid");
  }

  // DE-2 D7 recovery provenance allowlist
  const recovery = event.recovery ?? null;
  errors.push(...checkObjectShape(recovery, "recovery", new Set(["executionAttempt", "recoveryGeneration", "replayOf", "resumed", "recovered", "duplicateSuppressed"])));
  if (recovery) {
    if (recovery.executionAttempt !== null && recovery.executionAttempt !== undefined && (!Number.isInteger(recovery.executionAttempt) || recovery.executionAttempt < 0)) errors.push("recovery_executionAttempt_invalid");
    if (recovery.recoveryGeneration !== null && recovery.recoveryGeneration !== undefined && (!Number.isInteger(recovery.recoveryGeneration) || recovery.recoveryGeneration < 0)) errors.push("recovery_recoveryGeneration_invalid");
    if (recovery.duplicateSuppressed !== null && recovery.duplicateSuppressed !== undefined && (!Number.isInteger(recovery.duplicateSuppressed) || recovery.duplicateSuppressed < 0)) errors.push("recovery_duplicateSuppressed_invalid");
    if (recovery.replayOf !== null && recovery.replayOf !== undefined && typeof recovery.replayOf !== "string") errors.push("recovery_replayOf_invalid");
    for (const k of ["resumed", "recovered"]) {
      if (recovery[k] !== null && recovery[k] !== undefined && typeof recovery[k] !== "boolean") errors.push(`recovery_${k}_invalid`);
    }
  }
  if (agent && agent.finalVerdict !== null && agent.finalVerdict !== undefined && !["PASS", "HOLD", "REPAIR", "FAILED", "NOT_RECORDED", "SKIPPED_DUE_TO_DEPENDENCY"].includes(agent.finalVerdict)) {
    errors.push(`agent_finalVerdict_invalid:${String(agent.finalVerdict)}`);
  }

  const vf = event.verification ?? null;
  errors.push(...checkObjectShape(vf, "verification", new Set(["suite", "tests", "passed", "failed", "durationMs", "classification"])));

  const wb = event.writeback ?? null;
  errors.push(...checkObjectShape(wb, "writeback", new Set([
    "attemptedCount", "acceptedCount", "rejectedCount", "duplicateCount", "conflictCount",
    "recordsWritten", "bytesWritten", "durationMs", "candidateType", "resultingTrust",
    "evidenceIdentityDigest", "memoryRecordIdentity", "failureCode",
  ])));
  if (wb) {
    for (const k of ["attemptedCount", "acceptedCount", "rejectedCount", "duplicateCount", "conflictCount", "recordsWritten", "bytesWritten", "durationMs"]) {
      if (wb[k] !== null && wb[k] !== undefined && (!Number.isInteger(wb[k]) || wb[k] < 0)) errors.push(`writeback_${k}_invalid`);
    }
    if (wb.candidateType !== null && wb.candidateType !== undefined && !["EXECUTION", "CODE", "DECISION"].includes(wb.candidateType)) errors.push(`writeback_candidateType_invalid:${String(wb.candidateType)}`);
    if (wb.resultingTrust !== null && wb.resultingTrust !== undefined && !["RAW", "UNVERIFIED", "VERIFIED", "REVIEWED", "CONFIRMED"].includes(wb.resultingTrust)) errors.push(`writeback_resultingTrust_invalid:${String(wb.resultingTrust)}`);
  }
  if (vf && vf.classification !== null && vf.classification !== undefined && !VERIFICATION_CLASSIFICATIONS.includes(vf.classification)) {
    errors.push(`verification_classification_invalid:${String(vf.classification)}`);
  }

  const sec = event.security ?? null;
  if (!sec || typeof sec.sensitiveDataDetected !== "boolean" || sec.sensitiveDataDetected !== false) {
    errors.push("security_sensitiveDataDetected_must_be_false");
  }

  // security allowlist: prompt/response/stdout/body fields are NOT part of
  // the schema — presence of such fields fails validation（defensive double
  // check beyond shape allowlists）.
  const banned = ["prompt", "response", "stdout", "stderr", "body", "content", "secret", "password", "tokenValue"];
  const flat = canonicalJson(event);
  for (const b of banned) {
    if (flat.includes(`"${b}":`) || flat.includes(`"${b}_`)) errors.push(`banned_field_present:${b}`);
  }

  if (errors.length === 0) {
    return { valid: true, errors: [], event: { ...event, eventId: telemetryEventId({ graphRunId: graph.graphRunId, eventType: event.eventType, nodeId: id?.nodeId ?? null, attempt: id?.attempt ?? null, sequence: event.sequence }) } };
  }
  return { valid: false, errors };
}
