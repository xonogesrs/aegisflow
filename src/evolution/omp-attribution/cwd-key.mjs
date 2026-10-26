// src/evolution/omp-attribution/cwd-key.mjs
//
// Per-store keyed identity for the session cwd (cwd_ref). An unsalted hash of a
// guessable project path can be confirmed by anyone holding the store; a keyed
// HMAC cannot, as long as the key is NOT stored with the observations.
//
//   - the key is 32 random bytes (hex), generated from the OS CSPRNG;
//   - it lives in a user-only (0600) file OUTSIDE the store and outside git;
//   - it is never written to the store, a report, stdout, stderr or an error;
//   - a missing / unreadable / mismatching key FAILS CLOSED: a new key is never
//     minted over an existing store identity.
//
// `<store>/omp-observations/identity.json` records only the algorithm label
// and a short key_id (a one-way digest), so a wrong key is detected without the
// key itself ever being stored.

import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  closeSync, constants as fsConstants, fsyncSync, lstatSync, openSync, readSync,
  realpathSync, writeSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";

export const CWD_ALG = "hmac-sha256-v1";
export const KEY_ID_RE = /^[0-9a-f]{16}$/;
export const IDENTITY_SCHEMA = "aegisflow.omp-attribution-identity/v1";
const KEY_HEX_RE = /^[0-9a-f]{64}$/;

export class KeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "KeyError";
  }
}

export const KEY_ERRORS = Object.freeze({
  REQUIRED: "OMP_ATTRIBUTION_KEY_REQUIRED",
  MISSING: "OMP_ATTRIBUTION_KEY_MISSING",
  UNREADABLE: "OMP_ATTRIBUTION_KEY_UNREADABLE",
  INSECURE: "OMP_ATTRIBUTION_KEY_INSECURE",
  MISMATCH: "OMP_ATTRIBUTION_KEY_MISMATCH",
  IDENTITY_MISSING: "OMP_ATTRIBUTION_KEY_IDENTITY_MISSING",
  IDENTITY_CORRUPT: "OMP_ATTRIBUTION_KEY_IDENTITY_CORRUPT",
  INSIDE_STORE: "OMP_ATTRIBUTION_KEY_INSIDE_STORE",
});

export function keyIdOf(key) {
  return createHash("sha256").update(`omp-attribution-key-id:${key.toString("hex")}`).digest("hex").slice(0, 16);
}

export function cwdMacFor(key) {
  return (normalizedCwd) => createHmac("sha256", key).update(`cwd:${normalizedCwd}`).digest("hex");
}

/** In-memory only; used by dry-run when no key exists. Meaningless outside the process. */
export function ephemeralKey() {
  const key = randomBytes(32);
  return { key, keyId: keyIdOf(key), ephemeral: true };
}

/**
 * Read an existing key file.
 * @returns {{ key: Buffer, keyId: string, ephemeral: false } | null} null when the file does not exist
 * @throws {KeyError} INSECURE / UNREADABLE — never mints or repairs anything
 */
export function readKeyFile(keyFile) {
  let st;
  try {
    st = lstatSync(keyFile);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw new KeyError(KEY_ERRORS.UNREADABLE, "key file cannot be inspected");
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new KeyError(KEY_ERRORS.INSECURE, "key file is not a regular file");
  if ((st.mode & 0o077) !== 0) throw new KeyError(KEY_ERRORS.INSECURE, "key file is accessible by group/others");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new KeyError(KEY_ERRORS.INSECURE, "key file is not owned by the current user");
  }
  if (st.size > 256) throw new KeyError(KEY_ERRORS.UNREADABLE, "key file has an unexpected size");
  let fd;
  try {
    fd = openSync(keyFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const buf = Buffer.alloc(Math.min(st.size, 256));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const hex = buf.subarray(0, n).toString("utf8").trim();
    if (!KEY_HEX_RE.test(hex)) throw new KeyError(KEY_ERRORS.UNREADABLE, "key file content is not a 32-byte hex key");
    const key = Buffer.from(hex, "hex");
    return { key, keyId: keyIdOf(key), ephemeral: false };
  } catch (e) {
    if (e instanceof KeyError) throw e;
    throw new KeyError(KEY_ERRORS.UNREADABLE, "key file cannot be read");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Create a NEW key file: exclusive create, mode 0600, fsync. The parent
 * directory must already exist (its permissions are never altered).
 */
export function createKeyFile(keyFile) {
  const key = randomBytes(32);
  let fd;
  try {
    fd = openSync(keyFile, "wx", 0o600);
    writeSync(fd, `${key.toString("hex")}\n`);
    fsyncSync(fd);
  } catch (e) {
    if (e?.code === "EEXIST") throw new KeyError(KEY_ERRORS.UNREADABLE, "key file appeared concurrently; rerun");
    throw new KeyError(KEY_ERRORS.UNREADABLE, "key file cannot be created (does its directory exist?)");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { key, keyId: keyIdOf(key), ephemeral: false };
}

/** The key must not live inside the store it protects. */
export function assertKeyOutsideStore(keyFile, storeRoot) {
  let realDir;
  let realStore;
  try {
    realDir = realpathSync(dirname(keyFile));
    realStore = realpathSync(storeRoot);
  } catch {
    throw new KeyError(KEY_ERRORS.UNREADABLE, "key directory or store cannot be resolved");
  }
  const target = join(realDir, basename(keyFile));
  if (target === realStore || target.startsWith(realStore + sep)) {
    throw new KeyError(KEY_ERRORS.INSIDE_STORE, "the key file must be stored outside the store");
  }
}
