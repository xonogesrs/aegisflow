// src/subagent/subagent-contract.mjs
//
// Sub-agent execution contract for Graph nodes.
//
// Every sub-agent is bound to a full identity set and a minimal, frozen input
// context. The agent returns a STRUCTURED result（not a free-text summary）;
// the executor and reviewer validate schema + identity before a node may PASS.
//
// Identity binding（deterministic, derived — never process/pid based）:
//   agentExecutionId     = f(graphExecutionId, nodeId)
//   inputContextIdentity = sha256(canonical(input context)) — guards against
//                          context drift on rerun
//   outputSchemaIdentity = fixed schema version of the structured result
//
// Fail-closed: any missing field, bad status, or identity mismatch means the
// node cannot PASS（executor/reviewer treat it as REPAIR/error -> HOLD path）.

import { createHash } from "node:crypto";
import { assertAuthorizedPathsBounded } from "../admission/search-scope-governor.mjs";

export const SUBAGENT_RESULT_SCHEMA = "autoloop.subagent.structured-result/v1";
export const SUBAGENT_WRITER_RESULT_SCHEMA = "autoloop.subagent.writer-result/v1";
export const SUBAGENT_REVIEW_RESULT_SCHEMA = "autoloop.subagent.review-result/v1";
export const SUBAGENT_RESULT_STATUSES = Object.freeze(["PASS", "REPAIR", "HOLD", "CANCELLED"]);
export const SUBAGENT_ROLES = Object.freeze(["readonly-analyst", "writer", "repairer", "reviewer", "verifier", "join"]);
export const TOOL_PERMISSIONS = Object.freeze({
  READ_ONLY: ["fs.read", "fs.grep", "fs.list", "fs.stat"],
  SCRATCH_WRITE: ["fs.write-scratch"],
});

export class SubagentContractError extends Error {
  constructor(reasons) {
    super(`subagent_contract_violation: ${reasons.join(", ")}`);
    this.name = "SubagentContractError";
    this.reasons = reasons;
  }
}

export function sha256Hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

/** Deterministic agent execution id for a graph node. */
export function agentExecutionIdFor(graphExecutionId, nodeId) {
  return `agent_${sha256Hex(`${graphExecutionId}:${nodeId}`).slice(0, 16)}`;
}

/**
 * Deterministic STAGE-scoped agent execution id（review / repair stages of a
 * node）. A review agent and a repair agent are separate processes and MUST
 * NOT share the node's writer identity — stage-scoping prevents cross-wiring
 *（a review result can never be mistaken for a writer result）. Stable for a
 * given (graphExecutionId, nodeId, stage), so reruns are reproducible.
 */
export function stageAgentExecutionId(graphExecutionId, nodeId, stage) {
  return `agent_${sha256Hex(`${graphExecutionId}:${nodeId}:stage:${stage}`).slice(0, 16)}`;
}

/** Canonical（sorted-key）JSON — stable input-context identity base. */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Build the full sub-agent envelope for one node.
 * `inputContext` is the MINIMAL context: objective + authorized paths + tool
 * permissions + bounded dependency results digest + mutation scope (writer).
 * No full history is ever included.
 *
 * Writer nodes additionally bind (present in the envelope, validated against
 * the returned result): worktreeIdentity, baseCommit, mutationScope,
 * dependencyResultIdentities, repairBudget and cancellationIdentity. These are
 * NOT part of the inputContext identity hash (attempt-invariant hash keeps
 * repair attempts comparable), but they ARE part of the fail-closed
 * writer-result validation.
 */
