// test/control-plane/test-execution-sink.mjs
//
// CP-2R2 — SINK-TIME execution enforcement integration tests.
//
// These span the FULL path:
//   coordinate → planned authority → executeSequentially → runAdmittedGraph
//   → runner-visible/effective execution constraints
//
// They capture the ACTUAL arguments reaching the runner and prove that the
// authoritative budget allocation and admission identity bound at planning
// time are the exact values enforced at the execution sink — caller
// substitution cannot change them in between.

import { test } from "node:test";
import assert from "node:assert/strict";
import { coordinate, executeSequentially } from "../../src/control-plane/coordinator.mjs";
import { EXECUTION_HOLDS } from "../../src/control-plane/contract.mjs";
import { digestOf } from "../../src/canonical-digest.mjs";
import { standardAdmission, highAdmission, taskInput } from "./helpers.mjs";

function spyRunner(captured) {
  return async (args) => {
    captured.push(args);
    return { final: "PASS", nodeResults: [], transitions: [], closeout: { applied: false } };
  };
}

// A caller who can recompute hashes may keep the plan identity self-consistent
// while still tampering with the allocation/admission content. These sink
// tests therefore re-bind the plan identity after mutation so the sink's
// INDEPENDENT authority checks (not the plan digest) are what is exercised.
function rehashPlan(plan) {
  plan.planIdentity = digestOf({
    orderedTaskIds: plan.orderedTaskIds,
    tasks: plan.tasks.map((t) => ({
      taskId: t.taskId,
      admissionId: t.admissionId,
      runtime: t.runtime,
      decisionId: t.decision?.decisionId ?? null,
      allocationId: t.taskAllocation?.allocationId ?? null,
    })),
  });
  return plan;
}

test("sink-time no-double-spend: runner-visible limits are 16 and 4 (not 16 and 16)", async () => {
  const a = standardAdmission("A");
  const b = standardAdmission("B");
  const captured = [];
  const { plan } = coordinate({
    tasks: [
      taskInput("a", a, { runnerOpts: { runner: spyRunner(captured) } }),
      taskInput("b", b, { runnerOpts: { runner: spyRunner(captured) } }),
    ],
    globalBudget: { dimensions: { node_execution_count: 20 } },
  });

  const { ok, results } = await executeSequentially({ plan });
  assert.equal(ok, true);
  assert.equal(results.length, 2);
  assert.equal(results[0].dispatched, true);
  assert.equal(results[1].dispatched, true);
  assert.equal(captured.length, 2);

  const aLimits = captured[0].budget.enforcement.envelope.dimensions.node_execution_count.limit;
  const bLimits = captured[1].budget.enforcement.envelope.dimensions.node_execution_count.limit;
  assert.equal(aLimits, 16, "task A runner-visible node limit must be its 16-node allocation");
  assert.equal(bLimits, 4, "task B runner-visible node limit must be the remaining 4-node allocation");
  assert.ok(aLimits + bLimits <= 20, "collective allocation must not double-spend the global budget");
});

test("caller substitution cannot change the admission identity between planning and sink", async () => {
  const admission = standardAdmission("ORIGINAL");
  const captured = [];
  const { plan } = coordinate({
    tasks: [taskInput("a", admission, { runnerOpts: { runner: spyRunner(captured) } })],
  });
  const { results } = await executeSequentially({ plan });
  assert.equal(results[0].dispatched, true);
  assert.equal(captured[0].admission.admission_id, admission.admission_id);
});

test("runnerOpts admission override → rejected at the sink", async () => {
  const admission = standardAdmission("GOOD");
  const evil = highAdmission("EVIL");
  let calls = 0;
  const spy = async () => { calls += 1; return { final: "PASS", nodeResults: [], transitions: [] }; };
  const { plan } = coordinate({
    tasks: [taskInput("a", admission, { runnerOpts: { runner: spy, admission: evil } })],
  });
  const { results } = await executeSequentially({ plan });
  assert.equal(calls, 0);
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].holdCode, EXECUTION_HOLDS.AUTHORITY_OVERRIDE_REJECTED);
});

test("STANDARD plan + HIGH admission substitution → rejected", async () => {
  const planned = standardAdmission("PLANNED");
  const { plan } = coordinate({ tasks: [taskInput("a", planned)] });
  // A caller replaces the admission object AFTER planning.
  plan.tasks[0].admission = highAdmission("SUBSTITUTED");
  const { results } = await executeSequentially({ plan });
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].holdCode, EXECUTION_HOLDS.ADMISSION_IDENTITY_MISMATCH);
});

