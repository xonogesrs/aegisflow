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
