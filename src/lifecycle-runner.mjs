// lifecycle-runner.mjs
//
// Minimal, provider-neutral unified lifecycle runner: Task Card -> executor
// adapter -> normalized adapter result -> AutoLoop core validation ->
// reviewer adapter -> reviewer verdict -> PASS / REPAIR / HOLD.
//
// This module owns lifecycle sequencing and fail-closed judgment. It never
// delegates PASS/HOLD authority to the adapter: adapter results are only
// ever "well-formed" or not (see adapter/contract.mjs); every substantive
// judgment (evidence validity, mutation scope, reviewer verdict shape,
// repair-budget exhaustion) is made here, against existing AutoLoop schemas
// and gates, not invented in parallel.
//
// REPAIR is an in-loop transition, never a final state: runLifecycle()
// always resolves to exactly one of { PASS, HOLD }.

import { randomUUID } from "node:crypto";
import { AdapterContractError } from "./adapter/contract.mjs";
import { ScriptedAdapterSequenceError } from "./adapter/scripted-adapter.mjs";
import { captureScopeSnapshot, enforceScopeGate } from "./c2d/mutation-scope.mjs";
import { buildReviewEvidenceBundle } from "./v2/review-evidence.mjs";
import { buildSystemObservedDelta, SYSTEM_DELTA_ERRORS } from "./v2/system-delta.mjs";
import {
  buildExecutorOutputDiagnostic,
  buildHarnessOwnedEvidence,
  collectGitBaseline,
  runVerificationCommand,
} from "./v2/harness-evidence.mjs";
import { classifyHold } from "./hold-taxonomy.mjs";
import { normalize as normalizeReviewerVerdict, FAIL_CLOSED as REVIEWER_FAIL_CLOSED } from "./normalize-reviewer-json.mjs";
import { isValidLifecycleState } from "./governance/lifecycle-state.mjs";

// VCA-1 Phase 0C — the reviewer prompt (phase-response-contract.mjs
// sectionAuthority) already declares "You have NO tools and NO mutation
// authority... cannot inspect the repository yourself", but prior to this
// change that was prompt text only: callAdapter below passed the SAME
// taskCard.toolPolicy to both the executor and reviewer role, so a
// permissive executor toolPolicy silently also reached the reviewer
// invocation. The reviewer is a verification-only role by contract, so its
// tool policy is hard-pinned here — independent of taskCard.toolPolicy —
// closing a real HARD_TOOL_SURFACE gap between what the reviewer prompt
// claims and what the adapter actually granted.
const REVIEWER_TOOL_POLICY = Object.freeze({ mode: "no-tools" });

// Single reviewer-verdict authority: normalize-reviewer-json.mjs. It already
// enforces required fields, enum membership (including its own canonical
// recommended_next_action set), and the PASS-suppression business rule
// (PASS requires confidence HIGH and zero blocking_issues/evidence_gaps).
// This runner does not maintain a second, parallel shape check against
// schema/reviewer-verdict.schema.json -- two independent reviewer-verdict
// authorities is exactly the semantic-drift risk that let a PASS+LOW
// confidence verdict slip through a schema-only shape check.
//
// normalize() never throws and never returns "invalid" as a boolean; a
// structurally malformed input comes back as its FAIL_CLOSED shape with
// evidence_gaps[0] === REVIEWER_FAIL_CLOSED.evidence_gaps[0]
// ("reviewer_output_schema_invalid"). That marker is the only way to tell
// "malformed input" apart from "well-formed input that normalize()
// legitimately suppressed to HOLD" (e.g. PASS with LOW confidence) --
// the latter is a real, if unwelcome, reviewer verdict and must flow
// through as REVIEWER_HOLD, not be reported as malformed.
function isSchemaInvalidVerdict(verdict) {
  return Array.isArray(verdict.evidence_gaps) && verdict.evidence_gaps[0] === REVIEWER_FAIL_CLOSED.evidence_gaps[0];
}

