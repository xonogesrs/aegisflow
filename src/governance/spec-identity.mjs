// src/governance/spec-identity.mjs
//
// AUTOLOOP-REVART-IMPL1-RC2 — single owner of canonical spec-text identity.
//
// Frozen normalization contract (RC2 freeze D1; IMPL1 freeze §7) — exactly,
// with no silent broadening:
//   1. valid UTF-8 required (fail closed on malformed input);
//   2. strip one leading UTF-8 BOM if present;
//   3. normalize CRLF → LF;
//   4. standalone CR is NOT normalized (outside the frozen contract);
//   5. filesystem path is excluded from the digest input (this module takes
//      bytes only, never a path — path independence is by construction);
//   6. SHA-256 over the normalized content bytes.
//
// There is exactly one normalization implementation. Caller-supplied
// specDigest values are never authoritative: authority is derived here from
// actual bytes.

import { TextDecoder } from "node:util";
import { sha256Hex } from "../c2d/fs-atomic.mjs";

export class SpecIdentityError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "SpecIdentityError";
    this.code = code;
  }
}

/**
 * Canonical spec bytes: strict-UTF-8 decode → strip one leading BOM →
 * CRLF→LF. Returns a Buffer of the normalized bytes.
 *
 * @param {Buffer|Uint8Array|string} bytes — raw spec file bytes
 * @returns {Buffer} normalized bytes
 */
export function canonicalSpecBytes(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let text;
  try {
    // fatal:true — malformed UTF-8 throws instead of silently substituting.
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new SpecIdentityError("SPEC_UTF8_INVALID", "spec content is not valid UTF-8");
  }
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  // CRLF → LF only; a lone CR is preserved verbatim (frozen contract).
  const normalized = withoutBom.replace(/\r\n/g, "\n");
  return Buffer.from(normalized, "utf8");
}

/**
 * Authoritative spec digest: SHA-256 of canonicalSpecBytes().
 *
 * @param {Buffer|Uint8Array|string} bytes — raw spec file bytes
 * @returns {string} 64-hex sha256
 */
export function specDigestOf(bytes) {
  return sha256Hex(canonicalSpecBytes(bytes));
}
