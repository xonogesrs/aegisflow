// test/learning/lifecycle/test-resume-recovery.mjs
//
// RUNG-6 Step 5 suite — N3 resume/recovery at unit depth:
//   ladder 12: §12 7-step restart/replay rows (incl. HOLD paths + RESUME_CANNOT)
//   ladder 9/10/11 unit rows: C1–C5 dispositions, partial-line exclusion, seq gap
//   P5 green control: memory-snapshot resume fails closed
//   P11/P12 green controls: non-authority inputs rejected; step-2 enforcement
// All verdicts computed from journal bytes only.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resumeFromJournal, readDurableAuthority, verifyExecutionIdentity, verifyGeneration,
  verifyTerminalState, verifyOwnership, reconstructLegalContinuation,
  reconstructRecordState, resolveCrashDisposition,
} from "../../../src/learning/lifecycle/resume-recovery.mjs";
import {
  writeLifecycleEvent, writeOpCancelEvent, readLifecycleJournalState,
} from "../../../src/learning/lifecycle/event-journal.mjs";
import { authorizeLifecycleEvent } from "../../../src/learning/lifecycle/state-machine.mjs";
import { projection, t1Intent, demoteIntent, archiveIntent, t12Intent, journalAdmissionEvidence } from "./helpers.mjs";
import { MEMORY_ERRORS } from "../../../src/memory/validation.mjs";

const ROOTS = [];
function freshJournal() { const d = mkdtempSync(join(tmpdir(), "lc-n3-")); ROOTS.push(d); return join(d, "journal.jsonl"); }
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

/** AMENDMENT-1: land the admission record + attach the reading-layer fact. */
function resolveE9(jp, intent, { requiresJustification = false, append = true } = {}) {
  const rec = intent.elements.E9 ?? intent.elements.HUMAN_ADMISSION;
  intent.resolutionEvidence = journalAdmissionEvidence(jp, rec, { recordId: intent.recordId ?? "pat-lifecycle-1", generation: intent.generation ?? 1, requiresJustification }, { append });
  return intent;
}

const CLAIMANT = () => ({ graphRunId: "graph-run-1", task: "task-1", generation: 1 });

/** journal a T1 (CANDIDATE→ADVISORY) prefix and return the path. */
function journaledPrefix(o = {}) {
  const jp = freshJournal();
  const p1 = projection({ state: o.state ?? "CANDIDATE", generation: o.generation ?? 1 });
  const intent = o.intent ?? t1Intent({ generation: o.generation ?? 1 });
  const v = authorizeLifecycleEvent(intent, p1);
  assert.equal(v.ok, true, JSON.stringify(v));
  const w = writeLifecycleEvent({ intent, verdict: v, projection: p1, journalPath: jp, writerId: o.writerId ?? "graph-run-1", writerGeneration: 1 });
  assert.equal(w.status, "APPLIED", JSON.stringify(w));
  return { jp, w };
}

// ---------------------------------------------------------------------------
// Ladder 12 — the §12 algorithm end-to-end (steps 1–7 incl. HOLD paths)
// ---------------------------------------------------------------------------

test("R-12a. resume from a journaled prefix: steps 1–7 RESOLVED, continuation = frozen edges of the reconstructed state", async () => {
  const { jp } = journaledPrefix();
  const r = await resumeFromJournal({ journalPath: jp, claimant: CLAIMANT(), recordId: "pat-lifecycle-1" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.step, 7);
  assert.equal(r.status, "RESOLVED");
  assert.equal(r.state, "ADVISORY", "reconstructed from journal bytes");
  assert.deepEqual(r.allowedContinuations.map((c) => c.id), ["T2", "T4", "T7"]);
});

test("R-12b. resume with a torn view: step 1 HOLD RECOVERY_REQUIRED, nothing adopted", () => {
  const { jp } = journaledPrefix();
  appendFileSync(jp, '{"schema":"autoloop.memory-journal-event/v1","journalSeq'); // crash mid-append
  const r = readDurableAuthority(jp);
  assert.equal(r.ok, false);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, MEMORY_ERRORS.JOURNAL_CHAIN_INVALID);
  assert.equal(r.reason, "RECOVERY_REQUIRED");
});

test("R-12c. resume with corrupted middle line: HOLD; blind retry cannot launder it", () => {
  const { jp } = journaledPrefix();
  const good = readFileSync(jp, "utf8").trimEnd();
  writeFileSync(jp, good + "\n" + good.replace('"journalSequence":1', '"journalSequence":2') + "\n");
  const r = readDurableAuthority(jp);
  assert.equal(r.ok, false);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, MEMORY_ERRORS.JOURNAL_CHAIN_INVALID);
});

