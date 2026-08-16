#!/usr/bin/env node
// scripts/ta3-verify.mjs
//
// AUTOLOOP-TA3 — machine verification of the Admission-Driven Runtime Budget
// Enforcement card. Exit 0 iff ALL checks pass. Writes
// docs/pi-graph-output/ta3/ta3-verification.json.
//
//   V1   budget module files parse
//   V2   budget contract schema + enforcement states + dimension inventory
//        disclosure（meter source / unit / admission field / enforcement
//        point / durable state / exhaustion behavior / deferred reason）
//   V3   profile default contracts deterministic + cover every profile
//   V4   envelope derived from a FROZEN admission; deterministic id
//   V5   NEG2 — envelope tamper / runtime widening rejected（frozen + id）
//   V6   ledger reserve→settle exact accounting + BUDGET_EXHAUSTED blocks
//        further dispatch（NEG4, never overrun）
//   V7   B3/NEG5 — crash + resume cumulative（no reset）+ in-flight upper-bound
//        settlement（§6 conservative accounting）
//   V8   deterministic reconstruction from the receipt log（NEG13 baseline）
//   V9   B2/NEG3/NEG7 — child budget monotonic; over-request rejected
//   V10  B4/NEG10 — repair_attempt_count is a runtime meter; the TA-2 repair
//        budget authority stays separate
//   V11  NEG8/NEG9 — unsupported meters（tokens / tool calls）fail closed,
//        never read as 0 consumption
//   V12  NEG12 — malformed / tampered budget state after restore -> HOLD
//   V13  NEG13 — runtime-evidence vs closeout divergence -> HOLD
//   V14  NEG14 — low-level compat surface is NOT budget-authorized
//   V15  production wiring — runAdmittedGraph enforces（honoring runner PASS
//        + budget section; bypass runner HOLD; invalid authority HOLD before
//        dispatch; resume via checkpointState cumulative）
//   V16  production graph seams — colima runner pre-dispatch gate before
//        worktree/executor; subagent + durable forward `budget`; durable
//        persists budget-ledger.json; review-bundle renders §5.5
//   V17  regression suites green（budget/admission/governance/
//        scripted-lifecycle/telemetry/v2）
//   V18  scope guard — no production source outside the authorized scope was
//        modified by this card（content-identity aware vs the ta3 baseline）
//   V19  R9 single-model policy unchanged（deepseek-v4-flash only）
//   V20  TA-2 repair-lineage contract unchanged（no regression）: GENERATION_TYPE
//        parsing + cumulative budget semantics still valid on the TA-2R bundles
//   V21  final-surface: TA-3 closeout bundle（when generated）is residue-clean
//        and validates under the bundle contract

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "docs", "pi-graph-output", "ta3");
const TA2R = join(REPO, "docs", "pi-graph-output", "ta2r");

// VCA-1 W1A (S2): real wall-clock measurement for the whole verification run.
const VERIFY_STARTED_AT = Date.now();

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail });
}
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
function canonical(v) {
  const sort = (x) => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  };
  return JSON.stringify(sort(v));
}

const BUDGET_FILES = [
  "src/budget/contract.mjs",
  "src/budget/envelope.mjs",
  "src/budget/ledger.mjs",
  "src/budget/enforcement.mjs",
  "src/budget/graph-wiring.mjs",
];

const { classify, scanRiskSignals } = await import("../src/admission/classify.mjs");
const { buildAdmissionRecord } = await import("../src/admission/policy-projection.mjs");
const { freezeAdmission, validateAdmission } = await import("../src/admission/admission-record.mjs");
const { runAdmittedGraph } = await import("../src/admission/admission-gate.mjs");
const budget = await import("../src/budget/contract.mjs");
const envelopeMod = await import("../src/budget/envelope.mjs");
const ledgerMod = await import("../src/budget/ledger.mjs");
const enforcementMod = await import("../src/budget/enforcement.mjs");
const { attachBudgetResult } = await import("../src/budget/graph-wiring.mjs");
const { assertNoTemplateResidue, validateReviewBundle, parseRepairLineage, renderVerifierAccounting } = await import("../src/governance/review-bundle.mjs");
const { runSuiteSync, timingFields } = await import("../src/governance/verification-timing.mjs");

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

