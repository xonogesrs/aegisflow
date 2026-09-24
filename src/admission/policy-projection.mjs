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
//
// Scope decisions here are CANONICAL（c2d/mutation-scope.mjs is the single
// path-canonicalization seam）: a mutation_scope entry or phase boundary that
// is unresolvable, ambiguous, absolute, or lexically/canonically escaping is
// refused at projection time, so this projection can never report
// "authorized" for a boundary the enforcement gate canonicalizes away.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { TOOL_PERMISSIONS } from "../subagent/subagent-contract.mjs";
import { resolveCapabilityId, capabilityRegistry, resolveCapability } from "./registry.mjs";
import { resolveExecutable } from "../shared/autoloop-paths.mjs";
import { canonicalScopeEntry, canonicalScopeEntries, isWithinCanonicalScope } from "../c2d/mutation-scope.mjs";

export const PROJECTION_SCHEMA = "autoloop.policy-projection/v1";

// Executor runtime vocabulary. The runtime is ADMISSION-DERIVED from the
// isolation/durability policy — never optimizer/caller-selected (CP-1 §3;
// CP-2R2 Finding 5). Admission owns this mapping; the Control Plane consumes
// it, it does not mint a second copy.
export const EXECUTOR_RUNTIMES = Object.freeze(["direct", "colima", "subagent", "durable"]);

/**
 * Derive the executor runtime STRICTLY from the frozen admission's
 * isolation/durability policy (CP-1: runtime is admission-derived, not
 * optimizer-selected). Unknown/contradictory policies → null (fail closed),
 * never a permissive fallback.
 */
export function deriveExecutorRuntime(admission) {
  if (!admission || typeof admission !== "object" || Array.isArray(admission)) return null;
  const durability = admission.durability_policy;
  const isolation = admission.isolation_policy;
  if (durability === "durable" || durability === "durable_resume") return "durable";
  if (isolation === "colima") return "colima";
  if (isolation === "worktree") return "subagent";
  if (admission.profile === "FAST_PATH") return "direct";
  return null;
}

/**
 * R-10 (AUTH1) — the single authoritative retrieval-authority predicate.
 *
 * Retrieval is authorized IFF the admitted policy projection explicitly
 * declares `memory_policy.retrieval_allowed === true`. Provider availability
 * is NEVER authority: missing / false / malformed (non-boolean) authority
 * fails closed (no retrieval).
 */
export function isRetrievalAuthorized(admission) {
  return admission?.memory_policy?.retrieval_allowed === true;
}

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
 * Scope semantics（L）: the phase boundary is resolved with the SAME
 * canonical semantics the enforcement gate uses（c2d/mutation-scope.mjs）and
 * compared component-wise against the canonical admission scope. A boundary
 * or scope entry that is unresolvable, ambiguous, absolute, lexically
 * escaping or canonically escaping is NEVER authorized — it fails closed
 * HERE, so the projection cannot say "allowed" where `enforceScopeGate` would
 * say "denied".
 *
 * @param {object} admission — frozen admission record
 * @param {string} nodeRole — readonly-analyst | writer | repairer | reviewer |
 *        verifier | join
 * @param {object} [opts] — { mutationScopeFromPhase: string[] } — the
 *        decomposition's declared artifact boundary（admission must CONTAIN
 *        it; intersection enforced, L）;
 *        { repositoryRoot: string|null } — the root the boundaries are
 *        relative to（the isolated worktree for a writer phase）. When known,
 *        entries resolve with the gate's full canonicalization（root
 *        containment + symlink rejection）; when unknown, lexical
 *        canonicalization only（the enforcement gate stays authoritative）.
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

export function projectEnvelopeFields({ admission, nodeRole, mutationScopeFromPhase = [], repositoryRoot = null } = {}) {
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
  //   2. admission.mutation_scope must be a CANONICAL repository-relative
  //      scope（a non-canonical / escaping / glob entry grants nothing）
  //   3. every requested mutation path must be canonical AND inside it
  if (!writerAllowed) {
    throw new AdmissionEnvelopeError("ADMISSION_MUTATION_SCOPE_VIOLATION", `writer capability not granted by admission (nodeRole=${nodeRole})`);
  }
  const admissionScope = canonicalScopeEntries(admission.mutation_scope ?? [], repositoryRoot);
  if (admissionScope === null) {
    throw new AdmissionEnvelopeError("ADMISSION_MUTATION_SCOPE_VIOLATION", `admission.mutation_scope is not a canonical repository-relative scope: ${JSON.stringify(admission.mutation_scope ?? [])}`);
  }
  if (admissionScope.length === 0) {
    throw new AdmissionEnvelopeError("ADMISSION_MUTATION_SCOPE_VIOLATION", "admission grants writer but mutation_scope is empty");
  }
  // Decomposition-declared boundary must be a SUBSET of the admission scope
  //（admission only narrows）; anything outside -> HOLD（L）。
  const phaseBoundaries = [];
  for (const p of mutationScopeFromPhase ?? []) {
    const canonical = canonicalScopeEntry(p, repositoryRoot);
    if (canonical === null) {
      throw new AdmissionEnvelopeError("ADMISSION_MUTATION_SCOPE_VIOLATION", `phase boundary ${String(p)} is not a canonical repository-relative path`);
    }
    if (!isWithinCanonicalScope(canonical, admissionScope)) {
      throw new AdmissionEnvelopeError("ADMISSION_MUTATION_SCOPE_VIOLATION", `phase boundary ${String(p)} outside admission.mutation_scope`);
    }
    if (!phaseBoundaries.includes(canonical)) phaseBoundaries.push(canonical);
  }
  const effectiveScope = phaseBoundaries.length ? phaseBoundaries : admissionScope.slice();
  return {
    toolPermissions: [...TOOL_PERMISSIONS.READ_ONLY, ...TOOL_PERMISSIONS.SCRATCH_WRITE],
    mutationScope: effectiveScope,
    authorizedPaths: ["/src", "/work", "/scratch", "/results"],
    writerAllowed,
  };
}

