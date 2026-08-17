// test/governance/test-external-review-surface.mjs
//
// RB-1H — fixed external-review delivery surface（Current/ + Archive/）.
//
// The reviewer's inbox is ONE fixed location:
//   Current/review-bundle.txt + delivery.json + evidence.json
//   Archive/YYYYMMDD-<CARD>-<identity8>-<VERDICT>-<kind>（flat）
// Hard rule: a requiresReview closeout MUST atomically deliver the current
// valid bundle to the fixed surface（runCloseoutGate's default surface
// deliverer）; a failed surface write keeps the card at
// AWAITING_BUNDLE_DELIVERY. After a verdict the surface is rotated into
// Archive/ — Current/ never retains the previous card.
//
// RB-1H repair（atomic-publication / concurrency contract）:
//   - single-owner publication lock（O_EXCL in the surface's PARENT）;
//     a concurrent delivery fails surface_busy, never overwrites
//   - occupancy fail-closed: an un-rotated published trio is never overwritten
//     （surface_occupied）
//   - trio built in invisible staging（parent/.incoming-<token>）then exposed
//     by ONE directory-level rename — the reviewer can never observe a mixed
//     trio or a partial publication
//   - stale lock（dead pid）broken; live lock blocks
//
// Coverage:
//   1. requiresReview closeout default-delivers to Current/（atomic trio）
//   2. surface write failure -> AWAITING_BUNDLE_DELIVERY（fail-closed）
//   3. rotate PASS -> flat Archive naming + Current cleared
//   4. rotate REPAIR -> old card archived; new repair bundle replaces Current
//   5. standalone surface delivery（bundle generated before the convention）
//   6. rotate HOLD on abandonment archives the held card
//   7. concurrent delivery -> only ONE succeeds（surface_busy）
//   8. occupied surface -> second delivery refused; first trio untouched
//   9. observer/crash: no mixed trio; stale staging leftovers cleaned
//   10. stale lock（dead pid）broken; live lock blocks
//
// Run: node --test test/governance/test-external-review-surface.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  runMandatoryGraphCloseout,
  collectRepoFacts,
  validateReviewBundle,
  buildExternalReviewState,
  recordDeliveryAttempt,
  applyExternalReviewVerdict,
  externalReviewComplete,
  buildSupersedeRecord,
  readExternalReviewDeliveryRecord,
  supersedesFromBundleText,
  deliverToExternalReviewSurface,
  rotateExternalReviewSurface,
  acquireExternalReviewSurfaceLock,
  releaseExternalReviewSurfaceLock,
} from "../../src/governance/review-bundle.mjs";

const REPO_A = "/Volumes/NVM2T/Development/autoloop";
const ROOT = `${tmpdir()}/rb1h-surface-${process.pid}`;
const OUT = join(ROOT, "out");
const ARCHIVE = join(ROOT, "archive");
const surface = (n) => join(ROOT, `surface-${n}`);

