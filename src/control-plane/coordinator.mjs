// src/control-plane/coordinator.mjs
//
// CP-2R2 — cross-task Control Plane coordinator (CP-1 §7 minimal seams),
// repaired for sink-time authority/budget enforcement.
//
// This module is the COORDINATION seam, not a policy authority:
//   - orders tasks (priority, then stable input index),
//   - derives each task's budget envelope from the frozen admission (B1),
//   - SPLITS the Controller global budget across tasks collectively so the
//     sum of allocations stays inside the global budget (Finding 1),
//   - requires each task's ledger-derived `remaining` (never defaults to the
//     full envelope — Finding 2),
//   - CONSUMES the Lifecycle Runner's authoritative eligible transition set
//     (never derives it from budget counters — Finding 2),
//   - derives the executor runtime strictly from admission policy via the
//     admission owner (no permissive fallback — Finding 5),
//   - BINDS each task's authoritative allocation + admission identity into
//     the plan and the execution request (Findings 1/3),
//   - dispatches execution ONLY through runAdmittedGraph, never letting
//     caller options override authoritative fields (Finding 3).
//
// It never re-owns admission / budget / telemetry / lifecycle / review.

import { runAdmittedGraph, assertProductionAdmission } from "../admission/admission-gate.mjs";
import { deriveBudgetEnvelope } from "../budget/envelope.mjs";
import { ENFORCED_DIMENSIONS } from "../budget/contract.mjs";
// P7 subtraction (M25-optimizer): the telemetry AGGREGATE is advisory-only
// input for the OPTIONAL optimizer. It is loaded lazily through the same
// optional seam so the governance core never hard-imports the telemetry
// module for advisory purposes (OBSERVABILITY_ONLY — no acceptance/rejection
// authority ever flows from it).
import { digestOf } from "../canonical-digest.mjs";
import { deriveExecutorRuntime } from "../admission/policy-projection.mjs";
import { deriveLifecycleEligibleTransitions } from "../lifecycle-runner.mjs";
// P7 subtraction (M25-optimizer → OPTIONAL_ORCHESTRATION): the advisory
// optimizer is NO LONGER a hard-core import. The coordinator holds the
// budget authority (global split, envelope derivation, allocation binding)
// and consumes the optimizer only through the OPTIONAL advisory seam below —
// absent advisory ⇒ deterministic advisory-fallback decision, core
// unaffected. Nothing authoritative moves into the optional layer.
import { assertReviewArtifactEnforced } from "../governance/review-artifact-gate.mjs";
import { assessDirectExecutionTask, createDirectExecutionRunner } from "../sop/proportional-sop.mjs";
import {
  CONTROL_PLANE_SCHEMA,
  CONTROL_PLANE_VERSION,
  OPTIMIZER_DECISION_SCHEMA,
  OPTIMIZER_DECISION_VERSION,
  REVIEWER_STRATEGIES,
  OPTIMIZER_HOLDS,
  EXECUTION_HOLDS,
  EXECUTOR_MODEL_ALLOWLIST,
} from "./contract.mjs";

/**
 * Stage B — the ONE SOP-bound direct execution runner (FAST_PATH/S0). It is
 * dispatched only through runAdmittedGraph below, so every direct task still
 * crosses the admission gate, the governance seam fence, allocation binding
 * and budget enforcement. Created once; stateless per run.
 */
const DIRECT_EXECUTION_RUNNER = createDirectExecutionRunner();
export { deriveExecutorRuntime };

