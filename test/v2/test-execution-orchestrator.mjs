// test/v2/test-execution-orchestrator.mjs
//
// C2 — DAG-to-lifecycle execution orchestrator tests.
// Offline only: scripted/custom adapters over a temp git worktree.
// No provider, no Pi executable, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runExecutionOrchestrator } from "../../src/v2/execution-orchestrator.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_EVIDENCE = JSON.parse(
  readFileSync(new URL("../fixtures/implementation-evidence-valid.json", import.meta.url), "utf8"),
);

// ── helpers ──

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "c2-orchestrator-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function evidenceJson(request, overrides = {}) {
  // C4N: bind the evidence contract identity to the phase execution id
  // issued by AutoLoop（taskCard.executionId）; the review bundle enforces
  // this correspondence, so fixtures must carry the real phase id.
  const contractId = request?.taskCard?.executionId ?? FIXTURE_EVIDENCE.contract_id;
  return JSON.stringify({ ...FIXTURE_EVIDENCE, contract_id: contractId, ...overrides });
}

function verdictJson({ verdict, confidence = "HIGH", model = "test-model", summary = "ok", recommended_next_action } = {}) {
  return JSON.stringify({ verdict, confidence, model, summary, recommended_next_action });
}

function completed(stdout, executionId) {
  return { status: "completed", executionId, stdout, stderr: "", signal: null, error: null, metadata: { exitCode: 0 } };
}

function aborted(executionId) {
  return { status: "aborted", executionId, stdout: "", stderr: "", signal: null, error: null, metadata: {} };
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const MANIFEST = [
  { requirement_id: "R1", text: "analyze the current state" },
  { requirement_id: "R2", text: "implement the change" },
];
const PARENT = { scope: { allowed_paths: ["src/"], forbidden_paths: [] } };

// 2-phase IR：p_analysis（read-only）+ p_impl（writer，依賴 p_analysis）
function twoPhaseIr() {
  return {
    verdict: "DECOMPOSED",
    parent_goal: "goal",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [
      {
        phase_id: "p_analysis",
        title: "Analysis", summary: "read-only", responsibility: "R1 analysis", purpose: "analysis",
        effects: {
          artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
          evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
        },
        covers: [{ requirement_id: "R1", completeness: "complete", claim: "covers R1" }],
        depends_on: [],
      },
      {
        phase_id: "p_impl",
        title: "Implementation", summary: "writer", responsibility: "R2 implementation", purpose: "implementation",
        effects: {
          artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
          evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: ["evidence/"] },
        },
        covers: [{ requirement_id: "R2", completeness: "complete", claim: "covers R2" }],
        depends_on: ["p_analysis"],
      },
    ],
    dispositions: [],
    decomposition_evidence: ["test"],
  };
}

// 2 independent writer phases（no deps）
function twoWritersIr() {
  const ir = twoPhaseIr();
  ir.phases = [
    {
      phase_id: "p_w1",
      title: "Impl A", summary: "writer a", responsibility: "R1 impl", purpose: "implementation",
      effects: {
        artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
        evidence_output: "persistent", boundaries: { artifact: ["src/a/"], runtime: [], external_system: [], evidence: ["evidence/"] },
      },
      covers: [{ requirement_id: "R1", completeness: "complete", claim: "covers R1" }],
      depends_on: [],
    },
    {
      phase_id: "p_w2",
      title: "Impl B", summary: "writer b", responsibility: "R2 impl", purpose: "implementation",
      effects: {
        artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
        evidence_output: "persistent", boundaries: { artifact: ["src/b/"], runtime: [], external_system: [], evidence: ["evidence/"] },
      },
      covers: [{ requirement_id: "R2", completeness: "complete", claim: "covers R2" }],
      depends_on: [],
    },
  ];
  return ir;
}

