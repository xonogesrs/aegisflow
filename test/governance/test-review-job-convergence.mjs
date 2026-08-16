// test/governance/test-review-job-convergence.mjs
//
// AUTOLOOP-REVART-LC1-B2 — review-job materialization + lifecycle identity
// chain (B2-1..B2-3, B2-7) and the negative matrix N1-N12 / T4.
//
// Governed job root (B2-2 LOCKED): root = dirname(resolved out_dir) — NEVER
// process.cwd(). ensureCurrentReviewJob is create-or-verify-or-HOLD; it
// never replaces a conflicting job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import {
  REVIEW_LIFECYCLE_HOLDS,
  ensureCurrentReviewJob,
  gitTopLevel,
  buildLifecycleIdentity,
} from "../../src/governance/review-lifecycle.mjs";
import {
  readReviewJob,
  reviewJobPath,
  advanceState,
  updateReviewJob,
  acceptReviewJob,
} from "../../src/governance/review-job.mjs";
import { readCloseoutState } from "../../src/governance/closeout-state.mjs";
import { reviewCloseoutBindingDigest } from "../../src/governance/lifecycle-authorization.mjs";
import { assertProductionAdmission, PRODUCTION_GATE_HOLDS } from "../../src/admission/admission-gate.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import {
  makeGitRepo,
  projectBinding,
  makeReviewRequiredAdmission,
  makeSpyRunner,
  OUT_DIR_REL,
} from "./review-lifecycle-fixture.mjs";

const H = REVIEW_LIFECYCLE_HOLDS;
const cleanups = [];
test.after(() => {
  for (const d of cleanups) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

async function boot({ tag, tamper = false } = {}) {
  const repo = makeGitRepo(tag ?? "conv"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });
  const surface = mkdtempSync(join(tmpdir(), "revart-b2-surface-")); cleanups.push(surface);
  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: makeSpyRunner(calls), reviewSurfaceDir: surface });
  assert.equal(r.final, "REVIEW_PENDING", JSON.stringify(r, null, 1).slice(0, 500));
  assert.equal(r.reviewJob.ok, true, "B2: pending review must materialize a governed job");
  const repoRoot = gitTopLevel(repo);
  const statePath = resolve(repoRoot, OUT_DIR_REL, "closeout-state.json");
  const root = dirname(resolve(repoRoot, OUT_DIR_REL));
  return { repo, repoRoot, binding, admission, surface, statePath, root, r, calls };
}

function jobFixture({ repoRoot, binding, statePath, admission }) {
  return { admission, binding, statePath, repoRoot };
}

test("N1: absent job -> exactly-one governed creation; re-ensure -> RESUME (idempotent)", async () => {
  const f = await boot({ tag: "n1" });
  const job = readReviewJob(f.binding.card_id, { root: f.root });
  assert.equal(job.ok, true);
  assert.equal(job.job.jobId, `${f.binding.card_id}.g0001`);
  assert.equal(job.job.generation, 1);
  assert.equal(job.job.state, "REQUIRED");
  assert.equal(job.job.lineageId, f.binding.card_id);
  assert.equal(job.path, reviewJobPath(f.binding.card_id, { root: f.root }));

  // lifecycle identity chain (B2-3) matches the persisted state + admission.
  const st = readCloseoutState(f.statePath);
  const expected = buildLifecycleIdentity({
    admission: f.admission,
    binding: f.binding,
    resolvedOutDir: st.state.outDir,
    baselineContentDigest: st.state.baseline.contentDigest,
  });
  assert.deepEqual(job.job.lifecycleIdentity, expected);
  assert.equal(job.job.lifecycleIdentity.admissionId, f.admission.admission_id);
  assert.equal(job.job.lifecycleIdentity.bindingDigest, reviewCloseoutBindingDigest(f.binding));

  // Idempotent re-ensure (B2-7B): same job, no duplicate.
  const again = await ensureCurrentReviewJob(jobFixture(f));
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.reused, true);
  assert.equal(again.job.jobId, job.job.jobId);
  const files = readFileSync(again.path, "utf8");
  assert.equal(JSON.parse(files).stateVersion, 1, "no rewrite, no second mint");
});

test("N12: review pending -> never terminal PASS", async () => {
  const f = await boot({ tag: "n12" });
  assert.notEqual(f.r.final, "PASS");
  assert.equal(f.r.reviewJob.state, "REQUIRED");
});

