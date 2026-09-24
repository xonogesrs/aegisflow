// src/runtime/colima-profile-lock.mjs
//
// AUTOLOOP_BACKGROUND_WAITER_COALESCING_AND_PROFILE_SINGLEFLIGHT_1 — F/G.
//
// Single-flight serialization for AutoLoop-owned Colima profiles.
//
// Root cause this guards (AUTOLOOP_BACKGROUND_DEDUP_AUDIT_1, 2026-09-23):
// two DIFFERENT logical work items (test:colima-all × test:writeback; a
// WP1-F E2E probe) overlapped on the shared `autoloop-graph` profile. The
// concurrent runs interleave stop/start and reconcile mount generations
// underneath each other, failing closed with
// COLIMA_RUNTIME_MOUNT_RECONCILE_INCOMPLETE / mount-fingerprint mismatch.
// The documented discipline ("Colima suites run SERIAL") was advisory only —
// nothing in the runtime enforced it, and a foreground call auto-backgrounded
// by the harness silently joined the contending set.
//
// Contract:
//   - ONE mutating/reconciling operation per profile at a time. The lock is
//     held from BEFORE ensureInstance (any colima start/stop/reconcile or
//     container creation) until the operation's terminal cleanup completes.
//   - Identity is the PROFILE (machine-level shared state), never the
//     execution/worktree — the same affinity discipline as
//     repository-mutation-lock.mjs (Git common-dir identity).
//   - Fail-closed: a second acquirer receives a structured HOLD
//     (COLIMA_PROFILE_BUSY) naming the current owner; it never waits
//     silently, never steals, never falls back to unlocked execution.
//   - Crash/recovery: the lock record carries process identity; an orphaned
//     lock from a dead process on the same host is reclaimed through the
//     forensic path of c2d/lock.mjs (MIN_CRASH_AGE_MS guard applies). A
//     lock from a different host is never reclaimed (NOT_PROVEN_SAFE) —
//     cross-machine contention must be resolved by an operator, not guessed.
//   - Non-goal (card NON-GOAL): independent work that does not share the
//     mutable runtime state is NOT serialized. Locks are per-profile; w1/w2
//     style distinct profiles never contend.
//
// Authority-free: this module only serializes; judgment (retry policy,
// queueing, user-visible messaging) belongs to the caller.
//
// STANDALONE by construction: this module imports NOTHING from
// colima-runtime.mjs. The E1/E2 fixture isolation shims redirect the
// colima-runtime.mjs specifier to inert stand-ins; a static import here
// would break their import surface at link time (missing-export SyntaxError)
// the moment the real colima-graph-runner loads under isolation. The lock is
// metadata serialization, not a machine action: the NVM2T fail-closed storage
// gate still guards the ACTUAL mutation seam (ensureInstance). The lock root
// follows the CONFIGURED runtime home so lock records live on the same
// storage as the profiles they serialize.

import { isAbsolute, join, resolve } from "node:path";
import { autoloopHome, configuredColimaHome } from "../shared/autoloop-paths.mjs";
import {
  C2dHoldError,
  HOLD,
} from "../c2d/fs-atomic.mjs";
import { acquireStructuredLock } from "../c2d/lock.mjs";

export const COLIMA_PROFILE_LOCK_HOLD = Object.freeze({
  BUSY: "HOLD / COLIMA_PROFILE_BUSY",
  NOT_TEST_OWNED: "HOLD / COLIMA_PROFILE_LOCK_NOT_TEST_OWNED",
  RECLAIM_UNPROVEN: "HOLD / COLIMA_PROFILE_LOCK_RECLAIM_UNPROVEN",
  RELEASE_OWNER_MISMATCH: "HOLD / COLIMA_PROFILE_LOCK_RELEASE_OWNER_MISMATCH",
});

// Mirror of colima-runtime.mjs AUTOLOOP_TEST_PROFILES (kept literal here to
// preserve the standalone contract above; test/v2 helpers assert parity).
export const COLIMA_PROFILE_LOCK_ALLOWED = Object.freeze([
  "autoloop-graph",
  "autoloop-c3",
  "autoloop-w1",
  "autoloop-w2",
]);

// Lock root: a sibling of the Colima profile directories under the configured
// runtime home (so lock records live on the same storage as the profiles they
// serialize). Resolution order, mirroring AUTOLOOP_TELEMETRY_STATE_ROOT /
// AUTOLOOP_MEMORY_STATE_ROOT:
//   AUTOLOOP_COLIMA_PROFILE_LOCK_ROOT → <COLIMA_HOME>/autoloop-locks → <AUTOLOOP_HOME>/colima-locks
export const COLIMA_PROFILE_LOCK_ROOT_ENV = "AUTOLOOP_COLIMA_PROFILE_LOCK_ROOT";

export function colimaProfileLockDefaultRoot({ env = process.env } = {}) {
  const configured = env?.[COLIMA_PROFILE_LOCK_ROOT_ENV];
  if (typeof configured === "string" && configured.trim().length > 0) {
    if (!isAbsolute(configured.trim())) {
      throw new Error(`${COLIMA_PROFILE_LOCK_ROOT_ENV} must be an absolute path: ${configured}`);
    }
    return resolve(configured.trim());
  }
  const colimaHome = configuredColimaHome({ env });
  return colimaHome === null
    ? join(autoloopHome({ env }), "colima-locks")
    : join(colimaHome, "autoloop-locks");
}

