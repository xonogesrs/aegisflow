// test/governance/test-review-bundle.mjs
//
// RB-1 — Automatic Review Bundle Generation and Closeout Gate.
//
// Positive: implementation card bundle / research card (no diff) bundle /
// repair history / determinism / restart-verifiable / CBM-1-style backfill.
// Negative: crash / timeout / missing output / empty / missing section /
// wrong head-tree / wrong review identity / evidence hash mismatch /
// modified-after-generation sha mismatch / symlink / path escape / secret /
// truncation / placeholder / writer-fake-PASS-with-blocking /
// shallow-canonical-digest regression / temp-file residue / repo pollution /
// downstream-ordering.
//
// Run: node --test test/governance/test-review-bundle.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  REVIEW_BUNDLE_SOURCE_SCHEMA,
  REVIEW_BUNDLE_SECTIONS,
  REVIEW_BUNDLE_HOLDS,
  renderReviewBundle,
  writeReviewBundle,
  validateReviewBundle,
  runCloseoutGate,
  collectRepoFacts,
  reviewBundleIdentity,
  recursiveCanonicalJson,
  evidenceManifestDigest,
} from "../../src/governance/review-bundle.mjs";

const REPO_A = "/Volumes/NVM2T/Development/autoloop";
const ROOT = `${tmpdir()}/rb-test-${process.pid}`;
const OUT = join(ROOT, "out");
const EV = join(ROOT, "ev");
const repoEntriesBefore = spawnSync("git", ["-C", REPO_A, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

let bundleCount = 0;
function mkSource(overrides = {}) {
  bundleCount += 1;
  return {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: { cardId: "RB-TEST", cardTitle: "Review Bundle Test", cardType: "implementation" },
    graph: { graphRunId: `rb-test-${bundleCount}` },
    repo: { repository: facts.repository ?? null, branch: facts.branch, head: facts.head, treeSha: facts.treeSha, worktreePath: facts.worktreePath, baselineDirtyDigest: facts.baselineDirtyDigest, finalDirtyDigest: facts.finalDirtyDigest, remote: facts.remote },
    objective: "test review bundle generation",
    executiveStatus: "PASS",
    executiveSummary: "bundle generated and validated",
    authorizedScope: ["src/governance/review-bundle.mjs", "test/governance/test-review-bundle.mjs"],
    unauthorizedScope: ["commit", "push", "merge", "seal"],
    designDecisions: ["deterministic 25-section text bundle"],
    files: { added: ["src/governance/review-bundle.mjs"], modified: [], deleted: [] },
    diffSummary: "1 new governance module",
    execution: { testsExecuted: ["node --test test/governance/test-review-bundle.mjs"], testResults: { passed: 1, failed: 0, total: 1 }, pass: true },
    verifier: { pass: true, result: "PASS", summary: "verify PASS" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "f".repeat(64), blockingFindings: [], summary: "review PASS" },
    repairAttempts: [],
    negativeCases: ["fail-closed on missing bundle"],
    regression: [{ suite: "governance", tests: 1, pass: 1, fail: 0 }],
    evidence: [],
    security: { secretScanResult: "clean", ingestionAllowlist: ["repo tree, structured results"], ingestionDenylist: ["secrets, credentials, logs"] },
    risks: [], limitations: [],
    rollbackProcedure: "rm generated bundle and regenerate",
    openQuestions: [],
    recommendedNextStep: "CBM-2",
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
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  // main repo zero pollution（tests never add/remove files under repo A）
  const now = spawnSync("git", ["-C", REPO_A, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
  assert.equal(now, repoEntriesBefore, "main repo working tree unchanged by the test suite");
});

const facts = collectRepoFacts(REPO_A);
const gate = (source, opts = {}) => runCloseoutGate({ source, repoPath: REPO_A, outDir: OUT, timeoutMs: 5000, repoFacts: facts, ...opts });

// ── Positive ───────────────────────────────────────────────────────────────

test("1. implementation card auto-generates a validated bundle (PASS)", { timeout: 30000 }, async () => {
  const ev = evFile("ev-impl.json", JSON.stringify({ ok: true }));
  const source = mkSource({ evidence: [{ path: ev, sha256: shaFile(ev) }] });
  const r = await gate(source);
  assert.equal(r.final, "PASS", `final PASS (${r.reason})`);
  assert.equal(r.holdCode, null);
  assert.ok(r.bundlePath && existsSync(r.bundlePath), "bundle file written");
  assert.ok(/^[0-9a-f]{64}$/.test(r.bundle.identity));
  assert.ok(/^[0-9a-f]{64}$/.test(r.bundle.sha256));
  const txt = readFileSync(r.bundlePath, "utf8");
  assert.equal((txt.match(/^\d+\. [^\n]+$/gm) || []).length, 25, "25 sections");
  assert.ok(txt.includes("=== END OF REVIEW BUNDLE ==="), "terminator present");
  // identity fields bound
  assert.equal(txt.includes(`CARD_ID: RB-TEST`), true);
  assert.equal(txt.includes(`HEAD: ${facts.head}`), true, "head bound (git-derived)");
  assert.equal(txt.includes(`TREE_SHA: ${facts.treeSha}`), true, "tree bound");
});

test("2. research card with NO production diff still generates a complete bundle", { timeout: 30000 }, async () => {
  const doc = evFile("cbm1.md", "# research doc\nverdict PASS\n");
  const probeSrc = evFile("probe.mjs", "// probe\n");
  const probeRes = evFile("probe-result.json", '{"all_pass": true}');
  const sha = (p) => shaFile(p);
  const source = mkSource({
    task: { cardId: "CBM-1-TEST", cardTitle: "Research Test", cardType: "research" },
    objective: "read-only landscape research",
    files: { added: [], modified: [], deleted: [] },
    diffSummary: "NO_PRODUCTION_DIFF (research only)",
    designDecisions: ["SQLite primary / JSONL backup / vector not adopted"],
    research: {
      sourceMarkers: "SOURCE / DERIVED / INFERENCE / RECOMMENDATION",
      probe: { sourcePath: probeSrc, command: "node probe.mjs", resultPath: probeRes, summary: "7/7 probe checks PASS", cleanupNote: "tmp removed" },
    },
    evidence: [
      { path: doc, sha256: sha(doc) },
      { path: probeSrc, sha256: sha(probeSrc) },
      { path: probeRes, sha256: sha(probeRes) },
    ],
    executiveSummary: "research PASS; production untouched",
    recommendedNextStep: "CBM-2",
  });
  const r = await gate(source);
  assert.equal(r.final, "PASS", `research card PASS (${r.reason})`);
  const txt = readFileSync(r.bundlePath, "utf8");
  assert.ok(txt.includes("ADDED:\n  (none)"), "no production diff recorded");
  assert.ok(txt.includes("NO_PRODUCTION_DIFF"), "diff summary marks research-only");
  assert.ok(txt.includes("PROBE_SUMMARY: 7/7 probe checks PASS"), "probe result in bundle");
  assert.ok(txt.includes("SOURCE_MARKERS: SOURCE / DERIVED / INFERENCE / RECOMMENDATION"), "source markers preserved");
});

test("3. repair with final review PASS — bundle includes full attempt history", { timeout: 30000 }, async () => {
  const source = mkSource({
    repairAttempts: [
      { attempt: 0, taskType: "write_report_with_gap", status: "REPAIR", resultIdentity: "r0" },
      { attempt: 1, taskType: "repair_report", status: "PASS", resultIdentity: "r1" },
    ],
    repairBudget: { maxAttempts: 1, used: 1 },
    review: { pass: true, result: "PASS", reviewResultIdentity: "a".repeat(64), blockingFindings: [], summary: "re-review PASS" },
  });
  const r = await gate(source);
  assert.equal(r.final, "PASS");
  const txt = readFileSync(r.bundlePath, "utf8");
  assert.ok(txt.includes("attempt=0 taskType=write_report_with_gap status=REPAIR"), "attempt 0 history");
  assert.ok(txt.includes("attempt=1 taskType=repair_report status=PASS"), "attempt 1 history");
  assert.ok(txt.includes("REPAIR_BUDGET_MAX: 1"), "repair budget bound");
});

test("4. deterministic generation — same source -> same identity/sha256", { timeout: 30000 }, async () => {
  const ev = evFile("ev-det.json", "det");
  const sha = createHash("sha256").update("det").digest("hex");
  const s1 = mkSource({ evidence: [{ path: ev, sha256: sha }] });
  // Pin generatedAt: the wall-clock timestamp is intentionally part of the
  // artifact text（GENERATED_AT header）but NOT of the content identity, so
  // content-determinism must be asserted with a fixed timestamp.
  const pinned = { generatedAt: "2026-08-07T00:00:00.000Z" };
  const b1 = renderReviewBundle(s1, pinned);
  const b2 = renderReviewBundle(s1, pinned);
  assert.equal(b1.identity, b2.identity, "identity deterministic");
  assert.equal(b1.sha256, b2.sha256, "sha256 deterministic");
  assert.equal(b1.text, b2.text, "text deterministic");
  // a different source must differ
  const s3 = mkSource({ objective: "different objective", evidence: [{ path: ev, sha256: sha }] });
  const b3 = renderReviewBundle(s3, pinned);
  assert.notEqual(b1.identity, b3.identity, "identity changes with content");
});

test("5. process restart — an existing bundle on disk still validates（no regeneration needed）", { timeout: 30000 }, async () => {
  const ev = evFile("ev-restart.json", "restart");
  const sha = createHash("sha256").update("restart").digest("hex");
  const source = mkSource({ graph: { graphRunId: "restart-1" }, evidence: [{ path: ev, sha256: sha }] });
  const r = await gate(source);
  assert.equal(r.final, "PASS");
  // simulate a fresh process: validate purely from disk with the context
  const v = validateReviewBundle(r.bundlePath, {
    authorizedDir: OUT,
    expected: {
      taskId: "RB-TEST",
      repository: facts.repository ?? null,
      branch: facts.branch,
      head: facts.head,
      treeSha: facts.treeSha,
      graphRunId: "restart-1",
      reviewResultIdentity: "f".repeat(64),
      evidenceManifestDigest: r.bundle.evidenceManifestDigest,
    },
  });
  assert.equal(v.ok, true, `restart validation ok (${v.errors.join(";")})`);
});

test("6. CBM-1-style backfill bundle passes validation", { timeout: 30000 }, async () => {
  const doc = evFile("cbm1-real.md", "CBM-1 landscape research (real backfill shape)");
  const probeRes = evFile("cbm1-probe.json", '{"all_pass": true, "checks": 7}');
  const sha = (p) => shaFile(p);
  const source = mkSource({
    task: { cardId: "AUTOLOOP-PI-GRAPH-CBM1-1", cardTitle: "CBM-1 Existing Landscape and Contract Boundary Research", cardType: "research" },
    graph: { graphRunId: "cbm1-backfill" },
    executiveStatus: "PASS",
    files: { added: [], modified: [], deleted: [] },
    diffSummary: "NO_PRODUCTION_DIFF (research backfill)",
    designDecisions: [
      "SQLite (node:sqlite, FTS5) primary; JSON/JSONL backup; vector not adopted",
      "identity bound to validity_tree; stale exclusion on tree change",
      "recursive canonical JSON digest (CBM-1 shallow-replacer defect codified)",
    ],
    research: {
      sourceMarkers: "SOURCE / DERIVED / INFERENCE / RECOMMENDATION",
      probe: { sourcePath: "probe/cbm1-memory-probe.mjs", command: "node cbm1-memory-probe.mjs", resultPath: "cbm1-probe-result.json", summary: "7/7 PASS incl. canonical-digest defect", cleanupNote: "probe-tmp removed" },
    },
    evidence: [
      { path: doc, sha256: sha(doc) },
      { path: probeRes, sha256: sha(probeRes) },
    ],
    security: { secretScanResult: "clean", ingestionAllowlist: ["repo tree, structured results, review results, rulings"], ingestionDenylist: ["secrets, credentials, private keys, logs, db contents, user data"] },
    recommendedNextStep: "CBM-2 Memory Contract and Schema Definition",
  });
  const r = await gate(source);
  assert.equal(r.final, "PASS", `backfill PASS (${r.reason})`);
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: OUT });
  assert.equal(v.ok, true, v.errors.join(";"));
  assert.ok(readFileSync(r.bundlePath, "utf8").includes("recursive canonical JSON digest"), "canonical-defect note preserved");
});

// ── Negative ───────────────────────────────────────────────────────────────

test("7. generator crash -> HOLD REVIEW_BUNDLE_GENERATION_FAILED", { timeout: 30000 }, async () => {
  const r = await gate(mkSource(), { generate: async () => { throw new Error("boom"); } });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.GENERATION_FAILED);
});

test("8. generator timeout -> HOLD REVIEW_BUNDLE_GENERATION_FAILED", { timeout: 30000 }, async () => {
  const r = await gate(mkSource(), { generate: async () => { await new Promise((res) => setTimeout(res, 1000)); return { text: "x" }; }, timeoutMs: 50 });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.GENERATION_FAILED);
});

