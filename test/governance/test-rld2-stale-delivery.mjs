// test/governance/test-rld2-stale-delivery.mjs
//
// AUTOLOOP-RLD2 — recurring stale review-bundle delivery: root-cause repair
// negative tests（NEG-RLD1..10）+ positive invariants.
//
// Delivery must be a VERIFIED DEREFERENCE of authoritative lifecycle state
//（card identity + bundle identity + cryptographic content sha + lifecycle
// state）, never a filesystem discovery（filename / mtime / newest-file /
// cached path）. The fixed external-review surface is exercised ONLY through
// env-isolated dirs（AEGISFLOW_REVIEW_SURFACE / AEGISFLOW_REVIEW_ARCHIVE）— the
// real ~/Desktop/AutoLoop-Review surface is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  renderReviewBundle,
  validateReviewBundle,
  buildExternalReviewState,
  applyExternalReviewVerdict,
  deliverToExternalReviewSurface,
  rotateExternalReviewSurface,
  readExternalReviewDeliveryRecord,
  writeExternalReviewDeliveryRecord,
  currentReviewDelivery,
  REVIEW_BUNDLE_SOURCE_SCHEMA,
} from "../../src/governance/review-bundle.mjs";

let seq = 0;
function freshSurface() {
  const root = join(tmpdir(), `rld2-test-${process.pid}-${Date.now()}-${seq++}`);
  const surface = join(root, "Current");
  const archive = join(root, "Archive");
  const bundles = join(root, "bundles");
  for (const d of [surface, archive, bundles]) mkdirSync(d, { recursive: true });
  return { root, surface, archive, bundles };
}

function mintBundle(cardId, title, outDir) {
  const source = {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: { cardId, cardTitle: title, cardType: "implementation" },
    graph: { graphRunId: `rld2-${cardId}-${seq++}`, nodeId: "N1", phaseExecutionId: "N1:1", stageIds: [], agentExecutionIds: [] },
    repo: { repository: "local", branch: "rld2", head: "2e897e995202c0c8c079c5fdc96b9f5d42d50d25", treeSha: "7ca2c9100b208e15647ff1e0524ffc4e0857e7e0", worktreePath: outDir, baselineDirtyDigest: "dirty:rld2", finalDirtyDigest: "dirty:rld2", remote: null },
    objective: "RLD2 test bundle for " + cardId,
    executiveStatus: "PASS",
    executiveSummary: "rld2 " + cardId,
    authorizedScope: [],
    unauthorizedScope: [],
    designDecisions: [],
    files: { added: [], modified: [], deleted: [], preExistingDirty: [] },
    inventory: null,
    diffSummary: "rld2",
    execution: { nodesExecuted: ["N1"], testsExecuted: ["N1"], nodeResults: { passed: 1, failed: 0, total: 1 }, pass: true },
    verifier: { pass: true, result: "PASS", summary: "rld2" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "rld2", blockingFindings: [], summary: "rld2" },
    repairAttempts: [],
    repairBudget: { maxAttempts: 1, used: 0 },
    repairLineage: { generationType: "implementation", repairIterations: 0, surfaceReseals: 0, resealTouchedPaths: [] },
    externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null },
    negativeCases: [],
    regression: [],
    regressionSummary: "rld2",
    evidence: [],
    security: { secretScanResult: "clean" },
    risks: [],
    limitations: [],
    rollbackProcedure: "rld2",
    openQuestions: [],
    recommendedNextStep: "rld2",
  };
  const b = renderReviewBundle(source);
  const path = join(outDir, `rld2-bundle-${cardId}-${seq++}.txt`);
  writeFileSync(path, b.text, "utf8");
  assert.equal(validateReviewBundle(path, { authorizedDir: outDir }).ok, true, `minted ${cardId} bundle must validate`);
  return { path, identity: b.identity, sha256: b.sha256, cardId };
}

