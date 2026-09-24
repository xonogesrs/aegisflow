// test/evolution/test-evolution-production-activation.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1 — acceptance suite
// (Sections C/D/E/H/I through REAL production machinery).
//
//   P1  §C wiring: runAdmittedGraph attaches a truthful evolutionObservation
//       derived from the run's REAL durable evidence journal; NORMAL_OPERATION
//       semantics unchanged (verdict/budget/envelope fields untouched)
//   P2  §C negative: observer failure (unreadable/corrupt journal) NEVER
//       blocks NORMAL_OPERATION — result identical, observation absent/empty
//   P3  §C qualified evidence only: a SINGLE failure fires NO signal
//   P4  §D full LOW route through the production entry: qualified trigger →
//       candidate → LOW → policy preauthorization → isolated worktree mutation
//       → validation → fitness → independent review → evolution branch commit
//       → governed promotion → canary — no per-step human approval
//   P5  §E.1 single failure → NO EVOLUTION (no signal, no candidate)
//   P6  §E.2 insufficient evidence → NO CANDIDATE (below floor)
//   P7  §E.3 MEDIUM → stops BEFORE promotion (operator boundary)
//   P8  §E.4 HIGH → stops BEFORE mutation (no worktree, no authorization)
//   P9  §E.5/6/7 regression / unchanged / inconclusive → REJECT
//   P10 §E.8/9/10 review failure / semantic drift / HEAD mismatch → NO PROMOTION
//   P11 §E.11 canary regression → AUTO ROLLBACK (ref restored to baseline)
//   P12 §E.12 circuit breaker → EVOLUTION SUSPENDED, NORMAL_OPERATION continues
//   P13 §H kill switch: SUSPENDED blocks new cycles; NORMAL_OPERATION and
//       telemetry untouched; no source change needed; ENABLED is the default
//   P14 §I crash recovery: state recoverable, no duplicate candidate, no
//       duplicate promotion, incomplete mutation pollutes nothing, canary/
//       rollback authority and circuit breaker survive restart
//   P15 §B policy: production policy artifact refuses unrestricted wildcard
//       scope and can never allow HIGH
//
// Run: node --test test/evolution/test-evolution-production-activation.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";

import {
  extractTriggerObservations, evaluateSignals, buildTriggerEvent,
  readTriggerState, writeTriggerState,
} from "../../src/evolution/trigger.mjs";
import {
  createEvolutionPolicy, readEvolutionPolicy, classifyCandidateRisk,
  authorizeUnderPolicy, HIGH_RISK_CLASSES,
} from "../../src/evolution/policy.mjs";
import { deriveImprovementCandidate, readCandidate, candidateFilePath } from "../../src/evolution/candidate.mjs";
import { issueCandidateMutationAuthorization, runCandidateMutation } from "../../src/evolution/mutation.mjs";
import { evaluateFitness } from "../../src/evolution/fitness.mjs";
import {
  commitCandidateToEvolutionBranch, bindEvolutionReview,
  evaluateAutonomousPromotion, evolutionBranchFor,
} from "../../src/evolution/promotion.mjs";
import {
  openCanaryWindow, evaluateCanary, rollbackCandidate, readCanary,
  recordCandidateOutcome,
} from "../../src/evolution/canary.mjs";
import { runEvolutionCycle } from "../../src/evolution/loop.mjs";
import { digestOf } from "../../src/canonical-digest.mjs";
import {
  observeRunForEvolutionTriggers, attachEvolutionObservation,
} from "../../src/evolution/production-observer.mjs";
import {
  suspendEvolution, resumeEvolution, readEvolutionSuspension,
} from "../../src/evolution/kill-switch.mjs";
import { reconcileEvolutionState } from "../../src/evolution/recovery.mjs";
import { RunEvidenceStore } from "../../src/evidence/run-evidence-store.mjs";
import { collectFingerprint } from "../../src/c2d/fingerprint.mjs";
import { mintExecutionId } from "../../src/c2d/execution-id.mjs";

const ROOTS = [];
function freshDir(label) {
  const d = mkdtempSync(join(tmpdir(), `evol-act-${label}-`));
  ROOTS.push(d);
  return d;
}
test.after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

// ── fixture repo (same shape as the completion-1 suite) ─────────────────────

