// test/memory/test-writeback-trust.mjs
//
// CBM-4 Stage 4 — trust transition rules: no self-promotion, skip-level
// promotion fails closed, CONFIRMED is Controller-only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTrustCeiling, checkLadderProgression, checkEvidenceIdentity, ORIGIN_TRUST_CEILING, WRITEBACK_TRUST_HOLD } from "../../src/memory/writeback/trust.mjs";

test("1. writer / executor can never self-promote above UNVERIFIED", () => {
  const w = checkTrustCeiling({ origin: "writer", proposedTrust: "VERIFIED" });
  assert.equal(w.ok, false);
  assert.equal(w.holdCode, WRITEBACK_TRUST_HOLD.SELF_PROMOTION);
  assert.ok(checkTrustCeiling({ origin: "writer", proposedTrust: "UNVERIFIED" }).ok);
  assert.ok(checkTrustCeiling({ origin: "executor", proposedTrust: "UNVERIFIED" }).ok);
  assert.equal(checkTrustCeiling({ origin: "executor", proposedTrust: "REVIEWED" }).ok, false);
});

test("2. verifier ceiling VERIFIED; reviewer ceiling REVIEWED; controller ceiling CONFIRMED", () => {
  assert.ok(checkTrustCeiling({ origin: "verifier", proposedTrust: "VERIFIED" }).ok);
  assert.equal(checkTrustCeiling({ origin: "verifier", proposedTrust: "REVIEWED" }).ok, false);
  assert.ok(checkTrustCeiling({ origin: "independent_reviewer", proposedTrust: "REVIEWED" }).ok);
  assert.equal(checkTrustCeiling({ origin: "independent_reviewer", proposedTrust: "CONFIRMED" }).ok, false);
  assert.ok(checkTrustCeiling({ origin: "graph_closeout", proposedTrust: "REVIEWED" }).ok);
  assert.equal(ORIGIN_TRUST_CEILING.controller, "CONFIRMED");
});

test("3. CONFIRMED is rejected for every automatic origin", () => {
  for (const origin of Object.keys(ORIGIN_TRUST_CEILING)) {
    const r = checkTrustCeiling({ origin, proposedTrust: "CONFIRMED" });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, WRITEBACK_TRUST_HOLD.CONFIRMED_NOT_AUTOMATIC);
  }
});

test("4. skip-level promotion fails closed（UNVERIFIED -> REVIEWED without gates）", () => {
  const skip = checkLadderProgression({ proposedTrust: "REVIEWED", evidenceReferences: ["manifest:x"] });
  assert.equal(skip.ok, false);
  assert.equal(skip.holdCode, WRITEBACK_TRUST_HOLD.SKIP_LEVEL);
  // UNVERIFIED never needs gates
  assert.ok(checkLadderProgression({ proposedTrust: "UNVERIFIED", evidenceReferences: [] }).ok);
});

test("5. VERIFIED requires verifier-bound evidence; REVIEWED requires review-bound evidence", () => {
  // the evidence REFERENCE must carry the verifier/review binding
  assert.equal(checkLadderProgression({ proposedTrust: "VERIFIED", evidenceReferences: ["manifest:x", "verifier:vid"], verifierIdentity: "vid" }).ok, true);
  assert.equal(checkLadderProgression({ proposedTrust: "VERIFIED", evidenceReferences: ["manifest:x"], verifierIdentity: "vid" }).ok, false, "no verifier-bound ref");
  assert.equal(checkLadderProgression({ proposedTrust: "VERIFIED", evidenceReferences: ["manifest:x", "verifier:vid"], verifierIdentity: null }).ok, false, "no verifier identity");
  const reviewOk = checkLadderProgression({ proposedTrust: "REVIEWED", evidenceReferences: ["manifest:x", "verifier:vid", "review:rid"], verifierIdentity: "vid", reviewIdentity: "rid" });
  assert.equal(reviewOk.ok, true);
  const reviewMissing = checkLadderProgression({ proposedTrust: "REVIEWED", evidenceReferences: ["manifest:x", "verifier:vid"], verifierIdentity: "vid", reviewIdentity: null });
  assert.equal(reviewMissing.ok, false);
});

test("6. unknown origin fails closed", () => {
  const r = checkTrustCeiling({ origin: "ghost", proposedTrust: "UNVERIFIED" });
  assert.equal(r.ok, false);
  assert.ok(String(r.holdCode).startsWith("WRITEBACK_ORIGIN_UNKNOWN"));
});

const GRAPH = "cbm4-trust-run";
const CARD = "AUTOLOOP-PI-GRAPH-CBM4-1";
const VERIFIER = "b".repeat(64);
const REVIEW = "c".repeat(64);
const canonical = (o = {}) => ({
  graphRunId: GRAPH,
  taskCardIds: [CARD, "graph-closeout"],
  resultIdentities: [VERIFIER, REVIEW],
  verifierIdentities: [VERIFIER],
  reviewIdentities: [REVIEW],
  ...o,
});

