// test/subagent/test-delegation-decision.mjs
//
// CEDF Foundation — delegation decision model tests.
// Part 1: decideDelegation pure-function rules（five decisions + fail-closed HOLD gates + determinism）.
// Part 2: execution-orchestrator wiring（opt-in hooks.delegation seam; existing behavior unchanged without it）.
// Offline only — no provider, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  decideDelegation,
  DELEGATION_DECISIONS,
  DELEGATION_DECISION_CODES,
} from "../../src/subagent/delegation-decision.mjs";
import { runExecutionOrchestrator } from "../../src/v2/execution-orchestrator.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_EVIDENCE = JSON.parse(
  readFileSync(new URL("../fixtures/implementation-evidence-valid.json", import.meta.url), "utf8"),
);

const ADMISSION = Object.freeze({
  mutation_scope: ["src/", "evidence/"],
});

// ── phase builders ──

function completeEffects(overrides = {}) {
  return {
    artifact_mutation: "forbidden",
    runtime_side_effect: "forbidden",
    external_system_mutation: "forbidden",
    evidence_output: "ephemeral",
    boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
    ...overrides,
  };
}

function completePlan() {
  return {
    subject_phase_ids: ["p1"],
    method: "run checks",
    success_criteria: "all green",
    failure_criteria: "any red",
    evidence: ["evidence/run.json"],
  };
}

function readOnlyPhase(overrides = {}) {
  return {
    phase_id: "p_ro",
    title: "Analysis",
    summary: "read-only analysis",
    responsibility: "R1 analysis",
    purpose: "analysis",
    effects: completeEffects(),
    covers: [{ requirement_id: "R1", completeness: "complete", claim: "covers R1" }],
    depends_on: [],
    verification_plan: completePlan(),
    ...overrides,
  };
}

function writerPhase(overrides = {}) {
  return readOnlyPhase({
    phase_id: "p_w",
    purpose: "implementation",
    effects: completeEffects({
      artifact_mutation: "required",
      evidence_output: "persistent",
      boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: ["evidence/"] },
    }),
    ...overrides,
  });
}

// ── Part 1: pure-function decision rules ──

test("D1: admission missing → HOLD（fail-closed）", () => {
  for (const admission of [undefined, null, 42]) {
    const r = decideDelegation({ phase: readOnlyPhase(), readySiblings: [], dependencyStates: {}, admission });
    assert.equal(r.decision, DELEGATION_DECISIONS.HOLD);
    assert.deepEqual(r.reasons, [DELEGATION_DECISION_CODES.ADMISSION_MISSING]);
  }
});

test("D2: effects/boundary contract incomplete → HOLD", () => {
  const base = { readySiblings: [], dependencyStates: {}, admission: ADMISSION };

  // missing verification plan
  let p = readOnlyPhase();
  delete p.verification_plan;
  assert.equal(decideDelegation({ phase: p, ...base }).decision, DELEGATION_DECISIONS.HOLD);

  // incomplete verification plan（missing success_criteria）
  p = readOnlyPhase({ verification_plan: { ...completePlan() } });
  delete p.verification_plan.success_criteria;
  assert.equal(decideDelegation({ phase: p, ...base }).decision, DELEGATION_DECISIONS.HOLD);

  // missing boundaries object
  p = readOnlyPhase({ effects: completeEffects() });
  delete p.effects.boundaries;
  assert.equal(decideDelegation({ phase: p, ...base }).decision, DELEGATION_DECISIONS.HOLD);

  // boundary array missing（runtime absent）
  p = readOnlyPhase({
    effects: completeEffects({
      boundaries: { artifact: [], external_system: [], evidence: [] },
    }),
  });
  const r = decideDelegation({ phase: p, ...base });
  assert.equal(r.decision, DELEGATION_DECISIONS.HOLD);
  assert.ok(r.reasons.includes(DELEGATION_DECISION_CODES.BOUNDARY_CONTRACT_INCOMPLETE));

  // invalid effect value（fail-closed enum）
  p = readOnlyPhase({ effects: completeEffects({ evidence_output: "sometimes" }) });
  assert.equal(decideDelegation({ phase: p, ...base }).decision, DELEGATION_DECISIONS.HOLD);
});

