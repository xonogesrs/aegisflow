// test/governance/test-human-report-handoff.mjs
//
// REVIEW-LATEST-HUMAN-HANDOFF-1 — Latest Human Report decoupled from Current.
//
// Model under test（src/governance/human-report.mjs + the F1 wiring in
// src/governance/review-bundle.mjs deliverToExternalReviewSurface）:
//   Current/     = the review awaiting an external verdict（never overwritten
//                  while unresolved）
//   Queue/       = formal reviews waiting to become Current
//   LatestHuman/ = the NEWEST completed work report shown to the user
//                  （latest-report.txt bytes + latest-report.json pointer）
//
// Core invariant under test: LATEST != CURRENT. New work（formal bundle OR
// operator closeout）updates LatestHuman while Current/Queue authority is
// untouched. Publication is atomic, idempotent, stale-replay guarded and
// fail-closed.
//
// Env isolation: every scenario uses its own surface root（tmp）— the human
// report dir derives as <surface-root>/LatestHuman, so nothing touches the
// real Desktop surface.
//
// Run: node --test test/governance/test-human-report-handoff.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderReviewBundle,
  validateReviewBundle,
  buildExternalReviewState,
  recordDeliveryAttempt,
  deliverToExternalReviewSurface,
  readExternalReviewDeliveryRecord,
  REVIEW_BUNDLE_SOURCE_SCHEMA,
} from "../../src/governance/review-bundle.mjs";
import {
  reviewQueueStatus,
  readLatestPointer,
} from "../../src/governance/review-queue.mjs";
import {
  publishHumanReport,
  readHumanReport,
  humanReportStatus,
} from "../../src/governance/human-report.mjs";

let seq = 0;

/** Fresh isolated surface + queue + bundles root per scenario. */
function freshRoot() {
  const root = join(tmpdir(), `hrh-${process.pid}-${Date.now()}-${seq++}`);
  const surface = join(root, "Current");
  const archive = join(root, "Archive");
  const queue = join(root, "Queue");
  const bundles = join(root, "bundles");
  for (const d of [surface, archive, queue, bundles]) mkdirSync(d, { recursive: true });
  return { root, surface, archive, queue, bundles, human: join(root, "LatestHuman") };
}

function mintBundle(cardId, title, outDir) {
  const source = {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: { cardId, cardTitle: title, cardType: "implementation" },
    graph: { graphRunId: `hrh-${cardId}-${seq++}`, nodeId: "N1", phaseExecutionId: "N1:1", stageIds: [], agentExecutionIds: [] },
    repo: { repository: "local", branch: "hrh", head: "2e897e995202c0c8c079c5fdc96b9f5d42d50d25", treeSha: "7ca2c9100b208e15647ff1e0524ffc4e0857e7e0", worktreePath: outDir, baselineDirtyDigest: "dirty:hrh", finalDirtyDigest: "dirty:hrh", remote: null },
    objective: "HRH test bundle for " + cardId,
    executiveStatus: "PASS",
    executiveSummary: "hrh " + cardId,
    authorizedScope: [],
    unauthorizedScope: [],
    designDecisions: [],
    files: { added: [], modified: [], deleted: [], preExistingDirty: [] },
    inventory: null,
    diffSummary: "hrh",
    execution: { nodesExecuted: ["N1"], testsExecuted: ["N1"], nodeResults: { passed: 1, failed: 0, total: 1 }, pass: true },
    verifier: { pass: true, result: "PASS", summary: "hrh" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "hrh", blockingFindings: [], summary: "hrh" },
    repairAttempts: [],
    repairBudget: { maxAttempts: 1, used: 0 },
    repairLineage: { generationType: "implementation", repairIterations: 0, surfaceReseals: 0, resealTouchedPaths: [] },
    externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null },
    negativeCases: [],
    regression: [],
    regressionSummary: "hrh",
    evidence: [],
    security: { secretScanResult: "clean" },
    risks: [],
    limitations: [],
    rollbackProcedure: "hrh",
    openQuestions: [],
    recommendedNextStep: "hrh",
  };
  const b = renderReviewBundle(source);
  const path = join(outDir, `hrh-bundle-${cardId}-${seq++}.txt`);
  writeFileSync(path, b.text, "utf8");
  assert.equal(validateReviewBundle(path, { authorizedDir: outDir }).ok, true, `minted ${cardId} bundle must validate`);
  return { path, identity: b.identity, sha256: b.sha256, cardId };
}

