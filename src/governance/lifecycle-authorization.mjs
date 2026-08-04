// src/governance/lifecycle-authorization.mjs
//
// Review-unit lifecycle authorization contract (schema v2):
//  - schema-backed validation of the entry-card authorization record
//  - effective authority = parent ∩ child ∩ runtime policy (fail-closed)
//  - escalation detection → HOLD / AUTHORITY_ESCALATION_REJECTED
//
// Field semantics (§7 of AUTOLOOP-GOVERNANCE-REVIEW-UNIT-FINALIZATION-1):
//  - RESTRICTIVE_FIELDS  : true = stricter requirement. Effective = union
//    (p || c || r): no looser party (child or runtime) can cancel a stricter
//    requirement. Child loosening vs parent is escalation.
//  - CAPABILITY_FIELDS   : true = more capability. Effective = AND (p && c && r);
//    child requesting a capability the parent denied is escalation; runtime
//    deny tightens silently. Runtime can never *grant* beyond the parent.
//  - MIN_FIELDS          : integer caps. Effective = min(p, c, r); child
//    exceeding parent is escalation; runtime caps tighten silently.
//  - PATTERN_FIELDS      : containment intersection; when the intersection
//    cannot be proven, fail-closed HOLD (never pick the wider pattern).
//  - IDENTITY_FIELDS     : exact equality across all parties; conflict → HOLD.
//  - top-level bindings  : repository / worktree / branch / base / base_head /
//    authorized_paths / bundle_path — real identity intersection, never
//    `child || parent || runtime`.
//
// Reuses c2d conventions (C2dHoldError, canonical digest, fs-atomic) and the
// existing C3B/C3C fail-closed posture. Never touches git refs, never pushes,
// never merges, never seals. Absent authorization ⇒ all denied.

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
  "external_review", "review_unit", "merge_main", "release", "seal",
]);

// Boolean `allowed` fields per capability (subset of each section).
const ALLOW_FIELDS = Object.freeze({
  decomposition: "allowed",
  independent_review: "allowed",
  bounded_repair: "allowed",
  checkpoint_commit: "allowed",
  feature_branch_push: "allowed",
  draft_pr: "allowed",
  review_unit: "allowed",
  merge_main: "allowed",
  release: "allowed",
  seal: "allowed",
});

// true = stricter requirement; effective is a union (nothing can cancel it).
const RESTRICTIVE_FIELDS = Object.freeze({
  independent_review: ["require_fresh_session", "require_same_artifact_digest"],
  checkpoint_commit: ["require_local_gates_pass", "require_clean_index_before_stage", "require_expected_paths_only"],
  feature_branch_push: ["require_remote_ancestor_check"],
  draft_pr: ["draft_only"],
  external_review: ["required", "require_bundle"],
});

// true = increases capability; effective is an AND (all parties must allow).
const CAPABILITY_FIELDS = Object.freeze({
  bounded_repair: ["scope_expansion"],
  feature_branch_push: ["force_push"],
  draft_pr: ["create_if_missing", "update_if_present"],
});

// Integer caps (child exceeding parent is escalation; effective = min).
const MIN_FIELDS = Object.freeze({
  decomposition: ["max_depth", "max_total_nodes"],
  bounded_repair: ["max_rounds"],
  review_unit: [
    "repository_count", "worktree_count", "parent_card_count",
    "architecture_goal_count", "maximum_internal_milestones",
    "maximum_changed_paths", "maximum_patch_lines", "maximum_repair_rounds",
  ],
});

// String patterns participating in containment intersection.
const PATTERN_FIELDS = Object.freeze({
  feature_branch_push: ["branch_pattern"],
});

// String identity fields: exact equality across all parties, else HOLD.
const IDENTITY_FIELDS = Object.freeze({
  draft_pr: ["base_branch"],
  external_review: ["bundle_path"],
});

// Top-level binding fields on the authorization record (not the block).
export const TOP_LEVEL_BINDINGS = Object.freeze([
  "repository", "worktree", "branch", "base", "base_head",
  "authorized_paths", "bundle_path",
]);

// ---------------------------------------------------------------------------
// Default deny
// ---------------------------------------------------------------------------

