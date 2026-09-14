// test/test-sop-scale-bind.mjs
//
// AUTOLOOP-V1-PROPORTIONAL-EXECUTION-SOP-SCALE-BIND-1 — Stage B regression
// evidence (card §5 T1–T12, T14).
//
// Proves, end to end through PRODUCTION surfaces:
//   coordinate() → executeSequentially() → runAdmittedGraph()
//   → [SOP scale bind] → runLifecycle() (existing lifecycle runner)
//
// T13 (graph-path regression) and T15 (installed vendor integrity) are
// covered by the untouched suites they name; see the card final report.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { coordinate, executeSequentially } from "../src/control-plane/coordinator.mjs";
import { EXECUTION_HOLDS } from "../src/control-plane/contract.mjs";
import { digestOf } from "../src/canonical-digest.mjs";
import {
  fastPathAdmission,
  highAdmission,
  makeFrozenAdmission,
  allDimensions,
  taskInput,
  forgeAdmission,
  standardAdmission,
} from "./control-plane/helpers.mjs";
import {
  SOP_STAGES,
  SCALE_FOR_PROFILE,
  scaleForProfile,
  projectScalePlan,
  assertRequiredStagesHandled,
  createDirectExecutionRunner,
} from "../src/sop/proportional-sop.mjs";
import { PROFILE_MATRIX } from "../src/admission/policy-projection.mjs";
import { classify } from "../src/admission/classify.mjs";
import { createScriptedAdapter } from "../src/adapter/scripted-adapter.mjs";
import { buildPhaseTaskCard, deriveScopePatterns } from "../src/v2/phase-task-card.mjs";
import { captureScopeSnapshot } from "../src/c2d/mutation-scope.mjs";
import { createBudgetEnforcement } from "../src/budget/enforcement.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_EVIDENCE = JSON.parse(
  readFileSync(resolve(HERE, "fixtures", "implementation-evidence-valid.json"), "utf8"),
);

function spyRunner(captured) {
  return async (args) => {
    captured.push(args);
    return { final: "PASS", nodeResults: [], transitions: [], closeout: { applied: false } };
  };
}

/** Re-bind the plan identity after a deliberate mutation (mirrors the sink
 *  tests): the sink's INDEPENDENT authority checks stay what is exercised. */
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

// ── S0 direct-execution fixtures ─────────────────────────────────────────

function makeGitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "sop-scale-bind-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function evidenceJson(executionId, overrides = {}) {
  return JSON.stringify({ ...FIXTURE_EVIDENCE, contract_id: executionId, ...overrides });
}

function verdictJson({ verdict = "PASS", confidence = "HIGH", model = "test-model", summary = "ok", recommended_next_action = "STOP" } = {}) {
  return JSON.stringify({ verdict, confidence, model, summary, recommended_next_action });
}

function passVerdictAdapter() {
  return createScriptedAdapter([
    {
      expect: { phase: "reviewer", attempt: 0 },
      result: { status: "completed", stdout: verdictJson(), stderr: "", signal: null, error: null, metadata: {} },
    },
  ]);
}

/** Build a real taskCard (harness-owned evidence machinery intact) for a
 *  direct S0 execution against a fresh git fixture. */
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

let EXEC_SEQ = 0;
function nextExecutionId() {
  EXEC_SEQ += 1;
  return `exec_sop00000000000000000000000000000${String(EXEC_SEQ).padStart(2, "0")}`;
}

/** Full production integration: coordinate → executeSequentially →
 *  runAdmittedGraph → SOP direct runner → runLifecycle. */
