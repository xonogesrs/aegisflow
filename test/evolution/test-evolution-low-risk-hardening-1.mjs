// test/evolution/test-evolution-low-risk-hardening-1.mjs
//
// AEGISFLOW_EVOLUTION_LOW_RISK_HARDENING_1 — N1/N2/N3 regression.
//
// Each case pins one finding the independent review left open after TARGETED
// REMEDIATION 2. They drive the REAL machinery (the candidate store, the
// production consumer, the loop) — never a mock of the stage under test.
//
//   N1  an identity conflict must be its own classification, distinct from an
//       index WRITE failure; first-writer-wins is preserved
//   N2  a non-boolean `synthetic` must be REJECTED at every surface (runner
//       object, env incl. the legacy alias, declaration) — never coerced
//   N3  the consumer must re-establish evidence provenance from the durable
//       journal BEFORE any durable trigger write / cooldown / cycle
//
// Run: node --test test/evolution/test-evolution-low-risk-hardening-1.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";

import { createEvolutionPolicy } from "../../src/evolution/policy.mjs";
import { EVOLUTION_LOOP_HOLD, runEvolutionCycle } from "../../src/evolution/loop.mjs";
import {
  candidateFilePath, candidateStorePath, derivationIndexPath, derivationKey,
  indexDerivation, persistCandidate, readCandidate, proposalContentDigest,
  EVOLUTION_CANDIDATE_HOLD,
} from "../../src/evolution/candidate.mjs";
import { deriveStrategyCandidate } from "../../src/evolution/candidate-strategy.mjs";
import { readStrategyPolicy } from "../../src/evolution/strategy-store.mjs";
import { buildTriggerEvent, readTriggerState } from "../../src/evolution/trigger.mjs";
import {
  consumeEvolutionObservationForProduction, drainEvolutionCycles, evolutionConsumerState,
  resolveEvolutionProductionConfig,
} from "../../src/evolution/production-consumer.mjs";
import { observeRunForEvolutionTriggers } from "../../src/evolution/production-observer.mjs";
import {
  EVOLUTION_DECLARATION_ENV, EVOLUTION_DECLARATION_SCHEMA,
} from "../../src/evolution/production-declaration.mjs";
import { RunEvidenceStore } from "../../src/evidence/run-evidence-store.mjs";
import { digestOf } from "../../src/canonical-digest.mjs";

