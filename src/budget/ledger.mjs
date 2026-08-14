// src/budget/ledger.mjs
//
// AUTOLOOP-TA3 — budget LEDGER（cumulative consumption accounting）.
//
// The ledger is the durable accounting authority for runtime consumption:
//
//   - CUMULATIVE counters（B3）: consumption NEVER resets across process
//     restart / graph rebuild / checkpoint restore — resume starts from the
//     persisted counters, and a fresh ledger is never allowed to silently
//     restart a resumed run;
//   - CONSERVATIVE RESERVATION（§6 atomicity）: every dispatch first
//     RESERVES an upper bound（count dims reserve 1; wall-clock reserves
//     min(opCap, remaining)）. A crash between reservation and settlement
//     leaves the reservation in-flight; on resume, in-flight reservations
//     SETTLE AT THEIR UPPER BOUND（upper-bound charging — never "pretend
//     exact", never a missing receipt, never double-spend）;
//   - opKey uniqueness（executionId:phaseId:attempt）prevents duplicate
//     external work: re-dispatching an already-reserved opKey fails closed
//     （BUDGET_RESERVATION_CONFLICT）unless the recovery layer authorizes a
//     replay as a NEW attempt（which consumes retry_count）;
//   - DETERMINISTIC RECONSTRUCTION: the receipt log（events）replays to the
//     same counters（reconstructBudgetLedger）— the crash/resume proof and
//     the NEG13 divergence check both run against it;
//   - MONOTONIC CHILD MERGE（B2）: mergeChild refuses any child consumption
//     that would push a parent dimension over its limit
//     （BUDGET_CHILD_EXCEEDS_PARENT — fail closed）.

import { BUDGET_LEDGER_SCHEMA, BUDGET_LEDGER_VERSION, ENFORCED_DIMENSIONS } from "./contract.mjs";
import { assertEnvelopeUntampered } from "./envelope.mjs";

export class BudgetHoldError extends Error {
  constructor(code, reason) {
    super(reason || code);
    this.name = "BudgetHoldError";
    this.code = code;
  }
}

function zeroCounters() {
  return Object.fromEntries(ENFORCED_DIMENSIONS.map((d) => [d, 0]));
}

function dimsWithLimits(envelope) {
  return ENFORCED_DIMENSIONS.filter((d) => envelope?.dimensions?.[d]?.limit !== null && envelope?.dimensions?.[d]?.limit !== undefined);
}

/** Cumulative enforcement state from confirmed counters（envelope-level
 *  authority violations are handled by the enforcement layer）. */
export function stateFromCounters({ envelope, counters }) {
  const ratio = envelope.approachingRatio ?? 0.8;
  let approaching = false;
  for (const d of dimsWithLimits(envelope)) {
    const limit = envelope.dimensions[d].limit;
    const used = counters[d] ?? 0;
    // used >= limit => nothing left to consume => exhausted（dispatch is
    // impossible; never "approaching" at a fully consumed dimension）.
    if (used >= limit) return { state: "BUDGET_EXHAUSTED", dimension: d, used, limit };
    if (limit > 0 && used / limit >= ratio) approaching = true;
  }
  return approaching ? { state: "APPROACHING_LIMIT", dimension: null, used: null, limit: null } : { state: "CONTINUE", dimension: null, used: null, limit: null };
}

/**
 * Create a fresh ledger for an envelope（zero counters）.
 * @param {object} opts — { envelope, parentLedgerId? }
 */
export function createBudgetLedger({ envelope, parentLedgerId = null } = {}) {
  const intact = assertEnvelopeUntampered(envelope);
  if (!intact.ok) throw new BudgetHoldError(intact.holdCode, intact.reason);
  return {
    schema: BUDGET_LEDGER_SCHEMA,
    version: BUDGET_LEDGER_VERSION,
    admissionId: envelope.admissionId,
    envelopeId: envelope.envelopeId,
    parentLedgerId,
    generation: 0,
    counters: zeroCounters(),
    reservations: zeroCounters(),
    inFlight: {},
    events: [],
    state: "CONTINUE",
    lastCheckpointAt: null,
    checkpointCount: 0,
  };
}

