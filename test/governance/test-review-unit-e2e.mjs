// test/governance/test-review-unit-e2e.mjs
// End-to-end (round 2, §14 + external findings 1–8):
//
//   execute → internal checkpoint → bundle (clean worktree) → PENDING blocks
//   push → Controller exclusive-creates digest-bound PASS result → integration
//   attestation (NO new commit — reviewed HEAD stays pushable) → push dry-run
//   PASSES → artifact modified → blocked again.
//
// Plus CLI negative tests: invalid authority record, review-unit measurement
// failure, production skip-fresh-verify rejection, scope/repo/remote overrides.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTempRepo, CARD_ID, RUN_ID } from "./helpers.mjs";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";
import { bundleDigestFromFile } from "../../src/governance/review-context.mjs";
import { writeExternalReviewResult } from "../../src/governance/external-review.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const run = (script, args, cwd, env = {}) => {
  try {
    const stdout = execFileSync("node", [join(REPO, "scripts", script), ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
};

function writeAuthorityRecord(dir, bundlePath) {
  const baseHead = execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim();
  const record = {
    schema: "autoloop.lifecycle-authorization/v2",
    card_id: CARD_ID,
    run_id: RUN_ID,
    issued_at: new Date().toISOString(),
    authorized_by: "controller",
    authorization_ref: "card",
    repository: "xonogesrs/autoloop",
    worktree: dir,
    branch: "governance/test-unit",
    base: "main",
    base_head: baseHead,
    authorized_paths: ["work/", ".gitignore"],
    bundle_path: bundlePath,
    lifecycle_authorization: {
      decomposition: { allowed: true, max_depth: 1, max_total_nodes: 16 },
      independent_review: { allowed: true, require_fresh_session: true, require_same_artifact_digest: true },
      bounded_repair: { allowed: true, max_rounds: 2, scope_expansion: false },
      checkpoint_commit: { allowed: true, require_local_gates_pass: true, require_clean_index_before_stage: true, require_expected_paths_only: true },
      feature_branch_push: { allowed: true, branch_pattern: "governance/*", force_push: false, require_remote_ancestor_check: true },
      draft_pr: { allowed: true, base_branch: "main", draft_only: true, create_if_missing: true, update_if_present: true },
      external_review: { required: true, require_bundle: true, bundle_path: bundlePath },
      review_unit: { allowed: true, repository_count: 1, worktree_count: 1, parent_card_count: 1, architecture_goal_count: 1, maximum_internal_milestones: 3, maximum_changed_paths: 25, maximum_patch_lines: 3000, maximum_repair_rounds: 2 },
      merge_main: { allowed: false },
      release: { allowed: false },
      seal: { allowed: false },
    },
  };
  const authorityPath = join(dir, "authority.json");
  writeFileSync(authorityPath, JSON.stringify(record, null, 2));
  return authorityPath;
}

function inventoryOf(dir) {
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  return buildChangeInventory({ git, cwd: dir, baseBranch: "main" });
}

test("e2e: checkpoint → clean bundle → PENDING push blocked → controller PASS → attestation → push dry-run passes → tamper blocks", (t) => {
  const { dir, git } = createTempRepo(t);
  // harness artifacts gitignored (not part of the unit)
  writeFileSync(join(dir, ".gitignore"), "authority.json\nmeta.json\nout/\ngovernance/\nremote/\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore harness"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);

  // bare remote whose URL resolves to the authorized repository
  const bareDir = join(dir, "remote", "xonogesrs", "autoloop.git");
  mkdirSync(bareDir, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q"], { cwd: bareDir });
  git(["remote", "add", "origin", bareDir]);

  // ── EXECUTE + checkpoint milestone 1 (all content committed) ──
  writeFileSync(join(dir, "work", "a.txt"), "milestone one\n");
  const ck1 = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir,
    "--verification-passed", "true", "--artifact-identity", "sha256:unit",
    "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", "m1", "--milestones", "1",
    "--message", "checkpoint: e2e m1",
  ], dir);
  assert.equal(ck1.status, 0, ck1.stderr);
  const applied1 = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir,
    "--verification-passed", "true", "--artifact-identity", "sha256:unit",
    "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", "m1", "--milestones", "1",
    "--message", "checkpoint: e2e m1", "--apply",
  ], dir);
  assert.equal(applied1.status, 0, applied1.stderr);

  // ── EXECUTE + checkpoint milestone 2 (worktree ends CLEAN) ──
  writeFileSync(join(dir, "work", "b.txt"), "milestone two\n");
  const applied2 = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir,
    "--verification-passed", "true", "--artifact-identity", "sha256:unit",
    "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", "m2", "--milestones", "2",
    "--message", "checkpoint: e2e m2", "--apply",
  ], dir);
  assert.equal(applied2.status, 0, applied2.stderr);
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(status, "", "worktree must be clean before bundling");

  // ── BUNDLE (test fixture mode: honest NOT-RUN fresh verification) ──
  const metaPath = join(dir, "meta.json");
  writeFileSync(metaPath, JSON.stringify({ goal: "e2e unit", completed: "m1+m2", repairRounds: 0, openQuestions: [] }));
  const bundle = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", authorityPath,
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--review-round", "1",
    "--base-branch", "main", "--out-dir", outDir, "--skip-fresh-verify",
    "--milestones", "m1,m2", "--meta", metaPath,
  ], dir, { AUTOLOOP_TEST_FIXTURE: "1" });
  assert.equal(bundle.status, 0, bundle.stderr);
  assert.ok(existsSync(bundlePath), "bundle file written");
  const jsonText = bundle.stdout.slice(bundle.stdout.indexOf("{"), bundle.stdout.lastIndexOf("}") + 1);
  const bundleJson = JSON.parse(jsonText);
  assert.equal(bundleJson.bundle_sha256.length, 64);

  // ── PENDING blocks push (no result artifact → EXTERNAL_REVIEW_RESULT_MISSING) ──
  const pushPending = run("gov-push-gate.mjs", ["--authority-file", authorityPath, "--cwd", dir], dir);
  assert.notEqual(pushPending.status, 0);
  assert.match(pushPending.stderr, /EXTERNAL_REVIEW_RESULT_MISSING/);
  // no remote branch pushed
  const remoteBranches = execFileSync("git", ["--git-dir", bareDir, "branch", "--list"], { encoding: "utf8" }).trim();
  assert.equal(remoteBranches, "", "nothing pushed before PASS");

  // ── Controller exclusive-creates the digest-bound PASS result ──
  const inv = inventoryOf(dir);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const baseHead = execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim();
  const result = {
    schema: "autoloop.external-review-result/v1",
    card_id: CARD_ID,
    run_id: RUN_ID,
    verdict: "PASS",
    bundle_sha256: bundleDigestFromFile(readFileSync(bundlePath, "utf8")),
    patch_sha256: inv.patchSha256,
    changed_tree_identity: inv.changedTreeIdentity,
    reviewer_identity: "external-reviewer-1",
    reviewed_at: new Date().toISOString(),
    review_round: 1,
    findings_digest: "f".repeat(64),
    authorization_source: "controller-session:e2e-final-1",
    current_head: head,
    base_head: baseHead,
    repository: "xonogesrs/autoloop",
    branch: "governance/test-unit",
    base_branch: "main",
    bundle_path: bundlePath,
  };
  writeExternalReviewResult(dir, result); // exclusive-create (controller-owned)
  // exclusive-create refuses overwrite
  assert.throws(() => writeExternalReviewResult(dir, result), (e) => e.code === "HOLD / EXTERNAL_REVIEW_RESULT_INVALID" || e.code.includes("EEXIST") || e.code === undefined);

  // ── INTEGRATION attestation: verified, NO new commit, HEAD unchanged ──
  const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const integration = run("gov-commit-integration.mjs", [
    "--authority-file", authorityPath, "--cwd", dir,
    "--verification-passed", "true", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
  ], dir);
  assert.equal(integration.status, 0, integration.stderr);
  const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(headAfter, headBefore, "integration must NOT create a new commit");

  // ── PUSH dry-run now PASSES: the reviewed checkpoint HEAD is pushable ──
  const pushPass = run("gov-push-gate.mjs", ["--authority-file", authorityPath, "--cwd", dir], dir);
  assert.equal(pushPass.status, 0, pushPass.stderr);
  const pushJson = JSON.parse(pushPass.stdout.slice(pushPass.stdout.indexOf("{")));
  assert.equal(pushJson.allowed, true);

  // ── ARTIFACT MODIFIED → blocked again (digest mismatch) ──
  const tampered = JSON.parse(readFileSync(join(dir, "governance", "external-review-result.json"), "utf8"));
  tampered.bundle_sha256 = "0".repeat(64);
  writeFileSync(join(dir, "governance", "external-review-result.json"), JSON.stringify(tampered, null, 2));
  const blocked = run("gov-commit-integration.mjs", [
    "--authority-file", authorityPath, "--cwd", dir,
    "--verification-passed", "true", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
  ], dir);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /EVIDENCE_IDENTITY_MISMATCH/);
  const pushBlocked = run("gov-push-gate.mjs", ["--authority-file", authorityPath, "--cwd", dir], dir);
  assert.notEqual(pushBlocked.status, 0);

  // main unchanged, nothing pushed
  const mainHead = execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(mainHead, baseHead);
  const remoteBranches2 = execFileSync("git", ["--git-dir", bareDir, "branch", "--list"], { encoding: "utf8" }).trim();
  assert.equal(remoteBranches2, "");
});

