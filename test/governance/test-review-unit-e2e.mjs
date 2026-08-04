// test/governance/test-review-unit-e2e.mjs
// End-to-end (round 3 findings 1–6):
//
//   execute → checkpoint → bundle (real minimal verification, NO skip path)
//   → PENDING push blocked → Controller ingestion entry creates the PASS
//   result (exclusive-create, digest computed from the bundle) → integration
//   attestation (no new commit) → push dry-run PASSES → artifact modified →
//   blocked again.
//
// Plus the 11 required negative tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTempRepo, CARD_ID, RUN_ID } from "./helpers.mjs";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";
import { remoteUrlMatchesAuthorizedRepository } from "../../scripts/shared/gov-args.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const run = (script, args, cwd) => {
  try {
    const stdout = execFileSync("node", [join(REPO, "scripts", script), ...args], { cwd, encoding: "utf8" });
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
    worktree: realpathSync(dir),
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

function writeVerifyFixture(dir) {
  const p = join(dir, "verify.mjs");
  writeFileSync(p, "import { existsSync } from 'node:fs';\nif (!existsSync('work/a.txt') || !existsSync('work/b.txt')) { console.error('missing work files'); process.exit(1); }\nconsole.log('fixture verification ok');\n");
  writeFileSync(join(dir, "verify-config.json"), JSON.stringify({ commands: [["node verify.mjs", "fixture verification"]] }));
  return join(dir, "verify-config.json");
}

test("e2e: checkpoint → clean bundle → PENDING push blocked → controller PASS → attestation → push dry-run passes → tamper blocks", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), "authority.json\nmeta.json\nout/\ngovernance/\nremote/\nverify.mjs\nverify-config.json\n");
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

  // ── EXECUTE + checkpoint milestone 1 ──
  writeFileSync(join(dir, "work", "a.txt"), "milestone one\n");
  const ckArgs = (m, ms) => [
    "--authority-file", authorityPath, "--cwd", dir,
    "--verification-passed", "true", "--artifact-identity", "sha256:unit",
    "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", m, "--milestones", ms,
  ];
  const ck1 = run("gov-commit-checkpoint.mjs", [...ckArgs("m1", "1"), "--message", "checkpoint: e2e m1", "--apply"], dir);
  assert.equal(ck1.status, 0, ck1.stderr);

  // ── EXECUTE + checkpoint milestone 2 (worktree ends CLEAN) ──
  writeFileSync(join(dir, "work", "b.txt"), "milestone two\n");
  const ck2 = run("gov-commit-checkpoint.mjs", [...ckArgs("m2", "2"), "--message", "checkpoint: e2e m2", "--apply"], dir);
  assert.equal(ck2.status, 0, ck2.stderr);
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(status, "", "worktree must be clean before bundling");

  // ── BUNDLE (REAL minimal verification — no skip path exists) ──
  const verifyConfig = writeVerifyFixture(dir);
  const metaPath = join(outDir, "meta.json");
  writeFileSync(metaPath, JSON.stringify({ goal: "e2e unit", completed: "m1+m2", openQuestions: [] }));
  const bundle = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", authorityPath,
    "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir,
    "--verify-config", verifyConfig, "--milestones", "m1,m2", "--meta", metaPath,
  ], dir);
  assert.equal(bundle.status, 0, bundle.stderr);
  assert.ok(existsSync(bundlePath), "bundle file written");
  const jsonText = bundle.stdout.slice(bundle.stdout.indexOf("{"), bundle.stdout.lastIndexOf("}") + 1);
  const bundleJson = JSON.parse(jsonText);
  assert.equal(bundleJson.bundle_sha256.length, 64);
  assert.equal(bundleJson.review_round, 1);

  // ── PENDING blocks push (no result artifact → EXTERNAL_REVIEW_RESULT_MISSING) ──
  const pushPending = run("gov-push-gate.mjs", ["--authority-file", authorityPath, "--cwd", dir], dir);
  assert.notEqual(pushPending.status, 0);
  assert.match(pushPending.stderr, /EXTERNAL_REVIEW_RESULT_MISSING/);
  const remoteBranches = execFileSync("git", ["--git-dir", bareDir, "branch", "--list"], { encoding: "utf8" }).trim();
  assert.equal(remoteBranches, "", "nothing pushed before PASS");

  // ── CONTROLLER INGESTION entry creates the digest-bound PASS result ──
  const findingsFile = join(outDir, "findings.txt");
  writeFileSync(findingsFile, "e2e round-1 verdict PASS; no findings.");
  const ingest = run("gov-controller-ingest-result.mjs", [
    "--bundle-dir", outDir, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--verdict", "PASS", "--reviewer-identity", "external-reviewer-1",
    "--authorization-source", "controller-session:e2e-final", "--findings-file", findingsFile,
  ], dir);
  assert.equal(ingest.status, 0, ingest.stderr);
  // exclusive-create refuses a second ingestion
  const ingest2 = run("gov-controller-ingest-result.mjs", [
    "--bundle-dir", outDir, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--verdict", "PASS", "--reviewer-identity", "external-reviewer-2",
    "--authorization-source", "controller-session:e2e-final", "--findings-file", findingsFile,
  ], dir);
  assert.notEqual(ingest2.status, 0);
  assert.match(ingest2.stderr, /EXTERNAL_REVIEW_RESULT_NOT_CONTROLLER_OWNED|already exists/i);

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
  const resultPath = join(outDir, "governance", "external-review-result.json");
  const tampered = JSON.parse(readFileSync(resultPath, "utf8"));
  tampered.bundle_sha256 = "0".repeat(64);
  writeFileSync(resultPath, JSON.stringify(tampered, null, 2));
  const blocked = run("gov-commit-integration.mjs", [
    "--authority-file", authorityPath, "--cwd", dir,
    "--verification-passed", "true", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
  ], dir);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /EVIDENCE_IDENTITY_MISMATCH/);
  const pushBlocked = run("gov-push-gate.mjs", ["--authority-file", authorityPath, "--cwd", dir], dir);
  assert.notEqual(pushBlocked.status, 0);

  const mainHead = execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(mainHead, execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim());
  const remoteBranches2 = execFileSync("git", ["--git-dir", bareDir, "branch", "--list"], { encoding: "utf8" }).trim();
  assert.equal(remoteBranches2, "");
});

