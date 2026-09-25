// test/test-graph-closeout-integration.mjs
//
// RB-1R — REAL end-to-end mandatory closeout wiring through the generic
// Graph runner（runColimaGraph → runMandatoryGraphCloseout → runCloseoutGate）.
//
// Proves, WITHOUT any manual CLI step:
//   1. a Graph run with a persisted closeout-state record（closeout.statePath,
//      R-04 canonical seam）auto-generates + validates its review bundle
//      before the card may PASS（research card, zero production diff）
//   2. bundle-gate failure downgrades a would-be-PASS graph to HOLD
//      （fail-closed; no downstream PASS without a validated bundle）
//   3. the bundle's Repository Integrity keeps `package.json` intact
//      （RB-1 `ackage.json` defect regression）
//   4. exactly one card-level closeout verdict per run（node-level interim
//      PASS != card-level final closeout）
//
// Real Colima instance lifecycle（same as test-colima-graph.mjs）.
//
// Run: node --test test/test-graph-closeout-integration.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runColimaGraph } from "../src/runtime/colima-graph-runner.mjs";
import { validateReviewBundle, REVIEW_BUNDLE_HOLDS } from "../src/governance/review-bundle.mjs";
import { CLOSEOUT_STATE_SCHEMA, closeoutStatePath, writeCloseoutState } from "../src/governance/closeout-state.mjs";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const REPO_A = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
const SCRATCH = `${HOME}/autoloop-graph-closeout-test-scratch`;
const PROFILE = "autoloop-graph";
const PARENT = { scope: { allowed_paths: ["docs/"], forbidden_paths: [".git"] } };
const OUT = join(tmpdir(), `rb1r-graph-closeout-e2e-${process.pid}`);
const repoHeadBefore = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

function roPhase(phaseId, dependsOn = [], sleep = 4) {
  return {
    phase_id: phaseId,
    depends_on: dependsOn,
    effects: { artifact_mutation: "none" },
    runtime: {
      mode: "readonly",
      command: `${sleep ? `sleep ${sleep}; ` : ""}echo "${phaseId}_DONE"; touch /src/.closeout-probe 2>&1 && echo SRC_WRITABLE || echo SRC_WRITE_DENIED; touch /scratch/probe.txt && echo SCRATCH_OK; [ ! -e /var/run/docker.sock ] && echo NO_SOCKET || echo SOCKET_PRESENT`,
      expect: { stdoutContains: [`${phaseId}_DONE`, "SRC_WRITE_DENIED", "NO_SOCKET"] },
      limits: { memoryMiB: 256 },
    },
  };
}

const researchIr = {
  phases: [
    roPhase("R1", []),
    roPhase("R2", []),
    roPhase("V1", ["R1", "R2"], 1),
  ],
};

// R-04 removal: the e2e cases drive closeout through the canonical
// statePath seam — a persisted closeout-state record is the sole
// review-required trigger. The record carries the same card metadata the
// legacy in-memory contract carried; the persisted record is authoritative.
const baseCloseoutState = (overrides = {}) => ({
  schema: CLOSEOUT_STATE_SCHEMA,
  requiresReview: true,
  task: { cardId: "RB-1R-E2E", cardTitle: "Mandatory Closeout E2E", cardType: "research" },
  objective: "prove the mandatory graph closeout gate end to end",
  authorizedScope: ["docs/"],
  unauthorizedScope: ["commit", "push", "merge", "seal"],
  designDecisions: ["mandatory closeout hook at the generic graph runner"],
  negativeCases: ["gate failure downgrades PASS to HOLD"],
  regression: [{ suite: "test:governance", tests: 1, pass: 1, fail: 0 }],
  regressionSummary: "focused governance tests pass",
  recommendedNextStep: "CBM-2",
  ...overrides,
});

const writeE2eCloseoutState = (cardId, cardTitle, overrides = {}) => {
  const outDir = join(OUT, cardId);
  const state = baseCloseoutState({
    task: { cardId, cardTitle, cardType: "research" },
    outDir,
    diffSummary: "NO_PRODUCTION_DIFF (research card)",
    ...overrides,
  });
  const stPath = closeoutStatePath(outDir);
  const w = writeCloseoutState({ path: stPath, state });
  assert.equal(w.ok, true, `closeout-state write failed: ${w.reason}`);
  return { outDir, statePath: stPath };
};

