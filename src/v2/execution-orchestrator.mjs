// src/v2/execution-orchestrator.mjs
//
// C2 — DAG-to-lifecycle execution orchestrator.
//
// Uses the sealed deterministic scheduler (runner.mjs runDecompositionGraph)
// unchanged. Its injected `execute(phase)`:
//   1. builds the phase task card (phase-task-card.mjs hard gates),
//   2. captures the scope baseline snapshot immediately before the phase runs,
//   3. creates FRESH executor and reviewer adapters (session reuse = 0),
//   4. runs the phase through lifecycle-runner.mjs (never bypassed),
//   5. maps the lifecycle outcome: PASS → passed, HOLD → held, exception → failed.
//
// The orchestrator never repairs in-scheduler, never reorders the DAG to
// avoid writer conflicts, never adds/removes edges, and never starts a new
// phase after HOLD (all enforced by the sealed runner).

import { runDecompositionGraph, requiresWriterLease, PHASE_STATUS } from "./runner.mjs";
import { buildPhaseTaskCard, deriveScopePatterns, PhaseCardError } from "./phase-task-card.mjs";
import { runLifecycle } from "../lifecycle-runner.mjs";
import { captureScopeSnapshot } from "../c2d/mutation-scope.mjs";
import { validateImplementationEvidence } from "../validate-role-artifacts.mjs";
import { decideDelegation, DELEGATION_DECISIONS } from "../subagent/delegation-decision.mjs";
// STAGE C PRODUCTION WIRING: THE single orchestrator selection-bind seam.
// The orchestrator NEVER re-selects tools: it forwards the admitted
// { admission, taskAllocation } pair to the ONE canonical mint
// (buildPhaseTaskCard toolSelectionBind) and hands the ONE issuance-
// authentication resolver (createLifecycleSelectionAuthority) to the EXECUTOR
// adapter factory. The reviewer factory is never given either.
import { createLifecycleSelectionAuthority } from "../admission/policy-projection.mjs";

// C4J: the lifecycle hold detail may carry bounded executor diagnostics
//（final assistant text + parse error + protocol counters）. The durable
// persistence path needs them, but unscanned worker audit sinks
//（run-result.json）must never receive them — strip before recording.
function stripDiagnosticsFromDetail(detail) {
  if (!detail || typeof detail !== "object" || !("diagnostics" in detail)) return detail;
  const { diagnostics, ...rest } = detail;
  return rest;
}

export const ORCHESTRATOR_HOLD = Object.freeze({
  MISSING_EXECUTOR_ADAPTER_FACTORY: "MISSING_EXECUTOR_ADAPTER_FACTORY",
  MISSING_REVIEWER_ADAPTER_FACTORY: "MISSING_REVIEWER_ADAPTER_FACTORY",
  INVALID_REPAIR_BUDGET: "INVALID_REPAIR_BUDGET",
  INVALID_TIMEOUT: "INVALID_TIMEOUT",
  TOOL_SELECTION_CONTEXT_INVALID: "TOOL_SELECTION_CONTEXT_INVALID",
});

/**
 * Execute a validated DECOMPOSED IR DAG through the lifecycle runner.
 *
 * @param {object} opts
 * @param {object} opts.ir — validated IR (DECOMPOSED)
 * @param {object} opts.parent — { scope: { allowed_paths, forbidden_paths } }
 * @param {object[]} opts.manifest — [{ requirement_id, text }]
 * @param {string} opts.cwd — repository root
 * @param {string} opts.executionId — parent run execution id
 * @param {Function} opts.executorAdapterFactory — () => adapter（fresh per phase）
 * @param {Function} opts.reviewerAdapterFactory — () => adapter（fresh per phase）
 * @param {number} opts.maxRepairAttempts — 0 or 1
 * @param {number} opts.timeoutMs — positive
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.hooks] — { onLease, onStatus, onPhase }
 * @returns {Promise<object>} { final, holdCode?, reason?, scheduler, phaseResults, transitions }
 */
