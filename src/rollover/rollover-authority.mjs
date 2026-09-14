// src/rollover/rollover-authority.mjs
//
// STAGE D CROSS-SESSION ROLLOVER — CORE AUTHORITY CONSTANTS + DIGESTS.
// Card: AUTOLOOP-V1-STAGE-D-CROSS-SESSION-ROLLOVER-CORE-1.
//
// Frozen authorities carried here (each COUNT = 1, single definition):
//   - CanonicalSessionIdentity canonicalization (P1)
//   - RolloverIntent idempotency key derivation (P2)
//   - Spawn-receipt / transfer / validation / retirement digests (P3-P6)
//   - THE closed rollover state machine token set + legal transitions
//   - THE closed CROSS_SESSION_* hold-code set (TELEMETRY-AND-HOLD-CODES.md)
//   - THE closed authorized-trigger set
//
// Agent-neutral by contract (PORTABILITY-CONTRACT.md §2): this file contains
// ZERO provider CLI syntax, model names, thread-id parsing rules or
// agent-specific schema. Adapter kinds appear only as opaque registry data.
// Digests reuse the ONE canonicalization authority (src/canonical-digest.mjs,
// sorted keys + compact JSON + sha256 hex) — the same convention as
// admissionRecord/admissionDigest precedents.

import { digestOf } from "../canonical-digest.mjs";

// ── Frozen hold-code set (TELEMETRY-AND-HOLD-CODES.md §1 verbatim) ────────

export const ROLLOVER_HOLD_CODES = Object.freeze([
  "CROSS_SESSION_ROLLOVER_TRIGGER_UNAUTHORIZED",
  "CROSS_SESSION_ROLLOVER_SAFE_POINT_UNAVAILABLE",
  "CROSS_SESSION_ROLLOVER_INTENT_MISSING",
  "CROSS_SESSION_ROLLOVER_SCHEMA_UNSUPPORTED",
  "CROSS_SESSION_SUCCESSOR_ADAPTER_UNKNOWN",
  "CROSS_SESSION_SUCCESSOR_SPAWN_FAILED",
  "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID",
  "CROSS_SESSION_CHECKPOINT_MISMATCH",
  "CROSS_SESSION_AUTHORITY_MISMATCH",
  "CROSS_SESSION_GENERATION_MISMATCH",
  "CROSS_SESSION_SUCCESSOR_VALIDATION_FAILED",
  "CROSS_SESSION_ACK_MISSING",
  "CROSS_SESSION_ACK_INVALID",
  "CROSS_SESSION_ACK_TIMEOUT",
  "CROSS_SESSION_ACK_REPLAYED",
  "CROSS_SESSION_OWNERSHIP_TRANSFER_FAILED",
  "CROSS_SESSION_DUAL_OWNER_FENCED",
  "CROSS_SESSION_STALE_SOURCE_FENCED",
  "CROSS_SESSION_STALE_SUCCESSOR_FENCED",
  "CROSS_SESSION_TARGET_ADAPTER_TOOL_PROJECTION_UNAVAILABLE",
  "CROSS_SESSION_BUDGET_RECONSTRUCTION_FAILED",
  "CROSS_SESSION_REVOCATION_OBSERVED",
  "CROSS_SESSION_RETIREMENT_INCOMPLETE",
  "CROSS_SESSION_RECONCILIATION_REQUIRED",
  // Round-1 adversarial review additions:
  "CROSS_SESSION_ROLLOVER_IN_PROGRESS_A_FROZEN",
  "CROSS_SESSION_LEASE_CUSTODY_PENDING",
  "CROSS_SESSION_TOOL_PROJECTION_SCOPE_EXPANSION",
]);

// ── Closed state machine (ROLLOVER-STATE-MACHINE.md §1) ───────────────────

