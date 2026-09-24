// src/evolution/policy.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Sections C + D:
// risk classification + durable policy preauthorization.
//
// POLICY-PREAUTHORIZED AUTONOMOUS EVOLUTION (card target): a LOW-risk
// candidate that matches the frozen policy is authorized by the POLICY
// AUTHORITY — a durable, digest-bound artifact the operator issues ONCE —
// instead of a per-attempt operator mutation authorization. This replaces
// the per-candidate human step for LOW risk ONLY; MEDIUM keeps the existing
// operator authorization boundary and HIGH never mutates at all.
//
// Hard rules (card §C/§D/§M):
//   - NOT blanket authority: the policy binds baseline, scope patterns,
//     risk class, expiry/generation, allowed commands, validation plan and
//     a resource budget. Anything outside the binding fails closed.
//   - HIGH-risk classes (security/credentials, governance authority,
//     admission authority, promotion authority itself, secret handling,
//     destructive persistence migration, irreversible data ops, the
//     evolution policy itself) are UNCONDITIONALLY refused autonomous
//     mutation — the classifier cannot be talked out of them.
//   - The policy artifact is durable, exclusive-create, digest-bound and
//     expiry-checked exactly like the C3B mutation authorization it
//     substitutes for (same artifact conventions, different authority_type).
//   - The policy NEVER widens existing governance: admission, review,
//     promotion and semantic-drift gates still apply downstream.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { C2dHoldError, ensureDir0700, writeJsonExclusiveCreate, assertNotSymlink } from "../c2d/fs-atomic.mjs";
import { canonicalize, digestOf } from "../canonical-digest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(readFileSync(join(HERE, "..", "schema", "evolution-policy.schema.json"), "utf8"));

export const EVOLUTION_POLICY_SCHEMA = "autoloop.evolution-policy/v1";
export const EVOLUTION_POLICY_HOLD = Object.freeze({
  INVALID: "HOLD / EVOLUTION_POLICY_INVALID",
  EXPIRED: "HOLD / EVOLUTION_POLICY_EXPIRED",
  CONFLICT: "HOLD / EVOLUTION_POLICY_CONFLICT",
  RISK_CLASS_REFUSED: "HOLD / EVOLUTION_RISK_CLASS_REFUSED",
  SCOPE_OUTSIDE_POLICY: "HOLD / EVOLUTION_SCOPE_OUTSIDE_POLICY",
  COMMAND_NOT_ALLOWED: "HOLD / EVOLUTION_COMMAND_NOT_ALLOWED",
  BUDGET_EXHAUSTED: "HOLD / EVOLUTION_BUDGET_EXHAUSTED",
  CIRCUIT_BREAKER: "HOLD / EVOLUTION_CIRCUIT_BREAKER_TRIPPED",
  BASELINE_MISMATCH: "HOLD / EVOLUTION_BASELINE_MISMATCH",
});

// Card §C HIGH-risk classes — NEVER autonomous, in any policy.
export const HIGH_RISK_CLASSES = Object.freeze([
  "SECURITY_OR_CREDENTIALS",
  "GOVERNANCE_AUTHORITY",
  "ADMISSION_AUTHORITY",
  "PROMOTION_AUTHORITY",
  "SECRET_HANDLING",
  "DESTRUCTIVE_PERSISTENCE_MIGRATION",
  "IRREVERSIBLE_DATA_OPERATION",
  "EVOLUTION_POLICY_SELF",
]);

export const RISK_CLASSES = Object.freeze(["LOW", "MEDIUM", "HIGH"]);

export const evolutionPolicyPath = (policyRoot) => join(policyRoot, "evolution-policy.json");

export function computePolicyDigest(p) {
  const { policy_digest, ...rest } = p ?? {};
  return digestOf(rest);
}

function pathPatternSafe(p) {
  return typeof p === "string" && p.length > 0 && !/^\s*$/.test(p) && !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && !p.split("/").includes("..");
}

function commandAllowed(cmd) {
  return typeof cmd === "string" && cmd.length > 0 && !cmd.includes("\0") && !/^\s*$/.test(cmd);
}

/** Structural validation of a policy record (mirrors the JSON schema; the
 * repo's minimal validator lacks pattern/maxLength so the strict checks
 * live here — same convention as mutation-authority.mjs). */
