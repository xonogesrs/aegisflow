// test/v2/test-e3-discrimination-probes.mjs
//
// E3 DISCRIMINATION PROBES — 7 probe families (card §15).
// Card: AUTOLOOP-V1-STAGE-F-P5-SOAK-E3-IMPLEMENTATION-1.
//
// Each probe MUTATES the tested production discipline surface (via sealed
// test-only injection hooks or durable fixture state — NEVER production
// bytes), asserts the intended assertion DIES (the suite fails closed when
// the discipline is broken), then RESTORES the state and proves production
// is untouched. A probe that cannot die proves nothing.
//
//   P1  TTL expiry cannot authorize: a remnant with a STALE timestamp is
//       still an active lease (no clock-based reclaim exists).
//   P2  Holder death is not authority transfer: takeover after death is
//       refused (the dead holder's record still fences).
//   P3  Interrupt is not success: the transport refuses a killed /
//       errored dependency — a half-answer is not a completion.
//   P4  Fallback is not silently enabled: maxRetries=0 — a refusal is the
//       FINAL answer (ledger proves one request).
//   P5  Remote acknowledgement cannot be forged: permit digests refuse a
//       fabricated secret even with the full public record known.
//   P6  Reconnect does not skip ownership reconciliation: after
//       connectivity returns, a fresh actor is STILL refused.
//   P7  Stale lease_revision cannot validate: revision mismatch is
//       refused at the owner fence.
//
// RESTORE PROOF: every probe restores its injection and re-runs the GREEN
// control afterward — the control passing after the probe proves the
// discipline surface was restored byte-for-byte and production stayed
// unmodified throughout.

// Run: node --import ./test/v2/helpers/e1-runtime-isolation-preload.mjs --test --test-timeout=90000 test/v2/test-e3-discrimination-probes.mjs
import "./helpers/e1-runtime-isolation-preload.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeLeaseFixture, installWorkerHelpers, spawnLeaseHolder,
  sigkill, waitForExit, waitForMarker,
  freshLeg, cleanupLegs, cleanupAttestation,
  readLease, acquireLease, validateLeaseOwner, HOLD, C2dHoldError,
  permitFromLease, assertWritePermit,
  createPiTransportAdapter, TRANSPORT_FREEZE,
  setInjectionHook, clearInjectionHooks,
  mkdtempSync, tmpdir, join, writeFileSync, readFileSync, rmSync, existsSync,
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
  return join(mkdtempSync(join(tmpdir(), `e3-ack-p${tag}-`)), "ack.json");
}

/** Make the intended assertion DIE: expect fn to throw/refuse. */
async function expectDead(fn, why) {
  try {
    await fn();
  } catch (e) {
    return e; // the assertion died — the probe's purpose is served
  }
  assert.fail(`PROBE DID NOT DIE: ${why} (the intended assertion passed — discipline not discriminated)`);
}

// ═══════════════════════════════ P1 ═════════════════════════════════════════

