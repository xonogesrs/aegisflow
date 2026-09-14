// test/control-plane/test-optimizer.mjs
//
// CP-2R2 — bounded deterministic optimizer (CP-1 cost-optimizer-contract),
// repaired for authority/budget fail-closed enforcement.
//
// Proves the mechanical properties the repair card requires:
//   - deterministic identical-input → identical-output,
//   - every output stays inside a closed enum,
//   - sole eligible options selected; multiple → NO_RECOMMENDATION,
//   - selection ⊆ authoritative allowlist / eligible sets (no override),
//   - missing ledger authority → HOLD (never full-envelope default),
//   - missing lifecycle authority → HOLD (Finding 2),
//   - caller cannot substitute the authoritative allowlist,
//   - runtime is admission-derived; caller substitution → HOLD (Finding 5),
//   - allocation may only narrow the envelope (out-of-envelope → HOLD),
//   - required-dimension exhaustion → HOLD (Finding 2),
//   - rehashed/forged admission → HOLD.

import { test } from "node:test";
import assert from "node:assert/strict";
// P7 subtraction re-point: the optimizer advisory now lives in the OPTIONAL
// orchestration layer (src/orchestration/optimizer.mjs); the advisory's own
// contract is unchanged and is still proven by this suite.
import { runOptimizer } from "../../src/orchestration/optimizer.mjs";
import { deriveBudgetEnvelope } from "../../src/budget/envelope.mjs";
import {
  EXECUTOR_MODEL_ALLOWLIST,
  EXECUTOR_RUNTIMES,
  RETRY_REPLAN_CHOICES,
  REVIEWER_STRATEGIES,
  RECOMMENDATION_KINDS,
  OPTIMIZER_HOLDS,
  ESCALATION_IN_ENVELOPE,
} from "../../src/control-plane/contract.mjs";
import { standardAdmission, highAdmission, fastPathAdmission, fullRemaining, forgeAdmission } from "./helpers.mjs";

function baseCtx(overrides = {}) {
  const admission = overrides.admission ?? standardAdmission();
  const envelope = deriveBudgetEnvelope(admission).envelope;
  return {
    admission,
    budgetEnvelope: envelope,
    budgetRemaining: fullRemaining(admission),
    runtime: null, // no caller evidence — the optimizer derives from admission
    eligibleTransitions: ["CONTINUE", "RETRY", "REPLAN"],
    eligibleReviewers: ["deterministic"],
    taskAllocation: null,
    observed: null,
    ...overrides,
  };
}

test("deterministic: identical input → identical output", () => {
  const ctx = baseCtx();
  const d1 = runOptimizer(ctx);
  const d2 = runOptimizer(ctx);
  assert.equal(d1.decisionId, d2.decisionId);
  assert.deepEqual(d1, d2);
});

test("every output stays inside its closed enum", () => {
  const d = runOptimizer(baseCtx());
  assert.ok(RECOMMENDATION_KINDS.includes(d.recommendation));
  assert.ok(d.retryReplan === null || RETRY_REPLAN_CHOICES.includes(d.retryReplan));
  assert.ok(d.reviewerStrategy === null || REVIEWER_STRATEGIES.includes(d.reviewerStrategy));
  assert.ok(d.runtime === null || EXECUTOR_RUNTIMES.includes(d.runtime));
  assert.ok(d.holdCode === null || Object.values(OPTIMIZER_HOLDS).includes(d.holdCode));
  assert.ok(d.escalationClass === ESCALATION_IN_ENVELOPE || Object.values(OPTIMIZER_HOLDS).includes(d.escalationClass));
});

test("sole eligible options are selected (executor + reviewer + transition + runtime)", () => {
  const admission = highAdmission(); // derives runtime "durable"
  const d = runOptimizer(baseCtx({ admission, eligibleTransitions: ["RETRY"], eligibleReviewers: ["external"] }));
  assert.equal(d.recommendation, "RECOMMENDATION");
  assert.equal(d.executor.provider, EXECUTOR_MODEL_ALLOWLIST[0].provider);
  assert.equal(d.executor.model, EXECUTOR_MODEL_ALLOWLIST[0].model);
  assert.equal(d.retryReplan, "RETRY");
  assert.equal(d.reviewerStrategy, "external");
  assert.equal(d.runtime, "durable");
  assert.equal(d.escalationClass, ESCALATION_IN_ENVELOPE);
});

test("runtime is admission-derived (no caller evidence needed)", () => {
  const d = runOptimizer(baseCtx()); // STANDARD → colima
  assert.equal(d.recommendation, "RECOMMENDATION");
  assert.equal(d.runtime, "colima");
});

test("caller runtime substitution → HOLD (runtime is not a caller choice)", () => {
  const d = runOptimizer(baseCtx({ runtime: "direct" })); // STANDARD derives colima
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY);
});

