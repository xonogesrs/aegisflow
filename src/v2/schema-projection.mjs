// src/v2/schema-projection.mjs
//
// V2 Card 5E — machine-readable prompt schema projection。
//
// 單一事實來源：本模組從 ir-schema.mjs 的 shared metadata（required/allowed/enums/
// conditional rules）構建 projection descriptor；prompt-builder 將其序列化進 provider
// prompt；parity gate 把 prompt 內嵌的 projection parse 回來與 descriptor 結構比對。
//
// 設計規則（Card 5E Stage 2）：
//  - projection 由正式 IR schema metadata 產生，不得由 prompt 文字反向推測。
//  - validator 與 prompt projection 共用同一份 required-key 清單（ir-schema.mjs exports）。
//  - projection 內容可由 deterministic test 重新 parse 並結構比較。
//  - 本模組不改任何 validation 接受/拒絕語意。

import {
  TOP_KEYS, PHASE_KEYS, EFFECT_KEYS, COVER_KEYS, DISPOSITION_KEYS, PLAN_KEYS, POLICY_KEYS,
  PHASE_REQUIRED, PLAN_REQUIRED, DISPOSITION_REQUIRED,
  REQUIRED_EFFECTS, REQUIRED_BOUNDARIES,
  PURPOSES, EFFECT_VALUES, EVIDENCE_OUTPUT_VALUES, COMPLETENESS_VALUES,
  DISPOSITION_VALUES, REASON_CODES, DISPOSITION_FIELDS, VERDICT_VALUES,
} from "./ir-schema.mjs";

export const PROJECTION_VERSION = "v2.0.0-rc1-projection-1";

// 標記行（parity gate 用來從 prompt 抽取 projection JSON）
export const PROJECTION_BEGIN = "=== IR SCHEMA PROJECTION BEGIN ===";
export const PROJECTION_END = "=== IR SCHEMA PROJECTION END ===";

/**
 * 由正式 IR schema metadata 構建 prompt schema projection descriptor。
 * 純 JSON-serializable（無 Set/function）。
 */
export function buildPromptSchemaProjection() {
  return {
    version: PROJECTION_VERSION,
    objects: {
      root: {
        path: "$",
        required: ["verdict", "decomposition_evidence"],
        conditional: {
          DECOMPOSED: ["parent_goal", "execution_policy", "phases", "dispositions"],
          DECOMPOSITION_NOT_BENEFICIAL: ["reason"],
          DECOMPOSITION_BLOCKED: ["dispositions"],
        },
        allowed: [...TOP_KEYS],
        additionalProperties: false,
        enums: { verdict: [...VERDICT_VALUES] },
      },
      "phases[]": {
        path: "phases[]",
        required: [...PHASE_REQUIRED],
        allowed: [...PHASE_KEYS],
        additionalProperties: false,
        enums: { purpose: [...PURPOSES] },
        conditional: { verification_plan: "required when purpose is verification or review" },
      },
      "phases[].effects": {
        path: "phases[].effects",
        required: [...REQUIRED_EFFECTS, "boundaries"],
        allowed: [...EFFECT_KEYS],
        additionalProperties: false,
        enums: {
          artifact_mutation: [...EFFECT_VALUES],
          runtime_side_effect: [...EFFECT_VALUES],
          external_system_mutation: [...EFFECT_VALUES],
          evidence_output: [...EVIDENCE_OUTPUT_VALUES],
        },
      },
      "phases[].effects.boundaries": {
        path: "phases[].effects.boundaries",
        required: [...REQUIRED_BOUNDARIES],
        additionalProperties: true, // 反映 validator：boundaries 額外 key 未檢查
      },
      "phases[].covers[]": {
        path: "phases[].covers[]",
        required: ["requirement_id", "completeness", "claim"],
        allowed: [...COVER_KEYS],
        additionalProperties: false,
        enums: { completeness: [...COMPLETENESS_VALUES] },
      },
      "phases[].depends_on": {
        path: "phases[].depends_on",
        items: "string phase_id references; no cycles, no self-dependency, no dangling references",
        additionalProperties: false,
      },
      "phases[].verification_plan": {
        path: "phases[].verification_plan",
        required: [...PLAN_REQUIRED],
        allowed: [...PLAN_KEYS],
        additionalProperties: false,
        conditional: "required when purpose is verification or review",
      },
      "dispositions[]": {
        path: "dispositions[]",
        required: [...DISPOSITION_REQUIRED],
        allowed: [...DISPOSITION_KEYS],
        additionalProperties: false,
        enums: { disposition: [...DISPOSITION_VALUES] },
        conditional: {
          deferred: { required: [...DISPOSITION_FIELDS.deferred.required], reason_codes: [...REASON_CODES.deferred] },
          unresolved: { required: [...DISPOSITION_FIELDS.unresolved.required], reason_codes: [...REASON_CODES.unresolved] },
          blocked: { required: [...DISPOSITION_FIELDS.blocked.required], reason_codes: [...REASON_CODES.blocked] },
          out_of_scope: { required: [...DISPOSITION_FIELDS.out_of_scope.required], reason_codes: [...REASON_CODES.out_of_scope] },
          not_beneficial: { required: [...DISPOSITION_FIELDS.not_beneficial.required], reason_codes: [...REASON_CODES.not_beneficial] },
        },
      },
      execution_policy: {
        path: "execution_policy",
        required: ["executor", "reviewer", "multi_model_orchestration"],
        allowed: [...POLICY_KEYS],
        additionalProperties: true, // 反映 validator：execution_policy 額外 key 未檢查（H12 只查三值）
        locked: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
      },
    },
  };
}