test("9. output missing -> HOLD REVIEW_BUNDLE_MISSING", { timeout: 30000 }, async () => {
  const v = validateReviewBundle(join(OUT, "does-not-exist.txt"), { authorizedDir: OUT });
  assert.equal(v.ok, false);
  assert.equal(v.holdCode, REVIEW_BUNDLE_HOLDS.MISSING);
});

test("10. empty file -> HOLD REVIEW_BUNDLE_INVALID", { timeout: 30000 }, async () => {
  const p = join(OUT, "empty.txt");
  writeFileSync(p, "");
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, false);
  assert.equal(v.holdCode, REVIEW_BUNDLE_HOLDS.INVALID);
  assert.ok(v.errors.some((e) => e.includes("empty_file")), "empty_file error");
});

test("11. missing required section -> HOLD REVIEW_BUNDLE_INVALID", { timeout: 30000 }, async () => {
  const ev = evFile("ev-sec.json", "sec");
  const sha = createHash("sha256").update("sec").digest("hex");
  const b = renderReviewBundle(mkSource({ evidence: [{ path: ev, sha256: sha }] }));
  const p = join(OUT, "missing-section.txt");
  const broken = b.text.replace(/^5\. Objective$/m, "5. Objective X");
  writeFileSync(p, broken);
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("section_missing")), "section_missing error");
});

