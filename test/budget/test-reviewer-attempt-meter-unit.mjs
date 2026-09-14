// test/budget/test-reviewer-attempt-meter-unit.mjs
//
// AUTOLOOP-V1-VERIFIER-REVIEWER-ATTEMPT-METER-UNIT-REPAIR-1
// Canonical unit: one LOGICAL_REVIEW_ATTEMPT per real reviewer invocation.
// reviewer + reviewer_verdict evidence events are NOT two budget units.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import {
  BUDGET_CONTRACT_SCHEMA,
  LOGICAL_REVIEW_ATTEMPT,
  countLogicalReviewerAttempts,
  DIMENSION_METER_MAP,
} from "../../src/budget/contract.mjs";
import { createBudgetEnforcement } from "../../src/budget/enforcement.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";
import { createDirectExecutionRunner } from "../../src/sop/proportional-sop.mjs";
import { buildPhaseTaskCard, deriveScopePatterns } from "../../src/v2/phase-task-card.mjs";
import { captureScopeSnapshot } from "../../src/c2d/mutation-scope.mjs";
import { coordinate, executeSequentially } from "../../src/control-plane/coordinator.mjs";
import { fastPathAdmission, taskInput } from "../control-plane/helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_EVIDENCE = JSON.parse(
  readFileSync(resolve(HERE, "../fixtures", "implementation-evidence-valid.json"), "utf8"),
);

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

function budgetAdmission({ reviewerLimit = 1, nodeLimit = 4, repairLimit = 2, retryLimit = 2 } = {}) {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const rec = buildAdmissionRecord({
    taskId: "METER-UNIT",
    classification: c,
    mutationScope: ["docs/"],
    extensions: {
      budget: {
        schema: BUDGET_CONTRACT_SCHEMA,
        version: 1,
        dimensions: {
          node_execution_count: { limit: nodeLimit },
          wall_clock_ms: { limit: 600000 },
          sub_agent_execution_count: { limit: 1 },
          repair_attempt_count: { limit: repairLimit },
          verifier_reviewer_attempts: { limit: reviewerLimit },
          retry_count: { limit: retryLimit },
        },
      },
    },
  });
  return freezeAdmission(rec);
}

function pairEvents(attempt = 0) {
  return [
    { phase: "reviewer", attempt, status: "completed" },
    { phase: "reviewer_verdict", attempt, verdict: "PASS", recommended_next_action: "STOP" },
  ];
}

function graphTransitions(nodes) {
  return nodes.map((n) => ({
    phaseId: n.phaseId,
    executionId: "g",
    final: n.final ?? "PASS",
    attempt: n.attempt ?? 0,
    lifecycleTransitions: n.events,
  }));
}

function finalizeWith(enc, { nodes = 1, transitions = [], final = "PASS" } = {}) {
  for (let i = 0; i < nodes; i++) {
    const gate = enc.preDispatch({
      executionId: "g",
      phase_id: `n${i}`,
      nodeId: `n${i}`,
      attempt: 0,
      runtime: { limits: { timeoutMs: 60000 } },
    });
    assert.equal(gate.ok, true, JSON.stringify(gate));
    const settled = enc.recordConsumption({
      opKey: gate.opKey,
      actualAmounts: { node_execution_count: 1 },
      wallClockMs: 5,
    });
    assert.equal(settled.ok, true, JSON.stringify(settled));
  }
  const nodeResults = Array.from({ length: nodes }, (_, i) => ({
    nodeId: `n${i}`,
    final: "PASS",
    attempt: 0,
    resultIdentity: { latencyMs: 5 },
  }));
  return enc.finalize({
    final,
    nodeResults,
    transitions,
    startedAt: new Date(1700000000000).toISOString(),
    completedAt: new Date(1700000005000).toISOString(),
  });
}

// ── T1 / T2 unit ──────────────────────────────────────────────────────────

test("T1/T2: a reviewer+reviewer_verdict pair is 1 LOGICAL_REVIEW_ATTEMPT, not 2", () => {
  const flat = pairEvents(0);
  assert.equal(countLogicalReviewerAttempts(flat), 1);
  assert.notEqual(countLogicalReviewerAttempts(flat), 2, "events must not equal attempts");
  const nested = graphTransitions([{ phaseId: "P1", events: flat }]);
  assert.equal(countLogicalReviewerAttempts(nested), 1);
  assert.equal(LOGICAL_REVIEW_ATTEMPT, "LOGICAL_REVIEW_ATTEMPT");
  assert.match(DIMENSION_METER_MAP.verifier_reviewer_attempts.meterSource, /LOGICAL_REVIEW_ATTEMPT/);
});

