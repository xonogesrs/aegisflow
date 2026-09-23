// src/runtime/colima-graph-runner.mjs
//
// Parallel Work Graph Scheduler x Colima pipeline wiring.
//
// Drives a real DAG through the EXISTING sealed scheduler
// (runDecompositionGraph via runExecutionOrchestrator) with the Colima
// executor/reviewer adapters injected per phase:
//   - read-only nodes run in parallel (scheduler ready set + deterministic
//     declaration-order tie-break)
//   - writer nodes are serialized by the sealed ArtifactWriterLease
//     (at most one active writer in the whole graph; extra ready writers wait)
//   - each node keeps graphExecutionId / nodeId / phaseExecutionId / task
//     type / dependency identities / instance identity / worktree identity
//     (writer only) / result identity / cleanup result
//   - deterministic join: node results merged in IR declaration order, never
//     by completion order
//   - deterministic cleanup on every outcome: containers (label-scoped,
//     idempotent), worktrees (git worktree remove), scratch, instance (only
//     the one this card creates)
//
// Parallel writers / sub-agents are NOT part of this card.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { runExecutionOrchestrator } from "../v2/execution-orchestrator.mjs";
import { validateAdmission } from "../admission/admission-record.mjs";
import { isRetrievalAuthorized } from "../admission/policy-projection.mjs";
import { attachBudgetResult } from "../budget/graph-wiring.mjs";
import { phaseExecutionId } from "../v2/phase-task-card.mjs";
import { captureChangedPaths } from "../shared/git-diff-utils.mjs";
import { runStateDrivenCloseout } from "../governance/review-bundle.mjs";
import { applyExecutionReviewBarrier as productionExecutionReviewBarrier, deriveExecutionReviewRequirement } from "../governance/execution-review.mjs";
import { createColimaExecutorAdapter } from "./colima-executor-adapter.mjs";
import { createColimaReviewerAdapter } from "./colima-reviewer-adapter.mjs";
import {
  ensureInstance,
  deleteInstance,
  resolveInstance,
  cleanupStale,
  instanceSocket,
} from "./colima-runtime.mjs";
import { acquireColimaProfileLock } from "./colima-profile-lock.mjs";
import {
  prepareWorktree,
  verifyWorktree,
  revokeWorktree,
  captureWorktreeOutput,
} from "./colima-worktree.mjs";
import { BudgetHoldError } from "../budget/ledger.mjs";
import { prepareOwnedScratchRoot, removeOwnedScratchRoot, getScratchAuthorityToken, planOwnedScratchRoot } from "./scratch-ownership.mjs";
import { wipeScratchPreserving } from "../v2/durable-graph.mjs";

export const GRAPH_RESULT_SCHEMA = "autoloop.c3.parallel-graph-result/v1";

export class ColimaGraphError extends Error {
  constructor(reason, details) {
    super(`colima_graph: ${reason}`);
    this.name = "ColimaGraphError";
    this.reason = reason;
    this.details = details;
  }
}