// ── P7 subtraction (M25-optimizer): OPTIONAL advisory layer resolution ──
// The advisory optimizer and the advisory telemetry aggregate live in the
// OPTIONAL orchestration/telemetry layers. They are resolved ONCE at module
// load through try/catch dynamic imports; absence (file missing, import
// failure) degrades to null and the coordinator runs its deterministic
// advisory fallback. NOTHING authoritative lives behind these imports: the
// coordinator's budget authority (global split, envelope, allocation
// binding) and the execution sink's admission/identity/allocation gates are
// entirely local to the core.
let ADVISORY_OPTIMIZER = null;
let ADVISORY_TELEMETRY_AGGREGATE = null;
try {
  ADVISORY_OPTIMIZER = await import("../orchestration/optimizer.mjs");
} catch {
  ADVISORY_OPTIMIZER = null; // optional layer absent — advisory fallback applies
}
try {
  ADVISORY_TELEMETRY_AGGREGATE = await import("../telemetry/aggregate.mjs");
} catch {
  ADVISORY_TELEMETRY_AGGREGATE = null; // advisory provenance unavailable — fallback applies
}

/**
 * Eligible reviewer set owned by the admission review policy (singleton
 * projection — the CP consumes admission authority, it does not mint it).
 */
export function deriveEligibleReviewers(admission = null) {
  const strength = admission?.review_policy?.strength ?? null;
  if (!strength || strength === "none") return null;
  return REVIEWER_STRATEGIES.includes(strength) ? [strength] : [];
}

/** min(ledger remaining, global allocation) per dimension — the effective
 *  capacity that determines whether a transition is executable. */
function effectiveRemaining(budgetRemaining, allocation) {
  if (budgetRemaining === null || budgetRemaining === undefined) return budgetRemaining;
  if (typeof budgetRemaining !== "object" || Array.isArray(budgetRemaining)) return budgetRemaining;
  const eff = { ...budgetRemaining };
  const dims = allocation?.dimensions ?? null;
  if (dims && typeof dims === "object" && !Array.isArray(dims)) {
    for (const [d, limit] of Object.entries(dims)) {
      if (!Number.isFinite(limit)) continue;
      if (eff[d] === null || eff[d] === undefined) eff[d] = limit;
      else eff[d] = Math.min(eff[d], limit);
    }
  }
  return eff;
}

/**
 * Collective global-budget split (Finding 1): sequential narrowing over the
 * ordered tasks so sum(allocations) ≤ global and no task exceeds its own
 * envelope. Deterministic (order is deterministic). Zero global remaining
 * yields zero allocation → not executable.
 */
function splitGlobalBudget(ordered, globalBudget) {
  const allocationMap = {};
  if (globalBudget === null || globalBudget === undefined) {
    for (const t of ordered) allocationMap[t.taskId] = null;
    return { allocationMap, globalRemaining: null };
  }
  if (typeof globalBudget !== "object" || Array.isArray(globalBudget) || !globalBudget.dimensions || typeof globalBudget.dimensions !== "object" || Array.isArray(globalBudget.dimensions)) {
    return { allocationMap: null, globalRemaining: null, error: { holdCode: OPTIMIZER_HOLDS.MALFORMED_INPUT, reason: "globalBudget.dimensions must be an object" } };
  }
  const dims = Object.keys(globalBudget.dimensions);
  for (const d of dims) {
    if (!ENFORCED_DIMENSIONS.includes(d)) return { allocationMap: null, globalRemaining: null, error: { holdCode: OPTIMIZER_HOLDS.UNKNOWN_ENUM, reason: `globalBudget unknown dimension ${d}` } };
    const v = globalBudget.dimensions[d];
    if (v !== null && v !== undefined && (!Number.isFinite(v) || v < 0)) return { allocationMap: null, globalRemaining: null, error: { holdCode: OPTIMIZER_HOLDS.MALFORMED_INPUT, reason: `globalBudget ${d} invalid (${v})` } };
  }
  const remaining = { ...globalBudget.dimensions };
  for (const t of ordered) {
    const alloc = {};
    for (const d of dims) {
      const g = remaining[d];
      const envLimit = t.envelope?.dimensions?.[d]?.limit ?? null;
      const cap = (envLimit === null || envLimit === undefined) ? g : Math.min(g, envLimit);
      alloc[d] = cap;
      remaining[d] = g - cap;
    }
    allocationMap[t.taskId] = { dimensions: alloc };
  }
  return { allocationMap, globalRemaining: remaining };
}

