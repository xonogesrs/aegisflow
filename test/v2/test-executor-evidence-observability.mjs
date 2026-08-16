// test/v2/test-executor-evidence-observability.mjs
//
// C4J — bounded EXECUTOR_EVIDENCE_INVALID observability.
//
// Every executor evidence failure（executor final assistant text failing
// strict JSON parse）must persist bounded, credential-safe durable
// diagnostics:
//   - phases/<phaseId>/executor-diagnostics.json（final assistant text ≤ 2 KiB
//     with truncation metadata + parse error + adapter protocol counters +
//     bounded stderr tail）
//   - PHASE_HELD journal payload carries diagnostics_persisted /
//     diagnostic_error / failure_code / phase_id / artifact references
//   - artifacts are written BEFORE the journal event（crash consistency:
//     journal event = commit point）
//
// Zero model calls（fake decomposition adapter + scripted executor/reviewer）.
// Decision semantics unchanged: no prompt/schema/parser/policy modification,
// no repair/retry/resample/fallback. All writes still pass the existing
// SECRET_PATTERNS fail-closed path（DURABLE_EVIDENCE_SECRET_RISK）.
// Successful executor evidence shape unchanged（C4J-7）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { runAutoLoopInternal } from "../../src/v2/stack-a-internal.mjs";
import { buildExecutorCanonicalExample, buildReviewerCanonicalExample } from "../../src/v2/phase-response-contract.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";
import { EXECUTOR_DIAGNOSTICS_LIMITS, buildExecutorEvidenceDiagnostics } from "../../src/lifecycle-runner.mjs";

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

// ── Valid DECOMPOSED IR（decomposition must PASS so the run reaches phases）──
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

let execCounter = 0;
function freshExecutionId() {
  execCounter += 1;
  return `exec_${createHash("sha256").update(`c4j-${Date.now()}-${execCounter}`).digest("hex").slice(0, 32)}`;
}

function makeTempRepo() {
  const repo = mkdtempSync(join(tmpdir(), "c4j-repo-"));
  execFileSync("mkdir", ["-p", join(repo, "src")]);
  writeFileSync(join(repo, "src", "add.mjs"), "export function add(a, b) { return a + b; }\n");
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=c4j", "-c", "user.email=c4j@x", "commit", "-q", "-m", "fixture"], { cwd: repo });
  return repo;
}

function fakeDecomposition(result) {
  return {
    generate: async () => ({ status: "completed", parsed: result, requestCount: 1, elapsedMs: 1 }),
  };
}

// Adapter metadata shaped like the real pi-rpc-adapter diagnostics the worker
// observes（protocolEventTypeCounts / toolCallCount / terminalReason / …）.
function diagMetadata() {
  return {
    childPid: 4242,
    eventCount: 14,
    toolCallCount: 2,
    exitCode: 0,
    terminalReason: "stop",
    rawWireBytes: 4096,
    protocolEventTypeCounts: {
      agent_settled: 1,
      message_end: 2,
      message_update: 10,
      tool_execution_end: 2,
      response: 1,
    },
    protocolBytesByEventType: {},
    protocolMaxObservedLineBytes: 512,
    protocolCumulativeBytes: 2048,
  };
}

// Reach the phase execution path（decomposition PASS）with a scripted
// executor that returns the given stdout/stderr/metadata.
async function runDurable({ executorStdout, executorStderr = "", executorMetadata = {}, reviewerVerdict }) {
  const repo = makeTempRepo();
  const root = mkdtempSync(join(tmpdir(), "c4j-evidence-"));
  const executionId = freshExecutionId();
  const executorEvidence = buildExecutorCanonicalExample();
  const reviewerDefault = buildReviewerCanonicalExample({ expectedReviewerModel: "deepseek-v4-flash" });
  const execResult = {
    status: "completed",
    executionId: "x",
    stdout: executorStdout !== undefined ? executorStdout : JSON.stringify(executorEvidence),
    stderr: executorStderr,
    metadata: executorMetadata,
  };
  const revResult = {
    status: "completed",
    executionId: "x",
    stdout: reviewerVerdict ?? JSON.stringify(reviewerDefault),
    stderr: "",
    metadata: {},
  };
  const result = await runAutoLoopInternal({
    source: SOURCE,
    parent: PARENT,
    manifest: MANIFEST,
    cwd: repo,
    decompositionAdapter: fakeDecomposition(validIr()),
    executorAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "executor", attempt: 0 }, result: (req) => ({
      ...execResult,
      // C4N: bind the evidence contract identity to the phase execution id.
      stdout: executorStdout !== undefined ? executorStdout : JSON.stringify({ ...executorEvidence, contract_id: req.taskCard?.executionId }),
    }) }]),
    reviewerAdapterFactory: () => createScriptedAdapter([{ expect: { phase: "reviewer", attempt: 0 }, result: revResult }]),
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