const ROOTS = [];
function freshDir(label) {
  const d = mkdtempSync(join(tmpdir(), `evol-lrh1-${label}-`));
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
    policy_name: "low-risk-hardening-1-test",
    scope_patterns: ["lib/**"],
    forbidden_patterns: [],
    strategy_dimensions_allowed: ["MODEL_ROUTING", "RETRY_REPAIR"],
    allowed_commands: ["node", "git"],
    validation_plan_id: "lrh1-validation",
    validation_plan: { commands: [{ cmd: "node", args: ["-e", "process.exit(0)"], timeout_ms: 30000 }] },
    budget: { max_mutation_runs: 8, max_wall_clock_ms_per_run: 120000, max_evolutions_per_window: 8, window_ms: 86400000 },
    issued_by: "test-operator",
    authorization_ref: "test://low-risk-hardening-1",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

// ── durable evidence helpers (the only shape the fence accepts) ─────────────

function writeJournal(root, executionId, events) {
  const store = new RunEvidenceStore({
    root, executionId,
    chainId: `chain-${executionId}`, checkpointId: `ckpt-${executionId}`,
  });
  store.init();
  for (const e of events) store.appendEvent(e);
  return store;
}

function repairs(n, phase = "P1", payload = {}) {
  return Array.from({ length: n }, (_, i) => ({
    event_type: "PHASE_REPAIR_REQUESTED",
    stage: "phase",
    phase_id: phase,
    attempt: i,
    payload,
    timestamp: new Date().toISOString(),
  }));
}

function durableRepairs(n, phase = "P1", nonce = "a") {
  return repairs(n, phase).map((e, i) => ({ ...e, event_id: `evt_${i + 1}_${nonce.repeat(16)}`, sequence: i + 1 }));
}

function indexKeys(store) {
  const p = derivationIndexPath(store);
  if (!existsSync(p)) return [];
  return Object.keys(JSON.parse(readFileSync(p, "utf8")).derivations ?? {});
}

const SIGNATURE = "sig-low-risk-hardening";

function strategyPlan({ params, from, to }) {
  return {
    schema: "autoloop.evolution-improvement-plan/v1", version: 1,
    plan_id: "eplan_" + "5".repeat(40), kind: "AGENT_STRATEGY",
    dimension: "MODEL_ROUTING", task_class: "FAM",
    signal_class: "REPEATED_REPAIR_REQUIREMENT", problem_signature: SIGNATURE,
    evidence_refs: ["evt_1_" + "a".repeat(16)],
    affected_scope: ["strategy://FAM/MODEL_ROUTING"], patch_plan: null,
    strategy_plan: {
      surface: "strategy://FAM/MODEL_ROUTING", dimension: "MODEL_ROUTING", task_class: "FAM",
      from_value: from, to_value: to,
      params, risk_floor: "LOW", rationale: "bounded routing",
    },
    rationale: "bounded routing", diagnosis: { task_class: "FAM" },
    measurement_plan: { metric: "strategy_success_rate", direction: "increase", task_class: "FAM", dimension: "MODEL_ROUTING", baseline_samples: 4, min_samples: 3 },
  };
}

const PLAN_A = () => strategyPlan({
  params: { route: "deepseek/deepseek-v4-flash" },
  from: "merge-gateway/zai/glm-5.3-flash",
  to: "deepseek/deepseek-v4-flash",
});
const PLAN_B = () => strategyPlan({
  params: { route: "merge-gateway/zai/glm-5.3-flash" },
  from: "deepseek/deepseek-v4-flash",
  to: "merge-gateway/zai/glm-5.3-flash",
});

function triggerFor(baselineHead, triggerId = "evt_lrh1") {
  return {
    schema: "autoloop.evolution-trigger/v1",
    trigger_id: triggerId,
    signal_class: "REPEATED_REPAIR_REQUIREMENT",
    signature: SIGNATURE,
    count: 3, min_count: 3,
    evidence_refs: ["evt_1_" + "a".repeat(16), "evt_2_" + "a".repeat(16), "evt_3_" + "a".repeat(16)],
    observation: {},
  };
}

function persistedStrategy(store, plan, baselineHead) {
  const { candidate } = deriveStrategyCandidate({
    plan,
    triggerEvent: triggerFor(baselineHead),
    baselineHead, baselineRevision: 1, strategyPolicy: readStrategyPolicy(store),
  });
  return candidate;
}

// ══ N1 — IDENTITY CONFLICT IS NOT AN INDEX WRITE FAILURE ═══════════════════
//
// Before this hardening, a competing candidate for an identity the index
// already owned was reported as PERSIST_FAILED / INDEX_WRITE_FAILED, which
// sends the operator to inspect storage. Nothing was unwritable: the index
// simply refused to repoint an owner.

test("N1 the store classifies an identity conflict separately from an index write failure", () => {
  const store = freshDir("n1a-store");
  createEvolutionPolicy(store, policyInput());
  const baselineHead = "e".repeat(40);
  const first = persistedStrategy(store, PLAN_A(), baselineHead);
  const second = persistedStrategy(store, PLAN_B(), baselineHead);
  assert.notEqual(first.candidate_id, second.candidate_id, "the two plans are distinct candidates");

  persistCandidate(store, first);
  const key = derivationKey("AGENT_STRATEGY", SIGNATURE, baselineHead);

  // (a) CONFLICT — the index is healthy and refuses to repoint the owner.
  let conflict = null;
  try {
    persistCandidate(store, second);
  } catch (e) {
    conflict = e;
  }
  assert.ok(conflict, "a competing identity must fail closed");
  assert.equal(conflict.code, EVOLUTION_CANDIDATE_HOLD.CANDIDATE_CONFLICT, String(conflict?.message));
  assert.equal(conflict.details.conflict.kind, "different_candidate");
  assert.equal(conflict.details.conflict.owner_id, first.candidate_id);
  assert.equal(conflict.details.conflict.key, key);
  assert.equal(conflict.details.artifact_durable, true, "the competing artifact is durable; the INDEX refused it");
  assert.notEqual(conflict.code, EVOLUTION_CANDIDATE_HOLD.INDEX_WRITE_FAILED);

  // First writer wins: the index and the owner's artifact are untouched.
  const idx = JSON.parse(readFileSync(derivationIndexPath(store), "utf8"));
  assert.equal(idx.derivations[key], first.candidate_id, "the owner is never repointed");
  const owner = readCandidate(store, first.candidate_id);
  assert.equal(proposalContentDigest(owner), proposalContentDigest(first), "the owner's artifact is byte-identical");

  // The store-level classification also survives a direct index attempt.
  const direct = indexDerivation(store, second);
  assert.equal(direct.status, "CONFLICT");
  assert.equal(direct.code, EVOLUTION_CANDIDATE_HOLD.CANDIDATE_CONFLICT);

  // (b) WRITE FAILURE — the SAME store shape with an unwritable index path is
  // the OTHER fact, and still reports the artifact as durable.
  const blocked = freshDir("n1a2-store");
  createEvolutionPolicy(blocked, policyInput());
  const candidate = persistedStrategy(blocked, PLAN_A(), baselineHead);
  mkdirSync(derivationIndexPath(blocked), { recursive: true });
  let writeFailure = null;
  try {
    persistCandidate(blocked, candidate);
  } catch (e) {
    writeFailure = e;
  }
  assert.ok(writeFailure);
  assert.equal(writeFailure.code, EVOLUTION_CANDIDATE_HOLD.INDEX_WRITE_FAILED);
  assert.equal(writeFailure.details.artifact_durable, true);
  assert.notEqual(writeFailure.code, EVOLUTION_CANDIDATE_HOLD.CANDIDATE_CONFLICT);
});

test("N1 a same-id artifact with different content is a conflict (not a write failure), and replays stay idempotent", () => {
  const store = freshDir("n1b-store");
  createEvolutionPolicy(store, policyInput());
  const baselineHead = "f".repeat(40);
  const candidate = persistedStrategy(store, PLAN_A(), baselineHead);
  persistCandidate(store, candidate);

  // Idempotency is preserved: the same candidate is an EXISTING no-op.
  const replay = persistCandidate(store, candidate);
  assert.equal(replay.status, "EXISTING");
  assert.equal(replay.index.indexed, true);

  // A different immutable proposal under the SAME id fails closed as a conflict.
  const forged = { ...candidate, measurement_plan: { ...candidate.measurement_plan, min_samples: 99 } };
  forged.candidate_digest = digestOf({ ...forged, candidate_digest: undefined });
  let conflict = null;
  try {
    persistCandidate(store, forged);
  } catch (e) {
    conflict = e;
  }
  assert.ok(conflict);
  assert.equal(conflict.code, EVOLUTION_CANDIDATE_HOLD.CANDIDATE_CONFLICT);
  assert.equal(conflict.details.conflict.kind, "different_content");
  assert.equal(conflict.details.conflict.owner_id, candidate.candidate_id);
  assert.equal(readCandidate(store, candidate.candidate_id).candidate_digest, candidate.candidate_digest,
    "the first write remains the durable authority");
});

test("N1 the LOOP reports CANDIDATE_CONFLICT (not NOT_INDEXED / NOT_PERSISTED) and keeps the owner", async () => {
  const store = freshDir("n1c-store");
  const repo = makeFixtureRepo("n1c-repo");
  createEvolutionPolicy(store, policyInput());
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  const events = durableRepairs(3, "P0", "c");
  const trigger = triggerFor(baselineHead);

  const first = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("n1c-cp"),
    baselineHead, baselineRevision: 1, baselineEvents: events, fingerprint: null,
    triggerEvent: trigger, plan: PLAN_A(), taskClass: "FAM",
    reviewerIdentity: "reviewer:independent", proposalOnly: true,
  });
  assert.equal(first.loop_verdict, "PROPOSAL_RECORDED", JSON.stringify(first));

  const second = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("n1c-cp2"),
    baselineHead, baselineRevision: 1, baselineEvents: events, fingerprint: null,
    triggerEvent: trigger, plan: PLAN_B(), taskClass: "FAM",
    reviewerIdentity: "reviewer:independent", proposalOnly: true,
  });
  assert.equal(second.loop_verdict, "HOLD", JSON.stringify(second));
  assert.equal(second.hold_code, EVOLUTION_LOOP_HOLD.CANDIDATE_CONFLICT, JSON.stringify(second));
  assert.equal(second.stage, "proposal");
  assert.equal(second.conflict?.kind, "different_candidate", JSON.stringify(second.conflict));
  assert.equal(second.conflict?.owner_id, first.candidate_id);
  assert.equal(second.artifact_durable, true, "the competing proposal landed; only the identity was refused");
  assert.equal(second.proposal, undefined, "a conflicted identity is never claimed as recorded");
  assert.notEqual(second.hold_code, EVOLUTION_LOOP_HOLD.CANDIDATE_NOT_INDEXED);
  assert.notEqual(second.hold_code, EVOLUTION_LOOP_HOLD.CANDIDATE_NOT_PERSISTED);

  // The owner is still the operator-visible derivation, untouched.
  const idx = JSON.parse(readFileSync(derivationIndexPath(store), "utf8"));
  assert.equal(idx.derivations[derivationKey("AGENT_STRATEGY", SIGNATURE, baselineHead)], first.candidate_id);
  assert.equal(readCandidate(store, first.candidate_id).candidate_digest, first.candidate_digest);
  // Nothing downstream ran for the refused cycle.
  assert.equal(second.trace.stages.some((s) => s.stage === "authorization"), false);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
});

