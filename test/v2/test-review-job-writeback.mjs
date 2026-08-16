// test/v2/test-review-job-writeback.mjs
//
// AUTOLOOP-REVART-IMPL1 — review-job writeback gate tests (Group B).
// Zero provider, zero Pi, zero credential, zero network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createReviewJob,
  readReviewJob,
  advanceState,
  supersede,
  acceptReviewJob,
  findingsPath,
  verdictPath,
} from "../../src/governance/review-job.mjs";
import {
  persistFindings,
  persistVerdict,
  finalizePersisted,
  stageArtifacts,
  writeImmutableExclusive,
} from "../../src/governance/review-job-writeback.mjs";

const sha = (c, n) => c.repeat(n);

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "review-job-writeback-"));
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

test("findings persistence: RUNNING → FINDINGS_CAPTURED with digest bound from persisted bytes", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    const r = persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [{ findingId: "f1", subject: "s", description: "d", recommendedDisposition: "fix" }], summary: "findings summary" }, { root });
    assert.equal(r.ok, true);
    assert.match(r.findingsDigest, /^[0-9a-f]{64}$/);
    const job = readReviewJob("CARD", { root }).job;
    assert.equal(job.state, "FINDINGS_CAPTURED");
    assert.equal(job.findingsDigest, r.findingsDigest);
    // persisted bytes digest must equal the bound digest
    const bytes = readFileSync(findingsPath("CARD", 1, { root }), "utf8");
    assert.equal(createHash("sha256").update(bytes, "utf8").digest("hex"), r.findingsDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findings schema is strict: authority-bearing unknown fields are rejected", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    const r = persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [{ findingId: "f1", subject: "s", description: "d", recommendedDisposition: "fix", trusted: true }], summary: "x" }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_FINDINGS_SCHEMA_INVALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verdict persistence: FINDINGS_CAPTURED → VERDICT_PRODUCED, bound to findingsDigest", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
    const v = persistVerdict({ cardId: "CARD", reviewerIdentity: "reviewer:ext", verdict: "PASS", summary: "v", recommendedNextAction: "STOP" }, { root });
    assert.equal(v.ok, true);
    assert.match(v.verdictDigest, /^[0-9a-f]{64}$/);
    const job = readReviewJob("CARD", { root }).job;
    assert.equal(job.state, "VERDICT_PRODUCED");
    assert.equal(job.verdictDigest, v.verdictDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verdict without prior findings is rejected", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    const r = persistVerdict({ cardId: "CARD", reviewerIdentity: "reviewer:ext", verdict: "PASS" }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_JOB_STATE_MISMATCH"); // must be FINDINGS_CAPTURED
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verdict schema rejects non-authoritative enum values", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
    const r = persistVerdict({ cardId: "CARD", reviewerIdentity: "reviewer:ext", verdict: "REPLAN", summary: "v" }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_VERDICT_SCHEMA_INVALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findings digest mismatch blocks verdict (artifact tampered after persist)", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
    // tamper the persisted findings bytes
    const fpath = findingsPath("CARD", 1, { root });
    writeFileSync(fpath, readFileSync(fpath, "utf8") + "\nTAMPERED\n");
    const r = persistVerdict({ cardId: "CARD", reviewerIdentity: "reviewer:ext", verdict: "PASS" }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_FINDINGS_DIGEST_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalizePersisted: VERDICT_PRODUCED → PERSISTED after re-verifying both artifacts", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
    persistVerdict({ cardId: "CARD", reviewerIdentity: "reviewer:ext", verdict: "PASS", summary: "v", recommendedNextAction: "STOP" }, { root });
    const r = finalizePersisted({ cardId: "CARD" }, { root });
    assert.equal(r.ok, true);
    assert.equal(readReviewJob("CARD", { root }).job.state, "PERSISTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay: same bytes idempotent, different bytes rejected", () => {
  const root = tmpRoot();
  try {
    const p = join(root, "immutable.json");
    const bytes = '{"x":1}\n';
    const first = writeImmutableExclusive(p, bytes);
    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);
    const second = writeImmutableExclusive(p, bytes);
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    const third = writeImmutableExclusive(p, '{"x":2}\n');
    assert.equal(third.ok, false);
    assert.equal(third.code, "REVIEW_ARTIFACT_CONFLICTING_REPLAY");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging: PERSISTED → STAGED with exact allowlist (no AUTH1 candidate)", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
    persistVerdict({ cardId: "CARD", reviewerIdentity: "reviewer:ext", verdict: "PASS", summary: "v", recommendedNextAction: "STOP" }, { root });
    finalizePersisted({ cardId: "CARD" }, { root });
    const staged = [];
    const git = (args) => {
      if (args[0] === "add") { staged.push(args[1]); return ""; }
      if (args[0] === "diff" && args[1] === "--cached") { return staged.join("\n"); }
      return "";
    };
    const r = stageArtifacts({ cardId: "CARD", git }, { root });
    assert.equal(r.ok, true);
    assert.equal(readReviewJob("CARD", { root }).job.state, "STAGED");
    // only the 3 lifecycle artifacts were staged, nothing else
    assert.equal(staged.length, 3);
    assert.ok(staged.every((p) => p.includes("CARD") && (p.endsWith("review-job.json") || p.includes("review-findings.g") || p.includes("review-verdict.g"))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging rejects unexpected staged material", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
    persistVerdict({ cardId: "CARD", reviewerIdentity: "reviewer:ext", verdict: "PASS", summary: "v", recommendedNextAction: "STOP" }, { root });
    finalizePersisted({ cardId: "CARD" }, { root });
    const git = (args) => {
      if (args[0] === "add") return "";
      if (args[0] === "diff" && args[1] === "--cached") return "src/autoloop.mjs\n" + verdictPath("CARD", 1, { root }) + "\n";
      return "";
    };
    const r = stageArtifacts({ cardId: "CARD", git }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_STAGING_UNEXPECTED_MATERIAL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale generation write is rejected (SUPERSEDED job cannot persist findings)", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    // supersede the job, then attempt to write findings
    supersede("CARD", "CARD.g0002", { root });
    const r = persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_JOB_STALE_OR_HELD");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeStagedJob(root, verdict = "PASS", reviewer = "reviewer:ext") {
  makeRunningJob(root);
  persistFindings({ cardId: "CARD", reviewerIdentity: reviewer, findings: [], summary: "f" }, { root });
  persistVerdict({ cardId: "CARD", reviewerIdentity: reviewer, verdict, summary: "v", recommendedNextAction: "STOP" }, { root });
  finalizePersisted({ cardId: "CARD" }, { root });
  const staged = [];
  const git = (args) => {
    if (args[0] === "add") { staged.push(args[1]); return ""; }
    if (args[0] === "diff" && args[1] === "--cached") return staged.join("\n");
    return "";
  };
  stageArtifacts({ cardId: "CARD", git }, { root });
}

test("acceptReviewJob: STAGED → ACCEPTED only with PASS + independent reviewer", () => {
  const root = tmpRoot();
  try {
    makeStagedJob(root);
    const r = acceptReviewJob({ cardId: "CARD", implementerIdentity: "executor:impl", authorizationSource: "controller:op" }, { root });
    assert.equal(r.ok, true);
    assert.equal(readReviewJob("CARD", { root }).job.state, "ACCEPTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptReviewJob rejects a non-PASS verdict", () => {
  const root = tmpRoot();
  try {
    makeStagedJob(root, "HOLD");
    const r = acceptReviewJob({ cardId: "CARD", authorizationSource: "controller:op" }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_VERDICT_NOT_PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptReviewJob rejects agent:self reviewer", () => {
  const root = tmpRoot();
  try {
    makeStagedJob(root, "PASS", "agent:reviewer");
    const r = acceptReviewJob({ cardId: "CARD", authorizationSource: "controller:op" }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_SELF_DECLARED_REVIEWER");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptReviewJob rejects reviewer == implementer", () => {
  const root = tmpRoot();
  try {
    makeStagedJob(root, "PASS", "executor:impl");
    const r = acceptReviewJob({ cardId: "CARD", implementerIdentity: "executor:impl", authorizationSource: "controller:op" }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_SELF_DECLARED_REVIEWER");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptReviewJob rejects before STAGED (unstaged → no ACCEPTED)", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
    persistVerdict({ cardId: "CARD", reviewerIdentity: "reviewer:ext", verdict: "PASS", summary: "v", recommendedNextAction: "STOP" }, { root });
    finalizePersisted({ cardId: "CARD" }, { root }); // PERSISTED, not STAGED
    const r = acceptReviewJob({ cardId: "CARD", authorizationSource: "controller:op" }, { root });
    assert.equal(r.ok, false);
    assert.equal(r.code, "REVIEW_JOB_STATE_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Group D integration: delivery binding + downstream authorization ────

import { buildReviewJobDeliveryProjection, deliverAcceptedReviewJob } from "../../src/governance/review-bundle.mjs";

function makeAcceptedJob(root) {
  makeStagedJob(root, "PASS", "reviewer:ext");
  const r = acceptReviewJob({ cardId: "CARD", implementerIdentity: "executor:impl", authorizationSource: "controller:op" }, { root });
  assert.equal(r.ok, true);
  return r.job;
}

test("D-A1 happy path: ACCEPTED → delivery projection → DOWNSTREAM_AUTHORIZED", () => {
  const root = tmpRoot();
  try {
    makeAcceptedJob(root);
    const d = deliverAcceptedReviewJob({ cardId: "CARD", root });
    assert.equal(d.ok, true);
    assert.equal(d.job.state, "DOWNSTREAM_AUTHORIZED");
    assert.equal(d.delivery.jobId, "CARD.g0001");
    assert.equal(d.delivery.generation, 1);
    assert.match(d.delivery.findingsDigest, /^[0-9a-f]{64}$/);
    assert.match(d.delivery.verdictDigest, /^[0-9a-f]{64}$/);
    assert.equal(d.delivery.candidateIdentity.changedTreeIdentity, "a".repeat(64));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D-A3 delivery rejects non-ACCEPTED (PERSISTED cannot publish downstream)", () => {
  const root = tmpRoot();
  try {
    makeRunningJob(root);
    persistFindings({ cardId: "CARD", reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
    persistVerdict({ cardId: "CARD", reviewerIdentity: "reviewer:ext", verdict: "PASS", summary: "v", recommendedNextAction: "STOP" }, { root });
    finalizePersisted({ cardId: "CARD" }, { root }); // PERSISTED, not ACCEPTED
    const d = deliverAcceptedReviewJob({ cardId: "CARD", root });
    assert.equal(d.ok, false);
    assert.equal(d.code, "REVIEW_JOB_NOT_ACCEPTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D-A9 delivery is idempotent after DOWNSTREAM_AUTHORIZED", () => {
  const root = tmpRoot();
  try {
    makeAcceptedJob(root);
    assert.equal(deliverAcceptedReviewJob({ cardId: "CARD", root }).ok, true);
    const again = deliverAcceptedReviewJob({ cardId: "CARD", root });
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);
    assert.equal(again.job.state, "DOWNSTREAM_AUTHORIZED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D-A10 missing canonical artifact after ACCEPTED claim blocks downstream publication", () => {
  const root = tmpRoot();
  try {
    makeAcceptedJob(root);
    // delete the verdict artifact after ACCEPTED
    rmSync(verdictPath("CARD", 1, { root }));
    const d = deliverAcceptedReviewJob({ cardId: "CARD", root });
    assert.equal(d.ok, false);
    assert.equal(d.code, "REVIEW_ARTIFACT_MISSING");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D-A5 delivery rejects digest substitution (verdict tampered after ACCEPTED)", () => {
  const root = tmpRoot();
  try {
    makeAcceptedJob(root);
    const vp = verdictPath("CARD", 1, { root });
    writeFileSync(vp, readFileSync(vp, "utf8") + "\nTAMPERED\n");
    const d = deliverAcceptedReviewJob({ cardId: "CARD", root });
    assert.equal(d.ok, false);
    assert.equal(d.code, "REVIEW_VERDICT_DIGEST_MISMATCH");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
