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

import { runDecompositionGraph } from "./runner.mjs";
import { buildPhaseTaskCard, deriveScopePatterns, PhaseCardError } from "./phase-task-card.mjs";
import { runLifecycle } from "../lifecycle-runner.mjs";
import { captureScopeSnapshot } from "../c2d/mutation-scope.mjs";
import { validateImplementationEvidence } from "../validate-role-artifacts.mjs";

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
  if (typeof cwd !== "string" || cwd.length === 0) {
    return { final: "HOLD", holdCode: "ORCHESTRATOR_CWD_INVALID", reason: "ORCHESTRATOR_CWD_INVALID", scheduler: null, phaseResults: [], transitions: [] };
  }

  const phaseResults = [];
  const transitions = [];

  const execute = async (phase) => {
    const phaseId = phase?.phase_id ?? "unknown";
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
        environmentAllowlist: hooks.environmentAllowlist,
      });
      // C4Q: harness-owned evidence wiring — the verification command and the
      // executor model identity come from harness configuration（never from
      // model text）and are attached to the task card for the evidence builder.
      taskCard.verificationCommand = Array.isArray(hooks.verificationCommand) ? hooks.verificationCommand : null;
      taskCard.expectedExecutorModel = hooks.expectedExecutorModel ?? "";
      taskCard.expectedExecutorProvider = hooks.expectedExecutorProvider ?? "";

      // Baseline snapshot taken immediately before this phase runs, so a
      // serialized later phase sees the state AFTER earlier phases.
      const baselineSnapshot = captureScopeSnapshot(cwd);
      // The sealed scope gate matches full changed-file paths against glob
      // patterns; a concrete canonical boundary is expanded to its subtree
      // patterns here (mechanical, never wider than the boundary).
      taskCard.mutationScope = {
        repositoryRoot: cwd,
        baselineSnapshot,
        allowedPaths: deriveScopePatterns(taskCard.allowedPaths),
        forbiddenPaths: deriveScopePatterns(taskCard.forbiddenPaths),
      };

      const executorAdapter = executorAdapterFactory();
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
          onReviewerCompleted: (info) => hooks.lifecycle?.onReviewerCompleted?.({ phaseId, ...info }),
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
        phaseResults.push({ phaseId, status: "passed", final: "PASS", attempt: lifecycle.attempt });
        return { status: "passed" };
      }
      phaseResults.push({ phaseId, status: "held", final: "HOLD", attempt: lifecycle.attempt, reason: lifecycle.reason ?? null });
      return { status: "held" };
    } catch (e) {
      if (e instanceof PhaseCardError) {
        transitions.push({ phaseId, executionId: null, final: "HOLD", attempt: null, reason: e.code, lifecycleTransitions: [] });
        phaseResults.push({ phaseId, status: "held", final: "HOLD", reason: e.code });
        await hooks.onPhaseTerminal?.({ phaseId, final: "HOLD", reason: e.code });
        return { status: "held" };
      }
      // Unexpected exception → failed（runner propagates to HOLD + skips descendants）
      transitions.push({ phaseId, executionId: null, final: "HOLD", attempt: null, reason: `exception:${e?.code || e?.name || "unknown"}`, lifecycleTransitions: [] });
      phaseResults.push({ phaseId, status: "failed", final: "HOLD", reason: `exception:${e?.code || e?.name || "unknown"}` });
      await hooks.onPhaseTerminal?.({ phaseId, final: "HOLD", reason: `exception:${e?.code || e?.name || "unknown"}` });
      return { status: "failed" };
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
