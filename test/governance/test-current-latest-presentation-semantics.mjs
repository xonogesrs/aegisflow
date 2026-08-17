// test/governance/test-current-latest-presentation-semantics.mjs
//
// CURRENT-LATEST-REVIEW-PRESENTATION-SEMANTICS-1 — card T acceptance suite.
//
// Canonical rule under test:
//   task completion -> review bundle -> Current = that task's review
//   (whatever the previous card's verdict state; the queue never gates
//    presentation; the verdict lifecycle never controls the pointer).
//
// Coverage（card T, 20 items）:
//   1.  A completion -> Current = A
//   2.  B completion -> Current = B without any A verdict
//   3.  C completion -> Current = C without A/B verdicts
//   4.  A/B remain durable PENDING in the ledger
//   5.  verdict PASS on A while Current = C（ledger binding, not Current）
//   6.  verdict PASS on B while Current = C
//   7.  Current unchanged by old verdicts（no rollback）
//   8.  stale replay cannot regress Current（N4）
//   9.  crash before Current publish -> reconciliation republishes（N1）
//  10.  crash after Current publish -> ledger intact; reconcile idempotent
//  11.  migration: old CURRENT -> PENDING（presentation pointer derived）
//  12.  migration: old QUEUED -> PENDING
//  13.  archive lineage preserved（PASS archives bundle + delivery record）
//  14.  supersession preserved（successor entry carries the supersede binding）
//  15.  LatestHuman separation（LatestHuman != Current preserved）
//  16.  operator closeout does NOT change Current
//  17.  formal review publication updates Current
//  18.  review-bundle generation regression（deterministic identity/sha）
//  19.  queue/ledger regression（ordering + identities durable）
//  20.  pre-convention bundle（PC1-shaped）presented directly, no old PASS
//
// Env-isolated: every scenario gets its own surface/archive/queue roots.
//
// Run: node --test test/governance/test-current-latest-presentation-semantics.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  REVIEW_BUNDLE_SOURCE_SCHEMA,
  renderReviewBundle,
  validateReviewBundle,
  buildExternalReviewState,
  recordDeliveryAttempt,
  deliverToExternalReviewSurface,
  rotateExternalReviewSurface,
  reconcileReviewQueue,
  promoteNextPendingReview,
  readExternalReviewDeliveryRecord,
  bundleContentSha256,
} from "../../src/governance/review-bundle.mjs";
import {
  reviewQueueStatus,
  readReviewQueue,
  writeReviewQueue,
  migrateReviewQueue,
  presentedEntry,
  pendingEntries,
  ensureQueueMigrated,
} from "../../src/governance/review-queue.mjs";
import { publishHumanReport, humanReportStatus } from "../../src/governance/human-report.mjs";

const ROOT = `${tmpdir()}/cps-accept-${process.pid}`;
const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

let seq = 0;
function freshRoot() {
  const root = join(ROOT, `case-${seq++}`);
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
    graph: { graphRunId: `cps-${cardId}-${seq++}`, nodeId: "N1", phaseExecutionId: "N1:1", stageIds: [], agentExecutionIds: [] },
    repo: { repository: "local", branch: "cps", head: "2e897e995202c0c8c079c5fdc96b9f5d42d50d25", treeSha: "7ca2c9100b208e15647ff1e0524ffc4e0857e7e0", worktreePath: outDir, baselineDirtyDigest: "dirty:cps", finalDirtyDigest: "dirty:cps", remote: null },
    objective: "CPS acceptance bundle for " + cardId,
    executiveStatus: "PASS",
    executiveSummary: "cps " + cardId,
    authorizedScope: [],
    unauthorizedScope: [],
    designDecisions: [],
    files: { added: [], modified: [], deleted: [], preExistingDirty: [] },
    inventory: null,
    diffSummary: "cps",
    execution: { nodesExecuted: ["N1"], testsExecuted: ["N1"], nodeResults: { passed: 1, failed: 0, total: 1 }, pass: true },
    verifier: { pass: true, result: "PASS", summary: "cps" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "cps", blockingFindings: [], summary: "cps" },
    repairAttempts: [],
    repairBudget: { maxAttempts: 1, used: 0 },
    repairLineage: { generationType: generation === "reseal" ? "surface-reseal" : "implementation", repairIterations: 0, surfaceReseals: generation === "reseal" ? 1 : 0, resealTouchedPaths: [] },
    externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes },
    negativeCases: [],
    regression: [],
    regressionSummary: "cps",
    evidence: [],
    security: { secretScanResult: "clean" },
    risks: [],
    limitations: [],
    rollbackProcedure: "cps",
    openQuestions: [],
    recommendedNextStep: "cps",
  };
  const b = renderReviewBundle(source);
  const path = join(outDir, `cps-bundle-${cardId}-${seq++}.txt`);
  writeFileSync(path, b.text, "utf8");
  assert.equal(validateReviewBundle(path, { authorizedDir: outDir }).ok, true, `minted ${cardId} bundle must validate`);
  return { path, identity: b.identity, sha256: b.sha256, cardId, generation, jobId };
}

