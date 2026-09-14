// src/subagent/delegation-decision.mjs
//
// CEDF Foundation — delegation decision model（pure, deterministic）.
//
// decideDelegation answers, per phase, HOW the phase should be executed:
//   INLINE | DELEGATE | PARALLEL_DELEGATE | SERIAL_DEPENDENCY | HOLD.
//
// Authority fence: this module owns NO scheduling authority. It is a pure
// classification consumed by an existing seam（execution-orchestrator）.
// It never reorders the DAG, never grants capabilities, never overrides the
// runner's single-writer lease. All semantics are fail-closed: any missing
// or incomplete input collapses to HOLD with explicit reason codes.
//
// Terminology reuses the canonical vocabulary only: generation, authority
// domain, blockingFindings, dependencyResultIdentities. No new authority
// nouns are introduced here.

// P7 subtraction note: ir-schema + schema-projection are KEEP_CORE (M35 —
// evidence/schema plumbing; FREEZE row M35) and stay in src/v2. Only the
// validation intelligence (M28 validators + scorecard, M29 prompt builder)
// moved to the optional layer. These five frozen vocabulary constants are
// schema metadata — pure data, no authority — consumed from the core M35
// module (delegation-decision itself remains KEEP_CORE per M14; fail-closed
// HOLD semantics unchanged).
import { REQUIRED_EFFECTS, REQUIRED_BOUNDARIES, EFFECT_VALUES, EVIDENCE_OUTPUT_VALUES, PLAN_REQUIRED } from "../v2/ir-schema.mjs";
import { PHASE_STATUS } from "../v2/runner.mjs";

export const DELEGATION_DECISIONS = Object.freeze({
  INLINE: "INLINE",
  DELEGATE: "DELEGATE",
  PARALLEL_DELEGATE: "PARALLEL_DELEGATE",
  SERIAL_DEPENDENCY: "SERIAL_DEPENDENCY",
  HOLD: "HOLD",
});

export const DELEGATION_DECISION_CODES = Object.freeze({
  ADMISSION_MISSING: "ADMISSION_MISSING",
  PHASE_MISSING: "PHASE_MISSING",
  DEPENDENCY_CONTRACT_INVALID: "DEPENDENCY_CONTRACT_INVALID",
  EFFECTS_CONTRACT_INCOMPLETE: "EFFECTS_CONTRACT_INCOMPLETE",
  BOUNDARY_CONTRACT_INCOMPLETE: "BOUNDARY_CONTRACT_INCOMPLETE",
  VERIFICATION_PLAN_INCOMPLETE: "VERIFICATION_PLAN_INCOMPLETE",
  WRITER_AUTHORITY_UNAVAILABLE: "WRITER_AUTHORITY_UNAVAILABLE",
  NON_TERMINAL_DEPENDENCY: "NON_TERMINAL_DEPENDENCY",
  TRIVIAL_EXPECTED_EXECUTION_COST: "TRIVIAL_EXPECTED_EXECUTION_COST",
  READ_ONLY_DISJOINT_BOUNDARIES: "READ_ONLY_DISJOINT_BOUNDARIES",
  INDEPENDENT_WORK_UNIT: "INDEPENDENT_WORK_UNIT",
});

// Canonical terminal phase statuses（runner.mjs PHASE_STATUS）. Anything
// else — pending, running, waiting_for_writer, unknown, missing — is
// non-terminal and blocks delegation（fail-closed）.
const TERMINAL_DEPENDENCY_STATUSES = new Set([
  PHASE_STATUS.PASSED,
  PHASE_STATUS.HELD,
  PHASE_STATUS.FAILED,
  PHASE_STATUS.SKIPPED_DUE_TO_DEPENDENCY,
]);

