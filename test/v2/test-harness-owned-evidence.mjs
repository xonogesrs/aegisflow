// test/v2/test-harness-owned-evidence.mjs
//
// C4Q — harness-owned implementation evidence（offline only）.
//
// Proves the C4Q acceptance criteria:
//   1. prose executor final message → harness still produces valid evidence
//   2. fenced-JSON executor final message → NOT extracted as formal evidence
//   3. strict-JSON executor final message → NOT authoritative for identity/facts
//   4. contract_id always == phaseExecutionId（harness-bound）
//   5. changed paths come from the actual sandbox delta
//   6. test command / exit code come from system-observed process records
//   7. scope violation correctly HOLDS
//   8. test failure reflected in evidence and prevents improper PASS
//   9. stale / cross-phase identity rejected
//  10. evidence consistent with artifact SHA + journal references
//  11. C4N reviewer receives the full bundle and PASSes canonical success
//  12. synthetic secret / oversize / missing facts fail closed
//  13. executor output diagnostic bounded-saved; not polluting run-result
//  14. regressions（external full suite）
//
// Zero provider, zero Pi, zero credential.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runLifecycle } from "../../src/lifecycle-runner.mjs";
import { runExecutionOrchestrator } from "../../src/v2/execution-orchestrator.mjs";
import { buildPhaseTaskCard, deriveScopePatterns, phaseExecutionId } from "../../src/v2/phase-task-card.mjs";
import { captureScopeSnapshot } from "../../src/c2d/mutation-scope.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";
import { runDurableAutoLoopInternal } from "../../src/v2/stack-a-internal.mjs";
import { RunEvidenceStore, canonicalJson, sha256Text } from "../../src/evidence/run-evidence-store.mjs";
import {
  buildHarnessOwnedEvidence, buildExecutorOutputDiagnostic, collectGitBaseline,
  runVerificationCommand, HARNESS_EVIDENCE_ERRORS,
} from "../../src/v2/harness-evidence.mjs";
import { buildReviewEvidenceBundle } from "../../src/v2/review-evidence.mjs";
import { mintExecutionId } from "../../src/c2d/execution-id.mjs";

// ── helpers ──────────────────────────────────────────────────────────────

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "c4q-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src"));
  return dir;
}

const RUN_ID = mintExecutionId(); // valid exec_<32hex>

function writerCard({ cwd, runId = RUN_ID, phaseId = "p_impl" } = {}) {
  const phase = {
    phase_id: phaseId, title: "Impl", summary: "writer", responsibility: "R2 impl", purpose: "implementation",
    effects: {
      artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
      evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] },
    },
    covers: [{ requirement_id: "R2", completeness: "complete", claim: "covers R2" }],
    depends_on: [],
  };
  const card = buildPhaseTaskCard({
    phase, parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
    executionId: runId, cwd, maxRepairAttempts: 0, expectedReviewerModel: "test-model",
    toolPolicy: { mode: "no-tools" }, environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  });
  const baselineSnapshot = captureScopeSnapshot(cwd);
  card.mutationScope = {
    repositoryRoot: cwd, baselineSnapshot,
    allowedPaths: deriveScopePatterns(card.allowedPaths),
    forbiddenPaths: deriveScopePatterns(card.forbiddenPaths),
  };
  // C4Q harness configuration（from harness, never model text）.
  card.verificationCommand = ["node", "-e", "process.exit(0)"];
  card.expectedExecutorModel = "deepseek-v4-flash";
  card.expectedExecutorProvider = "deepseek";
  return card;
}

function completed(stdout, metadata = {}) {
  return { status: "completed", executionId: "x", stdout, stderr: "", signal: null, error: null, metadata: { exitCode: 0, toolCallCount: 7, eventCount: 120, terminalReason: "stop", ...metadata } };
}

function verdictJson(overrides = {}) {
  return JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP", ...overrides });
}

