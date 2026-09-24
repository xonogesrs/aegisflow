// test/evolution/test-evolution-production-wiring-repair.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_WIRING_REPAIR_1 — acceptance suite.
//
// The gap this suite closes (recorded in
// AUTOLOOP_CROSS_AGENT_EVOLUTION_APPLICATION_AUDIT_1):
//   runEvolutionCycle had NO production caller, result.evolutionObservation
//   had NO production consumer, and the durable trigger state was never
//   written by the production path. The previous activation's "closed loop"
//   evidence was TEST-DRIVEN (direct calls into the loop stages), not a
//   production invocation.
//
// EVERY test below enters through THE production entrypoint
// (runAdmittedGraph) — `runEvolutionCycle` is NEVER called directly as proof
// (card §F). The evolution cycle is reached only as a consequence of a real
// production run's durable evidence.
//
//   R1 §F REAL PRODUCTION TRACE: runAdmittedGraph → real durable journal →
//      observer → production consumer → durable trigger state →
//      runEvolutionCycle → candidate → isolated mutation → fitness → review
//      → promotion → canary (PROMOTED). No direct loop invocation.
//   R2 §B durable trigger state: dedup basis (lastFiredAt), signature,
//      evidence refs, survives a restart (re-read from disk).
//   R3 §G single failure → observer → NO cycle.
//   R4 §G insufficient evidence (2 < floor 3) → NO cycle.
//   R5 §G duplicate signature → ONE cycle / ONE candidate.
//   R6 §E SUSPENDED → NO cycle; resume restores the route.
//   R7 §C cycle failure → NORMAL_OPERATION unaffected (still PASS).
//   R8 §C inert by default: an undeclared deployment consumes nothing and
//      still performs the pre-repair observation-only behaviour.
//   R9 §A evidence-bound plan: a qualified signal WITHOUT a bounded plan
//      records the trigger but derives UNSUPPORTED — never a fabricated
//      mutation.
//
// Run: node --test test/evolution/test-evolution-production-wiring-repair.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";

import * as triggerMod from "../../src/evolution/trigger.mjs";
import { readTriggerState } from "../../src/evolution/trigger.mjs";
import { selectDerivationStrategy } from "../../src/evolution/candidate.mjs";
import { createEvolutionPolicy } from "../../src/evolution/policy.mjs";
import { candidateStorePath } from "../../src/evolution/candidate.mjs";
import { readCanary } from "../../src/evolution/canary.mjs";
import { EVOLUTION_LOOP_VERDICTS } from "../../src/evolution/loop.mjs";
import {
  drainEvolutionCycles, evolutionConsumerState,
  EVOLUTION_CONSUMER_DISPOSITIONS, EVOLUTION_CONSUMER_OUTCOME_DISPOSITIONS,
} from "../../src/evolution/production-consumer.mjs";
import { suspendEvolution, resumeEvolution } from "../../src/evolution/kill-switch.mjs";
import { RunEvidenceStore } from "../../src/evidence/run-evidence-store.mjs";

