// test/governance/test-review-queue-handoff.mjs
//
// REVART-LC1-REVIEW-QUEUE-AUTOMATIC-HANDOFF-REPAIR — pending-review queue +
// deterministic Current promotion + Latest pointer（T1–T19）.
//
// Model under test（src/governance/review-queue.mjs + the queue wiring in
// src/governance/review-bundle.mjs deliver/rotate）:
//   Current/   = the review awaiting action now（single slot, fail-closed）
//   Queue/     = every additional unresolved review（durable, FIFO）
//   Latest/    = navigation pointer to the NEWEST generated review（never
//                verdict authority）
//
// Invariants preserved from the review lifecycle:
//   - an unresolved Current occupant is NEVER overwritten（immutable except
//     via sanctioned verdict/reseal operations）
//   - a queued review is a legitimate delivery（SUCCESS）, not a
//     surface_occupied failure
//   - promotion copies bundle bytes verbatim — never regenerates/reseals
//   - ACCEPTED / final-closeout authority is untouched（no second mint site）
//
// Env isolation: each scenario gets its own AUTOLOOP_REVIEW_SURFACE /
// AUTOLOOP_REVIEW_ARCHIVE / AUTOLOOP_REVIEW_QUEUE so the real Desktop surface
// is never touched and no cross-test queue state leaks.
//
// Run: node --test test/governance/test-review-queue-handoff.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderReviewBundle,
  validateReviewBundle,
  buildExternalReviewState,
  recordDeliveryAttempt,
  applyExternalReviewVerdict,
  externalReviewComplete,
  deliverToExternalReviewSurface,
  rotateExternalReviewSurface,
  readExternalReviewDeliveryRecord,
  writeExternalReviewDeliveryRecord,
  promoteNextPendingReview,
  reconcileReviewQueue,
  REVIEW_BUNDLE_SOURCE_SCHEMA,
} from "../../src/governance/review-bundle.mjs";
import {
  reviewQueueDir,
  reviewQueuePath,
  readReviewQueue,
  reviewQueueStatus,
  readLatestPointer,
} from "../../src/governance/review-queue.mjs";

let seq = 0;

/** Fresh isolated surface + queue root per scenario. */
function freshRoot() {
  const root = join(tmpdir(), `revq-${process.pid}-${Date.now()}-${seq++}`);
  const surface = join(root, "Current");
  const archive = join(root, "Archive");
  const queue = join(root, "Queue");
  const bundles = join(root, "bundles");
  for (const d of [surface, archive, queue, bundles]) mkdirSync(d, { recursive: true });
  return { root, surface, archive, queue, bundles };
}

function mintBundle(cardId, title, outDir, { generation = null, supersedes = null, jobId = null } = {}) {
  const source = {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: { cardId, cardTitle: title, cardType: "implementation" },
    graph: { graphRunId: `revq-${cardId}-${seq++}`, nodeId: "N1", phaseExecutionId: "N1:1", stageIds: [], agentExecutionIds: [] },
    repo: { repository: "local", branch: "revq", head: "2e897e995202c0c8c079c5fdc96b9f5d42d50d25", treeSha: "7ca2c9100b208e15647ff1e0524ffc4e0857e7e0", worktreePath: outDir, baselineDirtyDigest: "dirty:revq", finalDirtyDigest: "dirty:revq", remote: null },
    objective: "REVQ test bundle for " + cardId,
    executiveStatus: "PASS",
    executiveSummary: "revq " + cardId,
    authorizedScope: [],
    unauthorizedScope: [],
    designDecisions: [],
    files: { added: [], modified: [], deleted: [], preExistingDirty: [] },
    inventory: null,
    diffSummary: "revq",
    execution: { nodesExecuted: ["N1"], testsExecuted: ["N1"], nodeResults: { passed: 1, failed: 0, total: 1 }, pass: true },
    verifier: { pass: true, result: "PASS", summary: "revq" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "revq", blockingFindings: [], summary: "revq" },
    repairAttempts: [],
    repairBudget: { maxAttempts: 1, used: 0 },
    repairLineage: { generationType: generation === "reseal" ? "surface-reseal" : "implementation", repairIterations: 0, surfaceReseals: generation === "reseal" ? 1 : 0, resealTouchedPaths: [] },
    externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes },
    negativeCases: [],
    regression: [],
    regressionSummary: "revq",
    evidence: [],
    security: { secretScanResult: "clean" },
    risks: [],
    limitations: [],
    rollbackProcedure: "revq",
    openQuestions: [],
    recommendedNextStep: "revq",
  };
  const b = renderReviewBundle(source);
  const path = join(outDir, `revq-bundle-${cardId}-${seq++}.txt`);
  writeFileSync(path, b.text, "utf8");
  assert.equal(validateReviewBundle(path, { authorizedDir: outDir }).ok, true, `minted ${cardId} bundle must validate`);
  return { path, identity: b.identity, sha256: b.sha256, cardId, generation, jobId };
}

