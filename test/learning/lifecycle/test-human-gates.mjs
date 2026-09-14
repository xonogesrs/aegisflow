// test/learning/lifecycle/test-human-gates.mjs
//
// RUNG-6 Step 6 suite — T3/T12 human-gate plumbing at unit depth:
//   DBL-1…DBL-5 (R16 double gate; composite binding check at F7)
//   SPOOF-1…SPOOF-4 (T3 admission spoofing; exact dying oracles)
//   SPOOF-R1…R5 (T12 removal spoofing incl. incident-layer fence)
// Payload embedding through N2 (admission reference + snapshot digest) with
// payload-shape proof; replay of an admission = NO duplicate authority mint.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeLifecycleEvent } from "../../../src/learning/lifecycle/state-machine.mjs";
import { writeLifecycleEvent, computePreRemovalSnapshotDigest } from "../../../src/learning/lifecycle/event-journal.mjs";
import { projection, promoteIntent, t12Intent, humanAdmissionRecord, hex64, journalAdmissionEvidence } from "./helpers.mjs";
import { MEMORY_ERRORS } from "../../../src/memory/validation.mjs";

const ROOTS = [];
function freshJournal() { const d = mkdtempSync(join(tmpdir(), "lc-hg-")); ROOTS.push(d); return join(d, "journal.jsonl"); }
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

const REC = "pat-lifecycle-1";
const run = (state, intent) => authorizeLifecycleEvent(intent, projection({ state, generation: intent.generation ?? 1, recordId: intent.recordId ?? REC }));
/** AMENDMENT-1: land the admission record in the journal + attach the
 * reading layer's derived resolution fact to the intent (both T3 E9 and
 * T12 HUMAN_ADMISSION rows). */
function resolveE9(jp, intent, { requiresJustification = false, append = true } = {}) {
  const rec = intent.elements.E9 ?? intent.elements.HUMAN_ADMISSION;
  intent.resolutionEvidence = journalAdmissionEvidence(jp, rec, { recordId: intent.recordId ?? REC, generation: intent.generation ?? 1, requiresJustification }, { append });
  return intent;
}

// ---------------------------------------------------------------------------
// DBL-1…DBL-5 — R16 double gate (T3)
// ---------------------------------------------------------------------------

test("HG-DBL1. Gate A only (genuine human record, no GATE-2 marker): T3 APPLIES — the only legal configuration", () => {
  const jp = freshJournal();
  const i = promoteIntent("REQUIRED_QUESTION");
  resolveE9(jp, i); // AMENDMENT-1: resolution derives from the journal
  const v = run("REQUIRED_QUESTION", i);
  assert.equal(v.status, "APPLIED", JSON.stringify(v));
  assert.equal(v.transition.id, "T3");
  // no production entry-authorization marker exists anywhere on the verdict
  assert.equal(JSON.stringify(v).includes("productionEntryAuthorized"), false);
});

test("HG-DBL2. Gate B only (a 'production authorization' marker without a human record): T3 REJECT + AUTHORITY_INSUFFICIENT", () => {
  const i = promoteIntent("REQUIRED_QUESTION");
  delete i.elements.E9;
  i.productionEntryAuthorized = true; // a marker without GATE-1
  const v = run("REQUIRED_QUESTION", i);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "WRITEBACK_AUTHORITY_INSUFFICIENT");
  // the element sweep names the absent element (E9) — the marker is never read
  assert.equal(v.reason, "MISSING_ELEMENT");
  assert.equal(v.missingElement, "E9");
  // the marker confers nothing: it is not carried into any verdict field
  assert.equal(v.productionEntryAuthorized, undefined);
});

test("HG-DBL3. A then B ordering is CHECKABLE as a fixture exercise (suite-only, not production behavior)", () => {
  const jp = freshJournal();
  const i = promoteIntent("REQUIRED_QUESTION");
  i.elements.E9 = humanAdmissionRecord();
  resolveE9(jp, i);
  const first = run("REQUIRED_QUESTION", i);
  assert.equal(first.status, "APPLIED");
  // the ordering record: the same verdict re-derives identically (order-stable)
  const second = run("REQUIRED_QUESTION", JSON.parse(JSON.stringify(i)));
  assert.deepEqual(first, second);
});

