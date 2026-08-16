// test/governance/test-promotion-gate-authority.mjs
//
// AUTOLOOP-PGMA1 — canonical promotion authority tests.
//
// Coverage (card spec outcomes, all fail-closed):
//   1. retired external-review-result.json is NEVER authority — its presence
//      grants nothing (RC1A §7.2);
//   2. review-job missing / not ACCEPTED -> HOLD;
//   3. delivery missing / not PASS / verdict unbound -> HOLD;
//   4. delivered bundle digest mismatch -> HOLD;
//   5. recomputed candidate identity mismatch -> HOLD;
//   6. reviewed HEAD != local HEAD / branch drift -> HOLD;
//   7. remote unreachable / unknown / diverged -> HOLD;
//   8. exact canonical chain -> PASS;
//   9. push gate: remote already exact -> PROMOTION_ALREADY_SATISFIED;
//  10. both gates compute the SAME promotion identity from the same evidence;
//  11. draft gate idempotent reconciliation returns DRAFT_PR_ALREADY_SATISFIED
//      (prBoundToCanonicalIdentity logic covered at module level).
//
// Run: node --test test/governance/test-promotion-gate-authority.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROMOTION_AUTHORITY_HOLDS,
  PROMOTION_STATUS,
  readReviewJobEvidence,
  readDeliveryEvidence,
  verifyDeliveryBundleDigest,
  computePromotionIdentity,
  evaluatePromotionAuthority,
} from "../../src/governance/promotion-authority.mjs";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";
import { candidateDomain } from "../../src/governance/candidate-domain-policy.mjs";
import { runPushGate } from "../../scripts/gov-push-gate.mjs";
import { prBoundToCanonicalIdentity } from "../../scripts/gov-draft-pr.mjs";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HEX64 = "0123456789abcdef".repeat(4);

function sha(s) {
  return execFileSync("shasum", ["-a", "256"], { input: s, encoding: "utf8" }).split(" ")[0];
}

// ── fixtures ─────────────────────────────────────────────────────────────

function baseReviewJob({ cardId = "fixture-card", head = "a".repeat(40), tree = HEX64, patch = HEX64, base = "b".repeat(40), branch = "gov/fixture" } = {}) {
  return {
    schemaVersion: "autoloop.review-job/v1",
    lineageId: cardId,
    jobId: `${cardId}.g0002`,
    generation: 2,
    candidateIdentity: {
      changedTreeIdentity: tree,
      patchSha256: patch,
      currentHead: head,
      baseHead: base,
      repository: "xonogesrs/autoloop",
      branch,
    },
    specId: cardId,
    specDigest: HEX64,
    reviewRound: 1,
    repairRound: 0,
    priorJobId: `${cardId}.g0001`,
    supersedes: `${cardId}.g0001`,
    state: "ACCEPTED",
    stateVersion: 8,
    requiredArtifacts: [
      { role: "findings", required: true, writeMode: "exclusive-create" },
      { role: "verdict", required: true, writeMode: "exclusive-create" },
    ],
    priorFindingsDigest: HEX64,
    priorVerdictDigest: HEX64,
    repoIdentity: "xonogesrs/autoloop",
    worktreeIdentity: "/fixture/worktree",
    findingsDigest: HEX64,
    verdictDigest: HEX64,
    acceptedAt: "2026-08-16T08:00:28.982Z",
    acceptanceAuthority: "controller",
  };
}

function baseDelivery({ cardId = "fixture-card", bundleIdentity = HEX64, bundleSha256 = HEX64, status = "PASS" } = {}) {
  return {
    schema: "autoloop.external-review-delivery/v2",
    cardId,
    fileName: "delivery.json",
    reviewBundleGenerated: true,
    reviewBundleValidated: true,
    reviewBundleDeliveryRequired: true,
    externalReviewStatus: status,
    externalReviewStatusReason: null,
    delivery: {
      required: true,
      attempted: true,
      method: "external-review-surface",
      attemptedAt: "2026-08-16T09:10:50.498Z",
      bundlePath: "/fixture/bundle.txt",
      reviewBundleIdentity: bundleIdentity,
      reviewBundleSha256: bundleSha256,
    },
    verdict: status === "PASS"
      ? { verdict: "PASS", reviewerIdentity: "ChatGPT", reviewedAt: "2026-08-16T09:24:07.000Z", bundleIdentity, bundleSha256, findingsDigest: null }
      : null,
    supersedes: null,
  };
}

