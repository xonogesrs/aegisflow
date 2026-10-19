// test/evolution/test-evolution-targeted-remediation-2.mjs
//
// AEGISFLOW_EVOLUTION_PROPOSAL_ONLY_TARGETED_REMEDIATION_2 — F1–F5 regression.
//
// Every case below pins a defect the independent review REPRODUCED against
// 23cbe67. Each one drives the REAL production machinery (runAdmittedGraph →
// durable journal → observer → consumer → runEvolutionCycle, or the real
// candidate store), never a mock of the stage under test.
//
//   F1  unqualified evidence must not consume a durable trigger/cooldown slot
//   F2  an unusable `proposalOnly` declaration must never fall back to the
//       MUTATING mode (boolean typing, unknown keys, env/file precedence)
//   F3  strategy and source candidates must not alias one derivation-index key
//       (both orders)
//   F4  an index-write failure must be classified as "durable but not indexed",
//       never as "not persisted", and a retry must repair it
//   F5  the self-deriving path applies the SAME provenance rule as production
//
// Run: node --test test/evolution/test-evolution-targeted-remediation-2.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync,
} from "node:fs";
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
import { buildTriggerEvent, readTriggerState } from "../../src/evolution/trigger.mjs";
import {
  drainEvolutionCycles, evolutionConsumerState, resolveEvolutionProductionConfig,
} from "../../src/evolution/production-consumer.mjs";
import {
  EVOLUTION_DECLARATION_ENV, EVOLUTION_DECLARATION_SCHEMA,
  readEvolutionProductionDeclaration, readDeclaredProposalOnly,
  validateEvolutionDeclaration,
} from "../../src/evolution/production-declaration.mjs";
import { deriveAttribution } from "../../src/evolution/attribution.mjs";
import { buildStrategyObservation, recordStrategyObservation } from "../../src/evolution/strategy-memory.mjs";
import { readStrategyPolicy } from "../../src/evolution/strategy-store.mjs";
import { RunEvidenceStore } from "../../src/evidence/run-evidence-store.mjs";
import { digestOf } from "../../src/canonical-digest.mjs";

const ROOTS = [];
function freshDir(label) {
  const d = mkdtempSync(join(tmpdir(), `evol-tr2-${label}-`));
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
    policy_name: "targeted-remediation-2-test",
    scope_patterns: ["lib/**"],
    forbidden_patterns: [],
    strategy_dimensions_allowed: ["MODEL_ROUTING", "RETRY_REPAIR"],
    allowed_commands: ["node", "git"],
    validation_plan_id: "tr2-validation",
    validation_plan: { commands: [{ cmd: "node", args: ["-e", "process.exit(0)"], timeout_ms: 30000 }] },
    budget: { max_mutation_runs: 8, max_wall_clock_ms_per_run: 120000, max_evolutions_per_window: 8, window_ms: 86400000 },
    issued_by: "test-operator",
    authorization_ref: "test://targeted-remediation-2",
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

/** A hand-built array with NO durable journal identity (event id + sequence). */
function repairs(n, phase = "P1") {
  return Array.from({ length: n }, (_, i) => ({
    event_type: "PHASE_REPAIR_REQUESTED",
    stage: "phase",
    phase_id: phase,
    attempt: i,
    payload: {},
    timestamp: new Date().toISOString(),
  }));
}

/** The same rows, stamped exactly as RunEvidenceStore stamps them. */
function durableRepairs(n, phase = "P1", nonce = "a") {
  return repairs(n, phase).map((e, i) => ({
    ...e, event_id: `evt_${i + 1}_${nonce.repeat(16)}`, sequence: i + 1,
  }));
}

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
    taskId: taskId ?? `EVOL-TR2-${admissionSeq}`,
    classification: classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("bounded fix") }),
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

async function productionRun({ store, checkpointRoot, repoRoot, terminalEvents, label, opts = {} }) {
  const evidenceRoot = freshDir(`ev-${label}`);
  const executionId = `exec_${createHash("sha256").update(label).digest("hex").slice(0, 32)}`;
  const r = await runAdmittedGraph({
    admission: frozenAdmission(),
    runner: journalingRunner({ terminalEvents, verdict: "PASS" }),
    persistence: { root: evidenceRoot, executionId },
    ir: { phases: [] },
    ...opts,
  });
  return r;
}

async function drainFor(triggerId) {
  await drainEvolutionCycles({ timeoutMs: 120000 });
  return evolutionConsumerState().outcomes.filter((o) => o.trigger_id === triggerId);
}

function indexKeys(store) {
  const p = derivationIndexPath(store);
  if (!existsSync(p)) return [];
  return Object.keys(JSON.parse(readFileSync(p, "utf8")).derivations ?? {});
}

// ══ F1 — UNQUALIFIED EVIDENCE MUST NOT CONSUME THE COOLDOWN ════════════════
//
// Before the fix, the loop applied only the DECLARED-synthetic rule and then
// gates + recorded + wrote trigger state for a hand-built array. The
// signature's `lastFiredAt` was spent, so the NEXT (real, durable) signal for
// the same signature was suppressed as `cooldown` — a fixture silently blocked
// a production trigger.