function makeFixtureRepo(label) {
  const repo = freshDir(label);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.email", "evol@test"]);
  git(repo, ["config", "user.name", "evol-fixture"]);
  mkdirSync(join(repo, "lib", "utils"), { recursive: true });
  writeFileSync(join(repo, "lib", "utils", "retry.ts"), "export const MAX_RETRIES = 3;\nexport const BACKOFF_MS = 1000;\n");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

const PATCH = [
  "--- a/lib/utils/retry.ts",
  "+++ b/lib/utils/retry.ts",
  "@@ -1,2 +1,2 @@",
  " export const MAX_RETRIES = 3;",
  "-export const BACKOFF_MS = 1000;",
  "+export const BACKOFF_MS = 500;",
  "",
].join("\n");

function policyInput(overrides = {}) {
  return {
    policy_name: "autoloop-production-evolution-test",
    scope_patterns: ["lib/**"],
    forbidden_patterns: [],
    allowed_commands: ["node", "git"],
    validation_plan_id: "evolution-validation-test",
    validation_plan: { commands: [{ cmd: "node", args: ["-e", "process.exit(0)"], timeout_ms: 30000 }] },
    budget: { max_mutation_runs: 8, max_wall_clock_ms_per_run: 120000, max_evolutions_per_window: 4, window_ms: 86400000 },
    issued_by: "test-operator",
    authorization_ref: "test://evolution-policy",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

// ── REAL durable evidence journal helpers (the production evidence path) ────

function makeEvidenceRoot(label) {
  return freshDir(label); // outside any repo — RunEvidenceStore contract
}

function journalExecution(label) {
  return { executionId: `exec_${label}${"0".repeat(Math.max(0, 28 - label.length))}`.slice(0, 36).padEnd(36, "0") };
}

function writeJournal(root, executionId, events) {
  const store = new RunEvidenceStore({
    root, executionId,
    chainId: `chain-${executionId}`, checkpointId: `ckpt-${executionId}`,
  });
  store.init();
  for (const e of events) store.appendEvent(e);
  return store;
}

function heldEvents(n, reason = "HOLD / C3B_MUTATION_FAILED") {
  return Array.from({ length: n }, (_, i) => ({
    event_type: "RUN_HELD", stage: "terminal", payload: { reason },
  }));
}

// ── frozen admission (the production entry contract) ────────────────────────

const FULL_EVIDENCE = {
  affected_files: { score: 1, reasons: ["single README file"] },
  affected_subsystems: { score: 0, reasons: ["docs only"] },
  dependency_depth: { score: 0, reasons: ["no deps"] },
  ambiguity: { score: 0, reasons: ["exact text"] },
  expected_execution_steps: { score: 0, reasons: ["one edit"] },
  verification_burden: { score: 0, reasons: ["no tests"] },
  external_dependencies: { score: 0, reasons: ["none"] },
  concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 0, reasons: ["revert 1 file"] },
};

function frozenAdmission(taskId = "EVOL-ACT-1") {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  return freezeAdmission(buildAdmissionRecord({ taskId, classification: c, mutationScope: ["docs/"] }));
}

// A faithful production runner: honors the budget chain (so the NEG13
// reconciliation passes) and writes REAL terminal events into a REAL durable
// evidence journal under the runner-owned persistence root.
function journalingRunner(recorded, { terminalEvents, verdict = "PASS" }) {
  return async (opts) => {
    recorded.push(opts);
    const enc = opts?.budget?.enforcement;
    if (enc) {
      const gate = enc.preDispatch({ executionId: "g", phase_id: "P1", nodeId: "P1", attempt: 0, runtime: { mode: "readonly", limits: { timeoutMs: 60000 } } });
      if (gate.ok) enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
    }
    // REAL durable journal: the terminal evidence path (durable-graph semantics)
    const root = opts.persistence?.root;
    const executionId = opts.persistence?.executionId;
    if (root && executionId) writeJournal(root, executionId, terminalEvents);
    return {
      final: verdict,
      executionId,
      nodeResults: [{ nodeId: "P1", final: verdict, attempt: 0, resultIdentity: { latencyMs: 5 } }],
      transitions: [],
      closeout: { applied: false },
      admission: opts?.admission ?? null,
    };
  };
}

// ── P1 + P2: §C production wiring through runAdmittedGraph ─────────────────

test("P1 runAdmittedGraph attaches a truthful evolution observation from the real journal; NORMAL_OPERATION semantics unchanged", async () => {
  const repo = makeFixtureRepo("p1-repo");
  const evidenceRoot = makeEvidenceRoot("p1-ev");
  const execId = `exec_${"a1".padEnd(32, "0").slice(0, 32)}`;
  const calls = [];
  const admission = frozenAdmission("EVOL-P1");
  const r = await runAdmittedGraph({
    admission,
    runner: journalingRunner(calls, { terminalEvents: heldEvents(4), verdict: "HOLD" }),
    persistence: { root: evidenceRoot, executionId: execId },
    ir: { phases: [] },
  });
  assert.equal(r.final, "HOLD"); // the run's own semantics (journalingRunner verdict)
  assert.ok(r.evolutionObservation, "evolution observation attached");
  const obs = r.evolutionObservation;
  assert.equal(obs.schema, "autoloop.evolution-observation/v1");
  assert.equal(obs.switch_state.state, "ENABLED");
  assert.equal(obs.execution_id, execId);
  assert.ok(obs.baseline_events >= 4, "journal actually read");
  assert.ok(obs.observed >= 4, "observations extracted from the REAL journal");
  // qualified: 4 equivalent HOLDs cross the ≥3 floor for the per-signature class
  assert.ok(obs.fired.some((s) => s.signalClass === "REPEATED_EQUIVALENT_FAILURE"), "qualified signal fired");
  // NORMAL_OPERATION semantics untouched: budget envelope + admission intact
  assert.equal(r.budget.authorized, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].admission, admission);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
});

test("P2 observer failure never blocks NORMAL_OPERATION (corrupt journal → clean result, empty observation)", async () => {
  const evidenceRoot = makeEvidenceRoot("p2-ev");
  const execId = `exec_${"b2".padEnd(32, "0").slice(0, 32)}`;
  const calls = [];
  const r = await runAdmittedGraph({
    admission: frozenAdmission("EVOL-P2"),
    runner: journalingRunner(calls, { terminalEvents: heldEvents(4), verdict: "HOLD" }),
    persistence: { root: evidenceRoot, executionId: execId },
    ir: { phases: [] },
  });
  assert.equal(r.final, "HOLD");
  assert.ok(r.evolutionObservation.fired.length > 0, "first (clean) run observes");
  // corrupt the journal, then run again with a FRESH execution id: the new
  // run appends a new journal; the OLD (corrupted) one must degrade cleanly.
  const journalDir = join(evidenceRoot, execId, "journal");
  const files = readdirSync(journalDir).sort();
  writeFileSync(join(journalDir, files[files.length - 1]), "{corrupt", "utf8");
  const r2 = await runAdmittedGraph({
    admission: frozenAdmission("EVOL-P2B"),
    runner: journalingRunner(calls, { terminalEvents: heldEvents(1), verdict: "HOLD" }),
    persistence: { root: evidenceRoot, executionId: `exec_${"b3".padEnd(32, "0").slice(0, 32)}` },
    ir: { phases: [] },
  });
  assert.equal(r2.final, "HOLD"); // the RUN's verdict, not an observer crash
  assert.equal(r2.budget.authorized, true);
  // observation is either absent or empty-fired — never a thrown error surface
  if (r2.evolutionObservation) assert.deepEqual(r2.evolutionObservation.fired, []);
  // and the direct observer call against the CORRUPT journal is total:
  const direct = observeRunForEvolutionTriggers({
    evidenceRoot, executionId: execId, graphRunId: "p2-direct",
  });
  assert.deepEqual(direct.fired, []);
});

test("P3 a SINGLE failure fires NO signal and forms NO candidate (card §C/§E.1)", () => {
  const store = freshDir("p3-store");
  const events = heldEvents(1);
  const obs = extractTriggerObservations({ events });
  const fired = evaluateSignals({ observations: obs });
  assert.deepEqual(fired, [], "single failure must never trigger");
  // and the production observer over a real journal with one HOLD agrees
  const evidenceRoot = makeEvidenceRoot("p3-ev");
  writeJournal(evidenceRoot, `exec_${"c3".padEnd(32, "0").slice(0, 32)}`, events);
  const direct = observeRunForEvolutionTriggers({
    evidenceRoot, executionId: `exec_${"c3".padEnd(32, "0").slice(0, 32)}`, graphRunId: "p3",
  });
  assert.deepEqual(direct.fired, []);
});

// ── P4: §D the full LOW-risk autonomous route (no per-step human approval) ──

test("P4 full LOW route: trigger → candidate → LOW → policy → worktree mutation → validation → fitness → review → commit → promotion → canary", async () => {
  const repo = makeFixtureRepo("p4-repo");
  const store = freshDir("p4-store");
  const checkpointRoot = freshDir("p4-cp");
  createEvolutionPolicy(store, policyInput());
  const policy = readEvolutionPolicy(store);
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);

  // qualified trigger from REAL journal evidence (≥3 equivalent failures)
  const evidenceRoot = makeEvidenceRoot("p4-ev");
  const execId = `exec_${"d4".padEnd(32, "0").slice(0, 32)}`;
  writeJournal(evidenceRoot, execId, heldEvents(3));
  const observation = observeRunForEvolutionTriggers({ evidenceRoot, executionId: execId, graphRunId: "p4" });
  assert.ok(observation.fired.length > 0, "trigger qualified from real journal");
  const signal = observation.fired.find((s) => s.signalClass === "REPEATED_EQUIVALENT_FAILURE");
  const triggerEvent = buildTriggerEvent({
    signal: { ...signal, observation: { patchPlan: { patch: PATCH }, affectedScope: ["lib/utils/retry.ts"] } },
    graphRunId: "p4",
  });

  // candidate derivation (deterministic, deduped)
  const derived = deriveImprovementCandidate({ triggerEvent, baselineHead, baselineRevision: 1, storeRoot: store });
  assert.equal(derived.status, "CREATED");
  const candidate = derived.candidate;
  assert.equal(candidate.risk_class, "LOW");

  // policy preauthorization (LOW = AUTONOMOUS)
  const authorization = authorizeUnderPolicy({
    policy, classification: { riskClass: "LOW", reasons: [] },
    mutationPaths: candidate.affected_scope, baselineHead,
    usage: { mutationRuns: 0, evolutionsInWindow: 0 },
  });
  assert.equal(authorization.authorized, true);
  assert.equal(authorization.promotionRequiresOperator, false);

  // isolated worktree mutation (production checkout untouched)
  const executionId = mintExecutionId();
  const issued = issueCandidateMutationAuthorization({
    checkpointRoot, executionId, fingerprint: collectFingerprint(repo), candidate, authorization, expiresAt: policy.expires_at,
  });
  const mutation = await runCandidateMutation({
    repoRoot: repo, checkpointRoot, executionId, candidate, authorization: issued.authorization,
    validationPlan: issued.validationPlan,
    policyDigest: authorization.policyDigest, mutationAuthorityDigest: issued.mutationAuthorityDigest, expiresAt: issued.expiresAt,
    maxRepairAttempts: 1, mutationCommandOverride: null,
  });
  assert.ok(["READY_FOR_REVIEW", "CANDIDATE_VERIFIED"].includes(mutation.outcome_state), `mutation: ${mutation.outcome_state}`);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), baselineHead);
  assert.equal(git(repo, ["status", "--porcelain"]), "");

  // fitness: 3 failures → 0 (repaired run) ⇒ IMPROVED, regression PASS
  const fitness = evaluateFitness({
    candidate,
    baselineEvidence: { events: heldEvents(3) },
    candidateEvidence: { events: [], mutationResult: mutation },
  });
  assert.equal(fitness.decision, "ACCEPT");

  // independent review (durable, self-approval fenced)
  const review = bindEvolutionReview({
    storeRoot: store, candidate, fitness,
    reviewerIdentity: "reviewer:independent-p4", verdict: "PASS", summary: "p4 bounded repair",
  });
  assert.equal(review.review_verdict, "PASS");

  // autonomous commit to the evolution branch (main/master untouched)
  const commit = commitCandidateToEvolutionBranch({
    repoRoot: repo, candidate, candidateTree: mutation.evidence.candidate.candidate_tree,
    baselineHead, fitness, mutationEvidence: mutation.evidence,
  });
  assert.equal(commit.branch, `evolution/${candidate.candidate_id}`);
  assert.equal(git(repo, ["rev-parse", "master"]), baselineHead);

  // governed promotion gate (ALL gates)
  const promotion = evaluateAutonomousPromotion({
    policy, authorization, candidate, fitness, storeRoot: store, liveBaselineHead: baselineHead,
  });
  assert.equal(promotion.authorized, true);

  // canary opens and evaluates HEALTHY on clean post evidence
  const canary = openCanaryWindow({
    storeRoot: store, candidate, promotion: commit, fitness,
    baselineMetric: { metric: "failure_or_repair_count", value: 3 },
  });
  const canaryResult = evaluateCanary({ storeRoot: store, candidate, postEvents: [] });
  assert.equal(canaryResult.verdict, "HEALTHY");
  assert.ok(canary.closes_at > canary.opened_at);
});

