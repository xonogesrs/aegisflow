// src/rollover/rollover-controller.mjs
//
// STAGE D — THE rollover authority sequence driver.
//
// Owns every sanctioned rollover publication while a rollover is ACTIVE
// (CONTRACT §6 publication-chain rule: the rollover authority is the ONLY
// permitted publisher; every non-rollover dispatch is fenced by the §9a
// durable gate in the resume entries).
//
// Durability model (single-store discipline — CONTRACT §0.1):
//   Every state change = ONE C2D journal intent/complete pair
//   (side_effect_class: rollover_intent | rollover_ack | rollover_transfer |
//    rollover_retirement | rollover_abort) published under lease custody,
//   followed by ONE checksummed CURRENT publication through the EXISTING
//   checkpoint authority (checkpoint-bridge publishCheckpoint → c2d
//   publishCurrent CAS + structured lock + write permit). No sidecar, no
//   second engine, no process-memory truth.
//
// Counter conformance note (frozen CONTRACT §6 timeline mapped onto this
// stack): the v2 AutoLoop spine advances snapshot revisions without writing
// C2D journal rows, so TWO counters exist. H (the pinned verified clean head)
// is the LIVE CURRENT revision at the safe point; the C2D journal counter is
// gapless from 1 (validateContinuity). The intent pins checkpointRevision=H /
// checkpointDigest=digest(CURRENT@H); its JOURNAL row lands at
// lastComplete+1 and is completed inside one custody window, so no INTENT
// row ever exists beyond lastComplete (T75 ordering pin).

import {
  acquireLease, releaseLease,
} from "../c2d/lease.mjs";
import { permitFromLease } from "../c2d/permit.mjs";
import { C2dHoldError } from "../c2d/fs-atomic.mjs";
import {
  publishIntent, publishComplete,
} from "../c2d/journal.mjs";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { scanForSecrets } from "../evidence/run-evidence-store.mjs";
import { publishCheckpoint, readCheckpoint } from "../v2/checkpoint-bridge.mjs";
import {
  ROLLOVER_STATES,
  validateTriggerEvent,
  isLegalRolloverTransition,
  rolloverTelemetryToken,
  deriveAuthorityDecisionDigest,
  deriveRolloverId,
  sessionIdentityDigest,
  deriveAckStableFieldDigest,
  deriveTransferDigest,
  deriveRetirementDigest,
  emptyRolloverBlock,
} from "./rollover-authority.mjs";

const ROLLOVER_ACTOR = "autoloop-rollover-authority";

export class RolloverHoldError extends Error {
  constructor(code, reason, extra = {}) {
    super(`cross_session_rollover: ${code}: ${reason}`);
    this.name = "RolloverHoldError";
    this.code = code;
    this.reason = reason;
    this.holdCode = code;
    this.applied = false;
    Object.assign(this, extra);
  }
}

/**
 * Safe freeze point proof (CONTRACT §7) — DURABLE facts only:
 *   - C2D journal continuity: no incomplete tail (no partial publication)
 *   - CURRENT verifies by external checksum (readCheckpoint throws otherwise)
 *   - no interrupted writer phase / live writer lease holder in the snapshot
 * In-flight executor/reviewer/reservation/settlement counters are zero BY
 * CONSTRUCTION when this is invoked from the between-phase boundary hook of
 * the runner (the only lawful requesting path — K14); the caller must pass
 * `atSafeBoundary: true` from that hook, which this function records into
 * the proof. Sleep/idle/queue-empty guesses are never accepted.
 */
export function declareSafeFreezePoint({ root, executionId, atSafeBoundary = false }) {
  const verified = readCheckpoint(root, executionId);
  const { execDir, snapshot, digest } = verified;
  let cont;
  try {
    cont = rolloverClassContinuity(execDir);
  } catch (e) {
    throw new RolloverHoldError("CROSS_SESSION_ROLLOVER_SAFE_POINT_UNAVAILABLE", `journal continuity unreadable: ${String(e?.code ?? e)}`);
  }
  if (cont.incompleteTail !== null) {
    throw new RolloverHoldError("CROSS_SESSION_ROLLOVER_SAFE_POINT_UNAVAILABLE", `incomplete journal tail at ${cont.incompleteTail}`);
  }
  if (snapshot.writer_phase_active === true || snapshot.writer_lease_holder) {
    throw new RolloverHoldError("CROSS_SESSION_ROLLOVER_SAFE_POINT_UNAVAILABLE", "writer phase active");
  }
  if (!atSafeBoundary) {
    throw new RolloverHoldError("CROSS_SESSION_ROLLOVER_SAFE_POINT_UNAVAILABLE", "request did not originate at a runner between-phase boundary");
  }
  return {
    execDir, snapshot,
    checkpointRevision: snapshot.revision,
    checkpointDigest: digest,
    proof: {
      journal_last_complete: cont.lastComplete,
      incomplete_tail: null,
      writer_phase_active: false,
      at_runner_safe_boundary: true,
      proven_at: new Date().toISOString(),
    },
  };
}

/**
 * Read the current rollover block (checksum-verified CURRENT or null).
 */
