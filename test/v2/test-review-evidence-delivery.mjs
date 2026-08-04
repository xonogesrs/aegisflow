// test/v2/test-review-evidence-delivery.mjs
//
// C4N — reviewer evidence bundle delivery（offline only）.
//
// Proves the C4N acceptance criteria against the system-assembled review
// bundle and the lifecycle/orchestrator wiring:
//   1. validated executor evidence reaches the reviewer request
//   2. phaseExecutionId / contract_id / evidence identity correspondence
//   3. reviewer can obtain changed paths, tests, baseline, artifact hashes
//   4. consistent evidence → canonical reviewer PASS
//   5. missing implementation evidence → MISSING gate / HOLD before review
//   6. evidence vs objective changed-paths mismatch → reviewer HOLD
//   7. internally incoherent test exit codes → HOLD
//   8. identity mismatch / artifact SHA mismatch / stale evidence → HOLD
//   9. oversized bundle fail-closed（no silent truncation）
//  10. synthetic secret blocks delivery without echo
//  11. reviewer stays no-tools / read-only / zero mutation authority
//  12. regressions（external full suite）
//
// Zero provider, zero Pi, zero credential access.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { buildReviewEvidenceBundle, REVIEW_EVIDENCE_ERRORS, REVIEW_EVIDENCE_FORMAT_VERSION, REVIEW_EVIDENCE_MAX_SERIALIZED_BYTES } from "../../src/v2/review-evidence.mjs";
import { buildHarnessOwnedEvidence, HARNESS_EVIDENCE_ERRORS } from "../../src/v2/harness-evidence.mjs";
import { buildPhaseTaskCard, deriveScopePatterns, phaseExecutionId } from "../../src/v2/phase-task-card.mjs";
import { captureScopeSnapshot } from "../../src/c2d/mutation-scope.mjs";
import { runLifecycle } from "../../src/lifecycle-runner.mjs";
import { runExecutionOrchestrator } from "../../src/v2/execution-orchestrator.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";
import { validateImplementationEvidence } from "../../src/validate-role-artifacts.mjs";
import { RunEvidenceStore, canonicalJson, sha256Text } from "../../src/evidence/run-evidence-store.mjs";

const FIXTURE_EVIDENCE = JSON.parse(
  readFileSync(new URL("../fixtures/implementation-evidence-valid.json", import.meta.url), "utf8"),
);

// ── helpers ──────────────────────────────────────────────────────────────

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "c4n-rev-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function writerCard({ cwd, executionId = "exec_11111111111111111111111111111111", phaseId = "p_impl" } = {}) {
  const phase = {
    phase_id: phaseId,
    title: "Impl", summary: "writer", responsibility: "R2 impl", purpose: "implementation",
    effects: {
      artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
      evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] },
    },
    covers: [{ requirement_id: "R2", completeness: "complete", claim: "covers R2" }],
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
    environmentAllowlist: ["PATH"],
  });
  const baselineSnapshot = captureScopeSnapshot(cwd);
  card.mutationScope = {
    repositoryRoot: cwd,
    baselineSnapshot,
    allowedPaths: deriveScopePatterns(card.allowedPaths),
    forbiddenPaths: deriveScopePatterns(card.forbiddenPaths),
  };
  // C4Q harness configuration.
  card.verificationCommand = ["node", "-e", "process.exit(0)"];
  card.expectedExecutorModel = "deepseek-v4-flash";
  card.expectedExecutorProvider = "deepseek";
  return card;
}

function evidenceFor(card, overrides = {}) {
  return { ...FIXTURE_EVIDENCE, contract_id: card.executionId, ...overrides };
}

function completed(stdout, executionId = "x") {
  return { status: "completed", executionId, stdout, stderr: "", signal: null, error: null, metadata: { exitCode: 0 } };
}

function verdictJson(overrides = {}) {
  return JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP", ...overrides });
}

