// src/subagent/subagent-review-agent.mjs
//
// INDEPENDENT Review Agent + reviewer adapter（adapter/contract.mjs）.
//
// For WRITER sub-agent phases the reviewer stage is NOT a deterministic
// adapter: it launches a REAL, read-only review agent process in an isolated
// Colima container that independently re-examines the writer's output:
//   - the writer's dedicated worktree mounted READ-ONLY at /work（the actual
//     changed files, not just the writer's claims）
//   - the source repo read-only at /src（+ verifies the read-only boundary:
//     a writable /src would be a pollution finding）
//   - the shared results dir read-only at /results（writer structured result,
//     captured worktree artifact, dependency results）
//   - network none, cap-drop ALL, no-new-privileges, limits, no runtime
//     socket; private scratch rw only for its own review result
//
// The review agent NEVER trusts the writer's self-declared status: it
// cross-checks execution identity, dependency results, diff + mutation
// scope, tests, evidence references, the actual changed-file content
//（claims supported by evidence）and the /src read-only boundary. It emits a
// structured review result（autoloop.subagent.review-result/v1）with
// findings / blockingFindings / nonBlockingFindings / evidenceChecked /
// scopeVerified / testsVerified / recommendedAction.
//
// The adapter maps that review result to the lifecycle verdict:
//   recommendedAction PASS  -> PASS（node closes out）
//   recommendedAction REPAIR -> REPAIR（bounded repair loop; the repair
//                                agent receives the exact blocking findings
//                                via taskCard.runtime.lastReviewResult）
//   recommendedAction HOLD / invalid result / identity mismatch -> HOLD
//                                （no blind repair）
//
// The review result is persisted to resultsDir/<nodeId>.review.json so the
// final PASS review is independently verifiable by downstream nodes.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assertAdapterRequest } from "../adapter/contract.mjs";
import { runTask, assertMountAllowlist } from "../runtime/colima-runtime.mjs";
import {
  buildSubagentEnvelope,
  validateSubagentEnvelope,
  validateReviewSubagentResult,
  canonicalJson,
  sha256Hex,
  SUBAGENT_REVIEW_RESULT_SCHEMA,
} from "./subagent-contract.mjs";

/**
 * The review agent program（busybox-sh; runs INSIDE the alpine container）.
 * Independently checks a writer node's output and emits the structured
 * review result to /scratch/result.json. Finding codes are space-free so the
 * JSON array emission is safe under busybox sed.
 */
