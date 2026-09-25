// src/v2/checkpoint-bridge.mjs
//
// C3 — AegisFlow checkpoint bridge on top of the sealed C2D checkpoint store.
//
// Reuses（never re-implements）:
//  - execution-id（mint/validate exec ids, secret digests）
//  - checkpoint-store（initExecutionDir, resolveExecDir, readCurrent,
//    publishCurrent — external checksum + CAS revision + structured lock +
//    write permit）
//  - lease/permit（acquireLease → permitFromLease → releaseLease）
//  - fingerprint（collectFingerprint / assertFingerprint）
//
// AegisFlow additive snapshot fields ride inside the C2D snapshot so the
// existing checksum/CAS/permit/lock authority stays the single writer of
// CURRENT.json. No second checkpoint authority is introduced.

import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import {
  C2dHoldError, HOLD, sha256Hex, setInjectionHook, clearInjectionHooks, fireHook,
  assertPathComponentsNotSymlink, assertNotSymlink, assertInsideRoot,
  writeExclusiveCreate,
} from "../c2d/fs-atomic.mjs";
import { mintExecutionId, validateExecutionId, mintChainId, mintCheckpointId } from "../c2d/execution-id.mjs";
import {
  resolveExecDir, initExecutionDir, readCurrent, publishCurrent, currentPath,
  validateAnchorBlock, getAnchorBlock, ANCHOR_BLOCK_FIELD, createInitialSnapshot,
} from "../c2d/checkpoint-store.mjs";
import { acquireLease, releaseLease, readLease } from "../c2d/lease.mjs";
import { permitFromLease } from "../c2d/permit.mjs";
import { collectFingerprint, assertFingerprint } from "../c2d/fingerprint.mjs";
import { canonicalJson, sha256Text, scanForSecrets, assertValidEvidenceRoot } from "../evidence/run-evidence-store.mjs";
import { execFileSync } from "node:child_process";
import { readRunManifest } from "../evidence/run-manifest.mjs";
import { existsSync, readFileSync, lstatSync, statSync, openSync, closeSync, writeSync, fsyncSync, linkSync, unlinkSync, mkdirSync, chmodSync, renameSync, readdirSync } from "node:fs";
import { acquireStructuredLock as acquireStructuredLockForBridge } from "../c2d/lock.mjs";
// STAGE D: controlled ADDITIVE minor bump — graph.rollover block may appear
// inside snapshot.graph. Major stays 1; legacy checkpoints (block absent)
// keep their same-session semantics (CONTRACT §14).
export const AUTOLOOP_CHECKPOINT_FORMAT_VERSION = "1.0.0";
export const AUTOLOOP_STATE_RUNNING = "AUTOLOOP_RUNNING";
export const AUTOLOOP_STATE_RESUMABLE = "AUTOLOOP_RESUMABLE";
export const AUTOLOOP_STATE_RESTART_REQUIRED = "AUTOLOOP_RESTART_REQUIRED";
export const AUTOLOOP_STATE_PASS = "AUTOLOOP_TERMINAL_PASS";
export const AUTOLOOP_STATE_HOLD = "AUTOLOOP_TERMINAL_HOLD";
export const AUTOLOOP_STATE_NOT_BENEFICIAL = "AUTOLOOP_TERMINAL_NOT_BENEFICIAL";

// ── DE-2 F1: semantic post-head event classification ────────────────────
// DE-1 proved recoverability failures when valid events appear beyond the
// checkpoint head (RESUME_FINGERPRINT_MISMATCH 'unexpected journal event ...
// beyond checkpoint head'). The fix is NOT a permissive allowlist: every
// event is classified by whether the durable truth it carries is already
// captured / deterministically re-derivable (replay-safe), is an intermediate
// marker folded into resumed state (resume-safe), or is unknown / invalid
// (fail closed).
//
// replay-safe — deterministic re-derivation; resume proceeds, the event is
//   never re-journaled. Its durable consequence is captured by the checkpoint
//   at the next safe boundary or is idempotent by construction.
// resume-safe — intermediate marker whose durable consequence is either
//   already persisted as an artifact (evidence / verdict / patch / result)
//   or recoverable from the checkpoint state (writer -> RECOVERY_REQUIRED,
//   read-only -> requeue or completed-result recovery).
export const POST_HEAD_EVENT_SEMANTICS = Object.freeze({
  replaySafe: new Set([
    "CHECKPOINT_PUBLISHED",
    "PHASE_READY",
    "PHASE_REPAIR_REQUESTED",
    "RUN_PASSED", "RUN_HELD", "RUN_NOT_BENEFICIAL",
    "MANIFEST_FINALIZED",
    "RESUME_REQUESTED", "RESUME_VALIDATED", "RESUME_REJECTED",
    "READ_ONLY_PHASE_REQUEUED_AFTER_INTERRUPTION",
    "GRAPH_CREATED", "GRAPH_INPUT_FROZEN",
    // I1: the decomposition-manifest artifact is written BEFORE this event;
    // a crash in the event→checkpoint sub-window leaves a replay-safe marker
    // (the artifact is durable truth; resume re-derives and verifies its
    // digest three ways).
    "DECOMPOSITION_MANIFEST_WRITTEN",
    // STAGE D rollover-class events: every rollover state change is durable
    // BEFORE its effects (INV-7) — the checkpoint mirror is the truth, so a
    // crash leaving these beyond the head is replay-safe (reconciliation
    // re-reads CURRENT; the C2 probe owns un-mirrored C2D intent rows).
    "ROLLOVER_STATE_TRANSITION",
    "ROLLOVER_MIRROR_PUBLISHED",
    "SPAWN_DISPATCH",
    "ROLLOVER_HANDOVER_FENCE",
    // STAGE-D BUDGET HANDOVER: cumulative ledger snapshots ride the
    // append-only journal（the artifact is exclusive-create / immutable）so a
    // successor killed mid-era never rolls back on the next reconstruction.
    // A crash leaving these beyond the head is replay-safe: the latest
    // snapshot IS the truth and the resume seam reads it directly.
    "BUDGET_LEDGER_SNAPSHOT",
    // WP1 automatic trigger producer: the durable usage observation /
    // observation-failure markers are journaled at the phase-terminal
    // observation point BEFORE the phase-terminal checkpoint. A crash in
    // that sub-window leaves them beyond the head; they are pure
    // observability records whose consequence is re-derivable at the next
    // boundary (the producer re-observes from live provider usage and the
    // window-dedup authority is the durable rollover block, never the
    // usage rows). Replay-safe — never re-journaled, never re-consumed.
    "PROVIDER_USAGE_OBSERVED",
    "ROLLOVER_USAGE_OBSERVATION_FAILED",
  ]),
  resumeSafe: new Set([
    // DE-1 F1 examples: journaled before their checkpoint -> post-head on crash
    "DAG_ACCEPTED",
    "PHASE_STARTED",
    "EXECUTOR_COMPLETED",
    "REVIEWER_COMPLETED",
    "PHASE_PASSED", "PHASE_HELD", "PHASE_FAILED",
    "PHASE_SKIPPED",
    "SYSTEM_DELTA_READY",
    // lifecycle error markers（intermediate; the phase hold is the outcome）
    "SYSTEM_DELTA_PERSISTENCE_FAILED",
    "EXECUTOR_OUTPUT_PERSISTENCE_FAILED",
    "RESUME_REJECTED",
    // DE-2 writer recovery markers (intermediate; the checkpoint state is truth)
    "WRITER_SIDE_EFFECT_COMMITTED",
    "WRITER_RECOVERY_CLASSIFIED",
  ]),
});

/**
 * Classify a post-head journal event semantically.
 * @returns {"replay-safe"|"resume-safe"|"invalid"}
 */
export function classifyPostHeadEvent(eventType) {
  if (POST_HEAD_EVENT_SEMANTICS.replaySafe.has(eventType)) return "replay-safe";
  if (POST_HEAD_EVENT_SEMANTICS.resumeSafe.has(eventType)) return "resume-safe";
  return "invalid";
}

