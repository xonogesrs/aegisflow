// test/governance/test-semantic-drift-gate.mjs
//
// POST-P4 SEMANTIC DRIFT GATE — successContractDigest freeze + drift fence.
//
// Frozen contract (docs/governance/autoloop-post-p4-governance-convergence.md §5):
//   SEMANTIC_SOURCE          = normalized successContract + bound spec digest
//                              + admission policy
//   SEMANTIC_BINDING_POINT   = persisted closeout-state record at write time
//   SEMANTIC_CHANGE_AUTHORITY= successor-generation machinery only
//   DRIFT DEFINITION         = any gate-time divergence between the bound
//                              digest and the live declared contract not
//                              accompanied by an authorized successor record
//
// Coverage:
//   D1  digest derivation is deterministic and key-order independent
//   D2  non-object contracts fail closed (no silent digest of junk)
//   D3  materializeCloseoutContract derives the digest from the record's own
//       contract bytes (never trusts a caller-supplied digest field)
//   D4  records without a contract carry no digest — legacy status quo kept
//   D5  unchanged contract at gate time → closeout proceeds (no false drift)
//   D6  in-place contract mutation → HOLD / SEMANTIC_DRIFT, never PASS
//   D7  contract deleted after binding → HOLD / SEMANTIC_DRIFT
//   D8  a caller-supplied successContractDigest field cannot influence the
//       gate-time derivation (binding point is the persisted contract bytes)
//   D9  semantic-source-superseded is a valid revocation trigger (cascade
//       integration per the frozen NEXT_CANONICAL_STAGE)
//
// Run: node --test test/governance/test-semantic-drift-gate.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runStateDrivenCloseout,
} from "../../src/governance/review-bundle.mjs";
import {
  CLOSEOUT_STATE_SCHEMA,
  CLOSEOUT_HOLDS,
  closeoutStatePath,
  successContractDigestOf,
  writeCloseoutState,
  readCloseoutState,
} from "../../src/governance/closeout-state.mjs";
import {
  REVOCATION_TRIGGERS,
  validateRevocationEvent,
} from "../../src/governance/truth-revocation.mjs";

const REPO_A = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");
const ROOT = `${tmpdir()}/semantic-drift-gate-${process.pid}`;
const OUT = join(ROOT, "out");
const surface = (n) => join(ROOT, `surface-${n}`);

before(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  process.env.AUTOLOOP_REVIEW_SURFACE = join(ROOT, "env-surface");
  process.env.AUTOLOOP_REVIEW_ARCHIVE = join(ROOT, "archive");
});
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
});

// ── realistic structured Graph result（matches what runColimaGraph returns）──

