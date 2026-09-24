// test/governance/test-execution-review.mjs
//
// RSL2 — Domain A（LATEST_EXECUTION_REVIEW）surface tests（T1–T14）+
// R-13 hardening checks.
//
// Coverage map:
//   T1  PASS execution -> Latest created
//   T2  second execution -> previous Latest archived + new Latest
//   T3  HOLD execution -> previous archived; HOLD review becomes Latest
//   T4  REPLAN execution -> review still published
//   T5  read-only execution -> review still published（admission-derived）
//   T6  external-review Current occupied -> Latest publish succeeds; inbox
//       untouched
//   T7  caller omits requiresReview, admission requires -> still mandatory
//   T8  review source generation missing -> COMPLETE blocked（barrier HOLD）
//   T9  review invalid -> publish blocked
//   T10 publish failure -> blocked; previous valid Latest preserved
//   T11 reread/hash mismatch -> verification fails（COMPLETE blocked）
//   T12 same-execution retry -> idempotent, no duplicate archive
//   T13 crash/failure during rotation -> no empty/corrupted Latest
//   T14 external inbox unresolved-occupant semantics unchanged
//   R13a apply-verdict binds the ACTUAL surface bundle bytes（divergence
//        blocked）
//   R13b forced delivery（--force / validated=false）removed（fail-closed）
//   R13c closeout-state disposition write failure fails closed

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  EXECUTION_REVIEW_SOURCE_SCHEMA,
  EXECUTION_REVIEW_HOLDS,
  executionReviewIdentity,
  publishExecutionReview,
  verifyLatestExecutionReview,
  latestExecutionReviewStatus,
  archivePreviousLatest,
  deriveExecutionReviewRequirement,
  applyExecutionReviewBarrier,
} from "../../src/governance/execution-review.mjs";
import {
  buildExternalReviewState,
  writeExternalReviewDeliveryRecord,
  readExternalReviewDeliveryRecord,
  deliverToExternalReviewSurface,
  runStateDrivenCloseout,
} from "../../src/governance/review-bundle.mjs";
import { CLOSEOUT_STATE_SCHEMA, closeoutStatePath } from "../../src/governance/closeout-state.mjs";
import { fileURLToPath } from "node:url";

const REPO_A = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");

const ROOT = join(tmpdir(), `rsl2-exec-review-${process.pid}-${Date.now()}`);
let SURFACE;
let ARCHIVE;
let INBOX;
let INBOX_ARCHIVE;

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  SURFACE = join(ROOT, "latest");
  ARCHIVE = join(ROOT, "latest", "archive");
  INBOX = join(ROOT, "inbox-current");
  INBOX_ARCHIVE = join(ROOT, "inbox-archive");
  mkdirSync(ROOT, { recursive: true });
  process.env.AUTOLOOP_EXECUTION_REVIEW_SURFACE = SURFACE;
  process.env.AUTOLOOP_EXECUTION_REVIEW_ARCHIVE = ARCHIVE;
  process.env.AUTOLOOP_REVIEW_SURFACE = INBOX;
  process.env.AUTOLOOP_REVIEW_ARCHIVE = INBOX_ARCHIVE;
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.AUTOLOOP_EXECUTION_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_EXECUTION_REVIEW_ARCHIVE;
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
});

const source = ({ executionId = "EXEC-A", cardId = "TEST-CARD", outcome = "PASS", overrides = {} } = {}) => ({
  schema: EXECUTION_REVIEW_SOURCE_SCHEMA,
  execution: {
    executionId,
    cardId,
    cardTitle: `Test ${cardId}`,
    outcome,
    holdCode: outcome === "PASS" ? null : "TEST_HOLD",
    reason: outcome === "PASS" ? null : `${outcome} reason`,
  },
  objective: "focused execution review test",
  repository: { repository: "xonogesrs/autoloop", branch: "test", head: "a".repeat(40), treeSha: "b".repeat(40), worktreePath: null },
  workSummary: "test work performed",
  mutations: { added: ["src/test-a.txt"], modified: [], deleted: [] },
  tests: [{ suite: "test-execution-review", tests: 1, pass: 1, fail: 0 }],
  findings: [],
  nextAction: "next",
  admissionRequirement: { required: true, admissionId: "adm-1", reviewPolicyStrength: "external", externalReviewRequired: true },
  ...overrides,
});

