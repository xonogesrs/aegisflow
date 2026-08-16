// test-lifecycle-runner.mjs
//
// Offline unit tests for lifecycle-runner.mjs using the deterministic
// scripted adapter only. No subprocess, no network, no provider, no real
// LLM call anywhere in this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runLifecycle } from "../src/lifecycle-runner.mjs";
import { createScriptedAdapter } from "../src/adapter/scripted-adapter.mjs";
import { captureScopeSnapshot } from "../src/c2d/mutation-scope.mjs";
import { buildPhaseTaskCard, deriveScopePatterns } from "../src/v2/phase-task-card.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_EVIDENCE = JSON.parse(
  readFileSync(resolve(HERE, "fixtures", "implementation-evidence-valid.json"), "utf8"),
);

function evidenceJson(overrides = {}) {
  return JSON.stringify({ ...FIXTURE_EVIDENCE, ...overrides });
}

// C4N: bind the evidence contract identity to the phase execution id from
// the request's task card（the review bundle enforces this correspondence）.
function evidenceFor(request, overrides = {}) {
  const contractId = request?.taskCard?.executionId ?? FIXTURE_EVIDENCE.contract_id;
  return JSON.stringify({ ...FIXTURE_EVIDENCE, contract_id: contractId, ...overrides });
}

function verdictJson({ verdict, confidence = "HIGH", model = "test-model", summary = "ok", recommended_next_action, ...rest } = {}) {
  return JSON.stringify({ verdict, confidence, model, summary, recommended_next_action, ...rest });
}

function completed(stdout) {
  return { status: "completed", stdout, stderr: "", signal: null, error: null, metadata: { exitCode: 0 } };
}

// C4Q harness configuration + real baseline snapshot so the harness-owned
// evidence builder can assemble facts for direct lifecycle tests.
const FIXTURE_CWD = (() => {
  const dir = mkdtempSync(join(tmpdir(), "c1-life-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
})();

const WRITER_PHASE = {
  phase_id: "p_impl", title: "Impl", summary: "writer", responsibility: "R1 impl", purpose: "implementation",
  effects: {
    artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
    evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] },
  },
  covers: [{ requirement_id: "R1", completeness: "complete", claim: "covers R1" }],
  depends_on: [],
};

function baseCard(overrides = {}) {
  const card = buildPhaseTaskCard({
    phase: WRITER_PHASE,
    parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
    executionId: "exec_11111111111111111111111111111111",
    cwd: FIXTURE_CWD,
    maxRepairAttempts: 0,
    expectedReviewerModel: "test-model",
    toolPolicy: { mode: "no-tools" },
    environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  });
  card.verificationCommand = ["node", "-e", "process.exit(0)"];
  card.expectedExecutorModel = "deepseek-v4-flash";
  card.expectedExecutorProvider = "deepseek";
  card.mutationScope = {
    repositoryRoot: FIXTURE_CWD,
    baselineSnapshot: captureScopeSnapshot(FIXTURE_CWD),
    allowedPaths: deriveScopePatterns(card.allowedPaths),
    forbiddenPaths: deriveScopePatterns(card.forbiddenPaths),
  };
  return { ...card, ...overrides };
}

test("direct PASS: executor completed + reviewer PASS resolves final PASS at attempt 0", async () => {
  const adapter = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
    {
      expect: { phase: "reviewer", attempt: 0 },
      result: completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" })),
    },
  ]);

  const outcome = await runLifecycle({
    cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 0, timeoutMs: 1000,
  });

  assert.equal(outcome.final, "PASS");
  assert.equal(outcome.attempt, 0);
  assert.equal(adapter.callRecord.length, 2);
});

test("one REPAIR then PASS: attempt numbers and call count are exact", async () => {
  const adapter = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
    {
      expect: { phase: "reviewer", attempt: 0 },
      result: completed(verdictJson({ verdict: "NEEDS_SUPPLEMENT", recommended_next_action: "REPAIR" })),
    },
    { expect: { phase: "executor", attempt: 1 }, result: completed(evidenceJson()) },
    {
      expect: { phase: "reviewer", attempt: 1 },
      result: completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" })),
    },
  ]);

  const outcome = await runLifecycle({
    cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 1, timeoutMs: 1000,
  });

  assert.equal(outcome.final, "PASS");
  assert.equal(outcome.attempt, 1);
  assert.equal(adapter.callRecord.length, 4);
  assert.deepEqual(
    outcome.transitions.filter((t) => t.phase === "executor" || t.phase === "reviewer").map((t) => [t.phase, t.attempt]),
    [["executor", 0], ["reviewer", 0], ["executor", 1], ["reviewer", 1]],
  );
});

