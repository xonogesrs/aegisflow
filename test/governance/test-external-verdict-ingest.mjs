// test/governance/test-external-verdict-ingest.mjs
//
// EXTERNAL-REVIEW-VERDICT-HANDOFF-1 — the production verdict ingress
//（src/governance/external-verdict-ingest.mjs）. Covers（card T1–T18）:
//   1. PASS verdict ingress → archive + rotate + promote oldest eligible
//   2. REPAIR ingress（record; Current stays; no unrelated promotion）
//   3. HOLD ingress（record; Current stays; no rotate / promote）
//   4. Current identity mismatch
//   5. bundle SHA mismatch
//   6. invalid verdict schema / packet
//   7. duplicate PASS idempotency
//   8. conflicting verdict rejection
//   9. crash before apply（resume applies）
//  10. crash after apply before archive（resume rotates）
//  11. crash after archive before promotion（reconcile promotes）
//  12. promotion recovery
//  13. PASS with empty Queue
//  14. PASS with pending Queue
//  15. no rotate on HOLD
//  16. no unrelated promotion on REPAIR
//  17. Current/Queue regressions（bytes verbatim; single CURRENT; no double archive）
//  18. LatestHuman separation（LatestHuman != Current preserved）
//  19. isolated live-shaped dogfood（P5/P6 identity + byte preservation）
//
// All tests run against env-isolated surfaces — the real Desktop surface is
// NEVER touched by the suite（the live acceptance runs as a separate script）.
//
// Run: node --test test/governance/test-external-verdict-ingest.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_BUNDLE_SOURCE_SCHEMA,
  renderReviewBundle,
  writeReviewBundle,
  validateReviewBundle,
  collectRepoFacts,
  buildExternalReviewState,
  recordDeliveryAttempt,
  applyExternalReviewVerdict,
  deliverToExternalReviewSurface,
  readExternalReviewDeliveryRecord,
  writeExternalReviewDeliveryRecord,
  bundleContentSha256,
  rotateExternalReviewSurface,
} from "../../src/governance/review-bundle.mjs";
import { readReviewQueue, writeReviewQueue } from "../../src/governance/review-queue.mjs";
import {
  ingestExternalVerdict,
  findingsDigest,
  validateVerdictPacket,
  EXTERNAL_VERDICT_PACKET_SCHEMA,
  EXTERNAL_VERDICT_HANDOFF_HOLDS,
  VERDICT_HANDOFF_IDEMPOTENT,
  VERDICT_HANDOFF_NO_DUPLICATE_TRANSITION,
} from "../../src/governance/external-verdict-ingest.mjs";
import { publishHumanReport } from "../../src/governance/human-report.mjs";

const REPO_A = "/tmp/autoloop";
const ROOT = `${tmpdir()}/evi-test-${process.pid}`;
const BUNDLES = join(ROOT, "bundles");
const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(BUNDLES, { recursive: true });
});
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const facts = collectRepoFacts(REPO_A);
let seq = 0;

function mkBundle(cardId, cardTitle) {
  seq += 1;
  const source = {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: { cardId, cardTitle, cardType: "implementation" },
    graph: { graphRunId: `evi-${cardId}-${seq}` },
    repo: { repository: facts.repository ?? null, branch: facts.branch, head: facts.head, treeSha: facts.treeSha, worktreePath: facts.worktreePath, remote: facts.remote },
    repoIntegrity: { head: facts.head, treeSha: facts.treeSha, worktreeClean: facts.worktreeClean, dirtyPaths: facts.dirtyPaths, untrackedFiles: facts.untrackedFiles, remote: facts.remote },
    objective: `verdict ingest test bundle ${cardId}`,
    executiveStatus: "PASS",
    executiveSummary: "verdict ingest dogfood",
    authorizedScope: ["src/governance/review-bundle.mjs", "test/governance/test-external-verdict-ingest.mjs"],
    unauthorizedScope: ["commit", "push", "merge", "seal"],
    designDecisions: ["verdict ingest test"],
    files: { added: ["src/governance/external-verdict-ingest.mjs"], modified: [], deleted: [] },
    diffSummary: "verdict ingest module",
    execution: { testsExecuted: ["node --test test/governance/test-external-verdict-ingest.mjs"], pass: true, nodeResults: { passed: 1, failed: 0, total: 1 } },
    verifier: { pass: true, result: "PASS", summary: "verify PASS" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "c".repeat(64), blockingFindings: [], summary: "review PASS" },
    repairAttempts: [],
    repairBudget: { maxAttempts: 1, used: 0 },
    repairLineage: { generationType: "implementation", repairIterations: 0, surfaceReseals: 0, resealTouchedPaths: [] },
    externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null, verdict: null },
    negativeCases: [],
    regression: [],
    evidence: [],
    security: { secretScanResult: "clean", ingestionAllowlist: [], ingestionDenylist: [] },
    risks: [], limitations: [],
    rollbackProcedure: "regenerate",
    openQuestions: [],
    recommendedNextStep: "external review",
  };
  const b = renderReviewBundle(source, { generatedAt: new Date().toISOString() });
  mkdirSync(BUNDLES, { recursive: true });
  const w = writeReviewBundle(b, BUNDLES, { fileName: `evi-${cardId}-${seq}.txt` });
  const v = validateReviewBundle(w.path, { authorizedDir: BUNDLES });
  assert.equal(v.ok, true, `bundle validates (${v.errors.join(";")})`);
  return { ...b, path: w.path, cardId, cardTitle };
}