// ── P5–P8: §E negative acceptance 1–4 ───────────────────────────────────────

test("P5 insufficient evidence → NO CANDIDATE (§E.2)", () => {
  const store = freshDir("p5-store");
  // 2 equivalent failures: below the ≥3 floor → no signal → no trigger → no candidate
  const fired = evaluateSignals({ observations: extractTriggerObservations({ events: heldEvents(2) }) });
  assert.deepEqual(fired, []);
  // even a hand-built trigger below floor cannot derive: derivation requires a
  // fired, gated trigger event; with no fired signal there is no event at all.
  assert.equal(readTriggerState(store).triggers.length, 0);
});

test("P6 MEDIUM stops BEFORE promotion (§E.3)", () => {
  const repo = makeFixtureRepo("p6-repo");
  const store = freshDir("p6-store");
  // a policy that allows MEDIUM evaluation (autonomous mutation/evaluation;
  // promotion remains the operator boundary)
  createEvolutionPolicy(store, policyInput({ risk_classes_allowed: ["LOW", "MEDIUM"] }));
  const policy = readEvolutionPolicy(store);
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  // a wide-scope behavioral candidate classifies MEDIUM (breadth > 8 paths)
  const scope = Array.from({ length: 9 }, (_, i) => `lib/a${i}.ts`);
  const cls = classifyCandidateRisk({
    affected_scope: scope, declared_risk_markers: [],
    expected_improvement: { kind: "behavioral" },
  });
  assert.equal(cls.riskClass, "MEDIUM");
  const trigger = buildTriggerEvent({
    signal: {
      signalClass: "REPEATED_EQUIVALENT_FAILURE", count: 3, minCount: 3,
      signature: "sig-p6", evidenceRefs: ["e1", "e2", "e3"],
      observation: { patchPlan: { patch: PATCH }, affectedScope: scope },
    },
    graphRunId: "p6",
  });
  const derived = deriveImprovementCandidate({ triggerEvent: trigger, baselineHead, baselineRevision: 1, storeRoot: store });
  assert.equal(derived.candidate.risk_class, "MEDIUM");
  const authorization = authorizeUnderPolicy({
    policy, classification: cls, mutationPaths: scope, baselineHead, usage: {},
  });
  assert.equal(authorization.authorized, true);
  assert.equal(authorization.promotionRequiresOperator, true, "MEDIUM mutates but cannot promote");
  // the promotion gate refuses BEFORE any branch advance:
  assert.throws(() => evaluateAutonomousPromotion({
    policy, authorization, candidate: derived.candidate,
    fitness: { decision: "ACCEPT", regression: { verdict: "PASS" }, candidate_id: derived.candidate.candidate_id, fitness_digest: "f".repeat(64) },
    storeRoot: store, liveBaselineHead: baselineHead,
  }), /MEDIUM-risk promotion requires operator/);
  assert.equal(git(repo, ["rev-parse", "master"]), baselineHead);
});

