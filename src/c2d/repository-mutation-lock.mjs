// Repository-wide lock. Identity is Git common-dir, never execution/worktree.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { C2dHoldError } from "./fs-atomic.mjs";
import { acquireStructuredLock, readCurrentLockRecord } from "./lock.mjs";

export const REPOSITORY_LOCK_HOLD = Object.freeze({
  ACTIVE: "HOLD / REPOSITORY_MUTATION_LOCK_ACTIVE",
  RECLAIM_UNPROVEN: "HOLD / REPOSITORY_MUTATION_LOCK_RECLAIM_UNPROVEN",
  RELEASE_OWNER_MISMATCH: "HOLD / REPOSITORY_MUTATION_LOCK_RELEASE_OWNER_MISMATCH",
});

// Module-private capability registry. Authority to pass a protected mutation /
// materialization / commit entry gate is *membership in this WeakMap keyed by the
// exact handle object returned from acquireRepositoryMutationLock* — never a
// boolean `held` flag, a caller-visible record field, a class name, an
// instanceof relation, an exported symbol, an object shape, or frozen status.
// There is no exported minting function, so a plain object, spread/clone,
// JSON round-trip, prototype copy, or reconstructed record can never appear as a
// key here, and therefore can never satisfy a gate. The private state also
// carries the issued durable record identity and canonical bindings so every
// gate can re-prove live on-disk ownership.
const CAPABILITY = new WeakMap();

export function repositoryLockKey(gitCommonDir) {
  return createHash("sha256").update(`autoloop.repository-mutation-lock/v1\0${gitCommonDir}`).digest("hex");
}
export function repositoryLockPath(gitCommonDir) {
  return join(gitCommonDir, "autoloop-locks", "repository-mutation-v1.lock");
}
export function acquireRepositoryMutationLock({ gitCommonDir, executionId, candidateId = "none", transitionKind, repositoryIdentity, targetWorktreeIdentity, expectedHead, lease, actorId, sessionId }) {
  if (!gitCommonDir || !["candidate_materialization", "commit"].includes(transitionKind)) throw new C2dHoldError(REPOSITORY_LOCK_HOLD.RECLAIM_UNPROVEN, "repository lock binding invalid");
  try {
    const lockPath = repositoryLockPath(gitCommonDir);
    const lockKey = repositoryLockKey(gitCommonDir);
    const raw = acquireStructuredLock(lockPath, {
      lock_kind: "repository_mutation", affinity_mode: "repository", repository_lock_key: lockKey, git_common_dir_identity: gitCommonDir,
      execution_id: executionId, checkpoint_id: "repository", chain_id: "repository", lease_id: lease?.lease_id || "none", lease_revision: lease?.lease_revision || 0,
      actor_id: actorId || "unknown", session_id: sessionId || "unknown", repository_identity: repositoryIdentity, worktree_identity: targetWorktreeIdentity, expected_head: expectedHead,
      candidate_id: candidateId, transition_kind: transitionKind,
    });
    // Private capability state: the durable record identity we issued, the exact
    // canonical lock path, canonical repository / lock-key / transition binding,
    // and held/released state. Never exported; only reachable via the WeakMap.
    const state = {
      lockPath,
      record: raw.record,
      gitCommonDir,
      repositoryLockKey: lockKey,
      transitionKind,
      held: true,
    };
    const handle = Object.freeze({
      path: raw.path,
      record: raw.record,
      reclaimed: raw.reclaimed === true,
      tombstone: raw.tombstone,
      tombstone_committed: raw.tombstone_committed,
      reclaim_generation: raw.reclaim_generation,
      durability_capability: raw.durability_capability,
      durability_reasons: raw.durability_reasons,
      repository_lock_key: lockKey,
      git_common_dir_identity: gitCommonDir,
      transition_kind: transitionKind,
      held: true,
      release() {
        // Only the genuine issued capability object may release. A spread/clone
        // shares lock_id/process_id/host_identity and would otherwise satisfy the
        // guarded lock.mjs release; it is rejected here on object identity so a
        // copied handle can never release (or, via a stale copy, release a
        // replacement owner's lock).
        const st = CAPABILITY.get(this);
        if (!st) throw new C2dHoldError(REPOSITORY_LOCK_HOLD.RELEASE_OWNER_MISMATCH, "forged or copied repository lock handle cannot release");
        const dur = raw.release();
        // Permanently mark the issued capability unusable. A repeated release is a
        // no-op at the durable layer and can never recreate authority.
        st.held = false;
        return dur;
      },
    });
    CAPABILITY.set(handle, state);
    return handle;
  } catch (e) {
    if (e?.code?.includes("LOCK_ACTIVE")) throw new C2dHoldError(REPOSITORY_LOCK_HOLD.ACTIVE, e.message, e.details);
    if (e?.code?.includes("LOCK_RECLAIM") || e?.code?.includes("AFFINITY")) throw new C2dHoldError(REPOSITORY_LOCK_HOLD.RECLAIM_UNPROVEN, e.message, e.details);
    throw e;
  }
}
export function assertRepositoryMutationLock(handle, fp, transitionKind) {
  // 1. Unforgeable capability: the supplied object must be the exact handle we
  //    issued. Plain objects, spreads/clones, JSON round-trips, prototype copies,
  //    reconstructed records, and handles from unrelated acquisitions all fail
  //    here because they are not registered in the private WeakMap.
  const state = CAPABILITY.get(handle);
  if (!state) throw new C2dHoldError(REPOSITORY_LOCK_HOLD.ACTIVE, "unforgeable held repository mutation lock capability required");
  // 2. Still held (not released) and bound to this exact transition + canonical repository.
  if (state.held !== true) throw new C2dHoldError(REPOSITORY_LOCK_HOLD.ACTIVE, "repository mutation lock already released");
  if (state.transitionKind !== transitionKind) throw new C2dHoldError(REPOSITORY_LOCK_HOLD.ACTIVE, "repository mutation lock transition-kind mismatch");
  if (!fp || state.gitCommonDir !== fp.git_common_dir_identity) throw new C2dHoldError(REPOSITORY_LOCK_HOLD.ACTIVE, "repository mutation lock canonical-repository mismatch");
  // 3. Live durable ownership: the capability must still correspond exactly to the
  //    current on-disk lock record. Process-local membership is never treated as
  //    proof that disk ownership still exists. Fail closed on absence, corruption,
  //    replacement by another owner, or any field mismatch. Never reacquire.
  let rec;
  try { rec = readCurrentLockRecord(state.lockPath); }
  catch { throw new C2dHoldError(REPOSITORY_LOCK_HOLD.ACTIVE, "repository mutation lock durable record unverifiable"); }
  if (!rec) throw new C2dHoldError(REPOSITORY_LOCK_HOLD.ACTIVE, "repository mutation lock durable record absent");
  const r = state.record;
  if (rec.lock_id !== r.lock_id || rec.process_id !== r.process_id || rec.host_identity !== r.host_identity ||
      rec.git_common_dir_identity !== state.gitCommonDir || rec.repository_lock_key !== state.repositoryLockKey ||
      rec.transition_kind !== state.transitionKind) {
    throw new C2dHoldError(REPOSITORY_LOCK_HOLD.ACTIVE, "repository mutation lock durable ownership no longer matches capability");
  }
  return true;
}
