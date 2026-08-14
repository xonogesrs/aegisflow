// test/budget/test-budget-wiring.mjs
//
// AUTOLOOP-TA3 — production wiring（runAdmittedGraph as the enforcement
// entrypoint）.
//   - an admitted run derives the envelope + ledger and the runner receives
//     the enforcement（pre-dispatch → record → finalize chain）;
//   - a budget-honoring runner produces a PASS with the budget section;
//   - a runner that executes nodes WITHOUT honoring the budget fails the
//     finalize reconciliation（NEG13 — production cannot bypass）;
//   - exhaustion blocks dispatch at the entrypoint（NEG4）;
//   - budget authority invalid（unsupported meter / bad checkpoint）HOLDs
//     BEFORE the runner is invoked;
//   - resume via checkpointState is cumulative（B3 / NEG5）;
//   - compat surface（no enforcement）is NOT budget-authorized（NEG14）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import { BUDGET_CONTRACT_SCHEMA } from "../../src/budget/contract.mjs";

const FULL_EVIDENCE = {
  affected_files: { score: 1, reasons: ["single README file"] },
  affected_subsystems: { score: 0, reasons: ["docs only"] },
  dependency_depth: { score: 0, reasons: ["no deps"] },
  ambiguity: { score: 0, reasons: ["exact text"] },
  expected_execution_steps: { score: 0, reasons: ["one edit"] },
  verification_burden: { score: 0, reasons: ["no tests"] },
  external_dependencies: { score: 0, reasons: ["none"] },
  concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 0, reasons: ["revert 1 file"] },
};

const DIMS = {
  node_execution_count: { limit: 3 },
  wall_clock_ms: { limit: 600000 },
  sub_agent_execution_count: { limit: 1 },
  repair_attempt_count: { limit: 2 },
  verifier_reviewer_attempts: { limit: 2 },
  retry_count: { limit: 2 },
};

function admission({ dimensions = DIMS } = {}) {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const rec = buildAdmissionRecord({
    taskId: "WIRE-TEST",
    classification: c,
    mutationScope: ["docs/"],
    extensions: dimensions ? { budget: { schema: BUDGET_CONTRACT_SCHEMA, version: 1, dimensions } } : {},
  });
  return freezeAdmission(rec);
}

const T0 = 1700000000000;
const T1 = 1700000005000; // +5000 ms

function nodeResult(phaseId, { final = "PASS", latencyMs = 5000 } = {}) {
  return { nodeId: phaseId, phaseExecutionId: `g:${phaseId}`, final, attempt: 0, taskType: "readonly", resultIdentity: { latencyMs }, startedAt: T0, completedAt: T1 };
}

/**
 * A budget-HONORING production runner（mirrors the colima runner's chain:
 * preDispatch in onPhaseStart → recordConsumption in onPhaseTerminal）.
 */
function honoringRunner(recorded, { phases = ["P1", "P2"] } = {}) {
  return async (opts) => {
    recorded.push(opts);
    const enc = opts.budget?.enforcement;
    const nodes = [];
    let hold = null;
    for (const phaseId of phases) {
      const gate = enc.preDispatch({ executionId: "g", phase_id: phaseId, nodeId: phaseId, attempt: 0, runtime: { mode: "readonly", limits: { timeoutMs: 60000 } } });
      if (!gate.ok) { hold = gate; break; }
      const settled = enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5000 });
      assert.equal(settled.ok, true, JSON.stringify(settled));
      nodes.push(nodeResult(phaseId));
    }
    return {
      final: hold ? "HOLD" : "PASS",
      holdCode: hold?.holdCode ?? null,
      reason: hold?.reason ?? null,
      executionId: "g",
      nodeResults: nodes,
      transitions: [],
      startedAt: new Date(T0).toISOString(),
      completedAt: new Date(T1).toISOString(),
      admission: opts.admission,
    };
  };
}

test("wiring: admitted run derives envelope + enforcement; runner honors it; PASS with budget evidence", async () => {
  const calls = [];
  const rec = admission();
  const r = await runAdmittedGraph({ admission: rec, runner: honoringRunner(calls) });
  assert.equal(r.final, "PASS");
  assert.equal(calls.length, 1);
  // the runner received the enforcement + the unchanged frozen admission
  assert.equal(calls[0].admission, rec);
  assert.ok(calls[0].budget.enforcement, "enforcement injected into the runner");
  // budget section attached（authorized, reconciled, no divergence）
  assert.equal(r.budget.authorized, true);
  assert.equal(r.budget.surface, "production");
  assert.equal(r.budget.admissionId, rec.admission_id);
  assert.deepEqual(r.budget.reconciliation.diverged, []);
  assert.equal(r.budget.dimensions.node_execution_count.consumed, 2);
});

