// test/learning/lifecycle/helpers.mjs
//
// RUNG-6 lifecycle test fixtures. Fixtures are journal-derived-projection
// shaped (claimSource: "JOURNAL_PROJECTION") — process memory is never
// authority; the fixtures merely hand N1 the facts a chain-verified read
// would produce. All helpers are TEST-ONLY (no production module imports
// these files).

import { createHash } from "node:crypto";
import { appendJournalEvent, readJournal } from "../../../src/memory/jsonl-journal.mjs";
import { resolveHumanAdmissionReference } from "../../../src/learning/lifecycle/resume-recovery.mjs";

export const REPO = "1".repeat(64);
export const hex64 = (n = 1) => createHash("sha256").update(String(n)).digest("hex");

/** A journal-derived projection for a pattern record in `state`. */
export function projection(o = {}) {
  return {
    claimSource: "JOURNAL_PROJECTION",
    chainVerified: true,
    recordExists: true,
    recordId: o.recordId ?? "pat-lifecycle-1",
    recordLayer: "PATTERN",
    state: o.state ?? "CANDIDATE",
    generation: o.generation ?? 1,
    lastSequence: o.lastSequence ?? 0,
    previousDigest: o.previousDigest ?? null,
    policyAllowed: o.policyAllowed ?? true,
    ...(o.cancelKey !== undefined ? { cancelKey: o.cancelKey } : {}),
    ...(o.operationTerminal ? { operationTerminal: true } : {}),
    ...o.overrides,
  };
}

/**
 * AMENDMENT-1 (OBS-02) test-side admission-resolution oracle.
 *
 * The ONLY legitimate way a presented human admission reference becomes
 * check-authoritative is through a DURABLE RESOLUTION PROOF derived by the
 * READING layer (N3::resolveHumanAdmissionReference) from a chain-verified
 * journal read. Production callers attach that fact as
 * `intent.resolutionEvidence` (the gate seam derives and attaches it);
 * fixtures attach it the same way.
 *
 * TEST-ONLY mirrors (never imported by production code):
 *   journalAdmissionEvidence(journalPath, presentedRecord, intent, {append})
 *     → the REAL reading-layer derivation over a real journal file (the
 *       honest path — used wherever a suite proves the APPLIED configuration;
 *       { append: true } lands the record as journal truth first, mirroring
 *       the human CBM-4 gate path);
 *   flagResolvedEvidence(presentedRecord)
 *     → a caller-authored pseudo-fact ({ valid: true, proof: … }) whose
 *       "proof" carries no reading-layer derivation — the pre-amendment
 *       `journalResolved: true` shape, kept for proving it now DIES
 *       (A1-T1/A1-T9 attack fixtures).
 */
export function journalAdmissionEvidence(journalPath, presentedRecord, intent, { append } = {}) {
  if (append) {
    // F4 INPUT RULE: the append state comes from a chain-verified read of the
    // journal — never from a default/assumed head (a stale state would append
    // a duplicate sequence and poison the chain).
    const head = readJournal(journalPath).state;
    appendJournalEvent({
      journalPath,
      state: { lastSequence: head.lastSequence, previousDigest: head.previousDigest },
      operation: "UPSERT_RECORD",
      recordId: `admission-${String(presentedRecord?.identity ?? "x").slice(0, 8)}`,
      payload: { record: presentedRecord },
    });
  }
  return resolveHumanAdmissionReference(journalPath, presentedRecord, intent);
}

/** A valid journal-derived intent for T1 (CANDIDATE→ADVISORY). */
export function t1Intent(o = {}) {
  return {
    claimSource: "JOURNAL_PROJECTION",
    recordId: o.recordId ?? "pat-lifecycle-1",
    event: o.event ?? "PROMOTE",
    to: o.to ?? null,
    generation: o.generation ?? 1,
    policyAllowed: true,
    executionIdentity: { graphRunId: o.graphRunId ?? "graph-run-1", task: "task-1", attempt: 1, selfAuthored: false },
    selfApproval: false,
    elements: {
      E1: { incidents: [hex64(11)], rationale: "multiple qualified incidents" },
      E2: { identity: hex64(12), independent: true },
      E3: { boundary: "PATH_PREFIX:/src" },
      E4: { analysis: "false-positive rate measured" },
      E5: { benefit: "transfer measured on 3 tasks" },
      E6: { path: "demote/archive rollback path" },
      E7: true,
      ...(o.elements ?? {}),
    },
    ...(o.extra ?? {}),
  };
}

