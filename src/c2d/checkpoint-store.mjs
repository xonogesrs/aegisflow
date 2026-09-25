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
import { acquireStructuredLock, readCurrentLockRecord } from "./lock.mjs";

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
  // C3 AegisFlow additive states（checkpoint-bridge 使用；不影響既有 callers）
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
  // C3 derived-artifact owner (ADMISSION ARTIFACT 1 §2/D1): a caller that
  // already holds the structured CURRENT.json.lock capability (same process,
  // same lock path, live durable record still owned) MAY pass that handle as
  // `heldLock`. The continuous-hold discipline requires ONE lock hold across
  // Phase 1-3; publishCurrent then reuses the held capability instead of
  // re-acquiring (never a second concurrent acquisition, never an unlock
  // window). Ownership is re-proven from the durable lock record on every
  // reuse (repository-mutation-lock assertHeld discipline).
  const lockIdentity = {
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
  };
  let lock;
  if (permit._heldLock != null) {
    const held = permit._heldLock;
    if (held.path !== currentLockPath(execDir) || held.record == null) {
      throw new C2dHoldError(HOLD.WRITE_PERMIT_REQUIRED, "held lock capability not bound to CURRENT.json.lock");
    }
    const rec = readCurrentLockRecord(held.path);
    if (!rec || rec.lock_id !== held.record.lock_id || rec.process_id !== held.record.process_id
      || rec.host_identity !== held.record.host_identity) {
      throw new C2dHoldError(HOLD.LOCK_RECLAIM_NOT_PROVEN_SAFE, "held lock capability no longer owns the durable record");
    }
    lock = { release() { /* ownership retained by the outer D1 hold */ } };
  } else {
    try {
      lock = acquireStructuredLock(currentLockPath(execDir), lockIdentity);
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

// ---------------------------------------------------------------------------
// D3 — extension-head anchor block validation (AUTOLOOP-V1-STAGE-E-C3
// POST-FINALIZATION DERIVED ARTIFACT OWNER; ADMISSION ARTIFACT 1 §R5/D3).
//
// The anchor block rides the CURRENT.json snapshot body as an ADDITIVE field
// (`extension_head`). validateSnapshotStructure above tolerates additive
// fields; the anchor block gets its OWN strict closed-field policy, invoked
// AFTER validateSnapshotStructure passes. A snapshot whose anchor block
// passes the snapshot validator but fails this validator FAILS CLOSED —
// no partial adoption.
//
// Frozen anchor-block fields (§R5):
//   execution_id            — exec_<32hex>
//   phase_id                — non-empty bounded string
//   committed_generation    — safe integer >= 0
//   committed_link_digest   — 64-hex
//   revocation_generation   — safe integer >= 0
//   pending_mutation_id     — null | non-empty bounded string
//   pending_generation      — null | safe integer >= 1
//   pending_link_digest     — null | 64-hex
//   committed_at            — null | ISO-8601 UTC timestamp string
// Unknown/missing/unsafe fields => ANCHOR_SCHEMA_INVALID (fail-closed).
// ---------------------------------------------------------------------------

const ANCHOR_EXEC_RE = /^exec_[0-9a-f]{32}$/;
const ANCHOR_HEX64_RE = /^[0-9a-f]{64}$/;
const ANCHOR_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const ANCHOR_BLOCK_FIELD = "extension_head";

export const ANCHOR_BLOCK_FIELDS = Object.freeze([
  "execution_id",
  "phase_id",
  "committed_generation",
  "committed_link_digest",
  "revocation_generation",
  "pending_mutation_id",
  "pending_generation",
  "pending_link_digest",
  "committed_at",
]);

const ANCHOR_MAX_BOUNDED_STRING = 256;

function anchorStringOk(v) {
  return typeof v === "string" && v.length > 0 && v.length <= ANCHOR_MAX_BOUNDED_STRING;
}

function anchorSafeInt(v, min) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min;
}

function anchorPendingConsistent(a) {
  // The pending trio is either fully present or fully absent.
  const set = (a.pending_mutation_id !== null ? 1 : 0)
    + (a.pending_generation !== null ? 1 : 0)
    + (a.pending_link_digest !== null ? 1 : 0);
  return set === 0 || set === 3;
}

/**
 * D3 strict closed-field validation of the extension-head anchor block.
 * @returns {boolean} true when a well-formed anchor block is present.
 * @throws C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID) on any violation.
 */
export function validateAnchorBlock(snapshot) {
  if (snapshot[ANCHOR_BLOCK_FIELD] === undefined) return false;
  const a = snapshot[ANCHOR_BLOCK_FIELD];
  if (a === null || typeof a !== "object" || Array.isArray(a)) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor block must be an object");
  }
  for (const key of Object.keys(a)) {
    if (!ANCHOR_BLOCK_FIELDS.includes(key)) {
      throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, `anchor block unknown field: ${key}`);
    }
  }
  for (const key of ANCHOR_BLOCK_FIELDS) {
    if (!(key in a)) {
      throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, `anchor block missing field: ${key}`);
    }
  }
  if (typeof a.execution_id !== "string" || !ANCHOR_EXEC_RE.test(a.execution_id)) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor execution_id invalid");
  }
  if (!anchorStringOk(a.phase_id)) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor phase_id invalid");
  }
  if (!anchorSafeInt(a.committed_generation, 0)) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor committed_generation unsafe");
  }
  // A fresh execution that has never committed carries committed_generation
  // 0 with committed_link_digest null — the verified-empty anchor (§R5).
  // Any committed_generation >= 1 REQUIRES a 64-hex digest.
  if (a.committed_generation === 0) {
    if (a.committed_link_digest !== null) {
      throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor committed_link_digest must be null at generation 0");
    }
  } else if (typeof a.committed_link_digest !== "string" || !ANCHOR_HEX64_RE.test(a.committed_link_digest)) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor committed_link_digest invalid");
  }
  if (!anchorSafeInt(a.revocation_generation, 0)) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor revocation_generation unsafe");
  }
  if (a.pending_mutation_id !== null && !anchorStringOk(a.pending_mutation_id)) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor pending_mutation_id invalid");
  }
  if (a.pending_generation !== null && !anchorSafeInt(a.pending_generation, 1)) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor pending_generation unsafe");
  }
  if (a.pending_link_digest !== null && (typeof a.pending_link_digest !== "string" || !ANCHOR_HEX64_RE.test(a.pending_link_digest))) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor pending_link_digest invalid");
  }
  if (a.committed_at !== null && (typeof a.committed_at !== "string" || !ANCHOR_ISO_RE.test(a.committed_at))) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor committed_at invalid");
  }
  if (!anchorPendingConsistent(a)) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor pending trio not fully present/absent");
  }
  if (a.pending_generation !== null && a.pending_generation !== a.committed_generation + 1) {
    throw new C2dHoldError(HOLD.ANCHOR_SCHEMA_INVALID, "anchor pending_generation must equal committed_generation + 1");
  }
  return true;
}

export function getAnchorBlock(snapshot) {
  const present = validateAnchorBlock(snapshot);
  return present ? snapshot[ANCHOR_BLOCK_FIELD] : null;
}
