// src/runtime/colima-runtime.mjs
//
// Colima runtime adapter for AegisFlow.
//
// Guarantees enforced here (and asserted by tests):
//   1. Pinned instance + socket: every docker invocation uses
//      `docker --host unix://$COLIMA_HOME/<profile>/docker.sock` explicitly.
//      Never inherits the shell's implicit docker context / DOCKER_HOST.
//   2. Explicit mount allowlist: only allowlisted source paths (read-only)
//      and scratch paths under scratchRoot (read-write) may be mounted.
//      Whole-$HOME auto-mount is never relied upon.
//   3. Isolated task containers: network none, --cap-drop ALL,
//      --security-opt no-new-privileges, pids/memory/cpu limits,
//      runtime socket never mounted into a task container.
//   4. Timeout / cancel / crash cleanup with idempotence (label-scoped).
//   5. NVM2T fail-closed storage gate (COLIMA-NVM2T-FAIL-CLOSED): the Colima
//      home MUST be the canonical NVM2T runtime path, verified against the
//      real mount by volume UUID. Missing/mis-mounted NVM2T, a system-disk
//      COLIMA_HOME, or a shadow mount (the gated mount name with a numeric
//      BEFORE any machine action — never mkdir ~/.colima, never fall back.
//
// Authority-free: this module only produces well-formed outcomes; judgment
// (PASS/REPAIR/HOLD, evidence trustworthiness) belongs to the caller.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  COLIMA_BIN_ENV,
  COLIMA_HOME_ENV,
  DOCKER_BIN_ENV,
  colimaMountGate,
  configuredColimaHome,
  readConfigEnv,
  resolveExecutable,
} from "../shared/autoloop-paths.mjs";

// Executable discovery: explicit env override -> PATH -> platform defaults ->
// bare name (PATH applies at spawn). No package-manager prefix is hardcoded.
export const COLIMA_BIN = resolveExecutable("colima", { envName: COLIMA_BIN_ENV });
export const DOCKER_BIN = resolveExecutable("docker", { envName: DOCKER_BIN_ENV });
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
// ---------------------------------------------------------------------------
// Colima storage gate (single seam; every path below flows through
// colimaHome(), so every consumer inherits the gate).
//
// The gate is CONFIGURATION-DRIVEN, never a hardcoded volume:
//   COLIMA_HOME                     required, absolute, outside $HOME
//   AEGISFLOW_COLIMA_MOUNT           optional: the volume the runtime must live on
//   AEGISFLOW_COLIMA_MOUNT_UUID      optional: that volume's identity (with the
//                                   mount var, enables the UUID + shadow-mount gate)
//   AEGISFLOW_COLIMA_SKIP_MOUNT_GATE optional "1": disable the volume gate
//                                   entirely (still requires an absolute,
//                                   non-$HOME COLIMA_HOME)
// Setting the two mount variables reproduces the original deployment's exact
// behavior (canonical volume + UUID + shadow-mount refusal).
// ---------------------------------------------------------------------------

export const COLIMA_SKIP_MOUNT_GATE_ENV = "AEGISFLOW_COLIMA_SKIP_MOUNT_GATE";

