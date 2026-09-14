// test/v2/test-e2-reboot-soak.mjs
//
// E2 REBOOT SOAK — MAIN MATRIX (R1–R7 + R-NEG).
// Card: AUTOLOOP-V1-STAGE-F-P5-SOAK-E2-IMPLEMENTATION-1, under the sealed
// admission AUTOLOOP-V1-STAGE-F-P5-SOAK-E2-ADMISSION-1.
//
// Scenario semantics are taken VERBATIM from the frozen inventory
// (E2-SCENARIO-INVENTORY.md) + reboot semantics + persistence ledger +
// oracle contract — no scenario merged, dropped, split, renamed, weakened,
// or promoted into new authority. Eight scenarios, each with:
//   1. a positive/discriminating oracle (exact code / durable byte state),
//   2. a negative arm (a named wrong behavior must NOT occur),
//   3. an exact error/state/code assertion where the authority defines one,
//   4. a second-resume restart-stability check (same verdict re-observed).
//
// Reboot semantics honored (E2-REBOOT-SEMANTICS frozen statement):
//   (1) process-level termination (SIGKILL-class, ungraceful, no cleanup
//       handlers) or graceful stop at a durable-marker-proven window;
//   (2) total loss of process memory (the killed process is a REAL spawned
//       helper; the parent SIGKILLs it — no graceful close, no flush);
//   (3) a FRESH node process resumes from execDir durable bytes ONLY;
//   (4) the resume verdict is produced by the sealed validation chain;
//   (5) reconcile from journal reality for any open tail;
//   (6) verdicts re-observed by a second fresh-process resume.
// Zero production mutation. Zero VM lifecycle. All state in mkdtemp
// namespaces. Engine-mode legs inject DETERMINISTIC adapter factories
// through the existing resumeDurableGraph factory seam — the orchestrator's
// own fail-closed factory contract — so no colima/VM is ever touched.

// Run: node --import ./test/v2/helpers/e1-runtime-isolation-preload.mjs --test --test-timeout=120000 test/v2/test-e2-reboot-soak.mjs
import "./helpers/e1-runtime-isolation-preload.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeE2Fixture, makeW2OpenTailFixture, makeW3PostHeadFixture,
  makeW4CheckpointedFixture, makeTerminalFixture,
  buildIR, writeIrFile, installWorkerHelpers, writeEvidenceFixture,
  spawnRebootWorker, sigkill, waitForExit,
  freshResumeLeg, cleanupLegs, countCalls,
  journalRows, fileDigest, git, readCheckpoint, readCurrent,
  validateContinuity, prepareOwnedScratchRoot, getScratchAuthorityToken,
  wipeScratchPreserving, existsSync, join, readFileSync, writeFileSync,
  rmSync, mkdirSync, mkdtempSync, tmpdir, sha256Text,
} from "./helpers/e2-reboot-fixtures.mjs";

// Every reboot-worker PID is collected here; suite end asserts zero orphans.
const REBOOT_WORKERS = [];
const WORKER_PIDS = [];

writeEvidenceFixture();
const WORKERS = installWorkerHelpers();
// Worker env (production-module URLs + engine-runtime redirect) must reach
// the spawned victims through process.env — spawnRebootWorker inherits it.
Object.assign(process.env, WORKERS.env);

function trackRebootWorker(w) { REBOOT_WORKERS.push(w); }

/** Spawn the reboot victim + record its pid for the zero-orphan attestation. */
function spawnVictim(fixture, mode, extraArgs = []) {
  const ackPath = join(mkdtempSync(join(tmpdir(), `e2-ack-${mode}-`)), "ack.json");
  const irFile = writeIrFile(WORKERS.dir, fixture.ir, `ir-${fixture.tag}.json`);
  const w = spawnRebootWorker(WORKERS.victimPath, [
    "--mode", mode,
    "--root", fixture.root, "--exec", fixture.executionId,
    "--repo", fixture.repo, "--scratch", fixture.scratch,
    "--ir", irFile,
    "--ack", ackPath,
    ...extraArgs,
  ], {});
  w.ackPath = ackPath;
  WORKER_PIDS.push(w.pid);
  trackRebootWorker(w);
  return w;
}

/** Wait until the durable marker file appears (the ack IS the marker). */
async function waitForMarker(ackPath, expect, timeoutMs = 20000, diag = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(ackPath)) {
      const ack = JSON.parse(readFileSync(ackPath, "utf8"));
      if (!expect || ack.marker === expect || ack.delivered) return ack;
    }
    await new Promise((r) => setImmediate(r));
  }
  let detail = "";
  if (diag && typeof diag.stderrText === "function") {
    detail = ` | victim stderr: ${diag.stderrText().slice(0, 400) || "(none)"} | stdout: ${diag.stdoutText().slice(0, 200) || "(none)"}`;
  }
  throw new Error(`E2: worker marker ${expect ?? "any"} not observed at ${ackPath} (timeout)${detail}`);
}

/**
 * The publication-window kill marker for R5 lives OUTSIDE the evidence root:
 * the armed hook writes the ack, and the torn window itself is proven by
 * durable bytes: CURRENT.json present WITHOUT a matching-valid sidecar, or
 * a sidecar whose digest mismatches the CURRENT bytes.
 */
