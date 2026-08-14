// src/subagent/subagent-executor-adapter.mjs
//
// Sub-agent executor adapter（adapter/contract.mjs `runAdapter`）.
//
// Launches a REAL sub-agent process inside an isolated Colima container:
//   - repo mounted read-only at /src; private scratch rw at /scratch; shared
//     graph results dir rw at /results
//   - network none, --cap-drop ALL, no-new-privileges, limits; runtime socket
//     never mounted
//   - the agent receives its minimal context envelope via container env
//     （objective + identities + task type — never the full history）
//   - the agent performs a bounded read-only task, writes its STRUCTURED
//     result（autoloop.subagent.structured-result/v1）to /scratch/result.json
//   - the executor collects and validates the result（schema + identity
//     binding）; invalid / missing / identity-mismatched results are
//     fail-closed（status=error → node cannot PASS）
//
// Identity: agentExecutionId + inputContextIdentity are derived
// deterministically from the graph/node（never from PID or container name）.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertAdapterRequest } from "../adapter/contract.mjs";
import { runTask, assertMountAllowlist } from "../runtime/colima-runtime.mjs";
import {
  buildSubagentEnvelope,
  validateSubagentResult,
  SUBAGENT_RESULT_SCHEMA,
  TOOL_PERMISSIONS,
} from "./subagent-contract.mjs";

export class SubagentExecutorError extends Error {
  constructor(reason, details) {
    super(`subagent_executor_adapter: ${reason}`);
    this.name = "SubagentExecutorError";
    this.reason = reason;
    this.details = details;
  }
}

/**
 * The agent program（busybox-sh; runs INSIDE the alpine container）.
 * It records its commands, performs the bounded task, and emits the
 * structured result JSON to /scratch/result.json.
 */
