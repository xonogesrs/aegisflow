// C3B controlled mutation boundary — orchestrator.
//
// Mirrors read-only-discovery-run.mjs's shape (acquireLease -> publishIntent
// -> gated work -> publishComplete -> publishCurrent -> releaseLease) but for
// an authorized, scope-fenced, isolated-worktree mutation instead of
// read-only discovery. Never commits, pushes, or seals — the terminal
// success state is READY_FOR_REVIEW / AWAITING_COMMIT_APPROVAL only.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { C2dHoldError, fireHook } from "./fs-atomic.mjs";
import { mintExecutionId, mintChainId, mintCheckpointId, mintTransitionId, validateExecutionId } from "./execution-id.mjs";
import { collectFingerprint } from "./fingerprint.mjs";
import { acquireLease, releaseLease, readLease } from "./lease.mjs";
import { permitFromLease } from "./permit.mjs";
import { initExecutionDir, publishCurrent, readCurrent } from "./checkpoint-store.mjs";
import { publishIntent, publishComplete, validateContinuity } from "./journal.mjs";
import { reconcileMutationIntent } from "./reconcile.mjs";
import { authorizeMutation, C3B_HOLD, assertValidationPlan } from "./mutation-authority.mjs";
import { captureScopeSnapshot, enforceScopeGate } from "./mutation-scope.mjs";
import { verifyWriteContainment } from "./write-containment.mjs";
import { captureReviewedCandidate, buildCandidateReviewerHandoff } from "./reviewed-commit-candidate.mjs";
import { acquireRepositoryMutationLock } from "./repository-mutation-lock.mjs";

export { C3B_HOLD };

// ---------- bounded validation / mutation-command runner ----------

function buildAllowedEnv(envAllowlist) {
  const env = {};
  const allow = new Set(["PATH", ...(Array.isArray(envAllowlist) ? envAllowlist : [])]);
  for (const key of allow) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return env;
}

/**
 * Run one exact-argv command with a hard wall-clock timeout and real
 * process-tree termination (detached process group, SIGKILL of the whole
 * group on timeout). Never uses a shell string.
 */
export function runBoundedCommand(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 60000;
    const env = buildAllowedEnv(opts.envAllowlist);
    let child;
    try {
      child = spawn(cmd, Array.isArray(args) ? args : [], {
        cwd: opts.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolvePromise({
        command: [cmd, ...(args || [])].join(" "), exit_code: null, stdout: "", stderr: "",
        timed_out: false, error: e.message, process_tree_killed: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let processTreeKilled = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      fireHook("before_process_tree_kill");
      try {
        process.kill(-child.pid, "SIGKILL");
        processTreeKilled = true;
      } catch {
        try { child.kill("SIGKILL"); } catch { /* best-effort */ }
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        command: [cmd, ...(args || [])].join(" "), exit_code: null,
        stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 20000),
        timed_out: timedOut, error: err.message, process_tree_killed: processTreeKilled,
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        command: [cmd, ...(args || [])].join(" "), exit_code: code, signal,
        stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 20000),
        timed_out: timedOut, process_tree_killed: processTreeKilled,
      });
    });
  });
}

export async function runValidationPlan(authorization, validationPlanId, validationPlan, cwd) {
  assertValidationPlan(authorization, validationPlanId);
  const results = [];
  for (const step of (validationPlan?.commands || [])) {
    const r = await runBoundedCommand(step.cmd, step.args || [], {
      cwd, timeoutMs: step.timeout_ms, envAllowlist: step.env_allowlist,
    });
    results.push({ ...r, required: step.required !== false });
  }
  const environmentFailure = results.some((r) => r.error && !r.timed_out);
  const validationFailed = !environmentFailure && results.some((r) => r.required && r.exit_code !== 0);
  return { results, environmentFailure, validationFailed };
}

// ---------- isolation ----------

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

export function createIsolatedWorktree(repoRoot, headSha) {
  const tmpBase = mkdtempSync(join(tmpdir(), "aura-c3b-"));
  const worktreePath = join(tmpBase, "wt");
  const r = git(["worktree", "add", "--detach", worktreePath, headSha], repoRoot);
  if (r.status !== 0) {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw new C2dHoldError(C3B_HOLD.ENVIRONMENT_FAILURE, `git worktree add failed: ${r.stderr || ""}`);
  }
  return { worktreePath, tmpBase };
}

