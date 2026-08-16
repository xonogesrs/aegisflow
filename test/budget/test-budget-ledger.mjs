// test/budget/test-budget-ledger.mjs
//
// AUTOLOOP-TA3 — budget LEDGER（cumulative accounting + crash/resume）.
//   - reserve/settle lifecycle with conservative upper-bound reservation;
//   - BUDGET_EXHAUSTED blocks further reservation（never "just a bit over"）;
//   - B3: crash + resume NEVER resets consumption（cumulative）;
//   - §6: in-flight reservations settle at their upper bound on resume;
//   - double-spend / duplicate-work prevention（opKey uniqueness）;
//   - deterministic reconstruction from the receipt log（NEG13 baseline）;
//   - NEG12: malformed / tampered state fails closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import { deriveBudgetEnvelope } from "../../src/budget/envelope.mjs";
import {
  createBudgetLedger,
  resumeBudgetLedger,
  reconstructBudgetLedger,
  checkpointBudgetLedger,
  remainingBudget,
  ledgerReserve,
  ledgerSettle,
  ledgerConfirm,
  mergeChildCounters,
} from "../../src/budget/ledger.mjs";

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

function envelope({ dimensions, ratio = 0.8 } = {}) {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const rec = freezeAdmission(buildAdmissionRecord({
    taskId: "LEDGER-TEST",
    classification: c,
    mutationScope: ["docs/"],
    extensions: { budget: { schema: "autoloop.budget-contract/v1", version: 1, approachingRatio: ratio, dimensions } },
  }));
  const r = deriveBudgetEnvelope(rec);
  assert.equal(r.ok, true);
  return r.envelope;
}

const DIMS = {
  node_execution_count: { limit: 3 },
  wall_clock_ms: { limit: 600000 },
  sub_agent_execution_count: { limit: 2 },
  repair_attempt_count: { limit: 2 },
  verifier_reviewer_attempts: { limit: 2 },
  retry_count: { limit: 2 },
};

function runNode(ledger, env, opKey, { wallMs = 10, subagent = false } = {}) {
  const amounts = { node_execution_count: 1, ...(subagent ? { sub_agent_execution_count: 1 } : {}), wall_clock_ms: 60000 };
  const r = ledgerReserve(ledger, env, { opKey, amounts });
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = ledgerSettle(ledger, env, { opKey, actualAmounts: { node_execution_count: 1, ...(subagent ? { sub_agent_execution_count: 1 } : {}), wall_clock_ms: wallMs } });
  assert.equal(s.ok, true, JSON.stringify(s));
  return s;
}

test("ledger: reserve -> settle records exact consumption; remaining shrinks", () => {
  const env = envelope({ dimensions: DIMS });
  const ledger = createBudgetLedger({ envelope: env });
  runNode(ledger, env, "g1:n1:0", { wallMs: 250 });
  assert.equal(ledger.counters.node_execution_count, 1);
  assert.equal(ledger.counters.wall_clock_ms, 250);
  const rem = remainingBudget(env, ledger);
  assert.equal(rem.node_execution_count, 2);
  assert.equal(rem.wall_clock_ms, 600000 - 250);
});

test("ledger: NEG4 — exhausted budget blocks new reservation (never overrun)", () => {
  const env = envelope({ dimensions: DIMS });
  const ledger = createBudgetLedger({ envelope: env });
  runNode(ledger, env, "g1:n1:0");
  runNode(ledger, env, "g1:n2:0");
  runNode(ledger, env, "g1:n3:0");
  // node_execution_count limit = 3 -> the 4th dispatch MUST be rejected.
  const r = ledgerReserve(ledger, env, { opKey: "g1:n4:0", amounts: { node_execution_count: 1, wall_clock_ms: 60000 } });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, "BUDGET_EXHAUSTED");
  // sub-agent dimension also enforced independently
  const env2 = envelope({ dimensions: DIMS });
  const l2 = createBudgetLedger({ envelope: env2 });
  runNode(l2, env2, "g2:s1:0", { subagent: true });
  runNode(l2, env2, "g2:s2:0", { subagent: true });
  const r2 = ledgerReserve(l2, env2, { opKey: "g2:s3:0", amounts: { node_execution_count: 1, sub_agent_execution_count: 1, wall_clock_ms: 60000 } });
  assert.equal(r2.ok, false);
  assert.equal(r2.holdCode, "BUDGET_EXHAUSTED");
});

test("ledger: B3 — crash + resume never resets consumption (cumulative)", () => {
  const env = envelope({ dimensions: DIMS });
  const ledger = createBudgetLedger({ envelope: env });
  runNode(ledger, env, "g1:n1:0", { wallMs: 100 });
  runNode(ledger, env, "g1:n2:0", { wallMs: 200 });
  // crash: node n3 is reserved but the process dies BEFORE settlement.
  const reserve = ledgerReserve(ledger, env, { opKey: "g1:n3:0", amounts: { node_execution_count: 1, wall_clock_ms: 60000 } });
  assert.equal(reserve.ok, true);
  const checkpoint = checkpointBudgetLedger(ledger);
  assert.equal(checkpoint.inFlight["g1:n3:0"] !== undefined, true);

  // resume in a NEW process with the same envelope -> counters continue.
  const resumed = resumeBudgetLedger({ envelope: env, state: checkpoint });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  // cumulative: 2 settled nodes + the in-flight node settled at upper bound.
  assert.equal(resumed.ledger.counters.node_execution_count, 3);
  assert.equal(resumed.ledger.counters.wall_clock_ms, 100 + 200 + 60000);
  assert.equal(resumed.ledger.generation, 1);
  assert.equal(Object.keys(resumed.ledger.inFlight).length, 0, "in-flight settled at upper bound");
  // a FRESH ledger would be 0 — resume must never look like a fresh start.
  const fresh = createBudgetLedger({ envelope: env });
  assert.equal(fresh.counters.node_execution_count, 0);
});

