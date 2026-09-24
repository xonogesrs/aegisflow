// src/admission/admission-gate.mjs
//
// TA-2R（finding 1 / NEG19）— MANDATORY production admission gate.
//
// The TA-2 runner APIs（runColimaGraph / runSubagentGraph / runDurableGraph）
// accept `admission = null` for backward compatibility（internal sub-graph
// calls, legacy callers, tests）— the external review found this means a
// production caller could reach decomposition/execution WITHOUT a frozen
// admission, contradicting the "ONE authoritative admission decision BEFORE
// decomposition" objective.
//
// This module IS the production entrypoint: `runAdmittedGraph` enforces the
// admission gate BEFORE any dispatch — no admission → HOLD / ADMISSION_REQUIRED
//（the underlying runner is NEVER invoked, so no decomposition/execution can
// start）; malformed → HOLD / ADMISSION_INVALID; tampered / unfrozen → HOLD /
// ADMISSION_DRIFT. Only a validated FROZEN admission passes the gate, and it
// is handed to the runner unchanged（the runner never re-derives it — A1:
// src/admission/* is the ONLY admission authority）.
//
// The gate is fail-closed by construction（assertProductionAdmission returns a
// HOLD before any await of the runner）and is proven by the negative suite
//（test/admission/test-admission-gate.mjs）with an injected spy runner: no
// admission ⇒ the spy is never called.
//
// Production callers MUST go through runAdmittedGraph（or the per-runner
// *Admitted wrappers below）; the low-level runner `admission` parameter stays
// a compatibility surface only.

import { validateAdmission, assertAdmissionFrozen, deriveAdmissionId } from "./admission-record.mjs";
import { createBudgetEnforcement } from "../budget/enforcement.mjs";
import { attachBudgetResult } from "../budget/graph-wiring.mjs";
import { digestOf } from "../canonical-digest.mjs";
// R-06: THE shared production telemetry seam (canonical location wiring +
// default-on instrumentation + explicit-disable). Resolved once per
// production run in runAdmittedGraph below.
import { resolveProductionTelemetryWiring, attachTelemetryDisposition } from "../telemetry/production-observer.mjs";
// PRODUCTION ACTIVATION (evolution §C): the post-result evolution trigger
// observer. Same wiring shape as R-06 telemetry: fail-open observability
// attached AFTER the runner returns — it NEVER changes admission, budget,
// lifecycle, closeout, verdict, or promotion semantics, and it mints NO
// authority (a fired signal becomes a candidate only through the separate
// evolution loop entry, never inline in a production run).
import { observeRunForEvolutionTriggers, attachEvolutionObservation } from "../evolution/production-observer.mjs";
import {
  resolveEvolutionProductionConfig,
  consumeEvolutionObservationForProduction,
} from "../evolution/production-consumer.mjs";


export const PRODUCTION_GATE_HOLDS = Object.freeze({
  ADMISSION_REQUIRED: "ADMISSION_REQUIRED",
  ADMISSION_INVALID: "ADMISSION_INVALID",
  ADMISSION_DRIFT: "ADMISSION_DRIFT",
  ALLOCATION_BINDING_MISMATCH: "ALLOCATION_BINDING_MISMATCH",
  AUTHORITY_SEAM_OVERRIDE_REJECTED: "AUTHORITY_SEAM_OVERRIDE_REJECTED",
});

// RSL2 bypass fence: governance DI seams（review barrier / closeout gate /
// surface redirection）are INTERNAL test seams of the runners. A production
// caller must never be able to replace the universal execution-review
// barrier or redirect the fixed Latest surface through runnerOpts. These
// keys are rejected fail-closed BEFORE any dispatch; tests that need DI call
// the raw runners directly（runColimaGraph etc.）, never this entrypoint.
export const AUTHORITY_SEAM_RUNNER_KEYS = Object.freeze([
  "executionReviewBarrier",
  "closeoutGate",
  "closeoutSourceBuilder",
  "closeoutEvidenceWriter",
  "executionReviewSurfaceDir",
  "executionReviewArchiveDir",
  // STAGE C PRODUCTION WIRING fence: the selection bind pair and the
  // issuance-authentication resolver are derived INSIDE the runners from the
  // authoritative admission/allocation. A caller-supplied substitute through
  // runnerOpts would let runtime input choose its own tool authority.
  "toolSelectionContext",
  "selectionAuthority",
  // STAGE D cross-session rollover fence (T22): rollover session identity,
  // generation and trigger control are minted by THE rollover authority
  // from durable truth — never accepted through the execution sink.
  "rolloverControl",
  "rolloverSessionBinding",
  "rolloverTriggerEvent",
  "successorSessionIdentity",
  "sessionIdentityDigest",
  "sessionGeneration",
  "spawnSuccessorSession",
  // STAGE D PRODUCTION WIRING fence (WP2): the mid-run rollover executor is
  // derived INSIDE this gate from the frozen admission + durable truth — a
  // caller-supplied substitute would mint successor authority from runtime
  // input. Canonical internal injection happens below for graph="durable"
  // and graph="subagent".
  "rolloverRequestExecutor",
]);
// WP2: THE canonical internal rollover executor derivation lives in
// src/rollover/production-wiring.mjs (SINGLE definition — the successor
// resume path in durable-graph.mjs derives through the SAME factory).
const deriveCanonicalRolloverExecutor = async ({ admission }) =>
  (await import("../rollover/production-wiring.mjs")).deriveCanonicalRolloverExecutor({ admission });