export function validatePolicyShape(p) {
  const errors = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["not_object"];
  const required = SCHEMA.required;
  for (const k of required) if (!(k in p)) errors.push(`missing_${k}`);
  for (const k of Object.keys(p)) if (!SCHEMA.properties[k]) errors.push(`unknown_${k}`);
  if (p.schema !== EVOLUTION_POLICY_SCHEMA) errors.push("schema_invalid");
  if (p.authority_type !== "evolution_policy") errors.push("authority_type_invalid");
  if (!/^[0-9a-f]{64}$/.test(p.policy_id || "")) errors.push("policy_id_invalid");
  if (!/^[0-9a-f]{64}$/.test(p.policy_digest || "")) errors.push("policy_digest_invalid");
  if (typeof p.policy_name !== "string" || p.policy_name.length === 0 || p.policy_name.length > 128) errors.push("policy_name_invalid");
  if (p.risk_classes_allowed === undefined) {
    // default: LOW only
  } else if (!Array.isArray(p.risk_classes_allowed) || !p.risk_classes_allowed.length
      || !p.risk_classes_allowed.every((r) => RISK_CLASSES.includes(r))
      || p.risk_classes_allowed.includes("HIGH")
      || new Set(p.risk_classes_allowed).size !== p.risk_classes_allowed.length) {
    errors.push("risk_classes_invalid");
  }
  if (!Array.isArray(p.scope_patterns) || !p.scope_patterns.length || !p.scope_patterns.every(pathPatternSafe)
      || new Set(p.scope_patterns).size !== p.scope_patterns.length) errors.push("scope_patterns_invalid");
  if (!Array.isArray(p.forbidden_patterns) || !p.forbidden_patterns.every(pathPatternSafe)) errors.push("forbidden_patterns_invalid");
  // forbidden patterns must always include the HIGH-risk surfaces (defense in
  // depth: even a hand-forged policy cannot silently unforbid them)
  const forbiddenSet = new Set(p.forbidden_patterns ?? []);
  for (const must of ["src/governance/**", "src/admission/**", "src/evolution/**", ".git/**", "docs/governance/**"]) {
    if (!forbiddenSet.has(must)) errors.push(`forbidden_missing:${must}`);
  }
  if (!Array.isArray(p.allowed_commands) || !p.allowed_commands.length || !p.allowed_commands.every(commandAllowed)) errors.push("allowed_commands_invalid");
  if (typeof p.validation_plan_id !== "string" || p.validation_plan_id.length === 0 || p.validation_plan_id.length > 128) errors.push("validation_plan_id_invalid");
  if (!p.validation_plan || typeof p.validation_plan !== "object" || !Array.isArray(p.validation_plan.commands) || !p.validation_plan.commands.length) errors.push("validation_plan_invalid");
  else {
    for (const c of p.validation_plan.commands) {
      if (!c || typeof c !== "object" || !commandAllowed(c.cmd) || !Array.isArray(c.args) || !c.args.every((a) => typeof a === "string" && !a.includes("\0"))) errors.push("validation_command_invalid");
      if (c.timeout_ms !== undefined && (!Number.isFinite(c.timeout_ms) || c.timeout_ms <= 0)) errors.push("validation_timeout_invalid");
    }
  }
  if (!p.budget || typeof p.budget !== "object") errors.push("budget_invalid");
  else {
    for (const k of ["max_mutation_runs", "max_wall_clock_ms_per_run", "max_evolutions_per_window", "window_ms"]) {
      const v = p.budget[k];
      if (!Number.isInteger(v) || v < 0) errors.push(`budget_${k}_invalid`);
    }
  }
  if (typeof p.issued_by !== "string" || p.issued_by.length === 0 || p.issued_by.length > 128) errors.push("issued_by_invalid");
  if (typeof p.authorization_ref !== "string" || p.authorization_ref.length === 0 || p.authorization_ref.length > 256) errors.push("authorization_ref_invalid");
  if (!p.issued_at || Number.isNaN(Date.parse(p.issued_at))) errors.push("issued_at_invalid");
  if (!p.expires_at || Number.isNaN(Date.parse(p.expires_at))) errors.push("expires_at_invalid");
  if (!errors.includes("issued_at_invalid") && !errors.includes("expires_at_invalid") && Date.parse(p.expires_at) <= Date.parse(p.issued_at)) errors.push("expiry_ordering_invalid");
  if (p.generation !== undefined && (!Number.isInteger(p.generation) || p.generation < 0)) errors.push("generation_invalid");
  if (!p.forbidden_risk_classes || !Array.isArray(p.forbidden_risk_classes) || !HIGH_RISK_CLASSES.every((c) => p.forbidden_risk_classes.includes(c))) errors.push("forbidden_risk_classes_incomplete");
  if (!errors.length && p.policy_id !== digestOf({ ...p, policy_id: undefined, policy_digest: undefined })) errors.push("policy_id_mismatch");
  if (!errors.length && computePolicyDigest(p) !== p.policy_digest) errors.push("policy_digest_mismatch");
  return errors;
}