test("ledger: deterministic reconstruction — the receipt log replays to identical counters", () => {
  const env = envelope({ dimensions: DIMS });
  const ledger = createBudgetLedger({ envelope: env });
  runNode(ledger, env, "g1:n1:0", { wallMs: 100 });
  runNode(ledger, env, "g1:n2:0", { wallMs: 200 });
  ledgerConfirm(ledger, env, { dimension: "repair_attempt_count", amount: 1, reason: "r" });
  const events = ledger.events.slice();
  const r1 = reconstructBudgetLedger({ envelope: env, events });
  const r2 = reconstructBudgetLedger({ envelope: env, events });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.ledger.counters, ledger.counters);
  assert.deepEqual(r1.ledger.counters, r2.ledger.counters, "reconstruction is deterministic");
});

test("ledger: NEG12 — malformed / tampered resume state fails closed", () => {
  const env = envelope({ dimensions: DIMS });
  const ledger = createBudgetLedger({ envelope: env });
  runNode(ledger, env, "g1:n1:0");
  const cp = checkpointBudgetLedger(ledger);
  // envelope mismatch（different admission）
  const env2 = envelope({ dimensions: { ...DIMS, node_execution_count: { limit: 9 } } });
  const badEnv = resumeBudgetLedger({ envelope: env2, state: cp });
  assert.equal(badEnv.ok, false);
  assert.equal(badEnv.holdCode, "BUDGET_AUTHORITY_INVALID");
  // tampered counters vs receipt log
  const forged = { ...cp, counters: { ...cp.counters, node_execution_count: 999 } };
  const badCounters = resumeBudgetLedger({ envelope: env, state: forged });
  assert.equal(badCounters.ok, false);
  // garbage state
  const badShape = resumeBudgetLedger({ envelope: env, state: { schema: "nope" } });
  assert.equal(badShape.ok, false);
  assert.equal(badShape.holdCode, "BUDGET_AUTHORITY_INVALID");
});

test("ledger: double-spend prevention — re-reserving the same opKey fails closed", () => {
  const env = envelope({ dimensions: DIMS });
  const ledger = createBudgetLedger({ envelope: env });
  const r1 = ledgerReserve(ledger, env, { opKey: "g1:n1:0", amounts: { node_execution_count: 1, wall_clock_ms: 60000 } });
  assert.equal(r1.ok, true);
  const r2 = ledgerReserve(ledger, env, { opKey: "g1:n1:0", amounts: { node_execution_count: 1, wall_clock_ms: 60000 } });
  assert.equal(r2.ok, false);
  assert.equal(r2.holdCode, "BUDGET_RESERVATION_CONFLICT");
  // settling an unreserved opKey fails closed（consumption without reservation）
  const bad = ledgerSettle(ledger, env, { opKey: "g1:zzz:0", actualAmounts: { node_execution_count: 1 } });
  assert.equal(bad.ok, false);
});

test("ledger: B2 — child merge is monotonic; child over parent remaining fails closed", () => {
  const env = envelope({ dimensions: DIMS });
  const ledger = createBudgetLedger({ envelope: env });
  runNode(ledger, env, "g1:n1:0"); // parent consumed 1/3 nodes
  // child consumes 2 nodes -> parent would reach 3/3 (ok)
  const ok = mergeChildCounters(ledger, env, { node_execution_count: 2 });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ledger.counters.node_execution_count, 3);
  // child consumes 1 more -> parent would reach 4/3 -> fail closed
  const over = mergeChildCounters(ledger, env, { node_execution_count: 1 });
  assert.equal(over.ok, false);
  assert.equal(over.holdCode, "BUDGET_CHILD_EXCEEDS_PARENT");
  assert.equal(ledger.counters.node_execution_count, 3, "parent counters unchanged on rejection");
});

test("ledger: B4 — repair_attempt_count is a runtime meter, separate from any repair budget authority", () => {
  const env = envelope({ dimensions: DIMS });
  const ledger = createBudgetLedger({ envelope: env });
  ledgerConfirm(ledger, env, { dimension: "repair_attempt_count", amount: 1, reason: "r1" });
  ledgerConfirm(ledger, env, { dimension: "repair_attempt_count", amount: 1, reason: "r2" });
  assert.equal(ledger.counters.repair_attempt_count, 2);
  // the ledger carries NO repair-budget authority field（never merged）.
  assert.equal(ledger.repair_budget, undefined);
  assert.equal(ledger.repairBudget, undefined);
  // other runtime counters untouched
  assert.equal(ledger.counters.node_execution_count, 0);
});
