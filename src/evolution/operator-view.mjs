// src/evolution/operator-view.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Section L: the
// read-only operator evolution view.
//
//   node scripts/evolution-operator.mjs [--store <dir>] [--json]
//
// Surfaces (card §L): candidate, trigger evidence, baseline, mutation,
// fitness result, review, promotion, canary, rollback, current evolution
// generation. READ ONLY / ADVISORY — zero writes, zero mutations, no
// production authority consumes its output (same fence as the R-07
// autoloop-operator surface). The operator can inspect; normal operation
// needs no intervention.
//
// Data sources: the durable evolution store (policy, candidates, reviews,
// canary records) + the durable trigger state (triggers, circuit breaker).
// Absent store → a truthful "no evolution activity" report, never a
// fabricated one.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Text as sha256Hex } from "../evidence/run-evidence-store.mjs";
import {
  readTriggerState, EVOLUTION_SIGNAL_CLASSES,
} from "./trigger.mjs";
import {
  candidateStorePath, derivationIndexPath,
} from "./candidate.mjs";
import { evolutionPolicyPath, EVOLUTION_POLICY_SCHEMA } from "./policy.mjs";

export const EVOLUTION_OPERATOR_REPORT_SCHEMA = "autoloop.evolution-operator-report/v1";

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function listCandidatesSafe(storeRoot) {
  const dir = candidateStorePath(storeRoot);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const c = readJsonSafe(join(dir, f));
    if (c?.schema === "autoloop.evolution-candidate/v1") out.push(c);
  }
  return out;
}

function listReviewsSafe(storeRoot) {
  const dir = join(storeRoot, "reviews");
  if (!existsSync(dir)) return {};
  const out = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const r = readJsonSafe(join(dir, f));
    if (r?.schema === "autoloop.evolution-review/v1") out[r.candidate_id] = r;
  }
  return out;
}

function listCanarySafe(storeRoot) {
  const dir = join(storeRoot, "canary");
  if (!existsSync(dir)) return {};
  const out = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const c = readJsonSafe(join(dir, f));
    if (c?.schema === "autoloop.evolution-canary/v1") out[c.candidate_id] = c;
  }
  return out;
}

/**
 * Build the read-only evolution report for one store root.
 * Total: every section present; absent data is UNKNOWN/empty, never invented.
 */
export function buildEvolutionReport({ storeRoot, env = process.env } = {}) {
  const root = storeRoot ?? env.AUTOLOOP_EVOLUTION_STORE_ROOT ?? null;
  const report = {
    schema: EVOLUTION_OPERATOR_REPORT_SCHEMA,
    storeRoot: root,
    generatedAt: new Date().toISOString(),
    policy: { state: "UNKNOWN", policyId: null, policyName: null, expiresAt: null, riskClassesAllowed: null },
    circuitBreaker: { state: "UNKNOWN", trippedAt: null, reason: null },
    generation: { current: null, derivations: 0 },
    triggers: { count: 0, latest: [], suppressed: 0 },
    candidates: [],
    reviews: {},
    canary: {},
    rollbacks: [],
    diagnostics: [],
  };
  if (!root || !existsSync(root)) {
    report.diagnostics.push({ code: "NO_EVOLUTION_STORE", detail: `no evolution store at ${root ?? "(unset)"}` });
    report.reportIdentity = sha256Hex(canonicalJson({ ...report, reportIdentity: undefined, generatedAt: undefined }));
    return report;
  }

  // Policy.
  const pPath = evolutionPolicyPath(root);
  if (existsSync(pPath)) {
    const p = readJsonSafe(pPath);
    if (p?.schema === EVOLUTION_POLICY_SCHEMA) {
      const expired = Date.parse(p.expires_at) <= Date.now();
      report.policy = {
        state: expired ? "EXPIRED" : "ACTIVE",
        policyId: p.policy_id,
        policyName: p.policy_name,
        expiresAt: p.expires_at,
        riskClassesAllowed: p.risk_classes_allowed ?? ["LOW"],
      };
    } else {
      report.diagnostics.push({ code: "POLICY_UNREADABLE", detail: pPath });
    }
  } else {
    report.policy.state = "ABSENT";
  }

  // Trigger state (dedup/cooldown/breaker).
  const ts = readTriggerState(root);
  report.circuitBreaker = ts.circuitBreaker
    ? { state: "TRIPPED", trippedAt: ts.circuitBreaker.at, reason: ts.circuitBreaker.reason }
    : { state: "CLEAR", trippedAt: null, reason: null };
  report.triggers = {
    count: (ts.triggers ?? []).length,
    latest: (ts.triggers ?? []).slice(-8).map((t) => ({
      trigger_id: t.trigger_id, signal_class: t.signal_class,
      signature: String(t.signature ?? "").slice(0, 16), observed_at: t.observed_at,
      evidence_refs: (t.evidence_refs ?? []).length,
    })),
    suppressed: Object.keys(ts.suppressedSignatures ?? {}).length,
  };

  // Derivation index (generation accounting).
  const idxPath = derivationIndexPath(root);
  if (existsSync(idxPath)) {
    const idx = readJsonSafe(idxPath);
    report.generation.derivations = Object.keys(idx?.derivations ?? {}).length;
  }

  // Candidates + reviews + canary, joined per candidate.
  const candidates = listCandidatesSafe(root);
  const reviews = listReviewsSafe(root);
  const canary = listCanarySafe(root);
  report.candidates = candidates.map((c) => ({
    candidate_id: c.candidate_id,
    signal_class: c.signal_class,
    risk_class: c.risk_class,
    baseline_head: String(c.baseline_head ?? "").slice(0, 12),
    baseline_revision: c.baseline_revision,
    affected_scope: c.affected_scope,
    derivation_strategy: c.derivation_strategy,
    // PRODUCTION ACTIVATION (Section G): explicit mutation / fitness /
    // promotion visibility (read-only, derived from the durable candidate).
    mutation: {
      strategy: c.derivation_strategy ?? null,
      edits: (c.mutation_plan?.edits ?? []).map((e) => ({ path: e.path, kind: e.kind })),
      rollback: c.rollback_plan?.kind ?? null,
    },
    fitness: {
      metric: c.expected_improvement?.metric ?? c.measurement_plan?.metric ?? null,
      direction: c.measurement_plan?.direction ?? null,
      cited_observation: c.expected_improvement?.cited_observation ?? null,
    },
    promotion: {
      review: reviews[c.candidate_id]
        ? { verdict: reviews[c.candidate_id].review_verdict, reviewer: reviews[c.candidate_id].reviewer_identity, digest: String(reviews[c.candidate_id].review_digest).slice(0, 16) }
        : null,
      canary: canary[c.candidate_id]
        ? { verdict: canary[c.candidate_id].verdict, rolled_back: canary[c.candidate_id].rolled_back === true, closes_at: canary[c.candidate_id].closes_at }
        : null,
      // autonomous promotion requires review PASS + canary HEALTHY/accepted;
      // anything else is visible as not-yet-promoted (no fabrication).
      promoted: Boolean(reviews[c.candidate_id]?.review_verdict === "PASS"
        && canary[c.candidate_id] && canary[c.candidate_id].rolled_back !== true
        && canary[c.candidate_id].verdict !== "REGRESSED"),
    },
    status: c.status,
    created_at: c.created_at,
    // legacy flat fields (kept for report consumers; promotion carries the
    // same data plus the promoted verdict)
    review: reviews[c.candidate_id]
      ? { verdict: reviews[c.candidate_id].review_verdict, reviewer: reviews[c.candidate_id].reviewer_identity, digest: String(reviews[c.candidate_id].review_digest).slice(0, 16) }
      : null,
    canary: canary[c.candidate_id]
      ? { verdict: canary[c.candidate_id].verdict, rolled_back: canary[c.candidate_id].rolled_back === true, closes_at: canary[c.candidate_id].closes_at }
      : null,
  }));
  report.reviews = Object.fromEntries(Object.entries(reviews).map(([k, v]) => [k, { verdict: v.review_verdict, reviewer: v.reviewer_identity }]));
  report.canary = Object.fromEntries(Object.entries(canary).map(([k, v]) => [k, { verdict: v.verdict, rolled_back: v.rolled_back === true }]));
  report.rollbacks = Object.values(canary).filter((c) => c.rolled_back === true).map((c) => ({
    candidate_id: c.candidate_id, rolled_back_at: c.rolled_back_at ?? null, baseline_head: String(c.baseline_head ?? "").slice(0, 12),
  }));

  report.reportIdentity = sha256Hex(canonicalJson({ ...report, reportIdentity: undefined, generatedAt: undefined }));
  return report;
}

