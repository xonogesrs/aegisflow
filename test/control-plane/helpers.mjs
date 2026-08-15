// test/control-plane/helpers.mjs
//
// CP-2 — shared admission fixtures for control-plane tests.

import { classify } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission, deriveAdmissionId } from "../../src/admission/admission-record.mjs";
import { deriveBudgetEnvelope } from "../../src/budget/envelope.mjs";
import { deriveLifecycleEligibleTransitions } from "../../src/lifecycle-runner.mjs";
import { ENFORCED_DIMENSIONS } from "../../src/budget/contract.mjs";

export function allDimensions(overrides = {}) {
  const zero = { score: 0, reasons: ["none"] };
  return {
    affected_files: zero,
    affected_subsystems: zero,
    dependency_depth: zero,
    ambiguity: zero,
    expected_execution_steps: zero,
    verification_burden: zero,
    external_dependencies: zero,
    concurrency_potential: zero,
    statefulness: zero,
    rollback_complexity: zero,
    ...overrides,
  };
}

export function makeFrozenAdmission({
  taskId = "TASK",
  dimensionScores = null,
  riskSignals = [],
  evidenceSufficient = true,
  mutationScope = ["/src"],
  extensions = null,
} = {}) {
  const classification = classify({
    dimensionScores: dimensionScores ?? allDimensions(),
    riskSignals,
    evidenceSufficient,
  });
  const record = buildAdmissionRecord({
    taskId,
    classification,
    mutationScope,
    extensions: extensions ?? {},
  });
  return freezeAdmission(record);
}

// size M (10..15), risk LOW → profile STANDARD.
export function standardAdmission(taskId = "TASK-STD", extensions = null) {
  return makeFrozenAdmission({
    taskId,
    dimensionScores: allDimensions({
      affected_files: { score: 3, reasons: ["multi-file"] },
      affected_subsystems: { score: 3, reasons: ["multi-subsystem"] },
      ambiguity: { score: 2, reasons: ["ambiguous"] },
      expected_execution_steps: { score: 2, reasons: ["steps"] },
      verification_burden: { score: 2, reasons: ["verify"] },
    }),
    riskSignals: [],
    extensions,
  });
}

// size M (10..15), risk HIGH → profile HIGH.
export function highAdmission(taskId = "TASK-HIGH", extensions = null) {
  return makeFrozenAdmission({
    taskId,
    dimensionScores: allDimensions({
      affected_files: { score: 3, reasons: ["multi-file"] },
      affected_subsystems: { score: 3, reasons: ["multi-subsystem"] },
      verification_burden: { score: 2, reasons: ["verify"] },
      external_dependencies: { score: 2, reasons: ["network"] },
    }),
    riskSignals: [{ signal_id: "RS.NETWORK_REMOTE", class: "HIGH", triggered: true, reason: "remote fetch" }],
    extensions,
  });
}

// size S (5..9), risk LOW → profile FAST_PATH (direct execution).
export function fastPathAdmission(taskId = "TASK-FAST") {
  return makeFrozenAdmission({
    taskId,
    dimensionScores: allDimensions({
      affected_files: { score: 2, reasons: ["few"] },
      verification_burden: { score: 2, reasons: ["verify"] },
      expected_execution_steps: { score: 1, reasons: ["steps"] },
    }),
    riskSignals: [],
  });
}

/** Ledger-derived full remaining budget for a frozen admission's envelope. */
export function fullRemaining(admission) {
  const envelope = deriveBudgetEnvelope(admission).envelope;
  return Object.fromEntries(ENFORCED_DIMENSIONS.map((d) => [d, envelope.dimensions[d]?.limit ?? null]));
}

/** Authoritative lifecycle eligible transition set from the Lifecycle Runner
 *  (NOT derived from budget counters). EXECUTING = forward-executable state. */
export function lifecycleEligible(admission, { state = "EXECUTING", repairAttempts = 0 } = {}) {
  return deriveLifecycleEligibleTransitions({
    lifecycleState: state,
    repairBudget: admission?.repair_budget ?? null,
    repairAttempts,
  });
}

/** Standard task shape for the coordinator（with authoritative lifecycle
 *  state + ledger-derived remaining）. */
export function taskInput(id, admission, extra = {}) {
  return {
    id,
    admission,
    remaining: fullRemaining(admission),
    lifecycleState: "EXECUTING",
    ...extra,
  };
}

/** Forge an admission: mutate a field and re-derive a matching admission_id.
 *  This is a REHASHED record — its id is self-consistent but its content is
 *  no longer authoritative/schema-valid. It must be rejected fail-closed. */
export function forgeAdmission(admission, mutations = {}) {
  const { admission_id, decision_time, ...rest } = admission;
  const mutated = { ...rest, ...mutations };
  return { ...mutated, decision_time: admission.decision_time, admission_id: deriveAdmissionId(mutated) };
}
