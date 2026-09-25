// test/governance/test-card-inventory.mjs
//
// CBM-2R — card-level changed-file inventory（Finding 5）.
//
// Section 9 must show what the card actually implemented, split into
//   CARD_IMPLEMENTATION_FILES / GRAPH_CLOSEOUT_OUTPUTS / PRE_EXISTING_DIRTY_FILES
// — never only the closeout output（summary.md）and never the whole worktree
// dirty list mislabeled as the card's changes.
//
// Run: node --test test/governance/test-card-inventory.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runMandatoryGraphCloseout,
  buildGraphCloseoutSource,
  collectRepoFacts,
  validateReviewBundle,
  captureBaselineInventory,
} from "../../src/governance/review-bundle.mjs";

const REPO_A = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");
const ROOT = `${tmpdir()}/cbm2r-inventory-${process.pid}`;
const OUT = join(ROOT, "out");

const facts = collectRepoFacts(REPO_A);
const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const passGraph = {
  executionId: "fixture-cbm2r-inventory-1",
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
      nodeId: "R1", phaseExecutionId: "exec_r1", taskType: "audit", dependencies: [],
      final: "PASS", attempt: 0, reason: null, startedAt: 1, completedAt: 2,
      cleanup: { worktreeRevoked: false },
      subagentResult: { status: "PASS", testResults: null, testsExecuted: [] },
    },
    {
      nodeId: "W1", phaseExecutionId: "exec_w1", taskType: "write", dependencies: ["R1"],
      final: "PASS", attempt: 0, reason: null, startedAt: 3, completedAt: 4,
      worktreeIdentity: {
        verified: true,
        output: { files: [{ status: " M", path: "src/governance/review-bundle.mjs", source: null, destination: null, rename: false }] },
      },
      cleanup: { worktreeRevoked: true },
      subagentResult: { status: "PASS", testResults: { passed: 1, failed: 0, total: 1 }, testsExecuted: ["self-test"] },
      reviewResult: { status: "PASS", findings: [], blockingFindings: [], scopeVerified: true, testsVerified: true, recommendedAction: "PASS", summary: "review PASS" },
    },
    {
      nodeId: "V1", phaseExecutionId: "exec_v1", taskType: "verify", dependencies: ["W1"],
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

let _surfaceSeq = 0;
const closeoutOpts = (overrides = {}) => ({
  requiresReview: true,
  cardId: "CBM-2R-TEST",
  cardTitle: "Card Inventory Test",
  cardType: "repair",
  objective: "verify card-level changed-file inventory",
  authorizedScope: ["src/governance/review-bundle.mjs", "test/governance/test-card-inventory.mjs"],
  unauthorizedScope: ["commit", "push"],
  designDecisions: ["categorized inventory"],
  negativeCases: [],
  regression: [{ suite: "test:governance", tests: 1, pass: 1, fail: 0 }],
  regressionSummary: "focused tests pass",
  recommendedNextStep: "CBM-3",
  // RB-1H: an un-rotated trio is never overwritten — each closeout run gets
  // its own isolated surface（AUTOLOOP_REPORT_LIFECYCLE_REPAIR_1 FM-2）.
  surfaceDir: join(ROOT, "surface", `run-${_surfaceSeq++}`),
  cardFiles: {
    cardImplementation: ["src/memory/canonical.mjs", "src/memory/contract.mjs", "test/memory/test-canonical.mjs", "package.json"],
    closeoutOutputs: ["docs/pi-graph-output/summary.md", "docs/pi-graph-output/cbm2r/card-closeout-bundle-20260807-xxx.txt"],
    preExistingDirty: ["src/v2/execution-orchestrator.mjs", "src/runtime/colima-runtime.mjs"],
  },
  ...overrides,
});

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  process.env.AEGISFLOW_REVIEW_SURFACE = join(ROOT, "surface");
  process.env.AEGISFLOW_REVIEW_ARCHIVE = join(ROOT, "archive");
});
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.AEGISFLOW_REVIEW_SURFACE;
  delete process.env.AEGISFLOW_REVIEW_ARCHIVE;
});

test("1. section 9 renders CARD_IMPLEMENTATION_FILES / GRAPH_CLOSEOUT_OUTPUTS / PRE_EXISTING_DIRTY_FILES", { timeout: 30000 }, async () => {
  const r = await runMandatoryGraphCloseout({ graphResult: passGraph, closeout: closeoutOpts(), repoPath: REPO_A, outDir: OUT, timeoutMs: 8000 });
  assert.equal(r.final, "PASS", `bundle gate PASS (${r.reason})`);
  const txt = readFileSync(r.bundlePath, "utf8");
  const sec9 = txt.split("9. Files Added / Modified / Deleted")[1].split("10. Diff Summary")[0];
  assert.ok(sec9.includes("CARD_IMPLEMENTATION_FILES:"), "CARD_IMPLEMENTATION_FILES label");
  assert.ok(sec9.includes("  - src/memory/canonical.mjs"), "implementation file listed");
  assert.ok(sec9.includes("  - package.json"), "package.json listed");
  assert.ok(sec9.includes("GRAPH_CLOSEOUT_OUTPUTS:"), "GRAPH_CLOSEOUT_OUTPUTS label");
  assert.ok(sec9.includes("  - docs/pi-graph-output/summary.md"), "closeout output listed");
  assert.ok(sec9.includes("PRE_EXISTING_DIRTY_FILES:"), "PRE_EXISTING_DIRTY_FILES label");
  assert.ok(sec9.includes("  - src/v2/execution-orchestrator.mjs"), "pre-existing dirty listed");
  // the worktree-derived ADDED/MODIFIED/DELETED still render
  assert.ok(sec9.includes("MODIFIED:"), "worktree MODIFIED still present");
  assert.ok(sec9.includes("  - src/governance/review-bundle.mjs"), "worktree-derived modified file");
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: OUT });
  assert.equal(v.ok, true, `bundle validates (${v.errors.join(";")})`);
});