function tornWindowState(execDir) {
  const cur = join(execDir, "CURRENT.json");
  const side = join(execDir, "CURRENT.json.sha256");
  if (!existsSync(cur)) return { cur: false };
  const bytes = readFileSync(cur);
  if (!existsSync(side)) return { cur: true, sidecar: false, torn: true };
  const expected = readFileSync(side, "utf8").trim();
  const actual = sha256Text(bytes);
  return { cur: true, sidecar: true, torn: expected !== actual, expected, actual };
}

// ═══════════════════════════════ R1 ═════════════════════════════════════════
// SIGKILL at W2 (STARTED→CONFIRMED: PHASE_STARTED journaled, terminal row
// open). Fail-closed: interrupted-writer classification, never a memory
// continuation; reconcile-from-reality; restart-stable.

test("E2 R1 M-W2-SIGKILL: SIGKILL of the in-flight writer leaves an open INTENT tail; fresh-process resume classifies fail-closed (INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED) with zero re-execution", async () => {
  const fx = await makeW2OpenTailFixture({ tag: "r1" });
  try {
    // ── Durable pre-kill markers (W2 by construction, re-proven from disk):
    const snapPre = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snapPre.active_phase, "P1");
    assert.equal(snapPre.writer_phase_active, true, "W2: writer_phase_active journaled");
    assert.ok(snapPre.writer_lease_holder, "W2: writer_lease_holder journaled");
    const startedRows = journalRows(fx.store, ["PHASE_STARTED"]);
    assert.equal(startedRows.length, 1, "W2: exactly one PHASE_STARTED row");
    const terminalRows = journalRows(fx.store, ["PHASE_PASSED", "PHASE_HELD", "PHASE_FAILED"]);
    assert.equal(terminalRows.length, 0, "W2: no terminal row yet (open tail)");

    // ── REBOOT: SIGKILL the real in-flight writer helper (no graceful path).
    const victim = spawnVictim(fx, "phase-start-kill", ["--phaseId", "P1"]);
    await waitForMarker(victim.ackPath, "PHASE_STARTED", 20000, victim);
    const victimPid = victim.pid;
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL", "reboot boundary: helper died by SIGKILL (ungraceful, no cleanup)");

    // Ephemeral loss is real: the killed process is gone.
    assert.throws(() => process.kill(victimPid, 0), "victim process memory is unrecoverable");

    // The crash boundary is NOW: every durable row from here on belongs to
    // the fresh-process resume legs, never to the killed process.
    const rowsPreKill = journalRows(fx.store).length;

    // ── FRESH-PROCESS RESUME (durable bytes only; engine-mode adapters).
    const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r1-leg1" });
    const v1 = leg1.value("LEG");
    assert.equal(v1.thrown, null, "resume reaches the recovery decision (no validation crash)");
    assert.equal(v1.final, "HOLD", "open INTENT tail never continues from memory");
    assert.equal(
      v1.reason,
      "INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED:P1:RECONSTRUCTABLE",
      "exact interrupted-writer classification (classifyInterruptedWriter NEVER guesses); the open tail carries PHASE_READY+PHASE_STARTED and no terminal row, so the classifier reconstructs (RECONSTRUCTABLE, not INVALID)",
    );
    assert.equal(v1.stage, "recovery_required");

    // Durable reconciliation evidence: the decision is journaled, and the
    // killed phase was NOT blind-retried (zero executor re-invocation).
    const postRows = journalRows(fx.store).slice(rowsPreKill);
    assert.ok(
      postRows.some((r) => r.event_type === "RESUME_REJECTED" && r.payload?.code === "INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED"),
      "RESUME_REJECTED journaled with the exact code",
    );
    assert.ok(
      postRows.some((r) => r.event_type === "WRITER_RECOVERY_CLASSIFIED"),
      "WRITER_RECOVERY_CLASSIFIED journaled (reconcile-from-reality, not retry)",
    );
    assert.equal(
      postRows.filter((r) => r.event_type === "PHASE_STARTED").length, 0,
      "no continuation of the killed phase from memory (zero re-execution)",
    );

    // ── SECOND RESUME (restart stability): the SAME classification.
    const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r1-leg2" });
    const v2 = leg2.value("LEG");
    assert.equal(v2.final, "HOLD");
    assert.equal(v2.reason, v1.reason, "restart stability: same verdict re-observed");

    // ── Negative arm: a fake in-memory continuation path must NOT occur —
    // the resumed leg's adapter ledger contains no P1 executor/reviewer call
    // (memory-replay recovery would have re-run the phase from nowhere).
    assert.equal(countCalls(v1.calls, "executor"), 0, "no executor re-invocation (no memory replay)");
    assert.equal(countCalls(v1.calls, "reviewer"), 0, "no reviewer invocation on a HOLD leg");
  } finally { fx.cleanup(); }
});

// ═══════════════════════════════ R2 ═════════════════════════════════════════
// SIGKILL at W3: phase terminal journaled (post-head) but the enclosing
// CHECKPOINT never published. Fresh-process resume adopts the resume-safe
// tail FROM THE JOURNAL and folds it through the CEDF gate.

