// test/governance/test-review-unit-e2e.mjs
// End-to-end (round 3 findings 1–6 + round 4 findings 1–2):
//
//   execute → checkpoint → bundle (REAL minimal verification injected via the
//   library API — NO --verify-config CLI flag, NO skip path)
//   → PENDING push blocked → Controller ingestion entry creates the PASS
//   result (exclusive-create, digest computed from the bundle) → integration
//   attestation (no new commit) → push dry-run PASSES → artifact modified →
//   blocked again.
//
// Plus the required negative tests. Round 4: the production CLI rejects
// --verify-config (fixed governance command set) and the production remote
// policy accepts ONLY the three canonical GitHub forms (local bare remotes
// are test-only adapter injection).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTempRepo, testRemoteMatch, CARD_ID, RUN_ID } from "./helpers.mjs";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";
import { remoteUrlMatchesAuthorizedRepository, productionRemoteMatch } from "../../scripts/shared/gov-args.mjs";
import { generateReviewBundle } from "../../scripts/gov-review-bundle.mjs";
import { runPushGate } from "../../scripts/gov-push-gate.mjs";

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

// In-process bundle generation with INTERNAL dependency injection: the
// verification command set is passed as a function argument (never a CLI
// flag). Hold failures are thrown and surfaced as `stderr` for uniform
// assertions (same shape as the subprocess `run` helper).
function genBundle(argv, verifyCommands) {
  try {
    const report = generateReviewBundle({ argv, verifyCommands });
    return { status: 0, report, stderr: "" };
  } catch (e) {
    return { status: 1, report: null, stderr: `${e.code ?? ""}\n${e.message}` };
  }
}

// In-process push gate with the TEST-ONLY remote adapter injected (local
// bare remotes are never part of the production remote policy).
function pushGate(argv, dir) {
  try {
    const report = runPushGate({ argv, cwd: dir, remotePolicy: testRemoteMatch });
    return { status: 0, report, stderr: "" };
  } catch (e) {
    return { status: 1, report: null, stderr: `${e.code ?? ""}\n${e.message}` };
  }
}

const GITIGNORE = "authority.json\nmeta.json\nout/\ngovernance/\nremote/\nverify.mjs\n";

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

// Minimal but REAL verification command set, injected through the library
// API. The fixture actually checks the committed work files exist.
function verifyFixtureCommands(dir) {
  const p = join(dir, "verify.mjs");
  writeFileSync(p, "import { existsSync } from 'node:fs';\nif (!existsSync('work/a.txt') || !existsSync('work/b.txt')) { console.error('missing work files'); process.exit(1); }\nconsole.log('fixture verification ok');\n");
  return [["node verify.mjs", "fixture verification"]];
}

test("e2e: checkpoint → clean bundle → PENDING push blocked → controller PASS → attestation → push dry-run passes → tamper blocks", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore harness"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);

  // bare remote whose URL resolves to the authorized repository — allowed
  // only via the TEST-ONLY adapter (production policy is GitHub-only)
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

  // ── BUNDLE (REAL minimal verification injected via DI — no CLI flag) ──
  const verifyCommands = verifyFixtureCommands(dir);
  const metaPath = join(outDir, "meta.json");
  writeFileSync(metaPath, JSON.stringify({ goal: "e2e unit", completed: "m1+m2", openQuestions: [] }));
  const bundle = genBundle([
    "--cwd", dir, "--authority-file", authorityPath,
    "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir,
    "--milestones", "m1,m2", "--meta", metaPath,
  ], verifyCommands);
  assert.equal(bundle.status, 0, bundle.stderr);
  assert.ok(existsSync(bundlePath), "bundle file written");
  assert.equal(bundle.report.bundle_sha256.length, 64);
  assert.equal(bundle.report.review_round, 1);

  // ── PENDING blocks push (no result artifact → EXTERNAL_REVIEW_RESULT_MISSING) ──
  const pushPending = pushGate(["--authority-file", authorityPath], dir);
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
  const pushPass = pushGate(["--authority-file", authorityPath], dir);
  assert.equal(pushPass.status, 0, pushPass.stderr);
  assert.equal(pushPass.report.allowed, true);

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
  const pushBlocked = pushGate(["--authority-file", authorityPath], dir);
  assert.notEqual(pushBlocked.status, 0);

  const mainHead = execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(mainHead, execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim());
  const remoteBranches2 = execFileSync("git", ["--git-dir", bareDir, "branch", "--list"], { encoding: "utf8" }).trim();
  assert.equal(remoteBranches2, "");
});

