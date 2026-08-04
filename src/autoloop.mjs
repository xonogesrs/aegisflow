// src/autoloop.mjs
//
// C2 — AutoLoop unified library entrypoint (production-oriented).
//
// Single fail-closed flow:
//   parent task + manifest
//   → V2 production decomposition pipeline（prompt → transport → schema →
//     structural → semantic → scorecard；NO case oracle）
//   → deterministic DAG scheduler（sealed runner）
//   → phase task-card bridge
//   → executor lifecycle
//   → reviewer lifecycle
//   → PASS / HOLD / NOT_BENEFICIAL
//
// This card wires execution and returns in-memory results only. Durable
// evidence / checkpoint-resume / operator CLI / real-Pi acceptance are
// deferred to C3 / C4 / C5.
//
// Hard rules:
//  - maxRepairAttempts ∈ {0, 1}（default 1）.
//  - timeoutMs must be explicit and > 0.
//  - executor and reviewer adapter factories must be provided separately.
//  - Each phase gets fresh adapter instances（session reuse = 0）.
//  - Parallel mutation is forbidden（enforced by the sealed runner lease）.
//  - No case contract / eval oracle / E1–E12 fixture / live-probe helper /
//    card-5 freeze script as runtime dependency.

import { runProductionPipeline } from "./v2/production-pipeline.mjs";
import { runExecutionOrchestrator } from "./v2/execution-orchestrator.mjs";
import { mintExecutionId } from "./c2d/execution-id.mjs";
import { runDurableAutoLoop, resumeAutoLoop } from "./v2/durable-execution.mjs";
import { AUTOLOOP_STATE_RESTART_REQUIRED as CHECKPOINT_STATE_RESTART_REQUIRED } from "./v2/checkpoint-bridge.mjs";

export { resumeAutoLoop };

// C4I: canonical state for a pre-decomposition / incomplete-decomposition
// interruption（not resumable; a new execution is required）.
export const AUTOLOOP_STATE_RESTART_REQUIRED = CHECKPOINT_STATE_RESTART_REQUIRED;
export const PRE_DECOMPOSITION_RESTART_REQUIRED = "PRE_DECOMPOSITION_RESTART_REQUIRED";

export const AUTOLOOP_HOLD = Object.freeze({
  MISSING_INPUT: "MISSING_INPUT",
  INVALID_TIMEOUT: "INVALID_TIMEOUT",
  INVALID_REPAIR_BUDGET: "INVALID_REPAIR_BUDGET",
  MISSING_DECOMPOSITION_ADAPTER: "MISSING_DECOMPOSITION_ADAPTER",
  MISSING_EXECUTOR_ADAPTER_FACTORY: "MISSING_EXECUTOR_ADAPTER_FACTORY",
  MISSING_REVIEWER_ADAPTER_FACTORY: "MISSING_REVIEWER_ADAPTER_FACTORY",
  PERSISTENCE_MODE_REQUIRED: "PERSISTENCE_MODE_REQUIRED",
  INVALID_PERSISTENCE_MODE: "INVALID_PERSISTENCE_MODE",
  PERSISTENCE_CONFIG_INVALID: "PERSISTENCE_CONFIG_INVALID",
});

function hold(reason, executionId) {
  return {
    final: "HOLD",
    stage: "input",
    reason,
    executionId,
    decomposition: null,
    phaseResults: [],
    scheduler: null,
    transitions: [],
    diagnostics: {},
  };
}

/**
 * Run AutoLoop end-to-end (decomposition → DAG execution) in memory.
 *
 * @param {object} opts
 * @param {object} opts.source — { goal?, requirements: [{requirement_id, text}], authority }
 * @param {object} opts.parent — { scope: { allowed_paths, forbidden_paths } }
 * @param {object[]} opts.manifest — [{ requirement_id, text }]
 * @param {string} opts.cwd — repository root
 * @param {object} opts.decompositionAdapter — { generate({systemPrompt, input}) }
 * @param {Function} opts.executorAdapterFactory — () => adapter（fresh per phase）
 * @param {Function} opts.reviewerAdapterFactory — () => adapter（fresh per phase）
 * @param {number} [opts.maxRepairAttempts = 1] — 0 or 1
 * @param {number} opts.timeoutMs — explicit, positive
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.hooks] — { onStage, onPhase, expectedReviewerModel, toolPolicy, environmentAllowlist, runner }
 * @param {object} [opts.persistence] — { mode: "durable"|"ephemeral", root, executionId };
 *        durable writes evidence journal + checkpoints + manifest; ephemeral
 *        is offline-test / explicit-library only（no filesystem evidence）.
 * @returns {Promise<{
 *   final: "PASS"|"HOLD"|"NOT_BENEFICIAL",
 *   stage, reason, executionId,
 *   decomposition, phaseResults, scheduler, transitions, diagnostics
 * }>}
 */
