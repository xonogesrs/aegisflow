// src/budget/contract.mjs
//
// AUTOLOOP-TA3 — budget contract（autoloop.budget-contract/v1）.
//
// The budget contract is the machine-readable, ADMISSION-BOUND resource
// envelope that production graph execution must obey. Unlike the COST-1
// telemetry budget（autoloop.telemetry-budget/v1, SIMULATED enforcement only,
// enforced:false）, this contract is the REAL enforcement surface:
//
//   - the contract lives in a FROZEN admission record
//     （admission.extensions.budget）or is derived DETERMINISTICALLY from the
//     frozen admission's profile（PROFILE_DEFAULT_CONTRACTS）— the runtime
//     NEVER invents or widens it（B1: admission is authority）;
//   - every dimension is validated against the meter inventory: a dimension
//     with NO reliable meter cannot be silently enforced as 0 consumption
//     （NEG8/NEG9 — fail closed, never "pretend exact"）;
//   - enforcement states are machine-readable:
//     CONTINUE / APPROACHING_LIMIT / BUDGET_EXHAUSTED / BUDGET_AUTHORITY_INVALID.
//
// Dimension decisions（§2 — enforced vs deferred, with reasons）:
//   ENFORCED（meter exists today）:
//     wall_clock_ms               — meter: runner timing（started/completed）
//     node_execution_count        — meter: dispatched node terminals
//     sub_agent_execution_count   — meter: sub-agent-backed node terminals
//     repair_attempt_count        — meter: repair lifecycle transitions
//                                    （INDEPENDENT of the TA-2 repair budget
//                                    authority — B4）;
//     verifier_reviewer_attempts  — meter: one LOGICAL_REVIEW_ATTEMPT
//                                    (one real reviewer invocation;
//                                    reviewer + reviewer_verdict evidence
//                                    pair = 1; events are not attempts)
//     retry_count                 — meter: attempts beyond the first per node
//   DEFERRED（no reliable meter today — disclosed, never fake-enforced）:
//     token_budget                — the execution layer reports tokenSource
//                                    NOT_REPORTED; declaring a token limit on
//                                    a contract fails closed
//                                    （BUDGET_AUTHORITY_INVALID: meter absent）
//     tool_call_count             — toolCallSource NOT_REPORTED; same rule
//     retrieval_bytes             — meter exists ONLY when the admission
//                                    allows memory retrieval; declaring the
//                                    dimension requires retrieval_allowed
//     external_network_ops        — no operation-level meter on the
//                                    production path today
//     runtime_execution_count     — container/instance starts are 1:1 with
//                                    graph runs today; covered by
//                                    node_execution_count
//     evidence_verification_cost  — covered by verifier_reviewer_attempts +
//                                    node_execution_count（closeout nodes）;

export const BUDGET_CONTRACT_SCHEMA = "autoloop.budget-contract/v1";
export const BUDGET_CONTRACT_VERSION = 1;
export const BUDGET_LEDGER_SCHEMA = "autoloop.budget-ledger/v1";
export const BUDGET_LEDGER_VERSION = 1;

// ── enforcement states（§4）─────────────────────────────────────────────
export const BUDGET_STATES = Object.freeze([
  "CONTINUE",
  "APPROACHING_LIMIT",
  "BUDGET_EXHAUSTED",
  "BUDGET_AUTHORITY_INVALID",
]);

export const BUDGET_HOLD_CODES = Object.freeze({
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  BUDGET_AUTHORITY_INVALID: "BUDGET_AUTHORITY_INVALID",
  BUDGET_METER_UNAVAILABLE: "BUDGET_METER_UNAVAILABLE",
  BUDGET_RECONCILIATION_DIVERGED: "BUDGET_RECONCILIATION_DIVERGED",
  BUDGET_RESERVATION_CONFLICT: "BUDGET_RESERVATION_CONFLICT",
  BUDGET_CHILD_EXCEEDS_PARENT: "BUDGET_CHILD_EXCEEDS_PARENT",
  BUDGET_CONTRACT_INVALID: "BUDGET_CONTRACT_INVALID",
});

// ── dimension inventory（meter source / owner / unit / admission field /
// enforcement point / durable state / exhaustion behavior / support）──────
export const DIMENSION_UNITS = Object.freeze({
  wall_clock_ms: "ms",
  node_execution_count: "count",
  sub_agent_execution_count: "count",
  repair_attempt_count: "count",
  verifier_reviewer_attempts: "count",
  retry_count: "count",
  token_budget: "tokens",
  tool_call_count: "count",
  retrieval_bytes: "bytes",
  external_network_ops: "count",
  runtime_execution_count: "count",
  evidence_verification_cost: "count",
});

