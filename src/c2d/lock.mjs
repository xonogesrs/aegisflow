// Structured exclusive locks with forensic orphan reclaim.
//
// Safety model:
//   - Fresh acquire is a single atomic exclusive-create. It never sees an absent
//     lock path during a reclaim, so it can never win a linearization gap; on
//     conflict it must itself go through reclaim (which is guard-serialized).
//   - Orphan reclaim replaces the old lock with the replacement via an atomic
//     renameSync. There is no unlink-then-create window, so no third party can
//     seize the path mid-reclaim.
//   - The reclaim guard is a structured, recoverable record: a crashed reclaimer
//     that leaves its guard behind is classified (host + dead PID + age + digest
//     + affinity) and safely reclaimed, so an orphaned guard cannot deadlock.
//   - The tombstone names the actual replacement owner before install and is only
//     marked committed after the replacement is published, so a completed tombstone
//     always matches the final owner.
//   - Directory-fsync degradation is aggregated and surfaced on the handle, never
//     silently swallowed.

import {
  existsSync, readFileSync, openSync, closeSync, fsyncSync, unlinkSync, renameSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import {
  C2dHoldError, HOLD, ensureDir0700, assertPathComponentsNotSymlink,
  assertNotSymlink, writeExclusiveCreate, sha256Hex, fireHook,
} from "./fs-atomic.mjs";

const MIN_CRASH_AGE_MS = 50;
const GUARD_STEAL_ATTEMPTS = 3;

function hostId() {
  return hostname() || "unknown-host";
}

function nowIso() {
  return new Date().toISOString();
}

function fsyncDirectory(dir) {
  try {
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
    return { durability_capability: "full" };
  } catch (e) {
    return { durability_capability: "degraded", reason: e?.message || "dir fsync failed" };
  }
}

/** Mutable accumulator so every durability-affecting step can be aggregated. */
function newDurability() {
  return { durability_capability: "full", durability_reasons: [] };
}

function aggregateDurability(acc, result) {
  if (!result) return acc;
  if (result.durability_capability === "degraded") {
    acc.durability_capability = "degraded";
    if (result.reason) acc.durability_reasons.push(result.reason);
  }
  return acc;
}

function processAlive(pid, lockHost) {
  if (lockHost !== hostId()) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === "ESRCH") return false;
    return null;
  }
}

function readLockFile(lockPath) {
  if (!existsSync(lockPath)) return null;
  assertNotSymlink(lockPath);
  let bytes;
  try {
    bytes = readFileSync(lockPath);
  } catch {
    throw new C2dHoldError(HOLD.LOCK_RECORD_CORRUPT, `lock unreadable: ${lockPath}`);
  }
  let rec;
  try {
    rec = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new C2dHoldError(HOLD.LOCK_RECORD_CORRUPT, `lock JSON corrupt: ${lockPath}`);
  }
  validateLockRecord(rec);
  return { bytes, rec, digest: sha256Hex(bytes) };
}

function validateLockRecord(rec) {
  const required = [
    "format_version", "lock_id", "lock_kind", "execution_id", "checkpoint_id",
    "chain_id", "lease_id", "lease_revision", "actor_id", "session_id",
    "process_id", "host_identity", "repository_identity", "worktree_identity",
    "expected_head", "acquired_at",
  ];
  for (const k of required) {
    if (rec[k] === undefined || rec[k] === null || rec[k] === "") {
      throw new C2dHoldError(HOLD.LOCK_RECORD_CORRUPT, `lock missing field ${k}`);
    }
  }
  if (!Number.isInteger(rec.process_id) || rec.process_id <= 0) {
    throw new C2dHoldError(HOLD.LOCK_RECORD_CORRUPT, "invalid process_id");
  }
  if (!Number.isInteger(rec.lease_revision)) {
    throw new C2dHoldError(HOLD.LOCK_RECORD_CORRUPT, "invalid lease_revision");
  }
  if (rec.affinity_mode === "repository" && (!rec.repository_lock_key || !rec.git_common_dir_identity || !["candidate_materialization", "commit"].includes(rec.transition_kind))) {
    throw new C2dHoldError(HOLD.LOCK_RECORD_CORRUPT, "repository lock record invalid");
  }
}

