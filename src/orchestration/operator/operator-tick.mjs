#!/usr/bin/env node
// operator-tick.mjs
//
// Phase C3A: minimal read-only integration of the sealed C2D checkpoint
// runtime into operator-tick dispatch.
//
// Feature gate:
//   AURA_AUTOLOOP_C3A_C2D_READ_ONLY=1   (explicit opt-in; DEFAULT DISABLED)
//
// Disabled → legacy behavior only: the tick delegates to the sealed
// scheduler tick (scheduler-tick-dry.mjs) with unchanged arguments, exit
// codes and verdict semantics. No C2D execution is created, no checkpoint
// state is written.
//
// Enabled → an explicitly eligible read-only candidate (side_effect_class
// "read_only", transition "READ_ONLY_DISCOVERY", no mutation / commit /
// push authorization) is dispatched through the sealed C2D entrypoint
// runReadOnlyDiscovery. The operator layer never writes CURRENT.json,
// checksums, journal records, lease.json, locks, tombstones or guards
// directly, and never adjusts revisions — all checkpoint side effects go
// through C2D (acquireLease → publishIntent → discovery → publishComplete
// → publishCurrent → releaseLease).
//
// Canonical execution identity: the candidate's immutable identity tuple
// (candidate_id, candidate_revision, transition, side_effect_class,
// repository/worktree identity, expected HEAD) deterministically derives
// execution_id / chain_id / checkpoint_id, and the binding is persisted in
// an exclusive-create index record (<checkpoint-root>/c3a-index/) so process
// memory is never the only identity truth. A same-candidate_id re-tick with
// changed immutable identity fails closed (HOLD), never mints a replacement
// execution.
//
// Secret lifecycle: lease/session secrets are minted inside C2D, held only
// in process memory, and never persisted or emitted (results are built from
// an explicit whitelist). There is no cross-tick plaintext secret storage:
// an active incomplete lease from a crashed tick fails closed
// (active_lease_conflict HOLD) unless the same session proof is supplied
// in-process via `resumeSession`, in which case existing C2D reconciliation
// runs.
//
// Discovery is advisory only. It is never mutation, commit, push or seal
// authorization.
//
// CLI exit codes:
//   0  tick completed (fresh / already_complete / reconcile / legacy path)
//   2  usage error
//   5  HOLD (fail-closed; never converted to skip or success)
//   (legacy delegation preserves scheduler exit codes 0/2/3/4)

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  C2dHoldError, HOLD, assertNotSymlink, resolveSafeRoot, writeJsonExclusiveCreate,
} from "../../c2d/fs-atomic.mjs";
import { validateExecutionId } from "../../c2d/execution-id.mjs";
import { collectFingerprint, assertFingerprint } from "../../c2d/fingerprint.mjs";
import { resolveExecDir, readCurrent, currentPath } from "../../c2d/checkpoint-store.mjs";
import { runReadOnlyDiscovery } from "../../c2d/read-only-discovery-run.mjs";
import { acquireLease, releaseLease } from "../../c2d/lease.mjs";
import { permitFromLease } from "../../c2d/permit.mjs";
import { validateContinuity, readIntent } from "../../c2d/journal.mjs";
import { commitMaterializedCandidate, reconcileCommitTransition } from "../../c2d/commit-materialized-candidate.mjs";
import {
  readCandidate, candidatePath, validateCandidate,
  materializeReviewedCandidate, reconcileCandidateTransition,
} from "../../c2d/reviewed-commit-candidate.mjs";
import { acquireRepositoryMutationLock } from "../../c2d/repository-mutation-lock.mjs";
import { materializationAuthorizationPath } from "../../c2d/materialization-authorization.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEDULER = join(HERE, "scheduler-tick-dry.mjs");

export const FEATURE_ENV = "AURA_AUTOLOOP_C3A_C2D_READ_ONLY";

export function c3aFeatureEnabled(env = process.env) {
  // Explicit opt-in only. No fuzzy auto-detection.
  return env[FEATURE_ENV] === "1";
}

export const C3A_HOLD = Object.freeze({
  READ_ONLY_SCOPE_VIOLATION: "HOLD / C3A_READ_ONLY_SCOPE_VIOLATION",
  CANDIDATE_IDENTITY_INCOMPLETE: "HOLD / C3A_CANDIDATE_IDENTITY_INCOMPLETE",
  CANDIDATE_IDENTITY_MISMATCH: "HOLD / C3A_CANDIDATE_IDENTITY_MISMATCH",
});

export class C3aHoldError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "C3aHoldError";
    this.code = code;
  }
}

// ── Candidate eligibility (fail closed) ─────────────────────────────

const CANDIDATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
// Any of these present and truthy on a candidate means it is not a pure
// read-only discovery candidate. Never auto-downgrade — fail closed.
const FORBIDDEN_MARKER_KEYS = [
  "mutation", "commit", "push", "repair", "delete", "move", "purge",
  "mutation_allowed", "commit_allowed", "push_allowed", "seal_allowed",
];

function scopeViolation(msg) {
  return new C3aHoldError(C3A_HOLD.READ_ONLY_SCOPE_VIOLATION, msg);
}

function identityIncomplete(msg) {
  return new C3aHoldError(C3A_HOLD.CANDIDATE_IDENTITY_INCOMPLETE, msg);
}

export function assertCandidateEligible(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw identityIncomplete("candidate must be a JSON object");
  }
  // Side-effect scope first: a mutation candidate is a scope violation even
  // if its identity is also incomplete.
  if (candidate.side_effect_class !== "read_only") {
    throw scopeViolation(`side_effect_class must be "read_only", got ${JSON.stringify(candidate.side_effect_class ?? null)}`);
  }
  if (candidate.transition !== "READ_ONLY_DISCOVERY") {
    throw scopeViolation(`transition must be "READ_ONLY_DISCOVERY", got ${JSON.stringify(candidate.transition ?? null)}`);
  }
  for (const k of FORBIDDEN_MARKER_KEYS) {
    if (k in candidate && candidate[k]) {
      throw scopeViolation(`forbidden marker present on candidate: ${k}`);
    }
  }
  const authority = candidate.phase_effective_authority;
  if (authority != null) {
    if (typeof authority !== "object" || Array.isArray(authority)) {
      throw scopeViolation("phase_effective_authority must be an object when present");
    }
    for (const k of Object.keys(authority)) {
      if (authority[k] === true) {
        throw scopeViolation(`authority grant present: phase_effective_authority.${k}`);
      }
    }
  }
  if (candidate.proposed_execution_capability &&
      candidate.proposed_execution_capability.mutation_requested) {
    throw scopeViolation("proposed_execution_capability.mutation_requested is set");
  }
  if (Array.isArray(candidate.operations) && candidate.operations.length > 0) {
    throw scopeViolation("candidate declares operations; C3A dispatches none");
  }
  if (candidate.input_paths != null) {
    if (!Array.isArray(candidate.input_paths)) {
      throw scopeViolation("input_paths must be an array when present");
    }
    for (const p of candidate.input_paths) {
      if (typeof p !== "string" || p.length === 0 || p.startsWith("/") ||
          p.includes("\0") || p.includes("\\") ||
          p.split("/").includes("..")) {
        throw scopeViolation(`unsafe input path: ${JSON.stringify(p)}`);
      }
    }
  }
  // Canonical identity completeness.
  if (typeof candidate.candidate_id !== "string" || !CANDIDATE_ID_RE.test(candidate.candidate_id)) {
    throw identityIncomplete("candidate_id missing or not path-safe");
  }
  if (!Number.isInteger(candidate.candidate_revision) || candidate.candidate_revision < 1) {
    throw identityIncomplete("candidate_revision must be an integer >= 1");
  }
  const b = candidate.binding;
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    throw identityIncomplete("binding missing");
  }
  if (typeof b.repository_root_identity !== "string" || !b.repository_root_identity.startsWith("/")) {
    throw identityIncomplete("binding.repository_root_identity missing or not absolute");
  }
  if (typeof b.worktree_identity !== "string" || !b.worktree_identity.startsWith("/")) {
    throw identityIncomplete("binding.worktree_identity missing or not absolute");
  }
  if (typeof b.expected_head !== "string" || !GIT_SHA_RE.test(b.expected_head)) {
    throw identityIncomplete("binding.expected_head missing or not a 40-hex commit id");
  }
  return candidate;
}

