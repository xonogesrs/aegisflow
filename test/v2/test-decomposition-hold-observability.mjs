// test/v2/test-decomposition-hold-observability.mjs
//
// C4F — bounded DECOMPOSITION_HELD observability.
//
// Every decomposition hold must persist enough bounded, credential-safe
// durable evidence to reconstruct the exact failing gate and field:
//   - artifacts/decomposition-ir.json（bounded rejected IR）
//   - artifacts/decomposition-validation.json（schema/structural/semantic
//     gate snapshots + frontier + hardFailures + truncation meta）
//   - artifacts/decomposition-response.json（transport status）
//   - DECOMPOSITION_HELD journal payload carries hard_failures +
//     diagnostics_persisted + diagnostic_error
//
// Zero model calls（fake decomposition adapter + scripted executor/reviewer）.
// Decision semantics unchanged: no prompt/schema/gate/policy modification,
// no repair/retry/resample/fallback. All writes still pass the existing
// SECRET_PATTERNS fail-closed path（DURABLE_EVIDENCE_SECRET_RISK）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { runAutoLoopInternal } from "../../src/v2/stack-a-internal.mjs";
import { validateSemantic } from "../../src/orchestration/validators/semantic-consistency.mjs";
import { buildExecutorCanonicalExample, buildReviewerCanonicalExample } from "../../src/v2/phase-response-contract.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";
import { DECOMP_HOLD_DIAGNOSTICS_LIMITS, boundIrForDiagnostics } from "../../src/v2/durable-execution.mjs";

const MANIFEST = [
  { requirement_id: "R1", text: "Correct src/add.mjs so add(a, b) returns the arithmetic sum." },
  { requirement_id: "R2", text: "Preserve the exported function name and module interface." },
  { requirement_id: "R3", text: "Modify no repository artifact except src/add.mjs." },
  { requirement_id: "R4", text: "Use a distinct read-only verification phase after implementation." },
  { requirement_id: "R5", text: "Verification must run npm test and must depend on implementation." },
  { requirement_id: "R6", text: "Do not commit, push, create remotes, install packages, or access files outside the isolated repository." },
  { requirement_id: "R7", text: "Return canonical bounded execution evidence for executor and reviewer." },
];
const PARENT = { scope: { allowed_paths: ["src/add.mjs"], forbidden_paths: ["package.json", "test/add.test.mjs", ".git/**"] } };
const SOURCE = {
  goal: "Repair the isolated fixture repository so add(a, b) performs arithmetic addition and the existing test suite passes.",
  requirements: MANIFEST,
  authority: { allowed_paths: ["src/add.mjs"], mutation_allowed: true, commit_allowed: false },
};