function stateFor(bundle) {
  return recordDeliveryAttempt(
    buildExternalReviewState({ bundle: { identity: bundle.identity, sha256: bundle.sha256 }, bundlePath: bundle.path, deliveryAttempted: true, deliveryMethod: "external-review-surface", attemptedAt: "2026-08-16T00:00:00.000Z" }),
    { method: "external-review-surface", attemptedAt: "2026-08-16T00:00:00.000Z" },
  );
}

function deliver(ctx, bundle, { generation = null, jobId = null } = {}) {
  return deliverToExternalReviewSurface({
    bundlePath: bundle.path,
    state: stateFor(bundle),
    source: { task: { cardId: bundle.cardId }, evidence: [] },
    surfaceDir: ctx.surface,
    generation,
    jobId,
  });
}

function humanLatest(ctx) {
  const r = readHumanReport({ surfaceDir: ctx.surface });
  return r.ok ? r.report : null;
}

const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function surfaceOccupant(ctx) {
  if (!existsSync(join(ctx.surface, "delivery.json"))) return null;
  const rec = readExternalReviewDeliveryRecord(join(ctx.surface, "delivery.json"));
  return rec.ok ? { cardId: rec.cardId, state: rec.state } : null;
}

function writeOperatorReport(ctx, cardId, text) {
  const p = join(ctx.bundles, `${cardId}-report.txt`);
  writeFileSync(p, text, "utf8");
  return p;
}

// ── 1. Formal review updates Latest ───────────────────────────────────────