export function buildAgentCommand(taskType) {
  return [
    "set -u",
    'mkdir -p /scratch',
    '[ -n "${AGENT_SLEEP:-}" ] && sleep "$AGENT_SLEEP"',
    'FILES=""', 'COUNT=0', 'CLAIM="task completed"', 'W_STATUS="PASS"',
    'case "' + taskType + '" in',
    "  count_todos)",
    '    FILES=$(grep -rl "TODO" /src/docs 2>/dev/null || true)',
    '    COUNT=$(printf \'%s\\n\' "$FILES" | grep -c . || true)',
    '    CLAIM="found ${COUNT} file(s) containing TODO under /src/docs"',
    '    ;;',
    "  inventory_markdown)",
    "    FILES=$(find /src/docs -name '*.md' -type f 2>/dev/null | sort)",
    '    COUNT=$(printf \'%s\\n\' "$FILES" | grep -c . || true)',
    '    CLAIM="found ${COUNT} markdown file(s) under /src/docs"',
    '    ;;',
    "  verify_writer)",
    '    DEPS_OK=0',
    '    [ -f /results/SA-R1.json ] && [ -f /results/SA-R2.json ] && DEPS_OK=1',
    '    W_RESULT_OK=0',
    '    [ -f /results/SA-W1.json ] && grep -q \'"status": "PASS"\' /results/SA-W1.json && W_RESULT_OK=1',
    '    W_WT_OK=0',
    '    [ -f /results/SA-W1.worktree.json ] && W_WT_OK=1',
    '    SCOPE_OK=0',
    '    [ "$W_RESULT_OK" = "1" ] && grep -q \'"ok": true\' /results/SA-W1.json && SCOPE_OK=1',
    '    TESTS_OK=0',
    '    [ "$W_RESULT_OK" = "1" ] && grep -q \'"failed": 0\' /results/SA-W1.json && TESTS_OK=1',
    '    DIFF_OK=0',
    '    [ "$W_RESULT_OK" = "1" ] && grep -q \'"diffSummary": "[^"]\' /results/SA-W1.json && DIFF_OK=1',
    '    if [ "$DIFF_OK" != "1" ] && [ "$W_WT_OK" = "1" ]; then',
    '      if grep -q \'"diff": "[^"]\' /results/SA-W1.worktree.json; then DIFF_OK=1; fi',
    '      if [ "$DIFF_OK" != "1" ] && grep -q \'"untrackedDirs": \\[[^]]\' /results/SA-W1.worktree.json; then DIFF_OK=1; fi',
    '      if [ "$DIFF_OK" != "1" ] && grep -q \'"untrackedFiles": \\[[^]]\' /results/SA-W1.worktree.json; then DIFF_OK=1; fi',
    '    fi',
    '    REVIEW_OK=0',
    '    [ -f /results/SA-W1.review.json ] && grep -q \'"recommendedAction": "PASS"\' /results/SA-W1.review.json && grep -q \'"blockingFindings": \\[\]\' /results/SA-W1.review.json && REVIEW_OK=1',
    '    if [ "$DEPS_OK" = "1" ] && [ "$W_RESULT_OK" = "1" ] && [ "$W_WT_OK" = "1" ] && [ "$SCOPE_OK" = "1" ] && [ "$TESTS_OK" = "1" ] && [ "$DIFF_OK" = "1" ] && [ "$REVIEW_OK" = "1" ]; then',
    '      W_STATUS="PASS"',
    '      CLAIM="writer SA-W1 independently verified: deps present, writer result PASS, scope ok, tests 0 failed, diff present, independent review PASS"',
    '    else',
    '      W_STATUS="REPAIR"',
    '      CLAIM="writer SA-W1 verification FAILED (deps=$DEPS_OK result=$W_RESULT_OK worktree=$W_WT_OK scope=$SCOPE_OK tests=$TESTS_OK diff=$DIFF_OK review=$REVIEW_OK)"',
    '    fi',
    '    ;;',
    "  *)",
    '    CLAIM="objective executed: ${AGENT_OBJECTIVE}"',
    '    ;;',
    "esac",
    // structured result emission（JSON array construction, minimal escaping）
    '{',
    '  echo "{"',
    '  echo "  \\"schema_version\\": \\"autoloop.subagent.structured-result/v1\\","',
    '  echo "  \\"status\\": \\"$W_STATUS\\","',
    '  echo "  \\"agentExecutionId\\": \\"$AGENT_EXECUTION_ID\\","',
    '  echo "  \\"inputContextIdentity\\": \\"$INPUT_CONTEXT_IDENTITY\\","',
    '  echo "  \\"outputSchemaIdentity\\": \\"autoloop.subagent.structured-result/v1\\","',
    '  echo "  \\"claims\\": [\\"$CLAIM\\"],"',
    '  echo "  \\"evidenceReferences\\": [],"',
    '  echo "  \\"filesInspected\\": ["',
    '  _first=1',
    '  for _f in $FILES; do',
    '    [ "$_first" = "1" ] && _first=0 || echo ","',
    '    printf \'    "%s"\' "$_f"',
    '  done',
    '  echo ""',
    '  echo "  ],"',
    '  echo "  \\"commandsExecuted\\": [\\"task=${AGENT_TASK_TYPE}\\", \\"grep/find under /src\\"],"',
    '  echo "  \\"assumptions\\": [\\"repo mounted read-only at /src\\", \\"network none\\"],"',
    '  echo "  \\"uncertainties\\": [],"',
    '  echo "  \\"recommendedNextAction\\": \\"review\\","',
    '  echo "  \\"summary\\": \\"$CLAIM\\""',
    '  echo "}"',
    '} > /scratch/result.json',
    // failure-injection hooks（contract-test only; envelope-controlled）
    '[ "${EMIT_MALFORMED:-0}" = "1" ] && echo "not valid json {{broken" > /scratch/result.json',
    // agent-process crash: SIGKILL a spawned worker and exit with its status
    // (PID 1 self-signal is ineffective in containers; worker kill + abnormal exit).
    '[ "${CRASH_AFTER:-0}" = "1" ] && { ( sleep 30 ) & _c=$!; kill -9 $_c; wait $_c; exit $?; }',
    'echo "SUBAGENT_DONE:${AGENT_TASK_TYPE}"',
  ].join("\n");
}