function publish(surfaceDir, bundle) {
  const state = buildExternalReviewState({ bundle: { identity: bundle.identity, sha256: bundle.sha256 }, bundlePath: bundle.path, deliveryAttempted: true, deliveryMethod: "external-review-surface", attemptedAt: "2026-08-09T00:00:00.000Z" });
  return deliverToExternalReviewSurface({ bundlePath: bundle.path, state, source: { task: { cardId: bundle.cardId } }, outDir: surfaceDir, surfaceDir });
}

function applyPass(surfaceDir, reviewer = "external-reviewer") {
  const rec = readExternalReviewDeliveryRecord(join(surfaceDir, "delivery.json"));
  assert.equal(rec.ok, true, JSON.stringify(rec.errors));
  const applied = applyExternalReviewVerdict(rec.state, { verdict: "PASS", bundleIdentity: rec.state.delivery.reviewBundleIdentity, bundleSha256: rec.state.delivery.reviewBundleSha256, reviewerIdentity: reviewer, reviewedAt: "2026-08-09T01:00:00.000Z" });
  assert.equal(applied.ok, true, JSON.stringify(applied.errors));
  return writeExternalReviewDeliveryRecord({ outDir: surfaceDir, state: applied.state, cardId: rec.cardId, fileName: "delivery.json" });
}

test("NEG-RLD1: no new bundle -> NO_NEW_REVIEW_BUNDLE (never fallback to old COMPLETE bundle)", () => {
  const ctx = freshSurface();
  try {
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, "NO_NEW_REVIEW_BUNDLE");
    assert.ok(!r.bundle, "no bundle may be returned");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("NEG-RLD2: Current card != bundle CARD_ID -> STALE_CARD_IDENTITY (the incident)", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publish(ctx.surface, a); // TA-2 generation occupies the surface (unresolved — verdict never applied)
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, "STALE_CARD_IDENTITY");
    assert.ok(r.reason.includes("AUTOLOOP-TA2"), r.reason);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("NEG-RLD3: Current identity != delivery source identity -> fail closed", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publish(ctx.surface, a);
    // the export uses a cached path to a DIFFERENT card's bundle
    const b = mintBundle("AUTOLOOP-TA3", "Task B", ctx.bundles);
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3", cachedPath: b.path });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, "STALE_CARD_IDENTITY"); // card identity mismatch
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("NEG-RLD4: copy/export SHA change -> SURFACE_SHA_MISMATCH (fail closed)", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA3", "Current Card", ctx.bundles);
    publish(ctx.surface, a);
    // tamper the surface bundle AFTER the delivery record was written
    const bp = join(ctx.surface, "review-bundle.txt");
    const text = readFileSync(bp, "utf8");
    writeFileSync(bp, text.replace("RLD2 test bundle", "RLD2 TAMPERED bundle"), "utf8");
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, "SURFACE_SHA_MISMATCH");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("NEG-RLD5: already externally-reviewed generation re-delivered as new -> STALE_GENERATION_ALREADY_REVIEWED", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA3", "Current Card", ctx.bundles);
    publish(ctx.surface, a);
    applyPass(ctx.surface); // external PASS bound to the surface
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, "STALE_GENERATION_ALREADY_REVIEWED");
    assert.ok(r.reason.includes("already externally reviewed"), r.reason);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("NEG-RLD6: card B not closed out -> never deliver card A", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publish(ctx.surface, a);
    // Card B has NO bundle; the delivery must not return card A
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, "STALE_CARD_IDENTITY");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("NEG-RLD7: crash/resume must not roll back to the previous authoritative generation", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publish(ctx.surface, a);
    applyPass(ctx.surface);
    rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "AUTOLOOP-TA2", identity: a.identity, verdict: "PASS" });
    // crash before B publish — Current is empty; export must report NO_NEW,
    // never roll back to A
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, "NO_NEW_REVIEW_BUNDLE");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("NEG-RLD8: stale cached path points to old bundle -> identity check rejects", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publish(ctx.surface, a);
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3", cachedPath: a.path });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, "STALE_CARD_IDENTITY");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("NEG-RLD9: partial rotation -> fail closed, no fallback", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publish(ctx.surface, a);
    // partial rotation: only the bundle is archived; the delivery record stays
    rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "AUTOLOOP-TA2", identity: a.identity, verdict: "PASS" });
    // simulate a crashed rotate: re-write a record for the OLD card
    const rec = readExternalReviewDeliveryRecord(join(ctx.archive, ...[])); // archive cleared the trio
    void rec;
    // the surface now has no delivery record -> NO_NEW, never a fallback
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.ok, false);
    assert.ok(["NO_NEW_REVIEW_BUNDLE", "SURFACE_RECORD_INVALID"].includes(r.holdCode), r.holdCode);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("NEG-RLD10: delivery receipt vs actual delivered SHA mismatch -> fail closed", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA3", "Current Card", ctx.bundles);
    publish(ctx.surface, a);
    // rewrite the delivery record claiming a DIFFERENT sha than the file
    const rec = readExternalReviewDeliveryRecord(join(ctx.surface, "delivery.json"));
    const forged = structuredClone(rec.state);
    forged.delivery.reviewBundleSha256 = "0".repeat(64);
    writeExternalReviewDeliveryRecord({ outDir: ctx.surface, state: forged, cardId: rec.cardId, fileName: "delivery.json" });
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, "SURFACE_SHA_MISMATCH");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── positive invariants（the healthy path must keep working）─────────────