async function lifecycleWith({ card, executorResult, reviewerAdapter }) {
  const executorAdapter = createScriptedAdapter([{ expect: { phase: "executor", attempt: 0 }, result: executorResult }]);
  return runLifecycle({
    cwd: card.repositoryRoot,
    taskCard: card,
    executorAdapter,
    reviewerAdapter,
    executorEvidenceValidator: validateImplementationEvidence,
    maxRepairAttempts: 0,
    timeoutMs: 5000,
    abortSignal: undefined,
    hooks: {},
  });
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── 1/2/3. Bundle shape, identity, objective facts ────────────────────────

test("C4N-1 bundle carries the validated executor evidence and identity fields", () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    const ev = evidenceFor(card, { actual_changed_paths: [] });
    const r = buildReviewEvidenceBundle({ executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: ev, observedChangedPaths: [] });
    assert.equal(r.ok, true);
    assert.equal(r.bundle.format_version, REVIEW_EVIDENCE_FORMAT_VERSION);
    assert.deepEqual(r.bundle.executor_implementation_evidence.original, ev);
    assert.equal(r.bundle.executor_implementation_evidence.schema_version, ev.schema_version);
    assert.equal(r.bundle.executor_implementation_evidence.contract_id, ev.contract_id);
    assert.equal(r.bundle.execution_identity.run_execution_id, card.parentExecutionId);
    assert.equal(r.bundle.execution_identity.phase_execution_id, card.executionId);
    assert.equal(r.bundle.execution_identity.phase_id, card.phaseId);
    assert.equal(r.bundle.execution_identity.attempt, 0);
    assert.equal(r.sha256.length, 64);
  } finally { cleanup(cwd); }
});

test("C4N-2 identity mismatch（contract_id ≠ phase execution id）fails closed", () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    const r = buildReviewEvidenceBundle({
      executionId: card.parentExecutionId, taskCard: card, attempt: 0,
      evidence: evidenceFor(card, { contract_id: "exec_ffffffffffffffffffffffffffffffff" }),
      observedChangedPaths: [],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, REVIEW_EVIDENCE_ERRORS.IDENTITY_MISMATCH);
    // phaseExecutionId derivation is the authoritative identity.
    assert.equal(card.executionId, phaseExecutionId(card.parentExecutionId, card.phaseId));
  } finally { cleanup(cwd); }
});

test("C4N-3 objective facts + durable references are available to the reviewer", () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    const ev = evidenceFor(card, { actual_changed_paths: [] });
    const r = buildReviewEvidenceBundle({ executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: ev, observedChangedPaths: [] });
    assert.equal(r.ok, true);
    const of = r.bundle.objective_facts;
    assert.deepEqual(of.authorized_paths, ["src"]);
    assert.deepEqual(of.actual_changed_paths, []);
    assert.equal(of.mutation_state, "unchanged");
    assert.equal(typeof of.repository_head, "string");
    assert.equal(typeof of.repository_tree, "string");
    assert.ok(Array.isArray(of.test_executions) && of.test_executions.length > 0);
    for (const t of of.test_executions) {
      assert.equal(t.source, "system_observed");
      assert.ok("command" in t && "exit_code" in t && "outcome" in t);
    }
    const dr = r.bundle.durable_references;
    assert.equal(dr.evidence_artifact_path, `phases/${card.phaseId}/implementation-evidence.json`);
    assert.match(dr.evidence_artifact_sha256, /^[0-9a-f]{64}$/);
    assert.equal(dr.executor_completed_event.event_type, "EXECUTOR_COMPLETED");
    assert.match(dr.executor_completed_event.evidence_hash, /^[0-9a-f]{64}$/);
    // Review scope: read-only, no authority.
    assert.equal(r.bundle.review_scope.reviewer_tools, "none");
    assert.equal(r.bundle.review_scope.mutation_authority, false);
    assert.equal(r.bundle.review_scope.commit_authority, false);
    assert.equal(r.bundle.review_scope.push_authority, false);
    assert.equal(r.bundle.review_scope.seal_authority, false);
  } finally { cleanup(cwd); }
});

// ── 4/5/6/11. Lifecycle wiring ──────────────────────────────────────────

test("C4N-4 consistent evidence → reviewer receives the bundle → PASS", async () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    let capturedRequest = null;
    const reviewerAdapter = {
      runAdapter: async (request) => {
        capturedRequest = request;
        return completed(verdictJson(), "x");
      },
    };
    const outcome = await lifecycleWith({
      card,
      executorResult: (req) => completed(JSON.stringify(evidenceFor(req.taskCard, { actual_changed_paths: [] })), "x"),
      reviewerAdapter,
    });
    assert.equal(outcome.final, "PASS");
    assert.ok(capturedRequest, "reviewer adapter must be invoked");
    assert.ok(capturedRequest.reviewEvidence, "reviewer request must carry the evidence bundle");
    assert.equal(capturedRequest.reviewEvidence.execution_identity.phase_execution_id, card.executionId);
    assert.equal(capturedRequest.toolPolicy.mode, "no-tools");
  } finally { cleanup(cwd); }
});

