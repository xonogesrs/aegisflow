// test/v2/test-phase-response-contract.mjs
//
// C4R focused tests — phase output contract projection, prompt composition,
// strict-parse regression, and a fake-Pi child capture proving the operative
// prompt reaches the child intact. Zero model calls; the only child process
// spawned is test/fixtures/fake-pi-rpc.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  buildPhaseExecutionPrompt,
  buildExecutorSchemaProjection,
  buildReviewerSchemaProjection,
  buildExecutorCanonicalExample,
  buildReviewerCanonicalExample,
  buildExecutorFinalResponseContract,
  buildReviewerFinalResponseContract,
  EXECUTOR_FINAL_RESPONSE_CONTRACT,
  REVIEWER_FINAL_RESPONSE_CONTRACT,
  FINAL_RESPONSE_CONTRACT_CORE,
  PROMPT_MAX_BYTES,
  renderExecutorProjectionText,
  promptSha256,
} from "../../src/v2/phase-response-contract.mjs";
import { buildPhaseTaskCard, deriveScopePatterns } from "../../src/v2/phase-task-card.mjs";
import { captureScopeSnapshot } from "../../src/c2d/mutation-scope.mjs";
import { validateImplementationEvidence, IE_REQUIRED_FIELDS, IE_ALLOWED_FIELDS, IE_ITEM_SHAPE_COMMANDS } from "../../src/validate-role-artifacts.mjs";
import { normalize as normalizeReviewerVerdict, VERDICTS, CONFIDENCE, NEXT_ACTIONS } from "../../src/normalize-reviewer-json.mjs";
import { runLifecycle } from "../../src/lifecycle-runner.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";
import { createPiRpcAdapter, DEFAULT_ENV_ALLOWLIST } from "../../src/adapter/pi-rpc-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "..", "fixtures", "fake-pi-rpc.mjs");
const ALLOWLIST_WITH_CONTROL = [...DEFAULT_ENV_ALLOWLIST, "FAKE_PI_CONTROL"];

// ── Fixtures ──────────────────────────────────────────────────────────

const WRITER_PHASE = {
  phase_id: "impl",
  title: "Fix target implementation",
  summary: "Correct the implementation so the module behaves as specified.",
  responsibility: "implementation",
  purpose: "implement",
  effects: {
    artifact_mutation: "allowed",
    runtime_side_effect: "forbidden",
    external_system_mutation: "forbidden",
    evidence_output: "bounded",
    boundaries: { artifact: ["src/add.mjs"] },
  },
  covers: [{ requirement_id: "R1" }, { requirement_id: "R2" }],
  depends_on: [],
  verification_plan: {
    subject_phase_ids: ["impl"],
    method: "run the project verification command",
    success_criteria: "all checks pass",
    failure_criteria: "any check fails",
    evidence: "verification output",
  },
};

const READONLY_PHASE = {
  ...WRITER_PHASE,
  phase_id: "verify",
  purpose: "verify",
  responsibility: "verification",
  effects: {
    artifact_mutation: "forbidden",
    runtime_side_effect: "forbidden",
    external_system_mutation: "forbidden",
    evidence_output: "bounded",
    boundaries: {},
  },
  covers: [{ requirement_id: "R3" }],
  depends_on: ["impl"],
};

const PARENT = { scope: { allowed_paths: ["src/add.mjs"], forbidden_paths: ["package.json", "test/add.test.mjs", ".git/**"] } };
function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "c4r-card-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}
const CWD = gitFixture();
const CARD_ARGS = {
  phase: WRITER_PHASE,
  parent: PARENT,
  executionId: "exec_c4rtest000000000000000000000000",
  cwd: CWD,
  maxRepairAttempts: 0,
  expectedReviewerModel: "deepseek-v4-flash",
  toolPolicy: { mode: "allowlist", tools: ["read", "bash", "edit", "write"] },
  environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
};

