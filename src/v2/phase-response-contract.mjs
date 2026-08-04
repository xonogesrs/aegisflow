// src/v2/phase-response-contract.mjs
//
// C4R — canonical phase output contract projection + phase execution prompt.
//
// Root cause addressed（AUTOLOOP_C4_EXECUTOR_EVIDENCE_INVALID）:
// the phase executor's final assistant text was natural language instead of
// canonical implementation-evidence JSON. This module makes the operative
// instruction and the final-response contract part of the TASK CARD itself
// (single canonical `model_prompt` field), projected MECHANICALLY from the
// same constants the runtime validators enforce — never a hand-maintained
// second field list.
//
// Contract authorities（single-authority rule）:
//   executor: src/validate-role-artifacts.mjs validateImplementationEvidence
//             + its IE_* constants（exported additively for projection）
//   reviewer: src/normalize-reviewer-json.mjs normalize() + VERDICTS /
//             CONFIDENCE / NEXT_ACTIONS（the runtime authority the lifecycle
//             actually uses）
//
// Strict parsing is untouched: the lifecycle still does
// JSON.parse(finalText) → canonical validator → PASS or fail-closed. No
// fence stripping, no substring extraction, no tolerant parsing, no
// second model call, no reformat request.

import {
  IE_REQUIRED_FIELDS,
  IE_ALLOWED_FIELDS,
  IE_ITEM_SHAPE_COMMANDS,
  IE_ITEM_SHAPE_COMPILE_RESULTS,
  IE_ITEM_SHAPE_TEST_RESULTS,
  IE_ITEM_SHAPE_NEGATIVE_EVIDENCE,
  IE_ITEM_SHAPE_MUTATION_EVIDENCE,
  IE_ITEM_SHAPE_SKIPPED_EVIDENCE,
  IE_ITEM_SHAPE_KNOWN_FAILURES,
  IE_ITEM_SHAPE_SCOPE_DEVIATIONS,
  IE_ENV_LIMITS_SHAPE,
  IE_TIMESTAMPS_SHAPE,
} from "../validate-role-artifacts.mjs";
import {
  VERDICTS,
  CONFIDENCE,
  NEXT_ACTIONS,
} from "../normalize-reviewer-json.mjs";
import { createHash } from "node:crypto";

export const PHASE_RESPONSE_CONTRACT_VERSION = "1.0.0";
export const EXECUTOR_SCHEMA_VERSION = "autoloop.implementation-evidence/v1";
export const REVIEWER_SCHEMA_NAME = "autoloop.reviewer-verdict";
export const PROMPT_MAX_BYTES = 48 * 1024;

// §6 fixed semantics — the FINAL RESPONSE CONTRACT core text（kept verbatim;
// a role header line is prepended when rendered into a role prompt）.
export const FINAL_RESPONSE_CONTRACT_CORE = `After completing the assigned work, your final assistant response must contain exactly one JSON object conforming to the supplied canonical schema.

Do not include Markdown fences.
Do not include prose before or after the JSON.
Do not summarize outside the JSON.
Do not return tool output as the final response.
Do not omit required fields.
Use empty arrays where the schema permits an empty list.`;

// C4L — executor-only hardening of the final-response contract.
// Adds explicit JSON-boundary rules（first non-whitespace char must be '{',
// nothing after the closing '}', completion statements forbidden, failure
// JSON path）that mirror the already-proven decomposition prompt wording.
// The reviewer contract is intentionally unchanged; FINAL_RESPONSE_CONTRACT_CORE
// stays the final block so C4R-5/C4R-19 invariants hold.
export const EXECUTOR_FINAL_RESPONSE_CONTRACT_HARDENING =
  `1. The first non-whitespace character of your final response MUST be '{'.
` +
  `2. Your final response MUST contain exactly one JSON object and nothing else.
` +
  `3. Do not write a summary, explanation, acknowledgement, Markdown fence, heading, or any prose before the JSON.
` +
  `4. Nothing may follow the closing '}' of the JSON object.
` +
  `5. Tool work may use normal intermediate messages, but the final assistant message must be JSON only.
` +
  `6. Completion statements such as "All work is complete" are forbidden in the final response.
` +
  `7. The JSON must conform exactly to the implementation-evidence schema supplied above.
` +
  `8. If you cannot produce valid evidence, return the contract-defined failure JSON (a schema-valid implementation-evidence object with the failure recorded in its known_failures, negative_evidence, or scope_deviations fields) instead of prose.\n`;

