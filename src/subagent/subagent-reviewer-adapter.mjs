// src/subagent/subagent-reviewer-adapter.mjs
//
// Deterministic reviewer adapter for sub-agent nodes（adapter/contract.mjs）.
// Re-validates the sub-agent's structured result（schema + identity + status）
// on top of the executor's fail-closed collection; emits a normalized verdict
// JSON on stdout for lifecycle-runner.mjs.
//
// Writer sub-agent nodes（schema autoloop.subagent.writer-result/v1）get a
// writer-aware judgment: PASS only when the writer result is schema-valid,
// status PASS, tests fully passed, diff present and scope verification ok.
// A writer that reports REPAIR or failing tests yields a REPAIR verdict
//（bounded repair loop）; any scope/schema/identity failure is a blocking
// issue（the executor already fail-closed scope violations, so this path is
// defense-in-depth）.

import { assertAdapterRequest } from "../adapter/contract.mjs";
import {
  SUBAGENT_WRITER_RESULT_SCHEMA,
  SUBAGENT_RESULT_SCHEMA,
} from "./subagent-contract.mjs";

export function createSubagentReviewerAdapter() {
  async function runAdapter(request) {
    assertAdapterRequest(request);
    if (request.phase !== "reviewer") {
      return { status: "error", executionId: request.executionId, error: `unexpected_phase:${request.phase}`, stdout: "", stderr: "", metadata: {} };
    }
    const runtime = request.taskCard?.runtime ?? {};
    const executor = runtime.lastExecutorResult ?? null;
    const sub = executor?.metadata?.subagent ?? null;
    const nodeId = request.taskCard?.phaseId ?? "unknown";
    const resultSchema = sub?.result?.schema_version ?? null;

    const issues = [];
    const evidenceGaps = [];
    if (!executor || executor.status !== "completed") {
      issues.push(`executor_not_completed:${executor?.status ?? "none"}`);
      evidenceGaps.push("executor_not_completed");
    } else if (!sub || !sub.result || !sub.validation?.ok) {
      issues.push("subagent_result_invalid");
      evidenceGaps.push(`subagent_result_invalid:${(sub?.validation?.errors ?? ["result_unavailable"]).join(";")}`);
    } else if (sub.result.status !== "PASS" && sub.result.status !== "REPAIR") {
      issues.push(`subagent_status:${sub.result.status}`);
      evidenceGaps.push(`subagent_status:${sub.result.status}`);
    }

    const isWriter = resultSchema === SUBAGENT_WRITER_RESULT_SCHEMA;
    let needsRepair = false;

    if (issues.length === 0 && sub?.result) {
      const r = sub.result;
      if (isWriter) {
        // Writer contract double-check（executor already fail-closed these;
        // the reviewer re-checks so a PASS can never ride on a scope or test
        // failure）.
        if (r.scopeVerification?.ok !== true) {
          issues.push("writer_scope_verification_not_ok");
          evidenceGaps.push(`writer_scope_verification_not_ok:${JSON.stringify(r.scopeVerification?.violations ?? [])}`);
        }
        if (!Array.isArray(r.filesChanged) || r.filesChanged.length === 0) {
          issues.push("writer_filesChanged_missing");
          evidenceGaps.push("writer_filesChanged_missing");
        }
        if (typeof r.diffSummary !== "string" || r.diffSummary.length === 0) {
          issues.push("writer_diff_summary_missing");
          evidenceGaps.push("writer_diff_summary_missing");
        }
        const tr = r.testResults;
        if (!tr || typeof tr.total !== "number" || tr.total < 1) {
          issues.push("writer_testResults_missing");
          evidenceGaps.push("writer_testResults_missing");
        } else if (tr.failed > 0) {
          issues.push(`writer_tests_failed:${tr.failed}/${tr.total}`);
          evidenceGaps.push(`writer_tests_failed:${tr.failed}/${tr.total}`);
          needsRepair = true;
        }
        if (r.status === "REPAIR") needsRepair = true;
        if (r.worktreeIdentity?.head !== r.worktreeIdentity?.baseCommit) {
          issues.push("writer_worktree_identity_inconsistent");
          evidenceGaps.push("writer_worktree_identity_inconsistent");
        }
      } else if (r.status === "REPAIR") {
        needsRepair = true;
      }
    }

    let verdict;
    if (issues.length === 0 && !needsRepair) {
      const r = sub.result;
      const detail = isWriter
        ? `writer sub-agent node ${nodeId}: writer result verified (schema+identity+scope+worktree), ${r.filesChanged.length} file(s) changed, tests ${r.testResults?.passed}/${r.testResults?.total} passed, diff present`
        : `sub-agent node ${nodeId}: structured result verified (schema+identity+status), ${r.filesInspected.length} file(s) inspected, ${r.commandsExecuted.length} command(s) recorded`;
      verdict = {
        verdict: "PASS",
        confidence: "HIGH",
        blocking_issues: [],
        required_supplements: [],
        evidence_gaps: [],
        summary: detail,
        recommended_next_action: "STOP",
      };
    } else if (issues.length === 0 && needsRepair) {
      // Writer failed its own tests / requested repair — bounded repair loop.
      verdict = {
        verdict: "NEEDS_SUPPLEMENT",
        confidence: "MEDIUM",
        blocking_issues: [],
        required_supplements: [],
        evidence_gaps: [`writer_tests_failed:${sub.result.testResults?.failed}/${sub.result.testResults?.total}`],
        summary: `writer sub-agent node ${nodeId}: writer self-tests failed / REPAIR status — repair attempt allowed within budget`,
        recommended_next_action: "REPAIR",
      };
    } else {
      verdict = {
        verdict: "NEEDS_SUPPLEMENT",
        confidence: "LOW",
        blocking_issues: issues,
        required_supplements: [],
        evidence_gaps: evidenceGaps,
        summary: `sub-agent node ${nodeId}: structured result NOT verifiable (${issues.join("; ")})`,
        recommended_next_action: "REPAIR",
      };
    }

    return {
      status: "completed",
      executionId: request.executionId,
      stdout: JSON.stringify(verdict),
      stderr: "",
      metadata: { reviewer: "deterministic-subagent", writer: isWriter, issues },
    };
  }

  return { runAdapter };
}

export { SUBAGENT_RESULT_SCHEMA };