function checkMutationScope(mutationScope) {
  const { repositoryRoot, baselineSnapshot, allowedPaths = [], forbiddenPaths = [] } = mutationScope;
  const currentSnapshot = captureScopeSnapshot(repositoryRoot);
  const gate = enforceScopeGate(repositoryRoot, baselineSnapshot, currentSnapshot, allowedPaths, forbiddenPaths);
  // C4N: the full changed-path inventory（delta）is the system-observed
  // objective fact delivered to the reviewer in the evidence bundle.
  return { ok: gate.ok, violations: gate.violations, delta: gate.delta };
}

function parseJsonStrict(text) {
  try {
    return { ok: true, value: JSON.parse(text ?? "") };
  } catch (e) {
    // Keep the message string for the existing `detail` field（unchanged
    // shape）; also expose the error name so C4J diagnostics can record
    // parse_error.type（V8: "SyntaxError"）.
    return { ok: false, error: e.message, name: e.name };
  }
}

// ── C4J — bounded EXECUTOR_EVIDENCE_INVALID diagnostics ──────────────────
// When the executor final assistant text fails strict JSON parsing, bounded
// durable diagnostics are produced（final text ≤ 2 KiB, bounded stderr tail,
// parse error + adapter protocol counters）. The diagnostics NEVER change the
// verdict or reason: they are best-effort, carried only by the durable
// persistence path（secret-scanned, DURABLE_EVIDENCE_SECRET_RISK fail-closed）.
export const EXECUTOR_DIAGNOSTICS_LIMITS = Object.freeze({
  format_version: "1.0.0",
  max_final_text_bytes: 2 * 1024,   // C4J: bounded final assistant text cap
  max_stderr_tail_bytes: 4 * 1024,  // bounded stderr tail cap
  max_parse_message_chars: 2048,    // parse error message cap
});

function headBytes(text, maxBytes) {
  if (typeof text !== "string") return { value: String(text ?? ""), truncated: false, original_bytes: 0 };
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { value: text, truncated: false, original_bytes: buf.length };
  return { value: buf.subarray(0, maxBytes).toString("utf8"), truncated: true, original_bytes: buf.length };
}

function tailBytes(text, maxBytes) {
  if (typeof text !== "string") return { value: String(text ?? ""), truncated: false, original_bytes: 0 };
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { value: text, truncated: false, original_bytes: buf.length };
  return { value: buf.subarray(buf.length - maxBytes).toString("utf8"), truncated: true, original_bytes: buf.length };
}

function countLines(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  const newlines = text.match(/\n/g);
  const n = newlines ? newlines.length : 0;
  return text.endsWith("\n") ? n : n + 1;
}

/**
 * Build bounded executor diagnostics from the adapter result. stdout is the
 * model's final assistant text（delivered by pi-rpc-adapter via
 * get_last_assistant_text → response.data.text → adapter.stdout）; stderr is
 * the child's stderr buffer（kept separate — never mixed）. Pure,
 * deterministic, credential-safe（values are bounded here; the durable store
 * re-scans every string and fails closed on any secret pattern）.
 */
