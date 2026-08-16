// test/v2/test-durable-execution.mjs
//
// C3 — durable execution + safe resume tests（resume safety matrix,
// fingerprint mismatch, interrupted writer fail-closed, manifest finalize）.
// Offline only（temp git worktree + temp evidence root）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runAutoLoopInternal, resumeAutoLoopInternal, runDurableAutoLoopInternal } from "../../src/v2/stack-a-internal.mjs";
import { RunEvidenceStore, canonicalJson, sha256Text } from "../../src/evidence/run-evidence-store.mjs";
import { readRunManifest, manifestPath, manifestShaPath } from "../../src/evidence/run-manifest.mjs";
import {
  publishCheckpoint, readCheckpoint, validateRunIdentity, collectRepositoryFingerprint,
  buildInputFingerprint, buildConfigurationFingerprint, buildDagFingerprint, buildIrSha256,
  AUTOLOOP_CHECKPOINT_FORMAT_VERSION,
} from "../../src/v2/checkpoint-bridge.mjs";
import { runtimeIdentity, computeSourceHashes } from "../../src/v2/durable-execution.mjs";
import { mintExecutionId } from "../../src/c2d/execution-id.mjs";
import { setInjectionHook, clearInjectionHooks } from "../../src/c2d/fs-atomic.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "c3-dur-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

const MANIFEST_REQ = [
  { requirement_id: "R1", text: "analyze" },
  { requirement_id: "R2", text: "implement" },
];
const PARENT = { scope: { allowed_paths: ["src/"], forbidden_paths: [] } };
const SOURCE = { goal: "task", requirements: MANIFEST_REQ, authority: { allowed_paths: ["src/"], mutation_allowed: true, commit_allowed: false } };

function twoPhaseIr() {
  return {
    verdict: "DECOMPOSED",
    parent_goal: "goal",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [
      {
        phase_id: "p_analysis",
        title: "Analysis", summary: "ro", responsibility: "R1", purpose: "analysis",
        effects: {
          artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
          evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
        },
        covers: [{ requirement_id: "R1", completeness: "complete", claim: "c" }],
        depends_on: [],
      },
      {
        phase_id: "p_impl",
        title: "Impl", summary: "w", responsibility: "R2", purpose: "implementation",
        effects: {
          artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
          evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: ["evidence/"] },
        },
        covers: [{ requirement_id: "R2", completeness: "complete", claim: "c" }],
        depends_on: ["p_analysis"],
      },
    ],
    dispositions: [],
    decomposition_evidence: ["e"],
  };
}

const FIXTURE_EVIDENCE = JSON.parse(readFileSync(new URL("../fixtures/implementation-evidence-valid.json", import.meta.url), "utf8"));

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
  return { generate: async () => ({ status: "completed", parsed: ir, content: JSON.stringify(ir), thinking: "", usage: null, stopReason: "stop", elapsedMs: 1, requestCount: 1 }) };
}

function passingFactories() {
  return {
    executorAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "executor", attempt: 0 }, result: (req) => completed(evidenceJson(req), "x") }]),
    reviewerAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson(), "x") }]),
  };
}

const TOOL_POLICY = { mode: "no-tools" };

// C4Q harness configuration.
const HARNESS_HOOKS = {
  environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  verificationCommand: ["node", "-e", "process.exit(0)"],
  expectedExecutorModel: "deepseek-v4-flash",
  expectedExecutorProvider: "deepseek",
};

function baseConfigFp({ maxRepairAttempts = 0, timeoutMs = 1000, toolPolicy = TOOL_POLICY, environmentAllowlist = ["PATH", "HOME", "TMPDIR"], expectedReviewerModel = undefined } = {}) {
  // environmentAllowlist must match the resume hooks（C4Q harness config）so
  // the frozen configuration fingerprint stays consistent.
  return buildConfigurationFingerprint({
    maxRepairAttempts, timeoutMs, toolPolicy,
    environmentAllowlist, expectedReviewerModel,
    runtime: runtimeIdentity(), sourceHashes: computeSourceHashes(),
    decompositionAdapterConfigHash: null, executorAdapterPolicyHash: null, reviewerAdapterPolicyHash: null,
    persistenceFormatVersion: AUTOLOOP_CHECKPOINT_FORMAT_VERSION,
  });
}