test("R-12d. stale claimant at step 3: REJECT WRONG_GENERATION (stale resume may not act)", async () => {
  const { jp } = journaledPrefix({ generation: 3 });
  const r = await resumeFromJournal({ journalPath: jp, claimant: { graphRunId: "graph-run-1", generation: 2 }, recordId: "pat-lifecycle-1" });
  assert.equal(r.ok, false);
  assert.equal(r.step, 3, "generation verification is step 3 in the frozen order");
  assert.equal(r.code, "WRONG_GENERATION");
  assert.equal(r.reason, "GENERATION_MISMATCH");
});

test("R-12e. foreign writer over the same prefix: step 5 HOLD PROCESS_OWNERSHIP_AMBIGUOUS — never takeover", async () => {
  const { jp } = journaledPrefix({ writerId: "graph-run-OTHER" });
  const r = await resumeFromJournal({ journalPath: jp, claimant: CLAIMANT(), recordId: "pat-lifecycle-1" });
  assert.equal(r.ok, false);
  assert.equal(r.step, 5);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, "PROCESS_OWNERSHIP_AMBIGUOUS");
});

test("R-12f. two competing writers journaled: HOLD (ambiguous attribution), never last-writer-wins", async () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const v1 = authorizeLifecycleEvent(t1Intent(), p1);
  writeLifecycleEvent({ intent: t1Intent(), verdict: v1, projection: p1, journalPath: jp, writerId: "writer-A", writerGeneration: 1 });
  // second writer: a demote from ADVISORY
  const p2 = projection({ state: "ADVISORY", generation: 1, lastSequence: 1, previousDigest: readLifecycleJournalState(jp).previousDigest });
  const i2 = demoteIntent("ADVISORY");
  const v2 = authorizeLifecycleEvent(i2, p2);
  assert.equal(v2.ok, true, JSON.stringify(v2));
  writeLifecycleEvent({ intent: i2, verdict: v2, projection: p2, journalPath: jp, writerId: "writer-B", writerGeneration: 1 });
  const r = verifyOwnership({ claimant: { graphRunId: "writer-A" }, journalEvents: readLifecycleJournalState(jp).events, durableGeneration: 1 });
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, "PROCESS_OWNERSHIP_AMBIGUOUS");
});

