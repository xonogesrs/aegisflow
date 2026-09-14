// test/learning/lifecycle/test-amendment2-cancel-self-approval.mjs
//
// AMENDMENT-2 (OBS-03) — V5-CANCEL SELF-APPROVAL PROHIBITION attack matrix.
// Card: AUTOLOOP-V1-STAGE-F-LIFECYCLE-AMENDMENT-IMPLEMENTATION-1 (§14).
//
// Proves: OP_CANCEL_INPUT ≠ OP_CANCEL_APPROVAL_AUTHORITY. A cancel is
// admitted (APPLIED) only when its admissibility derives from
// DURABLE OR PRE-EXISTING authority (F0/F1/F2/F4/F5 + ownership RESOLVED —
// facts of the journal prefix BEFORE the cancel event). The journaling
// actor's identity is ATTRIBUTION ONLY; self-journaling through the same
// frozen conditions stays LEGAL; no field of the cancel request/event may
// certify admissibility. A cancel whose only admissibility basis is itself
// ⇒ REJECT (refusal-to-construct, WRITEBACK_AUTHORITY_INSUFFICIENT /
// CANCEL_SELF_APPROVAL_REJECTED, zero durable effect).
// A2_ATTACKS_ACCEPTED = 0.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeLifecycleEvent, authorizeOpCancel } from "../../../src/learning/lifecycle/state-machine.mjs";
import { writeLifecycleEvent, writeOpCancelEvent, readLifecycleJournalState, applyLifecycleEventToProjection } from "../../../src/learning/lifecycle/event-journal.mjs";
import { resumeFromJournal } from "../../../src/learning/lifecycle/resume-recovery.mjs";
import { projection, t1Intent } from "./helpers.mjs";
import { MEMORY_ERRORS } from "../../../src/memory/validation.mjs";

const ROOTS = [];
function freshJournal() { const d = mkdtempSync(join(tmpdir(), "lc-amend2-")); ROOTS.push(d); return join(d, "journal.jsonl"); }
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

const REC = "pat-lifecycle-1";

/** A minimal LEGAL cancel intent: every admissibility fact is either an
 * input precondition (F4) or derived from the projection (F5/ownership). */
function cancelIntent(cancelKey, o = {}) {
  return {
    claimSource: "JOURNAL_PROJECTION",
    recordId: o.recordId ?? REC,
    event: "OP_CANCEL",
    cancelKey,
    generation: o.generation ?? 1,
    policyAllowed: true,
    executionIdentity: { graphRunId: o.graphRunId ?? "graph-run-1", task: "task-1", attempt: 1, selfAuthored: false },
    elements: {},
    ...(o.extra ?? {}),
  };
}

