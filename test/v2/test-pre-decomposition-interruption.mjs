// test/v2/test-pre-decomposition-interruption.mjs
//
// C4I focused tests — pre-decomposition interruption state alignment.
// A run that has not completed decomposition（no verified IR/DAG material,
// no frozen phase set）must never be marked AUTOLOOP_RESUMABLE, and
// resumeAutoLoop() must return the precise PRE_DECOMPOSITION_RESTART_REQUIRED
// result with zero provider/phase calls — never a generic
// RESUME_FINGERPRINT_MISMATCH.
// Zero model calls; the only adapters used are counting stubs that throw if
// invoked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { RunEvidenceStore } from "../../src/evidence/run-evidence-store.mjs";
import {
  publishCheckpoint, readCheckpoint, classifyResumeCapability,
  buildInputFingerprint, buildConfigurationFingerprint, buildIrSha256, buildDagFingerprint,
  collectRepositoryFingerprint, validateRunIdentity,
  AUTOLOOP_CHECKPOINT_FORMAT_VERSION, AUTOLOOP_STATE_RESUMABLE, AUTOLOOP_STATE_RESTART_REQUIRED,
} from "../../src/v2/checkpoint-bridge.mjs";
import { resumeAutoLoopInternal } from "../../src/v2/stack-a-internal.mjs";
import { runtimeIdentity, computeSourceHashes } from "../../src/v2/durable-execution.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "c4i-git-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

const SOURCE = { goal: "g", requirements: [{ requirement_id: "R1", text: "r" }], authority: {} };
const PARENT = { scope: { allowed_paths: ["src/"], forbidden_paths: [] } };
const MANIFEST_REQ = [{ requirement_id: "R1", text: "r" }];
const TOOL_POLICY = { mode: "no-tools" };

