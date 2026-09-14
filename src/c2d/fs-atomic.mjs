// Atomic filesystem helpers for C2D checkpoint store.
// Exclusive-create (wx) for immutable paths; exclusive lock files for replace CAS.

import {
  openSync, closeSync, writeSync, fsyncSync, renameSync, mkdirSync,
  readFileSync, existsSync, lstatSync, realpathSync, linkSync,
  chmodSync, unlinkSync, readdirSync, rmSync, constants,
} from "node:fs";
import { dirname, join, resolve, sep, normalize } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const HOLD = Object.freeze({
  CHECKPOINT_STALE_REVISION: "HOLD / CHECKPOINT_STALE_REVISION",
  RESUME_LEASE_CONFLICT: "HOLD / RESUME_LEASE_CONFLICT",
  DIRTY_STATE_MISMATCH: "HOLD / DIRTY_STATE_MISMATCH",
  EXPECTED_HEAD_MISMATCH: "HOLD / EXPECTED_HEAD_MISMATCH",
  REPOSITORY_FINGERPRINT_MISMATCH: "HOLD / REPOSITORY_FINGERPRINT_MISMATCH",
  WORKTREE_IDENTITY_MISMATCH: "HOLD / WORKTREE_IDENTITY_MISMATCH",
  CHECKPOINT_REALITY_MISMATCH: "HOLD / CHECKPOINT_REALITY_MISMATCH",
  CHECKPOINT_CORRUPT: "HOLD / CHECKPOINT_CORRUPT",
  SNAPSHOT_CHECKSUM_MISMATCH: "HOLD / SNAPSHOT_CHECKSUM_MISMATCH",
  JOURNAL_GAP: "HOLD / JOURNAL_GAP",
  JOURNAL_OUT_OF_ORDER: "HOLD / JOURNAL_OUT_OF_ORDER",
  INTENT_WITHOUT_COMPLETION: "HOLD / INTENT_WITHOUT_COMPLETION",
  UNEXPECTED_COMPLETION_WITHOUT_INTENT: "HOLD / UNEXPECTED_COMPLETION_WITHOUT_INTENT",
  REQUIRED_GIT_OBJECT_MISSING: "HOLD / REQUIRED_GIT_OBJECT_MISSING",
  FILESYSTEM_CAPABILITY_UNAVAILABLE: "HOLD / FILESYSTEM_CAPABILITY_UNAVAILABLE",
  INVALID_EXECUTION_ID: "HOLD / INVALID_EXECUTION_ID",
  PATH_TRAVERSAL: "HOLD / PATH_TRAVERSAL",
  SYMLINK_REJECTED: "HOLD / SYMLINK_REJECTED",
  WRITE_PERMIT_REQUIRED: "HOLD / WRITE_PERMIT_REQUIRED",
  WRITE_PERMIT_INVALID: "HOLD / WRITE_PERMIT_INVALID",
  WRITE_PERMIT_REPLAYED: "HOLD / WRITE_PERMIT_REPLAYED",
  LOCK_ACTIVE: "HOLD / LOCK_ACTIVE",
  LOCK_RECORD_CORRUPT: "HOLD / LOCK_RECORD_CORRUPT",
  LOCK_AFFINITY_MISMATCH: "HOLD / LOCK_AFFINITY_MISMATCH",
  LOCK_RECLAIM_NOT_PROVEN_SAFE: "HOLD / LOCK_RECLAIM_NOT_PROVEN_SAFE",
  LOCK_RECLAIM_CONFLICT: "HOLD / LOCK_RECLAIM_CONFLICT",
  LOCK_RECLAIM_LINEARIZATION_GAP: "HOLD / LOCK_RECLAIM_LINEARIZATION_GAP",
  LOCK_RECOVERY_DURABILITY_HIDDEN: "HOLD / LOCK_RECOVERY_DURABILITY_HIDDEN",
  RECLAIM_GUARD_RECORD_CORRUPT: "HOLD / RECLAIM_GUARD_RECORD_CORRUPT",
  RECLAIM_GUARD_RECOVERY_NOT_PROVEN_SAFE: "HOLD / RECLAIM_GUARD_RECOVERY_NOT_PROVEN_SAFE",
  LEASE_RELEASE_NOT_SECRET_AUTHORIZED: "HOLD / LEASE_RELEASE_NOT_SECRET_AUTHORIZED",
  ANCHOR_SCHEMA_INVALID: "HOLD / AMENDMENT_ANCHOR_SCHEMA_INVALID",
});