test("N2: conflicting/legacy job (no lifecycleIdentity) -> HOLD / REVIEW_JOB_BINDING_DRIFT", async () => {
  const f = await boot({ tag: "n2" });
  const jobPath = reviewJobPath(f.binding.card_id, { root: f.root });
  // Replace the governed job with a schema-valid legacy job (orchestrator-
  // style, no lifecycleIdentity block).
  const legacy = JSON.parse(readFileSync(jobPath, "utf8"));
  delete legacy.lifecycleIdentity;
  writeFileSync(jobPath, JSON.stringify(legacy, null, 2) + "\n", "utf8");
  const r = await ensureCurrentReviewJob(jobFixture(f));
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, H.JOB_BINDING_DRIFT);
  assert.ok(r.reason.includes("lifecycleIdentity"), r.reason);
});

test("N4: job lifecycleIdentity.outDir mismatch -> HOLD / REVIEW_JOB_BINDING_DRIFT", async () => {
  const f = await boot({ tag: "n4" });
  const jobPath = reviewJobPath(f.binding.card_id, { root: f.root });
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  job.lifecycleIdentity = { ...job.lifecycleIdentity, outDir: "/elsewhere/out" };
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n", "utf8");
  const r = await ensureCurrentReviewJob(jobFixture(f));
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, H.JOB_BINDING_DRIFT);
  assert.ok(r.reason.includes("outDir"), r.reason);
});

test("N5: job lifecycleIdentity.admissionId mismatch -> HOLD / REVIEW_JOB_BINDING_DRIFT", async () => {
  const f = await boot({ tag: "n5" });
  const jobPath = reviewJobPath(f.binding.card_id, { root: f.root });
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  job.lifecycleIdentity = { ...job.lifecycleIdentity, admissionId: "f".repeat(64) };
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n", "utf8");
  const r = await ensureCurrentReviewJob(jobFixture(f));
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, H.JOB_BINDING_DRIFT);
  assert.ok(r.reason.includes("admissionId"), r.reason);
});

test("N6: job lifecycleIdentity.sourceAuthorityDigest mismatch -> HOLD / REVIEW_JOB_BINDING_DRIFT", async () => {
  const f = await boot({ tag: "n6" });
  const jobPath = reviewJobPath(f.binding.card_id, { root: f.root });
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  job.lifecycleIdentity = { ...job.lifecycleIdentity, sourceAuthorityDigest: "e".repeat(64) };
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n", "utf8");
  const r = await ensureCurrentReviewJob(jobFixture(f));
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, H.JOB_BINDING_DRIFT);
  assert.ok(r.reason.includes("sourceAuthorityDigest"), r.reason);
});

test("N7: job specDigest mismatch -> HOLD / REVIEW_JOB_SPEC_DRIFT; live spec mutation also HOLDs", async () => {
  const f = await boot({ tag: "n7" });
  // (a) tampered persisted spec digest
  const jobPath = reviewJobPath(f.binding.card_id, { root: f.root });
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  job.specDigest = "d".repeat(64);
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n", "utf8");
  const r1 = await ensureCurrentReviewJob(jobFixture(f));
  assert.equal(r1.ok, false);
  assert.equal(r1.holdCode, H.JOB_SPEC_DRIFT);

  // (b) spec CONTENT changed after admission (live digest != frozen binding)
  const specAbs = resolve(f.repoRoot, f.binding.spec_path);
  writeFileSync(specAbs, "# mutated spec\n", "utf8");
  const r2 = await ensureCurrentReviewJob({ ...jobFixture(f), ...{} });
  assert.equal(r2.ok, false);
  assert.equal(r2.holdCode, H.JOB_SPEC_DRIFT);
  assert.ok(r2.reason.includes("frozen binding.spec_digest"), r2.reason);
});

test("N8: job lifecycleIdentity.baselineContentDigest mismatch -> HOLD / REVIEW_JOB_BINDING_DRIFT", async () => {
  const f = await boot({ tag: "n8" });
  const jobPath = reviewJobPath(f.binding.card_id, { root: f.root });
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  job.lifecycleIdentity = { ...job.lifecycleIdentity, baselineContentDigest: "c".repeat(64) };
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n", "utf8");
  const r = await ensureCurrentReviewJob(jobFixture(f));
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, H.JOB_BINDING_DRIFT);
  assert.ok(r.reason.includes("baselineContentDigest"), r.reason);
});

test("N9: job lineageId mismatch -> HOLD / REVIEW_JOB_BINDING_DRIFT", async () => {
  const f = await boot({ tag: "n9" });
  const jobPath = reviewJobPath(f.binding.card_id, { root: f.root });
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  job.lineageId = "OTHER-CARD";
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n", "utf8");
  const r = await ensureCurrentReviewJob(jobFixture(f));
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, H.JOB_BINDING_DRIFT);
  assert.ok(r.reason.includes("lineageId"), r.reason);
});

