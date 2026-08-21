// test/governance/test-review-delivery-invariant.mjs
//
// AUTOLOOP-V1-REVFIX-B2（MANDATORY-REVIEW-DELIVERY-INVARIANT）— focused
// proof that publication for a FORMAL review closeout is REQUIRED once
// runCloseoutGate is reached with a valid bundle, and that the caller-
// supplied `externalReview.deliveryRequired` source flag is informational
// only — it can never suppress publication, and its absence / false /
// malformed shape can never silently skip it.
//
// Coverage:
//   T1  canonical source + deliveryRequired:true     -> publish
//   T2  deliveryRequired ABSENT                      -> publish
//   T3  deliveryRequired:false                       -> publish（cannot suppress）
//   T4  malformed deliveryRequired / non-object      -> canonicalize; never silent skip
//   T4c formal + deliver:null opt-out                -> FAIL CLOSED（HOLD）
//   T5  externalReview object absent                 -> formal closeout still publishes
//   T6  validation failure                           -> no Current mutation
//   T7  publication failure                          -> not reported as successful delivery
//   T8  valid formal closeout                        -> delivery.attempted === true
//   T9  Current bundle identity == generated identity（recomputed + record）
//   T10 non-formal / test helper path                -> no surface publication
//   N1  non-formal + flag true                       -> flag has NO authority（no publish）
//
// Run: node --test test/governance/test-review-delivery-invariant.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_BUNDLE_SOURCE_SCHEMA,
  REVIEW_BUNDLE_HOLDS,
  EXTERNAL_REVIEW_HOLDS,
  EXTERNAL_REVIEW_STATUSES,
  runCloseoutGate,
  collectRepoFacts,
  verifyExternalReviewSurface,
  bundleContentSha256,
  readExternalReviewDeliveryRecord,
} from "../../src/governance/review-bundle.mjs";

