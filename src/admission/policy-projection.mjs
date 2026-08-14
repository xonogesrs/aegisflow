// src/admission/policy-projection.mjs
//
// TA-2 — policy projection（K, L, M, N, P, Q, R, S, T）.
//
// The single seam that turns a frozen admission record into every downstream
// projection:
//   admission → capability sets（required / allowed / denied）
//   admission → lifecycle / isolation / durability / memory / review /
//               repair / evidence / human-gate / review-surface decisions
//   admission → sub-agent envelope fields（toolPermissions + mutationScope）
//
// Envelope projection is the SINGLE enforcement surface（TA-1 integration
// map）: the agent NEVER self-selects permissions and the scheduler NEVER
// hardcodes them — both derive from admission. Writer enforcement（L）is
// fail-closed: writer capability must be in allowed_capabilities and every
// requested mutation path must be inside mutation_scope.

import { TOOL_PERMISSIONS } from "../subagent/subagent-contract.mjs";
import { resolveCapabilityId, capabilityRegistry, resolveCapability } from "./registry.mjs";

export const PROJECTION_SCHEMA = "autoloop.policy-projection/v1";

/**
 * TA-1 admission decision matrix（ta1-admission-decision-matrix.json）:
 * profile → 18 decision fields. Embedded snapshot; scripts/ta2-verify.mjs
 * re-checks parity against the docs artifact.
 */
export const PROFILE_MATRIX = Object.freeze({
  FAST_PATH: Object.freeze({
    direct_execution_allowed: true, decomposition_required: false, research_first_required: false,
    readonly_exploration_required: false, subagent_required: false, writer_allowed: true,
    isolated_worktree_required: false, colima_required: false, durable_execution_required: false,
    checkpoint_resume_required: false, memory_retrieval_allowed: false, memory_writeback_allowed: false,
    independent_review_required: false, repair_budget: 0, evidence_level: "none",
    external_review_required: false, closeout_bundle_required: false, human_controller_gate_required: false,
  }),
  STANDARD: Object.freeze({
    direct_execution_allowed: true, decomposition_required: false, research_first_required: false,
    readonly_exploration_required: false, subagent_required: true, writer_allowed: true,
    isolated_worktree_required: true, colima_required: true, durable_execution_required: false,
    checkpoint_resume_required: false, memory_retrieval_allowed: true, memory_writeback_allowed: false,
    independent_review_required: false, repair_budget: 1, evidence_level: "ephemeral",
    external_review_required: false, closeout_bundle_required: false, human_controller_gate_required: false,
  }),
  LARGE_LOW: Object.freeze({
    direct_execution_allowed: false, decomposition_required: true, research_first_required: true,
    readonly_exploration_required: true, subagent_required: true, writer_allowed: true,
    isolated_worktree_required: true, colima_required: true, durable_execution_required: true,
    checkpoint_resume_required: true, memory_retrieval_allowed: true, memory_writeback_allowed: false,
    independent_review_required: true, repair_budget: 2, evidence_level: "persistent",
    external_review_required: false, closeout_bundle_required: true, human_controller_gate_required: false,
  }),
  MEDIUM: Object.freeze({
    direct_execution_allowed: true, decomposition_required: false, research_first_required: false,
    readonly_exploration_required: false, subagent_required: true, writer_allowed: true,
    isolated_worktree_required: true, colima_required: true, durable_execution_required: false,
    checkpoint_resume_required: false, memory_retrieval_allowed: true, memory_writeback_allowed: false,
    independent_review_required: true, repair_budget: 1, evidence_level: "ephemeral",
    external_review_required: false, closeout_bundle_required: false, human_controller_gate_required: false,
  }),
  MEDIUM_LARGE: Object.freeze({
    direct_execution_allowed: false, decomposition_required: true, research_first_required: true,
    readonly_exploration_required: true, subagent_required: true, writer_allowed: true,
    isolated_worktree_required: true, colima_required: true, durable_execution_required: true,
    checkpoint_resume_required: true, memory_retrieval_allowed: true, memory_writeback_allowed: false,
    independent_review_required: true, repair_budget: 2, evidence_level: "persistent",
    external_review_required: false, closeout_bundle_required: true, human_controller_gate_required: false,
  }),
  HIGH: Object.freeze({
    direct_execution_allowed: false, decomposition_required: true, research_first_required: true,
    readonly_exploration_required: true, subagent_required: true, writer_allowed: true,
    isolated_worktree_required: true, colima_required: true, durable_execution_required: true,
    checkpoint_resume_required: true, memory_retrieval_allowed: true, memory_writeback_allowed: false,
    independent_review_required: true, repair_budget: 1, evidence_level: "persistent",
    external_review_required: true, closeout_bundle_required: true, human_controller_gate_required: true,
  }),
  CRITICAL: Object.freeze({
    direct_execution_allowed: false, decomposition_required: true, research_first_required: true,
    readonly_exploration_required: true, subagent_required: true, writer_allowed: true,
    isolated_worktree_required: true, colima_required: true, durable_execution_required: true,
    checkpoint_resume_required: true, memory_retrieval_allowed: true, memory_writeback_allowed: false,
    independent_review_required: true, repair_budget: 1, evidence_level: "persistent",
    external_review_required: true, closeout_bundle_required: true, human_controller_gate_required: true,
  }),
});

