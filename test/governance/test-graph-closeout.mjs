// test/governance/test-graph-closeout.mjs
//
// RB-1R — Mandatory Graph closeout integration tests.
//
// These tests exercise the PRODUCTION mandatory closeout path
// (runMandatoryGraphCloseout in src/governance/review-bundle.mjs — the same
// function the generic Graph runner runColimaGraph calls at card closeout)
// with realistic structured Graph results, plus the real end-to-end wiring
// in test/test-graph-closeout-integration.mjs (real runColimaGraph runs).
//
// Coverage:
//   - no CLI needed: runMandatoryGraphCloseout auto-generates + validates the
//     bundle before PASS
//   - PASS is declared only AFTER bundle validation
//   - generator crash -> HOLD
//   - gate timeout -> HOLD
//   - validator rejection -> HOLD
//   - secret injection -> HOLD REVIEW_BUNDLE_SECRET_DETECTED（bundle never
//     written）
//   - blocking final review -> no PASS
//   - research card with zero production diff -> complete bundle
//   - repair card -> attempt history + repair budget in the bundle
//   - one closeout -> exactly one verdict
//   - temp files cleaned
//   - closeout failure never yields PASS
//
// Run: node --test test/governance/test-graph-closeout.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import {
  REVIEW_BUNDLE_SOURCE_SCHEMA,
  REVIEW_BUNDLE_SECTIONS,
  REVIEW_BUNDLE_HOLDS,
  runMandatoryGraphCloseout,
  runStateDrivenCloseout,
  buildGraphCloseoutSource,
  validateReviewBundle,
  sha256Hex,
} from "../../src/governance/review-bundle.mjs";
import {
  CLOSEOUT_STATE_SCHEMA,
  GRAPH_EVIDENCE_SCHEMA,
  GRAPH_EVIDENCE_HOLDS,
  assertGraphAggregateConsistency,
  closeoutStatePath,
  loadGraphResultFromEvidence,
  validateGraphEvidence,
  writeCloseoutState,
} from "../../src/governance/closeout-state.mjs";

const REPO_A = "/Volumes/NVM2T/Development/repos/autoloop";
const ROOT = `${tmpdir()}/rb1r-graph-closeout-${process.pid}`;
const OUT = join(ROOT, "out");
const OUT2 = join(ROOT, "out-secret");

const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(OUT2, { recursive: true });
  // RB-1H hard rule: requiresReview closeouts default-deliver to the fixed
  // surface — redirect it away from the real Desktop inbox during tests.
  process.env.AUTOLOOP_REVIEW_SURFACE = join(ROOT, "surface");
  process.env.AUTOLOOP_REVIEW_ARCHIVE = join(ROOT, "archive");
});
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
});

// ── realistic structured Graph result fixtures（shapes match what
// runColimaGraph returns; no stdout parsing anywhere）───────────────────────

const passGraph = {
  executionId: "fixture-graph-pass-1",
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
      phaseExecutionId: "exec_fixture_r1",
      taskType: "count_todos",
      dependencies: [],
      final: "PASS",
      attempt: 0,
      reason: null,
      startedAt: 1,
      completedAt: 2,
      cleanup: { worktreeRevoked: false },
      subagentResult: { status: "PASS", testResults: null, testsExecuted: [] },
      subagentEnvelope: { agentExecutionId: "agent_fixture_r1" },
    },
    {
      nodeId: "W1",
      phaseExecutionId: "exec_fixture_w1",
      taskType: "write_report",
      dependencies: ["R1"],
      final: "PASS",
      attempt: 0,
      reason: null,
      startedAt: 3,
      completedAt: 4,
      worktreeIdentity: {
        verified: true,
        output: { files: [{ status: " M", path: "docs/pi-graph-output/summary.md", source: null, destination: null, rename: false }] },
      },
      cleanup: { worktreeRevoked: true },
      subagentResult: { status: "PASS", testResults: { passed: 2, failed: 0, total: 2 }, testsExecuted: ["self-test grep markdown claim"] },
      subagentEnvelope: { agentExecutionId: "agent_fixture_w1" },
      reviewResult: {
        schema_version: "autoloop.subagent.review-result/v1",
        status: "PASS",
        agentExecutionId: "agent_fixture_w1_reviewer",
        inputContextIdentity: "ctx",
        outputSchemaIdentity: "autoloop.subagent.review-result/v1",
        findings: [],
        blockingFindings: [],
        nonBlockingFindings: [],
        evidenceChecked: [],
        scopeVerified: true,
        testsVerified: true,
        claims: ["review PASS"],
        evidenceReferences: [],
        filesInspected: [],
        commandsExecuted: [],
        assumptions: [],
        uncertainties: [],
        recommendedAction: "PASS",
        recommendedNextAction: "review",
        summary: "independent review PASS",
      },
    },
    {
      nodeId: "V1",
      phaseExecutionId: "exec_fixture_v1",
      taskType: "verify_writer",
      dependencies: ["W1"],
      final: "PASS",
      attempt: 0,
      reason: null,
      startedAt: 5,
      completedAt: 6,
      cleanup: { worktreeRevoked: false },
      subagentResult: { status: "PASS", testResults: { passed: 1, failed: 0, total: 1 }, testsExecuted: [] },
      subagentEnvelope: { agentExecutionId: "agent_fixture_v1" },
    },
  ],
  transitions: [
    {
      phaseId: "R1", final: "PASS", attempt: 0, reason: null,
      lifecycleTransitions: [
        { phase: "executor", attempt: 0, status: "completed" },
        { phase: "reviewer", attempt: 0, status: "completed" },
        { phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" },
      ],
    },
    {
      phaseId: "W1", final: "PASS", attempt: 0, reason: null,
      lifecycleTransitions: [
        { phase: "executor", attempt: 0, status: "completed" },
        { phase: "reviewer", attempt: 0, status: "completed" },
        { phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" },
      ],
    },
    {
      phaseId: "V1", final: "PASS", attempt: 0, reason: null,
      lifecycleTransitions: [
        { phase: "executor", attempt: 0, status: "completed" },
        { phase: "reviewer", attempt: 0, status: "completed" },
        { phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" },
      ],
    },
  ],
};

const repairGraph = {
  ...passGraph,
  executionId: "fixture-graph-repair-1",
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
          { phase: "executor", attempt: 0, status: "completed" },
          { phase: "reviewer", attempt: 0, status: "completed" },
          { phase: "reviewer_verdict", attempt: 0, verdict: "NEEDS_SUPPLEMENT", recommended_next_action: "REPAIR" },
          { phase: "executor", attempt: 1, status: "completed" },
          { phase: "reviewer", attempt: 1, status: "completed" },
          { phase: "reviewer_verdict", attempt: 1, verdict: "PASS", recommended_next_action: "STOP" },
        ],
      }
    : tx)),
};

const researchGraph = {
  ...passGraph,
  executionId: "fixture-graph-research-1",
  // R-12: scheduler.order is the runner's STARTED-phase sequence and every
  // started phase has a node result（join completeness）— the research IR
  // never contains W1, so the order drops it too（canonical runner shape;
  // the closeout validator binds order ⇔ nodeResults）.
  scheduler: {
    ...passGraph.scheduler,
    order: ["R1", "V1"],
    statuses: { R1: "passed", V1: "passed" },
  },
  nodeResults: passGraph.nodeResults.filter((n) => n.nodeId !== "W1").map((n) => ({ ...n, worktreeIdentity: null, reviewResult: undefined })),
  transitions: passGraph.transitions.filter((tx) => tx.phaseId !== "W1"),
};

