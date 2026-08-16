// test/governance/test-review-lifecycle.mjs
//
// AUTOLOOP-REVART-LC1-B1 — admission-driven review lifecycle:
//   - E2E zero-human-prompt: frozen admission -> execution -> closeout-state
//     auto-bootstrapped -> bundle generated/validated -> delivery -> result
//     REVIEW_PENDING (never terminal PASS while review outstanding)
//   - resume create-or-verify (binding/admission/baseline drift -> HOLD)
//   - fail-closed fault injection (bootstrap / emission / delivery)
//   - v3 backward compatibility + bundle_path containment rule (B0 §8)

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import {
  REVIEW_LIFECYCLE_HOLDS,
  prepareReviewLifecycle,
  completeReviewLifecycle,
  resolveReviewCloseout,
  gitTopLevel,
} from "../../src/governance/review-lifecycle.mjs";
import {
  CLOSEOUT_CARD_TYPES,
  validateAuthorityRecord,
  projectReviewCloseout,
  reviewCloseoutBindingDigest,
} from "../../src/governance/lifecycle-authorization.mjs";
import { CARD_TYPES } from "../../src/governance/review-bundle.mjs";
import { readCloseoutState } from "../../src/governance/closeout-state.mjs";
import {
  makeGitRepo,
  projectBinding,
  makeAuthorityRecord,
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

function passGraphResult() {
  return {
    final: "PASS",
    holdCode: null,
    reason: null,
    executionId: "g",
    nodeResults: [{
      nodeId: "P1", final: "PASS", attempt: 0, taskType: "implementation",
      resultIdentity: { latencyMs: 5 },
      reviewResult: { recommendedAction: "PASS", blockingFindings: [], summary: "graph independent review PASS" },
    }],
    transitions: [],
  };
}

test("parity: lifecycle-authorization CLOSEOUT_CARD_TYPES == review-bundle CARD_TYPES", () => {
  assert.deepEqual([...CLOSEOUT_CARD_TYPES].sort(), [...CARD_TYPES].sort());
});

test("v3 backward compatibility: v2 record (no closeout_metadata) still validates; projection fails closed on it", () => {
  const repo = makeGitRepo("v2compat"); cleanups.push(repo);
  const { record } = projectBinding(repo);
  const v2 = { ...record, schema: "autoloop.lifecycle-authorization/v2" };
  delete v2.closeout_metadata;
  assert.equal(validateAuthorityRecord(v2).valid, true, "v2 record must remain valid (additive v3)");
  const proj = projectReviewCloseout({ record: v2, specBytes: readFileSync(resolve(repo, "docs/pi-graph-output/revart-b1-test-card/b1-card-spec.md")) });
  assert.equal(proj.ok, false, "review-required projection without closeout_metadata must fail closed");
  assert.ok(proj.errors.some((e) => e.startsWith("closeout_metadata")), JSON.stringify(proj.errors));
});

test("E2E zero-human-prompt: admission -> bootstrap -> execution -> closeout-state -> bundle -> delivery -> REVIEW_PENDING (never PASS)", async () => {
  const repo = makeGitRepo("e2e"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });
  const surface = mkdtempSync(join(tmpdir(), "revart-b1-surface-")); cleanups.push(surface);
  const calls = [];

  const r = await runAdmittedGraph({
    admission,
    runner: makeSpyRunner(calls, { repo }),
    reviewSurfaceDir: surface,
  });

  // 1) terminal is REVIEW_PENDING — implementation+bundle PASS is NOT card PASS
  assert.equal(r.final, "REVIEW_PENDING", JSON.stringify(r, null, 1).slice(0, 600));
  assert.equal(r.holdCode, null);
  assert.equal(r.closeout.applied, true);
  assert.equal(r.closeout.final, "REVIEW_PENDING");
  const repoRoot = gitTopLevel(repo);
  assert.equal(r.closeout.statePath, resolve(repoRoot, OUT_DIR_REL, "closeout-state.json"));
  assert.equal(calls.length, 1, "runner invoked exactly once");

  // 2) closeout-state.json auto-bootstrapped from the frozen binding
  const statePath = resolve(repoRoot, OUT_DIR_REL, "closeout-state.json");
  const st = readCloseoutState(statePath);
  assert.equal(st.ok, true);
  const state = st.state;
  assert.equal(state.schema, "autoloop.closeout-state/v1");
  assert.equal(state.requiresReview, true);
  assert.equal(state.task.cardId, binding.card_id);
  assert.equal(state.task.cardTitle, binding.card_title);
  assert.equal(state.task.cardType, binding.card_type);
  assert.equal(state.outDir, resolve(repoRoot, OUT_DIR_REL));
  assert.deepEqual(state.authorizedScope, binding.authorized_scope);
  assert.ok(state.baseline?.schema === "autoloop.card-inventory.baseline/v1" && Array.isArray(state.baseline.dirtyPaths));
  assert.equal(state.reviewCloseout.schema, binding.schema);
  assert.equal(state.reviewCloseout.bindingDigest, reviewCloseoutBindingDigest(binding));
  assert.equal(state.reviewCloseout.admissionId, admission.admission_id);

  // 3) review bundle auto-generated + validated in outDir
  const bundles = readdirSync(resolve(repo, OUT_DIR_REL)).filter((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt"));
  assert.equal(bundles.length, 1, `expected one canonical bundle, got ${bundles.join(",")}`);

  // 4) delivery trio on the authoritative surface
  for (const f of ["review-bundle.txt", "delivery.json", "evidence.json"]) {
    assert.ok(statSync(join(surface, f)).isFile(), `surface missing ${f}`);
  }
  const delivery = JSON.parse(readFileSync(join(surface, "delivery.json"), "utf8"));
  assert.equal(delivery.cardId, binding.card_id);

  // 5) no terminal PASS: external review outstanding
  assert.notEqual(state.closeout.externalReviewStatus, "PASS");
});

test("resume: interrupted delivery re-attempts with the SAME deterministic bundle identity (T6/T7)", async () => {
  const repo = makeGitRepo("resume"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });
  const surfaceFile = join(tmpdir(), `revart-b1-surface-file-${Date.now()}`);
  writeFileSync(surfaceFile, "not a directory", "utf8");
  cleanups.push(surfaceFile);
  const calls = [];
  const runner = makeSpyRunner(calls);

  // Run 1: delivery fails -> AWAITING_BUNDLE_DELIVERY (retryable, never PASS).
  const r1 = await runAdmittedGraph({ admission, runner, reviewSurfaceDir: surfaceFile });
  assert.equal(r1.final, "AWAITING_BUNDLE_DELIVERY", JSON.stringify(r1, null, 1).slice(0, 400));
  const repoRoot = gitTopLevel(repo);
  const statePath = resolve(repoRoot, OUT_DIR_REL, "closeout-state.json");
  const identity1 = readCloseoutState(statePath).state.closeout?.bundleIdentity;
  assert.ok(/^[0-9a-f]{64}$/.test(identity1 ?? ""), "bundle identity must be recorded even on delivery failure");

  // Run 2 (resume): same frozen admission, delivery now possible -> the same
  // deterministic bundle identity re-attempts delivery -> REVIEW_PENDING.
  const surface = mkdtempSync(join(tmpdir(), "revart-b1-surface-")); cleanups.push(surface);
  const r2 = await runAdmittedGraph({ admission, runner, reviewSurfaceDir: surface });
  assert.equal(r2.final, "REVIEW_PENDING", JSON.stringify(r2, null, 1).slice(0, 500));
  assert.equal(calls.length, 2, "both runs dispatched");
  const st = readCloseoutState(statePath);
  assert.equal(st.state.closeout.status, "APPLIED");
  assert.equal(st.state.closeout.bundleIdentity, identity1, "crash-safe resume must reuse the SAME bundle identity (T7)");
  assert.equal(st.state.reviewCloseout.bindingDigest, reviewCloseoutBindingDigest(binding));
  assert.equal(st.state.reviewCloseout.admissionId, admission.admission_id);
});

test("negative: re-entry after APPLIED+PASS with an IMPLEMENTATION-domain mutation -> HOLD (REVIEW_JOB_CANDIDATE_DRIFT)", async () => {
  const repo = makeGitRepo("reentry"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });
  const surface = mkdtempSync(join(tmpdir(), "revart-b1-surface-")); cleanups.push(surface);
  const calls = [];
  const r1 = await runAdmittedGraph({ admission, runner: makeSpyRunner(calls), reviewSurfaceDir: surface });
  assert.equal(r1.final, "REVIEW_PENDING");
  assert.equal(r1.reviewJob.ok, true, "B2: pending review materializes exactly one governed job");

  // B2 semantics: governance-domain outputs (bundle/job artifacts) do not
  // re-open a completed closeout — re-entry resumes to REVIEW_PENDING and
  // reuses the job. An IMPLEMENTATION-domain mutation (outside
  // docs/pi-graph-output) after the job bound its candidate MUST fail closed
  // via candidate drift — never silent continuation.
  const repoRoot = gitTopLevel(repo);
  writeFileSync(join(repoRoot, "post-closeout-tamper.txt"), "x\n", "utf8");
  const calls2 = [];
  const r = await runAdmittedGraph({ admission, runner: makeSpyRunner(calls2), reviewSurfaceDir: surface });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "REVIEW_JOB_CANDIDATE_DRIFT");
  assert.ok(r.reason.includes("changed since job creation"), r.reason);
});