test("repair budget exhausted at maxRepairAttempts=0: immediate HOLD, no second executor call", async () => {
  const adapter = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
    {
      expect: { phase: "reviewer", attempt: 0 },
      result: completed(verdictJson({ verdict: "HOLD", recommended_next_action: "REPAIR" })),
    },
  ]);

  const outcome = await runLifecycle({
    cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 0, timeoutMs: 1000,
  });

  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "REPAIR_BUDGET_EXHAUSTED");
  assert.equal(adapter.callRecord.length, 2, "must not call executor a second time");
});

test("repair budget exhausted at maxRepairAttempts=1 after two REPAIR verdicts", async () => {
  const adapter = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
    {
      expect: { phase: "reviewer", attempt: 0 },
      result: completed(verdictJson({ verdict: "HOLD", recommended_next_action: "REPAIR" })),
    },
    { expect: { phase: "executor", attempt: 1 }, result: completed(evidenceJson()) },
    {
      expect: { phase: "reviewer", attempt: 1 },
      result: completed(verdictJson({ verdict: "HOLD", recommended_next_action: "REPAIR" })),
    },
  ]);

  const outcome = await runLifecycle({
    cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 1, timeoutMs: 1000,
  });

  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "REPAIR_BUDGET_EXHAUSTED");
  assert.equal(outcome.attempt, 1);
  assert.equal(adapter.callRecord.length, 4);
});

test("executor error status yields HOLD EXECUTOR_ERROR without any reviewer call", async () => {
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 0 },
      result: { status: "error", stdout: "", stderr: "crash", signal: null, error: "crash", metadata: {} },
    },
  ]);
  const outcome = await runLifecycle({ cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 0, timeoutMs: 1000 });
  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "EXECUTOR_ERROR");
  assert.equal(adapter.callRecord.length, 1);
});

test("executor timed_out status yields HOLD EXECUTOR_TIMEOUT without any reviewer call", async () => {
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 0 },
      result: { status: "timed_out", stdout: "", stderr: "", signal: null, error: null, metadata: {} },
    },
  ]);
  const outcome = await runLifecycle({ cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 0, timeoutMs: 1000 });
  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "EXECUTOR_TIMEOUT");
  assert.equal(adapter.callRecord.length, 1);
});

test("abortSignal already aborted before start yields HOLD ABORTED_BEFORE_START with zero adapter calls", async () => {
  const adapter = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
  ]);
  const controller = new AbortController();
  controller.abort();
  const outcome = await runLifecycle({
    cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 0, timeoutMs: 1000, abortSignal: controller.signal,
  });
  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "ABORTED_BEFORE_START");
  assert.equal(adapter.callRecord.length, 0);
  assert.equal(adapter.remaining, 1);
});

test("malformed reviewer verdict (invalid enum) yields HOLD MALFORMED_REVIEWER_VERDICT, never guesses PASS", async () => {
  const adapter = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
    {
      expect: { phase: "reviewer", attempt: 0 },
      result: completed(JSON.stringify({
        verdict: "MAYBE_PASS_I_GUESS", confidence: "HIGH", summary: "PASS mentioned in free text", recommended_next_action: "STOP",
      })),
    },
  ]);
  const outcome = await runLifecycle({ cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 1, timeoutMs: 1000 });
  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "MALFORMED_REVIEWER_VERDICT");
});

test("reviewer stdout that isn't valid JSON yields HOLD MALFORMED_REVIEWER_VERDICT", async () => {
  const adapter = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
    { expect: { phase: "reviewer", attempt: 0 }, result: completed("PASS! looks great, ship it") },
  ]);
  const outcome = await runLifecycle({ cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 1, timeoutMs: 1000 });
  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "MALFORMED_REVIEWER_VERDICT");
});