test("[neg 1] AUTOLOOP_TEST_FIXTURE cannot make production skip tests (flag removed)", (t) => {
  const { dir } = createTempRepo(t);
  const res = run("gov-review-bundle.mjs", ["--cwd", dir, "--skip-fresh-verify", "--card-id", CARD_ID], dir);
  assert.notEqual(res.status, 0);
  // the flag no longer exists — no message about it being accepted
  assert.ok(!res.stdout.includes("NOT RUN"));
});

test("[neg 2] any fresh test FAIL/NOT-RUN → no bundle produced", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), "authority.json\nmeta.json\nout/\ngovernance/\nremote/\nverify.mjs\nverify-config.json\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  writeFileSync(join(dir, "work", "a.txt"), "a\n");
  const applied = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir, "--verification-passed", "true",
    "--artifact-identity", "x", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", "m1", "--milestones", "1",
    "--message", "ck", "--apply",
  ], dir);
  assert.equal(applied.status, 0, applied.stderr);
  // a verify config whose command FAILS
  const badConfig = join(outDir, "bad-verify-config.json");
  writeFileSync(badConfig, JSON.stringify({ commands: [["node missing-script.mjs", "must fail"]] }));
  writeFileSync(join(outDir, "meta.json"), JSON.stringify({ goal: "x" }));
  const res = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--verify-config", badConfig, "--meta", join(outDir, "meta.json"),
  ], dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /FRESH_VERIFY_FAILED/);
  assert.equal(existsSync(bundlePath), false, "no bundle when verification fails");
});

test("[neg 3] normal git repo but cwd != authorized worktree → rejected", (t) => {
  const { dir } = createTempRepo(t);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  // record claims a different worktree
  const wrong = JSON.parse(readFileSync(authorityPath, "utf8"));
  wrong.worktree = join(dir, "elsewhere");
  const wrongPath = join(dir, "authority-wrong-worktree.json");
  writeFileSync(wrongPath, JSON.stringify(wrong, null, 2));
  const res = run("gov-commit-checkpoint.mjs", ["--authority-file", wrongPath, "--cwd", dir, "--card-id", CARD_ID], dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /LIVE_BINDING_MISMATCH/);
});