/**
 * 將 projection 序列化為嵌入 prompt 的文字區段。
 */
export function renderPromptSchemaProjection() {
  const json = JSON.stringify(buildPromptSchemaProjection(), null, 1);
  return [
    "## IR SCHEMA PROJECTION (machine-readable, authoritative)",
    "",
    "The JSON below is the authoritative projection of the IR schema. Every object you emit",
    "must conform to it: required keys must be present, unknown keys are rejected where",
    "additionalProperties is false, and enum values must be from the listed sets.",
    "",
    PROJECTION_BEGIN,
    json,
    PROJECTION_END,
    "",
    `Disposition entries use the required key "disposition" (see DISPOSITION ENTRY CONTRACT below).`,
  ].join("\n");
}

/**
 * 渲染 disposition entry contract 區段（required key、alias 禁令、unknown-field 政策）。
 */
export function renderDispositionContract() {
  const disp = buildPromptSchemaProjection().objects["dispositions[]"];
  const entryKeys = [...disp.required, ...disp.allowed.filter((k) => !disp.required.includes(k))];
  return [
    "## DISPOSITION ENTRY CONTRACT",
    "",
    "Each dispositions[] entry is a single object. The required keys are:",
    `  ${disp.required.map((k) => `"${k}"`).join(", ")}`,
    `Allowed keys: ${disp.allowed.map((k) => `"${k}"`).join(", ")}. Unknown keys are rejected.`,
    `The canonical discriminant key is "disposition", with one of: ${disp.enums.disposition.map((v) => `"${v}"`).join(" | ")}.`,
    `"type", "kind", and "status" are NOT aliases for "disposition" and are rejected as unknown keys.`,
    "",
    "Per-disposition conditional fields (authoritative):",
    ...Object.entries(disp.conditional).map(([kind, rule]) =>
      `  - ${kind}: required ${rule.required.map((k) => `"${k}"`).join(", ") || "(none)"}; reason_code: ${rule.reason_codes.join(" | ")}`,
    ),
    "",
    `Example entry shape (only the keys permitted for the chosen disposition are used): { ${entryKeys.map((k) => `"${k}": <${k}>`).join(", ")} }`,
    "A requirement is either covered complete by exactly one phase, or dispositioned — never both.",
  ].join("\n");
}

// ── parity 檢查（結構比較，非 grep）──

function canonicalKeyList(arr) {
  return [...arr].sort();
}

/**
 * 深比對 prompt 內嵌 projection 與正式 descriptor。
 * @param {unknown} parsed — 從 prompt 抽取並 parse 的 projection
 * @returns {{pass: boolean, problems: string[]}}
 */