function validateStateShape(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return "state_missing_or_not_object";
  if (state.schema !== BUDGET_LEDGER_SCHEMA) return `schema_mismatch:${String(state.schema)}`;
  if (state.version !== BUDGET_LEDGER_VERSION) return `version_mismatch:${String(state.version)}`;
  if (typeof state.admissionId !== "string") return "admissionId_missing";
  if (typeof state.envelopeId !== "string") return "envelopeId_missing";
  if (!state.counters || typeof state.counters !== "object") return "counters_missing";
  for (const d of ENFORCED_DIMENSIONS) {
    if (!Number.isFinite(state.counters[d] ?? 0)) return `counter_invalid:${d}`;
    if (!Number.isFinite(state.reservations?.[d] ?? 0)) return `reservation_invalid:${d}`;
  }
  return null;
}

/**
 * Resume a ledger from durable state（B3 — cumulative, never reset）.
 * Fail-closed on malformed / tampered state（NEG12）: the state's
 * admissionId + envelopeId MUST match the envelope, and the counters must
 * re-derive from the receipt log when one is present.
 *
 * @param {object} opts — { envelope, state }
 * @returns {{ ok: true, ledger } | { ok: false, holdCode, reason }}
 */
export function resumeBudgetLedger({ envelope, state } = {}) {
  const intact = assertEnvelopeUntampered(envelope);
  if (!intact.ok) return { ok: false, holdCode: intact.holdCode, reason: intact.reason };
  const shapeErr = validateStateShape(state);
  if (shapeErr) return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: `BUDGET_AUTHORITY_INVALID: malformed budget state — ${shapeErr}` };
  if (state.envelopeId !== envelope.envelopeId) {
    return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: "BUDGET_AUTHORITY_INVALID: budget state envelopeId does not match the frozen admission envelope (tampered/mismatched state)" };
  }
  if (state.admissionId !== envelope.admissionId) {
    return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: "BUDGET_AUTHORITY_INVALID: budget state admissionId does not match the frozen admission" };
  }
  // Deterministic reconstruction proof: when the receipt log is present, the
  // counters must re-derive from it — a hand-edited counter set fails closed.
  if (Array.isArray(state.events) && state.events.length > 0) {
    const rebuilt = reconstructBudgetLedger({ envelope, events: state.events });
    if (!rebuilt.ok) return rebuilt;
    for (const d of ENFORCED_DIMENSIONS) {
      if ((rebuilt.ledger.counters[d] ?? 0) !== (state.counters[d] ?? 0)) {
        return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: `BUDGET_AUTHORITY_INVALID: counters diverge from receipt log (${d} ${state.counters[d]} != ${rebuilt.ledger.counters[d]})` };
      }
    }
  }
  // In-flight reservations（crash between reserve and settle）settle at their
  // reserved UPPER BOUND（§6 conservative upper-bound charging — never a
  // missing receipt, never a reset）.
  const ledger = {
    ...state,
    envelopeId: envelope.envelopeId,
    admissionId: envelope.admissionId,
    generation: (state.generation ?? 0) + 1,
    reservations: zeroCounters(),
    inFlight: {},
    events: [...(state.events ?? [])],
    checkpointCount: (state.checkpointCount ?? 0),
    resumed: true,
  };
  for (const [opKey, res] of Object.entries(state.inFlight ?? {})) {
    for (const [d, amount] of Object.entries(res?.amounts ?? {})) {
      ledger.counters[d] = (ledger.counters[d] ?? 0) + Number(amount ?? 0);
    }
    ledger.events.push({ seq: ledger.events.length, kind: "resume_settle_upper_bound", opKey, at: new Date().toISOString() });
  }
  const st = stateFromCounters({ envelope, counters: ledger.counters });
  ledger.state = st.state;
  return { ok: true, ledger };
}

/**
 * Deterministic reconstruction from a receipt log（events replay in order）.
 * This is the crash/resume accounting proof（§9）and the divergence baseline
 * （NEG13）.
 *
 * @param {object} opts — { envelope, events }
 * @returns {{ ok: true, ledger } | { ok: false, holdCode, reason }}
 */
