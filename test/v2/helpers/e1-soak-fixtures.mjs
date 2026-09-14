// test/v2/helpers/e1-soak-fixtures.mjs
//
// E1 HUMAN MUTATION SOAK — fixture/runtime-support helper (recovery lineage).
// RECOVERY_LINEAGE: E1_SOAK_HELPER_RECOVERY_V1
// RELATION_TO_ORIGINAL: BEHAVIORAL_REIMPLEMENTATION_FROM_FROZEN_SURFACE_AND_CONSUMER_EVIDENCE
// BYTE_EQUIVALENCE_TO_ORIGINAL: NOT CLAIMED (original bytes 4ec96aca… unrecoverable,
//   Phase-1 closed). This module replaces the lost helper as a NEW lineage and
//   satisfies the frozen 37-name export surface + the sealed consumers' behavior.
//
// Authority boundaries (mirrors the sealed IMPLEMENTATION-BOUNDARY):
//   * Every production semantic is CONSUMED, never re-implemented: HOLD codes,
//     C2dHoldError, journal/lease/permit/checkpoint machinery, the durable
//     graph state machine, the fold gate, the reconcile paths. No second copy
//     of any sealed decision lives here.
//   * C2dHoldError/HOLD are RE-EXPORTS of the sealed src/c2d/fs-atomic.mjs —
//     never redefinitions (oracle gate).
//   * Fixture boots drive the REAL publication chain exactly like
//     test/v2/test-durable-graph.mjs: DurableGraphRun + RunEvidenceStore +
//     run.checkpoint() → checksummed CURRENT. No hand-built snapshots.
//   * Fixtures build honest durable states inside disposable OS-temp
//     namespaces. No sleep-based timing anywhere: placement is proven by
//     durable markers (journal rows / CURRENT fields). Every spawned helper
//     PID is collectable for the zero-orphan attestation.
//
// Export surface = EXACT frozen 37-name union of the two sealed consumers
// (verified by tmp/E1-SOAK-RECOVERY/artifacts/export-surface-oracle.mjs).

import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync as fsMkdtempSync, rmSync, writeFileSync, readFileSync,
  existsSync, copyFileSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

// ── Sealed production primitives (re-exported verbatim; never re-implemented)
import { C2dHoldError, HOLD } from "../../../src/c2d/fs-atomic.mjs";
import { C3B_HOLD, createMutationAuthorization } from "../../../src/c2d/mutation-authority.mjs";
import { RunEvidenceStore } from "../../../src/evidence/run-evidence-store.mjs";
import { readCheckpoint, validateRunIdentity, collectRepositoryFingerprint, collectRepositoryTree } from "../../../src/v2/checkpoint-bridge.mjs";
import { readCurrent, initExecutionDir, publishCurrent, createInitialSnapshot } from "../../../src/c2d/checkpoint-store.mjs";
import { validateContinuity, publishIntent, publishComplete, readIntent, journalDir } from "../../../src/c2d/journal.mjs";
import { readLease, acquireLease, releaseLease } from "../../../src/c2d/lease.mjs";
import { permitFromLease } from "../../../src/c2d/permit.mjs";
import { reconcileMutationIntent } from "../../../src/c2d/reconcile.mjs";
import { runMutation } from "../../../src/c2d/mutation-run.mjs";
import { runReadOnlyDiscovery } from "../../../src/c2d/read-only-discovery-run.mjs";
import {
  runDurableGraph, resumeDurableGraph, childResultFoldGate,
  classifyInterruptedWriter, DurableGraphRun, captureWorktreeDirtyState,
} from "../../../src/v2/durable-graph.mjs";
import {
  buildIrSha256, buildDagFingerprint, buildInputFingerprint,
} from "../../../src/v2/checkpoint-bridge.mjs";
import { buildDecompositionManifest } from "../../../src/v2/decomposition-manifest.mjs";
import { computeSourceHashes } from "../../../src/v2/durable-execution.mjs";
import { canonicalJson, sha256Text } from "../../../src/evidence/run-evidence-store.mjs";
import {
  prepareOwnedScratchRoot, getScratchAuthorityToken,
} from "../../../src/runtime/scratch-ownership.mjs";
import { buildAdmissionRecord } from "../../../src/admission/policy-projection.mjs";
import { validateAdmission, deriveAdmissionId } from "../../../src/admission/admission-record.mjs";
import { classify } from "../../../src/admission/classify.mjs";
import { writeIsolatedShim as shimWriteIsolatedShim, runtimeShimHooks as shimRuntimeShimHooks } from "./e1-runtime-shim.mjs";
import { mintExecutionId, mintChainId, mintCheckpointId } from "../../../src/c2d/execution-id.mjs";

