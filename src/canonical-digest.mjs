// canonical-digest.mjs
//
// Minimal canonical-JSON + SHA-256 digest helper for AutoLoop task-
// understanding artifacts (authority record, task-understanding contract,
// provenance, challenge, bundles). Card
// AURACORE-AUTOLOOP-C4A-TASK-UNDERSTANDING-IMPLEMENTATION-1 §5/§9.
//
// No canonical-JSON utility existed anywhere in scripts/ai/ prior to this
// file (confirmed by recon). Reuses the existing sha256Hex primitive from
// c2d/fs-atomic.mjs rather than reimplementing hashing.
//
// Rules:
//   - object keys sorted by Unicode code-point order (recursive)
//   - array element order is preserved as-is (caller's responsibility to
//     produce a stable order before calling, e.g. sort production_truth by
//     fact_id, sort path arrays lexicographically)
//   - explicit null is preserved; undefined keys are omitted
//   - no whitespace, no trailing newline
//   - UTF-8 encoding throughout

import { sha256Hex } from "./c2d/fs-atomic.mjs";

function sortValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue;
      out[key] = sortValue(v);
    }
    return out;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`canonicalize: unsupported value type ${typeof value}`);
  }
  return value;
}

/**
 * Produce a canonical JSON string: recursively key-sorted, array order
 * preserved, no whitespace, no trailing newline.
 */
export function canonicalize(value) {
  return JSON.stringify(sortValue(value));
}

/**
 * SHA-256 hex digest of the canonical JSON serialization of `value`.
 */
export function digestOf(value) {
  return sha256Hex(Buffer.from(canonicalize(value), "utf8"));
}

/**
 * Normalize a path array to a stable, hashable form: forward slashes only,
 * lexicographically sorted. Does not perform security canonicalization
 * (traversal/symlink checks) — callers must have already validated paths
 * via canonicalRepositoryPath before calling this.
 */
export function normalizePathArrayForDigest(paths) {
  if (!Array.isArray(paths)) return [];
  return [...paths].map((p) => String(p).replace(/\\/g, "/")).sort();
}
