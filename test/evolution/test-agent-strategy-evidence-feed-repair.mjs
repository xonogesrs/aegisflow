// test/evolution/test-agent-strategy-evidence-feed-repair.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVIDENCE_FEED_REPAIR_1 — acceptance suite (A–L).
//
//   F1  §A/§B/§C/§E  EVERY-RUN feed: 3 healthy production runs are attributed
//       and recorded into the strategy memory (sample_count ≥ 3) with NO
//       trigger, NO candidate and NO cycle — and every observation binds the
//       full attribution identity, secret-free.
//   F2  §B  eligibility: test-only synthetic records, non-agent administrative
//       runs, unreadable/empty evidence and evidence without an attribution
//       identity are EXCLUDED with an explicit disposition; the memory stays
//       empty (nothing fabricated).
//   F3  §D  dedup/idempotency: the same authoritative run records ONE sample
//       however often it is observed; a resumed run with extended evidence is
//       refused as an identity conflict (never double counted, never rewritten).
//   F4  §I  crash/resume: the observation is durable (fresh-process read),
//       a replayed resume does not double count, and a partial/torn write
//       never forms a valid observation.
//   F5  §F  fitness reachability: baseline strategy vs candidate strategy over
//       the REAL production-written observations ⇒ EVIDENCE_SUFFICIENT = YES
//       and FITNESS = ACCEPT (no hand-fed memory).
//   F6  §G  trigger independence: a healthy non-triggering run and a qualified
//       deficient run both take MEMORY_RECORDED through the SAME feed; only the
//       deficient one enters the trigger/candidate path, and gated (deduped)
//       runs are still recorded.
//   F7  §H  fail-open: a memory/feed failure never changes the authoritative
//       run result, and the operator can SEE the failure (envelope + durable
//       feed log + operator report diagnostic).
//   F8  §A  the trigger path itself: qualified deficient runs reach
//       candidate derivation → fitness → ACCEPT → PROMOTED through the
//       production entrypoint, with NO hand-fed plan and NO seeded memory.
//   F9  §J.1  policy succession: gen N → gen N+1 with previous-digest binding,
//       monotonic generation, exclusive active policy and preserved history —
//       including the operator CLI lane (no manual archiving).
//   F10 §J.2  production declaration: storeRoot / checkpointRoot / repoRoot /
//       taskClass / strategyBaselineValues declared by the deployment, with
//       malformed declarations surfaced rather than swallowed.
//
// Run: node --test test/evolution/test-agent-strategy-evidence-feed-repair.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";

import { RunEvidenceStore } from "../../src/evidence/run-evidence-store.mjs";
import {
  readObservationJournal,
} from "../../src/evolution/production-observer.mjs";
import {
  feedStrategyObservationForProduction, STRATEGY_FEED_DISPOSITIONS,
  readStrategyFeedLog, strategyFeedView, attributionFeedState, strategyFeedLogPath,
} from "../../src/evolution/attribution-feed.mjs";
import {
  readStrategyMemory, strategyMemoryPath, summarizeStrategyValue,
  MIN_SAMPLES_FOR_SUFFICIENCY,
} from "../../src/evolution/strategy-memory.mjs";
import { produceImprovementPlan } from "../../src/evolution/plan-producer.mjs";
import { deriveStrategyCandidate } from "../../src/evolution/candidate-strategy.mjs";
import { evaluateStrategyFitness } from "../../src/evolution/fitness-strategy.mjs";
import {
  resolveEvolutionProductionConfig, drainEvolutionCycles, evolutionConsumerState,
  EVOLUTION_CONSUMER_DISPOSITIONS,
} from "../../src/evolution/production-consumer.mjs";
import { EVOLUTION_LOOP_VERDICTS } from "../../src/evolution/loop.mjs";
import { readTriggerState } from "../../src/evolution/trigger.mjs";
import { resolveProductionRoute } from "../../src/evolution/strategy-store.mjs";
import {
  createEvolutionPolicy, readEvolutionPolicy, issueSuccessorEvolutionPolicy,
  listEvolutionPolicyHistory, readEvolutionPolicyGeneration, evolutionPolicyPath,
  EVOLUTION_POLICY_HOLD,
} from "../../src/evolution/policy.mjs";
import { buildEvolutionReport } from "../../src/evolution/operator-view.mjs";
import {
  EVOLUTION_DECLARATION_ENV, EVOLUTION_DECLARATION_SCHEMA,
} from "../../src/evolution/production-declaration.mjs";

