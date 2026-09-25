// adapter/contract.mjs
//
// Provider-neutral executor/reviewer adapter contract. Not Pi-specific, not
// bound to any LLM provider. Defines only the request/result shape an
// AegisFlow-callable adapter must satisfy and validates values against it.
//
// This contract intentionally carries no authority: a validated result only
// means "well-formed", never "PASS", never "evidence is trustworthy", never
// "safe to commit". Those judgments belong to lifecycle-runner.mjs and the
// existing C2D / evidence-schema layers, not to the adapter or this file.

export class AdapterContractError extends Error {
  constructor(reasons) {
    super(`adapter_contract_violation: ${reasons.join(", ")}`);
    this.name = "AdapterContractError";
    this.reasons = reasons;
  }
}

export const ADAPTER_PHASES = Object.freeze(["executor", "reviewer"]);
export const ADAPTER_RESULT_STATUSES = Object.freeze(["completed", "timed_out", "aborted", "error"]);

const REQUEST_REQUIRED = ["executionId", "cwd", "taskCard", "phase", "attempt", "timeoutMs"];

export function validateAdapterRequest(request) {
  const errors = [];
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { valid: false, errors: ["request_not_object"] };
  }
  for (const key of REQUEST_REQUIRED) {
    if (request[key] === undefined || request[key] === null) errors.push(`missing_${key}`);
  }
  if (request.executionId !== undefined && (typeof request.executionId !== "string" || request.executionId.length === 0)) {
    errors.push("executionId_must_be_nonempty_string");
  }
  if (request.cwd !== undefined && (typeof request.cwd !== "string" || request.cwd.length === 0)) {
    errors.push("cwd_must_be_nonempty_string");
  }
  if (request.phase !== undefined && !ADAPTER_PHASES.includes(request.phase)) {
    errors.push(`phase_must_be_one_of_${ADAPTER_PHASES.join("|")}`);
  }
  if (request.attempt !== undefined && (!Number.isInteger(request.attempt) || request.attempt < 0)) {
    errors.push("attempt_must_be_nonnegative_integer");
  }
  if (request.timeoutMs !== undefined && (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) {
    errors.push("timeoutMs_must_be_finite_positive_number");
  }
  if (request.environmentAllowlist !== undefined && !Array.isArray(request.environmentAllowlist)) {
    errors.push("environmentAllowlist_must_be_array");
  }
  if (
    request.abortSignal !== undefined &&
    request.abortSignal !== null &&
    typeof request.abortSignal.aborted !== "boolean"
  ) {
    errors.push("abortSignal_must_be_AbortSignal_like");
  }
  return { valid: errors.length === 0, errors };
}

export function assertAdapterRequest(request) {
  const { valid, errors } = validateAdapterRequest(request);
  if (!valid) throw new AdapterContractError(errors);
  return request;
}

const RESULT_REQUIRED = ["status", "executionId"];

export function validateAdapterResult(result) {
  const errors = [];
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { valid: false, errors: ["result_not_object"] };
  }
  for (const key of RESULT_REQUIRED) {
    if (result[key] === undefined) errors.push(`missing_${key}`);
  }
  if (result.status !== undefined && !ADAPTER_RESULT_STATUSES.includes(result.status)) {
    errors.push(`status_must_be_one_of_${ADAPTER_RESULT_STATUSES.join("|")}`);
  }
  if (result.stdout !== undefined && typeof result.stdout !== "string") errors.push("stdout_must_be_string");
  if (result.stderr !== undefined && typeof result.stderr !== "string") errors.push("stderr_must_be_string");
  if (result.metadata !== undefined && (typeof result.metadata !== "object" || result.metadata === null)) {
    errors.push("metadata_must_be_object");
  }
  if (result.status === "completed") {
    if (result.signal) errors.push("completed_result_must_not_carry_signal");
    if (result.error) errors.push("completed_result_must_not_carry_error");
  }
  if (result.status === "error" && !result.error) errors.push("error_result_must_carry_error_message");
  return { valid: errors.length === 0, errors };
}

export function assertAdapterResult(result) {
  const { valid, errors } = validateAdapterResult(result);
  if (!valid) throw new AdapterContractError(errors);
  return result;
}