test("F1 unqualified evidence is refused BEFORE any durable trigger write and consumes no cooldown", async () => {
  const store = freshDir("f1-store");
  const repo = makeFixtureRepo("f1-repo");
  createEvolutionPolicy(store, policyInput());

  // (a) hand-built rows: refused at the evidence stage, nothing written.
  const refused = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f1-cp"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: repairs(3, "P1"), fingerprint: null,
  });
  assert.equal(refused.loop_verdict, "HOLD", JSON.stringify(refused));
  assert.equal(refused.hold_code, EVOLUTION_LOOP_HOLD.EVIDENCE_UNQUALIFIED);
  assert.equal(refused.stage, "evidence");
  assert.equal(refused.evidence_exclusion, "untrusted_evidence_row");
  assert.deepEqual(refused.trace.stages.map((s) => s.stage), ["policy"], "no trigger stage was entered");
  assert.equal(readTriggerState(store).triggers.length, 0, "no durable trigger recorded");
  assert.equal(existsSync(join(store, "evolution-trigger-state.json")), false, "no trigger state written at all");
  assert.equal(indexKeys(store).length, 0, "no derivation was recorded");
  assert.equal(existsSync(candidateStorePath(store)), false, "no candidate artifact");

  // (b) THE CONSEQUENCE THAT WAS THE BUG: the same signature still fires for
  // real evidence immediately afterwards — the refused run spent no cooldown
  // and no window slot.
  const real = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f1-cp2"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: durableRepairs(3, "P1", "b"), fingerprint: null,
  });
  assert.notEqual(real.hold_code, "HOLD / EVOLUTION_LOOP_TRIGGER_GATED",
    `real evidence was gated by the refused run: ${JSON.stringify(real)}`);
  assert.ok(real.trace.stages.some((s) => s.stage === "trigger"), "the real run reached the trigger stage");
  assert.equal(readTriggerState(store).triggers.length, 1, "the real evidence recorded exactly one trigger");
});

test("F1 the refused run is reported as HOLD with the provenance reason (never NO_TRIGGER)", async () => {
  const store = freshDir("f1b-store");
  const repo = makeFixtureRepo("f1b-repo");
  createEvolutionPolicy(store, policyInput());
  const empty = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f1b-cp"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: [], fingerprint: null,
  });
  assert.equal(empty.hold_code, EVOLUTION_LOOP_HOLD.EVIDENCE_UNQUALIFIED);
  assert.equal(empty.evidence_exclusion, "no_evidence_rows");
  // a row that is not an object is refused the same way, never read as "quiet"
  const junk = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f1b-cp2"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: [null], fingerprint: null,
  });
  assert.equal(junk.hold_code, EVOLUTION_LOOP_HOLD.EVIDENCE_UNQUALIFIED);
});

// ══ F2 — DECLARATION FAIL-CLOSED ═══════════════════════════════════════════
//
// The reviewed defect: `readEvolutionProductionDeclaration` discarded the WHOLE
// record when ANY key failed validation, and the resolver then read
// `decl.proposalOnly` from the discarded (empty) inputs. An operator's
// `proposalOnly:true` beside an unrelated typo therefore became `false` and the
// loop ran in the MUTATING mode — an authority ceiling lost to a typo.

function writeDeclaration(path, record) {
  writeFileSync(path, JSON.stringify(record, null, 2));
  return path;
}

function declBase(store, checkpointRoot, repo) {
  return { storeRoot: store, checkpointRoot, repoRoot: repo };
}

test("F2 a declared ceiling SURVIVES an unrelated invalid key (never fails open to mutation)", () => {
  const store = freshDir("f2-store");
  const checkpointRoot = freshDir("f2-cp");
  const repo = makeFixtureRepo("f2-repo");
  const dir = freshDir("f2-decl");
  const path = join(dir, "decl.json");

  // the declaration is invalid (unknown key) AND declares the ceiling
  writeDeclaration(path, { ...declBase(store, checkpointRoot, repo), proposalOnly: true, task_class: "typo" });
  const read = readEvolutionProductionDeclaration({ path, env: {} });
  assert.equal(read.provided, true);
  assert.equal(read.declaration, null, "the record as a whole is not usable");
  assert.ok(read.record, "the RAW record is still available to the resolver");
  assert.match(read.errors.join(";"), /unknown_task_class/);

  const cfg = resolveEvolutionProductionConfig({ runnerOpts: {}, env: { [EVOLUTION_DECLARATION_ENV]: path } });
  assert.equal(cfg.proposalOnly, true, "the operator's ceiling is not lost to an unrelated typo");
  assert.equal(cfg.declaration.valid, false);
  assert.equal(cfg.declaration.readable, true);
  assert.equal(cfg.declaration.proposalOnly, true);
  // and the deployment is INVALID overall: it must not run at all
  assert.ok(cfg.configurationInvalid, "an unusable declaration is a governed-configuration failure");
  assert.equal(cfg.enabled, false);
});

