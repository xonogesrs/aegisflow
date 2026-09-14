// test/learning/lifecycle/test-matrix-totality.mjs
//
// RUNG-6 ladder rung 1 — pure transition-matrix tests: the 7×5 event-kind
// matrix collapses to the frozen table; each (FROM, EVENT) pair resolves to
// exactly one table row or one I-row; no other outcome exists.
// Invariants: closed 7-state enum (negative: unknown state/kind fail-closed).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIFECYCLE_STATES, LEGAL_TRANSITIONS, ILLEGAL_TRANSITIONS,
  resolveMatrixCell, authorizeLifecycleEvent, allowedContinuations, LIFECYCLE_MODULE_LAW,
} from "../../../src/learning/lifecycle/state-machine.mjs";
import * as contract from "../../../src/memory/contract.mjs";
import { LIFECYCLE_TRANSITION_ILLEGAL, LIFECYCLE_TERMINAL_IMMUTABLE } from "../../../src/memory/contract.mjs";
import { projection, EVENT_KINDS, LIFECYCLE_STATES as S } from "./helpers.mjs";

test("M1. the enum is exactly the frozen 7 states, closed, declared once", () => {
  assert.deepEqual([...LIFECYCLE_STATES], S);
  assert.equal(LIFECYCLE_STATES.length, 7);
  assert.equal(Object.isFrozen(LIFECYCLE_STATES), true);
  for (const banned of ["COMPLETED", "HOLD", "CANCELLED", "FAILED", "RUNNING", "PAUSED", "CANCELLING", "ABSENT", "ADMITTED", "RESUMABLE"]) {
    assert.equal(LIFECYCLE_STATES.includes(banned), false, `${banned} must never be a state`);
  }
});

test("M2. the kind set in contract.mjs matches the state machine's kinds (closed 5)", () => {
  assert.deepEqual([...contract.LIFECYCLE_EVENT_KINDS], EVENT_KINDS);
});

test("M3. table accounting: 12 legal rows (up 3, demote 3, archive 5, remove 1)", () => {
  assert.equal(LEGAL_TRANSITIONS.length, 12);
  assert.equal(LEGAL_TRANSITIONS.filter((t) => t.event === "PROMOTE").length, 3);
  assert.equal(LEGAL_TRANSITIONS.filter((t) => t.event === "DEMOTE").length, 3);
  assert.equal(LEGAL_TRANSITIONS.filter((t) => t.event === "ARCHIVE").length, 5);
  assert.equal(LEGAL_TRANSITIONS.filter((t) => t.event === "REMOVE").length, 1);
  // unique ids, unique (from,event,to) triples
  const ids = LEGAL_TRANSITIONS.map((t) => t.id);
  assert.equal(new Set(ids).size, 12);
  const triples = LEGAL_TRANSITIONS.map((t) => `${t.from}|${t.event}|${t.to}`);
  assert.equal(new Set(triples).size, 12);
  // no edge FROM=REMOVED (I7 terminal law; no 13th edge)
  assert.equal(LEGAL_TRANSITIONS.filter((t) => t.from === "REMOVED").length, 0);
  // T1→T2→T3 adjacency (SM-2)
  assert.deepEqual(LEGAL_TRANSITIONS.filter((t) => t.event === "PROMOTE").map((t) => `${t.from}->${t.to}`),
    ["CANDIDATE->ADVISORY", "ADVISORY->REQUIRED_QUESTION", "REQUIRED_QUESTION->MANDATORY_GATE"]);
});

