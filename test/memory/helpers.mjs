// test/memory/helpers.mjs — CBM-2 shared fixtures（deterministic）.

import { MEMORY_RECORD_SCHEMA, NOT_APPLICABLE, deriveContentHash, deriveMemoryRecordId } from "../../src/memory/index.mjs";

const T = "2026-08-07T00:00:00.000Z";
export const hex64 = (c) => c.repeat(64);
export const hex40 = (c) => c.repeat(40);

export function finish(rec) {
  rec.subject.contentHash = deriveContentHash(rec.content);
  rec.recordId = deriveMemoryRecordId(rec);
  return rec;
}

export function baseCodeRecord(overrides = {}) {
  const rec = {
    schema: MEMORY_RECORD_SCHEMA,
    recordType: "CODE",
    identity: { repositoryIdentity: hex64("a"), commitSha: hex40("b"), treeSha: hex40("c"), path: "src/module.mjs", knowledgeKind: "FILE" },
    subject: { statement: "module exports parseMemoryRecord", contentHash: null, language: "javascript" },
    content: { kind: "TEXT", text: "export function parseMemoryRecord() {}" },
    source: { source: "REPOSITORY", identity: hex64("d") },
    scope: { repository: hex64("a"), tree: hex40("c"), path: "src/module.mjs" },
    trust: "RAW",
    validity: { status: "CURRENT", validityTree: hex40("c") },
    lifecycle: { events: [] },
    timestamps: { createdAt: T, updatedAt: T },
    evidence: { manifestDigest: NOT_APPLICABLE, items: [] },
    security: { scanResult: "clean", ingestionSource: "test-fixture" },
    metadata: {},
  };
  return finish({ ...rec, ...overrides });
}

export function baseExecutionRecord(overrides = {}) {
  const rec = {
    schema: MEMORY_RECORD_SCHEMA,
    recordType: "EXECUTION",
    identity: { graphRunId: "run-abc123", taskIdentity: "task-1", nodeId: "SA-W1", phaseExecutionId: "exec_phase", agentExecutionId: "agent_x", attempt: 0, executorKind: "writer-subagent" },
    subject: { resultKind: "TASK_RESULT", status: "PASS", startedAt: T, completedAt: T, evidenceManifestDigest: hex64("e"), summary: "writer PASS" },
    content: { kind: "STRUCTURED", data: { filesChanged: ["docs/out.md"] } },
    source: { source: "EXECUTION", identity: hex64("f") },
    scope: { graphRun: "run-abc123", task: "task-1" },
    trust: "RAW",
    validity: { status: "CURRENT", validityTree: NOT_APPLICABLE },
    lifecycle: { events: [] },
    timestamps: { createdAt: T, updatedAt: T },
    evidence: { manifestDigest: NOT_APPLICABLE, items: [] },
    security: { scanResult: "clean", ingestionSource: "test-fixture" },
    metadata: {},
  };
  return finish({ ...rec, ...overrides });
}

export function baseDecisionRecord(overrides = {}) {
  const rec = {
    schema: MEMORY_RECORD_SCHEMA,
    recordType: "DECISION",
    identity: { decisionId: "DEC-2026-001", decisionType: "ARCHITECTURE" },
    subject: { statement: "SQLite primary store", rationale: "deterministic + zero external dep", alternatives: ["JSONL only", "vector"], status: "accepted", authority: "CONTROLLER", effectiveScope: "repository:autoloop" },
    content: { kind: "TEXT", text: "Use SQLite (node:sqlite) as the primary memory store." },
    source: { source: "CONTROLLER", identity: hex64("g") },
    scope: { repository: hex64("a") },
    trust: "CONFIRMED",
    validity: { status: "CURRENT", validityTree: NOT_APPLICABLE },
    lifecycle: { events: [] },
    timestamps: { createdAt: T, updatedAt: T },
    evidence: { manifestDigest: hex64("a"), verifierResultIdentity: hex64("b"), reviewResultIdentity: hex64("c"), controllerRulingIdentity: hex64("d"), items: [] },
    security: { scanResult: "clean", ingestionSource: "test-fixture" },
    metadata: {},
  };
  return finish({ ...rec, ...overrides });
}
