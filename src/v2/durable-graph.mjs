// src/v2/durable-graph.mjs
//
// DE-2 — production Graph durability: wires STACK_A's journal / checkpoint /
// fingerprint machinery behind runColimaGraph (the PRODUCTION Graph path).
//
// Reuses（never re-implements）:
//   - RunEvidenceStore（journal + secret-scanned artifacts）
//   - checkpoint-bridge（publishCheckpoint / readCheckpoint /
//     classifyResumeCapability / classifyPostHeadEvent / fingerprints）
//   - sealed C2D checkpoint-store + lease/permit（single write authority）
//   - runColimaGraph（production Graph path）via injected durable hooks
//   - run-manifest（final manifest）
//
// Safety rules（mirror STACK_A durable-execution.mjs）:
//   - every journal event durably written before the next adapter call
//   - checkpoints at every safe boundary; publication failure => HOLD /
//     CHECKPOINT_PUBLICATION_FAILED（never silently ignored）
//   - resume never re-runs completed phases; ready set from durable truth
//   - interrupted writer => fail closed（RECOVERY_REQUIRED）with worktree /
//     side-effect inspection before ANY retry（Stage 7/8/9/10）
//   - repair budget survives restart（Stage 12）
//   - recovery provenance attached to the result（D7, Stage 14/26）
//
// This module is the ONLY new durable state machine in DE-2. It does NOT
// create a second journal/checkpoint/lease authority.

import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, rmSync, mkdirSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { RunEvidenceStore, canonicalJson, sha256Text, EvidenceHoldError, assertValidEvidenceRoot } from "../evidence/run-evidence-store.mjs";
import { finalizeRunManifest, buildRunManifest, MANIFEST_FORMAT_VERSION } from "../evidence/run-manifest.mjs";
import {
  validateRunIdentity, collectRepositoryFingerprint, collectRepositoryTree, publishCheckpoint, readCheckpoint, checkpointExists,
  buildInputFingerprint, buildConfigurationFingerprint, buildDagFingerprint, buildIrSha256,
  AUTOLOOP_CHECKPOINT_FORMAT_VERSION, deriveChainId, deriveCheckpointId,
  classifyResumeCapability, classifyPostHeadEvent,
} from "./checkpoint-bridge.mjs";
import { buildDecompositionManifest, DECOMPOSITION_MANIFEST_FORMAT } from "./decomposition-manifest.mjs";
import { runColimaGraph } from "../runtime/colima-graph-runner.mjs";
import { cleanupStale } from "../runtime/colima-runtime.mjs";
import {
  prepareOwnedScratchRoot,
  getScratchAuthorityToken,
  normalizeScratchPreservePath,
  ScratchOwnershipError,
} from "../runtime/scratch-ownership.mjs";
import { requiresWriterLease } from "./runner.mjs";
import { computeSourceHashes, runtimeIdentity, DURABLE_FORMAT_VERSION } from "./durable-execution.mjs";
import { admissionDigest, assertAdmissionFrozen } from "../admission/admission-record.mjs";
// STAGE C DURABLE RESUME (AUTOLOOP-V1-STAGE-C-DURABLE-RESUME-TOOL-SELECTION-BIND-CONTINUITY-REPAIR-1):
// bind continuity reuses THE single selector/validator authorities — never a
// second copy. The durable layer persists canonical DATA commitments only.
import { validateToolSelection } from "../admission/policy-projection.mjs";
import { mintTaskCardToolSelectionBind } from "./phase-task-card.mjs";
import { digestOf } from "../canonical-digest.mjs";
import { createBudgetEnforcement } from "../budget/enforcement.mjs";
// STAGE-D BUDGET HANDOVER (DISPOSITION-1): the resume path reconciles the
// reconstructed ledger against runtime evidence through THE existing
// attachBudgetResult authority (NEG13) — never a second reconciliation.
import { attachBudgetResult } from "../budget/graph-wiring.mjs";
// STAGE-D BUDGET HANDOVER: the fresh-era RSL2 barrier must yield terminal
// publication authority to the successor the moment ownership transfers
// mid-run — B's lifecycle closeout is the single real terminal and the
// single RSL3 publication (Contract V1 single-terminal; no archived churn).
import { applyExecutionReviewBarrier } from "../governance/execution-review.mjs";
// STAGE D cross-session rollover: THE durable §9a dispatch fence + §13a
// post-transfer resume gate (single authority; consumed, never forked).
import {
  evaluateCrossSessionResumeGate, throwOnRefusal,
  evaluatePostTransferPublicationAuthority,
} from "../rollover/resume-gate.mjs";
import { observeProviderUsageAndTrigger } from "../rollover/production-wiring.mjs";

export const GRAPH_DURABLE_FORMAT_VERSION = "1.0.0";

export const TOOL_SELECTION_COMMITMENT_SCHEMA = "autoloop.tool-selection-commitment/v1";

export class DurableGraphHoldError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.name = "DurableGraphHoldError";
  }
}

// ── STAGE C durable-resume tool-selection bind continuity (C1/P2 repair) ────
// The checkpoint persists a canonical DATA commitment (the frozen §7 selection
// output + the allocation identity it was minted from) INSIDE the existing
// single C2D snapshot (checksummed, atomically published, single writer).
// On resume the SAME selector/validator authorities re-derive the selection
// and require an exact canonical match before the process-local bind is
// re-minted. Any missing/malformed/tampered/stale commitment is a pre-spawn
// HOLD: applied=false, adapter spawn count 0, tool invocation count 0.
// Only a canonically EMPTY intent (LEGITIMATE_EMPTY) may resume as --no-tools.

function toolSelectionCommitmentForPhase({ executionId, admission, taskAllocation, phaseId, phase, recoveryGeneration }) {
  const nodeRole = requiresWriterLease(phase) ? "writer" : "readonly-analyst";
  const selection = mintTaskCardToolSelectionBind({
    executionId,
    admission,
    taskAllocation,
    nodeRole,
  });
  return {
    schema: TOOL_SELECTION_COMMITMENT_SCHEMA,
    runIdentity: executionId,
    phaseId,
    nodeRole,
    recovery_generation: recoveryGeneration ?? 0,
    allocationIdentity: {
      taskId: taskAllocation.taskId,
      admissionId: taskAllocation.admissionId,
      dimensions: taskAllocation.dimensions,
      allocationId: taskAllocation.allocationId,
    },
    selection,
  };
}

/** Canonical comparison bytes: the §7 output minus wall-clock provenance
 *  and the digest that covers it（the digest itself is verified separately
 *  by validateToolSelection before comparison）. */
function canonicalSelectionBytes(selection) {
  const { selectedAt, selectionDigest, ...rest } = selection;
  return canonicalJson(rest);
}

/**
 * Resume-side continuity gate. Validates every persisted commitment against
 * THE authoritative re-verified admission and the CURRENT runtime/registry/
 * mapping state, then returns the reconstructed authoritative taskAllocation
 * so the production toolSelectionContext derivation can re-mint process-local
 * binds. Throws DurableGraphHoldError on ANY gap — never degrades to no-tools.
 */
