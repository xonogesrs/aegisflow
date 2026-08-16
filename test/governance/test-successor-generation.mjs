// test/governance/test-successor-generation.mjs
//
// AUTH1-TC1 R-TC1-02 — successor-generation foundation tests.
// Proves: SUPERSEDE → createSuccessorReviewJob → g0002 REQUIRED with lineage
// links; g0001 artifacts preserved; stale ACCEPTED can never re-satisfy live
// enforcement; concurrency fails closed; crash-resume; monotonic generation;
// successor runs the full lifecycle to a fresh ACCEPTED.
// Zero provider, zero Pi, zero credential, zero network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createReviewJob,
  createSuccessorReviewJob,
  readReviewJob,
  advanceState,
  supersede,
  acceptReviewJob,
  jobIdFor,
  findingsPath,
  verdictPath,
  reviewJobPath,
} from "../../src/governance/review-job.mjs";
import {
  persistFindings,
  persistVerdict,
  finalizePersisted,
  stageArtifacts,
} from "../../src/governance/review-job-writeback.mjs";
import { assertReviewArtifactEnforced } from "../../src/governance/review-artifact-gate.mjs";

const sha = (c, n) => c.repeat(n);
const REQ = { review_policy: { strength: "independent" } };
const REVIEWER = "reviewer:ext";
const IMPLEMENTER = "executor:impl";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "successor-gen-"));
}

function candidate(currentHead = sha("c", 40)) {
  return {
    changedTreeIdentity: sha("a", 64),
    patchSha256: sha("b", 64),
    currentHead,
    baseHead: sha("d", 40),
    repository: "repo:test",
    branch: "main",
  };
}

const OLD_CANDIDATE = candidate();
const NEW_CANDIDATE = candidate(sha("f", 40)); // post-commit context (drifted HEAD)
const OLD_SPEC = sha("e", 64);
const NEW_SPEC = sha("0", 64);

/** Build an ACCEPTED g0001 via the real lifecycle. Returns staged paths. */
function makeAcceptedG0001(root) {
  createReviewJob({
    cardId: "CARD", generation: 1,
    candidateIdentity: OLD_CANDIDATE, specId: "spec-1", specDigest: OLD_SPEC,
  }, { root });
  advanceState("CARD", "REQUIRED", "PREPARED", { root });
  advanceState("CARD", "PREPARED", "RUNNING", { root });
  persistFindings({ cardId: "CARD", reviewerIdentity: REVIEWER, findings: [], summary: "f" }, { root });
  persistVerdict({ cardId: "CARD", reviewerIdentity: REVIEWER, verdict: "PASS", summary: "v", recommendedNextAction: "STOP" }, { root });
  finalizePersisted({ cardId: "CARD" }, { root });
  const staged = [];
  const git = (args) => {
    if (args[0] === "add") { staged.push(args[1]); return ""; }
    if (args[0] === "diff" && args[1] === "--cached") return staged.join("\n");
    return "";
  };
  stageArtifacts({ cardId: "CARD", git }, { root });
  const r = acceptReviewJob({
    cardId: "CARD",
    implementerIdentity: IMPLEMENTER,
    authorizationSource: "controller:op",
    trustedReviewerIdentity: REVIEWER,
    recomputed: {
      candidateIdentity: OLD_CANDIDATE,
      specIdentity: { specId: "spec-1", specDigest: OLD_SPEC },
      stagedSet: ["CARD/review-job.json", "CARD/review-findings.g0001.json", "CARD/review-verdict.g0001.json"],
      repositoryVerified: true,
    },
  }, { root });
  assert.equal(r.ok, true, r.code);
  return readReviewJob("CARD", { root }).job;
}