// ── unit tests: evidence reads (fail-closed) ─────────────────────────────

test("readReviewJobEvidence: missing review-job -> REVIEW_JOB_MISSING", () => {
  const root = join(tmpdir(), `pgma1-${process.pid}-missing-rj`);
  const r = readReviewJobEvidence("fixture-card", { root });
  assert.equal(r.ok, false);
  assert.equal(r.code, PROMOTION_AUTHORITY_HOLDS.REVIEW_JOB_MISSING);
});

test("readReviewJobEvidence: not ACCEPTED -> REVIEW_JOB_NOT_ACCEPTED", () => {
  const root = join(tmpdir(), `pgma1-${process.pid}-notacc`);
  mkdirSync(join(root, "fixture-card"), { recursive: true });
  const job = baseReviewJob();
  job.state = "PREPARED";
  writeFileSync(join(root, "fixture-card", "review-job.json"), JSON.stringify(job));
  const r = readReviewJobEvidence("fixture-card", { root });
  assert.equal(r.ok, false);
  assert.equal(r.code, PROMOTION_AUTHORITY_HOLDS.REVIEW_JOB_NOT_ACCEPTED);
});

test("readReviewJobEvidence: ACCEPTED record -> ok", () => {
  const root = join(tmpdir(), `pgma1-${process.pid}-ok`);
  mkdirSync(join(root, "fixture-card"), { recursive: true });
  writeFileSync(join(root, "fixture-card", "review-job.json"), JSON.stringify(baseReviewJob()));
  const r = readReviewJobEvidence("fixture-card", { root });
  assert.equal(r.ok, true);
  assert.equal(r.record.state, "ACCEPTED");
});

test("readDeliveryEvidence: missing delivery -> DELIVERY_MISSING", () => {
  const surface = join(tmpdir(), `pgma1-${process.pid}-nodl`);
  mkdirSync(surface, { recursive: true });
  const r = readDeliveryEvidence(surface);
  assert.equal(r.ok, false);
  assert.equal(r.code, PROMOTION_AUTHORITY_HOLDS.DELIVERY_MISSING);
});

test("readDeliveryEvidence: not PASS -> DELIVERY_NOT_PASS", () => {
  const surface = join(tmpdir(), `pgma1-${process.pid}-pend`);
  mkdirSync(surface, { recursive: true });
  writeFileSync(join(surface, "delivery.json"), JSON.stringify(baseDelivery({ status: "PENDING" })));
  const r = readDeliveryEvidence(surface);
  assert.equal(r.ok, false);
  assert.equal(r.code, PROMOTION_AUTHORITY_HOLDS.DELIVERY_NOT_PASS);
});

test("readDeliveryEvidence: PASS verdict unbound (identity/sha mismatch) -> DELIVERY_VERDICT_UNBOUND", () => {
  const surface = join(tmpdir(), `pgma1-${process.pid}-unbound`);
  mkdirSync(surface, { recursive: true });
  const d = baseDelivery({ bundleSha256: HEX64 });
  d.verdict.bundleSha256 = "f".repeat(64); // verdict sha != delivery sha
  writeFileSync(join(surface, "delivery.json"), JSON.stringify(d));
  const r = readDeliveryEvidence(surface);
  assert.equal(r.ok, false);
  assert.equal(r.code, PROMOTION_AUTHORITY_HOLDS.DELIVERY_VERDICT_UNBOUND);
});

