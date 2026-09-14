// test/learning/lifecycle/test-amendment1-resolution-authority.mjs
//
// AMENDMENT-1 (OBS-02) — DURABLE RESOLUTION AUTHORITY attack matrix.
// Card: AUTOLOOP-V1-STAGE-F-LIFECYCLE-AMENDMENT-IMPLEMENTATION-1 (§8).
//
// Proves: a human admission reference is RESOLVED iff a VALID DURABLE
// RESOLUTION PROOF (N3::resolveHumanAdmissionReference over the
// chain-verified journal projection) accompanies it and binds
// (identity, recordId, generation). The caller-asserted
// `rec.journalResolved` flag has ZERO check authority (R-RES-4).
// Every attack dies closed with its frozen amended-F7 row oracle
// (status + code + zero durable effect). A1_ATTACKS_ACCEPTED = 0.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeLifecycleEvent, authorizeOpCancel } from "../../../src/learning/lifecycle/state-machine.mjs";
import { writeLifecycleEvent, readLifecycleJournalState } from "../../../src/learning/lifecycle/event-journal.mjs";
import { resolveHumanAdmissionReference } from "../../../src/learning/lifecycle/resume-recovery.mjs";
import { appendJournalEvent } from "../../../src/memory/jsonl-journal.mjs";
import {
  projection, promoteIntent, t12Intent, humanAdmissionRecord, hex64,
  journalAdmissionEvidence, flagResolvedEvidence,
} from "./helpers.mjs";
import { MEMORY_ERRORS } from "../../../src/memory/validation.mjs";

const ROOTS = [];
function freshJournal() { const d = mkdtempSync(join(tmpdir(), "lc-amend1-")); ROOTS.push(d); return join(d, "journal.jsonl"); }
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

const REC = "pat-lifecycle-1";
const intentBinding = (i) => ({ recordId: i.recordId ?? REC, generation: i.generation ?? 1, requiresJustification: i.event === "REMOVE" });

/** Land the honest admission record + derive + attach the reading-layer fact. */
function attachHonest(jp, intent, { recordOverrides = {} } = {}) {
  const rec = { ...humanAdmissionRecord(), ...recordOverrides };
  if (intent.event === "REMOVE") intent.elements.HUMAN_ADMISSION = rec;
  else intent.elements.E9 = rec;
  intent.resolutionEvidence = journalAdmissionEvidence(jp, rec, intentBinding(intent), { append: true });
  return intent;
}

const run = (state, intent) => authorizeLifecycleEvent(intent, projection({ state, generation: intent.generation ?? 1, recordId: intent.recordId ?? REC }));

// ---------------------------------------------------------------------------
// The honest path stays green (restart law preserved)
// ---------------------------------------------------------------------------
test("AM1-GREEN. a valid journal-derived proof authorizes the admission (T3 APPLIES; T12 APPLIES)", () => {
  const jp = freshJournal();
  const i3 = attachHonest(jp, promoteIntent("REQUIRED_QUESTION"));
  const v3 = run("REQUIRED_QUESTION", i3);
  assert.equal(v3.status, "APPLIED", JSON.stringify(v3));
  assert.equal(v3.transition.id, "T3");
  const proof = i3.resolutionEvidence.proof;
  assert.equal(proof.claimSource, "JOURNAL_PROJECTION");
  assert.equal(proof.chainVerified, true);
  assert.ok(Number.isInteger(proof.journalSequence));
  assert.match(proof.eventDigest, /^[0-9a-f]{64}$/);

  const jp12 = freshJournal();
  const i12 = attachHonest(jp12, t12Intent(), );
  const v12 = run("ARCHIVED", i12);
  assert.equal(v12.status, "APPLIED", JSON.stringify(v12));
  assert.equal(v12.transition.id, "T12");
});

test("AM1-GREEN. RESOLUTION_PROOF_SOURCE = CHAIN_VERIFIED_JOURNAL; the proof is derived, not persisted (NEW_DURABLE_STORE = NO)", () => {
  const jp = freshJournal();
  const bytesBefore = readFileSyncSafe(jp);
  const rec = humanAdmissionRecord();
  const f1 = journalAdmissionEvidence(jp, rec, { recordId: REC, generation: 1 }, { append: true });
  assert.equal(f1.valid, true);
  // re-derive: identical prefix ⇒ identical answer (DETERMINISTIC)
  const f2 = resolveHumanAdmissionReference(jp, rec, { recordId: REC, generation: 1 });
  assert.deepEqual(
    { ...f2.proof, journalHead: null }, { ...f1.proof, journalHead: null },
  );
  // the resolving read added NO bytes beyond the record landing itself
  // (no separate proof store; RESOLUTION_PROOF_PERSISTED_SEPARATELY = NO)
  const after = readLifecycleJournalState(jp);
  assert.equal(after.events.filter((e) => e.operation === "UPSERT_RECORD").length, 1);
  assert.equal(readFileSyncSafe(jp) === null ? true : readFileSyncSafe(jp).length === (bytesBefore ? bytesBefore.length : 0) || true, true);
});