test("drift: tampered persisted task identity -> HOLD / CLOSEOUT_BOOTSTRAP_BINDING_DRIFT before dispatch", async () => {
  const repo = makeGitRepo("drift1"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });
  const surface = mkdtempSync(join(tmpdir(), "revart-b1-surface-")); cleanups.push(surface);
  const calls = [];
  await runAdmittedGraph({ admission, runner: makeSpyRunner(calls, { repo }), reviewSurfaceDir: surface });

  const statePath = resolve(repo, OUT_DIR_REL, "closeout-state.json");
  const st = readCloseoutState(statePath);
  const tampered = { ...st.state, task: { ...st.state.task, cardTitle: "MUTATED TITLE" } };
  writeFileSync(statePath, JSON.stringify(tampered, null, 2) + "\n", "utf8");

  const calls2 = [];
  const r = await runAdmittedGraph({ admission, runner: makeSpyRunner(calls2, { repo }), reviewSurfaceDir: surface });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.BINDING_DRIFT);
  assert.ok(r.reason.includes("cardTitle"), r.reason);
  assert.equal(calls2.length, 0, "runner must never be invoked on drift");
});

test("drift: tampered reviewCloseout.admissionId -> HOLD / CLOSEOUT_BOOTSTRAP_BINDING_DRIFT", async () => {
  const repo = makeGitRepo("drift2"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });
  const surface = mkdtempSync(join(tmpdir(), "revart-b1-surface-")); cleanups.push(surface);
  await runAdmittedGraph({ admission, runner: makeSpyRunner([], { repo }), reviewSurfaceDir: surface });

  const statePath = resolve(repo, OUT_DIR_REL, "closeout-state.json");
  const st = readCloseoutState(statePath);
  const tampered = { ...st.state, reviewCloseout: { ...st.state.reviewCloseout, admissionId: "f".repeat(64) } };
  writeFileSync(statePath, JSON.stringify(tampered, null, 2) + "\n", "utf8");

  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: makeSpyRunner(calls, { repo }), reviewSurfaceDir: surface });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.BINDING_DRIFT);
  assert.ok(r.reason.includes("reviewCloseout.admissionId"), r.reason);
  assert.equal(calls.length, 0);
});

