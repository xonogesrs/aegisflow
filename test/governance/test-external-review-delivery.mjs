// test/governance/test-external-review-delivery.mjs
//
// RB-1G — External Reviewer Bundle Delivery Governance（repair round）.
//
// One externally reviewed card requires ONE complete review bundle available
// to the external reviewer. Bundle generation, validation, internal review,
// path, identity, and SHA are necessary evidence but do NOT constitute
// external review. External review is complete only after the external
// reviewer has received and reviewed the ACTUAL bundle content and issued a
// verdict.
//
// RECEIPT MODEL（external repair finding）: the execution side can NEVER
// authoritatively confirm delivery. The external reviewer's verdict — bound
// to the CURRENT bundle identity + sha256, a real reviewer identity and a
// reviewedAt timestamp — IS the receipt acknowledgment; applying it proves
// RECEIVED + REVIEWED in one step. A sender-side delivery attempt is
// INFORMATIONAL ONLY（DELIVERY_ATTEMPTED）and never contributes to
// completion.
//
// Coverage（RB-1G required items + repair finding）:
//   1. requiresReview=true -> bundle must be generated
//   2. bundle generated, no receipt yet -> external review AWAITING_EXTERNAL_REVIEW
//   3. path + SHA present without a reviewer verdict -> no external PASS
//   4. internal reviewer PASS -> no automatic external PASS
//   5. external PASS verdict（the receipt）bound to the bundle -> complete
//   6. external REPAIR -> original bundle retained
//   7. repair closeout -> superseding bundle（new identity/sha; supersedes old）
//   8. external HOLD -> downstream stops
//   9. requiresReview=false internal nodes unaffected by the card-level rule
//   10. existing automatic bundle generation/validation regression intact
//   R. sender-side delivery attempt is NON-AUTHORITATIVE（the repair finding）
//   + self-declared verdict rejected / stale-bundle verdict rejected /
//     delivery record persistence roundtrip
//
// Run: node --test test/governance/test-external-review-delivery.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_BUNDLE_SOURCE_SCHEMA,
  REVIEW_BUNDLE_HOLDS,
  EXTERNAL_REVIEW_STATUSES,
  EXTERNAL_REVIEW_HOLDS,
  runMandatoryGraphCloseout,
  runCloseoutGate,
  collectRepoFacts,
  validateReviewBundle,
  buildExternalReviewState,
  recordDeliveryAttempt,
  applyExternalReviewVerdict,
  externalReviewComplete,
  cardExternalReviewStatus,
  buildSupersedeRecord,
  writeExternalReviewDeliveryRecord,
  readExternalReviewDeliveryRecord,
  supersedesFromBundleText,
  renderReviewBundle,
} from "../../src/governance/review-bundle.mjs";

const REPO_A = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");
const ROOT = `${tmpdir()}/rb1g-delivery-${process.pid}`;
const OUT = join(ROOT, "out");
const OUT2 = join(ROOT, "out2");
const SURFACE = join(ROOT, "surface");
const ARCHIVE = join(ROOT, "archive");

const facts = collectRepoFacts(REPO_A);
const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// ── realistic structured Graph result（same shape as runColimaGraph）──────

const passGraph = {
  executionId: "fixture-rb1g-pass-1",
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
      nodeId: "R1",
      phaseExecutionId: "exec_rb1g_r1",
      taskType: "count_todos",
      dependencies: [],
      final: "PASS",
      attempt: 0,
      reason: null,
      startedAt: 1,
      completedAt: 2,
      cleanup: { worktreeRevoked: false },
      subagentResult: { status: "PASS", testResults: null, testsExecuted: [] },
    },
    {
      nodeId: "W1",
      phaseExecutionId: "exec_rb1g_w1",
      taskType: "write_report",
      dependencies: ["R1"],
      final: "PASS",
      attempt: 0,
      reason: null,
      startedAt: 3,
      completedAt: 4,
      worktreeIdentity: {
        verified: true,
        output: { files: [{ status: " M", path: "src/governance/review-bundle.mjs", source: null, destination: null, rename: false }] },
      },
      cleanup: { worktreeRevoked: true },
      subagentResult: { status: "PASS", testResults: { passed: 2, failed: 0, total: 2 }, testsExecuted: ["self-test"] },
      reviewResult: {
        status: "PASS",
        findings: [],
        blockingFindings: [],
        scopeVerified: true,
        testsVerified: true,
        recommendedAction: "PASS",
        summary: "independent review PASS",
      },
    },
    {
      nodeId: "V1",
      phaseExecutionId: "exec_rb1g_v1",
      taskType: "verify_writer",
      dependencies: ["W1"],
      final: "PASS",
      attempt: 0,
      reason: null,
      startedAt: 5,
      completedAt: 6,
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

const repairGraph = {
  ...passGraph,
  executionId: "fixture-rb1g-repair-1",
  nodeResults: passGraph.nodeResults.map((n) => (n.nodeId === "W1"
    ? {
        ...n,
        attempt: 1,
        reviewResult: { ...n.reviewResult, recommendedAction: "PASS", blockingFindings: [] },
      }
    : n)),
  transitions: passGraph.transitions.map((tx) => (tx.phaseId === "W1"
    ? {
        ...tx,
        attempt: 1,
        lifecycleTransitions: [
          { phase: "reviewer_verdict", attempt: 0, verdict: "NEEDS_SUPPLEMENT", recommended_next_action: "REPAIR" },
          { phase: "reviewer_verdict", attempt: 1, verdict: "PASS", recommended_next_action: "STOP" },
        ],
      }
    : tx)),
};

const closeoutOpts = (outDir, overrides = {}) => ({
  requiresReview: true,
  cardId: "RB-1G-TEST",
  cardTitle: "External Review Bundle Delivery Governance Test",
  cardType: "implementation",
  objective: "verify the RB-1G external review bundle delivery governance",
  authorizedScope: ["src/governance/review-bundle.mjs", "test/governance/test-external-review-delivery.mjs"],
  unauthorizedScope: ["commit", "push", "merge", "seal"],
  designDecisions: ["structured external-review state in card closeout; verdict is the receipt"],
  negativeCases: ["path/sha without a reviewer verdict never PASSes external review"],
  regression: [{ suite: "test:governance", tests: 1, pass: 1, fail: 0 }],
  regressionSummary: "focused tests pass",
  recommendedNextStep: "CBM-2 external review",
  repairBudgetMaxAttempts: 1,
  ...overrides,
});

let _surfaceSeq = 0;
const run = (graph, opts = {}) => runMandatoryGraphCloseout({
  graphResult: graph,
  closeout: closeoutOpts(OUT, {
    ...opts.closeout,
    // RB-1H repair: occupancy fail-closed — an un-rotated published trio is
    // never overwritten, so each run gets its own isolated surface.
    surfaceDir: join(ROOT, `surface-${_surfaceSeq++}`),
  }),
  repoPath: REPO_A,
  outDir: OUT,
  timeoutMs: opts.timeoutMs ?? 8000,
  gate: opts.gate,
});

// A genuine external reviewer verdict（the receipt）. Requires the state's
// bundle binding + a real reviewer identity + a reviewed-at timestamp.
const verdictInput = (state, overrides = {}) => ({
  verdict: "PASS",
  reviewerIdentity: "AUTOLOOP_PI_GRAPH_RB1G_EXTERNAL_REVIEW",
  reviewedAt: "2026-08-07T18:00:00.000Z",
  bundleIdentity: state.delivery?.reviewBundleIdentity ?? null,
  bundleSha256: state.delivery?.reviewBundleSha256 ?? null,
  ...overrides,
});

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(OUT2, { recursive: true });
  // RB-1H: requiresReview closeouts now default-deliver to the fixed
  // surface — redirect it away from the real Desktop inbox during tests.
  process.env.AUTOLOOP_REVIEW_SURFACE = SURFACE;
  process.env.AUTOLOOP_REVIEW_ARCHIVE = ARCHIVE;
});
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
});

