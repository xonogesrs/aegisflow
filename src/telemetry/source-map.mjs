// src/telemetry/source-map.mjs
//
// COST-1 — machine-readable telemetry metric source map（stage 1 audit output）.
//
// Every metric COST-1 can observe is listed with:
//   source            where the value actually comes from（file / struct field）
//   authoritative     true when the value is measured/git-derived, false when
//                     declared/derived
//   availability      AVAILABLE | PARTIAL | NOT_REPORTED at this layer
//   lifecycleBoundary which execution boundary owns the value
//   deterministic     true when repeat/restart/rebuild-stable
//   nullable          the condition under which the value is null
//   providerExposed   whether the model/provider surface reports it
//
// Audit findings（what is NOT available — never fabricated）:
//   - the execution layer runs deterministic adapters（executor =
//     "colima-container", reviewer = "deterministic-c3"）; NO LLM usage
//     metadata flows through sub-agent results（no tokens, no model id, no
//     tool-call counters）. tokenSource is therefore NOT_REPORTED and the
//     aggregate exposes reportedTokens / tokenCoverage / unknownUsageCount.

export const TELEMETRY_SOURCE_MAP_SCHEMA = "autoloop.telemetry-source-map/v1";

export const TELEMETRY_SOURCE_MAP = [
  // ── identity ─────────────────────────────────────────────────────────────
  { metric: "graphRunId", source: "graph executionId / closeout evidence", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "graph", deterministic: true, nullable: false, providerExposed: false },
  { metric: "nodeId", source: "IR phase_id", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "node", deterministic: true, nullable: false, providerExposed: false },
  { metric: "phaseExecutionId", source: "v2/phase-task-card.mjs phaseExecutionId(executionId, phaseId)", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "node", deterministic: true, nullable: false, providerExposed: false },
  { metric: "agentExecutionId", source: "subagent-contract.mjs agentExecutionIdFor / stageAgentExecutionId", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "agent", deterministic: true, nullable: "readonly phases without an envelope", providerExposed: false },
  { metric: "attempt", source: "lifecycle attempt counter / node.attempt", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "node", deterministic: true, nullable: "skipped nodes", providerExposed: false },
  { metric: "taskType", source: "phase.runtime.mode / agentRole", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "node", deterministic: true, nullable: false, providerExposed: false },
  { metric: "risk", source: "none today", authoritative: false, availability: "NOT_REPORTED", lifecycleBoundary: "node", deterministic: false, nullable: "always null until a risk classification exists", providerExposed: false },
  { metric: "cardId/cardTitle/cardType", source: "closeout config", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "card", deterministic: true, nullable: "non-closeout graphs", providerExposed: false },

  // ── timing ───────────────────────────────────────────────────────────────
  { metric: "startedAt", source: "phaseStartTimes (colima-graph-runner)", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "node", deterministic: false, nullable: "skipped/never-started nodes", providerExposed: false },
  { metric: "completedAt", source: "captureNodeResult completedAt=Date.now()", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "node", deterministic: false, nullable: "skipped nodes", providerExposed: false },
  { metric: "durationMs", source: "executor result latencyMs (colima-runtime runTask)", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "executor", deterministic: false, nullable: "executor error/no result", providerExposed: false },
  { metric: "queue/wait", source: "none today", authoritative: false, availability: "NOT_REPORTED", lifecycleBoundary: "scheduler", deterministic: false, nullable: "always null; scheduler exposes no wait stats", providerExposed: false },
  { metric: "container startup", source: "none today (runTask covers total)", authoritative: false, availability: "NOT_REPORTED", lifecycleBoundary: "executor", deterministic: false, nullable: "always null", providerExposed: false },

  // ── model cost ───────────────────────────────────────────────────────────
  { metric: "inputTokens/outputTokens/cachedInputTokens/totalTokens", source: "none — sub-agent results carry no usage", authoritative: false, availability: "NOT_REPORTED", lifecycleBoundary: "agent", deterministic: false, nullable: "always null; tokenSource=NOT_REPORTED", providerExposed: false },
  { metric: "model", source: "none — adapters are deterministic (colima-container / deterministic-c3)", authoritative: false, availability: "NOT_REPORTED", lifecycleBoundary: "agent", deterministic: false, nullable: "always null at this layer", providerExposed: false },
  { metric: "provider", source: "none", authoritative: false, availability: "NOT_REPORTED", lifecycleBoundary: "agent", deterministic: false, nullable: "always null at this layer", providerExposed: false },

  // ── tool activity ────────────────────────────────────────────────────────
  { metric: "toolCallCount", source: "none — envelope carries toolPermissions (allowed set), not actual calls", authoritative: false, availability: "NOT_REPORTED", lifecycleBoundary: "agent", deterministic: false, nullable: "always null until agents report tool use", providerExposed: false },
  { metric: "tool category", source: "toolPermissions (allowed, not actual)", authoritative: false, availability: "PARTIAL", lifecycleBoundary: "agent", deterministic: true, nullable: "read-only phases without explicit permissions", providerExposed: false },
  { metric: "tool failures/retry", source: "none today", authoritative: false, availability: "NOT_REPORTED", lifecycleBoundary: "agent", deterministic: false, nullable: "always null", providerExposed: false },

  // ── retrieval（CBM-3）────────────────────────────────────────────────────
  { metric: "retrieval invoked/state", source: "memoryContext.state (graph-context)", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "graph", deterministic: true, nullable: "memory option absent", providerExposed: false },
  { metric: "selectedCount/conflictCount", source: "memoryContext.counts / conflictGroups.length", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "graph", deterministic: true, nullable: "EMPTY_MEMORY / no memory", providerExposed: false },
  { metric: "truncated/maxRecords/maxBytes/byteCount", source: "memoryContext.truncated/limits/byteCount", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "graph", deterministic: true, nullable: "EMPTY_MEMORY", providerExposed: false },
  { metric: "retrievalDigest/storeSnapshotDigest", source: "memoryContext digests (retrieval.mjs)", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "graph", deterministic: true, nullable: "EMPTY_MEMORY", providerExposed: false },

  // ── agent / graph ────────────────────────────────────────────────────────
  { metric: "subAgentCount", source: "graph node count (agent envelope present)", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "graph", deterministic: true, nullable: false, providerExposed: false },
  { metric: "fanOut", source: "declared phase count / node count", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "graph", deterministic: true, nullable: false, providerExposed: false },
  { metric: "repairCount", source: "lifecycle transitions (repair attempts)", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "node", deterministic: true, nullable: "no repairs", providerExposed: false },
  { metric: "reviewerCount", source: "reviewer transitions (lifecycle)", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "node", deterministic: true, nullable: "unreviewed nodes", providerExposed: false },
  { metric: "finalVerdict/holdCode", source: "scheduler verdict / closeout gate", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "graph", deterministic: true, nullable: false, providerExposed: false },
  { metric: "skipped nodes", source: "scheduler.statuses skipped_due_to_dependency", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "graph", deterministic: true, nullable: "no skips", providerExposed: false },
  { metric: "cancellation/timeout/crash", source: "lifecycle transitions (timed_out/aborted) + node reason", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "node", deterministic: false, nullable: "no cancellation", providerExposed: false },

  // ── verification ─────────────────────────────────────────────────────────
  { metric: "suite identity", source: "closeout regression entries / caller-provided", authoritative: false, availability: "AVAILABLE", lifecycleBoundary: "closeout", deterministic: true, nullable: "no verification recorded", providerExposed: false },
  { metric: "test count/pass/fail", source: "test harness results (caller-provided at closeout)", authoritative: true, availability: "AVAILABLE", lifecycleBoundary: "closeout", deterministic: true, nullable: "no verification recorded", providerExposed: false },
  { metric: "verification duration", source: "caller-provided at closeout (not measured in-process)", authoritative: true, availability: "PARTIAL", lifecycleBoundary: "closeout", deterministic: false, nullable: "no verification recorded", providerExposed: false },
  { metric: "canonical/full vs targeted", source: "classifyVerification(suite name)", authoritative: false, availability: "AVAILABLE", lifecycleBoundary: "closeout", deterministic: true, nullable: false, providerExposed: false },
];

/** Return the source map（frozen copy）. */
export function telemetrySourceMap() {
  return TELEMETRY_SOURCE_MAP.map((e) => ({ ...e }));
}

/** Summary counts for the closeout evidence. */
export function sourceMapSummary() {
  const avail = TELEMETRY_SOURCE_MAP.filter((e) => e.availability === "AVAILABLE").length;
  const partial = TELEMETRY_SOURCE_MAP.filter((e) => e.availability === "PARTIAL").length;
  const notReported = TELEMETRY_SOURCE_MAP.filter((e) => e.availability === "NOT_REPORTED").length;
  return { total: TELEMETRY_SOURCE_MAP.length, available: avail, partial, notReported };
}
