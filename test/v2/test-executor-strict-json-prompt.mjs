// test/v2/test-executor-strict-json-prompt.mjs
//
// C4L — executor strict-JSON prompt hardening.
//
// The executor final-response contract must now demand, in explicit terms:
//   first non-whitespace char of the final response = '{'
//   exactly one JSON object, nothing else
//   no prose/summary/acknowledgement/fence/heading before the JSON
//   nothing after the closing '}'
//   completion statements forbidden（e.g. "All work is complete"）
//   schema-exact JSON
//   contract-defined failure JSON instead of prose when evidence cannot be
//     produced（known_failures / negative_evidence / scope_deviations）
//
// The reviewer contract is intentionally unchanged（C4L scope = executor only）.
// Strict JSON.parse / lifecycle verdict / adapter extraction / schema / gates /
// tool permissions / retry policy / model config are untouched. Existing
// scripted fixtures（canonical JSON → PASS; prose → EXECUTOR_EVIDENCE_INVALID）
// must keep behaving identically, and the successful executor evidence shape
// must be unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { runAutoLoop } from "../../src/autoloop.mjs";
import {
  buildPhaseExecutionPrompt,
  buildExecutorCanonicalExample,
  buildReviewerCanonicalExample,
  FINAL_RESPONSE_CONTRACT_CORE,
  EXECUTOR_FINAL_RESPONSE_CONTRACT,
  EXECUTOR_FINAL_RESPONSE_CONTRACT_HARDENING,
  PROMPT_MAX_BYTES,
} from "../../src/v2/phase-response-contract.mjs";
import { buildPhaseTaskCard } from "../../src/v2/phase-task-card.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";

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

// ── Build the exact executor prompt a real campaign would send ──
function buildExecutorPrompt() {
  const ir = validIr();
  const phase = ir.phases[0];
  const card = buildPhaseTaskCard({
    phase,
    parent: PARENT,
    executionId: "exec_c4ltest000000000000000000000000",
    cwd: "/tmp/c4l-fixture-repo",
    maxRepairAttempts: 0,
    expectedReviewerModel: "deepseek-v4-flash",
    toolPolicy: { mode: "allowlist", tools: ["read", "bash", "edit", "write"] },
    environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  });
  return buildPhaseExecutionPrompt({ phase, taskCard: card, lifecyclePhase: "executor", attempt: 0 });
}

let execCounter = 0;
function freshExecutionId() {
  execCounter += 1;
  return `exec_${createHash("sha256").update(`c4l-${Date.now()}-${execCounter}`).digest("hex").slice(0, 32)}`;
}

