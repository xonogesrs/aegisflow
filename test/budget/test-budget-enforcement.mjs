// test/budget/test-budget-enforcement.mjs
//
// AUTOLOOP-TA3 — budget ENFORCEMENT（admission → envelope → ledger → state）.
// The full NEG suite（NEG1..NEG14）at the enforcement layer:
//   NEG1  production execution without a budget-bearing admission -> HOLD
//   NEG2  runtime raising the admission budget -> reject（envelope frozen）
//   NEG3  child budget > parent remaining -> reject
//   NEG4  budget exhausted -> no further dispatch
//   NEG5  crash + resume resets consumption -> reject（cumulative）
//   NEG6  retry obtaining a fresh budget -> reject（same envelope）
//   NEG7  sub-agent independently establishing a higher budget -> reject
//   NEG8  required meter missing -> fail closed（unsupported meter declared）
//   NEG9  unsupported meter read as 0 -> reject
//   NEG10 repair budget merged into runtime counter -> reject（separate）
//   NEG11 enforcement failure only warning/log -> reject（structured HOLD）
//   NEG12 malformed/tampered budget state after restore -> HOLD
//   NEG13 consumption divergence runtime evidence vs closeout -> HOLD
//   NEG14 legacy/internal runner as production-authorized -> reject

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission, deriveAdmissionId } from "../../src/admission/admission-record.mjs";
import { createBudgetEnforcement, BUDGET_HOLD_CODES } from "../../src/budget/enforcement.mjs";
import { assertEnvelopeUntampered } from "../../src/budget/envelope.mjs";
import { BUDGET_CONTRACT_SCHEMA, BUDGET_STATES } from "../../src/budget/contract.mjs";

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

function admission({ dimensions = null, text = "fix one typo in README", repairBudget = null } = {}) {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals(text) });
  const extensions = dimensions ? { budget: { schema: BUDGET_CONTRACT_SCHEMA, version: 1, dimensions } } : {};
  const rec = buildAdmissionRecord({ taskId: "ENF-TEST", classification: c, mutationScope: ["docs/"], extensions });
  if (repairBudget !== null) rec.repair_budget = repairBudget;
  return freezeAdmission(rec);
}

const DIMS = {
  node_execution_count: { limit: 2 },
  wall_clock_ms: { limit: 600000 },
  sub_agent_execution_count: { limit: 1 },
  repair_attempt_count: { limit: 2 },
  verifier_reviewer_attempts: { limit: 2 },
  retry_count: { limit: 2 },
};