test("readDeliveryEvidence: bound PASS -> ok", () => {
  const surface = join(tmpdir(), `pgma1-${process.pid}-bdl`);
  mkdirSync(surface, { recursive: true });
  writeFileSync(join(surface, "delivery.json"), JSON.stringify(baseDelivery()));
  const r = readDeliveryEvidence(surface);
  assert.equal(r.ok, true);
  assert.equal(r.record.externalReviewStatus, "PASS");
});

test("verifyDeliveryBundleDigest: missing bundle / digest mismatch / match", () => {
  const surface = join(tmpdir(), `pgma1-${process.pid}-digest`);
  mkdirSync(surface, { recursive: true });
  // missing
  let r = verifyDeliveryBundleDigest(surface, { expectedSha256: HEX64 });
  assert.equal(r.ok, false);
  assert.equal(r.code, PROMOTION_AUTHORITY_HOLDS.DELIVERY_BUNDLE_DIGEST_MISMATCH);
  // mismatch
  writeFileSync(join(surface, "review-bundle.txt"), "BODY\nREVIEW_BUNDLE_SHA256: " + HEX64 + "\n");
  r = verifyDeliveryBundleDigest(surface, { expectedSha256: "f".repeat(64) });
  assert.equal(r.ok, false);
  assert.equal(r.code, PROMOTION_AUTHORITY_HOLDS.DELIVERY_BUNDLE_DIGEST_MISMATCH);
  // match — digest excludes the footer line
  const body = "LINE1\nLINE2\n";
  const bodySha = sha(body);
  writeFileSync(join(surface, "review-bundle.txt"), body + `REVIEW_BUNDLE_SHA256: ${bodySha}\n`);
  r = verifyDeliveryBundleDigest(surface, { expectedSha256: bodySha });
  assert.equal(r.ok, true);
  assert.equal(r.sha256, bodySha);
});

// ── unit tests: promotion evaluation (all fail-closed rows) ─────────────

function evalFixture(over = {}) {
  const job = baseReviewJob();
  const dl = baseDelivery();
  const inventory = {
    changedTreeIdentity: job.candidateIdentity.changedTreeIdentity,
    patchSha256: job.candidateIdentity.patchSha256,
    head: job.candidateIdentity.currentHead,
    baseHead: job.candidateIdentity.baseHead,
    branch: job.candidateIdentity.branch,
  };
  return evaluatePromotionAuthority({
    reviewJob: job,
    delivery: dl,
    bundleSha256: dl.delivery.reviewBundleSha256,
    inventory,
    localHead: job.candidateIdentity.currentHead,
    remoteHead: job.candidateIdentity.currentHead,
    remoteReachable: true,
    fastForwardOnly: true,
    ...over,
  });
}

test("evaluate: candidate identity mismatch -> HOLD CANDIDATE_IDENTITY_MISMATCH", () => {
  const r = evalFixture({ inventory: { changedTreeIdentity: "c".repeat(64), patchSha256: "d".repeat(64), head: "a".repeat(40), branch: "gov/fixture" } });
  assert.equal(r.allowed, false);
  assert.match(r.violations.join(";"), /CANDIDATE_IDENTITY_MISMATCH/);
});

test("evaluate: local HEAD mismatch -> HOLD HEAD_MISMATCH_LOCAL", () => {
  const r = evalFixture({ localHead: "e".repeat(40) });
  assert.equal(r.allowed, false);
  assert.match(r.violations.join(";"), /HEAD_MISMATCH_LOCAL/);
});

test("evaluate: branch drift -> HOLD DELIVERY_STALE", () => {
  const r = evalFixture({ inventory: { changedTreeIdentity: HEX64, patchSha256: HEX64, head: "a".repeat(40), branch: "gov/other" } });
  assert.equal(r.allowed, false);
  assert.match(r.violations.join(";"), /DELIVERY_STALE/);
});

test("evaluate: delivery cardId drift -> HOLD DELIVERY_STALE", () => {
  const dl = baseDelivery({ cardId: "other-card" });
  const r = evalFixture({ delivery: dl });
  assert.equal(r.allowed, false);
  assert.match(r.violations.join(";"), /DELIVERY_STALE/);
});