const ROOTS = [];
function freshDir(label) {
  const d = mkdtempSync(join(tmpdir(), `evol-wire-${label}-`));
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

/**
 * The fixture policy's scope is `lib/**` (the fixture repo's source), so a
 * qualified LOW-risk candidate derived from the journal's bounded plan is
 * both authorized and executable.
 */
function policyInput(overrides = {}) {
  return {
    policy_name: "autoloop-production-wiring-repair-test",
    scope_patterns: ["lib/**"],
    forbidden_patterns: [],
    allowed_commands: ["node", "git"],
    validation_plan_id: "evolution-validation-wire",
    validation_plan: { commands: [{ cmd: "node", args: ["-e", "process.exit(0)"], timeout_ms: 30000 }] },
    budget: { max_mutation_runs: 8, max_wall_clock_ms_per_run: 120000, max_evolutions_per_window: 8, window_ms: 86400000 },
    issued_by: "test-operator",
    authorization_ref: "test://evolution-policy",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

// ── REAL durable evidence journal helpers (the production evidence path) ────

function writeJournal(root, executionId, events) {
  const store = new RunEvidenceStore({
    root, executionId,
    chainId: `chain-${executionId}`, checkpointId: `ckpt-${executionId}`,
  });
  store.init();
  for (const e of events) store.appendEvent(e);
  return store;
}

/** Repairs on ONE phase, each carrying a bounded repair plan in its durable
 *  payload — the evidence-bound form the derivation stage consumes. */
function plannedRepairs(n, phase = "P1") {
  return Array.from({ length: n }, (_, i) => ({
    event_type: "PHASE_REPAIR_REQUESTED",
    stage: "phase",
    phase_id: phase,
    attempt: i,
    payload: { patch_plan: { patch: PATCH }, affected_scope: ["lib/utils/retry.ts"] },
  }));
}

/** Repairs WITHOUT a bounded plan — a qualified signal with no actionable
 *  transform (derivation must fail closed, never fabricate a mutation). */
function planlessRepairs(n, phase = "P2") {
  return Array.from({ length: n }, (_, i) => ({
    event_type: "PHASE_REPAIR_REQUESTED", stage: "phase", phase_id: phase, attempt: i, payload: {},
  }));
}

function heldEvents(n, reason = "HOLD / C3B_MUTATION_FAILED") {
  return Array.from({ length: n }, () => ({ event_type: "RUN_HELD", stage: "terminal", payload: { reason } }));
}

const TERMINAL_PASS = { event_type: "RUN_PASSED", stage: "terminal", payload: {} };

// ── frozen admission (the production entry contract) ────────────────────────

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
  return freezeAdmission(buildAdmissionRecord({ taskId: taskId ?? `EVOL-WIRE-${admissionSeq}`, classification: c, mutationScope: ["lib/"] }));
}

/** A faithful production runner: honors the budget chain (NEG13) and writes
 *  REAL terminal events into a REAL durable journal under the runner-owned
 *  persistence root. */
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

/**
 * ONE production run through the REAL entrypoint with the evolution execution
 * inputs declared. `runEvolutionCycle` is never called here.
 */
async function productionRun({ store, checkpointRoot, repoRoot, terminalEvents, label, verdict = "PASS", withEvolution = true, reviewer = "reviewer:production-trace" }) {
  const evidenceRoot = freshDir(`ev-${label}`);
  // execution_id must match /^exec_[0-9a-f]{32}$/ (the C2D identity contract)
  const executionId = `exec_${createHash("sha256").update(label).digest("hex").slice(0, 32)}`;
  const r = await runAdmittedGraph({
    admission: frozenAdmission(),
    runner: journalingRunner({ terminalEvents, verdict }),
    persistence: { root: evidenceRoot, executionId },
    ir: { phases: [] },
    ...(withEvolution
      ? { evolution: { storeRoot: store, checkpointRoot, repoRoot, reviewerIdentity: reviewer } }
      : {}),
  });
  return { result: r, evidenceRoot, executionId };
}

// The consumer's outcome log is process-global (one process per test file),
// so EVERY assertion below is scoped to this test's own trigger id — a
// previous test's cycle can never satisfy (or pollute) it.
function outcomesFor(triggerId) {
  return evolutionConsumerState().outcomes.filter((o) => o.trigger_id === triggerId);
}

/** The drain's own asserts: every outcome carries a declared disposition,
 *  and a completed cycle always carries a loop verdict. */
async function drainFor(triggerId, { timeoutMs = 120000 } = {}) {
  await drainEvolutionCycles({ timeoutMs });
  const mine = outcomesFor(triggerId);
  for (const o of mine) {
    assert.ok(
      EVOLUTION_CONSUMER_OUTCOME_DISPOSITIONS.includes(o.disposition),
      `${o.disposition} is not a declared cycle outcome disposition`,
    );
    if (o.disposition === "CYCLE_COMPLETED") {
      assert.ok(o.loop_verdict, "a completed cycle carries a loop verdict");
      assert.ok(EVOLUTION_LOOP_VERDICTS.includes(o.loop_verdict), `${o.loop_verdict} is not a declared loop verdict`);
    }
  }
  return mine;
}

function outcomeCountSnapshot() {
  return evolutionConsumerState().outcomes.length;
}

/** Every consumer disposition must be a member of the frozen closed set. */
function assertDisposition(value, expected) {
  assert.ok(EVOLUTION_CONSUMER_DISPOSITIONS.includes(value), `${value} is not a declared consumer disposition`);
  if (expected !== undefined) assert.equal(value, expected);
}

// ── R1: §F THE REAL PRODUCTION TRACE ───────────────────────────────────────

test("R1 real production trace: runAdmittedGraph → durable evidence → observer → consumer → runEvolutionCycle → candidate → mutation → fitness → review → promotion → canary", async () => {
  const store = freshDir("r1-store");
  const checkpointRoot = freshDir("r1-cp");
  const repo = makeFixtureRepo("r1-repo");
  createEvolutionPolicy(store, policyInput());
  const baselineHead = git(repo, ["rev-parse", "HEAD"]);

  // 3 equivalent planned repairs on one phase ⇒ a QUALIFIED trigger (floor 3).
  const { result, evidenceRoot, executionId } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...plannedRepairs(3), TERMINAL_PASS],
    label: "r1",
  });

  // (a) the production run's own semantics are untouched
  assert.equal(result.final, "PASS");
  assert.equal(result.budget.authorized, true);

  // (b) the observer read the REAL journal and fired a qualified signal
  assert.ok(result.evolutionObservation, "observation attached");
  assert.ok(result.evolutionObservation.fired.length > 0, "qualified signal fired from real evidence");
  const signal = result.evolutionObservation.fired.find((s) => s.signalClass === "REPEATED_REPAIR_REQUIREMENT");
  assert.ok(signal, `expected a repair signal, got ${result.evolutionObservation.fired.map((s) => s.signalClass).join(",")}`);
  assert.equal(signal.count, 3);

  // (c) THE PRODUCTION CONSUMER consumed it and scheduled the cycle
  assertDisposition(result.evolutionDisposition.disposition, "CYCLE_STARTED");
  assert.equal(result.evolutionDisposition.cycle_started, true);
  assert.equal(result.evolutionDisposition.signal_class, "REPEATED_REPAIR_REQUIREMENT");
  assert.equal(result.evolutionDisposition.reviewer_configured, true);

  // (d) §B the durable trigger state was written BY THE PRODUCTION PATH
  const state = readTriggerState(store);
  assert.equal(state.triggers.length, 1, "exactly one durable production trigger");
  const recorded = state.triggers[0];
  assert.equal(recorded.schema, "autoloop.evolution-trigger/v1");
  assert.equal(recorded.signal_class, "REPEATED_REPAIR_REQUIREMENT");
  assert.equal(recorded.signature, signal.signature);
  assert.equal(recorded.trigger_id, result.evolutionDisposition.trigger_id, "the envelope names the durably recorded trigger");
  assert.ok(recorded.evidence_refs.length >= 3, "provenance: the durable journal event ids");
  assert.ok(state.lastFiredAt[signal.signature], "dedup/cooldown basis persisted");
  assert.ok(existsSync(join(store, "evolution-trigger-state.json")), "state is a durable file, not an envelope field");

  // (e) drain the scheduled cycle (production never awaits; this is the
  //     verification drain) and prove the loop actually ran and completed.
  const triggerId = result.evolutionDisposition.trigger_id;
  const drained = await drainFor(triggerId, { timeoutMs: 120000 });
  assert.equal(evolutionConsumerState().pending, 0, "no cycle left in flight");
  assert.equal(drained.length, 1, `expected exactly one cycle outcome: ${JSON.stringify(drained)}`);
  const outcome = drained[0];
  assert.equal(outcome.disposition, "CYCLE_COMPLETED", `cycle disposition: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.loop_verdict, "PROMOTED", `loop verdict: ${JSON.stringify(outcome.cycle)}`);

  // (f) the FULL downstream chain is observable in the durable store
  const candidates = readdirSync(candidateStorePath(store)).filter((f) => f.endsWith(".json"));
  assert.equal(candidates.length, 1, "exactly one derived candidate");
  const candidateId = candidates[0].replace(/\.json$/, "");
  assert.equal(outcome.cycle.candidate_id, candidateId, "the loop's candidate is the durable artifact");
  // promotion: a dedicated evolution branch exists at a descendant of baseline
  const branch = `evolution/${candidateId}`;
  assert.notEqual(git(repo, ["rev-parse", `refs/heads/${branch}`]), baselineHead, "evolution branch advanced");
  // canary: the bounded window was opened (and is observable)
  assert.ok(outcome.cycle.canary?.closes_at, "canary window opened");
  assert.ok(readCanary(store, candidateId), "durable canary record");

  // (g) production is untouched: main line and worktree unchanged
  assert.equal(git(repo, ["rev-parse", "master"]), baselineHead);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  // the run's journal is evidence only — the observer never wrote to it
  assert.ok(existsSync(evidenceRoot));
  assert.ok(executionId);

  // (h) crash recovery ran from the production consumer (§ wiring)
  assert.ok(evolutionConsumerState().reconciled_stores.includes(store), "reconcileEvolutionState invoked in the production path");
});

// ── R2: §B durable trigger state survives a restart ────────────────────────

test("R2 durable trigger state: signature + evidence refs + cooldown basis survive a restart (fresh-process read)", async () => {
  const store = freshDir("r2-store");
  const checkpointRoot = freshDir("r2-cp");
  const repo = makeFixtureRepo("r2-repo");
  createEvolutionPolicy(store, policyInput());
  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...plannedRepairs(3, "P9"), TERMINAL_PASS], label: "r2",
  });
  assertDisposition(result.evolutionDisposition.disposition, "CYCLE_STARTED");
  await drainEvolutionCycles({ timeoutMs: 120000 });

  // A restart re-reads the durable file (no in-memory carry-over): the
  // dedup basis, provenance and circuit-breaker slot are all present.
  const afterRestart = readTriggerState(store);
  assert.equal(afterRestart.triggers.length, 1);
  const t = afterRestart.triggers[0];
  assert.equal(t.signal_class, "REPEATED_REPAIR_REQUIREMENT");
  assert.match(t.signature, /^[0-9a-f]{64}$/);
  assert.ok(t.evidence_refs.every((e) => typeof e === "string" && e.length > 0));
  assert.ok(afterRestart.lastFiredAt[t.signature]);
  assert.equal(afterRestart.circuitBreaker, null, "breaker slot present and clear");

  // A genuinely FRESH PROCESS (not just a re-read in this one) sees the same
  // dedup basis, provenance and cleared breaker slot.
  const moduleHref = new URL("../../src/evolution/trigger.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { readTriggerState } from ${JSON.stringify(moduleHref)};
const s = readTriggerState(${JSON.stringify(store)});
const sig = s.triggers?.[0]?.signature ?? null;
console.log(JSON.stringify({
  count: s.triggers?.length ?? 0, sig,
  hasCooldownBasis: Boolean(sig && s.lastFiredAt?.[sig]),
  evidence: s.triggers?.[0]?.evidence_refs?.length ?? 0,
  breaker: s.circuitBreaker ?? null,
}));
`], { encoding: "utf8" });
  assert.equal(child.status, 0, `fresh-process read failed: ${child.stderr}`);
  const seen = JSON.parse(child.stdout.trim());
  assert.equal(seen.count, 1, "one durable trigger across the restart");
  assert.equal(seen.sig, t.signature);
  assert.equal(seen.hasCooldownBasis, true);
  assert.ok(seen.evidence >= 3);
  assert.equal(seen.breaker, null);
});

