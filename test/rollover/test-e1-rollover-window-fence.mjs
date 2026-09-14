// test/rollover/test-e1-rollover-window-fence.mjs
//
// E1 SOAK — C21: checkpoint-chain-only rollover window fence (recovery
// lineage reimplementation; sealed decision 6 of the E1 IMPLEMENTATION-1
// admission, reconstructed for the E1 recovery acceptance surface).
//
// RECOVERY LINEAGE: E1_SOAK_HELPER_RECOVERY_V1
//   Replaces the lost sealed bytes f4a5c4a8… (156 lines) as a behavioral
//   reimplementation from the frozen export surface + consumer evidence.
//   NOT a continuation of, and NOT byte-identical to, the sealed original.
//
// What this file proves (one discriminating oracle per arm, exact codes):
//
//   §1  An ACTIVE pre-commit rollover block inside the checksummed CURRENT
//       freezes the owner-of-record: EVERY dispatch attempt through the
//       between-phase gate is refused with
//       CROSS_SESSION_ROLLOVER_IN_PROGRESS_A_FROZEN — regardless of who
//       calls (§9a durable fence, not memory). The refusal is JOURNALED
//       (ROLLOVER_HANDOVER_FENCE row) and is fence EVIDENCE, never
//       consumption evidence: no lifecycle boundary, no result artifact,
//       no checkpoint revision, no owner takeover (§2).
//
//   §2  The fence is derived from CHECKPOINT CHAIN TRUTH ONLY: tampering
//       with the checksummed CURRENT bytes is refused with
//       SNAPSHOT_CHECKSUM_MISMATCH — a forged rollover block can never
//       authorize anything (fail closed before any dispatch).
//
//   §3  Rollover window composition: the fence applies while a rollover is
//       active AND releases cleanly when the block is absent (legacy
//       same-session semantics unchanged) — the negative control proving
//       the fence is the discriminating factor, not a constant refusal.
//
// Run: node --import ./test/v2/helpers/e1-runtime-isolation-preload.mjs --test test/rollover/test-e1-rollover-window-fence.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeGraphStoreFixture, makeAdmission,
  journalRows, readCheckpoint, readCurrent,
  mkdtempSync, tmpdir, join, writeFileSync, readFileSync, existsSync, rmSync,
} from "../v2/helpers/e1-soak-fixtures.mjs";
import { beginRollover } from "../../src/rollover/rollover-controller.mjs";
import { validateTriggerEvent } from "../../src/rollover/rollover-authority.mjs";

// Rollover-window construction: the §9a window is seeded through the SEALED
// controller ladder (beginRollover with an authorized trigger over an honest
// admission) — the durable rollover mirror lands inside the checksummed
// CURRENT via the sealed checkpoint authority, never a hand-built block.
async function openRolloverWindow(fx) {
  const admission = makeAdmission(`E1-C21-${fx.executionId.slice(-6)}`);
  const sourceIdentity = {
    adapterKind: "pi-builtin", providerKind: "pi-builtin",
    opaqueSessionId: `e1-owner-${fx.executionId.slice(-6)}`, sessionGeneration: 0,
  };
  const triggerEvent = {
    trigger: "OWNER_REQUESTED",
    source: "e1-rollover-fence",
    authorityDecisionRef: `e1-decision-${fx.executionId.slice(-6)}`,
    freshness: new Date().toISOString(),
    taskIdentity: fx.executionId,
    runIdentity: fx.executionId,
    admissionIdentity: admission.admission_id,
    observedFact: null,
  };
  const tv = validateTriggerEvent(triggerEvent);
  if (!tv.ok) throw new Error(`rollover trigger invalid: ${tv.reason}`);
  const began = await beginRollover({
    root: fx.root,
    executionId: fx.executionId,
    store: fx.store,
    triggerEvent,
    targetAdapterKind: "pi-builtin",
    targetProviderKind: "pi-builtin",
    sourceIdentity,
    admission,
    graphIdentity: { ir_sha256: readCheckpoint(fx.root, fx.executionId).snapshot.decomposition_ir_sha256 },
    toolSelectionCommitmentDigest: null,
    budgetStateDigest: null,
    lifecycleStateDigest: null,
    safePoint: null,
  });
  if (!began.ok) throw new Error(`beginRollover failed: ${JSON.stringify(began)}`);
  const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
  if (snap.graph?.rollover?.state !== "CHECKPOINT_PUBLISHED") {
    throw new Error(`rollover window state ${snap.graph?.rollover?.state} != CHECKPOINT_PUBLISHED`);
  }
  return began;
}

