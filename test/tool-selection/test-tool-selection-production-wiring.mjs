// test/tool-selection/test-tool-selection-production-wiring.mjs
//
// AUTOLOOP-V1-STAGE-C-TOOL-SELECTION-PRODUCTION-WIRING-1
// Binding test matrix T1–T34 (wiring card §8). Every test drives the NEW
// production seams:
//   runExecutionOrchestrator toolSelectionContext (THE orchestrator hook)
//   → buildPhaseTaskCard toolSelectionBind (single mint)
//   → executorAdapterFactory({ selectionAuthority }) (single authority wire)
//   → pi-rpc-adapter resolveToolSpawnArgs wired-strictness
// Offline except: T20's synthetic capture and any live graph E2E (colima).
// The only child process is test/fixtures/fake-pi-rpc.mjs via `node`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  projectToolSelection,
  validateToolSelection,
  createLifecycleSelectionAuthority,
  computeMappingDigest,
  parsePiBuiltinToolNames,
  buildAdmissionRecord,
  deriveExecutorRuntime,
  FROZEN_MAPPING_DIGEST,
  FROZEN_RUNTIME_VOCABULARY_DIGEST,
  FROZEN_RUNTIME_TOOL_NAMES,
  FROZEN_RUNTIME_IDENTITY,
  TOOL_SELECTION_MAPPING,
  TOOL_SELECTION_SCHEMA,
  PI_ADAPTER_KIND,
} from "../../src/admission/policy-projection.mjs";
import { freezeAdmission, deriveAdmissionId } from "../../src/admission/admission-record.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { digestOf } from "../../src/canonical-digest.mjs";
import { createPiRpcAdapter, DEFAULT_ENV_ALLOWLIST } from "../../src/adapter/pi-rpc-adapter.mjs";
import { buildPhaseTaskCard, phaseExecutionId } from "../../src/v2/phase-task-card.mjs";
import { runExecutionOrchestrator, ORCHESTRATOR_HOLD } from "../../src/v2/execution-orchestrator.mjs";
import { runLifecycle } from "../../src/lifecycle-runner.mjs";
import { captureScopeSnapshot } from "../../src/c2d/mutation-scope.mjs";
import { deriveScopePatterns } from "../../src/v2/phase-task-card.mjs";
import { coordinate, executeSequentially } from "../../src/control-plane/coordinator.mjs";
import { runAdmittedGraph, AUTHORITY_SEAM_RUNNER_KEYS } from "../../src/admission/admission-gate.mjs";
import { requiresWriterLease } from "../../src/v2/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "..", "fixtures", "fake-pi-rpc.mjs");
const EVIDENCE_FIXTURE = JSON.parse(
  readFileSync(resolve(HERE, "..", "fixtures", "implementation-evidence-valid.json"), "utf8"),
);

// ── shared helpers (same construction rules as the contract suite) ──────

const LOW_EVIDENCE = {
  affected_files: { score: 1, reasons: ["single file"] },
  affected_subsystems: { score: 0, reasons: ["docs only"] },
  dependency_depth: { score: 0, reasons: ["no deps"] },
  ambiguity: { score: 0, reasons: ["exact"] },
  expected_execution_steps: { score: 0, reasons: ["one edit"] },
  verification_burden: { score: 0, reasons: ["none"] },
  external_dependencies: { score: 0, reasons: ["none"] },
  concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 0, reasons: ["revert one file"] },
};
const HEAVY_EVIDENCE = {
  ...LOW_EVIDENCE,
  affected_files: { score: 6, reasons: ["multi-file"] },
  affected_subsystems: { score: 4, reasons: ["two subsystems"] },
  dependency_depth: { score: 3, reasons: ["some deps"] },
  ambiguity: { score: 3, reasons: ["moderate"] },
  expected_execution_steps: { score: 5, reasons: ["several edits"] },
  verification_burden: { score: 4, reasons: ["tests required"] },
};

