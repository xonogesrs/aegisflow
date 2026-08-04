import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  C2dHoldError, HOLD, ensureDir0700, sha256Hex, isSha256Hex, fireHook,
  assertNotSymlink, assertInsideRoot, assertPathComponentsNotSymlink,
  resolveSafeRoot, writeExclusiveCreate, writeAtomicReplaceUnderLock,
  writeJsonAtomicReplaceUnderLock,
} from "./fs-atomic.mjs";
import { validateExecutionId } from "./execution-id.mjs";
import { assertWritePermit } from "./permit.mjs";
import { acquireStructuredLock } from "./lock.mjs";

export const FORMAT_VERSION = "1.0.0";
export const SUPPORTED_FORMAT_MAJOR = 1;
export const KNOWN_CONTROL_STATES = new Set([
  "CHECKPOINT_CREATED",
  "RESUME_ELIGIBLE",
  "RESUME_VALIDATING",
  "RESUME_LEASE_ACQUIRED",
  "RESUME_RECONCILING",
  "RESUME_READY",
  "RESUMED",
  "RESUME_HOLD",
  "RESUME_ABORTED",
  "RESUME_COMPLETED",
  // C3B controlled mutation boundary lifecycle states (additive; read-only
  // slice-1 states above are untouched and remain the only states any
  // existing caller ever produces).
  "READY",
  "MUTATION_AUTHORIZED",
  "BASELINE_CAPTURED",
  "MUTATING",
  "MUTATION_COMPLETE",
  "VALIDATING",
  "READY_FOR_REVIEW",
  "REVIEWED",
  "AWAITING_COMMIT_APPROVAL",
  // C3B/C2D reviewed immutable candidate handoff. These are checkpoint
  // states, never commit/push/seal authorization.
  "CANDIDATE_CAPTURE_INTENT",
  "CANDIDATE_CAPTURE_VERIFIED_COMPLETE",
  "CANDIDATE_CAPTURED",
  "CANDIDATE_VERIFIED",
  "READY_FOR_COMMIT_AUTHORIZATION",
  "MATERIALIZATION_INTENT",
  "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE",
  "MATERIALIZED_VERIFIED",
  "CANDIDATE_EXPIRED",
  "CANDIDATE_HOLD",
  "SCOPE_VIOLATION",
  "MUTATION_FAILED",
  "VALIDATION_FAILED",
  "ENVIRONMENT_FAILURE",
  "EXECUTOR_ABANDONED",
  "RECOVERY_REQUIRED",
  "REVIEW_HOLD",
  "ROLLBACK_FAILED",
  // C3 AutoLoop additive states（checkpoint-bridge 使用；不影響既有 callers）
  "AUTOLOOP_RUNNING",
  "AUTOLOOP_RESUMABLE",
  "AUTOLOOP_TERMINAL_PASS",
  "AUTOLOOP_TERMINAL_HOLD",
  "AUTOLOOP_TERMINAL_NOT_BENEFICIAL",
  // C4I additive: pre-decomposition / incomplete-decomposition runs whose
  // checkpoint lacks the resume material (decomposition-ir + verified
  // IR/DAG hashes + frozen phase set). Such runs cannot be resumed and must
  // be restarted under a NEW execution id. Never marked RESUMABLE.
  "AUTOLOOP_RESTART_REQUIRED",
]);

export function resolveExecDir(checkpointRoot, executionId) {
  validateExecutionId(executionId);
  assertPathComponentsNotSymlink(checkpointRoot, { allowMissingLeaf: true });
  const root = resolveSafeRoot(checkpointRoot);
  const execDir = join(root, executionId);
  assertInsideRoot(root, execDir);
  assertPathComponentsNotSymlink(execDir, { allowMissingLeaf: true });
  return execDir;
}

export function initExecutionDir(checkpointRoot, executionId) {
  assertPathComponentsNotSymlink(checkpointRoot, { allowMissingLeaf: true });
  const root = resolveSafeRoot(checkpointRoot);
  ensureDir0700(root);
  assertNotSymlink(root);
  const execDir = resolveExecDir(checkpointRoot, executionId);
  if (existsSync(execDir)) assertNotSymlink(execDir);
  ensureDir0700(execDir);
  ensureDir0700(join(execDir, "journal"));
  ensureDir0700(join(execDir, "prior"));
  return execDir;
}