/**
 * Writer mutation-scope enforcement（L）: requested paths must be canonical and
 * inside the canonical admission scope. Pure check — throws on violation.
 * `repositoryRoot`（optional）selects the gate's full canonicalization for the
 * same root-aware agreement as `projectEnvelopeFields`.
 */
export function assertMutationWithinAdmissionScope(admission, requestedPaths, { repositoryRoot = null } = {}) {
  const scope = canonicalScopeEntries(admission?.mutation_scope ?? [], repositoryRoot);
  if (scope === null) {
    throw new AdmissionEnvelopeError("ADMISSION_MUTATION_SCOPE_VIOLATION", `admission.mutation_scope is not a canonical repository-relative scope: ${JSON.stringify(admission?.mutation_scope ?? [])}`);
  }
  for (const p of requestedPaths ?? []) {
    const canonical = canonicalScopeEntry(p, repositoryRoot);
    if (canonical === null || !isWithinCanonicalScope(canonical, scope)) {
      throw new AdmissionEnvelopeError("ADMISSION_MUTATION_SCOPE_VIOLATION", `path ${String(p)} outside admission.mutation_scope`);
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

// ═══════════════════════════════════════════════════════════════════════
// STAGE C — TOOL_SELECTION_CONTRACT_V1 (FROZEN, REV 3)
// AUTOLOOP-V1-STAGE-C-REGISTRY-BACKED-TASK-SPECIFIC-TOOL-SELECTION-1
//
// THE single registry-backed task-specific tool selector. One pure
// projection (projectToolSelection), one validator (validateToolSelection)
// reused verbatim by the pi adapter, one issuance-authentication resolver
// factory (createLifecycleSelectionAuthority). No second catalog, no second
// selector, no second executor: everything below derives from the EXISTING
// authorities — src/admission/registry.mjs capabilities,
// TOOL_PERMISSIONS vocabulary, projectEnvelopeFields, admission records —
// plus ONE frozen adapter projection onto the pinned Pi runtime surface.
//
// Identity layers (contract §1) are NEVER conflated:
//   CANONICAL_TOOL_ID / TOOL_PERMISSION_ID — agent-neutral permission ids
//   ADAPTER_TOOL_NAME                      — Pi-runtime-specific names
// Pi is only the FIRST adapterKind projection; adding another adapterKind
// requires new mapping ROWS under the SAME schema/authority, never a new
// catalog or selector.
// ═══════════════════════════════════════════════════════════════════════

import { canonicalize, digestOf } from "../canonical-digest.mjs";
import { admissionDigest } from "./admission-record.mjs";

export const TOOL_SELECTION_SCHEMA = "autoloop.tool-selection/v1";
export const RUNTIME_VOCABULARY_SCHEMA = "autoloop.runtime-vocabulary/v1";
export const TOOL_MAPPING_SCHEMA = "autoloop.tool-mapping/v1";
export const TOOL_SELECTION_REGISTRY_DIGEST_SCHEMA = "autoloop.tool-selection-registry/v1";
export const PI_ADAPTER_KIND = "pi-builtin";

/** Frozen failure codes (failure-code-analysis.md) — exactly ten, no others. */
export const TOOL_SELECTION_FAILURE_CODES = Object.freeze([
  "TOOL_SELECTION_CONTRACT_MISSING",
  "TOOL_SELECTION_TASK_INTENT_MISSING",
  "TOOL_SELECTION_PERMISSION_UNMAPPED",
  "TOOL_SELECTION_TOOL_UNAUTHORIZED",
  "TOOL_SELECTION_TOOL_REVOKED",
  "TOOL_SELECTION_UNKNOWN_CANONICAL_TOOL",
  "TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT",
  "TOOL_SELECTION_MAPPING_DRIFT",
  "TOOL_SELECTION_PROVENANCE_INVALID",
  "TOOL_SELECTION_REQUIRED_TOOL_UNAVAILABLE",
]);

/**
 * THE pinned (frozen) executor runtime identity for adapterKind=pi-builtin.
 *
 * This is the contract authority the §4 drift fence compares an OBSERVED
 * runtime against. It is CONFIGURATION, not a hardcoded install path:
 *
 *   AUTOLOOP_PI_RUNTIME_PATH     absolute path to the `pi` CLI entry point
 *   AUTOLOOP_PI_RUNTIME_SHA256   expected sha256 of that file (optional:
 *                                computed from the file when absent)
 *   AUTOLOOP_PI_RUNTIME_VERSION  expected version string (optional)
 *
 * When AUTOLOOP_PI_RUNTIME_PATH is unset the identity is self-observed from
 * the `pi` executable found on PATH, so a fresh checkout works without
 * configuration while still pinning exactly one artifact for the run.
 *
 * Fail-closed: when no `pi` executable can be found the resolver throws
 * TOOL_SELECTION_CONTRACT_MISSING — there is never a permissive fallback
 * identity. Resolution is memoized per (path, sha, version) tuple.
 */
export const PI_RUNTIME_PATH_ENV = "AUTOLOOP_PI_RUNTIME_PATH";
export const PI_RUNTIME_SHA256_ENV = "AUTOLOOP_PI_RUNTIME_SHA256";
export const PI_RUNTIME_VERSION_ENV = "AUTOLOOP_PI_RUNTIME_VERSION";

const runtimeIdentityCache = new Map();

/** Absolute path of the `pi` executable, from env override or PATH. */
export function resolvePiExecutable({ env = process.env } = {}) {
  const override = env?.[PI_RUNTIME_PATH_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    if (!isAbsolute(override.trim())) {
      throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", `${PI_RUNTIME_PATH_ENV} must be an absolute path: ${override}`);
    }
    return override.trim();
  }
  return resolveExecutable("pi", { env });
}

/**
 * Resolve the pinned runtime identity. Throws TOOL_SELECTION_CONTRACT_MISSING
 * when the runtime cannot be located, and TOOL_SELECTION_CONTRACT_MISSING on
 * an unreadable artifact — never a guessed identity.
 */
export function frozenRuntimeIdentity({ env = process.env, resolveExecutablePath = resolvePiExecutable, existsOf = existsSync } = {}) {
  const candidate = resolveExecutablePath({ env });
  const shaOverride = typeof env?.[PI_RUNTIME_SHA256_ENV] === "string" && env[PI_RUNTIME_SHA256_ENV].trim().length > 0
    ? env[PI_RUNTIME_SHA256_ENV].trim()
    : null;
  const version = typeof env?.[PI_RUNTIME_VERSION_ENV] === "string" && env[PI_RUNTIME_VERSION_ENV].trim().length > 0
    ? env[PI_RUNTIME_VERSION_ENV].trim()
    : null;
  const cacheKey = `${candidate}\u0000${shaOverride ?? ""}\u0000${version ?? ""}`;
  const cached = runtimeIdentityCache.get(cacheKey);
  if (cached) return cached;

  if (typeof candidate !== "string" || candidate.length === 0 || !isAbsolute(candidate)) {
    throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", `pi runtime executable not resolvable; set ${PI_RUNTIME_PATH_ENV}`);
  }
  // The identity must point at a concrete, existing artifact.
  const located = candidate;
  if (!existsOf(located)) {
    throw new ToolSelectionError(
      "TOOL_SELECTION_CONTRACT_MISSING",
      `pi runtime executable not found at ${located ?? candidate}; set ${PI_RUNTIME_PATH_ENV} to its absolute path`,
    );
  }
  const real = realpathSync(located);
  const sha256 = shaOverride ?? createHash("sha256").update(readFileSync(real)).digest("hex");
  const identity = Object.freeze({ realpath: real, sha256, version });
  runtimeIdentityCache.set(cacheKey, identity);
  return identity;
}

/**
 * The identity in effect for THIS process, resolved lazily on first use so
 * importing this module never requires a `pi` installation (tests, docs and
 * every non-Pi consumer keep working in a bare checkout).
 */
export function currentRuntimeIdentity() {
  return frozenRuntimeIdentity();
}

/**
 * Backwards-compatible view of the pinned identity.
 *
 * Properties resolve on ACCESS (not at import), so a bare checkout that never
 * touches tool selection can still import this module, and a caller that reads
 * `.realpath` without a `pi` installation gets the same fail-closed
 * TOOL_SELECTION_CONTRACT_MISSING the functions raise. Prefer
 * `frozenRuntimeIdentity()` in new code — it makes the resolution explicit.
 */
export const FROZEN_RUNTIME_IDENTITY = Object.freeze({
  get realpath() { return frozenRuntimeIdentity().realpath; },
  get sha256() { return frozenRuntimeIdentity().sha256; },
  get version() { return frozenRuntimeIdentity().version; },
});

/** FROZEN runtime vocabulary — bytewise-sorted exact names. */
export const FROZEN_RUNTIME_TOOL_NAMES = Object.freeze(
  ["bash", "edit", "find", "grep", "ls", "read", "write"].sort()
);

export const FROZEN_RUNTIME_VOCABULARY_DIGEST =
  "86dac294a94b7c16d6a337fc792ff40695c8d785f27de95314b1a9de5bd72301";

export const TOOL_SELECTION_MAPPING_VERSION = 1;

/**
 * FROZEN permission→tool mapping V1 (contract §5). bash is UNMAPPED in V1:
 * arbitrary-execution surface, never selectable. fs.stat is a zero-projection
 * row: grants nothing alone, inert inside a mixed selection.
 *
 * Rows carry agent-neutral canonicalToolId / requiredPermissionId and an
 * adapter-specific projection (adapterKind + adapterToolNames). A future
 * adapter adds NEW rows under a different adapterKind through THIS
 * authority — never a second catalog.
 */
export const TOOL_SELECTION_MAPPING = Object.freeze([
  Object.freeze({
    canonicalToolId: "fs.read",
    requiredPermissionId: "fs.read",
    adapterKind: PI_ADAPTER_KIND,
    adapterToolNames: Object.freeze(["read"]),
    runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
    mappingVersion: TOOL_SELECTION_MAPPING_VERSION,
    status: "ACTIVE",
  }),
  Object.freeze({
    canonicalToolId: "fs.grep",
    requiredPermissionId: "fs.grep",
    adapterKind: PI_ADAPTER_KIND,
    adapterToolNames: Object.freeze(["grep"]),
    runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
    mappingVersion: TOOL_SELECTION_MAPPING_VERSION,
    status: "ACTIVE",
  }),
  Object.freeze({
    canonicalToolId: "fs.list",
    requiredPermissionId: "fs.list",
    adapterKind: PI_ADAPTER_KIND,
    adapterToolNames: Object.freeze(["ls", "find"]),
    runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
    mappingVersion: TOOL_SELECTION_MAPPING_VERSION,
    status: "ACTIVE",
  }),
  Object.freeze({
    canonicalToolId: "fs.stat",
    requiredPermissionId: "fs.stat",
    adapterKind: PI_ADAPTER_KIND,
    adapterToolNames: Object.freeze([]),
    runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
    mappingVersion: TOOL_SELECTION_MAPPING_VERSION,
    status: "ACTIVE",
  }),
  Object.freeze({
    canonicalToolId: "fs.write-scratch",
    requiredPermissionId: "fs.write-scratch",
    adapterKind: PI_ADAPTER_KIND,
    adapterToolNames: Object.freeze(["edit", "write"]),
    runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
    mappingVersion: TOOL_SELECTION_MAPPING_VERSION,
    status: "ACTIVE",
  }),
]);

/** Fail-closed selection error carrying its exact frozen hold code. */
export class ToolSelectionError extends Error {
  constructor(code, reason) {
    super(`tool_selection: ${code}: ${reason}`);
    this.name = "ToolSelectionError";
    this.code = code;
    this.holdCode = code;
  }
}

/** Domain-separated digest: sha256(schema + "\n" + canonical + "\n"). */
function domainDigest(schema, canonicalJsonText) {
  return createHash("sha256").update(`${schema}\n${canonicalJsonText}\n`, "utf8").digest("hex");
}

/**
 * Contract §3 canonicalization of a name set: UTF-8 exact case (trim
 * FORBIDDEN, never silently applied); duplicates, empty strings, control
 * chars (\x00-\x1F,\x7F), comma, newline, NUL all fail closed; output is
 * bytewise-sorted unique strings.
 */
export function canonicalizeNameSet(names, { schemaLabel = "name set" } = {}) {
  if (!Array.isArray(names)) throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", `${schemaLabel} must be an array`);
  const seen = new Set();
  for (const n of names) {
    if (typeof n !== "string") throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", `${schemaLabel} entry is not a string`);
    if (n.length === 0) throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", `${schemaLabel} contains an empty string`);
    if (seen.has(n)) throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", `${schemaLabel} duplicate entry: ${n}`);
    for (const ch of n) {
      const c = ch.codePointAt(0);
      if (c <= 0x1f || c === 0x7f || ch === "," || ch === "\n" || ch === "\0") {
        throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", `${schemaLabel} forbidden character in entry`);
      }
    }
    seen.add(n);
  }
  return [...seen].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
}

/** §3 vocabulary digest over a sorted name array. */
export function computeRuntimeVocabularyDigest(sortedNames) {
  return domainDigest(RUNTIME_VOCABULARY_SCHEMA, JSON.stringify(sortedNames));
}

// Module-load self-check: the frozen vocabulary MUST reproduce its frozen
// digest (drift-fence integrity; T1 anchors this independently).
if (computeRuntimeVocabularyDigest([...FROZEN_RUNTIME_TOOL_NAMES]) !== FROZEN_RUNTIME_VOCABULARY_DIGEST) {
  throw new Error("CAPABILITY_REGISTRY_DRIFT: frozen runtime vocabulary digest mismatch");
}

/** §3 mapping digest over the bytewise-sorted mapping-row array. */
export function computeMappingDigest(rows = TOOL_SELECTION_MAPPING) {
  const sorted = [...rows].sort((a, b) =>
    Buffer.compare(Buffer.from(a.canonicalToolId, "utf8"), Buffer.from(b.canonicalToolId, "utf8")));
  return domainDigest(TOOL_MAPPING_SCHEMA, canonicalize(sorted));
}

export const FROZEN_MAPPING_DIGEST = computeMappingDigest();

/**
 * §3 REGISTRY_DIGEST (REV 2): over the sorted array of
 * { capability_id, required_permissions, default_state } rows for EVERY
 * capability id in (admission.capabilities.required ∪ allowed). Recomputed
 * by the validator — never accepted from a payload.
 */
export function computeRegistryDigest(admission) {
  const reg = capabilityRegistry();
  const ids = new Set();
  for (const raw of [...(admission?.capabilities?.required ?? []), ...(admission?.capabilities?.allowed ?? [])]) {
    const id = resolveCapabilityId(raw);
    if (!id) continue; // unknown ids fail separately as UNKNOWN_CANONICAL_TOOL
    ids.add(id);
  }
  const rows = [...ids].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")))
    .map((id) => ({ capability_id: id, required_permissions: reg[id].required_permissions, default_state: reg[id].default_state }));
  return domainDigest(TOOL_SELECTION_REGISTRY_DIGEST_SCHEMA, canonicalize(rows));
}

/**
 * Observe the ACTUAL pinned runtime identity pre-bind (§4 drift fence):
 * realpath resolution + file sha256. Version is supplied only by explicit
 * introspection (never guessed) — null here means "not observed".
 */
export function observeRuntimeIdentity({ executablePath = null } = {}) {
  const target = executablePath ?? frozenRuntimeIdentity().realpath;
  const real = realpathSync(target);
  const content = readFileSync(real);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { realpath: real, sha256, version: null };
}

/**
 * Parse the "Built-in Tool Names" surface out of captured `pi --help` text.
 * Pure: tests drive the REAL binary; production composition may cache one
 * capture per process. Names are never invented here.
 */
export function parsePiBuiltinToolNames(helpText) {
  const lines = String(helpText).split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /built[- ]in tool names/i.test(l.trim()));
  if (startIdx === -1) return null;
  // Bullet surface: "  <name>  - <description>" until the first non-bullet line.
  const seen = new Set();
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+([a-z][a-z0-9-]*)\s+-\s+/);
    if (!m) break;
    seen.add(m[1]);
  }
  return canonicalizeNameSet([...seen], { schemaLabel: "captured runtime vocabulary" });
}