function deliver(surfaceDir, bundle, { evidencePath = null } = {}) {
  mkdirSync(surfaceDir, { recursive: true });
  const state = buildExternalReviewState({ bundle: { identity: bundle.identity, sha256: bundle.sha256 }, bundlePath: bundle.path });
  const st = recordDeliveryAttempt(state, { method: "external-review-surface", attemptedAt: "2026-08-17T00:00:00.000Z" });
  const source = { task: { cardId: bundle.cardId }, evidence: evidencePath ? [{ path: evidencePath, sha256: shaFile(evidencePath) }] : [] };
  const r = deliverToExternalReviewSurface({ bundlePath: bundle.path, state: st, source, outDir: surfaceDir, surfaceDir });
  assert.equal(r.attempted, true, `delivery attempted (${r.reason ?? ""})`);
  return r;
}

function makePacket(cardId, bundle, verdict, { reviewer = "external-reviewer:human", reviewedAt = "2026-08-17T12:00:00.000Z", findings = ["none"], findingsDigestValue = null } = {}) {
  return {
    schema: EXTERNAL_VERDICT_PACKET_SCHEMA,
    cardId,
    bundleIdentity: bundle.identity,
    bundleSha256: bundle.sha256,
    verdict,
    reviewerIdentity: reviewer,
    reviewedAt,
    findingsDigest: findingsDigestValue ?? findingsDigest(findings),
    findings,
  };
}

function surfaceState(surfaceDir) {
  const rec = readExternalReviewDeliveryRecord(join(surfaceDir, "delivery.json"));
  return rec.ok ? rec : null;
}

function queuedIds(surfaceDir) {
  const q = readReviewQueue(surfaceDir);
  if (!q.ok) return [];
  return (q.queue.entries ?? [])
    .filter((e) => e.surfaceDir === surfaceDir && e.state === "QUEUED")
    .sort((a, b) => a.order - b.order)
    .map((e) => e.cardId);
}

function currentCard(surfaceDir) {
  const rec = surfaceState(surfaceDir);
  return rec ? { cardId: rec.cardId, identity: rec.state.delivery?.reviewBundleIdentity ?? null, sha256: rec.state.delivery?.reviewBundleSha256 ?? null } : null;
}

function archivedFiles(archiveDir, cardId) {
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir).filter((f) => f.includes(cardId));
}

// ── 1 / 14. PASS ingress → archive + rotate + promote ──────────────────────