// ── Frozen consumer-convenience re-exports (identity pass-through) ──────────
export {
  C2dHoldError, HOLD, C3B_HOLD, RunEvidenceStore, readCheckpoint, readCurrent,
  validateContinuity, readLease, acquireLease, reconcileMutationIntent, runMutation,
  childResultFoldGate, mkdtempSync, tmpdir, join, rmSync, writeFileSync, readFileSync,
  existsSync, copyFileSync, symlinkSync,
};

function mkdtempSync(prefix) { return fsMkdtempSync(prefix); }

// ═══════════════════════ Small shared helpers ═══════════════════════════════

/** sha256 hex over Buffer|string (fixture shorthand, mirrors sealed sha256Hex). */
function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Git runner over a concrete repo dir: {status, stdout, stderr}; never throws
 * (consumers assert on status/stderr fields of external git operations).
 */
export function git(repo, args, opts = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", ...opts });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Digest of a file's bytes (evidence pre/post captures, contract §1.6/1.7). */
export function fileDigest(path) {
  return sha256Hex(readFileSync(path));
}

/**
 * Journal row scan over a RunEvidenceStore (the sealed verifier's own event
 * list). Returns rows [{sequence, event_type, phase_id, payload}] ascending,
 * filtered by types. Only the store form is supported: every E1 fixture owns
 * its store, and a disk-reconstruction second reader would be a second
 * authority over the same journal.
 */
export function journalRows(storeOrExecDir, types = null) {
  if (!storeOrExecDir || typeof storeOrExecDir.verifyJournal !== "function") {
    throw new TypeError("journalRows: pass the fixture's RunEvidenceStore");
  }
  const j = storeOrExecDir.verifyJournal();
  const rows = [];
  for (let s = 1; s <= j.count; s++) {
    const { event } = storeOrExecDir.readEvent(s);
    rows.push(event);
  }
  const filtered = types ? rows.filter((r) => types.includes(r.event_type)) : rows;
  return filtered.map((r) => ({
    sequence: r.sequence, event_type: r.event_type, phase_id: r.phase_id ?? null,
    payload: r.payload ?? null,
  }));
}

/**
 * Honest admission record: classification + buildAdmissionRecord + id
 * derivation, validated through the sealed validator. Never hand-shaped.
 */
export function makeAdmission(taskId = "e1-soak") {
  const record = buildAdmissionRecord({ taskId, classification: classify({}) });
  record.admission_id = deriveAdmissionId(record);
  const v = validateAdmission(record);
  if (!v.ok) throw new C2dHoldError(HOLD.INVALID_EXECUTION_ID, `admission invalid: ${v.errors.join(",")}`);
  return record;
}

/**
 * THE per-attempt resume oracle (sealed decision 2): the observation window
 * starts at the pre-attempt journal head, so a later attempt can never
 * observe an earlier leg's rejection rows. Returns the consumer-contract
 * shape: { result, thrown, resumeRejected, resumeValidated, revisionUnchanged }.
 */
export async function captureResumeVerdict(fixture, opts = {}) {
  const store = fixture.store ?? null;
  // Pre-attempt head is read from DISK (verifyJournal re-scans): resume legs
  // append through their own store instances, so a cached instance head
  // would leak an earlier leg's rejection rows into this window.
  const pre = store ? store.verifyJournal().count : 0;
  const preRevision = (() => {
    try { return readCurrent(fixture.execDir)?.snapshot.revision ?? null; } catch { return null; }
  })();
  let thrown = null;
  let result = null;
  try {
    result = await resumeDurableGraph({
      persistenceRoot: fixture.root,
      executionId: fixture.executionId,
      ir: opts.ir ?? fixture.ir ?? null,
      parent: { scope: {} },
      manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: fixture.repo,
      repoPath: fixture.repo,
      scratchRoot: fixture.scratch,
      maxRepairAttempts: 1,
      timeoutMs: 60000,
      signal: undefined,
      hooks: {},
      dirtyScope: opts.dirtyScope ?? fixture.dirtyScope ?? [],
      admission: opts.admission ?? fixture.admission ?? null,
    });
  } catch (e) { thrown = e; }
  const inWindow = (r) => r.sequence > pre;
  const rows = store ? journalRows(store).filter(inWindow) : [];
  const rejected = rows.find((r) => r.event_type === "RESUME_REJECTED");
  const validated = rows.find((r) => r.event_type === "RESUME_VALIDATED");
  const postRevision = (() => {
    try { return readCurrent(fixture.execDir)?.snapshot.revision ?? null; } catch { return null; }
  })();
  return {
    result,
    thrown,
    resumeRejected: rejected ? { code: rejected.payload?.code ?? null, payload: rejected.payload ?? {} } : null,
    resumeValidated: validated != null,
    revisionUnchanged: postRevision === preRevision,
    newRows: rows,
  };
}

/** resumeFixture: the RAW resume entry (returns the result; HOLD-class failures THROW). */
export async function resumeFixture(fixture, opts = {}) {
  return resumeDurableGraph({
    persistenceRoot: fixture.root,
    executionId: fixture.executionId,
    ir: opts.ir ?? fixture.ir ?? null,
    parent: { scope: {} },
    manifest: [{ requirement_id: "r1", text: "x" }],
    cwd: fixture.repo,
    repoPath: fixture.repo,
    scratchRoot: fixture.scratch,
    maxRepairAttempts: 1,
    timeoutMs: 60000,
    signal: undefined,
    hooks: {},
    dirtyScope: opts.dirtyScope ?? fixture.dirtyScope ?? [],
    admission: opts.admission ?? fixture.admission ?? null,
  });
}

// ═══════════════════════ Independent external actor ═════════════════════════

const EXTERNAL_ACTOR_PAYLOAD = `
const { spawnSync, execFileSync } = require("node:child_process");
const { writeFileSync, readFileSync, symlinkSync, mkdirSync, appendFileSync, existsSync, copyFileSync, rmSync } = require("node:fs");
const { join, dirname } = require("node:path");
function arg(name) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : null; }
const ops = JSON.parse(readFileSync(arg("ops"), "utf8"));
let executed = 0;
for (const op of ops) {
  if (op.op === "write") { mkdirSync(dirname(op.path), { recursive: true }); writeFileSync(op.path, op.bytes); executed++; }
  else if (op.op === "append") { mkdirSync(dirname(op.path), { recursive: true }); appendFileSync(op.path, op.bytes); executed++; }
  else if (op.op === "delete" || op.op === "rm") { rmSync(op.path, { force: true, recursive: true }); executed++; }
  else if (op.op === "copy") { copyFileSync(op.from, op.to); executed++; }
  else if (op.op === "symlink") { if (!existsSync(op.path)) symlinkSync(op.target, op.path, "dir"); executed++; }
  else if (op.op === "git") { execFileSync("git", ["-C", op.repo, ...(op.args || [])], { stdio: "ignore" }); executed++; }
}
writeFileSync(arg("ack"), JSON.stringify({ executed, at: new Date().toISOString() }));
process.exit(0);
`;

/**
 * INDEPENDENT external mutation actor (SOAK-TEST-CONTRACT §1.2/§1.3): a
 * spawned node child that owns NO executor references applies the ops and
 * acks via a durable file. Returns the child's pid + ack. No sleeps: the
 * ack file IS the placement marker.
 */
export function externalMutate({ ops, ackDir, tag }) {
  const opsPath = join(ackDir, `ops-${tag}.json`);
  const ackPath = join(ackDir, `ack-${tag}.json`);
  writeFileSync(opsPath, JSON.stringify(ops));
  const payloadPath = join(ackDir, `actor-${tag}.cjs`);
  writeFileSync(payloadPath, EXTERNAL_ACTOR_PAYLOAD);
  const child = spawn(process.execPath, [payloadPath, "--ops", opsPath, "--ack", ackPath], {
    stdio: ["ignore", "ignore", "pipe"], env: { ...process.env },
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`external actor failed (${code}): ${stderr.slice(0, 400)}`));
      if (!existsSync(ackPath)) return reject(new Error("external actor ack missing"));
      resolve({ pid: child.pid, code, ackPath, ack: JSON.parse(readFileSync(ackPath, "utf8")) });
    });
    child.on("error", reject);
  });
}

