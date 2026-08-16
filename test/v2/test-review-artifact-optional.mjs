// test/v2/test-review-artifact-optional.mjs
//
// AUTOLOOP-REVART-IMPL1 — the load-bearing artifact-optional tests.
//
// Proves the first-level invariant:
//   "Required review artifacts are lifecycle-mandated outputs, not optional
//    agent behavior. No artifact, no state advancement."
//
// Zero provider, zero Pi, zero credential, zero network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createReviewJob,
  readReviewJob,
  advanceState,
  allowedTransitions,
  findingsPath,
  verdictPath,
} from "../../src/governance/review-job.mjs";
import {
  persistFindings,
  persistVerdict,
} from "../../src/governance/review-job-writeback.mjs";

const sha = (c, n) => c.repeat(n);

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "review-job-optional-"));
}

function candidate() {
  return {
    changedTreeIdentity: sha("a", 64),
    patchSha256: sha("b", 64),
    currentHead: sha("c", 40),
    baseHead: sha("d", 40),
    repository: "repo:test",
    branch: "main",
  };
}

function makeRunningJob(root) {
  createReviewJob({
    cardId: "CARD",
    generation: 1,
    candidateIdentity: candidate(),
    specId: "spec-1",
    specDigest: sha("e", 64),
  }, { root });
  advanceState("CARD", "REQUIRED", "PREPARED", { root });
  advanceState("CARD", "PREPARED", "RUNNING", { root });
}

test("T-A1 — session-only PASS: reviewer verdict in session output alone cannot reach ACCEPTED", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    // Reviewer "returns PASS" — but nothing is persisted. The lifecycle must not advance.
    const job = readReviewJob("CARD", { root }).job;
    assert.equal(job.state, "RUNNING");
    assert.notEqual(job.state, "ACCEPTED");
    assert.equal(job.verdictDigest, undefined);
    // No verdict artifact exists at the canonical path.
    assert.equal(existsSync(verdictPath("CARD", 1, { root })), false);
    // ACCEPTED is only reachable via STAGED; from RUNNING it is illegal.
    assert.ok(!allowedTransitions("RUNNING").includes("ACCEPTED"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T-A2 — session-only findings are NON_AUTHORITATIVE", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    // Findings exist only in "session output" — not persisted. Job stays RUNNING.
    const job = readReviewJob("CARD", { root }).job;
    assert.equal(job.state, "RUNNING");
    assert.equal(job.findingsDigest, undefined);
    assert.equal(existsSync(findingsPath("CARD", 1, { root })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T-A3 — reviewer writes nothing: lifecycle persists required artifact itself or stays incomplete", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    // With NO reviewer file and NO lifecycle persistence, the job cannot complete.
    assert.equal(readReviewJob("CARD", { root }).job.state, "RUNNING");
    // The lifecycle-owned path persists the artifact from captured content —
    // here that is the only thing that advances the state.
    const r = persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [], summary: "captured" }, { root });
    assert.equal(r.ok, true);
    assert.equal(readReviewJob("CARD", { root }).job.state, "FINDINGS_CAPTURED");
    assert.equal(existsSync(findingsPath("CARD", 1, { root })), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T-A4 — reviewer-invented path is ignored for authority", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    // Reviewer writes a plausible verdict to an arbitrary path.
    const invented = join(root, "somewhere", "else", "my-verdict.json");
    mkdirSync(join(root, "somewhere", "else"), { recursive: true });
    writeFileSync(invented, JSON.stringify({ verdict: "PASS" }), { flag: "w" });
    // The lifecycle only reads the canonical path — the invented file has no effect.
    const job = readReviewJob("CARD", { root }).job;
    assert.equal(job.state, "RUNNING");
    assert.equal(job.verdictDigest, undefined);
    assert.equal(existsSync(verdictPath("CARD", 1, { root })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T-A5 — crash after semantic output: recovery uses lifecycle-owned durable state only", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    // Reviewer produced semantic content then "crashed" before persistence.
    // Simulate recovery: the durable job is still RUNNING (no artifact).
    assert.equal(readReviewJob("CARD", { root }).job.state, "RUNNING");
    // Recovery re-runs the writeback gate with the captured content.
    const r = persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [{ findingId: "f1", subject: "s", description: "d", recommendedDisposition: "fix" }], summary: "recovered" }, { root });
    assert.equal(r.ok, true);
    assert.equal(readReviewJob("CARD", { root }).job.state, "FINDINGS_CAPTURED");
    // No session transcript was needed: the durable job + artifact are self-contained.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verdict cannot be persisted without findings artifact (no-artifact → no verdict)", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    const r = persistVerdict({ cardId: "CARD", reviewerIdentity: "reviewer:ext", verdict: "PASS" }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_JOB_STATE_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