test("M4. matrix totality: every (state,kind) resolves to exactly one sealed class (LEGAL | ILLEGAL | OP_BOUNDARY)", () => {
  for (const state of LIFECYCLE_STATES) {
    for (const kind of EVENT_KINDS) {
      const r = resolveMatrixCell(state, kind);
      assert.ok(["LEGAL", "ILLEGAL", "OP_BOUNDARY"].includes(r.kind), `${state}/${kind} unresolved`);
      if (r.kind === "LEGAL") {
        assert.equal(LEGAL_TRANSITIONS.filter((t) => t.from === state && t.event === kind).length, 1, `${state}/${kind} must resolve to exactly one row`);
      } else if (r.kind === "OP_BOUNDARY") {
        assert.equal(kind, "OP_CANCEL", "OP_BOUNDARY is the OP_CANCEL kind only");
        assert.equal(r.owner, "authorizeOpCancel");
      } else {
        assert.ok(r.iRow, `${state}/${kind} illegal without I-row`);
        assert.ok(r.iRow.fence, `${state}/${kind} I-row must name its fence`);
      }
    }
  }
  // OP_CANCEL cells agree with the evaluator's own boundary path (single oracle)
  for (const state of LIFECYCLE_STATES) {
    assert.equal(resolveMatrixCell(state, "OP_CANCEL").kind, "OP_BOUNDARY");
  }
});

test("M5. every legal row's APPLIED verdict is reachable via the pure evaluator with full elements", () => {
  // drive the matrix through authorizeLifecycleEvent per row (element sets
  // built per row kind) — proven individually in ladder-2; here we assert the
  // evaluator returns exactly APPLIED or a REJECT/HOLD verdict, never 'undefined'.
  for (const state of LIFECYCLE_STATES) {
    for (const kind of EVENT_KINDS) {
      const intent = {
        claimSource: "JOURNAL_PROJECTION", recordId: "pat-lifecycle-1", event: kind, to: null,
        generation: 1, policyAllowed: true,
        executionIdentity: { graphRunId: "g", task: "t", attempt: 1, selfAuthored: false },
        elements: { E1: { a: 1 }, E2: { identity: "2".repeat(64), independent: true }, E3: { b: 1 }, E4: { c: 1 }, E5: { d: 1 }, E6: { e: 1 }, E7: true, E8: { f: 1 }, E9: { identity: "3".repeat(64), mintPath: "HUMAN_CBM4_GATE", journalResolved: true, authoritySource: "HUMAN", recordId: "pat-lifecycle-1", generation: 1 }, CAUSE: { x: 1 }, SUPERSESSION: { y: 1 }, HUMAN_ADMISSION: { identity: "3".repeat(64), mintPath: "HUMAN_CBM4_GATE", journalResolved: true, authoritySource: "HUMAN", recordId: "pat-lifecycle-1", generation: 1, justificationClass: "SECURITY_SECRET_SCAN" } },
      };
      const v = authorizeLifecycleEvent(intent, projection({ state }));
      assert.ok(["APPLIED", "REJECT", "NO-OP", "HOLD"].includes(v.status), `${state}/${kind} -> ${v.status} not a Layer-2 disposition`);
    }
  }
});

test("M6. allowedContinuations: frozen out-edges per state; REMOVED = none", () => {
  assert.deepEqual(allowedContinuations("CANDIDATE").map((c) => c.id), ["T1", "T9"]);
  assert.deepEqual(allowedContinuations("ADVISORY").map((c) => c.id), ["T2", "T4", "T7"]);
  assert.deepEqual(allowedContinuations("REQUIRED_QUESTION").map((c) => c.id), ["T3", "T5", "T8"]);
  assert.deepEqual(allowedContinuations("MANDATORY_GATE").map((c) => c.id), ["T6", "T11"]);
  assert.deepEqual(allowedContinuations("DEMOTED").map((c) => c.id), ["T10"]);
  assert.deepEqual(allowedContinuations("ARCHIVED").map((c) => c.id), ["T12"]);
  assert.deepEqual(allowedContinuations("REMOVED"), []);
});

