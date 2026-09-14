// src/sop/proportional-sop.mjs
//
// AUTOLOOP-V1-PROPORTIONAL-EXECUTION-SOP-SCALE-BIND-1 — Stage B.
//
// THE single named 12-stage SOP sequencer bind (roadmap §1 skeleton +
// §8 FIRST_NEXT_CARD; roadmap §9 lists this sequencer as MISSING_BEHAVIOR
// to be added "as one bind, not twelve new modules").
//
// What this module is NOT:
//   - NOT a second classifier. Scale is a pure PROJECTION of the frozen
//     admission's profile (src/admission/classify.mjs stays the only
//     classification authority; src/admission/policy-projection.mjs stays
//     the only PROFILE_MATRIX authority).
//   - NOT a second lifecycle runner. The S0/direct EXECUTION stage calls
//     the EXISTING src/lifecycle-runner.mjs runLifecycle() and always
//     enters execution through the EXISTING production boundary
//     (runAdmittedGraph) — admission gate, RSL2 governance seam fence,
//     allocation binding and budget enforcement are inherited, never
//     bypassed.
//   - NOT a new durable engine / authority schema / terminal semantics.
//
import { runLifecycle } from "../lifecycle-runner.mjs";
import { PROFILE_MATRIX, createLifecycleSelectionAuthority, TOOL_SELECTION_SCHEMA } from "../admission/policy-projection.mjs";
import { mintTaskCardToolSelectionBind } from "../v2/phase-task-card.mjs";
import { assertProductionAdmission } from "../admission/admission-gate.mjs";
import { BUDGET_HOLD_CODES, countLogicalReviewerAttempts } from "../budget/contract.mjs";
import { EXECUTION_HOLDS } from "../control-plane/contract.mjs";
import { BudgetHoldError } from "../budget/ledger.mjs";

// Proportional rule: every named stage's disposition
// (REQUIRED | ALLOWED_TO_SKIP | FORBIDDEN | NOT_APPLICABLE) is DERIVED
// from the profile's PROFILE_MATRIX row. No stage may be skipped
// implicitly (missing handler / null graph / empty value): a required
// stage without a bound handler fails closed.

export const SOP_SCALE_BIND_SCHEMA = "autoloop.sop-scale-bind/v1";
export const SOP_SCALE_BIND_VERSION = 1;

export const STAGE_DISPOSITIONS = Object.freeze([
  "REQUIRED",
  "ALLOWED_TO_SKIP",
  "FORBIDDEN",
  "NOT_APPLICABLE",
]);

export const SCALES = Object.freeze(["S0", "S1", "S2", "S3"]);

/**
 * Named 12-stage V1 skeleton — verbatim roadmap §1 stage order. This IS the
 * canonical registry; nothing else in src/ may re-declare the stage list.
 */
export const SOP_STAGES = Object.freeze([
  "TASK_INTAKE",
  "TASK_UNDERSTANDING",
  "CURRENT_STATE_RECONCILIATION",
  "TASK_SIZE_AND_RISK_CLASSIFICATION",
  "PLAN",
  "CAPABILITY_AND_TOOL_SELECTION",
  "EXECUTION",
  "CHECKPOINT/SESSION_ROLLOVER",
  "VERIFY",
  "CLOSEOUT",
  "REVIEW",
  "LEARNING",
]);

/**
 * Roadmap §1.1 S0–S3 ↔ existing-profile mapping. Pure projection over the
 * PROFILE_MATRIX key vocabulary (no second size enum). Unknown profile ⇒
 * throw (fail closed) — a matrix row without a scale binding must never
 * silently route.
 */
export const SCALE_FOR_PROFILE = Object.freeze({
  FAST_PATH: "S0", // XS/S + LOW + no risk signal
  STANDARD: "S1", // M + LOW typical
  MEDIUM: "S2", // complex/cross-surface
  MEDIUM_LARGE: "S2",
  LARGE_LOW: "S2",
  HIGH: "S3", // high-risk / phase-level
  CRITICAL: "S3",
});

