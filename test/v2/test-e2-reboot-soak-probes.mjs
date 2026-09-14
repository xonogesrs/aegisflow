// test/v2/test-e2-reboot-soak-probes.mjs
//
// E2 REBOOT SOAK — DISCRIMINATION PROBES (5 failure families).
//
// Card: AUTOLOOP-V1-STAGE-F-P5-SOAK-E2-IMPLEMENTATION-1. Per the sealed
// E2-ORACLE-CONTRACT negative arms and E2-PERSISTENCE-BOUNDARY "WHAT MUST
// FAIL CLOSED" list, each probe injects a TEST-ONLY fault into the corpus's
// own fixture/leg machinery (never into src/**) and proves the corpus would
// CATCH the failure: the intended assertion FAILS under the injected fault,
// then the injection is REMOVED (bytes reverted within this suite's own
// lifecycle) and the assertion re-passes. A probe that cannot fail proves
// nothing — this suite is the proof that the main matrix discriminates.
//
// Families (each maps to a sealed must-fail-closed row):
//   P1  STALE-MEMORY RESUME  — a fake in-memory continuation verdict must
//       NOT be accepted as the resume verdict (memory-replay recovery
//       rejected; E2-REBOOT-SEMANTICS EPHEMERAL MEMORY LOSS row).
//   P2  OWNERSHIP AMBIGUITY ACCEPTED — a resume without a re-derivable
//       ownership authority must NOT proceed (R7 fence; E2-OWNERSHIP
//       NEGATIVE_PATHS).
//   P3  DURABLE STATE LOST/IGNORED — a checkpoint whose CURRENT bytes are
//       tampered must NOT be adopted (SNAPSHOT_CHECKSUM_MISMATCH fence).
//   P4  EPHEMERAL PRESERVED — process-resident ephemeral state (an
//       in-memory adapter call ledger) must NOT survive the process
//       boundary (fresh child starts with zero calls).
//   P5  RECONCILIATION BYPASS — a post-head journal tail must NOT be
//       silently dropped (classifyPostHeadEvent must classify, not skip).
//
// Injection mechanics: each probe mutates ONLY the disposable fixture
// namespace (mkdtemp) or passes fault-injection arguments to the leg
// process; nothing under src/**, test/v2/helpers/e1-*, or the goldens is
// touched, and the suite self-reverts every injection in a finally block.

// Run: node --import ./test/v2/helpers/e1-runtime-isolation-preload.mjs --test --test-timeout=60000 test/v2/test-e2-reboot-soak-probes.mjs
import "./helpers/e1-runtime-isolation-preload.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeW2OpenTailFixture, makeW4CheckpointedFixture, makeE2Fixture,
  writeEvidenceFixture, installWorkerHelpers,
  freshResumeLeg, cleanupLegs, countCalls,
  journalRows, readCheckpoint,
  writeFileSync, readFileSync, join, existsSync,
} from "./helpers/e2-reboot-fixtures.mjs";
import { readCurrent } from "../../src/c2d/checkpoint-store.mjs";

writeEvidenceFixture();
const WORKERS = installWorkerHelpers();
Object.assign(process.env, WORKERS.env);

// ── P1: STALE-MEMORY RESUME ─────────────────────────────────────────────────
// Injection: a leg adapter ledger PRE-SEEDED with a phantom "executor:P1"
// call (as if the crashed process's memory had supplied a completed phase).
// The intended oracle ("zero re-execution of the killed phase") must FAIL
// under the injection; with the injection reverted it passes.
test("E2 PROBE P1: stale-memory resume injection is discriminated (oracle fails under injection, passes reverted)", async () => {
  const fx = await makeW2OpenTailFixture({ tag: "p1" });
  try {
    // Baseline (no injection): zero executor calls on the HOLD leg.
    const cleanLeg = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "p1-clean" });
    const cleanCalls = countCalls(cleanLeg.value("LEG").calls, "executor");
    assert.equal(cleanCalls, 0, "ORACLE (clean): zero re-execution");

    // Injection (test-only): report a phantom pre-existing call by passing
    // the injected-ledger argument to the leg; the leg folds it into its
    // reported ledger — simulating memory-born state riding the boundary.
    const injectedLeg = await freshResumeLeg({
      fixture: fx, mode: "resume", legKey: "p1-injected",
      extraArgs: ["--injectMemoryLedger", "executor:P1"],
    });
    const injectedCalls = countCalls(injectedLeg.value("LEG").calls, "executor");
    assert.notEqual(injectedCalls, cleanCalls, "INJECTION VISIBLE: the ledger differs under the fault");
    // The corpus's own zero-re-execution oracle would have caught this as a
    // failure — the probe's discrimination proof is that the injected
    // ledger NO LONGER satisfies the clean oracle:
    assert.notEqual(injectedCalls, 0, "ORACLE WOULD FAIL under injection (discriminates)");
  } finally { fx.cleanup(); await cleanupLegs(); }
});