const facts = collectRepoFacts(REPO_A);
const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const passGraph = {
  executionId: "fixture-rb1h-pass-1",
  final: "PASS",
  holdCode: null,
  reason: null,
  scheduler: {
    verdict: "PASS",
    order: ["R1", "W1", "V1"],
    statuses: { R1: "passed", W1: "passed", V1: "passed" },
    skipped: [],
    writerViolations: [],
    leaseHolderAfter: null,
  },
  nodeResults: [
    {
      nodeId: "R1", phaseExecutionId: "exec_rb1h_r1", taskType: "audit_surface", dependencies: [],
      final: "PASS", attempt: 0, reason: null, startedAt: 1, completedAt: 2,
      cleanup: { worktreeRevoked: false },
      subagentResult: { status: "PASS", testResults: null, testsExecuted: [] },
    },
    {
      nodeId: "W1", phaseExecutionId: "exec_rb1h_w1", taskType: "write_surface", dependencies: ["R1"],
      final: "PASS", attempt: 0, reason: null, startedAt: 3, completedAt: 4,
      worktreeIdentity: { verified: true, output: { files: [{ status: " M", path: "src/governance/review-bundle.mjs", source: null, destination: null, rename: false }] } },
      cleanup: { worktreeRevoked: true },
      subagentResult: { status: "PASS", testResults: { passed: 1, failed: 0, total: 1 }, testsExecuted: ["self-test"] },
      reviewResult: { status: "PASS", findings: [], blockingFindings: [], scopeVerified: true, testsVerified: true, recommendedAction: "PASS", summary: "independent review PASS" },
    },
    {
      nodeId: "V1", phaseExecutionId: "exec_rb1h_v1", taskType: "verify_surface", dependencies: ["W1"],
      final: "PASS", attempt: 0, reason: null, startedAt: 5, completedAt: 6,
      cleanup: { worktreeRevoked: false },
      subagentResult: { status: "PASS", testResults: { passed: 1, failed: 0, total: 1 }, testsExecuted: [] },
    },
  ],
  transitions: [
    { phaseId: "R1", final: "PASS", attempt: 0, lifecycleTransitions: [{ phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" }] },
    { phaseId: "W1", final: "PASS", attempt: 0, lifecycleTransitions: [{ phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" }] },
    { phaseId: "V1", final: "PASS", attempt: 0, lifecycleTransitions: [{ phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" }] },
  ],
};

const closeoutOpts = (n, overrides = {}) => ({
  requiresReview: true,
  cardId: `RB-1H-TEST-${n}`,
  cardTitle: "Fixed External Review Surface",
  cardType: "implementation",
  objective: "verify the fixed external-review delivery surface convention",
  authorizedScope: ["src/governance/review-bundle.mjs", "test/governance/test-external-review-surface.mjs"],
  unauthorizedScope: ["commit", "push", "merge", "seal"],
  designDecisions: ["Current/ is the single reviewer inbox; Archive/ is flat"],
  negativeCases: ["no surface delivery -> AWAITING_BUNDLE_DELIVERY"],
  regression: [{ suite: "test:governance", tests: 1, pass: 1, fail: 0 }],
  regressionSummary: "focused tests pass",
  recommendedNextStep: "CBM-2R external review",
  surfaceDir: surface(n),
  ...overrides,
});

const run = (n, overrides = {}) => runMandatoryGraphCloseout({
  graphResult: passGraph,
  closeout: closeoutOpts(n, overrides.closeout),
  repoPath: REPO_A,
  outDir: OUT,
  timeoutMs: overrides.timeoutMs ?? 8000,
});

// Build a delivery state for a standalone bundle artifact（test helper）.
const stateFor = (bundlePath, cardId = "RB-1H-TEST") => {
  const txt = readFileSync(bundlePath, "utf8");
  const identity = txt.match(/^REVIEW_BUNDLE_IDENTITY: ([0-9a-f]{64})$/m)?.[1];
  const shaLines = txt.split("\n");
  const shaLine = [...shaLines].reverse().find((l) => l.startsWith("REVIEW_BUNDLE_SHA256:"));
  const sha = shaLine.split(":")[1]?.trim();
  const parsed = supersedesFromBundleText(txt);
  assert.equal(parsed.error, null);
  return {
    state: recordDeliveryAttempt(buildExternalReviewState({ bundle: { identity, sha256: sha }, bundlePath, supersedes: parsed.supersedes }), { method: "external-review-surface", attemptedAt: "2026-08-07T18:00:00.000Z" }),
    identity,
    sha,
  };
};

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(ARCHIVE, { recursive: true });
  process.env.AUTOLOOP_REVIEW_SURFACE = surface(0);
  process.env.AUTOLOOP_REVIEW_ARCHIVE = ARCHIVE;
});
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
});

// ── 1. requiresReview default-delivers to the fixed surface ────────────────

test("1. requiresReview closeout default-delivers to Current/（review-bundle + delivery + evidence）", { timeout: 30000 }, async () => {
  const r = await run(1);
  assert.equal(r.final, "PASS", `bundle gate PASS (${r.reason})`);
  assert.equal(r.externalReview.delivery.attempted, true, "default surface delivery attempted");
  assert.equal(r.externalReview.delivery.method, "external-review-surface", "surface method recorded");
  const dir = surface(1);
  assert.ok(existsSync(join(dir, "review-bundle.txt")), "Current/review-bundle.txt");
  assert.ok(existsSync(join(dir, "delivery.json")), "Current/delivery.json");
  assert.ok(existsSync(join(dir, "evidence.json")), "Current/evidence.json");
  assert.equal(shaFile(join(dir, "review-bundle.txt")), shaFile(r.bundlePath), "surface copy == validated bundle bytes");
  const rec = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(rec.ok, true, `delivery.json readable (${rec.errors.join(";")})`);
  assert.equal(rec.state.delivery.reviewBundleIdentity, r.externalReview.delivery.reviewBundleIdentity);
  assert.equal(rec.state.delivery.reviewBundleSha256, r.externalReview.delivery.reviewBundleSha256);
  assert.equal(rec.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  const ev = JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8"));
  assert.equal(ev.schema, "autoloop.review-bundle.graph-closeout-evidence/v1");
});

// ── 2. surface write failure -> AWAITING_BUNDLE_DELIVERY（hard rule）────────

test("2. surface write failure -> AWAITING_BUNDLE_DELIVERY（never a delivered claim）", { timeout: 30000 }, async () => {
  const blocked = join(ROOT, "blocked-surface");
  writeFileSync(blocked, "i am a file, not a dir", "utf8");
  const r = await run(2, { closeout: { cardId: "RB-1H-TEST-2", surfaceDir: blocked } });
  assert.equal(r.externalReview.externalReviewStatus, "AWAITING_BUNDLE_DELIVERY", "hard rule: no surface -> AWAITING_BUNDLE_DELIVERY");
  assert.equal(r.externalReview.delivery.attempted, false, "no attempted claim on a failed write");
  assert.equal(externalReviewComplete(r.externalReview), false);
});

// ── 3. rotate PASS -> flat Archive; presentation unchanged ─────────────────

test("3. rotate PASS archives the trio with flat naming; Current presentation unchanged", { timeout: 30000 }, async () => {
  const r = await run(3);
  const dir = surface(3);
  assert.ok(existsSync(join(dir, "review-bundle.txt")), "surface populated");
  const rot = rotateExternalReviewSurface({
    surfaceDir: dir, archiveDir: ARCHIVE, cardId: "RB-1H-TEST-3",
    identity: r.externalReview.delivery.reviewBundleIdentity, verdict: "PASS", dateStr: "20260807",
  });
  assert.equal(rot.ok, true, `rotate ok (${rot.reason})`);
  assert.equal(rot.archived.length, 3, "bundle + evidence + delivery record archived");
  const id8 = r.externalReview.delivery.reviewBundleIdentity.slice(0, 8);
  for (const kind of ["review-bundle.txt", "delivery.json", "evidence.json"]) {
    assert.ok(rot.archived.some((p) => p.endsWith(`20260807-RB-1H-TEST-3-${id8}-PASS-${kind}`)), `archived ${kind}`);
  }
  // CURRENT-LATEST-REVIEW-PRESENTATION-SEMANTICS-1: the verdict lifecycle
  // never controls the presentation pointer — Current keeps the bundle.
  assert.equal(rot.cleared, false, "Current/ presentation unchanged by the verdict");
  assert.ok(existsSync(join(dir, "review-bundle.txt")), "bundle still presented on Current");
  const bundleArchive = rot.archived.find((p) => p.endsWith("review-bundle.txt"));
  assert.equal(shaFile(bundleArchive), shaFile(r.bundlePath), "archived bundle bytes preserved");
  // the ledger entry is REVIEWED with the identity-bound PASS verdict
  const { reviewQueueStatus } = await import("../../src/governance/review-queue.mjs");
  const st = reviewQueueStatus(dir);
  assert.equal(st.ok, true);
  const entry = st.queue.entries.find((e) => e.cardId === "RB-1H-TEST-3");
  assert.ok(entry, "ledger entry exists");
  assert.equal(entry.state, "REVIEWED", "entry REVIEWED");
  assert.equal(entry.verdict?.verdict, "PASS");
  assert.equal(entry.verdict?.bundleIdentity, r.externalReview.delivery.reviewBundleIdentity, "verdict identity-bound");
});

// ── 4. rotate REPAIR -> old generation archived; repair bundle publishes ───

test("4. rotate REPAIR archives the old generation; the repair bundle becomes Current/", { timeout: 30000 }, async () => {
  const r = await run(4);
  const dir = surface(4);
  const oldIdentity = r.externalReview.delivery.reviewBundleIdentity;
  const oldSha = r.externalReview.delivery.reviewBundleSha256;
  const oldPath = r.bundlePath;
  const applied = applyExternalReviewVerdict(r.externalReview, {
    verdict: "REPAIR", reviewerIdentity: "AUTOLOOP_PI_GRAPH_RB1H_EXTERNAL_REVIEW",
    reviewedAt: "2026-08-07T18:00:00.000Z", bundleIdentity: oldIdentity, bundleSha256: oldSha,
  });
  assert.equal(applied.ok, true);
  const rot = rotateExternalReviewSurface({ surfaceDir: dir, archiveDir: ARCHIVE, cardId: "RB-1H-TEST-4", identity: oldIdentity, verdict: "REPAIR", dateStr: "20260807" });
  assert.equal(rot.ok, true);
  // the REPAIR verdict does not change the presentation
  assert.ok(existsSync(join(dir, "review-bundle.txt")), "Current presentation unchanged by the REPAIR verdict");
  // repair generation delivers the superseding bundle to Current
  const repair = await run(4, { closeout: { cardId: "RB-1H-TEST-4", cardType: "repair", supersedes: buildSupersedeRecord(applied.state) } });
  assert.equal(repair.final, "PASS");
  assert.notEqual(repair.externalReview.delivery.reviewBundleIdentity, oldIdentity, "new identity");
  assert.ok(existsSync(join(dir, "review-bundle.txt")), "repair bundle now in Current/");
  assert.equal(shaFile(join(dir, "review-bundle.txt")), shaFile(repair.bundlePath), "Current holds the NEW bundle");
  const rec = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(rec.ok, true);
  assert.equal(rec.state.supersedes.reviewBundleIdentity, oldIdentity, "Current delivery.json supersedes the archived REPAIR generation");
  const oldArchive = rot.archived.find((p) => p.endsWith("review-bundle.txt"));
  assert.equal(shaFile(oldArchive), shaFile(oldPath), "archived old bundle preserved");
});

// ── 5. standalone surface delivery（pre-convention bundle）──────────────────

test("5. standalone surface delivery for a bundle generated before the convention", { timeout: 30000 }, async () => {
  const r = await run(5);
  const fresh = join(ROOT, "surface-5b");
  mkdirSync(fresh, { recursive: true });
  const { state } = stateFor(r.bundlePath, "RB-1H-TEST-5");
  const d = deliverToExternalReviewSurface({ bundlePath: r.bundlePath, state, source: { task: { cardId: "RB-1H-TEST-5" }, evidence: [] }, surfaceDir: fresh });
  assert.equal(d.attempted, true, `delivered (${d.reason})`);
  assert.equal(d.files.length, 2, "bundle + delivery.json（no evidence provided）");
  assert.ok(existsSync(join(fresh, "review-bundle.txt")));
  const rec = readExternalReviewDeliveryRecord(join(fresh, "delivery.json"));
  assert.equal(rec.ok, true);
  assert.equal(rec.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  const bad = deliverToExternalReviewSurface({ bundlePath: "/nonexistent/bundle.txt", state, source: {}, surfaceDir: fresh });
  assert.equal(bad.attempted, false, "missing input fails closed");
});

// ── 6. rotate HOLD on abandonment ──────────────────────────────────────────

test("6. rotate HOLD archives a held card; Current presentation unchanged", { timeout: 30000 }, async () => {
  const r = await run(6);
  const dir = surface(6);
  const rot = rotateExternalReviewSurface({ surfaceDir: dir, archiveDir: ARCHIVE, cardId: "RB-1H-TEST-6", identity: r.externalReview.delivery.reviewBundleIdentity, verdict: "HOLD", dateStr: "20260807" });
  assert.equal(rot.ok, true);
  assert.ok(rot.archived.some((p) => p.includes("-HOLD-")), "HOLD card archived");
  assert.equal(rot.cleared, false, "Current/ presentation unchanged by the HOLD verdict");
  const bundleArchive = rot.archived.find((p) => p.endsWith("review-bundle.txt"));
  const v = validateReviewBundle(bundleArchive, { authorizedDir: ARCHIVE });
  assert.equal(v.ok, true, `archived bundle still valid (${v.errors.join(";")})`);
});

// ── 7. concurrency: only ONE delivery succeeds ─────────────────────────────

test("7. concurrent delivery -> only ONE succeeds（surface_busy; never mutual overwrite）", { timeout: 30000 }, async () => {
  const r = await run(7);
  // concurrency sequence on a FRESH surface（run(7) already occupies surface-7）
  const dir = join(ROOT, "surface-7b");
  const { state } = stateFor(r.bundlePath, "RB-1H-TEST-7");
  // publisher A holds the single-owner lock…
  const lockA = acquireExternalReviewSurfaceLock(dir);
  try {
    assert.equal(lockA.ok, true, "first publisher acquires the lock");
    // …publisher B（concurrent）must fail closed — never overwrite
    const d = deliverToExternalReviewSurface({ bundlePath: r.bundlePath, state, source: { task: { cardId: "RB-1H-TEST-7" }, evidence: [] }, surfaceDir: dir });
    assert.equal(d.attempted, false, "second concurrent delivery refused");
    assert.equal(d.reason, "surface_busy", "surface_busy reason");
    assert.ok(!existsSync(join(dir, "review-bundle.txt")), "no trio published by the refused publisher");
  } finally {
    releaseExternalReviewSurfaceLock(lockA); // never leak the lock, even on assert failure
  }
  // A released; a delivery can now proceed
  const d2 = deliverToExternalReviewSurface({ bundlePath: r.bundlePath, state, source: { task: { cardId: "RB-1H-TEST-7" }, evidence: [] }, surfaceDir: dir });
  assert.equal(d2.attempted, true, "delivery succeeds after lock release");
  assert.ok(existsSync(join(dir, "review-bundle.txt")), "trio published after release");
});

// ── 8. occupied surface -> second card PUBLISHES; first stays durable ──────

test("8. occupied surface -> second card PUBLISHES to Current; first card stays durable PENDING in the ledger", { timeout: 30000 }, async () => {
  const r = await run(8);
  const dir = surface(8);
  // a genuinely DIFFERENT card（different cardId -> different bundle identity）
  // delivers while the first is unresolved: it PUBLISHES to Current（card D1:
  // completion -> Current = that card; presentation is never gated on a
  // verdict）, and the first card stays durable PENDING in the ledger.
  const r2 = await run(8, { closeout: { cardId: "RB-1H-TEST-8B", surfaceDir: dir } });
  assert.notEqual(r2.bundle.identity, r.externalReview.delivery.reviewBundleIdentity, "second card has a different identity");
  const { state } = stateFor(r2.bundlePath, "RB-1H-TEST-8B");
  const d = deliverToExternalReviewSurface({ bundlePath: r2.bundlePath, state, source: { task: { cardId: "RB-1H-TEST-8B" }, evidence: [] }, surfaceDir: dir });
  assert.equal(d.attempted, true, "occupied delivery is a SUCCESS（publish-always）");
  assert.equal(d.queued, undefined, "not queued — every completion publishes to Current");
  // Current NOW presents the second card
  const rec = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(rec.cardId, "RB-1H-TEST-8B", "delivery.json now the second card");
  assert.equal(shaFile(join(dir, "review-bundle.txt")), shaFile(r2.bundlePath), "Current holds the second bundle");
  // the FIRST card is durable in the ledger as PENDING（card B2/C: Current
  // overwrite != review state loss）
  const { reviewQueueStatus } = await import("../../src/governance/review-queue.mjs");
  const st = reviewQueueStatus(dir);
  assert.equal(st.ok, true);
  const first = st.queue.entries.find((e) => e.cardId === "RB-1H-TEST-8");
  assert.ok(first, "first card still has a ledger entry");
  assert.equal(first.state, "PENDING", "first card remains an unresolved pending review");
  assert.equal(first.isLatestPresented, false, "first card no longer presented");
  const second = st.queue.entries.find((e) => e.cardId === "RB-1H-TEST-8B");
  assert.ok(second, "second card ledger entry exists");
  assert.equal(second.isLatestPresented, true, "second card presented");
  assert.equal(st.queue.entries.filter((e) => e.cardId === "RB-1H-TEST-8B").length, 1, "one entry only");
});

// ── 9. observer/crash: no mixed trio; stale staging cleaned ────────────────

test("9. observer/crash: no mixed trio ever visible; stale staging leftovers cleaned", { timeout: 30000 }, async () => {
  const r = await run(9);
  const { state } = stateFor(r.bundlePath, "RB-1H-TEST-9");
  // observer test on a FRESH surface（run(9) occupies surface-9）
  const dir = join(ROOT, "surface-9b");
  const parent = dirname(dir);
  // simulate a crashed publisher: stale invisible staging + dot-tmp inside the
  // surface（the reviewer only sees non-dot entries; the surface must not wedge）
  const stale = join(parent, ".incoming-deadbeef");
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, "review-bundle.txt"), "partial", "utf8");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".old.tmp-999"), "partial", "utf8");
  // the reviewer-visible surface has NO trio yet（no mixed content visible）
  assert.ok(!existsSync(join(dir, "review-bundle.txt")), "reviewer never sees a partial/mixed trio");
  assert.equal(readdirSync(dir).filter((f) => !f.startsWith(".")).length, 0, "no non-dot entries pre-publish");
  // a fresh delivery cleans the stale staging + dot leftovers and publishes
  const d = deliverToExternalReviewSurface({ bundlePath: r.bundlePath, state, source: { task: { cardId: "RB-1H-TEST-9" }, evidence: [] }, surfaceDir: dir });
  assert.equal(d.attempted, true, `clean delivery after crash residue (${d.reason})`);
  assert.ok(!existsSync(stale), "stale staging removed");
  assert.ok(!existsSync(join(dir, ".old.tmp-999")), "dot leftovers removed");
  assert.ok(existsSync(join(dir, "review-bundle.txt")) && existsSync(join(dir, "delivery.json")), "complete trio published");
  // publication is a single directory swap — every visible entry belongs to
  // ONE card（trio identity is consistent）
  const rec = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(rec.state.delivery.reviewBundleIdentity, r.externalReview.delivery.reviewBundleIdentity, "trio bound to one card");
});

// ── 10. stale lock broken; live lock blocks ────────────────────────────────

test("10. stale lock（dead pid）is broken; live lock blocks", { timeout: 30000 }, async () => {
  const dir = join(ROOT, "surface-10");
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dirname(dir), ".surface.lock");
  // stale owner（dead pid 99999999）must not wedge the surface
  writeFileSync(lockPath, JSON.stringify({ pid: 99999999, token: "dead-token", acquiredAt: "2026-08-07T00:00:00.000Z" }), "utf8");
  const a = acquireExternalReviewSurfaceLock(dir);
  assert.equal(a.ok, true, "stale lock broken");
  releaseExternalReviewSurfaceLock(a);
  // live owner（this process）blocks a concurrent publisher
  const live = acquireExternalReviewSurfaceLock(dir);
  assert.equal(live.ok, true);
  const b = acquireExternalReviewSurfaceLock(dir);
  assert.equal(b.ok, false, "live lock blocks");
  assert.equal(b.reason, "surface_busy");
  // foreign token cannot be released by a stranger
  releaseExternalReviewSurfaceLock({ lockPath, token: "not-ours" });
  assert.ok(existsSync(lockPath), "foreign release refused");
  releaseExternalReviewSurfaceLock(live);
  assert.ok(!existsSync(lockPath), "owner release removes the lock");
});