const MUTATION_EFFECTS = new Set(["allowed", "required"]);

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Normalize a boundary entry for intersection comparison（trailing slash is not an identity difference）. */
function normalizeBoundaryEntry(entry) {
  let s = String(entry);
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/**
 * Extract the artifact+evidence boundary identity set of a phase.
 * Returns null when the boundaries are not readable arrays — the caller
 * treats null as UNKNOWN overlap（fail-closed: never claims parallel）.
 */
function boundaryIdentitySet(phase) {
  const boundaries = phase?.effects?.boundaries;
  if (!isObject(boundaries)) return null;
  const artifact = boundaries.artifact;
  const evidence = boundaries.evidence;
  if (!Array.isArray(artifact) || !Array.isArray(evidence)) return null;
  const out = new Set();
  for (const e of [...artifact, ...evidence]) out.add(normalizeBoundaryEntry(e));
  return out;
}

/**
 * Decide how a phase should be executed.
 *
 * @param {object} input
 * @param {object} input.phase — IR v2 phase（phase_id, effects, verification_plan, depends_on）
 * @param {object[]} [input.readySiblings] — sibling phases ready in the same generation
 * @param {object} [input.dependencyStates] — map dependency id → status string | {status}
 * @param {object} [input.admission] — admission record（authority domain; mutation_scope）
 * @returns {{decision: string, reasons: string[]}}
 *
 * Precedence（high → low）:
 *   1. HOLD                 — fail-closed contract/authority gates
 *   2. SERIAL_DEPENDENCY    — a depends_on entry is not terminal
 *   3. INLINE               — no mutation, no deps, caller-declared trivial cost
 *   4. PARALLEL_DELEGATE    — read-only AND zero artifact/evidence boundary
 *                             intersection with every ready sibling
 *   5. DELEGATE             — independent work unit（default delegatable shape）
 *
 * INLINE is evaluated before PARALLEL_DELEGATE: a trivial-cost unit is by
 * definition read-only, so PARALLEL-first ordering would make INLINE
 * unreachable dead code. This keeps all five decisions reachable and
 * deterministic without inventing new authority semantics.
 */
export function decideDelegation({ phase, readySiblings, dependencyStates, admission } = {}) {
  // 1 ── HOLD: fail-closed gates ──────────────────────────────────────────
  const holdReasons = [];
  if (!isObject(admission)) return { decision: DELEGATION_DECISIONS.HOLD, reasons: [DELEGATION_DECISION_CODES.ADMISSION_MISSING] };
  if (!isObject(phase)) return { decision: DELEGATION_DECISIONS.HOLD, reasons: [DELEGATION_DECISION_CODES.PHASE_MISSING] };

  const effects = phase.effects;
  if (!isObject(effects)) {
    holdReasons.push(DELEGATION_DECISION_CODES.EFFECTS_CONTRACT_INCOMPLETE);
  } else {
    for (const key of REQUIRED_EFFECTS) {
      const values = key === "evidence_output" ? EVIDENCE_OUTPUT_VALUES : EFFECT_VALUES;
      if (!values.includes(effects[key])) {
        holdReasons.push(DELEGATION_DECISION_CODES.EFFECTS_CONTRACT_INCOMPLETE);
        break;
      }
    }
    const boundaries = effects.boundaries;
    if (!isObject(boundaries) || !REQUIRED_BOUNDARIES.every((b) => Array.isArray(boundaries[b]))) {
      holdReasons.push(DELEGATION_DECISION_CODES.BOUNDARY_CONTRACT_INCOMPLETE);
    }
  }

  const plan = phase.verification_plan;
  if (!isObject(plan) || !PLAN_REQUIRED.every((k) => plan[k] !== undefined && plan[k] !== null)) {
    holdReasons.push(DELEGATION_DECISION_CODES.VERIFICATION_PLAN_INCOMPLETE);
  }

  // Writer authority: a phase whose effects declare artifact mutation must
  // hold a non-empty sanctioned mutation boundary in its admission record.
  // Writer capability with an EMPTY mutationScope is fail-closed at
  // enforcement — it can never be delegated.
  const mutating = isObject(effects) && MUTATION_EFFECTS.has(effects.artifact_mutation);
  if (mutating && !(Array.isArray(admission.mutation_scope) && admission.mutation_scope.length > 0)) {
    holdReasons.push(DELEGATION_DECISION_CODES.WRITER_AUTHORITY_UNAVAILABLE);
  }

  if (holdReasons.length > 0) return { decision: DELEGATION_DECISIONS.HOLD, reasons: holdReasons };

  // Dependency contract: depends_on must be an array（IR v2 required field）.
  const deps = phase.depends_on;
  if (!Array.isArray(deps)) {
    return { decision: DELEGATION_DECISIONS.HOLD, reasons: [DELEGATION_DECISION_CODES.DEPENDENCY_CONTRACT_INVALID] };
  }

  // 2 ── SERIAL_DEPENDENCY: any non-terminal dependency ───────────────────
  const nonTerminal = deps.filter((depId) => {
    const state = isObject(dependencyStates) ? dependencyStates[depId] : undefined;
    const status = typeof state === "string" ? state : state?.status;
    return !TERMINAL_DEPENDENCY_STATUSES.has(status);
  });
  if (nonTerminal.length > 0) {
    return {
      decision: DELEGATION_DECISIONS.SERIAL_DEPENDENCY,
      reasons: [`${DELEGATION_DECISION_CODES.NON_TERMINAL_DEPENDENCY}:${nonTerminal.join(",")}`],
    };
  }

  const readOnly = !mutating;

  // 3 ── INLINE: explicitly declared trivial execution cost ───────────────
  // The caller must declare the cost on an explicit input field
  //（phase.expected_execution_cost === "trivial"）— never guessed from
  // title/summary/responsibility strings.
  if (readOnly && deps.length === 0 && phase.expected_execution_cost === "trivial") {
    return { decision: DELEGATION_DECISIONS.INLINE, reasons: [DELEGATION_DECISION_CODES.TRIVIAL_EXPECTED_EXECUTION_COST] };
  }

  // 4 ── PARALLEL_DELEGATE: read-only AND zero boundary intersection ──────
  if (readOnly) {
    const siblings = Array.isArray(readySiblings) ? readySiblings : [];
    const mine = boundaryIdentitySet(phase);
    const disjoint = siblings.every((sibling) => {
      const theirs = isObject(sibling) ? boundaryIdentitySet(sibling) : null;
      if (!mine || !theirs) return false; // unknown overlap → never claim parallel（fail-closed）
      for (const entry of mine) {
        if (theirs.has(entry)) return false;
      }
      return true;
    });
    if (disjoint) {
      return { decision: DELEGATION_DECISIONS.PARALLEL_DELEGATE, reasons: [DELEGATION_DECISION_CODES.READ_ONLY_DISJOINT_BOUNDARIES] };
    }
  }

  // 5 ── DELEGATE: single independent work unit, clear boundary, evidence
  //      verifiable through the phase's own verification plan ─────────────
  return { decision: DELEGATION_DECISIONS.DELEGATE, reasons: [DELEGATION_DECISION_CODES.INDEPENDENT_WORK_UNIT] };
}
