#!/usr/bin/env node
// scripts/autoloop-memory-query.mjs
//
// AUTOLOOP-CBM-LIVE-INTEGRATION-1 — Phase 1: the harness-facing query surface.
//
// A minimal machine-readable CLI over the EXISTING CBM retrieval engine
// (LocalMemoryStore -> retrieveMemory). It does NOT duplicate ranking,
// identity, store, or eligibility logic — it resolves the repository
// identity (the same resolveRepositoryIdentity the Graph provider uses),
// validates an autoloop.memory-query/v1 query, and returns the deterministic
// retrieval result as structured JSON, plus a check-at-use freshness block.
//
// Output schema: autoloop.memory-query/v1
//   {
//     schema, state: "AVAILABLE"|"EMPTY_MEMORY"|"INVALID", reason,
//     repository: { repositoryIdentity, worktreeIdentity, commitSha, treeSha,
//                   branch, canonicalPath, remote },
//     query: <normalized query>|null,
//     retrieval: <autoloop.memory-retrieval-result/v1>|null,
//     freshness: { indexed, currentTree, currentCommit, indexedTrees, stale }
//   }
//
// Exit codes:
//   0  success (AVAILABLE or EMPTY_MEMORY — same governed semantics as the
//      Graph provider; EMPTY_MEMORY is a valid, explicit answer, never an
//      error)
//   2  INVALID / fail-closed (corrupt or irreconcilable store,
//      MEMORY_STORE_INVALID, or an invalid query) — never silently treated
//      as empty memory
//   3  usage error
//
// Usage:
//   node scripts/autoloop-memory-query.mjs --repo <path> [--terms "t1 t2"]
//     [--path <p>] [--symbol <s>] [--record-types CODE,EXECUTION,DECISION]
//     [--trust-floor RAW|UNVERIFIED|VERIFIED|REVIEWED|CONFIRMED]
//     [--validity CURRENT|INCLUDE_STALE|ALL] [--max-records N]
//     [--state-root <dir>] [--json]
//
// Repository isolation is preserved: the identity is derived from the
// authoritative repository facts of `--repo` (remote + canonical path) and
// records of any other repository identity are hard-excluded by the
// retrieval eligibility pipeline.

import { parseArgs } from "node:util";
import { LocalMemoryStore, resolveRepositoryIdentity, MemoryStoreInvalidError } from "../src/memory/local-store.mjs";
import {
  MEMORY_QUERY_SCHEMA,
  validateMemoryQueryV1,
  defaultQuery,
  DEFAULT_TRUST_FLOOR,
  MAX_RECORDS_BOUND,
  MAX_BYTES_BOUND,
} from "../src/memory/query-schema.mjs";

const OPTIONS = {
  repo: { type: "string" },
  terms: { type: "string" },
  path: { type: "string" },
  symbol: { type: "string" },
  "record-types": { type: "string" },
  "trust-floor": { type: "string" },
  validity: { type: "string" },
  "max-records": { type: "string" },
  "state-root": { type: "string" },
  json: { type: "boolean", default: false },
};

function usageError(message) {
  console.error(`usage error: ${message}`);
  console.error("node scripts/autoloop-memory-query.mjs --repo <path> [--terms \"t1 t2\"] [--path <p>] [--symbol <s>] [--record-types CODE,EXECUTION,DECISION] [--trust-floor VERIFIED] [--validity CURRENT] [--max-records N] [--state-root <dir>] [--json]");
  return 3;
}

/** Check-at-use freshness: does the index cover the CURRENT repository tree? */
function computeFreshness(store, repository) {
  const enumQuery = validateMemoryQueryV1({
    schema: MEMORY_QUERY_SCHEMA,
    context: { repository: repository.repositoryIdentity, worktree: null, commit: null, tree: null, graphRunId: null, task: null },
    recordTypes: null,
    trustFloor: "RAW",
    validityPolicy: "ALL",
    conflictPolicy: "SURFACE",
    limits: { maxRecords: MAX_RECORDS_BOUND, maxBytes: MAX_BYTES_BOUND },
  });
  if (!enumQuery.valid) {
    throw new MemoryStoreInvalidError("FRESHNESS_ENUM_INVALID", `freshness enumeration query invalid: ${enumQuery.errors.join(";")}`);
  }
  const r = store.query(enumQuery.query);
  const indexedTrees = [...new Set(r.selectedRecords.map((rec) => rec.scope?.tree).filter(Boolean))].sort();
  const indexed = indexedTrees.length > 0;
  return {
    indexed,
    currentTree: repository.treeSha ?? null,
    currentCommit: repository.commitSha ?? null,
    indexedTrees,
    // stale only when an index exists but does not cover the current tree;
    // records bound to an older tree are additionally excluded at retrieval
    // time by the tree-baseline validity check (never labeled current).
    stale: indexed ? !indexedTrees.includes(repository.treeSha) : null,
  };
}

