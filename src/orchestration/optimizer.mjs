// src/orchestration/optimizer.mjs
//
// P7 SUBTRACTION (M25-optimizer → OPTIONAL_ORCHESTRATION) — relocated from
// src/control-plane/optimizer.mjs by
// AUTOLOOP-V1-STAGE-G-P7-GOVERNANCE-CENTRIC-SUBTRACTION-IMPLEMENTATION-1.
// The control-plane COORDINATOR (KEEP_CORE) keeps the budget authority
// (global split, envelope derivation, allocation binding) and consumes this
// advisory through an optional seam; when this module is absent the
// coordinator's deterministic advisory fallback applies. Nothing here is
// authority: the decision record is a RECOMMENDATION, and the execution
// sink re-validates admission identity + allocation binding + budget
// enforcement regardless of what this advisory said.
//
// CP-2R1 — bounded deterministic cost optimizer (CP-1 cost-optimizer-contract),
// repaired for authority/budget fail-closed enforcement.
//
// runOptimizer(decisionContext) → decision record. PURE and DETERMINISTIC:
// identical input → identical output (no time, no randomness, no I/O).
//
// Repairs (CP-2R1 findings):
//   - the model/provider allowlist is AUTHORITATIVE configuration truth
//     (imported), never caller-controlled; a caller-supplied allowlist that
//     does not match the authoritative one is rejected (Finding 4);
//   - budgetRemaining (ledger authority) is REQUIRED — missing → HOLD, never
//     defaulted to the full envelope (Finding 2);
//   - runtime is a validated admission-derived value; unknown/invalid →
//     HOLD, never a permissive fallback (Finding 5);
//   - budget allocation is a validated per-task ceiling (already split by the
//     coordinator); allocation may only NARROW the envelope (Finding 1/2).
//
// It NEVER mints admission / budget / lifecycle / review / telemetry
// authority, never invents a fallback, never escapes a closed enum, and never
// ranks by cost/quality (scoring deferred per CP-1 §5).

import { createHash } from "node:crypto";
import {
  OPTIMIZER_DECISION_SCHEMA,
  OPTIMIZER_DECISION_VERSION,
  RETRY_REPLAN_CHOICES,
  REVIEWER_STRATEGIES,
  EXECUTOR_RUNTIMES,
  ESCALATION_IN_ENVELOPE,
  OPTIMIZER_HOLDS,
  EXECUTOR_MODEL_ALLOWLIST,
} from "../control-plane/contract.mjs";
import { assertProductionAdmission } from "../admission/admission-gate.mjs";
import { assertEnvelopeUntampered } from "../budget/envelope.mjs";
import { deriveExecutorRuntime } from "../admission/policy-projection.mjs";
import { ENFORCED_DIMENSIONS } from "../budget/contract.mjs";

function sha256Hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Run the bounded deterministic optimizer.
 *
 * @param {object} ctx
 * @param {object} ctx.admission — frozen admission record (authority)
 * @param {object|null} ctx.budgetEnvelope — admission-derived budget envelope
 * @param {object|null} ctx.budgetRemaining — REQUIRED ledger-derived remaining
 *        budget per dimension (missing → HOLD, never defaulted). The
 *        coordinator passes the EFFECTIVE remaining (narrowed by the global
 *        allocation).
 * @param {object|null} [ctx.taskAllocation] — per-task global-budget split
 *        { dimensions: { [dim]: limit } } computed by the coordinator; may
 *        only narrow the envelope
 * @param {string|null} [ctx.runtime] — OPTIONAL caller/context evidence; the
 *        runtime is AUTHORITATIVELY derived from the admission's
 *        isolation/durability policy. Provided evidence must equal the
 *        derivation or HOLD (Finding 5).
 * @param {string[]} ctx.eligibleTransitions — eligible transition set owned
 *        by the Lifecycle Runner (subset of RETRY_REPLAN_CHOICES); missing →
 *        HOLD MISSING_LIFECYCLE_AUTHORITY (Finding 2)
 * @param {string[]|null} ctx.eligibleReviewers — eligible reviewer set owned
 *        by the admission review policy (subset of REVIEWER_STRATEGIES), or
 *        null when no reviewer is required
 * @param {object|null} [ctx.observed] — { source, aggregateIdentity }
 *        provenance-bearing telemetry snapshot
 * @param {Array|null} [ctx.executorAllowlist] — OPTIONAL; if provided it MUST
 *        equal the authoritative allowlist, else HOLD (caller may not mint/
 *        replace the allowlist — Finding 4)
 * @returns {object} decision record (always returned; never throws for
 *        expected failures)
 */