function writerCard() {
  const card = buildPhaseTaskCard(CARD_ARGS);
  // C4Q harness configuration + real baseline snapshot.
  card.verificationCommand = ["node", "-e", "process.exit(0)"];
  card.expectedExecutorModel = "deepseek-v4-flash";
  card.expectedExecutorProvider = "deepseek";
  card.mutationScope = {
    repositoryRoot: CWD,
    baselineSnapshot: captureScopeSnapshot(CWD),
    allowedPaths: deriveScopePatterns(card.allowedPaths),
    forbiddenPaths: deriveScopePatterns(card.forbiddenPaths),
  };
  return card;
}
function readonlyCard() {
  return buildPhaseTaskCard({ ...CARD_ARGS, phase: READONLY_PHASE });
}

function evidenceJson(value) {
  return JSON.stringify(value ?? buildExecutorCanonicalExample());
}
function verdictJson(overrides = {}) {
  return JSON.stringify({ ...buildReviewerCanonicalExample({ expectedReviewerModel: "deepseek-v4-flash" }), ...overrides });
}

function lifecycleWithExecutor(executorText, reviewerText) {
  const script = [
    { expect: { phase: "executor", attempt: 0 }, result: { status: "completed", executionId: "x", stdout: executorText, stderr: "", metadata: {} } },
  ];
  if (reviewerText !== undefined) {
    script.push({ expect: { phase: "reviewer", attempt: 0 }, result: { status: "completed", executionId: "x", stdout: reviewerText, stderr: "", metadata: {} } });
  }
  const adapter = createScriptedAdapter(script);
  return runLifecycle({
    cwd: CWD,
    taskCard: writerCard(),
    adapter,
    maxRepairAttempts: 0,
    timeoutMs: 5000,
    executorEvidenceValidator: validateImplementationEvidence,
  });
}

// ── 1/2. Projection consistency with canonical authorities ───────────

test("C4R-1 executor schema projection matches the canonical schema authority", () => {
  const proj = buildExecutorSchemaProjection();
  assert.deepEqual(proj.required_fields, [...IE_REQUIRED_FIELDS]);
  assert.deepEqual(proj.allowed_fields, [...IE_ALLOWED_FIELDS]);
  assert.equal(proj.schema_version, "autoloop.implementation-evidence/v1");
  assert.equal(proj.unknown_field_policy, "reject");
});

test("C4R-2 reviewer schema projection matches the runtime authority", () => {
  const proj = buildReviewerSchemaProjection();
  assert.deepEqual(proj.enums.verdict, [...VERDICTS].sort());
  assert.deepEqual(proj.enums.confidence, [...CONFIDENCE].sort());
  assert.deepEqual(proj.enums.recommended_next_action, [...NEXT_ACTIONS].sort());
  assert.deepEqual(proj.required_fields, ["verdict", "confidence", "model", "summary", "recommended_next_action"]);
  assert.ok(proj.pass_guard.includes("HIGH"));
});

// ── 3/4. Generic examples pass the real validators ───────────────────

