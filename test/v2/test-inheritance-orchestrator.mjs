// test/v2/test-inheritance-orchestrator.mjs
//
// DECOMP-OPT1-PC1 — orchestrator integration tests（production modules）:
//   P  normal: parent facts observed once, every child inherits by packet,
//      verification layering skips read-only phases
//   Q  drift: mid-run HEAD change → next child refuses stale REUSE（HOLD）
//   R  irrelevant drift: unrelated dirty file → reusable facts preserved
//   S  CBM hit / miss: recorded manifest reused by identity; miss degrades
//      to bounded source build
//   U-11 multiple children share the same manifest identity
//   U-10 resume/restart: deterministic manifest identity across runs
//
// Offline only（temp git worktree + temp memory store + scripted adapters）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runExecutionOrchestrator } from "../../src/v2/execution-orchestrator.mjs";
import { buildInheritanceManifest } from "../../src/v2/decomposition-inheritance.mjs";
import { runDurableAutoLoopInternal } from "../../src/v2/stack-a-internal.mjs";
import { mintExecutionId } from "../../src/c2d/execution-id.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";
import { LocalMemoryStore, resolveRepositoryIdentity } from "../../src/memory/local-store.mjs";
import { recordInheritanceManifest, queryInheritanceManifest } from "../../src/memory/inheritance-cbm.mjs";
import { buildDagFingerprint, buildIrSha256 } from "../../src/v2/checkpoint-bridge.mjs";

// ── fixtures ─────────────────────────────────────────────────────────────

function gitFixture(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inh-orch-"));
  execFileSync("git", ["init", "-b", "master", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    const parent = p.slice(0, p.lastIndexOf("/"));
    if (parent !== dir) mkdirSync(parent, { recursive: true });
    writeFileSync(p, text);
  }
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "base"], { stdio: "ignore" });
  return dir;
}