async function lifecycleRun({ card, executorResult, reviewerAdapter }) {
  const executorAdapter = createScriptedAdapter([{ expect: { phase: "executor", attempt: 0 }, result: executorResult }]);
  return runLifecycle({
    cwd: card.repositoryRoot, taskCard: card,
    executorAdapter, reviewerAdapter,
    maxRepairAttempts: 0, timeoutMs: 10_000, abortSignal: undefined,
    hooks: {},
  });
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── 1/2/3. Executor final message is never the evidence authority ─────────

for (const [label, output] of [
  ["prose", "All work is complete. Nothing structured here."],
  ["fenced-json", "```json\n{\"schema_version\":\"autoloop.implementation-evidence/v1\",\"contract_id\":\"fabricated\",\"actual_changed_paths\":[\"fake/other.mjs\"]}\n```"],
  ["strict-json-with-wrong-identity", "{\"schema_version\":\"autoloop.implementation-evidence/v1\",\"contract_id\":\"wrong-exec\",\"design_revision_id\":\"p_impl\",\"actual_changed_paths\":[\"fake/other.mjs\"]}"],
  ["empty", ""],
]) {
  test(`C4Q-${label === "prose" ? 1 : label === "fenced-json" ? 2 : label === "strict-json-with-wrong-identity" ? 3 : "1b"} executor final message ${label} → harness evidence is authoritative`, async () => {
    const cwd = gitFixture();
    try {
      const card = writerCard({ cwd });
      let captured = null;
      const reviewerAdapter = {
        runAdapter: async (request) => {
          captured = request.reviewEvidence;
          return completed(verdictJson());
        },
      };
      const outcome = await lifecycleRun({ card, executorResult: () => completed(output), reviewerAdapter });
      assert.equal(outcome.final, "PASS");
      assert.ok(captured, "reviewer must receive the C4N bundle");
      const ev = captured.executor_implementation_evidence.original;
      assert.equal(ev.contract_id, card.executionId, "contract_id must be harness-bound to phaseExecutionId");
      assert.equal(ev.schema_version, "autoloop.implementation-evidence/v1");
      assert.equal(captured.objective_facts.tool_execution_count, 7);
      // The fabricated changed paths in the model text must NOT leak in.
      assert.ok(!ev.actual_changed_paths.includes("fake/other.mjs"));
      assert.deepEqual(ev.actual_changed_paths, []);
      assert.equal(captured.objective_facts.test_executions[0].source, "system_observed");
    } finally { cleanup(cwd); }
  });
}

// ── 4/5/9. identity, changed paths, stale rejection ──────────────────────

test("C4Q-4 contract_id is always the phase execution id（mechanical binding）", () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    const evResult = buildHarnessOwnedEvidence({
      executionId: RUN_ID, taskCard: card, attempt: 0,
      scopeCheck: { ok: true, violations: [], delta: [] },
      baseline: collectGitBaseline(cwd),
      testRun: { ok: true, exit_code: 0, duration_ms: 10 },
      phaseStartedAt: "2026-08-03T16:00:00Z", phaseCompletedAt: "2026-08-03T16:00:01Z",
      executorResult: completed(""),
    });
    assert.equal(evResult.ok, true);
    assert.equal(evResult.evidence.contract_id, phaseExecutionId(RUN_ID, "p_impl"));
    assert.equal(evResult.evidence.contract_id, card.executionId);
  } finally { cleanup(cwd); }
});

test("C4Q-5 changed paths come from the actual sandbox delta", async () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd }); // baseline captured BEFORE the mutation
    writeFileSync(join(cwd, "src", "add.mjs"), "export function add(a,b){return a+b;}\n");
    let captured = null;
    const reviewerAdapter = { runAdapter: async (request) => { captured = request.reviewEvidence; return completed(verdictJson()); } };
    const outcome = await lifecycleRun({ card, executorResult: () => completed("prose"), reviewerAdapter });
    assert.equal(outcome.final, "PASS");
    const ev = captured.executor_implementation_evidence.original;
    assert.deepEqual(ev.actual_changed_paths, ["src/add.mjs"]);
    assert.deepEqual(ev.mutation_evidence, [{ path: "src/add.mjs", change_type: "added" }]);
    assert.equal(ev.executor_verdict, "PASS");
  } finally { cleanup(cwd); }
});

test("C4Q-9 stale / cross-phase identity is rejected", () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    // Card claims a phase execution id that does not match the run+phase.
    const stale = { ...card, executionId: phaseExecutionId(RUN_ID, "other_phase") };
    const r = buildHarnessOwnedEvidence({
      executionId: RUN_ID, taskCard: stale, attempt: 0,
      scopeCheck: { ok: true, violations: [], delta: [] },
      baseline: collectGitBaseline(cwd),
      testRun: { ok: true, exit_code: 0 },
      executorResult: completed(""),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, HARNESS_EVIDENCE_ERRORS.IDENTITY_MISMATCH);
  } finally { cleanup(cwd); }
});

