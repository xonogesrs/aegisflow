// src/runtime/colima-runtime.mjs
//
// Colima runtime adapter for AutoLoop.
//
// Guarantees enforced here (and asserted by tests):
//   1. Pinned instance + socket: every docker invocation uses
//      `docker --host unix://~/.colima/<profile>/docker.sock` explicitly.
//      Never inherits the shell's implicit docker context / DOCKER_HOST.
//   2. Explicit mount allowlist: only allowlisted source paths (read-only)
//      and scratch paths under scratchRoot (read-write) may be mounted.
//      Whole-$HOME auto-mount is never relied upon.
//   3. Isolated task containers: network none, --cap-drop ALL,
//      --security-opt no-new-privileges, pids/memory/cpu limits,
//      runtime socket never mounted into a task container.
//   4. Timeout / cancel / crash cleanup with idempotence (label-scoped).
//
// Authority-free: this module only produces well-formed outcomes; judgment
// (PASS/REPAIR/HOLD, evidence trustworthiness) belongs to the caller.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const COLIMA_BIN = "/opt/homebrew/bin/colima";
export const DOCKER_BIN = "/opt/homebrew/bin/docker";
export const TEST_IMAGE =
  "docker.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce";
export const CARD_LABEL = "autoloop.card=colima-autoloop-real-integration";

export class ColimaRuntimeError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ColimaRuntimeError";
    this.details = details;
  }
}

export function instanceSocket(profile) {
  return `unix://${process.env.HOME}/.colima/${profile}/docker.sock`;
}