/**
 * Validate a per-task allocation BOUND to the admission at the execution
 * sink（CP-2R2 Finding 1）: the allocation must carry the exact taskId /
 * admissionId it was produced for and a re-derivable integrity digest. This
 * rejects reuse of another task's allocation and substituted/reconstructed
 * allocations BEFORE any runner is invoked. Dimension narrowing（≤ envelope）
 * is enforced by createBudgetEnforcement.
 */
function validateExecutionAllocation(admission, allocation) {
  if (allocation === null || allocation === undefined) return { ok: true, dimensions: null };
  if (typeof allocation !== "object" || Array.isArray(allocation)) {
    return { ok: false, holdCode: PRODUCTION_GATE_HOLDS.ALLOCATION_BINDING_MISMATCH, reason: "ALLOCATION_BINDING_MISMATCH: allocation must be an object" };
  }
  const { taskId, admissionId, dimensions, allocationId } = allocation;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return { ok: false, holdCode: PRODUCTION_GATE_HOLDS.ALLOCATION_BINDING_MISMATCH, reason: "ALLOCATION_BINDING_MISMATCH: allocation.taskId missing" };
  }
  if (typeof admissionId !== "string" || admissionId.length === 0) {
    return { ok: false, holdCode: PRODUCTION_GATE_HOLDS.ALLOCATION_BINDING_MISMATCH, reason: "ALLOCATION_BINDING_MISMATCH: allocation.admissionId missing" };
  }
  if (admissionId !== admission.admission_id) {
    return { ok: false, holdCode: PRODUCTION_GATE_HOLDS.ALLOCATION_BINDING_MISMATCH, reason: `ALLOCATION_BINDING_MISMATCH: allocation.admissionId ${String(admissionId).slice(0, 12)} != admission.admission_id ${String(admission.admission_id).slice(0, 12)} (another task's allocation)` };
  }
  if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) {
    return { ok: false, holdCode: PRODUCTION_GATE_HOLDS.ALLOCATION_BINDING_MISMATCH, reason: "ALLOCATION_BINDING_MISMATCH: allocation.dimensions must be an object" };
  }
  if (typeof allocationId !== "string" || allocationId.length === 0) {
    return { ok: false, holdCode: PRODUCTION_GATE_HOLDS.ALLOCATION_BINDING_MISMATCH, reason: "ALLOCATION_BINDING_MISMATCH: allocation.allocationId missing" };
  }
  const expected = digestOf({ taskId, admissionId, dimensions });
  if (expected !== allocationId) {
    return { ok: false, holdCode: PRODUCTION_GATE_HOLDS.ALLOCATION_BINDING_MISMATCH, reason: "ALLOCATION_BINDING_MISMATCH: allocation integrity digest mismatch (substituted/reconstructed allocation)" };
  }
  return { ok: true, dimensions };
}

/**
 * Fail-closed gate: is this a valid FROZEN admission?
 *
 * @param {object|null} admission
 * @returns {{ok: true, admission: object} | {ok: false, holdCode: string, reason: string}}
 *   ok:false ALWAYS returns before any execution work — the caller must not
 *   dispatch.
 */