test("D3: writer capability with empty mutationScope → HOLD（authority unavailable）", () => {
  const r = decideDelegation({
    phase: writerPhase(),
    readySiblings: [],
    dependencyStates: {},
    admission: { mutation_scope: [] },
  });
  assert.equal(r.decision, DELEGATION_DECISIONS.HOLD);
  assert.ok(r.reasons.includes(DELEGATION_DECISION_CODES.WRITER_AUTHORITY_UNAVAILABLE));

  // missing mutation_scope field entirely is equally fail-closed
  const r2 = decideDelegation({
    phase: writerPhase(),
    readySiblings: [],
    dependencyStates: {},
    admission: {},
  });
  assert.equal(r2.decision, DELEGATION_DECISIONS.HOLD);

  // sanctioned non-empty scope clears the gate → not HOLD
  const ok = decideDelegation({
    phase: writerPhase(),
    readySiblings: [],
    dependencyStates: {},
    admission: ADMISSION,
  });
  assert.notEqual(ok.decision, DELEGATION_DECISIONS.HOLD);
});

test("D4: non-terminal dependency → SERIAL_DEPENDENCY（record-only semantics）", () => {
  const p = writerPhase({ depends_on: ["p_analysis"] });

  // pending dependency
  let r = decideDelegation({
    phase: p,
    readySiblings: [],
    dependencyStates: { p_analysis: "pending" },
    admission: ADMISSION,
  });
  assert.equal(r.decision, DELEGATION_DECISIONS.SERIAL_DEPENDENCY);
  assert.deepEqual(r.reasons, [`${DELEGATION_DECISION_CODES.NON_TERMINAL_DEPENDENCY}:p_analysis`]);

  // running dependency
  r = decideDelegation({
    phase: p,
    readySiblings: [],
    dependencyStates: { p_analysis: { status: "running" } },
    admission: ADMISSION,
  });
  assert.equal(r.decision, DELEGATION_DECISIONS.SERIAL_DEPENDENCY);

  // unknown dependency id（fail-closed → treated non-terminal）
  r = decideDelegation({
    phase: p,
    readySiblings: [],
    dependencyStates: {},
    admission: ADMISSION,
  });
  assert.equal(r.decision, DELEGATION_DECISIONS.SERIAL_DEPENDENCY);

  // terminal dependencies do NOT trigger serial
  r = decideDelegation({
    phase: p,
    readySiblings: [],
    dependencyStates: { p_analysis: "passed" },
    admission: ADMISSION,
  });
  assert.equal(r.decision, DELEGATION_DECISIONS.DELEGATE);
});

test("D5: read-only + zero artifact/evidence boundary intersection with every ready sibling → PARALLEL_DELEGATE", () => {
  const a = readOnlyPhase({
    phase_id: "p_a",
    effects: completeEffects({
      boundaries: { artifact: [], runtime: [], external_system: [], evidence: ["evidence/a/"] },
    }),
  });
  const b = readOnlyPhase({
    phase_id: "p_b",
    effects: completeEffects({
      boundaries: { artifact: [], runtime: [], external_system: [], evidence: ["evidence/b/"] },
    }),
  });
  const r = decideDelegation({
    phase: a,
    readySiblings: [b],
    dependencyStates: {},
    admission: ADMISSION,
  });
  assert.equal(r.decision, DELEGATION_DECISIONS.PARALLEL_DELEGATE);
  assert.deepEqual(r.reasons, [DELEGATION_DECISION_CODES.READ_ONLY_DISJOINT_BOUNDARIES]);

  // trailing slash is not an identity difference → overlap detected
  const b2 = readOnlyPhase({
    phase_id: "p_b2",
    effects: completeEffects({
      boundaries: { artifact: [], runtime: [], external_system: [], evidence: ["evidence/a"] },
    }),
  });
  const overlapped = decideDelegation({
    phase: a,
    readySiblings: [b2],
    dependencyStates: {},
    admission: ADMISSION,
  });
  assert.equal(overlapped.decision, DELEGATION_DECISIONS.DELEGATE);

  // unreadable sibling boundary（fail-closed: never claim parallel）
  const opaque = decideDelegation({
    phase: a,
    readySiblings: [{ phase_id: "p_opaque" }],
    dependencyStates: {},
    admission: ADMISSION,
  });
  assert.equal(opaque.decision, DELEGATION_DECISIONS.DELEGATE);
});

test("D6: single independent work unit with clear boundary → DELEGATE", () => {
  const r = decideDelegation({
    phase: writerPhase(),
    readySiblings: [readOnlyPhase()],
    dependencyStates: {},
    admission: ADMISSION,
  });
  assert.equal(r.decision, DELEGATION_DECISIONS.DELEGATE);
  assert.deepEqual(r.reasons, [DELEGATION_DECISION_CODES.INDEPENDENT_WORK_UNIT]);
});

