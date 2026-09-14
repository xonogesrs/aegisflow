// src/learning/lifecycle/state-machine.mjs
//
// STAGE-F LIFECYCLE — N1 DECISION CORE (PURE).
//
// Authority chain (every rule below is a frozen citation — this module
// translates the frozen table; it decides nothing new):
//   SPEC-1  AUTOLOOP-V1-STAGE-F-LIFECYCLE-SPEC-1-20260909T201500Z
//           · STATE-MODEL.md            (7 states, SM-1…SM-5)
//           · LEGAL-TRANSITIONS.md      (T1–T12 rows + idempotency key form)
//           · ILLEGAL-TRANSITIONS.md    (I1–I11 rows, first-reachable fence)
//           · FAIL-CLOSED-FENCE-ORDER.md (F4–F8 short-circuit order; F0–F3 are
//             input preconditions — see below)
//           · O1-O7-IMPLEMENTATION-MAP.md §Element-set freeze (E1–E9)
//           · R16-DOUBLE-GATE.md / R20-HUMAN-AUTHORITY.md (GATE-1 checks)
//           · ORACLE-CONTRACT.md        (verdict = status + code + effect)
//   PLAN-1  AUTOLOOP-V1-STAGE-F-LIFECYCLE-PLAN-1-20260909T140940Z
//           · LEGAL-TRANSITION-MAP.md / ILLEGAL-TRANSITION-MAP.md (seam rows)
//           · MODULE-RESPONSIBILITY-MAP.md (N1 row: DECIDES, NEVER WRITES)
//   RUNG-5  AUTOLOOP-V1-STAGE-F-LIFECYCLE-IMPLEMENTATION-ADMISSION-1-20260909T155807Z
//           · MUTATION-SURFACE-FREEZE §2 N1 (allowed/forbidden rows)
//           · COUNTS-FREEZE §2 (count-preservation laws)
//
// N1 IS PURE: no I/O, no import of jsonl-journal.mjs or any file path, no
// process-memory/session/provider/container/checkpoint parameters as identity
// or authority inputs, no minting, no mutable module-level state surviving as
// authority. The journal is the authority; N1 only renders verdicts over
// journal-derived facts handed to it. NO GENERIC (from,event,to) PASSTHROUGH
// exists: anything not in T1–T12 resolves to its I-row (anti-escape-hatch
// law). F0 chain integrity / F1 execution identity / F2 subject binding / F3
// policy projection are INPUT PRECONDITIONS: N1 requires their already-
// verified facts (chainVerified, executionIdentity, recordExists,
// policyAllowed) and fails closed when they are not present — it never
// re-derives them (ONE RECOVERY PATH law: F0–F2 belong to N3 / the gate).

import { LIFECYCLE_EVENT_KINDS, LIFECYCLE_TRANSITION_ILLEGAL, LIFECYCLE_TERMINAL_IMMUTABLE } from "../../memory/contract.mjs";
import { WRITEBACK_TRUST_HOLD } from "../../memory/writeback/trust.mjs";

// ---------------------------------------------------------------------------
// The 7-state closed enum — declared ONCE (STATE-REPRESENTATION §0; SM-1).
// No eighth state. COMPLETED / HOLD / CANCELLED / FAILED / RUNNING / PAUSED /
// CANCELLING / ABSENT / ADMITTED / RESUMED / RESUMABLE are Layer-2 run
// vocabulary (TERMINAL-SEMANTICS §1) and are NEVER states.
// ---------------------------------------------------------------------------
export const LIFECYCLE_STATES = Object.freeze([
  "CANDIDATE",
  "ADVISORY",
  "REQUIRED_QUESTION",
  "MANDATORY_GATE",
  "DEMOTED",
  "ARCHIVED",
  "REMOVED",
]);

// Layer-2 operation-run disposition vocabulary (TERMINAL-SEMANTICS §1).
// Exported read-only for oracle/return-shape use — never a record state.
export const LIFECYCLE_RUN_OUTCOMES = Object.freeze([
  "APPLIED", "REJECTED", "NO-OP", "HOLD", "CANCELLED", "FAILED", "COMPLETED",
]);

// Fine codes consumed verbatim from the live sealed surface (FINE-CODE-MAP §2
// constant-authority ledger — no aliasing, no normalization).
import { MEMORY_ERRORS } from "../../memory/validation.mjs";
import { TRANSFER_CODES } from "../../learning/transfer-metrics/schema.mjs";
export const LIFECYCLE_FINE_CODES = Object.freeze({
  TRANSITION_ILLEGAL: LIFECYCLE_TRANSITION_ILLEGAL,
  TERMINAL_IMMUTABLE: LIFECYCLE_TERMINAL_IMMUTABLE,
  JOURNAL_CHAIN_INVALID: MEMORY_ERRORS.JOURNAL_CHAIN_INVALID,
  WRONG_GENERATION: TRANSFER_CODES.WRONG_GENERATION,
  AUTHORITY_INSUFFICIENT: "WRITEBACK_AUTHORITY_INSUFFICIENT", // gate.mjs:33 standing code
  EVIDENCE_MISSING: WRITEBACK_TRUST_HOLD.EVIDENCE_MISSING,
  EVIDENCE_INVENTORY_REQUIRED: "WRITEBACK_EVIDENCE_INVENTORY_REQUIRED", // trust.mjs:31
  DUPLICATE_EVENT_ID: "DUPLICATE_EVENT_ID", // EXACTLY-ONCE / terminal-adapter precedent family
  EVENT_IDEMPOTENCY_CONFLICT: TRANSFER_CODES.IDEMPOTENCY_CONFLICT, // schema.mjs:352 value
  SELF_PROMOTION: "WRITEBACK_SELF_PROMOTION_REJECTED", // trust.mjs WRITEBACK_TRUST_HOLD.SELF_PROMOTION
  SKIP_LEVEL: "WRITEBACK_SKIP_LEVEL_PROMOTION_REJECTED", // trust.mjs WRITEBACK_TRUST_HOLD.SKIP_LEVEL
  INCIDENT_IMMUTABILITY_PREFIX: "pattern_forbidden_incident_layer_field:", // validation.mjs:243 live prefix
  RECOVERY_REQUIRED: "RECOVERY_REQUIRED",
  OWNERSHIP_AMBIGUOUS: "PROCESS_OWNERSHIP_AMBIGUOUS",
});

