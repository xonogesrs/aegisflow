// test/v2/test-checkpoint-bridge.mjs
//
// C3 — checkpoint bridge tests over the sealed C2D checkpoint store.
// Offline only（temp git worktree + temp evidence root）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { publishCheckpoint, readCheckpoint, buildInputFingerprint, buildConfigurationFingerprint, buildDagFingerprint, buildIrSha256, validateRunIdentity, collectRepositoryFingerprint, deriveChainId, deriveCheckpointId } from "../../src/v2/checkpoint-bridge.mjs";
import { buildCheckpointSnapshot } from "../../src/v2/checkpoint-bridge.mjs";
import { resolveExecDir, publishCurrent, currentPath } from "../../src/c2d/checkpoint-store.mjs";
import { acquireLease, releaseLease } from "../../src/c2d/lease.mjs";
import { mintExecutionId } from "../../src/c2d/execution-id.mjs";
import { resolveSafeRoot } from "../../src/c2d/fs-atomic.mjs";

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "c3-bridge-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

const IR = {
  verdict: "DECOMPOSED",
  parent_goal: "g",
  execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
  phases: [
    {
      phase_id: "p1", title: "t", summary: "s", responsibility: "r", purpose: "analysis",
      effects: {
        artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
        evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
      },
      covers: [{ requirement_id: "R1", completeness: "complete", claim: "c" }],
      depends_on: [],
    },
  ],
  dispositions: [],
  decomposition_evidence: ["e"],
};
const SOURCE = { goal: "g", requirements: [{ requirement_id: "R1", text: "t" }], authority: {} };
const PARENT = { scope: { allowed_paths: [], forbidden_paths: [] } };
const MANIFEST = [{ requirement_id: "R1", text: "t" }];

async function publishBase({ root, repo, executionId, overrides = null }) {
  const identity = validateRunIdentity(executionId);
  const repoFp = collectRepositoryFingerprint(repo);
  return publishCheckpoint({
    root, executionId, chainId: identity.chainId, checkpointId: identity.checkpointId,
    repositoryFingerprint: repoFp,
    inputFingerprint: buildInputFingerprint({ source: SOURCE, parent: PARENT, manifest: MANIFEST }),
    configurationFingerprint: buildConfigurationFingerprint({
      maxRepairAttempts: 0, timeoutMs: 1000, toolPolicy: null, environmentAllowlist: null,
      expectedReviewerModel: null, runtime: { node: "v0" }, sourceHashes: { a: "a" },
      decompositionAdapterConfigHash: null, executorAdapterPolicyHash: null, reviewerAdapterPolicyHash: null,
      persistenceFormatVersion: "1.0.0",
    }),
    irSha: buildIrSha256(IR), dagSha: buildDagFingerprint(IR),
    journalHead: { seq: 0, sha256: "genesis" },
    phaseStates: {}, phaseAttempts: {}, phaseResultHashes: {},
    completedPhaseIds: [], activePhase: null, activeLifecycleStage: null,
    writerPhaseActive: false, writerLeaseHolder: null, finalVerdict: null,
    resumePolicy: { safe_boundary: true, interrupted_writer: false },
    expectedRevision: 0, created_at: new Date().toISOString(),
    snapshotOverrides: overrides,
  });
}

test("8: CURRENT.json checksum tamper is detected", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-ck-root-"));
  const repo = gitFixture();
  try {
    const executionId = mintExecutionId();
    await publishBase({ root, repo, executionId });
    const execDir = resolveExecDir(resolveSafeRoot(root), executionId);
    const cur = readFileSync(currentPath(execDir), "utf8");
    writeFileSync(currentPath(execDir), cur.replace('"revision": 1', '"revision": 99'), "utf8");
    assert.throws(() => readCheckpoint(root, executionId), (e) => /SNAPSHOT_CHECKSUM_MISMATCH/.test(e.code || ""));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("9: CAS stale revision is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-cas-"));
  const repo = gitFixture();
  try {
    const executionId = mintExecutionId();
    const first = await publishBase({ root, repo, executionId });
    assert.equal(first.revision, 1);
    // Second publish with the same expectedRevision → stale CAS.
    await assert.rejects(
      () => publishBase({ root, repo, executionId }),
      (e) => /CHECKPOINT_STALE_REVISION/.test(e.code || ""),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("10: publishing without a write permit is rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-perm-"));
  const repo = gitFixture();
  try {
    const executionId = mintExecutionId();
    const identity = validateRunIdentity(executionId);
    const repoFp = collectRepositoryFingerprint(repo);
    const execDir = resolveExecDir(resolveSafeRoot(root), executionId);
    const snapshot = buildCheckpointSnapshot({
      executionId, chainId: identity.chainId, checkpointId: identity.checkpointId, revision: 1,
      created_at: new Date().toISOString(), repositoryFingerprint: repoFp,
      inputFingerprint: "i", configurationFingerprint: "c", irSha: "d", dagSha: "e",
      journalHead: { seq: 0, sha256: "genesis" }, phaseStates: {}, phaseAttempts: {}, phaseResultHashes: {},
      completedPhaseIds: [], activePhase: null, activeLifecycleStage: null,
      writerPhaseActive: false, writerLeaseHolder: null, finalVerdict: null,
      resumePolicy: { safe_boundary: true, interrupted_writer: false },
    });
    assert.throws(
      () => publishCurrent(execDir, snapshot, { expectedRevision: 0 }),
      (e) => /WRITE_PERMIT_REQUIRED/.test(e.code || ""),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("11: input fingerprint is stable for identical input, differs on change", () => {
  const a = buildInputFingerprint({ source: SOURCE, parent: PARENT, manifest: MANIFEST });
  const b = buildInputFingerprint({ source: SOURCE, parent: PARENT, manifest: MANIFEST });
  const c = buildInputFingerprint({ source: SOURCE, parent: PARENT, manifest: [{ requirement_id: "R2", text: "x" }] });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("35: concurrent checkpoint writer — an active lease blocks a second publisher", async () => {
  const root = mkdtempSync(join(tmpdir(), "c3-lease-"));
  const repo = gitFixture();
  try {
    const executionId = mintExecutionId();
    const identity = validateRunIdentity(executionId);
    const repoFp = collectRepositoryFingerprint(repo);
    // First process holds the lease.
    const execDir = resolveExecDir(resolveSafeRoot(root), executionId);
    const held = acquireLease(execDir, {
      execution_id: executionId, chain_id: identity.chainId, checkpoint_id: identity.checkpointId,
      repository_identity: repoFp.repository_root_identity, worktree_identity: repoFp.worktree_identity,
      actor_id: "other-process", expected_head: repoFp.expected_head, mutation_capability: false,
    });
    // Second process attempts to publish → must fail closed（single owner）.
    await assert.rejects(
      () => publishBase({ root, repo, executionId }),
      (e) => /RESUME_LEASE_CONFLICT/.test(e.code || ""),
    );
    // Release the held lease and try again → succeeds.
    releaseLease(execDir, held.lease.lease_id, held.lease.lease_revision, held.secrets);
    const ok = await publishBase({ root, repo, executionId });
    assert.equal(ok.revision, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
