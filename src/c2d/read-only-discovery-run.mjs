// Slice-1: READ_ONLY_DISCOVERY dry-run.
// Dirty resume unsupported. Session/lease secrets required for continuation.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  C2dHoldError, HOLD, fireHook, sha256Hex,
} from "./fs-atomic.mjs";
import {
  mintExecutionId, mintChainId, mintCheckpointId, mintTransitionId, validateExecutionId,
} from "./execution-id.mjs";
import { collectFingerprint, assertFingerprint } from "./fingerprint.mjs";
import { acquireLease, releaseLease, validateLeaseOwner, readLease } from "./lease.mjs";
import { permitFromLease } from "./permit.mjs";
import {
  initExecutionDir, createInitialSnapshot, publishCurrent, readCurrent,
} from "./checkpoint-store.mjs";
import { publishIntent, publishComplete, validateContinuity } from "./journal.mjs";
import { reconcileReadOnlyIntent } from "./reconcile.mjs";

export function discoverReadOnly(repoRoot, inputPaths = []) {
  const fp = collectFingerprint(repoRoot);
  if (fp.dirty) {
    throw new C2dHoldError(HOLD.DIRTY_STATE_MISMATCH, "slice-1 requires clean worktree; dirty resume unsupported");
  }
  const files = {};
  for (const rel of inputPaths) {
    const p = join(repoRoot, rel);
    if (!existsSync(p)) {
      throw new C2dHoldError(HOLD.REQUIRED_GIT_OBJECT_MISSING, `input missing: ${rel}`);
    }
    files[rel] = sha256Hex(readFileSync(p));
  }
  return {
    fingerprint: fp,
    evidence_manifest: {
      head: fp.expected_head,
      worktree_state: fp.expected_worktree_state,
      files,
      kind: "read_only_discovery",
    },
  };
}