export function reconstructToolSelectionContinuity({ executionId, admission, commitments }) {
  if (!admission || typeof admission !== "object" || !admission.admission_id) {
    throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", "selection commitments require the authoritative admission");
  }
  if (!commitments || typeof commitments !== "object" || Array.isArray(commitments)
      || Object.keys(commitments).length === 0) {
    throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", "malformed tool_selection_commitments container");
  }
  let allocation = null;
  for (const phaseId of Object.keys(commitments)) {
    const entry = commitments[phaseId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || entry.schema !== TOOL_SELECTION_COMMITMENT_SCHEMA) {
      throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", `malformed selection commitment for phase ${phaseId}`);
    }
    if (entry.runIdentity !== executionId) {
      throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", `selection commitment run identity mismatch for phase ${phaseId}`);
    }
    if (entry.phaseId !== phaseId || (entry.nodeRole !== "writer" && entry.nodeRole !== "readonly-analyst")) {
      throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", `malformed commitment identity for phase ${phaseId}`);
    }
    if (!Number.isInteger(entry.recovery_generation) || entry.recovery_generation < 0) {
      throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", `malformed commitment generation for phase ${phaseId}`);
    }
    const ai = entry.allocationIdentity;
    if (!ai || typeof ai !== "object" || Array.isArray(ai)
        || typeof ai.taskId !== "string" || ai.taskId.length === 0
        || typeof ai.admissionId !== "string"
        || typeof ai.allocationId !== "string"
        || !ai.dimensions || typeof ai.dimensions !== "object" || Array.isArray(ai.dimensions)) {
      throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", `malformed allocation identity for phase ${phaseId}`);
    }
    if (digestOf({ taskId: ai.taskId, admissionId: ai.admissionId, dimensions: ai.dimensions }) !== ai.allocationId) {
      throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", `allocation binding digest mismatch (substituted/reconstructed allocation) for phase ${phaseId}`);
    }
    if (ai.admissionId !== admission.admission_id) {
      throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", `selection commitment bound to a different admission for phase ${phaseId}`);
    }
    if (typeof admission.task_id === "string" && ai.taskId !== admission.task_id) {
      throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", `allocation taskId != admission.task_id for phase ${phaseId}`);
    }
    const persistedSelection = entry.selection;
    // THE one validator: digest integrity + authoritative identity resolution
    // + registry/mapping/runtime currency + deterministic replay fidelity.
    const verdict = validateToolSelection(persistedSelection, {
      authorityBinding: {
        taskId: ai.taskId,
        taskAllocationDigest: ai.allocationId,
        taskAllocationDimensions: ai.dimensions,
        runIdentity: executionId,
        admissionId: admission.admission_id,
        admissionDigestValue: admissionDigest(admission),
        admission,
      },
    });
    if (!verdict.ok) {
      throw new DurableGraphHoldError(verdict.code ?? "TOOL_SELECTION_PROVENANCE_INVALID", `persisted selection rejected on resume for phase ${phaseId}: ${verdict.reason}`);
    }
    // Exact canonical recomputation through THE single mint under the
    // CURRENT observed runtime — byte-equality minus wall-clock selectedAt.
    let recomputed;
    try {
      recomputed = mintTaskCardToolSelectionBind({
        executionId,
        admission,
        taskAllocation: { taskId: ai.taskId, admissionId: ai.admissionId, dimensions: ai.dimensions, allocationId: ai.allocationId },
        nodeRole: entry.nodeRole,
      });
    } catch (e) {
      throw new DurableGraphHoldError(e?.code ?? "TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT", `recomputed selection rejected on resume for phase ${phaseId}: ${e?.code}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    if (canonicalSelectionBytes(recomputed) !== canonicalSelectionBytes(persistedSelection)) {
      throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", `recomputed selection does not exactly match the persisted commitment for phase ${phaseId}`);
    }
    const entryAllocation = { taskId: ai.taskId, admissionId: ai.admissionId, dimensions: ai.dimensions, allocationId: ai.allocationId };
    if (allocation && canonicalJson(allocation) !== canonicalJson(entryAllocation)) {
      throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", "commitments disagree on the run's task allocation identity");
    }
    allocation = allocation ?? entryAllocation;
  }
  return { allocation };
}

const TERMINAL_EVENT_FOR = Object.freeze({ PASS: "RUN_PASSED", HOLD: "RUN_HELD", NOT_BENEFICIAL: "RUN_NOT_BENEFICIAL" });

function policyHash(value) {
  try {
    return sha256Text(canonicalJson(value ?? null));
  } catch {
    return sha256Text("unhashable");
  }
}

/** Deterministic writer side-effect identity（Stage 8）: stable across attempts. */
export function writerSideEffectId({ executionId, phaseId, graphGeneration = 0 }) {
  return sha256Text(`autoloop:writer:${executionId}:${phaseId}:${graphGeneration}`).slice(0, 24);
}

/**
 * DE-2 production resume requires the real（dirty）worktree to be resumable.
 * The graph records the FROZEN dirty set（filtered of the graph's own output
 * scope）at start; resume accepts the same filtered set and rejects drift.
 */
export function captureWorktreeDirtyState(repoRoot, dirtyScope = []) {
  let porcelain = "";
  try {
    porcelain = execFileSync("git", ["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch { return { porcelain: "", filteredDigest: null }; }
  return {
    porcelain,
    filteredDigest: porcelain.length === 0 ? "clean" : `dirty_filtered:${sha256Text(filterDirtyPorcelain(porcelain, dirtyScope))}`,
  };
}

/** Drop porcelain lines whose path lies under any allowed output dir. */
function filterDirtyPorcelain(porcelain, dirtyScope = []) {
  if (dirtyScope.length === 0) return porcelain;
  const norm = (p) => p.replace(/\\/g, "/").replace(/^"|"$/g, "").replace(/\/+$/g, "");
  const scopes = dirtyScope.map((s) => norm(String(s)).replace(/^\/+|\/+$/g, ""));
  return porcelain.split("\n").filter((line) => {
    const path = norm(line.slice(3));
    // match both directions: a concrete path under a scope, and a collapsed
    // untracked-dir line（git reports `?? docs/` for a fully-untracked dir）
    // that CONTAINS the scope.
    return !scopes.some((s) => path === s || path.startsWith(`${s}/`) || s.startsWith(`${path}/`));
  }).join("\n");
}

/**
 * Resume dirty policy: allowed when clean, when the current filtered dirty
 * digest matches the frozen permitted digest, or when the delta is confined
 * to the graph's own output scope. Anything else fails closed.
 */
export function resumeDirtyAllowed({ currentPorcelain, permittedDigest, dirtyScope = [] }) {
  const filtered = filterDirtyPorcelain(currentPorcelain, dirtyScope);
  const currentDigest = currentPorcelain.trim().length === 0 ? "clean" : `dirty_filtered:${sha256Text(filtered)}`;
  if (currentDigest === "clean") return true;
  return currentDigest === permittedDigest;
}

/**
 * Durable Graph run context — the production Graph counterpart of DurableRun.
 * Owns the durable state machine ONLY; never scheduler / topology / policy.
 */
export class DurableGraphRun {
  constructor({ ir, parent, manifest, cwd, repoPath, scratchRoot, maxRepairAttempts, timeoutMs, signal, hooks, persistence, recovery = null, dirtyScope = [], admission = null, budget = null, rolloverRequestExecutor = null, rolloverSessionBinding = null }) {
    const identity = validateRunIdentity(persistence.executionId);
    this.ir = ir ?? null;
    this.parent = parent;
    this.manifest = manifest;
    this.cwd = cwd;
    this.repoPath = repoPath;
    this.scratchRoot = scratchRoot;
    this.dirtyScope = dirtyScope;
    this.maxRepairAttempts = maxRepairAttempts;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.hooks = hooks || {};
    this.executionId = identity.executionId;
    this.chainId = identity.chainId;
    this.checkpointId = identity.checkpointId;
    this.root = persistence.root;

    this.store = null;
    this.execDir = null;
    this.createdAt = new Date().toISOString();
    this.repoFingerprint = null;
    this.inputFingerprint = null;
    this.configurationFingerprint = null;
    this.irSha = null;
    this.dagSha = null;
    this.decompositionManifestId = null;
    this.finalVerdict = null;
    this.finalReason = null;
    this.manifestSha = null;
    // TA-2 admission binding（compatibility surface — the PRODUCTION
    // entrypoint is runAdmittedGraph / runDurableGraphAdmitted in
    // src/admission/admission-gate.mjs; frozen into the configuration
    // fingerprint; a changed admission changes the fingerprint -> resume
    // drift HOLD）.
    this.admission = admission ?? null;
    this.admissionFingerprint = admission ? admissionDigest(admission) : null;
    // STAGE D: authorized mid-run rollover executor (coordinator intake).
    // Invoked ONCE at the first between-phase boundary; the §9a gate then
    // refuses all further A-side dispatch (handover-hold is A's real outcome).
    this.rolloverRequestExecutor = rolloverRequestExecutor ?? null;
    // STAGE D: successor binding forwarded by THE gated resume entry; used by
    // the between-phase gate to distinguish B-era continuation from A drift.
    this.rolloverSessionBinding = rolloverSessionBinding ?? null;
    // STAGE C durable-resume continuity: the authoritative allocation the
    // canonical tool selection was minted from（budget.allocation injected by
    // runAdmittedGraph）; drives commitment persistence at phase boundaries.
    this.selectionAllocation = budget?.allocation ?? null;
    // STAGE-D BUDGET HANDOVER: crash-consistent ledger persistence reads the
    // LIVE enforcement at every checkpoint（same object the runner settles
    // into — never a second meter）.
    this.budgetRef = budget ?? null;

    // DE-2 recovery provenance（Stage 14/26）: executionAttempt /
    // recoveryGeneration / replayOf / resumed / recovered /
    // duplicateSuppressed. recovery=null => fresh first attempt.
    this.recovery = recovery;

    this.state = {
      phaseStates: {},
      phaseAttempts: {},
      phaseResultHashes: {},
      completedPhaseIds: [],
      activePhase: null,
      activeLifecycleStage: null,
      writerPhaseActive: false,
      writerLeaseHolder: null,
      expectedRevision: 0,
      pendingResults: {},
      // STAGE C durable-resume continuity: per-phase canonical selection
      // commitments（persisted inside every published snapshot）
      selectionCommitments: {},
      // STAGE D: the durable rollover block mirror (graph.rollover). Null on
      // fresh runs; seeded from disk truth on resume; carried inside EVERY
      // subsequent publication so rollover state survives normal checkpoints.
      rolloverMirror: null,
      sideEffectIds: {},
      worktreeInfo: {},
      // DE-2 Stage 12: repair budget used（must survive restart）
      repairBudgetUsed: 0,
      // DE-2 production resume: frozen filtered dirty digest
      permittedDirtyDigest: null,
      // STAGE C durable-resume continuity: per-phase canonical selection
      // commitments（persisted inside every published snapshot）
      selectionCommitments: {},
    };
    // DE-2 repair: serialize checkpoint publication. With fast phases the
    // runner-view checkpoint（_onRunnerView）and a phase's lifecycle
    // checkpoint（onExecutorCompleted / onSystemDeltaReady /
    // onReviewerCompleted）can overlap; both read state.expectedRevision and
    // publish under C2D CAS — an overlap would fail closed with
    // CHECKPOINT_STALE_REVISION. The chain runs checkpoints one at a time so
    // the single-writer authority is never contended from inside one run.
    this._checkpointChain = Promise.resolve();
  }

  _resumePolicy() {
    const safeBoundary = this.state.activePhase === null && this.finalVerdict === null;
    return {
      safe_boundary: safeBoundary,
      interrupted_writer: false,
      max_repair_attempts: this.maxRepairAttempts,
      timeout_ms: this.timeoutMs,
    };
  }

  _graphInputFingerprint() {
    // The production Graph consumes an already-decomposed IR; the input
    // fingerprint covers caller's non-IR inputs plus scratch namespace and
    // repository binding. A resume may not silently switch cleanup storage.
    return buildInputFingerprint({
      source: null,
      parent: this.parent,
      manifest: this.manifest,
      repoPath: this.repoPath,
      scratchRoot: this.scratchRoot,
    });
  }

  _configurationFingerprint() {
    return buildConfigurationFingerprint({
      maxRepairAttempts: this.maxRepairAttempts,
      timeoutMs: this.timeoutMs,
      toolPolicy: this.hooks.toolPolicy,
      environmentAllowlist: this.hooks.environmentAllowlist,
      expectedReviewerModel: this.hooks.expectedReviewerModel,
      runtime: runtimeIdentity(),
      sourceHashes: computeSourceHashes(),
      persistenceFormatVersion: AUTOLOOP_CHECKPOINT_FORMAT_VERSION,
      // TA-2: the frozen admission digest is part of the configuration
      // identity（admission changes -> fingerprint mismatch -> HOLD）.
      admissionFingerprint: this.admissionFingerprint,
      // DE-2: the production Graph path's identity includes its execution
      // wiring（repoPath + scratchRoot are part of the durable contract）.
      executorAdapterPolicyHash: policyHash(this.hooks.executorAdapterPolicy ?? null),
      reviewerAdapterPolicyHash: policyHash(this.hooks.reviewerAdapterPolicy ?? null),
    });
  }

  /** Publish a checkpoint（journal head frozen BEFORE the CHECKPOINT_PUBLISHED record）. */
  async checkpoint({ activePhase, activeLifecycleStage, finalVerdict }) {
    // Serialize against concurrent lifecycle / runner-view checkpoints（see
    // constructor note）. Every checkpoint releases its gate in finally, so
    // a failed publication can never deadlock the chain.
    const prev = this._checkpointChain;
    let release = null;
    const gate = new Promise((r) => { release = r; });
    this._checkpointChain = prev.then(() => gate);
    await prev;
    try {
      return await this._publishCheckpoint({ activePhase, activeLifecycleStage, finalVerdict });
    } finally {
      release?.();
    }
  }

  /** The actual single-writer publication（runs serialized via checkpoint()）. */
  async _publishCheckpoint({ activePhase, activeLifecycleStage, finalVerdict }) {
    const head = this.store.journalHead;
    const pub = await publishCheckpoint({
      root: this.root,
      executionId: this.executionId,
      chainId: this.chainId,
      checkpointId: this.checkpointId,
      repositoryFingerprint: this.repoFingerprint,
      inputFingerprint: this.inputFingerprint,
      configurationFingerprint: this.configurationFingerprint,
      irSha: this.irSha,
      dagSha: this.dagSha,
      journalHead: head,
      phaseStates: this.state.phaseStates,
      phaseAttempts: this.state.phaseAttempts,
      phaseResultHashes: this.state.phaseResultHashes,
      completedPhaseIds: this.state.completedPhaseIds,
      activePhase: activePhase ?? this.state.activePhase,
      activeLifecycleStage: activeLifecycleStage ?? this.state.activeLifecycleStage,
      writerPhaseActive: this.state.writerPhaseActive,
      writerLeaseHolder: this.state.writerLeaseHolder,
      finalVerdict: finalVerdict ?? this.finalVerdict,
      resumePolicy: this._resumePolicy(),
      expectedRevision: this.state.expectedRevision,
      created_at: this.createdAt,
      snapshotOverrides: {
        // DE-2 additive graph fields（inside the C2D snapshot, single writer）
        graph: {
          execution_id: this.executionId,
          side_effect_ids: { ...this.state.sideEffectIds },
          // STAGE C durable-resume continuity: canonical selection
          // commitments ride INSIDE the single checksummed snapshot — no
          // sidecar, no second checksum, no second durable authority.
          tool_selection_commitments: { ...this.state.selectionCommitments },
          worktree_info: { ...this.state.worktreeInfo },
          repair_budget_used: this.state.repairBudgetUsed,
          recovery_generation: this.recovery?.recoveryGeneration ?? 0,
          recovery_attempt: this.recovery?.executionAttempt ?? 1,
          permitted_dirty_digest: this.state.permittedDirtyDigest ?? null,
          ...(this.state.rolloverMirror ? { rollover: this.state.rolloverMirror } : {}),
        },
        // I1: decomposition manifest digest（resume verifies recomputed ==
        // artifact == checkpoint）.
        ...(this.decompositionManifestId ? { decomposition_manifest_sha256: this.decompositionManifestId } : {}),
      },
    });
    this.state.expectedRevision = pub.revision;
    // STAGE-D BUDGET HANDOVER: the metered ledger must be crash-consistent
    // with every checkpoint — a successor killed mid-era MUST NOT roll back
    // to a stale budget-ledger.json on the next resume. The cumulative
    // snapshot rides THE append-only journal (the artifact is
    // exclusive-create / immutable by the sealed evidence model); the resume
    // seam reads the LATEST snapshot. Same single ledger authority — never a
    // second meter; in-flight reservations fold at their reserved upper
    // bound on reconstruction per §6.
    if (this.budgetRef?.enforcement) {
      try {
        this.store.appendEvent({
          event_type: "BUDGET_LEDGER_SNAPSHOT",
          stage: "checkpoint",
          payload: { ledger: this.budgetRef.enforcement.checkpointState() },
        });
      } catch { /* evidence-only: a write failure never changes the outcome */ }
    }
    this.store.appendEvent({
      event_type: "CHECKPOINT_PUBLISHED",
      stage: "checkpoint",
      payload: { revision: pub.revision, digest: pub.digest, journal_head_sequence: head.seq },
    });
    return pub;
  }

  /** Terminal runner-view diff（authoritative phase transitions）+ journal + checkpoint. */
  async _onRunnerView(view) {
    this.state.phaseStates = view.statuses;
    this.state.writerLeaseHolder = view.leaseHolder;
    const prev = this.state._lastRunnerStatuses || {};
    const newlyTerminal = [];
    for (const [id, s] of Object.entries(view.statuses)) {
      if (s === "skipped_due_to_dependency") continue;
      if ((s === "passed" || s === "held" || s === "failed") && prev[id] !== s) newlyTerminal.push(id);
    }
    for (const id of newlyTerminal) {
      const s = view.statuses[id];
      const result = this.state.pendingResults[id]
        || { final: s === "passed" ? "PASS" : "HOLD", attempt: null, reason: "PENDING_RESULT_SYNTHESIZED", synthesized: true };
      this.store.appendEvent({
        event_type: s === "passed" ? "PHASE_PASSED" : s === "held" ? "PHASE_HELD" : "PHASE_FAILED",
        stage: "phase",
        phase_id: id,
        attempt: result.attempt ?? null,
        status: s,
        payload: { final: result.final, reason: result.reason ?? null },
      });
      const resultRecord = {
        phase_id: id,
        final: result.final,
        status: s,
        attempt: result.attempt ?? null,
        reason: result.reason ?? null,
        graph_generation: this.recovery?.recoveryGeneration ?? 0,
        recorded_at: new Date().toISOString(),
        ...(result.synthesized ? { synthesized: true } : {}),
      };
      const written = this.store.writePhaseArtifact(id, "result.json", resultRecord);
      this.state.phaseResultHashes[id] = written.sha256;
      if (s === "passed") {
        if (!this.state.completedPhaseIds.includes(id)) this.state.completedPhaseIds.push(id);
      }
      try { await this.hooks.onDurableEvent?.({ event_type: s === "passed" ? "PHASE_PASSED" : s === "held" ? "PHASE_HELD" : "PHASE_FAILED", phase_id: id, pre_checkpoint: true }); } catch { /* harness seam only */ }
      await this.checkpoint({});
    }
    for (const id of view.newlySkipped || []) {
      this.store.appendEvent({ event_type: "PHASE_SKIPPED", stage: "phase", phase_id: id, status: "skipped_due_to_dependency", payload: {} });
      try { await this.hooks.onDurableEvent?.({ event_type: "PHASE_SKIPPED", phase_id: id, pre_checkpoint: true }); } catch { /* harness seam only */ }
    }
    if ((view.newlySkipped || []).length > 0) {
      await this.checkpoint({});
    }
    this.state._lastRunnerStatuses = view.statuses;
  }

  /** Durable hooks composed with the caller's hooks; runColimaGraph invokes them. */
  buildGraphHooks(ir) {
    const self = this;
    // DE-2 crash-injection / observability seam（Stage 19）: an optional
    // onDurableEvent observer fires at each journal boundary BEFORE the
    // checkpoint so a test harness can SIGKILL the process inside the
    // journal->checkpoint sub-window. Never affects production semantics
    //（observation only; failures are swallowed by the harness）.  
    const durableEvent = async (info) => {
      try { await self.hooks.onDurableEvent?.(info); } catch { /* harness seam only */ }
    };
    // recovery-generation-prefixed artifact names: a resumed process re-runs
    // the lifecycle from attempt 0, so attempt-scoped names must NOT collide
    // with the crashed generation's artifacts（repair / resume-safe re-run）.
    const gen = self.recovery?.recoveryGeneration ?? 0;
    return {
      ...self.hooks,
      onPhaseStart: async (arg) => {
        // runColimaGraph may call hooks positionally（phaseId）or as an event
        // object（{ phaseId }）— normalize both.
        const phaseId = typeof arg === "string" ? arg : arg?.phaseId;
        // ── STAGE D: authorized mid-run rollover intake. Runs ONCE at a
        // between-phase safe boundary AFTER at least one completed phase
        // (quiescence by construction: no executor/reviewer in flight); on
        // return the §9a gate below refuses all further A-side dispatch —
        // A's truthful handover-hold outcome.
        self.state._phaseStartCount = (self.state._phaseStartCount ?? 0) + 1;
        if (typeof self.rolloverRequestExecutor === "function"
            && !self.state._rolloverExecuted
            && self.state._phaseStartCount > 1) {
          self.state._rolloverExecuted = true;
          await self.rolloverRequestExecutor(self);
          // Handover happened: resync THIS runner's view to durable truth so
          // any subsequent hold-path publication CASes against the LIVE head
          // (the authority advanced the chain several revisions).
          const freshHead = readCheckpoint(self.root, self.executionId);
          self.state.expectedRevision = freshHead.snapshot.revision;
          self.state.rolloverMirror = freshHead.snapshot.graph?.rollover ?? null;
        }
        // ── STAGE D §9a: between-phase dispatch gate. Read the checksummed
        // CURRENT mirror; while an ACTIVE pre-commit rollover freezes the
        // owner-of-record, zero adapter invocations / budget events happen —
        // the phase dispatch itself is refused (durable fence, not memory).
        try {
          const gateSnap = readCheckpoint(this.root, this.executionId).snapshot;
          const gate = evaluateCrossSessionResumeGate({ snapshot: gateSnap, sessionBinding: self.rolloverSessionBinding, execDir: self.execDir ?? join(self.root, self.executionId) });
          if (gate.action === "REFUSE") {
            try {
              self.store.appendEvent({
                event_type: "ROLLOVER_HANDOVER_FENCE",
                stage: "rollover",
                phase_id: phaseId,
                payload: { code: gate.code, reason: gate.reason },
              });
            } catch { /* best-effort observability */ }
            throw new DurableGraphHoldError(gate.code, gate.reason);
          }
        } catch (e) {
          if (e instanceof DurableGraphHoldError) throw e;
          if (String(e?.code ?? "").includes("ENOENT") || e?.code === "ENOENT") {
            // CURRENT not yet created (pre-first-checkpoint window): nothing
            // to fence — the normal ladder owns absence semantics.
            return;
          }
          // Any OTHER read/parse failure is fail-closed, never fail-open:
          // an unreadable owner truth cannot authorize a dispatch.
          throw new DurableGraphHoldError("CROSS_SESSION_CHECKPOINT_MISMATCH",
            `between-phase gate could not verify rollover truth: ${String(e?.code ?? e?.name ?? e)}`);
        }
        const phase = (ir.phases || []).find((p) => p.phase_id === phaseId);
        const writer = phase ? requiresWriterLease(phase) : false;
        self.state.activePhase = phaseId;
        self.state.activeLifecycleStage = null;
        self.state.writerPhaseActive = writer;
        self.state.writerLeaseHolder = writer ? phaseId : null;
        // DE-2 Stage 8: deterministic side-effect identity per phase.
        if (writer) {
          self.state.sideEffectIds[phaseId] = writerSideEffectId({
            executionId: self.executionId,
            phaseId,
            graphGeneration: self.recovery?.recoveryGeneration ?? 0,
          });
        }
        // DE-2 Stage 9: persist the writer worktree identity the production
        // graph prepared（colima worktree runs BEFORE this hook）.
        if (writer && phase?.runtime) {
          self.state.worktreeInfo[phaseId] = {
            worktreeDir: phase.runtime.worktreePath ?? null,
            cloneDir: phase.runtime.cloneDir ?? null,
            head: phase.runtime.worktreeHead ?? null,
            verified: phase.runtime.worktreeVerified?.ok ?? false,
            baseline_digest: policyHash(phase.runtime.worktreeBaseline ?? null),
          };
        }
        self.store.appendEvent({ event_type: "PHASE_READY", stage: "phase", phase_id: phaseId, payload: {} });
        await durableEvent({ event_type: "PHASE_READY", phase_id: phaseId, pre_checkpoint: true });
        // STAGE C durable-resume continuity: commit the canonical selection
        // for THIS phase BEFORE the PHASE_STARTED checkpoint publishes it and
        // before any adapter can spawn. Canonical DATA only（§7 output +
        // allocation identity）— never the authority object/closure.
        if (self.admission && self.selectionAllocation && phase
            && !self.state.selectionCommitments[phaseId]) {
          self.state.selectionCommitments[phaseId] = toolSelectionCommitmentForPhase({
            executionId: self.executionId,
            admission: self.admission,
            taskAllocation: self.selectionAllocation,
            phaseId,
            phase,
            recoveryGeneration: self.recovery?.recoveryGeneration ?? 0,
          });
        }
        self.store.appendEvent({ event_type: "PHASE_STARTED", stage: "phase", phase_id: phaseId, payload: { writer, side_effect_id: self.state.sideEffectIds[phaseId] ?? null } });
        await durableEvent({ event_type: "PHASE_STARTED", phase_id: phaseId, pre_checkpoint: true });
        await self.checkpoint({});
        // COMPOSE the caller's own hook（production sub-agent wiring must
        // keep running）: durable journaling lands FIRST so a caller-hook
        // failure can never leave a journaled-but-uncheckpointed boundary.
        try { await self.hooks.onPhaseStart?.(arg); } catch (e) {
          // A caller hook is part of the production phase wiring — a failure
          // is a real graph failure, not a harness seam.
          throw e;
        }
      },
      onPhaseTerminal: async (arg, maybeNode) => {
        const phaseId = typeof arg === "string" ? arg : arg?.phaseId;
        const src = typeof arg === "string" ? (maybeNode ?? {}) : arg;
        const final = src.final ?? "HOLD";
        const attempt = src.attempt ?? null;
        const reason = src.reason ?? null;
        self.state.pendingResults[phaseId] = {
          final,
          attempt: attempt ?? null,
          reason: reason ?? null,
          graph_generation: self.recovery?.recoveryGeneration ?? 0,
        };
        // ── WP1: AUTOMATIC CONTEXT TRIGGER PRODUCER (observation point) ──
        // The provider-reported usage from THIS phase's executor (or null)
        // is observed DURABLY here. A trigger is produced only from real
        // provider usage against the frozen admission threshold; an
        // observation failure is journal observability only — A continues
        // if otherwise legal. Never a fabricated trigger, never a
        // RECOVERABLE_SESSION_FAILURE emission.
        if (self.rolloverRequestExecutor && self.admission) {
          try {
            self.state._rolloverObservation = observeProviderUsageAndTrigger({
              store: self.store,
              admission: self.admission,
              usage: src?.providerUsage ?? null,
              executionId: self.executionId,
              phaseId,
            });
          } catch (e) {
            self.state._rolloverObservation = { triggered: false, observed: false, reason: `observation error: ${String(e?.code ?? e?.message ?? e).slice(0, 120)}` };
          }
        }
        // COMPOSE the caller's own hook（production sub-agent wiring keeps
        // persisting reviewed results + attaching reviewResult）with the same
        // node object the graph runner produced.
        try { await self.hooks.onPhaseTerminal?.(phaseId, src); } catch (e) { throw e; }
      },
      lifecycle: {
        onExecutorOutput: async (info) => {
          const { phaseId, attempt, diagnostic } = info;
          try {
            self.store.writePhaseArtifact(phaseId, `g${gen}-executor-output-${attempt ?? 0}.json`, diagnostic ?? {});
          } catch (e) {
            if (e instanceof EvidenceHoldError) throw new DurableGraphHoldError("DURABLE_EVIDENCE_SECRET_RISK", e.message);
            throw e;
          }
          try { await self.hooks.lifecycle?.onExecutorOutput?.(info); } catch (e) { throw e; }
        },
        onExecutorCompleted: async (info) => {
          const { phaseId, attempt, evidence } = info;
          self.state.activeLifecycleStage = "executor_completed";
          try {
            self.store.writePhaseArtifact(phaseId, `g${gen}-implementation-evidence-${attempt ?? 0}.json`, evidence ?? {});
          } catch (e) {
            if (e instanceof EvidenceHoldError) throw new DurableGraphHoldError("DURABLE_EVIDENCE_SECRET_RISK", e.message);
            throw e;
          }
          self.store.appendEvent({
            event_type: "EXECUTOR_COMPLETED",
            stage: "phase",
            phase_id: phaseId,
            attempt,
            payload: { evidence_hash: evidence ? sha256Text(canonicalJson(evidence)) : null },
          });
          await durableEvent({ event_type: "EXECUTOR_COMPLETED", phase_id: phaseId, pre_checkpoint: true });
          await self.checkpoint({});
          try { await self.hooks.lifecycle?.onExecutorCompleted?.(info); } catch (e) { throw e; }
        },
        onSystemDeltaReady: async (info) => {
          const { phaseId, attempt, delta } = info;
          self.state.activeLifecycleStage = "system_delta_ready";
          try {
            self.store.writePhaseArtifact(phaseId, `g${gen}-reviewer-system-delta-${attempt ?? 0}.json`, delta.persistable_json);
            self.store.writePhaseRawArtifact(phaseId, `g${gen}-reviewer-system-delta-${attempt ?? 0}.patch`, delta.patch.text);
          } catch (e) {
            try {
              self.store.appendEvent({
                event_type: "SYSTEM_DELTA_PERSISTENCE_FAILED",
                stage: "phase",
                phase_id: phaseId,
                attempt,
                payload: { error: e?.code || e?.name || "unknown" },
              });
            } catch { /* best-effort; the hold below is the authority */ }
            if (e instanceof EvidenceHoldError) throw new DurableGraphHoldError("DURABLE_EVIDENCE_SECRET_RISK", e.message);
            throw e;
          }
          self.store.appendEvent({
            event_type: "SYSTEM_DELTA_READY",
            stage: "phase",
            phase_id: phaseId,
            attempt,
            payload: {
              patch_sha256: delta.patch.sha256,
              json_artifact_sha256: delta.artifacts.json.sha256,
              patch_artifact_sha256: delta.artifacts.patch.sha256,
              changed_path_count: Array.isArray(delta.changed_paths) ? delta.changed_paths.length : 0,
            },
          });
          await self.checkpoint({});
          try { await self.hooks.lifecycle?.onSystemDeltaReady?.(info); } catch (e) { throw e; }
        },
        onReviewerCompleted: async (info) => {
          const { phaseId, attempt, verdict, verdictObject } = info;
          self.state.activeLifecycleStage = "reviewer_completed";
          try {
            self.store.writePhaseArtifact(phaseId, `g${gen}-reviewer-verdict-${attempt ?? 0}.json`, verdictObject ?? { verdict });
          } catch (e) {
            if (e instanceof EvidenceHoldError) throw new DurableGraphHoldError("DURABLE_EVIDENCE_SECRET_RISK", e.message);
            throw e;
          }
          self.store.appendEvent({
            event_type: "REVIEWER_COMPLETED",
            stage: "phase",
            phase_id: phaseId,
            attempt,
            payload: { verdict: verdict ?? null },
          });
          await durableEvent({ event_type: "REVIEWER_COMPLETED", phase_id: phaseId, pre_checkpoint: true });
          await self.checkpoint({});
          try { await self.hooks.lifecycle?.onReviewerCompleted?.(info); } catch (e) { throw e; }
        },
        onRepairRequested: async (info) => {
          const { phaseId, attempt } = info;
          self.store.appendEvent({ event_type: "PHASE_REPAIR_REQUESTED", stage: "phase", phase_id: phaseId, attempt, payload: {} });
          // Stage 12: repair budget used must survive restart.
          self.state.repairBudgetUsed = Math.min(self.maxRepairAttempts, (self.state.repairBudgetUsed ?? 0) + 1);
          self.state.phaseAttempts[phaseId] = attempt ?? null;
          try { await self.hooks.onDurableEvent?.({ event_type: "PHASE_REPAIR_REQUESTED", phase_id: phaseId, pre_checkpoint: false }); } catch { /* harness seam only */ }
          try { await self.hooks.lifecycle?.onRepairRequested?.(info); } catch (e) { throw e; }
        },
      },
      runner: {
        ...(self.hooks.runner ?? {}),
        onCheckpoint: (view) => self._onRunnerView(view),
      },
    };
  }

  /** Terminal: journal RUN_* + checkpoint + manifest（mirror terminateDurableRun）. */
  async terminal(final, reason) {
    this.finalVerdict = final;
    this.finalReason = reason;
    let checkpoint = null;
    try {
      this.store.appendEvent({ event_type: TERMINAL_EVENT_FOR[final] || "RUN_HELD", stage: "terminal", payload: { reason: reason ?? null } });
      await this.checkpoint({ finalVerdict: final, activePhase: null, activeLifecycleStage: null, writerPhaseActive: false, writerLeaseHolder: null });
      checkpoint = readCheckpoint(this.root, this.executionId);
      const journal = this.store.verifyJournal();
      const manifest = buildRunManifest({
        executionId: this.executionId,
        chainId: this.chainId,
        created_at: this.createdAt,
        completed_at: new Date().toISOString(),
        final_verdict: final,
        final_reason: reason,
        input_fingerprint: this.inputFingerprint,
        configuration_fingerprint: this.configurationFingerprint,
        repository_fingerprint: this.repoFingerprint,
        decomposition_ir_sha256: this.irSha,
        dag_sha256: this.dagSha,
        journal_event_count: journal.count,
        journal_head_sha256: journal.head,
        checkpoint_revision: checkpoint.snapshot.revision,
        checkpoint_sha256: checkpoint.digest,
        phase_results: this.state.completedPhaseIds.map((id) => ({ phase_id: id, result_hash: this.state.phaseResultHashes[id] ?? null })),
        artifact_inventory: artifactInventory(this.execDir),
        secret_scan_result: { scanned: true, matches: [] },
        format_versions: {
          evidence: "1.0.0",
          journal: "1.0.0",
          manifest: MANIFEST_FORMAT_VERSION,
          checkpoint: AUTOLOOP_CHECKPOINT_FORMAT_VERSION,
          graph_durable: GRAPH_DURABLE_FORMAT_VERSION,
        },
      });
      const finalized = finalizeRunManifest(this.execDir, manifest);
      this.manifestSha = finalized.sha256;
      this.store.appendEvent({ event_type: "MANIFEST_FINALIZED", stage: "terminal", payload: { manifest_sha256: finalized.sha256 } });
      await this.checkpoint({ finalVerdict: final, activePhase: null, activeLifecycleStage: null, writerPhaseActive: false, writerLeaseHolder: null });
    } catch (e) {
      this.finalVerdict = "HOLD";
      this.finalReason = `TERMINAL_EVIDENCE_FAILURE:${e?.code || e?.name || "unknown"}`;
    }
  }

  /** DE-2 Stage 27: machine-readable recovery manifest（no secrets/content blobs）. */
  buildRecoveryManifest() {
    return {
      schema: "autoloop.recovery-manifest/v1",
      format_version: GRAPH_DURABLE_FORMAT_VERSION,
      graphRunId: this.executionId,
      executionAttempt: this.recovery?.executionAttempt ?? 1,
      recoveryGeneration: this.recovery?.recoveryGeneration ?? 0,
      resumed: this.recovery?.resumed ?? false,
      replayOf: this.recovery?.replayOf ?? null,
      checkpointIdentity: this.checkpointId,
      journalHead: this.store ? { seq: this.store.journalHead.seq, sha256: this.store.journalHead.sha256 } : null,
      repoIdentity: this.repoFingerprint?.repository_root_identity ?? null,
      worktreeIdentity: this.repoFingerprint?.worktree_identity ?? null,
      nodeStates: { ...this.state.phaseStates },
      attemptStates: { ...this.state.phaseAttempts },
      writerState: {
        active: this.state.writerPhaseActive,
        leaseHolder: this.state.writerLeaseHolder,
        sideEffectIds: { ...this.state.sideEffectIds },
        worktreeInfo: { ...this.state.worktreeInfo },
      },
      repairBudget: { max: this.maxRepairAttempts, used: this.state.repairBudgetUsed },
      memoryWritebackState: this.graphResult?.writeback?.ok === true ? { ok: true, recordsWritten: this.graphResult.writeback.recordsWritten ?? null } : { ok: false },
      telemetryRecoveryState: this.graphResult?.telemetry ?? null,
      unresolvedRecoveryActions: [],
      finalDisposition: this.finalVerdict ?? null,
    };
  }
}

function artifactInventory(execDir) {
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else out.push(r);
    }
  };
  walk(execDir, "");
  return out.sort();
}

/** Build a durable graph result envelope（recovery provenance + evidence）on top of runColimaGraph's result. */
function buildGraphResultEnvelope(run, graphResult) {
  const base = {
    ...graphResult,
    recovery: {
      executionAttempt: run.recovery?.executionAttempt ?? 1,
      recoveryGeneration: run.recovery?.recoveryGeneration ?? 0,
      replayOf: run.recovery?.replayOf ?? null,
      resumed: run.recovery?.resumed ?? false,
      recovered: run.recovery?.recovered ?? false,
      duplicateSuppressed: run.recovery?.duplicateSuppressed ?? 0,
    },
  };
  base.evidence = {
    root: run.root,
    exec_dir: run.execDir,
    execution_id: run.executionId,
    chain_id: run.chainId,
    checkpoint_revision: run.state.expectedRevision,
    manifest_sha256: run.manifestSha,
    journal_head_sha256: run.store ? run.store.journalHead.sha256 : null,
    final_verdict: run.finalVerdict,
    recovery_manifest: run.buildRecoveryManifest(),
  };
  return base;
}

/**
 * Run the production Graph with STACK_A durability behind it（Stage 3）.
 *
 * Same opts as runColimaGraph PLUS:
 * @param {object} opts.persistence — { root, executionId }（required; durable
 *   mode only）. root must be absolute and outside the repo.
 */
export async function runDurableGraph(opts = {}) {
  const { persistence, ir, parent, manifest, cwd, repoPath, scratchRoot, maxRepairAttempts, timeoutMs, signal, hooks = {}, closeout, closeoutGate, closeoutSourceBuilder, closeoutEvidenceWriter, memory, telemetry, writeback, dirtyScope = [], preserveInstance = false, profile, executorAdapterFactory, reviewerAdapterFactory, admission = null } = opts;
  const requestedScratchAuthorityToken = opts.scratchAuthorityToken ?? null;
  let scratchAuthorityToken = null;
  // TA-3 budget enforcement（production authority — injected by runAdmittedGraph;
  // forwarded to runColimaGraph for the pre-dispatch/settlement chain and
  // persisted here as budget-ledger.json so a RESUME continues cumulative
  // accounting — B3, never a reset）.
  const budget = opts.budget ?? null;
  if (!persistence || typeof persistence.root !== "string" || typeof persistence.executionId !== "string") {
    throw new DurableGraphHoldError("PERSISTENCE_CONFIG_INVALID", "persistence.root and persistence.executionId required");
  }
  const resolvedRoot = assertValidEvidenceRoot(persistence.root, cwd);
  // STAGE D: coordinator-level authorized rollover intake (never a caller
  // override — see AUTHORITATIVE_RUN_KEYS fencing at the sinks).
  const rolloverRequestExecutor = typeof opts.rolloverRequestExecutor === "function" ? opts.rolloverRequestExecutor : null;
  const rolloverSessionBinding = opts.rolloverSessionBinding ?? null;
  const run = new DurableGraphRun({
    ir, parent, manifest, cwd, repoPath, scratchRoot,
    maxRepairAttempts, timeoutMs, signal, hooks, persistence,
    recovery: null,
    dirtyScope,
    admission,
    budget,
    rolloverRequestExecutor,
    rolloverSessionBinding,
  });
  const store = new RunEvidenceStore({
    root: resolvedRoot,
    executionId: run.executionId,
    chainId: run.chainId,
    checkpointId: run.checkpointId,
    repoRoot: cwd,
  });
  run.execDir = store.init();
  run.store = store;
  run.root = resolvedRoot;

  run.repoFingerprint = collectRepositoryFingerprint(cwd);
  // DE-2 production resume: freeze the FILTERED dirty digest（the graph's
  // own output scope excluded）so the real dirty worktree can be resumed.
  const dirtyState = captureWorktreeDirtyState(cwd, run.dirtyScope);
  run.state.permittedDirtyDigest = dirtyState.filteredDigest;
  const frozenInput = { source: null, parent, manifest, repoPath, scratchRoot };
  store.writeArtifact("input.json", frozenInput);
  // TA-2（N/O）: persist the frozen admission alongside the input so a resume
  // can re-verify admission_id（anti-drift）.
  if (admission) store.writeArtifact("admission.json", admission);
  // STAGE C durable-resume continuity: freeze the canonical allocation
  // IDENTITY（digest-verified DATA, never the authority closure）so a fresh-
  // process resume can reconstruct the toolSelectionContext inputs through
  // the existing single selector/validator chain.
  if (admission && budget?.allocation) {
    store.writeArtifact("tool-selection-allocation.json", {
      schema: TOOL_SELECTION_COMMITMENT_SCHEMA,
      allocationIdentity: {
        taskId: budget.allocation.taskId,
        admissionId: budget.allocation.admissionId,
        dimensions: budget.allocation.dimensions,
        allocationId: budget.allocation.allocationId,
      },
    });
  }
  run.inputFingerprint = run._graphInputFingerprint();
  run.configurationFingerprint = run._configurationFingerprint();

  store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
  await run.checkpoint({});
  store.appendEvent({ event_type: "GRAPH_INPUT_FROZEN", stage: "input", payload: { input_fingerprint: run.inputFingerprint } });
  await run.checkpoint({});

  if (!ir || !Array.isArray(ir.phases) || ir.phases.length === 0) {
    return terminateGraphRun(run, "HOLD", "GRAPH_IR_REQUIRED");
  }
  store.writeArtifact("decomposition-ir.json", ir);
  run.irSha = buildIrSha256(ir);
  run.dagSha = buildDagFingerprint(ir);
  run.state.phaseStates = {};
  for (const p of (ir.phases || [])) run.state.phaseStates[p.phase_id] = "pending";
  store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: { phase_count: (ir.phases || []).length, ir_sha256: run.irSha, dag_sha256: run.dagSha } });
  try { await hooks.onDurableEvent?.({ event_type: "DAG_ACCEPTED", phase_id: null, pre_checkpoint: true }); } catch { /* harness seam only */ }
  await run.checkpoint({});

  // ── I1: Decomposition Manifest — produced exactly once per decomposition
  // revision, after DAG_ACCEPTED, through the existing evidence path
  // (secret-scan + size bound + journal + checkpoint). Fail-closed on any
  // missing binding or build failure. CPU + one tree observation only. ──
  const manifestResult = buildDecompositionManifest({
    parentExecutionId: run.executionId,
    chainId: run.chainId,
    parentRevision: sha256Text(canonicalJson(parent)),
    inputFingerprint: run.inputFingerprint,
    configurationFingerprint: run.configurationFingerprint,
    ir,
    irSha: run.irSha,
    dagSha: run.dagSha,
    repositoryIdentity: {
      repository_root_identity: run.repoFingerprint.repository_root_identity,
      expected_head: run.repoFingerprint.expected_head,
      tree: collectRepositoryTree(cwd),
    },
    sourceHashes: computeSourceHashes(),
    promptBuilderVersion: "graph-input-ir",
  });
  if (!manifestResult.ok) {
    return terminateGraphRun(run, "HOLD", `DECOMPOSITION_MANIFEST_INVALID:${manifestResult.code}`);
  }
  store.writeArtifact("decomposition-manifest.json", manifestResult.manifest);
  run.decompositionManifestId = manifestResult.manifest_id;
  store.appendEvent({
    event_type: "DECOMPOSITION_MANIFEST_WRITTEN",
    stage: "decomposition",
    payload: { format_version: DECOMPOSITION_MANIFEST_FORMAT, manifest_sha256: manifestResult.manifest_id, bytes: manifestResult.bytes },
  });
  await run.checkpoint({});

  // Create owned scratch only after durable graph identity/checkpoint exists.
  // A pre-checkpoint crash cannot leave a recursively-deletable child.
  const ownedScratchRoot = prepareOwnedScratchRoot({ scratchRoot, executionId: run.executionId, repoPath, authorityToken: requestedScratchAuthorityToken });
  scratchAuthorityToken = requestedScratchAuthorityToken ?? getScratchAuthorityToken(ownedScratchRoot);
  if (typeof scratchAuthorityToken !== "string") throw new DurableGraphHoldError("SCRATCH_OWNERSHIP_INVALID", "scratch authority unavailable");
  store.writeArtifact("scratch-ownership.json", { schema: "autoloop.scratch-authority/v1", authorityToken: scratchAuthorityToken });

  const graphHooks = run.buildGraphHooks(ir);
  try {
    run.graphResult = await runColimaGraph({
      ir, parent, manifest, cwd, repoPath, scratchRoot,
      executionId: run.executionId,
      profile,
      maxRepairAttempts, timeoutMs, signal,
      hooks: graphHooks,
      initialState: undefined,
      executorAdapterFactory,
      reviewerAdapterFactory,
      preserveInstance,
      budget,
      // STAGE-D BUDGET HANDOVER: the SAME RSL2 authority, gated on durable
      // ownership truth — a fresh-era process whose ownership transferred
      // mid-run has NO terminal publication authority (the handover branch
      // below already refuses the durable terminal; the runner-level review
      // publication must not churn the RSL3 surface either). Pre-transfer
      // failures keep the normal fail-closed barrier.
      executionReviewBarrier: async (barrierArgs) => {
        // REPAIR-1 §8 defense in depth: post-transfer durable states publish
        // ONLY through an owner-validated successor binding (THE gate — no
        // forked decision). The A-era handover skip is unchanged (frozen
        // budget-handover disposition); every OTHER post-transfer state now
        // fails closed without a valid binding.
        const mirrorState = run.state.rolloverMirror?.state ?? null;
        if (mirrorState === "OWNERSHIP_TRANSFER_COMMITTED") {
          return { required: false, ok: true, holdCode: null, reason: null, result: null };
        }
        const pub = evaluatePostTransferPublicationAuthority({
          snapshot: readCheckpoint(resolvedRoot, run.executionId).snapshot,
          sessionBinding: rolloverSessionBinding,
          execDir: run.execDir,
        });
        if (pub.action === "REFUSE") {
          return { required: true, ok: false, holdCode: pub.code, reason: `${pub.code}:${pub.reason}`, result: null };
        }
        return applyExecutionReviewBarrier(barrierArgs);
      },
      scratchAuthorityToken,
      closeout, closeoutGate, closeoutSourceBuilder, closeoutEvidenceWriter,
      memory, telemetry, writeback,
      admission,
      durable: { executionAttempt: 1, recoveryGeneration: 0, resumed: false, replayOf: null, recovered: false, duplicateSuppressed: 0 },
    });
  } catch (e) {
    return terminateGraphRun(run, "HOLD", `GRAPH_EXCEPTION:${e?.code || e?.name || "unknown"}`);
  }

  // TA-3: persist the budget ledger checkpoint（evidence; the graph outcome is
  // already final — a write failure never changes it）. The persisted state
  // carries the admissionId + envelopeId so a resume re-verifies it（NEG12）.
  if (budget?.enforcement) {
    try {
      store.writeArtifact("budget-ledger.json", budget.enforcement.checkpointState());
    } catch { /* evidence-only */ }
  }

  const final = run.graphResult.final === "PASS" ? "PASS" : "HOLD";
  const reason = final === "PASS" ? null : (run.graphResult.reason ?? "GRAPH_HOLD");
  // ── STAGE D handover: when ownership already transferred to the successor
  // (post-commit rollover state), THIS process must NOT publish a terminal
  // verdict for the execution — the run continues under B through the gated
  // resume entry; B's own lifecycle closeout is the single real terminal.
  const handoverStates = new Set(["OWNERSHIP_TRANSFER_COMMITTED"]); // ACTIVE_B era owns terminal publication
  const mirrorState = run.state.rolloverMirror?.state ?? null;
  if (mirrorState && handoverStates.has(mirrorState)) {
    return {
      ...buildGraphResultEnvelope(run, run.graphResult),
      final: "HOLD",
      stage: "rollover_handover",
      holdCode: "CROSS_SESSION_ROLLOVER_IN_PROGRESS_A_FROZEN",
      reason: `CROSS_SESSION_ROLLOVER_HANDOVER:${reason ?? "GRAPH_HOLD"}`,
      handedOver: true,
    };
  }

  await run.terminal(final, reason);
  return buildGraphResultEnvelope(run, run.graphResult);
}

async function terminateGraphRun(run, final, reason) {
  await run.terminal(final, reason);
  return buildGraphResultEnvelope(run, { executionId: run.executionId, final, holdCode: reason, reason, nodeResults: [], transitions: [], scheduler: null, memoryContext: null, join: [], closeout: { applied: false } });
}

/**
 * DE-2R: wipe a scratch root EXCEPT paths preserved by the resume entry.
 *
 * `preserve` holds normalized relative paths under the deterministic owned
 * child derived from caller namespace + execution identity（e.g. `results`).
 * Everything not under a preserved prefix is removed; preserved subtrees
 *（and their parents）are re-created empty so resumed graph can mount/write
 * them. The destructive target is never accepted directly from caller.
 * production-sub-agent-resume counterpart of the plain recursive wipe: the
 * crashed predecessor's worktrees / phase scratch are still reclaimed, but
 * already-persisted sub-agent results are never destroyed.
 */
export function wipeScratchPreserving({ scratchRoot, executionId, repoPath = null, preserve = [], authorityToken = null } = {}) {
  if (typeof authorityToken !== "string") throw new ScratchOwnershipError("scratch authority token required for wipe");
  const ownedRoot = prepareOwnedScratchRoot({ scratchRoot, executionId, repoPath, authorityToken });
  const keep = [
    ".autoloop-owner.json",
    ...preserve.map(normalizeScratchPreservePath),
  ];
  const assertPreserveNoSymlink = (path) => {
    let current = ownedRoot;
    for (const part of path.split("/").filter(Boolean)) {
      current = join(current, part);
      let stat;
      try { stat = lstatSync(current); } catch (e) {
        if (e?.code === "ENOENT") return;
        throw e;
      }
      if (stat.isSymbolicLink()) throw new ScratchOwnershipError(`preserved scratch path contains symlink: ${path}`);
    }
  };
  for (const path of keep) {
    if (path !== ".autoloop-owner.json") assertPreserveNoSymlink(path);
  }
  const isPreserved = (rel) => keep.some((k) => k === rel || rel.startsWith(`${k}/`) || k.startsWith(`${rel}/`));
  const wipe = (dir, rel) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const child = join(dir, e.name);
      if (isPreserved(childRel)) {
        if (e.isSymbolicLink()) throw new ScratchOwnershipError(`preserved scratch path contains symlink: ${childRel}`);
        // A preserved path may sit under this subtree（e.g. keep=exec_x/results
        // while this entry is exec_x）— recurse instead of deleting it, so
        // non-preserved siblings inside the subtree are still reclaimed.
        if (e.isDirectory()) wipe(child, childRel);
        continue;
      }
      try { rmSync(child, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  };
  try { wipe(ownedRoot, ""); } catch (e) {
    if (e instanceof ScratchOwnershipError) throw e;
    /* best-effort for ordinary stale-entry races */
  }
  for (const k of keep) {
    if (k === ".autoloop-owner.json") continue;
    assertPreserveNoSymlink(k);
    try { mkdirSync(join(ownedRoot, k), { recursive: true }); } catch { /* best-effort */ }
    assertPreserveNoSymlink(k);
  }
}

/**
 * Resume a durable production Graph run from disk（Stage 3/25）— a genuinely
 * new process reconstructs execution from durable artifacts only.
 */
export async function resumeDurableGraph({
  persistenceRoot,
  executionId,
  ir: callerIr = null,
  parent, manifest, cwd, repoPath, scratchRoot,
  maxRepairAttempts, timeoutMs, signal, hooks = {}, closeout, closeoutGate, closeoutSourceBuilder, closeoutEvidenceWriter,
  memory, telemetry, writeback,
  dirtyScope = [], preserveInstance = false,
  profile, executorAdapterFactory, reviewerAdapterFactory,
  // TA-2（N）: the authoritative admission must be re-verified on resume —
  // stored admission_id != authoritative -> HOLD / ADMISSION_DRIFT.
  admission = null,
  // TA-3 budget enforcement: { enforcement? } — when absent but the durable
  // store carries a budget-ledger.json, the ledger state is reconstructed
  // and enforcement re-derived from the re-verified admission（cumulative
  // resume — B3; malformed state -> HOLD, NEG12）.
  budget = null,
  // DE-2R: relative paths under scratchRoot that the resume wipe must KEEP.
  // The production sub-agent resume entry preserves
  // `<durableExecutionId>/results` so the crashed run's persisted sub-agent
  // results（dependency identities / review files）survive into the resumed
  // graph. Default keeps today's full-wipe behavior for every other caller.
  scratchPreserve = [],
  // STAGE D: caller's rollover session binding { sessionIdentityDigest,
  // sessionGeneration } — selects WHICH durable-truth branch applies at the
  // §9a/§13a gate; it is never authority by itself (CURRENT is).
  rolloverSessionBinding = null,
} = {}) {
  const identity = validateRunIdentity(executionId);
  if (!checkpointExists(persistenceRoot, executionId)) {
    throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "no checkpoint exists for this execution");
  }
  const { execDir, snapshot, digest: checkpointDigest } = readCheckpoint(persistenceRoot, executionId);

  // ── STAGE D §9a/§13a: THE durable cross-session dispatch pre-step. Read
  // from the checksummed CURRENT BEFORE anything else; while an ACTIVE
  // rollover freezes the owner-of-record every dispatch is refused with
  // zero adapter invocations and zero budget events; post-commit, only the
  // durable successor may pass the five-part fence. ──
  // STAGE-D BUDGET HANDOVER: the verdict (not just refusal) is retained —
  // postTransfer resumes requeue handover-fenced phases so the successor
  // executes the work the fence refused on the source side.
  const resumeGateVerdict = evaluateCrossSessionResumeGate({ snapshot, sessionBinding: rolloverSessionBinding, execDir });
  throwOnRefusal(resumeGateVerdict);
  const store = new RunEvidenceStore({
    root: persistenceRoot,
    executionId: identity.executionId,
    chainId: identity.chainId,
    checkpointId: identity.checkpointId,
  });
  store.init();

  // ── Read-only pre-gate（no journal write / provider call before this）──
  let journal;
  try {
    const major = parseInt(String(snapshot.autoloop_format_version ?? "0").split(".")[0], 10);
    if (major !== 1) throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", `unsupported checkpoint format major ${major}`);
    journal = store.verifyJournal();
    findJournalEventByHead(store, snapshot.journal_head_sequence, snapshot.journal_head_sha256);
  } catch (e) { throw e; }

  const classification = classifyResumeCapability({
    checkpoint: snapshot,
    artifacts: { decompositionIrExists: existsSync(join(execDir, "artifacts", "decomposition-ir.json")) },
    journal: { valid: true, headMatches: true },
  });

  // DE-2 F1: a checkpoint without the IR hash normally means RESTART_REQUIRED.
  // For the production Graph path the IR is caller-provided and written
  // atomically BEFORE the DAG_ACCEPTED journal event（which carries its
  // hashes）— so a crash in the DAG_ACCEPTED->checkpoint sub-window leaves a
  // VERIFIABLE IR artifact + journal reference. Reconstruct instead of
  // forcing a new execution（DAG_ACCEPTED is resume-safe）.
  let reconstructedIr = false;
  let ir = null;
  if (classification.capability === "RESTART_REQUIRED") {
    const rec = tryReconstructIr({ store, execDir, snapshot });
    if (rec) {
      ir = rec.ir;
      reconstructedIr = true;
    } else {
      return {
        final: "HOLD",
        stage: "restart_required",
        reason: "PRE_DECOMPOSITION_RESTART_REQUIRED",
        executionId,
        resumed: false,
        complete: false,
        recovery: { executionAttempt: null, recoveryGeneration: snapshot.graph?.recovery_generation ?? 0, resumed: false, replayOf: null, recovered: false, duplicateSuppressed: 0 },
        evidence: { root: persistenceRoot, exec_dir: execDir, execution_id: executionId, state: "RESTART_REQUIRED", checkpoint_revision: snapshot.revision },
      };
    }
  }

  // ── DE-2 F1: semantic post-head event classification（fail closed on
  //    unknown / invalid; replay-safe and resume-safe events proceed）──
  try {
    for (let s = snapshot.journal_head_sequence + 1; s <= journal.count; s++) {
      const { event } = store.readEvent(s);
      const cls = classifyPostHeadEvent(event.event_type);
      if (cls === "invalid") {
        throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", `unexpected journal event ${event.event_type} beyond checkpoint head`);
      }
    }
  } catch (e) { throw e; }

  store.appendEvent({ event_type: "RESUME_REQUESTED", stage: "resume", payload: { execution_id: identity.executionId } });

  // ── Validation（any failure => HOLD / RESUME_FINGERPRINT_MISMATCH）──
  let expectedFp = null;
  let verifiedManifestId = null;
  let irPhaseIds = new Set();
  let frozen = null;
  // STAGE-D BUDGET HANDOVER: the closure THIS resume reconstructed from the
  // durable ledger (single reconstruction authority — the block below).
  // Finalize/reconciliation at completion uses THIS SAME object so the
  // meter units and the ledger are one authority (NEG13).
  let resumedBudgetEnforcement = null;
  try {
    const repoRoot = snapshot.repository_fingerprint?.repository_root_identity;
    if (typeof repoRoot !== "string" || repoRoot.length === 0) {
      throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "repository identity missing from checkpoint");
    }
    let currentFp;
    try { currentFp = collectRepositoryFingerprint(repoRoot); } catch (e) {
      throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", `repository unavailable or changed: ${e?.message || e}`);
    }
    expectedFp = snapshot.repository_fingerprint;
    const fpFields = [
      "expected_head", "repository_root_identity", "worktree_identity", "git_common_dir_identity",
      "expected_ref", "origin_url", "origin_master", "expected_worktree_state",
    ];
    for (const f of fpFields) {
      if (currentFp[f] !== expectedFp[f]) {
        throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", `repository fingerprint mismatch: ${f}`);
      }
    }
    if (currentFp.dirty) {
      // DE-2 production resume: the real worktree is dirty by design. Accept
      // the frozen filtered dirty set（or a delta confined to the graph's own
      // output scope）; reject genuine drift（fail closed）.
      const permitted = snapshot.graph?.permitted_dirty_digest ?? null;
      const dirtyState = captureWorktreeDirtyState(repoRoot, dirtyScope);
      const ok = resumeDirtyAllowed({ currentPorcelain: dirtyState.porcelain, permittedDigest: permitted, dirtyScope });
      if (!ok) {
        throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "repository worktree drifted beyond the frozen/permitted dirty set");
      }
    }

    const frozen = readJsonSafe(execDir, "artifacts/input.json");
    if (frozen?.repoPath !== repoPath || frozen?.scratchRoot !== scratchRoot) {
      throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "repository or scratch namespace changed");
    }
    if (buildInputFingerprint(frozen) !== snapshot.input_fingerprint) {
      throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "input fingerprint mismatch");
    }

    // TA-2（N; NEG11）: the frozen admission must re-verify on resume.
    //   - an admission artifact exists on disk (this run was admitted): the
    //     authoritative caller admission must match the stored admission_id
    //     (or, when absent, the stored payload must still derive it).
    //   - mismatch -> HOLD / ADMISSION_DRIFT; never silent resume.
    // Note: admission.json is OPTIONAL（unadmitted runs never wrote it）— a
    // missing artifact means "this run was not admitted", NOT a failure.
    const storedAdmission = (() => {
      try {
        return JSON.parse(readFileSync(join(execDir, "artifacts", "admission.json"), "utf8"));
      } catch {
        return null;
      }
    })();
    if (storedAdmission && typeof storedAdmission === "object") {
      if (!admission || typeof admission !== "object") {
        throw new DurableGraphHoldError("ADMISSION_DRIFT", "stored admission requires authoritative admission on resume");
      }
      const drift = assertAdmissionFrozen({ stored: storedAdmission, authoritativeAdmissionId: admission.admission_id, authoritativeRecord: admission });
      if (!drift.ok) {
        throw new DurableGraphHoldError("ADMISSION_DRIFT", drift.reason);
      }
    } else if (admission && typeof admission === "object" && admission.admission_id) {
      // Caller supplies an admission for a run that was NOT admitted —
      // binding a new admission to an existing execution is a drift too.
      throw new DurableGraphHoldError("ADMISSION_DRIFT", "admission supplied for an unadmitted run");
    }

    // TA-3: budget ledger resume（B3 — consumption accumulates across the
    // crash boundary; a fresh ledger is NEVER allowed to restart a resumed
    // run）.
    const ledgerStatePath = join(execDir, "artifacts", "budget-ledger.json");
    if (existsSync(ledgerStatePath)) {

      if (!admission || typeof admission !== "object") {
        throw new DurableGraphHoldError("BUDGET_AUTHORITY_INVALID", "budget-ledger.json present but no authoritative admission on resume");
      }
      let ledgerState = null;
      try {
        ledgerState = JSON.parse(readFileSync(ledgerStatePath, "utf8"));
      } catch {
        throw new DurableGraphHoldError("BUDGET_AUTHORITY_INVALID", "budget-ledger.json malformed on resume (NEG12)");
      }
      // STAGE-D BUDGET HANDOVER: the LATEST journaled cumulative snapshot
      // (BUDGET_LEDGER_SNAPSHOT) supersedes the era-boundary artifact — a
      // successor killed mid-era must continue from its last checkpoint
      // truth, never roll back. The envelope/admission binding inside the
      // snapshot is re-verified by createBudgetEnforcement below（tampered
      // snapshots fail closed exactly like a tampered artifact）.
      try {
        const jscan = store.verifyJournal();
        for (let s = 1; s <= jscan.count; s++) {
          const { event } = store.readEvent(s);
          if (event?.event_type === "BUDGET_LEDGER_SNAPSHOT" && event?.payload?.ledger
              && typeof event.payload.ledger === "object") {
            ledgerState = event.payload.ledger;
          }
        }
      } catch (e) {
        if (e instanceof DurableGraphHoldError) throw e;
        throw new DurableGraphHoldError("BUDGET_AUTHORITY_INVALID", `budget ledger journal scan failed: ${e?.code || e?.name || "error"}`);
      }
      const enc = createBudgetEnforcement({ admission, checkpointState: ledgerState });
      if (!enc.ok) {
        throw new DurableGraphHoldError(enc.holdCode ?? "BUDGET_AUTHORITY_INVALID", enc.reason ?? "budget ledger state invalid on resume (NEG12)");
      }
      budget = { ...(budget ?? {}), enforcement: enc.enforcement };
      resumedBudgetEnforcement = enc.enforcement;
    }

    // STAGE C durable-resume continuity (C1/P2 repair): a run that carried
    // the canonical tool-selection allocation MUST resume through the same
    // selector/validator chain. The gate keys on EITHER signal of a wired
    // run — the loose frozen allocation artifact OR the checksummed
    // snapshot commitments — because losing exactly one of them must never
    // silently skip the gate (review MAJOR: keyed on the loose file alone,
    // an ENOENT on artifacts/ downgraded a required-tool resume to the
    // legacy --no-tools composition). Missing commitments (legacy
    // checkpoint or pre-commitment crash) and missing allocation artifact
    // both hold fail-closed — a required-tool run may never silently
    // degrade. Resume-phase selection holds deliberately live in THIS
    // namespace (TOOL_SELECTION_RESUME_*), not the frozen validator-code
    // table in policy-projection.mjs.
    const storedSelectionAllocationPath = join(execDir, "artifacts", "tool-selection-allocation.json");
    const rawCommitments = snapshot.graph?.tool_selection_commitments ?? null;
    // The checkpoint publishes `tool_selection_commitments: {}` UNCONDITIONALLY
    // (state init at :333, publish at :439), so the EMPTY container is the
    // normal unwired state and must NOT count as a wired-run signal — only a
    // container with at least one commitment does. Inside an entered gate the
    // RAW value is preserved so the existing validation chain keeps emitting
    // its precise codes ({} -> PROVENANCE_INVALID via the continuity
    // reconstruction; missing field -> BIND_MISSING).
    const hasLiveCommitments = rawCommitments !== null && typeof rawCommitments === "object"
      && !Array.isArray(rawCommitments) && Object.keys(rawCommitments).length > 0;
    const storedSelectionAllocation = existsSync(storedSelectionAllocationPath)
      ? readJsonSafe(execDir, "artifacts/tool-selection-allocation.json")
      : null;
    if (storedSelectionAllocation || hasLiveCommitments) {
      if (!rawCommitments || typeof rawCommitments !== "object") {
        throw new DurableGraphHoldError("TOOL_SELECTION_RESUME_BIND_MISSING", "wired durable run resumed without persisted selection commitments");
      }
      if (!storedSelectionAllocation || typeof storedSelectionAllocation !== "object") {
        throw new DurableGraphHoldError("TOOL_SELECTION_RESUME_ALLOCATION_MISSING", "wired durable run lost its frozen selection allocation artifact; two-way identity corroboration impossible");
      }
      const continuity = reconstructToolSelectionContinuity({
        executionId,
        admission,
        commitments: rawCommitments,
      });
      if (storedSelectionAllocation.schema !== TOOL_SELECTION_COMMITMENT_SCHEMA
          || canonicalJson(storedSelectionAllocation.allocationIdentity ?? {}) !== canonicalJson(continuity.allocation)) {
        throw new DurableGraphHoldError("TOOL_SELECTION_PROVENANCE_INVALID", "frozen allocation identity does not match the reconstructed selection allocation");
      }
      budget = { ...(budget ?? {}), allocation: continuity.allocation };
    }

    ir = readJsonSafe(execDir, "artifacts/decomposition-ir.json");
    if (!reconstructedIr && buildIrSha256(ir) !== snapshot.decomposition_ir_sha256) {
      throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "IR hash mismatch");
    }
    if (!reconstructedIr && buildDagFingerprint(ir) !== snapshot.dag_sha256) {
      throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "DAG fingerprint mismatch");
    }
    for (const id of snapshot.completed_phase_ids || []) {
      if (!snapshot.phase_result_hashes || typeof snapshot.phase_result_hashes[id] !== "string") {
        throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", `completed phase ${id} missing result hash`);
      }
    }
    irPhaseIds = new Set((ir.phases || []).map((p) => p.phase_id));
    for (const id of Object.keys(snapshot.phase_states || {})) {
      if (!irPhaseIds.has(id)) throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", `phase_states references unknown phase: ${id}`);
    }
    if (!reconstructedIr) {
      for (const id of irPhaseIds) {
        if (!snapshot.phase_states || !(id in snapshot.phase_states)) {
          throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", `phase_states missing phase: ${id}`);
        }
      }
    }

    // 10. I1 decomposition manifest binding（recomputed == artifact ==
    // checkpoint, three-way; fail-closed on any mismatch / malformed /
    // stale binding）. Inputs are re-derived from the SAME frozen durable
    // artifacts the initial build used. A missing artifact with a pinned
    // checkpoint id fails closed; a missing artifact WITHOUT a pinned id is
    // the DAG_ACCEPTED→manifest sub-window crash → reconstruct and persist.
    const manifestArtifactPath = join(execDir, "artifacts", "decomposition-manifest.json");
    const manifestArtifactExists = existsSync(manifestArtifactPath);
    const checkpointManifestId = typeof snapshot.decomposition_manifest_sha256 === "string"
      ? snapshot.decomposition_manifest_sha256 : null;
    const manifestBuildInputs = () => ({
      parentExecutionId: identity.executionId,
      chainId: identity.chainId,
      parentRevision: sha256Text(canonicalJson(frozen?.parent ?? parent)),
      inputFingerprint: snapshot.input_fingerprint,
      configurationFingerprint: snapshot.configuration_fingerprint,
      ir,
      irSha: buildIrSha256(ir),
      dagSha: buildDagFingerprint(ir),
      repositoryIdentity: {
        repository_root_identity: expectedFp.repository_root_identity,
        expected_head: expectedFp.expected_head,
        tree: collectRepositoryTree(repoRoot),
      },
      sourceHashes: computeSourceHashes(),
      promptBuilderVersion: "graph-input-ir",
    });
    if (manifestArtifactExists || checkpointManifestId) {
      if (!manifestArtifactExists) {
        throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "decomposition manifest artifact missing but checkpoint pins a manifest id");
      }
      const frozenManifest = (() => {
        try {
          return JSON.parse(readFileSync(manifestArtifactPath, "utf8"));
        } catch {
          throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "decomposition manifest artifact malformed (unparseable)");
        }
      })();
      if (typeof frozenManifest?.manifest_id !== "string" || frozenManifest.manifest_id.length === 0) {
        throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "decomposition manifest artifact malformed: missing manifest_id");
      }
      // Artifact self-consistency: the stored payload must hash to its own
      // declared manifest_id (catches any tampered binding field even when
      // the declared digest itself was left untouched).
      const payloadOnly = { ...frozenManifest };
      delete payloadOnly.manifest_id;
      delete payloadOnly.content_sha256;
      if (sha256Text(canonicalJson(payloadOnly)) !== frozenManifest.manifest_id) {
        throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "decomposition manifest artifact self-inconsistent (payload digest != manifest_id)");
      }
      const recomputed = buildDecompositionManifest(manifestBuildInputs());
      if (!recomputed.ok) {
        throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", `decomposition manifest cannot be re-derived: ${recomputed.code}`);
      }
      if (recomputed.manifest_id !== frozenManifest.manifest_id) {
        throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "decomposition manifest digest mismatch (recomputed != artifact)");
      }
      if (checkpointManifestId && checkpointManifestId !== frozenManifest.manifest_id) {
        throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "decomposition manifest digest mismatch (artifact != checkpoint)");
      }
      verifiedManifestId = frozenManifest.manifest_id;
    } else {
      const rebuilt = buildDecompositionManifest(manifestBuildInputs());
      if (!rebuilt.ok) {
        throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", `decomposition manifest cannot be reconstructed: ${rebuilt.code}`);
      }
      store.writeArtifact("decomposition-manifest.json", rebuilt.manifest);
      store.appendEvent({
        event_type: "DECOMPOSITION_MANIFEST_WRITTEN",
        stage: "resume",
        payload: { format_version: DECOMPOSITION_MANIFEST_FORMAT, manifest_sha256: rebuilt.manifest_id, bytes: rebuilt.bytes, reconstructed: true },
      });
      verifiedManifestId = rebuilt.manifest_id;
    }

    // I1-R1 (B): crash between the artifact write and the journal event —
    // repair the journal so the emission record always exists alongside the
    // artifact (replay-safe marker; never a second artifact write).
    // I1-R1.5: verifyJournal() failure here MUST fail closed — never swallow
    // an integrity error and treat it as "just no manifest event".
    let manifestEventExists = false;
    let journalScan;
    try {
      journalScan = store.verifyJournal();
    } catch (e) {
      throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH",
        `journal integrity failure during manifest rescan: ${e?.code || e?.name || "error"}`);
    }
    for (let s = 1; s <= journalScan.count; s++) {
      const { event } = store.readEvent(s);
      if (event?.event_type === "DECOMPOSITION_MANIFEST_WRITTEN") { manifestEventExists = true; break; }
    }
    if (!manifestEventExists) {
      store.appendEvent({
        event_type: "DECOMPOSITION_MANIFEST_WRITTEN",
        stage: "resume",
        payload: { format_version: DECOMPOSITION_MANIFEST_FORMAT, manifest_sha256: verifiedManifestId, recovered_journal_gap: true },
      });
    }
    store.appendEvent({ event_type: "RESUME_VALIDATED", stage: "resume", payload: { checkpoint_digest: checkpointDigest } });
  } catch (e) {
    try { store.appendEvent({ event_type: "RESUME_REJECTED", stage: "resume", payload: { code: e?.code || "RESUME_FINGERPRINT_MISMATCH" } }); } catch { /* best-effort */ }
    throw e;
  }

  // ── MULTI-SESSION REPAIR-1 R1: THE canonical rollover executor on the
  //    successor resume path. Generation ≥1 previously resumed with NO
  //    rolloverRequestExecutor — usage observation machinery and the §9a
  //    gate were present but the intake could never fire, so B→C could
  //    never trigger autonomously. Derive the SAME canonical executor the
  //    initial admitted durable execution uses (single factory in
  //    src/rollover/production-wiring.mjs) from the re-verified admission
  //    + durable truth — NEVER from caller opts (the key stays fenced at
  //    both sinks; this seam accepts no executor parameter at all). ──
  let rolloverRequestExecutor = null;
  if (admission && typeof admission === "object" && admission.extensions?.rollover?.enabled === true) {
    rolloverRequestExecutor = await (await import("../rollover/production-wiring.mjs"))
      .deriveCanonicalRolloverExecutor({ admission });
  }

  // ── DE-2R: adopt a caller-supplied IR object when it reproduces the
  //    durable decomposition artifact exactly（canonical-equal）. The
  //    production sub-agent resume entry（resumeSubagentGraph）reads the IR
  //    from durable truth and passes it so its composed hooks（writer wiring
  //    / results persistence）mutate the EXACT phase objects runColimaGraph
  //    drives. A mismatched / missing caller IR never overrides disk truth
  //   （the durable-read object stays in charge; validation above already
  //    bound the artifact to the checkpoint hashes）.──
  if (callerIr && Array.isArray(callerIr.phases)) {
    try {
      const diskIr = readJsonSafe(execDir, "artifacts/decomposition-ir.json");
      if (canonicalJson(callerIr) === canonicalJson(diskIr)) ir = callerIr;
    } catch { /* keep durable-read IR */ }
  }

  // ── Terminal run already complete ──
  if (snapshot.final_verdict) {
    return {
      final: snapshot.final_verdict,
      stage: "complete",
      reason: snapshot.final_verdict === "PASS" ? null : "already_terminal",
      executionId,
      resumed: false,
      complete: true,
      recovery: { executionAttempt: null, recoveryGeneration: snapshot.graph?.recovery_generation ?? 0, resumed: false, replayOf: null, recovered: false, duplicateSuppressed: 0 },
      evidence: { root: persistenceRoot, exec_dir: execDir, execution_id: executionId, checkpoint_revision: snapshot.revision, final_verdict: snapshot.final_verdict, state: "COMPLETE" },
    };
  }

  // ── Resume policy（Stage 7/8/9/10/11）───────────────────────────────
  const graphMeta = snapshot.graph ?? {};
  // Reconstructed-IR resume（DAG_ACCEPTED sub-window crash）: the phase set
  // was never frozen into a checkpoint — seed all phases pending from the IR.
  const seedPhaseStates = reconstructedIr
    ? Object.fromEntries([...irPhaseIds].map((id) => [id, "pending"]))
    : { ...snapshot.phase_states };
  let initialState = { statuses: { ...seedPhaseStates } };
  let recovered = false;
  let duplicateSuppressed = 0;
  const active = snapshot.active_phase;
  let recoveryActions = [];

  // ── Stage 11 completed-result recovery FIRST: a persisted phase result
  //    artifact is durable truth ONLY when the CEDF evidence-reuse gate
  //    accepts it（journal terminal event + checkpoint-pinned hash when one
  //    exists + generation binding）. A parseable artifact alone NEVER proves
  //    application: a crashed / aborted generation's stale result must not
  //    suppress re-execution. This must run BEFORE the active-phase requeue
  //    so a recovered result never gets requeued / re-executed.──
  for (const id of irPhaseIds) {
    const st = initialState.statuses[id];
    if (st === "passed" || st === "held" || st === "failed") continue;
    const resultArtifact = join(execDir, "phases", id, "result.json");
    if (!existsSync(resultArtifact)) continue;
    const gate = childResultFoldGate({ snapshot, store, execDir, phaseId: id });
    if (!gate.ok) {
      // Fail closed: reject the fold, journal the rejection, leave the
      // phase for the scheduler to re-execute.
      try {
        store.appendEvent({ event_type: "PHASE_RESULT_FOLD_REJECTED", stage: "resume", phase_id: id, payload: { code: gate.code } });
      } catch { /* best-effort */ }
      continue;
    }
    const st2 = gate.record.final === "PASS" ? "passed" : "held";
    initialState.statuses[id] = st2;
    if (st2 === "passed") duplicateSuppressed += 1;
    recovered = true;
  }

  // ── STAGE-D BUDGET HANDOVER: a between-phase §9a/§13a fence refusal is
  // the HANDOVER itself, never real work. On a POST-TRANSFER resume, phases
  // whose only terminal record is a journaled ROLLOVER_HANDOVER_FENCE (and
  // phases skipped merely because a fenced dependency was not terminal) are
  // requeued for execution under the successor. Derivation is deterministic
  // from EXISTING durable evidence (journal fence events) — no new durable
  // type, no reset of genuinely completed work; same-session crash resumes
  // (postTransfer=false) are unchanged.──
  if (resumeGateVerdict.postTransfer && snapshot.phase_states && typeof snapshot.phase_states === "object") {
    const fencedPhases = new Set();
    try {
      const jscan = store.verifyJournal();
      for (let s = 1; s <= jscan.count; s++) {
        const { event } = store.readEvent(s);
        if (event?.event_type === "ROLLOVER_HANDOVER_FENCE" && event?.phase_id) fencedPhases.add(String(event.phase_id));
      }
    } catch { /* journal already verified above; absence ⇒ nothing to requeue */ }
    if (fencedPhases.size > 0) {
      const requeued = [];
      for (let pass = 0; pass < ir.phases.length + 1; pass++) {
        let changed = false;
        for (const phase of ir.phases) {
          const id = phase.phase_id;
          const st = initialState.statuses[id];
          const depFenced = (phase.depends_on ?? []).some((d) => requeued.includes(d));
          if ((fencedPhases.has(id) && (st === "failed" || st === "held")) || (st === "skipped_due_to_dependency" && depFenced)) {
            initialState.statuses[id] = "pending";
            requeued.push(id);
            changed = true;
          }
        }
        if (!changed) break;
      }
      if (requeued.length > 0) {
        recovered = true;
        recoveryActions.push({ action: "HANDOVER_FENCED_PHASES_REQUEUED", phases: [...requeued] });
        // The fenced era never executed these phases; its result.json holds
        // the refusal HOLD, not work evidence. Remove it so the successor's
        // lawful terminal record can be written (exclusive-create) and no
        // CEDF fold ever mistakes the fence for a real outcome.
        for (const id of requeued) {
          try { rmSync(join(execDir, "phases", id, "result.json"), { force: true }); } catch { /* best-effort */ }
        }
      }
    }
  }

  if (active && initialState.statuses[active] !== "passed" && initialState.statuses[active] !== "held") {
    const phase = (ir.phases || []).find((p) => p.phase_id === active);
    const isWriter = phase ? requiresWriterLease(phase) : true;
    const leaseEmpty = !snapshot.writer_phase_active && !snapshot.writer_lease_holder;
    if (!isWriter && leaseEmpty) {
      // Interrupted read-only phase without a recovered result -> safe
      // requeue（Stage 11）.
      initialState.statuses[active] = "ready";
      store.appendEvent({ event_type: "READ_ONLY_PHASE_REQUEUED_AFTER_INTERRUPTION", stage: "resume", phase_id: active, payload: {} });
      recovered = true;
    } else {
      // Interrupted writer（Stage 7/8/9/10）: classify, do NOT blind-retry.
      const classification = classifyInterruptedWriter({ snapshot, phase, execDir, graphMeta, store });
      recoveryActions.push({ action: "WRITER_RECOVERY_CLASSIFICATION", phase_id: active, classification });
      store.appendEvent({ event_type: "WRITER_RECOVERY_CLASSIFIED", stage: "resume", phase_id: active, payload: { classification } });
      if (classification === "ALREADY_APPLIED") {
        // Writer result already committed（result artifact + side-effect
        // marker) — recover the result without re-running the mutation.
        initialState.statuses[active] = "passed";
        recovered = true;
        duplicateSuppressed = 1;
      } else {
        try { store.appendEvent({ event_type: "RESUME_REJECTED", stage: "resume", payload: { code: "INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED", phase_id: active, classification } }); } catch { /* best-effort */ }
        return {
          final: "HOLD",
          stage: "recovery_required",
          reason: `INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED:${active}:${classification}`,
          executionId,
          resumed: false,
          complete: false,
          recoveryActions,
          recovery: { executionAttempt: (snapshot.graph?.recovery_attempt ?? 1) + 1, recoveryGeneration: (snapshot.graph?.recovery_generation ?? 0) + 1, resumed: false, replayOf: null, recovered: false, duplicateSuppressed: 0 },
          evidence: { root: persistenceRoot, exec_dir: execDir, execution_id: executionId, checkpoint_revision: snapshot.revision, state: "RECOVERY_REQUIRED" },
        };
      }
    }
  }

  // ── Continue the DAG from the safe boundary（new process, disk only）──
  const gen = (snapshot.graph?.recovery_generation ?? 0) + 1;
  const attempt = (snapshot.graph?.recovery_attempt ?? 1) + 1;
  const run = new DurableGraphRun({
    ir, parent: frozen?.parent ?? parent, manifest: frozen?.manifest ?? manifest,
    cwd, repoPath, scratchRoot,
    maxRepairAttempts: snapshot.resume_policy?.max_repair_attempts ?? maxRepairAttempts,
    timeoutMs: snapshot.resume_policy?.timeout_ms ?? timeoutMs,
    signal, hooks,
    persistence: { root: persistenceRoot, executionId },
    recovery: { executionAttempt: attempt, recoveryGeneration: gen, resumed: true, replayOf: executionId, recovered, duplicateSuppressed },
    dirtyScope,
    admission,
    budget,
    // STAGE-D BUDGET HANDOVER: the successor's session binding must reach
    // THE SAME per-dispatch §9a/§13a gate the fresh run uses — without it,
    // B's own dispatches are fenced as "post-commit resume requires the
    // successor session binding" and the era can never settle into the
    // reconstructed ledger (protected seam wiring; no new authority).
    rolloverSessionBinding,
    // MULTI-SESSION REPAIR-1 R1: the successor era receives THE canonical
    // executor derived above (same factory as the initial admitted run) so
    // B→C can trigger autonomously at a between-phase boundary. Never a
    // caller parameter — derived here from the re-verified admission.
    rolloverRequestExecutor,
  });
  run.execDir = execDir;
  run.store = store;
  run.root = persistenceRoot;
  run.repoFingerprint = expectedFp;
  run.inputFingerprint = snapshot.input_fingerprint;
  run.configurationFingerprint = snapshot.configuration_fingerprint;
  run.irSha = reconstructedIr ? buildIrSha256(ir) : snapshot.decomposition_ir_sha256;
  run.dagSha = reconstructedIr ? buildDagFingerprint(ir) : snapshot.dag_sha256;
  // I1: carry the verified/reconstructed manifest id so the next checkpoint
  // pins it（full three-way binding on subsequent resume）.
  run.state.expectedRevision = snapshot.revision;
  // STAGE D: seed the durable rollover block mirror so every subsequent
  // checkpoint carries graph.rollover forward (retirement-pending windows,
  // ACTIVE_B era) — never dropped by normal publications.
  run.state.rolloverMirror = snapshot.graph?.rollover ?? null;
  // Seed from the RECOVERED initialState（completed-result recovery / requeue
  // already folded in）— the first resumed runner view must match it exactly
  //（DE-2 F2/F3: no re-terminalization of recovered / already-passed phases）.
  run.state.phaseStates = { ...initialState.statuses };
  run.state.phaseResultHashes = { ...(snapshot.phase_result_hashes || {}) };
  run.state.completedPhaseIds = [...(snapshot.completed_phase_ids || [])];
  run.state.sideEffectIds = { ...(graphMeta.side_effect_ids || {}) };
  run.state.worktreeInfo = { ...(graphMeta.worktree_info || {}) };
  // STAGE C durable-resume continuity: keep every persisted commitment in
  // the resumed writer state so subsequent checkpoints never lose them.
  run.state.selectionCommitments = { ...(graphMeta.tool_selection_commitments || {}) };
  run.state.repairBudgetUsed = graphMeta.repair_budget_used ?? 0;
  // DE-2 F2/F3: the runner-status baseline must be the RECOVERED state set.
  run.state._lastRunnerStatuses = { ...initialState.statuses };

  const graphHooks = run.buildGraphHooks(ir);
  try {
    // DE-2 Stage 18/19: a resumed controller reclaims the containers its
    // crashed predecessor abandoned（same executionId -> same container
    // names; a stale container would collide on re-create）. Cleanup is
    // idempotent + label-scoped and can never affect other executions.
    try { cleanupStale("autoloop-graph"); } catch { /* best-effort; container create fails closed below */ }
    // The scratch root is execution-scoped temp（colima worktrees / phase
    // scratch）— a resumed process reconstructs it from durable truth, so the
    // crashed predecessor's stale worktrees / clones are removed first.
    // DE-2R: the production sub-agent resume entry passes scratchPreserve
    //（the durable execution's shared results dir）so the wiped worktrees /
    // scratch never destroy already-persisted sub-agent results.
    const ownershipArtifact = readJsonSafe(execDir, "artifacts/scratch-ownership.json");
    const authorityToken = ownershipArtifact?.authorityToken;
    if (typeof authorityToken !== "string") {
      throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "scratch ownership authority missing");
    }
    wipeScratchPreserving({ scratchRoot, executionId, repoPath, preserve: scratchPreserve, authorityToken });
    run.graphResult = await runColimaGraph({
      ir, parent: frozen?.parent ?? parent, manifest: frozen?.manifest ?? manifest,
      cwd, repoPath, scratchRoot,
      executionId,
      profile,
      maxRepairAttempts: snapshot.resume_policy?.max_repair_attempts ?? maxRepairAttempts,
      timeoutMs: snapshot.resume_policy?.timeout_ms ?? timeoutMs,
      signal,
      hooks: graphHooks,
      initialState,
      executorAdapterFactory,
      reviewerAdapterFactory,
      scratchAuthorityToken: authorityToken,
      closeout, closeoutGate, closeoutSourceBuilder, closeoutEvidenceWriter,
      memory, telemetry, writeback,
      admission,
      durable: { executionAttempt: attempt, recoveryGeneration: gen, resumed: true, replayOf: executionId, recovered, duplicateSuppressed },
      preserveInstance,
      // REPAIR-1 §8 defense in depth (RESUMED path): the terminal/RSL3
      // publication seam validates post-transfer ownership on EVERY resume —
      // including OWNERSHIP_TRANSFER_COMMITTED crash windows. A stale A-era
      // caller that reached this seam without THE gate publishes NOTHING.
      executionReviewBarrier: async (barrierArgs) => {
        const pub = evaluatePostTransferPublicationAuthority({
          snapshot: readCheckpoint(persistenceRoot, executionId).snapshot,
          sessionBinding: rolloverSessionBinding,
          execDir,
        });
        if (pub.action === "REFUSE") {
          return { required: true, ok: false, holdCode: pub.code, reason: `${pub.code}:${pub.reason}`, result: null };
        }
        return applyExecutionReviewBarrier(barrierArgs);
      },
      budget,
    });
  } catch (e) {
    return terminateGraphRun(run, "HOLD", `ORCHESTRATION_EXCEPTION:${e?.code || e?.name || "unknown"}`);
  }
  const final = run.graphResult.final === "PASS" ? "PASS" : "HOLD";

  // STAGE-D BUDGET HANDOVER: the resumed era's final ledger state persists
  // through the SAME artifact authority（mirrors the fresh path; the
  // between-phase checkpoint persistence above already covers crashes）.
  if (resumedBudgetEnforcement) {
    try {
      store.writeArtifact("budget-ledger.json", resumedBudgetEnforcement.checkpointState());
    } catch { /* evidence-only */ }
  }

  const reason = final === "PASS" ? null : (run.graphResult.reason ?? "GRAPH_HOLD");
  // ── STAGE D handover: when ownership already transferred to the successor
  // (post-commit rollover state), THIS process must NOT publish a terminal
  // verdict for the execution — the run continues under B through the gated
  // resume entry; B's own lifecycle closeout is the single real terminal.
  const handoverStates = new Set(["OWNERSHIP_TRANSFER_COMMITTED"]); // ACTIVE_B era owns terminal publication
  const mirrorState = run.state.rolloverMirror?.state ?? null;
  if (mirrorState && handoverStates.has(mirrorState)) {
    return {
      ...buildGraphResultEnvelope(run, run.graphResult),
      final: "HOLD",
      stage: "rollover_handover",
      holdCode: "CROSS_SESSION_ROLLOVER_IN_PROGRESS_A_FROZEN",
      reason: `CROSS_SESSION_ROLLOVER_HANDOVER:${reason ?? "GRAPH_HOLD"}`,
      handedOver: true,
    };
  }

  await run.terminal(final, reason);
  // STAGE-D BUDGET HANDOVER: a resumed metered era settles + reconciles in
  // THE SAME ledger authority it was reconstructed from (NEG13 — divergence
  // is a HOLD). Un-metered resumes keep the exact legacy envelope.
  const envelope = buildGraphResultEnvelope(run, run.graphResult);
  return resumedBudgetEnforcement ? attachBudgetResult(envelope, resumedBudgetEnforcement) : envelope;
}

// ── CEDF freshness fencing ──────────────────────────────────────────────────
// A persisted phases/<id>/result.json is durable truth ONLY when it is
// provably bound to this run's own terminal transition. Parseability alone
// never proves application: a crashed / aborted generation can leave an
// artifact on disk that no checkpoint and no journal event ever adopted.
//
/**
 * Journal proof for a phase terminal transition. Takes the LAST matching
 * event（RSL3 footer lesson: the trusted region is the latest one）.
 * Returns null when no store is available or nothing matches.
 */
function findPhaseTerminalEvent(store, phaseId) {
  if (!store) return null;
  try {
    const j = store.verifyJournal();
    let found = null;
    for (let s = 1; s <= j.count; s++) {
      const { event } = store.readEvent(s);
      if ((event?.event_type === "PHASE_PASSED" || event?.event_type === "PHASE_HELD") && event?.phase_id === phaseId) {
        found = event;
      }
    }
    return found;
  } catch { return null; }
}

/**
 * Evidence-reuse validity gate for folding a persisted child phase result
 * into resumed durable truth（CEDF Phase 7/11）. ALL of the following must
 * hold, else the artifact is stale/unattributable and must never be folded:
 *   - parses with final PASS|HOLD,
 *   - bytes match the checkpoint-pinned sha256 when one exists
 *     (tamper / post-checkpoint regeneration rejection),
 *   - journal contains the matching PHASE_PASSED / PHASE_HELD event
 *     (a parseable artifact alone NEVER proves application),
 *   - graph_generation equals the snapshot's recovery generation when both
 *     are known (stale-generation fencing).
 */
export function childResultFoldGate({ snapshot, store = null, execDir, phaseId }) {
  const path = join(execDir, "phases", phaseId, "result.json");
  if (!existsSync(path)) return { ok: false, code: "RESULT_ARTIFACT_MISSING" };
  let rr = null;
  try { rr = JSON.parse(readFileSync(path, "utf8")); } catch { return { ok: false, code: "RESULT_ARTIFACT_MALFORMED" }; }
  if (!rr || (rr.final !== "PASS" && rr.final !== "HOLD")) return { ok: false, code: "RESULT_FINAL_INVALID" };
  const expectedSha = snapshot?.phase_result_hashes?.[phaseId] ?? null;
  if (expectedSha != null) {
    let actualSha = null;
    try { actualSha = sha256Text(readFileSync(path, "utf8")); } catch { return { ok: false, code: "RESULT_ARTIFACT_UNREADABLE" }; }
    if (actualSha !== expectedSha) return { ok: false, code: "RESULT_HASH_MISMATCH" };
  }
  const ev = findPhaseTerminalEvent(store, phaseId);
  if (!ev) return { ok: false, code: "JOURNAL_PROOF_MISSING" };
  const expectedEvent = rr.final === "PASS" ? "PHASE_PASSED" : "PHASE_HELD";
  if (ev.event_type !== expectedEvent) return { ok: false, code: "JOURNAL_OUTCOME_MISMATCH" };
  const rrGen = rr.graph_generation ?? null;
  const snapGen = snapshot?.graph?.recovery_generation ?? null;
  if (rrGen != null && snapGen != null && rrGen !== snapGen) return { ok: false, code: "STALE_GENERATION" };
  return { ok: true, record: rr };
}

/**
 * Stage 7/8/9/10 — classify an interrupted writer phase from durable truth.
 * NEVER guesses: ambiguous state fails closed（RECOVERY_REQUIRED）.
 */
export function classifyInterruptedWriter({ snapshot, phase, execDir, graphMeta = {}, store = null }) {
  const phaseId = phase?.phase_id ?? "unknown";
  const sideEffectId = graphMeta.side_effect_ids?.[phaseId] ?? null;
  const worktree = graphMeta.worktree_info?.[phaseId] ?? null;
  const resultArtifact = execDir ? join(execDir, "phases", phaseId, "result.json") : null;

  const resultExists = resultArtifact ? existsSync(resultArtifact) : false;
  // CEDF freshness fence: a committed result artifact proves ALREADY_APPLIED
  // only when the evidence-reuse gate accepts it（journal proof + pinned hash
  // when available）. The legacy unit-level surface（store == null, no journal
  // reachable）keeps presence + shape semantics; production resume ALWAYS
  // passes the store and therefore requires full proof.
  if (resultExists) {
    if (store == null) {
      try {
        const rr = readJsonSafe(execDir, `phases/${phaseId}/result.json`);
        if (rr && (rr.final === "PASS" || rr.final === "HOLD")) return "ALREADY_APPLIED";
      } catch { /* fall through to fail-closed */ }
    } else {
      const gate = childResultFoldGate({ snapshot, store, execDir, phaseId });
      if (gate.ok) return "ALREADY_APPLIED";
      // Unverified artifact: presence alone never proves the mutation was
      // applied — fall through to fail-closed worktree classification.
    }
  }

  // Worktree still present and matching durable expectations => RESTORABLE.
  if (worktree?.worktreeDir) {
    const wtDir = worktree.worktreeDir;
    const wtExists = existsSync(wtDir);
    if (wtExists && worktree.verified === true) return "RESTORABLE";
    if (wtExists && worktree.verified !== true) return "CONFLICTED";
    // worktree gone: reconstruction depends on deterministic state
    if (sideEffectId && !resultExists) return "RECONSTRUCTABLE";
  }

  if (sideEffectId && !resultExists) return "RECONSTRUCTABLE";
  return "INVALID";
}

// ── small local helpers（mirror durable-execution.mjs）────────────────────

/**
 * Reconstruct the IR for a crash in the DAG_ACCEPTED->checkpoint sub-window:
 * the journal's DAG_ACCEPTED event carries the authoritative ir/dag hashes;
 * the on-disk artifact must match them. Returns null when the DAG was never
 * accepted（true pre-decomposition -> RESTART_REQUIRED）.
 */
function tryReconstructIr({ store, execDir, snapshot }) {
  const artifactPath = join(execDir, "artifacts", "decomposition-ir.json");
  if (!existsSync(artifactPath)) return null;
  let dagEvent = null;
  try {
    const j = store.verifyJournal();
    for (let s = 1; s <= j.count; s++) {
      const { event } = store.readEvent(s);
      if (event.event_type === "DAG_ACCEPTED") { dagEvent = event; break; }
    }
  } catch { return null; }
  if (!dagEvent) return null;
  const irSha = dagEvent.payload?.ir_sha256 ?? null;
  const dagSha = dagEvent.payload?.dag_sha256 ?? null;
  if (!irSha || !dagSha) return null;
  let ir;
  try { ir = readJsonSafe(execDir, "artifacts/decomposition-ir.json"); } catch { return null; }
  if (buildIrSha256(ir) !== irSha) return null;
  if (buildDagFingerprint(ir) !== dagSha) return null;
  return { ir };
}

function findJournalEventByHead(store, headSequence, headSha256) {
  if (headSequence === null || headSequence === undefined) return;
  const { event } = store.readEvent(headSequence);
  if (event.event_type === "CHECKPOINT_PUBLISHED") return;
  const recheck = store.verifyJournal();
  if (recheck.count < headSequence) {
    throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "journal head sequence beyond journal");
  }
  void headSha256;
}

function readJsonSafe(execDir, rel) {
  try {
    return JSON.parse(readFileSync(join(execDir, rel), "utf8"));
  } catch (e) {
    throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", `artifact unreadable: ${rel}: ${e?.message || e}`);
  }
}

// NOTE: keep the journal-head check aligned with the STACK_A resume path —
// findJournalEventByHead there uses the event at head; the C2D checkpoint
// store remains the single authority.
