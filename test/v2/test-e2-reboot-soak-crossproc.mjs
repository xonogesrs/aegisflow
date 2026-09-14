// test/v2/test-e2-reboot-soak-crossproc.mjs
//
// E2 REBOOT SOAK — CROSS-PROCESS CONTINUATION MATRIX (3 tests: X1, X2, X3).
// Companion suite to test-e2-reboot-soak.mjs. Where the main matrix proves
// each reboot scenario's oracle with fresh-process resume LEGS (already
// real child processes), this suite re-proves the three restart-critical
// determinism contracts END-TO-END across a fresh node child per leg with
// the production module tree imported directly from disk — the same sealed
// crossproc discipline as E1's crossproc matrix:
//   X1: restart-never-depends-on-memory (open-tail HOLD re-observed in a
//       brand-new process with zero adapter invocations).
//   X2: restart-never-depends-on-memory for the CONTINUATION class: a
//       checkpointed run completes from durable bytes only, zero
//       CONFIRMED-phase re-execution, in a fresh child.
//   X3: ownership ambiguity never resolves by guessing: the stripped
//       ownership artifact holds in a fresh child, twice (restart-stable
//       durable HOLD).
//
// Worker protocol (same sealed pattern as test-e1-human-mutation-soak-
// crossproc.mjs): the leg source is written to tmp, spawned with
// process.execPath, and reports via `LEG:json` stdout lines. Children run
// the E2 engine-mode resolve redirect (helpers/e2-engine-runtime-shim.mjs)
// through the E2 leg bootstrap — zero VM lifecycle in ANY process (the
// colima instance is not started, probed, stopped, or deleted).

// Run: node --import ./test/v2/helpers/e1-runtime-isolation-preload.mjs --test --test-timeout=60000 test/v2/test-e2-reboot-soak-crossproc.mjs
import "./helpers/e1-runtime-isolation-preload.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeW2OpenTailFixture, makeW4CheckpointedFixture, makeE2Fixture,
  writeEvidenceFixture, installWorkerHelpers,
  freshResumeLeg, cleanupLegs, countCalls,
  journalRows, readCheckpoint, existsSync, join, rmSync,
} from "./helpers/e2-reboot-fixtures.mjs";

writeEvidenceFixture();
const WORKERS = installWorkerHelpers();
Object.assign(process.env, WORKERS.env);

test("E2 X1 CROSSPROC: open INTENT tail refuses continuation from memory in a fully fresh child (HOLD re-observed from durable bytes, zero adapter calls)", async () => {
  const fx = await makeW2OpenTailFixture({ tag: "x1" });
  try {
    // Leg 1 (fresh child): the interrupted-writer HOLD.
    const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "x1-leg1" });
    const v1 = leg1.value("LEG");
    assert.equal(v1.thrown, null);
    assert.equal(v1.final, "HOLD", "open tail never continues from memory");
    assert.equal(v1.reason, "INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED:P1:RECONSTRUCTABLE", "exact classification");

    // Leg 2 (ANOTHER fresh child — a second process boundary): the same
    // classification re-derives from durable bytes; the first child's
    // process memory is gone and can never contribute.
    const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "x1-leg2" });
    const v2 = leg2.value("LEG");
    assert.equal(v2.final, "HOLD", "restart-stable classification");
    assert.equal(v2.reason, v1.reason, "identical verdict bytes across the boundary");

    // Zero adapter invocation across BOTH legs (memory-replay would have
    // re-run the phase).
    assert.equal(countCalls(v1.calls, "executor"), 0);
    assert.equal(countCalls(v2.calls, "executor"), 0);
  } finally { fx.cleanup(); await cleanupLegs(); }
});

test("E2 X2 CROSSPROC: checkpointed run completes from durable bytes only in a fresh child (CONTINUE_WITH_FRESH_FACTS, zero CONFIRMED-phase re-execution)", async () => {
  const fx = await makeW4CheckpointedFixture({ tag: "x2" });
  try {
    const pinnedHash = readCheckpoint(fx.root, fx.executionId).snapshot.phase_result_hashes.P1;

    const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "x2-leg1" });
    const v1 = leg1.value("LEG");
    assert.equal(v1.thrown, null);
    assert.equal(v1.final, "PASS", "continuation completes from durable bytes");
    assert.equal(countCalls(v1.calls, "executor:P1"), 0, "CONFIRMED phase never re-executed");
    assert.equal(countCalls(v1.calls, "executor:P2"), 1, "remaining phase executed exactly once");

    const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snap.final_verdict, "PASS", "terminal truth durable");
    assert.equal(snap.phase_result_hashes.P1, pinnedHash, "P1 hash unchanged (durable, not re-derived)");
    assert.equal(snap.phase_states.P2, "passed");

    // Second fresh child: terminal short-circuit, zero re-execution.
    const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "x2-leg2" });
    const v2 = leg2.value("LEG");
    assert.equal(v2.final, "PASS");
    assert.equal(v2.stage, "complete");
    assert.equal(v2.complete, true);
    assert.equal(v2.resumed, false, "terminal short-circuit across the second boundary");
    assert.equal(countCalls(v2.calls, "executor"), 0);
  } finally { fx.cleanup(); await cleanupLegs(); }
});

test("E2 X3 CROSSPROC: stripped ownership artifact holds in a fresh child and the HOLD is restart-stable (never guessed, never auto-taken-over)", async () => {
  const fx = await makeE2Fixture({ tag: "x3", writerPhase: false });
  try {
    const ownershipPath = join(fx.execDir, "artifacts", "scratch-ownership.json");
    assert.equal(existsSync(ownershipPath), true, "ownership artifact present pre-strip");
    rmSync(ownershipPath, { force: true });

    const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "x3-leg1" });
    const v1 = leg1.value("LEG");
    assert.equal(v1.final, "HOLD", "missing ownership authority holds in a fresh child");
    assert.equal(v1.reason, "ORCHESTRATION_EXCEPTION:RESUME_FINGERPRINT_MISMATCH", "exact fenced code");
    assert.equal(existsSync(ownershipPath), false, "no silent takeover by the first child");

    // Restart stability: the HOLD published a terminal checkpoint; the next
    // fresh child short-circuits to the SAME durable verdict.
    const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "x3-leg2" });
    const v2 = leg2.value("LEG");
    assert.equal(v2.final, "HOLD", "the HOLD verdict is durable across the boundary");
    assert.equal(v2.stage, "complete");
    assert.equal(v2.reason, "already_terminal");
    assert.equal(existsSync(ownershipPath), false, "still no takeover");
  } finally { fx.cleanup(); await cleanupLegs(); }
});
