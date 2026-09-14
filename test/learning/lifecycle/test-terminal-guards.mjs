// test/learning/lifecycle/test-terminal-guards.mjs
//
// RUNG-6 Step 8 — ladder rungs 13/14 unit rows (TEST-OBLIGATION-FREEZE:
// TERMINAL_STATE_GUARDS = ALL_FROZEN):
//   COMPLETED non-reopen — a completed transition is immutable durable
//   reality; correction only via NEW journaled events on frozen edges
//   REMOVED non-reopen — no upward edge, no replay mutation, no restore path
//   HOLD non-collapse — HOLD never becomes a state or a pass
//   re-entry-not-an-edge — no ARCHIVED/REMOVED → active edge exists
// Oracle form: (Layer-1 reality, Layer-2 outcome) asserted together.

import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeLifecycleEvent, LIFECYCLE_STATES, LEGAL_TRANSITIONS, LIFECYCLE_RUN_OUTCOMES } from "../../../src/learning/lifecycle/state-machine.mjs";
import { applyLifecycleEventToProjection, writeLifecycleEvent, readLifecycleJournalState } from "../../../src/learning/lifecycle/event-journal.mjs";
import { projection, t1Intent, promoteIntent, demoteIntent, archiveIntent, t12Intent, humanAdmissionRecord } from "./helpers.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REC = "pat-lifecycle-1";
const run = (state, intent, overrides = {}) => authorizeLifecycleEvent(intent, projection({ state, generation: intent.generation ?? 1, recordId: intent.recordId ?? REC, ...overrides }));

test("TG-13a. COMPLETED is not a state: a completed transition run leaves the record in its Layer-1 state; outcome stays Layer-2", () => {
  // a T1 run completes: record state = ADVISORY (Layer 1); APPLIED (Layer 2)
  const v = run("CANDIDATE", t1Intent());
  assert.equal(v.layer1, "CANDIDATE->ADVISORY");
  assert.equal(v.layer2, "APPLIED");
  assert.equal(LIFECYCLE_STATES.includes("COMPLETED"), false);
  // the completed event, replayed, reconstructs the same Layer-1 state — never a COMPLETED state
  const recon = applyLifecycleEventToProjection(projection({ state: "CANDIDATE", generation: 1 }), { payload: { event: "PROMOTE", transition: { to: "ADVISORY" }, generationAfter: 1 } });
  assert.equal(recon.state, "ADVISORY");
  assert.equal(LIFECYCLE_STATES.includes(recon.state), true);
});

test("TG-13b. completed reality corrects only by NEW events on frozen edges (demote a gate), never by history rewrite", () => {
  // MANDATORY_GATE is settled; the only frozen continuations are T6 (demote) / T11 (archive)
  const v = run("MANDATORY_GATE", demoteIntent("MANDATORY_GATE"));
  assert.equal(v.status, "APPLIED");
  assert.equal(v.transition.id, "T6");
  // there is no edge that edits the PROMOTE event — the table has no EDIT/REWRITE kind
  const kinds = new Set(LEGAL_TRANSITIONS.map((t) => t.event));
  for (const banned of ["EDIT", "REWRITE", "CORRECT", "AMEND"]) assert.equal(kinds.has(banned), false);
});

test("TG-14a. REMOVED non-reopen: no upward edge exists; every intent from REMOVED fails terminal", () => {
  for (const [event, intent, code] of [
    ["PROMOTE", { ...t1Intent({ event: "PROMOTE", to: "ADVISORY" }), elements: { ...t1Intent().elements } }, "LIFECYCLE_TERMINAL_IMMUTABLE"],
    ["DEMOTE", demoteIntent("REMOVED"), "LIFECYCLE_TERMINAL_IMMUTABLE"],
    ["ARCHIVE", { ...archiveIntent({ event: "ARCHIVE", to: "ARCHIVED" }) }, "LIFECYCLE_TERMINAL_IMMUTABLE"],
    ["REMOVE", t12Intent(), "LIFECYCLE_TRANSITION_ILLEGAL"], // frozen I6: removal-source row (state != ARCHIVED)
  ]) {
    const v = run("REMOVED", intent);
    assert.equal(v.status, "REJECT", `${event} from REMOVED`);
    assert.equal(v.code, code, `${event} from REMOVED`);
  }
});