export function readRolloverBlock(root, executionId) {
  try {
    const { snapshot } = readCheckpoint(root, executionId);
    return snapshot.graph?.rollover ?? null;
  } catch (e) {
    if (String(e?.code ?? "").includes("CHECKSUM") || String(e?.code ?? "").includes("CORRUPT")) throw e;
    return null;
  }
}

/**
 * OWNER entry: validate trigger, pin the verified clean head H, publish the
 * durable INTENT (journal row at lastComplete+1, class rollover_intent) and
 * the CHECKPOINT_PUBLISHED mirror at revision R=H+1.
 *
 * Idempotency (T52/T74): the same request re-mints the SAME rolloverId (P2
 * determinism over byte-once pinned provenance); an existing ACTIVE intent
 * with the same id collapses to a no-op; a DIFFERENT active id for the same
 * owner generation fails closed (K1).
 */
export async function beginRollover(opts) {
  const {
    root, executionId, store,
    triggerEvent, targetAdapterKind, targetProviderKind,
    sourceIdentity, admission, graphIdentity,
    toolSelectionCommitmentDigest, budgetStateDigest, lifecycleStateDigest,
    safePoint = null,
  } = opts;

  const tv = validateTriggerEvent(triggerEvent);
  if (!tv.ok) throw new RolloverHoldError(tv.code, tv.reason);
  // ADV-REVIEW P2-5 fence: provenance is pinned BYTE-ONCE — so it is
  // secret-scanned BEFORE pinning; a suspect field fails closed (the bytes
  // are rejected, never transformed) keeping the idempotency key stable.
  {
    for (const blob of [
      JSON.stringify(triggerEvent.observedFact ?? null),
      String(triggerEvent.source ?? ""),
      String(triggerEvent.authorityDecisionRef ?? ""),
    ]) {
      if (blob === "null") continue;
      const scan = scanForSecrets(blob);
      if (!scan.safe) {
        throw new RolloverHoldError("CROSS_SESSION_ROLLOVER_TRIGGER_UNAUTHORIZED",
          `trigger provenance failed secret scan: ${scan.matches.join(",")}`);
      }
    }
  }

  const freeze = safePoint ?? declareSafeFreezePoint({ root, executionId, atSafeBoundary: true });
  const { execDir, snapshot } = freeze;
  // ── Intake resolution ────────────────────────────────────────────────
  // K1 fence: at most ONE active rollover per owner generation. A retry of
  // the SAME logical request collapses idempotently: equality is defined
  // over the authority-bearing fields MINUS the checkpoint pin (the head
  // may have advanced between attempts) — trigger decision digest, source/
  // target bindings, task/run/admission identities.
  const rollover0 = snapshot.graph?.rollover ?? null;
  const D_adm = decisionDigestOf(triggerEvent);
  const srcDigest = sessionIdentityDigest(sourceIdentity);
  const admissionId = String(admission?.admission_id ?? triggerEvent.admissionIdentity);
  let pinnedBasis = null; // { checkpointRevision, checkpointDigest }

  if (rollover0?.active_rollover_id) {
    const existingId = rollover0.active_rollover_id;
    const ei = rollover0.intents?.[existingId];
    const sameRequest = !!ei
      && !ROLLOVER_TERMINAL_SET.has(rollover0.state)
      && ei.authorityDecisionDigest === D_adm
      && ei.targetAdapterKind === targetAdapterKind
      && ei.targetProviderKind === targetProviderKind
      && ei.sourceGeneration === sourceIdentity.sessionGeneration
      && ei.sourceSessionIdentityDigest === srcDigest
      && String(ei.taskIdentity) === String(triggerEvent.taskIdentity)
      && String(ei.runIdentity) === String(triggerEvent.runIdentity)
      && String(ei.admissionIdentity) === admissionId;
    if (sameRequest) {
      return { ok: true, idempotent: true, rolloverId: existingId, state: rollover0.state };
    }
    throw new RolloverHoldError("CROSS_SESSION_ROLLOVER_TRIGGER_UNAUTHORIZED", "a different rollover is already active for this owner generation (K1)");
  }

  // T74 sequential refresh-retry: an ABORTED intent for the same logical
  // request re-mints the SAME rolloverId by REUSING its byte-once pinned
  // checkpoint basis (the provenance was pinned once at first intake).
  // ADV-REVIEW P1-2 fence: the owner-of-record is DURABLE. Once seeded it
  // changes ONLY inside a committed transfer (CONTRACT §4) — a caller may
  // never rewrite it via sourceIdentity/generation. Byte-match or refuse.
  if (rollover0?.owner) {
    if (rollover0.owner.session_identity_digest !== srcDigest
        || Number(rollover0.owner.session_generation) !== Number(sourceIdentity.sessionGeneration)) {
      throw new RolloverHoldError("CROSS_SESSION_AUTHORITY_MISMATCH",
        "source identity/generation does not match the durable owner-of-record (owner is never caller-supplied)");
    }
  }
  const sourceGeneration = sourceIdentity.sessionGeneration;
  for (const prev of Object.values(rollover0?.intents ?? {})) {
    if (!prev || prev.status !== "ABORTED") continue;
    if (prev.authorityDecisionDigest === D_adm
        && prev.targetAdapterKind === targetAdapterKind
        && prev.targetProviderKind === targetProviderKind
        && prev.sourceGeneration === sourceGeneration
        && prev.sourceSessionIdentityDigest === srcDigest
        && String(prev.taskIdentity) === String(triggerEvent.taskIdentity)
        && String(prev.runIdentity) === String(triggerEvent.runIdentity)
        && String(prev.admissionIdentity) === admissionId
        && Number.isInteger(prev.checkpointRevision)) {
      pinnedBasis = { checkpointRevision: prev.checkpointRevision, checkpointDigest: prev.checkpointDigest };
      break;
    }
  }

  const H = pinnedBasis ? pinnedBasis.checkpointRevision : freeze.checkpointRevision;
  const Hd = pinnedBasis ? pinnedBasis.checkpointDigest : freeze.checkpointDigest;
  const rolloverId = mintRolloverId({ triggerEvent, D_adm, sourceIdentity, targetAdapterKind, targetProviderKind, admission, graphIdentity, toolSelectionCommitmentDigest, budgetStateDigest, lifecycleStateDigest, H, Hd });
  const intentCore = {
    schemaVersion: 1,
    sourceSessionIdentityDigest: srcDigest,
    sourceGeneration,
    targetAdapterKind,
    targetProviderKind,
    trigger: triggerEvent.trigger,
    authorityDecisionDigest: D_adm,
    taskIdentity: String(triggerEvent.taskIdentity),
    runIdentity: String(triggerEvent.runIdentity),
    admissionIdentity: String(admission?.admission_id ?? triggerEvent.admissionIdentity),
    graphIdentity: graphIdentity ?? { ir_sha256: snapshot.decomposition_ir_sha256 ?? null, dag_sha256: snapshot.dag_sha256 ?? null },
    budgetIdentity: budgetStateDigest ?? null,
    checkpointRevision: H,
    checkpointDigest: Hd,
    toolSelectionCommitmentDigest: toolSelectionCommitmentDigest ?? null,
    budgetStateDigest: budgetStateDigest ?? null,
    lifecycleStateDigest: lifecycleStateDigest ?? null,
    expectedTargetGeneration: sourceGeneration + 1,
    // Provenance pinned BYTE-ONCE at intake (re-observation never alters):
    triggerSource: triggerEvent.source,
    triggerObservedFact: triggerEvent.observedFact ?? null,
    triggerFreshness: triggerEvent.freshness,
    triggerDecisionRef: triggerEvent.authorityDecisionRef,
  };

  await emitTransitionEvents(store, [
    [ROLLOVER_STATES.ROLLOVER_REQUESTED, { rollover_id: rolloverId, trigger: triggerEvent.trigger }],
  ]);

  // Journal INTENT row at gapless-next revision, completed in-custody (T75).
  await withLeaseCustody(execDir, snapshot, async (permit) => {
    const rev = (await journalTail(store, execDir)) + 1;
    const base = journalPairFields({ rev, snapshot, from: ROLLOVER_STATES.ACTIVE_A, to: ROLLOVER_STATES.CHECKPOINT_PUBLISHED, expectedRevisionBefore: H, sideEffectClass: "rollover_intent" });
    publishIntent(execDir, { ...base, record_kind: "intent", rollover_id: rolloverId, intent: intentCore }, permit);
    publishComplete(execDir, { ...base, record_kind: "complete" }, undefined, permit);
    noteJournalTail(store, rev);
  });

  // Mirror publication at R=H+1 (spawn-base recorded additively post-mint).
  const mirror = mirrorFrom(rollover0);
  mirror.owner = { session_identity_digest: intentCore.sourceSessionIdentityDigest, session_generation: sourceGeneration };
  mirror.active_rollover_id = rolloverId;
  mirror.state = ROLLOVER_STATES.CHECKPOINT_PUBLISHED;
  mirror.intents[rolloverId] = {
    ...intentCore,
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
    journalRevision: store.rolloverJournalTail ?? null,
    spawnBaseRevision: freeze.checkpointRevision + 1,
  };
  // The publication CAS expects the LIVE head; the P2 preimage keeps the
  // byte-once pinned basis (H) — two different counters by design.
  await publishMirror({ root, executionId, store, prior: snapshot, mirror, expectedRevision: freeze.checkpointRevision });

  await emitTransitionEvents(store, [
    [ROLLOVER_STATES.A_FROZEN, { rollover_id: rolloverId }],
    [ROLLOVER_STATES.CHECKPOINT_PUBLISHED, { rollover_id: rolloverId, spawn_base_revision: H + 1 }],
  ]);

  return { ok: true, rolloverId, intent: intentCore, sourceGeneration, spawnBaseRevision: freeze.checkpointRevision + 1, state: mirror.state };
}