// ── 1. requiresReview=true -> bundle MUST be generated ─────────────────────

test("1. requiresReview=true -> bundle must be generated（structured state + artifact on disk）", { timeout: 30000 }, async () => {
  const r = await run(passGraph);
  assert.equal(r.applied, true);
  assert.equal(r.final, "PASS", `bundle gate PASS (${r.reason})`);
  assert.equal(r.externalReview.reviewBundleGenerated, true, "reviewBundleGenerated=true");
  assert.equal(r.externalReview.reviewBundleValidated, true, "reviewBundleValidated=true");
  assert.equal(r.externalReview.reviewBundleDeliveryRequired, true, "reviewBundleDeliveryRequired=true");
  assert.ok(r.bundlePath && existsSync(r.bundlePath), "bundle artifact exists");
  // the state sha256 equals the validator-recomputed CONTENT sha（excludes
  // the REVIEW_BUNDLE_SHA256 footer line — same recompute as the validator）
  const raw = readFileSync(r.bundlePath, "utf8");
  const contentOnly = raw.slice(0, raw.lastIndexOf("REVIEW_BUNDLE_SHA256:"));
  assert.equal(
    createHash("sha256").update(contentOnly).digest("hex"),
    r.externalReview.delivery.reviewBundleSha256,
    "state sha256 == artifact content sha256",
  );
});

// ── 2. bundle generated, no receipt -> AWAITING_EXTERNAL_REVIEW ────────────

test("2. bundle generated, no reviewer verdict yet -> externalReviewStatus = AWAITING_EXTERNAL_REVIEW", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-2" } });
  assert.equal(r.final, "PASS", "bundle gate PASS");
  assert.equal(r.externalReview.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW", "status AWAITING_EXTERNAL_REVIEW");
  // RB-1H hard rule: the default deliverer atomically delivers the validated
  // bundle to the fixed external-review surface（Current/）; that is still
  // only an ATTEMPT — it never changes the status and never confirms receipt.
  assert.equal(r.externalReview.delivery.attempted, true, "default surface delivery attempted");
  assert.equal(r.externalReview.delivery.method, "external-review-surface", "surface method recorded");
  assert.equal(r.externalReview.verdict, null, "no verdict yet");
  assert.equal(externalReviewComplete(r.externalReview), false, "external review NOT complete");
  const guard = cardExternalReviewStatus(r.externalReview);
  assert.equal(guard.complete, false);
  assert.equal(guard.status, "AWAITING_EXTERNAL_REVIEW");
  assert.equal(guard.holdCode, EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE);
});

// ── 3. path + SHA present, no verdict -> no external PASS ──────────────────

test("3. path + SHA exist but no reviewer verdict -> external PASS impossible", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-3" } });
  // path + identity + sha are all present...
  assert.ok(r.bundlePath, "bundle path present");
  assert.ok(r.externalReview.delivery.reviewBundleIdentity, "identity present");
  assert.ok(r.externalReview.delivery.reviewBundleSha256, "sha256 present");
  // ...but there is no RECEIPT: the only way to PASS is the external
  // reviewer's own verdict（bind + reviewer identity + reviewedAt）. The
  // sender cannot fabricate one — the state stays AWAITING_EXTERNAL_REVIEW.
  assert.equal(r.externalReview.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW", "no receipt -> no status change");
  assert.equal(externalReviewComplete(r.externalReview), false, "no external PASS");
  assert.equal(cardExternalReviewStatus(r.externalReview).complete, false);
});

// ── 4. internal reviewer PASS -> no automatic external PASS ────────────────

test("4. internal reviewer PASS -> NOT automatic external PASS", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-4" } });
  // the internal review agent PASSed（bundle records REVIEW_PASS: true）and the
  // bundle gate PASSed（internal closeout complete）...
  const txt = readFileSync(r.bundlePath, "utf8");
  assert.ok(txt.includes("REVIEW_PASS: true"), "internal review PASS recorded in bundle");
  assert.equal(r.final, "PASS", "bundle gate PASS (internal closeout)");
  // ...but external review is NOT complete and no EXTERNAL_REVIEW_PASS exists
  assert.equal(externalReviewComplete(r.externalReview), false, "internal PASS != external PASS");
  assert.equal(r.externalReview.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  assert.equal(r.externalReview.verdict, null, "no external verdict");
});

// ── 5. external PASS verdict（the receipt）-> complete ─────────────────────