/** Zero-orphan attestation (§1.9): kill(pid,0) liveness over recorded pids. */
export function cleanupAttestation(pids) {
  const survivors = [];
  for (const pid of pids) {
    try { process.kill(pid, 0); survivors.push(pid); } catch { /* gone: good */ }
  }
  return { orphanCount: survivors.length, survivors };
}

// ═══════════════════════ Graph fixture boots ════════════════════════════════

/**
 * The shared graph boot — the REAL publication chain exactly as
 * test/v2/test-durable-graph.mjs drives it: DurableGraphRun + RunEvidenceStore
 * + owned scratch + decomposition manifest + checksummed checkpoints.
 * Returns the pieces every graph fixture shape is built from.
 */
async function bootGraphRun({ label, tag, ir, admission = null, dirtyScope = [], dirtySeed = null }) {
  const repo = makeTempGitRepo(label);
  if (dirtySeed) {
    const seedPath = join(repo, dirtySeed, "seed.txt");
    await import("node:fs").then((fs) => fs.mkdirSync(join(repo, dirtySeed), { recursive: true }));
    writeFileSync(seedPath, `seed ${tag ?? label}\n`);
  }
  const root = freshEvidenceRoot(label);
  const scratch = fsMkdtempSync(join(tmpdir(), `e1-${label}-scratch-`));
  const executionId = mintExecutionId();
  const run = new DurableGraphRun({
    ir, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
    cwd: repo, repoPath: repo, scratchRoot: scratch,
    maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
    persistence: { root, executionId },
    dirtyScope, admission,
  });
  const store = new RunEvidenceStore({ root, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
  const execDir = store.init();
  run.execDir = execDir;
  run.store = store;
  run.root = root;

  run.repoFingerprint = collectRepositoryFingerprint(repo);
  const dirtyState = captureWorktreeDirtyState(repo, dirtyScope);
  run.state.permittedDirtyDigest = dirtyState.filteredDigest;
  const frozenInput = { source: null, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }], repoPath: repo, scratchRoot: scratch };
  store.writeArtifact("input.json", frozenInput);
  if (admission) store.writeArtifact("admission.json", admission);
  run.inputFingerprint = run._graphInputFingerprint();
  run.configurationFingerprint = run._configurationFingerprint();

  store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
  await run.checkpoint({});
  store.appendEvent({ event_type: "GRAPH_INPUT_FROZEN", stage: "input", payload: { input_fingerprint: run.inputFingerprint } });
  await run.checkpoint({});

  store.writeArtifact("decomposition-ir.json", ir);
  run.irSha = buildIrSha256(ir);
  run.dagSha = buildDagFingerprint(ir);
  run.state.phaseStates = Object.fromEntries(ir.phases.map((p) => [p.phase_id, "pending"]));
  store.appendEvent({
    event_type: "DAG_ACCEPTED", stage: "decomposition",
    payload: { phase_count: ir.phases.length, ir_sha256: run.irSha, dag_sha256: run.dagSha },
  });
  await run.checkpoint({});

  // I1: decomposition manifest — same construction the production entry runs
  // (fail-closed bindings); the resume path re-derives it from durable bytes.
  const manifestResult = buildDecompositionManifest({
    parentExecutionId: run.executionId,
    chainId: run.chainId,
    parentRevision: sha256Text(canonicalJson({ scope: {} })),
    inputFingerprint: run.inputFingerprint,
    configurationFingerprint: run.configurationFingerprint,
    ir,
    irSha: run.irSha,
    dagSha: run.dagSha,
    repositoryIdentity: {
      repository_root_identity: run.repoFingerprint.repository_root_identity,
      expected_head: run.repoFingerprint.expected_head,
      tree: collectRepositoryTree(repo),
    },
    sourceHashes: computeSourceHashes(),
    promptBuilderVersion: "graph-input-ir",
  });
  if (!manifestResult.ok) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, `fixture decomposition manifest invalid: ${manifestResult.code}`);
  }
  store.writeArtifact("decomposition-manifest.json", manifestResult.manifest);
  run.decompositionManifestId = manifestResult.manifest_id;
  store.appendEvent({
    event_type: "DECOMPOSITION_MANIFEST_WRITTEN", stage: "decomposition",
    payload: { manifest_sha256: manifestResult.manifest_id, bytes: manifestResult.bytes },
  });
  await run.checkpoint({});

  // Owned scratch namespace + its durable authority artifact (the resume path
  // requires both: scratch-ownership.json must carry the authority token).
  const ownedScratchRoot = prepareOwnedScratchRoot({ scratchRoot: scratch, executionId: run.executionId, repoPath: repo });
  const authorityToken = getScratchAuthorityToken(ownedScratchRoot);
  store.writeArtifact("scratch-ownership.json", { schema: "autoloop.scratch-authority/v1", authorityToken });

  return { repo, root, scratch, execDir, store, run, executionId, ir, dirtyScope, admission };
}