for (const profile of Object.keys(PROFILE_MATRIX)) {
  if (!Object.hasOwn(SCALE_FOR_PROFILE, profile)) {
    throw new Error(`SOP scale bind drift: PROFILE_MATRIX row ${profile} has no roadmap §1.1 scale binding`);
  }
}

/** One scale result per profile — read-only projection of the frozen matrix vocabulary. */
export function scaleForProfile(profile) {
  const scale = SCALE_FOR_PROFILE[profile];
  if (!scale) throw new Error(`unknown profile: ${String(profile)}`);
  return scale;
}

const D = {
  REQUIRED: "REQUIRED",
  ALLOWED_TO_SKIP: "ALLOWED_TO_SKIP",
  FORBIDDEN: "FORBIDDEN",
  NOT_APPLICABLE: "NOT_APPLICABLE",
};

/**
 * Derive one stage's disposition STRICTLY from the profile's frozen
 * PROFILE_MATRIX row (`d`). `basis` names the deciding fields so every
 * disposition is auditable back to the matrix.
 *
 * Field-driven rules (no invented semantics):
 *   - TASK_INTAKE: admission is mandatory at every scale → REQUIRED.
 *   - TASK_UNDERSTANDING: no matrix row requires an understanding-payload
 *     stage today → ALLOWED_TO_SKIP everywhere (matrix-authorized skip).
 *   - CURRENT_STATE_RECONCILIATION: only meaningful when durability is
 *     required (crash/resume reconciliation) → REQUIRED iff
 *     durable_execution_required, else NOT_APPLICABLE.
 *   - TASK_SIZE_AND_RISK_CLASSIFICATION: classification evidence is part of
 *     every frozen admission → REQUIRED.
 *   - PLAN: required exactly when the matrix requires decomposition or
 *     research-first planning; otherwise matrix-authorized skip.
 *   - CAPABILITY_AND_TOOL_SELECTION: deny-by-default CAP projection applies
 *     at every scale → REQUIRED.
 *   - EXECUTION: every admitted task executes (direct or graph path) →
 *     REQUIRED.
 *   - CHECKPOINT/SESSION_ROLLOVER: REQUIRED iff checkpoint_resume_required,
 *     else NOT_APPLICABLE.
 *   - VERIFY: lifecycle verification (deterministic reviewer at S0;
 *     independent/external at higher scales) → REQUIRED.
 *   - CLOSEOUT: truthful terminal result publication at every scale (bundle
 *     depth comes from closeout_bundle_required) → REQUIRED.
 *   - REVIEW: formal terminals cannot skip review by profile → REQUIRED
 *     (strength scales via review_policy.strength).
 *   - LEARNING: memory_writeback_allowed=false on every current matrix row →
 *     FORBIDDEN (must not execute); an allowed row would make it
 *     ALLOWED_TO_SKIP.
 */
