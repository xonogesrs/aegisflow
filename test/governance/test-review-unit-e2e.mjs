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
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTempRepo, testRemoteMatch, CARD_ID, RUN_ID } from "./helpers.mjs";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";
import { candidateDomain } from "../../src/governance/candidate-domain-policy.mjs";
import { remoteUrlMatchesAuthorizedRepository, productionRemoteMatch } from "../../scripts/shared/gov-args.mjs";
import { generateReviewBundle } from "../../scripts/gov-review-bundle.mjs";
import { bundleDigestFromFile } from "../../src/governance/review-context.mjs";
import { runPushGate } from "../../scripts/gov-push-gate.mjs";
import { runCommitIntegration } from "../../scripts/gov-commit-integration.mjs";
import { parseArgs } from "../../scripts/shared/gov-args.mjs";

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

// PGMA1: canonical evidence root OUTSIDE the fixture repo (unique sibling
// dir per fixture) so unmigrated legacy gates never see the review-job in
// the worktree and tests never collide on the same evidence path.
function evidenceRootFor(dir) {
  return join(dirname(dir), `pgma1-evidence-${basename(dir)}`);
}

// In-process push gate with the TEST-ONLY remote adapter injected (local
// bare remotes are never part of the production remote policy). The
// canonical surface is always the fixture surface at <dir>/out/surface.
function pushGate(argv, dir) {
  const prev = process.env.AEGISFLOW_PI_GRAPH_OUTPUT;
  process.env.AEGISFLOW_PI_GRAPH_OUTPUT = evidenceRootFor(dir);
  try {
    const report = runPushGate({ argv, cwd: dir, surfaceDir: join(dir, "out", "surface"), remotePolicy: testRemoteMatch });
    return { status: 0, report, stderr: "" };
  } catch (e) {
    return { status: 1, report: null, stderr: `${e.code ?? ""}\n${e.message}` };
  } finally {
    if (prev === undefined) delete process.env.AEGISFLOW_PI_GRAPH_OUTPUT;
    else process.env.AEGISFLOW_PI_GRAPH_OUTPUT = prev;
  }
}

// R-11: in-process integration attestation through the same TEST-ONLY env
// seam as the push gate helper (review-job lives outside the fixture repo)
// and the same fixture surface. The retired external-review-result.json is
// never consulted by the migrated gate.
function integrationAttest(argv, dir) {
  const prev = process.env.AEGISFLOW_PI_GRAPH_OUTPUT;
  process.env.AEGISFLOW_PI_GRAPH_OUTPUT = evidenceRootFor(dir);
  try {
    const { flags } = parseArgs(argv);
    const report = runCommitIntegration({ flags, cwd: dir, surfaceDir: join(dir, "out", "surface") });
    return { status: 0, stdout: JSON.stringify(report, null, 1), report, stderr: "" };
  } catch (e) {
    return { status: 1, stdout: "", report: null, stderr: `${e.code ?? ""}\n${e.message}` };
  } finally {
    if (prev === undefined) delete process.env.AEGISFLOW_PI_GRAPH_OUTPUT;
    else process.env.AEGISFLOW_PI_GRAPH_OUTPUT = prev;
  }
}

