// src/learning/lifecycle/resume-recovery.mjs
//
// STAGE-F LIFECYCLE — N3 REALITY READER / RECOVERY ORCHESTRATION.
//
// Authority chain:
//   SPEC-1 RESUME-ALGORITHM.md    (the frozen §12 7-step algorithm: each step
//                                  INPUT / OWNER / FAILURE / NEXT STEP)
//   SPEC-1 CRASH-MATRIX.md        (C1–C5; disposition ∈ {RECOVERABLE, RESOLVED,
//                                  HOLD}; CRASH_RESOLUTION_INPUTS = { journal
//                                  bytes, digest chain, event identity })
//   SPEC-1 OWNERSHIP.md           (ownership = journaled attribution; RESOLVED
//                                  or HOLD; no takeover / LWW / liveness)
//   SPEC-1 HARNESS-INDEPENDENCE.md (session/container/provider/checkpoint IDs
//                                  are NEVER identity/authority inputs)
//   PLAN-1 MODULE-RESPONSIBILITY-MAP.md N3 row (reads reality, writes only via
//                                  N2; no lock; ambiguity ⇒ HOLD)
//
// FENCES: F0 chain integrity FIRST (assertChainIntegrity) → F1 execution
// identity (durable bindings compared per IdentityBinder rules) → F2 subject
// binding (record resolves in the journal projection). Ownership at resume
// step 5 = journaled attribution vs claimant comparison + generation fencing.
// RESUME prohibitions are structural: this module takes NO process-memory,
// executor-callback, harness-checkpoint, or provider-run-state input.

import { assertChainIntegrity, JournalError } from "../../memory/jsonl-journal.mjs";
import { MEMORY_ERRORS } from "../../memory/validation.mjs";
import { WRITEBACK_TRUST_HOLD } from "../../memory/writeback/trust.mjs";
import {
  LIFECYCLE_FINE_CODES, HUMAN_AUTHORITY_SOURCES, allowedContinuations, isLegalTransitionRow,
} from "./state-machine.mjs";
import { applyLifecycleEventToProjection } from "./event-journal.mjs";

// Dispositions are CLOSED (CRASH-MATRIX footer): nothing else may be returned.
export const RECOVERY_DISPOSITIONS = Object.freeze(["RECOVERABLE", "RESOLVED", "HOLD"]);
// Ownership outcome space is CLOSED (OWNERSHIP §OUTCOME SPACE).
export const OWNERSHIP_OUTCOMES = Object.freeze(["RESOLVED", "HOLD"]);

function hold(code, reason, extra = {}) {
  return { ok: false, status: "HOLD", code, reason, disposition: "HOLD", ...extra };
}
function reject(code, reason, extra = {}) {
  return { ok: false, status: "REJECT", code, reason, ...extra };
}

// ---------------------------------------------------------------------------
// STEP 1 — READ DURABLE AUTHORITY. Chain verified BEFORE any state adopted.
// Partial trailing line = torn view ⇒ HOLD (RECOVERY_REQUIRED) — the exclusion
// rule keeps the chain prefix readable but a resume must not adopt a torn view
// without reconciliation (AMBIGUITY LAW).
// ---------------------------------------------------------------------------
export function readDurableAuthority(journalPath) {
  let r;
  try {
    r = assertChainIntegrity(journalPath); // F0 — throws JOURNAL_CHAIN_INVALID
  } catch (e) {
    if (e instanceof JournalError) {
      return hold(MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "RECOVERY_REQUIRED", { detail: String(e.message).slice(0, 200) });
    }
    throw e;
  }
  if (r.partialTrailingLine) {
    return hold(MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "RECOVERY_REQUIRED", { detail: "torn view: partial trailing line — reconcile-first" });
  }
  return { ok: true, status: "READ", events: r.events, lastSequence: r.state.lastSequence, previousDigest: r.state.previousDigest };
}