test("1/14. PASS ingress archives Current and promotes the oldest eligible queued review（bytes verbatim）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s1");
  const arch = join(ROOT, "a1");
  const A = mkBundle("EVI-A", "Card A");
  const B = mkBundle("EVI-B", "Card B");
  deliver(surf, A);
  deliver(surf, B); // queued behind A
  assert.deepEqual(queuedIds(surf), ["EVI-B"], "B queued");
  const packet = makePacket("EVI-A", A, "PASS");
  const r = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true, r.errors.join(";"));
  assert.equal(r.code, "APPLIED");
  assert.equal(r.result.promoted.cardId, "EVI-B", "oldest eligible promoted");
  // P5/P6: identity + bytes preserved verbatim
  const cur = currentCard(surf);
  assert.equal(cur.cardId, "EVI-B", "Current advanced to B");
  assert.equal(cur.identity, B.identity, "P5 promoted identity == queue identity");
  assert.equal(cur.sha256, B.sha256, "P5 promoted sha == queue sha");
  assert.equal(bundleContentSha256(join(surf, "review-bundle.txt")), B.sha256, "P6 Current bytes == queued bytes");
  assert.equal(readFileSync(join(surf, "review-bundle.txt"), "utf8"), readFileSync(B.path, "utf8"), "P6 bytes verbatim, never regenerated");
  // archive holds A with PASS
  const archived = archivedFiles(arch, "EVI-A").filter((f) => f.includes("PASS") && f.endsWith("-delivery.json"));
  assert.equal(archived.length, 1, "A archived exactly once with PASS");
  const aRec = readExternalReviewDeliveryRecord(join(arch, archived[0]));
  assert.equal(aRec.ok, true);
  assert.equal(aRec.state.verdict.verdict, "PASS");
  // queue bookkeeping: A archived, B current, nothing queued
  const q = readReviewQueue(surf);
  assert.equal(q.queue.entries.find((e) => e.cardId === "EVI-A").state, "ARCHIVED");
  assert.equal(q.queue.entries.find((e) => e.cardId === "EVI-B").state, "CURRENT");
  assert.deepEqual(queuedIds(surf), [], "queue drained");
});

// ── 2 / 16. REPAIR ingress ─────────────────────────────────────────────────

test("2/16. REPAIR ingress records the verdict; Current stays; no unrelated promotion", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s2");
  const arch = join(ROOT, "a2");
  const A = mkBundle("EVI-RA", "Card A");
  const B = mkBundle("EVI-RB", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  const packet = makePacket("EVI-RA", A, "REPAIR", { findings: ["gap in evidence"] });
  const r = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true, r.errors.join(";"));
  assert.equal(r.result.status, "REPAIR");
  assert.equal(r.result.promoted, null, "no promotion on REPAIR");
  assert.deepEqual(r.result.archived, [], "no archive on REPAIR");
  const cur = currentCard(surf);
  assert.equal(cur.cardId, "EVI-RA", "Current stays in its authoritative position");
  const rec = surfaceState(surf);
  assert.equal(rec.state.externalReviewStatus, "REPAIR", "verdict recorded");
  assert.equal(rec.state.verdict.verdict, "REPAIR", "verdict bound");
  assert.deepEqual(queuedIds(surf), ["EVI-RB"], "B stays queued（no unrelated promotion）");
  assert.deepEqual(archivedFiles(arch, "EVI-RA"), [], "A not archived as PASS");
});

// ── 3 / 15. HOLD ingress ───────────────────────────────────────────────────

test("3/15. HOLD ingress records the verdict; Current stays; no rotate / promote", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s3");
  const arch = join(ROOT, "a3");
  const A = mkBundle("EVI-HA", "Card A");
  const B = mkBundle("EVI-HB", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  const packet = makePacket("EVI-HA", A, "HOLD", { findings: ["blocker: scope unclear"] });
  const r = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true);
  assert.equal(r.result.status, "HOLD");
  assert.equal(r.result.promoted, null);
  assert.equal(currentCard(surf).cardId, "EVI-HA", "Current stays");
  const rec = surfaceState(surf);
  assert.equal(rec.state.externalReviewStatus, "HOLD", "HOLD recorded");
  assert.deepEqual(queuedIds(surf), ["EVI-HB"], "queue untouched");
  assert.deepEqual(archivedFiles(arch, "EVI-HA"), [], "no rotation on HOLD");
});

// ── 4. Current identity mismatch ───────────────────────────────────────────