const SELECTION_ROLES = ["readonly-analyst", "writer", "repairer", "reviewer", "verifier", "join"];

function permissionVocabularySet() {
  return new Set([...TOOL_PERMISSIONS.READ_ONLY, ...TOOL_PERMISSIONS.SCRATCH_WRITE]);
}

// Row consumption is ADAPTER-KIND SCOPED: this projection implements
// adapterKind=pi-builtin. ACTIVE rows of OTHER kinds (future omp/codex)
// are invisible here — adding them can never poison existing projections.
// A second kind ships its own projection constants alongside these rows in
// THIS single mapping authority (never a second catalog).
function activeRowsFor(permissionId, rows, kind = PI_ADAPTER_KIND) {
  return rows.filter((r) => r.requiredPermissionId === permissionId && r.status === "ACTIVE" && r.adapterKind === kind);
}

/**
 * §6.1 taskToolIntent: nodeRole ∈ selection roles ⇒ per-node-role envelope
 * projection (the frozen TASK_INTENT_AUTHORITY formula); nodeRole == null
 * (direct/FAST_PATH execution — no sub-agent role exists) ⇒ the admission's
 * own tool_permissions upper bound. Caller hooks / prompt / raw toolPolicy
 * have ZERO influence anywhere in this function.
 */
function taskToolIntent({ admission, nodeRole }) {
  const vocab = permissionVocabularySet();
  // Registry/admission references use envelope CLASS KEYS (READ_ONLY /
  // SCRATCH_WRITE); canonical intent is the EXPANDED fs.* ids. Unknown
  // entries fail closed — never silently filtered.
  const expand = (entries) => {
    const out = [];
    for (const e of entries ?? []) {
      if (Object.prototype.hasOwnProperty.call(TOOL_PERMISSIONS, e)) {
        out.push(...TOOL_PERMISSIONS[e]);
      } else if (vocab.has(e)) {
        out.push(e);
      } else {
        throw new ToolSelectionError("TOOL_SELECTION_UNKNOWN_CANONICAL_TOOL", `intent permission outside registry-derived vocabulary: ${String(e)}`);
      }
    }
    return [...new Set(out)];
  };
  if (nodeRole === null || nodeRole === undefined) {
    return expand(admission.tool_permissions ?? []);
  }
  if (typeof nodeRole !== "string" || !SELECTION_ROLES.includes(nodeRole)) {
    throw new ToolSelectionError("TOOL_SELECTION_TASK_INTENT_MISSING", `unknown nodeRole: ${String(nodeRole)}`);
  }
  // Reviewer is hard-pinned no-tools by lifecycle-runner.mjs REVIEWER_TOOL_POLICY;
  // a reviewer reaching the selector is a bypass attempt, never a request.
  if (nodeRole === "reviewer" || nodeRole === "join") {
    throw new ToolSelectionError("TOOL_SELECTION_TASK_INTENT_MISSING", `role ${nodeRole} never selects tools (reviewer pin / non-executing role)`);
  }
  try {
    const envelope = projectEnvelopeFields({ admission, nodeRole });
    return envelope.toolPermissions.filter((p) => vocab.has(p));
  } catch (e) {
    if (e instanceof AdmissionEnvelopeError) {
      throw new ToolSelectionError("TOOL_SELECTION_TASK_INTENT_MISSING", `envelope projection failed: ${e.message}`);
    }
    throw e;
  }
}

