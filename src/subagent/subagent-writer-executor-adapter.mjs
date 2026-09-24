// src/subagent/subagent-writer-executor-adapter.mjs
//
// Writer sub-agent executor adapter（adapter/contract.mjs `runAdapter`）.
//
// Launches a REAL writer sub-agent process inside an isolated Colima
// container bound to a DEDICATED git worktree:
//   - source repo mounted read-only at /src
//   - the phase's dedicated worktree mounted read-write at /work
//     （the ONLY writable repo location; the main repo is never touched）
//   - private scratch rw at /scratch; shared graph results rw at /results
//   - network none, --cap-drop ALL, no-new-privileges, limits; runtime socket
//     never mounted
//   - the agent receives its minimal context envelope via container env
//     （objective + identities + task type + base commit + mutation scope +
//     dependency result identities + repair budget — never full history）
//   - the agent writes its STRUCTURED writer result
//     （autoloop.subagent.writer-result/v1）to /scratch/result.json with
//     filesChanged / testResults / status（PASS | REPAIR）
//   - the executor collects the result and fail-closes on EVERY writer
//     contract violation: unparseable result, identity mismatch, worktree
//     identity mismatch, out-of-mutation-scope writes, undeclared files,
//     empty diff（writer changed nothing）, missing test results, main-repo
//     pollution
//   - the host fills the AUTHORITATIVE diffSummary + scopeVerification from
//     the real worktree git state（the agent's self-report is never trusted）.
//
// The single-writer guarantee comes from the sealed scheduler's
// ArtifactWriterLease（runner.mjs）— this adapter never repairs in-process
// and never commits / pushes / seals.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertAdapterRequest } from "../adapter/contract.mjs";
import { runTask, assertMountAllowlist } from "../runtime/colima-runtime.mjs";
import { captureChangedPaths } from "../shared/git-diff-utils.mjs";
import { captureWorktreeOutput } from "../runtime/colima-worktree.mjs";
import {
  buildSubagentEnvelope,
  validateSubagentEnvelope,
  validateWriterSubagentResult,
  canonicalJson,
  sha256Hex,
  SUBAGENT_WRITER_RESULT_SCHEMA,
  TOOL_PERMISSIONS,
} from "./subagent-contract.mjs";
import { canonicalScopeEntry, canonicalScopeEntries, isWithinCanonicalScope } from "../c2d/mutation-scope.mjs";
import { verifyWriteContainment } from "../c2d/write-containment.mjs";

export class SubagentWriterExecutorError extends Error {
  constructor(reason, details) {
    super(`subagent_writer_executor_adapter: ${reason}`);
    this.name = "SubagentWriterExecutorError";
    this.reason = reason;
    this.details = details;
  }
}

/**
 * Host-observed writer scope decision — the AUTHORITATIVE replacement for the
 * agent's self-reported one, over two independent sources:
 *
 *  1. git's changed-path inventory (`hostChangedPaths`), canonicalized with the
 *     shared seam（`canonicalScopeEntry` / `isWithinCanonicalScope`）; and
 *  2. the git-INDEPENDENT write-containment scan of the materialized worktree
 *     (`verifyWriteContainment`) — a write THROUGH a pre-existing symlink leaves
 *     no repo-relative changed path at all, so source 1 cannot see it.
 *
 * Containment can only add violations; it never authorizes a path source 1
 * refused. Exported so the decision is testable without a sandbox runtime.
 */
export function hostObservedScopeViolations({ worktreePath, mutationScope = [], hostChangedPaths = [] }) {
  const scopeSet = canonicalScopeEntries(mutationScope, worktreePath);
  const containment = verifyWriteContainment({ root: worktreePath, boundaries: mutationScope });
  return [
    ...hostChangedPaths.filter((p) => {
      const canonical = canonicalScopeEntry(p, worktreePath);
      return canonical === null || scopeSet === null || !isWithinCanonicalScope(canonical, scopeSet);
    }),
    ...containment.violations.map((v) => `${v.path ?? "<worktree>"} (${v.reason})`),
  ];
}