test("F2 a non-boolean ceiling fails closed (runner object, env, and declaration)", () => {
  const store = freshDir("f2b-store");
  const checkpointRoot = freshDir("f2b-cp");
  const repo = makeFixtureRepo("f2b-repo");
  const dir = freshDir("f2b-decl");

  // (a) declaration carries a non-boolean
  const p1 = writeDeclaration(join(dir, "a.json"), { ...declBase(store, checkpointRoot, repo), proposalOnly: "yes" });
  const a = resolveEvolutionProductionConfig({ runnerOpts: {}, env: { [EVOLUTION_DECLARATION_ENV]: p1 } });
  assert.equal(a.proposalOnly, false);
  assert.match(a.configurationInvalid, /must be a boolean/);
  assert.equal(a.enabled, false);

  // (b) declaration carries an integer, not a boolean
  const p2 = writeDeclaration(join(dir, "b.json"), { ...declBase(store, checkpointRoot, repo), proposalOnly: 1 });
  const b = resolveEvolutionProductionConfig({ runnerOpts: {}, env: { [EVOLUTION_DECLARATION_ENV]: p2 } });
  assert.equal(b.proposalOnly, false);
  assert.match(b.configurationInvalid, /must be a boolean/);
  assert.equal(validateEvolutionDeclaration({ proposalOnly: 1 }).includes("proposalOnly_invalid"), true);

  // (c) the runner object
  const c = resolveEvolutionProductionConfig({
    runnerOpts: { evolution: { ...declBase(store, checkpointRoot, repo), proposalOnly: "false" } }, env: {},
  });
  assert.equal(c.proposalOnly, false);
  assert.match(c.proposalOnlyInvalid, /must be a boolean/);

  // (d) the environment
  const d = resolveEvolutionProductionConfig({
    runnerOpts: { evolution: declBase(store, checkpointRoot, repo) },
    env: { AEGISFLOW_EVOLUTION_PROPOSAL_ONLY: "maybe" },
  });
  assert.equal(d.proposalOnly, false);
  assert.match(d.proposalOnlyInvalid, /AEGISFLOW_EVOLUTION_PROPOSAL_ONLY/);

  // (e) an unparsable declaration cannot silently mean OFF
  const p5 = join(dir, "e.json");
  writeFileSync(p5, "{ this is not json");
  const e = resolveEvolutionProductionConfig({ runnerOpts: {}, env: { [EVOLUTION_DECLARATION_ENV]: p5 } });
  assert.equal(e.declaration.readable, false);
  assert.equal(e.enabled, false);
  assert.ok(e.configurationInvalid, "an unreadable declaration is not 'no declaration'");
});

test("F2 precedence is explicit: runnerOpts > env > declaration, and an explicit boolean stops the search", () => {
  const store = freshDir("f2c-store");
  const checkpointRoot = freshDir("f2c-cp");
  const repo = makeFixtureRepo("f2c-repo");
  const dir = freshDir("f2c-decl");
  const declaredTrue = writeDeclaration(join(dir, "on.json"), {
    schema: EVOLUTION_DECLARATION_SCHEMA, ...declBase(store, checkpointRoot, repo), proposalOnly: true,
  });
  const declaredFalse = writeDeclaration(join(dir, "off.json"), {
    schema: EVOLUTION_DECLARATION_SCHEMA, ...declBase(store, checkpointRoot, repo), proposalOnly: false,
  });

  // declaration alone
  const fromDecl = resolveEvolutionProductionConfig({ runnerOpts: {}, env: { [EVOLUTION_DECLARATION_ENV]: declaredTrue } });
  assert.equal(fromDecl.proposalOnly, true);
  assert.equal(fromDecl.configurationInvalid, null);

  // env beats the declaration
  const envOff = resolveEvolutionProductionConfig({
    runnerOpts: {}, env: { [EVOLUTION_DECLARATION_ENV]: declaredTrue, AEGISFLOW_EVOLUTION_PROPOSAL_ONLY: "0" },
  });
  assert.equal(envOff.proposalOnly, false, "an explicit env 0 overrides a declared true");

  // runnerOpts beats env
  const objOff = resolveEvolutionProductionConfig({
    runnerOpts: { evolution: { proposalOnly: false } },
    env: { [EVOLUTION_DECLARATION_ENV]: declaredTrue, AEGISFLOW_EVOLUTION_PROPOSAL_ONLY: "1" },
  });
  assert.equal(objOff.proposalOnly, false, "an explicit object false is never overridden");

  // a declared FALSE is honoured: an absent narrower surface does not raise it
  const declOff = resolveEvolutionProductionConfig({ runnerOpts: {}, env: { [EVOLUTION_DECLARATION_ENV]: declaredFalse } });
  assert.equal(declOff.proposalOnly, false);
  assert.equal(declOff.configurationInvalid, null);

  // the raw-record helper is the single reader of the ceiling
  assert.deepEqual(readDeclaredProposalOnly({ proposalOnly: true }), { present: true, value: true, error: null });
  assert.deepEqual(readDeclaredProposalOnly({}), { present: false, value: null, error: null });
  assert.equal(readDeclaredProposalOnly({ proposalOnly: "true" }).error !== null, true);
  assert.deepEqual(readDeclaredProposalOnly(null), { present: false, value: null, error: null });
});

