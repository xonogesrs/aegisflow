// test/governance/test-review-artifact-gate.mjs
//
// REVIEW-ROUTING-R1 + R1A — adversarial acceptance for the mandatory
// review-artifact enforcement gate + live candidate/spec binding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertReviewArtifactEnforced,
  reviewRequired,
  REVIEW_ARTIFACT_HOLD,
} from "../../src/governance/review-artifact-gate.mjs";

const REQ_INDEPENDENT = { review_policy: { strength: "independent" } };
const REQ_EXTERNAL = { review_policy: { strength: "external" } };
const NOT_REQUIRED_DETERMINISTIC = { review_policy: { strength: "deterministic" } };
const NOT_REQUIRED_NONE = { review_policy: { strength: "none" } };
const NOT_REQUIRED_EMPTY = {};

const CANONICAL_CANDIDATE = {
  changedTreeIdentity: "a".repeat(64),
  patchSha256: "b".repeat(64),
  currentHead: "c".repeat(40),
  baseHead: "d".repeat(40),
  repository: "repo",
  branch: "branch",
};
const CANONICAL_SPEC = "e".repeat(64);

function writeJob(root, cardId, overrides = {}) {
  const dir = join(root, cardId);
  mkdirSync(dir, { recursive: true });
  const generation = overrides.generation ?? 1;
  const job = {
    schemaVersion: "autoloop.review-job/v1",
    lineageId: cardId,
    jobId: `${cardId}.g${String(generation).padStart(4, "0")}`,
    generation,
    candidateIdentity: { ...CANONICAL_CANDIDATE },
    specId: "spec",
    specDigest: CANONICAL_SPEC,
    state: "ACCEPTED",
    stateVersion: 1,
    ...overrides,
  };
  if (overrides.generation !== undefined && overrides.jobId === undefined) {
    job.jobId = `${job.lineageId}.g${String(generation).padStart(4, "0")}`;
  }
  writeFileSync(join(dir, "review-job.json"), JSON.stringify(job));
}

function freshRoot() {
  return mkdtempSync(join(tmpdir(), "raj-gate-"));
}

function gateAt(root, {
  admission = REQ_INDEPENDENT,
  cardId = "CARD-A",
  candidateIdentity = CANONICAL_CANDIDATE,
  specDigest = CANONICAL_SPEC,
  omitLive = false,
  ...rest
} = {}) {
  return assertReviewArtifactEnforced({
    admission,
    cardId,
    candidateIdentity: omitLive ? null : candidateIdentity,
    specDigest: omitLive ? null : specDigest,
    opts: { root },
    ...rest,
  });
}

test("reviewRequired derives only from review_policy.strength", () => {
  assert.equal(reviewRequired(REQ_INDEPENDENT), true);
  assert.equal(reviewRequired(REQ_EXTERNAL), true);
  assert.equal(reviewRequired(NOT_REQUIRED_DETERMINISTIC), false);
  assert.equal(reviewRequired(NOT_REQUIRED_NONE), false);
  assert.equal(reviewRequired(NOT_REQUIRED_EMPTY), false);
});

test("A/F. NON-review-required task → unaffected (no artifact, no live identity needed)", () => {
  const root = freshRoot();
  try {
    for (const admission of [NOT_REQUIRED_DETERMINISTIC, NOT_REQUIRED_NONE, NOT_REQUIRED_EMPTY]) {
      const r = gateAt(root, { admission, cardId: null, omitLive: true });
      assert.equal(r.ok, true);
      assert.equal(r.reviewRequired, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B. review-required + ACCEPTED + matching live candidate/spec → verdict accepted", () => {
  const root = freshRoot();
  try {
    writeJob(root, "CARD-A");
    const r = gateAt(root, { admission: REQ_INDEPENDENT, cardId: "CARD-A" });
    assert.equal(r.ok, true);
    assert.equal(r.reviewRequired, true);
    assert.equal(r.job.state, "ACCEPTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C. review-required + console PASS only (no artifact) → HOLD", () => {
  const root = freshRoot();
  try {
    const r = gateAt(root, { admission: REQ_INDEPENDENT, cardId: "CARD-A" });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, REVIEW_ARTIFACT_HOLD);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D. review-required + missing review-job → HOLD", () => {
  const root = freshRoot();
  try {
    const r = gateAt(root, { admission: REQ_EXTERNAL, cardId: "CARD-A" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /REVIEW_JOB_MISSING/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E. valid artifact for wrong card → HOLD", () => {
  const root = freshRoot();
  try {
    writeJob(root, "CARD-A");
    const r = gateAt(root, { admission: REQ_INDEPENDENT, cardId: "CARD-B" });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, REVIEW_ARTIFACT_HOLD);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("G. artifact exists but not ACCEPTED → HOLD", () => {
  const root = freshRoot();
  try {
    writeJob(root, "CARD-A", { state: "STAGED" });
    const r = gateAt(root, { admission: REQ_INDEPENDENT, cardId: "CARD-A" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /state STAGED != ACCEPTED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H. stale / superseded artifact → HOLD", () => {
  const root = freshRoot();
  try {
    writeJob(root, "CARD-A", { supersededBy: "CARD-A.g0002" });
    const r = gateAt(root, { admission: REQ_INDEPENDENT, cardId: "CARD-A" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /superseded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I. forged card association (lineageId mismatch) → HOLD", () => {
  const root = freshRoot();
  try {
    writeJob(root, "CARD-A", { lineageId: "CARD-X", jobId: "CARD-X.g0001" });
    const r = gateAt(root, { admission: REQ_INDEPENDENT, cardId: "CARD-A" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /lineageId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("J. duplicate / ambiguous review identity (forged jobId) → HOLD", () => {
  const root = freshRoot();
  try {
    writeJob(root, "CARD-A", { jobId: "OTHER.g0001" });
    const r = gateAt(root, { admission: REQ_INDEPENDENT, cardId: "CARD-A" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /jobId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── R1A: live candidate/spec binding at verdict consumption ──────────────

test("R1A-E. review-required + omitted live identity → HOLD", () => {
  const root = freshRoot();
  try {
    writeJob(root, "CARD-A");
    const r = gateAt(root, { admission: REQ_INDEPENDENT, cardId: "CARD-A", omitLive: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /live (candidate identity|spec digest) missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R1A-B. accepted review + candidate mutated after acceptance → HOLD", () => {
  const root = freshRoot();
  try {
    writeJob(root, "CARD-A");
    const mutated = { ...CANONICAL_CANDIDATE, patchSha256: "f".repeat(64) };
    const r = gateAt(root, { admission: REQ_INDEPENDENT, cardId: "CARD-A", candidateIdentity: mutated });
    assert.equal(r.ok, false);
    assert.match(r.reason, /candidate drift/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R1A-C. accepted review + spec mutated after acceptance → HOLD", () => {
  const root = freshRoot();
  try {
    writeJob(root, "CARD-A");
    const r = gateAt(root, { admission: REQ_INDEPENDENT, cardId: "CARD-A", specDigest: "0".repeat(64) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /spec drift/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R1A-D. accepted review + both candidate and spec mutated → HOLD", () => {
  const root = freshRoot();
  try {
    writeJob(root, "CARD-A");
    const mutated = { ...CANONICAL_CANDIDATE, currentHead: "9".repeat(40) };
    const r = gateAt(root, { admission: REQ_INDEPENDENT, cardId: "CARD-A", candidateIdentity: mutated, specDigest: "1".repeat(64) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /candidate drift/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
