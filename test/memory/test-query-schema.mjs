// test/memory/test-query-schema.mjs
//
// CBM-3 §8 / §29 — Retrieval Query Contract. Unknown fields, unknown enums,
// malformed shapes and oversized queries fail closed（QUERY_* errors）.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_QUERY_SCHEMA,
  validateMemoryQueryV1,
  queryIdentity,
  DEFAULT_TRUST_FLOOR,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_BYTES,
  QUERY_ERRORS,
  normalizeQueryTerms,
} from "../../src/memory/index.mjs";
import { REPO } from "./helpers-cbm3.mjs";

const okQuery = () => ({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO } });

test("Q1. valid minimal query normalizes to contract defaults", () => {
  const r = validateMemoryQueryV1(okQuery());
  assert.equal(r.valid, true);
  assert.equal(r.query.trustFloor, DEFAULT_TRUST_FLOOR);
  assert.equal(r.query.validityPolicy, "CURRENT");
  assert.equal(r.query.conflictPolicy, "SURFACE");
  assert.equal(r.query.limits.maxRecords, DEFAULT_MAX_RECORDS);
  assert.equal(r.query.limits.maxBytes, DEFAULT_MAX_BYTES);
  assert.equal(r.query.recordTypes, null);
  assert.equal(r.query.terms, null);
});

test("Q2. unknown top-level field fails closed", () => {
  const r = validateMemoryQueryV1({ ...okQuery(), bogo: 1 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.startsWith(`${QUERY_ERRORS.QUERY_UNKNOWN_FIELD}:bogo`)));
});

test("Q3. unknown context / scope / limits fields fail closed", () => {
  for (const q of [
    { ...okQuery(), context: { repository: REPO, bogo: "x" } },
    { ...okQuery(), scope: { bogo: true } },
    { ...okQuery(), limits: { bogo: 5 } },
  ]) {
    const r = validateMemoryQueryV1(q);
    assert.equal(r.valid, false, `should reject ${JSON.stringify(q)}`);
    assert.ok(r.errors.some((e) => e.startsWith(QUERY_ERRORS.QUERY_UNKNOWN_FIELD)), r.errors.join(";"));
  }
});

test("Q4. unknown enums fail closed (trustFloor / validityPolicy / conflictPolicy / recordType)", () => {
  for (const q of [
    { ...okQuery(), trustFloor: "SUPER_TRUSTED" },
    { ...okQuery(), validityPolicy: "MAYBE" },
    { ...okQuery(), conflictPolicy: "PICK_NEWEST" },
    { ...okQuery(), recordTypes: ["MEME"] },
  ]) {
    const r = validateMemoryQueryV1(q);
    assert.equal(r.valid, false, `should reject ${JSON.stringify(q)}`);
    assert.ok(r.errors.some((e) => e.startsWith(QUERY_ERRORS.QUERY_UNKNOWN_ENUM)), r.errors.join(";"));
  }
});

test("Q5. wrong schema fails closed", () => {
  const r = validateMemoryQueryV1({ ...okQuery(), schema: "autoloop.memory-query/v99" });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.startsWith(QUERY_ERRORS.QUERY_SCHEMA_INVALID)));
});

test("Q6. repository is required and must be hex64", () => {
  for (const q of [
    { schema: MEMORY_QUERY_SCHEMA, context: {} },
    { schema: MEMORY_QUERY_SCHEMA, context: { repository: null } },
    { schema: MEMORY_QUERY_SCHEMA, context: { repository: "not-hex-64" } },
    { schema: MEMORY_QUERY_SCHEMA }, // context absent entirely
  ]) {
    const r = validateMemoryQueryV1(q);
    assert.equal(r.valid, false, `should reject ${JSON.stringify(q)}`);
  }
});

test("Q7. oversized query / terms / selectors fail closed", () => {
  const big = "x".repeat(9 * 1024);
  assert.equal(validateMemoryQueryV1({ ...okQuery(), terms: big }).valid, false);
  const many = { ...okQuery(), identitySelectors: { recordIds: Array.from({ length: 300 }, () => "a".repeat(64)) } };
  assert.equal(validateMemoryQueryV1(many).valid, false);
  const hugePath = { ...okQuery(), path: "y".repeat(5000) };
  assert.equal(validateMemoryQueryV1(hugePath).valid, false);
});

test("Q8. valid full query round-trips and is deterministic", () => {
  const q = {
    schema: MEMORY_QUERY_SCHEMA,
    context: { repository: REPO, worktree: "w".repeat(64), commit: "c".repeat(40), tree: "t".repeat(40), graphRunId: "run-1", task: "task-9" },
    recordTypes: ["CODE", "DECISION"],
    scope: { path: "src/module.mjs", symbol: "parseMemoryRecord" },
    trustFloor: "REVIEWED",
    validityPolicy: "INCLUDE_STALE",
    terms: "memory retrieval",
    logicalKey: "9".repeat(64),
    identitySelectors: { recordIds: ["8".repeat(64)] },
    limits: { maxRecords: 10, maxBytes: 4096 },
  };
  const r = validateMemoryQueryV1(q);
  assert.equal(r.valid, true, r.errors.join(";"));
  assert.equal(r.query.scope.path, "src/module.mjs");
  assert.equal(r.query.limits.maxRecords, 10);
  assert.equal(queryIdentity(r.query), queryIdentity(validateMemoryQueryV1(q).query));
});