test("5. external PASS verdict bound to the bundle -> external review complete（verdict is the receipt）", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-5" } });
  // the external reviewer actually reviewed the bundle and returned PASS
  // bound to its identity + sha256 —— this one step proves RECEIVED + REVIEWED
  const applied = applyExternalReviewVerdict(r.externalReview, verdictInput(r.externalReview));
  assert.equal(applied.ok, true, `verdict applied (${applied.errors.join(";")})`);
  assert.equal(applied.state.externalReviewStatus, "PASS");
  assert.equal(externalReviewComplete(applied.state), true, "external review complete");
  const guard = cardExternalReviewStatus(applied.state);
  assert.equal(guard.complete, true);
  assert.equal(guard.holdCode, null);
});

// ── 6. external REPAIR -> original bundle retained ─────────────────────────

test("6. external REPAIR -> original bundle retained（never overwritten）", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-6" } });
  const originalPath = r.bundlePath;
  const originalFileSha = shaFile(originalPath);
  const originalSha = r.externalReview.delivery.reviewBundleSha256;
  const applied = applyExternalReviewVerdict(r.externalReview, verdictInput(r.externalReview, { verdict: "REPAIR" }));
  assert.equal(applied.ok, true);
  assert.equal(applied.state.externalReviewStatus, "REPAIR");
  assert.equal(externalReviewComplete(applied.state), false, "REPAIR not complete");
  // bounded repair produces a NEW bundle; the ORIGINAL artifact must survive.
  // The superseding bundle is itself the external-review-triggered bounded
  // repair generation（closeout-accounting）: REPAIR_BUDGET_USED must show 1
  // consumed against MAX=1（USED=0 would let the control plane allow another
  // repair round）, and the section-14 binding must declare the superseded
  // verdict（SUPERSEDES_BUNDLE_VERDICT: REPAIR）.
  const repairCloseout = await run(passGraph, {
    closeout: { cardId: "RB-1G-TEST-6", cardType: "repair", supersedes: buildSupersedeRecord(applied.state) },
  });
  assert.equal(repairCloseout.final, "PASS");
  const repairTxt = readFileSync(repairCloseout.bundlePath, "utf8");
  assert.ok(repairTxt.includes("attempt=0 taskType=external-review-superseding-repair status=REPAIR"), "superseding repair generation recorded in attempt history");
  assert.ok(repairTxt.includes("REPAIR_BUDGET_MAX: 1"), "repair budget max bound");
  assert.ok(repairTxt.includes("REPAIR_BUDGET_USED: 1"), "superseding repair generation consumes 1 of the card-level budget");
  assert.ok(repairTxt.includes(`SUPERSEDES_BUNDLE_VERDICT: REPAIR`), "section 14 declares the superseded verdict");
  assert.ok(existsSync(originalPath), "original bundle retained on disk");
  assert.equal(shaFile(originalPath), originalFileSha, "original bundle bytes unchanged");
  assert.equal(originalSha, applied.state.delivery.reviewBundleSha256);
});

// ── 7. repair closeout -> superseding bundle ───────────────────────────────

test("7. repair closeout -> superseding bundle（new identity/sha; explicit supersede; awaits re-review）", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-7", repairBudgetMaxAttempts: 2 } });
  const oldIdentity = r.externalReview.delivery.reviewBundleIdentity;
  const oldSha = r.externalReview.delivery.reviewBundleSha256;
  const oldPath = r.bundlePath;
  const oldFileSha = shaFile(oldPath);
  const applied = applyExternalReviewVerdict(r.externalReview, verdictInput(r.externalReview, { verdict: "REPAIR" }));
  assert.equal(applied.ok, true);

  const repair = await run(repairGraph, {
    closeout: {
      cardId: "RB-1G-TEST-7",
      cardType: "repair",
      // closeout-accounting: REPAIR_BUDGET_USED counts BOTH the in-graph node
      // retry（W1 attempt=1 -> 1 REPAIR-status iteration）AND the
      // external-review-triggered superseding repair generation（+1）— this
      // fixture consumes 2 of MAX=2.
      repairBudgetMaxAttempts: 2,
      supersedes: buildSupersedeRecord(applied.state),
    },
  });
  assert.equal(repair.final, "PASS");
  const newIdentity = repair.externalReview.delivery.reviewBundleIdentity;
  const newSha = repair.externalReview.delivery.reviewBundleSha256;
  assert.notEqual(newIdentity, oldIdentity, "new bundle identity");
  assert.notEqual(newSha, oldSha, "new bundle sha256");
  assert.notEqual(repair.bundlePath, oldPath, "new artifact does not overwrite old");
  assert.equal(repair.externalReview.supersedes.reviewBundleIdentity, oldIdentity, "supersedes old identity");
  assert.equal(repair.externalReview.supersedes.reviewBundleSha256, oldSha, "supersedes old sha");
  assert.equal(repair.externalReview.supersedes.verdict, "REPAIR", "supersede bound to external REPAIR");
  // the bundle TEXT records the supersede + attempt history + accounting
  const txt = readFileSync(repair.bundlePath, "utf8");
  assert.ok(txt.includes(`SUPERSEDES_BUNDLE_IDENTITY: ${oldIdentity}`), "supersede identity in bundle");
  assert.ok(txt.includes(`SUPERSEDES_BUNDLE_SHA256: ${oldSha}`), "supersede sha in bundle");
  assert.ok(txt.includes("SUPERSEDES_BUNDLE_VERDICT: REPAIR"), "superseded verdict declared in bundle");
  assert.ok(txt.includes("attempt="), "repair attempt history in bundle");
  // the superseding repair generation is recorded（attempt numbering continues
  // after the in-graph retry entries: 0/1 = W1 retry, 2 = superseding repair）
  assert.ok(txt.includes("taskType=external-review-superseding-repair status=REPAIR"), "superseding repair generation in attempt history");
  assert.ok(txt.includes("REPAIR_BUDGET_USED: 2"), "in-graph retry + superseding repair generation = 2 consumed");
  // old artifact untouched
  assert.ok(existsSync(oldPath), "old bundle retained");
  assert.equal(shaFile(oldPath), oldFileSha, "old bundle bytes unchanged");
  // the NEW bundle awaits a fresh reviewer verdict（the receipt）
  assert.equal(repair.externalReview.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  assert.equal(repair.externalReview.verdict, null, "new bundle awaits re-review");
  // a verdict on the STALE old bundle is rejected against the new state
  const stale = applyExternalReviewVerdict(repair.externalReview, verdictInput(repair.externalReview, {
    bundleIdentity: oldIdentity,
    bundleSha256: oldSha,
    verdict: "PASS",
  }));
  assert.equal(stale.ok, false, "stale-bundle verdict rejected");
  assert.ok(stale.errors.some((e) => e.includes(EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE)), "STALE_BUNDLE");
});