function isUnder(child, parent) {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * Resolve + verify the Colima home. Fail closed:
 *   - COLIMA_HOME unset, empty, or relative
 *   - COLIMA_HOME resolves to $HOME or inside $HOME
 *   - (when the mount gate is configured) a different volume is mounted at the
 *     configured mount root, its volume UUID does not match, or a shadow mount
 *     of that volume is present
 *   - the directory is absent or not writable
 * Never creates a fallback directory and never rewrites COLIMA_HOME.
 */
export function assertColimaHome({
  env = process.env,
  uuidOf = defaultUuidOf,
  volumesOf = defaultVolumesOf,
  statOf = defaultStatOf,
  accessOf = accessSync,
} = {}) {
  const raw = env?.[COLIMA_HOME_ENV] ?? "";
  if (raw !== "" && !isAbsolute(raw.trim())) {
    throw new ColimaRuntimeError(
      `HOLD COLIMA_HOME_NOT_CANONICAL: ${COLIMA_HOME_ENV} must be an absolute path (got ${JSON.stringify(raw)}); ` +
      `a relative value is never resolved against the process cwd`,
      { configured: raw },
    );
  }
  const configured = configuredColimaHome({ env });
  if (configured === null) {
    throw new ColimaRuntimeError(
      `HOLD COLIMA_HOME_NOT_CANONICAL: ${COLIMA_HOME_ENV} must be set to an absolute path` +
      `${raw ? ` (got ${JSON.stringify(raw)})` : ""}; refusing to fall back to ~/.colima or any system-disk path`,
      { configured: raw },
    );
  }
  const home = resolve(homedir());
  if (isUnder(configured, home)) {
    throw new ColimaRuntimeError(
      `HOLD COLIMA_HOME_NOT_CANONICAL: ${configured} must never resolve under $HOME (${home})`,
      { configured, home },
    );
  }
  const gate = readConfigEnv(env, COLIMA_SKIP_MOUNT_GATE_ENV)?.value.trim() === "1" ? null : colimaMountGate({ env });
  if (gate) {
    if (!isUnder(configured, gate.mount)) {
      throw new ColimaRuntimeError(
        `HOLD COLIMA_HOME_NOT_CANONICAL: ${configured} must resolve under the configured mount ${gate.mount}`,
        { configured, mount: gate.mount },
      );
    }
    const uuid = uuidOf(gate.mount);
    if (uuid !== gate.uuid) {
      throw new ColimaRuntimeError(
        `HOLD COLIMA_MOUNT_IDENTITY_FAILED: ${gate.mount} volume UUID is '${uuid ?? "none"}', ` +
        `want ${gate.uuid} — mount drifted or a wrong volume is mounted at the configured path`,
        { mount: gate.mount, uuid, want: gate.uuid },
      );
    }
    const mountName = gate.mount.split(sep).filter(Boolean).pop();
    for (const entry of volumesOf()) {
      if (entry.startsWith(mountName) && entry !== mountName) {
        throw new ColimaRuntimeError(
          `HOLD COLIMA_SHADOW_MOUNT: ${dirname(gate.mount)}/${entry} exists alongside ${gate.mount} — ` +
          `refusing to guess which volume is the real one; remount cleanly and retry`,
          { shadow: `${dirname(gate.mount)}/${entry}`, canonical: gate.mount },
        );
      }
    }
  }
  let stat = null;
  try { stat = statOf(configured); } catch { /* absent */ }
  if (!stat || !stat.isDirectory()) {
    throw new ColimaRuntimeError(
      `HOLD COLIMA_RUNTIME_HOME_UNAVAILABLE: Colima runtime directory ${configured} does not exist`,
      { configured },
    );
  }
  try { accessOf(configured, constants.W_OK | constants.X_OK); } catch (e) {
    throw new ColimaRuntimeError(
      `HOLD COLIMA_RUNTIME_HOME_UNAVAILABLE: Colima runtime directory ${configured} is not writable: ${e.message}`,
      { configured },
    );
  }
  return configured;
}

function defaultUuidOf(mount) {
  const r = spawnSync("/usr/sbin/diskutil", ["info", "-plist", mount], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const m = (r.stdout ?? "").match(/<key>VolumeUUID<\/key>\s*<string>([0-9A-Fa-f-]+)<\/string>/);
  return m ? m[1] : null;
}

function defaultVolumesOf() {
  return readdirSync("/Volumes");
}

function defaultStatOf(path) {
  return statSync(path);
}

export function instanceSocket(profile) {
  return `unix://${colimaHome()}/${profile}/docker.sock`;
}

/** Resolve the verified Colima home; throws the fail-closed HOLD on any drift. */
export function colimaHome() {
  return assertColimaHome();
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

// ---------------------------------------------------------------------------
// Mount lifecycle authority（single seam）
//
// A running Colima VM does NOT pick up colima.yaml changes: `colima start`
// on an already-running instance rewrites the yaml and reports success while
// the VM keeps its ORIGINAL mount generation. Readiness therefore requires:
//   desired mount fingerprint == runtime mount fingerprint
//   AND a bidirectional host<->guest round-trip probe.
// ---------------------------------------------------------------------------

/**
 * Profiles this repository exclusively owns as ephemeral Colima test
 * instances. Only these may ever be stopped/reconciled by this module; any
 * other profile name（including `default` and look-alike names）fails closed.
 */
export const AUTOLOOP_TEST_PROFILES = Object.freeze([
  "autoloop-graph",
  "autoloop-c3",
  "autoloop-w1",
  "autoloop-w2",
]);

export const INSTANCE_ACTION = Object.freeze({
  REUSE: "reuse",       // runtime generation matches -> never restart
  START: "start",       // instance absent/stopped -> plain canonical start
  RECONCILE: "reconcile", // verified test-owned profile with stale mounts
  HOLD: "hold",         // fail closed, no mutation
});

export function limaRuntimeYamlPath(profile) {
  return `${colimaHome()}/_lima/colima-${profile}/lima.yaml`;
}

/** Normalize a mount path: strip trailing slashes; resolve symlinks when the host path exists. */
export function normalizeMountPath(p) {
  let s = String(p);
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  try { return realpathSync(s); } catch { return s; }
}

/**
 * Parse the `mounts:` block of a lima runtime yaml — the mount generation the
 * instance was actually provisioned with. Returns [{location, writable}].
 */
export function parseLimaMounts(yamlText) {
  const mounts = [];
  let inMounts = false;
  let cur = null;
  for (const line of String(yamlText).split("\n")) {
    if (/^mounts:\s*$/.test(line)) { inMounts = true; cur = null; continue; }
    if (!inMounts) continue;
    if (/^\S/.test(line)) break; // next top-level key ends the block
    let m = line.match(/^\s+-\s+location:\s*(.+?)\s*$/);
    if (m) { cur = { location: m[1], writable: false }; mounts.push(cur); continue; }
    m = line.match(/^\s+writable:\s*(true|false)\s*$/);
    if (m && cur) cur.writable = m[1] === "true";
  }
  return mounts;
}

/**
 * Canonical mount fingerprint: normalized host realpath + per-mount mode,
 * deduplicated and stably ordered, hashed. Used for BOTH the desired set and
 * the runtime set so a comparison can never diverge on formatting.
 */
export function mountFingerprint(mounts) {
  const entries = [...new Set(mounts.map((m) =>
    `${normalizeMountPath(m.location)}|${m.writable ? "rw" : "ro"}`,
  ))].sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/** RUNTIME_MOUNT_FINGERPRINT: null when the instance has never been created. */
export function runtimeMountFingerprint(profile) {
  try {
    return mountFingerprint(parseLimaMounts(readFileSync(limaRuntimeYamlPath(profile), "utf8")));
  } catch {
    return null;
  }
}

/** Parse `colima list` rows into [{profile, status, disk}] — machine-level truth. */
export function listInstances(run = runSync) {
  const r = run(COLIMA_BIN, ["list"]);
  const out = [];
  for (const line of (r.stdout ?? "").split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6 || !cols[0] || cols[0] === "PROFILE") continue;
    // PROFILE STATUS ARCH CPUS MEMORY DISK RUNTIME ADDRESS
    out.push({ profile: cols[0], status: cols[1], disk: cols[5] });
  }
  return out;
}

/**
 * Fail-closed decision for ensureInstance. A running VM whose runtime mount
 * generation differs from the desired one is NEVER reported ready, and
 * profiles outside AUTOLOOP_TEST_PROFILES are never mutated.
 */
export function planInstanceAction({ profile, desiredFingerprint, runtimeFingerprint, running }) {
  if (!AUTOLOOP_TEST_PROFILES.includes(profile)) {
    return {
      action: INSTANCE_ACTION.HOLD,
      holdCode: "COLIMA_PROFILE_NOT_TEST_OWNED",
      reason: `profile ${profile} is not an AegisFlow-owned ephemeral test profile; refusing to mutate`,
    };
  }
  if (runtimeFingerprint === null) {
    return { action: INSTANCE_ACTION.START }; // creation through the canonical seam
  }
  if (runtimeFingerprint === desiredFingerprint) {
    return running
      ? { action: INSTANCE_ACTION.REUSE }
      : { action: INSTANCE_ACTION.START };
  }
  return { action: INSTANCE_ACTION.RECONCILE };
}

/**
 * RW mount cardinality authority（single seam）.
 *
 * Production contract is frozen at EXACTLY ONE writable scratch mount:
 *   0 mounts  -> previously produced `undefined/.autoloop-probe` side effects
 *   2+ mounts -> previously published readiness while only rwMounts[0] was
 *                ever round-trip probed（R2R finding A28）
 * Fails closed BEFORE any machine action, config write, mkdir, spawn, or
 * probe. Returns the normalized host path of the single validated mount so
 * callers can never fall back to indexing an unvalidated array.
 *
 * Entry shape: a non-empty host path string. The guest target equals the
 * host location（colima --mount <path>:w mounts location->location）and the
 * mode is rw by membership in the writable list, so a validated entry
 * carries host path + guest target + mode == rw by construction.
 */
export function assertSingleWritableMount(rwMounts) {
  if (!Array.isArray(rwMounts) || rwMounts.length !== 1) {
    const got = Array.isArray(rwMounts) ? `array(${rwMounts.length})` : typeof rwMounts;
    throw new ColimaRuntimeError(
      `HOLD COLIMA_RW_MOUNT_CARDINALITY_INVALID: exactly one writable scratch mount required, got ${got}`,
    );
  }
  const m = rwMounts[0];
  if (typeof m !== "string" || m.trim().length === 0) {
    throw new ColimaRuntimeError(
      `HOLD COLIMA_RW_MOUNT_CARDINALITY_INVALID: writable mount must be a non-empty host path, got ${JSON.stringify(m)}`,
    );
  }
  return normalizeMountPath(m);
}

/**
 * Bidirectional host<->guest visibility proof over the pinned socket:
 *   HOST_TO_GUEST: host writes a nonce under scratchRoot, guest container reads it.
 *   GUEST_TO_HOST: guest container writes a nonce, host reads it back.
 * Nonce files are transient and always removed.
 */
export function roundTripProbe({ profile, scratchRoot, image = TEST_IMAGE }) {
  // Direct-bypass hardening: the probe only ever accepts the single validated
  // writable mount path produced by assertSingleWritableMount. An array (or
  // any non-string) must never reach the mkdir/docker seam.
  if (typeof scratchRoot !== "string" || scratchRoot.trim().length === 0) {
    throw new ColimaRuntimeError(
      `HOLD COLIMA_RW_MOUNT_CARDINALITY_INVALID: roundTripProbe requires the single validated writable mount path, got ${
        Array.isArray(scratchRoot) ? `array(${scratchRoot.length})` : JSON.stringify(scratchRoot)
      }`,
    );
  }
  let h2gPath = null;
  let g2hPath = null;
  try {
    const dir = `${normalizeMountPath(scratchRoot)}/.autoloop-probe`;
    mkdirSync(dir, { recursive: true });
    const token = createHash("sha256")
      .update(`${process.pid}:${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 16);
    h2gPath = `${dir}/h2g-${token}`;
    g2hPath = `${dir}/g2h-${token}`;
    writeFileSync(h2gPath, token);
    const h2g = runSync(DOCKER_BIN, [
      ...dockerBaseArgs(profile), "run", "--rm",
      "-v", `${h2gPath}:${h2gPath}`, image, "cat", h2gPath,
    ]);
    if (h2g.status !== 0 || h2g.stdout.trim() !== token) {
      return {
        ok: false,
        direction: "HOST_TO_GUEST",
        reason: h2g.status !== 0 ? h2g.stderr.trim() : `content mismatch: ${JSON.stringify(h2g.stdout)}`,
      };
    }
    const g2h = runSync(DOCKER_BIN, [
      ...dockerBaseArgs(profile), "run", "--rm",
      "-v", `${dir}:${dir}`, image, "sh", "-c", `printf %s '${token}' > '${g2hPath}'`,
    ]);
    if (g2h.status !== 0) {
      return { ok: false, direction: "GUEST_TO_HOST", reason: g2h.stderr.trim() };
    }
    let hosted = "";
    try { hosted = readFileSync(g2hPath, "utf8"); } catch { /* missing */ }
    if (hosted !== token) {
      return { ok: false, direction: "GUEST_TO_HOST", reason: `host read ${JSON.stringify(hosted)} != nonce ${token}` };
    }
    return { ok: true, direction: "ROUND_TRIP", token };
  } catch (e) {
    return { ok: false, direction: "PROBE_SETUP", reason: e?.message ?? String(e) };
  } finally {
    try { if (h2gPath) rmSync(h2gPath, { force: true }); } catch { /* best effort */ }
    try { if (g2hPath) rmSync(g2hPath, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Start (create if needed) an AegisFlow-dedicated Colima instance with an
 * explicit mount set. Passing mounts explicitly REPLACES the default whole-$HOME
 * mount in Colima, so the caller must list every needed path (repo ro + scratch rw).
 *
 * Lifecycle contract（fail closed）:
 *   running + fingerprint match            -> reuse, NO restart
 *   running/stopped + mismatch + test-owned -> bounded stop/start reconcile
 *   mismatch + NOT test-owned               -> HOLD, zero mutation
 * Readiness is published only after the RUNNING generation equals desired AND
 * the round-trip probe passes. "already running" is never readiness.
 * Stale-inode exception: a REUSED instance whose first H2G probe fails with
 * docker's "error while creating mount source path" gets exactly ONE bounded
 * stop/start re-bind before failing closed（a host dir deleted and recreated
 * at the same path keeps the path-string fingerprint identical while the VM
 * still holds the dead directory inode）.
 */
export function ensureInstance({ profile, cpus = 2, memory = 2, disk = 20, roMounts = [], rwMounts = [], socketReadyMs = 45000, deps = {}, env = process.env }) {
  // A28 repair: cardinality authority runs BEFORE any machine action
  // (listInstances / colima start|stop), config write, mkdir, spawn, or probe.
  // COLIMA-NVM2T-FAIL-CLOSED: verify the canonical NVM2T runtime home BEFORE
  // any machine action (list / start / stop / config write / mkdir / probe).
  // Forward every injectable observation so a caller (and the tests) can
  // exercise the gate's DECISIONS without a real machine. `deps` is already the
  // seam for machine actions; the gate's filesystem/volume facts belong there
  // too, otherwise a test cannot reach a later validation.
  assertColimaHome({
    env,
    uuidOf: deps.uuidOf,
    volumesOf: deps.volumesOf,
    statOf: deps.statOf,
    accessOf: deps.accessOf,
  });
  const scratchMount = assertSingleWritableMount(rwMounts);
  const run = deps.run ?? runSync;
  const resolveFn = deps.resolve ?? resolveInstance;
  const probeFn = deps.probe ?? roundTripProbe;
  const runtimeFpFn = deps.runtimeFingerprint ?? runtimeMountFingerprint;

  const desiredFingerprint = mountFingerprint([
    ...roMounts.map((location) => ({ location, writable: false })),
    ...rwMounts.map((location) => ({ location, writable: true })),
  ]);

  const before = listInstances(run).find((i) => i.profile === profile) ?? null;
  const running = before?.status === "Running";
  const plan = planInstanceAction({
    profile,
    desiredFingerprint,
    runtimeFingerprint: runtimeFpFn(profile),
    running,
  });
  if (plan.action === INSTANCE_ACTION.HOLD) {
    throw new ColimaRuntimeError(`HOLD ${plan.holdCode}: ${plan.reason}`);
  }

  if (plan.action === INSTANCE_ACTION.RECONCILE && running) {
    // Bounded reconcile: stop the verified test-owned profile so the start
    // below actually provisions the desired mount generation.
    run(COLIMA_BIN, ["stop", "--profile", profile]);
  }
  const startWithDesiredMounts = () => {
    const args = ["start", "--profile", profile, "--cpu", String(cpus), "--memory", String(memory), "--disk", String(disk)];
    for (const m of roMounts) args.push("--mount", m);
    for (const m of rwMounts) args.push("--mount", `${m}:w`);
    run(COLIMA_BIN, args, { log: true });
  };
  if (plan.action !== INSTANCE_ACTION.REUSE) {
    startWithDesiredMounts();
  }

  // colima start can return before the in-VM docker engine socket is ready;
  // retry the pinned-socket check（never implicit context）until ready.
  const deadline = Date.now() + socketReadyMs;
  let resolved = resolveFn(profile);
  while (!resolved.ok && Date.now() < deadline) {
    run("/bin/sleep", ["1"]);
    resolved = resolveFn(profile);
  }
  if (!resolved.ok) {
    throw new ColimaRuntimeError(
      `instance ${profile} not reachable on pinned socket ${resolved.socket}: ${resolved.error}`,
    );
  }

  // Post-readiness verification: the RUNNING generation must equal desired.
  const runtimeAfter = runtimeFpFn(profile);
  if (runtimeAfter !== desiredFingerprint) {
    throw new ColimaRuntimeError(
      `HOLD COLIMA_RUNTIME_MOUNT_RECONCILE_INCOMPLETE: instance ${profile} runs mount generation ${runtimeAfter}, desired ${desiredFingerprint}`,
      { desiredFingerprint, runtimeFingerprint: runtimeAfter },
    );
  }

  let rt = probeFn({ profile, scratchRoot: scratchMount });
  let rebound = false;
  if (!rt.ok && plan.action === INSTANCE_ACTION.REUSE
      && typeof rt.reason === "string"
      && rt.reason.includes("error while creating mount source path")) {
    // One bounded re-bind for the stale-inode case, then re-probe. Anything
    // else (or a second failure) stays fail-closed below.
    run(COLIMA_BIN, ["stop", "--profile", profile]);
    startWithDesiredMounts();
    const rebindDeadline = Date.now() + socketReadyMs;
    resolved = resolveFn(profile);
    while (!resolved.ok && Date.now() < rebindDeadline) {
      run("/bin/sleep", ["1"]);
      resolved = resolveFn(profile);
    }
    if (!resolved.ok) {
      throw new ColimaRuntimeError(
        `instance ${profile} not reachable on pinned socket ${resolved.socket} after stale-mount rebind: ${resolved.error}`,
      );
    }
    const runtimeRebound = runtimeFpFn(profile);
    if (runtimeRebound !== desiredFingerprint) {
      throw new ColimaRuntimeError(
        `HOLD COLIMA_RUNTIME_MOUNT_RECONCILE_INCOMPLETE: instance ${profile} runs mount generation ${runtimeRebound}, desired ${desiredFingerprint}`,
        { desiredFingerprint, runtimeFingerprint: runtimeRebound },
      );
    }
    rt = probeFn({ profile, scratchRoot: scratchMount });
  }
  if (!rt.ok) {
    throw new ColimaRuntimeError(
      `HOLD COLIMA_ROUND_TRIP_PROBE_FAILED (${rt.direction}): ${rt.reason}`,
      rt,
    );
  }

  const after = listInstances(run).find((i) => i.profile === profile) ?? null;
  return {
    ...resolved,
    reused: plan.action === INSTANCE_ACTION.REUSE && !rebound,
    reconciled: plan.action === INSTANCE_ACTION.RECONCILE,
    rebound,
    desiredMountFingerprint: desiredFingerprint,
    runtimeMountFingerprint: runtimeAfter,
    diskBefore: before?.disk ?? null,
    diskAfter: after?.disk ?? null,
  };
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