export const ROLLOVER_STATES = Object.freeze({
  ACTIVE_A: "ACTIVE_A",
  ROLLOVER_REQUESTED: "ROLLOVER_REQUESTED",
  A_FROZEN: "A_FROZEN",
  CHECKPOINT_PUBLISHED: "CHECKPOINT_PUBLISHED",
  B_SPAWN_REQUESTED: "B_SPAWN_REQUESTED",
  B_STARTED_QUARANTINED: "B_STARTED_QUARANTINED",
  B_CHECKPOINT_VALIDATED: "B_CHECKPOINT_VALIDATED",
  B_READY_ACKED: "B_READY_ACKED",
  OWNERSHIP_TRANSFER_COMMITTED: "OWNERSHIP_TRANSFER_COMMITTED",
  ACTIVE_B: "ACTIVE_B",
  A_RETIRED: "A_RETIRED",
  // Failure / terminal:
  ROLLOVER_ABORTED_PRE_TRANSFER: "ROLLOVER_ABORTED_PRE_TRANSFER",
  B_SPAWN_FAILED: "B_SPAWN_FAILED",
  B_VALIDATION_FAILED: "B_VALIDATION_FAILED",
  B_ACK_TIMEOUT: "B_ACK_TIMEOUT",
  OWNERSHIP_TRANSFER_FAILED: "OWNERSHIP_TRANSFER_FAILED",
  A_RETIREMENT_PENDING: "A_RETIREMENT_PENDING",
  A_RETIREMENT_CONFIRMED: "A_RETIREMENT_CONFIRMED",
  ROLLOVER_RECONCILIATION_REQUIRED: "ROLLOVER_RECONCILIATION_REQUIRED",
  ROLLOVER_HOLD: "ROLLOVER_HOLD",
});

/** States in which an ACTIVE rollover freezes the owner-of-record (§9a). */
export const ACTIVE_PRE_COMMIT_ROLLOVER_STATES = Object.freeze(new Set([
  ROLLOVER_STATES.ROLLOVER_REQUESTED,
  ROLLOVER_STATES.A_FROZEN,
  ROLLOVER_STATES.CHECKPOINT_PUBLISHED,
  ROLLOVER_STATES.B_SPAWN_REQUESTED,
  ROLLOVER_STATES.B_STARTED_QUARANTINED,
  ROLLOVER_STATES.B_CHECKPOINT_VALIDATED,
  ROLLOVER_STATES.B_READY_ACKED,
]));

/** Post-commit states: owner-of-record is B@(g+1) (§13a gate). */
export const POST_COMMIT_ROLLOVER_STATES = Object.freeze(new Set([
  ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED,
  ROLLOVER_STATES.ACTIVE_B,
  ROLLOVER_STATES.A_RETIREMENT_PENDING,
]));

/** States whose telemetry token is ROLLOVER_IN_PROGRESS (F-11 mapping). */
export const ROLLOVER_IN_PROGRESS_STATES = ACTIVE_PRE_COMMIT_ROLLOVER_STATES;

export const ROLLOVER_ABORTED_STATES = Object.freeze(new Set([
  ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER,
  ROLLOVER_STATES.B_SPAWN_FAILED,
  ROLLOVER_STATES.B_VALIDATION_FAILED,
  ROLLOVER_STATES.B_ACK_TIMEOUT,
]));


/**
 * STAGE-D CLOSED-ERA RESUME BINDING REPAIR-1: retirement-complete states are
 * POST-TRANSFER — the durable owner-of-record is B@(g+1) and identity
 * enforcement never closes with the era (INV-2). Resume and terminal/RSL3
 * publication in these states REQUIRE a valid successor sessionBinding.
 */
export const CLOSED_ERA_POST_TRANSFER_STATES = Object.freeze(new Set([
  ROLLOVER_STATES.A_RETIRED,
  ROLLOVER_STATES.A_RETIREMENT_CONFIRMED,
]));

