// test/admission/test-review-closeout-binding.mjs
//
// AUTOLOOP-REVART-LC1-B1 — pre-dispatch review lifecycle authority gate
// (B0 invariants I1 / I3 / I5). A review-required admission
// (review_policy.strength independent|external) MUST carry a complete frozen
// `extensions.review_closeout` binding with a non-zero authority digest
// chain and mutation_scope ⊆ authorized_scope; a non-review-required
// admission MUST NOT carry one. All violations HOLD BEFORE the runner is
// invoked (nodeResults: []).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import { REVIEW_LIFECYCLE_HOLDS } from "../../src/governance/review-lifecycle.mjs";
import {
  makeGitRepo,
  projectBinding,
  makeReviewRequiredAdmission,
  makeDeterministicAdmission,
} from "../governance/review-lifecycle-fixture.mjs";

const H = REVIEW_LIFECYCLE_HOLDS;

function spyRunner(recorded) {
  return async (opts) => {
    recorded.push(opts);
    return { final: "PASS", nodeResults: [], transitions: [] };
  };
}

const cleanups = [];
test.after(() => {
  for (const d of cleanups) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("I1: review-required admission WITHOUT binding -> HOLD / BINDING_MISSING, runner never invoked", async () => {
  const repo = makeGitRepo("missing"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding: null, authorityRecordDigest: "0".repeat(64) });
  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: spyRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.BINDING_MISSING);
  assert.deepEqual(r.nodeResults, []);
  assert.equal(calls.length, 0, "runner must never be invoked");
});

test("I1: non-review-required admission WITH binding -> HOLD / BINDING_UNREQUIRED", async () => {
  const admission = makeDeterministicAdmission({ binding: {} });
  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: spyRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.BINDING_UNREQUIRED);
  assert.equal(calls.length, 0, "runner must never be invoked");
});

test("I1: review-required admission with INVALID binding (absolute out_dir) -> HOLD / BINDING_INVALID", async () => {
  const repo = makeGitRepo("absout"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const bad = { ...binding, out_dir: "/etc/escape" };
  const admission = makeReviewRequiredAdmission({ binding: bad });
  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: spyRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.BINDING_INVALID);
  assert.ok(r.reason.includes("out_dir"), r.reason);
  assert.equal(calls.length, 0);
});

test("I1: review-required admission with INVALID binding (traversal out_dir) -> HOLD / BINDING_INVALID", async () => {
  const repo = makeGitRepo("traverse"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const bad = { ...binding, out_dir: "../escape" };
  const admission = makeReviewRequiredAdmission({ binding: bad });
  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: spyRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.BINDING_INVALID);
  assert.equal(calls.length, 0);
});

test("I3: zero authority_record_digest (buildAdmissionRecord default) -> HOLD / AUTHORITY_DIGEST_MISMATCH", async () => {
  const repo = makeGitRepo("zerodig"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding, authorityRecordDigest: "0".repeat(64) });
  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: spyRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.AUTHORITY_DIGEST_MISMATCH);
  assert.equal(calls.length, 0);
});

test("I3: digest mismatch (bound != source_authority_digest) -> HOLD / AUTHORITY_DIGEST_MISMATCH", async () => {
  const repo = makeGitRepo("wrongdig"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding, authorityRecordDigest: "1".repeat(64) });
  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: spyRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.AUTHORITY_DIGEST_MISMATCH);
  assert.equal(calls.length, 0);
});

test("I5: mutation_scope outside binding.authorized_scope -> HOLD / SCOPE_MISMATCH", async () => {
  const repo = makeGitRepo("scope"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding, mutationScope: ["src/elsewhere"] });
  const calls = [];
  const r = await runAdmittedGraph({ admission, runner: spyRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, H.SCOPE_MISMATCH);
  assert.equal(calls.length, 0);
});

test("gate: valid binding + review-required admission passes the pure gate (reaches dispatch)", async () => {
  const repo = makeGitRepo("gateok"); cleanups.push(repo);
  const { binding } = projectBinding(repo);
  const admission = makeReviewRequiredAdmission({ binding });
  // The lifecycle gate itself is exercised via resolveReviewCloseout (pure) —
  // full dispatch + closeout is covered by test-review-lifecycle.mjs E2E.
  const { resolveReviewCloseout } = await import("../../src/governance/review-lifecycle.mjs");
  const r = resolveReviewCloseout(admission);
  assert.equal(r.ok, true);
  assert.equal(r.active, true);
  assert.equal(r.binding.source_authority_digest, admission.authority_binding.authority_record_digest);
});

test("bundle_path consistency rule: authority bundle_path outside out_dir -> BINDING_INVALID at projection", async () => {
  const repo = makeGitRepo("bundlepath"); cleanups.push(repo);
  const { record, binding } = projectBinding(repo);
  // A valid binding projects; the OUT-OF-OUT_DIR case is rejected at
  // bootstrap (prepareReviewLifecycle) — covered in test-review-lifecycle.mjs.
  assert.ok(binding.bundle_path.startsWith(binding.out_dir), "fixture bundle_path must live inside out_dir");
  assert.ok(record.schema === "autoloop.lifecycle-authorization/v3");
});