test("N1. formal review delivery updates Latest Human Report", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("HRH-N1A", "Task A", ctx.bundles);
    const d = deliver(ctx, a);
    assert.equal(d.attempted, true, JSON.stringify(d));
    assert.equal(d.humanReportError, null, `human publish must succeed: ${d.humanReportError}`);
    const latest = humanLatest(ctx);
    assert.ok(latest, "LatestHuman must exist after formal delivery");
    assert.equal(latest.cardId, "HRH-N1A");
    assert.equal(latest.reportIdentity, a.identity);
    assert.equal(latest.sha256, shaFile(a.path), "pointer sha = actual published bytes");
    assert.equal(latest.reportType, "formal-review-bundle");
    assert.equal(latest.requiresExternalReview, true);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 2. QUEUED review still updates Latest ─────────────────────────────────

test("N2. queued formal review still updates Latest Human Report", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("HRH-N2A", "Task A", ctx.bundles);
    const b = mintBundle("HRH-N2B", "Task B", ctx.bundles);
    assert.equal(deliver(ctx, a).attempted, true);
    const d2 = deliver(ctx, b);
    assert.equal(d2.attempted, true, JSON.stringify(d2));
    assert.equal(d2.queued, true, "B must queue behind the unresolved A");
    assert.equal(d2.humanReportError, null, JSON.stringify(d2.humanReportError));
    const latest = humanLatest(ctx);
    assert.equal(latest.cardId, "HRH-N2B", "Latest = newest generated review (B), not the Current occupant (A)");
    assert.equal(latest.reportIdentity, b.identity);
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.pending.length, 1, "B sits in the queue");
    assert.equal(st.pending[0].cardId, "HRH-N2B");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 3. Unresolved Current remains unchanged ───────────────────────────────

test("N3. unresolved Current authority is untouched by Latest publication", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("HRH-N3A", "Task A", ctx.bundles);
    const b = mintBundle("HRH-N3B", "Task B", ctx.bundles);
    assert.equal(deliver(ctx, a).attempted, true);
    const aShaBefore = shaFile(join(ctx.surface, "review-bundle.txt"));
    assert.equal(deliver(ctx, b).queued, true);
    const occ = surfaceOccupant(ctx);
    assert.equal(occ.cardId, "HRH-N3A", "Current occupant unchanged");
    assert.equal(occ.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
    assert.equal(shaFile(join(ctx.surface, "review-bundle.txt")), aShaBefore, "Current bundle bytes unchanged");
    assert.equal(occ.state.delivery.reviewBundleIdentity, a.identity);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 4. Non-review operator closeout updates Latest ────────────────────────

test("N4. operator closeout（no external review）updates Latest Human Report", () => {
  const ctx = freshRoot();
  try {
    // Current occupied by an unresolved formal review.
    const a = mintBundle("HRH-N4A", "Task A", ctx.bundles);
    assert.equal(deliver(ctx, a).attempted, true);
    const reportPath = writeOperatorReport(ctx, "HRH-N4C", "REPORT C — operator closeout, EXTERNAL_REVIEW_REQUIRED = NO\n");
    const r = publishHumanReport({
      cardId: "HRH-N4C",
      jobId: "HRH-N4C.g0001",
      reportType: "operator-closeout",
      sourcePath: reportPath,
      requiresExternalReview: false,
      currentReviewState: null,
      createdAt: "2026-08-16T03:00:00.000Z",
      surfaceDir: ctx.surface,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const latest = humanLatest(ctx);
    assert.equal(latest.cardId, "HRH-N4C", "operator closeout becomes Latest, NOT the Current occupant");
    assert.equal(latest.sha256, shaFile(reportPath));
    assert.equal(latest.reportType, "operator-closeout");
    assert.equal(latest.requiresExternalReview, false);
    const occ = surfaceOccupant(ctx);
    assert.equal(occ.cardId, "HRH-N4A", "Current untouched");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 5. Stale report cannot replace newer Latest ───────────────────────────

test("N5. older report cannot replay over a newer Latest", () => {
  const ctx = freshRoot();
  try {
    const reportB = writeOperatorReport(ctx, "HRH-N5B", "REPORT B (newer)\n");
    const r1 = publishHumanReport({ cardId: "HRH-N5B", reportType: "operator-closeout", sourcePath: reportB, publishedAt: "2026-08-16T05:00:00.000Z", surfaceDir: ctx.surface });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const reportC = writeOperatorReport(ctx, "HRH-N5C", "REPORT C (newest)\n");
    const r2 = publishHumanReport({ cardId: "HRH-N5C", reportType: "operator-closeout", sourcePath: reportC, publishedAt: "2026-08-16T06:00:00.000Z", surfaceDir: ctx.surface });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    // stale replay: older report D attempts to overwrite C
    const reportD = writeOperatorReport(ctx, "HRH-N5D", "REPORT D (stale)\n");
    const r3 = publishHumanReport({ cardId: "HRH-N5D", reportType: "operator-closeout", sourcePath: reportD, publishedAt: "2026-08-16T04:00:00.000Z", surfaceDir: ctx.surface });
    assert.equal(r3.ok, false);
    assert.equal(r3.holdCode, "HUMAN_REPORT_STALE_REPLAY");
    const latest = humanLatest(ctx);
    assert.equal(latest.cardId, "HRH-N5C", "newest report preserved");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 6. Duplicate publication is idempotent ────────────────────────────────

test("N6. duplicate publication is idempotent（publishedAt preserved）", () => {
  const ctx = freshRoot();
  try {
    const report = writeOperatorReport(ctx, "HRH-N6A", "REPORT A\n");
    const r1 = publishHumanReport({ cardId: "HRH-N6A", reportType: "operator-closeout", sourcePath: report, publishedAt: "2026-08-16T07:00:00.000Z", surfaceDir: ctx.surface });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const r2 = publishHumanReport({ cardId: "HRH-N6A", reportType: "operator-closeout", sourcePath: report, publishedAt: "2026-08-16T07:00:00.000Z", surfaceDir: ctx.surface });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.alreadyCurrent, true, "second identical publish is a no-op");
    const latest = humanLatest(ctx);
    assert.equal(latest.publishedAt, "2026-08-16T07:00:00.000Z");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 7. Crash safety / fail-closed ─────────────────────────────────────────

test("N7a. missing report bytes fail closed（no publish）", () => {
  const ctx = freshRoot();
  try {
    const r = publishHumanReport({ cardId: "HRH-N7A", reportType: "operator-closeout", sourcePath: join(ctx.bundles, "does-not-exist.txt"), surfaceDir: ctx.surface });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, "HUMAN_REPORT_SOURCE_MISSING");
    assert.equal(existsSync(join(ctx.human, "latest-report.json")), false, "no pointer written on failure");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("N7b. corrupt latest pointer fails closed on read", () => {
  const ctx = freshRoot();
  try {
    const report = writeOperatorReport(ctx, "HRH-N7B", "REPORT B\n");
    assert.equal(publishHumanReport({ cardId: "HRH-N7B", reportType: "operator-closeout", sourcePath: report, publishedAt: "2026-08-16T08:00:00.000Z", surfaceDir: ctx.surface }).ok, true);
    writeFileSync(join(ctx.human, "latest-report.json"), "{ not json", "utf8");
    const rd = readHumanReport({ surfaceDir: ctx.surface });
    assert.equal(rd.ok, false);
    assert.equal(rd.holdCode, "HUMAN_REPORT_POINTER_CORRUPT");
    // publish refuses to clobber a corrupt pointer without force
    const r2 = publishHumanReport({ cardId: "HRH-N7C", reportType: "operator-closeout", sourcePath: writeOperatorReport(ctx, "HRH-N7C", "REPORT C\n"), publishedAt: "2026-08-16T09:00:00.000Z", surfaceDir: ctx.surface });
    assert.equal(r2.ok, false);
    assert.equal(r2.holdCode, "HUMAN_REPORT_POINTER_CORRUPT");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("N7c. corrupt pointer + force clears it and publishes", () => {
  const ctx = freshRoot();
  try {
    mkdirSync(ctx.human, { recursive: true });
    writeFileSync(join(ctx.human, "latest-report.json"), "garbage", "utf8");
    const report = writeOperatorReport(ctx, "HRH-N7D", "REPORT D\n");
    const r = publishHumanReport({ cardId: "HRH-N7D", reportType: "operator-closeout", sourcePath: report, publishedAt: "2026-08-16T10:00:00.000Z", surfaceDir: ctx.surface, force: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const latest = humanLatest(ctx);
    assert.equal(latest.cardId, "HRH-N7D");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

test("N7d. tampered bytes fail closed on read", () => {
  const ctx = freshRoot();
  try {
    const report = writeOperatorReport(ctx, "HRH-N7E", "REPORT E\n");
    assert.equal(publishHumanReport({ cardId: "HRH-N7E", reportType: "operator-closeout", sourcePath: report, publishedAt: "2026-08-16T11:00:00.000Z", surfaceDir: ctx.surface }).ok, true);
    writeFileSync(join(ctx.human, "latest-report.txt"), "TAMPERED\n", "utf8");
    const rd = readHumanReport({ surfaceDir: ctx.surface });
    assert.equal(rd.ok, false);
    assert.equal(rd.holdCode, "HUMAN_REPORT_SHA_MISMATCH");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 8. delivery + queue regression（smoke inside this suite）───────────────

test("N8. formal delivery still honors Current/Queue semantics", () => {
  const ctx = freshRoot();
  try {
    const a = mintBundle("HRH-N8A", "Task A", ctx.bundles);
    const b = mintBundle("HRH-N8B", "Task B", ctx.bundles);
    const c = mintBundle("HRH-N8C", "Task C", ctx.bundles);
    const d1 = deliver(ctx, a);
    assert.equal(d1.attempted, true);
    assert.equal(d1.queued, undefined);
    assert.equal(deliver(ctx, b).queued, true);
    assert.equal(deliver(ctx, b).attempted, true, "idempotent re-delivery of B");
    assert.equal(deliver(ctx, c).queued, true);
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.pending.length, 2, "B and C pending");
    const latest = readLatestPointer(ctx.surface);
    assert.ok(latest.ok, "queue Latest pointer still navigates");
    assert.equal(latest.latest.cardId, "HRH-N8C", "queue Latest pointer = newest formal review (unchanged semantics)");
    const occ = surfaceOccupant(ctx);
    assert.equal(occ.cardId, "HRH-N8A");
    const human = humanLatest(ctx);
    assert.equal(human.cardId, "HRH-N8C", "Latest Human = C while Current = A");
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});

// ── 9/10. real A→B→C live dogfood + user-facing retrieval ─────────────────

test("N9/N10. A→B→C live sequence: Latest follows work, Current preserved, user retrieval returns C", () => {
  const ctx = freshRoot();
  try {
    // G1 baseline: no human artifact yet
    const base = humanReportStatus({ surfaceDir: ctx.surface });
    assert.equal(base.ok, false);
    assert.equal(base.holdCode, "HUMAN_REPORT_ABSENT");

    // G2 Run A: a real bounded operator closeout
    const reportA = writeOperatorReport(ctx, "REPORT_A", "=== REPORT A ===\nAUTO-EXECUTION-COMPLETE: A\n");
    const aPub = publishHumanReport({
      cardId: "REPORT_A",
      jobId: "REPORT_A.g0001",
      reportType: "operator-closeout",
      sourcePath: reportA,
      requiresExternalReview: false,
      currentReviewState: null,
      createdAt: new Date().toISOString(),
      publishedAt: new Date(Date.now() + 1).toISOString(),
      surfaceDir: ctx.surface,
    });
    assert.equal(aPub.ok, true, JSON.stringify(aPub));
    let latest = humanLatest(ctx);
    assert.equal(latest.cardId, "REPORT_A", "G2: Latest = A");
    assert.equal(latest.sha256, shaFile(reportA));
    const idA = latest.reportIdentity;
    const shaA = latest.sha256;

    // G3 Run B while Current unresolved（simulate: formal bundle B queued）
    const cur = mintBundle("REPORT_CURRENT", "Unresolved Current A", ctx.bundles);
    assert.equal(deliver(ctx, cur).attempted, true, "Current occupied by unresolved review");
    const bBundle = mintBundle("REPORT_B", "Task B (formal)", ctx.bundles);
    const dB = deliver(ctx, bBundle, { jobId: "REPORT_B.g0001" });
    assert.equal(dB.attempted, true, JSON.stringify(dB));
    assert.equal(dB.queued, true, "B queues behind unresolved Current");
    latest = humanLatest(ctx);
    assert.equal(latest.cardId, "REPORT_B", "G3: Latest = B while Current untouched");
    assert.equal(latest.reportIdentity, bBundle.identity);
    const idB = latest.reportIdentity;
    const shaB = latest.sha256;
    const occ = surfaceOccupant(ctx);
    assert.equal(occ.cardId, "REPORT_CURRENT", "G3: Current authority unchanged");
    const st = reviewQueueStatus(ctx.surface);
    assert.equal(st.pending[0]?.cardId, "REPORT_B", "B formally queued");

    // G4 Run C — non-review operator closeout
    const reportC = writeOperatorReport(ctx, "REPORT_C", "=== REPORT C ===\nCLOSEOUT-COMPLETE: C (EXTERNAL_REVIEW_REQUIRED=NO)\n");
    const cPub = publishHumanReport({
      cardId: "REPORT_C",
      jobId: "REPORT_C.g0001",
      reportType: "operator-closeout",
      sourcePath: reportC,
      requiresExternalReview: false,
      currentReviewState: null,
      createdAt: new Date().toISOString(),
      publishedAt: new Date(Date.now() + 2).toISOString(),
      surfaceDir: ctx.surface,
    });
    assert.equal(cPub.ok, true, JSON.stringify(cPub));
    latest = humanLatest(ctx);
    assert.equal(latest.cardId, "REPORT_C", "G4: Latest = C");
    assert.equal(latest.reportIdentity, shaFile(reportC), "operator report identity is content-addressed");
    const idC = latest.reportIdentity;
    const shaC = latest.sha256;

    // H. identity proof: A != B != C; shas distinct; publishedAt increasing
    assert.notEqual(idA, idB);
    assert.notEqual(idB, idC);
    assert.notEqual(shaA, shaB);
    assert.notEqual(shaB, shaC);
    const t = (iso) => new Date(iso).getTime();
    assert.ok(t(aPub.report.publishedAt) < t(dB.attemptedAt), "publishedAt A < B");
    assert.ok(t(dB.attemptedAt) < t(cPub.report.publishedAt), "publishedAt B < C");

    // J. user-facing retrieval（readHumanReport IS the handoff read path）returns C
    const userView = readHumanReport({ surfaceDir: ctx.surface });
    assert.equal(userView.ok, true, JSON.stringify(userView));
    assert.equal(userView.report.cardId, "REPORT_C", "user receives C, not the stale Current");
    assert.equal(userView.report.reportIdentity, idC);
    assert.equal(userView.report.sha256, shaC);
    assert.ok(userView.text.includes("REPORT C"), "report bytes are C's");
    assert.notEqual(userView.report.reportIdentity, "413ab9acdef5171caaeecc55a22875ba870dfbed0f7913c0d04fbb7b126c4138");

    // I. invariants: Current untouched, queue intact
    assert.equal(surfaceOccupant(ctx).cardId, "REPORT_CURRENT");
    assert.equal(shaFile(join(ctx.surface, "review-bundle.txt")), shaFile(cur.path), "Current bundle bytes untouched");
    assert.equal(st.pending.length, 1);
  } finally { rmSync(ctx.root, { recursive: true, force: true }); }
});
