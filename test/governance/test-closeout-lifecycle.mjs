// test/governance/test-closeout-lifecycle.mjs
//
// AUTOLOOP_REPORT_LIFECYCLE_REPAIR_1 — state-driven mandatory closeout +
// fail-closed review surface delivery（FM-1 lifecycle trigger + FM-2
// delivery fail-open）.
//
// Coverage（repair-card regression tests T1-T10）:
//   T1  no formal conversation card-entry -> mandatory closeout auto-fires
//   T2  missing metadata -> CLOSEOUT_METADATA_INCOMPLETE（fail-closed）
//   T3  normal report delivery -> PASS + Current/ trio + identity/sha match
//   T4  surface write failure -> top-level final !== PASS
//   T5  occupied surface -> no overwrite, no PASS, blocked
//   T6  idempotent retry after fixing the surface -> same identity, one trio
//   T7  crash/restart boundary -> deterministic recovery, single artifact
//   T8  existing formal-card path（runMandatoryGraphCloseout）regression
//   T9  existing Graph-runner closeout wiring（closeout.statePath）regression
//   T10 requiresReview=false -> never forced to produce a bundle
//   R7  resolved occupant is auto-rotated at the next delivery
//
// Run: node --test test/governance/test-closeout-lifecycle.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runStateDrivenCloseout,
  runMandatoryGraphCloseout,
  collectRepoFacts,
  validateReviewBundle,
  externalReviewComplete,
  applyExternalReviewVerdict,
  serializeExternalReviewState,
  writeExternalReviewDeliveryRecord,
  readExternalReviewDeliveryRecord,
  deliverToExternalReviewSurface,
  rotateExternalReviewSurface,
} from "../../src/governance/review-bundle.mjs";
import {
  CLOSEOUT_STATE_SCHEMA,
  CLOSEOUT_HOLDS,
  closeoutStatePath,
  writeCloseoutState,
  readCloseoutState,
} from "../../src/governance/closeout-state.mjs";

const REPO_A = "/Volumes/NVM2T/Development/autoloop";
const ROOT = `${tmpdir()}/closeout-lifecycle-${process.pid}`;
const OUT = join(ROOT, "out");
const ARCHIVE = join(ROOT, "archive");
const surface = (n) => join(ROOT, `surface-${n}`);

const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(ARCHIVE, { recursive: true });
  process.env.AUTOLOOP_REVIEW_SURFACE = join(ROOT, "env-surface");
  process.env.AUTOLOOP_REVIEW_ARCHIVE = ARCHIVE;
});
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
});

// ── realistic structured Graph result（matches what runColimaGraph returns）──