/**
 * THE lawful policy producer (operator/Controller step; the evolution
 * subsystem itself can never mint or amend its own policy — HIGH_RISK
 * class EVOLUTION_POLICY_SELF). Exclusive-create; identical re-issue is
 * idempotent; any conflicting record fails closed.
 */
export function createEvolutionPolicy(policyRoot, input) {
  const now = new Date().toISOString();
  const identity = {
    schema: EVOLUTION_POLICY_SCHEMA,
    authority_type: "evolution_policy",
    policy_name: input.policy_name,
    risk_classes_allowed: input.risk_classes_allowed !== undefined ? [...input.risk_classes_allowed].sort() : ["LOW"],
    scope_patterns: [...input.scope_patterns].sort(),
    forbidden_patterns: [...new Set([
      ...["src/governance/**", "src/admission/**", "src/evolution/**", ".git/**", "docs/governance/**"],
      ...(input.forbidden_patterns ?? []),
    ])].sort(),
    allowed_commands: [...input.allowed_commands].sort(),
    validation_plan_id: input.validation_plan_id,
    validation_plan: input.validation_plan,
    budget: input.budget,
    issued_by: input.issued_by,
    authorization_ref: input.authorization_ref,
    issued_at: now,
    expires_at: input.expires_at,
    generation: input.generation ?? 0,
    forbidden_risk_classes: [...HIGH_RISK_CLASSES],
  };
  const policy_id = digestOf({ ...identity, policy_id: undefined, policy_digest: undefined });
  const draft = { ...identity, policy_id };
  const record = { ...draft, policy_digest: computePolicyDigest(draft) };
  const errors = validatePolicyShape(record);
  if (errors.length) throw new C2dHoldError(EVOLUTION_POLICY_HOLD.INVALID, errors.join(","));
  ensureDir0700(policyRoot);
  const p = evolutionPolicyPath(policyRoot);
  if (existsSync(p)) {
    assertNotSymlink(p);
    const old = readEvolutionPolicy(policyRoot, { allowExpired: true });
    if (old.policy_id === record.policy_id) return { status: "AUTHORIZED_EXISTING_IDENTICAL", policy: old };
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.CONFLICT, "a different evolution policy already exists (issue a successor generation explicitly)");
  }
  try {
    writeJsonExclusiveCreate(p, record);
  } catch {
    const old = readEvolutionPolicy(policyRoot, { allowExpired: true });
    if (old.policy_id === record.policy_id) return { status: "AUTHORIZED_EXISTING_IDENTICAL", policy: old };
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.CONFLICT, "conflicting evolution policy created concurrently");
  }
  return { status: "AUTHORIZED_CREATED", policy: Object.freeze(record) };
}

/** Fail-closed policy read. Expired → HOLD unless explicitly allowed. */
export function readEvolutionPolicy(policyRoot, { allowExpired = false } = {}) {
  const p = evolutionPolicyPath(policyRoot);
  if (!existsSync(p)) throw new C2dHoldError(EVOLUTION_POLICY_HOLD.INVALID, "evolution policy missing (autonomous evolution not authorized)");
  assertNotSymlink(p);
  let record;
  try { record = JSON.parse(readFileSync(p, "utf8")); } catch { throw new C2dHoldError(EVOLUTION_POLICY_HOLD.INVALID, "evolution policy unreadable"); }
  const errors = validatePolicyShape(record);
  if (errors.length) throw new C2dHoldError(EVOLUTION_POLICY_HOLD.INVALID, errors.join(","));
  if (!allowExpired && Date.parse(record.expires_at) <= Date.now()) {
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.EXPIRED, "evolution policy expired");
  }
  return Object.freeze(record);
}

// ── Section C — risk classification ────────────────────────────────────────

/**
 * Classify one improvement candidate into the evolution risk ladder.
 * Deterministic: identical facts ⇒ identical class. HIGH classes are
 * absolute (keyword/inventory based over the affected scope + the candidate's
 * own declared mutation character) — never judgement calls.
 *
 * @param {object} candidate — derived candidate (see candidate.mjs)
 * @returns {{ riskClass: "LOW"|"MEDIUM"|"HIGH", reasons: string[] }}
 */