const closeoutOpts = (outDir, overrides = {}) => ({
  requiresReview: true,
  cardId: "RB-1R-TEST",
  cardTitle: "Mandatory Closeout Test",
  cardType: "repair",
  objective: "verify the mandatory graph closeout gate",
  authorizedScope: ["src/governance/review-bundle.mjs", "src/runtime/colima-graph-runner.mjs"],
  unauthorizedScope: ["commit", "push", "merge", "seal"],
  designDecisions: ["mandatory closeout hook in the generic graph runner"],
  negativeCases: ["crash/timeout/validator-rejection/secret/blocking all HOLD"],
  regression: [{ suite: "test:governance", tests: 1, pass: 1, fail: 0 }],
  regressionSummary: "focused tests pass",
  recommendedNextStep: "CBM-2",
  repairBudgetMaxAttempts: 1,
  ...overrides,
});

let _surfaceSeq = 0;
const run = (graph, opts = {}) => runMandatoryGraphCloseout({
  graphResult: graph,
  closeout: closeoutOpts(OUT, {
    ...(opts.closeout ?? {}),
    // RB-1H: an un-rotated published trio is never overwritten — each
    // closeout run gets its own isolated surface（AUTOLOOP_REPORT_LIFECYCLE_
    // REPAIR_1 FM-2: a blocked delivery now yields a non-PASS final）.
    surfaceDir: join(ROOT, "surface", `run-${_surfaceSeq++}`),
  }),
  repoPath: REPO_A,
  outDir: OUT,
  timeoutMs: opts.timeoutMs ?? 8000,
  gate: opts.gate,
  sourceBuilder: opts.sourceBuilder,
  evidenceWriter: opts.evidenceWriter,
});

function assertBundle(r, { cardType } = {}) {
  assert.equal(r.applied, true);
  assert.equal(r.final, "PASS", `final PASS (${r.reason})`);
  assert.equal(r.holdCode, null);
  assert.ok(r.bundlePath && existsSync(r.bundlePath), "bundle file written");
  const txt = readFileSync(r.bundlePath, "utf8");
  assert.equal((txt.match(/^\d+\. [^\n]+$/gm) || []).length, 25, "25 sections");
  assert.ok(txt.includes("=== END OF REVIEW BUNDLE ==="), "terminator");
  if (cardType) assert.ok(txt.includes(`CARD_TYPE: ${cardType}`), `card type ${cardType}`);
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: OUT });
  assert.equal(v.ok, true, `bundle validates (${v.errors.join(";")})`);
  return txt;
}

test("1. graph closeout auto-generates a validated bundle WITHOUT any CLI invocation (PASS only after validation)", { timeout: 30000 }, async () => {
  const r = await run(passGraph);
  const txt = assertBundle(r, { cardType: "repair" });
  assert.ok(txt.includes(`GRAPH_RUN_ID: fixture-graph-pass-1`), "graph run id bound");
  assert.ok(txt.includes(`HEAD: `), "git-derived head present");
  assert.ok(txt.includes("REVIEW_PASS: true"), "independent review PASS recorded");
  assert.ok(r.bundle.identity && /^[0-9a-f]{64}$/.test(r.bundle.identity), "identity hex");
  // PASS was declared by the gate only after the bundle validated: the
  // validator re-scanned + recomputed identity/sha/evidence at gate time.
  const evPath = join(OUT, readdirSync(OUT).find((f) => f.endsWith("-graph-closeout-evidence.json")));
  const ev = JSON.parse(readFileSync(evPath, "utf8"));
  assert.equal(ev.schema, "autoloop.review-bundle.graph-closeout-evidence/v1");
});

test("2. research card with ZERO production diff still auto-generates a complete bundle", { timeout: 30000 }, async () => {
  const r = await run(researchGraph, { closeout: { cardType: "research", diffSummary: "NO_PRODUCTION_DIFF (research card)" } });
  const txt = assertBundle(r, { cardType: "research" });
  assert.ok(txt.includes("NO_PRODUCTION_DIFF"), "research diff summary");
  assert.ok(txt.includes("ADDED:\n  (none)"), "no added files");
  assert.ok(txt.includes("MODIFIED:\n  (none)"), "no modified files");
  assert.ok(txt.includes("REVIEW_PASS: true"), "per-node reviewer verdicts recorded as review PASS");
});

test("3. repair card bundle carries attempt history + repair budget", { timeout: 30000 }, async () => {
  const r = await run(repairGraph, { closeout: { cardType: "repair", repairBudgetMaxAttempts: 1 } });
  const txt = assertBundle(r, { cardType: "repair" });
  assert.ok(txt.includes("attempt=0 taskType=write_report (repair) status=REPAIR"), "attempt 0 repair history");
  assert.ok(txt.includes("attempt=1 taskType=write_report (repair) status=PASS"), "attempt 1 pass history");
  assert.ok(txt.includes("REPAIR_BUDGET_MAX: 1"), "repair budget max bound");
  // USED counts repair iterations CONSUMED（REPAIR-status attempts only）—
  // the final PASS attempt is not a repair; USED <= MAX must always hold and
  // the bundle must validate under that invariant.
  assert.ok(txt.includes("REPAIR_BUDGET_USED: 1"), "repair budget used = repairs consumed");
  assert.equal(validateReviewBundle(r.bundlePath, { authorizedDir: OUT }).ok, true, "bundle validates under USED<=MAX");
});

test("3b. validator rejects a bundle whose REPAIR_BUDGET_USED exceeds REPAIR_BUDGET_MAX", { timeout: 30000 }, async () => {
  const r = await run(repairGraph, { closeout: { cardType: "repair", repairBudgetMaxAttempts: 1 } });
  const txt = readFileSync(r.bundlePath, "utf8");
  // tamper the rendered budget to an over-budget claim（used=2 > max=1）
  const tampered = txt.replace("REPAIR_BUDGET_USED: 1\n", "REPAIR_BUDGET_USED: 2\n");
  const tmpPath = join(OUT, `over-budget-${Date.now()}.txt`);
  writeFileSync(tmpPath, tampered, "utf8");
  const v = validateReviewBundle(tmpPath, { authorizedDir: OUT });
  assert.equal(v.ok, false, "over-budget bundle must not validate");
  assert.ok(v.errors.some((e) => e.includes("repair_budget_used_exceeds_max")), `over-budget error present (${v.errors.join(";")})`);
  rmSync(tmpPath, { force: true });
});

test("3c. validator rejects REPAIR_BUDGET_USED=0 next to SUPERSEDES_BUNDLE_VERDICT: REPAIR（superseding repair generation must consume budget）", { timeout: 30000 }, async () => {
  // a generation superseding an externally-REPAIR'd bundle IS the bounded
  // repair — the generator counts it（USED=1）and the bundle validates;
  const repair = await run(passGraph, {
    closeout: {
      cardType: "repair",
      supersedes: { reviewBundleIdentity: "a".repeat(64), reviewBundleSha256: "b".repeat(64), bundlePath: "/tmp/prev.txt", verdict: "REPAIR" },
    },
  });
  assert.equal(repair.final, "PASS");
  const txt = readFileSync(repair.bundlePath, "utf8");
  assert.ok(txt.includes("SUPERSEDES_BUNDLE_VERDICT: REPAIR"), "superseded verdict declared");
  assert.ok(txt.includes("REPAIR_BUDGET_USED: 1"), "superseding repair generation consumes 1");
  assert.equal(validateReviewBundle(repair.bundlePath, { authorizedDir: OUT }).ok, true, "bundle validates under the accounting invariant");
  // …but a bundle claiming USED=0 while superseding a REPAIR-verdict bundle
  // is contradictory（the control plane could still allow another repair
  // round）and must be rejected（fail-closed）.
  const tampered = txt.replace("REPAIR_BUDGET_USED: 1\n", "REPAIR_BUDGET_USED: 0\n");
  const tmpPath = join(OUT, `unconsumed-repair-${Date.now()}.txt`);
  writeFileSync(tmpPath, tampered, "utf8");
  const v = validateReviewBundle(tmpPath, { authorizedDir: OUT });
  assert.equal(v.ok, false, "USED=0 with a REPAIR supersede must not validate");
  assert.ok(v.errors.some((e) => e.includes("repair_budget_unconsumed_despite_superseding_repair")), `invariant error present (${v.errors.join(";")})`);
  rmSync(tmpPath, { force: true });
});