test("reviewer status !== completed is never parsed as a verdict even if stdout looks like PASS", async () => {
  const adapter = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
    {
      expect: { phase: "reviewer", attempt: 0 },
      result: { status: "error", stdout: JSON.stringify({ verdict: "PASS" }), stderr: "", signal: null, error: "boom", metadata: {} },
    },
  ]);
  const outcome = await runLifecycle({ cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 1, timeoutMs: 1000 });
  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "REVIEWER_ERROR");
});

test("reviewer PASS with LOW confidence is suppressed by normalize-reviewer-json.mjs's business rule and never becomes final PASS", async () => {
  const adapter = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
    {
      expect: { phase: "reviewer", attempt: 0 },
      // Schema-shape-valid (verdict/confidence/model/summary/recommended_next_action
      // all present and individually well-typed), but PASS + LOW confidence --
      // exactly the semantic-drift scenario this unification card exists to close.
      result: completed(JSON.stringify({
        verdict: "PASS", confidence: "LOW", model: "test-model", summary: "looks fine to me",
        recommended_next_action: "STOP",
      })),
    },
  ]);
  const outcome = await runLifecycle({ cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 1, timeoutMs: 1000 });
  assert.notEqual(outcome.final, "PASS");
  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "REVIEWER_HOLD");
});

test("script sequence mismatch (runner calls executor first, script expects reviewer) fails closed", async () => {
  const adapter = createScriptedAdapter([
    { expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" })) },
  ]);
  const outcome = await runLifecycle({ cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 0, timeoutMs: 1000 });
  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "SCRIPT_SEQUENCE_MISMATCH");
});

test("malformed adapter result (contract violation) fails closed as HOLD MALFORMED_ADAPTER_RESULT", async () => {
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 0 },
      // "completed" must not carry a signal per adapter/contract.mjs.
      result: { status: "completed", stdout: evidenceJson(), stderr: "", signal: "SIGTERM", error: null, metadata: {} },
    },
  ]);
  const outcome = await runLifecycle({ cwd: "/tmp", taskCard: baseCard(), adapter, maxRepairAttempts: 0, timeoutMs: 1000 });
  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "MALFORMED_ADAPTER_RESULT");
});

test("executor output is non-authoritative; harness schema validation is the gate（C4Q）", async () => {
  // The executor final message is NOT parsed as evidence under C4Q. Even a
  // malformed object proceeds to the reviewer; the harness-owned evidence is
  // assembled and schema-validated by the harness builder itself.
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 0 },
      result: completed(JSON.stringify({ not_evidence: true })),
    },
    { expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" })) },
  ]);
  const outcome = await runLifecycle({ cwd: FIXTURE_CWD, taskCard: baseCard(), adapter, maxRepairAttempts: 0, timeoutMs: 1000 });
  assert.equal(outcome.final, "PASS");
  assert.equal(adapter.callRecord.length, 2, "reviewer is reached regardless of executor output format");
});

