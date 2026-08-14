// test/v2/test-system-delta.mjs
//
// C4S — reviewer-visible system-observed delta evidence（offline only）.
//
// Proves the C4S acceptance criteria:
//   C4S-1  content visibility — bundle carries the full textual diff
//   C4S-2  system ownership — changing the executor final message never
//          changes patch bytes
//   C4S-3  identity binding — stale / cross-phase / cross-run / erroneous
//          contract deltas are rejected（HARNESS_REVIEW_DELTA_IDENTITY_MISMATCH）
//   C4S-4  scope binding — the patch changed paths must reproduce the scope
//          gate's formal result exactly（extra / missing / different ⇒ HOLD）
//   C4S-5  SHA consistency — patch artifact / manifest / implementation
//          evidence / C4N bundle / journal / run result agree
//   C4S-6  reviewer usability — a scripted reviewer can verify implementation
//          change + tests added + verification plan completion from the bundle
//   C4S-7  oversize fail-closed — patch over the cap HOLDS before the reviewer
//   C4S-8  binary fail-closed — binary delta never yields a success bundle
//   C4S-9  secret fail-closed — credential patterns block the artifact
//   C4S-10 output independence — prose / fenced / strict / wrong-identity /
//          empty executor output never affect the system delta
//   C4S-11 durable failure — persistence failure is journaled and HOLDS
//
// Zero provider, zero Pi, zero credential, zero campaign.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runLifecycle } from "../../src/lifecycle-runner.mjs";
import { runAutoLoop } from "../../src/autoloop.mjs";
import { buildPhaseTaskCard, deriveScopePatterns, phaseExecutionId } from "../../src/v2/phase-task-card.mjs";
import { captureScopeSnapshot, enforceScopeGate } from "../../src/c2d/mutation-scope.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";
import { validateImplementationEvidence } from "../../src/validate-role-artifacts.mjs";
import { RunEvidenceStore, sha256Text } from "../../src/evidence/run-evidence-store.mjs";
import { buildReviewEvidenceBundle, REVIEW_EVIDENCE_ERRORS } from "../../src/v2/review-evidence.mjs";
import {
  buildSystemObservedDelta, SYSTEM_DELTA_ERRORS, SYSTEM_DELTA_FORMAT_VERSION, SYSTEM_DELTA_MAX_PATCH_BYTES,
} from "../../src/v2/system-delta.mjs";
import { mintExecutionId } from "../../src/c2d/execution-id.mjs";

const FIXTURE_EVIDENCE = JSON.parse(
  readFileSync(new URL("../fixtures/implementation-evidence-valid.json", import.meta.url), "utf8"),
);

// ── helpers ──────────────────────────────────────────────────────────────

function gitInit(dir) {
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
}

function commitAll(dir, message) {
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir, stdio: "ignore" });
}