export function runOptimizer(ctx = {}) {
  const errors = [];
  const info = [];
  const fail = (code, reason) => errors.push({ code, reason: `${code}: ${reason}` });

  const admission = ctx?.admission ?? null;
  const envelope = ctx?.budgetEnvelope ?? null;
  const remaining = ctx?.budgetRemaining ?? null;
  const runtime = ctx?.runtime ?? null;

  // ── 1. authority inputs — fail-closed ─────────────────────────────────
  if (!admission || typeof admission !== "object" || Array.isArray(admission)) {
    fail(OPTIMIZER_HOLDS.MALFORMED_INPUT, "missing admission record");
  } else {
    // FULL authoritative admission validation (id format + re-derivation +
    // schema/capability/profile) — a rehashed/forged admission with a valid
    // id but invalid content must NOT pass (Finding 3).
    const gate = assertProductionAdmission(admission);
    if (!gate.ok) {
      const code = gate.holdCode === "ADMISSION_REQUIRED" ? OPTIMIZER_HOLDS.MALFORMED_INPUT : OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY;
      fail(code, `admission not authoritative (${gate.reason})`);
    }
  }

  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    fail(OPTIMIZER_HOLDS.MALFORMED_INPUT, "missing budget envelope");
  } else {
    const intact = assertEnvelopeUntampered(envelope);
    if (!intact.ok) fail(OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY, `envelope not intact (${intact.reason})`);
    else if (admission && envelope.admissionId !== admission.admission_id) {
      fail(OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY, "envelope.admissionId does not match admission.admission_id");
    }
  }

  // Budget remaining (ledger authority) is REQUIRED — a missing ledger must
  // never be converted into a permissive full-envelope default (Finding 2).
  if (remaining === null || remaining === undefined) {
    fail(OPTIMIZER_HOLDS.MISSING_BUDGET_AUTHORITY, "missing budget remaining (ledger authority required)");
  } else if (typeof remaining !== "object" || Array.isArray(remaining)) {
    fail(OPTIMIZER_HOLDS.MALFORMED_INPUT, "budgetRemaining must be an object");
  } else {
    for (const [d, v] of Object.entries(remaining)) {
      if (!ENFORCED_DIMENSIONS.includes(d)) fail(OPTIMIZER_HOLDS.UNKNOWN_ENUM, `budgetRemaining unknown dimension ${d}`);
      else if (v !== null && v !== undefined && (!Number.isFinite(v) || v < 0)) fail(OPTIMIZER_HOLDS.MALFORMED_INPUT, `budgetRemaining ${d} invalid (${v})`);
    }
  }

  // ── 2. runtime — ADMISSION-DERIVED, validated (Finding 5) ─────────────
  // The runtime is derived from the validated admission's isolation/durability
  // policy. A caller/context-provided runtime is evidence ONLY — it must equal
  // the authoritative derivation or HOLD. The optimizer never selects or
  // substitutes runtime independently.
  let runtimeValue = null;
  {
    const derived = admission && typeof admission === "object" && !Array.isArray(admission)
      ? deriveExecutorRuntime(admission)
      : null;
    if (runtime !== null && runtime !== undefined) {
      if (!EXECUTOR_RUNTIMES.includes(runtime)) {
        fail(OPTIMIZER_HOLDS.UNKNOWN_ENUM, `unknown runtime ${runtime}`);
      } else if (runtime !== derived) {
        fail(OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY, `caller runtime ${runtime} does not match admission-derived runtime ${derived ?? "null"}`);
      }
    }
    if (derived === null || derived === undefined) {
      fail(OPTIMIZER_HOLDS.RUNTIME_UNRESOLVED, "runtime policy unresolved (admission isolation/durability policy maps to no known runtime)");
    } else if (!EXECUTOR_RUNTIMES.includes(derived)) {
      fail(OPTIMIZER_HOLDS.UNKNOWN_ENUM, `unknown admission-derived runtime ${derived}`);
    } else {
      runtimeValue = derived;
    }
  }

  // ── 3. executor selection — authoritative allowlist (Finding 4) ───────
  // The allowlist is AUTHORITATIVE configuration truth. A caller may not
  // substitute or expand it; shape validation is not enough.
  let executor = null;
  {
    const supplied = ctx?.executorAllowlist;
    if (supplied !== null && supplied !== undefined) {
      if (canonicalJson(supplied) !== canonicalJson(EXECUTOR_MODEL_ALLOWLIST)) {
        fail(OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY, "caller-supplied allowlist does not match the authoritative allowlist (authority/provenance mismatch)");
      }
    }
    const allowlist = EXECUTOR_MODEL_ALLOWLIST;
    if (!Array.isArray(allowlist) || allowlist.length === 0) {
      fail(OPTIMIZER_HOLDS.OWNERSHIP_UNRESOLVED, "no authorized executor allowlist");
    } else if (allowlist.length === 1) {
      executor = { provider: allowlist[0].provider, model: allowlist[0].model };
      info.push(`executor: sole eligible option (${executor.provider}/${executor.model})`);
    } else {
      info.push("executor: multiple eligible options — no scoring policy frozen; owner default applies");
    }
  }

  // ── 4. retry/replan — eligible transition set (Lifecycle Runner owns) ──
  let retryReplan = null;
  {
    const tr = ctx?.eligibleTransitions;
    if (tr === null || tr === undefined) {
      fail(OPTIMIZER_HOLDS.MISSING_LIFECYCLE_AUTHORITY, "missing lifecycle authority (eligible transition set not provided by the Lifecycle Runner)");
    } else if (!Array.isArray(tr)) {
      fail(OPTIMIZER_HOLDS.MALFORMED_INPUT, "eligibleTransitions must be an array");
    } else if (tr.length === 0) {
      fail(OPTIMIZER_HOLDS.NO_ELIGIBLE_OPTION, "no eligible transition (authoritative constraint requires HOLD)");
    } else {
      let unknown = false;
      for (const t of tr) {
        if (!RETRY_REPLAN_CHOICES.includes(t)) { fail(OPTIMIZER_HOLDS.UNKNOWN_ENUM, `unknown transition ${t}`); unknown = true; break; }
      }
      if (!unknown) {
        // REPLAN eligibility is owned by the admission repair authority; a
        // caller-substituted set that claims REPLAN with repair_budget 0 is
        // contradictory（defense in depth — the Lifecycle Runner never emits
        // this）.
        if (tr.includes("REPLAN") && admission && Number.isFinite(admission.repair_budget) && admission.repair_budget === 0) {
          fail(OPTIMIZER_HOLDS.CONTRADICTORY_AUTHORITY, "REPLAN eligible but admission.repair_budget = 0");
        }
        // NOTE: retry budget exhaustion is handled by the required-dimension
        // exhaustion check (Finding 2), NOT as a lifecycle contradiction —
        // budget constrains execution; it does not mint/deny transitions.
        if (tr.length === 1) {
          retryReplan = tr[0];
          info.push(`retryReplan: sole eligible option (${tr[0]})`);
        } else {
          info.push("retryReplan: multiple eligible options — owner default applies");
        }
      }
    }
  }

  // ── 5. reviewer strategy — eligible reviewer set (admission review policy) ──
  let reviewerStrategy = null;
  {
    const rv = ctx?.eligibleReviewers;
    if (rv === null || rv === undefined) {
      info.push("reviewerStrategy: no reviewer required (review_policy.strength=none)");
    } else if (!Array.isArray(rv) || rv.length === 0) {
      fail(OPTIMIZER_HOLDS.NO_ELIGIBLE_OPTION, "no eligible reviewer strategy");
    } else {
      let unknown = false;
      for (const r of rv) {
        if (!REVIEWER_STRATEGIES.includes(r)) { fail(OPTIMIZER_HOLDS.UNKNOWN_ENUM, `unknown reviewer strategy ${r}`); unknown = true; break; }
      }
      if (!unknown) {
        if (rv.length === 1) {
          reviewerStrategy = rv[0];
          info.push(`reviewerStrategy: sole eligible option (${rv[0]})`);
        } else {
          info.push("reviewerStrategy: multiple eligible options — owner default applies");
        }
      }
    }
  }

  // ── 6. budget allocation — narrowing only (Finding 1/2) ───────────────
  let budgetAllocation = null;
  {
    const ta = ctx?.taskAllocation ?? null;
    if (ta === null || ta === undefined) {
      info.push("budgetAllocation: no Controller global budget allocation provided");
    } else if (typeof ta !== "object" || Array.isArray(ta)) {
      fail(OPTIMIZER_HOLDS.MALFORMED_INPUT, "taskAllocation must be an object");
    } else {
      const td = ta.dimensions;
      if (!td || typeof td !== "object" || Array.isArray(td)) {
        fail(OPTIMIZER_HOLDS.MALFORMED_INPUT, "taskAllocation.dimensions must be an object");
      } else {
        const dims = {};
        let invalid = false;
        for (const [d, limit] of Object.entries(td)) {
          if (!ENFORCED_DIMENSIONS.includes(d)) { fail(OPTIMIZER_HOLDS.UNKNOWN_ENUM, `taskAllocation unknown dimension ${d}`); invalid = true; break; }
          if (limit === null || limit === undefined) continue;
          if (!Number.isFinite(limit) || limit < 0) { fail(OPTIMIZER_HOLDS.MALFORMED_INPUT, `taskAllocation ${d} invalid (${limit})`); invalid = true; break; }
          const envLimit = envelope?.dimensions?.[d]?.limit ?? null;
          if (envLimit !== null && envLimit !== undefined && limit > envLimit) {
            fail(OPTIMIZER_HOLDS.OUT_OF_ENVELOPE, `taskAllocation ${d} ${limit} exceeds envelope limit ${envLimit} (allocation may only narrow)`);
            invalid = true;
            break;
          }
          dims[d] = limit;
        }
        if (!invalid) budgetAllocation = { dimensions: dims };
      }
    }
  }

  // ── 7. observed optimization inputs — provenance required ─────────────
  let observedProvenance = null;
  {
    const obs = ctx?.observed ?? null;
    if (obs !== null && obs !== undefined) {
      if (!obs || typeof obs !== "object" || Array.isArray(obs) || typeof obs.source !== "string" || typeof obs.aggregateIdentity !== "string") {
        fail(OPTIMIZER_HOLDS.MISSING_PROVENANCE, "observed optimization inputs lack provenance (source + aggregateIdentity required)");
      } else {
        observedProvenance = { source: obs.source, aggregateIdentity: obs.aggregateIdentity };
      }
    }
  }

  // ── 7b. required-dimension exhaustion (Finding 2) ──────────────────────
  // A dimension is REQUIRED for this execution when the admission-derived
  // envelope declares a positive limit for it. If the EFFECTIVE remaining
  // (ledger remaining narrowed by the Controller global allocation) for a
  // required dimension is 0, the execution would consume an exhausted
  // dimension ⇒ HOLD. Budget state constrains execution; it does not mint a
  // transition to bypass the exhaustion.
  if (envelope && remaining && typeof remaining === "object" && !Array.isArray(remaining)) {
    for (const d of ENFORCED_DIMENSIONS) {
      const envLimit = envelope.dimensions?.[d]?.limit;
      if (envLimit === null || envLimit === undefined || envLimit <= 0) continue; // not required
      const rem = remaining[d];
      if (rem !== null && rem !== undefined && Number.isFinite(rem) && rem <= 0) {
        fail(OPTIMIZER_HOLDS.BUDGET_EXHAUSTED, `required dimension ${d} exhausted (effective remaining ${rem}, envelope limit ${envLimit})`);
      }
    }
  }

  // ── 8. assemble ───────────────────────────────────────────────────────
  const hold = errors.length > 0;
  const recommendation = hold
    ? "HOLD"
    : (executor || retryReplan || reviewerStrategy) ? "RECOMMENDATION" : "NO_RECOMMENDATION";

  const decision = {
    schema: OPTIMIZER_DECISION_SCHEMA,
    version: OPTIMIZER_DECISION_VERSION,
    recommendation,
    holdCode: hold ? errors[0].code : null,
    escalationClass: hold ? errors[0].code : ESCALATION_IN_ENVELOPE,
    reasons: [...errors.map((e) => e.reason), ...info],
    executor,
    runtime: runtimeValue,
    retryReplan,
    reviewerStrategy,
    budgetAllocation,
    observedProvenance,
    decisionId: null,
  };
  decision.decisionId = sha256Hex(canonicalJson(ctx ?? {}));
  return decision;
}