export const ENFORCED_DIMENSIONS = Object.freeze([
  "wall_clock_ms",
  "node_execution_count",
  "sub_agent_execution_count",
  "repair_attempt_count",
  "verifier_reviewer_attempts",
  "retry_count",
]);

export const DEFERRED_DIMENSIONS = Object.freeze([
  "token_budget",
  "tool_call_count",
  "retrieval_bytes",
  "external_network_ops",
  "runtime_execution_count",
  "evidence_verification_cost",
]);

/** Per-dimension disclosure: meter source, owner, unit, admission field,
 *  enforcement point, durable state location, exhaustion behavior,
 *  supported / deferred reason. */
export const DIMENSION_METER_MAP = Object.freeze({
  wall_clock_ms: {
    unit: "ms",
    meterSource: "runner timing (graphResult.startedAt/completedAt; node resultIdentity.latencyMs)",
    owner: "graph-runner (colima/subagent/durable)",
    admissionField: "extensions.budget.dimensions.wall_clock_ms.limit",
    enforcementPoint: "pre-dispatch reservation + post-operation settlement",
    durableState: "autoloop.budget-ledger/v1 (budget-ledger.json)",
    exhaustionBehavior: "BUDGET_EXHAUSTED — no further dispatch (conservative upper-bound reservation)",
    supported: true,
    deferredReason: null,
  },
  node_execution_count: {
    unit: "count",
    meterSource: "node terminal events (graphResult.nodeResults)",
    owner: "graph-runner",
    admissionField: "extensions.budget.dimensions.node_execution_count.limit",
    enforcementPoint: "pre-dispatch reservation + terminal settlement",
    durableState: "autoloop.budget-ledger/v1",
    exhaustionBehavior: "BUDGET_EXHAUSTED — node not dispatched",
    supported: true,
    deferredReason: null,
  },
  sub_agent_execution_count: {
    unit: "count",
    meterSource: "sub-agent-backed node terminals (node.subagentEnvelope)",
    owner: "subagent-graph-runner",
    admissionField: "extensions.budget.dimensions.sub_agent_execution_count.limit",
    enforcementPoint: "pre-dispatch reservation + terminal settlement",
    durableState: "autoloop.budget-ledger/v1",
    exhaustionBehavior: "BUDGET_EXHAUSTED — sub-agent node not dispatched",
    supported: true,
    deferredReason: null,
  },
  repair_attempt_count: {
    unit: "count",
    meterSource: "repair lifecycle transitions (transitions[].lifecycleTransitions status=REPAIR)",
    owner: "execution-orchestrator lifecycle hooks",
    admissionField: "extensions.budget.dimensions.repair_attempt_count.limit",
    enforcementPoint: "onRepairRequested settlement",
    durableState: "autoloop.budget-ledger/v1",
    exhaustionBehavior: "BUDGET_EXHAUSTED — repair not attempted (node HOLDs)",
    supported: true,
    // B4: this dimension is a RUNTIME meter; it is NOT the TA-2 repair
    // budget authority（admission.repair_budget / repair lineage）— the two
    // are separate counters with separate semantics（NEG10）.
    deferredReason: null,
  },
  verifier_reviewer_attempts: {
    unit: "count",
    meterSource: "LOGICAL_REVIEW_ATTEMPT = one real reviewer invocation (reviewer + reviewer_verdict evidence pair); settled at onReviewerCompleted",
    owner: "execution-orchestrator lifecycle hooks",
    admissionField: "extensions.budget.dimensions.verifier_reviewer_attempts.limit",
    enforcementPoint: "onReviewerCompleted settlement",
    durableState: "autoloop.budget-ledger/v1",
    exhaustionBehavior: "BUDGET_EXHAUSTED — reviewer not invoked",
    supported: true,
    deferredReason: null,
  },
  retry_count: {
    unit: "count",
    meterSource: "per-node attempt > 0 events (node.attempt / recovery replay)",
    owner: "graph-runner",
    admissionField: "extensions.budget.dimensions.retry_count.limit",
    enforcementPoint: "terminal settlement (attempt beyond first)",
    durableState: "autoloop.budget-ledger/v1",
    exhaustionBehavior: "BUDGET_EXHAUSTED — retry/replay not allowed",
    supported: true,
    deferredReason: null,
  },
  token_budget: {
    unit: "tokens",
    meterSource: null,
    owner: null,
    admissionField: "extensions.budget.dimensions.token_budget.limit",
    enforcementPoint: "NONE — meter absent",
    durableState: null,
    exhaustionBehavior: "BUDGET_AUTHORITY_INVALID if declared（NEG9: unsupported meter never reads as 0）",
    supported: false,
    deferredReason: "execution layer reports tokenSource NOT_REPORTED (COST-1 contract) — no provider meter exists; declaring a token limit fails closed until a real meter appears",
  },
  tool_call_count: {
    unit: "count",
    meterSource: null,
    owner: null,
    admissionField: "extensions.budget.dimensions.tool_call_count.limit",
    enforcementPoint: "NONE — meter absent",
    durableState: null,
    exhaustionBehavior: "BUDGET_AUTHORITY_INVALID if declared",
    supported: false,
    deferredReason: "toolCallSource NOT_REPORTED today — a REQUIRED meter that cannot count fails closed instead of silently continuing（NEG8）",
  },
  retrieval_bytes: {
    unit: "bytes",
    meterSource: "memory retrieval context byteCount (memory provider) — NOT consumed by the enforcement chain today",
    owner: "memory provider",
    admissionField: "extensions.budget.dimensions.retrieval_bytes.limit",
    enforcementPoint: "NONE — enforcement chain does not consume the retrieval meter today",
    durableState: null,
    exhaustionBehavior: "BUDGET_AUTHORITY_INVALID if declared（deferred — the meter exists in telemetry but is not wired into the enforcement chain; faking it would violate NEG8/NEG9）",
    supported: false,
    deferredReason: "the retrieval byte meter exists（memoryContext.byteCount）but the production enforcement chain does not consume it yet; enforcing it now would be pretending exact — deferred until the meter is wired",
  },
  external_network_ops: {
    unit: "count",
    meterSource: null,
    owner: null,
    admissionField: "extensions.budget.dimensions.external_network_ops.limit",
    enforcementPoint: "NONE — meter absent",
    durableState: null,
    exhaustionBehavior: "BUDGET_AUTHORITY_INVALID if declared",
    supported: false,
    deferredReason: "no operation-level external/network meter on the production path today",
  },
  runtime_execution_count: {
    unit: "count",
    meterSource: null,
    owner: null,
    admissionField: "extensions.budget.dimensions.runtime_execution_count.limit",
    enforcementPoint: "NONE — covered by node_execution_count",
    durableState: null,
    exhaustionBehavior: "deferred — container/instance starts are 1:1 with graph runs today",
    supported: false,
    deferredReason: "covered by node_execution_count; an independent meter adds no observability until multiple runtimes exist",
  },
  evidence_verification_cost: {
    unit: "count",
    meterSource: null,
    owner: null,
    admissionField: "extensions.budget.dimensions.evidence_verification_cost.limit",
    enforcementPoint: "NONE — covered by verifier_reviewer_attempts + node_execution_count",
    durableState: null,
    exhaustionBehavior: "deferred",
    supported: false,
    deferredReason: "covered by verifier_reviewer_attempts（reviewers/verifiers）and node_execution_count（closeout/evidence nodes）",
  },
});