/**
 * THE selector (§6.2). Pure, deterministic, fail-closed. Bound exactly once
 * per node dispatch. Drift checks run FIRST (REV 2 ordering); the mapping/
 * vocabulary intersection terms never silently drop a domain that a drift
 * check would have flagged.
 *
 * @param {object} p
 * @param {object} p.admission — THE frozen admission record (authoritative)
 * @param {string|null} p.nodeRole — selection role, or null for direct execution
 * @param {object} p.taskAllocation — authoritative allocation { taskId, admissionId, dimensions, allocationId }
 * @param {{realpath,sha256,version|null}} p.runtimeIdentity — OBSERVED actual runtime identity
 * @param {string} p.runtimeVocabularyDigest — observed/captured vocabulary digest
 * @param {string} p.executionId — runIdentity of THIS dispatch
 * @param {string} [p.selectedAt] — ISO instant override (tests); default now
 * @param {Array} [p.mappingRows] — mapping override (negative tests only; the
 *   adapter still validates every selection against FROZEN_MAPPING_DIGEST)
 * @returns {object} frozen autoloop.tool-selection/v1 selection output
 */
export function projectToolSelection({
  admission,
  nodeRole = null,
  taskAllocation,
  runtimeIdentity,
  runtimeVocabularyDigest,
  executionId,
  selectedAt,
  mappingRows = TOOL_SELECTION_MAPPING,
  frozenIdentity = null,
} = {}) {
  const frozen = frozenIdentity ?? frozenRuntimeIdentity();
  // ── 0. contract/mapping binding present (CONTRACT_MISSING otherwise) ──
  if (!admission || typeof admission !== "object") throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", "no frozen admission record");
  if (!taskAllocation || typeof taskAllocation !== "object") throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", "no authoritative task allocation");
  if (!runtimeIdentity || typeof runtimeIdentity !== "object") throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", "no observed runtime identity");
  if (typeof runtimeVocabularyDigest !== "string") throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", "no runtime vocabulary digest");
  if (typeof executionId !== "string" || executionId.length === 0) throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", "executionId (runIdentity) required");
  if (!Array.isArray(mappingRows) || mappingRows.length === 0) throw new ToolSelectionError("TOOL_SELECTION_CONTRACT_MISSING", "mapping binding missing");

  // ── 1. §4 drift checks FIRST: runtime identity + vocabulary digest ──
  if (runtimeIdentity.realpath !== frozen.realpath ||
      runtimeIdentity.sha256 !== frozen.sha256 ||
      (runtimeIdentity.version != null && frozen.version != null && runtimeIdentity.version !== frozen.version)) {
    throw new ToolSelectionError("TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT", "observed runtime identity != frozen contract identity");
  }
  if (runtimeVocabularyDigest !== FROZEN_RUNTIME_VOCABULARY_DIGEST) {
    throw new ToolSelectionError("TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT", "observed runtime vocabulary digest != frozen digest");
  }

  // ── 2. TASK_ALLOCATION_IDENTITY (§3 REV 2): coordinator allocation-binding digest ──
  if (typeof taskAllocation.allocationId !== "string" || taskAllocation.allocationId.length === 0) {
    throw new ToolSelectionError("TOOL_SELECTION_PROVENANCE_INVALID", "task allocation carries no allocationId binding digest");
  }
  const recomputedAllocationDigest = digestOf({
    taskId: taskAllocation.taskId,
    admissionId: taskAllocation.admissionId,
    dimensions: taskAllocation.dimensions,
  });
  if (recomputedAllocationDigest !== taskAllocation.allocationId) {
    throw new ToolSelectionError("TOOL_SELECTION_PROVENANCE_INVALID", "allocation binding digest mismatch (substituted/reconstructed allocation)");
  }
  if (taskAllocation.admissionId !== admission.admission_id) {
    throw new ToolSelectionError("TOOL_SELECTION_PROVENANCE_INVALID", "allocation bound to a different admission");
  }
  if (typeof admission.task_id === "string" && taskAllocation.taskId !== admission.task_id) {
    throw new ToolSelectionError("TOOL_SELECTION_PROVENANCE_INVALID", "allocation taskId != admission.task_id");
  }

  // ── 3. intent (§6.1), validated against the permission vocabulary ──
  const intent = taskToolIntent({ admission, nodeRole });
  const vocab = permissionVocabularySet();
  for (const p of intent) {
    if (!vocab.has(p)) throw new ToolSelectionError("TOOL_SELECTION_UNKNOWN_CANONICAL_TOOL", `intent permission outside registry-derived vocabulary: ${p}`);
  }

  // ── 4. allowed upper bound + registry-active permission universe ──
  // Registry/admission permission references use the envelope CLASS KEYS
  // (READ_ONLY / SCRATCH_WRITE); the contract's canonical vocabulary is the
  // EXPANDED fs.* ids. Expansion happens HERE and only here.
  const expandPermissions = (entries, label) => {
    const out = [];
    for (const e of entries ?? []) {
      if (Object.prototype.hasOwnProperty.call(TOOL_PERMISSIONS, e)) {
        out.push(...TOOL_PERMISSIONS[e]);
      } else if (vocab.has(e)) {
        out.push(e);
      } else {
        throw new ToolSelectionError("TOOL_SELECTION_UNKNOWN_CANONICAL_TOOL", `${label} outside registry-derived vocabulary: ${String(e)}`);
      }
    }
    return out;
  };
  const allowedSet = new Set(expandPermissions(admission.tool_permissions ?? [], "admission.tool_permissions"));
  const deniedResolved = new Set((admission.capabilities?.denied ?? []).map(resolveCapabilityId).filter(Boolean));
  const grantedIds = [...new Set([
    ...(admission.capabilities?.required ?? []),
    ...(admission.capabilities?.allowed ?? []),
  ])].map((raw) => {
    const id = resolveCapabilityId(raw);
    if (!id) throw new ToolSelectionError("TOOL_SELECTION_UNKNOWN_CANONICAL_TOOL", `granted capability outside registry: ${String(raw)}`);
    return id;
  });
  const reg = capabilityRegistry();
  const registryActiveTools = new Set();
  for (const id of grantedIds) {
    if (deniedResolved.has(id)) continue; // denied/revoked capability contributes nothing
    for (const perm of expandPermissions(reg[id].required_permissions, `${id}.required_permissions`)) {
      registryActiveTools.add(perm);
    }
  }


  // ── 5. unauthorized intent fails closed (never silently narrowed) ──
  for (const p of intent) {
    if (!allowedSet.has(p)) throw new ToolSelectionError("TOOL_SELECTION_TOOL_UNAUTHORIZED", `intent permission not in admitted allowed set: ${p}`);
  }

  // ── 6. S1 = intent ∩ allowed ∩ registryActive; every drop is explained ──
  const s1 = intent.filter((p) => registryActiveTools.has(p));
  const droppedByRegistry = intent.filter((p) => !registryActiveTools.has(p));
  if (droppedByRegistry.length > 0) {
    // Owning capability revoked/denied at selection time (revocation seam).
    throw new ToolSelectionError("TOOL_SELECTION_TOOL_REVOKED", `intent permissions whose owning capability is not registry-active: ${droppedByRegistry.join(",")}`);
  }

  // ── 7. mapping-domain drift BEFORE any further narrowing (REV 2 order) ──
  for (const p of s1) {
    const rows = mappingRows.filter((r) => r.requiredPermissionId === p && r.adapterKind === PI_ADAPTER_KIND);
    for (const row of rows) {
      if (row.mappingVersion !== TOOL_SELECTION_MAPPING_VERSION) {
        throw new ToolSelectionError("TOOL_SELECTION_MAPPING_DRIFT", `row ${p} mappingVersion stale`);
      }
      if (row.runtimeVocabularyDigest !== FROZEN_RUNTIME_VOCABULARY_DIGEST) {
        throw new ToolSelectionError("TOOL_SELECTION_MAPPING_DRIFT", `row ${p} authored against a foreign runtime vocabulary`);
      }
      if (row.status === "ACTIVE") {
        for (const n of row.adapterToolNames) {
          if (!FROZEN_RUNTIME_TOOL_NAMES.includes(n)) {
            throw new ToolSelectionError("TOOL_SELECTION_MAPPING_DRIFT", `mapped adapterToolName absent from verified runtime: ${n}`);
          }
        }
      }
    }
  }

  // ── 8. fully-revoked PI rows for selected permissions fail closed ──
  // (foreign-kind rows are invisible to this projection; a permission whose
  // only rows belong to another kind is simply unmapped HERE, never revoked)
  for (const p of s1) {
    const rows = mappingRows.filter((r) => r.requiredPermissionId === p && r.adapterKind === PI_ADAPTER_KIND);
    if (rows.length > 0 && rows.every((r) => r.status !== "ACTIVE")) {
      throw new ToolSelectionError("TOOL_SELECTION_TOOL_REVOKED", `all mapping rows revoked for selected permission: ${p}`);
    }
  }

  // ── 9. effective selection: ≥1 ACTIVE mapped name (zero-projection inert) ──
  const effective = s1.filter((p) => activeRowsFor(p, mappingRows).some((r) => r.adapterToolNames.length > 0));

  // ── 10. empty-selection semantics (§6.3: REV 2 laundering + REV 3 mixed) ──
  let basis;
  if (effective.length > 0) {
    basis = "DERIVED_SELECTION";
  } else if (s1.length > 0) {
    // Nonempty permission-level set reduced to zero names solely through
    // zero-projection rows ⇒ laundering, never LEGITIMATE_EMPTY.
    throw new ToolSelectionError("TOOL_SELECTION_PERMISSION_UNMAPPED", `nonempty selection (${s1.join(",")}) maps to zero adapter tool names`);
  } else if (intent.length > 0) {
    // Unreachable given steps 5–8 throw earlier; defense-in-depth fail-closed.
    throw new ToolSelectionError("TOOL_SELECTION_PERMISSION_UNMAPPED", "intent survived no intersection term");
  } else {
    basis = "LEGITIMATE_EMPTY"; // honest derived-empty (e.g. the FAST_PATH theorem)
  }

  // ── 11. deterministic frozen output (§7) ──
  const canonicalToolIds = [...new Set(effective)].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  const adapterToolNames = canonicalizeNameSet(
    effective.flatMap((p) => activeRowsFor(p, mappingRows).flatMap((r) => r.adapterToolNames)),
    { schemaLabel: "selected adapterToolNames" },
  );
  const selection = {
    contractVersion: TOOL_SELECTION_SCHEMA,
    taskIdentity: { taskId: taskAllocation.taskId, taskAllocationDigest: taskAllocation.allocationId },
    runIdentity: executionId,
    admissionIdentity: { admissionId: admission.admission_id, admissionDigest: admissionDigest(admission) },
    nodeRole: nodeRole ?? null,
    canonicalToolIds,
    permissionIds: [...canonicalToolIds],
    adapterKind: PI_ADAPTER_KIND,
    adapterToolNames,
    registryDigest: computeRegistryDigest(admission),
    // Kind-scoped: foreign-kind rows never alter THIS projection's digest.
    mappingDigest: computeMappingDigest(mappingRows.filter((r) => r.adapterKind === PI_ADAPTER_KIND)),
    runtimeIdentity: {
      realpath: runtimeIdentity.realpath,
      sha256: runtimeIdentity.sha256,
      version: runtimeIdentity.version ?? frozen.version,
    },
    runtimeVocabularyDigest,
    selectionBasis: basis,
    selectedAt: selectedAt ?? new Date().toISOString(),
  };
  selection.selectionDigest = domainDigest(TOOL_SELECTION_SCHEMA, canonicalize(selection));
  return deepFreeze(selection);
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}