export function classifyCandidateRisk(candidate) {
  const reasons = [];
  const scope = [...(candidate.affected_scope ?? [])];
  const highScopeMarkers = [
    "src/governance/", "src/admission/", "src/evolution/", "src/budget/",
    "src/schema/", "docs/governance/", ".git", "src/c2d/",
    "src/memory/writeback/", "src/learning/lifecycle/",
  ];
  for (const p of scope) {
    for (const m of highScopeMarkers) {
      if (p === m.replace(/\/$/, "") || p.startsWith(m)) {
        reasons.push(`high_scope:${p} matches ${m}**`);
      }
    }
  }
  const declared = candidate.declared_risk_markers ?? [];
  for (const marker of declared) {
    if (HIGH_RISK_CLASSES.includes(marker)) reasons.push(`declared_high:${marker}`);
  }
  if (reasons.length > 0) return { riskClass: "HIGH", reasons };

  // MEDIUM markers: multi-file scope, authority-adjacent glue, migration-like
  // changes, schema files, or the candidate exceeding single-concern bounds.
  if (scope.length > 8) reasons.push(`scope_breadth:${scope.length} paths`);
  if (scope.some((p) => p.includes("schema") || p.includes("migration") || p.includes("config")) ) reasons.push("schema_or_migration_like_path");
  if ((candidate.expected_improvement?.kind ?? "") === "behavioral" && scope.length > 3) reasons.push("behavioral_multi_path");
  if (reasons.length > 0) return { riskClass: "MEDIUM", reasons };

  // LOW: bounded, deterministic, single-concern changes inside the policy scope.
  reasons.push("bounded_single_concern_scope");
  reasons.push("no_authority_surface_touched");
  return { riskClass: "LOW", reasons };
}

/**
 * Policy authorization check for ONE candidate (replaces the per-attempt
 * operator mutation authorization for LOW-risk candidates). Returns the
 * C3B-compatible authorization INPUT the candidate pipeline may hand to
 * createMutationAuthorization — or fails closed with the exact hold code.
 *
 * @param {object} p
 * @param {object} p.policy — readEvolutionPolicy result
 * @param {object} p.classification — classifyCandidateRisk result
 * @param {string[]} p.mutationPaths — the candidate's exact intended paths
 * @param {string} p.baselineHead — the run's frozen baseline HEAD
 * @param {object} p.usage — { mutationRuns, wallClockMs, evolutionsInWindow } current counters
 */
export function authorizeUnderPolicy({ policy, classification, mutationPaths, baselineHead, usage }) {
  if (classification.riskClass === "HIGH") {
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.RISK_CLASS_REFUSED, `HIGH-risk candidate: ${classification.reasons.join("; ")}`);
  }
  if (classification.riskClass === "MEDIUM") {
    // MEDIUM may mutate/evaluate autonomously but promotion requires the
    // operator boundary — signalled to the caller via the returned flag.
  }
  if (!policy.risk_classes_allowed.includes(classification.riskClass)) {
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.RISK_CLASS_REFUSED, `risk class ${classification.riskClass} not allowed by policy (allowed: ${policy.risk_classes_allowed.join(",")})`);
  }
  // Scope containment: every mutation path inside policy scope, none in
  // forbidden patterns. Same glob conventions as mutation-scope.mjs.
  for (const path of mutationPaths) {
    if (!matchesGlob(path, policy.scope_patterns)) {
      throw new C2dHoldError(EVOLUTION_POLICY_HOLD.SCOPE_OUTSIDE_POLICY, `path outside policy scope: ${path}`);
    }
    if (matchesGlob(path, policy.forbidden_patterns)) {
      throw new C2dHoldError(EVOLUTION_POLICY_HOLD.SCOPE_OUTSIDE_POLICY, `path matches forbidden pattern: ${path}`);
    }
  }
  // Resource budget.
  const b = policy.budget;
  if ((usage?.mutationRuns ?? 0) >= b.max_mutation_runs) {
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.BUDGET_EXHAUSTED, `mutation run budget exhausted (${usage?.mutationRuns ?? 0}/${b.max_mutation_runs})`);
  }
  if ((usage?.evolutionsInWindow ?? 0) >= b.max_evolutions_per_window) {
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.BUDGET_EXHAUSTED, `evolution window budget exhausted (${usage?.evolutionsInWindow ?? 0}/${b.max_evolutions_per_window})`);
  }
  return {
    authorized: true,
    riskClass: classification.riskClass,
    promotionRequiresOperator: classification.riskClass === "MEDIUM",
    policyId: policy.policy_id,
    policyDigest: policy.policy_digest,
    validationPlanId: policy.validation_plan_id,
    validationPlan: policy.validation_plan,
    budget: { ...b },
  };
}

/** Glob match — same wildcard conventions as lifecycle-authorization matchesPattern. */
function matchesPattern(pattern, candidate) {
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  try {
    const source = pattern.split("*").map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
    return new RegExp(`^${source}$`).test(candidate);
  } catch { return false; }
}

function matchesGlob(path, patterns) {
  return (patterns ?? []).some((p) => {
    if (p === "**" || p === "*") return true;
    if (p.endsWith("/**")) {
      const prefix = p.slice(0, -3);
      return path === prefix || path.startsWith(prefix + "/");
    }
    return matchesPattern(p, path);
  });
}

export { matchesGlob };