// ── C4I single resume-capability authority ──────────────────────────────
// One classifier decides both (a) the canonical c2d_control_state published
// into every checkpoint and (b) the capability gate used by the resume API.
// Rules are NOT duplicated in the checkpoint writer, the resume API, or the
// report formatter.
//
// capability ∈ {
//   TERMINAL            final verdict present → completed run
//   RECOVERY_REQUIRED   interrupted writer / stale lease remnant → fail-closed
//   RESUMABLE           full resume material + safe boundary → resumable
//   RESTART_REQUIRED    pre-decomposition / incomplete decomposition (no
//                       verified IR/DAG material or no frozen phase set) →
//                       a new execution is required, resume is refused
//   CORRUPT             journal/checkpoint inconsistency or malformed input
// }
//
// RESUMABLE requires ALL of: decomposition completed（ir + dag hashes in
// checkpoint）、decomposition-ir artifact present（when observable）、phase
// state set frozen、no unsafe active writer、journal↔checkpoint aligned.
// A run that has not completed decomposition is NEVER RESUMABLE.
export function classifyResumeCapability({ checkpoint, artifacts = {}, journal = {} }) {
  // 0. malformed input
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    return { capability: "CORRUPT", state: null, reason: "checkpoint_missing_or_malformed" };
  }
  // 1. journal ↔ checkpoint alignment（provided on the resume read path）
  if (journal.valid === false || journal.headMatches === false) {
    return { capability: "CORRUPT", state: null, reason: "journal_checkpoint_mismatch" };
  }
  // 2. terminal verdict
  if (checkpoint.final_verdict) {
    const state = checkpoint.final_verdict === "PASS" ? AUTOLOOP_STATE_PASS
      : checkpoint.final_verdict === "NOT_BENEFICIAL" ? AUTOLOOP_STATE_NOT_BENEFICIAL
        : AUTOLOOP_STATE_HOLD;
    return { capability: "TERMINAL", state, reason: `terminal_verdict:${checkpoint.final_verdict}` };
  }
  // 3. interrupted writer / stale lease remnant（fail-closed; exact handling
  //    stays in the resume API, which must not silently retry the writer）
  if (checkpoint.writer_phase_active === true || checkpoint.writer_lease_holder) {
    return {
      capability: "RECOVERY_REQUIRED",
      state: checkpoint.active_phase ? AUTOLOOP_STATE_RUNNING : null,
      reason: checkpoint.active_phase ? "interrupted_writer_phase" : "stale_writer_lease_remnant",
    };
  }
  // 4. decomposition completeness（resume material）
  const irPresent = Boolean(checkpoint.decomposition_ir_sha256) && Boolean(checkpoint.dag_sha256);
  const artifactPresent = typeof artifacts.decompositionIrExists === "boolean" ? artifacts.decompositionIrExists : true;
  if (!irPresent || !artifactPresent) {
    return {
      capability: "RESTART_REQUIRED",
      state: AUTOLOOP_STATE_RESTART_REQUIRED,
      reason: !irPresent ? "decomposition_ir_or_dag_hash_absent" : "decomposition_ir_artifact_absent",
    };
  }
  // 5. phase set frozen
  const phaseStates = checkpoint.phase_states;
  if (!phaseStates || typeof phaseStates !== "object" || Array.isArray(phaseStates) || Object.keys(phaseStates).length === 0) {
    return { capability: "RESTART_REQUIRED", state: AUTOLOOP_STATE_RESTART_REQUIRED, reason: "phase_state_set_not_frozen" };
  }
  // 6. active phase（read-only requeue handled by the resume API）
  if (checkpoint.active_phase) {
    return { capability: "RESUMABLE", state: AUTOLOOP_STATE_RUNNING, reason: "active_phase_running" };
  }
  // 7. safe boundary with full resume material
  return { capability: "RESUMABLE", state: AUTOLOOP_STATE_RESUMABLE, reason: "safe_boundary_full_resume_material" };
}

export class CheckpointHoldError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.name = "CheckpointHoldError";
  }
}

export function deriveChainId(executionId) {
  return `chain_${sha256Text(`autoloop:${executionId}:chain`).slice(0, 24)}`;
}
export function deriveCheckpointId(executionId) {
  return `ckpt_${sha256Text(`autoloop:${executionId}:checkpoint`).slice(0, 24)}`;
}

export function mintRunIdentity() {
  const executionId = mintExecutionId();
  return { executionId, chainId: deriveChainId(executionId), checkpointId: deriveCheckpointId(executionId) };
}

export function validateRunIdentity(executionId) {
  validateExecutionId(executionId);
  return {
    executionId,
    chainId: deriveChainId(executionId),
    checkpointId: deriveCheckpointId(executionId),
  };
}

// ── Fingerprints（§8；secrets never enter fingerprints）──────────────────

export function buildInputFingerprint({ source, parent, manifest }) {
  return sha256Text(canonicalJson({ source, parent, manifest }));
}

export function buildDagFingerprint(ir) {
  const phaseIds = (ir.phases || []).map((p) => p.phase_id);
  const dependsOn = {};
  for (const p of ir.phases || []) dependsOn[p.phase_id] = (p.depends_on || []).slice();
  return sha256Text(canonicalJson({
    phase_ids: phaseIds,
    depends_on: dependsOn,
    execution_policy: ir.execution_policy ?? null,
  }));
}

export function buildIrSha256(ir) {
  return sha256Text(canonicalJson(ir));
}

/**
 * Build the configuration fingerprint（non-secret configuration identity only）.
 */
export function buildConfigurationFingerprint({
  maxRepairAttempts,
  timeoutMs,
  toolPolicy,
  environmentAllowlist,
  expectedReviewerModel,
  runtime,
  sourceHashes,
  decompositionAdapterConfigHash,
  executorAdapterPolicyHash,
  reviewerAdapterPolicyHash,
  persistenceFormatVersion,
  // TA-2（O）: frozen admission digest binds every checkpoint to its
  // admission（admission change -> fingerprint mismatch -> HOLD）.
  admissionFingerprint,
}) {
  return sha256Text(canonicalJson({
    max_repair_attempts: maxRepairAttempts,
    timeout_ms: timeoutMs,
    tool_policy: toolPolicy ?? null,
    environment_allowlist: environmentAllowlist ?? null,
    expected_reviewer_model: expectedReviewerModel ?? null,
    runtime: runtime ?? null,
    source_hashes: sourceHashes ?? null,
    decomposition_adapter_config_hash: decompositionAdapterConfigHash ?? null,
    executor_adapter_policy_hash: executorAdapterPolicyHash ?? null,
    reviewer_adapter_policy_hash: reviewerAdapterPolicyHash ?? null,
    persistence_format_version: persistenceFormatVersion,
    admission_fingerprint: admissionFingerprint ?? null,
  }));
}

// ── Snapshot construction（C2D required fields + AegisFlow additive）───────

export function buildCheckpointSnapshot({
  executionId, chainId, checkpointId,
  revision, created_at,
  repositoryFingerprint,
  inputFingerprint, configurationFingerprint,
  irSha, dagSha,
  journalHead, phaseStates, phaseAttempts, phaseResultHashes,
  completedPhaseIds, activePhase, activeLifecycleStage,
  writerPhaseActive, writerLeaseHolder, finalVerdict, resumePolicy,
}) {
  // C4I: the published control state is decided by the single resume-
  // capability classifier — a checkpoint without full resume material
  // (ir/dag hashes, frozen phase set) is AUTOLOOP_RESTART_REQUIRED, never
  // AUTOLOOP_RESUMABLE.
  const classification = classifyResumeCapability({
    checkpoint: {
      final_verdict: finalVerdict,
      active_phase: activePhase,
      writer_phase_active: writerPhaseActive,
      writer_lease_holder: writerLeaseHolder,
      decomposition_ir_sha256: irSha,
      dag_sha256: dagSha,
      phase_states: phaseStates,
    },
    artifacts: {},
    journal: {},
  });
  const state = classification.state ?? (activePhase ? AUTOLOOP_STATE_RUNNING : AUTOLOOP_STATE_RESUMABLE);
  return {
    format_version: "1.0.0",
    checkpoint_id: checkpointId,
    revision,
    execution_id: executionId,
    chain_id: chainId,
    phase: "AUTOLOOP",
    stage: finalVerdict ? "TERMINAL" : (activePhase ? "EXECUTION" : "IDLE"),
    state,
    c2d_control_state: state,
    created_at,
    updated_at: new Date().toISOString(),
    repository_fingerprint: repositoryFingerprint,
    repository_root_identity: repositoryFingerprint.repository_root_identity,
    git_common_dir_identity: repositoryFingerprint.git_common_dir_identity,
    expected_head: repositoryFingerprint.expected_head,
    expected_ref: repositoryFingerprint.expected_ref,
    expected_worktree_state: repositoryFingerprint.expected_worktree_state,
    execution_affinity: "SAME_WORKTREE_REQUIRED",
    last_completed_transition: null,
    next_transition_candidate: { value: "AUTOLOOP_CONTINUE", advisory_only: true, not_authorization: true },
    input_manifest: { execution_id: executionId, chain_id: chainId },
    checkpoint_integrity: { algorithm: "sha256", digest_basis: "external_current_file" },
    // ── AegisFlow additive ──
    autoloop_format_version: AUTOLOOP_CHECKPOINT_FORMAT_VERSION,
    input_fingerprint: inputFingerprint,
    configuration_fingerprint: configurationFingerprint,
    decomposition_ir_sha256: irSha,
    dag_sha256: dagSha,
    journal_head_sequence: journalHead.seq,
    journal_head_sha256: journalHead.sha256,
    phase_states: phaseStates,
    phase_attempts: phaseAttempts,
    phase_result_hashes: phaseResultHashes,
    completed_phase_ids: completedPhaseIds,
    active_phase: activePhase ?? null,
    active_lifecycle_stage: activeLifecycleStage ?? null,
    writer_phase_active: writerPhaseActive === true,
    writer_lease_holder: writerLeaseHolder ?? null,
    final_verdict: finalVerdict ?? null,
    resume_policy: resumePolicy ?? { safe_boundary: true, interrupted_writer: false },
  };
}

