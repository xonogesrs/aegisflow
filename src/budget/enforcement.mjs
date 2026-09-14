// src/budget/enforcement.mjs
//
// AUTOLOOP-TA3 — budget ENFORCEMENT（the single authoritative runtime
// abstraction）.
//
// createBudgetEnforcement assembles the admission → envelope → ledger →
// enforcement-state chain for ONE production execution:
//
//   runAdmittedGraph (src/admission/admission-gate.mjs) is the production
//   entrypoint: it asserts the frozen admission（TA-2 gate）, derives the
//   envelope（B1: admission is authority）, creates/resumes the ledger（B3:
//   cumulative, no reset on resume）, and injects this enforcement into the
//   runner hooks（pre-dispatch → execute → record → post-op → checkpoint）.
//
// Every production execution path goes through the same abstraction; the
// low-level runners keep their compat surface but are NOT budget-authorized
// unless they carry this enforcement（NEG14）.
//
// Enforcement contract（§3/§4/§8）:
//   B1  envelope derived ONLY from the frozen admission; runtime cannot
//       widen（envelope is deep-frozen + id-verified on every resume/merge）
//   B2  child budgets are a MONOTONIC projection of the parent's remaining
//       budget（projectChild + mergeChild fail closed）
//   B3  resume never resets consumption（resumeBudgetLedger）
//   B4  repair_attempt_count is a RUNTIME meter; it never merges with the
//       TA-2 repair budget authority（admission.repair_budget / lineage）
//   §4  states: CONTINUE / APPROACHING_LIMIT / BUDGET_EXHAUSTED /
//       BUDGET_AUTHORITY_INVALID（machine-readable）
//   NEG13 finalize() reconciles the runtime evidence（nodeResults /
//       transitions）against the ledger — divergence is a HOLD, never a
//       warning-only event（NEG11）.

import { createHash } from "node:crypto";
import {
  BUDGET_HOLD_CODES,
  DEFAULT_OP_WALL_CLOCK_CAP,
  ENFORCED_DIMENSIONS,
  deepFreeze,
  countLogicalReviewerAttempts,
} from "./contract.mjs";
import { deriveBudgetEnvelope, assertEnvelopeUntampered } from "./envelope.mjs";
import {
  createBudgetLedger,
  resumeBudgetLedger,
  checkpointBudgetLedger,
  remainingBudget,
  mergeChildCounters,
  stateFromCounters,
  ledgerReserve,
  ledgerSettle,
  ledgerConfirm,
  ledgerCancelReservation,
  BudgetHoldError,
} from "./ledger.mjs";

export { BudgetHoldError, BUDGET_HOLD_CODES };