test("admission identity/digest mismatch → rejected", async () => {
  const planned = standardAdmission("PLANNED");
  const { plan } = coordinate({ tasks: [taskInput("a", planned)] });
  plan.tasks[0].admission = standardAdmission("OTHER-VALID-ADMISSION");
  const { results } = await executeSequentially({ plan });
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].holdCode, EXECUTION_HOLDS.ADMISSION_IDENTITY_MISMATCH);
});

test("missing task allocation where a global budget was provided → rejected", async () => {
  const a = standardAdmission("A");
  const { plan } = coordinate({
    tasks: [taskInput("a", a)],
    globalBudget: { dimensions: { node_execution_count: 20 } },
  });
  plan.tasks[0].taskAllocation = null;
  rehashPlan(plan);
  const { results } = await executeSequentially({ plan });
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].holdCode, EXECUTION_HOLDS.ALLOCATION_MISSING);
});

test("reuse of another task's allocation → rejected", async () => {
  const a = standardAdmission("A");
  const b = standardAdmission("B");
  const captured = [];
  const { plan } = coordinate({
    tasks: [
      taskInput("a", a, { runnerOpts: { runner: spyRunner(captured) } }),
      taskInput("b", b, { runnerOpts: { runner: spyRunner(captured) } }),
    ],
    globalBudget: { dimensions: { node_execution_count: 20 } },
  });
  // Reuse task B's allocation for task A.
  plan.tasks[0].taskAllocation = plan.tasks[1].taskAllocation;
  rehashPlan(plan);
  const { results } = await executeSequentially({ plan });
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].holdCode, EXECUTION_HOLDS.ALLOCATION_BINDING_MISMATCH);
});

test("substituted/reconstructed allocation → rejected", async () => {
  const a = standardAdmission("A");
  const { plan } = coordinate({
    tasks: [taskInput("a", a)],
    globalBudget: { dimensions: { node_execution_count: 20 } },
  });
  // Reconstruct the dimensions（12 ≤ envelope 16）without recomputing the
  // integrity digest.
  plan.tasks[0].taskAllocation = {
    ...plan.tasks[0].taskAllocation,
    dimensions: { node_execution_count: 12 },
  };
  rehashPlan(plan);
  const { results } = await executeSequentially({ plan });
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].holdCode, EXECUTION_HOLDS.ALLOCATION_BINDING_MISMATCH);
});

test("tampered plan identity → rejected before any dispatch", async () => {
  const a = standardAdmission("A");
  let calls = 0;
  const spy = async () => { calls += 1; return { final: "PASS", nodeResults: [], transitions: [] }; };
  const { plan } = coordinate({ tasks: [taskInput("a", a, { runnerOpts: { runner: spy } })] });
  plan.planIdentity = "0".repeat(64);
  const { ok, results } = await executeSequentially({ plan });
  assert.equal(ok, false);
  assert.equal(results.length, 0);
  assert.equal(calls, 0);
});

test("valid admitted single-task happy path (allocation enforced, no substitution)", async () => {
  const admission = standardAdmission("SINGLE");
  const captured = [];
  const { plan } = coordinate({
    tasks: [taskInput("a", admission, { runnerOpts: { runner: spyRunner(captured) } })],
    globalBudget: { dimensions: { node_execution_count: 20 } },
  });
  const { results } = await executeSequentially({ plan });
  assert.equal(results[0].dispatched, true);
  assert.equal(results[0].result.final, "PASS");
  assert.equal(captured[0].admission.admission_id, admission.admission_id);
  assert.equal(captured[0].budget.enforcement.envelope.dimensions.node_execution_count.limit, 16);
});

test("valid multi-task happy path (both tasks dispatched once each, in order)", async () => {
  const a = standardAdmission("A");
  const b = standardAdmission("B");
  const captured = [];
  const { plan } = coordinate({
    tasks: [
      taskInput("a", a, { runnerOpts: { runner: spyRunner(captured) } }),
      taskInput("b", b, { runnerOpts: { runner: spyRunner(captured) } }),
    ],
    globalBudget: { dimensions: { node_execution_count: 20 } },
  });
  const { results } = await executeSequentially({ plan });
  assert.equal(results.length, 2);
  assert.equal(results[0].dispatched, true);
  assert.equal(results[1].dispatched, true);
  assert.equal(captured.length, 2);
  assert.equal(captured[0].admission.admission_id, a.admission_id);
  assert.equal(captured[1].admission.admission_id, b.admission_id);
  assert.equal(captured[0].budget.enforcement.envelope.dimensions.node_execution_count.limit, 16);
  assert.equal(captured[1].budget.enforcement.envelope.dimensions.node_execution_count.limit, 4);
});