// PGMA1: materialize the canonical promotion evidence for the fixture card —
// review-job ACCEPTED (identity recomputed over the candidate domain) +
// surface delivery (PASS/PENDING) + delivered bundle (body digest bound).
// The review-job lives OUTSIDE the repo (AEGISFLOW_PI_GRAPH_OUTPUT seam) so
// it never dirties the fixture worktree for unmigrated legacy gates.
function materializeCanonicalEvidence(dir, { status = "PASS", evidenceRoot = null } = {}) {
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const baseHead = git(["rev-parse", "main"]).trim();
  const head = git(["rev-parse", "HEAD"]).trim();
  const branch = git(["branch", "--show-current"]).trim();
  const inv = buildChangeInventory({ git, cwd: dir, baseBranch: "main", candidateDomain });
  const root = evidenceRoot ?? evidenceRootFor(dir);
  const cardDir = join(root, CARD_ID);
  mkdirSync(cardDir, { recursive: true });
  const job = {
    schemaVersion: "autoloop.review-job/v1",
    lineageId: CARD_ID,
    jobId: `${CARD_ID}.g0002`,
    generation: 2,
    candidateIdentity: {
      changedTreeIdentity: inv.changedTreeIdentity,
      patchSha256: inv.patchSha256,
      currentHead: head,
      baseHead,
      repository: "xonogesrs/autoloop",
      branch,
    },
    specId: CARD_ID,
    specDigest: "d".repeat(64),
    reviewRound: 1,
    repairRound: 0,
    priorJobId: `${CARD_ID}.g0001`,
    supersedes: `${CARD_ID}.g0001`,
    state: "ACCEPTED",
    stateVersion: 8,
    requiredArtifacts: [
      { role: "findings", required: true, writeMode: "exclusive-create" },
      { role: "verdict", required: true, writeMode: "exclusive-create" },
    ],
    priorFindingsDigest: "c".repeat(64),
    priorVerdictDigest: "b".repeat(64),
    repoIdentity: "xonogesrs/autoloop",
    worktreeIdentity: realpathSync(dir),
    findingsDigest: "a".repeat(64),
    verdictDigest: "e".repeat(64),
    acceptedAt: new Date().toISOString(),
    acceptanceAuthority: "controller",
  };
  writeFileSync(join(cardDir, "review-job.json"), JSON.stringify(job));
  const surface = join(dir, "out", "surface");
  mkdirSync(surface, { recursive: true });
  const bundleId = "f".repeat(64);
  const bundleBody = `REVIEW_BUNDLE_IDENTITY: ${bundleId}\nFIXTURE BUNDLE\n`;
  const bundleSha = createHash("sha256").update(bundleBody).digest("hex");
  writeFileSync(join(surface, "review-bundle.txt"), bundleBody + `REVIEW_BUNDLE_SHA256: ${bundleSha}\n`);
  const delivery = {
    schema: "autoloop.external-review-delivery/v2",
    cardId: CARD_ID,
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
      attemptedAt: new Date().toISOString(),
      bundlePath: join(surface, "review-bundle.txt"),
      reviewBundleIdentity: bundleId,
      reviewBundleSha256: bundleSha,
    },
    verdict: status === "PASS"
      ? { verdict: "PASS", reviewerIdentity: "external-reviewer-1", reviewedAt: new Date().toISOString(), bundleIdentity: bundleId, bundleSha256: bundleSha, findingsDigest: null }
      : null,
    supersedes: null,
  };
  writeFileSync(join(surface, "delivery.json"), JSON.stringify(delivery));
  return { surface, bundleId, bundleSha, evidenceRoot: root };
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

  // ── PENDING blocks push (delivery not PASS → canonical HOLD) ──
  materializeCanonicalEvidence(dir, { status: "PENDING" });
  const pushPending = pushGate(["--authority-file", authorityPath], dir);
  assert.notEqual(pushPending.status, 0);
  assert.match(pushPending.stderr, /DELIVERY_NOT_PASS/);
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

  // ── R-11 INTEGRATION attestation chronology (canonical authority) ──
  // BEFORE canonical PASS: delivery is PENDING, the ingested legacy result
  // artifact exists (ingested above) — integration must HOLD. The retired
  // artifact grants nothing (RC1A §7.2).
  const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const integrationPending = integrationAttest([
    "--authority-file", authorityPath, "--cwd", dir,
    "--verification-passed", "true", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
  ], dir);
  assert.notEqual(integrationPending.status, 0, "PENDING delivery must not authorize integration");
  assert.match(integrationPending.stderr, /DELIVERY_NOT_PASS/);
  const headStill = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(headStill, headBefore, "HOLD must not create a commit");

  // AFTER canonical PASS: integration succeeds. The legacy artifact stays
  // on disk but plays no role; HEAD is unchanged (attestation only).
  materializeCanonicalEvidence(dir, { status: "PASS" });
  const integration = integrationAttest([
    "--authority-file", authorityPath, "--cwd", dir,
    "--verification-passed", "true", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
  ], dir);
  assert.equal(integration.status, 0, integration.stderr);
  assert.equal(integration.report.integration_ready, true);
  assert.equal(integration.report.attestation_only, true);
  assert.equal(integration.report.no_commit_created, true);
  const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(headAfter, headBefore, "integration must NOT create a new commit");

  // IDEMPOTENCE: the exact same attestation repeats with the same outcome,
  // same authority identity, no mutation.
  const repeat = integrationAttest([
    "--authority-file", authorityPath, "--cwd", dir,
    "--verification-passed", "true", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
  ], dir);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(repeat.report.authority_identity, integration.report.authority_identity);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), headBefore);

  // RC-D: tampering the retired artifact cannot revoke the valid canonical
  // authorization — the migrated gate never reads it.
  const resultPath = join(outDir, "governance", "external-review-result.json");
  const tampered = JSON.parse(readFileSync(resultPath, "utf8"));
  tampered.bundle_sha256 = "0".repeat(64);
  writeFileSync(resultPath, JSON.stringify(tampered, null, 2));
  const stillAllowed = integrationAttest([
    "--authority-file", authorityPath, "--cwd", dir,
    "--verification-passed", "true", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
  ], dir);
  assert.equal(stillAllowed.status, 0, stillAllowed.stderr);
  assert.equal(stillAllowed.report.integration_ready, true);

  // ── PUSH dry-run now PASSES: canonical delivery PASS bound to the
  // reviewed checkpoint HEAD ──
  materializeCanonicalEvidence(dir, { status: "PASS" });
  const pushPass = pushGate(["--authority-file", authorityPath], dir);
  assert.equal(pushPass.status, 0, pushPass.stderr);
  assert.equal(pushPass.report.allowed, true);

  // ── CANONICAL DELIVERY TAMPERED → push blocked again (verdict unbound) ──
  const deliveryPath = join(dir, "out", "surface", "delivery.json");
  const tamperedDelivery = JSON.parse(readFileSync(deliveryPath, "utf8"));
  tamperedDelivery.verdict.bundleSha256 = "0".repeat(64);
  writeFileSync(deliveryPath, JSON.stringify(tamperedDelivery, null, 2));
  const pushBlocked = pushGate(["--authority-file", authorityPath], dir);
  assert.notEqual(pushBlocked.status, 0);
  assert.match(pushBlocked.stderr, /DELIVERY_VERDICT_UNBOUND/);


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
  // canonical evidence in place → the gate reaches the writable-scope check
  // and the committed out-of-scope path still blocks the push
  materializeCanonicalEvidence(dir);
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
  // a prior (round-2) bundle must exist in the archive for the prior binding.
  // R-14: the prior artifact must be SELF-CONSISTENT (footer digest equals the
  // recomputed content digest) — a stub whose footer lies is not selectable.
  mkdirSync(join(outDir, "archive"), { recursive: true });
  const priorBody = "PRIOR BUNDLE R2\n";
  const priorText = priorBody + "BUNDLE_SHA256 (sha256 of all content above): " + bundleDigestFromFile(priorBody) + "\n";
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
  // canonical evidence PASS + the reviewed head pushed to the remote (draft
  // PR is a post-push integration record)
  const fx = materializeCanonicalEvidence(dir);
  const bareDir = join(dir, "remote", "xonogesrs", "autoloop.git");
  mkdirSync(bareDir, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q"], { cwd: bareDir });
  git(["remote", "add", "origin", bareDir]);
  git(["push", "-q", "origin", "HEAD:refs/heads/governance/test-unit"]);
  // a custom body without card/result binding must be rejected for CREATE
  const unboundBody = join(outDir, "unbound-body.md");
  writeFileSync(unboundBody, "## unrelated content\nno card binding here\n");
  const prevEv = process.env.AEGISFLOW_PI_GRAPH_OUTPUT;
  process.env.AEGISFLOW_PI_GRAPH_OUTPUT = fx.evidenceRoot;
  try {
    const draft = run("gov-draft-pr.mjs", [
      "--authority-file", authorityPath, "--cwd", dir,
      "--surface", fx.surface,
      "--body-file", unboundBody,
    ], dir);
    assert.notEqual(draft.status, 0);
    assert.match(draft.stderr, /PR_NOT_BOUND_TO_PARENT_CARD/);
  } finally {
    if (prevEv === undefined) delete process.env.AEGISFLOW_PI_GRAPH_OUTPUT;
    else process.env.AEGISFLOW_PI_GRAPH_OUTPUT = prevEv;
  }
});