export function buildExecutorEvidenceDiagnostics(executorResult, parseError, limits = EXECUTOR_DIAGNOSTICS_LIMITS) {
  const stdout = executorResult?.stdout ?? "";
  const stderr = executorResult?.stderr ?? "";
  const metadata = executorResult?.metadata ?? {};
  const text = headBytes(stdout, limits.max_final_text_bytes);
  const tail = tailBytes(stderr, limits.max_stderr_tail_bytes);
  const eventCounts = metadata.protocolEventTypeCounts ?? {};
  const rawJsonlLines = Object.values(eventCounts).reduce((a, b) => a + (Number(b) || 0), 0);
  const firstContent = stdout.search(/\S/);
  return {
    format_version: limits.format_version,
    failure_code: "EXECUTOR_EVIDENCE_INVALID",
    final_assistant_text: {
      stored: text.value,
      original_length: text.original_bytes,
      stored_length: Buffer.byteLength(text.value, "utf8"),
      truncated: text.truncated,
      max_bytes: limits.max_final_text_bytes,
    },
    parse_error: {
      type: parseError?.name ?? null,
      message: typeof parseError?.message === "string" ? parseError.message.slice(0, limits.max_parse_message_chars) : null,
      position: null, // JSON.parse（V8）exposes no numeric offset
      first_non_whitespace_offset: firstContent >= 0 ? firstContent : null,
    },
    protocol: {
      rpc_completion_status: executorResult?.status ?? null,
      terminal_reason: metadata.terminalReason ?? null,
      assistant_message_count: eventCounts.message_end ?? 0,
      tool_call_count: metadata.toolCallCount ?? 0,
      raw_jsonl_line_count: rawJsonlLines,
      malformed_jsonl_count: 0, // any malformed wire line would have produced an error outcome instead of EXECUTOR_EVIDENCE_INVALID
      stderr_byte_count: tail.original_bytes,
      stderr_line_count: countLines(stderr),
      adapter_extraction_path: "pi-rpc-adapter get_last_assistant_text -> response.data.text -> adapter.stdout",
    },
    stderr_tail: {
      stored: tail.value,
      original_length: tail.original_bytes,
      stored_length: Buffer.byteLength(tail.value, "utf8"),
      truncated: tail.truncated,
      max_bytes: limits.max_stderr_tail_bytes,
    },
  };
}

