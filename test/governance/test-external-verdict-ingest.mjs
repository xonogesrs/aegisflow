// test/governance/test-external-verdict-ingest.mjs
//
// CURRENT-LATEST-REVIEW-PRESENTATION-SEMANTICS-1 — the production verdict
// ingress（src/governance/external-verdict-ingest.mjs）bound to the DURABLE
// LEDGER. Coverage:
//   1. PASS ingress → ledger REVIEWED + archived; Current unchanged（no
//      promotion — verdict lifecycle never controls presentation）
//   2. REPAIR ingress（ledger REPAIR; Current unchanged）
//   3. HOLD ingress（ledger HOLD; Current unchanged）
//   4. ledger binding: unknown card -> REVIEW_LEDGER_TARGET_NOT_FOUND;
//      identity/sha mismatch -> REVIEW_VERDICT_IDENTITY_MISMATCH（card H）
//   5. ledger sha divergence fails closed
//   6. invalid verdict schema / packet
//   7. identical-PASS replay idempotent（no double archive）
//   8. conflicting verdict rejection
//   9. crash before apply（resume applies）
//  10. crash after apply before archive（resume archives）
//  11/12. archive complete → replay idempotent; Current unchanged
//  13. PASS with an empty ledger（single card）→ archived; Current unchanged
//  17. regressions: verbatim bytes; single presented entry; no duplicate archive
//  18. LatestHuman separation（verdict handoff never touches LatestHuman）
//  19. live-shaped dogfood（identity + byte preservation, verdict provenance）
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
  deliverToExternalReviewSurface,
  readExternalReviewDeliveryRecord,
  bundleContentSha256,
} from "../../src/governance/review-bundle.mjs";
import { readReviewQueue, writeReviewQueue, findEntry, reviewQueueStatus } from "../../src/governance/review-queue.mjs";
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

function currentCard(surfaceDir) {
  const rec = surfaceState(surfaceDir);
  return rec ? { cardId: rec.cardId, identity: rec.state.delivery?.reviewBundleIdentity ?? null, sha256: rec.state.delivery?.reviewBundleSha256 ?? null } : null;
}

function ledgerState(surfaceDir, cardId) {
  const st = reviewQueueStatus(surfaceDir);
  assert.equal(st.ok, true, st.reason ?? "");
  return st.queue.entries.find((e) => e.cardId === cardId) ?? null;
}

function archivedFiles(archiveDir, cardId) {
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir).filter((f) => f.includes(cardId));
}

// ── 1 / 14. PASS ingress → ledger REVIEWED + archived; Current unchanged ───

test("1/14. PASS ingress REVIEWS + archives the target; Current unchanged（no promotion）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s1");
  const arch = join(ROOT, "a1");
  const A = mkBundle("EVI-A", "Card A");
  const B = mkBundle("EVI-B", "Card B");
  deliver(surf, A); // Current = A
  deliver(surf, B); // Current = B（A stays PENDING）
  assert.equal(currentCard(surf).cardId, "EVI-B", "B presented");
  const packet = makePacket("EVI-A", A, "PASS");
  const r = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true, r.errors.join(";"));
  assert.equal(r.code, "APPLIED");
  assert.equal(r.result.promoted, null, "no promotion — verdict lifecycle never controls presentation");
  // Current unchanged（card I）
  const cur = currentCard(surf);
  assert.equal(cur.cardId, "EVI-B", "Current still B");
  assert.equal(cur.identity, B.identity, "Current identity intact");
  assert.equal(bundleContentSha256(join(surf, "review-bundle.txt")), B.sha256, "Current bytes verbatim");
  // archive holds A with PASS（from the immutable ledger artifact）
  const archived = archivedFiles(arch, "EVI-A").filter((f) => f.includes("PASS") && f.endsWith("-delivery.json"));
  assert.equal(archived.length, 1, "A archived exactly once with PASS");
  const aRec = readExternalReviewDeliveryRecord(join(arch, archived[0]));
  assert.equal(aRec.ok, true);
  assert.equal(aRec.state.verdict.verdict, "PASS");
  assert.equal(aRec.state.verdict.bundleIdentity, A.identity, "verdict identity-bound");
  // ledger bookkeeping: A REVIEWED, B PENDING + presented
  assert.equal(ledgerState(surf, "EVI-A").state, "REVIEWED");
  assert.equal(ledgerState(surf, "EVI-B").state, "PENDING");
  assert.equal(ledgerState(surf, "EVI-B").isLatestPresented, true, "B presented");
  assert.equal(ledgerState(surf, "EVI-A").isLatestPresented, false, "A not presented");
});