/**
 * Publish one AegisFlow checkpoint through the sealed C2D publishCurrent
 *（external checksum + CAS + structured lock + secret-bound write permit）.
 * The C2D lease is acquired per publication and released afterwards so a
 * crash never wedges resume: a checkpoint is resumable only when it was
 * published with an empty lease.
 */
export async function publishCheckpoint({
  root, executionId, chainId, checkpointId,
  repositoryFingerprint, inputFingerprint, configurationFingerprint,
  irSha, dagSha, journalHead, phaseStates, phaseAttempts, phaseResultHashes,
  completedPhaseIds, activePhase, activeLifecycleStage,
  writerPhaseActive, writerLeaseHolder, finalVerdict, resumePolicy,
  expectedRevision, actorId = "autoloop",
  created_at,
  snapshotOverrides = null,
}) {
  const execDir = resolveExecDir(root, executionId);
  let acquired = null;
  try {
    acquired = acquireLease(execDir, {
      execution_id: executionId,
      chain_id: chainId,
      checkpoint_id: checkpointId,
      repository_identity: repositoryFingerprint.repository_root_identity,
      worktree_identity: repositoryFingerprint.worktree_identity,
      actor_id: actorId,
      expected_head: repositoryFingerprint.expected_head,
      mutation_capability: false,
      role: "autoloop-checkpoint",
    });
    const permit = permitFromLease(execDir, acquired.lease, acquired.secrets, false);
    const revision = (expectedRevision ?? 0) + 1;
    let snapshot = buildCheckpointSnapshot({
      executionId, chainId, checkpointId, revision, created_at,
      repositoryFingerprint, inputFingerprint, configurationFingerprint,
      irSha, dagSha, journalHead, phaseStates, phaseAttempts, phaseResultHashes,
      completedPhaseIds, activePhase, activeLifecycleStage,
      writerPhaseActive, writerLeaseHolder, finalVerdict, resumePolicy,
    });
    if (snapshotOverrides && typeof snapshotOverrides === "object") {
      snapshot = { ...snapshot, ...snapshotOverrides };
    }
    const published = publishCurrent(execDir, snapshot, { expectedRevision, permit });
    releaseLease(execDir, acquired.lease.lease_id, acquired.lease.lease_revision, acquired.secrets);
    acquired = null;
    return {
      revision: published.snapshot.revision,
      snapshot: published.snapshot,
      digest: published.digest,
      durability_capability: published.durability_capability,
      durability_reason: published.reason ?? null,
    };
  } finally {
    if (acquired) {
      try {
        releaseLease(execDir, acquired.lease.lease_id, acquired.lease.lease_revision, acquired.secrets);
      } catch { /* best-effort; lease recovery is fail-closed on next acquire */ }
    }
  }
}

/**
 * Read the current AegisFlow checkpoint（checksum-verified by readCurrent）.
 * Throws C2dHoldError on tamper / absence.
 */
export function readCheckpoint(root, executionId) {
  const execDir = resolveExecDir(root, executionId);
  const cur = readCurrent(execDir);
  return { execDir, snapshot: cur.snapshot, digest: cur.digest, bytes: cur.bytes };
}

export function checkpointExists(root, executionId) {
  const execDir = resolveExecDir(root, executionId);
  return existsSync(currentPath(execDir));
}

export function collectRepositoryFingerprint(repoRoot) {
  return collectFingerprint(repoRoot);
}

/**
 * I1 — read-only observation of the repository tree object id (F3A).
 * One git read; the tree id is a deterministic field of the commit object,
 * so it is re-derived per run only (never per child). Returns null on any
 * failure (caller fails closed).
 */
export function collectRepositoryTree(repoRoot) {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD^{tree}"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const tree = out.trim();
    return /^[0-9a-f]{40}$/.test(tree) ? tree : null;
  } catch {
    return null;
  }
}

/**
 * Compare a current repository fingerprint against the one frozen in a
 * checkpoint（strict equality for the canonical fields; worktree must be
 * clean unless the checkpoint permitted the observed dirty set）.
 */
export function assertRepositoryFingerprintMatches(actual, expected) {
  assertFingerprint(actual, expected, { requireClean: true });
}

export function sha256File(path) {
  return sha256Hex(readFileSync(path));
}

// ═══════════════════════════════════════════════════════════════════════════
// C3 POST-FINALIZATION DERIVED ARTIFACT OWNER
// (AUTOLOOP-V1-STAGE-E-C3-POST-FINALIZATION-DERIVED-ARTIFACT-OWNER-1)
//
// Implements the ADMISSION ARTIFACT 1 six-state machine, the frozen 12-step
// publication protocol (§R5 phases under D1 continuous lock), the §R3/D4/D7
// idempotency trio, and the ADMISSION ARTIFACT 2 crash-recovery semantics.
//
// Frozen source binding:
//   - SIX STATES: ABSENT / PENDING / PUBLISHED_UNCOMMITTED / COMMITTED /
//     ABORTED / CORRUPT (durable-bytes-observable; never a 7th state).
//   - 12 steps: evidence-root verify → acquireStructuredLock(CURRENT.json.lock)
//     → re-read authority → identity/revocation gates → Phase-1 CAS pending
//     intent → Phase-2 temp wx → file fsync → no-replace link → dir fsync →
//     re-verify bytes → Phase-3 CAS commit → final re-read + OPAQUE result.
//   - The lock is acquired BEFORE Phase 1 and released only after step 12
//     (D1: continuous hold; never released between phases).
//   - RunEvidenceStore stays the ONLY artifact byte owner: chain-link bytes
//     are written under `<execDir>/artifacts/derived/<generation>.json` via
//     the same exclusive-create/never-overwrite discipline as every other
//     artifact. No new store, lock namespace, event type, or index.
//   - Recovery is owner-executed (ADMISSION ARTIFACT 2): every restart action
//     is a frozen behavior of THIS module; callers pass no recovery policy.
//   - Data minimization: results/errors carry codes + opaque digests only —
//     never source paths, artifact bodies, or credentials.
//   - PRODUCTION_REACHABILITY = 0: no production module imports this
//     publisher; nothing wires it into any pipeline (test-enforced).
// ═══════════════════════════════════════════════════════════════════════════

export const DERIVED_ARTIFACT_FORMAT_VERSION = "1.0.0";

/** Frozen §R1 closed chain-link schema: exactly these 14 fields. */
export const DERIVED_LINK_FIELDS = Object.freeze([
  "format_version",
  "execution_id",
  "phase_id",
  "generation",
  "previous_link_digest",
  "artifact_identity",
  "artifact_digest",
  "artifact_size",
  "mutation_id",
  "issuer_identity",
  "revocation_generation",
  "created_at",
  "committed_at",
  "link_digest",
]);

/** Frozen evidence codes (publisher-owned string codes, fs-atomic HOLD table untouched except the D3 anchor code). */
export const DERIVED_CODES = Object.freeze({
  ALREADY_SATISFIED: "ALREADY_SATISFIED",
  COMMITTED: "COMMITTED",
  IDENTITY_CONFLICT: "AMENDMENT_IDENTITY_CONFLICT",
  QUARANTINE_CONFLICT: "AMENDMENT_QUARANTINE_CONFLICT",
  PENDING_CONFLICT: "AMENDMENT_PENDING_CONFLICT",
  PENDING_LINK_MISMATCH: "AMENDMENT_PENDING_LINK_MISMATCH",
  TAIL_LOSS: "AMENDMENT_TAIL_LOSS",
  ROLLBACK_DETECTED: "AMENDMENT_ROLLBACK_DETECTED",
  REVOKED_SUBJECT: "AMENDMENT_REVOKED_SUBJECT",
  ANCHOR_IDENTITY_MISMATCH: "AMENDMENT_ANCHOR_IDENTITY_MISMATCH",
  ANCHOR_SCHEMA_INVALID: "AMENDMENT_ANCHOR_SCHEMA_INVALID",
  STALE_GENERATION: "AMENDMENT_STALE_GENERATION",
  CHAIN_CORRUPT: "AMENDMENT_CHAIN_CORRUPT",
  CHAIN_INCOMPLETE: "AMENDMENT_CHAIN_INCOMPLETE",
  SCHEMA_INVALID: "AMENDMENT_SCHEMA_INVALID",
  LINK_SELF_DIGEST_MISMATCH: "AMENDMENT_LINK_SELF_DIGEST_MISMATCH",
  PUBLISHED_BYTES_MISMATCH: "AMENDMENT_PUBLISHED_BYTES_MISMATCH",
  CLOCK_ANOMALY: "CLOCK_ANOMALY",
  PATH_UNSAFE: "PATH_UNSAFE",
  ABSENT: "ABSENT",
});

const DERIVED_MAX_BOUNDED_STRING = 256;
const DERIVED_MAX_ARTIFACT_BYTES = 64 * 1024; // §R11 budget (DEFAULT_MAX_FREE_TEXT_BYTES parity)
const DERIVED_CLOCK_SKEW_MS = 300 * 1000;
const DERIVED_HEX64_RE = /^[0-9a-f]{64}$/;
const DERIVED_CHAIN_DIR = join("artifacts", "derived");
const DERIVED_ABORTED_PREFIX = "ABORTED-";