function stageDisposition(stage, d) {
  switch (stage) {
    case "TASK_INTAKE":
      return { disposition: D.REQUIRED, basis: ["admission mandatory (all profiles)"] };
    case "TASK_UNDERSTANDING":
      return { disposition: D.ALLOWED_TO_SKIP, basis: ["no matrix field requires understanding payload"] };
    case "CURRENT_STATE_RECONCILIATION":
      return d.durable_execution_required
        ? { disposition: D.REQUIRED, basis: ["durable_execution_required"] }
        : { disposition: D.NOT_APPLICABLE, basis: ["durability_policy: ephemeral"] };
    case "TASK_SIZE_AND_RISK_CLASSIFICATION":
      return { disposition: D.REQUIRED, basis: ["classification evidence frozen in admission"] };
    case "PLAN":
      return (d.decomposition_required || d.research_first_required)
        ? { disposition: D.REQUIRED, basis: ["decomposition_required || research_first_required"] }
        : { disposition: D.ALLOWED_TO_SKIP, basis: ["neither decomposition_required nor research_first_required"] };
    case "CAPABILITY_AND_TOOL_SELECTION":
      return { disposition: D.REQUIRED, basis: ["deny-by-default CAP projection (all profiles)"] };
    case "EXECUTION":
      return { disposition: D.REQUIRED, basis: ["admitted task must execute truthfully (all profiles)"] };
    case "CHECKPOINT/SESSION_ROLLOVER":
      return d.checkpoint_resume_required
        ? { disposition: D.REQUIRED, basis: ["checkpoint_resume_required"] }
        : { disposition: D.NOT_APPLICABLE, basis: ["checkpoint_resume_required=false"] };
    case "VERIFY":
      return { disposition: D.REQUIRED, basis: ["verify cannot be skipped by profile (review_policy.strength scales)"] };
    case "CLOSEOUT":
      return { disposition: D.REQUIRED, basis: ["truthful terminal publication (bundle depth from closeout_bundle_required)"] };
    case "REVIEW":
      return { disposition: D.REQUIRED, basis: ["formal terminals cannot skip review (review_policy.strength)"] };
    case "LEARNING":
      return d.memory_writeback_allowed
        ? { disposition: D.ALLOWED_TO_SKIP, basis: ["memory_writeback_allowed"] }
        : { disposition: D.FORBIDDEN, basis: ["memory_writeback_allowed=false"] };
    default:
      throw new Error(`unknown SOP stage: ${String(stage)}`);
  }
}

/**
 * Project the proportional stage plan for one profile. Pure; returns a
 * frozen record whose stage list is EXACTLY SOP_STAGES in canonical order.
 * The FULL frozen matrix row is the disposition source (it carries every
 * deciding field, durability/checkpoint/writeback included).
 */
export function projectScalePlan(profile) {
  if (!Object.hasOwn(PROFILE_MATRIX, profile)) throw new Error(`unknown profile: ${String(profile)}`);
  const d = PROFILE_MATRIX[profile];
  const stages = SOP_STAGES.map((stage) => {
    const { disposition, basis } = stageDisposition(stage, d);
    return Object.freeze({ stage, disposition, basis: Object.freeze([...basis]) });
  });
  return Object.freeze({
    schema: SOP_SCALE_BIND_SCHEMA,
    version: SOP_SCALE_BIND_VERSION,
    profile,
    scale: scaleForProfile(profile),
    stages: Object.freeze(stages),
  });
}

/**
 * Fail-closed check: does the caller-supplied handler set cover every
 * REQUIRED stage of the plan? A required stage without a handler is a HOLD,
 * never an implicit skip.
 *
 * @param {object} plan — projectScalePlan() output
 * @param {Record<string, boolean>} handlers — stage → handler present?
 * @returns {{ ok: true } | { ok: false, holdCode, reason }}
 */
export function assertRequiredStagesHandled(plan, handlers = {}) {
  for (const s of plan.stages) {
    if (s.disposition !== "REQUIRED") continue;
    if (handlers[s.stage] !== true) {
      return {
        ok: false,
        holdCode: EXECUTION_HOLDS.SOP_REQUIRED_STAGE_HANDLER_MISSING,
        reason: `${EXECUTION_HOLDS.SOP_REQUIRED_STAGE_HANDLER_MISSING}: required SOP stage ${s.stage} has no bound handler (fail closed; implicit skip is prohibited)`,
      };
    }
  }
  // A FORBIDDEN stage must never carry a handler either — carrying one would
  // signal intent to execute what the matrix forbids.
  for (const s of plan.stages) {
    if (s.disposition === "FORBIDDEN" && handlers[s.stage] === true) {
      return {
        ok: false,
        holdCode: EXECUTION_HOLDS.SOP_FORBIDDEN_STAGE_BOUND,
        reason: `${EXECUTION_HOLDS.SOP_FORBIDDEN_STAGE_BOUND}: stage ${s.stage} is FORBIDDEN by the ${plan.profile} matrix row but a handler was bound`,
      };
    }
  }
  return { ok: true };
}