function makeAdmission(taskId, kind = "fast") {
  if (kind === "heavy") {
    const c = classify({
      dimensionScores: HEAVY_EVIDENCE,
      riskSignals: scanRiskSignals("refactor module: modify database schema, delete legacy api endpoints"),
    });
    return freezeAdmission(buildAdmissionRecord({ taskId, classification: c, mutationScope: ["src/"] }));
  }
  const c = classify({ dimensionScores: LOW_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  return freezeAdmission(buildAdmissionRecord({ taskId, classification: c }));
}

function allocFor(admission, taskId, dims) {
  const a = {
    taskId,
    admissionId: admission.admission_id,
    dimensions: dims ?? {
      node_execution_count: 4, repair_attempt_count: 1, retry_count: 2,
      sub_agent_execution_count: 1, verifier_reviewer_attempts: 1, wall_clock_ms: 60000,
    },
  };
  return { ...a, allocationId: digestOf({ taskId: a.taskId, admissionId: a.admissionId, dimensions: a.dimensions }) };
}

const RT = { realpath: FROZEN_RUNTIME_IDENTITY.realpath, sha256: FROZEN_RUNTIME_IDENTITY.sha256, version: FROZEN_RUNTIME_IDENTITY.version };

function select(admission, { nodeRole = null, executionId = "exec_t", selectedAt = "2026-08-23T16:05:45.000Z", taskAllocation } = {}) {
  return projectToolSelection({
    admission,
    nodeRole,
    taskAllocation: taskAllocation ?? allocFor(admission, admission.task_id),
    runtimeIdentity: RT,
    runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
    executionId,
    selectedAt,
  });
}

/** Attacker-consistent re-signing per the frozen formula (recursive key sort). */
function reSign(selection, mutate) {
  const copy = JSON.parse(JSON.stringify(selection));
  mutate(copy);
  delete copy.selectionDigest; // validator digests over the field set EXCLUDING the digest
  const canon = JSON.stringify((function sort(x) {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  })(copy));
  copy.selectionDigest = createHash("sha256").update(`${TOOL_SELECTION_SCHEMA}\n${canon}\n`, "utf8").digest("hex");
  return copy;
}

function makeRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), "stagec-wiring-"));
  execFileSync("git", ["init", "-q", repo]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "placeholder.txt"), "writer boundary target\n");
  execFileSync("git", ["-C", repo, "config", "user.email", "wiring-test@autoloop.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "wiring-test"]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "baseline"]);
  t?.after?.(() => rmSync(repo, { recursive: true, force: true }));
  return repo;
}

function env() {
  return [...DEFAULT_ENV_ALLOWLIST, "FAKE_PI_CONTROL"];
}

const PASS_REVIEWER_TEXT = JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP" });

function withFakePi(control) {
  process.env.FAKE_PI_CONTROL = JSON.stringify(control);
  return () => delete process.env.FAKE_PI_CONTROL;
}

/** Recording wrapper around a REAL pi adapter for one role. */
function recordRole(adapter, log, role) {
  return {
    runAdapter: async (req) => {
      const res = await adapter.runAdapter(req);
      if (req.phase === role) log.push({ req, res });
      return res;
    },
  };
}


function taskCardHarnessFacts(card, repo) {
  card.environmentAllowlist = ["PATH", "HOME", "TMPDIR", "FAKE_PI_CONTROL"];
  card.expectedExecutorModel = "test-model";
  card.expectedExecutorProvider = "deepseek";
  card.verificationCommand = ["node", "-e", "process.exit(0)"];
  card.mutationScope = {
    repositoryRoot: repo,
    baselineSnapshot: captureScopeSnapshot(repo),
    allowedPaths: deriveScopePatterns(card.allowedPaths),
    forbiddenPaths: deriveScopePatterns(card.forbiddenPaths),
  };
  return card;
}

const READONLY_IR = (phaseId = "P1") => ({
  phases: [{ phase_id: phaseId, title: "wiring probe", purpose: "probe", covers: [], depends_on: [], effects: {} }],
});

const WRITER_IR = {
  phases: [{
    phase_id: "P1", title: "writer", purpose: "write", covers: [], depends_on: [],
    effects: { artifact_mutation: "required", boundaries: { artifact: ["src/"] } },
  }],
};

async function runWiredOrchestrator({
  admission, taskAllocation, repo, ir = READONLY_IR(), parentExecutionId = "exec_" + "cd".repeat(16),
  executorLog = [], reviewerFactoryArgs = [], extraHooks = {},
} = {}) {
  const cleanup = withFakePi({
    scenario: "normal",
    assistantTextByPhase: { executor: "wired executor done", reviewer: PASS_REVIEWER_TEXT },
  });
  try {
    let authoritySeen = null;
    const executorAdapterFactory = (factoryArg) => {
      authoritySeen = factoryArg ?? null;
      const base = createPiRpcAdapter({
        piExecutable: FIXTURE, environmentAllowlist: env(), graceMs: 150,
        ...(factoryArg?.selectionAuthority ? { selectionAuthority: factoryArg.selectionAuthority } : {}),
      });
      return recordRole({
        runAdapter: async (req) => {
          const res = await base.runAdapter(req);
          // Harness-owned evidence: a completing executor returns the strict
          // implementation-evidence document bound to THIS execution id.
          return res.status === "completed"
            ? { ...res, stdout: JSON.stringify({ ...EVIDENCE_FIXTURE, contract_id: req.taskCard.executionId }) }
            : res;
        },
      }, executorLog, "executor");
    };
    const reviewerAdapterFactory = (...factoryArg) => {
      reviewerFactoryArgs.push(factoryArg[0] ?? null);
      return recordRole(createPiRpcAdapter({ piExecutable: FIXTURE, environmentAllowlist: env(), graceMs: 150 }), executorLog, "reviewer");
    };
    const out = await runExecutionOrchestrator({
      ir,
      // Writer boundaries are REPO-RELATIVE canonical entries（the same form
      // canonicalRepositoryPath produces）; read-only phases ignore them.
      parent: { scope: { allowed_paths: ["src"], forbidden_paths: [] } },
      manifest: [],
      cwd: repo,
      executionId: parentExecutionId,
      executorAdapterFactory,
      reviewerAdapterFactory,
      maxRepairAttempts: 0,
      timeoutMs: 30000,
      toolSelectionContext: (admission && taskAllocation) ? { admission, taskAllocation } : null,
      // C4Q harness-owned facts flow through orchestrator hooks.
      hooks: {
        environmentAllowlist: env(),
        verificationCommand: ["node", "-e", "process.exit(0)"],
        expectedExecutorModel: "test-model",
        expectedExecutorProvider: "deepseek",
        ...extraHooks,
      },
    });
    return { out, authoritySeen };
  } finally {
    cleanup();
  }
}

// ═══════════════════════ T1–T5 · gap, default authority, bind truth ═════

test("T1 CURRENT_PRODUCTION_WIRING_GAP_REPRODUCED — absent context keeps the legacy composition observable", async (t) => {
  // Pre-wiring gap evidence (bundle probe-wiring-gap-output.txt): a tool-aware
  // Pi executor received toolPolicy=undefined and spawned via the LEGACY
  // --no-tools default. Post-wiring that composition is reachable ONLY via the
  // explicit no-context compat surface — production runners always forward the
  // admitted pair when present.
  const repo = makeRepo(t);
  const executorLog = [];
  const { authoritySeen } = await runWiredOrchestrator({ admission: null, taskAllocation: null, repo, executorLog });
  assert.equal(authoritySeen, null, "no context ⇒ no authority handed to factories");
  const execReq = executorLog.find((x) => x.req.phase === "executor");
  assert.ok(execReq);
  assert.equal(execReq.req.toolPolicy ?? null, null, "legacy composition carries no canonical bind");
  assert.equal(execReq.res.metadata.toolSelection ?? null, null, "no selection telemetry in legacy mode");
});

test("T2 PRODUCTION_DEFAULT_AUTHORITY_WIRED — context alone wires the canonical authority", async (t) => {
  const repo = makeRepo(t);
  const heavy = makeAdmission("T2", "heavy");
  const alloc = allocFor(heavy, heavy.task_id);
  const executorLog = [];
  const { authoritySeen } = await runWiredOrchestrator({ admission: heavy, taskAllocation: alloc, repo, executorLog });

  assert.ok(authoritySeen && typeof authoritySeen.selectionAuthority === "function", "factory received { selectionAuthority }");
  const execReq = executorLog.find((x) => x.req.phase === "executor");
  const carried = execReq.req.toolPolicy;
  assert.equal(carried.contractVersion, TOOL_SELECTION_SCHEMA);
  assert.equal(carried.taskIdentity.taskId, alloc.taskId);
  assert.equal(carried.admissionIdentity.admissionId, heavy.admission_id);
  // The authority resolves THIS invocation against the SAME authoritative pair.
  const binding = await authoritySeen.selectionAuthority({ executionId: carried.runIdentity });
  assert.equal(binding.taskId, alloc.taskId);
  assert.equal(binding.admissionId, heavy.admission_id);
  assert.equal(validateToolSelection(carried, { authorityBinding: binding }).ok, true);
});

test("T3 ORCHESTRATOR_BIND_PRESERVATION — minted selection reaches argv byte-identical", async (t) => {
  const repo = makeRepo(t);
  const heavy = makeAdmission("T3", "heavy");
  const alloc = allocFor(heavy, heavy.task_id);
  const executorLog = [];
  await runWiredOrchestrator({ admission: heavy, taskAllocation: alloc, repo, ir: WRITER_IR, executorLog });
  const execReq = executorLog.find((x) => x.req.phase === "executor");
  const carried = execReq.req.toolPolicy;
  assert.equal(Object.isFrozen(carried), true, "selection output is frozen at the mint");
  // Independent reproduction of THE selector over the SAME authoritative pair:
  const expected = projectToolSelection({
    admission: heavy,
    nodeRole: requiresWriterLease(WRITER_IR.phases[0]) ? "writer" : "readonly-analyst",
    taskAllocation: alloc,
    runtimeIdentity: RT, runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
    executionId: execReq.req.executionId,
    selectedAt: carried.selectedAt,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(carried)), JSON.parse(JSON.stringify(expected)),
    "orchestrator delivered the pure selector output unmodified (canonical byte-equivalence)");
});

test("T4 ORCHESTRATOR_CANNOT_RESELECT — no add/drop/rewrite seam exists", async () => {
  const src = readFileSync(resolve(process.cwd(), "src/v2/execution-orchestrator.mjs"), "utf8");
  for (const forbidden of [
    "projectToolSelection",           // the selector itself
    "canonicalizeNameSet",            // name-set rewriting
    "TOOL_SELECTION_MAPPING",         // second-mapping access
    "computeMappingDigest", "computeRegistryDigest",
    "adapterToolNames",               // direct array surgery
    "--tools", "--no-tools",          // argv-level vocabulary
    "bash",                           // Pi-only names in core orchestrator
  ]) {
    assert.equal(src.includes(forbidden), false, `orchestrator must not reference ${forbidden}`);
  }
  assert.ok(src.includes("createLifecycleSelectionAuthority"));
  assert.ok(src.includes("toolSelectionContext"));
});

test("T5 MISSING_BIND_FAILS_CLOSED — wired adapter holds pre-spawn with zero invocations", async (t) => {
  const repo = makeRepo(t);
  const cleanup = withFakePi({ scenario: "normal", assistantTextByPhase: { executor: "should never run" } });
  try {
    const fast = makeAdmission("T5");
    const auth = createLifecycleSelectionAuthority({ admission: fast, taskAllocation: allocFor(fast, fast.task_id) });
    const wired = createPiRpcAdapter({ piExecutable: FIXTURE, environmentAllowlist: env(), graceMs: 150, selectionAuthority: auth });
    const res = await wired.runAdapter({
      executionId: "exec_missing_bind", cwd: repo, phase: "executor", attempt: 0, timeoutMs: 5000,
      taskCard: { executionId: "exec_missing_bind" }, // NO canonical toolPolicy
    });
    assert.equal(res.status, "error");
    assert.equal(res.metadata.applied, false);
    assert.equal(res.metadata.toolInvocationCount, 0);
    assert.equal(res.metadata.selectionHoldCode, "TOOL_SELECTION_PROVENANCE_INVALID");
    assert.match(res.error, /no canonical toolSelectionBind/);
  } finally {
    cleanup();
  }
});

// ═══════════════════ T6–T9 · malformed / wrong-identity binds ═══════════

test("T6 MALFORMED_BIND_FAILS_CLOSED — orchestrator shape gate before any spawn", async (t) => {
  const repo = makeRepo(t);
  for (const bad of [42, "x", [], {}, { admission: {} }, { taskAllocation: {} }]) {
    const out = await runExecutionOrchestrator({
      ir: READONLY_IR(), parent: { scope: { allowed_paths: [repo], forbidden_paths: [] } },
      manifest: [], cwd: repo, executionId: "exec_bad", maxRepairAttempts: 0, timeoutMs: 1000,
      executorAdapterFactory: () => { throw new Error("SPAWNED"); },
      reviewerAdapterFactory: () => { throw new Error("SPAWNED"); },
      toolSelectionContext: bad,
    });
    assert.equal(out.final, "HOLD");
    assert.equal(out.holdCode, ORCHESTRATOR_HOLD.TOOL_SELECTION_CONTEXT_INVALID, `context ${JSON.stringify(bad)} rejected`);
    assert.equal(out.phaseResults.length, 0, "no phase started");
    assert.equal(out.transitions.length, 0, "no adapter ever constructed");
  }
  assert.throws(() => buildPhaseTaskCard({
    phase: READONLY_IR().phases[0], parent: { scope: { allowed_paths: [repo], forbidden_paths: [] } },
    cwd: repo, executionId: "p", maxRepairAttempts: 0,
    toolSelectionBind: { admission: {} },
  }), (e) => e.code === "PHASE_TOOL_SELECTION_BIND_REJECTED");
});

test("T7 WRONG_TASK_BIND_FAILS_CLOSED", async () => {
  const a = makeAdmission("T7-A", "heavy");
  const b = makeAdmission("T7-B", "heavy");
  const selA = select(a, { nodeRole: "writer", executionId: "exec_t7" });
  const authB = createLifecycleSelectionAuthority({ admission: b, taskAllocation: allocFor(b, b.task_id) });
  const verdict = validateToolSelection(selA, { authorityBinding: await authB({ executionId: "exec_t7" }) });
  assert.equal(verdict.ok, false);
});

test("T8 WRONG_RUN_BIND_FAILS_CLOSED", async () => {
  const a = makeAdmission("T8", "heavy");
  const sel = select(a, { nodeRole: "writer", executionId: "exec_run_1" });
  const auth = createLifecycleSelectionAuthority({ admission: a, taskAllocation: allocFor(a, a.task_id) });
  const verdict = validateToolSelection(sel, { authorityBinding: await auth({ executionId: "exec_run_2" }) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /runIdentity/);
});

test("T9 WRONG_ADMISSION_BIND_FAILS_CLOSED", async () => {
  const a = makeAdmission("T9-A", "heavy");
  const c = makeAdmission("T9-C", "heavy");
  const selA = select(a, { nodeRole: "writer", executionId: "exec_t9" });
  const authC = createLifecycleSelectionAuthority({ admission: c, taskAllocation: allocFor(c, c.task_id) });
  const verdict = validateToolSelection(selA, { authorityBinding: await authC({ executionId: "exec_t9" }) });
  assert.equal(verdict.ok, false);
});

// ═══════════════ T10–T14 · stale digests / kind fencing / replay ════════

async function forgedVerdict(admission, selection, mutate, executionId) {
  const auth = createLifecycleSelectionAuthority({ admission, taskAllocation: allocFor(admission, admission.task_id) });
  return validateToolSelection(reSign(selection, mutate), { authorityBinding: await auth({ executionId }) });
}

test("T10 STALE_REGISTRY_DIGEST_FAILS_CLOSED — recomputed, never trusted", async () => {
  const a = makeAdmission("T10", "heavy");
  const sel = select(a, { nodeRole: "writer", executionId: "exec_t10" });
  const verdict = await forgedVerdict(a, sel, (m) => { m.registryDigest = "f".repeat(64); }, "exec_t10");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /registryDigest/);
});

test("T11 STALE_MAPPING_DIGEST_FAILS_CLOSED", async () => {
  const a = makeAdmission("T11", "heavy");
  const sel = select(a, { nodeRole: "writer", executionId: "exec_t11" });
  const verdict = await forgedVerdict(a, sel, (m) => { m.mappingDigest = computeMappingDigest([]); }, "exec_t11");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /mappingDigest/);
});

