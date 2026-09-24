// src/shared/autoloop-paths.mjs
//
// Portable location resolution for every AutoLoop state root.
//
// WHY THIS MODULE EXISTS
// AutoLoop previously hardcoded one operator's absolute paths into the runtime
// (an evidence volume, a Colima runtime home, a Pi install path). That made a
// public checkout unusable anywhere else. Every root below is now resolved
// from explicit configuration with a portable default, so:
//
//   - a fresh clone works with ZERO configuration (defaults land under
//     AUTOLOOP_HOME, itself defaulting to ~/.autoloop), and
//   - the original deployment keeps byte-identical behavior by setting the
//     documented environment variables explicitly.
//
// INVARIANTS (fail-closed, preserved from the replaced literals)
//   - A configured root MUST be absolute. A relative value is an error, never
//     resolved against the process cwd.
//   - A state root MUST NOT be $HOME itself, and MUST NOT be inside $HOME when
//     it is a namespace that existing code treats as non-$HOME (telemetry,
//     evidence, Colima runtime home). This keeps the original "never fall
//     back to a home-directory namespace" refusal intact.
//   - Resolution NEVER creates a directory and NEVER falls back silently after
//     rejecting a configured value.
//
// This module has NO imports and NO side effects beyond reading the env it is
// handed, so it is safe to import from the Colima profile lock (which must not
// depend on colima-runtime.mjs) and from tests.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/** Root of all AutoLoop state when no more specific root is configured. */
export const AUTOLOOP_HOME_ENV = "AUTOLOOP_HOME";

/** Authoritative durable-evidence namespace. */
export const EVIDENCE_ROOT_ENV = "AUTOLOOP_EVIDENCE_ROOT";

/** Telemetry namespace. Must never live inside the evidence namespace. */
export const TELEMETRY_ROOT_ENV = "AUTOLOOP_TELEMETRY_ROOT";

/** Learning (transfer-metrics / incident) storage root. */
export const LEARNING_ROOT_ENV = "AUTOLOOP_LEARNING_ROOT";

/** Sandbox scratch root for fixture and probe work. */
export const SCRATCH_ROOT_ENV = "AUTOLOOP_SCRATCH_ROOT";

/** Colima runtime home (machine-level container state). */
export const COLIMA_HOME_ENV = "COLIMA_HOME";

/** Optional volume-identity gate for COLIMA_HOME. */
export const COLIMA_MOUNT_ENV = "AUTOLOOP_COLIMA_MOUNT";
export const COLIMA_MOUNT_UUID_ENV = "AUTOLOOP_COLIMA_MOUNT_UUID";

/** Executable overrides (no PATH dependence, no hardcoded install prefix). */
export const COLIMA_BIN_ENV = "AUTOLOOP_COLIMA_BIN";
export const DOCKER_BIN_ENV = "AUTOLOOP_DOCKER_BIN";

export class AutoloopPathError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "AutoloopPathError";
    this.details = details;
  }
}