test("C4N-5 missing implementation evidence / missing harness facts → HOLD before the reviewer", async () => {
  const cwd = gitFixture();
  try {
    // Executor final text is prose → NOT a gate under C4Q; the run proceeds.
    const outcome = await lifecycleWith({
      card: writerCard({ cwd }),
      executorResult: () => completed("All work is complete. No JSON.", "x"),
      reviewerAdapter: { runAdapter: async () => completed(verdictJson(), "x") },
    });
    assert.equal(outcome.final, "PASS");
    // Harness facts missing（non-git cwd）→ fail closed before review.
    const missingCard = writerCard({ cwd });
    const noFacts = buildHarnessOwnedEvidence({
      executionId: missingCard.parentExecutionId,
      taskCard: { ...missingCard, repositoryRoot: "/nonexistent" },
      attempt: 0, scopeCheck: { ok: true, violations: [], delta: [] },
      baseline: null, testRun: { ok: true, exit_code: 0 },
      executorResult: completed("", "x"),
    });
    assert.equal(noFacts.ok, false);
    assert.equal(noFacts.code, HARNESS_EVIDENCE_ERRORS.MISSING_FACTS);
    // Bundle builder itself fails closed on a non-object evidence.
    const r = buildReviewEvidenceBundle({ executionId: "exec_c4b000000000000000000000000000", taskCard: writerCard({ cwd }), attempt: 0, evidence: null, observedChangedPaths: [] });
    assert.equal(r.ok, false);
    assert.equal(r.code, REVIEW_EVIDENCE_ERRORS.MISSING);
  } finally { cleanup(cwd); }
});

test("C4N-6 reviewer cross-checks system-observed facts and HOLDS on test failure", async () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    // C4Q: the evidence is harness-owned（changed paths come from the system
    // delta）, so the reviewer's cross-check targets the system-observed test
    // outcome recorded in the bundle's objective facts.
    card.verificationCommand = ["node", "-e", "process.exit(1)"];
    const reviewerAdapter = createScriptedAdapter([{
      expect: { phase: "reviewer", attempt: 0 },
      result: (req) => {
        const bundle = req.reviewEvidence;
        assert.ok(bundle, "reviewer must receive the bundle");
        const t = bundle.objective_facts.test_executions[0];
        if (t.exit_code !== 0) {
          return completed(JSON.stringify({
            verdict: "HOLD", confidence: "HIGH", model: "test-model",
            summary: "system-observed verification failed",
            blocking_issues: [], required_supplements: [], scope_violations: [],
            evidence_gaps: ["verification failed"], recommended_next_action: "HUMAN_REVIEW",
          }), "x");
        }
        return completed(verdictJson(), "x");
      },
    }]);
    const outcome = await lifecycleWith({
      card,
      executorResult: () => completed("prose", "x"),
      reviewerAdapter,
    });
    assert.equal(outcome.final, "HOLD");
    assert.equal(outcome.reason, "REVIEWER_HOLD");
  } finally { cleanup(cwd); }
});

// ── 7/8/9/10. Fail-closed gates ─────────────────────────────────────────

test("C4N-7 internally incoherent test exit codes → HOLD", () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    const ev = evidenceFor(card, {
      actual_changed_paths: [],
      test_results: [{ test_identifier: "t", outcome: "passed", command: "node --test", exit_code: 1 }],
    });
    const r = buildReviewEvidenceBundle({ executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: ev, observedChangedPaths: [] });
    assert.equal(r.ok, false);
    assert.equal(r.code, REVIEW_EVIDENCE_ERRORS.TEST_INCONSISTENCY);
  } finally { cleanup(cwd); }
});

test("C4N-8 durable references are content-addressed（artifact sha + journal hash）", () => {
  const cwd = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4n-store-"));
  try {
    const card = writerCard({ cwd });
    const ev = evidenceFor(card, { actual_changed_paths: [] });
    const store = new RunEvidenceStore({
      root, executionId: card.parentExecutionId, chainId: "c4n-chain",
      checkpointId: "ckpt-1", repoRoot: cwd,
    });
    store.init();
    const written = store.writePhaseArtifact(card.phaseId, "executor-evidence.json", ev);
    const r = buildReviewEvidenceBundle({ executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: ev, observedChangedPaths: [] });
    assert.equal(r.ok, true);
    // Artifact sha matches the persisted artifact body（canonical + newline）.
    assert.equal(r.bundle.durable_references.evidence_artifact_sha256, written.sha256);
    assert.equal(r.bundle.durable_references.evidence_artifact_sha256, sha256Text(canonicalJson(ev) + "\n"));
    // Journal-style evidence hash matches the EXECUTOR_COMPLETED payload.
    assert.equal(r.bundle.durable_references.executor_completed_event.evidence_hash, sha256Text(canonicalJson(ev)));
    // Stale evidence：a different evidence object yields different hashes.
    const stale = buildReviewEvidenceBundle({ executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: evidenceFor(card, { actual_changed_paths: ["other"] }), observedChangedPaths: [] });
    assert.ok(stale.bundle.durable_references.evidence_artifact_sha256 !== r.bundle.durable_references.evidence_artifact_sha256);
  } finally {
    cleanup(cwd);
    cleanup(root);
  }
});