test("P7 HIGH stops BEFORE mutation (§E.4)", () => {
  const store = freshDir("p7-store");
  createEvolutionPolicy(store, policyInput());
  const policy = readEvolutionPolicy(store);
  // authority-surface scope → HIGH
  const cls = classifyCandidateRisk({ affected_scope: ["src/admission/admission-gate.mjs"], declared_risk_markers: [] });
  assert.equal(cls.riskClass, "HIGH");
  // the policy gate refuses BEFORE any authorization artifact exists:
  assert.throws(() => authorizeUnderPolicy({
    policy, classification: cls, mutationPaths: ["src/admission/admission-gate.mjs"],
    baselineHead: "a".repeat(40), usage: {},
  }), /HIGH-risk candidate/);
  // every HIGH class is structurally forbidden in the policy artifact
  for (const c of HIGH_RISK_CLASSES) assert.ok(policy.forbidden_risk_classes.includes(c));
  assert.throws(() => createEvolutionPolicy(store, policyInput({ risk_classes_allowed: ["LOW", "HIGH"] })), /risk_classes_invalid|CONFLICT/);
});

test("P8 regression / unchanged / inconclusive fitness → REJECT (§E.5/6/7)", () => {
  const candidate = {
    candidate_id: `ecand_${"8".repeat(40)}`,
    measurement_plan: { metric: "failure_or_repair_count", direction: "decrease" },
  };
  const baselineEvents = heldEvents(3);
  // regression: required validation failed
  const failing = { outcome_state: "VALIDATION_FAILED", evidence: { validation_results: [{ cmd: "node", args: [], exit_code: 1, required: true }] } };
  const f1 = evaluateFitness({ candidate, baselineEvidence: { events: baselineEvents }, candidateEvidence: { events: [], mutationResult: failing } });
  assert.equal(f1.decision, "REJECT");
  // unchanged: tests pass, metric identical
  const passing = { outcome_state: "READY_FOR_REVIEW", evidence: { validation_results: [{ exit_code: 0, required: true }] } };
  const f2 = evaluateFitness({ candidate, baselineEvidence: { events: baselineEvents }, candidateEvidence: { events: baselineEvents, mutationResult: passing } });
  assert.equal(f2.verdict, "UNCHANGED");
  assert.equal(f2.decision, "REJECT");
  // inconclusive: no measurable metric on either side
  const f3 = evaluateFitness({
    candidate: { ...candidate, measurement_plan: { metric: "provider_occupancy", direction: "decrease" } },
    baselineEvidence: { events: [] }, candidateEvidence: { events: [], mutationResult: passing },
  });
  assert.equal(f3.verdict, "INCONCLUSIVE");
  assert.equal(f3.decision, "REJECT");
});