// ── R3/R4: §G single failure and insufficient evidence → NO cycle ───────────

test("R3 a SINGLE failure fires no signal → the consumer starts NO cycle", async () => {
  const store = freshDir("r3-store");
  const checkpointRoot = freshDir("r3-cp");
  const repo = makeFixtureRepo("r3-repo");
  createEvolutionPolicy(store, policyInput());
  const before = outcomeCountSnapshot();
  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...plannedRepairs(1), TERMINAL_PASS], label: "r3",
  });
  assert.equal(result.evolutionObservation.fired.length, 0, "one failure never fires");
  assertDisposition(result.evolutionDisposition.disposition, "NO_QUALIFIED_TRIGGER");
  assert.equal(result.evolutionDisposition.cycle_started, false);
  await drainEvolutionCycles({ timeoutMs: 5000 });
  assert.equal(evolutionConsumerState().pending, 0);
  assert.equal(outcomeCountSnapshot(), before, "no cycle was ever scheduled");
  assert.equal(readTriggerState(store).triggers.length, 0, "no durable trigger");
  assert.ok(!existsSync(join(store, "evolution-trigger-state.json")));
});

test("R4 insufficient evidence (2 < floor 3) → NO cycle, no durable trigger", async () => {
  const store = freshDir("r4-store");
  const checkpointRoot = freshDir("r4-cp");
  const repo = makeFixtureRepo("r4-repo");
  createEvolutionPolicy(store, policyInput());
  const before = outcomeCountSnapshot();
  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...plannedRepairs(2), TERMINAL_PASS], label: "r4",
  });
  assert.equal(result.evolutionObservation.fired.length, 0);
  assertDisposition(result.evolutionDisposition.disposition, "NO_QUALIFIED_TRIGGER");
  await drainEvolutionCycles({ timeoutMs: 5000 });
  assert.equal(outcomeCountSnapshot(), before);
  assert.equal(readTriggerState(store).triggers.length, 0);
});