export const ROLLOVER_HOLD_STATES = Object.freeze(new Set([
  ROLLOVER_STATES.OWNERSHIP_TRANSFER_FAILED,
  ROLLOVER_STATES.ROLLOVER_HOLD,
  ROLLOVER_STATES.ROLLOVER_RECONCILIATION_REQUIRED,
]));

/**
 * State token → intermediate telemetry token (normative F-11 mapping).
 * These are NEVER terminal verdicts and never enter the PASS/HOLD channel.
 */
export function rolloverTelemetryToken(state) {
  if (ROLLOVER_IN_PROGRESS_STATES.has(state)) return "ROLLOVER_IN_PROGRESS";
  if ([ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED, ROLLOVER_STATES.ACTIVE_B].includes(state)) {
    return "ROLLOVER_COMMITTED";
  }
  if (ROLLOVER_ABORTED_STATES.has(state)) return "ROLLOVER_ABORTED";
  if (ROLLOVER_HOLD_STATES.has(state)) return "ROLLOVER_HOLD";
  if ([ROLLOVER_STATES.A_RETIREMENT_PENDING, ROLLOVER_STATES.ROLLOVER_RECONCILIATION_REQUIRED].includes(state)) {
    return "ROLLOVER_HOLD";
  }
  if ([ROLLOVER_STATES.A_RETIRED, ROLLOVER_STATES.A_RETIREMENT_CONFIRMED].includes(state)) {
    return "ROLLOVER_COMMITTED";
  }
  if (state === ROLLOVER_STATES.ACTIVE_A) return "NO_ROLLOVER";
  return null;
}

const LEGAL_TRANSITIONS = Object.freeze(new Map(Object.entries({
  [ROLLOVER_STATES.ACTIVE_A]: [ROLLOVER_STATES.ROLLOVER_REQUESTED],
  [ROLLOVER_STATES.ROLLOVER_REQUESTED]: [ROLLOVER_STATES.A_FROZEN, ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER],
  [ROLLOVER_STATES.A_FROZEN]: [ROLLOVER_STATES.CHECKPOINT_PUBLISHED, ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER],
  [ROLLOVER_STATES.CHECKPOINT_PUBLISHED]: [ROLLOVER_STATES.B_SPAWN_REQUESTED, ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER],
  [ROLLOVER_STATES.B_SPAWN_REQUESTED]: [
    ROLLOVER_STATES.B_STARTED_QUARANTINED,
    ROLLOVER_STATES.B_SPAWN_FAILED,
    ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER,
  ],
  [ROLLOVER_STATES.B_STARTED_QUARANTINED]: [
    ROLLOVER_STATES.B_CHECKPOINT_VALIDATED,
    ROLLOVER_STATES.B_VALIDATION_FAILED,
    ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER,
  ],
  [ROLLOVER_STATES.B_CHECKPOINT_VALIDATED]: [ROLLOVER_STATES.B_READY_ACKED, ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER],
  [ROLLOVER_STATES.B_READY_ACKED]: [
    ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED,
    ROLLOVER_STATES.OWNERSHIP_TRANSFER_FAILED,
    ROLLOVER_STATES.ROLLOVER_HOLD,
  ],
  [ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED]: [ROLLOVER_STATES.ACTIVE_B],
  [ROLLOVER_STATES.ACTIVE_B]: [ROLLOVER_STATES.A_RETIRED],
  // Failure states may only deepen into their documented terminal forms:
  [ROLLOVER_STATES.B_SPAWN_FAILED]: [ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER],
  [ROLLOVER_STATES.B_VALIDATION_FAILED]: [ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER],
  [ROLLOVER_STATES.B_ACK_TIMEOUT]: [ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER],
  [ROLLOVER_STATES.OWNERSHIP_TRANSFER_FAILED]: [ROLLOVER_STATES.ROLLOVER_HOLD, ROLLOVER_STATES.ROLLOVER_RECONCILIATION_REQUIRED],
  [ROLLOVER_STATES.A_RETIREMENT_PENDING]: [ROLLOVER_STATES.A_RETIRED],
})));