// 2 independent read-only phases
function twoReadOnlyIr() {
  const ir = twoPhaseIr();
  ir.phases = [
    {
      phase_id: "p_a1",
      title: "Audit A", summary: "ro a", responsibility: "R1 audit", purpose: "analysis",
      effects: {
        artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
        evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
      },
      covers: [{ requirement_id: "R1", completeness: "complete", claim: "covers R1" }],
      depends_on: [],
    },
    {
      phase_id: "p_a2",
      title: "Audit B", summary: "ro b", responsibility: "R2 audit", purpose: "analysis",
      effects: {
        artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
        evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
      },
      covers: [{ requirement_id: "R2", completeness: "complete", claim: "covers R2" }],
      depends_on: [],
    },
  ];
  return ir;
}

// default factories：executor 產出合法 evidence，reviewer 回 PASS
function defaultFactories(executorOverride, reviewerOverride) {
  const executorFactoryCalls = [];
  const reviewerFactoryCalls = [];
  return {
    executorAdapterFactory: () => {
      executorFactoryCalls.push({ at: Date.now() });
      return executorOverride ? executorOverride() : createScriptedAdapter([
        { expect: { phase: "executor", attempt: 0 }, result: (req) => completed(evidenceJson(req), "x") },
      ]);
    },
    reviewerAdapterFactory: () => {
      reviewerFactoryCalls.push({ at: Date.now() });
      return reviewerOverride ? reviewerOverride() : createScriptedAdapter([
        { expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" }), "x") },
      ]);
    },
    executorFactoryCalls,
    reviewerFactoryCalls,
  };
}

// C4Q harness configuration for offline orchestrator runs.
const HARNESS_HOOKS = {
  toolPolicy: { mode: "no-tools" },
  environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  expectedReviewerModel: "test-model",
  verificationCommand: ["node", "-e", "process.exit(0)"],
  expectedExecutorModel: "deepseek-v4-flash",
  expectedExecutorProvider: "deepseek",
};

// ── tests ──

test("T1: valid 2-phase IR → phases all run through lifecycle → PASS, dependency order respected", async () => {
  const cwd = gitFixture();
  try {
    const factories = defaultFactories();
    const r = await runExecutionOrchestrator({
      ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ...factories, hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "PASS");
    assert.equal(r.scheduler.verdict, "PASS");
    assert.deepEqual(r.scheduler.order, ["p_analysis", "p_impl"]);
    assert.equal(r.phaseResults.length, 2);
    assert.ok(r.phaseResults.every((p) => p.status === "passed"));
    assert.equal(r.scheduler.leaseHolderAfter, null);
    assert.equal(factories.executorFactoryCalls.length, 2, "fresh executor adapter per phase");
    assert.equal(factories.reviewerFactoryCalls.length, 2, "fresh reviewer adapter per phase");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T2: executor/reviewer adapters are routed strictly by phase", async () => {
  const cwd = gitFixture();
  try {
    // 若 lifecycle 錯把 reviewer call 送進 executor adapter（或反之），
    // scripted adapter 會因 phase_mismatch 拋錯 → HOLD。
    const r = await runExecutionOrchestrator({
      ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ...defaultFactories(), hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "PASS");
    // 每 phase 之 lifecycle transitions 應含 executor 與 reviewer 各一
    for (const t of r.transitions) {
      const phases = t.lifecycleTransitions.map((x) => x.phase);
      assert.ok(phases.includes("executor") && phases.includes("reviewer"), `phase ${t.phaseId} must see both executor and reviewer`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T3: missing executor adapter factory → HOLD before any call", async () => {
  const r = await runExecutionOrchestrator({
    ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd: gitFixture(),
    executionId: "exec_cccccccccccccccccccccccccccccccc",
    executorAdapterFactory: undefined, reviewerAdapterFactory: () => createScriptedAdapter([]),
    hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "MISSING_EXECUTOR_ADAPTER_FACTORY");
  assert.deepEqual(r.phaseResults, []);
});

test("T4: missing reviewer adapter factory → HOLD before any call", async () => {
  const r = await runExecutionOrchestrator({
    ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd: gitFixture(),
    executionId: "exec_dddddddddddddddddddddddddddddddd",
    executorAdapterFactory: () => createScriptedAdapter([]), reviewerAdapterFactory: undefined,
    hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "MISSING_REVIEWER_ADAPTER_FACTORY");
});

test("T5: invalid repair budget → HOLD", async () => {
  const r = await runExecutionOrchestrator({
    ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd: gitFixture(),
    executionId: "exec_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    ...defaultFactories(), maxRepairAttempts: 2, timeoutMs: 1000,
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "INVALID_REPAIR_BUDGET");
});

test("T6: invalid timeout → HOLD", async () => {
  const r = await runExecutionOrchestrator({
    ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd: gitFixture(),
    executionId: "exec_ffffffffffffffffffffffffffffffff",
    ...defaultFactories(), maxRepairAttempts: 0, timeoutMs: 0,
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "INVALID_TIMEOUT");
});

test("T7: two ready writers never run simultaneously (single-writer lease)", async () => {
  const cwd = gitFixture();
  try {
    let active = 0;
    let maxActive = 0;
    const executorAdapterFactory = () => ({
      runAdapter: async (request) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((res) => setTimeout(res, 10));
        active -= 1;
        return completed(evidenceJson(request), request.executionId);
      },
    });
    const reviewerAdapterFactory = () => ({
      runAdapter: async (request) => completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" }), request.executionId),
    });
    const r = await runExecutionOrchestrator({
      ir: twoWritersIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_11111111111111111111111111111111",
      executorAdapterFactory, reviewerAdapterFactory, hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "PASS");
    assert.equal(maxActive, 1, "never more than one writer executing");
    assert.equal(r.scheduler.writerViolations.length, 0);
    assert.equal(r.scheduler.leaseHolderAfter, null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T8: read-only phase runs per DAG rules (no mutation authority)", async () => {
  const cwd = gitFixture();
  try {
    const r = await runExecutionOrchestrator({
      ir: twoReadOnlyIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_22222222222222222222222222222222",
      ...defaultFactories(), hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "PASS");
    assert.equal(r.phaseResults.length, 2);
    // read-only phases get an empty allowlist → any repo change would violate scope
    for (const t of r.transitions) {
      const gate = t.lifecycleTransitions.find((x) => x.phase === "mutation_scope_gate");
      assert.ok(gate, "read-only phase still runs the mutation scope gate");
      assert.equal(gate.ok, true);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T9: writer phase without artifact boundary → HOLD PHASE_MUTATION_BOUNDARY_MISSING", async () => {
  const cwd = gitFixture();
  try {
    const ir = twoPhaseIr();
    ir.phases[1].effects.boundaries.artifact = [];
    const r = await runExecutionOrchestrator({
      ir, parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_33333333333333333333333333333333",
      ...defaultFactories(), hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.phaseResults.find((p) => p.phaseId === "p_impl").reason, "PHASE_MUTATION_BOUNDARY_MISSING");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T10: writer path traversal / absolute / wildcard → HOLD PHASE_ARTIFACT_PATH_INVALID", async () => {
  const cwd = gitFixture();
  try {
    for (const bad of ["../outside", "/abs/path", "**", "src/../escape"]) {
      const ir = twoPhaseIr();
      ir.phases[1].effects.boundaries.artifact = [bad];
      const r = await runExecutionOrchestrator({
        ir, parent: PARENT, manifest: MANIFEST, cwd,
        executionId: "exec_44444444444444444444444444444444",
        ...defaultFactories(), hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
      });
      assert.equal(r.final, "HOLD", `boundary "${bad}" must HOLD`);
      assert.equal(r.phaseResults.find((p) => p.phaseId === "p_impl").reason, "PHASE_ARTIFACT_PATH_INVALID", `boundary "${bad}"`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T11: parent authority must not be expanded by a child (out of scope / forbidden)", async () => {
  const cwd = gitFixture();
  try {
    const outOfScope = twoPhaseIr();
    outOfScope.phases[1].effects.boundaries.artifact = ["outside/"];
    const r1 = await runExecutionOrchestrator({
      ir: outOfScope, parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_55555555555555555555555555555555",
      ...defaultFactories(), hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r1.final, "HOLD");
    assert.equal(r1.phaseResults.find((p) => p.phaseId === "p_impl").reason, "PHASE_ARTIFACT_OUT_OF_PARENT_SCOPE");

    const forbidden = twoPhaseIr();
    forbidden.phases[1].effects.boundaries.artifact = ["src/secrets/x"];
    const r2 = await runExecutionOrchestrator({
      ir: forbidden,
      parent: { scope: { allowed_paths: ["src/"], forbidden_paths: ["src/secrets/"] } },
      manifest: MANIFEST, cwd,
      executionId: "exec_66666666666666666666666666666666",
      ...defaultFactories(), hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r2.final, "HOLD");
    assert.equal(r2.phaseResults.find((p) => p.phaseId === "p_impl").reason, "PHASE_ARTIFACT_IN_FORBIDDEN_PATH");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T12: executor output format does not gate evidence（C4Q harness-owned）", async () => {
  const cwd = gitFixture();
  try {
    const r = await runExecutionOrchestrator({
      ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_77777777777777777777777777777777",
      ...defaultFactories(
        () => createScriptedAdapter([{ expect: { phase: "executor", attempt: 0 }, result: completed("not json", "x") }]),
      ),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    // C4Q: the executor final message is non-authoritative — malformed text
    // still yields a harness-owned evidence object and the phase proceeds.
    assert.equal(r.final, "PASS");
    assert.equal(r.phaseResults.length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T13: malformed reviewer verdict → HOLD", async () => {
  const cwd = gitFixture();
  try {
    const r = await runExecutionOrchestrator({
      ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_88888888888888888888888888888888",
      ...defaultFactories(
        undefined,
        () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: completed("not json", "x") }]),
      ),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.phaseResults.find((p) => p.phaseId === "p_analysis").reason, "MALFORMED_REVIEWER_VERDICT");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T14: one REPAIR then PASS → second attempt succeeds", async () => {
  const cwd = gitFixture();
  try {
    const r = await runExecutionOrchestrator({
      ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_99999999999999999999999999999999",
      ...defaultFactories(
        () => createScriptedAdapter([
          { expect: { phase: "executor", attempt: 0 }, result: (req) => completed(evidenceJson(req), "x") },
          { expect: { phase: "executor", attempt: 1 }, result: (req) => completed(evidenceJson(req), "x") },
        ]),
        () => createScriptedAdapter([
          { expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson({ verdict: "NEEDS_SUPPLEMENT", recommended_next_action: "REPAIR" }), "x") },
          { expect: { phase: "reviewer", attempt: 1 }, result: completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" }), "x") },
        ]),
      ),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 1, timeoutMs: 1000,
    });
    assert.equal(r.final, "PASS");
    const impl = r.phaseResults.find((p) => p.phaseId === "p_impl");
    assert.equal(impl.attempt, 1);
    assert.equal(r.transitions.find((t) => t.phaseId === "p_impl").final, "PASS");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T15: second REPAIR request → REPAIR_BUDGET_EXHAUSTED HOLD", async () => {
  const cwd = gitFixture();
  try {
    const r = await runExecutionOrchestrator({
      ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
      ...defaultFactories(
        () => createScriptedAdapter([
          { expect: { phase: "executor", attempt: 0 }, result: (req) => completed(evidenceJson(req), "x") },
          { expect: { phase: "executor", attempt: 1 }, result: (req) => completed(evidenceJson(req), "x") },
        ]),
        () => createScriptedAdapter([
          { expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson({ verdict: "NEEDS_SUPPLEMENT", recommended_next_action: "REPAIR" }), "x") },
          { expect: { phase: "reviewer", attempt: 1 }, result: completed(verdictJson({ verdict: "NEEDS_SUPPLEMENT", recommended_next_action: "REPAIR" }), "x") },
        ]),
      ),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 1, timeoutMs: 1000,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.phaseResults.find((p) => p.phaseId === "p_analysis").reason, "REPAIR_BUDGET_EXHAUSTED");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T16: phase HOLD → descendants skipped, run HOLD", async () => {
  const cwd = gitFixture();
  try {
    const r = await runExecutionOrchestrator({
      ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2",
      ...defaultFactories(
        undefined,
        () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson({ verdict: "HOLD", recommended_next_action: "HUMAN_REVIEW" }), "x") }]),
      ),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "HOLD");
    assert.ok(r.scheduler.skipped.includes("p_impl"), "p_impl must be skipped after p_analysis HOLD");
    assert.equal(r.scheduler.statuses.p_impl, "skipped_due_to_dependency");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T17: pre-aborted signal → HOLD, zero lifecycle calls, lease never held", async () => {
  const cwd = gitFixture();
  try {
    const factories = defaultFactories();
    const ac = new AbortController();
    ac.abort();
    const r = await runExecutionOrchestrator({
      ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3",
      ...factories, hooks: HARNESS_HOOKS, hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000, signal: ac.signal,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.scheduler.leaseHolderAfter, null);
    assert.equal(factories.executorFactoryCalls.length, 0);
    assert.equal(factories.reviewerFactoryCalls.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T18: abort during a running writer → HOLD and writer lease released", async () => {
  const cwd = gitFixture();
  try {
    const executorAdapterFactory = () => ({
      runAdapter: async (request) => {
        if (request.abortSignal?.aborted) return aborted(request.executionId);
        await new Promise((resolve) => {
          const onAbort = () => { request.abortSignal?.removeEventListener("abort", onAbort); resolve(); };
          request.abortSignal?.addEventListener("abort", onAbort, { once: true });
          setTimeout(resolve, 2000); // never resolves before abort in this test
        });
        return request.abortSignal?.aborted ? aborted(request.executionId) : completed(evidenceJson(request), request.executionId);
      },
    });
    const reviewerAdapterFactory = () => ({
      runAdapter: async (request) => completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" }), request.executionId),
    });
    const ac = new AbortController();
    const promise = runExecutionOrchestrator({
      ir: twoWritersIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4",
      executorAdapterFactory, reviewerAdapterFactory, hooks: HARNESS_HOOKS, hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000, signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 30);
    const r = await promise;
    assert.equal(r.final, "HOLD");
    assert.equal(r.scheduler.leaseHolderAfter, null, "writer lease must be released on abort");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T19: unexpected executor exception → phase failed → run HOLD", async () => {
  const cwd = gitFixture();
  try {
    const r = await runExecutionOrchestrator({
      ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5",
      ...defaultFactories(
        () => ({ runAdapter: async () => { throw new Error("boom"); } }),
      ),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.phaseResults.find((p) => p.phaseId === "p_analysis").status, "failed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T20: scheduler does not add or modify DAG edges", async () => {
  const cwd = gitFixture();
  try {
    const ir = twoPhaseIr();
    const dependsBefore = ir.phases.map((p) => [p.phase_id, [...p.depends_on]]);
    const r = await runExecutionOrchestrator({
      ir, parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6",
      ...defaultFactories(), hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "PASS");
    const dependsAfter = r.scheduler.phases.map((p) => [p.phase_id, [...p.depends_on]]);
    assert.deepEqual(dependsAfter, dependsBefore, "runner must not modify depends_on");
    assert.equal(r.scheduler.writerViolations.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T21: no phase starts after a HOLD (HOLD propagation is terminal)", async () => {
  const cwd = gitFixture();
  try {
    const r = await runExecutionOrchestrator({
      ir: twoPhaseIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7",
      ...defaultFactories(
        undefined,
        () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson({ verdict: "HOLD", recommended_next_action: "HUMAN_REVIEW" }), "x") }]),
      ),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "HOLD");
    // p_analysis held → p_impl must never have run
    assert.ok(!r.phaseResults.some((p) => p.phaseId === "p_impl" && p.status === "passed"));
    assert.equal(r.scheduler.statuses.p_impl, "skipped_due_to_dependency");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