// ── Canonical candidate → execution identity ────────────────────────

export function deriveCanonicalExecutionIdentity(candidate) {
  const tuple = {
    scheme: "aura-c3a-read-only-v1",
    candidate_id: candidate.candidate_id,
    candidate_revision: candidate.candidate_revision,
    transition: candidate.transition,
    side_effect_class: candidate.side_effect_class,
    repository_root_identity: candidate.binding.repository_root_identity,
    worktree_identity: candidate.binding.worktree_identity,
    expected_head: candidate.binding.expected_head,
  };
  const canonical = JSON.stringify(tuple, Object.keys(tuple).sort());
  const identityDigest = createHash("sha256").update(canonical, "utf8").digest("hex");
  const derive = (domain) =>
    createHash("sha256").update(`${domain}:${identityDigest}`, "utf8").digest("hex");
  return {
    identity_digest: identityDigest,
    execution_id: validateExecutionId(`exec_${derive("exec").slice(0, 32)}`),
    chain_id: `chain_${derive("chain").slice(0, 24)}`,
    checkpoint_id: `ckpt_${derive("ckpt").slice(0, 24)}`,
  };
}

export function c3aIndexPath(checkpointRoot, candidateId) {
  return join(resolveSafeRoot(checkpointRoot), "c3a-index", `${candidateId}.json`);
}

/**
 * Resolve (and persist on first sight) the candidate → execution mapping.
 * The index record is the durable identity truth; a candidate_id seen again
 * with a different immutable identity fails closed.
 */
export function resolveCandidateExecution(checkpointRoot, candidate) {
  const identity = deriveCanonicalExecutionIdentity(candidate);
  const p = c3aIndexPath(checkpointRoot, candidate.candidate_id);

  const verifyExisting = () => {
    assertNotSymlink(p);
    let existing;
    try {
      existing = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, `c3a index unreadable: ${e.message}`);
    }
    if (existing.identity_digest !== identity.identity_digest ||
        existing.execution_id !== identity.execution_id) {
      throw new C3aHoldError(C3A_HOLD.CANDIDATE_IDENTITY_MISMATCH,
        `candidate ${candidate.candidate_id} already bound to a different immutable identity`);
    }
    return { ...identity, index_path: p, index_created: false };
  };

  if (existsSync(p)) return verifyExisting();

  const record = {
    format_version: "1.0.0",
    candidate_id: candidate.candidate_id,
    candidate_revision: candidate.candidate_revision,
    identity_digest: identity.identity_digest,
    execution_id: identity.execution_id,
    chain_id: identity.chain_id,
    checkpoint_id: identity.checkpoint_id,
    binding: {
      repository_root_identity: candidate.binding.repository_root_identity,
      worktree_identity: candidate.binding.worktree_identity,
      expected_head: candidate.binding.expected_head,
    },
    created_at: new Date().toISOString(),
  };
  try {
    writeJsonExclusiveCreate(p, record);
  } catch (e) {
    if (e instanceof C2dHoldError && e.code === HOLD.JOURNAL_OUT_OF_ORDER) {
      // Lost the exclusive-create race; content is deterministic, so verify.
      return verifyExisting();
    }
    throw e;
  }
  return { ...identity, index_path: p, index_created: true };
}

// ── Operator result (whitelisted; never carries secrets) ────────────

const NON_AUTHORITY = Object.freeze({
  advisory_only: true,
  not_authorization: true,
  mutation_authorized: false,
  commit_authorized: false,
  push_authorized: false,
});

function classifyHold(e) {
  if (e instanceof C3aHoldError) {
    if (e.code === C3A_HOLD.READ_ONLY_SCOPE_VIOLATION) return "read_only_scope_violation";
    if (e.code === C3A_HOLD.CANDIDATE_IDENTITY_MISMATCH) return "candidate_identity_mismatch";
    return "candidate_identity_incomplete";
  }
  if (e instanceof C2dHoldError) {
    switch (e.code) {
      case HOLD.RESUME_LEASE_CONFLICT:
      case HOLD.LEASE_RELEASE_NOT_SECRET_AUTHORIZED:
        return "active_lease_conflict";
      case HOLD.EXPECTED_HEAD_MISMATCH:
      case HOLD.REPOSITORY_FINGERPRINT_MISMATCH:
      case HOLD.WORKTREE_IDENTITY_MISMATCH:
      case HOLD.DIRTY_STATE_MISMATCH:
        return "fingerprint_mismatch";
      case HOLD.SNAPSHOT_CHECKSUM_MISMATCH:
      case HOLD.CHECKPOINT_CORRUPT:
      case HOLD.CHECKPOINT_REALITY_MISMATCH:
      case HOLD.JOURNAL_GAP:
      case HOLD.JOURNAL_OUT_OF_ORDER:
      case HOLD.INTENT_WITHOUT_COMPLETION:
      case HOLD.UNEXPECTED_COMPLETION_WITHOUT_INTENT:
        return "checkpoint_corrupt";
      default:
        return "hold";
    }
  }
  return "error";
}

function snapshotOf(r) {
  if (!r) return null;
  if (r.mode === "reconcile") return r.result?.snapshot?.snapshot ?? null;
  return r.snapshot?.snapshot ?? null;
}