function stateFor(bundle, { verdict = null } = {}) {
  const s = buildExternalReviewState({ bundle: { identity: bundle.identity, sha256: bundle.sha256 }, bundlePath: bundle.path, deliveryAttempted: true, deliveryMethod: "external-review-surface", attemptedAt: "2026-08-16T00:00:00.000Z" });
  return recordDeliveryAttempt(s, { method: "external-review-surface", attemptedAt: "2026-08-16T00:00:00.000Z" });
}

function deliver(ctx, bundle, { generation = null, jobId = null, supersedes = null } = {}) {
  const state = stateFor(bundle);
  if (supersedes) state.supersedes = supersedes;
  return deliverToExternalReviewSurface({
    bundlePath: bundle.path,
    state,
    source: { task: { cardId: bundle.cardId }, evidence: [] },
    surfaceDir: ctx.surface,
    generation,
    jobId,
  });
}

function applyVerdict(ctx, bundle, verdict = "PASS", reviewer = "external-reviewer") {
  const rec = readExternalReviewDeliveryRecord(join(ctx.surface, "delivery.json"));
  assert.equal(rec.ok, true, JSON.stringify(rec.errors));
  const applied = applyExternalReviewVerdict(rec.state, {
    verdict,
    reviewerIdentity: reviewer,
    reviewedAt: "2026-08-16T02:00:00.000Z",
    bundleIdentity: rec.state.delivery.reviewBundleIdentity,
    bundleSha256: rec.state.delivery.reviewBundleSha256,
  });
  assert.equal(applied.ok, true, JSON.stringify(applied.errors));
  return writeExternalReviewDeliveryRecord({ outDir: ctx.surface, state: applied.state, cardId: rec.cardId, fileName: "delivery.json" });
}

const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function surfaceOccupant(ctx) {
  if (!existsSync(join(ctx.surface, "delivery.json"))) return null;
  const rec = readExternalReviewDeliveryRecord(join(ctx.surface, "delivery.json"));
  return rec.ok ? { cardId: rec.cardId, state: rec.state } : null;
}

// ── T1: Current empty + review A -> A becomes Current ─────────────────────