test("T12 STALE_RUNTIME_VOCABULARY_FAILS_CLOSED", async () => {
  const a = makeAdmission("T12", "heavy");
  const sel = select(a, { nodeRole: "writer", executionId: "exec_t12" });
  for (const mutate of [
    (m) => { m.runtimeVocabularyDigest = "0".repeat(64); },
    (m) => { m.runtimeIdentity.sha256 = "1".repeat(64); },
  ]) {
    const verdict = await forgedVerdict(a, sel, mutate, "exec_t12");
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT");
  }
});

test("T13 UNKNOWN_ADAPTER_KIND_FAILS_CLOSED", async () => {
  const a = makeAdmission("T13", "heavy");
  const sel = select(a, { nodeRole: "writer", executionId: "exec_t13" });
  const verdict = await forgedVerdict(a, sel, (m) => { m.adapterKind = "omp"; }, "exec_t13");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /adapterKind/);
});

test("T14 CROSS_ADAPTER_REPLAY_FAILS_CLOSED — kind-scoped rows cannot widen pi payloads", async () => {
  const a = makeAdmission("T14", "heavy");
  const sel = select(a, { nodeRole: "writer", executionId: "exec_t14" });
  const verdict = await forgedVerdict(a, sel, (m) => { m.adapterToolNames = ["omp_write_file"]; }, "exec_t14");
  assert.equal(verdict.ok, false);
});