export function isLegalRolloverTransition(fromState, toState) {
  const allowed = LEGAL_TRANSITIONS.get(fromState);
  return Array.isArray(allowed) && allowed.includes(toState);
}

// ── Closed trigger set (CONTRACT §5) ──────────────────────────────────────

export const AUTHORIZED_ROLLOVER_TRIGGERS = Object.freeze([
  "OWNER_REQUESTED",
  "CONTEXT_THRESHOLD_REACHED",
  "PLANNED_STAGE_BOUNDARY",
]);

// RECOVERABLE_SESSION_FAILURE is REJECTED-NOT-AUTHORIZED (future card only).
export function isAuthorizedTrigger(trigger) {
  return AUTHORIZED_ROLLOVER_TRIGGERS.includes(trigger);
}

/**
 * Validate one trigger event per CONTRACT §5 field requirements.
 * CONTEXT_THRESHOLD_REACHED additionally requires PROVIDER-REPORTED usage
 * provenance (provider-reported=true + usage record identity); unverified
 * estimates are prohibited inputs (R3).
 */
export function validateTriggerEvent(event) {
  if (!event || typeof event !== "object") {
    return { ok: false, code: "CROSS_SESSION_ROLLOVER_TRIGGER_UNAUTHORIZED", reason: "trigger event missing" };
  }
  if (!isAuthorizedTrigger(event.trigger)) {
    return { ok: false, code: "CROSS_SESSION_ROLLOVER_TRIGGER_UNAUTHORIZED", reason: `trigger not in authorized closed set: ${String(event.trigger)}` };
  }
  for (const f of ["source", "authorityDecisionRef", "freshness", "taskIdentity", "runIdentity", "admissionIdentity"]) {
    if (event[f] === undefined || event[f] === null || event[f] === "") {
      return { ok: false, code: "CROSS_SESSION_ROLLOVER_TRIGGER_UNAUTHORIZED", reason: `trigger event missing ${f}` };
    }
  }
  if (!Number.isFinite(Date.parse(String(event.freshness)))) {
    return { ok: false, code: "CROSS_SESSION_ROLLOVER_TRIGGER_UNAUTHORIZED", reason: "freshness not ISO-8601" };
  }
  if (event.trigger === "CONTEXT_THRESHOLD_REACHED") {
    const of_ = event.observedFact;
    if (!of_ || typeof of_ !== "object" || of_.providerReported !== true || !of_.usageRecordId) {
      return { ok: false, code: "CROSS_SESSION_ROLLOVER_TRIGGER_UNAUTHORIZED", reason: "context threshold requires provider-reported usage provenance" };
    }
  }
  return { ok: true };
}

// ── Canonical session identity (CONTRACT §3 / IDENTITY §P1) ───────────────

export const SESSION_IDENTITY_SCHEMA_V = "autoloop.session-identity/v1";
export const ROLLOVER_INTENT_SCHEMA_V = "autoloop.rollover-intent/v1";
export const ROLLOVER_INTENT_SCHEMA = "autoloop.rollover/v1";
export const SPAWN_RECEIPT_SCHEMA_V = "autoloop.spawn-receipt/v1";
export const OWNERSHIP_TRANSFER_SCHEMA_V = "autoloop.ownership-transfer/v1";
export const ROLLOVER_VALIDATION_SCHEMA_V = "autoloop.rollover-validation/v1";
export const A_RETIREMENT_SCHEMA_V = "autoloop.a-retirement/v1";

/**
 * Structural validation of an opaque session id: non-empty, ≤512 chars,
 * printable, no control characters. The core treats the value as opaque
 * bytes-after-validation — never parsed, never compared across adapters.
 */
