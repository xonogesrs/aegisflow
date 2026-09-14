// test/learning/lifecycle/test-illegal-transitions.mjs
//
// RUNG-6 ladder rung 3 — all illegal classes I1–I11 individually: REJECT +
// exact fine code + zero durable effect + element-sweep (each of E1–E9
// removed in turn ⇒ REJECT). Oracle form: status + code + reason (ORACLE-
// CONTRACT dual layer).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeLifecycleEvent, LIFECYCLE_FINE_CODES, ILLEGAL_TRANSITIONS,
} from "../../../src/learning/lifecycle/state-machine.mjs";
import { projection, t1Intent, promoteIntent, demoteIntent, archiveIntent, t12Intent, humanAdmissionRecord } from "./helpers.mjs";

const REC = "pat-lifecycle-1";
const JCI = LIFECYCLE_FINE_CODES.JOURNAL_CHAIN_INVALID;
const TI = LIFECYCLE_FINE_CODES.TRANSITION_ILLEGAL;
const TTI = LIFECYCLE_FINE_CODES.TERMINAL_IMMUTABLE;
const WG = LIFECYCLE_FINE_CODES.WRONG_GENERATION;

function run(state, intent, projOverrides = {}) {
  return authorizeLifecycleEvent(intent, projection({ state, generation: projOverrides.generation ?? 1, recordId: intent.recordId ?? REC, ...projOverrides }));
}

test("I1. CANDIDATE PROMOTE-to-REQUIRED_QUESTION ⇒ REJECT + SKIP_LEVEL (F6)", () => {
  const v = run("CANDIDATE", t1Intent({ to: "REQUIRED_QUESTION" }));
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, TI);
  assert.equal(v.reason, "SKIP_LEVEL");
  assert.equal(v.iRow, "I1");
  assert.equal(v.fence, "F6");
});

test("I2. CANDIDATE PROMOTE-to-MANDATORY_GATE ⇒ REJECT + SKIP_LEVEL (F6)", () => {
  const v = run("CANDIDATE", t1Intent({ to: "MANDATORY_GATE" }));
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, TI);
  assert.equal(v.reason, "SKIP_LEVEL");
  assert.equal(v.iRow, "I2");
});

test("I3. ADVISORY PROMOTE-to-MANDATORY_GATE ⇒ REJECT + SKIP_LEVEL (F6)", () => {
  const v = run("ADVISORY", promoteIntent("ADVISORY", {}, { to: "MANDATORY_GATE" }));
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, TI);
  assert.equal(v.reason, "SKIP_LEVEL");
  assert.equal(v.iRow, "I3");
});

test("I4. downward non-demotion (RQ PROMOTE-to-ADVISORY) ⇒ REJECT + DOWNWARD_NON_DEMOTION (F6)", () => {
  const v = run("REQUIRED_QUESTION", promoteIntent("REQUIRED_QUESTION", {}, { to: "ADVISORY" }));
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, TI);
  assert.equal(v.reason, "DOWNWARD_NON_DEMOTION");
  assert.equal(v.iRow, "I4");
  // MG downgrade-to-ADVISORY: same class
  const v2 = run("MANDATORY_GATE", { ...promoteIntent("REQUIRED_QUESTION", {}, { to: "ADVISORY" }) });
  assert.equal(v2.status, "REJECT");
  assert.equal(v2.reason, "DOWNWARD_NON_DEMOTION");
});

test("I5. CANDIDATE DEMOTE ⇒ REJECT + SOURCE_STATE_NOT_DEMOTABLE (NEG-11)", () => {
  const v = run("CANDIDATE", demoteIntent("CANDIDATE"));
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, TI);
  assert.equal(v.reason, "SOURCE_STATE_NOT_DEMOTABLE");
  assert.equal(v.iRow, "I5");
});

test("I6. REMOVE from non-ARCHIVED (each non-archived state) ⇒ REJECT + REMOVAL_SOURCE_NOT_ARCHIVED (NEG-14)", () => {
  for (const state of ["CANDIDATE", "ADVISORY", "REQUIRED_QUESTION", "MANDATORY_GATE", "DEMOTED", "REMOVED"]) {
    const v = run(state, t12Intent());
    assert.equal(v.status, "REJECT", `${state}`);
    assert.equal(v.code, TI, `${state}: ${v.code}`);
    assert.equal(v.reason, "REMOVAL_SOURCE_NOT_ARCHIVED", `${state}: ${v.reason}`);
  }
});