export function runReadOnlyDiscovery({
  repoRoot,
  checkpointRoot,
  actorId = "test-actor",
  sessionId,
  sessionSecret,
  leaseSecret,
  inputPaths = ["docs/loop/cross-session-resume-c2d.md"],
  executionId,
  chainId,
  checkpointId,
  // When set (integer >= 1), this run represents a single logical transition
  // at that journal revision: if the journal already holds a COMPLETE at or
  // beyond it, the run observes completion (mode "already_complete") instead
  // of dispatching another transition. Default null preserves the original
  // one-call-one-transition behavior.
  singleTransitionRevision = null,
}) {
  if (singleTransitionRevision != null &&
      (!Number.isInteger(singleTransitionRevision) || singleTransitionRevision < 1)) {
    throw new C2dHoldError(HOLD.CHECKPOINT_REALITY_MISMATCH,
      `invalid singleTransitionRevision: ${singleTransitionRevision}`);
  }
  const fp = collectFingerprint(repoRoot);
  assertFingerprint(fp, fp, { requireClean: true });

  const execId = validateExecutionId(executionId || mintExecutionId());
  const execDir = initExecutionDir(checkpointRoot, execId);

  const cont0 = validateContinuity(execDir);
  const existingLease = readLease(execDir);

  // Active lease: only secret-bound same session may continue
  if (cont0.incompleteTail != null && existingLease && existingLease.released_at == null) {
    if (!sessionSecret || !leaseSecret || !sessionId) {
      throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT, "active crash lease; session secrets required");
    }
    const cont = acquireLease(execDir, {
      execution_id: execId,
      chain_id: existingLease.chain_id,
      checkpoint_id: existingLease.checkpoint_id,
      repository_identity: fp.repository_root_identity,
      worktree_identity: fp.worktree_identity,
      actor_id: actorId,
      session_id: sessionId,
      session_secret: sessionSecret,
      lease_secret: leaseSecret,
      expected_head: fp.expected_head,
    });
    if (!cont.continued) {
      throw new C2dHoldError(HOLD.RESUME_LEASE_CONFLICT, "could not continue active lease");
    }
    const permit = permitFromLease(execDir, cont.lease, cont.secrets);
    return finishReconcile({
      execDir, execId, lease: cont.lease, secrets: cont.secrets, permit, actorId,
      repoRoot, inputPaths, incompleteTail: cont0.incompleteTail,
    });
  }

  const acquired = acquireLease(execDir, {
    execution_id: execId,
    chain_id: chainId || (readCurrentSafe(execDir)?.snapshot.chain_id) || mintChainId(),
    checkpoint_id: checkpointId || (readCurrentSafe(execDir)?.snapshot.checkpoint_id) || mintCheckpointId(),
    repository_identity: fp.repository_root_identity,
    worktree_identity: fp.worktree_identity,
    actor_id: actorId,
    session_id: sessionId,
    session_secret: sessionSecret,
    lease_secret: leaseSecret,
    expected_head: fp.expected_head,
  });
  const lease = acquired.lease;
  const secrets = acquired.secrets;
  const permit = permitFromLease(execDir, lease, secrets);

  let current = readCurrentSafe(execDir);
  if (!current) {
    const initial = createInitialSnapshot({
      checkpoint_id: lease.checkpoint_id,
      execution_id: execId,
      chain_id: lease.chain_id,
      repository_fingerprint: fp,
      repository_root_identity: fp.repository_root_identity,
      git_common_dir_identity: fp.git_common_dir_identity,
      expected_head: fp.expected_head,
      expected_ref: fp.expected_ref,
      origin_url: fp.origin_url,
      origin_master: fp.origin_master,
      expected_worktree_state: fp.expected_worktree_state,
      current_owner_actor: actorId,
      lease_identity: lease.lease_id,
      input_manifest: { inputPaths },
    });
    current = publishCurrent(execDir, initial, { expectedRevision: 0, permit });
  } else if (current.snapshot.execution_id !== execId) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "execution_id drift");
  }

  const cont = validateContinuity(execDir);
  if (cont.incompleteTail != null) {
    return finishReconcile({
      execDir, execId, lease, secrets, permit, actorId, repoRoot, inputPaths,
      incompleteTail: cont.incompleteTail,
    });
  }

  if (singleTransitionRevision != null && cont.lastComplete >= singleTransitionRevision) {
    // Logical transition already durably complete: observe, never redispatch.
    const released = releaseLease(execDir, lease.lease_id, lease.lease_revision, secrets);
    return {
      execution_id: execId,
      chain_id: current.snapshot.chain_id,
      checkpoint_id: current.snapshot.checkpoint_id,
      execDir,
      released,
      snapshot: current,
      journal_last_complete: cont.lastComplete,
      mode: "already_complete",
    };
  }

  const expectedRevisionBefore = current.snapshot.revision;
  const transitionId = mintTransitionId();
  const nextRev = cont.lastComplete + 1;
  const intent = {
    format_version: "1.0.0",
    revision: nextRev,
    transition_id: transitionId,
    execution_id: current.snapshot.execution_id,
    checkpoint_id: current.snapshot.checkpoint_id,
    chain_id: current.snapshot.chain_id,
    record_kind: "intent",
    from_stage: current.snapshot.stage,
    to_stage: "READ_ONLY_DISCOVERY",
    from_state: current.snapshot.state,
    to_state: "RESUME_READY",
    actor_id: actorId,
    timestamp: new Date().toISOString(),
    side_effect_class: "read_only",
    expected_revision_before: expectedRevisionBefore,
    evidence_refs: inputPaths.slice(),
    expected_evidence_manifest: null,
  };

  validateLeaseOwner(execDir, lease.lease_id, actorId, lease.lease_revision, secrets);
  const intentPub = publishIntent(execDir, intent, permit);

  fireHook("after_read_only_action_pending");
  const discovery = discoverReadOnly(repoRoot, inputPaths);
  fireHook("after_read_only_action");

  const completeRecord = {
    format_version: "1.0.0",
    revision: nextRev,
    transition_id: transitionId,
    execution_id: intent.execution_id,
    checkpoint_id: intent.checkpoint_id,
    chain_id: intent.chain_id,
    record_kind: "verified_complete",
    from_stage: intent.from_stage,
    to_stage: intent.to_stage,
    from_state: intent.from_state,
    to_state: "RESUME_READY",
    actor_id: actorId,
    timestamp: new Date().toISOString(),
    side_effect_class: "read_only",
    expected_revision_before: expectedRevisionBefore,
    evidence_refs: inputPaths.slice(),
    verification_evidence: discovery.evidence_manifest,
    intent_digest: intentPub.digest,
  };

  const completePub = publishComplete(execDir, completeRecord, intentPub.digest, permit);

  const nextSnapshot = {
    ...current.snapshot,
    revision: nextRev,
    stage: "READ_ONLY_DISCOVERY",
    state: "RESUME_READY",
    c2d_control_state: "RESUME_READY",
    expected_head: discovery.fingerprint.expected_head,
    expected_ref: discovery.fingerprint.expected_ref,
    origin_url: discovery.fingerprint.origin_url,
    origin_master: discovery.fingerprint.origin_master,
    expected_worktree_state: discovery.fingerprint.expected_worktree_state,
    repository_fingerprint: discovery.fingerprint,
    last_completed_transition: transitionId,
    next_transition_candidate: {
      value: "NONE",
      advisory_only: true,
      not_authorization: true,
    },
    current_owner_actor: actorId,
    lease_identity: lease.lease_id,
    input_manifest: { inputPaths, evidence: discovery.evidence_manifest },
  };

  const published = publishCurrent(execDir, nextSnapshot, {
    expectedRevision: expectedRevisionBefore,
    permit,
  });

  const released = releaseLease(execDir, lease.lease_id, lease.lease_revision, secrets);

  return {
    execution_id: execId,
    chain_id: current.snapshot.chain_id,
    checkpoint_id: current.snapshot.checkpoint_id,
    execDir,
    lease,
    secrets,
    released,
    intent: intentPub,
    complete: completePub,
    snapshot: published,
    discovery,
    mode: "fresh",
    durability_capability: published.durability_capability || intentPub.durability_capability,
  };
}