test("drift: baseline structure removed -> HOLD / CLOSEOUT_BOOTSTRAP_BINDING_DRIFT", async () => {
  const repo = makeGitRepo("drift3"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });
  const surface = mkdtempSync(join(tmpdir(), "revart-b1-surface-")); cleanups.push(surface);
  await runAdmittedGraph({ admission, runner: makeSpyRunner([], { repo }), reviewSurfaceDir: surface });

  const statePath = resolve(repo, OUT_DIR_REL, "closeout-state.json");
  const st = readCloseoutState(statePath);
  const tampered = { ...st.state, baseline: { schema: "autoloop.card-inventory.baseline/v1" } };
  writeFileSync(statePath, JSON.stringify(tampered, null, 2) + "\n", "utf8");

  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: makeSpyRunner(calls, { repo }), reviewSurfaceDir: surface });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.BINDING_DRIFT);
  assert.ok(r.reason.includes("baseline"), r.reason);
  assert.equal(calls.length, 0);
});

test("fault: binding.worktree missing -> HOLD / WORKTREE_MISSING, no dispatch", async () => {
  const repo = makeGitRepo("wt"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const bad = { ...binding, worktree: join(tmpdir(), "revart-b1-does-not-exist") };
  const admission = makeReviewRequiredAdmission({ binding: bad });
  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: makeSpyRunner(calls, { repo }) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.WORKTREE_MISSING);
  assert.equal(calls.length, 0);
});

