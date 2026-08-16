// test/governance/test-colima-scope-gate.mjs
//
// VCA-1 W1A (S6) — test:colima-all scope gate.
//
// Acceptance criteria D + E:
//   D — a NON-runtime-touching card（docs-only / telemetry-only /
//       closeout-machinery）cannot run/claim colima-all:
//       assertColimaAllAuthorized -> ok:false, COLIMA_ALL_NOT_AUTHORIZED;
//       a closeout claiming colima-all without runtime scope HOLDs at the
//       mandatory closeout boundary.
//   E — a runtime-touching card（owns a colima-all suite member or touches
//       src/runtime/ / src/subagent/ / src/v2/durable* seams）still triggers
//       colima-all: assertColimaAllAuthorized -> ok:true.
//
// Also proves the closeout-boundary integration in runMandatoryGraphCloseout
//（review-bundle.mjs）and that the evidence snapshot marks UNKNOWN timings
// honestly（S10 cross-check）.
//
// Run: node --test test/governance/test-colima-scope-gate.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyColimaScope,
  assertColimaAllAuthorized,
  assertColimaAllClaims,
  colimaAllClaimed,
  COLIMA_ALL_HOLDS,
  COLIMA_ALL_SUBSTITUTE,
  COLIMA_ALL_SUITE_FILES,
} from "../../src/governance/colima-scope-gate.mjs";
import {
  runMandatoryGraphCloseout,
  buildGraphCloseoutEvidenceSnapshot,
} from "../../src/governance/review-bundle.mjs";

const REPO = "/Volumes/NVM2T/Development/autoloop";

const docsOnly = { authorizedScope: ["docs/pi-graph-output/x/"] };
const memoryOnly = { authorizedScope: ["src/memory/", "test/memory/", "docs/pi-graph-output/x/"] };
const runtimeSeam = { authorizedScope: ["docs/x/", "src/runtime/colima-graph-runner.mjs", "src/subagent/subagent-graph-runner.mjs"] };
const ownsColimaTest = { authorizedScope: ["docs/x/"], implementationFiles: ["test/test-durable-subagent-resume.mjs"] };
const de2Like = { authorizedScope: ["docs/x/", "src/v2/durable-graph.mjs", "src/runtime/colima-graph-runner.mjs"] };

test("D1: docs-only card is NOT authorized for colima-all", () => {
  const r = assertColimaAllAuthorized({ cardId: "C-DOCS", ...docsOnly });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, COLIMA_ALL_HOLDS.NOT_AUTHORIZED);
  assert.ok(r.reason.includes("COLIMA_ALL_NOT_AUTHORIZED"));
  assert.ok(r.substitute.includes("V17"));
  assert.equal(r.touchesRuntime, false);
});

test("D2: memory-only card（no runtime seam owned）is NOT authorized", () => {
  const r = assertColimaAllAuthorized({ cardId: "C-MEM", ...memoryOnly });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, COLIMA_ALL_HOLDS.NOT_AUTHORIZED);
});

test("E1: card owning a colima-all suite member IS authorized", () => {
  const r = assertColimaAllAuthorized({ cardId: "C-OWNER", ...ownsColimaTest });
  assert.equal(r.ok, true);
  assert.equal(r.touchesRuntime, true);
  assert.ok(r.matches.some((m) => m.path === "test/test-durable-subagent-resume.mjs"));
});

test("E2: card touching runtime seams（de2/de2r-like）IS authorized", () => {
  for (const c of [runtimeSeam, de2Like]) {
    const r = assertColimaAllAuthorized({ cardId: "C-RUNTIME", ...c });
    assert.equal(r.ok, true, `authorized for ${JSON.stringify(c.authorizedScope)}`);
    assert.equal(r.touchesRuntime, true);
  }
});

test("E3: classifyColimaScope lists the matched signals", () => {
  const cls = classifyColimaScope({ authorizedScope: runtimeSeam.authorizedScope });
  assert.equal(cls.touchesRuntime, true);
  assert.ok(cls.matches.length >= 2, "runtime seam + subagent both matched");
});