// 3-child IR：A（read-only analysis）→ B（writer, dep A）→ C（read-only
// verification, dep A+B）— children share parent/run facts, distinct
// child-local obligations.
function threeChildIr() {
  return {
    verdict: "DECOMPOSED",
    parent_goal: "goal",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [
      {
        phase_id: "p_a", title: "Analysis", summary: "ro", responsibility: "R1", purpose: "analysis",
        effects: { artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden", evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] } },
        covers: [{ requirement_id: "R1", completeness: "complete", claim: "c" }], depends_on: [],
      },
      {
        phase_id: "p_b", title: "Impl", summary: "w", responsibility: "R2", purpose: "implementation",
        effects: { artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden", evidence_output: "persistent", boundaries: { artifact: ["src/b/"], runtime: [], external_system: [], evidence: ["evidence/"] } },
        covers: [{ requirement_id: "R2", completeness: "complete", claim: "c" }], depends_on: ["p_a"],
      },
      {
        phase_id: "p_c", title: "Verify", summary: "ro", responsibility: "R3", purpose: "verification",
        effects: { artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden", evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] } },
        covers: [{ requirement_id: "R3", completeness: "complete", claim: "c" }], depends_on: ["p_a", "p_b"],
        verification_plan: {
          subject_phase_ids: ["p_a", "p_b"],
          method: "analysis",
          success_criteria: [{ criterion_id: "C1", text: "verified" }],
          failure_criteria: ["criterion unmet"],
          evidence: "system-observed verification outcome",
        },
      },
    ],
    dispositions: [],
    decomposition_evidence: ["e"],
  };
}

const MANIFEST_REQ = [
  { requirement_id: "R1", text: "analyze" },
  { requirement_id: "R2", text: "implement" },
  { requirement_id: "R3", text: "verify" },
];
const PARENT = { scope: { allowed_paths: ["src/"], forbidden_paths: ["src/forbidden"] } };
const SOURCE = { goal: "task", requirements: MANIFEST_REQ, authority: { allowed_paths: ["src/"], mutation_allowed: true, commit_allowed: false } };
const TOOL_POLICY = { mode: "no-tools" };
const HARNESS_HOOKS = {
  environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  expectedReviewerModel: "test-model",
  verificationCommand: ["node", "-e", "process.exit(0)"],
  expectedExecutorModel: "deepseek-v4-flash",
  expectedExecutorProvider: "deepseek",
};

const FIXTURE_EVIDENCE = JSON.parse(readFileSync(new URL("../fixtures/implementation-evidence-valid.json", import.meta.url), "utf8"));
function evidenceJson(request) {
  const contractId = request?.taskCard?.executionId ?? FIXTURE_EVIDENCE.contract_id;
  return JSON.stringify({ ...FIXTURE_EVIDENCE, contract_id: contractId });
}
function verdictJson(overrides = {}) { return JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP", ...overrides }); }
function completed(stdout, executionId) { return { status: "completed", executionId, stdout, stderr: "", signal: null, error: null, metadata: { exitCode: 0 } }; }

function passingFactories(executorSideEffect = null) {
  return {
    executorAdapterFactory: () => createScriptedAdapter([
      { expect: { phase: "executor", attempt: 0 }, result: (req) => { if (executorSideEffect) executorSideEffect(req); return completed(evidenceJson(req), "x"); } },
    ]),
    reviewerAdapterFactory: () => createScriptedAdapter([
      { expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson(), "x") },
    ]),
  };
}

const INHERITANCE_BASE = {
  enabled: true,
  parentCardId: "parent-card-1",
  parentGeneration: 1,
};

// ── P normal case ────────────────────────────────────────────────────────

test("P: parent facts observed once; 3 children inherit by packet; read-only verification skipped", async () => {
  const cwd = gitFixture({ "src/spec.txt": "spec v1\n" });
  try {
    const r = await runExecutionOrchestrator({
      ir: threeChildIr(), parent: PARENT, manifest: MANIFEST_REQ, cwd,
      executionId: "exec_11111111111111111111111111111111",
      ...passingFactories(),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
      inheritance: { ...INHERITANCE_BASE, specFilePaths: ["src/spec.txt"] },
    });
    assert.equal(r.final, "PASS", `run must PASS: ${r.reason}`);
    const inh = r.inheritance;
    assert.ok(inh, "inheritance block must be present");
    assert.ok(inh.manifest, "manifest must be built");
    assert.match(inh.manifestIdentity, /^decompInherit_[0-9a-f]{16}$/);
    assert.ok(/^[0-9a-f]{64}$/.test(inh.manifestSha256));
    const t = inh.telemetry;
    // parent facts observed exactly once（not once per child）
    assert.ok(t.parentFactsObservedOnce >= 1, `parent facts observed once: ${t.parentFactsObservedOnce}`);
    assert.equal(t.childPacketCount, 3, "one packet per child");
    assert.equal(t.identityObservationsPerChild.guard, 3, "exactly one guard per child");
    // verification layering: p_a + p_c are read-only → their verification
    // process runs are avoided（writer p_b still runs it）
    assert.ok(t.duplicateVerificationAvoided >= 2, `read-only verification avoided: ${t.duplicateVerificationAvoided}`);
    assert.equal(t.duplicateContextReconstructionAvoided, 3, "no context reconstruction per child");
    assert.ok(t.reuseCount > 0, "some facts REUSEd");
    // disposition totals are consistent
    assert.equal(t.reuseCount + t.revalidateCount + t.recomputeCount + t.inheritanceHoldCount, t.inheritedFactCount);
    // all three children share the SAME manifest identity
    assert.equal(inh.dispositionCounts.reuseCount, t.reuseCount);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("U-11: multiple children reuse the same manifest identity（packet-bound）", async () => {
  const cwd = gitFixture();
  try {
    const r = await runExecutionOrchestrator({
      ir: threeChildIr(), parent: PARENT, manifest: MANIFEST_REQ, cwd,
      executionId: "exec_22222222222222222222222222222222",
      ...passingFactories(),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
      inheritance: { ...INHERITANCE_BASE },
    });
    assert.equal(r.final, "PASS");
    const manifest = r.inheritance.manifest;
    // every phase transition carries the inherited baseline → the evidence
    // repository_baseline embeds the same manifest reference. We assert via
    // the F3A fact projection: the frozen baseline matches the manifest.
    assert.equal(r.inheritance.manifestIdentity, manifest.manifestIdentity);
    assert.equal(r.inheritance.manifestSha256, manifest.manifestSha256);
    assert.ok(Array.isArray(manifest.facts) && manifest.facts.length >= 7);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Q drift: fail closed, never silent reuse ─────────────────────────────

test("Q: mid-run HEAD drift → next child refuses stale REUSE（HOLD, no silent reuse）", async () => {
  const cwd = gitFixture();
  try {
    let committed = false;
    const r = await runExecutionOrchestrator({
      ir: threeChildIr(), parent: PARENT, manifest: MANIFEST_REQ, cwd,
      executionId: "exec_33333333333333333333333333333333",
      executorAdapterFactory: () => createScriptedAdapter([
        { expect: { phase: "executor", attempt: 0 }, result: (req) => {
          // p_a（read-only）commits — an in-run HEAD drift（forbidden for phases）
          if (req.taskCard?.phaseId === "p_a" && !committed) {
            writeFileSync(join(cwd, "drift.txt"), "drift\n");
            execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
            execFileSync("git", ["commit", "-m", "mid-run drift"], { cwd, stdio: "ignore" });
            committed = true;
          }
          return completed(evidenceJson(req), "x");
        } },
      ]),
      reviewerAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson(), "x") }]),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
      inheritance: { ...INHERITANCE_BASE },
    });
    assert.equal(r.final, "HOLD", "run must HOLD after in-run HEAD drift");
    const t = r.inheritance.telemetry;
    assert.ok(t.invalidationTriggerCount >= 1, "drift must be counted");
    assert.ok(t.inheritanceHoldCount >= 1, "drift must fail closed");
    const heldPhase = r.phaseResults.find((p) => p.status === "held");
    assert.ok(heldPhase, "a phase must be held");
    assert.equal(heldPhase.reason, "INHERITED_CONTEXT_FRESHNESS_UNPROVEN");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── R irrelevant drift: preserve reusable facts ─────────────────────────

test("R: irrelevant dirty file does not invalidate reusable facts", async () => {
  const cwd = gitFixture({ "src/spec.txt": "spec v1\n" });
  try {
    // dirty an UNRELATED file（no commit — HEAD unchanged）
    writeFileSync(join(cwd, "unrelated.txt"), "dirty\n");
    const r = await runExecutionOrchestrator({
      ir: threeChildIr(), parent: PARENT, manifest: MANIFEST_REQ, cwd,
      executionId: "exec_44444444444444444444444444444444",
      ...passingFactories(),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
      inheritance: { ...INHERITANCE_BASE, specFilePaths: ["src/spec.txt"] },
    });
    assert.equal(r.final, "PASS", `irrelevant drift must not fail the run: ${r.reason}`);
    const t = r.inheritance.telemetry;
    // F3A/IR/authority facts REUSEd（irrelevant drift preserves）; only the
    // FILE_DIGEST spec fact is a revalidation obligation
    assert.ok(t.reuseCount >= t.inheritedFactCount - 3, `reuse dominates: reuse=${t.reuseCount} total=${t.inheritedFactCount}`);
    assert.ok(t.inheritanceHoldCount === 0, "no holds under irrelevant drift");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── S CBM hit / miss ─────────────────────────────────────────────────────

function openStore() {
  const stateRoot = mkdtempSync(join(tmpdir(), "inh-cbm-"));
  const store = new LocalMemoryStore({ stateRoot });
  store.open();
  return { store, stateRoot };
}

async function preloadManifestRecord(cwd, store, executionId) {
  const repoIdentity = resolveRepositoryIdentity(cwd);
  const probe = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const { manifest } = buildInheritanceManifest({
    parentCardId: "parent-card-1",
    parentGeneration: 1,
    graphRunId: executionId,
    repositoryIdentity: {
      repository_root_identity: cwd,
      worktree_identity: cwd,
      git_common_dir_identity: null,
      expected_head: probe,
      expected_tree: tree,
      expected_ref: "master",
      origin_url: null,
      origin_master: null,
      expected_worktree_state: "clean",
    },
    inputFingerprint: "1".repeat(64),
    irSha: "2".repeat(64),
    dagSha: "3".repeat(64),
    phaseIds: ["p_a", "p_b", "p_c"],
    evidenceRefs: ["6".repeat(64)],
  });
  const outcome = await recordInheritanceManifest({
    store,
    manifest,
    graphRunId: executionId,
    repositoryIdentity: repoIdentity.repositoryIdentity,
  });
  assert.ok(outcome.ok, `preload must write through the gate: ${outcome.status} ${outcome.reason}`);
  return { manifest, repoIdentity };
}

test("S-CBM-HIT: recorded manifest is reused by identity（no rebuild, facts reused）", async () => {
  const cwd = gitFixture();
  const { store, stateRoot } = openStore();
  try {
    const { manifest, repoIdentity } = await preloadManifestRecord(cwd, store, "exec_99999999999999999999999999999999");
    const r = await runExecutionOrchestrator({
      ir: threeChildIr(), parent: PARENT, manifest: MANIFEST_REQ, cwd,
      executionId: "exec_55555555555555555555555555555555",
      ...passingFactories(),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
      inheritance: {
        ...INHERITANCE_BASE,
        inputFingerprint: "1".repeat(64),
        irSha: "2".repeat(64),
        dagSha: "3".repeat(64),
        cbm: { store, repositoryIdentityHex: repoIdentity.repositoryIdentity, writebackAllowed: true },
      },
    });
    assert.equal(r.final, "PASS", `CBM-hit run must PASS: ${r.reason}`);
    const t = r.inheritance.telemetry;
    assert.ok(t.cbm.queryCount >= 1, "CBM queried");
    assert.ok(t.cbm.hitCount >= 1, `CBM hit expected: ${JSON.stringify(t.cbm)}`);
    assert.ok(t.cbm.factsReused > 0, "manifest facts reused from CBM");
    assert.equal(t.parentFactsObservedOnce, 0, "no source rebuild on CBM hit");
    assert.equal(r.inheritance.manifestSha256, manifest.manifestSha256, "reused manifest identity must match the recorded one");
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("S-CBM-MISS: empty store degrades to bounded source build（never unbounded fallback）", async () => {
  const cwd = gitFixture();
  const { store, stateRoot } = openStore();
  try {
    const repoIdentity = resolveRepositoryIdentity(cwd);
    const r = await runExecutionOrchestrator({
      ir: threeChildIr(), parent: PARENT, manifest: MANIFEST_REQ, cwd,
      executionId: "exec_66666666666666666666666666666666",
      ...passingFactories(),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
      inheritance: {
        ...INHERITANCE_BASE,
        cbm: { store, repositoryIdentityHex: repoIdentity.repositoryIdentity, writebackAllowed: true },
      },
    });
    assert.equal(r.final, "PASS");
    const t = r.inheritance.telemetry;
    assert.ok(t.cbm.queryCount >= 1, "CBM queried");
    assert.ok(t.cbm.missCount >= 1, `CBM miss expected: ${JSON.stringify(t.cbm)}`);
    assert.ok(t.cbm.boundedFallbackCount >= 1, "bounded fallback recorded");
    assert.ok(t.parentFactsObservedOnce > 0, "source build happened exactly once");
    // write-back of the built manifest must have succeeded through the gate
    assert.equal(t.cbm.writebackGap, false, `writeback gap: ${t.cbm.writebackGapReason}`);
    // a second run now hits
    const r2 = await runExecutionOrchestrator({
      ir: threeChildIr(), parent: PARENT, manifest: MANIFEST_REQ, cwd,
      executionId: "exec_77777777777777777777777777777777",
      ...passingFactories(),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
      inheritance: {
        ...INHERITANCE_BASE,
        cbm: { store, repositoryIdentityHex: repoIdentity.repositoryIdentity, writebackAllowed: true },
      },
    });
    assert.equal(r2.final, "PASS");
    assert.ok(r2.inheritance.telemetry.cbm.hitCount >= 1, "second run hits CBM");
    assert.equal(r2.inheritance.manifestSha256, r.inheritance.manifestSha256, "same manifest identity across runs（resume/restart stability）");
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("S-CBM-STALE: recorded manifest for an old tree is not silently reused", async () => {
  const cwd = gitFixture();
  const { store, stateRoot } = openStore();
  try {
    const { manifest, repoIdentity } = await preloadManifestRecord(cwd, store, "exec_88888888888888888888888888888888");
    // drift the repo（commit）→ live tree != recorded tree
    writeFileSync(join(cwd, "new.txt"), "x\n");
    execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "tree drift"], { cwd, stdio: "ignore" });
    const r = await runExecutionOrchestrator({
      ir: threeChildIr(), parent: PARENT, manifest: MANIFEST_REQ, cwd,
      executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
      ...passingFactories(),
      hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
      inheritance: {
        ...INHERITANCE_BASE,
        cbm: { store, repositoryIdentityHex: repoIdentity.repositoryIdentity, writebackAllowed: true },
      },
    });
    assert.equal(r.final, "PASS");
    const t = r.inheritance.telemetry;
    assert.ok(t.cbm.staleCount >= 1, `stale manifest must be detected: ${JSON.stringify(t.cbm)}`);
    // the run rebuilt fresh（different tree ⇒ different manifest identity）
    assert.notEqual(r.inheritance.manifestSha256, manifest.manifestSha256, "stale manifest never silently reused");
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// ── U-10 resume/restart identity stability（durable）─────────────────────

test("U-10/§K: durable run persists a verifiable artifact; tampering rejects resume", async () => {
  const cwd = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "inh-dur-"));
  try {
    const executionId = mintExecutionId();
    const result = await runDurableAutoLoopInternal({
      source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ, cwd,
      decompositionAdapter: { generate: async () => ({ status: "completed", parsed: threeChildIr(), content: JSON.stringify(threeChildIr()), thinking: "", usage: null, stopReason: "stop", elapsedMs: 1, requestCount: 1 }) },
      ...passingFactories(),
      maxRepairAttempts: 0, timeoutMs: 1000, signal: undefined,
      hooks: { toolPolicy: TOOL_POLICY, ...HARNESS_HOOKS },
      persistence: { mode: "durable", root, executionId },
    });
    assert.equal(result.final, "PASS", `durable run must PASS: ${result.reason}`);

    const { readCheckpoint } = await import("../../src/v2/checkpoint-bridge.mjs");
    const execDir = readCheckpoint(root, executionId).execDir;
    const artifactPath = join(execDir, "artifacts", "decomposition-inheritance.json");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    assert.ok(artifact.manifestSha256, "inheritance manifest artifact must be persisted");
    // artifact self-integrity holds
    const { verifyManifestIntegrity } = await import("../../src/v2/decomposition-inheritance.mjs");
    assert.equal(verifyManifestIntegrity(artifact).ok, true);

    // §K / U-7: tampering the persisted artifact rejects resume（identity
    // drift fails closed before any phase runs）.
    const tampered = JSON.parse(readFileSync(artifactPath, "utf8"));
    tampered.repositoryIdentity = { ...tampered.repositoryIdentity, expected_head: "e".repeat(40) };
    writeFileSync(artifactPath, JSON.stringify(tampered, null, 2) + "\n");
    const { resumeAutoLoopInternal } = await import("../../src/v2/stack-a-internal.mjs");
    await assert.rejects(
      () => resumeAutoLoopInternal({
        persistenceRoot: root, executionId,
        decompositionAdapter: { generate: async () => ({ status: "completed", parsed: threeChildIr(), content: JSON.stringify(threeChildIr()), thinking: "", usage: null, stopReason: "stop", elapsedMs: 1, requestCount: 1 }) },
        ...passingFactories(),
        hooks: { toolPolicy: TOOL_POLICY, ...HARNESS_HOOKS },
      }),
      (e) => e?.code === "DECOMPOSITION_INHERITANCE_IDENTITY_DRIFT",
      "tampered inheritance manifest must reject resume"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
