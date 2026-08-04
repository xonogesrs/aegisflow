// src/governance/lifecycle-authorization.mjs
//
// Reversible lifecycle authorization contract:
//  - schema-backed validation of the entry-card `lifecycle_authorization` block
//  - effective authority = parent ∩ child ∩ runtime policy (fail-closed)
//  - escalation detection → HOLD / AUTHORITY_ESCALATION_REJECTED
//
// Reuses c2d conventions (C2dHoldError, canonical digest, fs-atomic) and the
// existing C3B/C3C fail-closed posture. Never touches git refs, never pushes,
// never merges, never seals. Existing commit=NO / push=NO / seal=NO defaults
// are never implicitly overridden: absent authorization ⇒ all denied.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { C2dHoldError, assertNotSymlink, ensureDir0700, writeJsonExclusiveCreate } from "../c2d/fs-atomic.mjs";
import { canonicalize, digestOf } from "../canonical-digest.mjs";
import { GOV_HOLD, hold } from "./holds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(
  readFileSync(join(HERE, "..", "schema", "lifecycle-authorization.schema.json"), "utf8"),
);
export const SCHEMA_ID = SCHEMA["$id"];

// Capability sections shared by every authority object (parent / child /
// runtime). Each carries a normalized shape so intersection is mechanical.
export const CAPABILITY_SECTIONS = Object.freeze([
  "decomposition", "independent_review", "bounded_repair",
  "checkpoint_commit", "feature_branch_push", "draft_pr",
  "merge_main", "release", "seal",
]);

// Boolean `allowed` fields per capability (subset of each section).
const ALLOW_FIELDS = Object.freeze({
  decomposition: "allowed",
  independent_review: "allowed",
  bounded_repair: "allowed",
  checkpoint_commit: "allowed",
  feature_branch_push: "allowed",
  draft_pr: "allowed",
  merge_main: "allowed",
  release: "allowed",
  seal: "allowed",
});

// Per-section scalar parameters that participate in intersection (min).
const MIN_FIELDS = Object.freeze({
  decomposition: ["max_depth", "max_total_nodes"],
  bounded_repair: ["max_rounds"],
});

// Per-section flags that must be ANDed (both must hold).
const AND_FIELDS = Object.freeze({
  independent_review: ["require_fresh_session", "require_same_artifact_digest"],
  bounded_repair: ["scope_expansion"],
  checkpoint_commit: ["require_local_gates_pass", "require_clean_index_before_stage", "require_expected_paths_only"],
  feature_branch_push: ["force_push"],
  draft_pr: ["draft_only", "create_if_missing", "update_if_present"],
});

// Per-section string parameters that participate in pattern containment.
const PATTERN_FIELDS = Object.freeze({
  feature_branch_push: ["branch_pattern"],
  draft_pr: ["base_branch"],
});

// ---------------------------------------------------------------------------
// Default deny
// ---------------------------------------------------------------------------

/** Fail-closed empty authority: every capability denied. */
export function defaultDenyAuthority() {
  return {
    decomposition: { allowed: false, max_depth: 0, max_total_nodes: 0 },
    independent_review: { allowed: false, require_fresh_session: false, require_same_artifact_digest: false },
    bounded_repair: { allowed: false, max_rounds: 0, scope_expansion: false },
    checkpoint_commit: { allowed: false, require_local_gates_pass: true, require_clean_index_before_stage: true, require_expected_paths_only: true },
    feature_branch_push: { allowed: false, branch_pattern: "", force_push: false, require_remote_ancestor_check: false },
    draft_pr: { allowed: false, base_branch: "", draft_only: true, create_if_missing: false, update_if_present: false },
    merge_main: { allowed: false },
    release: { allowed: false },
    seal: { allowed: false },
  };
}

// ---------------------------------------------------------------------------
// Normalization + validation
// ---------------------------------------------------------------------------