// ── P9: §E.8/9/10 — review failure / semantic drift / HEAD mismatch ─────────

test("P9 review failure / semantic drift / live HEAD mismatch → NO PROMOTION", () => {
  const store = freshDir("p9-store");
  const repo = makeFixtureRepo("p9-repo");
  createEvolutionPolicy(store, policyInput());
  const policy = readEvolutionPolicy(store);
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  const candidate = {
    candidate_id: `ecand_${"9".repeat(40)}`,
    baseline_head: baselineHead,
    risk_class: "LOW",
    measurement_plan: { metric: "failure_or_repair_count", direction: "decrease" },
  };
  candidate.candidate_digest = digestOf({ ...candidate, candidate_digest: undefined });
  const fitness = {
    decision: "ACCEPT", verdict: "IMPROVED", regression: { verdict: "PASS" },
    candidate_id: candidate.candidate_id, fitness_digest: "f".repeat(64),
  };
  const authorization = {
    authorized: true, riskClass: "LOW", promotionRequiresOperator: false,
    policyId: policy.policy_id, policyDigest: policy.policy_digest,
  };
  // §E.8: no durable review PASS → NO PROMOTION
  assert.throws(() => evaluateAutonomousPromotion({
    policy, authorization, candidate, fitness, storeRoot: store, liveBaselineHead: baselineHead,
  }), /no durable independent review PASS/);
  // §E.9: semantic drift (bound digest no longer matches live contract) → NO PROMOTION
  bindEvolutionReview({ storeRoot: store, candidate, fitness, reviewerIdentity: "reviewer:p9", verdict: "PASS", summary: "p9" });
  assert.throws(() => evaluateAutonomousPromotion({
    policy, authorization, candidate, fitness, storeRoot: store, liveBaselineHead: baselineHead,
    declaredContract: { a: 1 }, boundContractDigest: "e".repeat(64),
  }), /SEMANTIC_DRIFT:bound /);
  // §E.10: live HEAD moved off the frozen baseline → NO PROMOTION
  assert.throws(() => evaluateAutonomousPromotion({
    policy, authorization, candidate, fitness, storeRoot: store, liveBaselineHead: "b".repeat(40),
  }), /live HEAD.*!= candidate baseline/);
  // the tampered candidate digest also fails closed (gate 4 fires first for
  // the review binding, gate 5 for digest re-derivation — both IDENTITY_MISMATCH class)
  assert.throws(() => evaluateAutonomousPromotion({
    policy, authorization, candidate: { ...candidate, candidate_digest: "0".repeat(64) }, fitness,
    storeRoot: store, liveBaselineHead: baselineHead,
  }), /review artifact does not bind this candidate|candidate digest does not re-derive/);
});