// ══ N2 — SYNTHETIC CONFIGURATION TYPING ════════════════════════════════════
//
// A value whose TYPE is unusable used to fall through silently, reading a
// malformed configuration as "production evidence". It must be rejected at
// every surface, with no implicit conversion.

test("N2 a non-boolean synthetic is rejected on the runner object", () => {
  const store = freshDir("n2a-store");
  const checkpointRoot = freshDir("n2a-cp");
  const repo = makeFixtureRepo("n2a-repo");
  const base = { storeRoot: store, checkpointRoot, repoRoot: repo };

  for (const bad of ["true", "false", 1, 0, null, {}, []]) {
    const cfg = resolveEvolutionProductionConfig({
      runnerOpts: { evolution: { ...base, synthetic: bad } }, env: {},
    });
    assert.match(cfg.configurationInvalid ?? "", /synthetic must be a boolean/,
      `synthetic=${JSON.stringify(bad)} must be rejected`);
    assert.equal(cfg.synthetic, false, "an unusable value never means 'synthetic'");
  }

  // legal booleans keep their exact behaviour
  const off = resolveEvolutionProductionConfig({ runnerOpts: { evolution: { ...base, synthetic: false } }, env: {} });
  assert.equal(off.configurationInvalid, null);
  assert.equal(off.synthetic, false);
  const on = resolveEvolutionProductionConfig({ runnerOpts: { evolution: { ...base, synthetic: true } }, env: {} });
  assert.equal(on.configurationInvalid, null);
  assert.equal(on.synthetic, true);
});

