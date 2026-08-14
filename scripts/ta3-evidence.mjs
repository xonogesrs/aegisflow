#!/usr/bin/env node
// scripts/ta3-evidence.mjs
//
// AUTOLOOP-TA3 — structured budget evidence（deterministic, local）.
// Writes docs/pi-graph-output/ta3/ta3-budget-evidence.json carrying the
// card's §9 evidence requirements:
//   - budget contract schema + enforced dimension inventory（meter/source map）
//   - production wiring map（enforcement chain sections）
//   - budget state transition model
//   - crash/resume accounting proof（recomputed ledger trace）
//   - sample admission → budget envelope（from ta3-sample-admissions.json）
//   - sample cumulative consumption trace（reserve→settle→checkpoint→resume）
//   - exhaustion evidence（deterministic block）
//
// Run: node scripts/ta3-evidence.mjs
// Local-only, deterministic, no network, no commit/push/seal.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "docs", "pi-graph-output", "ta3");

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

const { classify, scanRiskSignals } = await import("../src/admission/classify.mjs");
const { buildAdmissionRecord } = await import("../src/admission/policy-projection.mjs");
const { freezeAdmission } = await import("../src/admission/admission-record.mjs");
const { deriveBudgetEnvelope } = await import("../src/budget/envelope.mjs");
const contract = await import("../src/budget/contract.mjs");
const ledgerMod = await import("../src/budget/ledger.mjs");
const { createBudgetEnforcement } = await import("../src/budget/enforcement.mjs");

const FULL = {
  affected_files: { score: 1, reasons: ["single README file"] }, affected_subsystems: { score: 0, reasons: ["docs only"] },
  dependency_depth: { score: 0, reasons: ["no deps"] }, ambiguity: { score: 0, reasons: ["exact text"] },
  expected_execution_steps: { score: 0, reasons: ["one edit"] }, verification_burden: { score: 0, reasons: ["no tests"] },
  external_dependencies: { score: 0, reasons: ["none"] }, concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] }, rollback_complexity: { score: 0, reasons: ["revert 1 file"] },
};

// ── sample admission → envelope ──────────────────────────────────────────
const c = classify({ dimensionScores: FULL, riskSignals: scanRiskSignals("fix one typo in README") });
const rec = freezeAdmission(buildAdmissionRecord({
  taskId: "TA3-EVIDENCE-SAMPLE",
  classification: c,
  mutationScope: ["docs/"],
  extensions: {
    budget: {
      schema: "autoloop.budget-contract/v1",
      version: 1,
      approachingRatio: 0.8,
      dimensions: {
        node_execution_count: { limit: 3 },
        wall_clock_ms: { limit: 600000 },
        sub_agent_execution_count: { limit: 2 },
        repair_attempt_count: { limit: 2 },
        verifier_reviewer_attempts: { limit: 2 },
        retry_count: { limit: 2 },
      },
    },
  },
}));
const envResult = deriveBudgetEnvelope(rec);
if (!envResult.ok) throw new Error(envResult.reason ?? "envelope failed");
const envelope = envResult.envelope;

// ── sample cumulative consumption trace（reserve → settle → checkpoint →
// resume → exhaustion）────────────────────────────────────────────────────
const enf = createBudgetEnforcement({ admission: rec });
if (!enf.ok) throw new Error(enf.reason ?? "enforcement failed");
const enc = enf.enforcement;
const trace = [];
const dispatch = (phaseId, wallMs, { subagent = false } = {}) => {
  const g = enc.preDispatch({ executionId: "ev", phase_id: phaseId, nodeId: phaseId, attempt: 0, runtime: { mode: subagent ? "subagent" : "readonly", limits: { timeoutMs: 60000 } } });
  if (!g.ok) { trace.push({ phaseId, action: "pre-dispatch", outcome: g.holdCode, reason: g.reason }); return g; }
  trace.push({ phaseId, action: "pre-dispatch", outcome: "reserved", reservation: g.reservation, opKey: g.opKey });
  const s = enc.recordConsumption({ opKey: g.opKey, actualAmounts: { node_execution_count: 1, ...(subagent ? { sub_agent_execution_count: 1 } : {}) }, wallClockMs: wallMs });
  trace.push({ phaseId, action: "settle", outcome: s.ok ? "confirmed" : s.holdCode, actual: s.ok ? s.actual : null, stateAfter: s.ok ? s.state : null });
  return s;
};
dispatch("N1", 5000);
dispatch("N2", 8000);
dispatch("N3", 3000);
const exhaustion = dispatch("N4", 5000);
const checkpoint = enc.checkpointState();
const resumed = createBudgetEnforcement({ admission: rec, checkpointState: checkpoint });
if (!resumed.ok) throw new Error(resumed.reason ?? "resume failed");
const resumedCounters = resumed.enforcement.ledger.counters;
const traceAfterResume = { countersAfterResume: resumedCounters, generation: resumed.enforcement.ledger.generation, resumedCumulative: resumedCounters.node_execution_count === 3 };

