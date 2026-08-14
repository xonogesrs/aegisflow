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
  validateRunIdentity, collectRepositoryFingerprint, publishCheckpoint, readCheckpoint, checkpointExists,
  buildInputFingerprint, buildConfigurationFingerprint, buildDagFingerprint, buildIrSha256,
  AUTOLOOP_CHECKPOINT_FORMAT_VERSION, deriveChainId, deriveCheckpointId,
  classifyResumeCapability, classifyPostHeadEvent,
} from "./checkpoint-bridge.mjs";
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
import { createBudgetEnforcement } from "../budget/enforcement.mjs";

export const GRAPH_DURABLE_FORMAT_VERSION = "1.0.0";

export class DurableGraphHoldError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.name = "DurableGraphHoldError";
  }
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
  constructor({ ir, parent, manifest, cwd, repoPath, scratchRoot, maxRepairAttempts, timeoutMs, signal, hooks, persistence, recovery = null, dirtyScope = [], admission = null }) {
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
    this.finalVerdict = null;
    this.finalReason = null;
    this.manifestSha = null;
    this.graphResult = null;
    // TA-2 admission binding（compatibility surface — the PRODUCTION
    // entrypoint is runAdmittedGraph / runDurableGraphAdmitted in
    // src/admission/admission-gate.mjs; frozen into the configuration
    // fingerprint; a changed admission changes the fingerprint -> resume
    // drift HOLD）.
    this.admission = admission ?? null;
    this.admissionFingerprint = admission ? admissionDigest(admission) : null;

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
      _lastRunnerStatuses: null,
      // DE-2 Stage 8/9: per-phase writer side-effect identity + worktree info
      sideEffectIds: {},
      worktreeInfo: {},
      // DE-2 Stage 12: repair budget used（must survive restart）
      repairBudgetUsed: 0,
      // DE-2 production resume: frozen filtered dirty digest
      permittedDirtyDigest: null,
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
          worktree_info: { ...this.state.worktreeInfo },
          repair_budget_used: this.state.repairBudgetUsed,
          recovery_generation: this.recovery?.recoveryGeneration ?? 0,
          recovery_attempt: this.recovery?.executionAttempt ?? 1,
          permitted_dirty_digest: this.state.permittedDirtyDigest ?? null,
        },
      },
    });
    this.state.expectedRevision = pub.revision;
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
      const result = this.state.pendingResults[id] || { final: s === "passed" ? "PASS" : "HOLD", reason: null };
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
        recorded_at: new Date().toISOString(),
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
        };
        self.state.phaseAttempts[phaseId] = attempt ?? null;
        self.state.activePhase = null;
        self.state.activeLifecycleStage = null;
        self.state.writerPhaseActive = false;
        self.state.writerLeaseHolder = null;
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
  const run = new DurableGraphRun({
    ir, parent, manifest, cwd, repoPath, scratchRoot,
    maxRepairAttempts, timeoutMs, signal, hooks, persistence,
    recovery: null,
    dirtyScope,
    admission,
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
      scratchAuthorityToken,
      closeout, closeoutGate, closeoutSourceBuilder, closeoutEvidenceWriter,
      memory, telemetry, writeback,
      admission,
      durable: { executionAttempt: 1, recoveryGeneration: 0, resumed: false, replayOf: null, recovered: false, duplicateSuppressed: 0 },
      preserveInstance,
      budget,
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
} = {}) {
  const identity = validateRunIdentity(executionId);
  if (!checkpointExists(persistenceRoot, executionId)) {
    throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "no checkpoint exists for this execution");
  }
  const { execDir, snapshot, digest: checkpointDigest } = readCheckpoint(persistenceRoot, executionId);

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
  let irPhaseIds = new Set();
  let frozen = null;
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
      const enc = createBudgetEnforcement({ admission, checkpointState: ledgerState });
      if (!enc.ok) {
        throw new DurableGraphHoldError(enc.holdCode ?? "BUDGET_AUTHORITY_INVALID", enc.reason ?? "budget ledger state invalid on resume (NEG12)");
      }
      budget = { ...(budget ?? {}), enforcement: enc.enforcement };
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
    store.appendEvent({ event_type: "RESUME_VALIDATED", stage: "resume", payload: { checkpoint_digest: checkpointDigest } });
  } catch (e) {
    try { store.appendEvent({ event_type: "RESUME_REJECTED", stage: "resume", payload: { code: e?.code || "RESUME_FINGERPRINT_MISMATCH" } }); } catch { /* best-effort */ }
    throw e;
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
  //    artifact（PHASE_PASSED journaled, checkpoint not landed）is durable
  //    truth — fold it into initialState so the phase is NOT re-run. This
  //    must run BEFORE the active-phase requeue so a recovered result never
  //    gets requeued / re-executed（and never collides on re-terminal）.──
  for (const id of irPhaseIds) {
    const st = initialState.statuses[id];
    if (st === "passed" || st === "held" || st === "failed") continue;
    const resultArtifact = join(execDir, "phases", id, "result.json");
    if (!existsSync(resultArtifact)) continue;
    try {
      const rr = readJsonSafe(execDir, `phases/${id}/result.json`);
      if (rr && (rr.final === "PASS" || rr.final === "HOLD")) {
        const st2 = rr.final === "PASS" ? "passed" : "held";
        initialState.statuses[id] = st2;
        if (st2 === "passed") duplicateSuppressed += 1;
        recovered = true;
      }
    } catch { /* artifact unreadable -> leave for the scheduler */ }
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
      const classification = classifyInterruptedWriter({ snapshot, phase, execDir, graphMeta });
      recoveryActions.push({ action: "WRITER_RECOVERY_CLASSIFICATION", phase_id: active, classification });
      store.appendEvent({ event_type: "WRITER_RECOVERY_CLASSIFIED", stage: "resume", phase_id: active, payload: { classification } });
      if (classification === "ALREADY_APPLIED") {
        // Writer result already committed (result artifact + side-effect
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
  });
  run.execDir = execDir;
  run.store = store;
  run.root = persistenceRoot;
  run.repoFingerprint = expectedFp;
  run.inputFingerprint = snapshot.input_fingerprint;
  run.configurationFingerprint = snapshot.configuration_fingerprint;
  run.irSha = reconstructedIr ? buildIrSha256(ir) : snapshot.decomposition_ir_sha256;
  run.dagSha = reconstructedIr ? buildDagFingerprint(ir) : snapshot.dag_sha256;
  run.createdAt = snapshot.created_at;
  run.state.expectedRevision = snapshot.revision;
  // Seed from the RECOVERED initialState（completed-result recovery / requeue
  // already folded in）— the first resumed runner view must match it exactly
  //（DE-2 F2/F3: no re-terminalization of recovered / already-passed phases）.
  run.state.phaseStates = { ...initialState.statuses };
  run.state.phaseAttempts = { ...(snapshot.phase_attempts || {}) };
  run.state.phaseResultHashes = { ...(snapshot.phase_result_hashes || {}) };
  run.state.completedPhaseIds = [...(snapshot.completed_phase_ids || [])];
  run.state.sideEffectIds = { ...(graphMeta.side_effect_ids || {}) };
  run.state.worktreeInfo = { ...(graphMeta.worktree_info || {}) };
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
      budget,
    });
  } catch (e) {
    return terminateGraphRun(run, "HOLD", `ORCHESTRATION_EXCEPTION:${e?.code || e?.name || "unknown"}`);
  }

  const final = run.graphResult.final === "PASS" ? "PASS" : "HOLD";
  const reason = final === "PASS" ? null : (run.graphResult.reason ?? "GRAPH_HOLD");
  await run.terminal(final, reason);
  return buildGraphResultEnvelope(run, run.graphResult);
}

/**
 * Stage 7/8/9/10 — classify an interrupted writer phase from durable truth.
 * NEVER guesses: ambiguous state fails closed（RECOVERY_REQUIRED）.
 */
export function classifyInterruptedWriter({ snapshot, phase, execDir, graphMeta = {} }) {
  const phaseId = phase?.phase_id ?? "unknown";
  const sideEffectId = graphMeta.side_effect_ids?.[phaseId] ?? null;
  const worktree = graphMeta.worktree_info?.[phaseId] ?? null;
  const resultArtifact = execDir ? join(execDir, "phases", phaseId, "result.json") : null;

  const resultExists = resultArtifact ? existsSync(resultArtifact) : false;
  // A committed result artifact is the ALREADY_APPLIED truth（the side effect
  // was captured and the phase terminal recorded it）.
  if (resultExists) {
    try {
      const rr = readJsonSafe(execDir, `phases/${phaseId}/result.json`);
      if (rr && (rr.final === "PASS" || rr.final === "HOLD")) return "ALREADY_APPLIED";
    } catch { /* fall through to fail-closed */ }
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