export function reconstructBudgetLedger({ envelope, events = [] } = {}) {
  const intact = assertEnvelopeUntampered(envelope);
  if (!intact.ok) return { ok: false, holdCode: intact.holdCode, reason: intact.reason };
  if (!Array.isArray(events)) return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: "BUDGET_AUTHORITY_INVALID: events must be an array" };
  const ledger = createBudgetLedger({ envelope });
  for (const ev of events) {
    if (!ev || typeof ev !== "object") return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: "BUDGET_AUTHORITY_INVALID: malformed receipt event" };
    if (ev.kind === "reserve") {
      const r = ledgerReserve(ledger, envelope, { opKey: ev.opKey, amounts: ev.amounts });
      if (!r.ok) return { ok: false, holdCode: r.holdCode, reason: `reconstruct: ${r.reason}` };
    } else if (ev.kind === "settle") {
      const s = ledgerSettle(ledger, envelope, { opKey: ev.opKey, actualAmounts: ev.actualAmounts });
      if (!s.ok) return { ok: false, holdCode: s.holdCode, reason: `reconstruct: ${s.reason}` };
    } else if (ev.kind === "confirm") {
      const c = ledgerConfirm(ledger, envelope, { dimension: ev.dimension, amount: ev.amount, reason: ev.reason });
      if (!c.ok) return { ok: false, holdCode: c.holdCode, reason: `reconstruct: ${c.reason}` };
    } else if (ev.kind === "merge_child") {
      if (!ev.childCounters || typeof ev.childCounters !== "object") return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: "reconstruct: merge_child without childCounters" };
      const m = mergeChildCounters(ledger, envelope, ev.childCounters);
      if (!m.ok) return { ok: false, holdCode: m.holdCode, reason: `reconstruct: ${m.reason}` };
    } else if (ev.kind === "resume_settle_upper_bound") {
      // already folded into counters by the persisted state; no-op for replay
    } else {
      return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: `reconstruct: unknown event kind ${String(ev.kind)}` };
    }
  }
  return { ok: true, ledger };
}

/** Check an opKey against in-flight reservations（duplicate work guard）. */
function assertOpKeyAvailable(ledger, opKey) {
  if (!opKey || typeof opKey !== "string") return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: "BUDGET_AUTHORITY_INVALID: opKey required for reservation" };
  if (ledger.inFlight[opKey]) {
    return { ok: false, holdCode: "BUDGET_RESERVATION_CONFLICT", reason: `BUDGET_RESERVATION_CONFLICT: ${opKey} is already reserved (duplicate dispatch; replay must be a new attempt)` };
  }
  return { ok: true };
}

function ledgerReserve(ledger, envelope, { opKey, amounts }) {
  const avail = assertOpKeyAvailable(ledger, opKey);
  if (!avail.ok) return avail;
  const clean = {};
  for (const [d, amount] of Object.entries(amounts ?? {})) {
    if (!ENFORCED_DIMENSIONS.includes(d)) return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: `unknown dimension ${d}` };
    const v = Number(amount ?? 0);
    if (!Number.isFinite(v) || v < 0) return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: `invalid reservation amount ${d}=${amount}` };
    const limit = envelope.dimensions[d]?.limit;
    if (limit === null || limit === undefined) continue; // unlimited dimension
    const available = limit - (ledger.counters[d] ?? 0) - (ledger.reservations[d] ?? 0);
    if (v > available) {
      return { ok: false, holdCode: "BUDGET_EXHAUSTED", reason: `BUDGET_EXHAUSTED: ${d} reserve ${v} > available ${available} (limit ${limit}, confirmed ${ledger.counters[d] ?? 0}, reserved ${ledger.reservations[d] ?? 0})` };
    }
    clean[d] = v;
  }
  for (const [d, v] of Object.entries(clean)) ledger.reservations[d] = (ledger.reservations[d] ?? 0) + v;
  ledger.inFlight[opKey] = { amounts: clean, reservedAt: new Date().toISOString() };
  ledger.events.push({ seq: ledger.events.length, kind: "reserve", opKey, amounts: clean });
  return { ok: true, reservation: clean };
}

function ledgerSettle(ledger, envelope, { opKey, actualAmounts }) {
  const res = ledger.inFlight[opKey];
  if (!res) {
    return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: `BUDGET_AUTHORITY_INVALID: settle for unreserved opKey ${opKey} (consumption without reservation)` };
  }
  const actual = {};
  for (const [d, reserved] of Object.entries(res.amounts)) {
    const provided = actualAmounts?.[d];
    // Explicit null/0（meter measured no activity）settles at 0; a missing
    // figure（undefined）settles at the reserved UPPER BOUND — conservative
    // charging, never a fabricated 0 for an operation that may have run.
    const v = provided === undefined ? reserved : Number(provided);
    if (!Number.isFinite(v) || v < 0) return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: `invalid actual ${d}=${provided}` };
    actual[d] = v;
  }
  for (const [d, v] of Object.entries(actual)) {
    ledger.reservations[d] = (ledger.reservations[d] ?? 0) - (res.amounts[d] ?? 0);
    ledger.counters[d] = (ledger.counters[d] ?? 0) + v;
  }
  delete ledger.inFlight[opKey];
  ledger.events.push({ seq: ledger.events.length, kind: "settle", opKey, actualAmounts: actual });
  const st = stateFromCounters({ envelope, counters: ledger.counters });
  ledger.state = st.state;
  return { ok: true, actual };
}

