// src/memory/query-schema.mjs
//
// CBM-3 — Retrieval Query Contract（autoloop.memory-query/v1）.
//
// The query is a STRUCTURED contract（never free-text）:
//
//   {
//     schema: "autoloop.memory-query/v1",
//     context: {
//       repository: <repositoryIdentity hex64>,   // REQUIRED — first hard boundary
//       worktree:  <worktreeIdentity hex64>|null, // optional worktree isolation
//       commit:    <commitSha>|null,              // optional commit baseline
//       tree:      <treeSha>|null,                // optional tree baseline
//       graphRunId:<graphRunId>|null,             // execution-bound memory scope
//       task:      <taskIdentity>|null,           // task-bound memory scope
//     },
//     recordTypes: ["CODE"|"EXECUTION"|"DECISION"]|null,  // null = all
//     scope: {
//       path:   <string>|null,   // exact path / ancestor-prefix match
//       symbol: <string>|null,   // exact symbol match
//       global: <boolean>|null,  // false excludes explicitly global records
//     },
//     trustFloor:     "VERIFIED",       // default; TRUST_STATES enum
//     validityPolicy: "CURRENT",        // CURRENT | INCLUDE_STALE | ALL
//     conflictPolicy: "SURFACE",        // only value — never silently resolve
//     terms:          <string>|null,    // lexical terms（FTS candidate gen）
//     logicalKey:     <hex64>|null,     // exact logicalKey selector
//     identitySelectors: { recordIds: [<hex64>...] },  // exact recordId selectors
//     limits: {
//       maxRecords: 50,                 // 1..1000
//       maxBytes:   65536,              // 1..262144
//     },
//   }
//
// FAIL CLOSED: unknown fields, unknown enums, malformed shapes, oversized
// queries are rejected（QUERY_* errors）— a query that cannot be fully
// understood is never partially executed.

import { TRUST_STATES, SCOPES, RECORD_TYPES } from "./contract.mjs";
import { recursiveCanonicalJson } from "./canonical.mjs";
import { sha256Text } from "../evidence/run-evidence-store.mjs";

export const MEMORY_QUERY_SCHEMA = "autoloop.memory-query/v1";
export const MEMORY_RETRIEVAL_RESULT_SCHEMA = "autoloop.memory-retrieval-result/v1";
export const MEMORY_CONTEXT_SCHEMA = "autoloop.memory-context/v1";
export const MEMORY_STORE_IDENTITY_SCHEMA = "autoloop.memory-store/v1";
export const MEMORY_SNAPSHOT_DIGEST_SCHEMA = "autoloop.memory-store-snapshot/v1";
export const MEMORY_RETRIEVAL_DIGEST_SCHEMA = "autoloop.memory-retrieval-digest/v1";

export const QUERY_ERRORS = Object.freeze({
  QUERY_SCHEMA_INVALID: "QUERY_SCHEMA_INVALID",
  QUERY_UNKNOWN_FIELD: "QUERY_UNKNOWN_FIELD",
  QUERY_UNKNOWN_ENUM: "QUERY_UNKNOWN_ENUM",
  QUERY_MALFORMED: "QUERY_MALFORMED",
  QUERY_TOO_LARGE: "QUERY_TOO_LARGE",
});

export const VALIDITY_POLICIES = Object.freeze(["CURRENT", "INCLUDE_STALE", "ALL"]);
export const CONFLICT_POLICIES = Object.freeze(["SURFACE"]);

export const DEFAULT_TRUST_FLOOR = "VERIFIED";
export const DEFAULT_MAX_RECORDS = 50;
export const DEFAULT_MAX_BYTES = 64 * 1024;
export const MAX_RECORDS_BOUND = 1000;
export const MAX_BYTES_BOUND = 256 * 1024;
export const MAX_QUERY_SERIALIZED_BYTES = 16 * 1024;
export const MAX_TERMS_BYTES = 8 * 1024;
export const MAX_SELECTOR_COUNT = 256;

const HEX64 = /^[0-9a-f]{64}$/;

export const QUERY_FIELDS = Object.freeze([
  "schema",
  "context",
  "recordTypes",
  "scope",
  "trustFloor",
  "validityPolicy",
  "conflictPolicy",
  "terms",
  "path",
  "symbol",
  "logicalKey",
  "identitySelectors",
  "limits",
]);

export const QUERY_CONTEXT_FIELDS = Object.freeze([
  "repository",
  "worktree",
  "commit",
  "tree",
  "graphRunId",
  "task",
]);

export const QUERY_SCOPE_FIELDS = Object.freeze(["path", "symbol", "global"]);

export const QUERY_LIMITS_FIELDS = Object.freeze(["maxRecords", "maxBytes"]);