function readCurrentSafe(execDir) {
  try {
    return readCurrent(execDir);
  } catch (e) {
    if (e instanceof C2dHoldError) throw e;
    return null;
  }
}

function finishReconcile({
  execDir, execId, lease, secrets, permit, actorId, repoRoot, inputPaths, incompleteTail,
}) {
  const result = reconcileReadOnlyIntent(execDir, {
    leaseId: lease.lease_id,
    actorId,
    leaseRevision: lease.lease_revision,
    secrets,
    revision: incompleteTail,
    reRunDiscovery: () => discoverReadOnly(repoRoot, inputPaths),
    buildCompleteRecord: ({ intent, evidence }) => ({
      format_version: "1.0.0",
      revision: intent.revision,
      transition_id: intent.transition_id,
      execution_id: intent.execution_id,
      checkpoint_id: intent.checkpoint_id,
      chain_id: intent.chain_id,
      record_kind: "verified_complete",
      from_stage: intent.from_stage,
      to_stage: intent.to_stage,
      from_state: intent.from_state,
      to_state: "RESUME_READY",
      actor_id: actorId,
      timestamp: new Date().toISOString(),
      side_effect_class: "read_only",
      expected_revision_before: intent.expected_revision_before,
      evidence_refs: intent.evidence_refs || [],
      verification_evidence: evidence.evidence_manifest,
      intent_digest: "",
    }),
    buildSnapshot: ({ evidence, previous, revision, intent }) => ({
      ...previous,
      revision,
      stage: "READ_ONLY_DISCOVERY",
      state: "RESUME_READY",
      c2d_control_state: "RESUME_READY",
      expected_head: evidence.fingerprint.expected_head,
      expected_ref: evidence.fingerprint.expected_ref,
      origin_url: evidence.fingerprint.origin_url,
      origin_master: evidence.fingerprint.origin_master,
      expected_worktree_state: evidence.fingerprint.expected_worktree_state,
      last_completed_transition: intent.transition_id,
      next_transition_candidate: {
        value: "NONE",
        advisory_only: true,
        not_authorization: true,
      },
      current_owner_actor: actorId,
      lease_identity: lease.lease_id,
    }),
  });
  const released = releaseLease(execDir, lease.lease_id, lease.lease_revision, secrets);
  return {
    execution_id: execId,
    execDir,
    lease,
    secrets,
    released,
    mode: "reconcile",
    result,
  };
}

export {
  mintExecutionId,
  collectFingerprint,
  acquireLease,
  HOLD,
  C2dHoldError,
};