const passGraph = {
  executionId: "fixture-lifecycle-pass-1",
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
      nodeId: "R1", phaseExecutionId: "exec_lc_r1", taskType: "audit", dependencies: [],
      final: "PASS", attempt: 0, reason: null, startedAt: 1, completedAt: 2,
      cleanup: { worktreeRevoked: false },
      subagentResult: { status: "PASS", testResults: null, testsExecuted: [] },
    },
    {
      nodeId: "W1", phaseExecutionId: "exec_lc_w1", taskType: "write", dependencies: ["R1"],
      final: "PASS", attempt: 0, reason: null, startedAt: 3, completedAt: 4,
      worktreeIdentity: {
        verified: true,
        output: { files: [{ status: " M", path: "src/governance/review-bundle.mjs", source: null, destination: null, rename: false }] },
      },
      cleanup: { worktreeRevoked: true },
      subagentResult: { status: "PASS", testResults: { passed: 2, failed: 0, total: 2 }, testsExecuted: ["self-test"] },
      reviewResult: { status: "PASS", findings: [], blockingFindings: [], scopeVerified: true, testsVerified: true, recommendedAction: "PASS", summary: "independent review PASS" },
    },
    {
      nodeId: "V1", phaseExecutionId: "exec_lc_v1", taskType: "verify", dependencies: ["W1"],
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

const stateFor = (cardId, { requiresReview = true, overrides = {} } = {}) => ({
  schema: CLOSEOUT_STATE_SCHEMA,
  task: { cardId, cardTitle: `${cardId} title`, cardType: "implementation" },
  requiresReview,
  reviewRequiredAt: "2026-08-08T00:00:00.000Z",
  outDir: join(OUT, cardId),
  authorizedScope: ["src/governance/review-bundle.mjs"],
  unauthorizedScope: ["commit", "push", "merge", "seal"],
  designDecisions: ["state-driven mandatory closeout"],
  objective: `${cardId}: verify the state-driven closeout lifecycle`,
  negativeCases: ["no card-specific script required"],
  regression: [{ suite: "test:governance", tests: 1, pass: 1, fail: 0 }],
  regressionSummary: "focused tests pass",
  recommendedNextStep: "external review",
  repairBudgetMaxAttempts: 1,
  ...overrides,
});

const drive = (cardId, { surfaceDir, state = null, graphResult = passGraph, graphResultPath = null, outDir = null, timeoutMs = 8000 } = {}) => {
  const st = state ?? stateFor(cardId);
  const stPath = closeoutStatePath(st?.outDir ?? join(OUT, cardId));
  // Write the record only when it does not exist yet（or was explicitly
  // supplied）— an existing APPLIED record must survive re-runs so the
  // idempotent retry/restart semantics stay observable.
  if (state || !existsSync(stPath)) {
    writeCloseoutState({ path: stPath, state: st });
  }
  return runStateDrivenCloseout({
    statePath: stPath,
    graphResult,
    graphResultPath,
    repoPath: REPO_A,
    cwd: REPO_A,
    outDir: outDir ?? join(OUT, cardId),
    timeoutMs,
    surfaceDir,
  });
};

// ── T1: no formal conversation card-entry → closeout auto-fires ───────────

test("T1. no formal card-entry script: work complete + review required -> mandatory closeout auto-fires", { timeout: 30000 }, async () => {
  const cardId = "LC-T1";
  const r = await drive(cardId, { surfaceDir: surface("t1") });
  assert.equal(r.applied, true, "closeout applied");
  assert.equal(r.final, "PASS", `final PASS (${r.reason})`);
  assert.ok(r.bundlePath && existsSync(r.bundlePath), "bundle written by the state-driven trigger");
  const txt = readFileSync(r.bundlePath, "utf8");
  assert.ok(txt.includes(`CARD_ID: ${cardId}`), "task identity bound from state");
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: join(OUT, cardId) });
  assert.equal(v.ok, true, `bundle validates (${v.errors.join(";")})`);
  // the state record now records the applied disposition（idempotent marker）
  const st = readCloseoutState(closeoutStatePath(join(OUT, cardId)));
  assert.equal(st.ok, true);
  assert.equal(st.state.closeout.status, "APPLIED");
  assert.equal(st.state.closeout.final, "PASS");
  assert.equal(st.state.closeout.bundleIdentity, r.bundle.identity);
});

// ── T2: missing metadata fails closed ─────────────────────────────────────

test("T2. incomplete closeout metadata -> CLOSEOUT_METADATA_INCOMPLETE（never silent skip, never PASS）", { timeout: 30000 }, async () => {
  // missing task.cardId
  const r1 = await drive("LC-T2A", { surfaceDir: surface("t2a"), state: stateFor("LC-T2A", { overrides: { task: { cardTitle: "no id", cardType: "implementation" } } }) });
  assert.equal(r1.applied, true, "not silently skipped");
  assert.notEqual(r1.final, "PASS");
  assert.equal(r1.holdCode, CLOSEOUT_HOLDS.METADATA_INCOMPLETE);
  assert.ok(r1.reason.includes("task.cardId"), `missing field named (${r1.reason})`);
  assert.ok(!existsSync(join(surface("t2a"), "review-bundle.txt")), "no report delivered");

  // missing outDir
  const r2 = await drive("LC-T2B", { surfaceDir: surface("t2b"), state: stateFor("LC-T2B", { overrides: { outDir: undefined } }) });
  assert.equal(r2.applied, true);
  assert.notEqual(r2.final, "PASS");
  assert.equal(r2.holdCode, CLOSEOUT_HOLDS.METADATA_INCOMPLETE);
  assert.ok(r2.reason.includes("outDir"), `missing field named (${r2.reason})`);
});