test("4. verdict packet that does not bind the live Current is rejected（card / identity / sha）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s4");
  const arch = join(ROOT, "a4");
  const A = mkBundle("EVI-IA", "Card A");
  deliver(surf, A);
  // wrong cardId
  let r = await ingestExternalVerdict({ packet: makePacket("EVI-WRONG", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, false);
  assert.equal(r.code, EXTERNAL_VERDICT_HANDOFF_HOLDS.CURRENT_IDENTITY_MISMATCH);
  // wrong identity
  const badIdent = { ...makePacket("EVI-IA", A, "PASS"), bundleIdentity: "0".repeat(64) };
  r = await ingestExternalVerdict({ packet: badIdent, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, false);
  assert.equal(r.code, EXTERNAL_VERDICT_HANDOFF_HOLDS.CURRENT_IDENTITY_MISMATCH);
  // wrong sha
  const badSha = { ...makePacket("EVI-IA", A, "PASS"), bundleSha256: "1".repeat(64) };
  r = await ingestExternalVerdict({ packet: badSha, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, false);
  assert.equal(r.code, EXTERNAL_VERDICT_HANDOFF_HOLDS.CURRENT_IDENTITY_MISMATCH);
  // Current untouched
  assert.equal(currentCard(surf).cardId, "EVI-IA");
  assert.equal(surfaceState(surf).state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
});

// ── 5. bundle SHA mismatch（bytes divergence）──────────────────────────────

test("5. a packet sha that diverges from the actual Current bytes is rejected", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s5");
  const arch = join(ROOT, "a5");
  const A = mkBundle("EVI-SA", "Card A");
  deliver(surf, A);
  // record + packet both claim a sha that does not match the on-disk bytes
  const fakeSha = "a".repeat(64);
  const rec = surfaceState(surf);
  const forged = {
    ...rec.state,
    delivery: { ...rec.state.delivery, reviewBundleSha256: fakeSha },
  };
  writeExternalReviewDeliveryRecord({ outDir: surf, state: forged, cardId: "EVI-SA", fileName: "delivery.json" });
  const r = await ingestExternalVerdict({ packet: makePacket("EVI-SA", A, "PASS", {}), surfaceDir: surf, archiveDir: arch });
  // the packet's sha no longer matches the record's — either way it must fail closed
  assert.equal(r.ok, false);
  assert.ok([EXTERNAL_VERDICT_HANDOFF_HOLDS.CURRENT_IDENTITY_MISMATCH, EXTERNAL_VERDICT_HANDOFF_HOLDS.PACKET_INVALID].includes(r.code), `code ${r.code}`);
});

// ── 6. invalid verdict schema / packet ─────────────────────────────────────

test("6. malformed verdict packets are rejected before any state change", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s6");
  const arch = join(ROOT, "a6");
  const A = mkBundle("EVI-VA", "Card A");
  deliver(surf, A);
  const base = makePacket("EVI-VA", A, "PASS");
  const cases = [
    { ...base, verdict: "MERGE" },
    { ...base, schema: "autoloop.other/v1" },
    { ...base, findings: ["x"], findingsDigest: "0".repeat(64) }, // digest mismatch
    { ...base, reviewedAt: "not-a-date" },
    { ...base, reviewerIdentity: "agent:the-implementer" },
    { ...base, bundleIdentity: "short" },
    { ...base, findings: "not-an-array" },
  ];
  for (const bad of cases) {
    const v = validateVerdictPacket(bad);
    assert.equal(v.ok, false, `packet rejected: ${JSON.stringify(bad).slice(0, 80)}`);
    const r = await ingestExternalVerdict({ packet: bad, surfaceDir: surf, archiveDir: arch });
    assert.equal(r.ok, false);
    assert.equal(r.code, EXTERNAL_VERDICT_HANDOFF_HOLDS.PACKET_INVALID, `code for ${JSON.stringify(bad).slice(0, 60)}`);
  }
  // no state change
  assert.equal(surfaceState(surf).state.externalReviewStatus, "AWAITING_EXTERNAL_REVIEW");
  assert.deepEqual(archivedFiles(arch, "EVI-VA"), [], "nothing archived");
});

// ── 7. duplicate PASS idempotency ──────────────────────────────────────────

test("7. re-sending the identical PASS packet is idempotent（no double archive/rotate/promote）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s7");
  const arch = join(ROOT, "a7");
  const A = mkBundle("EVI-DA", "Card A");
  const B = mkBundle("EVI-DB", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  const packet = makePacket("EVI-DA", A, "PASS");
  const r1 = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r1.ok, true);
  assert.equal(r1.result.promoted.cardId, "EVI-DB");
  // re-send the SAME packet: Current is now B — the archive holds A's PASS
  const r2 = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r2.ok, true, r2.errors.join(";"));
  assert.equal(r2.code, VERDICT_HANDOFF_IDEMPOTENT, "idempotent replay");
  // exactly one archived A PASS record; Current still B; B not re-promoted/duplicated
  const archivedA = archivedFiles(arch, "EVI-DA").filter((f) => f.includes("PASS") && f.endsWith("-delivery.json"));
  assert.equal(archivedA.length, 1, "A archived exactly once");
  assert.equal(currentCard(surf).cardId, "EVI-DB", "Current unchanged by replay");
  assert.deepEqual(queuedIds(surf), [], "no re-promotion / duplicates");
});