/**
 * Mark B_SPAWN_REQUESTED — published by the coordinator immediately before
 * dispatching spawnSuccessorSession (frozen machine transition).
 */
export async function recordSpawnDispatched({ root, executionId, store, rolloverId }) {
  return transitionMirror({
    root, executionId, store, rolloverId,
    toState: ROLLOVER_STATES.B_SPAWN_REQUESTED,
    mutate: () => {},
    eventPayload: { rollover_id: rolloverId },
  });
}

/**
 * Record the spawn receipt durably (B_STARTED_QUARANTINED) — C6 boundary.
 */
export async function recordSpawnReceipt({ root, executionId, store, rolloverId, candidate }) {
  return transitionMirror({
    root, executionId, store, rolloverId,
    toState: ROLLOVER_STATES.B_STARTED_QUARANTINED,
    mutate: (mirror) => {
      mirror.candidate = candidate;
    },
    eventPayload: { rollover_id: rolloverId, receipt_digest: candidate.spawnReceiptDigest },
  });
}

/**
 * Mark B_CHECKPOINT_VALIDATED (validation ladder passed; attestation bound).
 */
export async function recordValidationPassed({ root, executionId, store, rolloverId, validationDigest, observedRevision }) {
  return transitionMirror({
    root, executionId, store, rolloverId,
    toState: ROLLOVER_STATES.B_CHECKPOINT_VALIDATED,
    mutate: (mirror) => {
      mirror.validations = mirror.validations ?? {};
      mirror.validations[rolloverId] = { validationDigest, observedRevision, validatedAt: new Date().toISOString() };
    },
    eventPayload: { rollover_id: rolloverId },
  });
}