function stateFor(bundle, { verdict = null, supersedes = null } = {}) {
  const s = buildExternalReviewState({ bundle: { identity: bundle.identity, sha256: bundle.sha256 }, bundlePath: bundle.path, deliveryAttempted: true, deliveryMethod: "external-review-surface", attemptedAt: "2026-08-17T00:00:00.000Z", supersedes });
  return recordDeliveryAttempt(s, { method: "external-review-surface", attemptedAt: "2026-08-17T00:00:00.000Z" });
}

function deliver(ctx, bundle, { supersedes = null } = {}) {
  return deliverToExternalReviewSurface({
    bundlePath: bundle.path,
    state: stateFor(bundle, { supersedes }),
    source: { task: { cardId: bundle.cardId }, evidence: [] },
    surfaceDir: ctx.surface,
  });
}

function surfaceCardId(ctx) {
  const p = join(ctx.surface, "delivery.json");
  if (!existsSync(p)) return null;
  const rec = readExternalReviewDeliveryRecord(p);
  return rec.ok ? rec.cardId : null;
}

function entry(ctx, cardId) {
  const st = reviewQueueStatus(ctx.surface);
  assert.equal(st.ok, true, st.reason ?? "");
  return st.queue.entries.find((e) => e.cardId === cardId) ?? null;
}

before(() => rmSync(ROOT, { recursive: true, force: true }));
after(() => rmSync(ROOT, { recursive: true, force: true }));

// ── 1. A completion -> Current = A ────────────────────────────────────────