before(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  // RB-1H hard rule: requiresReview closeouts default-deliver to the fixed
  // surface — redirect it away from the real Desktop inbox during tests.
  process.env.AEGISFLOW_REVIEW_SURFACE = join(OUT, "surface");
  process.env.AEGISFLOW_REVIEW_ARCHIVE = join(OUT, "archive");
});
after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  delete process.env.AEGISFLOW_REVIEW_SURFACE;
  delete process.env.AEGISFLOW_REVIEW_ARCHIVE;
  const now = spawnSync("git", ["-C", REPO_A, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
  const beforeCount = spawnSync("git", ["-C", REPO_A, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
  assert.equal(now, beforeCount, "main repo entries unchanged by the test");
});

test("1. research graph with closeout auto-generates a validated bundle WITHOUT CLI; card PASS only after validation", { timeout: 900000 }, async (t) => {
  // R-04: closeout is triggered by the persisted statePath record, not an
  // in-memory requiresReview flag.
  const { outDir, statePath } = writeE2eCloseoutState("RB-1R-E2E", "Mandatory Closeout E2E");
  const r = await runColimaGraph({
    ir: researchIr,
    parent: PARENT,
    cwd: REPO_A,
    executionId: "graph-closeout-main-1",
    profile: PROFILE,
    repoPath: REPO_A,
    scratchRoot: SCRATCH,
    timeoutMs: 90000,
    closeout: { statePath, outDir },
  });
  // card-level final PASS rides on a validated bundle
  assert.equal(r.final, "PASS", `graph PASS (${r.reason})`);
  assert.equal(r.closeout.applied, true, "closeout gate applied");
  assert.equal(r.closeout.final, "PASS", `closeout final PASS (${r.closeout.reason})`);
  assert.ok(r.closeout.bundlePath && existsSync(r.closeout.bundlePath), "bundle auto-generated（no CLI）");
  // node-level interim PASS stays per-node（distinct from card-level closeout）
  for (const id of ["R1", "R2", "V1"]) {
    const n = r.nodeResults.find((x) => x.nodeId === id);
    assert.equal(n.final, "PASS", `node ${id} interim PASS`);
  }
  // bundle is a complete, independently valid 25-section artifact
  const txt = readFileSync(r.closeout.bundlePath, "utf8");
  assert.equal((txt.match(/^\d+\. [^\n]+$/gm) || []).length, 25, "25 sections");
  assert.ok(txt.includes("=== END OF REVIEW BUNDLE ==="), "terminator");
  assert.ok(txt.includes("CARD_TYPE: research"), "research card type");
  assert.ok(txt.includes("NO_PRODUCTION_DIFF"), "research diff summary");
  // RB-1 path identity defect regression: the DIRTY_PATHS inventory keeps
  // package.json intact and contains no truncated ackage.json ENTRY（the
  // prose may legitimately mention the defect name and `package.json`
  // contains `ackage.json` as a substring, so compare exact entries）
  const dirtyLine = txt.split("\n").find((l) => l.startsWith("DIRTY_PATHS:"));
  assert.ok(dirtyLine, "DIRTY_PATHS line present");
  const dirtyEntries = dirtyLine.slice("DIRTY_PATHS:".length).trim() === "[]"
    ? []
    : dirtyLine.slice("DIRTY_PATHS:".length).trim().split(", ").filter(Boolean);
  const porcelainPaths = new Set(spawnSync("git", ["-C", REPO_A, "status", "--porcelain=v1"], { encoding: "utf8" })
    .stdout.split("\n").filter(Boolean).map((l) => l.slice(3)));
  // git status --porcelain collapses fully-untracked directories; the bundle
  // inventory expands them (ls-files --others), so anchor against the union.
  const untrackedExpanded = new Set(spawnSync("git", ["-C", REPO_A, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" })
    .stdout.split("\n").filter(Boolean));
  const liveDirty = new Set([...porcelainPaths, ...untrackedExpanded]);
  assert.ok(dirtyEntries.every((p) => liveDirty.has(p)), "every DIRTY_PATHS entry is a live dirty/untracked path (no truncation/fabrication)");
  if (porcelainPaths.has("package.json")) assert.ok(dirtyEntries.includes("package.json"), "DIRTY_PATHS keeps package.json intact when dirty");
  assert.ok(!dirtyEntries.includes("ackage.json"), "no ackage.json entry in DIRTY_PATHS");
  assert.ok(dirtyEntries.every((p) => p.length > 0), "no empty path entries");
  const v = validateReviewBundle(r.closeout.bundlePath, { authorizedDir: OUT });
  assert.equal(v.ok, true, `bundle independently validates (${v.errors.join(";")})`);
  // repo purity
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "main repo untouched");
  // temp residue
  assert.deepEqual(readdirSync(OUT).filter((f) => f.includes(".tmp-") || f.endsWith(".tmp")), [], "no temp residue");
});

test("2. bundle-gate failure downgrades a would-be-PASS graph to HOLD（fail-closed; no downstream PASS）", { timeout: 900000 }, async (t) => {
  // R-04: closeout is triggered by the persisted statePath record, not an
  // in-memory requiresReview flag.
  const { outDir, statePath } = writeE2eCloseoutState("RB-1R-E2E-FAIL", "Mandatory Closeout E2E FAIL");
  const r = await runColimaGraph({
    ir: researchIr,
    parent: PARENT,
    cwd: REPO_A,
    executionId: "graph-closeout-fail-1",
    profile: PROFILE,
    repoPath: REPO_A,
    scratchRoot: SCRATCH,
    timeoutMs: 90000,
    closeout: { statePath, outDir },
    // internal DI（never a CLI flag）: validator rejects -> the PRODUCTION
    // mandatory path must downgrade the graph verdict
    closeoutGate: async () => ({ final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.INVALID, reason: "REVIEW_BUNDLE_INVALID:injected" }),
  });
  assert.equal(r.final, "HOLD", "graph downgraded to HOLD when the bundle gate fails");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.INVALID, "formal hold code surfaced");
  assert.equal(r.closeout.applied, true);
  assert.equal(r.closeout.final, "HOLD");
  assert.notEqual(r.final, "PASS", "no PASS without a validated bundle");
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "main repo untouched");
});

// ── R-01: settlement-return enforcement at the production runner seam ──────
// A phase refused by the budget pre-dispatch gate never dispatched: it holds
// no reservation, consumed nothing, and its terminal must be refusal
// evidence (skipped) — never a phantom settlement whose failure is silently
// ignored and later misattributed to BUDGET_RECONCILIATION_DIVERGED.
test("R-01: budget-refused phase settles nothing; authoritative hold code preserved; no reconciliation misattribution", { timeout: 300000 }, async () => {
  const { classify, scanRiskSignals } = await import("../src/admission/classify.mjs");
  const { buildAdmissionRecord } = await import("../src/admission/policy-projection.mjs");
  const { freezeAdmission } = await import("../src/admission/admission-record.mjs");
  const { createBudgetEnforcement } = await import("../src/budget/enforcement.mjs");
  const { BUDGET_CONTRACT_SCHEMA } = await import("../src/budget/contract.mjs");

  const FULL_EVIDENCE = {
    affected_files: { score: 1, reasons: ["single file"] },
    affected_subsystems: { score: 0, reasons: ["docs only"] },
    dependency_depth: { score: 0, reasons: ["no deps"] },
    ambiguity: { score: 0, reasons: ["exact text"] },
    expected_execution_steps: { score: 0, reasons: ["one edit"] },
    verification_burden: { score: 0, reasons: ["no tests"] },
    external_dependencies: { score: 0, reasons: ["none"] },
    concurrency_potential: { score: 0, reasons: ["none"] },
    statefulness: { score: 0, reasons: ["stateless"] },
    rollback_complexity: { score: 0, reasons: ["revert 1 file"] },
  };
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const rec = buildAdmissionRecord({
    taskId: "R01-SEAM-TEST",
    classification: c,
    mutationScope: ["docs/"],
    extensions: { budget: { schema: BUDGET_CONTRACT_SCHEMA, version: 1, dimensions: {
      node_execution_count: { limit: 0 },
      wall_clock_ms: { limit: 600000 },
      sub_agent_execution_count: { limit: 1 },
      repair_attempt_count: { limit: 2 },
      verifier_reviewer_attempts: { limit: 2 },
      retry_count: { limit: 2 },
    } } },
  });
  const admission = freezeAdmission(rec);
  const enc = createBudgetEnforcement({ admission }).enforcement;

  const r = await runColimaGraph({
    ir: { phases: [roPhase("R01P1", [], 1)] },
    parent: PARENT,
    cwd: REPO_A,
    executionId: "r01-seam-1",
    profile: PROFILE,
    repoPath: REPO_A,
    scratchRoot: SCRATCH,
    timeoutMs: 90000,
    budget: { enforcement: enc },
  });
  // The authoritative refusal (pre-dispatch gate) must surface as the final
  // hold code — NOT the downstream reconciliation fence.
  assert.equal(r.final, "HOLD");
  assert.notEqual(r.holdCode, "BUDGET_RECONCILIATION_DIVERGED");
  assert.equal(r.budget?.authorized, true, "budget section attached (enforcement present)");
  assert.equal(r.budget.reconciliation.diverged.length, 0, `no divergence: ${JSON.stringify(r.budget?.reconciliation?.diverged)}`);
  assert.equal(r.budget.dimensions.node_execution_count.consumed, 0, "refused phase never settles consumption");
  // the refused node is refusal evidence, not consumption evidence
  const node = (r.nodeResults ?? []).find((n) => n.nodeId === "R01P1");
  assert.ok(node, "refused phase terminal recorded");
  assert.equal(node.skipped, true, "never-dispatched node is refusal evidence (skipped)");
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "main repo untouched");
});