export async function runLifecycle({
  cwd,
  taskCard,
  adapter,
  executorAdapter,
  reviewerAdapter,
  executorEvidenceValidator,
  maxRepairAttempts,
  timeoutMs,
  abortSignal,
  hooks = {},
}) {
  if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("cwd is required");
  if (taskCard === undefined || taskCard === null) throw new TypeError("taskCard is required");
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
    throw new TypeError("maxRepairAttempts must be a nonnegative integer (0 means no repair)");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a finite positive number");
  }

  // Adapter separation (C2): executor and reviewer may be provided as two
  // distinct adapters (production mode). A single `adapter` remains valid for
  // legacy/scripted callers only. If a split pair is requested, BOTH halves
  // must be present — a partial pair fails closed before any adapter call.
  const splitAdapters = executorAdapter !== undefined || reviewerAdapter !== undefined;
  let resolveAdapter;
  if (splitAdapters) {
    if (!executorAdapter || typeof executorAdapter.runAdapter !== "function" ||
        !reviewerAdapter || typeof reviewerAdapter.runAdapter !== "function") {
      const missing = [
        !executorAdapter || typeof executorAdapter.runAdapter !== "function" ? "executorAdapter" : null,
        !reviewerAdapter || typeof reviewerAdapter.runAdapter !== "function" ? "reviewerAdapter" : null,
      ].filter(Boolean).join(",");
      const executionId = (taskCard && taskCard.executionId) || `lifecycle-${randomUUID()}`;
      return {
        final: "HOLD", reason: "MISSING_ADAPTER_PAIR", attempt: null,
        detail: { missing }, classification: classifyHold({ failureOrigin: "MISSING_ADAPTER_PAIR", message: `missing ${missing}` }),
        transitions: [{ phase: "runner", status: "HOLD", reason: "MISSING_ADAPTER_PAIR", detail: { missing } }],
        executionId,
      };
    }
    resolveAdapter = (phase) => (phase === "executor" ? executorAdapter : reviewerAdapter);
  } else {
    if (!adapter || typeof adapter.runAdapter !== "function") throw new TypeError("adapter.runAdapter is required");
    resolveAdapter = () => adapter;
  }

  const lifecycleStartedAt = new Date().toISOString();
  const executionId = (taskCard && taskCard.executionId) || `lifecycle-${randomUUID()}`;
  const transitions = [];

  function hold(reason, detail = {}) {
    const classification = classifyHold({ failureOrigin: reason, message: reason });
    transitions.push({ phase: "runner", status: "HOLD", reason, detail });
    return { final: "HOLD", reason, attempt: detail.attempt ?? null, detail, classification, transitions, executionId };
  }

  if (abortSignal && abortSignal.aborted) {
    return hold("ABORTED_BEFORE_START");
  }

  async function callAdapter(phase, attempt, extra = {}) {
    try {
      return { ok: true, result: await resolveAdapter(phase).runAdapter({
        executionId,
        cwd,
        taskCard,
        phase,
        attempt,
        timeoutMs,
        environmentAllowlist: taskCard.environmentAllowlist,
        toolPolicy: phase === "reviewer" ? REVIEWER_TOOL_POLICY : taskCard.toolPolicy,
        abortSignal,
        ...extra,
      }) };
    } catch (e) {
      if (e instanceof ScriptedAdapterSequenceError) {
        return { ok: false, holdResult: hold("SCRIPT_SEQUENCE_MISMATCH", { phase, attempt, reason: e.reason, detail: e.detail }) };
      }
      if (e instanceof AdapterContractError) {
        return { ok: false, holdResult: hold("MALFORMED_ADAPTER_RESULT", { phase, attempt, errors: e.reasons }) };
      }
      throw e;
    }
  }

  let attempt = 0;
  for (;;) {
    const executorCall = await callAdapter("executor", attempt);
    if (!executorCall.ok) return executorCall.holdResult;
    const executorResult = executorCall.result;
    transitions.push({ phase: "executor", attempt, status: executorResult.status });

    if (executorResult.status === "error") return hold("EXECUTOR_ERROR", { attempt, error: executorResult.error });
    if (executorResult.status === "timed_out") return hold("EXECUTOR_TIMEOUT", { attempt });
    if (executorResult.status === "aborted") return hold("EXECUTOR_ABORTED", { attempt });

    // C4Q: the executor final message is NON-AUTHORITATIVE for evidence.
    // It is preserved only as a bounded diagnostic（never parsed as the
    // formal evidence, never a gate, never polluting the run verdict）.
    // A persistence failure（e.g. secret-pattern fail-closed）becomes a
    // journaled phase hold — never a silent exception.
    try {
      await hooks.onExecutorOutput?.({ attempt, diagnostic: buildExecutorOutputDiagnostic(executorResult) });
    } catch (e) {
      return hold("EXECUTOR_OUTPUT_PERSISTENCE_FAILED", { attempt, reason: e?.message ?? String(e) });
    }

    let scopeCheck = null;
    if (taskCard.mutationScope) {
      scopeCheck = checkMutationScope(taskCard.mutationScope);
      transitions.push({ phase: "mutation_scope_gate", attempt, ok: scopeCheck.ok });
      if (!scopeCheck.ok) {
        return hold("MUTATION_SCOPE_VIOLATION", { attempt, violations: scopeCheck.violations });
      }
    }

    // C4S: system-observed textual delta evidence（reviewer-visible）. The
    // harness converts the scope gate's already-validated repository delta
    // into a bounded unified diff + per-file SHA-256 records. Every
    // fail-closed gate（identity / scope binding / SHA / oversize / binary /
    // secret）HOLDS here, BEFORE the reviewer is ever invoked（C4S-7/8/9）.
    let systemDelta = null;
    if (taskCard.mutationScope && scopeCheck) {
      const deltaResult = buildSystemObservedDelta({
        executionId: taskCard.parentExecutionId ?? executionId,
        taskCard,
        scopeCheck,
        limits: {},
      });
      if (!deltaResult.ok) {
        return hold(deltaResult.code, { attempt, reason: deltaResult.reason });
      }
      systemDelta = deltaResult.delta;
      // C4S-11: the patch + metadata must persist durably before review;
      // a persistence failure is a journaled HOLD — never a silent continue.
      try {
        await hooks.onSystemDeltaReady?.({ attempt, delta: systemDelta });
      } catch (e) {
        return hold(SYSTEM_DELTA_ERRORS.PERSISTENCE_FAILED, {
          attempt,
          reason: `${e?.code ?? e?.name ?? "error"}: ${String(e?.message ?? e).slice(0, 2048)}`,
        });
      }
    }

    // C4Q: harness-owned evidence assembly — AutoLoop collects the objective
    // facts and builds the implementation-evidence object itself（identity
    // mechanically bound; system-observed test process; schema validated）.
    const evidenceStartedAt = new Date().toISOString();
    const evidenceBuild = await buildHarnessOwnedEvidence({
      executionId: taskCard.parentExecutionId ?? executionId,
      taskCard,
      attempt,
      scopeCheck: scopeCheck ?? { ok: true, violations: [], delta: [] },
      baseline: taskCard.repositoryRoot ? collectGitBaseline(taskCard.repositoryRoot) : null,
      testRun: Array.isArray(taskCard.verificationCommand)
        ? await runVerificationCommand({
            command: taskCard.verificationCommand,
            cwd: taskCard.repositoryRoot,
            environmentAllowlist: taskCard.environmentAllowlist,
          })
        : null,
      phaseStartedAt: lifecycleStartedAt,
      phaseCompletedAt: evidenceStartedAt,
      executorResult,
      systemDelta,
    });
    if (!evidenceBuild.ok) {
      return hold(evidenceBuild.code, { attempt, reason: evidenceBuild.reason });
    }
    const harnessEvidence = evidenceBuild.evidence;

    // C3 checkpoint hook：executor 階段完整完成（harness evidence 已組裝）。
    await hooks.onExecutorCompleted?.({ attempt, evidence: harnessEvidence });

    // C4N: assemble the system reviewer evidence bundle（only when a
    // mutation scope was attached, i.e. the production orchestrator path）.
    // Any fail-closed gate blocks review and HOLDS the run without
    // changing the executor verdict. Absent mutationScope（legacy/direct
    // callers）delivers no bundle — the reviewer then has only the task card.
    let reviewEvidence = null;
    if (taskCard.mutationScope && scopeCheck) {
      const bundleResult = buildReviewEvidenceBundle({
        executionId: taskCard.parentExecutionId ?? executionId,
        taskCard,
        attempt,
        evidence: harnessEvidence,
        observedChangedPaths: (scopeCheck.delta || []).map((d) => d.path),
        toolExecutionCount: executorResult?.metadata?.toolCallCount ?? null,
        systemDelta,
      });
      if (!bundleResult.ok) {
        return hold(bundleResult.code, {
          attempt,
          reason: bundleResult.reason,
        });
      }
      reviewEvidence = bundleResult.bundle;
    }

    const reviewerCall = await callAdapter("reviewer", attempt, { reviewEvidence });
    if (!reviewerCall.ok) return reviewerCall.holdResult;
    const reviewerResult = reviewerCall.result;
    transitions.push({ phase: "reviewer", attempt, status: reviewerResult.status });

    if (reviewerResult.status === "error") return hold("REVIEWER_ERROR", { attempt, error: reviewerResult.error });
    if (reviewerResult.status === "timed_out") return hold("REVIEWER_TIMEOUT", { attempt });
    if (reviewerResult.status === "aborted") return hold("REVIEWER_ABORTED", { attempt });

    const verdictParse = parseJsonStrict(reviewerResult.stdout);
    if (!verdictParse.ok) {
      return hold("MALFORMED_REVIEWER_VERDICT", { attempt, reason: "stdout_not_valid_json", detail: verdictParse.error });
    }
    const verdict = normalizeReviewerVerdict(verdictParse.value, taskCard.expectedReviewerModel || "");
    if (isSchemaInvalidVerdict(verdict)) {
      return hold("MALFORMED_REVIEWER_VERDICT", { attempt, evidence_gaps: verdict.evidence_gaps, summary: verdict.summary });
    }
    transitions.push({
      phase: "reviewer_verdict",
      attempt,
      verdict: verdict.verdict,
      recommended_next_action: verdict.recommended_next_action,
    });

    // C3 checkpoint hook：reviewer 階段完整完成（verdict 已 normalize）。
    await hooks.onReviewerCompleted?.({ attempt, verdict: verdict.verdict, verdictObject: verdict });

    if (verdict.verdict === "PASS") {
      return { final: "PASS", attempt, transitions, executionId };
    }

    if (verdict.recommended_next_action === "REPAIR") {
      await hooks.onRepairRequested?.({ attempt });
      if (attempt >= maxRepairAttempts) {
        return hold("REPAIR_BUDGET_EXHAUSTED", { attempt, maxRepairAttempts });
      }
      attempt += 1;
      continue;
    }

    return hold("REVIEWER_HOLD", {
      attempt,
      verdict: verdict.verdict,
      recommended_next_action: verdict.recommended_next_action,
    });
  }
}

