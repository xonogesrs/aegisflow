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
import { isRetrievalAuthorized } from "./policy-projection.mjs";
import { createBudgetEnforcement } from "../budget/enforcement.mjs";
import { attachBudgetResult } from "../budget/graph-wiring.mjs";
import { digestOf } from "../canonical-digest.mjs";
import { resolveReviewCloseout, prepareReviewLifecycle, completeReviewLifecycle, ensureCurrentReviewJob } from "../governance/review-lifecycle.mjs";
import { readCloseoutState } from "../governance/closeout-state.mjs";

export const PRODUCTION_GATE_HOLDS = Object.freeze({
  ADMISSION_REQUIRED: "ADMISSION_REQUIRED",
  ADMISSION_INVALID: "ADMISSION_INVALID",
  ADMISSION_DRIFT: "ADMISSION_DRIFT",
  ALLOCATION_BINDING_MISMATCH: "ALLOCATION_BINDING_MISMATCH",
});

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
export async function runAdmittedGraph({ admission, graph = null, runner = null, budget = null, reviewSurfaceDir = null, ...runnerOpts }) {
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

  // ── REVART-LC1-B1 — review lifecycle authority gate (pure, pre-dispatch).
  // A review-required admission (review_policy.strength independent|external)
  // MUST carry a complete frozen `extensions.review_closeout` binding with a
  // non-zero authority digest chain and mutation_scope ⊆ authorized_scope;
  // a non-review-required admission MUST NOT carry one. Any violation HOLDs
  // BEFORE the runner is invoked (nodeResults: []).
  const lifecycle = resolveReviewCloseout(admission);
  if (!lifecycle.ok) {
    return {
      final: "HOLD",
      holdCode: lifecycle.holdCode,
      reason: lifecycle.reason,
      nodeResults: [],
      transitions: [],
      closeout: { applied: false },
      lifecycle: { active: false, holdCode: lifecycle.holdCode },
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

  // ── REVART-LC1-B1 — admission-driven lifecycle bootstrap BEFORE dispatch.
  // For a review-required run, materialize + persist the canonical
  // closeout-state.json from the frozen binding (create-or-verify; FM-3
  // card-start baseline). Any bootstrap failure HOLDs here — the runner is
  // NEVER invoked (fail-closed, Issue #8 negative #1). Caller `closeout`
  // runner opts are NON-authoritative once a binding is present (B0: no
  // runtime supplement) and are stripped so the runner cannot double-drive
  // or redirect the lifecycle seam.
  let prepared = null;
  let forward = runnerOpts;
  if (lifecycle.active) {
    if (Object.prototype.hasOwnProperty.call(forward, "closeout")) {
      forward = { ...forward };
      delete forward.closeout;
    }
    prepared = await prepareReviewLifecycle({ admission, binding: lifecycle.binding });
    if (!prepared.ok) {
      return {
        final: "HOLD",
        holdCode: prepared.holdCode,
        reason: prepared.reason,
        nodeResults: [],
        transitions: [],
        closeout: { applied: false },
        lifecycle: { active: true, holdCode: prepared.holdCode },
      };
    }
  }

  // ── CBM-LIVE (AUTOLOOP-CBM-LIVE-INTEGRATION-1) — ONE provider
  // construction/ownership path at the production entrypoint ──────────────
  // An admission that authorizes retrieval (memory_policy.retrieval_allowed
  // === true — an explicit capability, never a global default) gets the
  // single read-only memory provider automatically; no caller-specific
  // dogfood injection is required. An unauthorized admission gets NO
  // provider, so the runner's isRetrievalAuthorized(admission) && memory
  // gate fails closed (no retrieval). A caller-supplied provider is
  // respected unchanged (the same interface). Provider availability is
  // never authority: a missing/unusable store yields the governed
  // EMPTY_MEMORY / MEMORY_STORE_INVALID semantics inside the provider.
  if (!forward.memory && isRetrievalAuthorized(admission)) {
    const { createGraphMemoryProvider } = await import("../memory/graph-context.mjs");
    forward = { ...forward, memory: { provider: createGraphMemoryProvider({}) } };
  }

  // The frozen admission is forwarded UNCHANGED（the runner consumes it; it
  // never re-derives or amends it — A1）; the budget enforcement travels with
  // it so the production runner executes the pre-dispatch → record → post-op
  // chain（and the durable layer persists the ledger checkpoint）.
  const result = await fn({ ...forward, admission, budget: { ...(budget ?? {}), enforcement } });
  // Finalize + reconcile（NEG13）: the runner's runtime evidence and the
  // ledger MUST agree; divergence is a HOLD, never a warning-only event.
  let finalResult = attachBudgetResult(result, enforcement);

  // ── REVART-LC1-B1/B2 — mandatory completion trigger. At implementation
  // PASS, automatically run the existing state-driven closeout against the
  // bootstrapped state (bundle generation/validation/delivery stay owned by
  // review-bundle), then materialize the governed review job. The terminal
  // is decided from the PERSISTED closeout state (B0 I11 / B2-6): a card
  // whose closeout is APPLIED+PASS with review outstanding is REVIEW_PENDING
  // — a review-required run NEVER returns terminal PASS from here; only an
  // accepted authoritative review (Controller acceptance) yields PASS. On a
  // re-entry where the closeout is already APPLIED+PASS, mutation of the
  // lifecycle's OWN governance-domain outputs (bundle/job artifacts) is not
  // re-opened — the run resumes to REVIEW_PENDING and ensures the job;
  // implementation mutation OUTSIDE the governance domain is caught by the
  // job's candidate-drift verification (REVIEW_JOB_CANDIDATE_DRIFT → HOLD).
  // A genuinely failed closeout (HOLD / AWAITING_BUNDLE_DELIVERY with the
  // state NOT APPLIED+PASS) propagates fail-closed — never a successful
  // terminal without artifacts.
  if (lifecycle.active && finalResult.final === "PASS") {
    const outcome = await completeReviewLifecycle({
      admission,
      binding: lifecycle.binding,
      graphResult: finalResult,
      repoRoot: prepared.repoRoot,
      surfaceDir: reviewSurfaceDir,
    });
    const closeout = { applied: true, ...outcome };
    const stateAfter = readCloseoutState(outcome.statePath);
    const st = stateAfter.ok ? stateAfter.state : null;
    const appliedPass = st?.closeout?.status === "APPLIED" && st?.closeout?.final === "PASS";
    let terminal;
    let jobRes = null;
    if (appliedPass) {
      const status = st.closeout?.externalReviewStatus ?? "AWAITING_EXTERNAL_REVIEW";
      if (status === "PASS") {
        terminal = { final: "PASS", holdCode: null, reason: null };
      } else {
        terminal = { final: "REVIEW_PENDING", holdCode: null, reason: null };
        jobRes = await ensureCurrentReviewJob({
          admission,
          binding: lifecycle.binding,
          statePath: outcome.statePath,
          repoRoot: prepared.repoRoot,
        });
      }
    } else {
      const f = outcome.final;
      if (f === "HOLD" || f === "AWAITING_BUNDLE_DELIVERY") {
        terminal = { final: f, holdCode: outcome.holdCode ?? null, reason: outcome.reason ?? null };
      } else {
        terminal = { final: f === "PASS" ? "PASS" : "REVIEW_PENDING", holdCode: null, reason: null };
      }
    }
    if (jobRes && !jobRes.ok) {
      // REVIEW_PENDING without a governed job is not a clean terminal.
      return {
        ...finalResult,
        final: "HOLD",
        holdCode: jobRes.holdCode,
        reason: jobRes.reason,
        closeout,
        reviewJob: { ok: false, holdCode: jobRes.holdCode },
      };
    }
    finalResult = {
      ...finalResult,
      ...terminal,
      closeout,
      ...(jobRes?.ok
        ? { reviewJob: {
            ok: true,
            created: jobRes.created,
            reused: jobRes.reused,
            jobId: jobRes.job.jobId,
            generation: jobRes.job.generation,
            state: jobRes.job.state,
            path: jobRes.path,
            root: jobRes.root,
          } }
        : {}),
    };
  }
  return finalResult;
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