test("2. without cardFiles the plain ADDED/MODIFIED/DELETED form is unchanged", { timeout: 30000 }, async () => {
  const r = await runMandatoryGraphCloseout({ graphResult: passGraph, closeout: closeoutOpts({ cardFiles: undefined, cardId: "CBM-2R-TEST-2" }), repoPath: REPO_A, outDir: OUT, timeoutMs: 8000 });
  assert.equal(r.final, "PASS");
  const txt = readFileSync(r.bundlePath, "utf8");
  const sec9 = txt.split("9. Files Added / Modified / Deleted")[1].split("10. Diff Summary")[0];
  assert.ok(!sec9.includes("CARD_IMPLEMENTATION_FILES:"), "no category label without cardFiles");
  assert.ok(sec9.includes("ADDED:"), "plain ADDED");
  assert.ok(sec9.includes("MODIFIED:"), "plain MODIFIED");
});

test("3. buildGraphCloseoutSource merges cardFiles over worktree-derived files", async () => {
  const source = buildGraphCloseoutSource({ graphResult: passGraph, closeout: closeoutOpts(), evidence: [] });
  assert.ok(Array.isArray(source.files.cardImplementation), "cardImplementation array");
  assert.ok(source.files.cardImplementation.includes("src/memory/canonical.mjs"), "implementation file");
  assert.ok(Array.isArray(source.files.preExistingDirty), "preExistingDirty array");
  // worktree-derived files still merged in
  assert.ok(source.files.modified.includes("src/governance/review-bundle.mjs"), "worktree modified merged");
  // the card's own closeout files are NOT mislabeled as implementation
  assert.ok(!source.files.cardImplementation.includes("src/v2/execution-orchestrator.mjs"), "pre-existing dirty NOT in implementation");
});

test("4. inventory changes the content sha256; review identity stays task/repo-bound", { timeout: 30000 }, async () => {
  const r1 = await runMandatoryGraphCloseout({ graphResult: passGraph, closeout: closeoutOpts({ cardId: "CBM-2R-TEST-4" }), repoPath: REPO_A, outDir: OUT, timeoutMs: 8000 });
  const r2 = await runMandatoryGraphCloseout({ graphResult: passGraph, closeout: closeoutOpts({ cardId: "CBM-2R-TEST-4", cardFiles: { cardImplementation: ["src/memory/canonical.mjs"] } }), repoPath: REPO_A, outDir: OUT, timeoutMs: 8000 });
  assert.notEqual(r1.bundle.sha256, r2.bundle.sha256, "different inventory -> different content sha256");
  // identity binds task/repo/graph/review identity — NOT every rendered
  // section（identity excludes the bundle's own content hash by design）
  assert.equal(r1.bundle.identity, r2.bundle.identity, "same review identity -> same identity");
  const txt1 = readFileSync(r1.bundlePath, "utf8");
  assert.ok(txt1.includes("CARD_IMPLEMENTATION_FILES:"), "inventory rendered in r1");
});

test("FM-3: closeout contract with a captured baseline carries the delta-v1 inventory model", { timeout: 30000 }, async () => {
  const baseline = captureBaselineInventory(REPO_A, { cardId: "FM3-CARD-INVENTORY" });
  assert.equal(baseline.schema, "autoloop.card-inventory.baseline/v1");
  const source = buildGraphCloseoutSource({
    graphResult: passGraph,
    closeout: closeoutOpts({
      cardId: "FM3-CARD-INVENTORY",
      baseline,
      cardFiles: {
        cardImplementation: ["src/memory/canonical.mjs"],
        closeoutOutputs: ["docs/pi-graph-output/summary.md"],
        preExistingDirty: [],
      },
    }),
    repoPath: REPO_A,
    evidence: [],
  });
  assert.ok(source.inventory, "inventory model present");
  assert.equal(source.inventory.model, "delta-v1");
  assert.deepEqual(source.inventory.baseline.dirtyPaths, baseline.dirtyPaths, "baseline rendered from the captured snapshot");
  assert.ok(Array.isArray(source.inventory.deltaPaths), "delta paths array");
  // the baseline is authoritative pre-existing dirty provenance
  assert.deepEqual(source.files.preExistingDirty, baseline.dirtyPaths, "preExistingDirty derived from baseline");
});