test("[neg 4] branch/base/base_head/card/run mismatch → rejected", (t) => {
  const { dir } = createTempRepo(t);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  // branch mismatch
  const wrongBranch = JSON.parse(readFileSync(authorityPath, "utf8"));
  wrongBranch.branch = "main";
  const wb = join(dir, "authority-branch.json");
  writeFileSync(wb, JSON.stringify(wrongBranch, null, 2));
  assert.match(run("gov-commit-checkpoint.mjs", ["--authority-file", wb, "--cwd", dir, "--card-id", CARD_ID], dir).stderr, /LIVE_BINDING_MISMATCH/);
  // base_head mismatch
  const wrongHead = JSON.parse(readFileSync(authorityPath, "utf8"));
  wrongHead.base_head = "0".repeat(40);
  const wh = join(dir, "authority-head.json");
  writeFileSync(wh, JSON.stringify(wrongHead, null, 2));
  assert.match(run("gov-commit-checkpoint.mjs", ["--authority-file", wh, "--cwd", dir, "--card-id", CARD_ID], dir).stderr, /LIVE_BINDING_MISMATCH/);
  // card_id flag mismatch
  const res = run("gov-commit-checkpoint.mjs", ["--authority-file", authorityPath, "--cwd", dir, "--card-id", "OTHER-CARD"], dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /LIVE_BINDING_MISMATCH/);
});

test("[neg 5] committed out-of-scope path blocks bundle AND push", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), "authority.json\nmeta.json\nout/\ngovernance/\nremote/\nverify.mjs\nverify-config.json\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  writeFileSync(join(dir, "work", "a.txt"), "a\n");
  writeFileSync(join(dir, "stray-outside-scope.txt"), "x\n"); // NOT in authorized_paths
  git(["add", "stray-outside-scope.txt"]);
  git(["commit", "-m", "stray"]);
  const bareDir = join(dir, "remote", "xonogesrs", "autoloop.git");
  mkdirSync(bareDir, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q"], { cwd: bareDir });
  git(["remote", "add", "origin", bareDir]);
  const verifyConfig = join(outDir, "verify-config.json");
  writeFileSync(verifyConfig, JSON.stringify({ commands: [["node -e \"process.exit(0)\"", "minimal"]] }));
  writeFileSync(join(outDir, "meta.json"), JSON.stringify({ goal: "x" }));
  const bundle = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--verify-config", verifyConfig, "--meta", join(outDir, "meta.json"),
  ], dir);
  assert.notEqual(bundle.status, 0);
  assert.match(bundle.stderr, /GOVERNANCE_SCOPE_EXPANSION_REQUIRED/);
  assert.equal(existsSync(bundlePath), false, "no bundle when a path is out of scope");
  const push = run("gov-push-gate.mjs", ["--authority-file", authorityPath, "--cwd", dir], dir);
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /GOVERNANCE_SCOPE_EXPANSION_REQUIRED/);
});

test("[neg 6] round 3 must not reset to repair round 1 (history-derived)", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), "authority.json\nmeta.json\nout/\ngovernance/\nremote/\nverify.mjs\nverify-config.json\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  writeFileSync(join(dir, "work", "a.txt"), "a\n");
  const ck = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir, "--verification-passed", "true",
    "--artifact-identity", "x", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", "m1", "--milestones", "1",
    "--message", "ck", "--apply",
  ], dir);
  assert.equal(ck.status, 0, ck.stderr);
  // a prior (round-2) bundle must exist in the archive for the prior binding
  mkdirSync(join(outDir, "archive"), { recursive: true });
  const priorText = "PRIOR BUNDLE R2\nBUNDLE_SHA256 (sha256 of all content above): deadbeef\n";
  const priorPath = join(outDir, "archive", "20260804T000000Z-" + CARD_ID + "-run-1.txt");
  writeFileSync(priorPath, priorText);
  const findingsFile = join(outDir, "findings-r2.txt");
  writeFileSync(findingsFile, "round 2 findings text");
  const prepare = run("gov-controller-prepare-round.mjs", [
    "--bundle-dir", outDir, "--card-id", CARD_ID, "--findings-file", findingsFile,
    "--review-round", "3", "--repair-round", "2", "--max-repair-rounds", "2",
  ], dir);
  assert.equal(prepare.status, 0, prepare.stderr);
  // bundle generation now derives round 3 / repair 2 — attempting to reset via
  // meta.repairRounds=1 must be REJECTED
  const verifyConfig = join(outDir, "verify-config.json");
  writeFileSync(verifyConfig, JSON.stringify({ commands: [["node -e \"process.exit(0)\"", "minimal"]] }));
  const resetMeta = join(outDir, "meta-reset.json");
  writeFileSync(resetMeta, JSON.stringify({ goal: "x", repairRounds: 1 }));
  const res = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--verify-config", verifyConfig, "--meta", resetMeta,
  ], dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /REVIEW_HISTORY_INVALID/);
  // without the reset attempt, the generator derives round 3 / repair 2 from history
  const okMeta = join(outDir, "meta-ok.json");
  writeFileSync(okMeta, JSON.stringify({ goal: "x" }));
  const ok = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--verify-config", verifyConfig, "--meta", okMeta,
  ], dir);
  assert.equal(ok.status, 0, ok.stderr);
  const okJson = JSON.parse(ok.stdout.slice(ok.stdout.indexOf("{"), ok.stdout.lastIndexOf("}") + 1));
  assert.equal(okJson.review_round, 3);
  assert.equal(okJson.repair_round, 2);
  assert.equal(okJson.remaining_repair_budget, 0);
});