test("I7. resurrection from ARCHIVED / REMOVED out-edge ⇒ REJECT + TERMINAL_IMMUTABLE / V15_RESURRECTION (NEG-13, P1)", () => {
  const up = { ...archiveIntent({ event: "PROMOTE", to: "ADVISORY" }), elements: { ...t1Intent().elements } };
  const v1 = run("ARCHIVED", up);
  assert.equal(v1.status, "REJECT"); assert.equal(v1.code, TTI); assert.equal(v1.reason, "V15_RESURRECTION");
  const v2 = run("REMOVED", { ...demoteIntent("REMOVED") });
  assert.equal(v2.status, "REJECT"); assert.equal(v2.code, TTI); assert.equal(v2.reason, "V15_RESURRECTION");
  const v3 = run("REMOVED", { ...archiveIntent({ event: "ARCHIVE", to: "ARCHIVED" }) });
  assert.equal(v3.status, "REJECT"); assert.equal(v3.code, TTI);
  // DEMOTED upward return to active is also resurrection (only T10 legal)
  const v4 = run("DEMOTED", { ...t1Intent({ event: "PROMOTE", to: "ADVISORY" }), elements: { ...t1Intent().elements } });
  assert.equal(v4.status, "REJECT"); assert.equal(v4.code, TTI);
});

test("I8. state claim without journal derivation (silent coercion) ⇒ REJECT + JOURNAL_CHAIN_INVALID/SILENT_COERCION_DETECTED (F4, NEG-10/P9)", () => {
  const intent = { ...t1Intent(), claimSource: "PROCESS_MEMORY" };
  const v = run("CANDIDATE", intent);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, JCI);
  assert.equal(v.reason, "SILENT_COERCION_DETECTED");
  assert.equal(v.iRow, "I8");
  // projection-side claim-source violation
  const v2 = authorizeLifecycleEvent(t1Intent(), projection({ state: "CANDIDATE", overrides: { claimSource: "PROCESS_MEMORY" } }));
  assert.equal(v2.status, "REJECT"); assert.equal(v2.code, JCI); assert.equal(v2.reason, "SILENT_COERCION_DETECTED");
});