/**
 * The writer agent program（busybox-sh; runs INSIDE the alpine container）.
 * Performs a bounded writer task inside /work（the dedicated worktree）under
 * the mutation-scope relative path, runs its own tests, and emits the
 * structured WRITER result JSON to /scratch/result.json. The agent has no
 * git binary — the diff/scope facts are host-computed; the agent reports its
 * own filesChanged + testResults + status（PASS/REPAIR）.
 *
 * taskType:
 *   write_report          — read dependency results from /results, write
 *                           $SCOPE/summary.md containing both dependency
 *                           claims; self-test = file contains both claims;
 *                           PASS iff test passes
 *   write_report_repair   — attempt 0 writes content missing one dependency
 *                           claim（self-test fails → REPAIR）; attempt >= 1
 *                           writes complete content（self-test passes → PASS）
 *   write_report_fail     — always writes content missing a claim（self-test
 *                           always fails）; used for repair-budget exhaustion
 *   verify_writer         — read-only verifier task（checks /results/SA-W1.*
 *                           artifacts independently）
 *
 * Envelope-controlled failure injections（contract-test only）:
 *   WRITER_SCOPE_VIOLATION=1 — additionally write a file OUTSIDE the
 *                           mutation scope（inside /work）
 *   EMIT_MALFORMED=1        — overwrite result.json with invalid JSON
 *   CRASH_AFTER=1           — SIGKILL a worker and exit abnormally
 *   AGENT_SLEEP             — sleep N seconds（timeout injection）
 */