test("[neg 7] prior bundle/findings mismatch blocks the CLI", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), "authority.json\nmeta.json\nout/\ngovernance/\nremote/\nverify.mjs\nverify-config.json\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  writeFileSync(join(dir, "work", "a.txt"), "a\n");
  const ck = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir, "--verification-passed", "true",
    "--artifact-identity", "x", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", "m1", "--milestones", "1",
    "--message", "ck", "--apply",
  ], dir);
  assert.equal(ck.status, 0, ck.stderr);
  // stale history claiming a prior bundle that is NOT in the archive
  mkdirSync(join(outDir, "governance"), { recursive: true });
  const staleHistory = {
    schema: "autoloop.review-history/v1",
    card_id: CARD_ID,
    review_round: 3,
    repair_round: 2,
    prior_bundle_sha256: "f".repeat(64),
    prior_findings_digest: "e".repeat(64),
    prior_findings_text: "stale findings",
    remaining_budget: 0,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "governance", "review-history.json"), JSON.stringify(staleHistory, null, 2));
  const verifyConfig = join(outDir, "verify-config.json");
  writeFileSync(verifyConfig, JSON.stringify({ commands: [["node -e \"process.exit(0)\"", "minimal"]] }));
  writeFileSync(join(outDir, "meta.json"), JSON.stringify({ goal: "x" }));
  const res = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--verify-config", verifyConfig, "--meta", join(outDir, "meta.json"),
  ], dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /REVIEW_HISTORY_INVALID|REVIEW_HISTORY_MISSING/);
});

test("[neg 8] a declared stop condition prevents bundle production", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), "authority.json\nmeta.json\nout/\ngovernance/\nremote/\nverify.mjs\nverify-config.json\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  writeFileSync(join(dir, "work", "a.txt"), "a\n");
  const ck = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir, "--verification-passed", "true",
    "--artifact-identity", "x", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", "m1", "--milestones", "1",
    "--message", "ck", "--apply",
  ], dir);
  assert.equal(ck.status, 0, ck.stderr);
  const verifyConfig = join(outDir, "verify-config.json");
  writeFileSync(verifyConfig, JSON.stringify({ commands: [["node -e \"process.exit(0)\"", "minimal"]] }));
  const metaStop = join(outDir, "meta-stop.json");
  writeFileSync(metaStop, JSON.stringify({ goal: "x", stopConditions: ["SECOND_WORKTREE_REQUIRED"] }));
  const res = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--verify-config", verifyConfig, "--meta", metaStop,
  ], dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /REVIEW_UNIT_LIMIT_EXCEEDED/);
  assert.equal(existsSync(bundlePath), false);
});

test("[neg 9] executor cannot create a PASS result via the production API", async () => {
  const mod = await import("../../src/governance/external-review.mjs");
  assert.equal("writeExternalReviewResult" in mod, false, "PASS writer must not be exported");
  // no executor script writes the result artifact path
  for (const script of ["gov-commit-checkpoint.mjs", "gov-commit-integration.mjs", "gov-push-gate.mjs", "gov-draft-pr.mjs", "gov-review-bundle.mjs"]) {
    const src = readFileSync(join(REPO, "scripts", script), "utf8");
    assert.equal(src.includes("external-review-result.json") && src.includes("writeFileSync"), false, `${script} must not write the result artifact`);
  }
});

