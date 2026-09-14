// src/control-plane/contract.mjs
//
// CP-2 — frozen Control Plane / cost-optimizer constants (CP-1 contracts).
//
// This module carries ONLY frozen vocabulary + configuration truth. It is
// NOT an authority and holds NO decision logic: it defines the closed enums
// the optimizer may emit and the hold codes it may report, so an optimizer
// decision can never escape the contract (OPT-3).
//
// Configuration vs contract (CP-1 F2): the model allowlist VALUE below is
// operational/configuration truth (the R9 single-model policy). It is NOT a
// second authoritative copy — it is READ directly from the single runtime
// source-of-truth (R9 transport freeze) and bound as the CP's allowlist view
// (CP-2R2 Finding 4). A lawful change to the allowlist changes configuration,
// not the optimizer contract.

import { TRANSPORT_FREEZE } from "../v2/pi-transport-adapter.mjs";
import { EXECUTOR_RUNTIMES } from "../admission/policy-projection.mjs";

export { EXECUTOR_RUNTIMES };

export const CONTROL_PLANE_SCHEMA = "autoloop.control-plane/v1";
export const CONTROL_PLANE_VERSION = 1;

export const OPTIMIZER_DECISION_SCHEMA = "autoloop.optimizer-decision/v1";
export const OPTIMIZER_DECISION_VERSION = 1;

// Closed recommendation kinds (CP-1 §3 + C1): the optimizer either makes a
// bounded recommendation, declines (NO_RECOMMENDATION → the authoritative
// owner's existing default / sole eligible option applies), or reports an
// authoritative constraint that requires HOLD.
export const RECOMMENDATION_KINDS = Object.freeze([
  "RECOMMENDATION",
  "NO_RECOMMENDATION",
  "HOLD",
]);

// Closed retry/replan transition vocabulary. The Lifecycle Runner owns which
// transitions are legal now; the optimizer only selects within the eligible
// subset it is handed.
export const RETRY_REPLAN_CHOICES = Object.freeze(["CONTINUE", "RETRY", "REPLAN"]);

// Closed reviewer-strategy vocabulary, owned by the admission review policy.
export const REVIEWER_STRATEGIES = Object.freeze(["deterministic", "independent", "external"]);

// Escalation class for an in-envelope decision.
export const ESCALATION_IN_ENVELOPE = "IN_ENVELOPE";

// Hold codes the optimizer may REPORT. These are authoritative-constraint
// reports, never a new HOLD authority (CP-1 F2 / OPT-1): the optimizer says
// "the authoritative constraint requires HOLD"; the authoritative owner
// (lifecycle runner / admission / budget) still executes the transition.
export const OPTIMIZER_HOLDS = Object.freeze({
  MALFORMED_INPUT: "OPTIMIZER_MALFORMED_INPUT",
  MISSING_PROVENANCE: "OPTIMIZER_MISSING_PROVENANCE",
  MISSING_BUDGET_AUTHORITY: "OPTIMIZER_MISSING_BUDGET_AUTHORITY",
  MISSING_LIFECYCLE_AUTHORITY: "OPTIMIZER_MISSING_LIFECYCLE_AUTHORITY",
  CONTRADICTORY_AUTHORITY: "OPTIMIZER_CONTRADICTORY_AUTHORITY",
  OUT_OF_ENVELOPE: "OPTIMIZER_OUT_OF_ENVELOPE",
  UNKNOWN_ENUM: "OPTIMIZER_UNKNOWN_ENUM",
  OWNERSHIP_UNRESOLVED: "OPTIMIZER_OWNERSHIP_UNRESOLVED",
  RUNTIME_UNRESOLVED: "OPTIMIZER_RUNTIME_UNRESOLVED",
  BUDGET_EXHAUSTED: "OPTIMIZER_BUDGET_EXHAUSTED",
  NO_ELIGIBLE_OPTION: "OPTIMIZER_NO_ELIGIBLE_OPTION",
});

// Execution hold codes reported by the coordinator sink (executeSequentially)
// when a caller attempts to substitute authority between planning and the
// execution sink (CP-2R2 Findings 1/3). These are reported constraints, not
// a new authority.
export const EXECUTION_HOLDS = Object.freeze({
  PLAN_TAMPERED: "CP_PLAN_TAMPERED",
  ADMISSION_IDENTITY_MISMATCH: "CP_ADMISSION_IDENTITY_MISMATCH",
  ALLOCATION_MISSING: "CP_ALLOCATION_MISSING",
  ALLOCATION_BINDING_MISMATCH: "CP_ALLOCATION_BINDING_MISMATCH",
  AUTHORITY_OVERRIDE_REJECTED: "CP_AUTHORITY_OVERRIDE_REJECTED",
  // Stage B — proportional SOP scale bind: the former `graph === null`
  // silent skip is replaced by fail-closed direct-execution routing. The
  // three FAST_PATH_* codes are card-mandated exact strings.
  FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED: "FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED",
  FAST_PATH_DIRECT_SCALE_MISMATCH: "FAST_PATH_DIRECT_SCALE_MISMATCH",
  FAST_PATH_RISKY_TINY_TASK_FENCED: "FAST_PATH_RISKY_TINY_TASK_FENCED",
  GRAPH_RUNTIME_UNRESOLVED: "CP_GRAPH_RUNTIME_UNRESOLVED",
  DIRECT_EXECUTION_INPUT_INVALID: "CP_DIRECT_EXECUTION_INPUT_INVALID",
  DIRECT_RUNNER_EXCEPTION: "CP_DIRECT_RUNNER_EXCEPTION",
  SOP_REQUIRED_STAGE_HANDLER_MISSING: "CP_SOP_REQUIRED_STAGE_HANDLER_MISSING",
  SOP_FORBIDDEN_STAGE_BOUND: "CP_SOP_FORBIDDEN_STAGE_BOUND",
});

/**
 * Configuration truth (NOT contract semantics — see header): the current
 * R9 executor model allowlist, read from the single authoritative runtime
 * source-of-truth (TRANSPORT_FREEZE). Fail-closed: if the authoritative
 * configuration cannot be validated, this is null and the optimizer HOLDs
 * (OWNERSHIP_UNRESOLVED), never falling back to a second value set.
 */
export const EXECUTOR_MODEL_ALLOWLIST = (() => {
  try {
    if (
      TRANSPORT_FREEZE &&
      typeof TRANSPORT_FREEZE.provider === "string" && TRANSPORT_FREEZE.provider.length > 0 &&
      typeof TRANSPORT_FREEZE.model === "string" && TRANSPORT_FREEZE.model.length > 0
    ) {
      return Object.freeze([
        Object.freeze({ provider: TRANSPORT_FREEZE.provider, model: TRANSPORT_FREEZE.model }),
      ]);
    }
  } catch {
    // fall through to fail-closed null
  }
  return null;
})();