/** Fail-closed empty authority: every capability denied, no review unit. */
export function defaultDenyAuthority() {
  return {
    decomposition: { allowed: false, max_depth: 0, max_total_nodes: 0 },
    independent_review: { allowed: false, require_fresh_session: false, require_same_artifact_digest: false },
    bounded_repair: { allowed: false, max_rounds: 0, scope_expansion: false },
    checkpoint_commit: { allowed: false, require_local_gates_pass: true, require_clean_index_before_stage: true, require_expected_paths_only: true },
    feature_branch_push: { allowed: false, branch_pattern: "", force_push: false, require_remote_ancestor_check: false },
    draft_pr: { allowed: false, base_branch: "", draft_only: true, create_if_missing: false, update_if_present: false },
    external_review: { required: false, require_bundle: false, bundle_path: "" },
    review_unit: { allowed: false, repository_count: 0, worktree_count: 0, parent_card_count: 0, architecture_goal_count: 0, maximum_internal_milestones: 0, maximum_changed_paths: 0, maximum_patch_lines: 0, maximum_repair_rounds: 0 },
    merge_main: { allowed: false },
    release: { allowed: false },
    seal: { allowed: false },
  };
}

export function defaultDenyTopLevel() {
  return {
    repository: "",
    worktree: "",
    branch: "",
    base: "",
    base_head: "",
    authorized_paths: [],
    bundle_path: "",
  };
}

/**
 * Neutral runtime policy: no narrowing (pass-through). Used only when the
 * caller supplies NO runtime policy at all. A neutral runtime never grants
 * beyond parent ∩ child and never zeroes declared caps; it simply does not
 * add restrictions. An explicitly-provided runtime must be a complete,
 * schema-valid block (deny-first for omitted fields).
 */
export function neutralRuntimeAuthority() {
  return {
    decomposition: { allowed: true, max_depth: Infinity, max_total_nodes: Infinity },
    independent_review: { allowed: true, require_fresh_session: false, require_same_artifact_digest: false },
    bounded_repair: { allowed: true, max_rounds: Infinity, scope_expansion: true },
    checkpoint_commit: { allowed: true, require_local_gates_pass: false, require_clean_index_before_stage: false, require_expected_paths_only: false },
    feature_branch_push: { allowed: true, branch_pattern: "", force_push: true, require_remote_ancestor_check: false },
    draft_pr: { allowed: true, base_branch: "", draft_only: false, create_if_missing: true, update_if_present: true },
    external_review: { required: false, require_bundle: false, bundle_path: "" },
    review_unit: { allowed: true, repository_count: Infinity, worktree_count: Infinity, parent_card_count: Infinity, architecture_goal_count: Infinity, maximum_internal_milestones: Infinity, maximum_changed_paths: Infinity, maximum_patch_lines: Infinity, maximum_repair_rounds: Infinity },
    merge_main: { allowed: false },
    release: { allowed: false },
    seal: { allowed: false },
  };
}

// ---------------------------------------------------------------------------
// Minimal schema evaluator (parity with lifecycle-authorization.schema.json)
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Evaluate a value against the JSON-Schema subset used by the lifecycle
 * authorization schema (draft-07): type / required / additionalProperties /
 * properties / items / minLength / maxLength / minimum / maximum / const /
 * pattern / enum / format(date-time). Returns list of error strings.
 */