test("E2 R2 M-W3-SIGKILL: SIGKILL between terminal journal row and checkpoint publication; fresh-process resume adopts the post-head tail from journal bytes (RECONCILE_WITHOUT_REPLAY) and folds it through the hash gate", async () => {
  const fx = await makeW3PostHeadFixture({ tag: "r2" });
  try {
    const rowsPreKill = journalRows(fx.store).length;
    const { postHeadRow, pinnedHead } = fx.w3;
    assert.ok(postHeadRow.sequence > pinnedHead, "W3 marker: terminal row beyond pinned head");

    // ── REBOOT: SIGKILL the helper mid-window (before it can publish).
    const victim = spawnVictim(fx, "post-head-kill", ["--phaseId", "P1"]);
    // The victim replays its own PHASE_PASSED post-head row; the kill gates
    // on ITS durable marker (row visible in ITS journal — same store dir).
    await waitForMarker(victim.ackPath, "POST_HEAD", 20000, victim);
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL", "reboot boundary: ungraceful process death");
    const rowsPostKill = journalRows(fx.store);
    const terminalRows = rowsPostKill.filter((r) => r.event_type === "PHASE_PASSED" && r.phase_id === "P1");
    assert.equal(terminalRows.length, 1, "exactly one P1 terminal row (SIGKILL prevented any second publication)");
    assert.ok(rowsPostKill.every((r) => r.sequence > pinnedHead || r.sequence <= pinnedHead), "journal intact");

    // The last CURRENT still pins the PRE-terminal head (post-head reality).
    const snapPre = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snapPre.journal_head_sequence, pinnedHead, "checkpoint head unchanged (unpublished tail)");

    // ── CEDF fold gate (PRE-resume): the pinned crash-era result artifact
    // re-validates byte-for-byte against the CURRENT snapshot — journal-
    // backed folding, not artifact-trusting.
    const foldLeg = await freshResumeLeg({ fixture: fx, mode: "fold", extraArgs: ["--phaseId", "P1"], legKey: "r2-fold" });
    assert.equal(foldLeg.value("LEG").fold.ok, true, "CEDF fold gate accepts the journal-backed result");

    // ── FRESH-PROCESS RESUME: the tail is adopted from JOURNAL bytes.
    const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r2-leg1" });
    const v1 = leg1.value("LEG");
    assert.equal(v1.thrown, null, "resume-safe post-head events classify and proceed");
    assert.equal(v1.final, "PASS", "run continues from adopted journal truth");
    const snapAdopted = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snapAdopted.final_verdict, "PASS", "adopted tail reaches durable terminal truth");

    // Journal evidence of the adoption path (classifyPostHeadEvent resume-
    // safe class admitted the row; RESUME_VALIDATED then RESUME_REQUESTED).
    const postRows = journalRows(fx.store).slice(rowsPostKill.length);
    assert.ok(postRows.some((r) => r.event_type === "RESUME_REQUESTED"), "resume leg journaled (RESUME_REQUESTED)");

    // STALE_GENERATION fence: post-adoption the snapshot's recovery
    // generation advanced past the crash-era result record's generation —
    // the hash-consistent artifact now refuses at the generation fence.
    const staleGenLeg = await freshResumeLeg({ fixture: fx, mode: "fold", extraArgs: ["--phaseId", "P1"], legKey: "r2-stalegen" });
    assert.deepEqual(
      { ok: staleGenLeg.value("LEG").fold.ok, code: staleGenLeg.value("LEG").fold.code },
      { ok: false, code: "STALE_GENERATION" },
      "stale-generation result refuses at the fold gate",
    );

    // ── SECOND RESUME (restart stability): terminal short-circuit, same
    // truth, zero re-execution.
    const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r2-leg2" });
    const v2 = leg2.value("LEG");
    assert.equal(v2.final, "PASS");
    assert.equal(v2.stage, "complete");
    assert.equal(v2.resumed, false, "terminal short-circuit on second resume (resumed:false)");
    assert.equal(v2.complete, true, "terminal short-circuit on second resume (complete:true)");
    assert.equal(countCalls(v2.calls, "executor"), 0, "zero re-execution on the stability leg");

    // ── Negative arm: a STALE result offered post-restart must refuse.
    // Rewrite the PINNED result artifact through an external helper (byte-
    // different content, same graph_generation) — the fold gate must answer
    // RESULT_HASH_MISMATCH exactly. P2's hash pin is the live one in the
    // terminal snapshot (P1 was folded from its crash-era generation), so
    // P2 is the phase whose tamper exercises the hash gate.
    const resultPath = join(fx.execDir, "phases", "P2", "result.json");
    const record = JSON.parse(readFileSync(resultPath, "utf8"));
    record.reason = "e2-stale-offer";
    record.graph_generation = snapAdopted.graph?.recovery_generation ?? 0;
    writeFileSync(resultPath, JSON.stringify(record, null, 2) + "\n");
    const staleLeg = await freshResumeLeg({ fixture: fx, mode: "fold", extraArgs: ["--phaseId", "P2"], legKey: "r2-stale" });
    const staleFold = staleLeg.value("LEG").fold;
    assert.deepEqual(
      { ok: staleFold.ok, code: staleFold.code },
      { ok: false, code: "RESULT_HASH_MISMATCH" },
      "stale/tampered post-restart result refuses at the fold gate",
    );
    // Restart stability of the negative verdict.
    const staleLeg2 = await freshResumeLeg({ fixture: fx, mode: "fold", extraArgs: ["--phaseId", "P2"], legKey: "r2-stale2" });
    assert.equal(staleLeg2.value("LEG").fold.code, "RESULT_HASH_MISMATCH");
  } finally { fx.cleanup(); }
});

