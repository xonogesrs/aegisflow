// test/test-autoloop-entrypoint.mjs
//
// C2 — public entrypoint (runAutoLoop) end-to-end offline tests.
// Fake decomposition adapter + scripted executor/reviewer adapters over a
// temp git worktree. No provider, no Pi executable, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runAutoLoop } from "../src/autoloop.mjs";
import { createScriptedAdapter } from "../src/adapter/scripted-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_EVIDENCE = JSON.parse(
  readFileSync(new URL("./fixtures/implementation-evidence-valid.json", import.meta.url), "utf8"),
);

function dirname(path) {
  return path.replace(/\/[^/]*$/, "");
}

// Handcrafted valid DECOMPOSED IR + manifest + parent（no case oracle）.
const VALID_IR = {
  verdict: "DECOMPOSED",
  parent_goal: "implement the change",
  execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
  phases: [
    {
      phase_id: "p_analysis",
      title: "Analysis", summary: "Read-only analysis", responsibility: "Produce analysis findings for R1",
      purpose: "analysis",
      effects: {
        artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
        evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
      },
      covers: [{ requirement_id: "R1", completeness: "complete", claim: "analysis covers R1" }],
      depends_on: [],
    },
    {
      phase_id: "p_impl",
      title: "Implementation", summary: "Implement the change", responsibility: "Implement R2",
      purpose: "implementation",
      effects: {
        artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
        evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: ["evidence/"] },
      },
      covers: [{ requirement_id: "R2", completeness: "complete", claim: "implements R2" }],
      depends_on: ["p_analysis"],
    },
  ],
  dispositions: [],
  decomposition_evidence: ["test evidence"],
};

const VALID_MANIFEST = [
  { requirement_id: "R1", text: "analyze the current state" },
  { requirement_id: "R2", text: "implement the change" },
];
const VALID_PARENT = { scope: { allowed_paths: ["src/"], forbidden_paths: [] } };

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "c2-entrypoint-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function evidenceJson(request) {
  // C4N: bind contract identity to the phase execution id from the task card.
  const contractId = request?.taskCard?.executionId ?? FIXTURE_EVIDENCE.contract_id;
  return JSON.stringify({ ...FIXTURE_EVIDENCE, contract_id: contractId });
}

function verdictJson(overrides = {}) {
  return JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP", ...overrides });
}

function completed(stdout, executionId) {
  return { status: "completed", executionId, stdout, stderr: "", signal: null, error: null, metadata: { exitCode: 0 } };
}

function adapterFor(ir) {
  return {
    generate: async () => ({ status: "completed", parsed: ir, content: JSON.stringify(ir), thinking: "", usage: null, stopReason: "stop", elapsedMs: 1, requestCount: 1 }),
  };
}

function sourceFor() {
  return {
    goal: "test task",
    requirements: VALID_MANIFEST,
    authority: { allowed_paths: ["src/"], mutation_allowed: true, commit_allowed: false },
  };
}

const EPHEMERAL = { mode: "ephemeral" };

// C4Q harness configuration.
const HARNESS_HOOKS = {
  environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  expectedReviewerModel: "test-model",
  verificationCommand: ["node", "-e", "process.exit(0)"],
  expectedExecutorModel: "deepseek-v4-flash",
  expectedExecutorProvider: "deepseek",
};

function defaultFactories() {
  let executorCalls = 0;
  let reviewerCalls = 0;
  return {
    executorAdapterFactory: () => {
      executorCalls += 1;
      return createScriptedAdapter([{ expect: { phase: "executor", attempt: 0 }, result: (req) => completed(evidenceJson(req), "x") }]);
    },
    reviewerAdapterFactory: () => {
      reviewerCalls += 1;
      return createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson(), "x") }]);
    },
    countCalls: () => ({ executorCalls, reviewerCalls }),
  };
}

