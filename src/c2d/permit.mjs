// Secret-bound write permits. Lease stores only digest of lease_secret.
// Plain object clones without the secret cannot write.

import { timingSafeEqual } from "node:crypto";
import { C2dHoldError, HOLD } from "./fs-atomic.mjs";
import { readLease } from "./lease.mjs";
import { mintSecret, secretDigest } from "./execution-id.mjs";

export { mintSecret, secretDigest };

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Build secret-bound permit from active lease + secrets.
 * lease_secret and session_secret are held only by caller, never written to disk.
 */
export function permitFromLease(execDir, lease, secrets, expectedMutationCapability = false) {
  if (!lease || lease.released_at != null) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REQUIRED, "no active lease for permit");
  }
  if (lease.mutation_capability !== expectedMutationCapability) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REQUIRED,
      `permit requires lease mutation_capability=${expectedMutationCapability}`);
  }
  if (!secrets?.lease_secret || !secrets?.session_secret) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_INVALID, "lease_secret and session_secret required");
  }
  if (!safeEqualHex(secretDigest(secrets.lease_secret), lease.lease_secret_digest)) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_INVALID, "lease_secret digest mismatch");
  }
  if (!safeEqualHex(secretDigest(secrets.session_secret), lease.session_secret_digest)) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_INVALID, "session_secret digest mismatch");
  }
  return Object.freeze({
    execDir,
    lease_id: lease.lease_id,
    lease_revision: lease.lease_revision,
    actor_id: lease.actor_id,
    session_id: lease.session_id,
    execution_id: lease.execution_id,
    checkpoint_id: lease.checkpoint_id,
    chain_id: lease.chain_id,
    // secrets stay on permit object only; never serialize to checkpoint
    _lease_secret: secrets.lease_secret,
    _session_secret: secrets.session_secret,
  });
}

export function assertWritePermit(execDir, permit) {
  if (!permit) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REQUIRED, "write permit required");
  }
  if (permit.execDir !== execDir) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REQUIRED, "permit execDir mismatch");
  }
  if (!permit._lease_secret || !permit._session_secret) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_INVALID, "permit missing secrets (forge rejected)");
  }
  const live = readLease(execDir);
  if (!live || live.released_at != null) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REPLAYED, "lease not active");
  }
  if (live.lease_id !== permit.lease_id ||
      live.lease_revision !== permit.lease_revision ||
      live.actor_id !== permit.actor_id ||
      live.session_id !== permit.session_id ||
      live.execution_id !== permit.execution_id ||
      live.checkpoint_id !== permit.checkpoint_id ||
      live.chain_id !== permit.chain_id) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REPLAYED, "permit does not match active lease");
  }
  if (!safeEqualHex(secretDigest(permit._lease_secret), live.lease_secret_digest)) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_INVALID, "lease_secret invalid");
  }
  if (!safeEqualHex(secretDigest(permit._session_secret), live.session_secret_digest)) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_INVALID, "session_secret invalid");
  }
  return live;
}

export { mintSecret as mintLeaseSecret, mintSecret as mintSessionSecret };