// ── R5: §G/§D duplicate signature → ONE cycle ─────────────────────────────

test("R5 duplicate signature across two production runs → exactly ONE cycle, ONE candidate", async () => {
  const store = freshDir("r5-store");
  const checkpointRoot = freshDir("r5-cp");
  const repo = makeFixtureRepo("r5-repo");
  createEvolutionPolicy(store, policyInput());
  const events = [...plannedRepairs(3, "PD"), TERMINAL_PASS];

  const first = await productionRun({ store, checkpointRoot, repoRoot: repo, terminalEvents: events, label: "r5a" });
  assertDisposition(first.result.evolutionDisposition.disposition, "CYCLE_STARTED");
  const firstTrigger = first.result.evolutionDisposition.trigger_id;
  await drainEvolutionCycles({ timeoutMs: 120000 });

  // the SAME qualified signature again: cooldown/dedup suppresses it durably
  const second = await productionRun({ store, checkpointRoot, repoRoot: repo, terminalEvents: events, label: "r5b" });
  assertDisposition(second.result.evolutionDisposition.disposition, "GATED");
  assert.equal(second.result.evolutionDisposition.cycle_started, false);
  assert.ok(second.result.evolutionDisposition.suppressed.some((s) => s.reason === "cooldown"), JSON.stringify(second.result.evolutionDisposition.suppressed));

  await drainEvolutionCycles({ timeoutMs: 120000 });
  const completed = outcomesFor(firstTrigger).filter((o) => o.disposition === "CYCLE_COMPLETED");
  assert.equal(completed.length, 1, `expected ONE completed cycle: ${JSON.stringify(outcomesFor(firstTrigger))}`);
  assert.equal(completed[0].loop_verdict, "PROMOTED");
  assert.equal(readTriggerState(store).triggers.length, 1, "one durable trigger for the signature");
  const candidates = readdirSync(candidateStorePath(store)).filter((f) => f.endsWith(".json"));
  assert.equal(candidates.length, 1, "no duplicate candidate");
});

