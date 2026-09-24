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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { C2dHoldError, ensureDir0700, writeJsonExclusiveCreate, assertNotSymlink, writeJsonAtomicReplaceUnderLock } from "../c2d/fs-atomic.mjs";
import { acquireStructuredLock } from "../c2d/lock.mjs";
import { digestOf } from "../canonical-digest.mjs";

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
  // §J.1 POLICY SUCCESSION: a successor issuance must bind the digest of the
  // outgoing generation, advance it monotonically, and take the single active
  // slot — anything else fails closed here.
  SUCCESSION_MISMATCH: "HOLD / EVOLUTION_POLICY_SUCCESSION_MISMATCH",
  SUCCESSION_IN_FLIGHT: "HOLD / EVOLUTION_POLICY_SUCCESSION_IN_FLIGHT",
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
  // §J.1 POLICY SUCCESSION: a record that names its predecessor MUST be a
  // monotonic successor (generation ≥ 1) and bind a well-formed digest.
  if (p.previous_policy_digest !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(p.previous_policy_digest)) errors.push("previous_policy_digest_invalid");
    if (!Number.isInteger(p.generation) || p.generation < 1) errors.push("successor_generation_invalid");
  }
  if (!p.forbidden_risk_classes || !Array.isArray(p.forbidden_risk_classes) || !HIGH_RISK_CLASSES.every((c) => p.forbidden_risk_classes.includes(c))) errors.push("forbidden_risk_classes_incomplete");
  if (p.strategy_dimensions_allowed !== undefined) {
    if (!Array.isArray(p.strategy_dimensions_allowed)) errors.push("strategy_dimensions_allowed_invalid");
    else {
      const seen = new Set();
      for (const d of p.strategy_dimensions_allowed) {
        if (typeof d !== "string" || !STRATEGY_DIMENSION_IDS.includes(d)) errors.push(`strategy_dimension_unknown:${String(d)}`);
        else if (seen.has(d)) errors.push(`strategy_dimension_duplicate:${d}`);
        else seen.add(d);
      }
    }
  }
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
  const record = buildPolicyRecord(input, { generation: input.generation ?? 0 });
  ensureDir0700(policyRoot);
  const p = evolutionPolicyPath(policyRoot);
  if (existsSync(p)) {
    assertNotSymlink(p);
    const old = readEvolutionPolicy(policyRoot, { allowExpired: true });
    // IDENTICAL RE-ISSUE IS A NO-OP. `issued_at` is minted per call, so a
    // byte comparison of the two records would only ever match within the same
    // millisecond — which made the documented idempotency effectively
    // unreachable. Re-derive the candidate record under the EXISTING record's
    // issued_at and compare the CONTENT digests instead.
    const sameContent = buildPolicyRecord(input, {
      generation: old.generation ?? 0,
      previousPolicyDigest: old.previous_policy_digest ?? null,
    });
    sameContent.issued_at = old.issued_at;
    const identical = computePolicyDigest({ ...sameContent, policy_id: undefined, policy_digest: undefined })
      === computePolicyDigest({ ...old, policy_id: undefined, policy_digest: undefined });
    if (old.policy_id === record.policy_id || identical) return { status: "AUTHORIZED_EXISTING_IDENTICAL", policy: old };
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.CONFLICT, "a different evolution policy already exists — issue a SUCCESSOR generation explicitly (issueSuccessorEvolutionPolicy)");
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

// ── §J.1 POLICY SUCCESSION — the formal successor-generation issuance ───────
//
// The audit found the ONLY way to reissue a policy was `createEvolutionPolicy`,
// which refuses any record that differs from the existing one
// (EVOLUTION_POLICY_CONFLICT). An operator whose policy expired or needed a
// widened scope had to MANUALLY move the old artifact aside — an
// un-auditable, unsupported operation on a governance artifact.
//
// Succession makes reissue first-class and bounded:
//
//   gen N (active, digest D_N)
//     → archive  gen-N-D_N  (durable, exclusive-create, never overwritten)
//     → install  gen N+1    (previous_policy_digest = D_N, generation = N+1)
//
// Invariants enforced here:
//   - PREVIOUS DIGEST BINDING: the successor records the outgoing policy's
//     digest and must present it (explicitly or by reading the active record).
//   - MONOTONIC GENERATION: generation = outgoing + 1, always. A caller-declared
//     generation that is not exactly that fails closed.
//   - EXCLUSIVE ACTIVE POLICY: exactly ONE active record; the install path is
//     serialized by the shared structured lock and re-verifies the outgoing
//     digest immediately before the atomic replace.
//   - OLD GENERATION PRESERVED: the outgoing record is archived before the
//     install, so every generation stays readable.

export const EVOLUTION_POLICY_HISTORY_DIR = "evolution-policy-history";

/** Durable archive path for one generation of the policy. */
export function evolutionPolicyHistoryPath(policyRoot, generation, policyId) {
  return join(policyRoot, EVOLUTION_POLICY_HISTORY_DIR, `gen-${generation}-${policyId}.json`);
}

