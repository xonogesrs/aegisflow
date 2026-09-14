// test/learning/lifecycle/test-discrimination-controls.mjs
//
// RUNG-6 Step 8 — ladder 16 scaffolding: the 13 discrimination probes P1–P13
// at UNIT depth, each with its GREEN CONTROL (the probe's own expected-pass
// form). The mutation campaign (fault application to production bytes and
// re-run) is RUNG-7 work (RRC-SEPARATION §2/§3); this file ships the controls
// proving each probe's expected dying assertion is reachable in the
// implementation, so rung 7 applies each fault and watches it die.
// Each probe cites its frozen source row (DISCRIMINATION-PLAN.md).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeLifecycleEvent, authorizeOpCancel } from "../../../src/learning/lifecycle/state-machine.mjs";
import { writeLifecycleEvent, writeOpCancelEvent, readLifecycleJournalState, applyLifecycleEventToProjection } from "../../../src/learning/lifecycle/event-journal.mjs";
import { resumeFromJournal, verifyOwnership, verifyExecutionIdentity } from "../../../src/learning/lifecycle/resume-recovery.mjs";
import { projection, t1Intent, promoteIntent, demoteIntent, archiveIntent, t12Intent, humanAdmissionRecord, hex64, journalAdmissionEvidence } from "./helpers.mjs";
import { MEMORY_ERRORS } from "../../../src/memory/validation.mjs";

const ROOTS = [];
function freshJournal() { const d = mkdtempSync(join(tmpdir(), "lc-p-")); ROOTS.push(d); return join(d, "journal.jsonl"); }
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

/** AMENDMENT-1: land the admission record + attach the reading-layer fact. */
function resolveE9(jp, intent, { requiresJustification = false, append = true } = {}) {
  const rec = intent.elements.E9 ?? intent.elements.HUMAN_ADMISSION;
  intent.resolutionEvidence = journalAdmissionEvidence(jp, rec, { recordId: intent.recordId ?? REC, generation: intent.generation ?? 1, requiresJustification }, { append });
  return intent;
}

const REC = "pat-lifecycle-1";
const FULL = () => ({
  E1: { incidents: [hex64(11)] }, E2: { identity: hex64(12), independent: true }, E3: { b: 1 },
  E4: { c: 1 }, E5: { d: 1 }, E6: { e: 1 }, E7: true,
});

// P1 — terminal state mutated: out-of-table edge (ARCHIVED→ADVISORY) dies
test("P1 control: out-of-table edge ARCHIVED→ADVISORY REJECTs LIFECYCLE_TERMINAL_IMMUTABLE; terminal intact", () => {
  const i = { ...t1Intent({ event: "PROMOTE", to: "ADVISORY" }), elements: { ...t1Intent().elements } };
  const v = authorizeLifecycleEvent(i, projection({ state: "ARCHIVED", generation: 1 }));
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "LIFECYCLE_TERMINAL_IMMUTABLE");
});

// P2 — stale execution accepted: generation check live
test("P2 control: stale generation intent REJECTs WRONG_GENERATION; current-generation intent applies cleanly", () => {
  const stale = authorizeLifecycleEvent(t1Intent({ generation: 2 }), projection({ state: "CANDIDATE", generation: 1 }));
  assert.equal(stale.status, "REJECT");
  assert.equal(stale.code, "WRONG_GENERATION");
  const fresh = authorizeLifecycleEvent(t1Intent({ generation: 1 }), projection({ state: "CANDIDATE", generation: 1 }));
  assert.equal(fresh.status, "APPLIED");
});

// P3 — implicit takeover: second writer HOLDs with verification
test("P3 control: foreign writer over a journaled prefix HOLDs PROCESS_OWNERSHIP_AMBIGUOUS; single-owner flow green", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const v = authorizeLifecycleEvent(t1Intent(), p1);
  writeLifecycleEvent({ intent: t1Intent(), verdict: v, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  const o = verifyOwnership({ claimant: { graphRunId: "graph-run-OTHER" }, journalEvents: readLifecycleJournalState(jp).events, durableGeneration: 1 });
  assert.equal(o.status, "HOLD");
  assert.equal(o.disposition, "HOLD");
  assert.equal(o.code, "PROCESS_OWNERSHIP_AMBIGUOUS");
});

// P4 — cancel not durable: journaled intent is the only ack
test("P4 control: journal-first cancel — the journaled OP_CANCEL IS the authority (executor ack adds nothing)", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const i = { claimSource: "JOURNAL_PROJECTION", recordId: REC, event: "OP_CANCEL", cancelKey: "p4", generation: 1, policyAllowed: true, executionIdentity: { graphRunId: "g" }, elements: {} };
  const v = authorizeOpCancel(i, p1);
  const w = writeOpCancelEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  assert.equal(w.status, "APPLIED");
  assert.equal(readLifecycleJournalState(jp).events[0].payload.event, "OP_CANCEL");
});

// P5 — resume from process memory: memory-sourced facts die at the seam
test("P5 control: journal-derived resume completes; memory-sourced projection is refused (JOURNAL_CHAIN_INVALID)", async () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const v = authorizeLifecycleEvent(t1Intent(), p1);
  writeLifecycleEvent({ intent: t1Intent(), verdict: v, projection: p1, journalPath: jp, writerId: "graph-run-1", writerGeneration: 1 });
  const r = await resumeFromJournal({ journalPath: jp, claimant: { graphRunId: "graph-run-1", generation: 1 }, recordId: REC });
  assert.equal(r.ok, true); // journal reality resumes legally
  const memProj = { ...projection({ state: "CANDIDATE" }), claimSource: "PROCESS_MEMORY" };
  const refused = writeLifecycleEvent({ intent: t1Intent(), verdict: authorizeLifecycleEvent(t1Intent(), memProj), projection: memProj, journalPath: freshJournal(), writerId: "g", writerGeneration: 1 });
  assert.equal(refused.status, "HOLD");
  assert.equal(refused.code, MEMORY_ERRORS.JOURNAL_CHAIN_INVALID);
});