/**
 * Project the profile's policy vector（admission record fields）from a
 * classified profile.
 */
export function projectProfilePolicies(profile) {
  const d = PROFILE_MATRIX[profile];
  if (!d) throw new Error(`unknown profile: ${profile}`);
  return {
    lifecycle_profile: {
      direct_execution_allowed: d.direct_execution_allowed,
      decomposition_required: d.decomposition_required,
      decomposition_depth_bound: d.decomposition_required ? (d.repair_budget >= 2 ? 64 : 32) : null,
      research_first_required: d.research_first_required,
      readonly_exploration_required: d.readonly_exploration_required,
      subagent_required: d.subagent_required,
      writer_allowed: d.writer_allowed,
    },
    isolation_policy: d.colima_required ? "colima" : d.isolated_worktree_required ? "worktree" : d.direct_execution_allowed ? "none" : "host",
    durability_policy: d.durable_execution_required ? (d.checkpoint_resume_required ? "durable_resume" : "durable") : "ephemeral",
    memory_policy: { retrieval_allowed: d.memory_retrieval_allowed, writeback_allowed: d.memory_writeback_allowed },
    review_policy: {
      strength: d.external_review_required ? "external" : d.independent_review_required ? "independent" : "deterministic",
      independent_review_required: d.independent_review_required,
      external_review_required: d.external_review_required,
      strict_reviewer_routing: false, // filled from risk by the caller
    },
    repair_budget: d.repair_budget,
    evidence_policy: d.evidence_level,
    human_gates: d.human_controller_gate_required
      ? ["controller_pre_execution", ...(d.external_review_required ? ["controller_closeout"] : [])]
      : [],
    review_surface_policy: {
      authoritative_single_surface: true,
      chain: "linear",
      generation_policy: d.closeout_bundle_required || d.external_review_required
        ? ["supersede_previous", "preserve_history", "self_contained_chain", "no_chat_dependence", "revalidate_before_delivery"]
        : [],
    },
  };
}

/**
 * Project capability sets（CAP.* ids）for a profile（deny-by-default:
 * everything not required/allowed is denied）.
 *
 * @param {string} profile
 * @param {string} risk — canonical risk tier（drives strict routing grants）
 * @returns {{ required: string[], allowed: string[], denied: string[] }}
 */