// ---------------------------------------------------------------------------
// STEP 2 — VERIFY EXECUTION IDENTITY. The claimant presents DURABLE bindings
// only (graphRunId + task/admission/attempt). Session IDs, container IDs,
// provider run IDs, and harness checkpoints are NOT accepted inputs (they are
// structurally incapable of reaching this function: the claimant shape has no
// such fields, and any such field present is a forged-identity REJECT).
// IdentityBinder rule classes consumed verbatim (transfer-metrics/identities).
// ---------------------------------------------------------------------------
export function verifyExecutionIdentity({ claimant, journalEvents }) {
  // forged identity classes first (RESUME-ALGORITHM step 2 failure column)
  const nonDurable = ["sessionId", "containerId", "providerRunId", "harnessCheckpointId", "session_id", "container_id", "provider_run_id", "checkpoint_id"];
  const present = nonDurable.filter((k) => claimant?.[k] != null);
  if (present.length > 0) {
    return reject(WRITEBACK_IDENTITY_FORGED, `EVIDENCE_IDENTITY_FORGED:non-durable identity inputs present (${present.join(",")}) — harness-independence fence`);
  }
  if (!claimant || typeof claimant.graphRunId !== "string" || !claimant.graphRunId) {
    return reject(WRITEBACK_IDENTITY_MALFORMED, "EVIDENCE_IDENTITY_MALFORMED:graphRunId binding missing");
  }
  // Attribution comparison target: the durable prefix's journaled writers.
  const writers = new Set();
  for (const ev of journalEvents ?? []) {
    const w = ev?.payload?.executedBy;
    if (w?.writerId) writers.add(w.writerId);
  }
  // No journaled writer (empty prefix / C5): identity is verified against the
  // claimant's own durable bindings alone — nothing to compare against yet.
  if (writers.size === 0) return { ok: true, status: "VERIFIED", reason: null, comparedAgainst: [] };
  // TASK/ATTEMPT binding: every journaled writer event for this claimant's
  // graph must bind the same task binding the claimant presents (ADMISSION_
  // DRIFT fail-closed class when a frozen binding disagrees).
  const bindMismatch = [];
  for (const ev of journalEvents ?? []) {
    const p = ev?.payload ?? {};
    if (p?.executedBy?.writerId == null) continue;
    if (p?.executedBy?.writerId === claimant.graphRunId) continue;
    bindMismatch.push(p.executedBy.writerId);
  }
  if (bindMismatch.length > 0) {
    // A DIFFERENT writer owns the durable prefix — ownership step decides.
    return { ok: true, status: "VERIFIED_CLAIMANT", reason: null, comparedAgainst: [...writers], foreignWriters: bindMismatch };
  }
  return { ok: true, status: "VERIFIED", reason: null, comparedAgainst: [...writers] };
}

const WRITEBACK_IDENTITY_FORGED = WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_FORGED;
const WRITEBACK_IDENTITY_MALFORMED = WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_MALFORMED;

// ---------------------------------------------------------------------------
// STEP 3 — VERIFY GENERATION (delegated fence F5 semantics over durable
// fields; ambiguous reality ⇒ HOLD, stale ⇒ REJECT WRONG_GENERATION).
// ---------------------------------------------------------------------------
export function verifyGeneration({ intentGeneration, durableGeneration }) {
  if (!Number.isInteger(intentGeneration) || !Number.isInteger(durableGeneration)) {
    return hold(MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, "RECOVERY_REQUIRED", { detail: "generation reality ambiguous — re-read from journal" });
  }
  if (intentGeneration !== durableGeneration) {
    return reject(LIFECYCLE_FINE_CODES.WRONG_GENERATION, "GENERATION_MISMATCH", { detail: `intent generation ${intentGeneration} != durable generation ${durableGeneration}` });
  }
  return { ok: true, status: "VERIFIED", generation: durableGeneration };
}

// ---------------------------------------------------------------------------
// STEP 4 — VERIFY TERMINAL STATE (F6 terminal fence over the reconstructed
// state; terminal ⇒ LIFECYCLE_TERMINAL_IMMUTABLE for any active continuation;
// frozen out-edges only: DEMOTED/ARCHIVED have their legal edges, REMOVED none).
// ---------------------------------------------------------------------------
export function verifyTerminalState(reconstructedState) {
  if (reconstructedState === "REMOVED") {
    return reject(LIFECYCLE_FINE_CODES.TERMINAL_IMMUTABLE, "V15_RESURRECTION", { allowedContinuations: [] });
  }
  return { ok: true, status: "ACTIVE_OR_SETTLED", state: reconstructedState, allowedContinuations: allowedContinuations(reconstructedState) };
}