// ── per-operation wall-clock reservation cap（ms）────────────────────────
// Each dispatched operation reserves an UPPER BOUND of wall-clock so a crash
// before settlement cannot silently lose consumption（§6 conservative
// reservation）. The reservation is capped at DEFAULT_OP_WALL_CLOCK_CAP（not
// the whole remaining budget）and further capped by the remaining budget at
// the dispatch gate — a phase whose timeout exceeds the remaining budget is
// NOT dispatched（never "just a bit over"）.
export const DEFAULT_OP_WALL_CLOCK_CAP = 60_000;

// ── approaching-limit ratio（observability signal; NEVER expands budget）──
export const DEFAULT_APPROACHING_RATIO = 0.8;

// ── profile default contracts（deterministic; admission may override via
// extensions.budget — the runtime never invents or widens）─────────────────
export const PROFILE_DEFAULT_CONTRACTS = Object.freeze({
  FAST_PATH: Object.freeze({
    wall_clock_ms: 600_000,
    node_execution_count: 8,
    sub_agent_execution_count: 0,
    repair_attempt_count: 0,
    verifier_reviewer_attempts: 1,
    retry_count: 0,
  }),
  STANDARD: Object.freeze({
    wall_clock_ms: 900_000,
    node_execution_count: 16,
    sub_agent_execution_count: 4,
    repair_attempt_count: 1,
    verifier_reviewer_attempts: 2,
    retry_count: 1,
  }),
  MEDIUM: Object.freeze({
    wall_clock_ms: 1_800_000,
    node_execution_count: 32,
    sub_agent_execution_count: 8,
    repair_attempt_count: 2,
    verifier_reviewer_attempts: 4,
    retry_count: 2,
  }),
  MEDIUM_LARGE: Object.freeze({
    wall_clock_ms: 3_600_000,
    node_execution_count: 64,
    sub_agent_execution_count: 16,
    repair_attempt_count: 2,
    verifier_reviewer_attempts: 6,
    retry_count: 4,
  }),
  LARGE_LOW: Object.freeze({
    wall_clock_ms: 2_700_000,
    node_execution_count: 64,
    sub_agent_execution_count: 12,
    repair_attempt_count: 2,
    verifier_reviewer_attempts: 6,
    retry_count: 4,
  }),
  HIGH: Object.freeze({
    wall_clock_ms: 7_200_000,
    node_execution_count: 128,
    sub_agent_execution_count: 24,
    repair_attempt_count: 2,
    verifier_reviewer_attempts: 8,
    retry_count: 4,
  }),
  CRITICAL: Object.freeze({
    wall_clock_ms: 14_400_000,
    node_execution_count: 256,
    sub_agent_execution_count: 48,
    repair_attempt_count: 3,
    verifier_reviewer_attempts: 12,
    retry_count: 8,
  }),
});