export function projectCapabilities({ profile, risk }) {
  const d = PROFILE_MATRIX[profile];
  const required = [];
  const allowed = [];
  const deny = (id) => id;
  const denied = [];

  const cap = (alias) => resolveCapabilityId(alias); // alias -> CAP.*
  if (!d) throw new Error(`unknown profile: ${profile}`);

  // Every profile other than FAST_PATH engages the graph scheduler.
  if (!d.direct_execution_allowed) required.push(cap("subagent")); // scheduler implies sub-agents
  if (d.subagent_required) required.push(cap("subagent"));
  if (d.decomposition_required) required.push(cap("decomposition"));
  if (d.research_first_required || d.readonly_exploration_required) required.push(cap("research_first"));
  // CAP.WRITER_SUBAGENT is the ISOLATED sub-agent writer（dedicated worktree）:
  //   - required when worktree isolation is mandated（MEDIUM+ / HIGH / CRITICAL）
  //   - allowed when the profile may choose a sub-agent writer over direct
  //     execution（MEDIUM: writer_allowed && subagent_required && direct ok）
  //   - NOT granted on FAST_PATH（writer_allowed=true means in-place direct
  //     mutation, which needs no sub-agent writer capability — the sample
  //     admission denies it explicitly）
  if (d.writer_allowed && d.isolated_worktree_required) required.push(cap("writer"));
  else if (d.writer_allowed && d.subagent_required) allowed.push(cap("writer"));
  if (d.isolated_worktree_required) required.push(cap("worktree"));
  if (d.colima_required) required.push(cap("colima"));
  if (d.durable_execution_required) required.push(cap("durable_execution"));
  if (d.checkpoint_resume_required) required.push(cap("checkpoint_resume"));
  if (d.independent_review_required) required.push(cap("independent_review"));
  if (d.closeout_bundle_required) required.push(cap("review_bundle"));
  if (d.external_review_required) required.push(cap("external_review"));
  if (d.memory_retrieval_allowed) allowed.push(cap("memory_retrieval"));
  if (d.memory_writeback_allowed) allowed.push(cap("memory_writeback"));
  if (d.direct_execution_allowed) allowed.push(cap("direct_execution"));

  // Deny-by-default: every registry capability not granted is explicitly
  // denied（fail-closed enumeration; NEG4）。
  const granted = new Set([...required, ...allowed].filter(Boolean));
  for (const id of Object.keys(capabilityRegistry())) {
    if (!granted.has(id)) denied.push(id);
  }
  const uniq = (a) => [...new Set(a.filter(Boolean))].sort();
  return { required: uniq(required), allowed: uniq(allowed), denied: uniq(denied) };
}

/**
 * Project sub-agent ENVELOPE fields from the admission record（K）— the
 * single enforcement seam.
 *
 * @param {object} admission — frozen admission record
 * @param {string} nodeRole — readonly-analyst | writer | repairer | reviewer |
 *        verifier | join
 * @param {object} [opts] — { mutationScopeFromPhase: string[] } — the
 *        decomposition's declared artifact boundary（admission must CONTAIN
 *        it; intersection enforced, L）.
 * @returns {{ toolPermissions: string[], mutationScope: string[] | null,
 *             authorizedPaths: string[], writerAllowed: boolean }}
 *          — throws AdmissionEnvelopeError on any fail-closed violation.
 */
export class AdmissionEnvelopeError extends Error {
  constructor(code, reason) {
    super(`admission_envelope: ${reason}`);
    this.name = "AdmissionEnvelopeError";
    this.code = code;
  }
}

export function projectEnvelopeFields({ admission, nodeRole, mutationScopeFromPhase = [] } = {}) {
  if (!admission || typeof admission !== "object") {
    throw new AdmissionEnvelopeError("ADMISSION_INVALID", "no admission record");
  }
  const granted = new Set([...(admission.capabilities?.required ?? []), ...(admission.capabilities?.allowed ?? [])].map(resolveCapabilityId).filter(Boolean));
  const writerCap = resolveCapabilityId("writer");
  const isWriterRole = nodeRole === "writer" || nodeRole === "repairer";
  const writerAllowed = granted.has(writerCap);

  // Read-only roles: only READ_ONLY tools; never write.
  if (!isWriterRole) {
    return {
      toolPermissions: [...TOOL_PERMISSIONS.READ_ONLY],
      mutationScope: null,
      authorizedPaths: ["/src", "/scratch", "/results"],
      writerAllowed,
    };
  }

  // Writer / repairer roles（L）— fail-closed:
  //   1. writer capability must be granted by admission（NEG3）
  //   2. every requested mutation path must be inside admission.mutation_scope
  if (!writerAllowed) {
    throw new AdmissionEnvelopeError("ADMISSION_MUTATION_SCOPE_VIOLATION", `writer capability not granted by admission (nodeRole=${nodeRole})`);
  }
  const admissionScope = normalizeScope(admission.mutation_scope ?? []);
  if (admissionScope.length === 0) {
    throw new AdmissionEnvelopeError("ADMISSION_MUTATION_SCOPE_VIOLATION", "admission grants writer but mutation_scope is empty");
  }
  // Decomposition-declared boundary must be a SUBSET of the admission scope
  //（admission only narrows）; anything outside -> HOLD（L）。
  for (const p of mutationScopeFromPhase ?? []) {
    if (!withinScope(p, admissionScope)) {
      throw new AdmissionEnvelopeError("ADMISSION_MUTATION_SCOPE_VIOLATION", `phase boundary ${p} outside admission.mutation_scope`);
    }
  }
  const effectiveScope = (mutationScopeFromPhase?.length ? mutationScopeFromPhase : admissionScope).slice();
  return {
    toolPermissions: [...TOOL_PERMISSIONS.READ_ONLY, ...TOOL_PERMISSIONS.SCRATCH_WRITE],
    mutationScope: effectiveScope,
    authorizedPaths: ["/src", "/work", "/scratch", "/results"],
    writerAllowed,
  };
}