test("3d. surface-reseal lineage contract: GENERATION_TYPE machine classification + cumulative budget + governance-scope touch set", { timeout: 30000 }, async () => {
  // gen A — the bounded repair-iteration（supersedes a REPAIR-verified bundle）-> USED=1
  const a = await run(passGraph, {
    closeout: { cardType: "repair", repairBudgetMaxAttempts: 1, supersedes: { reviewBundleIdentity: "c".repeat(64), reviewBundleSha256: "d".repeat(64), bundlePath: "/tmp/prev-impl.txt", verdict: "REPAIR" } },
  });
  assert.equal(a.final, "PASS");
  const aTxt = readFileSync(a.bundlePath, "utf8");
  assert.ok(aTxt.includes("GENERATION_TYPE: repair-iteration"), "gen A machine-classified as repair-iteration");
  assert.ok(aTxt.includes("REPAIR_LINEAGE_REPAIR_ITERATIONS: 1"), "gen A consumed the single repair iteration");
  assert.ok(aTxt.includes("REPAIR_BUDGET_USED: 1"), "gen A USED=1/MAX=1");
  // gen B — surface-reseal superseding A（its real artifact is readable）: the
  // budget stays consumed 1（reseal adds +0 cumulatively）and the reseal
  // declares its touch set（governance scope only）.
  const b = await run(passGraph, {
    closeout: {
      cardType: "repair",
      repairBudgetMaxAttempts: 1,
      generationType: "surface-reseal",
      resealTouchedPaths: ["src/governance/review-bundle.mjs", "test/governance/test-graph-closeout.mjs"],
      supersedes: {
        reviewBundleIdentity: a.externalReview.delivery.reviewBundleIdentity,
        reviewBundleSha256: a.externalReview.delivery.reviewBundleSha256,
        bundlePath: a.bundlePath,
        verdict: "REPAIR",
      },
    },
  });
  assert.equal(b.final, "PASS", `reseal passes (${b.reason})`);
  const bTxt = readFileSync(b.bundlePath, "utf8");
  assert.ok(bTxt.includes("GENERATION_TYPE: surface-reseal"), "gen B machine-classified as surface-reseal");
  assert.ok(bTxt.includes("REPAIR_LINEAGE_REPAIR_ITERATIONS: 1"), "cumulative lineage stays 1（reseal adds +0）");
  assert.ok(bTxt.includes("REPAIR_LINEAGE_SURFACE_RESEALS: 1"), "one surface reseal in the lineage");
  assert.ok(bTxt.includes("REPAIR_BUDGET_USED: 1"), "USED stays 1/1");
  assert.ok(bTxt.includes("taskType=surface-reseal status=RESEAL"), "reseal recorded as RESEAL, never as a repair attempt");
  assert.ok(bTxt.includes("RESEAL_TOUCHED_PATHS:"), "reseal touch set rendered");
  assert.ok(bTxt.includes("src/governance/review-bundle.mjs"), "declared governance touch in the set");
  assert.equal(validateReviewBundle(b.bundlePath, { authorizedDir: OUT }).ok, true, "reseal validates under the lineage contract");
  // a reseal relabeled as a repair-iteration must not reset / skip the lineage
  const relabeled = bTxt.replace("GENERATION_TYPE: surface-reseal\n", "GENERATION_TYPE: repair-iteration\n");
  const rp = join(OUT, `relabel-${Date.now()}.txt`);
  writeFileSync(rp, relabeled, "utf8");
  const vr = validateReviewBundle(rp, { authorizedDir: OUT });
  assert.equal(vr.ok, false, "reseal relabeled as repair must not validate");
  assert.ok(vr.errors.some((e) => e.includes("repair_lineage_iterations_inconsistent")), `lineage inconsistency flagged (${vr.errors.join(";")})`);
  rmSync(rp, { force: true });
  // a reseal claiming a substantive implementation touch must be rejected
  const substantive = bTxt.replace("RESEAL_TOUCHED_PATHS:\n    - src/governance/review-bundle.mjs\n", "RESEAL_TOUCHED_PATHS:\n    - src/admission/admission-gate.mjs\n");
  const sp = join(OUT, `substantive-${Date.now()}.txt`);
  writeFileSync(sp, substantive, "utf8");
  const vs = validateReviewBundle(sp, { authorizedDir: OUT });
  assert.equal(vs.ok, false, "reseal touching substantive implementation must not validate");
  assert.ok(vs.errors.some((e) => e.includes("reseal_touches_substantive_implementation")), `substantive touch flagged (${vs.errors.join(";")})`);
  rmSync(sp, { force: true });
});

test("3e. cumulative lineage: a SECOND repair-iteration after the budget is consumed is over budget（HOLD, never USED=1/MAX=1 again）", { timeout: 30000 }, async () => {
  const a = await run(passGraph, {
    closeout: { cardType: "repair", repairBudgetMaxAttempts: 1, supersedes: { reviewBundleIdentity: "e".repeat(64), reviewBundleSha256: "f".repeat(64), bundlePath: "/tmp/prev-impl2.txt", verdict: "REPAIR" } },
  });
  assert.equal(a.final, "PASS");
  assert.ok(readFileSync(a.bundlePath, "utf8").includes("REPAIR_BUDGET_USED: 1"), "first repair consumes the budget");
  // a second repair generation superseding A pushes the cumulative count to
  // 2 > MAX=1 — the gate must hold it（the reviewer's lineage finding）.
  const second = await run(passGraph, {
    closeout: {
      cardType: "repair",
      repairBudgetMaxAttempts: 1,
      supersedes: {
        reviewBundleIdentity: a.externalReview.delivery.reviewBundleIdentity,
        reviewBundleSha256: a.externalReview.delivery.reviewBundleSha256,
        bundlePath: a.bundlePath,
        verdict: "REPAIR",
      },
    },
  });
  assert.equal(second.final, "HOLD", "second repair-iteration over the consumed budget must HOLD");
  assert.ok(/repair_lineage_cumulative_exceeds_max|repair_budget_used_exceeds_max/.test(String(second.reason ?? "")), `over-budget hold reason (${second.reason})`);
});

// ── 3f/3g — Repair-budget authority immutability（HOLD AUTH1_..._DRIFT）──