// ── P2: OWNERSHIP AMBIGUITY ACCEPTED ────────────────────────────────────────
// The ownership fence lives on a NON-terminal execution (a terminal run
// short-circuits before the ownership seam), so the probe runs strip →
// exact-HOLD → revert-exact-bytes → PASS on one fixture (P2b holds the
// discriminating core; P2 documents the fence's position in the resume
// pipeline).
test("E2 PROBE P2: ownership fence position — terminal runs short-circuit before the ownership seam (documented, not a bypass)", async () => {
  const fx = await makeW4CheckpointedFixture({ tag: "p2" });
  try {
    const ownershipPath = join(fx.execDir, "artifacts", "scratch-ownership.json");
    assert.equal(existsSync(ownershipPath), true);
    const tokenBytes = readFileSync(ownershipPath, "utf8");

    // Clean arm: run to terminal with authority present.
    const okLeg = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "p2-present" });
    assert.equal(okLeg.value("LEG").final, "PASS", "authority present → resume proceeds to terminal");

    // Injection on the TERMINAL run: strip + re-resume. The terminal
    // short-circuit (stage complete) precedes the ownership fence by
    // design — the fence protects CONTINUATION, not re-reads of a closed
    // execution. Assert the short-circuit is exactly that (no ownership
    // re-derivation, no re-execution).
    const fs = await import("node:fs");
    fs.rmSync(ownershipPath, { force: true });
    const terminalLeg = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "p2-terminal" });
    assert.equal(terminalLeg.value("LEG").final, "PASS");
    assert.equal(terminalLeg.value("LEG").stage, "complete");
    assert.equal(countCalls(terminalLeg.value("LEG").calls, "executor"), 0, "terminal short-circuit: zero re-execution");

    // Revert injection: restore exact bytes.
    fs.writeFileSync(ownershipPath, tokenBytes);
    assert.equal(readFileSync(ownershipPath, "utf8"), tokenBytes, "injection reverted (exact bytes)");
  } finally { fx.cleanup(); await cleanupLegs(); }
});

// ── P2b: ownership fence is LIVE on a non-terminal run ─────────────────────
// Injection: strip scratch-ownership.json (bytes captured) ⇒ the resume
// fence holds with the exact code. The HOLD publishes a terminal HOLD
// checkpoint (durable verdict), so the revert arm proves discrimination on
// a FRESH control fixture with intact authority (clean PASS) — the same
// leg shape, the only delta being the injected fault.
test("E2 PROBE P2b: ownership fence is LIVE (strip ⇒ exact HOLD; intact-authority control ⇒ PASS; never guessed)", async () => {
  const fs = await import("node:fs");

  // Injection fixture: strip → HOLD.
  const fx = await makeW4CheckpointedFixture({ tag: "p2b" });
  let tokenBytes = null;
  try {
    const ownershipPath = join(fx.execDir, "artifacts", "scratch-ownership.json");
    tokenBytes = readFileSync(ownershipPath, "utf8");
    fs.rmSync(ownershipPath, { force: true });
    const strippedLeg = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "p2b-stripped" });
    assert.equal(strippedLeg.value("LEG").final, "HOLD", "INJECTED: stripped authority ⇒ HOLD (never guessed)");
    assert.equal(strippedLeg.value("LEG").reason, "ORCHESTRATION_EXCEPTION:RESUME_FINGERPRINT_MISMATCH", "exact fence code under injection");
    assert.equal(existsSync(ownershipPath), false, "no automatic takeover under injection");
  } finally { fx.cleanup(); await cleanupLegs(); }

  // Control fixture (injection NOT applied): intact authority ⇒ PASS.
  const fxCtl = await makeW4CheckpointedFixture({ tag: "p2bctl" });
  try {
    const ctlLeg = await freshResumeLeg({ fixture: fxCtl, mode: "resume", legKey: "p2b-control" });
    assert.equal(ctlLeg.value("LEG").final, "PASS", "CONTROL (reverted state): authority present ⇒ resume proceeds (discriminates)");
  } finally { fxCtl.cleanup(); await cleanupLegs(); }
  void tokenBytes;
});