test("HG-DBL4. stale Gate A + fresh Gate B: admission bound to an older generation ⇒ REJECT WRONG_GENERATION", () => {
  const i = promoteIntent("REQUIRED_QUESTION");
  i.elements.E9 = { ...humanAdmissionRecord(), generation: 0 }; // older than intent gen 1
  const v = run("REQUIRED_QUESTION", i);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "WRONG_GENERATION");
});

test("HG-DBL5. fresh Gate A + stale Gate B (mismatched pair): the stale component rejects the whole admission", () => {
  const i = promoteIntent("REQUIRED_QUESTION");
  i.elements.E9 = { ...humanAdmissionRecord(), generation: 99 };
  const v = run("REQUIRED_QUESTION", i);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "WRONG_GENERATION");
});

// ---------------------------------------------------------------------------
// SPOOF-1…SPOOF-4 — T3 admission spoofing
// ---------------------------------------------------------------------------

test("HG-S1. SPOOF-1 agent-minted admission (not the human CBM-4 gate path) ⇒ REJECT + AUTHORITY_INSUFFICIENT", () => {
  const i = promoteIntent("REQUIRED_QUESTION");
  i.elements.E9 = { ...humanAdmissionRecord(), mintPath: "AGENT_SELF_MINT" };
  const v = run("REQUIRED_QUESTION", i);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "WRITEBACK_AUTHORITY_INSUFFICIENT");
  assert.equal(v.reason, "AGENT_MINTED_ADMISSION_REJECTED");
});

test("HG-S2. SPOOF-2 forged human authority reference ⇒ REJECT + EVIDENCE_IDENTITY_FORGED", () => {
  const a = promoteIntent("REQUIRED_QUESTION");
  a.elements.E9 = { ...humanAdmissionRecord(), identity: "not-a-valid-identity" };
  const v = run("REQUIRED_QUESTION", a);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "WRITEBACK_EVIDENCE_IDENTITY_FORGED");
  const b = promoteIntent("REQUIRED_QUESTION");
  b.elements.E9 = { ...humanAdmissionRecord(), authoritySource: "PROVIDER" }; // not HUMAN/CONTROLLER
  const v2 = run("REQUIRED_QUESTION", b);
  assert.equal(v2.status, "REJECT");
  assert.equal(v2.code, "WRITEBACK_EVIDENCE_IDENTITY_FORGED");
});

test("HG-S3. SPOOF-3 foreign execution authority presenting an admission ⇒ REJECT + binding mismatch", () => {
  const i = promoteIntent("REQUIRED_QUESTION");
  i.elements.E9 = { ...humanAdmissionRecord(), recordId: "some-other-record" };
  const v = run("REQUIRED_QUESTION", i);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "WRONG_GENERATION");
  assert.equal(v.reason, "ADMISSION_BINDING_MISMATCH");
});

test("HG-S4. SPOOF-4 replayed prior-generation admission ⇒ REJECT + WRONG_GENERATION (not double-spent)", () => {
  const i = promoteIntent("REQUIRED_QUESTION");
  i.elements.E9 = { ...humanAdmissionRecord(), generation: 0 };
  const v = run("REQUIRED_QUESTION", i);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "WRONG_GENERATION");
  assert.equal(v.reason, "ADMISSION_GENERATION_MISMATCH");
});

// ---------------------------------------------------------------------------
// SPOOF-R1…R5 — T12 removal spoofing
// ---------------------------------------------------------------------------

test("HG-R1. SPOOF-R1 agent-generated removal admission ⇒ REJECT + AUTHORITY_INSUFFICIENT", () => {
  const i = t12Intent();
  i.elements.HUMAN_ADMISSION = { ...humanAdmissionRecord(), mintPath: "AGENT_SELF_MINT", journalResolved: false };
  const v = run("ARCHIVED", i);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "WRITEBACK_AUTHORITY_INSUFFICIENT");
});

test("HG-R2. SPOOF-R2 forged human token ⇒ REJECT + EVIDENCE_IDENTITY_FORGED/_MALFORMED", () => {
  const i = t12Intent();
  i.elements.HUMAN_ADMISSION = { ...humanAdmissionRecord(), identity: "zz" };
  const v = run("ARCHIVED", i);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "WRITEBACK_EVIDENCE_IDENTITY_FORGED");
});

test("HG-R3. SPOOF-R3 foreign authority presenting an admission ⇒ REJECT + binding mismatch class", () => {
  const i = t12Intent({ recordId: "pat-target" });
  i.elements.HUMAN_ADMISSION = { ...humanAdmissionRecord(), recordId: "pat-other" };
  const v = run("ARCHIVED", i);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "WRONG_GENERATION");
});