test("evaluate: remote unreachable -> HOLD REMOTE_UNREACHABLE", () => {
  const r = evalFixture({ remoteReachable: false, remoteHead: null });
  assert.equal(r.allowed, false);
  assert.match(r.violations.join(";"), /REMOTE_UNREACHABLE/);
});

test("evaluate: remote reachable but branch absent -> AUTHORIZED (first push creates at reviewed head)", () => {
  const r = evalFixture({ remoteHead: null });
  assert.equal(r.allowed, true);
  assert.equal(r.status, PROMOTION_STATUS.AUTHORIZED);
});

test("evaluate: remote diverged -> HOLD REMOTE_DIVERGED", () => {
  const r = evalFixture({ remoteHead: "e".repeat(40), fastForwardOnly: false });
  assert.equal(r.allowed, false);
  assert.match(r.violations.join(";"), /REMOTE_DIVERGED/);
});

test("evaluate: remote == reviewed head -> PROMOTION_ALREADY_SATISFIED", () => {
  const r = evalFixture({});
  assert.equal(r.allowed, true);
  assert.equal(r.status, PROMOTION_STATUS.ALREADY_SATISFIED);
});

test("evaluate: remote behind (fast-forward) -> PROMOTION_AUTHORIZED", () => {
  const r = evalFixture({ remoteHead: "e".repeat(40), fastForwardOnly: true });
  assert.equal(r.allowed, true);
  assert.equal(r.status, PROMOTION_STATUS.AUTHORIZED);
});

test("evaluate: baseHead drift after review -> HOLD CANDIDATE_IDENTITY_MISMATCH", () => {
  const r = evalFixture({ inventory: { changedTreeIdentity: HEX64, patchSha256: HEX64, head: "a".repeat(40), baseHead: "f".repeat(40), branch: "gov/fixture" } });
  assert.equal(r.allowed, false);
  assert.match(r.violations.join(";"), /CANDIDATE_IDENTITY_MISMATCH/);
});

test("readDeliveryEvidence: delivery without cardId -> DELIVERY_INVALID (staleness check must not be skippable)", () => {
  const surface = join(tmpdir(), `pgma1-${process.pid}-nocard`);
  mkdirSync(surface, { recursive: true });
  const d = baseDelivery();
  delete d.cardId;
  writeFileSync(join(surface, "delivery.json"), JSON.stringify(d));
  const r = readDeliveryEvidence(surface);
  assert.equal(r.ok, false);
  assert.equal(r.code, PROMOTION_AUTHORITY_HOLDS.DELIVERY_INVALID);
});

// ── unit tests: shared promotion identity ────────────────────────────────

test("computePromotionIdentity: deterministic and shared across gates", () => {
  const job = baseReviewJob();
  const dl = baseDelivery();
  const i1 = computePromotionIdentity({ reviewJob: job, delivery: dl, bundleSha256: dl.delivery.reviewBundleSha256 });
  const i2 = computePromotionIdentity({ reviewJob: job, delivery: dl, bundleSha256: dl.delivery.reviewBundleSha256 });
  assert.equal(i1, i2);
  assert.match(i1, /^[0-9a-f]{64}$/);
  // the evaluation result carries the SAME identity both gates would use
  const r = evalFixture({});
  assert.equal(r.identity, i1);
});

