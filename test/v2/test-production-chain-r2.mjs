// test/v2/test-production-chain-r2.mjs
//
// AUTOLOOP-REVART-IMPL1-RC2-FREEZE-R2 — mandatory production-chain proof:
//
//   g0001 create → findings/verdict → staging → ACCEPTED → controlled commit
//   → g0002 create → findings/verdict → ACCEPTED
//
// Proves: governance/evidence accumulation (staged AND committed) does not
// change semantic candidate identity; real source mutation is still a fresh
// candidate; card A's committed evidence never pollutes card B's candidate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { runReviewJobOrchestrator } from "../../scripts/gov-review-job-orchestrator.mjs";
import { readReviewJob, acceptReviewJob } from "../../src/governance/review-job.mjs";
import { deriveReviewJobContext } from "../../src/governance/review-job-context.mjs";
import { productionRemoteMatch } from "../../scripts/shared/gov-args.mjs";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";
import { candidateDomain } from "../../src/governance/candidate-domain-policy.mjs";

function runGit(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function gitFor(repo) {
  return (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function setupRepo() {
  const repo = mkdtempSync(join(tmpdir(), "chain-"));
  runGit(repo, ["init", "-q"]);
  runGit(repo, ["config", "user.email", "t@t"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  runGit(repo, ["add", "base.txt"]);
  runGit(repo, ["commit", "-q", "-m", "init"]);
  runGit(repo, ["branch", "-M", "main"]);
  runGit(repo, ["remote", "add", "origin", "git@github.com:xonogesrs/autoloop.git"]);
  runGit(repo, ["checkout", "-q", "-b", "feat"]);
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
    review_unit: { allowed: false, repository_count: 1, worktree_count: 1, parent_card_count: 1, architecture_goal_count: 1, maximum_internal_milestones: 3, maximum_changed_paths: 64, maximum_patch_lines: 20000, maximum_repair_rounds: 0 },
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
    branch: "feat",
    base: "main",
    base_head: head,
    authorized_paths: ["docs/pi-graph-output/"],
    bundle_path: join(repo, "bundle.txt"),
    spec_path: specPath,
    lifecycle_authorization: lifecycleBlock(repo),
  };
}

function writeSpec(repo, cardId, content) {
  const rel = `docs/governance/${cardId.toLowerCase()}-implementation-spec.md`;
  mkdirSync(join(repo, "docs", "governance"), { recursive: true });
  writeFileSync(join(repo, rel), content);
  return rel;
}

function runCard({ repo, head, cardId, specRel }) {
  const specDir = mkdtempSync(join(tmpdir(), "chain-spec-"));
  try {
    const recordPath = join(specDir, "authority.json");
    writeFileSync(recordPath, JSON.stringify(makeRecord({ repo, head, cardId, repository: "xonogesrs/autoloop", specPath: specRel })));
    const findingsPath = join(specDir, "findings.json");
    writeFileSync(findingsPath, JSON.stringify([]));
    return runReviewJobOrchestrator({
      argv: [
        "--card-id", cardId,
        "--authority-file", recordPath,
        "--reviewer-identity", "reviewer:ext",
        "--verdict", "PASS",
        "--summary", "v",
        "--recommended-next-action", "STOP",
        "--findings-file", findingsPath,
        "--pi-graph-output", join(repo, "docs", "pi-graph-output"),
      ],
      cwd: repo,
    });
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
}

function acceptCard({ repo, cardId, specRel }) {
  const cwd = repo;
  const git = gitFor(repo);
  const authority = { repository: "xonogesrs/autoloop", spec_path: specRel };
  const ctx = deriveReviewJobContext({ git, cwd, baseBranch: "main", specId: cardId, authority });
  const repositoryVerified = productionRemoteMatch(ctx.repositoryRemote, authority.repository);
  const root = join(repo, "docs", "pi-graph-output");
  const artifactRelRoot = relative(cwd, root);
  const prefix = artifactRelRoot ? `${artifactRelRoot}/` : "";
  const stagedSet = git(["diff", "--cached", "--name-only"])
    .split("\n").filter(Boolean)
    .map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p))
    .sort();
  const r = acceptReviewJob({
    cardId,
    implementerIdentity: "implementer:agent",
    authorizationSource: "controller",
    trustedReviewerIdentity: "reviewer:ext",
    recomputed: { candidateIdentity: ctx.candidateIdentity, specIdentity: ctx.specIdentity, stagedSet, repositoryVerified },
  }, { root });
  assert.equal(r.ok, true, r.code ?? r.drift?.join(","));
  return r;
}

test("production chain: g0001 → ACCEPTED → commit → g0002 → ACCEPTED (evidence never pollutes identity)", () => {
  const repo = setupRepo();
  try {
    const git = gitFor(repo);
    const head = runGit(repo, ["rev-parse", "main"]);

    // ── g0001 ─────────────────────────────────────────────────────────
    writeFileSync(join(repo, "src1.txt"), "source one\n");
    const specA = writeSpec(repo, "CARD-A", "spec A\n");
    const r1 = runCard({ repo, head, cardId: "CARD-A", specRel: specA });
    assert.equal(r1.state, "STAGED");
    const job1 = readReviewJob("CARD-A", { root: join(repo, "docs", "pi-graph-output") }).job;
    const boundIdentity1 = job1.candidateIdentity.changedTreeIdentity;

    acceptCard({ repo, cardId: "CARD-A", specRel: specA });
    assert.equal(readReviewJob("CARD-A", { root: join(repo, "docs", "pi-graph-output") }).job.state, "ACCEPTED");

    // ── controlled commit (source + spec + evidence) ──────────────────
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-q", "-m", "g0001 accepted"]);

    // candidate identity stable after commit: same projection, evidence excluded
    const inv1 = buildChangeInventory({ git, cwd: repo, baseBranch: "main", candidateDomain });
    assert.equal(inv1.changedTreeIdentity, boundIdentity1, "committed evidence must not change candidate identity");
    assert.ok(!inv1.changedPaths.some((p) => p.includes("docs/pi-graph-output/CARD-A/")), "CARD-A evidence must be excluded");
    assert.ok(inv1.changedPaths.includes("src1.txt"));
    assert.ok(inv1.changedPaths.includes("docs/governance/card-a-implementation-spec.md"));

    // ── g0002 (next generation, new source mutation) ──────────────────
    writeFileSync(join(repo, "src2.txt"), "source two\n");
    const specB = writeSpec(repo, "CARD-B", "spec B\n");
    const r2 = runCard({ repo, head, cardId: "CARD-B", specRel: specB });
    assert.equal(r2.state, "STAGED");

    const inv2 = buildChangeInventory({ git, cwd: repo, baseBranch: "main", candidateDomain });
    assert.ok(!inv2.changedPaths.some((p) => p.includes("CARD-A/review-")), "CARD-A evidence must not pollute CARD-B candidate");
    assert.ok(inv2.changedPaths.includes("src2.txt"));
    assert.ok(inv2.changedPaths.includes("docs/governance/card-b-implementation-spec.md"));

    acceptCard({ repo, cardId: "CARD-B", specRel: specB });
    assert.equal(readReviewJob("CARD-B", { root: join(repo, "docs", "pi-graph-output") }).job.state, "ACCEPTED");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