// ---------------------------------------------------------------------------
// Mutation scope: AutoLoop core (c2d/mutation-scope.mjs), not the adapter,
// is the authority. The scripted adapter self-reports "completed" in this
// test; the lifecycle must still HOLD because the real fixture repository
// shows a change outside the declared allowlist.
// ---------------------------------------------------------------------------

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-scope-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.txt"), "a\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("mutation scope violation forces HOLD even when the adapter self-reports success", async () => {
  const repositoryRoot = gitFixture();
  try {
    const baselineSnapshot = captureScopeSnapshot(repositoryRoot);
    // Simulate an out-of-scope change made by whatever produced this
    // executor result (the scripted adapter itself never touches disk).
    writeFileSync(join(repositoryRoot, "escaped.txt"), "not allowed\n");

    const adapter = createScriptedAdapter([
      { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
    ]);

    const outcome = await runLifecycle({
      cwd: repositoryRoot,
      taskCard: baseCard({
        mutationScope: { repositoryRoot, baselineSnapshot, allowedPaths: ["src/**"], forbiddenPaths: [] },
      }),
      adapter,
      maxRepairAttempts: 1,
      timeoutMs: 1000,
    });

    assert.equal(outcome.final, "HOLD");
    assert.equal(outcome.reason, "MUTATION_SCOPE_VIOLATION");
    assert.equal(adapter.callRecord.length, 1, "reviewer must never be called after a scope violation");
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("mutation scope check passes through when the change stays within the allowlist", async () => {
  const repositoryRoot = gitFixture();
  try {
    const baselineSnapshot = captureScopeSnapshot(repositoryRoot);
    writeFileSync(join(repositoryRoot, "src", "b.txt"), "in scope\n");

    const adapter = createScriptedAdapter([
      { expect: { phase: "executor", attempt: 0 }, result: (req) => completed(evidenceFor(req)) },
      {
        expect: { phase: "reviewer", attempt: 0 },
        result: completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" })),
      },
    ]);

    const outcome = await runLifecycle({
      cwd: repositoryRoot,
      taskCard: baseCard({
        // Keep the default executionId so the harness identity re-derivation
        // (phaseExecutionId(run, phase)) stays consistent.
        mutationScope: { repositoryRoot, baselineSnapshot, allowedPaths: ["src/**"], forbiddenPaths: [] },
      }),
      adapter,
      maxRepairAttempts: 0,
      timeoutMs: 1000,
    });

    assert.equal(outcome.final, "PASS");
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

// ── C2: executor/reviewer adapter separation ──

test("C2: split executor/reviewer adapters route by phase", async () => {
  const executorAdapter = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
  ]);
  const reviewerAdapter = createScriptedAdapter([
    { expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" })) },
  ]);

  const outcome = await runLifecycle({
    cwd: "/tmp",
    taskCard: baseCard(),
    executorAdapter,
    reviewerAdapter,
    maxRepairAttempts: 0,
    timeoutMs: 1000,
  });

  assert.equal(outcome.final, "PASS");
  // each adapter saw exactly its own phase
  assert.ok(executorAdapter.callRecord.every((c) => c.phase === "executor"));
  assert.ok(reviewerAdapter.callRecord.every((c) => c.phase === "reviewer"));
  assert.equal(executorAdapter.callRecord.length, 1);
  assert.equal(reviewerAdapter.callRecord.length, 1);
});

test("C2: split pair with one half missing → HOLD MISSING_ADAPTER_PAIR before any call", async () => {
  const executorAdapter = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: completed(evidenceJson()) },
  ]);
  const outcome = await runLifecycle({
    cwd: "/tmp",
    taskCard: baseCard(),
    executorAdapter,
    reviewerAdapter: undefined,
    maxRepairAttempts: 0,
    timeoutMs: 1000,
  });
  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "MISSING_ADAPTER_PAIR");
  assert.equal(executorAdapter.callRecord.length, 0, "no adapter call before fail-closed HOLD");
});

// VCA-1 Phase 0C — the reviewer prompt (sectionAuthority) has always claimed
// "You have NO tools", but prior to this fix the runner passed the SAME
// taskCard.toolPolicy to both roles, so a permissive executor toolPolicy
// silently reached the reviewer's Pi invocation too. The reviewer role is
// verification-only by contract, so its toolPolicy is now hard-pinned in
// lifecycle-runner.mjs regardless of what taskCard.toolPolicy says.
test("VCA-1 Phase 0C: reviewer role always gets a hard no-tools toolPolicy, even when taskCard.toolPolicy is permissive", async () => {
  const seenToolPolicy = { executor: undefined, reviewer: undefined };
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 0 },
      result: (request) => {
        seenToolPolicy.executor = request.toolPolicy;
        return completed(evidenceJson());
      },
    },
    {
      expect: { phase: "reviewer", attempt: 0 },
      result: (request) => {
        seenToolPolicy.reviewer = request.toolPolicy;
        return completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" }));
      },
    },
  ]);

  const permissiveToolPolicy = { mode: "allowlist", tools: ["bash"] };
  const outcome = await runLifecycle({
    cwd: "/tmp",
    taskCard: baseCard({ toolPolicy: permissiveToolPolicy }),
    adapter,
    maxRepairAttempts: 0,
    timeoutMs: 1000,
  });

  assert.equal(outcome.final, "PASS");
  assert.deepEqual(seenToolPolicy.executor, permissiveToolPolicy, "executor keeps the task card's own toolPolicy");
  assert.deepEqual(seenToolPolicy.reviewer, { mode: "no-tools" }, "reviewer is hard-pinned to no-tools regardless of taskCard.toolPolicy");
});
