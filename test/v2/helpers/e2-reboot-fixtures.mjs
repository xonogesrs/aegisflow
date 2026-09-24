// test/v2/helpers/e2-reboot-fixtures.mjs
//
// E2 REBOOT SOAK — fixture-assembly helper (NEW file; E2-owned).
// Card: AUTOLOOP-V1-STAGE-F-P5-SOAK-E2-IMPLEMENTATION-1 under the sealed
// admission AUTOLOOP-V1-STAGE-F-P5-SOAK-E2-ADMISSION-1 (frozen contract:
// E2-SCENARIO-INVENTORY / E2-REBOOT-SEMANTICS / E2-PERSISTENCE-BOUNDARY /
// E2-ORACLE-CONTRACT / E2-MUTATION-BUDGET / E2-EXECUTION-SURFACE).
//
// Authority boundaries (mirroring the sealed helper rule — fixture assembly
// ONLY, zero production semantics live here):
//   * Every production decision is CONSUMED, never re-implemented: the
//     DurableGraphRun state machine, the resume validation chain, the
//     interrupted-writer / post-head classifiers, the CEDF fold gate, the
//     C2D publication chain (CAS + lock + permit), scratch-ownership.
//     HOLD codes and C2dHoldError are RE-EXPORTS of sealed src modules —
//     never redefinitions.
//   * Fixtures build honest durable states inside disposable OS-temp
//     namespaces through the REAL publication chain (same pattern as
//     test/v2/test-durable-graph.mjs and the sealed E1 fixtures).
//   * The reboot boundary is proven by DURABLE MARKERS (journal rows /
//     CURRENT fields / ack files) — never by sleep.
//   * SIGKILL-class profiles kill a real spawned helper process with
//     SIGKILL (the DE-2R injection class; colima-independent). No graceful
//     close, no shutdown-hook flush, no test-only state manufacturing.
//   * Fresh-process legs are spawned node children that import production
//     modules directly and derive everything from execDir bytes (the sealed
//     crossproc worker protocol).
//
// Engine-mode note (disclosed): continuation legs run the production
// durable state machine with DETERMINISTIC IN-ENGINE adapter factories
// injected through the existing resumeDurableGraph factory seam
// (src/v2/durable-graph.mjs :1213/:1842 -> runColimaGraph -> the
// orchestrator's own fail-closed factory contract, exercised the same way
// by test/tool-selection/test-tool-selection-durable-resume.mjs). Zero
// VM lifecycle in ANY process (isolation rule; colima-less host). The
// factories own NO durable authority: they return normalized adapter
// results only; every durable decision stays in the sealed machinery.

import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync,
  mkdirSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

// ── Sealed production primitives (re-exported verbatim; never re-implemented)
import { C2dHoldError, HOLD, setInjectionHook, clearInjectionHooks } from "../../../src/c2d/fs-atomic.mjs";
import { RunEvidenceStore, canonicalJson, sha256Text } from "../../../src/evidence/run-evidence-store.mjs";
import {
  readCheckpoint, collectRepositoryFingerprint, collectRepositoryTree,
} from "../../../src/v2/checkpoint-bridge.mjs";
import { readCurrent } from "../../../src/c2d/checkpoint-store.mjs";
import { validateContinuity, journalDir } from "../../../src/c2d/journal.mjs";
import {
  DurableGraphRun, captureWorktreeDirtyState, wipeScratchPreserving,
} from "../../../src/v2/durable-graph.mjs";
import { buildIrSha256, buildDagFingerprint } from "../../../src/v2/checkpoint-bridge.mjs";
import { buildDecompositionManifest } from "../../../src/v2/decomposition-manifest.mjs";
import { computeSourceHashes } from "../../../src/v2/durable-execution.mjs";
import {
  prepareOwnedScratchRoot, getScratchAuthorityToken, SCRATCH_OWNER_MARKER,
} from "../../../src/runtime/scratch-ownership.mjs";
import { mintExecutionId, mintChainId, mintCheckpointId } from "../../../src/c2d/execution-id.mjs";
import { writeIsolatedShim as shimWriteIsolatedShim, runtimeShimHooks } from "./e1-runtime-shim.mjs";

export {
  C2dHoldError, HOLD, RunEvidenceStore, readCheckpoint, readCurrent,
  validateContinuity, DurableGraphRun, captureWorktreeDirtyState,
  wipeScratchPreserving, setInjectionHook, clearInjectionHooks,
  prepareOwnedScratchRoot, getScratchAuthorityToken, SCRATCH_OWNER_MARKER,
  mkdtempSync, tmpdir, join, dirname, rmSync, writeFileSync, readFileSync,
  existsSync, mkdirSync, readdirSync, canonicalJson, sha256Text,
};

// ═══════════════════════ Small shared helpers ═══════════════════════════════

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function fileDigest(path) {
  return sha256Hex(readFileSync(path));
}