function enforce(admissionRecord, extra = {}) {
  const r = createBudgetEnforcement({ admission: admissionRecord, ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.enforcement;
}

function dispatchNode(enc, phaseId, { wallMs = 10, subagent = false, timeoutMs = 60000 } = {}) {
  const g = enc.preDispatch({ executionId: "g", phase_id: phaseId, nodeId: phaseId, attempt: 0, runtime: { mode: subagent ? "subagent" : "readonly", limits: { timeoutMs } } });
  if (!g.ok) return g;
  const s = enc.recordConsumption({
    opKey: g.opKey,
    actualAmounts: { node_execution_count: 1, ...(subagent ? { sub_agent_execution_count: 1 } : {}) },
    wallClockMs: wallMs,
  });
  return s.ok ? { ok: true, state: s.state } : s;
}

test("NEG1: enforcement requires a budget-bearing frozen admission", () => {
  const r = createBudgetEnforcement({ admission: null });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, "BUDGET_AUTHORITY_INVALID");
  // admission with an invalid budget contract（unsupported meter）also fails
  const rec = admission({ dimensions: { token_budget: { limit: 1 } } });
  const r2 = createBudgetEnforcement({ admission: rec });
  assert.equal(r2.ok, false);
  assert.equal(r2.holdCode, "BUDGET_AUTHORITY_INVALID");
});

test("NEG2: runtime cannot raise the admission budget (envelope frozen + id-bound)", () => {
  const enc = enforce(admission({ dimensions: DIMS }));
  const limitBefore = enc.envelope.dimensions.node_execution_count.limit;
  assert.throws(() => { enc.envelope.dimensions.node_execution_count.limit = 9999; }, TypeError);
  assert.equal(enc.envelope.dimensions.node_execution_count.limit, limitBefore);
  // re-derivation proof: an envelope with a widened limit fails the
  // untampered check（the frozen envelopeId no longer matches the payload）.
  const forged = { ...enc.envelope, dimensions: { ...enc.envelope.dimensions, node_execution_count: { ...enc.envelope.dimensions.node_execution_count, limit: 9999 } } };
  const check = assertEnvelopeUntampered(forged);
  assert.equal(check.ok, false);
  assert.equal(check.holdCode, "BUDGET_AUTHORITY_INVALID");
  // the legitimately-derived envelope still validates（unchanged authority）.
  assert.equal(assertEnvelopeUntampered(enc.envelope).ok, true);
});

test("NEG3: child budget > parent remaining -> rejected (monotonic B2)", () => {
  const enc = enforce(admission({ dimensions: DIMS }));
  dispatchNode(enc, "n1", { wallMs: 5 }); // parent consumed 1/2 nodes
  const child = enc.projectChild({ childLimits: { node_execution_count: 5 } });
  assert.equal(child.ok, false);
  assert.equal(child.holdCode, "BUDGET_CHILD_EXCEEDS_PARENT");
  // a child within remaining is fine and capped at remaining
  const ok = enc.projectChild({ childLimits: { node_execution_count: 1 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.limits.node_execution_count, 1);
  assert.equal(ok.childEnforcement.envelope.dimensions.node_execution_count.limit, 1);
});

test("NEG4: budget exhausted -> further dispatch rejected", () => {
  const enc = enforce(admission({ dimensions: DIMS }));
  assert.equal(dispatchNode(enc, "n1", { wallMs: 5 }).ok, true);
  assert.equal(dispatchNode(enc, "n2", { wallMs: 5 }).ok, true);
  assert.equal(enc.state(), "BUDGET_EXHAUSTED");
  const r = enc.preDispatch({ executionId: "g", phase_id: "n3", nodeId: "n3", attempt: 0, runtime: { limits: { timeoutMs: 60000 } } });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, "BUDGET_EXHAUSTED");
});

test("NEG5: crash + resume resets consumption -> reject (resume is cumulative)", () => {
  const rec = admission({ dimensions: DIMS });
  const enc = enforce(rec);
  dispatchNode(enc, "n1", { wallMs: 5 });
  const checkpoint = enc.checkpointState();
  // a NEW process resumes from the checkpoint — the counters continue.
  const resumed = createBudgetEnforcement({ admission: rec, checkpointState: checkpoint });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.enforcement.ledger.counters.node_execution_count, 1);
  // post-resume consumption accumulates on top
  dispatchNode(resumed.enforcement, "n2", { wallMs: 5 });
  assert.equal(resumed.enforcement.ledger.counters.node_execution_count, 2);
  // a "fresh" enforcement would report 0 — the resumed run must NOT reset.
  const fresh = enforce(rec);
  assert.equal(fresh.ledger.counters.node_execution_count, 0);
});

test("NEG6: retry does not obtain a fresh budget (same envelope, retry counted)", () => {
  const enc = enforce(admission({ dimensions: DIMS }));
  const envId = enc.envelope.envelopeId;
  dispatchNode(enc, "n1", { wallMs: 5 });
  enc.recordRetry({ nodeId: "n1" });
  enc.recordRetry({ nodeId: "n1" });
  assert.equal(enc.ledger.counters.retry_count, 2);
  assert.equal(enc.envelope.envelopeId, envId, "retries must never mint a new envelope");
  // exceeding the retry budget exhausts the run
  const r = enc.recordRetry({ nodeId: "n1" });
  assert.equal(enc.state(), "BUDGET_EXHAUSTED");
});

test("NEG7: sub-agent cannot independently establish a higher budget", () => {
  const parent = enforce(admission({ dimensions: DIMS }));
  dispatchNode(parent, "n1", { wallMs: 5 }); // remaining node_execution_count = 1
  // a forged child under the parent with a limit above remaining is rejected
  const forgedChildAdmission = admission({
    dimensions: { ...DIMS, node_execution_count: { limit: 10 } },
  });
  const forged = createBudgetEnforcement({ admission: forgedChildAdmission, parentEnforcement: parent });
  assert.equal(forged.ok, false);
  assert.equal(forged.holdCode, "BUDGET_CHILD_EXCEEDS_PARENT");
  // legitimate projection is capped at parent remaining
  const child = parent.projectChild({});
  assert.equal(child.ok, true);
  assert.ok(child.limits.node_execution_count <= 1, `child node limit ${child.limits.node_execution_count} <= parent remaining 1`);
});

test("NEG8/NEG9: required meter missing / unsupported meter as 0 -> fail closed", () => {
  // unsupported meter（tokens / tool calls）declared -> BUDGET_AUTHORITY_INVALID
  const rec = admission({ dimensions: { tool_call_count: { limit: 5 } } });
  const r = createBudgetEnforcement({ admission: rec });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, "BUDGET_AUTHORITY_INVALID");
  // the enforcement never reads an unsupported meter as 0 consumption.
  const enc = enforce(admission({ dimensions: DIMS }));
  assert.equal(enc.consumption().token_budget, undefined, "no fake token dimension");
});