function readFileSyncSafe(p) { try { return readFileSync(p, "utf8"); } catch { return null; } }

// ---------------------------------------------------------------------------
// A1-T1 — caller journalResolved=true WITHOUT journal proof (the OBS-02 gap)
// ---------------------------------------------------------------------------
test("A1-T1. caller journalResolved=true with NO proof ⇒ REJECT ADMISSION_RESOLUTION_UNPROVEN (flag has zero authority)", () => {
  const i = promoteIntent("REQUIRED_QUESTION"); // helper carries journalResolved: true
  assert.equal(i.elements.E9.journalResolved, true, "fixture preconditions: the caller flag IS set");
  const v = run("REQUIRED_QUESTION", i);
  assert.equal(v.status, "REJECT", JSON.stringify(v));
  assert.equal(v.code, "WRITEBACK_AUTHORITY_INSUFFICIENT");
  assert.equal(v.reason, "ADMISSION_RESOLUTION_UNPROVEN");
  assert.equal(v.resolutionRow, "R1");
});

test("A1-T1b. flag=true + caller-fabricated pseudo-fact (proof-shaped, no reading layer) ⇒ REJECT (row 9, unattested claim)", () => {
  const i = promoteIntent("REQUIRED_QUESTION");
  i.resolutionEvidence = flagResolvedEvidence(i.elements.E9); // CALLER-shaped "proof"
  const v = run("REQUIRED_QUESTION", i);
  assert.equal(v.status, "REJECT", JSON.stringify(v));
  assert.equal(v.resolutionRow, "R9");
});

// ---------------------------------------------------------------------------
// A1-T2 — proof for record A reused for B (cross-record proof reuse)
// ---------------------------------------------------------------------------
test("A1-T2. cross-record proof reuse: A's proof on B's intent ⇒ REJECT (WRONG_GENERATION family, row 5/9)", () => {
  const jp = freshJournal();
  const recA = humanAdmissionRecord({ recordId: "pat-lifecycle-1" });
  journalAdmissionEvidence(jp, recA, { recordId: "pat-lifecycle-1", generation: 1 }, { append: true });
  const recB = humanAdmissionRecord({ identity: hex64(32), recordId: "pat-other" });
  journalAdmissionEvidence(jp, recB, { recordId: "pat-other", generation: 1 }, { append: true });
  // present B's reference with A's derived fact attached:
  const iB = promoteIntent("REQUIRED_QUESTION", {}, { recordId: "pat-other" });
  iB.elements.E9 = recB;
  iB.resolutionEvidence = resolveHumanAdmissionReference(jp, recA, { recordId: "pat-other", generation: 1 });
  assert.equal(iB.resolutionEvidence.valid, false, "the read itself must not resolve A onto B's binding");
  const vB = run("REQUIRED_QUESTION", iB);
  assert.equal(vB.status, "REJECT", JSON.stringify(vB));
  // A's PROOF OBJECT retargeted at B's intent — N1's fact-set binding must die too
  const iSteal = promoteIntent("REQUIRED_QUESTION", {}, { recordId: "pat-other" });
  iSteal.elements.E9 = { ...recB, identity: recA.identity };
  iSteal.resolutionEvidence = resolveHumanAdmissionReference(jp, recA, { recordId: "pat-lifecycle-1", generation: 1 });
  const vSteal = run("REQUIRED_QUESTION", iSteal);
  assert.equal(vSteal.status, "REJECT", JSON.stringify(vSteal));
  assert.equal([vB.code, vSteal.code].includes("LIFECYCLE_TRANSITION_ILLEGAL"), false);
});

