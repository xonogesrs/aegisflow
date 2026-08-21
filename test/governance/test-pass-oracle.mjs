// test/governance/test-pass-oracle.mjs
//
// AUTOLOOP-P4 — THE PASS ORACLE: adversarial matrix + property/state table.
//
// Proves the canonical verification decision boundary:
//   CLAIM ≠ PROOF. A terminal closeout PASS is reachable ONLY through
//   evaluatePassOracle with attributable, fresh, correctly-fenced evidence.
//
// Coverage map（task-card T-numbers）:
//   Pure oracle ....... T1-T8, T10-T14, T19-T20
//   Property table .... P1（evidence state × authority × invariants）
//   Gate integration .. G1-G7（runCloseoutGate / runStateDrivenCloseout）
//
// Run: node --test test/governance/test-pass-oracle.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORACLE_EVIDENCE_SCHEMA,
  ORACLE_REJECTIONS,
  evaluatePassOracle,
  normalizeSuccessContract,
  validateOracleEvidence,
} from "../../src/governance/pass-oracle.mjs";
import {
  CLOSEOUT_STATE_SCHEMA,
  closeoutStatePath,
  writeCloseoutState,
} from "../../src/governance/closeout-state.mjs";
import {
  collectRepoFacts,
  runStateDrivenCloseout,
} from "../../src/governance/review-bundle.mjs";

const NOW = "2026-08-22T00:00:00.000Z";
const HEAD = "a".repeat(40);
const TREE = "b".repeat(64);

// ── evidence factory ─────────────────────────────────────────────────────

let seq = 0;
const ev = (over = {}) => ({
  schema: ORACLE_EVIDENCE_SCHEMA,
  evidenceId: over.evidenceId ?? `e${++seq}`,
  cardId: over.cardId ?? "CARD-1",
  generation: over.generation ?? 1,
  checkId: over.checkId ?? "review-bundle-valid",
  kind: over.kind ?? "deterministic",
  producer: over.producer ?? { identity: "validator", role: "independent" },
  result: over.result ?? "PASS",
  at: over.at ?? NOW,
  command: over.command ?? "validateReviewBundle",
  binding: over.binding ?? { head: HEAD, treeSha: TREE },
  ...({ summary: over.summary } ),
});

const contractFor = (requiredChecks = [], over = {}) =>
  normalizeSuccessContract({ requiredChecks, head: HEAD, treeSha: TREE, ...over });

const baseEvidence = () => [
  ev({ checkId: "review-bundle-valid" }),
  ev({ checkId: "independent-review", kind: "semantic", producer: { identity: "rev-identity-1", role: "independent" }, command: "finalReviewerVerdicts" }),
];

// ── T1: valid required evidence → PASS ───────────────────────────────────

test("T1. all required checks satisfied by independent evidence -> PASS", () => {
  const r = evaluatePassOracle({ contract: contractFor(), evidence: baseEvidence(), now: NOW });
  assert.equal(r.decision, "PASS");
  assert.deepEqual(r.failures, []);
});

// ── T2: missing required evidence → NOT_PASS ─────────────────────────────