function twoPhaseIr() {
  return {
    verdict: "DECOMPOSED",
    title: "t",
    phases: [
      { phase_id: "p1", title: "p1", summary: "", responsibility: "", purpose: "implement", effects: { artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden", evidence_output: "bounded", boundaries: { artifact: ["src/a.mjs"] } }, covers: [], depends_on: [], verification_plan: { subject_phase_ids: [], method: "m", success_criteria: "s", failure_criteria: "f", evidence: "e" } },
      { phase_id: "p2", title: "p2", summary: "", responsibility: "", purpose: "verify", effects: { artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden", evidence_output: "bounded", boundaries: {} }, covers: [], depends_on: ["p1"], verification_plan: { subject_phase_ids: [], method: "m", success_criteria: "s", failure_criteria: "f", evidence: "e" } },
    ],
    dispositions: [],
  };
}

function baseConfigFp() {
  return buildConfigurationFingerprint({
    maxRepairAttempts: 0, timeoutMs: 1000, toolPolicy: TOOL_POLICY,
    environmentAllowlist: undefined, expectedReviewerModel: undefined,
    runtime: runtimeIdentity(), sourceHashes: computeSourceHashes(),
    decompositionAdapterConfigHash: null, executorAdapterPolicyHash: null, reviewerAdapterPolicyHash: null,
    persistenceFormatVersion: AUTOLOOP_CHECKPOINT_FORMAT_VERSION,
  });
}

/**
 * Publish a checkpoint for a run that has NOT completed decomposition
 *（ir/dag hashes absent, phase set not frozen）— the C4B interruption shape.
 * journalEvents: array of event types appended before publishing.
 */
async function preDecompositionCheckpoint({
  repo, root, executionId,
  irSha = null, dagSha = null, phaseStates = {},
  writeIrArtifact = false,
  journalEvents = ["RUN_CREATED", "INPUT_FROZEN"],
  snapshotOverrides = null,
}) {
  const identity = validateRunIdentity(executionId);
  const store = new RunEvidenceStore({ root, executionId, chainId: identity.chainId, checkpointId: identity.checkpointId, repoRoot: repo });
  store.init();
  store.writeArtifact("input.json", { source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ });
  if (writeIrArtifact) store.writeArtifact("decomposition-ir.json", twoPhaseIr());
  for (const ev of journalEvents) store.appendEvent({ event_type: ev, stage: "run", payload: {} });
  const repoFp = collectRepositoryFingerprint(repo);
  const pub = await publishCheckpoint({
    root, executionId, chainId: identity.chainId, checkpointId: identity.checkpointId,
    repositoryFingerprint: repoFp,
    inputFingerprint: buildInputFingerprint({ source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ }),
    configurationFingerprint: baseConfigFp(),
    irSha, dagSha,
    journalHead: store.journalHead,
    phaseStates, phaseAttempts: {}, phaseResultHashes: {}, completedPhaseIds: [],
    activePhase: null, activeLifecycleStage: null,
    writerPhaseActive: false, writerLeaseHolder: null, finalVerdict: null,
    resumePolicy: { safe_boundary: true, interrupted_writer: false, max_repair_attempts: 0, timeout_ms: 1000 },
    expectedRevision: 0, created_at: new Date().toISOString(),
    snapshotOverrides,
  });
  return { store, pub };
}

function countingAdapters() {
  const counts = { decomposition: 0, executor: 0, reviewer: 0 };
  return {
    counts,
    decompositionAdapter: { generate: async () => { counts.decomposition += 1; return { status: "error", reason: "must-not-be-called" }; } },
    executorAdapterFactory: () => ({ runAdapter: async () => { counts.executor += 1; throw new Error("must-not-be-called"); } }),
    reviewerAdapterFactory: () => ({ runAdapter: async () => { counts.reviewer += 1; throw new Error("must-not-be-called"); } }),
  };
}

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const REPO_A = resolve(HERE, "..", "..");

// ── 1/2. Pre-decomposition states are not RESUMABLE ──────────────────

test("C4I-1 a run created but not decomposed is not RESUMABLE", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_10000000000000000000000000000000";
  try {
    await preDecompositionCheckpoint({ repo, root, executionId, journalEvents: ["RUN_CREATED"] });
    const cp = readCheckpoint(root, executionId);
    assert.equal(cp.snapshot.c2d_control_state, AUTOLOOP_STATE_RESTART_REQUIRED);
    assert.notEqual(cp.snapshot.c2d_control_state, AUTOLOOP_STATE_RESUMABLE);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("C4I-2 after DECOMPOSITION_STARTED interruption is not RESUMABLE", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_20000000000000000000000000000000";
  try {
    await preDecompositionCheckpoint({ repo, root, executionId, journalEvents: ["RUN_CREATED", "INPUT_FROZEN", "DECOMPOSITION_STARTED"] });
    const cp = readCheckpoint(root, executionId);
    assert.equal(cp.snapshot.c2d_control_state, AUTOLOOP_STATE_RESTART_REQUIRED);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 3/4/5. Missing resume material is not RESUMABLE ──────────────────

test("C4I-3 missing decomposition-ir.json is not RESUMABLE", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_30000000000000000000000000000000";
  try {
    const ir = twoPhaseIr();
    await preDecompositionCheckpoint({
      repo, root, executionId,
      irSha: buildIrSha256(ir), dagSha: buildDagFingerprint(ir),
      phaseStates: { p1: "pending", p2: "pending" },
      writeIrArtifact: true,
    });
    // Resume-side observable check: once the artifact is gone the run is no
    // longer resumable even though the checkpoint carries ir/dag hashes.
    const cp = readCheckpoint(root, executionId);
    const cls = classifyResumeCapability({ checkpoint: cp.snapshot, artifacts: { decompositionIrExists: false }, journal: { valid: true, headMatches: true } });
    assert.equal(cls.capability, "RESTART_REQUIRED");
    assert.equal(cls.state, AUTOLOOP_STATE_RESTART_REQUIRED);
    // And resumeAutoLoop must refuse precisely, with zero calls.
    rmSync(join(cp.execDir, "artifacts", "decomposition-ir.json"), { force: true });
    const { counts, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory } = countingAdapters();
    const r = await resumeAutoLoopInternal({ persistenceRoot: root, executionId, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory, hooks: { toolPolicy: TOOL_POLICY } });
    assert.equal(r.final, "HOLD");
    assert.equal(r.reason, "PRE_DECOMPOSITION_RESTART_REQUIRED");
    assert.equal(counts.decomposition, 0);
    assert.equal(counts.executor + counts.reviewer, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("C4I-4 missing IR hash is not RESUMABLE", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_40000000000000000000000000000000";
  try {
    const ir = twoPhaseIr();
    await preDecompositionCheckpoint({
      repo, root, executionId,
      irSha: null, dagSha: buildDagFingerprint(ir),
      phaseStates: { p1: "pending", p2: "pending" },
      writeIrArtifact: true,
    });
    const cp = readCheckpoint(root, executionId);
    assert.equal(cp.snapshot.c2d_control_state, AUTOLOOP_STATE_RESTART_REQUIRED);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("C4I-5 missing DAG hash is not RESUMABLE", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_50000000000000000000000000000000";
  try {
    const ir = twoPhaseIr();
    await preDecompositionCheckpoint({
      repo, root, executionId,
      irSha: buildIrSha256(ir), dagSha: null,
      phaseStates: { p1: "pending", p2: "pending" },
      writeIrArtifact: true,
    });
    const cp = readCheckpoint(root, executionId);
    assert.equal(cp.snapshot.c2d_control_state, AUTOLOOP_STATE_RESTART_REQUIRED);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 6/7/8/9. Precise restart-required resume result with 0 calls ─────

test("C4I-6/7/8/9 pre-decomposition resume returns precise result with 0 provider/phase calls and no generic mismatch", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_60000000000000000000000000000000";
  try {
    await preDecompositionCheckpoint({ repo, root, executionId, journalEvents: ["RUN_CREATED", "INPUT_FROZEN", "DECOMPOSITION_STARTED"] });
    const { counts, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory } = countingAdapters();
    const r = await resumeAutoLoopInternal({
      persistenceRoot: root, executionId,
      decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory,
      hooks: { toolPolicy: TOOL_POLICY },
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.reason, "PRE_DECOMPOSITION_RESTART_REQUIRED");
    assert.equal(r.provider_calls, 0);
    assert.equal(r.phase_calls, 0);
    assert.equal(r.complete, false);
    assert.equal(r.resumed, false);
    assert.equal(r.evidence.state, "RESTART_REQUIRED");
    assert.equal(counts.decomposition, 0);
    assert.equal(counts.executor, 0);
    assert.equal(counts.reviewer, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 10. Decomposed runs with full material stay RESUMABLE ────────────

test("C4I-10 decomposition complete with full fingerprints remains RESUMABLE", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_10000000000000000000000000000000";
  try {
    const ir = twoPhaseIr();
    await preDecompositionCheckpoint({
      repo, root, executionId,
      irSha: buildIrSha256(ir), dagSha: buildDagFingerprint(ir),
      phaseStates: { p1: "pending", p2: "pending" },
      writeIrArtifact: true,
      journalEvents: ["RUN_CREATED", "INPUT_FROZEN", "DECOMPOSITION_COMPLETED", "DAG_ACCEPTED"],
    });
    const cp = readCheckpoint(root, executionId);
    assert.equal(cp.snapshot.c2d_control_state, AUTOLOOP_STATE_RESUMABLE);
    const cls = classifyResumeCapability({ checkpoint: cp.snapshot, artifacts: { decompositionIrExists: true }, journal: { valid: true, headMatches: true } });
    assert.equal(cls.capability, "RESUMABLE");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 11/12/13. Existing resume capabilities preserved ─────────────────

test("C4I-11/12 completed-phase and read-only interrupt capabilities are preserved", () => {
  const ir = twoPhaseIr();
  const base = {
    final_verdict: null,
    writer_phase_active: false,
    writer_lease_holder: null,
    decomposition_ir_sha256: buildIrSha256(ir),
    dag_sha256: buildDagFingerprint(ir),
    phase_states: { p1: "passed", p2: "pending" },
  };
  // Safe boundary with a completed phase → RESUMABLE（completed phases not re-run is
  // enforced by the runner; classification stays RESUMABLE）.
  const safe = classifyResumeCapability({ checkpoint: { ...base, active_phase: null }, artifacts: { decompositionIrExists: true }, journal: {} });
  assert.equal(safe.capability, "RESUMABLE");
  // Interrupted read-only phase（active phase, not a writer）→ RESUMABLE（requeue path）.
  const ro = classifyResumeCapability({ checkpoint: { ...base, active_phase: "p2", writer_phase_active: false }, artifacts: { decompositionIrExists: true }, journal: {} });
  assert.equal(ro.capability, "RESUMABLE");
  assert.equal(ro.state, AUTOLOOP_STATE_RESUMABLE.replace("RESUMABLE", "RUNNING"));
});

test("C4I-13 interrupted writer remains RECOVERY_REQUIRED", () => {
  const ir = twoPhaseIr();
  const cls = classifyResumeCapability({
    checkpoint: {
      final_verdict: null,
      active_phase: "p1",
      writer_phase_active: true,
      writer_lease_holder: "p1",
      decomposition_ir_sha256: buildIrSha256(ir),
      dag_sha256: buildDagFingerprint(ir),
      phase_states: { p1: "running", p2: "pending" },
    },
    artifacts: { decompositionIrExists: true },
    journal: {},
  });
  assert.equal(cls.capability, "RECOVERY_REQUIRED");
});

// ── 14/15/16. Fail-closed paths preserved ────────────────────────────

test("C4I-14 corrupt checkpoint still fails closed", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_14000000000000000000000000000000";
  try {
    await preDecompositionCheckpoint({ repo, root, executionId });
    const cp = readCheckpoint(root, executionId);
    const p = join(cp.execDir, "CURRENT.json");
    const obj = JSON.parse(readFileSync(p, "utf8"));
    obj.revision = "corrupt"; // flat C2D snapshot shape
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
    // checksum file not re-signed → readCurrent fails closed
    assert.throws(() => readCheckpoint(root, executionId));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("C4I-15 unknown format major still rejects", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_15000000000000000000000000000000";
  try {
    await preDecompositionCheckpoint({ repo, root, executionId, snapshotOverrides: { autoloop_format_version: "9.0.0" } });
    const { counts, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory } = countingAdapters();
    await assert.rejects(
      () => resumeAutoLoopInternal({ persistenceRoot: root, executionId, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory, hooks: { toolPolicy: TOOL_POLICY } }),
      (e) => e && e.code === "RESUME_FINGERPRINT_MISMATCH",
    );
    assert.equal(counts.decomposition, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("C4I-16 journal/checkpoint mismatch still rejects", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_16000000000000000000000000000000";
  try {
    await preDecompositionCheckpoint({ repo, root, executionId });
    // Tamper the journal head alignment AND re-sign the checksum file so the
    // checkpoint is internally consistent but points at a journal position
    // that does not exist → the resume pre-gate must reject (fail-closed).
    const cp = readCheckpoint(root, executionId);
    const p = join(cp.execDir, "CURRENT.json");
    const obj = JSON.parse(readFileSync(p, "utf8"));
    obj.journal_head_sequence = 999;
    const bytes = JSON.stringify(obj, null, 2) + "\n";
    writeFileSync(p, bytes);
    writeFileSync(join(cp.execDir, "CURRENT.json.sha256"), createHash("sha256").update(bytes).digest("hex") + "\n");
    const { counts, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory } = countingAdapters();
    await assert.rejects(
      () => resumeAutoLoopInternal({ persistenceRoot: root, executionId, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory, hooks: { toolPolicy: TOOL_POLICY } }),
      (e) => e && (e.code === "RESUME_FINGERPRINT_MISMATCH" || e.code === "JOURNAL_INTEGRITY_FAILURE"),
    );
    assert.equal(counts.decomposition, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 17. C4B 5-event fixture equivalence ──────────────────────────────

test("C4I-17 the C4B five-event interrupted state is classified restart-required", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_17000000000000000000000000000000";
  try {
    const identity = validateRunIdentity(executionId);
    const store = new RunEvidenceStore({ root, executionId, chainId: identity.chainId, checkpointId: identity.checkpointId, repoRoot: repo });
    store.init();
    store.writeArtifact("input.json", { source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ });
    // Replicate the interrupted C4B journal: RUN_CREATED(1),
    // CHECKPOINT_PUBLISHED(2), INPUT_FROZEN(3), then publish a checkpoint
    // (head=3, no IR), then CHECKPOINT_PUBLISHED(4) + DECOMPOSITION_STARTED(5).
    store.appendEvent({ event_type: "RUN_CREATED", stage: "run", payload: {} });
    store.appendEvent({ event_type: "CHECKPOINT_PUBLISHED", stage: "checkpoint", payload: {} });
    store.appendEvent({ event_type: "INPUT_FROZEN", stage: "input", payload: {} });
    const repoFp = collectRepositoryFingerprint(repo);
    const pub = await publishCheckpoint({
      root, executionId, chainId: identity.chainId, checkpointId: identity.checkpointId,
      repositoryFingerprint: repoFp,
      inputFingerprint: buildInputFingerprint({ source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ }),
      configurationFingerprint: baseConfigFp(),
      irSha: null, dagSha: null,
      journalHead: store.journalHead,
      phaseStates: {}, phaseAttempts: {}, phaseResultHashes: {}, completedPhaseIds: [],
      activePhase: null, activeLifecycleStage: null,
      writerPhaseActive: false, writerLeaseHolder: null, finalVerdict: null,
      resumePolicy: { safe_boundary: true, interrupted_writer: false, max_repair_attempts: 0, timeout_ms: 1000 },
      expectedRevision: 0, created_at: new Date().toISOString(),
    });
    store.appendEvent({ event_type: "CHECKPOINT_PUBLISHED", stage: "checkpoint", payload: { revision: pub.revision } });
    store.appendEvent({ event_type: "DECOMPOSITION_STARTED", stage: "decomposition", payload: {} });
    assert.equal(store.journalHead.seq, 5);

    const cp = readCheckpoint(root, executionId);
    assert.equal(cp.snapshot.journal_head_sequence, 3);
    assert.equal(cp.snapshot.c2d_control_state, AUTOLOOP_STATE_RESTART_REQUIRED);

    const { counts, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory } = countingAdapters();
    const r = await resumeAutoLoopInternal({
      persistenceRoot: root, executionId,
      decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory,
      hooks: { toolPolicy: TOOL_POLICY },
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.reason, "PRE_DECOMPOSITION_RESTART_REQUIRED");
    assert.equal(r.provider_calls, 0);
    assert.equal(r.phase_calls, 0);
    assert.equal(counts.decomposition, 0);
    assert.equal(counts.executor, 0);
    assert.equal(counts.reviewer, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 18. Single resume-capability authority ───────────────────────────

test("C4I-18 the classifier is the single resume-capability authority", async () => {
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_18000000000000000000000000000000";
  try {
    // The published checkpoint state must equal the classifier's state for
    // the same snapshot（writer side uses the same authority）.
    await preDecompositionCheckpoint({ repo, root, executionId });
    const cp = readCheckpoint(root, executionId);
    const cls = classifyResumeCapability({ checkpoint: cp.snapshot, artifacts: { decompositionIrExists: false }, journal: { valid: true, headMatches: true } });
    assert.equal(cls.capability, "RESTART_REQUIRED");
    assert.equal(cls.state, cp.snapshot.c2d_control_state);
    // And a decomposed checkpoint likewise.
    const ir = twoPhaseIr();
    const root2 = mkdtempSync(join(tmpdir(), "c4i-root2-"));
    const exec2 = "exec_19000000000000000000000000000000";
    try {
      await preDecompositionCheckpoint({
        repo, root: root2, executionId: exec2,
        irSha: buildIrSha256(ir), dagSha: buildDagFingerprint(ir),
        phaseStates: { p1: "pending", p2: "pending" }, writeIrArtifact: true,
      });
      const cp2 = readCheckpoint(root2, exec2);
      const cls2 = classifyResumeCapability({ checkpoint: cp2.snapshot, artifacts: { decompositionIrExists: true }, journal: { valid: true, headMatches: true } });
      assert.equal(cls2.capability, "RESUMABLE");
      assert.equal(cls2.state, cp2.snapshot.c2d_control_state);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 19. No second provider call ──────────────────────────────────────

test("C4I-19 rejected pre-decomposition resume adds no second provider call", async () => {
  // covered precisely in C4I-6/7/8/9 and C4I-17 via counting adapters:
  // decomposition == 0 means the decomposition request is never re-issued.
  const repo = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "c4i-root-"));
  const executionId = "exec_20000000000000000000000000000000";
  try {
    await preDecompositionCheckpoint({ repo, root, executionId, journalEvents: ["RUN_CREATED", "INPUT_FROZEN", "DECOMPOSITION_STARTED"] });
    const { counts, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory } = countingAdapters();
    await resumeAutoLoopInternal({ persistenceRoot: root, executionId, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory, hooks: { toolPolicy: TOOL_POLICY } });
    assert.equal(counts.decomposition, 0);
    assert.equal(counts.executor + counts.reviewer, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── 20. Phase-output contract untouched ──────────────────────────────

test("C4I-20 the phase-output contract is not modified", () => {
  // C4B freeze pins（unchanged by C4I）; phase-response-contract.mjs was
  // modified ON PURPOSE by the C4L authorized executor prompt hardening
  //（reviewer contract + FINAL_RESPONSE_CONTRACT_CORE verbatim）and again by
  // C4N（reviewer evidence-bundle pointer prepended; decision contract + CORE
  // verbatim）— pin updated to the C4N source state. phase-task-card.mjs was
  // modified ON PURPOSE by the Parallel Scheduler x Colima wiring card（task
  // card now carries phase.runtime so the Colima executor adapter can run the
  // phase's real isolated-container task）— pin updated to that source state.
  // phase-response-contract.mjs was modified ON PURPOSE again by VCA-1 Phase
  // 0B（sectionVerification now carries the AUTHORITATIVE_SOURCE_FIRST /
  // bounded-verification-root instruction, closing the agent-generated
  // unbounded-scan gap identified as VCA1-F1）— pin updated to that source
  // state.
  const phaseResponseSha = sha(join(REPO_A, "src/v2/phase-response-contract.mjs"));
  const phaseTaskCardSha = sha(join(REPO_A, "src/v2/phase-task-card.mjs"));
  assert.equal(phaseResponseSha, "d7f35987a2a76de2fde027471bcaa1205ed58ea03436f18b44d11a279ada26df");
  // phase-task-card.mjs modified ON PURPOSE by AUTOLOOP-V1-STAGE-C-REGISTRY-
  // BACKED-TASK-SPECIFIC-TOOL-SELECTION-1: taskCard.toolPolicy is now MINTED
  // from projectToolSelection (raw caller passthrough removed; bind via
  // toolSelectionBind) — pin updated to that source state.
  // Modified ON PURPOSE again by AUTOLOOP-V1-STAGE-C-TOOL-SELECTION-PRODUCTION-
  // WIRING-1: mintTaskCardToolSelectionBind exported as THE single reusable
  // mint (graph orchestrator hook + SOP direct runner share it; explicit null
  // nodeRole = §6.1 direct-execution semantics) and observation failures now
  // surface as THE frozen RUNTIME_VOCABULARY_DRIFT code (review C4 repair) —
  // pin updated to that state.
  assert.equal(phaseTaskCardSha, "fb0f13b2f00358774d3524321d3771fa6ce79ae8a22fe9d5cb63115c109fcd3e");
});