// ══════════════ T15–T17 · caller injection fences ═══════════════════════

test("T15 CALLER_RAW_TOOL_POLICY_REJECTED — hooks.toolPolicy never survives a wired dispatch", async (t) => {
  const repo = makeRepo(t);
  const heavy = makeAdmission("T15", "heavy");
  const alloc = allocFor(heavy, heavy.task_id);
  const executorLog = [];
  await runWiredOrchestrator({
    admission: heavy, taskAllocation: alloc, repo, executorLog,
    extraHooks: { toolPolicy: { mode: "allowlist", tools: ["bash"] } },
  });
  const execReq = executorLog.find((x) => x.req.phase === "executor");
  assert.equal(execReq.req.toolPolicy.mode, undefined, "raw caller shape discarded");
  assert.equal(execReq.req.toolPolicy.contractVersion, TOOL_SELECTION_SCHEMA, "canonical mint carried instead");
  assert.equal(execReq.req.toolPolicy.adapterToolNames.includes("bash"), false);
});

test("T16 CALLER_SELECTION_AUTHORITY_INJECTION_REJECTED — sink-level fence", async () => {
  const fast = makeAdmission("T16");
  const spyRunner = async () => ({ final: "PASS", executionId: "g", nodeResults: [], transitions: [], closeout: { applied: false } });
  const smuggleCtx = await runAdmittedGraph({
    admission: fast, runner: spyRunner, ir: { phases: [] },
    toolSelectionContext: { admission: fast, taskAllocation: allocFor(fast, fast.task_id) },
  });
  assert.equal(smuggleCtx.final, "HOLD");
  assert.equal(smuggleCtx.holdCode, "AUTHORITY_SEAM_OVERRIDE_REJECTED");
  assert.ok(AUTHORITY_SEAM_RUNNER_KEYS.includes("toolSelectionContext"));
  assert.ok(AUTHORITY_SEAM_RUNNER_KEYS.includes("selectionAuthority"));

  // Coordinator sink rejects the same keys through runnerOpts.
  const { ok, plan } = coordinate({
    tasks: [{
      id: "T16", admission: fast,
      remaining: { node_execution_count: 1 }, lifecycleState: "EXECUTING",
      runnerOpts: { selectionAuthority: async () => ({}) },
    }],
  });
  assert.equal(ok, true);
  const dispatched = await executeSequentially({ plan });
  assert.equal(dispatched.results[0].dispatched, false);
  assert.equal(dispatched.results[0].holdCode, "CP_AUTHORITY_OVERRIDE_REJECTED",
    `got ${JSON.stringify(dispatched.results[0])}`);
});