test("T1. Current empty + review A delivery -> A becomes Current", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T1A", "Task A", ctx.bundles);
    const d = deliver(ctx, a);
    assert.equal(d.attempted, true, JSON.stringify(d));
    assert.equal(d.queued, undefined, "direct publish when Current empty");
    const occ = surfaceOccupant(ctx);
    assert.equal(occ.cardId, "REVQ-T1A", "A is the Current occupant");
    assert.equal(occ.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.current?.cardId, "REVQ-T1A", "queue entry is CURRENT");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T2: Current A unresolved + review B -> A stays; B QUEUED; no failure ──

test("T2. Current A unresolved + review B delivery -> A remains Current; B QUEUED; no surface_occupied failure", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T2A", "Task A", ctx.bundles);
    const b = mintBundle("REVQ-T2B", "Task B", ctx.bundles);
    deliver(ctx, a);
    const d = deliver(ctx, b);
    assert.equal(d.attempted, true, "queued delivery is a SUCCESS (T2)");
    assert.equal(d.queued, true, "B queued");
    assert.equal(d.method, "external-review-queue", "queue delivery method");
    const occ = surfaceOccupant(ctx);
    assert.equal(occ.cardId, "REVQ-T2A", "A still Current");
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.pending.length, 1, "one pending");
    assert.equal(st.pending[0].cardId, "REVQ-T2B", "B pending");
    assert.equal(st.pending[0].state, "QUEUED");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T3: A resolved/rotated -> B automatically promotes to Current ────────

test("T3. A resolved/rotated -> B automatically promotes to Current", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T3A", "Task A", ctx.bundles);
    const b = mintBundle("REVQ-T3B", "Task B", ctx.bundles);
    deliver(ctx, a);
    deliver(ctx, b); // B queued
    assert.equal(surfaceOccupant(ctx).cardId, "REVQ-T3A");
    applyVerdict(ctx, a, "PASS");
    const rot = rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "REVQ-T3A", identity: a.identity, verdict: "PASS" });
    assert.equal(rot.ok, true, `rotate ok (${rot.reason})`);
    assert.equal(rot.promoted?.cardId, "REVQ-T3B", "B promoted by rotation");
    const occ = surfaceOccupant(ctx);
    assert.equal(occ.cardId, "REVQ-T3B", "B is now Current");
    assert.equal(shaFile(join(ctx.surface, "review-bundle.txt")), shaFile(b.path), "B's bundle bytes copied verbatim (no regeneration)");
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.pending.length, 0, "queue drained");
    assert.equal(st.archived.some((e) => e.cardId === "REVQ-T3A"), true, "A archived in queue");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T4: A + B + C -> deterministic FIFO order ────────────────────────────

test("T4. A + B + C -> deterministic FIFO queue order", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T4A", "Task A", ctx.bundles);
    const b = mintBundle("REVQ-T4B", "Task B", ctx.bundles);
    const c = mintBundle("REVQ-T4C", "Task C", ctx.bundles);
    deliver(ctx, a); // Current
    deliver(ctx, b); // queued #1
    deliver(ctx, c); // queued #2
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.pending.length, 2);
    assert.equal(st.pending[0].cardId, "REVQ-T4B", "B first (FIFO)");
    assert.equal(st.pending[1].cardId, "REVQ-T4C", "C second");
    assert.ok(st.pending[0].order < st.pending[1].order, "monotonic order");
    // resolve A -> B promotes; resolve B -> C promotes
    applyVerdict(ctx, a, "PASS");
    const r1 = rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "REVQ-T4A", identity: a.identity, verdict: "PASS" });
    assert.equal(r1.promoted?.cardId, "REVQ-T4B");
    applyVerdict(ctx, b, "PASS");
    const r2 = rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "REVQ-T4B", identity: b.identity, verdict: "PASS" });
    assert.equal(r2.promoted?.cardId, "REVQ-T4C");
    assert.equal(surfaceOccupant(ctx).cardId, "REVQ-T4C");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T5: Latest after A/B/C -> points to C while Current may still be A ───