test("[neg 10] remote URL with only a substring match is rejected", () => {
  const target = "xonogesrs/autoloop";
  assert.equal(remoteUrlMatchesAuthorizedRepository("https://evil.example/xonogesrs/autoloop.git", target), false);
  assert.equal(remoteUrlMatchesAuthorizedRepository("/tmp/xonogesrs/autoloop-backup.git", target), false);
  assert.equal(remoteUrlMatchesAuthorizedRepository("git@evil.example:xonogesrs/autoloop.git", target), false);
  assert.equal(remoteUrlMatchesAuthorizedRepository("https://github.com/xonogesrs/autoloop-evil.git", target), false);
  assert.equal(remoteUrlMatchesAuthorizedRepository("git@github.com:xonogesrs/autoloop.git", target), true);
  assert.equal(remoteUrlMatchesAuthorizedRepository("https://github.com/xonogesrs/autoloop.git", target), true);
  assert.equal(remoteUrlMatchesAuthorizedRepository("/var/tmp/xonogesrs/autoloop.git", target), true);
});

test("[neg 11] custom PR body missing card/result binding is rejected", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), "authority.json\nmeta.json\nout/\ngovernance/\nremote/\nverify.mjs\nverify-config.json\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  writeFileSync(join(dir, "work", "a.txt"), "a\n");
  const ck = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir, "--verification-passed", "true",
    "--artifact-identity", "x", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", "m1", "--milestones", "1",
    "--message", "ck", "--apply",
  ], dir);
  assert.equal(ck.status, 0, ck.stderr);
  // bundle so the controller can ingest a PASS result
  const verifyConfig = join(outDir, "verify-config.json");
  writeFileSync(verifyConfig, JSON.stringify({ commands: [["node -e \"process.exit(0)\"", "minimal"]] }));
  writeFileSync(join(outDir, "meta.json"), JSON.stringify({ goal: "x" }));
  const bundle = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--verify-config", verifyConfig, "--meta", join(outDir, "meta.json"),
  ], dir);
  assert.equal(bundle.status, 0, bundle.stderr);
  const findingsFile = join(outDir, "findings.txt");
  writeFileSync(findingsFile, "pass");
  const ingest = run("gov-controller-ingest-result.mjs", [
    "--bundle-dir", outDir, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--verdict", "PASS", "--reviewer-identity", "external-reviewer-1",
    "--authorization-source", "controller-session:e2e", "--findings-file", findingsFile,
  ], dir);
  assert.equal(ingest.status, 0, ingest.stderr);
  // a custom body without card/result binding must be rejected for CREATE
  const unboundBody = join(outDir, "unbound-body.md");
  writeFileSync(unboundBody, "## unrelated content\nno card binding here\n");
  const draft = run("gov-draft-pr.mjs", [
    "--authority-file", authorityPath, "--cwd", dir,
    "--body-file", unboundBody, "--head", "governance/test-unit",
  ], dir);
  assert.notEqual(draft.status, 0);
  assert.match(draft.stderr, /PR_NOT_BOUND_TO_PARENT_CARD/);
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
});

test("e2e: bundle path mismatch → HOLD / BUNDLE_PATH_MISMATCH", (t) => {
  const { dir } = createTempRepo(t);
  const outDir = join(dir, "out");
  mkdirSync(outDir, { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, join(outDir, "READY_FOR_REVIEW.txt"));
  const wrong = JSON.parse(readFileSync(authorityPath, "utf8"));
  wrong.bundle_path = join(dir, "elsewhere", "READY_FOR_REVIEW.txt");
  wrong.lifecycle_authorization.external_review.bundle_path = wrong.bundle_path;
  const wrongPath = join(dir, "authority-wrong.json");
  writeFileSync(wrongPath, JSON.stringify(wrong, null, 2));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ goal: "x" }));
  const res = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", wrongPath,
    "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--verify-config", join(dir, "verify-config.json"),
    "--meta", join(dir, "meta.json"),
  ], dir);
  // bundle-path check fires before the (missing) verify config matters
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /BUNDLE_PATH_MISMATCH/);
});
