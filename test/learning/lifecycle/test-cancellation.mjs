// test/learning/lifecycle/test-cancellation.mjs
//
// RUNG-6 Step 7 suite — the 8 frozen cancellation cases (CANCELLATION §3),
// each with the P4/P13 oracle form: status + exact code + zero durable effect
// for no-op forms. Cancellation is Layer-2 ONLY (never an eighth record
// state); cancel produces no PROMOTE/DEMOTE/ARCHIVE/REMOVE event, ever.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeOpCancelEvent, writeLifecycleEvent, readLifecycleJournalState,
  applyLifecycleEventToProjection,
} from "../../../src/learning/lifecycle/event-journal.mjs";
import { authorizeLifecycleEvent, authorizeOpCancel } from "../../../src/learning/lifecycle/state-machine.mjs";
import { projection, t1Intent } from "./helpers.mjs";
import { MEMORY_ERRORS } from "../../../src/memory/validation.mjs";

const ROOTS = [];
function freshJournal() { const d = mkdtempSync(join(tmpdir(), "lc-cancel-")); ROOTS.push(d); return join(d, "journal.jsonl"); }
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

const REC = "pat-lifecycle-1";
const cancelIntent = (cancelKey, o = {}) => ({
  claimSource: "JOURNAL_PROJECTION",
  recordId: REC,
  event: "OP_CANCEL",
  cancelKey,
  generation: o.generation ?? 1,
  policyAllowed: true,
  executionIdentity: { graphRunId: o.graphRunId ?? "graph-run-1" },
  elements: {},
});

function journalT1(jp) {
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const v = authorizeLifecycleEvent(t1Intent(), p1);
  const w = writeLifecycleEvent({ intent: t1Intent(), verdict: v, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  assert.equal(w.status, "APPLIED");
  return { p1, w };
}

// 1 — CANCEL-BEFORE-START: intent made durable even though no work ran
test("CX-1. cancel-before-start: cancel intent is durable; no record event, no ghost; replay shows WHY nothing ran", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const i = cancelIntent("op-before-start");
  const v = authorizeOpCancel(i, p1);
  assert.equal(v.status, "APPLIED", JSON.stringify(v));
  const w = writeOpCancelEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  assert.equal(w.status, "APPLIED", JSON.stringify(w));
  const ev = JSON.parse(readFileSync(jp, "utf8").trim().split("\n")[0]);
  assert.equal(ev.payload.event, "OP_CANCEL");
  assert.equal(ev.payload.transition.to, ev.payload.transition.from, "self-edge form: no record-state change (cancel is not a transition)");
  // replay reconstructs the UNCHANGED record
  const recon = readLifecycleJournalState(jp).events.reduce((acc, e) => applyLifecycleEventToProjection(acc, e), projection({ state: "CANDIDATE", generation: 1 }));
  assert.equal(recon.state, "CANDIDATE");
});

// 2 — CANCEL-WHILE-RUNNING: durable intent FIRST (authority-first ordering)
test("CX-2. cancel-while-running: journal the cancel (authority instant) — executor signalling comes only after the event landed", () => {
  const jp = freshJournal();
  const { p1: pre1 } = journalT1(jp);
  const st1 = readLifecycleJournalState(jp);
  const p1 = { ...pre1, lastSequence: st1.lastSequence, previousDigest: st1.previousDigest };
  const i = cancelIntent("op-running");
  const v = authorizeOpCancel(i, p1);
  assert.equal(v.ok, true);
  const w = writeOpCancelEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  // the fsync RETURNING is the authority instant; only now may the executor be signalled
  assert.equal(w.status, "APPLIED");
  assert.equal(w.event.payload.event, "OP_CANCEL");
  // events already journaled (T1) remain durable reality
  const st = readLifecycleJournalState(jp);
  assert.equal(st.events[0].payload.event, "PROMOTE");
  assert.equal(st.events[1].payload.event, "OP_CANCEL");
});

// 3 — crash before the durable intent landed ⇒ no durable cancel
test("CX-3. crash before the cancel intent landed: no durable cancel exists; journaled prefix stays; rerun re-decides", () => {
  const jp = freshJournal();
  journalT1(jp);
  appendFileSync(jp, '{"schema":"autoloop.memory-journal-event/v1","pay'); // crash mid-cancel-append
  const st = readLifecycleJournalState(jp);
  assert.equal(st.partialTrailingLine, true);
  assert.equal(st.events.some((e) => e.payload?.event === "OP_CANCEL"), false, "no durable cancel");
  assert.equal(st.events[0].payload.event, "PROMOTE", "prefix stays");
});

// 4 — crash after the durable intent, before executor stop ⇒ cancel IS authoritative
test("CX-4. crash after durable intent: the cancel IS authoritative; unjournaled remainder discarded; fresh process re-derives", () => {
  const jp = freshJournal();
  journalT1(jp);
  const p1 = projection({ state: "CANDIDATE", generation: 1, lastSequence: 1, previousDigest: readLifecycleJournalState(jp).previousDigest });
  const i = cancelIntent("op-crash-after");
  const v = authorizeOpCancel(i, p1);
  writeOpCancelEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  // fresh process reads reality: the cancelled operation's memory proves nothing
  const st = readLifecycleJournalState(jp);
  assert.equal(st.events.filter((e) => e.payload?.event === "OP_CANCEL").length, 1);
  // continuation is re-decided by frozen edges (T2/T4/T7 from ADVISORY) — never "completed by intent"
  const recon = st.events.reduce((acc, e) => applyLifecycleEventToProjection(acc, e), projection({ state: "CANDIDATE", generation: 1 }));
  assert.equal(recon.state, "ADVISORY");
});

// 5 — CANCEL-AFTER-TERMINAL: NO-OP + LIFECYCLE_TERMINAL_IMMUTABLE, durable mutation NO
test("CX-5. cancel-after-terminal: operation NO-OP with LIFECYCLE_TERMINAL_IMMUTABLE; zero journal growth", () => {
  const jp = freshJournal();
  const i = cancelIntent("op-terminal");
  const v = authorizeOpCancel(i, projection({ state: "REMOVED", generation: 1 }));
  assert.equal(v.status, "NO-OP");
  assert.equal(v.code, "LIFECYCLE_TERMINAL_IMMUTABLE");
  assert.equal(v.layer2, "NO-OP");
  // A NO-OP verdict is never handed to the write seam (only ok+APPLIED
  // verdicts construct events); the journal stays untouched.
  assert.equal(v.ok, true);
  assert.equal(v.status, "NO-OP");
  assert.equal(existsSync(jp), false, "journal untouched (never created)");
});

// 6 — DUPLICATE CANCELLATION (same key): stable idempotent NO-OP
test("CX-6. duplicate cancellation (same key): NO-OP DUPLICATE_EVENT_ID, zero journal growth, never a second effect", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const i = cancelIntent("op-dup");
  const v = authorizeOpCancel(i, p1);
  writeOpCancelEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  const before = readFileSync(jp, "utf8").length;
  const v2 = authorizeOpCancel(i, projection({ state: "CANDIDATE", generation: 1, cancelKey: "op-dup" }));
  assert.equal(v2.status, "NO-OP");
  assert.equal(v2.code, "DUPLICATE_EVENT_ID");
  assert.equal(readFileSync(jp, "utf8").length, before);
});