test("[neg 1] production has no skip-fresh-verify and no --verify-config flag (round 4 finding 1)", (t) => {
  const { dir } = createTempRepo(t);
  const res = run("gov-review-bundle.mjs", ["--cwd", dir, "--skip-fresh-verify", "--card-id", CARD_ID], dir);
  assert.notEqual(res.status, 0);
  // the flag no longer exists — no message about it being accepted
  assert.ok(!res.stdout.includes("NOT RUN"));
  // an unknown flag cannot make the CLI succeed either
  const res2 = run("gov-review-bundle.mjs", ["--cwd", dir, "--verify-config", "/nonexistent.json", "--card-id", CARD_ID], dir);
  assert.notEqual(res2.status, 0);
});

test("[neg 12] --verify-config cannot replace the fixed production verification (round 4 finding 1)", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
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
  // the reviewer's exact attack: a config whose only command exits 0
  const noopConfig = join(outDir, "noop-verify-config.json");
  writeFileSync(noopConfig, JSON.stringify({ commands: [["node -e \"process.exit(0)\"", "noop"]] }));
  writeFileSync(join(outDir, "meta.json"), JSON.stringify({ goal: "x" }));
  const res = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--verify-config", noopConfig, "--meta", join(outDir, "meta.json"),
  ], dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /FRESH_VERIFY_FAILED/);
  assert.equal(existsSync(bundlePath), false, "no bundle produced: the production CLI always runs the governance-defined command set");
});

test("[neg 2] any fresh test FAIL/NOT-RUN → no bundle produced", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
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
  writeFileSync(join(outDir, "meta.json"), JSON.stringify({ goal: "x" }));
  // an injected command set whose command FAILS
  const res = genBundle([
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--meta", join(outDir, "meta.json"),
  ], [["node missing-script.mjs", "must fail"]]);
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
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
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
  writeFileSync(join(outDir, "meta.json"), JSON.stringify({ goal: "x" }));
  const bundle = genBundle([
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--meta", join(outDir, "meta.json"),
  ], [["node -e \"1+1\"", "minimal — never executed (scope blocks first)"]]);
  assert.notEqual(bundle.status, 0);
  assert.match(bundle.stderr, /GOVERNANCE_SCOPE_EXPANSION_REQUIRED/);
  assert.equal(existsSync(bundlePath), false, "no bundle when a path is out of scope");
  const push = pushGate(["--authority-file", authorityPath], dir);
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /GOVERNANCE_SCOPE_EXPANSION_REQUIRED/);
});

test("[neg 6] round 3 must not reset to repair round 1 (history-derived)", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  writeFileSync(join(dir, "work", "a.txt"), "a\n");
  writeFileSync(join(dir, "work", "b.txt"), "b\n");
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
    "--review-round", "3", "--repair-round", "2", "--authority-file", authorityPath,
  ], dir);
  assert.equal(prepare.status, 0, prepare.stderr);
  // bundle generation now derives round 3 / repair 2 — attempting to reset via
  // meta.repairRounds=1 must be REJECTED
  const resetMeta = join(outDir, "meta-reset.json");
  writeFileSync(resetMeta, JSON.stringify({ goal: "x", repairRounds: 1 }));
  const res = genBundle([
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--meta", resetMeta,
  ], verifyFixtureCommands(dir));
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /REVIEW_HISTORY_INVALID/);
  // without the reset attempt, the generator derives round 3 / repair 2 from history
  const okMeta = join(outDir, "meta-ok.json");
  writeFileSync(okMeta, JSON.stringify({ goal: "x" }));
  const ok = genBundle([
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--meta", okMeta,
  ], verifyFixtureCommands(dir));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.report.review_round, 3);
  assert.equal(ok.report.repair_round, 2);
  assert.equal(ok.report.remaining_repair_budget, 0);
});