test("E1: valid decomposition → all phases through lifecycle → final PASS", async () => {
  const cwd = gitFixture();
  try {
    const factories = defaultFactories();
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: adapterFor(VALID_IR),
      ...factories, hooks: HARNESS_HOOKS,
      maxRepairAttempts: 0, timeoutMs: 1000,
      persistence: EPHEMERAL,
    });
    assert.equal(r.final, "PASS");
    assert.ok(/^exec_[0-9a-f]{32}$/.test(r.executionId), `executionId format: ${r.executionId}`);
    assert.equal(r.decomposition.verdict, "DECOMPOSED");
    assert.equal(r.decomposition.phase_count, 2);
    assert.equal(r.phaseResults.length, 2);
    assert.ok(r.phaseResults.every((p) => p.status === "passed"));
    assert.equal(r.scheduler.verdict, "PASS");
    const { executorCalls, reviewerCalls } = factories.countCalls();
    assert.equal(executorCalls, 2, "fresh executor adapter per phase");
    assert.equal(reviewerCalls, 2, "fresh reviewer adapter per phase");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E2: NOT_BENEFICIAL → zero lifecycle calls, final NOT_BENEFICIAL", async () => {
  const cwd = gitFixture();
  try {
    const ir = {
      verdict: "DECOMPOSITION_NOT_BENEFICIAL",
      reason: "already satisfied",
      dispositions: [
        { requirement_id: "R1", disposition: "not_beneficial", reason_code: "ALREADY_SATISFIED", evidence: "nothing to change" },
        { requirement_id: "R2", disposition: "not_beneficial", reason_code: "ALREADY_SATISFIED", evidence: "nothing to change" },
      ],
      decomposition_evidence: ["test"],
    };
    const factories = defaultFactories();
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: adapterFor(ir),
      ...factories, hooks: HARNESS_HOOKS,
      maxRepairAttempts: 0, timeoutMs: 1000,
      persistence: EPHEMERAL,
    });
    assert.equal(r.final, "NOT_BENEFICIAL");
    const { executorCalls, reviewerCalls } = factories.countCalls();
    assert.equal(executorCalls + reviewerCalls, 0, "zero lifecycle calls");
    assert.deepEqual(r.phaseResults, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E3: DECOMPOSITION_BLOCKED → HOLD, zero lifecycle calls", async () => {
  const cwd = gitFixture();
  try {
    const ir = {
      verdict: "DECOMPOSITION_BLOCKED",
      dispositions: [
        { requirement_id: "R1", disposition: "unresolved", reason_code: "AMBIGUOUS_SCOPE", question: "which module?" },
      ],
      decomposition_evidence: ["test"],
    };
    const factories = defaultFactories();
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: adapterFor(ir),
      ...factories, hooks: HARNESS_HOOKS,
      maxRepairAttempts: 0, timeoutMs: 1000,
      persistence: EPHEMERAL,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.reason, "DECOMPOSITION_BLOCKED");
    const { executorCalls, reviewerCalls } = factories.countCalls();
    assert.equal(executorCalls + reviewerCalls, 0, "zero lifecycle calls");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E4: schema failure → HOLD, zero lifecycle calls", async () => {
  const cwd = gitFixture();
  try {
    const factories = defaultFactories();
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: adapterFor({ verdict: "DECOMPOSED" }),
      ...factories, hooks: HARNESS_HOOKS,
      maxRepairAttempts: 0, timeoutMs: 1000,
      persistence: EPHEMERAL,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.stage, "schema");
    const { executorCalls, reviewerCalls } = factories.countCalls();
    assert.equal(executorCalls + reviewerCalls, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E5: semantic failure → HOLD, zero lifecycle calls", async () => {
  const cwd = gitFixture();
  try {
    const ir = clone(VALID_IR);
    ir.phases[1].covers = []; // R2 uncovered
    const factories = defaultFactories();
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: adapterFor(ir),
      ...factories, hooks: HARNESS_HOOKS,
      maxRepairAttempts: 0, timeoutMs: 1000,
      persistence: EPHEMERAL,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.stage, "semantic");
    const { executorCalls, reviewerCalls } = factories.countCalls();
    assert.equal(executorCalls + reviewerCalls, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E6: missing executor adapter factory → HOLD MISSING_EXECUTOR_ADAPTER_FACTORY", async () => {
  const cwd = gitFixture();
  try {
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: adapterFor(VALID_IR),
      executorAdapterFactory: undefined,
      reviewerAdapterFactory: () => createScriptedAdapter([]),
      hooks: HARNESS_HOOKS,
      maxRepairAttempts: 0, timeoutMs: 1000,
      persistence: EPHEMERAL,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.reason, "MISSING_EXECUTOR_ADAPTER_FACTORY");
    assert.deepEqual(r.phaseResults, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E7: missing reviewer adapter factory → HOLD MISSING_REVIEWER_ADAPTER_FACTORY", async () => {
  const cwd = gitFixture();
  try {
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: adapterFor(VALID_IR),
      executorAdapterFactory: () => createScriptedAdapter([]),
      reviewerAdapterFactory: undefined,
      hooks: HARNESS_HOOKS,
      maxRepairAttempts: 0, timeoutMs: 1000,
      persistence: EPHEMERAL,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.reason, "MISSING_REVIEWER_ADAPTER_FACTORY");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E8: invalid repair budget (2) → HOLD INVALID_REPAIR_BUDGET", async () => {
  const cwd = gitFixture();
  try {
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: adapterFor(VALID_IR),
      ...defaultFactories(), maxRepairAttempts: 2, timeoutMs: 1000,
      persistence: EPHEMERAL,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.reason, "INVALID_REPAIR_BUDGET");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E9: missing / non-positive timeout → HOLD INVALID_TIMEOUT", async () => {
  const cwd = gitFixture();
  try {
    for (const timeoutMs of [undefined, 0, -1]) {
      const r = await runAutoLoop({
        source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
        decompositionAdapter: adapterFor(VALID_IR),
        ...defaultFactories(), maxRepairAttempts: 0, timeoutMs,
        persistence: EPHEMERAL,
      });
      assert.equal(r.final, "HOLD", `timeoutMs=${timeoutMs}`);
      assert.equal(r.reason, "INVALID_TIMEOUT");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E10: result contract — no secrets, no env, no raw reasoning in the result", async () => {
  const cwd = gitFixture();
  try {
    const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const evidenceWithSecret = { ...FIXTURE_EVIDENCE, executor_verdict: `done with key ${SECRET}` };
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: adapterFor(VALID_IR),
      executorAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "executor", attempt: 0 }, result: (req) => completed(JSON.stringify({ ...evidenceWithSecret, contract_id: req.taskCard?.executionId }), "x") }]),
      reviewerAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson(), "x") }]),
      hooks: HARNESS_HOOKS,
      maxRepairAttempts: 0, timeoutMs: 1000,
      persistence: EPHEMERAL,
    });
    // C4Q: the executor final message is NON-AUTHORITATIVE — a secret in it
    // never enters the harness-owned evidence; in ephemeral mode nothing is
    // persisted and the run proceeds. The result contract（no secret echo）
    // still holds.
    assert.equal(r.final, "PASS");
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(SECRET), "secret must never appear in the result");
    assert.ok(!serialized.includes("process.env"), "no environment exposure");
    assert.ok(!serialized.includes("Authorization"), "no auth header exposure");
    // raw model reasoning must not be present
    assert.ok(!serialized.includes("thinking"), "no raw reasoning in result");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E11: missing decomposition adapter → HOLD MISSING_DECOMPOSITION_ADAPTER", async () => {
  const cwd = gitFixture();
  try {
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: null,
      executorAdapterFactory: () => createScriptedAdapter([]),
      reviewerAdapterFactory: () => createScriptedAdapter([]),
      hooks: HARNESS_HOOKS,
      maxRepairAttempts: 0, timeoutMs: 1000,
      persistence: EPHEMERAL,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.reason, "MISSING_DECOMPOSITION_ADAPTER");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E12: missing persistence mode → HOLD PERSISTENCE_MODE_REQUIRED", async () => {
  const cwd = gitFixture();
  try {
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: adapterFor(VALID_IR),
      ...defaultFactories(), maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.reason, "PERSISTENCE_MODE_REQUIRED");
    assert.deepEqual(r.phaseResults, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("E13: invalid persistence mode → HOLD INVALID_PERSISTENCE_MODE", async () => {
  const cwd = gitFixture();
  try {
    const r = await runAutoLoop({
      source: sourceFor(), parent: VALID_PARENT, manifest: VALID_MANIFEST, cwd,
      decompositionAdapter: adapterFor(VALID_IR),
      ...defaultFactories(), hooks: HARNESS_HOOKS,
      maxRepairAttempts: 0, timeoutMs: 1000,
      persistence: { mode: "mystery" },
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.reason, "INVALID_PERSISTENCE_MODE");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
