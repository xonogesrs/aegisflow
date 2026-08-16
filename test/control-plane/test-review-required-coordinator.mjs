// test/control-plane/test-review-required-coordinator.mjs
//
// AUTOLOOP-REVART-LC1-B2 — mandatory acceptance T1 + T2:
//
// T1 — real coordinator path (coordinate -> executeSequentially ->
// runAdmittedGraph) with a review-required binding: implementation success ->
// REVIEW_PENDING, job materialized at the governed seam, unresolved review
// can never be terminal PASS, and the consumer gate reads the job at the
// authority-derived root (never cwd).
//
// T2 — durable checkpoint/resume identity: the binding participates in the
// frozen admission identity (fingerprint), the ledger checkpoint resumes
// cumulatively, and no duplicate job / silent path shift occurs across the
// restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { coordinate, executeSequentially } from "../../src/control-plane/coordinator.mjs";
import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import { admissionDigest } from "../../src/admission/admission-record.mjs";
import { buildConfigurationFingerprint } from "../../src/v2/checkpoint-bridge.mjs";
import { deriveLiveReviewBinding } from "../../src/governance/review-artifact-gate.mjs";
import { defaultGitRunner, gitTopLevel } from "../../src/governance/review-lifecycle.mjs";
import { readReviewJob, reviewJobPath } from "../../src/governance/review-job.mjs";
import { taskInput } from "./helpers.mjs";
import {
  makeGitRepo,
  projectBinding,
  makeReviewRequiredAdmission,
  makeSpyRunner,
  OUT_DIR_REL,
} from "../governance/review-lifecycle-fixture.mjs";

const cleanups = [];
test.after(() => {
  for (const d of cleanups) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const BASE_CFG = {
  maxRepairAttempts: 1,
  timeoutMs: 90000,
  toolPolicy: null,
  environmentAllowlist: null,
  expectedReviewerModel: null,
  runtime: { v: "test" },
  sourceHashes: null,
  persistenceFormatVersion: "1.0.0",
};

function fixture(tag) {
  const repo = makeGitRepo(tag); cleanups.push(repo);
  const { record, binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });
  const surface = mkdtempSync(join(tmpdir(), "revart-b2-surface-")); cleanups.push(surface);
  const repoRoot = gitTopLevel(repo);
  const jobRoot = dirname(resolve(repoRoot, OUT_DIR_REL));
  const liveReviewBinding = deriveLiveReviewBinding({
    git: defaultGitRunner(repoRoot),
    cwd: repoRoot,
    record,
    specId: binding.spec_id,
  });
  return { repo, repoRoot, record, binding, admission, surface, jobRoot, liveReviewBinding };
}

test("T1: coordinator + review-required binding E2E — REVIEW_PENDING, job at governed seam, never terminal PASS", async () => {
  const f = fixture("t1");
  const captured = [];
  const { plan } = coordinate({
    tasks: [taskInput("a", f.admission, {
      runnerOpts: { runner: makeSpyRunner(captured), reviewSurfaceDir: f.surface },
      cardId: f.binding.card_id,
      liveReviewBinding: f.liveReviewBinding,
    })],
    globalBudget: null,
  });
  assert.equal(plan.tasks[0].decision.recommendation, "RECOMMENDATION", JSON.stringify(plan.tasks[0].decision));

  const { ok, results } = await executeSequentially({ plan });
  assert.equal(ok, true);
  const res = results[0];
  assert.equal(res.dispatched, true);
  assert.equal(captured.length, 1);

  // implementation success -> REVIEW_PENDING (never terminal PASS)
  assert.equal(res.result.final, "REVIEW_PENDING", JSON.stringify(res.result, null, 1).slice(0, 600));
  // job materialized at the correct seam (inside runAdmittedGraph lifecycle)
  assert.equal(res.result.reviewJob.ok, true);
  assert.equal(res.result.reviewJob.created, true);
  assert.equal(res.result.reviewJob.jobId, `${f.binding.card_id}.g0001`);
  assert.ok(readFileSync(reviewJobPath(f.binding.card_id, { root: f.jobRoot }), "utf8").length > 0, "job persisted at the governed root");

  // unresolved review cannot become terminal PASS: consumer gate HOLDs on the
  // ACCEPTED requirement — and it FOUND the job at the authority-derived root
  // (the failure is the state, not a missing job).
  assert.equal(res.reviewArtifactEnforced, false);
  assert.ok(String(res.holdCode).includes("REVIEW_ARTIFACT"), res.holdCode);
  assert.ok(!String(res.reason).includes("REVIEW_JOB_MISSING"), `gate must find the job at the governed root: ${res.reason}`);
  assert.ok(String(res.reason).includes("state"), res.reason);
});

test("T2: durable checkpoint/resume — binding in frozen identity, cumulative resume, single job, no path shift", async () => {
  const f = fixture("t2");

  // The binding is part of the frozen admission identity: fingerprint is
  // stable for the same admission and changes if the binding changes.
  const fp1 = buildConfigurationFingerprint({ ...BASE_CFG, admissionFingerprint: admissionDigest(f.admission) });
  const fp2 = buildConfigurationFingerprint({ ...BASE_CFG, admissionFingerprint: admissionDigest(f.admission) });
  assert.equal(fp1, fp2);
  const refrozen = await (async () => {
    const { freezeAdmission } = await import("../../src/admission/admission-record.mjs");
    return freezeAdmission({
      ...f.admission,
      extensions: { ...f.admission.extensions, review_closeout: { ...f.admission.extensions.review_closeout, card_title: "MUTATED" } },
    });
  })();
  const fp3 = buildConfigurationFingerprint({ ...BASE_CFG, admissionFingerprint: admissionDigest(refrozen) });
  assert.notEqual(fp1, fp3, "binding mutation must change the durable identity (no silent resume)");

  // Run 1: full lifecycle -> REVIEW_PENDING + job g0001 + budget checkpoint.
  const calls = [];
  const r1 = await runAdmittedGraph({ admission: f.admission, runner: makeSpyRunner(calls), reviewSurfaceDir: f.surface });
  assert.equal(r1.final, "REVIEW_PENDING");
  assert.equal(r1.reviewJob.created, true);
  const checkpoint = r1.budget?.checkpoint;
  assert.ok(checkpoint, "checkpoint must be produced for durable resume");

  // Run 2: durable-style resume with the checkpoint — cumulative ledger,
  // REVIEW_PENDING again, SAME single job (no duplicate), state untouched.
  const calls2 = [];
  const r2 = await runAdmittedGraph({
    admission: f.admission,
    runner: makeSpyRunner(calls2),
    reviewSurfaceDir: f.surface,
    budget: { checkpointState: checkpoint },
  });
  assert.equal(r2.final, "REVIEW_PENDING", JSON.stringify(r2, null, 1).slice(0, 500));
  assert.equal(r2.reviewJob.reused, true, "resume must verify and reuse the existing job");
  assert.equal(r2.budget?.dimensions?.node_execution_count?.consumed, 2, "ledger resumes cumulatively (no reset)");
  const job = readReviewJob(f.binding.card_id, { root: f.jobRoot });
  assert.equal(job.ok, true);
  assert.equal(job.job.jobId, `${f.binding.card_id}.g0001`);
  assert.equal(job.job.generation, 1);
  assert.equal(JSON.parse(readFileSync(job.path, "utf8")).stateVersion, 1, "exactly one job, no rewrite");

  // No silent path shift: the job stayed at the authority-derived root.
  assert.ok(job.path.startsWith(f.jobRoot + "/"), job.path);
});