// ── 8. conflicting verdict rejection ───────────────────────────────────────

test("8. a DIFFERENT verdict on the same bundle fails closed（no silent overwrite）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s8");
  const arch = join(ROOT, "a8");
  const A = mkBundle("EVI-CA", "Card A");
  const B = mkBundle("EVI-CB", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  const pass = makePacket("EVI-CA", A, "PASS");
  const r1 = await ingestExternalVerdict({ packet: pass, surfaceDir: surf, archiveDir: arch });
  assert.equal(r1.ok, true);
  assert.equal(currentCard(surf).cardId, "EVI-CB", "A rotated; B promoted");
  // a HOLD for the archived A bundle → conflict via the archive record
  const hold = makePacket("EVI-CA", A, "HOLD", { findings: ["late concern"] });
  const r2 = await ingestExternalVerdict({ packet: hold, surfaceDir: surf, archiveDir: arch });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, EXTERNAL_VERDICT_HANDOFF_HOLDS.CONFLICTING, "conflicting verdict rejected");
  assert.equal(currentCard(surf).cardId, "EVI-CB", "Current untouched by the rejected conflict");
  // the identical PASS replay stays idempotent
  const r3 = await ingestExternalVerdict({ packet: pass, surfaceDir: surf, archiveDir: arch });
  assert.equal(r3.ok, true, "same verdict replay still idempotent");
  assert.equal(r3.code, VERDICT_HANDOFF_IDEMPOTENT);
});

// ── 9. crash before apply（resume）────────────────────────────────────────

test("9. a packet that was never applied is applied on ingest（L1 resume）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s9");
  const arch = join(ROOT, "a9");
  const A = mkBundle("EVI-L1A", "Card A");
  deliver(surf, A);
  const packet = makePacket("EVI-L1A", A, "PASS");
  // crash before apply: nothing was applied — ingest applies + completes
  const r = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true);
  assert.equal(r.code, "APPLIED");
  const aRec = archivedFiles(arch, "EVI-L1A").filter((f) => f.endsWith("-delivery.json"));
  assert.equal(aRec.length, 1, "A archived with a delivery record");
  const rec = readExternalReviewDeliveryRecord(join(arch, aRec[0]));
  assert.equal(rec.ok, true);
  assert.equal(rec.state.externalReviewStatus, "PASS", "applied via the fresh ingest（L1 resume）");
});

// ── 10. crash after apply before archive（resume）──────────────────────────

