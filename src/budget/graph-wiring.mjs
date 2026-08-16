// src/budget/graph-wiring.mjs
//
// AUTOLOOP-TA3 — production graph wiring（the runner-side half of the
// enforcement chain）.
//
// The production runners（runColimaGraph / runSubagentGraph /
// runDurableGraph）accept a `budget` opt carrying a budget enforcement
// object. This module provides:
//
//   wrapGraphHooks(hooks, enforcement, ctx) — wraps the caller's graph hooks
//     so the enforcement chain runs at every lifecycle boundary:
//       onPhaseStart      → preDispatch（BUDGET_EXHAUSTED ⇒ the node is
//                           NEVER dispatched — throw BudgetHoldError）
//       onPhaseTerminal   → recordConsumption（actual counters）
//       onRepairRequested → recordRepair（runtime meter — B4）
//       onReviewerCompleted → recordReviewer
//       retry detection   → recordRetry（attempt > 0）
//
//   attachBudgetResult(result, enforcement) — attaches the structured
//     `budget` section（authorized:true）after finalize.
//
//   COMPAT surface（NEG14）: a low-level runner invoked WITHOUT an
//   enforcement object（direct/legacy/internal calls）attaches
//   budget:{ authorized:false, surface:"compat" } — explicitly NOT a
//   production budget-authorized path. Only runAdmittedGraph（the production
//   entrypoint）marks a result budget-authorized.

import { BUDGET_HOLD_CODES } from "./contract.mjs";
import { BudgetHoldError } from "./ledger.mjs";

/**
 * Wrap runner hooks with the enforcement chain.
 *
 * @param {object} hooks — the caller's hooks（may be undefined）
 * @param {object} enforcement — budget enforcement（from runAdmittedGraph）
 * @param {object} ctx — { executionId, ir }（phase lookup + opKey binding）
 * @returns {object} wrapped hooks（safe to spread into the runner's hooks）
 */
export function wrapGraphHooks(hooks = {}, enforcement, ctx = {}) {
  const executionId = ctx.executionId ?? "graph";
  const phaseFor = (phaseId) => (ctx.ir?.phases ?? []).find((p) => p.phase_id === phaseId) ?? null;

  const onPhaseStart = async ({ phaseId }) => {
    const phase = phaseFor(phaseId);
    const gate = enforcement.preDispatch({
      executionId,
      phase_id: phaseId,
      nodeId: phaseId,
      attempt: 0,
      runtime: phase?.runtime ?? null,
      subagent: phase?.runtime?.mode === "subagent",
    });
    if (!gate.ok) {
      // Fail-closed: the node is NEVER dispatched. The caller converts this
      // into a deterministic HOLD node（executor not invoked）.
      throw new BudgetHoldError(gate.holdCode, gate.reason);
    }
    (hooks.onPhaseStart ?? (async () => {}))({ phaseId, __budget: gate });
  };

  const onPhaseTerminal = async ({ phaseId, final, attempt, reason }) => {
    const phase = phaseFor(phaseId);
    const opKey = `${executionId}:${phaseId}:0`;
    const subagent = phase?.runtime?.mode === "subagent";
    const actual = {
      node_execution_count: final === "SKIPPED_DUE_TO_DEPENDENCY" || final === "NOT_RECORDED" ? null : 1,
      ...(subagent ? { sub_agent_execution_count: final === "SKIPPED_DUE_TO_DEPENDENCY" ? null : 1 } : {}),
    };
    const settled = enforcement.recordConsumption({ opKey, actualAmounts: actual });
    if (!settled.ok) throw new BudgetHoldError(settled.holdCode, settled.reason);
    // retry accounting（attempts beyond the first per node）
    const attemptN = Number(attempt ?? 0);
    if (attemptN > 0) {
      for (let a = 0; a < attemptN; a++) enforcement.recordRetry({ nodeId: phaseId });
    }
    await (hooks.onPhaseTerminal ?? (async () => {}))({ phaseId, final, attempt, reason });
  };

  const lifecycle = {
    ...(hooks.lifecycle ?? {}),
    onRepairRequested: async (info) => {
      enforcement.recordRepair({ nodeId: info?.phaseId ?? null });
      await hooks.lifecycle?.onRepairRequested?.(info);
    },
    onReviewerCompleted: async (info) => {
      enforcement.recordReviewer({ nodeId: info?.phaseId ?? null });
      await hooks.lifecycle?.onReviewerCompleted?.(info);
    },
    onExecutorOutput: async (info) => { await hooks.lifecycle?.onExecutorOutput?.(info); },
    onExecutorCompleted: async (info) => { await hooks.lifecycle?.onExecutorCompleted?.(info); },
    onSystemDeltaReady: async (info) => { await hooks.lifecycle?.onSystemDeltaReady?.(info); },
  };

  return {
    ...hooks,
    onPhaseStart,
    onPhaseTerminal,
    lifecycle,
  };
}

/**
 * Attach the structured budget section to a graph result.
 * - enforcement present → finalize()（authorized:true, reconciliation, HOLD
 *   on divergence NEG13）;
 * - absent → compat surface marker（authorized:false — NEG14）.
 */
export function attachBudgetResult(result, enforcement) {
  if (enforcement) {
    return enforcement.finalize(result);
  }
  return {
    ...(result ?? {}),
    budget: {
      schema: "autoloop.budget-enforcement-result/v1",
      authorized: false,
      surface: "compat",
      reason: "BUDGET_AUTHORITY_INVALID: no budget enforcement attached — this low-level runner surface is NOT production budget-authorized (NEG14); use runAdmittedGraph",
    },
  };
}

export { BUDGET_HOLD_CODES };