// ── 2 / 16. REPAIR ingress ─────────────────────────────────────────────────

test("2/16. REPAIR ingress records the verdict on the ledger; Current unchanged; no unrelated archive", { timeout: 30000 }, async () => {
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
  assert.equal(currentCard(surf).cardId, "EVI-RB", "Current unchanged");
  assert.equal(ledgerState(surf, "EVI-RA").state, "REPAIR", "ledger entry REPAIR");
  assert.equal(ledgerState(surf, "EVI-RA").verdict.verdict, "REPAIR", "verdict bound");
  assert.equal(ledgerState(surf, "EVI-RB").state, "PENDING", "B untouched");
  assert.deepEqual(archivedFiles(arch, "EVI-RA"), [], "A not archived as PASS");
});

// ── 3 / 15. HOLD ingress ───────────────────────────────────────────────────

test("3/15. HOLD ingress records the verdict on the ledger; Current unchanged; no rotate / archive", { timeout: 30000 }, async () => {
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
  assert.equal(currentCard(surf).cardId, "EVI-HB", "Current unchanged");
  assert.equal(ledgerState(surf, "EVI-HA").state, "HOLD", "ledger entry HOLD");
  assert.deepEqual(archivedFiles(arch, "EVI-HA"), [], "no rotation on HOLD");
});

// ── 4. LEDGER binding（card H）─────────────────────────────────────────────