/**
 * Read every archived policy generation (oldest first). READ-ONLY, fail-open
 * per file: an unreadable archive entry is reported, never thrown.
 */
export function listEvolutionPolicyHistory(policyRoot) {
  const dir = join(policyRoot, EVOLUTION_POLICY_HISTORY_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
      out.push({ file: f, generation: rec?.generation ?? null, policy_id: rec?.policy_id ?? null, policy_digest: rec?.policy_digest ?? null, expires_at: rec?.expires_at ?? null });
    } catch {
      out.push({ file: f, generation: null, policy_id: null, policy_digest: null, expires_at: null, unreadable: true });
    }
  }
  return out.sort((a, b) => (a.generation ?? -1) - (b.generation ?? -1));
}

/** Read one archived generation's FULL record, or null when absent. */
export function readEvolutionPolicyGeneration(policyRoot, generation) {
  const dir = join(policyRoot, EVOLUTION_POLICY_HISTORY_DIR);
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir).sort()) {
    if (!f.startsWith(`gen-${generation}-`) || !f.endsWith(".json")) continue;
    try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; }
  }
  return null;
}

/** Build + validate one policy record (shared by create + successor). */
function buildPolicyRecord(input, { generation, previousPolicyDigest = null }) {
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
    generation,
    forbidden_risk_classes: [...HIGH_RISK_CLASSES],
    // AGENT-STRATEGY authority is OPT-IN and operator-issued: absent means a
    // strategy candidate is refused (fail closed), so no existing policy
    // silently gains agent-strategy authority from a code change.
    ...(Array.isArray(input.strategy_dimensions_allowed)
      ? { strategy_dimensions_allowed: [...new Set(input.strategy_dimensions_allowed)] }
      : {}),
    // §J.1: the outgoing generation this record succeeds (absent for gen 0).
    ...(previousPolicyDigest ? { previous_policy_digest: previousPolicyDigest } : {}),
  };
  const policy_id = digestOf({ ...identity, policy_id: undefined, policy_digest: undefined });
  const draft = { ...identity, policy_id };
  const record = { ...draft, policy_digest: computePolicyDigest(draft) };
  const errors = validatePolicyShape(record);
  if (errors.length) throw new C2dHoldError(EVOLUTION_POLICY_HOLD.INVALID, errors.join(","));
  return record;
}

/** Archive one outgoing policy record (durable, exclusive-create, idempotent). */
function archivePolicyRecord(policyRoot, record) {
  const p = evolutionPolicyHistoryPath(policyRoot, record.generation ?? 0, record.policy_id);
  if (existsSync(p)) return { status: "ARCHIVED_EXISTING", path: p };
  ensureDir0700(join(policyRoot, EVOLUTION_POLICY_HISTORY_DIR));
  try {
    writeJsonExclusiveCreate(p, record);
  } catch {
    if (existsSync(p)) return { status: "ARCHIVED_EXISTING", path: p };
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.CONFLICT, `cannot archive outgoing generation at ${p}`);
  }
  return { status: "ARCHIVED", path: p };
}

/**
 * Issue the SUCCESSOR of the currently active policy (§J.1).
 *
 * @param {string} policyRoot
 * @param {object} input — the same input `createEvolutionPolicy` accepts, plus
 *   an OPTIONAL `previous_policy_digest` that must match the active record
 *   (an operator may bind it explicitly to prove intent; when omitted the
 *   active record is read and bound).
 * @param {object} [opts]
 * @param {string|null} [opts.lockPath] — override for the succession lock
 * @returns {{ status: "SUCCEEDED", generation, policy, previous, archive }}
 */
export function issueSuccessorEvolutionPolicy(policyRoot, input, { lockPath = null } = {}) {
  const active = readEvolutionPolicy(policyRoot, { allowExpired: true });
  const outgoingDigest = active.policy_digest;
  const outgoingGeneration = Number.isInteger(active.generation) ? active.generation : 0;

  // (1) PREVIOUS DIGEST BINDING — the caller's declared binding must be the
  // outgoing policy, and a caller-declared generation must be exactly +1.
  if (input?.previous_policy_digest !== undefined && input.previous_policy_digest !== outgoingDigest) {
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.SUCCESSION_MISMATCH, "previous_policy_digest does not match the active generation");
  }
  if (input?.generation !== undefined && input.generation !== outgoingGeneration + 1) {
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.SUCCESSION_MISMATCH, `declared generation ${input.generation} is not the monotonic successor of ${outgoingGeneration}`);
  }
  const record = buildPolicyRecord(input, { generation: outgoingGeneration + 1, previousPolicyDigest: outgoingDigest });

  // (2) EXCLUSIVE ACTIVE POLICY — one successor at a time. The shared
  // structured lock reclaims a crashed issuance automatically.
  const lock = acquireStructuredLock(lockPath ?? join(policyRoot, "evolution-policy-succession.lock"), {
    lock_kind: "evolution_policy_succession",
    execution_id: "evolution-policy-succession",
    checkpoint_id: "evolution-policy",
    chain_id: "evolution-policy",
    lease_id: "none",
    lease_revision: 0,
    actor_id: String(input?.issued_by ?? "unknown").slice(0, 120),
    session_id: String(input?.authorization_ref ?? "unknown").slice(0, 120),
    repository_identity: `evolution-store:${policyRoot}`,
    worktree_identity: "evolution-policy-succession",
    expected_head: "none",
  });
  try {
    // Re-read under the lock: the active record must STILL be the one this
    // successor binds, or the issuance was raced and must fail closed.
    const current = readEvolutionPolicy(policyRoot, { allowExpired: true });
    if (current.policy_digest !== outgoingDigest) {
      throw new C2dHoldError(EVOLUTION_POLICY_HOLD.SUCCESSION_IN_FLIGHT, "the active policy changed while the successor was being issued");
    }
    const archive = archivePolicyRecord(policyRoot, current);
    writeJsonAtomicReplaceUnderLock(evolutionPolicyPath(policyRoot), record);
    return {
      status: "SUCCEEDED",
      generation: record.generation,
      policy: Object.freeze(record),
      previous: { policy_id: current.policy_id, policy_digest: outgoingDigest, generation: outgoingGeneration },
      archive,
    };
  } finally {
    try { lock.release(); } catch { /* foreign/lost lock: nothing this process may release */ }
  }
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