function baseCleanup(parts) {
  return () => {
    for (const p of parts) { try { rmSync(p, { recursive: true, force: true }); } catch { /* tmp */ } }
  };
}

/** Real temp git repo (clean, branch master, one initial commit). */
function makeTempGitRepo(label) {
  const repo = fsMkdtempSync(join(tmpdir(), `e1-${label}-repo-`));
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.email", "e1@fixture"]);
  git(repo, ["config", "user.name", "e1-fixture"]);
  writeFileSync(join(repo, "README.md"), "# e1 fixture\n");
  writeFileSync(join(repo, "base.txt"), "base\n");
  writeFileSync(join(repo, "human.txt"), "fixture baseline\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

function freshEvidenceRoot(label) {
  return fsMkdtempSync(join(tmpdir(), `e1-${label}-root-`));
}

function fixtureFrom(fx, { checkpoint = true } = {}) {
  return {
    tag: fx.tag ?? null,
    repo: fx.repo, root: fx.root, scratch: fx.scratch,
    checkpointRoot: fx.root, execDir: fx.execDir,
    store: fx.store, run: fx.run, ir: fx.ir, executionId: fx.executionId,
    admission: fx.admission ?? null,
    dirtyScope: fx.dirtyScope ?? [],
    frozenHead: git(fx.repo, ["rev-parse", "HEAD"]).stdout.trim(),
    ...(checkpoint ? { checkpoint: readCheckpoint(fx.root, fx.executionId) } : {}),
    cleanup: baseCleanup([fx.repo, fx.root, fx.scratch]),
  };
}

/**
 * The base graph fixture: durable graph machinery over a real clean repo,
 * checkpoints published through the real chain, run non-terminal, no dirty
 * seed. Consumers use it for fold-gate / evidence-root / C2D probes that
 * drive run.buildGraphHooks / run._onRunnerView / run.checkpoint directly.
 */
export async function makeGraphStoreFixture({ tag } = {}) {
  const ir = buildIR();
  const fx = await bootGraphRun({ label: `graph-${tag ?? "x"}`, tag, ir });
  return fixtureFrom(fx);
}

/**
 * W4-shaped non-terminal production run: checkpoint published (rev>0), run
 * non-terminal (final_verdict=null), R1 active mid-flight (PHASE_READY +
 * PHASE_STARTED + the boundary checkpoint all landed through the real hooks).
 * Optional frozen admission rides the boot and the artifact directory.
 */
export async function makeNonTerminalRunFixture({ tag, admission = null } = {}) {
  const ir = buildIR();
  const fx = await bootGraphRun({ label: `nonterm-${tag ?? "x"}`, tag, ir, admission });
  const hooks = fx.run.buildGraphHooks(ir);
  await hooks.onPhaseStart({ phaseId: "R1" });
  const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
  if (snap.final_verdict !== null) throw new Error("non-terminal fixture published a verdict");
  if (!(snap.revision > 0)) throw new Error("non-terminal fixture has no checkpoint");
  if (snap.active_phase !== "R1") throw new Error("non-terminal fixture: R1 not active");
  return fixtureFrom(fx);
}

/**
 * Terminal PASS production run: the real state machine drives R1 to a pinned
 * PASS (journal + hash-pinned result artifact + checkpoint) and publishes the
 * terminal verdict through run.terminal — no synthesized terminal state.
 * With dirtyScope + dirtySeed, the frozen checkpoint carries the scope-
 * confined permitted_dirty_digest and a dirty expected_worktree_state.
 */
export async function makeProductionRunFixture({ tag, admission = null, dirtyScope = [], dirtySeed = null } = {}) {
  const ir = buildIR();
  const fx = await bootGraphRun({ label: `prod-${tag ?? "x"}`, tag, ir, admission, dirtyScope, dirtySeed });
  const hooks = fx.run.buildGraphHooks(ir);
  await hooks.onPhaseStart({ phaseId: "R1" });
  await fx.run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
  await fx.run.terminal("PASS", null);
  const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
  if (snap.final_verdict !== "PASS") throw new Error("production fixture failed to publish PASS");
  if (!existsSync(join(fx.execDir, "artifacts", "input.json"))) throw new Error("production fixture missing input.json");
  if (!existsSync(join(fx.execDir, "artifacts", "decomposition-ir.json"))) throw new Error("production fixture missing decomposition-ir.json");
  return fixtureFrom(fx);
}

/** Terminal PASS run (C14/xc14 shape): resume short-circuits at stage complete. */
export async function makeTerminalPassFixture({ tag } = {}) {
  return makeProductionRunFixture({ tag });
}

function buildIR() {
  const phase = (phaseId, dependsOn = []) => ({
    phase_id: phaseId, title: `t-${phaseId}`, summary: "s", responsibility: "r", purpose: "analysis",
    effects: {
      artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
      evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
    },
    covers: [{ requirement_id: "R1", completeness: "complete", claim: "c" }],
    depends_on: dependsOn,
  });
  return {
    verdict: "DECOMPOSED",
    parent_goal: "g",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [phase("R1"), phase("R2", ["R1"])],
    dispositions: [],
    decomposition_evidence: ["e"],
  };
}

// ═══════════════════════ C2D open-tail fixture ═══════════════════════════════

/**
 * C2D open-tail construction (C11/C12/C15/C16 shape), built only from sealed
 * production primitives: one closed read_only transition (rev1) plus one OPEN
 * intent (rev2, class selected for the consumer: mutation for c15, read_only
 * otherwise), an ACTIVE owner lease whose secrets are returned to the caller,
 * over a real clean git repo containing the discovery input file.
 */
export function makeOpenTailC2DFixture({ tag, sideEffectClass } = {}) {
  const tailClass = sideEffectClass ?? (tag === "c15" ? "mutation" : "read_only");
  const repo = makeTempGitRepo(`tail-${tag ?? "x"}`);
  writeFileSync(join(repo, "a.txt"), "discovery input\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "discovery input"]);
  const root = freshEvidenceRoot(`tail-${tag ?? "x"}`);
  const execId = mintExecutionId();
  const execDir = initExecutionDir(root, execId);
  const actorId = `owner-${tag ?? "x"}`;
  const sessionId = `sess-${actorId}`;
  const sessionSecret = `${tag ?? "x"}-session-secret`;
  const leaseSecret = `${tag ?? "x"}-lease-secret`;

  const fp = collectRepositoryFingerprint(repo);
  const exec = acquireLease(execDir, {
    execution_id: execId,
    chain_id: mintChainId(),
    checkpoint_id: mintCheckpointId(),
    repository_identity: fp.repository_root_identity,
    worktree_identity: fp.worktree_identity,
    actor_id: actorId,
    session_id: sessionId,
    session_secret: sessionSecret,
    lease_secret: leaseSecret,
    expected_head: fp.expected_head,
    mutation_capability: tailClass === "mutation",
  });
  const lease = exec.lease;
  const secrets = exec.secrets;
  const permit = permitFromLease(execDir, lease, secrets, tailClass === "mutation");

  const initial = createInitialSnapshot({
    checkpoint_id: lease.checkpoint_id,
    execution_id: execId,
    chain_id: lease.chain_id,
    repository_fingerprint: fp,
    repository_root_identity: fp.repository_root_identity,
    git_common_dir_identity: fp.git_common_dir_identity,
    expected_head: fp.expected_head,
    expected_ref: fp.expected_ref,
    origin_url: fp.origin_url,
    origin_master: fp.origin_master,
    expected_worktree_state: fp.expected_worktree_state,
    current_owner_actor: actorId,
    lease_identity: lease.lease_id,
    input_manifest: {},
  });
  publishCurrent(execDir, initial, { expectedRevision: 0, permit });

  const intentFor = (rev, fromStage, toStage, cls) => ({
    format_version: "1.0.0",
    revision: rev,
    transition_id: `e1_tail_${rev}`,
    execution_id: execId,
    checkpoint_id: lease.checkpoint_id,
    chain_id: lease.chain_id,
    record_kind: "intent",
    from_stage: fromStage,
    to_stage: toStage,
    from_state: "CHECKPOINT_CREATED",
    to_state: "RESUME_READY",
    actor_id: actorId,
    timestamp: new Date().toISOString(),
    side_effect_class: cls,
    expected_revision_before: rev - 1,
    evidence_refs: ["a.txt"],
    expected_evidence_manifest: null,
  });

  // rev1: closed read_only transition (INTENT + COMPLETE).
  const i1 = intentFor(1, "CHECKPOINT_CREATED", "READ_ONLY_DISCOVERY", "read_only");
  publishIntent(execDir, i1, permit);
  publishComplete(execDir, { ...i1, record_kind: "complete" }, null, permit);
  // rev2: the OPEN tail (INTENT only — the crash window under test).
  const i2 = intentFor(2, "READ_ONLY_DISCOVERY", tailClass === "mutation" ? "MUTATION" : "READ_ONLY_DISCOVERY", tailClass);
  publishIntent(execDir, i2, permit);

  const continuity = validateContinuity(execDir);
  if (continuity.incompleteTail !== 2) throw new Error(`open-tail fixture: incompleteTail ${continuity.incompleteTail} != 2`);
  if (continuity.lastComplete !== 1) throw new Error(`open-tail fixture: lastComplete ${continuity.lastComplete} != 1`);

  return {
    tag: tag ?? null,
    repo, root, checkpointRoot: root, execDir, executionId: execId,
    lease, secrets, actorId, sessionId,
    ownerSessionId: sessionId,
    ownerSessionSecret: sessionSecret,
    ownerLeaseSecret: leaseSecret,
    ownerActorId: actorId,
    tailClass,
    continuity,
    ro: { runReadOnlyDiscovery },
    cleanup: baseCleanup([repo, root]),
  };
}

// ═══════════════════════ Cross-process worker legs ═══════════════════════════

/**
 * Spawn a fresh-process worker leg through the generated CJS bootstrap (the
 * worker inherits the runtime-isolation shim via E1_SHIM_URL; isolation rule
 * 3: zero VM lifecycle in ANY process). Reports via KEY:json stdout lines.
 */
export function runWorker(scriptPath, args = [], { homeShim = null } = {}) {
  const bootstrapUrl = homeShim?.bootstrapUrl ?? process.env.E1_PRELOAD_SHIM_BOOTSTRAP_URL;
  if (!bootstrapUrl) throw new Error("runWorker: no bootstrap URL (pass homeShim or run under the preload)");
  const child = spawn(process.execPath, ["--import", bootstrapUrl, scriptPath, ...args], {
    env: {
      ...process.env,
      E1_SHIM_URL: homeShim?.shimUrl ?? process.env.E1_SHIM_URL,
      ...(homeShim?.homeDir ? { HOME: homeShim.homeDir } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve({ pid: child.pid, code, out: stdout, stdout, stderr }));
    child.on("error", (e) => resolve({ pid: child.pid, code: -1, out: stdout, stdout, stderr: `${stderr}${e}` }));
  });
}

/** First `KEY:json` line from worker output (sealed worker protocol). */
export function workerLine(out, key) {
  const prefix = `${key}:`;
  for (const line of String(out).split("\n")) {
    if (line.startsWith(prefix)) {
      try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
    }
  }
  return null;
}

/**
 * Disposable HOME for worker legs (git config hygiene): an mkdtemp dir with
 * a minimal global git identity so spawned actors never touch the real
 * $HOME, plus a per-worker shim set for the isolation bootstrap.
 */
export function isolatedHome() {
  const homeDir = fsMkdtempSync(join(tmpdir(), "e1-home-"));
  const shim = shimWriteIsolatedShim(fsMkdtempSync(join(tmpdir(), "e1-worker-shim-")));
  return {
    homeDir,
    shimUrl: shim.shimUrl,
    shimPath: shim.shimPath,
    bootstrapUrl: shim.bootstrapUrl,
    cleanup() {
      for (const p of [homeDir, shim.dir]) { try { rmSync(p, { recursive: true, force: true }); } catch { /* tmp */ } }
    },
  };
}