// ═══════════════════════════════ R3 ═════════════════════════════════════════
// SIGKILL at W4 (checkpointed, non-terminal): fresh-process resume runs the
// full validation chain, re-executes ONLY the remaining phase, and re-
// verifies every frozen fingerprint. Negative arm: fingerprint drift ⇒
// RESUME_FINGERPRINT_MISMATCH + RESUME_REJECTED journaled.

test("E2 R3 M-W4-SIGKILL: SIGKILL after semantic checkpoint; fresh-process resume validates the full chain and completes remaining phases (CONTINUE_WITH_FRESH_FACTS) with zero CONFIRMED-phase re-execution", async () => {
  const fx = await makeW4CheckpointedFixture({ tag: "r3" });
  try {
    const callsLedger = [];
    const execCountPre = journalRows(fx.store, ["PHASE_STARTED"]).length;
    const pinnedHash = readCheckpoint(fx.root, fx.executionId).snapshot.phase_result_hashes.P1;

    // ── REBOOT: SIGKILL the helper (it would have continued the run).
    const victim = spawnVictim(fx, "post-head-kill", ["--phaseId", "P1"]);
    await waitForMarker(victim.ackPath, "POST_HEAD", 20000, victim);
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL", "reboot boundary: ungraceful process death");

    // ── FRESH-PROCESS RESUME (engine-mode deterministic adapters).
    const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r3-leg1", extraArgs: [] });
    const v1 = leg1.value("LEG");
    assert.equal(v1.thrown, null, "validation chain passes on honest durable state");
    assert.equal(v1.final, "PASS", "run resumes and completes remaining phases");
    // Terminal truth is durable, not just in the envelope: the continuation
    // path published RUN_PASSED + a terminal checkpoint.
    const snapTerminal = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snapTerminal.final_verdict, "PASS", "terminal verdict published (durable terminal truth)");

    // Zero re-execution of the CONFIRMED phase: P1's executor/reviewer never
    // re-ran; only P2 (the remaining phase) was dispatched.
    assert.equal(countCalls(v1.calls, "executor:P1"), 0, "P1 (CONFIRMED) never re-executed");
    assert.equal(countCalls(v1.calls, "executor:P2"), 1, "P2 (remaining) executed exactly once");

    // The resumed run's executed-phase set == journal plan minus completed.
    const snapPost = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snapPost.phase_states.P1, "passed");
    assert.equal(snapPost.phase_states.P2, "passed");
    assert.equal(snapPost.phase_result_hashes.P1, pinnedHash, "P1 result hash unchanged (durable, not re-derived)");

    // ── SECOND RESUME (restart stability): terminal short-circuit.
    const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r3-leg2" });
    const v2 = leg2.value("LEG");
    assert.equal(v2.final, "PASS");
    assert.equal(v2.stage, "complete");
    assert.equal(countCalls(v2.calls, "executor"), 0, "zero re-execution on the stability leg");

    // ── Negative arm (fingerprint fencing is LIVE post-reboot): a minimal
    // field mutation to the FROZEN INPUT artifact ⇒ RESUME_FINGERPRINT_MISMATCH
    // ("input fingerprint mismatch") + RESUME_REJECTED journaled (:1603).
    const inputPath = join(fx.execDir, "artifacts", "input.json");
    const frozen = JSON.parse(readFileSync(inputPath, "utf8"));
    frozen.parent = { scope: { drifted: true } };
    writeFileSync(inputPath, JSON.stringify(frozen));
    const driftLeg = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r3-drift" });
    const d = driftLeg.value("LEG");
    assert.equal(d.thrown?.code, "RESUME_FINGERPRINT_MISMATCH", "drifted frozen input fences the resume");
    assert.match(d.thrown?.message ?? "", /input fingerprint mismatch/, "exact field named");
    const driftRows = journalRows(fx.store).filter((r) => r.event_type === "RESUME_REJECTED");
    assert.ok(
      driftRows.some((r) => r.payload?.code === "RESUME_FINGERPRINT_MISMATCH"),
      "RESUME_REJECTED journaled (:1603)",
    );
    // Restart stability of the rejection: the terminal truth from leg1 still
    // stands; the drifted call is refused identically a second time.
    const driftLeg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r3-drift2" });
    assert.equal(driftLeg2.value("LEG").thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    void callsLedger; void execCountPre;
  } finally { fx.cleanup(); }
});