function holdDecision(holdCode, reason) {
  return {
    schema: OPTIMIZER_DECISION_SCHEMA,
    version: OPTIMIZER_DECISION_VERSION,
    recommendation: "HOLD",
    holdCode,
    escalationClass: holdCode,
    reasons: [`${holdCode}: ${reason}`],
    executor: null,
    runtime: null,
    retryReplan: null,
    reviewerStrategy: null,
    budgetAllocation: null,
    observedProvenance: null,
    decisionId: digestOf({ holdCode, reason }),
  };
}

// P7 subtraction (M25-optimizer): the OPTIONAL advisory seam. When the
// optional orchestration layer is present it exposes runOptimizer(ctx) →
// decision record; when it is ABSENT the coordinator falls back to this
// deterministic advisory-fallback decision. The fallback is NOT an
// acceptance/rejection authority: the coordinator's own budget authority
// (global split + envelope + allocation binding) and the execution sink's
// admission/allocation/identity gates are unchanged and remain the only
// authority. The fallback preserves the optimizer's own HOLD contract
// (missing lifecycle authority → HOLD) so no advisory absence can widen
// authority.
function advisoryFallbackDecision({ runtime, eligibleTransitions, eligibleReviewers, taskAllocation }) {
  if (eligibleTransitions === null || eligibleTransitions === undefined) {
    return holdDecision(OPTIMIZER_HOLDS.MISSING_LIFECYCLE_AUTHORITY, "missing/invalid lifecycle state (authoritative eligible transition set unavailable)");
  }
  const executor = EXECUTOR_MODEL_ALLOWLIST.length === 1
    ? { provider: EXECUTOR_MODEL_ALLOWLIST[0].provider, model: EXECUTOR_MODEL_ALLOWLIST[0].model }
    : null;
  const retryReplan = Array.isArray(eligibleTransitions) && eligibleTransitions.length === 1 ? eligibleTransitions[0] : null;
  const reviewerStrategy = Array.isArray(eligibleReviewers) && eligibleReviewers.length === 1 ? eligibleReviewers[0] : null;
  const dims = {};
  for (const [d, limit] of Object.entries(taskAllocation?.dimensions ?? {})) {
    if (limit === null || limit === undefined) continue;
    dims[d] = limit;
  }
  const recommendation = (executor || retryReplan || reviewerStrategy) ? "RECOMMENDATION" : "NO_RECOMMENDATION";
  return {
    schema: OPTIMIZER_DECISION_SCHEMA,
    version: OPTIMIZER_DECISION_VERSION,
    recommendation,
    holdCode: null,
    escalationClass: "IN_ENVELOPE",
    reasons: ["advisory layer absent — deterministic advisory fallback (no scoring; coordinator budget authority unchanged)"],
    executor,
    runtime,
    retryReplan,
    reviewerStrategy,
    budgetAllocation: Object.keys(dims).length > 0 ? { dimensions: dims } : null,
    observedProvenance: null,
    decisionId: digestOf({ advisoryFallback: true, runtime, eligibleTransitions, taskAllocation: dims }),
  };
}

/**
 * Bind a per-task allocation to its task + admission + dimensions with an
 * integrity digest (Finding 1). The execution sink re-derives this digest and
 * rejects any substituted / reconstructed / cross-task-reused allocation.
 */
function bindAllocation({ taskId, admissionId, dimensions }) {
  if (!dimensions || typeof dimensions !== "object" || Array.isArray(dimensions)) return null;
  return {
    taskId,
    admissionId,
    dimensions,
    allocationId: digestOf({ taskId, admissionId, dimensions }),
  };
}

