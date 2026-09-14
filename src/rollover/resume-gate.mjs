// src/rollover/resume-gate.mjs
//
// STAGE D — THE durable cross-session dispatch pre-step (CONTRACT §9a) and
// the post-transfer resume fence (CONTRACT §13a).
//
// §9a: EVERY resume entry reads graph.rollover.state from the checksummed
// CURRENT FIRST. While an ACTIVE rollover freezes the owner-of-record, ALL
// phase dispatch is refused — zero adapter invocations, zero budget events —
// regardless of owner-match (closes the freeze→commit window against
// second/restarted processes driving A through the unmodified public entry).
//
// §13a: after commit, B may resume ONLY through this five-part fence:
//   1. readCurrent owner == B@(g+1)
//   2. state ∈ {OWNERSHIP_TRANSFER_COMMITTED, ACTIVE_B}
//   3. transfers[active_rollover_id] present, P4 digest recomputes byte-
//      exactly, embedded ackDigest matches the pinned ACK stable-field digest
//   4. revocation re-check over pinned evidence/authorities
//   5. then the standard ladder steps 1-3 and 6-12 re-run against the chain
//      pins (steps 4-5 of the pre-commit ladder are NOT re-run — the owner
//      has changed by design)
// Steps 4-5 live in quarantine-validation.mjs / the caller's admission
// re-verification; this module performs 1-3 and exposes the verdict.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRevocationLedger } from "../governance/truth-revocation-store.mjs";
import { RolloverHoldError } from "./rollover-controller.mjs";
import {
  ACTIVE_PRE_COMMIT_ROLLOVER_STATES,
  POST_COMMIT_ROLLOVER_STATES,
  CLOSED_ERA_POST_TRANSFER_STATES,
  ROLLOVER_HOLD_STATES,
  ROLLOVER_ABORTED_STATES,
  ROLLOVER_STATES,
  deriveTransferDigest,
  deriveAckStableFieldDigest,
} from "./rollover-authority.mjs";

/**
 * Evaluate the cross-session resume gate against ONE verified snapshot.
 *
 * @param {object} p
 * @param {object} p.snapshot — checksum-verified CURRENT snapshot
 * @param {object|null} p.sessionBinding — caller's rollover session binding
 *   { sessionIdentityDigest, sessionGeneration } (minted by the coordinator
 *   for B; NEVER accepted as authority by itself — it only SELECTS which
 *   durable-truth branch applies, every check below is against CURRENT).
 * @returns {{ action: "PROCEED" } | { action: "REFUSE", code, reason }}
 */