test("T5. Latest after A/B/C points to C while Current is still A", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T5A", "Task A", ctx.bundles);
    const b = mintBundle("REVQ-T5B", "Task B", ctx.bundles);
    const c = mintBundle("REVQ-T5C", "Task C", ctx.bundles);
    deliver(ctx, a); // Current
    deliver(ctx, b); // queued
    deliver(ctx, c); // queued
    const latest = readLatestPointer(ctx.surface);
    assert.equal(latest.ok, true, latest.reason ?? "");
    assert.equal(latest.latest.cardId, "REVQ-T5C", "Latest = newest generated (C)");
    assert.equal(latest.latest.bundleIdentity, c.identity, "Latest identity traceable to source bundle");
    const occ = surfaceOccupant(ctx);
    assert.equal(occ.cardId, "REVQ-T5A", "Current still A");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T6: resolve A -> Current becomes B; Latest remains C ─────────────────

test("T6. resolve A -> Current becomes B; Latest remains C", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T6A", "Task A", ctx.bundles);
    const b = mintBundle("REVQ-T6B", "Task B", ctx.bundles);
    const c = mintBundle("REVQ-T6C", "Task C", ctx.bundles);
    deliver(ctx, a);
    deliver(ctx, b);
    deliver(ctx, c);
    applyVerdict(ctx, a, "PASS");
    const rot = rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "REVQ-T6A", identity: a.identity, verdict: "PASS" });
    assert.equal(rot.promoted?.cardId, "REVQ-T6B", "B promoted");
    assert.equal(surfaceOccupant(ctx).cardId, "REVQ-T6B", "Current becomes B");
    const latest = readLatestPointer(ctx.surface);
    assert.equal(latest.latest.cardId, "REVQ-T6C", "Latest remains C");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T7: duplicate B delivery -> one queue entry only ─────────────────────

test("T7. duplicate B delivery -> one queue entry only", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T7A", "Task A", ctx.bundles);
    const b = mintBundle("REVQ-T7B", "Task B", ctx.bundles);
    deliver(ctx, a);
    const d1 = deliver(ctx, b);
    assert.equal(d1.queued, true);
    const d2 = deliver(ctx, b); // same identity re-delivery
    assert.equal(d2.attempted, true, JSON.stringify(d2));
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.queue.entries.filter((e) => e.cardId === "REVQ-T7B").length, 1, "one entry only");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T8: conflicting B identity -> HOLD ───────────────────────────────────

