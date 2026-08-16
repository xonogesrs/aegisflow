// test/v2/test-decomposition-manifest.mjs
//
// I1 (AUTOLOOP-DECOMP-OPT1-IMPL1) — Decomposition Manifest tests.
//
// Frozen design authority: Issue #6 design inventory Section 8/8b/8c.
// Proof flags covered:
//   MANIFEST_SCHEMA_VALID       T1
//   CONTENT_ADDRESSING_VALID    T1
//   DETERMINISTIC_DIGEST        T2
//   EVIDENCE_PATH_BOUND         T3, T8
//   RESUME_BINDING_VERIFIED     T4
//   CORRUPTION_FAILS_CLOSED     T5, T6, T7
// Offline only（temp git worktree + temp evidence root; scripted adapters）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { runDurableAutoLoopInternal, resumeAutoLoopInternal } from "../../src/v2/stack-a-internal.mjs";
import { RunEvidenceStore, canonicalJson, sha256Text } from "../../src/evidence/run-evidence-store.mjs";
import { readCheckpoint } from "../../src/v2/checkpoint-bridge.mjs";
import { buildDecompositionManifest, buildPhaseTableDigests, DECOMPOSITION_MANIFEST_FORMAT } from "../../src/v2/decomposition-manifest.mjs";
import { computeSourceHashes } from "../../src/v2/durable-execution.mjs";
import { mintExecutionId } from "../../src/c2d/execution-id.mjs";

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "i1-manifest-"));
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
  const contractId = request?.taskCard?.executionId ?? FIXTURE_EVIDENCE.contract_id;
  return JSON.stringify({ ...FIXTURE_EVIDENCE, contract_id: contractId });
}
function verdictJson(overrides = {}) {
  return JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP", ...overrides });
}
function completed(stdout, executionId) {
  return { status: "completed", executionId, stdout, stderr: "", signal: null, error: null, metadata: { exitCode: 0 } };
}

const TOOL_POLICY = { mode: "no-tools" };
const HARNESS_HOOKS = {
  environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  verificationCommand: ["node", "-e", "process.exit(0)"],
  expectedExecutorModel: "deepseek-v4-flash",
  expectedExecutorProvider: "deepseek",
};