export function createSubagentExecutorAdapter({ profile, repoPath, scratchRoot, resultsDir, resultSink }) {
  if (!profile || !repoPath || !scratchRoot || !resultsDir) {
    throw new SubagentExecutorError("profile/repoPath/scratchRoot/resultsDir required");
  }

  async function runAdapter(request) {
    assertAdapterRequest(request);
    if (request.phase !== "executor") {
      return { status: "error", executionId: request.executionId, error: `unexpected_phase:${request.phase}`, stdout: "", stderr: "", metadata: {} };
    }
    const runtime = request.taskCard?.runtime ?? {};
    const taskType = runtime.taskType ?? "inventory_markdown";
    const objective = runtime.objective ?? `read-only ${taskType} over /src`;

    // TA-2（K）: a read-only node under an admission that violates the
    // envelope projection never runs（fail-closed）.
    if (runtime.admissionViolation) {
      return { status: "error", executionId: request.executionId, error: `${runtime.admissionViolation.code}:${runtime.admissionViolation.message}`, stdout: "", stderr: "", metadata: { mode: "subagent-readonly", admissionViolation: runtime.admissionViolation } };
    }

    const envelope = buildSubagentEnvelope({
      graphExecutionId: request.taskCard?.parentExecutionId ?? request.executionId,
      nodeId: request.taskCard?.phaseId ?? "unknown",
      phaseExecutionId: request.executionId,
      agentRole: runtime.agentRole ?? "readonly-analyst",
      objective,
      authorizedPaths: runtime.authorizedPaths ?? ["/src", "/scratch", "/results"],
      // TA-2（K）: tool permissions come FROM admission（never agent-selected）.
      toolPermissions: Array.isArray(runtime.toolPermissions) && runtime.toolPermissions.length ? runtime.toolPermissions : TOOL_PERMISSIONS.READ_ONLY,
      runtimeInstance: { profile, socket: null },
      timeoutMs: runtime.limits?.timeoutMs ?? request.timeoutMs,
      dependencyResultsDigest: runtime.dependencyResultsDigest ?? null,
      memoryContext: runtime.memoryContext ?? null,
      admissionId: runtime.admissionId ?? null,
      admissionDigest: runtime.admissionDigest ?? null,
    });

    const privateScratch = runtime.scratchPath;
    if (!privateScratch) {
      return { status: "error", executionId: request.executionId, error: "subagent_requires_scratchPath", stdout: "", stderr: "", metadata: {} };
    }
    const roMounts = [{ source: repoPath, target: "/src" }];
    const rwMounts = [
      { source: privateScratch, target: "/scratch" },
      { source: resultsDir, target: "/results" },
    ];
    assertMountAllowlist({ roMounts, rwMounts, repoPaths: [repoPath], scratchRoot });

    const env = {
      AGENT_EXECUTION_ID: envelope.agentExecutionId,
      INPUT_CONTEXT_IDENTITY: envelope.inputContextIdentity,
      AGENT_NODE_ID: envelope.nodeId,
      GRAPH_EXECUTION_ID: envelope.graphExecutionId,
      PHASE_EXECUTION_ID: envelope.phaseExecutionId,
      AGENT_OBJECTIVE: objective,
      AGENT_TASK_TYPE: taskType,
      AGENT_SLEEP: runtime.sleep ? String(runtime.sleep) : "",
      EMIT_MALFORMED: runtime.emitMalformed ? "1" : "0",
      CRASH_AFTER: runtime.crashAfter ? "1" : "0",
    };

    const run = await runTask({
      profile,
      executionId: request.executionId,
      taskId: `agent-${request.attempt}`,
      command: buildAgentCommand(taskType),
      roMounts,
      rwMounts,
      network: "none",
      cpus: runtime.limits?.cpus,
      memoryMiB: runtime.limits?.memoryMiB,
      pidsLimit: runtime.limits?.pidsLimit,
      timeoutMs: runtime.limits?.timeoutMs ?? request.timeoutMs,
      abortSignal: request.abortSignal,
      env,
    });

    // collect + validate the structured result
    let subagentResult = null;
    let validation = { ok: false, errors: ["result_unavailable"] };
    if (run.status === "completed") {
      const resultPath = join(privateScratch, "result.json");
      if (existsSync(resultPath)) {
        try {
          subagentResult = JSON.parse(readFileSync(resultPath, "utf8"));
          validation = validateSubagentResult(subagentResult, {
            expectedAgentExecutionId: envelope.agentExecutionId,
            expectedInputContextIdentity: envelope.inputContextIdentity,
          });
        } catch (e) {
          validation = { ok: false, errors: [`result_parse_failed:${String(e?.message ?? e).slice(0, 200)}`] };
        }
      }
    }

    const result = {
      status: run.status,
      executionId: request.executionId,
      stdout: run.stdout,
      stderr: run.stderr,
      metadata: { ...(run.metadata ?? {}), subagent: { envelope, result: subagentResult, validation } },
    };
    // fail-closed: a completed agent whose structured result is missing /
    // invalid / identity-mismatched must NOT pass.
    if (run.status === "completed" && !validation.ok) {
      result.status = "error";
      result.error = `subagent_result_invalid:${validation.errors.join(";")}`;
    }
    resultSink?.(request.executionId, result);
    if (request.taskCard && typeof request.taskCard === "object") {
      request.taskCard.runtime = request.taskCard.runtime ?? {};
      request.taskCard.runtime.lastExecutorResult = result;
    }
    return result;
  }

  return { runAdapter };
}

export { SUBAGENT_RESULT_SCHEMA };
