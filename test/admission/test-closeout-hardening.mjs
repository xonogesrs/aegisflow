// test/admission/test-closeout-hardening.mjs
//
// TA-2 — post-FM-3 closeout hardening tests（V1–V5; NEG13–NEG16）:
//   V1/NEG13  card-start baseline mandatory for delta-v1 closeouts
//   V2/NEG14  CURRENT_CARD_DELTA_PATHS == ADDED ∪ MODIFIED ∪ DELETED（single
//             machine delta truth）
//   V3/NEG15  {DELTA_PATHS_COUNT} / {BASELINE_PATHS_COUNT} narrative
//             placeholders render from the machine inventory（no stale
//             literals）
//   V4/NEG16  verifier accounting claims derived from structured results
//   V5        a newly generated bundle does not stale its own counts

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  captureBaselineInventory,
  classifyDeltaFromFacts,
  collectRepoFacts,
  assertCardStartBaseline,
  renderVerifierAccounting,
  assertAccountingMatches,
  assertNoTemplateResidue,
  buildGraphCloseoutSource,
  renderReviewBundle,
  runMandatoryGraphCloseout,
  validateReviewBundle,
} from "../../src/governance/review-bundle.mjs";

// ── helpers ────────────────────────────────────────────────────────────────

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "ta2-closeout-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

function fakeGraphResult(overrides = {}) {
  return {
    schema: "autoloop.c3.parallel-graph-result/v1",
    executionId: "exec_ta2closeout",
    final: "PASS",
    nodeResults: [{ nodeId: "P1", final: "PASS" }],
    transitions: [],
    closeout: { applied: true, final: "PASS" },
    ...overrides,
  };
}

function baselineFor(repo) {
  return captureBaselineInventory(repo, { cardId: "AUTOLOOP-TA2-TEST", recordedAt: "2026-08-09T00:00:00.000Z" });
}

// ── V1 / NEG13 ─────────────────────────────────────────────────────────────