export function removeIsolatedWorktree(repoRoot, worktreePath, tmpBase) {
  // TEST-ONLY injection: force a rollback failure to prove the fail-closed
  // path (ROLLBACK_FAILED / FAIL_CLOSED). Gated behind the same
  // AURA_TEST_HARNESS_ALLOWED convention already used by run-card.mjs's
  // writeRepairLoopFacts test-only injection.
  if (process.env.AURA_TEST_HARNESS_ALLOWED === "1" && process.env.AURA_TEST_C3B_FORCE_ROLLBACK_FAILURE === "1") {
    return { ok: false, stillListed: true, dirRemoved: false, gitStatus: -1, forced: true };
  }
  const r1 = git(["worktree", "remove", "--force", worktreePath], repoRoot);
  let dirRemoved = true;
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch { dirRemoved = false; }
  const list = git(["worktree", "list", "--porcelain"], repoRoot);
  const stillListed = (list.stdout || "").includes(worktreePath);
  const ok = r1.status === 0 && dirRemoved && !stillListed && !existsSync(worktreePath);
  return { ok, stillListed, dirRemoved, gitStatus: r1.status };
}

// ---------- evidence / reviewer handoff ----------

export function patchIdentity(diffText) {
  return createHash("sha256").update(diffText || "").digest("hex");
}

export function buildReviewerHandoff(evidenceBundle) {
  const handoff = {
    execution_id: evidenceBundle.execution_id,
    baseline_identity: evidenceBundle.baseline,
    changed_paths: evidenceBundle.changed_paths,
    patch_identity: evidenceBundle.patch_identity,
    diff: evidenceBundle.diff,
    scope_checks: evidenceBundle.scope_checks,
    validation_outputs: evidenceBundle.validation_results,
    failure_evidence: evidenceBundle.failure_evidence || null,
    authority_lineage: evidenceBundle.authority_lineage,
    unresolved_warnings: evidenceBundle.unresolved_warnings || [],
  };
  // Candidate facts are optional for legacy mutation-only callers. New C3B
  // candidate runs always set them before reviewer dispatch.
  return evidenceBundle.candidate ? buildCandidateReviewerHandoff(evidenceBundle.candidate, handoff) : Object.freeze(handoff);
}

export function validateReviewerHandoff(handoff, expectedExecutionId, expectedPatchIdentity) {
  if (!handoff || handoff.execution_id !== expectedExecutionId) {
    throw new C2dHoldError(C3B_HOLD.REVIEWER_HANDOFF_IDENTITY_MISMATCH,
      "reviewer handoff execution_id mismatch");
  }
  if (handoff.patch_identity !== expectedPatchIdentity) {
    throw new C2dHoldError(C3B_HOLD.REVIEWER_HANDOFF_IDENTITY_MISMATCH,
      "reviewer handoff patch_identity mismatch");
  }
  return true;
}

/**
 * PASS from an independent reviewer may only ever advance the lifecycle to
 * AWAITING_COMMIT_APPROVAL — never to a committed/pushed/sealed state.
 */
export function applyReviewerVerdict(handoff, expectedExecutionId, expectedPatchIdentity, verdict) {
  validateReviewerHandoff(handoff, expectedExecutionId, expectedPatchIdentity);
  if (verdict !== "PASS") {
    return { state: "REVIEW_HOLD", commit_authorized: false, push_authorized: false, seal_authorized: false };
  }
  return { state: "AWAITING_COMMIT_APPROVAL", commit_authorized: false, push_authorized: false, seal_authorized: false };
}

// ---------- snapshot helpers ----------