export function verifyPromptSchemaParity(parsed) {
  const problems = [];
  if (!parsed || typeof parsed !== "object") {
    return { pass: false, problems: ["projection is not a JSON object"] };
  }
  const expected = buildPromptSchemaProjection();

  if (parsed.version !== expected.version) {
    problems.push(`version mismatch: prompt has ${parsed.version}, schema contract has ${expected.version}`);
  }
  const objPaths = Object.keys(expected.objects);
  for (const path of objPaths) {
    if (!parsed.objects || !parsed.objects[path]) {
      problems.push(`missing object path in prompt projection: ${path}`);
      continue;
    }
    const p = parsed.objects[path];
    const e = expected.objects[path];
    const a = (x) => JSON.stringify(x ?? null);
    if (JSON.stringify(canonicalKeyList(p.required || [])) !== JSON.stringify(canonicalKeyList(e.required || []))) {
      problems.push(`${path}: required mismatch — prompt ${a(p.required)} vs schema ${a(e.required)}`);
    }
    if (p.additionalProperties !== e.additionalProperties) {
      problems.push(`${path}: additionalProperties mismatch — prompt ${p.additionalProperties} vs schema ${e.additionalProperties}`);
    }
    if (e.allowed && JSON.stringify(canonicalKeyList(p.allowed || [])) !== JSON.stringify(canonicalKeyList(e.allowed))) {
      problems.push(`${path}: allowed mismatch — prompt ${a(p.allowed)} vs schema ${a(e.allowed)}`);
    }
    if (e.enums) {
      for (const [ename, evals] of Object.entries(e.enums)) {
        const pvals = p.enums?.[ename] || [];
        if (JSON.stringify(canonicalKeyList(pvals)) !== JSON.stringify(canonicalKeyList(evals))) {
          problems.push(`${path}.enums.${ename}: mismatch — prompt ${a(pvals)} vs schema ${a(evals)}`);
        }
      }
    }
    if (e.conditional && JSON.stringify(p.conditional ?? null) !== JSON.stringify(e.conditional)) {
      problems.push(`${path}: conditional rules mismatch`);
    }
    if (e.locked && JSON.stringify(p.locked ?? null) !== JSON.stringify(e.locked)) {
      problems.push(`${path}: locked values mismatch`);
    }
  }

  // alias / unknown-field 政策：dispositions[] allowed 不得含 type/kind/status
  const disp = parsed.objects?.["dispositions[]"];
  if (disp) {
    const allowed = disp.allowed || [];
    for (const alias of ["type", "kind", "status"]) {
      if (allowed.includes(alias)) problems.push(`dispositions[]: alias "${alias}" present in allowed keys`);
    }
    if (!allowed.includes("disposition")) problems.push("dispositions[]: required key \"disposition\" missing from allowed keys");
  }

  return { pass: problems.length === 0, problems };
}

// ── canonical full-format example（Card 5E Stage 4：case-agnostic、schema-valid、semantic-valid）──

export const FORMAT_EXAMPLE = Object.freeze({
  task: "Write a contribution guide for the project repository",
  requirements: [
    { requirement_id: "R1", text: "outline the contribution workflow" },
    { requirement_id: "R2", text: "write the contribution guide under docs/" },
    { requirement_id: "R3", text: "obtain maintainer sign-off for the guide" },
  ],
  authority: { allowed_paths: ["docs/"], mutation_allowed: true, commit_allowed: false },
  ir: {
    verdict: "DECOMPOSED",
    parent_goal: "Write a contribution guide for the project repository",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [
      {
        phase_id: "outline_contribution_workflow",
        title: "Outline contribution workflow",
        summary: "Map the contribution steps from fork to review",
        responsibility: "Describe the ordered contribution workflow",
        purpose: "analysis",
        effects: {
          artifact_mutation: "forbidden",
          runtime_side_effect: "forbidden",
          external_system_mutation: "forbidden",
          evidence_output: "ephemeral",
          boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
        },
        covers: [{ requirement_id: "R1", completeness: "complete", claim: "Outlines the contribution workflow" }],
        depends_on: [],
      },
      {
        phase_id: "write_contribution_guide",
        title: "Write contribution guide",
        summary: "Write the guide into the docs directory",
        responsibility: "Author the contribution guide under docs/",
        purpose: "implementation",
        effects: {
          artifact_mutation: "required",
          runtime_side_effect: "forbidden",
          external_system_mutation: "forbidden",
          evidence_output: "none",
          boundaries: { artifact: ["docs/"], runtime: [], external_system: [], evidence: [] },
        },
        covers: [{ requirement_id: "R2", completeness: "complete", claim: "Writes the contribution guide" }],
        depends_on: ["outline_contribution_workflow"],
      },
    ],
    dispositions: [
      {
        requirement_id: "R3",
        disposition: "deferred",
        reason_code: "OTHER",
        reason: "maintainer sign-off requires an approval step outside this task's authorization",
        target: "after maintainer review",
      },
    ],
    decomposition_evidence: ["Two phases: outline the workflow, then write the guide; sign-off deferred pending approval"],
  },
});

export function renderFormatExample() {
  const ex = FORMAT_EXAMPLE;
  const irJson = JSON.stringify(ex.ir);
  return [
    "## FORMAT EXAMPLE (complete, valid, unrelated to your task)",
    "",
    `Task: "${ex.task}" with requirements ${ex.requirements.map((r) => `${r.requirement_id} (${r.text})`).join(", ")}, authority allowing edits under ${JSON.stringify(ex.authority.allowed_paths)}.`,
    "",
    irJson,
    "",
    "Note: the example above uses one non-empty dispositions[] entry to show the canonical key \"disposition\". Your task's dispositions must use the same key.",
  ].join("\n");
}

/**
 * Example 驗證所需之 neutral parent scope 與 manifest。
 */
export const EXAMPLE_PARENT = Object.freeze({
  scope: { allowed_paths: ["docs/"], forbidden_paths: [] },
});
export const EXAMPLE_MANIFEST = FORMAT_EXAMPLE.requirements;