/** Human-readable rendering (same conventions as the R-07 renderer). */
export function renderEvolutionReportText(report) {
  const lines = [];
  lines.push(`AutoLoop evolution report — ${report.storeRoot ?? "(no store)"}`);
  lines.push(`policy: ${report.policy.state}${report.policy.policyName ? ` (${report.policy.policyName})` : ""}${report.policy.expiresAt ? ` expires ${report.policy.expiresAt}` : ""}`);
  lines.push(`circuit breaker: ${report.circuitBreaker.state}${report.circuitBreaker.reason ? ` (${report.circuitBreaker.reason})` : ""}`);
  lines.push(`derivations: ${report.generation.derivations}; triggers recorded: ${report.triggers.count}; suppressed signatures: ${report.triggers.suppressed}`);
  if (report.triggers.latest.length > 0) {
    lines.push("latest triggers:");
    for (const t of report.triggers.latest) {
      lines.push(`  ${t.observed_at} ${t.signal_class} ${t.trigger_id} (evidence: ${t.evidence_refs} refs)`);
    }
  }
  if (report.candidates.length === 0) {
    lines.push("candidates: none");
  } else {
    lines.push(`candidates (${report.candidates.length}):`);
    for (const c of report.candidates) {
      const promo = c.promotion ?? {};
      const review = promo.review ? `review=${promo.review.verdict}(${promo.review.reviewer})` : "review=none";
      const canary = promo.canary ? `canary=${promo.canary.verdict}${promo.canary.rolled_back ? " ROLLED_BACK" : ""}` : "canary=none";
      const promoted = promo.promoted ? "PROMOTED" : "not-promoted";
      const mutation = c.mutation ? `mutation=${c.mutation.strategy ?? "none"}` : "mutation=none";
      const fitness = c.fitness?.metric ? `fitness-metric=${c.fitness.metric}` : "fitness-metric=none";
      lines.push(`  ${c.candidate_id} ${c.signal_class} risk=${c.risk_class} baseline=${c.baseline_head} ${review} ${canary} ${promoted}`);
      lines.push(`    scope: ${c.affected_scope.join(",")} strategy=${c.derivation_strategy} ${mutation} ${fitness}`);
    }
  }
  if (report.rollbacks.length > 0) {
    lines.push("rollbacks:");
    for (const r of report.rollbacks) lines.push(`  ${r.candidate_id} restored to ${r.baseline_head}`);
  }
  if (report.diagnostics.length > 0) {
    lines.push(`diagnostics (${report.diagnostics.length}):`);
    for (const d of report.diagnostics) lines.push(`  ${d.code}: ${d.detail}`);
  } else {
    lines.push("diagnostics: none");
  }
  lines.push(`reportIdentity: ${report.reportIdentity}`);
  return lines.join("\n");
}
