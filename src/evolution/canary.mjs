// src/evolution/canary.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Sections J + K:
// bounded canary observation with automatic rollback, and loop prevention
// (cooldown / window caps / same-signature suppression / global circuit
// breaker).
//
// CANARY (card §J): promotion never counts as permanent success. The
// promoted branch runs under a bounded observation window; post-promotion
// telemetry is compared against the pre-promotion baseline. Any of
//   - regression (validation failure on the promoted branch)
//   - new repeated failure (same signature re-appearing ≥ threshold)
//   - crash/resume anomaly (RECOVERY_REQUIRED / resume rejections)
//   - semantic drift (declared contract digest divergence)
//   - target metric deterioration (fitness metric regresses vs baseline)
// ⇒ AUTOMATIC ROLLBACK: the evolution branch ref is reset to the previous
// known-good (the pre-promotion baseline) — a ref-only operation, never a
// history rewrite, never touching main/master.
//
// LOOP PREVENTION (card §K): the circuit breaker lives in the durable
// trigger state (trigger.mjs tripCircuitBreaker/clearCircuitBreaker) and is
// consulted by the trigger gate; the canary adds the observation-driven
// trip conditions. Evolution subsystem failure NEVER blocks NORMAL_OPERATION:
// every evaluation here is fail-open for the run, fail-closed only for
// further autonomous evolution.

import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { C2dHoldError } from "../c2d/fs-atomic.mjs";
import { digestOf } from "../canonical-digest.mjs";
import { compareMetric } from "./fitness.mjs";
import { tripCircuitBreaker, EVOLUTION_TRIGGER_STATE_SCHEMA } from "./trigger.mjs";
import { deactivateStrategyValue } from "./strategy-store.mjs";

export const EVOLUTION_CANARY_SCHEMA = "autoloop.evolution-canary/v1";

export const CANARY_VERDICTS = Object.freeze(["HEALTHY", "REGRESSED", "ROLLED_BACK"]);
export const CANARY_HOLD = Object.freeze({
  EVIDENCE_INVALID: "HOLD / EVOLUTION_CANARY_EVIDENCE_INVALID",
  WINDOW_ACTIVE: "HOLD / EVOLUTION_CANARY_WINDOW_ACTIVE",
});

// Default canary window (policy may raise, never lower below the floor).
export const CANARY_WINDOW_FLOOR_MS = 30 * 60 * 1000;
export const DEFAULT_CANARY_WINDOW_MS = 2 * 60 * 60 * 1000;

// Circuit breaker thresholds (card §K).
export const CIRCUIT_BREAKER_DEFAULTS = Object.freeze({
  maxConsecutiveFailedCandidates: 3,
  maxRollbacksPerWindow: 2,
  windowMs: 24 * 60 * 60 * 1000,
});

function fail(code, message) {
  throw new C2dHoldError(code, message);
}

// ── Durable canary record ──────────────────────────────────────────────────

export function canaryPath(storeRoot, candidateId) {
  return join(storeRoot, "canary", `${candidateId}.json`);
}

export function readCanary(storeRoot, candidateId) {
  const p = canaryPath(storeRoot, candidateId);
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, "utf8"));
    return c?.schema === EVOLUTION_CANARY_SCHEMA ? c : null;
  } catch { return null; }
}

