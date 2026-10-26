// test/evolution/test-evolution-proposal-only-repair.mjs
//
// AEGISFLOW_EVOLUTION_PROPOSAL_ONLY_TARGETED_REPAIR_1 — G1/G2/G3 regression.
//
// Every case below drives the REAL production path (`runAdmittedGraph` →
// durable journal → observer → consumer → `runEvolutionCycle`), never a
// hand-call of the stage under test:
//
//   G1  synthetic / test-only evidence is refused BEFORE trigger evaluation
//       → no CYCLE_STARTED, no durable trigger, no candidate;
//       real qualified evidence still fires (no regression);
//   G2  a derived strategy proposal is DURABLE (survives a fresh process),
//       identity-digest verifiable, idempotent on retry, and a write failure
//       HOLDs instead of claiming a proposal;
//   G3  proposal-only is an explicit, default-OFF ceiling: it persists the
//       proposal and returns PROPOSAL_RECORDED without entering authorization,
//       mutation, fitness, review, promotion or canary; a missing/invalid
//       setting and unverifiable evidence fail CLOSED.
//
// Run: node --test test/evolution/test-evolution-proposal-only-repair.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";

import { createEvolutionPolicy } from "../../src/evolution/policy.mjs";
import {
  EVOLUTION_LOOP_HOLD, EVOLUTION_LOOP_VERDICTS, runEvolutionCycle,
} from "../../src/evolution/loop.mjs";
import {
  candidateStorePath, candidateFilePath, readCandidate,
} from "../../src/evolution/candidate.mjs";
import {
  EVOLUTION_CONSUMER_DISPOSITIONS, EVOLUTION_CONSUMER_OUTCOME_DISPOSITIONS,
  drainEvolutionCycles, evolutionConsumerState, resolveEvolutionProductionConfig,
} from "../../src/evolution/production-consumer.mjs";
import { readTriggerState } from "../../src/evolution/trigger.mjs";
import { readStrategyPolicy, resolveRoutePreference } from "../../src/evolution/strategy-store.mjs";
import { digestOf } from "../../src/canonical-digest.mjs";
import { deriveAttribution } from "../../src/evolution/attribution.mjs";
import { buildStrategyObservation, recordStrategyObservation } from "../../src/evolution/strategy-memory.mjs";
import { readCanary } from "../../src/evolution/canary.mjs";
import { suspendEvolution, resumeEvolution } from "../../src/evolution/kill-switch.mjs";
import { RunEvidenceStore } from "../../src/evidence/run-evidence-store.mjs";

