#!/usr/bin/env node
// scripts/ta3-independent-review.mjs
//
// AUTOLOOP-TA3 — independent review（deterministic, local, machine
// cross-check）. Independently recomputes the card's machine-verifiable
// claims — NOT a re-run of ta3-verify.mjs: it re-derives the evidence from
// the source modules + verification accounting:
//
//   IR-1  verification 21/21（ta3-verification.json）ok
//   IR-2  sample admissions + budget envelopes re-derivable（deterministic）
//   IR-3  budget contract schema + dimension inventory（independent read）
//   IR-4  NEG suite accounting cross-check（test:budget entry in
//        ta3-verification.json — contract cross-check, NO suite re-run）
//   IR-5  non-bypassability（independent spy proof: bypass -> HOLD）
//   IR-6  crash/resume cumulative accounting（independent recompute）
//   IR-7  production wiring seams（independent source inspection）
//   IR-8  scope guard（independent git status parse）
//   IR-9  R9 single-model policy（deepseek-v4-flash only）
//   IR-10 regression accounting cross-check vs ta3-verification.json
//
// Writes docs/pi-graph-output/ta3/ta3-independent-review.json +
// docs/pi-graph-output/ta3/ta3-sample-admissions.json（production
// classifier; envelope derivation reproducible — IR-2）.
//
// Run: node scripts/ta3-independent-review.mjs
// Local-only, deterministic, no network, no commit/push/seal.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "docs", "pi-graph-output", "ta3");

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const canonical = (v) => {
  const sort = (x) => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  };
  return JSON.stringify(sort(v));
};

const checks = [];
const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });

// ── IR-1: verification accounting ─────────────────────────────────────────
let verification = null;
const vPath = join(OUT, "ta3-verification.json");
if (existsSync(vPath)) verification = JSON.parse(readFileSync(vPath, "utf8"));
check("IR-1.verification_ok", verification !== null && verification.ok === true, verification ? `ta3-verify ${verification.passed}/${verification.total}` : "ta3-verification.json missing");

// ── IR-2: sample admissions + budget envelopes（deterministic）────────────
const samples = [];
const envelopeSamples = [];
{
  const { classify, scanRiskSignals } = await import("../src/admission/classify.mjs");
  const { buildAdmissionRecord } = await import("../src/admission/policy-projection.mjs");
  const { freezeAdmission, deriveAdmissionId, validateAdmission } = await import("../src/admission/admission-record.mjs");
  const { deriveBudgetEnvelope } = await import("../src/budget/envelope.mjs");
  const FULL = {
    affected_files: { score: 1, reasons: ["single README file"] }, affected_subsystems: { score: 0, reasons: ["docs only"] },
    dependency_depth: { score: 0, reasons: ["no deps"] }, ambiguity: { score: 0, reasons: ["exact text"] },
    expected_execution_steps: { score: 0, reasons: ["one edit"] }, verification_burden: { score: 0, reasons: ["no tests"] },
    external_dependencies: { score: 0, reasons: ["none"] }, concurrency_potential: { score: 0, reasons: ["none"] },
    statefulness: { score: 0, reasons: ["stateless"] }, rollback_complexity: { score: 0, reasons: ["revert 1 file"] },
  };
  const fixtures = [
    { taskId: "TA3-SAMPLE-FAST", text: "fix one typo in README", dims: null },
    {
      taskId: "TA3-SAMPLE-MEDIUM", text: "refactor the admission module and add a migration with bounded repair",
      dims: { node_execution_count: { limit: 24 }, wall_clock_ms: { limit: 600000 }, repair_attempt_count: { limit: 2 }, verifier_reviewer_attempts: { limit: 4 }, retry_count: { limit: 2 }, sub_agent_execution_count: { limit: 8 } },
    },
    {
      taskId: "TA3-SAMPLE-CRITICAL", text: "change the production scheduler authority and update the durable checkpoint format",
      dims: { node_execution_count: { limit: 96 }, wall_clock_ms: { limit: 3600000 }, repair_attempt_count: { limit: 3 }, verifier_reviewer_attempts: { limit: 8 }, retry_count: { limit: 4 }, sub_agent_execution_count: { limit: 32 } },
    },
  ];
  let allOk = true;
  for (const f of fixtures) {
    const c = classify({ dimensionScores: FULL, riskSignals: scanRiskSignals(f.text) });
    const rec = freezeAdmission(buildAdmissionRecord({
      taskId: f.taskId,
      classification: c,
      mutationScope: ["src/", "docs/"],
      extensions: f.dims ? { budget: { schema: "autoloop.budget-contract/v1", version: 1, dimensions: f.dims } } : {},
    }));
    const id1 = deriveAdmissionId(rec);
    const id2 = deriveAdmissionId(freezeAdmission({ ...rec, decision_time: "2099-01-01T00:00:00.000Z" }));
    const env = deriveBudgetEnvelope(rec);
    const env2 = deriveBudgetEnvelope(rec);
    const valid = validateAdmission(rec).ok && env.ok && env.envelope.envelopeId === env2.envelope.envelopeId && id1 === rec.admission_id && id2 === rec.admission_id;
    if (!valid) allOk = false;
    samples.push({ taskId: f.taskId, text: f.text, size: rec.size, risk: rec.risk, profile: rec.profile, admission_id: rec.admission_id, envelopeId: env.ok ? env.envelope.envelopeId : null, envelopeSource: env.ok ? env.envelope.contractSource : null, envelopeDimensions: env.ok ? env.envelope.dimensions : null });
    envelopeSamples.push({
      schema: "autoloop.budget-envelope-sample/v1",
      taskId: f.taskId,
      admissionId: rec.admission_id,
      envelopeId: env.ok ? env.envelope.envelopeId : null,
      contractSource: env.ok ? env.envelope.contractSource : null,
      admissionProfile: env.ok ? env.envelope.admissionProfile : null,
      dimensions: env.ok ? env.envelope.dimensions : null,
    });
  }
  check("IR-2.sample_admissions_and_envelopes_deterministic", allOk, `${samples.length} samples; ids + envelopeIds re-derivable`);
}

