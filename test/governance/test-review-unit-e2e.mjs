// test/governance/test-review-unit-e2e.mjs
// End-to-end (§14): isolated temp repo running the real CLI scripts:
//
//   execute → internal checkpoint → bundle → PENDING blocks push
//   → simulated digest-bound PASS result → integration gate PASS
//   → artifact modified → blocked again
//
// The full round never pushes, never touches a remote, never merges/seals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempRepo, CARD_ID, RUN_ID } from "./helpers.mjs";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";
import { bundleDigestFromFile } from "../../src/governance/review-context.mjs";

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

test("e2e: execute → checkpoint → bundle → PENDING push blocked → digest-bound PASS → integration → tamper blocks", (t) => {
  const { dir, git } = createTempRepo(t);
  // harness artifacts live inside the repo but are gitignored (not part of the unit)
  writeFileSync(join(dir, ".gitignore"), "authority.json\nauthority-wrong.json\nmeta.json\nout/\ngovernance/\n");
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore harness"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);

  // 1. EXECUTE milestone 1
  writeFileSync(join(dir, "work", "a.txt"), "milestone one\n");
  // 2. INTERNAL CHECKPOINT (dry-run then apply)
  const checkpointArgs = [
    "--authority-file", authorityPath,
    "--cwd", dir,
    "--expected-paths", "work/",
    "--verification-passed", "true",
    "--artifact-identity", "sha256:unit",
    "--evidence-digest", "e".repeat(64),
    "--repair-converged", "true",
    "--card-id", CARD_ID,
    "--run-id", RUN_ID,
    "--milestone-id", "m1",
    "--milestones", "1",
    "--message", "checkpoint: e2e m1",
  ];
  const dry = run("gov-commit-checkpoint.mjs", [...checkpointArgs], dir);
  assert.equal(dry.status, 0, dry.stderr);
  const applied = run("gov-commit-checkpoint.mjs", [...checkpointArgs, "--apply"], dir);
  assert.equal(applied.status, 0, applied.stderr);
  const log = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: dir, encoding: "utf8" });
  assert.match(log, /AutoLoop-Card: /);
  assert.match(log, /AutoLoop-Milestone: m1/);

  // 3. EXECUTE milestone 2 (dirty, uncommitted)
  writeFileSync(join(dir, "work", "b.txt"), "milestone two\n");

  // 4. BUNDLE (fresh verify skipped; identities computed from content)
  const metaPath = join(dir, "meta.json");
  writeFileSync(metaPath, JSON.stringify({ goal: "e2e unit", completed: "m1+m2", repairRounds: 0, openQuestions: [] }));
  const bundle = run("gov-review-bundle.mjs", [
    "--cwd", dir,
    "--authority-file", authorityPath,
    "--card-id", CARD_ID,
    "--run-id", RUN_ID,
    "--review-round", "1",
    "--base-branch", "main",
    "--out-dir", outDir,
    "--skip-fresh-verify",
    "--milestones", "m1,m2",
    "--meta", metaPath,
  ], dir);
  assert.equal(bundle.status, 0, bundle.stderr);
  assert.ok(existsSync(bundlePath), "bundle file written");
  const jsonText = bundle.stdout.slice(bundle.stdout.indexOf("{"), bundle.stdout.lastIndexOf("}") + 1);
  const bundleJson = JSON.parse(jsonText);
  assert.equal(bundleJson.bundle_sha256.length, 64);
  assert.equal(bundleJson.patch_sha256.length, 64);
  assert.equal(bundleJson.changed_tree_identity.length, 64);

  // 5. PENDING blocks push (no result artifact → EXTERNAL_REVIEW_RESULT_MISSING)
  const pushPending = run("gov-push-gate.mjs", ["--authority-file", authorityPath, "--cwd", dir], dir);
  assert.notEqual(pushPending.status, 0);
  assert.match(pushPending.stderr, /EXTERNAL_REVIEW_RESULT_MISSING/);
  // checkpoint commits exist locally; no remote exists (nothing to drift)
  const remoteCount = execFileSync("git", ["remote"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(remoteCount, "");

  // 6. SIMULATED digest-bound PASS result (harness-owned, computed not trust-input)
  const inv = inventoryOf(dir);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const baseHead = execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim();
  const bundleDigest = bundleDigestFromFile(readFileSync(bundlePath, "utf8"));
  const result = {
    schema: "autoloop.external-review-result/v1",
    card_id: CARD_ID,
    run_id: RUN_ID,
    verdict: "PASS",
    bundle_sha256: bundleDigest,
    patch_sha256: inv.patchSha256,
    changed_tree_identity: inv.changedTreeIdentity,
    reviewer_identity: "external-reviewer-1",
    reviewed_at: new Date().toISOString(),
    review_round: 1,
    findings_digest: "f".repeat(64),
    current_head: head,
    base_head: baseHead,
    repository: "xonogesrs/autoloop",
    branch: "governance/test-unit",
    base_branch: "main",
    bundle_path: bundlePath,
  };
  const resultDir = join(dir, "governance");
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(join(resultDir, "external-review-result.json"), JSON.stringify(result, null, 2));

  // 7. INTEGRATION gate PASS (commits remaining dirty milestone-2 content)
  const integrationArgs = [
    "--authority-file", authorityPath,
    "--cwd", dir,
    "--verification-passed", "true",
    "--evidence-digest", "e".repeat(64),
    "--repair-converged", "true",
    "--message", "integration: e2e unit (external PASS)",
  ];
  const integrationDry = run("gov-commit-integration.mjs", integrationArgs, dir);
  assert.equal(integrationDry.status, 0, integrationDry.stderr);
  const integration = run("gov-commit-integration.mjs", [...integrationArgs, "--apply"], dir);
  assert.equal(integration.status, 0, integration.stderr);
  const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  assert.notEqual(headAfter, head, "integration commit created");
  const log2 = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: dir, encoding: "utf8" });
  assert.match(log2, /Review-Result: [0-9a-f]{64}/);
  assert.match(log2, /AutoLoop-Card: /);

  // 8. ARTIFACT MODIFIED → blocked again (digest mismatch / head drift)
  const tampered = JSON.parse(readFileSync(join(resultDir, "external-review-result.json"), "utf8"));
  tampered.bundle_sha256 = "0".repeat(64);
  writeFileSync(join(resultDir, "external-review-result.json"), JSON.stringify(tampered, null, 2));
  const blocked = run("gov-commit-integration.mjs", integrationArgs, dir);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /EVIDENCE_IDENTITY_MISMATCH|INTEGRATION_GATE_VIOLATION/);

  // no push / no remote state changed / main untouched
  const mainHead = execFileSync("git", ["rev-parse", "main"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(mainHead, baseHead, "main unchanged");
  const branches = execFileSync("git", ["branch", "--list"], { cwd: dir, encoding: "utf8" });
  assert.ok(branches.includes("governance/test-unit"));
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
    "--expected-paths", "work/",
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

test("e2e: bundle path mismatch → HOLD / BUNDLE_PATH_MISMATCH (neg 14 at CLI level)", (t) => {
  const { dir } = createTempRepo(t);
  const outDir = join(dir, "out");
  mkdirSync(outDir, { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, join(outDir, "READY_FOR_REVIEW.txt"));
  // write a fresh record whose authorized bundle path points elsewhere
  const wrong = JSON.parse(readFileSync(authorityPath, "utf8"));
  wrong.bundle_path = join(dir, "elsewhere", "READY_FOR_REVIEW.txt");
  wrong.lifecycle_authorization.external_review.bundle_path = wrong.bundle_path;
  const wrongPath = join(dir, "authority-wrong.json");
  writeFileSync(wrongPath, JSON.stringify(wrong, null, 2));
  mkdirSync(join(dir, "work"), { recursive: true });
  writeFileSync(join(dir, "work", "a.txt"), "x\n");
  const metaPath = join(dir, "meta.json");
  writeFileSync(metaPath, JSON.stringify({ goal: "x" }));
  const res = run("gov-review-bundle.mjs", [
    "--cwd", dir, "--authority-file", wrongPath,
    "--card-id", CARD_ID, "--run-id", RUN_ID,
    "--base-branch", "main", "--out-dir", outDir,
    "--skip-fresh-verify", "--meta", metaPath,
  ], dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /BUNDLE_PATH_MISMATCH/);
});