const BUGGY_FIB = `export function fibonacci(n) {
  if (n === 0) return 0;
  if (n === 1) return 1;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
`;
const FIXED_FIB = `export function fibonacci(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("n must be a non-negative integer");
  }
  if (n === 0) return 0;
  if (n === 1) return 1;
  let a = 0;
  let b = 1;
  for (let i = 2; i <= n; i += 1) {
    const next = a + b;
    a = b;
    b = next;
  }
  return b;
}
`;
const BASE_TESTS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { fibonacci } from "../src/fibonacci.mjs";
test("fib(0) = 0", () => assert.equal(fibonacci(0), 0));
test("fib(1) = 1", () => assert.equal(fibonacci(1), 1));
test("fib(10) = 55", () => assert.equal(fibonacci(10), 55));
`;
const EXTENDED_TESTS = BASE_TESTS + `test("fib throws on negative input", () => assert.throws(() => fibonacci(-1), TypeError));
test("fib throws on non-integer input", () => assert.throws(() => fibonacci(1.5), TypeError));
`;

/**
 * C4R-equivalent fibonacci fixture: a committed BUGGY implementation + 3
 * passing base tests, so the executor's fix is a real, reviewable delta.
 */
function fibonacciFixture() {
  const dir = mkdtempSync(join(tmpdir(), "c4s-fib-"));
  gitInit(dir);
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "src", "fibonacci.mjs"), BUGGY_FIB);
  writeFileSync(join(dir, "test", "fibonacci.test.mjs"), BASE_TESTS);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fib", private: true, type: "module" }, null, 2) + "\n");
  commitAll(dir, "base");
  return dir;
}

/** The executor's implementation + test changes（identical across runs）. */
function applyFibonacciFix(dir) {
  writeFileSync(join(dir, "src", "fibonacci.mjs"), FIXED_FIB);
  writeFileSync(join(dir, "test", "fibonacci.test.mjs"), EXTENDED_TESTS);
}

/**
 * Build a phase task card whose mutation-scope baseline snapshot is captured
 * NOW — i.e. the fixture must still be in its PRE-change state. The real
 * change is applied afterwards（direct tests）or by the executor mid-run
 *（lifecycle tests）, and the scope gate then observes it.
 */
function writerCard({ cwd, runId = mintExecutionId(), phaseId = "p_impl", allowed = ["src/", "test/"] } = {}) {
  const phase = {
    phase_id: phaseId, title: "Impl", summary: "writer", responsibility: "R2 impl", purpose: "implementation",
    effects: {
      artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
      evidence_output: "persistent", boundaries: { artifact: allowed, runtime: [], external_system: [], evidence: [] },
    },
    covers: [{ requirement_id: "R2", completeness: "complete", claim: "covers R2" }],
    depends_on: [],
  };
  const card = buildPhaseTaskCard({
    phase, parent: { scope: { allowed_paths: allowed, forbidden_paths: [] } },
    executionId: runId, cwd, maxRepairAttempts: 0, expectedReviewerModel: "test-model",
    toolPolicy: { mode: "no-tools" }, environmentAllowlist: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
  });
  const baselineSnapshot = captureScopeSnapshot(cwd);
  card.mutationScope = {
    repositoryRoot: cwd, baselineSnapshot,
    allowedPaths: deriveScopePatterns(card.allowedPaths),
    forbiddenPaths: deriveScopePatterns(card.forbiddenPaths),
  };
  card.verificationCommand = ["node", "--test", "test/fibonacci.test.mjs"];
  card.expectedExecutorModel = "deepseek-v4-flash";
  card.expectedExecutorProvider = "deepseek";
  return card;
}

/** Formal scope-gate result for the card's baseline vs the CURRENT state. */
function gateAfterChange(card) {
  return enforceScopeGate(
    card.mutationScope.repositoryRoot,
    card.mutationScope.baselineSnapshot,
    captureScopeSnapshot(card.mutationScope.repositoryRoot),
    card.mutationScope.allowedPaths,
    card.mutationScope.forbiddenPaths,
  );
}

/** Build the system delta for a card whose fixture was changed AFTER the card. */
function deltaFor(card, opts = {}) {
  const check = gateAfterChange(card);
  assert.equal(check.ok, true, `scope gate must pass: ${JSON.stringify(check.violations)}`);
  return buildSystemObservedDelta({ executionId: card.parentExecutionId, taskCard: card, scopeCheck: check, limits: opts.limits ?? {} });
}

function evidenceFor(card, overrides = {}) {
  return { ...FIXTURE_EVIDENCE, contract_id: card.executionId, ...overrides };
}

function completed(stdout, metadata = {}) {
  return { status: "completed", executionId: "x", stdout, stderr: "", signal: null, error: null, metadata: { exitCode: 0, toolCallCount: 7, ...metadata } };
}

function verdictJson(overrides = {}) {
  return JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP", ...overrides });
}

async function lifecycleWith({ card, executorResult, reviewerAdapter, hooks = {} }) {
  const executorAdapter = createScriptedAdapter([{ expect: { phase: "executor", attempt: 0 }, result: executorResult }]);
  return runLifecycle({
    cwd: card.repositoryRoot,
    taskCard: card,
    executorAdapter,
    reviewerAdapter,
    executorEvidenceValidator: validateImplementationEvidence,
    maxRepairAttempts: 0,
    timeoutMs: 30_000,
    abortSignal: undefined,
    hooks,
  });
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function oneWriterIr() {
  return {
    verdict: "DECOMPOSED",
    parent_goal: "goal",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    decomposition_evidence: ["Implementation phase changes only src/fibonacci.mjs and test/fibonacci.test.mjs and covers R2."],
    phases: [{
      phase_id: "p_impl",
      title: "Fix fibonacci implementation",
      summary: "Correct the fibonacci implementation and add edge-case tests.",
      responsibility: "Modify only src/fibonacci.mjs and test/fibonacci.test.mjs.",
      purpose: "implementation",
      effects: {
        artifact_mutation: "required",
        runtime_side_effect: "forbidden",
        external_system_mutation: "forbidden",
        evidence_output: "none",
        boundaries: { artifact: ["src/", "test/"], runtime: [], external_system: [], evidence: [] },
      },
      covers: [
        { claim: "Fixes fibonacci edge cases and adds edge-case tests.", completeness: "complete", requirement_id: "R2" },
      ],
      depends_on: [],
    }],
    dispositions: [],
  };
}

function fakeDecomposition(ir) {
  return { generate: async () => ({ status: "completed", parsed: ir, requestCount: 1, elapsedMs: 1 }) };
}

function readJournalEvents(execDir) {
  const dir = join(execDir, "journal");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

const DURABLE_HOOKS = {
  environmentAllowlist: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
  executorAdapterPolicy: { writer_phase: { mode: "allowlist", tools: ["read", "bash", "edit", "write"] }, verification_phase: { mode: "allowlist", tools: ["read", "bash"] } },
  reviewerAdapterPolicy: { mode: "no-tools" },
  expectedReviewerModel: "test-model",
  verificationCommand: ["node", "--test", "test/fibonacci.test.mjs"],
  expectedExecutorModel: "deepseek-v4-flash",
  expectedExecutorProvider: "deepseek",
};

// ── C4S-1 — content visibility ───────────────────────────────────────────

test("C4S-1 bundle carries the full textual diff（implementation + tests）, not just paths", () => {
  const dir = fibonacciFixture();
  try {
    const card = writerCard({ cwd: dir }); // baseline = committed buggy state
    applyFibonacciFix(dir);                // real change AFTER the baseline
    const d = deltaFor(card);
    assert.equal(d.ok, true, d.reason);
    const delta = d.delta;
    assert.equal(delta.format_version, SYSTEM_DELTA_FORMAT_VERSION);
    assert.equal(delta.source, "system_observed");
    assert.equal(delta.authoritative, true);
    assert.equal(delta.producer, "harness");
    assert.ok(delta.patch.text.includes("diff --git a/src/fibonacci.mjs"), "impl diff present");
    assert.ok(delta.patch.text.includes("diff --git a/test/fibonacci.test.mjs"), "test diff present");
    assert.ok(delta.patch.text.includes("+    throw new TypeError"), "implementation change visible");
    assert.ok(delta.patch.text.includes("+test(\"fib throws on negative input\""), "added test visible");
    assert.ok(delta.patch.text.includes("-  return fibonacci(n - 1) + fibonacci(n - 2);"), "removed buggy line visible");
    assert.equal(delta.patch.truncated, false);
    assert.equal(delta.patch.generation_status, "ok");
    assert.equal(delta.patch.byte_count, Buffer.byteLength(delta.patch.text, "utf8"));
    assert.equal(delta.patch.sha256, sha256Text(delta.patch.text));
    const paths = delta.changed_paths.map((c) => c.path);
    assert.deepEqual(paths, ["src/fibonacci.mjs", "test/fibonacci.test.mjs"]);
    for (const c of delta.changed_paths) {
      assert.match(c.before_sha256, /^[0-9a-f]{64}$/);
      assert.match(c.after_sha256, /^[0-9a-f]{64}$/);
      assert.notEqual(c.before_sha256, c.after_sha256);
    }
    // Bundle embeds the delta（inline diff + durable references + SHA）.
    const ev = evidenceFor(card, { actual_changed_paths: paths });
    const b = buildReviewEvidenceBundle({
      executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: ev,
      observedChangedPaths: paths, systemDelta: delta,
    });
    assert.equal(b.ok, true, b.reason);
    assert.ok(b.bundle.system_delta, "bundle must carry system_delta");
    assert.equal(b.bundle.system_delta.patch.text, delta.patch.text);
    assert.equal(b.bundle.system_delta.patch.sha256, delta.patch.sha256);
    assert.equal(b.bundle.system_delta.durable_references.artifact_patch.sha256, delta.artifacts.patch.sha256);
    assert.equal(b.bundle.system_delta.durable_references.artifact_json.sha256, delta.artifacts.json.sha256);
    assert.ok(b.bundle.system_delta.patch.text.length > 0, "inline diff must not be empty");
  } finally { cleanup(dir); }
});

// ── C4S-2 / C4S-10 — system ownership + output independence ──────────────

const EXECUTOR_OUTPUT_FORMATS = [
  ["prose", "All work is complete. Implemented the fibonacci edge cases."],
  ["fenced-json", "```json\n{\"schema_version\":\"autoloop.implementation-evidence/v1\",\"contract_id\":\"fabricated\",\"actual_changed_paths\":[\"fake/other.mjs\"]}\n```"],
  ["strict-json", null], // filled per-run with the correct contract id
  ["wrong-identity-json", "{\"schema_version\":\"autoloop.implementation-evidence/v1\",\"contract_id\":\"exec_ffffffffffffffffffffffffffffffff\",\"actual_changed_paths\":[\"fake/other.mjs\"]}"],
  ["empty", ""],
];