/**
 * Resolve the effective dimension limits for an admission:
 *   admission.extensions.budget overrides the profile default per dimension.
 * Pure / deterministic / no side effects.
 *
 * @param {object} admission — frozen admission record
 * @returns {{ limits: object, contractSource: "profile"|"admission",
 *             approachingRatio: number, closeoutAuthorized: boolean }}
 */
export function resolveDimensionLimits(admission) {
  const profile = admission?.profile ?? "STANDARD";
  const base = { ...(PROFILE_DEFAULT_CONTRACTS[profile] ?? PROFILE_DEFAULT_CONTRACTS.STANDARD) };
  const declared = admission?.extensions?.budget?.dimensions ?? null;
  const limits = { ...base };
  let contractSource = "profile";
  if (declared && typeof declared === "object") {
    contractSource = "admission";
    for (const [dim, cfg] of Object.entries(declared)) {
      if (!cfg || typeof cfg !== "object" || cfg.limit === undefined || cfg.limit === null) continue;
      limits[dim] = cfg.limit;
    }
  }
  const approachingRatio = Number(admission?.extensions?.budget?.approachingRatio ?? DEFAULT_APPROACHING_RATIO);
  return {
    limits,
    contractSource,
    approachingRatio: Number.isFinite(approachingRatio) && approachingRatio > 0 && approachingRatio <= 1 ? approachingRatio : DEFAULT_APPROACHING_RATIO,
    closeoutAuthorized: admission?.extensions?.budget?.closeoutAuthorized === true,
  };
}