function isUnder(child, parent) {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/** True when `value` is $HOME itself or inside it. */
export function isInHomeNamespace(value, { home = homedir() } = {}) {
  return isUnder(value, home);
}

/** True when `value` resolves to exactly $HOME. */
export function isHomeItself(value, { home = homedir() } = {}) {
  return resolve(value) === resolve(home);
}

/**
 * Reject $HOME itself as a state root.
 *
 * Callers that ALREADY require the resolved path to sit under a configured
 * namespace root (writing it as an identity prefix) use this alone: the
 * namespace prefix is the real boundary, so a blanket "$HOME subtree is
 * forbidden" rule would contradict the portable default
 * (~/.autoloop/...), which is deliberately a home-directory namespace.
 */
export function rejectHomeItself(value, { home = homedir(), label = "state root" } = {}) {
  if (isHomeItself(value, { home })) {
    throw new AutoloopPathError("AUTOLOOP_ROOT_IS_HOME", `${label} must not be $HOME itself`, { value: resolve(value) });
  }
  return resolve(value);
}

/**
 * Namespace-root rule for state roots.
 *
 * Rejected:  $HOME itself, or any directory inside $HOME that is NOT inside
 *            AUTOLOOP_HOME (so state can never be scattered into the user's
 *            Desktop/Documents/Downloads — it must sit in the documented
 *            AutoLoop namespace or outside $HOME entirely).
 * Allowed:   $HOME/.autoloop/... (the portable default namespace), $HOME/.autoloop
 *            itself is never a root, and any absolute path outside $HOME.
 */
export function assertStateRootAllowed(value, { env = process.env, home = homedir() } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AutoloopPathError("AUTOLOOP_ROOT_NOT_SET", "state root is not set");
  }
  const raw = value.trim();
  if (!isAbsolute(raw)) {
    throw new AutoloopPathError("AUTOLOOP_ROOT_NOT_ABSOLUTE", `state root must be an absolute path: ${raw}`, { value: raw });
  }
  const resolved = resolve(raw);
  const homeResolved = resolve(home);
  if (resolved === homeResolved) {
    throw new AutoloopPathError("AUTOLOOP_ROOT_IS_HOME", "$HOME itself is never a state root", { value: resolved });
  }
  if (isUnder(resolved, homeResolved) && !isUnder(resolved, autoloopHome({ env, home }))) {
    throw new AutoloopPathError(
      "AUTOLOOP_ROOT_IN_HOME_NAMESPACE",
      `state root inside $HOME must live under ${AUTOLOOP_HOME_ENV} (${autoloopHome({ env, home })}): ${resolved}`,
      { value: resolved, home: homeResolved },
    );
  }
  return resolved;
}

/**
 * Absolute, never $HOME, never inside $HOME. Retained for callers that need the
 * strict form (a root that must live outside the home directory entirely).
 */
export function assertNamespaceRoot(value, { envName, home = homedir() } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AutoloopPathError("AUTOLOOP_ROOT_NOT_SET", `${envName} is not set`, { envName });
  }
  const raw = value.trim();
  if (!isAbsolute(raw)) {
    throw new AutoloopPathError("AUTOLOOP_ROOT_NOT_ABSOLUTE", `${envName} must be an absolute path: ${raw}`, { envName, value: raw });
  }
  const resolved = resolve(raw);
  if (isUnder(resolved, home)) {
    throw new AutoloopPathError(
      "AUTOLOOP_ROOT_IN_HOME_NAMESPACE",
      `${envName} must not resolve inside $HOME: ${resolved}`,
      { envName, value: resolved, home: resolve(home) },
    );
  }
  return resolved;
}

/**
 * The REAL path of `$HOME` (or a supplied home), canonicalized through its
 * deepest existing prefix.
 *
 * Fences that compare an ALREADY-canonicalized candidate against $HOME must use
 * this, never a bare `resolve(homedir())`: on a platform that reaches home
 * through a symlink (macOS `/tmp` → `/private/tmp`) the lexical spelling is a
 * different string, and a lexical HOME against a resolved candidate silently
 * disables the fence.
 */
export function canonicalHome({ home = homedir() } = {}) {
  return canonicalizeExistingPrefix(resolve(home));
}

/** AUTOLOOP_HOME itself (the container for the other defaults). */
export function autoloopHome({ env = process.env, home = homedir() } = {}) {
  const configured = env?.[AUTOLOOP_HOME_ENV];
  if (typeof configured === "string" && configured.trim().length > 0) {
    if (!isAbsolute(configured.trim())) {
      throw new AutoloopPathError("AUTOLOOP_HOME_NOT_ABSOLUTE", `${AUTOLOOP_HOME_ENV} must be an absolute path: ${configured}`, { value: configured });
    }
    return resolve(configured.trim());
  }
  return join(home, ".autoloop");
}

/**
 * Resolve a path under the AutoLoop namespace.
 *
 * `autoloopDefault("memory")` → `<AUTOLOOP_HOME>/memory`. This is the helper
 * every module with a state default uses, so relocating AUTOLOOP_HOME really
 * does move all AutoLoop state (a literal ~/.autoloop/... would silently
 * bypass it).
 */
export function autoloopDefault(...segments) {
  return join(autoloopHome(), ...segments);
}