function okResult(base, candidate, identity, r) {
  const snap = snapshotOf(r);
  return {
    ...base,
    status: r.mode,
    verdict: "OK",
    hold_code: null,
    candidate_id: candidate.candidate_id,
    candidate_revision: candidate.candidate_revision,
    execution_id: identity.execution_id,
    chain_id: identity.chain_id,
    checkpoint_id: identity.checkpoint_id,
    mode: r.mode,
    transition_id: snap?.last_completed_transition ?? null,
    revision: snap?.revision ?? null,
    c2d_control_state: snap?.c2d_control_state ?? null,
    next_transition_candidate: snap?.next_transition_candidate ?? null,
    durability_capability: r.durability_capability
      ?? r.result?.snapshot?.durability_capability ?? null,
    lease_released: r.released ? r.released.released_at != null : null,
    ...NON_AUTHORITY,
  };
}

function holdResult(base, candidate, identity, e) {
  return {
    ...base,
    status: classifyHold(e),
    verdict: "HOLD",
    hold_code: e.code || null,
    hold_message: e.message || String(e),
    candidate_id: candidate?.candidate_id ?? null,
    candidate_revision: candidate?.candidate_revision ?? null,
    execution_id: identity?.execution_id ?? null,
    chain_id: identity?.chain_id ?? null,
    checkpoint_id: identity?.checkpoint_id ?? null,
    mode: null,
    transition_id: null,
    revision: null,
    c2d_control_state: null,
    ...NON_AUTHORITY,
  };
}

// ── C3A tick ─────────────────────────────────────────────────────────