function buildInitialSnapshot(fields) {
  const now = new Date().toISOString();
  return {
    format_version: "1.0.0",
    checkpoint_id: fields.checkpoint_id,
    revision: 0,
    execution_id: fields.execution_id,
    chain_id: fields.chain_id,
    phase: "C3B_MUTATION",
    stage: "READY",
    state: "READY",
    c2d_control_state: "READY",
    created_at: now,
    updated_at: now,
    repository_fingerprint: fields.repository_fingerprint,
    repository_root_identity: fields.repository_root_identity,
    git_common_dir_identity: fields.git_common_dir_identity,
    expected_head: fields.expected_head,
    expected_ref: fields.expected_ref,
    origin_url: fields.origin_url || "",
    origin_master: fields.origin_master || "",
    expected_worktree_state: fields.expected_worktree_state,
    execution_affinity: "SAME_WORKTREE_REQUIRED",
    current_owner_actor: fields.current_owner_actor || null,
    lease_identity: fields.lease_identity || null,
    last_completed_transition: null,
    next_transition_candidate: { value: "MUTATION", advisory_only: true, not_authorization: true },
    input_manifest: fields.input_manifest || {},
    checkpoint_integrity: { algorithm: "sha256", digest_basis: "external_current_file" },
    dirty_state_policy: "isolated_worktree_mutation",
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

/**
 * Full C3B mutation run. Never commits/pushes/seals. Terminal outcome is
 * always one of the card §7/§17 lifecycle or failure states, recorded both
 * in the journal complete record (`outcome_state`) and the next CURRENT
 * snapshot (`state` / `c2d_control_state`).
 */
export async function runMutation({
  repoRoot, checkpointRoot, actorId = "c3b-executor", sessionId, sessionSecret, leaseSecret,
  executionId, chainId, checkpointId,
  authorization, validationPlanId, validationPlan,
  mutationCommand,
  inputManifest = {},
}) {
  if (authorization !== undefined) {
    throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_INVALID, "inline authorization forbidden; durable canonical artifact required");
  }
  const fp = collectFingerprint(repoRoot);
  if (fp.dirty) {
    throw new C2dHoldError(C3B_HOLD.ENVIRONMENT_FAILURE, "C3B requires a clean worktree at start");
  }

  const execId = validateExecutionId(executionId || mintExecutionId());
  const execDir = initExecutionDir(checkpointRoot, execId);
  // Global order: common-dir serialization before execution-local lease.
  // Hold across mutation and optional candidate capture: C3C never sees
  // partial C3B repository state.
  const repositoryLock = acquireRepositoryMutationLock({
    gitCommonDir: fp.git_common_dir_identity,
    executionId: execId,
    transitionKind: "candidate_materialization",
    repositoryIdentity: fp.repository_root_identity,
    targetWorktreeIdentity: fp.worktree_identity,
    expectedHead: fp.expected_head,
    actorId,
    sessionId,
  });
  try {

  const cont0 = validateContinuity(execDir);
  const existingLease = readLease(execDir);
  if (cont0.incompleteTail != null && existingLease && existingLease.released_at == null) {
    if (!sessionSecret || !leaseSecret || !sessionId) {
      throw new C2dHoldError(C3B_HOLD.RECOVERY_REQUIRED, "active mutation lease; session secrets required to continue");
    }
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
    mutation_capability: true,
  });
  const lease = acquired.lease;
  const secrets = acquired.secrets;

  // Bootstrap permit for checkpoint bookkeeping only (initial snapshot /
  // crash-tail reconciliation) — NOT the single-use mutation authorization.
  // Reconciling a crash must never require (or consume) a fresh
  // authorization: the authorization for this transition was already spent
  // by the attempt that crashed. Only a genuinely fresh transition consumes
  // `authorization` below.
  const bootstrapPermit = permitFromLease(execDir, lease, secrets, true);

  let current = readCurrentSafe(execDir);
  if (!current) {
    const initial = buildInitialSnapshot({
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
      input_manifest: inputManifest,
    });
    current = publishCurrent(execDir, initial, { expectedRevision: 0, permit: bootstrapPermit });
  }

  const cont = validateContinuity(execDir);
  if (cont.incompleteTail != null) {
    return finishReconcileMutation({
      execDir, execId, lease, secrets, actorId, repoRoot,
      incompleteTail: cont.incompleteTail,
    });
  }

  const authResult = authorizeMutation(execDir, undefined, {
    executionId: execId,
    repositoryIdentity: fp.repository_root_identity,
    gitCommonDir: fp.git_common_dir_identity,
    targetRef: fp.expected_ref,
    headSha: fp.expected_head,
    lease,
    secrets,
  });
  const permit = permitFromLease(execDir, lease, secrets, true);
  const durableAuthorization = authResult.authority;

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
    to_stage: "MUTATION",
    from_state: current.snapshot.state,
    to_state: "MUTATION_COMPLETE",
    actor_id: actorId,
    timestamp: new Date().toISOString(),
    side_effect_class: "mutation",
    expected_revision_before: expectedRevisionBefore,
    authorization_digest: authResult.authorityDigest,
    card_id: durableAuthorization.card_id,
    card_revision: durableAuthorization.card_revision,
    allowed_paths: durableAuthorization.allowed_paths,
    forbidden_paths: durableAuthorization.forbidden_paths,
  };
  fireHook("before_c3b_publish_intent");
  const intentPub = publishIntent(execDir, intent, permit);
  fireHook("after_c3b_publish_intent_before_worktree");

  const lifecycle = [{ state: "MUTATION_AUTHORIZED", at: new Date().toISOString() }];
  const gates = [];
  let outcomeState;
  let evidence = null;
  let candidate = null;
  let candidateCaptureArgs = null;
  let worktree = null;
  let rollback = null;
  let preserveWorktreeForCandidateRecovery = false;

  try {
    worktree = createIsolatedWorktree(repoRoot, fp.expected_head);
    lifecycle.push({ state: "BASELINE_CAPTURED", at: new Date().toISOString() });
    const baseline = captureScopeSnapshot(worktree.worktreePath);

    // ── WRITE CONTAINMENT — pre-execution, git-independent ────────────────
    // The post-mutation scope gate below iterates git's changed-path delta. A
    // write THROUGH a pre-existing symlink produces NO changed path, so that
    // gate can never see it. Audit the MATERIALIZED filesystem before anything
    // is dispatched: if the isolated worktree can redirect a write outside the
    // authorized root (a symlink — resolvable or dangling — on the write path,
    // or a symlink component of a declared writable boundary), nothing runs at
    // all. This is what makes the denial PRE-WRITE rather than post-hoc.
    const preContainment = verifyWriteContainment({
      root: worktree.worktreePath,
      boundaries: durableAuthorization.allowed_paths,
    });
    gates.push({ gate: "pre_mutation_write_containment", ok: preContainment.ok, violations: preContainment.violations });

    let mutationExec = { ran: false };
    let postMutation = baseline;
    let preGate = { ok: true, delta: [], violations: [] };
    let validation = { results: [], environmentFailure: false, validationFailed: false };

    if (!preContainment.ok) {
      outcomeState = "SCOPE_VIOLATION";
    } else {
      lifecycle.push({ state: "MUTATING", at: new Date().toISOString() });
      if (mutationCommand) {
        mutationExec = await runBoundedCommand(mutationCommand.cmd, mutationCommand.args || [], {
          cwd: worktree.worktreePath,
          timeoutMs: mutationCommand.timeout_ms,
          envAllowlist: mutationCommand.env_allowlist,
        });
      }
      postMutation = captureScopeSnapshot(worktree.worktreePath);
      preGate = enforceScopeGate(worktree.worktreePath, baseline, postMutation, durableAuthorization.allowed_paths, durableAuthorization.forbidden_paths);
      gates.push({ gate: "post_mutation", ok: preGate.ok, violations: preGate.violations });

      // ── WRITE CONTAINMENT — post-execution, git-independent ─────────────
      // Re-audit the materialized filesystem. A symlink created or swapped in
      // by the mutation itself is caught here even if git reports no changed
      // path for the write it mediated; the run fails closed.
      const postContainment = verifyWriteContainment({
        root: worktree.worktreePath,
        boundaries: durableAuthorization.allowed_paths,
      });
      gates.push({ gate: "post_mutation_write_containment", ok: postContainment.ok, violations: postContainment.violations });

      if (!preGate.ok || !postContainment.ok) {
        outcomeState = "SCOPE_VIOLATION";
      } else if (mutationCommand && mutationExec.error && !mutationExec.timed_out) {
        outcomeState = "ENVIRONMENT_FAILURE";
      } else if (mutationCommand && mutationExec.timed_out) {
        outcomeState = "MUTATION_FAILED";
      } else if (mutationCommand && mutationExec.exit_code !== 0) {
        outcomeState = "MUTATION_FAILED";
      } else {
        lifecycle.push({ state: "MUTATION_COMPLETE", at: new Date().toISOString() });
        fireHook("after_c3b_mutation_before_validation");
        lifecycle.push({ state: "VALIDATING", at: new Date().toISOString() });
        validation = validationPlan
          ? await runValidationPlan(durableAuthorization, validationPlanId, validationPlan, worktree.worktreePath)
          : { results: [], environmentFailure: false, validationFailed: false };
        const postValidation = captureScopeSnapshot(worktree.worktreePath);
        // Zero-tolerance gate: validation (and any background process) must not
        // change anything at all — no allowlist applies here, unlike the
        // post-mutation gate above.
        const postValidationGate = enforceScopeGate(worktree.worktreePath, postMutation, postValidation, [], []);
        gates.push({ gate: "post_validation", ok: postValidationGate.ok, violations: postValidationGate.violations });

        if (!postValidationGate.ok) {
          outcomeState = "SCOPE_VIOLATION";
        } else if (validation.environmentFailure) {
          outcomeState = "ENVIRONMENT_FAILURE";
        } else if (validation.validationFailed) {
          outcomeState = "VALIDATION_FAILED";
        } else {
          lifecycle.push({ state: "READY_FOR_REVIEW", at: new Date().toISOString() });
          outcomeState = "READY_FOR_REVIEW";
          // Candidate lineage is supplied only by Controller integration. Old
          // mutation-only callers remain supported; they cannot claim a
          // reviewed commit candidate without this durable lineage.
          if (inputManifest?.reviewed_candidate === true) {
            // C3B mutation transition must complete first. Candidate capture is
            // next independent C2D transition; keep source worktree until its
            // COMPLETE + CURRENT CAS has succeeded.
            preserveWorktreeForCandidateRecovery = true;
            const lineage = inputManifest.candidate_lineage || {};
            candidateCaptureArgs = {
              repoRoot, sourceWorktree: worktree.worktreePath, execDir, permit,
              authorization: durableAuthorization, sourceCheckpointRevision: expectedRevisionBefore,
              authorityRecordDigest: lineage.authority_record_digest,
              executionContextDigest: lineage.execution_context_digest,
              mutationAuthorityDigest: authResult.authorityDigest,
              expiresAt: lineage.expires_at,
            };
          }
        }
      }
    }

    // Evidence is recorded for EVERY terminal state of the attempt — a scope
    // or containment refusal must carry the gate that denied it, never be
    // indistinguishable from "no attempt was made".
    const diff = git(["diff", fp.expected_head, "--", "."], worktree.worktreePath).stdout || "";
    evidence = {
      execution_id: execId,
      card_id: durableAuthorization.card_id,
      card_revision: durableAuthorization.card_revision,
      baseline: {
        repo: repoRoot, branch: fp.expected_ref, head: fp.expected_head,
        origin: fp.origin_url, dirty: false,
      },
      changed_paths: preGate.delta,
      diff,
      patch_identity: patchIdentity(diff),
      scope_checks: gates,
      validation_results: validation.results,
      failure_evidence: outcomeState === "READY_FOR_REVIEW" ? null : { outcome_state: outcomeState, gates },
      authority_lineage: {
        lease_id: lease.lease_id, lease_revision: lease.lease_revision,
        authority_digest: authResult.authorityDigest,
      },
      candidate,
      unresolved_warnings: [],
    };
  } catch (e) {
    // Only C2dHoldError instances represent an expected, classifiable
    // operational failure (e.g. worktree creation environment failure). Any
    // other error is treated as an unexpected crash: it propagates uncaught
    // (after cleanup in `finally`) so the journal is left with INTENT and no
    // COMPLETE — the durable, deterministic signal for crash recovery via
    // reconcileMutationIntent on the next run, rather than a silently
    // "graceful" completion that would hide the crash.
    if (!(e instanceof C2dHoldError)) {
      throw e;
    }
    outcomeState = "ENVIRONMENT_FAILURE";
    evidence = {
      execution_id: execId, card_id: durableAuthorization.card_id, card_revision: durableAuthorization.card_revision,
      baseline: { repo: repoRoot, head: fp.expected_head }, changed_paths: [], diff: "",
      patch_identity: patchIdentity(""), scope_checks: gates,
      validation_results: [], failure_evidence: { error: e.message, code: e.code }, unresolved_warnings: [],
    };
  } finally {
    if (worktree && !preserveWorktreeForCandidateRecovery) {
      rollback = removeIsolatedWorktree(repoRoot, worktree.worktreePath, worktree.tmpBase);
      if (!rollback.ok && outcomeState !== "READY_FOR_REVIEW") {
        outcomeState = "ROLLBACK_FAILED";
      } else if (!rollback.ok) {
        evidence.unresolved_warnings.push("isolated_worktree_cleanup_incomplete");
      }
    }
  }

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
    to_state: intent.to_state,
    actor_id: actorId,
    timestamp: new Date().toISOString(),
    side_effect_class: "mutation",
    expected_revision_before: expectedRevisionBefore,
    outcome_state: outcomeState,
    lifecycle_transitions: lifecycle,
    intent_digest: intentPub.digest,
  };
  const completePub = publishComplete(execDir, completeRecord, intentPub.digest, permit);

  const nextSnapshot = {
    ...current.snapshot,
    revision: nextRev,
    stage: "MUTATION",
    state: outcomeState,
    c2d_control_state: outcomeState,
    last_completed_transition: transitionId,
    next_transition_candidate: (outcomeState === "READY_FOR_REVIEW" || outcomeState === "CANDIDATE_VERIFIED")
      ? { value: "AWAITING_COMMIT_APPROVAL", advisory_only: true, not_authorization: true }
      : { value: "NONE", advisory_only: true, not_authorization: true },
    current_owner_actor: actorId,
    lease_identity: lease.lease_id,
    input_manifest: { ...inputManifest, evidence },
  };
  const published = publishCurrent(execDir, nextSnapshot, { expectedRevision: expectedRevisionBefore, permit });
  // Candidate capture follows prior mutation COMPLETE/CURRENT. This ordering
  // leaves recoverable source reality if process dies during capture.
  if (candidateCaptureArgs) {
    candidateCaptureArgs.sourceCheckpointRevision = published.snapshot.revision;
    candidate = captureReviewedCandidate(candidateCaptureArgs);
    evidence.candidate = candidate;
    outcomeState = "CANDIDATE_VERIFIED";
    lifecycle.push({ state: "CANDIDATE_VERIFIED", at: new Date().toISOString() });
    rollback = removeIsolatedWorktree(repoRoot, worktree.worktreePath, worktree.tmpBase);
    preserveWorktreeForCandidateRecovery = false;
    if (!rollback.ok) evidence.unresolved_warnings.push("isolated_worktree_cleanup_pending");
  }
  const released = releaseLease(execDir, lease.lease_id, lease.lease_revision, secrets);

  const evidenceBundle = evidence;
  const reviewerHandoff = evidenceBundle ? buildReviewerHandoff(evidenceBundle) : null;

  return {
    execution_id: execId, execDir, lease, secrets, released,
    intent: intentPub, complete: completePub, snapshot: published,
    outcome_state: outcomeState, evidence: evidenceBundle, reviewer_handoff: reviewerHandoff,
    rollback, mode: "fresh",
  };
  } finally {
    repositoryLock.release();
  }
}