const ROOTS = [];
function freshDir(label) {
  const d = mkdtempSync(join(tmpdir(), `evol-feed-${label}-`));
  ROOTS.push(d);
  return d;
}
test.after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function makeFixtureRepo(label) {
  const repo = freshDir(label);
  mkdirSync(join(repo, "lib"), { recursive: true });
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.email", "evol@test"]);
  git(repo, ["config", "user.name", "evol-fixture"]);
  writeFileSync(join(repo, "lib", "retry.ts"), "export const MAX_RETRIES = 3;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

const DEEPSEEK = Object.freeze({ adapterKind: "pi-builtin", providerKind: "deepseek", modelId: "deepseek-v4-flash", requiredEnvKeys: [] });
const GLM = Object.freeze({ adapterKind: "pi-builtin", providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash", requiredEnvKeys: [] });
const DEEPSEEK_ROUTE = "deepseek/deepseek-v4-flash";
const GLM_ROUTE = "merge-gateway/zai/glm-5.3-flash";
/**
 * A credential-shaped value that the durable store's own secret patterns do
 * NOT match (so it is genuinely present in the journal): the point of the
 * assertion is that the ATTRIBUTION copies nothing but bounded identifiers —
 * not that the store refused the write.
 */
const SECRET = "tok_9f3ab21c77de4408bb0192c4d5e6f7a8";

function policyInput(overrides = {}) {
  return {
    policy_name: "agent-strategy-evidence-feed-repair",
    scope_patterns: ["lib/**"],
    forbidden_patterns: [],
    strategy_dimensions_allowed: ["MODEL_ROUTING"],
    allowed_commands: ["node", "git"],
    validation_plan_id: "feed-repair-validation",
    validation_plan: { commands: [{ cmd: "node", args: ["-e", "process.exit(0)"], timeout_ms: 30000 }] },
    budget: { max_mutation_runs: 8, max_wall_clock_ms_per_run: 120000, max_evolutions_per_window: 8, window_ms: 86400000 },
    issued_by: "test-operator",
    authorization_ref: "test://agent-strategy-evidence-feed-repair",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

// ── frozen admission (the production entry contract) ───────────────────────

const FULL_EVIDENCE = {
  affected_files: { score: 1, reasons: ["one file"] },
  affected_subsystems: { score: 0, reasons: ["none"] },
  dependency_depth: { score: 0, reasons: ["none"] },
  ambiguity: { score: 0, reasons: ["exact"] },
  expected_execution_steps: { score: 0, reasons: ["one step"] },
  verification_burden: { score: 0, reasons: ["none"] },
  external_dependencies: { score: 0, reasons: ["none"] },
  concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 0, reasons: ["revert one file"] },
};

let admissionSeq = 0;
function frozenAdmission(binding = DEEPSEEK, taskId = null) {
  admissionSeq += 1;
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("bounded agent-strategy evidence feed") });
  return freezeAdmission(buildAdmissionRecord({
    taskId: taskId ?? `FEED-${admissionSeq}`,
    classification: c,
    mutationScope: ["lib/"],
    // The ADMITTED provider binding is the ONLY provider authority the
    // attribution may read (§C).
    extensions: { rollover: { enabled: true, provider_binding: { ...binding } } },
  }));
}

// ── durable evidence journals (what a real run journals) ───────────────────

const BASE_TS = Date.parse("2026-09-24T00:00:00.000Z");
function stamped(events) {
  let tick = 0;
  return events.map((e) => ({ ...e, timestamp: new Date(BASE_TS + tick++ * 1000).toISOString() }));
}

/** A HEALTHY run: one agent phase set, provider-reported occupancy, PASS. */
function healthyJournal({ phaseCount = 3, occupancy = 0.42, generation = 1 } = {}) {
  const phases = ["P0", "P1", "P2"].slice(0, Math.max(1, phaseCount));
  return stamped([
    { event_type: "DAG_ACCEPTED", stage: "decomposition", payload: { phase_count: phaseCount, ir_sha256: "a".repeat(64), dag_sha256: "b".repeat(64) } },
    ...phases.map((id) => ({ event_type: "PHASE_STARTED", stage: "phase", phase_id: id, payload: {} })),
    { event_type: "TOOL_USAGE_OBSERVED", stage: "tool", phase_id: "P0", payload: { canonical_tool_ids: ["fs.read", "fs.grep"] } },
    { event_type: "PROVIDER_USAGE_OBSERVED", stage: "rollover", phase_id: "P0", payload: { provider_reported: true, occupancy } },
    { event_type: "SPAWN_DISPATCH", stage: "rollover", payload: { sessionGeneration: generation } },
    ...phases.map((id) => ({ event_type: "PHASE_PASSED", stage: "phase", phase_id: id, payload: {} })),
    { event_type: "RUN_PASSED", stage: "terminal", payload: {} },
  ]);
}

/**
 * A DEFICIENT run: repeated repairs on one phase then HOLD. `repairs` below the
 * signal floor (3) means the run qualifies NO trigger — a deficient run that is
 * still attributed (the selection bias this card removes).
 */
function deficientJournal({ repairs = 3, holdCode = "HOLD / C3B_MUTATION_FAILED" } = {}) {
  const phases = ["P0", "P1", "P2"];
  return stamped([
    { event_type: "DAG_ACCEPTED", stage: "decomposition", payload: { phase_count: 3, ir_sha256: "c".repeat(64), dag_sha256: "d".repeat(64) } },
    ...phases.map((id) => ({ event_type: "PHASE_STARTED", stage: "phase", phase_id: id, payload: {} })),
    ...Array.from({ length: repairs }, (_, i) => ({ event_type: "PHASE_REPAIR_REQUESTED", stage: "phase", phase_id: "P0", attempt: i + 1, payload: {} })),
    { event_type: "PHASE_HELD", stage: "phase", phase_id: "P0", payload: {} },
    { event_type: "PHASE_PASSED", stage: "phase", phase_id: "P1", payload: {} },
    { event_type: "PHASE_PASSED", stage: "phase", phase_id: "P2", payload: {} },
    { event_type: "RUN_HELD", stage: "terminal", payload: { reason: holdCode } },
  ]);
}

function writeJournal(root, executionId, events) {
  const store = new RunEvidenceStore({ root, executionId, chainId: `chain-${executionId}`, checkpointId: `ckpt-${executionId}` });
  store.init();
  for (const e of events) store.appendEvent(e);
  return store;
}

function execIdFor(label) {
  return `exec_${createHash("sha256").update(label).digest("hex").slice(0, 32)}`;
}

function journalingRunner({ events, verdict }) {
  return async (opts) => {
    const enc = opts?.budget?.enforcement;
    if (enc) {
      const gate = enc.preDispatch({ executionId: "g", phase_id: "P0", nodeId: "P0", attempt: 0, runtime: { mode: "readonly", limits: { timeoutMs: 60000 } } });
      if (gate.ok) enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
    }
    const root = opts.persistence?.root;
    const executionId = opts.persistence?.executionId;
    if (root && executionId) writeJournal(root, executionId, events);
    return {
      final: verdict,
      executionId,
      nodeResults: [{ nodeId: "P0", final: verdict, attempt: 0, resultIdentity: { latencyMs: 5 } }],
      transitions: [],
      closeout: { applied: false },
      admission: opts?.admission ?? null,
    };
  };
}

/** ONE production run through the REAL entrypoint (runAdmittedGraph). */
async function productionRun({
  store = null, checkpointRoot = null, repoRoot = null, events, verdict = "PASS",
  binding = DEEPSEEK, executionId = null, evidenceRoot = null, evolution = undefined, label = "run",
}) {
  const evRoot = evidenceRoot ?? freshDir(`ev-${label}`);
  const exec = executionId ?? execIdFor(`${label}-${Math.random().toString(16).slice(2, 8)}`);
  const r = await runAdmittedGraph({
    admission: frozenAdmission(binding),
    runner: journalingRunner({ events, verdict }),
    persistence: { root: evRoot, executionId: exec },
    ir: { phases: [] },
    ...(evolution === undefined ? {} : { evolution }),
  });
  return { result: r, evidenceRoot: evRoot, executionId: exec };
}

function evolutionOpts(store, checkpointRoot, repoRoot, extra = {}) {
  return { storeRoot: store, checkpointRoot, repoRoot, reviewerIdentity: "reviewer:independent", ...extra };
}

function feedConfig(store, checkpointRoot, repoRoot, extra = {}) {
  return resolveEvolutionProductionConfig({ runnerOpts: { evolution: evolutionOpts(store, checkpointRoot, repoRoot, extra) }, env: {} });
}

function assertFeedDisposition(value, expected) {
  assert.ok(STRATEGY_FEED_DISPOSITIONS.includes(value), `${value} is not a declared feed disposition`);
  if (expected !== undefined) assert.equal(value, expected);
}

// ── F1: §A/§B/§C/§E — EVERY healthy run is attributed and recorded ──────────

test("F1 §A/§E 3 healthy non-firing production runs are recorded into the strategy memory (sample_count >= 3)", async () => {
  const store = freshDir("f1-store");
  const checkpointRoot = freshDir("f1-cp");
  const repo = makeFixtureRepo("f1-repo");
  const TC = "FEEDHEALTHY";

  const runs = [];
  for (let i = 0; i < 3; i++) {
    // A healthy run: no repairs, no HOLD, PASS terminal — it qualifies NO
    // trigger, which is EXACTLY the run class the old code never recorded.
    const run = await productionRun({
      events: healthyJournal({ generation: i + 1 }),
      verdict: "PASS",
      binding: DEEPSEEK,
      label: `f1-${i}`,
      evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
    });
    runs.push(run);
  }

  // A fourth run is DEFICIENT (1 repair, HOLD) and its journal carries a
  // SECRET in a hold reason plus an unknown free-text payload key. It still
  // fires NO signal (1 repair < floor 3), so the ONLY way it can be attributed
  // is the every-run feed — and nothing from it may reach the memory.
  const secretRun = await productionRun({
    events: [
      ...deficientJournal({ repairs: 1, holdCode: `HOLD / C3B_MUTATION_FAILED: bearer ${SECRET}` }),
      { event_type: "NOTE", stage: "phase", phase_id: "P0", payload: { free_text: `DEEPSEEK_API_KEY=${SECRET}` } },
    ],
    verdict: "HOLD",
    binding: DEEPSEEK,
    label: "f1-secret",
    evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
  });
  assert.equal(secretRun.result.final, "HOLD");
  assert.equal(secretRun.result.evolutionObservation.fired.length, 0, "1 repair never fires");
  assertFeedDisposition(secretRun.result.strategyAttribution.disposition, "RECORDED");

  for (const run of runs) {
    // the run's own semantics are untouched
    assert.equal(run.result.final, "PASS");
    assert.equal(run.result.budget.authorized, true);
    // NO trigger, NO candidate, NO cycle — and still an observation
    assert.equal(run.result.evolutionObservation.fired.length, 0, "a healthy run fires no signal");
    assert.equal(run.result.evolutionDisposition.disposition, "NO_QUALIFIED_TRIGGER");
    assertFeedDisposition(run.result.strategyAttribution.disposition, "RECORDED");
    assert.equal(run.result.strategyAttribution.recorded, true);
    assert.equal(run.result.strategyAttribution.task_class, TC);
  }

  assert.ok(
    EVOLUTION_CONSUMER_DISPOSITIONS.includes(runs[0].result.evolutionDisposition.disposition),
    "the consumed disposition stays in the declared closed set",
  );
  // the memory now carries the healthy arm
  const summary = summarizeStrategyValue({ storeRoot: store, taskClass: TC, dimension: "MODEL_ROUTING", value: DEEPSEEK_ROUTE });
  assert.ok(summary.samples >= 3, `healthy samples ${summary.samples} < 3`);
  assert.equal(summary.evidence_sufficient, true);
  assert.equal(summary.min_samples_required, MIN_SAMPLES_FOR_SUFFICIENCY);
  // 3 PASS + 1 HOLD on the same route: the HOLD is a recorded non-firing
  // deficient observation, which is exactly the evidence the old code lost.
  assert.equal(summary.success_rate, 0.75);
  assert.equal(summary.hold_rate, 0.25);

  // §C: every axis is bound on the stored observation, and nothing secret or
  // free-textual was copied.
  const mem = readStrategyMemory(store);
  assert.equal(mem.observations.length, 4);
  const obs = mem.observations[0];
  assert.ok(obs.execution_id, "run identity bound");
  assert.ok(obs.provenance.evidence_refs.length > 0, "durable evidence refs bound");
  assert.ok(obs.provenance.journal_events > 0, "journal provenance bound");
  assert.equal(obs.attribution_identity.provider, "deepseek");
  assert.equal(obs.attribution_identity.model, "deepseek-v4-flash");
  assert.equal(obs.attribution_identity.adapter_kind, "pi-builtin");
  assert.equal(obs.attribution_identity.task_class, TC);
  assert.equal(obs.attribution_identity.terminal_outcome, "PASS");
  assert.ok(obs.attribution_identity.agent_identity.phase_ids.includes("P0"), "agent identity bound");
  assert.ok(obs.attribution_identity.parent_identity, "parent/run relation bound");
  assert.ok(obs.attribution_identity.decomposition_identity, "decomposition identity bound");
  assert.ok(obs.strategy.MODEL_ROUTING === DEEPSEEK_ROUTE, "strategy dimension bound");
  assert.equal(obs.repairs, 0);
  assert.equal(obs.max_attempt, 0, "retry/repair axis bound");
  assert.equal(obs.generation, 1, "generation bound");
  assert.equal(obs.occupancy_samples, 1, "context/token axis bound");
  assert.equal(typeof obs.latency_ms, "number", "latency bound");
  assert.ok(obs.provenance.admission_id, "admission identity bound");

  // §B/§H: the durable feed log carries the dispositions and no failures.
  const log = readStrategyFeedLog(store);
  assert.equal(log.counters.RECORDED, 4);
  assert.equal(log.failures.total, 0);
  const view = strategyFeedView({ storeRoot: store });
  assert.equal(view.total, 4);
  assert.equal(view.recorded, 4, "the operator surface reports how many dispositions actually recorded");

  // §C: NO secret, NO credential, NO raw prompt content is copied into the
  // durable memory OR the durable feed log — assert over the ON-DISK files,
  // not just the in-memory views.
  for (const file of [strategyMemoryPath(store), strategyFeedLogPath(store)]) {
    const durable = readFileSync(file, "utf8");
    for (const forbidden of [SECRET, "sk-live", "Bearer", "Authorization", "API_KEY", "free_text", "BEGIN PRIVATE KEY"]) {
      assert.ok(!durable.includes(forbidden), `${file} must not contain ${forbidden}`);
    }
  }
  // the HOLD observation IS recorded, with the bounded hold code only
  const held = mem.observations.find((o) => o.outcome === "HOLD");
  assert.ok(held, "the non-firing deficient run was attributed");
  assert.equal(held.attribution_identity.terminal_hold_code, "HOLD / C3B_MUTATION_FAILED");
  assert.equal(held.repairs, 1);
  assert.equal(held.attribution_identity.provider, "deepseek", "attribution uses the ADMITTED binding");
});

// ── F2: §B eligibility — explicit exclusions, never fabrication ─────────────

test("F2 §B ineligible evidence is EXCLUDED with an explicit disposition and never fabricated", () => {
  const store = freshDir("f2-store");
  const checkpointRoot = freshDir("f2-cp");
  const repo = makeFixtureRepo("f2-repo");
  const config = feedConfig(store, checkpointRoot, repo, { taskClass: "EXCLUDE" });

  const agentEvents = [{ event_type: "PHASE_PASSED", stage: "phase", phase_id: "P0", payload: {} }, { event_type: "RUN_PASSED", stage: "terminal", payload: {} }];

  const cases = [
    // test-only synthetic record (§B) — DECLARED, never guessed
    ["SYNTHETIC_RECORD", { journal: { ok: true, events: [...agentEvents, { event_type: "SYNTHETIC_EVIDENCE", stage: "test", payload: {} }] }, executionId: execIdFor("synth") }],
    ["NOT_AGENT_RUN", { journal: { ok: true, events: [{ event_type: "RUN_PASSED", stage: "terminal", payload: {} }] }, executionId: execIdFor("admin") }],
    ["NO_DURABLE_EVIDENCE", { journal: { ok: false, reason: "journal_integrity", events: [] }, executionId: execIdFor("broken") }],
    ["EMPTY_EVIDENCE", { journal: { ok: true, events: [] }, executionId: execIdFor("empty") }],
    ["NO_ATTRIBUTION_IDENTITY", { journal: { ok: true, events: agentEvents }, executionId: null, graphRunId: null }],
  ];
  for (const [expected, input] of cases) {
    const { record, attribution } = feedStrategyObservationForProduction({
      journal: input.journal,
      config,
      executionId: input.executionId ?? null,
      graphRunId: input.graphRunId ?? null,
      admission: null,
      switchState: { state: "ENABLED", reason: null },
    });
    assertFeedDisposition(record.disposition, expected);
    assert.equal(record.recorded, false, `${expected} must not record`);
    assert.ok(record.reason, `${expected} carries a reason`);
    assert.equal(attribution, null, `${expected} yields no attribution`);
  }

  // the store accumulated NOTHING: exclusions are not observations
  assert.equal(readStrategyMemory(store).observations.length, 0);
  const log = readStrategyFeedLog(store);
  assert.equal(log.counters.RECORDED ?? 0, 0);
  assert.equal(log.counters.SYNTHETIC_RECORD, 1);
  assert.equal(log.counters.NOT_AGENT_RUN, 1);
  assert.equal(log.counters.NO_DURABLE_EVIDENCE, 1);
  assert.equal(log.counters.EMPTY_EVIDENCE, 1);
  assert.equal(log.counters.NO_ATTRIBUTION_IDENTITY, 1);

  // an INERT deployment records nothing either, and says so
  const inert = resolveEvolutionProductionConfig({ runnerOpts: {}, env: {} });
  const disabled = feedStrategyObservationForProduction({ journal: { ok: true, events: agentEvents }, config: inert, executionId: execIdFor("inert") });
  assertFeedDisposition(disabled.record.disposition, "DISABLED");
  assert.ok(disabled.record.reason.includes("storeRoot"));
});

// ── F3: §D dedup / idempotency ─────────────────────────────────────────────

test("F3 §D one authoritative run is recorded ONCE; a replayed/extended observation never double counts", () => {
  const store = freshDir("f3-store");
  const checkpointRoot = freshDir("f3-cp");
  const repo = makeFixtureRepo("f3-repo");
  const config = feedConfig(store, checkpointRoot, repo, { taskClass: "DEDUP" });
  const evidenceRoot = freshDir("f3-ev");
  const executionId = execIdFor("f3-run");

  writeJournal(evidenceRoot, executionId, healthyJournal({ generation: 5 }));
  const journal = readObservationJournal({ evidenceRoot, executionId });
  assert.equal(journal.ok, true);

  const first = feedStrategyObservationForProduction({ journal, config, executionId, graphRunId: "g-f3", admission: null });
  assertFeedDisposition(first.record.disposition, "RECORDED");
  const observationId = first.record.observation_id;
  assert.ok(observationId, "a durable observation identity is minted");
  assert.equal(first.record.observation_status, "RECORDED");

  // (a) observer retry / duplicate terminal observation: the SAME journal
  const second = feedStrategyObservationForProduction({ journal, config, executionId, graphRunId: "g-f3", admission: null });
  assertFeedDisposition(second.record.disposition, "EXISTING");
  assert.equal(second.record.observation_status, "EXISTING");
  assert.equal(second.record.observation_id, observationId, "the same authoritative run keeps one identity");
  assert.equal(readStrategyMemory(store).observations.length, 1, "no double count");

  // (b) resume: the SAME run with EXTENDED evidence is refused (conflict), the
  // stored observation is never rewritten, and the sample count is unchanged.
  writeJournal(evidenceRoot, executionId, [{ event_type: "RESUME_REQUESTED", stage: "resume", payload: { execution_id: executionId } }]);
  const resumedJournal = readObservationJournal({ evidenceRoot, executionId });
  assert.ok(resumedJournal.count > journal.count, "the resumed run has more durable evidence");
  const resumed = feedStrategyObservationForProduction({ journal: resumedJournal, config, executionId, graphRunId: "g-f3", admission: null });
  assertFeedDisposition(resumed.record.disposition, "OBSERVATION_REJECTED");
  assert.equal(resumed.record.conflict, true, "recognised as a same-run conflict, not a failure");
  const mem = readStrategyMemory(store);
  assert.equal(mem.observations.length, 1, "still exactly one observation for this run");
  assert.equal(mem.observations[0].observation_id, observationId);
  assert.equal(mem.observations[0].outcome, "PASS", "the recorded observation was not rewritten");
  assert.equal(readStrategyFeedLog(store).failures.total, 0, "a dedup conflict is not an operator failure");
});

// ── F4: §I crash / resume / partial write ──────────────────────────────────

test("F4 §I durable observations survive a restart, resume does not double count, partial writes never form an observation", async () => {
  const store = freshDir("f4-store");
  const checkpointRoot = freshDir("f4-cp");
  const repo = makeFixtureRepo("f4-repo");
  const TC = "CRASHRESUME";

  const run = await productionRun({
    events: healthyJournal(),
    verdict: "PASS",
    binding: DEEPSEEK,
    label: "f4-run",
    evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
  });
  assertFeedDisposition(run.result.strategyAttribution.disposition, "RECORDED");
  const afterRun = readStrategyMemory(store).observations.length;
  assert.equal(afterRun, 1);

  // (a) DURABILITY across a process restart: a FRESH node process reads the
  // same store from disk and agrees.
  const memUrl = pathToFileURL(resolvePath("src/evolution/strategy-memory.mjs")).href;
  const script = `const { readStrategyMemory } = await import(${JSON.stringify(memUrl)});`
    + `process.stdout.write(String(readStrategyMemory(${JSON.stringify(store)}).observations.length));`;
  const fromFreshProcess = Number(execFileSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" }).trim());
  assert.equal(fromFreshProcess, afterRun, "restart preserves the sample count");

  // (b) DUPLICATE RESUME through the production entrypoint: the same
  // authoritative execution id runs again with extended evidence (what a
  // crash-resume does). It must NOT be counted twice, and the run's own
  // result is untouched (fail-open).
  const resumedEvents = [
    ...healthyJournal(),
    { event_type: "RESUME_REQUESTED", stage: "resume", payload: { execution_id: run.executionId } },
  ];
  const resume = await productionRun({
    events: resumedEvents,
    verdict: "PASS",
    binding: DEEPSEEK,
    executionId: run.executionId,
    evidenceRoot: run.evidenceRoot,
    label: "f4-resume",
    evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
  });
  assert.equal(resume.result.final, "PASS", "NORMAL_OPERATION unaffected by the dedup refusal");
  assertFeedDisposition(resume.result.strategyAttribution.disposition, "OBSERVATION_REJECTED");
  assert.equal(resume.result.strategyAttribution.conflict, true);
  assert.equal(readStrategyMemory(store).observations.length, afterRun, "resume adds no sample");

  // (c) PARTIAL WRITE: an orphaned temp file is never an observation, and a
  // torn main file never forms one either.
  writeFileSync(`${strategyMemoryPath(store)}.tmp-99999`, "{ \"schema\": \"autoloop.evolution-strategy-memory/v1\", \"observations\": [");
  assert.equal(readStrategyMemory(store).observations.length, afterRun, "an orphaned temp write is invisible");
  writeFileSync(strategyMemoryPath(store), "{ \"schema\": \"autoloop.evolution-strategy-memory/v1\", \"observations\": [{\"observation_id\":\"sobs_torn\"");
  assert.equal(readStrategyMemory(store).observations.length, 0, "a torn file yields NO valid observation (fail-open read)");

  // ...and the next eligible run restores a valid, atomic memory file.
  const recovered = await productionRun({
    events: healthyJournal(),
    verdict: "PASS",
    binding: DEEPSEEK,
    label: "f4-recovered",
    evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
  });
  assertFeedDisposition(recovered.result.strategyAttribution.disposition, "RECORDED");
  assert.equal(readStrategyMemory(store).observations.length, 1);
  assert.doesNotThrow(() => JSON.parse(readFileSync(strategyMemoryPath(store), "utf8")));
});

// ── F4b: §D/§I duplicate terminal observation ACROSS processes ─────────────

test("F4b §D the same authoritative run observed by a SECOND process is EXISTING, never a second sample", () => {
  const store = freshDir("f4b-store");
  const evidenceRoot = freshDir("f4b-ev");
  const executionId = execIdFor("f4b-run");
  writeJournal(evidenceRoot, executionId, healthyJournal());

  const feedUrl = pathToFileURL(resolvePath("src/evolution/attribution-feed.mjs")).href;
  const obsUrl = pathToFileURL(resolvePath("src/evolution/production-observer.mjs")).href;
  const memUrl = pathToFileURL(resolvePath("src/evolution/strategy-memory.mjs")).href;
  const script = [
    `const { feedStrategyObservationForProduction } = await import(${JSON.stringify(feedUrl)});`,
    `const { readObservationJournal } = await import(${JSON.stringify(obsUrl)});`,
    `const { readStrategyMemory } = await import(${JSON.stringify(memUrl)});`,
    `const journal = readObservationJournal({ evidenceRoot: ${JSON.stringify(evidenceRoot)}, executionId: ${JSON.stringify(executionId)} });`,
    `const config = { enabled: true, storeRoot: ${JSON.stringify(store)}, taskClass: "CROSSPROC", promptProfile: null };`,
    `const out = feedStrategyObservationForProduction({ journal, config, executionId: ${JSON.stringify(executionId)}, graphRunId: "g-f4b", switchState: { state: "ENABLED" } });`,
    `process.stdout.write(JSON.stringify({ disposition: out.record.disposition, samples: readStrategyMemory(${JSON.stringify(store)}).observations.length }));`,
  ].join("\n");

  const first = JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" }).trim());
  assert.equal(first.disposition, "RECORDED");
  assert.equal(first.samples, 1);
  const second = JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" }).trim());
  assert.equal(second.disposition, "EXISTING", "a second process observing the same run dedupes");
  assert.equal(second.samples, 1, "the sample count is stable across processes");
});

// ── F5: §F fitness reachability over REAL production observations ──────────

test("F5 §F baseline vs candidate over production-written observations ⇒ EVIDENCE_SUFFICIENT = YES, FITNESS = ACCEPT", async () => {
  const store = freshDir("f5-store");
  const checkpointRoot = freshDir("f5-cp");
  const repo = makeFixtureRepo("f5-repo");
  const TC = "FITNESSREACH";

  // The BASELINE arm (the deployment's current strategy, GLM) and the
  // CANDIDATE arm (deepseek) are BOTH written by real production runs. The
  // deficient baseline uses 2 repairs, which is BELOW the signal floor: no
  // trigger fires, so nothing but the every-run feed can record it.
  for (let i = 0; i < 3; i++) {
    const r = await productionRun({
      events: deficientJournal({ repairs: 2 }),
      verdict: "HOLD",
      binding: GLM,
      label: `f5-base-${i}`,
      evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
    });
    assertFeedDisposition(r.result.strategyAttribution.disposition, "RECORDED");
    assert.equal(r.result.evolutionDisposition.disposition, "NO_QUALIFIED_TRIGGER", "2 repairs never qualify a trigger");
  }
  for (let i = 0; i < 3; i++) {
    const r = await productionRun({
      events: healthyJournal({ generation: i + 1 }),
      verdict: "PASS",
      binding: DEEPSEEK,
      label: `f5-cand-${i}`,
      evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
    });
    assertFeedDisposition(r.result.strategyAttribution.disposition, "RECORDED");
  }

  const baseline = summarizeStrategyValue({ storeRoot: store, taskClass: TC, dimension: "MODEL_ROUTING", value: GLM_ROUTE });
  const candidate = summarizeStrategyValue({ storeRoot: store, taskClass: TC, dimension: "MODEL_ROUTING", value: DEEPSEEK_ROUTE });
  assert.equal(baseline.samples, 3, "the deficient baseline arm accumulated from production alone");
  assert.equal(candidate.samples, 3, "the healthy candidate arm accumulated from production alone");
  assert.equal(baseline.evidence_sufficient, true);
  assert.equal(candidate.evidence_sufficient, true);

  // The deployment declares the strategy it currently runs (the production
  // configuration seam §J.2 — never a test-local literal fed into the memory).
  const config = feedConfig(store, checkpointRoot, repo, {
    taskClass: TC,
    strategyDimensions: ["MODEL_ROUTING"],
    strategyBaselineValues: { MODEL_ROUTING: GLM_ROUTE },
  });
  const trigger = {
    schema: "autoloop.evolution-trigger/v1",
    trigger_id: "evt_f5",
    signal_class: "REPEATED_REPAIR_REQUIREMENT",
    signature: "sig-f5",
    count: 3,
    evidence_refs: ["e1", "e2", "e3"],
    observation: {},
  };

  // candidate derivation …
  const produced = produceImprovementPlan({
    triggerEvent: trigger, storeRoot: store, taskClass: TC,
    dimensions: config.strategyDimensions,
    baselineValues: config.strategyBaselineValues,
  });
  assert.equal(produced.status, "PLAN", JSON.stringify(produced.diagnosis ?? produced.reason));
  assert.equal(produced.plan.kind, "AGENT_STRATEGY");
  assert.equal(produced.plan.strategy_plan.from_value, GLM_ROUTE, "the baseline is the DECLARED production strategy");
  assert.equal(produced.plan.strategy_plan.to_value, DEEPSEEK_ROUTE);

  const derived = deriveStrategyCandidate({
    plan: produced.plan, triggerEvent: trigger,
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    strategyPolicy: null,
  });
  assert.equal(derived.status, "CREATED");

  // … fitness evaluation over the SAME production-written memory
  const fitness = evaluateStrategyFitness({
    storeRoot: store, taskClass: TC, dimension: "MODEL_ROUTING",
    baselineValue: produced.plan.strategy_plan.from_value,
    candidateValue: produced.plan.strategy_plan.to_value,
    measurementPlan: derived.candidate.measurement_plan,
    candidateId: derived.candidate.candidate_id,
  });
  assert.equal(fitness.evidence.sufficient, true, "EVIDENCE_SUFFICIENT");
  assert.equal(fitness.baseline.samples, 3);
  assert.equal(fitness.candidate.samples, 3);
  assert.equal(fitness.regression.verdict, "PASS");
  assert.equal(fitness.targetMetric.verdict, "IMPROVED");
  assert.equal(fitness.decision, "ACCEPT", "FITNESS = ACCEPT");
});

// ── F6: §G trigger independence ────────────────────────────────────────────

test("F6 §G healthy non-triggering and qualified deficient runs share ONE attribution feed; trigger semantics unchanged", async () => {
  const store = freshDir("f6-store");
  const checkpointRoot = freshDir("f6-cp");
  const repo = makeFixtureRepo("f6-repo");
  const TC = "TRIGGERINDEP";
  // The evolution loop is OFF without a durable policy: create the ONE lawful
  // operator artifact so the qualified run reaches the cycle path.
  createEvolutionPolicy(store, policyInput());

  // (1) a HEALTHY run: MEMORY_RECORDED, NO cycle.
  const healthy = await productionRun({
    events: healthyJournal(),
    verdict: "PASS",
    binding: DEEPSEEK,
    label: "f6-healthy",
    evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
  });
  assertFeedDisposition(healthy.result.strategyAttribution.disposition, "RECORDED");
  assert.equal(healthy.result.evolutionDisposition.disposition, "NO_QUALIFIED_TRIGGER");

  // (2) a QUALIFIED deficient run: MEMORY_RECORDED first, then the trigger path.
  const qualified = await productionRun({
    events: deficientJournal({ repairs: 3 }),
    verdict: "HOLD",
    binding: GLM,
    label: "f6-qualified",
    evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
  });
  assertFeedDisposition(qualified.result.strategyAttribution.disposition, "RECORDED");
  assert.equal(qualified.result.evolutionDisposition.disposition, "CYCLE_STARTED");
  assert.equal(qualified.result.evolutionDisposition.attribution_disposition, "RECORDED",
    "the scheduled cycle reports the feed's disposition (the attribution was NOT taken by the cycle)");
  assert.equal(qualified.result.evolutionDisposition.attribution_recorded, true);

  // (3) two MORE qualified deficient runs: gated by dedup/cooldown, and STILL
  // recorded — the gate can never suppress attribution.
  for (const label of ["f6-gated-1", "f6-gated-2"]) {
    const gated = await productionRun({
      events: deficientJournal({ repairs: 3 }),
      verdict: "HOLD",
      binding: GLM,
      label,
      evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
    });
    assertFeedDisposition(gated.result.strategyAttribution.disposition, "RECORDED");
    assert.equal(gated.result.evolutionDisposition.disposition, "GATED");
  }

  // ONE durable trigger; the trigger semantics are untouched.
  const state = readTriggerState(store);
  assert.equal(state.triggers.length, 1, "dedup/cooldown still yield exactly one recorded trigger");
  assert.equal(state.triggers[0].signal_class, "REPEATED_REPAIR_REQUIREMENT");

  // and the healthy arm plus all three deficient runs are in the memory
  const healthyArm = summarizeStrategyValue({ storeRoot: store, taskClass: TC, dimension: "MODEL_ROUTING", value: DEEPSEEK_ROUTE });
  const deficientArm = summarizeStrategyValue({ storeRoot: store, taskClass: TC, dimension: "MODEL_ROUTING", value: GLM_ROUTE });
  assert.equal(healthyArm.samples, 1, "the healthy non-firing run was recorded");
  assert.equal(deficientArm.samples, 3, "every deficient run was recorded, gated or not");
  assert.equal(readStrategyMemory(store).observations.length, 4);

  await drainEvolutionCycles({ timeoutMs: 120000 });
  const outcomes = evolutionConsumerState().outcomes.filter((o) => o.trigger_id === qualified.result.evolutionDisposition.trigger_id);
  assert.ok(outcomes.length >= 1, "the qualified run produced at least one cycle outcome");
  for (const o of outcomes) assert.ok(EVOLUTION_LOOP_VERDICTS.includes(o.loop_verdict) || o.loop_verdict === null);

  // (4) SUSPENDED: no new evolution state accumulates — but the disposition is
  // EXPLICIT (never a silent drop) and the run is untouched. Resuming restores
  // recording on the same evidence class.
  const before = readStrategyMemory(store).observations.length;
  const saved = process.env.AUTO_EVOLUTION;
  try {
    process.env.AUTO_EVOLUTION = "SUSPENDED";
    const suspended = await productionRun({
      events: healthyJournal(),
      verdict: "PASS",
      binding: DEEPSEEK,
      label: "f6-suspended",
      evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
    });
    assert.equal(suspended.result.final, "PASS", "NORMAL_OPERATION unaffected by the kill switch");
    assertFeedDisposition(suspended.result.strategyAttribution.disposition, "SUSPENDED");
    assert.ok(suspended.result.strategyAttribution.reason);
    assert.equal(readStrategyMemory(store).observations.length, before, "a suspended deployment accumulates no observations");
  } finally {
    if (saved === undefined) delete process.env.AUTO_EVOLUTION;
    else process.env.AUTO_EVOLUTION = saved;
  }
  const resumed = await productionRun({
    events: healthyJournal(),
    verdict: "PASS",
    binding: DEEPSEEK,
    label: "f6-resumed",
    evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
  });
  assertFeedDisposition(resumed.result.strategyAttribution.disposition, "RECORDED");
  assert.equal(readStrategyMemory(store).observations.length, before + 1, "resume restores recording");
});

// ── F7: §H fail-open + operator visibility ─────────────────────────────────

test("F7 §H a memory/feed failure never changes the run result and is visible to the operator", async () => {
  const checkpointRootA = freshDir("f7-cp-a");
  const repo = makeFixtureRepo("f7-repo");
  const TC = "FAILOPEN";

  // (a) the memory path is blocked (a DIRECTORY sits at strategy-memory.json)
  // while the feed log stays writable: FEED_FAILED, run untouched, failure
  // visible in the durable feed log AND in the operator report.
  const store = freshDir("f7-store");
  mkdirSync(strategyMemoryPath(store), { recursive: true });
  const blocked = await productionRun({
    events: healthyJournal(),
    verdict: "PASS",
    binding: DEEPSEEK,
    label: "f7-blocked",
    evolution: evolutionOpts(store, checkpointRootA, repo, { taskClass: TC }),
  });
  assert.equal(blocked.result.final, "PASS", "the authoritative run result is unchanged");
  assert.equal(blocked.result.budget.authorized, true);
  assertFeedDisposition(blocked.result.strategyAttribution.disposition, "FEED_FAILED");
  assert.equal(blocked.result.strategyAttribution.failure, true);
  assert.ok(blocked.result.strategyAttribution.reason, "the failure carries a reason");
  assert.equal(blocked.result.strategyAttribution.feed_log_written, true);
  const log = readStrategyFeedLog(store);
  assert.equal(log.counters.FEED_FAILED, 1);
  assert.equal(log.failures.total, 1);
  const report = buildEvolutionReport({ storeRoot: store, env: {} });
  assert.ok(
    report.diagnostics.some((d) => d.code === "ATTRIBUTION_FEED_FAILURE"),
    `operator report must surface the feed failure: ${JSON.stringify(report.diagnostics)}`,
  );
  assert.equal(report.attributionFeed.failures.total, 1);

  // (b) the store root itself is unusable (a FILE): the durable log cannot be
  // written either, so the envelope + the in-process feed state carry the
  // failure. The run is STILL untouched.
  const notADir = join(freshDir("f7-file"), "store-file");
  writeFileSync(notADir, "not a directory\n");
  const unusable = await productionRun({
    events: healthyJournal(),
    verdict: "PASS",
    binding: DEEPSEEK,
    label: "f7-unusable",
    evolution: evolutionOpts(notADir, checkpointRootA, repo, { taskClass: TC }),
  });
  assert.equal(unusable.result.final, "PASS");
  assert.equal(unusable.result.budget.authorized, true);
  assertFeedDisposition(unusable.result.strategyAttribution.disposition, "FEED_FAILED");
  assert.equal(unusable.result.strategyAttribution.feed_log_written, false);
  const inProcess = attributionFeedState().recent.filter((r) => r.execution_id === unusable.executionId);
  assert.equal(inProcess.length, 1, "the failure stays visible in-process when the durable log is unwritable");
  assert.equal(inProcess[0].disposition, "FEED_FAILED");
});

// ── F8: §A natural trigger path with NO hand-fed plan and NO seeded memory ──

test("F8 §A qualified deficient run ⇒ candidate derivation ⇒ fitness ACCEPT ⇒ PROMOTED (no hand-fed plan, no seeded memory)", async () => {
  const store = freshDir("f8-store");
  const checkpointRoot = freshDir("f8-cp");
  const repo = makeFixtureRepo("f8-repo");
  createEvolutionPolicy(store, policyInput());
  const TC = "NATURALFEED";

  const evolution = evolutionOpts(store, checkpointRoot, repo, {
    taskClass: TC,
    strategyDimensions: ["MODEL_ROUTING"],
    // The deployment declares the strategy currently in force (§J.2).
    strategyBaselineValues: { MODEL_ROUTING: GLM_ROUTE },
  });

  // Both arms accumulate from REAL production runs BEFORE anything fires: the
  // healthy arm is written by the every-run feed (no trigger at all), and the
  // deficient runs record as they go. Nothing is seeded into the memory.
  for (let i = 0; i < 3; i++) {
    const r = await productionRun({ events: healthyJournal({ generation: i + 1 }), verdict: "PASS", binding: DEEPSEEK, label: `f8-healthy-${i}`, evolution });
    assertFeedDisposition(r.result.strategyAttribution.disposition, "RECORDED");
    assert.equal(r.result.evolutionDisposition.disposition, "NO_QUALIFIED_TRIGGER");
  }
  let fired = null;
  for (let i = 0; i < 3; i++) {
    // The THIRD deficient run carries the 3rd repair on the same phase, which
    // is what crosses the signal floor.
    const r = await productionRun({
      events: deficientJournal({ repairs: i === 2 ? 3 : 2 }),
      verdict: "HOLD",
      binding: GLM,
      label: `f8-deficient-${i}`,
      evolution,
    });
    assertFeedDisposition(r.result.strategyAttribution.disposition, "RECORDED");
    if (r.result.evolutionDisposition.disposition === "CYCLE_STARTED") fired = r;
  }
  assert.ok(fired, "the third deficient run qualified the trigger");

  await drainEvolutionCycles({ timeoutMs: 180000 });
  const outcomes = evolutionConsumerState().outcomes.filter((o) => o.trigger_id === fired.result.evolutionDisposition.trigger_id);
  assert.equal(outcomes.length, 1, JSON.stringify(evolutionConsumerState().outcomes.map((o) => o.disposition)));
  const o = outcomes[0];
  assert.ok(EVOLUTION_CONSUMER_DISPOSITIONS.includes(fired.result.evolutionDisposition.disposition));
  assert.equal(o.disposition, "CYCLE_COMPLETED", JSON.stringify(o));
  assert.ok(EVOLUTION_LOOP_VERDICTS.includes(o.loop_verdict));
  assert.equal(o.loop_verdict, "PROMOTED", `natural strategy evolution did not complete: ${JSON.stringify(o.cycle)}`);
  assert.equal(o.cycle.candidate_kind, "AGENT_STRATEGY");
  assert.equal(o.cycle.strategy_activation.to_value, DEEPSEEK_ROUTE);
  // the promoted value is now the resolved route for the task class
  assert.equal(resolveProductionRoute({ storeRoot: store, taskClass: TC }).route, DEEPSEEK_ROUTE);
  // the memory is a pure product of production runs (3 healthy + 3 deficient)
  assert.equal(readStrategyMemory(store).observations.length, 6);
});

// ── F10b: §B the durable Subagent path attributes under the DURABLE id ─────

test("F10b §B the durable sub-agent path is attributed under its durable journal id (logical id != journal owner)", async () => {
  const store = freshDir("f10b-store");
  const checkpointRoot = freshDir("f10b-cp");
  const repo = makeFixtureRepo("f10b-repo");
  const TC = "SUBAGENTFEED";
  const logicalId = execIdFor("f10b-logical");
  const durableId = execIdFor("f10b-durable");
  const evidenceRoot = freshDir("f10b-ev");

  const r = await runAdmittedGraph({
    admission: frozenAdmission(GLM),
    // What runSubagentGraph returns on the PRODUCTION durable path: the
    // caller's logical execution id PLUS the durable id the journal was
    // actually written under.
    runner: async (opts) => {
      const enc = opts?.budget?.enforcement;
      if (enc) {
        const gate = enc.preDispatch({ executionId: "g", phase_id: "P0", nodeId: "P0", attempt: 0, runtime: { mode: "readonly", limits: { timeoutMs: 60000 } } });
        if (gate.ok) enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
      }
      writeJournal(opts.persistence.root, opts.persistence.executionId, deficientJournal({ repairs: 1 }));
      return {
        final: "HOLD",
        executionId: logicalId,
        durableExecutionId: opts.persistence.executionId,
        nodeResults: [{ nodeId: "P0", final: "HOLD", attempt: 0, resultIdentity: { latencyMs: 5 } }],
        transitions: [],
        closeout: { applied: false },
        admission: opts.admission ?? null,
      };
    },
    persistence: { root: evidenceRoot, executionId: durableId },
    ir: { phases: [] },
    evolution: evolutionOpts(store, checkpointRoot, repo, { taskClass: TC }),
  });

  assert.equal(r.executionId, logicalId, "the logical id is preserved on the envelope");
  assert.equal(r.durableExecutionId, durableId);
  assertFeedDisposition(r.strategyAttribution.disposition, "RECORDED");
  assert.equal(r.strategyAttribution.execution_id, durableId, "the JOURNAL OWNER is the attributed run identity");
  const mem = readStrategyMemory(store);
  assert.equal(mem.observations.length, 1);
  assert.equal(mem.observations[0].execution_id, durableId);
  assert.equal(mem.observations[0].task_class, TC);
  assert.equal(mem.observations[0].attribution_identity.provider, "merge-gateway");
});

// ── F9: §J.1 policy succession ─────────────────────────────────────────────

test("F9 §J.1 policy succession: previous-digest binding, monotonic generation, exclusive active policy, preserved history", () => {
  const store = freshDir("f9-store");
  const created = createEvolutionPolicy(store, policyInput());
  assert.equal(created.status, "AUTHORIZED_CREATED");
  const gen0 = readEvolutionPolicy(store, { allowExpired: true });
  assert.equal(gen0.generation, 0);
  assert.equal(gen0.previous_policy_digest, undefined);

  // gen 0 → gen 1, binding the outgoing digest
  const successor = issueSuccessorEvolutionPolicy(store, {
    ...policyInput({ policy_name: "agent-strategy-evidence-feed-repair-v2" }),
    previous_policy_digest: gen0.policy_digest,
  });
  assert.equal(successor.status, "SUCCEEDED");
  assert.equal(successor.generation, 1);
  assert.equal(successor.previous.policy_digest, gen0.policy_digest);
  const gen1 = readEvolutionPolicy(store, { allowExpired: true });
  assert.equal(gen1.generation, 1);
  assert.equal(gen1.previous_policy_digest, gen0.policy_digest, "the successor binds the previous digest");
  assert.notEqual(gen1.policy_id, gen0.policy_id);

  // the outgoing generation is PRESERVED and readable; exactly one ACTIVE record
  assert.ok(existsSync(successor.archive.path), "the outgoing generation was archived");
  const history = listEvolutionPolicyHistory(store);
  assert.equal(history.length, 1);
  assert.equal(history[0].generation, 0);
  assert.equal(history[0].policy_digest, gen0.policy_digest);
  assert.deepEqual(readEvolutionPolicyGeneration(store, 0), { ...gen0 });
  assert.ok(existsSync(evolutionPolicyPath(store)), "the single active policy record exists");
  assert.equal(readEvolutionPolicyGeneration(store, 1), null, "the active generation is not duplicated into history");

  // monotonic: the next successor is gen 2, not a conflict
  const successor2 = issueSuccessorEvolutionPolicy(store, policyInput({ policy_name: "agent-strategy-evidence-feed-repair-v3" }));
  assert.equal(successor2.generation, 2);
  assert.equal(readEvolutionPolicy(store, { allowExpired: true }).previous_policy_digest, gen1.policy_digest);

  // a wrong previous digest fails closed and changes nothing
  assert.throws(
    () => issueSuccessorEvolutionPolicy(store, { ...policyInput({ policy_name: "v4" }), previous_policy_digest: "0".repeat(64) }),
    (e) => e.code === EVOLUTION_POLICY_HOLD.SUCCESSION_MISMATCH,
  );
  // a non-monotonic declared generation fails closed
  assert.throws(
    () => issueSuccessorEvolutionPolicy(store, { ...policyInput({ policy_name: "v5" }), generation: 9 }),
    (e) => e.code === EVOLUTION_POLICY_HOLD.SUCCESSION_MISMATCH,
  );
  assert.equal(readEvolutionPolicy(store, { allowExpired: true }).generation, 2, "refusals never advance the generation");

  // the operator report exposes the active generation, its predecessor and the
  // preserved history.
  const report = buildEvolutionReport({ storeRoot: store, env: {} });
  assert.equal(report.policy.generation, 2);
  assert.equal(report.policy.previousPolicyDigest, gen1.policy_digest);
  assert.equal(report.policy.history.length, 2);

  // an IDENTICAL re-issue is a no-op (the content matches; only the per-call
  // issued_at differs), so it neither conflicts nor advances anything.
  const identical = createEvolutionPolicy(store, policyInput({
    policy_name: "agent-strategy-evidence-feed-repair-v3",
    expires_at: readEvolutionPolicy(store, { allowExpired: true }).expires_at,
  }));
  const activeBefore = readEvolutionPolicy(store, { allowExpired: true });
  assert.equal(identical.status, "AUTHORIZED_EXISTING_IDENTICAL");
  assert.equal(identical.policy.policy_id, activeBefore.policy_id);
  assert.equal(activeBefore.generation, 2, "an identical re-issue does not advance the generation");
  assert.equal(listEvolutionPolicyHistory(store).length, 2, "and preserves exactly the two predecessors");

  // THE OPERATOR LANE: a successor is issued by the CLI — no manual archiving.
  const cli = execFileSync("node", ["scripts/evolution-issue-policy.mjs", "--store", store, "--successor", "--json"], { cwd: resolvePath("."), encoding: "utf8" });
  const parsed = JSON.parse(cli);
  assert.equal(parsed.status, "SUCCEEDED");
  assert.equal(parsed.generation, 3);
  assert.ok(parsed.archived, "the CLI archived the outgoing generation");
  assert.equal(parsed.previous_policy_digest, readEvolutionPolicyGeneration(store, 2).policy_digest);
  assert.equal(listEvolutionPolicyHistory(store).length, 3, "every generation stays preserved");
});

// ── F10: §J.2 production declaration seam ──────────────────────────────────

test("F10 §J.2 the deployment declares storeRoot/checkpointRoot/repoRoot/taskClass/strategyBaselineValues (malformed ⇒ surfaced, not swallowed)", async () => {
  const store = freshDir("f10-store");
  const checkpointRoot = freshDir("f10-cp");
  const repo = makeFixtureRepo("f10-repo");
  const declDir = freshDir("f10-decl");
  const declPath = join(declDir, "evolution-deployment.json");
  writeFileSync(declPath, JSON.stringify({
    schema: EVOLUTION_DECLARATION_SCHEMA,
    declared_by: "operator:test",
    storeRoot: store,
    checkpointRoot,
    repoRoot: repo,
    taskClass: "declared",
    strategyBaselineValues: { MODEL_ROUTING: GLM_ROUTE },
    strategyDimensions: ["MODEL_ROUTING"],
  }, null, 2));

  const savedDecl = process.env[EVOLUTION_DECLARATION_ENV];
  const savedBaseline = process.env.AEGISFLOW_EVOLUTION_STRATEGY_BASELINE_VALUES;
  try {
    process.env[EVOLUTION_DECLARATION_ENV] = declPath;
    delete process.env.AEGISFLOW_EVOLUTION_STRATEGY_BASELINE_VALUES;

    // No runnerOpts.evolution at all: the declaration alone enables the seam.
    const cfg = resolveEvolutionProductionConfig({ runnerOpts: {} });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.storeRoot, store);
    assert.equal(cfg.checkpointRoot, checkpointRoot);
    assert.equal(cfg.repoRoot, repo);
    assert.equal(cfg.taskClass, "DECLARED", "task class declared by production config");
    assert.deepEqual(cfg.strategyBaselineValues, { MODEL_ROUTING: GLM_ROUTE },
      "strategyBaselineValues is a PRODUCTION input, not an internal object seam");
    assert.deepEqual(cfg.strategyDimensions, ["MODEL_ROUTING"]);
    assert.equal(cfg.declaration.provided, true);
    assert.deepEqual(cfg.declaration.errors, []);

    // an env override wins over the declaration (documented precedence)
    process.env.AEGISFLOW_EVOLUTION_STRATEGY_BASELINE_VALUES = JSON.stringify({ MODEL_ROUTING: DEEPSEEK_ROUTE });
    const overridden = resolveEvolutionProductionConfig({ runnerOpts: {} });
    assert.deepEqual(overridden.strategyBaselineValues, { MODEL_ROUTING: DEEPSEEK_ROUTE });
    delete process.env.AEGISFLOW_EVOLUTION_STRATEGY_BASELINE_VALUES;

    // a production run with NO runnerOpts.evolution feeds the declared store.
    const run = await productionRun({ events: healthyJournal(), verdict: "PASS", binding: DEEPSEEK, label: "f10-run" });
    assertFeedDisposition(run.result.strategyAttribution.disposition, "RECORDED");
    const mem = readStrategyMemory(store);
    assert.equal(mem.observations.length, 1);
    assert.equal(mem.observations[0].task_class, "DECLARED");
    assert.equal(run.result.strategyAttribution.task_class, "DECLARED");

    // a malformed declaration is IGNORED (fail-open) but its errors are surfaced
    writeFileSync(declPath, JSON.stringify({ storeRoot: store, task_class: "typo" }));
    const broken = resolveEvolutionProductionConfig({ runnerOpts: {} });
    assert.equal(broken.enabled, false, "a malformed declaration declares nothing");
    assert.deepEqual(broken.missing, ["storeRoot", "checkpointRoot", "repoRoot"]);
    assert.equal(broken.declaration.provided, true);
    assert.match(broken.declaration.errors.join(";"), /unknown_task_class|unknown_/);
    const report = buildEvolutionReport({ storeRoot: store, env: { [EVOLUTION_DECLARATION_ENV]: declPath } });
    assert.ok(report.diagnostics.some((d) => d.code === "DEPLOYMENT_DECLARATION_INVALID"),
      `operator report must surface the invalid declaration: ${JSON.stringify(report.diagnostics)}`);

    // an invalid baseline-values env variable is refused, never reinterpreted
    process.env.AEGISFLOW_EVOLUTION_STRATEGY_BASELINE_VALUES = "{not json";
    const badBaseline = resolveEvolutionProductionConfig({ runnerOpts: {} });
    assert.equal(badBaseline.strategyBaselineValues, null);
    assert.ok(badBaseline.strategyBaselineValuesError, "the invalid baseline declaration is reported");
    delete process.env.AEGISFLOW_EVOLUTION_STRATEGY_BASELINE_VALUES;

    // THE OPERATOR LANE: the deployment declaration is written by the CLI, and
    // the gate then resolves it from the environment alone.
    const cliPath = join(declDir, "declared-by-cli.json");
    const cli = execFileSync("node", [
      "scripts/evolution-declare-production.mjs", "--out", cliPath,
      "--store-root", store, "--checkpoint-root", checkpointRoot, "--repo-root", repo,
      "--task-class", "clideclared",
      "--strategy-baseline", `MODEL_ROUTING=${GLM_ROUTE}`,
      "--strategy-dimension", "MODEL_ROUTING",
      "--declared-by", "operator:cli-test",
      "--json",
    ], { cwd: resolvePath("."), encoding: "utf8" });
    assert.ok(cli.includes("status: DECLARED"), cli);
    process.env[EVOLUTION_DECLARATION_ENV] = cliPath;
    const fromCli = resolveEvolutionProductionConfig({ runnerOpts: {} });
    assert.equal(fromCli.enabled, true);
    assert.equal(fromCli.taskClass, "CLIDECLARED");
    assert.deepEqual(fromCli.strategyBaselineValues, { MODEL_ROUTING: GLM_ROUTE });
    assert.deepEqual(fromCli.declaration.errors, []);
    // ...and a conflicting re-declaration at the same path fails closed
    const conflict = spawnSync("node", [
      "scripts/evolution-declare-production.mjs", "--out", cliPath, "--store-root", join(store, "other"),
    ], { cwd: resolvePath("."), encoding: "utf8" });
    assert.equal(conflict.status, 1, conflict.stdout + conflict.stderr);
    assert.match(conflict.stderr, /EVOLUTION_DECLARATION_CONFLICT/);
  } finally {
    if (savedDecl === undefined) delete process.env[EVOLUTION_DECLARATION_ENV];
    else process.env[EVOLUTION_DECLARATION_ENV] = savedDecl;
    if (savedBaseline === undefined) delete process.env.AEGISFLOW_EVOLUTION_STRATEGY_BASELINE_VALUES;
    else process.env.AEGISFLOW_EVOLUTION_STRATEGY_BASELINE_VALUES = savedBaseline;
  }
});