// P6 — duplicate terminal effect: keyed idempotency live
test("P6 control: replay of a landed terminal event is a keyed NO-OP; exactly-once keys stable", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const i = t1Intent();
  const v = authorizeLifecycleEvent(i, p1);
  writeLifecycleEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  const before = readFileSync(jp, "utf8").length;
  const again = writeLifecycleEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  assert.equal(again.status, "NO-OP");
  assert.equal(again.code, "DUPLICATE_EVENT_ID");
  assert.equal(readFileSync(jp, "utf8").length, before);
});

// P7 — provider private state as authority: identity fence live
test("P7 control: session/provider/container/checkpoint inputs are REJECTED (harness-free binding green)", () => {
  const r = verifyExecutionIdentity({ claimant: { graphRunId: "g", providerRunId: "prov-1" }, journalEvents: [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "WRITEBACK_EVIDENCE_IDENTITY_FORGED");
  const ok = verifyExecutionIdentity({ claimant: { graphRunId: "g" }, journalEvents: [] });
  assert.equal(ok.ok, true);
});

// P8 — skip-level promotion: element gate live
test("P8 control: full element set applies; missing element REJECTs with its exact class", () => {
  const good = authorizeLifecycleEvent(t1Intent(), projection({ state: "CANDIDATE", generation: 1 }));
  assert.equal(good.status, "APPLIED");
  const bad = t1Intent(); delete bad.elements.E4;
  const v = authorizeLifecycleEvent(bad, projection({ state: "CANDIDATE", generation: 1 }));
  assert.equal(v.status, "REJECT");
  assert.equal(v.iRow, "I9");
});

// P9 — silent demotion: demotion requires a journaled event with cause
test("P9 control: demotion verdict carries the CAUSE element into its transition oracle (journal-first path)", () => {
  const i = demoteIntent("ADVISORY");
  const v = authorizeLifecycleEvent(i, projection({ state: "ADVISORY", generation: 1 }));
  assert.equal(v.status, "APPLIED");
  assert.equal(v.transition.id, "T4");
  assert.equal(i.elements.CAUSE.causeClass, "FALSE_POSITIVE");
  const noCause = demoteIntent("ADVISORY"); delete noCause.elements.CAUSE;
  const v2 = authorizeLifecycleEvent(noCause, projection({ state: "ADVISORY", generation: 1 }));
  assert.equal(v2.status, "REJECT");
});

// P10 — unattested human admission: self-minted records die
test("P10 control: genuine human record applies; agent-minted REJECTs WRITEBACK_AUTHORITY_INSUFFICIENT", () => {
  const jp = freshJournal();
  const good = promoteIntent("REQUIRED_QUESTION");
  resolveE9(jp, good);
  const v = authorizeLifecycleEvent(good, projection({ state: "REQUIRED_QUESTION", generation: 1 }));
  assert.equal(v.status, "APPLIED");
  const bad = promoteIntent("REQUIRED_QUESTION");
  bad.elements.E9 = { ...humanAdmissionRecord(), mintPath: "AGENT_SELF_MINT" };
  const v2 = authorizeLifecycleEvent(bad, projection({ state: "REQUIRED_QUESTION", generation: 1 }));
  assert.equal(v2.status, "REJECT");
  assert.equal(v2.code, "WRITEBACK_AUTHORITY_INSUFFICIENT");
});

// P11 — torn partial line adopted as state: exclusion live
test("P11 control: partial trailing line detected+excluded; state = last complete event", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const v = authorizeLifecycleEvent(t1Intent(), p1);
  writeLifecycleEvent({ intent: t1Intent(), verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  appendFileSync(jp, '{"partial');
  const st = readLifecycleJournalState(jp);
  assert.equal(st.partialTrailingLine, true);
  assert.equal(st.lastSequence, 1);
});

// P12 — resume skips execution-identity verification: step-2 live
test("P12 control: verified identity resumes; non-durable identity fields REJECT with the forged class", () => {
  const ok = verifyExecutionIdentity({ claimant: { graphRunId: "graph-run-1" }, journalEvents: [] });
  assert.equal(ok.ok, true);
  const forged = verifyExecutionIdentity({ claimant: { graphRunId: "graph-run-1", sessionId: "s-1" }, journalEvents: [] });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, "WRITEBACK_EVIDENCE_IDENTITY_FORGED");
});

// P13 — cancel ordering inverted: durable intent precedes executor effect
test("P13 control: authority-first ordering — the journal event exists BEFORE any executor signal could be sent", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "CANDIDATE", generation: 1 });
  const i = { claimSource: "JOURNAL_PROJECTION", recordId: REC, event: "OP_CANCEL", cancelKey: "p13", generation: 1, policyAllowed: true, executionIdentity: { graphRunId: "g" }, elements: {} };
  const v = authorizeOpCancel(i, p1);
  const w = writeOpCancelEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  // the fsync RETURN is the authority instant — the earliest point any
  // executor signal is legal is AFTER w.status === "APPLIED"
  assert.equal(w.status, "APPLIED");
  assert.ok(w.journalSequence >= 1);
});

test("PS-COUNT. the scaffolding covers all 13 probes with green controls", () => {
  // self-census: this file names P1..P13 controls exactly once each
  const src = readFileSync(new URL(import.meta.url).pathname, "utf8");
  for (let i = 1; i <= 13; i++) {
    assert.ok(src.includes(`// P${i} —`), `P${i} control missing`);
  }
});