const REPO_A = "/Volumes/NVM2T/Development/repos/autoloop";
const ROOT = `${tmpdir()}/review-delivery-invariant-${process.pid}`;
const OUT = join(ROOT, "out");
const repoEntriesBefore = spawnSync("git", ["-C", REPO_A, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

let bundleCount = 0;
let surfaceSeq = 0;
const nextSurface = () => join(ROOT, `surface-${surfaceSeq++}`);

// A minimal, valid PASS closeout source. By default it carries NO
// externalReview block at all（the legacy source shape the invariant must
// cover）; tests add one explicitly when they want it.
function mkSource(overrides = {}) {
  bundleCount += 1;
  return {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: { cardId: `REVFIX-B2-TEST-${bundleCount}`, cardTitle: "Mandatory Review Delivery Invariant Test", cardType: "implementation" },
    graph: { graphRunId: `revfix-b2-${bundleCount}` },
    repo: { repository: facts.repository ?? null, branch: facts.branch, head: facts.head, treeSha: facts.treeSha, worktreePath: facts.worktreePath, baselineDirtyDigest: facts.baselineDirtyDigest, finalDirtyDigest: facts.finalDirtyDigest, remote: facts.remote },
    objective: "prove formal closeout publication is a mandatory invariant",
    executiveStatus: "PASS",
    executiveSummary: "bundle generated and validated",
    authorizedScope: ["src/governance/review-bundle.mjs", "test/governance/test-review-delivery-invariant.mjs"],
    unauthorizedScope: ["commit", "push", "merge", "seal"],
    designDecisions: ["delivery authority = formal gate + valid bundle, never the caller flag"],
    files: { added: ["src/governance/review-bundle.mjs"], modified: [], deleted: [] },
    diffSummary: "mandatory delivery invariant",
    execution: { testsExecuted: ["node --test test/governance/test-review-delivery-invariant.mjs"], testResults: { passed: 1, failed: 0, total: 1 }, pass: true },
    verifier: { pass: true, result: "PASS", summary: "verify PASS" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "d".repeat(64), blockingFindings: [], summary: "review PASS" },
    repairAttempts: [],
    negativeCases: ["missing deliveryRequired must never silently skip publication"],
    regression: [{ suite: "governance", tests: 1, pass: 1, fail: 0 }],
    evidence: [],
    security: { secretScanResult: "clean", ingestionAllowlist: ["structured results"], ingestionDenylist: ["secrets"] },
    risks: [], limitations: [],
    rollbackProcedure: "regenerate",
    openQuestions: [],
    recommendedNextStep: "B4",
    ...overrides,
  };
}

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  // main repo zero pollution（tests never add/remove files under repo A）
  const now = spawnSync("git", ["-C", REPO_A, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
  assert.equal(now, repoEntriesBefore, "main repo working tree unchanged by the test suite");
});

const facts = collectRepoFacts(REPO_A);
const gate = (source, opts = {}) => runCloseoutGate({ source, repoPath: REPO_A, outDir: OUT, timeoutMs: 10000, repoFacts: facts, ...opts });

const surfaceTrio = (dir) => ({
  bundle: existsSync(join(dir, "review-bundle.txt")),
  delivery: existsSync(join(dir, "delivery.json")),
});

// ── T1: canonical source + deliveryRequired:true → publish ────────────────

test("T1. canonical source + deliveryRequired:true -> publish（attempted=true）", { timeout: 30000 }, async () => {
  const surfaceDir = nextSurface();
  const source = mkSource({ externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null } });
  const r = await gate(source, { formal: true, surfaceDir });
  assert.equal(r.final, "PASS", `final PASS (${r.reason})`);
  assert.equal(r.externalReview.delivery.attempted, true, "delivery attempted");
  assert.equal(r.externalReview.delivery.method, "external-review-surface");
  assert.equal(r.externalReview.externalReviewStatus, EXTERNAL_REVIEW_STATUSES[0], "AWAITING_EXTERNAL_REVIEW（attempt is not a receipt）");
  const trio = surfaceTrio(surfaceDir);
  assert.equal(trio.bundle, true, "Current/review-bundle.txt published");
  assert.equal(trio.delivery, true, "Current/delivery.json published");
});

// ── T2: deliveryRequired ABSENT → publish（the production-gap shape）────────

test("T2. deliveryRequired ABSENT -> still publishes（no silent PASS-without-publish）", { timeout: 30000 }, async () => {
  const surfaceDir = nextSurface();
  const source = mkSource(); // NO externalReview at all（legacy source shape）
  const r = await gate(source, { formal: true, surfaceDir });
  assert.equal(r.final, "PASS", `final PASS (${r.reason})`);
  assert.equal(r.externalReview.delivery.attempted, true, "delivery attempted despite missing flag");
  const trio = surfaceTrio(surfaceDir);
  assert.equal(trio.bundle, true, "Current/review-bundle.txt published");
  assert.equal(trio.delivery, true, "Current/delivery.json published");
  // the bundle's own rendered delivery contract is the DERIVED truth
  const txt = readFileSync(join(surfaceDir, "review-bundle.txt"), "utf8");
  assert.ok(txt.includes("REVIEW_BUNDLE_DELIVERY_REQUIRED: true"), "derived informational field renders true");
});

// ── T3: deliveryRequired:false → cannot suppress formal delivery ───────────

test("T3. deliveryRequired:false -> cannot suppress formal delivery", { timeout: 30000 }, async () => {
  const surfaceDir = nextSurface();
  const source = mkSource({ externalReview: { deliveryRequired: false, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null } });
  const r = await gate(source, { formal: true, surfaceDir });
  assert.equal(r.final, "PASS", `final PASS (${r.reason})`);
  assert.equal(r.externalReview.delivery.attempted, true, "explicit false cannot suppress");
  const trio = surfaceTrio(surfaceDir);
  assert.equal(trio.bundle, true, "published despite deliveryRequired:false");
});

// ── T4: malformed deliveryRequired → canonicalize, never silent skip ───────

test("T4. malformed deliveryRequired -> canonicalize to mandatory delivery（never silent skip）", { timeout: 30000 }, async () => {
  // (a) malformed flag value（non-boolean）
  const surfaceA = nextSurface();
  const sourceA = mkSource({ externalReview: { deliveryRequired: "yes", status: "AWAITING_EXTERNAL_REVIEW", supersedes: null } });
  const ra = await gate(sourceA, { formal: true, surfaceDir: surfaceA });
  assert.equal(ra.final, "PASS", `final PASS (${ra.reason})`);
  assert.equal(ra.externalReview.delivery.attempted, true, "malformed flag cannot skip");
  assert.equal(surfaceTrio(surfaceA).bundle, true, "published");

  // (b) non-object externalReview（garbage shape）
  const surfaceB = nextSurface();
  const sourceB = mkSource({ externalReview: "garbage-not-an-object" });
  const rb = await gate(sourceB, { formal: true, surfaceDir: surfaceB });
  assert.equal(rb.final, "PASS", `final PASS (${rb.reason})`);
  assert.equal(rb.externalReview.delivery.attempted, true, "non-object externalReview cannot skip");
  assert.equal(surfaceTrio(surfaceB).bundle, true, "published");
});

test("T4c. formal closeout + deliver:null opt-out -> FAIL CLOSED（HOLD, never PASS-without-publish）", { timeout: 30000 }, async () => {
  const surfaceDir = nextSurface();
  const source = mkSource();
  const r = await gate(source, { formal: true, surfaceDir, deliver: null });
  assert.notEqual(r.final, "PASS", "formal closeout cannot be made to skip delivery");
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, EXTERNAL_REVIEW_HOLDS.DELIVERY_NOT_CONFIRMED);
  assert.ok(String(r.reason).includes("FORMAL_CLOSEOUT_DELIVERY_OPT_OUT_DENIED"), `reason=${r.reason}`);
  assert.equal(surfaceTrio(surfaceDir).bundle, false, "nothing published（denied before publish）");
});

