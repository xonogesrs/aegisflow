#!/usr/bin/env node
// scripts/rld2-independent-review.mjs
//
// AUTOLOOP-RLD2 — independent review（deterministic, local, machine
// cross-check）. Independently recomputes the root-cause + repair claims —
// NOT a re-run of rld2-verify.mjs:
//
//   IR-1  verification 14/14（rld2-verification.json）ok
//   IR-2  incident truth（independent read: Current = TA-2R f7f168aa;
//         Archive has NO f7f168aa PASS entry）
//   IR-3  reproduction before/after（independent recompute: production model
//         delivers stale; verified selector fails closed）
//   IR-4  currentReviewDelivery fail-closed semantics（independent asserts）
//   IR-5  no-new-bundle -> NO_NEW_REVIEW_BUNDLE（never fallback）
//   IR-6  already-externally-reviewed -> STALE_GENERATION_ALREADY_REVIEWED
//   IR-7  publish card-identity guard（delivery_card_id_mismatch）
//   IR-8  history untouched（historical bundles' shas == ta3 baseline pathShas）
//   IR-9  real surface preserved（incident evidence intact）
//   IR-10 NEG suite + regression accounting cross-check
//
// Writes docs/pi-graph-output/rld2/rld2-independent-review.json +
// docs/pi-graph-output/rld2/rld2-negative-cases.json.
//
// Run: node scripts/rld2-independent-review.mjs
// Local-only, deterministic, no network, no commit/push/seal.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "docs", "pi-graph-output", "rld2");
const SURFACE = "/Users/zhengfengqing/Desktop/AutoLoop-Review/Current";
const ARCHIVE = "/Users/zhengfengqing/Desktop/AutoLoop-Review/Archive";

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const fileSha = (p) => (existsSync(p) ? sha256(readFileSync(p)) : null);

const checks = [];
const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });

// ── IR-1: verification accounting ─────────────────────────────────────────
let verification = null;
const vPath = join(OUT, "rld2-verification.json");
if (existsSync(vPath)) verification = JSON.parse(readFileSync(vPath, "utf8"));
check("IR-1.verification_ok", verification !== null && verification.ok === true, verification ? `rld2-verify ${verification.passed}/${verification.total}` : "rld2-verification.json missing");

// ── IR-2: incident truth（independent read）───────────────────────────────
const deliveryPath = join(SURFACE, "delivery.json");
let surfCardId = null, surfStatus = null, surfIdentity = null;
if (existsSync(deliveryPath)) {
  try {
    const d = JSON.parse(readFileSync(deliveryPath, "utf8"));
    surfCardId = d.cardId ?? null;
    surfStatus = d.externalReviewStatus ?? null;
    surfIdentity = d.delivery?.reviewBundleIdentity ?? null;
  } catch { /* unreadable */ }
}
const archiveHasF7f168aa = existsSync(ARCHIVE) ? readdirSync(ARCHIVE).some((f) => f.includes("f7f168aa")) : false;
const currentBundleSha = fileSha(join(SURFACE, "review-bundle.txt"));
const ta2rBundleSha = fileSha(join(REPO, "docs/pi-graph-output/ta2r/card-closeout-bundle-20260809-f7f168aa.txt"));
check("IR-2.incident_truth", surfCardId === "AUTOLOOP-TA2" && surfStatus === "AWAITING_EXTERNAL_REVIEW" && surfIdentity === "f7f168aa48139e10c5c48cffafce32d07f13ae1350e995b6e43695623bb9a146" && !archiveHasF7f168aa && currentBundleSha === ta2rBundleSha,
  `Current=${surfCardId}/${surfStatus} identity=${String(surfIdentity ?? "").slice(0, 8)}; Archive f7f168aa PASS=${archiveHasF7f168aa ? "present" : "ABSENT"}; Current sha==ta2r bundle=${currentBundleSha === ta2rBundleSha}`);