test("wiring: NEG13 — a runner that bypasses the budget chain is caught by reconciliation (HOLD)", async () => {
  const rec = admission();
  // this "runner" executes nodes WITHOUT honoring the budget hooks.
  const bypassRunner = async () => ({
    final: "PASS",
    executionId: "g",
    nodeResults: [nodeResult("P1"), nodeResult("P2")],
    transitions: [],
    startedAt: new Date(T0).toISOString(),
    completedAt: new Date(T1).toISOString(),
  });
  const r = await runAdmittedGraph({ admission: rec, runner: bypassRunner });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "BUDGET_RECONCILIATION_DIVERGED");
  assert.ok(r.reason.includes("node_execution_count"), r.reason);
});

test("wiring: NEG4 — exhaustion blocks dispatch at the entrypoint (runner observes no new dispatch)", async () => {
  const rec = admission({ dimensions: { ...DIMS, node_execution_count: { limit: 1 } } });
  const r = await runAdmittedGraph({ admission: rec, runner: honoringRunner([], { phases: ["P1", "P2", "P3"] }) });
  // 1 node dispatched, the rest blocked -> the runner returns HOLD deterministically
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "BUDGET_EXHAUSTED");
  assert.equal(r.nodeResults.length, 1, "only the first node may dispatch");
});

test("wiring: budget authority invalid -> HOLD BEFORE the runner is invoked (spy never called)", async () => {
  const calls = [];
  const rec = admission({ dimensions: { tool_call_count: { limit: 5 } } }); // unsupported meter
  const r = await runAdmittedGraph({ admission: rec, runner: honoringRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "BUDGET_AUTHORITY_INVALID");
  assert.equal(calls.length, 0, "runner must never be invoked with an invalid budget authority");
  assert.equal(r.budget.authorized, false);
});

test("wiring: NEG12 — malformed checkpointState -> HOLD before dispatch", async () => {
  const calls = [];
  const rec = admission();
  const r = await runAdmittedGraph({
    admission: rec,
    runner: honoringRunner(calls),
    budget: { checkpointState: { schema: "x" } },
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "BUDGET_AUTHORITY_INVALID");
  assert.equal(calls.length, 0);
});

test("wiring: B3/NEG5 — resume via checkpointState accumulates (never resets)", async () => {
  const rec = admission();
  // run 1: one node consumed
  const r1 = await runAdmittedGraph({ admission: rec, runner: honoringRunner([], { phases: ["P1"] }) });
  assert.equal(r1.final, "PASS");
  const checkpoint = r1.budget.checkpoint;
  assert.equal(checkpoint.counters.node_execution_count, 1);
  // run 2: resume from the checkpoint, consume one more node
  const r2 = await runAdmittedGraph({
    admission: rec,
    runner: honoringRunner([], { phases: ["P2"] }),
    budget: { checkpointState: checkpoint },
  });
  assert.equal(r2.final, "PASS");
  assert.equal(r2.budget.dimensions.node_execution_count.consumed, 2, "cumulative across the resume boundary");
  assert.equal(r2.budget.reconciliation.diverged.length, 0);
});

test("wiring: no admission -> HOLD / ADMISSION_REQUIRED（extended TA-2 gate, budget context）", async () => {
  const calls = [];
  const r = await runAdmittedGraph({ admission: null, runner: honoringRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "ADMISSION_REQUIRED");
  assert.equal(calls.length, 0);
});

test("wiring: direct low-level runner compat surface is NOT budget-authorized (NEG14)", async () => {
  const { attachBudgetResult } = await import("../../src/budget/graph-wiring.mjs");
  const compat = attachBudgetResult({ final: "PASS", nodeResults: [] }, null);
  assert.equal(compat.budget.authorized, false);
  assert.equal(compat.budget.surface, "compat");
  // the production entry result IS authorized
  const rec = admission();
  const r = await runAdmittedGraph({ admission: rec, runner: honoringRunner([]) });
  assert.equal(r.budget.authorized, true);
});