test("T17 CALLER_FACTORY_OVERRIDE_UNREACHABLE_IN_PRODUCTION — authority arg provenance", async (t) => {
  const repo = makeRepo(t);
  const heavy = makeAdmission("T17", "heavy");
  const alloc = allocFor(heavy, heavy.task_id);
  const executorLog = [];
  const reviewerFactoryArgs = [];
  const { authoritySeen } = await runWiredOrchestrator({
    admission: heavy, taskAllocation: alloc, repo, executorLog, reviewerFactoryArgs,
    extraHooks: { selectionAuthority: async () => ({ taskId: "ATTACKER" }) },
  });
  // The factory argument is the ORCHESTRATOR-created resolver over the
  // authoritative pair — hooks-supplied lookalikes are ignored entirely.
  assert.ok(typeof authoritySeen.selectionAuthority === "function");
  const binding = await authoritySeen.selectionAuthority({ executionId: "exec_whatever" });
  assert.equal(binding.taskId, heavy.task_id, "authority closes over the admitted pair, not hook data");
  assert.equal(binding.admissionId, heavy.admission_id);
  assert.equal(reviewerFactoryArgs.length > 0, true, "reviewer factory observed");
  assert.equal(reviewerFactoryArgs.every((a) => a === null || a === undefined), true,
    "reviewer factory NEVER receives an authority argument");
});

// ═══════════════ T18–T22 · exact argv semantics ═════════════════════════

test("T18 EXACT_SELECTED_ARGV — spawn argv equals the canonical subset exactly", async (t) => {
  const repo = makeRepo(t);
  const heavy = makeAdmission("T18", "heavy");
  const alloc = allocFor(heavy, heavy.task_id);
  const executorLog = [];
  const cleanup = withFakePi({ scenario: "normal", assistantTextByPhase: { executor: "done", reviewer: PASS_REVIEWER_TEXT } });
  try {
    await runExecutionOrchestrator({
      ir: WRITER_IR,
      parent: { scope: { allowed_paths: ["src"], forbidden_paths: [] } },
      manifest: [], cwd: repo, executionId: "exec_" + "ef".repeat(16),
      executorAdapterFactory: (a) => recordRole(createPiRpcAdapter({
        piExecutable: FIXTURE, environmentAllowlist: env(), graceMs: 150,
        ...(a?.selectionAuthority ? { selectionAuthority: a.selectionAuthority } : {}),
      }), executorLog, "executor"),
      reviewerAdapterFactory: () => createPiRpcAdapter({ piExecutable: FIXTURE, environmentAllowlist: env(), graceMs: 150 }),
      maxRepairAttempts: 0, timeoutMs: 30000,
      toolSelectionContext: { admission: heavy, taskAllocation: alloc },
      hooks: { environmentAllowlist: env() },
    });
    const execReq = executorLog.find((x) => x.req.phase === "executor");
    const carried = execReq.req.toolPolicy;
    const auth = createLifecycleSelectionAuthority({ admission: heavy, taskAllocation: alloc });
    const verdict = validateToolSelection(carried, { authorityBinding: await auth({ executionId: execReq.req.executionId }) });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.reason ?? ""));
    const args = execReq.res.metadata.args;
    const ti = args.indexOf("--tools");
    assert.ok(ti >= 0, "nonempty derivation ⇒ --tools present");
    assert.deepEqual(args.slice(ti, ti + 2), ["--tools", verdict.argvToolNames.join(",")]);
    assert.equal(args.includes("--no-tools"), false);
  } finally {
    cleanup();
  }
});

test("T19 BASH_NEVER_SELECTED — unmapped arbitrary-execution surface unreachable", () => {
  for (const kind of ["fast", "heavy"]) {
    for (const role of [null, "readonly-analyst", "writer", "repairer", "verifier"]) {
      const a = makeAdmission(`T19-${kind}-${role}`, kind);
      let s = null;
      try {
        s = select(a, { nodeRole: role, executionId: "exec_t19", selectedAt: undefined });
      } catch (e) {
        // Unauthorized/missing-intent combinations fail closed BEFORE any
        // name exists — equally bash-free outcomes.
        assert.match(String(e?.code ?? e), /TOOL_SELECTION_/);
        continue;
      }
      assert.equal(s.adapterToolNames.includes("bash"), false);
      assert.equal(s.canonicalToolIds.includes("bash"), false);
    }
  }
  const src = readFileSync(resolve(process.cwd(), "src/admission/policy-projection.mjs"), "utf8");
  assert.ok(/UNMAPPED/.test(src), "mapping keeps bash explicitly unmapped");
});

test("T20 RUNTIME_EXTRA_TOOL_NEVER_SELECTED — unrecognized runtime surface ignored", () => {
  // Bullet-surface help text exposing an EXTRA builtin: parsing yields it, the
  // frozen vocabulary/digest do not move, and no mapping row can carry it.
  const synthetic = [
    "Usage: pi [options]",
    "",
    "Built-in Tool Names:",
    "  read - Read files from disk",
    "  bash - Run shell commands",
    "  edit - Edit files",
    "  write - Write files",
    "  grep - Search file contents",
    "  find - Find files",
    "  ls - List directories",
    "  zz-extra-tool - Sneaky extra surface",
    "",
    "Options:",
    "  --help  show help",
  ].join("\n");
  const parsed = parsePiBuiltinToolNames(synthetic);
  assert.ok(Array.isArray(parsed) && parsed.includes("zz-extra-tool"));
  assert.equal(FROZEN_RUNTIME_TOOL_NAMES.includes("zz-extra-tool"), false);
  const mapped = new Set(TOOL_SELECTION_MAPPING.filter((r) => r.status === "ACTIVE").flatMap((r) => r.adapterToolNames));
  assert.equal(mapped.has("zz-extra-tool"), false, "no row maps an unrecognized runtime tool");
});

test("T21 LEGITIMATE_NO_TOOLS — FAST_PATH emptiness arises from THE FORMULA", async (t) => {
  const repo = makeRepo(t);
  const fast = makeAdmission("T21");
  const alloc = allocFor(fast, fast.task_id);
  // §6.1: direct execution has NO sub-agent role ⇒ intent = the admission's
  // own tool_permissions upper bound. FAST_PATH grants none ⇒ honest empty.
  const s = select(fast, { nodeRole: null, executionId: "exec_t21_adapter", selectedAt: undefined });
  assert.equal(s.selectionBasis, "LEGITIMATE_EMPTY");
  assert.deepEqual(s.adapterToolNames, []);
  // The wired adapter honors it exactly: argv --no-tools + NOT_SELECTED truth.
  const cleanup = withFakePi({ scenario: "normal", assistantTextByPhase: { executor: "never offers tools anyway" } });
  try {
    const auth = createLifecycleSelectionAuthority({ admission: fast, taskAllocation: alloc });
    const adapter = createPiRpcAdapter({ piExecutable: FIXTURE, environmentAllowlist: env(), graceMs: 150, selectionAuthority: auth });
    const res = await adapter.runAdapter({
      executionId: "exec_t21_adapter", cwd: repo, phase: "executor", attempt: 0, timeoutMs: 8000,
      taskCard: { executionId: "exec_t21_adapter" },
      toolPolicy: s,
    });
    assert.equal(res.status, "completed");
    assert.equal(res.metadata.args.includes("--no-tools"), true);
    assert.equal(res.metadata.args.includes("--tools"), false);
    assert.deepEqual(res.metadata.toolSelection, {
      selectionBasis: "LEGITIMATE_EMPTY", adapterToolNames: [], telemetryState: "NOT_SELECTED",
    });
    // Formula property: heavier grants derive real names through THE SAME
    // formula — no code path special-cases FAST_PATH.
    const heavySel = select(makeAdmission("T21h", "heavy"), { nodeRole: "writer", executionId: "exec_t21h", selectedAt: undefined });
    assert.equal(heavySel.selectionBasis, "DERIVED_SELECTION");
  } finally {
    cleanup();
  }
});

