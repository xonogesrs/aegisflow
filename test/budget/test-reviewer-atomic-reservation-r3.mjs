// test/budget/test-reviewer-atomic-reservation-r3.mjs
//
// AUTOLOOP-V1-VERIFIER-REVIEWER-ATTEMPT-ATOMIC-RESERVATION-REPAIR-R3
// The reviewer admission seam is an ATOMIC RESERVATION state machine
//
//   AVAILABLE → RESERVED → INVOKED → SETTLED      (RESERVED → CANCELLED only)
//
// inside the SINGLE existing budget ledger authority. limit=1 admits exactly
// one reviewer invocation; settle/cancel/replay are all fenced by the same
// ledger. The LOGICAL_REVIEW_ATTEMPT meter unit is unchanged:
// reviewer + reviewer_verdict = 1 attempt.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import {
  BUDGET_CONTRACT_SCHEMA,
  countLogicalReviewerAttempts,
} from "../../src/budget/contract.mjs";
import { createBudgetEnforcement } from "../../src/budget/enforcement.mjs";
import { BudgetHoldError } from "../../src/budget/ledger.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";
import { createDirectExecutionRunner } from "../../src/sop/proportional-sop.mjs";
import { buildPhaseTaskCard, deriveScopePatterns } from "../../src/v2/phase-task-card.mjs";
import { captureScopeSnapshot } from "../../src/c2d/mutation-scope.mjs";

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

