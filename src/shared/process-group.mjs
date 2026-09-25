// src/shared/process-group.mjs
//
// Task-scoped process-group ownership.
//
// WHY THIS MODULE EXISTS
// Every AegisFlow adapter that runs an external process must, on
// timeout/cancel/HOLD, terminate not just the process it spawned but every
// descendant that process created. Terminating only the leader leaves
// descendants reparented to init, still consuming CPU and — when they inherit
// the stdio pipes — still blocking the caller. That was observed as a real
// leak: a verification command's `sleep 900` grandchild survived its leader's
// SIGKILL with PPID 1, and kept the stdout/stderr pipes open so the caller
// hung for 60s against a 2s timeout.
//
// The convention, defined here so the repaired seams share one implementation
// instead of a third and fourth hand-rolled copy:
//
//   spawn with `detached: true`  -> the child becomes its own process group
//                                   leader (pgid == pid)
//   terminate with `process.kill(-pid, signal)` -> signals the WHOLE group
//   fall back to `child.kill(signal)` for the leader, and treat ESRCH as
//   success (the group is already gone)
//
// c2d/mutation-run.mjs and adapter/pi-rpc-adapter.mjs already implement this
// pattern inline and are intentionally left as-is; they are the reference the
// repaired seams were aligned to.
//
// SAFETY: a negative pid is only ever sent for children this module itself
// spawned detached, tracked in GROUP_LEADERS. That is what guarantees
// `process.kill(-pid)` can never address AegisFlow's own process group or any
// foreign process group.

import { spawn } from "node:child_process";

/** Children spawned by this module as detached group leaders. */
const GROUP_LEADERS = new WeakSet();

/** Grace before escalating SIGTERM -> SIGKILL. */
export const DEFAULT_TERMINATION_GRACE_MS = 300;
/** Second grace: SIGTERM -> SIGKILL window. */
export const DEFAULT_ESCALATION_MS = 300;
/** Bounded reap slack after SIGKILL, so a stdio-holding descendant cannot hang the caller. */
export const DEFAULT_REAP_SLACK_MS = 250;

/** Total bounded cleanup window for the default escalation ladder. */
export const DEFAULT_TERMINATION_BUDGET_MS =
  DEFAULT_TERMINATION_GRACE_MS + DEFAULT_ESCALATION_MS + DEFAULT_REAP_SLACK_MS;

/**
 * Spawn a task-scoped child as its own process-group leader.
 * Identical to `spawn` plus `detached: true`, with the child registered so
 * `signalProcessGroup` is allowed to address its group.
 */
export function spawnTaskScoped(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: true });
  GROUP_LEADERS.add(child);
  return child;
}

/** True once the child has been reaped (exit or signal observed). */
export function hasExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}

/**
 * Signal the whole process group of a task-scoped child, falling back to the
 * leader. ESRCH (group or process already gone) is success, never an error.
 *
 * Returns { group, delivered }:
 *   group     — the signal was addressed to the process group
 *   delivered — at least one signal was accepted by the OS
 */
export function signalProcessGroup(child, signal = "SIGKILL") {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return { group: false, delivered: false };
  // Negative-pid group signalling is POSIX-only, and only safe for a child we
  // spawned detached (its pgid is its own pid).
  if (process.platform !== "win32" && GROUP_LEADERS.has(child)) {
    try {
      process.kill(-pid, signal);
      return { group: true, delivered: true };
    } catch {
      // ESRCH: the group is already gone — fall through and let the leader
      // call report `delivered: false`. EPERM and friends: still try the
      // leader rather than give up.
    }
  }
  try {
    const delivered = child.kill(signal);
    return { group: false, delivered: delivered !== false };
  } catch {
    return { group: false, delivered: false }; // already reaped
  }
}

/**
 * Escalating, bounded termination of a task-scoped child and its descendants.
 *
 *   graceMs     quiet window before the first signal
 *   escalation  SIGTERM -> SIGKILL window
 *   reapSlackMs bounded window after SIGKILL before resolving anyway
 *
 * Never rejects and never hangs: the promise resolves by `exit` or, failing
 * that, at `graceMs + escalation + reapSlackMs` — independent of whether a
 * descendant keeps the stdio pipes open.
 */
export function terminateProcessGroup(child, {
  graceMs = DEFAULT_TERMINATION_GRACE_MS,
  escalation = DEFAULT_ESCALATION_MS,
  reapSlackMs = DEFAULT_REAP_SLACK_MS,
} = {}) {
  return new Promise((resolveTermination) => {
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
      resolveTermination({ processTreeKilled: false, reason: "no_child" });
      return;
    }
    // A reaped leader does NOT imply a reaped group: descendants that were
    // reparented to init keep the group alive (and keep inherited stdio pipes
    // open). Signal the group unconditionally, then report.
    if (hasExited(child)) {
      const { group } = signalProcessGroup(child, "SIGKILL");
      resolveTermination({ processTreeKilled: group, reason: "leader_already_exited" });
      return;
    }
    // Immediate termination: signal synchronously so a caller that returns
    // (or exits) right after cannot outrun the teardown. The slack timer is
    // unref'd: callers are not required to await this promise, so it must
    // never hold the event loop open.
    if (graceMs <= 0 && escalation <= 0) {
      const killed = signalProcessGroup(child, "SIGKILL");
      const slack = setTimeout(() => resolveTermination({ processTreeKilled: killed.group, reason: "killed_immediately" }), reapSlackMs);
      slack.unref?.();
      return;
    }

    let killedGroup = false;
    let done = false;
    let slackTimer = null;
    let termTimer = null;
    let killTimer = null;
    const finish = (info) => {
      if (done) return;
      done = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(slackTimer);
      resolveTermination(info);
    };

    // The child exiting on its own is the fast path.
    child.once("exit", () => finish({ processTreeKilled: killedGroup, reason: "exited" }));

    termTimer = setTimeout(() => {
      killedGroup = signalProcessGroup(child, "SIGTERM").group || killedGroup;
    }, graceMs);

    killTimer = setTimeout(() => {
      killedGroup = signalProcessGroup(child, "SIGKILL").group || killedGroup;
      slackTimer = setTimeout(() => finish({ processTreeKilled: killedGroup, reason: "killed" }), reapSlackMs);
    }, graceMs + escalation);
  });
}