test("E1 C21 §1 active rollover window: dispatch fenced, journaled as fence evidence, never consumption", async () => {
  const fx = await makeGraphStoreFixture({ tag: "c21a" });
  try {
    await openRolloverWindow(fx);
    // Window precondition: the durable CURRENT mirror carries an ACTIVE
    // pre-commit rollover block (owner-of-record frozen); the run is not
    // terminal; the checksummed CURRENT verifies; and the freeze point was
    // proven safe (declareSafeFreezePoint ran inside beginRollover — C2D
    // rollover-class continuity held: no incomplete tail).
    const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snap.graph?.rollover?.state, "CHECKPOINT_PUBLISHED", "rollover window active (pre-commit)");
    assert.equal(snap.graph?.rollover?.active_rollover_id != null, true, "active rollover id pinned");
    assert.equal(snap.final_verdict, null, "run not terminal inside the window");
    const cur = readCurrent(fx.execDir);
    assert.ok(cur && cur.snapshot.revision > 0, "checksummed CURRENT readable inside window");
    const frozenOwner = snap.graph.rollover.owner.session_identity_digest;
    const frozenRevision = cur.snapshot.revision;

    // Dispatch attempt INSIDE the window: the between-phase gate reads the
    // checksummed mirror (never caller state) and refuses with the exact
    // A-frozen code — the phase NEVER dispatches.
    let thrown = null;
    try {
      const hooks = fx.run.buildGraphHooks(fx.ir);
      await hooks.onPhaseStart({ phaseId: "R2" });
    } catch (e) { thrown = e; }
    assert.ok(thrown, "dispatch inside an active rollover window is refused");
    assert.equal(thrown.code, "CROSS_SESSION_ROLLOVER_IN_PROGRESS_A_FROZEN",
      `exact A-frozen fence code (got ${thrown.code})`);
    assert.match(thrown.message, /rollover/);

    // Restart stability: a second dispatch attempt re-observes the SAME
    // refusal from the same durable truth (durable fence, not memory — and
    // equally not bypassable by retrying).
    let thrown2 = null;
    try {
      const hooks = fx.run.buildGraphHooks(fx.ir);
      await hooks.onPhaseStart({ phaseId: "R2" });
    } catch (e) { thrown2 = e; }
    assert.equal(thrown2?.code, "CROSS_SESSION_ROLLOVER_IN_PROGRESS_A_FROZEN",
      "fence refusal is stable across attempts (durable truth)");

    // §2 — the refusal is DURABLE fence evidence: journaled exactly once per
    // attempt, naming the refused phase and the exact code.
    const fenceRows = journalRows(fx.store, ["ROLLOVER_HANDOVER_FENCE"]);
    assert.equal(fenceRows.length, 2, "one fence row per refused attempt");
    assert.equal(fenceRows[0].phase_id, "R2", "fence row names the refused phase");
    assert.equal(fenceRows[0].payload?.code, "CROSS_SESSION_ROLLOVER_IN_PROGRESS_A_FROZEN",
      "fence row carries the exact code");
    // The refused phase NEVER executed: no lifecycle boundary for it, and no
    // result artifact — a refused dispatch is not consumption evidence.
    const startedRows = journalRows(fx.store, ["PHASE_READY", "PHASE_STARTED"])
      .filter((r) => r.phase_id === "R2");
    assert.equal(startedRows.length, 0, "refused phase never reached a lifecycle boundary");
    assert.equal(existsSync(join(fx.execDir, "phases", "R2", "result.json")), false,
      "refused phase left no result artifact (never folded as work)");

    // No takeover, no chain churn: the frozen owner-of-record and the
    // checkpoint revision are byte-unchanged by the fenced attempts.
    const after = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(after.graph.rollover.owner.session_identity_digest, frozenOwner,
      "owner-of-record unchanged across the fenced window");
    assert.equal(after.graph.rollover.state, snap.graph.rollover.state,
      "rollover state not advanced by the refused dispatch");
    assert.equal(after.revision, frozenRevision, "fence evidence adds no checkpoint revision");
  } finally { fx.cleanup(); }
});