function ackStableDigestOrThrow(ack) {
  try {
    return deriveAckStableFieldDigest(ack);
  } catch (e) {
    throw new RolloverHoldError("CROSS_SESSION_ACK_INVALID", String(e?.message ?? e));
  }
}

/**
 * Publish THE durable ACK (B_READY_ACKED) — journal class rollover_ack +
 * snapshot mirror, atomically under the standard permit/lock/CAS (§10).
 * Idempotent over the STABLE FIELD SET; conflicting duplicate fails closed.
 */
export async function publishDurableAck({ root, executionId, store, rolloverId, ack }) {
  const { execDir, snapshot } = readCheckpoint(root, executionId);
  const mirror = requireActiveMirror(snapshot, rolloverId, { requireCurrent: true });
  const stableDigest = ackStableDigestOrThrow(ack);
  if (mirror.state === ROLLOVER_STATES.B_READY_ACKED || mirror.state === ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED || mirror.state === ROLLOVER_STATES.ACTIVE_B) {
    const existing = mirror.acks?.[rolloverId];
    if (existing && ackStableDigestOrThrow(existing) === stableDigest) {
      return { ok: true, idempotent: true }; // crash-republished ACK collapse (T73)
    }
    throw new RolloverHoldError("CROSS_SESSION_ACK_INVALID", "conflicting duplicate ACK (stable-field mismatch)");
  }
  if (mirror.state !== ROLLOVER_STATES.B_CHECKPOINT_VALIDATED) {
    throw new RolloverHoldError("CROSS_SESSION_ACK_INVALID", `ACK attempted from state ${mirror.state}`);
  }
  // T16 cross-adapter replay fence: the ACK's TARGET binding must be THE
  // durably recorded quarantine spawn candidate re-digested at g+1 (P1 over
  // mirror.candidate.identity) — NEVER a caller-minted identity. Without
  // this, an impostor/cross-adapter targetSessionIdentityDigest flows into
  // commitOwnershipTransfer and mints ownership for a session that was
  // never spawned nor validated.
  const intent = mirror.intents?.[rolloverId];
  const candidate = mirror.candidate;
  if (!intent || !candidate?.identity) {
    throw new RolloverHoldError("CROSS_SESSION_ACK_INVALID", "no durable intent/spawn candidate recorded for this rollover");
  }
  const gAck = intent.sourceGeneration;
  const candidateTargetDigest = sessionIdentityDigest({ ...candidate.identity, sessionGeneration: gAck + 1 });
  if (ack.targetSessionIdentityDigest !== candidateTargetDigest || ack.targetGeneration !== gAck + 1) {
    throw new RolloverHoldError("CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", "ACK target binding does not re-derive from the durable spawn candidate (impostor/cross-adapter replay)");
  }
  const full = { ...ack, readyAt: new Date().toISOString(), status: "READY" };
  await emitTransitionEvents(store, [[ROLLOVER_STATES.B_READY_ACKED, { rollover_id: rolloverId, ack_stable_digest: stableDigest }]]);
  await withLeaseCustody(execDir, snapshot, async (permit) => {
    const rev = (await journalTail(store, execDir)) + 1;
    const base = journalPairFields({ rev, snapshot, from: ROLLOVER_STATES.B_CHECKPOINT_VALIDATED, to: ROLLOVER_STATES.B_READY_ACKED, expectedRevisionBefore: snapshot.revision, sideEffectClass: "rollover_ack" });
    publishIntent(execDir, { ...base, record_kind: "intent", rollover_id: rolloverId }, permit);
    publishComplete(execDir, { ...base, record_kind: "complete", ack_stable_digest: stableDigest }, undefined, permit);
    noteJournalTail(store, rev);
  });
  await transitionMirror({
    root, executionId, store, rolloverId,
    toState: ROLLOVER_STATES.B_READY_ACKED,
    mutate: (m) => { m.acks[rolloverId] = full; },
    eventPayload: {},
  });
  return { ok: true, ack: full };
}

/**
 * Atomic ownership transfer (§13): ONE CAS publication from the ACK-mirror
 * head T (owner A@g, B_READY_ACKED) to T+1 (owner B@(g+1),
 * OWNERSHIP_TRANSFER_COMMITTED). Preconditions re-checked against the SAME
 * verified snapshot the CAS expects; a racing writer loses the CAS ⇒
 * CROSS_SESSION_OWNERSHIP_TRANSFER_FAILED (never dual-owner, T43/T54).
 */
