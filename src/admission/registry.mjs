// src/admission/registry.mjs
//
// TA-2 — authoritative Capability Registry（AUTOLOOP-TA2 section C）.
//
// ONE registry of every capability AutoLoop can grant. Every entry carries
// the machine-checkable attributes the admission decision projects from:
//   capability_id / purpose / required_permissions / mutation_capability /
//   network_capability / isolation_requirement / durability_relevance /
//   evidence_requirement / allowed_actor / allowed_execution_boundary /
//   risk_implications / default_state.
//
// DEFAULT STATE IS DENIED for every capability: nothing is usable unless an
// admission decision grants it. The registry is deny-by-default by
// construction — an unknown capability id resolves to DENIED (fail-closed,
// NEG4).
//
// Parity（machine-enforced）: the ids mirror the TA-1 capability inventory
// (docs/pi-graph-output/ta1/ta1-capability-inventory.json, 23 CAP.* ids) and
// the usage matrix. scripts/ta2-verify.mjs re-checks registry ↔ TA-1
// artifacts at verification time; any drift fails with
// CAPABILITY_REGISTRY_DRIFT. The sub-agent envelope's TOOL_PERMISSIONS and
// SUBAGENT_ROLES enums are the permission/actor vocabulary — parity against
// them is enforced here at module load (thrown) and re-verified by the test
// suite.

import {
  TOOL_PERMISSIONS,
  SUBAGENT_ROLES,
} from "../subagent/subagent-contract.mjs";

export const ADMISSION_REGISTRY_SCHEMA = "autoloop.capability-registry/v1";
export const CAPABILITY_DEFAULT_STATE = "DENIED";
export const CAPABILITY_DENY_REASON = "deny-by-default: no admission grant";

/** Permission vocabulary = the sub-agent envelope tool permission keys. */
export const PERMISSION_VOCABULARY = Object.freeze(Object.keys(TOOL_PERMISSIONS));

/** Actor vocabulary = sub-agent roles + the non-subagent system actors. */
export const ACTOR_VOCABULARY = Object.freeze([
  ...SUBAGENT_ROLES,
  "controller",
  "admission",
  "graph_node",
  "decomposer",
  "verifier",
  "closeout_gate",
  "durable_layer",
  "checkpoint_bridge",
  "writeback_gate",
  "telemetry_observer",
  "research",
  "subagent",
]);

export const ISOLATION_TIERS = Object.freeze(["none", "host", "worktree", "colima"]);
export const DURABILITY_TIERS = Object.freeze(["ephemeral", "durable", "durable_resume"]);
export const EVIDENCE_TIERS = Object.freeze(["none", "ephemeral", "persistent"]);

/**
 * The registry body. Compiled from the TA-1 capability inventory + usage
 * matrix（normative inputs）; verified for parity by scripts/ta2-verify.mjs.
 * `required_permissions` references the envelope permission vocabulary; a
 * capability that implies repository mutation marks mutation_capability.
 */