const ROOTS = [];
function freshDir(label) {
  const d = mkdtempSync(join(tmpdir(), `evol-po-${label}-`));
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

function policyInput(overrides = {}) {
  return {
    policy_name: "proposal-only-repair-test",
    scope_patterns: ["lib/**"],
    forbidden_patterns: [],
    strategy_dimensions_allowed: [
      "MODEL_ROUTING", "DECOMPOSITION", "CONTEXT_ALLOCATION",
      "RETRY_REPAIR", "FANOUT_PARALLELISM", "TOOL_SELECTION",
    ],
    allowed_commands: ["node", "git"],
    validation_plan_id: "proposal-only-validation",
    validation_plan: { commands: [{ cmd: "node", args: ["-e", "process.exit(0)"], timeout_ms: 30000 }] },
    budget: { max_mutation_runs: 8, max_wall_clock_ms_per_run: 120000, max_evolutions_per_window: 8, window_ms: 86400000 },
    issued_by: "test-operator",
    authorization_ref: "test://proposal-only",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

// ── REAL durable evidence journal helpers ──────────────────────────────────

function writeJournal(root, executionId, events) {
  const store = new RunEvidenceStore({
    root, executionId,
    chainId: `chain-${executionId}`, checkpointId: `ckpt-${executionId}`,
  });
  store.init();
  for (const e of events) store.appendEvent(e);
  return store;
}

/** Three repairs on one phase — the minimum the trigger floor requires. */
function repairs(n, phase = "P1", payload = {}) {
  return Array.from({ length: n }, (_, i) => ({
    event_type: "PHASE_REPAIR_REQUESTED",
    stage: "phase",
    phase_id: phase,
    attempt: i,
    payload,
  }));
}

/** The exact adversarial shape the admission audit measured (§3.1). */
const SYNTHETIC_REPAIRS = repairs(3, "PS", { synthetic: true, test_only: true });
const TEST_ONLY_REPAIRS = repairs(3, "PT", { test_only: true });
const REAL_REPAIRS = repairs(3, "PR");
const TERMINAL_PASS = { event_type: "RUN_PASSED", stage: "terminal", payload: {} };

const FULL_EVIDENCE = {
  affected_files: { score: 1, reasons: ["single file"] },
  affected_subsystems: { score: 0, reasons: ["none"] },
  dependency_depth: { score: 0, reasons: ["no deps"] },
  ambiguity: { score: 0, reasons: ["exact"] },
  expected_execution_steps: { score: 0, reasons: ["one edit"] },
  verification_burden: { score: 0, reasons: ["no tests"] },
  external_dependencies: { score: 0, reasons: ["none"] },
  concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 0, reasons: ["revert 1 file"] },
};

let admissionSeq = 0;
function frozenAdmission(taskId) {
  admissionSeq += 1;
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one bounded retry constant") });
  return freezeAdmission(buildAdmissionRecord({
    taskId: taskId ?? `EVOL-PO-${admissionSeq}`,
    classification: c,
    mutationScope: ["lib/"],
  }));
}

function journalingRunner({ terminalEvents, verdict = "PASS" }) {
  return async (opts) => {
    const enc = opts?.budget?.enforcement;
    if (enc) {
      const gate = enc.preDispatch({ executionId: "g", phase_id: "P1", nodeId: "P1", attempt: 0, runtime: { mode: "readonly", limits: { timeoutMs: 60000 } } });
      if (gate.ok) enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
    }
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

/** ONE production run through the real entrypoint. */
async function productionRun({
  store, checkpointRoot, repoRoot, terminalEvents, label,
  verdict = "PASS", evolutionOverrides = null,
}) {
  const evidenceRoot = freshDir(`ev-${label}`);
  const executionId = `exec_${createHash("sha256").update(label).digest("hex").slice(0, 32)}`;
  const r = await runAdmittedGraph({
    admission: frozenAdmission(),
    runner: journalingRunner({ terminalEvents, verdict }),
    persistence: { root: evidenceRoot, executionId },
    ir: { phases: [] },
    evolution: {
      storeRoot: store, checkpointRoot, repoRoot,
      reviewerIdentity: "reviewer:proposal-only",
      ...(evolutionOverrides ?? {}),
    },
  });
  return { result: r, evidenceRoot, executionId };
}

function outcomesFor(triggerId) {
  return evolutionConsumerState().outcomes.filter((o) => o.trigger_id === triggerId);
}

async function drainFor(triggerId) {
  await drainEvolutionCycles({ timeoutMs: 120000 });
  const mine = outcomesFor(triggerId);
  for (const o of mine) {
    assert.ok(
      EVOLUTION_CONSUMER_OUTCOME_DISPOSITIONS.includes(o.disposition),
      `${o.disposition} is not a declared cycle outcome disposition`,
    );
    if (o.disposition === "CYCLE_COMPLETED") {
      assert.ok(EVOLUTION_LOOP_VERDICTS.includes(o.loop_verdict), `${o.loop_verdict} is not a declared loop verdict`);
    }
  }
  return mine;
}

/** §B/§I strategy memory seeding — production-written attention records. */
const ROUTE_ROWS = Object.freeze([
  { providerKind: "deepseek", modelId: "deepseek-v4-flash", adapterKind: "pi-builtin", requiredEnvKeys: [] },
  { providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash", adapterKind: "pi-builtin", requiredEnvKeys: [] },
]);
const DEEPSEEK = ROUTE_ROWS[0];
const GLM = ROUTE_ROWS[1];

let seedSeq = 0;
function seedRun(storeRoot, { taskClass, route, outcome, repairs: repairCount, label }) {
  seedSeq += 1;
  const base = Date.now() - 60 * 60 * 1000;
  let tick = 0;
  const stamp = (e) => ({ ...e, timestamp: new Date(base + tick++ * 1000).toISOString() });
  const events = [];
  events.push({ event_type: "PHASE_STARTED", stage: "phase", phase_id: "P0", payload: {} });
  for (let i = 0; i < repairCount; i++) {
    events.push({ event_type: "PHASE_REPAIR_REQUESTED", stage: "phase", phase_id: "P0", attempt: i + 1, payload: {} });
  }
  events.push({ event_type: outcome === "PASS" ? "PHASE_PASSED" : "PHASE_HELD", stage: "phase", phase_id: "P0", payload: {} });
  events.push({ event_type: outcome === "PASS" ? "RUN_PASSED" : "RUN_HELD", stage: "terminal", payload: {} });
  const stamped = events.map(stamp);
  const attribution = deriveAttribution({
    events: stamped,
    admittedBinding: route,
    taskClass,
    executionId: `exec_${createHash("sha256").update(label).digest("hex").slice(0, 32)}`,
    graphRunId: `g-${label}`,
  });
  const observation = buildStrategyObservation({ attribution, evidenceRefs: stamped.map((_, i) => `evt_seed_${seedSeq}_${i}`) });
  recordStrategyObservation({ storeRoot, observation });
}

function seedDeficientAndHealthy(storeRoot, taskClass) {
  for (let i = 0; i < 6; i++) {
    seedRun(storeRoot, { taskClass, route: GLM, outcome: "HOLD", repairs: 3, label: `po-glm-${taskClass}-${i}` });
  }
  for (let i = 0; i < 4; i++) {
    seedRun(storeRoot, { taskClass, route: DEEPSEEK, outcome: "PASS", repairs: 0, label: `po-ds-${taskClass}-${i}` });
  }
}

// ══ G1 — SYNTHETIC EVIDENCE TRIGGER FENCE ══════════════════════════════════

test("G1a three synthetic PHASE_REPAIR_REQUESTED cannot enter CYCLE_STARTED", async () => {
  const store = freshDir("g1a-store");
  const checkpointRoot = freshDir("g1a-cp");
  const repo = makeFixtureRepo("g1a-repo");
  createEvolutionPolicy(store, policyInput());

  const { result, executionId } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...SYNTHETIC_REPAIRS, TERMINAL_PASS], label: "g1a",
  });

  // the RUN's own semantics are untouched (fail-open on the normal path)
  assert.equal(result.final, "PASS");
  assert.equal(result.budget.authorized, true);

  // the evidence was READ (so this is a refusal, not a missing journal)…
  assert.equal(result.evolutionObservation.baseline_events, 4);
  // …and REFUSED before any signal was counted
  assert.equal(result.evolutionObservation.evidence_qualified, false);
  assert.match(result.evolutionObservation.evidence_exclusion, /synthetic_evidence:declared_by_evidence_(payload|test_only)/);
  assert.deepEqual(result.evolutionObservation.fired, []);
  assert.equal(result.evolutionObservation.observed, 0);

  // no trigger, no cycle — the consumer sees nothing qualified
  assert.ok(EVOLUTION_CONSUMER_DISPOSITIONS.includes(result.evolutionDisposition.disposition));
  assert.equal(result.evolutionDisposition.disposition, "NO_QUALIFIED_TRIGGER");
  assert.equal(result.evolutionDisposition.cycle_started, false);

  await drainEvolutionCycles({ timeoutMs: 5000 });
  assert.equal(readTriggerState(store).triggers.length, 0, "no durable trigger recorded");
  assert.equal(existsSync(candidateStorePath(store)), false, "no candidate store was created");

  // the every-run feed still excludes it with ITS named disposition (no regression)
  assert.equal(result.strategyAttribution.disposition, "SYNTHETIC_RECORD");
  assert.equal(result.strategyAttribution.recorded, false);
  assert.ok(executionId);
});

test("G1b test_only evidence is refused the same way", async () => {
  const store = freshDir("g1b-store");
  const checkpointRoot = freshDir("g1b-cp");
  const repo = makeFixtureRepo("g1b-repo");
  createEvolutionPolicy(store, policyInput());

  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...TEST_ONLY_REPAIRS, TERMINAL_PASS], label: "g1b",
  });
  assert.equal(result.final, "PASS");
  assert.equal(result.evolutionObservation.evidence_qualified, false);
  assert.equal(result.evolutionObservation.evidence_exclusion, "synthetic_evidence:declared_by_evidence_test_only");
  assert.deepEqual(result.evolutionObservation.fired, []);
  assert.equal(result.evolutionDisposition.disposition, "NO_QUALIFIED_TRIGGER");
  await drainEvolutionCycles({ timeoutMs: 5000 });
  assert.equal(readTriggerState(store).triggers.length, 0);
});