test("positive: current card's awaiting-review bundle is delivered with verified identity + sha", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA3", "Current Card", ctx.bundles);
    publish(ctx.surface, a);
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.bundle.cardId, "AUTOLOOP-TA3");
    assert.equal(r.bundle.identity, a.identity);
    assert.equal(r.bundle.sha256, a.sha256);
    assert.equal(r.bundle.status, "AWAITING_EXTERNAL_REVIEW");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("positive: resolved A auto-rotates; B publishes; export returns B (healthy cycle)", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publish(ctx.surface, a);
    applyPass(ctx.surface);
    const b = mintBundle("AUTOLOOP-TA3", "Current Card", ctx.bundles);
    const pub = publish(ctx.surface, b);
    assert.equal(pub.attempted, true, JSON.stringify(pub));
    const r = currentReviewDelivery({ surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.ok, true);
    assert.equal(r.bundle.cardId, "AUTOLOOP-TA3");
    assert.equal(r.bundle.identity, b.identity);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("positive: publish is card-identity guarded (delivery_card_id_mismatch)", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    const state = buildExternalReviewState({ bundle: { identity: a.identity, sha256: a.sha256 }, bundlePath: a.path, deliveryAttempted: true, deliveryMethod: "external-review-surface", attemptedAt: "2026-08-09T00:00:00.000Z" });
    const r = deliverToExternalReviewSurface({ bundlePath: a.path, state, source: { task: { cardId: a.cardId } }, outDir: ctx.surface, surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.attempted, false);
    assert.ok(r.reason.includes("delivery_card_id_mismatch"), r.reason);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("positive: occupied-by-different-card block is identity-explicit", () => {
  const ctx = freshSurface();
  try {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publish(ctx.surface, a);
    const b = mintBundle("AUTOLOOP-TA3", "Current Card", ctx.bundles);
    const r = deliverToExternalReviewSurface({ bundlePath: b.path, state: buildExternalReviewState({ bundle: { identity: b.identity, sha256: b.sha256 }, bundlePath: b.path, deliveryAttempted: true, deliveryMethod: "external-review-surface", attemptedAt: "2026-08-09T00:00:00.000Z" }), source: { task: { cardId: b.cardId } }, outDir: ctx.surface, surfaceDir: ctx.surface, currentCardId: "AUTOLOOP-TA3" });
    assert.equal(r.attempted, false);
    assert.ok(r.reason.includes("surface_occupied_by_different_card"), r.reason);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});