test("3f. successor generation CANNOT expand REPAIR_BUDGET_MAX（validator rejects MAX > predecessor MAX）", { timeout: 30000 }, async () => {
  // predecessor: MAX=1 repair-iteration（real artifact, readable）
  const a = await run(passGraph, {
    closeout: { cardType: "repair", repairBudgetMaxAttempts: 1, supersedes: { reviewBundleIdentity: "ab".repeat(32), reviewBundleSha256: "cd".repeat(32), bundlePath: "/tmp/prev-impl3.txt", verdict: "REPAIR" } },
  });
  assert.equal(a.final, "PASS");
  const aTxt = readFileSync(a.bundlePath, "utf8");
  assert.ok(aTxt.includes("REPAIR_BUDGET_MAX: 1"), "predecessor MAX=1");

  // Build a SUCCESSOR bundle that supersedes the REAL predecessor artifact
  //（a.bundlePath — readable, so the lineage validator's max-immutability
  // check runs）and declares MAX=2（the AUTH1 MAX 1→2→3 pattern）. The
  // footer sha is recomputed for the tampered content so the check under
  // test is the lineage one, not the sha integrity one.
  const tampered = aTxt
    .replace("REPAIR_BUDGET_MAX: 1\n", "REPAIR_BUDGET_MAX: 2\n")
    .replace("SUPERSEDES_BUNDLE_IDENTITY: " + "ab".repeat(32), "SUPERSEDES_BUNDLE_IDENTITY: " + a.externalReview.delivery.reviewBundleIdentity)
    .replace("SUPERSEDES_BUNDLE_SHA256: " + "cd".repeat(32), "SUPERSEDES_BUNDLE_SHA256: " + a.externalReview.delivery.reviewBundleSha256)
    .replace("SUPERSEDES_BUNDLE_PATH: /tmp/prev-impl3.txt", `SUPERSEDES_BUNDLE_PATH: ${a.bundlePath}`);
  // recompute footer sha（content above the sha line）
  const linesArr = tampered.split("\n");
  const shaIdx = [...linesArr].reverse().findIndex((l) => l.trim().startsWith("REVIEW_BUNDLE_SHA256:"));
  const contentOnly = shaIdx >= 0 ? linesArr.slice(0, linesArr.length - 1 - shaIdx).join("\n") + "\n" : tampered;
  const newSha = sha256Hex(contentOnly);
  const expanded = tampered.replace(/REVIEW_BUNDLE_SHA256: [0-9a-f]{64}$/m, `REVIEW_BUNDLE_SHA256: ${newSha}`);
  const ep = join(OUT, `expanded-max-${Date.now()}.txt`);
  writeFileSync(ep, expanded, "utf8");
  const v = validateReviewBundle(ep, { authorizedDir: OUT });
  assert.equal(v.ok, false, "successor expanding MAX must not validate");
  assert.ok(v.errors.some((e) => e.includes("repair_budget_max_expanded")), `max-expansion flagged (${v.errors.join(";")})`);
  rmSync(ep, { force: true });
});

test("3g. generator inherits predecessor MAX（successor repairBudgetMaxAttempts cannot raise it）", { timeout: 30000 }, async () => {
  // predecessor with MAX=2（a card legitimately authorized for 2 repairs）
  const a = await run(passGraph, {
    closeout: { cardId: "RB-1R-3G", cardType: "repair", repairBudgetMaxAttempts: 2, supersedes: { reviewBundleIdentity: "12".repeat(32), reviewBundleSha256: "34".repeat(32), bundlePath: "/tmp/prev-impl4.txt", verdict: "REPAIR" } },
  });
  assert.equal(a.final, "PASS");
  const aTxt = readFileSync(a.bundlePath, "utf8");
  assert.ok(aTxt.includes("REPAIR_BUDGET_MAX: 2"), "predecessor MAX=2");

  // successor caller tries MAX=3 — generator must inherit 2, not 3
  const b = await run(passGraph, {
    closeout: {
      cardId: "RB-1R-3G",
      cardType: "repair",
      repairBudgetMaxAttempts: 3, // caller tries to expand
      supersedes: {
        reviewBundleIdentity: a.externalReview.delivery.reviewBundleIdentity,
        reviewBundleSha256: a.externalReview.delivery.reviewBundleSha256,
        bundlePath: a.bundlePath,
        verdict: "REPAIR",
      },
    },
  });
  assert.equal(b.final, "PASS", "successor with caller MAX=3 still passes generation（budget inherited down）");
  const bTxt = readFileSync(b.bundlePath, "utf8");
  assert.ok(bTxt.includes("REPAIR_BUDGET_MAX: 2"), `successor MAX inherited as 2, not caller 3 (${bTxt.match(/REPAIR_BUDGET_MAX: \d+/)?.[0]})`);
  // and the lineage validator still accepts it（MAX 2 >= cumulative 2）
  assert.equal(validateReviewBundle(b.bundlePath, { authorizedDir: OUT }).ok, true, "inherited-MAX successor validates");
});

test("4. generator crash -> HOLD REVIEW_BUNDLE_GENERATION_FAILED", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { sourceBuilder: async () => { throw new Error("boom"); } });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.GENERATION_FAILED);
});

test("5. gate timeout -> HOLD REVIEW_BUNDLE_GENERATION_FAILED", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { gate: async () => { await new Promise((res) => setTimeout(res, 2000)); return { final: "PASS" }; }, timeoutMs: 100 });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.GENERATION_FAILED);
  assert.ok(r.reason.includes("timeout"), "timeout reason");
});

test("6. validator rejection -> HOLD REVIEW_BUNDLE_INVALID（never PASS）", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { gate: async () => ({ final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.INVALID, reason: "REVIEW_BUNDLE_INVALID:injected" }) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.INVALID);
  assert.notEqual(r.final, "PASS");
});