function stableNodeOrder(ir) {
  const decl = new Map((ir.phases || []).map((p, i) => [p.phase_id, i]));
  return (ir.phases || []).map((p) => p.phase_id).sort((a, b) => {
    const da = decl.get(a) ?? Number.MAX_SAFE_INTEGER;
    const db = decl.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * A phase that mutates a DEDICATED git worktree（C3 isolated-writer pipeline
 * or a writer sub-agent node）. Read-only phases never match.
 */
export function isWriterPhase(phase) {
  const mode = phase?.runtime?.mode;
  if (mode === "writer") return true;
  return mode === "subagent" && phase?.runtime?.agentRole === "writer";
}

/**
 * Run a real DAG through the Colima pipeline on the official scheduler.
 *
 * @param {object} opts
 * @param {object} opts.ir — DECOMPOSED IR with phases carrying:
 *   { phase_id, depends_on, effects: { artifact_mutation }, runtime: { mode,
 *     command, expect, limits } }. Writer phases must declare a repo-relative
 *     artifact boundary (buildPhaseTaskCard hard gate) and their runtime
 *     command writes under that same relative path INSIDE the worktree.
 * @param {object} opts.parent — { scope: { allowed_paths, forbidden_paths } }
 * @param {object[]} [opts.manifest]
 * @param {string} opts.cwd — repository root (source; read-only)
 * @param {string} opts.executionId — graph execution id
 * @param {string} [opts.profile="autoloop-graph"]
 * @param {string} opts.repoPath — source repo (mount allowlist)
 * @param {string} opts.scratchRoot — writable scratch root (mount allowlist)
 * @param {number} [opts.maxRepairAttempts=1]
 * @param {number} [opts.timeoutMs=90000]
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.hooks]
 * @param {object} [opts.closeout] — RB-1R mandatory card-level closeout
 *   contract. R-04 removal: the ONLY supported trigger is the persisted
 *   state record — { statePath, outDir?, timeoutMs?, fileName?, surfaceDir?,
 *     agentIdentity? }. The persisted closeout-state record is authoritative
 *   for requiresReview + identity + scope; the card CANNOT declare final PASS
 *   without a generated + validated review bundle（runCloseoutGate,
 *   fail-closed）. The legacy in-memory `requiresReview` trigger was removed
 *   with R-04 — there is no fallback.
 * @param {Function} [opts.closeoutGate] — internal dependency injection for
 *   tests（defaults to the production runCloseoutGate; never a CLI flag）.
 * @param {Function} [opts.closeoutSourceBuilder] — internal DI（defaults to
 *   the production buildGraphCloseoutSource）.
 * @param {Function} [opts.closeoutEvidenceWriter] — internal DI（defaults to
 *   the production writeGraphCloseoutEvidence）.
 * @returns {Promise<object>} GRAPH_RESULT_SCHEMA
 */
export async function runColimaGraph({
  ir,
  parent,
  manifest = [],
  cwd,
  executionId = `graph-${randomUUID()}`,
  profile = "autoloop-graph",
  repoPath,
  scratchRoot,
  maxRepairAttempts = 1,
  timeoutMs = 90000,
  signal,
  initialState,
  hooks = {},
  // DE-2: optional durable-recovery provenance attached to the result
  //（recoveryGeneration / resumed / replayOf / recovered / duplicateSuppressed）.
  // Provided by src/v2/durable-graph.mjs; the graph runner itself only
  // attaches it — it never invents recovery state.
  durable = null,
  // DE-2 test-harness knob: keep the colima instance alive after cleanup
  //（crash-matrix runs many workers; production default deletes）.
  preserveInstance = false,
  // WP1 multi-session continuity: relative paths under the owned scratch
  // root the terminal cleanup must KEEP（the persisted sub-agent results
  // dir）. Provided by src/v2/durable-graph.mjs for sub-agent graphs: a
  // handover HOLD（A frozen, B resumes）or any durable continuation needs
  // the results to survive into the successor era — deleting them here is
  // exactly the cross-session dependency loss this seam exists to prevent.
  // Raw callers（no durable layer）leave it empty and keep full cleanup.
  scratchPreserve = [],
  executorAdapterFactory,
  reviewerAdapterFactory,
  closeout,
  closeoutGate,
  closeoutSourceBuilder,
  closeoutEvidenceWriter,
  // RSL2 — Domain A execution-review barrier（LATEST surface）: internal DI
  // for tests（defaults to the production applyExecutionReviewBarrier; never
  // a CLI flag）. `executionReviewSurfaceDir` / `executionReviewArchiveDir`
  // override the fixed Latest/ + Latest/archive/ paths.
  executionReviewBarrier = null,
  executionReviewSurfaceDir = null,
  executionReviewArchiveDir = null,
  memory = null,
  // COST-1 passive telemetry observer（R-06: DEFAULT-ON via runAdmittedGraph）.
  // Shapes:
  //   { observer, store?, verification?, lifecycle? } — canonical wiring from
  //     src/telemetry/production-observer.mjs（observer = post-result COST-1
  //     recordGraphTelemetry; lifecycle = mid-run lifecycle.observed emitter）.
  //   { observer, ... } — caller-supplied legacy opt-in wiring (compat).
  //   false — explicit disable（observable: result.telemetryDisabled）.
  //   null/undefined — raw-runner compat surface（no production path reaches
  //     here undefined: runAdmittedGraph always resolves the seam）.
  // The observer runs AFTER the graph result + closeout gate are final;
  // failures are swallowed and degrade to a telemetry.availability disposition
  // — they NEVER change task semantics (authority fence: S16 §C).
  telemetry = null,
  // CBM-4 governed memory write-back（OPT-IN）: { store, telemetryStore,
  // reviewIdentity, verifierIdentity, expectedRepository }. Runs AFTER the
  // result + closeout + telemetry are final; write-back is an evidence-
  // governed side effect — failures NEVER change the graph outcome.
  writeback = null,
  // TA-2 admission（compatibility surface — the PRODUCTION entrypoint is
  // runAdmittedGraph / runColimaGraphAdmitted in src/admission/admission-gate.mjs,
  // which REQUIRES a frozen admission before dispatch）: the frozen admission
  // record the scheduler CONSUMES（J）. Malformed admission -> HOLD /
  // ADMISSION_INVALID. When present, repair budget / isolation / durability /
  // review strength / memory policy are projected from it.
  admission = null,
  // TA-3 budget enforcement（production authority — injected by runAdmittedGraph）:
  //   budget.enforcement — the enforcement context（envelope + ledger + state）
  //   this runner MUST honor: pre-dispatch gate BEFORE any worktree/scratch
  //   setup or executor invocation, settlement at node terminal, repair /
  //   reviewer / retry recording at lifecycle boundaries, and the final
  //   attachBudgetResult（reconciliation, NEG13）. Absent → the result carries
  //   budget.authorized:false（compat surface — NEG14）.
  budget = null,
  // Internal durable ownership proof; raw callers leave null and receive a
  // fresh per-process token when child is first created.
  scratchAuthorityToken = null,
}) {
  if (!repoPath || !scratchRoot) throw new ColimaGraphError("repoPath and scratchRoot required");
  if (!Array.isArray(ir?.phases) || ir.phases.length === 0) throw new ColimaGraphError("ir.phases required");

  // ── TA-2 admission gate（J）: consume the frozen admission, never modify
  // it. Malformed / inconsistent admission -> HOLD / ADMISSION_INVALID
  //（fail-closed, A3 / NEG4）. The admission's repair budget is authoritative
  // when present（Q）. Scheduler-only projection: risk / capabilities /
  // mutation scope / review / durability are NOT touched here — the sub-agent
  // envelope + writer + durable layers enforce those from the same record.
  if (admission) {
    const admissionValidation = validateAdmission(admission);
    if (!admissionValidation.ok) {
      return {
        schema: GRAPH_RESULT_SCHEMA,
        executionId,
        final: "HOLD",
        holdCode: "ADMISSION_INVALID",
        reason: `ADMISSION_INVALID: ${admissionValidation.errors.slice(0, 4).join("; ")}`,
        memoryContext: null,
        scheduler: null,
        join: [],
        nodeResults: [],
        transitions: [],
        closeout: { applied: false },
        admission: { admission_id: admission.admission_id ?? null, invalid: true },
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        cleanup: { containersFound: 0, worktreesRevoked: [], instanceDeleted: false },
      };
    }
    maxRepairAttempts = Number.isInteger(admission.repair_budget) ? admission.repair_budget : maxRepairAttempts;
  }

  // ── CBM-3 read-only memory retrieval（card §22）──────────────────────
  // OPT-IN wiring（memory.provider）. When present, the graph resolves
  // repo/worktree/tree identity and retrieves a structured memoryContext
  // BEFORE any task work. Memory is DATA context only — it never affects
  // scheduler decisions / writer lease / mutation / review / repair /
  // commit authority. A corrupt/irreconcilable store is a fail-closed HOLD
  // （MEMORY_STORE_INVALID）— never silently treated as empty memory; a
  // missing store yields EMPTY_MEMORY and the graph continues.
  const startedAt = new Date().toISOString();
  let memoryContext = null;
  // ── R-10 (AUTH1): retrieval authority comes ONLY from the admitted policy
  // projection（admission.memory_policy.retrieval_allowed === true）. Provider
  // availability alone is never authority; missing / false / malformed
  // authority fails closed（no retrieval）.
  if (isRetrievalAuthorized(admission) && memory && typeof memory?.provider?.retrieveGraphMemory === "function") {
    const mr = await memory.provider.retrieveGraphMemory({
      repoPath,
      cwd,
      executionId,
      graphRunId: executionId,
      taskIdentity: memory.taskIdentity ?? null,
    });
    memoryContext = mr?.memoryContext ?? null;
    if (mr?.state === "INVALID" || (mr?.reason ?? "").startsWith("MEMORY_STORE_INVALID")) {
      return {
        schema: GRAPH_RESULT_SCHEMA,
        executionId,
        final: "HOLD",
        holdCode: "MEMORY_STORE_INVALID",
        reason: mr?.reason ?? "MEMORY_STORE_INVALID",
        memoryContext: {
          schema: "autoloop.memory-context/v1",
          state: "INVALID",
          kind: "MEMORY_CONTEXT_DATA",
          authorityBoundary: "memory is DATA; a corrupt store never holds the graph with a guessed answer",
          selectedRecords: [],
          conflictGroups: [],
        },
        startedAt,
        completedAt: new Date().toISOString(),
        closeout: { applied: false },
        instance: null,
        cleanup: { containersFound: 0, worktreesRevoked: [], instanceDeleted: false },
      };
    }
    // expose the structured memoryContext to every phase's runtime（the task
    // card carries the same runtime object reference — adapters / hooks read
    // it as DATA context; additive only, never a decision input）.
    for (const phase of ir.phases) {
      if (phase?.runtime && typeof phase.runtime === "object") {
        phase.runtime.memoryContext = memoryContext;
      }
    }
  }

  // ── F/G single-flight: serialize mutating/reconciling operations on the
  // shared Colima profile (AUTOLOOP_BACKGROUND_WAITER_COALESCING_AND_PROFILE_
  // SINGLEFLIGHT_1). Ordering invariant: scratch-namespace VALIDATION runs
  // first (fail-closed ScratchOwnershipError before anything else, the
  // P0-RS1 contract), then the profile lock is acquired with ZERO filesystem
  // effect (a busy profile fails closed without stranding an owned child),
  // then the owned scratch child is created and machine work proceeds.
  // Released in the finally below — on every terminal path (PASS / HOLD /
  // exception), after instance cleanup has completed. A crashed holder is
  // recovered through the forensic orphan reclaim of c2d/lock.mjs.
  planOwnedScratchRoot({ scratchRoot, executionId, repoPath });
  const profileLock = acquireColimaProfileLock({ profile, actorId: executionId, sessionId: `pid:${process.pid}` });
  try {
  // `scratchRoot` is caller-supplied namespace only. All mounts and cleanup
  // use one deterministic, marker-bound child owned by this execution.
  const scratchNamespace = scratchRoot;
  scratchRoot = prepareOwnedScratchRoot({ scratchRoot: scratchNamespace, executionId, repoPath, authorityToken: scratchAuthorityToken });
  const resolvedScratchAuthorityToken = scratchAuthorityToken ?? getScratchAuthorityToken(scratchRoot);
  // Instance ownership: a graph run may only tear down an instance it
  // CREATED. A pre-existing shared profile (machine-level infrastructure,
  // possibly hosting other work) is never destroyed as a side effect of a
  // run — that deletion was the root cause of the recurring
  // "docker socket missing" environment failures.
  const instancePreExisted = resolveInstance(profile).ok;
  const instance = ensureInstance({ profile, cpus: 2, memory: 2, disk: 20, roMounts: [repoPath], rwMounts: [scratchRoot] });

  const worktrees = new Map();        // phase_id -> worktree identity
  const executorResults = new Map();  // phaseExecutionId -> executor result (resultSink)
  const nodeResults = new Map();      // phase_id -> structured node result
  const phaseStartTimes = new Map();  // phase_id -> epoch ms
  // STAGE-D BUDGET HANDOVER: phases whose dispatch was refused by the §9a
  // ownership fence NEVER executed — their terminal HOLD node is fence
  // evidence, not consumption evidence（skipped:true; no settlement — the
  // reservation was already released by the fence cancellation seam）.
  const fenceRefusedPhases = new Set(); // phase_id -> refused at dispatch
  const dispatchedPhases = new Set(); // phase_id -> passed the budget pre-dispatch gate (holds a reservation)

  const captureNodeResult = (phase, { final, attempt, reason }) => {
    const phaseExecId = phaseExecutionId(executionId, phase.phase_id);
    const executor = executorResults.get(phaseExecId) ?? null;
    const wt = worktrees.get(phase.phase_id) ?? null;
    const node = {
      graphExecutionId: executionId,
      nodeId: phase.phase_id,
      phaseExecutionId: phaseExecId,
      taskType: phase.runtime?.mode ?? "readonly",
      dependencies: [...(phase.depends_on ?? [])],
      memoryContext,
      instanceIdentity: { profile, socket: instanceSocket(profile) },
      worktreeIdentity: wt
        ? { worktreeDir: wt.worktreeDir, cloneDir: wt.cloneDir, verified: wt.verified?.ok ?? false, head: wt.head }
        : null,
      resultIdentity: executor
        ? { status: executor.status, containerName: executor.containerName, latencyMs: executor.latencyMs }
        : null,
      // WP1: provider-reported usage from the executor's RPC stream (or null
      // when the executor surface exposes none — never estimated here).
      providerUsage: executor?.metadata?.providerUsage ?? null,
      subagentResult: executor?.metadata?.subagent?.result ?? null,
      subagentValidation: executor?.metadata?.subagent?.validation ?? null,
      subagentEnvelope: executor?.metadata?.subagent?.envelope ?? null,
      startedAt: phaseStartTimes.get(phase.phase_id) ?? null,
      completedAt: Date.now(),
      final,
      attempt,
      reason: reason ?? null,
      cleanup: { worktreeRevoked: false }, // filled on terminal
    };
    nodeResults.set(phase.phase_id, node);
    return node;
  };

  const execFactory = executorAdapterFactory
    ? executorAdapterFactory({ resultSink: (execId, result) => {
        executorResults.set(execId, result);
        // R-06: provider-reported usage observability（the SAME adapter-owned
        // channel the rollover producer consumes; never estimated; emitted
        // ONLY when the provider surface actually reported usage）.
        const usage = result?.metadata?.providerUsage ?? null;
        if (usage && typeof usage === "object") {
          telemetry?.lifecycle?.emit?.("provider.usage", {
            phaseId: execId,
            attempt: 0,
            outcome: "PROVIDER_REPORTED",
            detail: `input=${Number(usage.input ?? 0)} output=${Number(usage.output ?? 0)} cacheRead=${Number(usage.cacheRead ?? 0)} cacheWrite=${Number(usage.cacheWrite ?? 0)}`,
          });
        }
      } })
    : () => createColimaExecutorAdapter({
        profile,
        repoPath,
        scratchRoot,
        resultSink: (execId, result) => executorResults.set(execId, result),
      });
  const revFactory = reviewerAdapterFactory ?? (() => createColimaReviewerAdapter());

  const orchestratorResult = await runExecutionOrchestrator({
    ir,
    parent,
    manifest,
    cwd,
    executionId,
    maxRepairAttempts,
    timeoutMs,
    signal,
    initialState,
    executorAdapterFactory: execFactory,
    reviewerAdapterFactory: revFactory,
    // STAGE C PRODUCTION WIRING — THE graph-path bind forwarding. The
    // authoritative pair comes ONLY from the runAdmittedGraph-validated
    // inputs of THIS run（frozen admission + allocation-bound budget）, never
    // from caller hooks or task input. Raw-runner callers without an
    // admission/allocation（compat surface）stay on the legacy composition.
    toolSelectionContext: (admission && budget?.allocation)
      ? { admission, taskAllocation: budget.allocation }
      : null,
    // R-06: the mid-run lifecycle emitter from the canonical production
    // telemetry wiring（undefined on raw/test callers without wiring — every
    // emission is best-effort inside the emitter; never an authority input）.
    lifecycleEmit: typeof telemetry?.lifecycle?.emit === "function" ? telemetry.lifecycle.emit : null,
    hooks: {
      expectedExecutorModel: "colima-container",
      expectedExecutorProvider: "colima-container",
      expectedReviewerModel: "deterministic-c3",
      verificationCommand: ["git", "status", "--porcelain"],
      runner: {
        ...(hooks.runner ?? {}),
      },
      onPhaseStart: async ({ phaseId }) => {
        const phase = (ir.phases || []).find((p) => p.phase_id === phaseId);
        if (!phase) return;
        // R-06: dispatch observability（budget pre-dispatch gate passed —
        // best-effort, never an authority input）.
        telemetry?.lifecycle?.emit?.("phase.dispatch", {
          phaseId,
          outcome: "DISPATCHED",
          detail: phase?.runtime?.mode ?? null,
        });
        // TA-3: budget pre-dispatch gate FIRST — BEFORE any worktree / scratch
        // setup or executor invocation（fail-closed: an exhausted / invalid
        // budget never dispatches and never performs setup work）. The
        // reservation is the conservative upper-bound accounting（§6）.
        const budgetGate = budget?.enforcement?.preDispatch?.({
          executionId,
          phase_id: phaseId,
          nodeId: phaseId,
          attempt: 0,
          runtime: phase.runtime ?? null,
          subagent: phase.runtime?.mode === "subagent",
        });
        if (budgetGate && !budgetGate.ok) {
          captureNodeResult(phase, { final: "HOLD", attempt: 0, reason: budgetGate.holdCode ?? "BUDGET_EXHAUSTED" });
          throw new ColimaGraphError(budgetGate.holdCode ?? "BUDGET_EXHAUSTED", budgetGate.reason ?? "budget gate blocked dispatch");
        }
        // R-01: dispatch success is the settlement precondition. Only a
        // phase that passed the pre-dispatch gate holds a reservation, so
        // only such a phase may settle at terminal — a refused/never-started
        // operation has no reservation and no consumption to record.
        dispatchedPhases.add(phaseId);
        phaseStartTimes.set(phaseId, Date.now());
        if (isWriterPhase(phase)) {
          const wt = prepareWorktree({ sourceRepo: repoPath, scratchRoot, taskId: phaseId });
          const verified = verifyWorktree(wt);
          wt.verified = verified;
          if (!verified.ok) throw new ColimaGraphError("worktree verification failed", verified);
          phase.runtime.worktreePath = wt.worktreeDir;
          phase.runtime.cloneDir = wt.cloneDir;
          phase.runtime.worktreeVerified = verified;
          phase.runtime.worktreeHead = wt.head;
          worktrees.set(phaseId, wt);
        } else {
          const scratchPath = join(scratchRoot, phaseId, "scratch");
          mkdirSync(scratchPath, { recursive: true });
          phase.runtime = phase.runtime ?? {};
          phase.runtime.scratchPath = scratchPath;
        }
        // DE-2R: AWAIT the composed hooks. The production durable layer's
        // onPhaseStart is ASYNC（journal PHASE_READY/PHASE_STARTED -> checkpoint
        // -> caller sub-agent wiring）. Without await the durable chain RACES the
        // executor: the sub-agent writer wiring（mutationScope / dependency
        // identities）could land after the adapter already read the runtime,
        // silently degrading the writer to its default scope — and the
        // journal->checkpoint boundary could land after the adapter call,
        // breaking the durable-first guarantee. Awaiting keeps both the raw
        //（sync）and durable（async）compositions deterministic.
        try {
          await hooks.onPhaseStart?.(phaseId);
        } catch (e) {
          // STAGE-D BUDGET HANDOVER — reservation-cancellation seam for
          // INTENTIONALLY-REFUSED dispatches: EVERY §9a/§13a gate refusal
          // carries a CROSS_SESSION_* code and means the operation NEVER
          // ran. Uniform handling: release the conservative upper-bound
          // reservation through THE enforcement authority (cancel_reservation
          // receipt) and mark the phase fence-refused — no phantom
          // settlement, no orphaned in-flight reservation folding at upper
          // bound on the next reconstruction. The successor's real execution
          // then settles the same opKey exactly once. Any other failure keeps
          // the reservation (conservative upper-bound policy, §6). Rethrow —
          // the fence itself stays the authority.
          const code = String(e?.code ?? e?.holdCode ?? "");
          if (budget?.enforcement && code.startsWith("CROSS_SESSION_")) {
            budget.enforcement.cancelReservation?.({ opKey: `${executionId}:${phaseId}:0` });
            fenceRefusedPhases.add(phaseId);
          }
          throw e;
        }
      },
      onPhaseTerminal: async ({ phaseId, final, attempt, reason }) => {
        const phase = (ir.phases || []).find((p) => p.phase_id === phaseId);
        const node = captureNodeResult(phase, { final, attempt, reason });
        // STAGE-D BUDGET HANDOVER: a §9a fence-refused phase NEVER executed
        // — its terminal record is fence evidence, not consumption evidence
        // (skipped:true keeps observeFromResult from counting it; its
        // reservation was already released at refusal, so there is nothing
        // to settle — never a phantom charge, never a fabricated release).
        if (fenceRefusedPhases.has(phaseId)) node.skipped = true;
        // R-01: a phase that never passed the budget pre-dispatch gate never
        // dispatched — it holds no reservation and consumed nothing, so its
        // terminal record is refusal evidence, not consumption evidence
        // (skipped:true keeps NEG13 evidence consistent with the ledger).
        if (budget?.enforcement && node && !fenceRefusedPhases.has(phaseId) && !dispatchedPhases.has(phaseId)) node.skipped = true;
        // TA-3: settle the operation's reservation with the ACTUAL measured
        // consumption. Wall-clock meter = the contract's runner-timing source
        // （node resultIdentity.latencyMs when the executor produced it, else
        // the measured node window startedAt→completedAt）— the SAME figure
        // observeFromResult derives at reconciliation, so settle and evidence
        // stay in one unit. The pre-dispatch upper bound remains the crash
        // reservation (§6), not a terminal charge.
        if (budget?.enforcement && node && !fenceRefusedPhases.has(phaseId) && dispatchedPhases.has(phaseId)) {
          const opKey = `${executionId}:${phaseId}:0`;
          const lat = Number(node.resultIdentity?.latencyMs);
          const windowMs = Number.isFinite(node.startedAt) && Number.isFinite(node.completedAt)
            ? Math.max(0, node.completedAt - node.startedAt) : null;
          const durationMs = Number.isFinite(lat) ? lat : windowMs;
          const skipped = final === "SKIPPED_DUE_TO_DEPENDENCY" || final === "NOT_RECORDED";
          // R-01: the settlement result is AUTHORITATIVE. A failed settlement
          // on a dispatched operation fails closed here with the ledger's
          // own hold code — never silently ignored and never misattributed
          // to the NEG13 reconciliation fence downstream.
          const settled = budget.enforcement.recordConsumption({
            opKey,
            actualAmounts: {
              node_execution_count: skipped ? null : 1,
              ...(phase?.runtime?.mode === "subagent" ? { sub_agent_execution_count: skipped ? null : 1 } : {}),
            },
            wallClockMs: durationMs,
          });
          if (!settled.ok) {
            throw new BudgetHoldError(settled.holdCode ?? "BUDGET_AUTHORITY_INVALID", settled.reason ?? "budget settlement failed closed");
          }
          const attemptN = Number(attempt ?? 0);
          if (attemptN > 0) {
            for (let a = 0; a < attemptN; a++) budget.enforcement.recordRetry({ nodeId: phaseId });
          }
        }
        // writer worktree: record output then revoke (revocable, deterministic)
        if (isWriterPhase(phase) && worktrees.has(phaseId)) {
          const wt = worktrees.get(phaseId);
          node.worktreeIdentity.output = captureWorktreeOutput(wt);
          revokeWorktree(wt);
          node.cleanup.worktreeRevoked = true;
          worktrees.delete(phaseId);
        }
        // DE-2R: AWAIT the composed onPhaseTerminal so the durable
        // pendingResults record + the production sub-agent resultsDir
        // persistence / reviewResult attach complete before the next phase
        // executes（same race class as onPhaseStart）. Sync caller hooks
        //（raw path）are unaffected.
        await hooks.onPhaseTerminal?.(phaseId, node);
      },
      lifecycle: {
        // DE-2R: AWAIT every lifecycle hook the same way as onPhaseStart/
        // onPhaseTerminal — the durable layer's lifecycle handlers are async
        //（evidence artifact writes + checkpoint）and must land before the
        // orchestrator proceeds to the next boundary.
        onExecutorOutput: async (info) => { await hooks.lifecycle?.onExecutorOutput?.(info); await hooks.onExecutorOutput?.(info); },
        onExecutorCompleted: async (info) => {
          await hooks.lifecycle?.onExecutorCompleted?.(info); await hooks.onExecutorCompleted?.(info);
        },
        onBeforeReviewer: async (info) => {
          const gate = budget?.enforcement?.admitReviewer?.({ nodeId: info?.phaseId ?? null, attempt: info?.attempt });
          if (gate && !gate.ok) return gate;
          const nested = await hooks.lifecycle?.onBeforeReviewer?.(info);
          if (nested && nested.ok === false) {
            // R3 §5.3: nested refusal proves the reviewer never started.
            budget?.enforcement?.cancelReviewerReservation?.({ nodeId: info?.phaseId ?? null, attempt: info?.attempt ?? 0 });
            return nested;
          }
          return { ok: true };
        },
        onReviewerInvocationStarted: async (info) => {
          // R3: reservation RESERVED → INVOKED at the actual invocation seam.
          const c = budget?.enforcement?.confirmReviewerInvoked?.({ nodeId: info?.phaseId ?? null, attempt: info?.attempt ?? 0 });
          if (c && !c.ok && !c.duplicate) throw new BudgetHoldError(c.holdCode ?? "BUDGET_AUTHORITY_INVALID", c.reason ?? "reviewer invocation confirmation failed closed");
          await hooks.lifecycle?.onReviewerInvocationStarted?.(info); await hooks.onReviewerInvocationStarted?.(info);
        },
        onReviewerCompleted: async (info) => {
          // TA-3: one LOGICAL_REVIEW_ATTEMPT per real reviewer invocation.
          const s = budget?.enforcement?.recordReviewer?.({ nodeId: info?.phaseId ?? null, attempt: info?.attempt ?? 0 });
          if (s && !s.ok && !s.duplicate) {
            // R3 review fix: an unsettled real invocation fails the run closed.
            throw new BudgetHoldError(s.holdCode ?? "BUDGET_AUTHORITY_INVALID", s.reason ?? "reviewer settlement failed closed");
          }
          await hooks.lifecycle?.onReviewerCompleted?.(info); await hooks.onReviewerCompleted?.(info);
        },
        onRepairRequested: async (info) => {
          // TA-3: runtime repair meter（B4 — independent of the TA-2 repair
          // budget authority; never merged into it）.
          budget?.enforcement?.recordRepair({ nodeId: info?.phaseId ?? null });
          await hooks.lifecycle?.onRepairRequested?.(info); await hooks.onRepairRequested?.(info);
          // R-06: repair observability（best-effort; never an authority input）.
          telemetry?.lifecycle?.emit?.("phase.repair", {
            phaseId: info?.phaseId ?? null,
            attempt: info?.attempt ?? null,
            outcome: "REPAIR_REQUESTED",
            detail: info?.reason ?? null,
          });
        },
        onSystemDeltaReady: async (info) => { await hooks.lifecycle?.onSystemDeltaReady?.(info); await hooks.onSystemDeltaReady?.(info); },
      },
      // writer mutation verification is scoped to the isolated worktree root;
      // read-only phases keep the shared repository root (repo-purity gate).
      scopeBaselineForPhase: (phase) => {
        if (isWriterPhase(phase) && worktrees.has(phase.phase_id)) {
          const wt = worktrees.get(phase.phase_id);
          return { repositoryRoot: wt.worktreeDir, baselineSnapshot: captureChangedPaths(wt.worktreeDir) };
        }
        return null;
      },
    },
  });

  // ── RB-1R MANDATORY card-level closeout gate ──────────────────────────
  // Runs AFTER the orchestrator completes and BEFORE the final verdict is
  // returned. Node-level interim PASS（per-phase `final`）is NOT card-level
  // final closeout: only this gate may declare the card's formal PASS. A
  // PASS graph whose bundle gate does not pass is downgraded to HOLD
  //（fail-closed; no downstream PASS without a validated bundle）.
  let cardVerdict = orchestratorResult.final;
  let cardHoldCode = orchestratorResult.holdCode;
  let cardReason = orchestratorResult.reason;
  let closeoutResult = { applied: false, final: null, holdCode: null, reason: "closeout_not_required" };
  // RSL2 — Domain A（LATEST surface）: every FORMAL execution（frozen
  // admission present）must publish an execution review before any terminal
  // verdict. The requirement is admission-derived（authoritative）— the
  // caller's closeout declaration is at most an input, never the authority
  //（RSL2-03）. Publication failure fails closed（HOLD downgrade）.
  // R-04 removal: closeout applicability is statePath-only. An in-memory
  // `closeout.requiresReview` flag no longer triggers the closeout gate.
  const needsCardCloseout = Boolean(closeout?.statePath);
  const executionReviewRequirement = deriveExecutionReviewRequirement(admission);
  const needsExecutionReview = executionReviewRequirement.required;
  const graphView = (needsCardCloseout || needsExecutionReview)
    ? {
        executionId,
        final: orchestratorResult.final,
        holdCode: orchestratorResult.holdCode,
        reason: orchestratorResult.reason,
        scheduler: orchestratorResult.scheduler,
        nodeResults: [...nodeResults.values()],
        transitions: orchestratorResult.transitions,
        join: [...nodeResults.values()],
        // TA-2: the closeout source records the admission decision（evidence +
        // explainability; U）. Null when the graph ran unadmitted.
        admission: admission ?? null,
      }
    : null;
  let executionReviewResult = { applied: false };
  // AUTOLOOP_REPORT_LIFECYCLE_REPAIR_1（R3 / R1）: the production hook fires
  // from PERSISTED closeout-state（closeout.statePath）— a structured,
  // machine-readable review-required declaration is the ONLY closeout trigger.
  // The legacy in-memory `closeout.requiresReview` branch（R-04）is removed:
  // a caller that declares review-required MUST persist a closeout-state
  // record first. There is no fallback — a legacy invocation without
  // statePath cannot regain equivalent behavior.
  if (closeout?.statePath) {
    // state-driven: the persisted record is authoritative for requiresReview
    // + identity + scope（idempotent; R2 fail-closed on incomplete metadata）
    closeoutResult = await runStateDrivenCloseout({
      statePath: closeout.statePath,
      graphResult: graphView,
      repoPath,
      cwd,
      outDir: closeout.outDir,
      timeoutMs: closeout.timeoutMs ?? Math.max(timeoutMs, 30000),
      fileName: closeout.fileName,
      gate: closeoutGate,
      sourceBuilder: closeoutSourceBuilder,
      evidenceWriter: closeoutEvidenceWriter,
      surfaceDir: closeout.surfaceDir ?? null,
      agentIdentity: closeout.agentIdentity ?? null,
    });
    if (orchestratorResult.final === "PASS" && closeoutResult.final !== "PASS") {
      // Fail-closed: bundle gate failure downgrades the card verdict.
      cardVerdict = "HOLD";
      cardHoldCode = closeoutResult.holdCode ?? "REVIEW_BUNDLE_INVALID";
      cardReason = closeoutResult.reason ?? "REVIEW_BUNDLE_GATE_FAILED";
    }
  }

  // ── RSL2 Domain A barrier（universal execution review publication）─────
  // Runs AFTER the bundle gate and BEFORE the final verdict is returned. A
  // formal execution（admission present）that fails to publish its execution
  // review to Latest/ cannot transition to a terminal PASS（fail-closed）;
  // a HOLD outcome whose review cannot be published records the failure so
  // the caller can see why the execution review is missing.
  if (needsExecutionReview && graphView) {
    const barrier = await (executionReviewBarrier ?? productionExecutionReviewBarrier)({
      graphView,
      admission,
      closeout,
      repoPath,
      cwd,
      surfaceDir: executionReviewSurfaceDir ?? null,
      archiveDir: executionReviewArchiveDir ?? null,
    });
    executionReviewResult = barrier.result
      ? {
          applied: true,
          ok: barrier.ok,
          required: barrier.required,
          identity: barrier.result.identity ?? null,
          sha256: barrier.result.sha256 ?? null,
          path: barrier.result.path ?? null,
          archivedPath: barrier.result.archivedPath ?? null,
          idempotent: barrier.result.idempotent ?? false,
          holdCode: barrier.result.holdCode ?? null,
          reason: barrier.result.reason ?? null,
        }
      : { applied: true, ok: false, required: true, holdCode: barrier.holdCode, reason: barrier.reason };
    if (!barrier.ok) {
      cardVerdict = "HOLD";
      cardHoldCode = barrier.holdCode ?? "EXECUTION_REVIEW_NOT_PUBLISHED";
      cardReason = barrier.reason ?? "EXECUTION_REVIEW_NOT_PUBLISHED";
      if (orchestratorResult.final !== "PASS" && cardReason && !cardReason.startsWith("EXECUTION_REVIEW")) {
        cardReason = `${orchestratorResult.final}:${cardReason}`;
      }
    }
  }

  // deterministic join: fixed node order (IR declaration), never completion order
  const order = stableNodeOrder(ir);
  // skipped / never-started nodes get a placeholder result from the scheduler's
  // status map so the join is complete for every declared phase.
  const schedulerStatuses = orchestratorResult.scheduler?.statuses ?? {};
  const statusToFinal = (s) =>
    s === "passed" ? "PASS"
      : s === "held" ? "HOLD"
        : s === "failed" ? "FAILED"
          : s === "skipped_due_to_dependency" ? "SKIPPED_DUE_TO_DEPENDENCY"
            : s;
  for (const phase of ir.phases) {
    if (nodeResults.has(phase.phase_id)) continue;
    const s = schedulerStatuses[phase.phase_id];
    nodeResults.set(phase.phase_id, {
      graphExecutionId: executionId,
      nodeId: phase.phase_id,
      phaseExecutionId: phaseExecutionId(executionId, phase.phase_id),
      taskType: phase.runtime?.mode ?? "readonly",
      dependencies: [...(phase.depends_on ?? [])],
      memoryContext,
      instanceIdentity: { profile, socket: instanceSocket(profile) },
      worktreeIdentity: null,
      resultIdentity: null,
      startedAt: phaseStartTimes.get(phase.phase_id) ?? null,
      completedAt: null,
      final: statusToFinal(s) ?? "NOT_RECORDED",
      attempt: null,
      reason: s === "skipped_due_to_dependency" ? "SKIPPED_DUE_TO_DEPENDENCY" : null,
      cleanup: { worktreeRevoked: false },
      skipped: true,
    });
  }
  const joinOrder = order.map((phaseId) => nodeResults.get(phaseId) ?? {
    graphExecutionId: executionId,
    nodeId: phaseId,
    phaseExecutionId: phaseExecutionId(executionId, phaseId),
    final: "NOT_RECORDED",
    reason: "no terminal hook fired",
  });

  const cleanup = {
    containersFound: cleanupStale(profile).found,
    worktreesRevoked: [...worktrees.keys()],
    instanceDeleted: false,
  };
  for (const phaseId of [...worktrees.keys()]) {
    const wt = worktrees.get(phaseId);
    try { revokeWorktree(wt); } catch { /* best effort */ }
  }
  if (scratchPreserve.length > 0) {
    // WP1: preserve the declared subtrees（the persisted sub-agent results
    // dir）and reclaim everything else — the same wipe contract the resume
    // path uses. The owned root itself stays（the successor era re-derives
    // and re-owns it through the durable authority token）.
    wipeScratchPreserving({ scratchRoot: scratchNamespace, executionId, repoPath, preserve: scratchPreserve, authorityToken: resolvedScratchAuthorityToken });
  } else {
    removeOwnedScratchRoot({ scratchRoot: scratchNamespace, executionId, repoPath, authorityToken: resolvedScratchAuthorityToken });
  }
  if (!preserveInstance && !instancePreExisted) {
    deleteInstance(profile);
    cleanup.instanceDeleted = true;
  }

  const result = {
    schema: GRAPH_RESULT_SCHEMA,
    executionId,
    final: cardVerdict,
    holdCode: cardHoldCode,
    reason: cardReason,
    memoryContext,
    // TA-2: the frozen admission that governed this graph（null when the
    // graph ran unadmitted）. Consumers（telemetry / closeout / envelope）
    // read it; nobody may amend it（A1）.
    admission: admission ?? null,
    scheduler: orchestratorResult.scheduler,
    join: joinOrder,
    nodeResults: order.map((id) => nodeResults.get(id)).filter(Boolean),
    transitions: orchestratorResult.transitions,
    // DE-2: recovery provenance（provided by the durable wrapper; null on a
    // fresh non-resumed run）.
    recovery: durable ?? null,
    closeout: closeoutResult.applied
      ? {
          applied: true,
          final: closeoutResult.final,
          holdCode: closeoutResult.holdCode ?? null,
          reason: closeoutResult.reason ?? null,
          bundlePath: closeoutResult.bundlePath ?? null,
          bundle: closeoutResult.bundle ?? null,
          // RB-1G structured external-review delivery state: a bundle-gate
          // PASS（internal closeout）is NOT an external review. CARD_COMPLETE /
          // EXTERNAL_REVIEW_PASS require externalReview.complete === true.
          externalReview: closeoutResult.externalReview ?? null,
        }
      : { applied: false },
    // RSL2 — Domain A execution review publication record（Latest/）. When
    // `applied`, the graph already published its execution review BEFORE this
    // result was returned（barrier ran pre-verdict）.
    executionReview: executionReviewResult.applied
      ? {
          applied: true,
          ok: executionReviewResult.ok ?? false,
          required: executionReviewResult.required ?? false,
          identity: executionReviewResult.identity ?? null,
          sha256: executionReviewResult.sha256 ?? null,
          path: executionReviewResult.path ?? null,
          archivedPath: executionReviewResult.archivedPath ?? null,
          idempotent: executionReviewResult.idempotent ?? false,
          holdCode: executionReviewResult.holdCode ?? null,
          reason: executionReviewResult.reason ?? null,
        }
      : { applied: false },
    instance: { profile, socket: instanceSocket(profile) },
    startedAt,
    completedAt: new Date().toISOString(),
    cleanup,
  };

  // ── COST-1 passive telemetry observation（POST-result, opt-in）─────────
  // The graph outcome is FULLY decided above; observation runs last inside
  // try/catch and can never alter it. A corrupt telemetry store surfaces
  // TELEMETRY_STORE_INVALID to the caller（who decides fail-closed policy for
  // canonical metrics）; anything else degrades to TELEMETRY_UNAVAILABLE.
  if (telemetry && typeof telemetry?.observer === "function") {
    try {
      const telemetryResult = await telemetry.observer({
        graphResult: result,
        closeout,
        store: telemetry.store ?? null,
        verification: telemetry.verification ?? [],
      });
      result.telemetry = {
        observed: telemetryResult.ok,
        events: telemetryResult.events ?? 0,
        holdCode: telemetryResult.holdCode ?? null,
      };
    } catch (e) {
      result.telemetry = { observed: false, events: 0, holdCode: "TELEMETRY_UNAVAILABLE" };
    }
  }

  // ── CBM-4 governed memory write-back（POST-final, opt-in）──────────────
  // Write-back runs after the graph + closeout + telemetry are final and can
  // never change the graph outcome. A corrupt memory store surfaces
  // WRITEBACK_STORE_INVALID in the structured result; everything else is a
  // structured per-candidate status.
  //
  // TA-2（P; NEG5）: memory write-back requires EXPLICIT admission authority
  //（memory_policy.writeback_allowed）. A write-back request under an
  // admission that denies it -> WRITEBACK_AUTHORITY_INSUFFICIENT, and the
  // gate is never invoked（no partial write）.
  if (writeback && typeof writeback?.store === "object" && writeback.store !== null) {
    if (admission && admission.memory_policy?.writeback_allowed !== true) {
      result.writeback = {
        ok: false,
        outcomes: [],
        statusCounts: {},
        reason: "WRITEBACK_AUTHORITY_INSUFFICIENT: admission.memory_policy.writeback_allowed is false (deny-by-default; NEG5)",
      };
    } else {
      try {
        const { runGraphWriteback } = await import("../memory/writeback/graph.mjs");
        result.writeback = await runGraphWriteback({
          graphResult: result,
          store: writeback.store,
          telemetryStore: writeback.telemetryStore ?? null,
          reviewIdentity: writeback.reviewIdentity ?? null,
          verifierIdentity: writeback.verifierIdentity ?? null,
          expectedRepository: writeback.expectedRepository ?? null,
        });
      } catch (e) {
        result.writeback = { ok: false, outcomes: [], statusCounts: {}, reason: String(e?.message ?? e).slice(0, 200) };
      }
    }
  }

  // ── TA-3: attach the budget enforcement result（authorized + reconciled）──
  // When `budget.enforcement` is present（production path via runAdmittedGraph）
  // this runs finalize() — the runtime evidence vs ledger reconciliation
  // （NEG13）; a divergence downgrades the result to HOLD. When absent（direct
  // low-level call）the result carries budget.authorized:false — the compat
  // surface is explicitly NOT a production budget-authorized path（NEG14）.
  return attachBudgetResult(result, budget?.enforcement ?? null);
  } finally {
    // D (terminal cancellation at the resource layer): the profile is free
    // exactly when this operation's machine work (instance + containers) is
    // done — never while a poll/waiter could still observe mid-run state.
    // Release failure never masks the real outcome: a leaked record is
    // forensically reclaimable (dead-pid) and surfaces as
    // COLIMA_PROFILE_LOCK_RECLAIM_UNPROVEN for the next acquirer.
    try {
      profileLock.release();
    } catch (e) {
      if (result && typeof result === "object") {
        result.profileLockRelease = { ok: false, holdCode: e.code ?? null, reason: String(e?.message ?? e).slice(0, 200) };
      }
    }
  }
}
