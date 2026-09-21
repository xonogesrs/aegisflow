// scripts/semantic-drift-e2e.mjs
//
// POST-P4 SEMANTIC DRIFT GATE — REAL PRODUCT E2E (card
// AUTOLOOP_POST_WP1_PRODUCT_ROADMAP_RECONCILIATION_AND_NEXT_STAGE_LARGE_1,
// Phase I).
//
// Proves the capability through the REAL supported path, not function calls:
//   - canonical entrypoint: runStateDrivenCloseout — THE production closeout
//     trigger runColimaGraph invokes at card completion (closeout.statePath;
//     src/runtime/colima-graph-runner.mjs:608-611). No card-specific script.
//   - authoritative persisted state: real closeout-state records written via
//     writeCloseoutState (atomic, secret-scanned) and re-read by the trigger.
//   - observable product result: formal closeout disposition (PASS/HOLD),
//     delivered review-bundle trio on the real surface, persisted APPLIED
//     disposition in the state record.
//   - fail-closed negatives: drift HOLD before any delivery; drift never
//     reaches the PASS oracle; legacy no-contract records unaffected.
//
// Environment note: colima is NOT running on this workstation, so the
// container-executed variant of the same seam (a full admitted Colima graph
// run) is out of scope for this probe; the seam itself — the state-driven
// closeout the admitted runner calls — is exercised for real here, and the
// WP1/WP2 regression lanes cover the runner paths (Phase J/L).
//
// Run: node scripts/semantic-drift-e2e.mjs

import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runStateDrivenCloseout,
  validateReviewBundle,
} from "../src/governance/review-bundle.mjs";
import {
  CLOSEOUT_STATE_SCHEMA,
  CLOSEOUT_HOLDS,
  closeoutStatePath,
  successContractDigestOf,
  writeCloseoutState,
  readCloseoutState,
} from "../src/governance/closeout-state.mjs";

const REPO_A = "/Volumes/NVM2T/Development/repos/autoloop";
const ROOT = `${tmpdir()}/semantic-drift-e2e-${process.pid}`;
const OUT = join(ROOT, "out");
const ARCHIVE = join(ROOT, "archive");