test("[neg 7] prior bundle/findings mismatch blocks the CLI", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
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
  writeFileSync(join(outDir, "meta.json"), JSON.stringify({ goal: "x" }));
  const res = genBundle([
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--meta", join(outDir, "meta.json"),
  ], verifyFixtureCommands(dir));
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /REVIEW_HISTORY_INVALID|REVIEW_HISTORY_MISSING/);
});

test("[neg 8] a declared stop condition prevents bundle production", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
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
  const metaStop = join(outDir, "meta-stop.json");
  writeFileSync(metaStop, JSON.stringify({ goal: "x", stopConditions: ["SECOND_WORKTREE_REQUIRED"] }));
  const res = genBundle([
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--meta", metaStop,
  ], verifyFixtureCommands(dir));
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

test("[neg 10] remote URL: only canonical GitHub forms pass the production policy (round 4 finding 2)", () => {
  const target = "xonogesrs/autoloop";
  // allowed hosts / exact owner+repo only
  assert.equal(remoteUrlMatchesAuthorizedRepository("https://evil.example/xonogesrs/autoloop.git", target), false);
  assert.equal(remoteUrlMatchesAuthorizedRepository("git@evil.example:xonogesrs/autoloop.git", target), false);
  assert.equal(remoteUrlMatchesAuthorizedRepository("ssh://git@evil.example/xonogesrs/autoloop.git", target), false);
  assert.equal(remoteUrlMatchesAuthorizedRepository("https://github.com/xonogesrs/autoloop-evil.git", target), false);
  assert.equal(remoteUrlMatchesAuthorizedRepository("https://github.com/xonogesrs/autoloop.git", target), true);
  assert.equal(remoteUrlMatchesAuthorizedRepository("git@github.com:xonogesrs/autoloop.git", target), true);
  assert.equal(remoteUrlMatchesAuthorizedRepository("ssh://git@github.com/xonogesrs/autoloop.git", target), true);
  // round 4 finding 2: a LOCAL path must NOT pass even with matching trailing
  // owner/repo segments (a bare mirror on disk never impersonates GitHub)
  assert.equal(remoteUrlMatchesAuthorizedRepository("/var/tmp/xonogesrs/autoloop.git", target), false);
  assert.equal(remoteUrlMatchesAuthorizedRepository("/tmp/xonogesrs/autoloop-backup.git", target), false);
  assert.equal(remoteUrlMatchesAuthorizedRepository("file:///var/tmp/xonogesrs/autoloop.git", target), false);
  // the production policy is the default; the test-only adapter must be
  // injected EXPLICITLY and is never the production default
  assert.equal(remoteUrlMatchesAuthorizedRepository("/var/tmp/xonogesrs/autoloop.git", target, testRemoteMatch), true);
  assert.equal(productionRemoteMatch("git@github.com:xonogesrs/autoloop.git", target), true);
  assert.equal(productionRemoteMatch("/var/tmp/xonogesrs/autoloop.git", target), false);
});

test("[neg 13] repair caps must intersect: bounded 2 / review_unit 3 / repair 3 → HOLD (round 5 finding)", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  // self-contradictory card: bounded_repair.max_rounds=2 but
  // review_unit.maximum_repair_rounds=3 (the round-4 exception shape) — the
  // effective cap is min(2,3)=2, so repair 3 is OUT of effective authority
  const conflicted = JSON.parse(readFileSync(authorityPath, "utf8"));
  conflicted.lifecycle_authorization.review_unit.maximum_repair_rounds = 3;
  const conflictedPath = join(outDir, "authority-conflicted.json");
  writeFileSync(conflictedPath, JSON.stringify(conflicted, null, 2));
  writeFileSync(join(dir, "work", "a.txt"), "a\n");

  // checkpoint under the conflicted record is blocked by the gate
  const ck = run("gov-commit-checkpoint.mjs", [
    "--authority-file", conflictedPath, "--cwd", dir, "--verification-passed", "true",
    "--artifact-identity", "x", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", "m1", "--milestones", "1",
    "--repair-rounds", "3", "--message", "ck", "--apply",
  ], dir);
  assert.notEqual(ck.status, 0);
  assert.match(ck.stderr, /REVIEW_UNIT_LIMIT_EXCEEDED|repair_cap_authority_conflict/);

  // prepare-round must refuse to write history at repair 3 under this record
  mkdirSync(join(outDir, "archive"), { recursive: true });
  writeFileSync(join(outDir, "archive", "20260804T000000Z-" + CARD_ID + "-run-1.txt"), "PRIOR BUNDLE R4\nBUNDLE_SHA256 (sha256 of all content above): deadbeef\n");
  const findingsFile = join(outDir, "findings.txt");
  writeFileSync(findingsFile, "round 4 findings");
  const prepare = run("gov-controller-prepare-round.mjs", [
    "--bundle-dir", outDir, "--card-id", CARD_ID, "--findings-file", findingsFile,
    "--review-round", "4", "--repair-round", "3", "--authority-file", conflictedPath,
  ], dir);
  assert.notEqual(prepare.status, 0);
  assert.match(prepare.stderr, /REVIEW_HISTORY_INVALID|repair_cap_authority_conflict/);

  // a stale history claiming repair 3 under a cap-2 record must block the bundle
  mkdirSync(join(outDir, "governance"), { recursive: true });
  const priorText = "stale";
  const stale = {
    schema: "autoloop.review-history/v1",
    card_id: CARD_ID,
    review_round: 4,
    repair_round: 3,
    prior_bundle_sha256: "deadbeef".repeat(8),
    prior_findings_digest: createHash("sha256").update(priorText).digest("hex"),
    prior_findings_text: priorText,
    effective_repair_cap: 2,
    remaining_budget: 0,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "governance", "review-history.json"), JSON.stringify(stale, null, 2));
  writeFileSync(join(outDir, "meta.json"), JSON.stringify({ goal: "x" }));
  const bundle = genBundle([
    "--cwd", dir, "--authority-file", conflictedPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--meta", join(outDir, "meta.json"),
  ], verifyFixtureCommands(dir));
  assert.notEqual(bundle.status, 0);
  assert.match(bundle.stderr, /REVIEW_UNIT_LIMIT_EXCEEDED|REVIEW_HISTORY_INVALID/);
  assert.equal(existsSync(bundlePath), false, "no bundle when repair exceeds the effective cap");
});

test("[neg 11] custom PR body missing card/result binding is rejected", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  writeFileSync(join(dir, "work", "a.txt"), "a\n");
  writeFileSync(join(dir, "work", "b.txt"), "b\n");
  const ck = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir, "--verification-passed", "true",
    "--artifact-identity", "x", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", "m1", "--milestones", "1",
    "--message", "ck", "--apply",
  ], dir);
  assert.equal(ck.status, 0, ck.stderr);
  // bundle so the controller can ingest a PASS result
  writeFileSync(join(outDir, "meta.json"), JSON.stringify({ goal: "x" }));
  const bundle = genBundle([
    "--cwd", dir, "--authority-file", authorityPath, "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir, "--meta", join(outDir, "meta.json"),
  ], verifyFixtureCommands(dir));
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
  const callerIdentity = pushGate([
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
    "--base-branch", "main", "--out-dir", outDir,
    "--meta", join(dir, "meta.json"),
  ], dir);
  // bundle-path check fires before verification matters
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /BUNDLE_PATH_MISMATCH/);
});