function finishReconcileMutation({ execDir, execId, lease, secrets, actorId, repoRoot, incompleteTail }) {
  const result = reconcileMutationIntent(execDir, {
    leaseId: lease.lease_id,
    actorId,
    leaseRevision: lease.lease_revision,
    secrets,
    revision: incompleteTail,
    reRunGate: () => ({ observed_at: new Date().toISOString(), classification: "RECOVERY_REQUIRED" }),
    buildCompleteRecord: ({ intent }) => ({
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
      to_state: intent.to_state,
      actor_id: actorId,
      timestamp: new Date().toISOString(),
      side_effect_class: "mutation",
      expected_revision_before: intent.expected_revision_before,
      outcome_state: "RECOVERY_REQUIRED",
      lifecycle_transitions: [{ state: "RECOVERY_REQUIRED", at: new Date().toISOString() }],
      intent_digest: "",
    }),
    buildSnapshot: ({ previous, revision, intent }) => ({
      ...previous,
      revision,
      stage: "MUTATION",
      state: "RECOVERY_REQUIRED",
      c2d_control_state: "RECOVERY_REQUIRED",
      last_completed_transition: intent.transition_id,
      next_transition_candidate: { value: "NONE", advisory_only: true, not_authorization: true },
      current_owner_actor: actorId,
      lease_identity: lease.lease_id,
    }),
  });
  const released = releaseLease(execDir, lease.lease_id, lease.lease_revision, secrets);
  return {
    execution_id: execId, execDir, lease, secrets, released,
    outcome_state: "RECOVERY_REQUIRED", mode: "reconcile", result,
  };
}

export { mintExecutionId, collectFingerprint };