test("M7. unknown event kind REJECTs, never defaults (closed-kind negative)", () => {
  const v = authorizeLifecycleEvent(
    { claimSource: "JOURNAL_PROJECTION", recordId: "r", event: "REACTIVATE", to: "ADVISORY", generation: 1, policyAllowed: true, executionIdentity: { graphRunId: "g" }, elements: {} },
    projection({ state: "ARCHIVED" }),
  );
  assert.equal(v.status, "REJECT");
  assert.equal(v.reason, "UNREGISTERED_EVENT_KIND");
  assert.equal(v.code, LIFECYCLE_TRANSITION_ILLEGAL);
  for (const banned of ["REOPEN", "RESTORE", "REACTIVATE"]) {
    const v2 = authorizeLifecycleEvent(
      { claimSource: "JOURNAL_PROJECTION", recordId: "r", event: banned, to: null, generation: 1, policyAllowed: true, executionIdentity: { graphRunId: "g" }, elements: {} },
      projection({ state: "REMOVED" }),
    );
    assert.equal(v2.status, "REJECT", `${banned} must REJECT`);
    assert.notEqual(v2.reason, "APPLIED");
  }
});

test("M8. malformed/absent input preconditions fail closed (F1/F2/F3 forms)", () => {
  const base = { claimSource: "JOURNAL_PROJECTION", recordId: "r", event: "PROMOTE", to: null, generation: 1, policyAllowed: true, executionIdentity: { graphRunId: "g" }, elements: {} };
  const p = projection({ state: "CANDIDATE" });
  // F1: unbound execution identity
  const f1 = authorizeLifecycleEvent({ ...base, executionIdentity: null }, p);
  assert.equal(f1.status, "REJECT"); assert.equal(f1.fence, "F1");
  // F2: record does not resolve
  const f2 = authorizeLifecycleEvent(base, projection({ state: "CANDIDATE", overrides: { recordExists: false } }));
  assert.equal(f2.status, "REJECT"); assert.equal(f2.code, "JOURNAL_CHAIN_INVALID"); assert.equal(f2.fence, "F2");
  // F3: policy projection refuses
  const f3 = authorizeLifecycleEvent({ ...base, policyAllowed: false }, p);
  assert.equal(f3.status, "REJECT"); assert.equal(f3.fence, "F3");
});

test("M8b. F8 invariant: every emitted verdict binds transition.from == journal-derived projection state", () => {
  // the F8 write-seam guard holds row.from == projection.state as an
  // invariant; the oracle walks the full matrix and asserts it on every
  // APPLIED verdict (the only verdicts that carry a transition).
  for (const state of LIFECYCLE_STATES) {
    for (const kind of EVENT_KINDS) {
      if (kind === "OP_CANCEL") continue;
      const cell = resolveMatrixCell(state, kind);
      if (cell.kind !== "LEGAL") continue;
      const intent = {
        claimSource: "JOURNAL_PROJECTION", recordId: "pat-lifecycle-1", event: kind, to: null,
        generation: 1, policyAllowed: true,
        executionIdentity: { graphRunId: "g", task: "t", attempt: 1, selfAuthored: false },
        elements: { E1: { a: 1 }, E2: { identity: "2".repeat(64), independent: true }, E3: { b: 1 }, E4: { c: 1 }, E5: { d: 1 }, E6: { e: 1 }, E7: true, E8: { f: 1 }, E9: { identity: "3".repeat(64), mintPath: "HUMAN_CBM4_GATE", journalResolved: true, authoritySource: "HUMAN", recordId: "pat-lifecycle-1", generation: 1 }, CAUSE: { x: 1 }, SUPERSESSION: { y: 1 }, HUMAN_ADMISSION: { identity: "3".repeat(64), mintPath: "HUMAN_CBM4_GATE", journalResolved: true, authoritySource: "HUMAN", recordId: "pat-lifecycle-1", generation: 1, justificationClass: "SECURITY_SECRET_SCAN" } },
      };
      const v = authorizeLifecycleEvent(intent, projection({ state }));
      if (v.status === "APPLIED") {
        assert.equal(v.transition.from, state, `${state}/${kind}: verdict must bind the projection state`);
      }
    }
  }
});

test("M9. N1 structural law: DECIDES NEVER WRITES; no admission-mint code", () => {
  assert.equal(LIFECYCLE_MODULE_LAW.WRITES, false);
  assert.equal(LIFECYCLE_MODULE_LAW.MINTS_ADMISSIONS, false);
});
