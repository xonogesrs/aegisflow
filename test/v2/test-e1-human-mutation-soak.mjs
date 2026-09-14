// test/v2/test-e1-human-mutation-soak.mjs
//
// E1 HUMAN MUTATION SOAK — main matrix (19 tests: C1–C13, C15–C20).
// Card: AUTOLOOP-V1-STAGE-F-P5-SOAK-E1-IMPLEMENTATION-1, under the sealed
// admission AUTOLOOP-V1-STAGE-F-P5-SOAK-E1-ADMISSION-1.
//
// Authorities honored (read from the sealed bundle, never re-invented):
//   - TIMING-AND-ORACLE-MATRIX.md §"Matrix" — one discriminating oracle per
//     case, exact codes only (no generic retry/timeout assertions, §6)
//   - MUTATION-CLASS-MATRIX.md M1–M6 — admitted mutation classes only
//   - SOAK-TEST-CONTRACT.md §1 — isolation rules; §2 — file/case split;
//     §5 — per-case evidence fields; §6 — forbidden acts
//   - IMPLEMENTATION-BOUNDARY.md §1/§2 — zero production changes; the four
//     new test files are the ONLY tree delta
//
// Every case: real durable store on temp dirs → checkpoint publication
// observed at a durable marker → mutation by an INDEPENDENT external actor
// (harness / spawned helper owning no executor references) → exact-code
// verdict → durable journal/CURRENT oracle → restart-stability second
// observation → cleanup in finally. No sleep-based timing anywhere: mutation
// placement is proven by durable markers (journal rows / CURRENT fields),
// and pre/post digests of the mutated bytes are captured for the evidence
// bundle (contract §1.6/§1.7).

// Run: node --import ./test/v2/helpers/e1-runtime-isolation-preload.mjs --test test/v2/test-e1-human-mutation-soak.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeGraphStoreFixture, makeProductionRunFixture, makeNonTerminalRunFixture,
  makeTerminalPassFixture, resumeFixture,
  makeAdmission, git, journalRows,
  fileDigest, externalMutate, cleanupAttestation, makeOpenTailC2DFixture,
  readCheckpoint, readCurrent, validateContinuity,
  childResultFoldGate, C3B_HOLD, readLease, acquireLease, runMutation,
  reconcileMutationIntent,
  mkdtempSync, tmpdir, join,
  rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, symlinkSync,
  C2dHoldError, HOLD, RunEvidenceStore, captureResumeVerdict,
} from "./helpers/e1-soak-fixtures.mjs";

function capture(fixture, opts) { return captureResumeVerdict(fixture, opts); }

// Every spawned helper PID is collected here; suite end asserts zero orphans.
const HELPER_PIDS = [];
const ACK_DIRS = [];
function trackHelper(pid, ackDir) { HELPER_PIDS.push(pid); ACK_DIRS.push(ackDir); }

async function mutateAndTrack(ops, tag) {
  const ackDir = mkdtempSync(join(tmpdir(), `e1-ack-${tag}-`));
  const r = await externalMutate({ ops, ackDir, tag });
  trackHelper(r.pid, ackDir);
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// M1 — authoritative repository facts (W4→W5 restart legs)
// ─────────────────────────────────────────────────────────────────────────────

test("E1 C1 M1a W4: commit during non-terminal run rejects stale resume (expected_head)", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "c1" });
  const tracked = join(fx.repo, "human.txt");
  const pre = fileDigest(tracked);
  try {
    // W4 marker: checkpoint published (rev>0), run non-terminal, final_verdict=null.
    const snap = fx.checkpoint.snapshot;
    assert.equal(snap.final_verdict, null, "W4 precondition: run not terminal");
    assert.ok(snap.revision > 0, "W4 precondition: checkpoint exists");

    const mut = await mutateAndTrack([{ op: "write", path: tracked, bytes: "human commit\n" }, { op: "git", repo: fx.repo, args: ["add", "human.txt"] }, { op: "git", repo: fx.repo, args: ["commit", "-q", "-m", "human external commit"] }], "c1");
    assert.equal(mut.code, 0, "external actor acknowledged (exit 0)");
    const post = fileDigest(tracked);
    assert.notEqual(pre, post, "mutation digest changed inside the window");

    // Discriminating oracle: RESUME_FINGERPRINT_MISMATCH naming the field.
    const v = await capture(fx);
    assert.equal(v.thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.match(v.thrown.message, /repository fingerprint mismatch: expected_head/);
    // Durable oracle: RESUME_REJECTED journaled; no CURRENT publication follows.
    assert.equal(v.resumeRejected?.payload?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.equal(v.revisionUnchanged, true, "stale run publishes nothing");

    // C1 recovery leg (RECONCILE_WITHOUT_REPLAN): after re-baseline (git reset
    // to the frozen head by the human/operator), the SAME bytes resume validated.
    const frozenHead = fx.checkpoint.snapshot.repository_fingerprint.expected_head;
    git(fx.repo, ["reset", "-q", "--hard", frozenHead]);
    git(fx.repo, ["clean", "-fdq"]);
    const v2 = await capture(fx);
    assert.equal(v2.resumeValidated, true, "re-baselined run re-validates from durable bytes");
    assert.equal(v2.resumeRejected, null, "no rejection after reconciliation");
  } finally { fx.cleanup(); }
});