function directHold(holdCode, reason) {
  return { final: "HOLD", holdCode, reason, nodeResults: [], transitions: [], closeout: { applied: false }, executionPath: "direct" };
}

/**
 * Admission-level direct-execution guards, SHARED by the coordinator sink's
 * pre-dispatch readiness check and the runner itself (one set of rules — no
 * second judgment surface):
 *   1. scale guard — admission profile must project to S0 (FAST_PATH);
 *   2. capability guard — CAP.DIRECT_EXECUTION must be granted by the
 *      deny-by-default capability projection AND authorized by the current
 *      PROFILE_MATRIX row (matrix withdrawal ⇒ fail closed);
 *   3. risky-tiny fence — risk LOW + size XS/S or no direct execution.
 *
 * @param {object|null} admission
 * @returns {{ ok: true } | { ok: false, holdCode, reason }}
 */
export function assessDirectExecution(admission) {
  const profile = admission?.profile ?? null;
  if (profile !== "FAST_PATH" || scaleForProfile(profile) !== "S0") {
    return {
      ok: false,
      holdCode: EXECUTION_HOLDS.FAST_PATH_DIRECT_SCALE_MISMATCH,
      reason: `${EXECUTION_HOLDS.FAST_PATH_DIRECT_SCALE_MISMATCH}: direct execution is bound to the FAST_PATH/S0 matrix row only (profile=${String(profile)})`,
    };
  }
  const allowed = Array.isArray(admission.capabilities?.allowed) ? admission.capabilities.allowed : [];
  if (!allowed.includes("CAP.DIRECT_EXECUTION")) {
    return {
      ok: false,
      holdCode: EXECUTION_HOLDS.FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED,
      reason: `${EXECUTION_HOLDS.FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED}: admission does not grant CAP.DIRECT_EXECUTION`,
    };
  }
  if (PROFILE_MATRIX.FAST_PATH.direct_execution_allowed !== true) {
    return {
      ok: false,
      holdCode: EXECUTION_HOLDS.FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED,
      reason: `${EXECUTION_HOLDS.FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED}: PROFILE_MATRIX no longer authorizes direct execution for FAST_PATH`,
    };
  }
  if (admission.risk !== "LOW" || !["XS", "S"].includes(admission.size)) {
    return {
      ok: false,
      holdCode: EXECUTION_HOLDS.FAST_PATH_RISKY_TINY_TASK_FENCED,
      reason: `${EXECUTION_HOLDS.FAST_PATH_RISKY_TINY_TASK_FENCED}: size=${String(admission.size)} risk=${String(admission.risk)} may not enter the FAST_PATH direct execution path`,
    };
  }
  return { ok: true };
}

/**
 * Sink-side readiness check for ONE planned direct-execution task: the
 * shared admission guards PLUS dependency-injection presence (real executor
 * + reviewer adapters, cwd, taskCard). Absent adapters mean the runtime
 * cannot provide direct execution ⇒ HOLD / FAST_PATH_DIRECT_EXECUTION_
 * UNIMPLEMENTED at the sink (dispatched:false WITH the explicit hold code —
 * never the former silent skip). The runner re-runs the same checks.
 *
 * @param {object} task — plan.tasks[] entry
 * @returns {{ ok: true } | { ok: false, holdCode, reason }}
 */
