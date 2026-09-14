// src/learning/lifecycle/event-journal.mjs
//
// STAGE-F LIFECYCLE — N2 EVENT WRITE SEAM.
//
// Authority chain:
//   SPEC-1 DURABLE-RECORD.md      (17-field canonical record; journal event
//                                  shape = live autoloop.memory-journal-event/v1)
//   SPEC-1 JOURNAL-SEMANTICS.md   (ONE write path = appendJournalEvent →
//                                  appendLineFsync; NO_NEW_DURABLE_ENGINE; no
//                                  rename machinery; no advisory lock; digest
//                                  chain IS the concurrency fence)
//   SPEC-1 EXACTLY-ONCE.md        (per-effect keys; duplicate = idempotent NO-OP)
//   SPEC-1 GENERATION.md          (every event binds generation before→after)
//   SPEC-1 R20-HUMAN-AUTHORITY.md (pre-removal snapshot digest INSIDE payload)
//   PLAN-1 MODULE-RESPONSIBILITY-MAP.md (N2 row: WRITES THROUGH, NEVER AROUND;
//                                  refuses events lacking an N1 ok-verdict)
//   RUNG-5 MUTATION-SURFACE-FREEZE §2 N2 (allowed/forbidden rows)
//
// N2 CONSTRUCTS EVENTS ONLY FOR N1-AUTHORIZED INTENTS. There is no raw-append
// entry for callers (anti-escape-hatch law): every write enters with the
// intent + the N1 verdict, and N2 independently re-checks the verdict's
// binding (event kind, recordId, generation) before constructing anything.
// Payload fields outside DURABLE-RECORD are rejected (fail closed).

import { appendJournalEvent, readJournal, assertChainIntegrity, JournalError } from "../../memory/jsonl-journal.mjs";
import { recursiveCanonicalJson, canonicalSha256 } from "../../memory/canonical.mjs";
import { MEMORY_ERRORS } from "../../memory/validation.mjs";
import { LIFECYCLE_EVENT_KINDS, LIFECYCLE_TRANSITION_ILLEGAL, LIFECYCLE_TERMINAL_IMMUTABLE } from "../../memory/contract.mjs";
import { okVerdict, TERMINAL_STATES, LEGAL_TRANSITIONS } from "./state-machine.mjs";

export const LIFECYCLE_WRITE_STATUSES = Object.freeze([
  "APPLIED",          // journaled + fsynced (durability ack returned)
  "NO-OP",            // exactly-once duplicate/conflict — journal gains nothing
  "REJECT",           // refusal-to-construct (authorization missing/invalid)
  "HOLD",             // journal torn/ambiguous — nothing written, reconcile-first
]);

export class LifecycleWriteError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "LifecycleWriteError";
    this.code = code;
  }
}

function fail(status, code, reason, extra = {}) {
  return { ok: false, status, code, reason, layer2: status, ...extra };
}

// ---------------------------------------------------------------------------
// F8 (RUNG-8 RRC-F8 hardening; PROCESS_MEMORY_AUTHORITY=NO / JOURNAL_WINS=YES):
// the record's lifecycle truth is RE-DERIVED here from the authoritative
// journal bytes (the same replay law N3 uses — applyLifecycleEventToProjection
// over LIFECYCLE_EVENT events of the subject record; no lifecycle event ⇒
// CANDIDATE, no durable generation ⇒ generation null).
//   journalState  — the replayed record state (transition binding below)
//   journalGen    — the durable generation (null when no lifecycle event has
//                   landed for the record — N1's generation fence may only
//                   bind against a generation the journal can resolve)
// A caller projection.state may never independently establish a fact the
// journal refutes (frozen N2-4 CHECK_WRITE_DRIFT / N2-9 terminal NO-OP
// forms); absence of durable truth is N1-fenced, not caller-forged.
// ---------------------------------------------------------------------------
function deriveJournalTruth(journalPath, recordId) {
  const events = readJournal(journalPath).events;
  let projection = { claimSource: "JOURNAL_PROJECTION", chainVerified: true, recordExists: false, state: "CANDIDATE", generation: null };
  for (const ev of events) {
    if (ev.operation !== "LIFECYCLE_EVENT") continue;
    const p = ev.payload ?? {};
    if (p.recordId !== recordId) continue;
    projection = applyLifecycleEventToProjection(projection, ev);
    projection.recordExists = true;
  }
  return { journalState: projection.state, journalGen: projection.generation };
}