// ── Valid DECOMPOSED IR（same shape as the real C4 accepted decomposition）──
function validIr() {
  return {
    verdict: "DECOMPOSED",
    parent_goal: SOURCE.goal,
    execution_policy: { executor: "INHERIT_PARENT", multi_model_orchestration: false, reviewer: "EXTERNAL_GPT" },
    decomposition_evidence: [
      "Implementation phase changes only src/add.mjs and covers R1, R2, R3, and R6.",
      "Read-only verification phase after implementation runs npm test and covers R4, R5, and R7.",
    ],
    phases: [
      {
        phase_id: "fix_add_implementation",
        title: "Fix add implementation",
        summary: "Correct the implementation so the module behaves as specified.",
        responsibility: "Modify only src/add.mjs to correct the implementation.",
        purpose: "implementation",
        effects: {
          artifact_mutation: "required",
          boundaries: { artifact: ["src/add.mjs"], evidence: [], external_system: [], runtime: [] },
          evidence_output: "none",
          external_system_mutation: "forbidden",
          runtime_side_effect: "forbidden",
        },
        covers: [
          { claim: "Rewrites add(a,b) to return the arithmetic sum a + b.", completeness: "complete", requirement_id: "R1" },
          { claim: "Keeps the exported function named add and preserves the ES module interface.", completeness: "complete", requirement_id: "R2" },
          { claim: "The only repository artifact changed is src/add.mjs.", completeness: "complete", requirement_id: "R3" },
          { claim: "No commit/push/remote/package-install/outside access; only src/add.mjs is mutated.", completeness: "complete", requirement_id: "R6" },
        ],
        depends_on: [],
      },
      {
        phase_id: "verify_npm_test",
        title: "Verify with npm test",
        summary: "Run the project verification command and confirm the fix.",
        responsibility: "Execute npm test and verify the corrected add(a,b) passes.",
        purpose: "verification",
        effects: {
          artifact_mutation: "forbidden",
          boundaries: { artifact: [], evidence: ["executor_reviewer_evidence_bundle"], external_system: [], runtime: ["isolated_repository_test_execution"] },
          evidence_output: "ephemeral",
          external_system_mutation: "forbidden",
          runtime_side_effect: "allowed",
        },
        covers: [
          { claim: "Distinct read-only verification phase after implementation.", completeness: "complete", requirement_id: "R4" },
          { claim: "Runs npm test and depends on the implementation phase.", completeness: "complete", requirement_id: "R5" },
          { claim: "Returns canonical bounded execution evidence.", completeness: "complete", requirement_id: "R7" },
        ],
        depends_on: ["fix_add_implementation"],
        verification_plan: {
          subject_phase_ids: ["fix_add_implementation"],
          method: "Run npm test inside the isolated repository.",
          success_criteria: "All existing tests pass.",
          failure_criteria: "Any test failure.",
          evidence: "npm test transcript and src/add.mjs diff.",
        },
      },
    ],
    dispositions: [],
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));
// H9 defect: verification phase without verification_plan
function invalidH9Ir() {
  const ir = validIr();
  delete ir.phases[1].verification_plan;
  return ir;
}
// H4 defect: R3 cover removed（uncovered requirement → Z1）
function invalidH4Ir() {
  const ir = validIr();
  ir.phases[0].covers = ir.phases[0].covers.filter((c) => c.requirement_id !== "R3");
  return ir;
}
// Oversized free text（100 KiB claim）+ H9 defect — hold path with oversized
// text; the diagnostics must bound it, never write it unbounded.
function largeIr() {
  const ir = invalidH9Ir();
  ir.phases[0].covers[0].claim = "x".repeat(100 * 1024);
  return ir;
}
// Synthetic secret inside a cover claim + H9 defect — hold-path diagnostics
// must be blocked by the existing SECRET_PATTERNS fail-closed write path.
function secretIr() {
  const ir = invalidH9Ir();
  ir.phases[0].covers[0].claim = "synthetic credential " + "sk-" + "a".repeat(32) + " in claim";
  return ir;
}

let execCounter = 0;
function freshExecutionId() {
  execCounter += 1;
  return `exec_${createHash("sha256").update(`c4f-${Date.now()}-${execCounter}`).digest("hex").slice(0, 32)}`;
}

function makeTempRepo() {
  const repo = mkdtempSync(join(tmpdir(), "c4f-repo-"));
  execFileSync("mkdir", ["-p", join(repo, "src")]);
  writeFileSync(join(repo, "src", "add.mjs"), "export function add(a, b) { return a + b; }\n");
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=c4f", "-c", "user.email=c4f@x", "commit", "-q", "-m", "fixture"], { cwd: repo });
  return repo;
}

function fakeDecomposition(result) {
  return {
    generate: async () => {
      // Transport-shaped results（status present）are returned as-is; plain
      // IR objects are wrapped as a completed transport response.
      if (result && typeof result === "object" && result.status) return result;
      return { status: "completed", parsed: result, requestCount: 1, elapsedMs: 1 };
    },
  };
}