export function buildWriterAgentCommand(taskType) {
  const Q = '"'; // busybox-safe double quote
  const S = [
    "set -u",
    'mkdir -p /scratch',
    // WP1 parallel fan-in: the phase's OWN declared depends_on arrive as
    // the DEPENDENCY_FILES env var (injected by the adapter from the
    // taskCard). Normalize ONCE before every branch so the shared result
    // emission block always sees it (set -u: an unbound variable is fatal).
    'DEPENDENCY_FILES="${DEPENDENCY_FILES:-}"',
    'SCOPE="${WRITER_MUTATION_SCOPE:-docs/pi-graph-output}"',
    'WT_FILE="/work/$SCOPE/summary.md"',
    '[ -n "${AGENT_SLEEP:-}" ] && sleep "$AGENT_SLEEP"',
    'claim() { grep -A1 \'"claims"\' "$1" | tail -1 | sed \'s/^[[:space:]]*"//; s/",*$//\'; }',
    'W_STATUS="PASS"',
    'TEST_PASSED=0',
    'TEST_FAILED=0',
    'TEST_TOTAL=0',
    'CLAIM=""',
    `case "${taskType}" in`,
    "  write_report_with_gap)",
    '    mkdir -p "/work/$SCOPE"',
    '    R1_CLAIM=$(claim /results/SA-R1.json)',
    // Intentional evidence gap: the report omits the SA-R2/markdown claim.
    // The writer's own weak self-test only checks the todo line, so it
    // passes — the INDEPENDENT review agent must catch the gap.
    '    printf "analysis summary\\n\\n- todo: %s\\n" "$R1_CLAIM" > "$WT_FILE"',
    '    grep -q "todo:" "$WT_FILE" && TEST_PASSED=1 || TEST_FAILED=1',
    '    TEST_TOTAL=1',
    '    W_STATUS="PASS"',
    '    CLAIM="writer report written with incomplete evidence (SA-R2 markdown claim omitted); weak self-test passed"',
    '    ;;',
    "  write_report|write_report_repair|write_report_fail)",
    '    mkdir -p "/work/$SCOPE"',
    // WP1 parallel fan-in: consume EVERY declared dependency result — the
    // report incorporates one claim line per dependency and the self-test
    // fails unless ALL of them are present. The dependency list is the
    // phase's own declared depends_on (host-projected into
    // DEPENDENCY_FILES), never agent-invented: a missing required child
    // yields an empty claim line and the self-test fails (fail closed).
    '    DEP_FILES="${DEPENDENCY_FILES:-}"',
    '    CLAIM_LINES=""',
    '    DEP_INDEX=0',
    '    for _df in $DEP_FILES; do',
    '      DEP_INDEX=$((DEP_INDEX + 1))',
    '      _claim=$(claim "/results/$_df.json" 2>/dev/null || true)',
    '      if [ -n "$_claim" ]; then CLAIM_LINES="${CLAIM_LINES}- dep${DEP_INDEX} (${_df}): ${_claim}\\n"; fi',
    '    done',
    '    FAIL_INTENT=0',
    `    case "${taskType}" in`,
    "      write_report_fail) FAIL_INTENT=1 ;;",
    '      write_report_repair) [ "${REPAIR_ATTEMPT:-0}" -lt "1" ] && FAIL_INTENT=1 ;;',
    "    esac",
    '    if [ "$FAIL_INTENT" = "1" ]; then',
    '      printf "analysis summary\\n\\n- todo: only\\n" > "$WT_FILE"',
    '    else',
    '      printf "analysis summary\\n\\n${CLAIM_LINES}" > "$WT_FILE"',
    '    fi',
    '    _expected=0; for _df in $DEP_FILES; do _expected=$((_expected + 1)); done',
    'grep -c "^- dep" "$WT_FILE" >/scratch/.depcnt 2>/dev/null || true',

    'read -r _written < /scratch/.depcnt 2>/dev/null || _written=0',
    '    if [ "$_expected" -gt 0 ]; then if [ "$_written" -eq "$_expected" ]; then TEST_PASSED=1; else TEST_FAILED=1; fi; else [ -s "$WT_FILE" ] && TEST_PASSED=1 || TEST_FAILED=1; fi',
    '    TEST_TOTAL=1',
    '    if [ "$FAIL_INTENT" = "1" ]; then',
    '      W_STATUS="REPAIR"',
    '      CLAIM="writer report written but self-test failed (missing dependency claims); repair required"',
    '    else',
    '      W_STATUS="PASS"',
    '      CLAIM="writer report written under $SCOPE/summary.md incorporating ALL ${_expected} dependency claims; self-test passed"',
    '    fi',
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
    '    if [ "$DEPS_OK" = "1" ] && [ "$W_RESULT_OK" = "1" ] && [ "$W_WT_OK" = "1" ] && [ "$SCOPE_OK" = "1" ] && [ "$TESTS_OK" = "1" ] && [ "$DIFF_OK" = "1" ]; then',
    '      W_STATUS="PASS"',
    '      CLAIM="writer SA-W1 independently verified: deps present, structured result PASS, scope ok, tests 0 failed, diff present"',
    '    else',
    '      W_STATUS="REPAIR"',
    '      CLAIM="writer SA-W1 verification FAILED (deps=$DEPS_OK result=$W_RESULT_OK worktree=$W_WT_OK scope=$SCOPE_OK tests=$TESTS_OK diff=$DIFF_OK)"',
    '    fi',
    '    TEST_TOTAL=1',
    '    [ "$W_STATUS" = "PASS" ] && TEST_PASSED=1 || TEST_FAILED=1',
    '    ;;',
    "  *)",
    '    W_STATUS="REPAIR"',
    '    CLAIM="objective executed: ${AGENT_OBJECTIVE}"',
    '    TEST_TOTAL=1',
    '    TEST_FAILED=1',
    '    ;;',
    "esac",
    // scope-violation injection（contract-test only; envelope-controlled）
    '[ "${WRITER_SCOPE_VIOLATION:-0}" = "1" ] && { mkdir -p /work/docs/outside-boundary; echo "forbidden" > /work/docs/outside-boundary/leak.txt; }',
    // structured writer result emission（JSON array construction, minimal escaping）
    "{",
    '  echo "{"',
    '  echo "  \\"schema_version\\": \\"autoloop.subagent.writer-result/v1\\","',
    '  echo "  \\"status\\": \\"$W_STATUS\\","',
    '  echo "  \\"agentExecutionId\\": \\"$AGENT_EXECUTION_ID\\","',
    '  echo "  \\"inputContextIdentity\\": \\"$INPUT_CONTEXT_IDENTITY\\","',
    '  echo "  \\"outputSchemaIdentity\\": \\"autoloop.subagent.writer-result/v1\\","',
    '  echo "  \\"filesChanged\\": [\\"$SCOPE/summary.md\\"],"',
    '  echo "  \\"diffSummary\\": \\"\\","',
    '  echo "  \\"scopeVerification\\": {\\"ok\\": false, \\"violations\\": []},"',
    '  echo "  \\"testsExecuted\\": [\\"dependency claims present in report\\", \\"self-test grep markdown claim\\"],"',
    '  echo "  \\"testResults\\": {\\"passed\\": $TEST_PASSED, \\"failed\\": $TEST_FAILED, \\"total\\": $TEST_TOTAL},"',
    '  echo "  \\"claims\\": [\\"$CLAIM\\"],"',
    '  _EV_REFS=""',
    '  for _df in $DEPENDENCY_FILES; do _EV_REFS="${_EV_REFS}\\"/results/$_df.json\\", "; done',
    '  echo "  \\"evidenceReferences\\": [${_EV_REFS%, }],"',
    '  echo "  \\"filesInspected\\": [${_EV_REFS%, }],"',
    '  echo "  \\"commandsExecuted\\": [\\"task=${AGENT_TASK_TYPE}\\", \\"write under /work mutation scope\\", \\"self-test\\"],"',
    '  echo "  \\"assumptions\\": [\\"worktree mounted rw at /work\\", \\"repo mounted read-only at /src\\", \\"network none\\"],"',
    '  echo "  \\"uncertainties\\": [],"',
    '  echo "  \\"recommendedNextAction\\": \\"review\\","',
    '  echo "  \\"summary\\": \\"$CLAIM\\","',
    '  echo "  \\"worktreeIdentity\\": {\\"head\\": \\"$BASE_COMMIT\\", \\"baseCommit\\": \\"$BASE_COMMIT\\"}"',
    '  echo "}"',
    "} > /scratch/result.json",
    // failure-injection hooks（contract-test only; envelope-controlled）
    '[ "${EMIT_MALFORMED:-0}" = "1" ] && echo "not valid json {{broken" > /scratch/result.json',
    '[ "${CRASH_AFTER:-0}" = "1" ] && { ( sleep 30 ) & _c=$!; kill -9 $_c; wait $_c; exit $?; }',
    'echo "SUBAGENT_DONE:${AGENT_TASK_TYPE}"',
  ];
  return S.join("\n");
}

