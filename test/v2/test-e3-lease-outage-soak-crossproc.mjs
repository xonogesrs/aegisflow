// test/v2/test-e3-lease-outage-soak-crossproc.mjs
//
// E3 LEASE/OUTAGE SOAK — CROSS-PROCESS LEGS (X-class blocks).
// Card: AUTOLOOP-V1-STAGE-F-P5-SOAK-E3-IMPLEMENTATION-1, under the sealed
// admission AUTOLOOP-V1-STAGE-F-P5-SOAK-E3-ADMISSION-1-20260906T133000Z.
//
// The reboot-critical class of E3: every durable fact re-observed here is
// produced in one process and JUDGED in a DIFFERENT, fresh process that
// imports the production modules cold (freshLeg spawns
// `node leg.mjs` — no shared memory, no fixture state, only durable bytes
// under the store directory and the durable ack marker). The parent test
// process itself performs NO authority verdict — it only orchestrates
// spawns and asserts on the leg's reported production verdicts.
//
//   X1  (L1 cross-process)  holder dies by SIGKILL in process A; process B
//                           re-observes the remnant from lease.json alone
//                           and refuses takeover (ttl_alone_cannot_reclaim).
//   X2  (L1 continuation)   process B — with the dead holder's secrets —
//                           CONTINUES the same lease record (ownership
//                           survives process death by secret proof).
//   X3  (O2 cross-process)  a torn publication window produced by a killed
//                           victim process is refused by a fresh reader
//                           (SNAPSHOT_CHECKSUM_MISMATCH), restart-stable.
//                           E3-REPAIR-1: the window is the true torn byte
//                           seam (before_checksum_rename — CURRENT already
//                           renamed, sidecar not yet rewritten) and torn=true
//                           is byte-proven (hook-time digest proof + parent
//                           re-read), never inferred from the hook name.
//   X4  (O3 cross-process)  remnant lease + outage onset + reconnect: a
//                           fresh process re-derives the same ownership
//                           truth — reconnect resurrects nothing.
//
// LEASE IS OWNERSHIP, NOT TTL. OUTAGE IS CONNECTIVITY LOSS, NOT AUTHORITY
// TRANSFER. No sleep-based expiry, no fake clocks, no TTL semantics: every
// window is opened/closed by SIGKILL against a durable marker.

// Run: node --import ./test/v2/helpers/e1-runtime-isolation-preload.mjs --test --test-timeout=90000 test/v2/test-e3-lease-outage-soak-crossproc.mjs
import "./helpers/e1-runtime-isolation-preload.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeLeaseFixture, installWorkerHelpers, spawnLeaseHolder, spawnTornPublicationVictim,
  sigkill, waitForExit, waitForMarker, tornWindowState,
  freshLeg, cleanupLegs,
  readLease, HOLD,
  cleanupAttestation, mkdtempSync, tmpdir, join,
} from "./helpers/e3-lease-outage-fixtures.mjs";

const HELPERS = installWorkerHelpers();

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

const HOLDER_PIDS = [];
const HOLDER_ACKS = [];
function trackHolder(v) { HOLDER_PIDS.push(v.pid); HOLDER_ACKS.push(v.ackPath); return v; }

function ackPath(tag) {
  return join(mkdtempSync(join(tmpdir(), `e3-ack-x${tag}-`)), "ack.json");
}

// ═══════════════════════════════ X1 ═════════════════════════════════════════