function scriptedFactories() {
  const executorEvidence = buildExecutorCanonicalExample();
  const reviewerVerdict = buildReviewerCanonicalExample({ expectedReviewerModel: "deepseek-v4-flash" });
  // The durable orchestrator creates FRESH executor and reviewer adapters per
  // phase（session reuse = 0）; each role needs a single-step script.
  const execScript = [
    { expect: { phase: "executor", attempt: 0 }, result: (req) => ({
      status: "completed", executionId: "x",
      // C4N: bind the evidence contract identity to the phase execution id.
      stdout: JSON.stringify({ ...executorEvidence, contract_id: req.taskCard?.executionId }), stderr: "", metadata: {} }) },
  ];
  const revScript = [
    { expect: { phase: "reviewer", attempt: 0 }, result: { status: "completed", executionId: "x", stdout: JSON.stringify(reviewerVerdict), stderr: "", metadata: {} } },
  ];
  return {
    executorFactory: () => createScriptedAdapter(execScript),
    reviewerFactory: () => createScriptedAdapter(revScript),
  };
}

async function runDurable({ ir, secret = false }) {
  const repo = makeTempRepo();
  const root = mkdtempSync(join(tmpdir(), "c4f-evidence-"));
  const executionId = freshExecutionId();
  const factories = scriptedFactories();
  const result = await runAutoLoopInternal({
    source: SOURCE,
    parent: PARENT,
    manifest: MANIFEST,
    cwd: repo,
    decompositionAdapter: secret
      ? fakeDecomposition(secretIr())
      : fakeDecomposition(ir),
    executorAdapterFactory: factories.executorFactory,
    reviewerAdapterFactory: factories.reviewerFactory,
    maxRepairAttempts: 0,
    timeoutMs: 30_000,
    hooks: {
      environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
      executorAdapterPolicy: { writer_phase: { mode: "allowlist", tools: ["read", "bash", "edit", "write"] }, verification_phase: { mode: "allowlist", tools: ["read", "bash"] } },
      reviewerAdapterPolicy: { mode: "no-tools" },
      expectedReviewerModel: "deepseek-v4-flash",
      // C4Q harness configuration.
      verificationCommand: ["node", "-e", "process.exit(0)"],
      expectedExecutorModel: "deepseek-v4-flash",
      expectedExecutorProvider: "deepseek",
    },
    persistence: { mode: "durable", root, executionId, resume: false },
  });
  const execDir = join(root, executionId);
  const heldEvent = readJournalEvent(execDir, "DECOMPOSITION_HELD");
  return { result, root, execDir, heldEvent };
}

function readJournalEvent(execDir, eventType) {
  const dir = join(execDir, "journal");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const ev = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (ev.event_type === eventType) return ev;
  }
  return null;
}

