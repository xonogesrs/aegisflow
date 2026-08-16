// test/v2/test-staged-set-exact.mjs
//
// AUTOLOOP-REVART-IMPL1-RC2 — exact Git staged-set enforcement (D3/F6).
// Zero provider, zero Pi, zero credential, zero network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createReviewJob, acceptReviewJob, readReviewJob, advanceState,
} from "../../src/governance/review-job.mjs";
import {
  persistFindings, persistVerdict, finalizePersisted, stageArtifacts,
} from "../../src/governance/review-job-writeback.mjs";

const sha = (c, n) => c.repeat(n);
const tmpRoot = () => mkdtempSync(join(tmpdir(), "rj-staged-"));
const candidate = () => ({
  changedTreeIdentity: sha("a", 64), patchSha256: sha("b", 64),
  currentHead: sha("c", 40), baseHead: sha("d", 40), repository: "repo:test", branch: "main",
});

function persistedJob(root) {
  createReviewJob({ cardId: "CARD", generation: 1, candidateIdentity: candidate(), specId: "spec-1", specDigest: sha("e", 64) }, { root });
  advanceState("CARD", "REQUIRED", "PREPARED", { root });
  advanceState("CARD", "PREPARED", "RUNNING", { root });
  persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
  persistVerdict({ cardId: "CARD", reviewerIdentity: "reviewer:ext", verdict: "PASS", summary: "v", recommendedNextAction: "STOP" }, { root });
  finalizePersisted({ cardId: "CARD" }, { root });
}

const CANON = ["CARD/review-job.json", "CARD/review-findings.g0001.json", "CARD/review-verdict.g0001.json"];

// git runner that records added paths and reports them as the staged set.
function makeGit(stagedPaths) {
  const added = [];
  return {
    added,
    run: (args) => {
      if (args[0] === "add") { added.push(args[1]); return ""; }
      if (args[0] === "diff" && args[1] === "--cached") return (stagedPaths ?? added).join("\n");
      return "";
    },
  };
}

test("stageArtifacts without a git runner fails closed", () => {
  const root = tmpRoot();
  try {
    persistedJob(root);
    const r = stageArtifacts({ cardId: "CARD" }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_STAGING_GIT_MISSING");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exact staged set (3 paths) transitions to STAGED", () => {
  const root = tmpRoot();
  try {
    persistedJob(root);
    const g = makeGit();
    const r = stageArtifacts({ cardId: "CARD", git: g.run, repoRoot: root }, { root });
    assert.equal(r.ok, true);
    assert.equal(readReviewJob("CARD", { root }).job.state, "STAGED");
    assert.deepEqual([...g.added].sort(), [...CANON].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subset staged (only one artifact) is rejected as incomplete", () => {
  const root = tmpRoot();
  try {
    persistedJob(root);
    const g = makeGit(["CARD/review-job.json"]);
    const r = stageArtifacts({ cardId: "CARD", git: g.run, repoRoot: root }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_STAGING_INCOMPLETE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("extra review artifact staged is rejected", () => {
  const root = tmpRoot();
  try {
    persistedJob(root);
    const g = makeGit([...CANON, "CARD/review-verdict.g0002.json"]);
    const r = stageArtifacts({ cardId: "CARD", git: g.run, repoRoot: root }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_STAGING_UNEXPECTED_MATERIAL");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("wrong generation staged is rejected", () => {
  const root = tmpRoot();
  try {
    persistedJob(root);
    const g = makeGit(["CARD/review-job.json", "CARD/review-findings.g0002.json", "CARD/review-verdict.g0002.json"]);
    const r = stageArtifacts({ cardId: "CARD", git: g.run, repoRoot: root }, { root });
    assert.equal(r.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function stageExact(root) {
  const g = makeGit();
  const r = stageArtifacts({ cardId: "CARD", git: g.run, repoRoot: root }, { root });
  assert.equal(r.ok, true);
}

test("acceptance rejects staged-set drift (stage then unstage)", () => {
  const root = tmpRoot();
  try {
    persistedJob(root);
    stageExact(root);
    const recomputed = {
      candidateIdentity: candidate(),
      specIdentity: { specId: "spec-1", specDigest: sha("e", 64) },
      stagedSet: [],
      repositoryVerified: true,
    };
    const r = acceptReviewJob({ cardId: "CARD", trustedReviewerIdentity: "reviewer:ext", authorizationSource: "controller:op", recomputed }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_STAGED_SET_DRIFT");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("acceptance rejects candidate drift", () => {
  const root = tmpRoot();
  try {
    persistedJob(root);
    stageExact(root);
    const drifted = candidate();
    drifted.currentHead = sha("9", 40);
    const recomputed = {
      candidateIdentity: drifted,
      specIdentity: { specId: "spec-1", specDigest: sha("e", 64) },
      stagedSet: CANON,
      repositoryVerified: true,
    };
    const r = acceptReviewJob({ cardId: "CARD", trustedReviewerIdentity: "reviewer:ext", authorizationSource: "controller:op", recomputed }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_CANDIDATE_DRIFT");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("acceptance rejects spec drift", () => {
  const root = tmpRoot();
  try {
    persistedJob(root);
    stageExact(root);
    const recomputed = {
      candidateIdentity: candidate(),
      specIdentity: { specId: "spec-1", specDigest: sha("f", 64) },
      stagedSet: CANON,
      repositoryVerified: true,
    };
    const r = acceptReviewJob({ cardId: "CARD", trustedReviewerIdentity: "reviewer:ext", authorizationSource: "controller:op", recomputed }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_SPEC_DRIFT");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("acceptance rejects unverified repository", () => {
  const root = tmpRoot();
  try {
    persistedJob(root);
    stageExact(root);
    const recomputed = {
      candidateIdentity: candidate(),
      specIdentity: { specId: "spec-1", specDigest: sha("e", 64) },
      stagedSet: CANON,
      repositoryVerified: false,
    };
    const r = acceptReviewJob({ cardId: "CARD", trustedReviewerIdentity: "reviewer:ext", authorizationSource: "controller:op", recomputed }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_REPOSITORY_UNVERIFIED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
