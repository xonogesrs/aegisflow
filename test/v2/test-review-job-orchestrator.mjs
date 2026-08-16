// test/v2/test-review-job-orchestrator.mjs
//
// AUTOLOOP-REVART-IMPL1-RC2-FREEZE-R2 — production review-job orchestrator
// reachability (S1 authority-owned spec binding). Uses a real temp git repo +
// a valid authority record (no provider/Pi/cred/network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReviewJobOrchestrator, OrchestratorError } from "../../scripts/gov-review-job-orchestrator.mjs";
import { readReviewJob } from "../../src/governance/review-job.mjs";
import { specDigestOf } from "../../src/governance/spec-identity.mjs";

function runGit(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function setupRepo(remote = "git@github.com:xonogesrs/autoloop.git") {
  const repo = mkdtempSync(join(tmpdir(), "rj-orch-"));
  runGit(repo, ["init", "-q"]);
  runGit(repo, ["config", "user.email", "t@t"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "hello\n");
  runGit(repo, ["add", "a.txt"]);
  runGit(repo, ["commit", "-q", "-m", "init"]);
  runGit(repo, ["branch", "-M", "main"]);
  runGit(repo, ["remote", "add", "origin", remote]);
  return repo;
}

function lifecycleBlock(repo) {
  return {
    decomposition: { allowed: false, max_depth: 0, max_total_nodes: 0 },
    independent_review: { allowed: true, require_fresh_session: false, require_same_artifact_digest: false },
    bounded_repair: { allowed: false, max_rounds: 0, scope_expansion: false },
    checkpoint_commit: { allowed: false, require_local_gates_pass: true, require_clean_index_before_stage: true, require_expected_paths_only: true },
    feature_branch_push: { allowed: false, branch_pattern: "none", force_push: false, require_remote_ancestor_check: false },
    draft_pr: { allowed: false, base_branch: "main", draft_only: true, create_if_missing: false, update_if_present: false },
    external_review: { required: false, require_bundle: false, bundle_path: join(repo, "bundle.txt") },
    review_unit: { allowed: false, repository_count: 1, worktree_count: 1, parent_card_count: 1, architecture_goal_count: 1, maximum_internal_milestones: 1, maximum_changed_paths: 64, maximum_patch_lines: 20000, maximum_repair_rounds: 0 },
    merge_main: { allowed: false },
    release: { allowed: false },
    seal: { allowed: false },
  };
}

function makeRecord({ repo, head, cardId, repository, specPath }) {
  return {
    schema: "autoloop.lifecycle-authorization/v2",
    card_id: cardId,
    run_id: "run-1",
    repository,
    worktree: repo,
    branch: "main",
    base: "main",
    base_head: head,
    authorized_paths: ["docs/pi-graph-output/"],
    bundle_path: join(repo, "bundle.txt"),
    spec_path: specPath,
    lifecycle_authorization: lifecycleBlock(repo),
  };
}

function writeRepoSpec(repo, content = "line1\r\nline2\n") {
  const rel = "docs/governance/card-implementation-spec.md";
  mkdirSync(join(repo, "docs", "governance"), { recursive: true });
  writeFileSync(join(repo, rel), content);
  return rel;
}

function argvFor(repo, recordPath, findingsPath, extra = []) {
  return [
    "--card-id", "CARD",
    "--authority-file", recordPath,
    "--reviewer-identity", "reviewer:ext",
    "--verdict", "PASS",
    "--summary", "v",
    "--recommended-next-action", "STOP",
    "--findings-file", findingsPath,
    "--pi-graph-output", join(repo, "docs", "pi-graph-output"),
    ...extra,
  ];
}

test("production orchestrator reaches STAGED with authority-owned spec + DERIVED identity", () => {
  const repo = setupRepo();
  const specDir = mkdtempSync(join(tmpdir(), "rj-orch-spec-"));
  try {
    const head = runGit(repo, ["rev-parse", "main"]);
    const specRel = writeRepoSpec(repo);
    const specPath = join(repo, specRel);
    const recordPath = join(specDir, "authority.json");
    writeFileSync(recordPath, JSON.stringify(makeRecord({ repo, head, cardId: "CARD", repository: "xonogesrs/autoloop", specPath: specRel })));
    const findingsPath = join(specDir, "findings.json");
    writeFileSync(findingsPath, JSON.stringify([]));

    const result = runReviewJobOrchestrator({ argv: argvFor(repo, recordPath, findingsPath), cwd: repo });

    assert.equal(result.ok, true);
    assert.equal(result.state, "STAGED");
    assert.equal(result.candidateIdentity.repository, "xonogesrs/autoloop");
    assert.equal(result.candidateIdentity.branch, "main");
    assert.equal(result.candidateIdentity.currentHead, head);
    assert.equal(result.specDigest, specDigestOf(readFileSync(specPath)));
    const job = readReviewJob("CARD", { root: join(repo, "docs", "pi-graph-output") }).job;
    assert.equal(job.state, "STAGED");
    assert.equal(job.candidateIdentity.changedTreeIdentity, result.candidateIdentity.changedTreeIdentity);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("orchestrator rejects a mismatched repository (productionRemoteMatch fails closed)", () => {
  const repo = setupRepo("git@github.com:xonogesrs/autoloop.git");
  const specDir = mkdtempSync(join(tmpdir(), "rj-orch-spec-"));
  try {
    const head = runGit(repo, ["rev-parse", "main"]);
    const specRel = writeRepoSpec(repo);
    const recordPath = join(specDir, "authority.json");
    writeFileSync(recordPath, JSON.stringify(makeRecord({ repo, head, cardId: "CARD", repository: "other/otherrepo", specPath: specRel })));
    const findingsPath = join(specDir, "findings.json");
    writeFileSync(findingsPath, JSON.stringify([]));
    assert.throws(
      () => runReviewJobOrchestrator({ argv: argvFor(repo, recordPath, findingsPath), cwd: repo }),
      (e) => e instanceof OrchestratorError && e.code === "REVIEW_REPOSITORY_UNVERIFIED");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("orchestrator rejects a missing canonical spec (fail closed)", () => {
  const repo = setupRepo();
  const specDir = mkdtempSync(join(tmpdir(), "rj-orch-spec-"));
  try {
    const head = runGit(repo, ["rev-parse", "main"]);
    const recordPath = join(specDir, "authority.json");
    writeFileSync(recordPath, JSON.stringify(makeRecord({ repo, head, cardId: "CARD", repository: "xonogesrs/autoloop", specPath: "docs/governance/nope.md" })));
    const findingsPath = join(specDir, "findings.json");
    writeFileSync(findingsPath, JSON.stringify([]));
    assert.throws(
      () => runReviewJobOrchestrator({ argv: argvFor(repo, recordPath, findingsPath), cwd: repo }),
      (e) => e.code === "REVIEW_CONTEXT_SPEC_MISSING");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("orchestrator rejects a caller --spec-path redirect (S1.1)", () => {
  const repo = setupRepo();
  const specDir = mkdtempSync(join(tmpdir(), "rj-orch-spec-"));
  try {
    const head = runGit(repo, ["rev-parse", "main"]);
    const specRel = writeRepoSpec(repo);
    const recordPath = join(specDir, "authority.json");
    writeFileSync(recordPath, JSON.stringify(makeRecord({ repo, head, cardId: "CARD", repository: "xonogesrs/autoloop", specPath: specRel })));
    const findingsPath = join(specDir, "findings.json");
    writeFileSync(findingsPath, JSON.stringify([]));
    // caller passes a DIFFERENT spec path → must be rejected as a redirect
    const otherSpec = join(specDir, "other.md");
    writeFileSync(otherSpec, "other\n");
    assert.throws(
      () => runReviewJobOrchestrator({ argv: argvFor(repo, recordPath, findingsPath, ["--spec-path", otherSpec]), cwd: repo }),
      (e) => e instanceof OrchestratorError && e.code === "SPEC_PATH_REDIRECT_REJECTED");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(specDir, { recursive: true, force: true });
  }
});