test("N2 a non-boolean synthetic is rejected in the environment (brand and legacy names)", () => {
  const store = freshDir("n2b-store");
  const checkpointRoot = freshDir("n2b-cp");
  const repo = makeFixtureRepo("n2b-repo");
  const runnerOpts = { evolution: { storeRoot: store, checkpointRoot, repoRoot: repo } };

  for (const bad of ["yes", "2", "TRUE!", "on"]) {
    const cfg = resolveEvolutionProductionConfig({ runnerOpts, env: { AEGISFLOW_EVOLUTION_SYNTHETIC: bad } });
    assert.match(cfg.configurationInvalid ?? "", /AEGISFLOW_EVOLUTION_SYNTHETIC/,
      `env=${bad} must be rejected`);
    assert.equal(cfg.synthetic, false);
  }
  // A non-STRING env value is not "unset": the shared reader ignores it, and
  // treating that silence as production evidence is the N2 defect.
  for (const bad of [1, 0, null, {}, []]) {
    const cfg = resolveEvolutionProductionConfig({ runnerOpts, env: { AEGISFLOW_EVOLUTION_SYNTHETIC: bad } });
    assert.match(cfg.configurationInvalid ?? "", /AEGISFLOW_EVOLUTION_SYNTHETIC must be 1\/true\/0\/false \(got/,
      `env=${JSON.stringify(bad)} must be rejected, not read as unset`);
    assert.equal(cfg.synthetic, false);
  }
  // the pre-rename alias is the SAME surface (one reader, no second convention)
  const legacy = resolveEvolutionProductionConfig({ runnerOpts, env: { AUTOLOOP_EVOLUTION_SYNTHETIC: "maybe" } });
  assert.match(legacy.configurationInvalid ?? "", /AUTOLOOP_EVOLUTION_SYNTHETIC/,
    "a malformed LEGACY value is rejected, and the message names the variable actually set");
  assert.equal(legacy.synthetic, false);
  // ...including a non-string value under the legacy name
  const legacyTyped = resolveEvolutionProductionConfig({ runnerOpts, env: { AUTOLOOP_EVOLUTION_SYNTHETIC: {} } });
  assert.match(legacyTyped.configurationInvalid ?? "", /AUTOLOOP_EVOLUTION_SYNTHETIC/);
  assert.equal(legacyTyped.synthetic, false);
  // Precedence is the documented one: a usable BRAND value wins and the legacy
  // name is never consulted (the two are never merged). So a malformed legacy
  // value cannot break a deployment that sets the brand name, and a malformed
  // brand value is still rejected when the legacy name is legal.
  const brandWins = resolveEvolutionProductionConfig({
    runnerOpts, env: { AEGISFLOW_EVOLUTION_SYNTHETIC: "0", AUTOLOOP_EVOLUTION_SYNTHETIC: 1 },
  });
  assert.equal(brandWins.configurationInvalid, null, "the unused legacy name is not consulted");
  assert.equal(brandWins.synthetic, false);
  const brandBad = resolveEvolutionProductionConfig({
    runnerOpts, env: { AEGISFLOW_EVOLUTION_SYNTHETIC: 1, AUTOLOOP_EVOLUTION_SYNTHETIC: "0" },
  });
  assert.match(brandBad.configurationInvalid ?? "", /AEGISFLOW_EVOLUTION_SYNTHETIC/,
    "a malformed brand value is not laundered by a legal legacy value");
  assert.equal(brandBad.synthetic, false);

  for (const [value, expected] of [["1", true], ["true", true], ["0", false], ["false", false]]) {
    const cfg = resolveEvolutionProductionConfig({ runnerOpts, env: { AEGISFLOW_EVOLUTION_SYNTHETIC: value } });
    assert.equal(cfg.configurationInvalid, null, `env=${value} is legal`);
    assert.equal(cfg.synthetic, expected, `env=${value}`);
  }
});

test("N2 a non-boolean synthetic is rejected in the deployment declaration", () => {
  const store = freshDir("n2c-store");
  const checkpointRoot = freshDir("n2c-cp");
  const repo = makeFixtureRepo("n2c-repo");
  const dir = freshDir("n2c-decl");
  const base = { schema: EVOLUTION_DECLARATION_SCHEMA, storeRoot: store, checkpointRoot, repoRoot: repo };

  const badPath = join(dir, "bad.json");
  writeFileSync(badPath, JSON.stringify({ ...base, synthetic: "true" }));
  const bad = resolveEvolutionProductionConfig({ runnerOpts: {}, env: { [EVOLUTION_DECLARATION_ENV]: badPath } });
  assert.match(bad.configurationInvalid ?? "", /synthetic/);
  assert.equal(bad.synthetic, false);

  const goodPath = join(dir, "good.json");
  writeFileSync(goodPath, JSON.stringify({ ...base, synthetic: true }));
  const good = resolveEvolutionProductionConfig({ runnerOpts: {}, env: { [EVOLUTION_DECLARATION_ENV]: goodPath } });
  assert.equal(good.configurationInvalid, null);
  assert.equal(good.synthetic, true);
});

// ── production-run helpers (the real entrypoint) ───────────────────────────

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
  return freezeAdmission(buildAdmissionRecord({
    taskId: taskId ?? `EVOL-LRH1-${admissionSeq}`,
    classification: classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("bounded fix") }),
    mutationScope: ["lib/"],
  }));
}