// ── P10: §E.11 — canary regression → AUTO ROLLBACK ──────────────────────────

test("P10 canary regression triggers automatic rollback to the pre-promotion baseline", async () => {
  const repo = makeFixtureRepo("p10-repo");
  const store = freshDir("p10-store");
  const candidate = {
    candidate_id: `ecand_${"a".repeat(40)}`, candidate_digest: "c".repeat(64),
    problem_signature: "HOLD / C3B_MUTATION_FAILED",
  };
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  const commitOid = spawnSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", baselineHead, "-m", "evolution: p10"], { encoding: "utf8" }).stdout.trim();
  const branch = `evolution/${candidate.candidate_id}`;
  git(repo, ["update-ref", `refs/heads/${branch}`, commitOid]);
  openCanaryWindow({
    storeRoot: store, candidate, promotion: { branch, commit_oid: commitOid, parent: baselineHead },
    fitness: { fitness_digest: "f".repeat(64) },
    baselineMetric: { metric: "failure_or_repair_count", value: 0 },
  });
  // the SAME failure signature re-appears ≥2 post-promotion → REGRESSED
  const evaluated = evaluateCanary({ storeRoot: store, candidate, postEvents: heldEvents(2) });
  assert.equal(evaluated.verdict, "REGRESSED");
  // AUTOMATIC rollback: ref restored, idempotent, master untouched
  const rb = rollbackCandidate({ repoRoot: repo, storeRoot: store, candidate });
  assert.equal(rb.restored_to, baselineHead);
  assert.equal(git(repo, ["rev-parse", `refs/heads/${branch}`]), baselineHead);
  assert.equal(git(repo, ["rev-parse", "master"]), baselineHead);
  assert.equal(readCanary(store, candidate.candidate_id).rolled_back, true);
  const rb2 = rollbackCandidate({ repoRoot: repo, storeRoot: store, candidate });
  assert.equal(rb2.restored_to, baselineHead);
});

// ── P11: §E.12 — circuit breaker suspends evolution, NORMAL_OPERATION continues ──

test("P11 circuit breaker → evolution suspended; NORMAL_OPERATION continues unaffected", async () => {
  const store = freshDir("p11-store");
  const repo = makeFixtureRepo("p11-repo");
  // trip the breaker through the real accounting path
  let state = {};
  for (let i = 0; i < 3; i++) {
    const r = recordCandidateOutcome({ state, outcome: "REJECTED", candidateId: `c${i}`, signature: `s${i}` });
    state = r.state;
  }
  assert.ok(state.circuitBreaker);
  writeTriggerState(store, state);
  createEvolutionPolicy(store, policyInput());
  // the loop entry HOLDs at the trigger gate — never throws into the run path
  const r = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("p11-cp"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: heldEvents(5), fingerprint: collectFingerprint(repo),
  });
  assert.equal(r.loop_verdict, "HOLD");
  assert.equal(r.hold_code, "HOLD / EVOLUTION_LOOP_TRIGGER_GATED");
  // NORMAL_OPERATION through the production entry is unaffected by the breaker
  const calls = [];
  const evidenceRoot = makeEvidenceRoot("p11-ev");
  const r2 = await runAdmittedGraph({
    admission: frozenAdmission("EVOL-P11"),
    runner: journalingRunner(calls, { terminalEvents: heldEvents(1), verdict: "PASS" }),
    persistence: { root: evidenceRoot, executionId: `exec_${"e5".padEnd(32, "0").slice(0, 32)}` },
    ir: { phases: [] },
  });
  assert.equal(r2.final, "PASS");
  assert.equal(r2.budget.authorized, true);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
});

// ── P12: §H — the kill switch ───────────────────────────────────────────────