// ── 8. external HOLD -> downstream stops ───────────────────────────────────

test("8. external HOLD -> downstream stops（no external PASS / CARD_COMPLETE）", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-8" } });
  const applied = applyExternalReviewVerdict(r.externalReview, verdictInput(r.externalReview, { verdict: "HOLD" }));
  assert.equal(applied.ok, true);
  assert.equal(applied.state.externalReviewStatus, "HOLD");
  assert.equal(externalReviewComplete(applied.state), false, "HOLD never completes");
  const guard = cardExternalReviewStatus(applied.state);
  assert.equal(guard.complete, false, "downstream must stop");
  // a bundle-gate failure also stops downstream（fail-closed）
  const failed = await run(passGraph, {
    closeout: { cardId: "RB-1G-TEST-8B" },
    gate: async () => ({ final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.INVALID, reason: "REVIEW_BUNDLE_INVALID:injected" }),
  });
  assert.equal(failed.final, "HOLD", "gate failure downgrades the card");
  assert.notEqual(failed.final, "PASS");
});

// ── 9. requiresReview=false internal nodes unaffected ──────────────────────

test("9. requiresReview=false internal nodes unaffected by the card-level rule", { timeout: 30000 }, async () => {
  const r = await runMandatoryGraphCloseout({
    graphResult: passGraph,
    closeout: { ...closeoutOpts(OUT), requiresReview: false },
    repoPath: REPO_A,
    outDir: OUT,
    timeoutMs: 8000,
  });
  assert.equal(r.applied, false, "no mandatory closeout for internal-only cards");
  assert.equal(r.externalReview, undefined, "no external review state");
  // node-level interim completion stays per-node（unchanged by the card rule）
  const nodeR = await run(passGraph, { closeout: { requiresReview: false, cardId: "RB-1G-TEST-9" } });
  assert.equal(nodeR.applied, false);
});

// ── 10. existing automatic bundle generation/validation regression ─────────

test("10. automatic bundle generation + validation regression intact", { timeout: 30000 }, async () => {
  const evPath = join(ROOT, "ev-regression.json");
  mkdirSync(ROOT, { recursive: true });
  const fs = await import("node:fs");
  fs.writeFileSync(evPath, JSON.stringify({ ok: true }));
  const source = {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: { cardId: "RB-1G-REGRESSION", cardTitle: "Regression", cardType: "implementation" },
    graph: { graphRunId: "regression-1" },
    repo: { repository: facts.repository ?? null, branch: facts.branch, head: facts.head, treeSha: facts.treeSha, worktreePath: facts.worktreePath, baselineDirtyDigest: facts.baselineDirtyDigest, finalDirtyDigest: facts.finalDirtyDigest, remote: facts.remote },
    objective: "regression: bundle generation + validation unchanged",
    executiveStatus: "PASS",
    executiveSummary: "bundle generated and validated",
    authorizedScope: ["src/governance/review-bundle.mjs"],
    unauthorizedScope: ["commit", "push"],
    designDecisions: ["25-section deterministic text bundle"],
    files: { added: ["src/governance/review-bundle.mjs"], modified: [], deleted: [] },
    diffSummary: "governance change",
    execution: { testsExecuted: ["node --test test/governance/test-external-review-delivery.mjs"], testResults: { passed: 1, failed: 0, total: 1 }, pass: true },
    verifier: { pass: true, result: "PASS", summary: "verify PASS" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "c".repeat(64), blockingFindings: [], summary: "review PASS" },
    repairAttempts: [],
    negativeCases: [],
    regression: [],
    evidence: [{ path: evPath, sha256: shaFile(evPath) }],
    security: { secretScanResult: "clean", ingestionAllowlist: ["structured"], ingestionDenylist: ["secrets"] },
    risks: [], limitations: [],
    rollbackProcedure: "regenerate",
    openQuestions: [],
    recommendedNextStep: "CBM-2",
  };
  const r = await runCloseoutGate({ source, repoPath: REPO_A, outDir: OUT2, timeoutMs: 5000, repoFacts: facts });
  assert.equal(r.final, "PASS", `gate PASS (${r.reason})`);
  assert.ok(r.bundlePath && existsSync(r.bundlePath));
  const txt = readFileSync(r.bundlePath, "utf8");
  assert.equal((txt.match(/^\d+\. [^\n]+$/gm) || []).length, 25, "25 sections");
  assert.ok(txt.includes("=== END OF REVIEW BUNDLE ==="), "terminator");
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: OUT2 });
  assert.equal(v.ok, true, `bundle validates (${v.errors.join(";")})`);
  // structured state still present on the plain gate path（fail-closed default）
  assert.equal(r.externalReview.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  assert.equal(r.externalReview.delivery.attempted, false);
});

// ── R. the repair finding: sender-side delivery attempt is NON-AUTHORITATIVE