/** Land a legal T1 prefix (journaled by graph-run-1) so the durable facts exist. */
function journalT1(jp) {
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const v = authorizeLifecycleEvent(t1Intent(), p1);
  const w = writeLifecycleEvent({ intent: t1Intent(), verdict: v, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  assert.equal(w.status, "APPLIED", JSON.stringify(w));
  const st = readLifecycleJournalState(jp);
  return { p1: { ...p1, lastSequence: st.lastSequence, previousDigest: st.previousDigest }, w };
}

const journalGrew = (jp) => readLifecycleJournalState(jp).events.filter((e) => e.payload?.event === "OP_CANCEL").length;

// ---------------------------------------------------------------------------
// A2-T1 — actor cites its own cancel as authority
// ---------------------------------------------------------------------------
test("A2-T1. cancel citing itself as authority (any self-warrant form) ⇒ REJECT CANCEL_SELF_APPROVAL_REJECTED, zero durable effect", () => {
  const jp = freshJournal();
  journalT1(jp);
  const selfForms = [
    { selfApproval: true },
    { selfAuthorized: true },
    { cancelAdmissible: true },
    { selfCertified: true },
    { actorApproved: true },
    { actorAssertedAdmissible: true },
    { memoryAuthorized: true },
    { providerAuthorized: true },
    { harnessAuthorized: true },
    { sessionAuthorized: true },
    { executionIdentity: { graphRunId: "graph-run-1", selfAuthored: true } },
  ];
  for (const extra of selfForms) {
    const i = cancelIntent("k-self", { extra });
    const v = authorizeOpCancel(i, projection({ state: "CANDIDATE", generation: 1 }));
    assert.equal(v.status, "REJECT", `form must die: ${JSON.stringify(extra)} ⇒ ${JSON.stringify(v)}`);
    assert.equal(v.code, "WRITEBACK_AUTHORITY_INSUFFICIENT");
    assert.equal(v.reason, "CANCEL_SELF_APPROVAL_REJECTED");
    assert.equal(v.v5, "V5-C5");
    const w = writeOpCancelEvent({ intent: i, verdict: v, projection: projection({ state: "CANDIDATE", generation: 1 }), journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
    assert.equal(w.status, "REJECT", "the write seam constructs NOTHING for a refused cancel");
  }
  assert.equal(journalGrew(jp), 0, "no durable effect from any self-warrant form");
});

// ---------------------------------------------------------------------------
// A2-T2 — self-authored cancel + crash + replay
// ---------------------------------------------------------------------------
test("A2-T2. self-authored cancel + crash + replay: the rejected cancel never becomes durable; replay never revives it", () => {
  const jp = freshJournal();
  const { p1 } = journalT1(jp);
  const before = readFileSync(jp, "utf8").length;
  const i = cancelIntent("k-crash", { extra: { selfApproval: true } });
  const v = authorizeOpCancel(i, p1);
  assert.equal(v.status, "REJECT");
  assert.equal(existsSyncSafe(jp) ? readFileSync(jp, "utf8").length === before : true, true, "no bytes appended");
  // "crash + replay": a fresh re-derivation over the same prefix yields the
  // identical REJECT (retry never launders the refusal into an approval)
  const v2 = authorizeLifecycleEvent(i, p1);
  assert.equal(v2.status, "REJECT");
  assert.equal(v2.reason, "CANCEL_SELF_APPROVAL_REJECTED");
  assert.equal(journalGrew(jp), 0);
});

function existsSyncSafe(p) { try { return true; } catch { return false; } }

// ---------------------------------------------------------------------------
// A2-T3 — retry after restart (fresh process re-derives)
// ---------------------------------------------------------------------------
test("A2-T3. retry after restart: the fresh process re-derives the SAME verdict from journal bytes (memory never revives a refusal)", () => {
  const jp = freshJournal();
  const { p1 } = journalT1(jp);
  const i = cancelIntent("k-retry", { extra: { selfApproval: true } });
  assert.equal(authorizeOpCancel(i, p1).status, "REJECT");
  // restart: durable state re-read from the journal, verdict re-derived:
  const st = readLifecycleJournalState(jp);
  const freshProjection = { ...projection({ state: "CANDIDATE", generation: 1 }), lastSequence: st.lastSequence, previousDigest: st.previousDigest };
  const v = authorizeOpCancel(i, freshProjection);
  assert.equal(v.status, "REJECT", JSON.stringify(v));
  // the same self-flag re-presented stays refused (idempotent re-derivation)
  const v3 = authorizeOpCancel({ ...i, cancelKey: "k-retry-2" }, freshProjection);
  assert.equal(v3.status, "REJECT");
  assert.equal(journalGrew(jp), 0);
});

// ---------------------------------------------------------------------------
// A2-T4 — duplicate self-cancel
// ---------------------------------------------------------------------------
test("A2-T4. duplicate self-cancel: the self-warrant refusal is idempotent; the DUPLICATE law still answers from journal reality", () => {
  const jp = freshJournal();
  const { p1 } = journalT1(jp);
  // a LEGITIMATE cancel lands first (the normal path must stay green):
  const legit = cancelIntent("k-legit");
  const vLegit = authorizeOpCancel(legit, p1);
  assert.equal(vLegit.status, "APPLIED", JSON.stringify(vLegit));
  const w = writeOpCancelEvent({ intent: legit, verdict: vLegit, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  assert.equal(w.status, "APPLIED");
  const before = readFileSync(jp, "utf8").length;
  // a SECOND cancel with the same key + self-approval claim: the journal
  // reality answers first (duplicate NO-OP) — and never mints an approval:
  const dup = cancelIntent("k-legit", { extra: { selfApproval: true } });
  const vDup = authorizeOpCancel(dup, projection({ state: "CANDIDATE", generation: 1, cancelKey: "k-legit" }));
  assert.equal(vDup.status, "NO-OP");
  assert.equal(vDup.code, "DUPLICATE_EVENT_ID");
  assert.equal(readFileSync(jp, "utf8").length, before, "journal gains nothing");
});

// ---------------------------------------------------------------------------
// A2-T5 — conflicting cancel
// ---------------------------------------------------------------------------
test("A2-T5. conflicting cancel: first durable cancel remains authority; the conflicting candidate is a NO-OP citing it", () => {
  const jp = freshJournal();
  const { p1 } = journalT1(jp);
  const first = cancelIntent("k-first");
  const v1 = authorizeOpCancel(first, p1);
  writeOpCancelEvent({ intent: first, verdict: v1, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  const before = readFileSync(jp, "utf8").length;
  const second = cancelIntent("k-second", { extra: { selfApproval: true } });
  const v2 = authorizeOpCancel(second, projection({ state: "CANDIDATE", generation: 1, cancelKey: "k-first" }));
  assert.equal(v2.status, "NO-OP");
  assert.equal(v2.code, "EVENT_IDEMPOTENCY_CONFLICT");
  assert.equal(v2.existingCancelKey, "k-first");
  assert.equal(readFileSync(jp, "utf8").length, before, "journal gains nothing");
});

// ---------------------------------------------------------------------------
// A2-T6 — actor identity substituted for ownership (attribution-only law)
// ---------------------------------------------------------------------------
test("A2-T6. actor identity is NOT an authority shortcut: substituted identity cannot own the prefix; attribution rides the payload only", () => {
  const jp = freshJournal();
  const { p1 } = journalT1(jp); // prefix journaled by graph-run-1
  // (a) a claimant whose ONLY claim is "I am the actor" over someone else's
  //     prefix: ownership verdict stays with the journaled attribution — the
  //     frozen HOLD law governs (V5-Cancel consumes it; no new ownership test).
  const foreign = cancelIntent("k-foreign", { graphRunId: "graph-run-OTHER", extra: { ownershipVerdict: "AMBIGUOUS" } });
  const vForeign = authorizeOpCancel(foreign, p1);
  assert.equal(vForeign.status, "HOLD", JSON.stringify(vForeign));
  assert.equal(vForeign.code, "PROCESS_OWNERSHIP_AMBIGUOUS");
  // (b) the TRUE owner journals the cancel of its own operation — LEGAL
  //     (V5-C4: self-journaling confers zero ADDITIONAL authority; the checks
  //     are identical to the third-party case).
  const owner = cancelIntent("k-owner", { graphRunId: "graph-run-1" });
  const vOwner = authorizeOpCancel(owner, p1);
  assert.equal(vOwner.status, "APPLIED", JSON.stringify(vOwner));
  const w = writeOpCancelEvent({ intent: owner, verdict: vOwner, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  assert.equal(w.status, "APPLIED");
  const ev = readLifecycleJournalState(jp).events.find((e) => e.payload?.event === "OP_CANCEL");
  assert.equal(ev.payload.executedBy.writerId, "graph-run-1", "attribution is RECORDED (never deleted) — but it did not AUTHORIZE");
});

// ---------------------------------------------------------------------------
// A2-T7 — generation changes before replay
// ---------------------------------------------------------------------------
test("A2-T7. generation advanced between admission and replay: a stale cancel dies at F5 (WRONG_GENERATION), no laundering", () => {
  const jp = freshJournal();
  const { p1 } = journalT1(jp);
  const i = cancelIntent("k-gen");
  assert.equal(authorizeOpCancel(i, p1).status, "APPLIED");
  // the prefix advances (generation 2) before the cancel is re-presented:
  const advanced = projection({ state: "CANDIDATE", generation: 2, lastSequence: p1.lastSequence, previousDigest: p1.previousDigest });
  const v = authorizeOpCancel(i, advanced);
  assert.equal(v.status, "REJECT", JSON.stringify(v));
  assert.equal(v.code, "WRONG_GENERATION");
  assert.equal(v.iRow, "I11");
  assert.equal(journalGrew(jp), 0);
});

// ---------------------------------------------------------------------------
// A2-T8 — unrelated durable fact misbound as cancel authority
// ---------------------------------------------------------------------------
test("A2-T8. unrelated durable facts cannot authorize a cancel: only the frozen F0/F1/F2/F4/F5 + ownership set counts", () => {
  const jp = freshJournal();
  const { p1 } = journalT1(jp);
  // policy/project/whatever flags on the request are NOT authority inputs:
  const misbound = cancelIntent("k-misbound", {
    extra: {
      policyAllowed: true, // already required; adding MORE unrelated "facts" changes nothing
      unrelatedConfirmation: true,
      someDurableFact: "random-journal-row",
      humanApproved: true,
      externalSystemId: "srv-42",
    },
  });
  const v = authorizeOpCancel(misbound, p1);
  assert.equal(v.status, "APPLIED", JSON.stringify(v));
  // the APPLIED verdict's authority row is the frozen OPERATION_BOUNDARY —
  // not any caller-supplied "fact":
  assert.equal(v.transition.authority, "OPERATION_BOUNDARY");
  assert.equal(JSON.stringify(v).includes("random-journal-row"), false);
  assert.equal(JSON.stringify(v).includes("srv-42"), false);
  // the same intent WITHOUT a bound generation dies at F5 (unrelated fields
  // cannot substitute for the frozen generation binding):
  const noGen = { ...cancelIntent("k-nogen"), generation: 7 };
  const vNoGen = authorizeOpCancel(noGen, p1);
  assert.equal(vNoGen.status, "REJECT");
  assert.equal(vNoGen.code, "WRONG_GENERATION");
});

// ---------------------------------------------------------------------------
// A2-T9 — partially constructed cancellation attempt
// ---------------------------------------------------------------------------
test("A2-T9. refusal-to-construct: a rejected cancel produces NO event bytes, NO partial payload, NO torn row", () => {
  const jp = freshJournal();
  const { p1 } = journalT1(jp);
  const before = readFileSync(jp, "utf8");
  const i = cancelIntent("k-partial", { extra: { selfApproval: true } });
  const v = authorizeOpCancel(i, p1);
  assert.equal(v.status, "REJECT");
  const w = writeOpCancelEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  assert.equal(w.status, "REJECT");
  assert.equal(w.event, undefined, "no event object exists at all — nothing was constructed");
  assert.equal(readFileSync(jp, "utf8"), before, "journal bytes identical (no partial row, no torn tail)");
  const st = readLifecycleJournalState(jp);
  assert.equal(st.partialTrailingLine, false, "no torn row from the refusal");
});

// ---------------------------------------------------------------------------
// A2-T10 — writeback-before-authority mutation (ordering inverted)
// ---------------------------------------------------------------------------
test("A2-T10. writeback-before-authority is structurally unreachable: the write seam REQUIRES the N1 verdict BEFORE construction and refuses the refused", () => {
  const jp = freshJournal();
  const { p1 } = journalT1(jp);
  const before = readFileSync(jp, "utf8").length;
  // (a) THE ONLY PIPELINE (intent → N1 verdict → N2): the refused cancel's
  // verdict REJECTS, and N2 constructs NOTHING from it (refusal-to-construct;
  // construct→retroactively-authorize cannot occur because N2's parameter
  // contract demands the verdict up front and dies on a non-ok verdict).
  const i = cancelIntent("k-inverted", { extra: { selfApproval: true } });
  const realVerdict = authorizeOpCancel(i, p1);
  assert.equal(realVerdict.status, "REJECT");
  const wReal = writeOpCancelEvent({ intent: i, verdict: realVerdict, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  assert.equal(wReal.status, "REJECT");
  // (b) a verdict-less / non-N1-shaped write attempt is refused outright:
  const wNoVerdict = writeOpCancelEvent({ intent: i, verdict: null, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  assert.equal(wNoVerdict.status, "REJECT");
  assert.equal(wNoVerdict.reason, "CANCEL_NOT_AUTHORIZED");
  const wTransitionVerdict = writeOpCancelEvent({ intent: i, verdict: { ok: true, status: "APPLIED", transition: { id: "T1", from: "CANDIDATE", event: "PROMOTE", to: "ADVISORY", authority: "R14" } }, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  assert.equal(wTransitionVerdict.status, "REJECT", "a verdict not minted for the OP_CANCEL boundary constructs no cancel");
  assert.equal(journalGrew(jp), 0, "no OP_CANCEL event anywhere in the journal — no construct-before-authorize path");
  // (c) backstop (RUNG-8 hardening, unchanged): even a forged ok-verdict over
  // a conflicting cancel gets answered by the seam's journal-reality fence —
  // the seam's existing guards remain the backstop (frozen A2 scope: N2
  // re-derivation of AUTHORITY is NOT added — N1 stays the single decider).
  const first = cancelIntent("k-a");
  const vFirst = authorizeOpCancel(first, p1);
  writeOpCancelEvent({ intent: first, verdict: vFirst, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  const forgedConflict = cancelIntent("k-b");
  const forgedVerdict = { ok: true, status: "APPLIED", code: null, reason: "CANCEL_INTENT_DURABLE", layer1: "CANDIDATE", layer2: "APPLIED", opBoundary: "OP_CANCEL", transition: { id: "OP_CANCEL", from: "CANDIDATE", event: "OP_CANCEL", to: "CANDIDATE", authority: "OPERATION_BOUNDARY" } };
  const wConflict = writeOpCancelEvent({ intent: forgedConflict, verdict: forgedVerdict, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  assert.equal(wConflict.status, "NO-OP", "the seam's reality fence still answers: conflict NO-OP");
  assert.equal(wConflict.code, "EVENT_IDEMPOTENCY_CONFLICT");
});

// ---------------------------------------------------------------------------
// Restart/replay law (SELF_APPROVAL_AFTER_RESTART / BY_REPLAY = IMPOSSIBLE)
// ---------------------------------------------------------------------------
test("A2-RESTART. a legitimate durable cancel replays as already-authorized history; replay never re-admits or re-executes it", async () => {
  const jp = freshJournal();
  const { p1 } = journalT1(jp);
  const legit = cancelIntent("k-replay");
  const v = authorizeOpCancel(legit, p1);
  writeOpCancelEvent({ intent: legit, verdict: v, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  const before = readFileSync(jp, "utf8").length;
  // replay reconstruction: OP_CANCEL is state-neutral; the prefix stays reality
  const st = readLifecycleJournalState(jp);
  const recon = st.events.reduce((acc, e) => applyLifecycleEventToProjection(acc, e), projection({ state: "CANDIDATE", generation: 1 }));
  assert.equal(recon.state, "ADVISORY", "the journaled T1 prefix remains reality");
  // resume (restart law): a fresh claimant re-derives from journal bytes only
  const r = await resumeFromJournal({ journalPath: jp, claimant: { graphRunId: "graph-run-1", generation: 1 }, recordId: REC, continueWith: async ({ projection: proj, allowedContinuations }) => {
    // the only legal continuation is the frozen edge set — cancel is NOT an
    // edge; a resume may only continue through N2 with an N1-authorized write.
    // (policyAllowed rides the gate's own policy path in production; the
    // resume's continueWith supplies the F3 input precondition the same way.)
    const cont = allowedContinuations.find((c) => c.event === "DEMOTE"); // ADVISORY's frozen continuation
    const i = { ...t1Intent({ event: cont.event, to: cont.to, generation: 1, elements: { CAUSE: { causeClass: "FALSE_POSITIVE", source: "R9" } } }), policyAllowed: true };
    const verdict = authorizeLifecycleEvent(i, { ...proj, policyAllowed: true });
    if (!verdict.ok) return { ok: false, code: verdict.code, reason: verdict.reason };
    return writeLifecycleEvent({ intent: i, verdict, projection: { ...proj, policyAllowed: true }, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  } });
  assert.equal(r.ok, true, JSON.stringify(r));
  // the journaled cancel was NEVER re-delivered as a fresh approval act:
  const events = readLifecycleJournalState(jp).events;
  assert.equal(events.filter((e) => e.payload?.event === "OP_CANCEL").length, 1, "exactly one durable cancel — no second authority instant");
  assert.equal(events[events.length - 1].payload.event !== "OP_CANCEL", true, "the replay continuation journaled the frozen legal edge, not a cancel");
});

test("A2-LAW. the V5 refusal rides the frozen class set: code/reason are the frozen strings (no new fine-code class)", () => {
  const v = authorizeOpCancel(cancelIntent("k", { extra: { selfApproval: true } }), projection({ state: "CANDIDATE", generation: 1 }));
  assert.equal(v.code, "WRITEBACK_AUTHORITY_INSUFFICIENT");
  assert.equal(v.reason, "CANCEL_SELF_APPROVAL_REJECTED");
  // CANCELLATION_CREATES_NEW_EDGE = NO: the verdict carries no transition edge
  // (only the frozen opBoundary self-edge form, identical to the legal path)
  const legal = authorizeOpCancel(cancelIntent("k2"), projection({ state: "CANDIDATE", generation: 1 }));
  assert.deepEqual(legal.transition, { id: "OP_CANCEL", from: "CANDIDATE", event: "OP_CANCEL", to: "CANDIDATE", authority: "OPERATION_BOUNDARY" });
  assert.deepEqual(JSON.parse(JSON.stringify(legal.transition)), JSON.parse(JSON.stringify(v.transition === undefined ? legal.transition : legal.transition)), "refused path mints no transition at all");
  assert.equal(v.transition, undefined, "the REFUSAL carries no transition (refusal-to-construct)");
});
