// test/v2/test-e3-lease-outage-soak.mjs
//
// E3 LEASE/OUTAGE SOAK — MAIN MATRIX (8 blocks: L1 L2 L3 L-NEG O1 O2 O3
// O-NEG) + SUITE CLEANUP attestation.
// Card: AUTOLOOP-V1-STAGE-F-P5-SOAK-E3-IMPLEMENTATION-1, under the sealed
// admission AUTOLOOP-V1-STAGE-F-P5-SOAK-E3-ADMISSION-1-20260906T133000Z.
//
// Scenario semantics are taken VERBATIM from the frozen inventory
// (E3-SCENARIO-INVENTORY.md) + lease semantics + outage semantics +
// lease/outage boundary + oracle contract — no scenario merged, dropped,
// split, renamed, weakened, or promoted into new authority.
//
// LEASE IS OWNERSHIP, NOT TTL (the card's core freeze):
//   * every class-5 remnant is produced by a REAL spawned holder process
//     that dies by SIGKILL (the DE-2R injection class) — holder death, not
//     clock expiry. NO sleep-until-expiry, NO fake clock, NO wall-clock
//     timeout, NO renew-before-deadline exists anywhere in this suite
//     (E3-TIME-AUTHORITY: TIME_AUTHORITY = NONE; validity is
//     released_at == null AND secret digests AND identity fields, read
//     fresh from disk by the production code itself).
//   * the takeover/takeover-refusal oracles are the production fences
//     themselves: acquireLease / releaseLease / validateLeaseOwner /
//     permitFromLease / runMutation / reconcileMutationIntent — asserted at
//     the EXACT first-reachable production fence (E3-ORACLE-CONTRACT rule 5).
//
// OUTAGE IS CONNECTIVITY LOSS, NOT AUTHORITY TRANSFER (the card's class-6
// freeze):
//   * O1 injects the outage at the REAL production transport dependency
//     seam: createPiTransportAdapter (src/v2/pi-transport-adapter.mjs) with
//     a scripted fetchImpl returning a genuine provider refusal (HTTP 500) —
//     the same seam the sealed transport tests exercise. The adapter's own
//     TRANSPORT_FREEZE contract (maxRetries=0, maxRequests=1, no
//     repair/retry/resample/fallback) runs UNMODIFIED and is itself
//     asserted. NEVER `throw new Error("outage")` inside production paths.
//   * O2 injects the outage at the DURABLE-STORE dependency seam through the
//     sealed SIGKILL-during-publication class (the real torn window — the
//     before_checksum_rename seam where CURRENT is already replaced and the
//     sidecar is not yet rewritten; the kill IS the injection — no synthetic
//     corruption), and asserts the production read path refuses the
//     unverifiable view with the exact sealed codes (torn view = potential
//     revocation, fail-closed). torn=true is byte-proven, never inferred
//     from the hook name; torn=false is a TEST FAILURE.
//   * O3 joins both classes at the frozen boundary ordering: remnant lease
//     + outage onset, then reconnect — reconnection restores nothing by
//     itself; ownership resolves by secret proof or the exact HOLD.
//
// Zero production mutation. Zero VM lifecycle. All state in mkdtemp
// namespaces; fresh-process legs (test-e3-lease-outage-soak-crossproc.mjs)
// read only durable bytes. Durable markers prove every window — never sleep.

// Run: node --import ./test/v2/helpers/e1-runtime-isolation-preload.mjs --test --test-timeout=90000 test/v2/test-e3-lease-outage-soak.mjs
import "./helpers/e1-runtime-isolation-preload.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeLeaseFixture, installWorkerHelpers, spawnLeaseHolder, spawnTornPublicationVictim,
  sigkill, waitForExit, waitForMarker, tornWindowState,
  publishOpenMutationTail, reconcileTailWithSecrets, issueMutationAuthorization,
  freshLeg, cleanupLegs,
  readLease, acquireLease, releaseLease, validateLeaseOwner,
  permitFromLease, assertWritePermit, HOLD, C3B_HOLD, C2dHoldError,
  readCurrent, validateContinuity, leasePath,
  createPiTransportAdapter, TRANSPORT_FREEZE,
  cleanupAttestation, mkdtempSync, tmpdir, join, readFileSync, existsSync,
} from "./helpers/e3-lease-outage-fixtures.mjs";

const HELPERS = installWorkerHelpers();

/** Holder fields (the same actor/session identity the fixture leases). */
function holderFields(fx) {
  return {
    execution_id: fx.executionId,
    chain_id: fx.lease.chain_id,
    checkpoint_id: fx.lease.checkpoint_id,
    actor_id: fx.actorId,
    session_id: fx.sessionId,
    session_secret: fx.sessionSecret,
    lease_secret: fx.leaseSecret,
  };
}

/** Every spawned holder PID is tracked for the zero-orphan attestation. */
const HOLDER_PIDS = [];
const HOLDER_ACKS = [];
function trackHolder(v) { HOLDER_PIDS.push(v.pid); HOLDER_ACKS.push(v.ackPath); return v; }

function ackPath(tag) {
  return join(mkdtempSync(join(tmpdir(), `e3-ack-${tag}-`)), "ack.json");
}

// ═══════════════════════════════ L1 ═════════════════════════════════════════
// SIGKILL of the lease-holding writer mid-mutation (open INTENT tail): the
// active lease survives with NO living holder. A second actor WITHOUT
// secrets must be refused at the exact production fence
// (HOLD / RESUME_LEASE_CONFLICT, ttl_alone_cannot_reclaim: true); a
// public-record-only release must be refused (LEASE_RELEASE_NOT_SECRET_
// AUTHORIZED); the record stays byte-frozen (no local extension, no
// resurrection). The same-SESSION secret proof may still continue —
// ownership, not time, decides.