/** The strategy-surface scheme. An AGENT_STRATEGY candidate names a runtime
 *  strategy surface, not a file path — it can never be a source-mutation
 *  scope, and classifying its surface by path markers would be meaningless. */
export const STRATEGY_SURFACE_SCHEME = "strategy://";

/** The AGENT-STRATEGY dimensions a policy may preauthorize (§C). Kept literal
 *  here because this module must not depend on the strategy store (which
 *  imports admission policy-projection). */
export const STRATEGY_DIMENSION_IDS = Object.freeze([
  "MODEL_ROUTING", "DECOMPOSITION", "CONTEXT_ALLOCATION",
  "RETRY_REPAIR", "FANOUT_PARALLELISM", "TOOL_SELECTION", "PROMPT_EVOLUTION",
]);

/** The strategy dimension a surface names: `strategy://<task class>/<DIM>`. */
export function strategyDimensionOfSurface(p) {
  if (!isStrategySurface(p)) return null;
  const parts = p.slice(STRATEGY_SURFACE_SCHEME.length).split("/");
  const dim = parts[parts.length - 1] ?? null;
  return STRATEGY_DIMENSION_IDS.includes(dim) ? dim : null;
}

export function isStrategySurface(p) {
  return typeof p === "string" && p.startsWith(STRATEGY_SURFACE_SCHEME);
}

export function classifyCandidateRisk(candidate) {
  const reasons = [];
  const scope = [...(candidate.affected_scope ?? [])];
  const highScopeMarkers = [
    "src/governance/", "src/admission/", "src/evolution/", "src/budget/",
    "src/schema/", "docs/governance/", ".git", "src/c2d/",
    "src/memory/writeback/", "src/learning/lifecycle/",
  ];
  for (const p of scope) {
    // A strategy surface is not a path: it is validated by its own bounded
    // schema (strategy-store.mjs) and its risk is classified by
    // classifyStrategyRisk. Path markers do not apply.
    if (isStrategySurface(p)) continue;
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
    // A strategy surface is not a file path: it is a runtime strategy value,
    // validated against the bounded strategy schema (strategy-store.mjs) and
    // risk-classified by classifyStrategyRisk. Forbidden-path globs (governance
    // /admission/evolution/...) cannot apply to it in either direction.
    if (isStrategySurface(path)) {
      const dim = strategyDimensionOfSurface(path);
      if (dim === null) {
        throw new C2dHoldError(EVOLUTION_POLICY_HOLD.SCOPE_OUTSIDE_POLICY, `malformed strategy surface: ${path}`);
      }
      if (!Array.isArray(policy.strategy_dimensions_allowed) || !policy.strategy_dimensions_allowed.includes(dim)) {
        throw new C2dHoldError(
          EVOLUTION_POLICY_HOLD.SCOPE_OUTSIDE_POLICY,
          `strategy dimension ${dim} is not preauthorized by this policy (strategy_dimensions_allowed)`,
        );
      }
      continue;
    }
    if (!matchesGlob(path, policy.scope_patterns)) {
      throw new C2dHoldError(EVOLUTION_POLICY_HOLD.SCOPE_OUTSIDE_POLICY, `path outside policy scope: ${path}`);
    }
    if (matchesGlob(path, policy.forbidden_patterns)) {
      throw new C2dHoldError(EVOLUTION_POLICY_HOLD.SCOPE_OUTSIDE_POLICY, `path matches forbidden pattern: ${path}`);
    }
  }
  // A strategy candidate must carry ONLY strategy surfaces (never a mix that
  // could smuggle a source path past the strategy classification).
  const strategySurfaces = mutationPaths.filter(isStrategySurface);
  if (strategySurfaces.length > 0 && strategySurfaces.length !== mutationPaths.length) {
    throw new C2dHoldError(EVOLUTION_POLICY_HOLD.SCOPE_OUTSIDE_POLICY, "mixed strategy/source scope is not a valid candidate scope");
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