export async function commitOwnershipTransfer({ root, executionId, store, rolloverId, rsl3PinCheck = null }) {
  const { execDir, snapshot } = readCheckpoint(root, executionId);
  const mirror = requireActiveMirror(snapshot, rolloverId, { requireCurrent: true });
  if (mirror.state === ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED || mirror.state === ROLLOVER_STATES.ACTIVE_B) {
    return { ok: true, idempotent: true, transfer: mirror.transfers[rolloverId] };
  }
  if (mirror.state !== ROLLOVER_STATES.B_READY_ACKED) {
    throw new RolloverHoldError("CROSS_SESSION_OWNERSHIP_TRANSFER_FAILED", `transfer precondition: state is ${mirror.state}, need B_READY_ACKED`);
  }
  const ack = mirror.acks?.[rolloverId];
  const intent = mirror.intents?.[rolloverId];
  if (!ack || !intent) throw new RolloverHoldError("CROSS_SESSION_OWNERSHIP_TRANSFER_FAILED", "ACK/intent missing at commit");
  if (rsl3PinCheck) {
    const r = rsl3PinCheck();
    if (!r.ok) throw new RolloverHoldError(r.code, r.reason);
  }
  const g = intent.sourceGeneration;
  const committedAt = new Date().toISOString();
  const transfer = {
    rolloverId,
    from: { sessionIdentityDigest: intent.sourceSessionIdentityDigest, sessionGeneration: g },
    to: { sessionIdentityDigest: ack.targetSessionIdentityDigest, sessionGeneration: g + 1 },
    checkpointRevision: snapshot.revision, // T = ACK-mirror head (chain pin)
    ackDigest: ackStableDigestOrThrow(ack),
    committedAt,
  };
  transfer.transferDigest = deriveTransferDigest(transfer);

  await emitTransitionEvents(store, [[ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED, { rollover_id: rolloverId, transfer_digest: transfer.transferDigest }]]);
  try {
    await withLeaseCustody(execDir, snapshot, async (permit) => {
      const rev = (await journalTail(store, execDir)) + 1;
      const base = journalPairFields({ rev, snapshot, from: ROLLOVER_STATES.B_READY_ACKED, to: ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED, expectedRevisionBefore: snapshot.revision, sideEffectClass: "rollover_transfer" });
      publishIntent(execDir, { ...base, record_kind: "intent", rollover_id: rolloverId }, permit);
      publishComplete(execDir, { ...base, record_kind: "complete", transfer_digest: transfer.transferDigest }, undefined, permit);
      noteJournalTail(store, rev);
    });
  } catch (e) {
    if (e instanceof RolloverHoldError) throw e;
    // A concurrent coordinator lost the custody window (lease contention):
    // fail closed on the FROZEN hold vocabulary — a later retry is lawful
    // and collapses idempotently once the winner's commit is visible.
    if (e instanceof C2dHoldError) {
      throw new RolloverHoldError("CROSS_SESSION_LEASE_CUSTODY_PENDING", `transfer custody window unavailable: ${String(e?.code ?? e?.message ?? e).slice(0, 160)}`);
    }
    throw e;
  }
  let pubOk = false;
  let pubErr = null;
  try {
    await transitionMirrorWithBase({
      baseSnapshot: snapshot, root, executionId, store, rolloverId,
      toState: ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED,
      mutate: (m) => {
        m.owner = { session_identity_digest: transfer.to.sessionIdentityDigest, session_generation: g + 1 };
        m.transfers[rolloverId] = transfer;
      },
      expectedRevision: snapshot.revision,
      eventPayload: {},
    });
    pubOk = true;
  } catch (e) {
    pubErr = e;
  }
  if (!pubOk) {
    throw new RolloverHoldError("CROSS_SESSION_OWNERSHIP_TRANSFER_FAILED", String(pubErr?.message ?? pubErr).slice(0, 200));
  }
  return { ok: true, transfer, fromGeneration: g, toGeneration: g + 1 };
}

/**
 * ACTIVE_B entry: published by the B-side runner immediately after the §13a
 * post-transfer fence passes at the resume entry (OWNERSHIP_TRANSFER_COMMITTED
 * → ACTIVE_B). Zero dispatches happen before this lands (INV-3 continues).
 */
export async function enterActiveB({ root, executionId, store, rolloverId }) {
  return transitionMirror({
    root, executionId, store, rolloverId,
    toState: ROLLOVER_STATES.ACTIVE_B,
    mutate: () => {},
    eventPayload: { rollover_id: rolloverId },
  });
}

/**
 * A retirement (§13): publishable ONLY when ACK ∧ transfer committed ∧
 * readCurrent owner == B@(g+1) ∧ B reconstruction verified upstream.
 */