// ── 6/8. system-observed test evidence ───────────────────────────────────

test("C4Q-6 test command / exit code come from a system-observed process", async () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    // Verification command observed by AutoLoop（exit 0）.
    const run = await runVerificationCommand({ command: ["node", "-e", "process.exit(0)"], cwd, environmentAllowlist: ["PATH", "HOME"] });
    assert.equal(run.ok, true);
    assert.equal(run.exit_code, 0);
    const card2 = writerCard({ cwd });
    let captured = null;
    const reviewerAdapter = { runAdapter: async (request) => { captured = request.reviewEvidence; return completed(verdictJson()); } };
    const outcome = await lifecycleRun({ card: card2, executorResult: () => completed("prose"), reviewerAdapter });
    assert.equal(outcome.final, "PASS");
    const of = captured.objective_facts;
    assert.equal(of.test_executions[0].source, "system_observed");
    assert.equal(of.test_executions[0].exit_code, 0);
    assert.equal(of.test_executions[0].command, "node -e process.exit(0)");
  } finally { cleanup(cwd); }
});

test("C4Q-8 test failure is reflected in evidence and prevents improper PASS", async () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    card.verificationCommand = ["node", "-e", "process.exit(1)"];
    let captured = null;
    // Canonical reviewer that checks the system-observed test outcome.
    const reviewerAdapter = createScriptedAdapter([{
      expect: { phase: "reviewer", attempt: 0 },
      result: (req) => {
        captured = req.reviewEvidence;
        const t = req.reviewEvidence.objective_facts.test_executions[0];
        if (t.exit_code !== 0) {
          return completed(JSON.stringify({
            verdict: "HOLD", confidence: "HIGH", model: "test-model",
            summary: "verification command failed", blocking_issues: [], required_supplements: [],
            scope_violations: [], evidence_gaps: ["verification failed"], recommended_next_action: "HUMAN_REVIEW",
          }));
        }
        return completed(verdictJson());
      },
    }]);
    const outcome = await lifecycleRun({ card, executorResult: () => completed("prose"), reviewerAdapter });
    assert.equal(outcome.final, "HOLD");
    assert.equal(outcome.reason, "REVIEWER_HOLD");
    const ev = captured.executor_implementation_evidence.original;
    assert.equal(ev.known_failures.length, 1);
    assert.equal(ev.known_failures[0].severity, "HIGH");
    assert.equal(ev.executor_verdict, "FAIL");
    assert.equal(captured.objective_facts.test_executions[0].exit_code, 1);
  } finally { cleanup(cwd); }
});

// ── 7. scope violation ──────────────────────────────────────────────────

test("C4Q-7 scope violation correctly HOLDS", async () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    // Mutation outside the allowlist（src/）.
    writeFileSync(join(cwd, "escaped.txt"), "out of scope\n");
    const reviewerAdapter = { runAdapter: async () => completed(verdictJson()) };
    const outcome = await lifecycleRun({ card, executorResult: () => completed("prose"), reviewerAdapter });
    assert.equal(outcome.final, "HOLD");
    assert.equal(outcome.reason, "MUTATION_SCOPE_VIOLATION");
  } finally { cleanup(cwd); }
});

// ── 10. artifact SHA / journal reference consistency ─────────────────────