test("G1c a deployment that DECLARES itself synthetic fires nothing, even on real-looking evidence", async () => {
  const store = freshDir("g1c-store");
  const checkpointRoot = freshDir("g1c-cp");
  const repo = makeFixtureRepo("g1c-repo");
  createEvolutionPolicy(store, policyInput());

  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...REAL_REPAIRS, TERMINAL_PASS], label: "g1c",
    evolutionOverrides: { synthetic: true },
  });
  assert.equal(result.final, "PASS");
  assert.equal(result.evolutionObservation.evidence_qualified, false);
  assert.equal(result.evolutionObservation.evidence_exclusion, "synthetic_evidence:declared_by_deployment");
  assert.deepEqual(result.evolutionObservation.fired, []);
  assert.equal(result.evolutionDisposition.disposition, "NO_QUALIFIED_TRIGGER");
  assert.equal(result.strategyAttribution.disposition, "SYNTHETIC_RECORD");
  await drainEvolutionCycles({ timeoutMs: 5000 });
  assert.equal(readTriggerState(store).triggers.length, 0);
  assert.equal(existsSync(candidateStorePath(store)), false);
});

test("G1d real qualified evidence beyond the floor still enters the normal path (no regression)", async () => {
  const store = freshDir("g1d-store");
  const checkpointRoot = freshDir("g1d-cp");
  const repo = makeFixtureRepo("g1d-repo");
  createEvolutionPolicy(store, policyInput());

  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...REAL_REPAIRS, TERMINAL_PASS], label: "g1d",
  });
  assert.equal(result.final, "PASS");
  assert.equal(result.evolutionObservation.evidence_qualified, true);
  assert.equal(result.evolutionObservation.evidence_exclusion, null);
  assert.ok(result.evolutionObservation.fired.length > 0, "real evidence fires");
  assert.equal(result.evolutionDisposition.disposition, "CYCLE_STARTED");

  const outcomes = await drainFor(result.evolutionDisposition.trigger_id);
  assert.equal(outcomes.length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes[0].disposition, "CYCLE_COMPLETED");
  // the point here is that the TRIGGER path was NOT gated by the evidence
  // fence: the loop ran, reached a candidate stage and failed closed honestly
  // (this deployment declares no task class, so no strategy memory exists).
  assert.equal(outcomes[0].loop_verdict, "HOLD");
  assert.equal(outcomes[0].cycle.stage, "candidate");
  assert.equal(outcomes[0].cycle.hold_code, EVOLUTION_LOOP_HOLD.CANDIDATE_INCONCLUSIVE);
  assert.equal(readTriggerState(store).triggers.length, 1, "the durable trigger exists for real evidence");
});