test("[neg 14] exhausted repair lineage cannot restart as a fresh card: same authority record with a different card_id is a live-binding violation（reauthorization requires a NEW authority record）", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
  git(["add", ".gitignore"]);
  git(["commit", "-m", "gitignore"]);
  const outDir = join(dir, "out");
  const bundlePath = join(outDir, "READY_FOR_REVIEW.txt");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(dir, "work"), { recursive: true });
  const authorityPath = writeAuthorityRecord(dir, bundlePath);
  // card A exhausted its repair budget: repair_round 3 > effective cap 2.
  // Under the record's OWN card_id the exhaustion is enforced（cap binds）.
  writeFileSync(join(dir, "work", "a.txt"), "a\n");
  const ck = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir, "--verification-passed", "true",
    "--artifact-identity", "x", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", CARD_ID, "--run-id", RUN_ID, "--milestone-id", "m1", "--milestones", "1",
    "--repair-rounds", "3", "--message", "ck", "--apply",
  ], dir);
  // repair 3 exceeds the cap 2 → the exhausted round is denied
  assert.notEqual(ck.status, 0);
  assert.match(ck.stderr, /REVIEW_UNIT_LIMIT_EXCEEDED|repair_cap_authority_conflict/);
  // swapping the card_id on the SAME record is a live-binding violation:
  // a fresh lineage under an exhausted authority record is denied（budget
  // cannot be reset by lineage restart under the same authority）
  const reused = run("gov-commit-checkpoint.mjs", [
    "--authority-file", authorityPath, "--cwd", dir, "--verification-passed", "true",
    "--artifact-identity", "x", "--evidence-digest", "e".repeat(64), "--repair-converged", "true",
    "--card-id", "OTHER-CARD", "--run-id", RUN_ID, "--milestone-id", "m1", "--milestones", "1",
    "--repair-rounds", "0", "--message", "ck2", "--apply",
  ], dir);
  assert.notEqual(reused.status, 0);
  assert.match(reused.stderr, /LIVE_BINDING_MISMATCH|card_id/);
  // prepare-round under the same record with repair round 0 but a different
  // card id is likewise rejected by the controller entry（card_id derived
  // from the record, never caller-chosen）
  writeFileSync(join(outDir, "findings.txt"), "round findings");
  const prepare = run("gov-controller-prepare-round.mjs", [
    "--bundle-dir", outDir, "--card-id", "OTHER-CARD", "--findings-file", join(outDir, "findings.txt"),
    "--review-round", "1", "--repair-round", "0", "--authority-file", authorityPath,
  ], dir);
  assert.notEqual(prepare.status, 0);
  assert.match(prepare.stderr, /REVIEW_HISTORY_INVALID|LIVE_BINDING_MISMATCH|card_id/);
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