// ── CP-2R2 Finding 2 — authoritative lifecycle eligibility ──────────────
//
// The Control Plane / optimizer must NOT derive lifecycle eligibility from
// budget counters（budget constrains execution; it cannot mint CONTINUE /
// RETRY / REPAIR / REVIEW）. The Lifecycle Runner owns which transitions are
// legal now, so the eligible transition set（cost-optimizer contract §3
// CONTINUE / RETRY / REPLAN）is derived HERE from lifecycle state + admission
// repair authority, never from budget meters.

export const LIFECYCLE_RETRY_REPLAN_CHOICES = Object.freeze(["CONTINUE", "RETRY", "REPLAN"]);

/**
 * Authoritative eligible transition set owned by the Lifecycle Runner.
 *
 * @param {object} opts
 * @param {string|null} opts.lifecycleState — a valid reversible-lifecycle
 *        state（governance/lifecycle-state.mjs）; the authoritative "where are
 *        we now" fact.
 * @param {number|null} opts.repairBudget — admission.repair_budget（the TA-2
 *        repair AUTHORITY, not the runtime repair_attempt_count meter）.
 * @param {number} opts.repairAttempts — lifecycle repair attempts consumed
 *        so far.
 * @returns {string[]|null} — eligible transitions（subset of
 *   LIFECYCLE_RETRY_REPLAN_CHOICES）; null = lifecycle authority unavailable
 *   （caller must HOLD）; [] = terminal/no forward transition（HOLD）.
 */
export function deriveLifecycleEligibleTransitions({ lifecycleState = null, repairBudget = null, repairAttempts = 0 } = {}) {
  // Missing/unknown lifecycle state ⇒ authority unavailable — fail closed.
  if (!isValidLifecycleState(lifecycleState)) return null;
  // Terminal / controller-owned states offer no forward transition.
  if (lifecycleState === "CONTROLLER_REQUIRED" || lifecycleState === "INTEGRATION_READY") return [];

  const transitions = ["CONTINUE"];
  // RETRY is a lifecycle fact（the runner may re-attempt while the lifecycle
  // is still in a reversible, non-terminal state）— NOT derived from the
  // budget retry_count meter.
  transitions.push("RETRY");

  // REPLAN（repair/re-decompose）is legal ONLY inside the admission repair
  // authority, never from the budget repair_attempt_count meter.
  const rb = Number(repairBudget ?? 0);
  const used = Number(repairAttempts ?? 0);
  if (Number.isFinite(rb) && rb > 0 && Number.isFinite(used) && used < rb) {
    transitions.push("REPLAN");
  }
  return transitions;
}