test("F2 an illegal declaration starts ZERO cycles and performs ZERO mutation", async () => {
  const store = freshDir("f2d-store");
  const checkpointRoot = freshDir("f2d-cp");
  const repo = makeFixtureRepo("f2d-repo");
  const dir = freshDir("f2d-decl");
  createEvolutionPolicy(store, policyInput());

  const cases = [
    ["non-boolean ceiling", { ...declBase(store, checkpointRoot, repo), proposalOnly: "yes" }],
    ["unknown key with ceiling", { ...declBase(store, checkpointRoot, repo), proposalOnly: true, task_class: "typo" }],
  ];
  for (const [label, record] of cases) {
    const path = writeDeclaration(join(dir, `${label.replace(/\W+/g, "-")}.json`), record);
    const before = git(repo, ["status", "--porcelain"]);
    const head = git(repo, ["rev-parse", "HEAD"]);

    process.env[EVOLUTION_DECLARATION_ENV] = path;
    try {
      const r = await productionRun({
        store, checkpointRoot, repoRoot: repo,
        terminalEvents: [...durableRepairs(3, "PD", "d"), { event_type: "RUN_PASSED", stage: "terminal", payload: {} }],
        label: `f2d-${label.replace(/\W+/g, "-")}`,
      });
      assert.equal(r.final, "PASS", "normal operation is never affected");
      assert.equal(r.evolutionDisposition.disposition, "CONFIGURATION_INVALID", `${label}: ${JSON.stringify(r.evolutionDisposition)}`);
      assert.equal(r.evolutionDisposition.cycle_started, false);
      const outcomes = await drainFor(r.evolutionDisposition.trigger_id ?? "none");
      assert.equal(outcomes.length, 0, `${label}: no cycle outcome may exist`);
    } finally {
      delete process.env[EVOLUTION_DECLARATION_ENV];
    }

    assert.equal(readTriggerState(store).triggers.length, 0, `${label}: no trigger recorded`);
    assert.equal(existsSync(candidateStorePath(store)), false, `${label}: no candidate written`);
    assert.equal(git(repo, ["status", "--porcelain"]), before, `${label}: the repo is untouched`);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), head, `${label}: HEAD unmoved`);
    assert.equal(git(repo, ["branch", "--list", "evolution/*"]), "", `${label}: no evolution branch`);
  }
});

test("F2 a VALID declaration keeps its existing behaviour (no regression)", async () => {
  const store = freshDir("f2e-store");
  const checkpointRoot = freshDir("f2e-cp");
  const repo = makeFixtureRepo("f2e-repo");
  const dir = freshDir("f2e-decl");
  const path = writeDeclaration(join(dir, "ok.json"), {
    schema: EVOLUTION_DECLARATION_SCHEMA,
    declared_by: "operator:test",
    ...declBase(store, checkpointRoot, repo),
    taskClass: "declared",
    proposalOnly: true,
  });
  const cfg = resolveEvolutionProductionConfig({ runnerOpts: {}, env: { [EVOLUTION_DECLARATION_ENV]: path } });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.proposalOnly, true);
  assert.equal(cfg.configurationInvalid, null);
  assert.deepEqual(cfg.declaration.errors, []);
  assert.equal(cfg.declaration.valid, true);
  assert.equal(cfg.taskClass, "DECLARED");
});

// ══ F3 — CANDIDATE FAMILY ISOLATION ════════════════════════════════════════
//
// The reviewed defect: `persistCandidate` (strategy family) and
// `deriveImprovementCandidate` (source family) shared ONE index key,
// `<signature>@<baseline>`. Whichever family wrote first became the answer for
// the other, so the loop returned CANDIDATE_EXISTS for the WRONG family and
// never derived the candidate it was asked for.

const STRATEGY_SIGNATURE = "sig-family-isolation";

function strategyPlan(overrides = {}) {
  return {
    schema: "autoloop.evolution-improvement-plan/v1", version: 1,
    plan_id: "eplan_" + "3".repeat(40), kind: "AGENT_STRATEGY",
    dimension: "MODEL_ROUTING", task_class: "FAM",
    signal_class: "REPEATED_REPAIR_REQUIREMENT", problem_signature: STRATEGY_SIGNATURE,
    evidence_refs: ["evt_1_" + "a".repeat(16)],
    affected_scope: ["strategy://FAM/MODEL_ROUTING"], patch_plan: null,
    strategy_plan: {
      surface: "strategy://FAM/MODEL_ROUTING", dimension: "MODEL_ROUTING", task_class: "FAM",
      from_value: "merge-gateway/zai/glm-5.3-flash", to_value: "deepseek/deepseek-v4-flash",
      params: { route: "deepseek/deepseek-v4-flash" }, risk_floor: "LOW", rationale: "bounded routing",
    },
    rationale: "bounded routing", diagnosis: { task_class: "FAM" },
    measurement_plan: { metric: "strategy_success_rate", direction: "increase", task_class: "FAM", dimension: "MODEL_ROUTING", baseline_samples: 4, min_samples: 3 },
    ...overrides,
  };
}

function sourcePlan() {
  return {
    status: "PLAN",
    plan: {
      schema: "autoloop.evolution-improvement-plan/v1", version: 1,
      plan_id: "eplan_" + "4".repeat(40), kind: "SOURCE_REPAIR",
      dimension: null, task_class: "FAM",
      signal_class: "REPEATED_REPAIR_REQUIREMENT", problem_signature: STRATEGY_SIGNATURE,
      affected_scope: ["lib/retry.ts"],
      patch_plan: { patch: "diff --git a/lib/retry.ts b/lib/retry.ts\n--- a/lib/retry.ts\n+++ b/lib/retry.ts\n@@ -1 +1 @@\n-export const MAX_RETRIES = 3;\n+export const MAX_RETRIES = 4;\n" },
      rationale: "bounded retry repair", diagnosis: { task_class: "FAM" },
    },
  };
}