test("C4S-2 + C4S-10 executor final message never changes the system delta bytes", async () => {
  const patchShas = [];
  const contractIds = [];
  for (let i = 0; i < EXECUTOR_OUTPUT_FORMATS.length; i += 1) {
    const [label, textOrNull] = EXECUTOR_OUTPUT_FORMATS[i];
    const dir = fibonacciFixture();
    try {
      const card = writerCard({ cwd: dir });
      let captured = null;
      const executorStdout = textOrNull === null
        ? JSON.stringify(evidenceFor(card))
        : textOrNull;
      const outcome = await lifecycleWith({
        card,
        executorResult: () => {
          // The scripted executor makes the real fixture changes（the harness
          // observes them via the scope gate / git）and returns a completely
          // different final message per run.
          applyFibonacciFix(dir);
          return completed(executorStdout, { toolCallCount: 1 + i });
        },
        reviewerAdapter: {
          runAdapter: async (request) => {
            captured = request.reviewEvidence;
            return completed(verdictJson(), "x");
          },
        },
      });
      assert.equal(outcome.final, "PASS", `${label}: ${outcome.reason}`);
      assert.ok(captured, `${label}: reviewer must receive the bundle`);
      assert.ok(captured.system_delta, `${label}: bundle must carry the delta`);
      patchShas.push(captured.system_delta.patch.sha256);
      // Identity is harness-bound（never from executor text）.
      contractIds.push(captured.system_delta.identity.contract_id);
      assert.equal(captured.system_delta.identity.contract_id, phaseExecutionId(card.parentExecutionId, "p_impl"));
      assert.equal(captured.system_delta.patch.truncated, false);
      assert.equal(captured.system_delta.source, "system_observed");
      assert.equal(captured.system_delta.authoritative, true);
      assert.equal(captured.system_delta.producer, "harness");
    } finally { cleanup(dir); }
  }
  assert.equal(new Set(patchShas).size, 1, "all five executor output formats must yield the SAME patch bytes");
  assert.equal(contractIds.length, EXECUTOR_OUTPUT_FORMATS.length);
});