export const EXECUTOR_FINAL_RESPONSE_CONTRACT =
  `FINAL RESPONSE CONTRACT (executor — mandatory)\n\n` +
  `Your final assistant response must be exactly one canonical implementation-evidence JSON object.\n\n` +
  EXECUTOR_FINAL_RESPONSE_CONTRACT_HARDENING +
  `\n` +
  FINAL_RESPONSE_CONTRACT_CORE;

export const REVIEWER_FINAL_RESPONSE_CONTRACT =
  `FINAL RESPONSE CONTRACT (reviewer — mandatory)\n\n` +
  `Your final assistant response must be exactly one canonical reviewer-verdict JSON object.\n\n` +
  FINAL_RESPONSE_CONTRACT_CORE;

// ── Canonical schema projections（mechanically derived）──────────────

export function buildExecutorSchemaProjection() {
  return {
    contract_name: "autoloop.executor-implementation-evidence",
    contract_version: PHASE_RESPONSE_CONTRACT_VERSION,
    output_format: "application/json",
    schema_version: EXECUTOR_SCHEMA_VERSION,
    required_fields: [...IE_REQUIRED_FIELDS],
    allowed_fields: [...IE_ALLOWED_FIELDS],
    unknown_field_policy: "reject",
    item_shapes: {
      commands: IE_ITEM_SHAPE_COMMANDS,
      compile_results: IE_ITEM_SHAPE_COMPILE_RESULTS,
      test_results: IE_ITEM_SHAPE_TEST_RESULTS,
      negative_evidence: IE_ITEM_SHAPE_NEGATIVE_EVIDENCE,
      mutation_evidence: IE_ITEM_SHAPE_MUTATION_EVIDENCE,
      skipped_evidence: IE_ITEM_SHAPE_SKIPPED_EVIDENCE,
      known_failures: IE_ITEM_SHAPE_KNOWN_FAILURES,
      scope_deviations: IE_ITEM_SHAPE_SCOPE_DEVIATIONS,
    },
    environment_limits_shape: IE_ENV_LIMITS_SHAPE,
    timestamps_shape: IE_TIMESTAMPS_SHAPE,
  };
}

export function buildReviewerSchemaProjection() {
  return {
    contract_name: REVIEWER_SCHEMA_NAME,
    contract_version: PHASE_RESPONSE_CONTRACT_VERSION,
    output_format: "application/json",
    required_fields: ["verdict", "confidence", "model", "summary", "recommended_next_action"],
    enums: {
      verdict: [...VERDICTS].sort(),
      confidence: [...CONFIDENCE].sort(),
      recommended_next_action: [...NEXT_ACTIONS].sort(),
    },
    optional_string_arrays: ["blocking_issues", "required_supplements", "scope_violations", "evidence_gaps"],
    pass_guard: "PASS requires confidence HIGH and zero blocking_issues and zero evidence_gaps (enforced by the reviewer normalizer)",
    unknown_field_policy: "do not add fields outside the canonical set",
  };
}

// ── Text rendering for the prompt（from the structured projection）────

function renderItemShape(shape) {
  const parts = [];
  if (Array.isArray(shape?.required) && shape.required.length > 0) parts.push(`required: ${shape.required.join(", ")}`);
  for (const [name, prop] of Object.entries(shape?.properties || {})) {
    if (prop?.enum) parts.push(`${name}: ${prop.enum.join("|")}`);
    else if (prop?.type === "integer") parts.push(`${name}: integer`);
    else if (prop?.type === "boolean") parts.push(`${name}: boolean`);
    else parts.push(`${name}: string`);
  }
  return parts.join("; ");
}