const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} — ${detail}`);
};

const passGraph = {
  executionId: "e2e-drift-pass-1",
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
      nodeId: "R1", phaseExecutionId: "exec_e2e_r1", taskType: "audit", dependencies: [],
      final: "PASS", attempt: 0, reason: null, startedAt: 1, completedAt: 2,
      cleanup: { worktreeRevoked: false },
      subagentResult: { status: "PASS", testResults: null, testsExecuted: [] },
    },
    {
      nodeId: "W1", phaseExecutionId: "exec_e2e_w1", taskType: "write", dependencies: ["R1"],
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
      nodeId: "V1", phaseExecutionId: "exec_e2e_v1", taskType: "verify", dependencies: ["W1"],
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

const stateFor = (cardId, { contract = DECLARED_CONTRACT, boundDigest = undefined } = {}) => ({
  schema: CLOSEOUT_STATE_SCHEMA,
  task: { cardId, cardTitle: `${cardId} title`, cardType: "implementation" },
  requiresReview: true,
  reviewRequiredAt: "2026-09-21T00:00:00.000Z",
  outDir: join(OUT, cardId),
  authorizedScope: ["src/governance/review-bundle.mjs"],
  unauthorizedScope: ["commit", "push", "merge", "seal"],
  designDecisions: ["semantic drift gate e2e"],
  objective: `${cardId}: real product E2E for the semantic drift gate`,
  negativeCases: ["in-place contract mutation after digest binding"],
  regression: [{ suite: "test:governance", tests: 1, pass: 1, fail: 0 }],
  regressionSummary: "focused tests pass",
  recommendedNextStep: "external review",
  repairBudgetMaxAttempts: 1,
  ...(contract ? { successContract: contract } : {}),
  ...(boundDigest !== undefined ? { successContractDigest: boundDigest } : {}),
});

const drive = async (cardId, opts = {}) => {
  const state = opts.state ?? stateFor(cardId, { boundDigest: successContractDigestOf(DECLARED_CONTRACT) });
  const statePath = closeoutStatePath(state.outDir ?? join(OUT, cardId));
  writeCloseoutState({ path: statePath, state });
  return runStateDrivenCloseout({
    statePath,
    graphResult: opts.graphResult ?? passGraph,
    repoPath: REPO_A,
    cwd: REPO_A,
    outDir: join(OUT, cardId),
    timeoutMs: 20000,
    surfaceDir: join(ROOT, `surface-${cardId}`),
  });
};

// ── E2E 1: the real trigger closes a bound card whose semantics are intact ─

async function e2e1() {
  const cardId = "E2E-1-INTACT";
  const r = await drive(cardId);
  const trioOk = ["review-bundle.txt", "delivery.json"].every((f) =>
    existsSync(join(ROOT, `surface-${cardId}`, f)));
  record("E2E1_CANONICAL_TRIGGER_PASS",
    r.final === "PASS" && trioOk,
    `canonical state-driven closeout: final=${r.final}, surface trio delivered=${trioOk}, bundle=${r.bundlePath ? "written" : "absent"}`);

  // The persisted state record now carries the APPLIED disposition.
  const st = readCloseoutState(closeoutStatePath(join(OUT, cardId)));
  record("E2E1_PERSISTED_DISPOSITION",
    st.ok && st.state.closeout?.status === "APPLIED" && st.state.closeout?.final === "PASS",
    `authoritative persisted state: closeout.status=${st.state?.closeout?.status}, final=${st.state?.closeout?.final}`);

  record("E2E1_BUNDLE_VALIDATES",
    validateReviewBundle(r.bundlePath, { authorizedDir: join(OUT, cardId) }).ok === true,
    "delivered bundle validates against the canonical bundle validator");
  record("E2E1_ORACLE_RECORD_PRESENT",
    r.oracle?.pass === true,
    "closeout disposition carries THE PASS-oracle decision (oracle.pass=true)");
}

// ── E2E 2: drift HOLD on the real trigger — semantics mutated in place ─────

async function e2e2() {
  const cardId = "E2E-2-DRIFT";
  const mutated = {
    ...DECLARED_CONTRACT,
    requiredChecks: [{ id: "suite-alpha", kind: "regression-suite", suite: "test:governance" }],
  };
  const r = await drive(cardId, {
    state: stateFor(cardId, { contract: mutated, boundDigest: successContractDigestOf(DECLARED_CONTRACT) }),
  });
  const noDelivery = !existsSync(join(ROOT, `surface-${cardId}`, "review-bundle.txt"));
  record("E2E2_DRIFT_FAIL_CLOSED",
    r.final === "HOLD" && r.holdCode === CLOSEOUT_HOLDS.SEMANTIC_DRIFT && noDelivery,
    `drifted semantics: final=${r.final} holdCode=${r.holdCode}, surface delivery blocked=${noDelivery}`);

  // The drift HOLD is persisted as a retryable non-PASS disposition — never
  // an APPLIED PASS.
  const st = readCloseoutState(closeoutStatePath(join(OUT, cardId)));
  const persistedNotPass = !st.state?.closeout || st.state.closeout.final !== "PASS";
  record("E2E2_NO_PASS_MINTED", persistedNotPass,
    `persisted disposition never minted PASS (${st.state?.closeout?.final ?? "none"})`);
}

// ── E2E 3: semantics removed after binding → drift on the real trigger ─────

async function e2e3() {
  const cardId = "E2E-3-REMOVED";
  const r = await drive(cardId, {
    state: stateFor(cardId, { contract: null, boundDigest: successContractDigestOf(DECLARED_CONTRACT) }),
  });
  record("E2E3_REMOVAL_FAIL_CLOSED",
    r.final === "HOLD" && r.holdCode === CLOSEOUT_HOLDS.SEMANTIC_DRIFT,
    `removed declared semantics: final=${r.final} holdCode=${r.holdCode} (${r.reason?.slice(0, 80)})`);
}

// ── E2E 4: legacy record (no contract, no digest) closes out unchanged ─────

async function e2e4() {
  const cardId = "E2E-4-LEGACY";
  const r = await drive(cardId, { state: stateFor(cardId, { contract: null }) });
  record("E2E4_LEGACY_COMPAT",
    r.final === "PASS",
    `pre-Drift-Gate record with no contract/digest: final=${r.final} (no retro-fencing)`);
}

// ── E2E 5: repair loop — authorized re-declaration unblocks the card ───────

async function e2e5() {
  // A drifted card is retryable: the operator re-declares the contract and
  // re-binds the digest in the persisted record (the durable-state fix), and
  // the SAME trigger then closes the card. This proves the gate is a fence,
  // not a permanent lock — the recorded disposition stays retryable.
  const cardId = "E2E-5-REPAIR";
  const statePath = closeoutStatePath(join(OUT, cardId));
  writeCloseoutState({
    path: statePath,
    state: stateFor(cardId, {
      contract: { ...DECLARED_CONTRACT, requiredChecks: [] }, // drifted declaration
      boundDigest: successContractDigestOf(DECLARED_CONTRACT),
    }),
  });
  const drifted = await runStateDrivenCloseout({
    statePath, graphResult: passGraph, repoPath: REPO_A, cwd: REPO_A,
    outDir: join(OUT, cardId), timeoutMs: 20000, surfaceDir: join(ROOT, `surface-${cardId}`),
  });
  const driftBlocked = drifted.final === "HOLD" && drifted.holdCode === CLOSEOUT_HOLDS.SEMANTIC_DRIFT;

  // authorized re-declaration: re-bind the digest to the corrected contract
  const repaired = readCloseoutState(statePath);
  const fixedState = {
    ...repaired.state,
    successContract: DECLARED_CONTRACT,
    successContractDigest: successContractDigestOf(DECLARED_CONTRACT),
  };
  writeCloseoutState({ path: statePath, state: fixedState });
  const pass = await runStateDrivenCloseout({
    statePath, graphResult: passGraph, repoPath: REPO_A, cwd: REPO_A,
    outDir: join(OUT, cardId), timeoutMs: 20000, surfaceDir: join(ROOT, `surface-${cardId}`),
  });
  record("E2E5_DRIFT_THEN_REPAIR",
    driftBlocked && pass.final === "PASS",
    `drift HOLD=${driftBlocked} → authorized re-declaration → final=${pass.final} (fence is retryable, not a lock)`);
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(ARCHIVE, { recursive: true });
process.env.AUTOLOOP_REVIEW_SURFACE = join(ROOT, "env-surface");
process.env.AUTOLOOP_REVIEW_ARCHIVE = ARCHIVE;

try {
  await e2e1();
  await e2e2();
  await e2e3();
  await e2e4();
  await e2e5();
} finally {
  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSEMANTIC_DRIFT_E2E: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log("FAILED:", failed.map((f) => f.id).join(", "));
  process.exit(1);
}
rmSync(ROOT, { recursive: true, force: true });
console.log("VERDICT: PASS / SEMANTIC_DRIFT_GATE_REAL_PRODUCT_E2E");