export function assessDirectExecutionTask(task) {
  const guarded = assessDirectExecution(task?.admission ?? null);
  if (!guarded.ok) return guarded;
  const di = task?.runnerOpts ?? null;
  // STAGE C PRODUCTION WIRING: factory-based executor DI is lawful here —
  // the runner constructs it WITH the selection authority at dispatch time.
  const missingExecutor = (!di?.executorAdapter && typeof di?.executorAdapterFactory !== "function")
    ? "executorAdapter"
    : null;
  const missingReviewer = !di?.reviewerAdapter || typeof di.reviewerAdapter.runAdapter !== "function" ? "reviewerAdapter" : null;
  if (missingExecutor || missingReviewer) {
    return {
      ok: false,
      holdCode: EXECUTION_HOLDS.FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED,
      reason: `${EXECUTION_HOLDS.FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED}: runtime cannot provide direct execution (missing ${(missingExecutor && missingReviewer) ? "executorAdapter,reviewerAdapter" : (missingExecutor ?? missingReviewer)})`,
    };
  }
  if (typeof di.cwd !== "string" || di.cwd.length === 0 || di.taskCard === null || typeof di.taskCard !== "object") {
    return {
      ok: false,
      holdCode: EXECUTION_HOLDS.DIRECT_EXECUTION_INPUT_INVALID,
      reason: `${EXECUTION_HOLDS.DIRECT_EXECUTION_INPUT_INVALID}: direct execution requires a cwd string and a taskCard object`,
    };
  }
  return { ok: true };
}

/**
 * Count meter-relevant lifecycle boundary events with EXACTLY the rules the
 * budget finalize reconciliation applies to runtime evidence
 * (src/budget/enforcement.mjs observeFromResult):
 *   - reviewer attempts = LOGICAL_REVIEW_ATTEMPT
 *     (countLogicalReviewerAttempts — reviewer + reviewer_verdict pair = 1)
 *   - repair attempts   = status/phase REPAIR
 * Recording from the lifecycle EVIDENCE keeps ledger and evidence agreeable
 * by construction (NEG13) instead of by bookkeeping discipline.
 */
function countMeterEvents(lifecycleTransitions) {
  let repair = 0;
  for (const lt of lifecycleTransitions ?? []) {
    const phase = String(lt?.phase ?? "");
    const status = String(lt?.status ?? "");
    if (status.toUpperCase() === "REPAIR" || phase.toUpperCase() === "REPAIR") repair++;
  }
  return { reviewer: countLogicalReviewerAttempts(lifecycleTransitions), repair };
}

/**
 * THE S0/FAST_PATH direct-execution stage handler (Stage B fix for the
 * coordinator's former `graph === null → dispatched:false` silent skip).
 *
 * Intended ONLY as the `runner` handed to the EXISTING production
 * entrypoint runAdmittedGraph(), which enforces the frozen-admission gate,
 * the RSL2 governance-seam fence, allocation binding and the full budget
 * chain BEFORE this function is ever invoked. This handler adds the shared
 * guards (assessDirectExecution), DI validation, the required-stage bind,
 * the budget preDispatch/settle chain around the EXISTING lifecycle runner,
 * and a truthful graph-terminal-shaped result.
 *
 * Synchronous factory: returns the runner closure directly (never a promise
 * of one) so runAdmittedGraph always receives a callable runner.
 *
 * @returns {(runnerOpts: object) => Promise<object>} runner for runAdmittedGraph
 */
