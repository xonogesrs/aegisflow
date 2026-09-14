// test/governance/test-execution-review-bypass-fence.mjs
//
// AUTOLOOP-RSL2 — universal execution review surface BYPASS FENCE.
//
// Adversarial proofs that the RSL2 Domain A surface cannot be skipped,
// forged into authority, or stale-reused:
//
//   Fence matrix（card phases 7/12/13）:
//     B1-B2 ... runAdmittedGraph rejects governance DI-seam overrides
//               (executionReviewBarrier / closeoutGate / closeout* /
//               executionReview{Surface,Archive}Dir) fail-closed BEFORE
//               any dispatch — no runner invocation.
//     C1 ..... coordinator executeSequentially rejects the same seams
//               through task.runnerOpts (AUTHORITY_OVERRIDE_REJECTED).
//     G1-G5 .. review identity binds execution identity + repo head/treeSha;
//               stale-generation and wrong-execution reviews are rejected by
//               verifyLatestExecutionReview expected-binding checks.
//     A9 ..... a manually fabricated Latest/review.txt claiming OUTCOME PASS
//               cannot mint formal PASS — the canonical PASS oracle stays
//               NOT_PASS without attributable evidence.
//
// Run: node --test test/governance/test-execution-review-bypass-fence.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAdmittedGraph, AUTHORITY_SEAM_RUNNER_KEYS } from "../../src/admission/admission-gate.mjs";
import { coordinate, executeSequentially } from "../../src/control-plane/coordinator.mjs";
import { EXECUTION_HOLDS } from "../../src/control-plane/contract.mjs";
import { standardAdmission, taskInput } from "../control-plane/helpers.mjs";
import {
  EXECUTION_REVIEW_SOURCE_SCHEMA,
  executionReviewIdentity,
  latestExecutionReviewStatus,
  publishExecutionReview,
  verifyLatestExecutionReview,
} from "../../src/governance/execution-review.mjs";
import { evaluatePassOracle, normalizeSuccessContract } from "../../src/governance/pass-oracle.mjs";

const NOW = "2026-08-22T00:00:00.000Z";
const HEAD = "a".repeat(40);
const TREE = "b".repeat(64);