test("12. wrong HEAD/tree -> HOLD REVIEW_BUNDLE_IDENTITY_MISMATCH", { timeout: 30000 }, async () => {
  const ev = evFile("ev-head.json", "head");
  const sha = createHash("sha256").update("head").digest("hex");
  const source = mkSource({ evidence: [{ path: ev, sha256: sha }] });
  const r = await gate(source);
  assert.equal(r.final, "PASS");
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: OUT, expected: { head: "0".repeat(40), treeSha: "1".repeat(40) } });
  assert.equal(v.ok, false);
  assert.equal(v.holdCode, REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH);
  assert.ok(v.errors.some((e) => e.includes("head_mismatch")), "head_mismatch");
});

test("13. wrong review result identity -> HOLD REVIEW_BUNDLE_IDENTITY_MISMATCH", { timeout: 30000 }, async () => {
  const ev = evFile("ev-review.json", "review");
  const sha = createHash("sha256").update("review").digest("hex");
  const source = mkSource({ evidence: [{ path: ev, sha256: sha }] });
  const r = await gate(source);
  assert.equal(r.final, "PASS");
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: OUT, expected: { reviewResultIdentity: "0".repeat(64) } });
  assert.equal(v.ok, false);
  assert.equal(v.holdCode, REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH);
  assert.ok(v.errors.some((e) => e.includes("review_result_identity_mismatch")), "review identity mismatch");
});