export function validateOpaqueSessionId(opaqueSessionId) {
  if (typeof opaqueSessionId !== "string" || opaqueSessionId.length === 0) return false;
  if (opaqueSessionId.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(opaqueSessionId)) return false;
  return true;
}

/**
 * Validate identity fields against the frozen adapter-kind registry data.
 * `knownAdapterKinds` is injected (the spawn registry owns the rows) so this
 * module stays free of any concrete kind string.
 */
export function validateCanonicalSessionIdentityFields(identity, knownAdapterKinds) {
  if (!identity || typeof identity !== "object") {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "identity missing" };
  }
  const { adapterKind, providerKind, opaqueSessionId, sessionGeneration } = identity;
  if (typeof adapterKind !== "string" || !(knownAdapterKinds instanceof Set)
      || ![...knownAdapterKinds].some((k) => k.split("\u0000")[0] === adapterKind)) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_ADAPTER_UNKNOWN", reason: `unknown adapterKind ${String(adapterKind)}` };
  }
  if (typeof providerKind !== "string" || providerKind.length === 0 || !knownProviderKindsOf(knownAdapterKinds, adapterKind, providerKind)) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_ADAPTER_UNKNOWN", reason: `providerKind ${String(providerKind)} not bound to ${adapterKind}` };
  }
  if (!validateOpaqueSessionId(opaqueSessionId)) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "opaqueSessionId malformed" };
  }
  if (!Number.isInteger(sessionGeneration) || sessionGeneration < 0) {
    return { ok: false, code: "CROSS_SESSION_GENERATION_MISMATCH", reason: "sessionGeneration must be integer >= 0" };
  }
  return { ok: true };
}

// The registry passes a Set of "adapterKind\u0000providerKind" pair keys so
// this module never hardcodes either dimension.
function knownProviderKindsOf(pairSet, adapterKind, providerKind) {
  return pairSet.has(`${adapterKind}\u0000${providerKind}`);
}

// ── P1-P6 frozen digest preimages (IDENTITY-AND-DIGEST-CONTRACT.md) ──────

/** P1 — session identity digest. */
export function sessionIdentityDigest({ adapterKind, providerKind, opaqueSessionId, sessionGeneration }) {
  return digestOf({
    v: SESSION_IDENTITY_SCHEMA_V,
    adapterKind,
    providerKind,
    opaqueSessionId,
    sessionGeneration,
  });
}

/** P2 — authority decision digest over BYTE-ONCE pinned trigger provenance. */
export function deriveAuthorityDecisionDigest({ trigger, source, observedFact, freshness, decisionRef }) {
  return digestOf({
    v: "autoloop.rollover-authority/v1",
    trigger,
    source: source ?? null,
    observedFact: observedFact ?? null,
    freshness,
    decisionRef: decisionRef ?? null,
  });
}

/**
 * P2 — rolloverId. Deterministic idempotency key: status/createdAt EXCLUDED;
 * spawn-base additive fields EXCLUDED. Retry of the same request yields the
 * SAME rolloverId.
 */
export function deriveRolloverId(core) {
  return digestOf({ v: ROLLOVER_INTENT_SCHEMA_V, ...stripUndefined(core) });
}

/**
 * Recompute a stored intent's rolloverId from its persisted authority-bearing
 * fields (must equal intent.rolloverId; mismatch ⇒ forged/tampered intent).
 */
export function recomputeRolloverIdFromIntent(intent) {
  return deriveRolloverId({
    schemaVersion: intent.schemaVersion,
    sourceSessionIdentityDigest: intent.sourceSessionIdentityDigest,
    sourceGeneration: intent.sourceGeneration,
    targetAdapterKind: intent.targetAdapterKind,
    targetProviderKind: intent.targetProviderKind,
    trigger: intent.trigger,
    authorityDecisionDigest: intent.authorityDecisionDigest,
    taskIdentity: intent.taskIdentity,
    runIdentity: intent.runIdentity,
    admissionIdentity: intent.admissionIdentity,
    graphIdentity: intent.graphIdentity,
    budgetIdentity: intent.budgetIdentity,
    checkpointRevision: intent.checkpointRevision,
    checkpointDigest: intent.checkpointDigest,
    toolSelectionCommitmentDigest: intent.toolSelectionCommitmentDigest,
    budgetStateDigest: intent.budgetStateDigest,
    lifecycleStateDigest: intent.lifecycleStateDigest,
    expectedTargetGeneration: intent.expectedTargetGeneration,
  });
}