function journalingRunner({ terminalEvents }) {
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
      final: "PASS",
      executionId,
      nodeResults: [{ nodeId: "P1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } }],
      transitions: [],
      closeout: { applied: false },
      admission: opts?.admission ?? null,
    };
  };
}

async function productionRun({ store, checkpointRoot, repoRoot, terminalEvents, label, evolutionOverrides = null }) {
  const evidenceRoot = freshDir(`ev-${label}`);
  const executionId = `exec_${createHash("sha256").update(label).digest("hex").slice(0, 32)}`;
  const r = await runAdmittedGraph({
    admission: frozenAdmission(),
    runner: journalingRunner({ terminalEvents }),
    persistence: { root: evidenceRoot, executionId },
    ir: { phases: [] },
    evolution: { storeRoot: store, checkpointRoot, repoRoot, ...(evolutionOverrides ?? {}) },
  });
  return { result: r, evidenceRoot, executionId };
}

test("N2 an unusable synthetic starts ZERO cycles and performs ZERO mutation (end to end)", async () => {
  const store = freshDir("n2d-store");
  const repo = makeFixtureRepo("n2d-repo");
  createEvolutionPolicy(store, policyInput());
  const before = git(repo, ["status", "--porcelain"]);
  const head = git(repo, ["rev-parse", "HEAD"]);

  const { result } = await productionRun({
    store, checkpointRoot: freshDir("n2d-cp"), repoRoot: repo,
    terminalEvents: [...repairs(3, "PR"), { event_type: "RUN_PASSED", stage: "terminal", payload: {} }],
    label: "n2d",
    evolutionOverrides: { synthetic: "yes" },
  });
  assert.equal(result.final, "PASS", "normal operation is never affected");
  assert.equal(result.evolutionDisposition.disposition, "CONFIGURATION_INVALID", JSON.stringify(result.evolutionDisposition));
  assert.equal(result.evolutionDisposition.cycle_started, false);
  assert.match(result.evolutionDisposition.reason ?? "", /synthetic must be a boolean/);

  const outcomes = evolutionConsumerState().outcomes.filter((o) => o.trigger_id === result.evolutionDisposition.trigger_id);
  assert.equal(outcomes.length, 0, "no cycle outcome exists");
  assert.equal(readTriggerState(store).triggers.length, 0, "no trigger recorded");
  assert.equal(existsSync(join(store, "evolution-trigger-state.json")), false, "no trigger state written");
  assert.equal(existsSync(candidateStorePath(store)), false, "no candidate written");
  assert.equal(git(repo, ["status", "--porcelain"]), before);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
});

// ══ N3 — CONSUMER EVIDENCE GUARD ═══════════════════════════════════════════
//
// The consumer used to trust `observation.evidence_qualified` — a field on an
// object its caller hands in. The first repair re-read the journal and required
// each signal to cite a row the journal actually held, but that only proved the
// ROW existed: a forged signal could cite a genuine row while claiming a
// signature, count, class or patch the row does not support, and still write a
// durable trigger, spend the signature's cooldown and seed a candidate with an
// unverified patch.
//
// The consumer now RE-DERIVES the eligible signals from the durable journal
// (`extractTriggerObservations` + `evaluateSignals`, the same two functions the
// observer used) and accepts a caller claim only when it is canonically
// identical to a derived one. Downstream acts on the DERIVED records.
//
// Every case below asserts DURABLE side effects, not just the verdict.