/**
 * Resolve one root: explicit env value (strictly validated) or portable default.
 *
 * DEFAULT vs CONFIGURED is a real semantic distinction here:
 *
 *   - a CONFIGURED root is returned exactly as given (after validation), so a
 *     security-relevant path is never silently rewritten;
 *   - a DEFAULT root is resolved through the deepest EXISTING prefix, because a
 *     platform may reach a home directory through a symlink (macOS
 *     `/tmp` → `/private/tmp`, `/var` → `/private/var`) and consumers compare
 *     roots as path prefixes. Two defaults resolved from the same
 *     AUTOLOOP_HOME must agree, or one fails the other's boundary check.
 *
 * Making this uniform is what keeps `<AUTOLOOP_HOME>/learning` and
 * `<AUTOLOOP_HOME>/learning/scratch` mutually consistent on such a platform;
 * canonicalizing only one of them was the defect this rule removes.
 */
function resolveRoot({ env, envName, defaultRelative, home }) {
  const configured = env?.[envName];
  if (typeof configured === "string" && configured.trim().length > 0) {
    return assertStateRootAllowed(configured, { env, home });
  }
  return canonicalizeExistingPrefix(resolve(join(autoloopHome({ env, home }), ...defaultRelative)));
}

/**
 * Authoritative durable-evidence root.
 * Default: <AUTOLOOP_HOME>/evidence/autoloop
 */
export function resolveEvidenceRoot({ env = process.env, home = homedir() } = {}) {
  return resolveRoot({ env, envName: EVIDENCE_ROOT_ENV, defaultRelative: ["evidence", "autoloop"], home });
}

/**
 * Telemetry root. Default: <AUTOLOOP_HOME>/evidence/autoloop-telemetry
 *
 * Separation from the evidence namespace is the authority fence (telemetry is
 * observability, evidence is authority), so a configured telemetry root that
 * resolves INSIDE the evidence root fails closed.
 */
export function resolveTelemetryRoot({ env = process.env, home = homedir() } = {}) {
  const root = resolveRoot({ env, envName: TELEMETRY_ROOT_ENV, defaultRelative: ["evidence", "autoloop-telemetry"], home });
  const evidence = resolveEvidenceRoot({ env, home });
  if (root === evidence || isUnder(root, evidence)) {
    throw new AutoloopPathError(
      "AUTOLOOP_TELEMETRY_INSIDE_EVIDENCE",
      `${TELEMETRY_ROOT_ENV} must not live inside the evidence namespace (${evidence}): ${root}`,
      { telemetry: root, evidence },
    );
  }
  return root;
}

/**
 * Learning storage root (transfer metrics, incident records).
 * Default: <AUTOLOOP_HOME>/learning   — with a trailing separator, because
 * consumers use it as a storage-identity PREFIX.
 */
export function resolveLearningRoot({ env = process.env, home = homedir() } = {}) {
  const root = resolveRoot({ env, envName: LEARNING_ROOT_ENV, defaultRelative: ["learning"], home });
  return root.endsWith(sep) ? root : root + sep;
}

/**
 * Sandbox scratch root for fixtures.
 * Default: <AUTOLOOP_HOME>/learning/scratch — deliberately inside the learning
 * storage namespace, because the learning fixtures record their scratch paths
 * as storage identities that must satisfy the learning-root boundary. Both
 * defaults are canonicalized identically by `resolveRoot`, so that boundary
 * holds on a platform whose home directory is reached through a symlink.
 */
export function resolveScratchRoot({ env = process.env, home = homedir() } = {}) {
  return resolveRoot({ env, envName: SCRATCH_ROOT_ENV, defaultRelative: ["learning", "scratch"], home });
}

/**
 * Resolve symlinks in the deepest existing prefix of `p`.
 *
 * Used ONLY for platform defaults, where a symlinked component is an artefact
 * of where the OS puts home directories. An explicitly configured path is
 * never rewritten — a security-relevant resolution must stay visible.
 */