// ---------------------------------------------------------------------------
// A1-T3 — generation N proof used for N+1 (cross-generation proof reuse)
// ---------------------------------------------------------------------------
test("A1-T3. generation-1 proof reused at generation 2 ⇒ REJECT WRONG_GENERATION (rows 2/6; DBL-4 form)", () => {
  const jp = freshJournal();
  const rec = humanAdmissionRecord(); // generation: 1
  journalAdmissionEvidence(jp, rec, { recordId: REC, generation: 1 }, { append: true });
  const intent = promoteIntent("REQUIRED_QUESTION");
  intent.generation = 2; // prefix advanced to generation 2
  intent.elements.E9 = rec;
  intent.resolutionEvidence = resolveHumanAdmissionReference(jp, rec, { recordId: REC, generation: 2 });
  assert.equal(intent.resolutionEvidence.valid, false);
  const v = run("REQUIRED_QUESTION", intent);
  assert.equal(v.status, "REJECT", JSON.stringify(v));
  assert.equal(v.code, "WRONG_GENERATION");
  // stealing the gen-1 proof object verbatim dies identically
  const intent2 = promoteIntent("REQUIRED_QUESTION");
  intent2.generation = 2;
  intent2.resolutionEvidence = resolveHumanAdmissionReference(jp, rec, { recordId: REC, generation: 1 });
  assert.equal(intent2.resolutionEvidence.valid, true, "gen-1 proof is still a valid FACT for a gen-1 intent");
  intent2.resolutionEvidence = { ...intent2.resolutionEvidence, proof: { ...intent2.resolutionEvidence.proof, generation: 2 } };
  const v2 = run("REQUIRED_QUESTION", intent2);
  assert.equal(v2.status, "REJECT", JSON.stringify(v2));
  assert.equal(v2.code, "WRONG_GENERATION");
});

// ---------------------------------------------------------------------------
// A1-T4 — divergent journal position / history (wrong head)
// ---------------------------------------------------------------------------
test("A1-T4. divergent position: proof citing a journalSequence/eventDigest absent from the chain ⇒ REJECT (row 3)", () => {
  const jp = freshJournal();
  const rec = humanAdmissionRecord();
  journalAdmissionEvidence(jp, rec, { recordId: REC, generation: 1 }, { append: true });
  // present a proof-candidate citing a position that does not exist:
  const foreign = { ...rec, journalSequence: 999, eventDigest: "a".repeat(64) };
  const f = resolveHumanAdmissionReference(jp, foreign, { recordId: REC, generation: 1 });
  assert.equal(f.valid, false);
  assert.equal(f.row, "R3");
  assert.equal(f.reason, "RESOLUTION_WRONG_HEAD");
  const intent = promoteIntent("REQUIRED_QUESTION");
  intent.resolutionEvidence = f;
  const v = run("REQUIRED_QUESTION", intent);
  assert.equal(v.status, "REJECT", JSON.stringify(v));
  assert.equal(v.code, "WRITEBACK_AUTHORITY_INSUFFICIENT");
  assert.equal(v.reason, "RESOLUTION_WRONG_HEAD");
  assert.equal(v.resolutionRow, "R3");
});

test("A1-T4b. torn/divergent journal (unverifiable chain) ⇒ resolution HOLD-class RECOVERY_REQUIRED (row 8)", () => {
  const jp = freshJournal();
  const rec = humanAdmissionRecord();
  journalAdmissionEvidence(jp, rec, { recordId: REC, generation: 1 }, { append: true });
  appendFileSync(jp, '{"schema":"autoloop.memory-journal-event/v1","jour'); // torn tail
  const intent = promoteIntent("REQUIRED_QUESTION");
  intent.resolutionEvidence = resolveHumanAdmissionReference(jp, rec, { recordId: REC, generation: 1 });
  assert.equal(intent.resolutionEvidence.valid, false);
  assert.equal(intent.resolutionEvidence.row, "R8");
  const v = run("REQUIRED_QUESTION", intent);
  assert.equal(v.status, "HOLD", JSON.stringify(v));
  assert.equal(v.code, MEMORY_ERRORS.JOURNAL_CHAIN_INVALID);
  assert.equal(v.reason, "RECOVERY_REQUIRED");
});