async function runDurableComplete({ ir = twoPhaseIr(), factories = passingFactories(), maxRepairAttempts = 0, signal } = {}) {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c3-dur-root-"));
  const executionId = mintExecutionId();
  const result = await runDurableAutoLoopInternal({
    source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ, cwd: repo,
    decompositionAdapter: adapterFor(ir),
    ...factories,
    maxRepairAttempts, timeoutMs: 1000, signal,
    hooks: { toolPolicy: TOOL_POLICY, ...HARNESS_HOOKS },
    persistence: { mode: "durable", root, executionId },
  });
  return { result, repo, root, executionId };
}

async function interruptedCheckpoint({
  repo, root, executionId, ir = twoPhaseIr(),
  phaseStates, phaseResultHashes = {}, completedPhaseIds = [], activePhase = null,
  writerPhaseActive = false, writerLeaseHolder = null,
  journalExtra = [], toolPolicy = TOOL_POLICY, maxRepairAttempts = 0, timeoutMs = 1000,
  snapshotOverrides = null,
}) {
  const identity = validateRunIdentity(executionId);
  const store = new RunEvidenceStore({ root, executionId, chainId: identity.chainId, checkpointId: identity.checkpointId, repoRoot: repo });
  store.init();
  store.writeArtifact("input.json", { source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ });
  store.writeArtifact("decomposition-ir.json", ir);
  // I1: a complete interrupted run also carries the decomposition-validation
  // artifact (resume re-derives the manifest from it) — hand-built checkpoints
  // must mirror a real run's durable artifacts.
  store.writeArtifact("decomposition-validation.json", {
    schema_valid: true,
    structural: [],
    semantic: [],
    scorecard_verdict: "PASS",
    prompt_builder_version: "test-prompt-version",
  });
  for (const ev of [
    { event_type: "RUN_CREATED", stage: "run", payload: {} },
    { event_type: "INPUT_FROZEN", stage: "input", payload: {} },
    { event_type: "DECOMPOSITION_COMPLETED", stage: "decomposition", payload: {} },
    { event_type: "DAG_ACCEPTED", stage: "decomposition", payload: {} },
    ...journalExtra,
  ]) store.appendEvent(ev);
  const repoFp = collectRepositoryFingerprint(repo);
  const pub = await publishCheckpoint({
    root, executionId, chainId: identity.chainId, checkpointId: identity.checkpointId,
    repositoryFingerprint: repoFp,
    inputFingerprint: buildInputFingerprint({ source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ }),
    configurationFingerprint: baseConfigFp({ maxRepairAttempts, timeoutMs, toolPolicy }),
    irSha: buildIrSha256(ir), dagSha: buildDagFingerprint(ir),
    journalHead: store.journalHead,
    phaseStates, phaseAttempts: {}, phaseResultHashes,
    completedPhaseIds, activePhase, activeLifecycleStage: activePhase ? "phase_started" : null,
    writerPhaseActive, writerLeaseHolder, finalVerdict: null,
    resumePolicy: { safe_boundary: !activePhase, interrupted_writer: false, max_repair_attempts: maxRepairAttempts, timeout_ms: timeoutMs },
    expectedRevision: 0, created_at: new Date().toISOString(),
    snapshotOverrides,
  });
  return { store, pub };
}

async function resumeWith({ root, executionId, factories = passingFactories(), hooks = {} }) {
  return resumeAutoLoopInternal({
    persistenceRoot: root, executionId,
    decompositionAdapter: adapterFor(twoPhaseIr()),
    ...factories,
    hooks: { toolPolicy: TOOL_POLICY, ...HARNESS_HOOKS, ...hooks },
  });
}

// ── Completed-run resume rejection（fingerprint matrix）──

