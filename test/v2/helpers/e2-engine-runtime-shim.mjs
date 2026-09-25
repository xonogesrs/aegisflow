// test/v2/helpers/e2-engine-runtime-shim.mjs
//
// E2 REBOOT SOAK — engine-mode runtime shim (NEW file; E2-owned).
//
// Card: AUTOLOOP-V1-STAGE-F-P5-SOAK-E2-IMPLEMENTATION-1. This module exists
// for exactly one frozen purpose: the corpus's CONTINUATION legs run the
// production durable state machine with deterministic in-engine adapter
// factories (resumeDurableGraph's existing factory seam), and the production
// graph runner unconditionally calls the runtime-lifecycle seams
// (ensureInstance / resolveInstance / cleanupStale / worktree prep) BEFORE
// any phase dispatch. On this colima-less host those seams cannot execute
// (E1's disclosed environment failure), and the sealed E1 isolation shim
// (helpers/e1-runtime-shim.mjs) REFUSES them by design — it must not be
// modified (E1 protected bytes).
//
// Therefore E2 provides ITS OWN resolve redirect installed ONLY inside E2's
// spawned worker processes (never the harness process, never any E1 run),
// mapping the runtime module to THIS module. Like the E1 shim it performs
// ZERO VM lifecycle: it never starts/stops/probes a VM, never runs a
// container, never touches docker/colima binaries. Unlike the E1 shim it
// reports the NOT-CREATED state honestly (`ensureInstance` resolves the
// test-owned profile as "not pre-existing / REUSE") so the graph runner's
// no-factory cleanup path can complete without inventing a machine. Every
// execution that would actually require a VM (runTask with a real command)
// still REFUSES fail-closed — E2's phases never execute through the VM path,
// so the refusal is unreachable in the corpus.
//
// Import-surface parity with src/runtime/colima-runtime.mjs (the named
// imports of its three graph-path consumers: colima-graph-runner.mjs,
// colima-executor-adapter.mjs, colima-worktree.mjs) plus the object-shaped
// fields read through the namespace import.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const COLIMA_BIN = "/opt/homebrew/bin/colima";
export const DOCKER_BIN = "/opt/homebrew/bin/docker";
export const TEST_IMAGE = "e2-engine-image";
export const CARD_LABEL = "e2-engine";
export const AUTOLOOP_TEST_PROFILES = ["autoloop-c3", "autoloop-graph"];
export const INSTANCE_ACTION = Object.freeze({ REUSE: "reuse", START: "start", RECONCILE: "reconcile", HOLD: "hold" });

export class ColimaRuntimeError extends Error {
  constructor(message, options) { super(message, options); this.name = "ColimaRuntimeError"; }
}

const NOT_CREATED = {
  socket: "unix:///e2-engine-not-created",
  ok: false,
  serverVersion: "",
  error: "e2 engine mode: instance never created (no VM lifecycle in ANY process)",
};

export function instanceSocket(profile) { return "unix:///e2-engine-not-created/" + profile + "/docker.sock"; }

export function runSync() { return { status: 1, stdout: "", stderr: "e2-engine: no machine" }; }

export function resolveInstance() { return { ...NOT_CREATED }; }

export function limaRuntimeYamlPath(profile) { return "/e2-engine-not-created/" + profile + "/lima.yaml"; }

export function normalizeMountPath(p) { return String(p); }

export function parseLimaMounts() { return []; }

export function mountFingerprint(m) { return m; }

export function runtimeMountFingerprint() { return null; }

export function listInstances() { return [{ profile: "autoloop-graph", status: "Stopped", disk: "20GiB" }]; }

// planInstanceAction: the graph runner's readiness ladder asks what to do
// about the instance. Engine mode answers "nothing to do" (REUSE) for the
// test-owned profiles and refuses to mutate anything else — no START is
// ever issued, no machine is touched.
export function planInstanceAction({ profile } = {}) {
  if (!AUTOLOOP_TEST_PROFILES.includes(profile)) {
    return { action: INSTANCE_ACTION.HOLD, holdCode: "COLIMA_PROFILE_NOT_TEST_OWNED", reason: `profile ${profile} is not an AegisFlow-owned ephemeral test profile` };
  }
  return { action: INSTANCE_ACTION.REUSE, holdCode: null, reason: "e2 engine mode: zero VM lifecycle" };
}

export function assertSingleWritableMount(m) { return m[0]; }

export function roundTripProbe() { return { ok: false, error: "e2-engine: no machine to probe" }; }

// ensureInstance: engine mode never creates a machine. The instance is
// reported as NOT pre-existing so the runner's cleanup never tries to delete
// a shared machine; no lifecycle call is made in either direction.
export function ensureInstance() {
  return { profile: "autoloop-graph", engineMode: true, created: false, ready: false, socket: NOT_CREATED.socket };
}