function triggerFor(baselineHead) {
  return {
    schema: "autoloop.evolution-trigger/v1",
    trigger_id: "evt_family_isolation",
    signal_class: "REPEATED_REPAIR_REQUIREMENT",
    signature: STRATEGY_SIGNATURE,
    count: 3, min_count: 3,
    evidence_refs: ["evt_1_" + "a".repeat(16), "evt_2_" + "a".repeat(16), "evt_3_" + "a".repeat(16)],
    observation: {},
  };
}

function seedAuthority(store) {
  createEvolutionPolicy(store, policyInput());
}

test("F3 the derivation index is FAMILY-QUALIFIED (source key unchanged, strategy namespaced)", () => {
  const store = freshDir("f3a-store");
  const head = "b".repeat(40);
  assert.equal(derivationKey("SOURCE", "sig", head), `sig@${head}`, "the historical SOURCE key is preserved");
  assert.equal(derivationKey("AGENT_STRATEGY", "sig", head), `AGENT_STRATEGY:sig@${head}`);
  assert.notEqual(derivationKey("SOURCE", "sig", head), derivationKey("AGENT_STRATEGY", "sig", head));
});

test("F3 strategy-first then source: BOTH candidates exist, neither aliases the other", async () => {
  const store = freshDir("f3b-store");
  const repo = makeFixtureRepo("f3b-repo");
  seedAuthority(store);
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  const events = durableRepairs(3, "P0", "e");
  const trigger = triggerFor(baselineHead);

  const strategyCycle = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f3b-cp"),
    baselineHead, baselineRevision: 1, baselineEvents: events, fingerprint: null,
    triggerEvent: trigger, plan: strategyPlan(), taskClass: "FAM",
    reviewerIdentity: "reviewer:independent", proposalOnly: true,
  });
  assert.equal(strategyCycle.loop_verdict, "PROPOSAL_RECORDED", JSON.stringify(strategyCycle));
  assert.equal(strategyCycle.candidate_kind, "AGENT_STRATEGY");

  // the SAME signature@baseline, SOURCE family: it must DERIVE, not return the
  // strategy proposal as "already derived".
  const sourceCycle = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f3b-cp2"),
    baselineHead, baselineRevision: 1, baselineEvents: events, fingerprint: null,
    triggerEvent: trigger, plan: sourcePlan(), taskClass: "FAM",
    reviewerIdentity: "reviewer:independent", proposalOnly: true,
  });
  assert.notEqual(sourceCycle.loop_verdict, "CANDIDATE_EXISTS",
    `the source family was aliased to the strategy proposal: ${JSON.stringify(sourceCycle)}`);
  assert.equal(sourceCycle.loop_verdict, "PROPOSAL_RECORDED", JSON.stringify(sourceCycle));
  assert.notEqual(sourceCycle.candidate_id, strategyCycle.candidate_id, "two independent identities");
  assert.equal(sourceCycle.candidate_kind, "SOURCE");

  const strategyOnDisk = readCandidate(store, strategyCycle.candidate_id);
  const sourceOnDisk = readCandidate(store, sourceCycle.candidate_id);
  assert.equal(strategyOnDisk.candidate_kind, "AGENT_STRATEGY");
  assert.equal(sourceOnDisk?.candidate_kind ?? "SOURCE", "SOURCE");
  assert.notEqual(proposalContentDigest(strategyOnDisk), proposalContentDigest(sourceOnDisk));

  assert.deepEqual(
    indexKeys(store).sort(),
    [derivationKey("AGENT_STRATEGY", STRATEGY_SIGNATURE, baselineHead), derivationKey("SOURCE", STRATEGY_SIGNATURE, baselineHead)].sort(),
    "one index entry per candidate FAMILY",
  );
  assert.equal(readdirSync(candidateStorePath(store)).filter((f) => f.endsWith(".json")).length, 2);
});

test("F3 source-first then strategy: BOTH candidates exist (the reverse order)", async () => {
  const store = freshDir("f3c-store");
  const repo = makeFixtureRepo("f3c-repo");
  seedAuthority(store);
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  const events = durableRepairs(3, "P0", "f");
  const trigger = triggerFor(baselineHead);

  const sourceCycle = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f3c-cp"),
    baselineHead, baselineRevision: 1, baselineEvents: events, fingerprint: null,
    triggerEvent: trigger, plan: sourcePlan(), taskClass: "FAM",
    reviewerIdentity: "reviewer:independent", proposalOnly: true,
  });
  assert.equal(sourceCycle.loop_verdict, "PROPOSAL_RECORDED", JSON.stringify(sourceCycle));
  assert.equal(sourceCycle.candidate_kind, "SOURCE");

  const strategyCycle = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f3c-cp2"),
    baselineHead, baselineRevision: 1, baselineEvents: events, fingerprint: null,
    triggerEvent: trigger, plan: strategyPlan(), taskClass: "FAM",
    reviewerIdentity: "reviewer:independent", proposalOnly: true,
  });
  assert.notEqual(strategyCycle.loop_verdict, "CANDIDATE_EXISTS",
    `the strategy family was aliased to the source candidate: ${JSON.stringify(strategyCycle)}`);
  assert.equal(strategyCycle.loop_verdict, "PROPOSAL_RECORDED", JSON.stringify(strategyCycle));
  assert.notEqual(strategyCycle.candidate_id, sourceCycle.candidate_id);
  assert.equal(readCandidate(store, strategyCycle.candidate_id).candidate_kind, "AGENT_STRATEGY");
  assert.equal(readdirSync(candidateStorePath(store)).filter((f) => f.endsWith(".json")).length, 2);
});