function gitHead(repoPath) {
  const r = spawnSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The REPAIR agent program（busybox-sh; runs INSIDE the alpine container on
 * the SAME dedicated worktree）. It runs ONLY after a review agent returned
 * REPAIR with explicit blocking findings, and it must:
 *   - reuse the same graphExecutionId / node / worktree identity
 *   - respond to the bound blocking findings（REVIEW_FINDINGS_IDENTITY +
 *     BLOCKING_FINDINGS env carry the exact review it answers）
 *   - stay inside the original mutation scope（$SCOPE）
 *   - re-run its own tests and emit a WRITER-schema result that echoes the
 *     review findings identity（cross-wiring protection）
 *
 * repairTaskType:
 *   repair_report        — rewrite the report incorporating BOTH dependency
 *                          claims（fixes the review's evidence-gap finding）
 *   repair_report_fail   — rewrite but STILL omit the markdown claim（the
 *                          fix does not work; re-review keeps failing）
 * Envelope-controlled injections: REPAIR_SCOPE_VIOLATION=1 writes a file
 * outside the mutation scope（contract-test only）.
 */
export function buildRepairAgentCommand(taskType) {
  const S = [
    'set -u',
    'mkdir -p /scratch',
    'SCOPE="${WRITER_MUTATION_SCOPE:-docs/pi-graph-output}"',
    'WT_FILE="/work/$SCOPE/summary.md"',
    '[ -n "${AGENT_SLEEP:-}" ] && sleep "$AGENT_SLEEP"',
    'claim() { grep -A1 \'"claims"\' "$1" | tail -1 | sed \'s/^[[:space:]]*"//; s/",*$//\'; }',
    'W_STATUS="PASS"',
    'TEST_PASSED=0',
    'TEST_FAILED=0',
    'TEST_TOTAL=0',
    'CLAIM=""',
    `case "${taskType}" in`,
    '  repair_report|repair_report_fail)',
    '    mkdir -p "/work/$SCOPE"',
    '    FAIL_INTENT=0',
    `case "${taskType}" in`,
    '      repair_report_fail) FAIL_INTENT=1 ;;',
    '    esac',
    '    DEP_FILES="${DEPENDENCY_FILES:-}"',
    '    CLAIM_LINES=""',
    '    DEP_INDEX=0',
    '    for _df in $DEP_FILES; do',
    '      DEP_INDEX=$((DEP_INDEX + 1))',
    '      _claim=$(claim "/results/$_df.json" 2>/dev/null || true)',
    '      if [ -n "$_claim" ]; then CLAIM_LINES="${CLAIM_LINES}- dep${DEP_INDEX} (${_df}): ${_claim}\\n"; fi',
    '    done',
    '    if [ "$FAIL_INTENT" = "1" ]; then',
    '      printf "analysis summary\\n\\n- todo: only\\n" > "$WT_FILE"',
    '    else',
    '      printf "analysis summary\\n\\n${CLAIM_LINES}" > "$WT_FILE"',
    '    fi',
    '    _expected=0; for _df in $DEP_FILES; do _expected=$((_expected + 1)); done',
    'grep -c "^- dep" "$WT_FILE" >/scratch/.depcnt 2>/dev/null || true',

    'read -r _written < /scratch/.depcnt 2>/dev/null || _written=0',
    '    if [ "$_expected" -gt 0 ]; then if [ "$_written" -eq "$_expected" ]; then TEST_PASSED=1; else TEST_FAILED=1; fi; else [ -s "$WT_FILE" ] && TEST_PASSED=1 || TEST_FAILED=1; fi',
    '    TEST_TOTAL=1',
    '    if [ "$FAIL_INTENT" = "1" ]; then',
    '      W_STATUS="REPAIR"',
    '      CLAIM="repair attempt did NOT fix the evidence gap (dependency claims still missing); responding to blocking findings"',
    '    else',
    '      W_STATUS="PASS"',
    '      CLAIM="repair agent fixed the report under $SCOPE/summary.md incorporating ALL ${_expected} dependency claims; self-test passed"',
    '    fi',
    '    ;;',
    '  *)',
    '    W_STATUS="REPAIR"',
    '    CLAIM="repair objective executed: ${AGENT_OBJECTIVE}"',
    '    TEST_TOTAL=1',
    '    TEST_FAILED=1',
    '    ;;',
    'esac',
    '[ "${REPAIR_SCOPE_VIOLATION:-0}" = "1" ] && { mkdir -p /work/docs/outside-boundary; echo "forbidden" > /work/docs/outside-boundary/leak.txt; }',
    "{",
    '  echo "{"',
    '  echo "  \\"schema_version\\": \\"autoloop.subagent.writer-result/v1\\","',
    '  echo "  \\"status\\": \\"$W_STATUS\\","',
    '  echo "  \\"agentExecutionId\\": \\"$AGENT_EXECUTION_ID\\","',
    '  echo "  \\"inputContextIdentity\\": \\"$INPUT_CONTEXT_IDENTITY\\","',
    '  echo "  \\"outputSchemaIdentity\\": \\"autoloop.subagent.writer-result/v1\\","',
    '  echo "  \\"filesChanged\\": [\\"$SCOPE/summary.md\\"],"',
    '  echo "  \\"diffSummary\\": \\"\\","',
    '  echo "  \\"scopeVerification\\": {\\"ok\\": false, \\"violations\\": []},"',
    '  echo "  \\"testsExecuted\\": [\\"dependency claims present in report\\", \\"self-test grep markdown claim\\"],"',
    '  echo "  \\"testResults\\": {\\"passed\\": $TEST_PASSED, \\"failed\\": $TEST_FAILED, \\"total\\": $TEST_TOTAL},"',
    '  echo "  \\"claims\\": [\\"$CLAIM\\"],"',
    '  _EV_REFS=""',
    '  for _df in $DEPENDENCY_FILES; do _EV_REFS="${_EV_REFS}\\"/results/$_df.json\\", "; done',
    '  echo "  \\"evidenceReferences\\": [${_EV_REFS%, }],"',
    '  echo "  \\"filesInspected\\": [${_EV_REFS%, }],"',
    '  echo "  \\"commandsExecuted\\": [\\"task=${AGENT_TASK_TYPE}\\\", \\"repair under /work mutation scope\\", \\"self-test\\"],"',
    '  echo "  \\"assumptions\\": [\\"worktree mounted rw at /work\\", \\"repo mounted read-only at /src\\", \\"network none\\"],"',
    '  echo "  \\"uncertainties\\": [],"',
    '  echo "  \\"recommendedNextAction\\": \\"review\\","',
    '  echo "  \\"summary\\": \\"$CLAIM\\","',
    '  echo "  \\"worktreeIdentity\\": {\\"head\\": \\"$BASE_COMMIT\\", \\"baseCommit\\": \\"$BASE_COMMIT\\"},"',
    '  echo "  \\"reviewFindingsIdentity\\": \\"$REVIEW_FINDINGS_IDENTITY\\","',
    '  echo "  \\"blockingFindings\\": ${BLOCKING_FINDINGS:-[]}"',
    '  echo "}"',
    "} > /scratch/result.json",
    '[ "${EMIT_MALFORMED:-0}" = "1" ] && echo "not valid json {{broken" > /scratch/result.json',
    '[ "${CRASH_AFTER:-0}" = "1" ] && { ( sleep 30 ) & _c=$!; kill -9 $_c; wait $_c; exit $?; }',
    'echo "SUBAGENT_DONE:${AGENT_TASK_TYPE}"',
  ];
  return S.join("\n");
}
export function createSubagentWriterExecutorAdapter({ profile, repoPath, scratchRoot, resultsDir, resultSink, maxRepairAttempts = 1 }) {
  if (!profile || !repoPath || !scratchRoot || !resultsDir) {
    throw new SubagentWriterExecutorError("profile/repoPath/scratchRoot/resultsDir required");
  }
  const repoHeadAtStart = gitHead(repoPath);

  async function runAdapter(request) {
    assertAdapterRequest(request);
    if (request.phase !== "executor") {
      return { status: "error", executionId: request.executionId, error: `unexpected_phase:${request.phase}`, stdout: "", stderr: "", metadata: {} };
    }
    const runtime = request.taskCard?.runtime ?? {};
    const taskType = runtime.taskType ?? "write_report";
    const objective = runtime.objective ?? `writer ${taskType} over /work`;

    // TA-2（L; NEG3）: a writer under an admission that denies the writer
    // capability（or a phase boundary outside admission.mutation_scope）never
    // runs — the envelope projection records the violation at phase start.
    if (runtime.admissionViolation) {
      return { status: "error", executionId: request.executionId, error: `${runtime.admissionViolation.code}:${runtime.admissionViolation.message}`, stdout: "", stderr: "", metadata: { mode: "subagent-writer", admissionViolation: runtime.admissionViolation } };
    }

    const worktreePath = runtime.worktreePath;
    if (!worktreePath) {
      return { status: "error", executionId: request.executionId, error: "writer_subagent_requires_worktreePath", stdout: "", stderr: "", metadata: { mode: "subagent-writer" } };
    }
    const cloneDir = runtime.cloneDir;
    const head = gitHead(worktreePath);
    const baseCommit = head ?? runtime.worktreeVerified?.head ?? null;
    const mutationScope = Array.isArray(runtime.mutationScope) ? runtime.mutationScope : [];
    const attempt = request.attempt ?? 0;
    // Repair agent dispatch: attempt >= 1 runs ONLY after the review agent
    // returned REPAIR（lifecycle re-invokes the executor with attempt+1）.
    // If the phase declares a repairTaskType the repair agent runs its own
    // command; otherwise the legacy writer task re-runs（REPAIR_ATTEMPT）.
    const isRepair = attempt >= 1;
    const repairTaskType = runtime.repairTaskType ?? null;
    const review = request.taskCard?.runtime?.lastReviewResult ?? null;
    const reviewFindingsIdentity = isRepair && review?.result
      ? sha256Hex(canonicalJson(review.result))
      : null;
    // CEDF: dependency-reconciliation conflicts（injected by
    // subagent-graph-runner onPhaseStart）ride the EXISTING
    // blockingFindings channel — the reviewer sees them and HOLDs instead
    // of silently chaining a conflicted prerequisite. The repair attempt
    // keeps precedence over the review findings it is bound to.
    const blockingFindings = isRepair
      ? (Array.isArray(review?.result?.blockingFindings) ? review.result.blockingFindings : [])
      : Array.isArray(runtime.dependencyConflicts)
        ? runtime.dependencyConflicts
        : null;
    const repairBudget = { maxAttempts: maxRepairAttempts, remaining: Math.max(0, maxRepairAttempts - attempt) };
    const agentRole = isRepair ? "repairer" : "writer";

    const envelope = buildSubagentEnvelope({
      graphExecutionId: request.taskCard?.parentExecutionId ?? request.executionId,
      nodeId: request.taskCard?.phaseId ?? "unknown",
      phaseExecutionId: request.executionId,
      agentRole,
      stage: isRepair ? "repairer" : null,
      objective,
      authorizedPaths: runtime.authorizedPaths ?? ["/work", "/src", "/scratch", "/results"],
      runtimeInstance: { profile, socket: null },
      timeoutMs: runtime.limits?.timeoutMs ?? request.timeoutMs,
      dependencyResultsDigest: runtime.dependencyResultsDigest ?? null,
      outputSchemaIdentity: SUBAGENT_WRITER_RESULT_SCHEMA,
      worktreeIdentity: { worktreeDir: worktreePath, cloneDir: cloneDir ?? null, head: baseCommit },
      baseCommit,
      mutationScope,
      dependencyResultIdentities: runtime.dependencyResultIdentities ?? null,
      repairBudget,
      cancellationIdentity: request.abortSignal ? `signal-bound:${request.executionId}` : null,
      reviewFindingsIdentity,
      blockingFindings,
      // TA-2（K）: envelope tool permissions + admission binding come FROM the
      // admission projection（never agent-selected / scheduler-hardcoded）.
      toolPermissions: Array.isArray(runtime.toolPermissions) && runtime.toolPermissions.length ? runtime.toolPermissions : TOOL_PERMISSIONS.READ_ONLY,
      admissionId: runtime.admissionId ?? null,
      admissionDigest: runtime.admissionDigest ?? null,
    });
    const envelopeValidation = validateSubagentEnvelope(envelope);
    if (!envelopeValidation.ok) {
      return { status: "error", executionId: request.executionId, error: `subagent_envelope_invalid:${envelopeValidation.errors.join(";")}`, stdout: "", stderr: "", metadata: { mode: "subagent-writer" } };
    }

    const privateScratch = runtime.scratchPath ?? join(scratchRoot, request.taskCard?.phaseId ?? "writer", "scratch");
    mkdirSync(privateScratch, { recursive: true });
    const roMounts = [{ source: repoPath, target: "/src" }];
    const rwMounts = [
      { source: worktreePath, target: "/work" },
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
      BASE_COMMIT: baseCommit ?? "",
      WRITER_MUTATION_SCOPE: (mutationScope[0] ?? "docs/pi-graph-output").replace(/^\//, ""),
      REPAIR_ATTEMPT: String(attempt),
      // WP1 parallel fan-in: the phase's OWN declared depends_on, host-
      // projected — the writer consumes exactly these persisted results.
      DEPENDENCY_FILES: Array.isArray(request.taskCard?.dependsOn) ? request.taskCard.dependsOn.join(" ") : "",
      DEPENDENCY_RESULT_IDENTITIES: runtime.dependencyResultIdentities ? JSON.stringify(runtime.dependencyResultIdentities) : "",
      EMIT_MALFORMED: runtime.emitMalformed ? "1" : "0",
      CRASH_AFTER: runtime.crashAfter ? "1" : "0",
      WRITER_SCOPE_VIOLATION: runtime.scopeViolation ? "1" : "0",
      REVIEW_FINDINGS_IDENTITY: reviewFindingsIdentity ?? "",
      BLOCKING_FINDINGS: blockingFindings ? JSON.stringify(blockingFindings) : "[]",
      REPAIR_SCOPE_VIOLATION: runtime.repairScopeViolation ? "1" : "0",
    };

    const run = await runTask({
      profile,
      executionId: request.executionId,
      taskId: `agent-${isRepair ? "repair" : "writer"}-${request.attempt}`,
      command: isRepair && repairTaskType ? buildRepairAgentCommand(repairTaskType) : buildWriterAgentCommand(taskType),
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

    // ── Host-side writer validation（fail-closed）────────────────────────
    let subagentResult = null;
    let validation = { ok: false, errors: ["result_unavailable"] };
    let hostChangedPaths = [];
    let repoHeadClean = true;
    let diffSummary = "";
    if (run.status === "completed") {
      const resultPath = join(privateScratch, "result.json");
      let parsed = null;
      if (existsSync(resultPath)) {
        try {
          parsed = JSON.parse(readFileSync(resultPath, "utf8"));
        } catch (e) {
          validation = { ok: false, errors: [`result_parse_failed:${String(e?.message ?? e).slice(0, 200)}`] };
        }
      }
      if (parsed) {
        // Host-observed worktree facts（authoritative）.
        try {
          hostChangedPaths = [...captureChangedPaths(worktreePath).paths];
        } catch {
          hostChangedPaths = [];
        }
        const diffRun = spawnSync("git", ["-C", worktreePath, "diff", "HEAD", "--stat"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
        diffSummary = diffRun.status === 0 ? diffRun.stdout.trim().slice(0, 4 * 1024) : "";
        // Untracked files are not part of `git diff HEAD`; make the summary
        // reviewable（the worktree capture records untracked content）.
        if (!diffSummary && hostChangedPaths.length > 0) {
          const untrackedRun = spawnSync("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" });
          if (untrackedRun.status === 0 && untrackedRun.stdout.trim()) {
            diffSummary = `new file(s): ${untrackedRun.stdout.trim().split("\n").join(", ")}`;
          }
        }
        // Host-observed scope decision — CANONICAL semantics, the same rules
        // the enforcement gate applies（c2d/mutation-scope.mjs）: a changed path
        // that does not canonicalize（absolute / traversal / non-normalized /
        // symlink-adjacent）and a declared scope that does not canonicalize are
        // both violations, never passes.
        const scopeViolations = hostObservedScopeViolations({ worktreePath, mutationScope, hostChangedPaths });
        repoHeadClean = gitHead(repoPath) === repoHeadAtStart;
        subagentResult = {
          ...parsed,
          diffSummary: diffSummary || parsed.diffSummary || "",
          scopeVerification: { ok: scopeViolations.length === 0, violations: scopeViolations },
        };
        validation = validateWriterSubagentResult(subagentResult, {
          expectedAgentExecutionId: envelope.agentExecutionId,
          expectedInputContextIdentity: envelope.inputContextIdentity,
          expectedBaseCommit: baseCommit,
          // The review-findings echo is enforced ONLY for the dedicated repair
          // agent（repairTaskType）; the legacy self-test-driven repair path
          // re-runs the writer command which does not emit the echo.
          expectedReviewFindingsIdentity: isRepair && repairTaskType ? reviewFindingsIdentity : undefined,
          mutationScope,
          hostChangedPaths,
          repoHeadClean,
          repositoryRoot: worktreePath,
        });
      }
    }

    // ── Mid-lifecycle persistence（the INDEPENDENT review agent reads these
    //    BEFORE the reviewer stage）: the validated writer/repair result and
    //    the captured worktree state（diff/untracked/scope/head/purity）.
    const nodeId = request.taskCard?.phaseId ?? "unknown";
    if (run.status === "completed" && validation.ok && subagentResult) {
      try {
        writeFileSync(join(resultsDir, `${nodeId}.json`), JSON.stringify(subagentResult, null, 2) + "\n");
        const capture = captureWorktreeOutput({ worktreeDir: worktreePath, cloneDir: cloneDir ?? worktreePath });
        writeFileSync(
          join(resultsDir, `${nodeId}.worktree.json`),
          JSON.stringify({ ...capture, mutationScope, head: baseCommit, verified: true, repoHeadClean }, null, 2) + "\n",
        );
      } catch (e) {
        validation = { ok: false, errors: [`midlifecycle_persistence_failed:${String(e?.message ?? e).slice(0, 200)}`] };
      }
    }

    if (process.env.WP1_DEBUG_WRITER && run.status !== "completed") console.error(`WRITER_DEBUG ${nodeId}: run.status=${run.status} stderr=${String(run.stderr ?? "").slice(-300)}`);
    const result = {
      status: run.status,
      executionId: request.executionId,
      stdout: run.stdout,
      stderr: run.stderr,
      metadata: {
        ...(run.metadata ?? {}),
        mode: "subagent-writer",
        worktreePath,
        mutationScope,
        subagent: { envelope, result: subagentResult, validation, hostChangedPaths },
      },
    };
    // fail-closed: any writer contract violation must NOT pass.
    if (run.status === "completed" && !validation.ok) {
      result.status = "error";
      result.error = `subagent_writer_result_invalid:${validation.errors.join(";")}`;
      if (process.env.WP1_DEBUG_WRITER) console.error(`WRITER_DEBUG ${nodeId}: ${result.error}; raw=${String(readFileSync(join(privateScratch, "result.json"), "utf8")).slice(0, 400)}`);
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

export { SUBAGENT_WRITER_RESULT_SCHEMA };