// ---------------------------------------------------------------------------
// STEP 5 — VERIFY OWNERSHIP. Journaled attribution vs claimant identity +
// generation. Outcome space CLOSED: RESOLVED or HOLD (PROCESS_OWNERSHIP_
// AMBIGUOUS). No takeover, no last-writer-wins, no liveness authority.
// ---------------------------------------------------------------------------
export function verifyOwnership({ claimant, journalEvents, durableGeneration }) {
  const writers = new Set();
  for (const ev of journalEvents ?? []) {
    const w = ev?.payload?.executedBy;
    if (w?.writerId != null) writers.add(w.writerId);
  }
  // No journaled attribution (C5/empty prefix): ownership is trivially
  // RESOLVED to the first legal writer; nothing is adopted from anyone.
  if (writers.size === 0) {
    return { ok: true, status: "RESOLVED", outcome: "RESOLVED", reason: "no journaled attribution — first legal writer" };
  }
  const soleWriter = writers.size === 1 ? [...writers][0] : null;
  if (soleWriter === claimant?.graphRunId) {
    // Same durable identity: generation must bind (stale ⇒ REJECT/HOLD per
    // GENERATION; the stale claimant's only legal action = re-read + restart).
    if (Number.isInteger(claimant?.generation) && Number.isInteger(durableGeneration) && claimant.generation !== durableGeneration) {
      return reject(LIFECYCLE_FINE_CODES.WRONG_GENERATION, "STALE_CLAIMANT", { detail: `claimant generation ${claimant.generation} != durable ${durableGeneration} — re-derive from reality` });
    }
    return { ok: true, status: "RESOLVED", outcome: "RESOLVED", reason: "journaled attribution matches claimant" };
  }
  // Different writer over the same durable prefix: conflict detected —
  // NEVER implicit takeover; ambiguity ⇒ HOLD for human/admitted re-derivation.
  if (writers.size > 1) {
    return hold(LIFECYCLE_FINE_CODES.OWNERSHIP_AMBIGUOUS, "PROCESS_OWNERSHIP_AMBIGUOUS", { detail: `multiple journaled writers over the same prefix: ${[...writers].sort().join(",")}` });
  }
  return hold(LIFECYCLE_FINE_CODES.OWNERSHIP_AMBIGUOUS, "PROCESS_OWNERSHIP_AMBIGUOUS", { detail: `journaled writer ${soleWriter} != claimant ${claimant?.graphRunId ?? "(none)"} — no takeover; re-derive` });
}

// ---------------------------------------------------------------------------
// STEP 6 — RECONSTRUCT LEGAL CONTINUATION (frozen edges from the current
// state). Empty set at a non-terminal state = resume ambiguity ⇒ HOLD.
// ---------------------------------------------------------------------------
export function reconstructLegalContinuation(reconstructedState) {
  const cont = allowedContinuations(reconstructedState);
  if (cont.length === 0 && reconstructedState !== "REMOVED") {
    return hold(LIFECYCLE_FINE_CODES.OWNERSHIP_AMBIGUOUS, "PROCESS_OWNERSHIP_AMBIGUOUS", { detail: `empty continuation set at ${reconstructedState} — resume ambiguity` });
  }
  return { ok: true, status: "RECONSTRUCTED", allowedContinuations: cont };
}

// ---------------------------------------------------------------------------
// Replay reconstruction: chain-valid prefix → record-state projection.
// Deterministic; never re-removes, never re-mints, never resurrects
// (REPLAY LAW). Ghost rows are impossible here by chain validation (a ghost
// row ⇒ JOURNAL_CHAIN_INVALID fail-closed at F0/assertChainIntegrity).
// ---------------------------------------------------------------------------
export function reconstructRecordState(journalPath, { recordId } = {}) {
  const step1 = readDurableAuthority(journalPath);
  if (!step1.ok) return step1; // HOLD (torn/invalid) — nothing adopted
  let projection = { claimSource: "JOURNAL_PROJECTION", chainVerified: true, recordExists: false, state: "CANDIDATE", generation: null };
  let events = 0;
  for (const ev of step1.events) {
    if (ev.operation !== "LIFECYCLE_EVENT") continue;
    const p = ev.payload ?? {};
    if (recordId != null && p.recordId !== recordId) continue;
    projection = applyLifecycleEventToProjection(projection, ev);
    projection.recordExists = true;
    events += 1;
  }
  return { ok: true, status: "RECONSTRUCTED", projection, lifecycleEventCount: events, lastSequence: step1.lastSequence };
}