function affinityMatch(rec, identity) {
  if (rec.affinity_mode === "repository" || identity.affinity_mode === "repository") {
    return rec.affinity_mode === "repository" && identity.affinity_mode === "repository" &&
      rec.repository_lock_key === identity.repository_lock_key && rec.git_common_dir_identity === identity.git_common_dir_identity;
  }
  for (const f of [
    "execution_id", "checkpoint_id", "chain_id",
    "repository_identity", "worktree_identity", "expected_head",
  ]) {
    if (identity[f] !== undefined && identity[f] !== rec[f]) return false;
  }
  return true;
}

function buildLockRecord(identity) {
  return {
    format_version: "1.0.0",
    lock_id: `lock_${randomBytes(8).toString("hex")}`,
    lock_kind: identity.lock_kind || "generic",
    execution_id: identity.execution_id,
    checkpoint_id: identity.checkpoint_id,
    chain_id: identity.chain_id,
    lease_id: identity.lease_id,
    lease_revision: identity.lease_revision,
    actor_id: identity.actor_id,
    session_id: identity.session_id,
    process_id: process.pid,
    host_identity: hostId(),
    repository_identity: identity.repository_identity,
    worktree_identity: identity.worktree_identity,
    expected_head: identity.expected_head,
    acquired_at: nowIso(),
    ...(identity.affinity_mode === "repository" ? { affinity_mode: "repository", repository_lock_key: identity.repository_lock_key, git_common_dir_identity: identity.git_common_dir_identity, candidate_id: identity.candidate_id, transition_kind: identity.transition_kind } : {}),
  };
}

function makeHandle(lockPath, record, durability) {
  return {
    path: lockPath,
    record,
    reclaimed: false,
    durability_capability: durability.durability_capability,
    durability_reasons: durability.durability_reasons,
    release() {
      return releaseStructuredLock(lockPath, record);
    },
  };
}

/**
 * Read the current durable lock record, or null when the lock path is absent.
 * Throws C2dHoldError(LOCK_RECORD_CORRUPT) when a record exists but is
 * unreadable / structurally invalid. Used by protected mutation/commit entry
 * gates to re-prove that a live capability still owns the on-disk lock record;
 * process-local capability membership is never treated as proof that disk
 * ownership still exists.
 */
export function readCurrentLockRecord(lockPath) {
  const cur = readLockFile(lockPath);
  return cur ? cur.rec : null;
}

export function releaseStructuredLock(lockPath, expectedRecord) {
  const dur = newDurability();
  if (!existsSync(lockPath)) return dur;
  const cur = readLockFile(lockPath);
  if (!cur) return dur;
  if (cur.rec.lock_id !== expectedRecord.lock_id ||
      cur.rec.process_id !== expectedRecord.process_id ||
      cur.rec.host_identity !== expectedRecord.host_identity) {
    throw new C2dHoldError(HOLD.LOCK_RECLAIM_NOT_PROVEN_SAFE, "cannot release foreign lock");
  }
  fireHook("before_lock_release");
  unlinkSync(lockPath);
  aggregateDurability(dur, fsyncDirectory(dirname(lockPath)));
  fireHook("after_lock_release");
  return dur;
}

/**
 * Acquire structured exclusive lock. On conflict, attempt forensic orphan reclaim.
 */
export function acquireStructuredLock(lockPath, identity) {
  assertPathComponentsNotSymlink(dirname(lockPath));
  ensureDir0700(dirname(lockPath));
  const record = buildLockRecord(identity);
  const dur = newDurability();
  fireHook("before_lock_create");
  try {
    aggregateDurability(dur, writeExclusiveCreate(lockPath, JSON.stringify(record, null, 2) + "\n"));
  } catch (e) {
    if (e instanceof C2dHoldError && e.code === HOLD.JOURNAL_OUT_OF_ORDER) {
      return reclaimOrConflict(lockPath, identity);
    }
    throw e;
  }
  fireHook("after_lock_create");
  return makeHandle(lockPath, record, dur);
}

