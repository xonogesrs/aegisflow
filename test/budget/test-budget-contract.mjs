// test/budget/test-budget-contract.mjs
//
// AUTOLOOP-TA3 — budget contract（autoloop.budget-contract/v1）.
//   - schema validation（enforced vs deferred dimensions; unsupported meters
//     fail closed — NEG8/NEG9）;
//   - dimension inventory disclosure（meter source / unit / admission field /
//     enforcement point / durable state / exhaustion behavior / reason）;
//   - profile default contracts（deterministic, admission-overridable）.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_CONTRACT_SCHEMA,
  BUDGET_STATES,
  ENFORCED_DIMENSIONS,
  DEFERRED_DIMENSIONS,
  DIMENSION_METER_MAP,
  validateBudgetContract,
  effectiveBudgetContract,
  resolveDimensionLimits,
  PROFILE_DEFAULT_CONTRACTS,
  DEFAULT_APPROACHING_RATIO,
} from "../../src/budget/contract.mjs";

test("contract: schema + states + dimension inventory are machine-readable", () => {
  assert.equal(BUDGET_CONTRACT_SCHEMA, "autoloop.budget-contract/v1");
  assert.deepEqual(BUDGET_STATES, ["CONTINUE", "APPROACHING_LIMIT", "BUDGET_EXHAUSTED", "BUDGET_AUTHORITY_INVALID"]);
  // every enforced dimension has a full disclosure row
  for (const d of ENFORCED_DIMENSIONS) {
    const m = DIMENSION_METER_MAP[d];
    assert.ok(m, `meter map row for ${d}`);
    assert.equal(m.supported, true, `${d} enforced but marked unsupported`);
    assert.ok(m.meterSource && m.unit && m.admissionField && m.enforcementPoint && m.durableState && m.exhaustionBehavior, `${d} disclosure complete`);
  }
  // every deferred dimension discloses its reason
  for (const d of DEFERRED_DIMENSIONS) {
    const m = DIMENSION_METER_MAP[d];
    assert.equal(m.supported, false, `${d} deferred but marked supported`);
    assert.ok(m.deferredReason, `${d} deferred reason required`);
  }
});

test("contract: unsupported-meter declaration fails closed (NEG8/NEG9)", () => {
  // token budget with no provider meter -> invalid（never reads as 0）.
  const v1 = validateBudgetContract({ schema: BUDGET_CONTRACT_SCHEMA, dimensions: { token_budget: { limit: 100 } } });
  assert.equal(v1.ok, false);
  assert.ok(v1.errors.some((e) => e.startsWith("token_budget_unsupported_meter")), JSON.stringify(v1.errors));
  // tool-call meter absent -> invalid.
  const v2 = validateBudgetContract({ schema: BUDGET_CONTRACT_SCHEMA, dimensions: { tool_call_count: { limit: 5 } } });
  assert.equal(v2.ok, false);
  // unknown dimension -> invalid.
  const v3 = validateBudgetContract({ schema: BUDGET_CONTRACT_SCHEMA, dimensions: { nope: { limit: 1 } } });
  assert.equal(v3.ok, false);
  assert.ok(v3.errors.some((e) => e === "unknown_dimension:nope"));
  // unknown top-level field -> invalid.
  const v4 = validateBudgetContract({ schema: BUDGET_CONTRACT_SCHEMA, magic: true });
  assert.equal(v4.ok, false);
});

test("contract: retrieval_bytes is deferred — declaring it fails closed", () => {
  const contract = { schema: BUDGET_CONTRACT_SCHEMA, dimensions: { retrieval_bytes: { limit: 1024 } } };
  const v = validateBudgetContract(contract, { memory_policy: { retrieval_allowed: true } });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith("retrieval_bytes_unsupported_meter")), JSON.stringify(v.errors));
});

test("contract: valid enforced-dimension contract passes", () => {
  const contract = {
    schema: BUDGET_CONTRACT_SCHEMA,
    approachingRatio: 0.75,
    dimensions: {
      node_execution_count: { limit: 4 },
      wall_clock_ms: { limit: 60000 },
      repair_attempt_count: { limit: 1 },
    },
  };
  const v = validateBudgetContract(contract);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("contract: profile default contracts exist for every profile and are deterministic", () => {
  for (const profile of ["FAST_PATH", "STANDARD", "MEDIUM", "MEDIUM_LARGE", "LARGE_LOW", "HIGH", "CRITICAL"]) {
    const d = PROFILE_DEFAULT_CONTRACTS[profile];
    assert.ok(d, `profile ${profile}`);
    for (const dim of ENFORCED_DIMENSIONS) assert.ok(Number.isFinite(d[dim]), `${profile}.${dim} finite`);
  }
  // deterministic table（no randomness / no timestamps）
  assert.deepEqual(PROFILE_DEFAULT_CONTRACTS.FAST_PATH, PROFILE_DEFAULT_CONTRACTS.FAST_PATH);
});

test("contract: admission-declared overrides apply per dimension, defaults stay", () => {
  const admission = {
    profile: "STANDARD",
    extensions: { budget: { schema: BUDGET_CONTRACT_SCHEMA, dimensions: { node_execution_count: { limit: 2 } } } },
  };
  const r = resolveDimensionLimits(admission);
  assert.equal(r.contractSource, "admission");
  assert.equal(r.limits.node_execution_count, 2);
  assert.equal(r.limits.wall_clock_ms, PROFILE_DEFAULT_CONTRACTS.STANDARD.wall_clock_ms);
  assert.equal(r.approachingRatio, DEFAULT_APPROACHING_RATIO);
});

test("contract: effectiveBudgetContract builds the canonical contract object", () => {
  const admission = {
    profile: "CRITICAL",
    extensions: { budget: { schema: BUDGET_CONTRACT_SCHEMA, closeoutAuthorized: true, dimensions: { retry_count: { limit: 3 } } } },
  };
  const r = effectiveBudgetContract(admission);
  assert.equal(r.ok, true);
  assert.equal(r.contract.source, "admission");
  assert.equal(r.contract.closeoutAuthorized, true);
  assert.equal(r.contract.dimensions.retry_count.limit, 3);
  assert.equal(r.contract.dimensions.wall_clock_ms.limit, PROFILE_DEFAULT_CONTRACTS.CRITICAL.wall_clock_ms);
});
