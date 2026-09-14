// src/memory/writeback/trust.mjs
//
// CBM-4 — Stage 4: trust transition rules.
//
// CBM-2 ladder: RAW(0) < UNVERIFIED(1) < VERIFIED(2) < REVIEWED(3) < CONFIRMED(4).
// Rules:
//   - writer / executor propose candidates（never self-promote）: their origin
//     caps the WRITE-BACK trust at UNVERIFIED（candidate may be stored as
//     RAW/UNVERIFIED, never higher on the writer's own authority）
//   - verifier-backed fact: VERIFIED only when the verifier evidence identity
//     is bound correctly
//   - independent reviewer-backed fact: REVIEWED only when review PASS +
//     blockingFindings=[] + verifiable review identity
//   - CONFIRMED: Controller / highest authority only — CBM-4 NEVER auto-writes
//     CONFIRMED（a proposedTrust CONFIRMED is rejected by the contract）
//   - skip-level promotion fails closed（never RAW -> REVIEWED without the
//     intermediate evidence gates）

import { TRUST_STATES, TRUST_RANK } from "../contract.mjs";
import { WRITEBACK_ORIGINS } from "./candidate.mjs";

export const WRITEBACK_TRUST_HOLD = Object.freeze({
  SELF_PROMOTION: "WRITEBACK_SELF_PROMOTION_REJECTED",
  SKIP_LEVEL: "WRITEBACK_SKIP_LEVEL_PROMOTION_REJECTED",
  CONFIRMED_NOT_AUTOMATIC: "WRITEBACK_CONFIRMED_NOT_AUTOMATIC",
  EVIDENCE_MISSING: "WRITEBACK_EVIDENCE_MISSING",
  // CBM-4 trust-boundary hardening（external review round）: an evidence
  // identity is ONLY trustworthy when it is bound to the graph/task's
  // CANONICAL evidence inventory — a well-formed 64-hex digest that is not
  // attested by the graph（forged / from another graph or card）fails closed.
  EVIDENCE_INVENTORY_REQUIRED: "WRITEBACK_EVIDENCE_INVENTORY_REQUIRED",
  EVIDENCE_GRAPH_MISMATCH: "WRITEBACK_EVIDENCE_GRAPH_MISMATCH",
  EVIDENCE_CARD_MISMATCH: "WRITEBACK_EVIDENCE_CARD_MISMATCH",
  EVIDENCE_IDENTITY_MALFORMED: "WRITEBACK_EVIDENCE_IDENTITY_MALFORMED",
  EVIDENCE_IDENTITY_FORGED: "WRITEBACK_EVIDENCE_IDENTITY_FORGED",
});

// Canonical evidence result identities are sha256 digests（64-hex）.
const RESULT_IDENTITY_RE = /^[0-9a-f]{64}$/;

/**
 * CBM-4 trust-boundary hardening: bind verifier / reviewer evidence
 * identities to the graph/task's CANONICAL evidence inventory.
 *
 * Format is necessary but NOT sufficient — a well-formed 64-hex digest that
 * the graph never produced（forged）or that belongs to ANOTHER graph/card is
 * rejected. Every candidate claiming VERIFIED/REVIEWED trust must be judged
 * against the inventory the graph itself can attest（node result identities,
 * review result identities, closeout bundle digest）; without an inventory
 * the gate FAILS CLOSED（never falls back to "looks like hex, accept"）.
 *
 * @param {object} o
 * @param {string} o.proposedTrust - UNVERIFIED | VERIFIED | REVIEWED
 * @param {string|null} o.verifierIdentity - claimed verifier result identity
 * @param {string|null} o.reviewIdentity - claimed review result identity
 * @param {object|null} o.candidate - the candidate（graphRunId / taskCardId binding）
 * @param {object|null} o.canonicalEvidence - {
 *   graphRunId, taskCardIds: string[], resultIdentities: string[],
 *   verifierIdentities: string[], reviewIdentities: string[] }
 * @returns {{ ok: boolean, holdCode: string|null, reason: string|null }}
 */
export function checkEvidenceIdentity({ proposedTrust, verifierIdentity = null, reviewIdentity = null, candidate = null, canonicalEvidence = null } = {}) {
  // RAW / UNVERIFIED records carry no verifier/reviewer identity claim.
  if (proposedTrust === "UNVERIFIED") return { ok: true, holdCode: null, reason: null };
  // Cannot bind to an inventory we do not have — fail closed（never accept a
  // VERIFIED/REVIEWED claim on format alone）.
  if (!canonicalEvidence || typeof canonicalEvidence !== "object") {
    return { ok: false, holdCode: WRITEBACK_TRUST_HOLD.EVIDENCE_INVENTORY_REQUIRED, reason: "VERIFIED/REVIEWED requires the graph's canonical evidence inventory binding" };
  }
  // graph binding: the candidate must be written for the SAME graph the
  // inventory was derived from（an identity canonical for another graph is
  // forged in this context）.
  if (candidate && canonicalEvidence.graphRunId && candidate.graphRunId && candidate.graphRunId !== canonicalEvidence.graphRunId) {
    return { ok: false, holdCode: WRITEBACK_TRUST_HOLD.EVIDENCE_GRAPH_MISMATCH, reason: `evidence_other_graph:${candidate.graphRunId}!=${canonicalEvidence.graphRunId}` };
  }
  const cardIds = Array.isArray(canonicalEvidence.taskCardIds) ? canonicalEvidence.taskCardIds : [];
  if (candidate && cardIds.length > 0 && candidate.taskCardId && !cardIds.includes(candidate.taskCardId)) {
    return { ok: false, holdCode: WRITEBACK_TRUST_HOLD.EVIDENCE_CARD_MISMATCH, reason: `evidence_other_card:${candidate.taskCardId} not attested by this graph` };
  }
  const inventory = Array.isArray(canonicalEvidence.resultIdentities) ? canonicalEvidence.resultIdentities : [];
  const requireBound = (kind, id) => {
    if (!id) return { ok: false, holdCode: WRITEBACK_TRUST_HOLD.SKIP_LEVEL, reason: `${kind} evidence identity missing` };
    if (!RESULT_IDENTITY_RE.test(id)) {
      return { ok: false, holdCode: WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_MALFORMED, reason: `${kind}_identity_malformed:${id.slice(0, 16)}…` };
    }
    if (!inventory.includes(id)) {
      return { ok: false, holdCode: WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_FORGED, reason: `${kind}_identity_not_in_canonical_inventory:${id.slice(0, 16)}…（well-formed but not attested by this graph/task）` };
    }
    return { ok: true, holdCode: null, reason: null };
  };
  if (proposedTrust === "VERIFIED") {
    const v = requireBound("verifier", verifierIdentity);
    if (!v.ok) return v;
  }
  if (proposedTrust === "REVIEWED") {
    if (verifierIdentity) {
      const v = requireBound("verifier", verifierIdentity);
      if (!v.ok) return v;
    }
    const r = requireBound("review", reviewIdentity);
    if (!r.ok) return r;
  }
  return { ok: true, holdCode: null, reason: null };
}