test("E3 X1 cross-process L1: process A dies holding the lease; process B re-observes the remnant from durable bytes alone and refuses takeover (ttl_alone_cannot_reclaim)", async () => {
  const fx = makeLeaseFixture({ tag: "x1" });
  const ack = ackPath("1");
  try {
    // Process A: real holder, real SIGKILL, durable INTENT tail.
    const victim = trackHolder(spawnLeaseHolder({
      execDir: fx.execDir, repo: fx.repo, mode: "intent", ackPath: ack, helpers: HELPERS,
      fields: holderFields(fx),
    }));
    const marker = await waitForMarker(ack, "INTENT_TAIL", 20000, victim);
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL", "process A died ungracefully");

    // Process B: a FRESH node process that imports the production lease
    // module cold, re-reads the durable record, and attempts the takeover.
    const leg = await freshLeg({
      mode: "acquire-second-actor", legKey: "x1-b",
      legArgs: { execDir: fx.execDir, fields: { execution_id: fx.executionId, chain_id: fx.lease.chain_id,
        checkpoint_id: fx.lease.checkpoint_id, repository_identity: fx.lease.repository_identity,
        worktree_identity: fx.lease.worktree_identity, actor_id: "x1-intruder", session_id: "sess_x1_intruder",
        session_secret: "x1-secret", lease_secret: "x1-secret", expected_head: fx.lease.expected_head } },
    });
    const v = leg.value("LEG");
    assert.equal(v.hold?.code, HOLD.RESUME_LEASE_CONFLICT, "process B refused at the exact conflict fence");
    assert.match(v.hold?.message ?? "", /active lease exists/);
    assert.equal(v.hold?.details?.ttl_alone_cannot_reclaim, true, "frozen payload crosses the process boundary");
    // The re-observation matches process A's durable marker exactly.
    assert.equal(v.leaseAfter?.lease_id, marker.lease_id, "the SAME record process A held is what process B saw");
    assert.equal(v.leaseAfter?.released_at, null, "remnant active-on-disk (no TTL decay across processes)");
    assert.equal(v.leaseAfter?.lease_revision, 1, "record revision unchanged by the refused takeover");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ X2 ═════════════════════════════════════════

test("E3 X2 cross-process continuation: a fresh process holding the dead holder's secrets continues the SAME lease record (ownership survives process death by proof)", async () => {
  const fx = makeLeaseFixture({ tag: "x2" });
  const ack = ackPath("2");
  try {
    const victim = trackHolder(spawnLeaseHolder({
      execDir: fx.execDir, repo: fx.repo, mode: "intent", ackPath: ack, helpers: HELPERS,
      fields: holderFields(fx),
    }));
    const marker = await waitForMarker(ack, "INTENT_TAIL", 20000, victim);
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL");

    // Fresh process, ORIGINAL secrets: the continuation is judged entirely
    // by the production validateLeaseOwner path against durable bytes.
    const leg = await freshLeg({
      mode: "continue-owner", legKey: "x2-b",
      legArgs: { execDir: fx.execDir, fields: holderFields(fx) },
    });
    const v = leg.value("LEG");
    assert.equal(v.hold ?? null, null, "no HOLD for the lawful cross-process continuation");
    assert.equal(v.continued?.continued, true, "production continuation proof accepted in a cold process");
    assert.equal(v.continued?.lease_id, marker.lease_id, "the SAME record continues — resurrection never happened, PROOF did");
    assert.equal(v.continued?.lease_revision, marker.lease_revision, "record revision preserved across the boundary");

    // And the WRONG secrets in the same fresh-process shape are still
    // refused (the fence that admitted X2's proof is not over-triggered).
    const legBad = await freshLeg({
      mode: "continue-owner", legKey: "x2-bad",
      legArgs: { execDir: fx.execDir, fields: { ...holderFields(fx), session_secret: "not-the-secret" } },
    });
    assert.equal(legBad.value("LEG").hold?.code, HOLD.RESUME_LEASE_CONFLICT, "wrong-secret cross-process continuation refused");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ X3 ═════════════════════════════════════════

test("E3 X3 cross-process O2: the torn publication window produced by a killed victim process is refused by fresh reader processes — restart-stable, exact sealed code", async () => {
  const fx = makeLeaseFixture({ tag: "x3" });
  const ack = ackPath("3");
  try {
    // Process A (victim): real publication chain, killed inside the window.
    const victim = trackHolder(spawnTornPublicationVictim({
      execDir: fx.execDir, repo: fx.repo, ackPath: ack, helpers: HELPERS,
      fields: holderFields(fx),
    }));
    const tornMarker = await waitForMarker(ack, "TORN_WINDOW", 25000, victim);
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL", "the kill IS the injection");

    // Torn state is PROVEN FROM BYTES (hook-time proof + parent re-read),
    // never inferred from the hook name. torn=false ⇒ TEST FAILURE.
    assert.ok(tornMarker.torn_proof, "byte proof captured inside the torn window");
    assert.equal(tornMarker.torn_proof.torn, true, "hook-time byte proof: sidecar does not match CURRENT (torn)");
    const torn = tornWindowState(fx.execDir);
    assert.equal(torn.torn, true, "X3_TORN_STATE = TRUE — post-kill bytes: sidecar digest differs from CURRENT bytes");
    assert.notEqual(torn.expected, torn.actual, "sidecar is stale relative to CURRENT bytes (torn, not rolled back)");
    const leg1 = await freshLeg({ mode: "read-current", legKey: "x3-b1", legArgs: { execDir: fx.execDir } });
    const r1 = leg1.value("LEG");
    assert.equal(r1.adopted, false, "fresh process NEVER adopts the unprovable revision");
    assert.equal(r1.hold?.code, HOLD.SNAPSHOT_CHECKSUM_MISMATCH, "exact sealed refusal crosses the process boundary");
    // RESTART STABILITY: a second cold reader refuses identically.
    const leg2 = await freshLeg({ mode: "read-current", legKey: "x3-b2", legArgs: { execDir: fx.execDir } });
    assert.equal(leg2.value("LEG").hold?.code, HOLD.SNAPSHOT_CHECKSUM_MISMATCH, "restart-stable refusal (second cold reader)");
    // And the lease record — whose truth does NOT depend on the CURRENT
    // view — is still re-observed by a cold process (durable record): the
    // torn view frees nothing for takeover.
    const legL = await freshLeg({
      mode: "acquire-second-actor", legKey: "x3-b3",
      legArgs: { execDir: fx.execDir, fields: { execution_id: fx.executionId, chain_id: fx.lease.chain_id,
        checkpoint_id: fx.lease.checkpoint_id, repository_identity: fx.lease.repository_identity,
        worktree_identity: fx.lease.worktree_identity, actor_id: "x3-intruder", session_id: "sess_x3",
        session_secret: "x3-secret", lease_secret: "x3-secret", expected_head: fx.lease.expected_head } },
    });
    assert.equal(legL.value("LEG").hold?.code, HOLD.RESUME_LEASE_CONFLICT, "the torn view did not free the lease for takeover");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ X4 ═════════════════════════════════════════

test("E3 X4 cross-process O3: remnant lease + outage onset + reconnect re-derived by a cold process — reconnect restores nothing, ownership resolves by proof", async () => {
  const fx = makeLeaseFixture({ tag: "x4" });
  const ack = ackPath("4");
  try {
    // Process A: holder dies holding the lease (the remnant exists first).
    const victim = trackHolder(spawnLeaseHolder({
      execDir: fx.execDir, repo: fx.repo, mode: "lease", ackPath: ack, helpers: HELPERS,
      fields: holderFields(fx),
    }));
    const marker = await waitForMarker(ack, "LEASE_ACTIVE", 20000, victim);
    sigkill(victim);
    const exit = await waitForExit(victim.child);
    assert.equal(exit.signal, "SIGKILL");

    // Process B (outage onset): the dependency refuses; the cold process
    // re-observes that the outage added NO lease fact.
    const onsetLeg = await freshLeg({
      mode: "transport-outage", legKey: "x4-onset", legArgs: { execDir: fx.execDir },
    });
    const t1 = onsetLeg.value("LEG");
    assert.equal(t1.transport?.status, "error", "cold process: outage refuses (fail closed)");
    assert.deepEqual(t1.leaseAfter,
      { lease_id: marker.lease_id, lease_revision: marker.lease_revision, released_at: null, actor_id: fx.actorId },
      "cold process: the remnant's lease facts unchanged by the outage");

    // Process C (reconnect): connectivity restored; the cold process
    // re-derives the SAME ownership truth — nothing was resurrected.
    const recLeg = await freshLeg({
      mode: "transport-healthy", legKey: "x4-reconnect",
      legArgs: { execDir: fx.execDir, payload: JSON.stringify({ ok: true, verdict: "DECOMPOSED", note: "x4 reconnect" }) },
    });
    const t2 = recLeg.value("LEG");
    assert.equal(t2.transport?.status, "completed", "cold process: reconnect completes");
    assert.deepEqual(t2.leaseAfter,
      { lease_id: marker.lease_id, lease_revision: marker.lease_revision, released_at: null, actor_id: fx.actorId },
      "cold process: reconnect restored NOTHING (stale lease still a remnant)");

    // Process D (resolution): the ORIGINAL secrets, in a cold process,
    // resolve ownership by proof — RESOLVED arm of RESOLVED_OR_HOLD.
    const resLeg = await freshLeg({
      mode: "continue-owner", legKey: "x4-resolve",
      legArgs: { execDir: fx.execDir, fields: holderFields(fx) },
    });
    const v = resLeg.value("LEG");
    assert.equal(v.hold ?? null, null, "cold process: ownership resolves by secret proof");
    assert.equal(v.continued?.lease_id, marker.lease_id, "the SAME record continues — proven, not resurrected");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════ SUITE CLEANUP ══════════════════════════════════════

test("E3 CROSSPROC SUITE CLEANUP: zero surviving holder processes; leg scripts removed; ack namespaces destroyed", async () => {
  const att = cleanupAttestation(HOLDER_PIDS);
  assert.equal(att.orphans, 0, "zero orphan holder processes");
  assert.equal(att.residue, 0, "zero ack-path residue");
  await cleanupLegs();
});