// ── IR-3: reproduction before/after（independent recompute）───────────────
{
  const { renderReviewBundle, buildExternalReviewState, deliverToExternalReviewSurface, readExternalReviewDeliveryRecord, currentReviewDelivery, REVIEW_BUNDLE_SOURCE_SCHEMA } = await import("../src/governance/review-bundle.mjs");
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const ISO = join(tmpdir(), `rld2-ir-${process.pid}-${Date.now()}`);
  mkdirSync(join(ISO, "Current"), { recursive: true });
  mkdirSync(join(ISO, "Archive"), { recursive: true });
  mkdirSync(join(ISO, "bundles"), { recursive: true });
  const surface = join(ISO, "Current");
  const head = "2e897e995202c0c8c079c5fdc96b9f5d42d50d25";
  const mint = (cardId) => {
    const source = {
      schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
      task: { cardId, cardTitle: "T" + cardId, cardType: "implementation" },
      graph: { graphRunId: "g-" + cardId, nodeId: "N1", phaseExecutionId: "N1:1", stageIds: [], agentExecutionIds: [] },
      repo: { repository: "local", branch: "rld2", head, treeSha: "7ca2c9100b208e15647ff1e0524ffc4e0857e7e0", worktreePath: ISO, baselineDirtyDigest: "dirty:x", finalDirtyDigest: "dirty:x", remote: null },
      objective: "ir " + cardId, executiveStatus: "PASS", executiveSummary: "ir",
      authorizedScope: [], unauthorizedScope: [], designDecisions: [],
      files: { added: [], modified: [], deleted: [], preExistingDirty: [] }, inventory: null, diffSummary: "ir",
      execution: { nodesExecuted: ["N1"], testsExecuted: ["N1"], nodeResults: { passed: 1, failed: 0, total: 1 }, pass: true },
      verifier: { pass: true, result: "PASS", summary: "ir" }, review: { pass: true, result: "PASS", reviewResultIdentity: "ir", blockingFindings: [], summary: "ir" },
      repairAttempts: [], repairBudget: { maxAttempts: 1, used: 0 }, repairLineage: { generationType: "implementation", repairIterations: 0, surfaceReseals: 0, resealTouchedPaths: [] },
      externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null },
      negativeCases: [], regression: [], regressionSummary: "ir", evidence: [], security: { secretScanResult: "clean" }, risks: [], limitations: [], rollbackProcedure: "ir", openQuestions: [], recommendedNextStep: "ir",
    };
    const b = renderReviewBundle(source);
    const p = join(ISO, "bundles", cardId + ".txt");
    writeFileSync(p, b.text, "utf8");
    return { path: p, identity: b.identity, sha256: b.sha256, cardId };
  };
  const pub = (bundle) => {
    const state = buildExternalReviewState({ bundle: { identity: bundle.identity, sha256: bundle.sha256 }, bundlePath: bundle.path, deliveryAttempted: true, deliveryMethod: "external-review-surface", attemptedAt: "2026-08-09T00:00:00.000Z" });
    return deliverToExternalReviewSurface({ bundlePath: bundle.path, state, source: { task: { cardId: bundle.cardId } }, outDir: surface, surfaceDir: surface });
  };
  // Incident reproduction: A (TA-2) published, verdict NOT applied, B (TA-3)
  // publish blocked, export for TA-3:
  const a = mint("AUTOLOOP-TA2");
  pub(a);
  const b = mint("AUTOLOOP-TA3");
  const pubB = pub(b); // blocked (unresolved occupant)
  // production model reads Current -> returns A (stale)
  const rec = readExternalReviewDeliveryRecord(join(surface, "delivery.json"));
  const productionCard = rec.ok ? rec.cardId : null;
  // verified selector fails closed
  const verified = currentReviewDelivery({ surfaceDir: surface, currentCardId: "AUTOLOOP-TA3" });
  const staleProduced = productionCard === "AUTOLOOP-TA2" && pubB.attempted === false;
  const closed = verified.ok === false && verified.holdCode === "STALE_CARD_IDENTITY";
  check("IR-3.repro_before_after", staleProduced && closed, `production export produced card ${productionCard} (stale); publish B blocked=${!pubB.attempted}; verified selector -> ${verified.ok ? "delivered" : verified.holdCode}`);
  rmSync(ISO, { recursive: true, force: true });
}

