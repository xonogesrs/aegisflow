// src/evolution/candidate.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Section B: improvement
// candidate derivation. Completes the not-yet-wired `candidate_derivation`
// seam (src/generation-manifest.mjs MATERIAL_CHANGE_PATTERNS) with a real
// production derivation path.
//
// Input:  a fired, gated, provenance-bound improvement trigger event
//         (src/evolution/trigger.mjs) + the run's durable evidence.
// Output: an improvement candidate carrying AT LEAST (card §B):
//   candidate_id, problem_signature, evidence_refs, baseline_revision,
//   affected_scope, expected_improvement, measurement_plan, risk_class,
//   rollback_plan
//
// Hard rules:
//   - Deterministic identity: candidate_id = sha256 over the canonical
//     trigger + derivation facts. Same trigger ⇒ same candidate (dedup at
//     the identity level; a re-fired identical trigger re-derives the SAME
//     candidate, never a duplicate stream).
//   - Same problem_signature cannot infinitely regenerate: the candidate
//     store records derivation per (signature, baseline) pair; a repeat at
//     the SAME baseline is a no-op (already derived), a repeat at a NEW
//     baseline (the previous candidate was promoted/rejected) is legal.
//   - Evidence provenance: every candidate carries the trigger's durable
//     evidence_refs (journal event ids) — never an unanchored observation.
//   - The derivation NEVER mutates the repository: it produces candidate
//     DATA plus a bounded mutation PLAN (the concrete file edits / commands
//     the mutation stage will execute inside the isolated worktree). The
//     plan itself is data; executing it is the mutation stage's job under
//     policy authority.
//   - NON-AUTHORITATIVE: a candidate is a proposal. Risk classification,
//     policy authorization, mutation, fitness, review and promotion are
//     separate downstream stages with their own gates.

import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { C2dHoldError, writeJsonExclusiveCreate, assertNotSymlink } from "../c2d/fs-atomic.mjs";
import { canonicalize, digestOf } from "../canonical-digest.mjs";
import { classifyCandidateRisk } from "./policy.mjs";

export const EVOLUTION_CANDIDATE_SCHEMA = "autoloop.evolution-candidate/v1";
export const EVOLUTION_CANDIDATE_HOLD = Object.freeze({
  TRIGGER_INVALID: "HOLD / EVOLUTION_CANDIDATE_TRIGGER_INVALID",
  DERIVATION_UNSUPPORTED: "HOLD / EVOLUTION_CANDIDATE_DERIVATION_UNSUPPORTED",
  ALREADY_DERIVED: "HOLD / EVOLUTION_CANDIDATE_ALREADY_DERIVED",
  MALFORMED: "HOLD / EVOLUTION_CANDIDATE_MALFORMED",
});

// Deterministic repair strategies the derivation can plan for a trigger
// signature. Each strategy is a BOUNDED, REVIEWABLE transform — the v1 set
// is intentionally small (card §B: no speculative framework). A trigger
// whose signature matches no strategy fails closed DERIVATION_UNSUPPORTED
// (recorded, never silently dropped) so new strategies are added by card,
// not improvised.
export const DERIVATION_STRATEGIES = Object.freeze([
  "BOUNDED_CONSTANT_TUNING",       // adjust a bounded numeric threshold/config constant
  "DETERMINISTIC_BUG_REPAIR",      // narrow, evidence-cited code fix (patch text carried by evidence)
  "TELEMETRY_EFFICIENCY_REPAIR",   // reduce measured waste (retry backoff, redundant work)
]);

function fail(code, message, details) {
  throw new C2dHoldError(code, message, details);
}

// ── Candidate store (durable, exclusive-create, digest-bound) ──────────────

export function candidateStorePath(policyRoot) {
  return join(policyRoot, "evolution-candidates");
}

export function candidateFilePath(policyRoot, candidateId) {
  return join(candidateStorePath(policyRoot), `${candidateId}.json`);
}

export function derivationIndexPath(policyRoot) {
  return join(policyRoot, "evolution-derivation-index.json");
}

function readDerivationIndex(policyRoot) {
  const p = derivationIndexPath(policyRoot);
  if (!existsSync(p)) return { schema: EVOLUTION_CANDIDATE_SCHEMA, version: 1, derivations: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (raw?.schema !== EVOLUTION_CANDIDATE_SCHEMA) return { schema: EVOLUTION_CANDIDATE_SCHEMA, version: 1, derivations: {} };
    return raw;
  } catch { return { schema: EVOLUTION_CANDIDATE_SCHEMA, version: 1, derivations: {} }; }
}