export function buildSubagentEnvelope({
  graphExecutionId,
  nodeId,
  phaseExecutionId,
  agentRole,
  objective,
  authorizedPaths,
  toolPermissions = TOOL_PERMISSIONS.READ_ONLY,
  runtimeInstance,
  timeoutMs,
  dependencyResultsDigest = null,
  outputSchemaIdentity = SUBAGENT_RESULT_SCHEMA,
  worktreeIdentity = null,
  baseCommit = null,
  mutationScope = null,
  dependencyResultIdentities = null,
  repairBudget = null,
  cancellationIdentity = null,
  stage = null,
  reviewFindingsIdentity = null,
  blockingFindings = null,
  memoryContext = null,
  // TA-2 admission binding: the envelope carries the admission digest so a
  // changed admission invalidates in-flight envelopes（integration map）.
  admissionId = null,
  admissionDigest = null,
}) {
  const agentExecutionId = stage
    ? stageAgentExecutionId(graphExecutionId, nodeId, stage)
    : agentExecutionIdFor(graphExecutionId, nodeId);
  const inputContext = {
    objective,
    authorizedPaths: [...authorizedPaths],
    toolPermissions,
    dependencyResultsDigest,
    // mutationScope is attempt-invariant and part of the frozen context.
    ...(mutationScope ? { mutationScope: [...mutationScope] } : {}),
    // TA-2: the admission is part of the frozen context identity — a changed
    // admission changes the inputContextIdentity and invalidates the envelope.
    ...(admissionDigest ? { admissionDigest } : {}),
    // Review findings identity binds the repair to THE review it answers.
    ...(reviewFindingsIdentity ? { reviewFindingsIdentity } : {}),
    // CBM-3: memory is DATA context（never instructions）— its digest binds
    // the envelope to the deterministic retrieval result.
    ...(memoryContext ? { memoryContextDigest: sha256Hex(canonicalJson(memoryContext)) } : {}),
  };
  const inputContextIdentity = sha256Hex(canonicalJson(inputContext));
  return {
    schema_version: "autoloop.subagent.envelope/v1",
    graphExecutionId,
    nodeId,
    agentExecutionId,
    phaseExecutionId,
    agentRole,
    objective,
    authorizedPaths: [...authorizedPaths],
    toolPermissions,
    runtimeInstance,
    timeoutIdentity: { timeoutMs, source: "lifecycle" },
    inputContextIdentity,
    outputSchemaIdentity,
    dependencyResultsDigest,
    // writer-only binding fields (null for read-only roles)
    worktreeIdentity,
    baseCommit,
    mutationScope: mutationScope ? [...mutationScope] : null,
    dependencyResultIdentities: dependencyResultIdentities
      ? dependencyResultIdentities.map((d) => ({ ...d }))
      : null,
    repairBudget: repairBudget ? { ...repairBudget } : null,
    cancellationIdentity: cancellationIdentity ?? null,
    // review/repair stage wiring
    stage: stage ?? null,
    reviewFindingsIdentity: reviewFindingsIdentity ?? null,
    blockingFindings: blockingFindings ? [...blockingFindings] : null,
    // CBM-3 read-only memory context（bounded DATA; the input context digest
    // already binds it — the envelope carries it so executor/reviewer
    // consumers can render it as context）.
    memoryContext: memoryContext ?? null,
    // TA-2 admission binding（admission_id + digest; null when unadmitted）.
    admissionId: admissionId ?? null,
    admissionDigest: admissionDigest ?? null,
  };
}