/** P3 — spawn receipt digest (re-derived by core from returned fields). */
export function deriveSpawnReceiptDigest(receipt) {
  return digestOf({
    v: SPAWN_RECEIPT_SCHEMA_V,
    rolloverId: receipt.rolloverId,
    expectedTargetGeneration: receipt.expectedTargetGeneration,
    targetAdapterKind: receipt.targetAdapterKind,
    targetProviderKind: receipt.targetProviderKind,
    opaqueSessionId: receipt.opaqueSessionId,
    startedAt: receipt.startedAt,
  });
}

/** Stable ACK equality field set (CONTRACT §10): everything except readyAt/status. */
export function ackStableFieldSet(ack) {
  return {
    rolloverId: ack.rolloverId,
    sourceSessionIdentityDigest: ack.sourceSessionIdentityDigest,
    sourceGeneration: ack.sourceGeneration,
    targetSessionIdentityDigest: ack.targetSessionIdentityDigest,
    targetGeneration: ack.targetGeneration,
    checkpointRevision: ack.checkpointRevision,
    checkpointDigest: ack.checkpointDigest,
    validationDigest: ack.validationDigest,
  };
}

export function deriveAckStableFieldDigest(ack) {
  return digestOf(ackStableFieldSet(ack));
}

/** P4 — ownership transfer digest. T = ACK-mirror head (chain pin). */
export function deriveTransferDigest(transfer) {
  return digestOf({
    v: OWNERSHIP_TRANSFER_SCHEMA_V,
    rolloverId: transfer.rolloverId,
    from: transfer.from,
    to: transfer.to,
    checkpointRevision: transfer.checkpointRevision,
    ackDigest: transfer.ackDigest,
    committedAt: transfer.committedAt,
  });
}

/** P5 — validation digest (ACK payload basis). All 14 steps, in order, PASS. */
export function deriveValidationDigest(v) {
  return digestOf({
    v: ROLLOVER_VALIDATION_SCHEMA_V,
    rolloverId: v.rolloverId,
    checkpointRevision: v.checkpointRevision,
    checkpointDigest: v.checkpointDigest,
    steps: v.steps,
    toolSelectionProjection: v.toolSelectionProjection,
    budgetContinuity: v.budgetContinuity,
    revocationCheck: v.revocationCheck,
    rsl3LatestIdentityPin: v.rsl3LatestIdentityPin,
  });
}

/** P6 — A-retirement record binding digest. */
export function deriveRetirementDigest(retirement) {
  return digestOf({
    v: A_RETIREMENT_SCHEMA_V,
    rolloverId: retirement.rolloverId,
    source: retirement.source,
    successor: retirement.successor,
    ownershipTransferDigest: retirement.ownershipTransferDigest,
    retiredAt: retirement.retiredAt,
  });
}

function stripUndefined(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// ── graph.rollover block helpers (CONTRACT §4) ────────────────────────────

export function emptyRolloverBlock() {
  return {
    schema: ROLLOVER_INTENT_SCHEMA,
    state: ROLLOVER_STATES.ACTIVE_A,
    owner: null,
    active_rollover_id: null,
    intents: {},
    acks: {},
    transfers: {},
    retirements: {},
  };
}

export function isRolloverSchemaSupported(rolloverBlock) {
  return !!rolloverBlock && rolloverBlock.schema === ROLLOVER_INTENT_SCHEMA;
}