test("14. evidence hash mismatch -> HOLD", { timeout: 30000 }, async () => {
  const ev = evFile("ev-hash.json", "original");
  const sha = createHash("sha256").update("original").digest("hex");
  const source = mkSource({ evidence: [{ path: ev, sha256: sha }] });
  const r = await gate(source);
  assert.equal(r.final, "PASS");
  // a) wrong expected manifest digest -> IDENTITY_MISMATCH
  const v1 = validateReviewBundle(r.bundlePath, { authorizedDir: OUT, expected: { evidenceManifestDigest: "0".repeat(64) } });
  assert.equal(v1.ok, false);
  assert.equal(v1.holdCode, REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH);
  // b) evidence file content changed after generation -> per-file hash mismatch
  writeFileSync(ev, "tampered");
  const v2 = validateReviewBundle(r.bundlePath, { authorizedDir: OUT });
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.includes("evidence_hash_mismatch")), "per-file evidence hash mismatch");
});

test("15. bundle modified after generation -> SHA mismatch -> HOLD REVIEW_BUNDLE_INVALID", { timeout: 30000 }, async () => {
  const ev = evFile("ev-mod.json", "mod");
  const sha = createHash("sha256").update("mod").digest("hex");
  const source = mkSource({ evidence: [{ path: ev, sha256: sha }] });
  const r = await gate(source);
  assert.equal(r.final, "PASS");
  const p = join(OUT, "modified.txt");
  const txt = readFileSync(r.bundlePath, "utf8").replace("EXECUTIVE_STATUS: PASS", "EXECUTIVE_STATUS: HOLD");
  writeFileSync(p, txt);
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("bundle_sha256_mismatch")), "sha mismatch on tamper");
});