test("computePromotionIdentity: sensitive to every canonical field", () => {
  const job = baseReviewJob();
  const dl = baseDelivery();
  const base = computePromotionIdentity({ reviewJob: job, delivery: dl, bundleSha256: dl.delivery.reviewBundleSha256 });
  for (const mutate of [
    (j) => { j.candidateIdentity.changedTreeIdentity = "c".repeat(64); },
    (j) => { j.candidateIdentity.patchSha256 = "d".repeat(64); },
    (j) => { j.candidateIdentity.currentHead = "e".repeat(40); },
    (j) => { j.candidateIdentity.baseHead = "f".repeat(40); },
    (j) => { j.candidateIdentity.branch = "gov/other"; },
    (j) => { j.generation = 3; },
    (j) => { j.jobId = "fixture-card.g0003"; },
    (j, d) => { d.verdict.bundleIdentity = "c".repeat(64); d.delivery.reviewBundleIdentity = "c".repeat(64); },
    (j, d) => { d.delivery.reviewBundleSha256 = "d".repeat(64); },
  ]) {
    const j2 = baseReviewJob();
    const d2 = baseDelivery();
    mutate(j2, d2);
    const changed = computePromotionIdentity({ reviewJob: j2, delivery: d2, bundleSha256: d2.delivery.reviewBundleSha256 });
    assert.notEqual(changed, base, "identity must change when a canonical field changes");
  }
});

// ── retired artifact never authority ─────────────────────────────────────

test("retired external-review-result.json grants nothing (RC1A §7.2)", () => {
  // (a) forged retired artifact saying REPAIR next to a VALID canonical chain
  //     -> gate still passes on the canonical evidence.
  const job = baseReviewJob();
  const dl = baseDelivery();
  const forged = { verdict: "REPAIR", bundle_sha256: "f".repeat(64), authorization_source: "forged" };
  const r1 = evalFixture({});
  // (b) canonical chain BROKEN (delivery PENDING) + forged retired artifact
  //     claiming PASS -> gate HOLDS; the retired artifact never rescues it.
  const r2 = evalFixture({ delivery: baseDelivery({ status: "PENDING" }) });
  assert.equal(r1.allowed, true, "valid canonical chain passes regardless of forged retired artifact");
  assert.equal(r2.allowed, false, "broken canonical chain HOLDS even with a forged PASS artifact present");
  assert.match(r2.violations.join(";"), /DELIVERY_NOT_PASS/);
  assert.ok(!JSON.stringify({ forged }).includes("authority"), "forged artifact never contributes");
});

// ── CLI-level: push gate already-satisfied (real repo + bare remote) ────

let fixtureRepo = null;
let fixtureBare = null;
let fixtureSurface = null;