// ── C4S-3 — identity binding ─────────────────────────────────────────────

test("C4S-3 stale / cross-phase / cross-run / erroneous contract delta is rejected", () => {
  const dir = fibonacciFixture();
  try {
    const card = writerCard({ cwd: dir });
    applyFibonacciFix(dir);
    const good = deltaFor(card);
    assert.equal(good.ok, true);
    const delta = good.delta;
    const paths = delta.changed_paths.map((c) => c.path);

    // Cross-phase：a delta bound to p_impl delivered for p_other.
    const otherCard = writerCard({ cwd: dir, phaseId: "p_other" });
    const ev = evidenceFor(otherCard, { actual_changed_paths: paths });
    const crossPhase = buildReviewEvidenceBundle({
      executionId: otherCard.parentExecutionId, taskCard: otherCard, attempt: 0,
      evidence: ev, observedChangedPaths: paths, systemDelta: delta,
    });
    assert.equal(crossPhase.ok, false);
    assert.equal(crossPhase.code, SYSTEM_DELTA_ERRORS.IDENTITY_MISMATCH);

    // Cross-run：a delta minted under a different parent run id.
    const otherRunCard = writerCard({ cwd: dir, runId: mintExecutionId() });
    const ev2 = evidenceFor(otherRunCard, { actual_changed_paths: paths });
    const crossRun = buildReviewEvidenceBundle({
      executionId: otherRunCard.parentExecutionId, taskCard: otherRunCard, attempt: 0,
      evidence: ev2, observedChangedPaths: paths, systemDelta: delta,
    });
    assert.equal(crossRun.ok, false);
    assert.equal(crossRun.code, SYSTEM_DELTA_ERRORS.IDENTITY_MISMATCH);

    // Erroneous contract task card：phase execution id does not derive from (run, phase).
    const tampered = writerCard({ cwd: dir });
    tampered.executionId = "exec_ffffffffffffffffffffffffffffffff";
    const bad = buildSystemObservedDelta({ executionId: tampered.parentExecutionId, taskCard: tampered, scopeCheck: { ok: true, violations: [], delta: [] } });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, SYSTEM_DELTA_ERRORS.IDENTITY_MISMATCH);

    // Stale phase execution id at the generator.
    const staleCard = writerCard({ cwd: dir });
    const stale = buildSystemObservedDelta({
      executionId: staleCard.parentExecutionId,
      taskCard: { ...staleCard, executionId: "exec_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      scopeCheck: { ok: true, violations: [], delta: [] },
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, SYSTEM_DELTA_ERRORS.IDENTITY_MISMATCH);
  } finally { cleanup(dir); }
});

// ── C4S-4 — scope binding ────────────────────────────────────────────────

test("C4S-4 patch changed paths must reproduce the scope gate result exactly", () => {
  const dir = fibonacciFixture();
  try {
    const card = writerCard({ cwd: dir });
    applyFibonacciFix(dir);
    const real = gateAfterChange(card);
    assert.equal(real.ok, true);

    // Extra path in the formal delta（a file that did not change）⇒ HOLD.
    const extra = { ...real, delta: [...real.delta, { path: "src/never-touched.mjs", change: "added" }] };
    const r1 = buildSystemObservedDelta({ executionId: card.parentExecutionId, taskCard: card, scopeCheck: extra });
    assert.equal(r1.ok, false);
    assert.equal(r1.code, SYSTEM_DELTA_ERRORS.SCOPE_MISMATCH);

    // Missing path（a real change removed from the formal delta）⇒ HOLD.
    const missing = { ...real, delta: real.delta.filter((d) => d.path !== "test/fibonacci.test.mjs") };
    const r2 = buildSystemObservedDelta({ executionId: card.parentExecutionId, taskCard: card, scopeCheck: missing });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, SYSTEM_DELTA_ERRORS.SCOPE_MISMATCH);

    // Different file（formal delta names a file the sandbox did not change）⇒ HOLD.
    const different = {
      ...real,
      delta: real.delta.map((d) => (d.path === "src/fibonacci.mjs" ? { ...d, path: "src/other.mjs" } : d)),
    };
    const r3 = buildSystemObservedDelta({ executionId: card.parentExecutionId, taskCard: card, scopeCheck: different });
    assert.equal(r3.ok, false);
    assert.equal(r3.code, SYSTEM_DELTA_ERRORS.SCOPE_MISMATCH);

    // Exact reproduction ⇒ PASS.
    const ok = buildSystemObservedDelta({ executionId: card.parentExecutionId, taskCard: card, scopeCheck: real });
    assert.equal(ok.ok, true);
  } finally { cleanup(dir); }
});