export function runSync(bin, args, { env = process.env } = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// Instance management (pinned)
// ---------------------------------------------------------------------------

export function resolveInstance(profile) {
  const socket = instanceSocket(profile);
  const r = runSync(DOCKER_BIN, ["--host", socket, "info", "--format", "{{.ServerVersion}}"]);
  return {
    socket,
    ok: r.status === 0,
    serverVersion: r.stdout.trim(),
    error: r.status === 0 ? null : r.stderr.trim(),
  };
}

/**
 * Start (create if needed) an AutoLoop-dedicated Colima instance with an
 * explicit mount set. Passing mounts explicitly REPLACES the default whole-$HOME
 * mount in Colima, so the caller must list every needed path (repo ro + scratch rw).
 */
export function ensureInstance({ profile, cpus = 2, memory = 2, disk = 20, roMounts = [], rwMounts = [], socketReadyMs = 45000 }) {
  const args = ["start", "--profile", profile, "--cpu", String(cpus), "--memory", String(memory), "--disk", String(disk)];
  for (const m of roMounts) args.push("--mount", m);
  for (const m of rwMounts) args.push("--mount", `${m}:w`);
  runSync(COLIMA_BIN, args, { log: true });
  // colima start can return before the in-VM docker engine socket is ready;
  // retry the pinned-socket check（never implicit context）until ready.
  const deadline = Date.now() + socketReadyMs;
  let resolved = resolveInstance(profile);
  while (!resolved.ok && Date.now() < deadline) {
    runSync("/bin/sleep", ["1"]);
    resolved = resolveInstance(profile);
  }
  if (!resolved.ok) {
    throw new ColimaRuntimeError(
      `instance ${profile} not reachable on pinned socket ${resolved.socket}: ${resolved.error}`,
    );
  }
  return resolved;
}

export function stopInstance(profile) {
  return runSync(COLIMA_BIN, ["stop", "--profile", profile]);
}

export function deleteInstance(profile) {
  const r = runSync(COLIMA_BIN, ["delete", profile, "-f"]);
  // colima/lima can leave ssh-mux hostagent processes behind after delete;
  // remove them so a subsequent instance start does not hit port/state
  // conflicts from the deleted instance.
  runSync("/usr/bin/pkill", ["-f", `colima-${profile}`]);
  return r;
}

// ---------------------------------------------------------------------------
// Mount allowlist
// ---------------------------------------------------------------------------

/**
 * Assert every mount source is inside the allowlist:
 *   - read-only mounts: source must equal one of repoPaths
 *   - read-write mounts: source must be inside scratchRoot
 * Anything else -> ColimaRuntimeError (fail closed).
 */
export function assertMountAllowlist({ roMounts = [], rwMounts = [], repoPaths = [], scratchRoot }) {
  if (!scratchRoot) throw new ColimaRuntimeError("scratchRoot required");
  for (const m of roMounts) {
    if (!repoPaths.includes(m.source)) {
      throw new ColimaRuntimeError(`read-only mount ${m.source} not in repo allowlist ${JSON.stringify(repoPaths)}`);
    }
  }
  for (const m of rwMounts) {
    const inside = m.source === scratchRoot || m.source.startsWith(`${scratchRoot}/`);
    if (!inside) {
      throw new ColimaRuntimeError(`read-write mount ${m.source} outside scratchRoot ${scratchRoot}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Task execution (isolated containers, timeout / cancel, cleanup)
// ---------------------------------------------------------------------------

export function dockerBaseArgs(profile) {
  return ["--host", instanceSocket(profile)];
}

/**
 * Run a task in an isolated container on the pinned instance.
 * Returns { status: completed|timed_out|aborted|error, exitCode, signal,
 *           stdout, stderr, containerName, latencyMs, terminatedBy }.
 * `command` runs via `sh -c` inside the image.
 */
export function runTask({
  profile,
  executionId,
  taskId,
  image = TEST_IMAGE,
  command,
  roMounts = [],
  rwMounts = [],
  network = "none",
  cpus,
  memoryMiB,
  pidsLimit = 256,
  timeoutMs = 60000,
  abortSignal,
  extraArgs = [],
  env = {},
}) {
  return new Promise((resolve) => {
    const execId = executionId ?? taskId;
    const containerName = `autoloop-${String(execId).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40)}-${taskId}`;
    const args = [
      ...dockerBaseArgs(profile),
      "run",
      "--name", containerName,
      "--label", `autoloop.taskId=${taskId}`,
      "--label", `autoloop.executionId=${execId}`,
      "--label", CARD_LABEL,
      "--network", network,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(pidsLimit),
      "--rm",
    ];
    if (cpus) args.push("--cpus", String(cpus));
    if (memoryMiB) args.push("--memory", `${memoryMiB}m`);
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    for (const m of roMounts) args.push("-v", `${m.source}:${m.target}:ro`);
    for (const m of rwMounts) args.push("-v", `${m.source}:${m.target}`);
    args.push(...extraArgs, image, "sh", "-c", command);

    const child = spawn(DOCKER_BIN, args, { env: { ...process.env, DOCKER_HOST: instanceSocket(profile) } });
    let stdout = "";
    let stderr = "";
    let timerFired = false;
    let aborted = false;
    let settled = false;
    const startedAt = Date.now();

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortSignal?.removeEventListener) abortSignal.removeEventListener("abort", onAbort);
      result.latencyMs = Date.now() - startedAt;
      resolve(result);
    };

    const killContainer = () => {
      // docker run --rm exits once the container is killed; idempotent.
      runSync(DOCKER_BIN, [...dockerBaseArgs(profile), "kill", containerName]);
    };

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      killContainer();
    };
    if (abortSignal?.addEventListener) abortSignal.addEventListener("abort", onAbort);

    const timer = setTimeout(() => {
      if (settled) return;
      timerFired = true;
      killContainer();
    }, timeoutMs);

    child.on("error", (e) =>
      finish({ status: "error", executionId: execId, error: e.message, stdout, stderr, containerName }),
    );
    child.on("close", (code, signal) => {
      let status;
      if (timerFired) status = "timed_out";
      else if (aborted) status = "aborted";
      else status = code === 0 ? "completed" : "error";
      cleanupContainer(profile, containerName);
      finish({
        status,
        executionId: execId,
        exitCode: code,
        signal: signal ?? null,
        terminatedBy: timerFired ? "timeout" : aborted ? "cancel" : null,
        stdout,
        stderr,
        containerName,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Cleanup (idempotent, label-scoped)
// ---------------------------------------------------------------------------

export function cleanupContainer(profile, containerName) {
  return runSync(DOCKER_BIN, [...dockerBaseArgs(profile), "rm", "-f", containerName]);
}

export function containerState(profile, containerName) {
  const r = runSync(DOCKER_BIN, [...dockerBaseArgs(profile), "inspect", "--format", "{{.State.Status}}", containerName]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Remove every container tagged with the card label (stale containers from
 * crashes/timeouts/cancels). Idempotent: a second call finds 0.
 */
export function cleanupStale(profile, { label = CARD_LABEL } = {}) {
  const list = runSync(DOCKER_BIN, [...dockerBaseArgs(profile), "ps", "-aq", "--filter", `label=${label}`]);
  const ids = list.stdout.trim().split(/\s+/).filter(Boolean);
  let removed = 0;
  for (const id of ids) {
    const r = runSync(DOCKER_BIN, [...dockerBaseArgs(profile), "rm", "-f", id]);
    if (r.status === 0) removed += 1;
  }
  return { found: ids.length, removed };
}

export function ensureScratchRoot(scratchRoot) {
  mkdirSync(scratchRoot, { recursive: true });
  return scratchRoot;
}

export { dirname };