test("V1/NEG13: delta-v1 closeout WITHOUT a machine-captured baseline -> HOLD / CARD_START_BASELINE_MISSING", async () => {
  const repo = makeRepo();
  const out = join(repo, "out");
  mkdirSync(out, { recursive: true });
  try {
    const r = await runMandatoryGraphCloseout({
      graphResult: fakeGraphResult(),
      closeout: {
        requiresReview: true,
        inventoryModel: "delta-v1", // explicit post-FM-3 contract
        cardId: "AUTOLOOP-TA2-TEST",
        cardTitle: "test",
        cardType: "implementation",
        outDir: out,
        objective: "test",
      },
      repoPath: repo,
      cwd: repo,
      outDir: out,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.holdCode, "CARD_START_BASELINE_MISSING");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("V1: legacy closeout（no delta-v1 declaration, no baseline）stays non-retroactive", async () => {
  const repo = makeRepo();
  const out = join(repo, "out");
  mkdirSync(out, { recursive: true });
  try {
    const r = await runMandatoryGraphCloseout({
      graphResult: fakeGraphResult(),
      closeout: { requiresReview: true, cardId: "LEGACY", cardTitle: "legacy", cardType: "implementation", outDir: out, objective: "legacy test" },
      repoPath: repo,
      cwd: repo,
      outDir: out,
    });
    // must NOT be CARD_START_BASELINE_MISSING（legacy contract untouched）;
    // it proceeds to the normal gate（outcome depends on the empty repo — we
    // only assert the baseline gate passed）.
    assert.notEqual(r.holdCode, "CARD_START_BASELINE_MISSING");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("assertCardStartBaseline unit: declaration without baseline -> not ok; with baseline -> ok", () => {
  const repo = makeRepo();
  try {
    const bl = baselineFor(repo);
    assert.equal(assertCardStartBaseline({ closeout: { inventoryModel: "delta-v1" } }).ok, false);
    assert.equal(assertCardStartBaseline({ closeout: { inventoryModel: "delta-v1", baseline: bl } }).ok, true);
    assert.equal(assertCardStartBaseline({ closeout: { requiresReview: true } }).ok, true); // legacy
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── V2 / NEG14 ─────────────────────────────────────────────────────────────

test("V2/NEG14: delta views derive from the single machine delta (classifyDeltaFromFacts)", () => {
  const repo = makeRepo();
  try {
    const bl = baselineFor(repo);
    // add two files after baseline
    writeFileSync(join(repo, "a.md"), "a\n");
    writeFileSync(join(repo, "b.md"), "b\n");
    const facts = collectRepoFacts(repo, { baseline: bl });
    const cls = classifyDeltaFromFacts(facts);
    // CURRENT_CARD_DELTA_PATHS == ADDED ∪ MODIFIED ∪ DELETED（disjoint）
    const union = new Set([...cls.added, ...cls.modified, ...cls.deleted]);
    assert.equal(union.size, cls.added.length + cls.modified.length + cls.deleted.length, "disjoint");
    assert.deepEqual([...union].sort(), [...facts.deltaPaths].sort(), "delta == union");
    assert.equal(cls.added.length, 2);
    assert.equal(cls.modified.length, 0);
    assert.equal(cls.deleted.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("V2: buildGraphCloseoutSource with baseline renders files lists from the machine delta", () => {
  const repo = makeRepo();
  try {
    const bl = baselineFor(repo);
    writeFileSync(join(repo, "added.md"), "x\n");
    const source = buildGraphCloseoutSource({
      graphResult: fakeGraphResult(),
      closeout: { requiresReview: true, baseline: bl, inventoryModel: "delta-v1", cardId: "T", objective: "t" },
      repoPath: repo,
      cwd: repo,
    });
    assert.ok(Array.isArray(source.inventory.deltaPaths));
    assert.ok(source.files.added.includes("added.md"), `added.md in ${JSON.stringify(source.files.added)}`);
    assert.equal(source.files.preExistingDirty.includes("added.md"), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── V3 / NEG15 ─────────────────────────────────────────────────────────────

test("V3/NEG15: narrative count placeholders render from the machine inventory", () => {
  const repo = makeRepo();
  try {
    const bl = baselineFor(repo);
    writeFileSync(join(repo, "x1.md"), "x\n");
    writeFileSync(join(repo, "x2.md"), "x\n");
    const source0 = buildGraphCloseoutSource({
      graphResult: fakeGraphResult(),
      closeout: {
        requiresReview: true,
        baseline: bl,
        inventoryModel: "delta-v1",
        cardId: "T",
        objective: "delta {DELTA_PATHS_COUNT} baseline {BASELINE_PATHS_COUNT}",
      },
      repoPath: repo,
      cwd: repo,
    });
    // the gate enriches the source with authoritative repo facts — mirror
    // that enrichment here so renderReviewBundle validates.
    const facts = collectRepoFacts(repo, { baseline: bl });
    const source = { ...source0, repo: { repository: facts.repository, branch: facts.branch, head: facts.head, treeSha: facts.treeSha, worktreePath: facts.worktreePath, baselineDirtyDigest: facts.baselineDirtyDigest, finalDirtyDigest: facts.dirtyDigest, remote: facts.remote ?? null } };
    const bundle = renderReviewBundle(source, { generatedAt: "2026-08-09T00:00:00.000Z" });
    const expectedDelta = String(source.inventory.deltaPaths.length);
    const expectedBaseline = String(bl.dirtyPaths.length);
    assert.ok(bundle.text.includes(`delta ${expectedDelta} baseline ${expectedBaseline}`), `expected derived counts in narrative: ${bundle.text.slice(0, 400)}`);
    assert.ok(!bundle.text.includes("{DELTA_PATHS_COUNT}"), "placeholder must be substituted");
    assert.ok(!bundle.text.includes("{BASELINE_PATHS_COUNT}"), "placeholder must be substituted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── V4 / NEG16 ─────────────────────────────────────────────────────────────

test("V4/NEG16: verifier accounting derived from structured results; mismatch fails closed", () => {
  const results = [
    { suite: "V1 deliverables parse", tests: 1, passed: 1, failed: 0 },
    { suite: "V2 schema", tests: 1, passed: 1, failed: 0 },
  ];
  const narrative = renderVerifierAccounting(results);
  assert.equal(narrative, "2/2 (V1-V2)");
  assert.equal(assertAccountingMatches(results, narrative).ok, true);
  // a stale hand-written claim must be caught
  const stale = assertAccountingMatches(results, "1/2 (V1-V2)");
  assert.equal(stale.ok, false);
});

// ── U: admission recorded in the bundle ──────────────────────────────────

test("U: an admitted graph records the admission decision in the bundle (§1.5)", () => {
  const repo = makeRepo();
  try {
    const bl = baselineFor(repo);
    const admission = {
      schema: "autoloop.task-admission/v1",
      task_id: "T-ADM",
      admission_id: "a".repeat(64),
      size: "XS",
      risk: "LOW",
      profile: "FAST_PATH",
      repair_budget: 0,
      evidence_policy: "none",
      review_policy: { external_review_required: false },
      capabilities: { required: [], allowed: ["direct_execution"], denied: ["subagent", "colima"] },
      reasons: ["trivial typo"],
      review_surface_policy: { authoritative_single_surface: true, chain: "linear", generation_policy: [] },
    };
    const source0 = buildGraphCloseoutSource({
      graphResult: fakeGraphResult({ admission }),
      closeout: { requiresReview: true, baseline: bl, inventoryModel: "delta-v1", cardId: "T", objective: "t" },
      repoPath: repo,
      cwd: repo,
    });
    const facts = collectRepoFacts(repo, { baseline: bl });
    const source = { ...source0, repo: { repository: facts.repository, branch: facts.branch, head: facts.head, treeSha: facts.treeSha, worktreePath: facts.worktreePath, baselineDirtyDigest: facts.baselineDirtyDigest, finalDirtyDigest: facts.dirtyDigest, remote: facts.remote ?? null } };
    const bundle = renderReviewBundle(source, { generatedAt: "2026-08-09T00:00:00.000Z" });
    assert.ok(bundle.text.includes("1.5. Admission Decision"), "admission section must render");
    assert.ok(bundle.text.includes(`ADMISSION_ID: ${"a".repeat(64)}`), "admission_id must render");
    assert.ok(bundle.text.includes("ADMISSION_PROFILE: FAST_PATH"), "profile must render");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── V5 ─────────────────────────────────────────────────────────────────────

test("V5: a newly generated bundle does not stale its own counts (regeneration with growing delta)", () => {
  const repo = makeRepo();
  const out = join(repo, "out");
  mkdirSync(out, { recursive: true });
  try {
    const bl = baselineFor(repo);
    const gen = (extraFiles) => {
      const source0 = buildGraphCloseoutSource({
        graphResult: fakeGraphResult(),
        closeout: {
          requiresReview: true,
          baseline: bl,
          inventoryModel: "delta-v1",
          cardId: "T",
          objective: "count {DELTA_PATHS_COUNT}",
        },
        repoPath: repo,
        cwd: repo,
      });
      const facts = collectRepoFacts(repo, { baseline: bl });
      const source = { ...source0, repo: { repository: facts.repository, branch: facts.branch, head: facts.head, treeSha: facts.treeSha, worktreePath: facts.worktreePath, baselineDirtyDigest: facts.baselineDirtyDigest, finalDirtyDigest: facts.dirtyDigest, remote: facts.remote ?? null } };
      return { source, bundle: renderReviewBundle(source, { generatedAt: "2026-08-09T00:00:00.000Z" }) };
    };
    // generation 1: one file
    writeFileSync(join(repo, "gen1.md"), "1\n");
    const g1 = gen();
    const delta1 = String(g1.source.inventory.deltaPaths.length);
    assert.ok(g1.bundle.text.includes(`count ${delta1}`), `gen1 narrative = ${delta1}`);
    // generation 2: the new bundle file is itself a delta addition — counts
    // must DERIVE the new value, not keep the literal from gen1.
    writeFileSync(join(out, "card-closeout-bundle-test.txt"), g1.bundle.text);
    const g2 = gen();
    const delta2 = String(g2.source.inventory.deltaPaths.length);
    assert.notEqual(delta1, delta2, "delta grows when the bundle is a generated file");
    assert.ok(g2.bundle.text.includes(`count ${delta2}`), `gen2 narrative must be ${delta2}, got ${g2.bundle.text.slice(0, 300)}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── TA-2R NEG17: content-identity delta attribution（finding 2）────────────

const TEST_DELIVER_HOOK = async () => ({ attempted: true, method: "test-harness", attemptedAt: new Date().toISOString() });

function contentCloseout(bl, { objective = "delta {DELTA_PATHS_COUNT}" } = {}) {
  return {
    requiresReview: true,
    inventoryModel: "delta-v1",
    inventoryAttribution: "content-v1",
    baseline: bl,
    cardId: "AUTOLOOP-TA2R-TEST",
    cardTitle: "ta2r test",
    cardType: "implementation",
    outDir: join(bl.worktreePath, "out"),
    objective,
    authorizedScope: ["src/"],
    cardFiles: {
      cardImplementation: ["src/a.md"],
      closeoutOutputs: ["out/card-closeout-bundle-test.txt", "out/exec_contentdelta-graph-closeout-evidence.json"],
      preExistingDirty: [],
    },
    regression: [{ suite: "test:admission", tests: 3, pass: 3, fail: 0 }],
    deliver: TEST_DELIVER_HOOK,
  };
}

function fakeGraphResult3() {
  const reviewResult = { recommendedAction: "PASS", blockingFindings: [], summary: "independent review PASS" };
  return {
    schema: "autoloop.c3.parallel-graph-result/v1",
    executionId: "exec_contentdelta",
    final: "PASS",
    nodeResults: [
      { nodeId: "P1", final: "PASS", taskType: "readonly", reviewResult },
      { nodeId: "P2", final: "PASS", taskType: "implement", reviewResult },
      { nodeId: "P3", final: "PASS", taskType: "verify", reviewResult },
    ],
    transitions: [],
    closeout: { applied: true, final: "PASS" },
  };
}

function contentFixture() {
  const repo = makeRepo();
  const out = join(repo, "out");
  mkdirSync(out, { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.md"), "v1\n"); // pre-existing dirty at card start
  writeFileSync(join(repo, "src", "b.md"), "unchanged\n"); // pre-existing dirty, NOT modified by the card
  const bl = baselineFor(repo);
  return { repo, out, bl };
}

const runCloseout = async (repo, out, bl, graphResult = fakeGraphResult3()) => {
  const r = await runMandatoryGraphCloseout({
    graphResult,
    closeout: contentCloseout(bl),
    repoPath: repo,
    cwd: repo,
    outDir: out,
    fileName: "card-closeout-bundle-test.txt",
  });
  return r;
};

const readBundle = (repo) => readFileSync(join(repo, "out", "card-closeout-bundle-test.txt"), "utf8");

function parseSection9Block(text, header) {
  const sec9 = text.split("9. Files Added / Modified / Deleted")[1]?.split("10. Diff Summary")[0] ?? "";
  const re = new RegExp(`^${header}:\\s*$`, "m");
  const m = sec9.match(re);
  if (!m) return [];
  const start = sec9.indexOf(m[0]) + m[0].length;
  const rest = sec9.slice(start).split(/\n[A-Z_]+:\s*$/);
  return rest[0].split("\n").map((l) => l.trim().replace(/^-\s*/, "")).filter((l) => l && l !== "(none)");
}

const sectionLine = (text, name) => text.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1] ?? null;

test("NEG17/finding2: content-identity attribution — modified pre-existing dirty file lands in the delta with content proof; untouched one stays excluded", async () => {
  const { repo, out, bl } = contentFixture();
  try {
    writeFileSync(join(repo, "src", "a.md"), "v2-modified\n"); // the card modifies a pre-existing dirty file
    const r = await runCloseout(repo, out, bl);
    assert.equal(r.final, "PASS", r.reason ?? "");
    const text = readBundle(repo);
    // a.md: pre-existing dirty + content-changed -> MODIFIED in the delta
    const delta = parseSection9Block(text, "CURRENT_CARD_DELTA_PATHS");
    assert.ok(delta.includes("src/a.md"), `a.md in delta: ${delta.join(",")}`);
    assert.ok(!delta.includes("src/b.md"), "unchanged pre-existing dirty stays OUT of the delta");
    const attribution = parseSection9Block(text, "DELTA_ATTRIBUTION");
    const aLine = attribution.find((l) => l.includes("src/a.md"));
    assert.ok(aLine && aLine.startsWith("MODIFIED src/a.md (content: "), `content proof line: ${aLine}`);
    assert.ok(!attribution.some((l) => l.includes("src/b.md")), "b.md has no attribution line");
    assert.ok(/^MODIFIED src\/a\.md \(content: [0-9a-f]{12}\.\.\. -> [0-9a-f]{12}\.\.\.\)$/.test(aLine ?? ""), `distinct start/end shas: ${aLine}`);
    // the machine proof is ALSO visible in the git-derived facts
    const facts = collectRepoFacts(repo, { baseline: bl });
    assert.ok(facts.contentModified.includes("src/a.md"), `contentModified=${facts.contentModified.join(",")}`);
    assert.deepEqual(facts.unattributable, [], "all card-start shas present -> nothing unattributable");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("NEG17/finding2: baseline WITHOUT content identity + content-v1 closeout -> HOLD / BASELINE_CONTENT_IDENTITY_MISSING (fail closed, never guess)", async () => {
  const { repo, out, bl } = contentFixture();
  try {
    const stripped = { ...bl, pathShas: undefined, contentDigest: undefined };
    const r = await runMandatoryGraphCloseout({
      graphResult: fakeGraphResult3(),
      closeout: { ...contentCloseout(stripped), baseline: stripped },
      repoPath: repo,
      cwd: repo,
      outDir: out,
      fileName: "card-closeout-bundle-test.txt",
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.holdCode, "BASELINE_CONTENT_IDENTITY_MISSING");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("NEG17/finding2: a delta path whose card-start sha is missing -> HOLD / DELTA_ATTRIBUTION_FAIL_CLOSED", async () => {
  const { repo, out, bl } = contentFixture();
  try {
    writeFileSync(join(repo, "src", "a.md"), "v2-modified\n");
    const partial = { ...bl, pathShas: { ...bl.pathShas } };
    delete partial.pathShas["src/a.md"]; // simulate a pre-content baseline for this path
    const r = await runMandatoryGraphCloseout({
      graphResult: fakeGraphResult3(),
      closeout: { ...contentCloseout(partial), baseline: partial },
      repoPath: repo,
      cwd: repo,
      outDir: out,
      fileName: "card-closeout-bundle-test.txt",
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.holdCode, "DELTA_ATTRIBUTION_FAIL_CLOSED");
    assert.ok(String(r.reason ?? "").includes("src/a.md"), `reason names the unattributable path: ${r.reason}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── TA-2R NEG18: complete-bundle template residue（finding 3）──────────────

test("NEG18/finding3: a narrative with ${...} residue -> closeout HOLD / TEMPLATE_RESIDUE (complete-bundle scan)", async () => {
  const { repo, out, bl } = contentFixture();
  try {
    writeFileSync(join(repo, "src", "a.md"), "v2-modified\n");
    const r = await runMandatoryGraphCloseout({
      graphResult: fakeGraphResult3(),
      closeout: contentCloseout(bl, { objective: "suite had ${NEG_SUITE?.tests ?? 0} tests" }),
      repoPath: repo,
      cwd: repo,
      outDir: out,
      fileName: "card-closeout-bundle-test.txt",
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.holdCode, "TEMPLATE_RESIDUE");
    assert.ok(!existsSync(join(repo, "out", "card-closeout-bundle-test.txt")), "a residue bundle is never written");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("NEG18/finding3: the FINAL complete bundle (written artifact) has zero template residue + unified §11/§16 accounting", async () => {
  const { repo, out, bl } = contentFixture();
  try {
    writeFileSync(join(repo, "src", "a.md"), "v2-modified\n");
    const r = await runCloseout(repo, out, bl);
    assert.equal(r.final, "PASS", r.reason ?? "");
    const text = readBundle(repo);
    // complete-bundle residue scan on the WRITTEN artifact
    const residue = assertNoTemplateResidue(text);
    assert.deepEqual(residue.matches, [], "no ${...} / placeholder literal anywhere in the final bundle");
    assert.ok(!text.includes("${NEG_SUITE"), "no NEG_SUITE literal");
    assert.ok(!text.includes("${VERIFIER_ACCOUNTING"), "no VERIFIER_ACCOUNTING literal");
    // §11 counts GRAPH NODES（NODES_*）— never a conflicting TESTS_TOTAL
    assert.equal(sectionLine(text, "NODES_TOTAL"), "3");
    assert.equal(sectionLine(text, "NODES_PASSED"), "3");
    assert.equal(sectionLine(text, "NODES_FAILED"), "0");
    assert.equal(sectionLine(text, "TESTS_TOTAL"), null, "section 11 must not carry TESTS_TOTAL (finding 3)");
    // §16 renders the regression surface separately
    const sec16 = text.split("16. Regression Results")[1]?.split("17. Evidence Inventory")[0] ?? "";
    assert.ok(sec16.includes("suite="), "§16 renders structured regression suites");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("NEG18/finding3: validator independently fails a bundle whose DELTA_ATTRIBUTION content proof is stripped", async () => {
  const { repo, out, bl } = contentFixture();
  try {
    writeFileSync(join(repo, "src", "a.md"), "v2-modified\n");
    const r = await runCloseout(repo, out, bl);
    assert.equal(r.final, "PASS", r.reason ?? "");
    const bundlePath = join(repo, "out", "card-closeout-bundle-test.txt");
    const text = readBundle(repo);
    // strip the content proof from the a.md attribution line -> INVALID
    const tampered = text.replace(/MODIFIED src\/a\.md \(content: [0-9a-f]{12}\.\.\. -> [0-9a-f]{12}\.\.\.\)/, "MODIFIED src/a.md");
    assert.notEqual(tampered, text, "tamper applied");
    const path = join(repo, "out", "tampered.txt");
    writeFileSync(path, tampered, "utf8");
    const v = validateReviewBundle(path, { authorizedDir: out });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes("inventory_delta_kind_missing_content_proof")), v.errors.join(";"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