// ── C4S-5 — SHA consistency through the durable run ──────────────────────

test("C4S-5 patch SHA is consistent across artifact / manifest / evidence / bundle / journal", async () => {
  const repo = fibonacciFixture();
  const root = mkdtempSync(join(tmpdir(), "c4s-evidence-"));
  const executionId = mintExecutionId();
  const captured = [];
  try {
    const result = await runAutoLoop({
      source: { goal: "g", requirements: [{ requirement_id: "R2", text: "fix fibonacci" }], authority: { allowed_paths: ["src/", "test/"], mutation_allowed: true, commit_allowed: false } },
      parent: { scope: { allowed_paths: ["src/", "test/"], forbidden_paths: [] } },
      manifest: [{ requirement_id: "R2", text: "fix fibonacci" }],
      cwd: repo,
      decompositionAdapter: fakeDecomposition(oneWriterIr()),
      executorAdapterFactory: () => createScriptedAdapter([{
        expect: { phase: "executor", attempt: 0 },
        result: (req) => {
          applyFibonacciFix(repo);
          return completed(JSON.stringify(evidenceFor(req.taskCard)));
        },
      }]),
      reviewerAdapterFactory: () => createScriptedAdapter([{
        expect: { phase: "reviewer", attempt: 0 },
        result: (req) => { captured.push(req.reviewEvidence); return completed(verdictJson(), "x"); },
      }]),
      maxRepairAttempts: 0,
      timeoutMs: 60_000,
      hooks: DURABLE_HOOKS,
      persistence: { mode: "durable", root, executionId },
    });

    assert.equal(result.final, "PASS", result.reason);
    assert.equal(captured.length, 1);
    const bundle = captured[0];
    assert.ok(bundle.system_delta, "reviewer request must carry the system delta");
    const patchSha = bundle.system_delta.patch.sha256;
    const jsonArtifactSha = bundle.system_delta.durable_references.artifact_json.sha256;
    const patchArtifactSha = bundle.system_delta.durable_references.artifact_patch.sha256;
    assert.equal(patchSha, patchArtifactSha, "inline patch sha == durable patch artifact sha");

    const execDir = join(root, executionId);
    const phaseId = "p_impl";

    // 1. durable raw patch artifact bytes hash to the same SHA.
    const patchPath = join(execDir, "phases", phaseId, "reviewer-system-delta-0.patch");
    assert.ok(existsSync(patchPath), "patch artifact persisted");
    const rawBytes = readFileSync(patchPath);
    assert.equal(sha256Text(rawBytes.toString("utf8")), patchSha);
    assert.equal(rawBytes.toString("utf8"), bundle.system_delta.patch.text, "durable patch == inline patch");

    // 2. durable json artifact（metadata projection）hashes to its reference.
    const jsonPath = join(execDir, "phases", phaseId, "reviewer-system-delta-0.json");
    assert.ok(existsSync(jsonPath), "json artifact persisted");
    assert.equal(sha256Text(readFileSync(jsonPath, "utf8")), jsonArtifactSha);

    // 3. implementation evidence binds patch_sha256 to the same patch.
    const implEvidence = JSON.parse(readFileSync(join(execDir, "phases", phaseId, "implementation-evidence-0.json"), "utf8"));
    assert.equal(implEvidence.patch_sha256, patchSha);

    // 4. journal SYSTEM_DELTA_READY carries the same SHA.
    const events = readJournalEvents(execDir);
    const deltaEvent = events.find((e) => e.event_type === "SYSTEM_DELTA_READY");
    assert.ok(deltaEvent, "SYSTEM_DELTA_READY journaled");
    assert.equal(deltaEvent.payload.patch_sha256, patchSha);
    assert.equal(deltaEvent.payload.patch_artifact_sha256, patchSha);

    // 5. manifest artifact inventory lists both artifacts with matching SHAs.
    const manifest = JSON.parse(readFileSync(join(execDir, "manifest.json"), "utf8"));
    const inv = manifest.artifact_inventory || [];
    const patchInv = inv.find((a) => a.path === `phases/${phaseId}/reviewer-system-delta-0.patch`);
    const jsonInv = inv.find((a) => a.path === `phases/${phaseId}/reviewer-system-delta-0.json`);
    assert.ok(patchInv, "manifest lists the patch artifact");
    assert.ok(jsonInv, "manifest lists the json artifact");
    assert.equal(patchInv.sha256, patchSha);
    assert.equal(jsonInv.sha256, jsonArtifactSha);

    // 6. run result（phase result + captured reviewer bundle）agree.
    const phaseResult = result.phaseResults.find((p) => p.phaseId === phaseId);
    assert.equal(phaseResult?.status, "passed");
    assert.equal(bundle.system_delta.patch.sha256, patchSha);
  } finally {
    cleanup(repo);
    cleanup(root);
  }
});

