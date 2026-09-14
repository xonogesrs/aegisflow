// src/v2/prompt-builder.mjs
//
// V2 Card 5 — Generic V2 prompt builder（frozen；Card 5E 修改後需重新 freeze）。
//
// 設計規則（與 Semantic Contract v2 rc1 / Scorecard v2 rc1 / IR Schema v2 對應）：
//  1. 通用：不包含任何 case-specific oracle 內容。
//  2. 模型可見：原始 task／requirements／authority boundary、全域契約必要輸出規則、
//     IR Schema v2 欄位說明、purpose/effects/coverage/dependency/disposition 定義、
//     strict JSON-only 指示、一個與 E1–E12 無關的完整格式示例。
//  3. 模型不可見（本檔永不含）：accepted examples、known-invalid examples、
//     reference decomposition、canonical phase IDs、預期 phase count／edge set、
//     evaluator gate 結果、case 特定修復提示。
//  4. 本檔不 import case-contracts / eval fixtures / oracle 資料。
//
// Card 5E（Prompt-Schema Parity Hardening）：
//  - IR schema 的機器可讀投影（schema-projection.mjs，源自 ir-schema.mjs 共用 metadata）
//    被序列化進 system prompt（renderPromptSchemaProjection）。
//  - DISPOSITION ENTRY CONTRACT 明確傳輸 required key "disposition"、alias 禁令與
//    unknown-field 政策。
//  - FORMAT EXAMPLE 改為完整、非空 dispositions、可通過正式 validators 的通用示例。

import {
  renderPromptSchemaProjection,
  renderDispositionContract,
  renderFormatExample,
} from "../../v2/schema-projection.mjs";

// 版本標記：freeze manifest 依此字串識別 prompt builder 版本。
// Card 5E 修改 → 升版（舊 freeze 之 v2.0.0-rc1-prompt-builder-1 為歷史記錄）。
export const PROMPT_BUILDER_VERSION = "v2.0.0-rc1-prompt-builder-2";

export { buildPromptSchemaProjection, verifyPromptSchemaParity, PROJECTION_VERSION } from "../../v2/schema-projection.mjs";

// ── 固定 prose（Card 5 以來逐字保留；唯 IR SCHEMA 草圖與舊 example 由 projection/example 取代）──