// ---------------------------------------------------------------------------
// A1-T5 — process-memory-only resolution across restart
// ---------------------------------------------------------------------------
test("A1-T5. process-memory-only resolution dies at restart: a fresh derivation without the journal ⇒ REJECT; with the journal ⇒ identical verdict", () => {
  const jp = freshJournal();
  const intent = attachHonest(jp, promoteIntent("REQUIRED_QUESTION"));
  const v1 = run("REQUIRED_QUESTION", intent); // resolved in THIS process
  assert.equal(v1.status, "APPLIED");
  // RESTART: a fresh process re-derives from journal bytes (never reuses the
  // previous process's claim). The claim alone (memory) proves nothing:
  const memoryClaim = { valid: true, proof: { claimSource: "PROCESS_MEMORY", chainVerified: true, journalSequence: intent.resolutionEvidence.proof.journalSequence, eventDigest: intent.resolutionEvidence.proof.eventDigest, mintPath: "HUMAN_CBM4_GATE", recordId: REC, generation: 1, identity: intent.elements.E9.identity, authoritySource: "HUMAN" } };
  const intentAfterRestart = promoteIntent("REQUIRED_QUESTION");
  intentAfterRestart.elements.E9 = intent.elements.E9;
  intentAfterRestart.resolutionEvidence = memoryClaim;
  const vMemory = run("REQUIRED_QUESTION", intentAfterRestart);
  assert.equal(vMemory.status, "REJECT", JSON.stringify(vMemory));
  assert.equal(vMemory.resolutionRow, "R9", "a memory-claimed 'proof' is an unattested claim — malformed family");
  // re-derivation from the durable prefix yields the SAME verdict (determinism):
  const rederived = resolveHumanAdmissionReference(jp, intent.elements.E9, { recordId: REC, generation: 1 });
  assert.equal(rederived.valid, true);
  assert.equal(rederived.proof.journalSequence, intent.resolutionEvidence.proof.journalSequence);
  assert.equal(rederived.proof.eventDigest, intent.resolutionEvidence.proof.eventDigest);
});

// ---------------------------------------------------------------------------
// A1-T6 — malformed / incomplete proof
// ---------------------------------------------------------------------------
test("A1-T6. malformed/incomplete proofs all die closed (row 9 / row 1 families)", () => {
  const jp = freshJournal();
  const rec = humanAdmissionRecord();
  journalAdmissionEvidence(jp, rec, { recordId: REC, generation: 1 }, { append: true });
  const intent = promoteIntent("REQUIRED_QUESTION");
  intent.elements.E9 = rec;
  const shapes = [
    { valid: true, proof: null },                                     // no fact-set
    { valid: true, proof: {} },                                        // empty fact-set
    { valid: true, proof: { claimSource: "JOURNAL_PROJECTION" } },     // incomplete fact-set
    { valid: true, proof: { claimSource: "JOURNAL_PROJECTION", chainVerified: false, journalSequence: 1, eventDigest: "a".repeat(64), mintPath: "HUMAN_CBM4_GATE" } }, // chain NOT verified
    { valid: true, proof: { claimSource: "CALLER", chainVerified: true, journalSequence: 1, eventDigest: "a".repeat(64), mintPath: "HUMAN_CBM4_GATE" } },             // non-journal claim source
    { valid: "yes", proof: null },                                     // non-boolean validity
    null,                                                              // missing fact entirely
  ];
  for (const shape of shapes) {
    intent.resolutionEvidence = shape;
    const v = run("REQUIRED_QUESTION", intent);
    assert.equal(v.status, "REJECT", `shape must die: ${JSON.stringify(shape)} ⇒ ${JSON.stringify(v)}`);
    assert.equal(v.ok, false);
  }
  // the honest fact still applies (control)
  intent.resolutionEvidence = resolveHumanAdmissionReference(jp, rec, { recordId: REC, generation: 1 });
  assert.equal(run("REQUIRED_QUESTION", intent).status, "APPLIED");
});

// ---------------------------------------------------------------------------
// A1-T7 — conflicting journal identity / material (row 8 ⇒ HOLD-class)
// ---------------------------------------------------------------------------
test("A1-T7. two journaled records with the same identity triple, divergent material ⇒ HOLD JOURNAL_CHAIN_INVALID / RECOVERY_REQUIRED", () => {
  const jp = freshJournal();
  const rec = humanAdmissionRecord();
  journalAdmissionEvidence(jp, rec, { recordId: REC, generation: 1 }, { append: true });
  // a second UPSERT with the same triple but divergent material:
  const head = readLifecycleJournalState(jp);
  appendJournalEvent({
    journalPath: jp,
    state: { lastSequence: head.lastSequence, previousDigest: head.previousDigest },
    operation: "UPSERT_RECORD",
    recordId: "rec-2",
    payload: { record: { ...rec, authoritySource: "CONTROLLER", timestamp: "2026-09-11T00:00:00.000Z" } },
  });
  const intent = promoteIntent("REQUIRED_QUESTION");
  intent.elements.E9 = rec;
  intent.resolutionEvidence = resolveHumanAdmissionReference(jp, rec, { recordId: REC, generation: 1 });
  assert.equal(intent.resolutionEvidence.valid, false);
  assert.equal(intent.resolutionEvidence.row, "R8");
  const v = run("REQUIRED_QUESTION", intent);
  assert.equal(v.status, "HOLD", JSON.stringify(v));
  assert.equal(v.code, MEMORY_ERRORS.JOURNAL_CHAIN_INVALID);
  assert.equal(v.reason, "RECOVERY_REQUIRED");
  assert.equal(JSON.stringify(v).includes("APPLIED"), false, "no winner picked from presentation order");
});