function manifestBuildInputs({ cwd, ir, executionId, chainId, inputFingerprint, configurationFingerprint }) {
  return {
    parentExecutionId: executionId,
    chainId,
    inputFingerprint,
    configurationFingerprint,
    ir,
    irSha: sha256Text(canonicalJson(ir)),
    dagSha: sha256Text(canonicalJson({ phase_ids: (ir.phases || []).map((p) => p.phase_id), depends_on: Object.fromEntries((ir.phases || []).map((p) => [p.phase_id, (p.depends_on || []).slice()])), execution_policy: ir.execution_policy ?? null })),
    repositoryIdentity: {
      repository_root_identity: cwd,
      expected_head: execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      tree: execFileSync("git", ["-C", cwd, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    },
    sourceHashes: computeSourceHashes(),
    promptBuilderVersion: "test-prompt-version",
  };
}

// ── T1: schema + content addressing ────────────────────────────────────
test("T1: manifest schema valid + content addressing (manifest_id == sha256(canonical payload))", () => {
  const cwd = gitFixture();
  try {
    const ir = twoPhaseIr();
    const inputs = manifestBuildInputs({ cwd, ir, executionId: "exec_0123456789abcdef0123456789abcdef", chainId: "chain_x", inputFingerprint: "inp_fp", configurationFingerprint: "cfg_fp" });
    const r = buildDecompositionManifest(inputs);
    assert.equal(r.ok, true);
    const m = r.manifest;
    assert.equal(m.format_version, DECOMPOSITION_MANIFEST_FORMAT);
    assert.equal(m.parent.execution_id, inputs.parentExecutionId);
    assert.equal(m.input_fingerprint, "inp_fp");
    assert.equal(m.configuration_fingerprint, "cfg_fp");
    assert.equal(m.decomposition.ir_sha256, inputs.irSha);
    assert.equal(m.decomposition.dag_sha256, inputs.dagSha);
    assert.equal(m.decomposition.prompt_builder_version, "test-prompt-version");
    assert.equal(m.decomposition.phase_count, 2);
    assert.equal(m.repository_identity.repository_root_identity, cwd);
    assert.ok(/^[0-9a-f]{40}$/.test(m.repository_identity.expected_head));
    assert.ok(/^[0-9a-f]{40}$/.test(m.repository_identity.tree));
    assert.equal(typeof m.source_hashes, "object");
    assert.ok(Object.keys(m.source_hashes).length > 0);
    assert.equal(m.phase_table.length, 2);
    assert.equal(m.phase_table[0].phase_id, "p_analysis");
    assert.ok(/^[0-9a-f]{64}$/.test(m.phase_table[0].digest));
    // content addressing: manifest_id == sha256 of the canonical payload
    const payloadOnly = { ...m };
    delete payloadOnly.manifest_id;
    delete payloadOnly.content_sha256;
    assert.equal(m.manifest_id, sha256Text(canonicalJson(payloadOnly)));
    assert.equal(m.content_sha256, m.manifest_id);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── T2: determinism ────────────────────────────────────────────────────
test("T2: deterministic digest — identical inputs identical digest; phase change changes digest", () => {
  const cwd = gitFixture();
  try {
    const ir = twoPhaseIr();
    const inputs = manifestBuildInputs({ cwd, ir, executionId: "exec_0123456789abcdef0123456789abcdef", chainId: "chain_x", inputFingerprint: "inp_fp", configurationFingerprint: "cfg_fp" });
    const a = buildDecompositionManifest(inputs);
    const b = buildDecompositionManifest({ ...inputs, sourceHashes: computeSourceHashes() });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.manifest_id, b.manifest_id);
    assert.equal(canonicalJson(a.payload), canonicalJson(b.payload));
    // phase order is part of the identity: reordering changes the digest
    const reordered = { ...ir, phases: [ir.phases[1], ir.phases[0]] };
    const c = buildDecompositionManifest({ ...inputs, ir: reordered, irSha: sha256Text(canonicalJson(reordered)) });
    assert.notEqual(c.manifest_id, a.manifest_id);
    // a changed phase changes exactly its digest and the manifest digest
    const changed = { ...ir, phases: [{ ...ir.phases[0], summary: "changed" }, ir.phases[1]] };
    const d = buildDecompositionManifest({ ...inputs, ir: changed, irSha: sha256Text(canonicalJson(changed)) });
    const dDigest0 = d.ok ? d.manifest.phase_table[0].digest : undefined;
    const aDigest0 = a.ok ? a.manifest.phase_table[0].digest : undefined;
    assert.notEqual(dDigest0, aDigest0);
    assert.equal(d.manifest.phase_table[1].digest, a.manifest.phase_table[1].digest);
    assert.notEqual(d.manifest_id, a.manifest_id);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── T3: durable run produces manifest through the evidence path ────────
test("T3: durable run writes manifest artifact + journal event + checkpoint pin (evidence path)", async () => {
  const cwd = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "i1-manifest-store-"));
  const executionId = mintExecutionId();
  try {
    const res = await runDurableAutoLoopInternal({
      source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ, cwd,
      decompositionAdapter: { generate: async () => ({ status: "completed", requestCount: 1, elapsedMs: 1, parsed: twoPhaseIr() }) },
      executorAdapterFactory: () => ({ runAdapter: async (request) => completed(evidenceJson(request), request.executionId) }),
      reviewerAdapterFactory: () => ({ runAdapter: async () => completed(verdictJson(), executionId) }),
      maxRepairAttempts: 0, timeoutMs: 60_000,
      hooks: { toolPolicy: TOOL_POLICY, ...HARNESS_HOOKS },
      persistence: { mode: "durable", root, executionId },
    });
    assert.equal(res.final, "PASS", `expected PASS, got ${res.final} ${res.reason}`);
    const execDir = res.evidence.exec_dir;
    // artifact exists through the evidence path
    const artifactPath = join(execDir, "artifacts", "decomposition-manifest.json");
    assert.equal(existsSync(artifactPath), true, "decomposition-manifest.json artifact missing");
    const manifest = JSON.parse(readFileSync(artifactPath, "utf8"));
    assert.equal(manifest.format_version, DECOMPOSITION_MANIFEST_FORMAT);
    assert.ok(/^[0-9a-f]{64}$/.test(manifest.manifest_id));
    // journal event present
    const journal = readdirSync(join(execDir, "journal")).filter((f) => f.endsWith(".json"));
    const events = journal.flatMap((f) => readFileSync(join(execDir, "journal", f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    assert.ok(events.some((e) => e.event_type === "DECOMPOSITION_MANIFEST_WRITTEN"), "DECOMPOSITION_MANIFEST_WRITTEN journal event missing");
    assert.ok(events.some((e) => e.event_type === "DECOMPOSITION_MANIFEST_WRITTEN" && e.payload?.manifest_sha256 === manifest.manifest_id));
    // checkpoint pins the manifest id
    const { snapshot } = readCheckpoint(root, executionId);
    assert.equal(snapshot.decomposition_manifest_sha256, manifest.manifest_id, "checkpoint does not pin manifest id");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── T4: resume re-verifies the manifest binding ────────────────────────
test("T4: resume of a completed run verifies recomputed == artifact == checkpoint (passes)", async () => {
  const cwd = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "i1-manifest-store-"));
  const executionId = mintExecutionId();
  const runHooks = { toolPolicy: TOOL_POLICY, ...HARNESS_HOOKS };
  try {
    const res = await runDurableAutoLoopInternal({
      source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ, cwd,
      decompositionAdapter: { generate: async () => ({ status: "completed", requestCount: 1, elapsedMs: 1, parsed: twoPhaseIr() }) },
      executorAdapterFactory: () => ({ runAdapter: async (request) => completed(evidenceJson(request), request.executionId) }),
      reviewerAdapterFactory: () => ({ runAdapter: async () => completed(verdictJson(), executionId) }),
      maxRepairAttempts: 0, timeoutMs: 60_000,
      hooks: runHooks,
      persistence: { mode: "durable", root, executionId },
    });
    assert.equal(res.final, "PASS");
    const resume = await resumeAutoLoopInternal({
      persistenceRoot: root, executionId,
      decompositionAdapter: { generate: async () => ({ status: "completed", requestCount: 1, elapsedMs: 1, parsed: twoPhaseIr() }) },
      executorAdapterFactory: () => ({ runAdapter: async (request) => completed(evidenceJson(request), request.executionId) }),
      reviewerAdapterFactory: () => ({ runAdapter: async () => completed(verdictJson(), executionId) }),
      hooks: runHooks,
    });
    assert.equal(resume.final, "PASS");
    assert.equal(resume.complete, true);
    assert.equal(resume.stage, "complete");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── T5: corrupted manifest artifact fails closed on resume ─────────────
test("T5: tampered manifest artifact fails closed on resume (RESUME_FINGERPRINT_MISMATCH)", async () => {
  const cwd = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "i1-manifest-store-"));
  const executionId = mintExecutionId();
  const runHooks = { toolPolicy: TOOL_POLICY, ...HARNESS_HOOKS };
  try {
    const res = await runDurableAutoLoopInternal({
      source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ, cwd,
      decompositionAdapter: { generate: async () => ({ status: "completed", requestCount: 1, elapsedMs: 1, parsed: twoPhaseIr() }) },
      executorAdapterFactory: () => ({ runAdapter: async (request) => completed(evidenceJson(request), request.executionId) }),
      reviewerAdapterFactory: () => ({ runAdapter: async () => completed(verdictJson(), executionId) }),
      maxRepairAttempts: 0, timeoutMs: 60_000,
      hooks: runHooks,
      persistence: { mode: "durable", root, executionId },
    });
    assert.equal(res.final, "PASS");
    // tamper: rewrite the manifest_id field to a different valid-looking digest
    const artifactPath = join(res.evidence.exec_dir, "artifacts", "decomposition-manifest.json");
    const manifest = JSON.parse(readFileSync(artifactPath, "utf8"));
    manifest.manifest_id = "f".repeat(64);
    writeFileSync(artifactPath, JSON.stringify(manifest), "utf8");
    await assert.rejects(
      resumeAutoLoopInternal({
        persistenceRoot: root, executionId,
        decompositionAdapter: { generate: async () => ({ status: "completed", requestCount: 1, elapsedMs: 1, parsed: twoPhaseIr() }) },
        executorAdapterFactory: () => ({ runAdapter: async (request) => completed(evidenceJson(request), request.executionId) }),
        reviewerAdapterFactory: () => ({ runAdapter: async () => completed(verdictJson(), executionId) }),
        hooks: runHooks,
      }),
      (e) => e?.code === "RESUME_FINGERPRINT_MISMATCH" && /decomposition manifest/.test(e?.message || ""),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── T6: stale binding (input fingerprint edited inside manifest) fails ─
test("T6: stale manifest binding fails closed on resume", async () => {
  const cwd = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "i1-manifest-store-"));
  const executionId = mintExecutionId();
  const runHooks = { toolPolicy: TOOL_POLICY, ...HARNESS_HOOKS };
  try {
    const res = await runDurableAutoLoopInternal({
      source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ, cwd,
      decompositionAdapter: { generate: async () => ({ status: "completed", requestCount: 1, elapsedMs: 1, parsed: twoPhaseIr() }) },
      executorAdapterFactory: () => ({ runAdapter: async (request) => completed(evidenceJson(request), request.executionId) }),
      reviewerAdapterFactory: () => ({ runAdapter: async () => completed(verdictJson(), executionId) }),
      maxRepairAttempts: 0, timeoutMs: 60_000,
      hooks: runHooks,
      persistence: { mode: "durable", root, executionId },
    });
    assert.equal(res.final, "PASS");
    // stale binding: change a payload binding field WITHOUT touching
    // manifest_id — recomputed digest must no longer match.
    const artifactPath = join(res.evidence.exec_dir, "artifacts", "decomposition-manifest.json");
    const manifest = JSON.parse(readFileSync(artifactPath, "utf8"));
    manifest.input_fingerprint = "stale-fingerprint";
    writeFileSync(artifactPath, JSON.stringify(manifest), "utf8");
    await assert.rejects(
      resumeAutoLoopInternal({
        persistenceRoot: root, executionId,
        decompositionAdapter: { generate: async () => ({ status: "completed", requestCount: 1, elapsedMs: 1, parsed: twoPhaseIr() }) },
        executorAdapterFactory: () => ({ runAdapter: async (request) => completed(evidenceJson(request), request.executionId) }),
        reviewerAdapterFactory: () => ({ runAdapter: async () => completed(verdictJson(), executionId) }),
        hooks: runHooks,
      }),
      (e) => e?.code === "RESUME_FINGERPRINT_MISMATCH" && /decomposition manifest/.test(e?.message || ""),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── T7: malformed artifact fails closed ────────────────────────────────
test("T7: malformed manifest artifact fails closed on resume", async () => {
  const cwd = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "i1-manifest-store-"));
  const executionId = mintExecutionId();
  const runHooks = { toolPolicy: TOOL_POLICY, ...HARNESS_HOOKS };
  try {
    const res = await runDurableAutoLoopInternal({
      source: SOURCE, parent: PARENT, manifest: MANIFEST_REQ, cwd,
      decompositionAdapter: { generate: async () => ({ status: "completed", requestCount: 1, elapsedMs: 1, parsed: twoPhaseIr() }) },
      executorAdapterFactory: () => ({ runAdapter: async (request) => completed(evidenceJson(request), request.executionId) }),
      reviewerAdapterFactory: () => ({ runAdapter: async () => completed(verdictJson(), executionId) }),
      maxRepairAttempts: 0, timeoutMs: 60_000,
      hooks: runHooks,
      persistence: { mode: "durable", root, executionId },
    });
    assert.equal(res.final, "PASS");
    const artifactPath = join(res.evidence.exec_dir, "artifacts", "decomposition-manifest.json");
    writeFileSync(artifactPath, "{ not valid json", "utf8");
    await assert.rejects(
      resumeAutoLoopInternal({
        persistenceRoot: root, executionId,
        decompositionAdapter: { generate: async () => ({ status: "completed", requestCount: 1, elapsedMs: 1, parsed: twoPhaseIr() }) },
        executorAdapterFactory: () => ({ runAdapter: async (request) => completed(evidenceJson(request), request.executionId) }),
        reviewerAdapterFactory: () => ({ runAdapter: async () => completed(verdictJson(), executionId) }),
        hooks: runHooks,
      }),
      (e) => e?.code === "RESUME_FINGERPRINT_MISMATCH" && /decomposition manifest/.test(e?.message || ""),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ── T8: evidence path secret scan is fail-closed for artifacts ─────────
test("T8: manifest write path is secret-scanned (evidence path fail-closed)", async () => {
  const cwd = gitFixture();
  const root = mkdtempSync(join(tmpdir(), "i1-manifest-store-"));
  const executionId = mintExecutionId();
  try {
    const store = new RunEvidenceStore({ root, executionId, chainId: "chain_x", checkpointId: "ckpt_x", repoRoot: cwd });
    store.init();
    assert.throws(() => store.writeArtifact("secret-test.json", { token: "ghp_0123456789abcdef0123456789abcdef" }), (e) => e?.code === "DURABLE_EVIDENCE_SECRET_RISK" || /secret/i.test(String(e?.message || e)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