export function assertProductionAdmission(admission) {
  if (!admission || typeof admission !== "object" || Array.isArray(admission) || Object.keys(admission).length === 0) {
    return {
      ok: false,
      holdCode: PRODUCTION_GATE_HOLDS.ADMISSION_REQUIRED,
      reason: "ADMISSION_REQUIRED: production execution requires a frozen admission record; decomposition/execution is gated until one is provided (TA-2R mandatory admission authority)",
    };
  }
  // Not frozen: no bound id, or a malformed one（NEG11 drift class）.
  if (typeof admission.admission_id !== "string" || !/^[0-9a-f]{64}$/.test(admission.admission_id)) {
    return {
      ok: false,
      holdCode: PRODUCTION_GATE_HOLDS.ADMISSION_DRIFT,
      reason: "ADMISSION_DRIFT: admission_id missing or malformed — the record is not frozen (freezeAdmission binds the deterministic id)",
    };
  }
  // Tamper / drift: the payload must RE-DERIVE its own frozen id（NEG11）.
  let derived = null;
  try {
    derived = deriveAdmissionId(admission);
  } catch (e) {
    return { ok: false, holdCode: PRODUCTION_GATE_HOLDS.ADMISSION_INVALID, reason: `ADMISSION_INVALID: cannot derive admission_id (${String(e?.message ?? e).slice(0, 80)})` };
  }
  if (derived !== admission.admission_id) {
    return {
      ok: false,
      holdCode: PRODUCTION_GATE_HOLDS.ADMISSION_DRIFT,
      reason: `ADMISSION_DRIFT: payload re-derives ${derived.slice(0, 12)} != frozen ${admission.admission_id.slice(0, 12)} — the record was tampered after freezing`,
    };
  }
  const v = validateAdmission(admission);
  if (!v.ok) {
    return {
      ok: false,
      holdCode: PRODUCTION_GATE_HOLDS.ADMISSION_INVALID,
      reason: `ADMISSION_INVALID: ${v.errors.slice(0, 4).join("; ")}`,
    };
  }
  // Belt & suspenders（stored == authoritative here; id equality already
  // proven above, kept for the boundary contract）.
  const frozen = assertAdmissionFrozen({ stored: admission, authoritativeAdmissionId: admission.admission_id, authoritativeRecord: admission });
  if (!frozen.ok) {
    return { ok: false, holdCode: PRODUCTION_GATE_HOLDS.ADMISSION_DRIFT, reason: frozen.reason };
  }
  return { ok: true, admission };
}

/**
 * THE production entrypoint. Enforces assertProductionAdmission BEFORE any
 * dispatch, then runs the chosen runner WITH the frozen admission.
 *
 * TA-3（Admission-Driven Runtime Budget Enforcement）: this entrypoint is
 * also the single budget-authority seam — after the admission gate passes,
 * the budget ENVELOPE is derived from the frozen admission（B1: admission is
 * authority; the runtime can never widen it）, the ledger is initialized or
 * RESUMED（B3: crash/resume never resets consumption）, and the enforcement
 * is injected into the runner（pre-dispatch → execute → record → post-op
 * → durable checkpoint/evidence）. A runner that does NOT honor the budget
 * chain fails the finalize() reconciliation（NEG13）— production execution
 * cannot bypass budget enforcement.
 *
 * @param {object} opts
 * @param {object} opts.admission — frozen admission record（mandatory）
 * @param {"colima"|"subagent"|"durable"} [opts.graph] — which production runner
 * @param {Function} [opts.runner] — explicit runner（tests inject a spy）;
 *   overrides `graph`
 * @param {object} [opts.budget] — { checkpointState? (durable ledger state
 *   from a previous run of the SAME admission — cumulative resume),
 *   parentEnforcement? (child/sub-graph monotonic restriction B2),
 *   childLimits? (explicit monotonic narrowing), allocation? (authoritative
 *   per-task allocation { taskId, admissionId, dimensions, allocationId }
 *   bound by the global allocator — CP-2R2 Finding 1) }
 * @param {...object} opts — forwarded to the runner（ir, parent, cwd, …）
 * @returns {Promise<object>} runner result, or the HOLD when the gate fails
 *   BEFORE the runner is invoked（nodeResults: [] — no execution started）.
 */