// ── C4S-6 — reviewer usability（fibonacci fixture, scripted reviewer）────

test("C4S-6 reviewer can verify implementation change, tests added, and verification completion from the bundle", async () => {
  const dir = fibonacciFixture();
  try {
    const card = writerCard({ cwd: dir });
    let reviewSucceeded = false;
    const outcome = await lifecycleWith({
      card,
      executorResult: () => { applyFibonacciFix(dir); return completed("prose summary only"); },
      reviewerAdapter: {
        runAdapter: async (request) => {
          const bundle = request.reviewEvidence;
          assert.ok(bundle, "reviewer must receive the bundle");
          const patch = bundle.system_delta?.patch?.text ?? "";
          // The reviewer reads the CONTENT, not just paths:
          assert.ok(patch.includes("+    throw new TypeError"), "implementation change visible to reviewer");
          assert.ok(patch.includes("+test(\"fib throws on negative input\""), "added test visible to reviewer");
          assert.ok(patch.includes("+test(\"fib throws on non-integer input\""), "second added test visible");
          // Verification plan completion is checked from system-observed test records.
          const tr = bundle.objective_facts?.test_executions ?? [];
          assert.ok(tr.length > 0, "system-observed test execution recorded");
          assert.equal(tr[0].exit_code, 0);
          assert.equal(tr[0].source, "system_observed");
          // Scope discipline is checkable too.
          assert.deepEqual(bundle.objective_facts.actual_changed_paths, ["src/fibonacci.mjs", "test/fibonacci.test.mjs"]);
          reviewSucceeded = true;
          return completed(verdictJson(), "x");
        },
      },
    });
    assert.equal(outcome.final, "PASS");
    assert.equal(reviewSucceeded, true, "reviewer must have performed the content-level check");
  } finally { cleanup(dir); }
});

// ── C4S-7 — oversize fail-closed ─────────────────────────────────────────

test("C4S-7 patch over the bound HOLDS before the reviewer is invoked（no truncation）", async () => {
  // Unit level：explicit bound.
  const dir = fibonacciFixture();
  try {
    const card = writerCard({ cwd: dir });
    applyFibonacciFix(dir);
    const small = deltaFor(card, { limits: { maxPatchBytes: 512 } });
    assert.equal(small.ok, false);
    assert.equal(small.code, SYSTEM_DELTA_ERRORS.TOO_LARGE);
  } finally { cleanup(dir); }

  // Lifecycle level：a genuinely large patch（> default 64 KiB cap）.
  const dir2 = fibonacciFixture();
  try {
    const card = writerCard({ cwd: dir2 });
    let reviewerCalls = 0;
    const outcome = await lifecycleWith({
      card,
      executorResult: () => {
        writeFileSync(join(dir2, "src", "big.mjs"), `// ${"x".repeat(70 * 1024)}\n`);
        return completed("prose");
      },
      reviewerAdapter: {
        runAdapter: async () => { reviewerCalls += 1; return completed(verdictJson(), "x"); },
      },
    });
    assert.equal(outcome.final, "HOLD");
    assert.equal(outcome.reason, SYSTEM_DELTA_ERRORS.TOO_LARGE);
    assert.equal(reviewerCalls, 0, "reviewer must never be invoked on oversize");
  } finally { cleanup(dir2); }
});

// ── C4S-8 — binary fail-closed ───────────────────────────────────────────

