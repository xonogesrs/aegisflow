// test/governance/test-bundle-authority.mjs
//
// VCA-1 W1A (S9) — one authoritative review bundle per generation.
//
// Acceptance criterion H: an unchanged generation no longer produces
// multiple authoritative bundles. Proves:
//   1. generationKeyFromBundleText parses cardId + supersede target;
//   2. scanAuthoritativeBundles lists authoritative bundles（skips
//      .superseded/）;
//   3. a same-generation re-closeout is IDEMPOTENT — exactly one
//      authoritative bundle remains（alreadyApplied, no second render）;
//   4. repair / supersede generations are the explicit exception and MAY
//      produce a second authoritative bundle;
//   5. regenerateAuthoritative retires the same-generation bundle to
//      .superseded/ before re-rendering — still exactly one authoritative
//      bundle in the outDir root.
//
// Run: node --test test/governance/test-bundle-authority.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runMandatoryGraphCloseout,
  generationKeyFromBundleText,
  scanAuthoritativeBundles,
  assertAuthoritativeBundle,
  retireAuthoritativeBundles,
  BUNDLE_AUTHORITY_HOLDS,
} from "../../src/governance/review-bundle.mjs";

const REPO = "/Volumes/NVM2T/Development/autoloop";

// ── passing graph fixture（shape matches runColimaGraph / test-graph-closeout）──
function passGraph(executionId) {
  return {
    executionId,
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
        phaseExecutionId: `exec_${executionId}_r1`,
        taskType: "count_todos",
        dependencies: [],
        final: "PASS",
        attempt: 0,
        reason: null,
        startedAt: null, // S10: UNKNOWN timing — never fabricated
        completedAt: null,
        cleanup: { worktreeRevoked: false },
        subagentResult: { status: "PASS", testResults: null, testsExecuted: [] },
      },
      {
        nodeId: "W1",
        phaseExecutionId: `exec_${executionId}_w1`,
        taskType: "write_report",
        dependencies: ["R1"],
        final: "PASS",
        attempt: 0,
        reason: null,
        startedAt: null,
        completedAt: null,
        worktreeIdentity: { verified: true, output: { files: [] } },
        cleanup: { worktreeRevoked: true },
        subagentResult: { status: "PASS", testResults: { passed: 1, failed: 0, total: 1 }, testsExecuted: [] },
        reviewResult: {
          schema_version: "autoloop.subagent.review-result/v1",
          status: "PASS",
          outputSchemaIdentity: "autoloop.subagent.review-result/v1",
          findings: [],
          blockingFindings: [],
          nonBlockingFindings: [],
          scopeVerified: true,
          testsVerified: true,
          recommendedAction: "PASS",
          summary: "independent review PASS",
        },
      },
      {
        nodeId: "V1",
        phaseExecutionId: `exec_${executionId}_v1`,
        taskType: "verify_writer",
        dependencies: ["W1"],
        final: "PASS",
        attempt: 0,
        reason: null,
        startedAt: null,
        completedAt: null,
        cleanup: { worktreeRevoked: false },
        subagentResult: { status: "PASS", testResults: { passed: 1, failed: 0, total: 1 }, testsExecuted: [] },
      },
    ],
    transitions: [],
  };
}

function closeoutOpts(outDir, overrides = {}) {
  return {
    requiresReview: true,
    cardId: "VCA1-S9-TEST",
    cardTitle: "Bundle Authority Test",
    cardType: "implementation",
    objective: "one authoritative bundle per generation",
    authorizedScope: ["src/governance/review-bundle.mjs"],
    unauthorizedScope: ["commit", "push", "merge", "seal"],
    designDecisions: [],
    negativeCases: [],
    regression: [{ suite: "test:governance", tests: 1, pass: 1, fail: 0 }],
    regressionSummary: "focused tests pass",
    recommendedNextStep: "none",
    outDir,
    ...overrides,
  };
}