test("4. verdict packets that do not bind a durable LEDGER entry are rejected（unknown card / identity / sha）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s4");
  const arch = join(ROOT, "a4");
  const A = mkBundle("EVI-IA", "Card A");
  const B = mkBundle("EVI-IB", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  // unknown card -> REVIEW_LEDGER_TARGET_NOT_FOUND
  let r = await ingestExternalVerdict({ packet: makePacket("EVI-WRONG", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, false);
  assert.equal(r.code, EXTERNAL_VERDICT_HANDOFF_HOLDS.LEDGER_TARGET_NOT_FOUND);
  // wrong identity -> REVIEW_VERDICT_IDENTITY_MISMATCH
  const badIdent = { ...makePacket("EVI-IA", A, "PASS"), bundleIdentity: "0".repeat(64) };
  r = await ingestExternalVerdict({ packet: badIdent, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, false);
  assert.equal(r.code, EXTERNAL_VERDICT_HANDOFF_HOLDS.IDENTITY_MISMATCH);
  // wrong sha -> REVIEW_VERDICT_IDENTITY_MISMATCH
  const badSha = { ...makePacket("EVI-IA", A, "PASS"), bundleSha256: "1".repeat(64) };
  r = await ingestExternalVerdict({ packet: badSha, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, false);
  assert.equal(r.code, EXTERNAL_VERDICT_HANDOFF_HOLDS.IDENTITY_MISMATCH);
  // Current untouched; ledger untouched
  assert.equal(currentCard(surf).cardId, "EVI-IB", "Current unchanged");
  assert.equal(ledgerState(surf, "EVI-IA").state, "PENDING", "ledger untouched");
});

// ── 5. ledger sha divergence fails closed ─────────────────────────────────

test("5. a packet sha that diverges from the ledger entry is rejected", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s5");
  const arch = join(ROOT, "a5");
  const A = mkBundle("EVI-SA", "Card A");
  deliver(surf, A);
  // forge the LEDGER entry's sha（durable authority diverged）
  const q = readReviewQueue(surf);
  const entry = findEntry(q.queue, "EVI-SA", surf);
  entry.bundleSha256 = "a".repeat(64);
  writeReviewQueue(q.queue, { surfaceDir: surf });
  const r = await ingestExternalVerdict({ packet: makePacket("EVI-SA", A, "PASS", {}), surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, false);
  assert.equal(r.code, EXTERNAL_VERDICT_HANDOFF_HOLDS.IDENTITY_MISMATCH, `code ${r.code}`);
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
  assert.equal(ledgerState(surf, "EVI-VA").state, "PENDING", "ledger untouched");
  assert.deepEqual(archivedFiles(arch, "EVI-VA"), [], "nothing archived");
});

// ── 7. duplicate PASS idempotency ──────────────────────────────────────────

test("7. re-sending the identical PASS packet is idempotent（no double archive; Current unchanged）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s7");
  const arch = join(ROOT, "a7");
  const A = mkBundle("EVI-DA", "Card A");
  const B = mkBundle("EVI-DB", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  const packet = makePacket("EVI-DA", A, "PASS");
  const r1 = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r1.ok, true);
  assert.equal(r1.result.promoted, null);
  assert.equal(ledgerState(surf, "EVI-DA").state, "REVIEWED", "A reviewed");
  // re-send the SAME packet: the ledger entry already carries the verdict —
  // no duplicate transition, no re-archive
  const r2 = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r2.ok, true, r2.errors.join(";"));
  assert.equal(r2.code, VERDICT_HANDOFF_NO_DUPLICATE_TRANSITION, "no duplicate transition");
  const archivedA = archivedFiles(arch, "EVI-DA").filter((f) => f.includes("PASS") && f.endsWith("-delivery.json"));
  assert.equal(archivedA.length, 1, "A archived exactly once");
  assert.equal(currentCard(surf).cardId, "EVI-DB", "Current unchanged by replay");
  // a true IDEMPOTENT replay: the ledger entry is gone but the archive record
  // proves the identical verdict was applied（archive scan path）
  const q = readReviewQueue(surf);
  q.queue.entries = q.queue.entries.filter((e) => e.cardId !== "EVI-DA");
  writeReviewQueue(q.queue, { surfaceDir: surf });
  const r3 = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r3.ok, true, r3.errors.join(";"));
  assert.equal(r3.code, VERDICT_HANDOFF_IDEMPOTENT, "idempotent replay via archive record");
  assert.equal(currentCard(surf).cardId, "EVI-DB", "Current unchanged");
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
  assert.equal(currentCard(surf).cardId, "EVI-CB", "Current unchanged by the verdict");
  // a HOLD for the reviewed A bundle → conflict（verdict already applied）
  const hold = makePacket("EVI-CA", A, "HOLD", { findings: ["late concern"] });
  const r2 = await ingestExternalVerdict({ packet: hold, surfaceDir: surf, archiveDir: arch });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, EXTERNAL_VERDICT_HANDOFF_HOLDS.CONFLICTING, "conflicting verdict rejected");
  assert.equal(currentCard(surf).cardId, "EVI-CB", "Current untouched by the rejected conflict");
  // the identical PASS replay stays non-conflicting
  const r3 = await ingestExternalVerdict({ packet: pass, surfaceDir: surf, archiveDir: arch });
  assert.equal(r3.ok, true, "same verdict replay still accepted");
});

// ── 9. crash before apply（resume）────────────────────────────────────────

test("9. a packet that was never applied is applied on ingest（L1 resume）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s9");
  const arch = join(ROOT, "a9");
  const A = mkBundle("EVI-L1A", "Card A");
  deliver(surf, A);
  const packet = makePacket("EVI-L1A", A, "PASS");
  // crash before apply: nothing was applied — ingest applies + archives
  const r = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true);
  assert.equal(r.code, "APPLIED");
  assert.equal(ledgerState(surf, "EVI-L1A").state, "REVIEWED", "A reviewed");
  const aRec = archivedFiles(arch, "EVI-L1A").filter((f) => f.endsWith("-delivery.json"));
  assert.equal(aRec.length, 1, "A archived with a delivery record");
  const rec = readExternalReviewDeliveryRecord(join(arch, aRec[0]));
  assert.equal(rec.ok, true);
  assert.equal(rec.state.externalReviewStatus, "PASS", "applied via the fresh ingest（L1 resume）");
});

// ── 10. crash after apply before archive（resume）──────────────────────────