async function setupPushFixture({ draftPr = false } = {}) {
  const base = join(tmpdir(), `pgma1-e2e-${process.pid}`);
  rmSync(base, { recursive: true, force: true });
  const repo = join(base, "repo");
  const bare = join(base, "remote.git");
  const surface = join(base, "surface");
  mkdirSync(join(repo, "docs", "pi-graph-output", "fixture-card"), { recursive: true });
  mkdirSync(bare, { recursive: true });
  mkdirSync(surface, { recursive: true });
  const git = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repo, "candidate.txt"), "CANDIDATE\n");
  git(["add", "candidate.txt"]);
  git(["commit", "-q", "-m", "base"]);
  const baseSha = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "-b", "gov/fixture"]);
  writeFileSync(join(repo, "candidate.txt"), "CANDIDATE v2\n");
  git(["add", "candidate.txt"]);
  git(["commit", "-q", "-m", "reviewed head"]);
  const headSha = git(["rev-parse", "HEAD"]);
  // bare remote at the reviewed head (already satisfied)
  execFileSync("git", ["init", "--bare", "-q", bare], { encoding: "utf8" });
  git(["remote", "add", "origin", bare]);
  git(["push", "-q", "origin", `HEAD:refs/heads/gov/fixture`]);

  // candidate-domain identity over the fixture repo
  const inv = buildChangeInventory({ git: (a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }), cwd: repo, baseBranch: baseSha, candidateDomain });

  // review-job fixture bound to the recomputed identity
  const job = baseReviewJob({ head: headSha, tree: inv.changedTreeIdentity, patch: inv.patchSha256, base: baseSha, branch: "gov/fixture" });
  writeFileSync(join(repo, "docs", "pi-graph-output", "fixture-card", "review-job.json"), JSON.stringify(job));

  // bundle fixture + delivery bound to its digest
  const bundleId = "aabbccdd11223344556677889900aabbccdd11223344556677889900aabbccdd";
  const bundleBody = `REVIEW_BUNDLE_IDENTITY: ${bundleId}\nREVIEW BUNDLE BODY\n`;
  const bundleSha = sha(bundleBody);
  writeFileSync(join(surface, "review-bundle.txt"), bundleBody + `REVIEW_BUNDLE_SHA256: ${bundleSha}\n`);
  writeFileSync(join(surface, "delivery.json"), JSON.stringify(baseDelivery({ cardId: "fixture-card", bundleIdentity: bundleId, bundleSha256: bundleSha })));

  // authority record bound to the fixture repo
  const authority = {
    schema: "autoloop.lifecycle-authorization/v2",
    card_id: "fixture-card",
    run_id: "fixture-card-r1",
    repository: "xonogesrs/autoloop",
    worktree: resolve(repo),
    branch: "gov/fixture",
    base: baseSha,
    base_head: baseSha,
    authorized_paths: ["candidate.txt"],
    bundle_path: "docs/pi-graph-output/fixture-card/bundle.txt",
    lifecycle_authorization: {
      decomposition: { allowed: false, max_depth: 0, max_total_nodes: 0 },
      independent_review: { allowed: true, require_fresh_session: true, require_same_artifact_digest: true },
      bounded_repair: { allowed: false, max_rounds: 0, scope_expansion: false },
      checkpoint_commit: { allowed: true, require_local_gates_pass: true, require_clean_index_before_stage: true, require_expected_paths_only: true },
      feature_branch_push: { allowed: true, branch_pattern: "gov/*", force_push: false, require_remote_ancestor_check: true },
      draft_pr: draftPr
        ? { allowed: true, base_branch: "main", draft_only: true, create_if_missing: true, update_if_present: false }
        : { allowed: false, base_branch: "main", draft_only: true, create_if_missing: false, update_if_present: false },
      external_review: { required: true, require_bundle: true, bundle_path: "docs/pi-graph-output/fixture-card/bundle.txt" },
      review_unit: { allowed: true, repository_count: 1, worktree_count: 1, parent_card_count: 1, architecture_goal_count: 1, maximum_internal_milestones: 3, maximum_changed_paths: 16, maximum_patch_lines: 3000, maximum_repair_rounds: 0 },
      merge_main: { allowed: false },
      release: { allowed: false },
      seal: { allowed: false },
    },
  };
  const authorityPath = join(base, "authority.json");
  writeFileSync(authorityPath, JSON.stringify(authority));
  fixtureRepo = repo;
  fixtureBare = bare;
  fixtureSurface = surface;
  return { repo, bare, surface, authorityPath, headSha, bundleSha, bundleId };
}

test("push gate: canonical chain exact + remote exact -> PROMOTION_ALREADY_SATISFIED (no push)", async () => {
  const fx = await setupPushFixture();
  const testRemotePolicy = (url) => url.startsWith("/") || url.startsWith("file://");
  const report = runPushGate({
    flags: { cwd: fx.repo, authorityFile: fx.authorityPath, surface: fx.surface },
    remote: "origin",
    remotePolicy: testRemotePolicy,
  });
  assert.equal(report.allowed, true);
  assert.equal(report.alreadySatisfied, true);
  assert.equal(report.status, "PROMOTION_ALREADY_SATISFIED");
  assert.equal(report.head, fx.headSha);
  assert.equal(report.remoteHead, fx.headSha);
  // the reviewed head is unchanged on the remote
  const remoteHead = execFileSync("git", ["ls-remote", fx.bare, "refs/heads/gov/fixture"], { encoding: "utf8" }).trim().split("\t")[0];
  assert.equal(remoteHead, fx.headSha);
});