function normalizeScope(paths) {
  return (paths ?? []).map((p) => String(p).replace(/\/+$/, "")).filter(Boolean);
}

function withinScope(path, scope) {
  const np = String(path).replace(/\/+$/, "");
  // path is inside scope iff path == scope OR path starts with scope + "/".
  return scope.some((s) => np === s || np.startsWith(s + "/"));
}

/**
 * Writer mutation-scope enforcement（L）: requested paths must be inside the
 * admission scope. Pure check — throws on violation.
 */
export function assertMutationWithinAdmissionScope(admission, requestedPaths) {
  const scope = normalizeScope(admission?.mutation_scope ?? []);
  for (const p of requestedPaths ?? []) {
    if (!withinScope(p, scope)) {
      throw new AdmissionEnvelopeError("ADMISSION_MUTATION_SCOPE_VIOLATION", `path ${p} outside admission.mutation_scope`);
    }
  }
  return true;
}

/**
 * Assemble the full admission record from a classification result + evidence
 *（produces the schema-compliant record; caller freezes it）.
 */
export function buildAdmissionRecord({ taskId, classification, authorityRecordDigest = null, mutationScope = [], decisionTime = null, extensions = {} } = {}) {
  const profilePolicies = projectProfilePolicies(classification.profile);
  const caps = projectCapabilities({ profile: classification.profile, risk: classification.risk });
  const strict = classification.risk === "HIGH" || classification.risk === "CRITICAL";
  // Tool permission projection（K）: the union of required_permissions over
  // the granted capabilities — the envelope tool policy the admission grants
  //（audit view; enforcement happens in the envelope builder from the same
  // capability set）.
  const toolPermissions = [...new Set(
    [...caps.required, ...caps.allowed]
      .map((id) => resolveCapability(id)?.required_permissions ?? [])
      .flat(),
  )].sort();
  return {
    schema: "autoloop.task-admission/v1",
    schema_version: 1,
    task_id: taskId,
    decision_time: decisionTime ?? new Date().toISOString(),
    classifier_version: classification.classifier_version,
    size: classification.size,
    risk: classification.risk,
    profile: classification.profile,
    size_details: classification.size_details,
    risk_details: classification.risk_details,
    reasons: classification.reasons,
    capabilities: caps,
    lifecycle_profile: profilePolicies.lifecycle_profile,
    isolation_policy: profilePolicies.isolation_policy,
    durability_policy: profilePolicies.durability_policy,
    memory_policy: profilePolicies.memory_policy,
    review_policy: { ...profilePolicies.review_policy, strict_reviewer_routing: strict },
    repair_budget: profilePolicies.repair_budget,
    evidence_policy: profilePolicies.evidence_policy,
    human_gates: profilePolicies.human_gates,
    review_surface_policy: profilePolicies.review_surface_policy,
    authority_binding: {
      authority_record_digest: authorityRecordDigest ?? "0000000000000000000000000000000000000000000000000000000000000000",
      subset_of_lifecycle_authorization: true,
    },
    fail_closed: true,
    mutation_scope: [...(mutationScope ?? [])],
    tool_permissions: toolPermissions,
    ...(Object.keys(extensions ?? {}).length ? { extensions } : {}),
  };
}