test("T2b: duplicate publication of the same slot still counts 1", () => {
  const dup = [...pairEvents(0), ...pairEvents(0)];
  assert.equal(countLogicalReviewerAttempts(dup), 1);
  const nestedDup = [
    { phaseId: "P1", lifecycleTransitions: pairEvents(0) },
    { phaseId: "P1", lifecycleTransitions: pairEvents(0) },
  ];
  assert.equal(countLogicalReviewerAttempts(nestedDup), 1);
});

test("T2c: lone reviewer (error/invalid) and lone verdict each count 1; two attempts count 2", () => {
  assert.equal(countLogicalReviewerAttempts([{ phase: "reviewer", attempt: 0, status: "error" }]), 1);
  assert.equal(countLogicalReviewerAttempts([{ phase: "reviewer_verdict", attempt: 0, verdict: "HOLD" }]), 1);
  assert.equal(countLogicalReviewerAttempts([...pairEvents(0), ...pairEvents(1)]), 2);
  assert.equal(
    countLogicalReviewerAttempts(graphTransitions([
      { phaseId: "A", events: pairEvents(0) },
      { phaseId: "B", events: pairEvents(0) },
    ])),
    2,
    "distinct nodes with attempt 0 are distinct logical attempts",
  );
});

test("T5/T6/T7: observer, ledger and finalize agree at 1; no divergence HOLD", () => {
  const enc = createBudgetEnforcement({ admission: budgetAdmission({ reviewerLimit: 1 }) }).enforcement;
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  enc.recordReviewer({ nodeId: "P1", attempt: 0 });
  const finalized = finalizeWith(enc, {
    nodes: 1,
    transitions: graphTransitions([{ phaseId: "P1", events: pairEvents(0) }]),
  });
  assert.equal(finalized.final, "PASS");
  assert.deepEqual(finalized.budget.reconciliation.diverged, []);
  assert.equal(finalized.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
  assert.equal(finalized.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
  assert.equal(finalized.budget.dimensions.verifier_reviewer_attempts.consumed, 1);
  assert.equal(finalized.budget.dimensions.verifier_reviewer_attempts.limit, 1);
});

test("T10: duplicate recordReviewer of the same slot does not consume twice; re-finalize is idempotent", () => {
  const enc = createBudgetEnforcement({ admission: budgetAdmission({ reviewerLimit: 2 }) }).enforcement;
  const gate = enc.admitReviewer({ nodeId: "P1", attempt: 0 });
  assert.equal(gate.ok, true);
  const a = enc.recordReviewer({ nodeId: "P1", attempt: 0 });
  const b = enc.recordReviewer({ nodeId: "P1", attempt: 0 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 1);
  const result = {
    final: "PASS",
    nodeResults: [{ nodeId: "n0", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } }],
    transitions: graphTransitions([{ phaseId: "P1", events: pairEvents(0) }]),
    startedAt: new Date(1700000000000).toISOString(),
    completedAt: new Date(1700000005000).toISOString(),
  };
  enc.preDispatch({ executionId: "g", phase_id: "n0", nodeId: "n0", attempt: 0, runtime: { limits: { timeoutMs: 60000 } } });
  enc.recordConsumption({ opKey: "g:n0:0", actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
  const f1 = enc.finalize(result);
  const f2 = enc.finalize(result);
  assert.deepEqual(f1.budget.reconciliation.diverged, []);
  assert.deepEqual(f2.budget.reconciliation.diverged, []);
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 1);
});

test("T11: used==limit after a successful first attempt does not rewrite PASS", () => {
  const enc = createBudgetEnforcement({ admission: budgetAdmission({ reviewerLimit: 1 }) }).enforcement;
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  enc.recordReviewer({ nodeId: "P1", attempt: 0 });
  const finalized = finalizeWith(enc, {
    nodes: 1,
    transitions: graphTransitions([{ phaseId: "P1", events: pairEvents(0) }]),
  });
  assert.equal(finalized.final, "PASS");
  assert.equal(finalized.holdCode, undefined);
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 1);
  const secondAdmit = enc.admitReviewer({ nodeId: "P1", attempt: 1 });
  assert.equal(secondAdmit.ok, false);
  assert.equal(secondAdmit.holdCode, "BUDGET_EXHAUSTED");
  const second = enc.recordReviewer({ nodeId: "P1", attempt: 1 });
  assert.equal(second.ok, false);
  assert.equal(second.holdCode, "BUDGET_AUTHORITY_INVALID", "settlement without reservation fails closed");
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 1, "overshoot refused");
});

test("T12: limit>1 counts each real invocation +1 and refuses the next confirm", () => {
  const enc = createBudgetEnforcement({ admission: budgetAdmission({ reviewerLimit: 2 }) }).enforcement;
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  assert.equal(enc.recordReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 1 }).ok, true);
  assert.equal(enc.recordReviewer({ nodeId: "P1", attempt: 1 }).ok, true);
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 2);
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 2 }).ok, false);
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 2 }).holdCode, "BUDGET_EXHAUSTED");
  const unreserved = enc.recordReviewer({ nodeId: "P1", attempt: 2 });
  assert.equal(unreserved.ok, false);
  assert.equal(unreserved.holdCode, "BUDGET_AUTHORITY_INVALID");
});