// ── R6: §E kill switch actually controls the production consumer ───────────

test("R6 AUTO_EVOLUTION=SUSPENDED stops the production consumer; resume restores the route", async () => {
  const store = freshDir("r6-store");
  const checkpointRoot = freshDir("r6-cp");
  const repo = makeFixtureRepo("r6-repo");
  createEvolutionPolicy(store, policyInput());
  const events = [...plannedRepairs(3, "PS"), TERMINAL_PASS];

  suspendEvolution(store, { reason: "operator pause (wiring repair test)" });
  const before = outcomeCountSnapshot();
  const suspended = await productionRun({ store, checkpointRoot, repoRoot: repo, terminalEvents: events, label: "r6a" });
  assertDisposition(suspended.result.evolutionDisposition.disposition, "SUSPENDED");
  assert.equal(suspended.result.evolutionDisposition.cycle_started, false);
  assert.equal(suspended.result.evolutionObservation.fired.length, 0, "observer observes nothing while suspended");
  await drainEvolutionCycles({ timeoutMs: 5000 });
  assert.equal(readTriggerState(store).triggers.length, 0, "no durable trigger while suspended");
  assert.equal(outcomeCountSnapshot(), before, "no cycle scheduled while suspended");
  assert.equal(evolutionConsumerState().pending, 0);

  // resume → the SAME evidence now drives a real cycle
  resumeEvolution(store);
  const resumed = await productionRun({ store, checkpointRoot, repoRoot: repo, terminalEvents: events, label: "r6b" });
  assertDisposition(resumed.result.evolutionDisposition.disposition, "CYCLE_STARTED");
  const drained = await drainFor(resumed.result.evolutionDisposition.trigger_id, { timeoutMs: 120000 });
  assert.equal(drained.find((o) => o.disposition === "CYCLE_COMPLETED")?.loop_verdict, "PROMOTED");
});

// ── R7: §C a failing evolution cycle never affects NORMAL_OPERATION ────────