const CAPABILITIES = [
  {
    capability_id: "CAP.DIRECT_EXECUTION",
    purpose: "VIRTUAL capability: run the task directly without the graph scheduler (fast path). Grants NO tool access and no isolation/durability machinery — it only means 'graph scheduler not engaged'.",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "ephemeral",
    evidence_requirement: "none",
    allowed_actor: ["controller", "admission"],
    allowed_execution_boundary: "host",
    risk_implications: [],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.GRAPH_SCHEDULER",
    purpose: "Run a decomposed task as a DAG of nodes with dependency readiness, single-writer lease, bounded repair per node, final PASS/HOLD verdict",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "host",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["controller", "admission", "graph_node"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.CONCURRENCY", "RS.LIFECYCLE_GOVERNANCE"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.READONLY_SUBAGENT",
    purpose: "Bound read-only exploration/analysis of the codebase with a frozen minimal context and structured result; research gate + pre-decomposition discovery",
    required_permissions: ["READ_ONLY"],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "ephemeral",
    evidence_requirement: "ephemeral",
    allowed_actor: ["graph_node", "decomposer", "subagent"],
    allowed_execution_boundary: "host",
    risk_implications: [],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.WRITER_SUBAGENT",
    purpose: "Apply code changes inside a DEDICATED git worktree (rw /work) with the source repo read-only (/src); mutationScope-enforced structured writer result",
    required_permissions: ["READ_ONLY", "SCRATCH_WRITE"],
    mutation_capability: true,
    network_capability: false,
    isolation_requirement: "colima",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["graph_node", "subagent", "writer"],
    allowed_execution_boundary: "worktree",
    risk_implications: ["RS.DATABASE_MUTATION", "RS.DESTRUCTIVE_WRITE", "RS.SELF_MODIFICATION"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.INDEPENDENT_REVIEW",
    purpose: "A REAL review agent process in an isolated Colima container independently re-examines a writer's output; structured review result with blockingFindings",
    required_permissions: ["READ_ONLY"],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "colima",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["reviewer", "verifier"],
    allowed_execution_boundary: "colima",
    risk_implications: [],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.BOUNDED_REPAIR",
    purpose: "On REPAIR verdict, re-run the phase with the exact blocking findings, bounded by effective_repair_cap; budget persists; exhaustion -> HOLD",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "host",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["graph_node", "durable_layer"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.SELF_MODIFICATION"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.COLIMA_ISOLATION",
    purpose: "Pinned-instance container runtime: explicit socket, mount allowlist, network none, cap-drop ALL, no-new-privileges, pids/memory/cpu limits",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "colima",
    durability_relevance: "ephemeral",
    evidence_requirement: "ephemeral",
    allowed_actor: ["controller", "admission", "graph_node"],
    allowed_execution_boundary: "colima",
    risk_implications: ["RS.SECURITY_BOUNDARY"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.WORKTREE_ISOLATION",
    purpose: "Clone-once + per-task git worktree add --detach; verify/capture/revoke; writes never reach the main checkout",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "worktree",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["graph_node", "writer"],
    allowed_execution_boundary: "worktree",
    risk_implications: ["RS.DESTRUCTIVE_WRITE"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.SINGLE_WRITER_LEASE",
    purpose: "At most one writer mutation active at a time per repo/task; parallel mutation forbidden; lease restoration fail-closed",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "host",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["graph_node", "durable_layer"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.CONCURRENCY"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.DURABLE_EXECUTION",
    purpose: "Journal every safe boundary with deterministic ids, hash-chain event log, CAS CURRENT.json; resume reconstructs ready set from durable truth",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "host",
    durability_relevance: "durable_resume",
    evidence_requirement: "persistent",
    allowed_actor: ["durable_layer", "graph_node"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.PERSISTENCE", "RS.IRREVERSIBLE"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.CHECKPOINT_RESUME",
    purpose: "Publish checkpoints at every safe boundary; resume restores phase states + repair budget + permitted dirty digest; freezes admission into the fingerprint (anti-drift)",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "host",
    durability_relevance: "durable_resume",
    evidence_requirement: "persistent",
    allowed_actor: ["durable_layer", "checkpoint_bridge"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.PERSISTENCE"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.MEMORY_RETRIEVAL",
    purpose: "Deterministic retrieval over the memory store: fixed ranking tuple, conflict-groups surfaced, store snapshot digest, deterministic retrievalDigest",
    required_permissions: ["READ_ONLY"],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "ephemeral",
    evidence_requirement: "ephemeral",
    allowed_actor: ["graph_node", "subagent", "research"],
    allowed_execution_boundary: "host",
    risk_implications: [],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.MEMORY_WRITEBACK",
    purpose: "Persist memory records through the governed gate: candidate -> schema/identity -> authority/trust -> evidence -> scope -> security -> conflict -> lifecycle -> journal -> sqlite; idempotent; conflicts surfaced",
    required_permissions: ["SCRATCH_WRITE"],
    mutation_capability: true,
    network_capability: false,
    isolation_requirement: "host",
    durability_relevance: "durable_resume",
    evidence_requirement: "persistent",
    allowed_actor: ["writeback_gate", "graph_node"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.MEMORY_WRITEBACK", "RS.DATABASE_MUTATION", "RS.SELF_MODIFICATION"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.TELEMETRY",
    purpose: "Allowlisted identity-bound telemetry events (never prompts/secrets/user data); deterministic eventIds; aggregates; simulated budgets",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "ephemeral",
    evidence_requirement: "ephemeral",
    allowed_actor: ["telemetry_observer"],
    allowed_execution_boundary: "host",
    risk_implications: [],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.REVIEW_BUNDLE",
    purpose: "Generate the 25-section external review bundle from structured closeout source; recompute repo facts; security scan; delta-v1 inventory consistency fail-closed",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["closeout_gate", "controller"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.LIFECYCLE_GOVERNANCE"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.EXTERNAL_REVIEW_DELIVERY",
    purpose: "Fixed inbox ~/Desktop/AutoLoop-Review/Current/; atomic publish under single-owner lock; occupancy fail-closed; verdict is the sole receipt",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["closeout_gate", "controller"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.EXTERNAL_PUBLISHING", "RS.COMMIT_PUSH_MERGE"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.CLOSEOUT_STATE",
    purpose: "Persisted autoloop.closeout-state/v1 record; state-driven mandatory closeout; disposition idempotent; AWAITING_EXTERNAL_REVIEW lifecycle",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["closeout_gate"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.LIFECYCLE_GOVERNANCE"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.EVIDENCE_GENERATION",
    purpose: "Harness-owned evidence: baseline capture, verification commands, system-observed delta, review evidence bundle, evidence manifest digests",
    required_permissions: ["SCRATCH_WRITE"],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["graph_node", "closeout_gate", "verifier"],
    allowed_execution_boundary: "host",
    risk_implications: [],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.SECRET_SECURITY",
    purpose: "Deny-by-default scanning: secret scan on bundles; telemetry denylist; memory validation; symlink/binary/exec-bit checks fail-closed",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "ephemeral",
    evidence_requirement: "ephemeral",
    allowed_actor: ["closeout_gate", "writeback_gate", "telemetry_observer"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.SECRETS", "RS.CREDENTIALS", "RS.SECURITY_BOUNDARY"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.LIFECYCLE_GOVERNANCE",
    purpose: "Authorization schema v2, effective authority (parent ∩ child ∩ runtime), lifecycle state machine, review-unit gate, internal checkpoints vs integration-approved commits, push only after verified external PASS",
    required_permissions: [],
    mutation_capability: false,
    network_capability: true,
    isolation_requirement: "none",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["controller", "closeout_gate", "admission"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.COMMIT_PUSH_MERGE", "RS.EXTERNAL_PUBLISHING", "RS.LIFECYCLE_GOVERNANCE"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.RISK_NORMALIZATION",
    purpose: "Single canonical risk authority: LOW/MEDIUM/HIGH/CRITICAL (MED alias only); unknown values rejected fail-closed; isStrictReviewRisk drives strict-reviewer routing",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "ephemeral",
    evidence_requirement: "none",
    allowed_actor: ["admission"],
    allowed_execution_boundary: "host",
    risk_implications: [],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.TASK_DECOMPOSITION",
    purpose: "Decompose a parent task into IR v2 phases (purpose/effects/boundaries/execution_policy/dispositions); structure only, no mutation",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "durable",
    evidence_requirement: "persistent",
    allowed_actor: ["decomposer", "admission"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.SELF_MODIFICATION"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.PI_TRANSPORT",
    purpose: "Pinned transport: provider=deepseek, model=deepseek-v4-flash, reasoningEffort=high, no fallback, no tools by default; fail-closed payload guard",
    required_permissions: [],
    mutation_capability: false,
    network_capability: true,
    isolation_requirement: "host",
    durability_relevance: "ephemeral",
    evidence_requirement: "none",
    allowed_actor: ["controller"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.NETWORK_REMOTE", "RS.SECURITY_BOUNDARY"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
  {
    capability_id: "CAP.C2D_ATOMIC_STATE",
    purpose: "Atomic state transitions for execution/commit candidates: acquireLease -> publishIntent -> discovery -> complete -> current -> release; deterministic ids",
    required_permissions: [],
    mutation_capability: false,
    network_capability: false,
    isolation_requirement: "none",
    durability_relevance: "durable_resume",
    evidence_requirement: "persistent",
    allowed_actor: ["durable_layer", "checkpoint_bridge"],
    allowed_execution_boundary: "host",
    risk_implications: ["RS.PERSISTENCE", "RS.CONCURRENCY"],
    default_state: CAPABILITY_DEFAULT_STATE,
  },
];

const registry = Object.freeze(
  Object.fromEntries(
    CAPABILITIES.map((c) => [
      c.capability_id,
      Object.freeze({
        ...c,
        required_permissions: Object.freeze([...c.required_permissions]),
        allowed_actor: Object.freeze([...c.allowed_actor]),
      }),
    ]),
  ),
);

export function capabilityRegistry() {
  return registry;
}

export function listCapabilities() {
  return CAPABILITIES.map((c) => c.capability_id).sort();
}

/**
 * Resolve a capability id. Unknown ids resolve to DENIED（fail-closed,
 * NEG4）— never a grant.
 * @returns {object|null} the capability entry, or null when unknown.
 */
export function resolveCapability(id) {
  if (typeof id !== "string") return null;
  return registry[id] ?? null;
}

/**
 * Policy-level capability aliases（TA-1 integration map）: admission records
 * may reference policy ids（"direct_execution", "subagent", ...）which must
 * resolve to CAP.* registry ids for machine verification（NEG4）. Frozen
 * production records normalize to CAP.* ids.
 */
export const CAPABILITY_ALIASES = Object.freeze({
  direct_execution: "CAP.DIRECT_EXECUTION",
  subagent: "CAP.READONLY_SUBAGENT",
  writer: "CAP.WRITER_SUBAGENT",
  colima: "CAP.COLIMA_ISOLATION",
  worktree: "CAP.WORKTREE_ISOLATION",
  durable_execution: "CAP.DURABLE_EXECUTION",
  checkpoint_resume: "CAP.CHECKPOINT_RESUME",
  independent_review: "CAP.INDEPENDENT_REVIEW",
  review_bundle: "CAP.REVIEW_BUNDLE",
  external_review: "CAP.EXTERNAL_REVIEW_DELIVERY",
  memory_retrieval: "CAP.MEMORY_RETRIEVAL",
  memory_writeback: "CAP.MEMORY_WRITEBACK",
  decomposition: "CAP.TASK_DECOMPOSITION",
  research_first: "CAP.READONLY_SUBAGENT",
  readonly_exploration: "CAP.READONLY_SUBAGENT",
  commit_push_merge: "CAP.LIFECYCLE_GOVERNANCE",
});

/**
 * Resolve any capability reference（CAP.* id OR policy alias）to a registry
 * capability id. Unknown references resolve to null（denied, fail-closed）.
 */
export function resolveCapabilityId(id) {
  if (typeof id !== "string") return null;
  if (registry[id]) return id;
  return CAPABILITY_ALIASES[id] ?? null;
}

/**
 * True iff the reference resolves to a known registry capability（via id or
 * alias）.
 */
export function isKnownCapability(id) {
  return typeof id === "string" && Boolean(resolveCapabilityId(id));
}

/**
 * Machine-enforced parity: the registry vocabulary must agree with the
 * envelope's TOOL_PERMISSIONS keys and SUBAGENT_ROLES（any required
 * permission / allowed actor outside the vocabulary is a drift）. Called at
 * module load; the test suite and ta2-verify re-check.
 */
export function assertRegistryParity() {
  const errors = [];
  const permissionSet = new Set(PERMISSION_VOCABULARY);
  const actorSet = new Set(ACTOR_VOCABULARY);
  for (const c of CAPABILITIES) {
    for (const p of c.required_permissions) {
      if (!permissionSet.has(p)) errors.push(`${c.capability_id}.required_permissions:${p} not in TOOL_PERMISSIONS`);
    }
    for (const a of c.allowed_actor) {
      if (!actorSet.has(a)) errors.push(`${c.capability_id}.allowed_actor:${a} not in actor vocabulary`);
    }
    if (c.default_state !== CAPABILITY_DEFAULT_STATE) errors.push(`${c.capability_id}.default_state must be DENIED`);
    if (!ISOLATION_TIERS.includes(c.isolation_requirement)) errors.push(`${c.capability_id}.isolation_requirement invalid`);
    if (!DURABILITY_TIERS.includes(c.durability_relevance)) errors.push(`${c.capability_id}.durability_relevance invalid`);
    if (!EVIDENCE_TIERS.includes(c.evidence_requirement)) errors.push(`${c.capability_id}.evidence_requirement invalid`);
  }
  return { ok: errors.length === 0, errors };
}

assertRegistryParity();
