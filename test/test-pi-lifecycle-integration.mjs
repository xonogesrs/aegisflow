// test-pi-lifecycle-integration.mjs
//
// Lifecycle-level integration tests wiring the real lifecycle-runner.mjs
// against a Pi RPC adapter pointed at test/fixtures/fake-pi-rpc.mjs. No
// real Pi binary, no network, no provider is ever invoked in this file --
// only `node` running this repo's own fixture script.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runLifecycle } from "../src/lifecycle-runner.mjs";
import { createPiRpcAdapter, DEFAULT_ENV_ALLOWLIST } from "../src/adapter/pi-rpc-adapter.mjs";
import { captureScopeSnapshot } from "../src/c2d/mutation-scope.mjs";
import { buildPhaseTaskCard, deriveScopePatterns } from "../src/v2/phase-task-card.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "fixtures", "fake-pi-rpc.mjs");
const ALLOWLIST_WITH_CONTROL = [...DEFAULT_ENV_ALLOWLIST, "FAKE_PI_CONTROL"];
const EVIDENCE = JSON.parse(readFileSync(resolve(HERE, "fixtures", "implementation-evidence-valid.json"), "utf8"));

function evidenceJson(overrides = {}) {
  return JSON.stringify({ ...EVIDENCE, ...overrides });
}

function verdictJson({ verdict, confidence = "HIGH", model = "fake-pi", summary = "ok", recommended_next_action, ...rest }) {
  return JSON.stringify({ verdict, confidence, model, summary, recommended_next_action, ...rest });
}

async function withFakeControl(control, fn) {
  process.env.FAKE_PI_CONTROL = JSON.stringify(control);
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_PI_CONTROL;
  }
}

function makePiAdapter(adapterOptions = {}) {
  return createPiRpcAdapter({
    piExecutable: FIXTURE,
    environmentAllowlist: ALLOWLIST_WITH_CONTROL,
    graceMs: 150,
    ...adapterOptions,
  });
}

// C4Q harness-owned evidence needs a real baseline + harness config.
function makeCard(cwd) {
  const card = buildPhaseTaskCard({
    phase: {
      phase_id: "p_impl", title: "Impl", summary: "writer", responsibility: "R1", purpose: "implementation",
      effects: {
        artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
        evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] },
      },
      covers: [{ requirement_id: "R1", completeness: "complete", claim: "c" }], depends_on: [],
    },
    parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
    executionId: "exec_11111111111111111111111111111111",
    cwd, maxRepairAttempts: 1, expectedReviewerModel: "fake-pi",
    toolPolicy: { mode: "no-tools" }, environmentAllowlist: ALLOWLIST_WITH_CONTROL,
  });
  card.verificationCommand = ["node", "-e", "process.exit(0)"];
  card.expectedExecutorModel = "fake-pi";
  card.expectedExecutorProvider = "deepseek";
  card.mutationScope = {
    repositoryRoot: cwd, baselineSnapshot: captureScopeSnapshot(cwd),
    allowedPaths: deriveScopePatterns(card.allowedPaths), forbiddenPaths: deriveScopePatterns(card.forbiddenPaths),
  };
  return card;
}

test("T20 lifecycle direct PASS: Pi RPC executor completes, reviewer returns PASS, lifecycle resolves PASS", async () => {
  await withFakeControl(
    {
      scenario: "normal",
      assistantTextByPhase: {
        executor: evidenceJson(),
        reviewer: verdictJson({ verdict: "PASS", recommended_next_action: "STOP" }),
      },
    },
    async () => {
      const cwd = gitFixture();
      try {
        const adapter = makePiAdapter();
        const card = makeCard(cwd);
        card.maxRepairAttempts = 0;
        const outcome = await runLifecycle({
          cwd, taskCard: card, adapter, maxRepairAttempts: 0, timeoutMs: 10000,
        });
        assert.equal(outcome.final, "PASS");
        assert.equal(outcome.attempt, 0);
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    },
  );
});

test("T21 lifecycle REPAIR -> PASS: reviewer requests REPAIR on attempt 0, PASS on attempt 1", async () => {
  await withFakeControl(
    {
      scenario: "normal",
      assistantTextByPhase: {
        executor: evidenceJson(),
        reviewer: [
          verdictJson({ verdict: "NEEDS_SUPPLEMENT", recommended_next_action: "REPAIR" }),
          verdictJson({ verdict: "PASS", recommended_next_action: "STOP" }),
        ],
      },
    },
    async () => {
      const cwd = gitFixture();
      try {
        const adapter = makePiAdapter();
        const card = makeCard(cwd);
        const outcome = await runLifecycle({
          cwd, taskCard: card, adapter, maxRepairAttempts: 1, timeoutMs: 10000,
        });
        assert.equal(outcome.final, "PASS");
        assert.equal(outcome.attempt, 1);
        const phases = outcome.transitions.filter((t) => t.phase === "executor" || t.phase === "reviewer").map((t) => [t.phase, t.attempt]);
        assert.deepEqual(phases, [["executor", 0], ["reviewer", 0], ["executor", 1], ["reviewer", 1]]);
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    },
  );
});

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-lifecycle-scope-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.txt"), "a\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("T22 mutation scope violation forces HOLD even when the Pi executor self-reports success", async () => {
  const repositoryRoot = gitFixture();
  try {
    const baselineSnapshot = captureScopeSnapshot(repositoryRoot);
    // Simulate an out-of-scope change made by whatever produced this
    // executor result; the fake Pi child itself never touches this repo.
    writeFileSync(join(repositoryRoot, "escaped.txt"), "not allowed\n");

    await withFakeControl(
      { scenario: "normal", assistantTextByPhase: { executor: evidenceJson() } },
      async () => {
        const adapter = makePiAdapter();
        const outcome = await runLifecycle({
          cwd: repositoryRoot,
          taskCard: {
            id: "card-22",
            mutationScope: { repositoryRoot, baselineSnapshot, allowedPaths: ["src/**"], forbiddenPaths: [] },
          },
          adapter,
          maxRepairAttempts: 1,
          timeoutMs: 10000,
        });
        assert.equal(outcome.final, "HOLD");
        assert.equal(outcome.reason, "MUTATION_SCOPE_VIOLATION");
      },
    );
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("T23 (lifecycle level) a nonexistent Pi executable surfaces as HOLD via the normal adapter-error path, no fallback", async () => {
  const adapter = createPiRpcAdapter({ piExecutable: "/nonexistent/pi/binary/does/not/exist" });
  const outcome = await runLifecycle({
    cwd: tmpdir(), taskCard: { id: "card-23" }, adapter, maxRepairAttempts: 0, timeoutMs: 5000,
  });
  assert.equal(outcome.final, "HOLD");
  assert.equal(outcome.reason, "EXECUTOR_ERROR");
});