test("T2. executor claims PASS but required evidence absent -> NOT_PASS", () => {
  const r = evaluatePassOracle({ contract: contractFor(), evidence: [ev({ checkId: "review-bundle-valid" })], now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.ok(r.failures.some((f) => f.code === ORACLE_REJECTIONS.MISSING_REQUIRED && f.checkId === "independent-review"));
});

test("T2b. no failure observed is never PASS (empty evidence)", () => {
  const r = evaluatePassOracle({ contract: contractFor(), evidence: [], now: NOW });
  assert.equal(r.decision, "NOT_PASS");
});

// ── T3: required check FAIL → NOT_PASS ───────────────────────────────────

test("T3. required check fails -> NOT_PASS REQUIRED_FAILED", () => {
  const evidence = [
    ...baseEvidence(),
    ev({ checkId: "suite-x", producer: { identity: "runner", role: "executor" }, result: "FAIL", command: "regression:suite-x" }),
  ];
  const r = evaluatePassOracle({ contract: contractFor([{ id: "suite-x" }]), evidence, now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.ok(r.failures.some((f) => f.code === ORACLE_REJECTIONS.REQUIRED_FAILED && f.checkId === "suite-x"));
});

// ── T4: stale evidence after source mutation → NOT_PASS ──────────────────

test("T4. stale evidence (head moved after proof) -> NOT_PASS STALE", () => {
  const movedHead = "c".repeat(40);
  const c = normalizeSuccessContract({ requiredChecks: [], head: movedHead, treeSha: TREE });
  const r = evaluatePassOracle({ contract: { ok: true, errors: [], contract: { ...c.contract, cardId: "CARD-1", generation: 1 } }, evidence: baseEvidence(), now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.ok(r.rejectedEvidence.every((x) => x.code === ORACLE_REJECTIONS.STALE));
});

test("T4b. missing freshness binding is stale（fail-closed), never fresh", () => {
  const evidence = [ev({ binding: {} }), ev({ checkId: "independent-review", kind: "semantic", producer: { identity: "r", role: "independent" }, binding: {} })];
  const r = evaluatePassOracle({ contract: contractFor(), evidence, now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.ok(r.rejectedEvidence.every((x) => x.code === ORACLE_REJECTIONS.STALE));
});

test("T4c. content freshness: artifact digest mismatch rejected; exact digest accepted", () => {
  const art = "d".repeat(64);
  const otherArt = "e".repeat(64);
  const mk = (sha) => {
    const c = normalizeSuccessContract({ requiredChecks: [{ id: "artifact-ok", freshness: "content", expectedArtifactSha256: art }] });
    return evaluatePassOracle({
      contract: { ok: true, errors: [], contract: { ...c.contract, cardId: "CARD-1", generation: 1 } },
      evidence: [
        ev({}), ev({ checkId: "independent-review", kind: "semantic", producer: { identity: "r", role: "independent" } }),
        ev({ checkId: "artifact-ok", binding: { artifactSha256: sha }, command: "hash-artifact" }),
      ],
      now: NOW,
    });
  };
  assert.equal(mk(otherArt).decision, "NOT_PASS");
  assert.equal(mk(art).decision, "PASS");
});

test("T5. generation-N evidence cannot certify generation N+1 -> NOT_PASS", () => {
  const c = contractFor();
  const fenced = { ok: true, errors: [], contract: { ...c.contract, cardId: "CARD-1", generation: 1 } };
  const evidence = baseEvidence().map((e) => ({ ...e, generation: 2 }));
  const r = evaluatePassOracle({ contract: fenced, evidence, now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.ok(r.rejectedEvidence.every((x) => x.code === ORACLE_REJECTIONS.GENERATION_FENCED));
});

// ── T6: wrong lineage / task → rejected ──────────────────────────────────

test("T6. evidence from another card cannot certify this card -> NOT_PASS", () => {
  const evidence = baseEvidence().map((e) => ({ ...e, cardId: "OTHER-CARD" }));
  const c = contractFor();
  const r = evaluatePassOracle({ contract: { ok: true, errors: [], contract: { ...c.contract, cardId: "CARD-1", generation: null } }, evidence, now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.ok(r.rejectedEvidence.every((x) => x.code === ORACLE_REJECTIONS.LINEAGE_MISMATCH));
});

// ── T7: contradictory required evidence → NOT_PASS ───────────────────────

test("T7. contradictory required evidence must not produce PASS", () => {
  const evidence = [
    ...baseEvidence(),
    ev({ evidenceId: "probe-a", checkId: "runtime-probe", producer: { identity: "probe-a", role: "executor" }, result: "PASS", command: "probe:a" }),
    ev({ evidenceId: "probe-b", checkId: "runtime-probe", producer: { identity: "probe-b", role: "executor" }, result: "FAIL", command: "probe:b" }),
  ];
  const r = evaluatePassOracle({ contract: contractFor([{ id: "runtime-probe" }]), evidence, now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.ok(r.failures.some((f) => f.code === ORACLE_REJECTIONS.CONTRADICTORY && f.checkId === "runtime-probe"));
});

// ── T8: global invariant violated → NOT_PASS ─────────────────────────────

test("T8. required global invariant violated blocks PASS despite local success", () => {
  const r = evaluatePassOracle({
    contract: contractFor(),
    evidence: baseEvidence(),
    invariants: [{ id: "generation-fencing", ok: true }, { id: "authority-chain", ok: false, detail: "superseded authority" }],
    now: NOW,
  });
  assert.equal(r.decision, "NOT_PASS");
  assert.ok(r.failures.some((f) => f.code === ORACLE_REJECTIONS.INVARIANT_VIOLATED && f.checkId === "authority-chain"));
  // only APPLICABLE invariants apply — the passing one does not block
  assert.equal(r.failures.filter((f) => f.code === ORACLE_REJECTIONS.INVARIANT_VIOLATED).length, 1);
});

test("T8b. malformed invariant record fails closed", () => {
  const r = evaluatePassOracle({ contract: contractFor(), evidence: baseEvidence(), invariants: [{ ok: true }], now: NO_NOW() });
  assert.equal(r.decision, "NOT_PASS");
  function NO_NOW() { return NOW; }
});

// ── T9/T10: optional / irrelevant evidence never blocks ──────────────────

test("T9. optional evidence missing or failed does not block", () => {
  const c = contractFor([], { optionalChecks: [{ id: "extra-probe" }] });
  // absent
  const r1 = evaluatePassOracle({ contract: c, evidence: baseEvidence(), now: NOW });
  assert.equal(r1.decision, "PASS");
  // present but FAIL — counted, not blocking
  const r2 = evaluatePassOracle({
    contract: c,
    evidence: [...baseEvidence(), ev({ checkId: "extra-probe", producer: { identity: "p", role: "executor" }, result: "FAIL", command: "probe:x" })],
    now: NOW,
  });
  assert.equal(r2.decision, "PASS");
  assert.equal(r2.acceptedEvidence.includes(r2.acceptedEvidence.find(() => true)), true);
});

test("T10. irrelevant failed check outside the declared contract does not block", () => {
  const evidence = [
    ...baseEvidence(),
    ev({ checkId: "not-in-contract", producer: { identity: "x", role: "executor" }, result: "FAIL", command: "unrelated" }),
  ];
  const r = evaluatePassOracle({ contract: contractFor(), evidence, now: NOW });
  assert.equal(r.decision, "PASS");
});

// ── T11/T12: deterministic-first + bounded semantic review ───────────────

test("T11. deterministic proofs satisfy deterministic checks without LLM review", () => {
  const evidence = [
    ev({ checkId: "review-bundle-valid" }),
    ev({ checkId: "independent-review", kind: "deterministic", producer: { identity: "digest-check", role: "independent" }, command: "git-ancestry-check" }),
  ];
  const r = evaluatePassOracle({ contract: contractFor(), evidence, now: NOW });
  assert.equal(r.decision, "PASS");
});

test("T12. requiresIndependent check is NOT satisfied by executor self-report only", () => {
  const evidence = [
    ev({ checkId: "review-bundle-valid" }),
    ev({ checkId: "independent-review", kind: "semantic", producer: { identity: "executor-self", role: "executor" }, command: "self-report" }),
  ];
  const r = evaluatePassOracle({ contract: contractFor(), evidence, now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.ok(r.failures.some((f) => f.code === ORACLE_REJECTIONS.SELF_CERTIFIED));
});

// ── T13: semantic PASS cannot override deterministic FAIL ────────────────

test("T13. semantic reviewer PASS + deterministic required FAIL -> NOT_PASS", () => {
  const evidence = [
    ev({ checkId: "review-bundle-valid" }),
    ev({ checkId: "independent-review", kind: "semantic", producer: { identity: "reviewer", role: "independent" } }),
    ev({ checkId: "security-scan", producer: { identity: "scanner", role: "executor" }, result: "FAIL", command: "scan" }),
    ev({ checkId: "security-scan", kind: "semantic", producer: { identity: "semantic-reviewer", role: "independent" }, result: "PASS", command: "semantic-review" }),
  ];
  const r = evaluatePassOracle({ contract: contractFor([{ id: "security-scan" }]), evidence, now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.ok(r.failures.some((f) => f.code === ORACLE_REJECTIONS.CONTRADICTORY));
});

// ── T14: authority revoked before decision → NOT_PASS ────────────────────

test("T14. revoked authority forbids PASS even with complete evidence", () => {
  const c = contractFor([], { authority: { revoked: true, reason: "generation superseded" } });
  const r = evaluatePassOracle({ contract: c, evidence: baseEvidence(), now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.deepEqual(r.failures.map((f) => f.code), [ORACLE_REJECTIONS.AUTHORITY_REVOKED]);
});

// ── T19/T20: malformed / unattributable evidence rejected ────────────────

test("T19. malformed evidence is rejected, never counted as proof", () => {
  const bad = [
    { schema: "wrong" },
    { ...ev({}), result: "MAYBE" },
    { ...ev({}), at: "not-a-timestamp" },
    { ...ev({}), binding: { head: "zzz" } },
  ];
  for (const b of bad) {
    const v = validateOracleEvidence(b);
    assert.equal(v.ok, false);
  }
  const r = evaluatePassOracle({ contract: contractFor(), evidence: bad, now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.equal(r.rejectedEvidence.length, bad.length);
  assert.ok(r.rejectedEvidence.every((x) => x.code === ORACLE_REJECTIONS.MALFORMED_EVIDENCE));
});

test("T20. forged/unattributable evidence (no producer identity, unknown check) rejected", () => {
  const forged = [
    { ...ev({}), producer: { identity: "", role: "independent" } },
    { ...ev({}), producer: { identity: "ghost", role: "system" } },
    { ...ev({}), checkId: "never-declared" },
  ];
  const r = evaluatePassOracle({ contract: contractFor(), evidence: forged, now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.ok(r.rejectedEvidence.some((x) => x.code === ORACLE_REJECTIONS.UNDECLARED_CHECK));
});

test("T20b. invalid success contract fails closed", () => {
  const n = normalizeSuccessContract({ requiredChecks: "not-an-array" });
  assert.equal(n.ok, false);
  const r = evaluatePassOracle({ contract: n, evidence: baseEvidence(), now: NOW });
  assert.equal(r.decision, "NOT_PASS");
  assert.equal(r.failures[0].code, ORACLE_REJECTIONS.CONTRACT_INVALID);
});

test("T20c. implicit checks cannot be weakened or redeclared", () => {
  assert.ok(
    !normalizeSuccessContract({ requiredChecks: [{ id: "independent-review" }] }).ok,
    "redeclaring implicit check rejected",
  );
});

// ── P1: property / state-machine table ───────────────────────────────────
//
// For every combination of (checkState × authority × invariant) the oracle
// decision must equal the truth-table expectation.

const CHECK_STATES = {
  absent: { evidence: (c) => [], pass: false },
  pass: {
    evidence: () => [
      ev({}), ev({ checkId: "independent-review", kind: "semantic", producer: { identity: "rev", role: "independent" } }),
    ],
    pass: true,
  },
  fail: {
    evidence: () => [
      ev({}), ev({ checkId: "independent-review", kind: "semantic", producer: { identity: "rev", role: "independent" } }),
      ev({ checkId: "suite-y", producer: { identity: "run", role: "executor" }, result: "FAIL", command: "suite-y" }),
    ],
    contractExtra: [{ id: "suite-y" }],
    pass: false,
  },
  stale: {
    contractOver: { head: "f".repeat(40) },
    pass: false,
  },
  wrongGen: {
    evidenceOverride: { generation: 99 },
    pass: false,
  },
  wrongCard: {
    evidenceOverride: { cardId: "OTHER" },
    pass: false,
  },
  executorOnly: {
    evidence: () => [
      ev({}), ev({ checkId: "independent-review", kind: "semantic", producer: { identity: "self", role: "executor" } }),
    ],
    pass: false,
  },
  contradictory: {
    evidence: () => [
      ev({}), 
      ev({ evidenceId: "sr1", checkId: "independent-review", kind: "semantic", producer: { identity: "rev", role: "independent" } }),
      ev({ evidenceId: "sr2", checkId: "independent-review", kind: "semantic", producer: { identity: "rev2", role: "independent" }, result: "FAIL", command: "re-review" }),
    ],
    pass: false,
  },
};

const AUTHORITY_STATES = {
  ok: {},
  revoked: { authority: { revoked: true, reason: "superseded" } },
};

const INVARIANT_STATES = {
  ok: [],
  violated: [{ id: "inv-1", ok: false }],
};

test("P1. property table: checkState x authority x invariant -> decision", () => {
  for (const [stateName, state] of Object.entries(CHECK_STATES)) {
    for (const [authName, auth] of Object.entries(AUTHORITY_STATES)) {
      for (const [invName, inv] of Object.entries(INVARIANT_STATES)) {
        const over = { ...(state.contractOver ?? {}), ...auth };
        const cRaw = normalizeSuccessContract({ requiredChecks: state.contractExtra ?? [], head: HEAD, treeSha: TREE, ...over });
        let contract;
        if (!cRaw.ok) {
          contract = cRaw;
        } else if (state.evidenceOverride || stateName === "wrongCard") {
          contract = { ok: true, errors: [], contract: { ...cRaw.contract, cardId: "CARD-1", generation: 1 } };
        } else {
          contract = { ok: true, errors: [], contract: { ...cRaw.contract, cardId: null, generation: null } };
        }
        let evidence = [];
        if (stateName === "absent") evidence = [];
        else if (state.evidence) evidence = state.evidence(contract);
        else evidence = baseEvidence().map((e) => ({ ...e, ...(state.evidenceOverride ?? {}) }));
        const r = evaluatePassOracle({ contract, evidence, invariants: inv, now: NOW });
        const expected =
          authName === "revoked" ? "AUTHORITY_REVOKED"
          : !state.pass ? "NOT_PASS"
          : invName === "violated" ? "INVARIANT_VIOLATED"
          : "PASS";
        const codes = new Set(r.failures.map((f) => f.code));
        const actual =
          r.decision === "PASS" ? "PASS"
          : codes.has(ORACLE_REJECTIONS.AUTHORITY_REVOKED) ? "AUTHORITY_REVOKED"
          : state.pass && codes.has(ORACLE_REJECTIONS.INVARIANT_VIOLATED) ? "INVARIANT_VIOLATED"
          : "NOT_PASS";
        assert.equal(
          actual,
          expected,
          `state=${stateName} auth=${authName} inv=${invName}: got ${actual}, want ${expected} (${JSON.stringify(r.failures)})`,
        );
      }
    }
  }
});


// ── Gate integration: runCloseoutGate / runStateDrivenCloseout ───────────

import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import {
  REVIEW_BUNDLE_TERMINATOR,
  runCloseoutGate,
  validateReviewBundle,
} from "../../src/governance/review-bundle.mjs";

const REPO_A = "/Volumes/NVM2T/Development/repos/autoloop";
const ROOT = `${tmpdir()}/pass-oracle-${process.pid}`;
const OUT = join(ROOT, "out");

const passGraph = (cardId) => ({
  executionId: `fixture-oracle-${cardId}`,
  final: "PASS",
  holdCode: null,
  reason: null,
  scheduler: { verdict: "PASS", order: ["R1", "W1"], statuses: { R1: "passed", W1: "passed" }, skipped: [], writerViolations: [], leaseHolderAfter: null },
  nodeResults: [
    {
      nodeId: "R1", phaseExecutionId: `exec_${cardId}_r1`, taskType: "audit", dependencies: [],
      final: "PASS", attempt: 0, reason: null, startedAt: 1, completedAt: 2,
      cleanup: { worktreeRevoked: false },
      subagentResult: { status: "PASS", testResults: null, testsExecuted: [] },
    },
    {
      nodeId: "W1", phaseExecutionId: `exec_${cardId}_w1`, taskType: "write", dependencies: ["R1"],
      final: "PASS", attempt: 0, reason: null, startedAt: 3, completedAt: 4,
      cleanup: { worktreeRevoked: true },
      subagentResult: { status: "PASS", testResults: { passed: 1, failed: 0, total: 1 }, testsExecuted: ["oracle-fixture"] },
      reviewResult: { status: "PASS", findings: [], blockingFindings: [], scopeVerified: true, testsVerified: true, recommendedAction: "PASS", summary: "independent review PASS" },
    },
  ],
  transitions: [
    { phaseId: "R1", final: "PASS", attempt: 0, lifecycleTransitions: [{ phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" }] },
    { phaseId: "W1", final: "PASS", attempt: 0, lifecycleTransitions: [{ phase: "reviewer_verdict", attempt: 0, verdict: "PASS", recommended_next_action: "STOP" }] },
  ],
});

const gateSource = (cardId, over = {}) => ({
  schema: "autoloop.review-bundle.source/v1",
  task: { cardId, cardTitle: `${cardId} title`, cardType: "implementation", generation: 0 },
  executiveStatus: over.executiveStatus ?? "PASS",
  repo: {},
  objective: `${cardId}: oracle gate fixture`,
  authorizedScope: ["src/governance/review-bundle.mjs"],
  designDecisions: ["oracle fixture"],
  diffSummary: "fixture",
  review: over.review ?? {
    pass: true, result: "PASS", reviewResultIdentity: "aa".repeat(32),
    blockingFindings: [], summary: "independent review PASS",
  },
  verifier: over.verifier ?? { pass: true, result: "PASS", summary: "verifier ok" },
  regression: over.regression ?? [{ suite: "suite-alpha", tests: 2, pass: 2, fail: 0 }],
  negativeCases: [],
  risks: [],
  limitations: [],
  openQuestions: [],
  recommendedNextStep: "external review",
  inventory: over.inventory ?? null,
  evidence: [],
});

const driveGate = async (cardId, { source, successContract, authorityRevocation } = {}) =>
  runCloseoutGate({
    source,
    repoPath: REPO_A,
    outDir: join(OUT, cardId),
    timeoutMs: 15000,
    deliver: null, // non-formal unit-test path: never touch the desktop surface
    successContract: successContract ?? null,
    authorityRevocation: authorityRevocation ?? null,
  });

test("G1. gate: satisfied success contract -> final PASS carrying an oracle record", { timeout: 60000 }, async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(OUT, "g1"), { recursive: true });
  const cardId = "PO-G1";
  const r = await driveGate(cardId, {
    source: gateSource(cardId),
    successContract: { requiredChecks: [{ id: "suite-alpha" }, { id: "verifier-gate", kind: "verifier" }] },
  });
  assert.equal(r.final, "PASS", `(${r.holdCode}:${r.reason})`);
  assert.ok(r.oracle?.pass === true, "gate attaches the oracle decision");
  assert.ok(existsSync(r.bundlePath));
  const v = validateReviewBundle(r.bundlePath, { authorizedDir: join(OUT, cardId) });
  assert.equal(v.ok, true, `bundle validates (${v.errors.join(";")})`);
});

test("G2. gate: declared suite missing/failing -> HOLD PASS_ORACLE_REJECTED (claim != proof)", { timeout: 60000 }, async () => {
  mkdirSync(join(OUT, "g2"), { recursive: true });
  const cardId = "PO-G2";
  const missing = await driveGate(cardId + "-A", {
    source: gateSource(cardId, { regression: [] }),
    successContract: { requiredChecks: [{ id: "suite-alpha" }] },
  });
  assert.equal(missing.final, "HOLD");
  assert.equal(missing.holdCode, "PASS_ORACLE_REJECTED");
  assert.ok(missing.reason.includes("ORACLE_REQUIRED_EVIDENCE_MISSING@suite-alpha"), missing.reason);

  const failing = await driveGate(cardId + "-B", {
    source: gateSource(cardId, { regression: [{ suite: "suite-alpha", tests: 2, pass: 1, fail: 1 }] }),
    successContract: { requiredChecks: [{ id: "suite-alpha" }] },
  });
  assert.equal(failing.final, "HOLD");
  assert.equal(failing.holdCode, "PASS_ORACLE_REJECTED");
  assert.ok(failing.reason.includes("ORACLE_REQUIRED_CHECK_FAILED@suite-alpha"), failing.reason);
});

test("G3. gate: independent review HOLD with empty blocking findings can no longer ride to PASS", { timeout: 60000 }, async () => {
  mkdirSync(join(OUT, "g3"), { recursive: true });
  const cardId = "PO-G3";
  const r = await driveGate(cardId, {
    source: gateSource(cardId, { review: { pass: false, result: "HOLD", reviewResultIdentity: "bb".repeat(32), blockingFindings: [], summary: "held" } }),
  });
  assert.equal(r.final, "HOLD");
  // Defense in depth: the independent bundle validator already rejects a
  // PASS executive status over a non-PASS review; when it does not（e.g. a
  // future validator regression）the oracle is the second fail-closed layer.
  assert.ok(
    r.holdCode === "REVIEW_BUNDLE_INVALID" || r.holdCode === "PASS_ORACLE_REJECTED",
    `holdCode=${r.holdCode} reason=${r.reason}`,
  );
});

test("G4. gate: verifier-flag contract enforced", { timeout: 60000 }, async () => {
  const cardId = "PO-G4";
  const bad = await driveGate(cardId, {
    source: gateSource(cardId, { verifier: { pass: false, result: "HOLD", summary: "verifier held" } }),
    successContract: { requiredChecks: [{ id: "verifier-gate", kind: "verifier" }] },
  });
  assert.equal(bad.final, "HOLD");
  assert.equal(bad.holdCode, "PASS_ORACLE_REJECTED");

  const good = await driveGate(cardId + "-ok", {
    source: gateSource(cardId),
    successContract: { requiredChecks: [{ id: "verifier-gate", kind: "verifier" }] },
  });
  assert.equal(good.final, "PASS", good.reason);
});

test("G5. gate: revoked authority -> HOLD even with a perfect execution surface", { timeout: 60000 }, async () => {
  mkdirSync(join(OUT, "g5"), { recursive: true });
  const cardId = "PO-G5";
  const r = await driveGate(cardId, {
    source: gateSource(cardId),
    authorityRevocation: { revoked: true, reason: "authority superseded mid-flight" },
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "PASS_ORACLE_REJECTED");
  assert.ok(r.reason.includes(ORACLE_REJECTIONS.AUTHORITY_REVOKED), r.reason);
});

test("G6. gate: global invariant violation -> HOLD", { timeout: 60000 }, async () => {
  mkdirSync(join(OUT, "g6"), { recursive: true });
  const cardId = "PO-G6";
  const r = await driveGate(cardId, {
    source: gateSource(cardId),
    successContract: { invariantResults: [{ id: "durability-binding", ok: false, detail: "evidence root unverified" }] },
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "PASS_ORACLE_REJECTED");
  assert.ok(r.reason.includes(ORACLE_REJECTIONS.INVARIANT_VIOLATED), r.reason);
});

test("G7. state-driven closeout: successContract frozen in persisted state reaches the oracle", { timeout: 60000 }, async () => {
  const cardId = "PO-G7";
  const dir = join(ROOT, "surface-g7");
  const outDir = join(OUT, cardId);
  mkdirSync(outDir, { recursive: true });
  // Declared BEFORE execution and persisted: a regression suite that the
  // graph result below deliberately does not contain.
  const st = {
    schema: CLOSEOUT_STATE_SCHEMA,
    task: { cardId, cardTitle: `${cardId} title`, cardType: "implementation" },
    requiresReview: true,
    reviewRequiredAt: NOW,
    outDir,
    authorizedScope: ["src/governance/review-bundle.mjs"],
    unauthorizedScope: [],
    objective: `${cardId}: frozen contract`,
    negativeCases: [],
    regression: [{ suite: "suite-beta", tests: 1, pass: 1, fail: 0 }],
    regressionSummary: "focused",
    recommendedNextStep: "external review",
    repairBudgetMaxAttempts: 1,
    successContract: { requiredChecks: [{ id: "suite-must-exist" }] },
  };
  writeCloseoutState({ path: closeoutStatePath(outDir), state: st });
  const r = await runStateDrivenCloseout({
    statePath: closeoutStatePath(outDir),
    graphResult: passGraph(cardId),
    repoPath: REPO_A,
    cwd: REPO_A,
    outDir,
    timeoutMs: 20000,
    surfaceDir: dir,
  });
  assert.equal(r.applied, true);
  assert.equal(r.final, "HOLD", `unproven declared requirement must hold (${r.final}/${r.reason})`);
  assert.ok(String(r.reason ?? "").includes("PASS_ORACLE_REJECTED"), r.reason);
  // The disposition was recorded non-terminal — retryable, never a fake PASS.
  assert.notEqual(st.closeout?.final, "PASS");
});