test("D7: no mutation + no deps + explicitly declared trivial cost → INLINE", () => {
  const trivial = readOnlyPhase({ expected_execution_cost: "trivial" });
  const r = decideDelegation({
    phase: trivial,
    readySiblings: [],
    dependencyStates: {},
    admission: ADMISSION,
  });
  assert.equal(r.decision, DELEGATION_DECISIONS.INLINE);
  assert.deepEqual(r.reasons, [DELEGATION_DECISION_CODES.TRIVIAL_EXPECTED_EXECUTION_COST]);

  // cost must be an explicit field — never guessed; anything else is delegatable
  const undeclared = decideDelegation({
    phase: readOnlyPhase({ title: "quick trivial tiny check" }),
    readySiblings: [],
    dependencyStates: {},
    admission: ADMISSION,
  });
  assert.equal(undeclared.decision, DELEGATION_DECISIONS.PARALLEL_DELEGATE);
});

test("D8: determinism — identical inputs always produce identical output", () => {
  const input = () => ({
    phase: writerPhase({
      depends_on: ["p_a"],
      effects: completeEffects({
        artifact_mutation: "required",
        evidence_output: "persistent",
        boundaries: { artifact: ["src/x/"], runtime: [], external_system: [], evidence: ["evidence/x/"] },
      }),
    }),
    readySiblings: [
      readOnlyPhase({
        phase_id: "p_sib",
        effects: completeEffects({
          boundaries: { artifact: [], runtime: [], external_system: [], evidence: ["evidence/y/"] },
        }),
      }),
    ],
    dependencyStates: { p_a: "pending" },
    admission: { mutation_scope: ["src/x/"] },
  });
  const first = decideDelegation(input());
  for (let i = 0; i < 25; i++) {
    assert.deepEqual(decideDelegation(input()), first);
  }
  assert.equal(first.decision, DELEGATION_DECISIONS.SERIAL_DEPENDENCY);
});

// ── Part 2: orchestrator wiring ──

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "cedf-delegation-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function evidenceJson(request, overrides = {}) {
  const contractId = request?.taskCard?.executionId ?? FIXTURE_EVIDENCE.contract_id;
  return JSON.stringify({ ...FIXTURE_EVIDENCE, contract_id: contractId, ...overrides });
}

function verdictJson({ verdict, confidence = "HIGH", model = "test-model", summary = "ok", recommended_next_action } = {}) {
  return JSON.stringify({ verdict, confidence, model, summary, recommended_next_action });
}

function completed(stdout, executionId) {
  return { status: "completed", executionId, stdout, stderr: "", signal: null, error: null, metadata: { exitCode: 0 } };
}

const MANIFEST = [{ requirement_id: "R1", text: "analyze the current state" }];
const PARENT = { scope: { allowed_paths: ["src/"], forbidden_paths: [] } };

const HARNESS_HOOKS = {
  toolPolicy: { mode: "no-tools" },
  environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  expectedReviewerModel: "test-model",
  verificationCommand: ["node", "-e", "process.exit(0)"],
  expectedExecutorModel: "deepseek-v4-flash",
  expectedExecutorProvider: "deepseek",
};

function defaultFactories() {
  return {
    executorAdapterFactory: () => createScriptedAdapter([
      { expect: { phase: "executor", attempt: 0 }, result: (req) => completed(evidenceJson(req), "x") },
    ]),
    reviewerAdapterFactory: () => createScriptedAdapter([
      { expect: { phase: "reviewer", attempt: 0 }, result: completed(verdictJson({ verdict: "PASS", recommended_next_action: "STOP" }), "x") },
    ]),
  };
}

// IR matching test/v2 conventions, upgraded with complete verification plans
// so the delegation classifier can pass its own contract gates.
function delegationIr() {
  return {
    verdict: "DECOMPOSED",
    parent_goal: "goal",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [
      readOnlyPhase({
        phase_id: "p_analysis",
        effects: completeEffects({
          boundaries: { artifact: [], runtime: [], external_system: [], evidence: ["evidence/analysis/"] },
        }),
      }),
      writerPhase({ phase_id: "p_impl", depends_on: ["p_analysis"] }),
    ],
    dispositions: [],
    decomposition_evidence: ["test"],
  };
}