function sha256Hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}
function canonical(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Narrow an envelope by explicit per-task/per-child limits (MONOTONIC —
 * never widen). Used for both the Controller global-budget allocation
 * (top-level, CP-2R2 Finding 1) and child projections (B2). Fail-closed on
 * unknown dimensions, invalid values, or any limit that exceeds the
 * admission-derived envelope (or the parent's remaining budget when one is
 * present). Returns a deep-frozen narrowed envelope with a re-derived,
 * self-consistent envelopeId.
 */
function narrowEnvelopeByLimits(envelope, limits, parentEnforcement = null) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    return { ok: false, holdCode: BUDGET_HOLD_CODES.BUDGET_AUTHORITY_INVALID, reason: "BUDGET_AUTHORITY_INVALID: childLimits must be an object" };
  }
  const parentRemaining = parentEnforcement ? remainingBudget(parentEnforcement.envelope, parentEnforcement.ledger) : null;
  const narrowed = {};
  for (const [d, v] of Object.entries(limits)) {
    if (!ENFORCED_DIMENSIONS.includes(d)) {
      return { ok: false, holdCode: BUDGET_HOLD_CODES.BUDGET_AUTHORITY_INVALID, reason: `BUDGET_AUTHORITY_INVALID: unknown dimension ${d} in childLimits` };
    }
    if (v === null || v === undefined) continue; // dimension not constrained
    if (!Number.isFinite(v) || v < 0) {
      return { ok: false, holdCode: BUDGET_HOLD_CODES.BUDGET_AUTHORITY_INVALID, reason: `BUDGET_AUTHORITY_INVALID: invalid child limit ${d}=${v}` };
    }
    const envLimit = envelope.dimensions[d]?.limit;
    if (envLimit !== null && envLimit !== undefined && v > envLimit) {
      return { ok: false, holdCode: BUDGET_HOLD_CODES.BUDGET_CHILD_EXCEEDS_PARENT, reason: `BUDGET_CHILD_EXCEEDS_PARENT: ${d} child limit ${v} > envelope limit ${envLimit}` };
    }
    if (parentRemaining && parentRemaining[d] !== null && parentRemaining[d] !== undefined && v > parentRemaining[d]) {
      return { ok: false, holdCode: BUDGET_HOLD_CODES.BUDGET_CHILD_EXCEEDS_PARENT, reason: `BUDGET_CHILD_EXCEEDS_PARENT: ${d} child limit ${v} > parent remaining ${parentRemaining[d]}` };
    }
    narrowed[d] = v;
  }
  const nextDimensions = Object.fromEntries(ENFORCED_DIMENSIONS.map((d) => [d, {
    limit: narrowed[d] !== undefined ? narrowed[d] : envelope.dimensions[d]?.limit,
    unit: envelope.dimensions[d]?.unit ?? null,
  }]));
  const nextEnvelope = {
    ...envelope,
    dimensions: nextDimensions,
    envelopeId: sha256Hex(canonical({
      admissionId: envelope.admissionId,
      contractSchema: envelope.contractSchema,
      dimensions: nextDimensions,
      approachingRatio: envelope.approachingRatio,
      closeoutAuthorized: envelope.closeoutAuthorized,
      parentEnvelopeId: envelope.parentEnvelopeId,
    })),
  };
  return { ok: true, envelope: deepFreeze(nextEnvelope) };
}

/**
 * Create the enforcement context for a production execution.
 *
 * @param {object} opts
 * @param {object} opts.admission — FROZEN admission（mandatory）
 * @param {object|null} [opts.checkpointState] — durable ledger state from a
 *        previous run of the SAME admission（resume — cumulative, no reset）
 * @param {object|null} [opts.parentEnforcement] — parent enforcement when
 *        this run is a child/sub-graph（monotonic restriction B2）
 * @param {object|null} [opts.childLimits] — explicit child limits（projected
 *        by the parent from its REMAINING budget）
 * @param {object|null} [opts.envelopeOverride] — a pre-derived envelope
 *        (child projection); verified untampered
 * @returns {{ ok: true, enforcement } | { ok: false, holdCode, reason }}
 */