function reclaimOrConflict(lockPath, identity) {
  let existing;
  try {
    existing = readLockFile(lockPath);
  } catch (e) {
    if (e instanceof C2dHoldError) throw e;
    throw new C2dHoldError(HOLD.LOCK_RECORD_CORRUPT, e.message);
  }
  if (!existing) {
    // Path became free between the failed create and the read. Retry once.
    const record = buildLockRecord(identity);
    const dur = newDurability();
    try {
      aggregateDurability(dur, writeExclusiveCreate(lockPath, JSON.stringify(record, null, 2) + "\n"));
      return makeHandle(lockPath, record, dur);
    } catch {
      throw new C2dHoldError(HOLD.LOCK_ACTIVE, "lock race after disappearance");
    }
  }

  if (!affinityMatch(existing.rec, identity)) {
    throw new C2dHoldError(HOLD.LOCK_AFFINITY_MISMATCH, "lock affinity mismatch", {
      lock_id: existing.rec.lock_id,
    });
  }

  const alive = processAlive(existing.rec.process_id, existing.rec.host_identity);
  if (alive === true) {
    throw new C2dHoldError(HOLD.LOCK_ACTIVE, "lock held by live process", {
      lock_id: existing.rec.lock_id,
      process_id: existing.rec.process_id,
    });
  }
  if (alive === null) {
    throw new C2dHoldError(HOLD.LOCK_RECLAIM_NOT_PROVEN_SAFE, "process liveness unproven", {
      lock_id: existing.rec.lock_id,
      host_identity: existing.rec.host_identity,
    });
  }

  const age = Date.now() - Date.parse(existing.rec.acquired_at);
  if (!Number.isFinite(age) || age < MIN_CRASH_AGE_MS) {
    throw new C2dHoldError(HOLD.LOCK_RECLAIM_NOT_PROVEN_SAFE, "lock too young for orphan classification");
  }

  return forensicReclaim(lockPath, existing, identity);
}

// ---------------------------------------------------------------------------
// Reclaim guard: structured, recoverable record. Not a bare exclusive file.
// ---------------------------------------------------------------------------

function guardPathFor(lockPath) {
  return `${lockPath}.reclaim-guard`;
}

function buildGuardRecord(identity, target) {
  return {
    format_version: "1.0.0",
    guard_id: `rg_${randomBytes(8).toString("hex")}`,
    target_lock_id: target.rec.lock_id,
    target_lock_digest: target.digest,
    execution_id: identity.execution_id,
    checkpoint_id: identity.checkpoint_id,
    chain_id: identity.chain_id,
    actor_id: identity.actor_id,
    session_id: identity.session_id,
    process_id: process.pid,
    host_identity: hostId(),
    repository_identity: identity.repository_identity,
    worktree_identity: identity.worktree_identity,
    expected_head: identity.expected_head,
    acquired_at: nowIso(),
  };
}

function validateGuardRecord(rec) {
  const required = [
    "format_version", "guard_id", "target_lock_id", "target_lock_digest",
    "execution_id", "checkpoint_id", "chain_id", "actor_id", "session_id",
    "process_id", "host_identity", "repository_identity", "worktree_identity",
    "expected_head", "acquired_at",
  ];
  for (const k of required) {
    if (rec[k] === undefined || rec[k] === null || rec[k] === "") {
      throw new C2dHoldError(HOLD.RECLAIM_GUARD_RECORD_CORRUPT, `guard missing field ${k}`);
    }
  }
  if (!Number.isInteger(rec.process_id) || rec.process_id <= 0) {
    throw new C2dHoldError(HOLD.RECLAIM_GUARD_RECORD_CORRUPT, "invalid guard process_id");
  }
}

function readGuardFile(guardPath) {
  if (!existsSync(guardPath)) return null;
  assertNotSymlink(guardPath);
  let bytes;
  try {
    bytes = readFileSync(guardPath);
  } catch {
    throw new C2dHoldError(HOLD.RECLAIM_GUARD_RECORD_CORRUPT, `guard unreadable: ${guardPath}`);
  }
  let rec;
  try {
    rec = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new C2dHoldError(HOLD.RECLAIM_GUARD_RECORD_CORRUPT, `guard JSON corrupt: ${guardPath}`);
  }
  validateGuardRecord(rec);
  return { bytes, rec, digest: sha256Hex(bytes) };
}

/**
 * Acquire the reclaim guard. If an orphaned guard blocks us, classify it with the
 * same forensic rules as a lock and reclaim only when conclusively safe. Never
 * TTL-only, never PID-only across hosts. An orphaned guard is recoverable, so it
 * cannot become a permanent deadlock.
 */