function derivedBoundedString(v) {
  return typeof v === "string" && v.length > 0 && v.length <= DERIVED_MAX_BOUNDED_STRING;
}

function derivedSafeInt(v, min) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min;
}

function derivedIsoMs(v) {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * §R1 canonical link bytes: sorted keys, 2-space indent, trailing newline
 * (the sealed canonical-opening byte form; reviewer FINDING 2 fixes the
 * canonicalization citation). `excludeDigest` removes the link_digest field
 * before serialization — the self-exclusion is exact.
 */
function derivedCanonicalLinkBytes(link, { excludeDigest = false } = {}) {
  const source = excludeDigest
    ? Object.fromEntries(Object.entries(link).filter(([k]) => k !== "link_digest"))
    : link;
  const sorted = Object.keys(source).sort()
    .map((k) => [k, source[k]]);
  return Buffer.from(`${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`, "utf8");
}

function derivedLinkDigest(link) {
  return sha256Hex(derivedCanonicalLinkBytes(link, { excludeDigest: true }));
}

/** §R10 zero-write gates: run BEFORE any durable byte (Phase 1 included). */
function derivedAssertPublicationGates({ linkBytes, identity, generationPath }) {
  // regular-file / symlink / hardlink rejection on the generation path (C20)
  assertPathComponentsNotSymlink(generationPath, { allowMissingLeaf: true });
  if (existsSync(generationPath)) {
    let st;
    try {
      st = lstatSync(generationPath);
    } catch {
      st = null;
    }
    if (st) {
      if (st.isSymbolicLink()) {
        throw new C2dHoldError(HOLD.PATH_UNSAFE, "PATH_UNSAFE: symlinked publish target");
      }
      if (!st.isFile()) {
        throw new C2dHoldError(HOLD.PATH_UNSAFE, "PATH_UNSAFE: publish target is not a regular file");
      }
      if (st.nlink !== 1) {
        throw new C2dHoldError(HOLD.PATH_UNSAFE, "PATH_UNSAFE: hardlinked publish target");
      }
    }
  }
  // control-character rejection
  for (const ch of linkBytes.toString("utf8")) {
    const code = ch.codePointAt(0);
    if (code < 32 && code !== 9 && code !== 10) {
      throw new C2dHoldError(HOLD.PATH_UNSAFE, "PATH_UNSAFE: control characters in link bytes");
    }
  }
  // secret scan (names only on failure — data minimization)
  const scan = scanForSecretsPublic(linkBytes.toString("utf8"));
  if (!scan.safe) {
    throw new C2dHoldError(HOLD.PATH_UNSAFE, `PATH_UNSAFE: secret pattern(s): ${scan.matches.join(",")}`);
  }
  void identity;
}

/**
 * D6 seq-filter discipline (owner side): staging orphans
 * `<final>.tmp.<nonce>` are non-authority; a restart discards them. Only
 * temps for THIS generation's final path are removed — never any final byte.
 */
function discardStagingTemps(generationPath) {
  const dir = dirname(generationPath);
  const finalName = basename(generationPath);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.startsWith(`${finalName}.tmp.`)) {
      const p = join(dir, e);
      try {
        assertNotSymlink(p);
        unlinkSync(p);
        fsyncDirBridge(dir);
      } catch { /* discard is best-effort; gates still apply */ }
    }
  }
}

function scanForSecretsPublic(text) {
  // Reuses the sealed evidence-store scan semantics (run-evidence-store
  // exports scanForSecrets; the import below avoids a cycle because that
  // module imports checkpoint-store, not this bridge).
  return scanForSecrets(text);
}

/**
 * Durable artifact bytes exist for `generation`? Returns { exists, bytes,
 * digest } reading ONLY the acknowledged-or-pending generation path. Non-
 * canonical sequencing orphans (`.tmp.` staging) are structurally excluded
 * by the naming scheme (D6 seq-filter discipline).
 */
function derivedReadGenerationBytes(execDir, generation) {
  const p = derivedGenerationPath(execDir, generation);
  if (!existsSync(p)) return { exists: false, bytes: null, digest: null, path: p };
  assertNotSymlink(p);
  let st;
  try {
    st = lstatSync(p);
  } catch {
    st = null;
  }
  if (!st || st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
    throw new C2dHoldError(HOLD.PATH_UNSAFE, "PATH_UNSAFE: chain link path is not a safe regular file");
  }
  const bytes = readFileSync(p);
  return { exists: true, bytes, digest: sha256Hex(bytes), path: p };
}


/**
 * D4 quarantine fence: a quarantine marker (ABORTED-<gen>-<reason>) for the
 * target generation blocks any re-publication — quarantined bytes never
 * resurrect through the retry path. Caller: publishDerivedArtifact before
 * Phase 2.
 */
function assertNoQuarantineMarker(execDir, generation) {
  const dir = join(execDir, DERIVED_CHAIN_DIR);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const prefix = `${DERIVED_ABORTED_PREFIX}${generation}-`;
  for (const e of entries) {
    if (e.startsWith(prefix)) {
      throw new C2dHoldError(DERIVED_CODES.QUARANTINE_CONFLICT, "HOLD / CHECKPOINT_CORRUPT");
    }
  }
}
export function derivedGenerationPath(execDir, generation) {
  if (!derivedSafeInt(generation, 1)) {
    throw new C2dHoldError(HOLD.PATH_TRAVERSAL, "generation must be a safe integer >= 1");
  }
  const dir = join(execDir, DERIVED_CHAIN_DIR);
  assertInsideRoot(execDir, dir);
  return join(dir, `derived-${String(generation).padStart(12, "0")}.json`);
}

/**
 * §R4/D4 quarantine: move corrupt/orphan bytes aside as
 * ABORTED-<gen>-<reason> WITHOUT touching predecessor digests. Never
 * rewrites chain bytes; on path conflict fails closed (C16).
 */
function derivedQuarantine(execDir, generation, reason) {
  const src = derivedGenerationPath(execDir, generation);
  if (!existsSync(src)) return false;
  assertNotSymlink(src);
  const dst = join(execDir, DERIVED_CHAIN_DIR, `${DERIVED_ABORTED_PREFIX}${generation}-${reason}`);
  assertInsideRoot(join(execDir, DERIVED_CHAIN_DIR), dst);
  if (existsSync(dst)) {
    throw new C2dHoldError(DERIVED_CODES.QUARANTINE_CONFLICT, "HOLD / PATH_UNSAFE");
  }
  renameSync(src, dst);
  fsyncDirBridge(dirname(dst));
  return true;
}


function fsyncDirBridge(dir) {
  let fd = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch { /* durability degradation is surfaced via restart re-verify */ }
  finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* */ }
    }
  }
}

/**
 * The six-state machine, computed from DURABLE BYTES ONLY (§1 ADMISSION
 * ARTIFACT 1): anchor block + generation path + sidecar-verified CURRENT.
 * Never a 7th state; unknown/ambiguous combinations FAIL CLOSED.
 */