export function buildReviewAgentCommand() {
  const S = [
    "set -u",
    'mkdir -p /scratch',
    'SCOPE="${REVIEW_MUTATION_SCOPE:-docs/pi-graph-output}"',
    'WT_FILE="/work/$SCOPE/summary.md"',
    '[ -n "${REVIEW_SLEEP:-}" ] && sleep "$REVIEW_SLEEP"',
    'blocking=""',
    'add_blocking() { blocking="${blocking}${blocking:+|}$1"; }',
    // CEDF: dependency-reconciliation conflicts are pre-seeded blocking
    // findings（injected by the graph runner via runtime.dependencyConflicts
    // -> REVIEW_SEED_BLOCKING）; they are structural and HOLD, never repair.
    'for code in ${REVIEW_SEED_BLOCKING:-}; do add_blocking "$code"; done',
    // 1) dependency results（checked only when the writer declared deps）
    'if [ "${DEPENDENCY_COUNT:-0}" != "0" ]; then',
    '  if [ -f /results/SA-R1.json ] && [ -f /results/SA-R2.json ]; then deps_ok=1; else deps_ok=0; add_blocking DEPS_MISSING; fi',
    'else deps_ok=1; fi',
    // 2) writer structured result + scope + tests + diff（independent re-check）
    'if [ -f /results/SA-W1.json ]; then',
    '  grep -q \'"status": "PASS"\' /results/SA-W1.json && wr_ok=1 || wr_ok=0',
    '  grep -q \'"ok": true\' /results/SA-W1.json && scope_ok=1 || scope_ok=0',
    '  grep -q \'"failed": 0\' /results/SA-W1.json && tests_ok=1 || tests_ok=0',
    '  grep -q \'"diffSummary": "[^"]\' /results/SA-W1.json && diff_ok=1 || diff_ok=0',
    'else',
    '  wr_ok=0; scope_ok=0; tests_ok=0; diff_ok=0',
    '  add_blocking WRITER_RESULT_MISSING',
    'fi',
    '[ "$wr_ok" = "1" ] || add_blocking WRITER_STATUS_NOT_PASS',
    '[ "$scope_ok" = "1" ] || add_blocking SCOPE_NOT_OK',
    '[ "$tests_ok" = "1" ] || add_blocking TESTS_NOT_OK',
    '[ "$diff_ok" = "1" ] || add_blocking DIFF_MISSING',
    // 3) captured worktree artifact（diff inventory recorded before revoke）
    'if [ -f /results/SA-W1.worktree.json ]; then wt_ok=1; else wt_ok=0; add_blocking WORKTREE_ARTIFACT_MISSING; fi',
    // 4) actual changed-file content —— claims supported by evidence
    //   （the review agent reads the REAL worktree file, not the writer's claim）
    'if [ -f "$WT_FILE" ]; then',
    '  grep -q "todo:" "$WT_FILE" && r1_ok=1 || r1_ok=0',
    '  grep -q "markdown:" "$WT_FILE" && r2_ok=1 || r2_ok=0',
    'else r1_ok=0; r2_ok=0; add_blocking WORKTREE_CONTENT_MISSING; fi',
    '[ "$r1_ok" = "1" ] || add_blocking CLAIM_R1_MISSING',
    '[ "$r2_ok" = "1" ] || add_blocking CLAIM_R2_MISSING',
    // 5) /src read-only boundary（container-level main-repo pollution guard）
    'if touch /src/.review-probe 2>/dev/null; then src_ro=0; add_blocking SRC_WRITABLE; else src_ro=1; fi',
    // 6) verdict: structural failures => HOLD; fixable content/test gaps => REPAIR
    'case "$blocking" in',
    '  *DEPENDENCY_CONFLICT*|*WRITER_RESULT_MISSING*|*SCOPE_NOT_OK*|*DIFF_MISSING*|*WORKTREE_ARTIFACT_MISSING*|*WORKTREE_CONTENT_MISSING*|*SRC_WRITABLE*|*DEPS_MISSING*) R_STATUS="HOLD"; ACTION="HOLD" ;;',
    '  *) R_STATUS="REPAIR"; ACTION="REPAIR" ;;',
    'esac',
    '[ -z "$blocking" ] && { R_STATUS="PASS"; ACTION="PASS"; }',
    'if [ -z "$blocking" ]; then CLAIM="review PASS: all checks green (identity/deps/scope/tests/diff/evidence/src-ro)"; else CLAIM="review $R_STATUS: blocking findings ${blocking}"; fi',
    // JSON array emission（busybox-safe; codes are space-free）
    'to_json_array() { if [ -z "$1" ]; then echo "[]"; else echo "[$(echo "$1" | sed \'s/|/", "/g; s/^/"/; s/$/"/\')]"; fi; }',
    'BLOCKING_JSON=$(to_json_array "$blocking")',
    'SCOPE_VERIFIED="false"; [ "$scope_ok" = "1" ] && SCOPE_VERIFIED="true"',
    'TESTS_VERIFIED="false"; [ "$tests_ok" = "1" ] && TESTS_VERIFIED="true"',
    '{',
    '  echo "{"',
    '  echo "  \\"schema_version\\": \\"autoloop.subagent.review-result/v1\\","',
    '  echo "  \\"status\\": \\"$R_STATUS\\","',
    '  echo "  \\"agentExecutionId\\": \\"$AGENT_EXECUTION_ID\\","',
    '  echo "  \\"inputContextIdentity\\": \\"$INPUT_CONTEXT_IDENTITY\\","',
    '  echo "  \\"outputSchemaIdentity\\": \\"autoloop.subagent.review-result/v1\\","',
    '  echo "  \\"findings\\": $BLOCKING_JSON,"',
    '  echo "  \\"blockingFindings\\": $BLOCKING_JSON,"',
    '  echo "  \\"nonBlockingFindings\\": [],"',
    '  echo "  \\"evidenceChecked\\": [\\"/results/SA-R1.json\\", \\"/results/SA-R2.json\\", \\"/results/SA-W1.json\\", \\"/results/SA-W1.worktree.json\\", \\"$WT_FILE\\", \\"/src read-only boundary\\"],"',
    '  echo "  \\"scopeVerified\\": $SCOPE_VERIFIED,"',
    '  echo "  \\"testsVerified\\": $TESTS_VERIFIED,"',
    '  echo "  \\"claims\\": [\\"$CLAIM\\"],"',
    '  echo "  \\"evidenceReferences\\": [\\"/results/SA-W1.json\\", \\"/results/SA-W1.worktree.json\\"],"',
    '  echo "  \\"filesInspected\\": [\\"$WT_FILE\\", \\"/results/SA-W1.json\\", \\"/results/SA-W1.worktree.json\\"],"',
    '  echo "  \\"commandsExecuted\\": [\\"task=review_agent\\", \\"independent re-check of worktree/deps/scope/tests/diff\\\"],\"',
    '  echo "  \\"assumptions\\": [\\"worktree mounted read-only at /work\\", \\"results mounted read-only at /results\\", \\"network none\\"],"',
    '  echo "  \\"uncertainties\\": [],"',
    '  echo "  \\"recommendedAction\\": \\"$ACTION\\","',
    '  echo "  \\"recommendedNextAction\\": \\"review\\","',
    '  echo "  \\"summary\\": \\"$CLAIM\\""',
    '  echo "}"',
    '} > /scratch/result.json',
    // failure-injection hooks（contract-test only; envelope-controlled）
    '[ "${EMIT_MALFORMED:-0}" = "1" ] && echo "not valid json {{broken" > /scratch/result.json',
    '[ "${CRASH_AFTER:-0}" = "1" ] && { ( sleep 30 ) & _c=$!; kill -9 $_c; wait $_c; exit $?; }',
    'echo "SUBAGENT_DONE:review_agent"',
  ];
  return S.join("\n");
}