// ---------------------------------------------------------------------------
// Exactly-once key (LEGAL-TRANSITIONS header; EXACTLY-ONCE §1 row 1):
// recordId + logicalKey/contentHash + target event identity.
// ---------------------------------------------------------------------------
export function lifecycleExactlyOnceKey({ recordId, logicalKey, eventId }) {
  return canonicalSha256({ recordId, logicalKey, eventId });
}

// DURABLE-RECORD §1 field set — the canonical lifecycle event payload fields
// (payload-level; the journal envelope adds schema/seq/digests/timestamp).
const PAYLOAD_FIELDS = Object.freeze([
  "eventId",              // lifecycle identity (derived; exactly-once key component)
  "recordId",             // subject/candidate identity
  "logicalKey",           // R2-owned logical key (consumed verbatim)
  "contentHash",          // subject content hash (consumed verbatim)
  "event",                // transition kind (PROMOTE/DEMOTE/ARCHIVE/REMOVE/OP_CANCEL)
  "transition",           // { id, from, event, to, authority }
  "generationBefore",
  "generationAfter",
  "authoritySource",      // R14…R20
  "humanAdmissionRecord", // reference only — required for T3/T12, else null
  "causeEvidence",        // demote cause (R18) — payload per edge type
  "supersessionEvidence", // archive evidence (R19)
  "elements",             // E1–E9 evidence payloads (per edge type)
  "preRemovalSnapshotDigest", // T12 only — sha256 of pre-removal record bytes
  "executedBy",           // journaled attribution: writer_id / writer_generation
]);

function validatePayloadShape(payload) {
  const keys = Object.keys(payload);
  const illegal = keys.filter((k) => !PAYLOAD_FIELDS.includes(k));
  if (illegal.length > 0) {
    throw new LifecycleWriteError(MEMORY_ERRORS.SCHEMA_INVALID, `payload fields outside DURABLE-RECORD: ${illegal.join(",")}`);
  }
  for (const req of ["eventId", "recordId", "event", "generationBefore", "generationAfter", "executedBy"]) {
    if (payload[req] === undefined || payload[req] === null) {
      throw new LifecycleWriteError(MEMORY_ERRORS.SCHEMA_INVALID, `DURABLE-RECORD missing required field: ${req}`);
    }
  }
  if (payload.generationBefore !== payload.generationAfter && !["PROMOTE", "DEMOTE", "ARCHIVE", "REMOVE"].includes(payload.event)) {
    throw new LifecycleWriteError(MEMORY_ERRORS.SCHEMA_INVALID, "generation drift on a non-semantic event");
  }
}