// Trust-ladder consumption (structural — trust.mjs values reused verbatim,
// never re-implemented; ILLEGAL-TRANSITIONS I1/I10 rows).
export const TRUST_LADDER_CLASSES = Object.freeze({
  SKIP_LEVEL: "WRITEBACK_TRUST_HOLD.SKIP_LEVEL",
  SELF_PROMOTION: "WRITEBACK_TRUST_HOLD.SELF_PROMOTION",
});

// Frozen HOLD-class label (contract.mjs additive; A4.4).
export const SPEC_AMENDMENT_REQUIRED = "SPEC_AMENDMENT_REQUIRED";

// ---------------------------------------------------------------------------
// Element gate (O1-O7-IMPLEMENTATION-MAP §Element-set freeze — verbatim).
// Every upward edge requires E1–E7; T2 adds E8; T3 adds E9. Demotion requires
// cause evidence (R18); archive requires supersession/retirement evidence
// (R19); removal requires the human admission record + justification class
// (R20).
// ---------------------------------------------------------------------------
export const LIFECYCLE_ELEMENTS = Object.freeze({
  E1: "E1_qualified_incidents_or_high_severity_rationale",
  E2: "E2_independent_review_identity",
  E3: "E3_applicability_boundary",
  E4: "E4_false_positive_analysis",
  E5: "E5_measurable_transfer_benefit",
  E6: "E6_rollback_path",
  E7: "E7_generation_binding",
  E8: "E8_recorded_advisory_usage_and_escape_evidence",
  E9: "E9_human_admission_record",
});

// Justification classes legal inside a human REMOVAL admission record (R20).
export const REMOVAL_JUSTIFICATION_CLASSES = Object.freeze([
  "SECURITY_SECRET_SCAN",
  "PROVENANCE_CORRUPTION",
]);

// Human authority reference source values legal in an admission record
// (R16 §2 GATE 1 / R20 §1: HUMAN/CONTROLLER — never an agent/executor value).
export const HUMAN_AUTHORITY_SOURCES = Object.freeze(["HUMAN", "CONTROLLER"]);