function readArtifact(execDir, name) {
  const p = join(execDir, "artifacts", name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function cleanup(r) {
  try { rmSync(r.root, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── C4F-1: hold persists bounded diagnostics（exact gate + field）──
test("C4F-1 DECOMPOSITION_HELD persists bounded diagnostics with the exact gate", async () => {
  const r = await runDurable({ ir: invalidH9Ir() });
  try {
    assert.equal(r.result.final, "HOLD");
    assert.equal(r.result.reason, "SEMANTIC_GATE_FAILED");
    assert.ok(r.heldEvent, "DECOMPOSITION_HELD event exists");
    assert.equal(r.heldEvent.payload.diagnostics_persisted, true);
    assert.ok(Array.isArray(r.heldEvent.payload.hard_failures));
    assert.ok(r.heldEvent.payload.hard_failures.some((h) => h.includes("H9")), JSON.stringify(r.heldEvent.payload.hard_failures));
    // artifacts
    const validation = readArtifact(r.execDir, "decomposition-validation.json");
    assert.ok(validation, "decomposition-validation.json exists");
    const h9 = (validation.semantic || []).find((g) => g.gate_id === "H9");
    assert.ok(h9 && h9.pass === false && h9.failure_code === "H9_CLOSURE", JSON.stringify(h9));
    assert.ok(h9.evidence.includes("verification requires verification_plan"));
    assert.ok(readArtifact(r.execDir, "decomposition-ir.json"), "decomposition-ir.json exists");
    assert.ok(readArtifact(r.execDir, "decomposition-response.json"), "decomposition-response.json exists");
  } finally { cleanup(r); }
});

// ── C4F-2: readback reconstructs the exact failure from the persisted IR ──
test("C4F-2 readback re-runs gates on the persisted IR and reproduces the failure", async () => {
  const r = await runDurable({ ir: invalidH4Ir() });
  try {
    const persistedIr = readArtifact(r.execDir, "decomposition-ir.json");
    assert.ok(persistedIr, "persisted IR exists");
    const sem = validateSemantic(persistedIr, MANIFEST);
    const h4 = sem.gates.find((g) => g.gate_id === "H4");
    assert.ok(h4 && h4.pass === false && h4.failure_code === "H4_COMPLETENESS");
    assert.ok(h4.evidence.includes("R3: not covered nor dispositioned"), h4.evidence);
    // journal hard_failures map to the same gate
    assert.ok(r.heldEvent.payload.hard_failures.some((h) => h.includes("H4")), JSON.stringify(r.heldEvent.payload.hard_failures));
    // diagnostic meta records the failure path
    const validation = readArtifact(r.execDir, "decomposition-validation.json");
    const persistedH4 = (validation.semantic || []).find((g) => g.gate_id === "H4");
    assert.ok(persistedH4 && persistedH4.pass === false);
  } finally { cleanup(r); }
});

// ── C4F-3: oversized IR is bounded, never written unbounded ──
test("C4F-3 oversized IR is bounded with deterministic truncation markers", async () => {
  const r = await runDurable({ ir: largeIr() });
  try {
    const rawPath = join(r.execDir, "artifacts", "decomposition-ir.json");
    const bytes = readFileSync(rawPath);
    assert.ok(bytes.length < DECOMP_HOLD_DIAGNOSTICS_LIMITS.max_ir_bytes * 2, `file ${bytes.length} B`);
    const validation = readArtifact(r.execDir, "decomposition-validation.json");
    assert.ok(Array.isArray(validation.diagnostic_meta?.truncated_fields));
    assert.ok(validation.diagnostic_meta.truncated_fields.some((p) => p.includes("claim")), JSON.stringify(validation.diagnostic_meta.truncated_fields));
    // The 100 KiB string must not appear in any artifact
    const content = readFileSync(rawPath, "utf8");
    assert.ok(!content.includes("x".repeat(10 * 1024)), "oversized string not written verbatim");
  } finally { cleanup(r); }
});

// ── C4F-4: synthetic secret blocks persistence, never echoed ──
test("C4F-4 synthetic secret blocks evidence persistence without echo", async () => {
  const r = await runDurable({ ir: secretIr() });
  try {
    assert.equal(r.result.final, "HOLD"); // underlying verdict intact
    assert.equal(r.result.reason, "SEMANTIC_GATE_FAILED");
    assert.equal(r.heldEvent.payload.diagnostics_persisted, false);
    assert.equal(r.heldEvent.payload.diagnostic_error, "DURABLE_EVIDENCE_SECRET_RISK");
    // blocked artifacts absent（fail-closed persistence）
    assert.ok(!existsSync(join(r.execDir, "artifacts", "decomposition-ir.json")));
    assert.ok(!existsSync(join(r.execDir, "artifacts", "decomposition-validation.json")));
    // secret never echoed into journal / manifest / control files
    const needle = "sk-" + "a".repeat(32);
    for (const f of readdirSync(join(r.execDir, "journal")).filter((x) => x.endsWith(".json"))) {
      assert.ok(!readFileSync(join(r.execDir, "journal", f), "utf8").includes(needle));
    }
    assert.ok(!readFileSync(join(r.execDir, "manifest.json"), "utf8").includes(needle));
    assert.ok(!readFileSync(join(r.execDir, "final-report.json"), "utf8").includes(needle));
    assert.ok(!JSON.stringify(r.heldEvent.payload).includes(needle));
  } finally { cleanup(r); }
});

// ── C4F-5: success path behavior and evidence shape unchanged ──
test("C4F-5 success path keeps the pre-C4F evidence shape", async () => {
  const r = await runDurable({ ir: validIr() });
  try {
    assert.equal(r.result.final, "PASS");
    const journal = readdirSync(join(r.execDir, "journal")).filter((x) => x.endsWith(".json")).sort()
      .map((f) => JSON.parse(readFileSync(join(r.execDir, "journal", f), "utf8")).event_type);
    assert.ok(journal.includes("DECOMPOSITION_COMPLETED"));
    assert.ok(journal.includes("DAG_ACCEPTED"));
    assert.ok(journal.includes("RUN_PASSED"));
    // C4Q: the persisted evidence artifact is harness-owned.
    assert.ok(existsSync(join(r.execDir, "phases", "fix_add_implementation", "implementation-evidence-0.json")));
    assert.ok(existsSync(join(r.execDir, "phases", "fix_add_implementation", "executor-output-0.json")));
    // PASS-path validation artifact keeps the original shape（no diagnostic_meta）
    const validation = readArtifact(r.execDir, "decomposition-validation.json");
    assert.ok(validation.schema_valid === true);
    assert.ok(!("diagnostic_meta" in validation));
    assert.ok(!("hard_failures" in validation));
    for (const g of validation.semantic || []) {
      assert.deepEqual(Object.keys(g).sort(), ["gate_id", "pass"]);
    }
    // no DECOMPOSITION_HELD on the success path
    assert.ok(!journal.includes("DECOMPOSITION_HELD"));
  } finally { cleanup(r); }
});

// ── C4F-6: transport-stage hold also persists bounded diagnostics（null IR）──
test("C4F-6 transport-stage hold persists bounded diagnostics with null IR", async () => {
  const repo = makeTempRepo();
  const root = mkdtempSync(join(tmpdir(), "c4f-evidence-"));
  const executionId = freshExecutionId();
  const factories = scriptedFactories();
  try {
    const result = await runAutoLoopInternal({
      source: SOURCE,
      parent: PARENT,
      manifest: MANIFEST,
      cwd: repo,
      decompositionAdapter: fakeDecomposition({ status: "error", reason: "provider_error", requestCount: 0, elapsedMs: 1 }),
      executorAdapterFactory: factories.executorFactory,
      reviewerAdapterFactory: factories.reviewerFactory,
      maxRepairAttempts: 0,
      timeoutMs: 30_000,
      hooks: { environmentAllowlist: ["PATH", "HOME", "TMPDIR"], expectedReviewerModel: "deepseek-v4-flash" },
      persistence: { mode: "durable", root, executionId, resume: false },
    });
    const execDir = join(root, executionId);
    const held = readJournalEvent(execDir, "DECOMPOSITION_HELD");
    assert.equal(result.final, "HOLD");
    assert.equal(held.payload.stage, "transport");
    assert.equal(held.payload.diagnostics_persisted, true);
    const ir = readArtifact(execDir, "decomposition-ir.json");
    assert.equal(ir, null); // no IR on transport hold, still persisted bounded
    const validation = readArtifact(execDir, "decomposition-validation.json");
    assert.ok(validation && validation.schema_valid === false);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  }
});

// ── C4F-7: bounded envelope is a pure function with caps（unit）──
test("C4F-7 boundIrForDiagnostics preserves gate-relevant fields and caps free text", () => {
  const ir = validIr();
  const big = clone(ir);
  big.phases[0].covers[0].claim = "y".repeat(10_000);
  const bounded = boundIrForDiagnostics(big);
  assert.ok(bounded.value.phases[0].covers[0].claim.length <= DECOMP_HOLD_DIAGNOSTICS_LIMITS.max_field_chars);
  assert.equal(bounded.value.phases[0].purpose, "implementation"); // structural value preserved
  assert.equal(bounded.value.phases[1].verification_plan.subject_phase_ids[0], "fix_add_implementation");
  assert.ok(bounded.truncatedFields.some((p) => p.includes("claim")));
  // bounded IR still re-runs gates identically for the defect
  const h9 = clone(validIr());
  delete h9.phases[1].verification_plan;
  const b = boundIrForDiagnostics(h9);
  const sem = validateSemantic(b.value, MANIFEST);
  const g = sem.gates.find((x) => x.gate_id === "H9");
  assert.ok(g && g.pass === false);
});