test("g0001 → createSuccessorReviewJob → g0002 REQUIRED with lineage links", () => {
  const root = tmpRoot();
  try {
    const g1 = makeAcceptedG0001(root);
    const r = createSuccessorReviewJob({
      cardId: "CARD",
      candidateIdentity: NEW_CANDIDATE,
      specId: "spec-1",
      specDigest: NEW_SPEC,
      predecessorJobId: g1.jobId,
    }, { root });
    assert.equal(r.ok, true, r.code);
    assert.equal(r.job.jobId, "CARD.g0002");
    assert.equal(r.job.generation, 2);
    assert.equal(r.job.lineageId, "CARD");
    assert.equal(r.job.state, "REQUIRED");
    assert.equal(r.job.stateVersion, 1);
    // lineage links
    assert.equal(r.job.priorJobId, g1.jobId);
    assert.equal(r.job.priorFindingsDigest, g1.findingsDigest);
    assert.equal(r.job.priorVerdictDigest, g1.verdictDigest);
    assert.equal(r.job.supersedes, g1.jobId);
    // new context bound
    assert.deepEqual(r.job.candidateIdentity, NEW_CANDIDATE);
    assert.equal(r.job.specDigest, NEW_SPEC);
    // current pointer converged
    assert.equal(readReviewJob("CARD", { root }).job.jobId, "CARD.g0002");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("g0001 findings/verdict artifacts are preserved (not deleted, not overwritten)", () => {
  const root = tmpRoot();
  try {
    const g1 = makeAcceptedG0001(root);
    const f1 = readFileSync(findingsPath("CARD", 1, { root }), "utf8");
    const v1 = readFileSync(verdictPath("CARD", 1, { root }), "utf8");
    createSuccessorReviewJob({
      cardId: "CARD", candidateIdentity: NEW_CANDIDATE, specId: "spec-1",
      specDigest: NEW_SPEC, predecessorJobId: g1.jobId,
    }, { root });
    // files still exist and are byte-identical
    assert.equal(existsSync(findingsPath("CARD", 1, { root })), true);
    assert.equal(existsSync(verdictPath("CARD", 1, { root })), true);
    assert.equal(readFileSync(findingsPath("CARD", 1, { root }), "utf8"), f1);
    assert.equal(readFileSync(verdictPath("CARD", 1, { root }), "utf8"), v1);
    // g0001's digests still recompute from persisted bytes
    assert.equal(createHash("sha256").update(f1, "utf8").digest("hex"), g1.findingsDigest);
    assert.equal(createHash("sha256").update(v1, "utf8").digest("hex"), g1.verdictDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale ACCEPTED g0001 can never re-satisfy live enforcement after supersede", () => {
  const root = tmpRoot();
  try {
    const g1 = makeAcceptedG0001(root);
    // before supersede: g0001 satisfies enforcement (old context)
    const before = assertReviewArtifactEnforced({
      admission: REQ, cardId: "CARD", candidateIdentity: OLD_CANDIDATE, specDigest: OLD_SPEC, opts: { root },
    });
    assert.equal(before.ok, true);
    // supersede + converge to g0002
    createSuccessorReviewJob({
      cardId: "CARD", candidateIdentity: NEW_CANDIDATE, specId: "spec-1",
      specDigest: NEW_SPEC, predecessorJobId: g1.jobId,
    }, { root });
    // the current pointer is now g0002 REQUIRED — g0001 acceptance is gone
    const after = assertReviewArtifactEnforced({
      admission: REQ, cardId: "CARD", candidateIdentity: OLD_CANDIDATE, specDigest: OLD_SPEC, opts: { root },
    });
    assert.equal(after.ok, false);
    assert.match(after.reason, /state REQUIRED != ACCEPTED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successor runs the full lifecycle to a fresh ACCEPTED bound to the new context", () => {
  const root = tmpRoot();
  try {
    const g1 = makeAcceptedG0001(root);
    createSuccessorReviewJob({
      cardId: "CARD", candidateIdentity: NEW_CANDIDATE, specId: "spec-1",
      specDigest: NEW_SPEC, predecessorJobId: g1.jobId,
    }, { root });
    // full lifecycle on g0002
    advanceState("CARD", "REQUIRED", "PREPARED", { root });
    advanceState("CARD", "PREPARED", "RUNNING", { root });
    persistFindings({ cardId: "CARD", reviewerIdentity: REVIEWER, findings: [], summary: "g2 findings" }, { root });
    persistVerdict({ cardId: "CARD", reviewerIdentity: REVIEWER, verdict: "PASS", summary: "g2 verdict", recommendedNextAction: "STOP" }, { root });
    finalizePersisted({ cardId: "CARD" }, { root });
    const staged = [];
    const git = (args) => {
      if (args[0] === "add") { staged.push(args[1]); return ""; }
      if (args[0] === "diff" && args[1] === "--cached") return staged.join("\n");
      return "";
    };
    stageArtifacts({ cardId: "CARD", git }, { root });
    const r = acceptReviewJob({
      cardId: "CARD", implementerIdentity: IMPLEMENTER, authorizationSource: "controller:op",
      trustedReviewerIdentity: REVIEWER,
      recomputed: {
        candidateIdentity: NEW_CANDIDATE,
        specIdentity: { specId: "spec-1", specDigest: NEW_SPEC },
        stagedSet: ["CARD/review-job.json", "CARD/review-findings.g0002.json", "CARD/review-verdict.g0002.json"],
        repositoryVerified: true,
      },
    }, { root });
    assert.equal(r.ok, true, r.code);
    const job = readReviewJob("CARD", { root }).job;
    assert.equal(job.jobId, "CARD.g0002");
    assert.equal(job.state, "ACCEPTED");
    // enforcement with NEW context → ok; with OLD context → HOLD (drift)
    const okNew = assertReviewArtifactEnforced({
      admission: REQ, cardId: "CARD", candidateIdentity: NEW_CANDIDATE, specDigest: NEW_SPEC, opts: { root },
    });
    assert.equal(okNew.ok, true);
    const holdOld = assertReviewArtifactEnforced({
      admission: REQ, cardId: "CARD", candidateIdentity: OLD_CANDIDATE, specDigest: OLD_SPEC, opts: { root },
    });
    assert.equal(holdOld.ok, false);
    assert.match(holdOld.reason, /candidate drift/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrency fails closed: superseded-by-other successor creation is rejected", () => {
  const root = tmpRoot();
  try {
    const g1 = makeAcceptedG0001(root);
    // another party supersedes to a DIFFERENT successor first
    const s = supersede("CARD", "CARD.g9999", { root });
    assert.equal(s.ok, true);
    const r = createSuccessorReviewJob({
      cardId: "CARD", candidateIdentity: NEW_CANDIDATE, specId: "spec-1",
      specDigest: NEW_SPEC, predecessorJobId: g1.jobId,
    }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_JOB_SUPERSEEDED_BY_OTHER");
    // pointer unchanged
    assert.equal(readReviewJob("CARD", { root }).job.jobId, "CARD.g0001");
    assert.equal(readReviewJob("CARD", { root }).job.state, "SUPERSEDED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("crash-resume: pointer already SUPERSEDED by this successor → converge to g0002", () => {
  const root = tmpRoot();
  try {
    const g1 = makeAcceptedG0001(root);
    // simulate crash after supersede (before converge): pointer = g0001 SUPERSEDED
    supersede("CARD", "CARD.g0002", { root });
    const r = createSuccessorReviewJob({
      cardId: "CARD", candidateIdentity: NEW_CANDIDATE, specId: "spec-1",
      specDigest: NEW_SPEC, predecessorJobId: g1.jobId,
    }, { root });
    assert.equal(r.ok, true, r.code);
    assert.equal(r.job.jobId, "CARD.g0002");
    assert.equal(readReviewJob("CARD", { root }).job.jobId, "CARD.g0002");
    assert.equal(readReviewJob("CARD", { root }).job.state, "REQUIRED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idempotent: with predecessorJobId, re-invocation returns the existing successor", () => {
  const root = tmpRoot();
  try {
    const g1 = makeAcceptedG0001(root);
    const first = createSuccessorReviewJob({
      cardId: "CARD", candidateIdentity: NEW_CANDIDATE, specId: "spec-1",
      specDigest: NEW_SPEC, predecessorJobId: g1.jobId,
    }, { root });
    assert.equal(first.ok, true);
    const second = createSuccessorReviewJob({
      cardId: "CARD", candidateIdentity: NEW_CANDIDATE, specId: "spec-1",
      specDigest: NEW_SPEC, predecessorJobId: g1.jobId,
    }, { root });
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.job.jobId, "CARD.g0002");
    assert.equal(readReviewJob("CARD", { root }).job.jobId, "CARD.g0002");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation is monotonic: successor of successor → g0003", () => {
  const root = tmpRoot();
  try {
    const g1 = makeAcceptedG0001(root);
    const s2 = createSuccessorReviewJob({
      cardId: "CARD", candidateIdentity: NEW_CANDIDATE, specId: "spec-1",
      specDigest: NEW_SPEC, predecessorJobId: g1.jobId,
    }, { root });
    assert.equal(s2.ok, true);
    const s3 = createSuccessorReviewJob({
      cardId: "CARD", candidateIdentity: NEW_CANDIDATE, specId: "spec-1",
      specDigest: NEW_SPEC, predecessorJobId: s2.job.jobId,
    }, { root });
    assert.equal(s3.ok, true);
    assert.equal(s3.job.jobId, "CARD.g0003");
    assert.equal(s3.job.priorJobId, "CARD.g0002");
    assert.equal(s3.job.supersedes, "CARD.g0002");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HOLD predecessor cannot create a successor (fail closed)", () => {
  const root = tmpRoot();
  try {
    makeAcceptedG0001(root);
    // force HOLD via a direct schema-valid file write (updateReviewJob is not
    // exported; HOLD is a legal schema state).
    const jobPath = reviewJobPath("CARD", { root });
    const held = {
      schemaVersion: "autoloop.review-job/v1",
      lineageId: "CARD",
      jobId: "CARD.g0001",
      generation: 1,
      candidateIdentity: OLD_CANDIDATE,
      specId: "spec-1",
      specDigest: OLD_SPEC,
      state: "HOLD",
      stateVersion: 1,
    };
    mkdirSync(join(root, "CARD"), { recursive: true });
    writeFileSync(jobPath, JSON.stringify(held, null, 2) + "\n");
    const r = createSuccessorReviewJob({
      cardId: "CARD", candidateIdentity: NEW_CANDIDATE, specId: "spec-1",
      specDigest: NEW_SPEC, predecessorJobId: "CARD.g0001",
    }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_JOB_TERMINAL_HELD");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