async function runS0Positive({ executorStatus = "completed", verdict } = {}) {
  const cwd = makeGitFixture();
  try {
    const executionId = nextExecutionId();
    const executorResult = executorStatus === "error"
      ? { status: "error", stdout: "", stderr: "crash", signal: null, error: "crash", metadata: {} }
      : { status: "completed", stdout: evidenceJson(executionId), stderr: "", signal: null, error: null, metadata: {} };
    const executorAdapter = createScriptedAdapter([
      { expect: { phase: "executor", attempt: 0 }, result: executorResult },
    ]);
    const reviewerAdapter = verdict
      ? createScriptedAdapter([
          { expect: { phase: "reviewer", attempt: 0 }, result: { status: "completed", stdout: verdictJson(verdict), stderr: "", signal: null, error: null, metadata: {} } },
        ])
      : passVerdictAdapter();
    const fast = fastPathAdmission("S0-TASK");
    const { plan } = coordinate({
      tasks: [taskInput("s0", fast, {
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
    return { results, cwd, executionId, executorAdapter, reviewerAdapter };
  } catch (e) {
    rmSync(cwd, { recursive: true, force: true });
    throw e;
  }
}

// ── T1 CURRENT_BYPASS_REPRODUCTION ────────────────────────────────────────

test("T1: graph===null silent skip is unreachable — direct task without DI yields the mandated HOLD, legacy reason gone", async () => {
  const fast = fastPathAdmission("T1");
  const { plan } = coordinate({ tasks: [taskInput("t1", fast)] });
  assert.equal(plan.tasks[0].graph, null);
  assert.equal(plan.tasks[0].runtime, "direct");
  const { results } = await executeSequentially({ plan });
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].holdCode, "FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED");
  assert.ok(!Object.values(results[0]).some((v) => typeof v === "string" && v.includes("no graph runtime")));
});

test("T1b: graph===null under a NON-direct runtime is contradictory authority, never skipped", async () => {
  const std = standardAdmission("T1B"); // M/LOW ⇒ STANDARD ⇒ runtime colima
  const { plan } = coordinate({ tasks: [taskInput("t1b", std)] });
  assert.notEqual(plan.tasks[0].runtime, "direct");
  plan.tasks[0].graph = null;
  rehashPlan(plan);
  const captured = [];
  plan.tasks[0].runnerOpts = { runner: spyRunner(captured) };
  const { results } = await executeSequentially({ plan });
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].holdCode, EXECUTION_HOLDS.GRAPH_RUNTIME_UNRESOLVED);
  assert.equal(captured.length, 0);
});

// ── T2 S0_DIRECT_EXECUTION_POSITIVE (+ T3 DISPATCH_TRUTH, T12 telemetry) ──

test("T2: S0 + CAP.DIRECT_EXECUTION executes REALLY once through the existing lifecycle runner", async () => {
  const { results, cwd, executorAdapter, reviewerAdapter } = await runS0Positive();
  rmSync(cwd, { recursive: true, force: true });
  const r = results[0];
  // dispatch truth (T3)
  assert.equal(r.dispatched, true);
  assert.equal(r.result.final, "PASS");
  assert.equal(r.result.executionPath, "direct");
  assert.equal(r.result.nodeResults.length, 1);
  assert.equal(r.result.nodeResults[0].final, "PASS");
  assert.equal(r.result.nodeResults[0].taskType, "direct");
  // the REAL lifecycle ran: exactly one executor + one reviewer adapter call
  assert.equal(executorAdapter.callRecord.length, 1);
  assert.equal(reviewerAdapter.callRecord.length, 1);
  assert.equal(executorAdapter.callRecord[0].phase, "executor");
  assert.equal(reviewerAdapter.callRecord[0].phase, "reviewer");
  // single scale/bind authority surfaced on the result
  assert.equal(r.result.sopBind.scale, "S0");
  assert.equal(r.result.sopBind.profile, "FAST_PATH");
  assert.equal(r.result.sopBind.selectedStageDispositions["EXECUTION"], "REQUIRED");
});

// ── T12 TELEMETRY_AND_CLOSEOUT_TRUTH ─────────────────────────────────────

test("T12: closeout/telemetry carries selected scale, execution path, real runner result and budget reconciliation", async () => {
  const { results, cwd } = await runS0Positive();
  rmSync(cwd, { recursive: true, force: true });
  const r = results[0].result;
  assert.equal(r.budget.authorized, true);
  assert.equal(r.budget.surface, "production");
  assert.deepEqual(r.budget.reconciliation.diverged, []);
  assert.equal(r.budget.reconciliation.observed.node_execution_count, 1);
  assert.equal(r.budget.reconciliation.observed.verifier_reviewer_attempts, 1); // one LOGICAL_REVIEW_ATTEMPT (reviewer + reviewer_verdict pair)
  assert.equal(r.budget.reconciliation.ledger.verifier_reviewer_attempts, 1);
  assert.equal(r.budget.dimensions.verifier_reviewer_attempts.consumed, 1);
  assert.equal(r.budget.dimensions.verifier_reviewer_attempts.limit, 1);
  assert.equal(r.budget.reconciliation.observed.sub_agent_execution_count, 0);
  const lt = r.transitions[0].lifecycleTransitions;
  assert.ok(lt.some((t) => t.phase === "reviewer"));
  assert.ok(lt.some((t) => t.phase === "reviewer_verdict" && t.verdict === "PASS"));
  assert.equal(r.closeout.applied, false); // truthful: no fabricated bundle closeout
  assert.equal(results[0].reviewArtifactEnforced, false); // FAST_PATH strength=deterministic ⇒ no external review job owed
});

// ── T4 CAPABILITY_ABSENT_FAIL_CLOSED ─────────────────────────────────────

test("T4: missing CAP.DIRECT_EXECUTION fails closed with the exact mandated code", async () => {
  const stripped = {
    ...JSON.parse(JSON.stringify(fastPathAdmission("T4"))),
    capabilities: { required: [], allowed: [], denied: [] },
  };
  const runner = await createDirectExecutionRunner()({
    admission: stripped,
    budget: {},
    taskCard: { executionId: "exec_x" },
    executorAdapter: { runAdapter: async () => ({}) },
    reviewerAdapter: { runAdapter: async () => ({}) },
    cwd: "/tmp",
  });
  assert.equal(runner.final, "HOLD");
  assert.equal(runner.holdCode, "FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED");
  assert.deepEqual(runner.nodeResults, []);
});

test("T4b: absent adapters (runtime cannot provide direct execution) fail closed, never silently skip", async () => {
  const admission = fastPathAdmission("T4B");
  const runner = await createDirectExecutionRunner()({
    admission,
    budget: { enforcement: createBudgetEnforcement({ admission }).enforcement },
    taskCard: { executionId: "exec_y" },
    cwd: "/tmp",
  });
  assert.equal(runner.final, "HOLD");
  assert.equal(runner.holdCode, "FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED");
  assert.match(runner.reason, /missing .*adapter/i);
});

// ── T5 DIRECT_RUNNER_FAILURE_PROPAGATION ─────────────────────────────────

test("T5: executor failure propagates as HOLD — never translated into PASS or fake success", async () => {
  const { results, cwd } = await runS0Positive({ executorStatus: "error" });
  rmSync(cwd, { recursive: true, force: true });
  const r = results[0];
  assert.equal(r.dispatched, true); // it DID really dispatch — truthfully reported
  assert.equal(r.result.final, "HOLD");
  assert.match(String(r.result.reason), /EXECUTOR_ERROR/);
  assert.equal(r.result.closeout.applied, false);
  assert.equal(r.result.nodeResults[0].final, "HOLD");
});

test("T5b: reviewer HOLD verdict propagates — REVIEWER_HOLD is terminal, not silently repaired", async () => {
  const { results, cwd } = await runS0Positive({
    verdict: { verdict: "HOLD", confidence: "HIGH", recommended_next_action: "HUMAN_REVIEW" },
  });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(results[0].dispatched, true);
  assert.equal(results[0].result.final, "HOLD");
  assert.match(String(results[0].result.reason), /REVIEWER_HOLD/);
});

test("T5c: an exception escaping the lifecycle runner becomes a truthful HOLD, never a swallow", async () => {
  const boomAdapter = {
    runAdapter: async () => { throw new Error("adapter exploded"); },
  };
  const runner = createDirectExecutionRunner();
  const admissionC = fastPathAdmission("T5C");
  const out = await runner({
    admission: admissionC,
    budget: { enforcement: createBudgetEnforcement({ admission: admissionC }).enforcement },
    taskCard: makeTaskCard(makeGitFixture(), nextExecutionId()),
    executorAdapter: boomAdapter,
    reviewerAdapter: boomAdapter,
    cwd: "/tmp",
    timeoutMs: 1000,
  });
  assert.equal(out.final, "HOLD");
  assert.equal(out.holdCode, EXECUTION_HOLDS.DIRECT_RUNNER_EXCEPTION);
  assert.match(out.reason, /adapter exploded/);
});

// ── T11e/f: standalone-runner authority hardening (adversarial repair) ───

test("T11e: forged never-frozen admission cannot drive the direct runner standalone", async () => {
  const forged = {
    profile: "FAST_PATH", size: "S", risk: "LOW",
    capabilities: { required: [], allowed: ["CAP.DIRECT_EXECUTION"], denied: [] },
    admission_id: "0".repeat(64),
  };
  const out = await createDirectExecutionRunner()({
    admission: forged,
    budget: {},
    taskCard: { executionId: "exec_forge" },
    executorAdapter: { runAdapter: async () => ({}) },
    reviewerAdapter: { runAdapter: async () => ({}) },
    cwd: "/tmp",
  });
  assert.equal(out.final, "HOLD");
  assert.match(String(out.reason), /authority re-check failed/);
  assert.deepEqual(out.nodeResults, []); // no adapter was ever invoked
});

test("T11f: execution without the runAdmittedGraph budget chain is not authorized (NEG14)", async () => {
  const out = await createDirectExecutionRunner()({
    admission: fastPathAdmission("T11F"),
    budget: {},
    taskCard: { executionId: "exec_nofencing" },
    executorAdapter: { runAdapter: async () => ({}) },
    reviewerAdapter: { runAdapter: async () => ({}) },
    cwd: "/tmp",
  });
  assert.equal(out.final, "HOLD");
  assert.equal(out.holdCode, "BUDGET_AUTHORITY_INVALID");
});

// ── T6 RISKY_TINY_TASK_FENCE ─────────────────────────────────────────────

test("T6: risky tiny task escalates OFF FAST_PATH and can never enter the direct path", () => {
  const classification = classify({
    dimensionScores: allDimensions({
      affected_files: { score: 2, reasons: ["few"] },
      verification_burden: { score: 2, reasons: ["verify"] },
    }),
    riskSignals: [{ signal_id: "RS.NETWORK_REMOTE", class: "HIGH", triggered: true, reason: "remote fetch" }],
    evidenceSufficient: true,
  });
  // classifier fence (existing NEG1): any triggered signal ⇒ not FAST_PATH
  assert.notEqual(classification.profile, "FAST_PATH");
  assert.notEqual(scaleForProfile(classification.profile), "S0");

  // defense-in-depth at the runner: even a hand-built S0-looking record with
  // non-LOW risk is refused.
  const risky = {
    ...JSON.parse(JSON.stringify(fastPathAdmission("T6"))),
    risk: "MEDIUM",
  };
  const runner = createDirectExecutionRunner();
  return runner({
    admission: risky,
    budget: {},
    taskCard: { executionId: "exec_z" },
    executorAdapter: { runAdapter: async () => ({}) },
    reviewerAdapter: { runAdapter: async () => ({}) },
    cwd: "/tmp",
  }).then((out) => {
    assert.equal(out.final, "HOLD");
    assert.equal(out.holdCode, "FAST_PATH_RISKY_TINY_TASK_FENCED");
  });
});

// ── T7 S0_TO_S3_MATRIX ───────────────────────────────────────────────────

test("T7: stage dispositions for EVERY profile derive strictly from its PROFILE_MATRIX row", () => {
  for (const profile of Object.keys(PROFILE_MATRIX)) {
    const d = PROFILE_MATRIX[profile];
    const plan = projectScalePlan(profile);
    assert.equal(plan.profile, profile);
    assert.equal(plan.scale, SCALE_FOR_PROFILE[profile]);
    assert.deepEqual(plan.stages.map((s) => s.stage), [...SOP_STAGES]);
    for (const s of plan.stages) {
      assert.ok(["REQUIRED", "ALLOWED_TO_SKIP", "FORBIDDEN", "NOT_APPLICABLE"].includes(s.disposition), `${profile}/${s.stage}`);
      assert.ok(s.basis.length > 0);
    }
    const byStage = Object.fromEntries(plan.stages.map((s) => [s.stage, s.disposition]));
    assert.equal(byStage["TASK_INTAKE"], "REQUIRED");
    assert.equal(byStage["TASK_SIZE_AND_RISK_CLASSIFICATION"], "REQUIRED");
    assert.equal(byStage["CAPABILITY_AND_TOOL_SELECTION"], "REQUIRED");
    assert.equal(byStage["EXECUTION"], "REQUIRED");
    assert.equal(byStage["VERIFY"], "REQUIRED");
    assert.equal(byStage["CLOSEOUT"], "REQUIRED");
    assert.equal(byStage["REVIEW"], "REQUIRED");
    assert.equal(byStage["CHECKPOINT/SESSION_ROLLOVER"], d.checkpoint_resume_required ? "REQUIRED" : "NOT_APPLICABLE");
    assert.equal(byStage["CURRENT_STATE_RECONCILIATION"], d.durable_execution_required ? "REQUIRED" : "NOT_APPLICABLE");
    assert.equal(byStage["PLAN"], d.decomposition_required || d.research_first_required ? "REQUIRED" : "ALLOWED_TO_SKIP");
    assert.equal(byStage["LEARNING"], d.memory_writeback_allowed ? "ALLOWED_TO_SKIP" : "FORBIDDEN");
  }
});

test("T7b: roadmap §1.1 anchors hold — S0/S1 skip decomp+checkpoint, S2 rows split, S3 requires them", () => {
  assert.deepEqual(projectScalePlan("FAST_PATH").scale, "S0");
  assert.equal(projectScalePlan("FAST_PATH").stages.find((s) => s.stage === "CHECKPOINT/SESSION_ROLLOVER").disposition, "NOT_APPLICABLE");
  assert.equal(projectScalePlan("STANDARD").scale, "S1");
  assert.equal(projectScalePlan("MEDIUM").scale, "S2");
  assert.equal(projectScalePlan("MEDIUM_LARGE").scale, "S2");
  assert.equal(projectScalePlan("LARGE_LOW").scale, "S2");
  assert.equal(projectScalePlan("HIGH").scale, "S3");
  assert.equal(projectScalePlan("CRITICAL").scale, "S3");
  assert.equal(projectScalePlan("HIGH").stages.find((s) => s.stage === "CHECKPOINT/SESSION_ROLLOVER").disposition, "REQUIRED");
  // LEARNING is FORBIDDEN on every current matrix row (writeback denied)
  for (const p of Object.keys(PROFILE_MATRIX)) {
    assert.equal(projectScalePlan(p).stages.find((s) => s.stage === "LEARNING").disposition, "FORBIDDEN");
  }
});

// ── T8 S3_MANDATORY_STAGES ───────────────────────────────────────────────

test("T8: S3 cannot skip contract/plan/verify/review — all REQUIRED, nothing forbidden-or-skippable among them", () => {
  for (const profile of ["HIGH", "CRITICAL"]) {
    const byStage = Object.fromEntries(projectScalePlan(profile).stages.map((s) => [s.stage, s.disposition]));
    for (const stage of ["PLAN", "CAPABILITY_AND_TOOL_SELECTION", "VERIFY", "REVIEW", "CLOSEOUT"]) {
      assert.equal(byStage[stage], "REQUIRED", `${profile}/${stage}`);
    }
  }
});

// ── T9 REQUIRED_HANDLER_MISSING ──────────────────────────────────────────

test("T9: a REQUIRED stage without a bound handler fails closed — never demoted to skipped", () => {
  const plan = projectScalePlan("FAST_PATH");
  const handlers = Object.fromEntries(plan.stages.filter((s) => s.disposition === "REQUIRED").map((s) => [s.stage, true]));
  const missing = { ...handlers, REVIEW: false };
  const out = assertRequiredStagesHandled(plan, missing);
  assert.equal(out.ok, false);
  assert.equal(out.holdCode, EXECUTION_HOLDS.SOP_REQUIRED_STAGE_HANDLER_MISSING);
});

test("T9b: binding a handler for a FORBIDDEN stage (matrix-denied) fails closed", () => {
  const plan = projectScalePlan("FAST_PATH");
  const handlers = Object.fromEntries(plan.stages.filter((s) => s.disposition === "REQUIRED").map((s) => [s.stage, true]));
  const out = assertRequiredStagesHandled(plan, { ...handlers, LEARNING: true });
  assert.equal(out.ok, false);
  assert.equal(out.holdCode, EXECUTION_HOLDS.SOP_FORBIDDEN_STAGE_BOUND);
});

// ── T10 SINGLE_AUTHORITY_BIND ────────────────────────────────────────────

test("T10: single authority — one PROFILE_MATRIX, one stage registry, coordinator keeps no scale judgment", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const srcRoot = resolve(HERE, "..", "src");
  const matrixDefs = [];
  const stageDefs = [];
  const scaleDefs = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".mjs")) {
        const text = await readFile(p, "utf8");
        if (/export const PROFILE_MATRIX\b/.test(text)) matrixDefs.push(p);
        if (/export const SOP_STAGES\b/.test(text)) stageDefs.push(p);
        if (/SCALE_FOR_PROFILE\s*=\s*Object\.freeze/.test(text)) scaleDefs.push(p);
      }
    }
  }
  await walk(srcRoot);
  assert.deepEqual(matrixDefs, [resolve(srcRoot, "admission/policy-projection.mjs")]);
  assert.deepEqual(stageDefs, [resolve(srcRoot, "sop/proportional-sop.mjs")]);
  assert.deepEqual(scaleDefs, [resolve(srcRoot, "sop/proportional-sop.mjs")]);
  // the coordinator consumes the bind; it declares NO second scale/matrix copy
  const coord = await readFile(resolve(srcRoot, "control-plane/coordinator.mjs"), "utf8");
  assert.ok(!coord.includes("PROFILE_MATRIX"));
  assert.ok(!coord.includes("SCALE_FOR_PROFILE"));
  assert.ok(coord.includes("createDirectExecutionRunner"));
  // behavioral determinism: identical admissions project identical binds
  assert.deepEqual(projectScalePlan("FAST_PATH"), projectScalePlan("FAST_PATH"));
});