function makeTempRepo() {
  const repo = mkdtempSync(join(tmpdir(), "c4l-repo-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "add.mjs"), "export function add(a, b) { return a + b; }\n");
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=c4l", "-c", "user.email=c4l@x", "commit", "-q", "-m", "fixture"], { cwd: repo });
  return repo;
}

async function runDurable({ executorStdout, reviewerVerdict }) {
  const repo = makeTempRepo();
  const root = mkdtempSync(join(tmpdir(), "c4l-evidence-"));
  const executionId = freshExecutionId();
  const executorEvidence = buildExecutorCanonicalExample();
  const reviewerDefault = buildReviewerCanonicalExample({ expectedReviewerModel: "deepseek-v4-flash" });
  const result = await runAutoLoop({
    source: SOURCE,
    parent: PARENT,
    manifest: MANIFEST,
    cwd: repo,
    decompositionAdapter: { generate: async () => ({ status: "completed", parsed: validIr(), requestCount: 1, elapsedMs: 1 }) },
    executorAdapterFactory: () => createScriptedAdapter([
      { expect: { phase: "executor", attempt: 0 }, result: (req) => ({
        status: "completed", executionId: "x",
        // C4N: bind the evidence contract identity to the phase execution id.
        stdout: executorStdout !== undefined ? executorStdout : JSON.stringify({ ...executorEvidence, contract_id: req.taskCard?.executionId }),
        stderr: "", metadata: {} }) },
    ]),
    reviewerAdapterFactory: () => createScriptedAdapter([
      { expect: { phase: "reviewer", attempt: 0 }, result: { status: "completed", executionId: "x", stdout: reviewerVerdict ?? JSON.stringify(reviewerDefault), stderr: "", metadata: {} } },
    ]),
    maxRepairAttempts: 0,
    timeoutMs: 30_000,
    hooks: {
      environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
      executorAdapterPolicy: { writer_phase: { mode: "allowlist", tools: ["read", "bash", "edit", "write"] }, verification_phase: { mode: "allowlist", tools: ["read", "bash"] } },
      reviewerAdapterPolicy: { mode: "no-tools" },
      expectedReviewerModel: "deepseek-v4-flash",
      // C4Q harness configuration（never model text）.
      verificationCommand: ["node", "-e", "process.exit(0)"],
      expectedExecutorModel: "deepseek-v4-flash",
      expectedExecutorProvider: "deepseek",
    },
    persistence: { mode: "durable", root, executionId, resume: false },
  });
  return { result, root, execDir: join(root, executionId) };
}

function cleanup(r) {
  try { rmSync(r.root, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── C4L-1: first non-whitespace char must be '{' ──
test("C4L-1 prompt requires the first non-whitespace character to be '{'", () => {
  const ep = buildExecutorPrompt();
  assert.ok(ep.includes("The first non-whitespace character of your final response MUST be '{'."), ep.slice(-600));
  assert.ok(EXECUTOR_FINAL_RESPONSE_CONTRACT.includes("first non-whitespace"));
});

// ── C4L-2: prose before/after the JSON is forbidden ──
test("C4L-2 prompt forbids prose before and after the JSON", () => {
  const ep = buildExecutorPrompt();
  assert.ok(ep.includes("Do not write a summary, explanation, acknowledgement, Markdown fence, heading, or any prose before the JSON."));
  assert.ok(ep.includes("Do not include prose before or after the JSON."));
  assert.ok(ep.includes("Completion statements such as \"All work is complete\" are forbidden in the final response."));
});

// ── C4L-3: Markdown code fence forbidden ──
test("C4L-3 prompt forbids Markdown code fences", () => {
  const ep = buildExecutorPrompt();
  assert.ok(ep.includes("Markdown fence"));
  assert.ok(ep.includes("Do not include Markdown fences."));
});

// ── C4L-4: exactly one JSON object ──
test("C4L-4 prompt requires exactly one JSON object", () => {
  const ep = buildExecutorPrompt();
  assert.ok(ep.includes("Your final response MUST contain exactly one JSON object and nothing else."));
  assert.ok(ep.includes("exactly one JSON object conforming to the supplied canonical schema"));
  assert.ok(ep.includes("Nothing may follow the closing '}' of the JSON object."));
});

// ── C4L-5: contract-defined failure JSON path ──
test("C4L-5 prompt defines the failure JSON path instead of prose", () => {
  const ep = buildExecutorPrompt();
  assert.ok(ep.includes("contract-defined failure JSON"));
  assert.ok(ep.includes("known_failures"));
  assert.ok(ep.includes("negative_evidence"));
  assert.ok(ep.includes("scope_deviations"));
  assert.ok(ep.includes("instead of prose"));
});

// ── C4L-6: reviewer contract unchanged（executor-only scope）──
test("C4L-6 reviewer final-response contract is unchanged", () => {
  const { buildPhaseExecutionPrompt: build } = awaitImportContract();
  const ir = validIr();
  const phase = ir.phases[0];
  const card = buildPhaseTaskCard({
    phase, parent: PARENT, executionId: "exec_c4ltest000000000000000000000000",
    cwd: "/tmp/c4l-fixture-repo", maxRepairAttempts: 0, expectedReviewerModel: "deepseek-v4-flash",
    toolPolicy: { mode: "allowlist", tools: ["read", "bash", "edit", "write"] }, environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  });
  const rp = build({ phase, taskCard: card, lifecyclePhase: "reviewer", attempt: 0 });
  // reviewer prompt must not contain the executor-only hardening rules
  for (const s of ["non-whitespace", "Completion statements", "Nothing may follow the closing", "contract-defined failure JSON", "known_failures"]) {
    assert.ok(!rp.includes(s), `reviewer prompt must not contain executor hardening: ${s}`);
  }
  // reviewer contract == header + core, verbatim
  assert.ok(rp.includes("FINAL RESPONSE CONTRACT (reviewer — mandatory)"));
  assert.ok(rp.includes(FINAL_RESPONSE_CONTRACT_CORE));
  assert.ok(rp.trimEnd().endsWith("list."));
  // nothing after the core in the reviewer prompt
  const idx = rp.lastIndexOf(FINAL_RESPONSE_CONTRACT_CORE);
  assert.equal(rp.slice(idx + FINAL_RESPONSE_CONTRACT_CORE.length).trim().length, 0);
});

// ── C4L-7: executor prompt ends with the core; nothing after ──
test("C4L-7 executor prompt ends with the final-response contract core", () => {
  const ep = buildExecutorPrompt();
  assert.ok(ep.includes("FINAL RESPONSE CONTRACT (executor — mandatory)"));
  assert.ok(ep.includes(FINAL_RESPONSE_CONTRACT_CORE));
  const idx = ep.lastIndexOf(FINAL_RESPONSE_CONTRACT_CORE);
  assert.equal(ep.slice(idx + FINAL_RESPONSE_CONTRACT_CORE.length).trim().length, 0);
  assert.ok(ep.trimEnd().endsWith("list."));
  assert.ok(Buffer.byteLength(ep, "utf8") <= PROMPT_MAX_BYTES, "executor prompt stays within PROMPT_MAX_BYTES");
});

// ── C4L-8: existing scripted fixtures keep their behavior ──
test("C4L-8 executor output format no longer gates evidence（C4Q harness-owned）", async () => {
  // canonical executor output -> reviewer PASS -> RUN_PASSED
  const ok = await runDurable({ executorStdout: undefined, reviewerVerdict: undefined });
  try {
    assert.equal(ok.result.final, "PASS");
    const journal = readdirSync(join(ok.execDir, "journal")).filter((x) => x.endsWith(".json")).sort()
      .map((f) => JSON.parse(readFileSync(join(ok.execDir, "journal", f), "utf8")).event_type);
    assert.ok(journal.includes("RUN_PASSED"));
    assert.ok(!journal.includes("PHASE_HELD"));
  } finally { cleanup(ok); }

  // prose-prefixed output also proceeds（C4Q: format variance is not a gate）
  const prose = await runDurable({ executorStdout: "All work is complete.\n" + JSON.stringify(buildExecutorCanonicalExample()) });
  try {
    assert.equal(prose.result.final, "PASS");
    const held = readJournalEvent(prose.execDir, "PHASE_HELD");
    assert.equal(held, null, "prose executor output no longer yields PHASE_HELD");
  } finally { cleanup(prose); }
});

// ── C4L-9: successful executor evidence shape unchanged ──
test("C4L-9 successful executor path keeps a harness-owned implementation-evidence artifact", async () => {
  const r = await runDurable({ executorStdout: undefined, reviewerVerdict: undefined });
  try {
    assert.equal(r.result.final, "PASS");
    // C4Q: the persisted evidence artifact is the harness-owned
    // implementation evidence; the executor output is a bounded diagnostic.
    assert.ok(existsSync(join(r.execDir, "phases", "fix_add_implementation", "implementation-evidence-0.json")));
    assert.ok(existsSync(join(r.execDir, "phases", "fix_add_implementation", "executor-output-0.json")));
    assert.ok(!existsSync(join(r.execDir, "phases", "fix_add_implementation", "executor-diagnostics.json")));
    const ev = JSON.parse(readFileSync(join(r.execDir, "phases", "fix_add_implementation", "implementation-evidence-0.json"), "utf8"));
    assert.equal(ev.schema_version, "autoloop.implementation-evidence/v1");
    const manifest = JSON.parse(readFileSync(join(r.execDir, "manifest.json"), "utf8"));
    assert.equal(manifest.final_verdict, "PASS");
  } finally { cleanup(r); }
});

function readJournalEvent(execDir, eventType) {
  const dir = join(execDir, "journal");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const ev = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (ev.event_type === eventType) return ev;
  }
  return null;
}

// small helper so the reviewer-prompt test can reuse the builder
function awaitImportContract() {
  return { buildPhaseExecutionPrompt: buildPhaseExecutionPrompt };
}