test("C4Q-10 evidence artifact SHA and journal references are consistent", async () => {
  const cwd = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4q-store-"));
  try {
    const card = writerCard({ cwd });
    const evResult = buildHarnessOwnedEvidence({
      executionId: RUN_ID, taskCard: card, attempt: 0,
      scopeCheck: { ok: true, violations: [], delta: [] },
      baseline: collectGitBaseline(cwd),
      testRun: { ok: true, exit_code: 0, duration_ms: 12 },
      phaseStartedAt: "2026-08-03T16:00:00Z", phaseCompletedAt: "2026-08-03T16:00:01Z",
      executorResult: completed(""),
    });
    assert.equal(evResult.ok, true);
    const ev = evResult.evidence;
    const store = new RunEvidenceStore({ root, executionId: RUN_ID, chainId: "c4q", checkpointId: "ckpt", repoRoot: cwd });
    store.init();
    const written = store.writePhaseArtifact("p_impl", "implementation-evidence-0.json", ev);
    const bundle = buildReviewEvidenceBundle({ executionId: RUN_ID, taskCard: card, attempt: 0, evidence: ev, observedChangedPaths: [] });
    assert.equal(bundle.ok, true);
    assert.equal(bundle.bundle.durable_references.evidence_artifact_sha256, written.sha256);
    assert.equal(bundle.bundle.durable_references.evidence_artifact_path, "phases/p_impl/implementation-evidence-0.json");
    assert.equal(bundle.bundle.durable_references.executor_completed_event.evidence_hash, sha256Text(canonicalJson(ev)));
  } finally { cleanup(cwd); cleanup(root); }
});

// ── 11. reviewer gets the bundle and PASSes canonical success（orchestrator）─

test("C4Q-11 orchestrator: reviewer receives full bundle → PASS", async () => {
  const cwd = gitFixture();
  try {
    let captured = [];
    const result = await runExecutionOrchestrator({
      ir: {
        verdict: "DECOMPOSED", parent_goal: "g",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [{
          phase_id: "p_impl", title: "Impl", summary: "w", responsibility: "R2", purpose: "implementation",
          effects: {
            artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
            evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] },
          },
          covers: [{ requirement_id: "R2", completeness: "complete", claim: "c" }], depends_on: [],
        }],
        dispositions: [], decomposition_evidence: ["e"],
      },
      parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
      manifest: [{ requirement_id: "R2", text: "implement" }],
      cwd, executionId: RUN_ID,
      executorAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "executor", attempt: 0 }, result: completed("prose") }]),
      reviewerAdapterFactory: () => ({
        runAdapter: async (request) => { captured.push(request.reviewEvidence); return completed(verdictJson()); },
      }),
      maxRepairAttempts: 0, timeoutMs: 10_000,
      hooks: {
        toolPolicy: { mode: "no-tools" }, environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
        expectedReviewerModel: "test-model",
        verificationCommand: ["node", "-e", "process.exit(0)"],
        expectedExecutorModel: "deepseek-v4-flash", expectedExecutorProvider: "deepseek",
      },
    });
    assert.equal(result.final, "PASS");
    assert.equal(captured.length, 1);
    const bundle = captured[0];
    assert.ok(bundle, "reviewer must receive the C4N bundle");
    assert.equal(bundle.execution_identity.phase_execution_id, phaseExecutionId(RUN_ID, "p_impl"));
    assert.equal(bundle.executor_implementation_evidence.contract_id, phaseExecutionId(RUN_ID, "p_impl"));
    assert.equal(bundle.objective_facts.test_executions[0].source, "system_observed");
  } finally { cleanup(cwd); }
});

// ── 12. secret / oversize / missing facts fail closed ────────────────────