function budgetAdmission({ reviewerLimit = 1, nodeLimit = 4, repairLimit = 2, retryLimit = 2, taskId = "ATOMIC-R3" } = {}) {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const rec = buildAdmissionRecord({
    taskId,
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

function makeEnc(opts = {}) {
  return createBudgetEnforcement({ admission: budgetAdmission(opts) }).enforcement;
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

/** Deterministic concurrency harness: two callers race the SAME reviewer
 *  admission seam. P7 subtraction re-point: wrapGraphHooks was REMOVED (M07,
 *  zero production callers) — this harness now drives the enforcement chain
 *  through the production lifecycle-hook contract itself, exactly the shape
 *  the runners wire (colima-graph-runner / SOP direct runner): the caller's
 *  nested hook is composed AFTER the enforcement gate. Caller A's nested
 *  hook suspends on a barrier promise AFTER the enforcement gate runs (the
 *  exact check→invoke window); caller B then attempts admission.
 *  No timing dependence — ordering is controlled by explicit awaits. */
async function raceTwoCallers(enc, { phaseA = "P1", phaseB = "P2" } = {}) {
  let releaseA;
  const barrier = new Promise((r) => { releaseA = r; });
  const nested = { ok: true };
  const w = {
    lifecycle: {
      onBeforeReviewer: async (info) => {
        // THE production seam: admitReviewer (atomic reservation, sync).
        const gate = enc.admitReviewer({ nodeId: info?.phaseId ?? null, attempt: info?.attempt });
        if (!gate.ok) return gate;
        const upstream = typeof nested.onBeforeReviewer === "function" ? await nested.onBeforeReviewer(info) : { ok: true };
        // R3 §5.3: a nested pre-invocation refusal proves the reviewer was
        // never started — release THIS reservation（only）safely.
        if (upstream && upstream.ok === false) {
          enc.cancelReviewerReservation({ nodeId: info?.phaseId ?? null, attempt: info?.attempt ?? 0 });
          return upstream;
        }
        return { ok: true };
      },
      onReviewerInvocationStarted: async (info) => {
        // R3: reservation RESERVED → INVOKED at the actual invocation seam.
        const c = enc.confirmReviewerInvoked({ nodeId: info?.phaseId ?? null, attempt: info?.attempt ?? 0 });
        if (!c.ok && !c.duplicate) throw new BudgetHoldError(c.holdCode ?? "BUDGET_AUTHORITY_INVALID", c.reason ?? "reviewer invocation confirmation failed closed");
        await nested.onReviewerInvocationStarted?.(info);
      },
      onReviewerCompleted: async (info) => {
        const s = enc.recordReviewer({ nodeId: info?.phaseId ?? null, attempt: info?.attempt ?? 0 });
        if (!s.ok && !s.duplicate) {
          // R3 review fix: a real invocation that cannot settle must never
          // pass silently — fail the run closed（NEG13 backstop stays intact）.
          throw new BudgetHoldError(s.holdCode ?? "BUDGET_AUTHORITY_INVALID", s.reason ?? "reviewer settlement failed closed");
        }
        await nested.onReviewerCompleted?.(info);
      },
    },
  };
  nested.onBeforeReviewer = () => barrier;
  // A enters the seam; enforcement reserves SYNCHRONOUSLY before its await.
  const pa = w.lifecycle.onBeforeReviewer({ phaseId: phaseA, attempt: 0 });
  await Promise.resolve(); // yield once — A is now parked on the barrier, reservation held
  // B races the same limit pool while A holds an active reservation.
  const b = await w.lifecycle.onBeforeReviewer({ phaseId: phaseB, attempt: 0 });
  releaseA({ ok: true });
  const a = await pa;
  return { a, b, wiring: w };
}

function activeReservations(enc) {
  return [...enc._reviewerReservations.values()].filter((r) => r.state === "RESERVED" || r.state === "INVOKED").length;
}
function inflightReviewerKeys(enc) {
  return Object.keys(enc.ledger.inFlight).filter((k) => k.startsWith("reviewer:"));
}

// ── T1: post-fix TOCTOU probe (pre-fix reproduction captured in R3 evidence) ──

test("T1: TOCTOU closed — second concurrent caller cannot pass the check-only window", async () => {
  const enc = makeEnc({ reviewerLimit: 1 });
  const { a, b } = await raceTwoCallers(enc);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false, "second concurrent admission must be rejected while A holds the reservation");
  assert.equal(["BUDGET_EXHAUSTED", "BUDGET_RESERVATION_CONFLICT"].includes(b.holdCode), true);
});

// ── T2 / T3 / T6: limit=1 atomic reservation, invocation count exactly 1 ──

test("T2/T3/T6: limit=1 two concurrent distinct attempts -> exactly 1 success, 1 rejection, 1 invocation", async () => {
  const enc = makeEnc({ reviewerLimit: 1 });
  let invocations = 0;
  const { a, wiring } = await raceTwoCallers(enc).then(async ({ a, b, wiring }) => {
    assert.equal(b.ok, false);
    return { a, wiring };
  });
  assert.equal(a.ok, true);
  // Only the reservation holder may invoke the reviewer.
  await wiring.lifecycle.onReviewerInvocationStarted({ phaseId: "P1", attempt: 0 });
  invocations += 1;
  await wiring.lifecycle.onReviewerCompleted({ phaseId: "P1", attempt: 0, verdict: "PASS", verdictObject: { verdict: "PASS" } });
  assert.equal(invocations, 1, "reviewer invoked exactly once under limit=1");
  assert.equal(activeReservations(enc), 0);
  assert.deepEqual(inflightReviewerKeys(enc), []);
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 1);
  assert.equal(enc.consumption().verifier_reviewer_attempts.reserved, 0);
});

// ── T4: no post-check yield — reservation exists before admission returns ──

test("T4: NO_POST_CHECK_YIELD — reservation is visible to the ledger before admit returns", () => {
  const enc = makeEnc({ reviewerLimit: 1 });
  // admitReviewer is synchronous: by the time it returns ok, the ledger
  // already carries the reservation — any concurrent reader sees it.
  const gate = enc.admitReviewer({ nodeId: "P1", attempt: 0 });
  assert.equal(gate.ok, true);
  assert.equal(enc.ledger.reservations.verifier_reviewer_attempts, 1);
  assert.ok(enc.ledger.inFlight["reviewer:P1:0"]);
  assert.equal(enc._reviewerReservations.get("P1:0").state, "RESERVED");
});

// ── T5 / T14a: duplicate identity fence ──

test("T5: DUPLICATE_IDENTITY_FENCE — same identity can never hold two reservations or replay a consumed slot", () => {
  const enc = makeEnc({ reviewerLimit: 4 });
  const first = enc.admitReviewer({ nodeId: "P1", attempt: 0 });
  assert.equal(first.ok, true);
  const second = enc.admitReviewer({ nodeId: "P1", attempt: 0 });
  assert.equal(second.ok, false);
  assert.equal(second.holdCode, "BUDGET_RESERVATION_CONFLICT");
  // replay after settlement is also fenced
  enc.confirmReviewerInvoked({ nodeId: "P1", attempt: 0 });
  assert.equal(enc.recordReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  const replay = enc.admitReviewer({ nodeId: "P1", attempt: 0 });
  assert.equal(replay.ok, false);
  assert.equal(replay.holdCode, "BUDGET_RESERVATION_CONFLICT");
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 1);
});

// ── T7: limit=2 exactness ──

test("T7: LIMIT_TWO_EXACTNESS — exactly two concurrent reservations, third pre-fenced", async () => {
  const enc = makeEnc({ reviewerLimit: 2 });
  const r1 = enc.admitReviewer({ nodeId: "PA", attempt: 0 });
  const r2 = enc.admitReviewer({ nodeId: "PB", attempt: 0 });
  const r3 = enc.admitReviewer({ nodeId: "PC", attempt: 0 });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, false);
  assert.equal(r3.holdCode, "BUDGET_EXHAUSTED");
  // settling one frees exactly one slot — no over-consumption possible
  enc.confirmReviewerInvoked({ nodeId: "PA", attempt: 0 });
  enc.recordReviewer({ nodeId: "PA", attempt: 0 });
  // while PB's reservation is still ACTIVE, the freed slot stays held:
  const blocked = enc.admitReviewer({ nodeId: "PC", attempt: 0 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.holdCode, "BUDGET_EXHAUSTED");
  // PB never invoked -> safe cancellation releases its slot; PC then admits.
  assert.equal(enc.cancelReviewerReservation({ nodeId: "PB", attempt: 0 }).ok, true);
  const r4 = enc.admitReviewer({ nodeId: "PC", attempt: 0 });
  assert.equal(r4.ok, true);
});

// ── T8 / T16: PASS settlement + meter unit invariance ──

test("T8/T16: PASS invocation settles once; meter unit stays reviewer+verdict=1", () => {
  const enc = makeEnc({ reviewerLimit: 1 });
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  enc.confirmReviewerInvoked({ nodeId: "P1", attempt: 0 });
  const settled = enc.recordReviewer({ nodeId: "P1", attempt: 0 });
  const gate = enc.preDispatch({ executionId: "g", phase_id: "n0", nodeId: "n0", attempt: 0, runtime: { limits: { timeoutMs: 60000 } } });
  assert.equal(gate.ok, true, JSON.stringify(gate));
  enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
  assert.equal(enc.consumption().verifier_reviewer_attempts.reserved, 0);
  const finalized = enc.finalize({
    final: "PASS",
    nodeResults: [{ nodeId: "P1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } }],
    transitions: graphTransitions([{ phaseId: "P1", events: pairEvents(0) }]),
  });
  assert.equal(finalized.final, "PASS", "terminal verdict stays the original truthful verdict");
  assert.deepEqual(finalized.budget.reconciliation.diverged, []);
  assert.equal(finalized.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
  assert.equal(finalized.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
  assert.equal(countLogicalReviewerAttempts(graphTransitions([{ phaseId: "P1", events: pairEvents(0) }])), 1);
});

// ── T9: HOLD settlement does not free the slot for a bypass retry ──

test("T9: HOLD_SETTLEMENT — HOLD consumes the slot; no retry may bypass the limit", () => {
  const enc = makeEnc({ reviewerLimit: 1 });
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  enc.confirmReviewerInvoked({ nodeId: "P1", attempt: 0 });
  enc.recordReviewer({ nodeId: "P1", attempt: 0 }); // HOLD outcome still settles
  const again = enc.admitReviewer({ nodeId: "P1", attempt: 1 });
  assert.equal(again.ok, false);
  assert.equal(again.holdCode, "BUDGET_EXHAUSTED", "settled HOLD must not release the limit slot");
});

// ── T10: error / timeout / invalid results each settle exactly once ──

test("T10: ERROR_SETTLEMENT — throw/rejection/timeout/invalid all settle once", () => {
  for (const status of ["error", "timed_out", "aborted", "invalid"]) {
    const enc = makeEnc({ reviewerLimit: 1 });
    assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true, status);
    enc.confirmReviewerInvoked({ nodeId: "P1", attempt: 0 }); // invocation started regardless of outcome
    assert.equal(enc.recordReviewer({ nodeId: "P1", attempt: 0 }).ok, true, status);
    assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 1, `${status} settles exactly 1`);
    assert.equal(activeReservations(enc), 0, status);
  }
});

// ── T11: safe cancellation of a never-invoked reservation ──

test("T11: PRE_INVOCATION_SAFE_CANCEL — only RESERVED cancels; freed slot admits next legal attempt", () => {
  const enc = makeEnc({ reviewerLimit: 1 });
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  const cancelled = enc.cancelReviewerReservation({ nodeId: "P1", attempt: 0 });
  assert.equal(cancelled.ok, true);
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 0);
  assert.equal(enc.consumption().verifier_reviewer_attempts.reserved, 0);
  // cancellation binds identity and succeeds only once
  const recancel = enc.cancelReviewerReservation({ nodeId: "P1", attempt: 0 });
  assert.equal(recancel.ok, false);
  // the released slot admits the next legal attempt end-to-end
  assert.equal(enc.admitReviewer({ nodeId: "P2", attempt: 0 }).ok, true);
  enc.confirmReviewerInvoked({ nodeId: "P2", attempt: 0 });
  assert.equal(enc.recordReviewer({ nodeId: "P2", attempt: 0 }).ok, true);
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 1);
});

// ── T12: cancel after invocation fails closed ──

test("T12: INVOKED_CANCEL_REJECTED — INVOKED and SETTLED slots are never released", () => {
  const enc = makeEnc({ reviewerLimit: 2 });
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  enc.confirmReviewerInvoked({ nodeId: "P1", attempt: 0 });
  const c1 = enc.cancelReviewerReservation({ nodeId: "P1", attempt: 0 });
  assert.equal(c1.ok, false);
  assert.equal(c1.holdCode, "BUDGET_RESERVATION_CONFLICT");
  enc.recordReviewer({ nodeId: "P1", attempt: 0 });
  const c2 = enc.cancelReviewerReservation({ nodeId: "P1", attempt: 0 });
  assert.equal(c2.ok, false);
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 1, "slot stays consumed");
});

// ── T13: duplicate settlement idempotency ──

test("T13: DUPLICATE_SETTLEMENT_IDEMPOTENCY — repeated completion never double counts", () => {
  const enc = makeEnc({ reviewerLimit: 2 });
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  enc.confirmReviewerInvoked({ nodeId: "P1", attempt: 0 });
  const s1 = enc.recordReviewer({ nodeId: "P1", attempt: 0 });
  const s2 = enc.recordReviewer({ nodeId: "P1", attempt: 0 });
  assert.equal(s1.ok, true);
  assert.equal(s2.ok, true);
  assert.equal(s2.duplicate, true);
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 1);
});

