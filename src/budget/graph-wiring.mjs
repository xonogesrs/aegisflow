// src/budget/graph-wiring.mjs
//
// AUTOLOOP-TA3 — production graph wiring（the runner-side half of the
// enforcement chain）.
//
// The production runners（runColimaGraph / runSubagentGraph /
// runDurableGraph）accept a `budget` opt carrying a budget enforcement
// object. This module provides:
//
//   AUTOLOOP-V1-STAGE-G-P7-GOVERNANCE-CENTRIC-SUBTRACTION-IMPLEMENTATION-1
//   (M07): the former wrapGraphHooks convenience wrapper was REMOVED here —
//   zero production callers (admission-verified); the lifecycle
//   reviewer-admission chain it wrapped is wired directly by the production
//   runners（colima-graph-runner lifecycle hooks / SOP direct runner）and the
//   budget suites were re-pointed to that same chain. attachBudgetResult and
//   the COMPAT surface are unchanged.
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