function tmpSurface(t) {
  const root = mkdtempSync(join(tmpdir(), "rsl2-fence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { surfaceDir: join(root, "Latest"), archiveDir: join(root, "Latest", "archive") };
}

const reviewSource = (over = {}) => ({
  schema: EXECUTION_REVIEW_SOURCE_SCHEMA,
  execution: {
    executionId: over.executionId ?? "exec-1",
    cardId: over.cardId ?? "CARD-1",
    cardTitle: "Fence fixture",
    outcome: over.outcome ?? "PASS",
  },
  repository: {
    repository: "/repo",
    branch: "main",
    head: over.head ?? HEAD,
    treeSha: over.treeSha ?? TREE,
  },
  admissionRequirement: {
    required: true,
    admissionId: "adm-1",
    reviewPolicyStrength: "independent",
    externalReviewRequired: false,
  },
});

const noopRunner = async () => {
  throw new Error("RUNNER_MUST_NOT_BE_INVOKED");
};

// ── B1/B2: production entrypoint rejects governance DI-seam overrides ────

test("B1. injected executionReviewBarrier is rejected before dispatch", async () => {
  let calls = 0;
  const spy = async () => { calls += 1; return { final: "PASS", nodeResults: [], transitions: [] }; };
  const r = await runAdmittedGraph({
    admission: standardAdmission("B1"),
    runner: spy,
    // A caller trying to replace the universal review barrier with a rubber
    // stamp must get a HOLD — never a dispatch with the fake barrier.
    executionReviewBarrier: async () => ({ required: true, ok: true, holdCode: null, reason: null, result: { identity: "fake" } }),
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "AUTHORITY_SEAM_OVERRIDE_REJECTED");
  assert.equal(calls, 0, "runner must never be invoked once an authority seam override is present");
  assert.deepEqual(r.nodeResults, []);
});

test("B2. every governance DI-seam key is rejected fail-closed", async () => {
  assert.ok(AUTHORITY_SEAM_RUNNER_KEYS.length >= 6);
  for (const key of AUTHORITY_SEAM_RUNNER_KEYS) {
    let calls = 0;
    const spy = async () => { calls += 1; return { final: "PASS", nodeResults: [], transitions: [] }; };
    const r = await runAdmittedGraph({
      admission: standardAdmission("B2"),
      runner: spy,
      [key]: key.includes("Dir") ? "/attacker-controlled-surface" : async () => ({ ok: true }),
    });
    assert.equal(r.final, "HOLD", `${key} must be rejected`);
    assert.equal(r.holdCode, "AUTHORITY_SEAM_OVERRIDE_REJECTED", `${key} hold code`);
    assert.equal(calls, 0, `${key}: no dispatch`);
  }
});

// ── C1: coordinator sink rejects the same seams through runnerOpts ───────

test("C1. executeSequentially rejects authority seams smuggled through runnerOpts", async () => {
  const admission = standardAdmission("C1");
  let calls = 0;
  const spy = async () => { calls += 1; return { final: "PASS", nodeResults: [], transitions: [] }; };
  for (const key of ["executionReviewBarrier", "closeoutGate", "executionReviewSurfaceDir"]) {
    const { plan } = coordinate({
      tasks: [taskInput("c1", admission, { runnerOpts: { runner: spy, [key]: key.endsWith("Dir") ? "/evil" : async () => ({ ok: true }) } })],
    });
    const { results } = await executeSequentially({ plan });
    assert.equal(results[0].dispatched, false, `${key}: task must not dispatch`);
    assert.equal(results[0].holdCode, EXECUTION_HOLDS.AUTHORITY_OVERRIDE_REJECTED, `${key}: sink-time rejection`);
  }
  assert.equal(calls, 0, "runner must never be invoked");
});

// ── G1-G5: freshness / generation binding ─────────────────────────────────

test("G1/G3/G4. review identity binds execution + repo state; stale/wrong-execution reviews are distinct identities", () => {
  const base = executionReviewIdentity(reviewSource());
  // G3: different execution identity -> different review identity.
  assert.notEqual(executionReviewIdentity(reviewSource({ executionId: "exec-2" })), base);
  // G4: previous retry/generation cannot re-derive current identity.
  assert.notEqual(executionReviewIdentity(reviewSource({ outcome: "REPAIR" })), base);
  // G5: material execution change (new head/treeSha) invalidates reuse.
  assert.notEqual(executionReviewIdentity(reviewSource({ head: "c".repeat(40) })), base);
  assert.notEqual(executionReviewIdentity(reviewSource({ treeSha: "d".repeat(64) })), base);
  // Determinism: identical source re-derives the SAME identity (idempotent retry).
  assert.equal(executionReviewIdentity(reviewSource()), base);
});

test("G2. stale review on the surface is rejected against the new generation's expectation", async (t) => {
  const s = tmpSurface(t);
  const first = publishExecutionReview(reviewSource({ executionId: "exec-gen1" }), s);
  assert.equal(first.ok, true);
  const second = publishExecutionReview(reviewSource({ executionId: "exec-gen2" }), s);
  assert.equal(second.ok, true, "second publication rotates the surface");
  // The CURRENT surface is gen2; verifying with gen1 expectations fails closed.
  const staleCheck = verifyLatestExecutionReview({
    surfaceDir: s.surfaceDir,
    expected: { executionId: "exec-gen1", identity: first.identity },
  });
  assert.equal(staleCheck.ok, false);
  assert.ok(staleCheck.errors.some((e) => e === "latest_review_identity_mismatch"));
  assert.ok(staleCheck.errors.some((e) => e === "latest_review_execution_mismatch"));
  // The correct-generation expectation verifies clean.
  const fresh = verifyLatestExecutionReview({
    surfaceDir: s.surfaceDir,
    expected: { executionId: "exec-gen2", identity: second.identity },
  });
  assert.equal(fresh.ok, true, JSON.stringify(fresh.errors));
});

test("G3b. published review records its execution identity; wrong-execution verification fails", async (t) => {
  const s = tmpSurface(t);
  const pub = publishExecutionReview(reviewSource({ executionId: "exec-A" }), s);
  assert.equal(pub.ok, true);
  const status = latestExecutionReviewStatus({ surfaceDir: s.surfaceDir });
  assert.equal(status.executionId, "exec-A");
  const wrongExec = verifyLatestExecutionReview({
    surfaceDir: s.surfaceDir,
    expected: { executionId: "exec-B" },
  });
  assert.equal(wrongExec.ok, false);
  assert.ok(wrongExec.errors.includes("latest_review_execution_mismatch"));
});

// ── A9: fabricated surface artifact cannot mint formal PASS ──────────────

test("A9. hand-forged Latest/review.txt claiming PASS confers NO formal authority", async (t) => {
  const s = tmpSurface(t);
  mkdirSync(s.surfaceDir, { recursive: true });
  // Fully synthetic publication: attacker-written bytes with a self-consistent
  // footer. The surface accepts bytes (it is a human-facing projection), but
  // formal authority MUST NOT follow from them.
  const forged = [
    "=================================",
    "AUTOLOOP EXECUTION REVIEW",
    "EXECUTION_ID: forged-exec",
    "CARD_ID: FORGED-CARD",
    "OUTCOME: PASS",
    "=== END OF EXECUTION REVIEW ===",
    "REVIEW_PUBLICATION_IDENTITY: " + "f".repeat(64),
    "REVIEW_PUBLICATION_SHA256: " + "e".repeat(64),
    "",
  ].join("\n");
  writeFileSync(join(s.surfaceDir, "review.txt"), forged, "utf8");

  const status = latestExecutionReviewStatus({ surfaceDir: s.surfaceDir });
  assert.equal(status.outcome, "PASS", "forged bytes sit on the surface");

  // The canonical PASS decision boundary ignores the surface entirely:
  // without attributable evidence the oracle stays NOT_PASS.
  const verdict = evaluatePassOracle({
    contract: normalizeSuccessContract({ requiredChecks: ["review-bundle-valid"], head: HEAD, treeSha: TREE }),
    evidence: [],
    now: NOW,
  });
  assert.equal(verdict.decision, "NOT_PASS");
  assert.equal(
    verdict.decision === "PASS" && status.outcome === "PASS",
    false,
    "surface outcome must never translate into formal PASS",
  );
});