test("E1 C21 §2 forged rollover block in CURRENT bytes fails closed (checksum authority)", async () => {
  const fx = await makeGraphStoreFixture({ tag: "c21b" });
  try {
    await openRolloverWindow(fx);
    // A human forges the CURRENT.json bytes directly (swaps the rollover
    // block to a post-commit state to self-authorize the dispatch) WITHOUT
    // the matching sidecar checksum. The checkpoint-chain authority refuses:
    // unprovable bytes authorize nothing — not even the fence's own refusal
    // path may read them as truth.
    const currentPath = join(fx.execDir, "CURRENT.json");
    const good = readFileSync(currentPath, "utf8");
    const forged = JSON.parse(good);
    forged.graph.rollover.state = "OWNERSHIP_TRANSFER_COMMITTED";
    forged.graph.rollover.owner = {
      session_identity_digest: "f".repeat(64), session_generation: 99,
    };
    writeFileSync(currentPath, JSON.stringify(forged));

    // Direct durable oracle: the tampered bytes are rejected on read.
    let read = null;
    try { readCurrent(fx.execDir); } catch (e) { read = e; }
    assert.ok(read, "forged CURRENT rejected");
    assert.equal(read.code, "HOLD / SNAPSHOT_CHECKSUM_MISMATCH",
      "exact checksum-authority code");
    assert.match(read.message, /CURRENT checksum mismatch/);

    // The gate inherits the same fail-closed verdict: no dispatch, no
    // forgiveness of the unprovable bytes.
    let thrown = null;
    try {
      const hooks = fx.run.buildGraphHooks(fx.ir);
      await hooks.onPhaseStart({ phaseId: "R2" });
    } catch (e) { thrown = e; }
    assert.ok(thrown, "dispatch against forged bytes refused");
    assert.match(String(thrown.message ?? ""), /CHECKPOINT_MISMATCH|CURRENT checksum mismatch|SNAPSHOT_CHECKSUM/,
      `fence refuses unprovable checkpoint truth (got: ${thrown.message ?? thrown.code})`);

    // Restart stability: the forged bytes re-observe identically.
    let read2 = null;
    try { readCurrent(fx.execDir); } catch (e) { read2 = e; }
    assert.equal(read2?.code, "HOLD / SNAPSHOT_CHECKSUM_MISMATCH");
  } finally { fx.cleanup(); }
});

test("E1 C21 §3 negative control: no rollover block ⇒ same dispatch proceeds (fence is the discriminator)", async () => {
  const fx = await makeGraphStoreFixture({ tag: "c21c" });
  try {
    // Same runner, same phase seam, NO rollover block anywhere in the chain:
    // the between-phase gate must NOT refuse (legacy same-session semantics).
    const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(snap.graph?.rollover ?? null, null, "no rollover block (negative control)");

    let refused = null;
    try {
      const hooks = fx.run.buildGraphHooks(fx.ir);
      await hooks.onPhaseStart({ phaseId: "R1" });
    } catch (e) { refused = e; }
    assert.equal(refused ?? null, null, "absent rollover block never fences a dispatch");
    // The phase actually crossed the gate: its lifecycle boundary is real.
    const started = journalRows(fx.store, ["PHASE_READY"]).filter((r) => r.phase_id === "R1");
    assert.equal(started.length, 1, "dispatch proceeded through the unfenced gate");
  } finally { fx.cleanup(); }
});
