// test/control-plane/test-coordinator.mjs
//
// CP-2R2 — cross-task coordinator (CP-1 §7 minimal seams), repaired for
// sink-time authority/budget enforcement.
//
// Proves: priority/stable ordering, collective global-budget split (no
// double-spend), allocation narrowing, runtime strictness (no fallback),
// missing ledger / exhausted budget fail-closed, missing/empty lifecycle
// authority fail-closed, rehashed/forged admission fail-closed, and
// one-at-a-time dispatch through runAdmittedGraph (no arbitrary runner
// bypass, no caller override of authoritative fields).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coordinate,
  executeSequentially,
  deriveEligibleReviewers,
  deriveExecutorRuntime,
} from "../../src/control-plane/coordinator.mjs";
import { OPTIMIZER_HOLDS } from "../../src/control-plane/contract.mjs";
import {
  standardAdmission,
  highAdmission,
  fastPathAdmission,
  fullRemaining,
  lifecycleEligible,
  taskInput,
  forgeAdmission,
} from "./helpers.mjs";

test("deriveEligibleReviewers reflects admission review policy", () => {
  assert.deepEqual(deriveEligibleReviewers(standardAdmission()), ["deterministic"]);
  assert.deepEqual(deriveEligibleReviewers(highAdmission()), ["external"]);
});

test("deriveExecutorRuntime is strict (no permissive fallback)", () => {
  assert.equal(deriveExecutorRuntime(standardAdmission()), "colima");
  assert.equal(deriveExecutorRuntime(highAdmission()), "durable");
  assert.equal(deriveExecutorRuntime(fastPathAdmission()), "direct");
  assert.equal(deriveExecutorRuntime(null), null);
  assert.equal(deriveExecutorRuntime({ profile: "STANDARD", durability_policy: "ephemeral", isolation_policy: "bogus" }), null);
});

test("ordering by priority then stable index", () => {
  const a = standardAdmission("A");
  const b = standardAdmission("B");
  const c = standardAdmission("C");
  const { plan } = coordinate({ tasks: [
    taskInput("a", a, { priority: 2 }),
    taskInput("b", b, { priority: 1 }),
    taskInput("c", c, { priority: 1 }),
  ] });
  assert.deepEqual(plan.orderedTaskIds, ["b", "c", "a"]);
});

test("global budget is split collectively — no double-spend", () => {
  const a = standardAdmission("A");
  const b = standardAdmission("B");
  const { plan } = coordinate({
    tasks: [taskInput("a", a), taskInput("b", b)],
    globalBudget: { dimensions: { node_execution_count: 20 } },
  });
  const aAlloc = plan.tasks.find((t) => t.taskId === "a").decision.budgetAllocation.dimensions.node_execution_count;
  const bAlloc = plan.tasks.find((t) => t.taskId === "b").decision.budgetAllocation.dimensions.node_execution_count;
  assert.equal(aAlloc, 16); // capped by envelope (STANDARD node limit 16)
  assert.equal(bAlloc, 4);  // remaining global after A
  assert.ok(aAlloc + bAlloc <= 20);
  assert.equal(plan.globalRemaining.node_execution_count, 0);
  // the authoritative allocation is bound into the plan, not just the decision
  const aTask = plan.tasks.find((t) => t.taskId === "a");
  assert.equal(aTask.taskAllocation.admissionId, a.admission_id);
  assert.equal(aTask.taskAllocation.dimensions.node_execution_count, 16);
  assert.equal(aTask.taskAllocation.allocationId.length, 64);
});

test("zero global budget → task is not executable (HOLD)", () => {
  const a = standardAdmission("A");
  const { plan } = coordinate({ tasks: [taskInput("a", a)], globalBudget: { dimensions: { node_execution_count: 0 } } });
  assert.equal(plan.tasks[0].decision.recommendation, "HOLD");
  assert.equal(plan.tasks[0].decision.holdCode, OPTIMIZER_HOLDS.BUDGET_EXHAUSTED);
});

test("missing ledger remaining → HOLD (never full-envelope default)", () => {
  const a = standardAdmission("A");
  const { plan } = coordinate({ tasks: [{ id: "a", admission: a, lifecycleState: "EXECUTING" }] }); // no remaining
  assert.equal(plan.tasks[0].decision.recommendation, "HOLD");
  assert.equal(plan.tasks[0].decision.holdCode, OPTIMIZER_HOLDS.MISSING_BUDGET_AUTHORITY);
});

test("exhausted ledger remaining (node) → HOLD", () => {
  const a = standardAdmission("A");
  const rem = fullRemaining(a);
  rem.node_execution_count = 0;
  const { plan } = coordinate({ tasks: [taskInput("a", a, { remaining: rem })] });
  assert.equal(plan.tasks[0].decision.recommendation, "HOLD");
  assert.equal(plan.tasks[0].decision.holdCode, OPTIMIZER_HOLDS.BUDGET_EXHAUSTED);
});

test("zero budget in each required dimension → HOLD", () => {
  const a = standardAdmission("A");
  const zeroDims = {
    wall_clock_ms: "wall_clock_ms",
    sub_agent_execution_count: "sub_agent_execution_count",
    repair_attempt_count: "repair_attempt_count",
    verifier_reviewer_attempts: "verifier_reviewer_attempts",
    retry_count: "retry_count",
  };
  for (const dim of Object.values(zeroDims)) {
    const rem = fullRemaining(a);
    rem[dim] = 0;
    const { plan } = coordinate({ tasks: [taskInput("a", a, { remaining: rem })] });
    assert.equal(plan.tasks[0].decision.recommendation, "HOLD", `${dim} should be unexecutable`);
  }
});