test("unknown runtime → HOLD", () => {
  const d = runOptimizer(baseCtx({ runtime: "bogus" }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.UNKNOWN_ENUM);
});

test("multiple eligible options → NO_RECOMMENDATION (never invents a fallback)", () => {
  const d = runOptimizer(baseCtx({ eligibleTransitions: ["CONTINUE", "RETRY", "REPLAN"], eligibleReviewers: ["deterministic", "independent"] }));
  assert.equal(d.retryReplan, null);
  assert.equal(d.reviewerStrategy, null);
  assert.ok(d.reasons.some((r) => r.includes("retryReplan: multiple eligible")));
  assert.ok(d.reasons.some((r) => r.includes("reviewerStrategy: multiple eligible")));
});

test("selection cannot escape the eligible set", () => {
  const d = runOptimizer(baseCtx({ eligibleTransitions: ["CONTINUE"], eligibleReviewers: ["independent"] }));
  assert.equal(d.retryReplan, "CONTINUE");
  assert.equal(d.reviewerStrategy, "independent");
  assert.ok(RETRY_REPLAN_CHOICES.includes(d.retryReplan));
  assert.equal(d.executor.provider, EXECUTOR_MODEL_ALLOWLIST[0].provider);
  assert.equal(d.executor.model, EXECUTOR_MODEL_ALLOWLIST[0].model);
});

test("caller cannot substitute the authoritative allowlist → HOLD", () => {
  const d = runOptimizer(baseCtx({ executorAllowlist: [{ provider: "evil", model: "unauthorized" }] }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY);
});

test("caller allowlist equal to authoritative → accepted", () => {
  const d = runOptimizer(baseCtx({ executorAllowlist: EXECUTOR_MODEL_ALLOWLIST }));
  assert.notEqual(d.recommendation, "HOLD");
  assert.equal(d.executor.provider, EXECUTOR_MODEL_ALLOWLIST[0].provider);
});

test("missing budget remaining (ledger authority) → HOLD", () => {
  const d = runOptimizer(baseCtx({ budgetRemaining: null }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.MISSING_BUDGET_AUTHORITY);
});

test("missing lifecycle authority → HOLD", () => {
  const d = runOptimizer(baseCtx({ eligibleTransitions: null }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.MISSING_LIFECYCLE_AUTHORITY);
  assert.equal(d.retryReplan, null);
});

test("empty eligible transitions → HOLD", () => {
  const d = runOptimizer(baseCtx({ eligibleTransitions: [] }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.NO_ELIGIBLE_OPTION);
  assert.equal(d.retryReplan, null);
  assert.equal(d.escalationClass, OPTIMIZER_HOLDS.NO_ELIGIBLE_OPTION);
});

test("unknown transition enum → HOLD (caller-substituted lifecycle set)", () => {
  const d = runOptimizer(baseCtx({ eligibleTransitions: ["CONTINUE", "FOO"] }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.UNKNOWN_ENUM);
});

test("caller-substituted REPLAN with repair_budget 0 → HOLD", () => {
  const admission = { ...standardAdmission("NOREPAIR"), repair_budget: 0 };
  const d = runOptimizer(baseCtx({ admission, eligibleTransitions: ["REPLAN"] }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY);
});

test("malformed input (missing admission) → HOLD", () => {
  const d = runOptimizer(baseCtx({ admission: null }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.MALFORMED_INPUT);
});

test("rehashed/forged admission → HOLD", () => {
  const forged = forgeAdmission(standardAdmission("FORGED"), { fail_closed: false });
  const d = runOptimizer(baseCtx({ admission: forged }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY);
});

test("rehashed but semantically invalid FAST_PATH (durable) admission → HOLD", () => {
  const forged = forgeAdmission(fastPathAdmission("FAST-FORGED"), { durability_policy: "durable" });
  const d = runOptimizer(baseCtx({ admission: forged }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY);
});

test("valid-looking admission with policy inconsistency → HOLD", () => {
  // STANDARD profile requires colima isolation; "none" is schema-valid but
  // semantically inconsistent — production validation must reject it, not
  // merely shape/id validate.
  const forged = forgeAdmission(standardAdmission("INCONSISTENT"), { isolation_policy: "none" });
  const d = runOptimizer(baseCtx({ admission: forged }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY);
});

test("observed input without provenance → HOLD", () => {
  const d = runOptimizer(baseCtx({ observed: { some: "data" } }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.MISSING_PROVENANCE);
});

test("contradictory authority (envelope/admission mismatch) → HOLD", () => {
  const ctx = baseCtx();
  const other = standardAdmission("TASK-OTHER");
  const otherEnv = deriveBudgetEnvelope(other).envelope;
  const d = runOptimizer({ ...ctx, budgetEnvelope: otherEnv });
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY);
});

test("budget allocation narrows within envelope", () => {
  const d = runOptimizer(baseCtx({ taskAllocation: { dimensions: { node_execution_count: 5 } } }));
  assert.equal(d.budgetAllocation.dimensions.node_execution_count, 5);
});

test("allocation exceeding envelope → OUT_OF_ENVELOPE HOLD", () => {
  const d = runOptimizer(baseCtx({ taskAllocation: { dimensions: { node_execution_count: 100 } } }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.OUT_OF_ENVELOPE);
});

test("unsupported dimension in allocation → HOLD", () => {
  const d = runOptimizer(baseCtx({ taskAllocation: { dimensions: { token_budget: 10 } } }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.UNKNOWN_ENUM);
});

test("required-dimension exhaustion → HOLD (budget constrains, never minted)", () => {
  const admission = standardAdmission("EXH");
  const rem = fullRemaining(admission);
  rem.node_execution_count = 0;
  const d = runOptimizer(baseCtx({ admission, budgetRemaining: rem }));
  assert.equal(d.recommendation, "HOLD");
  assert.equal(d.holdCode, OPTIMIZER_HOLDS.BUDGET_EXHAUSTED);
});