function canonicalizeExistingPrefix(p) {
  let current = resolve(p);
  const trailing = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return trailing.length === 0 ? real : join(real, ...trailing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p); // nothing exists / reached root
      trailing.push(basename(current));
      current = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// Human-facing review surfaces (operator entrypoints, not authority stores).
//
// Defaults live under <AUTOLOOP_HOME>/review; each is independently
// relocatable with its documented env var. An override must be absolute
// (a relative path is an error, never resolved against the cwd), but it may
// point anywhere — these are operator-visible directories, so pointing them
// at e.g. a Desktop folder is legitimate configuration.
// ---------------------------------------------------------------------------

export const REVIEW_SURFACE_ENV = "AUTOLOOP_REVIEW_SURFACE";
export const REVIEW_ARCHIVE_ENV = "AUTOLOOP_REVIEW_ARCHIVE";
export const EXECUTION_REVIEW_SURFACE_ENV = "AUTOLOOP_EXECUTION_REVIEW_SURFACE";
export const EXECUTION_REVIEW_ARCHIVE_ENV = "AUTOLOOP_EXECUTION_REVIEW_ARCHIVE";

function resolveOverrideOr({ env, envName, defaultRelative, home }) {
  const configured = env?.[envName];
  if (typeof configured === "string" && configured.trim().length > 0) {
    if (!isAbsolute(configured.trim())) {
      throw new AutoloopPathError("AUTOLOOP_ROOT_NOT_ABSOLUTE", `${envName} must be an absolute path: ${configured}`, { envName, value: configured });
    }
    return resolve(configured.trim());
  }
  // Same default/configured rule as resolveRoot: a default is canonicalized so
  // every surface derived from one AUTOLOOP_HOME names the same directory.
  return canonicalizeExistingPrefix(resolve(join(autoloopHome({ env, home }), ...defaultRelative)));
}

/** External-review inbox (at most one card awaiting a verdict). */
export function resolveReviewSurface({ env = process.env, home = homedir() } = {}) {
  return resolveOverrideOr({ env, envName: REVIEW_SURFACE_ENV, defaultRelative: ["review", "Current"], home });
}

/** Rotated external-review archive (flat, immutable). */
export function resolveReviewArchive({ env = process.env, home = homedir() } = {}) {
  return resolveOverrideOr({ env, envName: REVIEW_ARCHIVE_ENV, defaultRelative: ["review", "Archive"], home });
}

/** Human entrypoint for the latest formal execution review. */
export function resolveExecutionReviewSurface({ env = process.env, home = homedir() } = {}) {
  return resolveOverrideOr({ env, envName: EXECUTION_REVIEW_SURFACE_ENV, defaultRelative: ["review", "Latest"], home });
}

/** Historical execution reviews rotated out of the latest entrypoint. */
export function resolveExecutionReviewArchive({ env = process.env, home = homedir() } = {}) {
  return resolveOverrideOr({ env, envName: EXECUTION_REVIEW_ARCHIVE_ENV, defaultRelative: ["review", "Latest", "archive"], home });
}

/**
 * The Colima runtime home as CONFIGURED (no existence or identity check).
 *
 * Returns null when COLIMA_HOME is unset — the machine-action gate
 * (colima-runtime.mjs assertColimaHome) turns that into a fail-closed HOLD.
 * Kept as a pure resolver here so the profile-lock module and the runtime
 * module agree on the same value without depending on each other.
 */
export function configuredColimaHome({ env = process.env } = {}) {
  const configured = env?.[COLIMA_HOME_ENV];
  if (typeof configured !== "string" || configured.trim().length === 0) return null;
  return resolve(configured.trim());
}

/** Optional volume-identity gate configuration. Absent ⇒ gate disabled. */
export function colimaMountGate({ env = process.env } = {}) {
  const mount = env?.[COLIMA_MOUNT_ENV];
  const uuid = env?.[COLIMA_MOUNT_UUID_ENV];
  if (typeof mount !== "string" || mount.trim().length === 0) return null;
  if (typeof uuid !== "string" || uuid.trim().length === 0) return null;
  return { mount: resolve(mount.trim()), uuid: uuid.trim() };
}

/**
 * Resolve an executable path WITHOUT hardcoding a package-manager prefix:
 * explicit env override, then PATH, then the platform-default install dirs,
 * then the bare name (so the caller's own PATH still applies at spawn time).
 */
export function resolveExecutable(name, {
  env = process.env,
  envName = null,
  extraDirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"],
  exists = defaultExists,
} = {}) {
  const override = envName ? env?.[envName] : undefined;
  if (typeof override === "string" && override.trim().length > 0) return override.trim();
  const dirs = String(env?.PATH ?? "").split(":").filter(Boolean).concat(extraDirs);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return name;
}

function defaultExists(p) {
  return existsSync(p);
}