export function renderExecutorProjectionText(projection = buildExecutorSchemaProjection()) {
  const lines = [];
  lines.push(`schema_version: "${projection.schema_version}"`);
  lines.push(`required_fields (${projection.required_fields.length}): ${projection.required_fields.join(", ")}`);
  lines.push(`unknown_field_policy: ${projection.unknown_field_policy} — do not add any field not listed above`);
  lines.push("executor_invocation: { schema_version: \"autoloop.model-invocation/v1\", invocation_id, attempt_id, role: \"executor\", provider, configured_model, requested_model, effective_model, provider_request_id, started_at, completed_at, result_status: SUCCEEDED|FAILED|TIMED_OUT|CANCELLED|IDENTITY_MISMATCH|INVALID_OUTPUT }");
  lines.push("repository_baseline: { repository, branch, head: 40-hex, origin_ref, origin_head: 40-hex, ahead: integer, behind: integer, expected_worktree_state: clean|dirty, permitted_dirty_paths: [], captured_at: ISO-8601 UTC Z }");
  lines.push(`commands / compile_results item: ${renderItemShape(projection.item_shapes.commands)}`);
  lines.push(`test_results item: ${renderItemShape(projection.item_shapes.test_results)}`);
  lines.push(`mutation_evidence item: ${renderItemShape(projection.item_shapes.mutation_evidence)}`);
  lines.push(`negative_evidence item: ${renderItemShape(projection.item_shapes.negative_evidence)}`);
  lines.push(`skipped_evidence item: ${renderItemShape(projection.item_shapes.skipped_evidence)}`);
  lines.push(`known_failures item: ${renderItemShape(projection.item_shapes.known_failures)}`);
  lines.push(`scope_deviations item: ${renderItemShape(projection.item_shapes.scope_deviations)}`);
  lines.push("environment_limits: { max_path_length: integer, max_command_results: integer, max_test_results: integer, notes: string }");
  lines.push("timestamps: { started_at, completed_at } — ISO-8601 UTC ending in Z");
  lines.push("sha256 fields (design_contract_hash, patch_sha256, initial_integrity, final_integrity): exactly 64 lowercase hex characters; use 64 zeros when nothing changed");
  return lines.join("\n");
}

export function renderReviewerProjectionText(projection = buildReviewerSchemaProjection()) {
  const lines = [];
  lines.push(`required_fields: ${projection.required_fields.join(", ")}`);
  lines.push(`verdict: ${projection.enums.verdict.join("|")}`);
  lines.push(`confidence: ${projection.enums.confidence.join("|")}`);
  lines.push(`recommended_next_action: ${projection.enums.recommended_next_action.join("|")}`);
  lines.push(`optional_string_arrays: ${projection.optional_string_arrays.join(", ")}`);
  lines.push(`model: the reviewer model identifier — must equal taskCard.expectedReviewerModel`);
  lines.push(`pass_guard: ${projection.pass_guard}`);
  lines.push(`unknown_field_policy: ${projection.unknown_field_policy}`);
  return lines.join("\n");
}

// ── Canonical generic examples（schema-valid, no campaign content）────

const SHA256_ZERO = "0000000000000000000000000000000000000000000000000000000000000000";
const GIT_HASH_EXAMPLE = "0123456789abcdef0123456789abcdef01234567";