export function validateSubagentEnvelope(envelope) {
  const errors = [];
  for (const k of [
    "graphExecutionId", "nodeId", "agentExecutionId", "phaseExecutionId", "agentRole",
    "objective", "authorizedPaths", "toolPermissions", "runtimeInstance",
    "timeoutIdentity", "inputContextIdentity", "outputSchemaIdentity",
  ]) {
    if (envelope[k] === undefined || envelope[k] === null) errors.push(`missing_${k}`);
  }
  if (envelope.agentRole !== undefined && !SUBAGENT_ROLES.includes(envelope.agentRole)) {
    errors.push(`invalid_agentRole:${envelope.agentRole}`);
  }
  if (envelope.authorizedPaths !== undefined && !Array.isArray(envelope.authorizedPaths)) {
    errors.push("authorizedPaths_must_be_array");
  }
  // RB-SSG（invariant B）: an envelope may not authorize an unbounded
  // traversal root（$HOME / user home / Desktop / filesystem root / multi-user
  // parent）. Absolute forbidden roots are rejected fail-closed; relative
  // paths are worktree-scoped and never flagged here.
  if (Array.isArray(envelope.authorizedPaths)) {
    const bounded = assertAuthorizedPathsBounded(envelope.authorizedPaths);
    if (!bounded.ok) errors.push(...bounded.errors);
  }
  // Writer envelope hard requirements（fail-closed before any task starts）.
  // The repair agent（repairer）carries the same writer contract AND must be
  // bound to the review findings it answers.
  if (envelope.agentRole === "writer" || envelope.agentRole === "repairer") {
    for (const k of ["worktreeIdentity", "baseCommit", "mutationScope", "repairBudget"]) {
      if (envelope[k] === undefined || envelope[k] === null) errors.push(`${envelope.agentRole}_missing_${k}`);
    }
    if (envelope.worktreeIdentity && (envelope.worktreeIdentity.worktreeDir === undefined || envelope.worktreeIdentity.head === undefined)) {
      errors.push(`${envelope.agentRole}_worktreeIdentity_incomplete`);
    }
    if (envelope.mutationScope !== undefined && !Array.isArray(envelope.mutationScope)) {
      errors.push(`${envelope.agentRole}_mutationScope_must_be_array`);
    }
    if (envelope.repairBudget !== undefined && (typeof envelope.repairBudget.maxAttempts !== "number" || typeof envelope.repairBudget.remaining !== "number")) {
      errors.push(`${envelope.agentRole}_repairBudget_invalid`);
    }
    if (envelope.agentRole === "repairer") {
      if (typeof envelope.reviewFindingsIdentity !== "string" || envelope.reviewFindingsIdentity.length === 0) {
        errors.push("repairer_missing_reviewFindingsIdentity");
      }
      if (!Array.isArray(envelope.blockingFindings)) errors.push("repairer_blockingFindings_must_be_array");
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate the agent's structured result against the contract AND bind its
 * identity to the expected node identities（fail-closed）.
 */
export function validateSubagentResult(result, { expectedAgentExecutionId, expectedInputContextIdentity } = {}) {
  const errors = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, errors: ["result_not_object"] };
  }
  if (result.schema_version !== SUBAGENT_RESULT_SCHEMA) errors.push(`schema_version_mismatch:${result.schema_version}`);
  if (!SUBAGENT_RESULT_STATUSES.includes(result.status)) errors.push(`status_invalid:${result.status}`);
  if (expectedAgentExecutionId !== undefined && result.agentExecutionId !== expectedAgentExecutionId) {
    errors.push(`agent_identity_mismatch:${result.agentExecutionId}!=${expectedAgentExecutionId}`);
  }
  if (expectedInputContextIdentity !== undefined && result.inputContextIdentity !== expectedInputContextIdentity) {
    errors.push(`input_context_identity_mismatch`);
  }
  if (result.outputSchemaIdentity !== SUBAGENT_RESULT_SCHEMA) errors.push("output_schema_identity_mismatch");
  for (const k of [
    "claims", "evidenceReferences", "filesInspected", "commandsExecuted",
    "assumptions", "uncertainties",
  ]) {
    if (!Array.isArray(result[k])) errors.push(`missing_or_nonarray_${k}`);
  }
  if (typeof result.recommendedNextAction !== "string" || result.recommendedNextAction.length === 0) {
    errors.push("recommendedNextAction_missing");
  }
  if (typeof result.summary !== "string" || result.summary.length === 0) errors.push("summary_missing");
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a WRITER sub-agent's structured result（writer schema）fail-closed.
 *
 * In addition to the base binding checks it enforces the writer contract:
 *  - schema_version must be the writer schema
 *  - filesChanged（array）/ diffSummary（string）/ scopeVerification
 *    （{ok, violations[]}）/ testsExecuted（array）/ testResults
 *    （{passed,failed,total}）must all be present and well-typed
 *  - worktree identity：result.worktreeIdentity.head must equal the
 *    envelope's baseCommit（agent-observed base == host-bound base）
 *  - mutation scope：every changed file（agent-reported AND host-observed）
 *    must be inside the envelope's mutationScope; agent filesChanged must
 *    equal the host-observed changed set（no undeclared writes）
 *  - diff presence：a writer that reports no changes cannot PASS
 *
 * `hostChangedPaths` is the host-observed changed-path set of the worktree
 *（relative to the worktree root）; `repoHeadClean` is the host-observed
 * main-repo purity flag（main repo must stay zero-touch）.
 */
export function validateWriterSubagentResult(
  result,
  {
    expectedAgentExecutionId,
    expectedInputContextIdentity,
    expectedBaseCommit,
    expectedReviewFindingsIdentity,
    mutationScope = [],
    hostChangedPaths = [],
    repoHeadClean = true,
  } = {},
) {
  const errors = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, errors: ["result_not_object"] };
  }
  if (result.schema_version !== SUBAGENT_WRITER_RESULT_SCHEMA) {
    errors.push(`schema_version_mismatch:${result.schema_version}`);
  }
  if (!SUBAGENT_RESULT_STATUSES.includes(result.status)) errors.push(`status_invalid:${result.status}`);
  if (expectedAgentExecutionId !== undefined && result.agentExecutionId !== expectedAgentExecutionId) {
    errors.push(`agent_identity_mismatch:${result.agentExecutionId}!=${expectedAgentExecutionId}`);
  }
  if (expectedInputContextIdentity !== undefined && result.inputContextIdentity !== expectedInputContextIdentity) {
    errors.push(`input_context_identity_mismatch`);
  }
  if (result.outputSchemaIdentity !== SUBAGENT_WRITER_RESULT_SCHEMA) errors.push("output_schema_identity_mismatch");

  for (const k of ["filesChanged", "testsExecuted"]) {
    if (!Array.isArray(result[k])) errors.push(`missing_or_nonarray_${k}`);
  }
  if (typeof result.diffSummary !== "string") errors.push("diffSummary_missing");
  if (!result.scopeVerification || typeof result.scopeVerification !== "object" || Array.isArray(result.scopeVerification)) {
    errors.push("scopeVerification_missing");
  } else if (result.scopeVerification.ok !== true) {
    errors.push(`scope_verification_not_ok:${JSON.stringify(result.scopeVerification.violations ?? []).slice(0, 200)}`);
  }
  const tr = result.testResults;
  if (!tr || typeof tr !== "object" || Array.isArray(tr)) {
    errors.push("testResults_missing");
  } else {
    for (const k of ["passed", "failed", "total"]) {
      if (!Number.isInteger(tr[k]) || tr[k] < 0) errors.push(`testResults_${k}_invalid`);
    }
    if (tr.total !== undefined && (tr.passed ?? -1) + (tr.failed ?? -1) !== tr.total) {
      errors.push("testResults_passed_plus_failed_must_equal_total");
    }
    if (tr.total === 0) errors.push("testResults_total_zero");
  }
  for (const k of [
    "claims", "evidenceReferences", "filesInspected", "commandsExecuted",
    "assumptions", "uncertainties",
  ]) {
    if (!Array.isArray(result[k])) errors.push(`missing_or_nonarray_${k}`);
  }
  if (typeof result.recommendedNextAction !== "string" || result.recommendedNextAction.length === 0) {
    errors.push("recommendedNextAction_missing");
  }
  if (typeof result.summary !== "string" || result.summary.length === 0) errors.push("summary_missing");

  // Worktree identity binding: the agent's observed base must equal the
  // host-bound baseCommit（worktree identity consistency）.
  const wtId = result.worktreeIdentity;
  if (!wtId || typeof wtId !== "object" || wtId.head === undefined) {
    errors.push("worktreeIdentity_missing");
  } else if (expectedBaseCommit !== undefined && wtId.head !== expectedBaseCommit) {
    errors.push(`worktree_identity_mismatch:${wtId.head}!=${expectedBaseCommit}`);
  }

  // Repair result must echo the review findings it was bound to（串線防護）.
  if (expectedReviewFindingsIdentity !== undefined) {
    if (result.reviewFindingsIdentity !== expectedReviewFindingsIdentity) {
      errors.push(`review_findings_identity_mismatch:${result.reviewFindingsIdentity}!=${expectedReviewFindingsIdentity}`);
    }
  }

  // Mutation scope containment（both agent-reported and host-observed）.
  const scopeSet = new Set((mutationScope || []).map((p) => String(p).replace(/\/+$/, "")));
  const inScope = (p) => {
    const np = String(p).replace(/\/+$/, "");
    return [...scopeSet].some((s) => np === s || np.startsWith(s + "/"));
  };
  for (const f of result.filesChanged ?? []) {
    if (!inScope(f)) errors.push(`filesChanged_out_of_scope:${f}`);
  }
  for (const p of hostChangedPaths) {
    if (!inScope(p)) errors.push(`host_changed_out_of_scope:${p}`);
  }
  const hostSet = [...new Set(hostChangedPaths.map((p) => String(p)))].sort();
  const agentSet = [...new Set((result.filesChanged ?? []).map((p) => String(p)))].sort();
  if (JSON.stringify(hostSet) !== JSON.stringify(agentSet)) {
    errors.push(`filesChanged_mismatch:agent=${JSON.stringify(agentSet)}!=host=${JSON.stringify(hostSet)}`);
  }
  // Diff presence：a writer with zero changes cannot PASS.
  if (hostChangedPaths.length === 0) errors.push("no_changes_no_diff");
  if (!repoHeadClean) errors.push("main_repo_polluted");

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a REVIEW agent's structured result（review schema）fail-closed.
 *
 * The review agent is the INDEPENDENT gate on a writer's output: it must
 * carry its stage-scoped identity, enumerate findings, and declare whether
 * the writer result passes scope/tests/evidence cross-checks. The reviewer
 * adapter maps this result to the lifecycle verdict — the review agent can
 * never be bypassed by the writer's own self-declared status.
 */
export function validateReviewSubagentResult(
  result,
  { expectedAgentExecutionId, expectedInputContextIdentity } = {},
) {
  const errors = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { ok: false, errors: ["result_not_object"] };
  }
  if (result.schema_version !== SUBAGENT_REVIEW_RESULT_SCHEMA) {
    errors.push(`schema_version_mismatch:${result.schema_version}`);
  }
  if (!SUBAGENT_RESULT_STATUSES.includes(result.status)) errors.push(`status_invalid:${result.status}`);
  if (expectedAgentExecutionId !== undefined && result.agentExecutionId !== expectedAgentExecutionId) {
    errors.push(`agent_identity_mismatch:${result.agentExecutionId}!=${expectedAgentExecutionId}`);
  }
  if (expectedInputContextIdentity !== undefined && result.inputContextIdentity !== expectedInputContextIdentity) {
    errors.push(`input_context_identity_mismatch`);
  }
  if (result.outputSchemaIdentity !== SUBAGENT_REVIEW_RESULT_SCHEMA) errors.push("output_schema_identity_mismatch");
  for (const k of ["findings", "blockingFindings", "nonBlockingFindings", "evidenceChecked"]) {
    if (!Array.isArray(result[k])) errors.push(`missing_or_nonarray_${k}`);
  }
  if (typeof result.scopeVerified !== "boolean") errors.push("scopeVerified_must_be_boolean");
  if (typeof result.testsVerified !== "boolean") errors.push("testsVerified_must_be_boolean");
  if (!["PASS", "REPAIR", "HOLD"].includes(result.recommendedAction)) {
    errors.push(`recommendedAction_invalid:${result.recommendedAction}`);
  }
  // Internal consistency（fail-closed on self-contradiction）.
  if (result.recommendedAction === "PASS" && Array.isArray(result.blockingFindings) && result.blockingFindings.length > 0) {
    errors.push("review_PASS_with_blocking_findings");
  }
  if (result.status === "REPAIR" && (!Array.isArray(result.blockingFindings) || result.blockingFindings.length === 0)) {
    errors.push("review_REPAIR_without_blocking_findings");
  }
  if (result.status === "PASS" && (!Array.isArray(result.blockingFindings) || result.blockingFindings.length > 0)) {
    errors.push("review_PASS_with_blocking_findings");
  }
  for (const k of [
    "claims", "evidenceReferences", "filesInspected", "commandsExecuted",
    "assumptions", "uncertainties",
  ]) {
    if (!Array.isArray(result[k])) errors.push(`missing_or_nonarray_${k}`);
  }
  if (typeof result.recommendedNextAction !== "string" || result.recommendedNextAction.length === 0) {
    errors.push("recommendedNextAction_missing");
  }
  if (typeof result.summary !== "string" || result.summary.length === 0) errors.push("summary_missing");
  return { ok: errors.length === 0, errors };
}
