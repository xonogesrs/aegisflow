// test/governance/test-execution-review-rotation-lifecycle.mjs
//
// RSL3 — Surface Rotation Lifecycle direct acceptance suite.
//
// Canonical contract (RSL2 closeout NEXT_ACTION): real end-to-end rotation —
// PGMA1 stays pending in the Domain B inbox while Task A -> Latest A,
// Task B -> A archived + Latest B, Task C HOLD -> B archived + Latest C;
// fail-closed on missing/invalid/unpublished reviews.
//
// Coverage map:
//   L1  full A->B->C chain; ordered archive; byte-identical archives
//   L2  Domain B occupant (PGMA1) untouched across all rotations
//   L3  stale-generation rotation rejected (superseded review cannot
//        republish onto Latest); surface + archive unchanged
//   L4  same-execution retry inside a chain stays idempotent
//   L5  barrier fail-closed on missing / unpublished required review;
//        previous valid Latest preserved on publish failure
//   L6  concurrent publishers: no lost update, no dual-current, no
//        regression of the current identity; failures are fail-closed
//   L7  live lock is never destroyed by contenders; dead-pid lock is
//        recoverable exactly once (serialized takeover)
//   L8  corrupt lock file fails closed (busy), bytes untouched
//   L9  crash replay determinism: archive-then-crash, orphan staging and
//        orphan archive tmp never become authoritative
//   L10 path adversarial: traversal/symlink injection cannot escape the
//        archive or overwrite through a symlink

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  EXECUTION_REVIEW_SOURCE_SCHEMA,
  archivePreviousLatest,
  EXECUTION_REVIEW_HOLDS,
  executionReviewIdentity,
  publishExecutionReview,
  verifyLatestExecutionReview,
  latestExecutionReviewStatus,
  acquireLatestReviewLock,
  releaseLatestReviewLock,
  applyExecutionReviewBarrier,
} from "../../src/governance/execution-review.mjs";

const MODULE_URL = new URL("../../src/governance/execution-review.mjs", import.meta.url).href;

const ROOT = join(tmpdir(), `rsl3-rotation-${process.pid}-${Date.now()}`);
let SURFACE;
let ARCHIVE;
let INBOX;

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  SURFACE = join(ROOT, "latest");
  ARCHIVE = join(SURFACE, "archive");
  INBOX = join(ROOT, "inbox-current");
  mkdirSync(INBOX, { recursive: true });
  process.env.AUTOLOOP_EXECUTION_REVIEW_SURFACE = SURFACE;
  process.env.AUTOLOOP_EXECUTION_REVIEW_ARCHIVE = ARCHIVE;
  process.env.AUTOLOOP_REVIEW_SURFACE = INBOX;
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.AUTOLOOP_EXECUTION_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_EXECUTION_REVIEW_ARCHIVE;
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
});

const source = ({ executionId, cardId, outcome = "PASS" }) => ({
  schema: EXECUTION_REVIEW_SOURCE_SCHEMA,
  execution: {
    executionId,
    cardId,
    cardTitle: `Task ${cardId}`,
    outcome,
    holdCode: outcome === "PASS" ? null : "TEST_HOLD",
    reason: outcome === "PASS" ? null : `${outcome} reason`,
  },
  objective: "RSL3 rotation lifecycle acceptance",
  repository: { repository: "xonogesrs/autoloop", branch: "test", head: "a".repeat(40), treeSha: "b".repeat(40), worktreePath: null },
  workSummary: "rotation lifecycle work",
  mutations: { added: ["src/rsl3.txt"], modified: [], deleted: [] },
  tests: [{ suite: "rsl3-rotation", tests: 1, pass: 1, fail: 0 }],
  findings: [],
  nextAction: "next",
  admissionRequirement: { required: true, admissionId: "adm-rsl3", reviewPolicyStrength: "external", externalReviewRequired: true },
});

const TASK_A = source({ executionId: "EXEC-A", cardId: "TASK-A", outcome: "PASS" });
const TASK_B = source({ executionId: "EXEC-B", cardId: "TASK-B", outcome: "PASS" });
const TASK_C = source({ executionId: "EXEC-C", cardId: "TASK-C", outcome: "HOLD" });
const TASK_D = source({ executionId: "EXEC-D", cardId: "TASK-D", outcome: "PASS" });
const TASK_E = source({ executionId: "EXEC-E", cardId: "TASK-E", outcome: "PASS" });
const TASK_F = source({ executionId: "EXEC-F", cardId: "TASK-F", outcome: "PASS" });