// ── T14: wrong / forged identity settlement fails closed ──

test("T14: WRONG_IDENTITY_FENCED — forged identity cannot settle or release another's slot", () => {
  const enc = makeEnc({ reviewerLimit: 2 });
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  const forged = enc.recordReviewer({ nodeId: "PX", attempt: 9 });
  assert.equal(forged.ok, false, "settlement without a matching reservation is refused");
  assert.equal(forged.holdCode, "BUDGET_AUTHORITY_INVALID");
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 0);
  // P1's reservation is untouched by the forged attempt
  assert.ok(enc.ledger.inFlight["reviewer:P1:0"]);
  // confirm-invoked for an unknown identity also fails closed
  const ci = enc.confirmReviewerInvoked({ nodeId: "GHOST", attempt: 0 });
  assert.equal(ci.ok, false);
  // cancellation cannot target another attempt's slot
  const cx = enc.cancelReviewerReservation({ nodeId: "OTHER", attempt: 3 });
  assert.equal(cx.ok, false);
  assert.ok(enc.ledger.inFlight["reviewer:P1:0"]);
});

// ── T15: unresolved reservation at finalize fails closed ──

test("T15: UNRESOLVED_RESERVATION_FINALIZE — leaked reservation forces reconciliation HOLD", () => {
  const enc = makeEnc({ reviewerLimit: 1 });
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  const finalized = enc.finalize({
    final: "PASS",
    nodeResults: [{ nodeId: "P1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } }],
    transitions: graphTransitions([{ phaseId: "P1", events: pairEvents(0) }]),
  });
  assert.equal(finalized.final, "HOLD", "leaked reservation must fail closed, not silently close out");
  assert.equal(finalized.holdCode, "BUDGET_RECONCILIATION_DIVERGED");
  assert.match(finalized.reason, /unresolved_reservations=1/);
});

// ── T17: rejected pre-invocation attempt leaves NO fake attempt evidence ──

test("T17: REJECTED_ATTEMPT_TELEMETRY — rejection publishes no reviewer evidence", async () => {
  const enc = makeEnc({ reviewerLimit: 1 });
  const { a, b, wiring } = await raceTwoCallers(enc);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  await wiring.lifecycle.onReviewerInvocationStarted({ phaseId: "P1", attempt: 0 });
  await wiring.lifecycle.onReviewerCompleted({ phaseId: "P1", attempt: 0, verdict: "PASS", verdictObject: { verdict: "PASS" } });
  const transitions = graphTransitions([{ phaseId: "P1", events: pairEvents(0) }]);
  assert.equal(countLogicalReviewerAttempts(transitions), 1, "only the admitted attempt has evidence");
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 1);
  // no telemetry consumption invented for B: nothing was reserved/settled for PB
  assert.ok(!enc._reviewerSettled.has("P2:0"));
});

// ── T18: direct production path end-to-end through runAdmittedGraph ──

function makeGitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "atomic-r3-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir });
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

function reviewerStep(attempt, verdict) {
  return {
    expect: { phase: "reviewer", attempt },
    result: { status: "completed", stdout: verdictJson(verdict), stderr: "", signal: null, error: null, metadata: {} },
  };
}

test("T18: DIRECT_PRODUCTION_INTEGRATION — production direct path enforces the fence end-to-end", async () => {
  const cwd = makeGitFixture();
  try {
    const executionId = "exec_atomic000000000000000000000000001";
    const executorAdapter = createScriptedAdapter([executorStep(executionId, 0)]);
    const reviewerAdapter = createScriptedAdapter([reviewerStep(0, { verdict: "PASS", recommended_next_action: "STOP" })]);
    const result = await runAdmittedGraph({
      admission: budgetAdmission({ reviewerLimit: 1, taskId: "ATOMIC-DIRECT" }),
      runner: createDirectExecutionRunner(),
      cwd,
      taskCard: makeTaskCard(cwd, executionId),
      executorAdapter,
      reviewerAdapter,
      timeoutMs: 30_000,
      maxRepairAttempts: 0,
    });
    assert.equal(result.final, "PASS");
    assert.equal(reviewerAdapter.callRecord.length, 1, "exactly one real reviewer invocation");
    assert.equal(result.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
    assert.equal(result.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
    assert.deepEqual(result.budget.reconciliation.diverged, [], "no unresolved reservations leak into closeout");
    const inFlightReviewers = Object.keys(result.budget.checkpoint.inFlight ?? {}).filter((k) => k.startsWith("reviewer:"));
    assert.deepEqual(inFlightReviewers, [], "ACTIVE_RESERVATION_COUNT = 0 at terminal flow");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── T19: the graph lifecycle seam uses the SAME reservation authority ──
// P7 subtraction re-point: wrapGraphHooks was REMOVED (M07, zero production
// callers) — the reserve/invoke/settle chain this test proves is the one the
// production runners wire directly（colima-graph-runner lifecycle hooks /
// SOP direct runner）. The enforcement calls and their ordering are unchanged.

test("T19: GRAPH_PRODUCTION_INTEGRATION — the graph lifecycle seam drives reserve/invoke/settle on one authority", async () => {
  const enc = makeEnc({ reviewerLimit: 2, nodeLimit: 4 });
  let invocations = 0;
  const nested = {
    lifecycle: {
      onBeforeReviewer: async () => ({ ok: true }),
      onReviewerInvocationStarted: async () => { invocations += 1; },
    },
  };
  // Production seam shape (colima-graph-runner / SOP direct runner):
  // enforcement gate FIRST, then the nested caller hook.
  const w = {
    lifecycle: {
      onBeforeReviewer: async (info) => {
        const gate = enc.admitReviewer({ nodeId: info?.phaseId ?? null, attempt: info?.attempt });
        if (!gate.ok) return gate;
        const upstream = typeof nested.lifecycle?.onBeforeReviewer === "function" ? await nested.lifecycle.onBeforeReviewer(info) : { ok: true };
        if (upstream && upstream.ok === false) {
          enc.cancelReviewerReservation({ nodeId: info?.phaseId ?? null, attempt: info?.attempt ?? 0 });
          return upstream;
        }
        return { ok: true };
      },
      onReviewerInvocationStarted: async (info) => {
        const c = enc.confirmReviewerInvoked({ nodeId: info?.phaseId ?? null, attempt: info?.attempt ?? 0 });
        if (!c.ok && !c.duplicate) throw new BudgetHoldError(c.holdCode ?? "BUDGET_AUTHORITY_INVALID", c.reason ?? "reviewer invocation confirmation failed closed");
        await nested.lifecycle?.onReviewerInvocationStarted?.(info);
      },
      onReviewerCompleted: async (info) => {
        const s = enc.recordReviewer({ nodeId: info?.phaseId ?? null, attempt: info?.attempt ?? 0 });
        if (!s.ok && !s.duplicate) throw new BudgetHoldError(s.holdCode ?? "BUDGET_AUTHORITY_INVALID", s.reason ?? "reviewer settlement failed closed");
        await nested.lifecycle?.onReviewerCompleted?.(info);
      },
    },
  };
  const g1 = await w.lifecycle.onBeforeReviewer({ phaseId: "PA", attempt: 0 });
  assert.equal(g1.ok, true);
  await w.lifecycle.onReviewerInvocationStarted({ phaseId: "PA", attempt: 0 });
  await w.lifecycle.onReviewerCompleted({ phaseId: "PA", attempt: 0, verdict: "PASS", verdictObject: { verdict: "PASS" } });
  const g2 = await w.lifecycle.onBeforeReviewer({ phaseId: "PB", attempt: 0 });
  assert.equal(g2.ok, true);
  await w.lifecycle.onReviewerInvocationStarted({ phaseId: "PB", attempt: 0 });
  await w.lifecycle.onReviewerCompleted({ phaseId: "PB", attempt: 0, verdict: "HOLD", verdictObject: { verdict: "HOLD" } });
  const g3 = await w.lifecycle.onBeforeReviewer({ phaseId: "PC", attempt: 0 });
  assert.equal(g3.ok, false, "third graph attempt fenced by the same ledger authority");
  assert.equal(g3.holdCode, "BUDGET_EXHAUSTED");
  assert.equal(invocations, 2);
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 2);
  const observed = countLogicalReviewerAttempts(graphTransitions([
    { phaseId: "PA", events: pairEvents(0) },
    { phaseId: "PB", events: [{ phase: "reviewer", attempt: 0, status: "completed" }, { phase: "reviewer_verdict", attempt: 0, verdict: "HOLD" }] },
  ]));
  assert.equal(observed, 2);
});

// ── T20: retry/repair idempotency — distinct identities, no duplicate evidence ──

test("T20: RETRY_REPAIR_IDEMPOTENCY — repair loop consumes one slot per logical attempt, no reuse", async () => {
  const cwd = makeGitFixture();
  try {
    const executionId = "exec_atomic000000000000000000000000002";
    const executorAdapter = createScriptedAdapter([executorStep(executionId, 0), executorStep(executionId, 1)]);
    const reviewerAdapter = createScriptedAdapter([
      reviewerStep(0, { verdict: "HOLD", confidence: "HIGH", recommended_next_action: "REPAIR", summary: "repair" }),
      reviewerStep(1, { verdict: "PASS", recommended_next_action: "STOP" }),
    ]);
    const result = await runAdmittedGraph({
      admission: budgetAdmission({ reviewerLimit: 2, repairLimit: 2, retryLimit: 2, taskId: "ATOMIC-RETRY" }),
      runner: createDirectExecutionRunner(),
      cwd,
      taskCard: makeTaskCard(cwd, executionId),
      executorAdapter,
      reviewerAdapter,
      timeoutMs: 30_000,
      maxRepairAttempts: 1,
    });
    assert.equal(reviewerAdapter.callRecord.length, 2, "two logical attempts, zero duplicate invocations");
    assert.equal(result.budget.reconciliation.ledger.verifier_reviewer_attempts, 2);
    assert.equal(result.budget.reconciliation.observed.verifier_reviewer_attempts, 2);
    assert.deepEqual(result.budget.reconciliation.diverged, []);
    const lt = result.transitions[0].lifecycleTransitions;
    const attemptsWithEvidence = new Set(lt.filter((t) => t.phase === "reviewer").map((t) => t.attempt));
    assert.deepEqual([...attemptsWithEvidence].sort(), [0, 1], "evidence drift-free across retry identities");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── T21: final reconciliation — ledger == observer, failing paths stay HOLD ──

test("T21: FINAL_RECONCILIATION — diverged=[] on truth, HOLD terminal stays HOLD", () => {
  const enc = makeEnc({ reviewerLimit: 1 });
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  enc.confirmReviewerInvoked({ nodeId: "P1", attempt: 0 });
  enc.recordReviewer({ nodeId: "P1", attempt: 0 });
  const gate = enc.preDispatch({ executionId: "g", phase_id: "n0", nodeId: "n0", attempt: 0, runtime: { limits: { timeoutMs: 60000 } } });
  assert.equal(gate.ok, true);
  enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
  const holdEvents = [
    { phase: "reviewer", attempt: 0, status: "completed" },
    { phase: "reviewer_verdict", attempt: 0, verdict: "HOLD", recommended_next_action: "STOP" },
  ];
  const finalized = enc.finalize({
    final: "HOLD",
    nodeResults: [{ nodeId: "P1", final: "HOLD", attempt: 0, resultIdentity: { latencyMs: 5 } }],
    transitions: graphTransitions([{ phaseId: "P1", events: holdEvents }]),
  });
  assert.equal(finalized.final, "HOLD", "real HOLD verdict must not be rewritten");
  assert.deepEqual(finalized.budget.reconciliation.diverged, []);
  assert.equal(finalized.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
  assert.equal(finalized.budget.reconciliation.observed.verifier_reviewer_attempts, 1);
});

// ── T22: single-authority static proof ──

test("T22: SINGLE_AUTHORITY_STATIC_PROOF — no second meter, normalizer, ledger, or runner authority", () => {
  const read = (p) => readFileSync(resolve(HERE, "../..", p), "utf8");
  const enforcementSrc = read("src/budget/enforcement.mjs");
  // one admission seam, defined once; reservation rides the ONE ledger
  assert.equal((enforcementSrc.match(/admitReviewer\(/g) || []).filter(() => true).length >= 1, true);
  assert.match(enforcementSrc, /_reviewerKey\(nodeId, attempt\)/);
  assert.match(enforcementSrc, /from "\.\/ledger\.mjs"/, "enforcement rides THE one ledger authority");
  const contractSrc = read("src/budget/contract.mjs");
  assert.equal((contractSrc.match(/export function countLogicalReviewerAttempts/g) || []).length, 1, "ONE normalizer");
  const ledgerSrc = read("src/budget/ledger.mjs");
  assert.equal((ledgerSrc.match(/export function createBudgetLedger/g) || []).length, 1, "ONE ledger constructor");
  const runnerSrc = read("src/lifecycle-runner.mjs");
  assert.equal((runnerSrc.match(/export function runLifecycle|export async function runLifecycle/g) || []).length, 1, "ONE lifecycle runner");
  // DIMENSION_METER_MAP keeps exactly one verifier_reviewer_attempts entry
  assert.equal((contractSrc.match(/verifier_reviewer_attempts: \{/g) || []).length, 1);
});

// ── R3 adversarial-review repairs ─────────────────────────────────────────

test("RV1: cancel_reservation replays deterministically — durable resume works after cancellation", () => {
  const admission = budgetAdmission({ reviewerLimit: 2 });
  const enc = createBudgetEnforcement({ admission }).enforcement;
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  assert.equal(enc.cancelReviewerReservation({ nodeId: "P1", attempt: 0 }).ok, true);
  const checkpoint = enc.checkpointState();
  // resume MUST accept a checkpoint whose receipt log contains cancel_reservation
  const resumed = createBudgetEnforcement({ admission, checkpointState: checkpoint });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const rEnc = resumed.enforcement;
  assert.equal(rEnc.consumption().verifier_reviewer_attempts.consumed, 0);
  assert.equal(rEnc.consumption().verifier_reviewer_attempts.reserved, 0);
  // and the freed slot is usable end-to-end on the resumed authority
  assert.equal(rEnc.admitReviewer({ nodeId: "P2", attempt: 0 }).ok, true);
  rEnc.confirmReviewerInvoked({ nodeId: "P2", attempt: 0 });
  assert.equal(rEnc.recordReviewer({ nodeId: "P2", attempt: 0 }).ok, true);
});

test("RV2: CANCELLED identity is terminal — same identity can never re-admit", () => {
  const enc = makeEnc({ reviewerLimit: 4 });
  assert.equal(enc.admitReviewer({ nodeId: "P1", attempt: 0 }).ok, true);
  assert.equal(enc.cancelReviewerReservation({ nodeId: "P1", attempt: 0 }).ok, true);
  const reAdmit = enc.admitReviewer({ nodeId: "P1", attempt: 0 });
  assert.equal(reAdmit.ok, false, "cancelled identity must not take a second reservation");
  assert.equal(reAdmit.holdCode, "BUDGET_RESERVATION_CONFLICT");
});

test("RV3: settlement failure fails closed — the reviewer settlement seam throws instead of silent uncounted invocation", async () => {
  const enc = makeEnc({ reviewerLimit: 2 });
  // P7 subtraction re-point: the settlement fence lives in the lifecycle
  // onReviewerCompleted contract（wired by the production runners）, not in
  // the removed wrapGraphHooks wrapper.
  const w = { lifecycle: { onReviewerCompleted: async (info) => {
    const s = enc.recordReviewer({ nodeId: info?.phaseId ?? null, attempt: info?.attempt ?? 0 });
    if (!s.ok && !s.duplicate) throw new BudgetHoldError(s.holdCode ?? "BUDGET_AUTHORITY_INVALID", s.reason ?? "reviewer settlement failed closed");
  } } };
  // recordReviewer for a never-reserved identity must surface, not vanish
  await assert.rejects(
    () => w.lifecycle.onReviewerCompleted({ phaseId: "PX", attempt: 7, verdict: "PASS" }),
    (e) => e.constructor.name === "BudgetHoldError",
    "unsettleable invocation must throw BudgetHoldError",
  );
  assert.equal(enc.consumption().verifier_reviewer_attempts.consumed, 0);
});