function admission({ dimensions = null, text = "fix one typo in README" } = {}) {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals(text) });
  const extensions = dimensions ? { budget: { schema: "autoloop.budget-contract/v1", version: 1, dimensions } } : {};
  return freezeAdmission(buildAdmissionRecord({ taskId: "TA3-VERIFY", classification: c, mutationScope: ["docs/"], extensions }));
}

const DIMS = {
  node_execution_count: { limit: 3 },
  wall_clock_ms: { limit: 600000 },
  sub_agent_execution_count: { limit: 2 },
  repair_attempt_count: { limit: 2 },
  verifier_reviewer_attempts: { limit: 2 },
  retry_count: { limit: 2 },
};

function enforce(rec) {
  const r = enforcementMod.createBudgetEnforcement({ admission: rec });
  if (!r.ok) throw new Error(r.reason ?? "enforce failed");
  return r.enforcement;
}

function dispatchNode(enc, phaseId, { wallMs = 5, timeoutMs = 60000 } = {}) {
  const g = enc.preDispatch({ executionId: "g", phase_id: phaseId, nodeId: phaseId, attempt: 0, runtime: { mode: "readonly", limits: { timeoutMs } } });
  if (!g.ok) return g;
  const s = enc.recordConsumption({ opKey: g.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: wallMs });
  return s.ok ? { ok: true } : s;
}

// ── V1: module parse ──────────────────────────────────────────────────────
const parseOk = BUDGET_FILES.every((f) => {
  try { execFileSync("node", ["--check", join(REPO, f)], { stdio: "pipe" }); return true; } catch { return false; }
});
check("V1.budget_modules_parse", parseOk, `${BUDGET_FILES.join(", ")} parse clean`);

// ── V2: contract schema + states + dimension inventory ────────────────────
{
  const states = budget.BUDGET_STATES;
  const statesOk = canonical(states) === canonical(["CONTINUE", "APPROACHING_LIMIT", "BUDGET_EXHAUSTED", "BUDGET_AUTHORITY_INVALID"]);
  const enforcedOk = budget.ENFORCED_DIMENSIONS.every((d) => {
    const m = budget.DIMENSION_METER_MAP[d];
    return m && m.supported === true && m.meterSource && m.unit && m.admissionField && m.enforcementPoint && m.durableState && m.exhaustionBehavior;
  });
  const deferredOk = budget.DEFERRED_DIMENSIONS.every((d) => {
    const m = budget.DIMENSION_METER_MAP[d];
    return m && m.supported === false && m.deferredReason;
  });
  check("V2.contract_states_and_dimension_inventory", statesOk && enforcedOk && deferredOk,
    `states ${states.join("/")}; enforced ${budget.ENFORCED_DIMENSIONS.length} (all metered), deferred ${budget.DEFERRED_DIMENSIONS.length} (all disclosed with reasons)`);
}

// ── V3: profile default contracts ─────────────────────────────────────────
{
  const profiles = ["FAST_PATH", "STANDARD", "MEDIUM", "MEDIUM_LARGE", "LARGE_LOW", "HIGH", "CRITICAL"];
  const ok = profiles.every((p) => budget.PROFILE_DEFAULT_CONTRACTS[p]
    && budget.ENFORCED_DIMENSIONS.every((d) => Number.isFinite(budget.PROFILE_DEFAULT_CONTRACTS[p][d])));
  check("V3.profile_default_contracts", ok, `${profiles.length} profiles x ${budget.ENFORCED_DIMENSIONS.length} enforced dims, deterministic table`);
}

// ── V4: envelope from frozen admission + determinism ──────────────────────
{
  const rec = admission();
  const e1 = envelopeMod.deriveBudgetEnvelope(rec);
  const e2 = envelopeMod.deriveBudgetEnvelope(admission());
  const ok = e1.ok && e2.ok && e1.envelope.envelopeId === e2.envelope.envelopeId
    && e1.envelope.admissionId === rec.admission_id
    && /^[0-9a-f]{64}$/.test(e1.envelope.envelopeId);
  check("V4.envelope_frozen_deterministic", ok, `envelopeId ${String(e1.envelope?.envelopeId).slice(0, 12)}... stable; bound to admission ${rec.admission_id.slice(0, 12)}`);
}