test("F3 a legacy unqualified entry pointing at a strategy artifact does not satisfy a SOURCE derivation", async () => {
  const store = freshDir("f3d-store");
  const repo = makeFixtureRepo("f3d-repo");
  seedAuthority(store);
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);

  // A store written by the PREVIOUS build: the strategy proposal occupies the
  // unqualified key the source family reads.
  const { candidate } = deriveStrategyCandidate({
    plan: strategyPlan(),
    triggerEvent: { trigger_id: "evt_legacy", signature: STRATEGY_SIGNATURE, signal_class: "REPEATED_REPAIR_REQUIREMENT", evidence_refs: ["e1"] },
    baselineHead, baselineRevision: 1, strategyPolicy: readStrategyPolicy(store),
  });
  mkdirSync(candidateStorePath(store), { recursive: true });
  writeFileSync(candidateFilePath(store, candidate.candidate_id), JSON.stringify(candidate, null, 2));
  writeFileSync(derivationIndexPath(store), JSON.stringify({
    schema: "autoloop.evolution-candidate/v1", version: 1,
    derivations: { [`${STRATEGY_SIGNATURE}@${baselineHead}`]: candidate.candidate_id },
  }, null, 2));

  const sourceCycle = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f3d-cp"),
    baselineHead, baselineRevision: 1, baselineEvents: durableRepairs(3, "P0", "1"), fingerprint: null,
    triggerEvent: triggerFor(baselineHead), plan: sourcePlan(), taskClass: "FAM",
    reviewerIdentity: "reviewer:independent", proposalOnly: true,
  });
  assert.equal(sourceCycle.loop_verdict, "PROPOSAL_RECORDED", JSON.stringify(sourceCycle));
  assert.equal(sourceCycle.candidate_kind, "SOURCE");
  // The SOURCE family owns the unqualified key, so it RECLAIMS the residue the
  // shared-key build left there — and the legacy strategy ARTIFACT stays on
  // disk, untouched and still readable under its own identity.
  const idx = JSON.parse(readFileSync(derivationIndexPath(store), "utf8"));
  assert.equal(idx.derivations[derivationKey("SOURCE", STRATEGY_SIGNATURE, baselineHead)], sourceCycle.candidate_id,
    "the source family is indexed under its own key");
  assert.equal(idx.derivations[derivationKey("AGENT_STRATEGY", STRATEGY_SIGNATURE, baselineHead)], undefined,
    "the strategy entry is not invented retroactively");
  const legacy = readCandidate(store, candidate.candidate_id);
  assert.equal(legacy?.candidate_kind, "AGENT_STRATEGY", "the legacy artifact is preserved");
  assert.equal(legacy.candidate_digest, candidate.candidate_digest);
});

// ══ F4 — PERSISTENCE ERROR CLASSIFICATION ══════════════════════════════════
//
// The reviewed defect: a failure after the candidate FILE was durable (the
// derivation-index write) surfaced as the generic PERSIST_FAILED, which reads
// as "nothing was persisted". The artifact existed; only the index did not.

function persistedStrategyCandidate(store, baselineHead, salt = "a") {
  const { candidate } = deriveStrategyCandidate({
    plan: strategyPlan(),
    triggerEvent: { trigger_id: `evt_classify_${salt}`, signature: STRATEGY_SIGNATURE, signal_class: "REPEATED_REPAIR_REQUIREMENT", evidence_refs: ["e1"] },
    baselineHead, baselineRevision: 1, strategyPolicy: readStrategyPolicy(store),
  });
  return candidate;
}

test("F4 an index-write failure reports 'durable but not indexed', and a retry repairs it", () => {
  const store = freshDir("f4a-store");
  seedAuthority(store);
  const baselineHead = "c".repeat(40);
  const candidate = persistedStrategyCandidate(store, baselineHead);

  // Occupy the index path with a DIRECTORY: the atomic rename cannot replace it.
  const indexPath = derivationIndexPath(store);
  mkdirSync(indexPath, { recursive: true });

  let thrown = null;
  try {
    persistCandidate(store, candidate);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, "the write must fail closed");
  assert.equal(thrown.code, EVOLUTION_CANDIDATE_HOLD.INDEX_WRITE_FAILED);
  assert.equal(thrown.details.artifact_durable, true, "the artifact IS durable — the index is not");
  assert.equal(thrown.details.candidate_id, candidate.candidate_id);
  assert.match(thrown.message, /durable but not indexed/);

  // The ARTIFACT is on disk and complete: this is what the old message denied.
  const onDisk = readCandidate(store, candidate.candidate_id);
  assert.ok(onDisk, "the candidate file exists");
  assert.equal(proposalContentDigest(onDisk), proposalContentDigest(candidate));
  assert.equal(digestOf({ ...onDisk, candidate_digest: undefined }), onDisk.candidate_digest);

  // Repair the index path and retry: the retry is an idempotent EXISTING write
  // that now indexes — nothing was lost and nothing was duplicated.
  rmSync(indexPath, { recursive: true, force: true });
  const retry = persistCandidate(store, candidate);
  assert.equal(retry.status, "EXISTING", "the retry keeps the first durable write");
  assert.equal(retry.candidate.candidate_id, candidate.candidate_id);
  assert.equal(retry.index.indexed, true);
  assert.deepEqual(indexKeys(store), [derivationKey("AGENT_STRATEGY", STRATEGY_SIGNATURE, baselineHead)]);
  assert.equal(readdirSync(candidateStorePath(store)).filter((f) => f === `${candidate.candidate_id}.json`).length, 1,
    "no duplicate artifact after the retry");
});