function ledgerConfirm(ledger, envelope, { dimension, amount, reason = null }) {
  if (!ENFORCED_DIMENSIONS.includes(dimension)) return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: `unknown dimension ${dimension}` };
  const v = Number(amount ?? 0);
  if (!Number.isFinite(v) || v < 0) return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: `invalid confirm amount ${dimension}=${amount}` };
  ledger.counters[dimension] = (ledger.counters[dimension] ?? 0) + v;
  ledger.events.push({ seq: ledger.events.length, kind: "confirm", dimension, amount: v, reason });
  const st = stateFromCounters({ envelope, counters: ledger.counters });
  ledger.state = st.state;
  return { ok: true };
}

/**
 * Monotonic child merge（B2）: a child ledger's confirmed consumption is
 * folded into the parent ONLY when no parent dimension would exceed its
 * limit（child ≤ remaining parent）. Fail-closed otherwise.
 */
export function mergeChildCounters(ledger, envelope, childCounters) {
  for (const d of ENFORCED_DIMENSIONS) {
    const limit = envelope.dimensions[d]?.limit;
    if (limit === null || limit === undefined) continue;
    const parentUsed = (ledger.counters[d] ?? 0) + (ledger.reservations[d] ?? 0);
    const childUsed = Number(childCounters?.[d] ?? 0);
    if (!Number.isFinite(childUsed) || childUsed < 0) {
      return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: `invalid child counter ${d}=${childCounters?.[d]}` };
    }
    if (parentUsed + childUsed > limit) {
      return { ok: false, holdCode: "BUDGET_CHILD_EXCEEDS_PARENT", reason: `BUDGET_CHILD_EXCEEDS_PARENT: ${d} parent ${parentUsed} + child ${childUsed} > limit ${limit}` };
    }
  }
  for (const d of ENFORCED_DIMENSIONS) {
    ledger.counters[d] = (ledger.counters[d] ?? 0) + Number(childCounters?.[d] ?? 0);
  }
  ledger.events.push({ seq: ledger.events.length, kind: "merge_child", childCounters: { ...(childCounters ?? {}) } });
  const st = stateFromCounters({ envelope, counters: ledger.counters });
  ledger.state = st.state;
  return { ok: true };
}

/**
 * Durable snapshot（B3）— persisted by the durable layer / closeout evidence.
 */
export function checkpointBudgetLedger(ledger) {
  return {
    schema: BUDGET_LEDGER_SCHEMA,
    version: BUDGET_LEDGER_VERSION,
    admissionId: ledger.admissionId,
    envelopeId: ledger.envelopeId,
    parentLedgerId: ledger.parentLedgerId ?? null,
    generation: ledger.generation ?? 0,
    counters: { ...(ledger.counters ?? {}) },
    reservations: { ...(ledger.reservations ?? {}) },
    inFlight: Object.fromEntries(Object.entries(ledger.inFlight ?? {}).map(([k, v]) => [k, { amounts: { ...(v.amounts ?? {}) }, reservedAt: v.reservedAt ?? null }])),
    events: (ledger.events ?? []).map((e) => ({ ...e, amounts: e.amounts ? { ...e.amounts } : undefined, actualAmounts: e.actualAmounts ? { ...e.actualAmounts } : undefined, childCounters: e.childCounters ? { ...e.childCounters } : undefined })),
    state: ledger.state ?? "CONTINUE",
    lastCheckpointAt: new Date().toISOString(),
    checkpointCount: (ledger.checkpointCount ?? 0) + 1,
  };
}

/** Remaining（unconsumed, unreserved）budget per dimension — child authority. */
export function remainingBudget(envelope, ledger) {
  const remaining = {};
  for (const d of ENFORCED_DIMENSIONS) {
    const limit = envelope.dimensions[d]?.limit;
    if (limit === null || limit === undefined) { remaining[d] = null; continue; }
    remaining[d] = Math.max(0, limit - (ledger.counters[d] ?? 0) - (ledger.reservations[d] ?? 0));
  }
  return remaining;
}

export { ledgerReserve, ledgerSettle, ledgerConfirm };
