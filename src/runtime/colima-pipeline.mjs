// src/runtime/colima-pipeline.mjs
//
// C3 Colima isolated-writer pipeline — the OFFICIAL entry path for running
// Colima-backed tasks through AutoLoop's lifecycle runner. Read-only tasks
// and isolated-worktree writer tasks BOTH flow through this module; nothing
// calls the bake-off test runner directly anymore.
//
// Responsibilities (all enforced, never assumed):
//   1. pinned instance/socket: ensureInstance on the dedicated profile with
//      an EXPLICIT mount list (repo ro + scratch rw); every docker call in
//      the executor adapter uses the pinned socket, never implicit context.
//   2. worktree lifecycle: writer tasks get a dedicated worktree created,
//      bound (verified), and revoked automatically; the source repo is only
//      ever read.
//   3. official lifecycle: runLifecycle() with the Colima executor adapter +
//      deterministic reviewer; mutation-scope gate is attached to the worktree
//      (writer) or the repo (readonly) so the OFFICIAL scope machinery proves
//      "only the designated worktree changed" / "repo untouched".
//   4. deterministic cleanup: containers cleaned (label-scoped, idempotent)
//      and worktree revoked on every path — PASS, HOLD, exception.
//   5. structured result with execution identity for later review/repair/
//      scheduler consumption.
//
// Parallel writers / scheduler are NOT part of this card (single writer per
// run; one dedicated instance).

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { runLifecycle } from "../lifecycle-runner.mjs";
import { captureScopeSnapshot } from "../c2d/mutation-scope.mjs";
import { phaseExecutionId, deriveScopePatterns } from "../v2/phase-task-card.mjs";
import {
  ensureInstance,
  resolveInstance,
  cleanupStale,
  instanceSocket,
  CARD_LABEL,
} from "./colima-runtime.mjs";
import { acquireColimaProfileLock } from "./colima-profile-lock.mjs";
import { createColimaExecutorAdapter } from "./colima-executor-adapter.mjs";
import { createColimaReviewerAdapter } from "./colima-reviewer-adapter.mjs";
import {
  prepareWorktree,
  verifyWorktree,
  captureWorktreeOutput,
  revokeWorktree,
  WorktreeError,
} from "./colima-worktree.mjs";

export const C3_PIPELINE_PHASE_ID = "c3-phase";
export const C3_RESULT_SCHEMA = "autoloop.c3.colima-task-result/v1";

export class ColimaPipelineError extends Error {
  constructor(reason, details) {
    super(`colima_pipeline: ${reason}`);
    this.name = "ColimaPipelineError";
    this.reason = reason;
    this.details = details;
  }
}

/**
 * Run one Colima task through the official AutoLoop lifecycle.
 *
 * @param {object} opts
 * @param {object} opts.taskCard — { id?, executionId?, runtime: { mode,
 *   command, taskId?, network?, limits?, expect? } }
 * @param {string} opts.profile — dedicated Colima instance profile
 * @param {string} opts.repoPath — read-only source repo (mount allowlist)
 * @param {string} opts.scratchRoot — writable scratch root (mount allowlist)
 * @param {number} [opts.maxRepairAttempts=1]
 * @param {number} [opts.timeoutMs=90000]
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.hooks]
 * @returns {Promise<object>} structured result (C3_RESULT_SCHEMA)
 */
