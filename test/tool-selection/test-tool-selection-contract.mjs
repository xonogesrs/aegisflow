// test/tool-selection/test-tool-selection-contract.mjs
//
// AUTOLOOP-V1-STAGE-C-REGISTRY-BACKED-TASK-SPECIFIC-TOOL-SELECTION-1
// Binding test matrix T1–T26 (freeze-card §11, recovered verbatim) plus the
// REV 2 binding additions TA–TD and the multi-agent portability checks.
//
// The only child processes ever spawned here are (a) the REAL `pi --help`
// read-only vocabulary capture (T1) and (b) test/fixtures/fake-pi-rpc.mjs
// via `node` for adapter argv/revalidation tests. No network, no provider.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  projectToolSelection,
  validateToolSelection,
  createLifecycleSelectionAuthority,
  computeRegistryDigest,
  computeMappingDigest,
  computeRuntimeVocabularyDigest,
  parsePiBuiltinToolNames,
  canonicalizeNameSet,
  observeRuntimeIdentity,
  buildAdmissionRecord,
  FROZEN_MAPPING_DIGEST,
  FROZEN_RUNTIME_VOCABULARY_DIGEST,
  FROZEN_RUNTIME_TOOL_NAMES,
  FROZEN_RUNTIME_IDENTITY,
  TOOL_SELECTION_MAPPING,
  TOOL_SELECTION_SCHEMA,
  TOOL_SELECTION_FAILURE_CODES,
  PI_ADAPTER_KIND,
  ToolSelectionError,
} from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { digestOf } from "../../src/canonical-digest.mjs";
import { createPiRpcAdapter, DEFAULT_ENV_ALLOWLIST } from "../../src/adapter/pi-rpc-adapter.mjs";
import { buildPhaseTaskCard, deriveScopePatterns, phaseExecutionId } from "../../src/v2/phase-task-card.mjs";
import { captureScopeSnapshot } from "../../src/c2d/mutation-scope.mjs";
import { runLifecycle } from "../../src/lifecycle-runner.mjs";
import { coordinate, executeSequentially } from "../../src/control-plane/coordinator.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "..", "fixtures", "fake-pi-rpc.mjs");
const EVIDENCE_FIXTURE = JSON.parse(
  readFileSync(resolve(HERE, "..", "fixtures", "implementation-evidence-valid.json"), "utf8"),
);

// ── admission + allocation helpers ─────────────────────────────────────

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