test("R7 a FAILING evolution cycle leaves the successful production run PASS (fail-open)", async () => {
  const store = freshDir("r7-store");
  const checkpointRoot = freshDir("r7-cp");
  const repo = makeFixtureRepo("r7-repo");
  // the validation plan FAILS ⇒ the mutation stage fails closed ⇒ cycle HOLDs
  createEvolutionPolicy(store, policyInput({
    validation_plan: { commands: [{ cmd: "node", args: ["-e", "process.exit(1)"], timeout_ms: 30000 }] },
  }));

  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...plannedRepairs(3, "PF"), TERMINAL_PASS], label: "r7",
  });
  // the normal run is authoritative and unaffected by the evolution outcome
  assert.equal(result.final, "PASS");
  assert.equal(result.budget.authorized, true);
  assertDisposition(result.evolutionDisposition.disposition, "CYCLE_STARTED");

  const drained = await drainFor(result.evolutionDisposition.trigger_id, { timeoutMs: 120000 });
  assert.equal(drained.length, 1, JSON.stringify(drained));
  const outcome = drained[0];
  assert.equal(outcome.loop_verdict, "HOLD", `expected the cycle to fail closed: ${JSON.stringify(outcome.cycle)}`);
  assert.match(outcome.cycle.hold_code ?? "", /EVOLUTION_LOOP_MUTATION_FAILED|EVOLUTION_LOOP_FITNESS_REJECTED|EVOLUTION_POLICY_INVALID/);
  // no promotion happened: no evolution branch, main line and worktree clean
  assert.equal(git(repo, ["branch", "--list", "evolution/*"]), "");
  assert.equal(git(repo, ["rev-parse", "master"]), git(repo, ["rev-parse", "HEAD"]));
  assert.equal(git(repo, ["status", "--porcelain"]), "");
});

// ── R8: §A inert by default (no declared evolution inputs) ─────────────────

test("R8 an undeclared deployment is inert: observation only, no consumer effect", async () => {
  const store = freshDir("r8-store");
  const repo = makeFixtureRepo("r8-repo");
  createEvolutionPolicy(store, policyInput());
  const before = outcomeCountSnapshot();
  const { result } = await productionRun({
    store, checkpointRoot: freshDir("r8-cp"), repoRoot: repo,
    terminalEvents: [...plannedRepairs(3, "PI"), TERMINAL_PASS], label: "r8",
    withEvolution: false,
  });
  assert.equal(result.final, "PASS");
  // pre-repair behaviour preserved: the observation still attaches...
  assert.ok(result.evolutionObservation);
  assert.ok(result.evolutionObservation.fired.length > 0);
  // ...but nothing consumes it: no trigger, no cycle, no store mutation.
  assertDisposition(result.evolutionDisposition.disposition, "DISABLED");
  assert.equal(result.evolutionDisposition.cycle_started, false);
  assert.equal(readTriggerState(store).triggers.length, 0);
  assert.ok(!existsSync(join(store, "evolution-trigger-state.json")));
  await drainEvolutionCycles({ timeoutMs: 5000 });
  assert.equal(outcomeCountSnapshot(), before, "an undeclared deployment schedules nothing");
});

// ── R9: §A evidence-bound plan — no plan ⇒ no fabricated mutation ──────────

test("R9 a qualified signal WITHOUT a bounded evidence plan records the trigger but derives UNSUPPORTED", async () => {
  const store = freshDir("r9-store");
  const checkpointRoot = freshDir("r9-cp");
  const repo = makeFixtureRepo("r9-repo");
  createEvolutionPolicy(store, policyInput());
  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    // qualified by count, but the durable evidence carries NO bounded plan
    terminalEvents: [...planlessRepairs(3, "PN"), TERMINAL_PASS], label: "r9",
  });
  assert.ok(result.evolutionObservation.fired.length > 0, "count alone still qualifies the signal");
  assertDisposition(result.evolutionDisposition.disposition, "CYCLE_STARTED");
  // the trigger IS durably recorded (the evidence is real)...
  assert.equal(readTriggerState(store).triggers.length, 1);

  const drained = await drainFor(result.evolutionDisposition.trigger_id, { timeoutMs: 120000 });
  assert.equal(drained.length, 1, JSON.stringify(drained));
  const outcome = drained[0];
  // ...but the loop fails closed at derivation: nothing was mutated or
  // promoted. (AGENT_STRATEGY_EVOLUTION_COMPLETION_1 added the natural plan
  // producer ahead of this stage, so a planless signal is now reported by the
  // producer as INCONCLUSIVE — insufficient attributed evidence — rather than
  // as UNSUPPORTED by the source derivation. Both are the same invariant:
  // a planless signal yields NO candidate and mutates nothing.)
  assert.equal(outcome.loop_verdict, "HOLD");
  assert.match(outcome.cycle.hold_code ?? "", /EVOLUTION_LOOP_CANDIDATE_(UNSUPPORTED|INCONCLUSIVE)/);
  assert.ok(!existsSync(candidateStorePath(store)) || readdirSync(candidateStorePath(store)).filter((f) => f.endsWith(".json")).length === 0, "no candidate fabricated");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(git(repo, ["branch", "--list", "evolution/*"]), "");
});