// ── T5: externalReview object absent → formal closeout still delivers ──────

test("T5. externalReview object absent -> formal closeout cannot silently skip delivery", { timeout: 30000 }, async () => {
  const surfaceDir = nextSurface();
  const source = mkSource();
  assert.equal(source.externalReview, undefined, "fixture really has no externalReview");
  const r = await gate(source, { formal: true, surfaceDir });
  assert.equal(r.final, "PASS");
  assert.equal(r.externalReview.delivery.attempted, true);
  const trio = surfaceTrio(surfaceDir);
  assert.equal(trio.bundle && trio.delivery, true, "full trio published");
  // the structured state itself always records delivery as required
  assert.equal(r.externalReview.reviewBundleDeliveryRequired, true, "state deliveryRequired true");
  assert.equal(r.externalReview.delivery.required, true);
});

// ── T6: generator validation failure → no Current mutation ────────────────

test("T6. validation failure -> HOLD before any Current mutation", { timeout: 30000 }, async () => {
  const surfaceDir = nextSurface();
  const source = mkSource();
  const r = await gate(source, {
    formal: true,
    surfaceDir,
    validate: () => ({ ok: false, errors: ["forced_validation_failure"], holdCode: REVIEW_BUNDLE_HOLDS.INVALID }),
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.INVALID);
  assert.ok(!r.externalReview?.delivery?.attempted, "no delivery attempted on invalid bundle");
  const trio = surfaceTrio(surfaceDir);
  assert.equal(trio.bundle, false, "invalid bundle must not publish");
  assert.equal(trio.delivery, false, "no delivery record for an invalid bundle");
});

// ── T7: publication failure → not reported as successful closeout delivery ─

test("T7. publication failure -> closeout cannot report successful delivery（fail-closed）", { timeout: 30000 }, async () => {
  // (a) the deliverer throws
  const surfaceA = nextSurface();
  const ra = await gate(mkSource(), {
    formal: true,
    surfaceDir: surfaceA,
    deliver: async () => { throw new Error("surface down"); },
  });
  assert.equal(ra.final, "AWAITING_BUNDLE_DELIVERY", "throw -> non-PASS");
  assert.equal(ra.externalReview.externalReviewStatus, EXTERNAL_REVIEW_STATUSES[1]);
  assert.equal(ra.externalReview.delivery.attempted, false, "no successful delivery claim");
  assert.ok(String(ra.reason).includes("delivery_error"), `reason=${ra.reason}`);

  // (b) the deliverer reports attempted:false
  const surfaceB = nextSurface();
  const rb = await gate(mkSource(), {
    formal: true,
    surfaceDir: surfaceB,
    deliver: async () => ({ attempted: false, reason: "channel-down" }),
  });
  assert.equal(rb.final, "AWAITING_BUNDLE_DELIVERY", "declined -> non-PASS");
  assert.equal(rb.externalReview.delivery.attempted, false);
  assert.ok(String(rb.reason).includes("delivery_blocked"), `reason=${rb.reason}`);
});

// ── T8: valid formal closeout → delivery.attempted === true ───────────────

test("T8. valid formal closeout -> delivery.attempted === true", { timeout: 30000 }, async () => {
  const surfaceDir = nextSurface();
  const r = await gate(mkSource(), { formal: true, surfaceDir });
  assert.equal(r.final, "PASS");
  assert.equal(r.externalReview.delivery.attempted, true);
  assert.ok(r.externalReview.delivery.attemptedAt, "attemptedAt recorded");
  assert.equal(r.externalReview.delivery.method, "external-review-surface");
});

// ── T9: Current bundle identity == generated bundle identity ──────────────

test("T9. Current bundle identity == generated bundle identity（recomputed + record）", { timeout: 30000 }, async () => {
  const surfaceDir = nextSurface();
  const source = mkSource(); // no deliveryRequired
  const r = await gate(source, { formal: true, surfaceDir });
  assert.equal(r.final, "PASS");
  const bundlePath = join(surfaceDir, "review-bundle.txt");
  const raw = readFileSync(bundlePath, "utf8");
  const surfaceIdentity = raw.match(/^REVIEW_BUNDLE_IDENTITY: ([0-9a-f]{64})$/m)?.[1] ?? null;
  assert.equal(surfaceIdentity, r.bundle.identity, "Current identity == generated identity");
  assert.equal(bundleContentSha256(bundlePath), r.bundle.sha256, "Current content sha == generated sha（recomputed）");
  const rec = readExternalReviewDeliveryRecord(join(surfaceDir, "delivery.json"));
  assert.equal(rec.ok, true, `delivery record valid (${rec.errors.join(";")})`);
  assert.equal(rec.state.delivery.reviewBundleIdentity, r.bundle.identity, "record identity bound");
  assert.equal(rec.state.delivery.reviewBundleSha256, r.bundle.sha256, "record sha bound");
  assert.equal(rec.state.delivery.attempted, true, "record attempted");
  const proof = verifyExternalReviewSurface({
    surfaceDir,
    expected: { identity: r.bundle.identity, sha256: r.bundle.sha256, cardId: source.task.cardId },
  });
  assert.equal(proof.ok, true, `surface re-verification passes (${proof.errors.join(";")})`);
});

// ── T10: non-formal / test helper path → no desktop publication ───────────

test("T10. non-formal / test helper path -> no surface publication", { timeout: 30000 }, async () => {
  const surfaceDir = nextSurface();
  // simulate a configured surface: a non-formal PASS closeout must not write
  // to it, even though delivery machinery is fully wired.
  process.env.AUTOLOOP_REVIEW_SURFACE = surfaceDir;
  try {
    const r = await gate(mkSource()); // NO formal, NO deliver hook
    assert.equal(r.final, "PASS", `non-formal PASS unchanged (${r.reason})`);
    assert.equal(r.externalReview.delivery.attempted, false, "no delivery attempt from a test-helper path");
    assert.equal(r.externalReview.delivery.method, null);
    const trio = surfaceTrio(surfaceDir);
    assert.equal(trio.bundle, false, "nothing published to the surface");
    assert.equal(trio.delivery, false, "no delivery record written");
    // non-formal source shape stays untouched（NOT_APPLICABLE rendering）
    const txt = readFileSync(r.bundlePath, "utf8");
    assert.ok(txt.includes("REVIEW_BUNDLE_DELIVERY_REQUIRED: NOT_APPLICABLE"), "non-formal informational field untouched");

    // explicit deliver:null opt-out still works on the non-formal path
    const r2 = await gate(mkSource(), { deliver: null });
    assert.equal(r2.final, "PASS", "explicit test opt-out allowed on non-formal path");
    assert.equal(r2.externalReview.delivery.attempted, false);
  } finally {
    delete process.env.AUTOLOOP_REVIEW_SURFACE;
  }
});

// ── N1: the source flag has NO authority anywhere（even non-formal）────────

test("N1. deliveryRequired:true on a NON-formal path has no authority（no publication）", { timeout: 30000 }, async () => {
  const surfaceDir = nextSurface();
  process.env.AUTOLOOP_REVIEW_SURFACE = surfaceDir;
  try {
    const source = mkSource({ externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null } });
    const r = await gate(source); // non-formal — the flag alone must not publish
    assert.equal(r.final, "PASS");
    assert.equal(r.externalReview.delivery.attempted, false, "flag is informational only — never the publication authority");
    assert.equal(surfaceTrio(surfaceDir).bundle, false, "no publication");
  } finally {
    delete process.env.AUTOLOOP_REVIEW_SURFACE;
  }
});

// ── F1: formal + explicit custom deliver hook still works ─────────────────

test("F1. formal closeout with an explicit custom deliver hook -> hook is the channel", { timeout: 30000 }, async () => {
  let called = 0;
  const r = await gate(mkSource(), {
    formal: true,
    deliver: async (d) => { called += 1; assert.ok(d.bundlePath && existsSync(d.bundlePath)); return { attempted: true, method: "custom-channel" }; },
  });
  assert.equal(called, 1, "custom hook invoked");
  assert.equal(r.final, "PASS");
  assert.equal(r.externalReview.delivery.attempted, true);
  assert.equal(r.externalReview.delivery.method, "custom-channel");
});