test("10. an applied PASS with archive pending continues to archive on re-ingest（L2 resume）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s10");
  const arch = join(ROOT, "a10");
  const A = mkBundle("EVI-L2A", "Card A");
  const B = mkBundle("EVI-L2B", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  // simulate the crash: verdict durably applied to the LEDGER entry, archive
  // never ran
  const q = readReviewQueue(surf);
  const entry = findEntry(q.queue, "EVI-L2A", surf);
  entry.verdict = {
    verdict: "PASS",
    reviewerIdentity: "external-reviewer:human",
    reviewedAt: "2026-08-17T12:00:00.000Z",
    bundleIdentity: A.identity,
    bundleSha256: A.sha256,
    findingsDigest: findingsDigest(["none"]),
  };
  entry.state = "REVIEWED";
  writeReviewQueue(q.queue, { surfaceDir: surf });
  assert.deepEqual(archivedFiles(arch, "EVI-L2A"), [], "archive not yet done");
  // re-ingest the same packet → continue archive（no re-apply）
  const r = await ingestExternalVerdict({ packet: makePacket("EVI-L2A", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true, r.errors.join(";"));
  assert.equal(r.code, VERDICT_HANDOFF_NO_DUPLICATE_TRANSITION, "no duplicate transition");
  assert.equal(r.result.promoted, null);
  assert.equal(currentCard(surf).cardId, "EVI-L2B", "Current unchanged");
  const archivedA = archivedFiles(arch, "EVI-L2A").filter((f) => f.endsWith("-delivery.json"));
  assert.equal(archivedA.length, 1, "A archived exactly once（resume completed）");
});

// ── 11 / 12. archive complete → replay idempotent ─────────────────────────

test("11/12. archive complete -> re-ingest is idempotent; Current unchanged", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s11");
  const arch = join(ROOT, "a11");
  const A = mkBundle("EVI-L3A", "Card A");
  const B = mkBundle("EVI-L3B", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  const r1 = await ingestExternalVerdict({ packet: makePacket("EVI-L3A", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r1.ok, true);
  assert.equal(ledgerState(surf, "EVI-L3A").state, "REVIEWED", "A reviewed");
  const archivedA = archivedFiles(arch, "EVI-L3A").filter((f) => f.endsWith("-delivery.json"));
  assert.equal(archivedA.length, 1, "A archived");
  // re-ingest the SAME packet → no duplicate transition, no second archive
  const r2 = await ingestExternalVerdict({ packet: makePacket("EVI-L3A", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r2.ok, true, r2.errors.join(";"));
  assert.equal(r2.code, VERDICT_HANDOFF_NO_DUPLICATE_TRANSITION);
  assert.equal(archivedFiles(arch, "EVI-L3A").filter((f) => f.endsWith("-delivery.json")).length, 1, "still exactly one archive");
  assert.equal(currentCard(surf).cardId, "EVI-L3B", "Current unchanged");
  assert.equal(bundleContentSha256(join(surf, "review-bundle.txt")), B.sha256, "bytes verbatim");
});

// ── 13. PASS with an empty ledger（single card）────────────────────────────

test("13. PASS on the only card archives it; Current presentation unchanged（legal）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s13");
  const arch = join(ROOT, "a13");
  const A = mkBundle("EVI-EA", "Card A");
  deliver(surf, A);
  const r = await ingestExternalVerdict({ packet: makePacket("EVI-EA", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true, r.errors.join(";"));
  assert.equal(r.result.promoted, null, "nothing to promote");
  assert.equal(r.result.currentAfter.cardId, "EVI-EA", "Current unchanged（verdict lifecycle never controls presentation）");
  assert.ok(existsSync(join(surf, "review-bundle.txt")), "Current still presents the reviewed bundle");
  const archivedA = archivedFiles(arch, "EVI-EA").filter((f) => f.includes("PASS") && f.endsWith("-delivery.json"));
  assert.equal(archivedA.length, 1, "A archived");
  assert.equal(ledgerState(surf, "EVI-EA").state, "REVIEWED", "A reviewed");
});

// ── 17. Current/Queue regressions ──────────────────────────────────────────

test("17. presentation preserved verbatim; single presented entry; no duplicate archive entries", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s17");
  const arch = join(ROOT, "a17");
  const A = mkBundle("EVI-GA", "Card A");
  const B = mkBundle("EVI-GB", "Card B");
  const C = mkBundle("EVI-GC", "Card C");
  deliver(surf, A);
  deliver(surf, B);
  deliver(surf, C);
  assert.equal(currentCard(surf).cardId, "EVI-GC", "newest completion presented");
  const r = await ingestExternalVerdict({ packet: makePacket("EVI-GA", A, "PASS"), surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true);
  assert.equal(r.result.promoted, null);
  assert.equal(readFileSync(join(surf, "review-bundle.txt"), "utf8"), readFileSync(C.path, "utf8"), "verbatim bytes");
  const q = readReviewQueue(surf);
  assert.equal(q.queue.entries.filter((e) => e.isLatestPresented === true && e.surfaceDir === surf).length, 1, "single presented entry");
  assert.equal(ledgerState(surf, "EVI-GA").state, "REVIEWED", "A reviewed");
  assert.equal(ledgerState(surf, "EVI-GB").state, "PENDING", "B still pending");
  assert.equal(ledgerState(surf, "EVI-GC").state, "PENDING", "C still pending");
  const archA = archivedFiles(arch, "EVI-GA");
  assert.equal(archA.filter((f) => f.endsWith("-delivery.json")).length, 1, "A delivery record archived exactly once");
  assert.equal(archA.filter((f) => f.endsWith("-review-bundle.txt")).length, 1, "A bundle archived exactly once");
});

// ── 18. LatestHuman separation ─────────────────────────────────────────────

test("18. verdict handoff never touches LatestHuman（LatestHuman != Current preserved）", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s18");
  const arch = join(ROOT, "a18");
  const humanDir = join(surf, "..", "LatestHuman");
  const A = mkBundle("EVI-LHA", "Card A");
  const B = mkBundle("EVI-LHB", "Card B");
  deliver(surf, A);
  deliver(surf, B);
  // publish a human report for A（distinct report）
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
  assert.equal(currentCard(surf).cardId, "EVI-LHB", "Current unchanged (B)");
  const humanAfter = readFileSync(join(humanDir, "latest-report.txt"), "utf8");
  assert.equal(humanAfter, humanBefore, "LatestHuman untouched by the verdict handoff");
  assert.notEqual(currentCard(surf).cardId, "EVI-LHA", "LatestHuman（A report）!= Current（B）");
});

// ── 19. isolated live-shaped dogfood（identity + byte preservation）────────

test("19. live-shaped dogfood: verdict binds a NON-presented card; identity + bytes preserved", { timeout: 30000 }, async () => {
  const surf = join(ROOT, "s19");
  const arch = join(ROOT, "a19");
  const A = mkBundle("EVI-LIVEA", "Live Card A");
  const B = mkBundle("EVI-LIVEB", "Live Card B");
  const C = mkBundle("EVI-LIVEC", "Live Card C");
  deliver(surf, A); // Current = A
  deliver(surf, B); // Current = B
  deliver(surf, C); // Current = C
  const preC = ledgerState(surf, "EVI-LIVEC");
  // verdict on A while Current = C（card G: the target does NOT need to be
  // Current）
  const packet = makePacket("EVI-LIVEA", A, "PASS", { reviewer: "external-reviewer:acceptance", reviewedAt: "2026-08-17T13:00:00.000Z", findings: ["none"] });
  const r = await ingestExternalVerdict({ packet, surfaceDir: surf, archiveDir: arch });
  assert.equal(r.ok, true, r.errors.join(";"));
  // A reviewed + archived; Current stays C with identical identity + bytes
  const archivedA = archivedFiles(arch, "EVI-LIVEA").filter((f) => f.includes("PASS") && f.endsWith("-delivery.json"));
  assert.equal(archivedA.length, 1, "A archived with PASS");
  assert.equal(ledgerState(surf, "EVI-LIVEA").state, "REVIEWED", "A reviewed in ledger");
  assert.equal(currentCard(surf).cardId, "EVI-LIVEC", "Current stays C");
  assert.equal(currentCard(surf).identity, preC.bundleIdentity, "Current identity preserved");
  assert.equal(bundleContentSha256(join(surf, "review-bundle.txt")), preC.bundleSha256, "Current bytes preserved");
});