function acquireReclaimGuard(guardPath, identity, target, dur) {
  for (let attempt = 0; attempt <= GUARD_STEAL_ATTEMPTS; attempt++) {
    const record = buildGuardRecord(identity, target);
    fireHook("before_guard_publish");
    try {
      aggregateDurability(dur, writeExclusiveCreate(guardPath, JSON.stringify(record, null, 2) + "\n"));
      fireHook("after_guard_publish");
      return record;
    } catch (e) {
      if (!(e instanceof C2dHoldError && e.code === HOLD.JOURNAL_OUT_OF_ORDER)) throw e;
    }
    // Guard busy: classify and, if provably orphaned, remove it and retry.
    recoverOrphanedGuardOrThrow(guardPath, identity, target, dur);
  }
  throw new C2dHoldError(HOLD.LOCK_RECLAIM_CONFLICT, "reclaim guard contended");
}

function recoverOrphanedGuardOrThrow(guardPath, identity, target, dur) {
  const existing = readGuardFile(guardPath);
  if (!existing) return; // vanished; caller retries create
  const alive = processAlive(existing.rec.process_id, existing.rec.host_identity);
  if (alive === true) {
    throw new C2dHoldError(HOLD.LOCK_RECLAIM_CONFLICT, "reclaim guard held by live reclaimer", {
      guard_id: existing.rec.guard_id,
      process_id: existing.rec.process_id,
    });
  }
  if (alive === null) {
    throw new C2dHoldError(HOLD.RECLAIM_GUARD_RECOVERY_NOT_PROVEN_SAFE, "guard reclaimer liveness unproven", {
      guard_id: existing.rec.guard_id,
      host_identity: existing.rec.host_identity,
    });
  }
  const age = Date.now() - Date.parse(existing.rec.acquired_at);
  if (!Number.isFinite(age) || age < MIN_CRASH_AGE_MS) {
    throw new C2dHoldError(HOLD.RECLAIM_GUARD_RECOVERY_NOT_PROVEN_SAFE, "guard too young for orphan classification");
  }
  if (!affinityMatch(existing.rec, identity)) {
    throw new C2dHoldError(HOLD.RECLAIM_GUARD_RECOVERY_NOT_PROVEN_SAFE, "guard affinity mismatch", {
      guard_id: existing.rec.guard_id,
    });
  }
  // Confirm the guard bytes did not change between classification and removal.
  const again = readGuardFile(guardPath);
  if (!again || again.digest !== existing.digest) {
    // Another racer already recovered or a new reclaimer published; retry loop.
    return;
  }
  fireHook("before_guard_recover");
  try { unlinkSync(guardPath); } catch { /* someone else won the removal */ }
  aggregateDurability(dur, fsyncDirectory(dirname(guardPath)));
  fireHook("after_guard_recover");
}

function releaseReclaimGuard(guardPath, guardRecord, dur) {
  const cur = existsSync(guardPath) ? readGuardFile(guardPath) : null;
  if (!cur) return;
  if (cur.rec.guard_id !== guardRecord.guard_id ||
      cur.rec.process_id !== guardRecord.process_id ||
      cur.rec.host_identity !== guardRecord.host_identity) {
    // Not ours (already recovered by someone else). Do not remove.
    return;
  }
  fireHook("before_guard_release");
  try { unlinkSync(guardPath); } catch { /* */ }
  aggregateDurability(dur, fsyncDirectory(dirname(guardPath)));
  fireHook("after_guard_release");
}

// ---------------------------------------------------------------------------
// Forensic reclaim: guard-serialized, gapless atomic replacement.
// ---------------------------------------------------------------------------