// ── V5: NEG2 — envelope immutability / tamper ─────────────────────────────
{
  const enc = enforce(admission({ dimensions: DIMS }));
  let frozen = false;
  try { enc.envelope.dimensions.node_execution_count.limit = 9999; } catch { frozen = true; }
  const forged = { ...enc.envelope, dimensions: { ...enc.envelope.dimensions, node_execution_count: { ...enc.envelope.dimensions.node_execution_count, limit: 9999 } } };
  const check2 = envelopeMod.assertEnvelopeUntampered(forged);
  check("V5.envelope_immutable_tamper_rejected", frozen && check2.ok === false && check2.holdCode === "BUDGET_AUTHORITY_INVALID",
    `deep-frozen=${frozen}; widened envelope re-derives a mismatch -> ${check2.holdCode}`);
}

// ── V6: ledger exact accounting + exhaustion (NEG4) ───────────────────────
{
  const env = envelopeMod.deriveBudgetEnvelope(admission({ dimensions: DIMS })).envelope;
  const ledger = ledgerMod.createBudgetLedger({ envelope: env });
  const run = (opKey, wallMs) => {
    const r = ledgerMod.ledgerReserve(ledger, env, { opKey, amounts: { node_execution_count: 1, wall_clock_ms: 60000 } });
    if (!r.ok) return r;
    return ledgerMod.ledgerSettle(ledger, env, { opKey, actualAmounts: { node_execution_count: 1, wall_clock_ms: wallMs } });
  };
  run("g:n1:0", 250);
  const exact = ledger.counters.node_execution_count === 1 && ledger.counters.wall_clock_ms === 250;
  run("g:n2:0", 250);
  run("g:n3:0", 250);
  const blocked = ledgerMod.ledgerReserve(ledger, env, { opKey: "g:n4:0", amounts: { node_execution_count: 1, wall_clock_ms: 60000 } });
  check("V6.ledger_exact_and_exhaustion", exact && blocked.ok === false && blocked.holdCode === "BUDGET_EXHAUSTED",
    `1 node/250ms recorded exactly; 4th dispatch blocked -> ${blocked.holdCode ?? blocked.reason}`);
}

// ── V7: B3/NEG5 crash+resume cumulative + in-flight upper-bound ───────────
{
  const rec = admission({ dimensions: DIMS });
  const enc = enforce(rec);
  dispatchNode(enc, "n1", { wallMs: 100 });
  const reserve = enc.preDispatch({ executionId: "g", phase_id: "n2", nodeId: "n2", attempt: 0, runtime: { mode: "readonly", limits: { timeoutMs: 60000 } } });
  if (!reserve.ok) throw new Error("reserve failed");
  const cp = enc.checkpointState();
  const resumed = enforcementMod.createBudgetEnforcement({ admission: rec, checkpointState: cp });
  const ok = resumed.ok && resumed.enforcement.ledger.counters.node_execution_count === 2
    && resumed.enforcement.ledger.counters.wall_clock_ms === 100 + 60000
    && resumed.enforcement.ledger.generation === 1
    && Object.keys(resumed.enforcement.ledger.inFlight).length === 0;
  check("V7.crash_resume_cumulative_upper_bound", ok, `resume keeps ${resumed.enforcement?.ledger.counters.node_execution_count} nodes (in-flight settled at reserved upper bound)`);
}

// ── V8: deterministic reconstruction ──────────────────────────────────────
{
  const env = envelopeMod.deriveBudgetEnvelope(admission({ dimensions: DIMS })).envelope;
  const ledger = ledgerMod.createBudgetLedger({ envelope: env });
  ledgerMod.ledgerReserve(ledger, env, { opKey: "g:n1:0", amounts: { node_execution_count: 1, wall_clock_ms: 60000 } });
  ledgerMod.ledgerSettle(ledger, env, { opKey: "g:n1:0", actualAmounts: { node_execution_count: 1, wall_clock_ms: 500 } });
  const r1 = ledgerMod.reconstructBudgetLedger({ envelope: env, events: ledger.events });
  const r2 = ledgerMod.reconstructBudgetLedger({ envelope: env, events: ledger.events });
  check("V8.deterministic_reconstruction", r1.ok && r2.ok && canonical(r1.ledger.counters) === canonical(r2.ledger.counters) && r1.ledger.counters.node_execution_count === 1,
    `receipt log replays to identical counters (${canonical(r1.ledger.counters)})`);
}