// ---------------------------------------------------------------------------
// DURABLE RESOLUTION AUTHORITY (AMENDMENT 1 / OBS-02 — NORMATIVE-AMENDMENT-
// TEXT.md R-RES-1…R-RES-9; OBS02-DURABLE-RESOLUTION-AUTHORITY.md §1/§2).
//
// resolveHumanAdmissionReference is the READING-LAYER ADMISSION-RESOLVING
// READ: an independent re-derivation of "does the presented human admission
// reference exist as DURABLE JOURNAL TRUTH?" from the chain-verified journal
// projection — the same N3 chain-verified read discipline that produces
// chainVerified/recordExists/policyAllowed (R-RES-5: N1 stays PURE; the
// resolving read never moves into N1).
//
// The proof is DERIVED here, from journal bytes, on every call: no proof is
// minted, cached-as-authority, persisted separately, or accepted from the
// caller (R-RES-6). PROOF VALIDITY (R-RES-3) is enforced over the RE-DERIVED
// fact-set: the presented reference's material fields must agree with the
// journaled record's fields — a presented `journalResolved: true` flag (or
// any caller-supplied substitute) has ZERO check authority (R-RES-4:
// CALLER_journalResolved_AUTHORITY = NO; the field is not even read here).
//
// Deterministic: identical journal prefix ⇒ identical proof/invalid result
// (RESOLUTION_AFTER_RESTART = DETERMINISTIC; RESOLUTION_AFTER_REPLAY =
// DETERMINISTIC). No new store, no new authority domain: the journal is the
// only source (AUTHORITY SOURCE = layer 2).
//
// Proof fields (R-RES-2 fact-set): claimSource, chainVerified,
// journalSequence, eventDigest, and the matched journaled record fields
// (identity, recordId, generation, authoritySource, mintPath,
// justificationClass, timestamp). An INVALID result carries no proof fields
// (fail closed; zero authority leaks out of an invalid read).
//
// Failure classes are the FROZEN AMENDED-F7 rows (OBS02-F7-AMENDMENT.md
// table, exact numbering); they are carried as machine-readable `row` labels
// for the CHECK's dying oracle. The CHECK (N1::checkHumanAdmissionRecord)
// still owns the verdict; N3 only derives the fact. Row labels:
//   R1 missing proof        (no journaled record binds the triple)
//   R2 stale proof          (binding no longer matches — generation divergence)
//   R3 wrong head           (journalSequence/eventDigest unresolvable in the
//                            current chain-verified projection)
//   R4 wrong event          (matched journal event carries no admission record)
//   R5 wrong recordId       (journaled record binds a different subject)
//   R6 wrong generation     (journaled generation ≠ intent.generation)
//   R7 replayed proof       (exactly-once/second-mint question — answered by
//                            the transition layer's exactly-once keys, not by
//                            this read; therefore never returned here)
//   R8 conflicting proof    (same identity triple, divergent material content,
//                            or an unverifiable journal ⇒ JOURNAL_CHAIN_INVALID
//                            ⇒ RECOVERY_REQUIRED — the HOLD-class row)
//   R9 malformed proof      (malformed/mismatched presented proof material —
//                            unattested claim; forged/malformed family)
// ---------------------------------------------------------------------------
export function resolveHumanAdmissionReference(journalPath, presentedRecord, intent = {}) {
  if (presentedRecord == null || typeof presentedRecord !== "object") {
    return { valid: false, row: "R9", reason: "RESOLUTION_PROOF_MALFORMED" };
  }
  // STEP 1 — chain-verified read FIRST (the F0 discipline; N3 step-1 law).
  const step1 = readDurableAuthority(journalPath);
  if (!step1.ok) {
    // Journal unreadable/torn ⇒ reality ambiguous ⇒ HOLD-class fact
    // (JOURNAL_CHAIN_INVALID ⇒ RECOVERY_REQUIRED); the CHECK fails closed.
    return { valid: false, row: "R8", reason: "RESOLUTION_JOURNAL_UNVERIFIED", detail: step1.reason ?? "journal chain not verified" };
  }  const seq = step1.lastSequence;
  const headDigest = step1.previousDigest;
  // STEP 2 — re-derive the journaled admission-record fact-set: find the
  // UPSERT_RECORD record whose identity matches the presented reference, and
  // reconcile every journaled record on the triple (R-RES-8 CONFLICT law).
  const presentedIdentity = presentedRecord.identity;
  const match = { seq: null, digest: null, record: null };
  const triple = new Map(); // identity|recordId|generation → record (first wins; divergence ⇒ conflict)
  for (const ev of step1.events) {
    if (ev.operation !== "UPSERT_RECORD") continue;
    const rec = ev.payload?.record ?? null;
    if (rec == null || typeof rec !== "object") continue;
    const recIdentity = rec.identity ?? null;
    if (recIdentity != null && presentedIdentity != null && recIdentity === presentedIdentity) {
      // wrong-head detection: the presented proof material cites a position
      // that does not exist in the current chain (or a duplicate seq).
      if (presentedRecord.journalSequence != null) {
        if (presentedRecord.journalSequence !== ev.journalSequence) {
          return { valid: false, row: "R3", reason: "RESOLUTION_WRONG_HEAD" };
        }
      }
      if (presentedRecord.eventDigest != null && presentedRecord.eventDigest !== ev.eventDigest) {
        return { valid: false, row: "R3", reason: "RESOLUTION_WRONG_HEAD" };
      }
      if (match.seq == null) {
        match.seq = ev.journalSequence;
        match.digest = ev.eventDigest;
        match.record = rec;
      }
    }
    const key = `${recIdentity ?? ""}|${rec.recordId ?? ""}|${rec.generation ?? ""}`;
    const prev = triple.get(key);
    if (prev != null && canonicalRecordMaterial(prev) !== canonicalRecordMaterial(rec)) {
      return { valid: false, row: "R8", reason: "RESOLUTION_CONFLICT_RECOVERY_REQUIRED" };
    }
    if (prev == null) triple.set(key, rec);
  }
  if (match.seq == null || match.record == null) {
    // ABSENCE RULE (R-RES-9): no matching journaled record ⇒ UNRESOLVED.
    return { valid: false, row: "R1", reason: "ADMISSION_RESOLUTION_UNPROVEN" };
  }
  const journaled = match.record;
  // STEP 3 — PROOF VALIDITY (R-RES-3): the presented reference's material
  // fields must agree with the JOURNALED record's fields.
  // mintPath: the record must be human-minted through the frozen gate path.
  if (journaled.mintPath !== "HUMAN_CBM4_GATE") {
    return { valid: false, row: "R4", reason: "RESOLUTION_WRONG_EVENT" };
  }
  if (presentedRecord.mintPath !== journaled.mintPath) {
    return { valid: false, row: "R9", reason: "RESOLUTION_PROOF_MISMATCH" };
  }
  // authoritySource: journaled value must be a human/CONTROLLER value, and
  // the presented value must agree with the journaled value.
  if (!HUMAN_AUTHORITY_SOURCES.includes(journaled.authoritySource) || presentedRecord.authoritySource !== journaled.authoritySource) {
    return { valid: false, row: "R9", reason: "RESOLUTION_PROOF_MISMATCH" };
  }
  // identity: presented identity must be a well-formed human identity string
  // agreeing with the journaled record.
  if (typeof presentedRecord.identity !== "string" || !/^[0-9a-f]{64}$/.test(presentedRecord.identity) || presentedRecord.identity !== journaled.identity) {
    return { valid: false, row: "R9", reason: "RESOLUTION_PROOF_MISMATCH" };
  }
  // justificationClass where required (T12 rows): present + agreeing.
  if (intent.requiresJustification === true) {
    if (journaled.justificationClass == null || presentedRecord.justificationClass !== journaled.justificationClass) {
      return { valid: false, row: "R9", reason: "RESOLUTION_PROOF_MISMATCH" };
    }
  }
  // STEP 4 — BINDING (the frozen R16 §2/R20 §1 triple): subject recordId +
  // bound generation, from the JOURNALED fields (never the presented ones).
  if (journaled.recordId !== intent.recordId) {
    return { valid: false, row: "R5", reason: "ADMISSION_RESOLUTION_RECORD_MISMATCH" };
  }
  if (journaled.generation !== intent.generation) {
    return { valid: false, row: "R6", reason: "ADMISSION_RESOLUTION_GENERATION_MISMATCH" };
  }
  // VALID PROOF — the journal-derived fact-set (R-RES-2), regenerated from
  // authoritative journal material on every call. NOT persisted anywhere;
  // NOT independently authoritative: it authorizes only by binding, here,
  // now (PROOF SOURCE = CHAIN_VERIFIED_JOURNAL).
  return {
    valid: true,
    row: null,
    reason: null,
    proof: {
      claimSource: "JOURNAL_PROJECTION",
      chainVerified: true,
      journalSequence: match.seq,
      eventDigest: match.digest,
      identity: journaled.identity,
      recordId: journaled.recordId,
      generation: journaled.generation,
      authoritySource: journaled.authoritySource,
      mintPath: journaled.mintPath,
      justificationClass: journaled.justificationClass ?? null,
      timestamp: journaled.timestamp ?? null,
      journalHead: { lastSequence: seq, previousDigest: headDigest },
    },
  };
}