test("C4R-3 executor canonical example passes validateImplementationEvidence", () => {
  const ex = buildExecutorCanonicalExample();
  const v = validateImplementationEvidence(ex);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test("C4R-4 reviewer canonical example normalizes to PASS", () => {
  const ex = buildReviewerCanonicalExample({ expectedReviewerModel: "deepseek-v4-flash" });
  const n = normalizeReviewerVerdict(ex, "deepseek-v4-flash");
  assert.equal(n.verdict, "PASS");
  assert.equal(n.confidence, "HIGH");
});

// ── 5. JSON-only instruction at prompt tail ──────────────────────────

test("C4R-5 executor prompt ends with the FINAL RESPONSE CONTRACT", () => {
  const card = writerCard();
  const ep = card.model_prompt.executor;
  assert.ok(ep.includes("FINAL RESPONSE CONTRACT (executor — mandatory)"));
  assert.ok(ep.trimEnd().endsWith("list."));
  assert.ok(ep.includes(FINAL_RESPONSE_CONTRACT_CORE));
  // Nothing after the contract core.
  const idx = ep.lastIndexOf(FINAL_RESPONSE_CONTRACT_CORE);
  assert.equal(ep.slice(idx + FINAL_RESPONSE_CONTRACT_CORE.length).trim().length, 0);
});

// ── 6/7. No C4 oracle / no credentials ───────────────────────────────

test("C4R-6 prompts contain no C4-specific oracle content", () => {
  const card = writerCard();
  const ep = card.model_prompt.executor;
  const rp = card.model_prompt.reviewer;
  // Answer-oracle strings must never appear anywhere in the prompts.
  for (const bad of ["npm test", "a - b", "fixture", "autoloop-c4", "add(", "expect the sum", "return a + b"]) {
    assert.ok(!ep.includes(bad) && !rp.includes(bad), `prompt must not contain: ${bad}`);
  }
  // The generic canonical examples must be free of campaign content.
  const joined = JSON.stringify(buildExecutorCanonicalExample()) + JSON.stringify(buildReviewerCanonicalExample());
  for (const bad of ["add.mjs", "npm test", "a - b", "fixture", "autoloop-c4"]) {
    assert.ok(!joined.includes(bad), `example must not contain: ${bad}`);
  }
  // "add.mjs" may appear ONLY in the phase-facts/authority sections (the
  // actual task boundary), never inside the canonical example block.
  const exampleSection = ep.slice(ep.indexOf("CANONICAL EXAMPLE"), ep.indexOf("FINAL RESPONSE CONTRACT"));
  assert.ok(!exampleSection.includes("add.mjs"), "example section must not reference the campaign target");
});

test("C4R-7 prompts contain no credential or environment material", () => {
  const card = writerCard();
  const joined = card.model_prompt.executor + "\n" + card.model_prompt.reviewer;
  for (const bad of ["api_key", "api key", "sk-", "DEEPSEEK", "auth.json", "Authorization", "cookie", "password", "secret", "token", "PATH=", "HOME=", "DEEPSEEK_API_KEY"]) {
    assert.ok(!joined.toLowerCase().includes(bad.toLowerCase()), `prompt must not contain: ${bad}`);
  }
  assert.ok(!JSON.stringify(card.executor_final_response_contract).includes("DEEPSEEK"));
});

// ── 8. Prompt size bound ─────────────────────────────────────────────

test("C4R-8 prompt size has an explicit upper bound and stays within it", () => {
  assert.ok(Number.isInteger(PROMPT_MAX_BYTES) && PROMPT_MAX_BYTES > 0);
  const card = writerCard();
  assert.ok(Buffer.byteLength(card.model_prompt.executor, "utf8") <= PROMPT_MAX_BYTES);
  assert.ok(Buffer.byteLength(card.model_prompt.reviewer, "utf8") <= PROMPT_MAX_BYTES);
});

// ── 9/10. Authority fields ───────────────────────────────────────────

test("C4R-9 writer task card carries allowed/forbidden boundary", () => {
  const card = writerCard();
  assert.deepEqual(card.allowedPaths, ["src/add.mjs"]);
  assert.ok(card.forbiddenPaths.includes("package.json"));
  assert.ok(card.forbiddenPaths.includes(".git/**"));
});

test("C4R-10 read-only task card has no mutation authority", () => {
  const card = readonlyCard();
  assert.deepEqual(card.allowedPaths, []);
});

// ── 11/12. Role separation + attempt invariance ──────────────────────

test("C4R-11 executor prompt differs clearly from reviewer prompt", () => {
  const card = writerCard();
  assert.notEqual(card.model_prompt.executor, card.model_prompt.reviewer);
  assert.ok(card.model_prompt.executor.includes("implementation-evidence"));
  assert.ok(card.model_prompt.reviewer.includes("reviewer-verdict"));
  // The executor prompt must not present the reviewer verdict schema as its
  // own contract, and vice versa.
  assert.ok(!card.model_prompt.executor.includes("recommended_next_action"));
});

test("C4R-12 attempt 0 and attempt 1 keep identical schema requirements", () => {
  const card = writerCard();
  const p0 = buildPhaseExecutionPrompt({ phase: WRITER_PHASE, taskCard: { ...card, model_prompt: undefined }, lifecyclePhase: "executor", attempt: 0 });
  const p1 = buildPhaseExecutionPrompt({ phase: WRITER_PHASE, taskCard: { ...card, model_prompt: undefined }, lifecyclePhase: "executor", attempt: 1 });
  assert.ok(p0.includes(EXECUTOR_FINAL_RESPONSE_CONTRACT));
  assert.ok(p1.includes(EXECUTOR_FINAL_RESPONSE_CONTRACT));
  const schemaA = renderExecutorProjectionText();
  assert.ok(p0.includes(schemaA) && p1.includes(schemaA));
  // Only the attempt context line differs.
  assert.ok(p0.includes("Attempt: 0"));
  assert.ok(p1.includes("Attempt: 1"));
});

// ── 13/14/15. Strict parsing regression（unchanged fail-closed）──────

test("C4R-13 prose executor output does not gate evidence（C4Q harness-owned）", async () => {
  // C4Q: the executor final message is non-authoritative; format variance must
  // not determine whether evidence is produced. Prose reaches the reviewer.
  const out = await lifecycleWithExecutor("Done. I fixed the file.", verdictJson());
  assert.equal(out.final, "PASS");
});

test("C4R-14 Markdown-fenced executor output does not gate evidence（C4Q）", async () => {
  const out = await lifecycleWithExecutor("```json\n" + evidenceJson() + "\n```", verdictJson());
  assert.equal(out.final, "PASS");
});

test("C4R-15 prose-wrapped executor output does not gate evidence（C4Q）", async () => {
  const out = await lifecycleWithExecutor("Here is the result:\n" + evidenceJson() + "\nThanks!", verdictJson());
  assert.equal(out.final, "PASS");
});

// ── 16/17. Exact canonical JSON flows through the lifecycle ──────────

test("C4R-16 exact canonical executor JSON proceeds to the reviewer", async () => {
  const out = await lifecycleWithExecutor(evidenceJson(), verdictJson());
  assert.equal(out.final, "PASS");
  assert.equal(out.attempt, 0);
});

test("C4R-17 exact canonical reviewer PASS JSON completes the lifecycle", async () => {
  const out = await lifecycleWithExecutor(evidenceJson(), verdictJson({ verdict: "PASS", recommended_next_action: "STOP" }));
  assert.equal(out.final, "PASS");
});

test("C4R-18 malformed reviewer JSON still yields HOLD", async () => {
  const out = await lifecycleWithExecutor(evidenceJson(), "not a verdict at all");
  assert.equal(out.final, "HOLD");
  assert.equal(out.reason, "MALFORMED_REVIEWER_VERDICT");
});

// ── 19/20. No new calls / no lifecycle bypass ────────────────────────

test("C4R-19 task-card construction performs no adapter or model calls", () => {
  const card = writerCard();
  assert.ok(card.model_prompt.executor.length > 0);
  assert.ok(card.executor_final_response_contract.required_fields.length > 0);
  // Static: the prompt/contract module must not depend on any transport.
  const src = readFileSync(new URL("../../src/v2/phase-response-contract.mjs", import.meta.url), "utf8");
  for (const forbiddenImport of ["pi-rpc-adapter", "pi-transport-adapter", "lifecycle-runner", "production-pipeline", "fetch(", "spawn("]) {
    assert.ok(!src.includes(forbiddenImport), `phase-response-contract must not import/use ${forbiddenImport}`);
  }
});

test("C4R-20 lifecycle remains the only PASS/HOLD authority", async () => {
  const card = writerCard();
  const script = [
    { expect: { phase: "executor", attempt: 0 }, result: { status: "completed", executionId: "x", stdout: evidenceJson(), stderr: "", metadata: {} } },
    { expect: { phase: "reviewer", attempt: 0 }, result: { status: "completed", executionId: "x", stdout: verdictJson(), stderr: "", metadata: {} } },
  ];
  const adapter = createScriptedAdapter(script);
  const out = await runLifecycle({ cwd: CWD, taskCard: card, adapter, maxRepairAttempts: 0, timeoutMs: 5000, executorEvidenceValidator: validateImplementationEvidence });
  assert.equal(out.final, "PASS");
  assert.equal(adapter.callRecord.length, 2);
});

// ── 21/22. Serialization + determinism ───────────────────────────────

test("C4R-21 serialized task card fully contains the operative prompt", () => {
  const card = writerCard();
  const serialized = JSON.stringify(card);
  assert.ok(serialized.includes("model_prompt"));
  assert.ok(serialized.includes("ROLE AND LIFECYCLE PHASE"));
  assert.ok(serialized.includes("FINAL RESPONSE CONTRACT"));
  assert.ok(card.prompt_usage.includes("model_prompt"));
});

test("C4R-22 prompt builder is deterministic (same input → same SHA)", () => {
  const a = writerCard();
  const b = writerCard();
  assert.equal(promptSha256(a.model_prompt.executor), promptSha256(b.model_prompt.executor));
  assert.equal(promptSha256(a.model_prompt.reviewer), promptSha256(b.model_prompt.reviewer));
});

// ── 23/24. Schema strictness ─────────────────────────────────────────

test("C4R-23 unknown schema field is rejected", () => {
  const ex = { ...buildExecutorCanonicalExample(), unexpected_extra_field: 1 };
  const v = validateImplementationEvidence(ex);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("unexpected_extra_field")) || v.errors.length > 0);
});