test("NEG10: repair budget authority stays separate from runtime counters", () => {
  const rec = admission({ dimensions: DIMS, repairBudget: 1 });
  const enc = enforce(rec);
  assert.equal(rec.repair_budget, 1);
  enc.recordRepair({ nodeId: "n1" });
  enc.recordRepair({ nodeId: "n1" });
  assert.equal(enc.ledger.counters.repair_attempt_count, 2);
  // the admission repair budget authority is untouched by runtime accounting
  assert.equal(rec.repair_budget, 1);
  // the runtime ledger never carries the repair-budget authority field
  assert.equal(enc.ledger.repair_budget, undefined);
  assert.equal(enc.ledger.repairBudget, undefined);
});

test("NEG11: enforcement failures are structured HOLDs, never warning-only", () => {
  const enc = enforce(admission({ dimensions: DIMS }));
  // exhaust node budget, then ask for dispatch
  dispatchNode(enc, "n1", { wallMs: 5 });
  dispatchNode(enc, "n2", { wallMs: 5 });
  const r = enc.preDispatch({ executionId: "g", phase_id: "n3", nodeId: "n3", attempt: 0, runtime: { limits: { timeoutMs: 60000 } } });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, "BUDGET_EXHAUSTED");
  // every failure returns { ok:false, holdCode, reason } — the state machine
  // has no "warn and continue" branch for enforcement failures.
  for (const [label, res] of Object.entries({ exhaustion: r })) {
    assert.equal(typeof res.reason, "string", label);
    assert.ok(BUDGET_HOLD_CODES[res.holdCode] !== undefined, label);
  }
  assert.deepEqual(BUDGET_STATES, ["CONTINUE", "APPROACHING_LIMIT", "BUDGET_EXHAUSTED", "BUDGET_AUTHORITY_INVALID"]);
});

test("NEG12: malformed/tampered budget state after restore -> HOLD", () => {
  const rec = admission({ dimensions: DIMS });
  const enc = enforce(rec);
  dispatchNode(enc, "n1", { wallMs: 5 });
  const cp = enc.checkpointState();
  // tampered envelope id
  const tampered = { ...cp, envelopeId: "0".repeat(64) };
  const r1 = createBudgetEnforcement({ admission: rec, checkpointState: tampered });
  assert.equal(r1.ok, false);
  assert.equal(r1.holdCode, "BUDGET_AUTHORITY_INVALID");
  // malformed state（garbage）
  const r2 = createBudgetEnforcement({ admission: rec, checkpointState: { schema: "x" } });
  assert.equal(r2.ok, false);
  assert.equal(r2.holdCode, "BUDGET_AUTHORITY_INVALID");
  // counter divergence from the receipt log
  const forgedCounters = { ...cp, counters: { ...cp.counters, node_execution_count: 99 } };
  const r3 = createBudgetEnforcement({ admission: rec, checkpointState: forgedCounters });
  assert.equal(r3.ok, false);
});

