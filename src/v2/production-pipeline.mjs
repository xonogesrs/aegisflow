// src/v2/production-pipeline.mjs
//
// C2 — Production decomposition pipeline.
//
// Fixed order (deterministic):
//   source task
//   → buildPromptBundle（frozen prompt-builder）
//   → decompositionAdapter.generate（exactly ONE provider request）
//   → validateIRShape（ir-schema）
//   → validateStructural（structural-validator H1/H2/H3/H5/H7/H8/H12）
//   → validateSemantic（semantic-consistency H4/H6/H9/H10 + frontier）
//   → evaluateScorecardV2 WITHOUT case contract（case evaluator never runs）
//
// Hard rules:
//  - No case contract / eval oracle / E1–E12 fixture in this path.
//  - No normalization, no repair, no second request, no silent fallback.
//  - Any failure → fail-closed HOLD at the exact failing stage with zero
//    lifecycle calls.
//  - DECOMPOSITION_BLOCKED → HOLD（reason DECOMPOSITION_BLOCKED）.
//  - DECOMPOSITION_NOT_BENEFICIAL → NOT_BENEFICIAL（no actionable phases）.
//  - DECOMPOSED → PASS only when every hard gate passes; the caller then
//    schedules the DAG.

import { buildPromptBundle } from "./prompt-builder.mjs";
import { validateIRShape } from "./ir-schema.mjs";
import { validateStructural } from "./structural-validator.mjs";
import { validateSemantic } from "./semantic-consistency.mjs";
import { evaluateScorecardV2 } from "./scorecard-v2.mjs";

export const PRODUCTION_STAGES = Object.freeze([
  "transport", "schema", "decomposition_verdict", "structural", "semantic", "scorecard",
]);

function hold(stage, reason, hardFailures, extra = {}) {
  return {
    final: "HOLD",
    stage,
    verdict: "HOLD",
    reason,
    hardFailures: Array.isArray(hardFailures) ? hardFailures : [String(hardFailures)],
    transport: null,
    ir: null,
    shape: null,
    structural: null,
    semantic: null,
    scorecard: null,
    prompts: null,
    ...extra,
  };
}

/**
 * Run the production decomposition pipeline (no case oracle, one request).
 *
 * @param {object} opts
 * @param {object} opts.source — { goal?, requirements: [{requirement_id, text}], authority }
 * @param {object} opts.parent — { scope: { allowed_paths, forbidden_paths } }
 * @param {object[]} opts.manifest — [{ requirement_id, text }]
 * @param {object} opts.decompositionAdapter — { generate({systemPrompt, input}) }
 *        (sealed v2 transport interface: completed → parsed)
 * @param {object} [opts.hooks] — { onStage }
 * @returns {Promise<object>}
 */
