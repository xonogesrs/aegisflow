// test/governance/test-schema-parity.mjs
// [neg 20] JSON Schema ↔ runtime validator parity.
//
// A deliberately INDEPENDENT minimal draft-07 evaluator (different code path
// from the runtime validator) validates the same schema file across a matrix
// of mutations. The verdicts must agree with validateAuthorityRecord /
// validateLifecycleAuthorization in every case.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SCHEMA, validateAuthorityRecord, validateLifecycleAuthorization } from "../../src/governance/lifecycle-authorization.mjs";
import { entryRecord, entryBlock } from "./helpers.mjs";

// ---------------------------------------------------------------------------
// Independent minimal draft-07 evaluator (test-only, different implementation)
// ---------------------------------------------------------------------------

function typeMatches(value, type) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

function check(schema, value, path, errors) {
  if (schema === undefined || schema === null) return;
  if (schema.const !== undefined && value !== schema.const) { errors.push(`${path}:const`); return; }
  if (schema.enum && !schema.enum.includes(value)) { errors.push(`${path}:enum`); return; }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) { errors.push(`${path}:type`); return; }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}:minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}:maxLength`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}:pattern`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path}:format`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}:minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}:maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}:minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}:maxItems`);
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) errors.push(`${path}:additionalProperties:${key}`);
      }
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}:required:${key}`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) check(sub, value[key], `${path}.${key}`, errors);
    }
  }
}

function schemaValid(schema, value) {
  const errors = [];
  check(schema, value, "$", errors);
  return errors.length === 0;
}

// ---------------------------------------------------------------------------
// Parity matrix
// ---------------------------------------------------------------------------

const MUTATIONS = [
  ["identity", (r) => r],
  ["schema const wrong", (r) => ({ ...r, schema: "autoloop.lifecycle-authorization/v1" })],
  ["missing card_id", (r) => { const c = structuredClone(r); delete c.card_id; return c; }],
  ["missing lifecycle_authorization", (r) => { const c = structuredClone(r); delete c.lifecycle_authorization; return c; }],
  ["unknown top-level field", (r) => ({ ...r, nuclear: true })],
  ["repository too short", (r) => ({ ...r, repository: "" })],
  ["base_head bad pattern", (r) => ({ ...r, base_head: "xyz" })],
  ["authorized_paths empty", (r) => ({ ...r, authorized_paths: [] })],
  ["authorized_paths wrong type", (r) => ({ ...r, authorized_paths: "src/" })],
  ["unknown capability section", (r) => ({ ...r, lifecycle_authorization: { ...r.lifecycle_authorization, nuclear: { allowed: true } } })],
  ["missing section", (r) => { const c = structuredClone(r); delete c.lifecycle_authorization.review_unit; return c; }],
  ["unknown field in section", (r) => { const c = structuredClone(r); c.lifecycle_authorization.draft_pr.extra = 1; return c; }],
  ["merge allowed true", (r) => ({ ...r, lifecycle_authorization: { ...r.lifecycle_authorization, merge_main: { allowed: true } } })],
  ["seal allowed true", (r) => ({ ...r, lifecycle_authorization: { ...r.lifecycle_authorization, seal: { allowed: true } } })],
  ["milestones above maximum", (r) => ({ ...r, lifecycle_authorization: { ...r.lifecycle_authorization, review_unit: { ...r.lifecycle_authorization.review_unit, maximum_internal_milestones: 9 } } })],
  ["repository_count above 1", (r) => ({ ...r, lifecycle_authorization: { ...r.lifecycle_authorization, review_unit: { ...r.lifecycle_authorization.review_unit, repository_count: 2 } } })],
  ["repair rounds above 2", (r) => ({ ...r, lifecycle_authorization: { ...r.lifecycle_authorization, bounded_repair: { ...r.lifecycle_authorization.bounded_repair, max_rounds: 3 } } })],
  ["max_depth negative", (r) => ({ ...r, lifecycle_authorization: { ...r.lifecycle_authorization, decomposition: { ...r.lifecycle_authorization.decomposition, max_depth: -1 } } })],
  ["max_depth float", (r) => ({ ...r, lifecycle_authorization: { ...r.lifecycle_authorization, decomposition: { ...r.lifecycle_authorization.decomposition, max_depth: 1.5 } } })],
  ["external_review missing required", (r) => { const c = structuredClone(r); delete c.lifecycle_authorization.external_review.require_bundle; return c; }],
  ["external_review bundle_path too long", (r) => ({ ...r, lifecycle_authorization: { ...r.lifecycle_authorization, external_review: { ...r.lifecycle_authorization.external_review, bundle_path: "x".repeat(2000) } } })],
  ["checkpoint flag wrong type", (r) => ({ ...r, lifecycle_authorization: { ...r.lifecycle_authorization, checkpoint_commit: { ...r.lifecycle_authorization.checkpoint_commit, require_local_gates_pass: "yes" } } })],
  ["branch_pattern empty", (r) => ({ ...r, lifecycle_authorization: { ...r.lifecycle_authorization, feature_branch_push: { ...r.lifecycle_authorization.feature_branch_push, branch_pattern: "" } } })],
  ["draft_only missing", (r) => { const c = structuredClone(r); delete c.lifecycle_authorization.draft_pr.draft_only; return c; }],
  ["card_revision too long", (r) => ({ ...r, card_revision: "z".repeat(100) })],
  ["issued_at bad date", (r) => ({ ...r, issued_at: "not-a-date" })],
  ["authorized_paths has empty item", (r) => ({ ...r, authorized_paths: [...r.authorized_paths, ""] })],
];

test("[neg 20] JSON Schema evaluator and runtime validator agree on every mutation", () => {
  for (const [name, mutate] of MUTATIONS) {
    const record = mutate(entryRecord());
    const schemaOk = schemaValid(SCHEMA, record);
    const runtimeOk = validateAuthorityRecord(record).valid;
    assert.equal(schemaOk, runtimeOk, `parity mismatch on "${name}": schema=${schemaOk} runtime=${runtimeOk}`);
  }
});

test("[neg 20] block-level parity on section mutations", () => {
  const block = entryBlock();
  const cases = [
    ["valid block", (b) => b],
    ["unknown field", (b) => ({ ...b, decomposition: { ...b.decomposition, extra: true } })],
    ["missing review_unit", (b) => { const c = structuredClone(b); delete c.review_unit; return c; }],
    ["release allowed", (b) => ({ ...b, release: { allowed: true } })],
    ["milestones 0", (b) => ({ ...b, review_unit: { ...b.review_unit, maximum_internal_milestones: 0 } })],
    ["create_if_missing string", (b) => ({ ...b, draft_pr: { ...b.draft_pr, create_if_missing: "yes" } })],
  ];
  for (const [name, mutate] of cases) {
    const mutated = mutate(block);
    const schemaOk = schemaValid(SCHEMA.properties.lifecycle_authorization, mutated);
    const runtimeOk = validateLifecycleAuthorization(mutated).valid;
    assert.equal(schemaOk, runtimeOk, `block parity mismatch on "${name}": schema=${schemaOk} runtime=${runtimeOk}`);
  }
});

test("schema file on disk is the one loaded (no drift)", () => {
  const onDisk = JSON.parse(readFileSync(new URL("../../src/schema/lifecycle-authorization.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(onDisk, SCHEMA);
});