test("D3: a closeout claiming colima-all for a docs-only card fails the claims gate", () => {
  const claimed = colimaAllClaimed({ regression: [{ suite: "test:colima-all（single full run）", tests: 42, pass: 42, fail: 0 }] });
  assert.equal(claimed, true);
  const r = assertColimaAllClaims({
    closeout: {
      cardId: "C-DOCS",
      authorizedScope: docsOnly.authorizedScope,
      regression: [{ suite: "test:colima-all（single full run）", tests: 42, pass: 42, fail: 0 }],
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, COLIMA_ALL_HOLDS.NOT_AUTHORIZED);
  assert.equal(r.claimed, true);
});

test("D4: a 'colima-all NOT re-run' note is NOT treated as a claim", () => {
  const claimed = colimaAllClaimed({
    regression: [{ suite: "existing suites", tests: 0, pass: 0, fail: 0, note: "colima-all NOT re-run (research-card rule)" }],
  });
  assert.equal(claimed, false);
  const r = assertColimaAllClaims({ closeout: { cardId: "C-RESEARCH", authorizedScope: ["docs/"], regression: [{ suite: "existing suites", tests: 0, pass: 0, fail: 0 }] } });
  assert.equal(r.ok, true);
  assert.equal(r.claimed, false);
});

test("E4: a runtime-touching card's colima-all claim passes the claims gate", () => {
  const r = assertColimaAllClaims({
    closeout: {
      cardId: "C-DE2",
      authorizedScope: de2Like.authorizedScope,
      cardFiles: { cardImplementation: ["src/v2/durable-graph.mjs"] },
      regression: [{ suite: "test:colima-all（canonical）", tests: 43, pass: 43, fail: 0 }],
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.claimed, true);
});

// ── closeout-boundary integration（runMandatoryGraphCloseout）───────────────
const mkCloseout = (overrides = {}) => ({
  requiresReview: true,
  cardId: "VCA1-S6-TEST",
  cardTitle: "S6 gate test",
  cardType: "implementation",
  objective: "prove the colima-all scope gate at the closeout boundary",
  authorizedScope: docsOnly.authorizedScope,
  unauthorizedScope: [],
  designDecisions: [],
  negativeCases: [],
  regression: [{ suite: "test:colima-all（single full run）", tests: 1, pass: 1, fail: 0 }],
  regressionSummary: "colima-all claimed",
  recommendedNextStep: "none",
  ...overrides,
});

const minimalGraphResult = {
  executionId: "vca1-s6-graph",
  final: "PASS",
  holdCode: null,
  reason: null,
  scheduler: { verdict: "PASS", order: ["W1"], statuses: { W1: "passed" }, skipped: [], writerViolations: [], leaseHolderAfter: null },
  nodeResults: [{ nodeId: "W1", phaseExecutionId: "vca1-s6-graph:W1", taskType: "x", dependencies: [], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } }],
  transitions: [],
};

test("D5: mandatory closeout HOLDs COLIMA_ALL_NOT_AUTHORIZED for a docs-only card claiming colima-all", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "vca1-s6-docs-"));
  try {
    const r = await runMandatoryGraphCloseout({
      graphResult: minimalGraphResult,
      closeout: mkCloseout(),
      repoPath: REPO,
      cwd: REPO,
      outDir,
      timeoutMs: 30000,
    });
    assert.equal(r.applied, true);
    assert.equal(r.final, "HOLD");
    assert.equal(r.holdCode, COLIMA_ALL_HOLDS.NOT_AUTHORIZED);
    assert.ok(r.reason.includes("COLIMA_ALL_NOT_AUTHORIZED"));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("E5: a runtime-touching card's closeout is NOT blocked by the colima gate", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "vca1-s6-rt-"));
  try {
    const r = await runMandatoryGraphCloseout({
      graphResult: minimalGraphResult,
      closeout: mkCloseout({ authorizedScope: de2Like.authorizedScope, cardFiles: { cardImplementation: ["src/v2/durable-graph.mjs"] } }),
      repoPath: REPO,
      cwd: REPO,
      outDir,
      timeoutMs: 60000,
    });
    // NOT the colima hold — either the bundle pipeline proceeds or a later
    // gate reports its own disposition（never COLIMA_ALL_NOT_AUTHORIZED）.
    assert.notEqual(r.holdCode, COLIMA_ALL_HOLDS.NOT_AUTHORIZED);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("S10: evidence snapshot marks UNKNOWN timingSource when timestamps are absent", () => {
  const snap = buildGraphCloseoutEvidenceSnapshot({ graphResult: minimalGraphResult, closeout: { cardId: "X", cardTitle: "X", cardType: "implementation" } });
  assert.equal(snap.nodes[0].startedAt, null);
  assert.equal(snap.nodes[0].completedAt, null);
  assert.equal(snap.nodes[0].timingSource, "UNKNOWN");
  const measured = buildGraphCloseoutEvidenceSnapshot({
    graphResult: {
      ...minimalGraphResult,
      nodeResults: [{ ...minimalGraphResult.nodeResults[0], startedAt: 1786000000000, completedAt: 1786000001000 }],
    },
    closeout: { cardId: "X", cardTitle: "X", cardType: "implementation" },
  });
  assert.equal(measured.nodes[0].timingSource, "MEASURED");
});

test("S6: colima-all suite membership list matches package.json test:colima-all", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const cmd = pkg.scripts["test:colima-all"];
  const files = cmd.split(" ").filter((x) => x.endsWith(".mjs"));
  assert.deepEqual(files.sort(), [...COLIMA_ALL_SUITE_FILES].sort(), "gate's suite membership mirrors the canonical npm script");
});