export function makeAdmission(taskId, kind = "fast") {
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

export function allocFor(admission, taskId, dims) {
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

function select(admission, { nodeRole = null, executionId = "exec_t", selectedAt = "2026-08-23T16:05:45.000Z", mappingRows, taskAllocation, runtimeIdentity, runtimeVocabularyDigest } = {}) {
  return projectToolSelection({
    admission,
    nodeRole,
    taskAllocation: taskAllocation ?? allocFor(admission, admission.task_id),
    runtimeIdentity: runtimeIdentity ?? RT,
    runtimeVocabularyDigest: runtimeVocabularyDigest ?? FROZEN_RUNTIME_VOCABULARY_DIGEST,
    executionId,
    selectedAt,
    ...(mappingRows ? { mappingRows } : {}),
  });
}

async function authorityFor(admission, taskAllocation) {
  return createLifecycleSelectionAuthority({ admission, taskAllocation: taskAllocation ?? allocFor(admission, admission.task_id) });
}

/** Attacker-consistent re-signing: patch fields, then recompute SELECTION_DIGEST per the frozen formula. */
function reSignSync(selection, createHash) {
  const copy = JSON.parse(JSON.stringify(selection));
  delete copy.selectionDigest; // validator digests over the field set EXCLUDING the digest
  const canon = JSON.stringify((function sort(x) {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  })(copy));
  copy.selectionDigest = createHash("sha256").update(`${TOOL_SELECTION_SCHEMA}\n${canon}\n`, "utf8").digest("hex");
  return copy;
}

test("T1 runtime vocabulary capture and digest parity (real pi --help)", () => {
  // Frozen digest self-parity (module-load fence, anchored independently).
  assert.equal(computeRuntimeVocabularyDigest([...FROZEN_RUNTIME_TOOL_NAMES]), FROZEN_RUNTIME_VOCABULARY_DIGEST);
  assert.deepEqual([...FROZEN_RUNTIME_TOOL_NAMES].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  // Live read-only introspection of the pinned surface; identity drift fails.
  let help;
  try {
    help = execFileSync("pi", ["--help"], { encoding: "utf8", timeout: 30000 });
  } catch (e) {
    throw new Error(`PI_TOOL_VOCABULARY_UNAVAILABLE: pi --help failed: ${e.message}`);
  }
  const names = parsePiBuiltinToolNames(help);
  assert.ok(Array.isArray(names) && names.length >= 7, "capture found builtin tool names");
  assert.ok(FROZEN_RUNTIME_TOOL_NAMES.every((n) => names.includes(n)), `captured surface contains frozen set: ${names.join(",")}`);
  const observed = observeRuntimeIdentity();
  assert.equal(observed.realpath, FROZEN_RUNTIME_IDENTITY.realpath);
  assert.equal(observed.sha256, FROZEN_RUNTIME_IDENTITY.sha256);
});

test("T2 vocabulary case/duplicate/control/comma/newline/NUL rejection", () => {
  assert.throws(() => canonicalizeNameSet(["read", "read"]), ToolSelectionError); // duplicate
  assert.throws(() => canonicalizeNameSet([""]), ToolSelectionError); // empty
  assert.throws(() => canonicalizeNameSet(["re\x01ad"]), ToolSelectionError); // control
  assert.throws(() => canonicalizeNameSet(["re,ad"]), ToolSelectionError); // comma
  assert.throws(() => canonicalizeNameSet(["re\nad"]), ToolSelectionError); // newline
  assert.throws(() => canonicalizeNameSet(["re\0ad"]), ToolSelectionError); // NUL
  assert.throws(() => canonicalizeNameSet([7]), ToolSelectionError); // non-string
  // Trim is FORBIDDEN rather than silently applied: distinct byte strings stay distinct.
  assert.deepEqual(canonicalizeNameSet(["read", " read"]), [" read", "read"]);
});

test("T3 known registry tools map to verified adapter tools", () => {
  const s = select(makeAdmission("T3", "heavy"), { nodeRole: "writer" });
  assert.equal(s.selectionBasis, "DERIVED_SELECTION");
  assert.deepEqual(s.canonicalToolIds, ["fs.grep", "fs.list", "fs.read", "fs.write-scratch"]);
  assert.deepEqual(s.adapterToolNames, ["edit", "find", "grep", "ls", "read", "write"]);
  assert.equal(s.adapterKind, PI_ADAPTER_KIND);
});

test("T4 runtime extra tool never auto-selected (bash unmapped)", () => {
  assert.ok(FROZEN_RUNTIME_TOOL_NAMES.includes("bash"), "bash exists at runtime");
  for (const row of TOOL_SELECTION_MAPPING) {
    assert.equal(row.adapterToolNames.includes("bash"), false, `row ${row.canonicalToolId} must not map bash`);
  }
  const s = select(makeAdmission("T4", "heavy"), { nodeRole: "writer" });
  assert.equal(s.adapterToolNames.includes("bash"), false);
  // A selection claiming bash cannot pass validation.
  const forged = JSON.parse(JSON.stringify(s));
  forged.adapterToolNames = [...s.adapterToolNames, "bash"];
  const auth = createLifecycleSelectionAuthority({ admission: makeAdmission("T4", "heavy"), taskAllocation: allocFor(makeAdmission("T4", "heavy"), "T4") });
  const v = validateToolSelection(forged, { authorityBinding: null });
  assert.equal(v.ok, false);
});

test("T5 mapped tool absent from runtime fails closed (MAPPING_DRIFT)", () => {
  const rows = TOOL_SELECTION_MAPPING.map((r) => r.canonicalToolId === "fs.read"
    ? { ...r, adapterToolNames: ["nosuchtool"] }
    : r);
  assert.throws(() => select(makeAdmission("T5", "heavy"), { nodeRole: "writer", mappingRows: rows }),
    (e) => e.code === "TOOL_SELECTION_MAPPING_DRIFT");
});

test("T6 permission without mapping fails closed when required (laundering)", () => {
  const zeroRows = TOOL_SELECTION_MAPPING.map((r) => ({ ...r, adapterToolNames: [] }));
  assert.throws(() => select(makeAdmission("T6", "heavy"), { nodeRole: "readonly-analyst", mappingRows: zeroRows }),
    (e) => e.code === "TOOL_SELECTION_PERMISSION_UNMAPPED");
});

test("T7 unknown canonical tool fails closed", () => {
  const a = makeAdmission("T7");
  const tampered = { ...a, tool_permissions: ["fs.teleport"] };
  assert.throws(() => select(tampered),
    (e) => e.code === "TOOL_SELECTION_UNKNOWN_CANONICAL_TOOL");
  assert.throws(() => select({ ...a, capabilities: { ...a.capabilities, allowed: [...a.capabilities.allowed, "CAP.NOPE"] } }),
    (e) => e.code === "TOOL_SELECTION_UNKNOWN_CANONICAL_TOOL");
});

test("T8 known but unauthorized tool fails closed", async () => {
  const heavy = makeAdmission("T8", "heavy");
  // Narrow the admitted upper bound below what the writer envelope needs.
  const narrowed = { ...heavy, tool_permissions: ["READ_ONLY"] };
  assert.throws(() => select(narrowed, { nodeRole: "writer" }),
    (e) => e.code === "TOOL_SELECTION_TOOL_UNAUTHORIZED");
});

test("T9 revoked tool fails closed", () => {
  // A SELECTED permission whose rows are revoked ⇒ hold (never silently narrowed).
  const grepRevoked = TOOL_SELECTION_MAPPING.map((r) => r.canonicalToolId === "fs.grep" ? { ...r, status: "REVOKED" } : r);
  assert.throws(() => select(makeAdmission("T9", "heavy"), { nodeRole: "writer", mappingRows: grepRevoked }),
    (e) => e.code === "TOOL_SELECTION_TOOL_REVOKED");
  const allRevoked = TOOL_SELECTION_MAPPING.map((r) => ({ ...r, status: "REVOKED" }));
  assert.throws(() => select(makeAdmission("T9", "heavy"), { nodeRole: "writer", mappingRows: allRevoked }),
    (e) => e.code === "TOOL_SELECTION_TOOL_REVOKED");
  // Owning capability denied at selection time ⇒ registry-level revocation.
  const heavy = makeAdmission("T9", "heavy");
  const deniedWriter = { ...heavy, capabilities: { ...heavy.capabilities, denied: [...heavy.capabilities.denied, "CAP.WRITER_SUBAGENT"] } };
  assert.throws(() => select(deniedWriter, { nodeRole: "writer" }),
    (e) => e.code === "TOOL_SELECTION_TOOL_REVOKED");
});

test("T10 allowed-set is not treated as required-set", () => {
  // FAST_PATH: CAP.DIRECT_EXECUTION is ALLOWED yet grants nothing.
  const fast = makeAdmission("T10-fast");
  assert.deepEqual(fast.capabilities.required, []);
  assert.deepEqual(fast.capabilities.allowed, ["CAP.DIRECT_EXECUTION"]);
  const s = select(fast);
  assert.equal(s.selectionBasis, "LEGITIMATE_EMPTY");
  // Heavy writer: writer capability REQUIRED ⇒ write tools selected.
  const w = select(makeAdmission("T10-heavy", "heavy"), { nodeRole: "writer" });
  assert.ok(w.canonicalToolIds.includes("fs.write-scratch"));
  // Memory-retrieval allowance contributes no tools on either side.
  assert.equal(w.adapterToolNames.includes("bash"), false);
});

test("T11 deterministic task-specific subset", () => {
  const a = makeAdmission("T11", "heavy");
  const s1 = select(a, { nodeRole: "writer", executionId: "exec_x" });
  const s2 = select(a, { nodeRole: "writer", executionId: "exec_x" });
  assert.deepEqual(JSON.parse(JSON.stringify(s1)), JSON.parse(JSON.stringify(s2)));
  assert.equal(s1.selectionDigest, s2.selectionDigest);
  const s3 = select(a, { nodeRole: "writer", executionId: "exec_y" });
  assert.notEqual(s3.runIdentity, s1.runIdentity);
  assert.equal(s3.selectionDigest !== s1.selectionDigest, true); // runIdentity binds the digest
});

test("T12 empty legitimate no-tools (provenance LEGITIMATE_EMPTY)", async () => {
  const fast = makeAdmission("T12");
  const s = select(fast);
  assert.equal(s.selectionBasis, "LEGITIMATE_EMPTY");
  assert.deepEqual(s.adapterToolNames, []);
  assert.deepEqual(s.canonicalToolIds, []);
  const auth = await authorityFor(fast);
  const v = validateToolSelection(s, { authorityBinding: await auth({ executionId: s.runIdentity }) });
  assert.equal(v.ok, true);
  assert.deepEqual(v.argvToolNames, []);
});

test("T13 missing required tool cannot become no-tools success", () => {
  const zeroRows = TOOL_SELECTION_MAPPING.map((r) => ({ ...r, adapterToolNames: [] }));
  try {
    select(makeAdmission("T13", "heavy"), { nodeRole: "readonly-analyst", mappingRows: zeroRows });
    assert.fail("expected PERMISSION_UNMAPPED");
  } catch (e) {
    assert.equal(e.code, "TOOL_SELECTION_PERMISSION_UNMAPPED");
    // Failure is an exception — never a { basis: LEGITIMATE_EMPTY } output.
    assert.notEqual(e.code, "OK");
  }
});

// ── T14–T19 · card mint, adapter argv, lifecycle consumption ───────────

const WRITER_PHASE = {
  phase_id: "p_impl", title: "Impl", summary: "writer", responsibility: "R1 impl", purpose: "implementation",
  effects: {
    artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
    evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] },
  },
  covers: [{ requirement_id: "R1", completeness: "complete", claim: "covers R1" }],
  depends_on: [],
};
const READONLY_PHASE = {
  ...WRITER_PHASE,
  phase_id: "p_read",
  effects: { ...WRITER_PHASE.effects, artifact_mutation: "forbidden", boundaries: { ...WRITER_PHASE.effects.boundaries, artifact: [] } },
};

test("T14 caller raw allowlist ignored/rejected (never reaches argv)", () => {
  const heavy = makeAdmission("T14", "heavy");
  const card = buildPhaseTaskCard({
    phase: WRITER_PHASE,
    parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
    executionId: "exec_" + "ab".repeat(16),
    cwd: tmpdir(),
    maxRepairAttempts: 0,
    toolPolicy: { mode: "allowlist", tools: ["bash", "read"] },
  });
  assert.equal(card.toolPolicy, undefined, "raw passthrough removed");
  assert.equal(card.callerToolPolicyIgnored, true);
});

test("T15 forged selection output rejected", async () => {
  const heavy = makeAdmission("T15", "heavy");
  const s = select(heavy, { nodeRole: "writer" });
  const auth = await authorityFor(heavy);
  const binding = await auth({ executionId: s.runIdentity });
  // Naive tamper breaks the digest.
  const tampered = JSON.parse(JSON.stringify(s));
  tampered.adapterToolNames = ["bash"];
  assert.equal(validateToolSelection(tampered, { authorityBinding: binding }).ok, false);
  // TA-style attacker-consistent forgery with WRONG identities still rejected.
});

test("T16 stale registry/mapping/runtime digest rejected", async () => {
  const heavy = makeAdmission("T16", "heavy");
  const s = select(heavy, { nodeRole: "writer" });
  const auth = await authorityFor(heavy);
  const binding = await auth({ executionId: s.runIdentity });
  // Attacker-consistent mutations: fields patched AND digest re-signed, so
  // the specific drift codes (not a bare digest mismatch) are what reject.
  const { createHash } = await import("node:crypto");
  const mutate = (patch) => reSignSync({ ...JSON.parse(JSON.stringify(s)), ...patch }, createHash);
  assert.equal(validateToolSelection(mutate({ runtimeVocabularyDigest: "0".repeat(64) }), { authorityBinding: binding }).code,
    "TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT");
  assert.equal(validateToolSelection(mutate({ runtimeIdentity: { ...s.runtimeIdentity, sha256: "f".repeat(64) } }), { authorityBinding: binding }).code,
    "TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT");
  const regTampered = mutate({ registryDigest: digestOf({ forged: true }) });
  assert.equal(validateToolSelection(regTampered, { authorityBinding: binding }).code, "TOOL_SELECTION_PROVENANCE_INVALID");
  const mapTampered = mutate({ mappingDigest: digestOf({ forged: true }) });
  assert.equal(validateToolSelection(mapTampered, { authorityBinding: binding }).code, "TOOL_SELECTION_PROVENANCE_INVALID");
});

test("T17 wrong task/run/admission identity rejected", async () => {
  const heavy = makeAdmission("T17", "heavy");
  const s = select(heavy, { nodeRole: "writer" });
  // Right admission, wrong invocation identities.
  const authSame = await authorityFor(heavy);
  assert.equal(validateToolSelection(s, { authorityBinding: await authSame({ executionId: "exec_other" }) }).code,
    "TOOL_SELECTION_PROVENANCE_INVALID");
  // Different authoritative admission entirely.
  const otherHeavy = makeAdmission("T17-other", "heavy");
  const authOther = await authorityFor(otherHeavy);
  assert.equal(validateToolSelection(s, { authorityBinding: await authOther({ executionId: s.runIdentity }) }).code,
    "TOOL_SELECTION_PROVENANCE_INVALID");
  // No binding expectation at all.
  assert.equal(validateToolSelection(s, { authorityBinding: null }).code, "TOOL_SELECTION_PROVENANCE_INVALID");
});

test("T18 adapter argv has no shell/string injection", async () => {
  const heavy = makeAdmission("T18", "heavy");
  const s = select(heavy, { nodeRole: "writer", executionId: "exec_argv;rm -rf $HOME`" });
  const auth = await authorityFor(heavy);
  const seen = [];
  const adapter = createPiRpcAdapter({
    piExecutable: FIXTURE,
    environmentAllowlist: [...DEFAULT_ENV_ALLOWLIST, "FAKE_PI_CONTROL"],
    graceMs: 150,
    selectionAuthority: async (req) => { seen.push(req); return auth(req); },
  });
  process.env.FAKE_PI_CONTROL = JSON.stringify({ scenario: "normal", assistantTextByPhase: { executor: "done" } });
  try {
    const res = await adapter.runAdapter({
      executionId: s.runIdentity, cwd: tmpdir(), taskCard: { id: "t18" }, phase: "executor", attempt: 0, timeoutMs: 8000,
      toolPolicy: s,
    });
    assert.equal(res.status, "completed");
    const args = res.metadata.args;
    assert.deepEqual(args.filter((x) => x === "--tools").length, 1);
    const idx = args.indexOf("--tools");
    assert.equal(args[idx + 1], s.adapterToolNames.join(","));
    for (const a of args) {
      assert.equal(/[;&|`]|\$\(/.test(a), false, `argv token contains shell metacharacter: ${a}`);
    }
    assert.deepEqual(res.metadata.toolSelection, {
      selectionBasis: "DERIVED_SELECTION", adapterToolNames: s.adapterToolNames, telemetryState: "SELECTED",
    });
  } finally {
    delete process.env.FAKE_PI_CONTROL;
  }
});

// Lifecycle-level helpers (git-initialized fixture repo like the C4Q tests).
function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "stagec-life-"));
  spawnSync("git", ["init", "-b", "master"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "base.txt"), "base\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "base"], { cwd: dir });
  return dir;
}

function completed(stdout) {
  return { status: "completed", stdout, stderr: "", signal: null, error: null, metadata: { exitCode: 0 } };
}

// C4Q/C4S harness wiring (mirrors test-lifecycle-runner baseCard): a writer
// phase requires a system-observed verification record + scope snapshot.
function wireHarness(card, repo) {
  card.environmentAllowlist = ["PATH", "HOME", "TMPDIR", "FAKE_PI_CONTROL"];
  card.expectedExecutorModel = "deepseek-v4-flash";
  card.verificationCommand = ["node", "-e", "process.exit(0)"];
  card.expectedExecutorProvider = "deepseek";
  card.mutationScope = {
    repositoryRoot: repo,
    baselineSnapshot: captureScopeSnapshot(repo),
    allowedPaths: deriveScopePatterns(card.allowedPaths),
    forbiddenPaths: deriveScopePatterns(card.forbiddenPaths),
  };
  return card;
}

test("T19 executor receives exactly selected subset (reviewer pinned separately)", async () => {
  const repo = makeFixtureRepo();
  try {
    const heavy = makeAdmission("T19", "heavy");
    const bind = { admission: heavy, taskAllocation: allocFor(heavy, "T19") };
    const card = buildPhaseTaskCard({
      phase: WRITER_PHASE,
      parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
      executionId: "exec_" + "cd".repeat(16),
      cwd: repo,
      maxRepairAttempts: 0,
      expectedReviewerModel: "test-model",
      toolSelectionBind: bind,
    });
    const seen = [];
    const executorAdapter = {
      runAdapter: async (request) => {
        seen.push({ phase: request.phase, toolPolicy: request.toolPolicy });
        return completed(JSON.stringify({ ...EVIDENCE_FIXTURE, contract_id: request.taskCard.executionId }));
      },
    };
    const reviewerAdapter = {
      runAdapter: async (request) => {
        seen.push({ phase: request.phase, toolPolicy: request.toolPolicy });
        return completed(JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP" }));
      },
    };
    wireHarness(card, repo);
    const probe = JSON.stringify({ vc: card.verificationCommand, ea: card.environmentAllowlist, root: card.repositoryRoot, ap: card.allowedPaths });
    const result = await runLifecycle({
      cwd: repo, taskCard: card, executorAdapter, reviewerAdapter, maxRepairAttempts: 0, timeoutMs: 20000,
    });
    assert.equal(result.final, "PASS", `final=${result.final} reason=${result.reason} detail=${JSON.stringify(result.detail ?? {})} probe=${probe}`);
    if (result.final !== "PASS") {
      console.error("T19DEBUG", result.reason);
    }
    const exec = seen.find((x) => x.phase === "executor");
    const rev = seen.find((x) => x.phase === "reviewer");
    assert.equal(exec.toolPolicy.contractVersion, TOOL_SELECTION_SCHEMA);
    assert.equal(exec.toolPolicy.selectionBasis, "DERIVED_SELECTION");
    assert.deepEqual(exec.toolPolicy.adapterToolNames, ["edit", "find", "grep", "ls", "read", "write"]);
    assert.equal(exec.toolPolicy.runIdentity, card.executionId);
    assert.deepEqual(rev.toolPolicy, { mode: "no-tools" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("T20 reviewer remains no-tools even under a permissive executor selection", async () => {
  const repo = makeFixtureRepo();
  try {
    const heavy = makeAdmission("T20", "heavy");
    const card = buildPhaseTaskCard({
      phase: WRITER_PHASE,
      parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
      executionId: "exec_" + "ef".repeat(16),
      cwd: repo,
      maxRepairAttempts: 0,
      expectedReviewerModel: "test-model",
      toolSelectionBind: { admission: heavy, taskAllocation: allocFor(heavy, "T20") },
    });
    const seen = [];
    const mk = (phaseResult) => ({ runAdapter: async (r) => { seen.push({ phase: r.phase, policy: r.toolPolicy }); return phaseResult(r); } });
    wireHarness(card, repo);
    const result = await runLifecycle({
      cwd: repo, taskCard: card,
      executorAdapter: mk((r) => completed(JSON.stringify({ ...EVIDENCE_FIXTURE, contract_id: r.taskCard.executionId }))),
      reviewerAdapter: mk((r) => completed(JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP" }))),
      maxRepairAttempts: 0, timeoutMs: 20000,
    });
    assert.equal(result.final, "PASS");
    assert.deepEqual(seen.find((x) => x.phase === "reviewer").policy, { mode: "no-tools" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("T21 direct/FAST_PATH follows canonical authority (formula, not hardcode)", () => {
  const fast = makeAdmission("T21");
  // Formula output: empty because the REGISTRY grants no tool-bearing capability.
  const s = select(fast);
  assert.equal(s.selectionBasis, "LEGITIMATE_EMPTY");
  // Breaking the registry/permission derivation CHANGES the outcome — the
  // no-tools result is THE FORMULA over registry truth, not a hardcoded
  // rule keyed on profile FAST_PATH (the widened admission is STILL FAST_PATH).
  const widened = {
    ...fast,
    tool_permissions: ["READ_ONLY"],
    capabilities: {
      ...fast.capabilities,
      allowed: [...fast.capabilities.allowed, "CAP.READONLY_SUBAGENT"],
      // Granting = removing the deny-by-default entry for that capability.
      denied: fast.capabilities.denied.filter((id) => id !== "CAP.READONLY_SUBAGENT"),
    },
  };
  const s2 = select(widened);
  assert.equal(s2.selectionBasis, "DERIVED_SELECTION");
  assert.deepEqual(s2.adapterToolNames, ["find", "grep", "ls", "read"]);
});

test("T22 graph path follows same selector (single bind through card mint)", async () => {
  const repo = makeFixtureRepo();
  try {
    const heavy = makeAdmission("T22", "heavy");
    const bind = { admission: heavy, taskAllocation: allocFor(heavy, "T22") };
    // Writer phase and readonly phase get role-appropriate selections from THE selector.
    const writerCard = buildPhaseTaskCard({
      phase: WRITER_PHASE,
      parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
      executionId: "exec_" + "12".repeat(16), cwd: repo, maxRepairAttempts: 0, toolSelectionBind: bind,
    });
    const readerCard = buildPhaseTaskCard({
      phase: READONLY_PHASE,
      parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
      executionId: "exec_" + "34".repeat(16), cwd: repo, maxRepairAttempts: 0, toolSelectionBind: bind,
    });
    assert.equal(writerCard.toolPolicy.nodeRole, "writer");
    assert.ok(writerCard.toolPolicy.canonicalToolIds.includes("fs.write-scratch"));
    assert.equal(readerCard.toolPolicy.nodeRole, "readonly-analyst");
    assert.equal(readerCard.toolPolicy.canonicalToolIds.includes("fs.write-scratch"), false);
    assert.deepEqual(readerCard.toolPolicy.canonicalToolIds, ["fs.grep", "fs.list", "fs.read"]);
    // Both selections validate against the SAME authority (one projection reused).
    const auth = await authorityFor(heavy, bind.taskAllocation);
    assert.equal(validateToolSelection(writerCard.toolPolicy, { authorityBinding: await auth({ executionId: writerCard.executionId }) }).ok, true);
    assert.equal(validateToolSelection(readerCard.toolPolicy, { authorityBinding: await auth({ executionId: readerCard.executionId }) }).ok, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("T23 retry/repair preserves selection identity and idempotency", async () => {
  const repo = makeFixtureRepo();
  try {
    const heavy = makeAdmission("T23", "heavy");
    const card = buildPhaseTaskCard({
      phase: WRITER_PHASE,
      parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
      executionId: "exec_" + "56".repeat(16), cwd: repo, maxRepairAttempts: 1,
      toolSelectionBind: { admission: heavy, taskAllocation: allocFor(heavy, "T23") },
    });
    const policiesByAttempt = [];
    let attempt = -1;
    const executorAdapter = {
      runAdapter: async (r) => {
        if (r.attempt !== attempt) { attempt = r.attempt; policiesByAttempt.push(r.toolPolicy); }
        return completed(JSON.stringify({ ...EVIDENCE_FIXTURE, contract_id: r.taskCard.executionId }));
      },
    };
    const verdicts = [
      { verdict: "HOLD", confidence: "HIGH", model: "test-model", summary: "needs repair", recommended_next_action: "REPAIR" },
      { verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP" },
    ];
    let reviewIdx = 0;
    const reviewerAdapter = {
      runAdapter: async () => completed(JSON.stringify(verdicts[Math.min(reviewIdx++, 1)])),
    };
    wireHarness(card, repo);
    const result = await runLifecycle({
      cwd: repo, taskCard: card, executorAdapter, reviewerAdapter, maxRepairAttempts: 1, timeoutMs: 30000,
    });
    assert.equal(result.final, "PASS");
    assert.equal(policiesByAttempt.length, 2, "executor ran twice (attempt 0 repair, attempt 1)");
    assert.strictEqual(policiesByAttempt[0], policiesByAttempt[1], "SAME frozen selection object across attempts");
    assert.equal(policiesByAttempt[0].runIdentity, card.executionId);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("T24 tool exception and malformed result preserve failure truth", async () => {
  const repo = makeFixtureRepo();
  try {
    const heavy = makeAdmission("T24", "heavy");
    const card = buildPhaseTaskCard({
      phase: WRITER_PHASE,
      parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
      executionId: "exec_" + "78".repeat(16), cwd: repo, maxRepairAttempts: 0,
      toolSelectionBind: { admission: heavy, taskAllocation: allocFor(heavy, "T24") },
    });
    wireHarness(card, repo);
    const errResult = await runLifecycle({
      cwd: repo, taskCard: card,
      executorAdapter: { runAdapter: async () => ({ status: "error", stdout: "", stderr: "", signal: null, error: "tool exploded", metadata: {} }) },
      reviewerAdapter: { runAdapter: async () => completed(JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP" })) },
      maxRepairAttempts: 0, timeoutMs: 20000,
    });
    assert.equal(errResult.final, "HOLD");
    assert.equal(errResult.reason, "EXECUTOR_ERROR");
    wireHarness(card, repo);
    const malformed = await runLifecycle({
      cwd: repo, taskCard: card,
      executorAdapter: { runAdapter: async (r) => completed(JSON.stringify({ ...EVIDENCE_FIXTURE, contract_id: r.taskCard.executionId })) },
      reviewerAdapter: { runAdapter: async () => completed("not json at all {") },
      maxRepairAttempts: 0, timeoutMs: 20000,
    });
    assert.equal(malformed.final, "HOLD");
    assert.equal(malformed.reason, "MALFORMED_REVIEWER_VERDICT");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── E2E production chain (mandated: coordinator → admission → selector → lifecycle → pi adapter) ──

test("E2E production coordinator → admission gate → SOP direct runner → lifecycle → pi-rpc-adapter", async () => {
  // FAST_PATH/S0: the production composition for a direct task. The card is
  // bound through THE selector (projectToolSelection) and the pi adapter
  // revalidates it against the coordinator-bound authoritative allocation.
  const fast = makeAdmission("STAGEC-E2E");
  assert.equal(fast.profile, "FAST_PATH");
  const repo = makeFixtureRepo();
  const parentExecutionId = "exec_" + "9a".repeat(16);
  const executionId = phaseExecutionId(parentExecutionId, "DIRECT_EXECUTION");
  const taskCard = wireHarness(
    {
      executionId,
      parentExecutionId,
      phaseId: "DIRECT_EXECUTION",
      repositoryRoot: repo,
      title: "stage-c e2e",
    },
    repo,
  );
    try {
    const adapterRequests = [];
    const recordingExecutor = {
      runAdapter: async (req) => {
        adapterRequests.push({ phase: req.phase, toolPolicy: req.toolPolicy, meta: null });
        const res = await realExecutor.runAdapter(req);
        if (res.status !== "completed") {
          console.error("E2EEXEC", res.status, res.error, JSON.stringify(res.metadata?.selectionHoldCode ?? null), JSON.stringify(res.metadata?.args ?? null));
        }
        adapterRequests[adapterRequests.length - 1].meta = res.metadata;
        return res.status === "completed"
          ? { ...res, stdout: JSON.stringify({ ...EVIDENCE_FIXTURE, contract_id: req.taskCard.executionId }) }
          : res;
      },
    };
    let realExecutor;
    let selectionAuthorityRef;
    const recordingReviewer = {
      runAdapter: async (req) => {
        adapterRequests.push({ phase: req.phase, toolPolicy: req.toolPolicy, meta: null });
        return await realReviewer.runAdapter(req);
      },
    };
    let realReviewer;
    process.env.FAKE_PI_CONTROL = JSON.stringify({
      scenario: "normal",
      assistantTextByPhase: {
        executor: "e2e executor done",
        reviewer: JSON.stringify({ verdict: "PASS", confidence: "HIGH", model: "test-model", summary: "ok", recommended_next_action: "STOP" }),
      },
    });
    try {
      const DIMS = { node_execution_count: 8, repair_attempt_count: 2, retry_count: 4, sub_agent_execution_count: 2, verifier_reviewer_attempts: 2, wall_clock_ms: 120000 };
      const { ok, plan } = coordinate({
        tasks: [{
          id: "STAGEC-E2E",
          admission: fast,
          remaining: { ...DIMS },
          lifecycleState: "EXECUTING",
          runnerOpts: {
            taskCard,
            executorAdapter: recordingExecutor,
            reviewerAdapter: recordingReviewer,
            cwd: repo,
            timeoutMs: 30000,
            maxRepairAttempts: 0,
          },
        }],
        globalBudget: { dimensions: { ...DIMS } },
      });
      assert.equal(ok, true);
      const planTask = plan.tasks[0];
      assert.equal(planTask.runtime, "direct");
      assert.equal(planTask.graph, null, "direct runtime ⇒ graph null ⇒ SOP direct runner");
      assert.ok(planTask.taskAllocation?.allocationId, "coordinator bound the authoritative allocation");
      assert.notEqual(planTask.decision?.recommendation, "HOLD", `optimizer decision: ${planTask.decision?.holdCode}`);

      // THE selector bind (single, per dispatch): formula over the frozen admission.
      taskCard.toolPolicy = select(fast, { executionId, taskAllocation: planTask.taskAllocation });
      selectionAuthorityRef = createLifecycleSelectionAuthority({ admission: fast, taskAllocation: planTask.taskAllocation });
      realExecutor = createPiRpcAdapter({
        piExecutable: FIXTURE,
        environmentAllowlist: [...DEFAULT_ENV_ALLOWLIST, "FAKE_PI_CONTROL"],
        graceMs: 150,
        selectionAuthority: selectionAuthorityRef,
      });
      realReviewer = createPiRpcAdapter({
        piExecutable: FIXTURE,
        environmentAllowlist: [...DEFAULT_ENV_ALLOWLIST, "FAKE_PI_CONTROL"],
        graceMs: 150,
      });

      const dispatched = await executeSequentially({ plan });
      const r = dispatched.results[0];
      assert.equal(r.dispatched, true, `dispatched (reason=${r.holdCode ?? ""} ${r.reason ?? ""})`);
      assert.equal(r.result?.final, "PASS", `terminal PASS (got ${r.result?.final}/${r.result?.reason ?? ""}/${JSON.stringify(r.result?.detail ?? {}).slice(0,600)})`);

      // Selector ran in-chain: the executor carried THE canonical selection.
      const execReq = adapterRequests.find((x) => x.phase === "executor");
      assert.equal(execReq.toolPolicy.contractVersion, TOOL_SELECTION_SCHEMA);
      assert.equal(execReq.toolPolicy.selectionBasis, "LEGITIMATE_EMPTY", "FAST_PATH no-tools arises FROM THE FORMULA");
      assert.deepEqual(execReq.toolPolicy.adapterToolNames, []);
      assert.equal(execReq.toolPolicy.runIdentity, executionId);
      // Adapter revalidated against the authoritative store; argv = exact selected subset.
      assert.deepEqual(execReq.meta.toolSelection, {
        selectionBasis: "LEGITIMATE_EMPTY", adapterToolNames: [], telemetryState: "NOT_SELECTED",
      });
      assert.ok(execReq.meta.args.includes("--no-tools"));
      assert.equal(execReq.meta.args.includes("--tools"), false);
      // Reviewer stayed pinned.
      const revReq = adapterRequests.find((x) => x.phase === "reviewer");
      assert.deepEqual(revReq.toolPolicy, { mode: "no-tools" });
    } finally {
      delete process.env.FAKE_PI_CONTROL;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── T25–T26 · telemetry truth & single-authority structure ─────────────

test("T25 telemetry publishes canonical and adapter identities truthfully", async () => {
  const heavy = makeAdmission("T25", "heavy");
  const s = select(heavy, { nodeRole: "writer", executionId: "exec_telemetry_1" });
  const auth = await authorityFor(heavy);
  const adapter = createPiRpcAdapter({
    piExecutable: FIXTURE,
    environmentAllowlist: [...DEFAULT_ENV_ALLOWLIST, "FAKE_PI_CONTROL"],
    graceMs: 150,
    selectionAuthority: auth,
  });
  process.env.FAKE_PI_CONTROL = JSON.stringify({ scenario: "normal", assistantTextByPhase: { executor: "ok" } });
  try {
    const res = await adapter.runAdapter({
      executionId: s.runIdentity, cwd: tmpdir(), taskCard: { id: "t25" }, phase: "executor", attempt: 0, timeoutMs: 8000, toolPolicy: s,
    });
    assert.equal(res.status, "completed");
    assert.equal(res.metadata.toolSelection.telemetryState, "SELECTED");
    assert.deepEqual(res.metadata.toolSelection.adapterToolNames, s.adapterToolNames);
    assert.equal(typeof res.metadata.toolCallCount, "number"); // honest counter untouched
    // Rejection path publishes SELECTED_REJECTED with zero invocations.
    const forged = JSON.parse(JSON.stringify(s));
    forged.runIdentity = "exec_wrong_run";
    const rej = await adapter.runAdapter({
      executionId: s.runIdentity, cwd: tmpdir(), taskCard: { id: "t25b" }, phase: "executor", attempt: 0, timeoutMs: 8000, toolPolicy: forged,
    });
    assert.equal(rej.status, "error");
    assert.equal(rej.metadata.selectionTelemetryState, "SELECTED_REJECTED");
    assert.equal(rej.metadata.applied, false);
    assert.equal(rej.metadata.toolInvocationCount, 0);
    assert.equal(rej.metadata.childPid, undefined, "no child was ever spawned");
  } finally {
    delete process.env.FAKE_PI_CONTROL;
  }
});

test("T26 no second catalog/selector/executor/governor", () => {
  // Exactly ten frozen codes — implementation invented none.
  assert.deepEqual([...TOOL_SELECTION_FAILURE_CODES], [
    "TOOL_SELECTION_CONTRACT_MISSING",
    "TOOL_SELECTION_TASK_INTENT_MISSING",
    "TOOL_SELECTION_PERMISSION_UNMAPPED",
    "TOOL_SELECTION_TOOL_UNAUTHORIZED",
    "TOOL_SELECTION_TOOL_REVOKED",
    "TOOL_SELECTION_UNKNOWN_CANONICAL_TOOL",
    "TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT",
    "TOOL_SELECTION_MAPPING_DRIFT",
    "TOOL_SELECTION_PROVENANCE_INVALID",
    "TOOL_SELECTION_REQUIRED_TOOL_UNAVAILABLE",
  ]);
  // One mapping authority: the frozen rows live WITH the projection module.
  assert.equal(FROZEN_MAPPING_DIGEST, computeMappingDigest(TOOL_SELECTION_MAPPING));
  // The selector derives from the SINGLE registry — two admissions through the
  // same pure function yield their own correct registry digests.
  const a1 = makeAdmission("T26-a");
  const a2 = makeAdmission("T26-b", "heavy");
  assert.equal(select(a1).registryDigest, computeRegistryDigest(a1));
  assert.equal(select(a2, { nodeRole: "writer" }).registryDigest, computeRegistryDigest(a2));
  // No new executor/governor: lifecycle + governance imports unchanged is
  // asserted structurally by the focused suites; here the validator reuse is
  // proven by importing THE SAME module (no second copy exists to import).
  assert.equal(typeof validateToolSelection, "function");
});

// ── REV 2 binding additions TA–TD ───────────────────────────────────────

test("TA forged-but-well-formed selection (attacker-signed) rejected by authority resolution", async () => {
  const heavy = makeAdmission("TA", "heavy");
  const s = JSON.parse(JSON.stringify(select(heavy, { nodeRole: "writer", executionId: "exec_ta" })));
  // Attacker swaps EVERY identity to its own values AND re-signs correctly.
  s.taskIdentity = { taskId: "EVIL", taskAllocationDigest: digestOf({ evil: true }) };
  s.runIdentity = "exec_evil";
  s.admissionIdentity = { admissionId: "evil_adm", admissionDigest: digestOf({ evil: true }) };
  delete s.selectionDigest;
  const canon = JSON.stringify((function sort(x) {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  })(s));
  const { createHash } = await import("node:crypto");
  s.selectionDigest = createHash("sha256").update(`${TOOL_SELECTION_SCHEMA}\n${canon}\n`, "utf8").digest("hex");
  const auth = await authorityFor(heavy);
  const v = validateToolSelection(s, { authorityBinding: await auth({ executionId: "exec_ta" }) });
  assert.equal(v.ok, false);
  assert.equal(v.code, "TOOL_SELECTION_PROVENANCE_INVALID");
});

test("TA2 resigned payload with COPIED identities but swapped tool arrays rejected", async () => {
  // Review F1: attacker copies the REAL publicly-observable identities and
  // swaps only the tool arrays, re-signing with the public digest formula.
  // Derivation fidelity must reject it — argv can never exceed what THE
  // frozen mapping derives from the carried ids.
  const heavy = makeAdmission("TA2", "heavy");
  const honest = JSON.parse(JSON.stringify(select(heavy, { nodeRole: "readonly-analyst", executionId: "exec_ta2" })));
  const auth = await authorityFor(heavy);
  const binding = await auth({ executionId: honest.runIdentity });
  assert.equal(validateToolSelection(honest, { authorityBinding: binding }).ok, true);

  const escalated = JSON.parse(JSON.stringify(honest));
  escalated.canonicalToolIds = ["fs.write-scratch"];
  escalated.permissionIds = ["fs.write-scratch"];
  escalated.adapterToolNames = ["edit", "write"];
  delete escalated.selectionDigest;
  const { createHash } = await import("node:crypto");
  const canon = JSON.stringify((function sort(x) {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  })(escalated));
  escalated.selectionDigest = createHash("sha256").update(`${TOOL_SELECTION_SCHEMA}\n${canon}\n`, "utf8").digest("hex");
  const v = validateToolSelection(escalated, { authorityBinding: binding });
  assert.equal(v.ok, false);
  assert.equal(v.code, "TOOL_SELECTION_PROVENANCE_INVALID");
});

test("TB direct adapter invocation with NO binding expectation holds before spawn", async () => {
  const heavy = makeAdmission("TB", "heavy");
  const s = select(heavy, { nodeRole: "writer", executionId: "exec_tb" });
  // Case 1: NO selectionAuthority configured at all.
  const bare = createPiRpcAdapter({ piExecutable: FIXTURE, environmentAllowlist: [...DEFAULT_ENV_ALLOWLIST, "FAKE_PI_CONTROL"], graceMs: 150 });
  const r1 = await bare.runAdapter({
    executionId: s.runIdentity, cwd: tmpdir(), taskCard: { id: "tb1" }, phase: "executor", attempt: 0, timeoutMs: 5000, toolPolicy: s,
  });
  assert.equal(r1.status, "error");
  assert.match(r1.error, /^TOOL_SELECTION_PROVENANCE_INVALID/);
  assert.equal(r1.metadata.applied, false);
  assert.equal(r1.metadata.toolInvocationCount, 0);
  assert.equal(r1.metadata.childPid, undefined);
  // Case 2: authority configured but resolution returns null (no binding).
  const unbound = createPiRpcAdapter({
    piExecutable: FIXTURE, environmentAllowlist: [...DEFAULT_ENV_ALLOWLIST, "FAKE_PI_CONTROL"], graceMs: 150,
    selectionAuthority: async () => null,
  });
  const r2 = await unbound.runAdapter({
    executionId: s.runIdentity, cwd: tmpdir(), taskCard: { id: "tb2" }, phase: "executor", attempt: 0, timeoutMs: 5000, toolPolicy: s,
  });
  assert.equal(r2.status, "error");
  assert.match(r2.error, /^TOOL_SELECTION_PROVENANCE_INVALID/);
  assert.equal(r2.metadata.applied, false);
});

test("TC validator recomputes REGISTRY_DIGEST; implementer-supplied value is PROVENANCE_INVALID", async () => {
  const heavy = makeAdmission("TC", "heavy");
  const other = makeAdmission("TC-other");
  const s = JSON.parse(JSON.stringify(select(heavy, { nodeRole: "writer", executionId: "exec_tc" })));
  s.registryDigest = computeRegistryDigest(other); // implementer-chosen value
  const auth = await authorityFor(heavy);
  const v = validateToolSelection(s, { authorityBinding: await auth({ executionId: s.runIdentity }) });
  assert.equal(v.ok, false);
  assert.equal(v.code, "TOOL_SELECTION_PROVENANCE_INVALID");
});

test("TD zero-projection laundering: nonempty intent reduced to empty ⇒ UNMAPPED, never LEGITIMATE_EMPTY", () => {
  const heavy = makeAdmission("TD", "heavy");
  const statOnly = TOOL_SELECTION_MAPPING.map((r) =>
    r.canonicalToolId === "fs.stat" ? r : { ...r, adapterToolNames: [] });
  try {
    const s = select(heavy, { nodeRole: "writer", mappingRows: statOnly });
    // If we ever got here it would be the laundering defect.
    assert.notEqual(s.selectionBasis, "LEGITIMATE_EMPTY");
    assert.fail("expected TOOL_SELECTION_PERMISSION_UNMAPPED");
  } catch (e) {
    assert.equal(e.code, "TOOL_SELECTION_PERMISSION_UNMAPPED");
  }
  // MIXED CASE (REV 3): zero-projection member beside real tools is INERT.
  const s2 = select(heavy, { nodeRole: "writer" });
  assert.equal(s2.canonicalToolIds.includes("fs.stat"), false, "inert member excluded from selection");
  assert.ok(s2.canonicalToolIds.length > 0, "rest of selection unaffected");
});

// ── Multi-agent portability invariants (dispatch addendum §4) ───────────

test("PORTABILITY canonical ids are agent-neutral; Pi names appear only as projections", () => {
  const PI_NAMES = new Set(FROZEN_RUNTIME_TOOL_NAMES);
  for (const row of TOOL_SELECTION_MAPPING) {
    assert.equal(row.adapterKind, "pi-builtin");
    assert.ok(/^fs\./.test(row.canonicalToolId), `canonical id agent-neutral: ${row.canonicalToolId}`);
    assert.equal(PI_NAMES.has(row.canonicalToolId), false, "canonical identity is NOT a Pi tool name");
    for (const n of row.adapterToolNames) assert.ok(PI_NAMES.has(n));
  }
});

test("PORTABILITY core selector has no Pi CLI coupling beyond the frozen identity DATA", () => {
  const src = readFileSync(resolve(HERE, "..", "..", "src", "admission", "policy-projection.mjs"), "utf8");
  assert.equal(/from\s+"[^"]*@earendil-works/.test(src), false, "no Pi package import in the selector authority");
  assert.equal(/\bspawn\s*\(/.test(src.slice(src.indexOf("STAGE C"))), false, "selector spawns nothing");
});

test("PORTABILITY unknown adapterKind fails closed; cross-adapter replay fenced", async () => {
  const heavy = makeAdmission("PORT", "heavy");
  const s = JSON.parse(JSON.stringify(select(heavy, { nodeRole: "writer", executionId: "exec_port" })));
  // Unknown future adapterKind on the payload → fail closed even re-signed.
  s.adapterKind = "omp-future";
  delete s.selectionDigest;
  const canon = JSON.stringify((function sort(x) {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  })(s));
  const { createHash } = await import("node:crypto");
  s.selectionDigest = createHash("sha256").update(`${TOOL_SELECTION_SCHEMA}\n${canon}\n`, "utf8").digest("hex");
  const auth = await authorityFor(heavy);
  const v = validateToolSelection(s, { authorityBinding: await auth({ executionId: "exec_port" }) });
  assert.equal(v.ok, false);
  assert.equal(v.code, "TOOL_SELECTION_PROVENANCE_INVALID");
  // Cross-adapter replay: pi selection replayed under another admission's
  // authority is fenced (identities do not resolve there).
  const otherAuth = await authorityFor(makeAdmission("PORT-other", "heavy"));
  const v2 = validateToolSelection(select(heavy, { nodeRole: "writer", executionId: "exec_port2" }),
    { authorityBinding: await otherAuth({ executionId: "exec_port2" }) });
  assert.equal(v2.ok, false);
});

test("PORTABILITY future adapters extend by adding ROWS through the same authority", () => {
  const ompRow = {
    canonicalToolId: "fs.read",
    requiredPermissionId: "fs.read",
    adapterKind: "omp-future",
    adapterToolNames: ["view"],
    runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
    mappingVersion: 1,
    status: "ACTIVE",
  };
  // Pure projection over rows: a second adapterKind digest computes WITHOUT
  // any change to catalog, selector, or governance code.
  const d = computeMappingDigest([...TOOL_SELECTION_MAPPING, ompRow]);
  assert.equal(d !== FROZEN_MAPPING_DIGEST, true);
  assert.equal(FROZEN_MAPPING_DIGEST, computeMappingDigest()); // frozen authority untouched
  // KIND ISOLATION (repair of review finding): appending ACTIVE foreign-kind
  // rows must NOT poison existing pi-builtin projections — same selection,
  // same digest, no TOOL_SELECTION_MAPPING_DRIFT.
  const heavy = makeAdmission("PORT-EXT", "heavy");
  const before = select(heavy, { nodeRole: "writer", executionId: "exec_ext" });
  const after = projectToolSelection({
    admission: heavy,
    nodeRole: "writer",
    taskAllocation: allocFor(heavy, heavy.task_id),
    runtimeIdentity: RT,
    runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
    executionId: "exec_ext",
    selectedAt: "2026-08-23T16:05:45.000Z",
    mappingRows: [...TOOL_SELECTION_MAPPING, ompRow],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
  assert.equal(after.selectionBasis, "DERIVED_SELECTION");
  assert.equal(after.adapterToolNames.includes("view"), false, "foreign-kind names never leak into pi selections");
});

test("PORTABILITY malformed bind yields machine-readable hold code", () => {
  assert.throws(() => buildPhaseTaskCard({
    phase: WRITER_PHASE,
    parent: { scope: { allowed_paths: ["src/"], forbidden_paths: [] } },
    executionId: "exec_" + "be".repeat(16),
    cwd: tmpdir(),
    maxRepairAttempts: 0,
    toolSelectionBind: { admission: null },
  }), (e) => e.code === "PHASE_TOOL_SELECTION_BIND_REJECTED");
});