// ── T11 ADMISSION_AND_GOVERNANCE_BYPASS ──────────────────────────────────

test("T11a: forged direct classification (graph nulled, runtime forged) cannot reach the direct path", async () => {
  const std = standardAdmission("T11A"); // M/LOW ⇒ STANDARD ⇒ runtime colima (not FAST_PATH)
  const { plan } = coordinate({ tasks: [taskInput("t11a", std)] });
  plan.tasks[0].graph = null;
  plan.tasks[0].runtime = "direct"; // FORGED
  rehashPlan(plan);
  const captured = [];
  plan.tasks[0].runnerOpts = { runner: spyRunner(captured) };
  const { results } = await executeSequentially({ plan });
  assert.equal(captured.length, 0);
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].holdCode, "FAST_PATH_DIRECT_SCALE_MISMATCH"); // runner scale guard
});

test("T11b: injected caller `runner` is IGNORED for direct tasks — the SOP bind is the only handler", async () => {
  const cwd = makeGitFixture();
  try {
    const executionId = nextExecutionId();
    const executorAdapter = createScriptedAdapter([
      { expect: { phase: "executor", attempt: 0 }, result: { status: "completed", stdout: evidenceJson(executionId), stderr: "", signal: null, error: null, metadata: {} } },
    ]);
    const captured = [];
    const fast = fastPathAdmission("T11B");
    const { plan } = coordinate({
      tasks: [taskInput("t11b", fast, {
        runnerOpts: {
          runner: spyRunner(captured), // smuggled substitute — must be ignored
          cwd,
          taskCard: makeTaskCard(cwd, executionId),
          executorAdapter,
          reviewerAdapter: passVerdictAdapter(),
          timeoutMs: 30_000,
        },
      })],
    });
    const { results } = await executeSequentially({ plan });
    assert.equal(captured.length, 0); // spy NEVER invoked
    assert.equal(results[0].dispatched, true);
    assert.equal(results[0].result.executionPath, "direct"); // real bind ran
    assert.equal(executorAdapter.callRecord.length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T11c: forged capability set is rejected by admission authority before any dispatch", async () => {
  const forged = forgeAdmission(fastPathAdmission("T11C"), {
    capabilities: { required: [], allowed: [], denied: [] },
  });
  const captured = [];
  const { plan } = coordinate({ tasks: [taskInput("t11c", forged, { runnerOpts: { runner: spyRunner(captured) } })] });
  const { results } = await executeSequentially({ plan });
  assert.equal(captured.length, 0);
  assert.equal(results[0].dispatched, false);
  assert.ok(results[0].holdCode); // optimizer/admission authority rejected the rehash
});

test("T11d: governance DI seams stay rejected on direct tasks (AUTHORITY_OVERRIDE_REJECTED)", async () => {
  const fast = fastPathAdmission("T11D");
  const { plan } = coordinate({
    tasks: [taskInput("t11d", fast, { runnerOpts: { closeoutGate: async () => ({ ok: true }) } })],
  });
  const { results } = await executeSequentially({ plan });
  assert.equal(results[0].dispatched, false);
  assert.equal(results[0].holdCode, EXECUTION_HOLDS.AUTHORITY_OVERRIDE_REJECTED);
});

// ── T14 RETRY_AND_DUPLICATE_FENCE ────────────────────────────────────────

test("T14: repair budget 0 on S0 — REPAIR verdict exhausts honestly, retry meter stays clean", async () => {
  const { results, cwd } = await runS0Positive({
    verdict: { verdict: "NEEDS_SUPPLEMENT", confidence: "HIGH", recommended_next_action: "REPAIR" },
  });
  rmSync(cwd, { recursive: true, force: true });
  const r = results[0].result;
  assert.equal(r.final, "HOLD");
  assert.match(String(r.reason), /REPAIR_BUDGET_EXHAUSTED/);
  assert.equal(r.lifecycle.attempt, 0); // no second executor attempt was lawful
  assert.deepEqual(r.budget.reconciliation.diverged, []); // meters agree with evidence
  assert.equal(r.budget.reconciliation.observed.retry_count, 0);
});

test("T14b: repeated dispatch of the same S0 task creates independent ledgers — no silent accumulation", async () => {
  const cwd = makeGitFixture();
  try {
    for (const round of [1, 2]) {
      // Each round is a FRESH coordinate→execute cycle (fresh scripted
      // adapters + fresh scope baseline): the budget enforcement object is
      // created inside runAdmittedGraph per call, so consumption must start
      // at zero every time — never accumulate across dispatches.
      const executionId = nextExecutionId();
      const executorAdapter = createScriptedAdapter([
        { expect: { phase: "executor", attempt: 0 }, result: { status: "completed", stdout: evidenceJson(executionId), stderr: "", signal: null, error: null, metadata: {} } },
      ]);
      const fast = fastPathAdmission("T14B");
      const { plan } = coordinate({
        tasks: [taskInput("t14b", fast, {
          runnerOpts: {
            cwd,
            taskCard: makeTaskCard(cwd, executionId),
            executorAdapter,
            reviewerAdapter: passVerdictAdapter(),
            timeoutMs: 30_000,
          },
        })],
      });
      const run = await executeSequentially({ plan });
      assert.equal(run.results[0].dispatched, true, `round ${round}`);
      assert.equal(run.results[0].result.final, "PASS");
      assert.deepEqual(run.results[0].result.budget.reconciliation.diverged, []);
      assert.equal(run.results[0].result.budget.dimensions.node_execution_count.consumed, 1);
      assert.equal(executorAdapter.callRecord.length, 1);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