// ── V9: B2/NEG3/NEG7 child monotonic ──────────────────────────────────────
{
  const enc = enforce(admission({ dimensions: DIMS }));
  dispatchNode(enc, "n1", { wallMs: 5 });
  const over = enc.projectChild({ childLimits: { node_execution_count: 5 } });
  const within = enc.projectChild({ childLimits: { node_execution_count: 1 } });
  check("V9.child_budget_monotonic", over.ok === false && over.holdCode === "BUDGET_CHILD_EXCEEDS_PARENT" && within.ok === true,
    `over-request rejected (${over.holdCode}); within-remaining child capped at ${within.limits?.node_execution_count}`);
}

// ── V10: B4/NEG10 repair independence ─────────────────────────────────────
{
  const rec = admission({ dimensions: DIMS });
  const enc = enforce(rec);
  const repairBefore = rec.repair_budget;
  enc.recordRepair({ nodeId: "n1" });
  enc.recordRepair({ nodeId: "n1" });
  check("V10.repair_runtime_meter_independent", enc.ledger.counters.repair_attempt_count === 2 && rec.repair_budget === repairBefore
    && enc.ledger.repair_budget === undefined && enc.ledger.repairBudget === undefined,
    `runtime repair meter=2; admission.repair_budget unchanged (${repairBefore}); ledger carries no repair-budget authority field`);
}

// ── V11: NEG8/NEG9 unsupported meter fail-closed ──────────────────────────
{
  const recToken = admission({ dimensions: { token_budget: { limit: 100 } } });
  const rToken = enforcementMod.createBudgetEnforcement({ admission: recToken });
  const recTool = admission({ dimensions: { tool_call_count: { limit: 5 } } });
  const rTool = enforcementMod.createBudgetEnforcement({ admission: recTool });
  check("V11.unsupported_meter_fail_closed", rToken.ok === false && rToken.holdCode === "BUDGET_AUTHORITY_INVALID"
    && rTool.ok === false && rTool.holdCode === "BUDGET_AUTHORITY_INVALID",
    `token_budget / tool_call_count declared -> BUDGET_AUTHORITY_INVALID (never 0-consumption)`);
}

// ── V12: NEG12 malformed/tampered state ───────────────────────────────────
{
  const rec = admission({ dimensions: DIMS });
  const enc = enforce(rec);
  dispatchNode(enc, "n1", { wallMs: 5 });
  const cp = enc.checkpointState();
  const tampered = { ...cp, envelopeId: "0".repeat(64) };
  const r1 = enforcementMod.createBudgetEnforcement({ admission: rec, checkpointState: tampered });
  const r2 = enforcementMod.createBudgetEnforcement({ admission: rec, checkpointState: { schema: "x" } });
  check("V12.malformed_state_fail_closed", r1.ok === false && r1.holdCode === "BUDGET_AUTHORITY_INVALID" && r2.ok === false,
    `tampered envelopeId / malformed state -> ${r1.holdCode}`);
}

// ── V13: NEG13 divergence -> HOLD ─────────────────────────────────────────
{
  const enc = enforce(admission({ dimensions: DIMS }));
  dispatchNode(enc, "n1", { wallMs: 5 });
  const result = {
    final: "PASS",
    nodeResults: [
      { nodeId: "n1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } },
      { nodeId: "n2", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } },
    ],
    transitions: [],
  };
  const finalized = enc.finalize(result);
  check("V13.reconciliation_divergence_hold", finalized.final === "HOLD" && finalized.holdCode === "BUDGET_RECONCILIATION_DIVERGED",
    `ledger 1 node vs evidence 2 nodes -> ${finalized.holdCode}`);
}

// ── V14: NEG14 compat surface ─────────────────────────────────────────────
{
  const compat = attachBudgetResult({ final: "PASS", nodeResults: [] }, null);
  const enc = enforce(admission({ dimensions: DIMS }));
  const authorized = attachBudgetResult({ final: "PASS", nodeResults: [], transitions: [] }, enc);
  check("V14.compat_not_authorized", compat.budget.authorized === false && compat.budget.surface === "compat"
    && authorized.budget.authorized === true && authorized.budget.surface === "production",
    `direct low-level -> authorized:false (compat); production entry -> authorized:true`);
}

