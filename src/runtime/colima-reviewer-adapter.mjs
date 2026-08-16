// src/runtime/colima-reviewer-adapter.mjs
//
// Deterministic pipeline reviewer adapter for the Colima isolated-writer
// pipeline (satisfies adapter/contract.mjs `runAdapter`).
//
// It is NOT a language model: it mechanically judges the executor's recorded
// result against the task card's explicit expectations and emits a normalized
// reviewer verdict JSON on stdout, which lifecycle-runner.mjs parses and
// normalizes (normalize-reviewer-json.mjs). Scope enforcement itself was
// already done by the lifecycle's mutation-scope gate BEFORE the reviewer is
// invoked; this adapter double-checks the executor status and stdout markers.

import { assertAdapterRequest } from "../adapter/contract.mjs";

const EXPECTED_MARKERS_MISSING = "expected_stdout_markers_missing";
const EXECUTOR_NOT_COMPLETED = "executor_not_completed";

export function createColimaReviewerAdapter() {
  async function runAdapter(request) {
    assertAdapterRequest(request);
    if (request.phase !== "reviewer") {
      return {
        status: "error",
        executionId: request.executionId,
        error: `unexpected_phase:${request.phase}`,
        stdout: "",
        stderr: "",
        metadata: {},
      };
    }
    const runtime = request.taskCard?.runtime ?? {};
    const executor = runtime.lastExecutorResult ?? null;
    const expect = runtime.expect ?? {};
    const expectedMarkers = Array.isArray(expect.stdoutContains) ? expect.stdoutContains : [];
    const summaryBase = `c3 colima task ${runtime.mode ?? "readonly"} (executionId=${request.executionId})`;

    const issues = [];
    const evidenceGaps = [];
    if (!executor || executor.status !== "completed") {
      issues.push(EXECUTOR_NOT_COMPLETED);
      evidenceGaps.push(EXECUTOR_NOT_COMPLETED);
    } else {
      for (const marker of expectedMarkers) {
        if (!executor.stdout.includes(marker)) {
          issues.push(`${EXPECTED_MARKERS_MISSING}:${marker}`);
          evidenceGaps.push(`${EXPECTED_MARKERS_MISSING}:${marker}`);
        }
      }
    }

    let verdict;
    if (issues.length === 0) {
      verdict = {
        verdict: "PASS",
        confidence: "HIGH",
        blocking_issues: [],
        required_supplements: [],
        evidence_gaps: [],
        summary: `${summaryBase}: all expectations met (status=completed, ${expectedMarkers.length} marker(s) verified)`,
        recommended_next_action: "STOP",
      };
    } else {
      verdict = {
        verdict: "NEEDS_SUPPLEMENT",
        confidence: "LOW",
        blocking_issues: issues,
        required_supplements: [],
        evidence_gaps: evidenceGaps,
        summary: `${summaryBase}: expectations not met (${issues.join("; ")})`,
        recommended_next_action: "REPAIR",
      };
    }

    return {
      status: "completed",
      executionId: request.executionId,
      stdout: JSON.stringify(verdict),
      stderr: "",
      metadata: { reviewer: "deterministic-c3", issues },
    };
  }

  return { runAdapter };
}