export function evaluateCrossSessionResumeGate({ snapshot, sessionBinding = null, execDir = null }) {
  const rollover = snapshot.graph?.rollover ?? null;
  // No rollover block ⇒ legacy same-session semantics UNCHANGED (§14).
  if (!rollover || typeof rollover !== "object") return { action: "PROCEED" };
  if (rollover.schema !== "autoloop.rollover/v1") {
    return refuse("CROSS_SESSION_ROLLOVER_SCHEMA_UNSUPPORTED", String(rollover.schema));
  }

  const state = rollover.state;

  // ── Active pre-commit rollover: EVERYONE is fenced (A-frozen world) ────
  if (ACTIVE_PRE_COMMIT_ROLLOVER_STATES.has(state)) {
    return refuse("CROSS_SESSION_ROLLOVER_IN_PROGRESS_A_FROZEN",
      `durable rollover ${rollover.active_rollover_id ?? "?"} active in state ${state}; owner-of-record frozen`);
  }

  // ── Post-commit: only the transferred owner may proceed ─────────────────
  if (POST_COMMIT_ROLLOVER_STATES.has(state) || CLOSED_ERA_POST_TRANSFER_STATES.has(state)) {
    // REPAIR-1: retirement clears active_rollover_id; the closed-era durable
    // truth keeps the SAME transfer/ACK records under last_rollover_id.
    const closedEra = CLOSED_ERA_POST_TRANSFER_STATES.has(state);
    const transferId = rollover.active_rollover_id ?? (closedEra ? rollover.last_rollover_id : null);
    const transfer = rollover.transfers?.[transferId];
    if (!transferId || !transfer) {
      return refuse("CROSS_SESSION_DUAL_OWNER_FENCED", "post-commit state without a durable transfer record (poisoned store)");
    }
    // Fence part 3: P4 digest recomputes byte-exactly.
    let recomputed;
    try {
      const { transferDigest, ...rest } = transfer;
      recomputed = deriveTransferDigest(rest);
    } catch (e) {
      return refuse("CROSS_SESSION_RECONCILIATION_REQUIRED", `transfer record unreadable: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    if (recomputed !== transfer.transferDigest) {
      return refuse("CROSS_SESSION_RECONCILIATION_REQUIRED", "ownership transfer digest does not recompute (altered record)");
    }
    // Fence part 3b: embedded ackDigest matches the pinned ACK stable fields.
    const ack = rollover.acks?.[transferId];
    if (!ack) {
      return refuse("CROSS_SESSION_ACK_MISSING", "post-commit state lost its pinned ACK");
    }
    if (deriveAckStableFieldDigest(ack) !== transfer.ackDigest) {
      return refuse("CROSS_SESSION_ACK_INVALID", "pinned ACK stable-field digest does not match the transfer record");
    }
    // Fence parts 1-2: the resuming caller must BE the durable successor.
    const owner = rollover.owner ?? {};
    if (!sessionBinding || typeof sessionBinding !== "object") {
      return refuse("CROSS_SESSION_STALE_SOURCE_FENCED", "post-commit resume requires the successor session binding");
    }
    if (sessionBinding.sessionIdentityDigest !== owner.session_identity_digest ||
        sessionBinding.sessionGeneration !== owner.session_generation) {
      return refuse("CROSS_SESSION_STALE_SOURCE_FENCED",
        `resume binding ${String(sessionBinding.sessionIdentityDigest)?.slice(0, 12)}…@${String(sessionBinding.sessionGeneration)} != durable owner @${owner.session_generation}`);
    }
    // Fence part 4 (CONTRACT §13a): post-transfer revocation re-check over
    // the execution's durable revocation ledger — fail closed.
    if (execDir) {
      const ledgerDir = join(execDir, "truth-revocations");
      const rev = readRevocationLedger(existsSync(ledgerDir) ? ledgerDir : null);
      if (!rev.ok) return refuse("CROSS_SESSION_REVOCATION_OBSERVED", "revocation ledger unreadable at post-transfer gate");
      const blobIds = [transferId, owner.session_identity_digest, snapshot.execution_id];
      const applies = rev.events.filter((e) => {
        const blob = JSON.stringify(e.subjects ?? e ?? {});
        return blobIds.some((id) => id && blob.includes(String(id)));
      });
      if (applies.length > 0) {
        return refuse("CROSS_SESSION_REVOCATION_OBSERVED", `${applies.length} revocation(s) apply to the transferred authority`);
      }
    }
    if (state === ROLLOVER_STATES.A_RETIREMENT_PENDING) {
      return refuse("CROSS_SESSION_RETIREMENT_INCOMPLETE", "retirement record pending (C15/C16 window); reconciler must close it first");
    }
    // Closed-era states are POST-TRANSFER: identity enforcement never closes
    // with the era (INV-2). A successful closed-era resume is owner-validated
    // against the durable owner-of-record via the SAME five-part fence above.
    if (CLOSED_ERA_POST_TRANSFER_STATES.has(state)) {
      return { action: "PROCEED", postTransfer: true, closed: true, ownerValidated: true, rolloverId: transferId };
    }
    return { action: "PROCEED", postTransfer: true, rolloverId: transferId };
  }

  // ── Aborted: owner still A; same-session semantics restored ─────────────
  if (ROLLOVER_ABORTED_STATES.has(state)) {
    if (sessionBinding && rollover.owner && sessionBinding.sessionGeneration !== undefined &&
        sessionBinding.sessionGeneration !== rollover.owner.session_generation) {
      return refuse("CROSS_SESSION_GENERATION_MISMATCH", "binding generation predates the aborted rollover's owner");
    }
    return { action: "PROCEED", postTransfer: false };
  }

  // ── Hold / reconciliation states: fail closed ────────────────────────────
  if (ROLLOVER_HOLD_STATES.has(state)) {
    return refuse("CROSS_SESSION_RECONCILIATION_REQUIRED", `rollover state ${state}`);
  }
  if (state === ROLLOVER_STATES.ACTIVE_A) {
    return { action: "PROCEED", postTransfer: false };
  }
  return refuse("CROSS_SESSION_RECONCILIATION_REQUIRED", `unknown rollover state ${String(state)}`);
}

function refuse(code, reason) {
  return { action: "REFUSE", code, reason };
}

/**
 * STAGE-D CLOSED-ERA RESUME BINDING REPAIR-1 — the single post-transfer
 * terminal/RSL3 publication ownership decision (defense in depth; INV-2).
 *
 * Even if a caller reaches the terminal/publication seam without passing
 * THE resume gate, publication is lawful ONLY when the durable CURRENT
 * snapshot's post-transfer state is paired with a sessionBinding that THE
 * gate validates against the durable owner-of-record. State alone never
 * authorizes; binding alone never authorizes.
 *
 * @returns {{ action: "PROCEED" } | { action: "REFUSE", code, reason }}
 */
export function evaluatePostTransferPublicationAuthority({ snapshot, sessionBinding = null, execDir = null }) {
  const rollover = snapshot?.graph?.rollover ?? null;
  const state = rollover?.state ?? null;
  const postTransfer = POST_COMMIT_ROLLOVER_STATES.has(state) || CLOSED_ERA_POST_TRANSFER_STATES.has(state);
  if (!postTransfer) {
    // ADV-R1 hardening: a durable rollover block with an UNKNOWN state token
    // never defaults open — fail closed like THE gate's unknown-state branch.
    if (rollover && typeof rollover === "object" && rollover.schema === "autoloop.rollover/v1" &&
        state !== ROLLOVER_STATES.ACTIVE_A &&
        !ACTIVE_PRE_COMMIT_ROLLOVER_STATES.has(state) &&
        !ROLLOVER_ABORTED_STATES.has(state) &&
        !ROLLOVER_HOLD_STATES.has(state)) {
      return refuse("CROSS_SESSION_RECONCILIATION_REQUIRED", `unknown rollover state ${String(state)}`);
    }
    return { action: "PROCEED" };
  }
  // THE one gate — never a forked decision.
  return evaluateCrossSessionResumeGate({ snapshot, sessionBinding, execDir });
}

export function throwOnRefusal(verdict) {
  if (verdict.action === "REFUSE") {
    throw new DurableGateError(verdict.code, verdict.reason);
  }
  return verdict;
}

export class DurableGateError extends RolloverHoldError {}