export async function publishARetirement({ root, executionId, store, rolloverId }) {
  const { execDir, snapshot } = readCheckpoint(root, executionId);
  const mirror = requireActiveMirror(snapshot, rolloverId);
  if (mirror.state === ROLLOVER_STATES.A_RETIRED || mirror.state === ROLLOVER_STATES.A_RETIREMENT_CONFIRMED) {
    return { ok: true, idempotent: true };
  }
  const transfer = mirror.transfers?.[rolloverId];
  const ack = mirror.acks?.[rolloverId];
  if (!transfer || !ack) {
    throw new RolloverHoldError("CROSS_SESSION_RETIREMENT_INCOMPLETE", "transfer/ACK record missing");
  }
  if (mirror.state !== ROLLOVER_STATES.ACTIVE_B && mirror.state !== ROLLOVER_STATES.A_RETIREMENT_PENDING) {
    throw new RolloverHoldError("CROSS_SESSION_RETIREMENT_INCOMPLETE", `retirement attempted from state ${mirror.state}`);
  }
  if (mirror.owner?.session_generation !== transfer.to.sessionGeneration) {
    throw new RolloverHoldError("CROSS_SESSION_RETIREMENT_INCOMPLETE", "owner-of-record is not the transferred successor");
  }
  const retiredAt = new Date().toISOString();
  const retirement = {
    rolloverId,
    source: { sessionIdentityDigest: transfer.from.sessionIdentityDigest, generation: transfer.from.sessionGeneration },
    successor: { sessionIdentityDigest: transfer.to.sessionIdentityDigest, generation: transfer.to.sessionGeneration },
    ownershipTransferDigest: transfer.transferDigest,
    retiredAt,
  };
  retirement.retirementDigest = deriveRetirementDigest(retirement);
  await emitTransitionEvents(store, [[ROLLOVER_STATES.A_RETIRED, { rollover_id: rolloverId }]]);
  await withLeaseCustody(execDir, snapshot, async (permit) => {
    const rev = (await journalTail(store, execDir)) + 1;
    const base = journalPairFields({ rev, snapshot, from: mirror.state, to: ROLLOVER_STATES.A_RETIRED, expectedRevisionBefore: snapshot.revision, sideEffectClass: "rollover_retirement" });
    publishIntent(execDir, { ...base, record_kind: "intent", rollover_id: rolloverId }, permit);
    publishComplete(execDir, { ...base, record_kind: "complete", retirement_digest: retirement.retirementDigest }, undefined, permit);
    noteJournalTail(store, rev);
  });
  await transitionMirror({
    root, executionId, store, rolloverId,
    toState: ROLLOVER_STATES.A_RETIRED,
    relaxCurrent: true, // closed-era duplicate retries hit the idempotent gate above first
    mutate: (m) => {
      m.retirements[rolloverId] = retirement;
      m.last_rollover_id = rolloverId;
      m.active_rollover_id = null; // rollover closed
    },
    eventPayload: {},
  });
  return { ok: true, retirement };
}

/**
 * Abort before transfer (trigger invalidation / cancel / spawn failure /
 * validation failure / ACK timeout). Owner stays A@g (G1). Post-transfer
 * failures can NEVER abort (commit point singular).
 */
export async function abortRolloverPreTransfer({ root, executionId, store, rolloverId, reasonCode }) {
  const { execDir, snapshot } = readCheckpoint(root, executionId);
  const mirror = snapshot.graph?.rollover ?? null;
  if (!mirror || !mirror.active_rollover_id) return { ok: true, idempotent: true };
  if (POST_COMMIT_SET.has(mirror.state)) {
    throw new RolloverHoldError("CROSS_SESSION_RECONCILIATION_REQUIRED", "post-transfer failure cannot abort (G1 commit point)");
  }
  await emitTransitionEvents(store, [[ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER, { rollover_id: rolloverId, reason: reasonCode }]]);
  await withLeaseCustody(execDir, snapshot, async (permit) => {
    const rev = (await journalTail(store, execDir)) + 1;
    const base = journalPairFields({ rev, snapshot, from: mirror.state, to: ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER, expectedRevisionBefore: snapshot.revision, sideEffectClass: "rollover_abort" });
    publishIntent(execDir, { ...base, record_kind: "intent", rollover_id: rolloverId, reason_code: reasonCode }, permit);
    publishComplete(execDir, { ...base, record_kind: "complete", reason_code: reasonCode }, undefined, permit);
    noteJournalTail(store, rev);
  });
  await transitionMirror({
    root, executionId, store, rolloverId,
    toState: ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER,
    mutate: (m) => {
      if (m.intents[m.active_rollover_id]) m.intents[m.active_rollover_id].status = "ABORTED";
      m.abortReason = reasonCode;
      m.last_rollover_id = m.active_rollover_id;
      m.active_rollover_id = null;
    },
    eventPayload: {},
  });
  return { ok: true };
}

// ── internals ─────────────────────────────────────────────────────────────

function decisionDigestOf(triggerEvent) {
  return deriveAuthorityDecisionDigest({
    trigger: triggerEvent.trigger,
    source: triggerEvent.source,
    observedFact: triggerEvent.observedFact ?? null,
    freshness: triggerEvent.freshness,
    decisionRef: triggerEvent.authorityDecisionRef,
  });
}