test("R-12g. terminal reconstruction at step 4: REMOVED ⇒ REJECT LIFECYCLE_TERMINAL_IMMUTABLE, empty continuation", async () => {
  const jp = freshJournal();
  const pA = projection({ state: "CANDIDATE", generation: 1 });
  const vA = authorizeLifecycleEvent(t1Intent(), pA);
  writeLifecycleEvent({ intent: t1Intent(), verdict: vA, projection: pA, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  const st = readLifecycleJournalState(jp);
  const pB = projection({ state: "ADVISORY", generation: 1, lastSequence: st.lastSequence, previousDigest: st.previousDigest });
  const iB = archiveIntent();
  const vB = authorizeLifecycleEvent(iB, pB);
  assert.equal(vB.ok, true);
  writeLifecycleEvent({ intent: iB, verdict: vB, projection: pB, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  const st2 = readLifecycleJournalState(jp);
  const pC = projection({ state: "ARCHIVED", generation: 1, lastSequence: st2.lastSequence, previousDigest: st2.previousDigest });
  const iC = t12Intent();
  iC.preRemovalRecordBytes = { recordId: iC.recordId, statement: "pre-removal" };
  resolveE9(jp, iC, { requiresJustification: true, append: true });
  const vC = authorizeLifecycleEvent(iC, pC);
  assert.equal(vC.ok, true, JSON.stringify(vC));
  writeLifecycleEvent({ intent: iC, verdict: vC, projection: pC, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  const r = await resumeFromJournal({ journalPath: jp, claimant: CLAIMANT(), recordId: "pat-lifecycle-1" });
  assert.equal(r.ok, false);
  assert.equal(r.step, 4);
  assert.equal(r.code, "LIFECYCLE_TERMINAL_IMMUTABLE");
  assert.deepEqual(r.allowedContinuations, []);
});

test("R-12h. RESUME_CANNOT: resume mints no new identity for the same logical content (idempotent duplicate)", async () => {
  const { jp } = journaledPrefix();
  // same-identity re-delivery through the resume path's write = keyed NO-OP
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const intent = t1Intent();
  const v = authorizeLifecycleEvent(intent, p1);
  const w = writeLifecycleEvent({ intent, verdict: v, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  assert.equal(w.status, "NO-OP");
  assert.equal(w.code, "DUPLICATE_EVENT_ID");
});

test("R-12i. P5 green control: a memory-snapshot claimant with NO journal cannot resume (JOURNAL/missing durable state)", async () => {
  // empty journal (no bytes at all): step 1 reads genesis; the claimant's
  // generation binding CANNOT be verified against a prefix that does not
  // exist — step 3 HOLDs (generation reality ambiguous; a resume never
  // self-verifies against an absent prefix). Any continuation write requires
  // an N1 ok-verdict over a JOURNAL projection — a memory-sourced projection
  // is refused (N2-15).
  const jp = freshJournal();
  const r = await resumeFromJournal({ journalPath: jp, claimant: CLAIMANT(), recordId: "never-journaled" });
  assert.equal(r.ok, false);
  assert.equal(r.step, 3);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, MEMORY_ERRORS.JOURNAL_CHAIN_INVALID);
  assert.equal(r.reason, "RECOVERY_REQUIRED");
  // the ONLY way a process-memory resume could act is N2's seam — refused:
  const memProj = { ...projection({ state: "CANDIDATE" }), claimSource: "PROCESS_MEMORY" };
  const seam = writeLifecycleEvent({ intent: t1Intent(), verdict: authorizeLifecycleEvent(t1Intent(), memProj), projection: memProj, journalPath: jp, writerId: "x", writerGeneration: 1 });
  assert.equal(seam.status, "HOLD");
  assert.equal(seam.code, MEMORY_ERRORS.JOURNAL_CHAIN_INVALID);
});

// ---------------------------------------------------------------------------
// Ladders 9/10/11 — C1–C5 dispositions, torn-write, exactly-once (unit rows)
// ---------------------------------------------------------------------------

test("R-C1. crash during run: chain-valid prefix ⇒ RECOVERABLE (continue via §12)", () => {
  const { jp } = journaledPrefix();
  const r = resolveCrashDisposition({ journalPath: jp, recordId: "pat-lifecycle-1" });
  assert.equal(r.disposition, "RECOVERABLE");
  assert.equal(r.ok, true);
});

test("R-C2. crash during cancel: cancelled IFF the OP_CANCEL event landed", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const intent = { claimSource: "JOURNAL_PROJECTION", recordId: "pat-lifecycle-1", event: "OP_CANCEL", cancelKey: "op-9", generation: 1, policyAllowed: true, executionIdentity: { graphRunId: "graph-run-1" }, elements: {} };
  const v = authorizeLifecycleEvent(intent, p1);
  assert.equal(v.status, "APPLIED", JSON.stringify(v));
  writeOpCancelEvent({ intent, verdict: v, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  const st = readLifecycleJournalState(jp);
  assert.equal(st.events.some((e) => e.payload?.event === "OP_CANCEL"), true);
  // the journaled cancel IS the answer (RESOLVED); a torn view would HOLD
  const r = readDurableAuthority(jp);
  assert.equal(r.ok, true);
});

test("R-C3. crash during terminal write: expectEventId landed ⇒ RESOLVED (retry = identity no-op); absent ⇒ RESOLVED (retry legal)", () => {
  const { jp, w } = journaledPrefix();
  const landed = resolveCrashDisposition({ journalPath: jp, recordId: "pat-lifecycle-1", expectEventId: w.event.payload.eventId });
  assert.equal(landed.disposition, "RESOLVED");
  assert.ok(landed.event, "landed event returned");
  const absent = resolveCrashDisposition({ journalPath: jp, recordId: "pat-lifecycle-1", expectEventId: "ghost-check" });
  assert.equal(absent.disposition, "RESOLVED");
  assert.equal(absent.reason, "event absent — state unchanged (retry legal, same identity)");
});

test("R-C5. crash before durable state: no ownership, RESOLVED, fresh attempt with same identity discipline", () => {
  const jp = freshJournal();
  const r = resolveCrashDisposition({ journalPath: jp, recordId: "pat-lifecycle-1" });
  assert.equal(r.disposition, "RESOLVED");
  assert.match(r.reason, /^C5/);
});

test("R-TORN. partial trailing line excluded from reconstruction (never state); chain ends at last complete event", () => {
  const { jp } = journaledPrefix();
  appendFileSync(jp, '{"partial');
  const recon = reconstructRecordState(jp, { recordId: "pat-lifecycle-1" });
  // reconstruction is withheld — torn view ⇒ HOLD (AMBIGUITY LAW)
  assert.equal(recon.ok, false);
  assert.equal(recon.status, "HOLD");
  // the raw read machinery still reports the excluded line (N2-10 covered)
  const st = readLifecycleJournalState(jp);
  assert.equal(st.partialTrailingLine, true);
  assert.equal(st.lastSequence, 1);
});

// ---------------------------------------------------------------------------
// Step-2 unit rows — durable-identity enforcement (P11/P12 green controls)
// ---------------------------------------------------------------------------

test("R-ID1. step 2 rejects session/container/provider/checkpoint identity inputs (harness-independence fence)", () => {
  for (const key of ["sessionId", "containerId", "providerRunId", "harnessCheckpointId"]) {
    const r = verifyExecutionIdentity({ claimant: { graphRunId: "g", [key]: "forged" }, journalEvents: [] });
    assert.equal(r.ok, false, key);
    assert.equal(r.code, "WRITEBACK_EVIDENCE_IDENTITY_FORGED");
  }
});

test("R-ID2. step 2 with no journaled writers verifies the claimant alone (C5 form)", () => {
  const r = verifyExecutionIdentity({ claimant: CLAIMANT(), journalEvents: [] });
  assert.equal(r.ok, true);
  assert.equal(r.status, "VERIFIED");
});

test("R-GEN. step 3 unit rows: ambiguous ⇒ HOLD; stale ⇒ REJECT WRONG_GENERATION; match ⇒ VERIFIED", () => {
  const amb = verifyGeneration({ intentGeneration: null, durableGeneration: null });
  assert.equal(amb.status, "HOLD");
  const stale = verifyGeneration({ intentGeneration: 2, durableGeneration: 1 });
  assert.equal(stale.status, "REJECT");
  assert.equal(stale.code, "WRONG_GENERATION");
  const ok = verifyGeneration({ intentGeneration: 1, durableGeneration: 1 });
  assert.equal(ok.status, "VERIFIED");
});

test("R-CONT. step 6: empty continuation at a non-terminal state ⇒ HOLD ambiguity; REMOVED ⇒ empty set is legal", () => {
  const h = reconstructLegalContinuation("MUTATED"); // unreachable state — ambiguity guard
  assert.equal(h.ok, false);
  assert.equal(h.code, "PROCESS_OWNERSHIP_AMBIGUOUS");
  // REMOVED is handled at step 4 (terminal REJECT) before step 6 — verify:
  const t = verifyTerminalState("REMOVED");
  assert.equal(t.ok, false);
  assert.deepEqual(t.allowedContinuations, []);
});

// ---------------------------------------------------------------------------
// CP-4 review regression rows.
// R-GEN2: a generation-less claimant must HOLD (never self-verify).
// R-CONT2: step 7 resolves ONLY on an N2 APPLIED result.
// ---------------------------------------------------------------------------
test("R-GEN2. generation-less claimant over a non-empty prefix ⇒ HOLD (never self-verified RESOLVED)", async () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const v1 = authorizeLifecycleEvent(t1Intent(), p1);
  writeLifecycleEvent({ intent: t1Intent(), verdict: v1, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  // same writer, but NO generation binding at all:
  const r = await resumeFromJournal({ journalPath: jp, claimant: { graphRunId: "graph-run-1", task: "task-1" }, recordId: "pat-lifecycle-1" });
  assert.equal(r.ok, false);
  assert.equal(r.step, 3);
  assert.equal(r.status, "HOLD");
  assert.equal(r.disposition, "HOLD");
  assert.equal(r.reason, "CLAIMANT_GENERATION_BINDING_MISSING");
});

test("R-CONT2. step 7 resolves ONLY on an N2 APPLIED continuation result", async () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const v1 = authorizeLifecycleEvent(t1Intent(), p1);
  writeLifecycleEvent({ intent: t1Intent(), verdict: v1, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  // (a) an ok:true NON-APPLIED result (e.g. a NO-OP laundering attempt) ⇒ HOLD:
  const r1 = await resumeFromJournal({
    journalPath: jp,
    claimant: { graphRunId: "graph-run-1", task: "task-1", generation: 1 },
    recordId: "pat-lifecycle-1",
    continueWith: async () => ({ ok: true, status: "NO-OP", code: "DUPLICATE_EVENT_ID" }),
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.step, 7);
  assert.equal(r1.status, "HOLD");
  assert.equal(r1.reason, "CONTINUATION_WRITE_NOT_APPLIED");
  // (b) an APPLIED N2 write resolves:
  const r2 = await resumeFromJournal({
    journalPath: jp,
    claimant: { graphRunId: "graph-run-1", task: "task-1", generation: 1 },
    recordId: "pat-lifecycle-1",
    continueWith: async () => ({ ok: true, status: "APPLIED", journalSequence: 2 }),
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.status, "RESOLVED");
  assert.equal(r2.disposition, "RECOVERABLE");
});