test("C4R-24 missing required field is rejected", () => {
  const ex = { ...buildExecutorCanonicalExample() };
  delete ex.executor_verdict;
  const v = validateImplementationEvidence(ex);
  assert.equal(v.valid, false);
});

// ── 25. No duplicate schema authority ────────────────────────────────

test("C4R-25 no duplicate schema authority (same constants, no drift)", () => {
  const proj = buildExecutorSchemaProjection();
  assert.equal(proj.item_shapes.commands, IE_ITEM_SHAPE_COMMANDS); // same object reference
  assert.equal(proj.required_fields.length, IE_REQUIRED_FIELDS.length);
  assert.deepEqual(proj.required_fields, [...IE_REQUIRED_FIELDS]);
  const ex = buildExecutorFinalResponseContract();
  assert.deepEqual(ex.required_fields, [...IE_REQUIRED_FIELDS]);
});

// ── §10 / §12.25 — actual child payload capture ──────────────────────

test("C4R-capture the operative prompt reaches the Pi child payload intact", async () => {
  const receivedPromptFile = join(tmpdir(), `c4r-capture-${process.pid}-${Date.now()}.json`);
  const card = writerCard();
  const executorText = evidenceJson();
  process.env.FAKE_PI_CONTROL = JSON.stringify({
    scenario: "normal",
    receivedPromptFile,
    assistantTextByPhase: { executor: executorText },
  });
  try {
    const adapter = createPiRpcAdapter({
      piExecutable: FIXTURE,
      environmentAllowlist: ALLOWLIST_WITH_CONTROL,
      graceMs: 150,
    });
    const result = await adapter.runAdapter({
      executionId: card.executionId,
      cwd: CWD,
      taskCard: card,
      phase: "executor",
      attempt: 0,
      timeoutMs: 5000,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.stdout, executorText);
    const recorded = JSON.parse(readFileSync(receivedPromptFile, "utf8"));
    const message = JSON.parse(recorded.raw);
    assert.equal(message.phase, "executor");
    assert.equal(message.taskCard.phaseId, "impl");
    assert.ok(message.taskCard.model_prompt.executor.includes("FINAL RESPONSE CONTRACT"));
    assert.ok(message.taskCard.model_prompt.executor.includes("CANONICAL SCHEMA PROJECTION"));
    assert.ok(message.taskCard.model_prompt.executor.includes("CANONICAL EXAMPLE"));
    assert.ok(message.taskCard.model_prompt.executor.includes("Do not include Markdown fences."));
    assert.ok(message.taskCard.model_prompt.executor.includes("Do not include prose before or after the JSON."));
    // Reviewer role prompt is also delivered intact in the same card.
    assert.ok(message.taskCard.model_prompt.reviewer.includes("FINAL RESPONSE CONTRACT (reviewer — mandatory)"));
  } finally {
    delete process.env.FAKE_PI_CONTROL;
    rmSync(receivedPromptFile, { force: true });
    rmSync(CWD, { recursive: true, force: true });
  }
});

test("C4R-build rejects an invalid lifecyclePhase", () => {
  const card = writerCard();
  assert.throws(() => buildPhaseExecutionPrompt({ phase: WRITER_PHASE, taskCard: card, lifecyclePhase: "designer", attempt: 0 }), /lifecyclePhase/);
});