// ── V15: production wiring (runAdmittedGraph) ─────────────────────────────
{
  let v15ok = true;
  const v15d = [];
  const honoring = async (opts) => {
    const enc = opts.budget.enforcement;
    const gate = enc.preDispatch({ executionId: "g", phase_id: "P1", nodeId: "P1", attempt: 0, runtime: { mode: "readonly", limits: { timeoutMs: 60000 } } });
    if (!gate.ok) return { final: "HOLD", holdCode: gate.holdCode, nodeResults: [], transitions: [] };
    enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
    return { final: "PASS", executionId: "g", nodeResults: [{ nodeId: "P1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } }], transitions: [] };
  };
  const rOk = await runAdmittedGraph({ admission: admission({ dimensions: DIMS }), runner: honoring });
  if (rOk.final !== "PASS" || rOk.budget?.authorized !== true || rOk.budget?.reconciliation?.diverged?.length !== 0) v15ok = false;
  v15d.push(`honoring runner -> ${rOk.final} (authorized=${rOk.budget?.authorized})`);
  const bypass = async () => ({ final: "PASS", executionId: "g", nodeResults: [{ nodeId: "P1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } }], transitions: [] });
  const rBypass = await runAdmittedGraph({ admission: admission({ dimensions: DIMS }), runner: bypass });
  if (rBypass.final !== "HOLD" || rBypass.holdCode !== "BUDGET_RECONCILIATION_DIVERGED") v15ok = false;
  v15d.push(`bypass runner -> ${rBypass.final} (${rBypass.holdCode})`);
  const rInvalid = await runAdmittedGraph({ admission: admission({ dimensions: { tool_call_count: { limit: 5 } } }), runner: honoring });
  if (rInvalid.final !== "HOLD" || rInvalid.holdCode !== "BUDGET_AUTHORITY_INVALID") v15ok = false;
  v15d.push(`invalid authority -> ${rInvalid.final} (${rInvalid.holdCode})`);
  const rec = admission({ dimensions: DIMS });
  const r1 = await runAdmittedGraph({ admission: rec, runner: honoring });
  const cp = r1.budget.checkpoint;
  const r2 = await runAdmittedGraph({ admission: rec, runner: honoring, budget: { checkpointState: cp } });
  if (r2.budget?.dimensions?.node_execution_count?.consumed !== 2 || r2.budget?.reconciliation?.diverged?.length !== 0) v15ok = false;
  v15d.push(`resume cumulative consumed=${r2.budget?.dimensions?.node_execution_count?.consumed}`);
  check("V15.production_wiring_enforced", v15ok, v15d.join("; "));
}

// ── V16: production graph seams ───────────────────────────────────────────
{
  let seamOk = true;
  const seamD = [];
  const colima = readFileSync(join(REPO, "src/runtime/colima-graph-runner.mjs"), "utf8");
  const subagent = readFileSync(join(REPO, "src/subagent/subagent-graph-runner.mjs"), "utf8");
  const durable = readFileSync(join(REPO, "src/v2/durable-graph.mjs"), "utf8");
  const gate = readFileSync(join(REPO, "src/admission/admission-gate.mjs"), "utf8");
  const bundle = readFileSync(join(REPO, "src/governance/review-bundle.mjs"), "utf8");
  if (!colima.includes("budget = null") || !colima.includes("budget?.enforcement?.preDispatch") || !colima.includes("attachBudgetResult(result, budget?.enforcement ?? null)")) { seamOk = false; seamD.push("colima runner lacks budget seam"); }
  if (!colima.includes("captureNodeResult(phase, { final: \"HOLD\", attempt: 0, reason: budgetGate.holdCode")) { seamOk = false; seamD.push("colima pre-dispatch gate does not synthesize a HOLD node"); }
  if (!subagent.includes("budget = null")) { seamOk = false; seamD.push("subagent runner lacks budget opt"); }
  if (!durable.includes('writeArtifact("budget-ledger.json"')) { seamOk = false; seamD.push("durable layer does not persist budget-ledger.json"); }
  if (!durable.includes("budget-ledger.json present but no authoritative admission")) { seamOk = false; seamD.push("durable resume lacks budget ledger restore"); }
  if (!gate.includes("createBudgetEnforcement")) { seamOk = false; seamD.push("production gate lacks enforcement"); }
  if (!gate.includes("return attachBudgetResult(result, enforcement)")) { seamOk = false; seamD.push("production gate lacks finalize/reconcile"); }
  if (!bundle.includes('section(5.5, "Budget Enforcement"')) { seamOk = false; seamD.push("review bundle lacks §5.5"); }
  check("V16.production_graph_seams", seamOk, seamD.length ? seamD.join("; ") : "colima pre-dispatch gate + subagent/durable forwarding + durable ledger persist + gate finalize + bundle §5.5 present");
}

// ── V17: regression suites ────────────────────────────────────────────────
// VCA-1 W1A (S3): the 3 governance sub-suite entries（review-bundle /
// graph-closeout / external-review-delivery）were removed — test:governance
// already covers them（VCA-1 R1/R2: 70 tests double-counted in the recorded
// 915）. Every entry records REAL wallMs/startedAt/completedAt（S2）.
const suites = [
  { name: "test:budget", cmd: ["node", "--test", "test/budget/*.mjs"] },
  { name: "test:admission", cmd: ["node", "--test", "test/admission/*.mjs"] },
  { name: "test:governance", cmd: ["node", "--test", "test/governance/*.mjs"] },
  { name: "test:scripted-lifecycle", cmd: ["node", "--test", "test/test-scripted-adapter.mjs", "test/test-lifecycle-runner.mjs", "test/test-standalone-paths.mjs", "test/test-normalize-reviewer-json.mjs"] },
  { name: "test:telemetry", cmd: ["node", "--test", "test/telemetry/*.mjs"] },
  { name: "test:v2", cmd: ["node", "--test", "test/v2/*.mjs"] },
];
const regression = [];
for (const s of suites) {
  const r = runSuiteSync(s.cmd, { cwd: REPO, timeoutMs: 2400000 });
  const suiteOk = r.ok && r.tests > 0 && r.failed === 0;
  regression.push({ suite: s.name, tests: r.tests, passed: r.passed, failed: r.failed, ok: suiteOk, startedAt: r.startedAt, completedAt: r.completedAt, wallMs: r.wallMs, timingSource: r.timingSource });
}
const allGreen = regression.every((r) => r.ok);
const regTotal = regression.reduce((a, r) => a + r.tests, 0);
const regPassed = regression.reduce((a, r) => a + r.passed, 0);
check("V17.regression_green", allGreen, `${renderVerifierAccounting(regression)} across budget + admission + governance + scripted-lifecycle + telemetry + v2 (${regTotal} tests, ${regression.reduce((a, r) => a + r.wallMs, 0)}ms wall)`);

// ── V18: scope guard（content-identity aware vs ta3 baseline）─────────────
let scopeOk = true;
let scopeDetail = "";
try {
  const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: REPO, encoding: "utf8" });
  const touched = new Set();
  for (const line of status.split("\n").filter(Boolean)) {
    const p = line.slice(3).trim();
    touched.add(p);
    if (line.startsWith("R")) { const to = p.split(" -> ")[1]; if (to) touched.add(to); }
  }
  const authorizedPrefixes = [
    "src/budget/",
    "test/budget/",
    "src/admission/",
    "src/runtime/",
    "src/subagent/",
    "src/v2/",
    "src/governance/",
    "test/governance/",
    "test/admission/",
    "test/telemetry/",
    "scripts/ta3-",
    "docs/pi-graph-output/ta3/",
  ];
  const authorizedFiles = [
    "src/admission/admission-gate.mjs",
    "src/runtime/colima-graph-runner.mjs",
    "src/subagent/subagent-graph-runner.mjs",
    "src/v2/durable-graph.mjs",
    "src/governance/review-bundle.mjs",
    "test/admission/test-admission-gate.mjs",
    "test/telemetry/test-telemetry-graph-invariance.mjs",
  ];
  const baselinePath = join(OUT, "ta3-card-start-baseline.json");
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : { dirtyPaths: [], pathShas: {} };
  const preExisting = new Set((baseline.dirtyPaths ?? []).map((x) => String(x).replace(/\/$/, "")));
  const baselineShas = baseline.pathShas ?? {};
  const norm = (x) => String(x).replace(/\/$/, "");
  for (const raw of touched) {
    const p = norm(raw);
    const inAuth = authorizedPrefixes.some((a) => p === a.replace(/\/$/, "") || p.startsWith(a)) || authorizedFiles.includes(p);
    if (inAuth) continue;
    const preExistingChild = [...preExisting].some((b) => p === b || p.startsWith(b + "/") || b.startsWith(p + "/"));
    if (preExisting.has(p) || preExistingChild) {
      // content-identity: a pre-existing dirty file the card DID NOT modify
      //（card-start sha == closeout sha）stays excluded. Directories cannot
      // be content-hashed — collapsed git dir entries are excluded by
      // membership alone（their files are enumerated individually）.
      const st = statSync(join(REPO, p), { throwIfNoEntry: false });
      if (!st || !st.isFile()) continue;
      const cur = readFileSync(join(REPO, p), "utf8");
      if (baselineShas[p] === sha256(cur)) continue;
      if (!authorizedPrefixes.some((a) => p.startsWith(a)) && !authorizedFiles.includes(p)) {
        scopeOk = false;
        scopeDetail += `pre-existing content-modified OUTSIDE authorized scope: ${raw}; `;
      }
      continue;
    }
    scopeOk = false;
    scopeDetail += `${raw}; `;
  }
} catch (e) { scopeOk = false; scopeDetail = e.message; }
check("V18.scope_guard", scopeOk, scopeDetail || "every touched path is TA-3 authorized or card-start pre-existing and content-unchanged");

// ── V19: R9 single-model policy ───────────────────────────────────────────
let r9ok = false;
let r9d = "";
try {
  const schema = JSON.parse(readFileSync(join(REPO, "src/schema/card-input.schema.json"), "utf8"));
  const desc = schema.properties.executor.properties.model.description ?? "";
  const transport = readFileSync(join(REPO, "src/v2/pi-transport-adapter.mjs"), "utf8");
  const descAllowsPro = /(allowlist|allowed|currently).{0,60}deepseek-v4-pro/.test(desc);
  r9ok = desc.includes("deepseek-v4-flash") && !descAllowsPro && /model:\s*["']deepseek-v4-flash["']/.test(transport) && !/model:\s*["']deepseek-v4-pro["']/.test(transport);
  r9d = r9ok ? "executor allowlist = deepseek/deepseek-v4-flash only (R9)" : "allowlist widened or pro enabled";
} catch (e) { r9d = e.message; }
check("V19.r9_single_model", r9ok, r9d);

// ── V20: TA-2 repair-lineage contract unchanged ───────────────────────────
let v20ok = true;
let v20d = "";
try {
  const bundles = existsSync(TA2R) ? readdirSync(TA2R).filter((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt")) : [];
  const lineage = parseRepairLineage(readFileSync(join(TA2R, "card-closeout-bundle-20260809-f7f168aa.txt"), "utf8"));
  if (lineage.generationType !== "surface-reseal" || lineage.budgetUsed !== 1 || lineage.repairIterations !== 1) {
    v20ok = false;
    v20d = `TA-2R lineage parse mismatch: ${JSON.stringify(lineage)}`;
  } else {
    v20d = `TA-2R lineage intact (${lineage.generationType}, USED=${lineage.budgetUsed}/MAX=${lineage.budgetMax}, iterations=${lineage.repairIterations})`;
  }
} catch (e) { v20ok = false; v20d = e.message; }
check("V20.repair_lineage_no_regression", v20ok, v20d);

// ── V21: final-surface（TA-3 bundle when generated）───────────────────────
let v21ok = true;
let v21d = [];
const ta3Bundles = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt")) : [];
for (const b of ta3Bundles) {
  const text = readFileSync(join(OUT, b), "utf8");
  const residue = assertNoTemplateResidue(text);
  if (!residue.ok) { v21ok = false; v21d.push(`residue: ${residue.matches.slice(0, 3).join("|")}`); }
  const v = validateReviewBundle(join(OUT, b), { authorizedDir: OUT });
  if (!v.ok) { v21ok = false; v21d.push(v.errors.slice(0, 3).join("|")); }
  v21d.push(`${b} clean`);
}
check("V21.final_surface_bundle", v21ok, ta3Bundles.length ? v21d.join("; ") : "no TA-3 bundle yet (closeout not run)");

// ── summary ──────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const summary = {
  schema: "autoloop.ta3-verification/v1",
  card: "AUTOLOOP-TA3",
  generation: "implementation",
  verifiedAt: new Date().toISOString(),
  // VCA-1 W1A (S2): real measured timing for this verification run.
  ...timingFields(VERIFY_STARTED_AT, Date.now()),
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  ok: failed.length === 0,
  checks: results.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail })),
  regression,
  digest: sha256(canonical(results)),
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