export function loadCandidateFile(candidatePath) {
  let raw;
  try {
    raw = readFileSync(candidatePath, "utf8");
  } catch (e) {
    throw identityIncomplete(`candidate file unreadable: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw identityIncomplete(`candidate file is not valid JSON: ${e.message}`);
  }
}

/**
 * Dispatch one eligible read-only candidate through the C2D runtime.
 * `resumeSession` ({ session_id, session_secret, lease_secret }) is an
 * in-memory, process-scoped continuation proof only — it is never read from
 * or written to disk by this layer.
 */
export function operatorTickC2dReadOnly({
  repoRoot,
  checkpointRoot,
  candidate = null,
  candidatePath = null,
  actorId = "operator-tick",
  resumeSession = null,
  env = process.env,
}) {
  const base = { stage: "c3a", feature: c3aFeatureEnabled(env) ? "enabled" : "disabled" };
  if (!c3aFeatureEnabled(env)) {
    return {
      ...base,
      status: "feature_disabled",
      verdict: "OK",
      dispatched: false,
      ...NON_AUTHORITY,
    };
  }

  let cand = null;
  let identity = null;
  try {
    cand = candidate ?? loadCandidateFile(candidatePath);
    assertCandidateEligible(cand);
    if (typeof repoRoot !== "string" || !repoRoot) {
      throw identityIncomplete("repoRoot required");
    }
    if (typeof checkpointRoot !== "string" || !checkpointRoot) {
      throw identityIncomplete("checkpointRoot required");
    }

    // Fingerprint fail-closed against the candidate's declared binding.
    const fp = collectFingerprint(repoRoot);
    assertFingerprint(fp, {
      expected_head: cand.binding.expected_head,
      repository_root_identity: cand.binding.repository_root_identity,
      worktree_identity: cand.binding.worktree_identity,
    }, { requireClean: true });

    identity = resolveCandidateExecution(checkpointRoot, cand);

    // Inspect canonical C2D state (read only). Corrupt state fails closed;
    // a durably completed transition is observed without redispatch. The
    // race-free completed check is enforced again inside C2D under the lease
    // via singleTransitionRevision.
    const execDir = resolveExecDir(checkpointRoot, identity.execution_id);
    if (existsSync(currentPath(execDir))) {
      const current = readCurrent(execDir);
      if (current.snapshot.execution_id !== identity.execution_id ||
          current.snapshot.chain_id !== identity.chain_id ||
          current.snapshot.checkpoint_id !== identity.checkpoint_id) {
        throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT,
          "checkpoint identity does not match canonical candidate identity");
      }
      if (current.snapshot.revision >= 1 &&
          current.snapshot.stage === "READ_ONLY_DISCOVERY" &&
          current.snapshot.last_completed_transition) {
        return okResult(base, cand, identity, {
          mode: "already_complete",
          snapshot: current,
          released: null,
          durability_capability: null,
        });
      }
    }

    const r = runReadOnlyDiscovery({
      repoRoot,
      checkpointRoot,
      actorId,
      executionId: identity.execution_id,
      chainId: identity.chain_id,
      checkpointId: identity.checkpoint_id,
      inputPaths: Array.isArray(cand.input_paths) ? cand.input_paths.slice() : [],
      singleTransitionRevision: 1,
      ...(resumeSession
        ? {
            sessionId: resumeSession.session_id,
            sessionSecret: resumeSession.session_secret,
            leaseSecret: resumeSession.lease_secret,
          }
        : {}),
    });
    return okResult(base, cand, identity, r);
  } catch (e) {
    return holdResult(base, cand, identity, e);
  }
}

// ── C3C explicit commit-reconciliation dispatch (feature-gated) ─────
//
// Separate from C3A above: C3A's assertCandidateEligible hard-rejects any
// candidate carrying a commit/mutation/push/seal marker, by design, so a
// commit-bearing dispatch cannot and must not be routed through it. This is
// therefore an independent dispatch branch, gated by its own feature flag,
// sharing nothing with C3A's eligibility gate or its read-only C2D
// discovery call. It never creates, approves, or reconstructs authorization
// -- it only initiates an already-authorized durable transition through the
// sealed C3C consumer (commit-materialized-candidate.mjs), which remains
// completely unmodified.

export const C3C_FEATURE_ENV = "AURA_AUTOLOOP_C3C_COMMIT_INTEGRATION";

export function c3cFeatureEnabled(env = process.env) {
  // Explicit opt-in only, independent of AURA_AUTOLOOP_C3A_C2D_READ_ONLY.
  return env[C3C_FEATURE_ENV] === "1";
}

export const C3C_OPERATOR_HOLD = Object.freeze({
  CANDIDATE_PATH_NOT_CANONICAL: "HOLD / C3C_OPERATOR_CANDIDATE_PATH_NOT_CANONICAL",
  CANDIDATE_STRUCTURALLY_INVALID: "HOLD / C3C_OPERATOR_CANDIDATE_STRUCTURALLY_INVALID",
  MATERIALIZED_STATE_MISSING: "HOLD / C3C_OPERATOR_MATERIALIZED_STATE_MISSING",
  EXECUTION_IDENTITY_MISMATCH: "HOLD / C3C_OPERATOR_EXECUTION_IDENTITY_MISMATCH",
  MODE_CONFLICT: "HOLD / C3C_OPERATOR_MODE_CONFLICT",
});

export class C3cOperatorHoldError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "C3cOperatorHoldError";
    this.code = code;
  }
}

function reviewArtifactPath(execDir, candidateId) {
  // Mirrors the identical literal convention already used by the sealed
  // commit-authorization.mjs (reviewPath) and reviewed-commit-candidate.mjs
  // (reviewerArtifactPath, private) -- reused here as a read-only reference
  // to an existing durable location, not a new artifact or new convention.
  return join(execDir, "reviews", `${candidateId}.json`);
}

function readDurableReviewArtifact(execDir, candidateId) {
  const p = reviewArtifactPath(execDir, candidateId);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * Resolve an explicit --candidate path to the durable materialized-candidate
 * record it must reference. The caller-supplied path is used only for
 * routing (which execDir/candidate_id); the content actually used for
 * commit dispatch is always re-read from the canonical durable location via
 * readCandidate, never trusted from the caller-supplied file directly. A
 * path that does not resolve (after symlink resolution) to that canonical
 * location is rejected -- this is the only caller-supplied "reference," and
 * it can never carry authority of its own.
 */
function resolveDurableCommitCandidate(checkpointRoot, candidateFilePath) {
  const raw = loadCandidateFile(candidateFilePath);
  const structCheck = validateCandidate(raw);
  if (!structCheck.valid) {
    throw new C3cOperatorHoldError(
      C3C_OPERATOR_HOLD.CANDIDATE_STRUCTURALLY_INVALID,
      `candidate file structurally invalid: ${structCheck.errors.join(",")}`,
    );
  }
  const execDir = resolveExecDir(checkpointRoot, raw.execution_id);
  const canonicalPath = candidatePath(execDir, raw.candidate_id);
  let realArg, realCanonical;
  try {
    realArg = realpathSync(candidateFilePath);
    realCanonical = realpathSync(canonicalPath);
  } catch (e) {
    throw new C3cOperatorHoldError(
      C3C_OPERATOR_HOLD.CANDIDATE_PATH_NOT_CANONICAL,
      `candidate path could not be resolved against the durable store: ${e.message}`,
    );
  }
  if (realArg !== realCanonical) {
    throw new C3cOperatorHoldError(
      C3C_OPERATOR_HOLD.CANDIDATE_PATH_NOT_CANONICAL,
      "--candidate must reference the canonical durable candidate artifact for its execution_id/candidate_id, not a caller-supplied copy",
    );
  }
  // Authoritative re-read from the canonical path; ignores `raw` beyond routing.
  const candidate = readCandidate(execDir, raw.candidate_id);
  if (!candidate) {
    throw new C3cOperatorHoldError(
      C3C_OPERATOR_HOLD.MATERIALIZED_STATE_MISSING,
      "durable candidate artifact missing after canonical-path verification",
    );
  }
  return { execDir, candidate };
}

/**
 * Dispatch one explicit, already-authorized durable candidate to the sealed
 * C3C boundary. Never mints CURRENT/candidate/authorization state itself --
 * it only acquires the execDir's existing mutation-capable lease (the
 * sealed consumer takes a pre-built permit and never acquires its own, see
 * commit-materialized-candidate.mjs) and then selects between the two
 * sealed C3C entry points based on journal continuity:
 *   - an incomplete "commit" journal tail -> reconcileCommitTransition
 *     (crash recovery; deterministic recompute, never a second commit).
 *   - otherwise -> commitMaterializedCandidate (fresh mint).
 * A non-"commit" incomplete tail (e.g. a crashed mutation transition) is
 * never special-cased here: falling through to commitMaterializedCandidate
 * lets its own existing CONFLICTING_INTENT check fail closed, exactly as
 * sealed -- this wrapper never reimplements that check.
 */
function reconcileOrCommitCandidate({ repoRoot, execDir, permit, candidate, review, repositoryLock, invocationCounters }) {
  const continuity = validateContinuity(execDir);
  if (continuity.incompleteTail != null) {
    const r = reconcileCommitTransition({ repoRoot, execDir, permit, repositoryLock });
    if (r.state === "COMMITTED_LOCAL_VERIFIED") {
      return { mode: "reconcile", state: r.state, completion: r.completion };
    }
    // r.state === "NO_COMMIT_TRANSITION": incomplete tail exists but is not
    // a commit transition. Fall through; commitMaterializedCandidate's own
    // continuity check below is what fails this closed.
  }
  const completion = commitMaterializedCandidate({
    repoRoot, execDir, permit, candidate, review, repositoryLock, invocationCounters,
  });
  return { mode: "fresh", state: "COMMITTED_LOCAL_VERIFIED", completion };
}

const C3C_NOT_DISPATCHED = Object.freeze({ dispatched: false, commit_created: false });

function classifyC3cHold(e) {
  if (e instanceof C3cOperatorHoldError) return e.code;
  if (e instanceof C2dHoldError) return e.code;
  return "error";
}

function okResultC3c(base, candidateId, executionId, mode, completion) {
  return {
    ...base,
    status: mode === "reconcile" ? "recovered" : "committed",
    verdict: "OK",
    hold_code: null,
    candidate_id: candidateId,
    execution_id: executionId,
    dispatched: true,
    commit_created: true,
    commit_sha: completion.commit_sha,
    verified: completion.verified === true,
  };
}

function holdResultC3c(base, candidateId, executionId, e) {
  return {
    ...base,
    status: "hold",
    verdict: "HOLD",
    hold_code: classifyC3cHold(e),
    hold_message: e.message || String(e),
    candidate_id: candidateId ?? null,
    execution_id: executionId ?? null,
    ...C3C_NOT_DISPATCHED,
  };
}

/**
 * C3C operator entry point. Feature-gated, explicit-candidate-only, never
 * scans. Disabled (default) or no discoverable authorization -> a truthful
 * no-side-effect result, exactly like C3A's own feature-disabled short
 * circuit -- this IS the dry-run/read-only guard: it returns before any
 * lease is acquired and before either sealed C3C function is called.
 *
 * Mode-conflict guard: an explicit C3C commit-mode request while C3A's own
 * read-only feature flag is simultaneously active is a fail-closed HOLD,
 * checked here before anything else in this function -- before the
 * candidate path is even resolved against the durable store, before any
 * lease is acquired, and before either sealed C3C entry point
 * (commitMaterializedCandidate / reconcileCommitTransition) can be reached.
 * This is independent of whether C3A itself has dispatched anything; the
 * two feature flags being simultaneously active plus an explicit C3C
 * request is itself the conflict. Neither mode is silently prioritized --
 * both are rejected.
 */
export function operatorTickC3cCommit({
  repoRoot,
  checkpointRoot,
  candidatePath: candidateFilePath = null,
  actorId = "operator-tick",
  env = process.env,
  invocationCounters = null,
}) {
  const base = { stage: "c3c", feature: c3cFeatureEnabled(env) ? "enabled" : "disabled" };
  if (!c3cFeatureEnabled(env)) {
    return { ...base, status: "feature_disabled", verdict: "OK", ...C3C_NOT_DISPATCHED };
  }
  if (c3aFeatureEnabled(env)) {
    // Explicit C3C commit-mode request with C3A's read-only mode also
    // active: neither mode may proceed. Fail closed before any candidate
    // resolution, lease acquisition, or sealed C3C call below this point.
    return holdResultC3c(base, null, null, new C3cOperatorHoldError(
      C3C_OPERATOR_HOLD.MODE_CONFLICT,
      "C3A read-only mode (AURA_AUTOLOOP_C3A_C2D_READ_ONLY) and C3C explicit commit mode (--c3c-commit with AURA_AUTOLOOP_C3C_COMMIT_INTEGRATION) cannot both be active for the same invocation",
    ));
  }

  let candidateId = null;
  let executionId = null;
  let execDir = null;
  let acquired = null;
  let repositoryLock = null;
  try {
    if (typeof repoRoot !== "string" || !repoRoot) {
      throw new C3cOperatorHoldError(C3C_OPERATOR_HOLD.CANDIDATE_STRUCTURALLY_INVALID, "repoRoot required");
    }
    if (typeof checkpointRoot !== "string" || !checkpointRoot) {
      throw new C3cOperatorHoldError(C3C_OPERATOR_HOLD.CANDIDATE_STRUCTURALLY_INVALID, "checkpointRoot required");
    }
    if (typeof candidateFilePath !== "string" || !candidateFilePath) {
      throw new C3cOperatorHoldError(C3C_OPERATOR_HOLD.CANDIDATE_STRUCTURALLY_INVALID, "--candidate required for c3c-commit mode");
    }

    const resolved = resolveDurableCommitCandidate(checkpointRoot, candidateFilePath);
    execDir = resolved.execDir;
    const candidate = resolved.candidate;
    candidateId = candidate.candidate_id;
    executionId = candidate.execution_id;

    // Discovery-only: is there anything eligible at all? No lease, no
    // consumer call, no side effect below this point until proven eligible.
    const review = readDurableReviewArtifact(execDir, candidateId);
    const authExists = existsSync(join(execDir, "commit-authorization.json"));
    const current = readCurrent(execDir);
    const terminalStateReady = !!current && current.snapshot.state === "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE";
    if (!review || review.review_verdict !== "PASS" || !authExists || !terminalStateReady) {
      return { ...base, status: "no_commit_authorization", verdict: "OK", candidate_id: candidateId, execution_id: executionId, ...C3C_NOT_DISPATCHED };
    }
    if (current.snapshot.execution_id !== executionId) {
      throw new C3cOperatorHoldError(C3C_OPERATOR_HOLD.EXECUTION_IDENTITY_MISMATCH, "CURRENT execution_id does not match candidate execution_id");
    }

    const fp = collectFingerprint(repoRoot);
    // Global order: repository/common-dir lock before execution lease.
    repositoryLock = acquireRepositoryMutationLock({ gitCommonDir: fp.git_common_dir_identity, executionId, candidateId, transitionKind: "commit", repositoryIdentity: fp.repository_root_identity, targetWorktreeIdentity: fp.worktree_identity, expectedHead: fp.expected_head, actorId, sessionId: "operator-tick" });
    acquired = acquireLease(execDir, {
      execution_id: current.snapshot.execution_id,
      chain_id: current.snapshot.chain_id,
      checkpoint_id: current.snapshot.checkpoint_id,
      repository_identity: fp.repository_root_identity,
      worktree_identity: fp.worktree_identity,
      actor_id: actorId,
      expected_head: fp.expected_head,
      mutation_capability: true,
    });
    const permit = permitFromLease(execDir, acquired.lease, acquired.secrets, true);

    const dispatch = reconcileOrCommitCandidate({
      repoRoot, execDir, permit, candidate, review, repositoryLock, invocationCounters,
    });

    releaseLease(execDir, acquired.lease.lease_id, acquired.lease.lease_revision, acquired.secrets);
    acquired = null;
    repositoryLock.release();
    repositoryLock = null;
    return okResultC3c(base, candidateId, executionId, dispatch.mode, dispatch.completion);
  } catch (e) {
    if (acquired) {
      try {
        releaseLease(execDir, acquired.lease.lease_id, acquired.lease.lease_revision, acquired.secrets);
      } catch {
        // Best-effort release on the failure path; a held lease is
        // recoverable on the next tick, never a silent data loss.
      }
    }
    if (repositoryLock) { try { repositoryLock.release(); } catch {} }
    return holdResultC3c(base, candidateId, executionId, e);
  }
}

// ── C3B explicit materialization operator dispatch (feature-gated) ──
//
// Independent of C3A and C3C: dispatches the sealed C2D materialization
// consumer (reviewed-commit-candidate.mjs: materializeReviewedCandidate /
// reconcileCandidateTransition) for one already-authorized durable
// reviewed-commit candidate. It never creates, approves, or reconstructs
// authorization -- it only initiates an already-authorized durable
// transition through the sealed consumer, which remains completely
// unmodified. C3B materialization intentionally stops at
// CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE: this dispatcher never imports
// or calls commitMaterializedCandidate / reconcileCommitTransition, and
// never reads commit-authorization.json -- even when a valid commit
// authorization already exists. A separate, explicitly requested
// --c3c-commit invocation with its own independent commit authorization is
// required to commit.

export const C3B_FEATURE_ENV = "AURA_AUTOLOOP_C3B_MATERIALIZATION_INTEGRATION";

export function c3bFeatureEnabled(env = process.env) {
  // Explicit opt-in only, independent of the C3A/C3C feature flags.
  return env[C3B_FEATURE_ENV] === "1";
}

export const C3B_OPERATOR_HOLD = Object.freeze({
  CANDIDATE_PATH_NOT_CANONICAL: "HOLD / C3B_OPERATOR_CANDIDATE_PATH_NOT_CANONICAL",
  CANDIDATE_STRUCTURALLY_INVALID: "HOLD / C3B_OPERATOR_CANDIDATE_STRUCTURALLY_INVALID",
  EXECUTION_IDENTITY_MISMATCH: "HOLD / C3B_OPERATOR_EXECUTION_IDENTITY_MISMATCH",
  MATERIALIZATION_AUTHORITY_MISSING: "HOLD / C3B_OPERATOR_MATERIALIZATION_AUTHORITY_MISSING",
  MODE_CONFLICT: "HOLD / C3B_OPERATOR_MODE_CONFLICT",
});

export class C3bOperatorHoldError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "C3bOperatorHoldError";
    this.code = code;
  }
}

/**
 * Resolve an explicit --candidate path to the durable reviewed-commit
 * candidate record it must reference. Kept as its own function -- not
 * shared with resolveDurableCommitCandidate above -- so a C3B failure
 * always surfaces a C3B_OPERATOR_HOLD code and this addition never touches
 * the sealed, already-tested C3C resolver.
 */
function resolveDurableMaterializationCandidate(checkpointRoot, candidateFilePath) {
  const raw = loadCandidateFile(candidateFilePath);
  const structCheck = validateCandidate(raw);
  if (!structCheck.valid) {
    throw new C3bOperatorHoldError(
      C3B_OPERATOR_HOLD.CANDIDATE_STRUCTURALLY_INVALID,
      `candidate file structurally invalid: ${structCheck.errors.join(",")}`,
    );
  }
  const execDir = resolveExecDir(checkpointRoot, raw.execution_id);
  const canonicalPath = candidatePath(execDir, raw.candidate_id);
  let realArg, realCanonical;
  try {
    realArg = realpathSync(candidateFilePath);
    realCanonical = realpathSync(canonicalPath);
  } catch (e) {
    throw new C3bOperatorHoldError(
      C3B_OPERATOR_HOLD.CANDIDATE_PATH_NOT_CANONICAL,
      `candidate path could not be resolved against the durable store: ${e.message}`,
    );
  }
  if (realArg !== realCanonical) {
    throw new C3bOperatorHoldError(
      C3B_OPERATOR_HOLD.CANDIDATE_PATH_NOT_CANONICAL,
      "--candidate must reference the canonical durable candidate artifact for its execution_id/candidate_id, not a caller-supplied copy",
    );
  }
  const candidate = readCandidate(execDir, raw.candidate_id);
  if (!candidate) {
    throw new C3bOperatorHoldError(
      C3B_OPERATOR_HOLD.CANDIDATE_STRUCTURALLY_INVALID,
      "durable candidate artifact missing after canonical-path verification",
    );
  }
  return { execDir, candidate };
}

/**
 * Dispatch one explicit, already-authorized durable candidate to the sealed
 * C2D materialization boundary, mirroring reconcileOrCommitCandidate above
 * but accounting for a real difference in recovery shape: unlike commit
 * (which is idempotent via its own content-addressed
 * commit-completions/<idempotency-key> lookup, reached on every call
 * regardless of journal continuity), candidate_materialization bumps
 * CURRENT to an intermediate MATERIALIZATION_INTENT stage before the git
 * effect runs, so a crash that lands *after* the journal COMPLETE record is
 * durably written but *before* the final CURRENT publish leaves
 * `continuity.incompleteTail` null (the journal itself is not incomplete)
 * even though CURRENT has not caught up. Gating on the *kind* of the most
 * recent journal transition -- not merely on incompleteTail -- catches that
 * case without misreading an already-published prior *capture* transition
 * as a materialization one:
 *   - the latest journal transition (complete or incomplete) is a
 *     candidate_materialization -> reconcileCandidateTransition (crash
 *     recovery or current-only catch-up; deterministic recompute, never a
 *     second materialization).
 *   - otherwise (nothing yet, or only a candidate_capture on record) ->
 *     materializeReviewedCandidate (fresh mint).
 * Never reimplements authority validation, fingerprint collection, lock-key
 * calculation, lock reclaim, git index/worktree materialization, the
 * lifecycle transition state machine, crash recovery, or effect
 * verification -- all of that stays inside the sealed consumer.
 */
function reconcileOrMaterializeCandidate({ repoRoot, execDir, permit, candidate, review, repositoryLock, invocationCounters }) {
  const continuity = validateContinuity(execDir);
  const revision = continuity.incompleteTail ?? continuity.lastComplete;
  const latestIntent = revision ? readIntent(execDir, revision) : null;
  if (latestIntent && latestIntent.side_effect_class === "candidate_materialization") {
    const r = reconcileCandidateTransition({ repoRoot, execDir, permit, review, repositoryLock, invocationCounters });
    if (r.state === "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE" || r.state === "CURRENT_ALREADY_PUBLISHED") {
      return { mode: "reconcile", state: "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE", evidence: r.evidence || null };
    }
    // Any other reconciled state is not this dispatcher's concern; fall
    // through and let materializeReviewedCandidate's own transitionSetup
    // continuity check fail closed on it.
  }
  const completion = materializeReviewedCandidate({
    repoRoot, execDir, permit, candidate, review, repositoryLock, invocationCounters,
  });
  return { mode: "fresh", state: completion.state, evidence: completion.evidence || null };
}

const C3B_NOT_DISPATCHED = Object.freeze({ dispatched: false, materialized: false });

function classifyC3bHold(e) {
  if (e instanceof C3bOperatorHoldError) return e.code;
  if (e instanceof C2dHoldError) return e.code;
  return "error";
}

function okResultC3b(base, candidateId, executionId, mode, r) {
  return {
    ...base,
    status: mode === "reconcile" ? "recovered" : "materialized",
    verdict: "OK",
    hold_code: null,
    candidate_id: candidateId,
    execution_id: executionId,
    dispatched: true,
    materialized: true,
    state: r.state,
    candidate_tree: r.evidence?.candidate_tree ?? null,
  };
}

function holdResultC3b(base, candidateId, executionId, e) {
  return {
    ...base,
    status: "hold",
    verdict: "HOLD",
    hold_code: classifyC3bHold(e),
    hold_message: e.message || String(e),
    candidate_id: candidateId ?? null,
    execution_id: executionId ?? null,
    ...C3B_NOT_DISPATCHED,
  };
}

/**
 * C3B operator entry point. Feature-gated, explicit-candidate-only, never
 * scans. Disabled (default) -> a truthful OK/feature_disabled no-side-effect
 * result, before any lease is acquired and before either sealed
 * materialization entry point is called -- this IS the dry-run/read-only
 * guard. Unlike C3C's own "nothing to do yet" OK short-circuit, a missing,
 * invalid, expired, or mismatched materialization authorization HOLDs here
 * (per this card's boundary, §12) rather than returning OK -- still always
 * before any lease is acquired and before either sealed materialization
 * entry point is called.
 *
 * Mode-conflict guard: an explicit C3B materialize-mode request while
 * either C3A's read-only feature flag or C3C's commit feature flag is
 * simultaneously active is a fail-closed HOLD, checked here before
 * anything else -- before the candidate path is resolved against the
 * durable store, before any lease is acquired, and before either sealed
 * materialization entry point can be reached.
 *
 * This function never imports or calls commitMaterializedCandidate,
 * reconcileCommitTransition, or anything that reads
 * commit-authorization.json -- C3B invocation stops at
 * CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE and never reads or consumes
 * commit authorization, even when one already exists.
 */
export function operatorTickC3bMaterialize({
  repoRoot,
  checkpointRoot,
  candidatePath: candidateFilePath = null,
  actorId = "operator-tick",
  env = process.env,
  invocationCounters = null,
}) {
  const base = { stage: "c3b", feature: c3bFeatureEnabled(env) ? "enabled" : "disabled" };
  if (!c3bFeatureEnabled(env)) {
    return { ...base, status: "feature_disabled", verdict: "OK", ...C3B_NOT_DISPATCHED };
  }
  if (c3aFeatureEnabled(env)) {
    return holdResultC3b(base, null, null, new C3bOperatorHoldError(
      C3B_OPERATOR_HOLD.MODE_CONFLICT,
      "C3A read-only mode (AURA_AUTOLOOP_C3A_C2D_READ_ONLY) and C3B explicit materialization mode (--c3b-materialize with AURA_AUTOLOOP_C3B_MATERIALIZATION_INTEGRATION) cannot both be active for the same invocation",
    ));
  }
  if (c3cFeatureEnabled(env)) {
    return holdResultC3b(base, null, null, new C3bOperatorHoldError(
      C3B_OPERATOR_HOLD.MODE_CONFLICT,
      "C3C commit mode (AURA_AUTOLOOP_C3C_COMMIT_INTEGRATION) and C3B explicit materialization mode (--c3b-materialize with AURA_AUTOLOOP_C3B_MATERIALIZATION_INTEGRATION) cannot both be active for the same invocation",
    ));
  }

  let candidateId = null;
  let executionId = null;
  let execDir = null;
  let acquired = null;
  let repositoryLock = null;
  try {
    if (typeof repoRoot !== "string" || !repoRoot) {
      throw new C3bOperatorHoldError(C3B_OPERATOR_HOLD.CANDIDATE_STRUCTURALLY_INVALID, "repoRoot required");
    }
    if (typeof checkpointRoot !== "string" || !checkpointRoot) {
      throw new C3bOperatorHoldError(C3B_OPERATOR_HOLD.CANDIDATE_STRUCTURALLY_INVALID, "checkpointRoot required");
    }
    if (typeof candidateFilePath !== "string" || !candidateFilePath) {
      throw new C3bOperatorHoldError(C3B_OPERATOR_HOLD.CANDIDATE_STRUCTURALLY_INVALID, "--candidate required for c3b-materialize mode");
    }

    const resolved = resolveDurableMaterializationCandidate(checkpointRoot, candidateFilePath);
    execDir = resolved.execDir;
    const candidate = resolved.candidate;
    candidateId = candidate.candidate_id;
    executionId = candidate.execution_id;

    // Unlike C3C's own "nothing to do yet" OK short-circuit above (a
    // routine, expected polling state for an as-yet-unapproved commit),
    // this card's boundary (§12) requires missing/invalid/expired/
    // mismatched materialization authority to HOLD with zero effect, not
    // report a quiet OK. This is only an existence pre-check (is there a
    // PASS review artifact and an authorization file at all?), which lets
    // this HOLD before ever acquiring the repository lock or a lease --
    // it is never a stand-in for real authority validation. Every other
    // check (schema, expiry, binding to this exact candidate/repository/
    // tree/head) stays inside the sealed consumer's own
    // requireReviewerArtifact / readMaterializationAuthorization, reached
    // below; this function never reimplements that validation.
    const review = readDurableReviewArtifact(execDir, candidateId);
    const authExists = existsSync(materializationAuthorizationPath(execDir));
    if (!review || review.review_verdict !== "PASS" || !authExists) {
      throw new C3bOperatorHoldError(C3B_OPERATOR_HOLD.MATERIALIZATION_AUTHORITY_MISSING, "no PASS review artifact and/or no materialization authorization exists for this candidate");
    }
    if (!existsSync(currentPath(execDir))) {
      throw new C3bOperatorHoldError(C3B_OPERATOR_HOLD.CANDIDATE_STRUCTURALLY_INVALID, "no CURRENT checkpoint state exists for this candidate's execution");
    }
    const current = readCurrent(execDir);
    if (current.snapshot.execution_id !== executionId) {
      throw new C3bOperatorHoldError(C3B_OPERATOR_HOLD.EXECUTION_IDENTITY_MISMATCH, "CURRENT execution_id does not match candidate execution_id");
    }
    if (current.snapshot.state === "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE" && current.snapshot.last_completed_transition) {
      // Already materialized: report truthfully, never re-attempt the git
      // mutation (a second attempt would also fail closed on dirty-worktree
      // drift inside assertBaselineTarget, since the prior materialization
      // deliberately leaves the worktree dirty). This is the only OK
      // short-circuit in this function, and it is a structural/idempotency
      // check (a state already reached), never a stand-in for authority
      // validation.
      return { ...base, status: "already_complete", verdict: "OK", candidate_id: candidateId, execution_id: executionId, dispatched: false, materialized: true, state: current.snapshot.state };
    }

    const fp = collectFingerprint(repoRoot);
    // Global order: repository/common-dir lock before execution lease,
    // exactly mirroring the C3C dispatcher above.
    repositoryLock = acquireRepositoryMutationLock({ gitCommonDir: fp.git_common_dir_identity, executionId, candidateId, transitionKind: "candidate_materialization", repositoryIdentity: fp.repository_root_identity, targetWorktreeIdentity: fp.worktree_identity, expectedHead: fp.expected_head, actorId, sessionId: "operator-tick" });
    acquired = acquireLease(execDir, {
      execution_id: current.snapshot.execution_id,
      chain_id: current.snapshot.chain_id,
      checkpoint_id: current.snapshot.checkpoint_id,
      repository_identity: fp.repository_root_identity,
      worktree_identity: fp.worktree_identity,
      actor_id: actorId,
      expected_head: fp.expected_head,
      mutation_capability: true,
    });
    const permit = permitFromLease(execDir, acquired.lease, acquired.secrets, true);

    const dispatch = reconcileOrMaterializeCandidate({
      repoRoot, execDir, permit, candidate, review, repositoryLock, invocationCounters,
    });

    releaseLease(execDir, acquired.lease.lease_id, acquired.lease.lease_revision, acquired.secrets);
    acquired = null;
    repositoryLock.release();
    repositoryLock = null;
    return okResultC3b(base, candidateId, executionId, dispatch.mode, dispatch);
  } catch (e) {
    if (acquired) {
      try {
        releaseLease(execDir, acquired.lease.lease_id, acquired.lease.lease_revision, acquired.secrets);
      } catch {
        // Best-effort release on the failure path; a held lease is
        // recoverable on the next tick, never a silent data loss.
      }
    }
    if (repositoryLock) { try { repositoryLock.release(); } catch {} }
    return holdResultC3b(base, candidateId, executionId, e);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────

function emit(obj) {
  console.log(JSON.stringify(obj));
}

function parseArgs(argv) {
  const a = {
    candidate: null, checkpointRoot: null, repoRoot: null, actorId: "operator-tick",
    metadataDir: null, lockFile: null, fakeEventsFile: null,
    chainTimeout: null, staleLockTtl: null, c3cCommit: false, c3bMaterialize: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) {
        console.error(`ERROR: ${arg} requires a value`);
        process.exit(2);
      }
      return argv[++i];
    };
    if (arg === "--candidate") a.candidate = next();
    else if (arg === "--checkpoint-root") a.checkpointRoot = next();
    else if (arg === "--repo-root") a.repoRoot = next();
    else if (arg === "--actor-id") a.actorId = next();
    else if (arg === "--metadata-dir") a.metadataDir = next();
    else if (arg === "--lock-file") a.lockFile = next();
    else if (arg === "--fake-events-file") a.fakeEventsFile = next();
    else if (arg === "--chain-timeout") a.chainTimeout = next();
    else if (arg === "--stale-lock-ttl") a.staleLockTtl = next();
    else if (arg === "--c3c-commit") a.c3cCommit = true;
    else if (arg === "--c3b-materialize") a.c3bMaterialize = true;
    else if (arg === "--card-state" || arg === "--debug") {
      console.error(`ERROR: '${arg}' is forbidden in the operator command`);
      process.exit(2);
    } else {
      console.error(`ERROR: unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return a;
}

function delegateLegacy(a) {
  // Standalone checkouts (see AUTOLOOP_STANDALONE_COPY_AND_BOOTSTRAP) do not
  // carry scheduler-tick-dry.mjs. Without this guard, spawnSync would still
  // launch node against a nonexistent module path and let it crash with a
  // raw "Cannot find module" stack on inherited stderr; check up front and
  // fail closed with a deterministic reason instead, preserving the same
  // exit code the shell wrapper already uses for this condition.
  if (!existsSync(SCHEDULER)) {
    console.error(`UNSUPPORTED_STANDALONE_LEGACY_SCHEDULER: scheduler tick not found at ${SCHEDULER}`);
    return 4;
  }
  const args = [];
  if (a.metadataDir) args.push("--metadata-dir", a.metadataDir);
  if (a.lockFile) args.push("--lock-file", a.lockFile);
  if (a.fakeEventsFile) args.push("--fake-events-file", a.fakeEventsFile);
  if (a.chainTimeout != null) args.push("--chain-timeout", String(a.chainTimeout));
  if (a.staleLockTtl != null) args.push("--stale-lock-ttl", String(a.staleLockTtl));
  const r = spawnSync(process.execPath, [SCHEDULER, ...args], { stdio: "inherit" });
  return r.status == null ? 4 : r.status;
}

function main() {
  const a = parseArgs(process.argv.slice(2));

  // Structural conflict: both explicit mutation-mode flags requested in the
  // same invocation. Rejected before either C3B or C3C code runs -- this is
  // the CLI-level half of the "same-invocation materialize+commit" ban;
  // operatorTickC3bMaterialize's own env-flag guard below is the other half.
  if (a.c3bMaterialize && a.c3cCommit) {
    emit({
      stage: "c3b",
      feature: c3bFeatureEnabled() ? "enabled" : "disabled",
      status: "hold",
      verdict: "HOLD",
      hold_code: C3B_OPERATOR_HOLD.MODE_CONFLICT,
      hold_message: "--c3b-materialize and --c3c-commit cannot both be requested in the same invocation",
      dispatched: false,
      materialized: false,
    });
    process.exit(5);
  }

  // C3B is likewise a hard, structural fork, mirroring --c3c-commit below:
  // it short-circuits before any C3A or legacy-scheduler code runs, and
  // C3A's own dispatch/eligibility logic is untouched by this branch.
  if (a.c3bMaterialize) {
    if (!a.candidate) {
      console.error("ERROR: --c3b-materialize requires --candidate");
      process.exit(2);
    }
    if (!a.checkpointRoot || !a.repoRoot) {
      console.error("ERROR: --checkpoint-root and --repo-root are REQUIRED with --c3b-materialize");
      process.exit(2);
    }
    const c3bResult = operatorTickC3bMaterialize({
      repoRoot: a.repoRoot,
      checkpointRoot: a.checkpointRoot,
      candidatePath: a.candidate,
      actorId: a.actorId,
    });
    emit(c3bResult);
    process.exit(c3bResult.verdict === "OK" ? 0 : 5);
  }

  // C3C is a hard, structural fork: --c3c-commit short-circuits before any
  // C3A or legacy-scheduler code runs, so C3A's own dispatch/eligibility
  // logic below is untouched by this branch. This branch order alone is
  // NOT the conflict guard, though -- it only stops C3A code from also
  // running; it does nothing about C3A's read-only mode being active
  // while C3C explicit commit mode is requested. That conflict is
  // detected and rejected explicitly, inside operatorTickC3cCommit
  // itself, before any candidate resolution or lease acquisition.
  if (a.c3cCommit) {
    if (!a.candidate) {
      console.error("ERROR: --c3c-commit requires --candidate");
      process.exit(2);
    }
    if (!a.checkpointRoot || !a.repoRoot) {
      console.error("ERROR: --checkpoint-root and --repo-root are REQUIRED with --c3c-commit");
      process.exit(2);
    }
    const c3cResult = operatorTickC3cCommit({
      repoRoot: a.repoRoot,
      checkpointRoot: a.checkpointRoot,
      candidatePath: a.candidate,
      actorId: a.actorId,
    });
    emit(c3cResult);
    process.exit(c3cResult.verdict === "OK" ? 0 : 5);
  }

  const enabled = c3aFeatureEnabled();
  const hasLegacyArgs = !!(a.metadataDir && a.lockFile);

  if (!a.candidate) {
    emit({
      stage: "c3a",
      feature: enabled ? "enabled" : "disabled",
      status: enabled ? "no_candidate" : "feature_disabled",
      dispatched: false,
      legacy_delegated: hasLegacyArgs,
    });
    if (hasLegacyArgs) process.exit(delegateLegacy(a));
    console.error("ERROR: nothing to do (no --candidate and no legacy --metadata-dir/--lock-file)");
    process.exit(2);
  }

  if (!enabled) {
    // Feature disabled: legacy behavior only. The candidate is NOT dispatched
    // and no C2D state is created or touched.
    emit({
      stage: "c3a",
      feature: "disabled",
      status: "feature_disabled",
      dispatched: false,
      legacy_delegated: hasLegacyArgs,
    });
    if (hasLegacyArgs) process.exit(delegateLegacy(a));
    process.exit(0);
  }

  if (!a.checkpointRoot || !a.repoRoot) {
    console.error("ERROR: --checkpoint-root and --repo-root are REQUIRED with --candidate");
    process.exit(2);
  }

  const result = operatorTickC2dReadOnly({
    repoRoot: a.repoRoot,
    checkpointRoot: a.checkpointRoot,
    candidatePath: a.candidate,
    actorId: a.actorId,
  });
  emit(result);
  process.exit(result.verdict === "OK" ? 0 : 5);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