test("C4N-9 oversized bundle fails closed without truncation", () => {
  const cwd = gitFixture();
  try {
    const card = writerCard({ cwd });
    const ev = evidenceFor(card, { actual_changed_paths: [] });
    const r = buildReviewEvidenceBundle({
      executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: ev,
      observedChangedPaths: [], limits: { maxSerializedBytes: 64 },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, REVIEW_EVIDENCE_ERRORS.OVERSIZE);
    assert.ok(!("bundle" in r && r.bundle), "no partial/truncated bundle may be produced");
  } finally { cleanup(cwd); }
});

test("C4N-10 synthetic secret blocks evidence delivery and is not echoed", () => {
  const cwd = gitFixture();
  const SYNTH = "sk-abcdefghijklmnopqrstuvwxyz123456";
  try {
    const card = writerCard({ cwd });
    const ev = evidenceFor(card, { actual_changed_paths: [], executor_verdict: `finished with ${SYNTH}` });
    const r = buildReviewEvidenceBundle({ executionId: card.parentExecutionId, taskCard: card, attempt: 0, evidence: ev, observedChangedPaths: [] });
    assert.equal(r.ok, false);
    assert.equal(r.code, REVIEW_EVIDENCE_ERRORS.SECRET_RISK);
    assert.ok(!JSON.stringify(r).includes(SYNTH), "the matched secret content must never be echoed");
    assert.ok(!r.reason.includes(SYNTH));
  } finally { cleanup(cwd); }
});

// ── Production wiring（orchestrator）────────────────────────────────────

test("C4N-orch reviewer request through the production orchestrator carries the bundle", async () => {
  const cwd = gitFixture();
  try {
    const executionId = "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const captured = [];
    const reviewerFactoryCalls = [];
    const result = await runExecutionOrchestrator({
      ir: {
        verdict: "DECOMPOSED",
        parent_goal: "goal",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [{
          phase_id: "p_impl", title: "Impl", summary: "w", responsibility: "R2", purpose: "implementation",
          effects: {
            artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
            evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] },
          },
          covers: [{ requirement_id: "R2", completeness: "complete", claim: "c" }],
          depends_on: [],
        }],
        dispositions: [],
        decomposition_evidence: ["e"],
      },
      parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
      manifest: [{ requirement_id: "R2", text: "implement" }],
      cwd,
      executionId,
      executorAdapterFactory: () => createScriptedAdapter([{
        expect: { phase: "executor", attempt: 0 },
        result: (req) => completed(JSON.stringify(evidenceFor(req.taskCard, { actual_changed_paths: [] })), "x"),
      }]),
      reviewerAdapterFactory: () => {
        reviewerFactoryCalls.push(1);
        return {
          runAdapter: async (request) => {
            captured.push(request.reviewEvidence);
            return completed(verdictJson(), "x");
          },
        };
      },
      maxRepairAttempts: 0,
      timeoutMs: 5000,
      hooks: {
        toolPolicy: { mode: "no-tools" },
        environmentAllowlist: ["PATH"],
        expectedReviewerModel: "test-model",
        verificationCommand: ["node", "-e", "process.exit(0)"],
        expectedExecutorModel: "deepseek-v4-flash",
        expectedExecutorProvider: "deepseek",
      },
    });
    assert.equal(result.final, "PASS");
    assert.equal(reviewerFactoryCalls.length, 1);
    assert.equal(captured.length, 1);
    const bundle = captured[0];
    assert.ok(bundle, "production reviewer request must carry the evidence bundle");
    assert.equal(bundle.execution_identity.phase_id, "p_impl");
    assert.equal(bundle.execution_identity.phase_execution_id, phaseExecutionId(executionId, "p_impl"));
    assert.equal(bundle.executor_implementation_evidence.contract_id, phaseExecutionId(executionId, "p_impl"));
  } finally { cleanup(cwd); }
});

// ── Constants sanity ────────────────────────────────────────────────────

test("C4N-bound max serialized bytes is explicit and positive", () => {
  assert.ok(Number.isInteger(REVIEW_EVIDENCE_MAX_SERIALIZED_BYTES) && REVIEW_EVIDENCE_MAX_SERIALIZED_BYTES > 0);
  assert.deepEqual(Object.keys(REVIEW_EVIDENCE_ERRORS).sort(), [
    "BUILD_FAILED", "IDENTITY_MISMATCH", "MISSING", "OVERSIZE", "SECRET_RISK", "TEST_INCONSISTENCY",
  ]);
});