test("Q9. non-object / array query rejected", () => {
  assert.equal(validateMemoryQueryV1(null).valid, false);
  assert.equal(validateMemoryQueryV1([]).valid, false);
  assert.equal(validateMemoryQueryV1("SELECT * FROM memory").valid, false);
});

test("Q10. query identity is sensitive to every retrieval-relevant field", () => {
  const base = validateMemoryQueryV1(okQuery()).query;
  const variants = [
    { ...base, trustFloor: "CONFIRMED" },
    { ...base, validityPolicy: "ALL" },
    { ...base, terms: "retrieval" },
    { ...base, limits: { ...base.limits, maxRecords: 7 } },
  ];
  const ids = new Set([queryIdentity(base)]);
  for (const v of variants) ids.add(queryIdentity(v));
  assert.equal(ids.size, 1 + variants.length, "each variant must change the query identity");
});

test("Q11. lexical terms normalization is deterministic and deduped", () => {
  assert.deepEqual(normalizeQueryTerms("  Memory  MEMORY retrieval "), ["memory", "retrieval"]);
  assert.deepEqual(normalizeQueryTerms(""), []);
  assert.deepEqual(normalizeQueryTerms(null), []);
});

// ── R2 PATTERN query-schema extension (AUTOLOOP-V1-STAGE-F-R2-IMPLEMENTATION-1;
//    additive cases only — existing expectations above byte-untouched) ─────

test("R2-Q1. recordTypes accepts PATTERN; null recordTypes still valid (null ⇒ ALL incl. PATTERN, frozen §5 semantics)", () => {
  const withPattern = validateMemoryQueryV1({ ...okQuery(), recordTypes: ["PATTERN"] });
  assert.equal(withPattern.valid, true);
  assert.deepEqual(withPattern.query.recordTypes, ["PATTERN"]);
  const mixed = validateMemoryQueryV1({ ...okQuery(), recordTypes: ["PATTERN", "CODE"] });
  assert.equal(mixed.valid, true);
  const none = validateMemoryQueryV1(okQuery());
  assert.equal(none.valid, true);
  assert.equal(none.query.recordTypes, null, "null recordTypes (all types incl. PATTERN) stays the frozen default");
});

test("R2-Q2. pattern selector fields accepted and normalized to explicit shape", () => {
  const q = validateMemoryQueryV1({
    ...okQuery(),
    recordTypes: ["PATTERN"],
    pattern: {
      appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src/memory" }],
      doesNotApplyWhen: [{ field: "scope.symbol", op: "SYMBOL_EQUALS", value: "x" }],
      mechanismSignature: { errorClass: "livelock" },
    },
  });
  assert.equal(q.valid, true, JSON.stringify(q.errors));
  assert.deepEqual(q.query.pattern.appliesWhen, [{ field: "scope.path", op: "PATH_PREFIX", value: "src/memory" }]);
  assert.deepEqual(q.query.pattern.mechanismSignature, { errorClass: "livelock" });
});

test("R2-Q3. query without pattern selectors normalizes to explicit nulls (byte-identical pre-R2 form + nulls)", () => {
  const q = validateMemoryQueryV1(okQuery()).query;
  assert.deepEqual(q.pattern, { appliesWhen: null, doesNotApplyWhen: null, mechanismSignature: null });
});

test("R2-Q4. unknown pattern sub-field rejected (QUERY_UNKNOWN_FIELD)", () => {
  const q = validateMemoryQueryV1({ ...okQuery(), pattern: { bogus: true } });
  assert.equal(q.valid, false);
  assert.ok(q.errors.some((e) => e.includes(QUERY_ERRORS.QUERY_UNKNOWN_FIELD) && e.includes("pattern.bogus")));
});

test("R2-Q5. non-structured op rejected — lexical-similarity matching is NOT a query op ([CT §1 R6] NG)", () => {
  const q = validateMemoryQueryV1({ ...okQuery(), pattern: { appliesWhen: [{ field: "x", op: "LEXICAL_SIMILAR", value: "y" }] } });
  assert.equal(q.valid, false);
  assert.ok(q.errors.some((e) => e.includes(QUERY_ERRORS.QUERY_UNKNOWN_ENUM)));
});

test("R2-Q6. malformed pattern condition rejected (empty array / bad value shape)", () => {
  const q1 = validateMemoryQueryV1({ ...okQuery(), pattern: { appliesWhen: [] } });
  assert.equal(q1.valid, false);
  assert.ok(q1.errors.some((e) => e.includes("pattern.appliesWhen_must_be_non_empty_array")));
  const q2 = validateMemoryQueryV1({ ...okQuery(), pattern: { appliesWhen: [{ field: "x", op: "PATH_PREFIX", value: 42 }] } });
  assert.equal(q2.valid, false);
  assert.ok(q2.errors.some((e) => e.includes("value_invalid")));
});

test("R2-Q7. pattern selectors change the query identity (deterministic digest input)", () => {
  const base = validateMemoryQueryV1(okQuery()).query;
  const withPattern = validateMemoryQueryV1({ ...okQuery(), pattern: { appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src" }] } }).query;
  assert.notEqual(queryIdentity(base), queryIdentity(withPattern));
  assert.equal(queryIdentity(withPattern), queryIdentity(validateMemoryQueryV1({ ...okQuery(), pattern: { appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src" }] } }).query));
});