function writeDerivationIndex(policyRoot, index) {
  const p = derivationIndexPath(policyRoot);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n", "utf8");
    renameSync(tmp, p);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

export function readCandidate(policyRoot, candidateId) {
  const p = candidateFilePath(policyRoot, candidateId);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  try {
    const c = JSON.parse(readFileSync(p, "utf8"));
    if (c?.schema !== EVOLUTION_CANDIDATE_SCHEMA) return null;
    return c;
  } catch { return null; }
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * Select the derivation strategy for a fired trigger. Deterministic over
 * the trigger facts. Returns null when no strategy applies (caller fails
 * closed with DERIVATION_UNSUPPORTED).
 */
export function selectDerivationStrategy({ signalClass, observation, signature }) {
  switch (signalClass) {
    case "REPEATED_EQUIVALENT_FAILURE":
    case "RECURRING_HOLD_PATTERN":
      // A recurring HOLD/failure with a code-level cause is a deterministic
      // bug repair candidate; the affected scope + patch plan must be
      // carried by the observation (evidence-bound), otherwise unsupported.
      return observation?.patchPlan ? "DETERMINISTIC_BUG_REPAIR" : null;
    case "REPEATED_REPAIR_REQUIREMENT":
      // Repeated repairs on the same phase indicate an efficiency/robustness
      // defect in that phase's bounded configuration — constant tuning first
      // (the smallest safe transform), behavioral repair only with a patch.
      return observation?.patchPlan ? "DETERMINISTIC_BUG_REPAIR" : "BOUNDED_CONSTANT_TUNING";
    case "ABNORMAL_RETRY_FREQUENCY":
      return "TELEMETRY_EFFICIENCY_REPAIR";
    case "LATENCY_REGRESSION":
    case "TOKEN_INEFFICIENCY":
      return "TELEMETRY_EFFICIENCY_REPAIR";
    case "QUALIFIED_PATTERN_EVIDENCE":
      // A qualified pattern proposes a bounded improvement; it must carry a
      // concrete patch plan to be actionable.
      return observation?.patchPlan ? "DETERMINISTIC_BUG_REPAIR" : null;
    default:
      return null;
  }
}

/**
 * Derive the affected scope + mutation plan for one strategy. The plan is
 * DATA: exact relative paths + bounded edits/commands. Scope comes from the
 * trigger observation when present (evidence-bound), otherwise the strategy
 * default (config/constant surfaces only — never authority code).
 */
export function deriveMutationPlan({ strategy, observation, scopeHints = [] }) {
  const scope = (scopeHints.length ? scopeHints : (observation?.affectedScope ?? []))
    .filter((p) => typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").includes(".."));
  if (!scope.length) return null;
  const edits = [];
  if (strategy === "BOUNDED_CONSTANT_TUNING") {
    // One bounded numeric adjustment per affected file, cited to evidence.
    for (const p of scope) {
      edits.push({
        path: p,
        kind: "constant_adjustment",
        target: observation?.constantTarget ?? null,
        adjustment: observation?.constantAdjustment ?? null,
        evidence_refs: observation?.evidenceRefs ?? [],
      });
    }
  } else if (strategy === "DETERMINISTIC_BUG_REPAIR") {
    edits.push({
      path: scope[0],
      kind: "patch_apply",
      patch: observation.patchPlan.patch ?? null,
      evidence_refs: observation?.evidenceRefs ?? [],
    });
  } else if (strategy === "TELEMETRY_EFFICIENCY_REPAIR") {
    for (const p of scope) {
      edits.push({
        path: p,
        kind: "efficiency_adjustment",
        metric: observation?.metric ?? null,
        evidence_refs: observation?.evidenceRefs ?? [],
      });
    }
  }
  return { strategy, affected_scope: scope, edits };
}

/**
 * THE candidate derivation entry. Consumes one gated trigger event and
 * produces (or idempotently returns) the durable improvement candidate.
 *
 * @param {object} p
 * @param {object} p.triggerEvent — buildTriggerEvent output (gated)
 * @param {string} p.baselineHead — frozen baseline HEAD (40-hex)
 * @param {string} p.baselineRevision — durable checkpoint revision at trigger time
 * @param {string} p.storeRoot — durable store root for candidates
 * @param {string[]} [p.scopeHints] — evidence-derived affected paths
 * @param {object} [p.measurement] — { metric, baselineValue, direction } measurement plan override
 * @returns {{ status: "CREATED"|"EXISTING"|"UNSUPPORTED", candidate?: object, reason?: string }}
 */
export function deriveImprovementCandidate({ triggerEvent, baselineHead, baselineRevision, storeRoot, scopeHints = [], measurement = null }) {
  if (!triggerEvent || triggerEvent.schema !== "autoloop.evolution-trigger/v1") {
    fail(EVOLUTION_CANDIDATE_HOLD.TRIGGER_INVALID, "trigger event missing or wrong schema");
  }
  if (!/^[0-9a-f]{40}$/.test(baselineHead || "")) {
    fail(EVOLUTION_CANDIDATE_HOLD.TRIGGER_INVALID, "baseline HEAD invalid");
  }
  const strategy = selectDerivationStrategy({
    signalClass: triggerEvent.signal_class,
    observation: triggerEvent.observation,
    signature: triggerEvent.signature,
  });
  if (!strategy) {
    return { status: "UNSUPPORTED", reason: `no derivation strategy for ${triggerEvent.signal_class} (recorded; add a strategy by card, never improvised)` };
  }
  const plan = deriveMutationPlan({ strategy, observation: triggerEvent.observation, scopeHints });
  if (!plan || !plan.affected_scope.length || plan.edits.some((e) => e.kind === "patch_apply" && !e.patch)) {
    return { status: "UNSUPPORTED", reason: `strategy ${strategy} lacks a concrete bounded plan (affected scope / patch missing)` };
  }

  // Deterministic identity over trigger + baseline + plan facts.
  const identityFacts = {
    trigger_id: triggerEvent.trigger_id,
    signal_class: triggerEvent.signal_class,
    signature: triggerEvent.signature,
    baseline_head: baselineHead,
    strategy,
    affected_scope: [...plan.affected_scope].sort(),
  };
  const candidateId = `ecand_${digestOf(identityFacts).slice(0, 40)}`;

  // Same-signature dedup at the SAME baseline: already derived → no-op.
  const index = readDerivationIndex(storeRoot);
  const key = `${triggerEvent.signature}@${baselineHead}`;
  if (index.derivations[key]) {
    const existing = readCandidate(storeRoot, index.derivations[key]);
    if (existing) return { status: "EXISTING", candidate: existing };
  }

  // Risk classification (Section C) — recorded on the candidate; the
  // downstream policy gate re-derives it and never trusts this field alone.
  const classification = classifyCandidateRisk({
    affected_scope: plan.affected_scope,
    declared_risk_markers: triggerEvent.observation?.declaredRiskMarkers ?? [],
  });

  // Measurement plan: what the fitness stage must compare (card §F).
  const measurementPlan = measurement ?? {
    metric: triggerEvent.signal_class === "LATENCY_REGRESSION" ? "wall_duration_ms"
      : triggerEvent.signal_class === "TOKEN_INEFFICIENCY" ? "provider_occupancy"
      : "failure_or_repair_count",
    baselineValue: triggerEvent.observation?.currentAvg ?? triggerEvent.count ?? null,
    direction: "decrease", // an improvement lowers the trigger metric
    regressionGate: "zero_regression", // correctness suites must not regress
  };

  const candidate = {
    schema: EVOLUTION_CANDIDATE_SCHEMA,
    version: 1,
    candidate_id: candidateId,
    created_at: new Date().toISOString(),
    problem_signature: triggerEvent.signature,
    signal_class: triggerEvent.signal_class,
    trigger_id: triggerEvent.trigger_id,
    evidence_refs: [...triggerEvent.evidence_refs].sort(),
    baseline_revision: baselineRevision,
    baseline_head: baselineHead,
    affected_scope: [...plan.affected_scope].sort(),
    derivation_strategy: strategy,
    mutation_plan: plan,
    expected_improvement: {
      kind: strategy === "DETERMINISTIC_BUG_REPAIR" ? "correctness" : "efficiency",
      metric: measurementPlan.metric,
      direction: measurementPlan.direction,
      cited_observation: triggerEvent.observation ?? {},
    },
    measurement_plan: measurementPlan,
    risk_class: classification.riskClass,
    risk_reasons: classification.reasons,
    rollback_plan: {
      kind: "worktree_discard", // isolated worktree: discard = complete rollback
      baseline_head: baselineHead,
      note: "mutation runs in an isolated C3B worktree; failure/rejection discards the worktree — the production checkout is never touched",
    },
    status: "DERIVED",
  };
  candidate.candidate_digest = digestOf({ ...candidate, candidate_digest: undefined });

  // Persist (exclusive-create) + record the derivation index.
  mkdirSync(candidateStorePath(storeRoot), { recursive: true });
  const p = candidateFilePath(storeRoot, candidateId);
  try {
    writeJsonExclusiveCreate(p, candidate);
  } catch (e) {
    const existing = readCandidate(storeRoot, candidateId);
    if (existing) return { status: "EXISTING", candidate: existing };
    throw e;
  }
  index.derivations[key] = candidateId;
  writeDerivationIndex(storeRoot, index);
  return { status: "CREATED", candidate };
}

/** List candidates (bounded, newest last) for the operator surface. */
export function listCandidates(storeRoot, { limit = 32 } = {}) {
  const dir = candidateStorePath(storeRoot);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(-limit);
  const out = [];
  for (const f of files) {
    try {
      const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (c?.schema === EVOLUTION_CANDIDATE_SCHEMA) out.push(c);
    } catch { /* skip unreadable */ }
  }
  return out;
}