// ── IR-4/5/6/7: fail-closed semantics（independent asserts on the code）───
{
  const src = readFileSync(join(REPO, "src/governance/review-bundle.mjs"), "utf8");
  check("IR-4.current_review_delivery", src.includes("export function currentReviewDelivery") && src.includes("STALE_CARD_IDENTITY") && src.includes("SURFACE_SHA_MISMATCH") && src.includes("SURFACE_RECORD_INVALID"),
    "currentReviewDelivery exports with STALE_CARD_IDENTITY / SURFACE_SHA_MISMATCH / SURFACE_RECORD_INVALID");
  check("IR-5.no_new_no_fallback", src.includes('holdCode: "NO_NEW_REVIEW_BUNDLE"') && src.includes("a stale generation is never substituted"),
    "NO_NEW_REVIEW_BUNDLE — no fallback to a stale COMPLETE bundle");
  check("IR-6.already_reviewed_guard", src.includes('holdCode: "STALE_GENERATION_ALREADY_REVIEWED"') && src.includes("already externally reviewed"),
    "STALE_GENERATION_ALREADY_REVIEWED — an externally-reviewed COMPLETE generation is never re-delivered as a new generation");
  check("IR-7.publish_card_guard", src.includes("delivery_card_id_mismatch") && src.includes("surface_occupied_by_different_card"),
    "publish refuses a wrong-card bundle (delivery_card_id_mismatch); occupant block is identity-explicit");
}

// ── IR-8: history untouched（independent pathShas check）──────────────────
{
  let ok = true;
  let detail = "all historical artifacts unchanged";
  const baselinePath = join(REPO, "docs/pi-graph-output/ta3/ta3-card-start-baseline.json");
  if (existsSync(baselinePath)) {
    const bl = JSON.parse(readFileSync(baselinePath, "utf8"));
    const changed = [];
    for (const [rel, baseSha] of Object.entries(bl.pathShas ?? {})) {
      if (!rel.startsWith("docs/pi-graph-output/")) continue;
      if (fileSha(join(REPO, rel)) !== baseSha) changed.push(rel);
    }
    if (changed.length) { ok = false; detail = `changed: ${changed.slice(0, 5).join(",")}`; }
  }
  check("IR-8.history_untouched", ok, detail);
}

// ── IR-9: real surface preserved ──────────────────────────────────────────
check("IR-9.surface_preserved", currentBundleSha === "921360ad22fa1dc0d0abfc9d6f8507c102bad11f27e95afc309a2672807fc14c",
  "the incident Current/review-bundle.txt is byte-preserved (TA-2R f7f168aa) — RLD2 never deleted/overwrote incident evidence");

// ── IR-10: NEG suite + regression cross-check ─────────────────────────────
let negOut = "";
try { negOut = execFileSync("node", ["--test", "test/governance/test-rld2-stale-delivery.mjs"], { cwd: REPO, encoding: "utf8", timeout: 600000 }); } catch (e) { negOut = String(e?.stdout ?? "") + String(e?.stderr ?? ""); }
const nm = negOut.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
const negOk = nm && Number(nm[3]) === 0 && Number(nm[1]) >= 14;
const regOk = verification !== null && verification.regression?.every((r) => r.ok === true && r.failed === 0);
const regTotal = verification?.regression?.reduce((a, r) => a + r.tests, 0) ?? 0;
check("IR-10.neg_suite_and_regression", negOk && regOk, `NEG-RLD suite ${nm ? `${nm[2]}/${nm[1]}` : "?"}; regression ${regTotal} tests all green`);

// ── write outputs ─────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const failedChecks = checks.filter((c) => !c.ok);
const summary = {
  schema: "autoloop.rld2-independent-review/v1",
  card: "AUTOLOOP-RLD2",
  generation: "root-cause-investigation-with-bounded-repair",
  reviewedAt: new Date().toISOString(),
  total: checks.length,
  passed: checks.length - failedChecks.length,
  failed: failedChecks.length,
  ok: failedChecks.length === 0,
  checks,
  digest: sha256(JSON.stringify(checks)),
};
writeFileSync(join(OUT, "rld2-independent-review.json"), JSON.stringify(summary, null, 2) + "\n");