/**
 * Issuance authentication (§7 item 6): resolve THIS invocation's identities
 * AGAINST the authoritative frozen admission record / lifecycle bind
 * context. The resolver closes over THE admission; nothing is ever accepted
 * from the selection payload's own fields. This is a RESOLVER over existing
 * authorities — not a catalog, selector, governor, or runner.
 */
export function createLifecycleSelectionAuthority({
  admission,
  taskAllocation,
} = {}) {
  if (!admission || typeof admission !== "object") throw new TypeError("createLifecycleSelectionAuthority: frozen admission required");
  if (!taskAllocation || typeof taskAllocation !== "object") throw new TypeError("createLifecycleSelectionAuthority: authoritative taskAllocation required");
  return async function selectionAuthority({ executionId, phase } = {}) {
    if (typeof executionId !== "string" || executionId.length === 0) return null;
    return {
      taskId: taskAllocation.taskId,
      taskAllocationDigest: taskAllocation.allocationId,
      taskAllocationDimensions: taskAllocation.dimensions,
      runIdentity: executionId,
      phase: phase ?? null,
      admissionId: admission.admission_id,
      admissionDigestValue: admissionDigest(admission),
      admission,
    };
  };
}

/**
 * §7 adapter re-validation — THE ONE validator, imported by
 * src/adapter/pi-rpc-adapter.mjs (same module as the selector; never a
 * second copy). Returns { ok:true, argvToolNames, basis } or
 * { ok:false, code, reason } with code ∈ TOOL_SELECTION_FAILURE_CODES.
 */
