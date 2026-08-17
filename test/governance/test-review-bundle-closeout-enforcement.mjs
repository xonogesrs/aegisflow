// test/governance/test-review-bundle-closeout-enforcement.mjs
//
// RB2R2 — AUTHORITATIVE EXTERNAL REVIEW RECORD BINDING.
//
// Mechanical proof that:
//   - the closeout path CANNOT reach a PASS/closeout-like success without a
//     canonical durable review bundle (CP-2 bypass stays closed), AND
//   - final card closeout cannot be minted from ANY caller-controlled
//     persisted field / status string / helper result / idempotent return
//     value, AND
//   - a caller-supplied externalReviewRecord can NEVER substitute for the
//     canonical surface delivery.json authority (RB2R2 REMOVE CALLER
//     AUTHORITY).
//
// Retains A–L (RB2) and M–Z (RB2R1); strengthens Y/Z to exercise the REAL
// production --final-closeout path; adds AA–AC (RB2R2) including the exact
// caller-supplied externalReviewRecord reproducer.
//
// Run: node --test test/governance/test-review-bundle-closeout-enforcement.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runStateDrivenCloseout,
  runMandatoryGraphCloseout,
  verifyAppliedCloseoutBundle,
  assertFinalCardCloseout,
  deriveAuthoritativeCloseoutStage,
  resolveAuthoritativeExternalReviewRecord,
  buildExternalReviewState,
  applyExternalReviewVerdict,
  buildSupersedeRecord,
  cardExternalReviewStatus,
  externalReviewComplete,
  validateReviewBundle,
  bundleContentSha256,
  writeExternalReviewDeliveryRecord,
  readExternalReviewDeliveryRecord,
} from "../../src/governance/review-bundle.mjs";
import { readReviewQueue, writeReviewQueue, findEntry } from "../../src/governance/review-queue.mjs";
import {
  CLOSEOUT_STATE_SCHEMA,
  CLOSEOUT_STAGES,
  deriveCloseoutStage,
  closeoutStatePath,
  writeCloseoutState,
  readCloseoutState,
} from "../../src/governance/closeout-state.mjs";

// REVIEW-BUNDLE-REVIEW-SECTION-CONVERGENCE-1: resolve the repo root from the
// test file location（portable across checkouts）so the spawned production
// CLI exercises the SAME src the tests import（never a stale sibling copy）.
const REPO_A = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/+$/, "");
const ROOT = `${tmpdir()}/rb2r1-enforce-${process.pid}`;
const OUT = join(ROOT, "out");
const surface = (n) => join(ROOT, `surface-${n}`);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  process.env.AUTOLOOP_REVIEW_SURFACE = join(ROOT, "env-surface");
  process.env.AUTOLOOP_REVIEW_ARCHIVE = join(ROOT, "archive");
});
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
});

const passGraph = {
  executionId: "rb2r1-enforce-pass",
  final: "PASS",
  holdCode: null,
  reason: null,
  scheduler: { verdict: "PASS", order: ["R1", "W1", "V1"], statuses: { R1: "passed", W1: "passed", V1: "passed" }, skipped: [] },
  nodeResults: [
    { nodeId: "R1", phaseExecutionId: "e1", taskType: "audit", dependencies: [], final: "PASS", attempt: 0, cleanup: { worktreeRevoked: false } },
    { nodeId: "W1", phaseExecutionId: "e2", taskType: "write", dependencies: ["R1"], final: "PASS", attempt: 0, cleanup: { worktreeRevoked: true }, reviewResult: { status: "PASS", findings: [], blockingFindings: [], recommendedAction: "PASS" } },
    { nodeId: "V1", phaseExecutionId: "e3", taskType: "verify", dependencies: ["W1"], final: "PASS", attempt: 0, cleanup: { worktreeRevoked: false } },
  ],
  transitions: [],
};

function stateFor(cardId, overrides = {}) {
  return {
    schema: CLOSEOUT_STATE_SCHEMA,
    task: { cardId, cardTitle: `${cardId} title`, cardType: "implementation" },
    requiresReview: true,
    outDir: join(OUT, cardId),
    authorizedScope: ["src/governance/review-bundle.mjs"],
    unauthorizedScope: ["commit", "push", "merge", "seal"],
    objective: `${cardId}: review-bundle closeout enforcement`,
    negativeCases: [],
    regression: [],
    regressionSummary: "n/a",
    recommendedNextStep: "external review",
    agentIdentity: "agent:the-implementer",
    ...overrides,
  };
}

function writeState(cardId, state) {
  const p = closeoutStatePath(join(OUT, cardId));
  writeCloseoutState({ path: p, state });
  return p;
}

