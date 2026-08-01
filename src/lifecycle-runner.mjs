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
import { validateImplementationEvidence } from "./validate-role-artifacts.mjs";
import { captureScopeSnapshot, enforceScopeGate } from "./c2d/mutation-scope.mjs";
import { classifyHold } from "./hold-taxonomy.mjs";
import { normalize as normalizeReviewerVerdict, FAIL_CLOSED as REVIEWER_FAIL_CLOSED } from "./normalize-reviewer-json.mjs";

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
  return { ok: gate.ok, violations: gate.violations };
}

function parseJsonStrict(text) {
  try {
    return { ok: true, value: JSON.parse(text ?? "") };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function runLifecycle({
  cwd,
  taskCard,
  adapter,
  maxRepairAttempts,
  timeoutMs,
  abortSignal,
}) {
  if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("cwd is required");
  if (taskCard === undefined || taskCard === null) throw new TypeError("taskCard is required");
  if (!adapter || typeof adapter.runAdapter !== "function") throw new TypeError("adapter.runAdapter is required");
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
    throw new TypeError("maxRepairAttempts must be a nonnegative integer (0 means no repair)");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a finite positive number");
  }

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

  async function callAdapter(phase, attempt) {
    try {
      return { ok: true, result: await adapter.runAdapter({
        executionId,
        cwd,
        taskCard,
        phase,
        attempt,
        timeoutMs,
        environmentAllowlist: taskCard.environmentAllowlist,
        toolPolicy: taskCard.toolPolicy,
        abortSignal,
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

    const evidenceParse = parseJsonStrict(executorResult.stdout);
    if (!evidenceParse.ok) {
      return hold("EXECUTOR_EVIDENCE_INVALID", { attempt, reason: "stdout_not_valid_json", detail: evidenceParse.error });
    }
    const evidenceCheck = validateImplementationEvidence(evidenceParse.value);
    if (!evidenceCheck.valid) {
      return hold("EXECUTOR_EVIDENCE_INVALID", { attempt, errors: evidenceCheck.errors });
    }

    if (taskCard.mutationScope) {
      const scopeCheck = checkMutationScope(taskCard.mutationScope);
      transitions.push({ phase: "mutation_scope_gate", attempt, ok: scopeCheck.ok });
      if (!scopeCheck.ok) {
        return hold("MUTATION_SCOPE_VIOLATION", { attempt, violations: scopeCheck.violations });
      }
    }

    const reviewerCall = await callAdapter("reviewer", attempt);
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

    if (verdict.verdict === "PASS") {
      return { final: "PASS", attempt, transitions, executionId };
    }

    if (verdict.recommended_next_action === "REPAIR") {
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