function consumerConfig({ store, checkpointRoot, repoRoot }) {
  return resolveEvolutionProductionConfig({ runnerOpts: { evolution: { storeRoot: store, checkpointRoot, repoRoot } }, env: {} });
}

/** A real, qualified journal (3 repairs on one phase) plus the observation the
 *  production observer derives from it. */
function realJournalObservation({ label, payload = {} }) {
  const evidenceRoot = freshDir(`${label}-ev`);
  const executionId = `exec_${createHash("sha256").update(label).digest("hex").slice(0, 32)}`;
  const journal = writeJournal(evidenceRoot, executionId, repairs(3, "P0", payload));
  const rows = [];
  const head = journal.verifyJournal();
  for (let s = 1; s <= head.count; s++) rows.push(journal.readEvent(s).event);
  const observation = observeRunForEvolutionTriggers({ evidenceRoot, executionId, graphRunId: label });
  return { evidenceRoot, executionId, rows, observation };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Assert the N3 refusal left ZERO durable trace. */
function assertNoDurableTrace(store, out, reason) {
  assert.equal(out.disposition, "NO_QUALIFIED_TRIGGER", JSON.stringify(out));
  assert.equal(out.cycle_started, false);
  assert.equal(out.evidence_qualified, false);
  assert.equal(out.evidence_reverified, true);
  assert.match(out.reason, reason, JSON.stringify(out.reason));
  assert.equal(existsSync(join(store, "evolution-trigger-state.json")), false, "0 durable trigger records / 0 cooldown consumption");
  assert.equal(existsSync(candidateStorePath(store)), false, "0 candidate artifacts");
  assert.equal(existsSync(join(store, "evolution-cycles")), false, "0 cycle locks (no production cycle activation)");
}

test("N3 the real journal derives the signal the consumer accepts (the baseline for A–D)", async () => {
  const store = freshDir("n3-base-store");
  const repo = makeFixtureRepo("n3-base-repo");
  createEvolutionPolicy(store, policyInput());
  const config = consumerConfig({ store, checkpointRoot: freshDir("n3-base-cp"), repoRoot: repo });
  const { evidenceRoot, executionId, observation } = realJournalObservation({ label: "n3-base" });

  assert.equal(observation.evidence_qualified, true);
  assert.equal(observation.fired.length, 1, JSON.stringify(observation.fired));
  assert.equal(observation.fired[0].signalClass, "REPEATED_REPAIR_REQUIREMENT");

  const out = consumeEvolutionObservationForProduction({ observation, config, evidenceRoot, executionId });
  assert.equal(out.disposition, "CYCLE_STARTED", JSON.stringify(out));
  await drainEvolutionCycles({ timeoutMs: 120000 });
});

// ── A: real row + forged SIGNATURE ─────────────────────────────────────────
test("N3-A a real journal row with a FORGED signature is refused and writes nothing", () => {
  const store = freshDir("n3A-store");
  const repo = makeFixtureRepo("n3A-repo");
  createEvolutionPolicy(store, policyInput());
  const config = consumerConfig({ store, checkpointRoot: freshDir("n3A-cp"), repoRoot: repo });
  const { evidenceRoot, executionId, observation } = realJournalObservation({ label: "n3A" });

  // The reviewer's exploit shape: the REAL rows, a REAL class, a REAL count —
  // only the signature is invented (it becomes the cooldown key).
  const forged = clone(observation);
  forged.fired[0].signature = "sig-forged-by-caller";
  const out = consumeEvolutionObservationForProduction({ observation: forged, config, evidenceRoot, executionId });
  assertNoDurableTrace(store, out, /does not match the journal-derived signal \(signature\)/);
});

// ── B: real row + forged COUNT ─────────────────────────────────────────────
test("N3-B a real journal row with a FORGED count is refused and writes nothing", () => {
  const store = freshDir("n3B-store");
  const repo = makeFixtureRepo("n3B-repo");
  createEvolutionPolicy(store, policyInput());
  const config = consumerConfig({ store, checkpointRoot: freshDir("n3B-cp"), repoRoot: repo });
  const { evidenceRoot, executionId, observation } = realJournalObservation({ label: "n3B" });

  const forged = clone(observation);
  forged.fired[0].count = 99;
  const out = consumeEvolutionObservationForProduction({ observation: forged, config, evidenceRoot, executionId });
  assertNoDurableTrace(store, out, /does not match the journal-derived signal \(count\)/);
});

// ── C: real row + forged CLASS ─────────────────────────────────────────────
test("N3-C a real journal row with a FORGED class is refused and writes nothing", () => {
  const store = freshDir("n3C-store");
  const repo = makeFixtureRepo("n3C-repo");
  createEvolutionPolicy(store, policyInput());
  const config = consumerConfig({ store, checkpointRoot: freshDir("n3C-cp"), repoRoot: repo });
  const { evidenceRoot, executionId, observation } = realJournalObservation({ label: "n3C" });

  // A derivable class the journal does NOT derive from this evidence (no HOLDs).
  const forged = clone(observation);
  forged.fired[0].signalClass = "RECURRING_HOLD_PATTERN";
  const out = consumeEvolutionObservationForProduction({ observation: forged, config, evidenceRoot, executionId });
  assertNoDurableTrace(store, out, /was not derived from the durable journal/);
});

// ── D: real row + forged PATCH ─────────────────────────────────────────────
test("N3-D a forged patchPlan is never written into a durable candidate", async () => {
  const store = freshDir("n3D-store");
  const repo = makeFixtureRepo("n3D-repo");
  createEvolutionPolicy(store, policyInput());
  const config = consumerConfig({ store, checkpointRoot: freshDir("n3D-cp"), repoRoot: repo });
  const FORGED_PATCH = "--- a/lib/retry.ts\n+++ b/lib/retry.ts\n@@\n-export const MAX_RETRIES = 3;\n+export const MAX_RETRIES = 99;\n";
  const { evidenceRoot, executionId, observation } = realJournalObservation({ label: "n3D" });

  // The journal carries NO patch, so no patch may travel to a candidate.
  const forged = clone(observation);
  forged.fired[0].observation = { patchPlan: { patch: FORGED_PATCH }, affectedScope: ["lib/retry.ts"] };
  const out = consumeEvolutionObservationForProduction({ observation: forged, config, evidenceRoot, executionId });
  assertNoDurableTrace(store, out, /does not match the journal-derived signal \(patchPlan\)/);

  // Not even after a cycle: the store holds no candidate and no artifact cites
  // the forged patch.
  const candidates = existsSync(candidateStorePath(store))
    ? readdirSync(candidateStorePath(store)).filter((f) => f.endsWith(".json"))
    : [];
  assert.deepEqual(candidates, [], "0 candidate artifacts");
  for (const f of candidates) {
    assert.equal(readFileSync(join(candidateStorePath(store), f), "utf8").includes("MAX_RETRIES = 99"), false);
  }
  assert.equal(git(repo, ["status", "--porcelain"]), "", "the repo is untouched");
});

test("N3-D a patch the JOURNAL carries travels into the candidate (provenance, not refusal)", async () => {
  const store = freshDir("n3D2-store");
  const repo = makeFixtureRepo("n3D2-repo");
  createEvolutionPolicy(store, policyInput());
  const config = consumerConfig({ store, checkpointRoot: freshDir("n3D2-cp"), repoRoot: repo });
  const JOURNAL_PATCH = "--- a/lib/retry.ts\n+++ b/lib/retry.ts\n@@\n-export const MAX_RETRIES = 3;\n+export const MAX_RETRIES = 5;\n";
  const { evidenceRoot, executionId, observation } = realJournalObservation({
    label: "n3D2",
    payload: { patch_plan: { patch: JOURNAL_PATCH }, affected_scope: ["lib/retry.ts"] },
  });

  // The journal itself carries the patch, so the derived signal carries it too.
  assert.equal(observation.fired[0].observation.patchPlan.patch, JOURNAL_PATCH);

  const out = consumeEvolutionObservationForProduction({ observation, config, evidenceRoot, executionId });
  assert.equal(out.disposition, "CYCLE_STARTED", JSON.stringify(out));
  const state = readTriggerState(store);
  assert.equal(state.triggers.length, 1);
  assert.equal(state.triggers[0].observation.patchPlan.patch, JOURNAL_PATCH,
    "the durable trigger carries the JOURNAL's patch");
  await drainEvolutionCycles({ timeoutMs: 120000 });

  // A caller that swaps the patch on an otherwise-correct signal is refused
  // even though the same journal row is cited.
  const store2 = freshDir("n3D3-store");
  createEvolutionPolicy(store2, policyInput());
  const config2 = consumerConfig({ store: store2, checkpointRoot: freshDir("n3D3-cp"), repoRoot: repo });
  const swapped = clone(observation);
  swapped.fired[0].observation.patchPlan.patch = JOURNAL_PATCH.replace("= 5;", "= 99;");
  const refused = consumeEvolutionObservationForProduction({ observation: swapped, config: config2, evidenceRoot, executionId });
  assertNoDurableTrace(store2, refused, /does not match the journal-derived signal \(patchPlan\)/);
});

// ── E: forge then real — the forgery must not spend the cooldown ───────────
test("N3-E a refused forgery consumes NO cooldown: the real signal still fires afterwards", async () => {
  const store = freshDir("n3E-store");
  const repo = makeFixtureRepo("n3E-repo");
  createEvolutionPolicy(store, policyInput());
  const config = consumerConfig({ store, checkpointRoot: freshDir("n3E-cp"), repoRoot: repo });
  const { evidenceRoot, executionId, observation } = realJournalObservation({ label: "n3E" });

  // Forge the signature FIRST (the cooldown key the caller controls).
  const forged = clone(observation);
  forged.fired[0].signature = "sig-forged-first";
  const refused = consumeEvolutionObservationForProduction({ observation: forged, config, evidenceRoot, executionId });
  assertNoDurableTrace(store, refused, /does not match the journal-derived signal \(signature\)/);

  // The real signal over the SAME store must still reach the gate un-suppressed.
  const real = consumeEvolutionObservationForProduction({ observation, config, evidenceRoot, executionId });
  assert.equal(real.disposition, "CYCLE_STARTED", `the forgery spent the cooldown: ${JSON.stringify(real)}`);
  assert.equal(readTriggerState(store).triggers.length, 1, "exactly one durable trigger, from the real signal");
  await drainEvolutionCycles({ timeoutMs: 120000 });
});

// ── F: real journal + correctly derived signal → normal trigger ────────────
test("N3-F a real journal with the correctly derived signal fires normally (no over-fencing)", async () => {
  const store = freshDir("n3F-store");
  const repo = makeFixtureRepo("n3F-repo");
  createEvolutionPolicy(store, policyInput());
  const config = consumerConfig({ store, checkpointRoot: freshDir("n3F-cp"), repoRoot: repo });
  const { evidenceRoot, executionId, rows, observation } = realJournalObservation({ label: "n3F" });

  const out = consumeEvolutionObservationForProduction({ observation, config, evidenceRoot, executionId });
  assert.equal(out.disposition, "CYCLE_STARTED", JSON.stringify(out));
  assert.equal(out.cycle_started, true);

  const state = readTriggerState(store);
  assert.equal(state.triggers.length, 1, "the verified signal recorded its durable trigger");
  assert.deepEqual(state.triggers[0].evidence_refs, rows.map((e) => e.event_id).sort(),
    "the durable trigger cites the journal's own rows");
  assert.equal(out.signal_class, "REPEATED_REPAIR_REQUIREMENT");
  await drainEvolutionCycles({ timeoutMs: 120000 });
});

// ── G: the classes the consumer cannot re-derive stay refused ──────────────
test("N3-G a caller-supplied class the journal cannot re-derive is refused (pattern / baseline classes)", () => {
  const store = freshDir("n3G-store");
  const repo = makeFixtureRepo("n3G-repo");
  createEvolutionPolicy(store, policyInput());
  const config = consumerConfig({ store, checkpointRoot: freshDir("n3G-cp"), repoRoot: repo });
  const { evidenceRoot, executionId, observation } = realJournalObservation({ label: "n3G" });

  for (const [signalClass, pattern] of [
    ["QUALIFIED_PATTERN_EVIDENCE", /QUALIFIED_PATTERN_EVIDENCE cannot be re-established/],
    ["LATENCY_REGRESSION", /LATENCY_REGRESSION cannot be re-established/],
    ["TOKEN_INEFFICIENCY", /TOKEN_INEFFICIENCY cannot be re-established/],
  ]) {
    const forged = clone(observation);
    forged.fired[0].signalClass = signalClass;
    const out = consumeEvolutionObservationForProduction({ observation: forged, config, evidenceRoot, executionId });
    assertNoDurableTrace(store, out, pattern);
  }
});

// ── G2: a caller cannot OMIT a derived signal to pick the cooldown key ─────
test("N3-G2 a caller that reports FEWER signals than the journal derives is refused", () => {
  const store = freshDir("n3G2-store");
  const repo = makeFixtureRepo("n3G2-repo");
  createEvolutionPolicy(store, policyInput());
  const config = consumerConfig({ store, checkpointRoot: freshDir("n3G2-cp"), repoRoot: repo });

  // 5 repairs derive TWO classes (REPEATED_REPAIR_REQUIREMENT and the
  // retry-volume class); claiming only one is a caller-side edit of what
  // qualifies.
  const evidenceRoot = freshDir("n3G2-ev");
  const executionId = `exec_${createHash("sha256").update("n3G2").digest("hex").slice(0, 32)}`;
  writeJournal(evidenceRoot, executionId, repairs(5, "P0"));
  const observation = observeRunForEvolutionTriggers({ evidenceRoot, executionId, graphRunId: "n3G2" });
  assert.deepEqual(
    observation.fired.map((s) => s.signalClass).sort(),
    ["ABNORMAL_RETRY_FREQUENCY", "REPEATED_REPAIR_REQUIREMENT"],
    JSON.stringify(observation.fired),
  );

  const truncated = clone(observation);
  truncated.fired = truncated.fired.slice(0, 1);
  const out = consumeEvolutionObservationForProduction({ observation: truncated, config, evidenceRoot, executionId });
  assertNoDurableTrace(store, out, /journal derives 2/);
});
