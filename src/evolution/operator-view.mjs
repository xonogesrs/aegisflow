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
import { readConfigEnv } from "../shared/autoloop-paths.mjs";
import {
  readTriggerState, EVOLUTION_SIGNAL_CLASSES,
} from "./trigger.mjs";
import {
  candidateStorePath, derivationIndexPath,
} from "./candidate.mjs";
import { evolutionPolicyPath, EVOLUTION_POLICY_SCHEMA, listEvolutionPolicyHistory } from "./policy.mjs";
import { strategyPolicyView } from "./strategy-store.mjs";
import { strategyMemoryView } from "./strategy-memory.mjs";
import { strategyFeedView } from "./attribution-feed.mjs";
import { readEvolutionProductionDeclaration, EVOLUTION_DECLARATION_ENV } from "./production-declaration.mjs";

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
  const root = storeRoot ?? readConfigEnv(env, "AEGISFLOW_EVOLUTION_STORE_ROOT")?.value ?? null;
  const report = {
    schema: EVOLUTION_OPERATOR_REPORT_SCHEMA,
    storeRoot: root,
    generatedAt: new Date().toISOString(),
    policy: { state: "UNKNOWN", policyId: null, policyName: null, expiresAt: null, riskClassesAllowed: null, generation: null, previousPolicyDigest: null, history: [] },
    circuitBreaker: { state: "UNKNOWN", trippedAt: null, reason: null },
    generation: { current: null, derivations: 0 },
    triggers: { count: 0, latest: [], suppressed: 0 },
    candidates: [],
    reviews: {},
    canary: {},
    rollbacks: [],
    // AGENT STRATEGY EVOLUTION (read-only): the active strategy policy and the
    // bounded performance memory the strategy candidates are derived from.
    strategy: { generation: 0, task_classes: [], active: {}, history: [], allowed_canonical_tool_ids: [] },
    strategyMemory: { total: 0, by_task_class: {}, latest: [] },
    // §A/§H EVIDENCE FEED (read-only): the every-run attribution feed's
    // durable disposition journal — the operator's window into whether
    // healthy/non-firing runs are being attributed, and into every feed or
    // attribution failure (which never changes a run result).
    attributionFeed: { counters: {}, failures: { total: 0, last: null }, total: 0, recorded: 0, latest: [], updated_at: null },
    // §J.2 PRODUCTION DECLARATION (read-only): which production declaration
    // record this deployment is using, and its validation errors (a malformed
    // record is ignored by the resolver, never silently).
    deployment: { provided: false, path: null, env: EVOLUTION_DECLARATION_ENV, errors: [] },
    diagnostics: [],
  };
  // §J.2: the deployment declaration is store-independent — report it even
  // when no evolution store exists yet.
  const decl = readEvolutionProductionDeclaration({ env });
  report.deployment = { provided: decl.provided, path: decl.path, env: EVOLUTION_DECLARATION_ENV, errors: decl.errors };
  if (decl.provided && decl.errors.length > 0) {
    report.diagnostics.push({ code: "DEPLOYMENT_DECLARATION_INVALID", detail: decl.errors.join("; ") });
  }
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
        // §J.1: which generation is active, which generation it succeeds, and
        // every preserved predecessor — a reissue is visible, not implicit.
        generation: p.generation ?? 0,
        previousPolicyDigest: p.previous_policy_digest ?? null,
        history: listEvolutionPolicyHistory(root),
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
  try {
    const sp = strategyPolicyView(root);
    report.strategy = {
      generation: sp.generation,
      updated_at: sp.updated_at,
      task_classes: sp.task_classes,
      active: sp.active,
      history: sp.history,
      allowed_canonical_tool_ids: sp.allowed_canonical_tool_ids,
    };
  } catch { /* absent/corrupt strategy policy → the empty default stands */ }
  try {
    const mv = strategyMemoryView({ storeRoot: root, limit: 16 });
    report.strategyMemory = { total: mv.total, updated_at: mv.updated_at, by_task_class: mv.by_task_class, latest: mv.latest };
  } catch { /* absent/corrupt memory → the empty default stands */ }
  try {
    const fv = strategyFeedView({ storeRoot: root, limit: 16 });
    report.attributionFeed = {
      counters: fv.counters, failures: fv.failures, total: fv.total, recorded: fv.recorded, latest: fv.latest, updated_at: fv.updated_at,
    };
    // §H: an attribution/feed failure is FAIL-OPEN (it never changes a run
    // result) but it must be VISIBLE to the operator.
    if ((fv.failures?.total ?? 0) > 0) {
      report.diagnostics.push({
        code: "ATTRIBUTION_FEED_FAILURE",
        detail: `${fv.failures.total} feed failure(s); last=${fv.failures.last?.disposition ?? "?"} reason=${String(fv.failures.last?.reason ?? "").slice(0, 160)}`,
      });
    }
  } catch { /* absent/corrupt feed log → the empty default stands */ }
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
  lines.push(`AegisFlow evolution report — ${report.storeRoot ?? "(no store)"}`);
  lines.push(`policy: ${report.policy.state}${report.policy.policyName ? ` (${report.policy.policyName})` : ""}${report.policy.expiresAt ? ` expires ${report.policy.expiresAt}` : ""}`);
  if (report.policy.generation !== null && report.policy.generation !== undefined) {
    lines.push(`policy generation: ${report.policy.generation}${report.policy.previousPolicyDigest ? ` (succeeds ${String(report.policy.previousPolicyDigest).slice(0, 12)})` : ""}; preserved generations: ${(report.policy.history ?? []).length}`);
  }
  lines.push(`deployment declaration: ${report.deployment.provided ? `${report.deployment.path}${report.deployment.errors.length > 0 ? ` INVALID(${report.deployment.errors.join(",")})` : ""}` : `not declared (${report.deployment.env} unset)`}`);
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
  // AGENT STRATEGY EVOLUTION (read-only).
  lines.push(`strategy policy: generation=${report.strategy.generation}; task classes=${report.strategy.task_classes.length > 0 ? report.strategy.task_classes.join(",") : "none"}`);
  for (const tc of report.strategy.task_classes) {
    for (const [dim, a] of Object.entries(report.strategy.active[tc] ?? {})) {
      lines.push(`  ${tc}/${dim} = ${a.value} (candidate=${a.candidate_id ?? "none"} gen=${a.generation})`);
    }
  }
  lines.push(`strategy memory: ${report.strategyMemory.total} observations; by task class=${JSON.stringify(report.strategyMemory.by_task_class)}`);
  lines.push(`attribution feed: ${report.attributionFeed.recorded}/${report.attributionFeed.total} dispositions recorded ${JSON.stringify(report.attributionFeed.counters)}; failures=${report.attributionFeed.failures.total}`);
  if (report.diagnostics.length > 0) {
    lines.push(`diagnostics (${report.diagnostics.length}):`);
    for (const d of report.diagnostics) lines.push(`  ${d.code}: ${d.detail}`);
  } else {
    lines.push("diagnostics: none");
  }
  lines.push(`reportIdentity: ${report.reportIdentity}`);
  return lines.join("\n");
}