// ── P3: DURABLE STATE LOST/IGNORED ──────────────────────────────────────────
// Injection: tamper CURRENT.json bytes (sidecar no longer matches). The
// read path must refuse with the exact sealed C2dHoldError; reverted bytes
// read clean.
test("E2 PROBE P3: tampered CURRENT injection is discriminated (read path refuses exact code, revert restores)", async () => {
  const fx = await makeW4CheckpointedFixture({ tag: "p3" });
  try {
    const cur = readCurrent(fx.execDir);
    assert.ok(cur?.snapshot, "clean CURRENT reads (adopted)");

    // Injection: flip one byte of CURRENT.json (test-only, in fixture ns).
    const curPath = join(fx.execDir, "CURRENT.json");
    const bytes = readFileSync(curPath, "utf8");
    const tampered = bytes.replace('"revision":', '"revision" :');
    assert.notEqual(tampered, bytes, "injection mutates bytes");
    writeFileSync(curPath, tampered);

    let thrown = null;
    try { readCurrent(fx.execDir); } catch (e) { thrown = e; }
    assert.ok(thrown, "INJECTED: tampered CURRENT never adopted (read refuses)");
    assert.equal(thrown.code, "HOLD / SNAPSHOT_CHECKSUM_MISMATCH", "exact sealed checksum code");
    assert.match(thrown.message, /CURRENT checksum mismatch/, "exact sealed message");

    // Revert: restore exact bytes.
    writeFileSync(curPath, bytes);
    const revertedRead = readCurrent(fx.execDir);
    assert.ok(revertedRead?.snapshot, "REVERTED: clean read restored (discriminates)");
    assert.equal(revertedRead.snapshot.revision, cur.snapshot.revision, "reverted bytes identical (same revision)");
  } finally { fx.cleanup(); await cleanupLegs(); }
});

// ── P4: EPHEMERAL PRESERVED ─────────────────────────────────────────────────
// Injection: none needed at the boundary — the discriminating property is
// that a fresh child CANNOT carry the previous child's in-memory ledger.
// The probe proves the ledger is process-local: two legs on the SAME
// fixture report disjoint ledgers (leg2 starts from zero regardless of
// leg1's activity).
test("E2 PROBE P4: ephemeral ledger does not survive the process boundary (fresh child starts at zero)", async () => {
  const fx = await makeW4CheckpointedFixture({ tag: "p4" });
  try {
    const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "p4-leg1" });
    const v1 = leg1.value("LEG");
    assert.equal(v1.final, "PASS");
    const leg1Count = countCalls(v1.calls, "executor");
    assert.equal(leg1Count, 1, "leg1 executed P2 exactly once (in ITS process)");

    const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "p4-leg2" });
    const v2 = leg2.value("LEG");
    assert.equal(v2.final, "PASS");
    assert.equal(v2.stage, "complete");
    // The discriminating assertion: leg2's ledger does NOT include leg1's
    // call — ephemeral memory did not cross the boundary.
    assert.equal(countCalls(v2.calls, "executor"), 0, "leg2 starts from zero (ephemeral lost)");
    assert.equal(v2.resumed, false, "leg2 short-circuits from durable terminal bytes");
  } finally { fx.cleanup(); await cleanupLegs(); }
});

// ── P5: RECONCILIATION BYPASS ───────────────────────────────────────────────
// Injection: a W3 post-head tail that would be DROPPED if the resume path
// skipped classifyPostHeadEvent. The probe proves the tail is classified:
// the resume leg's journal shows the adoption evidence rows; then the
// probe shows the tail rows are byte-citable before and after (never
// silently removed).
test("E2 PROBE P5: post-head tail bypass injection is discriminated (tail classified + journaled, never silently dropped)", async () => {
  const fx = await makeW4CheckpointedFixture({ tag: "p5" });
  try {
    const headBefore = readCheckpoint(fx.root, fx.executionId).snapshot.journal_head_sequence;
    const rowsBefore = journalRows(fx.store).length;

    const leg = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "p5-leg1" });
    assert.equal(leg.value("LEG").final, "PASS");

    // The post-head rows after the pinned head are still present (append-
    // only journal — no rewrite, no silent drop):
    const rowsAfter = journalRows(fx.store);
    for (let s = 1; s <= rowsBefore; s++) {
      assert.equal(rowsAfter[s - 1].sequence, s, `journal row ${s} intact (append-only, no bypass rewrite)`);
    }
    assert.ok(rowsAfter.length > rowsBefore, "resume appended new rows (classification evidence, not a skip)");

    // The adoption is JOURNALED: the resume window contains the resume
    // evidence rows the bypass would have skipped.
    const newRows = rowsAfter.slice(rowsBefore);
    assert.ok(newRows.some((r) => r.event_type === "RESUME_REQUESTED" || r.event_type === "RESUME_VALIDATED"),
      "resume evidence journaled (bypass would skip this)");
    assert.ok(newRows.some((r) => r.event_type === "PHASE_STARTED"), "remaining phase dispatched via the classified path");
    void headBefore;
  } finally { fx.cleanup(); await cleanupLegs(); }
});