test("T13: telemetry/closeout keep both evidence events but report consumption 1", () => {
  const events = pairEvents(0);
  assert.equal(events.filter((e) => e.phase === "reviewer" || e.phase === "reviewer_verdict").length, 2);
  assert.equal(countLogicalReviewerAttempts(events), 1);
});

test("T14: graph-shaped and flat evidence of the same pair yield the same count", () => {
  const flat = pairEvents(0);
  const graph = graphTransitions([{ phaseId: "DIRECT_EXECUTION", events: flat }]);
  const colima = graphTransitions([{ phaseId: "P1", events: flat }]);
  const subagent = graphTransitions([{ phaseId: "SA-W1", events: flat }]);
  assert.equal(countLogicalReviewerAttempts(flat), 1);
  assert.equal(countLogicalReviewerAttempts(graph), 1);
  assert.equal(countLogicalReviewerAttempts(colima), 1);
  assert.equal(countLogicalReviewerAttempts(subagent), 1);
});

test("T16: single normalizer / ledger / meter unit authority", () => {
  assert.equal(typeof countLogicalReviewerAttempts, "function");
  assert.equal(DIMENSION_METER_MAP.verifier_reviewer_attempts.enforcementPoint, "onReviewerCompleted settlement");
  const src = readFileSync(resolve(HERE, "../../src/budget/enforcement.mjs"), "utf8");
  assert.match(src, /countLogicalReviewerAttempts\(transitions\)/);
  assert.doesNotMatch(src, /phase === "reviewer" \|\| phase === "reviewer_verdict"\) reviewerCount/);
  const sop = readFileSync(resolve(HERE, "../../src/sop/proportional-sop.mjs"), "utf8");
  assert.match(sop, /countLogicalReviewerAttempts/);
  const observer = readFileSync(resolve(HERE, "../../src/telemetry/graph-observer.mjs"), "utf8");
  assert.match(observer, /countLogicalReviewerAttempts/);
});