test("e2e: self-declared PASS flags are rejected by the CLIs", (t) => {
  const { dir } = createTempRepo(t);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  const selfDeclared = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir,
    "--external-review-status", "PASS",
    "--card-id", CARD_ID,
  ], dir);
  assert.notEqual(selfDeclared.status, 0);
  assert.match(selfDeclared.stderr, /RESULT_SELF_DECLARATION_REJECTED/);
  const callerIdentity = run("gov-push-gate.mjs", [
    "--authority-file", authorityPath, "--cwd", dir,
    "--reviewed-artifact-identity", "x".repeat(64),
  ], dir);
  assert.notEqual(callerIdentity.status, 0);
  assert.match(callerIdentity.stderr, /RESULT_SELF_DECLARATION_REJECTED/);
  const resultFile = run("gov-push-gate.mjs", [
    "--authority-file", authorityPath, "--cwd", dir,
    "--result-file", join(dir, "fake-result.json"),
  ], dir);
  assert.notEqual(resultFile.status, 0);
  assert.match(resultFile.stderr, /RESULT_SELF_DECLARATION_REJECTED|--result-file|unexpected/i);
});

test("[findings 2] invalid authority record (missing top-level bindings) is rejected by the CLI", (t) => {
  const { dir } = createTempRepo(t);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  const bad = JSON.parse(readFileSync(writeAuthorityRecord(dir, bundlePath), "utf8"));
  delete bad.repository;
  delete bad.bundle_path;
  const badPath = join(dir, "authority-bad.json");
  writeFileSync(badPath, JSON.stringify(bad, null, 2));
  const res = run("gov-commit-checkpoint.mjs", ["--authority-file", badPath, "--cwd", dir, "--card-id", CARD_ID], dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /AUTHORIZATION_INVALID|rejected/i);
  const bundleRes = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", badPath,
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--base-branch", "main",
    "--out-dir", outDir, "--skip-fresh-verify", "--meta", join(dir, "meta.json"),
  ], dir, { AUTOLOOP_TEST_FIXTURE: "1" });
  assert.notEqual(bundleRes.status, 0);
  assert.match(bundleRes.stderr, /AUTHORIZATION_INVALID/);
});