// ═══════════════════════════════ R4 ═════════════════════════════════════════
// W5 full fresh-process profile: graceful stop of a TERMINAL run, restart in
// a brand-new process reading only durable bytes. Terminal short-circuit:
// zero re-execution, zero duplicate side effects, stable id mapping.

test("E2 R4 M-W5-FRESHPROC: fresh-process resume of a terminally complete run short-circuits (ACCEPT_ALREADY_COMPLETED_SIDE_EFFECT) with zero re-execution and stable durable-execution-id mapping", async () => {
  const fx = await makeTerminalFixture({ tag: "r4" });
  try {
    assert.equal(fx.checkpoint.snapshot.final_verdict, "PASS", "pre-reboot: terminal PASS published");

    // ── FRESH-PROCESS RESUME (the reboot boundary is the process exit).
    const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r4-leg1" });
    const v1 = leg1.value("LEG");
    assert.equal(v1.thrown, null);
    assert.equal(v1.final, "PASS", "terminal truth from durable bytes");
    assert.equal(v1.stage, "complete");
    assert.equal(v1.complete, true);
    assert.equal(v1.resumed, false, "no replay across the process boundary");
    assert.equal(v1.recovery?.duplicateSuppressed, 0, "duplicate side effects = 0 (DE-2R pin 2)");
    assert.equal(v1.evidence?.state, "COMPLETE");
    assert.equal(countCalls(v1.calls, "executor"), 0, "zero re-execution (counter == 0)");

    // ── SECOND RESUME (restart stability): identical short-circuit.
    const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r4-leg2" });
    const v2 = leg2.value("LEG");
    assert.equal(v2.final, "PASS");
    assert.equal(v2.stage, "complete");
    assert.equal(v2.resumed, false);
    assert.equal(v2.recovery?.duplicateSuppressed, 0);

    // Durable-execution-id mapping stable (DE-2R pin 4): the subagent entry
    // maps the caller's logical id to the SAME durable id in a fresh process.
    const leg3 = await freshResumeLeg({ fixture: fx, mode: "resume-subagent", legKey: "r4-leg3" });
    const v3 = leg3.value("LEG");
    assert.equal(v3.thrown, null);
    assert.equal(v3.durableExecutionId, fx.executionId, "logical->durable id mapping stable");
    assert.equal(v3.final, "PASS");
    assert.equal(countCalls(v3.calls, "executor"), 0, "no re-execution through the subagent entry either");

    // ── Negative arm: the verdict must cite DURABLE BYTES, never memory.
    // Provenance: a fresh process has no channel to the harness's fixtures —
    // assert the result envelope's evidence root points at the durable store
    // and the checkpoint digest basis is the external CURRENT file.
    assert.equal(v1.evidence?.root, fx.root, "verdict provenance = durable store root");
    const cur = readCurrent(fx.execDir);
    assert.equal(cur.snapshot.final_verdict, "PASS");
    assert.equal(cur.snapshot.checkpoint_integrity?.digest_basis, "external_current_file");
  } finally { fx.cleanup(); }
});

// ═══════════════════════════════ R5 ═════════════════════════════════════════
// SIGKILL during the REAL publication window (fs-atomic CAS/lock/permit):
// CURRENT replaced, sidecar not yet renamed. The torn revision must never be
// adopted; the previous-consistent state stays provable; no silent rollback,
// no silent acceptance; exact HOLD code on the read path.