export function createBudgetEnforcement({ admission, checkpointState = null, parentEnforcement = null, childLimits = null, envelopeOverride = null } = {}) {
  if (!admission || typeof admission !== "object") {
    return { ok: false, holdCode: BUDGET_HOLD_CODES.BUDGET_AUTHORITY_INVALID, reason: "BUDGET_AUTHORITY_INVALID: enforcement requires a frozen admission record" };
  }
  let envelopeResult;
  if (envelopeOverride) {
    const intact = assertEnvelopeUntampered(envelopeOverride);
    if (!intact.ok) return { ok: false, holdCode: intact.holdCode, reason: intact.reason };
    envelopeResult = { ok: true, envelope: envelopeOverride };
  } else {
    const parentMeta = parentEnforcement ? { parentEnvelopeId: parentEnforcement.envelope.envelopeId, parentLedgerId: parentEnforcement.ledgerId() } : {};
    envelopeResult = deriveBudgetEnvelope(admission, parentMeta);
  }
  if (!envelopeResult.ok) return envelopeResult;
  let envelope = envelopeResult.envelope;

  // CP-2R2 Finding 1: a per-task/per-child allocation（childLimits）narrows
  // the envelope MONOTONICALLY at the execution sink. This applies whether or
  // not a parent enforcement is present — a top-level Controller global
  // allocation must become the EFFECTIVE limit the ledger consumes, never the
  // original full envelope. Never widen.
  if (childLimits !== null && childLimits !== undefined) {
    const narrowed = narrowEnvelopeByLimits(envelope, childLimits, parentEnforcement);
    if (!narrowed.ok) return narrowed;
    envelope = narrowed.envelope;
  }

  // Child envelopes must NOT exceed the parent's remaining budget（B2）.
  //（When childLimits were provided this is also checked inside
  // narrowEnvelopeByLimits; this block covers a child envelope declared via
  // its own admission extensions without explicit childLimits — NEG7.）
  if (parentEnforcement) {
    const parentRemaining = remainingBudget(parentEnforcement.envelope, parentEnforcement.ledger);
    for (const d of ENFORCED_DIMENSIONS) {
      const childLimit = childLimits?.[d] ?? envelope.dimensions[d]?.limit;
      if (childLimit === null || childLimit === undefined) continue;
      const parentAvail = parentRemaining[d];
      if (parentAvail !== null && childLimit > parentAvail) {
        return {
          ok: false,
          holdCode: BUDGET_HOLD_CODES.BUDGET_CHILD_EXCEEDS_PARENT,
          reason: `BUDGET_CHILD_EXCEEDS_PARENT: ${d} child limit ${childLimit} > parent remaining ${parentAvail}`,
        };
      }
    }
  }

  let ledger;
  if (checkpointState) {
    const resumed = resumeBudgetLedger({ envelope, state: checkpointState });
    if (!resumed.ok) return resumed;
    ledger = resumed.ledger;
  } else {
    ledger = createBudgetLedger({ envelope, parentLedgerId: parentEnforcement ? parentEnforcement.ledgerId() : null });
  }

  const enforcement = {
    admission,
    envelope,
    ledger,
    _state: stateFromCounters({ envelope, counters: ledger.counters }).state,
    // resume baseline: this generation's divergence is measured against
    // consumption recorded SINCE the resume point（cumulative counters stay
    // in the ledger; the checkpoint carries the pre-crash baseline）.
    _resumeBaseline: checkpointState && checkpointState.counters ? { ...checkpointState.counters } : null,
    _reviewerSettled: new Set(),
    _reviewerReservations: new Map(),


    /** Ledger identity（child binding / evidence fingerprint）. */
    ledgerId() {
      const { events, ...rest } = this.ledger;
      return sha256Hex(canonical(rest));
    },

    /** Machine-readable enforcement state（§4）. */
    state() {
      const st = stateFromCounters({ envelope, counters: this.ledger.counters });
      this._state = st.state;
      return st.state;
    },

    /** Per-dimension consumption view（evidence / telemetry / closeout）. */
    consumption() {
      return Object.fromEntries(ENFORCED_DIMENSIONS.map((d) => [
        d,
        {
          limit: envelope.dimensions[d]?.limit ?? null,
          unit: envelope.dimensions[d]?.unit ?? null,
          consumed: this.ledger.counters[d] ?? 0,
          reserved: this.ledger.reservations[d] ?? 0,
          remaining: remainingBudget(envelope, this.ledger)[d],
          approaching: envelope.dimensions[d]?.limit != null
            && (this.ledger.counters[d] ?? 0) / envelope.dimensions[d].limit >= (envelope.approachingRatio ?? 0.8),
        },
      ]));
    },

    /**
     * Pre-dispatch gate（§4/§8 — the node is dispatched ONLY while CONTINUE）.
     * Reserves the operation's upper bounds so a crash cannot lose the
     * consumption. Exhausted / authority-invalid NEVER dispatches.
     *
     * @param {object} node — { phase_id/nodeId, executionId, attempt,
     *        runtime?: { mode, limits } }
     * @returns {{ ok: true, reservation, opKey, signal } | { ok: false,
     *          holdCode, reason }}
     */
    preDispatch(node) {
      if (this._state === "BUDGET_AUTHORITY_INVALID") {
        return { ok: false, holdCode: BUDGET_HOLD_CODES.BUDGET_AUTHORITY_INVALID, reason: "BUDGET_AUTHORITY_INVALID: enforcement is not authorized to dispatch" };
      }
      const phaseId = node?.phase_id ?? node?.nodeId ?? node?.id ?? "unknown";
      const attempt = Number(node?.attempt ?? 0);
      const opKey = `${node?.executionId ?? node?.graphExecutionId ?? "graph"}:${phaseId}:${attempt}`;
      const isSubagent = node?.runtime?.mode === "subagent" || node?.subagent === true;
      const amounts = {
        node_execution_count: 1,
        ...(isSubagent ? { sub_agent_execution_count: 1 } : {}),
        wall_clock_ms: Math.min(DEFAULT_OP_WALL_CLOCK_CAP, node?.runtime?.limits?.timeoutMs ?? DEFAULT_OP_WALL_CLOCK_CAP),
      };
      const r = ledgerReserve(this.ledger, envelope, { opKey, amounts });
      if (!r.ok) return r;
      this._state = this.state();
      const approaching = ENFORCED_DIMENSIONS
        .filter((d) => this.consumption()[d].approaching)
        .map((d) => `${d}:${this.consumption()[d].consumed}/${this.consumption()[d].limit}`);
      return { ok: true, reservation: r.reservation, opKey, signal: { state: this._state, approaching } };
    },

    /**
     * Post-operation settlement（record actual consumption; upper-bound
     * charge when the meter cannot produce an exact figure）.
     */
    recordConsumption({ opKey, actualAmounts = null, wallClockMs = null } = {}) {
      const amounts = { ...(actualAmounts ?? {}) };
      if (wallClockMs !== null && wallClockMs !== undefined) amounts.wall_clock_ms = wallClockMs;
      const s = ledgerSettle(this.ledger, envelope, { opKey, actualAmounts: amounts });
      if (!s.ok) return s;
      this._state = this.state();
      return { ok: true, actual: s.actual, state: this._state };
    },
    /**
     * STAGE-D BUDGET HANDOVER — cancellation seam for INTENTIONALLY-REFUSED
     * dispatches at ownership handover（§9a fence）: releases the op's
     * upper-bound reservation WITHOUT charging it, through THE ledger
     * authority（cancel_reservation receipt; deterministic on replay）.
     * Only a live in-flight reservation is cancellable; anything else fails
     * closed — never a silent no-op, never a fabricated release.
     */
    cancelReservation({ opKey } = {}) {
      if (!opKey || typeof opKey !== "string") {
        return { ok: false, holdCode: BUDGET_HOLD_CODES.BUDGET_AUTHORITY_INVALID, reason: "BUDGET_AUTHORITY_INVALID: cancelReservation requires the opKey" };
      }
      const c = ledgerCancelReservation(this.ledger, opKey);
      if (c.ok) this._state = this.state();
      return c;
    },

    /** Record a repair attempt（runtime meter only — B4; NOT the TA-2 repair
     *  budget authority）. */
    recordRepair({ nodeId = null } = {}) {
      const c = ledgerConfirm(this.ledger, envelope, { dimension: "repair_attempt_count", amount: 1, reason: `repair:${String(nodeId ?? "node")}` });
      this._state = this.state();
      return c;
    },

    /** Reviewer attempt identity — THE single logical slot key. */
    _reviewerKey(nodeId, attempt) {
      return `${String(nodeId ?? "node")}:${Number(attempt ?? 0)}`;
    },

    /** Record a reviewer / verifier LOGICAL_REVIEW_ATTEMPT settlement.
     *  R3: settles the ATOMIC RESERVATION taken at admitReviewer into
     *  confirmed consumption (RESERVED|INVOKED → SETTLED). Idempotent per
     *  (nodeId, attempt). Fails closed for an unknown / wrong reservation
     *  identity — consumption without a reservation is never valid. */
    recordReviewer({ nodeId = null, attempt = 0 } = {}) {
      const key = this._reviewerKey(nodeId, attempt);
      if (this._reviewerSettled.has(key)) return { ok: true, duplicate: true };
      const opKey = `reviewer:${key}`;
      const s = ledgerSettle(this.ledger, envelope, { opKey, actualAmounts: { verifier_reviewer_attempts: 1 } });
      if (!s.ok) {
        this._state = this.state();
        return s;
      }
      this._reviewerSettled.add(key);
      const res = this._reviewerReservations.get(key);
      if (res && res.state !== "CANCELLED") res.state = "SETTLED";
      this._state = this.state();
      return { ok: true, actual: s.actual };
    },

    /**
     * Pre-invocation gate for a reviewer attempt — R3 ATOMIC RESERVATION.
     * Admits ONLY when settled + active reservations < limit; the ledger
     * reservation is created SYNCHRONOUSLY inside this call（no await between
     * check and mutation）so a concurrent second caller is rejected before it
     * may invoke the reviewer. Duplicate identity（same node:attempt）can
     * never hold two reservations or replay a consumed one.
     */
    admitReviewer({ nodeId = null, attempt = 0 } = {}) {
      if (this._state === "BUDGET_AUTHORITY_INVALID") {
        return { ok: false, holdCode: BUDGET_HOLD_CODES.BUDGET_AUTHORITY_INVALID, reason: "BUDGET_AUTHORITY_INVALID: enforcement is not authorized to dispatch" };
      }
      const key = this._reviewerKey(nodeId, attempt);
      const opKey = `reviewer:${key}`;
      const existing = this._reviewerReservations.get(key);
      if (existing) {
        // CANCELLED is terminal too: a consumed/cancelled identity never
        // re-admits — replay requires a NEW attempt identity（R3 review fix）.
        return {
          ok: false,
          holdCode: "BUDGET_RESERVATION_CONFLICT",
          reason: `BUDGET_RESERVATION_CONFLICT: reviewer reservation ${opKey} already ${existing.state} — one invoke permission per logical attempt; replay requires a new attempt identity`,
        };
      }
      if (this._reviewerSettled.has(key)) {
        return {
          ok: false,
          holdCode: "BUDGET_RESERVATION_CONFLICT",
          reason: `BUDGET_RESERVATION_CONFLICT: reviewer attempt ${opKey} already settled — replay requires a new attempt identity`,
        };
      }
      if (this.ledger.inFlight[opKey]) {
        return {
          ok: false,
          holdCode: "BUDGET_RESERVATION_CONFLICT",
          reason: `BUDGET_RESERVATION_CONFLICT: ${opKey} is already reserved in the ledger`,
        };
      }
      // Atomic admission arithmetic: limit - confirmed - reserved >= 1.
      // Synchronous — no promise yield between the availability check and
      // the reservation mutation.
      const r = ledgerReserve(this.ledger, envelope, { opKey, amounts: { verifier_reviewer_attempts: 1 } });
      if (!r.ok) return r;
      this._reviewerReservations.set(key, { opKey, state: "RESERVED", reservedAt: new Date().toISOString() });
      this._state = this.state();
      return { ok: true, nodeId, attempt: Number(attempt ?? 0), reservationToken: opKey };
    },

    /**
     * Invocation confirmation seam（R3）: marks RESERVED → INVOKED. Must be
     * called by the production wiring at the moment the reviewer adapter is
     * actually handed the call. Idempotent; fails closed without a live
     * reservation.
     */
    confirmReviewerInvoked({ nodeId = null, attempt = 0 } = {}) {
      const key = this._reviewerKey(nodeId, attempt);
      const res = this._reviewerReservations.get(key);
      if (!res || res.state === "CANCELLED" || !this.ledger.inFlight[res.opKey]) {
        return { ok: false, holdCode: BUDGET_HOLD_CODES.BUDGET_AUTHORITY_INVALID, reason: `BUDGET_AUTHORITY_INVALID: no active reviewer reservation for ${key}` };
      }
      if (res.state === "INVOKED" || res.state === "SETTLED") return { ok: true, duplicate: true };
      res.state = "INVOKED";
      return { ok: true };
    },

    /**
     * Safe cancellation seam（R3 §5.3）: only a RESERVED（never invoked）
     * reservation bound to its original identity may be cancelled, once.
     * INVOKED/SETTLED slots are never released.
     */
    cancelReviewerReservation({ nodeId = null, attempt = 0 } = {}) {
      const key = this._reviewerKey(nodeId, attempt);
      const res = this._reviewerReservations.get(key);
      if (!res || !this.ledger.inFlight[res.opKey]) {
        return { ok: false, holdCode: BUDGET_HOLD_CODES.BUDGET_AUTHORITY_INVALID, reason: `BUDGET_AUTHORITY_INVALID: no cancellable reviewer reservation for ${key}` };
      }
      if (res.state !== "RESERVED") {
        return {
          ok: false,
          holdCode: "BUDGET_RESERVATION_CONFLICT",
          reason: `BUDGET_RESERVATION_CONFLICT: reviewer reservation ${res.opKey} is ${res.state} — cancellation after invocation fails closed`,
        };
      }
      const inflight = this.ledger.inFlight[res.opKey];
      for (const [d, v] of Object.entries(inflight.amounts ?? {})) {
        this.ledger.reservations[d] = (this.ledger.reservations[d] ?? 0) - v;
      }
      delete this.ledger.inFlight[res.opKey];
      this.ledger.events.push({ seq: this.ledger.events.length, kind: "cancel_reservation", opKey: res.opKey });
      res.state = "CANCELLED";
      this._state = this.state();
      return { ok: true };
    },


    /** Record a retry（attempt beyond the first — same node re-attempt）. */
    recordRetry({ nodeId = null } = {}) {
      const c = ledgerConfirm(this.ledger, envelope, { dimension: "retry_count", amount: 1, reason: `retry:${String(nodeId ?? "node")}` });
      this._state = this.state();
      return c;
    },

    /**
     * Project a CHILD envelope whose limits ≤ parent REMAINING budget（B2）.
     * An EXPLICIT childLimits request that exceeds a parent dimension's
     * remaining budget is REJECTED（BUDGET_CHILD_EXCEEDS_PARENT — NEG3）;
     * dimensions not requested cap at the parent's remaining budget（any
     * projection only narrows or equals the parent authority）.
     * The child shares the parent's admission authority binding and carries
     * the parent envelope/ledger metadata in its own envelope.
     */
    projectChild({ taskId = null, childLimits = null } = {}) {
      const remaining = remainingBudget(envelope, this.ledger);
      const explicit = childLimits && typeof childLimits === "object";
      const limits = {};
      for (const d of ENFORCED_DIMENSIONS) {
        const parentAvail = remaining[d];
        if (explicit && childLimits[d] !== undefined && childLimits[d] !== null) {
          if (parentAvail !== null && childLimits[d] > parentAvail) {
            return {
              ok: false,
              holdCode: BUDGET_HOLD_CODES.BUDGET_CHILD_EXCEEDS_PARENT,
              reason: `BUDGET_CHILD_EXCEEDS_PARENT: ${d} requested ${childLimits[d]} > parent remaining ${parentAvail}`,
            };
          }
          limits[d] = childLimits[d];
        } else {
          const own = envelope.dimensions[d]?.limit;
          limits[d] = own === null || own === undefined ? null : Math.min(own, parentAvail ?? own);
        }
      }
      const childAdmission = {
        ...admission,
        task_id: taskId ?? `${admission.task_id ?? "child"}-${String(this.ledgerId()).slice(0, 8)}`,
        extensions: {
          ...(admission.extensions ?? {}),
          budget: {
            schema: "autoloop.budget-contract/v1",
            version: 1,
            dimensions: Object.fromEntries(Object.entries(limits).map(([d, l]) => [d, { limit: l }])),
          },
        },
        admission_id: admission.admission_id, // child shares the parent's AUTHORITY binding
      };
      const childResult = createBudgetEnforcement({
        admission: childAdmission,
        parentEnforcement: this,
        childLimits: limits,
      });
      if (!childResult.ok) return childResult;
      return { ok: true, childEnforcement: childResult.enforcement, limits };
    },

    /**
     * Merge a child's confirmed consumption into this（parent）ledger.
     * Monotonic（B2）: any child consumption that would exceed the parent
     * limit fails closed（BUDGET_CHILD_EXCEEDS_PARENT）.
     */
    mergeChild(childEnforcement) {
      const m = mergeChildCounters(this.ledger, envelope, childEnforcement.ledger.counters);
      this._state = this.state();
      return m;
    },

    /** Durable snapshot for checkpoint / evidence（B3）. */
    checkpointState() {
      return checkpointBudgetLedger(this.ledger);
    },

    /**
     * FINALIZE + RECONCILE（§8/§9 — NEG13）: cross-check the runtime evidence
     *（graphResult.nodeResults / transitions）against the ledger. The runtime
     * evidence and the closeout accounting MUST agree; divergence is a HOLD
     * （BUDGET_RECONCILIATION_DIVERGED）— never a warning-only event（NEG11）.
     * Returns the graph result with the structured `budget` section attached.
     */
    finalize(graphResult) {
      const result = graphResult ?? {};
      const nodes = Array.isArray(result.nodeResults) ? result.nodeResults : [];
      const transitions = Array.isArray(result.transitions) ? result.transitions : [];
      const observed = observeFromResult(result);
      const ledgerCounts = this.ledger.counters;
      const diverged = [];
      // R3 §5.4: a lifecycle that ends with an active reviewer reservation
      // fails closed — never silently discarded or counted as consumption.
      const activeReservations =
        [...this._reviewerReservations.values()].filter((r) => r.state === "RESERVED" || r.state === "INVOKED").length;
      const inflightReviewerKeys = Object.keys(this.ledger.inFlight ?? {}).filter((k) => k.startsWith("reviewer:")).length;
      if (activeReservations > 0 || inflightReviewerKeys > 0) {
        diverged.push(`verifier_reviewer_attempts:unresolved_reservations=${Math.max(activeReservations, inflightReviewerKeys)}`);
      }
      for (const d of ENFORCED_DIMENSIONS) {
        if (envelope.dimensions[d]?.limit === null || envelope.dimensions[d]?.limit === undefined) continue;
        const expected = (ledgerCounts[d] ?? 0) - (this._resumeBaseline?.[d] ?? 0);
        const actual = observed[d] ?? 0;
        if (expected !== actual) diverged.push(`${d}:ledger=${expected} evidence=${actual}`);
      }
      const budgetSection = {
        schema: "autoloop.budget-enforcement-result/v1",
        authorized: true,
        surface: "production",
        admissionId: admission.admission_id,
        envelopeId: envelope.envelopeId,
        envelopeSource: envelope.contractSource,
        admissionProfile: envelope.admissionProfile,
        state: this.state(),
        approachingRatio: envelope.approachingRatio,
        closeoutAuthorized: envelope.closeoutAuthorized,
        dimensions: this.consumption(),
        reconciliation: {
          diverged,
          observed,
          ledger: ledgerCounts,
        },
        checkpoint: this.checkpointState(),
        enforcementSections: ["assert-admission", "derive-envelope", "init-resume-ledger", "pre-dispatch", "execute-bounded", "record-consumption", "post-op-invariant", "durable-checkpoint-evidence"],
      };
      if (diverged.length > 0) {
        const reason = `BUDGET_RECONCILIATION_DIVERGED: ${diverged.join("; ")}`;
        return {
          ...result,
          final: "HOLD",
          holdCode: BUDGET_HOLD_CODES.BUDGET_RECONCILIATION_DIVERGED,
          reason,
          budget: budgetSection,
        };
      }
      return { ...result, budget: budgetSection };
    },
  };

  return { ok: true, enforcement };
}