test("T17: other budget meters keep their units (repair still event-counts; nodes still terminals)", () => {
  const enc = createBudgetEnforcement({ admission: budgetAdmission({ reviewerLimit: 1 }) }).enforcement;
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  enc.recordReviewer({ nodeId: "P1", attempt: 0 });
  enc.recordRepair({ nodeId: "P1" });
  const finalized = finalizeWith(enc, {
    nodes: 1,
    transitions: graphTransitions([{
      phaseId: "P1",
      events: [...pairEvents(0), { phase: "repair", status: "REPAIR", attempt: 0 }],
    }]),
  });
  assert.deepEqual(finalized.budget.reconciliation.diverged, []);
  assert.equal(finalized.budget.reconciliation.observed.repair_attempt_count, 1);
  assert.equal(finalized.budget.reconciliation.ledger.repair_attempt_count, 1);
  assert.equal(finalized.budget.reconciliation.observed.node_execution_count, 1);
  assert.equal(finalized.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
});

test("T6 graph adapter: the reviewer settlement seam records 1 logical attempt and reconciles", async () => {
  const admission = budgetAdmission({ reviewerLimit: 1 });
  const enc = createBudgetEnforcement({ admission }).enforcement;
  // P7 subtraction re-point: wrapGraphHooks was REMOVED (M07, zero production
  // callers) — the settlement this test proves is the lifecycle
  // onReviewerCompleted contract wired directly by the production runners
  //（colima-graph-runner / SOP direct runner）.
  const settle = async (info) => {
    const s = enc.recordReviewer({ nodeId: info?.phaseId ?? null, attempt: info?.attempt ?? 0 });
    if (!s.ok && !s.duplicate) throw new Error("reviewer settlement failed closed");
    return s;
  };
  const gate = enc.admitReviewer({ nodeId: "P1" });
  assert.equal(gate.ok, true);
  await settle({ phaseId: "P1", attempt: 0, verdict: "PASS" });
  const finalized = finalizeWith(enc, {
    nodes: 1,
    transitions: graphTransitions([{ phaseId: "P1", events: pairEvents(0) }]),
  });
  assert.equal(finalized.final, "PASS");
  assert.deepEqual(finalized.budget.reconciliation.diverged, []);
  assert.equal(finalized.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
  assert.equal(finalized.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
});

test("T6b: observer=2 / ledger=1 divergence is gone — pair no longer HOLDs reconciliation", () => {
  const enc = createBudgetEnforcement({ admission: budgetAdmission({ reviewerLimit: 1 }) }).enforcement;
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  enc.recordReviewer({ nodeId: "P1", attempt: 0 });
  const finalized = finalizeWith(enc, {
    nodes: 1,
    transitions: graphTransitions([{ phaseId: "P1", events: pairEvents(0) }]),
  });
  assert.notEqual(finalized.holdCode, "BUDGET_RECONCILIATION_DIVERGED");
  assert.equal(finalized.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
});

// ── production direct path (T3/T4/T8/T9/T15/T18) ─────────────────────────

function makeGitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "meter-unit-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function evidenceJson(executionId) {
  return JSON.stringify({ ...FIXTURE_EVIDENCE, contract_id: executionId });
}

function verdictJson({ verdict = "PASS", confidence = "HIGH", model = "test-model", summary = "ok", recommended_next_action = "STOP" } = {}) {
  return JSON.stringify({ verdict, confidence, model, summary, recommended_next_action });
}

function makeTaskCard(cwd, executionId) {
  const phase = {
    phase_id: "p_direct", title: "Direct", summary: "writer", responsibility: "R1 impl", purpose: "implementation",
    effects: {
      artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
      evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] },
    },
    covers: [{ requirement_id: "R1", completeness: "complete", claim: "covers R1" }],
    depends_on: [],
  };
  const card = buildPhaseTaskCard({
    phase,
    parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
    executionId,
    cwd,
    maxRepairAttempts: 0,
    expectedReviewerModel: "test-model",
    toolPolicy: { mode: "no-tools" },
    environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  });
  card.verificationCommand = ["node", "-e", "process.exit(0)"];
  card.expectedExecutorModel = "deepseek-v4-flash";
  card.expectedExecutorProvider = "deepseek";
  card.mutationScope = {
    repositoryRoot: cwd,
    baselineSnapshot: captureScopeSnapshot(cwd),
    allowedPaths: deriveScopePatterns(card.allowedPaths),
    forbiddenPaths: deriveScopePatterns(card.forbiddenPaths),
  };
  return card;
}

function executorStep(executionId, attempt = 0) {
  return {
    expect: { phase: "executor", attempt },
    result: { status: "completed", stdout: evidenceJson(executionId), stderr: "", signal: null, error: null, metadata: {} },
  };
}
test("T9: pre-invocation fence leaves consumption at 0 and does not call reviewer", async () => {
  const cwd = makeGitFixture();
  try {
    const executionId = "exec_meter000000000000000000000000000z0";
    const admission = fastPathAdmission("METER-ZERO");
    const reviewerAdapter = createScriptedAdapter([reviewerStep(0, { verdict: "PASS" })]);
    const executorAdapter = createScriptedAdapter([executorStep(executionId, 0)]);
    const result = await runAdmittedGraph({
      admission,
      runner: createDirectExecutionRunner(),
      cwd,
      taskCard: makeTaskCard(cwd, executionId),
      executorAdapter,
      reviewerAdapter,
      timeoutMs: 30_000,
      maxRepairAttempts: 0,
      hooks: {
        onBeforeReviewer: async () => ({
          ok: false,
          holdCode: "BUDGET_EXHAUSTED",
          reason: "BUDGET_EXHAUSTED: reviewer not invoked",
        }),
      },
    });
    assert.equal(reviewerAdapter.callRecord.length, 0);
    assert.equal(result.final, "HOLD");
    assert.equal(result.holdCode, "BUDGET_EXHAUSTED");
    assert.equal(result.budget.reconciliation.ledger.verifier_reviewer_attempts, 0);
    assert.equal(result.budget.reconciliation.observed.verifier_reviewer_attempts, 0);
    assert.deepEqual(result.budget.reconciliation.diverged, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function reviewerStep(attempt, verdict) {
  return {
    expect: { phase: "reviewer", attempt },
    result: { status: "completed", stdout: verdictJson(verdict), stderr: "", signal: null, error: null, metadata: {} },
  };
}

async function runDirect({ reviewerLimit = 1, maxRepairAttempts = 0, reviewerSteps, extraExecutorSteps = [], reviewerAdapter, executionId = "exec_meter00000000000000000000000000001" } = {}) {
  const cwd = makeGitFixture();
  try {
    const executorAdapter = createScriptedAdapter([
      executorStep(executionId, 0),
      ...extraExecutorSteps.map((attempt) => executorStep(executionId, attempt)),
    ]);
    const reviewer = reviewerAdapter ?? createScriptedAdapter(reviewerSteps);
    const admission = fastPathAdmission("METER-S0");
    const result = await runAdmittedGraph({
      admission,
      runner: createDirectExecutionRunner(),
      cwd,
      taskCard: makeTaskCard(cwd, executionId),
      executorAdapter,
      reviewerAdapter: reviewer,
      timeoutMs: 30_000,
      maxRepairAttempts,
    });
    return { result, cwd, executorAdapter, reviewerAdapter: reviewer, admission };
  } catch (e) {
    rmSync(cwd, { recursive: true, force: true });
    throw e;
  }
}


test("T3/T15: FAST_PATH limit=1 first real reviewer runs, used=1/1, PASS preserved", async () => {
  const { result, cwd, executorAdapter, reviewerAdapter } = await runDirect({
    reviewerSteps: [reviewerStep(0, { verdict: "PASS", recommended_next_action: "STOP" })],
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.final, "PASS");
  assert.equal(executorAdapter.callRecord.length, 1);
  assert.equal(reviewerAdapter.callRecord.length, 1);
  assert.equal(result.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
  assert.equal(result.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
  assert.deepEqual(result.budget.reconciliation.diverged, []);
  assert.equal(result.budget.dimensions.verifier_reviewer_attempts.consumed, 1);
  assert.equal(result.budget.dimensions.verifier_reviewer_attempts.limit, 1);
  const lt = result.transitions[0].lifecycleTransitions;
  assert.ok(lt.some((t) => t.phase === "reviewer"));
  assert.ok(lt.some((t) => t.phase === "reviewer_verdict" && t.verdict === "PASS"));
});

test("T4: second real reviewer attempt is fenced before invocation", async () => {
  const { result, cwd, reviewerAdapter, executorAdapter } = await runDirect({
    maxRepairAttempts: 1,
    extraExecutorSteps: [1],
    reviewerSteps: [
      reviewerStep(0, { verdict: "HOLD", confidence: "HIGH", recommended_next_action: "REPAIR", summary: "repair" }),
      reviewerStep(1, { verdict: "PASS", recommended_next_action: "STOP" }),
    ],
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.final, "HOLD");
  assert.equal(result.holdCode, "BUDGET_EXHAUSTED");
  assert.equal(reviewerAdapter.callRecord.length, 1, "second reviewer must not be invoked");
  assert.ok(executorAdapter.callRecord.length >= 1);
  assert.equal(result.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
  assert.equal(result.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
  assert.deepEqual(result.budget.reconciliation.diverged, []);
});

test("T8 PASS/HOLD/invalid/error each consume exactly 1", async () => {
  const cases = [
    { name: "PASS", steps: [reviewerStep(0, { verdict: "PASS", recommended_next_action: "STOP" })], expectFinal: "PASS" },
    { name: "HOLD", steps: [reviewerStep(0, { verdict: "HOLD", confidence: "HIGH", recommended_next_action: "STOP", summary: "hold" })], expectFinal: "HOLD" },
    { name: "invalid", steps: [{ expect: { phase: "reviewer", attempt: 0 }, result: { status: "completed", stdout: "not-json", stderr: "", signal: null, error: null, metadata: {} } }], expectFinal: "HOLD" },
    { name: "error", steps: [{ expect: { phase: "reviewer", attempt: 0 }, result: { status: "error", stdout: "", stderr: "boom", signal: null, error: "boom", metadata: {} } }], expectFinal: "HOLD" },
  ];
  for (const c of cases) {
    const { result, cwd, reviewerAdapter } = await runDirect({
      executionId: `exec_meter0000000000000000000000000000${c.name.slice(0, 2)}`,
      reviewerSteps: c.steps,
    });
    rmSync(cwd, { recursive: true, force: true });
    assert.equal(result.final, c.expectFinal, c.name);
    assert.equal(reviewerAdapter.callRecord.length, 1, c.name);
    assert.equal(result.budget.reconciliation.ledger.verifier_reviewer_attempts, 1, `${c.name} ledger`);
    assert.equal(result.budget.reconciliation.observed.verifier_reviewer_attempts, 1, `${c.name} observer`);
    assert.deepEqual(result.budget.reconciliation.diverged, [], c.name);
  }

  const throwing = {
    runAdapter: async () => {
      throwing.calls = (throwing.calls ?? 0) + 1;
      throw new Error("reviewer exploded");
    },
    callRecord: [],
  };
  const { result, cwd } = await runDirect({
    executionId: "exec_meter000000000000000000000000000th",
    reviewerAdapter: throwing,
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.final, "HOLD");
  assert.equal(throwing.calls, 1);
  assert.equal(result.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
  assert.equal(result.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
  assert.deepEqual(result.budget.reconciliation.diverged, []);
});



test("T15 coordinator → lifecycle runner production path reports 1/1", async () => {
  const cwd = makeGitFixture();
  try {
    const executionId = "exec_sop00000000000000000000000000099";
    const executorAdapter = createScriptedAdapter([executorStep(executionId, 0)]);
    const reviewerAdapter = createScriptedAdapter([reviewerStep(0, { verdict: "PASS", recommended_next_action: "STOP" })]);
    const { plan } = coordinate({
      tasks: [taskInput("s0", fastPathAdmission("S0-METER"), {
        runnerOpts: {
          cwd,
          taskCard: makeTaskCard(cwd, executionId),
          executorAdapter,
          reviewerAdapter,
          timeoutMs: 30_000,
        },
      })],
    });
    const { results } = await executeSequentially({ plan });
    const r = results[0].result;
    assert.equal(results[0].dispatched, true);
    assert.equal(r.final, "PASS");
    assert.equal(r.executionPath, "direct");
    assert.equal(reviewerAdapter.callRecord.length, 1);
    assert.equal(r.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
    assert.equal(r.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
    assert.deepEqual(r.budget.reconciliation.diverged, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T15 graph runner path: admitted honoring runner + recordReviewer + pair evidence", async () => {
  const admission = budgetAdmission({ reviewerLimit: 1, nodeLimit: 2 });
  const result = await runAdmittedGraph({
    admission,
    runner: async (opts) => {
      const enc = opts.budget.enforcement;
      const gate = enc.preDispatch({ executionId: "g", phase_id: "P1", nodeId: "P1", attempt: 0, runtime: { limits: { timeoutMs: 60000 } } });
      assert.equal(gate.ok, true);
      const admit = enc.admitReviewer({ nodeId: "P1" });
      assert.equal(admit.ok, true);
      enc.recordReviewer({ nodeId: "P1", attempt: 0 });
      enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
      return {
        final: "PASS",
        nodeResults: [{ nodeId: "P1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } }],
        transitions: graphTransitions([{ phaseId: "P1", events: pairEvents(0) }]),
        startedAt: new Date(1700000000000).toISOString(),
        completedAt: new Date(1700000005000).toISOString(),
        closeout: { applied: false },
      };
    },
  });
  assert.equal(result.final, "PASS");
  assert.equal(result.budget.authorized, true);
  assert.deepEqual(result.budget.reconciliation.diverged, []);
  assert.equal(result.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
  assert.equal(result.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
});

test("T7 subagent-shaped evidence reconciles at 1 when settled once", () => {
  const enc = createBudgetEnforcement({ admission: budgetAdmission({ reviewerLimit: 1 }) }).enforcement;
  assert.equal(enc.admitReviewer({ nodeId: "SA-W1", attempt: 0 }).ok, true);
  enc.recordReviewer({ nodeId: "SA-W1", attempt: 0 });
  const finalized = finalizeWith(enc, {
    nodes: 1,
    transitions: graphTransitions([{ phaseId: "SA-W1", events: pairEvents(0) }]),
  });
  assert.equal(finalized.final, "PASS");
  assert.deepEqual(finalized.budget.reconciliation.diverged, []);
  assert.equal(finalized.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
  assert.equal(finalized.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
});
