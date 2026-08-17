// test/governance/test-review-bundle-decision-section.mjs
//
// REVIEW-BUNDLE-REVIEW-SECTION-CONVERGENCE-1 — canonical reviewer decision
// surface. Covers（card Q1–Q17）:
//   1. new External Review Decision rendering（E1–E9）
//   2. internal review clearly labeled non-external（D; C1/C2）
//   3. WHAT_CHANGED implementation bundle（E4）
//   4. WHAT_WAS_PROVEN evidence-backed（E5; implemented != proven）
//   5. known limitations rendering（E6; J empty-list semantics）
//   6. PENDING verdict rendering（E8）
//   7. existing authoritative external verdict rendering
//   8. PASS/REPAIR/HOLD next actions（E9）
//   9. repair/supersession lineage（F）
//  10. empty-list deterministic rendering（J）
//  11. implementation bundle dogfood（L1）
//  12. no-source bundle dogfood（L2）
//  13. parser/backward compatibility（H; legacy layout still validates）
//  14. LatestHuman publication（N）
//  15. Current/Queue authority regression（R invariants）
//  16. review generation regression（determinism）
//  17. secret scan regression
//
// Run: node --test test/governance/test-review-bundle-decision-section.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEW_BUNDLE_SOURCE_SCHEMA,
  REVIEW_BUNDLE_SECTIONS,
  REVIEW_BUNDLE_SECTIONS_LEGACY,
  REVIEW_BUNDLE_HOLDS,
  renderReviewBundle,
  writeReviewBundle,
  validateReviewBundle,
  runCloseoutGate,
  collectRepoFacts,
  parseBlockingFindings,
  parseRepairLineage,
  supersedesFromBundleText,
  deliverToExternalReviewSurface,
} from "../../src/governance/review-bundle.mjs";
import { humanReportTextPath } from "../../src/governance/human-report.mjs";