// ── runtime-evidence observation（NEG13 baseline）────────────────────────
function observeFromResult(result) {
  const nodes = Array.isArray(result.nodeResults) ? result.nodeResults : [];
  const transitions = Array.isArray(result.transitions) ? result.transitions : [];
  let nodeCount = 0;
  let subagentCount = 0;
  let retryCount = 0;
  let wallClockMs = 0;
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const final = n.final ?? "NOT_RECORDED";
    // STAGE-D BUDGET HANDOVER: scheduler-synthesized placeholder results
    //（colima join completion for never-executed / folded phases）carry
    // skipped:true — they are NOT runtime evidence of consumption. Counting
    // them would double-charge a resumed era for work already settled in the
    // baseline era（or never performed at all）.
    if (n.skipped === true || final === "SKIPPED_DUE_TO_DEPENDENCY" || final === "NOT_RECORDED") continue;
    nodeCount++;
    if (n.subagentEnvelope || n.subagentResult || n.taskType === "subagent") subagentCount++;
    const attempt = Number(n.attempt ?? 0);
    if (attempt > 0) retryCount += attempt;
    // STAGE-D BUDGET HANDOVER: the SAME runner-timing meter the terminal
    // settlement uses — executor latencyMs, else the node's measured
    // startedAt→completedAt window. One meter, one unit: settle and
    // reconcile can only agree when both read the identical figure.
    const lat = Number(n?.resultIdentity?.latencyMs);
    if (Number.isFinite(lat) && lat >= 0) {
      wallClockMs += lat;
    } else if (Number.isFinite(n?.startedAt) && Number.isFinite(n?.completedAt)) {
      wallClockMs += Math.max(0, n.completedAt - n.startedAt);
    }
  }
  // Wall-clock meter: the SUM of measured node latencies is the consistent
  // figure（the ledger settles per-node latencies）. Falls back to the graph
  // envelope start→completed window ONLY when at least one real node ran —
  // a resumed era with zero executed nodes must observe zero, never the
  // whole-process window（STAGE-D BUDGET HANDOVER reconciliation fix）.
  if (wallClockMs === 0 && nodeCount > 0) {
    const started = result.startedAt ? Date.parse(result.startedAt) : null;
    const completed = result.completedAt ? Date.parse(result.completedAt) : null;
    if (Number.isFinite(started) && Number.isFinite(completed)) {
      wallClockMs = Math.max(0, completed - started);
    }
  }
  let repairCount = 0;
  for (const tx of transitions ?? []) {
    for (const lt of tx?.lifecycleTransitions ?? []) {
      const phase = String(lt?.phase ?? "");
      const status = String(lt?.status ?? "");
      if (status.toUpperCase() === "REPAIR" || phase.toUpperCase() === "REPAIR") repairCount++;
    }
  }
  return {
    wall_clock_ms: wallClockMs,
    node_execution_count: nodeCount,
    sub_agent_execution_count: subagentCount,
    repair_attempt_count: repairCount,
    verifier_reviewer_attempts: countLogicalReviewerAttempts(transitions),
    retry_count: retryCount,
  };
}