// Material-content digest of a journaled admission record (R-RES-8 conflict
// detection: the FROZEN material field set — two records with the same
// identity triple but divergent material content ⇒ AMBIGUOUS ⇒ HOLD-class).
function canonicalRecordMaterial(rec) {
  const material = {
    identity: rec.identity ?? null,
    recordId: rec.recordId ?? null,
    generation: rec.generation ?? null,
    authoritySource: rec.authoritySource ?? null,
    mintPath: rec.mintPath ?? null,
    justificationClass: rec.justificationClass ?? null,
    timestamp: rec.timestamp ?? null,
  };
  const keys = Object.keys(material).sort();
  return keys.map((k) => `${k}=${String(material[k])}`).join("|");
}

// ---------------------------------------------------------------------------
// Crash-matrix dispositions C1–C5 (CRASH_RESOLUTION_INPUTS = { bytes, chain,
// event identity } ONLY). Outcomes ∈ { RECOVERABLE, RESOLVED, HOLD }.
// ---------------------------------------------------------------------------
export function resolveCrashDisposition({ journalPath, recordId = null, expectEventId = null }) {
  const step1 = readDurableAuthority(journalPath);
  if (!step1.ok) return step1; // torn/invalid view ⇒ HOLD (C1/C2/C3 HOLD forms)
  const events = step1.events.filter((ev) => ev.operation === "LIFECYCLE_EVENT" && (recordId == null || ev.payload?.recordId === recordId));
  if (expectEventId != null) {
    // C3 shape: did the terminal event land?
    const landed = events.find((ev) => ev.payload?.eventId === expectEventId);
    if (landed) return { ok: true, disposition: "RESOLVED", code: null, reason: "event present and chain-valid (retry = identity no-op)", event: landed };
    return { ok: true, disposition: "RESOLVED", code: null, reason: "event absent — state unchanged (retry legal, same identity)" };
  }
  if (events.length === 0) {
    // C5: nothing journaled — no event, no state change, no ownership.
    return { ok: true, disposition: "RESOLVED", code: null, reason: "C5: no durable state — fresh attempt, same logical identity discipline" };
  }
  // C1: chain-valid prefix exists; resumer verifies identity/generation or HOLDs.
  return { ok: true, disposition: "RECOVERABLE", code: null, reason: "C1: chain-valid prefix — continue via the §12 algorithm", events, lastSequence: step1.lastSequence };
}