/**
 * Validate a user-declared budget contract（admission.extensions.budget）.
 * Fail-closed（NEG8/NEG9）:
 *   - limit must be a non-negative finite number;
 *   - a dimension with NO meter（token_budget / tool_call_count /
 *     external_network_ops / runtime_execution_count /
 *     evidence_verification_cost）cannot be declared — an unsupported meter
 *     must never be treated as 0 consumption;
 *   - retrieval_bytes requires admission.memory_policy.retrieval_allowed
 *     （the meter cannot exist otherwise）;
 *   - unknown dimensions / unknown fields fail closed.
 *
 * @param {object} contract — admission.extensions.budget
 * @param {object} admission — the frozen admission（for memory policy）
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateBudgetContract(contract, admission = null) {
  const errors = [];
  if (contract === undefined || contract === null) return { ok: true, errors: [] };
  if (typeof contract !== "object" || Array.isArray(contract)) return { ok: false, errors: ["contract_must_be_object"] };
  if (contract.schema !== undefined && contract.schema !== BUDGET_CONTRACT_SCHEMA) {
    errors.push(`schema_mismatch:${String(contract.schema)}`);
  }
  const extra = Object.keys(contract).filter((k) => !["schema", "version", "dimensions", "approachingRatio", "closeoutAuthorized"].includes(k));
  if (extra.length) errors.push(`unknown_field:${extra.join(",")}`);
  const dims = contract.dimensions ?? {};
  if (typeof dims !== "object" || Array.isArray(dims)) { errors.push("dimensions_must_be_object"); return { ok: false, errors }; }
  const allDims = [...ENFORCED_DIMENSIONS, ...DEFERRED_DIMENSIONS];
  for (const [dim, cfg] of Object.entries(dims)) {
    if (!allDims.includes(dim)) { errors.push(`unknown_dimension:${dim}`); continue; }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) { errors.push(`${dim}_must_be_object`); continue; }
    const cfgExtra = Object.keys(cfg).filter((k) => !["limit", "thresholdRatio"].includes(k));
    if (cfgExtra.length) errors.push(`${dim}_unknown_field:${cfgExtra.join(",")}`);
    const limit = cfg.limit;
    if (limit === undefined || limit === null || !Number.isFinite(limit) || limit < 0) errors.push(`${dim}_limit_invalid`);
    const meta = DIMENSION_METER_MAP[dim];
    if (meta && meta.supported === false) {
      errors.push(`${dim}_unsupported_meter:${dim} has no reliable meter today; declaring it fails closed (never 0-consumption)`);
    }
    if (cfg.thresholdRatio !== undefined && (!Number.isFinite(cfg.thresholdRatio) || cfg.thresholdRatio <= 0 || cfg.thresholdRatio > 1)) {
      errors.push(`${dim}_thresholdRatio_invalid`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Deep-freeze a plain object（budget contract / envelope are immutable）. */
export function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) deepFreeze(value[k]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Assemble the effective contract object（profile defaults ∪ admission
 * overrides）, validated. Returns null when the admission declares no
 * contract（pure profile default path）.
 */
export function effectiveBudgetContract(admission) {
  const declared = admission?.extensions?.budget ?? null;
  const v = validateBudgetContract(declared, admission);
  if (!v.ok) return { ok: false, errors: v.errors };
  const { limits, contractSource, approachingRatio, closeoutAuthorized } = resolveDimensionLimits(admission);
  return {
    ok: true,
    contract: {
      schema: BUDGET_CONTRACT_SCHEMA,
      version: BUDGET_CONTRACT_VERSION,
      source: contractSource,
      approachingRatio,
      closeoutAuthorized,
      dimensions: Object.fromEntries(ENFORCED_DIMENSIONS.map((d) => [d, { limit: limits[d] ?? null }])),
    },
  };
}

export const LOGICAL_REVIEW_ATTEMPT = "LOGICAL_REVIEW_ATTEMPT";

/**
 * THE single verifier_reviewer_attempts normalizer.
 *
 * Evidence events `reviewer` and `reviewer_verdict` remain distinct
 * lifecycle facts. Budget consumption is one LOGICAL_REVIEW_ATTEMPT
 * per real invocation, identified by (node, attempt). A pair of
 * events for the same slot counts as 1. Duplicate publication of the
 * same slot is ignored. A lone reviewer event (invocation without a
 * verdict: error / timeout / invalid) still counts as 1. A lone
 * reviewer_verdict without a reviewer event still counts as 1.
 *
 * Accepts either:
 *   - graph transitions: [{ phaseId, lifecycleTransitions: [...] }]
 *   - a flat lifecycle event list: [{ phase, attempt, ... }]
 */
export function countLogicalReviewerAttempts(transitions) {
  if (!Array.isArray(transitions) || transitions.length === 0) return 0;
  const slots = new Set();
  const ingest = (events, nodeKey) => {
    for (const lt of events ?? []) {
      const phase = String(lt?.phase ?? "");
      if (phase !== "reviewer" && phase !== "reviewer_verdict") continue;
      const attempt = lt.attempt === undefined || lt.attempt === null ? 0 : lt.attempt;
      slots.add(`${nodeKey}#${attempt}`);
    }
  };
  const nested = transitions.some((t) => t && Array.isArray(t.lifecycleTransitions));
  if (nested) {
    for (let i = 0; i < transitions.length; i++) {
      const tx = transitions[i];
      ingest(tx.lifecycleTransitions, tx.phaseId ?? tx.nodeId ?? `tx:${i}`);
    }
  } else {
    ingest(transitions, "direct");
  }
  return slots.size;
}