export function currentPath(execDir) {
  return join(execDir, "CURRENT.json");
}

export function checksumPath(execDir) {
  return join(execDir, "CURRENT.json.sha256");
}

export function currentLockPath(execDir) {
  return join(execDir, "CURRENT.json.lock");
}

export function readCurrent(execDir) {
  const p = currentPath(execDir);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  const cp = checksumPath(execDir);
  if (!existsSync(cp)) {
    throw new C2dHoldError(HOLD.SNAPSHOT_CHECKSUM_MISMATCH, "CURRENT.json.sha256 missing");
  }
  assertNotSymlink(cp);
  const bytes = readFileSync(p);
  const expected = readFileSync(cp, "utf8").trim();
  const actual = sha256Hex(bytes);
  if (expected !== actual || !isSha256Hex(expected)) {
    throw new C2dHoldError(HOLD.SNAPSHOT_CHECKSUM_MISMATCH, "CURRENT checksum mismatch");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, `CURRENT.json parse error: ${e.message}`);
  }
  return { snapshot, bytes, digest: actual };
}

/**
 * Publish CURRENT under exclusive lock + expected_revision CAS + write permit.
 */
export function publishCurrent(execDir, snapshot, { expectedRevision, permit } = {}) {
  if (!permit) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REQUIRED, "write permit required");
  }
  if (snapshot.execution_id !== permit.execution_id ||
      snapshot.checkpoint_id !== permit.checkpoint_id ||
      snapshot.chain_id !== permit.chain_id) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REQUIRED, "snapshot identity does not match permit");
  }

  const live = assertWritePermit(execDir, permit);
  let lock;
  try {
    lock = acquireStructuredLock(currentLockPath(execDir), {
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
  } catch (e) {
    if (e instanceof C2dHoldError) {
      // surface lock/guard-recovery taxonomy rather than masquerading as CAS
      const code = String(e.code);
      if (code.includes("LOCK_") || code.includes("GUARD") || code.includes("RECLAIM")) throw e;
      throw new C2dHoldError(HOLD.CHECKPOINT_STALE_REVISION, "CURRENT lock busy (CAS contention)", {
        cause: e.code,
      });
    }
    throw e;
  }

  try {
    const existing = existsSync(currentPath(execDir)) ? readCurrent(execDir) : null;
    if (expectedRevision != null) {
      const cur = existing ? existing.snapshot.revision : 0;
      if (cur !== expectedRevision) {
        throw new C2dHoldError(HOLD.CHECKPOINT_STALE_REVISION, "stale revision CAS", {
          expected: expectedRevision,
          actual: cur,
        });
      }
    }

    if (existing) {
      const priorDir = join(execDir, "prior");
      ensureDir0700(priorDir);
      const priorPath = join(priorDir, `CURRENT.${pad(existing.snapshot.revision)}.json`);
      // exclusive create for prior (immutable once written for that revision)
      try {
        writeExclusiveCreate(priorPath, existing.bytes);
      } catch (e) {
        if (!(e instanceof C2dHoldError && e.code === HOLD.JOURNAL_OUT_OF_ORDER)) throw e;
        // prior already exists for this revision — ok if same digest
        const prev = readFileSync(priorPath);
        if (sha256Hex(prev) !== sha256Hex(existing.bytes)) {
          throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "prior snapshot conflict");
        }
      }
    }

    const body = {
      ...snapshot,
      format_version: FORMAT_VERSION,
      checkpoint_integrity: {
        algorithm: "sha256",
        digest_basis: "external_current_file",
      },
      updated_at: new Date().toISOString(),
      dirty_state_policy: "clean_only_slice1_not_content_affinity",
    };
    validateSnapshotStructure(body);

    fireHook("before_current_temp_write");
    const published = writeJsonAtomicReplaceUnderLock(currentPath(execDir), body, {
      hookBeforeRename: "before_current_rename",
      hookAfterRename: "after_current_rename",
    });
    const digest = sha256Hex(published.bytes);
    fireHook("before_checksum_rename");
    const cksum = writeAtomicReplaceUnderLock(checksumPath(execDir), digest + "\n", {
      hookBeforeRename: "before_checksum_rename",
      hookAfterRename: "after_checksum_rename",
    });
    return {
      snapshot: body,
      bytes: published.bytes,
      digest,
      durability_capability: published.durability_capability || cksum.durability_capability,
      durability_reason: published.reason || cksum.reason,
    };
  } finally {
    lock.release();
  }
}

