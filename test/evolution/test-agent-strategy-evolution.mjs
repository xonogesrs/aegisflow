// test/evolution/test-agent-strategy-evolution.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVOLUTION_COMPLETION_1 — acceptance suite.
//
//   S1  §A attribution: every axis derived from real durable evidence; secrets
//       and free text never copied; deterministic; unobservable axes are null.
//   S2  §D memory: an observation is provenance-bound; ONE execution is never
//       sufficient evidence.
//   S3  §D memory: idempotent by identity, bounded, conflict fail-closed.
//   S4  §B producer: a bounded plan is derived FROM the evidence (helper-level).
//   S5  §B producer: INCONCLUSIVE vs NO_CANDIDATE — never a fabricated plan.
//   S6  §C candidate classes: LOW bounded knobs, MEDIUM prompt floor, HIGH
//       refusal for anything outside the bounded schema.
//   S7  §E routing seam: supported routes only; explicit binding always wins.
//   S8  §H strategy fitness: ACCEPT needs regression PASS + target IMPROVED +
//       sufficient evidence; every other outcome REJECTs.
//   S9  §I cross-agent: agent A's evidence → candidate → promotion → future
//       route resolution changes for agent B/C.
//   S10 §L CASE 1: GLM repeated repair → attributable → strategy candidate.
//   S11 §L CASE 2: GLM vs DeepSeek on one task class → routing fitness →
//       future preference.
//   S12 §L CASE 3: decomposition/context exhaustion → bounded candidate.
//   S13 §L CASE 4: prompt → MEDIUM candidate → stops before autonomous
//       promotion.
//   S14 §K NATURAL end-to-end through runAdmittedGraph with NO hand-fed plan.
//   S15 §J strategy canary regression → automatic deactivation (rollback).
//
// Run: node --test test/evolution/test-agent-strategy-evolution.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";

import { deriveAttribution, canonicalTaskClass, CONTEXT_BANDS } from "../../src/evolution/attribution.mjs";
import {
  buildStrategyObservation, recordStrategyObservation, readStrategyMemory,
  summarizeStrategyDimension, strategyMemoryView, MIN_SAMPLES_FOR_SUFFICIENCY,
} from "../../src/evolution/strategy-memory.mjs";
import { produceImprovementPlan, diagnoseDimension, DIAGNOSIS_THRESHOLDS, knobSpaceOf } from "../../src/evolution/plan-producer.mjs";
import { classifyStrategyRisk, deriveStrategyCandidate } from "../../src/evolution/candidate-strategy.mjs";
import {
  validateStrategyValue, activateStrategyValue, deactivateStrategyValue,
  readStrategyPolicy, resolveRoutePreference, resolveProductionRoute,
  allowedCanonicalToolIds, strategyPolicyView, STRATEGY_STORE_HOLD,
} from "../../src/evolution/strategy-store.mjs";
import { evaluateStrategyFitness } from "../../src/evolution/fitness-strategy.mjs";
import { selectRouteForTaskClass, SUPPORTED_ROUTE_VALUES, defaultRoute } from "../../src/evolution/strategy-routing.mjs";
import { runEvolutionCycle, EVOLUTION_LOOP_VERDICTS } from "../../src/evolution/loop.mjs";
import { createEvolutionPolicy } from "../../src/evolution/policy.mjs";
import { readCanary } from "../../src/evolution/canary.mjs";
import { readTriggerState, extractTriggerObservations, evaluateSignals, DEFAULT_SIGNAL_WINDOW_MS } from "../../src/evolution/trigger.mjs";
import { RunEvidenceStore } from "../../src/evidence/run-evidence-store.mjs";

import * as attributionMod from "../../src/evolution/attribution.mjs";

const validateValue = validateStrategyValue;
const readPolicy = readStrategyPolicy;