// Profile single-flight lock (AUTOLOOP_BACKGROUND_WAITER_COALESCING_AND_
// PROFILE_SINGLEFLIGHT_1): inert under E2 engine mode — zero VM lifecycle
// means zero profile contention; no real lock file is created or consulted.
export const COLIMA_PROFILE_LOCK_HOLD = Object.freeze({
  BUSY: "HOLD / COLIMA_PROFILE_BUSY",
  NOT_TEST_OWNED: "HOLD / COLIMA_PROFILE_LOCK_NOT_TEST_OWNED",
  RECLAIM_UNPROVEN: "HOLD / COLIMA_PROFILE_LOCK_RECLAIM_UNPROVEN",
  RELEASE_OWNER_MISMATCH: "HOLD / COLIMA_PROFILE_LOCK_RELEASE_OWNER_MISMATCH",
});
export function colimaProfileLockPath(profile) { return "/e2-engine-not-created/autoloop-locks/colima-profile-" + profile + ".lock"; }
export function acquireColimaProfileLock({ profile = "autoloop-graph" } = {}) {
  return { profile, path: colimaProfileLockPath(profile), record: {}, reclaimed: false, release() { return { durability_capability: "full", durability_reasons: [] }; } };
}

export function stopInstance() { /* zero VM lifecycle under E2 */ }

export function deleteInstance() { /* zero VM lifecycle under E2 */ }

export function assertMountAllowlist() { /* engine mode: no containers, mounts never used */ }

export function dockerBaseArgs(socket) { return ["--host", socket]; }

// runTask: the REAL container execution path. Unreachable in the E2 corpus
// (phases run through injected deterministic adapters), so a call here is a
// corpus bug and fails closed loudly.
export function runTask() { throw new ColimaRuntimeError("e2: runTask refused — engine mode never executes container workloads"); }

export function cleanupContainer() { return { removed: 0 }; }

export function containerState() { return "absent"; }

export function cleanupStale() { return { found: 0, removed: [] }; }

export function dirname(p) { return p.replace(/\/[^/]*$/, ""); }

export function ensureScratchRoot(scratchRoot) { mkdirSync(scratchRoot, { recursive: true }); return scratchRoot; }

// ── worktree seams (imported by src/runtime/colima-worktree.mjs consumers —
//    the graph runner imports prepareWorktree/verifyWorktree/revokeWorktree/
//    captureWorktreeOutput from colima-worktree.mjs, which itself imports
//    colima-runtime; the runner also imports them directly) ──────────────────

export function prepareWorktree({ sourceRepo, scratchRoot, taskId }) {
  const wtDir = mkdtempSync(join(tmpdir(), `e2-engine-wt-${taskId}-`));
  // A real git worktree add would touch the source repo's admin files; the
  // engine-mode leg's writer phases never execute (deterministic adapters),
  // so the worktree only needs to EXIST as a directory for the durable
  // worktree-info bookkeeping. It is a disposable temp dir, removed with the
  // fixture namespace. No repo mutation.
  mkdirSync(join(wtDir, "scratch"), { recursive: true });
  const r = spawnSync("git", ["-C", sourceRepo, "rev-parse", "HEAD"], { encoding: "utf8" });
  return {
    worktreeDir: wtDir,
    cloneDir: wtDir,
    taskId,
    baseCommit: r.status === 0 ? r.stdout.trim() : null,
    head: r.status === 0 ? r.stdout.trim() : null,
    verified: { ok: true, mode: "e2-engine-no-worktree" },
  };
}

export function verifyWorktree(wt) { return { ok: true, mode: "e2-engine-no-worktree", worktreeDir: wt?.worktreeDir ?? null }; }

export function revokeWorktree(wt) { return { revoked: Boolean(wt?.worktreeDir) }; }

export function captureWorktreeOutput() { return null; }

export { mkdirSync, mkdtempSync };

/**
 * The resolve-hook object (module.registerHooks shape) for E2 worker
 * processes: redirects colima-runtime.mjs AND colima-worktree.mjs to the
 * E2 engine-mode modules — EXCEPT the modules' own self-references (the
 * token guard) — so the production graph stack runs with zero VM lifecycle.
 * Registered INSIDE the spawned leg before the production tree links.
 */
export function runtimeEngineHooks({ runtimeShimUrl, worktreeShimUrl }) {
  if (typeof runtimeShimUrl !== "string" || typeof worktreeShimUrl !== "string") {
    throw new TypeError("runtimeEngineHooks: both shim URLs required");
  }
  return {
    resolve(specifier, context, nextResolve) {
      const s = String(specifier);
      if (s.endsWith("colima-runtime.mjs") && !s.includes("e2-engine-runtime-shim")) {
        return { url: runtimeShimUrl, shortCircuit: true };
      }
      if (s.endsWith("colima-worktree.mjs") && !s.includes("e2-engine-runtime-shim")) {
        return { url: worktreeShimUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  };
}