function mintRolloverId({ triggerEvent, D_adm, sourceIdentity, targetAdapterKind, targetProviderKind, admission, graphIdentity, toolSelectionCommitmentDigest, budgetStateDigest, lifecycleStateDigest, H, Hd }) {
  return deriveRolloverId({
    schemaVersion: 1,
    sourceSessionIdentityDigest: sessionIdentityDigest(sourceIdentity),
    sourceGeneration: sourceIdentity.sessionGeneration,
    targetAdapterKind,
    targetProviderKind,
    trigger: triggerEvent.trigger,
    authorityDecisionDigest: D_adm,
    taskIdentity: String(triggerEvent.taskIdentity),
    runIdentity: String(triggerEvent.runIdentity),
    admissionIdentity: String(admission?.admission_id ?? triggerEvent.admissionIdentity),
    graphIdentity: graphIdentity ?? null,
    budgetIdentity: budgetStateDigest ?? null,
    checkpointRevision: H,
    checkpointDigest: Hd,
    toolSelectionCommitmentDigest: toolSelectionCommitmentDigest ?? null,
    budgetStateDigest: budgetStateDigest ?? null,
    lifecycleStateDigest: lifecycleStateDigest ?? null,
    expectedTargetGeneration: sourceIdentity.sessionGeneration + 1,
  });
}

async function transitionMirror({ root, executionId, store, rolloverId, toState, mutate, eventPayload, relaxCurrent = false }) {
  const { snapshot } = readCheckpoint(root, executionId);
  // Pre-commit transitions are lawful only for THE active rollover (P1-1).
  if (!relaxCurrent) {
    const mirror0 = requireActiveMirror(snapshot, rolloverId, { requireCurrent: true });
    void mirror0;
  }
  return transitionMirrorWithBase({
    baseSnapshot: snapshot, root, executionId, store, rolloverId,
    toState, mutate, expectedRevision: snapshot.revision, eventPayload,
  });
}

async function transitionMirrorWithBase({ baseSnapshot, root, executionId, store, rolloverId, toState, mutate, expectedRevision, eventPayload }) {
  const mirror = requireActiveMirror(baseSnapshot, rolloverId);
  if (!isLegalRolloverTransition(mirror.state, toState)) {
    throw new RolloverHoldError("CROSS_SESSION_RECONCILIATION_REQUIRED", `illegal transition ${mirror.state} → ${toState}`);
  }
  const next = mirrorFrom(mirror);
  mutate(next);
  next.state = toState;
  await publishMirror({ root, executionId, store, prior: baseSnapshot, mirror: next, expectedRevision, eventPayload });
  return next;
}

async function publishMirror({ root, executionId, store, prior, mirror, expectedRevision }) {
  const pub = await publishCheckpoint({
    root,
    executionId,
    chainId: prior.chain_id,
    checkpointId: prior.checkpoint_id,
    repositoryFingerprint: prior.repository_fingerprint,
    inputFingerprint: prior.input_fingerprint,
    configurationFingerprint: prior.configuration_fingerprint,
    irSha: prior.decomposition_ir_sha256,
    dagSha: prior.dag_sha256,
    journalHead: store.journalHead,
    phaseStates: prior.phase_states ?? {},
    phaseAttempts: prior.phase_attempts ?? {},
    phaseResultHashes: prior.phase_result_hashes ?? {},
    completedPhaseIds: prior.completed_phase_ids ?? [],
    activePhase: prior.active_phase ?? null,
    activeLifecycleStage: prior.active_lifecycle_stage ?? null,
    writerPhaseActive: prior.writer_phase_active === true,
    writerLeaseHolder: prior.writer_lease_holder ?? null,
    finalVerdict: prior.final_verdict ?? null,
    resumePolicy: prior.resume_policy ?? { safe_boundary: true, interrupted_writer: false },
    expectedRevision,
    actorId: ROLLOVER_ACTOR,
    created_at: prior.created_at,
    snapshotOverrides: {
      // Preserve EVERY other additive graph field byte-for-byte (continuity):
      graph: { ...(prior.graph ?? {}), rollover: mirror },
    },
  });
  store.appendEvent({
    event_type: "ROLLOVER_MIRROR_PUBLISHED",
    stage: "rollover",
    payload: {
      revision: pub.revision,
      digest: pub.digest,
      rollover_state: mirror.state,
      telemetry_token: rolloverTelemetryToken(mirror.state),
    },
  });
  return pub;
}

async function withLeaseCustody(execDir, snapshot, fn) {
  let acquired = null;
  try {
    acquired = acquireLease(execDir, {
      execution_id: snapshot.execution_id,
      chain_id: snapshot.chain_id,
      checkpoint_id: snapshot.checkpoint_id,
      repository_identity: snapshot.repository_root_identity,
      worktree_identity: snapshot.repository_fingerprint?.worktree_identity,
      actor_id: ROLLOVER_ACTOR,
      expected_head: snapshot.expected_head,
      mutation_capability: false,
      role: "autoloop-rollover",
    });
    const permit = permitFromLease(execDir, acquired.lease, acquired.secrets, false);
    return await fn(permit, acquired);
  } finally {
    if (acquired) {
      try { releaseLease(execDir, acquired.lease.lease_id, acquired.lease.lease_revision, acquired.secrets); } catch { /* fail-closed on next acquire */ }
    }
  }
}