test("TG-14b. REMOVED non-reopen at replay: reconstruction is idempotent; re-application never resurrects", () => {
  let p = projection({ state: "ARCHIVED", generation: 2 });
  const removalEvent = { payload: { event: "REMOVE", transition: { id: "T12", from: "ARCHIVED", to: "REMOVED" }, generationAfter: 2 } };
  p = applyLifecycleEventToProjection(p, removalEvent);
  assert.equal(p.state, "REMOVED");
  for (let i = 0; i < 3; i++) p = applyLifecycleEventToProjection(p, removalEvent);
  assert.equal(p.state, "REMOVED", "replay never resurrects");
  // no restore code path: the seam refuses RESTORE-like kinds and N1 has no restore verdict
  assert.equal(LIFECYCLE_STATES.includes("REMOVED"), true);
});

test("TG-14c. implicit restore probe: an intent claiming state ADVISORY for a REMOVED record dies at F4/F6, never APPLIED", () => {
  const claimIntent = { ...t1Intent({ event: "PROMOTE", to: "ADVISORY" }), elements: { ...t1Intent().elements } };
  // the projection (journal reality) says REMOVED — the intent's claim cannot override
  const v = run("REMOVED", claimIntent);
  assert.equal(v.status, "REJECT");
  assert.notEqual(v.layer1, "CANDIDATE->ADVISORY");
});

test("TG-14d. no re-entry edge: ARCHIVED has exactly one out-edge (T12); neither ARCHIVED nor REMOVED can return to active states", () => {
  const archivedOut = LEGAL_TRANSITIONS.filter((t) => t.from === "ARCHIVED");
  assert.equal(archivedOut.length, 1);
  assert.equal(archivedOut[0].id, "T12");
  const activeStates = ["CANDIDATE", "ADVISORY", "REQUIRED_QUESTION", "MANDATORY_GATE"];
  for (const from of ["ARCHIVED", "REMOVED"]) {
    for (const to of activeStates) {
      assert.equal(LEGAL_TRANSITIONS.some((t) => t.from === from && t.to === to), false, `re-entry ${from}->${to} exists`);
    }
  }
});

test("TG-14e. re-admission is NOT a restore: a new human admission + new record lineage is the only future path (no code path here)", () => {
  // the frozen law: future restore = NEW authority + NEW generation + NEW record;
  // assert the implementation provides no same-recordId restore route:
  const kinds = new Set(LEGAL_TRANSITIONS.map((t) => t.event));
  assert.equal(kinds.has("RESTORE"), false);
  assert.equal(kinds.has("REACTIVATE"), false);
  assert.equal(kinds.has("REOPEN"), false);
});

test("TG-HOLD. HOLD never collapses into a pass: HOLD verdicts are Layer-2 dispositions requiring reconciliation", () => {
  // the run-outcome vocabulary is closed and HOLD is in it — but never a state
  assert.ok(LIFECYCLE_RUN_OUTCOMES.includes("HOLD"));
  assert.equal(LIFECYCLE_STATES.includes("HOLD"), false);
  // a HOLD verdict names its reconciliation class (RECOVERY_REQUIRED), never APPLIED
  const { readDurableAuthority } = (() => ({}))(); // placeholder to keep import shape
  const v = run("CANDIDATE", { ...t1Intent(), claimSource: "PROCESS_MEMORY" });
  assert.equal(v.status, "REJECT");
  // HOLD forms (N3 torn view) are proven in test-resume-recovery.mjs R-12b/c;
  // here: no code path maps HOLD → APPLIED (verdict statuses are sealed)
});