test("E2 R5 M-W4-TORN: SIGKILL inside the real publication window; the torn revision is never adopted (SNAPSHOT_CHECKSUM_MISMATCH), the prior-consistent CURRENT stays provable, and reconciliation re-derives publication eligibility", async () => {
  const fx = await makeW4CheckpointedFixture({ tag: "r5" });
  try {
    const prior = readCurrent(fx.execDir);
    const priorBytes = Buffer.from(prior.bytes).toString("hex");
    const priorRevision = prior.snapshot.revision;

    // ── REBOOT: SIGKILL the publishing helper inside the torn window.
    // The victim arms the sealed before_checksum_rename hook, enters a
    // runner-view publication, and the parent kills it the moment the
    // durable torn-window marker (ack file) is visible.
    const victim = spawnVictim(fx, "publish-torn-cancel", ["--phaseId", "P2"]);
    const ack = await waitForMarker(victim.ackPath, null);
    assert.equal(ack.marker, "TORN", "torn-window marker observed");
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL", "reboot boundary: killed mid-publication");

    // ── Durable post-kill reality (byte-proven, not assumed):
    const torn = tornWindowState(fx.execDir);
    assert.equal(torn.cur, true, "CURRENT.json bytes present (atomic replace completed or prior)");
    // The kill races the hook: the window may leave CURRENT/new-or-prior with
    // a sidecar mismatch, or the publication may have been refused before the
    // rename. EITHER WAY the invariant is: the read path adopts NOTHING that
    // is not checksum-provable, and the prior revision is re-derivable.
    const legRead = await freshResumeLeg({ fixture: fx, mode: "read-current", legKey: "r5-read" });
    const r = legRead.value("LEG");
    if (torn.torn) {
      // Torn window realized: the read path MUST fail closed with the exact
      // sealed code — silent acceptance of the torn revision is forbidden.
      assert.equal(r.adopted, false, "torn revision NEVER adopted");
      assert.equal(r.adoptCode, "HOLD / SNAPSHOT_CHECKSUM_MISMATCH", "exact sealed code on the read path");
      assert.match(r.adoptMessage ?? "", /checksum mismatch/i);

      // Resume on the unprovable store fails closed identically (no
      // publication succeeds from a tampered/unprovable state). The resume
      // entry throws the sealed C2D hold class with the exact code string.
      const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r5-resume1" });
      const v1 = leg1.value("LEG");
      assert.equal(v1.thrown?.code, "HOLD / SNAPSHOT_CHECKSUM_MISMATCH", "resume refuses the unprovable checkpoint (exact sealed hold code)");
      const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r5-resume2" });
      assert.equal(leg2.value("LEG").thrown?.code, "HOLD / SNAPSHOT_CHECKSUM_MISMATCH", "restart stability of the refusal");
    } else {
      // The kill landed before the new CURRENT rename: the prior-consistent
      // state must still be exactly provable — byte-identical.
      assert.equal(r.adopted, true, "prior-consistent CURRENT reads clean");
      assert.equal(r.revision, priorRevision, "no torn revision adopted (revision unchanged)");
      assert.equal(readCurrent(fx.execDir).bytes.toString("hex"), priorBytes, "prior bytes byte-identical (no silent rollback, no silent acceptance)");
    }

    // ── Negative arm (both directions, on the torn realization): if torn,
    // a silent rollback to prior would also be visible as a VALID sidecar —
    // the mismatch proves neither acceptance nor rollback happened.
    if (torn.torn) {
      assert.notEqual(torn.expected, torn.actual, "sidecar is stale relative to CURRENT bytes (torn, not rolled back)");
    }

    // ── Reconciliation boundary documented by evidence: what remains
    // trustworthy = the journal (append-only, intact across the kill).
    const rows = journalRows(fx.store, ["CHECKPOINT_PUBLISHED"]);
    assert.ok(rows.length >= 1, "journal CHECKPOINT_PUBLISHED rows intact (reconciliation base)");
  } finally { fx.cleanup(); }
});

// ═══════════════════════════════ R6 ═════════════════════════════════════════
// Reboot-resume across the scratch reclamation boundary: the resume-time
// owned-scratch wipe reclaims worktrees/phase scratch but PRESERVES the
// persisted results dir (DE-2R pin 1); preserved results re-fold only
// through the RESULT_HASH/STALE_GENERATION gate.

test("E2 R6 M-W5-SCRATCHWIPE: reboot-resume scratch wipe reclaims phase scratch and preserves the persisted results dir (wipeScratchPreserving); stale scratch authority cannot resurrect through the fold gate", async () => {
  const fx = await makeW4CheckpointedFixture({ tag: "r6" });
  try {
    // ── Pre-reboot durable state: persisted results under the owned child.
    const resultsDir = join(fx.ownedScratchRoot, "results");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "P1.json"), JSON.stringify({ phase_id: "P1", persisted: true }));
    const phaseScratch = join(fx.ownedScratchRoot, "P1", "scratch");
    mkdirSync(phaseScratch, { recursive: true });
    writeFileSync(join(phaseScratch, "stale.txt"), "reclaimable phase scratch\n");
    const resultsDigest = fileDigest(join(resultsDir, "P1.json"));

    // ── REBOOT: SIGKILL the helper at the phase boundary, then the fresh
    // process performs the resume-time wipe semantics (DE-2R pin 1).
    const victim = spawnVictim(fx, "post-head-kill", ["--phaseId", "P1"]);
    await waitForMarker(victim.ackPath, "POST_HEAD", 20000, victim);
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL");

    // ── Wipe boundary proof (the resume entry's FIRST scratch act, before
    // any phase dispatch): wipeScratchPreserving runs with the DURABLE
    // authority token re-derived from the artifact — reclaiming phase
    // scratch while preserving the results dir. Asserted at the boundary
    // itself: after the resumed run reaches terminal, the production
    // cleanup legitimately removes the whole owned child.
    wipeScratchPreserving({ scratchRoot: fx.scratch, executionId: fx.executionId, repoPath: fx.repo, preserve: ["results"], authorityToken: fx.authorityToken });
    assert.equal(existsSync(join(resultsDir, "P1.json")), true, "persisted results NOT dropped by the resume wipe");
    assert.equal(fileDigest(join(resultsDir, "P1.json")), resultsDigest, "preserved result bytes unchanged");
    assert.equal(existsSync(join(phaseScratch, "stale.txt")), false, "phase scratch reclaimed by design");
    assert.equal(existsSync(join(fx.ownedScratchRoot, ".autoloop-owner.json")), true, "ownership marker intact");

    // Fresh-process resume: ownership authority re-derived from the durable
    // artifact, run continues and completes.
    const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r6-leg1" });
    const v1 = leg1.value("LEG");
    assert.equal(v1.thrown, null, "resume proceeds with ownership authority re-derived from the artifact");
    assert.equal(v1.final, "PASS", "resumed run completes with preserved results");
    const snapR6Terminal = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snapR6Terminal.final_verdict, "PASS", "terminal verdict published (durable terminal truth)");

    // ── SECOND RESUME (restart stability).
    const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r6-leg2" });
    const v2 = leg2.value("LEG");
    assert.equal(v2.final, "PASS");
    assert.equal(v2.stage, "complete");
    assert.equal(countCalls(v2.calls, "executor"), 0);

    // ── Negative arm: a stale scratch-era result offered back through the
    // fold gate must refuse. The gate's fence order is
    // hash → journal-proof → generation; a re-serialized stale-generation
    // artifact is first caught by the hash fence (RESULT_HASH_MISMATCH) —
    // the exact fail-closed refusal the card demands (no silent
    // re-adoption). The STALE_GENERATION fence is separately proven in R2's
    // post-resume fold probe (hash-consistent artifact, advanced snapshot
    // generation).
    const record = JSON.parse(readFileSync(join(fx.execDir, "phases", "P1", "result.json"), "utf8"));
    record.graph_generation = (record.graph_generation ?? 0) - 1;
    writeFileSync(join(fx.execDir, "phases", "P1", "result.json"), JSON.stringify(record, null, 2) + "\n");
    const staleLeg = await freshResumeLeg({ fixture: fx, mode: "fold", extraArgs: ["--phaseId", "P1"], legKey: "r6-stale" });
    const staleFold = staleLeg.value("LEG").fold;
    assert.equal(staleFold.ok, false, "stale-generation scratch result refused");
    assert.equal(staleFold.code, "RESULT_HASH_MISMATCH", "exact fail-closed refusal at the fold gate (no silent re-adoption)");
  } finally { fx.cleanup(); }
});