export function createDirectExecutionRunner() {
  return async function directExecutionRunner(runnerOpts = {}) {
    const admission = runnerOpts.admission ?? null;

    // ── 1–3. shared admission-level guards (scale/capability/risky-tiny) ──
    const guarded = assessDirectExecution(admission);
    if (!guarded.ok) return directHold(guarded.holdCode, guarded.reason);

    // ── 3b. authority re-validation (defense in depth) ────────────────────
    // Production composition reaches this closure THROUGH runAdmittedGraph
    // (frozen-admission gate + budget chain already enforced there).
    // Re-checking here closes standalone misuse of the exported factory:
    // an unfrozen/tampered admission must never drive real work, and
    // execution without the budget enforcement object is not
    // production-authorized (NEG14 semantics).
    const authorityGate = assertProductionAdmission(admission);
    if (!authorityGate.ok) {
      return directHold(authorityGate.holdCode, `direct execution authority re-check failed: ${authorityGate.reason}`);
    }
    if (!runnerOpts.budget?.enforcement || typeof runnerOpts.budget.enforcement.preDispatch !== "function") {
      return directHold(
        BUDGET_HOLD_CODES.BUDGET_AUTHORITY_INVALID,
        `${BUDGET_HOLD_CODES.BUDGET_AUTHORITY_INVALID}: direct execution requires the runAdmittedGraph budget enforcement chain (standalone invocation is NOT budget-authorized)`,
      );
    }
    // ── 4. DI guard: no adapters ⇒ fail closed, never silently skip ───────
    const { taskCard, executorAdapter, reviewerAdapter, cwd, timeoutMs, hooks, maxRepairAttempts } = runnerOpts;
    const missingExecutor = (!runnerOpts.executorAdapter && typeof runnerOpts.executorAdapterFactory !== "function")
      ? "executorAdapter"
      : null;
    const missingReviewer = !reviewerAdapter || typeof reviewerAdapter.runAdapter !== "function" ? "reviewerAdapter" : null;
    if (missingExecutor || missingReviewer) {
      return directHold(
        EXECUTION_HOLDS.FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED,
        `${EXECUTION_HOLDS.FAST_PATH_DIRECT_EXECUTION_UNIMPLEMENTED}: runtime cannot provide direct execution (missing ${(missingExecutor && missingReviewer) ? "executorAdapter,reviewerAdapter" : (missingExecutor ?? missingReviewer)})`,
      );
    }
    if (typeof cwd !== "string" || cwd.length === 0 || taskCard === null || typeof taskCard !== "object") {
      return directHold(
        EXECUTION_HOLDS.DIRECT_EXECUTION_INPUT_INVALID,
        `${EXECUTION_HOLDS.DIRECT_EXECUTION_INPUT_INVALID}: direct execution requires a cwd string and a taskCard object`,
      );
    }

    // ── 4b. STAGE C PRODUCTION WIRING — THE direct-path selection bind ────
    // THE authoritative pair comes ONLY from the runAdmittedGraph-injected
    // inputs of THIS dispatch（runnerOpts.admission + runnerOpts.budget.
    // allocation）, never from taskCard fields or caller/runtime input. When
    // both exist, EVERY direct execution carries a canonical
    // toolSelectionBind: minted HERE through THE single phase-task-card mint
    // when the composition did not already bind one; a non-canonical caller
    // card.toolPolicy is REPLACED（raw allowlist has zero authority on the
    // direct path either）. The executor factory receives THE one selection
    // authority; a prebuilt adapter instance is used verbatim. No allocation
    //（compat surface）⇒ unchanged legacy composition behavior.
    let selectionAuthority = null;
    let wiredExecutorAdapter = executorAdapter;
    const directAllocation = runnerOpts.budget?.allocation ?? null;
    if (admission && directAllocation && typeof taskCard === "object") {
      try {
        const cardPolicyCanonical = taskCard.toolPolicy !== null && typeof taskCard.toolPolicy === "object"
          && !Array.isArray(taskCard.toolPolicy)
          && taskCard.toolPolicy.contractVersion === TOOL_SELECTION_SCHEMA;
        if (!cardPolicyCanonical) {
          if (typeof taskCard.executionId !== "string" || taskCard.executionId.length === 0) {
            return directHold(
              EXECUTION_HOLDS.DIRECT_EXECUTION_INPUT_INVALID,
              `${EXECUTION_HOLDS.DIRECT_EXECUTION_INPUT_INVALID}: wired direct execution requires a taskCard.executionId to bind runIdentity`,
            );
          }
          // Direct execution has NO sub-agent role（§6.1）: nodeRole=null ⇒
          // intent = the admission's own tool_permissions upper bound — the
          // Stage B CAPABILITY_AND_TOOL_SELECTION bind semantics.
          taskCard.toolPolicy = mintTaskCardToolSelectionBind({
            phase: { effects: {} },
            executionId: taskCard.executionId,
            admission,
            taskAllocation: directAllocation,
            nodeRole: null,
          });
        }
        selectionAuthority = createLifecycleSelectionAuthority({ admission, taskAllocation: directAllocation });
        if (typeof runnerOpts.executorAdapterFactory === "function") {
          wiredExecutorAdapter = runnerOpts.executorAdapterFactory({ selectionAuthority });
        }
      } catch (e) {
        // Selection drift / provenance failure ⇒ truthful HOLD, never a
        // silent no-tools downgrade.
        return directHold(e?.code ?? "TOOL_SELECTION_PROVENANCE_INVALID", `tool selection bind failed closed: ${e?.code ?? e?.name ?? "error"}: ${String(e?.message ?? e).slice(0, 512)}`);
      }
    }

    // ── 5. proportional bind: every REQUIRED S0 stage must have a handler ─
    const plan = projectScalePlan(admission.profile);
    const allowed = admission.capabilities.allowed;
    const bind = assertRequiredStagesHandled(plan, {
      TASK_INTAKE: true, // enforced upstream by the runAdmittedGraph admission gate
      TASK_SIZE_AND_RISK_CLASSIFICATION: Boolean(admission.size && admission.risk),
      CAPABILITY_AND_TOOL_SELECTION: allowed.includes("CAP.DIRECT_EXECUTION"),
      EXECUTION: true, // this runner + runLifecycle below
      VERIFY: true, // lifecycle deterministic reviewer verdict
      CLOSEOUT: true, // truthful terminal publication below
      REVIEW: true, // lifecycle reviewer phase
    });
    if (!bind.ok) return directHold(bind.holdCode, bind.reason);

    // ── 6. budget chain: preDispatch before any lifecycle work ────────────
    const startedAt = new Date().toISOString();
    const wallStart = Date.now();
    const enforcement = runnerOpts.budget?.enforcement ?? null;
    let opKey = null;
    if (enforcement) {
      const gate = enforcement.preDispatch({
        executionId: taskCard.executionId ?? "direct",
        phase_id: "DIRECT_EXECUTION",
        nodeId: "DIRECT_EXECUTION",
        attempt: 0,
        runtime: null,
      });
      if (!gate.ok) {
        return { ...directHold(gate.holdCode, gate.reason), startedAt };
      }
      opKey = gate.opKey;
    }

    // ── 7. EXECUTION stage: the EXISTING lifecycle runner does the work ──
    let lifecycle;
    try {
      lifecycle = await runLifecycle({
        cwd,
        taskCard,
        executorAdapter: wiredExecutorAdapter,
        reviewerAdapter,
        maxRepairAttempts: Number.isInteger(maxRepairAttempts)
          ? maxRepairAttempts
          : Number(admission.repair_budget ?? 0),
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
        hooks: {
          ...(hooks ?? {}),
          onBeforeReviewer: async (info) => {
            if (enforcement) {
              const gate = enforcement.admitReviewer({ nodeId: "DIRECT_EXECUTION", attempt: info?.attempt });
              if (!gate.ok) return gate;
            }
            const upstream = typeof hooks?.onBeforeReviewer === "function" ? await hooks.onBeforeReviewer(info) : { ok: true };
            // R3 §5.3: an upstream pre-invocation refusal proves the reviewer
            // was never started — release THIS reservation（only）safely.
            if (upstream && upstream.ok === false && enforcement) {
              enforcement.cancelReviewerReservation({ nodeId: "DIRECT_EXECUTION", attempt: info?.attempt ?? 0 });
            }
            return upstream;
          },
          onReviewerInvocationStarted: async (info) => {
            // R3: reservation RESERVED → INVOKED at the actual invocation seam.
            if (enforcement) {
              const c = enforcement.confirmReviewerInvoked({ nodeId: "DIRECT_EXECUTION", attempt: info?.attempt ?? 0 });
              if (!c.ok && !c.duplicate) throw new BudgetHoldError(c.holdCode ?? "BUDGET_AUTHORITY_INVALID", c.reason ?? "reviewer invocation confirmation failed closed");
            }
            await hooks?.onReviewerInvocationStarted?.(info);
          },
          onReviewerCompleted: async (info) => {
            if (enforcement) {
              const s = enforcement.recordReviewer({ nodeId: "DIRECT_EXECUTION", attempt: info?.attempt ?? 0 });
              if (!s.ok && !s.duplicate) {
                // R3 review fix: an unsettled real invocation fails closed —
                // the DIRECT_RUNNER_EXCEPTION handler below keeps it a truthful HOLD.
                throw new BudgetHoldError(s.holdCode ?? "BUDGET_AUTHORITY_INVALID", s.reason ?? "reviewer settlement failed closed");
              }
            }
            await hooks?.onReviewerCompleted?.(info);
          },
        },
      });
    } catch (e) {
      // An exception escaping the lifecycle runner must NEVER be swallowed
      // into a fake PASS — surface it as a truthful HOLD.
      return {
        ...directHold(
          EXECUTION_HOLDS.DIRECT_RUNNER_EXCEPTION,
          `${EXECUTION_HOLDS.DIRECT_RUNNER_EXCEPTION}: ${e?.code ?? e?.name ?? "error"}: ${String(e?.message ?? e).slice(0, 512)}`,
        ),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
    const completedAt = new Date().toISOString();
    const latencyMs = Math.max(0, Date.now() - wallStart);

    // ── 8. settle remaining meters FROM the lifecycle evidence (NEG13) ──
    // Reviewer attempts settle at onReviewerCompleted (one logical attempt
    // per real invocation). Repair/retry still follow evidence so ledger
    // and observeFromResult stay agreeable.
    if (enforcement) {
      const { repair } = countMeterEvents(lifecycle.transitions);
      for (let i = 0; i < repair; i++) enforcement.recordRepair({ nodeId: "DIRECT_EXECUTION" });
      if (Number(lifecycle.attempt ?? 0) > 0) {
        for (let a = 0; a < Number(lifecycle.attempt); a++) enforcement.recordRetry({ nodeId: "DIRECT_EXECUTION" });
      }
      const settled = enforcement.recordConsumption({
        opKey,
        actualAmounts: { node_execution_count: 1 },
        wallClockMs: latencyMs,
      });
      if (!settled.ok) {
        return { ...directHold(settled.holdCode, settled.reason), startedAt, completedAt };
      }
    }

    // ── 9. truthful terminal shape (same consumers as graph terminals) ──
    const passed = lifecycle.final === "PASS";
    return {
      final: passed ? "PASS" : "HOLD",
      ...(passed ? {} : { holdCode: lifecycle.reason ?? "LIFECYCLE_HOLD", reason: lifecycle.reason ?? null }),
      executionId: lifecycle.executionId ?? taskCard.executionId ?? "direct",
      executionPath: "direct",
      sopBind: Object.freeze({
        schema: SOP_SCALE_BIND_SCHEMA,
        scale: plan.scale,
        profile: plan.profile,
        selectedStageDispositions: Object.fromEntries(plan.stages.map((s) => [s.stage, s.disposition])),
      }),
      lifecycle: {
        final: lifecycle.final,
        attempt: lifecycle.attempt ?? 0,
        reason: lifecycle.reason ?? null,
        classification: lifecycle.classification ?? null,
      },
      nodeResults: [
        {
          graphExecutionId: lifecycle.executionId ?? "direct",
          nodeId: "DIRECT_EXECUTION",
          phaseExecutionId: `direct:${lifecycle.executionId ?? "direct"}`,
          final: lifecycle.final,
          attempt: lifecycle.attempt ?? 0,
          taskType: "direct",
          resultIdentity: { latencyMs },
          startedAt,
          completedAt,
        },
      ],
      transitions: [
        {
          phaseId: "DIRECT_EXECUTION",
          final: lifecycle.final,
          attempt: lifecycle.attempt ?? 0,
          reason: lifecycle.reason ?? null,
          lifecycleTransitions: lifecycle.transitions ?? [],
        },
      ],
      startedAt,
      completedAt,
      closeout: { applied: false },
    };
  };
}
