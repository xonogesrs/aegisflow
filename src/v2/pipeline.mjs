// src/v2/pipeline.mjs
//
// V2 Card 5 — Test-only V2 decomposition pipeline orchestration.
//
// 固定順序（deterministic，Card 5 §一 pipeline）：
//   source task
//   → generic V2 prompt builder（prompt-builder.mjs）
//   → Pi transport adapter（pi-transport-adapter.mjs；strict JSON parser 內建）
//   → IR Schema v2（ir-schema.mjs）
//   → structural validator（structural-validator.mjs）
//   → semantic consistency（semantic-consistency.mjs）
//   → case-contract evaluator（case-evaluator.mjs）
//   → Scorecard v2（scorecard-v2.mjs）
//   → runner schedule（runner.mjs）
//   → PASS / HOLD / NOT_BENEFICIAL
//
// 規則：
//  - HOLD 後不得進 runner；
//  - NOT_BENEFICIAL 不產生 actionable phases（runner 不執行）；
//  - transport request count 保持一（adapter 強制；provider error 不觸發第二 request）。

import { buildPromptBundle } from "./prompt-builder.mjs";
import { validateIRShape } from "./ir-schema.mjs";
import { validateStructural } from "./structural-validator.mjs";
import { validateSemantic } from "./semantic-consistency.mjs";
import { evaluateCase } from "./case-evaluator.mjs";
import { evaluateScorecardV2 } from "./scorecard-v2.mjs";
import { runDecompositionGraph } from "./runner.mjs";

export const PIPELINE_STAGES = Object.freeze([
  "transport", "schema", "structural", "semantic", "case", "scorecard", "runner",
]);

/**
 * 執行 v2 decomposition pipeline（test-only orchestration）。
 *
 * @param {object} opts
 * @param {object} opts.source — { goal?, requirements, authority }
 * @param {object} opts.parent — { scope: { allowed_paths, forbidden_paths } }
 * @param {object[]} opts.manifest — [{ requirement_id, text }]
 * @param {object} opts.contract — case contract（eval 用，不進 prompt）
 * @param {object} opts.adapter — createPiTransportAdapter() 實例
 * @param {Function} [opts.execute] — runner stub executor
 * @returns {Promise<object>}
 */
export async function runV2Pipeline({ source, parent, manifest, contract, adapter, execute, hooks = {} } = {}) {
  const prompts = buildPromptBundle(source);

  const transport = await adapter.generate({ systemPrompt: prompts.systemPrompt, input: prompts.userPrompt });
  const base = { prompts, source };

  if (transport.status !== "completed") {
    return {
      ...base,
      stage: "transport",
      transport,
      verdict: "HOLD",
      hardFailures: [`transport:${transport.status}:${transport.reason || ""}`],
    };
  }

  const ir = transport.parsed;

  const shape = validateIRShape(ir);
  if (!shape.valid) {
    return { ...base, stage: "schema", transport, ir, shape, verdict: "HOLD", hardFailures: shape.errors };
  }

  const structural = validateStructural(ir, parent);
  const structuralFailures = structural.filter((g) => !g.pass).map((g) => `${g.gate_id}: ${g.evidence}`);
  if (structuralFailures.length > 0) {
    return { ...base, stage: "structural", transport, ir, shape, structural, verdict: "HOLD", hardFailures: structuralFailures };
  }

  const semantic = validateSemantic(ir, manifest);
  const semanticFailures = semantic.gates.filter((g) => !g.pass).map((g) => `${g.gate_id}: ${g.evidence}`);
  const frontierFailures = semantic.frontierFailures;
  if (semanticFailures.length > 0 || frontierFailures.length > 0) {
    return { ...base, stage: "semantic", transport, ir, shape, structural, semantic, verdict: "HOLD", hardFailures: [...semanticFailures, ...frontierFailures] };
  }

  const caseEval = evaluateCase(ir, contract);
  if (caseEval.failures.length > 0) {
    return { ...base, stage: "case", transport, ir, shape, structural, semantic, caseEval, verdict: "HOLD", hardFailures: caseEval.failures };
  }

  const scorecard = evaluateScorecardV2(ir, { parent, manifest, contract });
  if (scorecard.verdict !== "PASS") {
    return { ...base, stage: "scorecard", transport, ir, shape, structural, semantic, caseEval, scorecard, verdict: scorecard.verdict };
  }

  // HOLD/NOT_BENEFICIAL 不進 runner；只有 PASS 才排程。
  const run = await runDecompositionGraph({ ir, execute, hooks: hooks.runner });
  return { ...base, stage: "runner", transport, ir, shape, structural, semantic, caseEval, scorecard, run, verdict: run.verdict };
}