export async function runColimaTask({
  taskCard,
  profile = "autoloop-c3",
  repoPath,
  scratchRoot,
  maxRepairAttempts = 1,
  timeoutMs = 90000,
  signal,
  hooks = {},
}) {
  if (!repoPath || !scratchRoot) throw new ColimaPipelineError("repoPath and scratchRoot required");
  // VCA-1 Phase 0D: this is the OFFICIAL production entrypoint (run:c3);
  // timeoutMs ultimately reaches a real `docker kill` in colima-runtime.mjs's
  // runTask, but only if it is actually a finite positive number — an
  // unparsed CLI flag (Number("abc") => NaN) or a caller passing 0/negative
  // must fail closed here rather than silently produce an unbounded or
  // effectively-instant timeout further down the call chain.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ColimaPipelineError(`invalid_timeout_ms: ${String(timeoutMs)}`);
  }
  const runtime = taskCard.runtime ?? {};
  const mode = runtime.mode ?? "readonly";
  if (!["readonly", "writer"].includes(mode)) throw new ColimaPipelineError(`unsupported mode ${mode}`);
  const runExecutionId = taskCard.executionId ?? `c3-${randomUUID()}`;
  const phaseId = taskCard.phaseId ?? C3_PIPELINE_PHASE_ID;
  const phaseExecId = phaseExecutionId(runExecutionId, phaseId);
  const startedAt = new Date().toISOString();

  // ── F/G single-flight (AUTOLOOP_BACKGROUND_WAITER_COALESCING_AND_PROFILE_
  // SINGLEFLIGHT_1): the profile lock is held from BEFORE the instance
  // reconcile (any colima start/stop) until the terminal cleanup completes.
  const profileLock = acquireColimaProfileLock({ profile, actorId: runExecutionId, sessionId: `pid:${process.pid}` });
  try {
  // 1. pinned instance with explicit mounts (repo ro + scratch rw; NO whole-$HOME)
  const instance = ensureInstance({ profile, cpus: 2, memory: 2, disk: 20, roMounts: [repoPath], rwMounts: [scratchRoot] });

  let worktree = null;
  let lifecycle = null;
  let result = null;
  try {
    // 2. worktree lifecycle (writer only; source is read-only)
    if (mode === "writer") {
      worktree = prepareWorktree({ sourceRepo: repoPath, scratchRoot, taskId: runtime.taskId ?? runExecutionId });
      runtime.worktreePath = worktree.worktreeDir;
      runtime.cloneDir = worktree.cloneDir;
      const verified = verifyWorktree(worktree);
      if (!verified.ok) {
        throw new WorktreeError("worktree verification failed", verified);
      }
      runtime.worktreeVerified = verified;
    } else {
      runtime.scratchPath = join(scratchRoot, runExecutionId, "scratch");
      mkdirSync(runtime.scratchPath, { recursive: true });
    }

    // 3. build the official task card for lifecycle-runner.mjs
    const repositoryRoot = mode === "writer" ? worktree.worktreeDir : repoPath;
    const allowedPaths = mode === "writer" ? ["*"] : [];
    const fullCard = {
      id: taskCard.id ?? runExecutionId,
      phaseId,
      executionId: phaseExecId,
      parentExecutionId: runExecutionId,
      repositoryRoot,
      allowedPaths,
      runtime,
      // writer phases require system-observed test evidence (harness gate)
      verificationCommand: mode === "writer" ? ["git", "status", "--porcelain"] : null,
      expectedExecutorModel: "colima-container",
      expectedReviewerModel: "deterministic-c3",
      mutationScope: {
        repositoryRoot,
        baselineSnapshot: captureScopeSnapshot(repositoryRoot),
        allowedPaths: deriveScopePatterns(allowedPaths),
        forbiddenPaths: [],
      },
    };

    // 4. official lifecycle (executor + deterministic reviewer adapters)
    const executorAdapter = createColimaExecutorAdapter({ profile, repoPath, scratchRoot });
    const reviewerAdapter = createColimaReviewerAdapter();
    lifecycle = await runLifecycle({
      cwd: repoPath,
      taskCard: fullCard,
      executorAdapter,
      reviewerAdapter,
      maxRepairAttempts,
      timeoutMs,
      abortSignal: signal,
      hooks: {
        onExecutorOutput: (info) => hooks.onExecutorOutput?.(info),
        onExecutorCompleted: (info) => hooks.onExecutorCompleted?.(info),
        onReviewerCompleted: (info) => hooks.onReviewerCompleted?.(info),
        onRepairRequested: (info) => hooks.onRepairRequested?.(info),
        onSystemDeltaReady: (info) => hooks.onSystemDeltaReady?.(info),
      },
    });

    // 5. structured result (captured BEFORE worktree revocation)
    const output = mode === "writer"
      ? { worktree: captureWorktreeOutput(worktree), worktreeVerified: runtime.worktreeVerified }
      : { scratchProbe: runtime.lastExecutorResult?.stdout ?? "" };
    result = {
      schema: C3_RESULT_SCHEMA,
      cardId: taskCard.cardId ?? "AUTOLOOP-PI-GRAPH-C3-COLIMA-ISOLATED-WRITER-1",
      mode,
      executionId: runExecutionId,
      phaseExecutionId: phaseExecId,
      final: lifecycle.final,
      attempt: lifecycle.attempt,
      reason: lifecycle.reason ?? null,
      classification: lifecycle.classification ?? null,
      instance: { profile, socket: instanceSocket(profile), serverVersion: instance.serverVersion },
      task: { id: fullCard.id, command: runtime.command, expect: runtime.expect ?? null },
      output,
      transitions: lifecycle.transitions ?? [],
      startedAt,
      completedAt: new Date().toISOString(),
      cleanup: null, // filled in finally
    };
  } finally {
    // 6. deterministic cleanup on EVERY path (PASS / HOLD / exception)
    let worktreeRevoked = false;
    try {
      if (worktree) {
        revokeWorktree(worktree);
        worktreeRevoked = true;
      }
    } catch (e) {
      worktreeRevoked = false;
    }
    const stale = cleanupStale(profile);
    if (result) {
      result.cleanup = {
        worktreeRevoked,
        containersFound: stale.found,
        containersRemoved: stale.removed,
        instanceAlive: resolveInstance(profile).ok,
      };
    }
  }
  return result;
  } finally {
    // Profile is free exactly when instance + container work is done.
    try {
      profileLock.release();
    } catch (e) {
      if (result && typeof result === "object") {
        result.profileLockRelease = { ok: false, holdCode: e.code ?? null, reason: String(e?.message ?? e).slice(0, 200) };
      }
    }
  }
}

export { CARD_LABEL };