// ---------------------------------------------------------------------------
// THE §12 RESUME ALGORITHM (steps 1–7, exact order; short-circuit on failure).
// step 7 either continues the allowed continuation (writing NEW journal events
// ONLY through N2) or HOLDs with the exact fail-closed class.
// claimant: { graphRunId, generation?, task? } — DURABLE bindings only.
// continueWith: async ({ intent, verdict, projection }) → N2 write result;
//   supplied by the caller for the genuinely remaining legal continuation.
// ---------------------------------------------------------------------------
export async function resumeFromJournal({ journalPath, claimant, recordId = null, intentGeneration = null, continueWith = null }) {
  // STEP 1 — durable authority (F0 FIRST)
  const step1 = readDurableAuthority(journalPath);
  if (!step1.ok) return { step: 1, ...step1 };

  // STEP 2 — execution identity
  const step2 = verifyExecutionIdentity({ claimant, journalEvents: step1.events });
  if (!step2.ok) return { step: 2, ...step2 };

  // STEP 3 — generation (durable vs intent). The two sides MUST be distinct
  // (RESUME-ALGORITHM step 3: the record's durable generation vs the resuming
  // intent's generation; OWNERSHIP: generation fencing). A claimant with NO
  // generation binding is not verifiable against reality — it HOLDS
  // (RECOVERY_REQUIRED); it may never pass by comparing the durable value
  // against itself.
  let durableGeneration = null;
  for (const ev of step1.events) {
    if (ev.operation === "LIFECYCLE_EVENT" && (recordId == null || ev.payload?.recordId === recordId) && Number.isInteger(ev.payload?.generationAfter)) {
      durableGeneration = ev.payload.generationAfter;
    }
  }
  const claimantGeneration = Number.isInteger(claimant?.generation) ? claimant.generation : (Number.isInteger(intentGeneration) ? intentGeneration : null);
  if (claimantGeneration == null) {
    return { step: 3, ok: false, status: "HOLD", disposition: "HOLD", code: LIFECYCLE_FINE_CODES.RECOVERY_REQUIRED, reason: "CLAIMANT_GENERATION_BINDING_MISSING", detail: "resume requires the claimant's own generation binding — a generation-less claimant may not self-verify against the durable prefix" };
  }
  const step3 = verifyGeneration({ intentGeneration: claimantGeneration, durableGeneration });
  if (!step3.ok) return { step: 3, ...step3 };

  // STEP 4 — terminal state over the reconstructed projection
  const recon = reconstructRecordState(journalPath, { recordId });
  if (!recon.ok) return { step: 4, ...recon };
  const step4 = verifyTerminalState(recon.projection.state);
  if (!step4.ok) return { step: 4, ...step4 };

  // STEP 5 — ownership
  const step5 = verifyOwnership({ claimant, journalEvents: step1.events, durableGeneration });
  if (!step5.ok) return { step: 5, ...step5 };

  // STEP 6 — legal continuation
  const step6 = reconstructLegalContinuation(recon.projection.state);
  if (!step6.ok) return { step: 6, ...step6 };

  // STEP 7 — continue (via N2 only) or HOLD
  if (typeof continueWith !== "function") {
    return {
      ok: true, step: 7, status: "RESOLVED", outcome: "RESOLVED", disposition: "RECOVERABLE",
      state: recon.projection.state, generation: recon.projection.generation,
      allowedContinuations: step6.allowedContinuations, reason: "continuation reconstructed — caller supplies the N2 write",
    };
  }
  const result = await continueWith({ projection: recon.projection, allowedContinuations: step6.allowedContinuations, claimant });
  if (!result || result.ok !== true) {
    const code = result?.code ?? LIFECYCLE_FINE_CODES.RECOVERY_REQUIRED;
    return { step: 7, ok: false, status: "HOLD", disposition: "HOLD", code, reason: result?.reason ?? "continuation write did not land" };
  }
  // Step 7 resolves ONLY on a journal-authoritative success: the continuation
  // write must be an N2 APPLIED (journaled + fsynced). Any other ok:true shape
  // (NO-OP, REJECT-shaped, or a write that bypassed N2) does not advance the
  // operation — HOLD, reconcile-first (RESUME-ALGORITHM step 7: new journal
  // events through the existing machinery ONLY).
  if (result.status !== "APPLIED") {
    return { step: 7, ok: false, status: "HOLD", disposition: "HOLD", code: result.code ?? LIFECYCLE_FINE_CODES.RECOVERY_REQUIRED, reason: "CONTINUATION_WRITE_NOT_APPLIED", detail: `continuation returned status ${String(result.status)} — only an APPLIED N2 write resolves the resume` };
  }
  return { ok: true, step: 7, status: "RESOLVED", outcome: "RESOLVED", disposition: "RECOVERABLE", result };
}