function pad(n) {
  return String(n).padStart(12, "0");
}

export function createInitialSnapshot(fields) {
  const now = new Date().toISOString();
  return {
    format_version: FORMAT_VERSION,
    checkpoint_id: fields.checkpoint_id,
    revision: 0,
    execution_id: fields.execution_id,
    chain_id: fields.chain_id,
    phase: "C2D_RUNTIME",
    stage: "INIT",
    state: "CHECKPOINT_CREATED",
    c2d_control_state: "CHECKPOINT_CREATED",
    created_at: now,
    updated_at: now,
    repository_fingerprint: fields.repository_fingerprint,
    repository_root_identity: fields.repository_root_identity,
    git_common_dir_identity: fields.git_common_dir_identity,
    expected_head: fields.expected_head,
    expected_ref: fields.expected_ref,
    origin_url: fields.origin_url || fields.repository_fingerprint?.origin_url || "",
    origin_master: fields.origin_master || fields.repository_fingerprint?.origin_master || "",
    expected_worktree_state: fields.expected_worktree_state,
    execution_affinity: fields.execution_affinity || "SAME_WORKTREE_REQUIRED",
    current_owner_actor: fields.current_owner_actor || null,
    lease_identity: fields.lease_identity || null,
    last_completed_transition: null,
    next_transition_candidate: {
      value: "READ_ONLY_DISCOVERY",
      advisory_only: true,
      not_authorization: true,
    },
    input_manifest: fields.input_manifest || {},
    checkpoint_integrity: {
      algorithm: "sha256",
      digest_basis: "external_current_file",
    },
    dirty_state_policy: "clean_only_slice1_not_content_affinity",
  };
}

export function validateSnapshotStructure(snapshot) {
  const required = [
    "format_version", "checkpoint_id", "revision", "execution_id", "chain_id",
    "phase", "stage", "state", "c2d_control_state", "created_at", "updated_at",
    "repository_fingerprint", "repository_root_identity", "git_common_dir_identity",
    "expected_head", "expected_ref", "expected_worktree_state", "execution_affinity",
    "last_completed_transition", "next_transition_candidate", "input_manifest",
    "checkpoint_integrity",
  ];
  for (const k of required) {
    if (!(k in snapshot)) {
      throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, `missing field ${k}`);
    }
  }
  const major = parseInt(String(snapshot.format_version).split(".")[0], 10);
  if (major !== SUPPORTED_FORMAT_MAJOR) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, `unsupported format_version ${snapshot.format_version}`);
  }
  if (!KNOWN_CONTROL_STATES.has(snapshot.c2d_control_state)) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, `unknown c2d_control_state ${snapshot.c2d_control_state}`);
  }
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, `unsafe revision ${snapshot.revision}`);
  }
  try {
    validateExecutionId(snapshot.execution_id);
  } catch {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "invalid execution_id in snapshot");
  }
  if (typeof snapshot.checkpoint_id !== "string" || !snapshot.checkpoint_id) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "invalid checkpoint_id");
  }
  if (typeof snapshot.chain_id !== "string" || !snapshot.chain_id) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "invalid chain_id");
  }
  if (snapshot.next_transition_candidate?.not_authorization !== true) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "next_transition_candidate must be not_authorization");
  }
  if (snapshot.checkpoint_integrity?.digest_basis !== "external_current_file") {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "checkpoint_integrity must use external_current_file");
  }
  return true;
}
