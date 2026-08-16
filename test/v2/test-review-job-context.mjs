// test/v2/test-review-job-context.mjs
//
// AUTOLOOP-REVART-IMPL1-RC2 — review-job context authority adapter tests.
// Uses a real temp git repo (no provider/Pi/credential/network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deriveReviewJobContext,
  candidateDrift,
  specDrift,
  ReviewJobContextError,
} from "../../src/governance/review-job-context.mjs";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";
import { specDigestOf, SpecIdentityError } from "../../src/governance/spec-identity.mjs";

function runGit(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function setupRepo(remote = "git@github.com:xonogesrs/autoloop.git") {
  const repo = mkdtempSync(join(tmpdir(), "rj-context-"));
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

function specFile(dir, content) {
  const p = join(dir, "card-spec.md");
  writeFileSync(p, content);
  return p;
}

const authority = { repository: "git@github.com:xonogesrs/autoloop.git" };

test("derives candidate identity from git, not caller input", () => {
  const repo = setupRepo();
  const specDir = mkdtempSync(join(tmpdir(), "rj-spec-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const ctx = deriveReviewJobContext({
      git, cwd: repo, baseBranch: "main",
      specId: "spec-1", specPath: specFile(specDir, "spec body\n"),
      authority,
    });
    assert.equal(ctx.candidateIdentity.repository, authority.repository);
    assert.equal(ctx.candidateIdentity.branch, "main");
    assert.equal(ctx.candidateIdentity.currentHead, runGit(repo, ["rev-parse", "HEAD"]));
    // changedTree/patch are recomputed from git (equal to the authoritative owner)
    const inv = buildChangeInventory({ git, cwd: repo, baseBranch: "main" });
    assert.equal(ctx.candidateIdentity.changedTreeIdentity, inv.changedTreeIdentity);
    assert.equal(ctx.candidateIdentity.patchSha256, inv.patchSha256);
    assert.match(ctx.candidateIdentity.changedTreeIdentity, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("specDigest is derived from spec bytes (no caller digest input exists)", () => {
  const repo = setupRepo();
  const specDir = mkdtempSync(join(tmpdir(), "rj-spec-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const sp = specFile(specDir, "line1\r\nline2\n");
    const ctx = deriveReviewJobContext({ git, cwd: repo, baseBranch: "main", specId: "spec-1", specPath: sp, authority });
    const expected = specDigestOf(readFileSync(sp));
    assert.equal(ctx.specIdentity.specDigest, expected);
    assert.equal(ctx.specIdentity.specId, "spec-1");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("repositoryRemote is derived live from git origin", () => {
  const repo = setupRepo("git@github.com:xonogesrs/autoloop.git");
  const specDir = mkdtempSync(join(tmpdir(), "rj-spec-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const ctx = deriveReviewJobContext({ git, cwd: repo, baseBranch: "main", specId: "spec-1", specPath: specFile(specDir, "x\n"), authority });
    assert.equal(ctx.repositoryRemote, "git@github.com:xonogesrs/autoloop.git");
    assert.ok(ctx.worktreeIdentity);
    assert.equal(ctx.liveHead, runGit(repo, ["rev-parse", "HEAD"]));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("missing git runner fails closed", () => {
  assert.throws(() => deriveReviewJobContext({ cwd: "/x", baseBranch: "main", specId: "s", specPath: "/s", authority }),
    (e) => e instanceof ReviewJobContextError && e.code === "REVIEW_CONTEXT_GIT_MISSING");
});

test("missing canonical spec fails closed", () => {
  const repo = setupRepo();
  const specDir = mkdtempSync(join(tmpdir(), "rj-spec-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.throws(
      () => deriveReviewJobContext({ git, cwd: repo, baseBranch: "main", specId: "s", specPath: join(specDir, "nope.md"), authority }),
      (e) => e instanceof ReviewJobContextError && e.code === "REVIEW_CONTEXT_SPEC_MISSING");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("missing authority.repository fails closed", () => {
  const repo = setupRepo();
  const specDir = mkdtempSync(join(tmpdir(), "rj-spec-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.throws(
      () => deriveReviewJobContext({ git, cwd: repo, baseBranch: "main", specId: "s", specPath: specFile(specDir, "x\n"), authority: {} }),
      (e) => e instanceof ReviewJobContextError && e.code === "REVIEW_CONTEXT_REPOSITORY_MISSING");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("invalid UTF-8 spec fails closed", () => {
  const repo = setupRepo();
  const specDir = mkdtempSync(join(tmpdir(), "rj-spec-"));
  try {
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const sp = join(specDir, "bad.md");
    writeFileSync(sp, Buffer.from([0xff, 0xfe, 0xfd]));
    assert.throws(
      () => deriveReviewJobContext({ git, cwd: repo, baseBranch: "main", specId: "s", specPath: sp, authority }),
      SpecIdentityError);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("candidateDrift reports field-level differences only", () => {
  const a = { changedTreeIdentity: "a".repeat(64), patchSha256: "b".repeat(64), currentHead: "c".repeat(40), baseHead: "d".repeat(40), repository: "r", branch: "main" };
  const b = { ...a, currentHead: "e".repeat(40) };
  assert.deepEqual(candidateDrift(a, b), ["currentHead"]);
  assert.deepEqual(candidateDrift(a, a), []);
});

test("specDrift is true only on digest difference", () => {
  assert.equal(specDrift("a".repeat(64), "b".repeat(64)), true);
  assert.equal(specDrift("a".repeat(64), "a".repeat(64)), false);
});