export function validateToolSelection(selection, { authorityBinding, frozenIdentity = null } = {}) {
  const frozen = frozenIdentity ?? frozenRuntimeIdentity();
  const invalid = (reason) => ({ ok: false, code: "TOOL_SELECTION_PROVENANCE_INVALID", reason });
  if (!authorityBinding) return invalid("no authoritative lifecycle binding expectation resolved for THIS invocation");
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) return invalid("selection output missing/malformed");
  if (selection.contractVersion !== TOOL_SELECTION_SCHEMA) return invalid("contractVersion mismatch");
  const { selectionDigest, ...rest } = selection;
  if (typeof selectionDigest !== "string" || selectionDigest.length !== 64) return invalid("selectionDigest missing");
  if (domainDigest(TOOL_SELECTION_SCHEMA, canonicalize(rest)) !== selectionDigest) return invalid("SELECTION_DIGEST recompute mismatch");

  // Identities resolve against the AUTHORITATIVE store — never payload fields.
  if (!selection.taskIdentity || selection.taskIdentity.taskId !== authorityBinding.taskId) return invalid("taskIdentity.taskId does not resolve authoritatively");
  if (!selection.taskIdentity || selection.taskIdentity.taskAllocationDigest !== authorityBinding.taskAllocationDigest) return invalid("taskIdentity.taskAllocationDigest does not resolve authoritatively");
  if (selection.runIdentity !== authorityBinding.runIdentity) return invalid("runIdentity does not match THIS invocation");
  if (!selection.admissionIdentity || selection.admissionIdentity.admissionId !== authorityBinding.admissionId) return invalid("admissionIdentity.admissionId does not resolve authoritatively");
  if (!selection.admissionIdentity || selection.admissionIdentity.admissionDigest !== authorityBinding.admissionDigestValue) return invalid("admissionIdentity.admissionDigest does not match the authoritative record");

  // Digests current: registry recomputed from THE authoritative admission;
  // implementer-chosen values are provenance violations (REV 2 gap B).
  if (selection.registryDigest !== computeRegistryDigest(authorityBinding.admission)) return invalid("registryDigest does not match the single registry state for the authoritative admission");
  if (selection.mappingDigest !== FROZEN_MAPPING_DIGEST) return invalid("mappingDigest stale/forged");
  if (selection.runtimeVocabularyDigest !== FROZEN_RUNTIME_VOCABULARY_DIGEST) return { ok: false, code: "TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT", reason: "runtimeVocabularyDigest stale" };
  const ri = selection.runtimeIdentity ?? {};
  if (ri.realpath !== frozen.realpath || ri.sha256 !== frozen.sha256) {
    return { ok: false, code: "TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT", reason: "runtimeIdentity stale/forged" };
  }

  // Schema coherence: frozen field set, canonical arrays, enums.
  if (!Array.isArray(selection.canonicalToolIds) || !Array.isArray(selection.permissionIds)) return invalid("missing canonical/permission id fields");
  if (JSON.stringify(selection.canonicalToolIds) !== JSON.stringify(selection.permissionIds)) return invalid("permissionIds != canonicalToolIds (V1 identity rows)");
  for (const key of ["canonicalToolIds", "adapterToolNames"]) {
    const arr = selection[key];
    let canon = null;
    try { canon = canonicalizeNameSet(arr, { schemaLabel: key }); } catch { canon = null; }
    if (!canon || JSON.stringify(canon) !== JSON.stringify(arr)) return invalid(`${key} not canonical (sorted/unique/exact)`);
  }
  if (selection.adapterKind !== PI_ADAPTER_KIND) return invalid("unknown adapterKind");
  if (selection.selectionBasis !== "LEGITIMATE_EMPTY" && selection.selectionBasis !== "DERIVED_SELECTION") return invalid("selectionBasis unknown");
  if (!(typeof selection.selectedAt === "string" && !Number.isNaN(Date.parse(selection.selectedAt)))) return invalid("selectedAt not ISO-8601");

  // Every name ∈ THIS kind's frozen ACTIVE mapping ∩ verified runtime
  // vocabulary; basis/name coherence (no laundering shape). Foreign-kind
  // rows (future adapters) never widen what a pi-builtin selection may carry.
  const mappableNames = new Set(
    TOOL_SELECTION_MAPPING.filter((r) => r.status === "ACTIVE" && r.adapterKind === PI_ADAPTER_KIND).flatMap((r) => r.adapterToolNames)
  );
  for (const n of selection.adapterToolNames) {
    if (!mappableNames.has(n) || !FROZEN_RUNTIME_TOOL_NAMES.includes(n)) {
      return invalid(`adapterToolName outside frozen mapping ∩ verified runtime vocabulary: ${n}`);
    }
  }
  // DERIVATION FIDELITY (review F1): names must be exactly the union the
  // frozen mapping derives from the carried ids, and ids must live in the
  // permission vocabulary — a resigned payload with authoritative identities
  // but swapped tool arrays can never reach argv.
  const permVocab = permissionVocabularySet();
  for (const id of selection.canonicalToolIds) {
    if (!permVocab.has(id)) return invalid(`canonicalToolId outside permission vocabulary: ${id}`);
  }
  const derivedNames = canonicalizeNameSet(
    TOOL_SELECTION_MAPPING
      .filter((r) => r.status === "ACTIVE" && r.adapterKind === PI_ADAPTER_KIND && selection.canonicalToolIds.includes(r.requiredPermissionId))
      .flatMap((r) => r.adapterToolNames),
    { schemaLabel: "derived adapterToolNames" },
  );
  if (JSON.stringify(derivedNames) !== JSON.stringify(selection.adapterToolNames)) {
    return invalid("adapterToolNames do not equal ⋃ ACTIVE mapping rows for the carried canonicalToolIds");
  }

  // DETERMINISTIC REPLAY (review F1, strongest fence): re-run THE selector
  // over the authoritative admission + payload nodeRole and require the
  // payload to reproduce it exactly. A resigned payload with copied
  // identities but swapped tool arrays cannot pass — the replay yields the
  // honest derivation.
  //
  // CONDITIONAL BY DESIGN (review finding #3 disposition: accepted):
  // production resolvers (createLifecycleSelectionAuthority requires a full
  // taskAllocation; the durable-resume reconstruction binds ai.dimensions)
  // ALWAYS carry taskAllocationDimensions, so this replay engages on every
  // production validation. The truthy guard exists so contract tests can
  // isolate the identity/digest fences from the replay fence using minimal
  // bindings; a binding without dimensions is not reachable through any
  // production seam.
  if (authorityBinding.taskAllocationDimensions) {
    let replay;
    try {
      replay = projectToolSelection({
        admission: authorityBinding.admission,
        nodeRole: selection.nodeRole ?? null,
        taskAllocation: {
          taskId: authorityBinding.taskId,
          admissionId: authorityBinding.admissionId,
          dimensions: authorityBinding.taskAllocationDimensions,
          allocationId: authorityBinding.taskAllocationDigest,
        },
        runtimeIdentity: frozen,
        runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
        executionId: authorityBinding.runIdentity,
      });
    } catch (e) {
      return invalid(`deterministic replay failed: ${e?.code ?? e?.name}: ${e?.message ?? e}`);
    }
    const fingerprint = (x) => JSON.stringify({ ids: x.canonicalToolIds, names: x.adapterToolNames, basis: x.selectionBasis, registryDigest: x.registryDigest });
    if (fingerprint(replay) !== fingerprint(selection)) {
      return invalid("payload does not reproduce the deterministic projection from the authoritative admission");
    }
  }

  return { ok: true, argvToolNames: selection.adapterToolNames, basis: selection.selectionBasis, selection };

}