function readJournalEvent(execDir, eventType) {
  const dir = join(execDir, "journal");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const ev = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (ev.event_type === eventType) return ev;
  }
  return null;
}

function readOutputArtifact(execDir, phaseId = "fix_add_implementation") {
  const p = join(execDir, "phases", phaseId, "executor-output-0.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function cleanup(r) {
  try { rmSync(r.root, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── C4J-1（C4Q）: prose executor output → PASS; bounded diagnostic persisted ──
test("C4J-1 prose final assistant text no longer gates evidence; bounded output diagnostic persisted", async () => {
  const prose = "All evidence collected for the fix. Here is my report.";
  const r = await runDurable({ executorStdout: prose, executorMetadata: diagMetadata() });
  try {
    // C4Q: format variance must not decide evidence parseability — the run
    // proceeds to the reviewer（here PASS）.
    assert.equal(r.result.final, "PASS");
    assert.ok(!readJournalEvent(r.execDir, "PHASE_HELD"), "no PHASE_HELD for prose executor output");
    // the bounded, non-authoritative output diagnostic is persisted
    const diag = readOutputArtifact(r.execDir);
    assert.ok(diag, "executor-output-0.json exists");
    assert.equal(diag.kind, "executor_output_diagnostic");
    assert.equal(diag.authoritative, false);
    assert.equal(diag.final_assistant_text.stored, prose);
    assert.equal(diag.final_assistant_text.original_length, Buffer.byteLength(prose, "utf8"));
    assert.equal(diag.final_assistant_text.truncated, false);
    assert.equal(diag.parse_info.valid_json, false);
    assert.ok(diag.parse_info.error.includes("Unexpected token 'A'"), diag.parse_info.error);
    assert.equal(diag.protocol.tool_call_count, 2);
    assert.equal(diag.protocol.rpc_completion_status, "completed");
    assert.equal(diag.protocol.assistant_message_count, 2);
    assert.ok(diag.protocol.adapter_extraction_path.includes("get_last_assistant_text"));
  } finally { cleanup(r); }
});

// ── C4J-2（C4Q）: output formats distinguishable in the diagnostic ──
test("C4J-2 prose+JSON, pure prose, empty, malformed are distinguishable in the diagnostic parse info", async () => {
  const evidence = JSON.stringify(buildExecutorCanonicalExample());
  const cases = [
    { name: "prose+JSON", stdout: "All evidence:\n" + evidence, valid: false },
    { name: "pure-prose", stdout: "Here is some prose text, no JSON at all.", valid: false },
    { name: "empty", stdout: "", valid: false },
    { name: "malformed", stdout: "{not valid json", valid: false },
    { name: "strict-json", stdout: evidence, valid: true },
  ];
  const seen = new Map();
  for (const c of cases) {
    const r = await runDurable({ executorStdout: c.stdout, executorMetadata: diagMetadata() });
    try {
      assert.equal(r.result.final, "PASS", c.name); // evidence is harness-owned regardless of format
      const diag = readOutputArtifact(r.execDir);
      assert.ok(diag, `${c.name}: output diagnostic exists`);
      assert.equal(diag.parse_info.valid_json, c.valid, `${c.name}: parse info records format validity`);
      const key = diag.final_assistant_text.stored.slice(0, 80);
      assert.ok(!seen.has(key), `${c.name}: diagnostic must be distinct`);
      seen.set(key, c.name);
      if (c.name === "empty") {
        assert.equal(diag.final_assistant_text.original_length, 0);
        assert.equal(diag.parse_info.valid_json, false);
      }
    } finally { cleanup(r); }
  }
  assert.equal(seen.size, cases.length, "all five formats are individually distinguishable");
});

// ── C4J-3（C4Q）: oversized output truncated with deterministic metadata ──
test("C4J-3 oversized final assistant text is truncated with deterministic metadata", async () => {
  const big = "x".repeat(5000);
  const r = await runDurable({ executorStdout: big, executorMetadata: diagMetadata() });
  try {
    assert.equal(r.result.final, "PASS");
    const diag = readOutputArtifact(r.execDir);
    assert.ok(diag);
    assert.equal(diag.final_assistant_text.original_length, 5000);
    assert.equal(diag.final_assistant_text.truncated, true);
    assert.ok(diag.final_assistant_text.stored_length <= EXECUTOR_DIAGNOSTICS_LIMITS.max_final_text_bytes);
    assert.equal(diag.final_assistant_text.stored, "x".repeat(EXECUTOR_DIAGNOSTICS_LIMITS.max_final_text_bytes));
    const content = readFileSync(join(r.execDir, "phases", "fix_add_implementation", "executor-output-0.json"), "utf8");
    assert.ok(!content.includes("x".repeat(3000)), "oversized tail not persisted");
  } finally { cleanup(r); }
});

// ── C4J-4（C4Q）: synthetic secret blocks diagnostic persistence, no echo ──
test("C4J-4 synthetic secret blocks output-diagnostic persistence without echo", async () => {
  const secret = "sk-" + "a".repeat(32);
  const r = await runDurable({ executorStdout: "All evidence " + secret + " collected.", executorMetadata: diagMetadata() });
  try {
    assert.equal(r.result.final, "HOLD"); // durable write fail-closed on secret
    const held = readJournalEvent(r.execDir, "PHASE_HELD");
    assert.ok(held, "PHASE_HELD present");
    assert.equal(held.payload.reason, "EXECUTOR_OUTPUT_PERSISTENCE_FAILED");
    assert.ok(!existsSync(join(r.execDir, "phases", "fix_add_implementation", "executor-output-0.json")));
    for (const f of readdirSync(join(r.execDir, "journal")).filter((x) => x.endsWith(".json"))) {
      assert.ok(!readFileSync(join(r.execDir, "journal", f), "utf8").includes(secret));
    }
    assert.ok(!readFileSync(join(r.execDir, "manifest.json"), "utf8").includes(secret));
    assert.ok(!JSON.stringify(r.result).includes(secret), "run result carries no secret");
  } finally { cleanup(r); }
});

// ── C4J-5（C4Q）: stderr stays independent of the final assistant text ──
test("C4J-5 stderr and final assistant text remain separate in the output diagnostic", async () => {
  const stdout = "All evidence collected.";
  const stderr = "warning: something on stderr\nnote: second line\n";
  const r = await runDurable({ executorStdout: stdout, executorStderr: stderr, executorMetadata: diagMetadata() });
  try {
    assert.equal(r.result.final, "PASS");
    const diag = readOutputArtifact(r.execDir);
    assert.ok(diag);
    assert.equal(diag.final_assistant_text.stored, stdout);
    assert.ok(!diag.final_assistant_text.stored.includes("stderr"));
    assert.equal(diag.stderr_tail.stored, stderr);
    assert.equal(diag.stderr_tail.truncated, false);
    assert.equal(diag.protocol.stderr_byte_count, Buffer.byteLength(stderr, "utf8"));
  } finally { cleanup(r); }
});

// ── C4J-6（C4Q）: output diagnostic written before EXECUTOR_COMPLETED ──
test("C4J-6 output diagnostic artifact is written before the EXECUTOR_COMPLETED journal event", async () => {
  const r = await runDurable({ executorStdout: "All evidence collected.", executorMetadata: diagMetadata() });
  try {
    assert.equal(r.result.final, "PASS");
    const artifactPath = join(r.execDir, "phases", "fix_add_implementation", "executor-output-0.json");
    assert.ok(existsSync(artifactPath), "artifact exists");
    const artifactMtime = statSync(artifactPath).mtimeMs;
    const completed = readJournalEvent(r.execDir, "EXECUTOR_COMPLETED");
    assert.ok(completed, "EXECUTOR_COMPLETED journal event exists");
    const eventMtime = statSync(join(r.execDir, "journal", String(completed.sequence).padStart(12, "0") + ".json")).mtimeMs;
    assert.ok(artifactMtime <= eventMtime, `artifact ${artifactMtime} written before event ${eventMtime}`);
  } finally { cleanup(r); }
});

// ── C4J-7（C4Q）: success evidence artifact is harness-owned ──
test("C4J-7 successful path keeps a harness-owned implementation-evidence artifact", async () => {
  const r = await runDurable({ executorStdout: undefined, reviewerVerdict: undefined });
  try {
    assert.equal(r.result.final, "PASS");
    const journal = readdirSync(join(r.execDir, "journal")).filter((x) => x.endsWith(".json")).sort()
      .map((f) => JSON.parse(readFileSync(join(r.execDir, "journal", f), "utf8")).event_type);
    assert.ok(journal.includes("RUN_PASSED"));
    assert.ok(journal.includes("EXECUTOR_COMPLETED"));
    assert.ok(!journal.includes("PHASE_HELD"));
    assert.ok(!existsSync(join(r.execDir, "phases", "fix_add_implementation", "executor-diagnostics.json")));
    // the persisted artifact is the harness-owned implementation evidence
    const ev = JSON.parse(readFileSync(join(r.execDir, "phases", "fix_add_implementation", "implementation-evidence-0.json"), "utf8"));
    assert.ok(ev && typeof ev === "object");
    assert.equal(ev.schema_version, "autoloop.implementation-evidence/v1");
    assert.equal(ev.executor_invocation.role, "executor");
    assert.equal(readJournalEvent(r.execDir, "PHASE_HELD"), null);
  } finally { cleanup(r); }
});

// ── C4J-8（C4Q）: durable invariants on a HOLD run ──
test("C4J-8 hold run keeps durable invariants（no repair/resume, manifest consistent）", async () => {
  const r = await runDurable({
    executorStdout: "prose is fine now",
    executorMetadata: diagMetadata(),
    reviewerVerdict: JSON.stringify({ verdict: "HOLD", confidence: "HIGH", model: "deepseek-v4-flash", summary: "needs work", recommended_next_action: "HUMAN_REVIEW" }),
  });
  try {
    const files = readdirSync(join(r.execDir, "journal")).filter((x) => x.endsWith(".json")).sort();
    assert.ok(files.length >= 10, `journal has events (${files.length})`);
    let prev = "genesis";
    let seq = 0;
    for (const f of files) {
      const ev = JSON.parse(readFileSync(join(r.execDir, "journal", f), "utf8"));
      seq += 1;
      assert.equal(ev.sequence, seq);
      assert.equal(ev.previous_event_sha256, prev);
      const { event_sha256, ...rest } = ev;
      const { canonicalJson } = (() => {
        const sortKeys = (v) => {
          if (Array.isArray(v)) return v.map(sortKeys);
          if (v !== null && typeof v === "object") {
            const out = {};
            for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
            return out;
          }
          return v;
        };
        return { canonicalJson: (v) => JSON.stringify(sortKeys(v)) };
      })();
      assert.equal(event_sha256, createHash("sha256").update(canonicalJson(rest) + "\n").digest("hex"));
      prev = event_sha256;
    }
    for (const f of files) {
      const ev = JSON.parse(readFileSync(join(r.execDir, "journal", f), "utf8"));
      assert.ok(!["PHASE_REPAIR_REQUESTED", "RESUME_REQUESTED", "RESUME_VALIDATED", "RESUME_REJECTED"].includes(ev.event_type), ev.event_type);
    }
    const manifest = JSON.parse(readFileSync(join(r.execDir, "manifest.json"), "utf8"));
    assert.equal(manifest.final_verdict, "HOLD");
    const manifestBody = readFileSync(join(r.execDir, "manifest.json"), "utf8");
    const manifestShaFile = readFileSync(join(r.execDir, "manifest.json.sha256"), "utf8").trim().split(/\s+/)[0];
    assert.equal(createHash("sha256").update(manifestBody).digest("hex"), manifestShaFile);
  } finally { cleanup(r); }
});

// ── C4J-9: buildExecutorEvidenceDiagnostics is a pure, bounded function ──
test("C4J-9 buildExecutorEvidenceDiagnostics bounds stderr tail deterministically", () => {
  const stderr = "line1\n" + "z".repeat(6000) + "\nlast";
  const diag = buildExecutorEvidenceDiagnostics(
    { stdout: "All evidence.", stderr, status: "completed", metadata: diagMetadata() },
    { name: "SyntaxError", message: "Unexpected token 'A', \"All evidenc\"... is not valid JSON" },
  );
  assert.equal(diag.final_assistant_text.stored, "All evidence.");
  assert.equal(diag.stderr_tail.truncated, true);
  assert.ok(diag.stderr_tail.stored_length <= EXECUTOR_DIAGNOSTICS_LIMITS.max_stderr_tail_bytes);
  assert.equal(diag.stderr_tail.original_length, Buffer.byteLength(stderr, "utf8"));
  assert.equal(diag.stderr_tail.stored, stderr.slice(-EXECUTOR_DIAGNOSTICS_LIMITS.max_stderr_tail_bytes));
  assert.equal(diag.protocol.stderr_line_count, 3);
  assert.equal(diag.parse_error.type, "SyntaxError");
  // deterministic: same input → same output
  const again = buildExecutorEvidenceDiagnostics(
    { stdout: "All evidence.", stderr, status: "completed", metadata: diagMetadata() },
    { name: "SyntaxError", message: "Unexpected token 'A', \"All evidenc\"... is not valid JSON" },
  );
  assert.equal(JSON.stringify(diag), JSON.stringify(again));
});