test("W1: WITHOUT hooks.delegation — existing behavior unchanged（no delegation records）", async () => {
  const cwd = gitFixture();
  try {
    const r = await runExecutionOrchestrator({
      ir: delegationIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_deleg_0000000000000000000000000001",
      ...defaultFactories(), hooks: HARNESS_HOOKS, maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "PASS");
    assert.equal(r.phaseResults.length, 2);
    assert.ok(r.phaseResults.every((p) => p.status === "passed"));
    assert.ok(r.phaseResults.every((p) => !("delegation" in p)), "no delegation record without the opt-in seam");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("W2: WITH hooks.delegation — every executed phase gets a recorded decision; PASS path unchanged", async () => {
  const cwd = gitFixture();
  try {
    const r = await runExecutionOrchestrator({
      ir: delegationIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_deleg_0000000000000000000000000002",
      ...defaultFactories(),
      hooks: {
        ...HARNESS_HOOKS,
        delegation: { admission: { mutation_scope: ["src/", "evidence/"] } },
      },
      maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "PASS");
    const byId = new Map(r.phaseResults.map((p) => [p.phaseId, p]));
    // read-only, no deps, sibling boundary disjoint at run time → PARALLEL_DELEGATE recorded
    assert.equal(byId.get("p_analysis").delegation.decision, DELEGATION_DECISIONS.PARALLEL_DELEGATE);
    // mutating phase whose deps are terminal → DELEGATE recorded
    assert.equal(byId.get("p_impl").delegation.decision, DELEGATION_DECISIONS.DELEGATE);
    assert.equal(byId.get("p_impl").status, "passed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("W3: decision=HOLD is enforced fail-closed → phase held with reason in detail", async () => {
  const cwd = gitFixture();
  try {
    let lifecycleEntered = false;
    const factories = {
      executorAdapterFactory: () => ({
        runAdapter: async () => {
          lifecycleEntered = true;
          return completed(evidenceJson({ taskCard: { executionId: "x" } }), "x");
        },
      }),
      reviewerAdapterFactory: () => createScriptedAdapter([]),
    };
    const r = await runExecutionOrchestrator({
      ir: delegationIr(), parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_deleg_0000000000000000000000000003",
      ...factories,
      hooks: {
        ...HARNESS_HOOKS,
        delegation: {}, // no admission → decideDelegation fails closed on every phase
      },
      maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(lifecycleEntered, false, "HOLD decision must block the lifecycle entirely");
    // The sealed runner skips descendants of a held phase — only p_analysis
    // reaches execute; p_impl is skipped_due_to_dependency（scheduling untouched）.
    assert.equal(r.phaseResults.length, 1);
    const pr = r.phaseResults[0];
    assert.equal(pr.phaseId, "p_analysis");
    assert.equal(pr.status, "held");
    assert.equal(pr.delegation.decision, DELEGATION_DECISIONS.HOLD);
    assert.match(pr.reason, /^DELEGATION_HOLD:ADMISSION_MISSING$/);
    assert.ok(r.scheduler.skipped.includes("p_impl"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("W4: PARALLEL_DELEGATE inconsistent with runner writer lease → downgrade reason recorded, scheduling untouched", async () => {
  const cwd = gitFixture();
  try {
    // Read-only by artifact_mutation but persistent repo-path evidence →
    // decideDelegation says PARALLEL_DELEGATE while requiresWriterLease(phase)
    // is true（evidence writer lease). The runner stays authoritative.
    // The artifact boundary stays non-empty（phase card hard gate）and disjoint
    // from the sibling's artifact/evidence boundary.
    const ir = delegationIr();
    ir.phases[0] = readOnlyPhase({
      phase_id: "p_analysis",
      effects: completeEffects({
        evidence_output: "persistent",
        boundaries: { artifact: ["src/analysis/"], runtime: [], external_system: [], evidence: ["evidence/analysis/"] },
      }),
    });
    ir.phases[1] = writerPhase({
      phase_id: "p_impl",
      depends_on: ["p_analysis"],
      effects: completeEffects({
        artifact_mutation: "required",
        evidence_output: "persistent",
        boundaries: { artifact: ["src/impl/"], runtime: [], external_system: [], evidence: ["evidence/impl/"] },
      }),
    });
    const r = await runExecutionOrchestrator({
      ir, parent: PARENT, manifest: MANIFEST, cwd,
      executionId: "exec_deleg_0000000000000000000000000004",
      ...defaultFactories(),
      hooks: {
        ...HARNESS_HOOKS,
        delegation: { admission: { mutation_scope: ["src/", "evidence/"] } },
      },
      maxRepairAttempts: 0, timeoutMs: 1000,
    });
    assert.equal(r.final, "PASS", "runner scheduling semantics unchanged");
    const byId = new Map(r.phaseResults.map((p) => [p.phaseId, p]));
    const d = byId.get("p_analysis").delegation;
    assert.equal(d.decision, DELEGATION_DECISIONS.PARALLEL_DELEGATE);
    assert.deepEqual(d.reasons, [
      DELEGATION_DECISION_CODES.READ_ONLY_DISJOINT_BOUNDARIES,
      "PARALLEL_DELEGATE_DOWNGRADED_BY_RUNNER_WRITER_LEASE",
    ]);
    assert.equal(r.scheduler.writerViolations.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