test("R. sender-side delivery attempt is NON-AUTHORITATIVE（the repair finding）", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-R" } });
  // the execution side records that it provided the artifact...
  const attempted = recordDeliveryAttempt(r.externalReview, { method: "presented-path", attemptedAt: "2026-08-07T18:00:00.000Z" });
  assert.equal(attempted.delivery.attempted, true, "attempt recorded");
  // ...but that NEVER changes the status and NEVER contributes to completion
  assert.equal(attempted.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW", "attempt does not change status");
  assert.equal(externalReviewComplete(attempted), false, "attempt does not complete");
  assert.equal(cardExternalReviewStatus(attempted).complete, false);
  // even an attempted delivery + matching path/SHA cannot produce PASS — only
  // the reviewer's own verdict can
  const stillNoPass = applyExternalReviewVerdict(attempted, {
    verdict: "PASS",
    bundleIdentity: attempted.delivery.reviewBundleIdentity,
    bundleSha256: attempted.delivery.reviewBundleSha256,
    reviewerIdentity: "AUTOLOOP_PI_GRAPH_RB1G_EXTERNAL_REVIEW",
    reviewedAt: "2026-08-07T18:00:00.000Z",
  });
  assert.equal(stillNoPass.ok, true, "the reviewer's verdict is the receipt — it applies");
  assert.equal(stillNoPass.state.externalReviewStatus, "PASS");
  assert.equal(externalReviewComplete(stillNoPass.state), true);
  // the gate default（no deliver hook）now delivers to the FIXED surface
  //（RB-1H hard rule）— still only an attempt, never a receipt
  const fresh = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-R2" } });
  assert.equal(fresh.externalReview.delivery.attempted, true, "default surface delivery attempted");
  assert.equal(fresh.externalReview.delivery.method, "external-review-surface", "surface method recorded");
  assert.equal(fresh.externalReview.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW", "attempt never confirms receipt");
  // a `deliver` hook that reports success still only records an ATTEMPT —
  // it can never confirm receipt or change the status
  const withDeliver = await runMandatoryGraphCloseout({
    graphResult: passGraph,
    closeout: closeoutOpts(OUT, { cardId: "RB-1G-TEST-R3", deliver: async () => ({ attempted: true, method: "channel-x" }) }),
    repoPath: REPO_A,
    outDir: OUT,
    timeoutMs: 8000,
  });
  assert.equal(withDeliver.externalReview.delivery.attempted, true, "deliver hook records an attempt");
  assert.equal(withDeliver.externalReview.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW", "attempt never confirms receipt");
  assert.equal(externalReviewComplete(withDeliver.externalReview), false, "attempt never completes");
});

// ── extra: self-declared verdict rejected ──────────────────────────────────

test("11. self-declared external verdict rejected（agent cannot pass itself）", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-11" } });
  const applied = applyExternalReviewVerdict(r.externalReview, verdictInput(r.externalReview, {
    reviewerIdentity: "agent:pi",
    agentIdentity: "agent:pi",
  }));
  assert.equal(applied.ok, false);
  assert.ok(applied.errors.some((e) => e.includes(EXTERNAL_REVIEW_HOLDS.SELF_DECLARED)), "SELF_DECLARED");
  assert.equal(externalReviewComplete(r.externalReview), false);
});

// ── extra: delivery record persistence roundtrip ───────────────────────────

test("12. delivery record persistence roundtrip（record -> read -> verdict -> complete）", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-12" } });
  const attempted = recordDeliveryAttempt(r.externalReview, { method: "presented-path", attemptedAt: "2026-08-07T18:00:00.000Z" });
  const rec = writeExternalReviewDeliveryRecord({ outDir: OUT, state: attempted, cardId: "RB-1G-TEST-12" });
  assert.equal(rec.ok, true, `record written (${rec.reason})`);
  assert.ok(existsSync(rec.path), "record file exists");
  const read = readExternalReviewDeliveryRecord(rec.path);
  assert.equal(read.ok, true, `record readable (${read.errors.join(";")})`);
  assert.equal(read.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  assert.equal(read.state.delivery.attempted, true, "attempt persisted");
  assert.equal(read.state.delivery.confirmed, undefined, "no sender-authoritative confirmed flag exists");
  const applied = applyExternalReviewVerdict(read.state, verdictInput(read.state));
  assert.equal(applied.ok, true, "verdict applies to persisted state");
  assert.equal(applied.state.externalReviewStatus, "PASS");
  assert.equal(externalReviewComplete(applied.state), true, "complete after verdict");
  // tampered / malformed records fail closed
  const fs = await import("node:fs");
  const bad = join(OUT, "external-review-delivery-bad.json");
  fs.writeFileSync(bad, JSON.stringify({ schema: "autoloop.external-review-delivery/v2", externalReviewStatus: "NOPE", delivery: { reviewBundleIdentity: "x" } }));
  const readBad = readExternalReviewDeliveryRecord(bad);
  assert.equal(readBad.ok, false, "malformed record rejected");
});

// ── 13. repair-generation delivery record carries the SUPERSEDES binding ────

// A repair-generation delivery record must carry the same SUPERSEDES binding
// the bundle declares in its section 14（single source of truth = the bundle
// text; the record is derived from it）— the artifact and its delivery
// record must never diverge on the evidence chain.
test("13. repair-generation delivery record carries the SUPERSEDES binding（artifact and record never diverge）", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-13", repairBudgetMaxAttempts: 2 } });
  const oldIdentity = r.externalReview.delivery.reviewBundleIdentity;
  const oldSha = r.externalReview.delivery.reviewBundleSha256;
  const applied = applyExternalReviewVerdict(r.externalReview, verdictInput(r.externalReview, { verdict: "REPAIR" }));
  assert.equal(applied.ok, true);

  const repair = await run(repairGraph, {
    // closeout-accounting: the fixture consumes 2（in-graph W1 retry + the
    // external-review-triggered superseding repair generation）of MAX=2.
    closeout: { cardId: "RB-1G-TEST-13", cardType: "repair", repairBudgetMaxAttempts: 2, supersedes: buildSupersedeRecord(applied.state) },
  });
  assert.equal(repair.final, "PASS");
  const txt = readFileSync(repair.bundlePath, "utf8");
  assert.ok(txt.includes(`SUPERSEDES_BUNDLE_IDENTITY: ${oldIdentity}`), "bundle declares supersede");
  assert.ok(txt.includes("SUPERSEDES_BUNDLE_VERDICT: REPAIR"), "bundle declares superseded verdict");
  assert.ok(txt.includes("REPAIR_BUDGET_USED: 2"), "superseding repair generation counted against budget");

  // the --record-delivery-attempt derivation: parse the bundle's own section 14
  const parsed = supersedesFromBundleText(txt);
  assert.equal(parsed.error, null);
  assert.equal(parsed.supersedes.reviewBundleIdentity, oldIdentity, "parsed supersede identity");
  assert.equal(parsed.supersedes.reviewBundleSha256, oldSha, "parsed supersede sha256");
  const state = buildExternalReviewState({ bundle: { identity: repair.externalReview.delivery.reviewBundleIdentity, sha256: repair.externalReview.delivery.reviewBundleSha256 }, bundlePath: repair.bundlePath, supersedes: parsed.supersedes });
  const attempted = recordDeliveryAttempt(state, { method: "presented-in-conversation", attemptedAt: "2026-08-07T18:00:00.000Z" });
  const rec = writeExternalReviewDeliveryRecord({ outDir: OUT, state: attempted, cardId: "RB-1G-TEST-13" });
  assert.equal(rec.ok, true, `record written (${rec.reason})`);
  const read = readExternalReviewDeliveryRecord(rec.path);
  assert.equal(read.ok, true, `record readable (${read.errors.join(";")})`);
  assert.equal(read.state.supersedes.reviewBundleIdentity, oldIdentity, "delivery record supersedes identity");
  assert.equal(read.state.supersedes.reviewBundleSha256, oldSha, "delivery record supersedes sha256");
  // the supersede binding never changes the receipt model: still awaiting
  // a fresh reviewer verdict bound to the CURRENT bundle
  assert.equal(read.state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  assert.equal(externalReviewComplete(read.state), false);
});

// ── 14. supersedesFromBundleText: parse + fail-closed ──────────────────────

test("14. supersedesFromBundleText parses SUPERSEDES_* and fails closed on partial bindings", { timeout: 30000 }, async () => {
  // original bundle -> no supersede binding -> null
  const r = await run(passGraph, { closeout: { cardId: "RB-1G-TEST-14" } });
  const plain = supersedesFromBundleText(readFileSync(r.bundlePath, "utf8"));
  assert.equal(plain.supersedes, null);
  assert.equal(plain.error, null);
  // full binding parses
  const ident = "9".repeat(64);
  const sha = "a".repeat(64);
  const withSup = `REPAIR_BUDGET_MAX: 1\nREPAIR_BUDGET_USED: 1\nSUPERSEDES_BUNDLE_IDENTITY: ${ident}\nSUPERSEDES_BUNDLE_SHA256: ${sha}\nSUPERSEDES_BUNDLE_PATH: /tmp/prev.txt\n`;
  const ok = supersedesFromBundleText(withSup);
  assert.equal(ok.error, null);
  assert.equal(ok.supersedes.reviewBundleIdentity, ident);
  assert.equal(ok.supersedes.reviewBundleSha256, sha);
  assert.equal(ok.supersedes.bundlePath, "/tmp/prev.txt");
  // identity WITHOUT sha -> fail closed（never a partial chain binding）
  const partial = supersedesFromBundleText(`SUPERSEDES_BUNDLE_IDENTITY: ${ident}\n`);
  assert.equal(partial.supersedes, null);
  assert.equal(partial.error, "supersedes_sha256_missing");
  // a malformed persisted supersedes record is rejected on read
  const fs = await import("node:fs");
  const bad = join(OUT, "external-review-delivery-bad-sup.json");
  fs.writeFileSync(bad, JSON.stringify({
    schema: "autoloop.external-review-delivery/v2",
    externalReviewStatus: "AWAITING_EXTERNAL_REVIEW",
    delivery: { reviewBundleIdentity: "b".repeat(64), reviewBundleSha256: "c".repeat(64) },
    supersedes: { reviewBundleIdentity: "not-hex" },
  }));
  const readBad = readExternalReviewDeliveryRecord(bad);
  assert.equal(readBad.ok, false, "malformed supersedes rejected");
  assert.ok(readBad.errors.some((e) => e.includes("delivery_record_supersedes_malformed")), "supersedes_malformed");
});

// ── sanity: statuses / verdicts sets ───────────────────────────────────────

test("sanity: external review statuses and verdicts are the fixed RB-1G sets", () => {
  assert.deepEqual([...EXTERNAL_REVIEW_STATUSES], ["AWAITING_EXTERNAL_REVIEW", "AWAITING_BUNDLE_DELIVERY", "PASS", "REPAIR", "HOLD"]);
  assert.deepEqual(Array.from(new Set([...EXTERNAL_REVIEW_STATUSES])), [...EXTERNAL_REVIEW_STATUSES]);
  // buildExternalReviewState default = AWAITING_EXTERNAL_REVIEW（no receipt yet）
  const s = buildExternalReviewState({ bundle: { identity: "a".repeat(64), sha256: "b".repeat(64) }, bundlePath: "/tmp/b.txt" });
  assert.equal(s.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  assert.equal(s.reviewBundleGenerated, true);
  assert.equal(s.reviewBundleValidated, true);
  assert.equal(s.reviewBundleDeliveryRequired, true);
  assert.equal(s.delivery.required, true);
  assert.equal(s.delivery.attempted, false);
  assert.equal(s.delivery.confirmed, undefined, "no sender-authoritative confirmed flag");
});

// ═══════════════════════════════════════════════════════════════════════════
// R-13 residual repair — verdict-time artifact verification (single fresh
// read), structural validation, SHA/identity/card binding, caller-authority
// removal, conflict fence, tamper matrix, reverse controls.
// ═══════════════════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyExternalReviewVerdictForDelivery,
  verifyDeliveredArtifactForVerdict,
} from "../../src/governance/review-bundle.mjs";

const R13 = join(ROOT, "r13");
const CLI = join(REPO_A, "scripts/gov-closeout-bundle.mjs");

// Render a REAL canonical bundle through renderReviewBundle so the artifact
// passes validateReviewBundle (schema/sections/terminator/sha/footer).
const r13Source = (cardId) => ({
  schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
  task: { cardId, cardTitle: `${cardId} closeout`, cardType: "implementation" },
  graph: { graphRunId: `r13-run-${cardId}` },
  repo: { repository: facts.repository ?? null, branch: facts.branch, head: facts.head, treeSha: facts.treeSha },
  objective: `${cardId}: R-13 verdict artifact binding`,
  executiveStatus: "PASS",
  executiveSummary: "bundle generated and validated for R-13",
  authorizedScope: ["src/governance/review-bundle.mjs"],
  unauthorizedScope: [],
  objective_extra: undefined,
  files: { added: [], modified: [], deleted: [] },
  execution: { testsExecuted: ["r13-targeted"], testResults: { passed: 1, failed: 0, total: 1 }, pass: true },
  verifier: { pass: true, result: "PASS", summary: "verify PASS" },
  review: { pass: true, result: "PASS", reviewResultIdentity: "e".repeat(64), blockingFindings: [], summary: "review PASS" },
  negativeCases: ["forged artifact rejected at verdict time"],
  regression: [{ suite: "governance", tests: 1, pass: 1, fail: 0 }],
  evidence: [],
  security: { secretScanResult: "clean", ingestionAllowlist: [], ingestionDenylist: [] },
  risks: [], limitations: [],
  rollbackProcedure: "n/a",
  openQuestions: [],
  recommendedNextStep: "external review",
});

const r13Setup = (name, { cardId = `R13-${name}`, tamper = null, record = {} } = {}) => {
  const dir = join(R13, name);
  mkdirSync(dir, { recursive: true });
  const b = renderReviewBundle(r13Source(cardId), { generatedAt: "2026-09-19T00:00:00.000Z" });
  // The delivery record binds the GENUINE bundle (identity + content sha as
  // delivered). Tampering is applied to the ARTIFACT ONLY, after the record
  // is fixed — that is the real-world attack shape.
  const marker0 = "REVIEW_BUNDLE_SHA256:";
  const genuineContent = b.text.slice(0, b.text.lastIndexOf(marker0));
  const genuineSha = createHash("sha256").update(genuineContent).digest("hex");
  let text = b.text;
  if (tamper === "byte") {
    text = text.replace("bundle generated and validated for R-13", "bundle generated and validated for R-13 TAMPERED");
  } else if (tamper === "truncate") {
    text = text.slice(0, Math.floor(text.length * 0.8));
  } else if (tamper === "identity") {
    text = text.replace(/^REVIEW_BUNDLE_IDENTITY: [0-9a-f]{64}$/m, `REVIEW_BUNDLE_IDENTITY: ${"9".repeat(64)}`);
  } else if (tamper === "card") {
    text = text.replace(/^CARD_ID: .*$/m, "CARD_ID: R13-OTHER-CARD");
  } else if (tamper === "forged-consistent") {
    // self-consistent forgery: keep structure, recompute the footer sha for
    // changed content — the OLD attack that previously minted a PASS.
    text = text.replace("bundle generated and validated for R-13", "FORGED CONTENT");
    const marker = "REVIEW_BUNDLE_SHA256:";
    const body = text.slice(0, text.lastIndexOf(marker));
    const forged = createHash("sha256").update(body).digest("hex");
    text = body + `${marker} ${forged}\n`;
  }
  writeFileSync(join(dir, "review-bundle.txt"), text, "utf8");
  const artifactText = readFileSync(join(dir, "review-bundle.txt"), "utf8");
  // content sha over the same bytes the verifier will derive
  const marker = "REVIEW_BUNDLE_SHA256:";
  const shaIdx = artifactText.lastIndexOf(marker);
  const content = artifactText.slice(0, shaIdx);
  const contentSha = createHash("sha256").update(content).digest("hex");
  const statedSha = artifactText.slice(shaIdx).match(/REVIEW_BUNDLE_SHA256:\s*([0-9a-f]{64})/)?.[1] ?? null;
  const rec = {
    schema: "autoloop.external-review-delivery/v2",
    cardId: record.cardId ?? cardId,
    fileName: "delivery.json",
    reviewBundleGenerated: true,
    reviewBundleValidated: true,
    externalReviewStatus: record.finalized ? record.finalized : "AWAITING_EXTERNAL_REVIEW",
    externalReviewStatusReason: null,
    delivery: {
      required: true, attempted: true, method: "test", attemptedAt: "2026-09-19T00:00:00.000Z",
      bundlePath: join(dir, "review-bundle.txt"),
      reviewBundleIdentity: record.identity ?? b.identity,
      reviewBundleSha256: record.sha ?? genuineSha,
    },
    verdict: record.finalized
      ? { verdict: record.finalized, reviewerIdentity: "FIRST-REVIEWER", reviewedAt: "2026-09-19T00:00:00.000Z",
          bundleIdentity: record.identity ?? b.identity, bundleSha256: record.sha ?? genuineSha }
      : null,
  };
  writeFileSync(join(dir, "delivery.json"), JSON.stringify(rec, null, 2) + "\n", "utf8");
  return { dir, identity: b.identity, contentSha, statedSha, cardId };
};

const r13Apply = (name, { verdict = "PASS", reviewer = "R13-EXTERNAL-REVIEWER", expectedCardId } = {}) =>
  applyExternalReviewVerdictForDelivery({
    deliveryPath: join(R13, name, "delivery.json"),
    verdict, reviewerIdentity: reviewer, reviewedAt: "2026-09-19T01:00:00.000Z",
    ...(expectedCardId ? { expectedCardId } : {}),
  });

const r13RecordStatus = (name) =>
  readExternalReviewDeliveryRecord(join(R13, name, "delivery.json")).state?.externalReviewStatus ?? null;

test("R13-RC-A. valid delivery + untouched valid artifact + legitimate verdict → applies", () => {
  const s = r13Setup("rc-a");
  const r = r13Apply("rc-a", { expectedCardId: s.cardId });
  assert.equal(r.ok, true, r.errors?.join(";"));
  assert.equal(r.state.externalReviewStatus, "PASS");
  assert.equal(r.state.verdict.bundleIdentity, s.identity);
  assert.equal(r.state.verdict.bundleSha256, s.contentSha);
  assert.equal(externalReviewComplete(r.state), true);
});

test("R13-RC-B. tampered artifact → rejected, record unchanged", () => {
  r13Setup("rc-b", { tamper: "byte" });
  const r = r13Apply("rc-b");
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, "EXTERNAL_REVIEW_STALE_BUNDLE");
  assert.equal(r13RecordStatus("rc-b"), "AWAITING_EXTERNAL_REVIEW");
});

