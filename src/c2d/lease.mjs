import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  C2dHoldError, HOLD, ensureDir0700, assertNotSymlink,
  writeJsonExclusiveCreate, writeJsonAtomicReplaceUnderLock,
} from "./fs-atomic.mjs";
import { mintLeaseId, mintSecret, secretDigest } from "./execution-id.mjs";
import { acquireStructuredLock } from "./lock.mjs";

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export function leasePath(execDir) {
  return join(execDir, "lease.json");
}

export function leaseLockPath(execDir) {
  return join(execDir, "lease.json.lock");
}

export function readLease(execDir) {
  const p = leasePath(execDir);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  return JSON.parse(readFileSync(p, "utf8"));
}

function lockIdentity(execDir, fields, lease) {
  return {
    lock_kind: "lease",
    execution_id: fields.execution_id || lease?.execution_id,
    checkpoint_id: fields.checkpoint_id || lease?.checkpoint_id,
    chain_id: fields.chain_id || lease?.chain_id,
    lease_id: lease?.lease_id || "none",
    lease_revision: lease?.lease_revision ?? 0,
    actor_id: fields.actor_id || lease?.actor_id,
    session_id: fields.session_id || lease?.session_id,
    repository_identity: fields.repository_identity || lease?.repository_identity,
    worktree_identity: fields.worktree_identity || lease?.worktree_identity,
    expected_head: fields.expected_head || lease?.expected_head,
  };
}

/**
 * Acquire lease.
 * Returns { lease, secrets: { lease_secret, session_secret } }
 * Secrets are NOT stored in cleartext on disk.
 */
export function acquireLease(execDir, fields) {
  ensureDir0700(execDir);
  const path = leasePath(execDir);
  const existing = readLease(execDir);

  const lease_secret = fields.lease_secret || mintSecret();
  const session_secret = fields.session_secret || mintSecret();
  const session_id = fields.session_id || `sess_${mintSecret().slice(0, 16)}`;

  if (!existing) {
    const lease = {
      format_version: "1.0.0",
      lease_id: mintLeaseId(),
      execution_id: fields.execution_id,
      chain_id: fields.chain_id,
      checkpoint_id: fields.checkpoint_id,
      repository_identity: fields.repository_identity,
      worktree_identity: fields.worktree_identity,
      actor_id: fields.actor_id,
      session_id,
      role: fields.role || "c2d-readonly",
      mutation_capability: fields.mutation_capability === true,
      acquired_at: new Date().toISOString(),
      renewed_at: new Date().toISOString(),
      lease_revision: 1,
      expected_head: fields.expected_head,
      released_at: null,
      lease_secret_digest: secretDigest(lease_secret),
      session_secret_digest: secretDigest(session_secret),
      host_identity: fields.host_identity,
    };
    try {
      writeJsonExclusiveCreate(path, lease);
    } catch (e) {
      if (e instanceof C2dHoldError && e.code === HOLD.JOURNAL_OUT_OF_ORDER) {
        throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT, "lease exclusive create lost race", {
          ttl_alone_cannot_reclaim: true,
        });
      }
      throw e;
    }
    return { lease, secrets: { lease_secret, session_secret } };
  }

  if (existing.released_at == null) {
    // Active lease: only same session secret proof may continue (not actor_id alone)
    if (fields.session_secret && fields.session_id === existing.session_id &&
        fields.actor_id === existing.actor_id &&
        secretDigest(fields.session_secret) === existing.session_secret_digest &&
        fields.lease_secret &&
        secretDigest(fields.lease_secret) === existing.lease_secret_digest) {
      return {
        lease: existing,
        secrets: {
          lease_secret: fields.lease_secret,
          session_secret: fields.session_secret,
        },
        continued: true,
      };
    }
    throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT, "active lease exists", {
      existing_lease_id: existing.lease_id,
      existing_actor_id: existing.actor_id,
      existing_session_id: existing.session_id,
      ttl_alone_cannot_reclaim: true,
    });
  }

  // Released: replace under structured lock
  const lock = acquireStructuredLock(leaseLockPath(execDir), lockIdentity(execDir, fields, existing));
  try {
    const again = readLease(execDir);
    if (again && again.released_at == null) {
      throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT, "lease became active under lock", {
        existing_lease_id: again.lease_id,
        ttl_alone_cannot_reclaim: true,
      });
    }
    const nextRev = again ? (again.lease_revision || 1) + 1 : 1;
    const lease = {
      format_version: "1.0.0",
      lease_id: mintLeaseId(),
      execution_id: fields.execution_id,
      chain_id: fields.chain_id,
      checkpoint_id: fields.checkpoint_id,
      repository_identity: fields.repository_identity,
      worktree_identity: fields.worktree_identity,
      actor_id: fields.actor_id,
      session_id,
      role: fields.role || "c2d-readonly",
      mutation_capability: fields.mutation_capability === true,
      acquired_at: new Date().toISOString(),
      renewed_at: new Date().toISOString(),
      lease_revision: nextRev,
      expected_head: fields.expected_head,
      released_at: null,
      lease_secret_digest: secretDigest(lease_secret),
      session_secret_digest: secretDigest(session_secret),
    };
    writeJsonAtomicReplaceUnderLock(path, lease);
    return { lease, secrets: { lease_secret, session_secret } };
  } finally {
    lock.release();
  }
}