/** Promotion intent with the full legal element set for its row. */
export function promoteIntent(fromState, extraElements = {}, o = {}) {
  const base = t1Intent(o);
  if (fromState === "ADVISORY" || fromState === "REQUIRED_QUESTION") {
    base.elements.E8 = { usageRecorded: true, escapeEvidence: { digest: hex64(21) } };
  }
  if (fromState === "REQUIRED_QUESTION") {
    base.elements.E9 = humanAdmissionRecord(o.admissionOverrides ?? {});
  }
  return { ...base, ...Object.fromEntries(Object.entries(o).filter(([k]) => !["elements", "admissionOverrides"].includes(k))), elements: { ...base.elements, ...extraElements } };
}

/** A well-formed HUMAN-minted admission record (journal-resolvable).
 * AMENDMENT-1 note: `journalResolved` remains as a PRESENTATION HINT only
 * (R-RES-4: zero check authority — the check consumes the derived proof). */
export function humanAdmissionRecord(o = {}) {
  return {
    identity: o.identity ?? hex64(31),
    mintPath: "HUMAN_CBM4_GATE",
    journalResolved: true,
    authoritySource: o.authoritySource ?? "HUMAN",
    recordId: o.recordId ?? "pat-lifecycle-1",
    generation: o.generation ?? 1,
    justificationClass: o.justificationClass ?? "SECURITY_SECRET_SCAN",
    timestamp: "2026-09-09T00:00:00.000Z",
    ...o.extra,
  };
}

/**
 * A1 attack fixture — a caller-authored pseudo-fact: proof-SHAPED but with
 * NO reading-layer derivation behind it (the pre-amendment
 * `journalResolved: true` presentation shape). N1 must reject it.
 */
export function flagResolvedEvidence(presentedRecord) {
  return {
    valid: true,
    presentedRecord,
    proof: {
      claimSource: "CALLER",
      chainVerified: false,
      journalSequence: presentedRecord?.journalSequence ?? null,
      eventDigest: presentedRecord?.eventDigest ?? null,
      identity: presentedRecord?.identity ?? null,
      recordId: presentedRecord?.recordId ?? null,
      generation: presentedRecord?.generation ?? null,
      mintPath: presentedRecord?.mintPath ?? null,
      authoritySource: presentedRecord?.authoritySource ?? null,
      justificationClass: presentedRecord?.justificationClass ?? null,
    },
  };
}

/** A T12 removal intent (ARCHIVED→REMOVED, human authority). */
export function t12Intent(o = {}) {
  return {
    claimSource: "JOURNAL_PROJECTION",
    recordId: o.recordId ?? "pat-lifecycle-1",
    event: "REMOVE",
    to: "REMOVED",
    generation: o.generation ?? 1,
    policyAllowed: true,
    executionIdentity: { graphRunId: o.graphRunId ?? "graph-run-r20", task: "task-r20", attempt: 1, selfAuthored: false },
    targetLayer: "PATTERN",
    elements: {
      HUMAN_ADMISSION: humanAdmissionRecord(o.admissionOverrides ?? {}),
    },
    ...(o.extra ?? {}),
  };
}

/** A demote intent with cause evidence (T4/T5/T6). */
export function demoteIntent(fromState, o = {}) {
  return {
    claimSource: "JOURNAL_PROJECTION",
    recordId: "pat-lifecycle-1",
    event: "DEMOTE",
    to: "DEMOTED",
    generation: o.generation ?? 1,
    policyAllowed: true,
    executionIdentity: { graphRunId: "graph-run-demote", task: "task-demote", attempt: 1, selfAuthored: false },
    elements: { CAUSE: { causeClass: o.causeClass ?? "FALSE_POSITIVE", source: "R9" } },
    ...(o.extra ?? {}),
  };
}

/** An archive intent with supersession evidence (T7–T11). */
export function archiveIntent(o = {}) {
  return {
    claimSource: "JOURNAL_PROJECTION",
    recordId: "pat-lifecycle-1",
    event: "ARCHIVE",
    to: "ARCHIVED",
    generation: o.generation ?? 1,
    policyAllowed: true,
    executionIdentity: { graphRunId: "graph-run-archive", task: "task-archive", attempt: 1, selfAuthored: false },
    elements: { SUPERSESSION: { supersededBy: hex64(41), reason: "retired" } },
    ...(o.extra ?? {}),
  };
}

export const LIFECYCLE_STATES = ["CANDIDATE", "ADVISORY", "REQUIRED_QUESTION", "MANDATORY_GATE", "DEMOTED", "ARCHIVED", "REMOVED"];
export const EVENT_KINDS = ["PROMOTE", "DEMOTE", "ARCHIVE", "REMOVE", "OP_CANCEL"];