// ---------------------------------------------------------------------------
// The frozen legal transition table — T1–T12, 12 rows, each with the exact
// binding columns (LEGAL-TRANSITIONS.md §table; LEGAL-TRANSITION-MAP.md).
// from/event/to are EXACT; authorityRow names the governing rule; elements =
// required element keys; toState is the only legal destination for the row.
// ---------------------------------------------------------------------------
export const LEGAL_TRANSITIONS = Object.freeze([
  { id: "T1", from: "CANDIDATE", event: "PROMOTE", to: "ADVISORY", authority: "R14", elements: ["E1", "E2", "E3", "E4", "E5", "E6", "E7"], humanRecord: false },
  { id: "T2", from: "ADVISORY", event: "PROMOTE", to: "REQUIRED_QUESTION", authority: "R15", elements: ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"], humanRecord: false },
  { id: "T3", from: "REQUIRED_QUESTION", event: "PROMOTE", to: "MANDATORY_GATE", authority: "R16", elements: ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E9"], humanRecord: true },
  { id: "T4", from: "ADVISORY", event: "DEMOTE", to: "DEMOTED", authority: "R18", elements: ["CAUSE"], humanRecord: false },
  { id: "T5", from: "REQUIRED_QUESTION", event: "DEMOTE", to: "DEMOTED", authority: "R18", elements: ["CAUSE"], humanRecord: false },
  { id: "T6", from: "MANDATORY_GATE", event: "DEMOTE", to: "DEMOTED", authority: "R18", elements: ["CAUSE"], humanRecord: false },
  { id: "T7", from: "ADVISORY", event: "ARCHIVE", to: "ARCHIVED", authority: "R19", elements: ["SUPERSESSION"], humanRecord: false },
  { id: "T8", from: "REQUIRED_QUESTION", event: "ARCHIVE", to: "ARCHIVED", authority: "R19", elements: ["SUPERSESSION"], humanRecord: false },
  { id: "T9", from: "CANDIDATE", event: "ARCHIVE", to: "ARCHIVED", authority: "R19", elements: ["SUPERSESSION"], humanRecord: false },
  { id: "T10", from: "DEMOTED", event: "ARCHIVE", to: "ARCHIVED", authority: "R19", elements: ["SUPERSESSION"], humanRecord: false },
  { id: "T11", from: "MANDATORY_GATE", event: "ARCHIVE", to: "ARCHIVED", authority: "R19", elements: ["SUPERSESSION"], humanRecord: false },
  { id: "T12", from: "ARCHIVED", event: "REMOVE", to: "REMOVED", authority: "R20", elements: ["HUMAN_ADMISSION"], humanRecord: true, justificationRequired: true },
]);

// ---------------------------------------------------------------------------
// The frozen illegal classes — I1–I11, 11 rows (ILLEGAL-TRANSITIONS.md
// §table; ILLEGAL-TRANSITION-MAP.md seam placement). Every row returns an
// exact failure (status + code) with ZERO durable mutation; no silent no-op.
// ---------------------------------------------------------------------------
export const ILLEGAL_TRANSITIONS = Object.freeze([
  { id: "I1", from: "CANDIDATE", event: "PROMOTE", to: "REQUIRED_QUESTION", fence: "F6", status: "REJECT", code: LIFECYCLE_TRANSITION_ILLEGAL, reason: "SKIP_LEVEL" },
  { id: "I2", from: "CANDIDATE", event: "PROMOTE", to: "MANDATORY_GATE", fence: "F6", status: "REJECT", code: LIFECYCLE_TRANSITION_ILLEGAL, reason: "SKIP_LEVEL" },
  { id: "I3", from: "ADVISORY", event: "PROMOTE", to: "MANDATORY_GATE", fence: "F6", status: "REJECT", code: LIFECYCLE_TRANSITION_ILLEGAL, reason: "SKIP_LEVEL" },
  { id: "I4", from: "REQUIRED_QUESTION", event: "PROMOTE", to: "ADVISORY", fence: "F6", status: "REJECT", code: LIFECYCLE_TRANSITION_ILLEGAL, reason: "DOWNWARD_NON_DEMOTION" },
  { id: "I5", from: "CANDIDATE", event: "DEMOTE", to: null, fence: "F6", status: "REJECT", code: LIFECYCLE_TRANSITION_ILLEGAL, reason: "SOURCE_STATE_NOT_DEMOTABLE" },
  { id: "I6", from: null, event: "REMOVE", to: null, fence: "F6", status: "REJECT", code: LIFECYCLE_TRANSITION_ILLEGAL, reason: "REMOVAL_SOURCE_NOT_ARCHIVED", fromExcept: ["ARCHIVED"] },
  { id: "I7", from: null, event: null, to: null, fence: "F6", status: "REJECT", code: LIFECYCLE_TERMINAL_IMMUTABLE, reason: "V15_RESURRECTION", fromIn: ["ARCHIVED", "REMOVED"] },
  { id: "I8", from: null, event: null, to: null, fence: "F4", status: "REJECT", code: MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, reason: "SILENT_COERCION_DETECTED" },
  { id: "I9", from: null, event: null, to: null, fence: "F7", status: "REJECT", code: null, reason: "MISSING_ELEMENT" }, // code = admission-element class (resolved at runtime)
  { id: "I10", from: null, event: null, to: null, fence: "F7", status: "REJECT", code: null, reason: "NO_INDEPENDENT_REVIEW_IDENTITY" },
  { id: "I11", from: null, event: null, to: null, fence: "F5", status: "REJECT", code: TRANSFER_CODES.WRONG_GENERATION, reason: "GENERATION_MISMATCH" },
]);

const UPWARD_EVENTS = new Set(["PROMOTE"]);
const DEMOTABLE_FROM = new Set(["ADVISORY", "REQUIRED_QUESTION", "MANDATORY_GATE"]);
// FROZEN terminal set (7-state semantics; unchanged — now exported so the N2
// cancel-boundary F8 fencing consumes THIS set verbatim instead of
// re-implementing the list; RRC-F8 RUNG-8 hardening).
export const TERMINAL_STATES = new Set(["DEMOTED", "ARCHIVED", "REMOVED"]);

// The verdict shape (gate outcome shape — MODULE-RESPONSIBILITY-MAP E1/N1).
// { ok, status, code, reason?, transition? , layer1, layer2 }
function verdict(status, code, reason, extra = {}) {
  return { ok: false, status, code, reason, layer1: extra.layer1 ?? null, layer2: status, ...extra };
}
export function okVerdict(transition, extra = {}) {
  return { ok: true, status: "APPLIED", code: null, reason: null, layer1: `${transition.from}->${transition.to}`, layer2: "APPLIED", transition: { id: transition.id, from: transition.from, event: transition.event, to: transition.to, authority: transition.authority }, ...extra };
}

// ---------------------------------------------------------------------------
// F4 — journal-reality check (I8 seam). The state claim evaluated MUST be the
// journal-derived projection (JOURNAL-CRASH-SEMANTICS §1 STEP-1 F4 INPUT
// RULE); process memory is never accepted as the claim source. journalFacts
// MUST carry claimSource === "JOURNAL_PROJECTION".
// ---------------------------------------------------------------------------
function checkF4_journalReality(intent, projection) {
  if (intent?.claimSource !== "JOURNAL_PROJECTION") {
    return verdict("REJECT", MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "SILENT_COERCION_DETECTED", {
      iRow: "I8", fence: "F4",
      detail: "state claim is not journal-derived (process-memory/other claim source) — nothing adopted",
    });
  }
  if (projection?.claimSource !== "JOURNAL_PROJECTION") {
    return verdict("REJECT", MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "SILENT_COERCION_DETECTED", {
      iRow: "I8", fence: "F4",
      detail: "projection is not journal-derived — nothing adopted; rebuild projection from journal reality",
    });
  }
  if (projection?.chainVerified !== true) {
    return verdict("HOLD", MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "RECOVERY_REQUIRED", {
      fence: "F0", detail: "journal chain not verified — reconcile-from-reality only",
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// F5 — generation fence (I11 seam; GENERATION.md: durable-field comparison,
// never timestamps/memory).
// ---------------------------------------------------------------------------
function checkF5_generation(intent, projection) {
  const intentGen = intent?.generation;
  const durableGen = projection?.generation;
  if (!Number.isInteger(intentGen) || !Number.isInteger(durableGen)) {
    return verdict("REJECT", TRANSFER_CODES.WRONG_GENERATION, "GENERATION_MISMATCH", {
      iRow: "I11", fence: "F5", detail: "generation bindings missing/malformed on intent or durable projection",
    });
  }
  if (intentGen !== durableGen) {
    return verdict("REJECT", TRANSFER_CODES.WRONG_GENERATION, "GENERATION_MISMATCH", {
      iRow: "I11", fence: "F5", detail: `intent generation ${intentGen} != durable generation ${durableGen} — record untouched`,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// F6 — transition legality + terminal checks (I1–I7 seam). Table-total: any
// (from, event, to) not in T1–T12 resolves to its I-row; REMOVED has no
// out-edge at all; resurrection from ARCHIVED/REMOVED is I7.
// ---------------------------------------------------------------------------
function classifyF6(fromState, event, toState) {
  const row = LEGAL_TRANSITIONS.find((t) => t.from === fromState && t.event === event && (toState == null || t.to === toState));
  if (row) return { legal: true, row };
  // Exact I-row matches first (deterministic, table-driven). I4's frozen FROM
  // set is "REQUIRED_QUESTION or MANDATORY_GATE" (ILLEGAL-TRANSITIONS row I4):
  // any downward PROMOTE from either state resolves to I4.
  const exact = ILLEGAL_TRANSITIONS.find((i) => {
    if (i.id === "I6" || i.id === "I7") return false;
    const fromMatch = i.from === fromState || (i.id === "I4" && (fromState === "REQUIRED_QUESTION" || fromState === "MANDATORY_GATE") && event === "PROMOTE" && toState === "ADVISORY");
    return fromMatch && i.event === event && (i.to == null || i.to === toState);
  });
  if (exact) return { legal: false, iRow: exact };
  // I5 — CANDIDATE demote (any target).
  if (fromState === "CANDIDATE" && event === "DEMOTE") return { legal: false, iRow: ILLEGAL_TRANSITIONS.find((i) => i.id === "I5") };
  // I6 — removal from any state except ARCHIVED.
  if (event === "REMOVE" && fromState !== "ARCHIVED") return { legal: false, iRow: { ...ILLEGAL_TRANSITIONS.find((i) => i.id === "I6"), from: fromState } };
  // I7 — resurrection / REMOVED out-edge / any transition from a terminal
  // state that is not its frozen continuation.
  if (TERMINAL_STATES.has(fromState)) {
    const cont = LEGAL_TRANSITIONS.find((t) => t.from === fromState);
    if (!cont || cont.event !== event || (toState != null && cont.to !== toState)) {
      return { legal: false, iRow: { ...ILLEGAL_TRANSITIONS.find((i) => i.id === "I7"), from: fromState, event, to: toState } };
    }
  }
  // Table miss without a named I-row: still fail closed (anti-escape-hatch
  // law) as a generic illegal transition of the matching family.
  return { legal: false, iRow: { id: "I-F6", fence: "F6", status: "REJECT", code: LIFECYCLE_TRANSITION_ILLEGAL, reason: "NOT_IN_TRANSITION_TABLE", from: fromState, event, to: toState } };
}

// ---------------------------------------------------------------------------
// F7 — human authority + element gate (I9/I10 seams + R16/R20 checks).
// ---------------------------------------------------------------------------
function elementClassCode(elementKey) {
  // Admission-element class binding (FINE-CODE-CLASS-FREEZE A4.1): the class
  // matching the failed precondition. E9 (the human admission record) is the
  // WRITEBACK_AUTHORITY_INSUFFICIENT row (frozen I9 row).
  if (elementKey === "E9") return LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT;
  if (elementKey === "E1" || elementKey === "E4" || elementKey === "E5" || elementKey === "CAUSE") return LIFECYCLE_FINE_CODES.EVIDENCE_MISSING;
  if (elementKey === "E3" || elementKey === "E6") return LIFECYCLE_FINE_CODES.EVIDENCE_INVENTORY_REQUIRED;
  if (elementKey === "E2") return LIFECYCLE_FINE_CODES.EVIDENCE_MISSING;
  if (elementKey === "E8") return LIFECYCLE_FINE_CODES.EVIDENCE_MISSING;
  if (elementKey === "E7") return LIFECYCLE_FINE_CODES.WRONG_GENERATION;
  if (elementKey === "SUPERSESSION") return LIFECYCLE_FINE_CODES.EVIDENCE_MISSING;
  if (elementKey === "HUMAN_ADMISSION") return LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT;
  return LIFECYCLE_FINE_CODES.EVIDENCE_MISSING;
}

function checkF7_elementsAndAuthority(row, intent) {
  const elements = intent?.elements ?? {};
  for (const key of row.elements) {
    const v = elements[key];
    const present = key === "E7"
      ? v === true // generation binding asserted by the intent at F5; presence flag required in payload
      : v != null && v !== false && v !== "" && !(typeof v === "object" && Array.isArray(v) && v.length === 0);
    if (!present) {
      return verdict("REJECT", elementClassCode(key), "MISSING_ELEMENT", {
        iRow: "I9", fence: "F7", missingElement: key,
        detail: `admission element ${key} missing for ${row.id} — no event`,
      });
    }
  }
  // I10 — independent review identity (executor self-approval rejected).
  if (UPWARD_EVENTS.has(row.event)) {
    const review = intent?.elements?.E2;
    // V5 executor self-approval: a self-authored execution identity cannot
    // review its own output — regardless of the E2 shape presented.
    const selfApproval = intent?.selfApproval === true
      || intent?.executionIdentity?.selfAuthored === true
      || (review && typeof review === "object" && review.selfAuthored === true);
    if (selfApproval) {
      return verdict("REJECT", LIFECYCLE_FINE_CODES.SELF_PROMOTION, "SELF_PROMOTION", {
        iRow: "I10", fence: "F7", detail: "independent review identity absent/self-authored — executor self-approval rejected",
      });
    }
    const malformed = review == null
      || (typeof review !== "object" || typeof review.identity !== "string" || !/^[0-9a-f]{64}$/.test(review.identity) || review.independent !== true);
    if (malformed) {
      return verdict("REJECT", WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_MALFORMED, "NO_INDEPENDENT_REVIEW_IDENTITY", {
        iRow: "I10", fence: "F7", detail: "E2 review identity malformed or not independent — no event",
      });
    }
  }
  // R16 GATE 1 — human admission record (T3): presence + well-formedness +
  // binding to the SAME recordId + generation (DBL-4/DBL-5 composite check).
  if (row.humanRecord && row.event === "PROMOTE") {
    const rec = intent?.elements?.E9 ?? null;
    const chk = checkHumanAdmissionRecord(rec, intent);
    if (chk) return chk;
  }
  // R20 — human REMOVAL admission record (T12) + justification class.
  if (row.id === "T12") {
    const rec = intent?.elements?.HUMAN_ADMISSION ?? intent?.removalAdmissionRecord ?? null;
    const chk = checkHumanAdmissionRecord(rec, intent);
    if (chk) return chk;
    const just = rec.justificationClass;
    if (!REMOVAL_JUSTIFICATION_CLASSES.includes(just)) {
      return verdict("REJECT", LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT, "REMOVAL_JUSTIFICATION_INVALID", {
        iRow: "I9", fence: "F7", detail: "removal admission record lacks a frozen justification class (SECURITY_SECRET_SCAN | PROVENANCE_CORRUPTION)",
      });
    }
  }
  return null;
}

/** Human admission record check (R16 §2 CHECK seam / R20 §1). The ONLY
 * accepted proof of human authority is a VALID DURABLE RESOLUTION PROOF —
 * the journal-derived fact-set produced by the READING layer's
 * admission-resolving read (N3::resolveHumanAdmissionReference) — binding
 * the SAME recordId + generation. Agent-minted (SPOOF-1/R1), forged
 * (SPOOF-2/R2), foreign (SPOOF-3/R3) and stale (SPOOF-4/R4, DBL-4/DBL-5)
 * forms fail closed with their exact classes.
 *
 * AMENDMENT 1 (OBS-02 — NORMATIVE-AMENDMENT-TEXT.md R-RES-1…R-RES-9):
 * the caller-asserted `rec.journalResolved` flag has ZERO check authority
 * (R-RES-4: CALLER_journalResolved_AUTHORITY = NO — CHECK_CONSUMES_CALLER_
 * FLAG = NO). DURABLE_RESOLUTION_AUTHORITY = JOURNAL_DERIVED_ONLY: this
 * check consumes intent.resolutionEvidence, the proof derived from the
 * chain-verified journal projection, and fails closed without it. N1
 * remains PURE — the proof is an INPUT FACT (R-RES-5); N1 performs no I/O
 * and never mints/synthesizes a proof. FALSE_RESOLVED_ACCEPTANCE =
 * IMPOSSIBLE: no presentation-side value can manufacture the proof.
 *
 * Frozen amended-F7 row mapping (OBS02-F7-AMENDMENT.md table; reason-token
 * forms only — NEW_FINE_CODE_CLASSES = 0):
 *   R1 missing proof     ⇒ AUTHORITY_INSUFFICIENT / ADMISSION_RESOLUTION_UNPROVEN
 *   R2 stale proof       ⇒ WRONG_GENERATION (generation divergence — DBL-4 form)
 *   R3 wrong head        ⇒ AUTHORITY_INSUFFICIENT / ADMISSION_RESOLUTION_UNRESOLVED
 *   R4 wrong event       ⇒ AUTHORITY_INSUFFICIENT / ADMISSION_RESOLUTION_UNRESOLVED
 *   R5 wrong recordId    ⇒ WRONG_GENERATION (binding-mismatch family — SPOOF-3/R3)
 *   R6 wrong generation  ⇒ WRONG_GENERATION (DBL-4/DBL-5 form)
 *   R7 replayed proof    ⇒ exactly-once law upstream (DUPLICATE_EVENT_ID /
 *                          second authority mint REJECT) — unreachable here
 *   R8 conflicting proof ⇒ HOLD JOURNAL_CHAIN_INVALID ⇒ RECOVERY_REQUIRED
 *   R9 malformed proof   ⇒ EVIDENCE_IDENTITY_FORGED/_MALFORMED family */
function checkHumanAdmissionRecord(rec, intent) {
  if (rec == null) {
    return verdict("REJECT", LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT, "HUMAN_ADMISSION_RECORD_MISSING", {
      iRow: "I9", fence: "F7", detail: "human admission record absent — no transition",
    });
  }
  if (typeof rec !== "object") {
    return verdict("REJECT", LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT, "HUMAN_ADMISSION_RECORD_MISSING", {
      iRow: "I9", fence: "F7", detail: "admission reference is not a journal-resolvable record object",
    });
  }
  // SPOOF-1/R1 (existing frozen form, byte-identical): agent-minted /
  // non-journal creation path. The amendment EXTENDS this fence's reach to
  // journaled material (the proof's mintPath below); it does not move it.
  if (rec.mintPath !== "HUMAN_CBM4_GATE") {
    return verdict("REJECT", LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT, "AGENT_MINTED_ADMISSION_REJECTED", {
      iRow: "I9", fence: "F7", resolutionRow: "R4",
      detail: "admission record not minted through the human CBM-4 gate path — no transition",
    });
  }
  // SPOOF-2/R2 (existing frozen form): forged human authority reference.
  const src = rec.authoritySource;
  if (!HUMAN_AUTHORITY_SOURCES.includes(src) || typeof rec.identity !== "string" || !/^[0-9a-f]{64}$/.test(rec.identity)) {
    return verdict("REJECT", WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_FORGED, "HUMAN_AUTHORITY_REFERENCE_FORGED", {
      iRow: "I9", fence: "F7", resolutionRow: "R9",
      detail: "human authority reference forged/malformed — no transition",
    });
  }
  // Binding: SAME recordId + generation (existing frozen forms — SPOOF-3/R3
  // foreign; SPOOF-4/R4 & DBL-4/DBL-5 stale pair).
  if (rec.recordId !== intent?.recordId) {
    return verdict("REJECT", LIFECYCLE_FINE_CODES.WRONG_GENERATION, "ADMISSION_BINDING_MISMATCH", {
      iRow: "I9", fence: "F7", resolutionRow: "R5",
      detail: "admission record binds a different recordId (foreign admission)",
    });
  }
  if (rec.generation !== intent?.generation) {
    return verdict("REJECT", LIFECYCLE_FINE_CODES.WRONG_GENERATION, "ADMISSION_GENERATION_MISMATCH", {
      iRow: "I9", fence: "F7", resolutionRow: "R6",
      detail: "admission record bound to a superseded generation (stale pair rejected)",
    });
  }
  // AMENDMENT 1 — RESOLUTION PROOF REQUIRED (frozen amended-F7 row 1). A
  // well-formed presented reference is NOT authority: admission resolves
  // ONLY through a VALID journal-derived proof (R-RES-1/R-RES-9). The
  // canonical producer is the READING layer (N3::resolveHumanAdmissionReference,
  // attached as intent.resolutionEvidence — the gate seam derives and
  // attaches it, overwriting any caller-supplied value).
  const ev = intent?.resolutionEvidence;
  if (ev == null) {
    return verdict("REJECT", LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT, "ADMISSION_RESOLUTION_UNPROVEN", {
      iRow: "I9", fence: "F7", resolutionRow: "R1",
      detail: "durable resolution proof missing — a presented admission reference resolves ONLY through a journal-derived proof (AMENDMENT-1 R-RES-1/R-RES-9)",
    });
  }
  if (typeof ev !== "object" || ev.valid !== true) {
    return resolveFailureVerdict(ev);
  }
  const proof = ev.proof;
  // A valid fact carries the journal-derived fact-set; a proof-shaped object
  // without the reading layer's derivation shape is an unattested claim
  // (row 9 — the forged/malformed family).
  if (proof == null || typeof proof !== "object"
    || proof.claimSource !== "JOURNAL_PROJECTION"
    || proof.chainVerified !== true
    || !Number.isInteger(proof.journalSequence)
    || typeof proof.eventDigest !== "string"
    || proof.mintPath !== rec.mintPath) {
    return verdict("REJECT", WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_MALFORMED, "RESOLUTION_PROOF_MALFORMED", {
      iRow: "I9", fence: "F7", resolutionRow: "R9",
      detail: "resolution evidence is not a valid journal-derived fact-set (unattested proof-shaped claim) — no transition",
    });
  }
  // Fact-set binding: the journaled record the proof derives from must bind
  // THIS recordId + generation (rows 5/6 — the binding-mismatch family).
  if (proof.recordId !== intent?.recordId) {
    return verdict("REJECT", LIFECYCLE_FINE_CODES.WRONG_GENERATION, "ADMISSION_RESOLUTION_RECORD_MISMATCH", {
      iRow: "I9", fence: "F7", resolutionRow: "R5",
      detail: "resolution proof binds a different recordId — cross-record proof reuse is impossible",
    });
  }
  if (proof.generation !== intent?.generation) {
    return verdict("REJECT", LIFECYCLE_FINE_CODES.WRONG_GENERATION, "ADMISSION_RESOLUTION_GENERATION_MISMATCH", {
      iRow: "I9", fence: "F7", resolutionRow: "R6",
      detail: "resolution proof binds a different generation — cross-generation proof reuse is impossible",
    });
  }
  // Fact-set agreement: the presented reference must be the JOURNALED record
  // (identity + authoritySource — disagreement ⇒ forged/unattested, row 9).
  if (proof.identity !== rec.identity || proof.authoritySource !== rec.authoritySource) {
    return verdict("REJECT", WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_FORGED, "HUMAN_AUTHORITY_REFERENCE_FORGED", {
      iRow: "I9", fence: "F7", resolutionRow: "R9",
      detail: "presented reference disagrees with the journaled record's fields — no transition",
    });
  }
  // Presented T12 justification class must agree with the journaled record.
  if (typeof rec.justificationClass === "string" && proof.justificationClass != null && rec.justificationClass !== proof.justificationClass) {
    return verdict("REJECT", LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT, "RESOLUTION_PROOF_MISMATCH", {
      iRow: "I9", fence: "F7", resolutionRow: "R9",
      detail: "presented justification class disagrees with the journaled record — no transition",
    });
  }
  return null;
}

/** Amended-F7 fail-closed dispositions for an INVALID resolution fact (the
 * exact frozen row mapping; OBS02-F7-AMENDMENT.md — every row dies with its
 * frozen class, zero durable effect, no silent absorption). */
function resolveFailureVerdict(ev) {
  const row = typeof ev === "object" ? ev.row : null;
  const reason = typeof ev === "object" ? ev.reason : null;
  switch (row) {
    case "R2": // stale — binding no longer matches the current projection
      return verdict("REJECT", LIFECYCLE_FINE_CODES.WRONG_GENERATION, reason ?? "ADMISSION_RESOLUTION_STALE", {
        iRow: "I9", fence: "F7", resolutionRow: "R2",
        detail: "durable resolution proof is stale — binding no longer matches the journal-derived projection (fail closed)",
      });
    case "R3": // wrong head — journalSequence/eventDigest unresolvable
    case "R4": // wrong event — matched event carries no admission record
      return verdict("REJECT", LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT, reason ?? "ADMISSION_RESOLUTION_UNRESOLVED", {
        iRow: "I9", fence: "F7", resolutionRow: row,
        detail: "durable resolution proof does not resolve in the chain-verified journal — no transition",
      });
    case "R8": // conflicting — journal ambiguity ⇒ HOLD-class fail-closed
      return verdict("HOLD", LIFECYCLE_FINE_CODES.JOURNAL_CHAIN_INVALID, "RECOVERY_REQUIRED", {
        fence: "F0", resolutionRow: "R8",
        detail: reason ?? "conflicting resolution material — reconcile-from-reality; nothing adopted",
      });
    case "R9": // malformed/unattested proof material
      return verdict("REJECT", WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_MALFORMED, reason ?? "RESOLUTION_PROOF_MALFORMED", {
        iRow: "I9", fence: "F7", resolutionRow: "R9",
        detail: "resolution proof malformed/unattested — no transition",
      });
    case "R1": // absence — no matching journaled record ⇒ UNRESOLVED
    default:  // any other invalid shape dies closed (never absorbed)
      return verdict("REJECT", LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT, reason ?? "ADMISSION_RESOLUTION_UNPROVEN", {
        iRow: "I9", fence: "F7", resolutionRow: row ?? "R1",
        detail: "human admission reference is UNRESOLVED against durable journal truth — no transition",
      });
  }
}

// ---------------------------------------------------------------------------
// SPOOF-R5 — incident-layer removal fence (R20; FINE-CODE-CLASS-FREEZE A4.2).
// The incident layer is NEVER removable: the live PATTERN fence prefix is
// consumed verbatim.
// ---------------------------------------------------------------------------
function checkIncidentLayer(intent, projection) {
  if (intent?.targetLayer === "INCIDENT" || projection?.recordLayer === "INCIDENT" || intent?.incidentLayer === true) {
    return verdict("REJECT", `${MEMORY_ERRORS.SCHEMA_INVALID}:pattern_forbidden_incident_layer_field:${intent?.rawField ?? "incident_layer"}`, "INCIDENT_LAYER_NOT_REMOVABLE", {
      iRow: "SPOOF-R5", fence: "F7", detail: "incident-layer records are never removable — incident layer untouched",
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// authorizeLifecycleEvent — THE entry into the transition machinery.
// Fence order F4→F8 (short-circuit on first failure; FAIL-CLOSED-FENCE-ORDER).
// F0 chain integrity / F1 execution identity / F2 subject binding / F3 policy
// projection are input preconditions carried as verified flags (see header).
// Pure: receives journal-derived facts, returns verdicts, writes NOTHING.
// ---------------------------------------------------------------------------
export function authorizeLifecycleEvent(intent, projection, opts = {}) {
  // — input precondition forms (fail closed before any state-dependent verdict) —
  if (intent == null || typeof intent !== "object") {
    return verdict("REJECT", LIFECYCLE_TRANSITION_ILLEGAL, "INTENT_MALFORMED");
  }
  // F1 — execution identity must be bound (binder fail-closed form).
  const exec = intent.executionIdentity;
  if (!exec || typeof exec !== "object" || typeof exec.graphRunId !== "string" || !exec.graphRunId) {
    return verdict("REJECT", WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_MALFORMED, "EXECUTION_IDENTITY_UNBOUND", { fence: "F1" });
  }
  // F2 — subject binding: the record must resolve from durable reality.
  if (!projection?.recordExists || typeof intent?.recordId !== "string" || !intent.recordId) {
    return verdict("REJECT", MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "MISSING_DURABLE_STATE", { fence: "F2" });
  }
  // F3 — policy projection must allow this writeback (never bypassed).
  if (intent.policyAllowed !== true || projection?.policyAllowed !== true) {
    return verdict("REJECT", "POLICY_NOT_ALLOWED", "MEMORY_WRITEBACK_NOT_ALLOWED", { fence: "F3" });
  }

  // F4 — journal reality (I8 seam; also carries the F0 chain flag).
  const f4 = checkF4_journalReality(intent, projection);
  if (f4) return f4;

  // Unregistered kinds REJECT, never default (closed kind set; GATE-SEAM
  // fail-closed form). Checked after F4 so a non-journal claim can never
  // launder an unknown kind into a cleaner error.
  if (!LIFECYCLE_EVENT_KINDS.includes(intent.event)) {
    return verdict("REJECT", LIFECYCLE_TRANSITION_ILLEGAL, "UNREGISTERED_EVENT_KIND", { fence: "F6", event: intent.event });
  }

  // F5 — generation fence (I11 seam).
  const f5 = checkF5_generation(intent, projection);
  if (f5) return f5;

  // Cancellation operation boundary (Layer-2; never a record transition).
  if (intent.event === "OP_CANCEL") return authorizeOpCancel(intent, projection);

  // F6 — legality + terminal (I1–I7 seam).
  const cls = classifyF6(projection.state, intent.event, intent.to ?? null);
  if (!cls.legal) {
    const i = cls.iRow;
    return verdict(i.status ?? "REJECT", i.code ?? LIFECYCLE_TRANSITION_ILLEGAL, i.reason, { iRow: i.id, fence: i.fence, from: projection.state, event: intent.event, to: intent.to ?? null });
  }
  const row = cls.row;

  // SPOOF-R5 incident-layer fence (only ever relevant for REMOVE; runs
  // before element checks per R20 §1 THE EDGE ordering).
  const incident = checkIncidentLayer(intent, projection);
  if (incident) return incident;

  // F7 — element gate + human authority (I9/I10 + R16/R20 seams).
  const f7 = checkF7_elementsAndAuthority(row, intent);
  if (f7) return f7;

  // F8 — terminal-immutability write-seam guard (FAIL-CLOSED-FENCE-ORDER):
  // the verdict's transition must bind the journal-derived projection state —
  // the intent may not claim a different source state than reality (the
  // row's from is projection-derived; an intent whose OWN claimSource state
  // (carried as from-claim) disagrees is silent coercion, caught here).
  if (row.from !== projection.state) {
    return verdict("REJECT", LIFECYCLE_TERMINAL_IMMUTABLE, "V15_RESURRECTION", { iRow: "I7", fence: "F8", detail: "write-seam guard: row/projection drift — verdict must derive from journal reality" });
  }

  return okVerdict(row, { generationAfter: projection.generation });
}

const TERMINAL_CONTINUATIONS = new Set(["DEMOTED->ARCHIVED", "ARCHIVED->REMOVED"]);

// ---------------------------------------------------------------------------
// authorizeOpCancel — the OP_CANCEL operation boundary (Layer-2; CANCELLATION
// §1 data model). A cancel NEVER creates an edge and NEVER bypasses
// authority: it is durably journaled through N2 or it is nothing.
//
// AMENDMENT 2 (OBS-03 — V5-Cancel authority rule; OBS03-V5-AUTHORITY.md
// V5-C1…V5-C5; OBS03-SELF-APPROVAL-PROHIBITION.md): OP_CANCEL_INPUT ≠
// OP_CANCEL_APPROVAL_AUTHORITY. Admission rests ONLY on
// CANCEL_AUTHORITY = PRE_EXISTING_DURABLE_FACTS_ONLY (V5-C2: the F0/F1/F2/
// F4/F5 + ownership facts of the journal prefix BEFORE the cancel event —
// all still enforced on this path: F4 by the authorizeLifecycleEvent input
// preconditions, F5 below, ownership below). The cancel-journaling actor's
// identity (executionIdentity / graphRunId / writerId) is ATTRIBUTION ONLY:
// it is never an admission input (V5-C1 — ACTOR_IDENTITY_CONFERS_CANCEL_
// AUTHORITY = NO), and no field of the cancel request/event may certify
// admissibility (V5-C3 — no self-supplied warrant; SELF_JOURNALING_
// CONFERS_AUTHORITY = NO, while self-journaling through the same V5-C2
// conditions stays LEGAL per V5-C4). A cancel whose only admissibility
// basis is itself ⇒ REJECT (V5-C5, frozen refusal shape:
// WRITEBACK_AUTHORITY_INSUFFICIENT / CANCEL_SELF_APPROVAL_REJECTED) —
// REFUSAL-TO-CONSTRUCT: N2 constructs nothing for this verdict, so no
// partially valid cancellation event can survive a rejection, and the
// writeback-before-authority ordering is structurally unreachable.
// ---------------------------------------------------------------------------
export function authorizeOpCancel(intent, projection) {
  // CANCEL-AFTER-TERMINAL: stable operation-level NO-OP, not an error state.
  if (TERMINAL_STATES.has(projection.state) || projection?.operationTerminal === true) {
    return { ok: true, status: "NO-OP", code: LIFECYCLE_TERMINAL_IMMUTABLE, reason: "CANCEL_AFTER_TERMINAL", layer1: projection.state, layer2: "NO-OP", opBoundary: "OP_CANCEL" };
  }
  // Duplicate cancel (same key) — idempotent NO-OP (DUPLICATE_EVENT_ID class).
  if (projection?.cancelKey === intent?.cancelKey && projection?.cancelKey != null) {
    return { ok: true, status: "NO-OP", code: LIFECYCLE_FINE_CODES.DUPLICATE_EVENT_ID, reason: "DUPLICATE_CANCEL", layer1: projection.state, layer2: "NO-OP", opBoundary: "OP_CANCEL" };
  }
  // Conflicting cancel (different key while one is journaled) — conflict-class
  // NO-OP citing the existing journaled intent (CANCELLATION §3 card §27).
  if (projection?.cancelKey != null && projection.cancelKey !== intent?.cancelKey) {
    return { ok: true, status: "NO-OP", code: LIFECYCLE_FINE_CODES.EVENT_IDEMPOTENCY_CONFLICT, reason: "CONFLICTING_CANCEL", layer1: projection.state, layer2: "NO-OP", opBoundary: "OP_CANCEL", existingCancelKey: projection.cancelKey };
  }
  // V5-Cancel (AMENDMENT 2, V5-C5 — frozen position: after the terminal/
  // duplicate/conflict prongs, alongside F5): a cancel whose only
  // admissibility basis is itself is REFUSED before any event exists.
  // Self-supplied warrant forms (frozen SELF-APPROVED-CANCEL definition
  // a/b/c): the request asserting its own admissibility; the actor's
  // identity as the SOLE basis; a process-memory/provider/session claim.
  // The parameter space has no authority input slot for any of them —
  // admissibility can only PRE-EXIST in durable facts (F0/F1/F2/F4/F5 +
  // ownership RESOLVED, evaluated above/below). CANCELLATION_CREATES_NEW_
  // EDGE = NO: this prong ADDS a fence; it skips none, creates no edge.
  const selfWarrant =
    intent?.selfApproval === true
    || intent?.selfAuthorized === true
    || intent?.cancelAdmissible === true
    || intent?.selfCertified === true
    || (intent?.executionIdentity?.selfAuthored === true)
    || intent?.actorApproved === true
    || intent?.actorAssertedAdmissible === true
    || intent?.memoryAuthorized === true
    || intent?.providerAuthorized === true
    || intent?.harnessAuthorized === true
    || intent?.sessionAuthorized === true;
  if (selfWarrant) {
    return verdict("REJECT", LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT, "CANCEL_SELF_APPROVAL_REJECTED", {
      fence: "F7", v5: "V5-C5", opBoundary: "OP_CANCEL",
      detail: "a cancellation request/event is not its own approval authority (OP_CANCEL_INPUT ≠ OP_CANCEL_APPROVAL_AUTHORITY) — refusal-to-construct; zero durable effect",
    });
  }
  // Ownership: a cancel execution bound to a stale generation may not act
  // (GENERATION STALE CANCEL); wrong owner ⇒ HOLD/REJECT like any write.
  const f5 = checkF5_generation(intent, projection);
  if (f5) return { ...f5, opBoundary: "OP_CANCEL" };
  if (intent?.ownershipVerdict === "AMBIGUOUS") {
    return verdict("HOLD", LIFECYCLE_FINE_CODES.OWNERSHIP_AMBIGUOUS, "PROCESS_OWNERSHIP_AMBIGUOUS", { opBoundary: "OP_CANCEL" });
  }
  return { ok: true, status: "APPLIED", code: null, reason: "CANCEL_INTENT_DURABLE", layer1: projection.state, layer2: "APPLIED", opBoundary: "OP_CANCEL", transition: { id: "OP_CANCEL", from: projection.state, event: "OP_CANCEL", to: projection.state, authority: "OPERATION_BOUNDARY" } };
}

// ---------------------------------------------------------------------------
// Allowed-continuation sets (RESUME-ALGORITHM step 6) — the frozen edges from
// a state that hold their elements; empty/ambiguous ⇒ HOLD upstream.
// ---------------------------------------------------------------------------
export function allowedContinuations(state) {
  return LEGAL_TRANSITIONS.filter((t) => t.from === state).map((t) => ({ id: t.id, event: t.event, to: t.to }));
}

export function isLegalTransitionRow(id) {
  return LEGAL_TRANSITIONS.some((t) => t.id === id);
}

// Matrix totality helper (ladder 1): every (state, kind) pair resolves to
// exactly one sealed class — a LEGAL T-row, an ILLEGAL I-row, or (for the
// operation-boundary kind OP_CANCEL — CANCELLATION §1: Layer-2 operation
// boundary, never a record transition) OP_BOUNDARY. One oracle per cell.
export function resolveMatrixCell(state, event) {
  const legal = LEGAL_TRANSITIONS.filter((t) => t.from === state && t.event === event);
  if (legal.length === 1) return { kind: "LEGAL", row: legal[0] };
  if (event === "OP_CANCEL") return { kind: "OP_BOUNDARY", owner: "authorizeOpCancel" };
  const cls = classifyF6(state, event, null);
  return { kind: "ILLEGAL", iRow: cls.iRow ?? { id: "I-F6", fence: "F6" } };
}

// Anti-self-review / anti-mint structural exports (RRC/DBL-1 diff oracle).
export const LIFECYCLE_MODULE_LAW = Object.freeze({
  WRITES: false,          // N1 NEVER WRITES (module map: DECIDES, NEVER WRITES)
  MINTS_ADMISSIONS: false // no admission-record minting code exists here
});