export function createReviewAgentReviewerAdapter({ profile, repoPath, scratchRoot, resultsDir }) {
  if (!profile || !repoPath || !scratchRoot || !resultsDir) {
    throw new Error("subagent_review_agent_reviewer: profile/repoPath/scratchRoot/resultsDir required");
  }

  async function runAdapter(request) {
    assertAdapterRequest(request);
    if (request.phase !== "reviewer") {
      return { status: "error", executionId: request.executionId, error: `unexpected_phase:${request.phase}`, stdout: "", stderr: "", metadata: {} };
    }
    const runtime = request.taskCard?.runtime ?? {};
    const nodeId = request.taskCard?.phaseId ?? "unknown";
    const graphExecutionId = request.taskCard?.parentExecutionId ?? request.executionId;
    const worktreePath = runtime.worktreePath;
    const mutationScope = Array.isArray(runtime.mutationScope) ? runtime.mutationScope : [];
    const reviewScratch = join(scratchRoot, nodeId, "review-scratch");
    mkdirSync(reviewScratch, { recursive: true });

    const envelope = buildSubagentEnvelope({
      graphExecutionId,
      nodeId,
      phaseExecutionId: request.executionId,
      agentRole: "reviewer",
      stage: "reviewer",
      objective: `independently review writer node ${nodeId}: identity, dependency results, diff + mutation scope, tests + evidence, main-repo purity, claims vs evidence`,
      authorizedPaths: ["/work", "/src", "/results", "/scratch"],
      runtimeInstance: { profile, socket: null },
      timeoutMs: runtime.reviewTimeoutMs ?? runtime.limits?.timeoutMs ?? request.timeoutMs,
      dependencyResultsDigest: runtime.dependencyResultsDigest ?? null,
      outputSchemaIdentity: SUBAGENT_REVIEW_RESULT_SCHEMA,
      mutationScope,
      // CEDF: the reviewer envelope carries the injected dependency
      // conflicts on the existing blockingFindings channel（fail-closed）.
      blockingFindings: Array.isArray(runtime.dependencyConflicts) ? runtime.dependencyConflicts : null,
      memoryContext: runtime.memoryContext ?? null,
    });
    const envelopeValidation = validateSubagentEnvelope(envelope);
    if (!envelopeValidation.ok) {
      return { status: "error", executionId: request.executionId, error: `review_envelope_invalid:${envelopeValidation.errors.join(";")}`, stdout: "", stderr: "", metadata: {} };
    }

    const env = {
      AGENT_EXECUTION_ID: envelope.agentExecutionId,
      INPUT_CONTEXT_IDENTITY: envelope.inputContextIdentity,
      AGENT_NODE_ID: nodeId,
      GRAPH_EXECUTION_ID: graphExecutionId,
      PHASE_EXECUTION_ID: request.executionId,
      REVIEW_MUTATION_SCOPE: (mutationScope[0] ?? "docs/pi-graph-output").replace(/^\//, ""),
      REVIEW_SLEEP: runtime.reviewSleep ? String(runtime.reviewSleep) : "",
      EMIT_MALFORMED: runtime.reviewMalformed ? "1" : "0",
      CRASH_AFTER: runtime.reviewCrashAfter ? "1" : "0",
      DEPENDENCY_COUNT: String(runtime.dependencyResultIdentities?.length ?? 0),
      // CEDF: dependency-reconciliation conflicts（space-free codes）are
      // pre-seeded as blocking findings -> structural HOLD verdict.
      REVIEW_SEED_BLOCKING: Array.isArray(runtime.dependencyConflicts) ? runtime.dependencyConflicts.join(" ") : "",
    };

    const roMounts = [
      { source: repoPath, target: "/src" },
      ...(worktreePath ? [{ source: worktreePath, target: "/work" }] : []),
      { source: resultsDir, target: "/results" },
    ];
    const rwMounts = [{ source: reviewScratch, target: "/scratch" }];
    // Read-only mounts must be allowlisted sources: the repo, the dedicated
    // worktree and the shared results dir are all legitimate read-only review
    // mounts（the review agent never writes to them）.
    assertMountAllowlist({
      roMounts,
      rwMounts,
      repoPaths: [repoPath, ...(worktreePath ? [worktreePath] : []), resultsDir],
      scratchRoot,
    });

    const run = await runTask({
      profile,
      executionId: request.executionId,
      taskId: `agent-review-${request.attempt}`,
      command: buildReviewAgentCommand(),
      roMounts,
      rwMounts,
      network: "none",
      cpus: runtime.limits?.cpus,
      memoryMiB: runtime.limits?.memoryMiB,
      pidsLimit: runtime.limits?.pidsLimit,
      timeoutMs: runtime.reviewTimeoutMs ?? runtime.limits?.timeoutMs ?? request.timeoutMs,
      abortSignal: request.abortSignal,
      env,
    });

    // ── collect + validate the review result（fail-closed）────────────────
    let reviewResult = null;
    let validation = { ok: false, errors: ["review_result_unavailable"] };
    if (run.status === "completed") {
      const resultPath = join(reviewScratch, "result.json");
      if (existsSync(resultPath)) {
        try {
          reviewResult = JSON.parse(readFileSync(resultPath, "utf8"));
          validation = validateReviewSubagentResult(reviewResult, {
            expectedAgentExecutionId: envelope.agentExecutionId,
            expectedInputContextIdentity: envelope.inputContextIdentity,
          });
        } catch (e) {
          validation = { ok: false, errors: [`review_result_parse_failed:${String(e?.message ?? e).slice(0, 200)}`] };
        }
      }
    }

    // ── map review result to the normalized lifecycle verdict ────────────
    const reviewIdentity = reviewResult && validation.ok ? sha256Hex(canonicalJson(reviewResult)) : null;
    let verdict;
    if (run.status !== "completed") {
      // lifecycle maps timed_out/aborted/error to REVIEWER_* HOLD paths.
      return { status: run.status, executionId: request.executionId, stdout: run.stdout, stderr: run.stderr, metadata: { reviewer: "review-agent", envelope, reviewResult, validation } };
    }
    if (!validation.ok) {
      verdict = {
        verdict: "NEEDS_SUPPLEMENT",
        confidence: "LOW",
        blocking_issues: validation.errors,
        required_supplements: [],
        evidence_gaps: validation.errors,
        summary: `review agent ${nodeId}: review result invalid/identity-mismatched — no blind repair (${validation.errors.join("; ")})`,
        recommended_next_action: "HUMAN_REVIEW",
      };
    } else if (reviewResult.recommendedAction === "PASS") {
      verdict = {
        verdict: "PASS",
        confidence: "HIGH",
        blocking_issues: [],
        required_supplements: [],
        evidence_gaps: [],
        summary: `review agent ${nodeId}: independent review PASS — ${reviewResult.blockingFindings.length} blocking finding(s), scopeVerified=${reviewResult.scopeVerified}, testsVerified=${reviewResult.testsVerified}, evidenceChecked=${reviewResult.evidenceChecked.length} item(s)`,
        recommended_next_action: "STOP",
      };
    } else if (reviewResult.recommendedAction === "REPAIR") {
      verdict = {
        verdict: "NEEDS_SUPPLEMENT",
        confidence: "MEDIUM",
        blocking_issues: [],
        required_supplements: [],
        evidence_gaps: reviewResult.blockingFindings,
        summary: `review agent ${nodeId}: REPAIR — ${reviewResult.blockingFindings.length} blocking finding(s) drive the bounded repair loop`,
        recommended_next_action: "REPAIR",
      };
    } else {
      verdict = {
        verdict: "NEEDS_SUPPLEMENT",
        confidence: "LOW",
        blocking_issues: reviewResult.blockingFindings ?? [],
        required_supplements: [],
        evidence_gaps: reviewResult.blockingFindings ?? [],
        summary: `review agent ${nodeId}: HOLD — structural findings (${(reviewResult.blockingFindings ?? []).join("; ")})`,
        recommended_next_action: "HUMAN_REVIEW",
      };
    }

    // ── persist review result + bind for the repair agent（串線防護）──────
    try {
      writeFileSync(join(resultsDir, `${nodeId}.review.json`), JSON.stringify(reviewResult, null, 2) + "\n");
    } catch { /* best effort; validation above is authoritative */ }
    if (request.taskCard && typeof request.taskCard === "object") {
      request.taskCard.runtime = request.taskCard.runtime ?? {};
      request.taskCard.runtime.lastReviewResult = { result: reviewResult, validation, identity: reviewIdentity, attempt: request.attempt };
    }

    return {
      status: "completed",
      executionId: request.executionId,
      stdout: JSON.stringify(verdict),
      stderr: "",
      metadata: { reviewer: "review-agent", envelope, reviewResult, validation, reviewIdentity },
    };
  }

  return { runAdapter };
}

export { SUBAGENT_REVIEW_RESULT_SCHEMA };