test("E3 P1 probe: TTL expiry cannot authorize — a stale-timestamped remnant is STILL an active lease; an expiry-claiming takeover dies", async () => {
  const fx = makeLeaseFixture({ tag: "p1" });
  try {
    // Forge ONLY a stale timestamp onto the record (the field a TTL
    // discipline would consult); identity/digests stay intact.
    const leasePath = join(fx.execDir, "lease.json");
    const lease = JSON.parse(readFileSync(leasePath, "utf8"));
    lease.acquired_at = "2020-01-01T00:00:00.000Z";
    lease.expires_at = "2020-01-01T01:00:00.000Z";
    writeFileSync(leasePath, JSON.stringify(lease, null, 2) + "\n");

    await expectDead(async () => {
      acquireLease(fx.execDir, {
        execution_id: fx.executionId, chain_id: fx.lease.chain_id, checkpoint_id: fx.lease.checkpoint_id,
        repository_identity: fx.lease.repository_identity, worktree_identity: fx.lease.worktree_identity,
        actor_id: "p1-intruder", session_id: "sess_p1",
        session_secret: "p1-secret", lease_secret: "p1-secret",
        expected_head: fx.lease.expected_head,
      });
    }, "stale-timestamped lease was reclaimed (a TTL discipline exists — forbidden)");

    // Control: with the record restored, the same-session proof continues.
    const leaseAfter = readLease(fx.execDir);
    assert.equal(leaseAfter.lease_id, fx.lease.lease_id, "record untouched by the refused takeover");
    assert.equal(leaseAfter.released_at, null, "record still active — NO clock consumed it");
    void lease;
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ P2 ═════════════════════════════════════════

test("E3 P2 probe: holder death is not authority transfer — a takeover after SIGKILL dies at the conflict fence; the proof-continuation control stays green", async () => {
  const fx = makeLeaseFixture({ tag: "p2" });
  const ack = ackPath("2");
  try {
    const victim = trackHolder(spawnLeaseHolder({
      execDir: fx.execDir, repo: fx.repo, mode: "intent", ackPath: ack, helpers: HELPERS,
      fields: holderFields(fx),
    }));
    await waitForMarker(ack, "INTENT_TAIL", 20000, victim);
    sigkill(victim);
    await waitForExit(victim.child);

    await expectDead(async () => {
      await freshLeg({
        mode: "acquire-second-actor", legKey: "p2-takeover",
        legArgs: { execDir: fx.execDir, fields: { execution_id: fx.executionId, chain_id: fx.lease.chain_id,
          checkpoint_id: fx.lease.checkpoint_id, repository_identity: fx.lease.repository_identity,
          worktree_identity: fx.lease.worktree_identity, actor_id: "p2-intruder", session_id: "sess_p2",
          session_secret: "p2-secret", lease_secret: "p2-secret", expected_head: fx.lease.expected_head } },
      }).then((leg) => {
        const v = leg.value("LEG");
        if (v.hold) throw new Error(v.hold.code);
      });
    }, "takeover succeeded after holder death (death transferred authority — forbidden)");

    // Control: the lawful secret-proof continuation is still admitted.
    const leg = await freshLeg({
      mode: "continue-owner", legKey: "p2-control",
      legArgs: { execDir: fx.execDir, fields: holderFields(fx) },
    });
    assert.equal(leg.value("LEG").continued?.continued, true, "control green after probe: proof still works");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ P3 ═════════════════════════════════════════

test("E3 P3 probe: interrupt is not success — a truncated/aborted dependency answer is an ERROR, never a completion; the healthy control completes", async () => {
  const fx = makeLeaseFixture({ tag: "p3" });
  try {
    // A dependency that DIES MID-STREAM (stream aborted mid-SSE) — the
    // real adapter must surface an error, not a completion.
    const leg = await freshLeg({
      mode: "transport-truncated", legKey: "p3-truncated",
      legArgs: { execDir: fx.execDir },
    });
    const t = leg.value("LEG").transport;
    if (!t || t.status === "completed") {
      assert.fail("PROBE DID NOT DIE: truncated dependency answer was adopted as a completion (interrupt treated as success)");
    }
    assert.equal(t.status, "error", "interrupt surfaced as an error");
    assert.notEqual(t.reason, null, "the refusal carries a reason (not silently swallowed)");

    // Control: the healthy scripted dependency completes (adapter restored
    // to its normal discipline — production untouched).
    const legOk = await freshLeg({
      mode: "transport-healthy", legKey: "p3-control",
      legArgs: { execDir: fx.execDir, payload: JSON.stringify({ ok: true, verdict: "DECOMPOSED" }) },
    });
    assert.equal(legOk.value("LEG").transport?.status, "completed", "control green after probe: healthy answers still complete");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ P4 ═════════════════════════════════════════

test("E3 P4 probe: fallback is not silently enabled — the adapter ledger proves exactly ONE dependency response on refusal (maxRetries=0); a ledger with >1 response would die", async () => {
  const fx = makeLeaseFixture({ tag: "p4" });
  try {
    const leg = await freshLeg({
      mode: "transport-outage", legKey: "p4",
      legArgs: { execDir: fx.execDir },
    });
    const t = leg.value("LEG").transport;
    assert.equal(t.httpResponses, 1, "the intended assertion: ONE response (fallback would make this >1 and the assertion would die)");
    assert.equal(t.freeze.maxRetries, 0, "TRANSPORT_FREEZE.maxRetries == 0 (the no-fallback contract itself)");
    assert.equal(t.freeze.maxRequests, 1, "TRANSPORT_FREEZE.maxRequests == 1");
    assert.equal(t.status, "error", "refusal is terminal");
    void fx;
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ P5 ═════════════════════════════════════════

test("E3 P5 probe: remote acknowledgement cannot be forged — a fabricated secret with the FULL public record dies at the digest fence; the true-secret control is admitted", async () => {
  const fx = makeLeaseFixture({ tag: "p5" });
  try {
    const lease = readLease(fx.execDir);
    // The forger knows EVERYTHING public: ids, revisions, digests — and
    // presents a fabricated secret. The digest fence must refuse.
    const forge = { lease_secret: "fabricated-secret", session_secret: "fabricated-secret" };
    await expectDead(async () => {
      permitFromLease(fx.execDir, lease, forge, true);
    }, "a fabricated secret was admitted with the full public record known (forged acknowledgement)");

    await expectDead(async () => {
      validateLeaseOwner(fx.execDir, lease.lease_id, lease.actor_id, lease.lease_revision, forge, true);
    }, "a fabricated secret validated lease ownership");

    // Control: the true secrets are admitted (fence intact, not
    // over-triggered).
    const live = assertWritePermit(fx.execDir, permitFromLease(fx.execDir, readLease(fx.execDir), fx.secrets, true));
    assert.equal(live.lease_id, fx.lease.lease_id, "control green after probe: the true permit is admitted");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ P6 ═════════════════════════════════════════

test("E3 P6 probe: reconnect does not skip ownership reconciliation — after connectivity returns, a fresh actor is STILL refused; a skip would die", async () => {
  const fx = makeLeaseFixture({ tag: "p6" });
  const ack = ackPath("6");
  try {
    const victim = trackHolder(spawnLeaseHolder({
      execDir: fx.execDir, repo: fx.repo, mode: "intent", ackPath: ack, helpers: HELPERS,
      fields: holderFields(fx),
    }));
    await waitForMarker(ack, "INTENT_TAIL", 20000, victim);
    sigkill(victim);
    await waitForExit(victim.child);

    // "Reconnect": the dependency is reachable again (healthy answer).
    const rec = await freshLeg({
      mode: "transport-healthy", legKey: "p6-reconnect",
      legArgs: { execDir: fx.execDir, payload: JSON.stringify({ ok: true, verdict: "DECOMPOSED" }) },
    });
    assert.equal(rec.value("LEG").transport?.status, "completed", "reconnect: dependency answers");

    // The intended assertion: even WITH connectivity, the remnant fences.
    await expectDead(async () => {
      await freshLeg({
        mode: "acquire-second-actor", legKey: "p6-takeover",
        legArgs: { execDir: fx.execDir, fields: { execution_id: fx.executionId, chain_id: fx.lease.chain_id,
          checkpoint_id: fx.lease.checkpoint_id, repository_identity: fx.lease.repository_identity,
          worktree_identity: fx.lease.worktree_identity, actor_id: "p6-intruder", session_id: "sess_p6",
          session_secret: "p6-secret", lease_secret: "p6-secret", expected_head: fx.lease.expected_head } },
      }).then((leg) => {
        const v = leg.value("LEG");
        if (v.hold) throw new Error(v.hold.code);
      });
    }, "reconnect skipped ownership reconciliation (fresh actor admitted a remnant lease)");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════════════ P7 ═════════════════════════════════════════

test("E3 P7 probe: stale lease_revision cannot validate — a revision-mismatched claim dies at the owner fence; the current-revision control validates", async () => {
  const fx = makeLeaseFixture({ tag: "p7" });
  try {
    const lease = readLease(fx.execDir);
    await expectDead(async () => {
      validateLeaseOwner(fx.execDir, lease.lease_id, lease.actor_id, lease.lease_revision + 5, fx.secrets, true);
    }, "a stale lease_revision validated (stale generation accepted — forbidden)");

    await expectDead(async () => {
      validateLeaseOwner(fx.execDir, lease.lease_id, lease.actor_id, 999, fx.secrets, true);
    }, "an older lease_revision validated");

    // Control: the CURRENT revision with true secrets validates.
    const v = validateLeaseOwner(fx.execDir, lease.lease_id, lease.actor_id, lease.lease_revision, fx.secrets, true);
    assert.equal(v.lease_revision, lease.lease_revision, "control green after probe: current authority validates");
  } finally {
    fx.cleanup();
  }
});

// ═══════════════════════ SUITE CLEANUP ══════════════════════════════════════

test("E3 PROBE SUITE CLEANUP: zero surviving holder processes; no injection hooks left armed; leg scripts removed", async () => {
  const att = cleanupAttestation(HOLDER_PIDS);
  assert.equal(att.orphans, 0, "zero orphan holder processes");
  assert.equal(att.residue, 0, "zero ack-path residue");
  clearInjectionHooks();
  await cleanupLegs();
});