const run = (outDir, graph, overrides = {}, surfaceDir = null) => runMandatoryGraphCloseout({
  graphResult: graph,
  closeout: closeoutOpts(outDir, {
    ...(overrides.closeout ?? {}),
    // RB-1H: an un-rotated published trio is never overwritten — each
    // closeout run gets its own isolated surface.
    surfaceDir: surfaceDir ?? join(SURFACE_ROOT, `run-${runSeq++}`),
  }),
  repoPath: REPO,
  cwd: REPO,
  outDir,
  timeoutMs: 60000,
});

const bundlesIn = (dir) => readdirSync(dir).filter((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt") && !f.includes(".superseded.")).sort();
const supersededIn = (dir) => {
  const d = join(dir, ".superseded");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".txt")).sort() : [];
};

// Per-run isolated review surfaces（RB-1H）.
let runSeq = 0;
const SURFACE_ROOT = mkdtempSync(join(tmpdir(), "vca1-s9-surface-"));
process.env.AUTOLOOP_REVIEW_SURFACE = join(SURFACE_ROOT, "current");
process.env.AUTOLOOP_REVIEW_ARCHIVE = join(SURFACE_ROOT, "archive");

test("S9/1: generationKeyFromBundleText parses cardId + supersede target", () => {
  const key = generationKeyFromBundleText(
    "CARD_ID: VCA1-S9-TEST\nREVIEW_BUNDLE_IDENTITY: " + "a".repeat(64) +
    "\nSUPERSEDES_BUNDLE_IDENTITY: " + "b".repeat(64) + "\nGENERATION_TYPE: surface-reseal\n",
  );
  assert.equal(key.cardId, "VCA1-S9-TEST");
  assert.equal(key.identity, "a".repeat(64));
  assert.equal(key.supersededIdentity, "b".repeat(64));
  assert.equal(key.generationType, "surface-reseal");
  const first = generationKeyFromBundleText("CARD_ID: X\nREVIEW_BUNDLE_IDENTITY: " + "c".repeat(64) + "\n");
  assert.equal(first.supersededIdentity, null);
});