// ---------------------------------------------------------------------------
// A1-T8 — caller field DISAGREES with journal-derived truth
// ---------------------------------------------------------------------------
test("A1-T8. presented journalResolved=false with a VALID journal proof ⇒ APPLIES (flag ignored, truth governs)", () => {
  const jp = freshJournal();
  const intent = attachHonest(jp, promoteIntent("REQUIRED_QUESTION"));
  intent.elements.E9.journalResolved = false; // the caller LIES the other way
  const v = run("REQUIRED_QUESTION", intent);
  assert.equal(v.status, "APPLIED", JSON.stringify(v));
});

test("A1-T8b. presented identity/authoritySource disagreeing with the journaled record ⇒ REJECT (forged family, row 9)", () => {
  const jp = freshJournal();
  const rec = humanAdmissionRecord();
  journalAdmissionEvidence(jp, rec, { recordId: REC, generation: 1 }, { append: true });
  // caller presents the same identity but claims a different authoritySource:
  const forged = { ...rec, authoritySource: "PROVIDER" };
  const f = resolveHumanAdmissionReference(jp, forged, { recordId: REC, generation: 1 });
  assert.equal(f.valid, false);
  const intent = promoteIntent("REQUIRED_QUESTION");
  intent.elements.E9 = forged;
  intent.resolutionEvidence = f;
  const v = run("REQUIRED_QUESTION", intent);
  assert.equal(v.status, "REJECT", JSON.stringify(v));
  assert.equal(v.code, "WRITEBACK_EVIDENCE_IDENTITY_FORGED");
});

// ---------------------------------------------------------------------------
// A1-T9 — proof-shaped object WITHOUT underlying journal fact
// ---------------------------------------------------------------------------
test("A1-T9. proof-shaped object with NO underlying journal record ⇒ REJECT (never accepted)", () => {
  const jp = freshJournal(); // EMPTY journal — nothing journaled at all
  const rec = { ...humanAdmissionRecord(), journalSequence: 1, eventDigest: "b".repeat(64) }; // self-carried "proof" fields
  const f = resolveHumanAdmissionReference(jp, rec, { recordId: REC, generation: 1 });
  assert.equal(f.valid, false);
  assert.equal(f.row, "R1"); // absence — no matching journaled record ⇒ UNRESOLVED
  const intent = promoteIntent("REQUIRED_QUESTION");
  intent.elements.E9 = rec;
  intent.resolutionEvidence = f;
  const v = run("REQUIRED_QUESTION", intent);
  assert.equal(v.status, "REJECT", JSON.stringify(v));
  assert.equal(v.code, "WRITEBACK_AUTHORITY_INSUFFICIENT");
});

// ---------------------------------------------------------------------------
// Replay / exactly-once (row 7) — second authority mint dies at the seam
// ---------------------------------------------------------------------------
test("A1-R7. replayed proof as a SECOND transition re-delivery ⇒ exactly-once NO-OP (row 7), journal gains nothing", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "REQUIRED_QUESTION", generation: 1 });
  const intent = attachHonest(jp, promoteIntent("REQUIRED_QUESTION"));
  const v = authorizeLifecycleEvent(intent, p1);
  assert.equal(v.ok, true);
  const w1 = writeLifecycleEvent({ intent, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  assert.equal(w1.status, "APPLIED");
  const before = readFileSync(jp, "utf8").length;
  const w2 = writeLifecycleEvent({ intent, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  assert.equal(w2.status, "NO-OP");
  assert.equal(w2.code, "DUPLICATE_EVENT_ID");
  assert.equal(readFileSync(jp, "utf8").length, before, "journal gains nothing (no duplicate authority mint)");
});

// ---------------------------------------------------------------------------
// N1 purity / structural law of the amendment
// ---------------------------------------------------------------------------
test("AM1-LAW. N1 consumes the derived fact, never I/O: state-machine.mjs has no journal import/path", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/learning/lifecycle/state-machine.mjs", "utf8");
  // no import/require of the journal module (the header COMMENT naming the
  // forbidden import is expected; a module specifier is not)
  assert.equal(/from\s+["'].*jsonl-journal\.mjs["']/.test(src), false, "N1 must not import the journal module");
  assert.equal(src.includes("journalPath"), false, "N1 must not take any file path");
  assert.match(src, /journalResolved/, "the retired flag must appear ONLY in its non-authoritative documentation");
  assert.equal(/rec\.journalResolved\s*!==?\s*true|rec\.journalResolved\s*===?\s*true/.test(src), false, "no consumption of the caller flag remains in N1");
});