function computePlanIdentity(plan) {
  return digestOf({
    orderedTaskIds: plan.orderedTaskIds,
    tasks: plan.tasks.map((t) => ({
      taskId: t.taskId,
      admissionId: t.admissionId,
      runtime: t.runtime,
      decisionId: t.decision?.decisionId ?? null,
      allocationId: t.taskAllocation?.allocationId ?? null,
    })),
  });
}

/**
 * Build the cross-task coordination plan. Pure / deterministic.
 *
 * @param {object} opts
 * @param {Array<{id?, admission, remaining?, priority?, runnerOpts?,
 *        lifecycleState?}>} opts.tasks
 *        — `remaining` is REQUIRED (ledger-derived); `lifecycleState` is
 *        REQUIRED authoritative lifecycle state (Lifecycle Runner owns the
 *        eligible transition set — Finding 2); `runnerOpts` are forwarded as
 *        non-authoritative runner/test options ONLY.
 * @param {object|null} [opts.globalBudget] — { dimensions: { [dim]: limit } }
 * @param {Array<object>} [opts.telemetryEvents] — telemetry events for the
 *        observed optimization input (provenance via aggregate identity).
 *        P7 subtraction (M25-optimizer): consumed ONLY by the optional
 *        advisory layer — the aggregate is computed lazily so the hard core
 *        never imports the telemetry module for advisory purposes.
 * @returns {{ ok: true, plan } | { ok: false, holdCode, reason }}
 */