test("G1e the self-deriving loop entry refuses synthetic evidence before trigger evaluation", async () => {
  const store = freshDir("g1e-store");
  const repo = makeFixtureRepo("g1e-repo");
  createEvolutionPolicy(store, policyInput());
  const stamped = [...SYNTHETIC_REPAIRS, TERMINAL_PASS].map((e, i) => ({
    ...e, event_id: `evt_${i + 1}_${"a".repeat(16)}`, sequence: i + 1,
    timestamp: new Date().toISOString(),
  }));
  const out = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("g1e-cp"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: stamped, fingerprint: null,
  });
  assert.equal(out.loop_verdict, "HOLD");
  assert.equal(out.hold_code, EVOLUTION_LOOP_HOLD.EVIDENCE_UNQUALIFIED);
  assert.equal(out.stage, "evidence");
  assert.equal(readTriggerState(store).triggers.length, 0, "no trigger recorded for synthetic evidence");
});

// ══ G2 — DURABLE PROPOSAL PERSISTENCE ══════════════════════════════════════

test("G2a a production strategy proposal is durable, digest-bound and restart-readable", async () => {
  const store = freshDir("g2a-store");
  const checkpointRoot = freshDir("g2a-cp");
  const repo = makeFixtureRepo("g2a-repo");
  createEvolutionPolicy(store, policyInput());
  seedDeficientAndHealthy(store, "PROP");

  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...REAL_REPAIRS, { event_type: "RUN_HELD", stage: "terminal", payload: { reason: "HOLD / C3B_MUTATION_FAILED" } }],
    verdict: "HOLD", label: "g2a",
    evolutionOverrides: { taskClass: "PROP" },
  });
  assert.equal(result.final, "HOLD");
  assert.equal(result.evolutionDisposition.disposition, "CYCLE_STARTED", JSON.stringify(result.evolutionDisposition));

  const outcomes = await drainFor(result.evolutionDisposition.trigger_id);
  assert.equal(outcomes.length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes[0].disposition, "CYCLE_COMPLETED");
  assert.equal(outcomes[0].loop_verdict, "PROMOTED", JSON.stringify(outcomes[0].cycle));
  const candidateId = outcomes[0].cycle.candidate_id;
  assert.match(candidateId, /^ecand_[0-9a-f]{40}$/);

  // THE ARTIFACT: exactly one candidate, in the EXISTING governed store
  const files = readdirSync(candidateStorePath(store)).filter((f) => f.endsWith(".json"));
  assert.deepEqual(files, [`${candidateId}.json`]);
  const stored = JSON.parse(readFileSync(candidateFilePath(store, candidateId), "utf8"));
  assert.equal(stored.candidate_kind, "AGENT_STRATEGY");
  assert.equal(stored.candidate_id, candidateId);
  assert.equal(stored.status, "DERIVED");
  assert.match(stored.created_at, /^\d{4}-\d{2}-\d{2}T/);
  // the digest re-derives from the STORED content
  assert.equal(digestOf({ ...stored, candidate_digest: undefined }), stored.candidate_digest);
  // the source evidence is bound on the artifact
  assert.ok(stored.evidence_refs.length >= 3, `evidence refs: ${JSON.stringify(stored.evidence_refs)}`);
  assert.ok(stored.evidence_refs.every((e) => /^evt_\d+_[0-9a-f]{16}$/.test(e)));
  assert.equal(stored.trigger_id, outcomes[0].trigger_id);

  // A FRESH PROCESS reads it back and re-derives the same digest.
  const candUrl = new URL("../../src/evolution/candidate.mjs", import.meta.url).href;
  const digestUrl = new URL("../../src/canonical-digest.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { readCandidate } from ${JSON.stringify(candUrl)};
import { digestOf } from ${JSON.stringify(digestUrl)};
const c = readCandidate(${JSON.stringify(store)}, ${JSON.stringify(candidateId)});
console.log(JSON.stringify({
  found: Boolean(c),
  kind: c?.candidate_kind ?? null,
  digest: c?.candidate_digest ?? null,
  rederived: c ? digestOf({ ...c, candidate_digest: undefined }) : null,
  evidence: c?.evidence_refs?.length ?? 0,
}));
`], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const seen = JSON.parse(child.stdout.trim());
  assert.equal(seen.found, true, "the proposal survived the process boundary");
  assert.equal(seen.kind, "AGENT_STRATEGY");
  assert.equal(seen.digest, stored.candidate_digest);
  assert.equal(seen.rederived, stored.candidate_digest);
  assert.ok(seen.evidence >= 3);

  // the operator surface lists it and names the bounded proposal
  const cli = spawnSync(process.execPath, [join(process.cwd(), "scripts", "evolution-operator.mjs"), "--store", store, "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout);
  const entry = report.candidates.find((c) => c.candidate_id === candidateId);
  assert.ok(entry, "the proposal is on the operator surface");
  assert.equal(entry.candidate_kind, "AGENT_STRATEGY");
  assert.equal(entry.mutation.edits.length, 0, "a strategy proposal edits no source");
  assert.equal(entry.mutation.strategy_activation.dimension, "MODEL_ROUTING");
  assert.equal(entry.mutation.strategy_activation.to_value, "deepseek/deepseek-v4-flash");
  assert.equal(entry.promotion.promoted, true);
});

test("G2b a proposal is durable even when the cycle ENDS at a rejection (fitness HOLD)", async () => {
  const store = freshDir("g2b-store");
  const checkpointRoot = freshDir("g2b-cp");
  const repo = makeFixtureRepo("g2b-repo");
  createEvolutionPolicy(store, policyInput());
  seedDeficientAndHealthy(store, "REJ");

  // A plan that is authorized but whose memory arm is too thin to move the
  // metric: the cycle HOLDs at fitness — and the proposal must still exist.
  const plan = {
    schema: "autoloop.evolution-improvement-plan/v1", version: 1,
    plan_id: "eplan_" + "4".repeat(40), kind: "AGENT_STRATEGY",
    dimension: "RETRY_REPAIR", task_class: "REJ", signal_class: "REPEATED_REPAIR_REQUIREMENT",
    problem_signature: "sig-g2b", evidence_refs: ["evt_x"], affected_scope: ["strategy://REJ/RETRY_REPAIR"],
    patch_plan: null,
    strategy_plan: {
      surface: "strategy://REJ/RETRY_REPAIR", dimension: "RETRY_REPAIR", task_class: "REJ",
      from_value: "max_attempt_3", to_value: "max_attempt_4", params: { max_attempts: 4 },
      risk_floor: "LOW", rationale: "bounded retry nudge",
    },
    rationale: "bounded retry nudge", diagnosis: { task_class: "REJ" },
    measurement_plan: { metric: "strategy_success_rate", direction: "increase", task_class: "REJ", dimension: "RETRY_REPAIR", candidate_value: "max_attempt_4", baseline_samples: 4, min_samples: 3 },
  };
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  const out = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot,
    baselineHead, baselineRevision: 1,
    baselineEvents: [...REAL_REPAIRS].map((e, i) => ({
      ...e, event_id: `evt_${i + 1}_${"b".repeat(16)}`, sequence: i + 1, timestamp: new Date().toISOString(),
    })),
    fingerprint: null, plan, taskClass: "REJ",
    reviewerIdentity: "reviewer:proposal-only",
  });
  assert.equal(out.loop_verdict, "HOLD", JSON.stringify(out));
  assert.equal(out.stage, "fitness", JSON.stringify(out));
  assert.equal(out.hold_code, EVOLUTION_LOOP_HOLD.FITNESS_REJECTED);

  const files = readdirSync(candidateStorePath(store)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, "the rejected proposal is still durable");
  const stored = JSON.parse(readFileSync(join(candidateStorePath(store), files[0]), "utf8"));
  assert.equal(stored.candidate_id, out.trace.stages.find((s) => s.stage === "candidate").candidate_id);
  assert.equal(digestOf({ ...stored, candidate_digest: undefined }), stored.candidate_digest);
});

test("G2c the same event retried twice yields ONE proposal (identity idempotency)", async () => {
  const store = freshDir("g2c-store");
  const checkpointRoot = freshDir("g2c-cp");
  const repo = makeFixtureRepo("g2c-repo");
  createEvolutionPolicy(store, policyInput());
  seedDeficientAndHealthy(store, "IDEM");

  const events = [...REAL_REPAIRS].map((e, i) => ({
    ...e, event_id: `evt_${i + 1}_${"c".repeat(16)}`, sequence: i + 1, timestamp: new Date().toISOString(),
  }));
  // ONE pre-gated trigger, injected exactly like the production consumer does
  // (the loop does not re-derive or re-gate it), used by BOTH runs.
  const trigger = {
    schema: "autoloop.evolution-trigger/v1",
    trigger_id: "evt_idem",
    signal_class: "REPEATED_REPAIR_REQUIREMENT",
    signature: "sig-idem",
    count: 3,
    min_count: 3,
    evidence_refs: events.map((e) => e.event_id),
    observation: {},
  };
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  const cycle = (proposalOnly) => runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot,
    baselineHead, baselineRevision: 1,
    baselineEvents: events, fingerprint: null, taskClass: "IDEM",
    triggerEvent: trigger,
    reviewerIdentity: "reviewer:proposal-only", proposalOnly,
  });

  const once = await cycle(true);
  assert.equal(once.loop_verdict, "PROPOSAL_RECORDED", JSON.stringify(once));
  const filesAfterFirst = readdirSync(candidateStorePath(store)).filter((f) => f.endsWith(".json"));
  assert.equal(filesAfterFirst.length, 1);

  // the SAME event retried (a crash/restart replay) must not fan out: the
  // identity is deterministic and the write is exclusive-create.
  const second = await cycle(true);
  assert.equal(second.loop_verdict, "PROPOSAL_RECORDED", JSON.stringify(second));
  assert.equal(second.candidate_id, once.candidate_id, "the same event keeps one proposal identity");
  // …and the normal mode over the same evidence writes the same artifact too.
  const third = await cycle(false);
  const filesAfterThird = readdirSync(candidateStorePath(store)).filter((f) => f.endsWith(".json"));
  assert.equal(filesAfterThird.length, 1, `duplicate proposals: ${JSON.stringify(filesAfterThird)}`);
  assert.deepEqual(filesAfterThird, filesAfterFirst);
  assert.equal(third.candidate_id, once.candidate_id);
});

test("G2d an unprovable write HOLDs and never claims a proposal", async () => {
  const store = freshDir("g2d-store");
  const checkpointRoot = freshDir("g2d-cp");
  const repo = makeFixtureRepo("g2d-repo");
  createEvolutionPolicy(store, policyInput());
  seedDeficientAndHealthy(store, "NOSPACE");

  // Make the candidate store unCREATABLE: a regular file occupies the path the
  // store directory needs. No write can land there, so the derivation stage
  // must NOT report a created proposal (it must HOLD instead).
  const dir = candidateStorePath(store);
  writeFileSync(dir, "not a directory\n");
  try {
    const out = await runEvolutionCycle({
      repoRoot: repo, policyRoot: store, checkpointRoot,
      baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
      baselineEvents: [...REAL_REPAIRS].map((e, i) => ({
        ...e, event_id: `evt_${i + 1}_${"d".repeat(16)}`, sequence: i + 1, timestamp: new Date().toISOString(),
      })),
      fingerprint: null, taskClass: "NOSPACE",
      reviewerIdentity: "reviewer:proposal-only", proposalOnly: true,
    });
    assert.equal(out.loop_verdict, "HOLD", JSON.stringify(out));
    assert.equal(out.hold_code, EVOLUTION_LOOP_HOLD.CANDIDATE_NOT_PERSISTED);
    assert.equal(out.stage, "proposal");
    assert.equal(out.proposal, undefined, "no proposal record is reported");
    assert.equal(out.trace.stages.some((s) => s.stage === "proposal"), false, "no proposal stage completed");
    assert.equal(readFileSync(dir, "utf8"), "not a directory\n");
  } finally {
    rmSync(dir, { force: true });
  }
});

// ══ G3 — PROPOSAL-ONLY HARD STOP ═══════════════════════════════════════════

test("G3a proposal-only (production path): durable proposal, PROPOSAL_RECORDED, zero downstream stages", async () => {
  const store = freshDir("g3a-store");
  const checkpointRoot = freshDir("g3a-cp");
  const repo = makeFixtureRepo("g3a-repo");
  createEvolutionPolicy(store, policyInput());
  seedDeficientAndHealthy(store, "PO");
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  const strategyGenerationBefore = readStrategyPolicy(store).generation;

  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...REAL_REPAIRS, { event_type: "RUN_HELD", stage: "terminal", payload: { reason: "HOLD / C3B_MUTATION_FAILED" } }],
    verdict: "HOLD", label: "g3a",
    evolutionOverrides: { taskClass: "PO", proposalOnly: true },
  });
  assert.equal(result.final, "HOLD");
  assert.equal(result.evolutionDisposition.disposition, "CYCLE_STARTED");
  assert.equal(result.evolutionDisposition.proposal_only, true);

  const outcomes = await drainFor(result.evolutionDisposition.trigger_id);
  assert.equal(outcomes.length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes[0].disposition, "CYCLE_COMPLETED");
  assert.equal(outcomes[0].loop_verdict, "PROPOSAL_RECORDED", JSON.stringify(outcomes[0].cycle));
  const cycle = outcomes[0].cycle;
  assert.equal(cycle.proposal_only, true);
  assert.equal(cycle.candidate_kind, "AGENT_STRATEGY");
  assert.equal(cycle.proposal.candidate_id, cycle.candidate_id);
  assert.equal(cycle.proposal.candidate_digest, cycle.candidate_digest);

  // downstream stage fields are ABSENT — no fitness, review, commit, canary
  assert.equal(cycle.fitness_digest, null);
  assert.equal(cycle.branch, null);
  assert.equal(cycle.canary, null);
  assert.equal(cycle.strategy_activation, null);

  // and no downstream ARTIFACT exists
  assert.equal(existsSync(join(store, "reviews")), false, "no review artifact");
  assert.equal(existsSync(join(store, "canary")), false, "no canary artifact");
  assert.equal(git(repo, ["branch", "--list", "evolution/*"]), "", "no evolution branch");
  assert.equal(git(repo, ["rev-parse", "HEAD"]), baselineHead);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(readStrategyPolicy(store).generation, strategyGenerationBefore, "no strategy activation");
  assert.equal(resolveRoutePreference({ storeRoot: store, taskClass: "PO" }), null);
  assert.equal(readCanary(store, cycle.candidate_id), null);
  // no mutation authorization / execution directory was ever created
  assert.equal(readdirSync(checkpointRoot).length, 0, "the mutation boundary was never entered");

  // the proposal is readable and its digest re-derives
  const stored = readCandidate(store, cycle.candidate_id);
  assert.ok(stored, "the proposal is durable");
  assert.equal(digestOf({ ...stored, candidate_digest: undefined }), cycle.candidate_digest);
  assert.ok(stored.evidence_refs.length >= 3);

  // the run's own normal path stays exactly the run's
  assert.equal(result.budget.authorized, true);
});

test("G3b the loop's stage trace proves proposal-only stopped before authorization", async () => {
  const store = freshDir("g3b-store");
  const checkpointRoot = freshDir("g3b-cp");
  const repo = makeFixtureRepo("g3b-repo");
  createEvolutionPolicy(store, policyInput());
  seedDeficientAndHealthy(store, "TRACE");

  const out = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot,
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: [...REAL_REPAIRS].map((e, i) => ({
      ...e, event_id: `evt_${i + 1}_${"e".repeat(16)}`, sequence: i + 1, timestamp: new Date().toISOString(),
    })),
    fingerprint: null, taskClass: "TRACE",
    reviewerIdentity: "reviewer:proposal-only", proposalOnly: true,
  });
  assert.equal(out.loop_verdict, "PROPOSAL_RECORDED", JSON.stringify(out));
  const stages = out.trace.stages.map((s) => s.stage);
  assert.ok(stages.includes("policy"));
  assert.ok(stages.includes("trigger"));
  assert.ok(stages.includes("candidate"));
  assert.ok(stages.includes("proposal"));
  assert.ok(stages.includes("proposal_only_stop"));
  for (const forbidden of ["authorization", "strategy_stage", "mutation", "fitness", "review", "commit", "canary_open", "strategy_activation"]) {
    assert.ok(!stages.includes(forbidden), `proposal-only entered ${forbidden}: ${JSON.stringify(stages)}`);
  }
  assert.equal(out.promotion_gates, undefined);
  assert.equal(out.fitness, undefined);
  assert.equal(out.review, undefined);
  assert.equal(out.commit, undefined);
});

test("G3c proposal-only OFF preserves the existing veridct set and behaviour (default false)", async () => {
  const store = freshDir("g3c-store");
  const checkpointRoot = freshDir("g3c-cp");
  const repo = makeFixtureRepo("g3c-repo");
  createEvolutionPolicy(store, policyInput());
  seedDeficientAndHealthy(store, "OFF");

  const cfgDefault = resolveEvolutionProductionConfig({
    runnerOpts: { evolution: { storeRoot: store, checkpointRoot, repoRoot: repo } }, env: {},
  });
  assert.equal(cfgDefault.proposalOnly, false, "proposal-only is OFF unless explicitly enabled");
  const cfgDeclaredFalse = resolveEvolutionProductionConfig({
    runnerOpts: { evolution: { storeRoot: store, checkpointRoot, repoRoot: repo } },
    env: { AEGISFLOW_EVOLUTION_PROPOSAL_ONLY: "false" },
  });
  assert.equal(cfgDeclaredFalse.proposalOnly, false);

  // an explicit boolean STOPS the search: a caller that says false cannot be
  // overridden by the broader declaration surface.
  const declPath = join(store, "proposal-only-declaration.json");
  writeFileSync(declPath, JSON.stringify({ storeRoot: store, checkpointRoot, repoRoot: repo, proposalOnly: true }));
  const cfgPinnedOff = resolveEvolutionProductionConfig({
    runnerOpts: { evolution: { storeRoot: store, checkpointRoot, repoRoot: repo, proposalOnly: false } },
    env: { AEGISFLOW_EVOLUTION_PROPOSAL_ONLY: "1" },
  });
  assert.equal(cfgPinnedOff.proposalOnly, false, "an explicit false is never overridden");
  assert.equal(cfgPinnedOff.proposalOnlyInvalid, null);
  const cfgFromDecl = resolveEvolutionProductionConfig({
    runnerOpts: {},
    env: { AEGISFLOW_EVOLUTION_DEPLOYMENT_CONFIG: declPath },
  });
  assert.equal(cfgFromDecl.proposalOnly, true, "the operator declaration enables it");

  const out = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot,
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: [...REAL_REPAIRS].map((e, i) => ({
      ...e, event_id: `evt_${i + 1}_${"f".repeat(16)}`, sequence: i + 1, timestamp: new Date().toISOString(),
    })),
    fingerprint: null, taskClass: "OFF",
    reviewerIdentity: "reviewer:proposal-only",
  });
  // the unchanged normal mode still evaluates and promotes autonomously
  assert.equal(out.loop_verdict, "PROMOTED", JSON.stringify(out));
  assert.equal(out.proposal_only, undefined);
  assert.ok(out.fitness_digest);
  assert.ok(out.promotion_gates);
  // and the proposal was still persisted on the way through
  assert.ok(readCandidate(store, out.candidate_id));
});

test("G3d evidence that is not a durable journal row fails CLOSED under proposal-only", async () => {
  const store = freshDir("g3d-store");
  const checkpointRoot = freshDir("g3d-cp");
  const repo = makeFixtureRepo("g3d-repo");
  createEvolutionPolicy(store, policyInput());
  seedDeficientAndHealthy(store, "HAND");

  // hand-built rows carry no durable event identity: they are not evidence a
  // production proposal may cite.
  const out = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot,
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: REAL_REPAIRS.map((e) => ({ ...e, timestamp: new Date().toISOString() })),
    fingerprint: null, taskClass: "HAND",
    reviewerIdentity: "reviewer:proposal-only", proposalOnly: true,
  });
  assert.equal(out.loop_verdict, "HOLD", JSON.stringify(out));
  assert.equal(out.hold_code, EVOLUTION_LOOP_HOLD.EVIDENCE_UNQUALIFIED);
  assert.equal(out.stage, "evidence");
  const dir = candidateStorePath(store);
  assert.equal(!existsSync(dir) || readdirSync(dir).filter((f) => f.endsWith(".json")).length === 0, true,
    "no proposal was recorded from unverifiable evidence");
});

test("G3e an uninterpretable proposal-only setting fails closed (never a silent mutating run)", async () => {
  const store = freshDir("g3e-store");
  const checkpointRoot = freshDir("g3e-cp");
  const repo = makeFixtureRepo("g3e-repo");
  createEvolutionPolicy(store, policyInput());
  seedDeficientAndHealthy(store, "BADCFG");

  // (a) the runner object carries a non-boolean ceiling
  const cfg = resolveEvolutionProductionConfig({
    runnerOpts: { evolution: { storeRoot: store, checkpointRoot, repoRoot: repo, proposalOnly: "yes" } }, env: {},
  });
  assert.equal(cfg.proposalOnly, false);
  assert.match(cfg.proposalOnlyInvalid, /boolean/);
  // (b) the environment carries an uninterpretable value
  const cfgEnv = resolveEvolutionProductionConfig({
    runnerOpts: { evolution: { storeRoot: store, checkpointRoot, repoRoot: repo } },
    env: { AEGISFLOW_EVOLUTION_PROPOSAL_ONLY: "maybe" },
  });
  assert.equal(cfgEnv.proposalOnly, false);
  assert.match(cfgEnv.proposalOnlyInvalid, /AEGISFLOW_EVOLUTION_PROPOSAL_ONLY/);
  // (c) the loop entry refuses a non-boolean outright
  const out = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot,
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: [], fingerprint: null, proposalOnly: "true",
  });
  assert.equal(out.loop_verdict, "HOLD");
  assert.equal(out.hold_code, EVOLUTION_LOOP_HOLD.PROPOSAL_ONLY_INVALID);
  // (d) the production consumer starts NO cycle on the invalid setting
  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...REAL_REPAIRS, TERMINAL_PASS], label: "g3e",
    evolutionOverrides: { taskClass: "BADCFG", proposalOnly: "yes" },
  });
  assert.equal(result.evolutionDisposition.disposition, "CONFIGURATION_INVALID");
  assert.equal(result.evolutionDisposition.cycle_started, false);
  await drainEvolutionCycles({ timeoutMs: 5000 });
  assert.equal(readTriggerState(store).triggers.length, 0, "no trigger recorded under an invalid setting");
});

test("G3f the kill switch still stops proposal-only before any proposal", async () => {
  const store = freshDir("g3f-store");
  const checkpointRoot = freshDir("g3f-cp");
  const repo = makeFixtureRepo("g3f-repo");
  createEvolutionPolicy(store, policyInput());
  seedDeficientAndHealthy(store, "KILL");
  suspendEvolution(store, { reason: "operator pause" });
  try {
    const suspended = await productionRun({
      store, checkpointRoot, repoRoot: repo,
      terminalEvents: [...REAL_REPAIRS, TERMINAL_PASS], label: "g3f",
      evolutionOverrides: { taskClass: "KILL", proposalOnly: true },
    });
    assert.equal(suspended.result.final, "PASS");
    assert.equal(suspended.result.evolutionDisposition.disposition, "SUSPENDED");
    await drainEvolutionCycles({ timeoutMs: 5000 });
    assert.equal(existsSync(candidateStorePath(store)), false, "suspended: no proposal written");

    // the loop entry refuses too, without writing anything
    const direct = await runEvolutionCycle({
      repoRoot: repo, policyRoot: store, checkpointRoot,
      baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
      baselineEvents: [], fingerprint: null, proposalOnly: true,
    });
    assert.equal(direct.hold_code, EVOLUTION_LOOP_HOLD.SUSPENDED);
  } finally {
    resumeEvolution(store);
  }
});