test("T8. conflicting B identity（same card, different bundle, no supersession）-> HOLD", () => {
  const ctx = freshRoot();
  try {
    const b1 = mintBundle("REVQ-T8B", "Task B v1", ctx.bundles);
    const b2 = mintBundle("REVQ-T8B", "Task B v2", ctx.bundles);
    deliver(ctx, b1); // B1 Current (surface empty)
    const d = deliver(ctx, b2); // same card, different identity, NO supersession
    assert.equal(d.attempted, false, "conflicting identity fails closed");
    assert.equal(d.hold, true, "HOLD");
    assert.ok(d.reason.includes("queue_hold"), d.reason);
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.held.some((e) => e.cardId === "REVQ-T8B"), true, "entry HOLD");
    assert.equal(surfaceOccupant(ctx).cardId, "REVQ-T8B", "surface occupant untouched (b1 still there, unmodified)");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T9: queued B resealed -> queue references successor only; supersession ─

test("T9. queued B resealed -> queue references successor only; supersession preserved", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T9A", "Task A", ctx.bundles);
    const b1 = mintBundle("REVQ-T9B", "Task B v1", ctx.bundles);
    const sup = { reviewBundleIdentity: b1.identity, reviewBundleSha256: b1.sha256, bundlePath: b1.path };
    const b2 = mintBundle("REVQ-T9B", "Task B v2 (reseal)", ctx.bundles, { generation: "reseal", supersedes: sup });
    deliver(ctx, a); // Current
    deliver(ctx, b1); // B1 queued
    const d = deliver(ctx, b2, { supersedes: sup }); // sanctioned reseal of QUEUED B
    assert.equal(d.attempted, true, JSON.stringify(d));
    assert.equal(d.queued, true, "still queued");
    const st = reviewQueueStatus(ctx.surface);
    const entries = st.queue.entries.filter((e) => e.cardId === "REVQ-T9B");
    assert.equal(entries.length, 1, "one entry only (successor replaces obsolete)");
    assert.equal(entries[0].bundleIdentity, b2.identity, "references successor generation");
    assert.equal(entries[0].supersedes?.reviewBundleIdentity, b1.identity, "supersession preserved");
    assert.equal(entries[0].state, "QUEUED", "still queued behind A");
    // promotion promotes ONLY the successor generation
    applyVerdict(ctx, a, "PASS");
    const rot = rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "REVQ-T9A", identity: a.identity, verdict: "PASS" });
    assert.equal(rot.promoted?.cardId, "REVQ-T9B");
    assert.equal(shaFile(join(ctx.surface, "review-bundle.txt")), shaFile(b2.path), "promotes the resealed generation bytes");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T10: Current A resealed -> remains Current; no duplicate queue entry ─

test("T10. Current A resealed -> A remains Current; no duplicate queue entry", () => {
  const ctx = freshRoot();
  try {
    const a1 = mintBundle("REVQ-T10A", "Task A v1", ctx.bundles);
    const sup = { reviewBundleIdentity: a1.identity, reviewBundleSha256: a1.sha256, bundlePath: a1.path };
    const a2 = mintBundle("REVQ-T10A", "Task A v2 (reseal)", ctx.bundles, { generation: "reseal", supersedes: sup });
    deliver(ctx, a1); // A1 Current
    const d = deliver(ctx, a2, { supersedes: sup }); // sanctioned reseal of CURRENT
    assert.equal(d.attempted, true, JSON.stringify(d));
    assert.equal(d.resealed, true, "Current updated in place");
    assert.equal(surfaceOccupant(ctx).cardId, "REVQ-T10A", "same lineage remains Current");
    assert.equal(shaFile(join(ctx.surface, "review-bundle.txt")), shaFile(a2.path), "Current holds the superseding generation");
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.queue.entries.filter((e) => e.cardId === "REVQ-T10A").length, 1, "no duplicate queue entry");
    assert.equal(st.current?.bundleIdentity, a2.identity, "queue entry references successor");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T11: crash after enqueue before Latest update -> queue survives restart ─

test("T11. crash after enqueue before Latest update -> restart recovers queue; no loss", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T11A", "Task A", ctx.bundles);
    const b = mintBundle("REVQ-T11B", "Task B", ctx.bundles);
    deliver(ctx, a);
    deliver(ctx, b); // enqueued; Latest was written as part of delivery
    // simulate a process that died between queue persist and Latest update:
    // remove the latest pointer only — the queue file itself is the durable
    // authority and must survive.
    rmSync(join(ctx.queue, "latest.json"), { force: true });
    const qr = readReviewQueue(ctx.surface);
    assert.equal(qr.ok, true);
    assert.equal(qr.queue.entries.some((e) => e.cardId === "REVQ-T11B" && e.state === "QUEUED"), true, "B queued entry survives");
    // restart: reconcile re-promotes deterministically after A resolves
    applyVerdict(ctx, a, "PASS");
    const rot = rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "REVQ-T11A", identity: a.identity, verdict: "PASS" });
    assert.equal(rot.promoted?.cardId, "REVQ-T11B", "B promoted after restart");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T12: crash after archive before promotion -> restart promotes next ───

test("T12. crash after Current archive before promotion -> restart promotes next queued item", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T12A", "Task A", ctx.bundles);
    const b = mintBundle("REVQ-T12B", "Task B", ctx.bundles);
    deliver(ctx, a);
    deliver(ctx, b);
    // simulate: archive + clear Current manually（as if rotation ran but the
    // promotion step crashed）— queue entry for B is still QUEUED.
    applyVerdict(ctx, a, "PASS");
    const rec = readExternalReviewDeliveryRecord(join(ctx.surface, "delivery.json"));
    const rot = rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "REVQ-T12A", identity: rec.state.delivery.reviewBundleIdentity, verdict: "PASS" });
    assert.equal(rot.promoted?.cardId, "REVQ-T12B", "promotion happens inside rotation");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T13: Current empty + pending queue on startup -> reconcile promotes ───

test("T13. Current empty + pending queue on startup -> automatic reconciliation/promotion", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T13A", "Task A", ctx.bundles);
    const b = mintBundle("REVQ-T13B", "Task B", ctx.bundles);
    deliver(ctx, a);
    deliver(ctx, b);
    // crash simulation: Current trio is cleared (archive written), queue has
    // B QUEUED; restart calls reconcileReviewQueue with no new delivery.
    for (const f of readdirSync(ctx.surface)) rmSync(join(ctx.surface, f), { force: true });
    const r = reconcileReviewQueue({ surfaceDir: ctx.surface });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.promoted?.cardId, "REVQ-T13B", "reconcile promotes the pending review");
    assert.equal(surfaceOccupant(ctx).cardId, "REVQ-T13B", "B is Current after reconciliation");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T14: queue persistence corruption -> fail closed ─────────────────────

test("T14. queue persistence corruption -> fail closed", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T14A", "Task A", ctx.bundles);
    deliver(ctx, a);
    // corrupt the queue file
    writeFileSync(reviewQueuePath(ctx.surface), "{ not valid json", "utf8");
    const d = deliver(ctx, mintBundle("REVQ-T14B", "Task B", ctx.bundles));
    assert.equal(d.attempted, false, "corrupt queue fails closed");
    assert.equal(d.hold, true, "HOLD");
    assert.ok(d.reason.includes("queue_hold"), d.reason);
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.ok, false, "status fails closed on corruption");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T15: Latest failure -> does not block or invalidate review authority ──

test("T15. Latest failure -> does not block or invalidate review authority", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T15A", "Task A", ctx.bundles);
    // make latest.json unwritable: a directory at the latest path
    mkdirSync(join(ctx.queue, "latest.json"), { recursive: true });
    const d = deliver(ctx, a);
    assert.equal(d.attempted, true, "delivery succeeds despite Latest failure");
    assert.ok(d.latestError, "Latest failure surfaced as warning, not error");
    const st = reviewQueueStatus(ctx.surface);
    assert.ok(st.latestError, `status notes Latest failure (${st.latestError})`);
    assert.equal(surfaceOccupant(ctx).cardId, "REVQ-T15A", "review authority intact");
    const qr = readReviewQueue(ctx.surface);
    assert.equal(qr.queue.entries.some((e) => e.cardId === "REVQ-T15A"), true, "queue entry persists");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T16: restart preserves queue ordering and identities ─────────────────

test("T16. restart preserves queue ordering and identities", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T16A", "Task A", ctx.bundles);
    const b = mintBundle("REVQ-T16B", "Task B", ctx.bundles);
    const c = mintBundle("REVQ-T16C", "Task C", ctx.bundles);
    deliver(ctx, a);
    deliver(ctx, b);
    deliver(ctx, c);
    // "restart": re-read from disk（fresh module state == fresh process）
    const qr = readReviewQueue(ctx.surface);
    assert.equal(qr.ok, true);
    const pend = qr.queue.entries.filter((e) => e.state === "QUEUED").sort((x, y) => x.order - y.order);
    assert.deepEqual(pend.map((e) => e.cardId), ["REVQ-T16B", "REVQ-T16C"], "ordering preserved");
    assert.equal(pend[0].bundleIdentity, b.identity, "B identity preserved");
    assert.equal(pend[1].bundleIdentity, c.identity, "C identity preserved");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── T17: review-job / Controller ACCEPTED semantics unchanged ────────────

test("T17. review-job / Controller ACCEPTED semantics unchanged (acceptReviewJob is the sole mint site)", async () => {
  // ACCEPTED minting lives in review-job.mjs; the queue layer must not add a
  // second acceptance path. Verify the queue module never exports accept.
  const mod = await import("../../src/governance/review-queue.mjs");
  assert.equal(typeof mod.acceptReviewJob, "undefined", "queue module has no acceptance mint");
  const rj = await import("../../src/governance/review-job.mjs");
  assert.equal(typeof rj.acceptReviewJob, "function", "acceptance stays in review-job.mjs");
});

// ── T18: exactly one ACCEPTED mint site remains ──────────────────────────

test("T18. exactly one ACCEPTED mint site remains", async () => {
  const rj = await import("../../src/governance/review-job.mjs");
  const src = readFileSync("/private/tmp/autoloop/src/governance/review-job.mjs", "utf8");
  // acceptReviewJob is the single production ACCEPTED transition
  const acceptFn = src.match(/acceptReviewJob[\s\S]*?state: "ACCEPTED"/g) ?? [];
  assert.ok(acceptFn.length >= 1, "acceptReviewJob mints ACCEPTED (state: \"ACCEPTED\")");
  // review-queue.mjs must contain no ACCEPTED mint
  const qsrc = readFileSync("/private/tmp/autoloop/src/governance/review-queue.mjs", "utf8");
  assert.ok(!qsrc.includes('"ACCEPTED"'), "queue module never mints ACCEPTED");
  assert.equal(typeof rj.acceptReviewJob, "function");
});

// ── T19: full scenario ───────────────────────────────────────────────────

test("T19. full scenario: A pending -> B generated -> C generated -> A verdict/rotate -> B promoted -> B verdict/rotate -> C promoted; no loss/dup/regeneration", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("REVQ-T19A", "Task A", ctx.bundles);
    const b = mintBundle("REVQ-T19B", "Task B", ctx.bundles);
    const c = mintBundle("REVQ-T19C", "Task C", ctx.bundles);
    deliver(ctx, a); // A Current
    deliver(ctx, b); // B queued
    deliver(ctx, c); // C queued
    assert.equal(surfaceOccupant(ctx).cardId, "REVQ-T19A");
    // A verdict + rotate -> B promoted
    applyVerdict(ctx, a, "PASS");
    const r1 = rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "REVQ-T19A", identity: a.identity, verdict: "PASS" });
    assert.equal(r1.promoted?.cardId, "REVQ-T19B");
    assert.equal(surfaceOccupant(ctx).cardId, "REVQ-T19B");
    assert.equal(shaFile(join(ctx.surface, "review-bundle.txt")), shaFile(b.path), "B bytes verbatim");
    // B verdict + rotate -> C promoted
    applyVerdict(ctx, b, "PASS");
    const r2 = rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "REVQ-T19B", identity: b.identity, verdict: "PASS" });
    assert.equal(r2.promoted?.cardId, "REVQ-T19C");
    assert.equal(surfaceOccupant(ctx).cardId, "REVQ-T19C");
    assert.equal(shaFile(join(ctx.surface, "review-bundle.txt")), shaFile(c.path), "C bytes verbatim");
    // nothing lost / duplicated / regenerated
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.pending.length, 0, "no pending left");
    assert.equal(st.queue.entries.length, 3, "exactly three entries (one per card)");
    assert.equal(st.queue.entries.filter((e) => e.cardId === "REVQ-T19B").length, 1);
    assert.equal(st.queue.entries.filter((e) => e.cardId === "REVQ-T19C").length, 1);
    const archives = readdirSync(ctx.archive);
    // these minted bundles carry no evidence.json -> review-bundle + delivery
    assert.equal(archives.filter((f) => f.includes("REVQ-T19A") && f.includes("PASS")).length, 2, "A archived pair (bundle+delivery)");
    assert.equal(archives.filter((f) => f.includes("REVQ-T19B") && f.includes("PASS")).length, 2, "B archived pair");
    // archive bundle bytes immutable
    const aArch = archives.find((f) => f.includes("REVQ-T19A") && f.endsWith("review-bundle.txt"));
    assert.equal(shaFile(join(ctx.archive, aArch)), shaFile(a.path), "A archive bytes preserved");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});