const ROOTS = [];
function freshDir(label) {
  const d = mkdtempSync(join(tmpdir(), `evol-strat-${label}-`));
  ROOTS.push(d);
  return d;
}
test.after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function makeFixtureRepo(label) {
  const repo = freshDir(label);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.email", "evol@test"]);
  git(repo, ["config", "user.name", "evol-fixture"]);
  mkdirSync(join(repo, "lib"), { recursive: true });
  writeFileSync(join(repo, "lib", "retry.ts"), "export const MAX_RETRIES = 3;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

const PATCH = [
  "--- a/lib/retry.ts",
  "+++ b/lib/retry.ts",
  "@@ -1,1 +1,1 @@",
  "-export const MAX_RETRIES = 3;",
  "+export const MAX_RETRIES = 2;",
  "",
].join("\n");

function policyInput(overrides = {}) {
  return {
    policy_name: "agent-strategy-test",
    scope_patterns: ["lib/**"],
    forbidden_patterns: [],
    // §C/§J: agent-strategy authority is OPT-IN and operator-issued. The
    // production CLI lane can only issue the LOW dimensions, so the default
    // test policy declares exactly those.
    strategy_dimensions_allowed: [
      "MODEL_ROUTING", "DECOMPOSITION", "CONTEXT_ALLOCATION",
      "RETRY_REPAIR", "FANOUT_PARALLELISM", "TOOL_SELECTION",
    ],
    allowed_commands: ["node", "git"],
    validation_plan_id: "strategy-validation-test",
    validation_plan: { commands: [{ cmd: "node", args: ["-e", "process.exit(0)"], timeout_ms: 30000 }] },
    budget: { max_mutation_runs: 8, max_wall_clock_ms_per_run: 120000, max_evolutions_per_window: 8, window_ms: 86400000 },
    issued_by: "test-operator",
    authorization_ref: "test://strategy-policy",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

// ── evidence fixtures ──────────────────────────────────────────────────────

const ROUTE_ROWS = Object.freeze([
  { providerKind: "deepseek", modelId: "deepseek-v4-flash", adapterKind: "pi-builtin", requiredEnvKeys: [] },
  { providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash", adapterKind: "pi-builtin", requiredEnvKeys: [] },
]);

const DEEPSEEK = ROUTE_ROWS[0];
const GLM = ROUTE_ROWS[1];

/**
 * Build ONE run's durable journal for a given shape. Everything here is what a
 * real run would journal — the attribution is derived FROM these rows.
 */
function journalFor({
  outcome = "PASS", repairs = 0, occupancy = null, occupancySamples = 0,
  phaseCount = null, concurrency = 1, tools = null, maxAttempt = 0,
  holdCode = "HOLD / C3B_MUTATION_FAILED", generation = null, extraEvents = [],
} = {}) {
  // A durable journal row ALWAYS carries a timestamp (the store writes one);
  // the fixtures must too, or latency/concurrency would be unmeasurable.
  //
  // The base is RELATIVE to now, and must stay so: the trigger's observation
  // window is `DEFAULT_SIGNAL_WINDOW_MS` (24h) measured against `Date.now()`,
  // and `extractTriggerObservations` DROPS any event older than the window.
  // An absolute fixture date therefore makes every seeded journal expire 24h
  // after that date: the signals stop crossing their floor, the loop returns
  // NO_TRIGGER before the candidate stage, and the S13/S16 assertions never
  // reach the stage they exist to test. This is a property of the fixture, not
  // of the pipeline — see `SIGNAL_COUNT_FLOOR` in src/evolution/trigger.mjs.
  const base = Date.now() - 60 * 60 * 1000; // one hour ago: always inside the window
  let tick = 0;
  const stamp = (e) => ({ ...e, timestamp: new Date(base + tick++ * 1000).toISOString() });
  const events = [];
  if (phaseCount !== null) {
    events.push({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: { phase_count: phaseCount, ir_sha256: "a".repeat(64), dag_sha256: "b".repeat(64) } });
  }
  // concurrency phases, each started then terminated (overlapping intervals)
  const phases = Math.max(concurrency, 1);
  for (let i = 0; i < phases; i++) {
    events.push({ event_type: "PHASE_STARTED", stage: "phase", phase_id: `P${i}`, payload: {} });
  }
  for (let i = 0; i < repairs; i++) {
    events.push({ event_type: "PHASE_REPAIR_REQUESTED", stage: "phase", phase_id: "P0", attempt: Math.max(1, maxAttempt || i + 1), payload: {} });
  }
  for (let i = 0; i < phases; i++) {
    events.push({ event_type: outcome === "HOLD" && i === 0 ? "PHASE_HELD" : "PHASE_PASSED", stage: "phase", phase_id: `P${i}`, payload: {} });
  }
  if (tools) {
    events.push({ event_type: "TOOL_USAGE_OBSERVED", stage: "tool", phase_id: "P0", payload: { canonical_tool_ids: tools } });
  }
  if (occupancy !== null) {
    for (let i = 0; i < Math.max(1, occupancySamples); i++) {
      events.push({ event_type: "PROVIDER_USAGE_OBSERVED", stage: "rollover", phase_id: "P0", payload: { provider_reported: true, occupancy, occupancy_fields: ["context"], threshold: 0.8 } });
    }
  }
  if (generation !== null) {
    events.push({ event_type: "SPAWN_DISPATCH", stage: "rollover", payload: { sessionGeneration: generation } });
  }
  events.push(...extraEvents);
  events.push({
    event_type: outcome === "PASS" ? "RUN_PASSED" : outcome === "HOLD" ? "RUN_HELD" : "RUN_NOT_BENEFICIAL",
    stage: "terminal",
    payload: outcome === "HOLD" ? { reason: holdCode } : {},
  });
  return events.map(stamp);
}

let obsSeq = 0;
/** Record one attributed run into the strategy memory, returning the
 *  attribution + the recorded observation. */
function recordRun(storeRoot, {
  taskClass = "BUGFIX", route = DEEPSEEK, outcome = "PASS", label = null, promptProfile = null, ...shape
} = {}) {
  obsSeq += 1;
  const events = journalFor({ outcome, ...shape });
  const attribution = deriveAttribution({
    events,
    admittedBinding: route,
    taskClass,
    executionId: `exec_${createHash("sha256").update(label ?? `s${obsSeq}`).digest("hex").slice(0, 32)}`,
    graphRunId: `g${obsSeq}`,
    admissionId: `adm_${obsSeq}`,
    promptProfile,
  });
  const observation = buildStrategyObservation({ attribution, evidenceRefs: events.map((e, i) => `evt_obs_${obsSeq}_${i}`) });
  const res = recordStrategyObservation({ storeRoot, observation });
  return { attribution, observation: res.observation, status: res.status };
}

/** Seed N runs of one route/shape into a task class. */
function seedRuns(storeRoot, n, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(recordRun(storeRoot, { ...opts, label: `${opts.label ?? "seed"}-${i}` }));
  return out;
}

// ── S0: the trigger observation window is a FIXTURE invariant ──────────────
// Guards the drift that made S13/S16 fail: an absolute fixture timestamp ages
// out of the 24h trigger window, `extractTriggerObservations` drops every
// observation, and the loop returns NO_TRIGGER before the candidate stage —
// so the assertions downstream never execute. The failure surfaces 24h after
// the fixture date, far from the change that caused it. This makes it local.
test("S0 trigger window: journalFor fixtures stay inside the 24h observation window", () => {
  const observations = extractTriggerObservations({ events: journalFor({ outcome: "HOLD", repairs: 3 }) });
  assert.ok(observations.length > 0, "fixture events must survive the observation window (a stale absolute base makes them vanish)");
  const fired = evaluateSignals({ observations, thresholds: {} });
  assert.ok(fired.some((f) => f.signalClass === "REPEATED_REPAIR_REQUIREMENT"), "3 repairs must cross the REPEATED_REPAIR_REQUIREMENT floor");
  const oldest = Math.min(...observations.map((o) => o.at));
  assert.ok(Date.now() - oldest < DEFAULT_SIGNAL_WINDOW_MS, "the fixture base must be relative to now, never an absolute date");
});

// ── S1: §A attribution ─────────────────────────────────────────────────────

test("S1 §A attribution: every axis derived from durable evidence; no secrets, no free text, deterministic", () => {
  const SECRET = "Authorization: Bearer sk-live-ABCDEFGHIJKLMNOPQRSTUV";
  const events = journalFor({
    outcome: "HOLD", repairs: 3, occupancy: 0.82, occupancySamples: 2, phaseCount: 7,
    concurrency: 3, tools: ["fs.read", "fs.grep"], maxAttempt: 4, generation: 2,
    holdCode: `HOLD / C3B_MUTATION_FAILED: ${SECRET}`,
    extraEvents: [{ event_type: "NOTE", stage: "phase", phase_id: "P0", payload: { free_text: SECRET } }],
  });
  const a = deriveAttribution({ events, admittedBinding: GLM, taskClass: "Bugfix", executionId: "exec_" + "ab".padEnd(32, "0"), graphRunId: "gA", admissionId: "adm_1", promptProfile: "reviewer-v2" });

  // ── every declared axis is present ──────────────────────────────────────
  for (const axis of attributionMod.ATTRIBUTION_AXES) {
    assert.ok(axis in a, `axis ${axis} present`);
  }
  assert.equal(a.provider, "merge-gateway");
  assert.equal(a.model, "zai/glm-5.3-flash");
  assert.equal(a.adapter_kind, "pi-builtin");
  assert.equal(a.task_class, "BUGFIX", "task class canonicalized");
  assert.equal(a.prompt_profile, "reviewer-v2");
  assert.deepEqual(a.agent_identity.phase_ids, ["P0", "P1", "P2"]);
  assert.equal(a.parent_identity, "gA");
  assert.equal(a.outcome, "HOLD");
  assert.equal(a.retry_repair.repairs, 3);
  assert.equal(a.retry_repair.max_attempt, 4);
  assert.equal(a.context_token.reported, true);
  assert.equal(Math.round(a.context_token.occupancy_avg * 100), 82);
  assert.equal(a.latency.measured, true);
  assert.ok(a.latency.wall_ms >= 0);
  assert.equal(a.generation, 2);
  assert.equal(a.fanout.phase_count, 7);
  assert.equal(a.fanout.max_concurrent, 3, "measured concurrency from overlapping phase intervals");
  assert.equal(a.tool_usage.available, true);
  assert.deepEqual(a.tool_usage.tools, ["fs.grep", "fs.read"]);
  assert.match(a.decomposition_strategy.identity, /^[0-9a-f]{24}$/);

  // ── SECRET / FREE TEXT: never copied ────────────────────────────────────
  const serialized = JSON.stringify(a);
  assert.ok(!serialized.includes("sk-live"), "secret never copied into attribution");
  assert.ok(!serialized.includes("Bearer"), "auth header never copied");
  assert.ok(!serialized.includes("free_text"), "unknown payload keys are never copied");
  assert.ok(!serialized.includes(SECRET), "no raw payload text");

  // ── determinism ─────────────────────────────────────────────────────────
  const again = deriveAttribution({ events, admittedBinding: GLM, taskClass: "Bugfix", executionId: "exec_" + "ab".padEnd(32, "0"), graphRunId: "gA", admissionId: "adm_1", promptProfile: "reviewer-v2" });
  assert.equal(again.attribution_digest, a.attribution_digest, "identical evidence ⇒ identical digest");

  // ── unobservable axes are null, never guessed ───────────────────────────
  const bare = deriveAttribution({ events: journalFor({ outcome: "PASS" }), admittedBinding: null, taskClass: null, executionId: "exec_" + "cd".padEnd(32, "0") });
  assert.equal(bare.provider, null);
  assert.equal(bare.model, null);
  assert.equal(bare.task_class, "UNCLASSIFIED");
  assert.equal(bare.fanout.phase_count, null);
  assert.equal(bare.context_token.reported, false);
  assert.equal(bare.decomposition_strategy.declared, false);
  assert.equal(bare.prompt_profile, null);
  assert.equal(bare.generation, null);
  assert.equal(canonicalTaskClass("not a class!"), "UNCLASSIFIED");
});

// ── S2: §D provenance + single execution is never evidence ────────────────

test("S2 §D memory: observations are provenance-bound and ONE execution is never sufficient evidence", () => {
  const store = freshDir("s2-store");
  const s1 = recordRun(store, { outcome: "PASS", label: "only" });
  assert.equal(s1.status, "RECORDED");
  assert.ok(s1.observation.provenance.evidence_refs.length > 0, "durable evidence refs recorded");
  assert.equal(s1.observation.provenance.execution_id, s1.attribution.execution_id);

  const dim = summarizeStrategyDimension({ storeRoot: store, taskClass: "BUGFIX", dimension: "MODEL_ROUTING" });
  const v = dim.values.find((x) => x.value === "deepseek/deepseek-v4-flash");
  assert.ok(v, "the observed route appears");
  assert.equal(v.samples, 1);
  assert.equal(v.evidence_sufficient, false, "a single execution can never be sufficient");
  assert.ok(v.confidence < 1);
  assert.equal(v.min_samples_required, MIN_SAMPLES_FOR_SUFFICIENCY);

  // provenance is mandatory
  assert.throws(
    () => buildStrategyObservation({ attribution: { ...s1.attribution, execution_id: null, graph_run_id: null, admission_id: null }, evidenceRefs: [] }),
    (e) => e.code === "HOLD / EVOLUTION_STRATEGY_MEMORY_PROVENANCE_MISSING" && /provenance|execution id/i.test(e.message),
  );
  // a wrong-schema attribution is refused
  assert.throws(() => buildStrategyObservation({ attribution: { schema: "nope" } }), /attribution record missing or wrong schema/);
});

// ── S3: §D bounded, idempotent, conflict-closed ───────────────────────────

test("S3 §D memory: idempotent by identity, bounded size, conflicting payload fails closed", () => {
  const store = freshDir("s3-store");
  const first = recordRun(store, { outcome: "PASS", label: "dup" });
  // Re-recording the SAME observation (a replayed journal / a retried cycle)
  // must not double-count. Present the identical record again.
  const second = recordStrategyObservation({ storeRoot: store, observation: first.observation });
  assert.equal(second.observation.observation_id, first.observation.observation_id, "same record ⇒ same identity");
  const mem = readStrategyMemory(store);
  assert.equal(mem.observations.filter((o) => o.observation_id === first.observation.observation_id).length, 1, "no double count");
  assert.equal(second.status, "EXISTING");

  // conflicting payload under the same identity is a provenance conflict
  const conflicting = { ...first.observation, outcome: "PASS", succeeded: false, observation_digest: "0".repeat(64) };
  assert.throws(() => recordStrategyObservation({ storeRoot: store, observation: conflicting }), /identity conflict/);

  // bounded: the cap drops oldest
  const small = freshDir("s3-small");
  for (let i = 0; i < 6; i++) recordRun(small, { outcome: "PASS", label: `b${i}` });
  const view = strategyMemoryView({ storeRoot: small });
  assert.equal(view.total, 6);
  assert.equal(view.latest.length, 6);
});

// ── S4: §B the producer derives a plan FROM evidence ──────────────────────

test("S4 §B producer: derives a plan from the evidence itself (helper-level, no hand-fed plan argument)", () => {
  const store = freshDir("s4-store");
  // A source-repair plan comes from the trigger observation, which the
  // evidence-bound extractor (trigger.mjs) filled from the journal payload.
  const trigger = {
    schema: "autoloop.evolution-trigger/v1",
    trigger_id: "evt_s4",
    signal_class: "REPEATED_REPAIR_REQUIREMENT",
    signature: "sig-s4",
    count: 3,
    evidence_refs: ["e1", "e2", "e3"],
    observation: { phaseId: "P0", patchPlan: { patch: PATCH }, affectedScope: ["lib/retry.ts"] },
  };
  const out = produceImprovementPlan({ triggerEvent: trigger, storeRoot: store, taskClass: "BUGFIX" });
  assert.equal(out.status, "PLAN");
  assert.equal(out.plan.kind, "SOURCE_REPAIR");
  assert.equal(out.plan.patch_plan.patch, PATCH);
  assert.deepEqual(out.plan.affected_scope, ["lib/retry.ts"]);
  assert.equal(out.plan.measurement_plan.metric, "failure_or_repair_count");
  assert.match(out.plan.plan_id, /^eplan_[0-9a-f]{40}$/);

  // determinism: same evidence ⇒ same plan identity
  const again = produceImprovementPlan({ triggerEvent: trigger, storeRoot: store, taskClass: "BUGFIX" });
  assert.equal(again.plan.plan_id, out.plan.plan_id);

  // a strategy plan is derived from the MEMORY, with no plan argument at all
  seedRuns(store, 4, { taskClass: "ROUTING", route: GLM, outcome: "HOLD", repairs: 3, label: "glm" });
  const strat = produceImprovementPlan({
    triggerEvent: { ...trigger, observation: {} },
    storeRoot: store, taskClass: "ROUTING",
    dimensions: ["MODEL_ROUTING"],
    baselineValues: { MODEL_ROUTING: "merge-gateway/zai/glm-5.3-flash" },
  });
  // GLM is deficient and no OTHER supported route has sufficient evidence yet
  // ⇒ the producer must NOT fabricate a re-route; it reports the gap.
  assert.equal(strat.status, "NO_CANDIDATE");
  assert.ok(strat.diagnosis.dimensions[0].signals.includes("no_comparable_route_evidence"), JSON.stringify(strat.diagnosis.dimensions[0].signals));

  // ...and once the alternative route has comparable evidence, it proposes it.
  seedRuns(store, 4, { taskClass: "ROUTING", route: DEEPSEEK, outcome: "PASS", label: "ds" });
  const strat2 = produceImprovementPlan({
    triggerEvent: { ...trigger, observation: {} },
    storeRoot: store, taskClass: "ROUTING", dimensions: ["MODEL_ROUTING"],
    baselineValues: { MODEL_ROUTING: "merge-gateway/zai/glm-5.3-flash" },
  });
  assert.equal(strat2.status, "PLAN");
  assert.equal(strat2.plan.kind, "AGENT_STRATEGY");
  assert.equal(strat2.plan.dimension, "MODEL_ROUTING");
  assert.equal(strat2.plan.strategy_plan.to_value, "deepseek/deepseek-v4-flash");
  assert.equal(strat2.plan.strategy_plan.from_value, "merge-gateway/zai/glm-5.3-flash");
  assert.ok(strat2.plan.strategy_plan.rationale.includes("success"));
  assert.deepEqual(strat2.plan.affected_scope, ["strategy://ROUTING/MODEL_ROUTING"]);
  assert.equal(strat2.plan.measurement_plan.metric, "strategy_success_rate");
  assert.equal(strat2.plan.measurement_plan.direction, "increase");

  // the knob space is finite and inspectable
  assert.deepEqual(knobSpaceOf("FANOUT_PARALLELISM"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(knobSpaceOf("CONTEXT_ALLOCATION"), CONTEXT_BANDS.map((b) => b.id));
  assert.deepEqual(knobSpaceOf("MODEL_ROUTING"), [...SUPPORTED_ROUTE_VALUES]);
});

// ── S5: §B INCONCLUSIVE / NO_CANDIDATE ───────────────────────────────────

test("S5 §B producer: insufficient evidence ⇒ INCONCLUSIVE; sufficient-and-healthy ⇒ NO_CANDIDATE; never a fabricated plan", () => {
  const store = freshDir("s5-store");
  const trigger = { schema: "autoloop.evolution-trigger/v1", trigger_id: "evt_s5", signal_class: "RECURRING_HOLD_PATTERN", signature: "sig-s5", count: 3, evidence_refs: ["e1", "e2", "e3"], observation: {} };

  // (a) empty memory
  const emptyStore = freshDir("s5-empty");
  const emptyOut = produceImprovementPlan({ triggerEvent: trigger, storeRoot: emptyStore, taskClass: "BUGFIX" });
  assert.equal(emptyOut.status, "INCONCLUSIVE");
  assert.equal(emptyOut.plan, null);
  assert.match(emptyOut.reason, /insufficient attributed evidence/);

  // (b) one sample — still INCONCLUSIVE
  const one = freshDir("s5-one");
  recordRun(one, { taskClass: "BUGFIX", outcome: "HOLD", repairs: 2, label: "one" });
  assert.equal(produceImprovementPlan({ triggerEvent: trigger, storeRoot: one, taskClass: "BUGFIX" }).status, "INCONCLUSIVE");

  // (c) enough samples, all healthy ⇒ NO_CANDIDATE (nothing to fix)
  const healthy = freshDir("s5-healthy");
  seedRuns(healthy, 5, { taskClass: "BUGFIX", outcome: "PASS", repairs: 0, occupancy: 0.3, occupancySamples: 1, label: "ok" });
  const okOut = produceImprovementPlan({ triggerEvent: trigger, storeRoot: healthy, taskClass: "BUGFIX" });
  assert.equal(okOut.status, "NO_CANDIDATE");
  assert.equal(okOut.plan, null);
  assert.ok(okOut.diagnosis.dimensions.length > 0, "the diagnosis is still reported for audit");

  // (d) a dimension whose axis is unobservable is never "deficient"
  const d = diagnoseDimension({ storeRoot: emptyStore, taskClass: "BUGFIX", dimension: "TOOL_SELECTION" });
  assert.equal(d.evidence_sufficient, false);
  assert.equal(d.deficient, false);
  assert.equal(d.alternative, null);

  // (e) the thresholds are declared constants, not magic numbers
  assert.equal(DIAGNOSIS_THRESHOLDS.minSamples, MIN_SAMPLES_FOR_SUFFICIENCY);
});

// ── S6: §C classes + risk ladder ─────────────────────────────────────────

test("S6 §C strategy candidate classes: LOW bounded knobs, MEDIUM prompt floor, HIGH refusal outside the schema", () => {
  const low = [
    { dimension: "MODEL_ROUTING", params: { route: "deepseek/deepseek-v4-flash" } },
    { dimension: "DECOMPOSITION", params: { max_phases: 4 } },
    { dimension: "CONTEXT_ALLOCATION", params: { target_band: "BAND_60_75" } },
    { dimension: "RETRY_REPAIR", params: { max_attempts: 3 } },
    { dimension: "FANOUT_PARALLELISM", params: { max_concurrent: 2 } },
    { dimension: "TOOL_SELECTION", params: { canonical_tool_ids: ["fs.grep", "fs.read"] } },
  ];
  for (const { dimension, params } of low) {
    const cls = classifyStrategyRisk({ dimension, params });
    assert.equal(cls.riskClass, "LOW", `${dimension} must be LOW: ${cls.reasons.join(";")}`);
    assert.equal(validateValue(dimension, params).ok, true, `${dimension} params valid`);
  }

  // §C/J: prompt/profile is MEDIUM in v1
  const prompt = classifyStrategyRisk({ dimension: "PROMPT_EVOLUTION", params: { prompt_profile: "reviewer-v3" } });
  assert.equal(prompt.riskClass, "MEDIUM");
  assert.ok(prompt.reasons.some((r) => r.startsWith("declared_medium_floor")));

  // out-of-bounds / authority-reaching params are HIGH (refused), never MEDIUM
  const bad = [
    ["RETRY_REPAIR", { max_attempts: 99 }],
    ["FANOUT_PARALLELISM", { max_concurrent: 0 }],
    ["DECOMPOSITION", { max_phases: 999 }],
    ["CONTEXT_ALLOCATION", { target_band: "BAND_WHATEVER" }],
    ["MODEL_ROUTING", { route: "openai/gpt-9" }],
    ["TOOL_SELECTION", { canonical_tool_ids: ["bash"] }],           // bash is UNMAPPED in V1
    ["TOOL_SELECTION", { canonical_tool_ids: ["fs.read", "rm-rf"] }],
  ];
  for (const [dimension, params] of bad) {
    assert.equal(classifyStrategyRisk({ dimension, params }).riskClass, "HIGH", `${dimension} ${JSON.stringify(params)} must be HIGH`);
  }

  // §G: the strategy may only name tools inside the admission vocabulary
  const allowed = allowedCanonicalToolIds();
  assert.ok(allowed.includes("fs.read"));
  assert.ok(!allowed.includes("bash"), "bash stays unmapped");
  assert.equal(validateValue("TOOL_SELECTION", { canonical_tool_ids: ["fs.read"] }).ok, true);
  assert.match(validateValue("TOOL_SELECTION", { canonical_tool_ids: ["bash"] }).reason, /outside the admission vocabulary/);
});

// ── S7: §E routing seam ──────────────────────────────────────────────────

test("S7 §E routing seam: supported routes only, explicit authority binding always wins", () => {
  const store = freshDir("s7-store");

  // no preference ⇒ the deployment default
  assert.equal(selectRouteForTaskClass({}).source, "DEFAULT");
  assert.equal(selectRouteForTaskClass({}).route, SUPPORTED_ROUTE_VALUES[0]);

  // a preference inside the supported rows is honoured
  const glm = selectRouteForTaskClass({ strategyPreference: "merge-gateway/zai/glm-5.3-flash" });
  assert.equal(glm.source, "STRATEGY");
  assert.equal(glm.route, "merge-gateway/zai/glm-5.3-flash");
  assert.equal(glm.binding.providerKind, "merge-gateway");

  // an unsupported route is refused (never selected)
  const unsupported = selectRouteForTaskClass({ strategyPreference: "openai/gpt-9" });
  assert.equal(unsupported.source, "STRATEGY_UNSUPPORTED");
  assert.equal(unsupported.route, SUPPORTED_ROUTE_VALUES[0], "falls back to the default, never the unsupported route");

  // a deployment allowlist narrows further
  const narrowed = selectRouteForTaskClass({ strategyPreference: "merge-gateway/zai/glm-5.3-flash", allowlist: ["deepseek/deepseek-v4-flash"] });
  assert.equal(narrowed.source, "ALLOWLIST_REFUSED");
  assert.equal(narrowed.route, "deepseek/deepseek-v4-flash");

  // AN AUTHORITY BINDING ALWAYS WINS, even against a strategy preference
  const explicit = selectRouteForTaskClass({ strategyPreference: "merge-gateway/zai/glm-5.3-flash", explicitBinding: DEEPSEEK });
  assert.equal(explicit.source, "EXPLICIT");
  assert.equal(explicit.route, "deepseek/deepseek-v4-flash");

  // and the store-backed resolver reads the ACTIVE preference
  const policy = createEvolutionPolicy(store, policyInput());
  assert.ok(policy);
  const before = resolveProductionRoute({ storeRoot: store, taskClass: "BUGFIX" });
  assert.equal(before.source, "DEFAULT");
  activateStrategyValue({
    storeRoot: store, taskClass: "BUGFIX", dimension: "MODEL_ROUTING",
    params: { route: "merge-gateway/zai/glm-5.3-flash" }, candidateId: "ecand_" + "1".repeat(40), expectedGeneration: 0,
  });
  const after = resolveProductionRoute({ storeRoot: store, taskClass: "BUGFIX" });
  assert.equal(after.source, "STRATEGY");
  assert.equal(after.route, "merge-gateway/zai/glm-5.3-flash");
  // a DIFFERENT task class is unaffected
  assert.equal(resolveProductionRoute({ storeRoot: store, taskClass: "FEATURE" }).source, "DEFAULT");
  // and an explicit binding still overrides the activation
  assert.equal(resolveProductionRoute({ storeRoot: store, taskClass: "BUGFIX", explicitBinding: DEEPSEEK }).source, "EXPLICIT");
  assert.equal(defaultRoute().route, SUPPORTED_ROUTE_VALUES[0]);
});

// ── S8: §H strategy fitness ──────────────────────────────────────────────

test("S8 §H strategy fitness: ACCEPT only on regression PASS + target IMPROVED + sufficient evidence", () => {
  const store = freshDir("s8-store");
  const TC = "FITNESS";
  // baseline arm: 4 runs, 50% success, high repair
  seedRuns(store, 4, { taskClass: TC, route: GLM, outcome: "PASS", repairs: 2, label: "b-pass" });
  for (let i = 0; i < 4; i++) recordRun(store, { taskClass: TC, route: GLM, outcome: "HOLD", repairs: 3, label: `b-hold-${i}` });
  // candidate arm: 4 runs, all success, no repairs
  seedRuns(store, 4, { taskClass: TC, route: DEEPSEEK, outcome: "PASS", repairs: 0, label: "c-pass" });

  const improved = evaluateStrategyFitness({
    storeRoot: store, taskClass: TC, dimension: "MODEL_ROUTING",
    baselineValue: "merge-gateway/zai/glm-5.3-flash", candidateValue: "deepseek/deepseek-v4-flash",
    candidateId: "ecand_" + "2".repeat(40),
  });
  assert.equal(improved.schema, "autoloop.evolution-strategy-fitness/v1");
  assert.equal(improved.kind, "AGENT_STRATEGY");
  assert.equal(improved.candidate_id, "ecand_" + "2".repeat(40));
  assert.equal(improved.regression.verdict, "PASS");
  assert.equal(improved.targetMetric.verdict, "IMPROVED");
  assert.equal(improved.verdict, "IMPROVED");
  assert.equal(improved.decision, "ACCEPT");
  assert.equal(improved.evidence.sufficient, true);
  assert.equal(improved.baseline.samples, 8);
  assert.equal(improved.candidate.samples, 4);
  assert.ok(improved.fitness_digest);

  // INSUFFICIENT: the candidate arm has one sample
  const thin = freshDir("s8-thin");
  seedRuns(thin, 4, { taskClass: TC, route: GLM, outcome: "PASS", label: "tb" });
  recordRun(thin, { taskClass: TC, route: DEEPSEEK, outcome: "PASS", label: "tc" });
  const inconclusive = evaluateStrategyFitness({
    storeRoot: thin, taskClass: TC, dimension: "MODEL_ROUTING",
    baselineValue: "merge-gateway/zai/glm-5.3-flash", candidateValue: "deepseek/deepseek-v4-flash",
  });
  assert.equal(inconclusive.verdict, "INCONCLUSIVE");
  assert.equal(inconclusive.decision, "REJECT");
  assert.match(inconclusive.reason, /insufficient evidence/);

  // UNCHANGED: identical arms
  const sameStore = freshDir("s8-same");
  seedRuns(sameStore, 5, { taskClass: TC, route: GLM, outcome: "PASS", repairs: 0, label: "s1" });
  seedRuns(sameStore, 5, { taskClass: TC, route: DEEPSEEK, outcome: "PASS", repairs: 0, label: "s2" });
  const unchanged = evaluateStrategyFitness({
    storeRoot: sameStore, taskClass: TC, dimension: "MODEL_ROUTING",
    baselineValue: "merge-gateway/zai/glm-5.3-flash", candidateValue: "deepseek/deepseek-v4-flash",
  });
  assert.equal(unchanged.verdict, "UNCHANGED");
  assert.equal(unchanged.decision, "REJECT");

  // REGRESSED: the candidate improves success but worsens repairs ⇒ guard fires
  const regStore = freshDir("s8-reg");
  seedRuns(regStore, 4, { taskClass: TC, route: GLM, outcome: "PASS", repairs: 0, label: "r1" });
  for (let i = 0; i < 2; i++) recordRun(regStore, { taskClass: TC, route: GLM, outcome: "HOLD", repairs: 0, label: `r1h${i}` });
  seedRuns(regStore, 4, { taskClass: TC, route: DEEPSEEK, outcome: "PASS", repairs: 4, label: "r2" });
  const regressed = evaluateStrategyFitness({
    storeRoot: regStore, taskClass: TC, dimension: "MODEL_ROUTING",
    baselineValue: "merge-gateway/zai/glm-5.3-flash", candidateValue: "deepseek/deepseek-v4-flash",
  });
  assert.equal(regressed.targetMetric.verdict, "IMPROVED", "success does improve");
  assert.equal(regressed.regression.verdict, "REGRESSED", "but the repair guard regresses");
  assert.equal(regressed.decision, "REJECT", "a success that costs repairs is not an improvement");

  // the A/B arms are disjoint by construction
  assert.equal(improved.baseline.label, "baseline:merge-gateway/zai/glm-5.3-flash");
  assert.equal(improved.candidate.label, "candidate:deepseek/deepseek-v4-flash");
});

// ── S9: §I cross-agent learning ──────────────────────────────────────────

test("S9 §I cross-agent learning: agent A evidence → candidate → promotion → agent B/C future routing changes", () => {
  const store = freshDir("s9-store");
  const TC = "CROSSAGENT";
  const policy = createEvolutionPolicy(store, policyInput());

  // Agent A (GLM route) produces deficient evidence; agent B (DeepSeek) healthy.
  seedRuns(store, 6, { taskClass: TC, route: GLM, outcome: "HOLD", repairs: 3, label: "agA" });
  seedRuns(store, 4, { taskClass: TC, route: DEEPSEEK, outcome: "PASS", repairs: 0, label: "agB" });

  // BEFORE: the task class runs on the default (the deficient GLM behaviour was
  // observed under an explicitly-bound GLM admission, not under the default).
  assert.equal(resolveProductionRoute({ storeRoot: store, taskClass: TC }).source, "DEFAULT");

  // THE LEARNING: evidence → pattern/candidate → evaluation → promotion.
  const trigger = { schema: "autoloop.evolution-trigger/v1", trigger_id: "evt_s9", signal_class: "RECURRING_HOLD_PATTERN", signature: "sig-s9", count: 3, evidence_refs: ["e1", "e2", "e3"], observation: {} };
  const produced = produceImprovementPlan({
    triggerEvent: trigger, storeRoot: store, taskClass: TC, dimensions: ["MODEL_ROUTING"],
    baselineValues: { MODEL_ROUTING: "merge-gateway/zai/glm-5.3-flash" },
  });
  assert.equal(produced.status, "PLAN");
  assert.equal(produced.plan.strategy_plan.to_value, "deepseek/deepseek-v4-flash");
  const derived = deriveStrategyCandidate({
    plan: produced.plan, triggerEvent: trigger,
    baselineHead: git(freshDirRepo(), ["rev-parse", "HEAD"]), baselineRevision: 1,
    strategyPolicy: readPolicy(store),
  });
  assert.equal(derived.status, "CREATED");
  const candidate = derived.candidate;

  // fitness over the SAME comparable evidence
  const fitness = evaluateStrategyFitness({
    storeRoot: store, taskClass: TC, dimension: candidate.strategy_plan.dimension,
    baselineValue: candidate.strategy_plan.from_value, candidateValue: candidate.strategy_plan.to_value,
    candidateId: candidate.candidate_id,
  });
  assert.equal(fitness.decision, "ACCEPT", JSON.stringify(fitness));

  // promotion → the bounded value becomes ACTIVE
  const activated = activateStrategyValue({
    storeRoot: store, taskClass: TC, dimension: candidate.strategy_plan.dimension,
    params: candidate.strategy_plan.params, candidateId: candidate.candidate_id,
    expectedGeneration: candidate.mutation_plan.strategy_activation.policy_generation,
    evidenceDigest: candidate.candidate_digest,
  });
  assert.equal(activated.activation.value, "deepseek/deepseek-v4-flash", "the promoted value is the fitness-winning route");

  // AFTER: agent B/C (a NEW execution, different task instance) resolves the
  // promoted value — this is the cross-agent transfer.
  const afterB = resolveProductionRoute({ storeRoot: store, taskClass: TC });
  assert.equal(afterB.source, "STRATEGY");
  assert.equal(afterB.route, "deepseek/deepseek-v4-flash");
  const afterC = resolveProductionRoute({ storeRoot: store, taskClass: candidate.strategy_plan.task_class });
  assert.equal(afterC.route, afterB.route, "every future agent on this task class adopts it");
  // an unrelated task class is untouched
  assert.equal(resolveProductionRoute({ storeRoot: store, taskClass: "OTHER" }).source, "DEFAULT");
  assert.ok(policy);

  // CROSS_AGENT_POLICY_TRANSFER: the promotion is durable and readable
  const view = strategyPolicyView(store);
  assert.equal(view.generation, 1);
  assert.deepEqual(view.task_classes, [TC]);
  assert.equal(view.active[TC].MODEL_ROUTING.candidate_id, candidate.candidate_id);
  assert.equal(view.active[TC].MODEL_ROUTING.evidence_digest, candidate.candidate_digest);
});

function freshDirRepo() {
  return makeFixtureRepo(`repo-${Math.random().toString(16).slice(2, 8)}`);
}

// ── S10: §L CASE 1 — GLM repeated repair ─────────────────────────────────

test("S10 §L CASE 1: GLM repeated repair is attributable and yields a strategy candidate", () => {
  const store = freshDir("s10-store");
  const TC = "GLM_REPAIR";
  seedRuns(store, 4, { taskClass: TC, route: GLM, outcome: "PASS", repairs: 3, maxAttempt: 3, label: "glm-repair" });
  seedRuns(store, 4, { taskClass: TC, route: DEEPSEEK, outcome: "PASS", repairs: 0, label: "ds-clean" });

  // attributABILITY: every observation pins the provider/model
  const mem = readStrategyMemory(store);
  const glmObs = mem.observations.filter((o) => o.strategy.MODEL_ROUTING === "merge-gateway/zai/glm-5.3-flash");
  assert.equal(glmObs.length, 4);
  assert.ok(glmObs.every((o) => o.repairs === 3 && o.provenance.evidence_refs.length > 0));

  // diagnosis: REPAIR_REPAIR / MODEL_ROUTING both see the deficiency
  const retry = diagnoseDimension({
    storeRoot: store, taskClass: TC, dimension: "RETRY_REPAIR",
    baselineValue: "max_attempt_3",
  });
  assert.equal(retry.evidence_sufficient, true);
  assert.ok(retry.deficient);
  assert.ok(retry.signals.some((s) => s.startsWith("repair_rate")), JSON.stringify(retry.signals));
  assert.ok(retry.alternative, "a bounded retry knob is proposed");
  assert.ok(retry.alternative.params.max_attempts > 3);

  const routing = diagnoseDimension({
    storeRoot: store, taskClass: TC, dimension: "MODEL_ROUTING",
    baselineValue: "merge-gateway/zai/glm-5.3-flash",
  });
  assert.ok(routing.deficient, "the GLM route is diagnosed deficient");
  // HONEST REFUSAL: both routes are PASS-perfect here, so the only deficiency
  // is repair cost. The producer must NOT re-route on that basis — it records
  // why instead of guessing.
  assert.equal(routing.alternative, null);
  assert.ok(routing.signals.includes("no_route_with_better_success"), JSON.stringify(routing.signals));

  // candidate derivation from the produced plan
  const trigger = { schema: "autoloop.evolution-trigger/v1", trigger_id: "evt_s10", signal_class: "REPEATED_REPAIR_REQUIREMENT", signature: "sig-s10", count: 4, evidence_refs: ["e1", "e2", "e3", "e4"], observation: {} };
  // Re-routing is correctly REFUSED (success is not better anywhere)...
  const routingPlan = produceImprovementPlan({
    triggerEvent: trigger, storeRoot: store, taskClass: TC, dimensions: ["MODEL_ROUTING"],
    baselineValues: { MODEL_ROUTING: "merge-gateway/zai/glm-5.3-flash" },
  });
  assert.equal(routingPlan.status, "NO_CANDIDATE");
  // ...while the bounded RETRY knob IS actionable on the same evidence.
  const produced = produceImprovementPlan({
    triggerEvent: trigger, storeRoot: store, taskClass: TC, dimensions: ["RETRY_REPAIR"],
    baselineValues: { RETRY_REPAIR: "max_attempt_3" },
  });
  assert.equal(produced.status, "PLAN", JSON.stringify(produced.reason ?? produced.diagnosis));
  assert.equal(produced.plan.dimension, "RETRY_REPAIR");
  assert.equal(produced.plan.strategy_plan.to_value, "max_attempt_4");
  assert.equal(produced.plan.strategy_plan.from_value, "max_attempt_3");
  const repo = makeFixtureRepo("s10-repo");
  const derived = deriveStrategyCandidate({ plan: produced.plan, triggerEvent: trigger, baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1, strategyPolicy: readPolicy(store) });
  assert.equal(derived.candidate.risk_class, "LOW");
  assert.equal(derived.candidate.candidate_kind, "AGENT_STRATEGY");
  assert.match(derived.candidate.candidate_id, /^ecand_[0-9a-f]{40}$/);
});

// ── S11: §L CASE 2 — GLM vs DeepSeek routing fitness ─────────────────────

test("S11 §L CASE 2: comparable GLM vs DeepSeek evidence → routing fitness → future preference", () => {
  const store = freshDir("s11-store");
  const TC = "ROUTE_COMPARE";
  // 6 vs 6: enough on both arms, clear winner on success AND cost.
  seedRuns(store, 6, { taskClass: TC, route: GLM, outcome: "PASS", repairs: 2, occupancy: 0.92, occupancySamples: 2, label: "glm" });
  for (let i = 0; i < 3; i++) recordRun(store, { taskClass: TC, route: GLM, outcome: "HOLD", repairs: 3, occupancy: 0.95, occupancySamples: 2, label: `glmh${i}` });
  seedRuns(store, 6, { taskClass: TC, route: DEEPSEEK, outcome: "PASS", repairs: 0, occupancy: 0.55, occupancySamples: 2, label: "ds" });

  const dim = summarizeStrategyDimension({ storeRoot: store, taskClass: TC, dimension: "MODEL_ROUTING" });
  const glm = dim.values.find((v) => v.value === "merge-gateway/zai/glm-5.3-flash");
  const ds = dim.values.find((v) => v.value === "deepseek/deepseek-v4-flash");
  assert.equal(glm.evidence_sufficient, true);
  assert.equal(ds.evidence_sufficient, true);
  assert.ok(ds.success_rate > glm.success_rate);
  assert.ok(ds.occupancy_avg < glm.occupancy_avg);
  assert.ok(ds.repair_rate < glm.repair_rate);

  const fitness = evaluateStrategyFitness({
    storeRoot: store, taskClass: TC, dimension: "MODEL_ROUTING",
    baselineValue: "merge-gateway/zai/glm-5.3-flash", candidateValue: "deepseek/deepseek-v4-flash",
  });
  assert.equal(fitness.decision, "ACCEPT");
  assert.equal(fitness.targetMetric.verdict, "IMPROVED");
  assert.equal(fitness.regression.verdict, "PASS");

  const produced = produceImprovementPlan({
    triggerEvent: { schema: "autoloop.evolution-trigger/v1", trigger_id: "evt_s11", signal_class: "RECURRING_HOLD_PATTERN", signature: "sig-s11", count: 3, evidence_refs: ["e1"], observation: {} },
    storeRoot: store, taskClass: TC, dimensions: ["MODEL_ROUTING"],
    baselineValues: { MODEL_ROUTING: "merge-gateway/zai/glm-5.3-flash" },
  });
  assert.equal(produced.status, "PLAN");
  assert.equal(produced.plan.strategy_plan.to_value, "deepseek/deepseek-v4-flash");

  // promote → future preference
  activateStrategyValue({
    storeRoot: store, taskClass: TC, dimension: "MODEL_ROUTING",
    params: produced.plan.strategy_plan.params, candidateId: "ecand_" + "3".repeat(40), expectedGeneration: 0,
  });
  const pref = resolveRoutePreference({ storeRoot: store, taskClass: TC });
  assert.equal(pref.value, "deepseek/deepseek-v4-flash");
  assert.equal(resolveProductionRoute({ storeRoot: store, taskClass: TC }).route, "deepseek/deepseek-v4-flash");
});

// ── S12: §L CASE 3 — decomposition / context exhaustion ──────────────────

test("S12 §L CASE 3: context exhaustion under a wide decomposition → bounded decomposition/context candidate", () => {
  const store = freshDir("s12-store");
  const TC = "DECOMP_CTX";
  // 5 runs at 8 declared phases, measured concurrency 4, occupancy in the high band
  seedRuns(store, 5, { taskClass: TC, route: DEEPSEEK, outcome: "HOLD", repairs: 2, phaseCount: 8, concurrency: 4, occupancy: 0.88, occupancySamples: 2, label: "wide" });

  const ctx = diagnoseDimension({ storeRoot: store, taskClass: TC, dimension: "CONTEXT_ALLOCATION" });
  assert.equal(ctx.evidence_sufficient, true);
  assert.equal(ctx.baseline.value, "BAND_75_90", "the run sat in the 75-90% band");
  assert.ok(ctx.alternative, "a lower band is proposed");
  assert.equal(ctx.alternative.params.target_band, "BAND_60_75");

  const decomp = diagnoseDimension({ storeRoot: store, taskClass: TC, dimension: "DECOMPOSITION" });
  assert.equal(decomp.baseline.value, "max_phases_8");
  assert.ok(decomp.alternative);
  assert.equal(decomp.alternative.params.max_phases, 7, "bounded step: one phase fewer");

  const fan = diagnoseDimension({ storeRoot: store, taskClass: TC, dimension: "FANOUT_PARALLELISM" });
  assert.equal(fan.baseline.value, "concurrency_4");
  assert.ok(fan.alternative);
  assert.equal(fan.alternative.params.max_concurrent, 3, "narrows, never widens, on stress evidence");

  const produced = produceImprovementPlan({
    triggerEvent: { schema: "autoloop.evolution-trigger/v1", trigger_id: "evt_s12", signal_class: "TOKEN_INEFFICIENCY", signature: "sig-s12", count: 5, evidence_refs: ["e1"], observation: {} },
    storeRoot: store, taskClass: TC, dimensions: ["CONTEXT_ALLOCATION", "DECOMPOSITION", "FANOUT_PARALLELISM"],
  });
  assert.equal(produced.status, "PLAN");
  assert.ok(["CONTEXT_ALLOCATION", "DECOMPOSITION", "FANOUT_PARALLELISM"].includes(produced.plan.dimension));

  const repo = makeFixtureRepo("s12-repo");
  const derived = deriveStrategyCandidate({
    plan: produced.plan,
    triggerEvent: { schema: "autoloop.evolution-trigger/v1", trigger_id: "evt_s12", signal_class: "TOKEN_INEFFICIENCY", signature: "sig-s12", count: 5, evidence_refs: ["e1"], observation: {} },
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1, strategyPolicy: readPolicy(store),
  });
  assert.equal(derived.candidate.risk_class, "LOW");
  assert.equal(derived.candidate.rolled_back === undefined, true);
  assert.equal(derived.candidate.rollback_plan.kind, "strategy_deactivation");
  assert.equal(derived.candidate.mutation_plan.edits.length, 0, "a strategy candidate mutates no source");
});

// ── S13: §L CASE 4 — prompt → MEDIUM, stops before promotion ─────────────

test("S13 §L CASE 4: a prompt/profile candidate is MEDIUM and stops before autonomous promotion", async () => {
  const store = freshDir("s13-store");
  const TC = "PROMPT_HOLD";
  // Repeated HOLDs while a declared prompt profile is in use.
  seedRuns(store, 4, { taskClass: TC, route: DEEPSEEK, outcome: "HOLD", repairs: 3, label: "prompt-v2", promptProfile: "reviewer-v2" });
  seedRuns(store, 4, { taskClass: TC, route: DEEPSEEK, outcome: "PASS", repairs: 0, label: "prompt-v3", promptProfile: "reviewer-v3" });

  // the prompt axis IS observable when the deployment declares it
  const dim = summarizeStrategyDimension({ storeRoot: store, taskClass: TC, dimension: "PROMPT_EVOLUTION" });
  assert.equal(dim.values.length, 2, "both declared profiles have evidence");
  const v2 = dim.values.find((v) => v.value === "prompt_reviewer-v2");
  assert.equal(v2.evidence_sufficient, true);
  assert.equal(v2.hold_rate, 1);

  // the diagnosis is representable
  const diag = diagnoseDimension({ storeRoot: store, taskClass: TC, dimension: "PROMPT_EVOLUTION" });
  assert.ok(diag.deficient);
  assert.ok(diag.signals.includes("prompt_axis_declared_only"), "prompt deficiency is only ever declared-axis driven");

  // ...and a plan exists, but at the MEDIUM floor
  const produced = produceImprovementPlan({
    triggerEvent: { schema: "autoloop.evolution-trigger/v1", trigger_id: "evt_s13", signal_class: "RECURRING_HOLD_PATTERN", signature: "sig-s13", count: 3, evidence_refs: ["e1"], observation: {} },
    storeRoot: store, taskClass: TC, dimensions: ["PROMPT_EVOLUTION"],
  });
  // The producer only proposes a value the memory shows as BETTER; v3 is
  // healthy and sufficient, so the plan names it...
  if (produced.status === "PLAN") {
    assert.equal(produced.plan.dimension, "PROMPT_EVOLUTION");
  }
  // ...and regardless of which dimension wins, the PROMPT candidate itself is
  // MEDIUM. Force the prompt candidate to make the boundary explicit.
  const repo = makeFixtureRepo("s13-repo");
  const promptPlan = {
    schema: "autoloop.evolution-improvement-plan/v1",
    version: 1,
    plan_id: "eplan_" + "9".repeat(40),
    kind: "AGENT_STRATEGY",
    dimension: "PROMPT_EVOLUTION",
    task_class: TC,
    signal_class: "RECURRING_HOLD_PATTERN",
    problem_signature: "sig-s13",
    evidence_refs: ["e1"],
    affected_scope: [`strategy://${TC}/PROMPT_EVOLUTION`],
    patch_plan: null,
    strategy_plan: {
      surface: `strategy://${TC}/PROMPT_EVOLUTION`, dimension: "PROMPT_EVOLUTION", task_class: TC,
      from_value: "prompt_reviewer-v2", to_value: "prompt_reviewer-v3",
      params: { prompt_profile: "reviewer-v3" }, risk_floor: "MEDIUM",
      rationale: "declared profile with recurring HOLDs; alternative profile healthy",
    },
    rationale: "declared profile with recurring HOLDs",
    diagnosis: { task_class: TC },
    measurement_plan: {
      metric: "strategy_success_rate", direction: "increase", baseline_value: "prompt_reviewer-v2",
      baseline_samples: 4, min_samples: 3, task_class: TC, dimension: "PROMPT_EVOLUTION", candidate_value: "prompt_reviewer-v3",
    },
  };
  const derived = deriveStrategyCandidate({ plan: promptPlan, triggerEvent: { trigger_id: "evt_s13", signature: "sig-s13", signal_class: "RECURRING_HOLD_PATTERN", evidence_refs: ["e1"] }, baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1, strategyPolicy: readPolicy(store) });
  assert.equal(derived.candidate.risk_class, "MEDIUM", "PROMPT_EVOLUTION is MEDIUM in v1");
  assert.ok(derived.candidate.risk_reasons.some((r) => r.includes("declared_medium_floor")));

  // THE BOUNDARY: a MEDIUM candidate stops at AWAITING_OPERATOR_PROMOTION and
  // the strategy value is NOT activated.
  createEvolutionPolicy(store, policyInput({
    risk_classes_allowed: ["LOW", "MEDIUM"],
    strategy_dimensions_allowed: ["PROMPT_EVOLUTION"],
  }));
  const before = readStrategyPolicy(store).generation;
  const cycle = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("s13-cp"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: journalFor({ outcome: "HOLD", repairs: 3 }),
    fingerprint: null, plan: promptPlan, taskClass: TC,
    reviewerIdentity: "reviewer:independent",
  });
  assert.equal(cycle.loop_verdict, "AWAITING_OPERATOR_PROMOTION", JSON.stringify(cycle));
  assert.equal(cycle.candidate_kind, "AGENT_STRATEGY");
  assert.equal(cycle.risk_class, "MEDIUM", "the declared MEDIUM floor holds");
  assert.equal(readStrategyPolicy(store).generation, before, "no autonomous activation of a MEDIUM strategy");
  assert.equal(resolveRoutePreference({ storeRoot: store, taskClass: TC }), null);
});

// ── S14: §K natural end-to-end with NO hand-fed plan ─────────────────────

test("S14 §K NATURAL evolution: production run → producer → strategy candidate → cycle, with NO hand-fed plan", async () => {
  const store = freshDir("s14-store");
  const checkpointRoot = freshDir("s14-cp");
  const repo = makeFixtureRepo("s14-repo");
  createEvolutionPolicy(store, policyInput());
  const TC = "NATURAL";

  // Agent A (GLM) has repeatedly held on this task class; agent B (DeepSeek)
  // is healthy. This is the ONLY input — no plan, no scope, no patch is passed
  // to the production entrypoint anywhere below.
  seedRuns(store, 6, { taskClass: TC, route: GLM, outcome: "HOLD", repairs: 3, label: "natA" });
  seedRuns(store, 4, { taskClass: TC, route: DEEPSEEK, outcome: "PASS", repairs: 0, label: "natB" });

  // The evidence root carries a qualified signal, produced by the RUN ITSELF
  // (the runner writes its own journal), with NO patch plan in any payload.
  const evidenceRoot = freshDir("s14-ev");
  const executionId = `exec_${createHash("sha256").update("s14").digest("hex").slice(0, 32)}`;
  const runEvents = [
    { event_type: "DAG_ACCEPTED", stage: "decomposition", payload: { phase_count: 4, ir_sha256: "c".repeat(64), dag_sha256: "d".repeat(64) } },
    ...Array.from({ length: 3 }, (_, i) => ({ event_type: "PHASE_REPAIR_REQUESTED", stage: "phase", phase_id: "P0", attempt: i + 1, payload: {} })),
    { event_type: "RUN_HELD", stage: "terminal", payload: { reason: "HOLD / C3B_MUTATION_FAILED" } },
  ];

  const dims = { affected_files: { score: 1, reasons: ["one"] }, affected_subsystems: { score: 0, reasons: ["n"] }, dependency_depth: { score: 0, reasons: ["n"] }, ambiguity: { score: 0, reasons: ["n"] }, expected_execution_steps: { score: 0, reasons: ["n"] }, verification_burden: { score: 0, reasons: ["n"] }, external_dependencies: { score: 0, reasons: ["n"] }, concurrency_potential: { score: 0, reasons: ["n"] }, statefulness: { score: 0, reasons: ["n"] }, rollback_complexity: { score: 0, reasons: ["n"] } };
  const admission = freezeAdmission(buildAdmissionRecord({
    taskId: "S14-NATURAL",
    classification: classify({ dimensionScores: dims, riskSignals: scanRiskSignals("bounded strategy adaptation") }),
    mutationScope: ["lib/"],
    extensions: { rollover: { enabled: true, provider_binding: { ...GLM, requiredEnvKeys: [] } } },
  }));

  const r = await runAdmittedGraph({
    admission,
    runner: async (opts) => {
      const enc = opts?.budget?.enforcement;
      if (enc) { const gt = enc.preDispatch({ executionId: "g", phase_id: "P0", nodeId: "P0", attempt: 0, runtime: { mode: "readonly", limits: { timeoutMs: 60000 } } }); if (gt.ok) enc.recordConsumption({ opKey: gt.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 }); }
      const s = new RunEvidenceStore({ root: evidenceRoot, executionId, chainId: `c-${executionId}`, checkpointId: `k-${executionId}` });
      s.init();
      for (const e of runEvents) s.appendEvent(e);
      return { final: "HOLD", executionId, nodeResults: [{ nodeId: "P0", final: "HOLD", attempt: 0, resultIdentity: { latencyMs: 5 } }], transitions: [], closeout: { applied: false }, admission: opts?.admission ?? null };
    },
    persistence: { root: evidenceRoot, executionId },
    ir: { phases: [] },
    // ONLY configuration — no plan, no observation, no scope hints.
    evolution: { storeRoot: store, checkpointRoot, repoRoot: repo, reviewerIdentity: "reviewer:independent", taskClass: TC },
  });

  // the run's own semantics are untouched
  assert.equal(r.final, "HOLD");
  assert.equal(r.budget.authorized, true);
  assert.equal(r.evolutionDisposition.disposition, "CYCLE_STARTED", JSON.stringify(r.evolutionDisposition));
  assert.ok(r.evolutionObservation.fired.length > 0);

  // the cycle ran and produced an AGENT_STRATEGY candidate from the evidence
  const { drainEvolutionCycles, evolutionConsumerState } = await import("../../src/evolution/production-consumer.mjs");
  await drainEvolutionCycles({ timeoutMs: 120000 });
  const outcomes = evolutionConsumerState().outcomes.filter((o) => o.trigger_id === r.evolutionDisposition.trigger_id);
  assert.equal(outcomes.length, 1, JSON.stringify(evolutionConsumerState().outcomes));
  const o = outcomes[0];
  assert.equal(o.disposition, "CYCLE_COMPLETED");
  assert.ok(EVOLUTION_LOOP_VERDICTS.includes(o.loop_verdict));
  // The natural evidence is sufficient and the fitness gate passes, so the
  // LOW bounded strategy adaptation completes autonomously. (A HOLD with a
  // named stage would be the honest alternative; it is asserted too so the
  // test cannot pass by silently failing closed.)
  assert.equal(o.loop_verdict, "PROMOTED", `natural evolution did not complete: ${JSON.stringify(o.cycle)}`);
  if (o.loop_verdict === "PROMOTED") {
    assert.equal(o.cycle.candidate_kind, "AGENT_STRATEGY", "a strategy candidate was derived from natural evidence");
    assert.ok(o.cycle.strategy_activation, "and a bounded strategy value became active");
    assert.equal(o.cycle.strategy_activation.surface, `strategy://${TC}/MODEL_ROUTING`);
    assert.equal(o.cycle.strategy_activation.to_value, "deepseek/deepseek-v4-flash");
    // the promoted value is now the resolved route for this task class
    assert.equal(resolveProductionRoute({ storeRoot: store, taskClass: TC }).route, "deepseek/deepseek-v4-flash");
  } else {
    // fail-closed with a named stage — never a silent success
    assert.ok(o.cycle.hold_code, JSON.stringify(o.cycle));
  }

  // §A/§D: the memory now also contains THIS run's own attributed evidence
  const mem = readStrategyMemory(store);
  assert.ok(
    mem.observations.some((x) => x.execution_id === executionId),
    "the production run attributed itself into the strategy memory",
  );
  // and the run's own route (GLM, from the ADMITTED binding) is what was recorded
  const ownObs = mem.observations.find((x) => x.execution_id === executionId);
  assert.equal(ownObs.strategy.MODEL_ROUTING, "merge-gateway/zai/glm-5.3-flash", "attribution uses the admitted provider binding");

  // no source mutation, no branch, repo untouched
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(git(repo, ["branch", "--list", "evolution/*"]), "");
});

// ── S15: §J strategy canary regression → deactivation ───────────────────

test("S15 §J a regressed strategy canary automatically DEACTIVATES the promoted value (rollback)", async () => {
  const store = freshDir("s15-store");
  const checkpointRoot = freshDir("s15-cp");
  const repo = makeFixtureRepo("s15-repo");
  createEvolutionPolicy(store, policyInput());
  const TC = "ROLLBACK";

  // Seed so the producer proposes a MODEL_ROUTING change, and make the route
  // push leave the activation in place, then REGRESS it in the canary.
  seedRuns(store, 6, { taskClass: TC, route: GLM, outcome: "HOLD", repairs: 3, label: "rbA" });
  seedRuns(store, 4, { taskClass: TC, route: DEEPSEEK, outcome: "PASS", repairs: 0, label: "rbB" });

  const trigger = { schema: "autoloop.evolution-trigger/v1", trigger_id: "evt_s15", signal_class: "RECURRING_HOLD_PATTERN", signature: "sig-s15", count: 3, evidence_refs: ["e1", "e2", "e3"], observation: {} };
  const produced = produceImprovementPlan({
    triggerEvent: trigger, storeRoot: store, taskClass: TC, dimensions: ["MODEL_ROUTING"],
    baselineValues: { MODEL_ROUTING: "merge-gateway/zai/glm-5.3-flash" },
  });
  assert.equal(produced.status, "PLAN");
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);

  // post-promotion evidence that REGRESSES: the same problem signature repeats
  const cycle = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot,
    baselineHead, baselineRevision: 1,
    baselineEvents: journalFor({ outcome: "HOLD", repairs: 3 }),
    fingerprint: null,
    triggerEvent: trigger,
    attribution: recordRun(store, { taskClass: TC, route: GLM, outcome: "HOLD", repairs: 3, label: "s15-attr" }).attribution,
    taskClass: TC,
    strategyDimensions: ["MODEL_ROUTING"],
    reviewerIdentity: "reviewer:independent",
    plan: produced.plan,
    postEvents: [
      { event_type: "RUN_HELD", stage: "terminal", payload: { reason: "sig-s15" } },
      { event_type: "RUN_HELD", stage: "terminal", payload: { reason: "sig-s15" } },
    ],
  });

  assert.equal(cycle.loop_verdict, "ROLLED_BACK", JSON.stringify(cycle));
  assert.equal(cycle.candidate_kind, "AGENT_STRATEGY");
  assert.ok(cycle.canary_reasons.includes("new_repeated_failure:2"));
  assert.equal(cycle.rollback.kind, "strategy_deactivation");
  assert.equal(cycle.rollback.deactivated, true);
  // the value is GONE: future resolution falls back to the deployment default
  assert.equal(resolveRoutePreference({ storeRoot: store, taskClass: TC }), null);
  assert.equal(resolveProductionRoute({ storeRoot: store, taskClass: TC }).source, "DEFAULT");
  // the canary record records the strategy rollback (durable, inspectable)
  const canary = readCanary(store, cycle.candidate_id);
  assert.equal(canary.promotion_kind, "AGENT_STRATEGY");
  assert.equal(canary.rolled_back, true);
  assert.equal(canary.rollback.kind, "strategy_deactivation");
  // the trigger state recorded the rollback for the circuit breaker accounting
  const st = readTriggerState(store);
  assert.ok((st.outcomes ?? []).some((o) => o.outcome === "ROLLED_BACK"));
});

// ── S16: §C/§J agent-strategy authority is OPT-IN ────────────────────────

test("S16 a policy that does not preauthorize a strategy dimension REFUSES strategy candidates (fail closed)", async () => {
  const store = freshDir("s16-store");
  const checkpointRoot = freshDir("s16-cp");
  const repo = makeFixtureRepo("s16-repo");
  const TC = "NOT_AUTHORIZED";

  // (a) a policy issued WITHOUT strategy_dimensions_allowed (the pre-existing
  //     shape — including the live production policy) refuses strategy work.
  createEvolutionPolicy(store, policyInput({ strategy_dimensions_allowed: undefined }));
  const trigger = { schema: "autoloop.evolution-trigger/v1", trigger_id: "evt_s16", signal_class: "REPEATED_REPAIR_REQUIREMENT", signature: "sig-s16", count: 4, evidence_refs: ["e1"], observation: {} };
  const plan = {
    schema: "autoloop.evolution-improvement-plan/v1", version: 1, plan_id: "eplan_" + "7".repeat(40),
    kind: "AGENT_STRATEGY", dimension: "RETRY_REPAIR", task_class: TC,
    signal_class: "REPEATED_REPAIR_REQUIREMENT", problem_signature: "sig-s16", evidence_refs: ["e1"],
    affected_scope: [`strategy://${TC}/RETRY_REPAIR`], patch_plan: null,
    strategy_plan: { surface: `strategy://${TC}/RETRY_REPAIR`, dimension: "RETRY_REPAIR", task_class: TC, from_value: "max_attempt_3", to_value: "max_attempt_4", params: { max_attempts: 4 }, risk_floor: "LOW", rationale: "bounded" },
    rationale: "bounded", diagnosis: { task_class: TC },
    measurement_plan: { metric: "strategy_success_rate", direction: "increase", task_class: TC, dimension: "RETRY_REPAIR", candidate_value: "max_attempt_4", candidate_value_raw: 4, baseline_samples: 4, min_samples: 3 },
  };
  const blocked = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot,
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: journalFor({ outcome: "HOLD", repairs: 3 }),
    fingerprint: null, plan, taskClass: TC,
    reviewerIdentity: "reviewer:independent",
  });
  assert.equal(blocked.loop_verdict, "HOLD", JSON.stringify(blocked));
  assert.equal(blocked.hold_code, "HOLD / EVOLUTION_SCOPE_OUTSIDE_POLICY", JSON.stringify(blocked));
  assert.match(blocked.reason, /not preauthorized by this policy/);
  assert.equal(readStrategyPolicy(store).generation, 0, "nothing activated");

  // (b) the SAME store, now with the dimension preauthorized, is refused at a
  //     DIFFERENT stage only because its memory is thin — proving the refusal
  //     in (a) was the authorization fence, not an incidental failure.
  const store2 = freshDir("s16-store2");
  createEvolutionPolicy(store2, policyInput({ strategy_dimensions_allowed: ["RETRY_REPAIR"] }));
  const after = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store2, checkpointRoot: freshDir("s16-cp2"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: journalFor({ outcome: "HOLD", repairs: 3 }),
    fingerprint: null, plan, taskClass: TC,
    reviewerIdentity: "reviewer:independent",
  });
  assert.notEqual(after.hold_code, "HOLD / EVOLUTION_SCOPE_OUTSIDE_POLICY", "the authorization fence no longer fires");

  // (c) the operator CLI lane can only issue LOW dimensions, and refuses an
  //     unknown dimension outright.
  const { spawnSync } = await import("node:child_process");
  const cli = (args) => spawnSync(process.execPath, [join(process.cwd(), "scripts", "evolution-issue-policy.mjs"), ...args], { encoding: "utf8" });
  const medium = cli(["--store", freshDir("s16-cli"), "--strategy-dimensions", "PROMPT_EVOLUTION"]);
  assert.equal(medium.status, 1);
  assert.match(medium.stderr, /not issuable through this lane/);
  const unknown = cli(["--store", freshDir("s16-cli2"), "--strategy-dimensions", "MADE_UP_DIM"]);
  assert.equal(unknown.status, 1);
  const ok = cli(["--store", freshDir("s16-cli3"), "--strategy-dimensions", "MODEL_ROUTING,RETRY_REPAIR", "--json"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).strategy_dimensions_allowed, ["MODEL_ROUTING", "RETRY_REPAIR"]);
  // and an unconfigured issue stays fail-closed
  const none = cli(["--store", freshDir("s16-cli4"), "--json"]);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(JSON.parse(none.stdout).strategy_dimensions_allowed, undefined, "omitted = no strategy authorization");
});

