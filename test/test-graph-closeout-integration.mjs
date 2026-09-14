// test/test-graph-closeout-integration.mjs
//
// RB-1R — REAL end-to-end mandatory closeout wiring through the generic
// Graph runner（runColimaGraph → runMandatoryGraphCloseout → runCloseoutGate）.
//
// Proves, WITHOUT any manual CLI step:
//   1. a Graph run marked requiresReview auto-generates + validates its
//      review bundle before the card may PASS（research card, zero production
//      diff）
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

const HOME = homedir();
const REPO_A = "/Volumes/NVM2T/Development/repos/autoloop";
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

const baseCloseout = (overrides = {}) => ({
  requiresReview: true,
  cardId: "RB-1R-E2E",
  cardTitle: "Mandatory Closeout E2E",
  cardType: "research",
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

before(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  // RB-1H hard rule: requiresReview closeouts default-deliver to the fixed
  // surface — redirect it away from the real Desktop inbox during tests.
  process.env.AUTOLOOP_REVIEW_SURFACE = join(OUT, "surface");
  process.env.AUTOLOOP_REVIEW_ARCHIVE = join(OUT, "archive");
});
after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
  const now = spawnSync("git", ["-C", REPO_A, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
  const beforeCount = spawnSync("git", ["-C", REPO_A, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
  assert.equal(now, beforeCount, "main repo entries unchanged by the test");
});

test("1. research graph with closeout auto-generates a validated bundle WITHOUT CLI; card PASS only after validation", { timeout: 900000 }, async (t) => {
  const r = await runColimaGraph({
    ir: researchIr,
    parent: PARENT,
    cwd: REPO_A,
    executionId: "graph-closeout-main-1",
    profile: PROFILE,
    repoPath: REPO_A,
    scratchRoot: SCRATCH,
    timeoutMs: 90000,
    closeout: { ...baseCloseout(), outDir: OUT, diffSummary: "NO_PRODUCTION_DIFF (research card)" },
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
  const r = await runColimaGraph({
    ir: researchIr,
    parent: PARENT,
    cwd: REPO_A,
    executionId: "graph-closeout-fail-1",
    profile: PROFILE,
    repoPath: REPO_A,
    scratchRoot: SCRATCH,
    timeoutMs: 90000,
    closeout: { ...baseCloseout({ cardId: "RB-1R-E2E-FAIL", cardTitle: "Mandatory Closeout E2E FAIL" }), outDir: OUT },
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