test("NEG13: consumption divergence between runtime evidence and closeout -> HOLD", () => {
  const enc = enforce(admission({ dimensions: DIMS }));
  dispatchNode(enc, "n1", { wallMs: 5 });
  // the graph result claims TWO executed nodes but the ledger recorded ONE.
  const result = {
    final: "PASS",
    nodeResults: [
      { nodeId: "n1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } },
      { nodeId: "n2", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } },
    ],
    transitions: [],
    startedAt: new Date(1700000000000).toISOString(),
    completedAt: new Date(1700000005010).toISOString(),
  };
  const finalized = enc.finalize(result);
  assert.equal(finalized.final, "HOLD");
  assert.equal(finalized.holdCode, "BUDGET_RECONCILIATION_DIVERGED");
  assert.ok(finalized.reason.includes("node_execution_count"), finalized.reason);
});

test("NEG14: compat surface is never budget-authorized (authorized only via production entry)", async () => {
  const { attachBudgetResult } = await import("../../src/budget/graph-wiring.mjs");
  const compat = attachBudgetResult({ final: "PASS", nodeResults: [] }, null);
  assert.equal(compat.budget.authorized, false);
  assert.equal(compat.budget.surface, "compat");
  // a valid enforced run attaches authorized:true
  const enc = enforce(admission({ dimensions: DIMS }));
  const authorized = attachBudgetResult({ final: "PASS", nodeResults: [], transitions: [] }, enc);
  assert.equal(authorized.budget.authorized, true);
  assert.equal(authorized.budget.surface, "production");
});

test("state transitions: CONTINUE -> APPROACHING_LIMIT -> BUDGET_EXHAUSTED", () => {
  const enc = enforce(admission({ dimensions: { ...DIMS, node_execution_count: { limit: 5 } }, text: "fix one typo in README" }));
  assert.equal(enc.state(), "CONTINUE");
  dispatchNode(enc, "n1", { wallMs: 5 }); // 1/5
  dispatchNode(enc, "n2", { wallMs: 5 }); // 2/5
  dispatchNode(enc, "n3", { wallMs: 5 }); // 3/5
  dispatchNode(enc, "n4", { wallMs: 5 }); // 4/5 -> 0.8 ratio reached -> APPROACHING
  assert.equal(enc.state(), "APPROACHING_LIMIT");
  dispatchNode(enc, "n5", { wallMs: 5 }); // 5/5
  assert.equal(enc.state(), "BUDGET_EXHAUSTED");
});

test("finalize: a clean enforced run attaches the budget evidence section (PASS preserved)", () => {
  const enc = enforce(admission({ dimensions: DIMS }));
  const g1 = dispatchNode(enc, "n1", { wallMs: 5 });
  assert.equal(g1.ok, true);
  const result = {
    final: "PASS",
    executionId: "g",
    nodeResults: [{ nodeId: "n1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } }],
    transitions: [],
    startedAt: new Date(1700000000000).toISOString(),
    completedAt: new Date(1700000005000).toISOString(),
  };
  const finalized = enc.finalize(result);
  assert.equal(finalized.final, "PASS");
  assert.equal(finalized.budget.schema, "autoloop.budget-enforcement-result/v1");
  assert.equal(finalized.budget.authorized, true);
  assert.equal(finalized.budget.dimensions.node_execution_count.consumed, 1);
  assert.deepEqual(finalized.budget.reconciliation.diverged, []);
});