export function releaseLease(execDir, leaseId, leaseRevision, secrets) {
  const path = leasePath(execDir);
  const existing0 = readLease(execDir);
  const lock = acquireStructuredLock(
    leaseLockPath(execDir),
    lockIdentity(execDir, {
      actor_id: existing0?.actor_id,
      session_id: existing0?.session_id,
      repository_identity: existing0?.repository_identity,
      worktree_identity: existing0?.worktree_identity,
      expected_head: existing0?.expected_head,
      execution_id: existing0?.execution_id,
      checkpoint_id: existing0?.checkpoint_id,
      chain_id: existing0?.chain_id,
    }, existing0 || { lease_id: leaseId, lease_revision: leaseRevision || 0 }),
  );
  try {
    const existing = readLease(execDir);
    if (!existing) return null;
    if (existing.lease_id !== leaseId) {
      throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT, "lease_id mismatch on release");
    }
    if (leaseRevision != null && existing.lease_revision !== leaseRevision) {
      throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT, "lease_revision mismatch on release");
    }
    // Mandatory secret authorization: a caller that only knows the public
    // lease_id + revision (both cleartext in lease.json) must NOT be able to
    // release an active lease. Both secret proofs are required and verified
    // with a timing-safe comparison. Never skip via optional chaining.
    if (!secrets || !secrets.lease_secret || !secrets.session_secret) {
      throw new C2dHoldError(HOLD.LEASE_RELEASE_NOT_SECRET_AUTHORIZED,
        "lease release requires lease_secret and session_secret");
    }
    if (!safeEqualHex(secretDigest(secrets.session_secret), existing.session_secret_digest)) {
      throw new C2dHoldError(HOLD.LEASE_RELEASE_NOT_SECRET_AUTHORIZED, "session_secret invalid on release");
    }
    if (!safeEqualHex(secretDigest(secrets.lease_secret), existing.lease_secret_digest)) {
      throw new C2dHoldError(HOLD.LEASE_RELEASE_NOT_SECRET_AUTHORIZED, "lease_secret invalid on release");
    }
    if (existing.released_at != null) return existing;
    const released = {
      ...existing,
      released_at: new Date().toISOString(),
      renewed_at: new Date().toISOString(),
      lease_revision: (existing.lease_revision || 1) + 1,
    };
    writeJsonAtomicReplaceUnderLock(path, released);
    return released;
  } finally {
    lock.release();
  }
}

export function validateLeaseOwner(execDir, leaseId, actorId, leaseRevision, secrets, expectedMutationCapability = false) {
  const existing = readLease(execDir);
  if (!existing || existing.released_at != null) {
    throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT, "no active lease");
  }
  if (existing.lease_id !== leaseId || existing.actor_id !== actorId) {
    throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT, "lease ownership mismatch");
  }
  if (leaseRevision != null && existing.lease_revision !== leaseRevision) {
    throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT, "lease revision mismatch");
  }
  if (secrets?.session_secret &&
      secretDigest(secrets.session_secret) !== existing.session_secret_digest) {
    throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT, "session_secret mismatch");
  }
  if (existing.mutation_capability !== expectedMutationCapability) {
    throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT,
      `lease mutation_capability mismatch: expected=${expectedMutationCapability}`);
  }
  return existing;
}