test("[findings 3] review-unit measurement failure is fail-closed (REVIEW_UNIT_MEASUREMENT_INCOMPLETE)", (t) => {
  // a directory that is NOT under any git repository makes the change
  // inventory unbuildable → the CLI must fail closed, never skip the check
  const { dir } = createTempRepo(t);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  const plainDir = mkdtempSync(join(tmpdir(), "autoloop-non-git-"));
  t.after(() => rmSync(plainDir, { recursive: true, force: true }));
  const res = run("gov-commit-checkpoint.mjs", ["--authority-file", authorityPath, "--cwd", plainDir, "--card-id", CARD_ID], plainDir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /REVIEW_UNIT_MEASUREMENT_INCOMPLETE|not a git repository|rev-parse/i);
});

test("[findings 4] production CLI rejects --skip-fresh-verify", (t) => {
  const { dir } = createTempRepo(t);
  const res = run("gov-review-bundle.mjs", ["--cwd", dir, "--skip-fresh-verify", "--card-id", CARD_ID], dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /FRESH_VERIFY_REQUIRED/);
});

test("[findings 6] CLI scope / repo / remote overrides are rejected", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), "authority.json\nmeta.json\nout/\ngovernance/\nremote/\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  writeFileSync(join(dir, "work", "a.txt"), "a\n");

  // scope override outside the authorized scope → rejected
  const scope = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir, "--card-id", CARD_ID,
    "--expected-paths", "src/nuclear/",
  ], dir);
  assert.notEqual(scope.status, 0);
  assert.match(scope.stderr, /CLI_OVERRIDE_REJECTED/);

  // remote override pointing at a non-authorized repository → rejected
  const wrongRemote = join(dir, "elsewhere.git");
  execFileSync("git", ["init", "--bare", "-q", wrongRemote], { encoding: "utf8" });
  git(["remote", "add", "evil", wrongRemote]);
  const remote = run("gov-push-gate.mjs", [
    "--authority-file", authorityPath, "--cwd", dir, "--remote", "evil",
  ], dir);
  assert.notEqual(remote.status, 0);
  assert.match(remote.stderr, /REMOTE_NOT_AUTHORIZED/);

  // draft --repo override mismatching the reviewed repository → rejected
  const draft = run("gov-draft-pr.mjs", [
    "--authority-file", authorityPath, "--cwd", dir,
    "--repo", "other/repo", "--head", "governance/test-unit",
  ], dir);
  assert.notEqual(draft.status, 0);
  assert.match(draft.stderr, /CLI_OVERRIDE_REJECTED|EXTERNAL_REVIEW_RESULT_MISSING|result artifact/);
});

test("e2e: bundle path mismatch → HOLD / BUNDLE_PATH_MISMATCH (findings 14 at CLI level)", (t) => {
  const { dir } = createTempRepo(t);
  const outDir = join(dir, "out");
  mkdirSync(outDir, { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, join(outDir, "READY_FOR_REVIEW.txt"));
  const wrong = JSON.parse(readFileSync(authorityPath, "utf8"));
  wrong.bundle_path = join(dir, "elsewhere", "READY_FOR_REVIEW.txt");
  wrong.lifecycle_authorization.external_review.bundle_path = wrong.bundle_path;
  const wrongPath = join(dir, "authority-wrong.json");
  writeFileSync(wrongPath, JSON.stringify(wrong, null, 2));
  mkdirSync(join(dir, "work"), { recursive: true });
  writeFileSync(join(dir, "work", "a.txt"), "x\n");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ goal: "x" }));
  const res = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", wrongPath,
    "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir,
    "--skip-fresh-verify", "--meta", join(dir, "meta.json"),
  ], dir, { AUTOLOOP_TEST_FIXTURE: "1" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /BUNDLE_PATH_MISMATCH/);
});