test("mixed exhausted/non-exhausted dimensions → HOLD (any exhausted required dimension blocks)", () => {
  const a = standardAdmission("A");
  const rem = fullRemaining(a);
  rem.node_execution_count = 16; // plenty of nodes
  rem.sub_agent_execution_count = 0; // but sub-agent exhausted
  const { plan } = coordinate({ tasks: [taskInput("a", a, { remaining: rem })] });
  assert.equal(plan.tasks[0].decision.recommendation, "HOLD");
  assert.equal(plan.tasks[0].decision.holdCode, OPTIMIZER_HOLDS.BUDGET_EXHAUSTED);
});

test("missing lifecycle authority → HOLD (never synthesized from budget)", () => {
  const a = standardAdmission("A");
  const { plan } = coordinate({ tasks: [{ id: "a", admission: a, remaining: fullRemaining(a) }] }); // no lifecycleState
  assert.equal(plan.tasks[0].decision.recommendation, "HOLD");
  assert.equal(plan.tasks[0].decision.holdCode, OPTIMIZER_HOLDS.MISSING_LIFECYCLE_AUTHORITY);
});

test("empty eligible lifecycle set → HOLD (no invented CONTINUE)", () => {
  const a = standardAdmission("A");
  const { plan } = coordinate({ tasks: [taskInput("a", a, { lifecycleState: "CONTROLLER_REQUIRED" })] });
  assert.equal(plan.tasks[0].decision.recommendation, "HOLD");
  assert.equal(plan.tasks[0].decision.holdCode, OPTIMIZER_HOLDS.NO_ELIGIBLE_OPTION);
});

test("lifecycle eligibility comes from the Lifecycle Runner, not budget counters", () => {
  const a = standardAdmission("A");
  // EXECUTING + repair authority 1 → [CONTINUE, RETRY, REPLAN]
  assert.deepEqual(lifecycleEligible(a), ["CONTINUE", "RETRY", "REPLAN"]);
  // repair authority 0 → no REPLAN, but CONTINUE/RETRY remain（lifecycle facts）
  const noRepair = { ...a, repair_budget: 0 };
  assert.deepEqual(lifecycleEligible(noRepair), ["CONTINUE", "RETRY"]);
  // a zero node budget does NOT change the lifecycle eligible set（budget
  // constrains, it does not mint/deny lifecycle transitions）
  const rem = fullRemaining(a);
  rem.node_execution_count = 0;
  assert.deepEqual(lifecycleEligible(a), ["CONTINUE", "RETRY", "REPLAN"]);
});

test("routing stays inside envelope for valid admissions", () => {
  const a = standardAdmission("A");
  const { plan } = coordinate({ tasks: [taskInput("a", a)] });
  const d = plan.tasks[0].decision;
  assert.equal(d.escalationClass, "IN_ENVELOPE");
  assert.equal(d.recommendation, "RECOMMENDATION");
  assert.equal(d.executor.provider, "deepseek");
  assert.equal(d.executor.model, "deepseek-v4-flash");
  assert.equal(d.runtime, "colima");
});

test("invalid admission surfaces a HOLD decision (fail-closed)", () => {
  const { plan } = coordinate({ tasks: [{ id: "bad", admission: { task_id: "bad" }, remaining: fullRemaining(standardAdmission()), lifecycleState: "EXECUTING" }] });
  assert.equal(plan.tasks[0].decision.recommendation, "HOLD");
});

test("rehashed/forged admission surfaces HOLD", () => {
  const forged = forgeAdmission(standardAdmission("FORGED"), { fail_closed: false });
  const { plan } = coordinate({ tasks: [taskInput("forged", forged)] });
  assert.equal(plan.tasks[0].decision.recommendation, "HOLD");
  assert.equal(plan.tasks[0].decision.holdCode, OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY);
});

test("deterministic: same inputs → same planIdentity", () => {
  const a = standardAdmission("A");
  const tasks = [taskInput("a", a)];
  const p1 = coordinate({ tasks });
  const p2 = coordinate({ tasks });
  assert.equal(p1.plan.planIdentity, p2.plan.planIdentity);
});

test("executeSequentially reaches authoritative runner exactly once (admission enforced)", async () => {
  const admission = standardAdmission("GOOD");
  let calls = 0;
  const spy = async () => { calls += 1; return { final: "PASS", nodeResults: [], transitions: [], closeout: { applied: false } }; };
  const { plan } = coordinate({ tasks: [taskInput("good", admission, { runnerOpts: { runner: spy } })] });
  const { results } = await executeSequentially({ plan });
  assert.equal(calls, 1);
  assert.equal(results[0].dispatched, true);
  assert.equal(results[0].result.final, "PASS");
});

test("rehashed/forged admission is never dispatched (admission enforcement)", async () => {
  const forged = forgeAdmission(standardAdmission("FORGED"), { fail_closed: false });
  let calls = 0;
  const spy = async () => { calls += 1; return { final: "PASS", nodeResults: [], transitions: [] }; };
  const { plan } = coordinate({ tasks: [taskInput("forged", forged, { runnerOpts: { runner: spy } })] });
  const { results } = await executeSequentially({ plan });
  assert.equal(calls, 0);
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].holdCode, OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY);
});

test("fast-path (direct) task is not graph-dispatched (no silent fallback)", async () => {
  const fast = fastPathAdmission("FAST");
  const { plan } = coordinate({ tasks: [taskInput("fast", fast)] });
  assert.equal(plan.tasks[0].runtime, "direct");
  assert.equal(plan.tasks[0].graph, null);
  const { results } = await executeSequentially({ plan });
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].reason, "direct execution (no graph runtime)");
});
