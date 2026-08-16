// src/memory/canonical.mjs
//
// CBM-2 — Memory Contract v1: recursive canonical JSON spec（STRICT）.
//
// This is the CONTRACT canonicalizer for memory identity / digest / journal
// hash chains. It is intentionally STRICTER than the earlier
// `recursiveCanonicalJson` helpers（review-bundle / subagent-contract /
// run-evidence-store）:
//
//   - object keys sorted by Unicode CODE POINT（explicit deterministic rule）
//   - array order PRESERVED（never sorted, never collapsed）
//   - `undefined` is REJECTED（never silently dropped by JSON.stringify）
//   - NaN / Infinity / -Infinity REJECTED
//   - BigInt REJECTED（explicit conversion required）
//   - Date normalized to RFC3339 UTC（toISOString）
//   - strings passed through RAW（no Unicode normalization; byte-exact）
//   - only plain objects / arrays / primitives（no runtime object identity）
//   - no wall-clock generation timestamps unless part of memory semantics
//   - never includes its own digest
//
// CBM-1 collision defect（codified as zero-tolerance）: a shallow
// `JSON.stringify(v, Object.keys(v))` replacer strips nested object fields,
// making digests COUNT-only. The memory contract MUST use the recursive
// sorted-key form below; the collision regression lives in the test suite.

import { sha256Text } from "../evidence/run-evidence-store.mjs";

export const CANONICALIZATION_ERROR_CODES = Object.freeze({
  UNDEFINED_VALUE: "CANONICALIZATION_FAILED:undefined_value",
  NON_FINITE_NUMBER: "CANONICALIZATION_FAILED:non_finite_number",
  BIGINT: "CANONICALIZATION_FAILED:bigint",
  UNSUPPORTED_TYPE: "CANONICALIZATION_FAILED:unsupported_type",
  INVALID_DATE: "CANONICALIZATION_FAILED:invalid_date",
});

export class CanonicalizationError extends Error {
  constructor(code, path, message) {
    super(`${code}${path ? ` at ${path}` : ""}: ${message ?? ""}`);
    this.name = "CanonicalizationError";
    this.code = code;
    this.path = path;
  }
}

/** Compare two strings by Unicode code point（not UTF-16 code unit）. */
export function compareCodePoints(a, b) {
  let i = 0;
  while (i < a.length && i < b.length) {
    const ca = a.codePointAt(i);
    const cb = b.codePointAt(i);
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

function canonicalize(value, path) {
  if (value === null) return null;
  if (typeof value === "undefined") {
    throw new CanonicalizationError(CANONICALIZATION_ERROR_CODES.UNDEFINED_VALUE, path, "undefined is never silently dropped");
  }
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(CANONICALIZATION_ERROR_CODES.NON_FINITE_NUMBER, path, String(value));
    }
    // -0 normalizes to 0 for deterministic output（JSON.stringify does this）
    return Object.is(value, -0) ? 0 : value;
  }
  if (t === "bigint") {
    throw new CanonicalizationError(CANONICALIZATION_ERROR_CODES.BIGINT, path, "explicit conversion required");
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CanonicalizationError(CANONICALIZATION_ERROR_CODES.INVALID_DATE, path, String(value));
    }
    return value.toISOString(); // RFC3339 UTC
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => canonicalize(v, `${path}[${i}]`));
  }
  if (t === "object") {
    const out = {};
    for (const k of Object.keys(value).sort(compareCodePoints)) {
      const v = value[k];
      if (v === undefined) {
        throw new CanonicalizationError(CANONICALIZATION_ERROR_CODES.UNDEFINED_VALUE, `${path}.${k}`, "undefined is never silently dropped");
      }
      out[k] = canonicalize(v, `${path}.${k}`);
    }
    return out;
  }
  throw new CanonicalizationError(CANONICALIZATION_ERROR_CODES.UNSUPPORTED_TYPE, path, `typeof ${t}`);
}

/**
 * Recursive canonical JSON（memory contract spec）. Throws
 * CanonicalizationError on any value the contract rejects.
 */
export function recursiveCanonicalJson(value) {
  return JSON.stringify(canonicalize(value, "$"));
}

/**
 * sha256 over a canonical payload（contract identity / digest basis）.
 */
export function canonicalSha256(value) {
  return sha256Text(recursiveCanonicalJson(value));
}

/**
 * Content hash（CBM-1 §5）: sha256("content:" + canonical(content)).
 * Content-identical payloads share the hash; content is identity-relevant.
 */
export function contentHash(content) {
  return sha256Text("content:" + recursiveCanonicalJson(content));
}

/** RFC3339 / ISO-8601 UTC now（memory timestamps）— no local time, no ms drift issues. */
export function utcNowIso() {
  return new Date().toISOString();
}