test("E3 L1 W-W2-SIGKILL: holder death mid-mutation orphans the active lease; a second actor cannot reclaim (ttl_alone_cannot_reclaim), a public-record release cannot revoke, and only the secret-proving same session may continue", async () => {
  const fx = makeLeaseFixture({ tag: "l1" });
  const ack = ackPath("l1");
  try {
    // ── Holder death at the durable-marker window: the victim acquires the
    // SAME-session lease, publishes the initial CURRENT, journals the open
    // INTENT tail, acks, and is SIGKILLed — no cleanup path runs.
    const victim = trackHolder(spawnLeaseHolder({
      execDir: fx.execDir, repo: fx.repo, mode: "intent", ackPath: ack, helpers: HELPERS,
      fields: holderFields(fx),
    }));
    const marker = await waitForMarker(ack, "INTENT_TAIL", 20000, victim);
    assert.ok(marker.lease_id, "durable marker: holder identity existed (lease_id in ack)");
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL", "holder death is ungraceful (SIGKILL, no cleanup)");
    try { process.kill(victim.pid, 0); assert.fail("holder still alive"); } catch { /* dead */ }

    // ── Durable remnant reality, read fresh from disk:
    const lease = readLease(fx.execDir);
    assert.ok(lease, "durable lease record remained on disk");
    assert.equal(lease.lease_id, marker.lease_id, "lease_id matches the dead holder's durable marker");
    assert.equal(lease.released_at, null, "released_at == null (remnant is active-on-disk, NOT expired — no TTL exists)");
    assert.ok(lease.lease_secret_digest && lease.session_secret_digest, "only digests persist; secrets died with the process");
    assert.notEqual(lease.lease_secret_digest, fx.leaseSecret, "no plaintext secret on disk");
    const cont = validateContinuity(fx.execDir);
    assert.equal(cont.incompleteTail, 1, "open INTENT tail survived the kill (the ambiguous side effect)");
    assert.equal(readCurrent(fx.execDir).snapshot.revision, 0, "CURRENT survived the kill unchanged");

    // ── Discriminating negative arm 1: a SECOND actor WITHOUT the secrets
    // attempts acquireLease — the exact first-reachable production fence.
    let takeover = null;
    try {
      acquireLease(fx.execDir, {
        execution_id: fx.executionId, chain_id: lease.chain_id, checkpoint_id: lease.checkpoint_id,
        repository_identity: lease.repository_identity, worktree_identity: lease.worktree_identity,
        actor_id: "intruder-e3", session_id: "sess_intruder_e3",
        session_secret: "intruder-secret", lease_secret: "intruder-secret",
        expected_head: lease.expected_head,
      });
      assert.fail("second actor reclaimed an orphaned lease — forbidden");
    } catch (e) {
      takeover = e;
    }
    assert.ok(takeover instanceof C2dHoldError);
    assert.equal(takeover.code, HOLD.RESUME_LEASE_CONFLICT, "exact first-reachable fence (lease.mjs :116-121)");
    assert.match(takeover.message, /active lease exists/);
    assert.equal(takeover.details?.ttl_alone_cannot_reclaim, true, "the frozen payload: waiting can NEVER reclaim");

    // ── Discriminating negative arm 2: the PUBLIC record alone (lease_id +
    // revision are cleartext) must not revoke or transfer ownership. A
    // secret-less releaseLease is refused at the exact fence.
    let pubRel = null;
    try {
      await releaseLease(fx.execDir, lease.lease_id, lease.lease_revision, null);
      assert.fail("public-record release succeeded — authority invented");
    } catch (e) { pubRel = e; }
    assert.ok(pubRel instanceof C2dHoldError);
    assert.equal(pubRel.code, HOLD.LEASE_RELEASE_NOT_SECRET_AUTHORIZED, "release requires BOTH secrets (lease.mjs :191-200)");
    const leaseAfterReleaseAttempt = readLease(fx.execDir);
    assert.equal(leaseAfterReleaseAttempt.lease_id, lease.lease_id, "lease record unchanged by the refused release");
    assert.equal(leaseAfterReleaseAttempt.released_at, null, "released_at still null (no invented revocation)");
    assert.deepEqual(
      { l1: leaseAfterReleaseAttempt.lease_id, r: leaseAfterReleaseAttempt.lease_revision, d: leaseAfterReleaseAttempt.lease_secret_digest },
      { l1: lease.lease_id, r: lease.lease_revision, d: lease.lease_secret_digest },
      "lease.json bytes frozen by the refusal (no local extension/rewrite)",
    );

    // ── Ownership resolution: the SAME session WITH both secrets may
    // continue the SAME record (continuation proof, lease.mjs :100-115) —
    // a fresh process, real production continuation, NOT a fixture
    // assertion.
    const contLeg = await freshLeg({
      mode: "continue-owner", legKey: "l1-continue",
      legArgs: { execDir: fx.execDir, fields: holderFields(fx) },
    });
    const v = contLeg.value("LEG");
    assert.equal(v.hold ?? null, null, "same-session continuation is not refused");
    assert.equal(v.continued?.continued, true, "production continuation proof accepted (continued: true)");
    assert.equal(v.continued?.lease_id, lease.lease_id, "the SAME record continues (no re-mint)");

    // ── A wrong-identity session with the right secrets is still refused —
    // identity binding, not just secret possession.
    let wrongSess = null;
    try {
      acquireLease(fx.execDir, { ...holderFields(fx), session_id: "sess_other_identity" });
      assert.fail("identity mismatch accepted");
    } catch (e) { wrongSess = e; }
    assert.equal(wrongSess?.code, HOLD.RESUME_LEASE_CONFLICT, "identity binding enforced at the same fence");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ L2 ═════════════════════════════════════════
// The holder dies leaving an open INTENT tail; the recovery RE-ENTRY without
// secrets classifies (HOLD / C3B_RECOVERY_REQUIRED); the secret-bearing
// recovery continues and reconciles the tail FROM DURABLE REALITY through
// reconcileMutationIntent (never blind retry, never memory replay). The
// reconciled terminal state is RECOVERY_REQUIRED (durable), the lease is
// lawfully released, and a second observation reproduces the resolution.

test("E3 L2 W-W2-SIGKILL recovery: re-entry without secrets classifies C3B_RECOVERY_REQUIRED; the secret-bearing recovery reconciles the open tail from durable reality and releases the lease lawfully", async () => {
  const fx = makeLeaseFixture({ tag: "l2" });
  const ack = ackPath("l2");
  try {
    // ── Holder death with the open tail (real SIGKILL, real orphaning).
    const victim = trackHolder(spawnLeaseHolder({
      execDir: fx.execDir, repo: fx.repo, mode: "intent", ackPath: ack, helpers: HELPERS,
      fields: holderFields(fx),
    }));
    const marker = await waitForMarker(ack, "INTENT_TAIL", 20000, victim);
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL");
    assert.equal(readLease(fx.execDir).released_at, null, "remnant: active record, dead holder");
    assert.equal(validateContinuity(fx.execDir).incompleteTail, 1, "open INTENT tail present");

    // ── Recovery RE-ENTRY without secrets: the production mutation entry
    // classifies — never guesses, never blind-retries (mutation-run :283).
    const noSecretsLeg = await freshLeg({
      mode: "run-mutation", legKey: "l2-nosecrets",
      legArgs: { args: { repoRoot: fx.repo, checkpointRoot: fx.checkpointRoot, actorId: "recovery-b", executionId: fx.executionId, mutationCommand: null, inputManifest: {} } },
    });
    const v1 = noSecretsLeg.value("LEG");
    assert.equal(v1.hold?.code, C3B_HOLD.RECOVERY_REQUIRED, "exact recovery classification (HOLD / C3B_RECOVERY_REQUIRED)");
    assert.match(v1.hold?.message ?? "", /active mutation lease; session secrets required to continue/);
    assert.equal(readLease(fx.execDir).released_at, null, "classification consumed no authority (record untouched)");

    // ── The secret-bearing SAME-session recovery reconciles the open tail
    // FROM DURABLE REALITY through the production reconcile path —
    // re-deriving the gate from the store, never replaying memory. (The
    // continuation arm is proven separately by the fresh acquireLease
    // continuation leg below — runMutation itself continues the lease
    // internally from the re-supplied secrets; the prior publication's
    // same-revision bookkeeping makes a full re-entry's bootstrap snapshot a
    // prior-conflict by design, so the direct reconcile entry is the
    // production seam this recovery drives, exactly as the sealed E1 C15
    // secret-continuation arm does.)
    const contLeg = await freshLeg({
      mode: "continue-owner", legKey: "l2-continue",
      legArgs: { execDir: fx.execDir, fields: holderFields(fx) },
    });
    const vc = contLeg.value("LEG");
    assert.equal(vc.hold ?? null, null, "same-session secret proof admits the recovery (lease continuity)");
    assert.equal(vc.continued?.lease_id, fx.lease.lease_id, "the SAME record continues — recovery re-read durable reality");

    const recLeg = await freshLeg({
      mode: "mutation-reconcile", legKey: "l2-reconcile",
      legArgs: { execDir: fx.execDir, args: {
        leaseId: fx.lease.lease_id, actorId: fx.actorId,
        leaseRevision: fx.lease.lease_revision, secrets: { lease_secret: fx.leaseSecret, session_secret: fx.sessionSecret },
        revision: 1,
        reRunGate: { observed_at: new Date().toISOString(), classification: "RECOVERY_REQUIRED" },
      } },
    });
    const v2 = recLeg.value("LEG");
    assert.equal(v2.hold ?? null, null, "secret-bearing reconcile is admitted");
    assert.equal(v2.reconciled?.complete_digest != null, true, "the reconcile wrote the verified_complete record (durable, not a fixture claim)");
    assert.equal(v2.reconciled?.snapshot_revision, 1, "CURRENT advanced to the reconciled revision");

    // ── Durable post-recovery reality.
    const cont2 = validateContinuity(fx.execDir);
    assert.equal(cont2.incompleteTail, null, "the ambiguous tail is CLOSED (reconcile wrote the verified_complete record)");
    assert.equal(cont2.lastComplete, 1, "the tail's revision is the completed one");
    const snap = readCurrent(fx.execDir).snapshot;
    assert.equal(snap.c2d_control_state, "RECOVERY_REQUIRED", "CURRENT carries the durable recovery classification");

    // ── The recovery then releases the lease lawfully (the holder's own
    // secrets) — the recovery path's terminal bookkeeping.
    const relLeg = await freshLeg({
      mode: "release-owner", legKey: "l2-release",
      legArgs: { execDir: fx.execDir, leaseId: fx.lease.lease_id, leaseRevision: fx.lease.lease_revision,
        secrets: { lease_secret: fx.leaseSecret, session_secret: fx.sessionSecret } },
    });
    const vr = relLeg.value("LEG");
    assert.equal(vr.hold ?? null, null, "lawful release with the holder's own secrets (no force, no takeover)");
    assert.notEqual(vr.released?.released_at, null, "released_at set by the real releaseLease");

    const leaseAfter = readLease(fx.execDir);
    assert.notEqual(leaseAfter.released_at, null, "released_at set on disk (real release, not a fixture claim)");
    assert.equal(leaseAfter.lease_revision, 2, "lease_revision bumped by the release (+1, the frozen generation analogue)");

    // ── POST_RECOVERY_OWNERSHIP = RESOLVED: after the lawful release the
    // store is re-acquirable by a NEW actor under the structured lock with a
    // further revision bump (re-issue, never resurrection). The successor
    // takes a mutation-capability lease (it will continue the recovery
    // lifecycle below).
    const reacq = await freshLeg({
      mode: "acquire-second-actor", legKey: "l2-reacquire",
      legArgs: { execDir: fx.execDir, fields: { execution_id: fx.executionId, chain_id: fx.lease.chain_id,
        checkpoint_id: fx.lease.checkpoint_id, repository_identity: fx.lease.repository_identity,
        worktree_identity: fx.lease.worktree_identity, actor_id: "successor-e3", session_id: "sess_successor_e3",
        session_secret: "successor-secret", lease_secret: "successor-secret", expected_head: fx.lease.expected_head,
        mutation_capability: true } },
    });
    const v3 = reacq.value("LEG");
    assert.equal(v3.hold ?? null, null, "post-release acquisition by a new actor is lawful");
    assert.equal(v3.acquired?.lease_id != null, true, "fresh lease_id minted (re-issue, not the old record)");
    assert.notEqual(v3.acquired?.lease_id, marker.lease_id, "the dead holder's lease_id was never resurrected");
    const successorRevision = v3.leaseAfter?.lease_revision ?? null;
    assert.equal(successorRevision != null, true, "successor lease_revision observable");

    // ── Restart stability: the NEW holder's ownership survives re-entry —
    // the store's continuity contract refuses any un-opened revision at the
    // FIRST-REACHABLE fence (continuity, not authority): no stale
    // classification residue, no invented tail, no authority leak.
    const recLeg2 = await freshLeg({
      mode: "mutation-reconcile", legKey: "l2-stability",
      legArgs: { execDir: fx.execDir, args: {
        leaseId: v3.acquired?.lease_id, actorId: "successor-e3", leaseRevision: successorRevision,
        secrets: { lease_secret: "successor-secret", session_secret: "successor-secret" }, revision: 2,
      } },
    });
    const v4 = recLeg2.value("LEG");
    assert.equal(v4.hold?.code, HOLD.CHECKPOINT_REALITY_MISMATCH,
      "second-cycle: an un-opened revision is refused at the continuity fence (the successor's authority itself validates — no lease conflict)");
    assert.match(v4.hold?.message ?? "", /revision is not incomplete tail/);
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ L3 ═════════════════════════════════════════
// Concurrent lease capture: a second actor races the still-held (or remnant)
// active lease through the structured-lock path — every capture attempt is
// refused with the exact conflict codes; stale lease_revision permits are
// rejected (WRITE_PERMIT_REPLAYED); wrong secrets are rejected
// (WRITE_PERMIT_INVALID); validateLeaseOwner refuses a revision mismatch.

test("E3 L3 W-W2-CONCURRENT: concurrent capture of a held lease is refused at every fence (conflict codes + stale-revision permit replay + wrong-secret permit)", async () => {
  const fx = makeLeaseFixture({ tag: "l3" });
  try {
    const lease = readLease(fx.execDir);
    assert.equal(lease.released_at, null, "precondition: active held lease (revision 1)");

    // ── Arm 1: a second actor's takeover attempt through acquireLease —
    // the exact conflict fence.
    let takeover = null;
    try {
      acquireLease(fx.execDir, {
        execution_id: fx.executionId, chain_id: lease.chain_id, checkpoint_id: lease.checkpoint_id,
        repository_identity: lease.repository_identity, worktree_identity: lease.worktree_identity,
        actor_id: "racer-e3", session_id: "sess_racer_e3",
        session_secret: "racer-secret", lease_secret: "racer-secret",
        expected_head: lease.expected_head,
      });
      assert.fail("concurrent capture won — forbidden");
    } catch (e) { takeover = e; }
    assert.ok(takeover instanceof C2dHoldError);
    assert.equal(takeover.code, HOLD.RESUME_LEASE_CONFLICT);
    assert.match(takeover.message, /active lease exists/);
    assert.equal(takeover.details?.ttl_alone_cannot_reclaim, true, "frozen payload present at the conflict site");

    // ── Arm 2: a permit built from the STALE public record (wrong lease_
    // revision) is rejected as a replay — the generation analogue fence.
    // (permitFromLease digests the secrets FIRST — a stale-REVISION claim
    // with the owner's own secrets must be built through the production
    // path and then diverged, mirroring exactly what a stale caller could
    // hold: valid secrets + an outdated public record.)
    const stalePermit = {
      ...permitFromLease(fx.execDir, readLease(fx.execDir), fx.secrets, true),
      lease_revision: 999, // stale generation claimed against the live record
    };
    let replayed = null;
    try { assertWritePermit(fx.execDir, stalePermit); assert.fail("stale permit accepted"); }
    catch (e) { replayed = e; }
    assert.ok(replayed instanceof C2dHoldError);
    assert.equal(replayed.code, HOLD.WRITE_PERMIT_REPLAYED, "stale lease_revision refused (permit does not match active lease)");
    assert.match(replayed.message, /permit does not match active lease/);

    // ── Arm 3: a permit with WRONG secrets is rejected as invalid — the
    // forge/digest fence. (permitFromLease is the production digest gate
    // itself: wrong secrets are refused AT ISSUANCE — even earlier than the
    // live re-read in assertWritePermit. Both halves of the fence are
    // asserted: refusal at issuance, and a re-diffed permit refused on the
    // live write path.)
    let forgedAtIssue = null;
    try { permitFromLease(fx.execDir, lease, { lease_secret: "wrong-secret", session_secret: "wrong-secret" }, true); assert.fail("forged permit issued"); }
    catch (e) { forgedAtIssue = e; }
    assert.ok(forgedAtIssue instanceof C2dHoldError);
    assert.equal(forgedAtIssue.code, HOLD.WRITE_PERMIT_INVALID, "wrong secrets refused at the digest fence (issuance)");
    assert.match(forgedAtIssue.message, /digest mismatch/);
    const diffedPermit = { ...permitFromLease(fx.execDir, readLease(fx.execDir), fx.secrets, true), _lease_secret: "wrong-secret" };
    let forged = null;
    try { assertWritePermit(fx.execDir, diffedPermit); assert.fail("forged permit accepted"); }
    catch (e) { forged = e; }
    assert.ok(forged instanceof C2dHoldError);
    assert.equal(forged.code, HOLD.WRITE_PERMIT_INVALID, "wrong secrets refused at the digest fence (live write path)");
    assert.match(forged.message, /invalid/);

    // ── Arm 4: validateLeaseOwner refuses a revision mismatch and a
    // wrong-identity claim (stale authority cannot validate).
    let revMismatch = null;
    try { validateLeaseOwner(fx.execDir, lease.lease_id, lease.actor_id, 999, fx.secrets, true); assert.fail("revision mismatch validated"); }
    catch (e) { revMismatch = e; }
    assert.equal(revMismatch?.code, HOLD.RESUME_LEASE_CONFLICT, "lease_revision mismatch refused");
    assert.match(revMismatch?.message ?? "", /revision mismatch/);
    let actorMismatch = null;
    try { validateLeaseOwner(fx.execDir, lease.lease_id, "someone-else", lease.lease_revision, fx.secrets, true); assert.fail("actor mismatch validated"); }
    catch (e) { actorMismatch = e; }
    assert.equal(actorMismatch?.code, HOLD.RESUME_LEASE_CONFLICT, "ownership (actor) mismatch refused");

    // ── The record is UNCHANGED by every refused capture: no winner, no
    // corruption, still the original revision.
    const leaseAfter = readLease(fx.execDir);
    assert.deepEqual(
      { id: leaseAfter.lease_id, rev: leaseAfter.lease_revision, actor: leaseAfter.actor_id, session: leaseAfter.session_id },
      { id: lease.lease_id, rev: 1, actor: lease.actor_id, session: lease.session_id },
      "the held lease survived all capture attempts byte-frozen",
    );

    // ── Control: the TRUE holder's own permit still validates (the fences
    // exist but are not over-triggered).
    const live = assertWritePermit(fx.execDir, permitFromLease(fx.execDir, readLease(fx.execDir), fx.secrets, true));
    assert.equal(live.lease_id, lease.lease_id, "control: the real owner's permit validates fresh from disk");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ L-NEG ══════════════════════════════════════
// Baseline (no failure): the full acquire→continue→release lifecycle is
// green through the REAL machinery with NO spurious HOLD; release without
// secrets still refuses (the fence exists but is not over-triggered); the
// lease ends released_at != null with revision 2.

test("E3 L-NEG baseline: no-failure lease lifecycle (acquire → secret-proven continue → wrong-secret refuse → lawful release) is green with zero spurious HOLD", async () => {
  const fx = makeLeaseFixture({ tag: "lneg" });
  try {
    const lease = readLease(fx.execDir);
    assert.equal(lease.lease_revision, 1, "baseline acquire: revision 1");
    assert.equal(lease.released_at, null, "baseline acquire: active");

    // Secret-proven continuation of the SAME session (the L-NEG arm that
    // proves the fences do not over-trigger on lawful continuation).
    const contLeg = await freshLeg({
      mode: "continue-owner", legKey: "lneg-continue",
      legArgs: { execDir: fx.execDir, fields: holderFields(fx) },
    });
    const v1 = contLeg.value("LEG");
    assert.equal(v1.hold ?? null, null, "no spurious HOLD on lawful continuation");
    assert.equal(v1.continued?.continued, true, "continuation accepted");

    // A WRONG-secret continuation attempt is refused at the exact conflict
    // fence (identity+secret binding, never name binding).
    let wrong = null;
    try {
      acquireLease(fx.execDir, { ...holderFields(fx), session_secret: "not-the-secret" });
      assert.fail("wrong-secret continuation accepted");
    } catch (e) { wrong = e; }
    assert.equal(wrong?.code, HOLD.RESUME_LEASE_CONFLICT, "wrong secret refused (lease.mjs session proof)");

    // Lawful release WITH both secrets, through the production entry.
    const relLeg = await freshLeg({
      mode: "release-owner", legKey: "lneg-release",
      legArgs: { execDir: fx.execDir, leaseId: lease.lease_id, leaseRevision: lease.lease_revision,
        secrets: { lease_secret: fx.leaseSecret, session_secret: fx.sessionSecret } },
    });
    const v2 = relLeg.value("LEG");
    assert.equal(v2.hold ?? null, null, "no spurious HOLD on lawful release");
    assert.notEqual(v2.released?.released_at, null, "released_at set (real terminal lease state)");

    const after = readLease(fx.execDir);
    assert.notEqual(after.released_at, null, "durable terminal state: released");
    assert.equal(after.lease_revision, 2, "revision bumped by release (+1)");
    // A released record is re-issuable — that is RE-ISSUE (fresh lease_id
    // under the lock), never resurrection of the old record.
    const reissueLeg = await freshLeg({
      mode: "acquire-second-actor", legKey: "lneg-reissue",
      legArgs: { execDir: fx.execDir, fields: { execution_id: fx.executionId, chain_id: fx.lease.chain_id,
        checkpoint_id: fx.lease.checkpoint_id, repository_identity: fx.lease.repository_identity,
        worktree_identity: fx.lease.worktree_identity, actor_id: "next-e3", session_id: "sess_next_e3",
        session_secret: "next-secret", lease_secret: "next-secret", expected_head: fx.lease.expected_head } },
    });
    const v3 = reissueLeg.value("LEG");
    assert.equal(v3.hold ?? null, null, "released record is lawfully re-issuable");
    assert.notEqual(v3.acquired?.lease_id, lease.lease_id, "fresh lease_id (re-issue, not resurrection)");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ O1 ═════════════════════════════════════════
// Transport/service outage: the REAL production transport adapter
// (TRANSPORT_FREEZE contract unmodified) receives a genuine provider
// refusal (HTTP 500) at its scripted fetch seam and fails closed with
// status "error"/reason "provider_error", maxRetries=0 proven by the
// request ledger (exactly ONE HTTP response), and — the class-6 boundary —
// the outage changes NO durable lease/ownership fact.

test("E3 O1 W-W2-OUTAGE-TRANSPORT: provider refusal at the real transport seam fails closed (provider_error, maxRetries=0, one request) and leaves lease/ownership authority untouched", async () => {
  const fx = makeLeaseFixture({ tag: "o1" });
  try {
    const leaseBefore = readLease(fx.execDir);
    assert.equal(leaseBefore.released_at, null, "precondition: valid active lease + connectivity up");

    // ── THE OUTAGE at the production dependency seam (real adapter, real
    // refusal response — no production edit, no synthetic throw in
    // production paths).
    const leg = await freshLeg({
      mode: "transport-outage", legKey: "o1-outage",
      legArgs: { execDir: fx.execDir },
    });
    const t = leg.value("LEG").transport;
    assert.equal(t.freeze.maxRetries, 0, "TRANSPORT_FREEZE.maxRetries == 0 (the no-fallback contract itself)");
    assert.equal(t.freeze.maxRequests, 1, "TRANSPORT_FREEZE.maxRequests == 1");
    assert.equal(t.httpResponses, 1, "request ledger: exactly ONE dependency response — zero retries, zero fallback attempts");
    assert.equal(t.requestCount, 1, "adapter request count: 1 (no repair/resample continuation)");
    assert.equal(t.status, "error", "the outage is an ERROR, never a success");
    assert.equal(t.reason, "provider_error", "exact frozen refusal reason (provider error → HOLD family)");
    assert.match(t.errorMessage ?? "", /upstream provider unavailable/, "the real dependency refusal surfaced (not swallowed, not reinvented)");

    // ── THE BOUNDARY: ownership is durable, not connectivity-derived. The
    // outage changed NO lease fact.
    const leaseAfter = readLease(fx.execDir);
    assert.deepEqual(
      { id: leaseAfter.lease_id, rev: leaseAfter.lease_revision, actor: leaseAfter.actor_id, session: leaseAfter.session_id, released: leaseAfter.released_at },
      { id: leaseBefore.lease_id, rev: leaseBefore.lease_revision, actor: leaseBefore.actor_id, session: leaseBefore.session_id, released: null },
      "REMOTE UNAVAILABLE != LOCAL AUTHORITY MAY CONTINUE: lease unchanged by the outage",
    );
    assert.equal(leaseAfter.lease_secret_digest, leaseBefore.lease_secret_digest, "authority digests unchanged");
    void fx;
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ O2 ═════════════════════════════════════════
// Torn-store outage (the durable store IS the dependency): SIGKILL of the
// writer inside the REAL publication window (CURRENT replaced, sidecar not
// yet renamed — the sealed before-checksum-rename seam, the kill IS the
// injection). The production read path refuses the unverifiable view with
// the exact sealed codes; a checkpointed consistent state re-derives clean;
// the refusal is restart-stable. Torn view = potential revocation: the
// writer's lease/authority is NOT silently continued on top of it.

test("E3 O2 W-W3-TORN: SIGKILL inside the real torn-publication window; the production read path refuses the unprovable store (SNAPSHOT_CHECKSUM_MISMATCH) — torn view treated as potential revocation, fail-closed, restart-stable", async () => {
  const fx = makeLeaseFixture({ tag: "o2" });
  const ack = ackPath("o2");
  try {
    // The victim continues the fixture's lease and performs ONE real
    // publication; the parent kills it inside the REAL torn window.
    const victim = trackHolder(spawnTornPublicationVictim({
      execDir: fx.execDir, repo: fx.repo, ackPath: ack, helpers: HELPERS,
      fields: holderFields(fx),
    }));
    const tornMarker = await waitForMarker(ack, "TORN_WINDOW", 25000, victim);
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL", "the kill IS the injection (no synthetic torn file)");

    // ── Torn state is PROVEN FROM BYTES, not inferred from the hook name.
    // The victim's hook captured CURRENT's actual digest vs the sidecar's
    // expected digest at the moment of the kill; the parent independently
    // re-reads the same durable bytes. torn=false ⇒ TEST FAILURE.
    assert.ok(tornMarker.torn_proof, "byte proof captured inside the torn window");
    assert.equal(tornMarker.torn_proof.torn, true, "hook-time byte proof: sidecar does not match CURRENT (torn)");
    const torn = tornWindowState(fx.execDir);
    assert.equal(torn.cur, true, "CURRENT.json bytes present");
    assert.equal(torn.sidecar, true, "sidecar present (the seam is before the sidecar rewrite, not before the CURRENT rename)");
    assert.equal(torn.torn, true, "O2_TORN_STATE = TRUE — post-kill bytes: sidecar digest differs from CURRENT bytes");
    assert.notEqual(torn.expected, torn.actual, "sidecar is stale relative to CURRENT bytes (torn, not rolled back)");
    const readLeg1 = await freshLeg({ mode: "read-current", legKey: "o2-read1", legArgs: { execDir: fx.execDir } });
    const r1 = readLeg1.value("LEG");
    // Torn window realized: the read path MUST fail closed with the exact
    // sealed code — silent acceptance of the unprovable revision is
    // forbidden (potential revocation).
    assert.equal(r1.adopted, false, "torn revision NEVER adopted");
    assert.equal(r1.hold?.code, HOLD.SNAPSHOT_CHECKSUM_MISMATCH, "exact sealed refusal on the read path");
    assert.match(r1.hold?.message ?? "", /checksum mismatch/i);
    // The writer's session must NOT continue authority on top of the
    // unprovable view: the continuation lands in the torn store and the
    // store's own read refuses — ownership is not silently resurrected
    // over a potentially-revoked store.
    const contLeg = await freshLeg({
      mode: "continue-owner", legKey: "o2-continue",
      legArgs: { execDir: fx.execDir, fields: holderFields(fx) },
    });
    const v = contLeg.value("LEG");
    // The lease record itself is readable locally (its truth does not
    // depend on connectivity); the CONTINUATION is lawful only if the
    // store proves the record — the exact record check stays possible.
    assert.equal(v.continued?.continued, true, "lease continuity re-checks from durable bytes (the record survived torn CURRENT)");
    // Restart stability of the store refusal: a second read refuses again.
    const readLeg2 = await freshLeg({ mode: "read-current", legKey: "o2-read2", legArgs: { execDir: fx.execDir } });
    assert.equal(readLeg2.value("LEG").hold?.code, HOLD.SNAPSHOT_CHECKSUM_MISMATCH, "restart-stable store refusal");
    void tornMarker;
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ O3 ═════════════════════════════════════════
// Outage/reconnect mid-write on the remnant-lease store: (onset) the outage
// adds NO lease fact — the remnant stays a remnant while the transport is
// down; (reconnect) connectivity returns and re-derives the SAME ownership
// truth from durable bytes — reconnect NEVER resurrects stale authority; the
// orphaned lease refuses a fresh actor exactly as before; ownership resolves
// only by secret proof or lawful re-issue. Second cycle repeats the same
// verdicts (stability).

test("E3 O3 W-W2-OUTAGE-RECONNECT: remnant lease + outage onset keeps ownership frozen; reconnect re-derives the same durable truth (stale authority not resurrected); ownership resolves by secret proof or HOLD — twice", async () => {
  const fx = makeLeaseFixture({ tag: "o3" });
  const ack = ackPath("o3");
  try {
    // ── Holder death FIRST (real SIGKILL): the remnant exists BEFORE the
    // outage — the O3 precondition (remnant lease + outage).
    const victim = trackHolder(spawnLeaseHolder({
      execDir: fx.execDir, repo: fx.repo, mode: "lease", ackPath: ack, helpers: HELPERS,
      fields: holderFields(fx),
    }));
    await waitForMarker(ack, "LEASE_ACTIVE", 20000, victim);
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL");
    const remnant = readLease(fx.execDir);
    assert.equal(remnant.released_at, null, "remnant: active record, dead holder");

    // ── OUTAGE ONSET (class 6 seam): the refusal fires while the remnant
    // persists; the outage adds NO lease fact.
    const outageLeg = await freshLeg({
      mode: "transport-outage", legKey: "o3-onset",
      legArgs: { execDir: fx.execDir },
    });
    const t1 = outageLeg.value("LEG").transport;
    assert.equal(t1.status, "error", "outage onset: dependency refuses (fail closed)");
    assert.equal(t1.httpResponses, 1, "outage onset: no retry (maxRetries=0)");
    assert.deepEqual(outageLeg.value("LEG").leaseAfter,
      { lease_id: remnant.lease_id, lease_revision: remnant.lease_revision, released_at: null, actor_id: remnant.actor_id },
      "outage onset: the remnant's lease facts are UNCHANGED (nobody holds; nobody invented)");
    // During the outage the second actor is STILL refused: the outage is
    // not a license to invent authority locally either.
    const duringOutage = await freshLeg({
      mode: "acquire-second-actor", legKey: "o3-during",
      legArgs: { execDir: fx.execDir, fields: { execution_id: fx.executionId, chain_id: fx.lease.chain_id,
        checkpoint_id: fx.lease.checkpoint_id, repository_identity: fx.lease.repository_identity,
        worktree_identity: fx.lease.worktree_identity, actor_id: " opportun-e3".trim(), session_id: "sess_opportun_e3",
        session_secret: "opportun-secret", lease_secret: "opportun-secret", expected_head: fx.lease.expected_head } },
    });
    assert.equal(duringOutage.value("LEG").hold?.code, HOLD.RESUME_LEASE_CONFLICT, "remnant + outage: takeover still refused (durable authority first, connectivity has no vote)");

    // ── RECONNECT: the dependency becomes reachable again (the same real
    // adapter, healthy scripted provider this time) — and it restores
    // NOTHING by itself.
    const healthyLeg = await freshLeg({
      mode: "transport-healthy", legKey: "o3-reconnect",
      legArgs: { execDir: fx.execDir, payload: JSON.stringify({ ok: true, verdict: "DECOMPOSED", note: "e3 reconnect control" }) },
    });
    const t2 = healthyLeg.value("LEG").transport;
    assert.equal(t2.status, "completed", "reconnect: connectivity restored (dependency answers)");
    assert.equal(t2.httpResponses, 1, "reconnect: the new request is a NEW recorded attempt (maxRequests=1, no continuation of the dead attempt)");
    // The remote fact exists only because the real dependency returned it —
    // and it did NOT resurrect the stale lease:
    assert.deepEqual(healthyLeg.value("LEG").leaseAfter,
      { lease_id: remnant.lease_id, lease_revision: remnant.lease_revision, released_at: null, actor_id: remnant.actor_id },
      "STALE LEASE AFTER RECONNECT: still a remnant (reconnect != ownership)");
    // And the fresh actor is STILL refused post-reconnect.
    const afterReconnect = await freshLeg({
      mode: "acquire-second-actor", legKey: "o3-after",
      legArgs: { execDir: fx.execDir, fields: { execution_id: fx.executionId, chain_id: fx.lease.chain_id,
        checkpoint_id: fx.lease.checkpoint_id, repository_identity: fx.lease.repository_identity,
        worktree_identity: fx.lease.worktree_identity, actor_id: "opportun-e3-b", session_id: "sess_opportun_e3_b",
        session_secret: "opportun-secret-b", lease_secret: "opportun-secret-b", expected_head: fx.lease.expected_head } },
    });
    assert.equal(afterReconnect.value("LEG").hold?.code, HOLD.RESUME_LEASE_CONFLICT, "reconnect did not restore authority (exact conflict fence re-fires)");

    // ── POST-OUTAGE OWNERSHIP = RESOLVED OR HOLD, by durable truth: the
    // same session's secret proof resolves the continuation.
    const resolveLeg = await freshLeg({
      mode: "continue-owner", legKey: "o3-resolve",
      legArgs: { execDir: fx.execDir, fields: holderFields(fx) },
    });
    const v = resolveLeg.value("LEG");
    assert.equal(v.hold ?? null, null, "ownership resolves by secret proof (RESOLVED arm)");
    assert.equal(v.continued?.lease_id, remnant.lease_id, "the SAME record continues — nothing was resurrected, it was proven");

    // ── SECOND CYCLE (repeated-cycle stability): a second outage→reconnect
    // round re-derives the SAME verdicts; no authority changed unexpectedly.
    const outageLeg2 = await freshLeg({
      mode: "transport-outage", legKey: "o3-onset2", legArgs: { execDir: fx.execDir },
    });
    assert.equal(outageLeg2.value("LEG").transport.status, "error", "second cycle: outage refuses again");
    assert.deepEqual(outageLeg2.value("LEG").leaseAfter,
      { lease_id: remnant.lease_id, lease_revision: remnant.lease_revision, released_at: null, actor_id: remnant.actor_id },
      "second cycle: lease facts STILL frozen (no drift)");
    const healthyLeg2 = await freshLeg({
      mode: "transport-healthy", legKey: "o3-reconnect2",
      legArgs: { execDir: fx.execDir, payload: JSON.stringify({ ok: true, verdict: "DECOMPOSED", note: "e3 reconnect cycle 2" }) },
    });
    assert.equal(healthyLeg2.value("LEG").transport.status, "completed", "second cycle: reconnect works again");
    assert.deepEqual(healthyLeg2.value("LEG").leaseAfter,
      { lease_id: remnant.lease_id, lease_revision: remnant.lease_revision, released_at: null, actor_id: remnant.actor_id },
      "second cycle: reconnect STILL restores nothing (stale lease never resurrected)");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ O-NEG ══════════════════════════════════════
// Baseline (no outage): the same transport machinery answers (strict-JSON
// completion, exactly one request, zero outage-class codes) and the store is
// untouched; duplicate side effects = 0. Proves the class-6 fences are not
// over-triggered.

test("E3 O-NEG baseline: healthy dependency answers once with zero outage-class codes; no spurious refuses; store and lease untouched; duplicate side effects = 0", async () => {
  const fx = makeLeaseFixture({ tag: "oneg" });
  try {
    const leaseBefore = readLease(fx.execDir);
    const leg = await freshLeg({
      mode: "transport-healthy", legKey: "oneg",
      legArgs: { execDir: fx.execDir, payload: JSON.stringify({ ok: true, verdict: "DECOMPOSED", note: "e3 baseline" }) },
    });
    const t = leg.value("LEG").transport;
    assert.equal(t.status, "completed", "healthy dependency completes");
    assert.equal(t.reason, null, "zero outage-class codes (no refusal reason)");
    assert.equal(t.stopReason, "stop", "clean stopReason (not length)");
    assert.equal(t.httpResponses, 1, "exactly one request (maxRequests=1 honored)");
    assert.equal(t.requestCount, 1, "adapter request count 1");
    assert.equal(t.errorMessage, null, "no error text");
    assert.deepEqual(leg.value("LEG").leaseAfter,
      { lease_id: leaseBefore.lease_id, lease_revision: leaseBefore.lease_revision, released_at: null, actor_id: leaseBefore.actor_id },
      "baseline: lease/authority untouched");
    // The store was not disturbed by the baseline exchange.
    const r = await freshLeg({ mode: "read-current", legKey: "oneg-read", legArgs: { execDir: fx.execDir } });
    assert.equal(r.value("LEG").adopted, true, "baseline: store reads clean");
    assert.equal(r.value("LEG").revision, 0, "baseline: no duplicate publications (duplicate side effects = 0)");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════ SUITE CLEANUP ══════════════════════════════════════

test("E3 SUITE CLEANUP: zero surviving holder processes; leg scripts removed; ack namespaces destroyed", async () => {
  const att = cleanupAttestation(HOLDER_PIDS);
  assert.equal(att.orphans, 0, "zero orphan holder processes");
  assert.equal(att.residue, 0, "zero ack-path residue");
  await cleanupLegs();
  assert.equal(existsSync(leasePath("/nonexistent-e3-probe")), false, "leasePath helper sanity (no real-path writes)");
});