test("7. secret injection -> HOLD REVIEW_BUNDLE_SECRET_DETECTED（bundle zero bytes on disk）", { timeout: 30000 }, async () => {
  const r = await runMandatoryGraphCloseout({
    graphResult: passGraph,
    closeout: { ...closeoutOpts(OUT2), executiveSummary: 'leak DEEPSEEK_API_KEY="sk-abcdefghijklmnopqrstuvwxyz123456"' },
    repoPath: REPO_A,
    outDir: OUT2,
    timeoutMs: 8000,
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.SECRET_DETECTED);
  assert.ok(!r.bundlePath, "no bundle path for secret-bearing closeout");
  const bundles = readdirSync(OUT2).filter((f) => f.endsWith(".txt"));
  assert.deepEqual(bundles, [], "no bundle file persisted（pre-write secret scan）");
});

test("8. blocking final review -> no PASS（pass closeout with blocking findings HOLDS）", { timeout: 30000 }, async () => {
  const blocked = {
    ...passGraph,
    nodeResults: passGraph.nodeResults.map((n) => (n.nodeId === "W1"
      ? { ...n, reviewResult: { ...n.reviewResult, recommendedAction: "REPAIR", blockingFindings: ["CLAIM_R2_MISSING"] } }
      : n)),
  };
  const r = await run(blocked);
  assert.equal(r.final, "HOLD");
  // R-12: the blocking finding is fenced BEFORE the gate — the source builder
  // downgrades the contradicted aggregate to HOLD and the oracle rejects the
  // non-PASS independent review（either deterministic surface is fail-closed;
  // both carry the blocking truth）.
  assert.ok(
    /blocking|ORACLE_REQUIRED_CHECK_FAILED@independent-review|AGGREGATE_CHILD_CONTRADICTION/.test(String(r.reason ?? "")),
    `blocking review blocks PASS closeout (${r.reason})`,
  );
  assert.notEqual(r.final, "PASS");
});

test("9. one closeout -> exactly one verdict; temp files cleaned", { timeout: 30000 }, async () => {
  // a FRESH identity（not already exercised by earlier tests）so the
  // artifact behavior is observable
  const freshGraph = { ...passGraph, executionId: "fixture-graph-pass-9", nodeResults: passGraph.nodeResults.map((n) => ({ ...n })), transitions: passGraph.transitions.map((t) => ({ ...t })) };
  const r1 = await run(freshGraph);
  const r2 = await run(freshGraph);
  assert.equal(r1.final, "PASS");
  assert.equal(r2.final, "PASS");
  // deterministic: same graph + same closeout -> same bundle identity AND
  // same file name（idempotent overwrite — one artifact, not competing ones）
  assert.equal(r1.bundle.identity, r2.bundle.identity, "single deterministic verdict");
  // VCA-1 W1A (S9): one authoritative bundle per generation — the fresh
  // identity occupies exactly one authoritative slot, and the identical
  // re-run overwrites in place（no second artifact, no retirement needed）.
  const bundles = readdirSync(OUT).filter((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt"));
  assert.equal(bundles.filter((f) => f === basename(r1.bundlePath)).length, 1, "one authoritative artifact for the fresh identity");
  assert.equal(readdirSync(OUT).filter((f) => f === basename(r1.bundlePath)).length, 1, "rerun of the same identity overwrites（no competing verdicts）");
  const leftovers = readdirSync(OUT).filter((f) => f.includes(".tmp-") || f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no temp residue after closeout");
});

test("10. closeout failure never yields PASS; evidence still hashed by the tool", { timeout: 30000 }, async () => {
  const r = await run(passGraph, { gate: async () => ({ final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:injected" }) });
  assert.equal(r.final, "HOLD");
  assert.notEqual(r.final, "PASS");
  // evidence snapshot written by the closeout layer with a tool-computed sha
  const evFiles = readdirSync(OUT).filter((f) => f.endsWith("-graph-closeout-evidence.json"));
  assert.ok(evFiles.length >= 1, "evidence snapshot persisted");
  const ev = readFileSync(join(OUT, evFiles[evFiles.length - 1]), "utf8");
  assert.match(ev, /"schema": "autoloop\.review-bundle\.graph-closeout-evidence\/v1"/, "evidence schema");
});

test("11. buildGraphCloseoutSource output is schema-valid and structured（never free-text stdout）", { timeout: 30000 }, async () => {
  const src = buildGraphCloseoutSource({ graphResult: passGraph, closeout: closeoutOpts(OUT) });
  assert.equal(src.schema, REVIEW_BUNDLE_SOURCE_SCHEMA);
  assert.equal(src.task.cardId, "RB-1R-TEST");
  assert.ok(Array.isArray(src.negativeCases));
  assert.ok(src.review.pass === true);
  assert.ok(src.review.reviewResultIdentity && src.review.reviewResultIdentity.length === 64);
  assert.equal(src.verifier.result, "PASS");
  assert.ok(Array.isArray(src.repairAttempts));
  // no production-diff claim leaks for a fixture with a worktree output
  assert.ok(src.files.modified.includes("docs/pi-graph-output/summary.md"));
});

test("sanity: graph source schema is the same REVIEW_BUNDLE_SOURCE_SCHEMA as CLI/backfill", { timeout: 30000 }, async () => {
  const src = buildGraphCloseoutSource({ graphResult: passGraph, closeout: closeoutOpts(OUT) });
  assert.equal(src.schema, REVIEW_BUNDLE_SOURCE_SCHEMA);
  assert.deepEqual([...REVIEW_BUNDLE_SECTIONS], [...REVIEW_BUNDLE_SECTIONS]);
});

// ═══════════════════════════════════════════════════════════════════════════
// R-12 CLOSEOUT ACCEPTANCE — single canonical graph evidence validator,
// identity binding, completeness, aggregate/child fencing, reverse controls,
// negative matrix, disk/memory parity.
// ═══════════════════════════════════════════════════════════════════════════

const R12_ROOT = `${tmpdir()}/r12-closeout-${process.pid}`;
const R12_OUT = join(R12_ROOT, "out");
// Canonical runner-shaped PASS graph (order ⇔ nodeResults bound; the exact
// shape runColimaGraph's graphView produces).
const r12RunnerGraph = (cardId, over = {}) => ({
  executionId: over.executionId ?? `r12-run-${cardId}`,
  final: over.final ?? "PASS",
  holdCode: over.holdCode ?? null,
  reason: over.reason ?? null,
  scheduler: over.scheduler ?? {
    verdict: "PASS",
    order: ["R1", "W1", "V1"],
    statuses: { R1: "passed", W1: "passed", V1: "passed" },
    skipped: [],
    writerViolations: [],
    leaseHolderAfter: null,
  },
  nodeResults: over.nodeResults ?? [
    { nodeId: "R1", phaseExecutionId: `e_${cardId}_r1`, taskType: "audit", dependencies: [], final: "PASS", attempt: 0, cleanup: { worktreeRevoked: false } },
    { nodeId: "W1", phaseExecutionId: `e_${cardId}_w1`, taskType: "write", dependencies: ["R1"], final: "PASS", attempt: 0, cleanup: { worktreeRevoked: true }, reviewResult: { status: "PASS", findings: [], blockingFindings: [], recommendedAction: "PASS" } },
    { nodeId: "V1", phaseExecutionId: `e_${cardId}_v1`, taskType: "verify", dependencies: ["W1"], final: "PASS", attempt: 0, cleanup: { worktreeRevoked: false } },
  ],
  transitions: over.transitions ?? [],
});

const r12Closeout = (cardId, over = {}) => ({
  schema: CLOSEOUT_STATE_SCHEMA,
  task: { cardId, cardTitle: `${cardId} title`, cardType: "implementation" },
  requiresReview: true,
  outDir: join(R12_OUT, cardId),
  authorizedScope: ["src/governance/review-bundle.mjs"],
  unauthorizedScope: [],
  objective: `${cardId}: R-12 closeout acceptance`,
  negativeCases: [],
  regression: [{ suite: "test:governance", tests: 1, pass: 1, fail: 0 }],
  regressionSummary: "focused",
  recommendedNextStep: "external review",
  repairBudgetMaxAttempts: 1,
  ...over,
});

const r12Drive = async (cardId, { graphResult = null, graphResultPath = null, state = null, surfaceDir = null } = {}) => {
  const st = state ?? r12Closeout(cardId);
  const stPath = closeoutStatePath(st.outDir);
  writeCloseoutState({ path: stPath, state: st });
  return runStateDrivenCloseout({
    statePath: stPath,
    graphResult,
    graphResultPath,
    repoPath: REPO_A,
    cwd: REPO_A,
    outDir: st.outDir,
    timeoutMs: 30000,
    surfaceDir: surfaceDir ?? join(R12_ROOT, `surface-${cardId}`),
  });
};

// ── RC-A — canonical success (runner-shaped, complete, bound) ─────────────

test("R12-RC-A. canonical runner-shaped complete graph → closeout proceeds to PASS", { timeout: 30000 }, async () => {
  mkdirSync(R12_OUT, { recursive: true });
  const cardId = "R12-RC-A";
  const r = await r12Drive(cardId, { graphResult: r12RunnerGraph(cardId) });
  assert.equal(r.applied, true);
  assert.equal(r.final, "PASS", `canonical success (${r.holdCode}:${r.reason})`);
  assert.ok(r.bundlePath && existsSync(r.bundlePath));
});

// ── RC-B — forged aggregate (missing / HOLD / FAIL / skipped child) ───────

test("R12-RC-B. forged aggregate PASS over missing child → HOLD R12_AGGREGATE_CHILD_CONTRADICTION", { timeout: 30000 }, async () => {
  const cardId = "R12-RC-B";
  const forged = r12RunnerGraph(cardId, { nodeResults: r12RunnerGraph(cardId).nodeResults.filter((n) => n.nodeId !== "V1") });
  const r = await r12Drive(cardId, { graphResult: forged });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "R12_AGGREGATE_CHILD_CONTRADICTION");
  assert.ok(r.reason.includes("V1:MISSING"), r.reason);
});

test("R12-RC-B2. forged aggregate PASS over HOLD child → HOLD", { timeout: 30000 }, async () => {
  const cardId = "R12-RC-B2";
  const g = r12RunnerGraph(cardId);
  g.nodeResults[2].final = "HOLD";
  const r = await r12Drive(cardId, { graphResult: g });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "R12_AGGREGATE_CHILD_CONTRADICTION");
});

test("R12-RC-B3. forged aggregate PASS over FAILED child → HOLD", { timeout: 30000 }, async () => {
  const cardId = "R12-RC-B3";
  const g = r12RunnerGraph(cardId);
  g.nodeResults[1].final = "FAILED";
  const r = await r12Drive(cardId, { graphResult: g });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "R12_AGGREGATE_CHILD_CONTRADICTION");
});

test("R12-RC-B4. forged aggregate PASS over skipped required child → HOLD", { timeout: 30000 }, async () => {
  const cardId = "R12-RC-B4";
  const g = r12RunnerGraph(cardId);
  g.nodeResults[2].final = "SKIPPED_DUE_TO_DEPENDENCY";
  const r = await r12Drive(cardId, { graphResult: g });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "R12_AGGREGATE_CHILD_CONTRADICTION");
});

// ── RC-C — wrong identity ─────────────────────────────────────────────────

test("R12-RC-C. structurally valid PASS evidence bound to the WRONG cardId → HOLD R12_EVIDENCE_CARD_MISMATCH", { timeout: 30000 }, async () => {
  const cardId = "R12-RC-C";
  const forged = { ...r12RunnerGraph(cardId), task: { cardId: "R12-OTHER-CARD" } };
  const r = await r12Drive(cardId, { graphResult: forged });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "R12_EVIDENCE_CARD_MISMATCH");
  assert.ok(r.reason.includes("R12-OTHER-CARD"), r.reason);
});

test("R12-RC-C2. evidence graphRunId conflicting with the recorded lineage → HOLD R12_EVIDENCE_RUN_MISMATCH", { timeout: 30000 }, async () => {
  const cardId = "R12-RC-C2";
  const st = r12Closeout(cardId, { expectedGraphRunId: "recorded-run-42" });
  const forged = r12RunnerGraph(cardId, { executionId: "different-run-99" });
  const r = await r12Drive(cardId, { graphResult: forged, state: st });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "R12_EVIDENCE_RUN_MISMATCH");
});

// ── RC-D — advisory tamper ────────────────────────────────────────────────

test("R12-RC-D. advisory fields tampered → canonical derived result stays authoritative", { timeout: 30000 }, async () => {
  const cardId = "R12-RC-D";
  // advisory (non-authoritative) executiveSummary / diffSummary tampering
  // cannot mint or revoke PASS: the closeout verdict derives from validated
  // graph truth + the gate, never from caller prose.
  const g = r12RunnerGraph(cardId);
  const r = await r12Drive(cardId, {
    graphResult: g,
    state: r12Closeout(cardId, { executiveSummary: "FORGED: everything failed, absolutely HOLD" }),
  });
  assert.equal(r.final, "PASS", `advisory tamper cannot revoke a valid PASS (${r.holdCode}:${r.reason})`);
  const txt = readFileSync(r.bundlePath, "utf8");
  assert.ok(txt.includes("R12-RC-D"), "bundle bound to the card");
});

// ── Negative matrix — deterministic fail-closed outcomes ──────────────────

test("R12-NEG. negative matrix: 20 deterministic fail-closed cases", { timeout: 60000 }, async () => {
  mkdirSync(R12_OUT, { recursive: true });
  const evDir = join(R12_ROOT, "neg-ev");
  mkdirSync(evDir, { recursive: true });
  const writeEv = (name, obj) => {
    const p = join(evDir, `${name}.json`);
    writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
    return p;
  };
  const validEvidence = (over = {}) => ({
    schema: GRAPH_EVIDENCE_SCHEMA,
    graphRunId: "r12-neg-run",
    final: "PASS",
    holdCode: null,
    reason: null,
    task: { cardId: "R12-NEG-CARD", cardTitle: "n", cardType: "implementation" },
    scheduler: { verdict: "PASS", order: ["A", "B"], statuses: { A: "passed", B: "passed" }, skipped: [], writerViolations: [], leaseHolderAfter: null },
    nodes: [
      { nodeId: "A", phaseExecutionId: "ea", taskType: "audit", dependencies: [], final: "PASS", attempt: 0, worktreeRevoked: false },
      { nodeId: "B", phaseExecutionId: "eb", taskType: "write", dependencies: ["A"], final: "PASS", attempt: 0, worktreeRevoked: true, reviewResultStatus: "PASS", reviewBlockingFindings: [] },
    ],
    transitions: [],
    ...over,
  });
  const stPath = closeoutStatePath(join(R12_OUT, "R12-NEG-CARD"));
  writeCloseoutState({ path: stPath, state: r12Closeout("R12-NEG-CARD") });
  const driveEv = async (p) => runStateDrivenCloseout({
    statePath: stPath,
    graphResultPath: p,
    repoPath: REPO_A,
    cwd: REPO_A,
    outDir: join(R12_OUT, "R12-NEG-CARD"),
    timeoutMs: 30000,
    surfaceDir: join(R12_ROOT, "surface-neg"),
  });
  const expectHold = async (name, p, code, needle) => {
    const r = await driveEv(p);
    assert.equal(r.applied, true, `${name}: applied`);
    assert.notEqual(r.final, "PASS", `${name}: must not PASS`);
    assert.equal(r.final, "HOLD", `${name}: final=${r.final} reason=${r.reason}`);
    if (code) assert.equal(r.holdCode, code, `${name}: holdCode=${r.holdCode} reason=${r.reason}`);
    if (needle) assert.ok(String(r.reason ?? "").includes(needle), `${name}: reason=${r.reason}`);
  };

  // 1. missing evidence file
  await expectHold("neg1-missing-file", join(evDir, "does-not-exist.json"), null, "closeout_evidence_missing");
  // 2. malformed JSON
  await expectHold("neg2-malformed-json", writeEv("malformed", "{not json"), null, "closeout_evidence_unreadable");
  // 3. wrong schema
  await expectHold("neg3-wrong-schema", writeEv("wrong-schema", validEvidence({ schema: "some.other.schema/v9" })), "R12_EVIDENCE_SCHEMA_MISMATCH", null);
  // 4. missing task.cardId
  await expectHold("neg4-missing-cardId", writeEv("no-cardid", validEvidence({ task: { cardTitle: "n" } })), "R12_EVIDENCE_INVALID", "task_cardId_missing");
  // 5. wrong task.cardId
  await expectHold("neg5-wrong-cardId", writeEv("wrong-cardid", validEvidence({ task: { cardId: "R12-OTHER" } })), "R12_EVIDENCE_CARD_MISMATCH", null);
  // 6. missing graphRunId
  await expectHold("neg6-missing-runId", writeEv("no-runid", validEvidence({ graphRunId: undefined })), "R12_EVIDENCE_INVALID", "graphRunId_missing");
  // 7. missing aggregate final
  await expectHold("neg7-missing-final", writeEv("no-final", validEvidence({ final: undefined })), "R12_EVIDENCE_INVALID", "aggregate_final_missing");
  // 8. zero nodes
  await expectHold("neg8-zero-nodes", writeEv("zero-nodes", validEvidence({ nodes: [] })), "R12_EVIDENCE_INVALID", "node_collection_empty");
  // 9. missing required node (order lists C)
  await expectHold("neg9-missing-required", writeEv("missing-required", validEvidence({
    scheduler: { verdict: "PASS", order: ["A", "B", "C"], statuses: { A: "passed", B: "passed", C: "passed" }, skipped: [], writerViolations: [] },
  })), "R12_AGGREGATE_CHILD_CONTRADICTION", "C:MISSING");
  // 10. child FAIL
  await expectHold("neg10-child-fail", writeEv("child-fail", validEvidence({
    nodes: validEvidence().nodes.map((n) => (n.nodeId === "B" ? { ...n, final: "FAILED" } : n)),
  })), "R12_AGGREGATE_CHILD_CONTRADICTION", "B:FAILED");
  // 11. child HOLD
  await expectHold("neg11-child-hold", writeEv("child-hold", validEvidence({
    nodes: validEvidence().nodes.map((n) => (n.nodeId === "B" ? { ...n, final: "HOLD" } : n)),
  })), "R12_AGGREGATE_CHILD_CONTRADICTION", "B:HOLD");
  // 12. child unknown final
  await expectHold("neg12-child-unknown", writeEv("child-unknown", validEvidence({
    nodes: validEvidence().nodes.map((n) => (n.nodeId === "B" ? { ...n, final: "WEIRD" } : n)),
  })), "R12_EVIDENCE_INVALID", "node_final_unknown");
  // 13. duplicate conflicting node
  await expectHold("neg13-duplicate-conflict", writeEv("dup-conflict", validEvidence({
    nodes: [...validEvidence().nodes, { nodeId: "B", phaseExecutionId: "eb2", final: "FAILED" }],
  })), "R12_EVIDENCE_INVALID", "duplicate_conflicting_node");
  // 14. skipped required node
  await expectHold("neg14-skipped-required", writeEv("skipped", validEvidence({
    nodes: validEvidence().nodes.map((n) => (n.nodeId === "B" ? { ...n, final: "SKIPPED_DUE_TO_DEPENDENCY" } : n)),
  })), "R12_AGGREGATE_CHILD_CONTRADICTION", "B:SKIPPED_DUE_TO_DEPENDENCY");
  // 15. writer violation
  await expectHold("neg15-writer-violation", writeEv("writer-violation", validEvidence({
    scheduler: { verdict: "HOLD", order: ["A", "B"], statuses: { A: "passed", B: "failed" }, skipped: [], writerViolations: ["B: lease held by A"] },
  })), "R12_AGGREGATE_CHILD_CONTRADICTION", "writer_violation");
  // 16. blocking finding
  await expectHold("neg16-blocking-finding", writeEv("blocking", validEvidence({
    nodes: validEvidence().nodes.map((n) => (n.nodeId === "B" ? { ...n, reviewBlockingFindings: ["FOUND"] } : n)),
  })), "R12_AGGREGATE_CHILD_CONTRADICTION", "B:BLOCKING_FINDINGS");
  // 17. aggregate PASS + child non-PASS (scheduler truth contradicts PASS)
  await expectHold("neg17-aggregate-child", writeEv("agg-child", validEvidence({
    final: "PASS",
    scheduler: { verdict: "HOLD", order: ["A", "B"], statuses: { A: "passed", B: "held" }, skipped: [], writerViolations: [] },
  })), "R12_AGGREGATE_CHILD_CONTRADICTION", "scheduler_status:B:held");
  // 18. stale/wrong generation — replay from a mismatched recorded run
  const st2Path = closeoutStatePath(join(R12_OUT, "R12-NEG-GEN"));
  writeCloseoutState({ path: st2Path, state: r12Closeout("R12-NEG-GEN", { expectedGraphRunId: "gen-run-current" }) });
  const stale = writeEv("stale-gen", validEvidence({ task: { cardId: "R12-NEG-GEN" }, graphRunId: "gen-run-OLD" }));
  const r18 = await runStateDrivenCloseout({
    statePath: st2Path, graphResultPath: stale, repoPath: REPO_A, cwd: REPO_A,
    outDir: join(R12_OUT, "R12-NEG-GEN"), timeoutMs: 30000, surfaceDir: join(R12_ROOT, "surface-neg"),
  });
  assert.equal(r18.final, "HOLD");
  assert.equal(r18.holdCode, "R12_EVIDENCE_RUN_MISMATCH");
  // 19. replay from another card
  const otherCard = writeEv("other-card", validEvidence({ task: { cardId: "R12-SOMEONE-ELSE" } }));
  await expectHold("neg19-replay-other-card", otherCard, "R12_EVIDENCE_CARD_MISMATCH", null);
  // 20. caller-declared aggregate PASS without canonical evidence — the
  //     pre-R12 defect reproducer: bare PASS object with a fake node.
  const bare = writeEv("bare-pass", { final: "PASS", nodeResults: [{ nodeId: "FAKE", final: "PASS" }] });
  await expectHold("neg20-bare-pass", bare, "R12_EVIDENCE_SCHEMA_MISMATCH", null);
});

// ── GATE 9 — non-PASS semantics: valid evidence with HOLD outcome ─────────

test("R12-NONPASS. valid evidence with HOLD outcome → normal closeout non-PASS (not an exception)", { timeout: 30000 }, async () => {
  const cardId = "R12-NONPASS";
  const g = r12RunnerGraph(cardId, {
    final: "HOLD",
    holdCode: "ORCHESTRATION_HOLD",
    reason: "phase V1 held",
    scheduler: { verdict: "HOLD", order: ["R1", "W1", "V1"], statuses: { R1: "passed", W1: "passed", V1: "held" }, skipped: [], writerViolations: [] },
  });
  g.nodeResults[2].final = "HOLD";
  const r = await r12Drive(cardId, { graphResult: g });
  assert.equal(r.applied, true);
  assert.equal(r.final, "HOLD", "valid non-PASS evidence keeps closeout semantics");
  assert.notEqual(r.holdCode, "R12_EVIDENCE_INVALID");
  assert.notEqual(r.holdCode, "R12_AGGREGATE_CHILD_CONTRADICTION");
});

// ── GATE P — disk/memory parity ───────────────────────────────────────────

test("R12-PARITY. same semantic evidence via disk path and memory path → same closeout verdict", { timeout: 60000 }, async () => {
  const cardId = "R12-PARITY";
  const g = r12RunnerGraph(cardId, { executionId: "r12-parity-run" });
  // memory path
  const mem = await r12Drive(`${cardId}-MEM`, { graphResult: g });
  assert.equal(mem.final, "PASS", `memory path (${mem.holdCode}:${mem.reason})`);
  // disk path: serialize the SAME semantic evidence to the v1 snapshot and load it
  const evDir = join(R12_ROOT, "parity");
  mkdirSync(evDir, { recursive: true });
  const snapshot = {
    schema: GRAPH_EVIDENCE_SCHEMA,
    graphRunId: g.executionId,
    final: g.final,
    holdCode: null,
    reason: null,
    task: { cardId: `${cardId}-DISK`, cardTitle: "p", cardType: "implementation" },
    scheduler: g.scheduler,
    nodes: g.nodeResults.map((n) => ({
      nodeId: n.nodeId,
      phaseExecutionId: n.phaseExecutionId,
      taskType: n.taskType,
      dependencies: n.dependencies,
      final: n.final,
      attempt: n.attempt,
      worktreeRevoked: n.cleanup?.worktreeRevoked === true,
      reviewResultStatus: n.reviewResult?.recommendedAction ?? null,
      reviewBlockingFindings: n.reviewResult?.blockingFindings ?? [],
    })),
    transitions: g.transitions,
  };
  const evPath = join(evDir, "parity-evidence.json");
  writeFileSync(evPath, JSON.stringify(snapshot), "utf8");
  const disk = await r12Drive(`${cardId}-DISK`, { graphResultPath: evPath });
  assert.equal(disk.final, "PASS", `disk path (${disk.holdCode}:${disk.reason})`);
  assert.equal(mem.final, disk.final, "parity: same verdict");
  // parity on rejection: the SAME forged evidence fails identically on both paths
  const forgedMem = { ...g, nodeResults: g.nodeResults.filter((n) => n.nodeId !== "V1") };
  const forgedDisk = { ...snapshot, graphRunId: "r12-parity-run", nodes: snapshot.nodes.filter((n) => n.nodeId !== "V1") };
  const fMem = await r12Drive(`${cardId}-FMEM`, { graphResult: forgedMem });
  assert.equal(fMem.final, "HOLD");
  assert.equal(fMem.holdCode, "R12_AGGREGATE_CHILD_CONTRADICTION");
  const fDiskPath = join(evDir, "forged-parity.json");
  writeFileSync(fDiskPath, JSON.stringify({ ...forgedDisk, task: { cardId: `${cardId}-FDISK` } }), "utf8");
  const fDisk = await r12Drive(`${cardId}-FDISK`, { graphResultPath: fDiskPath });
  assert.equal(fDisk.final, "HOLD");
  assert.equal(fDisk.holdCode, "R12_AGGREGATE_CHILD_CONTRADICTION", `disk rejection parity (${fDisk.holdCode})`);
});

// ── Validator unit surface — schema/identity/normalization ────────────────

test("R12-VALID. validator: schema enforcement + identity + normalization + run binding", () => {
  // schema required on disk evidence
  const noSchema = validateGraphEvidence({ graphRunId: "g", final: "PASS", nodes: [{ nodeId: "A", final: "PASS" }] }, { requireSchema: true });
  assert.equal(noSchema.ok, false);
  assert.equal(noSchema.holdCode, "R12_EVIDENCE_SCHEMA_MISMATCH");
  // graph-unknown placeholder is never accepted as a run identity
  const unknown = validateGraphEvidence({ graphRunId: "graph-unknown", final: "PASS", nodes: [{ nodeId: "A", final: "PASS" }] });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some((e) => e.includes("graphRunId_missing_or_reserved_placeholder")));
  // runner-shaped input normalizes nodeResults
  const runner = validateGraphEvidence(r12RunnerGraph("V-UNIT"));
  assert.equal(runner.ok, true);
  assert.equal(runner.graphResult.nodeResults.length, 3);
  assert.equal(runner.graphResult.executionId, `r12-run-V-UNIT`);
  // disk-shaped input normalizes nodes
  const disk = validateGraphEvidence({
    schema: GRAPH_EVIDENCE_SCHEMA, graphRunId: "g1", final: "PASS",
    task: { cardId: "V-UNIT" },
    nodes: [{ nodeId: "A", final: "PASS" }],
  }, { requireSchema: true, requireTaskIdentity: true });
  assert.equal(disk.ok, true);
  assert.equal(disk.graphResult.nodeResults[0].nodeId, "A");
  // node with a foreign graphExecutionId → run mismatch
  const foreign = validateGraphEvidence({
    graphRunId: "g1", final: "PASS",
    nodes: [{ nodeId: "A", final: "PASS", graphExecutionId: "OTHER-RUN" }],
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.holdCode, "R12_EVIDENCE_RUN_MISMATCH");
  // non-PASS valid evidence passes structural validation (GATE 9)
  const held = validateGraphEvidence({ graphRunId: "g2", final: "HOLD", nodes: [{ nodeId: "A", final: "HOLD" }] });
  assert.equal(held.ok, true);
  assert.equal(held.graphResult.final, "HOLD");
});

test("R12-LOADER. loadGraphResultFromEvidence: no silent defaults survive", async () => {
  const dir = join(R12_ROOT, "loader");
  mkdirSync(dir, { recursive: true });
  // missing graphRunId no longer defaults to graph-unknown
  const p1 = join(dir, "no-run.json");
  writeFileSync(p1, JSON.stringify({ schema: GRAPH_EVIDENCE_SCHEMA, final: "PASS", task: { cardId: "L" }, nodes: [{ nodeId: "A", final: "PASS" }] }));
  const l1 = loadGraphResultFromEvidence(p1);
  assert.equal(l1.ok, false);
  assert.ok(l1.errors.some((e) => e.includes("graphRunId_missing")));
  // missing final no longer defaults to HOLD
  const p2 = join(dir, "no-final.json");
  writeFileSync(p2, JSON.stringify({ schema: GRAPH_EVIDENCE_SCHEMA, graphRunId: "g", task: { cardId: "L" }, nodes: [{ nodeId: "A", final: "PASS" }] }));
  const l2 = loadGraphResultFromEvidence(p2);
  assert.equal(l2.ok, false);
  assert.ok(l2.errors.some((e) => e.includes("aggregate_final_missing")));
  // card binding through the loader
  const p3 = join(dir, "wrong-card.json");
  writeFileSync(p3, JSON.stringify({
    schema: GRAPH_EVIDENCE_SCHEMA, graphRunId: "g", final: "PASS",
    task: { cardId: "OTHER" }, nodes: [{ nodeId: "A", final: "PASS" }],
  }));
  const l3 = loadGraphResultFromEvidence(p3, { expectedCardId: "MINE" });
  assert.equal(l3.ok, false);
  assert.equal(l3.holdCode, "R12_EVIDENCE_CARD_MISMATCH");
  // valid evidence with card binding loads
  const p4 = join(dir, "ok.json");
  writeFileSync(p4, JSON.stringify({
    schema: GRAPH_EVIDENCE_SCHEMA, graphRunId: "g", final: "PASS",
    task: { cardId: "MINE" }, nodes: [{ nodeId: "A", final: "PASS" }],
  }));
  const l4 = loadGraphResultFromEvidence(p4, { expectedCardId: "MINE" });
  assert.equal(l4.ok, true);
  assert.equal(l4.graphResult.executionId, "g");
});

test("R12-BUILDER. buildGraphCloseoutSource consumes validated truth only", () => {
  // forged aggregate PASS over a missing required child → executiveStatus HOLD
  const forged = r12RunnerGraph("B-UNIT", { nodeResults: r12RunnerGraph("B-UNIT").nodeResults.filter((n) => n.nodeId !== "V1") });
  const src = buildGraphCloseoutSource({ graphResult: forged, closeout: { cardId: "B-UNIT" } });
  assert.equal(src.executiveStatus, "HOLD");
  assert.ok(src.executiveSummary.includes("R-12 aggregate/child contradiction fenced"));
  // malformed evidence → deterministic throw, never a plausible source
  assert.throws(() => buildGraphCloseoutSource({ graphResult: { final: "PASS" }, closeout: { cardId: "B-UNIT" } }), /R12_EVIDENCE_INVALID/);
  // valid runner graph → executiveStatus reflects validated truth
  const ok = buildGraphCloseoutSource({ graphResult: r12RunnerGraph("B-UNIT"), closeout: { cardId: "B-UNIT" } });
  assert.equal(ok.executiveStatus, "PASS");
});