// ── S17: canary metric coherence ────────────────────────────────────────

test("S17 a canary whose baseline metric is NOT occupancy never rolls back on occupancy evidence", async () => {
  const store = freshDir("s17-store");
  const checkpointRoot = freshDir("s17-cp");
  const repo = makeFixtureRepo("s17-repo");
  createEvolutionPolicy(store, policyInput());
  const TC = "CANARY_METRIC";
  seedRuns(store, 6, { taskClass: TC, route: GLM, outcome: "HOLD", repairs: 3, label: "cmA" });
  seedRuns(store, 4, { taskClass: TC, route: DEEPSEEK, outcome: "PASS", repairs: 0, label: "cmB" });

  const trigger = { schema: "autoloop.evolution-trigger/v1", trigger_id: "evt_s17", signal_class: "RECURRING_HOLD_PATTERN", signature: "sig-s17", count: 3, evidence_refs: ["e1", "e2", "e3"], observation: {} };
  const produced = produceImprovementPlan({
    triggerEvent: trigger, storeRoot: store, taskClass: TC, dimensions: ["MODEL_ROUTING"],
    baselineValues: { MODEL_ROUTING: "merge-gateway/zai/glm-5.3-flash" },
  });
  assert.equal(produced.status, "PLAN");
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);

  // Post-promotion evidence: NO regression of the promoted strategy (no repeat
  // of the problem signature, no validation failure) but the OCCUPANCY proxy
  // is far above the (success-rate) baseline. A category error would roll this
  // healthy promotion back.
  const cycle = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot,
    baselineHead, baselineRevision: 1,
    baselineEvents: journalFor({ outcome: "HOLD", repairs: 3 }),
    fingerprint: null,
    triggerEvent: trigger,
    taskClass: TC,
    strategyDimensions: ["MODEL_ROUTING"],
    reviewerIdentity: "reviewer:independent",
    plan: produced.plan,
    postEvents: journalFor({ outcome: "PASS", occupancy: 0.95, occupancySamples: 4 }),
  });

  assert.equal(cycle.loop_verdict, "PROMOTED", JSON.stringify(cycle));
  assert.equal(cycle.canary.verdict, "HEALTHY");
  assert.equal(resolveRoutePreference({ storeRoot: store, taskClass: TC })?.value, "deepseek/deepseek-v4-flash", "the promotion stands");
  assert.equal(readCanary(store, cycle.candidate_id).rolled_back, false);
});