test("C4Q-12 synthetic secret, oversize, missing facts all fail closed", () => {
  const cwd = gitFixture();
  // Sentinel must match a REAL credential shape（SECRET_PATTERNS sk_key）:
  // the original free-form sentinel matched no pattern, so this fail-closed
  // proof never fired. Pattern-shaped sentinel keeps the no-echo asserts honest.
  const SYNTH = "sk-syntheticsentinelfixed123456";
  try {
    const card = writerCard({ cwd });
    // secret: the verification command carries a secret pattern → evidence scan catches it
    const cardSecret = writerCard({ cwd });
    cardSecret.verificationCommand = ["node", "-e", `console.log('${SYNTH}')`];
    const r1 = buildHarnessOwnedEvidence({
      executionId: RUN_ID, taskCard: cardSecret, attempt: 0,
      scopeCheck: { ok: true, violations: [], delta: [] }, baseline: collectGitBaseline(cwd),
      testRun: { ok: true, exit_code: 0, duration_ms: 5 }, executorResult: completed(""),
    });
    assert.equal(r1.ok, false);
    assert.equal(r1.code, HARNESS_EVIDENCE_ERRORS.SECRET_RISK);
    assert.ok(!JSON.stringify(r1).includes(SYNTH));
    // oversize
    const r2 = buildHarnessOwnedEvidence({
      executionId: RUN_ID, taskCard: card, attempt: 0,
      scopeCheck: { ok: true, violations: [], delta: [] }, baseline: collectGitBaseline(cwd),
      testRun: { ok: true, exit_code: 0 }, executorResult: completed(""),
      limits: { maxSerializedBytes: 64 },
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, HARNESS_EVIDENCE_ERRORS.OVERSIZE);
    // missing facts: non-git cwd → baseline null
    const r3 = buildHarnessOwnedEvidence({
      executionId: RUN_ID, taskCard: { ...card, repositoryRoot: "/nonexistent" }, attempt: 0,
      scopeCheck: { ok: true, violations: [], delta: [] }, baseline: null,
      testRun: { ok: true, exit_code: 0 }, executorResult: completed(""),
    });
    assert.equal(r3.ok, false);
    assert.equal(r3.code, HARNESS_EVIDENCE_ERRORS.MISSING_FACTS);
  } finally { cleanup(cwd); }
});

// ── 13. executor diagnostic bounded-saved; not in run-result ─────────────

test("C4Q-13 durable run: executor output diagnostic saved bounded; evidence harness-owned", async () => {
  const cwd = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4q-dur-"));
  const executionId = mintExecutionId();
  try {
    const LONG_TEXT = "prose line\n".repeat(5000); // ~55 KB
    const MANIFEST = [
      { requirement_id: "R1", text: "Correct src/add.mjs so add(a, b) returns the arithmetic sum." },
      { requirement_id: "R2", text: "Preserve the exported function name and module interface." },
      { requirement_id: "R3", text: "Modify no repository artifact except src/add.mjs." },
      { requirement_id: "R4", text: "Use a distinct read-only verification phase after implementation." },
      { requirement_id: "R5", text: "Verification must run npm test and must depend on implementation." },
      { requirement_id: "R6", text: "Do not commit, push, create remotes, install packages, or access files outside the isolated repository." },
      { requirement_id: "R7", text: "Return canonical bounded execution evidence for executor and reviewer." },
    ];
    const result = await runDurableAutoLoopInternal({
      source: {
        goal: "Repair the isolated fixture repository so add(a, b) performs arithmetic addition and the existing test suite passes.",
        requirements: MANIFEST,
        authority: { allowed_paths: ["src/add.mjs"], mutation_allowed: true, commit_allowed: false },
      },
      parent: { scope: { allowed_paths: ["src/add.mjs"], forbidden_paths: ["package.json", "test/add.test.mjs", ".git/**"] } },
      manifest: MANIFEST,
      cwd, decompositionAdapter: { generate: async () => ({ status: "completed", parsed: {
        verdict: "DECOMPOSED",
        parent_goal: "Repair the isolated fixture repository so add(a, b) performs arithmetic addition and the existing test suite passes.",
        execution_policy: { executor: "INHERIT_PARENT", multi_model_orchestration: false, reviewer: "EXTERNAL_GPT" },
        decomposition_evidence: [
          "Implementation phase changes only src/add.mjs and covers R1, R2, R3, and R6.",
          "Read-only verification phase after implementation runs npm test and covers R4, R5, and R7.",
        ],
        phases: [
          {
            phase_id: "fix_add_implementation", title: "Fix add implementation",
            summary: "Correct the implementation so the module behaves as specified.",
            responsibility: "Modify only src/add.mjs to correct the implementation.", purpose: "implementation",
            effects: {
              artifact_mutation: "required", boundaries: { artifact: ["src/add.mjs"], evidence: [], external_system: [], runtime: [] },
              evidence_output: "none", external_system_mutation: "forbidden", runtime_side_effect: "forbidden",
            },
            covers: [
              { claim: "Rewrites add(a,b) to return the arithmetic sum a + b.", completeness: "complete", requirement_id: "R1" },
              { claim: "Keeps the exported function named add and preserves the ES module interface.", completeness: "complete", requirement_id: "R2" },
              { claim: "The only repository artifact changed is src/add.mjs.", completeness: "complete", requirement_id: "R3" },
              { claim: "No commit/push/remote/package-install/outside access; only src/add.mjs is mutated.", completeness: "complete", requirement_id: "R6" },
            ],
            depends_on: [],
          },
          {
            phase_id: "verify_npm_test", title: "Verify with npm test",
            summary: "Run the project verification command and confirm the fix.",
            responsibility: "Execute npm test and verify the corrected add(a,b) passes.", purpose: "verification",
            effects: {
              artifact_mutation: "forbidden", boundaries: { artifact: [], evidence: ["executor_reviewer_evidence_bundle"], external_system: [], runtime: ["isolated_repository_test_execution"] },
              evidence_output: "ephemeral", external_system_mutation: "forbidden", runtime_side_effect: "allowed",
            },
            covers: [
              { claim: "Distinct read-only verification phase after implementation.", completeness: "complete", requirement_id: "R4" },
              { claim: "Runs npm test and depends on the implementation phase.", completeness: "complete", requirement_id: "R5" },
              { claim: "Returns canonical bounded execution evidence.", completeness: "complete", requirement_id: "R7" },
            ],
            depends_on: ["fix_add_implementation"],
            verification_plan: {
              subject_phase_ids: ["fix_add_implementation"],
              method: "Run npm test inside the isolated repository.",
              success_criteria: "All existing tests pass.",
              failure_criteria: "Any test failure.",
              evidence: "npm test transcript and src/add.mjs diff.",
            },
          },
        ],
        dispositions: [],
      }, requestCount: 1, elapsedMs: 1 }) },
      // Custom executor adapter that performs the tool work (mutates
      // src/add.mjs) during the phase, then returns a prose final message —
      // the mutation is observed by the harness scope delta, not by the text.
      executorAdapterFactory: () => ({
        runAdapter: async () => {
          writeFileSync(join(cwd, "src", "add.mjs"), "export function add(a,b){return a+b;}\n");
          return completed(LONG_TEXT);
        },
      }),
      reviewerAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson()) }]),
      maxRepairAttempts: 0, timeoutMs: 10_000,
      hooks: {
        environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
        expectedReviewerModel: "test-model",
        verificationCommand: ["node", "-e", "process.exit(0)"],
        expectedExecutorModel: "deepseek-v4-flash", expectedExecutorProvider: "deepseek",
      },
      persistence: { root, executionId, resume: false },
    });
    assert.equal(result.final, "PASS", `run HOLD: reason=${result.reason} phases=${JSON.stringify(result.phaseResults)}`);
    const execDir = join(root, executionId);
    const outputArtifact = join(execDir, "phases", "fix_add_implementation", "executor-output-0.json");
    assert.ok(existsSync(outputArtifact), "executor output diagnostic must be persisted");
    const diag = JSON.parse(readFileSync(outputArtifact, "utf8"));
    assert.equal(diag.kind, "executor_output_diagnostic");
    assert.equal(diag.authoritative, false);
    assert.equal(diag.final_assistant_text.truncated, true, "bounded diagnostic must truncate");
    assert.ok(diag.final_assistant_text.stored_length <= 2048);
    const evArtifact = join(execDir, "phases", "fix_add_implementation", "implementation-evidence-0.json");
    assert.ok(existsSync(evArtifact));
    const ev = JSON.parse(readFileSync(evArtifact, "utf8"));
    assert.equal(ev.contract_id, phaseExecutionId(executionId, "fix_add_implementation"));
    assert.deepEqual(ev.actual_changed_paths, ["src/add.mjs"]);
    assert.equal(ev.executor_verdict, "PASS");
    assert.ok(!JSON.stringify(result).includes("prose line"), "raw executor text must not pollute the run result");
  } finally { cleanup(cwd); cleanup(root); }
});


test("C4Q-diag buildExecutorOutputDiagnostic is bounded and non-authoritative", () => {
  const long = "x".repeat(100_000);
  const d = buildExecutorOutputDiagnostic(completed(long, { protocolEventTypeCounts: { message_end: 3 } }));
  assert.equal(d.authoritative, false);
  assert.equal(d.truncated ?? d.final_assistant_text.truncated, true);
  assert.ok(d.final_assistant_text.stored_length <= 2048);
  assert.equal(d.protocol.assistant_message_count, 3);
  assert.equal(d.parse_info.valid_json, false);
  const dj = buildExecutorOutputDiagnostic(completed('{"a":1}'));
  assert.equal(dj.parse_info.valid_json, true);
});