/** Run a successful state-driven closeout → returns { result, statePath, state }. */
async function drive(cardId, { surfaceDir = null, repoPath = REPO_A } = {}) {
  const st = stateFor(cardId);
  const stPath = writeState(cardId, st);
  const result = await runStateDrivenCloseout({
    statePath: stPath,
    graphResult: passGraph,
    repoPath,
    cwd: repoPath,
    outDir: join(OUT, cardId),
    timeoutMs: 30000,
    surfaceDir,
  });
  const after = readCloseoutState(stPath);
  return { result, statePath: stPath, state: after.state };
}

/** Apply an external-review verdict to the surface delivery.json (authoritative record). */
function applyVerdictToSurface(surfaceDir, input) {
  const rec = readExternalReviewDeliveryRecord(join(surfaceDir, "delivery.json"));
  assert.equal(rec.ok, true, `surface delivery record readable (${rec.errors?.join(";")})`);
  const applied = applyExternalReviewVerdict(rec.state, {
    verdict: "PASS",
    reviewerIdentity: "external-reviewer",
    reviewedAt: "2026-08-15T00:00:00.000Z",
    bundleIdentity: rec.state.delivery.reviewBundleIdentity,
    bundleSha256: rec.state.delivery.reviewBundleSha256,
    ...input,
  });
  const written = writeExternalReviewDeliveryRecord({ outDir: surfaceDir, state: applied.state, cardId: rec.cardId, fileName: "delivery.json" });
  // CURRENT-LATEST-REVIEW-PRESENTATION-SEMANTICS-1: the DURABLE LEDGER entry
  // is the authoritative review record — the surface delivery record is a
  // presentation projection. Apply the same verdict to the ledger entry so
  // the final closeout gate resolves authority from the ledger.
  const qr = readReviewQueue(surfaceDir);
  assert.equal(qr.ok, true, `ledger readable (${qr.reason ?? ""})`);
  const entry = findEntry(qr.queue, rec.cardId, surfaceDir);
  assert.ok(entry, `ledger entry exists for ${rec.cardId}`);
  entry.verdict = applied.state.verdict;
  entry.state = applied.state.verdict.verdict === "PASS" ? "REVIEWED" : applied.state.verdict.verdict;
  entry.updatedAt = new Date().toISOString();
  const wq = writeReviewQueue(qr.queue, { surfaceDir });
  assert.equal(wq.ok, true, `ledger write ok (${wq.reason ?? ""})`);
  return { rec, applied, written };
}

function makeCleanRepo(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "impl.txt"), "v1\n");
  spawnSync("git", ["-C", dir, "add", "impl.txt"]);
  spawnSync("git", ["-C", dir, "commit", "-qm", "init"], { env: GIT_ENV });
  return dir;
}

/** Spawn the PRODUCTION final-closeout CLI（scripts/gov-closeout-bundle.mjs --final-closeout）. */
function runFinalCloseout(cardId, statePath, surfaceDir, repoPath = REPO_A) {
  return spawnSync(process.execPath, [
    "scripts/gov-closeout-bundle.mjs",
    "--final-closeout", statePath,
    "--repo", repoPath,
    "--out", join(OUT, cardId),
    "--surface", surfaceDir,
  ], { cwd: REPO_A, encoding: "utf8" });
}

// ── A. no bundle → final PASS rejected（the CP-2-style bypass）─────────────

test("A. caller-controlled closeout.final PASS with NO bundle → rejected (CP-2 bypass reproduction)", { timeout: 30000 }, async () => {
  const cardId = "RB2-A";
  const forged = {
    ...stateFor(cardId),
    closeout: { status: "APPLIED", final: "PASS", bundleIdentity: "0".repeat(64), bundleSha256: "0".repeat(64) },
  };
  const stPath = writeState(cardId, forged);
  const r = await runStateDrivenCloseout({ statePath: stPath, graphResult: passGraph, repoPath: REPO_A, cwd: REPO_A, outDir: join(OUT, cardId), surfaceDir: surface("a") });
  assert.equal(r.applied, true);
  assert.notEqual(r.final, "PASS", "a forged PASS without a bundle must not pass");
  assert.equal(r.final, "HOLD");
});

// ── B. malformed bundle → rejected ────────────────────────────────────────

test("B. recorded PASS backed by a MALFORMED bundle → rejected", { timeout: 30000 }, async () => {
  const cardId = "RB2-B";
  const identity = "ab".repeat(32);
  const outDir = join(OUT, cardId);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "card-closeout-bundle-forged.txt"), `REVIEW_BUNDLE_IDENTITY: ${identity}\nnot a real bundle\n`);
  const forged = { ...stateFor(cardId), closeout: { status: "APPLIED", final: "PASS", bundleIdentity: identity, bundleSha256: "cd".repeat(32) } };
  const stPath = writeState(cardId, forged);
  const r = await runStateDrivenCloseout({ statePath: stPath, graphResult: passGraph, repoPath: REPO_A, cwd: REPO_A, outDir, surfaceDir: surface("b") });
  assert.equal(r.final, "HOLD");
});