test("16. symlink output -> HOLD REVIEW_BUNDLE_INVALID", { timeout: 30000 }, async () => {
  const real = join(OUT, "real.txt");
  writeFileSync(real, "x");
  const link = join(OUT, "link.txt");
  try { rmSync(link, { force: true }); } catch { /* */ }
  symlinkSync(real, link);
  const v = validateReviewBundle(link, { authorizedDir: OUT });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("symlink_output")), "symlink rejected");
});

test("17. path escape outside authorized dir -> HOLD", { timeout: 30000 }, async () => {
  const ev = evFile("ev-esc.json", "esc");
  const sha = createHash("sha256").update("esc").digest("hex");
  const b = renderReviewBundle(mkSource({ evidence: [{ path: ev, sha256: sha }] }));
  const outside = join(ROOT, "outside-bundle.txt");
  writeReviewBundle(b, ROOT, { fileName: "outside-bundle.txt" });
  const v = validateReviewBundle(outside, { authorizedDir: OUT });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("path_outside_authorized_dir")), "escape rejected");
});

test("18. secret injection -> HOLD REVIEW_BUNDLE_SECRET_DETECTED (never written to disk)", { timeout: 30000 }, async () => {
  const secretOut = join(ROOT, "out-secret");
  mkdirSync(secretOut, { recursive: true });
  const source = mkSource({ executiveSummary: 'leak DEEPSEEK_API_KEY="sk-abcdefghijklmnopqrstuvwxyz123456"' });
  const r = await runCloseoutGate({ source, repoPath: REPO_A, outDir: secretOut, timeoutMs: 5000, repoFacts: facts });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.SECRET_DETECTED);
  assert.ok(!r.bundlePath, "no bundle written for a secret-bearing source");
  assert.deepEqual(readdirSync(secretOut), [], "no bundle file persisted (pre-write scan)");
});

test("19. truncated write -> HOLD REVIEW_BUNDLE_INVALID", { timeout: 30000 }, async () => {
  const ev = evFile("ev-trunc.json", "trunc");
  const sha = createHash("sha256").update("trunc").digest("hex");
  const b = renderReviewBundle(mkSource({ evidence: [{ path: ev, sha256: sha }] }));
  const p = join(OUT, "truncated.txt");
  writeFileSync(p, b.text.slice(0, Math.floor(b.text.length * 0.6)));
  const v = validateReviewBundle(p, { authorizedDir: OUT });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("truncated_missing_terminator")), "truncation detected");
});

test("20. unresolved placeholder -> HOLD REVIEW_BUNDLE_INVALID", { timeout: 30000 }, async () => {
  const source = mkSource({ objective: "implement the <TODO> item" });
  const r = await gate(source);
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.INVALID);
  assert.ok(r.reason.includes("unresolved_placeholder"), "placeholder detected");
});

test("21. writer fake PASS but review has blocking findings -> HOLD（no final PASS）", { timeout: 30000 }, async () => {
  const source = mkSource({
    executiveStatus: "PASS",
    review: { pass: false, result: "REPAIR", reviewResultIdentity: "b".repeat(64), blockingFindings: ["CLAIM_R2_MISSING"], summary: "review found gap" },
    execution: { testsExecuted: [], testResults: { passed: 1, failed: 0, total: 1 }, pass: true },
    verifier: { pass: true, result: "PASS", summary: "verify PASS" },
  });
  const r = await gate(source);
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, REVIEW_BUNDLE_HOLDS.INVALID);
  assert.ok(r.reason.includes("pass_closeout_with_blocking_review"), "blocking review blocks PASS closeout");
  assert.ok(!r.bundlePath, "no bundle emitted");
});