export function derivedReadState(execDir, { executionId, phaseId } = {}) {
  const cur = readCurrent(execDir);
  if (!cur) return { state: DERIVED_CODES.ABSENT, anchor: null, committed: null, walk: null };
  // D3: strict anchor validation AFTER the snapshot validator passed (in
  // readCurrent the bytes parsed; validateSnapshotStructure ran only at
  // publish time, so re-run it here for read-side closure).
  try {
    validateAnchorBlock(cur.snapshot);
  } catch (e) {
    if (e instanceof C2dHoldError && e.code === HOLD.ANCHOR_SCHEMA_INVALID) {
      return { state: DERIVED_CODES.ANCHOR_SCHEMA_INVALID, anchor: null, committed: null, walk: null };
    }
    throw e;
  }
  const anchor = getAnchorBlock(cur.snapshot);
  if (!anchor) {
    // Legacy run without derived head: verified-empty ABSENT (§1/§4#7) —
    // NEVER generation-0 truthiness.
    return { state: DERIVED_CODES.ABSENT, anchor: null, committed: null, walk: null };
  }
  if (executionId != null && anchor.execution_id !== executionId) {
    throw new C2dHoldError(DERIVED_CODES.ANCHOR_IDENTITY_MISMATCH, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (phaseId != null && anchor.phase_id !== phaseId) {
    throw new C2dHoldError(DERIVED_CODES.ANCHOR_IDENTITY_MISMATCH, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (anchor.committed_generation === 0) {
    // Committed generation 0 = nothing has ever been committed; a pending
    // intent may exist for generation 1. No generation bytes are consulted.
    if (anchor.pending_mutation_id === null) {
      return { state: DERIVED_CODES.ABSENT, anchor, committed: null, walk: null };
    }
    return { state: DERIVED_CODES.PENDING, anchor, committed: null, walk: null };
  }
  const genBytes = derivedReadGenerationBytes(execDir, anchor.committed_generation);
  if (!genBytes.exists) {
    // Anchor acknowledges a generation whose bytes are missing: committed
    // current points at a missing artifact → CORRUPT (fail-closed; C11/F5
    // family adjudicates the exact suffix classification).
    return { state: DERIVED_CODES.CHAIN_CORRUPT, anchor, committed: null, walk: null };
  }
  if (genBytes.digest !== anchor.committed_link_digest) {
    return { state: DERIVED_CODES.CHAIN_CORRUPT, anchor, committed: null, walk: null };
  }
  if (anchor.pending_mutation_id !== null) {
    // Pending intent for gen N+1 with committed head intact.
    return { state: DERIVED_CODES.PENDING, anchor, committed: genBytes, walk: null };
  }
  if (anchor.committed_at === null) {
    return { state: DERIVED_CODES.CHAIN_CORRUPT, anchor, committed: genBytes, walk: null };
  }
  return { state: DERIVED_CODES.COMMITTED, anchor, committed: genBytes, walk: null };
}

/**
 * Build a §R1-closed chain-link document (no digest yet). All identity
 * inputs are validated fail-closed BEFORE any byte exists (zero-write gates).
 */
export function buildDerivedLink({
  executionId, phaseId, generation, previousLinkDigest,
  artifactDigest, artifactSize, mutationId, issuerIdentity,
  revocationGeneration, createdAt,
}) {
  if (!derivedBoundedString(phaseId)) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (!derivedSafeInt(generation, 1)) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (typeof previousLinkDigest !== "string" || !DERIVED_HEX64_RE.test(previousLinkDigest)) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (typeof artifactDigest !== "string" || !DERIVED_HEX64_RE.test(artifactDigest)) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (!derivedSafeInt(artifactSize, 1) || artifactSize > DERIVED_MAX_ARTIFACT_BYTES) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (!derivedBoundedString(mutationId)) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (typeof issuerIdentity !== "string" || !DERIVED_HEX64_RE.test(issuerIdentity)) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (!derivedSafeInt(revocationGeneration, 0)) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  const createdMs = derivedIsoMs(createdAt);
  if (createdMs === null) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  return {
    format_version: DERIVED_ARTIFACT_FORMAT_VERSION,
    execution_id: executionId,
    phase_id: phaseId,
    generation,
    previous_link_digest: previousLinkDigest,
    artifact_identity: { logical_name: "post-finalization-derived", generation },
    artifact_digest: artifactDigest,
    artifact_size: artifactSize,
    mutation_id: mutationId,
    issuer_identity: issuerIdentity,
    revocation_generation: revocationGeneration,
    created_at: createdAt,
    committed_at: null,
    link_digest: null,
  };
}

/** §R1 input rule A5: identity NEVER derives from its own digest. */
export function assertDerivedIdentityNotDigestDerived(input) {
  if (input && typeof input === "object"
    && input.artifact_identity != null
    && typeof input.artifact_identity === "object"
    && input.artifact_identity.digest !== undefined) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  return true;
}

/**
 * §7 revocation gate (zero-write, UNCONDITIONAL — every publication
 * consults the durable authority fold; there is no argument-elision path):
 * consult the fold of the sealed learning-authority module (bound via
 * bindDerivedAuthoritySeam; this file holds no direct import of that stack —
 * the seam object is the only coupling). Semantics over the DURABLE fold:
 *   READY fold + revoked subject           ⇒ AMENDMENT_REVOKED_SUBJECT
 *   READY fold + subject unknown (CURRENT@0) ⇒ proceed with generation 0
 *   fold UNAVAILABLE/CORRUPT               ⇒ fail closed (never a fallback)
 * TransferMetricsError from the seam (e.g. PATH_UNSAFE on a missing root)
 * propagates — the caller cannot elide the gate by omitting arguments.
 */
export function assertDerivedSubjectLive({ transferMetricsRoot, writerId }) {
  return withTransferMetricsReadLockBridge(transferMetricsRoot, () => {
    const replay = replayAuthorityReadinessBridge(transferMetricsRoot);
    if (replay.status === "READY" && replay.fold) {
      if (replay.fold.revokedWriterIds.has(writerId)) {
        throw new C2dHoldError(DERIVED_CODES.REVOKED_SUBJECT, "HOLD / CHECKPOINT_CORRUPT");
      }
      return replay.fold.writerGenerations.get(writerId) ?? 0;
    }
    // No durable GEN-2 fold: the zero-write gate treats authority as
    // unavailable and fails closed (never CURRENT@0 truthiness).
    throw new C2dHoldError(DERIVED_CODES.REVOKED_SUBJECT, "HOLD / CHECKPOINT_CORRUPT");
  });
}

let __authoritySeam = null;
function authoritySeam() {
  if (!__authoritySeam) {
    throw new Error("derived-artifact authority seam not bound");
  }
  return __authoritySeam;
}
function withTransferMetricsReadLockBridge(root, fn) {
  const seam = authoritySeam();
  return seam.withReadLock(root, fn);
}
function replayAuthorityReadinessBridge(root) {
  const seam = authoritySeam();
  return seam.replayReadiness(root);
}

/**
 * Bind the durable authority seam (consumed ONLY from the frozen
 * authority-state module; called by the test harness / future closeout —
 * never auto-wired). No second fold is implemented here.
 */
export function bindDerivedAuthoritySeam({ withReadLock, replayReadiness }) {
  __authoritySeam = { withReadLock, replayReadiness };
}

/**
 * THE frozen 12-step publication protocol (ADMISSION ARTIFACT 1 §2).
 *
 * @param {object} opts
 * @param {string} opts.root — evidence root (outside the repo)
 * @param {string} opts.executionId — exec_<32hex>
 * @param {object}  opts.link — §R1-closed link document (buildDerivedLink)
 *   with committed_at/link_digest left null (owner fills them)
 * @param {Buffer|string} opts.artifactBytes — the pending derived artifact
 *   bytes the pending digest was computed over
 * @param {object} opts.repositoryFingerprint — collectRepositoryFingerprint
 *   output (lease/permit identity)
 * @param {string} [opts.actorId]
 * @param {object} [opts.transferMetricsRoot] — durable authority root for
 *   the §R7 zero-write revocation gate
 * @param {string} [opts.writerId] — subject identity for the revocation gate
 * @returns {object} OPAQUE verified result: { status, generation,
 *   committed_link_digest, committed_at, artifact_digest } — no paths, no
 *   bodies, no credentials.
 */
export async function publishDerivedArtifact(opts) {
  const {
    root, executionId, link, artifactBytes,
    repositoryFingerprint, actorId = "autoloop",
    transferMetricsRoot = null, writerId = null,
  } = opts;
  validateExecutionId(executionId);
  // ── STEP 1 (§2): evidence root + run identity + FINALIZED BASE MANIFEST.
  // Missing base manifest ⇒ explicit AMENDMENT_CHAIN_INCOMPLETE (§R12:
  // never an empty effective state). readRunManifest sidecar-verifies.
  if (readRunManifest(resolveExecDir(root, executionId)) === null) {
    throw new C2dHoldError(DERIVED_CODES.CHAIN_INCOMPLETE, "HOLD / CHECKPOINT_CORRUPT: base manifest not finalized");
  }
  // ── §R1 clock authority: writer clock skew > 300s ⇒ CLOCK_ANOMALY.
  const createdMs = Date.parse(link.created_at);
  if (!Number.isFinite(createdMs) || createdMs > Date.now() + DERIVED_CLOCK_SKEW_MS) {
    throw new C2dHoldError(DERIVED_CODES.CLOCK_ANOMALY, "HOLD / CHECKPOINT_CORRUPT: occurred_at more than 300s after recorded_at");
  }
  if (!link || typeof link !== "object" || Array.isArray(link)) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (link.execution_id !== executionId) {
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }
  const bytes = Buffer.isBuffer(artifactBytes) ? artifactBytes : Buffer.from(String(artifactBytes ?? ""), "utf8");
  if (bytes.length !== link.artifact_size || sha256Hex(bytes) !== link.artifact_digest) {
    // A8/A9: size/digest mismatch between bytes and declared identity.
    throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
  }

  // Bootstrap the exec dir through the SEALED initializer (owner-only 0700;
  // journal/prior/ subdirs). A fresh execution has no CURRENT yet — Phase 1
  // creates it via publishCurrent with expectedRevision 0 semantics (the
  // re-read below returns null and the anchor publishes the first snapshot
  // only when the base checkpoint already exists; otherwise the caller must
  // have finalized a base checkpoint first).
  initExecutionDir(root, executionId);
  const execDir = resolveExecDir(root, executionId);

  // ── Zero-write gates BEFORE the lock: §R7 revocation (UNCONDITIONAL per
  // the frozen text: EVERY publication consults the durable authority fold —
  // omitted transferMetricsRoot/writerId is NOT an elision; the fold is
  // consulted for the ANCHOR's issuer identity, and an absent durable fold
  // fails closed) + §R10 byte gates.
  assertDerivedSubjectLive({
    transferMetricsRoot: transferMetricsRoot,
    writerId: writerId ?? link.issuer_identity,
  });
  const generationPath = derivedGenerationPath(execDir, link.generation);
  // D1/D6 owner restart behavior: discard OUR generation's stale staging
  // temps BEFORE the §R10 gates (a crash between link and tmp-unlink leaves
  // the durable final with nlink=2; the temp is non-authority staging).
  discardStagingTemps(generationPath);
  derivedAssertPublicationGates({ linkBytes: bytes, identity: link.artifact_identity, generationPath });

  // ── Checkpoint credential seam (consume-only): lease + permit.
  const acquired = acquireLease(execDir, {
    execution_id: executionId,
    chain_id: link.chain_id ?? deriveChainId(executionId),
    checkpoint_id: link.checkpoint_id ?? deriveCheckpointId(executionId),
    repository_identity: repositoryFingerprint.repository_root_identity,
    worktree_identity: repositoryFingerprint.worktree_identity,
    actor_id: actorId,
    expected_head: repositoryFingerprint.expected_head,
    mutation_capability: false,
    role: "autoloop-derived-artifact",
  });
  let leaseHeld = true;
  let permit = permitFromLease(execDir, acquired.lease, acquired.secrets, false);
  const live = readLease(execDir); // live lease = the checkpoint-store lock-identity source

  let lock = null;
  try {
    // ── STEP 1-2 (§2): evidence root verified above; acquire THE structured
    // lock on CURRENT.json.lock. It is released ONLY after step 12 (D1).
    lock = acquireStructuredLockDirect(execDir, permit, live);
    // D1 continuous hold: publishCurrent reuses THIS capability for Phase 1
    // and Phase 3 instead of re-acquiring (ownership re-proven per reuse).
    permit = permitFromLease(execDir, acquired.lease, acquired.secrets, false, lock);

    // ── C5 owner restart behavior: a crash between the CURRENT.json replace
    // and the sidecar rename leaves the sidecar missing/torn while CURRENT
    // bytes are complete-or-previous. Under the CONTINUOUS lock hold, the
    // owner re-publishes the sidecar from the durable CURRENT bytes (atomic
    // replace, same primitive family) — then STEP 3 re-reads authority.
    healSidecarUnderLock(execDir);
    // ── STEP 3: re-read authority under the lock (pre-lock reads advisory).
    const cur = readCurrent(execDir);
    const priorAnchor = cur ? safeAnchor(cur.snapshot) : null;

    // ── D4/D7 idempotency trio adjudication (acknowledged links only),
    // BEFORE stale-generation rejection: a deterministic retry of an
    // already-committed mutation (same mutation_id + same link, same
    // identity) is ALREADY_SATISFIED with the ORIGINAL durable event —
    // the retry's own clock value is discarded (D7).
    const committedGeneration = priorAnchor ? priorAnchor.committed_generation : 0;
    const committedLinkDigest = priorAnchor ? priorAnchor.committed_link_digest : DERIVED_GENESIS;
    if (priorAnchor && priorAnchor.committed_generation >= 1
      && adjudicateD7Pair(execDir, committedGeneration, link)) {
      // STEP 12 short-circuit (ALREADY_SATISFIED with ORIGINAL commit).
      const result = {
        status: DERIVED_CODES.ALREADY_SATISFIED,
        generation: committedGeneration,
        committed_link_digest: priorAnchor.committed_link_digest,
        committed_at: priorAnchor.committed_at,
        artifact_digest: committedArtifactDigest(execDir, committedGeneration),
      };
      lock.release();
      lock = null;
      releaseLeaseBridge(execDir, acquired);
      leaseHeld = false;
      return result;
    }
    // ── §R4/D5 walk-derived authority: the committed head MUST be rebuildable
    // by the canonical reader BEFORE any extension. Extending from a corrupt
    // or unacknowledged chain is FORBIDDEN — fail closed before Phase 1
    // (zero-write for the new generation).
    if (committedGeneration >= 1) {
      try {
        derivedWalkChain(execDir);
      } catch (e) {
        throw new C2dHoldError(DERIVED_CODES.CHAIN_CORRUPT, `HOLD / CHECKPOINT_CORRUPT: ${e.code ?? e.message}`);
      }
    }
    // ── STEP 4: identity/generation/issuer/revocation verification.
    if (link.generation !== committedGeneration + 1) {
      throw new C2dHoldError(DERIVED_CODES.STALE_GENERATION, "HOLD / CHECKPOINT_CORRUPT");
    }
    // §R1 continuity: the new link's predecessor digest MUST be the
    // acknowledged committed head (GENESIS for generation 1) — a fabricated
    // tail can never enter the chain (H5 rollback-resurrection fence).
    const expectedPrev = committedGeneration >= 1 ? committedLinkDigest : DERIVED_GENESIS;
    if (link.previous_link_digest !== expectedPrev) {
      throw new C2dHoldError(DERIVED_CODES.CHAIN_CORRUPT, "HOLD / CHECKPOINT_CORRUPT: predecessor digest mismatch");
    }
    if (priorAnchor && priorAnchor.execution_id !== executionId) {
      throw new C2dHoldError(DERIVED_CODES.ANCHOR_IDENTITY_MISMATCH, "HOLD / CHECKPOINT_CORRUPT");
    }
    if (transferMetricsRoot != null && writerId != null) {
      // Issuer revalidation UNDER the lock (§R7/C18/I3).
      assertDerivedSubjectLive({ transferMetricsRoot, writerId });
    }


/**
 * C5 frozen restart behavior: re-publish CURRENT.json.sha256 from the
 * durable CURRENT.json bytes under the already-held CURRENT.json.lock.
 * CURRENT bytes are complete-or-previous by atomic-replace discipline, so
 * the recomputed checksum always matches the bytes on disk. A NO-OP when
 * the sidecar is already consistent. Caller MUST hold the structured lock.
 */
function healSidecarUnderLock(execDir) {
  const cp = currentPath(execDir);
  if (!existsSync(cp)) return;
  const shaPath = join(execDir, "CURRENT.json.sha256");
  const bytes = readFileSync(cp);
  const digest = sha256Hex(bytes);
  let consistent = false;
  if (existsSync(shaPath)) {
    try {
      assertNotSymlink(shaPath);
      consistent = readFileSync(shaPath, "utf8").trim() === digest;
    } catch { consistent = false; }
  }
  if (consistent) return;
  const tmp = `${shaPath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, Buffer.from(digest + "\n", "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, shaPath);
  fsyncDirBridge(execDir);
}

    // ── D1 lost-Phase-1-writer adjudication: orphan pending intent?
    if (priorAnchor && priorAnchor.pending_mutation_id !== null
      && priorAnchor.pending_mutation_id !== link.mutation_id
      && priorAnchor.pending_generation === link.generation) {
      adjudicateOrphanIntent(execDir, priorAnchor);
    }

    // ── STEP 5 (Phase 1): durable pending-intent publish via checkpoint CAS.
    // pending_link_digest = FULL canonical durable-link-bytes digest. When a
    // crashed publisher of the SAME identity already recorded a pending
    // intent (C2/C3 restart), the on-record digest is authority: the retry
    // adopts it (retry-skew created_at never changes the durable bytes).
    const selfDigest = derivedLinkDigest(link);
    const finalLink = { ...link, link_digest: selfDigest };
    const finalBytes = derivedCanonicalLinkBytes({ ...finalLink, committed_at: null });
    const ownDigest = sha256Hex(finalBytes);
    let pendingDigest = ownDigest;
    if (priorAnchor && priorAnchor.pending_mutation_id === link.mutation_id
      && priorAnchor.pending_generation === link.generation
      && priorAnchor.pending_link_digest !== ownDigest) {
      // Same identity, different retry skew: verify the durable bytes (if
      // any) against the ON-RECORD digest, then keep that digest.
      const existing = derivedReadGenerationBytes(execDir, link.generation);
      if (existing.exists && existing.digest === priorAnchor.pending_link_digest) {
        pendingDigest = priorAnchor.pending_link_digest;
      }
    }
    publishAnchor(execDir, cur, permit, {
      execution_id: executionId,
      phase_id: link.phase_id,
      committed_generation: committedGeneration,
      committed_link_digest: committedLinkDigest === DERIVED_GENESIS ? null : committedLinkDigest,
      committed_at: priorAnchor?.committed_at ?? null,
      revocation_generation: link.revocation_generation,
      pending_mutation_id: link.mutation_id,
      pending_generation: link.generation,
      pending_link_digest: pendingDigest,
    }, repositoryFingerprint);

    // ── D4: quarantined bytes never resurrect through the retry path. If a
    // quarantine marker (ABORTED-<gen>-*) exists for THIS generation, any
    // re-publication against it fails closed — the quarantined identity may
    // only re-enter via a fresh mutation at a FRESH generation (operator
    // resolves the cause first).
    assertNoQuarantineMarker(execDir, link.generation);
    // ── STEP 6-8 (Phase 2): temp wx → file fsync → no-replace link → dir fsync.
    // The link bytes = the canonical §R1 document (committed_at stays null
    // until commit; committed_at lives in the ANCHOR, not the link body).
    fireHook("derived_after_pending_intent"); // C2/C7 crash-point boundary
    writeLinkExclusive(execDir, link.generation, finalBytes);

    // ── STEP 9: re-verify durable bytes against the pending digest.
    const published = derivedReadGenerationBytes(execDir, link.generation);
    if (!published.exists || published.digest !== pendingDigest) {
      derivedQuarantine(execDir, link.generation, "verify");
      throw new C2dHoldError(DERIVED_CODES.PUBLISHED_BYTES_MISMATCH, "HOLD / CHECKPOINT_CORRUPT");
    }

    // ── STEP 10 (Phase 3): checkpoint CAS commit — THE commit point.
    fireHook("derived_before_commit_anchor"); // C5/C9 crash-point boundary
    const committedAt = new Date().toISOString();
    publishAnchor(execDir, null, permit, {
      execution_id: executionId,
      phase_id: link.phase_id,
      committed_generation: link.generation,
      committed_link_digest: pendingDigest,
      committed_at: committedAt,
      revocation_generation: link.revocation_generation,
      pending_mutation_id: null,
      pending_generation: null,
      pending_link_digest: null,
    }, repositoryFingerprint);

    // ── STEP 11-12: final re-read; the committed truth MUST be rebuildable
    // by the canonical reader (walk + anchor + gates). OPAQUE result only.
    const verified = derivedVerifyCommitted(execDir, { executionId, phaseId: link.phase_id });
    if (!verified.ok) {
      throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, verified.code);
    }
    const result = {
      status: DERIVED_CODES.COMMITTED,
      generation: link.generation,
      committed_link_digest: pendingDigest,
      committed_at: committedAt,
      artifact_digest: link.artifact_digest,
    };
    lock.release();
    lock = null;
    releaseLeaseBridge(execDir, acquired);
    leaseHeld = false;
    return result;
  } finally {
    if (lock) {
      try { lock.release(); } catch { /* release-on-error best effort; reclaim is forensically safe */ }
    }
    if (leaseHeld) {
      try { releaseLeaseBridge(execDir, acquired); } catch { /* fail-closed on next acquire */ }
    }
  }
}

const DERIVED_GENESIS = "0".repeat(64);
/**
 * D4/D7 pair adjudication: ALREADY_SATISFIED iff the committed head link
 * carries the retry's (artifact_digest, committed identity) pair — the
 * frozen idempotency key. created_at divergence alone with equal digests is
 * accepted retry skew (D7); identity (execution/phase/generation/mutation)
 * mismatch is NOT a retry and fails the pair.
 */
function adjudicateD7Pair(execDir, committedGeneration, link) {
  const bytes = derivedReadGenerationBytes(execDir, committedGeneration);
  if (!bytes.exists) return false;
  let parsed;
  try {
    parsed = JSON.parse(bytes.bytes.toString("utf8"));
  } catch {
    return false;
  }
  return parsed.artifact_digest === link.artifact_digest
    && parsed.mutation_id === link.mutation_id
    && parsed.execution_id === link.execution_id
    && parsed.phase_id === link.phase_id
    && parsed.generation === link.generation
    && parsed.issuer_identity === link.issuer_identity;
}

function committedArtifactDigest(execDir, committedGeneration) {
  const bytes = derivedReadGenerationBytes(execDir, committedGeneration);
  return bytes.exists ? linkArtifactDigest(bytes.bytes) : null;
}

function linkArtifactDigest(bytes) {
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    return typeof parsed.artifact_digest === "string" ? parsed.artifact_digest : null;
  } catch {
    return null;
  }
}

function safeAnchor(snapshot) {
  try {
    validateAnchorBlock(snapshot);
  } catch (e) {
    if (e instanceof C2dHoldError && e.code === HOLD.ANCHOR_SCHEMA_INVALID) {
      throw new C2dHoldError(DERIVED_CODES.ANCHOR_SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
    }
    throw e;
  }
  return getAnchorBlock(snapshot);
}

function linkWithDigest(link, digest) {
  const l = { ...link };
  if (l.link_digest == null) l.link_digest = digest ?? derivedLinkDigest(l);
  return l;
}

function acquireStructuredLockDirect(execDir, permit, live) {
  // The lease/permit credential carries the canonical repository/worktree
  // identity; the CURRENT.json.lock record MUST match publishCurrent's own
  // record fields exactly (§R2 one namespace, one affinity discipline).
  void execDir;
  return acquireStructuredLockForBridge(join(execDir, "CURRENT.json.lock"), {
    lock_kind: "current",
    execution_id: permit.execution_id,
    checkpoint_id: permit.checkpoint_id,
    chain_id: permit.chain_id,
    lease_id: permit.lease_id,
    lease_revision: permit.lease_revision,
    actor_id: permit.actor_id,
    session_id: permit.session_id,
    repository_identity: live.repository_identity,
    worktree_identity: live.worktree_identity,
    expected_head: live.expected_head,
  });
}

/**
 * Publish the anchor block through the SEALED checkpoint authority
 * (publishCurrent: structured lock + revision CAS + write permit + external
 * sidecar + prior/ immutable store). `prior` = the re-read CURRENT (or null
 * to re-read internally). The revision CAS is expectedRevision = prior
 * revision; a concurrent writer between our re-read and this publish fails
 * CHECKPOINT_STALE_REVISION (never last-writer-wins).
 */
function publishAnchor(execDir, prior, permit, anchorFields, repositoryFingerprint) {
  const cur = prior ?? readCurrent(execDir);
  if (cur) {
    const expectedRevision = cur.snapshot.revision;
    const snapshot = {
      ...cur.snapshot,
      revision: expectedRevision + 1,
      [ANCHOR_BLOCK_FIELD]: anchorFields,
    };
    publishCurrent(execDir, snapshot, { expectedRevision, permit });
    return;
  }
  // First anchor on a fresh execution: createInitialSnapshot through the
  // SEALED factory, then ride the anchor block on it (publishCurrent runs
  // the full permit + structured-lock + sidecar discipline itself).
  const identity = {
    execution_id: anchorFields.execution_id,
    checkpoint_id: deriveCheckpointId(anchorFields.execution_id),
    chain_id: deriveChainId(anchorFields.execution_id),
  };
  const snapshot = {
    ...createInitialSnapshotBridge(execDir, identity, repositoryFingerprint),
    revision: 1,
    [ANCHOR_BLOCK_FIELD]: anchorFields,
  };
  publishCurrent(execDir, snapshot, { expectedRevision: 0, permit });
}

function createInitialSnapshotBridge(execDir, identity, repositoryFingerprint) {
  void execDir;
  return createInitialSnapshot({
    checkpoint_id: identity.checkpoint_id,
    execution_id: identity.execution_id,
    chain_id: identity.chain_id,
    repository_fingerprint: repositoryFingerprint,
    repository_root_identity: repositoryFingerprint.repository_root_identity,
    git_common_dir_identity: repositoryFingerprint.git_common_dir_identity,
    expected_head: repositoryFingerprint.expected_head,
    expected_ref: repositoryFingerprint.expected_ref,
    expected_worktree_state: repositoryFingerprint.expected_worktree_state,
    origin_url: repositoryFingerprint.origin_url,
    origin_master: repositoryFingerprint.origin_master,
  });
}

/**
 * Phase-2 exclusive publication of the generation link: temp wx → write →
 * file fsync → linkSync (EEXIST ⇒ adjudicate, never overwrite) → dir fsync.
 * EEXIST with byte-identical existing bytes = deterministic idempotent
 * completion (same mutation re-entry); EEXIST with different bytes =
 * AMENDMENT_IDENTITY_CONFLICT (§R3).
 */
function writeLinkExclusive(execDir, generation, bytes) {
  const dir = join(execDir, DERIVED_CHAIN_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const finalPath = derivedGenerationPath(execDir, generation);
  assertPathComponentsNotSymlink(finalPath, { allowMissingLeaf: true });
  const tmp = `${finalPath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const fd = openSync(tmp, "wx", 0o600);
  fireHook("derived_before_file_write");
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
    fireHook("derived_after_file_fsync"); // C1/C4 crash-point boundary
  } finally {
    closeSync(fd);
  }
  try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  fireHook("derived_before_link");
  try {
    linkSync(tmp, finalPath);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* */ }
    if (e && e.code === "EEXIST") {
      const existing = readFileSync(finalPath);
      if (existing.equals(bytes)) {
        return completeEexistRetry(finalPath); // byte-identical retry
      }
      // §R3/D7 deterministic retry: a retry re-serializes the SAME identity;
      // only retry-skew fields (created_at) may differ. Compare the frozen
      // identity fields; equal ⇒ accept the durable original (never a
      // rewrite); any identity difference ⇒ AMENDMENT_IDENTITY_CONFLICT.
      if (linkIdentityEquivalent(existing, bytes)) {
        return completeEexistRetry(finalPath);
      }
      throw new C2dHoldError(DERIVED_CODES.IDENTITY_CONFLICT, "HOLD / CHECKPOINT_CORRUPT");
    }
    throw e;
  }
  fireHook("derived_after_link"); // C3/C6 crash-point boundary
  try { unlinkSync(tmp); } catch { /* */ }
  fsyncDirBridge(dirname(finalPath));
  fireHook("derived_after_dir_fsync"); // C6/C10 dir-durability boundary
  return finalPath;
}

/** D7 retry-skew equivalence: identity fields equal, created_at may differ. */
function linkIdentityEquivalent(existingBytes, retryBytes) {
  const parse = (b) => {
    try { return JSON.parse(b.toString("utf8")); } catch { return null; }
  };
  const a = parse(existingBytes);
  const b = parse(retryBytes);
  if (!a || !b) return false;
  return a.execution_id === b.execution_id
    && a.phase_id === b.phase_id
    && a.generation === b.generation
    && a.mutation_id === b.mutation_id
    && a.artifact_digest === b.artifact_digest
    && a.artifact_size === b.artifact_size
    && a.issuer_identity === b.issuer_identity
    && a.revocation_generation === b.revocation_generation
    && a.previous_link_digest === b.previous_link_digest;
}

function completeEexistRetry(finalPath) {
  fireHook("derived_after_link"); // deterministic retry completion (C4/E3)
  fsyncDirBridge(dirname(finalPath));
  fireHook("derived_after_dir_fsync");
  return finalPath;
}

/**
 * D1 orphan-intent adjudication (owner-executed; never caller-decided):
 *  - orphan pending_link_digest matches a published link ⇒ quarantine the
 *    orphan generation and FAIL_CLOSED AMENDMENT_PENDING_CONFLICT (the
 *    crashed owner's commit is never adopted as the caller's own; D4 keeps
 *    quarantine from resurrecting).
 *  - bytes exist but do NOT match the orphan intent ⇒ ambiguous state,
 *    FAIL_CLOSED AMENDMENT_PENDING_CONFLICT (no bytes are touched).
 *  - no link bytes ⇒ stale superseded intent (C15): quarantine-by-naming
 *    only; the caller's own Phase-1 CAS publish clears the pending trio.
 *  - unparseable/unsafe generation ⇒ AMENDMENT_PENDING_CONFLICT.
 */
function adjudicateOrphanIntent(execDir, orphan) {
  const gen = orphan.pending_generation;
  if (!derivedSafeInt(gen, 1)) {
    throw new C2dHoldError(DERIVED_CODES.PENDING_CONFLICT, "HOLD / CHECKPOINT_CORRUPT");
  }
  const genBytes = derivedReadGenerationBytes(execDir, gen);
  if (genBytes.exists && genBytes.digest === orphan.pending_link_digest) {
    // D1 adopt rule: the orphan's link is fully published and matches its
    // intent. The ORPHAN's own Phase-3 commit belongs to the crashed owner;
    // the current caller may NOT adopt another mutation's intent as its own
    // commit — fail closed with AMENDMENT_PENDING_CONFLICT and quarantine
    // the orphan generation (operator resolves; D4 keeps quarantine from
    // resurrecting). Deterministic; never a silent overwrite.
    derivedQuarantine(execDir, gen, "orphan");
    throw new C2dHoldError(DERIVED_CODES.PENDING_CONFLICT, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (genBytes.exists) {
    // Bytes exist but do NOT match the orphan intent: ambiguous — fail closed.
    throw new C2dHoldError(DERIVED_CODES.PENDING_CONFLICT, "HOLD / CHECKPOINT_CORRUPT");
  }
  // No link bytes: the orphan intent is a stale superseded mutation
  // (C15/D1): quarantine-by-naming only (no bytes to move) — the caller's
  // own Phase-1 CAS publish below clears the pending trio and allocates
  // the SAME generation for ITS mutation (stale orphan consumed).
}


/**
 * The frozen canonical reader (ADMISSION ARTIFACT 1 §3). Walks ONLY the
 * chain acknowledged by the anchor; verifies per generation: closed schema,
 * self digest, predecessor continuity, artifact digest/size, identity
 * binding. Distinguishes trailing deletion / rollback / revoked resurrection.
 * Data minimization: errors carry code + opaque digests only.
 */
export function derivedWalkChain(execDir, { expectedHeadDigest = null } = {}) {
  const cur = readCurrent(execDir);
  if (!cur) {
    return { ok: true, state: DERIVED_CODES.ABSENT, head: null, generations: [] };
  }
  const anchor = safeAnchor(cur.snapshot);
  if (!anchor) {
    return { ok: true, state: DERIVED_CODES.ABSENT, head: null, generations: [] };
  }
  if (anchor.committed_generation === 0) {
    return { ok: true, state: DERIVED_CODES.ABSENT, head: null, generations: [] };
  }
  // Path safety FIRST: a symlinked derived dir (or any symlink component)
  // is PATH_UNSAFE — never interpretable as a missing/tail-loss state.
  assertPathComponentsNotSymlink(join(execDir, DERIVED_CHAIN_DIR));
  // Walk from genesis (generation 1) to committed head; verify continuity.
  const generations = [];
  let previousDigest = DERIVED_GENESIS_PREFIX;
  for (let g = 1; g <= anchor.committed_generation; g += 1) {
    const b = derivedReadGenerationBytes(execDir, g);
    if (!b.exists) {
      // Missing generation NEVER becomes 0/skipped (§R4/§R6): distinguish
      // tail loss (missing at the head) from a hole (missing in the middle).
      if (g === anchor.committed_generation) {
        throw new C2dHoldError(DERIVED_CODES.TAIL_LOSS, "HOLD / CHECKPOINT_CORRUPT");
      }
      throw new C2dHoldError(DERIVED_CODES.CHAIN_INCOMPLETE, "HOLD / CHECKPOINT_CORRUPT");
    }
    let parsed;
    try {
      parsed = JSON.parse(b.bytes.toString("utf8"));
    } catch {
      throw new C2dHoldError(DERIVED_CODES.CHAIN_CORRUPT, "HOLD / CHECKPOINT_CORRUPT");
    }
    // Closed-field validation (§R1): unknown field ⇒ FAIL_CLOSED.
    for (const key of Object.keys(parsed)) {
      if (!DERIVED_LINK_FIELDS.includes(key)) {
        throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
      }
    }
    for (const key of DERIVED_LINK_FIELDS) {
      if (!(key in parsed)) {
        throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
      }
    }
    if (parsed.generation !== g) {
      throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
    }
    // §R1 SELF digest: over canonical bytes EXCLUDING the link_digest field.
    const recomputedSelfDigest = derivedLinkDigest(parsed);
    if (parsed.link_digest !== recomputedSelfDigest) {
      throw new C2dHoldError(DERIVED_CODES.LINK_SELF_DIGEST_MISMATCH, "HOLD / CHECKPOINT_CORRUPT");
    }
    if (g === 1) {
      if (parsed.previous_link_digest !== DERIVED_GENESIS) {
        // Checkpoint rollback at the walk start (§R5 detection proof).
        throw new C2dHoldError(DERIVED_CODES.ROLLBACK_DETECTED, "HOLD / CHECKPOINT_CORRUPT");
      }
    } else if (parsed.previous_link_digest !== previousDigest) {
      throw new C2dHoldError(DERIVED_CODES.CHAIN_CORRUPT, "HOLD / CHECKPOINT_CORRUPT");
    }
    if (parsed.artifact_size == null || !derivedSafeInt(parsed.artifact_size, 1)
      || !DERIVED_HEX64_RE.test(parsed.artifact_digest)) {
      throw new C2dHoldError(DERIVED_CODES.SCHEMA_INVALID, "HOLD / CHECKPOINT_CORRUPT");
    }
    // previousDigest = FULL canonical bytes digest (the anchor's digest
    // basis); predecessor continuity for the NEXT link uses this digest.
    generations.push({ generation: g, link_digest: parsed.link_digest, artifact_digest: parsed.artifact_digest, bytes_digest: b.digest });
    previousDigest = b.digest;
  }
  if (anchor.committed_link_digest !== previousDigest) {
    // Walk head does not match the anchor acknowledgment: rollback/rewrite.
    throw new C2dHoldError(DERIVED_CODES.ROLLBACK_DETECTED, "HOLD / CHECKPOINT_CORRUPT");
  }
  if (expectedHeadDigest != null && expectedHeadDigest !== previousDigest) {
    throw new C2dHoldError(DERIVED_CODES.TAIL_LOSS, "HOLD / CHECKPOINT_CORRUPT");
  }
  return { ok: true, state: DERIVED_CODES.COMMITTED, head: previousDigest, generations, anchor };
}

const DERIVED_GENESIS_PREFIX = DERIVED_GENESIS;

/** Step 11/12 verification: committed head is rebuildable by the reader. */
function derivedVerifyCommitted(execDir, { executionId, phaseId }) {
  void executionId; void phaseId;
  try {
    const walked = derivedWalkChain(execDir);
    return { ok: walked.ok, code: null, walked };
  } catch (e) {
    if (e instanceof C2dHoldError) return { ok: false, code: e.message, walked: null };
    throw e;
  }
}

function releaseLeaseBridge(execDir, acquired) {
  releaseLease(execDir, acquired.lease.lease_id, acquired.lease.lease_revision, acquired.secrets);
}

function assertValidEvidenceRootBridge(root) {
  // The SEALED validator is the single root authority (outside-repo, 0700,
  // no symlink). Consume it; never re-implement it.
  assertValidEvidenceRoot(root, null);
}

function currentLockPathBridge(execDir) {
  return join(execDir, "CURRENT.json.lock");
}