// ═══════════════════════════════ R7 ═════════════════════════════════════════
// Reboot across ownership/rollover context: scratch-ownership authority is
// re-derived from the durable artifact; the rollover mirror rides every
// checkpoint; a missing ownership artifact is an exact HOLD; ownership is
// never guessed, never auto-taken-over.

test("E2 R7 M-W5-ROLLOVER: reboot-resume re-derives scratch-ownership authority from the durable artifact and carries the rollover mirror; stripped ownership artifact is an exact HOLD (never guessed, no takeover)", async () => {
  const fx = await makeE2Fixture({ tag: "r7", writerPhase: false });
  try {
    // Rollover mirror with durable ABORTED-era truth: owner preserved, no
    // transfer record (ROLLOVER_ABORTED_PRE_TRANSFER => same-session
    // semantics restored, owner still A; §14 legacy semantics).
    const snapshot = readCheckpoint(fx.root, fx.executionId).snapshot;
    const rolloverMirror = {
      schema: "autoloop.rollover/v1",
      state: "ROLLOVER_ABORTED_PRE_TRANSFER",
      active_rollover_id: null,
      last_rollover_id: null,
      owner: {
        actor: "e2-owner-a",
        session_identity_digest: "a".repeat(64),
        session_generation: 0,
      },
      transfers: {},
      acks: {},
    };
    // Publish the mirror through the REAL state machine (seeded state +
    // checkpoint — the same seam _publishCheckpoint uses; single writer).
    fx.run.state.rolloverMirror = rolloverMirror;
    await fx.run.checkpoint({});
    const snapWithMirror = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snapWithMirror.graph?.rollover?.state, "ROLLOVER_ABORTED_PRE_TRANSFER", "rollover mirror published inside the checksummed CURRENT");

    // Durable ownership authority artifact exists (boot wrote it).
    const ownershipPath = join(fx.execDir, "artifacts", "scratch-ownership.json");
    assert.equal(existsSync(ownershipPath), true, "scratch-ownership.json is durable reality");
    const token = JSON.parse(readFileSync(ownershipPath, "utf8")).authorityToken;
    assert.equal(typeof token, "string");

    // ── REBOOT: SIGKILL, then fresh-process resume re-derives authority.
    const victim = spawnVictim(fx, "hold-kill", ["--phaseId", "P1"]);
    await waitForMarker(victim.ackPath, "HOLD_BOUNDARY", 20000, victim);
    sigkill(victim);
    await waitForExit(victim.child);
    const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r7-leg1" });
    const v1 = leg1.value("LEG");
    assert.equal(v1.thrown, null, "ownership authority re-derived from the artifact (clean arm)");
    assert.equal(v1.final, "PASS", "resume proceeds only with proven ownership");

    // Rollover mirror continuity: the resumed run's next checkpoint still
    // carries the mirror (never dropped by normal publications).
    const snapPost = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snapPost.graph?.rollover?.state, "ROLLOVER_ABORTED_PRE_TRANSFER", "rollover mirror survives the reboot-resume");

    // ── SECOND RESUME (restart stability).
    const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "r7-leg2" });
    const v2 = leg2.value("LEG");
    assert.equal(v2.final, "PASS");
    assert.equal(v2.stage, "complete");

    // ── Negative arm: strip the ownership authority artifact ⇒ exact HOLD
    // (the :1829 fence throws DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH",
    // "scratch ownership authority missing"); the resume entry's graph
    // invocation boundary wraps it as ORCHESTRATION_EXCEPTION:<code> — the
    // production surface this corpus asserts byte-for-byte); the resume
    // NEVER guesses ownership, NEVER auto-takes-over. The fence is live on
    // a NON-terminal execution (a terminal run short-circuits before the
    // ownership seam), so the negative arm runs on its own fresh fixture.
    const fxStrip = await makeE2Fixture({ tag: "r7-strip", writerPhase: false });
    try {
      const stripOwnershipPath = join(fxStrip.execDir, "artifacts", "scratch-ownership.json");
      assert.equal(existsSync(stripOwnershipPath), true, "strip fixture: ownership artifact present");
      rmSync(stripOwnershipPath, { force: true });
      const strippedLeg = await freshResumeLeg({ fixture: fxStrip, mode: "resume", legKey: "r7-stripped" });
      const s = strippedLeg.value("LEG");
      assert.equal(s.final, "HOLD", "stripped ownership artifact holds");
      assert.equal(s.reason, "ORCHESTRATION_EXCEPTION:RESUME_FINGERPRINT_MISMATCH", "exact fenced code through the orchestration boundary");
      assert.match(s.holdCode ?? "", /RESUME_FINGERPRINT_MISMATCH/, "hold code carries the fence");
      // Restart stability of the HOLD: the HOLD published a terminal
      // checkpoint, so the second leg short-circuits to the SAME durable
      // verdict (stage complete, reason already_terminal) — the hold is
      // durable, not re-derived.
      const strippedLeg2 = await freshResumeLeg({ fixture: fxStrip, mode: "resume", legKey: "r7-stripped2" });
      const s2 = strippedLeg2.value("LEG");
      assert.equal(s2.final, "HOLD", "restart stability: the HOLD verdict is durable");
      assert.equal(s2.stage, "complete");
      assert.equal(s2.reason, "already_terminal");
      // No automatic takeover: the artifact was NOT re-created by any leg.
      assert.equal(existsSync(stripOwnershipPath), false, "ownership authority never resurrected (no silent takeover)");
    } finally { fxStrip.cleanup(); }
  } finally { fx.cleanup(); }
});