test("F4 the LOOP reports CANDIDATE_NOT_INDEXED (not NOT_PERSISTED) and keeps the artifact", async () => {
  const store = freshDir("f4b-store");
  const repo = makeFixtureRepo("f4b-repo");
  seedAuthority(store);
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  // block the index write, leave the candidate directory writable
  mkdirSync(derivationIndexPath(store), { recursive: true });

  const out = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f4b-cp"),
    baselineHead, baselineRevision: 1, baselineEvents: durableRepairs(3, "P0", "2"), fingerprint: null,
    triggerEvent: triggerFor(baselineHead), plan: strategyPlan(), taskClass: "FAM",
    reviewerIdentity: "reviewer:independent", proposalOnly: true,
  });
  assert.equal(out.loop_verdict, "HOLD", JSON.stringify(out));
  assert.equal(out.hold_code, EVOLUTION_LOOP_HOLD.CANDIDATE_NOT_INDEXED, JSON.stringify(out));
  assert.equal(out.artifact_durable, true);
  assert.equal(out.stage, "proposal");
  assert.ok(out.candidate_path && existsSync(out.candidate_path), "the reported path is the durable artifact");
  assert.match(out.reason, /durable but not indexed/);
  assert.equal(out.proposal, undefined, "a not-indexed proposal is not claimed as recorded");

  // nothing was mutated downstream: no authorization, no branch, HEAD unmoved
  assert.equal(out.trace.stages.some((s) => s.stage === "authorization"), false);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(git(repo, ["branch", "--list", "evolution/*"]), "");
});

test("F4 an artifact that truly cannot be written is still PERSIST_FAILED (no false 'durable')", async () => {
  const store = freshDir("f4c-store");
  const repo = makeFixtureRepo("f4c-repo");
  seedAuthority(store);
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  // a regular file occupies the candidate store directory path
  writeFileSync(candidateStorePath(store), "not a directory\n");

  const out = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f4c-cp"),
    baselineHead, baselineRevision: 1, baselineEvents: durableRepairs(3, "P0", "3"), fingerprint: null,
    triggerEvent: triggerFor(baselineHead), plan: strategyPlan(), taskClass: "FAM",
    reviewerIdentity: "reviewer:independent", proposalOnly: true,
  });
  assert.equal(out.loop_verdict, "HOLD", JSON.stringify(out));
  assert.equal(out.hold_code, EVOLUTION_LOOP_HOLD.CANDIDATE_NOT_PERSISTED, JSON.stringify(out));
  assert.equal(out.artifact_durable, false);
  assert.equal(out.proposal, undefined);
  assert.equal(readFileSync(candidateStorePath(store), "utf8"), "not a directory\n");
});

test("F4 a SOURCE derivation whose index write fails is classified, not thrown", async () => {
  const store = freshDir("f4d-store");
  const repo = makeFixtureRepo("f4d-repo");
  seedAuthority(store);
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);
  mkdirSync(derivationIndexPath(store), { recursive: true });

  const out = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f4d-cp"),
    baselineHead, baselineRevision: 1, baselineEvents: durableRepairs(3, "P0", "4"), fingerprint: null,
    triggerEvent: triggerFor(baselineHead), plan: sourcePlan(), taskClass: "FAM",
    reviewerIdentity: "reviewer:independent",
  });
  assert.equal(out.loop_verdict, "HOLD", JSON.stringify(out));
  assert.equal(out.hold_code, EVOLUTION_LOOP_HOLD.CANDIDATE_NOT_INDEXED, JSON.stringify(out));
  assert.equal(out.artifact_durable, true);
  assert.equal(out.stage, "candidate");
  const files = readdirSync(candidateStorePath(store)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, "the source artifact is durable");
});

test("F4 the index never repoints an identity it already owns (conflict fails closed)", () => {
  const store = freshDir("f4e-store");
  seedAuthority(store);
  const baselineHead = "d".repeat(40);
  const first = persistedStrategyCandidate(store, baselineHead, "b");
  persistCandidate(store, first);

  // a DIFFERENT candidate, same family + same signature@baseline
  const second = { ...first, candidate_id: `ecand_${"9".repeat(40)}` };
  second.candidate_digest = digestOf({ ...second, candidate_digest: undefined });
  const conflict = indexDerivation(store, second);
  assert.equal(conflict.indexed, false);
  assert.equal(conflict.status, "CONFLICT");
  // N1: an identity conflict is its own classification — the index was
  // readable and writable, it simply refused to repoint an owner.
  assert.equal(conflict.code, EVOLUTION_CANDIDATE_HOLD.CANDIDATE_CONFLICT);
  assert.equal(conflict.conflict?.kind, "different_candidate");
  assert.equal(conflict.conflict?.owner_id, first.candidate_id);
  // the original owner is untouched
  assert.deepEqual(indexKeys(store), [derivationKey("AGENT_STRATEGY", STRATEGY_SIGNATURE, baselineHead)]);
  const idx = JSON.parse(readFileSync(derivationIndexPath(store), "utf8"));
  assert.equal(idx.derivations[derivationKey("AGENT_STRATEGY", STRATEGY_SIGNATURE, baselineHead)], first.candidate_id);
});