export function coordinate({ tasks = [], globalBudget = null, telemetryEvents = [] } = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, holdCode: OPTIMIZER_HOLDS.MALFORMED_INPUT, reason: "coordinate requires a non-empty tasks array" };
  }
  // P7 subtraction (M25-optimizer): the aggregate identity is advisory
  // provenance for the OPTIONAL optimizer. The aggregate module is loaded
  // lazily ONLY when events were supplied — with no events this is a pure
  // pass-through and the hard core never touches the telemetry module. A
  // missing/failed aggregate degrades to advisory-absent (fallback), never
  // to an authority change.
  let observed = null;
  if (telemetryEvents.length > 0 && ADVISORY_TELEMETRY_AGGREGATE) {
    try {
      observed = ADVISORY_TELEMETRY_AGGREGATE.aggregateGraphRun({ events: telemetryEvents });
    } catch {
      observed = null;
    }
  }

  const entries = tasks.map((t, i) => {
    const admission = t?.admission ?? null;
    const envelopeResult = admission
      ? deriveBudgetEnvelope(admission)
      : { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: "BUDGET_AUTHORITY_INVALID: missing admission" };
    return {
      taskId: t?.id ?? `task-${i}`,
      admission,
      envelope: envelopeResult.ok ? envelopeResult.envelope : null,
      remaining: t?.remaining ?? null, // REQUIRED — no full-envelope default
      priority: Number.isFinite(t?.priority) ? t.priority : 0,
      order: i,
      runnerOpts: t?.runnerOpts ?? null,
      lifecycleState: t?.lifecycleState ?? null,
      repairAttempts: Number.isFinite(t?.repairAttempts) ? t.repairAttempts : 0,
      cardId: t?.cardId ?? null, // canonical review unit (resolved from the authority record)
      liveReviewBinding: t?.liveReviewBinding ?? null, // derived via deriveLiveReviewBinding (authoritative), never caller-invented
      decision: null,
    };
  });

  const ordered = [...entries].sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
  ordered.forEach((t, idx) => { t.order = idx; });

  const split = splitGlobalBudget(ordered, globalBudget);
  const globalBudgetProvided = globalBudget !== null && globalBudget !== undefined;

  for (const t of ordered) {
    const runtime = t.admission ? deriveExecutorRuntime(t.admission) : null;
    if (split.error) {
      t.decision = holdDecision(split.error.holdCode, split.error.reason);
    } else {
      const taskAllocation = split.allocationMap?.[t.taskId] ?? null;
      const effective = effectiveRemaining(t.remaining, taskAllocation);
      // Authoritative lifecycle eligible set — consumed from the Lifecycle
      // Runner, NEVER synthesized from budget counters (Finding 2).
      const eligibleTransitions = deriveLifecycleEligibleTransitions({
        lifecycleState: t.lifecycleState,
        repairBudget: t.admission?.repair_budget ?? null,
        repairAttempts: t.repairAttempts,
      });
      if (eligibleTransitions === null) {
        t.decision = holdDecision(OPTIMIZER_HOLDS.MISSING_LIFECYCLE_AUTHORITY, "missing/invalid lifecycle state (authoritative eligible transition set unavailable)");
      } else {
        // ── P7 subtraction (M25-optimizer): OPTIONAL advisory seam ────────
        // The optimizer advisory lives in the optional orchestration layer
        // (src/orchestration/optimizer.mjs), resolved at module load. When
        // the layer is ABSENT the coordinator uses the deterministic
        // advisory fallback — the core never depends on the optional layer,
        // and no authority moves into it. The advisory decision is still
        // only a RECOMMENDATION record: the execution sink re-validates
        // admission identity + allocation binding + budget enforcement
        // regardless of what the advisory said.
        t.decision = ADVISORY_OPTIMIZER?.runOptimizer
          ? ADVISORY_OPTIMIZER.runOptimizer({
              admission: t.admission,
              budgetEnvelope: t.envelope,
              budgetRemaining: effective,
              taskAllocation,
              runtime,
              eligibleTransitions,
              eligibleReviewers: deriveEligibleReviewers(t.admission),
              observed: { source: "telemetry-aggregate", aggregateIdentity: observed?.aggregateIdentity ?? "" },
            })
          : advisoryFallbackDecision({
              runtime,
              eligibleTransitions,
              eligibleReviewers: deriveEligibleReviewers(t.admission),
              taskAllocation,
            });
      }
    }
    t.runtime = runtime;
    t.graph = runtime === "direct" ? null : runtime;
  }

  const allocation = Object.fromEntries(ordered.map((t) => [t.taskId, t.decision?.budgetAllocation ?? null]));

  const plan = {
    schema: CONTROL_PLANE_SCHEMA,
    version: CONTROL_PLANE_VERSION,
    globalBudgetProvided,
    orderedTaskIds: ordered.map((t) => t.taskId),
    tasks: ordered.map((t) => {
      const taskAllocation = bindAllocation({
        taskId: t.taskId,
        admissionId: t.admission?.admission_id ?? null,
        dimensions: split.allocationMap?.[t.taskId]?.dimensions ?? null,
      });
      return {
        taskId: t.taskId,
        admissionId: t.admission?.admission_id ?? null,
        admission: t.admission,
        priority: t.priority,
        order: t.order,
        runtime: t.runtime,
        graph: t.graph,
        runnerOpts: t.runnerOpts,
        decision: t.decision,
        cardId: t.cardId,
        liveReviewBinding: t.liveReviewBinding,
        taskAllocation,
      };
    }),
    allocation,
    globalRemaining: split.globalRemaining ?? null,
    planIdentity: null,
  };
  plan.planIdentity = computePlanIdentity(plan);
  return { ok: true, plan };
}