/** Gapless C2D journal tail (tracked per-store; falls back to disk truth). */
async function journalTail(store, execDir) {
  if (store && Number.isInteger(store.rolloverJournalTail)) return store.rolloverJournalTail;
  const cont = rolloverClassContinuity(execDir);
  return cont.lastComplete;
}

function noteJournalTail(store, rev) {
  store.rolloverJournalTail = rev;
}

function journalPairFields({ rev, snapshot, from, to, expectedRevisionBefore, sideEffectClass }) {
  return {
    revision: rev,
    transition_id: `rollover_${rev}_${sideEffectClass}`,
    execution_id: snapshot.execution_id,
    checkpoint_id: snapshot.checkpoint_id,
    chain_id: snapshot.chain_id,
    from_stage: "ROLLOVER",
    to_stage: "ROLLOVER",
    from_state: from,
    to_state: to,
    expected_revision_before: expectedRevisionBefore,
    side_effect_class: sideEffectClass,
  };
}

function requireActiveMirror(snapshot, rolloverId, { requireCurrent = false } = {}) {
  const mirror = snapshot.graph?.rollover ?? null;
  if (!mirror || typeof mirror !== "object") {
    throw new RolloverHoldError("CROSS_SESSION_ROLLOVER_INTENT_MISSING", "no graph.rollover block on CURRENT");
  }
  if (mirror.schema !== "autoloop.rollover/v1") {
    throw new RolloverHoldError("CROSS_SESSION_ROLLOVER_SCHEMA_UNSUPPORTED", String(mirror.schema));
  }
  // ADV-REVIEW P1-1 fence: ACK/spawn/validation operations are lawful ONLY
  // for THE currently active rolloverId — a stale/aborted id must never
  // ride the active candidate's durable bindings (K7/T18 family).
  const closedEra = mirror.state === ROLLOVER_STATES.A_RETIRED || mirror.state === ROLLOVER_STATES.A_RETIREMENT_CONFIRMED;
  if (requireCurrent && !closedEra && rolloverId && mirror.active_rollover_id !== rolloverId) {
    throw new RolloverHoldError(
      mirror.intents?.[rolloverId] ? "CROSS_SESSION_ACK_REPLAYED" : "CROSS_SESSION_ACK_INVALID",
      `stale rolloverId ${rolloverId} is not the active rollover`,
    );
  }
  return mirror;
}

async function emitTransitionEvents(store, pairs) {
  for (const [state, payload] of pairs) {
    store.appendEvent({
      event_type: "ROLLOVER_STATE_TRANSITION",
      stage: "rollover",
      payload: { state, telemetry_token: rolloverTelemetryToken(state), ...payload },
    });
  }
}

function mirrorFrom(rollover) {
  const base = rollover && typeof rollover === "object"
    ? rollover
    : emptyRolloverBlock();
  return {
    ...emptyRolloverBlock(),
    ...base,
    intents: { ...(base.intents ?? {}) },
    acks: { ...(base.acks ?? {}) },
    transfers: { ...(base.transfers ?? {}) },
    retirements: { ...(base.retirements ?? {}) },
  };
}

const ROLLOVER_TERMINAL_SET = new Set([
  ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER,
  ROLLOVER_STATES.A_RETIRED,
]);

const POST_COMMIT_SET = new Set([
  ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED,
  ROLLOVER_STATES.ACTIVE_B,
  ROLLOVER_STATES.A_RETIREMENT_PENDING,
]);

/**
 * Continuity scan restricted to the C2D journal NAMESPACE
 * (`<rev>.intent.json` / `<rev>.complete.json`). The same directory also
 * carries the append-only EVIDENCE journal (`<seq>.json`, RunEvidenceStore);
 * the shared-directory layout means the generic validator cannot be pointed
 * at this path directly. Same semantics as c2d/journal.validateContinuity:
 * gapless from 1, complete-tail detection — used ONLY for the §7 safe-point
 * proof and the T75 ordering pin (no INTENT row beyond lastComplete).
 */
function rolloverClassContinuity(execDir) {
  let names = [];
  try { names = readdirSync(join(execDir, "journal")); } catch { return { lastComplete: 0, incompleteTail: null }; }
  const rows = new Map();
  for (const n of names) {
    const m = n.match(/^(\d{12})\.(intent|complete)\.json$/);
    if (!m) continue; // evidence-journal rows live in a different namespace
    const rev = parseInt(m[1], 10);
    if (!rows.has(rev)) rows.set(rev, {});
    rows.get(rev)[m[2]] = true;
  }
  const keys = [...rows.keys()].sort((a, b) => a - b);
  if (keys.length === 0) return { lastComplete: 0, incompleteTail: null };
  if (keys[0] !== 1) throw new RolloverHoldError("CROSS_SESSION_ROLLOVER_SAFE_POINT_UNAVAILABLE", `first C2D revision must be 1, got ${keys[0]}`);
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] !== keys[i - 1] + 1) {
      throw new RolloverHoldError("CROSS_SESSION_ROLLOVER_SAFE_POINT_UNAVAILABLE", `C2D journal gap at ${keys[i]}`);
    }
  }
  const last = keys[keys.length - 1];
  if (rows.get(last).complete) return { lastComplete: last, incompleteTail: null };
  const lastComplete = keys.filter((r) => rows.get(r).complete).pop() ?? 0;
  return { lastComplete, incompleteTail: last };
}