export async function runExecutionOrchestrator({
  ir,
  parent,
  // STAGE C PRODUCTION WIRING — THE orchestrator hook bind input. The
  manifest,
  cwd,
  executionId,
  executorAdapterFactory,
  reviewerAdapterFactory,
  maxRepairAttempts = 1,
  timeoutMs,
  signal,
  initialState,
  hooks = {},
  // authoritative admitted pair { admission, taskAllocation } as validated by
  // runAdmittedGraph (frozen admission gate + allocation binding digest).
  // Present ⇒ every phase card mints its toolSelectionBind through the ONE
  // canonical selector and the executor factory receives the ONE selection
  // authority. Absent (null) ⇒ unchanged legacy composition behavior.
  toolSelectionContext = null,
} = {}) {
  // Fail-closed input gates, before any adapter/lifecycle call.
  if (typeof executorAdapterFactory !== "function") {
    return { final: "HOLD", holdCode: ORCHESTRATOR_HOLD.MISSING_EXECUTOR_ADAPTER_FACTORY, reason: ORCHESTRATOR_HOLD.MISSING_EXECUTOR_ADAPTER_FACTORY, scheduler: null, phaseResults: [], transitions: [] };
  }
  if (typeof reviewerAdapterFactory !== "function") {
    return { final: "HOLD", holdCode: ORCHESTRATOR_HOLD.MISSING_REVIEWER_ADAPTER_FACTORY, reason: ORCHESTRATOR_HOLD.MISSING_REVIEWER_ADAPTER_FACTORY, scheduler: null, phaseResults: [], transitions: [] };
  }
  if (maxRepairAttempts !== 0 && maxRepairAttempts !== 1) {
    return { final: "HOLD", holdCode: ORCHESTRATOR_HOLD.INVALID_REPAIR_BUDGET, reason: ORCHESTRATOR_HOLD.INVALID_REPAIR_BUDGET, scheduler: null, phaseResults: [], transitions: [] };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { final: "HOLD", holdCode: ORCHESTRATOR_HOLD.INVALID_TIMEOUT, reason: ORCHESTRATOR_HOLD.INVALID_TIMEOUT, scheduler: null, phaseResults: [], transitions: [] };
  }

  // Fail-closed shape gate on the bind pair — BEFORE any adapter/lifecycle
  // work. A malformed context is never repaired, never downgraded to a
  // no-tools run.
  let selectionAuthority = null;
  if (toolSelectionContext != null) {
    const ts = toolSelectionContext;
    if (typeof ts !== "object" || Array.isArray(ts)
        || !ts.admission || typeof ts.admission !== "object" || Array.isArray(ts.admission)
        || !ts.taskAllocation || typeof ts.taskAllocation !== "object" || Array.isArray(ts.taskAllocation)) {
      return { final: "HOLD", holdCode: ORCHESTRATOR_HOLD.TOOL_SELECTION_CONTEXT_INVALID, reason: ORCHESTRATOR_HOLD.TOOL_SELECTION_CONTEXT_INVALID, scheduler: null, phaseResults: [], transitions: [] };
    }
    // THE one issuance-authentication resolver over the authoritative pair;
    // created HERE from the runAdmittedGraph-validated inputs — never from
    // caller/runtime/task input. The reviewer factory never receives it.
    selectionAuthority = createLifecycleSelectionAuthority({
      admission: ts.admission,
      taskAllocation: ts.taskAllocation,
    });
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    return { final: "HOLD", holdCode: "ORCHESTRATOR_CWD_INVALID", reason: "ORCHESTRATOR_CWD_INVALID", scheduler: null, phaseResults: [], transitions: [] };
  }

  const phaseResults = [];
  const transitions = [];

  // Delegation observability seam（opt-in）: when hooks.delegation carries an
  // admission record, every phase is classified by decideDelegation BEFORE
  // it runs. The sealed scheduler keeps ALL scheduling authority — a
  // decision never reorders the DAG and never grants a writer lease. The
  // only enforced semantics: decision=HOLD is fail-closed → the phase is
  // held without entering the lifecycle. Without hooks.delegation there is
  // no admission input to feed the pure function（fabricating one would
  // violate its fail-closed contract), so no decision is recorded and
  // existing behavior is unchanged.
  const delegationAdmission = hooks.delegation?.admission ?? null;
  const delegationEnabled = hooks.delegation != null && delegationAdmission !== undefined;
  const startedPhaseIds = new Set();
  const terminalPhaseIds = new Set();

  const execute = async (phase) => {
    const phaseId = phase?.phase_id ?? "unknown";
    startedPhaseIds.add(phaseId);
    // Delegation classification（record-only unless HOLD; see above）.
    let delegation = null;
    if (delegationEnabled) {
      const readySiblings = (ir?.phases ?? []).filter((p) =>
        p !== phase
        && p?.phase_id !== phaseId
        && !startedPhaseIds.has(p.phase_id)
        && (Array.isArray(p?.depends_on) ? p.depends_on : []).every((d) => terminalPhaseIds.has(d))
      );
      const dependencyStates = Object.fromEntries(
        (Array.isArray(phase?.depends_on) ? phase.depends_on : []).map((d) => [
          d,
          terminalPhaseIds.has(d) ? PHASE_STATUS.PASSED : PHASE_STATUS.PENDING,
        ]),
      );
      const classified = decideDelegation({ phase, readySiblings, dependencyStates, admission: delegationAdmission });
      const reasons = [...classified.reasons];
      // PARALLEL_DELEGATE vs runner writer lease: the runner's lease
      // predicate is authoritative. A phase that acquires an evidence
      // writer lease is serialized by the sealed scheduler regardless of
      // this classification — record the downgrade reason only.
      if (classified.decision === DELEGATION_DECISIONS.PARALLEL_DELEGATE && requiresWriterLease(phase)) {
        reasons.push("PARALLEL_DELEGATE_DOWNGRADED_BY_RUNNER_WRITER_LEASE");
      }
      delegation = { decision: classified.decision, reasons };
      if (classified.decision === DELEGATION_DECISIONS.HOLD) {
        const reason = `DELEGATION_HOLD:${reasons.join(";")}`;
        transitions.push({ phaseId, executionId: null, final: "HOLD", attempt: null, reason, lifecycleTransitions: [] });
        phaseResults.push({ phaseId, status: "held", final: "HOLD", reason, delegation });
        await hooks.onPhaseTerminal?.({ phaseId, final: "HOLD", reason });
        return { status: "held" };
      }
    }
    try {
      await hooks.onPhaseStart?.({ phaseId });
      const taskCard = buildPhaseTaskCard({
        phase,
        parent,
        executionId,
        cwd,
        maxRepairAttempts,
        expectedReviewerModel: hooks.expectedReviewerModel || "",
        toolPolicy: hooks.toolPolicy,
        // STAGE C: the ONLY bind input — minted per phase inside
        // buildPhaseTaskCard by THE single canonical selector. The
        // orchestrator never recomputes, extends, narrows, or rewrites it.
        toolSelectionBind: selectionAuthority
          ? { admission: toolSelectionContext.admission, taskAllocation: toolSelectionContext.taskAllocation }
          : undefined,
        environmentAllowlist: hooks.environmentAllowlist,
      });
      // C4Q: harness-owned evidence wiring — the verification command and the
      // executor model identity come from harness configuration（never from
      // model text）and are attached to the task card for the evidence builder.
      taskCard.verificationCommand = Array.isArray(hooks.verificationCommand) ? hooks.verificationCommand : null;
      taskCard.expectedExecutorModel = hooks.expectedExecutorModel ?? "";
      taskCard.expectedExecutorProvider = hooks.expectedExecutorProvider ?? "";

      // Baseline snapshot taken immediately before this phase runs, so a
      // serialized later phase sees the state AFTER earlier phases. The
      // wiring may scope mutation verification to a per-phase root（e.g. an
      // isolated worktree）via hooks.scopeBaselineForPhase; otherwise the
      // shared repository root is used.
      const scopeInfo = (hooks.scopeBaselineForPhase && hooks.scopeBaselineForPhase(phase)) || {
        repositoryRoot: cwd,
        baselineSnapshot: captureScopeSnapshot(cwd),
      };
      // The sealed scope gate matches full changed-file paths against glob
      // patterns; a concrete canonical boundary is expanded to its subtree
      // patterns here (mechanical, never wider than the boundary).
      taskCard.mutationScope = {
        repositoryRoot: scopeInfo.repositoryRoot,
        baselineSnapshot: scopeInfo.baselineSnapshot,
        allowedPaths: deriveScopePatterns(taskCard.allowedPaths),
        forbiddenPaths: deriveScopePatterns(taskCard.forbiddenPaths),
      };

      // STAGE C: the executor factory receives THE selection authority created
      // from the authoritative pair; factories that ignore the argument keep
      // their exact legacy behavior. The reviewer factory NEVER receives it —
      // the reviewer stays hard-pinned no-tools in lifecycle-runner.mjs.
      const executorAdapter = executorAdapterFactory(selectionAuthority ? { selectionAuthority } : undefined);
      const reviewerAdapter = reviewerAdapterFactory();

      const lifecycle = await runLifecycle({
        cwd,
        taskCard,
        executorAdapter,
        reviewerAdapter,
        executorEvidenceValidator: validateImplementationEvidence,
        maxRepairAttempts,
        timeoutMs,
        abortSignal: signal,
        hooks: {
          onExecutorOutput: (info) => hooks.lifecycle?.onExecutorOutput?.({ phaseId, ...info }),
          onExecutorCompleted: (info) => hooks.lifecycle?.onExecutorCompleted?.({ phaseId, ...info }),
          onBeforeReviewer: (info) => hooks.lifecycle?.onBeforeReviewer?.({ phaseId, ...info }),
          onReviewerCompleted: (info) => hooks.lifecycle?.onReviewerCompleted?.({ phaseId, ...info }),
          onReviewerInvocationStarted: (info) => hooks.lifecycle?.onReviewerInvocationStarted?.({ phaseId, ...info }),
          onRepairRequested: (info) => hooks.lifecycle?.onRepairRequested?.({ phaseId, ...info }),
          // C4S: the system-observed delta（patch + metadata）is persisted
          // before the reviewer is invoked; persistence failure HOLDS.
          onSystemDeltaReady: (info) => hooks.lifecycle?.onSystemDeltaReady?.({ phaseId, ...info }),
        },
      });

      transitions.push({
        phaseId,
        executionId: taskCard.executionId,
        final: lifecycle.final,
        attempt: lifecycle.attempt,
        reason: lifecycle.reason ?? null,
        lifecycleTransitions: (lifecycle.transitions || []).map((t) => ({
          ...t,
          detail: stripDiagnosticsFromDetail(t.detail),
        })),
      });
      await hooks.onPhase?.({ phaseId, final: lifecycle.final, attempt: lifecycle.attempt });
      await hooks.onPhaseTerminal?.({
        phaseId,
        final: lifecycle.final,
        attempt: lifecycle.attempt,
        reason: lifecycle.reason ?? null,
        detail: lifecycle.detail ?? null,
      });

      if (lifecycle.final === "PASS") {
        phaseResults.push({ phaseId, status: "passed", final: "PASS", attempt: lifecycle.attempt, ...(delegationEnabled ? { delegation } : {}) });
        return { status: "passed" };
      }
      phaseResults.push({ phaseId, status: "held", final: "HOLD", attempt: lifecycle.attempt, reason: lifecycle.reason ?? null, ...(delegationEnabled ? { delegation } : {}) });
      return { status: "held" };
    } catch (e) {
      if (e instanceof PhaseCardError) {
        transitions.push({ phaseId, executionId: null, final: "HOLD", attempt: null, reason: e.code, lifecycleTransitions: [] });
        phaseResults.push({ phaseId, status: "held", final: "HOLD", reason: e.code, ...(delegationEnabled ? { delegation } : {}) });
        await hooks.onPhaseTerminal?.({ phaseId, final: "HOLD", reason: e.code });
        return { status: "held" };
      }
      // Unexpected exception → failed（runner propagates to HOLD + skips descendants）
      transitions.push({ phaseId, executionId: null, final: "HOLD", attempt: null, reason: `exception:${e?.code || e?.name || "unknown"}`, lifecycleTransitions: [] });
      phaseResults.push({ phaseId, status: "failed", final: "HOLD", reason: `exception:${e?.code || e?.name || "unknown"}`, ...(delegationEnabled ? { delegation } : {}) });
      await hooks.onPhaseTerminal?.({ phaseId, final: "HOLD", reason: `exception:${e?.code || e?.name || "unknown"}` });
      return { status: "failed" };
    } finally {
      terminalPhaseIds.add(phaseId);
    }
  };

  const run = await runDecompositionGraph({
    ir,
    execute,
    workspace: cwd,
    signal,
    initialState,
    hooks: hooks.runner || {},
  });

  return {
    final: run.verdict === "PASS" ? "PASS" : "HOLD",
    holdCode: run.verdict === "PASS" ? null : "ORCHESTRATION_HOLD",
    reason: run.verdict === "PASS" ? null : (run.writerViolations.length > 0
      ? `WRITER_LEASE_VIOLATION:${run.writerViolations.join(";")}`
      : run.verdict),
    scheduler: {
      verdict: run.verdict,
      order: run.order,
      statuses: run.statuses,
      skipped: run.skipped,
      writerViolations: run.writerViolations,
      leaseHolderAfter: run.leaseHolderAfter,
      phases: run.phases,
    },
    phaseResults,
    transitions,
  };
}