// ── C. wrong bundle SHA → rejected ────────────────────────────────────────

test("C. recorded PASS with a WRONG bundle sha256 → rejected", { timeout: 30000 }, async () => {
  const cardId = "RB2-C";
  const { state } = await drive(cardId, { surfaceDir: surface("c") });
  assert.equal(state.closeout.final, "PASS");
  const forged = { ...state, closeout: { ...state.closeout, bundleSha256: "de".repeat(32) } };
  const stPath = writeState(cardId, forged);
  const r = await runStateDrivenCloseout({ statePath: stPath, graphResult: passGraph, repoPath: REPO_A, cwd: REPO_A, outDir: join(OUT, cardId), surfaceDir: surface("c2") });
  assert.equal(r.final, "HOLD");
  assert.ok(r.reason.includes("sha256"), `sha mismatch surfaced (${r.reason})`);
});

// ── D. stale / superseded bundle → rejected ───────────────────────────────

test("D. superseded（retired）bundle no longer satisfies the recorded disposition", { timeout: 30000 }, async () => {
  const cardId = "RB2-D";
  const { state } = await drive(cardId, { surfaceDir: surface("d") });
  const outDir = join(OUT, cardId);
  const file = readdirSync(outDir).find((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt"));
  assert.ok(file, "bundle file exists");
  mkdirSync(join(outDir, ".superseded"), { recursive: true });
  renameSync(join(outDir, file), join(outDir, ".superseded", file));
  const r = await runStateDrivenCloseout({ statePath: closeoutStatePath(outDir), graphResult: passGraph, repoPath: REPO_A, cwd: REPO_A, outDir, surfaceDir: surface("d2") });
  assert.equal(r.final, "HOLD", "a superseded bundle must not satisfy the recorded PASS");
});

// ── E. implementation changed after bundle generation → rejected ──────────

test("E. bundle bound to a STALE implementation HEAD → rejected", { timeout: 30000 }, async () => {
  const cardId = "RB2-E";
  const { state } = await drive(cardId, { surfaceDir: surface("e") });
  const outDir = join(OUT, cardId);
  const otherRepo = makeCleanRepo("other-repo");
  const check = verifyAppliedCloseoutBundle({ outDir, closeout: state.closeout, cardId, repoPath: otherRepo });
  assert.equal(check.ok, false, "stale HEAD must be rejected");
  assert.ok(check.reason.includes("stale_implementation"), `stale head surfaced (${check.reason})`);
});

// ── F. self-review PASS rejected ──────────────────────────────────────────

test("F. self-declared agent review PASS → rejected", () => {
  const s = buildExternalReviewState({ bundle: { identity: "ab".repeat(32), sha256: "cd".repeat(32) } });
  const r = applyExternalReviewVerdict(s, {
    verdict: "PASS",
    reviewerIdentity: "agent:the-implementer",
    reviewedAt: "2026-08-15T00:00:00.000Z",
    bundleIdentity: "ab".repeat(32),
    bundleSha256: "cd".repeat(32),
    agentIdentity: "agent:the-implementer",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("SELF_DECLARED")), `self-declared surfaced (${r.errors.join(";")})`);
});

// ── G. independent HOLD → final closeout rejected ─────────────────────────

test("G. independent HOLD verdict → final card closeout rejected", { timeout: 30000 }, async () => {
  const cardId = "RB2-G";
  const dir = surface("g");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  // The external reviewer applies HOLD to the authoritative surface record.
  const held = applyVerdictToSurface(dir, { verdict: "HOLD", reviewerIdentity: "external-reviewer" });
  assert.equal(held.applied.ok, true);
  const r = assertFinalCardCloseout({ closeout: state.closeout, outDir, cardId, surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity });
  assert.equal(r.ok, false, "HOLD must block final closeout");
});

// ── H. unbound reviewer PASS text → rejected ──────────────────────────────

test("H. reviewer PASS not bound to the bundle identity/sha → rejected", () => {
  const s = buildExternalReviewState({ bundle: { identity: "ab".repeat(32), sha256: "cd".repeat(32) } });
  const r = applyExternalReviewVerdict(s, {
    verdict: "PASS",
    reviewerIdentity: "external-reviewer",
    reviewedAt: "2026-08-15T00:00:00.000Z",
    bundleIdentity: "ef".repeat(32),
    bundleSha256: "00".repeat(32),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("STALE_BUNDLE")), `unbound verdict surfaced (${r.errors.join(";")})`);
});

// ── I. valid bundle + valid independent PASS → closeout eligible ──────────

test("I. valid bundle + bound independent PASS → final card closeout eligible", { timeout: 30000 }, async () => {
  const cardId = "RB2-I";
  const dir = surface("i");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  // The external reviewer applies a genuine bound PASS to the authoritative
  // surface record.
  const passed = applyVerdictToSurface(dir, { verdict: "PASS", reviewerIdentity: "external-reviewer" });
  assert.equal(passed.applied.ok, true);
  assert.equal(externalReviewComplete(passed.applied.state), true);
  const r = assertFinalCardCloseout({ closeout: state.closeout, outDir, cardId, surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity });
  assert.equal(r.ok, true, `final gate should accept a bound independent PASS (${r.reason})`);
  assert.equal(r.stage, "REVIEW_ACCEPTED");
});

// ── J. legacy no-review path does not mint a review-bearing PASS ──────────

test("J. requiresReview=false legacy path never mints a review-bearing closeout PASS", { timeout: 30000 }, async () => {
  const cardId = "RB2-J";
  const r = await runMandatoryGraphCloseout({
    graphResult: passGraph,
    closeout: {
      requiresReview: false,
      cardId,
      cardTitle: "no review",
      cardType: "implementation",
      objective: "o",
      authorizedScope: ["src/governance/review-bundle.mjs"],
      unauthorizedScope: [],
      designDecisions: [],
      negativeCases: [],
      regression: [],
      regressionSummary: "n/a",
      recommendedNextStep: "none",
    },
    repoPath: REPO_A,
    outDir: join(OUT, cardId),
    timeoutMs: 30000,
  });
  assert.equal(r.applied, false);
  assert.equal(r.final, null, "no-review path returns no card-level PASS");
});

// ── K. AWAITING_EXTERNAL_REVIEW is not closeout/commit eligible ───────────

test("K. AWAITING_EXTERNAL_REVIEW is not closeout/commit eligible", { timeout: 30000 }, async () => {
  const cardId = "RB2-K";
  const dir = surface("k");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  assert.equal(state.closeout.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  const guard = cardExternalReviewStatus({ externalReviewStatus: "AWAITING_EXTERNAL_REVIEW", delivery: { reviewBundleIdentity: state.closeout.bundleIdentity, reviewBundleSha256: state.closeout.bundleSha256 }, verdict: null });
  assert.equal(guard.complete, false, "pending review is not complete");
  const r = assertFinalCardCloseout({ closeout: state.closeout, outDir, cardId, surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity });
  assert.equal(r.ok, false, "final closeout must not precede review acceptance");
});

// ── L. supersede semantics preserved; stage machine is closed ─────────────

test("L. buildSupersedeRecord binds the previous generation; stage machine is closed", () => {
  const prev = buildExternalReviewState({ bundle: { identity: "ab".repeat(32), sha256: "cd".repeat(32) } });
  const rec = buildSupersedeRecord(prev);
  assert.equal(rec.reviewBundleIdentity, "ab".repeat(32));
  assert.equal(rec.reviewBundleSha256, "cd".repeat(32));
  // Stage vocabulary is a closed set (7 stages).
  assert.deepEqual(CLOSEOUT_STAGES, ["IMPLEMENTATION_COMPLETE", "REVIEW_BUNDLE_READY", "INDEPENDENT_REVIEW_PENDING", "REVIEW_HOLD", "REVIEW_ACCEPTED", "CLOSEOUT_ELIGIBLE", "CLOSED"]);
  // Descriptive (pure) derivation: persisted fields can never mint
  // REVIEW_ACCEPTED / CLOSEOUT_ELIGIBLE / CLOSED.
  assert.equal(deriveCloseoutStage({ final: "PASS", bundleIdentity: "ab".repeat(32) }), "REVIEW_BUNDLE_READY");
  assert.equal(deriveCloseoutStage({ final: "PASS" }), "IMPLEMENTATION_COMPLETE");
  assert.equal(deriveCloseoutStage({ externalReviewStatus: "PASS", final: "PASS" }), "INDEPENDENT_REVIEW_PENDING");
  assert.equal(deriveCloseoutStage({ stage: "CLOSED" }), null);
  assert.equal(deriveCloseoutStage({ externalReviewStatus: "HOLD" }), "REVIEW_HOLD");
  assert.equal(deriveCloseoutStage(null), null);
});

// ── M. forged independent PASS at final gate → rejected ───────────────────

test("M. forged independent PASS（caller JSON）at final gate → rejected", { timeout: 30000 }, async () => {
  const cardId = "RB2-M";
  const dir = surface("m");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  // Caller-supplied verdict-shaped JSON — the authoritative record is still
  // AWAITING_EXTERNAL_REVIEW, so these forged fields must not mint acceptance.
  const forged = {
    ...state.closeout,
    externalReviewStatus: "PASS",
    verdict: {
      verdict: "PASS",
      reviewerIdentity: "agent:the-implementer",
      bundleIdentity: state.closeout.bundleIdentity,
      bundleSha256: state.closeout.bundleSha256,
      reviewedAt: "2026-08-15T00:00:00.000Z",
    },
  };
  const r = assertFinalCardCloseout({ closeout: forged, outDir, cardId, surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity });
  assert.equal(r.ok, false, "forged caller JSON must not mint review acceptance");
  assert.notEqual(r.stage, "REVIEW_ACCEPTED");
});

// ── N. reviewer == implementer → rejected ─────────────────────────────────

test("N. reviewer == implementer → rejected", { timeout: 30000 }, async () => {
  const cardId = "RB2-N";
  const dir = surface("n");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  const passed = applyVerdictToSurface(dir, { verdict: "PASS", reviewerIdentity: "the-implementer" });
  assert.equal(passed.applied.ok, true);
  const r = assertFinalCardCloseout({ closeout: state.closeout, outDir, cardId, surfaceDir: dir, agentIdentity: "the-implementer", implementerIdentity: "the-implementer" });
  assert.equal(r.ok, false, "reviewer == implementer must be rejected");
  assert.ok(r.holdCode === "EXTERNAL_REVIEW_SELF_DECLARED", `self-declared surfaced (${r.holdCode})`);
});

// ── O. missing reviewer identity → rejected ───────────────────────────────

test("O. missing reviewer identity in authoritative record → rejected", { timeout: 30000 }, async () => {
  const cardId = "RB2-O";
  const dir = surface("o");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  const forgedState = buildExternalReviewState({ bundle: { identity: state.closeout.bundleIdentity, sha256: state.closeout.bundleSha256 } });
  forgedState.externalReviewStatus = "PASS";
  forgedState.verdict = { verdict: "PASS", reviewerIdentity: null, reviewedAt: "2026-08-15T00:00:00.000Z", bundleIdentity: state.closeout.bundleIdentity, bundleSha256: state.closeout.bundleSha256 };
  writeExternalReviewDeliveryRecord({ outDir: dir, state: forgedState, cardId, fileName: "delivery.json" });
  // the authoritative LEDGER entry carries the same forged verdict fields
  const qr = readReviewQueue(dir);
  const entry = findEntry(qr.queue, cardId, dir);
  entry.verdict = forgedState.verdict;
  entry.state = "REVIEWED";
  writeReviewQueue(qr.queue, { surfaceDir: dir });
  const r = assertFinalCardCloseout({ closeout: state.closeout, outDir, cardId, surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, "EXTERNAL_REVIEW_INVALID_VERDICT", `reviewer required (${r.holdCode})`);
  assert.ok(r.reason.includes("reviewer_identity_required"));
});

// ── P. missing reviewedAt / invalid authoritative review record → rejected ─

test("P. missing reviewedAt in authoritative record → rejected", { timeout: 30000 }, async () => {
  const cardId = "RB2-P";
  const dir = surface("p");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  const forgedState = buildExternalReviewState({ bundle: { identity: state.closeout.bundleIdentity, sha256: state.closeout.bundleSha256 } });
  forgedState.externalReviewStatus = "PASS";
  forgedState.verdict = { verdict: "PASS", reviewerIdentity: "external-reviewer", reviewedAt: null, bundleIdentity: state.closeout.bundleIdentity, bundleSha256: state.closeout.bundleSha256 };
  writeExternalReviewDeliveryRecord({ outDir: dir, state: forgedState, cardId, fileName: "delivery.json" });
  // the authoritative LEDGER entry carries the same forged verdict fields
  const qr = readReviewQueue(dir);
  const entry = findEntry(qr.queue, cardId, dir);
  entry.verdict = forgedState.verdict;
  entry.state = "REVIEWED";
  writeReviewQueue(qr.queue, { surfaceDir: dir });
  const r = assertFinalCardCloseout({ closeout: state.closeout, outDir, cardId, surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, "EXTERNAL_REVIEW_INVALID_VERDICT", `reviewedAt required (${r.holdCode})`);
  assert.ok(r.reason.includes("reviewed_at_required"));
});

// ── Q. missing persisted bundle SHA → rejected ────────────────────────────

test("Q. missing persisted bundle SHA → rejected", { timeout: 30000 }, async () => {
  const cardId = "RB2-Q";
  const dir = surface("q");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  const noSha = { ...state.closeout, bundleSha256: null };
  const r = verifyAppliedCloseoutBundle({ outDir, closeout: noSha, cardId, repoPath: REPO_A });
  assert.equal(r.ok, false, "missing bundle sha must be HOLD");
  assert.equal(r.holdCode, "REVIEW_BUNDLE_MISSING");
  assert.ok(r.reason.includes("sha256"));
});

// ── R. repoPath/live repo unavailable → rejected ──────────────────────────

test("R. live repository unavailable → rejected（fail-closed, never skipped）", { timeout: 30000 }, async () => {
  const cardId = "RB2-R";
  const { state } = await drive(cardId, { surfaceDir: surface("r") });
  const outDir = join(OUT, cardId);
  const r = verifyAppliedCloseoutBundle({ outDir, closeout: state.closeout, cardId, repoPath: join(ROOT, "does-not-exist") });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("live_repository_unavailable"), `live repo failure surfaced (${r.reason})`);
});

// ── S. persisted CLOSED without evidence → rejected ───────────────────────

test("S. persisted CLOSED without evidence → cannot advance state", () => {
  // Pure descriptive derivation never echoes CLOSED from a persisted field.
  assert.notEqual(deriveCloseoutStage({ stage: "CLOSED" }), "CLOSED");
  assert.equal(deriveCloseoutStage({ stage: "CLOSED" }), null);
  // Authoritative derivation with no bundle at all → IMPLEMENTATION_COMPLETE.
  const r = deriveAuthoritativeCloseoutStage({ closeout: { stage: "CLOSED", bundleIdentity: "0".repeat(64), bundleSha256: "0".repeat(64) }, outDir: join(OUT, "RB2-S-empty"), cardId: "RB2-S", repoPath: null });
  assert.equal(r.stage, "IMPLEMENTATION_COMPLETE");
  assert.equal(r.ok, false);
});

// ── T. persisted PASS status without bound verdict → rejected ─────────────

test("T. persisted PASS status without bound verdict → not REVIEW_ACCEPTED", { timeout: 30000 }, async () => {
  const cardId = "RB2-T";
  const dir = surface("t");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  const claimedPass = { ...state.closeout, externalReviewStatus: "PASS" };
  // Pure derivation demotes the unverified PASS claim.
  assert.equal(deriveCloseoutStage(claimedPass), "INDEPENDENT_REVIEW_PENDING");
  // Final gate: authoritative record is still AWAITING → rejected.
  const r = assertFinalCardCloseout({ closeout: claimedPass, outDir, cardId, surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity });
  assert.equal(r.ok, false);
  assert.notEqual(r.stage, "REVIEW_ACCEPTED");
});

// ── U. review pending idempotent rerun → never returns final PASS ─────────

test("U. review pending idempotent rerun → never returns final PASS", { timeout: 30000 }, async () => {
  const cardId = "RB2-U";
  const dir = surface("u");
  const first = await drive(cardId, { surfaceDir: dir });
  assert.equal(first.result.final, "PASS");
  const second = await runStateDrivenCloseout({ statePath: first.statePath, graphResult: passGraph, repoPath: REPO_A, cwd: REPO_A, outDir: join(OUT, cardId), surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity });
  assert.equal(second.alreadyApplied, true);
  assert.notEqual(second.final, "PASS", "idempotent re-run while review pending must not mint final PASS");
  assert.equal(second.final, "AWAITING_EXTERNAL_REVIEW");
  assert.equal(second.stage, "REVIEW_BUNDLE_READY");
});

// ── V. working-tree mutation after bundle/review → rejected ───────────────

test("V. tracked working-tree mutation after bundle/review → rejected", { timeout: 30000 }, async () => {
  const cardId = "RB2-V";
  const dir = surface("v");
  const repo = makeCleanRepo("repo-v");
  const { state } = await drive(cardId, { surfaceDir: dir, repoPath: repo });
  // Mutate a TRACKED file in the working tree（HEAD does not move）.
  writeFileSync(join(repo, "impl.txt"), "v2\n");
  const r = verifyAppliedCloseoutBundle({ outDir: join(OUT, cardId), closeout: state.closeout, cardId, repoPath: repo });
  assert.equal(r.ok, false, "working-tree mutation must fail closed");
  assert.ok(r.reason.includes("working_tree_mutated"), `mutation surfaced (${r.reason})`);
});

// ── W. staged mutation after bundle/review → rejected ─────────────────────

test("W. staged mutation after bundle/review → rejected", { timeout: 30000 }, async () => {
  const cardId = "RB2-W";
  const dir = surface("w");
  const repo = makeCleanRepo("repo-w");
  const { state } = await drive(cardId, { surfaceDir: dir, repoPath: repo });
  writeFileSync(join(repo, "impl.txt"), "v2\n");
  spawnSync("git", ["-C", repo, "add", "impl.txt"]);
  const r = verifyAppliedCloseoutBundle({ outDir: join(OUT, cardId), closeout: state.closeout, cardId, repoPath: repo });
  assert.equal(r.ok, false, "staged mutation must fail closed");
  assert.ok(r.reason.includes("working_tree_mutated"), `staged mutation surfaced (${r.reason})`);
});

// ── X. ephemeral/missing evidence ref → bundle cannot become REVIEW_READY ──

test("X. missing evidence ref → bundle cannot become REVIEW_READY", { timeout: 30000 }, async () => {
  const cardId = "RB2-X";
  const dir = surface("x");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  const bundle = readdirSync(outDir).find((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt"));
  assert.ok(bundle, "bundle exists");
  // Delete the durable evidence the bundle references.
  const evidence = readdirSync(outDir).find((f) => f.endsWith("-graph-closeout-evidence.json"));
  assert.ok(evidence, "evidence file exists");
  rmSync(join(outDir, evidence), { force: true });
  const v = validateReviewBundle(join(outDir, bundle), { authorizedDir: outDir, expected: { taskId: cardId } });
  assert.equal(v.ok, false, "missing evidence ref must fail validation");
  assert.ok(v.errors.some((e) => e.includes("evidence_ref_missing")), `evidence_ref_missing surfaced (${v.errors.join(";")})`);
  const r = verifyAppliedCloseoutBundle({ outDir, closeout: state.closeout, cardId, repoPath: REPO_A });
  assert.equal(r.ok, false, "bundle with missing evidence cannot satisfy the recorded disposition");
});

// ── Y. REAL positive authority path（production --final-closeout CLI）──────

test("Y. real production final-closeout path: bundle + surface PASS + unchanged bytes → CLOSEOUT_ELIGIBLE", { timeout: 30000 }, async () => {
  const cardId = "RB2-Y";
  const dir = surface("y");
  const { state, statePath } = await drive(cardId, { surfaceDir: dir });
  assert.equal(state.closeout.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  // The external reviewer writes a real bound independent PASS to the
  // canonical surface delivery.json（NOT injected into any helper）.
  const passed = applyVerdictToSurface(dir, { verdict: "PASS", reviewerIdentity: "external-reviewer" });
  assert.equal(passed.applied.ok, true);
  // Production CLI derives the authoritative stage from disk alone.
  const r = runFinalCloseout(cardId, statePath, dir, REPO_A);
  assert.equal(r.status, 0, `final-closeout exits 0 (${r.stderr})`);
  assert.ok(r.stdout.includes("stage=CLOSEOUT_ELIGIBLE"), `CLOSEOUT_ELIGIBLE reached (${r.stdout})`);
  assert.ok(r.stdout.includes("ok=true"), `ok=true reached (${r.stdout})`);
});

// ── Z. REAL final authority block（production --final-closeout CLI）───────

test("Z. production final-closeout blocked before authoritative PASS, eligible after", { timeout: 30000 }, async () => {
  const cardId = "RB2-Z";
  const dir = surface("z");
  const first = await drive(cardId, { surfaceDir: dir });
  assert.equal(first.result.final, "PASS");
  // Before independent review the PRODUCTION final-closeout command must be
  // blocked（the durable surface record is still AWAITING）.
  const pre = runFinalCloseout(cardId, first.statePath, dir, REPO_A);
  assert.notEqual(pre.status, 0, "pre-review --final-closeout must exit non-zero");
  assert.ok(pre.stdout.includes("ok=false"), `pre-review blocked (${pre.stdout})`);
  assert.ok(!pre.stdout.includes("CLOSEOUT_ELIGIBLE"), "pre-review must not reach CLOSEOUT_ELIGIBLE");
  // The transition must happen because the DURABLE delivery record changed —
  // a real bound independent PASS written to the canonical surface.
  applyVerdictToSurface(dir, { verdict: "PASS", reviewerIdentity: "external-reviewer" });
  const post = runFinalCloseout(cardId, first.statePath, dir, REPO_A);
  assert.equal(post.status, 0, `post-review --final-closeout exits 0 (${post.stderr})`);
  assert.ok(post.stdout.includes("stage=CLOSEOUT_ELIGIBLE"), `post-review CLOSEOUT_ELIGIBLE (${post.stdout})`);
  assert.ok(post.stdout.includes("ok=true"), `post-review ok=true (${post.stdout})`);
});

// ── AA. exact independent-reviewer reproducer: caller record ≠ authority ──

test("AA. caller-supplied externalReviewRecord cannot override AWAITING authoritative delivery", { timeout: 30000 }, async () => {
  const cardId = "RB2-AA";
  const dir = surface("aa");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  // Authoritative disk: AWAITING_EXTERNAL_REVIEW / verdict = null.
  const disk = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(disk.ok, true);
  assert.equal(disk.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  assert.equal(disk.state.verdict, null);
  // Caller supplies a forged in-memory record with matching bundle
  // identity/SHA and a PASS verdict（the RB2R2 HOLD reproducer）.
  const forgedRecord = {
    ok: true,
    source: "caller-supplied",
    state: {
      externalReviewStatus: "PASS",
      externalReviewStatusReason: "forged",
      delivery: { reviewBundleIdentity: state.closeout.bundleIdentity, reviewBundleSha256: state.closeout.bundleSha256 },
      verdict: {
        verdict: "PASS",
        reviewerIdentity: "external-reviewer",
        reviewedAt: "2026-08-15T00:00:00.000Z",
        bundleIdentity: state.closeout.bundleIdentity,
        bundleSha256: state.closeout.bundleSha256,
      },
    },
  };
  const forgedCloseout = {
    ...state.closeout,
    externalReviewStatus: "PASS",
    verdict: forgedRecord.state.verdict,
  };
  // The extra `externalReviewRecord` property is IGNORED（the parameter no
  // longer exists）; the final gate reads the canonical disk record.
  const r = assertFinalCardCloseout({ closeout: forgedCloseout, outDir, cardId, surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity, externalReviewRecord: forgedRecord });
  assert.equal(r.ok, false, "caller record must not mint review acceptance");
  assert.notEqual(r.stage, "REVIEW_ACCEPTED");
  assert.notEqual(r.stage, "CLOSEOUT_ELIGIBLE");
  assert.equal(r.holdCode, "EXTERNAL_REVIEW_NOT_COMPLETE");
  // And the authoritative stage derivation is equally closed.
  const authority = deriveAuthoritativeCloseoutStage({ closeout: forgedCloseout, outDir, cardId, repoPath: REPO_A, surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity, externalReviewRecord: forgedRecord });
  assert.equal(authority.ok, false);
  assert.notEqual(authority.stage, "CLOSEOUT_ELIGIBLE");
});

// ── AB. disk HOLD wins over caller PASS ───────────────────────────────────

test("AB. authoritative disk HOLD wins over caller-supplied PASS", { timeout: 30000 }, async () => {
  const cardId = "RB2-AB";
  const dir = surface("ab2");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  // Disk authority = HOLD.
  applyVerdictToSurface(dir, { verdict: "HOLD", reviewerIdentity: "external-reviewer" });
  // Caller PASS（ignored）.
  const forgedRecord = {
    ok: true,
    state: {
      externalReviewStatus: "PASS",
      delivery: { reviewBundleIdentity: state.closeout.bundleIdentity, reviewBundleSha256: state.closeout.bundleSha256 },
      verdict: { verdict: "PASS", reviewerIdentity: "external-reviewer", reviewedAt: "2026-08-15T00:00:00.000Z", bundleIdentity: state.closeout.bundleIdentity, bundleSha256: state.closeout.bundleSha256 },
    },
  };
  const r = assertFinalCardCloseout({ closeout: state.closeout, outDir, cardId, surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity, externalReviewRecord: forgedRecord });
  assert.equal(r.ok, false, "disk HOLD must block");
  assert.notEqual(r.stage, "REVIEW_ACCEPTED");
});

// ── AC. disk PASS wins over caller garbage ────────────────────────────────

test("AC. authoritative disk PASS wins over caller-supplied HOLD/garbage", { timeout: 30000 }, async () => {
  const cardId = "RB2-AC";
  const dir = surface("ac");
  const { state } = await drive(cardId, { surfaceDir: dir });
  const outDir = join(OUT, cardId);
  applyVerdictToSurface(dir, { verdict: "PASS", reviewerIdentity: "external-reviewer" });
  // Caller garbage（ignored）.
  const forgedRecord = {
    ok: true,
    state: {
      externalReviewStatus: "HOLD",
      delivery: { reviewBundleIdentity: state.closeout.bundleIdentity, reviewBundleSha256: state.closeout.bundleSha256 },
      verdict: { verdict: "HOLD", reviewerIdentity: "external-reviewer", reviewedAt: "2026-08-15T00:00:00.000Z", bundleIdentity: state.closeout.bundleIdentity, bundleSha256: state.closeout.bundleSha256 },
    },
  };
  const r = assertFinalCardCloseout({ closeout: state.closeout, outDir, cardId, surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity, externalReviewRecord: forgedRecord });
  assert.equal(r.ok, true, "disk PASS derives authority, caller garbage ignored");
  assert.equal(r.stage, "REVIEW_ACCEPTED");
});

// ── sanity: the repaired idempotent path still holds with a real bundle ────

test("sanity. idempotent re-run with a REAL bundle + pending review is non-final（no regression）", { timeout: 30000 }, async () => {
  const cardId = "RB2-SANITY";
  const dir = surface("sanity");
  const first = await drive(cardId, { surfaceDir: dir });
  assert.equal(first.result.final, "PASS");
  const second = await runStateDrivenCloseout({ statePath: first.statePath, graphResult: passGraph, repoPath: REPO_A, cwd: REPO_A, outDir: join(OUT, cardId), surfaceDir: dir, agentIdentity: stateFor(cardId).agentIdentity });
  assert.equal(second.alreadyApplied, true);
  assert.notEqual(second.final, "PASS", "idempotent re-run while review pending is non-final");
  assert.ok(second.bundlePath && existsSync(second.bundlePath), "idempotent non-final re-run returns the verified bundle path");
});