const currentBytes = () => readFileSync(join(SURFACE, "review.txt"), "utf8");
const archiveFiles = () => (existsSync(ARCHIVE) ? readdirSync(ARCHIVE).filter((f) => f.endsWith("-review.txt")).sort() : []);
const admission = () => ({ schema: "autoloop.task-admission/v1", admission_id: "adm-rsl3" });

function writeOccupant(cardId) {
  writeFileSync(join(INBOX, "delivery.json"), JSON.stringify({
    schema: "autoloop.external-review-delivery/v2",
    cardId,
    externalReviewStatus: "AWAITING_EXTERNAL_REVIEW",
    delivery: {},
  }, null, 2));
}

// ── L1 ────────────────────────────────────────────────────────────────────

test("L1. canonical chain: A -> Latest A; B -> A archived + Latest B; C HOLD -> B archived + Latest C", () => {
  const rA = publishExecutionReview(TASK_A, { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(rA.ok, true, rA.reason);
  const bytesA = currentBytes();
  assert.equal(archiveFiles().length, 0);
  assert.equal(latestExecutionReviewStatus().outcome, "PASS");

  const rB = publishExecutionReview(TASK_B, { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(rB.ok, true, rB.reason);
  assert.equal(rB.previousIdentity, rA.identity);
  assert.equal(archiveFiles().length, 1);
  // byte-identical archive of A
  const archA = readFileSync(join(ARCHIVE, archiveFiles()[0]), "utf8");
  assert.equal(archA, bytesA, "archived previous Latest must be byte-identical");
  assert.ok(archiveFiles()[0].includes("TASK-A"), "archive name carries card id");
  assert.equal(latestExecutionReviewStatus().cardId, "TASK-B");

  const bytesB = currentBytes();
  const rC = publishExecutionReview(TASK_C, { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(rC.ok, true, rC.reason);
  assert.equal(rC.previousIdentity, rB.identity);
  assert.equal(archiveFiles().length, 2);
  assert.equal(readFileSync(join(ARCHIVE, archiveFiles()[1]), "utf8"), bytesB, "B archived byte-identically");
  const st = latestExecutionReviewStatus();
  assert.equal(st.cardId, "TASK-C");
  assert.equal(st.outcome, "HOLD", "HOLD outcome still rotates to current");
  // ordered history preserved: A entry precedes B entry
  assert.deepEqual(archiveFiles().map((f) => (f.includes("TASK-A") ? "A" : "B")), ["A", "B"]);
  // full chain verifies fail-closed clean
  assert.equal(verifyLatestExecutionReview().ok, true);
  assert.equal(verifyLatestExecutionReview({ expected: { executionId: "EXEC-C", cardId: "TASK-C" } }).ok, true);
  assert.equal(verifyLatestExecutionReview({ expected: { executionId: "EXEC-A" } }).ok, false, "wrong-generation expectation rejected");
});

// ── L2 ────────────────────────────────────────────────────────────────────

test("L2. PGMA1 occupant in Domain B inbox survives every Domain A rotation untouched", () => {
  writeOccupant("PGMA1");
  const inboxBefore = readFileSync(join(INBOX, "delivery.json"), "utf8");
  for (const t of [TASK_D, TASK_E]) {
    const r = publishExecutionReview(t, { surfaceDir: SURFACE, archiveDir: ARCHIVE, inboxOccupant: "PGMA1" });
    assert.equal(r.ok, true, r.reason);
  }
  assert.equal(latestExecutionReviewStatus().cardId, "TASK-E", "rotation chain continued past PGMA1 scenario");
  assert.equal(readFileSync(join(INBOX, "delivery.json"), "utf8"), inboxBefore, "inbox bytes untouched");
  assert.equal(readdirSync(INBOX).sort().join(","), "delivery.json", "no inbox side effects");
  // publication record honestly reports the occupant while it stays pending
  const rec = currentBytes();
  assert.match(rec, /EXTERNAL_INBOX_OCCUPANT: PGMA1/);
  writeOccupant("PGMA1"); // restore for later tests that read the env default
});


test("L3. stale generation rejected: already-archived review cannot republish onto Latest", () => {
  const before = currentBytes();
  const count = archiveFiles().length;
  const r = publishExecutionReview(TASK_A, { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(r.ok, false);
  assert.equal(currentBytes(), before, "surface unchanged after stale attempt");
  assert.equal(archiveFiles().length, count, "archive unchanged after stale attempt");
  assert.equal(latestExecutionReviewStatus().cardId, "TASK-E", "current did not regress");
});

// ── L4 ────────────────────────────────────────────────────────────────────

test("L4. same-execution retry of the CURRENT review stays idempotent inside the chain", () => {
  const before = currentBytes();
  const count = archiveFiles().length;
  const r = publishExecutionReview(TASK_E, { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(r.ok, true);
  assert.equal(r.idempotent, true);
  assert.equal(currentBytes(), before);
  assert.equal(archiveFiles().length, count);
});

test("L5. barrier fail-closed on missing/unpublished required review; failure preserves previous Latest", async () => {
  // missing review on an empty surface
  const emptySurface = join(ROOT, "empty-surface");
  rmSync(emptySurface, { recursive: true, force: true });

  const v = verifyLatestExecutionReview({ surfaceDir: emptySurface });
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes("latest_review_missing"));

  // barrier with a failing publisher -> COMPLETE blocked, holdCode surfaced
  const goodBytes = currentBytes();
  const barrier = await applyExecutionReviewBarrier({
    graphView: { executionId: "EXEC-D", final: "PASS", nodeResults: [] },
    admission: admission(),
    closeout: { cardId: "TASK-D", objective: "x" },
    require: true,
    surfaceDir: SURFACE,
    archiveDir: join(ROOT, "blocked-archive-will-fail"),
    publisher: () => ({ ok: false, holdCode: EXECUTION_REVIEW_HOLDS.PUBLISH_FAILED, reason: "simulated_publish_failure" }),
  });
  assert.ok(
    [EXECUTION_REVIEW_HOLDS.NOT_PUBLISHED, EXECUTION_REVIEW_HOLDS.PUBLISH_FAILED].includes(barrier.holdCode),
    `fail-closed hold code, got ${barrier.holdCode}`,
  );
  assert.equal(barrier.ok, false);
  assert.equal(currentBytes(), goodBytes, "previous valid Latest preserved");
});

// ── L6 ────────────────────────────────────────────────────────────────────

test("L6. concurrent publishers: no lost update, no dual-current, no identity regression", async () => {
  const cSurface = join(ROOT, "conc", "latest");
  const cArchive = join(cSurface, "archive");
  mkdirSync(dirname(cSurface), { recursive: true });
  const childSrc = `
    import { publishExecutionReview, EXECUTION_REVIEW_SOURCE_SCHEMA } from ${JSON.stringify(MODULE_URL)};
    const execId = process.env.C_EXEC;
    const src = {
      schema: EXECUTION_REVIEW_SOURCE_SCHEMA,
      execution: { executionId: execId, cardId: execId, cardTitle: execId, outcome: "PASS", holdCode: null, reason: null },
      objective: "concurrency probe",
      repository: { repository: "r/r", branch: "b", head: ${JSON.stringify("a".repeat(40))}, treeSha: ${JSON.stringify("b".repeat(40))}, worktreePath: null },
      workSummary: "w", mutations: { added: [], modified: [], deleted: [] },
      tests: [], findings: [], nextAction: null,
      admissionRequirement: { required: true, admissionId: "adm-c", reviewPolicyStrength: "external", externalReviewRequired: true },
    };
    const r = publishExecutionReview(src, { surfaceDir: process.env.C_SURFACE, archiveDir: process.env.C_ARCHIVE });
    console.log("RESULT:" + JSON.stringify(r));
  `;
  const kids = Array.from({ length: 6 }, (_, i) =>
    new Promise((res) => {
      const p = spawn(process.execPath, ["-e", childSrc], {
        env: { ...process.env, C_SURFACE: cSurface, C_ARCHIVE: cArchive, C_EXEC: `CONC-${i}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.on("close", () => {
        const line = out.trim().split("\n").find((l) => l.startsWith("RESULT:"));
        res(line ? JSON.parse(line.slice(7)) : { ok: false, reason: "no_output:" + out.slice(0, 200) });
      });
    }));
  const results = await Promise.all(kids);

  // every success is durably recoverable: current OR archived, exactly once
  const okIds = results.filter((r) => r.ok).map((r) => r.identity);
  assert.ok(okIds.length >= 1, "at least one publisher must win");
  const present = new Set();
  for (const f of readdirSync(cArchive).filter((f) => f.endsWith("-review.txt"))) {
    const m = readFileSync(join(cArchive, f), "utf8").match(/^REVIEW_PUBLICATION_IDENTITY:\s*([0-9a-f]{64})$/m);
    if (m) present.add(m[1]);
  }
  present.add(latestExecutionReviewStatus({ surfaceDir: cSurface }).identity);
  for (const id of okIds) assert.ok(present.has(id), `successful publication ${id.slice(0, 8)} must survive`);
  // final surface verifies fail-closed clean
  assert.equal(verifyLatestExecutionReview({ surfaceDir: cSurface }).ok, true);
  // failed attempts are fail-closed with known hold codes only
  for (const r of results.filter((x) => !x.ok)) {
    assert.ok(!r.holdCode || Object.values(EXECUTION_REVIEW_HOLDS).includes(r.holdCode), `fail-closed code: ${r.holdCode ?? r.reason}`);
  }
});

// ── L7 ────────────────────────────────────────────────────────────────────

test("L7. live lock never destroyed by contenders; dead lock recovered exactly once", async () => {
  const lDir = join(ROOT, "lockcase", "latest");
  mkdirSync(lDir, { recursive: true });
  const lockPath = join(dirname(lDir), ".latest.lock");

  // live foreign holder
  const holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 150));
  writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, token: "live-token", acquiredAt: "now" }));
  const liveBytes = readFileSync(lockPath, "utf8");
  for (let i = 0; i < 3; i++) {
    const g = acquireLatestReviewLock(lDir);
    assert.equal(g.ok, false, "live lock must block");
  }
  assert.equal(readFileSync(lockPath, "utf8"), liveBytes, "contenders must not touch a LIVE lock");
  holder.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 150));

  // now dead: recovery succeeds and consumes the stale lock exactly once
  const g1 = acquireLatestReviewLock(lDir);
  assert.equal(g1.ok, true, "dead-pid lock must be recoverable");
  assert.equal(existsSync(join(dirname(lDir), ".latest.lock.recover")), false, "claim marker cleaned up");
  releaseLatestReviewLock(g1);
  assert.equal(existsSync(lockPath), false, "release removes own lock");
});

// ── L8 ────────────────────────────────────────────────────────────────────

test("L8. corrupt lock file fails closed without mutation", () => {
  const lDir = join(ROOT, "corruptlock", "latest");
  mkdirSync(lDir, { recursive: true });
  const lockPath = join(dirname(lDir), ".latest.lock");
  writeFileSync(lockPath, "{corrupt-bytes-not-json");
  const g = acquireLatestReviewLock(lDir);
  assert.equal(g.ok, false);
  assert.match(readFileSync(lockPath, "utf8"), /corrupt-bytes/, "unreadable lock left untouched (manual-intervention fail-closed)");
});

// ── L9 ────────────────────────────────────────────────────────────────────

test("L9. crash replay determinism: archive-then-crash replays clean; staging/tmp orphans never authoritative", () => {
  const kSurface = join(ROOT, "crash", "latest");
  const kArchive = join(kSurface, "archive");
  const kFiles = () => readdirSync(kArchive).filter((f) => f.endsWith("-review.txt")).sort();
  mkdirSync(kSurface, { recursive: true });

  const rA = publishExecutionReview(TASK_A, { surfaceDir: kSurface, archiveDir: kArchive });
  assert.equal(rA.ok, true, rA.reason);
  // simulate crash between the archive rename and the publish rename:
  // B's predecessor A is in BOTH the archive and Latest.
  const archStep = archivePreviousLatest({ surfaceDir: kSurface, archiveDir: kArchive });
  assert.equal(archStep.ok && archStep.archived, true);
  assert.equal(latestExecutionReviewStatus({ surfaceDir: kSurface }).cardId, "TASK-A", "current survived the simulated crash");

  // orphan artifacts a crashed publisher may leave behind
  const orphanTmp = `${kFiles()[0]}.tmp-999-junk`;
  writeFileSync(join(kArchive, orphanTmp), "partial");
  mkdirSync(join(ROOT, "crash", `.latest-incoming-crash`), { recursive: true });
  writeFileSync(join(ROOT, "crash", `.latest-incoming-crash`, "review.txt"), "stale staging");

  // fresh-process retry completes the rotation deterministically
  const rB2 = publishExecutionReview(TASK_B, { surfaceDir: kSurface, archiveDir: kArchive });
  assert.equal(rB2.ok, true, rB2.reason);
  // no duplicate archive rows for A despite the replayed crash window
  assert.equal(kFiles().filter((f) => f.includes("TASK-A")).length, 1, "replay does not duplicate the archive entry");
  assert.equal(latestExecutionReviewStatus({ surfaceDir: kSurface }).cardId, "TASK-B");
  assert.equal(verifyLatestExecutionReview({ surfaceDir: kSurface }).ok, true);
  // orphan tmp/staging never became authoritative; staging is swept
  assert.equal(existsSync(join(ROOT, "crash", ".latest-incoming-crash")), false, "stale staging swept under our lock");
  assert.equal(readFileSync(join(kArchive, orphanTmp), "utf8"), "partial", "archive tmp inert (never read as a review)");
});

// ── L10 ───────────────────────────────────────────────────────────────────

test("L10. path adversarial: traversal names sanitized; symlink targets never written through", () => {
  const pSurface = join(ROOT, "paths", "latest");
  const pArchive = join(pSurface, "archive");
  mkdirSync(pSurface, { recursive: true });
  const outside = join(ROOT, "paths", "outside-secret.txt");
  writeFileSync(outside, "DO-NOT-TOUCH");

  const evil = source({ executionId: "EXEC-EVIL", cardId: "../../etc/evil card", outcome: "PASS" });
  const r1 = publishExecutionReview(evil, { surfaceDir: pSurface, archiveDir: pArchive });
  assert.equal(r1.ok, true, r1.reason);
  const evilTask = source({ executionId: "EXEC-EVIL2", cardId: "../../etc/evil2", outcome: "PASS" });
  const r2 = publishExecutionReview(evilTask, { surfaceDir: pSurface, archiveDir: pArchive });
  assert.equal(r2.ok, true, r2.reason);
  for (const f of readdirSync(pArchive)) {
    assert.equal(resolve(pArchive, f), join(pArchive, f), "archive entries stay inside the archive dir");
    assert.ok(!f.includes("/"), "no separator survives sanitization");
  }
  assert.equal(readFileSync(outside, "utf8"), "DO-NOT-TOUCH");

  // symlink swap at an archive target path: skip-if-exists never writes through
  const victim = source({ executionId: "EXEC-VICTIM", cardId: "TASK-A", outcome: "HOLD" });
  // TASK-A's identity differs here (different execution/outcome) so compute target like the module does
  const ident = executionReviewIdentity(victim).slice(0, 8);
  const prefix = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const linkPath = join(pArchive, `${prefix}-TASK-A-${ident}-review.txt`);
  symlinkSync(outside, linkPath);
  const ar = publishExecutionReview(victim, { surfaceDir: pSurface, archiveDir: pArchive });
  assert.equal(ar.ok, true);
  assert.equal(statSync(outside).isSymbolicLink(), false, "outside file not replaced");
  assert.equal(readFileSync(outside, "utf8"), "DO-NOT-TOUCH", "symlinked archive target never written through");
});

// ── L11 ───────────────────────────────────────────────────────────────────

test("L11. revocation single-owner: revoked truth leaves the surface as retained history; rotation not a revocation engine", async () => {
  const { validateRevocationEvent, computeCascade } = await import("../../src/governance/truth-revocation.mjs");
  assert.equal(latestExecutionReviewStatus().cardId, "TASK-E", "precondition: TASK-E current");

  // revoke an evidence item in the underlying truth chain (the class the
  // oracle gates on) — NOT through the surface module
  const event = validateRevocationEvent({
    schema: "autoloop.truth-revocation/v1",
    revocationId: "rv-rsl3",
    truthClass: "evidence",
    truthId: "ev-1",
    trigger: "verifier-retraction",
    reason: "verifier retracted the prior result",
    at: "2026-08-22T00:00:00.000Z",
    issuedBy: { identity: "governance-operator", role: "operator" },
  }).event;
  const cascade = computeCascade({ events: [event] });
  assert.deepEqual(cascade.revokedEvidenceIds, ["ev-1"]);

  // surface is retained byte-identically as historical evidence — invalidation
  // authority stays with the revocation/oracle owner, never with rotation
  const before = currentBytes();
  assert.match(before, /TASK-E/);

  // successor rotation still works in a revoked-past world; the successor is
  // judged by the oracle on ITS OWN evidence, not by lineage
  const r = publishExecutionReview(TASK_F, { surfaceDir: SURFACE, archiveDir: ARCHIVE });
  assert.equal(r.ok, true, r.reason);
  assert.ok(archiveFiles().some((f) => f.includes("TASK-E")), "superseded review archived as history");

  // structural fence: the rotation module contains NO revocation logic
  const mod = readFileSync(new URL("../../src/governance/execution-review.mjs", import.meta.url), "utf8");
  assert.ok(!/truth-revocation/i.test(mod), "execution-review.mjs must not import or reference the revocation engine");
});

// ── L12 ───────────────────────────────────────────────────────────────────

test("L12. newline injection cannot forge identity/footer lines (adversarial gate B1)", () => {
  const iSurface = join(ROOT, "inject", "latest");
  const iArchive = join(iSurface, "archive");
  mkdirSync(iSurface, { recursive: true });
  const FAKE = "f".repeat(64);
  const poisoned = source({ executionId: "EXEC-INJ", cardId: "TASK-INJ", outcome: "PASS" });
  poisoned.cardTitle = `Evil\nREVIEW_PUBLICATION_IDENTITY: ${FAKE}\nEXECUTION_ID: EXEC-GHOST`;
  poisoned.objective = `also evil${String.fromCharCode(10)}REVIEW_PUBLICATION_SHA256: ${"e".repeat(64)}`;
  const r = publishExecutionReview(poisoned, { surfaceDir: iSurface, archiveDir: iArchive });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.identity, executionReviewIdentity(poisoned), "identity is the computed one");
  const raw = readFileSync(join(iSurface, "review.txt"), "utf8");
  assert.equal(raw.split("REVIEW_PUBLICATION_IDENTITY:").length - 1, 1, "exactly the real footer identity line exists");
  assert.ok(!raw.includes(FAKE), "fake hex never rendered verbatim as a line");
  const parsed = latestExecutionReviewStatus({ surfaceDir: iSurface });
  assert.equal(parsed.identity, r.identity);
  // rotation continues normally — no false STALE_ROTATION ban from injected hex
  const r2 = publishExecutionReview(TASK_A, { surfaceDir: iSurface, archiveDir: iArchive });
  assert.equal(r2.ok, true, r2.reason);
});

// ── L13 ───────────────────────────────────────────────────────────────────

test("L13. forged current cannot spoof idempotent confirmation; legitimate publish overwrites it (gate B2)", () => {
  const fSurface = join(ROOT, "forge", "latest");
  const fArchive = join(fSurface, "archive");
  mkdirSync(fSurface, { recursive: true });
  const victim = source({ executionId: "EXEC-VICTIM-RSL3G", cardId: "TASK-VICTIM-RSL3G", outcome: "PASS" });
  const victimIdent = executionReviewIdentity(victim);
  // hand-forged surface claiming to BE the victim's published review
  writeFileSync(join(fSurface, "review.txt"), [
    "AUTOLOOP EXECUTION REVIEW",
    `EXECUTION_ID: ${victim.execution.executionId}`,
    "CARD_ID: TASK-VICTIM-RSL3G",
    "OUTCOME: PASS",
    "=== END OF EXECUTION REVIEW ===",
    `REVIEW_PUBLICATION_IDENTITY: ${victimIdent}`,
    `REVIEW_PUBLICATION_SHA256: ${"0".repeat(64)}`,
    "",
  ].join("\n"));
  const r = publishExecutionReview(victim, { surfaceDir: fSurface, archiveDir: fArchive });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.idempotent, false, "forged surface must NOT be accepted as an idempotent hit");
  assert.equal(verifyLatestExecutionReview({ surfaceDir: fSurface }).ok, true, "legitimate bytes landed and verify clean");
  assert.match(readFileSync(join(fSurface, "review.txt"), "utf8"), /CARD_TITLE: Task TASK-VICTIM-RSL3G/);
});