export async function runAdmittedGraph({ admission, graph = null, runner = null, budget = null, ...runnerOpts }) {
  const gate = assertProductionAdmission(admission);
  if (!gate.ok) {
    return {
      final: "HOLD",
      holdCode: gate.holdCode,
      reason: gate.reason,
      nodeResults: [],
      transitions: [],
      closeout: { applied: false },
    };
  }
  let fn = runner;
  if (!fn) {
    if (graph === "colima") {
      fn = (await import("../runtime/colima-graph-runner.mjs")).runColimaGraph;
    } else if (graph === "subagent") {
      fn = (await import("../subagent/subagent-graph-runner.mjs")).runSubagentGraph;
    } else if (graph === "durable") {
      fn = (await import("../v2/durable-graph.mjs")).runDurableGraph;
    } else {
      return {
        final: "HOLD",
        holdCode: PRODUCTION_GATE_HOLDS.ADMISSION_INVALID,
        reason: "ADMISSION_INVALID: production gate requires graph=colima|subagent|durable or an explicit runner",
        nodeResults: [],
        transitions: [],
        closeout: { applied: false },
      };
    }
  }
  // ── RSL2 bypass fence: reject governance DI-seam overrides ────────────
  // The universal execution-review barrier and the closeout gate are
  // authority seams. A caller-supplied replacement via runnerOpts would let
  // a formal execution reach a terminal PASS without publishing its review.
  // Fail closed BEFORE the runner is invoked（nodeResults: []）.
  const seamConflicts = Object.keys(runnerOpts).filter((k) => AUTHORITY_SEAM_RUNNER_KEYS.includes(k));
  if (seamConflicts.length > 0) {
    return {
      final: "HOLD",
      holdCode: PRODUCTION_GATE_HOLDS.AUTHORITY_SEAM_OVERRIDE_REJECTED,
      reason: `AUTHORITY_SEAM_OVERRIDE_REJECTED: caller options override governance authority seams: ${seamConflicts.join(",")}`,
      nodeResults: [],
      transitions: [],
      closeout: { applied: false },
    };
  }
  if (typeof fn !== "function") {
    return {
      final: "HOLD",
      holdCode: PRODUCTION_GATE_HOLDS.ADMISSION_INVALID,
      reason: "ADMISSION_INVALID: runner is not a function",
      nodeResults: [],
      transitions: [],
      closeout: { applied: false },
    };
  }

  // ── CP-2R2 Finding 1: bind the authoritative per-task allocation ───────
  // The allocation produced by the global allocator MUST become the effective
  // execution limit. Validate its admission binding + integrity digest BEFORE
  // any budget enforcement / runner dispatch.
  const allocation = validateExecutionAllocation(admission, budget?.allocation ?? null);
  if (!allocation.ok) {
    return {
      final: "HOLD",
      holdCode: allocation.holdCode,
      reason: allocation.reason,
      nodeResults: [],
      transitions: [],
      closeout: { applied: false },
    };
  }

  // ── TA-3: derive the budget authority from the FROZEN admission ────────
  // Fail-closed BEFORE dispatch: an admission whose budget contract is
  // invalid / declares an unsupported meter（NEG8/NEG9）or whose durable
  // ledger state is malformed/tampered（NEG12）HOLDs here — the runner is
  // never invoked.
  const enforcementResult = createBudgetEnforcement({
    admission,
    checkpointState: budget?.checkpointState ?? null,
    parentEnforcement: budget?.parentEnforcement ?? null,
    childLimits: allocation.dimensions ?? budget?.childLimits ?? null,
  });
  if (!enforcementResult.ok) {
    return {
      final: "HOLD",
      holdCode: enforcementResult.holdCode ?? "BUDGET_AUTHORITY_INVALID",
      reason: enforcementResult.reason ?? "BUDGET_AUTHORITY_INVALID",
      nodeResults: [],
      transitions: [],
      closeout: { applied: false },
      budget: {
        schema: "autoloop.budget-enforcement-result/v1",
        authorized: false,
        surface: "production-gate",
        holdCode: enforcementResult.holdCode ?? "BUDGET_AUTHORITY_INVALID",
        reason: enforcementResult.reason ?? "BUDGET_AUTHORITY_INVALID",
      },
    };
  }
  const enforcement = enforcementResult.enforcement;

  // ── R-06: canonical production telemetry (default-on, authority-fenced) ──
  // ONE shared seam: the run-scoped telemetry state is resolved HERE through
  // resolveTelemetryStateRoot (S16 canonical namespace / validated override)
  // and forwarded to the runner — no per-caller instrumentation, no private
  // persistent root, no repo-local fallback. telemetry:false is the explicit
  // disable; anything falsy means default-on. A telemetry failure degrades
  // to a diagnostic disposition on the result envelope and NEVER changes
  // admission / budget / lifecycle / verdict semantics (S16 §C/§J).
  const telemetryRunId = String(runnerOpts.executionId ?? admission.admission_id ?? "");
  const telemetryResolution = await resolveProductionTelemetryWiring({
    telemetryOpt: runnerOpts.telemetry,
    graphRunId: telemetryRunId,
    generation: 0,
  });
  const productionTelemetry = telemetryResolution.wiring;
  if (telemetryResolution.disposition) {
    runnerOpts.telemetryDisposition = telemetryResolution.disposition;
  }

  // The frozen admission is forwarded UNCHANGED（the runner consumes it; it
  // never re-derives or amends it — A1）; the budget enforcement travels with
  // it so the production runner executes the pre-dispatch → record → post-op
  // chain（and the durable layer persists the ledger checkpoint）.
  // WP2: the graph="durable" AND graph="subagent" production paths receive
  // THE canonical internal rollover executor derived from the frozen
  // admission + durable truth — never a caller-supplied closure (fenced
  // above), never an env override. The sub-agent path forwards it to
  // runDurableGraph (the sub-agent runner IS a durable production entry), so
  // provider-usage observation + the automatic trigger are reachable through
  // real sub-agent graphs as well.
  let canonicalRolloverExecutor = null;
  if (graph === "durable" || graph === "subagent") {
    canonicalRolloverExecutor = await deriveCanonicalRolloverExecutor({ admission });
  }
  const result = await fn({
    ...runnerOpts,
    admission,
    budget: { ...(budget ?? {}), enforcement },
    // R-06: the resolved telemetry wiring (canonical object) OR explicit
    // false (disable) — never undefined, so runner-side default resolution
    // cannot re-enable a disabled run.
    telemetry: productionTelemetry ?? false,
    ...(canonicalRolloverExecutor ? { rolloverRequestExecutor: canonicalRolloverExecutor } : {}),
  });
  // R-06: attach the telemetry disposition to the envelope (observability
  // only; the disposition never rewrites any other field).
  if (telemetryResolution.disposition) {
    attachTelemetryDisposition(result, telemetryResolution.disposition);
  }
  // EVOLUTION (production activation §C + wiring repair §A): post-result
  // trigger observation over the run's durable evidence journal, followed by
  // THE production consumer. The observation is read-only over the journal,
  // kill-switch aware, and fail-open: an observer failure degrades to an
  // absent/empty observation and NEVER blocks NORMAL_OPERATION. Only a
  // QUALIFIED signal (≥ the class's minimum evidence count inside its window)
  // surfaces here.
  //
  // The consumer (§A/§B/§C/§D) then, for a qualified signal ONLY: records the
  // durable trigger through the existing trigger-state machinery, enforces the
  // kill switch and single-flight, and SCHEDULES runEvolutionCycle. It is
  // NEVER awaited — the run envelope below stays authoritative and an
  // evolution failure can never turn a successful run into HOLD/FAIL.
  try {
    const evolutionConfig = resolveEvolutionProductionConfig({ runnerOpts });
    const observation = observeRunForEvolutionTriggers({
      evidenceRoot: runnerOpts.persistence?.root ?? null,
      executionId: result?.executionId ?? runnerOpts.executionId ?? null,
      graphRunId: telemetryRunId,
      thresholds: evolutionConfig.thresholds,
      storeRoot: evolutionConfig.storeRoot,
    });
    attachEvolutionObservation(result, observation);
    result.evolutionDisposition = consumeEvolutionObservationForProduction({
      observation,
      config: evolutionConfig,
      evidenceRoot: runnerOpts.persistence?.root ?? null,
      executionId: result?.executionId ?? runnerOpts.executionId ?? null,
      graphRunId: telemetryRunId,
      // The frozen admission is the ONLY provider authority: the consumer reads
      // the admitted provider_binding from it for attribution (§A) and never
      // re-derives or replaces it (§E).
      admission,
    });
  } catch {
    // Evolution observation/consumption failure is observability + scheduling
    // only: it must never block or alter NORMAL_OPERATION (card §C).
  }
  // Finalize + reconcile（NEG13）: the runner's runtime evidence and the
  // ledger MUST agree; divergence is a HOLD, never a warning-only event.
  return attachBudgetResult(result, enforcement);
}

// Per-runner production wrappers（thin; same mandatory gate）.
export async function runColimaGraphAdmitted(opts) {
  return runAdmittedGraph({ ...opts, graph: "colima" });
}
export async function runSubagentGraphAdmitted(opts) {
  return runAdmittedGraph({ ...opts, graph: "subagent" });
}
export async function runDurableGraphAdmitted(opts) {
  return runAdmittedGraph({ ...opts, graph: "durable" });
}