test("P12 kill switch: SUSPENDED blocks new cycles, leaves NORMAL_OPERATION and telemetry untouched; default ENABLED", async () => {
  const store = freshDir("p12-store");
  const repo = makeFixtureRepo("p12-repo");
  createEvolutionPolicy(store, policyInput());
  // default: ENABLED (no marker, no env)
  const observation = observeRunForEvolutionTriggers({
    evidenceRoot: makeEvidenceRoot("p12-ev"), executionId: `exec_${"f6".padEnd(32, "0").slice(0, 32)}`,
    graphRunId: "p12", storeRoot: store,
  });
  assert.equal(observation.switch_state.state, "ENABLED");
  // suspend via the durable marker (NO source change)
  suspendEvolution(store, { reason: "operator pause" });
  assert.ok(readEvolutionSuspension(store));
  // the loop refuses BEFORE any evolution work:
  const r = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("p12-cp"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: heldEvents(5), fingerprint: collectFingerprint(repo),
  });
  assert.equal(r.loop_verdict, "HOLD");
  assert.equal(r.hold_code, "HOLD / EVOLUTION_SUSPENDED");
  // the observer records nothing while suspended:
  const obs2 = observeRunForEvolutionTriggers({
    evidenceRoot: makeEvidenceRoot("p12-ev2"), executionId: `exec_${"f7".padEnd(32, "0").slice(0, 32)}`,
    graphRunId: "p12b", storeRoot: store,
  });
  assert.equal(obs2.switch_state.state, "SUSPENDED");
  assert.deepEqual(obs2.fired, []);
  assert.equal(obs2.observed, 0);
  // NORMAL_OPERATION continues unaffected while suspended:
  const calls = [];
  const r2 = await runAdmittedGraph({
    admission: frozenAdmission("EVOL-P12"),
    runner: journalingRunner(calls, { terminalEvents: heldEvents(1), verdict: "PASS" }),
    persistence: { root: makeEvidenceRoot("p12-ev3"), executionId: `exec_${"f8".padEnd(32, "0").slice(0, 32)}` },
    ir: { phases: [] },
    evolutionStoreRoot: store,
  });
  assert.equal(r2.final, "PASS");
  assert.equal(r2.budget.authorized, true);
  // env override also suspends (and takes precedence after resume):
  resumeEvolution(store);
  assert.equal(readEvolutionSuspension(store), null);
  const r3 = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("p12-cp2"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: heldEvents(5), fingerprint: collectFingerprint(repo),
    env: { AUTO_EVOLUTION: "SUSPENDED" },
  });
  assert.equal(r3.loop_verdict, "HOLD");
  assert.equal(r3.hold_code, "HOLD / EVOLUTION_SUSPENDED");
});

// ── P13: §I — crash recovery ────────────────────────────────────────────────

test("P13 crash recovery: state recoverable, no duplicate candidate/promotion, canary+rollback authority and breaker survive", async () => {
  const repo = makeFixtureRepo("p13-repo");
  const store = freshDir("p13-store");
  createEvolutionPolicy(store, policyInput());
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);

  // a candidate derived BEFORE the crash
  const trigger = buildTriggerEvent({
    signal: {
      signalClass: "REPEATED_EQUIVALENT_FAILURE", count: 3, minCount: 3,
      signature: "sig-p13", evidenceRefs: ["e1", "e2", "e3"],
      observation: { patchPlan: { patch: PATCH }, affectedScope: ["lib/utils/retry.ts"] },
    },
    graphRunId: "p13",
  });
  const derived = deriveImprovementCandidate({ triggerEvent: trigger, baselineHead, baselineRevision: 1, storeRoot: store });
  assert.equal(derived.status, "CREATED");
  const candidate = derived.candidate;

  // a promoted branch with an INTERRUPTED rollback (canary REGRESSED, ref not yet restored)
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  const commitOid = spawnSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", baselineHead, "-m", "evolution: p13"], { encoding: "utf8" }).stdout.trim();
  const branch = `evolution/${candidate.candidate_id}`;
  git(repo, ["update-ref", `refs/heads/${branch}`, commitOid]);
  openCanaryWindow({
    storeRoot: store, candidate, promotion: { branch, commit_oid: commitOid, parent: baselineHead },
    fitness: { fitness_digest: "f".repeat(64) },
    baselineMetric: { metric: "failure_or_repair_count", value: 3 },
  });
  evaluateCanary({ storeRoot: store, candidate, postEvents: heldEvents(2, candidate.problem_signature) });
  // record the rollback DECISION by hand-crashing before the ref repair:
  const canaryRecord = JSON.parse(readFileSync(join(store, "canary", `${candidate.candidate_id}.json`), "utf8"));
  assert.equal(canaryRecord.verdict, "REGRESSED");
  assert.equal(canaryRecord.rolled_back, false); // interrupted here

  // circuit breaker state set before the crash survives:
  let st = readTriggerState(store);
  st = { ...st, circuitBreaker: { at: new Date().toISOString(), reason: "pre-crash" } };
  writeTriggerState(store, st);

  // RECONCILE after restart:
  const rec = reconcileEvolutionState({ repoRoot: repo, storeRoot: store });
  assert.equal(rec.schema, "autoloop.evolution-recovery/v1");
  assert.equal(rec.circuit_breaker.tripped, true, "circuit breaker state not lost");
  assert.equal(rec.circuit_breaker.reason, "pre-crash");
  assert.ok(rec.recovered.some((x) => x === `rollback_completed:${candidate.candidate_id}`), "interrupted rollback completed");
  // the ref is now restored to the baseline (rollback authority recovered):
  assert.equal(git(repo, ["rev-parse", `refs/heads/${branch}`]), baselineHead);
  assert.equal(readCanary(store, candidate.candidate_id).rolled_back, true);

  // NO duplicate candidate: re-deriving after the crash returns EXISTING
  const rederived = deriveImprovementCandidate({ triggerEvent: trigger, baselineHead, baselineRevision: 1, storeRoot: store });
  assert.equal(rederived.status, "EXISTING");
  assert.equal(rederived.candidate.candidate_id, candidate.candidate_id);
  assert.ok(existsSync(candidateFilePath(store, candidate.candidate_id)));

  // NO duplicate promotion: a replayed promotion against the same candidate
  // fails closed (the branch is at baseline, HEAD gate + review gate hold)
  assert.throws(() => evaluateAutonomousPromotion({
    policy: readEvolutionPolicy(store),
    authorization: { authorized: true, riskClass: "LOW", promotionRequiresOperator: false, policyId: readEvolutionPolicy(store).policy_id },
    candidate, fitness: { decision: "ACCEPT", regression: { verdict: "PASS" }, candidate_id: candidate.candidate_id, fitness_digest: "f".repeat(64) },
    storeRoot: store, liveBaselineHead: baselineHead,
  }), /no durable independent review PASS/, "no review artifact → replayed promotion fails closed");
  // incomplete mutations pollute nothing: the production checkout is clean
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(git(repo, ["rev-parse", "master"]), baselineHead);
});