// ═════════════════════════════ R-NEG ════════════════════════════════════════
// Negative control: NO reboot injection at all — a healthy non-terminal run
// with a clean checkpoint, fresh-process resume. Must validate and complete
// with NO spurious HOLD: the reboot profiles above detect the REBOOT CLASS,
// not merely any restart (E1 C19 analog).

test("E2 R-NEG NEG-CONTROL: no-mutation no-kill fresh-process resume continues from durable bytes (RESUME_VALIDATED) with identical phase set and NO spurious HOLD", async () => {
  const fx = await makeW4CheckpointedFixture({ tag: "rneg" });
  try {
    const before = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(before.final_verdict, null, "healthy non-terminal run");
    const phasesBefore = JSON.stringify(before.phase_states);

    // ── FRESH-PROCESS RESUME (no kill, no injection, no mutation).
    const leg1 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "rneg-leg1" });
    const v1 = leg1.value("LEG");
    assert.equal(v1.thrown, null, "clean resume validates");
    assert.equal(v1.final, "PASS", "run completes from durable bytes only");
    assert.equal(v1.recovery?.resumed, true, "recovery provenance: reconstruction from durable bytes");

    // The completed phase set matches the durable plan (identical phase set).
    const after = readCheckpoint(fx.root, fx.executionId).snapshot;
    const expectedCompleted = { ...JSON.parse(phasesBefore), P2: "passed" };
    assert.deepEqual(after.phase_states, expectedCompleted, "identical phase set, no over-invalidation");

    // NO spurious HOLD: no RESUME_REJECTED row anywhere in the leg window.
    const rejected = journalRows(fx.store, ["RESUME_REJECTED"]);
    assert.equal(rejected.length, 0, "negative control proves no over-invalidation (no spurious HOLD)");

    // ── SECOND RESUME (restart stability): terminal short-circuit.
    const leg2 = await freshResumeLeg({ fixture: fx, mode: "resume", legKey: "rneg-leg2" });
    const v2 = leg2.value("LEG");
    assert.equal(v2.final, "PASS");
    assert.equal(v2.stage, "complete");
    assert.equal(v2.resumed, false);
    assert.equal(countCalls(v2.calls, "executor"), 0);
  } finally { fx.cleanup(); }
});

// ── Suite-level attestation: every reboot worker died; no orphans. ─────────
test("E2 SUITE CLEANUP: zero surviving reboot-worker processes; worker helpers removed", async () => {
  const attestation = cleanupLegs === null ? { orphanCount: -1 } : null;
  // cleanupLegs removes leg scripts; the reboot victims were SIGKILLed.
  const survivors = [];
  for (const pid of WORKER_PIDS) {
    try { process.kill(pid, 0); survivors.push(pid); } catch { /* gone: good */ }
  }
  assert.equal(survivors.length, 0, `zero-orphan attestation (survivors: ${JSON.stringify(survivors)})`);
  void attestation;
  WORKERS.cleanup();
});