export class C2dHoldError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = "C2dHoldError";
    this.code = code;
    this.details = details;
  }
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function isSha256Hex(s) {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

/** @type {Record<string, () => void>} */
let injectionHooks = Object.create(null);

export function setInjectionHook(name, fn) {
  if (fn == null) delete injectionHooks[name];
  else injectionHooks[name] = fn;
}

export function clearInjectionHooks() {
  injectionHooks = Object.create(null);
}

export function fireHook(name) {
  const fn = injectionHooks[name];
  if (typeof fn === "function") fn();
}

/** @type {Record<string, () => void>} */
let fsyncDirImpl = null;
export function setDirFsyncImpl(fn) {
  fsyncDirImpl = fn;
}
export function resetDirFsyncImpl() {
  fsyncDirImpl = null;
}

export function ensureDir0700(dir) {
  assertPathComponentsNotSymlink(dirname(resolve(dir)), { allowMissingLeaf: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertNotSymlink(dir);
  try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
}

export function assertNotSymlink(path) {
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw new C2dHoldError(HOLD.SYMLINK_REJECTED, `symlink rejected: ${path}`);
  }
}

/**
 * Reject if the target path itself (when present) is a symlink.
 * Intermediate OS temp symlinks (e.g. /tmp -> /private/tmp) are resolved via
 * resolveSafeRoot, not rejected here.
 */
export function assertPathComponentsNotSymlink(targetPath, { allowMissingLeaf = false } = {}) {
  const abs = resolve(targetPath);
  if (!existsSync(abs)) {
    if (allowMissingLeaf) return;
    return;
  }
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    throw new C2dHoldError(HOLD.SYMLINK_REJECTED, `symlink rejected: ${abs}`);
  }
}

export function assertInsideRoot(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  const prefix = r.endsWith(sep) ? r : r + sep;
  if (t !== r && !t.startsWith(prefix)) {
    throw new C2dHoldError(HOLD.PATH_TRAVERSAL, `path escapes root: ${target}`);
  }
}

function fsyncDirectory(dir) {
  if (fsyncDirImpl) {
    fsyncDirImpl(dir);
    return { durability_capability: "full" };
  }
  try {
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
    return { durability_capability: "full" };
  } catch (e) {
    return {
      durability_capability: "degraded",
      reason: e && e.message ? e.message : "directory fsync unavailable",
    };
  }
}

/**
 * Exclusive create-if-absent of final path.
 * Write temp fully, then linkSync(temp, final) — atomic create-if-absent on POSIX.
 * Never overwrites an existing final path.
 */
export function writeExclusiveCreate(finalPath, bytes, hooks = {}) {
  assertPathComponentsNotSymlink(dirname(finalPath));
  assertPathComponentsNotSymlink(finalPath, { allowMissingLeaf: true });
  const dir = dirname(finalPath);
  ensureDir0700(dir);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  const nonce = randomBytes(8).toString("hex");
  const tmp = `${finalPath}.tmp.${nonce}`;
  fireHook(hooks.hookBeforeCreate || "before_exclusive_create");
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  fireHook(hooks.hookBeforeLink || "before_exclusive_link");
  try {
    linkSync(tmp, finalPath);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* */ }
    if (e && e.code === "EEXIST") {
      throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, `exclusive create failed: ${finalPath}`, {
        errno: e.code,
      });
    }
    throw e;
  }
  try { unlinkSync(tmp); } catch { /* */ }
  fireHook(hooks.hookAfterCreate || "after_exclusive_create");
  const dur = fsyncDirectory(dir);
  fireHook(hooks.hookAfterDirFsync || "after_dir_fsync");
  return { path: finalPath, bytes: buf, ...dur };
}

/**
 * @deprecated Prefer acquireStructuredLock from lock.mjs.
 * Thin wrapper retained for internal temp critical sections that are not crash-recovery locks.
 */