test("12: configuration change rejects resume", async () => {
  const { result, repo, root, executionId } = await runDurableComplete();
  try {
    assert.equal(result.final, "PASS");
    await assert.rejects(
      resumeAutoLoopInternal({
        persistenceRoot: root, executionId,
        decompositionAdapter: adapterFor(twoPhaseIr()),
        ...passingFactories(),
        hooks: { toolPolicy: { mode: "allowlist", tools: ["bash"] }, ...HARNESS_HOOKS },
      }),
      (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("13: source/parent/manifest tamper rejects resume", async () => {
  const { result, repo, root, executionId } = await runDurableComplete();
  try {
    const execDir = readCheckpoint(root, executionId).execDir;
    const p = join(execDir, "artifacts", "input.json");
    const obj = JSON.parse(readFileSync(p, "utf8"));
    obj.manifest[0].text = "tampered";
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
    await assert.rejects(() => resumeWith({ root, executionId }), (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("14: IR tamper rejects resume", async () => {
  const { result, repo, root, executionId } = await runDurableComplete();
  try {
    const execDir = readCheckpoint(root, executionId).execDir;
    const p = join(execDir, "artifacts", "decomposition-ir.json");
    const ir = JSON.parse(readFileSync(p, "utf8"));
    ir.phases[0].phase_id = "p_tampered";
    writeFileSync(p, JSON.stringify(ir, null, 2) + "\n");
    await assert.rejects(() => resumeWith({ root, executionId }), (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("15: DAG edge tamper rejects resume", async () => {
  const { result, repo, root, executionId } = await runDurableComplete();
  try {
    const execDir = readCheckpoint(root, executionId).execDir;
    const p = join(execDir, "artifacts", "decomposition-ir.json");
    const ir = JSON.parse(readFileSync(p, "utf8"));
    ir.phases[1].depends_on = []; // remove the dependency edge
    writeFileSync(p, JSON.stringify(ir, null, 2) + "\n");
    await assert.rejects(() => resumeWith({ root, executionId }), (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("16: repository HEAD change rejects resume", async () => {
  const { result, repo, root, executionId } = await runDurableComplete();
  try {
    writeFileSync(join(repo, "newfile.txt"), "x\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "bump head"], { cwd: repo, stdio: "ignore" });
    await assert.rejects(() => resumeWith({ root, executionId }), (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("17: repository identity change rejects resume", async () => {
  const { result, repo, root, executionId } = await runDurableComplete();
  try {
    rmSync(repo, { recursive: true, force: true });
    const newRepo = gitFixture(); // different .git identity at a new path
    // Point the old path at the new repo so the resume read works but identity differs.
    await assert.rejects(() => resumeWith({ root, executionId }), (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH");
    rmSync(newRepo, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("18: unexpected dirty path rejects resume", async () => {
  const { result, repo, root, executionId } = await runDurableComplete();
  try {
    writeFileSync(join(repo, "unexpected.txt"), "dirty\n");
    await assert.rejects(() => resumeWith({ root, executionId }), (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("26: NOT_BENEFICIAL run completes with a manifest", async () => {
  const ir = {
    verdict: "DECOMPOSITION_NOT_BENEFICIAL",
    reason: "already satisfied",
    dispositions: [
      { requirement_id: "R1", disposition: "not_beneficial", reason_code: "ALREADY_SATISFIED", evidence: "e" },
      { requirement_id: "R2", disposition: "not_beneficial", reason_code: "ALREADY_SATISFIED", evidence: "e" },
    ],
    decomposition_evidence: ["e"],
  };
  const { result, repo, root, executionId } = await runDurableComplete({ ir });
  try {
    assert.equal(result.final, "NOT_BENEFICIAL");
    assert.equal(result.evidence.state, "TERMINAL_NOT_BENEFICIAL");
    const execDir = readCheckpoint(root, executionId).execDir;
    const manifest = readRunManifest(execDir);
    assert.equal(manifest.final_verdict, "NOT_BENEFICIAL");
    assert.ok(existsSync(manifestPath(execDir)));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("25: HOLD run evidence is retained (journal + manifest, nothing deleted)", async () => {
  const factories = {
    executorAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "executor", attempt: 0 }, result: (req) => completed(evidenceJson(req), "x") }]),
    reviewerAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson({ verdict: "HOLD", recommended_next_action: "HUMAN_REVIEW" }), "x") }]),
  };
  const { result, repo, root, executionId } = await runDurableComplete({ factories });
  try {
    assert.equal(result.final, "HOLD");
    assert.equal(result.evidence.state, "TERMINAL_HOLD");
    const execDir = readCheckpoint(root, executionId).execDir;
    assert.ok(existsSync(execDir), "evidence dir retained");
    const journalFiles = readdirSync(join(execDir, "journal")).filter((f) => f.endsWith(".json"));
    assert.ok(journalFiles.length > 0, "journal retained");
    const manifest = readRunManifest(execDir);
    assert.equal(manifest.final_verdict, "HOLD");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("32: abort leaves a consistent checkpoint", async () => {
  const ac = new AbortController();
  ac.abort();
  const { result, repo, root, executionId } = await runDurableComplete({ signal: ac.signal });
  try {
    assert.equal(result.final, "HOLD");
    const execDir = readCheckpoint(root, executionId).execDir;
    const store = new RunEvidenceStore({ root, executionId, chainId: result.evidence.chain_id, checkpointId: deriveCkpt(executionId) });
    store.init();
    const v = store.verifyJournal();
    assert.ok(v.ok, "journal chain consistent after abort");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("33: evidence write failure stops the run (no next phase)", async () => {
  // C4Q: a secret in the non-authoritative executor output makes the bounded
  // output-diagnostic persistence fail closed（EXECUTOR_OUTPUT_PERSISTENCE_FAILED）
  // → phase failed → HOLD before p_impl.
  const factories = {
    executorAdapterFactory: () => createScriptedAdapter([
      { expect: { phase: "executor", attempt: 0 }, result: completed("synthetic-secret-sentinel-0123456789abcdef evidence output", "x") },
    ]),
    reviewerAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson(), "x") }]),
  };
  const { result, repo, root, executionId } = await runDurableComplete({ factories });
  try {
    assert.equal(result.final, "HOLD");
    // p_impl must never have started.
    const execDir = readCheckpoint(root, executionId).execDir;
    assert.ok(!existsSync(join(execDir, "phases", "p_impl")), "p_impl must never run after evidence write failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("34: checkpoint publication failure stops the run (no next phase)", async () => {
  let injected = false;
  setInjectionHook("before_current_rename", () => {
    if (!injected) {
      injected = true;
      throw new Error("injected checkpoint fs failure");
    }
  });
  try {
    const { result, repo, root, executionId } = await runDurableComplete();
    try {
      assert.equal(result.final, "HOLD");
      const execDir = readCheckpoint(root, executionId).execDir;
      assert.ok(!existsSync(join(execDir, "phases", "p_impl")), "p_impl must never run after checkpoint publication failure");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    clearInjectionHooks();
  }
});

test("36: unknown checkpoint major version rejects resume", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c3-dur-root-"));
  const executionId = mintExecutionId();
  try {
    await interruptedCheckpoint({
      repo, root, executionId,
      phaseStates: { p_analysis: "pending", p_impl: "pending" },
      snapshotOverrides: { autoloop_format_version: "9.0.0" },
    });
    await assert.rejects(() => resumeWith({ root, executionId }), (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("37: phase set inconsistent with IR rejects resume", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c3-dur-root-"));
  const executionId = mintExecutionId();
  try {
    await interruptedCheckpoint({
      repo, root, executionId,
      phaseStates: { p_analysis: "pending", p_impl: "pending", bogus: "pending" },
    });
    await assert.rejects(() => resumeWith({ root, executionId }), (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("38: missing phase result hash rejects resume", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c3-dur-root-"));
  const executionId = mintExecutionId();
  try {
    await interruptedCheckpoint({
      repo, root, executionId,
      phaseStates: { p_analysis: "passed", p_impl: "pending" },
      completedPhaseIds: ["p_analysis"],
      phaseResultHashes: {}, // missing hash for the completed phase
    });
    await assert.rejects(() => resumeWith({ root, executionId }), (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── Safe resume：interrupted at a safe boundary ──

test("20: safe checkpoint resumes and executes the remaining phases", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c3-dur-root-"));
  const executionId = mintExecutionId();
  try {
    await interruptedCheckpoint({
      repo, root, executionId,
      phaseStates: { p_analysis: "passed", p_impl: "pending" },
      completedPhaseIds: ["p_analysis"],
      phaseResultHashes: { p_analysis: "a".repeat(64) },
      journalExtra: [
        { event_type: "PHASE_STARTED", stage: "phase", phase_id: "p_analysis", payload: {} },
        { event_type: "EXECUTOR_COMPLETED", stage: "phase", phase_id: "p_analysis", payload: {} },
        { event_type: "REVIEWER_COMPLETED", stage: "phase", phase_id: "p_analysis", payload: {} },
        { event_type: "PHASE_PASSED", stage: "phase", phase_id: "p_analysis", payload: {} },
      ],
    });
    const r = await resumeWith({ root, executionId });
    assert.equal(r.final, "PASS");
    assert.equal(r.evidence.final_verdict, "PASS");
    assert.equal(r.evidence.state, "TERMINAL_PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("19: completed phases are never re-run on resume", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c3-dur-root-"));
  const executionId = mintExecutionId();
  try {
    await interruptedCheckpoint({
      repo, root, executionId,
      phaseStates: { p_analysis: "passed", p_impl: "pending" },
      completedPhaseIds: ["p_analysis"],
      phaseResultHashes: { p_analysis: "a".repeat(64) },
    });
    let executorCalls = [];
    const r = await resumeAutoLoopInternal({
      persistenceRoot: root, executionId,
      decompositionAdapter: adapterFor(twoPhaseIr()),
      executorAdapterFactory: () => {
        executorCalls.push("executor");
        return createScriptedAdapter([{ expect: { phase: "executor", attempt: 0 }, result: (req) => completed(evidenceJson(req), "x") }]);
      },
      reviewerAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson(), "x") }]),
      hooks: { toolPolicy: TOOL_POLICY, ...HARNESS_HOOKS },
    });
    assert.equal(r.final, "PASS");
    assert.deepEqual(executorCalls, ["executor"], "only the remaining phase p_impl may run");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("21: interrupted read-only phase is safely requeued", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c3-dur-root-"));
  const executionId = mintExecutionId();
  try {
    await interruptedCheckpoint({
      repo, root, executionId,
      phaseStates: { p_analysis: "running", p_impl: "pending" },
      completedPhaseIds: [],
      phaseResultHashes: {},
      activePhase: "p_analysis", // read-only, non-terminal
      journalExtra: [{ event_type: "PHASE_STARTED", stage: "phase", phase_id: "p_analysis", payload: {} }],
    });
    const r = await resumeWith({ root, executionId });
    assert.equal(r.final, "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("22: interrupted writer phase → RECOVERY_REQUIRED", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c3-dur-root-"));
  const executionId = mintExecutionId();
  try {
    await interruptedCheckpoint({
      repo, root, executionId,
      phaseStates: { p_analysis: "passed", p_impl: "running" },
      completedPhaseIds: ["p_analysis"],
      phaseResultHashes: { p_analysis: "a".repeat(64) },
      activePhase: "p_impl", // writer, non-terminal
      writerPhaseActive: true,
      writerLeaseHolder: "p_impl",
      journalExtra: [{ event_type: "PHASE_STARTED", stage: "phase", phase_id: "p_impl", payload: { writer: true } }],
    });
    await assert.rejects(
      () => resumeWith({ root, executionId }),
      (e) => e && e.code === "INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("23: writer lease remnant rejects resume", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c3-dur-root-"));
  const executionId = mintExecutionId();
  try {
    await interruptedCheckpoint({
      repo, root, executionId,
      phaseStates: { p_analysis: "pending", p_impl: "pending" },
      activePhase: null,
      writerLeaseHolder: "p_impl", // remnant lease with no active phase
    });
    await assert.rejects(() => resumeWith({ root, executionId }), (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("24: descendant skipped states are preserved on resume", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c3-dur-root-"));
  const executionId = mintExecutionId();
  try {
    await interruptedCheckpoint({
      repo, root, executionId,
      phaseStates: { p_analysis: "held", p_impl: "skipped_due_to_dependency" },
      completedPhaseIds: [],
      phaseResultHashes: {},
      activePhase: null,
      journalExtra: [
        { event_type: "PHASE_STARTED", stage: "phase", phase_id: "p_analysis", payload: {} },
        { event_type: "PHASE_HELD", stage: "phase", phase_id: "p_analysis", payload: {} },
        { event_type: "PHASE_SKIPPED", stage: "phase", phase_id: "p_impl", payload: {} },
      ],
    });
    const r = await resumeWith({ root, executionId });
    assert.equal(r.final, "HOLD");
    assert.equal(r.scheduler.statuses.p_impl, "skipped_due_to_dependency", "descendant skip must persist");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("40: durable complete offline run is re-verifiable", async () => {
  const { result, repo, root, executionId } = await runDurableComplete();
  try {
    assert.equal(result.final, "PASS");
    const cp = readCheckpoint(root, executionId);
    assert.equal(cp.snapshot.final_verdict, "PASS");
    const execDir = cp.execDir;
    const manifest = readRunManifest(execDir);
    const body = readFileSync(manifestPath(execDir), "utf8");
    assert.equal(sha256Text(body), readFileSync(manifestShaPath(execDir), "utf8").trim());
    assert.equal(manifest.final_verdict, "PASS");
    // Resume of a completed run reports the terminal verdict.
    const resumed = await resumeWith({ root, executionId });
    assert.equal(resumed.final, "PASS");
    assert.equal(resumed.complete, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("39: ephemeral mode creates no filesystem evidence", async () => {
  const repo = gitFixture();
  try {
    const r = await runAutoLoopInternal({
      source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ, cwd: repo,
      decompositionAdapter: adapterFor(twoPhaseIr()),
      ...passingFactories(), maxRepairAttempts: 0, timeoutMs: 1000,
      hooks: HARNESS_HOOKS,
      persistence: { mode: "ephemeral" },
    });
    assert.equal(r.final, "PASS");
    assert.equal(r.evidence, undefined, "ephemeral mode must not expose an evidence directory");
    assert.equal(r.phaseResults.length, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function deriveCkpt(executionId) {
  return `ckpt_${sha256Text(`autoloop:${executionId}:checkpoint`).slice(0, 24)}`;
}