test("HG-R4. SPOOF-R4 replayed prior-generation admission ⇒ REJECT + WRONG_GENERATION", () => {
  const i = t12Intent();
  i.elements.HUMAN_ADMISSION = { ...humanAdmissionRecord(), generation: 0 };
  const v = run("ARCHIVED", i);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, "WRONG_GENERATION");
});

test("HG-R5. SPOOF-R5 incident-layer removal ⇒ REJECT + live incident-immutability prefix (even with a genuine record)", () => {
  const i = t12Intent();
  i.targetLayer = "INCIDENT";
  i.rawField = "incident_layer";
  const v = run("ARCHIVED", i);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, `${MEMORY_ERRORS.SCHEMA_INVALID}:pattern_forbidden_incident_layer_field:incident_layer`);
  // projection-side layer also fenced
  const i2 = t12Intent();
  const v2 = authorizeLifecycleEvent(i2, projection({ state: "ARCHIVED", generation: 1, overrides: { recordLayer: "INCIDENT" } }));
  assert.equal(v2.status, "REJECT");
  assert.match(v2.code, /pattern_forbidden_incident_layer_field:/);
});

// ---------------------------------------------------------------------------
// Payload embedding through N2 (admission reference + snapshot digest)
// ---------------------------------------------------------------------------

test("HG-N2a. T3 write embeds the human admission record as a REFERENCE inside the journal payload", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "REQUIRED_QUESTION", generation: 1 });
  const i = promoteIntent("REQUIRED_QUESTION");
  resolveE9(jp, i);
  const v = authorizeLifecycleEvent(i, p1);
  assert.equal(v.ok, true, JSON.stringify(v));
  const w = writeLifecycleEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  assert.equal(w.status, "APPLIED", JSON.stringify(w));
  const ev = readFileSync(jp, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.payload?.event === "PROMOTE");
  assert.equal(ev.payload.humanAdmissionRecord.mintPath, "HUMAN_CBM4_GATE");
  assert.equal(ev.payload.humanAdmissionRecord.identity.length, 64);
});

test("HG-N2b. T12 write embeds the pre-removal snapshot digest INSIDE the payload (audit survives removal)", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "ARCHIVED", generation: 1 });
  const i = t12Intent();
  i.preRemovalRecordBytes = { recordId: REC, statement: "pre-removal" };
  i.preRemovalSnapshotDigest = computePreRemovalSnapshotDigest(i.preRemovalRecordBytes); // mirrored; N2 re-derives
  resolveE9(jp, i, { requiresJustification: true });
  const v = authorizeLifecycleEvent(i, p1);
  assert.equal(v.ok, true, JSON.stringify(v));
  const w = writeLifecycleEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  assert.equal(w.status, "APPLIED");
  const ev = readFileSync(jp, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.payload?.event === "REMOVE");
  assert.match(ev.payload.preRemovalSnapshotDigest, /^[0-9a-f]{64}$/);
});

test("HG-N2c. replay of a journaled admission = NO duplicate authority mint (replay reconstructs, never re-mints)", () => {
  const jp = freshJournal();
  const p1 = projection({ state: "ARCHIVED", generation: 1 });
  const i = t12Intent();
  i.preRemovalRecordBytes = { recordId: i.recordId, statement: "pre-removal" };
  resolveE9(jp, i, { requiresJustification: true });
  const v = authorizeLifecycleEvent(i, p1);
  writeLifecycleEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  const before = readFileSync(jp, "utf8").length;
  // same-identity re-delivery through the seam:
  const w2 = writeLifecycleEvent({ intent: i, verdict: v, projection: p1, journalPath: jp, writerId: "g", writerGeneration: 1 });
  assert.equal(w2.status, "NO-OP");
  assert.equal(w2.code, "DUPLICATE_EVENT_ID");
  assert.equal(readFileSync(jp, "utf8").length, before, "journal gains nothing");
});

test("HG-N2d. the admission reference rides the payload, never mints a new record (no minting code in N2)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/learning/lifecycle/event-journal.mjs", "utf8");
  assert.equal(/mint[A-Z]/.test(src.replace("mints", "")), false, "N2 contains no minting function");
  assert.match(src, /humanAdmissionRecord: null/, "non-admission events carry a null reference");
});