test("R13-RC-C. forged delivery identity/SHA + mismatching artifact → rejected", () => {
  r13Setup("rc-c", { record: { identity: "f".repeat(64), sha: "f".repeat(64) } });
  const r = r13Apply("rc-c");
  assert.equal(r.ok, false);
  assert.equal(r13RecordStatus("rc-c"), "AWAITING_EXTERNAL_REVIEW");
});

test("R13-RC-D. valid artifact + wrong-card delivery → rejected (card binding)", () => {
  // The ARTIFACT is valid for card R13-RC-D; the DELIVERY record claims a
  // different card — the artifact→delivery direction must fail closed.
  r13Setup("rc-d", { cardId: "R13-RC-D", record: { cardId: "R13-OTHER-CARD" } });
  const r = r13Apply("rc-d");
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, "EXTERNAL_REVIEW_CARD_MISMATCH");
});

test("R13-RC-E. caller-supplied identity/SHA have zero authority", () => {
  const s = r13Setup("rc-e", { tamper: "forged-consistent" });
  // even if a caller echoes the forged record values, the fresh artifact
  // truth governs; the forged-consistent artifact also fails validation.
  const r = applyExternalReviewVerdictForDelivery({
    deliveryPath: join(R13, "rc-e", "delivery.json"),
    verdict: "PASS", reviewerIdentity: "R13-EXTERNAL-REVIEWER",
    bundleIdentity: s.identity, bundleSha256: s.contentSha,
  });
  assert.equal(r.ok, false, "caller echo must not mint authority");
  // and a direct low-level call with a bogus artifact path fails closed
  const v = verifyDeliveredArtifactForVerdict({ deliveryPath: join(R13, "rc-e", "delivery.json") });
  assert.equal(v.ok, false);
});