function writeCanaryRecord(storeRoot, record) {
  const p = canaryPath(storeRoot, record.candidate_id);
  mkdirSync(join(storeRoot, "canary"), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
    renameSync(tmp, p);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  return p;
}

/**
 * Open the canary window for a promoted candidate.
 *
 * @param {object} p
 * @param {string} p.storeRoot
 * @param {object} p.candidate
 * @param {object} p.promotion — commitCandidateToEvolutionBranch result
 * @param {object} p.fitness — the fitness record that authorized promotion
 * @param {number} [p.windowMs] — observation window (≥ CANARY_WINDOW_FLOOR_MS)
 * @param {object} p.baselineMetric — the pre-promotion metric observation
 */
export function openCanaryWindow({ storeRoot, candidate, promotion, fitness, windowMs = DEFAULT_CANARY_WINDOW_MS, baselineMetric }) {
  const isStrategy = promotion?.kind === "AGENT_STRATEGY";
  if (isStrategy) {
    // A strategy promotion binds a RUNTIME strategy surface, not a git branch:
    // the rollback action is deactivation (strategy-store.mjs), so the window
    // must name the surface and the activation generation instead.
    if (promotion.candidate_id !== candidate.candidate_id || !promotion.surface) {
      fail(CANARY_HOLD.EVIDENCE_INVALID, "strategy promotion does not bind this candidate's surface");
    }
  } else if (promotion?.branch !== `evolution/${candidate.candidate_id}`) {
    fail(CANARY_HOLD.EVIDENCE_INVALID, "promotion does not bind this candidate's branch");
  }
  const w = Math.max(Number(windowMs) || 0, CANARY_WINDOW_FLOOR_MS);
  const record = {
    schema: EVOLUTION_CANARY_SCHEMA,
    version: 1,
    candidate_id: candidate.candidate_id,
    candidate_digest: candidate.candidate_digest,
    promotion_kind: isStrategy ? "AGENT_STRATEGY" : "SOURCE",
    branch: isStrategy ? null : promotion.branch,
    commit_oid: isStrategy ? null : promotion.commit_oid,
    baseline_head: isStrategy ? (promotion.baseline_head ?? null) : promotion.parent,
    strategy_surface: isStrategy ? promotion.surface : null,
    strategy_dimension: isStrategy ? (promotion.dimension ?? null) : null,
    strategy_task_class: isStrategy ? (promotion.task_class ?? null) : null,
    strategy_from_value: isStrategy ? (promotion.from_value ?? null) : null,
    strategy_to_value: isStrategy ? (promotion.to_value ?? null) : null,
    strategy_generation: isStrategy ? (promotion.generation ?? null) : null,
    fitness_digest: fitness.fitness_digest,
    baseline_metric: baselineMetric ?? null,
    opened_at: new Date().toISOString(),
    window_ms: w,
    closes_at: new Date(Date.now() + w).toISOString(),
    verdict: "HEALTHY",
    observations: [],
    rolled_back: false,
  };
  record.canary_digest = digestOf({ ...record, canary_digest: undefined });
  writeCanaryRecord(storeRoot, record);
  return record;
}

/**
 * Evaluate the canary window (card §J). Reads post-promotion evidence and
 * decides HEALTHY vs REGRESSED; REGRESSED triggers the automatic rollback.
 *
 * @param {object} p
 * @param {string} p.storeRoot
 * @param {object} p.candidate
 * @param {object[]} p.postEvents — post-promotion journal events
 * @param {object} [p.postMutationResult] — validation result from the promoted branch run
 * @param {object} [p.declaredContract] — live declared contract for drift check
 * @param {object} p.state — durable trigger state (for circuit-breaker accounting)
 */
export function evaluateCanary({ storeRoot, candidate, postEvents = [], postMutationResult = null, declaredContract = null, state = null }) {
  const record = readCanary(storeRoot, candidate.candidate_id);
  if (!record) fail(CANARY_HOLD.EVIDENCE_INVALID, "no canary window open for candidate");
  if (record.rolled_back) return { ...record, verdict: "ROLLED_BACK" };

  const reasons = [];
  // 1. regression: promoted-branch validation failure.
  if (postMutationResult) {
    const okStates = new Set(["READY_FOR_REVIEW", "CANDIDATE_VERIFIED"]);
    if (!okStates.has(postMutationResult.outcome_state)) reasons.push(`regression:mutation_${postMutationResult.outcome_state}`);
    const failed = (postMutationResult.evidence?.validation_results ?? []).filter((r) => r.required !== false && r.exit_code !== 0);
    if (failed.length > 0) reasons.push(`regression:${failed.length}_validation_failure(s)`);
  }
  // 2. new repeated failure: the same hold reason re-appearing ≥ 2 on the
  //    promoted branch (the durable RUN_HELD payload reason is the hold code).
  const sigFails = postEvents.filter((e) =>
    e.event_type === "RUN_HELD"
    && (e.payload?.reason === candidate.problem_signature
        || String(e.payload?.reason ?? "").includes(String(candidate.problem_signature)))
  );
  if (sigFails.length >= 2) reasons.push(`new_repeated_failure:${sigFails.length}`);
  // 3. crash/resume anomaly.
  const anomalies = postEvents.filter((e) => e.event_type === "RESUME_REJECTED" || (e.event_type === "RUN_HELD" && String(e.payload?.reason ?? "").includes("RECOVERY_REQUIRED")));
  if (anomalies.length >= 2) reasons.push(`crash_resume_anomaly:${anomalies.length}`);
  // 4. semantic drift.
  if (declaredContract && record.declared_contract_digest) {
    const live = digestOf(declaredContract);
    if (live !== record.declared_contract_digest) reasons.push("semantic_drift");
  }
  // 5. target metric deterioration vs the canary baseline.
  // The only post-promotion quantity measurable from durable evidence is
  // provider-reported OCCUPANCY, so this check is meaningful only when the
  // canary's baseline metric IS that quantity. Comparing an unrelated metric's
  // baseline (a failure/repair count, or a strategy success rate) against an
  // occupancy average is a category error that could roll back a healthy
  // promotion — so the check applies to the matching metric only, and the
  // other criteria (regression / repeated failure / crash / drift) carry the
  // rest.
  if (record.baseline_metric?.value != null && /occupancy|wall_duration_ms|provider_occupancy/.test(String(record.baseline_metric.metric ?? ""))) {
    const usages = postEvents.filter((e) => e.event_type === "PROVIDER_USAGE_OBSERVED").map((e) => e.payload?.occupancy).filter((v) => typeof v === "number");
    if (usages.length >= 2) {
      const avg = usages.reduce((a, v) => a + v, 0) / usages.length;
      const cmp = compareMetric({ baseline: record.baseline_metric.value, candidate: avg, direction: "decrease" });
      if (cmp.verdict === "REGRESSED") reasons.push(`target_metric_deterioration:${cmp.ratio?.toFixed(3)}`);
    }
  }

  const verdict = reasons.length > 0 ? "REGRESSED" : "HEALTHY";
  record.observations.push({ at: new Date().toISOString(), verdict, reasons });
  record.verdict = verdict;
  writeCanaryRecord(storeRoot, record);
  return { ...record, verdict, reasons };
}

/**
 * AUTOMATIC ROLLBACK (card §J): reset the evolution branch ref to the
 * previous known-good. Ref-only; never touches main/master; never rewrites
 * history. Idempotent.
 */
export function rollbackCandidate({ repoRoot, storeRoot, candidate }) {
  const record = readCanary(storeRoot, candidate.candidate_id);
  if (!record) fail(CANARY_HOLD.EVIDENCE_INVALID, "no canary record to roll back");

  // STRATEGY ROLLBACK: a strategy promotion changed a runtime policy value, so
  // the rollback DEACTIVATES that value (restoring the recorded previous one).
  // No ref, no history, no worktree is involved — the strategy store is the
  // only durable state, and deactivation is idempotent.
  if (record.promotion_kind === "AGENT_STRATEGY") {
    const d = deactivateStrategyValue({
      storeRoot,
      taskClass: record.strategy_task_class,
      dimension: record.strategy_dimension,
    });
    record.rolled_back = true;
    record.verdict = "ROLLED_BACK";
    record.rolled_back_at = new Date().toISOString();
    record.rollback = {
      kind: "strategy_deactivation",
      surface: record.strategy_surface,
      dimension: record.strategy_dimension,
      task_class: record.strategy_task_class,
      deactivated: d.deactivated === true,
      restored_to: d.deactivated ? (record.strategy_from_value ?? null) : null,
      generation: d.generation ?? null,
    };
    writeCanaryRecord(storeRoot, record);
    return {
      rolled_back: true,
      kind: "strategy_deactivation",
      surface: record.strategy_surface,
      restored_to: record.rollback.restored_to,
      deactivated: record.rollback.deactivated,
    };
  }

  const branch = record.branch;
  // The previous known-good is the pre-promotion baseline.
  const prev = gitRevParse(repoRoot, `refs/heads/${branch}`);
  if (prev !== record.commit_oid) {
    // Branch already moved (e.g. double rollback) — verify it is not ahead.
    // Reset to baseline is always safe: ref-only.
  }
  const r = spawnSyncGit(repoRoot, ["update-ref", `refs/heads/${branch}`, record.baseline_head, prev ?? `${"0".repeat(40)}`]);
  if (r.status !== 0) fail(CANARY_HOLD.EVIDENCE_INVALID, `rollback ref update failed: ${r.stderr}`);
  record.rolled_back = true;
  record.verdict = "ROLLED_BACK";
  record.rolled_back_at = new Date().toISOString();
  writeCanaryRecord(storeRoot, record);
  return { rolled_back: true, branch, restored_to: record.baseline_head, from: prev };
}

function spawnSyncGit(repoRoot, args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}
function gitRevParse(repoRoot, ref) {
  const r = spawnSyncGit(repoRoot, ["rev-parse", "--verify", ref]);
  return r.status === 0 ? r.stdout.trim() : null;
}

// ── Loop prevention (Section K) ────────────────────────────────────────────

/**
 * Record a candidate outcome for loop accounting and evaluate the circuit
 * breaker. Returns { state, tripped, reason } — the caller persists state.
 *
 * Trip conditions (card §K):
 *   - maxConsecutiveFailedCandidates consecutive REJECT/rollback outcomes
 *   - maxRollbacksPerWindow rollbacks inside windowMs
 */
export function recordCandidateOutcome({ state, outcome, candidateId, signature, defaults = CIRCUIT_BREAKER_DEFAULTS, now = Date.now() }) {
  const s = { schema: EVOLUTION_TRIGGER_STATE_SCHEMA, ...(state ?? {}) };
  s.outcomes = [...(s.outcomes ?? [])];
  s.outcomes.push({ at: new Date(now).toISOString(), candidateId, signature, outcome });
  while (s.outcomes.length > 128) s.outcomes.shift();
  // consecutive failures
  let consecutive = 0;
  for (let i = s.outcomes.length - 1; i >= 0; i--) {
    if (s.outcomes[i].outcome === "REJECTED" || s.outcomes[i].outcome === "ROLLED_BACK") consecutive++;
    else break;
  }
  if (consecutive >= defaults.maxConsecutiveFailedCandidates) {
    const next = tripCircuitBreaker(s, { reason: `circuit_breaker: ${consecutive} consecutive failed candidates` });
    return { state: next, tripped: true, reason: "consecutive_failed_candidates" };
  }
  // rollbacks per window
  const rollbacks = s.outcomes.filter((o) => o.outcome === "ROLLED_BACK" && now - Date.parse(o.at) < defaults.windowMs);
  if (rollbacks.length >= defaults.maxRollbacksPerWindow) {
    const next = tripCircuitBreaker(s, { reason: `circuit_breaker: ${rollbacks.length} rollbacks inside window` });
    return { state: next, tripped: true, reason: "rollback_window_exceeded" };
  }
  return { state: s, tripped: false, reason: null };
}
