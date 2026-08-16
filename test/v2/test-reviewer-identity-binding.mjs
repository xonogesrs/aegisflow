// test/v2/test-reviewer-identity-binding.mjs
//
// AUTOLOOP-REVART-IMPL1-RC2 — trusted reviewer identity binding (D4).
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
const tmpRoot = () => mkdtempSync(join(tmpdir(), "rj-reviewer-"));
const candidate = () => ({
  changedTreeIdentity: sha("a", 64), patchSha256: sha("b", 64),
  currentHead: sha("c", 40), baseHead: sha("d", 40), repository: "repo:test", branch: "main",
});

function makeStagedJob(root, reviewer) {
  createReviewJob({ cardId: "CARD", generation: 1, candidateIdentity: candidate(), specId: "spec-1", specDigest: sha("e", 64) }, { root });
  advanceState("CARD", "REQUIRED", "PREPARED", { root });
  advanceState("CARD", "PREPARED", "RUNNING", { root });
  persistFindings({ cardId: "CARD", reviewerIdentity: reviewer, findings: [], summary: "f" }, { root });
  persistVerdict({ cardId: "CARD", reviewerIdentity: reviewer, verdict: "PASS", summary: "v", recommendedNextAction: "STOP" }, { root });
  finalizePersisted({ cardId: "CARD" }, { root });
  const staged = [];
  const git = (args) => {
    if (args[0] === "add") { staged.push(args[1]); return ""; }
    if (args[0] === "diff" && args[1] === "--cached") return staged.join("\n");
    return "";
  };
  stageArtifacts({ cardId: "CARD", git }, { root });
}

// A recomputed object that matches the job exactly (no drift).
function recomputed() {
  return {
    candidateIdentity: candidate(),
    specIdentity: { specId: "spec-1", specDigest: sha("e", 64) },
    stagedSet: ["CARD/review-job.json", "CARD/review-findings.g0001.json", "CARD/review-verdict.g0001.json"],
    repositoryVerified: true,
  };
}

test("matching trusted reviewer identity is accepted", () => {
  const root = tmpRoot();
  try {
    makeStagedJob(root, "reviewer:ext");
    const r = acceptReviewJob({ cardId: "CARD", trustedReviewerIdentity: "reviewer:ext", authorizationSource: "controller:op", recomputed: recomputed() }, { root });
    assert.equal(r.ok, true);
    assert.equal(readReviewJob("CARD", { root }).job.state, "ACCEPTED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("trusted reviewer identity mismatch is rejected", () => {
  const root = tmpRoot();
  try {
    makeStagedJob(root, "reviewer:ext");
    const r = acceptReviewJob({ cardId: "CARD", trustedReviewerIdentity: "other:reviewer", authorizationSource: "controller:op", recomputed: recomputed() }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEWER_IDENTITY_MISMATCH");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing trusted identity on the full-recompute path fails closed", () => {
  const root = tmpRoot();
  try {
    makeStagedJob(root, "reviewer:ext");
    const r = acceptReviewJob({ cardId: "CARD", authorizationSource: "controller:op", recomputed: recomputed() }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEWER_IDENTITY_MISSING");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("self-declared 'independent' reviewer cannot pass the trusted binding", () => {
  const root = tmpRoot();
  try {
    makeStagedJob(root, "independent");
    const r = acceptReviewJob({ cardId: "CARD", trustedReviewerIdentity: "reviewer:ext", authorizationSource: "controller:op", recomputed: recomputed() }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEWER_IDENTITY_MISMATCH");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reviewer == implementer is rejected before trusted binding", () => {
  const root = tmpRoot();
  try {
    makeStagedJob(root, "executor:impl");
    const r = acceptReviewJob({ cardId: "CARD", implementerIdentity: "executor:impl", trustedReviewerIdentity: "executor:impl", authorizationSource: "controller:op", recomputed: recomputed() }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_SELF_DECLARED_REVIEWER");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