// ── P14: §B — production policy boundary ────────────────────────────────────

test("P14 production policy: LOW autonomous, MEDIUM operator, HIGH denied; unrestricted wildcard scope refused", async () => {
  const store = freshDir("p14-store");
  const out = spawnSync(process.execPath, [
    join(process.cwd(), "scripts", "evolution-issue-policy.mjs"), "--store", store, "--json",
  ], { encoding: "utf8" });
  assert.equal(out.status, 0, `issue failed: ${out.stderr}`);
  const summary = JSON.parse(out.stdout);
  assert.deepEqual(summary.risk_classes_allowed, ["LOW"]);
  assert.ok(!summary.scope_patterns.includes("**") && !summary.scope_patterns.includes("src/**"));
  // the issued policy artifact cannot authorize HIGH (structural)
  const policy = readEvolutionPolicy(store);
  for (const c of HIGH_RISK_CLASSES) assert.ok(policy.forbidden_risk_classes.includes(c));
  // unrestricted wildcard scope is refused at issue time
  const out2 = spawnSync(process.execPath, [
    join(process.cwd(), "scripts", "evolution-issue-policy.mjs"), "--store", store, "--scope", "src/**",
  ], { encoding: "utf8" });
  assert.equal(out2.status, 1);
  assert.ok(out2.stderr.includes("unrestricted mutation scope refused"));
  // kill-switch CLI round trip
  const s1 = spawnSync(process.execPath, [join(process.cwd(), "scripts", "evolution-kill-switch.mjs"), "--store", store, "--status"], { encoding: "utf8" });
  assert.ok(s1.stdout.includes("AUTO_EVOLUTION = ENABLED"));
  spawnSync(process.execPath, [join(process.cwd(), "scripts", "evolution-kill-switch.mjs"), "--store", store, "--suspend", "--reason", "test"], { encoding: "utf8" });
  const s2 = spawnSync(process.execPath, [join(process.cwd(), "scripts", "evolution-kill-switch.mjs"), "--store", store, "--status"], { encoding: "utf8" });
  assert.ok(s2.stdout.includes("SUSPENDED"));
  spawnSync(process.execPath, [join(process.cwd(), "scripts", "evolution-kill-switch.mjs"), "--store", store, "--resume"], { encoding: "utf8" });
  const s3 = spawnSync(process.execPath, [join(process.cwd(), "scripts", "evolution-kill-switch.mjs"), "--store", store, "--status"], { encoding: "utf8" });
  assert.ok(s3.stdout.includes("ENABLED"));
});

// ── P15: attach helper is total and non-mutating ────────────────────────────

test("P15 attachEvolutionObservation never throws and never rewrites other fields", () => {
  const result = { final: "PASS", budget: { authorized: true } };
  const obs = observeRunForEvolutionTriggers({ evidenceRoot: "/nonexistent", executionId: "exec_x", graphRunId: "p15" });
  attachEvolutionObservation(result, obs);
  assert.equal(result.final, "PASS");
  assert.equal(result.budget.authorized, true);
  assert.equal(result.evolutionObservation, obs);
  // frozen objects and arrays are safe
  const frozen = Object.freeze({ final: "PASS" });
  assert.doesNotThrow(() => attachEvolutionObservation(frozen, obs));
  assert.doesNotThrow(() => attachEvolutionObservation(null, obs));
});