// ── T3: normal report delivery ────────────────────────────────────────────

test("T3. normal delivery: generate+validate+deliver PASS; Current/ trio consistent", { timeout: 30000 }, async () => {
  const cardId = "LC-T3";
  const dir = surface("t3");
  const r = await drive(cardId, { surfaceDir: dir });
  assert.equal(r.final, "PASS");
  // artifact present on the configured surface
  const bundlePath = join(dir, "review-bundle.txt");
  assert.ok(existsSync(bundlePath), "review-bundle.txt on surface");
  assert.ok(existsSync(join(dir, "delivery.json")), "delivery.json on surface");
  // identity + recomputed sha match the bundle the gate generated
  const txt = readFileSync(bundlePath, "utf8");
  const ident = txt.match(/^REVIEW_BUNDLE_IDENTITY: ([0-9a-f]{64})$/m)?.[1];
  const lines = txt.split("\n");
  const shaIdx = [...lines].reverse().findIndex((l) => l.startsWith("REVIEW_BUNDLE_SHA256:"));
  const statedSha = lines[lines.length - 1 - shaIdx].split(":")[1]?.trim();
  assert.equal(ident, r.bundle.identity, "surface identity matches gate identity");
  assert.equal(statedSha, r.bundle.sha256, "surface sha matches gate sha");
  // delivery record consistent
  const rec = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(rec.ok, true, `delivery record readable (${rec.errors.join(";")})`);
  assert.equal(rec.state.delivery.reviewBundleIdentity, r.bundle.identity);
  assert.equal(rec.state.delivery.reviewBundleSha256, r.bundle.sha256);
  assert.equal(rec.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW", "awaiting review");
  // verdict NOT yet applied -> external review NOT complete
  assert.equal(externalReviewComplete(rec.state), false, "no external review complete before verdict");
});

// ── T4: surface write failure → top-level non-PASS ────────────────────────

test("T4. surface write failure -> top-level final !== PASS（no closeout complete claim）", { timeout: 30000 }, async () => {
  const cardId = "LC-T4";
  const blocked = surface("t4");
  writeFileSync(blocked, "i am a file, not a dir", "utf8"); // blocks mkdir+write
  const r = await drive(cardId, { surfaceDir: blocked });
  assert.notEqual(r.final, "PASS", `final must not be PASS (got ${r.final})`);
  assert.equal(r.final, "AWAITING_BUNDLE_DELIVERY");
  assert.equal(r.externalReview.externalReviewStatus, "AWAITING_BUNDLE_DELIVERY");
  assert.equal(r.externalReview.delivery.attempted, false);
  assert.equal(externalReviewComplete(r.externalReview), false);
});

// ── T5: occupied surface → QUEUED（REVART-LC1）, no overwrite ─────────────

test("T5. occupied Current/（unresolved card）-> second card PUBLISHES; first card stays durable PENDING", { timeout: 30000 }, async () => {
  const cardIdA = "LC-T5A";
  const cardIdB = "LC-T5B";
  const dir = surface("t5");
  const ra = await drive(cardIdA, { surfaceDir: dir });
  assert.equal(ra.final, "PASS");
  const aIdentity = ra.bundle.identity;
  // card B delivers while A is unresolved: B PUBLISHES to Current（card D1:
  // completion -> Current = that card; presentation never gated on a verdict）
  const rb = await drive(cardIdB, { surfaceDir: dir });
  assert.equal(rb.final, "PASS", `publish-always keeps the gate PASS (got ${rb.final})`);
  assert.equal(rb.externalReview.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW", "B awaiting review");
  assert.equal(rb.externalReview.delivery.method, "external-review-surface", "B published to Current");
  // Current presents the NEWEST completion
  assert.equal(shaFile(join(dir, "review-bundle.txt")), shaFile(rb.bundlePath), "Current holds B's bundle bytes");
  const rec = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(rec.state.delivery.reviewBundleIdentity, rb.bundle.identity, "delivery record is card B");
  // A is durable in the ledger as PENDING（exactly one entry per card; card B2/C）
  const { reviewQueueStatus } = await import("../../src/governance/review-queue.mjs");
  const st = reviewQueueStatus(dir);
  assert.equal(st.ok, true);
  const aEntry = st.queue.entries.find((e) => e.cardId === cardIdA);
  assert.ok(aEntry, "A ledger entry exists");
  assert.equal(aEntry.state, "PENDING", "A remains an unresolved pending review");
  assert.equal(aEntry.bundleIdentity, aIdentity, "A identity preserved");
  assert.equal(aEntry.isLatestPresented, false, "A not presented");
  const bEntry = st.queue.entries.find((e) => e.cardId === cardIdB);
  assert.ok(bEntry, "B entry exists");
  assert.equal(bEntry.isLatestPresented, true, "B presented");
  assert.equal(st.queue.entries.filter((e) => e.cardId === cardIdB).length, 1, "one entry only");
});

// ── T6: idempotent retry after fixing the surface ─────────────────────────

test("T6. delivery failure then retry: same identity, no duplicate delivery, recovers to awaiting review", { timeout: 30000 }, async () => {
  const cardId = "LC-T6";
  const dir = surface("t6");
  // first attempt: surface blocked
  const blocked = surface("t6-blocked");
  writeFileSync(blocked, "blocked", "utf8");
  const r1 = await drive(cardId, { surfaceDir: blocked });
  assert.notEqual(r1.final, "PASS");
  const identity1 = r1.bundle.identity;
  const sha1 = r1.bundle.sha256;
  // fix the surface and retry the SAME lifecycle closeout（same state record）
  rmSync(blocked, { force: true });
  mkdirSync(dir, { recursive: true });
  const r2 = await drive(cardId, { surfaceDir: dir });
  assert.equal(r2.final, "PASS", `retry recovers (${r2.reason})`);
  // the LOGICAL bundle identity is the binding（deterministic; excludes the
  // per-run GENERATED_AT content stamp, so the content sha may differ but the
  // identity must not）
  assert.equal(r2.bundle.identity, identity1, "logical bundle identity unchanged on retry");
  // exactly ONE trio on the surface（no duplicate delivery）
  const surfaceFiles = readdirSync(dir).filter((f) => !f.startsWith(".")).sort();
  assert.deepEqual(surfaceFiles, ["delivery.json", "evidence.json", "review-bundle.txt"], "single complete trio");
  const rec = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(rec.state.delivery.reviewBundleIdentity, identity1, "delivery record identity consistent");
  assert.equal(rec.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW", "recovered to awaiting review");
  // re-running after PASS is a no-op（idempotent; never re-generates）
  const r3 = await drive(cardId, { surfaceDir: dir });
  assert.equal(r3.alreadyApplied, true, "applied PASS closeout is skipped");
  // RB2R1: review is still AWAITING_EXTERNAL_REVIEW, so the idempotent re-run
  // must NOT mint final PASS — it returns a non-final review state.
  assert.equal(r3.final, "AWAITING_EXTERNAL_REVIEW", "idempotent re-run never mints final PASS while review pending");
});

// ── T7: crash/restart boundary ────────────────────────────────────────────

test("T7. crash between generation and delivery: resume is deterministic, single artifact, state consistent", { timeout: 30000 }, async () => {
  const cardId = "LC-T7";
  const dir = surface("t7");
  // run 1 "crashes" before delivery commits（surface unwritable）
  const blocked = surface("t7-blocked");
  writeFileSync(blocked, "blocked", "utf8");
  const r1 = await drive(cardId, { surfaceDir: blocked });
  assert.notEqual(r1.final, "PASS");
  assert.ok(existsSync(r1.bundlePath), "bundle WAS generated + validated before the delivery boundary");
  const st1 = readCloseoutState(closeoutStatePath(join(OUT, cardId)));
  assert.equal(st1.state.closeout.status, "APPLIED", "disposition recorded durably");
  // "restart": fresh process resumes the same state + authoritative evidence
  rmSync(blocked, { force: true });
  mkdirSync(dir, { recursive: true });
  const r2 = await drive(cardId, { surfaceDir: dir });
  assert.equal(r2.final, "PASS", "resume recovers");
  assert.equal(r2.bundle.identity, r1.bundle.identity, "no conflicting bundle identity on resume");
  // exactly one Current artifact; state and artifact agree
  const surfaceFiles = readdirSync(dir).filter((f) => !f.startsWith(".")).sort();
  assert.deepEqual(surfaceFiles, ["delivery.json", "evidence.json", "review-bundle.txt"], "single unique Current trio");
  const rec = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(rec.state.delivery.reviewBundleIdentity, r2.bundle.identity, "state matches artifact");
  const st2 = readCloseoutState(closeoutStatePath(join(OUT, cardId)));
  assert.equal(st2.state.closeout.final, "PASS");
  assert.equal(st2.state.closeout.bundleIdentity, r2.bundle.identity);
  // bundle files on disk: no conflicting second artifact（same deterministic name）
  const bundles = readdirSync(join(OUT, cardId)).filter((f) => f.startsWith("card-closeout-bundle-"));
  assert.equal(bundles.length, 1, "exactly one bundle artifact on disk");
});

// ── T8: existing formal-card path regression ──────────────────────────────

test("T8. existing formal-card path（closeout contract -> runMandatoryGraphCloseout）regression intact", { timeout: 30000 }, async () => {
  const cardId = "LC-T8";
  const dir = surface("t8");
  const r = await runMandatoryGraphCloseout({
    graphResult: passGraph,
    closeout: {
      requiresReview: true,
      cardId,
      cardTitle: "formal card closeout",
      cardType: "implementation",
      objective: "regression: formal card path unchanged",
      authorizedScope: ["src/governance/review-bundle.mjs"],
      unauthorizedScope: ["commit"],
      designDecisions: [],
      negativeCases: [],
      regression: [],
      regressionSummary: "n/a",
      recommendedNextStep: "none",
      surfaceDir: dir,
    },
    repoPath: REPO_A,
    outDir: join(OUT, cardId),
    timeoutMs: 8000,
  });
  assert.equal(r.applied, true);
  assert.equal(r.final, "PASS", `formal card path PASS (${r.reason})`);
  assert.ok(existsSync(join(dir, "review-bundle.txt")), "delivered to Current/");
});

// ── T9: Graph runner closeout wiring（closeout.statePath）regression ──────

test("T9. Graph-runner closeout wiring: explicit closeout.statePath drives state-driven closeout", { timeout: 30000 }, async () => {
  // This exercises the same wiring runColimaGraph uses at card closeout:
  // closeout.statePath -> runStateDrivenCloseout. runColimaGraph itself is
  // covered by test-graph-closeout-integration.mjs（real runs）.
  const cardId = "LC-T9";
  const stPath = closeoutStatePath(join(OUT, cardId));
  writeCloseoutState({ path: stPath, state: stateFor(cardId) });
  const r = await runStateDrivenCloseout({
    statePath: stPath,
    graphResult: passGraph,
    repoPath: REPO_A,
    cwd: REPO_A,
    outDir: join(OUT, cardId),
    timeoutMs: 8000,
    surfaceDir: surface("t9"),
  });
  assert.equal(r.applied, true);
  assert.equal(r.final, "PASS");
  // a requiresReview card WITHOUT statePath still uses the legacy in-memory
  // contract（unchanged; regression）
  const legacy = await runMandatoryGraphCloseout({
    graphResult: passGraph,
    closeout: { requiresReview: true, cardId: "LC-T9-LEGACY", cardTitle: "legacy", cardType: "implementation", objective: "o", authorizedScope: ["src/governance/review-bundle.mjs"], unauthorizedScope: [], designDecisions: [], negativeCases: [], regression: [], regressionSummary: "n/a", recommendedNextStep: "none", surfaceDir: surface("t9-legacy") },
    repoPath: REPO_A,
    outDir: join(OUT, "lc-t9-legacy"),
    timeoutMs: 8000,
  });
  assert.equal(legacy.final, "PASS", "legacy requiresReview path unchanged");
});

// ── T10: no-review task ───────────────────────────────────────────────────

test("T10. requiresReview=false is never forced to produce an external-review bundle", { timeout: 30000 }, async () => {
  const cardId = "LC-T10";
  const r = await drive(cardId, { surfaceDir: surface("t10"), state: stateFor(cardId, { requiresReview: false }) });
  assert.equal(r.applied, false, "no mandatory closeout for internal-only work");
  assert.equal(r.final, null);
  assert.ok(!existsSync(join(surface("t10"), "review-bundle.txt")), "no report produced");
  assert.equal(readdirSync(join(OUT, cardId)).filter((f) => f !== "closeout-state.json").length, 0, "no bundle artifacts");
});

// ── R7: a reviewed generation is archived via the LEDGER verdict flow; the
// next delivery publishes over the presentation（no auto-rotate seam）────────

test("R7. PASS on the ledger archives A; the next delivery publishes B; verdicts never auto-generate", { timeout: 30000 }, async () => {
  const cardA = "LC-R7A";
  const cardB = "LC-R7B";
  const dir = surface("r7");
  const ra = await drive(cardA, { surfaceDir: dir });
  assert.equal(ra.final, "PASS");
  // Controller applies a genuine PASS verdict to the DURABLE LEDGER entry
  //（the verdict authority; archives from the immutable ledger artifact）.
  const rec = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(rec.ok, true);
  const rot = rotateExternalReviewSurface({
    surfaceDir: dir, archiveDir: ARCHIVE,
    cardId: cardA, identity: rec.state.delivery.reviewBundleIdentity, verdict: "PASS",
  });
  assert.equal(rot.ok, true, `ledger verdict applied (${rot.reason ?? ""})`);
  // next required card delivers -> Current = B（publish-always; no special
  // auto-rotation seam, no auto-generated verdicts）
  const rb = await drive(cardB, { surfaceDir: dir });
  assert.equal(rb.final, "PASS", `next card publishes (${rb.reason})`);
  // Archive now holds card A（flat naming）; Current holds card B
  const archived = readdirSync(ARCHIVE).filter((f) => f.includes(cardA) && f.includes("review-bundle"));
  assert.ok(archived.length === 1, `card A archived (${archived.join(",")})`);
  const recB = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(recB.state.delivery.reviewBundleIdentity, rb.bundle.identity, "Current holds card B");
  assert.equal(externalReviewComplete(recB.state), false, "card B still awaiting external review");
});

// ── sanity: state record schema + materialization invariants ──────────────

test("sanity. closeout-state roundtrip + requiresReview is the ONLY trigger", async () => {
  const st = stateFor("LC-SANITY");
  const p = closeoutStatePath(join(OUT, "LC-SANITY"));
  const w = writeCloseoutState({ path: p, state: st });
  assert.equal(w.ok, true);
  const r = readCloseoutState(p);
  assert.equal(r.ok, true);
  assert.equal(r.state.schema, CLOSEOUT_STATE_SCHEMA);
  assert.equal(r.state.requiresReview, true);
  // a record with requiresReview missing defaults to NOT required（no review work）
  const noFlag = stateFor("LC-SANITY2", { overrides: { requiresReview: undefined } });
  const noFlagR = await drive("LC-SANITY2", { surfaceDir: surface("sanity2"), state: noFlag });
  assert.equal(noFlagR.applied, false, "absent requiresReview -> no mandatory closeout");
  assert.equal(noFlagR.final, null);
});