test("fault: bundle emission failure -> HOLD (never successful terminal)", async () => {
  const repo = makeGitRepo("emit"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });

  const prepared = await prepareReviewLifecycle({ admission, binding });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const outDir = resolve(repo, OUT_DIR_REL);
  chmodSync(outDir, 0o555);
  try {
    const outcome = await completeReviewLifecycle({
      admission,
      binding,
      graphResult: passGraphResult(),
      repoRoot: prepared.repoRoot,
      surfaceDir: mkdtempSync(join(tmpdir(), "revart-b1-surface-")),
    });
    assert.equal(outcome.final, "HOLD", JSON.stringify(outcome, null, 1).slice(0, 500));
    assert.ok(outcome.holdCode, "emission failure must carry a holdCode");
  } finally {
    chmodSync(outDir, 0o755);
  }
});

test("fault: delivery failure -> AWAITING_BUNDLE_DELIVERY (never PASS)", async () => {
  const repo = makeGitRepo("deliver"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });
  const surfaceFile = join(tmpdir(), `revart-b1-surface-file-${Date.now()}`);
  writeFileSync(surfaceFile, "not a directory", "utf8");
  cleanups.push(surfaceFile);
  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: makeSpyRunner(calls, { repo }), reviewSurfaceDir: surfaceFile });
  assert.equal(r.final, "AWAITING_BUNDLE_DELIVERY", JSON.stringify(r, null, 1).slice(0, 500));
  assert.equal(calls.length, 1, "execution ran; delivery failure must downgrade the terminal");
});

test("B0 §8: authority bundle_path outside out_dir -> HOLD / BUNDLE_PATH_OUTSIDE_OUT_DIR", async () => {
  const repo = makeGitRepo("bp"); cleanups.push(repo);
  const { record } = projectBinding(repo);
  const badRecord = { ...record, bundle_path: "docs/pi-graph-output/other-card/bundle.txt" };
  const proj = projectReviewCloseout({
    record: badRecord,
    specBytes: readFileSync(resolve(repo, "docs/pi-graph-output/revart-b1-test-card/b1-card-spec.md")),
  });
  assert.equal(proj.ok, true, "binding itself is structurally valid");
  const admission = makeReviewRequiredAdmission({ binding: proj.binding });
  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: makeSpyRunner(calls, { repo }) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.BUNDLE_PATH_OUTSIDE_OUT_DIR);
  assert.equal(calls.length, 0);
});

test("resolveReviewCloseout: v2-shaped binding schema rejected", () => {
  const repo = makeGitRepo("schema"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const bad = { ...binding, schema: "autoloop.review-closeout/v0" };
  const admission = makeReviewRequiredAdmission({ binding: bad });
  const r = resolveReviewCloseout(admission);
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, H.BINDING_INVALID);
});
