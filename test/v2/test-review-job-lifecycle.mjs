// test/v2/test-review-job-lifecycle.mjs
//
// AUTOLOOP-REVART-IMPL1 — review-job lifecycle tests (Group A/B).
// Zero provider, zero Pi, zero credential, zero network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createReviewJob,
  readReviewJob,
  advanceState,
  supersede,
  updateReviewJob,
  generationLabel,
  jobIdFor,
  findingsPath,
  verdictPath,
  REVIEW_JOB_STATES,
  allowedTransitions,
  ReviewJobError,
} from "../../src/governance/review-job.mjs";

const sha = (c, n) => c.repeat(n);

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "review-job-lifecycle-"));
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

function makeJob(root, generation = 1, extra = {}) {
  return createReviewJob({
    cardId: "CARD",
    generation,
    candidateIdentity: candidate(),
    specId: "spec-1",
    specDigest: sha("e", 64),
    ...extra,
  }, { root });
}

test("createReviewJob binds lineage/generation identity and defaults to REQUIRED", () => {
  const root = tmpRoot();
  try {
    const r = makeJob(root);
    assert.equal(r.ok, true);
    assert.equal(r.job.state, "REQUIRED");
    assert.equal(r.job.jobId, "CARD.g0001");
    assert.equal(r.job.lineageId, "CARD");
    assert.equal(r.job.generation, 1);
    assert.equal(r.job.stateVersion, 1);
    const read = readReviewJob("CARD", { root });
    assert.equal(read.ok, true);
    assert.equal(read.job.jobId, "CARD.g0001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation label and jobId are monotonic and zero-padded", () => {
  assert.equal(generationLabel(1), "g0001");
  assert.equal(generationLabel(42), "g0042");
  assert.equal(jobIdFor("CARD", 3), "CARD.g0003");
});

test("forward transitions REQUIRED→PREPARED→RUNNING are legal and durable", () => {
  const root = tmpRoot();
  try {
    makeJob(root);
    assert.equal(advanceState("CARD", "REQUIRED", "PREPARED", { root }).ok, true);
    assert.equal(advanceState("CARD", "PREPARED", "RUNNING", { root }).ok, true);
    const read = readReviewJob("CARD", { root });
    assert.equal(read.job.state, "RUNNING");
    assert.equal(read.job.stateVersion, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("illegal transition is rejected (no skipping REQUIRED→ACCEPTED)", () => {
  assert.throws(() => advanceState("CARD", "REQUIRED", "ACCEPTED", { root: "/nope" }), ReviewJobError);
  // SUPERSEDED and HOLD are reachable from any non-terminal; ACCEPTED only from STAGED.
  assert.ok(allowedTransitions("STAGED").includes("ACCEPTED"));
  assert.ok(!allowedTransitions("PERSISTED").includes("ACCEPTED"));
});

test("idempotent resume: advancing to the current state is a no-op success", () => {
  const root = tmpRoot();
  try {
    makeJob(root);
    advanceState("CARD", "REQUIRED", "PREPARED", { root });
    const again = advanceState("CARD", "REQUIRED", "PREPARED", { root });
    assert.equal(again.ok, true);
    assert.equal(again.alreadyInState, true);
    assert.equal(again.job.stateVersion, 2); // unchanged
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CAS: update with a stale stateVersion is rejected", () => {
  const root = tmpRoot();
  try {
    makeJob(root);
    advanceState("CARD", "REQUIRED", "PREPARED", { root });
    const r = updateReviewJob("CARD", { expectedStateVersion: 99, patch: { state: "RUNNING" } }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_JOB_STATE_VERSION_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exclusive-create: a second createReviewJob for the same lineage is rejected", () => {
  const root = tmpRoot();
  try {
    makeJob(root);
    assert.throws(() => makeJob(root), /exclusive create failed|JOURNAL_OUT_OF_ORDER/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supersession is terminal: a SUPERSEDED job cannot advance again", () => {
  const root = tmpRoot();
  try {
    makeJob(root, 1);
    const s = supersede("CARD", "CARD.g0002", { root });
    assert.equal(s.ok, true);
    assert.equal(s.job.state, "SUPERSEDED");
    const read = readReviewJob("CARD", { root });
    assert.equal(read.job.state, "SUPERSEDED");
    // advancing a superseded job must fail (it is no longer RUNNING, and cannot be anything but SUPERSEDED)
    const adv = advanceState("CARD", "REQUIRED", "PREPARED", { root });
    assert.equal(adv.ok, false);
    assert.equal(adv.code, "REVIEW_JOB_STATE_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ABA: a superseded generation cannot return to current", () => {
  const root = tmpRoot();
  try {
    makeJob(root, 1);
    supersede("CARD", "CARD.g0002", { root });
    // The only legal transitions out of SUPERSEDED are SUPERSEDED itself.
    assert.deepEqual(allowedTransitions("SUPERSEDED"), ["SUPERSEDED"]);
    assert.ok(!allowedTransitions("SUPERSEDED").includes("RUNNING"));
    assert.ok(!allowedTransitions("SUPERSEDED").includes("ACCEPTED"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact paths are deterministic and generation-scoped", () => {
  const root = tmpRoot();
  try {
    assert.equal(findingsPath("CARD", 3, { root }), join(root, "CARD", "review-findings.g0003.json"));
    assert.equal(verdictPath("CARD", 3, { root }), join(root, "CARD", "review-verdict.g0003.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical state set is exactly the frozen 11 states", () => {
  assert.deepEqual(REVIEW_JOB_STATES, [
    "REQUIRED", "PREPARED", "RUNNING", "FINDINGS_CAPTURED",
    "VERDICT_PRODUCED", "PERSISTED", "STAGED", "ACCEPTED",
    "DOWNSTREAM_AUTHORIZED", "SUPERSEDED", "HOLD",
  ]);
});