function buildQuery(repository, values) {
  const q = defaultQuery();
  q.context.repository = repository.repositoryIdentity;
  q.context.worktree = repository.worktreeIdentity;
  q.context.commit = repository.commitSha;
  q.context.tree = repository.treeSha;
  if (values.terms !== undefined) q.terms = values.terms;
  if (values.path !== undefined) q.path = values.path;
  if (values.symbol !== undefined) q.symbol = values.symbol;
  if (values["record-types"] !== undefined) {
    q.recordTypes = values["record-types"].split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  if (values["trust-floor"] !== undefined) q.trustFloor = values["trust-floor"];
  if (values.validity !== undefined) q.validityPolicy = values.validity;
  if (values["max-records"] !== undefined) {
    const n = Number(values["max-records"]);
    if (!Number.isInteger(n) || n < 1 || n > MAX_RECORDS_BOUND) throw new Error(`max-records out of bounds (1..${MAX_RECORDS_BOUND})`);
    q.limits.maxRecords = n;
  }
  return q;
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: OPTIONS, allowPositionals: false, strict: true }));
  } catch (e) {
    return usageError(e.message);
  }
  if (!values.repo) return usageError("--repo is required");
  if (values["trust-floor"] !== undefined && !["RAW", "UNVERIFIED", "VERIFIED", "REVIEWED", "CONFIRMED"].includes(values["trust-floor"])) {
    return usageError(`invalid --trust-floor ${values["trust-floor"]}`);
  }
  if (values.validity !== undefined && !["CURRENT", "INCLUDE_STALE", "ALL"].includes(values.validity)) {
    return usageError(`invalid --validity ${values.validity}`);
  }

  let repository;
  try {
    repository = resolveRepositoryIdentity(values.repo);
  } catch (e) {
    console.error(`identity resolution failed: ${String(e?.message ?? e)}`);
    return 3;
  }

  const store = new LocalMemoryStore({ stateRoot: values["state-root"] ?? null, log: { info() {}, warn() {}, error() {} } });
  if (!store.exists()) {
    emit({
      schema: MEMORY_QUERY_SCHEMA,
      state: "EMPTY_MEMORY",
      reason: null,
      repository,
      query: null,
      retrieval: null,
      freshness: { indexed: false, currentTree: repository.treeSha ?? null, currentCommit: repository.commitSha ?? null, indexedTrees: [], stale: null },
    });
    return 0;
  }

  try {
    store.open();
    const freshness = computeFreshness(store, repository);
    let query;
    try {
      query = buildQuery(repository, values);
    } catch (e) {
      console.error(`query build failed: ${e.message}`);
      return 3;
    }
    const v = validateMemoryQueryV1(query);
    if (!v.valid) {
      emit({ schema: MEMORY_QUERY_SCHEMA, state: "INVALID", reason: `QUERY_INVALID:${v.errors.slice(0, 5).join(";")}`, repository, query: null, retrieval: null, freshness });
      return 2;
    }
    const retrieval = store.query(v.query);
    emit({ schema: MEMORY_QUERY_SCHEMA, state: "AVAILABLE", reason: null, repository, query: v.query, retrieval, freshness });
    return 0;
  } catch (e) {
    if (e instanceof MemoryStoreInvalidError || String(e?.message ?? "").includes("MEMORY_STORE_INVALID")) {
      emit({ schema: MEMORY_QUERY_SCHEMA, state: "INVALID", reason: `MEMORY_STORE_INVALID:${String(e?.message ?? e).slice(0, 300)}`, repository, query: null, retrieval: null, freshness: null });
      return 2;
    }
    throw e;
  } finally {
    try { store.close(); } catch { /* best effort */ }
  }
}

function emit(out) {
  if (out.schema && out.state === "AVAILABLE" && !out.repository) {
    // (defensive — caller always passes repository)
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

process.exit(main());