export async function runAutoLoop({
  source,
  parent,
  manifest,
  cwd,
  decompositionAdapter,
  executorAdapterFactory,
  reviewerAdapterFactory,
  maxRepairAttempts = 1,
  timeoutMs,
  signal,
  hooks = {},
  persistence,
} = {}) {
  const executionId = mintExecutionId();

  // ── Persistence mode（never silently guess an evidence location）──
  if (persistence === undefined || persistence === null) {
    return hold(AUTOLOOP_HOLD.PERSISTENCE_MODE_REQUIRED, executionId);
  }
  if (persistence.mode === "ephemeral") {
    // Offline / explicit library use — no filesystem evidence. Falls through
    // to the plain in-memory flow below.
  } else if (persistence.mode === "durable") {
    if (typeof persistence.root !== "string" || persistence.root.length === 0 ||
        typeof persistence.executionId !== "string" || persistence.executionId.length === 0) {
      return hold(AUTOLOOP_HOLD.PERSISTENCE_CONFIG_INVALID, executionId);
    }
    return runDurableAutoLoop({
      source, parent, manifest, cwd,
      decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory,
      maxRepairAttempts, timeoutMs, signal, hooks,
      persistence: { root: persistence.root, executionId: persistence.executionId },
    });
  } else {
    return hold(AUTOLOOP_HOLD.INVALID_PERSISTENCE_MODE, executionId);
  }

  // ── Input gates（fail-closed, before any adapter/lifecycle call）──
  if (!source || typeof source !== "object" || Array.isArray(source)) return hold(AUTOLOOP_HOLD.MISSING_INPUT, executionId);
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return hold(AUTOLOOP_HOLD.MISSING_INPUT, executionId);
  if (!Array.isArray(manifest) || manifest.length === 0) return hold(AUTOLOOP_HOLD.MISSING_INPUT, executionId);
  if (typeof cwd !== "string" || cwd.length === 0) return hold(AUTOLOOP_HOLD.MISSING_INPUT, executionId);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return hold(AUTOLOOP_HOLD.INVALID_TIMEOUT, executionId);
  if (maxRepairAttempts !== 0 && maxRepairAttempts !== 1) return hold(AUTOLOOP_HOLD.INVALID_REPAIR_BUDGET, executionId);
  if (!decompositionAdapter || typeof decompositionAdapter.generate !== "function") {
    return hold(AUTOLOOP_HOLD.MISSING_DECOMPOSITION_ADAPTER, executionId);
  }
  if (typeof executorAdapterFactory !== "function") return hold(AUTOLOOP_HOLD.MISSING_EXECUTOR_ADAPTER_FACTORY, executionId);
  if (typeof reviewerAdapterFactory !== "function") return hold(AUTOLOOP_HOLD.MISSING_REVIEWER_ADAPTER_FACTORY, executionId);

  // ── 1. Production decomposition（one request；no case oracle）──
  const pipeline = await runProductionPipeline({
    source,
    parent,
    manifest,
    decompositionAdapter,
    hooks: { onStage: hooks.onStage },
  });

  if (pipeline.final !== "PASS") {
    return {
      final: pipeline.final,
      stage: pipeline.stage,
      reason: pipeline.reason ?? pipeline.hardFailures?.join("; ") ?? null,
      executionId,
      decomposition: null,
      phaseResults: [],
      scheduler: null,
      transitions: [],
      diagnostics: {
        pipeline_stage: pipeline.stage,
        transport_status: pipeline.transport?.status ?? null,
        transport_request_count: pipeline.transport?.requestCount ?? null,
        hard_failures: pipeline.hardFailures ?? [],
        prompt_builder_version: pipeline.prompts?.version ?? null,
      },
    };
  }

  // ── 2. DAG execution through lifecycle runner ──
  const orchestration = await runExecutionOrchestrator({
    ir: pipeline.ir,
    parent,
    manifest,
    cwd,
    executionId,
    executorAdapterFactory,
    reviewerAdapterFactory,
    maxRepairAttempts,
    timeoutMs,
    signal,
    hooks,
  });

  const ir = pipeline.ir;
  return {
    final: orchestration.final,
    stage: orchestration.final === "PASS" ? "execution" : "execution_hold",
    reason: orchestration.reason,
    executionId,
    decomposition: {
      verdict: ir.verdict,
      phase_count: (ir.phases || []).length,
      phase_ids: (ir.phases || []).map((p) => p.phase_id),
      disposition_count: (ir.dispositions || []).length,
    },
    phaseResults: orchestration.phaseResults,
    scheduler: orchestration.scheduler,
    transitions: orchestration.transitions,
    diagnostics: {
      pipeline_stage: pipeline.stage,
      transport_status: pipeline.transport?.status ?? null,
      transport_request_count: pipeline.transport?.requestCount ?? null,
      prompt_builder_version: pipeline.prompts?.version ?? null,
    },
  };
}