const passGraph = {
  executionId: "fixture-drift-pass-1",
  final: "PASS",
  holdCode: null,
  reason: null,
  scheduler: {
    verdict: "PASS",
    order: ["R1", "W1", "V1"],
    statuses: { R1: "passed", W1: "passed", V1: "passed" },
    skipped: [],
    writerViolations: [],
    leaseHolderAfter: null,
  },
  nodeResults: [
    {
      nodeId: "R1", phaseExecutionId: "exec_dr_r1", taskType: "audit", dependencies: [],
      final: "PASS", attempt: 0, reason: null, startedAt: 1, completedAt: 2,
      cleanup: { worktreeRevoked: false },
      subagentResult: { status: "PASS", testResults: null, testsExecuted: [] },
    },
    {
      nodeId: "W1", phaseExecutionId: "exec_dr_w1", taskType: "write", dependencies: ["R1"],
      final: "PASS", attempt: 0, reason: null, startedAt: 3, completedAt: 4,
      worktreeIdentity: {
        verified: true,
        output: { files: [{ status: " M", path: "src/governance/review-bundle.mjs", source: null, destination: null, rename: false }] },
      },
      cleanup: { worktreeRevoked: true },
      subagentResult: { status: "PASS", testResults: { passed: 2, failed: 0, total: 2 }, testsExecuted: ["self-test"] },
      reviewResult: { status: "PASS", findings: [], blockingFindings: [], scopeVerified: true, testsVerified: true, recommendedAction: "PASS", summary: "independent review PASS" },
    },
    {
      nodeId: "V1", phaseExecutionId: "exec_dr_v1", taskType: "verify", dependencies: ["W1"],
      final: "PASS", attempt: 0, reason: null, startedAt: 5, completedAt: 6,
      cleanup: { worktreeRevoked: false },
      subagentResult: { status: "PASS", testResults: { passed: 1, failed: 0, total: 1 }, testsExecuted: [] },
    },
  ],
  transitions: [
    { phaseId: "R1", final: "PASS", attempt: 0, lifecycleTransitions: [{ phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" }] },
    { phaseId: "W1", final: "PASS", attempt: 0, lifecycleTransitions: [{ phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" }] },
    { phaseId: "V1", final: "PASS", attempt: 0, lifecycleTransitions: [{ phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" }] },
  ],
};

const DECLARED_CONTRACT = {
  requiredChecks: [
    { id: "suite-alpha", kind: "regression-suite", suite: "test:governance" },
    { id: "verifier-gate", kind: "verifier" },
  ],
};

const stateFor = (cardId, { overrides = {}, contract = DECLARED_CONTRACT, boundDigest = undefined } = {}) => ({
  schema: CLOSEOUT_STATE_SCHEMA,
  task: { cardId, cardTitle: `${cardId} title`, cardType: "implementation" },
  requiresReview: true,
  reviewRequiredAt: "2026-09-21T00:00:00.000Z",
  outDir: join(OUT, cardId),
  authorizedScope: ["src/governance/review-bundle.mjs"],
  unauthorizedScope: ["commit", "push", "merge", "seal"],
  designDecisions: ["semantic drift gate"],
  objective: `${cardId}: verify the semantic drift gate`,
  negativeCases: ["in-place contract mutation"],
  regression: [{ suite: "test:governance", tests: 1, pass: 1, fail: 0 }],
  regressionSummary: "focused tests pass",
  recommendedNextStep: "external review",
  repairBudgetMaxAttempts: 1,
  ...(contract ? { successContract: contract } : {}),
  ...(boundDigest !== undefined ? { successContractDigest: boundDigest } : {}),
  ...overrides,
});

const drive = (cardId, { surfaceDir, state = null, graphResult = passGraph } = {}) => {
  const st = state ?? stateFor(cardId, { boundDigest: successContractDigestOf(DECLARED_CONTRACT) });
  const stPath = closeoutStatePath(st.outDir ?? join(OUT, cardId));
  writeCloseoutState({ path: stPath, state: st });
  return runStateDrivenCloseout({
    statePath: stPath,
    graphResult,
    repoPath: REPO_A,
    cwd: REPO_A,
    outDir: join(OUT, cardId),
    timeoutMs: 15000,
    surfaceDir,
  });
};

// ── D1: deterministic, key-order independent digest ───────────────────────

test("D1. successContractDigestOf is deterministic and key-order independent", () => {
  const a = successContractDigestOf(DECLARED_CONTRACT);
  const reordered = { requiredChecks: DECLARED_CONTRACT.requiredChecks.slice().reverse() };
  // array order is semantic (check list identity) — same array order + same
  // content in different KEY order must yield the SAME digest.
  const b = successContractDigestOf({
    requiredChecks: DECLARED_CONTRACT.requiredChecks.map((c) => ({ suite: c.suite, kind: c.kind, id: c.id })),
  });
  assert.equal(a, successContractDigestOf(DECLARED_CONTRACT), "same input → same digest");
  assert.equal(a, b, "key order does not affect the digest");
  assert.notEqual(a, successContractDigestOf(reordered), "array order IS semantic: reversed check list diverges");
  assert.match(a, /^[0-9a-f]{64}$/, "64-hex sha256");
});

// ── D2: non-object contracts fail closed ──────────────────────────────────

test("D2. non-object contracts are rejected (never silently digested)", () => {
  for (const bad of [null, undefined, [1, 2], "contract", 42]) {
    assert.throws(() => successContractDigestOf(bad), TypeError, `rejects ${JSON.stringify(bad) ?? String(bad)}`);
  }
});

// ── D3: materialization derives the digest from the record's own bytes ────

test("D3. materializeCloseoutContract derives the digest from the persisted contract bytes", async () => {
  const { materializeCloseoutContract } = await import("../../src/governance/closeout-state.mjs");
  const r = materializeCloseoutContract(stateFor("D3", { boundDigest: "0".repeat(64) }));
  assert.equal(r.ok, true, `(${r.errors.join(";")})`);
  assert.equal(r.contract.successContractDigest, successContractDigestOf(DECLARED_CONTRACT),
    "digest re-derived from the record's own contract bytes");
});

// ── D4: legacy records (no contract) keep the pre-gate status quo ─────────

test("D4. record without a contract carries no digest and closes out unchanged", { timeout: 30000 }, async () => {
  const cardId = "D4";
  const r = await drive(cardId, { surfaceDir: surface("d4"), state: stateFor(cardId, { contract: null }) });
  assert.equal(r.final, "PASS", `legacy no-contract card still closes (${r.holdCode}:${r.reason})`);
  const st = readCloseoutState(closeoutStatePath(join(OUT, cardId)));
  assert.equal(st.state.successContract, undefined, "no contract materialized");
});

// ── D5: unchanged contract → no false drift ───────────────────────────────

test("D5. unchanged declared contract at gate time → closeout proceeds", { timeout: 30000 }, async () => {
  const cardId = "D5";
  const r = await drive(cardId, { surfaceDir: surface("d5") });
  assert.equal(r.final, "PASS", `(${r.holdCode}:${r.reason})`);
  assert.notEqual(r.holdCode, CLOSEOUT_HOLDS.SEMANTIC_DRIFT);
});

// ── D6: in-place mutation → HOLD / SEMANTIC_DRIFT ─────────────────────────

test("D6. in-place contract mutation after digest binding → HOLD SEMANTIC_DRIFT, never PASS", { timeout: 30000 }, async () => {
  const cardId = "D6";
  const mutated = {
    ...DECLARED_CONTRACT,
    requiredChecks: [{ id: "suite-alpha", kind: "regression-suite", suite: "test:governance" }],
    // the verifier check was silently dropped after binding
  };
  const r = await drive(cardId, {
    surfaceDir: surface("d6"),
    state: stateFor(cardId, { contract: mutated, boundDigest: successContractDigestOf(DECLARED_CONTRACT) }),
  });
  assert.equal(r.applied, true);
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, CLOSEOUT_HOLDS.SEMANTIC_DRIFT);
  assert.ok(r.reason.includes("successor-generation"), `reason names the authorized change path (${r.reason})`);
  assert.ok(!existsSync(join(surface("d6"), "review-bundle.txt")), "no report delivered on drift");
});

// ── D7: contract deleted after binding → drift ────────────────────────────

test("D7. declared semantics removed after digest binding → HOLD SEMANTIC_DRIFT", { timeout: 30000 }, async () => {
  const cardId = "D7";
  const r = await drive(cardId, {
    surfaceDir: surface("d7"),
    state: stateFor(cardId, { contract: null, boundDigest: successContractDigestOf(DECLARED_CONTRACT) }),
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, CLOSEOUT_HOLDS.SEMANTIC_DRIFT);
  assert.ok(r.reason.includes("removed"), `(${r.reason})`);
});

// ── D8: caller-supplied digest field is never the authority ───────────────

test("D8. a forged successContractDigest field cannot make drifted semantics pass", { timeout: 30000 }, async () => {
  const cardId = "D8";
  const mutated = {
    ...DECLARED_CONTRACT,
    requiredChecks: [], // weakened AFTER the authoritative digest was bound
  };
  // The record carries the OLD authoritative digest; the mutation is real.
  // A naive implementation that trusted a caller-supplied live digest would
  // let this pass; the derivation is from the contract bytes themselves.
  const r = await drive(cardId, {
    surfaceDir: surface("d8"),
    state: stateFor(cardId, { contract: mutated, boundDigest: successContractDigestOf(DECLARED_CONTRACT) }),
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, CLOSEOUT_HOLDS.SEMANTIC_DRIFT);
});

// ── D9: semantic-source-superseded is a first-class revocation trigger ────

test("D9. semantic-source-superseded trigger validates and integrates the cascade", () => {
  assert.ok(REVOCATION_TRIGGERS.includes("semantic-source-superseded"),
    "trigger wired into REVOCATION_TRIGGERS (frozen NEXT_CANONICAL_STAGE)");
  const v = validateRevocationEvent({
    schema: "autoloop.truth-revocation/v1",
    revocationId: "sdg-d9-1",
    truthClass: "evidence",
    truthId: "ev-123",
    trigger: "semantic-source-superseded",
    reason: "declared task semantics superseded via successor generation",
    at: "2026-09-21T12:00:00.000Z",
    issuedBy: { identity: "operator-1", role: "operator" },
  });
  assert.equal(v.ok, true, `(${(v.errors ?? []).join(";")})`);
  assert.equal(v.event.trigger, "semantic-source-superseded");
});