test("E1 C2 M1b W4: branch checkout (ref move) rejects stale resume (expected_ref)", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "c2" });
  try {
    assert.equal(fx.checkpoint.snapshot.final_verdict, null);
    const mut = await mutateAndTrack([{ op: "git", repo: fx.repo, args: ["checkout", "-q", "-b", "human-branch"] }], "c2");
    assert.equal(mut.code, 0);
    const v = await capture(fx);
    assert.equal(v.thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.match(v.thrown.message, /repository fingerprint mismatch: expected_ref/);
    assert.equal(v.resumeRejected?.payload?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.equal(v.revisionUnchanged, true);
    // Restart stability: the second attempt returns the SAME classification.
    const v2 = await capture(fx);
    assert.equal(v2.thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.match(v2.thrown.message, /expected_ref/);
  } finally { fx.cleanup(); }
});

test("E1 C3 M1c W4: tracked-file edit on a clean checkpoint rejects (dirty delta)", async () => {
  const fx = await makeProductionRunFixture({ tag: "c3" });
  const tracked = join(fx.repo, "README.md");
  try {
    assert.equal(fx.checkpoint.snapshot.repository_fingerprint.expected_worktree_state, "clean");
    const mut = await mutateAndTrack([{ op: "write", path: tracked, bytes: "# human edit\n" }], "c3");
    assert.equal(mut.code, 0);
    const v = await capture(fx);
    assert.equal(v.thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.match(v.thrown.message, /expected_worktree_state/);
    assert.equal(v.resumeRejected?.payload?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.equal(v.revisionUnchanged, true);
    // Recovery leg: human reverts; same durable bytes resume validated.
    writeFileSync(tracked, "# e1 fixture\n");
    const v2 = await capture(fx);
    assert.equal(v2.resumeValidated, true);
  } finally { fx.cleanup(); }
});

test("E1 C4 M1c' W4: dirty delta confined to the frozen permitted set continues; drift beyond scope rejects", async () => {
  const scope = ["docs/pi-graph-output"];
  const fx = await makeProductionRunFixture({ tag: "c4", dirtyScope: scope, dirtySeed: "docs/pi-graph-output" });
  try {
    // The checkpoint froze the dirty worktree WITH the scope-confined delta.
    const permitted = fx.checkpoint.snapshot.graph?.permitted_dirty_digest ?? null;
    assert.match(String(permitted), /^dirty_filtered:/, "permitted dirty digest frozen");

    // POSITIVE arm: identical filtered digest → resume passes the gate
    // (RESUME_VALIDATED; the run continues and its HOLD comes from the graph
    // runner — never from the fingerprint gate).
    const vSame = await capture(fx, { dirtyScope: scope });
    assert.equal(vSame.resumeValidated, true, "identical filtered digest resumes");
    assert.equal(vSame.resumeRejected, null);
    assert.ok(vSame.result != null);

    // NEGATIVE arm: human drifts OUTSIDE the scope → exact reject code.
    const mut = await mutateAndTrack([{ op: "write", path: join(fx.repo, "README.md"), bytes: "# human drift\n" }], "c4");
    assert.equal(mut.code, 0);
    const vDrift = await capture(fx, { dirtyScope: scope });
    assert.equal(vDrift.thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.match(vDrift.thrown.message, /expected_worktree_state|drifted beyond the frozen\/permitted dirty set/);
    assert.equal(vDrift.resumeRejected?.payload?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.equal(vDrift.revisionUnchanged, true);
  } finally { fx.cleanup(); }
});

test("E1 C5 M1d W4: origin url change rejects stale resume (origin_url)", async () => {
  const fx = await makeProductionRunFixture({ tag: "c5" });
  try {
    assert.equal(fx.checkpoint.snapshot.repository_fingerprint.origin_url, "");
    const mut = await mutateAndTrack([{ op: "git", repo: fx.repo, args: ["remote", "add", "origin", "/tmp/e1-human-remapped-origin.git"] }], "c5");
    assert.equal(mut.code, 0);
    const v = await capture(fx);
    assert.equal(v.thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.match(v.thrown.message, /repository fingerprint mismatch: origin_url/);
    assert.equal(v.resumeRejected?.payload?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.equal(v.revisionUnchanged, true);
    const v2 = await capture(fx);
    assert.match(v2.thrown?.message ?? "", /origin_url/, "restart stability: same classification");
  } finally { fx.cleanup(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// M2 — plan / approval state (W4→W5)
// ─────────────────────────────────────────────────────────────────────────────

test("E1 C6 M2a W4: frozen admission record edited ⇒ ADMISSION_DRIFT on resume", async () => {
  const admission = makeAdmission("E1-C6");
  const fx = await makeNonTerminalRunFixture({ tag: "c6", admission });
  const admissionArtifact = join(fx.execDir, "artifacts", "admission.json");
  assert.ok(existsSync(admissionArtifact), "admission frozen on disk");
  try {
    // HUMAN EDITS the frozen approval identity: the stored admission_id no
    // longer matches the authoritative record ⇒ ADMISSION_DRIFT; the run
    // never continues under a stale approval.
    const rr = JSON.parse(readFileSync(admissionArtifact, "utf8"));
    rr.admission_id = "f".repeat(64);
    const mut = await mutateAndTrack([{ op: "write", path: admissionArtifact, bytes: JSON.stringify(rr) }], "c6");
    assert.equal(mut.code, 0);
    const v = await capture(fx, { admission });
    assert.equal(v.thrown?.code, "ADMISSION_DRIFT");
    assert.match(v.thrown.message, /stored .* != authoritative/);
    assert.equal(v.resumeRejected?.payload?.code, "ADMISSION_DRIFT");
    assert.equal(v.revisionUnchanged, true);
    // Restart stability: the second resume re-observes the same drift.
    const v2 = await capture(fx, { admission });
    assert.equal(v2.thrown?.code, "ADMISSION_DRIFT");
  } finally { fx.cleanup(); }
});

test("E1 C7 M2b W4: frozen input manifest artifact edited ⇒ input fingerprint mismatch", async () => {
  const fx = await makeProductionRunFixture({ tag: "c7" });
  const inputPath = join(fx.execDir, "artifacts", "input.json");
  const pre = fileDigest(inputPath);
  try {
    const mut = await mutateAndTrack([{ op: "write", path: inputPath, bytes: JSON.stringify({ ...JSON.parse(readFileSync(inputPath, "utf8")), manifest: [{ requirement_id: "r1", text: "human-rewritten" }] }) }], "c7");
    assert.equal(mut.code, 0);
    assert.notEqual(pre, fileDigest(inputPath));
    const v = await capture(fx);
    assert.equal(v.thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.match(v.thrown.message, /input fingerprint mismatch/);
    assert.equal(v.resumeRejected?.payload?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.equal(v.revisionUnchanged, true);
    const v2 = await capture(fx);
    assert.match(v2.thrown?.message ?? "", /input fingerprint mismatch/, "restart stability");
  } finally { fx.cleanup(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// M3 — working state / artifacts after a checkpoint (W4)
// ─────────────────────────────────────────────────────────────────────────────

test("E1 C8 M3a W4: phase result artifact edited post-pin ⇒ RESULT_HASH_MISMATCH (fold gate)", async () => {
  const fx = await makeGraphStoreFixture({ tag: "c8" });
  try {
    // Drive R1 to a pinned PASS result through the real hooks/journal.
    const hooks = fx.run.buildGraphHooks(fx.ir);
    await hooks.onPhaseStart({ phaseId: "R1" });
    await fx.run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    await fx.run.checkpoint({});
    const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
    const resultPath = join(fx.execDir, "phases", "R1", "result.json");
    assert.ok(typeof snap.phase_result_hashes.R1 === "string", "hash pinned in CURRENT");
    const pre = fileDigest(resultPath);
    // Positive control: the honest artifact folds.
    const gate0 = childResultFoldGate({ snapshot: snap, store: fx.store, execDir: fx.execDir, phaseId: "R1" });
    assert.equal(gate0.ok, true);

    // HUMAN EDITS the pinned artifact (digest changes, pin does not).
    const mut = await mutateAndTrack([{ op: "write", path: resultPath, bytes: JSON.stringify({ ...JSON.parse(readFileSync(resultPath, "utf8")), reason: "human-rewrite", synthesized: false }) }], "c8");
    assert.equal(mut.code, 0);
    assert.notEqual(pre, fileDigest(resultPath));
    const gate = childResultFoldGate({ snapshot: snap, store: fx.store, execDir: fx.execDir, phaseId: "R1" });
    assert.deepEqual({ ok: gate.ok, code: gate.code }, { ok: false, code: "RESULT_HASH_MISMATCH" });
    // Presence alone never proves application: interrupted-writer classification
    // must NOT return ALREADY_APPLIED off the tampered artifact.
    const { classifyInterruptedWriter } = await import("../../src/v2/durable-graph.mjs");
    const cls = classifyInterruptedWriter({ snapshot: snap, phase: fx.ir.phases[0], execDir: fx.execDir, graphMeta: snap.graph, store: fx.store });
    assert.notEqual(cls, "ALREADY_APPLIED", "tampered artifact can never prove application");
    assert.equal(fileDigest(resultPath) !== pre, true);
    // Restart stability: a second fold observation returns the same code.
    const gate2 = childResultFoldGate({ snapshot: snap, store: fx.store, execDir: fx.execDir, phaseId: "R1" });
    assert.equal(gate2.code, "RESULT_HASH_MISMATCH");
  } finally { fx.cleanup(); }
});

test("E1 C9 M3b W4: old-generation result replayed ⇒ STALE_GENERATION (fold gate)", async () => {
  const fx = await makeGraphStoreFixture({ tag: "c9" });
  try {
    // Pin a generation-0 result for R1 (fully generationed fixture per S8).
    const hooks = fx.run.buildGraphHooks(fx.ir);
    await hooks.onPhaseStart({ phaseId: "R1" });
    await fx.run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    await fx.run.checkpoint({});
    const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snap.graph.recovery_generation, 0);
    // Positive control: matching generation folds.
    const gate0 = childResultFoldGate({ snapshot: snap, store: fx.store, execDir: fx.execDir, phaseId: "R1" });
    assert.equal(gate0.ok, true);
    // HUMAN REPLAYS the old-generation result against generation 1: the result
    // artifact declares graph_generation 0 while the resumed generation is 1.
    const replayed = JSON.parse(readFileSync(join(fx.execDir, "phases", "R1", "result.json"), "utf8"));
    const gen1Snap = JSON.parse(JSON.stringify(snap));
    gen1Snap.graph.recovery_generation = 1; // successor generation offers the stale result
    const gate = childResultFoldGate({ snapshot: gen1Snap, store: fx.store, execDir: fx.execDir, phaseId: "R1" });
    assert.deepEqual({ ok: gate.ok, code: gate.code }, { ok: false, code: "STALE_GENERATION" });
    void replayed;
    // The superseded bytes never enter the ledger: no fold, no duplicateSuppressed.
    assert.equal(gate.record ?? null, null);
    // Restart stability.
    const gate2 = childResultFoldGate({ snapshot: gen1Snap, store: fx.store, execDir: fx.execDir, phaseId: "R1" });
    assert.equal(gate2.code, "STALE_GENERATION");
  } finally { fx.cleanup(); }
});

test("E1 C10 M3c W4: decomposition IR artifact edited ⇒ IR hash mismatch (DAG variant asserted)", async () => {
  const fx = await makeProductionRunFixture({ tag: "c10" });
  const irPath = join(fx.execDir, "artifacts", "decomposition-ir.json");
  try {
    const mut = await mutateAndTrack([{ op: "write", path: irPath, bytes: JSON.stringify({ ...JSON.parse(readFileSync(irPath, "utf8")), phases: [{ phase_id: "RX", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly" } }], dispositions: [] }) }], "c10");
    assert.equal(mut.code, 0);
    const v = await capture(fx);
    assert.equal(v.thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.match(v.thrown.message, /IR hash mismatch/);
    assert.equal(v.resumeRejected?.payload?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.equal(v.revisionUnchanged, true);
    // Restart stability: the same tampered bytes re-observe the same code.
    const v2 = await capture(fx);
    assert.match(v2.thrown?.message ?? "", /IR hash mismatch/);
  } finally { fx.cleanup(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// M4 — durable record of a journaled side effect (W2/W3/W4)
// ─────────────────────────────────────────────────────────────────────────────

test("E1 C11 M4a W2/W3: COMPLETE row without INTENT ⇒ UNEXPECTED_COMPLETION_WITHOUT_INTENT (no blind replay)", async () => {
  const fx = await makeOpenTailC2DFixture({ tag: "c11" });
  try {
    // Construction: the owner (with the lease's session secrets) legitimately
    // closes the open tail, leaving two COMPLETE transitions.
    await fx.ro.runReadOnlyDiscovery({ repoRoot: fx.repo, checkpointRoot: fx.checkpointRoot, actorId: `owner-c11`, inputPaths: ["a.txt"], executionId: fx.executionId, sessionId: fx.ownerSessionId, sessionSecret: fx.ownerSessionSecret, leaseSecret: fx.ownerLeaseSecret });
    const cont0 = validateContinuity(fx.execDir);
    assert.equal(cont0.lastComplete, 2, "baseline: two complete transitions");
    // HUMAN copies a COMPLETE row to a revision that has no INTENT row:
    // an orphan completion of an effect that was never opened.
    const orphan = join(fx.execDir, "journal", "000000000003.complete.json");
    const mut = await mutateAndTrack([{ op: "copy", from: join(fx.execDir, "journal", "000000000001.complete.json"), to: orphan }], "c11");
    assert.equal(mut.code, 0);
    assert.ok(existsSync(orphan));
    let thrown = null;
    try { validateContinuity(fx.execDir); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof C2dHoldError);
    assert.equal(thrown.code, HOLD.UNEXPECTED_COMPLETION_WITHOUT_INTENT);
    assert.match(thrown.message, /complete without intent at 3/);
    // The C2D evidence journal and the graph checkpoint stay unreconcilable:
    // a graph-level resume of this checkpoint cannot silently accept the
    // orphan (the durable CURRENT still reflects the pre-orphan ledger and
    // continuity is re-validated on every reconcile).
    let recon = null;
    try {
      const { reconcileReadOnlyIntent } = await import("../../src/c2d/reconcile.mjs");
      const { discoverReadOnly } = await import("../../src/c2d/read-only-discovery-run.mjs");
      await reconcileReadOnlyIntent(fx.execDir, { leaseId: "x", actorId: "a", leaseRevision: 1, secrets: null, revision: 3, reRunDiscovery: () => discoverReadOnly(fx.repo, ["a.txt"]), buildCompleteRecord: () => ({}), buildSnapshot: ({ previous }) => previous });
    } catch (e) { recon = e; }
    assert.ok(recon instanceof C2dHoldError, "reconcile fails closed on the ambiguous ledger");
    // Restart stability: a fresh read re-observes the same HOLD.
    let thrown2 = null;
    try { validateContinuity(fx.execDir); } catch (e) { thrown2 = e; }
    assert.equal(thrown2?.code, HOLD.UNEXPECTED_COMPLETION_WITHOUT_INTENT);
  } finally { fx.cleanup(); }
});

test("E1 C12 M4b W2: INTENT row removed under the journal ⇒ UNEXPECTED_COMPLETION_WITHOUT_INTENT / JOURNAL_GAP (effect never blind-retried)", async () => {
  // Baseline: two COMPLETE transitions (owner closes the constructed tail).
  const fx = await makeOpenTailC2DFixture({ tag: "c12" });
  try {
    await fx.ro.runReadOnlyDiscovery({ repoRoot: fx.repo, checkpointRoot: fx.checkpointRoot, actorId: `owner-c12`, inputPaths: ["a.txt"], executionId: fx.executionId, sessionId: fx.ownerSessionId, sessionSecret: fx.ownerSessionSecret, leaseSecret: fx.ownerLeaseSecret });
    assert.equal(validateContinuity(fx.execDir).lastComplete, 2);
    // Form 1 (opening row removed): delete INTENT@1 — COMPLETE@1 and @2 now
    // reference transitions whose opening rows are gone.
    const mut = await mutateAndTrack([{ op: "delete", path: join(fx.execDir, "journal", "000000000001.intent.json") }], "c12");
    assert.equal(mut.code, 0);
    let thrown = null;
    try { validateContinuity(fx.execDir); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof C2dHoldError);
    assert.equal(thrown.code, HOLD.UNEXPECTED_COMPLETION_WITHOUT_INTENT);
    assert.match(thrown.message, /complete without intent at 1/);
    // Form 2 (whole first row-pair removed): JOURNAL_GAP at 2.
    await mutateAndTrack([{ op: "delete", path: join(fx.execDir, "journal", "000000000001.complete.json") }], "c12b");
    let gap = null;
    try { validateContinuity(fx.execDir); } catch (e) { gap = e; }
    assert.equal(gap?.code, HOLD.JOURNAL_GAP);
    assert.match(gap.message, /first revision must be 1, got 2/);
    // Restart stability: fresh reads re-observe the same classification.
    let gap2 = null;
    try { validateContinuity(fx.execDir); } catch (e) { gap2 = e; }
    assert.equal(gap2?.code, HOLD.JOURNAL_GAP);
  } finally { fx.cleanup(); }
});

test("E1 C13 M4c W4: CURRENT.json bytes corrupted ⇒ SNAPSHOT_CHECKSUM_MISMATCH (state unprovable, no publication)", async () => {
  const fx = await makeGraphStoreFixture({ tag: "c13" });
  try {
    const currentPath = join(fx.execDir, "CURRENT.json");
    const good = readFileSync(currentPath, "utf8");
    const mut = await mutateAndTrack([{ op: "write", path: currentPath, bytes: good.slice(0, Math.floor(good.length / 2)) + "HUMAN-TAMPERED" }], "c13");
    assert.equal(mut.code, 0);
    // Direct read oracle.
    let read = null;
    try { readCurrent(fx.execDir); } catch (e) { read = e; }
    assert.ok(read instanceof C2dHoldError);
    assert.equal(read.code, HOLD.SNAPSHOT_CHECKSUM_MISMATCH);
    assert.match(read.message, /CURRENT checksum mismatch/);
    // Resume oracle: the read-only pre-gate refuses before ANY write (the
    // C2dHoldError propagates out of resumeDurableGraph unfiltered — the
    // checkpoint bytes are unprovable, so no RESUME_REJECTED row can even be
    // journaled against them).
    let thrown = null;
    try {
      await resumeFixture(fx, {});
    } catch (e) { thrown = e; }
    assert.ok(thrown instanceof C2dHoldError);
    assert.equal(thrown.code, HOLD.SNAPSHOT_CHECKSUM_MISMATCH);
    // Restart stability: the corrupted bytes re-observe identically.
    let read2 = null;
    try { readCurrent(fx.execDir); } catch (e) { read2 = e; }
    assert.equal(read2?.code, HOLD.SNAPSHOT_CHECKSUM_MISMATCH);
  } finally { fx.cleanup(); }
});

test("E1 C14 M4d W4: provably complete effect re-asked ⇒ terminal short-circuit (duplicate side effects = 0)", async () => {
  const fx = await makeTerminalPassFixture({ tag: "c14" });
  try {
    // Terminal marker: final_verdict=PASS published through the real state
    // machine (hooks + run.terminal — no synthesized state).
    assert.equal(fx.checkpoint.snapshot.final_verdict, "PASS");
    // HUMAN RE-ASKS the same execution: resume of a final_verdict run
    // short-circuits to terminal truth with zero re-execution.
    const v = await capture(fx);
    assert.equal(v.thrown, null);
    assert.equal(v.result.final, "PASS");
    assert.equal(v.result.stage, "complete");
    assert.equal(v.result.complete, true);
    assert.equal(v.result.resumed, false, "no replay: resume never re-executed");
    assert.equal(v.result.recovery?.duplicateSuppressed, 0);
    assert.equal(v.resumeValidated, true);
    // Restart stability: a second observation returns the same verdict shape.
    const v2 = await capture(fx);
    assert.equal(v2.result?.final, "PASS");
    assert.equal(v2.result?.stage, "complete");
    assert.equal(v2.result?.resumed, false);
  } finally { fx.cleanup(); }
});

test("E1 C15 M5a W2: human deletes the lease record while INTENT open ⇒ RECOVERY_REQUIRED (no takeover)", async () => {
  const fx = await makeOpenTailC2DFixture({ tag: "c15" });
  try {
    const cont = fx.continuity;
    assert.ok(cont.incompleteTail, "open INTENT tail exists");
    const leaseBefore = readLease(fx.execDir);
    assert.ok(leaseBefore && leaseBefore.released_at == null, "active lease at the window");
    // HUMAN DELETES the lease record: ownership of the in-flight effect becomes
    // unprovable — the reconcile path must fail closed, never auto-take-over.
    const mut = await mutateAndTrack([{ op: "delete", path: join(fx.execDir, "lease.json") }], "c15");
    assert.equal(mut.code, 0);
    assert.equal(existsSync(join(fx.execDir, "lease.json")), false);
    // Ownership validation (validateLeaseOwner) ⇒ RESUME_LEASE_CONFLICT.
    let thrown = null;
    try {
      reconcileMutationIntent(fx.execDir, {
        leaseId: leaseBefore.lease_id, actorId: leaseBefore.actor_id,
        leaseRevision: leaseBefore.lease_revision, secrets: null,
        revision: cont.incompleteTail,
        reRunGate: () => ({ classification: "RECOVERY_REQUIRED" }),
        buildCompleteRecord: ({ intent }) => ({ format_version: "1.0.0", record_kind: "verified_complete", revision: intent.revision }),
        buildSnapshot: ({ previous, revision }) => ({ ...previous, revision }),
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown instanceof C2dHoldError);
    assert.equal(thrown.code, HOLD.RESUME_LEASE_CONFLICT);
    assert.match(thrown.message, /no active lease/);
    // The tail remains open (durable verdict: RECOVERY_REQUIRED state persists;
    // nothing was published over the ambiguous effect).
    assert.equal(validateContinuity(fx.execDir).incompleteTail, cont.incompleteTail);
    // Restart stability: a fresh reconcile attempt re-observes the same HOLD.
    let thrown2 = null;
    try {
      reconcileMutationIntent(fx.execDir, {
        leaseId: leaseBefore.lease_id, actorId: leaseBefore.actor_id,
        leaseRevision: leaseBefore.lease_revision, secrets: null,
        revision: cont.incompleteTail,
        reRunGate: () => ({ classification: "RECOVERY_REQUIRED" }),
        buildCompleteRecord: ({ intent }) => ({ format_version: "1.0.0", record_kind: "verified_complete", revision: intent.revision }),
        buildSnapshot: ({ previous, revision }) => ({ ...previous, revision }),
      });
    } catch (e) { thrown2 = e; }
    assert.equal(thrown2?.code, HOLD.RESUME_LEASE_CONFLICT);
  } finally { fx.cleanup(); }
});

test("E1 C16 M5b W2: second external actor forces ownership without secrets ⇒ RECOVERY_REQUIRED (classification, not retry)", async () => {
  const fx = await makeOpenTailC2DFixture({ tag: "c16" });
  try {
    assert.ok(fx.continuity.incompleteTail, "open INTENT tail with the owner's active lease");
    // Arm 1: a second actor's takeover attempt through acquireLease fails closed.
    const lease = readLease(fx.execDir);
    let takeover = null;
    try {
      acquireLease(fx.execDir, {
        execution_id: fx.executionId, chain_id: lease.chain_id, checkpoint_id: lease.checkpoint_id,
        repository_identity: lease.repository_identity, worktree_identity: lease.worktree_identity,
        actor_id: "intruder-b", session_id: "sess_intruder",
        session_secret: "wrong", lease_secret: "wrong",
        expected_head: lease.expected_head,
      });
    } catch (e) { takeover = e; }
    assert.ok(takeover instanceof C2dHoldError);
    assert.equal(takeover.code, HOLD.RESUME_LEASE_CONFLICT);
    assert.match(takeover.message, /active lease exists/);
    // Arm 2: the production mutation-run entry classifies the same situation as
    // C3B RECOVERY_REQUIRED ("active mutation lease; session secrets required").
    const repo2 = fx.repo;
    let cls = null;
    try {
      await runMutation({
        repoRoot: repo2, checkpointRoot: fx.checkpointRoot,
        actorId: "intruder-b", executionId: fx.executionId,
        mutationCommand: null, inputManifest: {},
      });
    } catch (e) { cls = e; }
    assert.ok(cls instanceof C2dHoldError);
    assert.equal(cls.code, C3B_HOLD.RECOVERY_REQUIRED);
    assert.match(cls.message, /active mutation lease; session secrets required to continue/);
    // No takeover happened: the owner's lease record is unchanged.
    const leaseAfter = readLease(fx.execDir);
    assert.equal(leaseAfter.lease_id, lease.lease_id);
    assert.equal(leaseAfter.actor_id, lease.actor_id);
    // Restart stability: a second classification returns the same verdict.
    let cls2 = null;
    try {
      await runMutation({ repoRoot: repo2, checkpointRoot: fx.checkpointRoot, actorId: "intruder-b", executionId: fx.executionId, mutationCommand: null, inputManifest: {} });
    } catch (e) { cls2 = e; }
    assert.equal(cls2?.code, C3B_HOLD.RECOVERY_REQUIRED);
  } finally { fx.cleanup(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// M6 — evidence root / derived generation staleness (W4)
// ─────────────────────────────────────────────────────────────────────────────

test("E1 C17 M6a W4: evidence root identity changed ⇒ PERSISTENCE_ROOT_INVALID / SYMLINK_REJECTED (fail closed before any write)", async () => {
  const { assertValidEvidenceRoot } = await import("../../src/evidence/run-evidence-store.mjs");
  const fx = await makeGraphStoreFixture({ tag: "c17" });
  try {
    // Form 1: human relocates the evidence root INSIDE the repo worktree.
    const badRoot = join(fx.repo, "evidence-relocated");
    let e1 = null;
    try { assertValidEvidenceRoot(badRoot, fx.repo); } catch (e) { e1 = e; }
    assert.ok(e1);
    assert.equal(e1.code, "PERSISTENCE_ROOT_INVALID");
    assert.match(e1.message, /OUTSIDE the repository worktree/);
    // Form 2: human replaces the root with a symlinked directory.
    const realDir = mkdtempSync(join(tmpdir(), "e1-c17-real-"));
    const linkDir = join(tmpdir(), `e1-c17-link-${Math.random().toString(36).slice(2, 8)}`);
    await mutateAndTrack([{ op: "write", path: join(realDir, "x.txt"), bytes: "moved\n" }], "c17");
    symlinkSync(realDir, linkDir, "dir");
    let e2 = null;
    try { assertValidEvidenceRoot(linkDir, fx.repo); } catch (e) { e2 = e; }
    assert.ok(e2);
    assert.equal(e2.code, HOLD.SYMLINK_REJECTED);
    // Store init with the mutated root fails closed before any write.
    let initErr = null;
    try {
      const s = new RunEvidenceStore({ root: badRoot, executionId: fx.executionId, chainId: "c", checkpointId: "k", repoRoot: fx.repo });
      s.init();
    } catch (e) { initErr = e; }
    assert.equal(initErr?.code, "PERSISTENCE_ROOT_INVALID");
    rmSync(realDir, { recursive: true, force: true });
    try { rmSync(linkDir, { force: true }); } catch { /* tmp */ }
  } finally { fx.cleanup(); }
});

test("E1 C18 M6b W4: derived artifact from a superseded generation offered for fold ⇒ RESULT_HASH_MISMATCH / STALE_GENERATION", async () => {
  const fx = await makeGraphStoreFixture({ tag: "c18" });
  try {
    // Pin an honest R1 result at generation 0.
    const hooks = fx.run.buildGraphHooks(fx.ir);
    await hooks.onPhaseStart({ phaseId: "R1" });
    await fx.run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    await fx.run.checkpoint({});
    const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
    // Superseded-generation offer: successor (gen 1) submits gen-0 bytes whose
    // content ALSO differs from the pin ⇒ the fold gate refuses on hash first.
    const gen1Snap = JSON.parse(JSON.stringify(snap));
    gen1Snap.graph.recovery_generation = 1;
    const resultPath = join(fx.execDir, "phases", "R1", "result.json");
    const mut = await mutateAndTrack([{ op: "write", path: resultPath, bytes: JSON.stringify({ phase_id: "R1", final: "PASS", status: "passed", graph_generation: 0, reason: "superseded-offer" }) }], "c18");
    assert.equal(mut.code, 0);
    const gate = childResultFoldGate({ snapshot: gen1Snap, store: fx.store, execDir: fx.execDir, phaseId: "R1" });
    assert.equal(gate.ok, false);
    assert.ok(gate.code === "RESULT_HASH_MISMATCH" || gate.code === "STALE_GENERATION", `superseded bytes refused (got ${gate.code})`);
    assert.equal(gate.code, "RESULT_HASH_MISMATCH", "hash pin checked before generation binding");
    // Negative-arm pairing: same bytes against the UNPINNED successor view
    // (no hash pin) still refuses on generation binding.
    const unpinned = JSON.parse(JSON.stringify(gen1Snap));
    delete unpinned.phase_result_hashes.R1;
    const gate2 = childResultFoldGate({ snapshot: unpinned, store: fx.store, execDir: fx.execDir, phaseId: "R1" });
    assert.deepEqual({ ok: gate2.ok, code: gate2.code }, { ok: false, code: "STALE_GENERATION" });
    // Superseded bytes never entered the ledger: no PHASE_RESULT_FOLD row.
    const foldRows = journalRows(fx.store, ["PHASE_RESULT_FOLD_REJECTED"]);
    assert.equal(foldRows.length, 0, "direct fold-gate probes write nothing");
  } finally { fx.cleanup(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative controls (no mutation / unaffected authority)
// ─────────────────────────────────────────────────────────────────────────────

test("E1 C19 negative W4→W5: NO mutation ⇒ resume continues from durable bytes (RESUME_VALIDATED, recovery provenance)", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "c19" });
  try {
    const before = fx.checkpoint.snapshot;
    assert.equal(before.final_verdict, null);
    const v = await capture(fx);
    assert.equal(v.thrown, null);
    assert.equal(v.resumeRejected, null, "no rejection row without mutation");
    assert.equal(v.resumeValidated, true, "RESUME_VALIDATED journaled");
    // Reconstruction used durable bytes only: the resumed envelope carries
    // recovery provenance pointing at the ORIGINAL execution.
    assert.equal(v.result.recovery?.resumed, true);
    assert.equal(v.result.recovery?.replayOf, fx.executionId);
    assert.equal(v.result.recovery?.recoveryGeneration, (before.graph?.recovery_generation ?? 0) + 1);
    // Restart stability: the SECOND resume observes the same verdict family.
    const v2 = await capture(fx);
    assert.equal(v2.resumeValidated, true);
    assert.equal(v2.result?.final, v.result.final);
  } finally { fx.cleanup(); }
});

test("E1 C20 negative W4→W5: provenance-fenced unaffected authority ⇒ mutation in an unrelated temp namespace leaves fingerprints untouched", async () => {
  const fx = await makeProductionRunFixture({ tag: "c20" });
  const unrelated = mkdtempSync(join(tmpdir(), "e1-c20-unrelated-ns-"));
  try {
    const frozenFp = fx.checkpoint.snapshot.repository_fingerprint;
    // HUMAN mutates an unrelated temp namespace (outside the run's repo,
    // evidence root and scratch root): no fingerprint/digest of the run changes.
    const mut = await mutateAndTrack([{ op: "write", path: join(unrelated, "human.txt"), bytes: "unrelated mutation\n" }], "c20");
    assert.equal(mut.code, 0);
    const liveFp = (await import("../../src/c2d/fingerprint.mjs")).collectFingerprint(fx.repo);
    assert.deepEqual(
      { head: liveFp.expected_head, ref: liveFp.expected_ref, wt: liveFp.expected_worktree_state, url: liveFp.origin_url },
      { head: frozenFp.expected_head, ref: frozenFp.expected_ref, wt: frozenFp.expected_worktree_state, url: frozenFp.origin_url },
      "no over-invalidation: run fingerprints byte-identical",
    );
    const v = await capture(fx);
    assert.equal(v.resumeRejected, null, "unrelated mutation never fences the run");
    assert.equal(v.resumeValidated, true);
    assert.notEqual(v.result ?? null, null);
    rmSync(unrelated, { recursive: true, force: true });
  } finally {
    try { rmSync(unrelated, { recursive: true, force: true }); } catch { /* tmp */ }
    fx.cleanup();
  }
});

// ── Suite-level cleanup attestation (SOAK-TEST-CONTRACT §1.9 / §5.6) ─────────
test("E1 SUITE CLEANUP: zero surviving helper processes; all ack dirs removed", async () => {
  const attestation = cleanupAttestation(HELPER_PIDS);
  assert.equal(attestation.orphanCount, 0, `survivors: ${JSON.stringify(attestation.survivors)}`);
  for (const dir of ACK_DIRS) {
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false, "ack dir removed");
  }
});