/** Canonical lock path for one profile. */
export function colimaProfileLockPath(profile, root = null) {
  const base = root ?? colimaProfileLockDefaultRoot();
  return join(base, `colima-profile-${profile}.lock`);
}

// Fixed affinity fields: EVERY acquirer of the same profile passes the same
// values, so contention between any two callers resolves to LOCK_ACTIVE
// (busy) — never an affinity mismatch masquerading as a different problem.
// The acquirer's own identity (who holds it now) travels in actor/session.
function fixedIdentityFields(profile) {
  return {
    lock_kind: "colima_profile",
    execution_id: "colima-profile-lock",
    checkpoint_id: "profile",
    chain_id: "profile",
    lease_id: "none",
    lease_revision: 0,
    repository_identity: `colima-profile:${profile}`,
    worktree_identity: `colima-profile:${profile}`,
    expected_head: "none",
  };
}

/** Module-private capability registry — the same unforgeable-handle
 *  discipline as repository-mutation-lock.mjs: only the exact object issued
 *  by acquireColimaProfileLock can release, and only while still held. */
const CAPABILITY = new WeakMap();

/**
 * Acquire the single-flight lock for one AutoLoop-owned Colima profile.
 * Non-blocking: contention is a structured HOLD, never a wait.
 *
 * @param {object} opts
 * @param {string} opts.profile — AutoLoop test-owned profile name
 *   (COLIMA_PROFILE_LOCK_ALLOWED member; mirrors the AUTOLOOP_TEST_PROFILES
 *   fence that gates every ensureInstance mutation).
 * @param {string} [opts.actorId] — who is acquiring (graph/execution id,
 *   suite name). Recorded in the durable lock record for forensics.
 * @param {string} [opts.sessionId] — session/process context label.
 * @param {string} [opts.root] — explicit lock directory override (tests).
 * @returns {{ profile: string, path: string, record: object, release(): object }}
 *   release() is idempotent-safe at the durable layer but refuses a foreign
 *   or already-released handle (capability check below).
 */
export function acquireColimaProfileLock({ profile, actorId = "unknown", sessionId = "unknown", root = null } = {}) {
  if (typeof profile !== "string" || profile.trim().length === 0) {
    throw new C2dHoldError(COLIMA_PROFILE_LOCK_HOLD.NOT_TEST_OWNED, "profile required");
  }
  // Mirror the AUTOLOOP_TEST_PROFILES fence: only AutoLoop-owned profiles are
  // ever locked/mutated by this runtime. Locking an unowned profile would
  // imply a mutation path that does not (and must not) exist.
  if (!COLIMA_PROFILE_LOCK_ALLOWED.includes(profile)) {
    throw new C2dHoldError(
      COLIMA_PROFILE_LOCK_HOLD.NOT_TEST_OWNED,
      `profile ${profile} is not an AutoLoop-owned ephemeral test profile; refusing to lock`,
      { profile },
    );
  }
  const lockPath = colimaProfileLockPath(profile, root);
  let raw;
  try {
    raw = acquireStructuredLock(lockPath, {
      ...fixedIdentityFields(profile),
      actor_id: actorId,
      session_id: sessionId,
    });
  } catch (e) {
    if (e instanceof C2dHoldError) {
      if (e.code === HOLD.LOCK_ACTIVE) {
        throw new C2dHoldError(
          COLIMA_PROFILE_LOCK_HOLD.BUSY,
          `profile ${profile} is held by another operation: ${e.message}`,
          { profile, lockPath, holder: e.details ?? null },
        );
      }
      if (e.code === HOLD.LOCK_AFFINITY_MISMATCH || e.code === HOLD.LOCK_RECORD_CORRUPT) {
        throw new C2dHoldError(
          COLIMA_PROFILE_LOCK_HOLD.RECLAIM_UNPROVEN,
          `profile ${profile} lock record is foreign or corrupt: ${e.message}`,
          { profile, lockPath, cause: e.code },
        );
      }
      // LOCK_RECLAIM_NOT_PROVEN_SAFE / LOCK_RECLAIM_CONFLICT / guard errors:
      // surfaced as-is under the profile-lock reclaim-unproven code.
      throw new C2dHoldError(
        COLIMA_PROFILE_LOCK_HOLD.RECLAIM_UNPROVEN,
        `profile ${profile} lock could not be safely (re)acquired: ${e.message}`,
        { profile, lockPath, cause: e.code },
      );
    }
    throw e;
  }
  const state = { lockPath, record: raw.record, profile, held: true };
  const handle = Object.freeze({
    profile,
    path: lockPath,
    record: raw.record,
    reclaimed: raw.reclaimed === true,
    durability_capability: raw.durability_capability,
    durability_reasons: raw.durability_reasons,
    release() {
      const st = CAPABILITY.get(this);
      if (!st) throw new C2dHoldError(COLIMA_PROFILE_LOCK_HOLD.RELEASE_OWNER_MISMATCH, "forged or copied profile lock handle cannot release");
      if (st.held !== true) throw new C2dHoldError(COLIMA_PROFILE_LOCK_HOLD.RELEASE_OWNER_MISMATCH, "profile lock already released");
      const dur = raw.release();
      st.held = false;
      return dur;
    },
  });
  CAPABILITY.set(handle, state);
  return handle;
}
