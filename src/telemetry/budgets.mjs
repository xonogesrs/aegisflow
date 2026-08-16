// src/telemetry/budgets.mjs
//
// COST-1 — budget contract（autoloop.telemetry-budget/v1）.
//
// Defines the budget SCHEMA + validation + SIMULATED enforcement ONLY. This
// card does NOT wire any budget into production scheduler / model / review /
// repair behavior（card stage 7: real adaptive enforcement is a later Cost
// Optimization stage）. simulateBudgetEnforcement returns violations without
// touching any task — tests prove production routing is untouched.

import { TELEMETRY_BUDGET_SCHEMA } from "./contract.mjs";

export const BUDGET_KINDS = Object.freeze([
  "tokenBudget",
  "timeBudget",
  "toolCallBudget",
  "retrievalByteBudget",
  "researchQueryBudget",
  "retryBudget",
  "repairBudget",
  "subAgentBudget",
]);

export const BUDGET_UNITS = Object.freeze([
  "tokens", "ms", "count", "bytes", "queries", "attempts", "repairs", "agents",
]);

const KIND_UNIT = Object.freeze({
  tokenBudget: "tokens",
  timeBudget: "ms",
  toolCallBudget: "count",
  retrievalByteBudget: "bytes",
  researchQueryBudget: "queries",
  retryBudget: "attempts",
  repairBudget: "repairs",
  subAgentBudget: "agents",
});

export const DEFAULT_BUDGETS = Object.freeze({
  tokenBudget: { limit: null, unit: "tokens", policy: "soft", enforced: false },
  timeBudget: { limit: null, unit: "ms", policy: "soft", enforced: false },
  toolCallBudget: { limit: null, unit: "count", policy: "soft", enforced: false },
  retrievalByteBudget: { limit: null, unit: "bytes", policy: "soft", enforced: false },
  researchQueryBudget: { limit: null, unit: "queries", policy: "soft", enforced: false },
  retryBudget: { limit: null, unit: "attempts", policy: "soft", enforced: false },
  repairBudget: { limit: null, unit: "repairs", policy: "soft", enforced: false },
  subAgentBudget: { limit: null, unit: "agents", policy: "soft", enforced: false },
});

export function validateTelemetryBudgetV1(budget) {
  const errors = [];
  if (!budget || typeof budget !== "object") return { valid: false, errors: ["budget_missing"] };
  if (budget.schema !== TELEMETRY_BUDGET_SCHEMA) errors.push(`schema_mismatch:${String(budget.schema)}`);
  if (typeof budget.name !== "string" || budget.name.length === 0) errors.push("name_required");
  if (typeof budget.version !== "number" || budget.version !== 1) errors.push("version_invalid");
  for (const kind of BUDGET_KINDS) {
    const entry = budget[kind];
    if (entry === null || entry === undefined) continue;
    if (typeof entry !== "object" || Array.isArray(entry)) { errors.push(`${kind}_must_be_object`); continue; }
    if (entry.limit !== null && entry.limit !== undefined && (!Number.isFinite(entry.limit) || entry.limit < 0)) errors.push(`${kind}_limit_invalid`);
    if (entry.unit !== KIND_UNIT[kind]) errors.push(`${kind}_unit_mismatch:${String(entry.unit)}`);
    if (entry.policy !== "soft" && entry.policy !== "hard") errors.push(`${kind}_policy_invalid`);
    if (entry.enforced !== false && entry.enforced !== true) errors.push(`${kind}_enforced_invalid`);
    if (entry.enforced === true) errors.push(`${kind}_enforced_must_be_false_in_COST1`);
  }
  const extra = Object.keys(budget).filter((k) => !["schema", "name", "version", ...BUDGET_KINDS].includes(k));
  if (extra.length) errors.push(`unknown_field:${extra.join(",")}`);
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] };
}

/**
 * SIMULATED enforcement: returns { ok, violations } for an aggregate — it
 * NEVER changes behavior and NEVER reads live routing. Tests freeze the
 * contract; future Cost Optimization wiring will flip `enforced` per budget.
 */
export function simulateBudgetEnforcement({ budget, aggregate = null, usage = null } = {}) {
  const v = validateTelemetryBudgetV1(budget);
  if (!v.valid) return { ok: false, violations: v.errors.map((e) => `budget_invalid:${e}`), enforced: false };
  const violations = [];
  const u = usage ?? {
    totalTokens: aggregate?.reportedTokens?.total ?? null,
    totalDurationMs: aggregate?.totalDurationMs ?? null,
    toolCallCount: aggregate?.toolCallCount ?? null,
    retrievalBytes: aggregate?.retrieval?.byteCount ?? null,
    retryCount: 0,
    repairCount: aggregate?.repairCount ?? null,
    subAgentCount: aggregate?.subAgentCount ?? null,
  };
  if (budget.tokenBudget?.limit != null && u.totalTokens != null && u.totalTokens > budget.tokenBudget.limit) violations.push(`tokenBudget_exceeded:${u.totalTokens}>${budget.tokenBudget.limit}`);
  if (budget.timeBudget?.limit != null && u.totalDurationMs != null && u.totalDurationMs > budget.timeBudget.limit) violations.push(`timeBudget_exceeded:${u.totalDurationMs}>${budget.timeBudget.limit}`);
  if (budget.toolCallBudget?.limit != null && u.toolCallCount != null && u.toolCallCount > budget.toolCallBudget.limit) violations.push(`toolCallBudget_exceeded:${u.toolCallCount}>${budget.toolCallBudget.limit}`);
  if (budget.retrievalByteBudget?.limit != null && u.retrievalBytes != null && u.retrievalBytes > budget.retrievalByteBudget.limit) violations.push(`retrievalByteBudget_exceeded:${u.retrievalBytes}>${budget.retrievalByteBudget.limit}`);
  if (budget.repairBudget?.limit != null && u.repairCount != null && u.repairCount > budget.repairBudget.limit) violations.push(`repairBudget_exceeded:${u.repairCount}>${budget.repairBudget.limit}`);
  if (budget.subAgentBudget?.limit != null && u.subAgentCount != null && u.subAgentCount > budget.subAgentBudget.limit) violations.push(`subAgentBudget_exceeded:${u.subAgentCount}>${budget.subAgentBudget.limit}`);
  return { ok: violations.length === 0, violations, enforced: false, simulated: true };
}