test("T22 REQUIRED_TOOL_MISSING_IS_HOLD — revoked grant never degrades to no-tools success", async (t) => {
  const repo = makeRepo(t);
  // Admission whose envelope projects tools while its registry-active grants
  // carry NONE: the intersection drops every intent permission ⇒ REVOKED.
  const c = classify({
    dimensionScores: HEAVY_EVIDENCE,
    riskSignals: scanRiskSignals("refactor module: modify database schema"),
  });
  const rec = buildAdmissionRecord({ taskId: "T22", classification: c, mutationScope: ["src/"] });
  rec.capabilities = { required: ["CAP.DIRECT_EXECUTION"], allowed: [], denied: [] }; // grants no tools
  rec.tool_permissions = ["READ_ONLY", "SCRATCH_WRITE"];                              // intent projects tools
  rec.admission_id = deriveAdmissionId(rec);
  // Orchestrator-level seam test: the record is schema-shaped but NOT
  // production-frozen here — this seam exercises THE MINT'S fail-closed path.
  const revokedAdmission = rec;
  const alloc = allocFor(revokedAdmission, "T22");

  const spawned = [];
  const out = await runExecutionOrchestrator({
    ir: READONLY_IR(),
    parent: { scope: { allowed_paths: [repo], forbidden_paths: [] } },
    manifest: [], cwd: repo, executionId: "exec_" + "ab".repeat(16),
    executorAdapterFactory: () => ({ runAdapter: async (req) => { spawned.push(req); return { status: "completed", executionId: req.executionId, stdout: "{}", stderr: "", signal: null, error: null, metadata: {} }; } }),
    reviewerAdapterFactory: () => ({ runAdapter: async (req) => ({ status: "completed", executionId: req.executionId, stdout: "", stderr: "", signal: null, error: null, metadata: {} }) }),
    maxRepairAttempts: 0, timeoutMs: 5000,
    toolSelectionContext: { admission: revokedAdmission, taskAllocation: alloc },
  });
  assert.equal(out.final, "HOLD");
  const transition = out.transitions.find((x) => x.phaseId === "P1");
  assert.match(transition.reason, /TOOL_SELECTION_TOOL_REVOKED$/, `truthful selector code surfaced (got ${transition.reason})`);
  assert.equal(spawned.length, 0, "fail closed BEFORE any adapter invocation");
});

// ══════════════ T23–T25 · path wiring (direct / graph / v2) ═════════════