// Resolve the repo root from the test file location（portable across
// checkouts; never depends on a hardcoded machine path）.
const REPO_A = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/+$/, "");
const ROOT = `${tmpdir()}/rb-decision-${process.pid}`;
const OUT = join(ROOT, "out");
const EV = join(ROOT, "ev");
const SURFACE = join(ROOT, "surface");
const repoEntriesBefore = spawnSync("git", ["-C", REPO_A, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

let bundleCount = 0;
function mkSource(overrides = {}) {
  bundleCount += 1;
  return {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: { cardId: "RBD-TEST", cardTitle: "Review Bundle Decision Test", cardType: "implementation" },
    graph: { graphRunId: `rbd-test-${bundleCount}` },
    repo: { repository: "autoloop", branch: "main", head: "a".repeat(40), treeSha: "b".repeat(40), worktreePath: REPO_A, remote: null },
    repoIntegrity: { head: "a".repeat(40), treeSha: "b".repeat(40), worktreeClean: true, dirtyPaths: [], untrackedFiles: [], remote: null },
    objective: "test the consolidated external review decision section",
    executiveStatus: "PASS",
    executiveSummary: "decision section converged and verified",
    authorizedScope: ["src/governance/review-bundle.mjs", "test/governance/test-review-bundle-decision-section.mjs"],
    unauthorizedScope: ["commit", "push", "merge", "seal"],
    designDecisions: ["single consolidated reviewer decision section"],
    files: { added: ["src/governance/review-bundle.mjs"], modified: [], deleted: [] },
    diffSummary: "1 governance module converged",
    execution: { testsExecuted: ["node --test test/governance/test-review-bundle-decision-section.mjs"], pass: true, nodeResults: { passed: 1, failed: 0, total: 1 } },
    verifier: { pass: true, result: "PASS", summary: "verify PASS" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "f".repeat(64), blockingFindings: [], summary: "review PASS" },
    repairAttempts: [],
    repairBudget: { maxAttempts: 1, used: 0 },
    repairLineage: { generationType: "implementation", repairIterations: 0, surfaceReseals: 0, resealTouchedPaths: [] },
    externalReview: { deliveryRequired: false, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null, verdict: null },
    negativeCases: ["fail-closed on missing bundle"],
    regression: [{ suite: "governance", tests: 1, pass: 1, fail: 0 }],
    evidence: [],
    security: { secretScanResult: "clean", ingestionAllowlist: ["structured results"], ingestionDenylist: ["secrets"] },
    risks: [], limitations: [],
    rollbackProcedure: "rm generated bundle and regenerate",
    openQuestions: [],
    recommendedNextStep: "external review",
    ...overrides,
  };
}

function evFile(name, content) {
  const p = join(EV, name);
  mkdirSync(join(EV), { recursive: true });
  writeFileSync(p, content);
  return p;
}

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(EV, { recursive: true });
  mkdirSync(SURFACE, { recursive: true });
  process.env.AUTOLOOP_REVIEW_SURFACE = SURFACE;
  process.env.AUTOLOOP_REVIEW_ARCHIVE = join(ROOT, "archive");
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
  const now = spawnSync("git", ["-C", REPO_A, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
  assert.equal(now, repoEntriesBefore, "main repo working tree unchanged by the test suite");
});

const facts = collectRepoFacts(REPO_A);
const gate = (source, opts = {}) => runCloseoutGate({ source, repoPath: REPO_A, outDir: OUT, timeoutMs: 10000, repoFacts: facts, ...opts });
const sectionText = (txt, title) => {
  const m = txt.match(new RegExp(`^\\d+(\\.\\d+)?\\. ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"));
  assert.ok(m, `section present: ${title}`);
  const start = m.index + m[0].length;
  const rest = txt.slice(start);
  const next = rest.match(/^\d+(?:\.\d+)?\. .+$/m);
  return next ? rest.slice(0, next.index) : rest;
};

// ── Q1 — new External Review Decision rendering ───────────────────────────

test("Q1. External Review Decision section renders E1–E9 in one place", { timeout: 30000 }, async () => {
  const source = mkSource({
    whatChanged: ["Added src/governance/review-bundle.mjs decision section"],
    whatWasProven: ["LatestHuman advanced A -> B -> C.", "Formal QUEUED delivery also updated LatestHuman."],
    nextActions: { pass: "rotate to promote the queued review", repair: "bounded repair within budget", hold: "stop downstream" },
  });
  const b = renderReviewBundle(source, { generatedAt: "2026-08-17T00:00:00.000Z" });
  const sec = sectionText(b.text, "External Review Decision");
  // E1 status
  assert.ok(sec.includes("EXTERNAL_REVIEW_STATUS: AWAITING_EXTERNAL_REVIEW"), "E1 status");
  // E2 target
  assert.ok(sec.includes("REVIEW_TARGET:"), "E2 REVIEW_TARGET");
  assert.ok(sec.includes("CARD_ID: RBD-TEST"), "E2 CARD_ID");
  assert.ok(sec.includes("GENERATION_JOB_ID: NOT_APPLICABLE"), "E2 GENERATION_JOB_ID (absent -> NOT_APPLICABLE)");
  assert.ok(sec.includes("GRAPH_RUN_ID: rbd-test-"), "E2 GRAPH_RUN_ID");
  assert.ok(/BUNDLE_IDENTITY: [0-9a-f]{64}/.test(sec), "E2 BUNDLE_IDENTITY");
  assert.ok(sec.includes("BUNDLE_SHA256: NOT_APPLICABLE (authoritative content sha256: footer REVIEW_BUNDLE_SHA256 line)"), "E2 BUNDLE_SHA256 footer reference");
  // E3 snapshot
  assert.ok(sec.includes("DECISION_SNAPSHOT:"), "E3 snapshot");
  assert.ok(sec.includes("EXECUTION: PASS"), "E3 EXECUTION");
  assert.ok(sec.includes("VERIFIER: PASS"), "E3 VERIFIER");
  assert.ok(sec.includes("INTERNAL_REVIEW: PASS"), "E3 INTERNAL_REVIEW");
  assert.ok(sec.includes("REGRESSION:"), "E3 REGRESSION");
  assert.ok(sec.includes("SECURITY_SCAN: clean"), "E3 SECURITY_SCAN");
  assert.ok(sec.includes("REPOSITORY_INTEGRITY: CLEAN"), "E3 REPOSITORY_INTEGRITY");
  assert.ok(sec.includes("DECISION_SNAPSHOT is a summary reference"), "E3 summary-reference note");
  // E4/E5/E6
  assert.ok(sec.includes("WHAT_CHANGED:\n  - Added src/governance/review-bundle.mjs decision section"), "E4 WHAT_CHANGED");
  assert.ok(sec.includes("WHAT_WAS_PROVEN:\n  - LatestHuman advanced A -> B -> C."), "E5 WHAT_WAS_PROVEN");
  assert.ok(sec.includes("KNOWN_LIMITATIONS:\n  - none"), "E6 KNOWN_LIMITATIONS canonical empty");
  // E7 checks
  assert.ok(sec.includes("REVIEWER_CHECKS:"), "E7 REVIEWER_CHECKS");
  for (const n of [1, 2, 3, 4, 5, 6]) {
    assert.ok(sec.includes(`${n}. `), `E7 check ${n}`);
  }
  assert.ok(sec.includes("Is the implementation within authorized scope?"), "E7 check 1 text");
  assert.ok(sec.includes("Is repair required before acceptance?"), "E7 check 6 text");
  // E8 verdict + allowed
  assert.ok(sec.includes("EXTERNAL_VERDICT:"), "E8 EXTERNAL_VERDICT");
  assert.ok(sec.includes("VERDICT: PENDING"), "E8 PENDING verdict");
  assert.ok(sec.includes("REVIEWER_IDENTITY: NOT_APPLICABLE"), "E8 reviewer identity absent");
  assert.ok(sec.includes("ALLOWED_VERDICTS:"), "E8 ALLOWED_VERDICTS");
  assert.ok(sec.includes("  - PASS\n  - REPAIR\n  - HOLD"), "E8 allowed verdicts");
  // E9 next actions
  assert.ok(sec.includes("NEXT_ACTION:"), "E9 NEXT_ACTION");
  assert.ok(sec.includes("IF_PASS: rotate to promote the queued review"), "E9 IF_PASS");
  assert.ok(sec.includes("IF_REPAIR: bounded repair within budget"), "E9 IF_REPAIR");
  assert.ok(sec.includes("IF_HOLD: stop downstream"), "E9 IF_HOLD");
  // the decision section is ONE contiguous block before Execution Results
  const decStart = b.text.indexOf("10.5. External Review Decision");
  const execStart = b.text.indexOf("11. Execution Results");
  assert.ok(decStart > 0 && execStart > decStart, "decision section placed before execution details (K)");
});

// ── Q2 — internal review clearly labeled non-external ─────────────────────

test("Q2. internal independent review is labeled INTERNAL and never mints the external verdict", { timeout: 30000 }, async () => {
  const source = mkSource({ review: { pass: true, result: "PASS", reviewResultIdentity: "e".repeat(64), blockingFindings: [], summary: "internal agent PASS" } });
  const b = renderReviewBundle(source, { generatedAt: "2026-08-17T00:00:00.000Z" });
  const sec = sectionText(b.text, "Internal Independent Review");
  assert.ok(sec.includes("INTERNAL_REVIEW_RESULT: PASS"), "canonical INTERNAL label");
  assert.ok(sec.includes("INTERNAL_REVIEW_IDENTITY: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"), "canonical INTERNAL identity");
  assert.ok(sec.includes("INTERNAL_REVIEW_SUMMARY: internal agent PASS"), "canonical INTERNAL summary");
  assert.ok(sec.includes("AUTHORITY_NOTE: Internal independent review is supporting evidence. It is NOT the external reviewer verdict."), "AUTHORITY_NOTE (C1)");
  assert.ok(sec.includes("BLOCKING_FINDINGS:\n  - none"), "canonical blocking findings block");
  // legacy compat aliases（same values）must remain（D）
  assert.ok(sec.includes("REVIEW_PASS: true"), "compat REVIEW_PASS");
  assert.ok(sec.includes("REVIEW_RESULT: PASS"), "compat REVIEW_RESULT");
  assert.ok(sec.includes("REVIEW_RESULT_IDENTITY: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"), "compat REVIEW_RESULT_IDENTITY");
  // internal PASS must NOT produce an external verdict（C1: internal != external）
  const dec = sectionText(b.text, "External Review Decision");
  assert.ok(dec.includes("INTERNAL_REVIEW: PASS"), "snapshot shows internal PASS");
  assert.ok(dec.includes("VERDICT: PENDING"), "external verdict stays PENDING despite internal PASS");
  assert.ok(dec.includes("EXTERNAL_REVIEW_STATUS: AWAITING_EXTERNAL_REVIEW"), "status stays AWAITING");
  // validation agrees
  const dir = join(OUT, "q2");
  mkdirSync(dir, { recursive: true });
  const w = writeReviewBundle(b, dir);
  assert.equal(validateReviewBundle(w.path, { authorizedDir: dir }).ok, true, "bundle validates");
});

// ── Q3 — WHAT_CHANGED implementation bundle ───────────────────────────────

test("Q3. WHAT_CHANGED derives from the implementation delta", { timeout: 30000 }, async () => {
  const source = mkSource({
    files: { added: ["src/governance/review-bundle.mjs"], modified: ["test/governance/test-review-bundle.mjs"], deleted: [] },
    inventory: { model: "delta-v1", deltaPaths: ["src/governance/review-bundle.mjs", "test/governance/test-review-bundle.mjs"], deltaKinds: [
      { path: "src/governance/review-bundle.mjs", kind: "ADDED" },
      { path: "test/governance/test-review-bundle.mjs", kind: "MODIFIED", baselineSha: "c".repeat(40), finalSha: "d".repeat(40) },
    ] },
  });
  const b = renderReviewBundle(source, { generatedAt: "2026-08-17T00:00:00.000Z" });
  const dec = sectionText(b.text, "External Review Decision");
  assert.ok(dec.includes("WHAT_CHANGED:\n  - Added src/governance/review-bundle.mjs\n  - Changed test/governance/test-review-bundle.mjs"), "delta-attributed WHAT_CHANGED");
  assert.ok(!dec.includes("Preserved"), "no invented claims");
});

// ── Q4 — WHAT_WAS_PROVEN evidence-backed ──────────────────────────────────

test("Q4. WHAT_WAS_PROVEN renders governed claims; absent -> NOT_RECORDED（implemented != proven）", { timeout: 30000 }, async () => {
  const withClaims = mkSource({ whatWasProven: ["Formal QUEUED delivery also updated LatestHuman.", "Current remained unresolved and byte-identical."] });
  const b1 = renderReviewBundle(withClaims, { generatedAt: "2026-08-17T00:00:00.000Z" });
  const dec1 = sectionText(b1.text, "External Review Decision");
  assert.ok(dec1.includes("WHAT_WAS_PROVEN:\n  - Formal QUEUED delivery also updated LatestHuman.\n  - Current remained unresolved and byte-identical."), "governed claims rendered verbatim");
  // absent（never supplied）-> NOT_RECORDED（data provenance I — never fabricated）
  const noClaims = mkSource({});
  delete noClaims.whatWasProven;
  const b2 = renderReviewBundle(noClaims, { generatedAt: "2026-08-17T00:00:00.000Z" });
  const dec2 = sectionText(b2.text, "External Review Decision");
  assert.ok(dec2.includes("WHAT_WAS_PROVEN:\n  - NOT_RECORDED"), "absent claims -> NOT_RECORDED（never fabricated）");
  // explicit empty list -> canonical `- none`（J）
  const emptyList = mkSource({ whatWasProven: [] });
  const b3 = renderReviewBundle(emptyList, { generatedAt: "2026-08-17T00:00:00.000Z" });
  assert.ok(sectionText(b3.text, "External Review Decision").includes("WHAT_WAS_PROVEN:\n  - none"), "explicit empty claims -> - none");
});

// ── Q5 — known limitations rendering ──────────────────────────────────────

test("Q5. KNOWN_LIMITATIONS centralized; empty -> deterministic - none", { timeout: 30000 }, async () => {
  const withLim = mkSource({ limitations: ["carry-forward debt X (non-blocking)"] });
  const b1 = renderReviewBundle(withLim, { generatedAt: "2026-08-17T00:00:00.000Z" });
  const dec1 = sectionText(b1.text, "External Review Decision");
  assert.ok(dec1.includes("KNOWN_LIMITATIONS:\n  - carry-forward debt X (non-blocking)"), "carry-forward debt listed（never hidden）");
  const empty = mkSource({ limitations: [] });
  const b2 = renderReviewBundle(empty, { generatedAt: "2026-08-17T00:00:00.000Z" });
  assert.ok(b2.text.includes("KNOWN_LIMITATIONS:\n  - none"), "canonical empty marker");
});

// ── Q6 — PENDING verdict rendering ────────────────────────────────────────

test("Q6. PENDING verdict is the default; never a fake existing verdict", { timeout: 30000 }, async () => {
  const b = renderReviewBundle(mkSource(), { generatedAt: "2026-08-17T00:00:00.000Z" });
  assert.ok(b.text.includes("VERDICT: PENDING"), "PENDING default");
  assert.ok(b.text.includes("ALLOWED_VERDICTS:"), "allowed verdicts provided");
  const dir = join(OUT, "q6");
  mkdirSync(dir, { recursive: true });
  const w = writeReviewBundle(b, dir);
  assert.equal(validateReviewBundle(w.path, { authorizedDir: dir }).ok, true, "PENDING bundle validates");
});

// ── Q7 — existing authoritative external verdict rendering ────────────────

test("Q7. an authoritative external verdict renders in the decision section; mismatch fails closed", { timeout: 30000 }, async () => {
  const source = mkSource({
    externalReview: {
      deliveryRequired: true,
      status: "PASS",
      supersedes: null,
      verdict: {
        verdict: "PASS",
        reviewerIdentity: "external-reviewer:jane",
        reviewedAt: "2026-08-17T00:00:00.000Z",
        findingsDigest: "d".repeat(64),
        findings: ["minor formatting nit"],
      },
    },
  });
  const b = renderReviewBundle(source, { generatedAt: "2026-08-17T00:00:00.000Z" });
  const dec = sectionText(b.text, "External Review Decision");
  assert.ok(dec.includes("EXTERNAL_VERDICT:\n  VERDICT: PASS"), "authoritative verdict rendered");
  assert.ok(dec.includes("REVIEWER_IDENTITY: external-reviewer:jane"), "reviewer identity bound");
  assert.ok(dec.includes("REVIEWED_AT: 2026-08-17T00:00:00.000Z"), "reviewedAt bound");
  assert.ok(dec.includes(`FINDINGS_DIGEST: ${"d".repeat(64)}`), "findings digest bound");
  assert.ok(dec.includes("FINDINGS:\n    - minor formatting nit"), "findings rendered");
  const dir = join(OUT, "q7");
  mkdirSync(dir, { recursive: true });
  const w = writeReviewBundle(b, dir);
  assert.equal(validateReviewBundle(w.path, { authorizedDir: dir }).ok, true, "authoritative PASS bundle validates");
  // a verdict contradicting the status is contradictory evidence -> invalid
  const tampered = b.text.replace("  VERDICT: PASS\n", "  VERDICT: HOLD\n");
  const tp = join(dir, "tampered.txt");
  writeFileSync(tp, tampered);
  const v = validateReviewBundle(tp, { authorizedDir: dir });
  assert.equal(v.ok, false, "verdict/status mismatch must not validate");
  assert.ok(v.errors.some((e) => e.includes("external_verdict_status_mismatch")), "mismatch error present");
});

// ── Q8 — PASS/REPAIR/HOLD next actions ────────────────────────────────────

test("Q8. NEXT_ACTION colocated; NOT_SPECIFIED when the lifecycle does not know", { timeout: 30000 }, async () => {
  const b = renderReviewBundle(mkSource(), { generatedAt: "2026-08-17T00:00:00.000Z" });
  const dec = sectionText(b.text, "External Review Decision");
  assert.ok(dec.includes("NEXT_ACTION:\n  IF_PASS: external review\n  IF_REPAIR: NOT_SPECIFIED\n  IF_HOLD: NOT_SPECIFIED"), "recommendedNextStep maps to IF_PASS; unknowns NOT_SPECIFIED");
  const noNext = renderReviewBundle(mkSource({ recommendedNextStep: null }), { generatedAt: "2026-08-17T00:00:00.000Z" });
  assert.ok(sectionText(noNext.text, "External Review Decision").includes("IF_PASS: NOT_SPECIFIED"), "unknown next step -> NOT_SPECIFIED");
});

// ── Q9 — repair / supersession lineage ────────────────────────────────────

test("Q9. Repair and Supersession Lineage renders machine fields + legacy aliases", { timeout: 30000 }, async () => {
  const source = mkSource({
    repairAttempts: [
      { attempt: 0, taskType: "external-review-superseding-repair", status: "REPAIR", resultIdentity: "graph:rbd:repair:0" },
    ],
    repairBudget: { maxAttempts: 1, used: 1 },
    repairLineage: { generationType: "repair-iteration", repairIterations: 1, surfaceReseals: 0, resealTouchedPaths: [] },
    externalReview: {
      deliveryRequired: true,
      status: "AWAITING_EXTERNAL_REVIEW",
      supersedes: { reviewBundleIdentity: "1".repeat(64), reviewBundleSha256: "2".repeat(64), bundlePath: "/tmp/prev-bundle.txt", verdict: "REPAIR" },
      verdict: null,
    },
  });
  const b = renderReviewBundle(source, { generatedAt: "2026-08-17T00:00:00.000Z" });
  const sec = sectionText(b.text, "Repair and Supersession Lineage");
  assert.ok(sec.includes("REPAIR_ATTEMPTS:\n  - attempt=0 taskType=external-review-superseding-repair status=REPAIR"), "attempt history preserved");
  assert.ok(sec.includes("REPAIR_BUDGET_MAX: 1"), "budget max");
  assert.ok(sec.includes("REPAIR_BUDGET_USED: 1"), "budget used");
  assert.ok(sec.includes("GENERATION_TYPE: repair-iteration"), "generation type");
  assert.ok(sec.includes("REPAIR_ITERATIONS: 1"), "canonical iterations");
  assert.ok(sec.includes("SURFACE_RESEALS: 0"), "canonical reseals");
  assert.ok(sec.includes("REPAIR_LINEAGE_REPAIR_ITERATIONS: 1"), "legacy alias iterations");
  assert.ok(sec.includes("REPAIR_LINEAGE_SURFACE_RESEALS: 0"), "legacy alias reseals");
  assert.ok(/CURRENT_BUNDLE_IDENTITY: [0-9a-f]{64}/.test(sec), "current bundle identity");
  assert.ok(sec.includes(`SUPERSEDES_BUNDLE_IDENTITY: ${"1".repeat(64)}`), "superseded identity");
  assert.ok(sec.includes(`SUPERSEDES_BUNDLE_SHA256: ${"2".repeat(64)}`), "superseded sha");
  assert.ok(sec.includes("SUPERSEDES_BUNDLE_VERDICT: REPAIR"), "superseded verdict");
  assert.ok(sec.includes("LINEAGE_SUMMARY: Bounded repair iteration (cumulative 1); supersedes bundle 11111111."), "lineage summary derived");
  // machine parsers still read the lineage（compatibility）
  assert.equal(parseRepairLineage(b.text).repairIterations, 1, "parseRepairLineage cumulative");
  const sup = supersedesFromBundleText(b.text);
  assert.equal(sup.supersedes.reviewBundleIdentity, "1".repeat(64), "supersedesFromBundleText");
  // first generation: NOT_APPLICABLE supersedes + explicit summary
  const first = renderReviewBundle(mkSource(), { generatedAt: "2026-08-17T00:00:00.000Z" });
  const fsec = sectionText(first.text, "Repair and Supersession Lineage");
  assert.ok(fsec.includes("SUPERSEDES_BUNDLE_IDENTITY: NOT_APPLICABLE"), "no fabricated lineage");
  assert.ok(fsec.includes("LINEAGE_SUMMARY: First-generation implementation; no supersession."), "first-generation summary");
});

// ── Q10 — empty-list deterministic rendering ──────────────────────────────

test("Q10. empty lists render the single canonical - none marker（J）", { timeout: 30000 }, async () => {
  const b = renderReviewBundle(mkSource({ files: { added: [], modified: [], deleted: [] }, risks: [], limitations: [], negativeCases: [], openQuestions: [], evidence: [] }), { generatedAt: "2026-08-17T00:00:00.000Z" });
  const txt = b.text;
  assert.ok(txt.includes("KNOWN_LIMITATIONS:\n  - none"), "decision KNOWN_LIMITATIONS");
  assert.ok(txt.includes("RISKS:\n  - none\nLIMITATIONS:\n  - none"), "section 21 deterministic markers（no duplicated (none) placeholder）");
  assert.ok(!txt.includes("(none)\n  (none)"), "banned duplicated placeholder absent");
  assert.ok(txt.includes("BLOCKING_FINDINGS:\n  - none"), "blocking findings canonical");
  assert.ok(txt.includes("ADDED:\n  - none"), "section 9 empty ADDED canonical");
  assert.ok(txt.includes("EVIDENCE_MANIFEST_DIGEST"), "empty evidence still binds the manifest digest");
  // deterministic across renders
  const b2 = renderReviewBundle(mkSource({ files: { added: [], modified: [], deleted: [] }, risks: [], limitations: [], negativeCases: [], openQuestions: [], evidence: [] }), { generatedAt: "2026-08-17T00:00:00.000Z" });
  assert.notEqual(b.text, b2.text, "different graphRunId -> different text");
  assert.equal((txt.match(/  - none\n/g) || []).length, (txt.match(/  - none\n/g) || []).length, "marker rendering deterministic");
});

// ── Q11 — implementation bundle dogfood（L1）──────────────────────────────

test("Q11. implementation bundle dogfood: gate-generated bundle carries a truthful decision section", { timeout: 30000 }, async () => {
  const ev = evFile("q11-ev.json", JSON.stringify({ ok: true }));
  const source = mkSource({
    whatChanged: ["Added the External Review Decision section to the review bundle renderer"],
    whatWasProven: ["Existing governance tests pass unchanged with the new layout"],
    nextActions: { pass: "rotate to promote the queued review", repair: null, hold: null },
    evidence: [{ path: ev, sha256: shaFile(ev) }],
  });
  const r = await gate(source);
  assert.equal(r.final, "PASS", `gate PASS (${r.reason})`);
  const txt = readFileSync(r.bundlePath, "utf8");
  const dec = sectionText(txt, "External Review Decision");
  assert.ok(dec.includes("WHAT_CHANGED:\n  - Added the External Review Decision section to the review bundle renderer"), "WHAT_CHANGED truthful");
  assert.ok(dec.includes("WHAT_WAS_PROVEN:\n  - Existing governance tests pass unchanged with the new layout"), "WHAT_WAS_PROVEN evidence-backed");
  assert.ok(dec.includes("VERDICT: PENDING"), "PENDING verdict");
  assert.ok(dec.includes("IF_PASS: rotate to promote the queued review"), "next action colocated");
});

// ── Q12 — no-source / lifecycle bundle dogfood（L2）───────────────────────

test("Q12. no-source card renders WHAT_CHANGED without invented code mutations", { timeout: 30000 }, async () => {
  const source = mkSource({
    task: { cardId: "RBD-LIFECYCLE", cardTitle: "Lifecycle Closeout", cardType: "closeout" },
    files: { added: [], modified: [], deleted: [], closeoutOutputs: ["docs/pi-graph-output/rbd-lifecycle/closeout-state.json"] },
    diffSummary: "NO_PRODUCTION_DIFF (lifecycle closeout)",
    objective: "operator/lifecycle closeout without source changes",
  });
  const b = renderReviewBundle(source, { generatedAt: "2026-08-17T00:00:00.000Z" });
  const dec = sectionText(b.text, "External Review Decision");
  assert.ok(dec.includes("WHAT_CHANGED:\n  - No source implementation changes.\n  - Produced closeout output: docs/pi-graph-output/rbd-lifecycle/closeout-state.json"), "no-source marker + actual output change");
  assert.ok(dec.includes("WHAT_WAS_PROVEN:\n  - NOT_RECORDED"), "no fabricated proof claims");
  const dir = join(OUT, "q12");
  mkdirSync(dir, { recursive: true });
  const w = writeReviewBundle(b, dir);
  assert.equal(validateReviewBundle(w.path, { authorizedDir: dir }).ok, true, "no-source bundle validates");
});

// ── Q13 — parser / backward compatibility（H）─────────────────────────────

test("Q13. legacy pre-convergence layout still validates; broken legacy fails", { timeout: 30000 }, async () => {
  const source = mkSource();
  const b = renderReviewBundle(source, { generatedAt: "2026-08-17T00:00:00.000Z" });
  // transform the canonical layout into the LEGACY layout（sections 1-23,
  // renamed 13/14, appended 24/25, no decision section）— the shape every
  // historical evidence bundle carries.
  const rule = "=".repeat(80) + "\n";
  const start = b.text.indexOf("\n10.5. External Review Decision\n");
  const end = b.text.indexOf("11. Execution Results");
  let legacy = b.text.slice(0, start + 1) + b.text.slice(end);
  legacy = legacy.replace("13. Internal Independent Review", "13. Independent Review Results");
  legacy = legacy.replace("14. Repair and Supersession Lineage", "14. Repair Attempts");
  const legacy24 = `${rule}24. Recommended Next Step\n${rule}external review\n\n`;
  const legacy25 = `${rule}25. External Reviewer Verdict Template\n${rule}VERDICT: PASS / REPAIR / HOLD\nREVIEWER_IDENTITY: <reviewer>\nREVIEWED_AT: <date>\n\n`;
  legacy = legacy.replace("=== END OF REVIEW BUNDLE ===", legacy24 + legacy25 + "=== END OF REVIEW BUNDLE ===");
  const content = legacy.split("\n").filter((l) => !l.startsWith("REVIEW_BUNDLE_SHA256:")).join("\n") + "\n";
  legacy = content + `REVIEW_BUNDLE_SHA256: ${createHash("sha256").update(content).digest("hex")}\n`;
  const dir = join(OUT, "q13");
  mkdirSync(dir, { recursive: true });
  const lp = join(dir, "legacy.txt");
  writeFileSync(lp, legacy);
  const lv = validateReviewBundle(lp, { authorizedDir: dir });
  assert.equal(lv.ok, true, `legacy layout validates (${lv.errors.join(";")})`);
  // the legacy required set is exactly the fixed 25-section historical set
  assert.equal(REVIEW_BUNDLE_SECTIONS_LEGACY.length, 25, "legacy set is the historical 25");
  // a legacy bundle missing one of its sections must fail closed
  const broken = legacy.replace(/^25\. External Reviewer Verdict Template.*$/m, "25. Something Else");
  const bp = join(dir, "broken.txt");
  writeFileSync(bp, broken);
  const bv = validateReviewBundle(bp, { authorizedDir: dir });
  assert.equal(bv.ok, false, "legacy missing section rejected");
  assert.ok(bv.errors.some((e) => e.includes("section_missing:External Reviewer Verdict Template")), "legacy section_missing error");
  // and the canonical layout is NOT the legacy set（the decision section
  // separates the two layouts deterministically）
  assert.ok(!REVIEW_BUNDLE_SECTIONS.includes("Recommended Next Step"), "canonical layout removed Recommended Next Step");
  assert.ok(!REVIEW_BUNDLE_SECTIONS.includes("External Reviewer Verdict Template"), "canonical layout removed the verdict template");
  assert.ok(REVIEW_BUNDLE_SECTIONS.includes("External Review Decision"), "canonical layout added the decision section");
});

// ── Q14 — LatestHuman publication（N）─────────────────────────────────────

test("Q14. LatestHuman receives the new-format report bytes verbatim", { timeout: 30000 }, async () => {
  const ev = evFile("q14-ev.json", JSON.stringify({ ok: true }));
  const source = mkSource({
    task: { cardId: "RBD-LATEST", cardTitle: "LatestHuman Handoff", cardType: "implementation" },
    graph: { graphRunId: "rbd-latest-1" },
    externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null, verdict: null },
    whatChanged: ["Converged the review bundle decision section"],
    whatWasProven: ["LatestHuman receives the new-format bundle verbatim"],
    evidence: [{ path: ev, sha256: shaFile(ev) }],
  });
  const r = await gate(source, { surfaceDir: SURFACE });
  assert.equal(r.final, "PASS", `delivery PASS (${r.reason})`);
  const human = humanReportTextPath(SURFACE);
  assert.ok(existsSync(human), "LatestHuman/latest-report.txt exists");
  const reportBytes = readFileSync(human, "utf8");
  assert.equal(reportBytes, readFileSync(r.bundlePath, "utf8"), "LatestHuman bytes == bundle bytes（new format, verbatim）");
  assert.ok(reportBytes.includes("10.5. External Review Decision"), "LatestHuman carries the new decision section");
  assert.ok(reportBytes.includes("VERDICT: PENDING"), "LatestHuman carries the pending verdict");
  assert.ok(!reportBytes.includes("External Reviewer Verdict Template"), "LatestHuman has no legacy tail template");
});

// ── Q15 — Current/Queue authority regression（R）───────────────────────────

test("Q15. Current/Queue authority unchanged: unresolved occupant never overwritten; queued deliveries stay queued", { timeout: 30000 }, async () => {
  const surfA = join(ROOT, "q15-current");
  mkdirSync(surfA, { recursive: true });
  const evA = evFile("q15-a.json", JSON.stringify({ a: 1 }));
  const sourceA = mkSource({
    task: { cardId: "RBD-Q15A", cardTitle: "Queue A", cardType: "implementation" },
    graph: { graphRunId: "rbd-q15a" },
    externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null, verdict: null },
    evidence: [{ path: evA, sha256: shaFile(evA) }],
  });
  const ra = await gate(sourceA, { surfaceDir: surfA });
  assert.equal(ra.final, "PASS", "A delivered");
  const currentBundle = readFileSync(join(surfA, "review-bundle.txt"), "utf8");
  assert.ok(existsSync(join(surfA, "delivery.json")), "Current/delivery.json present");
  // B is a DIFFERENT card -> queued behind the unresolved occupant, never an overwrite
  const evB = evFile("q15-b.json", JSON.stringify({ b: 1 }));
  const sourceB = mkSource({
    task: { cardId: "RBD-Q15B", cardTitle: "Queue B", cardType: "implementation" },
    graph: { graphRunId: "rbd-q15b" },
    externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null, verdict: null },
    evidence: [{ path: evB, sha256: shaFile(evB) }],
  });
  const rb = await gate(sourceB, { surfaceDir: surfA });
  assert.equal(rb.final, "PASS", "B delivery is a SUCCESS（queued, not surface_occupied failure）");
  assert.equal(readFileSync(join(surfA, "review-bundle.txt"), "utf8"), currentBundle, "unresolved Current occupant byte-identical");
  const queuePath = join(dirname(surfA), "Queue", "queue.json");
  assert.ok(existsSync(queuePath), "queue persisted");
  const queue = JSON.parse(readFileSync(queuePath, "utf8"));
  assert.ok(JSON.stringify(queue).includes("RBD-Q15B"), "B recorded as pending in the queue");
});

// ── Q16 — review generation regression ────────────────────────────────────

test("Q16. generation regression: same source -> deterministic identity/sha; regeneration validates", { timeout: 30000 }, async () => {
  const source = mkSource({ graph: { graphRunId: "rbd-det" } });
  const pinned = { generatedAt: "2026-08-17T00:00:00.000Z" };
  const b1 = renderReviewBundle(source, pinned);
  const b2 = renderReviewBundle(source, pinned);
  assert.equal(b1.identity, b2.identity, "identity deterministic");
  assert.equal(b1.sha256, b2.sha256, "sha256 deterministic");
  assert.equal(b1.text, b2.text, "text deterministic");
  const dir = join(OUT, "q16");
  mkdirSync(dir, { recursive: true });
  const w = writeReviewBundle(b1, dir);
  assert.equal(validateReviewBundle(w.path, { authorizedDir: dir }).ok, true, "regenerated bundle validates");
});

// ── Q17 — secret scan regression ──────────────────────────────────────────

test("Q17. secret scan regression: a secret in the decision-context field never reaches disk", { timeout: 30000 }, async () => {
  const secretOut = join(ROOT, "out-secret");
  mkdirSync(secretOut, { recursive: true });
  const source = mkSource({ whatWasProven: ['leak DEEPSEEK_API_KEY="sk-abcdefghijklmnopqrstuvwxyz123456"'] });
  const r = await runCloseoutGate({ source, repoPath: REPO_A, outDir: secretOut, timeoutMs: 5000, repoFacts: facts });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.SECRET_DETECTED);
  assert.ok(!r.bundlePath, "no bundle written for a secret-bearing decision context");
  assert.deepEqual(readdirSync(secretOut), [], "no bundle persisted");
});