// ── R10: §A the bounded-plan link — bounds and class selection ─────────────
//
// Helper-level contract (NOT route proof; the route proof is R1/R9 above):
// the plan travels from DURABLE evidence into the signal observation only for
// the classes whose derivation strategy consumes it, and only within the byte
// bound the applier enforces.

test("R10 evidence-bound plan link: extracted only for plan-consuming classes, only within the applier's byte bound", () => {
  const { extractTriggerObservations, evaluateSignals, MAX_EVIDENCE_PATCH_BYTES } = triggerMod;
  const okPatch = PATCH;
  const bigPatch = ["--- a/lib/x.ts", "+++ b/lib/x.ts", "@@ -1 +1 @@", `-old${"x".repeat(MAX_EVIDENCE_PATCH_BYTES)}`, "+new", ""].join("\n");
  assert.ok(Buffer.byteLength(bigPatch, "utf8") > MAX_EVIDENCE_PATCH_BYTES, "fixture must exceed the bound");

  const planned = (payload, n = 3) => Array.from({ length: n }, (_, i) => ({
    event_type: "PHASE_REPAIR_REQUESTED", stage: "phase", phase_id: "P1", attempt: i, payload,
  }));

  // (1) a planned repair carries the plan into the plan-consuming class
  let fired = evaluateSignals({ observations: extractTriggerObservations({ events: planned({ patch_plan: { patch: okPatch }, affected_scope: ["lib/utils/retry.ts"], declared_risk_markers: ["GOVERNANCE_AUTHORITY"] }) }) });
  let sig = fired.find((s) => s.signalClass === "REPEATED_REPAIR_REQUIREMENT");
  assert.ok(sig, "repair signal fired");
  assert.equal(sig.observation.patchPlan.patch, okPatch, "bounded plan reaches the signal observation");
  assert.deepEqual(sig.observation.affectedScope, ["lib/utils/retry.ts"]);
  assert.deepEqual(sig.observation.declaredRiskMarkers, ["GOVERNANCE_AUTHORITY"], "declared markers survive for risk classification");

  // (2) an OVERSIZED patch is simply not extracted (the applier would refuse it
  //     anyway) ⇒ the candidate fails closed at derivation, never late
  fired = evaluateSignals({ observations: extractTriggerObservations({ events: planned({ patch_plan: { patch: bigPatch }, affected_scope: ["lib/utils/retry.ts"] }) }) });
  sig = fired.find((s) => s.signalClass === "REPEATED_REPAIR_REQUIREMENT");
  assert.ok(sig, "the signal still fires on count alone");
  assert.equal(sig.observation.patchPlan, undefined, "oversized patch is not carried");

  // (2b) the camelCase aliases (in-process producers) are accepted too, and a
  //      bare-string patch_plan is normalized to the same shape
  fired = evaluateSignals({ observations: extractTriggerObservations({ events: planned({ patchPlan: { patch: okPatch }, affectedScope: ["lib/utils/retry.ts"] }) }) });
  sig = fired.find((s) => s.signalClass === "REPEATED_REPAIR_REQUIREMENT");
  assert.equal(sig.observation.patchPlan.patch, okPatch, "camelCase patchPlan accepted");
  assert.deepEqual(sig.observation.affectedScope, ["lib/utils/retry.ts"]);
  fired = evaluateSignals({ observations: extractTriggerObservations({ events: planned({ patch_plan: okPatch, affected_scope: ["lib/utils/retry.ts"] }) }) });
  sig = fired.find((s) => s.signalClass === "REPEATED_REPAIR_REQUIREMENT");
  assert.equal(sig.observation.patchPlan.patch, okPatch, "a bare-string patch_plan normalizes to {patch}");

  // (3) traversal/absolute scope entries are dropped, never carried
  fired = evaluateSignals({ observations: extractTriggerObservations({ events: planned({ patch_plan: { patch: okPatch }, affected_scope: ["/etc/passwd", "../outside", "lib/ok.ts"] }) }) });
  sig = fired.find((s) => s.signalClass === "REPEATED_REPAIR_REQUIREMENT");
  assert.deepEqual(sig.observation.affectedScope, ["lib/ok.ts"]);

  // (4) a plan is NOT carried into the classes whose strategies emit edits the
  //     mutation boundary cannot execute (constant_adjustment /
  //     efficiency_adjustment) — carrying it would change nothing, so those
  //     classes keep their pre-existing outcomes. The strategies they DO
  //     select are asserted here so the boundary is documented, not assumed.
  fired = evaluateSignals({ observations: extractTriggerObservations({ events: planned({ metric: "retry_backoff", patch_plan: { patch: okPatch } }, 5) }) });
  const retry = fired.find((s) => s.signalClass === "ABNORMAL_RETRY_FREQUENCY");
  assert.ok(retry, "retry-volume signal fired (floor 5)");
  assert.equal(retry.observation.patchPlan, undefined, "no plan on a non-plan-consuming class");
  assert.equal(
    selectDerivationStrategy({ signalClass: retry.signalClass, observation: retry.observation, signature: retry.signature }),
    "TELEMETRY_EFFICIENCY_REPAIR",
  );

  // The plan-REQUIRING classes: with a plan they derive DETERMINISTIC_BUG_REPAIR
  // (executable); without one they do not derive a plan at all.
  assert.equal(
    selectDerivationStrategy({ signalClass: "RECURRING_HOLD_PATTERN", observation: { patchPlan: { patch: okPatch } }, signature: "s" }),
    "DETERMINISTIC_BUG_REPAIR",
  );
  assert.equal(
    selectDerivationStrategy({ signalClass: "RECURRING_HOLD_PATTERN", observation: {}, signature: "s" }),
    null,
    "a planless HOLD pattern does not derive (UNSUPPORTED, no fabricated transform)",
  );
  assert.equal(
    selectDerivationStrategy({ signalClass: "REPEATED_EQUIVALENT_FAILURE", observation: {}, signature: "s" }),
    null,
  );
  // PRECISE, pre-existing behaviour of the repair class (unchanged by this
  // card): without a plan it selects the constant-tuning strategy, whose
  // edits the mutation boundary cannot apply ⇒ the candidate fails closed at
  // MUTATION_FAILED rather than at derivation.
  assert.equal(
    selectDerivationStrategy({ signalClass: "REPEATED_REPAIR_REQUIREMENT", observation: {}, signature: "s" }),
    "BOUNDED_CONSTANT_TUNING",
  );
});