/** git runner over a concrete repo dir; never throws. */
export function git(repo, args, opts = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", ...opts });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Real temp git repo (clean, branch master, one initial commit). */
export function makeTempGitRepo(label) {
  const repo = mkdtempSync(join(tmpdir(), `e2-${label}-repo-`));
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.email", "e2@fixture"]);
  git(repo, ["config", "user.name", "e2-fixture"]);
  writeFileSync(join(repo, "README.md"), "# e2 fixture\n");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

/**
 * Journal row scan over a RunEvidenceStore — the sealed verifier's own event
 * list (journalRows discipline of the sealed E1 helper: the fixture's store
 * is the single journal reader; no second authority over the same journal).
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

/** Zero-orphan attestation: kill(pid,0) liveness over recorded pids. */
export function cleanupAttestation(pids) {
  const survivors = [];
  for (const pid of pids) {
    try { process.kill(pid, 0); survivors.push(pid); } catch { /* gone: good */ }
  }
  return { orphanCount: survivors.length, survivors };
}

// ═══════════════════════ IR construction (fixture input data) ═══════════════

/**
 * Build a DECOMPOSED IR. Phases whose `effects.artifact_mutation` is
 * "allowed"/"required" are writer phases per src/v2/runner.mjs
 * isRepositoryWriter (the ONLY classification authority — never phase ids).
 * `runtime.mode: "readonly"` keeps the colima pre-phase on the read-only
 * path; the mode is irrelevant in engine mode (adapters are injected).
 */
export function buildIR({ writerPhase = true, secondPhase = true, purpose = "e2" } = {}) {
  const phase = (phaseId, writer, dependsOn = []) => ({
    phase_id: phaseId,
    title: `t-${phaseId}`,
    summary: `${purpose} ${phaseId}`,
    responsibility: "r",
    purpose: "implementation",
    effects: writer
      ? {
          artifact_mutation: "required", runtime_side_effect: "forbidden",
          external_system_mutation: "forbidden", evidence_output: "persistent",
          boundaries: { artifact: ["docs/"], runtime: [], external_system: [], evidence: ["docs/"] },
        }
      : {
          artifact_mutation: "forbidden", runtime_side_effect: "forbidden",
          external_system_mutation: "forbidden", evidence_output: "ephemeral",
          boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
        },
    runtime: { mode: "readonly", command: "true", expect: {}, limits: { memoryMiB: 256, timeoutMs: 60000 } },
    covers: [{ requirement_id: "R1", completeness: "complete", claim: "c" }],
    depends_on: dependsOn,
  });
  // P1 is the WRITER phase (artifact boundary "docs/"); the parent scope
  // authorizes exactly that path (see bootGraphRun parent scope). P2 is
  // read-only and dependent. The interrupted-writer / ownership windows the
  // corpus exercises come from the real writer FLAGS (writer_phase_active /
  // writer_lease_holder), which onPhaseStart sets for requiresWriterLease
  // phases — see makeW2OpenTailFixture.
  const phases = [phase("P1", true)];
  if (secondPhase) phases.push(phase("P2", false, ["P1"]));
  return {
    verdict: "DECOMPOSED",
    parent_goal: purpose,
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases,
    dispositions: [],
    decomposition_evidence: ["e"],
  };
}

// ═══════════════════════ Deterministic engine adapters ══════════════════════

const VALID_REVIEWER_VERDICT = JSON.stringify({
  verdict: "PASS", confidence: "HIGH", model: "",
  summary: "ok", recommended_next_action: "STOP",
});

/**
 * The ONE deterministic executor adapter used by every engine-mode leg.
 * Returns a normalized "completed" adapter result (adapter/contract.mjs
 * shape); lifecycle-runner parses the executor's final message as JSON and
 * validates it through validateImplementationEvidence — the fixture payload
 * is the same document shape the sealed fixture uses
 * (test/fixtures/implementation-evidence-valid.json), bound per-phase.
 */
export function createDeterministicExecutorAdapter({ resultSink = null, calls = null } = {}) {
  const callRecord = [];
  return {
    callRecord,
    runAdapter: async (request) => {
      callRecord.push({ phase: request.phase, attempt: request.attempt, executionId: request.executionId });
      if (calls) calls.push(request.phase);
      const evidence = JSON.parse(
        readFileSync(new URL("../fixtures/implementation-evidence-valid-e2.json", import.meta.url), "utf8"),
      );
      evidence.contract_id = request.taskCard?.executionId ?? evidence.contract_id;
      evidence.design_revision_id = request.taskCard?.phaseId ?? evidence.design_revision_id;
      const result = {
        status: "completed",
        executionId: request.executionId,
        stdout: JSON.stringify(evidence),
        stderr: "",
        signal: null,
        error: null,
        metadata: { exitCode: 0, mode: "readonly" },
      };
      resultSink?.(request.executionId, result);
      return result;
    },
  };
}

/** Deterministic reviewer adapter: emits the one normalized PASS verdict. */
export function createDeterministicReviewerAdapter({ calls = null } = {}) {
  const callRecord = [];
  return {
    callRecord,
    runAdapter: async (request) => {
      callRecord.push({ phase: request.phase, attempt: request.attempt, executionId: request.executionId });
      if (calls) calls.push(request.phase);
      return {
        status: "completed",
        executionId: request.executionId,
        stdout: VALID_REVIEWER_VERDICT,
        stderr: "",
        signal: null,
        error: null,
        metadata: { exitCode: 0 },
      };
    },
  };
}

/**
 * THE engine-mode factory pair for resumeDurableGraph (existing :1213 seam).
 * A refusal factory never spawns a phase: it throws, which the orchestrator
 * maps to a failed phase (used by negative arms that must prove the run
 * would have re-executed without the durable fold).
 */
export function engineFactories({ refuse = false, calls = null } = {}) {
  // Factory contract (asymmetric, per runColimaGraph :326-334): the EXECUTOR
  // factory is pre-invoked once with { resultSink } and must return the
  // per-phase factory the orchestrator then calls; the REVIEWER factory is
  // forwarded raw and must return the adapter directly.
  const executorAdapterFactory = () => () => {
    if (refuse) throw new Error("E2_ENGINE_REFUSAL_ADAPTER");
    return createDeterministicExecutorAdapter({ calls });
  };
  const reviewerAdapterFactory = () => {
    if (refuse) throw new Error("E2_ENGINE_REFUSAL_ADAPTER");
    return createDeterministicReviewerAdapter({ calls });
  };
  return { executorAdapterFactory, reviewerAdapterFactory };
}

// ═══════════════════════ The shared boot (real publication chain) ═══════════

async function bootGraphRun({ label, ir, admission = null }) {
  const repo = makeTempGitRepo(label);
  const root = mkdtempSync(join(tmpdir(), `e2-${label}-root-`));
  const scratch = mkdtempSync(join(tmpdir(), `e2-${label}-scratch-`));
  const executionId = mintExecutionId();
  const run = new DurableGraphRun({
    ir, parent: { scope: { allowed_paths: ["docs/"] } }, manifest: [{ requirement_id: "r1", text: "x" }],
    cwd: repo, repoPath: repo, scratchRoot: scratch,
    maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
    persistence: { root, executionId },
    dirtyScope: [], admission,
  });
  const store = new RunEvidenceStore({ root, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
  const execDir = store.init();
  run.execDir = execDir;
  run.store = store;
  run.root = root;

  run.repoFingerprint = collectRepositoryFingerprint(repo);
  const dirtyState = captureWorktreeDirtyState(repo, []);
  run.state.permittedDirtyDigest = dirtyState.filteredDigest;
  const frozenInput = { source: null, parent: { scope: { allowed_paths: ["docs/"] } }, manifest: [{ requirement_id: "r1", text: "x" }], repoPath: repo, scratchRoot: scratch };
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

  // I1: decomposition manifest — same construction as the sealed fixtures.
  const manifestResult = buildDecompositionManifest({
    parentExecutionId: run.executionId,
    chainId: run.chainId,
    parentRevision: sha256Text(canonicalJson({ scope: { allowed_paths: ["docs/"] } })),
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

  // Owned scratch namespace + its durable authority artifact (the resume
  // path requires both: scratch-ownership.json carries the authority token;
  // its loss is R7's negative arm, :1829).
  const ownedScratchRoot = prepareOwnedScratchRoot({ scratchRoot: scratch, executionId: run.executionId, repoPath: repo });
  const authorityToken = getScratchAuthorityToken(ownedScratchRoot);
  store.writeArtifact("scratch-ownership.json", { schema: "autoloop.scratch-authority/v1", authorityToken });

  return { repo, root, scratch, execDir, store, run, executionId, ir, admission, ownedScratchRoot, authorityToken };
}

function fixtureFrom(fx, tag) {
  return {
    tag,
    repo: fx.repo, root: fx.root, scratch: fx.scratch,
    execDir: fx.execDir, store: fx.store, run: fx.run, ir: fx.ir,
    executionId: fx.executionId, admission: fx.admission ?? null,
    ownedScratchRoot: fx.ownedScratchRoot, authorityToken: fx.authorityToken,
    frozenHead: git(fx.repo, ["rev-parse", "HEAD"]).stdout.trim(),
    checkpoint: readCheckpoint(fx.root, fx.executionId),
    cleanup() {
      for (const p of [fx.repo, fx.root, fx.scratch]) {
        try { rmSync(p, { recursive: true, force: true }); } catch { /* tmp */ }
      }
    },
  };
}

/**
 * The base E2 fixture: real durable store + owned scratch + checksummed
 * checkpoints, run non-terminal, nothing started. Used directly by R3.
 */
export async function makeE2Fixture({ tag, writerPhase = true, admission = null } = {}) {
  const ir = buildIR({ writerPhase, secondPhase: true, purpose: `e2-${tag}` });
  const fx = await bootGraphRun({ label: `boot-${tag}`, ir, admission });
  return fixtureFrom(fx, tag);
}

// ═══════════════════════ Boundary-window constructors ═══════════════════════

/**
 * W2 shape (R1): PHASE_STARTED journaled through the REAL hooks with the
 * phase's writer flags set (a WRITER phase per isRepositoryWriter), INTENT
 * semantics carried by the open durable tail (the phase's terminal row and
 * its enclosing checkpoint are absent — the exact incomplete-tail reality
 * the interrupted-writer classifier adjudicates; persistence boundary:
 * "PHASE_STARTED journaled (:669), writer flags set, NO terminal row,
 * validateContinuity().incompleteTail open").
 */
export async function makeW2OpenTailFixture({ tag } = {}) {
  const fx = await makeE2Fixture({ tag });
  const hooks = fx.run.buildGraphHooks(fx.ir);
  await hooks.onPhaseStart({ phaseId: "P1" });
  const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
  if (snap.active_phase !== "P1") throw new Error(`W2 fixture: active_phase ${snap.active_phase} != P1`);
  if (snap.writer_phase_active !== true || !snap.writer_lease_holder) {
    throw new Error("W2 fixture: writer flags not set");
  }
  const started = journalRows(fx.store, ["PHASE_STARTED"]);
  if (started.length !== 1) throw new Error(`W2 fixture: PHASE_STARTED rows ${started.length} != 1`);
  return Object.assign(fx, { w2: { activePhase: "P1", writerFlags: { writer_phase_active: snap.writer_phase_active, writer_lease_holder: snap.writer_lease_holder } } });
}

/**
 * W3 shape (R2): post-head events beyond the checkpoint head — the phase's
 * terminal transition is journaled through the REAL _onRunnerView path
 * (PHASE_PASSED row + pinned result artifact) but the enclosing CHECKPOINT
 * is NOT published: the runner-view hook fires the pre-checkpoint
 * onDurableEvent seam (:545) and we stop there. The last CURRENT still pins
 * the pre-terminal journal head — the exact post-head tail R2 adjudicates.
 */
export async function makeW3PostHeadFixture({ tag } = {}) {
  const fx = await makeE2Fixture({ tag, writerPhase: false });
  const hooks = fx.run.buildGraphHooks(fx.ir);
  await hooks.onPhaseStart({ phaseId: "P1" });
  const headBefore = fx.store.verifyJournal().count;
  let release;
  const gate = new Promise((r) => { release = r; });
  const caller = fx.run.hooks;
  fx.run.hooks = {
    ...caller,
    onDurableEvent: async (info) => {
      if (info?.event_type === "PHASE_PASSED" && info?.pre_checkpoint === true) {
        await caller?.onDurableEvent?.(info);
        await gate; // hold BEFORE the enclosing checkpoint publication (release only via w3.resume())
        return;
      }
      await caller?.onDurableEvent?.(info);
    },
  };
  const runnerView = fx.run._onRunnerView({
    statuses: { P1: "passed", P2: "pending" }, leaseHolder: null, newlySkipped: [],
  });
  // The wrapper holds INSIDE _onRunnerView (before the enclosing checkpoint
  // publication). Wait until the terminal row is durably journaled — the
  // crash window is exactly "row written, checkpoint not published".
  const w3Deadline = Date.now() + 15000;
  while (journalRows(fx.store, ["PHASE_PASSED"]).length < 1) {
    if (Date.now() > w3Deadline) throw new Error("W3 fixture: PHASE_PASSED row never journaled");
    await new Promise((r) => setImmediate(r));
  }
  // Durable W3 markers: terminal row present, beyond the pinned head.
  const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
  const rows = journalRows(fx.store, ["PHASE_PASSED"]);
  if (rows.length !== 1) throw new Error(`W3 fixture: PHASE_PASSED rows ${rows.length} != 1`);
  if (rows[0].sequence <= snap.journal_head_sequence) {
    throw new Error("W3 fixture: terminal row is not beyond the checkpoint head");
  }
  if (!existsSync(join(fx.execDir, "phases", "P1", "result.json"))) {
    throw new Error("W3 fixture: pinned result artifact missing");
  }
  fx.w3 = {
    postHeadRow: rows[0],
    pinnedHead: snap.journal_head_sequence,
    resume: async () => {
      release();
      await runnerView; // let the interrupted publication complete its chain
      fx.run.hooks = caller;
    },
  };
  return fx;
}

/**
 * W4 shape: a complete checkpoint (revision bump, phase_result_hashes
 * pinned), run non-terminal, P1 CONFIRMED through the real hooks.
 */
export async function makeW4CheckpointedFixture({ tag } = {}) {
  const fx = await makeE2Fixture({ tag, writerPhase: false });
  const hooks = fx.run.buildGraphHooks(fx.ir);
  await hooks.onPhaseStart({ phaseId: "P1" });
  await fx.run._onRunnerView({ statuses: { P1: "passed", P2: "pending" }, leaseHolder: null, newlySkipped: [] });
  const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
  if (snap.final_verdict !== null) throw new Error("W4 fixture: run must be non-terminal");
  if (!(snap.revision > 0)) throw new Error("W4 fixture: no checkpoint");
  if (snap.phase_states.P1 !== "passed") throw new Error("W4 fixture: P1 not passed in phase_states");
  if (!snap.phase_result_hashes?.P1) throw new Error("W4 fixture: P1 result hash not pinned");
  return Object.assign(fx, { w4: { completedPhase: "P1" } });
}

/** Terminal PASS shape (R4): full real drive to run.terminal("PASS"). */
export async function makeTerminalFixture({ tag } = {}) {
  const fx = await makeE2Fixture({ tag, writerPhase: false });
  const hooks = fx.run.buildGraphHooks(fx.ir);
  await hooks.onPhaseStart({ phaseId: "P1" });
  await fx.run._onRunnerView({ statuses: { P1: "passed", P2: "pending" }, leaseHolder: null, newlySkipped: [] });
  await fx.run.terminal("PASS", null);
  const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
  if (snap.final_verdict !== "PASS") throw new Error("terminal fixture failed to publish PASS");
  // Refresh the fixture's cached checkpoint handle: fixtureFrom captured it
  // BEFORE the terminal publication.
  fx.checkpoint = readCheckpoint(fx.root, fx.executionId);
  return Object.assign(fx, { terminal: { verdict: "PASS" } });
}

/**
 * R5 shape: SIGKILL the publishing process inside the REAL torn-publication
 * window — CURRENT.json replaced (atomic), sidecar CURRENT.json.sha256 NOT
 * yet renamed — reached through the sealed injection-hook seam
 * (before_checksum_rename) exactly as test-post-finalization-derived-artifact
 * C5 constructs it. The kill IS the injection; no synthetic torn file.
 */
export async function killDuringPublicationWindow({ fixture, victimScriptPath, ackPath }) {
  // Arm the one-shot publication-window hook IN THE VICTIM's module tree via
  // the durable-runner worker (see workers below): the worker installs
  // before_checksum_rename, starts a phase-boundary publication, and the
  // parent SIGKILLs it when the durable marker (temp CURRENT without valid
  // sidecar) is observable.
  return spawnRebootWorker(victimScriptPath, [
    "--mode", "publish-torn",
    "--root", fixture.root, "--exec", fixture.executionId,
    "--repo", fixture.repo, "--scratch", fixture.scratch,
    "--ack", ackPath,
  ], { killWhen: ackPath });
}

// ═══════════════════════ SIGKILL reboot workers ═════════════════════════════
// SIGKILL-class profiles run the injection inside a REAL spawned helper
// process ("writer helper") that drives the production hooks. The PARENT
// sends SIGKILL — zero graceful shutdown, zero cleanup handlers, zero
// flush — exactly the DE-2R crash-matrix class. Durable markers (journal
// rows on disk / the torn window marker) gate the kill; no sleeps.

const WORKER_HELPERS = join(tmpdir(), `e2-worker-helpers-${process.pid}`);

function victimBootstrapSrc() {
  return `
const fsatomic = await import(process.env.E2_FSATOMIC_URL);
const { setInjectionHook, clearInjectionHooks } = fsatomic;
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
function arg(name) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : null; }
const root = arg("root"), execId = arg("exec"), repo = arg("repo"), scratch = arg("scratch"), ackPath = arg("ack");
const mode = arg("mode");
const dur = await import(process.env.E2_DURABLE_URL);
const bridge = await import(process.env.E2_BRIDGE_URL);
const evidence = await import(process.env.E2_EVIDENCE_URL);
const c2d = await import(process.env.E2_C2DSTORE_URL);
const scratchOwnership = await import(process.env.E2_SCRATCHOWN_URL);
const ir = JSON.parse(readFileSync(arg("ir"), "utf8"));
const REPO_ROOT = process.env.E2_REPO_ROOT;
const executionId = execId;
const store = new evidence.RunEvidenceStore({ root, executionId, chainId: (bridge.readCheckpoint(root, executionId).snapshot.chain_id), checkpointId: (bridge.readCheckpoint(root, executionId).snapshot.checkpoint_id), repoRoot: repo });
store.init();
const cp = bridge.readCheckpoint(root, executionId);
const run = new dur.DurableGraphRun({
  ir, parent: { scope: { allowed_paths: ["docs/"] } }, manifest: [{ requirement_id: "r1", text: "x" }],
  cwd: repo, repoPath: repo, scratchRoot: scratch,
  maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
  persistence: { root, executionId },
  dirtyScope: [], admission: null,
  recovery: { executionAttempt: (cp.snapshot.graph?.recovery_attempt ?? 1), recoveryGeneration: (cp.snapshot.graph?.recovery_generation ?? 0), resumed: false, replayOf: null, recovered: false, duplicateSuppressed: 0 },
});
run.execDir = store.execDir; run.store = store; run.root = root;
run.repoFingerprint = bridge.collectRepositoryFingerprint(repo);
run.inputFingerprint = cp.snapshot.input_fingerprint;
run.configurationFingerprint = cp.snapshot.configuration_fingerprint;
run.irSha = cp.snapshot.decomposition_ir_sha256;
run.dagSha = cp.snapshot.dag_sha256;
run.state.expectedRevision = cp.snapshot.revision;
run.state.phaseStates = { ...cp.snapshot.phase_states };
run.state.phaseResultHashes = { ...(cp.snapshot.phase_result_hashes ?? {}) };
run.state.completedPhaseIds = [...(cp.snapshot.completed_phase_ids ?? [])];
run.state.rolloverMirror = cp.snapshot.graph?.rollover ?? null;
run.state._lastRunnerStatuses = { ...cp.snapshot.phase_states };
const ownership = JSON.parse(readFileSync(join(store.execDir, "artifacts", "scratch-ownership.json"), "utf8"));
const ownedRoot = scratchOwnership.prepareOwnedScratchRoot({ scratchRoot: scratch, executionId, repoPath: repo, authorityToken: ownership.authorityToken });
run.state.permittedDirtyDigest = cp.snapshot.graph?.permitted_dirty_digest ?? null;
// ATOMIC publish (tmp + rename): the parent polls this path, so the file must
// never be observable in a partially-written state. A plain writeFileSync
// creates/truncates the path BEFORE writing the bytes, and a parent that
// read between those two moments got an empty file and threw
// "Unexpected end of JSON input" — a real, observed soak flake (this marker
// gates a SIGKILL, so the window was hit often).
const publishAck = (obj) => {
  mkdirSync(require_dirname(ackPath), { recursive: true });
  const tmp = ackPath + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(obj));
  renameSync(tmp, ackPath);
};
const helperAck = publishAck;

if (mode === "phase-start-kill") {
  // R1/R6: die INSIDE the writer phase start, after the durable marker
  // (PHASE_STARTED row + writer flags checkpoint) is observable on disk.
  const hooks = run.buildGraphHooks(ir);
  await hooks.onPhaseStart({ phaseId: arg("phaseId") ?? "P1" });
  helperAck({ marker: "PHASE_STARTED" });
  // Hold until SIGKILL arrives; no graceful shutdown, no flush.
  await new Promise(() => {});
} else if (mode === "post-head-kill") {
  // R2/R3/R6/R7: the W3/W4 shape (terminal row journaled beyond the pinned
  // checkpoint head, or the semantic checkpoint itself) is ALREADY durable
  // on disk from the fixture constructor. The victim must NOT append to the
  // journal (any append would collide with the frozen fixture sequence or
  // disturb the post-head window); it re-derives the shape read-only,
  // acks the marker, then holds until the parent SIGKILLs it — no graceful
  // shutdown, no flush.
  const j = store.verifyJournal();
  let passedRows = 0;
  for (let s = 1; s <= j.count; s++) {
    if (store.readEvent(s).event.event_type === "PHASE_PASSED") passedRows++;
  }
  if (passedRows < 1) throw new Error("post-head-kill: no PHASE_PASSED row on disk — fixture shape broken");
  helperAck({ marker: "POST_HEAD", rows: passedRows, head: j.count });
  await new Promise(() => {});
} else if (mode === "hold-kill") {
  // R7-style reboot: no journal shape requirement — the fixture state IS
  // the crash boundary. The victim constructs the durable view read-only,
  // acks, and holds until the parent SIGKILLs it.
  helperAck({ marker: "HOLD_BOUNDARY", head: store.verifyJournal().count });
  await new Promise(() => {});
} else if (mode === "publish-torn") {
  // R5: die INSIDE the real publication window (CURRENT replaced, sidecar
  // not yet renamed), reached through the sealed injection-hook seam.
  setInjectionHook("before_checksum_rename", () => {
    // Durable marker for the parent: the torn window is NOW. Write the ack
    // OUTSIDE the evidence root (parent-visible), then stop cooperating.
    try { publishAck({ marker: "TORN" }); } catch {}
    throw new Error("E2_TORN_MARKER_STOP"); // publication aborts here in-worker if parent is slow; parent SIGKILL wins the race by design
  });
  const hooks = run.buildGraphHooks(ir);
  await hooks.onPhaseStart({ phaseId: arg("phaseId") ?? "P2" });
  helperAck({ marker: "PUBLICATION_ARMED" });
  await new Promise(() => {});
} else if (mode === "publish-torn-cancel") {
  // R5 alternate: the injected failure is DELIVERED (no parent kill yet);
  // proves the window is real even without the kill racing the worker.
  setInjectionHook("before_checksum_rename", () => {
    try { publishAck({ marker: "TORN" }); } catch {}
    throw new Error("E2_TORN_INJECTED_FAILURE");
  });
  const hooks = run.buildGraphHooks(ir);
  await hooks.onPhaseStart({ phaseId: arg("phaseId") ?? "P2" });
  try { await run._onRunnerView({ statuses: { P1: "passed", P2: "pending" }, leaseHolder: null, newlySkipped: [] }); }
  catch (e) { helperAck({ delivered: String(e?.message ?? e).slice(0, 120) }); }
  process.exit(0);
}
function require_dirname(p) { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : "."; }
`;
}

/**
 * Spawn the reboot worker (fresh node process, isolated shim bootstrap).
 * Returns { child, pid, exited } — the CALLER owns the kill decision, gated
 * on durable markers.
 */
export function spawnRebootWorker(scriptPath, args, opts = {}) {
  const child = spawn(process.execPath, ["--import", process.env.E2_WORKER_BOOTSTRAP_URL, scriptPath, ...args], {
    env: {
      ...process.env,
      ...(opts.env ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (c) => { stderr += c; });
  child.stdout.on("data", (c) => { stdout += c; });
  return { child, pid: child.pid, stderrText: () => stderr, stdoutText: () => stdout };
}

/** SIGKILL the victim. No TERM first, no graceful anything. */
export function sigkill(child) {
  try { process.kill(child.pid, "SIGKILL"); } catch { /* already dead */ }
}

export async function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (e) => resolve({ code: -1, signal: null, error: String(e) }));
  });
}

/** Install + materialize the worker bootstrap + fixture evidence file. */
export function installWorkerHelpers() {
  mkdirSync(WORKER_HELPERS, { recursive: true });
  const bootstrapPath = join(WORKER_HELPERS, "worker-bootstrap.mjs");
  const src = `import { registerHooks } from "node:module";
import { runtimeEngineHooks } from ${JSON.stringify(new URL("./e2-engine-runtime-shim.mjs", import.meta.url).href)};
registerHooks(runtimeEngineHooks({ runtimeShimUrl: process.env.E2_ENGINE_RUNTIME_URL, worktreeShimUrl: process.env.E2_ENGINE_WORKTREE_URL }));
await import(process.argv[1]);
`;
  writeFileSync(bootstrapPath, src);
  const victimPath = join(WORKER_HELPERS, "reboot-victim.mjs");
  writeFileSync(victimPath, victimBootstrapSrc());
  // The worker imports production modules via absolute file URLs.
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const env = {
    E2_REPO_ROOT: repoRoot,
    E2_FSATOMIC_URL: `file://${repoRoot}src/c2d/fs-atomic.mjs`,
    E2_DURABLE_URL: `file://${repoRoot}src/v2/durable-graph.mjs`,
    E2_BRIDGE_URL: `file://${repoRoot}src/v2/checkpoint-bridge.mjs`,
    E2_EVIDENCE_URL: `file://${repoRoot}src/evidence/run-evidence-store.mjs`,
    E2_C2DSTORE_URL: `file://${repoRoot}src/c2d/checkpoint-store.mjs`,
    E2_SCRATCHOWN_URL: `file://${repoRoot}src/runtime/scratch-ownership.mjs`,
    E2_ENGINE_RUNTIME_URL: new URL("./e2-engine-runtime-shim.mjs", import.meta.url).href,
    E2_ENGINE_WORKTREE_URL: new URL("./e2-engine-worktree-shim.mjs", import.meta.url).href,
    E2_SHIM_HOOKS_URL: new URL("./e2-engine-runtime-shim.mjs", import.meta.url).href,
    E2_WORKER_BOOTSTRAP_URL: `file://${bootstrapPath}`,
  };
  return { bootstrapPath, victimPath, env, dir: WORKER_HELPERS, cleanup: () => { try { rmSync(WORKER_HELPERS, { recursive: true, force: true }); } catch { /* tmp */ } } };
}

/**
 * Write a worker IR file (the victim re-reads the IR from disk — durable
 * fixture input, never reconstructed).
 */
export function writeIrFile(dir, ir, name = "ir.json") {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(ir));
  return p;
}

// ═══════════════════════ Fresh-process resume legs ══════════════════════════

const WORKER_LEGS = [];

/**
 * Fresh-process resume leg: a brand-new node process that imports the
 * production resume machinery and derives EVERYTHING from execDir bytes.
 * Reports via KEY:json stdout lines (sealed worker protocol).
 */
export async function freshResumeLeg({ fixture, mode = "resume", refusal = false, admission = "none", extraArgs = [], legKey = null } = {}) {
  const src = FRESH_LEG_SRC();
  const legPath = join(tmpdir(), `e2-fresh-leg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(legPath, src);
  const bootstrap = await ensureLegBootstrap();
  const child = spawn(process.execPath, ["--import", bootstrap.url, legPath,
    "--mode", mode,
    "--root", fixture.root, "--exec", fixture.executionId,
    "--repo", fixture.repo, "--scratch", fixture.scratch,
    "--refusal", refusal ? "1" : "0",
    "--admission", admission,
    "--irfile", fixture.irFile ?? "",
    ...extraArgs,
  ], {
    env: { ...process.env, E2_REPO_ROOT: new URL("../../../", import.meta.url).pathname, ...(bootstrap.env) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  WORKER_LEGS.push({ path: legPath, pid: child.pid, bootstrapDir: bootstrap.dir });
  const exit = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (e) => resolve({ code: -1, signal: null, error: String(e) }));
  });
  const leg = {
    pid: child.pid, exit, stdout, stderr,
    value: (key) => {
      const prefix = `${key}:`;
      for (const line of String(stdout).split("\n")) {
        if (line.startsWith(prefix)) {
          try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
        }
      }
      return null;
    },
  };
  if (legKey) leg.key = legKey;
  return leg;
}

let LEG_BOOTSTRAP = null;
async function ensureLegBootstrap() {
  if (LEG_BOOTSTRAP) return LEG_BOOTSTRAP;
  const dir = mkdtempSync(join(tmpdir(), "e2-leg-bootstrap-"));
  const bootstrapPath = join(dir, "leg-bootstrap.mjs");
  const engineRuntimeUrl = new URL("./e2-engine-runtime-shim.mjs", import.meta.url).href;
  const engineWorktreeUrl = new URL("./e2-engine-worktree-shim.mjs", import.meta.url).href;
  const hooksUrl = new URL("./e2-engine-runtime-shim.mjs", import.meta.url).href;
  writeFileSync(bootstrapPath, `import { registerHooks } from "node:module";
import { runtimeEngineHooks } from ${JSON.stringify(hooksUrl)};
process.env.E2_ENGINE_RUNTIME_URL = ${JSON.stringify(engineRuntimeUrl)};
process.env.E2_ENGINE_WORKTREE_URL = ${JSON.stringify(engineWorktreeUrl)};
process.env.E2_SHIM_HOOKS_URL = ${JSON.stringify(hooksUrl)};
registerHooks(runtimeEngineHooks({ runtimeShimUrl: process.env.E2_ENGINE_RUNTIME_URL, worktreeShimUrl: process.env.E2_ENGINE_WORKTREE_URL }));
await import(process.argv[1]);
`);
  LEG_BOOTSTRAP = { url: `file://${bootstrapPath}`, dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } } };
  return LEG_BOOTSTRAP;
}

function FRESH_LEG_SRC() {
  return `
function arg(name) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : null; }
const mode = arg("mode");
const root = arg("root"), executionId = arg("exec"), repo = arg("repo"), scratch = arg("scratch");
const refusal = arg("refusal") === "1";
const admissionMode = arg("admission") ?? "none";
const REPO_ROOT = process.env.E2_REPO_ROOT.replace(/[\\/]$/, "");
// Isolation rule 3 (zero VM lifecycle in ANY process): the E2 engine-mode
// resolve redirect was installed by the leg bootstrap BEFORE the production
// tree links colima-runtime.mjs / colima-worktree.mjs — continuation legs
// run the durable state machine with deterministic adapters and ZERO VM
// lifecycle (the engine-mode runtime module answers lifecycle seams with
// not-created state; every real VM action still refuses fail-closed).
const dur = await import(REPO_ROOT + "/src/v2/durable-graph.mjs");
const sub = await import(REPO_ROOT + "/src/subagent/subagent-graph-runner.mjs");
const bridge = await import(REPO_ROOT + "/src/v2/checkpoint-bridge.mjs");
const scratchOwnership = await import(REPO_ROOT + "/src/runtime/scratch-ownership.mjs");
const fsx = await import("node:fs");

const deterministicExecutor = (sink) => {
  const callRecord = [];
  return { callRecord, runAdapter: async (request) => {
    callRecord.push(request.phase);
    if (refusal && request.phase === "executor") throw new Error("E2_ENGINE_REFUSAL_ADAPTER");
    const evidence = JSON.parse(fsx.readFileSync(REPO_ROOT + "/test/v2/fixtures/implementation-evidence-valid-e2.json", "utf8"));
    evidence.contract_id = request.taskCard?.executionId ?? evidence.contract_id;
    evidence.design_revision_id = request.taskCard?.phaseId ?? evidence.design_revision_id;
    const result = { status: "completed", executionId: request.executionId, stdout: JSON.stringify(evidence), stderr: "", signal: null, error: null, metadata: { exitCode: 0, mode: "readonly" } };
    sink?.(request.executionId, result);
    return result;
  } };
};
const deterministicReviewer = () => {
  const callRecord = [];
  return { callRecord, runAdapter: async (request) => {
    callRecord.push(request.phase);
    if (refusal && request.phase === "reviewer") throw new Error("E2_ENGINE_REFUSAL_ADAPTER");
    return { status: "completed", executionId: request.executionId, stdout: JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "", summary: "ok", recommended_next_action: "STOP" }), stderr: "", signal: null, error: null, metadata: { exitCode: 0 } };
  } };
};
const calls = [];
// Probe-only seam (E2 discrimination probes): --injectMemoryLedger simulates
// memory-born ledger entries riding the process boundary (stale-memory
// resume fault). Production wiring never passes this argument; it exists
// solely so the probe suite can prove the zero-re-execution oracle
// discriminates. Default: absent ⇒ no injection.
{
  const injIdx = process.argv.indexOf("--injectMemoryLedger");
  if (injIdx >= 0) for (const entry of String(process.argv[injIdx + 1] ?? "").split(",").filter(Boolean)) calls.push(entry);
}
const executorAdapterFactory = () => () => { const a = deterministicExecutor((id, r) => { globalThis.__lastExec = r; }); return { runAdapter: async (req) => { calls.push("executor:" + (req.taskCard?.phaseId ?? "?")); return a.runAdapter(req); } }; };
// Reviewer: runColimaGraph forwards the reviewer factory RAW to the
// orchestrator (only the executor side is pre-invoked with { resultSink }),
// so the reviewer factory must return the ADAPTER directly.
const reviewerAdapterFactory = () => { const a = deterministicReviewer(); return { runAdapter: async (req) => { calls.push("reviewer:" + (req.taskCard?.phaseId ?? "?")); return a.runAdapter(req); } }; };

let admission = null;
if (admissionMode === "file") admission = JSON.parse(fsx.readFileSync(arg("admissionPath"), "utf8"));

let result = null, thrown = null;
try {
  if (mode === "resume") {
    result = await dur.resumeDurableGraph({
      persistenceRoot: root, executionId,
      parent: { scope: { allowed_paths: ["docs/"] } }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: scratch,
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      dirtyScope: [], admission,
      // The production sub-agent resume entry (subagent-graph-runner.mjs)
      // passes scratchPreserve: ["results"] so the resume-time wipe reclaims
      // worktrees/phase scratch while preserving persisted sub-agent results.
      scratchPreserve: ["results"],
      executorAdapterFactory, reviewerAdapterFactory,
    });
  } else if (mode === "resume-subagent") {
    result = await sub.resumeSubagentGraph({
      parent: { scope: { allowed_paths: ["docs/"] } }, manifest: [], cwd: repo,
      executionId, repoPath: repo, scratchRoot: scratch,
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      dirtyScope: [], admission,
      persistence: { root, executionId },
      executorAdapterFactory, reviewerAdapterFactory,
    });
  } else if (mode === "read-current") {
    // Pure read-path probe: does readCurrent adopt or refuse the torn store?
    try {
      const cur = (await import(REPO_ROOT + "/src/c2d/checkpoint-store.mjs")).readCurrent(root + "/" + executionId);
      result = { adopted: true, revision: cur.snapshot.revision, digest: cur.digest };
    } catch (e) {
      result = { adopted: false, code: e?.code ?? e?.name, message: String(e?.message ?? e).slice(0, 160) };
    }
  } else if (mode === "fold") {
    const cp = bridge.readCheckpoint(root, executionId);
    const evidence = await import(REPO_ROOT + "/src/evidence/run-evidence-store.mjs");
    const store = new evidence.RunEvidenceStore({ root, executionId, chainId: cp.snapshot.chain_id, checkpointId: cp.snapshot.checkpoint_id });
    store.init();
    const gate = dur.childResultFoldGate({ snapshot: cp.snapshot, store, execDir: store.execDir, phaseId: arg("phaseId") ?? "P1" });
    result = { ok: gate.ok, code: gate.code ?? null };
  }
} catch (e) {
  thrown = { code: e?.code ?? e?.name ?? null, message: String(e?.message ?? e).slice(0, 240) };
}
process.stdout.write("LEG:" + JSON.stringify({
  mode, thrown,
  final: result?.final ?? null, stage: result?.stage ?? null, complete: result?.complete ?? null,
  reason: result?.reason ?? null, holdCode: result?.holdCode ?? null,
  resumed: result?.resumed ?? null,
  recovery: result?.recovery ?? null, evidence: result?.evidence ?? null,
  executionId: result?.executionId ?? null, durableExecutionId: result?.durableExecutionId ?? null,
  adopted: result?.adopted ?? null, adoptCode: result?.code ?? null, adoptMessage: result?.message ?? null,
  fold: result?.ok !== undefined ? { ok: result.ok, code: result.code ?? null } : null,
  calls,
}) + "\\n");
process.exit(0);
`;
}

/** The deterministic engine-mode executor evidence fixture (written once). */
export function writeEvidenceFixture() {
  const fixturePath = new URL("../fixtures/implementation-evidence-valid-e2.json", import.meta.url);
  if (existsSync(fixturePath)) return fixturePath;
  // Same document shape as test/fixtures/implementation-evidence-valid.json
  // (schema autoloop.implementation-evidence/v1; per-phase identity bound by
  // the adapter at call time).
  mkdirSync(dirname(fixturePath.pathname), { recursive: true });
  const evidence = {
    schema_version: "autoloop.implementation-evidence/v1",
    contract_id: "PHASE_EXEC_ID",
    design_revision_id: "PHASE_ID",
    design_contract_hash: sha256Text("autoloop:phase-contract:e2").padEnd(64, "0"),
    implementation_attempt_id: "P1-attempt-0",
    parent_attempt_id: "EXEC_ID",
    executor_invocation: {
      schema_version: "autoloop.model-invocation/v1",
      invocation_id: "PHASE_EXEC_ID",
      attempt_id: "P1-attempt-0",
      role: "executor",
      provider: "e2-deterministic",
      configured_model: "e2-deterministic",
      requested_at: "2026-09-06T00:00:00.000Z",
      started_at: "2026-09-06T00:00:00.000Z",
      completed_at: "2026-09-06T00:00:01.000Z",
      elapsed_ms: 1000,
      request_count: 1,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
    repository_baseline: { head: "e2fixture", tree: "e2fixture", branch: "master" },
    initial_integrity: { head: "e2fixture", clean: true },
    final_integrity: { head: "e2fixture", clean: true },
    authorized_paths: [],
    actual_changed_paths: [],
    patch_sha256: sha256Text(""),
    commands: [],
    compile_results: [],
    test_results: [],
    negative_evidence: [],
    mutation_evidence: [],
    skipped_evidence: [],
    known_failures: [],
    environment_limits: {},
    scope_deviations: [],
    executor_verdict: "PASS",
    timestamps: { started_at: "2026-09-06T00:00:00.000Z", completed_at: "2026-09-06T00:00:01.000Z" },
    integrity: { verified: true },
  };
  writeFileSync(fixturePath, JSON.stringify(evidence, null, 2) + "\n");
  return fixturePath;
}

/** Suite-end cleanup: remove leg scripts + leg bootstrap; return attestation. */
export async function cleanupLegs() {
  const pids = WORKER_LEGS.map((l) => l.pid);
  const attestation = cleanupAttestation(pids);
  const paths = [...WORKER_LEGS.map((l) => l.path)];
  WORKER_LEGS.length = 0;
  for (const p of paths) { try { rmSync(p, { force: true }); } catch { /* tmp */ } }
  if (LEG_BOOTSTRAP) { LEG_BOOTSTRAP.cleanup(); LEG_BOOTSTRAP = null; }
  return attestation;
}

/** Count an adapter-call ledger (fresh-leg `calls` output). */
export function countCalls(callsList, phase) {
  // Matches exact entries ("executor:P2") and sub-ids ("executor:P2#3").
  return (callsList ?? []).filter((c) => String(c) === phase || String(c).startsWith(`${phase}:`)).length;
}