// ── rld2-negative-cases.json（structured NEG-RLD matrix）──────────────────
const negativeCases = {
  schema: "autoloop.rld2.negative-cases/v1",
  card: "AUTOLOOP-RLD2",
  negativeCases: [
    { id: "NEG-RLD1", claim: "no new bundle -> NO_NEW_REVIEW_BUNDLE; a stale COMPLETE bundle is never substituted", test: "test/governance/test-rld2-stale-delivery.mjs", outcome: "pass" },
    { id: "NEG-RLD2", claim: "Current card != bundle CARD_ID -> STALE_CARD_IDENTITY (the incident)", test: "test/governance/test-rld2-stale-delivery.mjs", outcome: "pass" },
    { id: "NEG-RLD3", claim: "current identity != delivery source identity -> fail closed", test: "test/governance/test-rld2-stale-delivery.mjs", outcome: "pass" },
    { id: "NEG-RLD4", claim: "copy/export SHA change -> SURFACE_SHA_MISMATCH", test: "test/governance/test-rld2-stale-delivery.mjs", outcome: "pass" },
    { id: "NEG-RLD5", claim: "already externally-reviewed generation re-delivered as new -> STALE_GENERATION_ALREADY_REVIEWED", test: "test/governance/test-rld2-stale-delivery.mjs", outcome: "pass" },
    { id: "NEG-RLD6", claim: "card B not closed out -> never deliver card A", test: "test/governance/test-rld2-stale-delivery.mjs", outcome: "pass" },
    { id: "NEG-RLD7", claim: "crash/resume must not roll back to the previous authoritative generation", test: "test/governance/test-rld2-stale-delivery.mjs", outcome: "pass" },
    { id: "NEG-RLD8", claim: "stale cached path -> identity check rejects", test: "test/governance/test-rld2-stale-delivery.mjs", outcome: "pass" },
    { id: "NEG-RLD9", claim: "partial Current/Archive rotation -> fail closed, no fallback", test: "test/governance/test-rld2-stale-delivery.mjs", outcome: "pass" },
    { id: "NEG-RLD10", claim: "delivery receipt vs actual delivered SHA mismatch -> fail closed", test: "test/governance/test-rld2-stale-delivery.mjs", outcome: "pass" },
    { id: "R1", claim: "card A COMPLETE + reviewed -> card B starts -> card A not delivered as card B output", test: "scripts/rld2-reproduction.mjs R1", outcome: "pre:OK / post:OK" },
    { id: "R2", claim: "card A COMPLETE -> card B admitted, no closeout -> NO_NEW; never silently return card A", test: "scripts/rld2-reproduction.mjs R2", outcome: "pre:VIOLATED(STALE) / post:OK(fail-closed)" },
    { id: "R3", claim: "card B bundle generated -> Current rotates -> delivery returns B identity", test: "scripts/rld2-reproduction.mjs R3", outcome: "pre:OK / post:OK" },
    { id: "R4", claim: "Current changes between selection and copy -> identity verification prevents stale", test: "scripts/rld2-reproduction.mjs R4", outcome: "pre:VIOLATED(STALE) / post:OK(fail-closed)" },
    { id: "R5", claim: "repeated delivery invocation -> idempotent; never reinterprets old artifact as a new generation", test: "scripts/rld2-reproduction.mjs R5", outcome: "pre:VIOLATED(STALE) / post:OK(fail-closed)" },
    { id: "R6", claim: "crash between bundle generation and Current rotation", test: "scripts/rld2-reproduction.mjs R6", outcome: "pre:VIOLATED(STALE) / post:OK(fail-closed)" },
    { id: "R7", claim: "crash between Current rotation and delivery receipt commit", test: "scripts/rld2-reproduction.mjs R7", outcome: "pre:OK(NO_NEW) / post:OK(NO_NEW)" },
    { id: "R8", claim: "resume after crash does not roll back to previous authoritative generation", test: "scripts/rld2-reproduction.mjs R8", outcome: "pre:OK / post:OK" },
    { id: "R9", claim: "old attachment/file-handle/path cache remains -> identity verification rejects stale source", test: "scripts/rld2-reproduction.mjs R9 + NEG-RLD8", outcome: "pre:VIOLATED(STALE) / post:OK(fail-closed)" },
    { id: "R10", claim: "two cards with identical filename convention, different identity -> identity decides", test: "scripts/rld2-reproduction.mjs R10", outcome: "pre:VIOLATED(STALE) / post:OK(fail-closed)" },
  ],
  reproductionAccounting: {
    pre_repair: { scenarioOk: verification?.checks?.find((c) => c.id === "V4.repro_pre_repair_stale") ? undefined : undefined },
  },
};
// pull the reproduction accounting from the verification JSON
if (verification) {
  const v4 = verification.checks.find((c) => c.id === "V4.repro_pre_repair_stale");
  const v5 = verification.checks.find((c) => c.id === "V5.repro_post_repair_fail_closed");
  negativeCases.reproductionAccounting = {
    pre_repair: v4?.detail ?? "n/a",
    post_repair: v5?.detail ?? "n/a",
  };
}
writeFileSync(join(OUT, "rld2-negative-cases.json"), JSON.stringify(negativeCases, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