test("1. A completion -> Current = A", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-1A", "Card A", ctx.bundles);
    const d = deliver(ctx, A);
    assert.equal(d.attempted, true, JSON.stringify(d));
    assert.equal(surfaceCardId(ctx), "CPS-1A", "Current = A immediately");
    assert.equal(entry(ctx, "CPS-1A").isLatestPresented, true, "A presented");
    assert.equal(entry(ctx, "CPS-1A").state, "PENDING", "A awaiting review");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 2. B completion -> Current = B without any A verdict ──────────────────

test("2. B completion -> Current = B（A unresolved, no verdict needed）", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-2A", "Card A", ctx.bundles);
    const B = mintBundle("CPS-2B", "Card B", ctx.bundles);
    deliver(ctx, A);
    const d = deliver(ctx, B);
    assert.equal(d.attempted, true, JSON.stringify(d));
    assert.equal(d.queued, undefined, "no queueing — publish-always");
    assert.equal(surfaceCardId(ctx), "CPS-2B", "Current = B with A still PENDING");
    assert.equal(entry(ctx, "CPS-2A").state, "PENDING", "A still pending");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 3. C completion -> Current = C without A/B verdicts ───────────────────

test("3. C completion -> Current = C（A/B unresolved）", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-3A", "Card A", ctx.bundles);
    const B = mintBundle("CPS-3B", "Card B", ctx.bundles);
    const C = mintBundle("CPS-3C", "Card C", ctx.bundles);
    deliver(ctx, A);
    deliver(ctx, B);
    deliver(ctx, C);
    assert.equal(surfaceCardId(ctx), "CPS-3C", "Current = C");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 4. A/B remain durable pending ─────────────────────────────────────────

test("4. A/B remain durable PENDING in the ledger（Current overwrite != review state loss）", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-4A", "Card A", ctx.bundles);
    const B = mintBundle("CPS-4B", "Card B", ctx.bundles);
    const C = mintBundle("CPS-4C", "Card C", ctx.bundles);
    deliver(ctx, A);
    deliver(ctx, B);
    deliver(ctx, C);
    const qr = readReviewQueue(ctx.surface);
    assert.equal(qr.ok, true);
    const a = qr.queue.entries.find((e) => e.cardId === "CPS-4A");
    const b = qr.queue.entries.find((e) => e.cardId === "CPS-4B");
    assert.equal(a.state, "PENDING", "A durable pending");
    assert.equal(a.bundleIdentity, A.identity, "A identity preserved");
    assert.equal(a.bundleSha256, A.sha256, "A sha preserved");
    assert.equal(b.state, "PENDING", "B durable pending");
    assert.equal(b.bundleIdentity, B.identity, "B identity preserved");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 5. verdict PASS on A while Current = C（ledger binding）────────────────

test("5. verdict PASS on A while Current = C -> A REVIEWED; Current stays C", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-5A", "Card A", ctx.bundles);
    const B = mintBundle("CPS-5B", "Card B", ctx.bundles);
    const C = mintBundle("CPS-5C", "Card C", ctx.bundles);
    deliver(ctx, A);
    deliver(ctx, B);
    deliver(ctx, C);
    const rot = rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "CPS-5A", identity: A.identity, verdict: "PASS" });
    assert.equal(rot.ok, true, `rotate ok (${rot.reason})`);
    assert.equal(entry(ctx, "CPS-5A").state, "REVIEWED", "A reviewed in ledger");
    assert.equal(entry(ctx, "CPS-5A").verdict.bundleIdentity, A.identity, "verdict identity-bound");
    assert.equal(surfaceCardId(ctx), "CPS-5C", "Current unchanged");
    assert.ok(rot.archived.some((p) => p.includes("CPS-5A") && p.includes("PASS")), "A archived");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 6. verdict PASS on B while Current = C ────────────────────────────────

test("6. verdict PASS on B while Current = C -> B REVIEWED; Current stays C", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-6A", "Card A", ctx.bundles);
    const B = mintBundle("CPS-6B", "Card B", ctx.bundles);
    const C = mintBundle("CPS-6C", "Card C", ctx.bundles);
    deliver(ctx, A);
    deliver(ctx, B);
    deliver(ctx, C);
    const rot = rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "CPS-6B", identity: B.identity, verdict: "PASS" });
    assert.equal(rot.ok, true, `rotate ok (${rot.reason})`);
    assert.equal(entry(ctx, "CPS-6B").state, "REVIEWED", "B reviewed");
    assert.equal(surfaceCardId(ctx), "CPS-6C", "Current unchanged");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 7. Current unchanged by old verdicts ──────────────────────────────────

test("7. old verdicts never change the presentation（no rollback to B/A）", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-7A", "Card A", ctx.bundles);
    const B = mintBundle("CPS-7B", "Card B", ctx.bundles);
    const C = mintBundle("CPS-7C", "Card C", ctx.bundles);
    deliver(ctx, A);
    deliver(ctx, B);
    deliver(ctx, C);
    const cSha = shaFile(join(ctx.surface, "review-bundle.txt"));
    rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "CPS-7A", identity: A.identity, verdict: "PASS" });
    rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "CPS-7B", identity: B.identity, verdict: "PASS" });
    assert.equal(surfaceCardId(ctx), "CPS-7C", "Current stays C");
    assert.equal(shaFile(join(ctx.surface, "review-bundle.txt")), cSha, "Current bytes unchanged");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 8. stale replay cannot regress Current ────────────────────────────────