const archiveFiles = () => (existsSync(ARCHIVE) ? readdirSync(ARCHIVE).filter((f) => f.endsWith("-review.txt")).sort() : []);

const admissionFor = ({ strength = "external", external = true, readOnly = false } = {}) => ({
  schema: "autoloop.task-admission/v1",
  admission_id: `adm-${strength}-${readOnly ? "ro" : "rw"}`,
  size: "small",
  risk: "medium",
  profile: readOnly ? "read-only-reconcile" : "standard",
  reasons: [],
  capabilities: [],
  lifecycle_profile: { review: true },
  isolation_policy: {},
  durability_policy: {},
  memory_policy: { retrieval_allowed: false, writeback_allowed: false },
  review_policy: { strength, independent_review_required: strength === "independent", external_review_required: external, strict_reviewer_routing: true },
  repair_budget: 1,
  evidence_policy: {},
  human_gates: [],
  review_surface_policy: { authoritative_single_surface: true, chain: "linear", generation_policy: ["supersede_previous", "preserve_history"] },
  authority_binding: { authority_record_digest: "0".repeat(64), subset_of_lifecycle_authorization: true },
  fail_closed: true,
});

// ── T1 ────────────────────────────────────────────────────────────────────

test("T1. PASS execution -> Latest/review.txt created and verified", () => {
  const src = source();
  const r = publishExecutionReview(src, { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.idempotent, false);
  assert.equal(r.identity, executionReviewIdentity(src), "deterministic identity");
  assert.ok(existsSync(join(SURFACE, "review.txt")), "Latest/review.txt exists");
  const st = latestExecutionReviewStatus({ surfaceDir: SURFACE });
  assert.equal(st.present, true);
  assert.equal(st.executionId, "EXEC-A");
  assert.equal(st.cardId, "TEST-CARD");
  assert.equal(st.identity, r.identity);
  assert.equal(st.sha256, r.sha256);
  const v = verifyLatestExecutionReview({ surfaceDir: SURFACE, expected: { identity: r.identity, sha256: r.sha256, executionId: "EXEC-A", cardId: "TEST-CARD" } });
  assert.equal(v.ok, true, `reread/recompute verified (${v.errors.join(";")})`);
});

// ── T2 ────────────────────────────────────────────────────────────────────

test("T2. second execution -> previous Latest archived, new Latest published", () => {
  const s2 = join(ROOT, "latest-t2");
  const a2 = join(ROOT, "latest-t2-archive");
  const a = source({ executionId: "EXEC-A2", cardId: "CARD-A2" });
  const b = source({ executionId: "EXEC-B2", cardId: "CARD-B2" });
  const ra = publishExecutionReview(a, { surfaceDir: s2, archiveDir: a2 });
  assert.equal(ra.ok, true, ra.reason);
  assert.equal(latestExecutionReviewStatus({ surfaceDir: s2 }).cardId, "CARD-A2", "Latest = A");
  const rb = publishExecutionReview(b, { surfaceDir: s2, archiveDir: a2 });
  assert.equal(rb.ok, true, rb.reason);
  assert.equal(rb.previousIdentity, ra.identity, "previous identity recorded");
  assert.ok(rb.archivedPath && rb.archivedPath.includes(ra.identity.slice(0, 8)), `archive names previous identity (${rb.archivedPath})`);
  assert.equal(latestExecutionReviewStatus({ surfaceDir: s2 }).cardId, "CARD-B2", "Latest = B");
  const files = readdirSync(a2).filter((f) => f.endsWith("-review.txt"));
  assert.equal(files.length, 1, "exactly one archive entry");
  assert.ok(files[0].includes(ra.identity.slice(0, 8)), `archived file is A (${files[0]})`);
  const txt = readFileSync(join(s2, "review.txt"), "utf8");
  assert.ok(txt.includes(`LATEST_PREVIOUS_IDENTITY: ${ra.identity}`), "publication record binds previous identity");
  assert.ok(txt.includes(`LATEST_ARCHIVED_PATH: ${rb.archivedPath}`), "publication record binds archived path");
});

// ── T3 ────────────────────────────────────────────────────────────────────

test("T3. HOLD execution -> previous archived; HOLD review becomes Latest", () => {
  const ok = source({ executionId: "EXEC-OK3", cardId: "CARD-OK3", outcome: "PASS" });
  const hold = source({ executionId: "EXEC-HOLD3", cardId: "CARD-HOLD3", outcome: "HOLD" });
  const r1 = publishExecutionReview(ok, { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(r1.ok, true, r1.reason);
  const r2 = publishExecutionReview(hold, { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(r2.ok, true, `HOLD review publishes (${r2.reason})`);
  assert.equal(r2.previousIdentity, r1.identity, "previous archived");
  const st = latestExecutionReviewStatus({ surfaceDir: SURFACE });
  assert.equal(st.cardId, "CARD-HOLD3");
  assert.equal(st.outcome, "HOLD", "HOLD review is the Latest");
  const txt = readFileSync(join(SURFACE, "review.txt"), "utf8");
  assert.ok(txt.includes("OUTCOME: HOLD"), "Latest shows the HOLD outcome");
  assert.ok(archiveFiles().some((f) => f.includes(r1.identity.slice(0, 8))), "previous archived");
});

// ── T4 ────────────────────────────────────────────────────────────────────

test("T4. REPLAN execution -> review still published", () => {
  const r = publishExecutionReview(source({ executionId: "EXEC-R4", cardId: "CARD-R4", outcome: "REPLAN" }), { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(r.ok, true, `REPLAN publishes (${r.reason})`);
  assert.equal(latestExecutionReviewStatus({ surfaceDir: SURFACE }).outcome, "REPLAN");
});

// ── T5 ────────────────────────────────────────────────────────────────────

test("T5. read-only execution -> review still published (admission-derived, deterministic strength)", async () => {
  // a read-only/reconcile admission with NO external review still requires
  // the execution review（universal Domain A contract）
  const adm = admissionFor({ strength: "deterministic", external: false, readOnly: true });
  const req = deriveExecutionReviewRequirement(adm);
  assert.equal(req.required, true, "admission-derived requirement");
  assert.equal(req.externalReviewRequired, false);
  const graphView = {
    executionId: "EXEC-RO5",
    final: "PASS",
    holdCode: null,
    reason: null,
    nodeResults: [],
    transitions: [],
    admission: adm,
  };
  const b = await applyExecutionReviewBarrier({ graphView, admission: adm, closeout: null, repoPath: null, surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(b.required, true);
  assert.equal(b.ok, true, b.reason);
  assert.equal(latestExecutionReviewStatus({ surfaceDir: SURFACE }).executionId, "EXEC-RO5", "read-only execution published");
});

// ── T6 ────────────────────────────────────────────────────────────────────

test("T6. external-review Current occupied (PGMA1-like) -> Latest publishes anyway; inbox untouched", () => {
  // seed an unresolved occupant in the inbox（AWAITING_EXTERNAL_REVIEW, null
  // verdict — exactly the live PGMA1 state shape）
  const inboxBundle = join(INBOX, "review-bundle.txt");
  mkdirSync(INBOX, { recursive: true });
  const ID = "e29094b40b31f017522409d4ed8a3725d6f8b24b0973b2a66b3ab7556ebe47c9";
  const SHA = "545c741abf2fea1aec8512d56717405bec28d78efebf57cc0b523cfab4bc9975";
  writeFileSync(inboxBundle, `REVIEW_BUNDLE_IDENTITY: ${ID}\nCARD_ID: autoloop-pgma1\n${"x".repeat(400)}\n=== END OF REVIEW BUNDLE ===\nREVIEW_BUNDLE_SHA256: ${SHA}\n`, "utf8");
  const st = buildExternalReviewState({ bundle: { identity: ID, sha256: SHA }, bundlePath: inboxBundle });
  const w = writeExternalReviewDeliveryRecord({ outDir: INBOX, state: st, cardId: "autoloop-pgma1", fileName: "delivery.json" });
  assert.equal(w.ok, true, w.reason);
  const beforeBytes = readFileSync(join(INBOX, "delivery.json"), "utf8");
  const occ = readExternalReviewDeliveryRecord(join(INBOX, "delivery.json"));
  assert.equal(occ.ok, true);
  assert.equal(occ.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW", "occupant unresolved");

  // Latest publication succeeds while the inbox stays occupied
  const r = publishExecutionReview(source({ executionId: "EXEC-T6", cardId: "CARD-T6", outcome: "PASS" }), { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(r.ok, true, `Latest publishes despite occupied inbox (${r.reason})`);
  const txt = readFileSync(join(SURFACE, "review.txt"), "utf8");
  assert.ok(txt.includes("EXTERNAL_INBOX_OCCUPANT: autoloop-pgma1"), "publication record names the inbox occupant");
  assert.ok(txt.includes("EXTERNAL_INBOX_MUTATED: false"), "inbox never mutated");
  // inbox byte-identical + still unresolved
  assert.equal(readFileSync(join(INBOX, "delivery.json"), "utf8"), beforeBytes, "inbox delivery record untouched");
  const after = readExternalReviewDeliveryRecord(join(INBOX, "delivery.json"));
  assert.equal(after.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  assert.equal(after.state.verdict, null, "no verdict minted");
});

// ── T7 ────────────────────────────────────────────────────────────────────

test("T7. caller omits requiresReview but admission requires it -> review still mandatory", async () => {
  const adm = admissionFor({ strength: "external", external: true });
  const graphView = {
    executionId: "EXEC-T7",
    final: "PASS",
    holdCode: null,
    reason: null,
    nodeResults: [],
    transitions: [],
    admission: adm,
  };
  // closeout carries NO requiresReview declaration — the admission still
  // mandates the execution review（caller omission cannot bypass）
  const b = await applyExecutionReviewBarrier({ graphView, admission: adm, closeout: {}, repoPath: null, surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(b.required, true, "requirement is admission-derived");
  assert.equal(b.ok, true, b.reason);
  assert.equal(latestExecutionReviewStatus({ surfaceDir: SURFACE }).executionId, "EXEC-T7");
});

// ── T8 ────────────────────────────────────────────────────────────────────

test("T8. review source generation missing -> barrier HOLDs (COMPLETE blocked)", async () => {
  const adm = admissionFor({});
  const graphView = { executionId: "EXEC-T8", final: "PASS", holdCode: null, reason: null, nodeResults: [], transitions: [] };
  const b = await applyExecutionReviewBarrier({
    graphView,
    admission: adm,
    closeout: null,
    repoPath: null,
    surfaceDir: SURFACE,
    archiveDir: ARCHIVE,
    sourceBuilder: () => { throw new Error("generation exploded"); },
  });
  assert.equal(b.required, true);
  assert.equal(b.ok, false, "generation failure must block");
  assert.equal(b.holdCode, EXECUTION_REVIEW_HOLDS.SOURCE_FAILED);
});

// ── T9 ────────────────────────────────────────────────────────────────────

test("T9. invalid review source -> publish blocked (no Latest mutation)", () => {
  const bad = source({ executionId: "EXEC-T9", cardId: "CARD-T9" });
  delete bad.execution.cardId; // required field missing
  const before = latestExecutionReviewStatus({ surfaceDir: SURFACE });
  const r = publishExecutionReview(bad, { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, EXECUTION_REVIEW_HOLDS.INVALID);
  const after = latestExecutionReviewStatus({ surfaceDir: SURFACE });
  assert.equal(after.executionId, before.executionId, "Latest unchanged on invalid source");
});

// ── T10 ───────────────────────────────────────────────────────────────────

test("T10. publish failure -> blocked; previous valid Latest preserved", () => {
  // archive target blocked（a FILE where the archive dir must be）-> rotation
  // fails -> publish fails -> previous Latest bytes untouched
  const ok = source({ executionId: "EXEC-T10A", cardId: "CARD-T10A", outcome: "PASS" });
  const r1 = publishExecutionReview(ok, { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(r1.ok, true, r1.reason);
  const firstBytes = readFileSync(join(SURFACE, "review.txt"), "utf8");
  const blockedArchive = join(ROOT, "blocked-archive");
  writeFileSync(blockedArchive, "i am a file, not a dir", "utf8");
  const next = source({ executionId: "EXEC-T10B", cardId: "CARD-T10B", outcome: "PASS" });
  const r2 = publishExecutionReview(next, { surfaceDir: SURFACE, archiveDir: blockedArchive });
  assert.equal(r2.ok, false, "blocked rotation fails closed");
  assert.equal(r2.holdCode, EXECUTION_REVIEW_HOLDS.PUBLISH_FAILED);
  assert.equal(readFileSync(join(SURFACE, "review.txt"), "utf8"), firstBytes, "previous valid Latest preserved");
  assert.equal(latestExecutionReviewStatus({ surfaceDir: SURFACE }).executionId, "EXEC-T10A");

  // surface itself blocked（a FILE where Latest/ must be）
  const blockedSurface = join(ROOT, "blocked-surface");
  writeFileSync(blockedSurface, "blocked", "utf8");
  const r3 = publishExecutionReview(source({ executionId: "EXEC-T10C", cardId: "CARD-T10C" }), { surfaceDir: blockedSurface, archiveDir: ARCHIVE });
  assert.equal(r3.ok, false);
  assert.equal(r3.holdCode, EXECUTION_REVIEW_HOLDS.PUBLISH_FAILED);
});

// ── T11 ───────────────────────────────────────────────────────────────────

test("T11. reread/hash mismatch -> verification fails (COMPLETE blocked)", () => {
  const r = publishExecutionReview(source({ executionId: "EXEC-T11", cardId: "CARD-T11", outcome: "PASS" }), { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(r.ok, true, r.reason);
  const path = join(SURFACE, "review.txt");
  const txt = readFileSync(path, "utf8");
  // tamper: mutate a content byte without touching the footer
  const tampered = txt.replace("OUTCOME: PASS", "OUTCOME: HOLD");
  assert.notEqual(tampered, txt, "tamper applied");
  writeFileSync(path, tampered, "utf8");
  const v = verifyLatestExecutionReview({ surfaceDir: SURFACE, expected: { identity: r.identity, sha256: r.sha256 } });
  assert.equal(v.ok, false, "tampered artifact must fail verification");
  assert.ok(v.errors.some((e) => e.includes("sha_recompute_mismatch")), `recompute mismatch surfaced (${v.errors.join(";")})`);
  // restore + verify clean
  writeFileSync(path, txt, "utf8");
  const v2 = verifyLatestExecutionReview({ surfaceDir: SURFACE, expected: { identity: r.identity, sha256: r.sha256 } });
  assert.equal(v2.ok, true, v2.errors.join(";"));
});

// ── T12 ───────────────────────────────────────────────────────────────────

test("T12. same-execution retry -> idempotent, no duplicate archive", () => {
  // fresh pair of dirs for an isolated sequence
  const s2 = join(ROOT, "latest-t12");
  const a2 = join(ROOT, "latest-t12-archive");
  const src = source({ executionId: "EXEC-T12", cardId: "CARD-T12" });
  const r1 = publishExecutionReview(src, { surfaceDir: s2, archiveDir: a2 });
  assert.equal(r1.ok, true, r1.reason);
  const r2 = publishExecutionReview(src, { surfaceDir: s2, archiveDir: a2 });
  assert.equal(r2.ok, true);
  assert.equal(r2.idempotent, true, "retry idempotent");
  assert.equal(r2.archivedPath, null, "no archive on idempotent retry");
  const countAfterRetry = existsSync(a2) ? readdirSync(a2).filter((f) => f.endsWith("-review.txt")).length : 0;
  assert.equal(countAfterRetry, 0, "no duplicate archive on retry");
  // a NEW execution rotates exactly once
  const r3 = publishExecutionReview(source({ executionId: "EXEC-T12B", cardId: "CARD-T12B" }), { surfaceDir: s2, archiveDir: a2 });
  assert.equal(r3.ok, true, r3.reason);
  assert.equal(r3.previousIdentity, r1.identity);
  const files = readdirSync(a2).filter((f) => f.endsWith("-review.txt"));
  assert.equal(files.length, 1, "exactly one archive entry");
});

// ── T13 ───────────────────────────────────────────────────────────────────

test("T13. crash during rotation -> no empty/corrupted Latest; retry does not duplicate", () => {
  const s3 = join(ROOT, "latest-t13");
  const a3 = join(ROOT, "latest-t13-archive");
  const r1 = publishExecutionReview(source({ executionId: "EXEC-T13A", cardId: "CARD-T13A" }), { surfaceDir: s3, archiveDir: a3 });
  assert.equal(r1.ok, true, r1.reason);
  const bytesBefore = readFileSync(join(s3, "review.txt"), "utf8");
  // simulate the crash window: archive step completed, publish never ran
  const arch = archivePreviousLatest({ surfaceDir: s3, archiveDir: a3 });
  assert.equal(arch.ok, true, arch.reason);
  assert.equal(arch.archived, true);
  // Latest still holds the previous VALID review（never empty/corrupt）
  assert.equal(existsSync(join(s3, "review.txt")), true, "Latest not removed by rotation");
  assert.equal(readFileSync(join(s3, "review.txt"), "utf8"), bytesBefore, "Latest bytes unchanged after archive-only crash");
  // recovery: next publish works and does NOT duplicate the archive entry
  const r2 = publishExecutionReview(source({ executionId: "EXEC-T13B", cardId: "CARD-T13B" }), { surfaceDir: s3, archiveDir: a3 });
  assert.equal(r2.ok, true, `recovery publish ok (${r2.reason})`);
  assert.equal(r2.previousIdentity, r1.identity);
  const files = readdirSync(a3).filter((f) => f.endsWith("-review.txt"));
  assert.equal(files.length, 1, "no duplicate archive after crash recovery");
  assert.equal(latestExecutionReviewStatus({ surfaceDir: s3 }).executionId, "EXEC-T13B");
});

// ── T14 ───────────────────────────────────────────────────────────────────

test("T14. external inbox unresolved-occupant semantics unchanged (still fail-closed)", () => {
  // reuse the occupied inbox from T6: a different card's delivery is refused
  const otherBundle = join(ROOT, "other-bundle.txt");
  writeFileSync(otherBundle, "CARD_ID: OTHER-CARD\nREVIEW_BUNDLE_IDENTITY: " + "c".repeat(64) + "\n=== END OF REVIEW BUNDLE ===\nREVIEW_BUNDLE_SHA256: " + "d".repeat(64) + "\n", "utf8");
  const st = buildExternalReviewState({ bundle: { identity: "c".repeat(64), sha256: "d".repeat(64) }, bundlePath: otherBundle });
  const d = deliverToExternalReviewSurface({ bundlePath: otherBundle, state: st, source: { task: { cardId: "OTHER-CARD" }, evidence: [] }, surfaceDir: INBOX, currentCardId: "OTHER-CARD" });
  assert.equal(d.attempted, false, "occupied inbox still refuses a new card");
  assert.ok(d.reason.startsWith("surface_occupied"), `occupancy fail-closed intact (${d.reason})`);
  const occ = readExternalReviewDeliveryRecord(join(INBOX, "delivery.json"));
  assert.equal(occ.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW", "occupant untouched");
  assert.equal(occ.cardId, "autoloop-pgma1");
});

// ── R13a ──────────────────────────────────────────────────────────────────

test("R13a. apply-verdict binds ACTUAL surface bundle bytes; divergence blocked", () => {
  const dir = join(ROOT, "r13a");
  mkdirSync(dir, { recursive: true });
  const ID = "f".repeat(64);
  const actualSha = "1".repeat(64);
  // bundle on the surface（the authoritative material）
  const bundleBody = `REVIEW_BUNDLE_IDENTITY: ${ID}\nCARD_ID: R13A-CARD\n${"y".repeat(300)}\n=== END OF REVIEW BUNDLE ===\n`;
  writeFileSync(join(dir, "review-bundle.txt"), bundleBody + `REVIEW_BUNDLE_SHA256: ${actualSha}\n`, "utf8");
  // delivery record claims a DIFFERENT sha（stale/divergent material）
  const st = buildExternalReviewState({ bundle: { identity: ID, sha256: "2".repeat(64) }, bundlePath: join(dir, "review-bundle.txt") });
  const w = writeExternalReviewDeliveryRecord({ outDir: dir, state: st, cardId: "R13A-CARD", fileName: "delivery.json" });
  assert.equal(w.ok, true, w.reason);
  const run = spawnSync(process.execPath, [
    join(REPO_A, "scripts/gov-closeout-bundle.mjs"),
    "--apply-verdict", join(dir, "delivery.json"),
    "--verdict", "PASS",
    "--reviewer", "test-reviewer",
  ], { cwd: REPO_A, encoding: "utf8" });
  assert.notEqual(run.status, 0, `divergent verdict must be blocked (${run.stdout}${run.stderr})`);
  assert.ok(run.stderr.includes("surface_bundle_sha_diverges_from_record") || run.stdout.includes("surface_bundle_sha_diverges_from_record"), `divergence surfaced (${run.stderr})`);
  // record unchanged（no verdict minted）
  const rec = readExternalReviewDeliveryRecord(join(dir, "delivery.json"));
  assert.equal(rec.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  assert.equal(rec.state.verdict, null);
});

// ── R13b ──────────────────────────────────────────────────────────────────

test("R13b. forced delivery (--force) removed: unvalidated bundle never reaches the inbox", () => {
  const dir = join(ROOT, "r13b");
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, "not-a-bundle.txt");
  writeFileSync(bad, "this is not a review bundle at all", "utf8");
  const run = spawnSync(process.execPath, [
    join(REPO_A, "scripts/gov-external-review-surface.mjs"),
    "--deliver", bad,
    "--card", "R13B-CARD",
    "--force",
  ], { cwd: REPO_A, encoding: "utf8" });
  assert.notEqual(run.status, 0, `forced invalid delivery must be blocked (${run.stdout}${run.stderr})`);
  assert.ok((run.stderr + run.stdout).includes("deliver_blocked"), `fail-closed surfaced (${run.stderr})`);
  // the occupied inbox（PGMA1 stub from T6）is byte-identical — nothing
  // overwrote it
  assert.equal(existsSync(join(INBOX, "review-bundle.txt")), true, "inbox bundle still present");
  assert.ok(readFileSync(join(INBOX, "review-bundle.txt"), "utf8").includes("autoloop-pgma1"), "inbox bundle unchanged");
});

// ── R13c ──────────────────────────────────────────────────────────────────

test("R13c. closeout-state disposition write failure fails closed (CLOSEOUT_STATE_WRITE_FAILED)", { timeout: 30000 }, async () => {
  const cardId = "RSL2-R13C";
  // a state record whose DISPOSITION write will be secret-scanned and refused
  //（written raw to bypass the scanning writer — the read side must pass）
  const st = {
    schema: CLOSEOUT_STATE_SCHEMA,
    task: { cardId, cardTitle: "sk-aaaaaaaaaaaaaaaa secret marker", cardType: "implementation" },
    requiresReview: true,
    reviewRequiredAt: "2026-08-16T00:00:00.000Z",
    outDir: join(ROOT, "r13c-out", cardId),
    authorizedScope: ["src/governance/review-bundle.mjs"],
    unauthorizedScope: ["commit", "push", "merge", "seal"],
    designDecisions: ["R13c disposition-write fail-closed"],
    objective: "R13c: disposition write failure must not be silently ignored",
    negativeCases: [],
    regression: [],
    regressionSummary: "focused test",
    recommendedNextStep: "n/a",
    repairBudgetMaxAttempts: 1,
  };
  const stPath = closeoutStatePath(st.outDir);
  mkdirSync(dirname(stPath), { recursive: true });
  writeFileSync(stPath, JSON.stringify(st, null, 2) + "\n", "utf8");
  const graphResult = {
    executionId: "rsl2-r13c-graph",
    final: "PASS",
    holdCode: null,
    reason: null,
    scheduler: { verdict: "PASS", order: ["A"], statuses: { A: "passed" }, skipped: [], writerViolations: [], leaseHolderAfter: null },
    nodeResults: [
      { nodeId: "A", phaseExecutionId: "e_r13c_a", taskType: "audit", dependencies: [], final: "PASS", attempt: 0, cleanup: { worktreeRevoked: false } },
    ],
    transitions: [],
  };
  const r = await runStateDrivenCloseout({
    statePath: stPath,
    graphResult,
    repoPath: REPO_A,
    cwd: REPO_A,
    outDir: st.outDir,
    timeoutMs: 8000,
    surfaceDir: join(ROOT, "r13c-surface"),
  });
  assert.equal(r.applied, true);
  assert.notEqual(r.final, "PASS", "disposition write failure must not mint PASS");
  assert.equal(r.holdCode, "CLOSEOUT_STATE_WRITE_FAILED", `write failure surfaced (${r.holdCode} / ${r.reason})`);
});
