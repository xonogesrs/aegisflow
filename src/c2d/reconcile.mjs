import { existsSync } from "node:fs";
import { C2dHoldError, HOLD } from "./fs-atomic.mjs";
import {
  completePath, publishComplete, readIntent, validateContinuity,
} from "./journal.mjs";
import { publishCurrent, readCurrent } from "./checkpoint-store.mjs";
import { validateLeaseOwner } from "./lease.mjs";
import { permitFromLease } from "./permit.mjs";
import { reconcileCandidateTransition } from "./reviewed-commit-candidate.mjs";
import { reconcileCommitTransition } from "./commit-materialized-candidate.mjs";

// Concrete C2D consumer. Generic callback helper below remains for legacy
// callers; candidate recovery always uses persisted candidate intent + Git.
export function reconcileCandidateLifecycle(execDir, args) {
  return reconcileCandidateTransition(args);
}

// C3C commit recovery. Distinct side_effect_class ("commit") from
// candidate_capture/candidate_materialization above, so an incomplete commit
// intent can never be reconciled through the candidate path or vice versa.
export function reconcileCommitLifecycle(execDir, args) {
  return reconcileCommitTransition(args);
}

/**
 * Generic reviewed-candidate reconciliation. Candidate capture and exact
 * materialization are non-repeatable filesystem effects: caller re-observes
 * Git truth and returns either exact-baseline or exact-candidate evidence.
 */
export function reconcileReviewedCandidateIntent(execDir, {
  leaseId, actorId, leaseRevision, secrets, revision, observeTruth,
  buildCompleteRecord, buildSnapshot,
}) {
  const lease = validateLeaseOwner(execDir, leaseId, actorId, leaseRevision, secrets, true);
  const permit = permitFromLease(execDir, lease, secrets, true);
  const cont = validateContinuity(execDir);
  if (cont.incompleteTail !== revision) {
    throw new C2dHoldError(HOLD.CHECKPOINT_REALITY_MISMATCH, "candidate revision is not incomplete tail");
  }
  const intent = readIntent(execDir, revision);
  if (!intent || !["candidate_capture", "candidate_materialization"].includes(intent.side_effect_class)) {
    throw new C2dHoldError(HOLD.CHECKPOINT_REALITY_MISMATCH, "not a reviewed candidate intent");
  }
  const current = readCurrent(execDir);
  if (!current) throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "CURRENT missing during candidate reconcile");
  const truth = observeTruth(intent);
  if (!truth || !["exact_baseline", "exact_candidate"].includes(truth.classification)) {
    throw new C2dHoldError(HOLD.CHECKPOINT_REALITY_MISMATCH, "partial candidate materialization reality mismatch");
  }
  const complete = buildCompleteRecord({ intent, truth });
  for (const f of ["revision", "transition_id", "execution_id", "checkpoint_id", "chain_id", "from_stage", "to_stage", "from_state", "to_state", "expected_revision_before", "side_effect_class"]) complete[f] = intent[f];
  const pub = publishComplete(execDir, complete, null, permit);
  const snapshot = buildSnapshot({ intent, truth, previous: current.snapshot, revision });
  snapshot.execution_id = intent.execution_id; snapshot.checkpoint_id = intent.checkpoint_id; snapshot.chain_id = intent.chain_id;
  return { complete: pub, snapshot: publishCurrent(execDir, snapshot, { expectedRevision: current.snapshot.revision, permit }) };
}

/**
 * Slice-1 reconciliation: INTENT exists, COMPLETE absent, side_effect_class = read_only.
 * Requires active lease (no silent reclaim). Identity taken from existing INTENT/CURRENT.
 */