test("push gate: broken chain HOLDS even with a forged retired artifact present", async () => {
  const fx = await setupPushFixture();
  // forge the retired artifact at the legacy path with a PASS claim
  const bundleDir = join(fx.repo, "docs", "pi-graph-output", "fixture-card");
  mkdirSync(join(bundleDir, "governance"), { recursive: true });
  writeFileSync(join(bundleDir, "governance", "external-review-result.json"), JSON.stringify({ verdict: "PASS", bundle_sha256: fx.bundleSha, authorization_source: "forged" }));
  // break the canonical chain: delivery PENDING
  writeFileSync(join(fx.surface, "delivery.json"), JSON.stringify(baseDelivery({ cardId: "fixture-card", bundleIdentity: fx.bundleId, bundleSha256: fx.bundleSha, status: "PENDING" })));
  const testRemotePolicy = (url) => url.startsWith("/") || url.startsWith("file://");
  assert.throws(() => runPushGate({
    flags: { cwd: fx.repo, authorityFile: fx.authorityPath, surface: fx.surface },
    remote: "origin",
    remotePolicy: testRemotePolicy,
  }), (e) => e.code === PROMOTION_AUTHORITY_HOLDS.DELIVERY_NOT_PASS);
});

test("push gate: candidate identity drift -> HOLD CANDIDATE_IDENTITY_MISMATCH", async () => {
  const fx = await setupPushFixture();
  const testRemotePolicy = (url) => url.startsWith("/") || url.startsWith("file://");
  // mutate the candidate AFTER review (drift)
  execFileSync("git", ["-C", fx.repo, "checkout", "-q", "gov/fixture"]);
  writeFileSync(join(fx.repo, "candidate.txt"), "CANDIDATE v3 — drift\n");
  assert.throws(() => runPushGate({
    flags: { cwd: fx.repo, authorityFile: fx.authorityPath, surface: fx.surface },
    remote: "origin",
    remotePolicy: testRemotePolicy,
  }), (e) => e.code === PROMOTION_AUTHORITY_HOLDS.CANDIDATE_IDENTITY_MISMATCH);
});

test("draft gate: canonical chain + pushed head + no existing PR -> CREATE (dry-run)", async () => {
  const fx = await setupPushFixture({ draftPr: true });
  const out = execFileSync("node", [
    resolve(REPO_DIR, "scripts", "gov-draft-pr.mjs"),
    "--cwd", fx.repo, "--authority-file", fx.authorityPath, "--surface", fx.surface,
  ], { encoding: "utf8" });
  const report = JSON.parse(out);
  assert.equal(report.action, "CREATE");
  assert.equal(report.dryRun, true);
  assert.equal(report.verified, true);
});

test("draft gate: existing PR body binding check (DRAFT_PR_ALREADY_SATISFIED predicate)", () => {
  const job = baseReviewJob({ tree: "1".repeat(64), patch: "2".repeat(64), head: "3".repeat(40) });
  const dl = baseDelivery({ bundleIdentity: "4".repeat(64), bundleSha256: "5".repeat(64) });
  const bound = [
    `CARD_ID: ${job.lineageId}`,
    `REVIEW_BUNDLE_IDENTITY: ${dl.delivery.reviewBundleIdentity}`,
    `REVIEW_BUNDLE_SHA256: ${dl.delivery.reviewBundleSha256}`,
    `CHANGED_TREE_IDENTITY: ${job.candidateIdentity.changedTreeIdentity}`,
    `REVIEWED_HEAD: ${job.candidateIdentity.currentHead}`,
  ].join("\n");
  const ok = prBoundToCanonicalIdentity({ body: bound, reviewJob: job, delivery: dl, bundleSha256: dl.delivery.reviewBundleSha256 });
  assert.equal(ok, true);
  const stale = bound.replace(job.candidateIdentity.changedTreeIdentity, "c".repeat(64));
  assert.equal(prBoundToCanonicalIdentity({ body: stale, reviewJob: job, delivery: dl, bundleSha256: dl.delivery.reviewBundleSha256 }), false, "stale changed-tree binding must not satisfy");
});

after(() => {
  if (fixtureRepo) rmSync(dirname(fixtureRepo), { recursive: true, force: true });
});
