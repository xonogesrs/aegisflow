// test/memory/helpers-cbm3.mjs — CBM-3 shared fixtures（deterministic）.
//
// Builds validated MemoryRecordV1 fixtures at every trust level, across
// repository/worktree/tree/path/symbol/graphRun/task/global scopes, plus
// conflict pairs and relationship bindings. Every fixture passes
// validateMemoryRecordV1（trust-gated evidence fields are filled per level）.

import { MEMORY_RECORD_SCHEMA, NOT_APPLICABLE, deriveContentHash, deriveMemoryRecordId, deriveLogicalKey } from "../../src/memory/index.mjs";

export const T = "2026-08-07T00:00:00.000Z";
export const hex64 = (c) => c.repeat(64);
export const hex40 = (c) => c.repeat(40);

// canonical repository/worktree/tree identities used by every fixture
export const REPO = hex64("1");
export const REPO_OTHER = hex64("2");
export const WT = hex64("3");
export const WT_OTHER = hex64("4");
export const TREE = hex40("5");
export const TREE_OTHER = hex40("6");
export const COMMIT = hex40("7");

export function finish(rec) {
  rec.subject.contentHash = deriveContentHash(rec.content);
  rec.recordId = deriveMemoryRecordId(rec);
  return rec;
}

/** Evidence identity blocks per trust level（hex64 strings; trust-gated）. */
export function evidenceFor(trust) {
  const e = { manifestDigest: NOT_APPLICABLE, items: [] };
  if (trust !== "RAW") e.manifestDigest = hex64("a");
  if (trust === "VERIFIED" || trust === "REVIEWED" || trust === "CONFIRMED") e.verifierResultIdentity = hex64("b");
  if (trust === "REVIEWED" || trust === "CONFIRMED") e.reviewResultIdentity = hex64("c");
  if (trust === "CONFIRMED") e.controllerRulingIdentity = hex64("d");
  return e;
}

/**
 * Base CODE record factory.
 * scopeOverrides merge into scope; defaults are repository + tree bound.
 */
export function codeRecord({
  trust = "VERIFIED",
  validity = "CURRENT",
  repo = REPO,
  worktree = null,
  tree = TREE,
  path = "src/module.mjs",
  symbol = null,
  global = false,
  statement = "module exports parseMemoryRecord",
  text = "export function parseMemoryRecord() {}",
  knowledgeKind = "FILE",
  language = "javascript",
  commit = COMMIT,
  extraScope = {},
} = {}) {
  const scope = { ...extraScope };
  if (global) scope.global = true;
  else {
    scope.repository = repo;
    if (tree) scope.tree = tree;
    if (path) scope.path = path;
    if (symbol) scope.symbol = symbol;
    if (worktree) scope.worktree = worktree;
  }
  const rec = {
    schema: MEMORY_RECORD_SCHEMA,
    recordType: "CODE",
    identity: {
      repositoryIdentity: repo,
      commitSha: commit,
      treeSha: tree ?? NOT_APPLICABLE,
      path,
      ...(worktree ? { worktreeIdentity: worktree } : {}),
      ...(symbol ? { symbol } : {}),
      knowledgeKind,
    },
    subject: { statement, contentHash: null, language },
    content: { kind: "TEXT", text },
    source: { source: "REPOSITORY", identity: hex64("d") },
    scope,
    trust,
    validity: { status: validity, ...(tree ? { validityTree: tree } : {}) },
    lifecycle: { events: [] },
    timestamps: { createdAt: T, updatedAt: T },
    evidence: evidenceFor(trust),
    security: { scanResult: "clean", ingestionSource: "test-fixture" },
    metadata: {},
  };
  return finish(rec);
}

/** EXECUTION record factory（graphRun/task bound）. */
export function executionRecord({
  trust = "VERIFIED",
  validity = "CURRENT",
  repo = REPO,
  graphRun = "run-abc",
  task = "task-1",
  resultKind = "TASK_RESULT",
  status = "PASS",
  summary = "writer PASS",
} = {}) {
  const rec = {
    schema: MEMORY_RECORD_SCHEMA,
    recordType: "EXECUTION",
    identity: {
      graphRunId: graphRun,
      taskIdentity: task,
      nodeId: "SA-W1",
      phaseExecutionId: "exec_phase",
      agentExecutionId: "agent_x",
      attempt: 0,
      executorKind: "writer-subagent",
    },
    subject: {
      resultKind,
      status,
      startedAt: T,
      completedAt: T,
      evidenceManifestDigest: hex64("e"),
      summary,
    },
    content: { kind: "STRUCTURED", data: { filesChanged: ["docs/out.md"], summary } },
    source: { source: "EXECUTION", identity: hex64("f") },
    scope: { repository: repo, graphRun, task },
    trust,
    validity: { status: validity, validityTree: NOT_APPLICABLE },
    lifecycle: { events: [] },
    timestamps: { createdAt: T, updatedAt: T },
    evidence: evidenceFor(trust),
    security: { scanResult: "clean", ingestionSource: "test-fixture" },
    metadata: {},
  };
  return finish(rec);
}

/** DECISION record factory（global or repo-scoped）. */
export function decisionRecord({
  trust = "CONFIRMED",
  validity = "CURRENT",
  repo = null,
  global = false,
  decisionId = "DEC-2026-001",
  statement = "SQLite primary store",
} = {}) {
  const scope = global ? { global: true } : { repository: repo };
  const rec = {
    schema: MEMORY_RECORD_SCHEMA,
    recordType: "DECISION",
    identity: { decisionId, decisionType: "ARCHITECTURE" },
    subject: {
      statement,
      rationale: "deterministic + zero external dep",
      alternatives: ["JSONL only", "vector"],
      status: "accepted",
      authority: "CONTROLLER",
      effectiveScope: global ? "global" : `repository:${repo}`,
    },
    content: { kind: "TEXT", text: `Use SQLite as primary memory store for ${statement}.` },
    source: { source: "CONTROLLER", identity: hex64("g") },
    scope,
    trust,
    validity: { status: validity, validityTree: NOT_APPLICABLE },
    lifecycle: { events: [] },
    timestamps: { createdAt: T, updatedAt: T },
    evidence: evidenceFor(trust),
    security: { scanResult: "clean", ingestionSource: "test-fixture" },
    metadata: {},
  };
  return finish(rec);
}

/** Build a logicalKey-conflicting pair（same identity/scope, different content）. */
export function conflictPair({ path = "src/conflict.mjs", trust = "VERIFIED" } = {}) {
  const a = codeRecord({ path, trust, statement: "version A: returns true", text: "function f() { return true; }" });
  const b = codeRecord({ path, trust, statement: "version B: returns false", text: "function f() { return false; }" });
  if (deriveLogicalKey(a) !== deriveLogicalKey(b)) throw new Error("fixture: conflict pair must share logicalKey");
  return [a, b];
}

/** Relationship row builder（sqlite memory_relationships insert-ready）. */
export function relationship({ id, recordId, targetRecordId, type }) {
  return { relationshipId: id, recordId, targetRecordId, relationshipType: type, identity: hex64("zz") };
}