test("10. an applied PASS with rotation pending continues to rotate on re-ingest（L2 resume）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s10");
  const arch = join(ROOT, "a10");
  const A = mkBundle("EVI-L2A", "Card A");
  const B = mkBundle("EVI-L2B", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  // simulate the crash: verdict durably applied to the record, rotation never ran
  const rec = surfaceState(surf);
  const applied = applyExternalReviewVerdict(rec.state, {
    verdict: "PASS",
    bundleIdentity: A.identity,
    bundleSha256: A.sha256,
    reviewerIdentity: "external-reviewer:human",
    reviewedAt: "2026-08-17T12:00:00.000Z",
    findingsDigest: findingsDigest(["none"]),
  });
  assert.equal(applied.ok, true);
  writeExternalReviewDeliveryRecord({ outDir: surf, state: applied.state, cardId: "EVI-L2A", fileName: "delivery.json" });
  // re-ingest the same packet → continue archive/rotate/promote（no re-apply）
  const r = await ingestExternalVerdict({ packet: makePacket("EVI-L2A", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true, r.errors.join(";"));
  assert.equal(r.code, VERDICT_HANDOFF_NO_DUPLICATE_TRANSITION, "no duplicate transition");
  assert.equal(r.result.promoted.cardId, "EVI-L2B", "rotation completed on resume");
  assert.equal(currentCard(surf).cardId, "EVI-L2B", "Current advanced");
  const archivedA = archivedFiles(arch, "EVI-L2A").filter((f) => f.endsWith("-delivery.json"));
  assert.equal(archivedA.length, 1, "A archived exactly once");
});

// ── 11 / 12. crash after archive before promotion（reconcile）──────────────

test("11/12. archive done but promotion missing → re-ingest reconciles the promotion", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s11");
  const arch = join(ROOT, "a11");
  const A = mkBundle("EVI-L3A", "Card A");
  const B = mkBundle("EVI-L3B", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  // simulate the crash: PASS applied + archived（Current cleared）, promotion never ran
  const rec = surfaceState(surf);
  const applied = applyExternalReviewVerdict(rec.state, {
    verdict: "PASS",
    bundleIdentity: A.identity,
    bundleSha256: A.sha256,
    reviewerIdentity: "external-reviewer:human",
    reviewedAt: "2026-08-17T12:00:00.000Z",
    findingsDigest: findingsDigest(["none"]),
  });
  writeExternalReviewDeliveryRecord({ outDir: surf, state: applied.state, cardId: "EVI-L3A", fileName: "delivery.json" });
  const rot = rotateExternalReviewSurface({ surfaceDir: surf, archiveDir: arch, cardId: "EVI-L3A", identity: A.identity, verdict: "PASS" });
  assert.equal(rot.ok, true);
  assert.equal(rot.promoted.cardId, "EVI-L3B", "promotion happened here — undo it to simulate the crash");
  // undo the promotion: Current empty again + B back to QUEUED（simulating crash before promotion）
  rmSync(join(surf, "review-bundle.txt"), { force: true });
  rmSync(join(surf, "delivery.json"), { force: true });
  rmSync(join(surf, "evidence.json"), { force: true });
  const q = readReviewQueue(surf);
  const bEntry = q.queue.entries.find((e) => e.cardId === "EVI-L3B");
  bEntry.state = "QUEUED";
  bEntry.deliveredAt = null;
  writeReviewQueue(q.queue, { surfaceDir: surf });
  // re-ingest the SAME packet → idempotent + reconcile promotes B（L3 recovery）
  const r = await ingestExternalVerdict({ packet: makePacket("EVI-L3A", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true, r.errors.join(";"));
  assert.equal(r.code, VERDICT_HANDOFF_IDEMPOTENT);
  assert.equal(r.result.promoted.cardId, "EVI-L3B", "promotion reconciled（oldest eligible promoted）");
  assert.equal(currentCard(surf).cardId, "EVI-L3B");
  assert.equal(bundleContentSha256(join(surf, "review-bundle.txt")), B.sha256, "bytes verbatim");
});

// ── 13. PASS with empty Queue ──────────────────────────────────────────────

test("13. PASS with an empty Queue archives Current and leaves Current empty（legal）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s13");
  const arch = join(ROOT, "a13");
  const A = mkBundle("EVI-EA", "Card A");
  deliver(surf, A);
  const r = await ingestExternalVerdict({ packet: makePacket("EVI-EA", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true, r.errors.join(";"));
  assert.equal(r.result.promoted, null, "nothing to promote");
  assert.equal(r.result.currentAfter.cardId, null, "Current empty");
  assert.ok(!existsSync(join(surf, "review-bundle.txt")), "Current cleared");
  const archivedA = archivedFiles(arch, "EVI-EA").filter((f) => f.includes("PASS") && f.endsWith("-delivery.json"));
  assert.equal(archivedA.length, 1, "A archived");
});

// ── 17. Current/Queue regressions ──────────────────────────────────────────

test("17. promotion preserves bytes verbatim; single CURRENT; no duplicate archive entries", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s17");
  const arch = join(ROOT, "a17");
  const A = mkBundle("EVI-GA", "Card A");
  const B = mkBundle("EVI-GB", "Card B");
  const C = mkBundle("EVI-GC", "Card C");
  deliver(surf, A);
  deliver(surf, B);
  deliver(surf, C);
  const r = await ingestExternalVerdict({ packet: makePacket("EVI-GA", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true);
  assert.equal(r.result.promoted.cardId, "EVI-GB", "oldest eligible promoted（B before C）");
  assert.equal(readFileSync(join(surf, "review-bundle.txt"), "utf8"), readFileSync(B.path, "utf8"), "verbatim bytes");
  const q = readReviewQueue(surf);
  assert.equal(q.queue.entries.filter((e) => e.state === "CURRENT" && e.surfaceDir === surf).length, 1, "single CURRENT");
  assert.deepEqual(queuedIds(surf), ["EVI-GC"], "C still queued");
  const archA = archivedFiles(arch, "EVI-GA");
  assert.equal(archA.filter((f) => f.endsWith("-delivery.json")).length, 1, "A delivery record archived exactly once");
  assert.equal(archA.filter((f) => f.endsWith("-review-bundle.txt")).length, 1, "A bundle archived exactly once");
});

// ── 18. LatestHuman separation ─────────────────────────────────────────────

test("18. verdict handoff never touches LatestHuman（LatestHuman != Current preserved）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s18");
  const arch = join(ROOT, "a18");
  const humanDir = join(dirnameOf(surf), "LatestHuman");
  const A = mkBundle("EVI-LHA", "Card A");
  const B = mkBundle("EVI-LHB", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  // publish a human report for A（the delivery already did; re-publish a distinct report）
  const pub = publishHumanReport({
    cardId: "EVI-LHA",
    reportType: "formal-review-bundle",
    reportIdentity: A.identity,
    sourceReportSha256: A.sha256,
    sourcePath: A.path,
    requiresExternalReview: true,
    currentReviewState: "AWAITING_EXTERNAL_REVIEW",
    surfaceDir: surf,
    force: true,
  });
  assert.equal(pub.ok, true, pub.reason ?? "");
  const humanBefore = readFileSync(join(humanDir, "latest-report.txt"), "utf8");
  const r = await ingestExternalVerdict({ packet: makePacket("EVI-LHA", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true);
  assert.equal(currentCard(surf).cardId, "EVI-LHB", "Current advanced to B");
  const humanAfter = readFileSync(join(humanDir, "latest-report.txt"), "utf8");
  assert.equal(humanAfter, humanBefore, "LatestHuman untouched by the verdict handoff");
  assert.notEqual(currentCard(surf).cardId, "EVI-LHA", "LatestHuman（A report）!= Current（B）");
});

// ── 19. isolated live-shaped dogfood（P1–P6 acceptance shape）──────────────

test("19. live-shaped dogfood: Current A PASS → archive → rotate → promote（P5/P6 identity + bytes）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s19");
  const arch = join(ROOT, "a19");
  const A = mkBundle("EVI-LIVEA", "Live Card A");
  const B = mkBundle("EVI-LIVEB", "Live Card B");
  deliver(surf, A);
  deliver(surf, B);
  const preQueue = readReviewQueue(surf);
  const preB = preQueue.queue.entries.find((e) => e.cardId === "EVI-LIVEB");
  // P3: capture the pre-promotion queue identity/sha
  const preIdentity = preB.bundleIdentity;
  const preSha = preB.bundleSha256;
  // P2: verdict with real reviewer provenance
  const packet = makePacket("EVI-LIVEA", A, "PASS", { reviewer: "external-reviewer:acceptance", reviewedAt: "2026-08-17T13:00:00.000Z", findings: ["none"] });
  const r = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true, r.errors.join(";"));
  // P1: old Current archived
  const archivedA = archivedFiles(arch, "EVI-LIVEA").filter((f) => f.includes("PASS") && f.endsWith("-delivery.json"));
  assert.equal(archivedA.length, 1, "P1 old Current archived");
  // P4/P5/P6: oldest queued → Current with identical identity + bytes
  assert.equal(r.result.promoted.cardId, "EVI-LIVEB", "P4 oldest QUEUED promoted");
  assert.equal(r.result.currentAfter.bundleIdentity, preIdentity, "P5 pre == post identity");
  assert.equal(r.result.currentAfter.bundleSha256, preSha, "P5 pre == post sha");
  assert.equal(bundleContentSha256(join(surf, "review-bundle.txt")), preSha, "P6 bytes preserved");
});

function dirnameOf(p) {
  return join(p, "..");
}