test("R13-TAMPER-13. self-consistent forged artifact + matching forged record → rejected", () => {
  r13Setup("t13", { tamper: "forged-consistent" });
  const r = r13Apply("t13");
  assert.equal(r.ok, false);
  assert.match(String(r.errors?.join(";")), /EXTERNAL_REVIEW_ARTIFACT_INVALID|EXTERNAL_REVIEW_STALE_BUNDLE/);
});

test("R13-TAMPER-14. structurally invalid artifact with internally matching sha/identity → rejected", () => {
  r13Setup("t14", { tamper: "truncate" });
  const r = r13Apply("t14");
  assert.equal(r.ok, false);
  assert.equal(r13RecordStatus("t14"), "AWAITING_EXTERNAL_REVIEW");
});

test("R13-TAMPER-15. conflicting verdict against finalized receipt → rejected; same verdict idempotent", () => {
  r13Setup("t15", { record: { finalized: "PASS" } });
  const conflict = r13Apply("t15", { verdict: "HOLD" });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.holdCode, "EXTERNAL_REVIEW_VERDICT_CONFLICT");
  // same verdict + same reviewer stays idempotent
  const again = applyExternalReviewVerdictForDelivery({
    deliveryPath: join(R13, "t15", "delivery.json"),
    verdict: "PASS", reviewerIdentity: "FIRST-REVIEWER", reviewedAt: "2026-09-19T02:00:00.000Z",
  });
  assert.equal(again.ok, true, again.errors?.join(";"));
  assert.equal(again.idempotent, true);
});