const base = () => ({ graphRunId: GRAPH, taskCardId: CARD });

// ── CBM-4 trust-boundary hardening: canonical evidence identity binding ──

test("7. UNVERIFIED carries no identity claim（no inventory required）", () => {
  const r = checkEvidenceIdentity({ proposedTrust: "UNVERIFIED", candidate: base(), canonicalEvidence: null });
  assert.equal(r.ok, true);
});

test("8. VERIFIED/REVIEWED without a canonical evidence inventory fails closed（never hex64-only）", () => {
  const r = checkEvidenceIdentity({ proposedTrust: "VERIFIED", verifierIdentity: VERIFIER, candidate: base(), canonicalEvidence: null });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, WRITEBACK_TRUST_HOLD.EVIDENCE_INVENTORY_REQUIRED);
  const r2 = checkEvidenceIdentity({ proposedTrust: "REVIEWED", reviewIdentity: REVIEW, candidate: base(), canonicalEvidence: null });
  assert.equal(r2.ok, false);
  assert.equal(r2.holdCode, WRITEBACK_TRUST_HOLD.EVIDENCE_INVENTORY_REQUIRED);
});

test("9. well-formed but NONEXISTENT verifier identity -> forged（not in canonical inventory）", () => {
  const forged = "a".repeat(64); // 64-hex, format-perfect, never attested
  const r = checkEvidenceIdentity({ proposedTrust: "VERIFIED", verifierIdentity: forged, candidate: base(), canonicalEvidence: canonical() });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_FORGED);
  assert.ok(String(r.reason).includes("not_in_canonical_inventory"));
});

test("10. well-formed but WRONG review identity -> forged", () => {
  const forgedReview = "d".repeat(64);
  const r = checkEvidenceIdentity({ proposedTrust: "REVIEWED", verifierIdentity: VERIFIER, reviewIdentity: forgedReview, candidate: base(), canonicalEvidence: canonical() });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_FORGED);
  assert.ok(String(r.reason).includes("review_identity_not_in_canonical_inventory"));
});

test("11. malformed（non-hex64 / unbounded）identity -> malformed, still rejected", () => {
  const r = checkEvidenceIdentity({ proposedTrust: "VERIFIED", verifierIdentity: "not-hex-at-all", candidate: base(), canonicalEvidence: canonical() });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_MALFORMED);
  const r2 = checkEvidenceIdentity({ proposedTrust: "REVIEWED", verifierIdentity: VERIFIER, reviewIdentity: "x".repeat(200), candidate: base(), canonicalEvidence: canonical() });
  assert.equal(r2.ok, false);
  assert.equal(r2.holdCode, WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_MALFORMED);
});

test("12. identity canonical for ANOTHER graph -> rejected（evidence_other_graph）", () => {
  const r = checkEvidenceIdentity({
    proposedTrust: "REVIEWED", verifierIdentity: VERIFIER, reviewIdentity: REVIEW,
    candidate: { graphRunId: "other-graph-run", taskCardId: CARD },
    canonicalEvidence: canonical(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, WRITEBACK_TRUST_HOLD.EVIDENCE_GRAPH_MISMATCH);
  // well-formed identity canonical for graph B but NOT in graph A's inventory
  const r2 = checkEvidenceIdentity({
    proposedTrust: "REVIEWED", verifierIdentity: VERIFIER, reviewIdentity: "e".repeat(64),
    candidate: base(), canonicalEvidence: canonical(),
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.holdCode, WRITEBACK_TRUST_HOLD.EVIDENCE_IDENTITY_FORGED);
});

test("13. identity bound to ANOTHER card -> rejected（evidence_other_card）", () => {
  const r = checkEvidenceIdentity({
    proposedTrust: "REVIEWED", verifierIdentity: VERIFIER, reviewIdentity: REVIEW,
    candidate: { graphRunId: GRAPH, taskCardId: "AUTOLOOP-PI-GRAPH-OTHER-1" },
    canonicalEvidence: canonical(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, WRITEBACK_TRUST_HOLD.EVIDENCE_CARD_MISMATCH);
});

test("14. attested verifier + review identities -> accepted（REVIEWED binds BOTH when provided）", () => {
  const r = checkEvidenceIdentity({
    proposedTrust: "REVIEWED", verifierIdentity: VERIFIER, reviewIdentity: REVIEW,
    candidate: base(), canonicalEvidence: canonical(),
  });
  assert.equal(r.ok, true);
  const v = checkEvidenceIdentity({ proposedTrust: "VERIFIED", verifierIdentity: VERIFIER, candidate: base(), canonicalEvidence: canonical() });
  assert.equal(v.ok, true);
});