test("N11: job candidate no longer matches live state -> HOLD / REVIEW_JOB_CANDIDATE_DRIFT", async () => {
  const f = await boot({ tag: "n11" });
  const jobPath = reviewJobPath(f.binding.card_id, { root: f.root });
  const job = JSON.parse(readFileSync(jobPath, "utf8"));
  job.candidateIdentity = { ...job.candidateIdentity, currentHead: "a".repeat(40) };
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + "\n", "utf8");
  const r = await ensureCurrentReviewJob(jobFixture(f));
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, H.JOB_CANDIDATE_DRIFT);
  assert.ok(r.reason.includes("currentHead"), r.reason);
});

test("N10: duplicate Controller ingest -> idempotent, no second ACCEPTED mint", async () => {
  const f = await boot({ tag: "n10" });
  const opts = { root: f.root };
  // Advance REQUIRED -> ... -> STAGED through the writeback state machine.
  for (const [from, to] of [["REQUIRED", "PREPARED"], ["PREPARED", "RUNNING"], ["RUNNING", "FINDINGS_CAPTURED"], ["FINDINGS_CAPTURED", "VERDICT_PRODUCED"], ["VERDICT_PRODUCED", "PERSISTED"], ["PERSISTED", "STAGED"]]) {
    const a = advanceState(f.binding.card_id, from, to, opts);
    assert.equal(a.ok, true, `${from}->${to}`);
  }
  // Controller acceptance (test shortcut to the ACCEPTED state to exercise
  // the idempotency branch — the real acceptance path is covered by
  // gov-controller-ingest-result / acceptReviewJob suites).
  const staged = readReviewJob(f.binding.card_id, opts);
  const acc = updateReviewJob(f.binding.card_id, {
    expectedStateVersion: staged.job.stateVersion,
    patch: { state: "ACCEPTED", findingsDigest: "a".repeat(64), verdictDigest: "b".repeat(64) },
  }, opts);
  assert.equal(acc.ok, true);
  const versionAfterAccept = acc.job.stateVersion;
  const r1 = acceptReviewJob({ cardId: f.binding.card_id, authorizationSource: "test-controller" }, opts);
  assert.equal(r1.ok, true);
  assert.equal(r1.idempotent, true, "duplicate ingest must be idempotent");
  const after = readReviewJob(f.binding.card_id, opts);
  assert.equal(after.job.state, "ACCEPTED");
  assert.equal(after.job.stateVersion, versionAfterAccept, "no second mint (stateVersion unchanged)");
});

test("N3: cwd differs -> job root still derived from the authority-bound out_dir (no relocation)", async () => {
  const f = await boot({ tag: "n3" });
  const jobPath = reviewJobPath(f.binding.card_id, { root: f.root });
  rmSync(jobPath, { force: true });
  const foreign = mkdtempSync(join(tmpdir(), "revart-b2-foreign-")); cleanups.push(foreign);
  const prevCwd = process.cwd();
  try {
    process.chdir(foreign);
    const r = await ensureCurrentReviewJob(jobFixture(f));
    assert.equal(r.ok, true);
    assert.equal(r.created, true);
    assert.ok(r.path.startsWith(f.root + "/"), `job at authority-derived root, got ${r.path}`);
    assert.ok(!r.path.startsWith(foreign), `job must NOT land under the cwd ${foreign}`);
  } finally {
    process.chdir(prevCwd);
  }
});

test("B2-7E: re-frozen admission with a different binding vs existing state -> HOLD (binding drift)", async () => {
  const f = await boot({ tag: "driftadmission" });
  const mutated = {
    ...f.admission,
    extensions: { ...f.admission.extensions, review_closeout: { ...f.admission.extensions.review_closeout, card_title: "MUTATED TITLE" } },
  };
  const refrozen = freezeAdmission(mutated);
  assert.notEqual(refrozen.admission_id, f.admission.admission_id, "binding is inside the frozen admission identity");
  const calls = [];
  const r = await runAdmittedGraph({ admission: refrozen, runner: makeSpyRunner(calls), reviewSurfaceDir: f.surface });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.BINDING_DRIFT);
  assert.equal(calls.length, 0, "runner must never be invoked on admission-level binding drift");
});

test("T4: frozen binding tamper after freeze -> ADMISSION_DRIFT at the production gate", async () => {
  const repo = makeGitRepo("t4"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });
  const tampered = {
    ...admission,
    extensions: { ...admission.extensions, review_closeout: { ...admission.extensions.review_closeout, card_type: "research" } },
  };
  // No re-freeze: the payload no longer re-derives its frozen id.
  const gate = assertProductionAdmission(tampered);
  assert.equal(gate.ok, false);
  assert.equal(gate.holdCode, PRODUCTION_GATE_HOLDS.ADMISSION_DRIFT);
  const calls = [];
  const r = await runAdmittedGraph({ admission: tampered, runner: makeSpyRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, PRODUCTION_GATE_HOLDS.ADMISSION_DRIFT);
  assert.equal(calls.length, 0);
});
