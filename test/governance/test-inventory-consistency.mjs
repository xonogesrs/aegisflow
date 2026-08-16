// test/governance/test-inventory-consistency.mjs
//
// FM-3 — REVIEW BUNDLE INVENTORY CONSISTENCY（authorized / actually-touched /
// CARD_IMPLEMENTATION_FILES cross-check）.
//
// Three layers:
//   Layer 1 — pure unit tests on validateCardInventoryConsistency /
//             computeInventoryDelta（T1–T8 logic, no I/O）.
//   Layer 2 — bundle-parser tests: renderReviewBundle + writeReviewBundle +
//             validateReviewBundle over crafted sources carrying the
//             inventory model（CARD_INVENTORY_MODEL: delta-v1）.
//   Layer 3 — real scratch-git-repo end-to-end: captureBaselineInventory →
//             runMandatoryGraphCloseout → the gate re-derives authoritative
//             facts against the baseline and the validator fails/passes as
//             required（T1–T4, T6 + R5 non-retroactivity + dogfood pipeline）.
//
// Run: node --test test/governance/test-inventory-consistency.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_BUNDLE_SOURCE_SCHEMA,
  REVIEW_BUNDLE_HOLDS,
  renderReviewBundle,
  writeReviewBundle,
  validateReviewBundle,
  runMandatoryGraphCloseout,
  collectRepoFacts,
  captureBaselineInventory,
} from "../../src/governance/review-bundle.mjs";
import {
  CARD_INVENTORY_BASELINE_SCHEMA,
  CARD_INVENTORY_MODEL,
  computeInventoryDelta,
  validateCardInventoryConsistency,
} from "../../src/governance/card-inventory.mjs";

const REPO_A = "/Volumes/NVM2T/Development/autoloop";
const ROOT = `${tmpdir()}/fm3-inventory-${process.pid}`;
const OUT = join(ROOT, "out");

// ── Layer 2 helpers ────────────────────────────────────────────────────────
const facts = collectRepoFacts(REPO_A);
let n = 0;
function mkBundleSource(overrides = {}) {
  n += 1;
  return {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: { cardId: `FM3-TEST-${n}`, cardTitle: "Inventory Consistency Test", cardType: "implementation" },
    graph: { graphRunId: `fm3-inv-${n}` },
    repo: {
      repository: facts.repository ?? null,
      branch: facts.branch, head: facts.head, treeSha: facts.treeSha, worktreePath: facts.worktreePath,
      baselineDirtyDigest: "clean", finalDirtyDigest: "clean", remote: facts.remote,
    },
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: false, dirtyPaths: [], untrackedFiles: [], remote: facts.remote },
    objective: "inventory consistency validator",
    executiveStatus: "PASS",
    executiveSummary: "test",
    authorizedScope: [],
    unauthorizedScope: ["commit", "push"],
    designDecisions: [],
    files: { added: [], modified: [], deleted: [] },
    diffSummary: "test",
    execution: { testsExecuted: [], testResults: { passed: 1, failed: 0, total: 1 }, pass: true },
    verifier: { pass: true, result: "PASS", summary: "verify PASS" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "a".repeat(64), blockingFindings: [], summary: "review PASS" },
    repairAttempts: [],
    negativeCases: [],
    regression: [],
    evidence: [],
    security: { secretScanResult: "clean", ingestionAllowlist: [], ingestionDenylist: [] },
    risks: [], limitations: [],
    rollbackProcedure: "regen",
    openQuestions: [],
    recommendedNextStep: "next",
    ...overrides,
  };
}

function renderAndWrite(source, outDir = OUT) {
  const bundle = renderReviewBundle(source);
  const w = writeReviewBundle(bundle, outDir);
  return w.path;
}

// ── Layer 3 helpers（scratch repo）─────────────────────────────────────────
const REPO = join(tmpdir(), `fm3-inv-repo-${process.pid}`);
const REPO_CLEAN = join(tmpdir(), `fm3-inv-clean-repo-${process.pid}`);
const git = (args, opts = {}) => spawnSync("git", args, { cwd: REPO, encoding: "utf8", ...opts });
function putFile(p, content) {
  const full = join(REPO, p);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}