// ══ F5 — SELF-DERIVING PROVENANCE PARITY ═══════════════════════════════════
//
// The reviewed defect: the production observer applied the FULL provenance
// rule (synthetic declaration, payload flags, journal identity) while the
// self-deriving loop entry applied only the DECLARED-synthetic half. The two
// paths could therefore disagree about the same run.

test("F5 the self-deriving path refuses the same evidence shapes the production observer refuses", async () => {
  const repo = makeFixtureRepo("f5-repo");
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);

  const cases = [
    ["no rows", [], "no_evidence_rows"],
    ["hand-built rows", repairs(3), "untrusted_evidence_row"],
    ["a non-object row", [null], "untrusted_evidence_row"],
    ["payload.synthetic", durableRepairs(3, "PS", "5").map((e) => ({ ...e, payload: { synthetic: true } })), "synthetic_evidence:declared_by_evidence_payload"],
    ["payload.test_only", durableRepairs(3, "PT", "6").map((e) => ({ ...e, payload: { test_only: true } })), "synthetic_evidence:declared_by_evidence_test_only"],
    ["a SYNTHETIC_EVIDENCE row", [...durableRepairs(2, "PX", "7"), { event_type: "SYNTHETIC_EVIDENCE", stage: "phase", payload: {}, timestamp: new Date().toISOString(), event_id: `evt_3_${"7".repeat(16)}`, sequence: 3 }], "synthetic_evidence:declared_by_evidence_event"],
  ];

  for (const [label, events, expected] of cases) {
    const store = freshDir(`f5-${label.replace(/\W+/g, "-")}`);
    createEvolutionPolicy(store, policyInput());
    const out = await runEvolutionCycle({
      repoRoot: repo, policyRoot: store, checkpointRoot: freshDir(`f5cp-${label.replace(/\W+/g, "-")}`),
      baselineHead, baselineRevision: 1, baselineEvents: events, fingerprint: null,
    });
    assert.equal(out.hold_code, EVOLUTION_LOOP_HOLD.EVIDENCE_UNQUALIFIED, `${label}: ${JSON.stringify(out)}`);
    assert.equal(out.evidence_exclusion, expected, label);
    assert.equal(readTriggerState(store).triggers.length, 0, `${label}: no trigger recorded`);
    assert.equal(existsSync(candidateStorePath(store)), false, `${label}: no candidate`);
  }
});

test("F5 a deployment that DECLARES itself synthetic cannot fire through the loop entry", async () => {
  const repo = makeFixtureRepo("f5b-repo");
  const store = freshDir("f5b-store");
  createEvolutionPolicy(store, policyInput());
  const out = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f5b-cp"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: durableRepairs(3, "P0", "8"), fingerprint: null, synthetic: true,
  });
  assert.equal(out.hold_code, EVOLUTION_LOOP_HOLD.EVIDENCE_UNQUALIFIED);
  assert.equal(out.evidence_exclusion, "synthetic_evidence:declared_by_deployment");
  assert.equal(readTriggerState(store).triggers.length, 0);
});

test("F5 REAL durable evidence still fires on the self-deriving path (no over-fencing)", async () => {
  const repo = makeFixtureRepo("f5c-repo");
  const store = freshDir("f5c-store");
  createEvolutionPolicy(store, policyInput());
  const out = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f5c-cp"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: durableRepairs(3, "P0", "9"), fingerprint: null,
  });
  assert.ok(out.trace.stages.some((s) => s.stage === "trigger"), `real evidence did not reach the trigger stage: ${JSON.stringify(out)}`);
  assert.equal(readTriggerState(store).triggers.length, 1, "real evidence records its trigger");
  assert.notEqual(out.stage, "evidence");
});

test("F5 the production path and the self-deriving path agree on a REAL journal", async () => {
  const store = freshDir("f5d-store");
  const repo = makeFixtureRepo("f5d-repo");
  createEvolutionPolicy(store, policyInput());

  // A real durable journal written by RunEvidenceStore itself.
  const evidenceRoot = freshDir("f5d-ev");
  const executionId = `exec_${createHash("sha256").update("f5d").digest("hex").slice(0, 32)}`;
  const journal = writeJournal(evidenceRoot, executionId, repairs(3, "P0"));
  const journalEvents = [];
  const j = journal.verifyJournal();
  for (let s = 1; s <= j.count; s++) journalEvents.push(journal.readEvent(s).event);

  // production path: the consumer scheduled / refused a cycle
  const r = await productionRun({
    store, checkpointRoot: freshDir("f5d-cp"), repoRoot: repo,
    terminalEvents: repairs(3, "P0"), label: "f5d",
    opts: { evolution: { storeRoot: store, checkpointRoot: freshDir("f5d-cp2"), repoRoot: repo } },
  });
  assert.equal(r.evolutionObservation.evidence_qualified, true, "the real journal is production evidence");

  // self-deriving path over the SAME rows
  const direct = await runEvolutionCycle({
    repoRoot: repo, policyRoot: store, checkpointRoot: freshDir("f5d-cp3"),
    baselineHead: git(repo, ["rev-parse", "HEAD"]), baselineRevision: 1,
    baselineEvents: journalEvents, fingerprint: null,
  });
  assert.notEqual(direct.stage, "evidence", "the self-deriving path accepted what production accepted");
});