test("22. shallow canonical digest collision regression（CBM-1 defect must never return）", { timeout: 30000 }, async () => {
  const arr1 = [{ key: "k", content_hash: "h1" }, { key: "k2", content_hash: "h2" }];
  const arr2 = [{ key: "k", content_hash: "DIFFERENT_VALUE" }, { key: "k2", content_hash: "h2" }];
  // the defective form collides（count-only）
  const shallow1 = JSON.stringify(arr1, Object.keys(arr1).sort());
  const shallow2 = JSON.stringify(arr2, Object.keys(arr2).sort());
  assert.equal(shallow1, shallow2, "shallow replacer collides — this is the CBM-1 defect");
  // the mandated recursive form distinguishes field content
  assert.notEqual(recursiveCanonicalJson(arr1), recursiveCanonicalJson(arr2), "recursive canonical is content-sensitive");
  // identity must be content-sensitive too
  const id1 = reviewBundleIdentity({ cardId: "X", cardTitle: "T", cardType: "implementation", head: "a".repeat(40), treeSha: "b".repeat(40), graphRunId: "g", finalReviewResultIdentity: "c".repeat(64), evidenceManifestDigest: evidenceManifestDigest([{ path: "p", sha256: "d".repeat(64) }]) });
  const id2 = reviewBundleIdentity({ cardId: "X", cardTitle: "T", cardType: "implementation", head: "a".repeat(40), treeSha: "b".repeat(40), graphRunId: "g", finalReviewResultIdentity: "c".repeat(64), evidenceManifestDigest: evidenceManifestDigest([{ path: "p", sha256: "e".repeat(64) }]) });
  assert.notEqual(id1, id2, "identity changes when an evidence hash differs");
});

test("23. rerun leaves no temporary files", { timeout: 30000 }, async () => {
  const ev = evFile("ev-tmp.json", "tmp");
  const sha = createHash("sha256").update("tmp").digest("hex");
  const source = mkSource({ evidence: [{ path: ev, sha256: sha }] });
  await gate(source);
  await gate(source);
  const leftovers = readdirSync(OUT).filter((f) => f.includes(".tmp-") || f.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no temp files after rerun");
});

test("24. main repo zero pollution（covered by after-hook + explicit check）", { timeout: 30000 }, async () => {
  const ev = evFile("ev-poll.json", "poll");
  const sha = createHash("sha256").update("poll").digest("hex");
  const source = mkSource({ evidence: [{ path: ev, sha256: sha }] });
  const r = await gate(source);
  assert.equal(r.final, "PASS");
  const now = spawnSync("git", ["-C", REPO_A, "status", "--porcelain"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).length;
  assert.equal(now, repoEntriesBefore, "no new repo A entries from this test");
});

test("25. downstream closeout never starts before bundle READY", { timeout: 30000 }, async () => {
  const orderOut = join(ROOT, "out-order");
  mkdirSync(orderOut, { recursive: true });
  // a) no completed final review -> HOLD MISSING, no bundle written
  const noReview = mkSource();
  delete noReview.review;
  const r1 = await runCloseoutGate({ source: noReview, repoPath: REPO_A, outDir: orderOut, timeoutMs: 5000, repoFacts: facts });
  assert.equal(r1.final, "HOLD");
  assert.equal(r1.holdCode, REVIEW_BUNDLE_HOLDS.MISSING);
  assert.ok(!r1.bundlePath, "no downstream signal (bundlePath absent)");
  assert.deepEqual(readdirSync(orderOut), [], "no bundle emitted before review completed");
  // b) a gate that fails validation must not yield PASS（downstream blocked）
  const ev = evFile("ev-order.json", "order");
  const sha = createHash("sha256").update("order").digest("hex");
  const r2 = await gate(mkSource({ evidence: [{ path: ev, sha256: sha }] }), {
    validate: () => ({ ok: false, errors: ["REVIEW_BUNDLE_INVALID:injected"], holdCode: REVIEW_BUNDLE_HOLDS.INVALID }),
  });
  assert.equal(r2.final, "HOLD");
  assert.notEqual(r2.final, "PASS", "downstream closeout blocked before bundle READY");
});

test("sanity: all 25 sections are the controller's fixed set", { timeout: 30000 }, async () => {
  assert.deepEqual([...REVIEW_BUNDLE_SECTIONS], [
    "Review Request",
    "Executive Status",
    "Task Identity",
    "Repository and Worktree Identity",
    "Objective",
    "Authorized Scope",
    "Explicitly Unauthorized Scope",
    "Architecture and Design Decisions",
    "Files Added / Modified / Deleted",
    "Diff Summary",
    "Execution Results",
    "Verification Results",
    "Independent Review Results",
    "Repair Attempts",
    "Negative and Fail-Closed Cases",
    "Regression Results",
    "Evidence Inventory",
    "Evidence Hashes",
    "Security and Secret Scan",
    "Repository Integrity",
    "Known Risks and Limitations",
    "Rollback Procedure",
    "Open Questions",
    "Recommended Next Step",
    "External Reviewer Verdict Template",
  ]);
});