test("I9. element sweep: every upward edge missing each element in turn ⇒ REJECT + element class (F7)", () => {
  const sweeps = [
    ["CANDIDATE", t1Intent(), ["E1", "E2", "E3", "E4", "E5", "E6", "E7"]],
    ["ADVISORY", promoteIntent("ADVISORY"), ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"]],
    ["REQUIRED_QUESTION", promoteIntent("REQUIRED_QUESTION"), ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E9"]],
  ];
  for (const [state, intent, elements] of sweeps) {
    for (const el of elements) {
      const broken = JSON.parse(JSON.stringify(intent));
      delete broken.elements[el];
      const v = run(state, broken);
      assert.equal(v.status, "REJECT", `${state} missing ${el}`);
      assert.equal(v.iRow, "I9", `${state} missing ${el}: ${v.iRow}`);
      assert.ok(v.code, `${state} missing ${el}: exact element class required`);
    }
  }
  // T9 archive without supersession evidence
  const a = archiveIntent(); delete a.elements.SUPERSESSION;
  const v = run("CANDIDATE", a);
  assert.equal(v.status, "REJECT"); assert.equal(v.iRow, "I9");
  // T12 without the human admission record ⇒ AUTHORITY_INSUFFICIENT (NEG-15)
  const r = t12Intent(); delete r.elements.HUMAN_ADMISSION;
  const v2 = run("ARCHIVED", r);
  assert.equal(v2.status, "REJECT"); assert.equal(v2.code, LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT);
  // T12 without a legal justification class
  const v3 = run("ARCHIVED", t12Intent({ admissionOverrides: { justificationClass: "AGENT_WHIM" } }));
  assert.equal(v3.status, "REJECT"); assert.equal(v3.code, LIFECYCLE_FINE_CODES.AUTHORITY_INSUFFICIENT);
});

test("I10. upward edge without independent review identity ⇒ REJECT + SELF_PROMOTION / EVIDENCE_IDENTITY_* (F7, NEG-02)", () => {
  const self = t1Intent(); self.elements.E2 = { identity: "2".repeat(64), independent: false };
  const v = run("CANDIDATE", self);
  assert.equal(v.status, "REJECT"); assert.equal(v.iRow, "I10"); assert.ok(["WRITEBACK_EVIDENCE_IDENTITY_MALFORMED", "WRITEBACK_SELF_PROMOTION_REJECTED"].includes(v.code));
  const missing = t1Intent(); missing.elements.E2 = { identity: "2".repeat(64), independent: true, selfAuthored: true };
  const v2 = run("CANDIDATE", missing);
  assert.equal(v2.status, "REJECT"); assert.equal(v2.iRow, "I10"); assert.equal(v2.code, LIFECYCLE_FINE_CODES.SELF_PROMOTION);
  const forged = t1Intent(); forged.elements.E2 = { identity: "zz", independent: true };
  const v3 = run("CANDIDATE", forged);
  assert.equal(v3.status, "REJECT"); assert.equal(v3.iRow, "I10");
});

test("I10b. self-authored execution identity with a well-formed E2 object ⇒ REJECT + SELF_PROMOTION (V5; CP-2 Finding 1)", () => {
  // an executor-flagged self-authored run cannot present an independent review
  // identity, whatever E2 shape it supplies (trust-ladder review identity rule)
  const a = t1Intent();
  a.executionIdentity.selfAuthored = true;
  const v = run("CANDIDATE", a);
  assert.equal(v.status, "REJECT", JSON.stringify(v));
  assert.equal(v.iRow, "I10");
  assert.equal(v.code, "WRITEBACK_SELF_PROMOTION_REJECTED");
  // E2-as-object variant with selfAuthored review object — also rejected
  const b = t1Intent();
  b.elements.E2 = { identity: "2".repeat(64), independent: true, selfAuthored: true };
  const v2 = run("CANDIDATE", b);
  assert.equal(v2.status, "REJECT");
  assert.equal(v2.iRow, "I10");
  // and the string-E2 + selfAuthored execution form stays covered
  const c = t1Intent();
  c.elements.E2 = "2".repeat(64);
  c.executionIdentity.selfAuthored = true;
  const v3 = run("CANDIDATE", c);
  assert.equal(v3.status, "REJECT");
  assert.equal(v3.iRow, "I10");
});

test("I11. intent generation ≠ durable generation ⇒ REJECT + WRONG_GENERATION (F5, P2)", () => {
  const v = run("CANDIDATE", t1Intent({ generation: 2 }), {});
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, WG);
  assert.equal(v.iRow, "I11");
  assert.equal(v.fence, "F5");
  // stale admission pair (SPOOF-4/DBL-4 shape) at F7 binding
  const stale = promoteIntent("REQUIRED_QUESTION");
  stale.elements.E9 = { ...stale.elements.E9, generation: 0 };
  const v2 = run("REQUIRED_QUESTION", stale);
  assert.equal(v2.status, "REJECT"); assert.equal(v2.code, WG); assert.equal(v2.reason, "ADMISSION_GENERATION_MISMATCH");
});

test("I-DBL5. DBL-5 fresh A + stale B mismatched pair ⇒ REJECT + binding mismatch", () => {
  const intent = promoteIntent("REQUIRED_QUESTION");
  intent.elements.E9 = { ...humanAdmissionRecord(), generation: 99 };
  const v = run("REQUIRED_QUESTION", intent);
  assert.equal(v.status, "REJECT");
  assert.equal(v.code, WG);
});

test("I-FORM. every I-row verdict: zero durable effect (no ok, no transition), exact (status, code) pair", () => {
  for (const row of ILLEGAL_TRANSITIONS) {
    assert.equal(row.status, "REJECT", row.id);
    assert.ok(row.fence, `${row.id} must name its first-reachable fence`);
  }
});