// origin -> the highest trust that origin's authority may grant in write-back
export const ORIGIN_TRUST_CEILING = Object.freeze({
  controller: "CONFIRMED",          // only explicit controller authority may pass
  independent_reviewer: "REVIEWED",
  verifier: "VERIFIED",
  graph_closeout: "REVIEWED",       // closeout gate may bind REVIEWED facts
  writer: "UNVERIFIED",
  executor: "UNVERIFIED",
});

// R2 PATTERN trust-ladder mapping row ([CT §5] structural mapping, ONE
// additive row — ladder codes and hold codes unchanged and still enforced):
//   CANDIDATE ≈ RAW/UNVERIFIED · ADVISORY ≈ VERIFIED ·
//   REQUIRED_QUESTION ≈ REVIEWED · MANDATORY_GATE ≈ CONFIRMED (Controller-only)
// R2 stores PATTERNs at the trust their evidence supports; there is NO
// automatic upward mapping and NO §5 lifecycle edge inside R2
// (R2_MAY_PROMOTE = NO; ceiling for any R2 write path is VERIFIED).
export const PATTERN_TRUST_LADDER_MAPPING = Object.freeze({
  CANDIDATE: ["RAW", "UNVERIFIED"],
  ADVISORY: ["VERIFIED"],
  REQUIRED_QUESTION: ["REVIEWED"],
  MANDATORY_GATE: ["CONFIRMED"],   // Controller-only; never automatic (unchanged rule)
  R2_WRITE_CEILING: "VERIFIED",    // R2 write paths never exceed VERIFIED
});

/**
 * Check a candidate's proposed trust against its origin's authority ceiling.
 * Returns { ok, holdCode?, reason? }.
 */
export function checkTrustCeiling({ origin, proposedTrust }) {
  if (!WRITEBACK_ORIGINS.includes(origin)) {
    return { ok: false, holdCode: "WRITEBACK_ORIGIN_UNKNOWN", reason: `origin_unknown:${origin}` };
  }
  const ceiling = ORIGIN_TRUST_CEILING[origin] ?? "UNVERIFIED";
  if (proposedTrust === "CONFIRMED") {
    return { ok: false, holdCode: WRITEBACK_TRUST_HOLD.CONFIRMED_NOT_AUTOMATIC, reason: "CONFIRMED is Controller-only; CBM-4 never auto-writes CONFIRMED" };
  }
  if (TRUST_RANK[proposedTrust] > TRUST_RANK[ceiling]) {
    return {
      ok: false,
      holdCode: WRITEBACK_TRUST_HOLD.SELF_PROMOTION,
      reason: `self_promotion:${origin} cannot grant ${proposedTrust}（ceiling ${ceiling}）`,
    };
  }
  return { ok: true, holdCode: null, reason: null };
}

/**
 * Verify a skip-level promotion would have passed through the ladder.
 * A candidate reaching VERIFIED must have a verifier-bound evidence ref;
 * REVIEWED must have a review-bound evidence ref. RAW->VERIFIED without the
 * intermediate gates fails closed.
 */
export function checkLadderProgression({ proposedTrust, evidenceReferences = [], reviewIdentity = null, verifierIdentity = null }) {
  const refs = Array.isArray(evidenceReferences) ? evidenceReferences : [];
  if (proposedTrust === "UNVERIFIED") return { ok: true };
  if (proposedTrust === "VERIFIED") {
    const verifierBound = Boolean(verifierIdentity) && refs.some((r) => String(r).includes(verifierIdentity) || String(r).includes("verifier"));
    if (!verifierBound) {
      return { ok: false, holdCode: WRITEBACK_TRUST_HOLD.SKIP_LEVEL, reason: "VERIFIED requires a verifier-bound evidence identity" };
    }
    return { ok: true };
  }
  if (proposedTrust === "REVIEWED") {
    const reviewBound = Boolean(reviewIdentity) && refs.some((r) => String(r).includes(reviewIdentity) || String(r).includes("review"));
    if (!reviewBound) {
      return { ok: false, holdCode: WRITEBACK_TRUST_HOLD.SKIP_LEVEL, reason: "REVIEWED requires an independent-review evidence identity" };
    }
    return { ok: true };
  }
  return { ok: false, holdCode: WRITEBACK_TRUST_HOLD.CONFIRMED_NOT_AUTOMATIC, reason: "CONFIRMED not automatic" };
}

export { TRUST_STATES, TRUST_RANK };
