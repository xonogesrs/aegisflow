// src/v2/checkpoint-bridge.mjs
//
// C3 — AutoLoop checkpoint bridge on top of the sealed C2D checkpoint store.
//
// Reuses（never re-implements）:
//  - execution-id（mint/validate exec ids, secret digests）
//  - checkpoint-store（initExecutionDir, resolveExecDir, readCurrent,
//    publishCurrent — external checksum + CAS revision + structured lock +
//    write permit）
//  - lease/permit（acquireLease → permitFromLease → releaseLease）
//  - fingerprint（collectFingerprint / assertFingerprint）
//
// AutoLoop additive snapshot fields ride inside the C2D snapshot so the
// existing checksum/CAS/permit/lock authority stays the single writer of
// CURRENT.json. No second checkpoint authority is introduced.

import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  C2dHoldError, HOLD, sha256Hex,
} from "../c2d/fs-atomic.mjs";
import { mintExecutionId, validateExecutionId, mintChainId, mintCheckpointId } from "../c2d/execution-id.mjs";
import {
  resolveExecDir, initExecutionDir, readCurrent, publishCurrent,
  currentPath,
} from "../c2d/checkpoint-store.mjs";
import { acquireLease, releaseLease } from "../c2d/lease.mjs";
import { permitFromLease } from "../c2d/permit.mjs";
import { collectFingerprint, assertFingerprint } from "../c2d/fingerprint.mjs";
import { canonicalJson, sha256Text } from "../evidence/run-evidence-store.mjs";
import { existsSync, readFileSync } from "node:fs";

export const AUTOLOOP_CHECKPOINT_FORMAT_VERSION = "1.0.0";
export const AUTOLOOP_STATE_RUNNING = "AUTOLOOP_RUNNING";
export const AUTOLOOP_STATE_RESUMABLE = "AUTOLOOP_RESUMABLE";
export const AUTOLOOP_STATE_RESTART_REQUIRED = "AUTOLOOP_RESTART_REQUIRED";
export const AUTOLOOP_STATE_PASS = "AUTOLOOP_TERMINAL_PASS";
export const AUTOLOOP_STATE_HOLD = "AUTOLOOP_TERMINAL_HOLD";
export const AUTOLOOP_STATE_NOT_BENEFICIAL = "AUTOLOOP_TERMINAL_NOT_BENEFICIAL";

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
  }));
}

// ── Snapshot construction（C2D required fields + AutoLoop additive）───────

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
    // ── AutoLoop additive ──
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
 * Publish one AutoLoop checkpoint through the sealed C2D publishCurrent
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
 * Read the current AutoLoop checkpoint（checksum-verified by readCurrent）.
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