test("S9/2: scanAuthoritativeBundles ignores .superseded/ entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "vca1-s9-scan-"));
  try {
    mkdirSync(join(dir, ".superseded"), { recursive: true });
    writeFileSync(join(dir, "card-closeout-bundle-20260809-aaaaaaaa.txt"), "CARD_ID: VCA1-S9-TEST\nREVIEW_BUNDLE_IDENTITY: " + "a".repeat(64) + "\n");
    writeFileSync(join(dir, ".superseded", "card-closeout-bundle-20260808-bbbbbbbb.txt"), "CARD_ID: VCA1-S9-TEST\nREVIEW_BUNDLE_IDENTITY: " + "b".repeat(64) + "\n");
    const all = scanAuthoritativeBundles(dir);
    assert.equal(all.length, 1);
    assert.equal(all[0].fileName, "card-closeout-bundle-20260809-aaaaaaaa.txt");
    const filtered = scanAuthoritativeBundles(dir, { cardId: "OTHER" });
    assert.equal(filtered.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S9/3: assertAuthoritativeBundle blocks a same-generation duplicate", () => {
  const dir = mkdtempSync(join(tmpdir(), "vca1-s9-pure-"));
  try {
    writeFileSync(join(dir, "card-closeout-bundle-20260809-aaaaaaaa.txt"),
      "CARD_ID: VCA1-S9-TEST\nREVIEW_BUNDLE_IDENTITY: " + "a".repeat(64) + "\n");
    const r = assertAuthoritativeBundle({ outDir: dir, cardId: "VCA1-S9-TEST", supersedes: null });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, BUNDLE_AUTHORITY_HOLDS.ALREADY_AUTHORITATIVE);
    assert.equal(r.sameGeneration.length, 1);
    // a DIFFERENT supersede target（repair generation）is allowed
    const repair = assertAuthoritativeBundle({ outDir: dir, cardId: "VCA1-S9-TEST", supersedes: { reviewBundleIdentity: "b".repeat(64) } });
    assert.equal(repair.ok, true);
    // explicit regenerate is allowed and retires the same-generation bundle
    const regen = assertAuthoritativeBundle({ outDir: dir, cardId: "VCA1-S9-TEST", supersedes: null, allowRegenerate: true });
    assert.equal(regen.ok, true);
    assert.equal(regen.retire.length, 1);
    retireAuthoritativeBundles(dir, regen.retire);
    assert.equal(bundlesIn(dir).length, 0);
    assert.equal(supersededIn(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S9/4: unchanged generation closeout keeps exactly ONE authoritative bundle", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "vca1-s9-e2e-"));
  try {
    const first = await run(outDir, passGraph("vca1-s9-gen1"));
    assert.equal(first.final, "PASS", `first closeout PASS (${first.reason})`);
    assert.equal(bundlesIn(outDir).length, 1, "first generation -> 1 bundle");

    // identical same-generation re-closeout（same graph -> same deterministic
    // identity -> same file overwritten; no second authoritative bundle）.
    const second = await run(outDir, passGraph("vca1-s9-gen1"));
    assert.equal(second.final, "PASS");
    assert.equal(second.bundle.identity, first.bundle.identity, "same generation -> same bundle identity");
    assert.equal(bundlesIn(outDir).length, 1, "still exactly 1 authoritative bundle");
    assert.equal(supersededIn(outDir).length, 0, "identical re-run overwrites in place, nothing to retire");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("S9/5: a repair/supersede generation may add an authoritative bundle", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "vca1-s9-repair-"));
  try {
    const first = await run(outDir, passGraph("vca1-s9-repair-gen1"));
    assert.equal(first.final, "PASS");
    const firstBundle = scanAuthoritativeBundles(outDir, { cardId: "VCA1-S9-TEST" })[0];
    assert.ok(firstBundle, "first bundle exists");

    const second = await run(outDir, passGraph("vca1-s9-repair-gen2"), {
      closeout: {
        supersedes: { reviewBundleIdentity: firstBundle.identity, reviewBundleSha256: "00".repeat(32), bundlePath: firstBundle.path, verdict: "HOLD" },
      },
    });
    assert.equal(second.final, "PASS", `repair generation closeout PASS (${second.reason})`);
    assert.notEqual(second.alreadyApplied, true, "supersede generation is NOT idempotent");
    assert.equal(bundlesIn(outDir).length, 2, "supersede chain: 2 authoritative bundles");
    const keys = scanAuthoritativeBundles(outDir, { cardId: "VCA1-S9-TEST" });
    const superseder = keys.find((k) => k.supersededIdentity !== null);
    assert.ok(superseder, "second generation supersedes the first");
    assert.equal(superseder.supersededIdentity, firstBundle.identity, "second generation supersedes the first");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("S9/6: same-generation re-render with drifted inputs retires the old bundle — ONE authoritative bundle", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "vca1-s9-regen-"));
  try {
    const first = await run(outDir, passGraph("vca1-s9-regen-gen1"));
    assert.equal(first.final, "PASS");
    assert.equal(bundlesIn(outDir).length, 1);

    // drifted same-generation re-closeout（different graph run id -> new
    // identity）must retire the old bundle so exactly one stays authoritative.
    const second = await run(outDir, passGraph("vca1-s9-regen-gen1-v2"));
    assert.equal(second.final, "PASS", `regenerated closeout PASS (${second.reason})`);
    assert.notEqual(second.bundle.identity, first.bundle.identity, "drifted inputs -> new bundle identity");
    assert.equal(bundlesIn(outDir).length, 1, "exactly one authoritative bundle after re-render");
    assert.equal(supersededIn(outDir).length, 1, "old same-generation bundle retired to .superseded/");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