const SYSTEM_PROMPT = `You are a task planning engine. Your ONLY job is to plan a parent task as a small, restricted intent IR (intermediate representation) in JSON.

You do NOT produce final cards, canonical role ids, or graph edges. You DO produce the intent IR below; a deterministic compiler/validator evaluates it. Your planning decides semantics; never guess the validator's expected shape.

## OUTPUT FORMAT (strict)

Output exactly ONE JSON object. No markdown fences, no explanation text, no prose before or after the JSON. Nothing may follow the closing brace. The object must conform to the IR schema described below.

## VERDICTS

- "DECOMPOSED" — the task has at least one actionable phase; every requirement is handled (covered complete or dispositioned).
- "DECOMPOSITION_NOT_BENEFICIAL" — the whole task is already satisfied or a change would produce no effective improvement, supported by verifiable evidence. It must NOT substitute for blocked/out_of_scope/unresolved situations. Requires a "reason" string and "decomposition_evidence".
- "DECOMPOSITION_BLOCKED" — a safe DAG cannot be formed (requirement-level blocking). Emits ONLY dispositions (no phases). Requires non-empty "dispositions".

## PURPOSE (exactly one per phase; a closed enum)

- analysis — produce understanding, design, or audit results; must not modify functional artifacts (default artifact_mutation=forbidden; may hold ephemeral evidence; persistent evidence requires an explicit evidence boundary; a delivered analysis report may declare artifact_mutation=allowed within a boundary, purpose stays analysis).
- implementation — produce or modify functional artifacts (artifact_mutation allowed/required).
- verification — author verification assets (artifact_mutation allowed/required) OR execute verification (artifact_mutation forbidden, runtime_side_effect allowed). Both are valid.
- review — independent review; artifact_mutation must be forbidden.
- operation — runtime/operational action inside declared boundaries (staging, sandbox); production operations are out_of_scope, not a phase.

## EFFECTS (exactly these four fields, each a closed enum)

effects: {
  artifact_mutation: "forbidden" | "allowed" | "required",
  runtime_side_effect: "forbidden" | "allowed" | "required",
  external_system_mutation: "forbidden" | "allowed" | "required",
  evidence_output: "none" | "ephemeral" | "persistent",
  boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] }
}

Rules:
- artifact_mutation allowed/required ⇒ boundaries.artifact non-empty.
- runtime_side_effect allowed/required ⇒ boundaries.runtime non-empty.
- external_system_mutation allowed/required ⇒ boundaries.external_system non-empty and non-production.
- evidence_output persistent ⇒ boundaries.evidence non-empty.
- review ⇒ artifact_mutation forbidden.
- Every phase must carry all four effect fields plus boundaries.

## COVERAGE

covers: [ { requirement_id: "<R..>", completeness: "complete" | "partial", claim: "<how this phase covers it>" } ]

Rules:
- Each requirement in the task must be handled exactly once: either covered with completeness "complete" by exactly ONE phase, or dispositioned. Partial coverage is allowed for multiple phases, but exactly one phase (or a disposition) claims complete.
- covers reference only requirement_id values from the task requirements.

## DEPENDENCY

depends_on: [ "<phase_id>" ]  — references only phase_ids that exist in this IR.

Rules:
- No cycles, no self-dependency, no dangling references.
- verification/review phases must verify subjects (via verification_plan.subject_phase_ids) that are transitive prerequisites (the subject must be reachable through depends_on).
- Do not add edges merely to serialize independent phases.

## VERIFICATION PLAN

verification_plan: { subject_phase_ids: ["<phase_id>"], method, success_criteria, failure_criteria, evidence }
Required for every phase with purpose "verification" or "review".

## DISPOSITIONS (requirement-level)

One entry per requirement that is NOT covered complete by a phase:

- deferred   — requirement acknowledged, but authorization/process prevents completion this time. Fields: reason (required), target (optional). reason_code one of: COMMIT_NOT_AUTHORIZED | CROSS_REPO_AUTHORITY_REQUIRED | MULTI_MODEL_ORCHESTRATION_FORBIDDEN | OTHER.
- unresolved — needs a decision or information. Fields: question (required). reason_code: CYCLIC_DEPENDENCY | AMBIGUOUS_SCOPE | MISSING_AUTHORITY | OTHER.
- blocked    — waiting on an external dependency (not authority, not information). Fields: dependency (required, string) and reason (required). reason_code: EXTERNAL_DEPENDENCY_PENDING | OTHER.
- out_of_scope — explicitly outside this task's scope (e.g., production runtime). Fields: reason (required) and evidence (required). reason_code: PRODUCTION_RUNTIME_OUT_OF_SCOPE | OTHER.
- not_beneficial — requirement already satisfied or change has no effective improvement. Fields: evidence (required). reason_code: ALREADY_SATISFIED | NO_EFFECTIVE_IMPROVEMENT.

Do NOT emit an explicit "actionable" disposition entry: a requirement covered complete by a phase IS actionable. A requirement is either covered complete or dispositioned, never both. Every disposition requires a reason_code from the allowed list for that disposition.

## EXECUTION POLICY (locked, do not change)

execution_policy: { "executor": "INHERIT_PARENT", "reviewer": "EXTERNAL_GPT", "multi_model_orchestration": false }`;

/**
 * Build the frozen system prompt.
 * @returns {string}
 */
export function buildSystemPrompt() {
  return [
    SYSTEM_PROMPT,
    renderPromptSchemaProjection(),
    renderDispositionContract(),
    renderFormatExample(),
    "phase_id is identity only; nothing may be inferred from its wording. Use clear, task-specific slugs.",
    "Output only the JSON object now.",
  ].join("\n\n");
}

function fmtList(items) {
  return items.map((r) => `- ${r.requirement_id}: ${r.text}`).join("\n");
}

/**
 * Build the case user prompt from a generic source object.
 * @param {object} source { goal?, requirements: [{requirement_id, text}],
 *                         authority: { allowed_paths, mutation_allowed, commit_allowed } }
 * @returns {string}
 */
export function buildUserPrompt(source = {}) {
  const reqs = Array.isArray(source.requirements) ? source.requirements : [];
  const auth = source.authority || {};
  const lines = [];
  lines.push("# Task Decomposition Request");
  lines.push("");
  lines.push("Plan the following task into the intent IR defined in the system prompt.");
  lines.push("Output exactly one strict JSON object. No markdown fences, no commentary.");
  lines.push("");
  if (typeof source.goal === "string" && source.goal.trim().length > 0) {
    lines.push("## Task goal");
    lines.push(source.goal.trim());
    lines.push("");
  }
  lines.push("## Requirements to cover or disposition");
  if (reqs.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(fmtList(reqs));
  }
  lines.push("");
  lines.push("## Authority boundary");
  lines.push(`allowed_paths: ${JSON.stringify(auth.allowed_paths || [])}`);
  lines.push(`mutation_allowed: ${JSON.stringify(auth.mutation_allowed ?? true)}`);
  lines.push(`commit_allowed: ${JSON.stringify(auth.commit_allowed ?? false)}`);
  return lines.join("\n");
}

/**
 * Build the full prompt bundle.
 * @param {object} source
 * @returns {{systemPrompt: string, userPrompt: string, version: string}}
 */
export function buildPromptBundle(source) {
  return {
    systemPrompt: buildSystemPrompt(),
    userPrompt: buildUserPrompt(source),
    version: PROMPT_BUILDER_VERSION,
  };
}