// ── R11: §C consumer-level fail-open ───────────────────────────────────────

test("R11 a broken durable trigger state makes the consumer fail OPEN: run PASS, no cycle, no mutation", async () => {
  const store = freshDir("r11-store");
  const checkpointRoot = freshDir("r11-cp");
  const repo = makeFixtureRepo("r11-repo");
  createEvolutionPolicy(store, policyInput());
  // Sabotage the durable state path: a NON-EMPTY DIRECTORY where the trigger
  // state FILE belongs, so the atomic tmp+rename publish cannot succeed.
  mkdirSync(join(store, "evolution-trigger-state.json"), { recursive: true });
  writeFileSync(join(store, "evolution-trigger-state.json", "blocker"), "x");

  const before = outcomeCountSnapshot();
  const { result } = await productionRun({
    store, checkpointRoot, repoRoot: repo,
    terminalEvents: [...plannedRepairs(3, "PX"), TERMINAL_PASS], label: "r11",
  });
  // the run is authoritative and unaffected by the evolution wiring failure
  assert.equal(result.final, "PASS");
  assert.equal(result.budget.authorized, true);
  assertDisposition(result.evolutionDisposition.disposition, "SCHEDULE_FAILED");
  assert.equal(result.evolutionDisposition.cycle_started, false);
  assert.match(result.evolutionDisposition.reason ?? "", /consumer failed open|schedule failed/);

  // no cycle was scheduled; nothing was mutated or promoted
  await drainEvolutionCycles({ timeoutMs: 5000 });
  assert.equal(evolutionConsumerState().pending, 0);
  assert.equal(outcomeCountSnapshot(), before);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(git(repo, ["branch", "--list", "evolution/*"]), "");
});