function putFileClean(p, content) {
  const full = join(REPO_CLEAN, p);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function makeGraph(executionId, nodeFiles = []) {
  return {
    executionId,
    final: "PASS",
    holdCode: null,
    reason: null,
    scheduler: { verdict: "PASS", order: ["W1"], statuses: { W1: "passed" }, skipped: [], writerViolations: [], leaseHolderAfter: null },
    nodeResults: [
      {
        nodeId: "W1", phaseExecutionId: `exec_${executionId}`, taskType: "write", dependencies: [],
        final: "PASS", attempt: 0, reason: null, startedAt: 1, completedAt: 2,
        worktreeIdentity: { verified: true, output: { files: nodeFiles } },
        cleanup: { worktreeRevoked: true },
        subagentResult: { status: "PASS", testResults: { passed: 1, failed: 0, total: 1 }, testsExecuted: ["self-test"] },
        reviewResult: { status: "PASS", findings: [], blockingFindings: [], scopeVerified: true, testsVerified: true, recommendedAction: "PASS", summary: "review PASS" },
      },
    ],
    transitions: [
      { phaseId: "W1", final: "PASS", attempt: 0, lifecycleTransitions: [{ phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" }] },
    ],
  };
}

let _surfaceSeq = 0;
function closeoutFor(overrides = {}) {
  return {
    requiresReview: true,
    cardId: "FM3-E2E",
    cardTitle: "FM-3 inventory e2e",
    cardType: "repair",
    objective: "scratch repo inventory consistency",
    authorizedScope: ["a.txt", "b.txt", "package.json"],
    unauthorizedScope: ["commit", "push"],
    designDecisions: ["baseline delta model"],
    negativeCases: [],
    regression: [],
    cardFiles: { cardImplementation: [], closeoutOutputs: [], preExistingDirty: [] },
    surfaceDir: join(ROOT, "surface", `run-${_surfaceSeq++}`),
    ...overrides,
  };
}

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  // scratch git repo: committed baseline tree（a.txt / b.txt / package.json）
  mkdirSync(REPO, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  git(["config", "core.quotepath", "false"]);
  putFile("a.txt", "a1\n");
  putFile("b.txt", "b1\n");
  putFile("package.json", "{\"v\":1}\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  // isolate the external-review surface（never touch the real Current/）.
  process.env.AUTOLOOP_REVIEW_SURFACE = join(ROOT, "surface-env");
  process.env.AUTOLOOP_REVIEW_ARCHIVE = join(ROOT, "archive-env");
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(REPO, { recursive: true, force: true });
  rmSync(REPO_CLEAN, { recursive: true, force: true });
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
});

// ══════════════════════════════════════════════════════════════════════════
// Layer 1 — pure invariant checks
// ══════════════════════════════════════════════════════════════════════════

test("T1 (pure): authorized + actually-touched + missing from implementation inventory fails", () => {
  const r = validateCardInventoryConsistency({
    authorizedPaths: ["package.json", "src/a.mjs"],
    implementationPaths: ["src/a.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["package.json", "src/a.mjs"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("inventory_missing_implementation:package.json"), JSON.stringify(r.errors));
});

test("T2 (pure): complete implementation inventory passes", () => {
  const r = validateCardInventoryConsistency({
    authorizedPaths: ["package.json", "src/a.mjs"],
    implementationPaths: ["package.json", "src/a.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["package.json", "src/a.mjs"],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("T3 (pure): pre-existing dirty path is never required in the current-card inventory", () => {
  // package.json was already dirty at card START（baseline）; it is still
  // dirty at closeout and authorized — but it is NOT a current-card change,
  // so it must NOT be demanded in CARD_IMPLEMENTATION_FILES.
  const r = validateCardInventoryConsistency({
    authorizedPaths: ["package.json", "src/a.mjs"],
    implementationPaths: ["src/a.mjs"],
    baselinePaths: ["package.json"],
    finalDirtyPaths: ["package.json", "src/a.mjs"],
    preExistingDirtyPaths: ["package.json"],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("T4 (pure): unauthorized touched implementation fails closed; adding it to the inventory cannot bypass", () => {
  const r1 = validateCardInventoryConsistency({
    authorizedPaths: ["src/a.mjs"],
    implementationPaths: ["src/a.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["src/a.mjs", "src/unauthorized.mjs"],
  });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.includes("inventory_unauthorized_touched:src/unauthorized.mjs"), JSON.stringify(r1.errors));
  // declaring it in CARD_IMPLEMENTATION_FILES does NOT bypass the scope gate
  const r2 = validateCardInventoryConsistency({
    authorizedPaths: ["src/a.mjs"],
    implementationPaths: ["src/a.mjs", "src/unauthorized.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["src/a.mjs", "src/unauthorized.mjs"],
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.includes("inventory_unauthorized_implementation:src/unauthorized.mjs"), JSON.stringify(r2.errors));
});

test("T5 (pure): authorized but untouched is not required", () => {
  const r = validateCardInventoryConsistency({
    authorizedPaths: ["src/a.mjs", "src/b.mjs"],
    implementationPaths: ["src/a.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["src/a.mjs"],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("T6 (pure): closeout artifacts are not forced into the implementation inventory", () => {
  const r = validateCardInventoryConsistency({
    authorizedPaths: ["src/a.mjs"],
    implementationPaths: ["src/a.mjs"],
    closeoutOutputPaths: ["docs/pi-graph-output/fm3/evidence.json", "test/governance/test-x.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["src/a.mjs", "docs/pi-graph-output/fm3/evidence.json", "test/governance/test-x.mjs"],
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("T7 (pure): multiple files with one missing — validator reports the exact missing path", () => {
  const r = validateCardInventoryConsistency({
    authorizedPaths: ["src/a.mjs", "src/b.mjs", "src/c.mjs"],
    implementationPaths: ["src/a.mjs", "src/c.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["src/a.mjs", "src/b.mjs", "src/c.mjs"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("inventory_missing_implementation:src/b.mjs"), JSON.stringify(r.errors));
  assert.ok(!r.errors.some((e) => e.includes(":src/a.mjs") || e.includes(":src/c.mjs")), "only the missing path reported");
});

test("T8 (pure): rename/deleted provenance — rename source cannot be lost; deleted authorized file must be accounted", () => {
  // rename: porcelain keeps BOTH source + destination in the dirty set;
  // declaring only the new path loses the source provenance -> fail on source
  const r1 = validateCardInventoryConsistency({
    authorizedPaths: ["old-name.mjs", "new-name.mjs"],
    implementationPaths: ["new-name.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["old-name.mjs", "new-name.mjs"],
  });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.includes("inventory_missing_implementation:old-name.mjs"), JSON.stringify(r1.errors));
  // declaring both source + destination accounts the rename
  const r2 = validateCardInventoryConsistency({
    authorizedPaths: ["old-name.mjs", "new-name.mjs"],
    implementationPaths: ["old-name.mjs", "new-name.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["old-name.mjs", "new-name.mjs"],
  });
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  // deleted authorized file: accounted via implementation inventory OR the
  // worktree-derived DELETED list
  const r3 = validateCardInventoryConsistency({
    authorizedPaths: ["src/gone.mjs"],
    implementationPaths: [],
    deletedPaths: ["src/gone.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["src/gone.mjs"],
  });
  assert.equal(r3.ok, true, JSON.stringify(r3.errors));
  const r4 = validateCardInventoryConsistency({
    authorizedPaths: ["src/gone.mjs"],
    implementationPaths: [],
    deletedPaths: [],
    baselinePaths: [],
    finalDirtyPaths: ["src/gone.mjs"],
  });
  assert.equal(r4.ok, false);
  assert.ok(r4.errors.includes("inventory_missing_implementation:src/gone.mjs"), JSON.stringify(r4.errors));
});

test("R2 (pure): structured authorization exception admits an out-of-scope path; free-text alone does not", () => {
  const withException = validateCardInventoryConsistency({
    authorizedPaths: ["src/a.mjs"],
    implementationPaths: ["src/a.mjs", "src/outside.mjs"],
    exceptions: [{ path: "src/outside.mjs", reason: "minimal helper permitted by card scope" }],
    baselinePaths: [],
    finalDirtyPaths: ["src/a.mjs", "src/outside.mjs"],
  });
  assert.equal(withException.ok, true, JSON.stringify(withException.errors));
  const noException = validateCardInventoryConsistency({
    authorizedPaths: ["src/a.mjs"],
    implementationPaths: ["src/a.mjs", "src/outside.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["src/a.mjs", "src/outside.mjs"],
  });
  assert.equal(noException.ok, false);
  assert.ok(noException.errors.includes("inventory_unauthorized_implementation:src/outside.mjs"), JSON.stringify(noException.errors));
});

test("C3 (pure): declared pre-existing path not present in the baseline fails (reliable provenance)", () => {
  const r = validateCardInventoryConsistency({
    authorizedPaths: [],
    implementationPaths: [],
    preExistingDirtyPaths: ["src/fake-pre-existing.mjs"],
    baselinePaths: [],
    finalDirtyPaths: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("inventory_pre_existing_not_in_baseline:src/fake-pre-existing.mjs"), JSON.stringify(r.errors));
});

test("C4 (pure): a path cannot be both implementation file and closeout output", () => {
  const r = validateCardInventoryConsistency({
    authorizedPaths: ["src/a.mjs"],
    implementationPaths: ["src/a.mjs"],
    closeoutOutputPaths: ["src/a.mjs"],
    baselinePaths: [],
    finalDirtyPaths: ["src/a.mjs"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("inventory_classification_overlap:src/a.mjs"), JSON.stringify(r.errors));
});

test("C5 (pure): declared delta must equal the recomputed delta (single repo-diff truth)", () => {
  const r = validateCardInventoryConsistency({
    authorizedPaths: [],
    implementationPaths: [],
    baselinePaths: ["src/pre.mjs"],
    finalDirtyPaths: ["src/pre.mjs", "src/a.mjs"],
    deltaPaths: ["src/pre.mjs"], // wrong: recomputed delta is [src/a.mjs]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("inventory_delta_mismatch:declared_vs_recomputed"), JSON.stringify(r.errors));
});

test("computeInventoryDelta: baseline excludes pre-existing paths; dedupe + order preserved", () => {
  const d = computeInventoryDelta({ baselinePaths: ["b", "a", "a"], finalDirtyPaths: ["c", "a", "b", "d"] });
  assert.deepEqual(d.deltaPaths, ["c", "d"]);
  assert.deepEqual(d.baselinePaths, ["b", "a"]);
});

// ══════════════════════════════════════════════════════════════════════════
// Layer 2 — bundle parser / validator over crafted sources
// ══════════════════════════════════════════════════════════════════════════

test("T1 (bundle): package.json authorized + touched but missing from implementation -> VALIDATION FAIL", () => {
  const src = mkBundleSource({
    authorizedScope: ["package.json", "src/a.mjs"],
    inventory: {
      model: CARD_INVENTORY_MODEL,
      baseline: { head: facts.head, treeSha: facts.treeSha, dirtyDigest: "clean", dirtyPaths: [] },
      deltaPaths: ["package.json", "src/a.mjs"],
    },
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: false, dirtyPaths: ["package.json", "src/a.mjs"], untrackedFiles: [], remote: facts.remote },
    files: { cardImplementation: ["src/a.mjs"], closeoutOutputs: [], preExistingDirty: [], added: [], modified: [], deleted: [] },
  });
  const p = renderAndWrite(src);
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, false, "VALIDATION FAIL");
  assert.equal(v.holdCode, REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT);
  assert.ok(v.errors.some((e) => e.includes("inventory_missing_implementation:package.json")), JSON.stringify(v.errors));
});

test("T2 (bundle): correct implementation inventory validates PASS", () => {
  const src = mkBundleSource({
    authorizedScope: ["package.json", "src/a.mjs"],
    inventory: {
      model: CARD_INVENTORY_MODEL,
      baseline: { head: facts.head, treeSha: facts.treeSha, dirtyDigest: "clean", dirtyPaths: [] },
      deltaPaths: ["package.json", "src/a.mjs"],
    },
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: false, dirtyPaths: ["package.json", "src/a.mjs"], untrackedFiles: [], remote: facts.remote },
    files: { cardImplementation: ["package.json", "src/a.mjs"], closeoutOutputs: [], preExistingDirty: [], added: [], modified: [], deleted: [] },
  });
  const p = renderAndWrite(src);
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("R5 (bundle): bundle WITHOUT the inventory model still validates (non-retroactive)", () => {
  const src = mkBundleSource({
    authorizedScope: ["package.json"],
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: false, dirtyPaths: ["package.json"], untrackedFiles: [], remote: facts.remote },
    files: { added: [], modified: [], deleted: [] },
  });
  const p = renderAndWrite(src);
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const txt = readFileSync(p, "utf8");
  assert.ok(!txt.includes("CARD_INVENTORY_MODEL"), "no inventory marker on legacy-shaped bundle");
});

test("inventory (bundle): baseline digest cross-check — section 4 vs section 9 mismatch fails closed", () => {
  const src = mkBundleSource({
    inventory: {
      model: CARD_INVENTORY_MODEL,
      baseline: { head: facts.head, treeSha: facts.treeSha, dirtyDigest: "dirty:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", dirtyPaths: [] },
      deltaPaths: [],
    },
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: true, dirtyPaths: [], untrackedFiles: [], remote: facts.remote },
    files: { added: [], modified: [], deleted: [] },
  });
  const p = renderAndWrite(src);
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("inventory_baseline_digest_mismatch")), JSON.stringify(v.errors));
});

test("inventory (bundle): baseline HEAD is a recorded card-start FACT — divergence from the bundle HEAD is legitimate (model v2); malformed head fails", () => {
  // Baseline captured at a different HEAD than the bundle generation HEAD is
  // the NORMAL committed-before-baseline / post-baseline-evidence shape.
  const src = mkBundleSource({
    inventory: {
      model: CARD_INVENTORY_MODEL,
      baseline: { head: "0".repeat(40), treeSha: facts.treeSha, dirtyDigest: "clean", dirtyPaths: [] },
      deltaPaths: [],
    },
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: true, dirtyPaths: [], untrackedFiles: [], remote: facts.remote },
    files: { added: [], modified: [], deleted: [] },
  });
  const p = renderAndWrite(src);
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  // A MALFORMED baseline head (not 40-hex) still fails closed.
  const bad = mkBundleSource({
    inventory: {
      model: CARD_INVENTORY_MODEL,
      baseline: { head: "not-a-sha", treeSha: facts.treeSha, dirtyDigest: "clean", dirtyPaths: [] },
      deltaPaths: [],
    },
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: true, dirtyPaths: [], untrackedFiles: [], remote: facts.remote },
    files: { added: [], modified: [], deleted: [] },
  });
  const v2 = validateReviewBundle(renderAndWrite(bad), { authorizedDir: OUT });
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.includes("inventory_baseline_head_malformed")), JSON.stringify(v2.errors));
});

test("R2 (bundle): structured AUTHORIZATION_EXCEPTIONS render and admit an out-of-scope path; absent exception fails", () => {
  const src = mkBundleSource({
    authorizedScope: ["src/a.mjs"],
    authorizationExceptions: [{ path: "src/outside.mjs", reason: "minimal helper permitted by card scope" }],
    inventory: {
      model: CARD_INVENTORY_MODEL,
      baseline: { head: facts.head, treeSha: facts.treeSha, dirtyDigest: "clean", dirtyPaths: [] },
      deltaPaths: ["src/a.mjs", "src/outside.mjs"],
    },
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: false, dirtyPaths: ["src/a.mjs", "src/outside.mjs"], untrackedFiles: [], remote: facts.remote },
    files: { cardImplementation: ["src/a.mjs", "src/outside.mjs"], closeoutOutputs: [], preExistingDirty: [], added: [], modified: [], deleted: [] },
  });
  const p = renderAndWrite(src);
  const txt = readFileSync(p, "utf8");
  assert.ok(txt.includes("AUTHORIZATION_EXCEPTIONS:"), "exceptions rendered");
  assert.ok(txt.includes("src/outside.mjs :: minimal helper permitted by card scope"), "structured exception with reason");
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, true, JSON.stringify(v.errors));

  const src2 = mkBundleSource({
    authorizedScope: ["src/a.mjs"],
    inventory: {
      model: CARD_INVENTORY_MODEL,
      baseline: { head: facts.head, treeSha: facts.treeSha, dirtyDigest: "clean", dirtyPaths: [] },
      deltaPaths: ["src/a.mjs", "src/outside.mjs"],
    },
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: false, dirtyPaths: ["src/a.mjs", "src/outside.mjs"], untrackedFiles: [], remote: facts.remote },
    files: { cardImplementation: ["src/a.mjs", "src/outside.mjs"], closeoutOutputs: [], preExistingDirty: [], added: [], modified: [], deleted: [] },
  });
  const p2 = renderAndWrite(src2);
  const v2 = validateReviewBundle(p2, { authorizedDir: OUT });
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.includes("inventory_unauthorized_implementation:src/outside.mjs")), JSON.stringify(v2.errors));
});

test("T6 (bundle): closeout outputs declared in GRAPH_CLOSEOUT_OUTPUTS are not missing implementation files", () => {
  const src = mkBundleSource({
    authorizedScope: ["src/a.mjs"],
    inventory: {
      model: CARD_INVENTORY_MODEL,
      baseline: { head: facts.head, treeSha: facts.treeSha, dirtyDigest: "clean", dirtyPaths: [] },
      deltaPaths: ["src/a.mjs", "docs/pi-graph-output/fm3/evidence.json"],
    },
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: false, dirtyPaths: ["src/a.mjs", "docs/pi-graph-output/fm3/evidence.json"], untrackedFiles: [], remote: facts.remote },
    files: { cardImplementation: ["src/a.mjs"], closeoutOutputs: ["docs/pi-graph-output/fm3/evidence.json"], preExistingDirty: [], added: [], modified: [], deleted: [] },
  });
  const p = renderAndWrite(src);
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("C5 (bundle): declared CURRENT_CARD_DELTA_PATHS mismatch fails closed", () => {
  const src = mkBundleSource({
    authorizedScope: ["src/a.mjs"],
    inventory: {
      model: CARD_INVENTORY_MODEL,
      baseline: { head: facts.head, treeSha: facts.treeSha, dirtyDigest: "clean", dirtyPaths: [] },
      deltaPaths: ["src/a.mjs", "docs/sneaky.mjs"], // sneaky path not in final dirty
    },
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: false, dirtyPaths: ["src/a.mjs"], untrackedFiles: [], remote: facts.remote },
    files: { cardImplementation: ["src/a.mjs"], closeoutOutputs: [], preExistingDirty: [], added: [], modified: [], deleted: [] },
  });
  const p = renderAndWrite(src);
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("inventory_delta_mismatch:declared_vs_recomputed")), JSON.stringify(v.errors));
});

// ══════════════════════════════════════════════════════════════════════════
// Layer 3 — real scratch-git-repo end-to-end（full closeout pipeline）
// ══════════════════════════════════════════════════════════════════════════

test("T1 (e2e): package.json gap reproduced on a real repo — closeout HOLDs with the exact missing path", { timeout: 30000 }, async () => {
  const baseline = captureBaselineInventory(REPO, { cardId: "FM3-E2E-T1" });
  assert.equal(baseline.schema, CARD_INVENTORY_BASELINE_SCHEMA);
  assert.equal(baseline.dirtyDigest, "clean");
  // the card touches package.json（authorized）but the implementation
  // inventory deliberately omits it — the DE-2R instance.
  putFile("package.json", "{\"v\":2}\n");
  const closeout = closeoutFor({
    cardId: "FM3-E2E-T1",
    authorizedScope: ["package.json", "a.txt"],
    cardFiles: { cardImplementation: [], closeoutOutputs: [], preExistingDirty: [] },
    baseline,
    outDir: join(ROOT, "t1-out"),
  });
  const r = await runMandatoryGraphCloseout({ graphResult: makeGraph("fm3-e2e-t1"), closeout, repoPath: REPO, outDir: closeout.outDir });
  assert.equal(r.final, "HOLD", "VALIDATION FAIL");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT);
  assert.ok(String(r.reason ?? "").includes("inventory_missing_implementation:package.json"), String(r.reason));
});

test("T2 (e2e): correct implementation inventory on a real repo closes PASS", { timeout: 30000 }, async () => {
  const baseline = captureBaselineInventory(REPO, { cardId: "FM3-E2E-T2" });
  putFile("package.json", "{\"v\":3}\n");
  const closeout = closeoutFor({
    cardId: "FM3-E2E-T2",
    authorizedScope: ["package.json", "a.txt"],
    cardFiles: { cardImplementation: ["package.json"], closeoutOutputs: [], preExistingDirty: [] },
    baseline,
    outDir: join(ROOT, "t2-out"),
  });
  const r = await runMandatoryGraphCloseout({ graphResult: makeGraph("fm3-e2e-t2"), closeout, repoPath: REPO, outDir: closeout.outDir });
  assert.equal(r.final, "PASS", `final PASS (${r.reason})`);
  const txt = readFileSync(r.bundlePath, "utf8");
  assert.ok(txt.includes("CARD_INVENTORY_MODEL: delta-v1"), "inventory model rendered");
  assert.ok(txt.includes("BASELINE_DIRTY_PATHS:"), "baseline block rendered");
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: closeout.outDir });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("T2b (e2e): a GENUINELY clean baseline（dirtyPaths=[] / digest `clean`）still validates (digest cross-check must not false-fail)", { timeout: 30000 }, async () => {
  // dedicated repo: stays clean until this card's own touch
  mkdirSync(REPO_CLEAN, { recursive: true });
  const cg = (args) => spawnSync("git", args, { cwd: REPO_CLEAN, encoding: "utf8" });
  cg(["init", "-q"]);
  cg(["config", "user.email", "t@t"]);
  cg(["config", "user.name", "t"]);
  cg(["config", "core.quotepath", "false"]);
  putFileClean("a.txt", "a1\n");
  putFileClean("package.json", "{\"v\":1}\n");
  cg(["add", "-A"]);
  cg(["commit", "-qm", "init"]);
  const baseline = captureBaselineInventory(REPO_CLEAN, { cardId: "FM3-E2E-T2B" });
  assert.equal(baseline.dirtyDigest, "clean", "baseline is genuinely clean");
  putFileClean("package.json", "{\"v\":2}\n");
  const closeout = closeoutFor({
    cardId: "FM3-E2E-T2B",
    authorizedScope: ["package.json"],
    cardFiles: { cardImplementation: ["package.json"], closeoutOutputs: [], preExistingDirty: [] },
    baseline,
    outDir: join(ROOT, "t2b-out"),
  });
  const r = await runMandatoryGraphCloseout({ graphResult: makeGraph("fm3-e2e-t2b"), closeout, repoPath: REPO_CLEAN, outDir: closeout.outDir });
  assert.equal(r.final, "PASS", `clean-baseline PASS (${r.reason})`);
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: closeout.outDir });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("T3 (e2e): pre-existing dirty path（in baseline）is never demanded, even though authorized + still dirty", { timeout: 30000 }, async () => {
  // b.txt is ALREADY dirty before the card starts（pre-existing dirty）.
  putFile("b.txt", "pre-existing dirty\n");
  const baseline = captureBaselineInventory(REPO, { cardId: "FM3-E2E-T3" });
  assert.ok(baseline.dirtyPaths.includes("b.txt"), "baseline captured the pre-existing dirty path");
  // the card touches ONLY a.txt（authorized; b.txt is authorized but untouched
  // by THIS card）.
  putFile("a.txt", "card change\n");
  const closeout = closeoutFor({
    cardId: "FM3-E2E-T3",
    authorizedScope: ["a.txt", "b.txt"],
    cardFiles: { cardImplementation: ["a.txt"], closeoutOutputs: [], preExistingDirty: [] },
    baseline,
    outDir: join(ROOT, "t3-out"),
  });
  const r = await runMandatoryGraphCloseout({ graphResult: makeGraph("fm3-e2e-t3"), closeout, repoPath: REPO, outDir: closeout.outDir });
  assert.equal(r.final, "PASS", `PASS despite pre-existing dirty b.txt (${r.reason})`);
  const txt = readFileSync(r.bundlePath, "utf8");
  const dirtyLine = (txt.split("\n").find((l) => l.startsWith("DIRTY_PATHS:")) ?? "");
  assert.ok(dirtyLine.includes("b.txt"), `final dirty still lists b.txt (${dirtyLine})`);
  assert.ok(!txt.split("CARD_IMPLEMENTATION_FILES:")[1].split("GRAPH_CLOSEOUT_OUTPUTS:")[0].includes("b.txt"), "b.txt NOT in implementation inventory");
  // and the bundle explicitly documents b.txt as pre-existing（baseline）.
  assert.ok(txt.split("PRE_EXISTING_DIRTY_FILES:")[1].split("ADDED:")[0].includes("b.txt"), "b.txt documented as pre-existing");
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: closeout.outDir });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("T4 (e2e): unauthorized touched implementation fails closed", { timeout: 30000 }, async () => {
  const baseline = captureBaselineInventory(REPO, { cardId: "FM3-E2E-T4" });
  putFile("a.txt", "card change t4\n");
  putFile("u.txt", "unauthorized touch\n"); // outside authorized scope
  const closeout = closeoutFor({
    cardId: "FM3-E2E-T4",
    authorizedScope: ["a.txt"],
    cardFiles: { cardImplementation: ["a.txt"], closeoutOutputs: [], preExistingDirty: [] },
    baseline,
    outDir: join(ROOT, "t4-out"),
  });
  const r = await runMandatoryGraphCloseout({ graphResult: makeGraph("fm3-e2e-t4"), closeout, repoPath: REPO, outDir: closeout.outDir });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT);
  assert.ok(String(r.reason ?? "").includes("inventory_unauthorized_touched:u.txt"), String(r.reason));
});

test("T6 (e2e): closeout outputs（in-repo evidence）are classified, not forced into implementation", { timeout: 30000 }, async () => {
  const baseline = captureBaselineInventory(REPO, { cardId: "FM3-E2E-T6" });
  putFile("a.txt", "card change t6\n");
  // an in-repo closeout artifact（evidence）— declared as GRAPH_CLOSEOUT_OUTPUTS
  putFile("docs/fm3-e2e/evidence.json", "{}\n");
  const closeout = closeoutFor({
    cardId: "FM3-E2E-T6",
    authorizedScope: ["a.txt"],
    cardFiles: { cardImplementation: ["a.txt"], closeoutOutputs: ["docs/fm3-e2e/evidence.json"], preExistingDirty: [] },
    baseline,
    outDir: join(ROOT, "t6-out"),
  });
  const r = await runMandatoryGraphCloseout({ graphResult: makeGraph("fm3-e2e-t6"), closeout, repoPath: REPO, outDir: closeout.outDir });
  assert.equal(r.final, "PASS", `PASS (${r.reason})`);
  const txt = readFileSync(r.bundlePath, "utf8");
  const sec9 = txt.split("9. Files Added / Modified / Deleted")[1].split("10. Diff Summary")[0];
  assert.ok(sec9.includes("CARD_IMPLEMENTATION_FILES:") && sec9.includes("GRAPH_CLOSEOUT_OUTPUTS:") && sec9.includes("PRE_EXISTING_DIRTY_FILES:"), "categories rendered");
  assert.ok(sec9.split("GRAPH_CLOSEOUT_OUTPUTS:")[1].split("PRE_EXISTING_DIRTY_FILES:")[0].includes("docs/fm3-e2e/evidence.json"), "evidence classified as closeout output");
  assert.ok(!sec9.split("CARD_IMPLEMENTATION_FILES:")[1].split("GRAPH_CLOSEOUT_OUTPUTS:")[0].includes("evidence.json"), "evidence NOT forced into implementation");
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: closeout.outDir });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test("R5 (e2e): a requiresReview card WITHOUT a captured baseline keeps legacy behavior (no inventory checks)", { timeout: 30000 }, async () => {
  putFile("a.txt", "legacy card change\n");
  const closeout = closeoutFor({
    cardId: "FM3-E2E-R5",
    authorizedScope: ["a.txt"],
    cardFiles: { cardImplementation: ["a.txt"], closeoutOutputs: [], preExistingDirty: [] },
    // NOTE: no baseline — legacy-shaped closeout（report-lifecycle-repair-1 style）
    outDir: join(ROOT, "t5-out"),
  });
  const r = await runMandatoryGraphCloseout({ graphResult: makeGraph("fm3-e2e-r5"), closeout, repoPath: REPO, outDir: closeout.outDir });
  assert.equal(r.final, "PASS", `legacy closeout still PASSes (${r.reason})`);
  const txt = readFileSync(r.bundlePath, "utf8");
  assert.ok(!txt.includes("CARD_INVENTORY_MODEL"), "no inventory marker without a baseline — R5 non-retroactive");
});