// ── IR-3: contract schema + dimension inventory（independent read）────────
{
  const { BUDGET_CONTRACT_SCHEMA, BUDGET_STATES, ENFORCED_DIMENSIONS, DEFERRED_DIMENSIONS, DIMENSION_METER_MAP } = await import("../src/budget/contract.mjs");
  const ok = BUDGET_CONTRACT_SCHEMA === "autoloop.budget-contract/v1"
    && BUDGET_STATES.length === 4
    && ENFORCED_DIMENSIONS.every((d) => DIMENSION_METER_MAP[d]?.supported === true && DIMENSION_METER_MAP[d].meterSource)
    && DEFERRED_DIMENSIONS.every((d) => DIMENSION_METER_MAP[d]?.supported === false && DIMENSION_METER_MAP[d].deferredReason);
  check("IR-3.contract_and_inventory", ok, `${ENFORCED_DIMENSIONS.length} enforced + ${DEFERRED_DIMENSIONS.length} deferred (disclosed)`);
}

// ── IR-4: NEG suite accounting（contract cross-check, no re-run）──────────
// VCA-1 W1A (S4): the independent review does NOT re-execute a full suite
// V1 already verified. IR's job is independent recomputation of claims — so
// IR-4 cross-checks the structured test:budget accounting recorded in
// ta3-verification.json（same evidence/contract the closeout renders）.
{
  const budgetEntry = (verification?.regression ?? []).find((r) => r.suite === "test:budget");
  const ok = budgetEntry !== undefined
    && budgetEntry.ok === true
    && budgetEntry.failed === 0
    && Number.isFinite(budgetEntry.tests)
    && budgetEntry.tests > 0;
  const wall = Number.isFinite(budgetEntry?.wallMs) ? `, ${budgetEntry.wallMs}ms wall (measured by V1)` : "";
  check("IR-4.neg_suite_accounting_cross_check", ok,
    budgetEntry ? `test:budget ${budgetEntry.passed}/${budgetEntry.tests} green in V17 accounting (not re-run by IR)${wall}` : "test:budget missing from verification accounting");
}