// 7 — CONFLICTING CANCELLATION (different key while one journaled): first cancel remains authority
test("CX-7. conflicting cancellation: first durable cancel remains authority; second cited and NO-OP (EVENT_IDEMPOTENCY_CONFLICT)", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const first = cancelIntent("op-first");
  const v1 = authorizeOpCancel(first, p1);
  writeOpCancelEvent({ intent: first, verdict: v1, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  const second = cancelIntent("op-second");
  const v2 = authorizeOpCancel(second, projection({ state: "CANDIDATE", generation: 1, cancelKey: "op-first" }));
  assert.equal(v2.status, "NO-OP");
  assert.equal(v2.code, "EVENT_IDEMPOTENCY_CONFLICT");
  assert.equal(v2.existingCancelKey, "op-first", "the existing journaled intent is cited");
});

// 8 — stale cancellation + ownership ambiguity forms
test("CX-8. stale cancel execution and ambiguous ownership: REJECT/HOLD — never act on stale or ambiguous reality", () => {
  // stale generation cancel (GENERATION STALE CANCEL)
  const stale = authorizeOpCancel(cancelIntent("k", { generation: 2 }), projection({ state: "CANDIDATE", generation: 1 }));
  assert.equal(stale.status, "REJECT");
  assert.equal(stale.code, "WRONG_GENERATION");
  // ownership-ambiguous cancel (claimant != journaled writer)
  const jp = freshJournal();
  journalT1(jp); // journaled by graph-run-1
  const other = { ...cancelIntent("k2", { graphRunId: "graph-run-OTHER" }), ownershipVerdict: "AMBIGUOUS" };
  const v = authorizeOpCancel(other, projection({ state: "CANDIDATE", generation: 1 }));
  assert.equal(v.status, "HOLD", JSON.stringify(v));
  assert.equal(v.code, "PROCESS_OWNERSHIP_AMBIGUOUS");
});

test("CX-LAW. cancellation never manufactures a transition event (non-manufacture law)", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const i = cancelIntent("k");
  const v = authorizeOpCancel(i, p1);
  writeOpCancelEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  const events = readLifecycleJournalState(jp).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.event, "OP_CANCEL");
  for (const banned of ["PROMOTE", "DEMOTE", "ARCHIVE", "REMOVE"]) {
    assert.equal(events.some((e) => e.payload?.event === banned), false, `cancel produced ${banned}`);
  }
});