// Authority fields that a caller may NEVER override through runnerOpts at the
// execution sink (Finding 3). The test-injection `runner` seam is the only
// execution seam; it is extracted separately and still goes through
// runAdmittedGraph's mandatory admission gate.
const AUTHORITATIVE_RUN_KEYS = new Set([
  "admission", "admission_id", "graph", "budget", "allocation", "runtime",
  "profile", "capabilities", "isolation_policy", "durability_policy",
  "memory_policy", "review_policy", "repair_budget", "evidence_policy",
  "human_gates", "review_surface_policy", "authority_binding", "fail_closed",
  "taskId", "taskAllocation", "eligibleTransitions", "lifecycleState",
  // RSL2 bypass fence: governance DI seams must never be caller-overridable
  // through the execution sink（mirrors AUTHORITY_SEAM_RUNNER_KEYS in
  // src/admission/admission-gate.mjs, which enforces the same boundary at
  // the entrypoint itself）.
  "executionReviewBarrier", "closeoutGate", "closeoutSourceBuilder",
  "closeoutEvidenceWriter", "executionReviewSurfaceDir", "executionReviewArchiveDir",
  // STAGE C PRODUCTION WIRING fence（mirrors admission-gate.mjs）: the
  // selection bind pair / authority are runner-internal derivations from the
  // authoritative admission + allocation, never caller-overridable.
  "toolSelectionContext", "selectionAuthority",
  // STAGE D cross-session rollover fence (T22): rollover identity/generation/
  // trigger control is minted by THE rollover authority from durable truth —
  // never accepted from caller options (AUTHORITATIVE_RUN_KEYS pattern).
  "rolloverControl", "rolloverSessionBinding", "rolloverTriggerEvent",
  "successorSessionIdentity", "sessionIdentityDigest", "sessionGeneration",
  "spawnSuccessorSession",
]);

/**
 * Sequence plan.tasks ONE at a time through runAdmittedGraph — the single
 * authoritative production admission surface (Finding 3). No arbitrary
 * runner, no caller override of authoritative fields, and each task's
 * authoritative allocation is bound into the execution request so the runner
 * sees the narrowed effective limits (Finding 1).
 *
 * HOLDed tasks are skipped; direct-execution (FAST_PATH/S0) tasks are bound
 * to the single SOP direct execution runner (Stage B) and dispatched through
 * the SAME runAdmittedGraph boundary — the former `graph === null` silent
 * skip is removed (no silent fallback — Finding 5).
 */