export function defaultQuery() {
  return {
    schema: MEMORY_QUERY_SCHEMA,
    context: { repository: null, worktree: null, commit: null, tree: null, graphRunId: null, task: null },
    recordTypes: null,
    scope: { path: null, symbol: null, global: null },
    trustFloor: DEFAULT_TRUST_FLOOR,
    validityPolicy: "CURRENT",
    conflictPolicy: "SURFACE",
    terms: null,
    path: null,
    symbol: null,
    logicalKey: null,
    identitySelectors: { recordIds: [] },
    limits: { maxRecords: DEFAULT_MAX_RECORDS, maxBytes: DEFAULT_MAX_BYTES },
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function ok(value) {
  return { valid: true, errors: [], query: value };
}

function fail(errors) {
  return { valid: false, errors: [...errors], query: null };
}

/**
 * Validate + normalize a memory query. Returns { valid, errors, query } —
 * `query` is the fully-normalized（defaulted）form used for retrieval and
 * identity/digest derivation. Fail-closed on anything unknown or malformed.
 */
export function validateMemoryQueryV1(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return fail([`${QUERY_ERRORS.QUERY_MALFORMED}:query_not_object`]);
  }
  for (const k of Object.keys(input)) {
    if (!QUERY_FIELDS.includes(k)) {
      errors.push(`${QUERY_ERRORS.QUERY_UNKNOWN_FIELD}:${k}`);
    }
  }
  if (input.schema !== MEMORY_QUERY_SCHEMA) {
    return fail([`${QUERY_ERRORS.QUERY_SCHEMA_INVALID}:${String(input.schema)}`]);
  }
  // context（required sub-object）
  if (!isPlainObject(input.context)) {
    errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:context_must_be_object`);
  } else {
    for (const k of Object.keys(input.context)) {
      if (!QUERY_CONTEXT_FIELDS.includes(k)) errors.push(`${QUERY_ERRORS.QUERY_UNKNOWN_FIELD}:context.${k}`);
    }
    const repo = input.context.repository;
    if (typeof repo !== "string" || repo.length === 0) {
      errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:context.repository_required_non_empty_string`);
    } else if (!HEX64.test(repo)) {
      errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:context.repository_must_be_hex64`);
    }
    for (const k of ["worktree", "commit", "tree"]) {
      const v = input.context[k];
      if (v !== undefined && v !== null && (typeof v !== "string" || v.length === 0)) {
        errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:context.${k}_must_be_non_empty_string_or_null`);
      }
    }
  }
  // scope（optional sub-object）
  if (input.scope !== undefined && input.scope !== null) {
    if (!isPlainObject(input.scope)) {
      errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:scope_must_be_object`);
    } else {
      for (const k of Object.keys(input.scope)) {
        if (!QUERY_SCOPE_FIELDS.includes(k)) errors.push(`${QUERY_ERRORS.QUERY_UNKNOWN_FIELD}:scope.${k}`);
      }
      if (input.scope.global !== undefined && input.scope.global !== null && typeof input.scope.global !== "boolean") {
        errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:scope.global_must_be_boolean`);
      }
    }
  }
  // recordTypes
  if (input.recordTypes !== undefined && input.recordTypes !== null) {
    if (!Array.isArray(input.recordTypes) || input.recordTypes.length === 0) {
      errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:recordTypes_must_be_non_empty_array`);
    } else {
      for (const t of input.recordTypes) {
        if (!RECORD_TYPES.includes(t)) errors.push(`${QUERY_ERRORS.QUERY_UNKNOWN_ENUM}:recordType:${String(t)}`);
      }
    }
  }
  // enums
  if (input.trustFloor !== undefined && !TRUST_STATES.includes(input.trustFloor)) {
    errors.push(`${QUERY_ERRORS.QUERY_UNKNOWN_ENUM}:trustFloor:${String(input.trustFloor)}`);
  }
  if (input.validityPolicy !== undefined && !VALIDITY_POLICIES.includes(input.validityPolicy)) {
    errors.push(`${QUERY_ERRORS.QUERY_UNKNOWN_ENUM}:validityPolicy:${String(input.validityPolicy)}`);
  }
  if (input.conflictPolicy !== undefined && !CONFLICT_POLICIES.includes(input.conflictPolicy)) {
    errors.push(`${QUERY_ERRORS.QUERY_UNKNOWN_ENUM}:conflictPolicy:${String(input.conflictPolicy)}`);
  }
  // free-text terms（bounded）
  if (input.terms !== undefined && input.terms !== null) {
    if (typeof input.terms !== "string") {
      errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:terms_must_be_string`);
    } else if (Buffer.byteLength(input.terms, "utf8") > MAX_TERMS_BYTES) {
      errors.push(`${QUERY_ERRORS.QUERY_TOO_LARGE}:terms>${MAX_TERMS_BYTES}`);
    }
  }
  // path / symbol（bounded strings）
  for (const k of ["path", "symbol"]) {
    const v = input[k];
    if (v !== undefined && v !== null) {
      if (typeof v !== "string" || v.length === 0) {
        errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:${k}_must_be_non_empty_string`);
      } else if (Buffer.byteLength(v, "utf8") > 4096) {
        errors.push(`${QUERY_ERRORS.QUERY_TOO_LARGE}:${k}>4096`);
      }
    }
  }
  // logicalKey（hex64）
  if (input.logicalKey !== undefined && input.logicalKey !== null) {
    if (typeof input.logicalKey !== "string" || !HEX64.test(input.logicalKey)) {
      errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:logicalKey_must_be_hex64`);
    }
  }
  // identitySelectors
  if (input.identitySelectors !== undefined && input.identitySelectors !== null) {
    if (!isPlainObject(input.identitySelectors) || !Array.isArray(input.identitySelectors.recordIds)) {
      errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:identitySelectors.recordIds_must_be_array`);
    } else {
      if (input.identitySelectors.recordIds.length > MAX_SELECTOR_COUNT) {
        errors.push(`${QUERY_ERRORS.QUERY_TOO_LARGE}:recordIds>${MAX_SELECTOR_COUNT}`);
      }
      for (const rid of input.identitySelectors.recordIds) {
        if (typeof rid !== "string" || !HEX64.test(rid)) {
          errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:identitySelectors.recordIds_must_be_hex64`);
        }
      }
    }
  }
  // limits
  if (input.limits !== undefined && input.limits !== null) {
    if (!isPlainObject(input.limits)) {
      errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:limits_must_be_object`);
    } else {
      for (const k of Object.keys(input.limits)) {
        if (!QUERY_LIMITS_FIELDS.includes(k)) errors.push(`${QUERY_ERRORS.QUERY_UNKNOWN_FIELD}:limits.${k}`);
      }
      const mr = input.limits.maxRecords;
      if (mr !== undefined && (!Number.isInteger(mr) || mr < 1 || mr > MAX_RECORDS_BOUND)) {
        errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:limits.maxRecords_out_of_bounds`);
      }
      const mb = input.limits.maxBytes;
      if (mb !== undefined && (!Number.isInteger(mb) || mb < 1 || mb > MAX_BYTES_BOUND)) {
        errors.push(`${QUERY_ERRORS.QUERY_MALFORMED}:limits.maxBytes_out_of_bounds`);
      }
    }
  }
  if (errors.length) return fail(errors);

  // ── normalize（explicit defaults; strip unknown-but-tolerated nulls）──
  const q = defaultQuery();
  const ctx = input.context ?? {};
  q.context.repository = ctx.repository;
  q.context.worktree = ctx.worktree ?? null;
  q.context.commit = ctx.commit ?? null;
  q.context.tree = ctx.tree ?? null;
  q.context.graphRunId = ctx.graphRunId ?? null;
  q.context.task = ctx.task ?? null;
  q.recordTypes = input.recordTypes === undefined || input.recordTypes === null ? null : [...input.recordTypes];
  q.scope.path = input.path ?? input.scope?.path ?? null;
  q.scope.symbol = input.symbol ?? input.scope?.symbol ?? null;
  q.scope.global = input.scope?.global ?? null;
  q.trustFloor = input.trustFloor ?? DEFAULT_TRUST_FLOOR;
  q.validityPolicy = input.validityPolicy ?? "CURRENT";
  q.conflictPolicy = input.conflictPolicy ?? "SURFACE";
  q.terms = input.terms ?? null;
  q.logicalKey = input.logicalKey ?? null;
  q.identitySelectors.recordIds = [...(input.identitySelectors?.recordIds ?? [])];
  q.limits.maxRecords = input.limits?.maxRecords ?? DEFAULT_MAX_RECORDS;
  q.limits.maxBytes = input.limits?.maxBytes ?? DEFAULT_MAX_BYTES;

  // oversized query guard（after normalization）
  const serialized = Buffer.byteLength(recursiveCanonicalJson(q), "utf8");
  if (serialized > MAX_QUERY_SERIALIZED_BYTES) {
    return fail([`${QUERY_ERRORS.QUERY_TOO_LARGE}:query>${MAX_QUERY_SERIALIZED_BYTES}`]);
  }
  return ok(q);
}

/**
 * Deterministic query identity: sha256(canonical(normalized query)).
 * The SAME store snapshot + SAME query identity ⇒ the same retrieval digest.
 */
export function queryIdentity(query) {
  return sha256Text(recursiveCanonicalJson(query));
}

/** Deterministic lexical terms（whitespace-split, lowercased, deduped）. */
export function normalizeQueryTerms(terms) {
  if (typeof terms !== "string" || terms.trim().length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const tok of terms.trim().toLowerCase().split(/\s+/)) {
    if (tok.length > 0 && !seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

export { SCOPES };