// ── IR-5: non-bypassability（independent spy proof）───────────────────────
{
  const { classify, scanRiskSignals } = await import("../src/admission/classify.mjs");
  const { buildAdmissionRecord } = await import("../src/admission/policy-projection.mjs");
  const { freezeAdmission } = await import("../src/admission/admission-record.mjs");
  const { runAdmittedGraph } = await import("../src/admission/admission-gate.mjs");
  const FULL = {
    affected_files: { score: 1, reasons: ["x"] }, affected_subsystems: { score: 0, reasons: ["x"] },
    dependency_depth: { score: 0, reasons: ["x"] }, ambiguity: { score: 0, reasons: ["x"] },
    expected_execution_steps: { score: 0, reasons: ["x"] }, verification_burden: { score: 0, reasons: ["x"] },
    external_dependencies: { score: 0, reasons: ["x"] }, concurrency_potential: { score: 0, reasons: ["x"] },
    statefulness: { score: 0, reasons: ["x"] }, rollback_complexity: { score: 0, reasons: ["x"] },
  };
  const c = classify({ dimensionScores: FULL, riskSignals: scanRiskSignals("fix one typo") });
  const rec = freezeAdmission(buildAdmissionRecord({
    taskId: "IR5",
    classification: c,
    mutationScope: ["docs/"],
    extensions: { budget: { schema: "autoloop.budget-contract/v1", version: 1, dimensions: { node_execution_count: { limit: 2 }, wall_clock_ms: { limit: 600000 }, sub_agent_execution_count: { limit: 1 }, repair_attempt_count: { limit: 1 }, verifier_reviewer_attempts: { limit: 1 }, retry_count: { limit: 1 } } } },
  }));
  const honoring = async (opts) => {
    const enc = opts.budget.enforcement;
    const gate = enc.preDispatch({ executionId: "g", phase_id: "P1", nodeId: "P1", attempt: 0, runtime: { limits: { timeoutMs: 60000 } } });
    if (!gate.ok) return { final: "HOLD", holdCode: gate.holdCode, nodeResults: [], transitions: [] };
    enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
    return { final: "PASS", executionId: "g", nodeResults: [{ nodeId: "P1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } }], transitions: [] };
  };
  const bypass = async () => ({ final: "PASS", executionId: "g", nodeResults: [{ nodeId: "P1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } }], transitions: [] });
  const rHonor = await runAdmittedGraph({ admission: rec, runner: honoring });
  const rBypass = await runAdmittedGraph({ admission: rec, runner: bypass });
  check("IR-5.non_bypassability", rHonor.final === "PASS" && rBypass.final === "HOLD" && rBypass.holdCode === "BUDGET_RECONCILIATION_DIVERGED",
    `honoring runner -> ${rHonor.final}; bypass runner -> ${rBypass.final} (${rBypass.holdCode})`);
}

// ── IR-6: crash/resume cumulative（independent recompute）─────────────────
{
  const { classify, scanRiskSignals } = await import("../src/admission/classify.mjs");
  const { buildAdmissionRecord } = await import("../src/admission/policy-projection.mjs");
  const { freezeAdmission } = await import("../src/admission/admission-record.mjs");
  const { deriveBudgetEnvelope } = await import("../src/budget/envelope.mjs");
  const { createBudgetLedger, ledgerReserve, ledgerSettle, checkpointBudgetLedger, resumeBudgetLedger } = await import("../src/budget/ledger.mjs");
  const FULL = {
    affected_files: { score: 1, reasons: ["x"] }, affected_subsystems: { score: 0, reasons: ["x"] },
    dependency_depth: { score: 0, reasons: ["x"] }, ambiguity: { score: 0, reasons: ["x"] },
    expected_execution_steps: { score: 0, reasons: ["x"] }, verification_burden: { score: 0, reasons: ["x"] },
    external_dependencies: { score: 0, reasons: ["x"] }, concurrency_potential: { score: 0, reasons: ["x"] },
    statefulness: { score: 0, reasons: ["x"] }, rollback_complexity: { score: 0, reasons: ["x"] },
  };
  const c = classify({ dimensionScores: FULL, riskSignals: scanRiskSignals("fix one typo") });
  const rec = freezeAdmission(buildAdmissionRecord({
    taskId: "IR6",
    classification: c,
    mutationScope: ["docs/"],
    extensions: { budget: { schema: "autoloop.budget-contract/v1", version: 1, dimensions: { node_execution_count: { limit: 10 }, wall_clock_ms: { limit: 600000 }, sub_agent_execution_count: { limit: 2 }, repair_attempt_count: { limit: 2 }, verifier_reviewer_attempts: { limit: 2 }, retry_count: { limit: 2 } } } },
  }));
  const env = deriveBudgetEnvelope(rec).envelope;
  const ledger = createBudgetLedger({ envelope: env });
  ledgerReserve(ledger, env, { opKey: "g:n1:0", amounts: { node_execution_count: 1, wall_clock_ms: 60000 } });
  ledgerSettle(ledger, env, { opKey: "g:n1:0", actualAmounts: { node_execution_count: 1, wall_clock_ms: 100 } });
  ledgerReserve(ledger, env, { opKey: "g:n2:0", amounts: { node_execution_count: 1, wall_clock_ms: 60000 } }); // crash before settle
  const cp = checkpointBudgetLedger(ledger);
  const resumed = resumeBudgetLedger({ envelope: env, state: cp });
  check("IR-6.crash_resume_cumulative", resumed.ok === true && resumed.ledger.counters.node_execution_count === 2
    && resumed.ledger.counters.wall_clock_ms === 100 + 60000,
    `pre-crash 1 node + in-flight upper-bound -> resumed ${resumed.ledger?.counters.node_execution_count} nodes, ${resumed.ledger?.counters.wall_clock_ms}ms (no reset)`);
}

// ── IR-7: production wiring seams（independent source inspection）─────────
{
  const colima = readFileSync(join(REPO, "src/runtime/colima-graph-runner.mjs"), "utf8");
  const gate = readFileSync(join(REPO, "src/admission/admission-gate.mjs"), "utf8");
  const durable = readFileSync(join(REPO, "src/v2/durable-graph.mjs"), "utf8");
  const ok = colima.includes("budget?.enforcement?.preDispatch") && colima.includes("attachBudgetResult(result, budget?.enforcement ?? null)")
    && gate.includes("createBudgetEnforcement") && gate.includes("attachBudgetResult(result, enforcement)")
    && durable.includes('writeArtifact("budget-ledger.json"');
  check("IR-7.production_seams", ok, "colima pre-dispatch gate; admission-gate enforcement; durable ledger persist all present");
}

// ── IR-8: scope guard（independent git status parse）──────────────────────
let scopeOk = true;
let scopeDetail = "";
try {
  const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: REPO, encoding: "utf8" });
  const prefixes = ["src/budget/", "test/budget/", "src/admission/", "src/runtime/", "src/subagent/", "src/v2/", "src/governance/", "test/governance/", "test/admission/", "test/telemetry/", "scripts/ta3-", "docs/pi-graph-output/ta3/"];
  const files = ["src/admission/admission-gate.mjs", "src/runtime/colima-graph-runner.mjs", "src/subagent/subagent-graph-runner.mjs", "src/v2/durable-graph.mjs", "src/governance/review-bundle.mjs", "test/admission/test-admission-gate.mjs", "test/telemetry/test-telemetry-graph-invariance.mjs"];
  const baseline = existsSync(join(OUT, "ta3-card-start-baseline.json")) ? JSON.parse(readFileSync(join(OUT, "ta3-card-start-baseline.json"), "utf8")) : { dirtyPaths: [] };
  const preExisting = new Set((baseline.dirtyPaths ?? []).map((x) => String(x).replace(/\/$/, "")));
  for (const line of status.split("\n").filter(Boolean)) {
    const p = line.slice(3).trim().replace(/\/$/, "");
    if (prefixes.some((a) => p === a.replace(/\/$/, "") || p.startsWith(a)) || files.includes(p)) continue;
    const inPre = [...preExisting].some((b) => p === b || p.startsWith(b + "/") || b.startsWith(p + "/"));
    if (inPre) continue;
    scopeOk = false;
    scopeDetail += `${line}; `;
  }
} catch (e) { scopeOk = false; scopeDetail = e.message; }
check("IR-8.scope_guard", scopeOk, scopeDetail || "every touched path is TA-3 authorized or card-start pre-existing");

// ── IR-9: R9 single-model policy ──────────────────────────────────────────
{
  const schema = JSON.parse(readFileSync(join(REPO, "src/schema/card-input.schema.json"), "utf8"));
  const desc = schema.properties.executor.properties.model.description ?? "";
  const transport = readFileSync(join(REPO, "src/v2/pi-transport-adapter.mjs"), "utf8");
  const ok = desc.includes("deepseek-v4-flash") && !/deepseek-v4-pro/.test(transport);
  check("IR-9.r9_single_model", ok, "deepseek-v4-flash only (R9)");
}

// ── IR-10: regression accounting cross-check ──────────────────────────────
// VCA-1 W1A (S3/S4): V17 no longer carries the 3 governance sub-suite
// entries（covered by test:governance）— expect >= 6 distinct suites.
{
  const ok = verification !== null && Array.isArray(verification.regression) && verification.regression.length >= 6
    && verification.regression.every((r) => r.ok === true && r.failed === 0)
    && !verification.regression.some((r) => r.suite === "test:review-bundle" || r.suite === "test:graph-closeout" || r.suite === "test:external-review-delivery");
  const total = verification?.regression?.reduce((a, r) => a + r.tests, 0) ?? 0;
  const wall = verification?.regression?.reduce((a, r) => a + (Number.isFinite(r.wallMs) ? r.wallMs : 0), 0) ?? 0;
  check("IR-10.regression_cross_check", ok, `${total} tests across ${verification?.regression?.length ?? 0} distinct suites, all green (${wall}ms wall recorded)`);
}

// ── write outputs ─────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const failedChecks = checks.filter((c) => !c.ok);
const summary = {
  schema: "autoloop.ta3-independent-review/v1",
  card: "AUTOLOOP-TA3",
  generation: "implementation",
  reviewedAt: new Date().toISOString(),
  total: checks.length,
  passed: checks.length - failedChecks.length,
  failed: failedChecks.length,
  ok: failedChecks.length === 0,
  checks,
  digest: sha256(canonical(checks)),
};
writeFileSync(join(OUT, "ta3-independent-review.json"), JSON.stringify(summary, null, 2) + "\n");
writeFileSync(join(OUT, "ta3-sample-admissions.json"), JSON.stringify({ schema: "autoloop.ta3-sample-admissions/v1", samples, envelopeSamples }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