export function acquireExclusiveLock(lockPath) {
  assertPathComponentsNotSymlink(dirname(lockPath));
  ensureDir0700(dirname(lockPath));
  try {
    const fd = openSync(lockPath, "wx", 0o600);
    writeSync(fd, Buffer.from(JSON.stringify({
      format_version: "1.0.0",
      process_id: process.pid,
      acquired_at: new Date().toISOString(),
    }) + "\n", "utf8"));
    fsyncSync(fd);
    return { fd, path: lockPath };
  } catch (e) {
    if (e && e.code === "EEXIST") {
      throw new C2dHoldError(HOLD.CHECKPOINT_STALE_REVISION, `exclusive lock busy: ${lockPath}`, {
        errno: "EEXIST",
      });
    }
    throw e;
  }
}

export function releaseExclusiveLock(lock) {
  if (!lock) return;
  try { closeSync(lock.fd); } catch { /* */ }
  try { unlinkSync(lock.path); } catch { /* */ }
}

/**
 * Replace existing file under exclusive lock. Caller holds lock.
 *
 * AURACORE-AUTOLOOP-C5B-ATOMIC-EVIDENCE-SCHEMA-PARITY-AND-CANONICAL-TEST-RUNNER-1:
 * hardened so a write/fsync failure or a rename failure cleans up the known
 * temp path before rethrowing, mirroring writeExclusiveCreate's existing
 * cleanup-on-failure pattern above. Previously the temp file could be
 * orphaned on either failure path. This is a pure failure-path hardening —
 * the success path (temp write, fsync, rename, hook order, return shape) is
 * byte-for-byte unchanged, so existing callers (checkpoint-store.mjs,
 * lease.mjs) see no behavior change on success. On any failure, the
 * pre-existing destination file (if any) is never touched — rename either
 * fully replaces it atomically or does not happen at all.
 */
export function writeAtomicReplaceUnderLock(finalPath, bytes, hooks = {}) {
  assertPathComponentsNotSymlink(dirname(finalPath));
  if (existsSync(finalPath)) assertNotSymlink(finalPath);
  const dir = dirname(finalPath);
  ensureDir0700(dir);
  const nonce = randomBytes(8).toString("hex");
  const tmp = `${finalPath}.tmp.${nonce}`;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, buf);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  closeSync(fd);
  try { chmodSync(tmp, 0o600); } catch { /* */ }
  try {
    fireHook(hooks.hookBeforeRename || "before_replace_rename");
    renameSync(tmp, finalPath);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort — tmp may not exist depending on failure mode */ }
    throw e;
  }
  fireHook(hooks.hookAfterRename || "after_replace_rename");
  const dur = fsyncDirectory(dir);
  return { path: finalPath, bytes: buf, ...dur };
}

export function writeJsonExclusiveCreate(finalPath, obj, hooks) {
  const body = JSON.stringify(obj, null, 2) + "\n";
  const r = writeExclusiveCreate(finalPath, body, hooks);
  return { ...r, bytes: Buffer.from(body, "utf8") };
}

export function writeJsonAtomicReplaceUnderLock(finalPath, obj, hooks) {
  const body = JSON.stringify(obj, null, 2) + "\n";
  const r = writeAtomicReplaceUnderLock(finalPath, body, hooks);
  return { ...r, bytes: Buffer.from(body, "utf8") };
}

export function readExact(path) {
  return readFileSync(path);
}

export function listDirSafe(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

export function removeIfExists(path) {
  if (existsSync(path)) unlinkSync(path);
}

export function rmTree(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

/**
 * Resolve checkpoint root safely:
 * - If the path itself exists and is a symlink → reject (escape vector).
 * - Otherwise resolve nearest existing ancestor with realpath (allows /tmp→/private/tmp),
 *   then rejoin missing leaf components.
 */
export function resolveSafeRoot(path) {
  const abs = resolve(path);
  if (existsSync(abs)) {
    assertNotSymlink(abs);
    return realpathSync(abs);
  }
  // Walk up to existing ancestor
  let cur = abs;
  const missing = [];
  while (!existsSync(cur)) {
    missing.push(cur.slice(dirname(cur).length).replace(/^\//, ""));
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const realBase = realpathSync(cur);
  // rebuild path under real base
  let out = realBase;
  for (const part of missing.reverse()) {
    if (!part) continue;
    out = join(out, part);
  }
  return out;
}