test("R13-TAMPER-6/7. artifact identity changed / wrong-card artifact → rejected", () => {
  // identity line swapped → footer sha no longer matches content → the
  // validator's sha recompute and the record comparison both fail closed.
  r13Setup("t6", { tamper: "identity" });
  const r6 = r13Apply("t6");
  assert.equal(r6.ok, false);
  assert.match(String(r6.errors?.join(";")), /EXTERNAL_REVIEW_STALE_BUNDLE|EXTERNAL_REVIEW_ARTIFACT_INVALID/);
  // wrong-card artifact: record still binds THIS card, artifact says another
  // card. The card line is inside the sha-covered content, so a plain swap
  // trips the sha fence; a RE-WRITTEN card line with a recomputed footer
  // (fully self-consistent wrong-card artifact) trips the CARD binding.
  r13Setup("t7", { cardId: "R13-T7", tamper: "card" });
  const r7 = r13Apply("t7");
  assert.equal(r7.ok, false);
  assert.match(String(r7.errors?.join(";")), /EXTERNAL_REVIEW_CARD_MISMATCH|EXTERNAL_REVIEW_STALE_BUNDLE|EXTERNAL_REVIEW_ARTIFACT_INVALID/);
});

test("R13-TAMPER-9/12. missing artifact and stale rotated surface → rejected", () => {
  const s = r13Setup("t9");
  rmSync(join(s.dir, "review-bundle.txt"));
  const r = r13Apply("t9");
  assert.equal(r.ok, false);
  assert.match(String(r.errors?.join(";")), /surface_bundle_missing/);
  // wrong-card trio: valid artifact from another card paired with this record
  const other = r13Setup("t9-other", { cardId: "R13-T9-OTHER" });
  const v = verifyDeliveredArtifactForVerdict({
    deliveryPath: join(R13, "t9-other", "delivery.json"),
    expectedCardId: "R13-SOME-OTHER-CARD",
  });
  assert.equal(v.ok, false);
  assert.equal(v.holdCode, "EXTERNAL_REVIEW_CARD_MISMATCH");
});

test("R13-CLI. real CLI E2E: deliver→verdict→idempotent→conflict→tamper→record unchanged", () => {
  const s = r13Setup("cli");
  const run = (args) => spawnSync(process.execPath, [CLI, "--apply-verdict", join(s.dir, "delivery.json"), ...args], { cwd: REPO_A, encoding: "utf8" });
  // 1. legitimate PASS applies
  let r = run(["--verdict", "PASS", "--reviewer", "R13-CLI-REVIEWER", "--reviewed-at", "2026-09-19T03:00:00.000Z"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.includes("externalReviewComplete: true"));
  // 2. identical verdict → idempotent success
  r = run(["--verdict", "PASS", "--reviewer", "R13-CLI-REVIEWER", "--reviewed-at", "2026-09-19T03:05:00.000Z"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.includes("idempotent"), r.stdout);
  // 3. conflicting verdict → rejected
  r = run(["--verdict", "REPAIR", "--reviewer", "R13-CLI-REVIEWER"]);
  assert.notEqual(r.status, 0);
  assert.ok(`${r.stderr}${r.stdout}`.includes("verdict_conflict"), `${r.stderr}${r.stdout}`);
  // 4. tamper the artifact → rejected
  const bundle = join(s.dir, "review-bundle.txt");
  const saved = readFileSync(bundle, "utf8");
  writeFileSync(bundle, saved.replace("bundle generated and validated for R-13", "TAMPERED AFTER VERDICT"), "utf8");
  const recBefore = readFileSync(join(s.dir, "delivery.json"), "utf8");
  r = run(["--verdict", "HOLD", "--reviewer", "R13-CLI-REVIEWER"]);
  assert.notEqual(r.status, 0);
  // 5. record byte-identical after the failed attempt
  assert.equal(readFileSync(join(s.dir, "delivery.json"), "utf8"), recBefore);
  // restore for after()
  writeFileSync(bundle, saved, "utf8");
});