export function reconcileReadOnlyIntent(execDir, {
  leaseId,
  actorId,
  leaseRevision,
  secrets,
  revision,
  reRunDiscovery,
  buildCompleteRecord,
  buildSnapshot,
}) {
  const lease = validateLeaseOwner(execDir, leaseId, actorId, leaseRevision, secrets);
  const permit = permitFromLease(execDir, lease, secrets);
  const cont = validateContinuity(execDir);
  if (cont.incompleteTail !== revision) {
    throw new C2dHoldError(HOLD.CHECKPOINT_REALITY_MISMATCH, "revision is not incomplete tail");
  }
  if (existsSync(completePath(execDir, revision))) {
    throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, "complete already exists");
  }
  const intent = readIntent(execDir, revision);
  if (!intent) {
    throw new C2dHoldError(HOLD.UNEXPECTED_COMPLETION_WITHOUT_INTENT, "intent missing");
  }
  if (intent.side_effect_class !== "read_only") {
    throw new C2dHoldError(HOLD.CHECKPOINT_REALITY_MISMATCH, "only read_only reconciliation in slice-1");
  }
  const existing = readCurrent(execDir);
  if (!existing) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "CURRENT missing during reconcile");
  }
  // Preserve identity from existing checkpoint / intent
  if (intent.execution_id !== existing.snapshot.execution_id ||
      intent.checkpoint_id !== existing.snapshot.checkpoint_id ||
      intent.chain_id !== existing.snapshot.chain_id) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "intent/checkpoint identity drift");
  }
  if (permit.execution_id !== intent.execution_id ||
      permit.checkpoint_id !== intent.checkpoint_id ||
      permit.chain_id !== intent.chain_id) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REQUIRED, "lease identity does not match intent");
  }

  const fresh = reRunDiscovery();
  const priorManifest = intent.expected_evidence_manifest || null;
  const freshManifest = fresh.evidence_manifest;
  if (priorManifest && JSON.stringify(priorManifest) !== JSON.stringify(freshManifest)) {
    throw new C2dHoldError(HOLD.CHECKPOINT_REALITY_MISMATCH, "read-only evidence mismatch on reconcile");
  }
  const completeRecord = buildCompleteRecord({ intent, evidence: fresh });
  // force identity from intent
  completeRecord.revision = intent.revision;
  completeRecord.transition_id = intent.transition_id;
  completeRecord.execution_id = intent.execution_id;
  completeRecord.checkpoint_id = intent.checkpoint_id;
  completeRecord.chain_id = intent.chain_id;
  completeRecord.from_stage = intent.from_stage;
  completeRecord.to_stage = intent.to_stage;
  completeRecord.from_state = intent.from_state;
  completeRecord.to_state = intent.to_state;
  completeRecord.expected_revision_before = intent.expected_revision_before;
  completeRecord.side_effect_class = intent.side_effect_class;

  const pub = publishComplete(execDir, completeRecord, null, permit);
  const snap = buildSnapshot({
    intent,
    complete: completeRecord,
    evidence: fresh,
    previous: existing.snapshot,
    revision,
  });
  snap.execution_id = intent.execution_id;
  snap.checkpoint_id = intent.checkpoint_id;
  snap.chain_id = intent.chain_id;
  const published = publishCurrent(execDir, snap, {
    expectedRevision: existing.snapshot.revision,
    permit,
  });
  return { complete: pub, snapshot: published };
}

/**
 * C3B mutation reconciliation: INTENT exists, COMPLETE absent,
 * side_effect_class = mutation. Requires an active mutation-capable lease
 * (no silent reclaim). Distinct from reconcileReadOnlyIntent above (which is
 * untouched and remains read_only-only) so a crash mid-mutation can never be
 * reconciled through the read-only path or vice versa.
 *
 * `reRunGate` re-derives the current scope/validation state (analogous to
 * reRunDiscovery) so the reconciler never trusts stale in-memory claims about
 * what happened before the crash — it re-observes the isolated worktree.
 */
export function reconcileMutationIntent(execDir, {
  leaseId,
  actorId,
  leaseRevision,
  secrets,
  revision,
  reRunGate,
  buildCompleteRecord,
  buildSnapshot,
}) {
  const lease = validateLeaseOwner(execDir, leaseId, actorId, leaseRevision, secrets, true);
  const permit = permitFromLease(execDir, lease, secrets, true);
  const cont = validateContinuity(execDir);
  if (cont.incompleteTail !== revision) {
    throw new C2dHoldError(HOLD.CHECKPOINT_REALITY_MISMATCH, "revision is not incomplete tail");
  }
  if (existsSync(completePath(execDir, revision))) {
    throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, "complete already exists");
  }
  const intent = readIntent(execDir, revision);
  if (!intent) {
    throw new C2dHoldError(HOLD.UNEXPECTED_COMPLETION_WITHOUT_INTENT, "intent missing");
  }
  if (intent.side_effect_class !== "mutation") {
    throw new C2dHoldError(HOLD.CHECKPOINT_REALITY_MISMATCH, "only mutation reconciliation via reconcileMutationIntent");
  }
  const existing = readCurrent(execDir);
  if (!existing) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "CURRENT missing during reconcile");
  }
  if (intent.execution_id !== existing.snapshot.execution_id ||
      intent.checkpoint_id !== existing.snapshot.checkpoint_id ||
      intent.chain_id !== existing.snapshot.chain_id) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "intent/checkpoint identity drift");
  }
  if (permit.execution_id !== intent.execution_id ||
      permit.checkpoint_id !== intent.checkpoint_id ||
      permit.chain_id !== intent.chain_id) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REQUIRED, "lease identity does not match intent");
  }

  const fresh = reRunGate();
  const completeRecord = buildCompleteRecord({ intent, gate: fresh });
  completeRecord.revision = intent.revision;
  completeRecord.transition_id = intent.transition_id;
  completeRecord.execution_id = intent.execution_id;
  completeRecord.checkpoint_id = intent.checkpoint_id;
  completeRecord.chain_id = intent.chain_id;
  completeRecord.from_stage = intent.from_stage;
  completeRecord.to_stage = intent.to_stage;
  completeRecord.from_state = intent.from_state;
  completeRecord.to_state = intent.to_state;
  completeRecord.expected_revision_before = intent.expected_revision_before;
  completeRecord.side_effect_class = intent.side_effect_class;

  const pub = publishComplete(execDir, completeRecord, null, permit);
  const snap = buildSnapshot({
    intent,
    complete: completeRecord,
    gate: fresh,
    previous: existing.snapshot,
    revision,
  });
  snap.execution_id = intent.execution_id;
  snap.checkpoint_id = intent.checkpoint_id;
  snap.chain_id = intent.chain_id;
  const published = publishCurrent(execDir, snap, {
    expectedRevision: existing.snapshot.revision,
    permit,
  });
  return { complete: pub, snapshot: published };
}