export function validateAgainstSchema(schema, value, path) {
  const errors = [];
  if (!isPlainObject(schema)) return errors;

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}:const expected ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}:enum`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) => {
      if (t === "object") return isPlainObject(value);
      if (t === "array") return Array.isArray(value);
      if (t === "string") return typeof value === "string";
      if (t === "integer") return Number.isInteger(value);
      if (t === "boolean") return typeof value === "boolean";
      if (t === "number") return typeof value === "number" && Number.isFinite(value);
      return false;
    });
    if (!ok) {
      errors.push(`${path}:type expected ${schema.type.join ? schema.type.join("/") : schema.type}`);
      return errors; // cannot go deeper on a wrong type
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}:minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}:maxLength ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}:pattern`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path}:format date-time`);
  }
  if (typeof value === "number" || Number.isInteger(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}:below_minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}:above_maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}:minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}:maxItems ${schema.maxItems}`);
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validateAgainstSchema(schema.items, item, `${path}[${i}]`)));
    }
  }
  if (isPlainObject(value)) {
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) errors.push(`${path}:additional_properties:${key}`);
      }
    }
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value)) errors.push(`${path}:required_missing:${key}`);
      }
    }
    for (const [key, subschema] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validateAgainstSchema(subschema, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Normalization + validation (single contract with the schema)
// ---------------------------------------------------------------------------

function normalizeSection(section, value) {
  // Accept missing section as denied (fail-closed).
  if (value === undefined || value === null) return defaultDenyAuthority()[section];
  if (!isPlainObject(value)) return null;
  return value;
}

/**
 * Validate a raw lifecycle_authorization block. Mirrors the schema exactly:
 * unknown sections/fields rejected, required fields enforced, types, bounds,
 * consts (merge_main/release/seal allowed=false, review-unit count caps).
 */
export function validateLifecycleAuthorization(raw) {
  if (!isPlainObject(raw)) return { valid: false, errors: ["lifecycle_authorization:type"] };
  const schema = SCHEMA.properties.lifecycle_authorization;
  const errors = validateAgainstSchema(schema, raw, "lifecycle_authorization");
  for (const key of Object.keys(raw)) {
    if (!CAPABILITY_SECTIONS.includes(key)) errors.push(`lifecycle_authorization:unknown_capability:${key}`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a full authorization record (top-level bindings + block).
 */
export function validateAuthorityRecord(raw) {
  if (!isPlainObject(raw)) return { valid: false, errors: ["record:type"] };
  const errors = validateAgainstSchema(SCHEMA, raw, "record");
  errors.push(...validateLifecycleAuthorization(raw.lifecycle_authorization).errors);
  return { valid: errors.length === 0, errors };
}

/** Normalize a raw block into a canonical authority object (deny-first). */
export function normalizeAuthority(raw) {
  const base = defaultDenyAuthority();
  if (!raw || !isPlainObject(raw)) return base;
  const check = validateLifecycleAuthorization(raw);
  if (!check.valid) throw hold(GOV_HOLD.AUTHORIZATION_INVALID, check.errors.join(","));
  const out = {};
  for (const section of CAPABILITY_SECTIONS) {
    const v = normalizeSection(section, raw[section]);
    if (v === null) throw hold(GOV_HOLD.AUTHORIZATION_INVALID, `${section}:not_object`);
    out[section] = { ...base[section], ...v };
  }
  return out;
}

/** Normalize the top-level binding fields of a record (deny-first). */
export function normalizeTopLevel(raw) {
  const base = defaultDenyTopLevel();
  if (!isPlainObject(raw)) return base;
  const out = { ...base };
  for (const field of TOP_LEVEL_BINDINGS) {
    if (field in raw && raw[field] !== undefined && raw[field] !== null) {
      if (field === "authorized_paths") {
        out[field] = Array.isArray(raw[field])
          ? raw[field].filter((p) => typeof p === "string" && p.length > 0)
          : [];
      } else {
        out[field] = String(raw[field]);
      }
    }
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
  if (childPattern.includes("**") || parentPattern.includes("**")) return false;
  const parentPrefix = parentPattern.split("*")[0];
  if (!childPattern.startsWith(parentPrefix)) return false;
  const parentSuffix = parentPattern.split("*").slice(1).join("");
  if (parentSuffix && !childPattern.endsWith(parentSuffix)) return false;
  return true;
}

/**
 * True if `candidate` path is inside `scope` (exact file paths, dirs with
 * trailing slash, or bare directory prefixes).
 */
export function scopeCovers(p, scope) {
  if (!Array.isArray(scope)) return false;
  return scope.some((allowed) => {
    if (typeof allowed !== "string") return false;
    if (allowed === p) return true;
    if (allowed.endsWith("/") && p.startsWith(allowed)) return true;
    if (p.startsWith(allowed + "/")) return true;
    if (p.endsWith("/")) return allowed.startsWith(p) || allowed === p.slice(0, -1);
    return false;
  });
}

// ---------------------------------------------------------------------------
// Intersection helpers
// ---------------------------------------------------------------------------

function intersectIdentity(parent, child, runtime, label) {
  const declared = [parent, child, runtime].filter((v) => typeof v === "string" && v.length > 0);
  if (declared.length === 0) return "";
  const first = declared[0];
  if (declared.some((v) => v !== first)) {
    throw hold(GOV_HOLD.AUTHORITY_ESCALATION_REJECTED, `${label} identity conflict: ${declared.join(" != ")}`);
  }
  return first;
}

function intersectPatterns(parent, child, runtime, label) {
  const declared = [];
  if (typeof parent === "string" && parent) declared.push(["parent", parent]);
  if (typeof child === "string" && child) declared.push(["child", child]);
  if (typeof runtime === "string" && runtime) declared.push(["runtime", runtime]);
  if (declared.length === 0) return "";
  if (declared.length === 1) return declared[0][1];
  const parentEntry = declared.find(([n]) => n === "parent");
  const childEntry = declared.find(([n]) => n === "child");
  if (childEntry && parentEntry && !patternContained(childEntry[1], parentEntry[1])) {
    throw hold(GOV_HOLD.AUTHORITY_ESCALATION_REJECTED, `${label} escapes parent pattern: ${childEntry[1]} not in ${parentEntry[1]}`);
  }
  // Effective = narrowest declared pattern provably contained in all others;
  // if the intersection cannot be proven, fail-closed HOLD (never the wider).
  for (const [name, cand] of declared) {
    if (declared.every(([n2, p2]) => n2 === name || patternContained(cand, p2))) return cand;
  }
  throw hold(GOV_HOLD.AUTHORITY_ESCALATION_REJECTED, `${label}: cannot compute safe pattern intersection (fail-closed)`);
}

function intersectPaths(childPaths, parentPaths, runtimePaths, label) {
  if (!Array.isArray(childPaths)) childPaths = [];
  if (!Array.isArray(parentPaths)) parentPaths = [];
  if (!Array.isArray(runtimePaths)) runtimePaths = [];
  if (childPaths.length > 0 && parentPaths.length === 0) {
    throw hold(GOV_HOLD.AUTHORITY_ESCALATION_REJECTED, `${label}: child declares scope with no parent scope (cannot create scope from nothing)`);
  }
  if (childPaths.length === 0) {
    // child inherits the parent scope, narrowed by runtime when it declares one
    if (runtimePaths.length === 0) return [...parentPaths];
    return parentPaths.filter((p) => scopeCovers(p, runtimePaths));
  }
  const effective = [];
  for (const p of childPaths) {
    if (!scopeCovers(p, parentPaths)) {
      throw hold(GOV_HOLD.AUTHORITY_ESCALATION_REJECTED, `${label}: ${p} escapes parent scope`);
    }
    if (runtimePaths.length === 0 || scopeCovers(p, runtimePaths)) effective.push(p);
  }
  return effective;
}

// ---------------------------------------------------------------------------
// Effective authority = parent ∩ child ∩ runtime
// ---------------------------------------------------------------------------

function normalizeInput(input, mode = "deny") {
  if (!isPlainObject(input)) {
    return mode === "runtime"
      ? { top: defaultDenyTopLevel(), auth: neutralRuntimeAuthority() }
      : { top: defaultDenyTopLevel(), auth: defaultDenyAuthority() };
  }
  // Accept either a full record { lifecycle_authorization, ... } or a block.
  if (isPlainObject(input.lifecycle_authorization)) {
    return { top: normalizeTopLevel(input), auth: normalizeAuthority(input.lifecycle_authorization) };
  }
  return { top: defaultDenyTopLevel(), auth: normalizeAuthority(input) };
}

/**
 * Compute effective authority. Escalation (child exceeding parent, or either
 * exceeding runtime policy in the capability direction) → HOLD /
 * AUTHORITY_ESCALATION_REJECTED.
 *
 * @param {object} parent  — full record or raw block
 * @param {object} child   — full record or raw block
 * @param {object} runtime — policy record or raw block (default deny)
 * @returns {object} effective authority record (canonical shape)
 */
export function effectiveAuthority(parent, child, runtime) {
  const { top: Tp, auth: P } = normalizeInput(parent, "deny");
  const { top: Tc, auth: C } = normalizeInput(child, "deny");
  const { top: Tr, auth: R } = normalizeInput(runtime, "runtime");
  const out = {};

  for (const section of CAPABILITY_SECTIONS) {
    const p = P[section], c = C[section], r = R[section];
    const violations = [];
    const isAllowSection = Boolean(ALLOW_FIELDS[section]);

    // 1. allowed — capability: escalation only vs parent (child must never
    //    enable what its parent denied); runtime deny is *not* escalation.
    if (isAllowSection && c.allowed === true && p.allowed === false) violations.push(`${section}.allowed parent_denied`);
    const allowed = !isAllowSection || (c.allowed === true && p.allowed === true && r.allowed === true);

    // 2. min-parameter caps — child exceeding parent is escalation; runtime
    //    caps tighten silently.
    for (const f of MIN_FIELDS[section] ?? []) {
      if (c[f] > p[f]) violations.push(`${section}.${f} exceeds parent`);
    }

    // 3. restrictive requirements (true = stricter) — child loosening vs
    //    parent is escalation; effective is a union so no looser runtime can
    //    cancel the stricter requirement.
    for (const f of RESTRICTIVE_FIELDS[section] ?? []) {
      if (c[f] === false && p[f] === true) violations.push(`${section}.${f} loosened_vs_parent`);
    }

    // 4. capability flags (true = more power) — child requesting what the
    //    parent denied is escalation; effective is AND.
    for (const f of CAPABILITY_FIELDS[section] ?? []) {
      if (c[f] === true && p[f] === false) violations.push(`${section}.${f} capability_exceeds_parent`);
    }

    // 5. pattern containment — child escaping parent pattern is escalation.
    for (const f of PATTERN_FIELDS[section] ?? []) {
      if (c[f] && !patternContained(c[f], p[f])) violations.push(`${section}.${f} escapes parent pattern`);
    }

    // 6. identity fields — child differing from parent is escalation.
    for (const f of IDENTITY_FIELDS[section] ?? []) {
      if (c[f] && p[f] && c[f] !== p[f]) violations.push(`${section}.${f} identity_conflict`);
    }

    if (violations.length > 0) {
      throw hold(GOV_HOLD.AUTHORITY_ESCALATION_REJECTED, violations.join("; "));
    }

    const merged = { ...p, ...c };
    for (const f of MIN_FIELDS[section] ?? []) merged[f] = Math.min(c[f], p[f], r[f]);
    for (const f of RESTRICTIVE_FIELDS[section] ?? []) merged[f] = p[f] === true || c[f] === true || r[f] === true;
    for (const f of CAPABILITY_FIELDS[section] ?? []) merged[f] = c[f] === true && p[f] === true && r[f] === true;
    for (const f of PATTERN_FIELDS[section] ?? []) {
      merged[f] = intersectPatterns(p[f], c[f], r[f], `${section}.${f}`);
    }
    for (const f of IDENTITY_FIELDS[section] ?? []) {
      merged[f] = intersectIdentity(p[f], c[f], r[f], `${section}.${f}`);
    }
    if (isAllowSection) merged.allowed = allowed;
    out[section] = merged;
  }

  // Top-level bindings (real identity intersection).
  const top = {
    repository: intersectIdentity(Tp.repository, Tc.repository, Tr.repository, "repository"),
    worktree: intersectIdentity(Tp.worktree, Tc.worktree, Tr.worktree, "worktree"),
    branch: intersectIdentity(Tp.branch, Tc.branch, Tr.branch, "branch"),
    base: intersectIdentity(Tp.base, Tc.base, Tr.base, "base"),
    base_head: intersectIdentity(Tp.base_head, Tc.base_head, Tr.base_head, "base_head"),
    authorized_paths: intersectPaths(Tc.authorized_paths, Tp.authorized_paths, Tr.authorized_paths, "authorized_paths"),
    bundle_path: intersectIdentity(Tp.bundle_path, Tc.bundle_path, Tr.bundle_path, "bundle_path"),
  };

  return { ...out, ...top };
}

// ---------------------------------------------------------------------------
// Durable artifact (execDir/governance/lifecycle-authorization.json)
// ---------------------------------------------------------------------------

export function lifecycleAuthorizationPath(execDir) {
  return join(execDir, "governance", "lifecycle-authorization.json");
}

// ---------------------------------------------------------------------------
// Canonical repair budget (round 5 finding)
// ---------------------------------------------------------------------------
//
// The same effective authority carries TWO repair caps:
//   bounded_repair.max_rounds          (bounded-repair capability)
//   review_unit.maximum_repair_rounds  (review-unit boundary)
//
// The canonical cap is their strict intersection (min). Any finite mismatch
// between the two is an authority conflict and is rejected fail-closed — a
// card must declare ONE consistent repair budget.

function finiteCap(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Canonical repair cap = min(bounded_repair.max_rounds, review_unit.maximum_repair_rounds). */
export function effectiveRepairCap(authority) {
  const bounded = authority?.bounded_repair?.max_rounds;
  const unit = authority?.review_unit?.maximum_repair_rounds;
  if (!finiteCap(bounded) && !finiteCap(unit)) return Infinity;
  if (!finiteCap(bounded)) return unit;
  if (!finiteCap(unit)) return bounded;
  return Math.min(bounded, unit);
}

/**
 * When BOTH repair caps are finite and differ, the record itself is
 * self-contradictory (e.g. bounded_repair.max_rounds 2 vs
 * review_unit.maximum_repair_rounds 3) — returns a human-readable conflict
 * description, or null when the record is consistent.
 */
export function repairCapConflict(authority) {
  const bounded = authority?.bounded_repair?.max_rounds;
  const unit = authority?.review_unit?.maximum_repair_rounds;
  if (!finiteCap(bounded) || !finiteCap(unit) || bounded === unit) return null;
  return `bounded_repair.max_rounds ${bounded} != review_unit.maximum_repair_rounds ${unit} (effective repair cap = min = ${Math.min(bounded, unit)})`;
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
  const check = validateAuthorityRecord(record);
  if (!check.valid) throw hold(GOV_HOLD.AUTHORIZATION_INVALID, check.errors.join(","));
  return record;
}

export { C2dHoldError };