export async function runProductionPipeline({ source, parent, manifest, decompositionAdapter, hooks = {} } = {}) {
  if (!decompositionAdapter || typeof decompositionAdapter.generate !== "function") {
    return hold("transport", "MISSING_DECOMPOSITION_ADAPTER", ["decompositionAdapter.generate is required"]);
  }

  let prompts;
  try {
    prompts = buildPromptBundle(source);
  } catch (e) {
    return hold("transport", "PROMPT_BUILD_FAILED", [`buildPromptBundle: ${e?.message || e}`]);
  }
  hooks.onStage?.("transport");

  let transport;
  try {
    transport = await decompositionAdapter.generate({ systemPrompt: prompts.systemPrompt, input: prompts.userPrompt });
  } catch (e) {
    return hold("transport", `transport:${e?.code || e?.name || "error"}`, [`${e?.message || e}`]);
  }

  const boundedTransport = transport && typeof transport === "object"
    ? {
        status: transport.status,
        requestCount: Number.isInteger(transport.requestCount) ? transport.requestCount : null,
        elapsedMs: Number.isFinite(transport.elapsedMs) ? transport.elapsedMs : null,
        reason: typeof transport.reason === "string" ? transport.reason : null,
      }
    : null;

  if (!transport || transport.status !== "completed") {
    const reason = `transport:${transport?.status ?? "missing"}:${transport?.reason ?? "no_result"}`;
    return hold("transport", reason, [reason], { transport: boundedTransport, prompts: { version: prompts.version } });
  }

  const ir = transport.parsed;
  if (ir === null || ir === undefined || typeof ir !== "object" || Array.isArray(ir)) {
    return hold("schema", "transport:parsed_not_object", ["transport completed without a parsed IR object"], {
      transport: boundedTransport, prompts: { version: prompts.version },
    });
  }

  // 1. schema
  hooks.onStage?.("schema");
  const shape = validateIRShape(ir);
  if (!shape.valid) {
    return hold("schema", "IR_SCHEMA_INVALID", shape.errors, {
      transport: boundedTransport, ir, shape, prompts: { version: prompts.version },
    });
  }

  // 2. decomposition verdict short-circuits (no phases to execute)
  if (ir.verdict === "DECOMPOSITION_BLOCKED") {
    return {
      final: "HOLD",
      stage: "decomposition_verdict",
      verdict: "HOLD",
      reason: "DECOMPOSITION_BLOCKED",
      hardFailures: ["verdict:DECOMPOSITION_BLOCKED"],
      transport: boundedTransport,
      ir,
      shape,
      structural: null,
      semantic: null,
      scorecard: null,
      prompts: { version: prompts.version },
    };
  }
  if (ir.verdict === "DECOMPOSITION_NOT_BENEFICIAL") {
    return {
      final: "NOT_BENEFICIAL",
      stage: "decomposition_verdict",
      verdict: "NOT_BENEFICIAL",
      reason: "DECOMPOSITION_NOT_BENEFICIAL",
      hardFailures: [],
      transport: boundedTransport,
      ir,
      shape,
      structural: null,
      semantic: null,
      scorecard: null,
      prompts: { version: prompts.version },
    };
  }

  // 3. structural
  hooks.onStage?.("structural");
  const structural = validateStructural(ir, parent);
  const structuralFailures = structural.filter((g) => !g.pass).map((g) => `${g.gate_id}: ${g.evidence}`);
  if (structuralFailures.length > 0) {
    return hold("structural", "STRUCTURAL_GATE_FAILED", structuralFailures, {
      transport: boundedTransport, ir, shape, structural, prompts: { version: prompts.version },
    });
  }

  // 4. semantic
  hooks.onStage?.("semantic");
  const semantic = validateSemantic(ir, manifest);
  const semanticFailures = semantic.gates.filter((g) => !g.pass).map((g) => `${g.gate_id}: ${g.evidence}`);
  const frontierFailures = semantic.frontierFailures;
  if (semanticFailures.length > 0 || frontierFailures.length > 0) {
    return hold("semantic", "SEMANTIC_GATE_FAILED", [...semanticFailures, ...frontierFailures], {
      transport: boundedTransport, ir, shape, structural, semantic, prompts: { version: prompts.version },
    });
  }

  // 5. scorecard — NO case contract: evaluateCase is never invoked because
  // `contract` is omitted (see scorecard-v2.mjs: contract ? evaluateCase : no-op).
  hooks.onStage?.("scorecard");
  const scorecard = evaluateScorecardV2(ir, { parent, manifest });
  if (scorecard.verdict !== "PASS") {
    return hold("scorecard", scorecard.verdict === "NOT_BENEFICIAL" ? "DECOMPOSITION_NOT_BENEFICIAL" : "SCORECARD_HOLD",
      scorecard.hardFailures, {
        transport: boundedTransport, ir, shape, structural, semantic, scorecard, prompts: { version: prompts.version },
      });
  }

  return {
    final: "PASS",
    stage: "scorecard",
    verdict: "PASS",
    reason: null,
    hardFailures: [],
    transport: boundedTransport,
    ir,
    shape,
    structural,
    semantic,
    scorecard,
    prompts: { version: prompts.version },
  };
}