test("T23 DIRECT_PATH_WIRED — SOP direct runner mints the bind through the coordinator chain", async (t) => {
  const repo = makeRepo(t);
  const fast = makeAdmission("T23");
  const cleanup = withFakePi({
    scenario: "normal",
    assistantTextByPhase: { executor: "direct wired done", reviewer: PASS_REVIEWER_TEXT },
  });
  try {
    const DIMS = { node_execution_count: 4, repair_attempt_count: 1, retry_count: 2, sub_agent_execution_count: 1, verifier_reviewer_attempts: 1, wall_clock_ms: 60000 };
    const parentExecutionId = "exec_" + "9b".repeat(16);
    const executionId = phaseExecutionId(parentExecutionId, "DIRECT_EXECUTION");
    const taskCard = {
      executionId, parentExecutionId, phaseId: "DIRECT_EXECUTION",
      repositoryRoot: repo, title: "direct wiring",
    };
    // Harness-owned evidence facts（C4Q）on the direct-path card.
    taskCard.environmentAllowlist = ["PATH", "HOME", "TMPDIR", "FAKE_PI_CONTROL"];
    taskCard.expectedExecutorModel = "test-model";
    taskCard.expectedExecutorProvider = "deepseek";
    taskCard.verificationCommand = ["node", "-e", "process.exit(0)"];
    taskCard.mutationScope = {
      repositoryRoot: repo,
      baselineSnapshot: captureScopeSnapshot(repo),
      allowedPaths: [], forbiddenPaths: [],
    };
    let constructedWith = null;
    const { ok, plan } = coordinate({
      tasks: [{
        id: "T23", admission: fast, remaining: { ...DIMS }, lifecycleState: "EXECUTING",
        runnerOpts: {
          taskCard, cwd: repo, timeoutMs: 30000, maxRepairAttempts: 0,
          executorAdapterFactory: (arg) => {
            constructedWith = arg ?? null;
            const base = createPiRpcAdapter({ piExecutable: FIXTURE, environmentAllowlist: env(), graceMs: 150, ...(arg ?? {}) });
            return {
              runAdapter: async (req) => {
                const res = await base.runAdapter(req);
                return res.status === "completed"
                  ? { ...res, stdout: JSON.stringify({ ...EVIDENCE_FIXTURE, contract_id: req.taskCard.executionId }) }
                  : res;
              },
            };
          },
          reviewerAdapter: createPiRpcAdapter({ piExecutable: FIXTURE, environmentAllowlist: env(), graceMs: 150 }),
        },
      }],
      globalBudget: { dimensions: { ...DIMS } },
    });
    assert.equal(ok, true);
    const planTask = plan.tasks[0];
    assert.equal(planTask.runtime, "direct");
    assert.ok(planTask.taskAllocation?.allocationId);

    // Production-default composition: NO manual toolPolicy assignment — the
    // runner mints the bind from the runAdmittedGraph-injected pair.
    const dispatched = await executeSequentially({ plan });
    const r = dispatched.results[0];
    assert.equal(r.dispatched, true, `dispatched (${r.holdCode ?? ""} ${r.reason ?? ""})`);
    assert.equal(r.result?.final, "PASS", `terminal PASS (${r.result?.holdCode ?? ""}/${r.result?.reason ?? ""})`);
    assert.ok(constructedWith && typeof constructedWith.selectionAuthority === "function", "direct factory received the selection authority");
    assert.ok(r.result.lifecycle?.final === "PASS");
  } finally {
    cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("T24 GRAPH_PATH_WIRING — colima runner forwards the pair to the orchestrator", () => {
  const src = readFileSync(resolve(process.cwd(), "src/runtime/colima-graph-runner.mjs"), "utf8");
  assert.match(src, /toolSelectionContext:\s*\(admission && budget\?\.allocation\)/);
  assert.match(src, /\{ admission, taskAllocation: budget\.allocation \}/);
  const orch = readFileSync(resolve(process.cwd(), "src/v2/execution-orchestrator.mjs"), "utf8");
  assert.match(orch, /toolSelectionBind:\s*selectionAuthority/);
  assert.doesNotMatch(orch, /hooks\.toolSelectionContext/);
});

test("T25 V2_ORCHESTRATOR_WIRING — wired v2 run validates end-to-end through lifecycle", async (t) => {
  const repo = makeRepo(t);
  const heavy = makeAdmission("T25", "heavy");
  const alloc = allocFor(heavy, heavy.task_id);
  const executorLog = [];
  const reviewerLog2 = [];
  const { authoritySeen } = await runWiredOrchestrator({ admission: heavy, taskAllocation: alloc, repo, ir: WRITER_IR, executorLog });
  const execReq = executorLog.find((x) => x.req.phase === "executor");
  const revReq = executorLog.find((x) => x.req.phase === "reviewer");
  assert.ok(execReq, "executor ran through the wired seam");
  assert.ok(revReq, "lifecycle reached the reviewer stage");
  const binding = await authoritySeen.selectionAuthority({ executionId: execReq.req.executionId });
  assert.equal(validateToolSelection(execReq.req.toolPolicy, { authorityBinding: binding }).ok, true);
});

// ═══════════ T26–T27 · retry / repair bind idempotency ══════════════════

test("T26/T27 RETRY_REPAIR_BIND_IDEMPOTENCY — same frozen bind across attempts", async (t) => {
  const repo = makeRepo(t);
  const heavy = makeAdmission("T26", "heavy");
  const alloc = allocFor(heavy, heavy.task_id);
  const seenPolicies = [];
  let calls = 0;
  const flakyExecutor = {
    runAdapter: async (req) => {
      calls += 1;
      seenPolicies.push(req.toolPolicy);
      return { status: "completed", executionId: req.executionId, stdout: JSON.stringify({ ...EVIDENCE_FIXTURE, contract_id: req.taskCard.executionId }), stderr: "", signal: null, error: null, metadata: {} };
    },
  };
  // Attempt 0: deterministic reviewer says REPAIR ⇒ attempt 1 reuses THE bind.
  const verdicts = [
    JSON.stringify({ verdict: "HOLD", confidence: "HIGH", model: "test-model", summary: "needs repair", recommended_next_action: "REPAIR" }),
    PASS_REVIEWER_TEXT,
  ];
  let reviewIdx = 0;
  const reviewer = { runAdapter: async (req) => ({ status: "completed", executionId: req.executionId, stdout: verdicts[Math.min(reviewIdx++, 1)], stderr: "", signal: null, error: null, metadata: {} }) };
  const card = buildPhaseTaskCard({
    phase: { phase_id: "P1", title: "repair", purpose: "p", covers: [], depends_on: [], effects: {} },
    parent: { scope: { allowed_paths: [repo], forbidden_paths: [] } },
    executionId: "exec_" + "aa".repeat(16), cwd: repo, maxRepairAttempts: 1,
    toolSelectionBind: { admission: heavy, taskAllocation: alloc },
  });
  // Harness-owned evidence facts（C4Q）— identical to the orchestrator wiring.
  card.environmentAllowlist = ["PATH", "HOME", "TMPDIR", "FAKE_PI_CONTROL"];
  card.expectedExecutorModel = "test-model";
  card.expectedExecutorProvider = "deepseek";
  card.verificationCommand = ["node", "-e", "process.exit(0)"];
  taskCardHarnessFacts(card, repo);
  const lifecycle = await runLifecycle({
    cwd: repo, taskCard: card,
    executorAdapter: flakyExecutor, reviewerAdapter: reviewer,
    maxRepairAttempts: 1, timeoutMs: 20000,
  });
  assert.equal(lifecycle.final, "PASS", `lifecycle ${lifecycle.final}:${lifecycle.reason ?? ""}`);
  assert.equal(seenPolicies.length, 2, "executor invoked twice (initial + repair)");
  assert.ok(seenPolicies[0] === seenPolicies[1], "repair reuses the SAME frozen selection object (idempotent bind)");
  assert.equal(Object.isFrozen(seenPolicies[0]), true);
});

// ═══════════ T28–T30 · reviewer pin, failure truth, telemetry ═══════════

test("T28 REVIEWER_REMAINS_NO_TOOLS under a fully wired executor selection", async (t) => {
  const repo = makeRepo(t);
  const heavy = makeAdmission("T28", "heavy");
  const alloc = allocFor(heavy, heavy.task_id);
  const executorLog = [];
  const reviewerFactoryArgs = [];
  await runWiredOrchestrator({ admission: heavy, taskAllocation: alloc, repo, ir: WRITER_IR, executorLog, reviewerFactoryArgs });
  const execReq = executorLog.find((x) => x.req.phase === "executor");
  const revReq = executorLog.find((x) => x.req.phase === "reviewer");
  assert.equal(execReq.req.toolPolicy.contractVersion, TOOL_SELECTION_SCHEMA);
  assert.deepEqual(revReq.req.toolPolicy, { mode: "no-tools" }, "hard-pinned reviewer policy untouched");
  assert.equal(revReq.res.metadata.args.includes("--tools"), false);
  assert.equal(reviewerFactoryArgs.every((a) => a === null || a === undefined), true,
    "reviewer factory never receives the executor authority");
});

test("T29 TOOL_FAILURE_TRUTH — exception/malformed result never becomes PASS", async (t) => {
  const repo = makeRepo(t);
  const heavy = makeAdmission("T29", "heavy");
  const alloc = allocFor(heavy, heavy.task_id);
  for (const stdout of ["totally malformed {{"]) {
    const executor = { runAdapter: async (req) => ({ status: "completed", executionId: req.executionId, stdout, stderr: "", signal: null, error: null, metadata: {} }) };
    const reviewer = { runAdapter: async (req) => ({ status: "completed", executionId: req.executionId, stdout: PASS_REVIEWER_TEXT, stderr: "", signal: null, error: null, metadata: {} }) };
    const card = buildPhaseTaskCard({
      phase: { phase_id: "P1", title: "t", purpose: "p", covers: [], depends_on: [], effects: {} },
      parent: { scope: { allowed_paths: [repo], forbidden_paths: [] } },
      executionId: "exec_" + "bb".repeat(16), cwd: repo, maxRepairAttempts: 0,
      toolSelectionBind: { admission: heavy, taskAllocation: alloc },
    });
    const lifecycle = await runLifecycle({
      cwd: repo, taskCard: card, executorAdapter: executor, reviewerAdapter: reviewer,
      maxRepairAttempts: 0, timeoutMs: 10000,
    });
    assert.equal(lifecycle.final, "HOLD", `stdout ${stdout.slice(0, 20)} must HOLD`);
  }
});

test("T30 TELEMETRY_IDENTITY_TRUTH — published identities equal the carried selection", async (t) => {
  const repo = makeRepo(t);
  const heavy = makeAdmission("T30", "heavy");
  const alloc = allocFor(heavy, heavy.task_id);
  const executorLog = [];
  await runWiredOrchestrator({ admission: heavy, taskAllocation: alloc, repo, ir: WRITER_IR, executorLog });
  const execReq = executorLog.find((x) => x.req.phase === "executor");
  const meta = execReq.res.metadata;
  const carried = execReq.req.toolPolicy;
  assert.deepEqual(meta.toolSelection.adapterToolNames, carried.adapterToolNames, "published names == carried names");
  assert.equal(meta.toolSelection.selectionBasis, carried.selectionBasis);
  assert.equal(meta.toolSelection.telemetryState, carried.selectionBasis === "LEGITIMATE_EMPTY" ? "NOT_SELECTED" : "SELECTED");
  assert.equal(meta.toolSelection.telemetryState === "SELECTED", meta.args.includes("--tools"));
});

// ═══════════ T31–T34 · single-authority + portability static proofs ═════

test("T31 SINGLE_SELECTOR_AUTHORITY — one selector module, bounded consumers", () => {
  const find = (pat) => execFileSync("grep", ["-rlF", pat, "src/", "--include=*.mjs"], { cwd: process.cwd() })
    .toString().trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(find("projectToolSelection("),
    ["src/v2/phase-task-card.mjs", "src/admission/policy-projection.mjs"].sort(),
    "THE selector is referenced only by its definition and THE single mint");
  assert.deepEqual(find("validateToolSelection("),
    ["src/admission/policy-projection.mjs", "src/adapter/pi-rpc-adapter.mjs", "src/v2/durable-graph.mjs"].sort(),
    "THE validator is referenced by its definition, THE pi adapter boundary, and the " +
    "durable-resume continuity gate (AUTOLOOP-V1-STAGE-C-DURABLE-RESUME-TOOL-SELECTION-" +
    "BIND-CONTINUITY-REPAIR-1): resume reconstruction reuses THE validator — never a copy");
});

test("T32 SINGLE_ADAPTER_FACTORY_WIRING_SEAM — one pi factory; authorities flow from two named seams", () => {
  const find = (pat) => execFileSync("grep", ["-rlF", pat, "src/", "--include=*.mjs"], { cwd: process.cwd() })
    .toString().trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(find("export function createPiRpcAdapter"), ["src/adapter/pi-rpc-adapter.mjs"]);
  assert.deepEqual(
    find("createLifecycleSelectionAuthority(").filter((f) => f !== "src/admission/policy-projection.mjs").sort(),
    ["src/sop/proportional-sop.mjs", "src/v2/execution-orchestrator.mjs"].sort(),
    "only the orchestrator hook and the SOP direct runner create authorities");
});

test("T33 PI_NAMES_ABSENT_FROM_CORE_ORCHESTRATOR", () => {
  for (const f of ["src/v2/execution-orchestrator.mjs", "src/control-plane/coordinator.mjs", "src/lifecycle-runner.mjs"]) {
    const src = readFileSync(resolve(process.cwd(), f), "utf8");
    for (const token of ["--mode rpc", "--tools", "--no-tools", "pi-coding-agent", "cli.js", '"bash"', "'bash'"]) {
      assert.equal(src.includes(token), false, `${f} must not contain ${token}`);
    }
  }
});

test("T34 FUTURE_ADAPTER_PORTABILITY_STATIC_PROOF — omp/codex need rows, never core authorities", () => {
  // Kind-scoped projection: adding hypothetical omp rows to the SAME mapping
  // authority leaves every pi-builtin digest/name-set unchanged.
  const ompRows = [{
    canonicalToolId: "fs.write-scratch", requiredPermissionId: "fs.write-scratch",
    adapterKind: "omp", adapterToolNames: ["omp_apply_patch"],
    runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
    mappingVersion: 1, status: "ACTIVE",
  }];
  const extended = [...TOOL_SELECTION_MAPPING, ...ompRows];
  assert.equal(computeMappingDigest(extended.filter((r) => r.adapterKind === PI_ADAPTER_KIND)), FROZEN_MAPPING_DIGEST,
    "foreign-kind rows cannot perturb the pi projection digest");
  const a = makeAdmission("T34", "heavy");
  const selBase = select(a, { nodeRole: "writer", executionId: "exec_t34", selectedAt: undefined });
  const selExt = projectToolSelection({
    admission: a, nodeRole: "writer", taskAllocation: allocFor(a, a.task_id),
    runtimeIdentity: RT, runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
    executionId: "exec_t34", selectedAt: undefined, mappingRows: extended,
  });
  assert.deepEqual(selExt.canonicalToolIds, selBase.canonicalToolIds);
  assert.deepEqual(selExt.adapterToolNames, selBase.adapterToolNames, "names unchanged; omp names never leak into pi selections");
});