test("C4S-8 binary delta fails closed；no partial success bundle", async () => {
  const dir = fibonacciFixture();
  try {
    const card = writerCard({ cwd: dir });
    applyFibonacciFix(dir);
    writeFileSync(join(dir, "src", "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
    const check = gateAfterChange(card);
    assert.equal(check.ok, true);
    const d = buildSystemObservedDelta({ executionId: card.parentExecutionId, taskCard: card, scopeCheck: check });
    assert.equal(d.ok, false);
    assert.equal(d.code, SYSTEM_DELTA_ERRORS.UNSUPPORTED_BINARY);

    // Lifecycle：HOLD before reviewer.
    let reviewerCalls = 0;
    const outcome = await lifecycleWith({
      card: writerCard({ cwd: dir }),
      executorResult: () => {
        applyFibonacciFix(dir);
        writeFileSync(join(dir, "src", "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
        return completed("prose");
      },
      reviewerAdapter: { runAdapter: async () => { reviewerCalls += 1; return completed(verdictJson(), "x"); } },
    });
    assert.equal(outcome.final, "HOLD");
    assert.equal(outcome.reason, SYSTEM_DELTA_ERRORS.UNSUPPORTED_BINARY);
    assert.equal(reviewerCalls, 0);
  } finally { cleanup(dir); }
});

// ── C4S-9 — secret fail-closed ───────────────────────────────────────────

test("C4S-9 credential pattern blocks the delta；no durable artifact；no echo", async () => {
  const SYNTH = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const dir = fibonacciFixture();
  try {
    const card = writerCard({ cwd: dir });
    applyFibonacciFix(dir);
    writeFileSync(join(dir, "src", "creds.txt"), `token=${SYNTH}\n`);
    const check = gateAfterChange(card);
    assert.equal(check.ok, true);
    const d = buildSystemObservedDelta({ executionId: card.parentExecutionId, taskCard: card, scopeCheck: check });
    assert.equal(d.ok, false);
    assert.equal(d.code, SYSTEM_DELTA_ERRORS.SECRET_DETECTED);
    assert.ok(!JSON.stringify(d).includes(SYNTH), "matched secret content must never be echoed");
    assert.ok(!d.reason.includes(SYNTH));

    // Store refuses to persist a secret raw artifact（code-based matcher）.
    const root = mkdtempSync(join(tmpdir(), "c4s-secret-"));
    try {
      const store = new RunEvidenceStore({ root, executionId: mintExecutionId(), chainId: "c", checkpointId: "c", repoRoot: dir });
      store.init();
      assert.throws(
        () => store.writePhaseRawArtifact("p_impl", "reviewer-system-delta-0.patch", `diff\n+token=${SYNTH}\n`),
        (e) => e?.code === "DURABLE_EVIDENCE_SECRET_RISK",
      );
    } finally { cleanup(root); }

    // Lifecycle：HOLD before reviewer（fresh fixture — the unit part above
    // already dirtied `dir` with the fixed files + credential）.
    let reviewerCalls = 0;
    const dir2 = fibonacciFixture();
    try {
      const outcome = await lifecycleWith({
        card: writerCard({ cwd: dir2 }),
        executorResult: () => {
          applyFibonacciFix(dir2);
          writeFileSync(join(dir2, "src", "creds.txt"), `token=${SYNTH}\n`);
          return completed("prose");
        },
        reviewerAdapter: { runAdapter: async () => { reviewerCalls += 1; return completed(verdictJson(), "x"); } },
      });
      assert.equal(outcome.final, "HOLD");
      assert.equal(outcome.reason, SYSTEM_DELTA_ERRORS.SECRET_DETECTED);
      assert.equal(reviewerCalls, 0);
    } finally { cleanup(dir2); }
  } finally { cleanup(dir); }
});

// ── C4S-11 — durable failure ─────────────────────────────────────────────

test("C4S-11 patch/metadata persistence failure is journaled and HOLDS", async () => {
  // Lifecycle：the persistence hook throws ⇒ HOLD before reviewer.
  const dir = fibonacciFixture();
  try {
    const card = writerCard({ cwd: dir });
    applyFibonacciFix(dir);
    let reviewerCalls = 0;
    const outcome = await lifecycleWith({
      card,
      executorResult: () => completed("prose"),
      reviewerAdapter: { runAdapter: async () => { reviewerCalls += 1; return completed(verdictJson(), "x"); } },
      hooks: {
        onSystemDeltaReady: async () => { throw new Error("disk full"); },
      },
    });
    assert.equal(outcome.final, "HOLD");
    assert.equal(outcome.reason, SYSTEM_DELTA_ERRORS.PERSISTENCE_FAILED);
    assert.equal(reviewerCalls, 0, "reviewer must never be invoked after persistence failure");
  } finally { cleanup(dir); }

  // Store：control characters in the raw patch are refused（code-based matcher）.
  const root = mkdtempSync(join(tmpdir(), "c4s-ctrl-"));
  try {
    const dir2 = fibonacciFixture();
    const store = new RunEvidenceStore({ root, executionId: mintExecutionId(), chainId: "c", checkpointId: "c", repoRoot: dir2 });
    store.init();
    assert.throws(
      () => store.writePhaseRawArtifact("p_impl", "reviewer-system-delta-0.patch", "diff --git a/x b/x\n+\u0007bell\n"),
      (e) => e?.code === "DURABLE_EVIDENCE_SECRET_RISK",
    );
    cleanup(dir2);
  } finally { cleanup(root); }

  // Durable run：control-char content passes the delta gates but the durable
  // write fails ⇒ journaled SYSTEM_DELTA_PERSISTENCE_FAILED + HOLD.
  const repo = fibonacciFixture();
  const root2 = mkdtempSync(join(tmpdir(), "c4s-durable-ctrl-"));
  const executionId = mintExecutionId();
  try {
    const result = await runAutoLoop({
      source: { goal: "g", requirements: [{ requirement_id: "R2", text: "x" }], authority: { allowed_paths: ["src/", "test/"], mutation_allowed: true, commit_allowed: false } },
      parent: { scope: { allowed_paths: ["src/", "test/"], forbidden_paths: [] } },
      manifest: [{ requirement_id: "R2", text: "x" }],
      cwd: repo,
      decompositionAdapter: fakeDecomposition(oneWriterIr()),
      executorAdapterFactory: () => createScriptedAdapter([{
        expect: { phase: "executor", attempt: 0 },
        result: (req) => {
          writeFileSync(join(repo, "src", "ctrl.txt"), "line one\n\u0007line two\n");
          return completed(JSON.stringify(evidenceFor(req.taskCard)));
        },
      }]),
      reviewerAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: () => completed(verdictJson(), "x") }]),
      maxRepairAttempts: 0,
      timeoutMs: 60_000,
      hooks: { ...DURABLE_HOOKS, verificationCommand: ["node", "-e", "process.exit(0)"] },
      persistence: { mode: "durable", root: root2, executionId },
    });
    assert.equal(result.final, "HOLD");
    const phaseResult = result.phaseResults.find((p) => p.phaseId === "p_impl");
    assert.equal(phaseResult?.reason, SYSTEM_DELTA_ERRORS.PERSISTENCE_FAILED);
    const events = readJournalEvents(join(root2, executionId));
    assert.ok(events.some((e) => e.event_type === "SYSTEM_DELTA_PERSISTENCE_FAILED"), "persistence failure must be journaled");
    assert.ok(!events.some((e) => e.event_type === "SYSTEM_DELTA_READY"), "no SYSTEM_DELTA_READY on failure");
  } finally {
    cleanup(repo);
    cleanup(root2);
  }
});

// ── Bundle fail-closed gates for a malformed/stale delta ────────────────

test("C4S-bundle gates: tampered patch SHA / truncated delta rejected before review", () => {
  const dir = fibonacciFixture();
  try {
    const card = writerCard({ cwd: dir });
    applyFibonacciFix(dir);
    const d = deltaFor(card);
    assert.equal(d.ok, true);
    const delta = d.delta;
    const paths = delta.changed_paths.map((c) => c.path);
    const ev = evidenceFor(card, { actual_changed_paths: paths });

    // Tampered patch SHA（declared ≠ actual bytes）.
    const tamperedSha = { ...delta, patch: { ...delta.patch, sha256: "0".repeat(64) } };
    const r1 = buildReviewEvidenceBundle({ executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: ev, observedChangedPaths: paths, systemDelta: tamperedSha });
    assert.equal(r1.ok, false);
    assert.equal(r1.code, SYSTEM_DELTA_ERRORS.SHA_MISMATCH);

    // Tampered byte_count.
    const tamperedCount = { ...delta, patch: { ...delta.patch, byte_count: delta.patch.byte_count + 1 } };
    const r2 = buildReviewEvidenceBundle({ executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: ev, observedChangedPaths: paths, systemDelta: tamperedCount });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, SYSTEM_DELTA_ERRORS.SHA_MISMATCH);

    // Truncated delta（never produced by the generator; rejected defensively）.
    const truncated = { ...delta, patch: { ...delta.patch, truncated: true } };
    const r3 = buildReviewEvidenceBundle({ executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: ev, observedChangedPaths: paths, systemDelta: truncated });
    assert.equal(r3.ok, false);
    assert.equal(r3.code, SYSTEM_DELTA_ERRORS.TOO_LARGE);

    // Oversized serialized bundle still fails closed（existing bound intact）.
    const r4 = buildReviewEvidenceBundle({ executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: ev, observedChangedPaths: paths, systemDelta: delta, limits: { maxSerializedBytes: 512 } });
    assert.equal(r4.ok, false);
    assert.equal(r4.code, REVIEW_EVIDENCE_ERRORS.OVERSIZE);
  } finally { cleanup(dir); }
});

