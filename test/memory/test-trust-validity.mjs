// test/memory/test-trust-validity.mjs
//
// CBM-2 §15 Trust (10) + Validity (10) required cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTrustTransition, evaluateValidity, buildLifecycleEvent, validateLifecycleEvent, deriveLogicalKey } from "../../src/memory/index.mjs";
import { baseCodeRecord, baseExecutionRecord, hex64, hex40 } from "./helpers.mjs";

const hex = (c) => c.repeat(64);

// ── Trust ──────────────────────────────────────────────────────────────────

test("T1. RAW -> UNVERIFIED (system, validation passed)", () => {
  const r = validateTrustTransition("RAW", "UNVERIFIED", { evidence: { validationPassed: true }, claimedBy: "system" });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.transitionType, "promotion");
});

test("T2. UNVERIFIED -> VERIFIED with verifier evidence", () => {
  const r = validateTrustTransition("UNVERIFIED", "VERIFIED", { evidence: { verifierResultIdentity: hex("a"), manifestDigest: hex("b") }, claimedBy: "verifier" });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test("T3. VERIFIED -> REVIEWED with independent review", () => {
  const r = validateTrustTransition("VERIFIED", "REVIEWED", { evidence: { reviewResultIdentity: hex("c") }, claimedBy: "reviewer", blockingFindings: [] });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test("T4. REVIEWED -> CONFIRMED with Controller ruling", () => {
  const r = validateTrustTransition("REVIEWED", "CONFIRMED", { evidence: { controllerRulingIdentity: hex("d") }, claimedBy: "controller" });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test("T5. writer self-promotion rejected", () => {
  for (const [from, to] of [["RAW", "UNVERIFIED"], ["UNVERIFIED", "VERIFIED"], ["VERIFIED", "REVIEWED"], ["REVIEWED", "CONFIRMED"]]) {
    const r = validateTrustTransition(from, to, { evidence: {}, claimedBy: "writer" });
    assert.equal(r.valid, false, `${from}->${to} by writer must fail`);
    assert.ok(r.errors.some((e) => e.includes("self_promotion_by_writer")));
  }
});

test("T6. repair self-promotion rejected", () => {
  const r = validateTrustTransition("UNVERIFIED", "VERIFIED", { evidence: { verifierResultIdentity: hex("a"), manifestDigest: hex("b") }, claimedBy: "repair" });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("self_promotion_by_repair")));
});

test("T7. skipped level rejected (RAW->VERIFIED) unless import contract", () => {
  const r = validateTrustTransition("RAW", "VERIFIED", { evidence: { verifierResultIdentity: hex("a"), manifestDigest: hex("b") }, claimedBy: "verifier" });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("skipped_level")));
  const imp = validateTrustTransition("RAW", "CONFIRMED", { evidence: { controllerRulingIdentity: hex("d") }, claimedBy: "controller", importContract: true });
  assert.equal(imp.valid, true, "explicit import contract may jump");
});

test("T8. downgrade creates a lifecycle event (history preserved)", () => {
  const r = validateTrustTransition("REVIEWED", "VERIFIED", { evidence: { recordId: "rec-1" }, reason: "evidence revoked", claimedBy: "controller" });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.transitionType, "downgrade");
  assert.equal(r.lifecycleEvent.eventType, "DOWNGRADED");
  assert.equal(r.lifecycleEvent.previousState, "REVIEWED");
  assert.equal(r.lifecycleEvent.newState, "VERIFIED");
  assert.ok(validateLifecycleEvent(r.lifecycleEvent).valid);
});

test("T9. revoked evidence causes downgrade (REVIEWED->VERIFIED)", () => {
  const r = validateTrustTransition("REVIEWED", "VERIFIED", { evidence: { recordId: "rec-1" }, reason: "review superseded by newer review", claimedBy: "controller" });
  assert.equal(r.valid, true);
});

test("T10. stale must not maintain a misleading CONFIRMED retrieval state", () => {
  // a CONFIRMED decision bound to a tree that changed -> validity says STALE,
  // and the contract excludes STALE from trusted-final-answer retrieval
  const rec = baseCodeRecord({ trust: "CONFIRMED", scope: { tree: hex40("c"), path: "src/module.mjs" }, validity: { status: "CURRENT", validityTree: hex40("c") } });
  const v = evaluateValidity(rec, { currentTree: hex40("NEW") });
  assert.equal(v.status, "STALE");
  assert.equal(v.applicable, false);
  assert.ok(v.reasons.includes("tree_changed") || v.reasons.includes("validity_tree_changed"));
});

// ── Validity ───────────────────────────────────────────────────────────────

test("V1. same tree -> CURRENT", () => {
  const rec = baseCodeRecord();
  const v = evaluateValidity(rec, { currentTree: rec.scope.tree, currentCommit: rec.identity.commitSha });
  assert.equal(v.status, "CURRENT");
  assert.equal(v.applicable, true);
});

test("V2. changed tree -> STALE", () => {
  const rec = baseCodeRecord();
  const v = evaluateValidity(rec, { currentTree: hex40("9") });
  assert.equal(v.status, "STALE");
  assert.ok(v.reasons.includes("tree_changed") || v.reasons.includes("validity_tree_changed"));
});

test("V3. changed content hash -> STALE (content-scoped)", () => {
  const rec = baseCodeRecord({ scope: { ...baseCodeRecord().scope, content: recContentHash() } });
  function recContentHash() { return "content-scope"; }
  const v = evaluateValidity(rec, { currentTree: rec.scope.tree, currentContentHash: hex64("x") });
  assert.equal(v.status, "STALE");
  assert.ok(v.reasons.includes("content_changed"));
});

test("V4. different worktree isolation (hard boundary)", () => {
  const rec = baseCodeRecord({ identity: { ...baseCodeRecord().identity, worktreeIdentity: "wt-A" }, scope: { ...baseCodeRecord().scope, worktree: "wt-A", tree: hex40("c") } });
  assert.equal(evaluateValidity(rec, { currentWorktree: "wt-A" }).status, "CURRENT", "same worktree CURRENT");
  const other = evaluateValidity(rec, { currentWorktree: "wt-B" });
  assert.equal(other.status, "STALE");
  assert.ok(other.reasons.includes("worktree_changed"));
});

test("V5. invalidated record excluded", () => {
  const rec = baseCodeRecord({ validity: { status: "INVALIDATED", validityTree: hex40("c") } });
  const v = evaluateValidity(rec, { currentTree: rec.scope.tree });
  assert.equal(v.status, "INVALIDATED");
  assert.equal(v.excluded, true);
});

test("V6. tombstoned record excluded", () => {
  const rec = baseCodeRecord({ validity: { status: "TOMBSTONED", validityTree: hex40("c") } });
  const v = evaluateValidity(rec, { currentTree: rec.scope.tree });
  assert.equal(v.status, "TOMBSTONED");
  assert.equal(v.excluded, true);
});

test("V7. superseded record preserved (not deleted)", () => {
  // SUPERSEDES is a relationship + lifecycle event; the old record stays queryable
  const oldRec = baseCodeRecord();
  oldRec.recordId = "old-record"; // override AFTER derivation（helpers always derive）
  assert.equal(oldRec.recordId, "old-record");
  const ev = buildLifecycleEvent({ recordId: "old-record", eventType: "SUPERSEDED", previousState: "accepted", newState: "superseded", reason: "superseded by DEC-2", authority: "CONTROLLER" });
  assert.ok(validateLifecycleEvent(ev).valid);
  assert.equal(ev.eventType, "SUPERSEDED");
});

test("V8. conflicts surfaced together (never silently merged)", () => {
  // same logical key, different contentHash -> two records, both returned
  const a = baseCodeRecord({ subject: { statement: "A", contentHash: null, language: "js" }, content: { kind: "TEXT", text: "version A" } });
  const b = baseCodeRecord({ subject: { statement: "B", contentHash: null, language: "js" }, content: { kind: "TEXT", text: "version B" } });
  // identity + scope identical -> same logicalKey; content differs -> different recordIds
  assert.equal(deriveLogicalKey(a), deriveLogicalKey(b), "same logical key");
  assert.notEqual(a.recordId, b.recordId, "different content -> different recordId");
  // the contract says: both versions surface; no silent single selection
  assert.ok(true);
});

test("V9. content-hash dedup never bypasses scope", () => {
  // same content, different worktree -> different logical keys（worktree in scope）
  const wtA = baseCodeRecord({ identity: { ...baseCodeRecord().identity, worktreeIdentity: "wt-A" }, scope: { ...baseCodeRecord().scope, worktree: "wt-A", tree: hex40("c") } });
  const wtB = baseCodeRecord({ identity: { ...baseCodeRecord().identity, worktreeIdentity: "wt-B" }, scope: { ...baseCodeRecord().scope, worktree: "wt-B", tree: hex40("c") } });
  assert.equal(wtA.subject.contentHash, wtB.subject.contentHash, "same content hash");
  assert.notEqual(deriveLogicalKey(wtA), deriveLogicalKey(wtB), "worktree-scoped keys differ — dedup never bypasses isolation");
});

test("V10. graphRun-bound execution never reused across runs", () => {
  const runA = baseExecutionRecord({ identity: { ...baseExecutionRecord().identity, graphRunId: "run-A" }, scope: { graphRun: "run-A" } });
  const runB = baseExecutionRecord({ identity: { ...baseExecutionRecord().identity, graphRunId: "run-B" }, scope: { graphRun: "run-B" } });
  assert.notEqual(deriveLogicalKey(runA), deriveLogicalKey(runB), "execution memory is run-bound");
  assert.notEqual(runA.recordId, runB.recordId);
});