// ---------------------------------------------------------------------------
// The ONE journal-derived state read for lifecycle writes (F4 input rule:
// the state claim is the JOURNAL projection, chain-verified FIRST).
// ---------------------------------------------------------------------------
export function readLifecycleJournalState(journalPath) {
  const r = assertChainIntegrity(journalPath); // F0 — throws JOURNAL_CHAIN_INVALID on corruption/gap
  return {
    claimSource: "JOURNAL_PROJECTION",
    chainVerified: true,
    events: r.events,
    partialTrailingLine: r.partialTrailingLine,
    lastSequence: r.state.lastSequence,
    previousDigest: r.state.previousDigest,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle event kinds journaled as LIFECYCLE_EVENT operations (the journal's
// own operation enum is untouched; lifecycle semantics live in the payload).
// ---------------------------------------------------------------------------

/**
 * THE lifecycle write seam. Requires:
 *   - intent: the journal-derived intent (claimSource: JOURNAL_PROJECTION)
 *   - verdict: the N1 verdict from authorizeLifecycleEvent(intent, projection)
 *     — must be an ok-verdict ({ ok: true }) whose binding matches the intent
 *   - journalPath, projection (journal-derived), attribution fields
 * Returns { ok, status, code?, event?, journalSequence? } — caller-visible
 * success ONLY after appendJournalEvent returns (fsync durability boundary).
 * Refuses to construct events for failed/absent authorization (REJECT — the
 * write seam is unreachable for a rejected intent).
 */
export function writeLifecycleEvent({ intent, verdict, projection, journalPath, writerId, writerGeneration, now }) {
  if (!intent || !verdict || !projection || !journalPath) {
    return fail("REJECT", LIFECYCLE_TRANSITION_ILLEGAL, "WRITE_SEAM_INPUT_MISSING");
  }
  if (intent.claimSource !== "JOURNAL_PROJECTION" || projection.claimSource !== "JOURNAL_PROJECTION" || projection.chainVerified !== true) {
    return fail("HOLD", MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "RECOVERY_REQUIRED", { detail: "write seam refuses non-journal-derived facts" });
  }
  // Refusal-to-construct: only N1 ok-verdicts may become events.
  if (!verdict.ok || !verdict.transition) {
    return fail("REJECT", verdict.code ?? LIFECYCLE_TRANSITION_ILLEGAL, verdict.reason ?? "NOT_AUTHORIZED", { iRow: verdict.iRow ?? null });
  }
  // Verdict/intent binding check (check/write drift cannot pass silently):
  if (verdict.transition.event !== intent.event || verdict.transition.from !== projection.state) {
    return fail("REJECT", LIFECYCLE_TERMINAL_IMMUTABLE, "CHECK_WRITE_DRIFT", { detail: "F8 write-seam guard: verdict no longer matches journal reality" });
  }
  if (!LIFECYCLE_EVENT_KINDS.includes(intent.event)) {
    return fail("REJECT", LIFECYCLE_TRANSITION_ILLEGAL, "UNREGISTERED_EVENT_KIND");
  }

  // T12 snapshot-digest law (R20 §1: "sha256 of the pre-removal record bytes
  // — INSIDE the event payload"; DURABLE-RECORD §1: snapshot digest
  // content-addressed). The digest is DERIVED here from the pre-removal
  // record bytes the caller must supply — never trusted. A REMOVE intent
  // without record bytes, or whose caller-supplied digest disagrees with the
  // derived one, is refused (the audit field cannot be forged past the seam).
  let snapshotDigest = null;
  if (intent.event === "REMOVE") {
    if (intent.preRemovalRecordBytes == null) {
      return fail("REJECT", LIFECYCLE_TRANSITION_ILLEGAL, "PRE_REMOVAL_RECORD_BYTES_REQUIRED", { detail: "T12 requires the pre-removal record bytes — the digest is derived, never trusted" });
    }
    snapshotDigest = computePreRemovalSnapshotDigest(intent.preRemovalRecordBytes);
    if (intent.preRemovalSnapshotDigest != null && intent.preRemovalSnapshotDigest !== snapshotDigest) {
      return fail("REJECT", LIFECYCLE_TRANSITION_ILLEGAL, "SNAPSHOT_DIGEST_MISMATCH", { detail: "caller-supplied preRemovalSnapshotDigest does not match the derived digest of the pre-removal record bytes" });
    }
  }

  const eventId = deriveLifecycleEventId({ recordId: intent.recordId, event: intent.event, seq: projection.lastSequence ?? 0, key: intent.logicalKey ?? null });
  const exactlyOnceKey = lifecycleExactlyOnceKey({ recordId: intent.recordId, logicalKey: intent.logicalKey ?? null, eventId });

  // Exactly-once duplicate check against journal reality (per-effect key).
  // STAGE-2 ≡ STAGE-1 from every consumer's view (TORN-WRITE-SEMANTICS): the
  // duplicate answer comes from the readable prefix — BEFORE the torn-tail
  // barrier and any state fencing (frozen N2-10 same-identity retry oracle).
  const dup = findDuplicateDelivery(journalPath, { recordId: intent.recordId, event: intent.event, exactlyOnceKey });
  if (dup) return dup; // NO-OP (DUPLICATE_EVENT_ID / conflict class)

  // F8 (RRC-F8 RUNG-8 hardening — JOURNAL-WINS TRUTH FENCE, after the
  // exactly-once answer per STAGE-2 ≡ STAGE-1). The caller projection's
  // state cannot establish a lifecycle fact the journal REFUTES:
  //   · durable lifecycle events exist for this record AND their replayed
  //     state disagrees with projection.state ⇒ CHECK_WRITE_DRIFT (frozen
  //     N2-4 form — durable truth cannot be claimed away by the caller);
  //   · journal-derived state is TERMINAL ⇒ the frozen F6 terminal law is
  //     bound to that reality: REMOVED constructs nothing (I7/V15 class);
  //     DEMOTED/ARCHIVED only their single frozen continuation edge (T10 /
  //     T12) — any other kind is refused.
  // Non-refuted non-terminal claims and head staleness stay N1-bound (frozen
  // N2-19: the journal, not the caller, decides where the chain head is).
  {
    const { journalState, journalGen } = deriveJournalTruth(journalPath, intent.recordId);
    if (journalState !== "CANDIDATE" && journalState !== projection.state) {
      return fail("REJECT", LIFECYCLE_TERMINAL_IMMUTABLE, "CHECK_WRITE_DRIFT", { detail: `F8 journal-wins: durable events derive state ${journalState}, caller claims ${String(projection.state)}` });
    }
    const legalContinuation = LEGAL_TRANSITIONS.find((t) => t.from === journalState);
    if (TERMINAL_STATES.has(journalState) && (legalContinuation == null || legalContinuation.event !== intent.event)) {
      return fail("REJECT", LIFECYCLE_TERMINAL_IMMUTABLE, "CHECK_WRITE_DRIFT", { detail: `F8 terminal reality: journal-derived state ${journalState} — no ${String(intent.event)} event is constructible (I7/V15 class)` });
    }
  }

  const payload = {
    eventId,
    recordId: intent.recordId,
    logicalKey: intent.logicalKey ?? null,
    contentHash: intent.contentHash ?? null,
    event: intent.event,
    transition: { ...verdict.transition },
    generationBefore: projection.generation,
    generationAfter: verdict.generationAfter ?? projection.generation,
    // AMENDMENT-1 (R-RES-5): the reading layer's journal-derived resolution
    // fact RIDES the payload as provenance — N2 consumes it, never MINTS it.
    authoritySource: verdict.transition.authority ?? null,
    humanAdmissionRecord: intent.elements?.E9 ?? intent.elements?.HUMAN_ADMISSION ?? null,
    causeEvidence: intent.elements?.CAUSE ?? null,
    supersessionEvidence: intent.elements?.SUPERSESSION ?? null,
    elements: sanitizeElements(intent.elements),
    preRemovalSnapshotDigest: snapshotDigest,
    executedBy: { writerId, writerGeneration },
  };
  validatePayloadShape(payload);

  // F4 INPUT RULE / journal-bytes-are-authority: the append state comes from
  // THIS seam's own chain-verified read of the journal — never from the
  // caller's projection (a stale/forged projection could otherwise append a
  // duplicate sequence and poison the chain while reporting success). The
  // caller projection is still used for the N1 verdict binding above; the
  // JOURNAL decides where the chain head is.
  let journalHead;
  try {
    journalHead = readLifecycleJournalState(journalPath);
  } catch (e) {
    if (e instanceof JournalError) return fail("HOLD", e.code, "JOURNAL_HEAD_UNREADABLE", { detail: String(e.message).slice(0, 200) });
    throw e;
  }
  // RRC-T3 (RUNG-8): fail closed BEFORE any new authoritative append can be
  // built on a torn/unterminated tail — appending onto a file whose final
  // line lacks "\n" would concatenate the new event onto the torn bytes and
  // produce the forbidden third state (caller-visible APPLIED over a chain
  // no reader can see). The frozen HOLD row is exactly this reconciliation
  // barrier; the torn tail is mechanical to recover (one "\n" insert) and
  // the valid prefix stays authoritative and untouched.
  if (journalHead.partialTrailingLine === true) {
    return fail("HOLD", MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "PARTIAL_TRAILING_LINE_UNTERMINATED", { detail: "RRC-T3: journal ends with an unterminated final line (torn write) — reconcile-first; no append may build on torn authority" });
  }
  let result;
  try {
    result = appendJournalEvent({
      journalPath,
      state: { lastSequence: journalHead.lastSequence, previousDigest: journalHead.previousDigest },
      operation: "LIFECYCLE_EVENT",
      recordId: intent.recordId,
      payload,
      ...(now ? { timestamp: now } : {}),
    });
  } catch (e) {
    if (e instanceof JournalError) {
      // Journal's own fail-closed discipline (seq/secret) — surfaced, never swallowed.
      return fail("REJECT", e.code, "JOURNAL_APPEND_REJECTED", { detail: String(e.message).slice(0, 200) });
    }
    throw e;
  }
  // Durability boundary = appendJournalEvent RETURNED (write + fsync inside).
  return {
    ok: true,
    status: "APPLIED",
    code: null,
    reason: null,
    layer2: "APPLIED",
    event: result.event,
    journalSequence: result.event.journalSequence,
    exactlyOnceKey,
    state: result.state,
  };
}

function sanitizeElements(elements) {
  // Elements pass through the payload allowlist unchanged (the real gate is
  // validatePayloadShape + the journal's own secret scan — no extra
  // "sanitization" pretense: N2 constructs, never rewrites, N1 evidence).
  return elements == null ? null : elements;
}

/** Deterministic lifecycle event identity (never reused; exactly-once). */
export function deriveLifecycleEventId({ recordId, event, seq, key }) {
  return canonicalSha256({ recordId, event, seq, key }).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Cancellation boundary (CANCELLATION §1/§2 — OP_CANCEL via N2, authority-
// first). Same seam, same exactly-once keys, same durability contract.
// ---------------------------------------------------------------------------
export function writeOpCancelEvent({ intent, verdict, projection, journalPath, writerId, writerGeneration, now }) {
  if (!intent || !projection || !journalPath) {
    return fail("REJECT", LIFECYCLE_TRANSITION_ILLEGAL, "WRITE_SEAM_INPUT_MISSING");
  }
  // Same binding guards as writeLifecycleEvent (module header law: the seam
  // accepts only journal-derived facts and only N1-authorized verdicts).
  if (intent.claimSource !== "JOURNAL_PROJECTION" || projection.claimSource !== "JOURNAL_PROJECTION" || projection.chainVerified !== true) {
    return fail("HOLD", MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "RECOVERY_REQUIRED", { detail: "cancel seam refuses non-journal-derived facts" });
  }
  if (!verdict?.ok || verdict.opBoundary !== "OP_CANCEL") {
    return fail("REJECT", verdict?.code ?? LIFECYCLE_TRANSITION_ILLEGAL, verdict?.reason ?? "CANCEL_NOT_AUTHORIZED");
  }
  // Only an APPLIED (authorized) verdict constructs an event. NO-OP verdicts
  // (duplicate/conflict/cancel-after-terminal) never mint events — the
  // duplicate scan below answers from JOURNAL REALITY with the exact oracle
  // (cited first-cancel key), so the frozen citation rule survives at the
  // seam layer (CANCELLATION §3; FINE-CODE-CLASS-FREEZE A4.3).
  if (verdict.status !== "APPLIED") {
    return fail("NO-OP", verdict.code ?? LIFECYCLE_TRANSITION_ILLEGAL, verdict.reason ?? "CANCEL_VERDICT_NOT_APPLIED", { layer1: verdict.layer1 ?? null, existingCancelKey: verdict.existingCancelKey ?? null, opBoundary: "OP_CANCEL" });
  }
  const eventId = deriveLifecycleEventId({ recordId: intent.recordId, event: "OP_CANCEL", seq: projection.lastSequence ?? 0, key: intent.cancelKey ?? null });
  const duplicate = findDuplicateDelivery(journalPath, { recordId: intent.recordId, event: "OP_CANCEL", exactlyOnceKey: lifecycleExactlyOnceKey({ recordId: intent.recordId, logicalKey: intent.cancelKey ?? null, eventId }) });
  if (duplicate) {
    return { ...duplicate, conflictingCancelKey: duplicate.code === "EVENT_IDEMPOTENCY_CONFLICT" ? (intent.cancelKey ?? null) : duplicate.conflictingCancelKey };
  }
  // F8 (RRC-F8 RUNG-8 hardening, cancel boundary — TERMINAL REALITY, after
  // the exactly-once answer per STAGE-2 ≡ STAGE-1): cancel-after-terminal is
  // bound to the record state RE-DERIVED from the journal — a caller
  // projection cannot hide a terminal record behind a non-terminal
  // projection.state (the frozen NO-OP/LIFECYCLE_TERMINAL_IMMUTABLE form).
  {
    const { journalState } = deriveJournalTruth(journalPath, intent.recordId);
    if (TERMINAL_STATES.has(journalState)) {
      return fail("NO-OP", LIFECYCLE_TERMINAL_IMMUTABLE, "CANCEL_AFTER_TERMINAL", { layer1: journalState, layer2: "NO-OP", opBoundary: "OP_CANCEL", detail: "F8 journal-wins: terminal reality re-derived from the journal" });
    }
  }
  const payload = {
    eventId,
    recordId: intent.recordId,
    logicalKey: intent.cancelKey ?? null,
    contentHash: null,
    event: "OP_CANCEL",
    transition: { ...verdict.transition },
    generationBefore: projection.generation,
    generationAfter: projection.generation,
    authoritySource: "OPERATION_BOUNDARY",
    humanAdmissionRecord: null,
    causeEvidence: { cancelKey: intent.cancelKey ?? null },
    supersessionEvidence: null,
    elements: null,
    preRemovalSnapshotDigest: null,
    executedBy: { writerId, writerGeneration },
  };
  validatePayloadShape(payload);
  // Journal-reality append state (same F4 input rule as writeLifecycleEvent).
  let journalHead;
  try {
    journalHead = readLifecycleJournalState(journalPath);
  } catch (e) {
    if (e instanceof JournalError) return fail("HOLD", e.code, "JOURNAL_HEAD_UNREADABLE", { detail: String(e.message).slice(0, 200) });
    throw e;
  }
  // RRC-T3 (RUNG-8): same torn-tail barrier as the transition seam — no
  // authoritative append may build on an unterminated final line.
  if (journalHead.partialTrailingLine === true) {
    return fail("HOLD", MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "PARTIAL_TRAILING_LINE_UNTERMINATED", { detail: "RRC-T3: journal ends with an unterminated final line (torn write) — reconcile-first; no append may build on torn authority" });
  }
  let result;
  try {
    result = appendJournalEvent({
      journalPath,
      state: { lastSequence: journalHead.lastSequence, previousDigest: journalHead.previousDigest },
      operation: "LIFECYCLE_EVENT",
      recordId: intent.recordId,
      payload,
      ...(now ? { timestamp: now } : {}),
    });
  } catch (e) {
    if (e instanceof JournalError) return fail("REJECT", e.code, "JOURNAL_APPEND_REJECTED", { detail: String(e.message).slice(0, 200) });
    throw e;
  }
  return { ok: true, status: "APPLIED", code: null, reason: "CANCEL_INTENT_DURABLE", layer2: "APPLIED", event: result.event, journalSequence: result.event.journalSequence, state: result.state };
}

// ---------------------------------------------------------------------------
// Duplicate delivery / conflicting-cancel resolution over journal reality.
// The candidate's exactly-once key (built from its own recordId + logicalKey
// + eventId) is compared against the key RE-DERIVED from each journaled
// event's own payload fields — the frozen key form (EXACTLY-ONCE §1 row 1;
// LEGAL-TRANSITIONS header: recordId + logicalKey/contentHash + target event
// identity). Keys EQUAL ⇒ the same logical op re-delivered ⇒ idempotent
// NO-OP (DUPLICATE_EVENT_ID; journal gains nothing). Keys differ while a
// cancel is already journaled ⇒ conflict-class NO-OP (EVENT_IDEMPOTENCY_
// CONFLICT) citing BOTH the first durable cancel (the authority —
// CANCELLATION §3 card §27) and the conflicting candidate key.
// A different (recordId, kind) pair never matches (its key cannot equal).
// ---------------------------------------------------------------------------
export function findDuplicateDelivery(journalPath, { recordId, event, exactlyOnceKey }) {
  if (exactlyOnceKey == null) return null; // no key ⇒ nothing to match (fail-open scan refused upstream by key derivation)
  const r = readJournal(journalPath);
  for (const ev of r.events) {
    if (ev.operation !== "LIFECYCLE_EVENT") continue;
    const p = ev.payload ?? {};
    if (p.recordId !== recordId) continue;
    if (p.event !== event) continue;
    // journal-reality key for this journaled event, from ITS OWN fields:
    const journaledKey = lifecycleExactlyOnceKey({ recordId, logicalKey: p.logicalKey ?? null, eventId: p.eventId });
    if (journaledKey === exactlyOnceKey) {
      // same logical op re-delivered — exactly-once replay
      return { ok: true, status: "NO-OP", code: "DUPLICATE_EVENT_ID", reason: "EXACTLY_ONCE_REPLAY", layer2: "NO-OP", duplicateOf: { eventId: p.eventId, journalSequence: ev.journalSequence } };
    }
    if (event === "OP_CANCEL") {
      // conflicting cancel: a DIFFERENT key while one is already journaled —
      // the first durable cancel remains the authority; the conflicting one
      // is rejected citing it (CANCELLATION §3; FINE-CODE-CLASS-FREEZE A4.3).
      return { ok: true, status: "NO-OP", code: "EVENT_IDEMPOTENCY_CONFLICT", reason: "CONFLICTING_CANCEL", layer2: "NO-OP", existingCancelKey: p.logicalKey ?? null, conflictingCancelKey: null, duplicateOf: { eventId: p.eventId, journalSequence: ev.journalSequence } };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pre-removal snapshot digest (T12; R20 §1): sha256 of the pre-removal record
// bytes at intent time — journal-first payload, NEVER a projection write, and
// NEVER a restore key (no code may read it for reconstruction).
// ---------------------------------------------------------------------------
export function computePreRemovalSnapshotDigest(record) {
  return canonicalSha256(record);
}

// ---------------------------------------------------------------------------
// Replay projection entry (N3 consumes; N2 exposes the pure reducer).
// Applies one lifecycle journal event to a record-state projection. Replay
// reconstructs — it never re-removes, never resurrects, never re-executes.
// ---------------------------------------------------------------------------
export function applyLifecycleEventToProjection(projection, journalEvent) {
  const p = journalEvent?.payload ?? {};
  if (p.event === "OP_CANCEL") return projection; // operation boundary: no record-state change
  const next = { ...projection, claimSource: "JOURNAL_PROJECTION", chainVerified: true };
  next.generation = p.generationAfter ?? projection.generation;
  if (p.transition?.to) next.state = p.transition.to;
  if (p.transition?.to === "REMOVED") next.terminal = "REMOVED";
  return next;
}

export { readJournal, assertChainIntegrity };