function forensicReclaim(lockPath, existing, identity) {
  const dir = dirname(lockPath);
  const guardPath = guardPathFor(lockPath);
  const dur = newDurability();
  const reclaimGen = randomBytes(8).toString("hex");

  const guardRecord = acquireReclaimGuard(guardPath, identity, existing, dur);
  let released = false;
  try {
    // Re-validate the orphan under the guard.
    fireHook("before_old_lock_validation");
    const again = readLockFile(lockPath);
    if (!again || again.digest !== existing.digest) {
      throw new C2dHoldError(HOLD.LOCK_RECLAIM_NOT_PROVEN_SAFE, "lock changed during reclaim");
    }
    if (processAlive(again.rec.process_id, again.rec.host_identity) !== false) {
      throw new C2dHoldError(HOLD.LOCK_RECLAIM_NOT_PROVEN_SAFE, "process liveness recheck failed");
    }
    if (!affinityMatch(again.rec, identity)) {
      throw new C2dHoldError(HOLD.LOCK_AFFINITY_MISMATCH, "affinity changed during reclaim");
    }
    fireHook("after_old_lock_validation");

    // Replacement identity is fixed now, so the tombstone can name the real owner.
    const newRec = buildLockRecord(identity);
    const tombPath = join(dir, `${basename(lockPath)}.tombstone.${again.rec.lock_id}.${reclaimGen}`);
    const committedPath = `${tombPath}.committed`;

    // Reserve the replacement in a private temp path (never the live lock path).
    fireHook("before_replacement_reservation");
    const replTmp = `${lockPath}.replacement.${reclaimGen}`;
    aggregateDurability(dur, writeExclusiveCreate(replTmp, JSON.stringify(newRec, null, 2) + "\n"));
    fireHook("after_replacement_reservation");

    // Prepare the tombstone (immutable) naming the replacement owner.
    const tomb = {
      format_version: "1.0.0",
      status: "reclaiming",
      original_lock: again.rec,
      original_lock_digest: again.digest,
      replacement_lock_id: newRec.lock_id,
      replacement_actor_id: newRec.actor_id,
      replacement_session_id: newRec.session_id,
      replacement_process_id: newRec.process_id,
      replacement_host_identity: newRec.host_identity,
      reclaim_generation: reclaimGen,
      reclaimer_actor: identity.actor_id,
      reclaimer_session: identity.session_id,
      prepared_at: nowIso(),
      liveness_evidence: {
        process_id: again.rec.process_id,
        alive: false,
        host: again.rec.host_identity,
      },
      affinity_evidence: {
        execution_id: identity.execution_id,
        checkpoint_id: identity.checkpoint_id,
        chain_id: identity.chain_id,
        repository_identity: identity.repository_identity,
        worktree_identity: identity.worktree_identity,
        expected_head: identity.expected_head,
      },
    };
    fireHook("before_tombstone_prepare");
    aggregateDurability(dur, writeExclusiveCreate(tombPath, JSON.stringify(tomb, null, 2) + "\n"));
    fireHook("after_tombstone_prepare");

    // Atomic install: rename replacement over the old orphan. No path-absence
    // window, so no fresh acquirer or second reclaimer can seize the gap.
    fireHook("before_replacement_publish");
    const preInstall = readLockFile(lockPath);
    if (!preInstall || preInstall.digest !== existing.digest) {
      throw new C2dHoldError(HOLD.LOCK_RECLAIM_NOT_PROVEN_SAFE, "lock changed before install");
    }
    renameSync(replTmp, lockPath);
    aggregateDurability(dur, fsyncDirectory(dir));
    fireHook("after_replacement_publish");

    // Finalize: mark the tombstone committed only after the replacement is live.
    fireHook("before_tombstone_finalize");
    aggregateDurability(dur, writeExclusiveCreate(committedPath, JSON.stringify({
      committed_at: nowIso(),
      replacement_lock_id: newRec.lock_id,
      reclaim_generation: reclaimGen,
    }, null, 2) + "\n"));
    fireHook("after_tombstone_finalize");

    releaseReclaimGuard(guardPath, guardRecord, dur);
    released = true;

    if (dur.durability_capability === "degraded") {
      throw new C2dHoldError(HOLD.LOCK_RECOVERY_DURABILITY_HIDDEN, "reclaim durability degraded", {
        reasons: dur.durability_reasons,
        tombstone: tombPath,
      });
    }

    return {
      path: lockPath,
      record: newRec,
      reclaimed: true,
      tombstone: tombPath,
      tombstone_committed: committedPath,
      reclaim_generation: reclaimGen,
      durability_capability: dur.durability_capability,
      durability_reasons: dur.durability_reasons,
      release() {
        return releaseStructuredLock(lockPath, newRec);
      },
    };
  } finally {
    if (!released) {
      // Error path: release our own guard so we never self-deadlock.
      releaseReclaimGuard(guardPath, guardRecord, dur);
    }
  }
}

export { hostId };