test("8. stale older completion replay cannot regress Current from C to B", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-8A", "Card A", ctx.bundles);
    const B = mintBundle("CPS-8B", "Card B", ctx.bundles);
    const C = mintBundle("CPS-8C", "Card C", ctx.bundles);
    deliver(ctx, A);
    deliver(ctx, B);
    deliver(ctx, C);
    assert.equal(surfaceCardId(ctx), "CPS-8C");
    // re-deliver the OLDER completion B（same identity）— must NOT republish
    const d = deliver(ctx, B);
    assert.equal(d.attempted, true, "stale replay is a durable ledger no-op, not a failure");
    assert.equal(d.staleReplay, true, "flagged as stale replay");
    assert.equal(surfaceCardId(ctx), "CPS-8C", "Current not regressed to B");
    assert.equal(entry(ctx, "CPS-8B").isLatestPresented, false, "B not presented");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 9. crash before Current publish -> reconciliation republishes ────────

test("9. crash before Current publish -> reconciliation republishes the newest", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-9A", "Card A", ctx.bundles);
    const B = mintBundle("CPS-9B", "Card B", ctx.bundles);
    deliver(ctx, A);
    deliver(ctx, B);
    // crash: ledger persisted with B presented, Current trio wiped
    for (const f of readdirSync(ctx.surface)) rmSync(join(ctx.surface, f), { force: true });
    const r = reconcileReviewQueue({ surfaceDir: ctx.surface });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.promoted?.cardId, "CPS-9B", "newest republished");
    assert.equal(surfaceCardId(ctx), "CPS-9B", "Current recovered to B");
    assert.equal(shaFile(join(ctx.surface, "review-bundle.txt")), shaFile(B.path), "bytes verbatim");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 10. crash after Current publish -> ledger intact; reconcile idempotent ─

test("10. crash after Current publish -> ledger intact; reconcile is a no-op", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-10A", "Card A", ctx.bundles);
    const B = mintBundle("CPS-10B", "Card B", ctx.bundles);
    deliver(ctx, A);
    deliver(ctx, B);
    assert.equal(surfaceCardId(ctx), "CPS-10B", "B published");
    // restart: the trio is intact; reconciliation must not change anything
    const r = reconcileReviewQueue({ surfaceDir: ctx.surface });
    assert.equal(r.ok, true);
    assert.equal(r.promoted, null, "already_current — no republish");
    assert.equal(surfaceCardId(ctx), "CPS-10B", "Current unchanged");
    const qr = readReviewQueue(ctx.surface);
    assert.equal(qr.queue.entries.filter((e) => e.cardId === "CPS-10A" && e.state === "PENDING").length, 1, "A durable pending after restart");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 11/12. migration: old CURRENT / QUEUED -> PENDING ─────────────────────

test("11/12. deterministic migration: old CURRENT/QUEUED -> PENDING; ARCHIVED stays; presentation pointer derived", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-11A", "Card A", ctx.bundles);
    const B = mintBundle("CPS-11B", "Card B", ctx.bundles);
    const C = mintBundle("CPS-11C", "Card C", ctx.bundles);
    const legacy = {
      schema: "autoloop.review-queue/v1",
      updatedAt: null,
      nextOrder: 4,
      entries: [
        { entryId: "CPS-11A", cardId: "CPS-11A", surfaceDir: ctx.surface, generation: null, jobId: null, bundleIdentity: A.identity, bundleSha256: A.sha256, bundlePath: A.path, evidencePath: null, supersedes: null, supersededBy: null, order: 1, enqueuedAt: "2026-08-17T00:00:00.000Z", deliveredAt: "2026-08-17T00:00:00.000Z", state: "CURRENT", verdict: null, holdReason: null, updatedAt: "2026-08-17T00:00:00.000Z" },
        { entryId: "CPS-11B", cardId: "CPS-11B", surfaceDir: ctx.surface, generation: null, jobId: null, bundleIdentity: B.identity, bundleSha256: B.sha256, bundlePath: B.path, evidencePath: null, supersedes: null, supersededBy: null, order: 2, enqueuedAt: "2026-08-17T00:01:00.000Z", deliveredAt: null, state: "QUEUED", verdict: null, holdReason: null, updatedAt: "2026-08-17T00:01:00.000Z" },
        { entryId: "CPS-11C", cardId: "CPS-11C", surfaceDir: ctx.surface, generation: null, jobId: null, bundleIdentity: C.identity, bundleSha256: C.sha256, bundlePath: C.path, evidencePath: null, supersedes: null, supersededBy: null, order: 3, enqueuedAt: "2026-08-17T00:02:00.000Z", deliveredAt: null, state: "ARCHIVED", verdict: null, holdReason: null, updatedAt: "2026-08-17T00:02:00.000Z" },
      ],
      currentEntryId: "CPS-11A",
      latestEntryId: null,
    };
    const m = migrateReviewQueue(legacy);
    assert.equal(m.ok, true);
    assert.equal(m.migrated >= 3, true, "legacy states remapped");
    const a = m.queue.entries.find((e) => e.cardId === "CPS-11A");
    const b = m.queue.entries.find((e) => e.cardId === "CPS-11B");
    const c = m.queue.entries.find((e) => e.cardId === "CPS-11C");
    assert.equal(a.state, "PENDING", "old CURRENT -> PENDING");
    assert.equal(b.state, "PENDING", "old QUEUED -> PENDING");
    assert.equal(c.state, "ARCHIVED", "old ARCHIVED stays ARCHIVED");
    assert.equal(a.isLatestPresented, true, "presentation pointer = old currentEntryId");
    assert.equal(a.bundleIdentity, A.identity, "identity preserved");
    assert.equal(a.bundleSha256, A.sha256, "sha preserved");
    assert.equal(a.order, 1, "order preserved");
    assert.equal(b.supersedes, null, "supersession preserved");
    // a legacy queue with NO currentEntryId -> newest eligible by order presented
    //（deep copy — the first migration already mutated `legacy` in place）
    const legacy2 = structuredClone(legacy);
    legacy2.currentEntryId = null;
    const m2 = migrateReviewQueue(legacy2);
    const presented = m2.queue.entries.filter((e) => e.isLatestPresented === true);
    assert.equal(presented.length, 1, "exactly one presented");
    assert.equal(presented[0].cardId, "CPS-11C", "newest eligible（order 3）presented");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 13. archive lineage preserved ─────────────────────────────────────────

test("13. PASS archives the bundle + delivery record（lineage preserved, identity-bound）", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-13A", "Card A", ctx.bundles);
    deliver(ctx, A);
    rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "CPS-13A", identity: A.identity, verdict: "PASS" });
    const files = readdirSync(ctx.archive).filter((f) => f.includes("CPS-13A") && f.includes("PASS"));
    assert.ok(files.some((f) => f.endsWith("review-bundle.txt")), "bundle archived");
    assert.ok(files.some((f) => f.endsWith("delivery.json")), "delivery record archived");
    const recPath = join(ctx.archive, files.find((f) => f.endsWith("delivery.json")));
    const rec = readExternalReviewDeliveryRecord(recPath);
    assert.equal(rec.ok, true);
    assert.equal(rec.state.verdict.bundleIdentity, A.identity, "archived verdict identity-bound");
    assert.equal(rec.state.verdict.bundleSha256, A.sha256, "archived verdict sha-bound");
    assert.equal(entry(ctx, "CPS-13A").state, "REVIEWED", "ledger reviewed");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 14. supersession preserved ────────────────────────────────────────────

test("14. supersession lineage preserved on the successor entry; generation resets to PENDING", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-14A", "Card A", ctx.bundles);
    const sup = { reviewBundleIdentity: A.identity, reviewBundleSha256: A.sha256, bundlePath: A.path };
    const A2 = mintBundle("CPS-14A", "Card A v2 (reseal)", ctx.bundles, { generation: "reseal", supersedes: sup });
    deliver(ctx, A);
    const d = deliver(ctx, A2, { supersedes: sup });
    assert.equal(d.attempted, true, JSON.stringify(d));
    const e = entry(ctx, "CPS-14A");
    assert.equal(e.bundleIdentity, A2.identity, "successor referenced");
    assert.equal(e.supersedes?.reviewBundleIdentity, A.identity, "supersede binding preserved");
    assert.equal(e.supersedes?.bundlePath, A.path, "superseded artifact path preserved");
    assert.equal(e.state, "PENDING", "new generation awaits review");
    assert.equal(e.order, 1, "position preserved");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 15/16/17. LatestHuman separation + operator/formal report semantics ───

test("15/16/17. LatestHuman = latest completed report of ANY type; operator closeout never changes Current; formal publication updates Current", () => {
  const ctx = freshRoot();
  try {
    // 17: a formal review publication updates Current
    const F = mintBundle("CPS-17F", "Formal F", ctx.bundles);
    deliver(ctx, F);
    assert.equal(surfaceCardId(ctx), "CPS-17F", "formal publication -> Current = F");
    // 16: an operator closeout does NOT change Current
    const reportPath = join(ctx.bundles, "operator-report.txt");
    writeFileSync(reportPath, "=== OPERATOR CLOSEOUT ===\n", "utf8");
    const pub = publishHumanReport({
      cardId: "CPS-16OP",
      jobId: "CPS-16OP.g0001",
      reportType: "operator-closeout",
      sourcePath: reportPath,
      requiresExternalReview: false,
      surfaceDir: ctx.surface,
    });
    assert.equal(pub.ok, true, JSON.stringify(pub));
    assert.equal(surfaceCardId(ctx), "CPS-17F", "operator closeout does NOT change Current");
    // 15: LatestHuman separation — LatestHuman = operator report, Current = formal F
    const hs = humanReportStatus({ surfaceDir: ctx.surface });
    assert.equal(hs.ok, true, hs.reason ?? "");
    assert.equal(hs.report.cardId, "CPS-16OP", "LatestHuman = operator closeout");
    assert.equal(hs.report.reportType, "operator-closeout");
    assert.notEqual(hs.report.cardId, surfaceCardId(ctx), "LatestHuman != Current（separation preserved）");
    // a NEW formal completion updates BOTH（Current and LatestHuman）
    const G = mintBundle("CPS-17G", "Formal G", ctx.bundles);
    deliver(ctx, G);
    assert.equal(surfaceCardId(ctx), "CPS-17G", "Current = G");
    const hs2 = humanReportStatus({ surfaceDir: ctx.surface });
    assert.equal(hs2.report.cardId, "CPS-17G", "LatestHuman = G");
    assert.equal(hs2.report.reportType, "formal-review-bundle");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 18. review-bundle generation regression ───────────────────────────────

test("18. review-bundle generation regression: deterministic identity/sha; validator accepts", () => {
  const out = join(ROOT, "gen-18");
  mkdirSync(out, { recursive: true });
  const source = {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: { cardId: "CPS-18A", cardTitle: "Card A", cardType: "implementation" },
    graph: { graphRunId: "cps-18-fixed", nodeId: "N1", phaseExecutionId: "N1:1", stageIds: [], agentExecutionIds: [] },
    repo: { repository: "local", branch: "cps", head: "2e897e995202c0c8c079c5fdc96b9f5d42d50d25", treeSha: "7ca2c9100b208e15647ff1e0524ffc4e0857e7e0", worktreePath: out, baselineDirtyDigest: "dirty:cps", finalDirtyDigest: "dirty:cps", remote: null },
    objective: "CPS acceptance bundle regression",
    executiveStatus: "PASS",
    executiveSummary: "cps",
    authorizedScope: [],
    unauthorizedScope: [],
    designDecisions: [],
    files: { added: [], modified: [], deleted: [], preExistingDirty: [] },
    inventory: null,
    diffSummary: "cps",
    execution: { nodesExecuted: ["N1"], testsExecuted: ["N1"], nodeResults: { passed: 1, failed: 0, total: 1 }, pass: true },
    verifier: { pass: true, result: "PASS", summary: "cps" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "cps", blockingFindings: [], summary: "cps" },
    repairAttempts: [],
    repairBudget: { maxAttempts: 1, used: 0 },
    repairLineage: { generationType: "implementation", repairIterations: 0, surfaceReseals: 0, resealTouchedPaths: [] },
    externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null },
    negativeCases: [],
    regression: [],
    regressionSummary: "cps",
    evidence: [],
    security: { secretScanResult: "clean" },
    risks: [],
    limitations: [],
    rollbackProcedure: "cps",
    openQuestions: [],
    recommendedNextStep: "cps",
  };
  const pinned = { generatedAt: "2026-08-17T00:00:00.000Z" };
  const b1 = renderReviewBundle(source, pinned);
  const b2 = renderReviewBundle(source, pinned);
  assert.equal(b1.identity, b2.identity, "identity deterministic for identical source");
  assert.equal(b1.sha256, b2.sha256, "sha deterministic for identical source");
  const p1 = join(out, "b1.txt");
  const p2 = join(out, "b2.txt");
  writeFileSync(p1, b1.text, "utf8");
  writeFileSync(p2, b2.text, "utf8");
  assert.equal(validateReviewBundle(p1, { authorizedDir: out }).ok, true, "bundle validates");
  assert.equal(validateReviewBundle(p2, { authorizedDir: out }).ok, true, "bundle validates");
});

// ── 19. queue/ledger regression ───────────────────────────────────────────

test("19. queue/ledger regression: monotonic completion order + durable identities across restart", () => {
  const ctx = freshRoot();
  try {
    const A = mintBundle("CPS-19A", "Card A", ctx.bundles);
    const B = mintBundle("CPS-19B", "Card B", ctx.bundles);
    const C = mintBundle("CPS-19C", "Card C", ctx.bundles);
    deliver(ctx, A);
    deliver(ctx, B);
    deliver(ctx, C);
    const qr = readReviewQueue(ctx.surface);
    assert.equal(qr.ok, true);
    const pend = qr.queue.entries.filter((e) => e.state === "PENDING").sort((x, y) => x.order - y.order);
    assert.deepEqual(pend.map((e) => e.cardId), ["CPS-19A", "CPS-19B", "CPS-19C"], "ordering preserved");
    assert.equal(pend[0].bundleIdentity, A.identity, "A identity preserved");
    assert.equal(pend[1].bundleIdentity, B.identity, "B identity preserved");
    assert.equal(pend[2].bundleIdentity, C.identity, "C identity preserved");
    assert.ok(pend[0].order < pend[1].order && pend[1].order < pend[2].order, "monotonic order");
    assert.equal(presentedEntry(qr.queue, ctx.surface).cardId, "CPS-19C", "presented = newest");
    assert.deepEqual(pendingEntries(qr.queue, ctx.surface).map((e) => e.cardId), ["CPS-19A", "CPS-19B", "CPS-19C"], "navigation metadata intact");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 20. pre-convention bundle（PC1-shaped）presented directly, no old PASS ─

test("20. a pre-convention closeout bundle（PC1-shaped）is presented directly — no old review PASS required", () => {
  const ctx = freshRoot();
  try {
    // A non-schema closeout artifact（like the live PC1 card closeout）:
    // delivered with explicit content identities（deterministic, never
    // guessed）— the seam the production CLI exposes as --force
    // --identity/--sha256. It is presented WITHOUT any prior review PASS.
    const pc1Path = join(ctx.bundles, "pc1-closeout.txt");
    const pc1Text = "AUTOLOOP-DECOMP-OPT1-PC1 — CARD CLOSEOUT\nPARENT_TO_CHILD_CONTEXT_AND_EVIDENCE_INHERITANCE_CONVERGED\n";
    writeFileSync(pc1Path, pc1Text, "utf8");
    const pc1Sha = shaFile(pc1Path);
    const state = stateFor({ path: pc1Path, identity: pc1Sha, sha256: pc1Sha, cardId: "PARENT_TO_CHILD_CONTEXT_AND_EVIDENCE_INHERITANCE_CONVERGED" });
    const d = deliverToExternalReviewSurface({
      bundlePath: pc1Path,
      state,
      source: { task: { cardId: "PARENT_TO_CHILD_CONTEXT_AND_EVIDENCE_INHERITANCE_CONVERGED" }, evidence: [] },
      surfaceDir: ctx.surface,
    });
    assert.equal(d.attempted, true, `PC1 presented (${d.reason ?? ""})`);
    assert.equal(surfaceCardId(ctx), "PARENT_TO_CHILD_CONTEXT_AND_EVIDENCE_INHERITANCE_CONVERGED", "Current = PC1 directly");
    assert.equal(bundleContentSha256(join(ctx.surface, "review-bundle.txt")), pc1Sha, "PC1 bytes presented verbatim");
    const e = entry(ctx, "PARENT_TO_CHILD_CONTEXT_AND_EVIDENCE_INHERITANCE_CONVERGED");
    assert.equal(e.state, "PENDING", "PC1 pending in ledger");
    // no old review was required to be PASSed（nothing else on the ledger）
    assert.equal(readReviewQueue(ctx.surface).queue.entries.length, 1, "only PC1 in the ledger");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});