function normalizeSection(section, value) {
  // Accept missing section as denied (fail-closed).
  if (value === undefined || value === null) return defaultDenyAuthority()[section];
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

/**
 * Validate a raw lifecycle_authorization object (as embedded in an entry
 * card). Returns { valid, errors }. Unknown sections, unknown fields,
 * non-boolean allowed, non-const irreversible sections → invalid.
 */
export function validateLifecycleAuthorization(raw) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { valid: false, errors: ["not_object"] };
  for (const key of Object.keys(raw)) {
    if (!CAPABILITY_SECTIONS.includes(key)) errors.push(`unknown_capability:${key}`);
  }
  for (const section of CAPABILITY_SECTIONS) {
    const v = normalizeSection(section, raw[section]);
    if (v === null) { errors.push(`${section}:not_object`); continue; }
    const schema = SCHEMA.properties.lifecycle_authorization.properties[section];
    if (!schema) { errors.push(`${section}:no_schema`); continue; }
    const allowed = schema.properties.allowed;
    if (allowed && typeof v.allowed !== "boolean") errors.push(`${section}:allowed_not_boolean`);
    // Irreversible sections must be locked to allowed:false.
    if (section === "merge_main" || section === "release" || section === "seal") {
      if (v.allowed !== false) errors.push(`${section}:must_be_false`);
    }
    for (const [field, def] of Object.entries(schema.properties)) {
      if (field === "allowed") continue;
      if (field in v) {
        if (def.type === "integer" && !Number.isInteger(v[field])) errors.push(`${section}.${field}:not_integer`);
        if (def.type === "boolean" && typeof v[field] !== "boolean") errors.push(`${section}.${field}:not_boolean`);
        if (def.type === "string" && typeof v[field] !== "string") errors.push(`${section}.${field}:not_string`);
        if (def.type === "integer" && Number.isInteger(v[field])) {
          if (def.minimum !== undefined && v[field] < def.minimum) errors.push(`${section}.${field}:below_minimum`);
          if (def.maximum !== undefined && v[field] > def.maximum) errors.push(`${section}.${field}:above_maximum`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Normalize a raw block into a canonical authority object (deny-first). */
export function normalizeAuthority(raw) {
  const base = defaultDenyAuthority();
  if (!raw || typeof raw !== "object") return base;
  const check = validateLifecycleAuthorization(raw);
  if (!check.valid) throw hold(GOV_HOLD.AUTHORIZATION_INVALID, check.errors.join(","));
  const out = {};
  for (const section of CAPABILITY_SECTIONS) {
    const v = raw[section];
    if (v === undefined || v === null) { out[section] = base[section]; continue; }
    out[section] = { ...base[section], ...v };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pattern containment (branch patterns like "governance/*")
// ---------------------------------------------------------------------------

function globToRegExp(pattern) {
  // Only "*" wildcard segments supported; no "**"; anchored full match.
  const escaped = pattern.split("*").map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${escaped}$`);
}

/** True if `candidate` matches `pattern` (pattern may contain * segments). */
export function matchesPattern(pattern, candidate) {
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  try { return globToRegExp(pattern).test(candidate); } catch { return false; }
}

/** True if every string matched by `child` is also matched by `parent`. */
export function patternContained(childPattern, parentPattern) {
  if (childPattern === parentPattern) return true;
  if (!parentPattern) return false;
  // Treat both as globs; containment holds when the child glob, restricted to
  // the parent's static prefix, stays within the parent glob. Conservative
  // implementation: child must share the parent's non-wildcard prefix and
  // must not contain "**" or escape segments.
  if (childPattern.includes("**") || parentPattern.includes("**")) return false;
  const parentPrefix = parentPattern.split("*")[0];
  if (!childPattern.startsWith(parentPrefix)) return false;
  // All child wildcards must be within the parent wildcard span.
  const parentSuffix = parentPattern.split("*").slice(1).join("");
  if (parentSuffix && !childPattern.endsWith(parentSuffix)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Effective authority = parent ∩ child ∩ runtime
// ---------------------------------------------------------------------------

/**
 * Compute effective authority. Escalation (child exceeding parent, or either
 * exceeding runtime policy) → HOLD / AUTHORITY_ESCALATION_REJECTED.
 *
 * @param {object} parent  — normalized authority (or raw block)
 * @param {object} child   — normalized authority (or raw block)
 * @param {object} runtime — normalized policy (or raw block); default deny
 * @returns {object} effective authority (canonical shape)
 */
export function effectiveAuthority(parent, child, runtime) {
  const P = normalizeAuthority(parent);
  const C = normalizeAuthority(child);
  const R = normalizeAuthority(runtime);
  const out = {};

  for (const section of CAPABILITY_SECTIONS) {
    const p = P[section], c = C[section], r = R[section];
    const violations = [];

    // 1. allowed — escalation only vs parent: a child must never enable what
    //    its parent denied. Runtime denial is *not* escalation: per §13.3
    //    runtime policy deny overrides card allow (intersection tightens).
    if (c.allowed === true && p.allowed === false) violations.push(`${section}.allowed parent_denied`);
    const allowed = c.allowed === true && p.allowed === true && r.allowed === true;

    // 2. min-parameter caps (max_depth / max_total_nodes / max_rounds) —
    //    child exceeding parent is escalation; runtime caps tighten silently.
    for (const f of MIN_FIELDS[section] ?? []) {
      if (c[f] > p[f]) violations.push(`${section}.${f} exceeds parent`);
    }

    // 3. AND-flags (false = tighter) — child loosening vs parent is escalation;
    //    runtime tightenings intersect silently.
    for (const f of AND_FIELDS[section] ?? []) {
      if (c[f] === false && p[f] === true) violations.push(`${section}.${f} loosened_vs_parent`);
    }

    // 4. force_push is a denial flag: effective true only if any side asks for it.
    if (section === "feature_branch_push") {
      if (c.force_push === true) violations.push("feature_branch_push.force_push forbidden");
    }

    // 5. pattern containment — child escaping parent pattern is escalation;
    //    runtime pattern narrows silently.
    for (const f of PATTERN_FIELDS[section] ?? []) {
      if (c[f] && !patternContained(c[f], p[f])) violations.push(`${section}.${f} escapes parent pattern`);
    }

    if (violations.length > 0) {
      throw hold(GOV_HOLD.AUTHORITY_ESCALATION_REJECTED, violations.join("; "));
    }

    const merged = { ...p, ...c };
    for (const f of MIN_FIELDS[section] ?? []) merged[f] = Math.min(c[f], p[f], r[f]);
    for (const f of AND_FIELDS[section] ?? []) merged[f] = c[f] === true && p[f] === true && r[f] === true;
    if (section === "feature_branch_push") {
      merged.force_push = c.force_push === true || p.force_push === true || r.force_push === true;
      merged.branch_pattern = c.branch_pattern || p.branch_pattern || r.branch_pattern;
      merged.require_remote_ancestor_check = c.require_remote_ancestor_check === true &&
        p.require_remote_ancestor_check === true && r.require_remote_ancestor_check === true;
    }
    merged.allowed = allowed;
    out[section] = merged;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Durable artifact (execDir/governance/lifecycle-authorization.json)
// ---------------------------------------------------------------------------

export function lifecycleAuthorizationPath(execDir) {
  return join(execDir, "governance", "lifecycle-authorization.json");
}

export function authorityDigest(a) {
  return digestOf(canonicalize(a));
}

export function writeLifecycleAuthorization(execDir, record) {
  ensureDir0700(join(execDir, "governance"));
  writeJsonExclusiveCreate(lifecycleAuthorizationPath(execDir), record);
  return record;
}

export function readLifecycleAuthorization(execDir) {
  const p = lifecycleAuthorizationPath(execDir);
  if (!existsSync(p)) throw hold(GOV_HOLD.AUTHORIZATION_MISSING, "lifecycle authorization artifact missing");
  assertNotSymlink(p);
  let record;
  try { record = JSON.parse(readFileSync(p, "utf8")); } catch { throw hold(GOV_HOLD.AUTHORIZATION_MISSING, "lifecycle authorization unreadable"); }
  const block = record.lifecycle_authorization;
  const check = validateLifecycleAuthorization(block);
  if (!check.valid) throw hold(GOV_HOLD.AUTHORIZATION_INVALID, check.errors.join(","));
  return record;
}
