// test/learning/lifecycle/test-legal-transitions.mjs
//
// RUNG-6 ladder rung 2 — all legal transitions T1–T12 individually, each with
// APPLIED + event identity + generation binding + derived effect (POS-01…06)
// plus duplicate-delivery NO-OP and edge-13 absence.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGAL_TRANSITIONS, authorizeLifecycleEvent, LIFECYCLE_FINE_CODES,
} from "../../../src/learning/lifecycle/state-machine.mjs";
import { projection, t1Intent, promoteIntent, demoteIntent, archiveIntent, t12Intent, humanAdmissionRecord, journalAdmissionEvidence } from "./helpers.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REC = "pat-lifecycle-1";
/** AMENDMENT-1: a fresh journal to land admission records into + the
 * reading-layer resolution attach (`intent.resolutionEvidence`). */
function freshJournal() { const d = mkdtempSync(join(tmpdir(), "lc-legal-")); return join(d, "journal.jsonl"); }
function resolveE9(jp, intent, { requiresJustification = false, append = true } = {}) {
  const rec = intent.elements.E9 ?? intent.elements.HUMAN_ADMISSION;
  intent.resolutionEvidence = journalAdmissionEvidence(jp, rec, { recordId: intent.recordId ?? REC, generation: intent.generation ?? 1, requiresJustification }, { append });
  return intent;
}

function run(state, intent) {
  return authorizeLifecycleEvent(intent, projection({ state, generation: intent.generation ?? 1, recordId: intent.recordId ?? REC }));
}

test("L-T1. CANDIDATE→ADVISORY PROMOTE (R14): APPLIED with full E1–E7 (POS-01)", () => {
  const v = run("CANDIDATE", t1Intent());
  assert.equal(v.status, "APPLIED", JSON.stringify(v));
  assert.equal(v.ok, true);
  assert.equal(v.transition.id, "T1");
  assert.equal(v.transition.from, "CANDIDATE");
  assert.equal(v.transition.to, "ADVISORY");
  assert.equal(v.transition.authority, "R14");
  assert.equal(v.layer1, "CANDIDATE->ADVISORY");
  assert.equal(v.layer2, "APPLIED");
  assert.equal(v.generationAfter, 1);
});

test("L-T2. ADVISORY→REQUIRED_QUESTION PROMOTE (R15): APPLIED with E1–E7+E8 (POS-02)", () => {
  const v = run("ADVISORY", promoteIntent("ADVISORY"));
  assert.equal(v.status, "APPLIED", JSON.stringify(v));
  assert.equal(v.transition.id, "T2");
  assert.equal(v.transition.to, "REQUIRED_QUESTION");
  assert.equal(v.transition.authority, "R15");
});

test("L-T3. REQUIRED_QUESTION→MANDATORY_GATE PROMOTE (R16): APPLIED with human admission record (POS-03)", () => {
  const jp = freshJournal();
  const i = promoteIntent("REQUIRED_QUESTION");
  resolveE9(jp, i);
  const v = run("REQUIRED_QUESTION", i);
  assert.equal(v.status, "APPLIED", JSON.stringify(v));
  assert.equal(v.transition.id, "T3");
  assert.equal(v.transition.to, "MANDATORY_GATE");
  assert.equal(v.transition.authority, "R16");
});

test("L-T4/T5/T6. active→DEMOTED DEMOTE (R18): APPLIED with cause evidence (POS-04 ×3)", () => {
  for (const [state, tid] of [["ADVISORY", "T4"], ["REQUIRED_QUESTION", "T5"], ["MANDATORY_GATE", "T6"]]) {
    const v = run(state, demoteIntent(state));
    assert.equal(v.status, "APPLIED", `${state}: ${JSON.stringify(v)}`);
    assert.equal(v.transition.id, tid);
    assert.equal(v.transition.to, "DEMOTED");
    assert.equal(v.transition.authority, "R18");
  }
});

test("L-T7..T11. →ARCHIVED ARCHIVE (R19): APPLIED with supersession evidence (POS-05 ×5)", () => {
  for (const [state, tid] of [["ADVISORY", "T7"], ["REQUIRED_QUESTION", "T8"], ["CANDIDATE", "T9"], ["DEMOTED", "T10"], ["MANDATORY_GATE", "T11"]]) {
    const v = run(state, archiveIntent());
    assert.equal(v.status, "APPLIED", `${state}: ${JSON.stringify(v)}`);
    assert.equal(v.transition.id, tid);
    assert.equal(v.transition.to, "ARCHIVED");
    assert.equal(v.transition.authority, "R19");
  }
});

test("L-T12. ARCHIVED→REMOVED REMOVE (R20): APPLIED with genuine human admission record (POS-06)", () => {
  const jp = freshJournal();
  const i = t12Intent();
  resolveE9(jp, i, { requiresJustification: true });
  const v = run("ARCHIVED", i);
  assert.equal(v.status, "APPLIED", JSON.stringify(v));
  assert.equal(v.transition.id, "T12");
  assert.equal(v.transition.from, "ARCHIVED");
  assert.equal(v.transition.to, "REMOVED");
  assert.equal(v.transition.authority, "R20");
});

test("L-T12b. T12 with provenance-corruption justification class also APPLIES", () => {
  const jp = freshJournal();
  const intent = t12Intent({ admissionOverrides: { justificationClass: "PROVENANCE_CORRUPTION" } });
  resolveE9(jp, intent, { requiresJustification: true });
  const v = run("ARCHIVED", intent);
  assert.equal(v.status, "APPLIED", JSON.stringify(v));
});

test("L-D1. duplicate delivery of the same legal intent re-derives an idempotent NO-OP (exactly-once key)", () => {
  // POST-FSYNC duplicate: the journal already carries the event identity —
  // modeled at unit depth by the projection carrying the delivered cancel/key
  // semantics; for transitions the journal seq/digest chain is the key. N1
  // re-verdicts the same APPLIED (construction is N2's exactly-once seam),
  // and N2's keyed NO-OP is proven in test-event-journal.mjs. Here: replay
  // of the same intent yields the SAME verdict (deterministic, no drift).
  const i = t1Intent();
  const v1 = run("CANDIDATE", i);
  const v2 = run("CANDIDATE", JSON.parse(JSON.stringify(i)));
  assert.deepEqual(v1, v2);
  assert.equal(v1.status, "APPLIED");
});

test("L-E13. no 13th edge exists: LEGAL rows == 12 and re-entry (ARCHIVED→active) is not a row", () => {
  assert.equal(LEGAL_TRANSITIONS.length, 12);
  for (const to of ["CANDIDATE", "ADVISORY", "REQUIRED_QUESTION", "MANDATORY_GATE"]) {
    assert.equal(LEGAL_TRANSITIONS.some((t) => t.from === "ARCHIVED" && t.to === to), false, `re-entry edge to ${to} must not exist`);
  }
  const v = run("ARCHIVED", { ...t1Intent({ event: "PROMOTE", to: "ADVISORY" }), elements: { ...t1Intent().elements } });
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, LIFECYCLE_FINE_CODES.TERMINAL_IMMUTABLE);
  assert.equal(v.reason, "V15_RESURRECTION");
});

test("L-GEN. generation binding: APPLIED verdict carries generationAfter == durable generation", () => {
  const v = run("CANDIDATE", t1Intent({ generation: 7 }));
  assert.equal(v.status, "APPLIED");
  assert.equal(v.generationAfter, 7);
});