// ── Constants sanity ─────────────────────────────────────────────────────

test("C4S constants：explicit bound, stable error codes, format version", () => {
  assert.ok(Number.isInteger(SYSTEM_DELTA_MAX_PATCH_BYTES) && SYSTEM_DELTA_MAX_PATCH_BYTES > 0);
  assert.equal(SYSTEM_DELTA_ERRORS.IDENTITY_MISMATCH, "HARNESS_REVIEW_DELTA_IDENTITY_MISMATCH");
  assert.equal(SYSTEM_DELTA_ERRORS.TOO_LARGE, "REVIEWER_SYSTEM_DELTA_TOO_LARGE");
  assert.equal(SYSTEM_DELTA_ERRORS.SCOPE_MISMATCH, "C4S_REVIEW_DELTA_SCOPE_MISMATCH");
  assert.equal(SYSTEM_DELTA_ERRORS.SHA_MISMATCH, "C4S_REVIEW_DELTA_SHA_MISMATCH");
  assert.equal(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, "C4S_SYSTEM_DELTA_GENERATION_FAILED");
  assert.equal(SYSTEM_DELTA_ERRORS.UNSUPPORTED_BINARY, "C4S_REVIEW_DELTA_UNSUPPORTED_BINARY");
  assert.equal(SYSTEM_DELTA_ERRORS.SECRET_DETECTED, "C4S_REVIEW_DELTA_SECRET_DETECTED");
  assert.equal(SYSTEM_DELTA_ERRORS.PERSISTENCE_FAILED, "C4S_REVIEW_DELTA_PERSISTENCE_FAILED");
});