// ── crash/resume accounting proof（deterministic recompute）──────────────
const env2 = deriveBudgetEnvelope(rec).envelope;
const ledger = ledgerMod.createBudgetLedger({ envelope: env2 });
ledgerMod.ledgerReserve(ledger, env2, { opKey: "crash:n1:0", amounts: { node_execution_count: 1, wall_clock_ms: 60000 } });
ledgerMod.ledgerSettle(ledger, env2, { opKey: "crash:n1:0", actualAmounts: { node_execution_count: 1, wall_clock_ms: 150 } });
ledgerMod.ledgerReserve(ledger, env2, { opKey: "crash:n2:0", amounts: { node_execution_count: 1, wall_clock_ms: 60000 } }); // crash before settle
const crashCheckpoint = ledgerMod.checkpointBudgetLedger(ledger);
const resumeProof = ledgerMod.resumeBudgetLedger({ envelope: env2, state: crashCheckpoint });
const reconstruction = ledgerMod.reconstructBudgetLedger({ envelope: env2, events: resumeProof.ok ? resumeProof.ledger.events : [] });

const evidence = {
  schema: "autoloop.ta3-budget-evidence/v1",
  card: "AUTOLOOP-TA3",
  generatedAt: new Date().toISOString(),
  contractSchema: contract.BUDGET_CONTRACT_SCHEMA,
  enforcementStates: contract.BUDGET_STATES,
  enforcedDimensions: Object.fromEntries(contract.ENFORCED_DIMENSIONS.map((d) => [d, contract.DIMENSION_METER_MAP[d]])),
  deferredDimensions: Object.fromEntries(contract.DEFERRED_DIMENSIONS.map((d) => [d, contract.DIMENSION_METER_MAP[d]])),
  profileDefaultContracts: contract.PROFILE_DEFAULT_CONTRACTS,
  productionWiringMap: {
    enforcementChainSections: ["assert-admission", "derive-envelope", "init-resume-ledger", "pre-dispatch", "execute-bounded", "record-consumption", "post-op-invariant", "durable-checkpoint-evidence"],
    entrypoint: "src/admission/admission-gate.mjs: runAdmittedGraph (createBudgetEnforcement + attachBudgetResult)",
    runnerSeam: "src/runtime/colima-graph-runner.mjs: pre-dispatch gate before worktree/executor + terminal settlement + repair/reviewer/retry meters",
    subagentForwarding: "src/subagent/subagent-graph-runner.mjs: budget forwarded to runDurableGraph / runColimaGraph",
    durablePersist: "src/v2/durable-graph.mjs: budget-ledger.json artifact (checkpoint) + resume reconstruction from the re-verified admission",
    bundleSection: "src/governance/review-bundle.mjs §5.5 Budget Enforcement (from graphResult.budget)",
  },
  stateTransitionModel: {
    CONTINUE: "within budget — dispatch allowed",
    APPROACHING_LIMIT: "consumed >= approachingRatio of a limit — observability/replanning signal ONLY; never widens budget",
    BUDGET_EXHAUSTED: "consumed >= limit — no further dispatch; deterministic HOLD (or admission-authorized bounded graceful closeout)",
    BUDGET_AUTHORITY_INVALID: "admission/contract/envelope/ledger missing, unsupported, tampered or unverifiable — fail closed before execution",
  },
  sampleAdmission: { admission_id: rec.admission_id, size: rec.size, risk: rec.risk, profile: rec.profile, budgetContract: rec.extensions.budget },
  sampleEnvelope: envelope,
  sampleConsumptionTrace: {
    trace,
    exhaustion: exhaustion.ok ? null : { outcome: exhaustion.holdCode, reason: exhaustion.reason },
    checkpoint: checkpoint,
    traceAfterResume,
  },
  crashResumeAccountingProof: {
    preCrashConfirmed: { node_execution_count: 1, wall_clock_ms: 150 },
    inFlightAtCrash: Object.keys(crashCheckpoint.inFlight ?? {}),
    resume: resumeProof.ok
      ? { cumulative: resumeProof.ledger.counters, generation: resumeProof.ledger.generation, inFlightAfter: Object.keys(resumeProof.ledger.inFlight).length, settledUpperBound: true }
      : { ok: false },
    deterministicReconstruction: reconstruction.ok && reconstruction.ledger.counters.node_execution_count === resumeProof.ledger.counters.node_execution_count,
  },
  accountingInvariant: "consumed_before_crash + consumed_after_resume = cumulative consumption (B3); conservative upper-bound reservation for unconfirmed in-flight work (§6)",
  digest: null,
};
evidence.digest = sha256(JSON.stringify({ ...evidence, digest: null, generatedAt: null }));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "ta3-budget-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(`ta3-budget-evidence.json written (digest ${evidence.digest.slice(0, 16)}...)`);
console.log(`sample trace: ${trace.length} actions; exhaustion=${exhaustion.holdCode ?? "none"}; resume cumulative nodes=${resumedCounters.node_execution_count}`);