export async function executeSequentially({ plan = null } = {}) {
  if (!plan || !Array.isArray(plan.tasks)) return { ok: false, reason: "plan.tasks required", results: [] };

  // Plan integrity: reject a tampered plan before any dispatch.
  if (computePlanIdentity(plan) !== plan.planIdentity) {
    return { ok: false, holdCode: EXECUTION_HOLDS.PLAN_TAMPERED, reason: "plan identity does not re-derive (plan tampered)", results: [] };
  }

  const results = [];
  for (const task of plan.tasks) {
    if (task.decision?.recommendation === "HOLD") {
      results.push({ taskId: task.taskId, dispatched: false, holdCode: task.decision.holdCode });
      continue;
    }
    // Separate authoritative fields from caller runner/test options (Finding 3).
    // Checked BEFORE any routing/dispatch decision — an authority-seam
    // override is rejected regardless of runtime.
    const { runner, ...forward } = task.runnerOpts ?? {};
    const conflicts = Object.keys(forward).filter((k) => AUTHORITATIVE_RUN_KEYS.has(k));
    if (conflicts.length > 0) {
      results.push({ taskId: task.taskId, dispatched: false, holdCode: EXECUTION_HOLDS.AUTHORITY_OVERRIDE_REJECTED, reason: `caller options override authoritative execution fields: ${conflicts.join(",")}` });
      continue;
    }

    // ── Stage B proportional SOP scale bind ──────────────────────────────
    // A direct-execution task (runtime "direct" ⇒ graph null) is routed
    // through the SAME admission/allocation/authority gauntlet below via the
    // SOP-bound direct lifecycle runner. A null/missing graph under ANY
    // other runtime is contradictory authority and fails closed.
    let isDirectExecution = false;
    if (task.graph === null || task.graph === undefined) {
      if (task.runtime !== "direct") {
        results.push({
          taskId: task.taskId,
          dispatched: false,
          holdCode: EXECUTION_HOLDS.GRAPH_RUNTIME_UNRESOLVED,
          reason: "graph runtime unresolved for a non-direct task (graph===null silent skip removed)",
        });
        continue;
      }
      const readiness = assessDirectExecutionTask(task);
      if (!readiness.ok) {
        // Explicit fail-closed HOLD at the sink (card-mandated codes) — the
        // former silent `dispatched:false` skip is unreachable.
        results.push({ taskId: task.taskId, dispatched: false, holdCode: readiness.holdCode, reason: readiness.reason });
        continue;
      }
      isDirectExecution = true;
    }

    // Admission identity binding (Finding 3): the admission reaching the sink
    // must be EXACTLY the planned admission identity.
    const gate = assertProductionAdmission(task.admission);
    if (!gate.ok) {
      results.push({ taskId: task.taskId, dispatched: false, holdCode: gate.holdCode, reason: gate.reason });
      continue;
    }
    if (task.admission.admission_id !== task.admissionId) {
      results.push({ taskId: task.taskId, dispatched: false, holdCode: EXECUTION_HOLDS.ADMISSION_IDENTITY_MISMATCH, reason: "admission identity does not match the planned admissionId" });
      continue;
    }

    // Allocation binding (Finding 1): a Controller global budget was provided
    // ⇒ every executable task must carry its authoritative allocation.
    if (plan.globalBudgetProvided) {
      if (!task.taskAllocation) {
        results.push({ taskId: task.taskId, dispatched: false, holdCode: EXECUTION_HOLDS.ALLOCATION_MISSING, reason: "missing task allocation where a Controller global budget was allocated" });
        continue;
      }
      if (task.taskAllocation.taskId !== task.taskId || task.taskAllocation.admissionId !== task.admission.admission_id) {
        results.push({ taskId: task.taskId, dispatched: false, holdCode: EXECUTION_HOLDS.ALLOCATION_BINDING_MISMATCH, reason: "task allocation is bound to a different task/admission" });
        continue;
      }
      if (digestOf({ taskId: task.taskAllocation.taskId, admissionId: task.taskAllocation.admissionId, dimensions: task.taskAllocation.dimensions }) !== task.taskAllocation.allocationId) {
        results.push({ taskId: task.taskId, dispatched: false, holdCode: EXECUTION_HOLDS.ALLOCATION_BINDING_MISMATCH, reason: "task allocation integrity digest mismatch (substituted/reconstructed allocation)" });
        continue;
      }
    }

    const result = await runAdmittedGraph({
      admission: task.admission,
      graph: task.graph,
      // Stage B: for direct tasks the caller-supplied test `runner` seam is
      // deliberately IGNORED — the SOP-bound direct execution runner is the
      // only lawful EXECUTION-stage handler, so an injected substitute can
      // never bypass the proportional bind. Its DI (adapters/taskCard/cwd)
      // still arrives through forward (non-authoritative keys only).
      runner: isDirectExecution ? DIRECT_EXECUTION_RUNNER : runner,
      budget: { allocation: task.taskAllocation ?? null },
      ...forward,
    });

    // ── REVIEW-ROUTING-R1: mandatory review-artifact enforcement at the
    // verdict-acceptance owner. A review-required task (review_policy.strength
    // independent|external) may only yield an accepted verdict when its
    // canonical card carries an ACCEPTED, non-superseded review job. Console
    // PASS has zero authority.
    const reviewGate = assertReviewArtifactEnforced({
      admission: task.admission,
      cardId: task.cardId ?? null,
      candidateIdentity: task.liveReviewBinding?.candidateIdentity ?? null,
      specDigest: task.liveReviewBinding?.specDigest ?? null,
    });
    if (!reviewGate.ok) {
      results.push({ taskId: task.taskId, dispatched: true, result, reviewArtifactEnforced: false, holdCode: reviewGate.holdCode, reason: reviewGate.reason });
      continue;
    }

    results.push({ taskId: task.taskId, dispatched: true, result, reviewArtifactEnforced: reviewGate.reviewRequired });
  }
  return { ok: true, results };
}