export function buildExecutorCanonicalExample() {
  return {
    schema_version: EXECUTOR_SCHEMA_VERSION,
    contract_id: "example-contract",
    design_revision_id: "example-revision",
    design_contract_hash: SHA256_ZERO,
    implementation_attempt_id: "example-attempt",
    parent_attempt_id: "example-parent",
    executor_invocation: {
      schema_version: "autoloop.model-invocation/v1",
      invocation_id: "example-invocation",
      attempt_id: "example-attempt",
      role: "executor",
      provider: "example-provider",
      configured_model: "example-model",
      requested_model: "example-model",
      effective_model: "NOT_REPORTED_BY_PROVIDER",
      provider_request_id: "example-request",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:00:01Z",
      result_status: "SUCCEEDED",
    },
    repository_baseline: {
      repository: "example-repository",
      branch: "main",
      head: GIT_HASH_EXAMPLE,
      origin_ref: "refs/remotes/origin/main",
      origin_head: GIT_HASH_EXAMPLE,
      ahead: 0,
      behind: 0,
      expected_worktree_state: "clean",
      permitted_dirty_paths: [],
      captured_at: "2026-01-01T00:00:00Z",
    },
    initial_integrity: SHA256_ZERO,
    final_integrity: SHA256_ZERO,
    authorized_paths: ["example/target.txt"],
    actual_changed_paths: [],
    patch_sha256: SHA256_ZERO,
    commands: [{ command: "example verification command", status: "ok", exit_code: 0 }],
    compile_results: [],
    test_results: [],
    negative_evidence: [],
    mutation_evidence: [],
    skipped_evidence: [],
    known_failures: [],
    environment_limits: { max_path_length: 0, max_command_results: 0, max_test_results: 0, notes: "example environment" },
    scope_deviations: [],
    executor_verdict: "PASS",
    timestamps: { started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:00:01Z" },
    integrity: "example integrity",
  };
}

export function buildReviewerCanonicalExample({ expectedReviewerModel } = {}) {
  // The model field is required by the reviewer-verdict contract but must
  // not embed any provider/model identity (no provider info in examples).
  // Empty string is schema-valid; the runtime normalizer fills it from the
  // caller's expectedReviewerModel, and the projection instructs the model
  // to use taskCard.expectedReviewerModel exactly.
  void expectedReviewerModel;
  return {
    verdict: "PASS",
    confidence: "HIGH",
    model: "",
    summary: "Phase goal met; verification evidence is consistent and complete.",
    blocking_issues: [],
    required_supplements: [],
    scope_violations: [],
    evidence_gaps: [],
    recommended_next_action: "STOP",
  };
}

// ── Structured final-response contracts（embedded in the task card）──

export function buildExecutorFinalResponseContract() {
  return {
    contract_name: "autoloop.executor-final-response",
    contract_version: PHASE_RESPONSE_CONTRACT_VERSION,
    output_format: "application/json",
    schema_projection: buildExecutorSchemaProjection(),
    required_fields: [...IE_REQUIRED_FIELDS],
    unknown_field_policy: "reject",
    canonical_example: buildExecutorCanonicalExample(),
    failure_behavior: "fail-closed: prose, Markdown fences, surrounding text, missing required fields, extra unknown fields, or non-JSON output → HOLD / EXECUTOR_EVIDENCE_INVALID with no retry, no repair, no reformat request",
  };
}

export function buildReviewerFinalResponseContract({ expectedReviewerModel } = {}) {
  return {
    contract_name: "autoloop.reviewer-final-response",
    contract_version: PHASE_RESPONSE_CONTRACT_VERSION,
    output_format: "application/json",
    schema_projection: buildReviewerSchemaProjection(),
    required_fields: ["verdict", "confidence", "model", "summary", "recommended_next_action"],
    unknown_field_policy: "do not add fields outside the canonical set",
    canonical_example: buildReviewerCanonicalExample({ expectedReviewerModel }),
    failure_behavior: "fail-closed: malformed or non-JSON output → HOLD / MALFORMED_REVIEWER_VERDICT; PASS requires confidence HIGH with zero blocking_issues and zero evidence_gaps",
  };
}

// ── Phase execution prompt（§9 fixed order, deterministic）───────────

function sectionPhaseFacts(taskCard) {
  const lines = [
    "ASSIGNED PHASE FACTS",
    `phase_id: ${taskCard.phaseId ?? "unknown"}`,
    `executionId: ${taskCard.executionId ?? "unknown"}`,
    `title: ${taskCard.title ?? ""}`,
    `summary: ${taskCard.summary ?? ""}`,
    `responsibility: ${taskCard.responsibility ?? ""}`,
    `purpose: ${typeof taskCard.purpose === "string" ? taskCard.purpose : JSON.stringify(taskCard.purpose ?? null)}`,
    `covers (requirement ids): ${Array.isArray(taskCard.covers) ? taskCard.covers.map((c) => c?.requirement_id ?? c).join(", ") : ""}`,
    `depends_on: ${Array.isArray(taskCard.dependsOn) ? taskCard.dependsOn.join(", ") : ""}`,
  ];
  return lines.join("\n");
}

function sectionAuthority(taskCard, lifecyclePhase) {
  if (lifecyclePhase === "reviewer") {
    return [
      "AUTHORITY AND FORBIDDEN ACTIONS (reviewer)",
      "You have NO tools and NO mutation authority. You are strictly read-only.",
      "You must not modify any file, run mutating commands, or access anything outside the repository root.",
    ].join("\n");
  }
  const allowed = Array.isArray(taskCard.allowedPaths) && taskCard.allowedPaths.length > 0
    ? taskCard.allowedPaths.join(", ")
    : "(none — this is a read-only phase; do not modify ANY file)";
  const forbidden = Array.isArray(taskCard.forbiddenPaths) ? taskCard.forbiddenPaths.join(", ") : "";
  return [
    "AUTHORITY AND FORBIDDEN ACTIONS (executor)",
    `repository_root: ${taskCard.repositoryRoot ?? ""}`,
    `allowed_mutation_paths: ${allowed}`,
    `forbidden_mutation_paths: ${forbidden}`,
    "Modify ONLY files under allowed_mutation_paths inside repository_root. Any change to any other path is a scope violation.",
    "Do not commit. Do not push. Do not create git remotes. Do not install packages. Do not access files outside repository_root.",
  ].join("\n");
}

function sectionVerification(taskCard) {
  const vp = taskCard.verificationPlan && typeof taskCard.verificationPlan === "object" ? taskCard.verificationPlan : null;
  const method = vp?.method ?? "see verificationPlan";
  const success = vp?.success_criteria ?? "";
  const failure = vp?.failure_criteria ?? "";
  return [
    "VERIFICATION OBLIGATIONS",
    `verification method: ${method}`,
    `success criteria: ${success}`,
    `failure criteria: ${failure}`,
    "Run the verification command from repository_root and record its real output.",
  ].join("\n");
}

function sectionEvidence(lifecyclePhase) {
  if (lifecyclePhase === "reviewer") {
    return [
      "EVIDENCE COLLECTION OBLIGATIONS (reviewer)",
      "Assess whether the phase's executor evidence supports PASS for this phase.",
      "Base your verdict on the task card facts, the verification plan, and the evidence you are asked to review.",
      "The system-assembled evidence bundle is delivered in the top-level message field named reviewEvidence.",
      "Review ONLY the task card facts and that bundle; you have no tools and cannot inspect the repository yourself.",
      "Compare the executor's claimed changed paths, repository baseline, and test outcomes against the bundle's system-observed objective facts and durable references.",
      "Any inconsistency between the executor's claims and the bundle's objective facts must yield a HOLD or REJECT verdict; never PASS.",
      "Do not fabricate, extrapolate, or invent evidence that is not present in the bundle.",
    ].join("\n");
  }
  return [
    "EVIDENCE COLLECTION OBLIGATIONS (executor)",
    "Collect and report real evidence: every command you ran, test outcomes, and the exact set of repository paths you changed.",
    "Use empty arrays where the schema permits an empty list; never invent commands, tests, or changed paths.",
  ].join("\n");
}

export function buildPhaseExecutionPrompt({ phase, taskCard, lifecyclePhase, attempt }) {
  if (lifecyclePhase !== "executor" && lifecyclePhase !== "reviewer") {
    throw new TypeError(`lifecyclePhase must be "executor" or "reviewer", got ${String(lifecyclePhase)}`);
  }
  if (!phase || typeof phase !== "object" || Array.isArray(phase)) throw new TypeError("phase object required");
  if (!taskCard || typeof taskCard !== "object" || Array.isArray(taskCard)) throw new TypeError("taskCard object required");
  const attemptNumber = Number.isInteger(attempt) ? attempt : 0;

  const projection = lifecyclePhase === "executor" ? buildExecutorSchemaProjection() : buildReviewerSchemaProjection();
  const example = lifecyclePhase === "executor"
    ? buildExecutorCanonicalExample()
    : buildReviewerCanonicalExample({ expectedReviewerModel: taskCard.expectedReviewerModel || undefined });  const contract = lifecyclePhase === "executor" ? EXECUTOR_FINAL_RESPONSE_CONTRACT : REVIEWER_FINAL_RESPONSE_CONTRACT;

  const roleSection = [
    "ROLE AND LIFECYCLE PHASE",
    `You are the phase ${lifecyclePhase.toUpperCase()} for phase "${phase.phase_id ?? taskCard.phaseId ?? "unknown"}" of this AutoLoop run.`,
    `Your role is determined by the top-level "phase" field of this message ("executor" or "reviewer").`,
    `The "model_prompt" object inside the task card is the operative instruction: read ONLY the section matching your role (model_prompt.${lifecyclePhase}).`,
    "The FINAL RESPONSE CONTRACT at the end of this prompt is mandatory and overrides any other formatting habit.",
    `Attempt: ${attemptNumber}`,
  ].join("\n");

  const schemaSection = lifecyclePhase === "executor"
    ? ["CANONICAL SCHEMA PROJECTION (executor implementation-evidence)", renderExecutorProjectionText(projection)].join("\n")
    : ["CANONICAL SCHEMA PROJECTION (reviewer verdict)", renderReviewerProjectionText(projection)].join("\n");

  const exampleSection = lifecyclePhase === "executor"
    ? ["CANONICAL EXAMPLE (generic, schema-valid)", JSON.stringify(example, null, 2)].join("\n")
    : ["CANONICAL EXAMPLE (generic, schema-valid)", JSON.stringify(example, null, 2),
       "(In the example above, the \"model\" field is empty on purpose: you must output the exact value of taskCard.expectedReviewerModel.)"].join("\n");

  const prompt = [
    roleSection,
    sectionPhaseFacts(taskCard),
    sectionAuthority(taskCard, lifecyclePhase),
    sectionVerification(taskCard),
    sectionEvidence(lifecyclePhase),
    schemaSection,
    exampleSection,
    contract,
  ].join("\n\n");

  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > PROMPT_MAX_BYTES) {
    throw new Error(`phase prompt exceeds PROMPT_MAX_BYTES (${bytes} > ${PROMPT_MAX_BYTES})`);
  }
  return prompt;
}

// ── Determinism helper for tests ─────────────────────────────────────

export function promptSha256(prompt) {
  return createHash("sha256").update(String(prompt), "utf8").digest("hex");
}
