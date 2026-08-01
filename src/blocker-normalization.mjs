#!/usr/bin/env node
// blocker-normalization.mjs
//
// Phase C2A: implements the 15-row canonical blocker normalization table.
//
// normalize():       maps structured fields → normalized_problem_id + blocker_origin
//                      ALL 15 rows collected, sorted by precedence, lowest wins
// normalizeFacts():  maps eligibility facts → present/missing/valid/invalid
//                      C2A stops at normalization — no score, no disqualify.
//                      Score/disqualify is C2B responsibility.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NORMALIZATION_TABLE = [
  { precedence: 1,  source: "termination_reason",      match: "missing_canonical_blocker",      problemId: "blocker_missing",            blockerOrigin: "reviewer_schema_missing" },
  { precedence: 2,  source: "termination_reason",      match: "non_repairable_reviewer_outcome", problemId: "blocker_missing",            blockerOrigin: "reviewer_schema_missing" },
  { precedence: 3,  source: "termination_reason",      match: "repair_target_scope_violation",   problemId: "scope_violation",            blockerOrigin: "lifecycle_order_violation" },
  { precedence: 4,  source: "termination_reason",      match: "non_repairable_blocker",          problemId: "blocker_non_repairable",     blockerOrigin: "cannot_determine" },
  { precedence: 5,  source: "termination_reason",      match: "same_blocker_repeated",           problemId: "blocker_repeated",           blockerOrigin: "runner_loop_stuck" },
  { precedence: 6,  source: "termination_reason",      match: "validation_failed",               problemId: "validation_gap",             blockerOrigin: "lifecycle_order_violation" },
  { precedence: 7,  source: "termination_reason",      match: "execution_failed",                problemId: "execution_failure",          blockerOrigin: "cannot_determine" },
  { precedence: 8,  source: "termination_reason",      match: "repair_facts_write_failed",       problemId: "sidecar_write_failure",      blockerOrigin: "sidecar_persistence_failure" },
  { precedence: 9,  source: "last_blocking_reason",    prefix: "missing_negative_",                                                   problemId: "missing_negative_evidence",   blockerOrigin: "missing_negative_evidence" },
  { precedence: 10, source: "evidence_gaps",           contains: "missing_",                                                           problemId: null, /* dynamic: evidence_gap:<value> */  blockerOrigin: "missing_negative_evidence" },
  { precedence: 11, source: "last_blocking_reason",    prefix: "authority_",                                                           problemId: "authority_concern",           blockerOrigin: "authority_boundary_question" },
  { precedence: 12, source: "last_blocking_reason",    prefix: "governance_",                                                          problemId: "governance_signal",           blockerOrigin: "policy_change_indicated" },
  { precedence: 13, source: "convergence",             match: "CONVERGED_WITHOUT_REPAIR",                                              problemId: null,                          blockerOrigin: null },
  { precedence: 14, source: "convergence",             prefix: "NOT_CONVERGED_",                                                       problemId: null,                          blockerOrigin: "cannot_determine" },
  { precedence: 15, source: null,                                                                                                      problemId: "unclassified",                blockerOrigin: "cannot_determine" },
];

export { NORMALIZATION_TABLE };

const KNOWN_NON_PASS_TERMINATION_REASONS = new Set([
  ...NORMALIZATION_TABLE.filter((row) => row.precedence >= 1 && row.precedence <= 8).map((row) => row.match),
  "max_repair_rounds_reached", "repair_round_requested", "non_repairable",
]);
const KNOWN_CONVERGED = new Set(["CONVERGED_WITHOUT_REPAIR", "CONVERGED_AFTER_REPAIR"]);
const KNOWN_NON_CONVERGED = new Set([
  "NOT_CONVERGED_MAX_RETRIES", "NOT_CONVERGED_SAME_BLOCKER", "NOT_CONVERGED_NON_REPAIRABLE",
  "NOT_CONVERGED_INVALID_REVIEWER_RESULT", "NOT_CONVERGED_VALIDATION_FAILURE",
  "NOT_CONVERGED_EXECUTOR_FAILURE", "NOT_CONVERGED_SCOPE_VIOLATION", "NOT_CONVERGED_INFRASTRUCTURE_FAILURE",
]);
const KNOWN_NON_PASS_EXTERNAL_VERDICTS = new Set(["HOLD", "BLOCKED", "NEEDS_RETRY", "SKIP", "FAILED"]);

function collectCandidates(sidecar) {
  const candidates = [];

  // Precedence 1-8: termination_reason exact
  const tr = sidecar.termination_reason;
  if (typeof tr === "string") {
    for (const row of NORMALIZATION_TABLE) {
      if (row.precedence <= 8 && row.source === "termination_reason" && row.match === tr) {
        candidates.push(row);
      }
    }
  }

  // Precedence 9: last_blocking_reason prefix "missing_negative_"
  const lbr = sidecar.last_blocking_reason;
  if (typeof lbr === "string") {
    const row9 = NORMALIZATION_TABLE.find(r => r.precedence === 9);
    if (row9 && lbr.startsWith(row9.prefix)) {
      candidates.push({ ...row9, problemId: row9.problemId });
    }
  }

  // Precedence 10: evidence_gaps contains "missing_"
  const gaps = sidecar.evidence_gaps;
  if (Array.isArray(gaps)) {
    const row10 = NORMALIZATION_TABLE.find(r => r.precedence === 10);
    if (row10) {
      for (const gap of gaps) {
        if (typeof gap === "string" && gap.includes(row10.contains)) {
          candidates.push({ ...row10, problemId: `evidence_gap:${gap}` });
          break;
        }
      }
    }
  }

  // Precedence 11: last_blocking_reason prefix "authority_"
  if (typeof lbr === "string") {
    const row11 = NORMALIZATION_TABLE.find(r => r.precedence === 11);
    if (row11 && lbr.startsWith(row11.prefix)) {
      candidates.push({ ...row11, problemId: row11.problemId });
    }
  }

  // Precedence 12: last_blocking_reason prefix "governance_"
  if (typeof lbr === "string") {
    const row12 = NORMALIZATION_TABLE.find(r => r.precedence === 12);
    if (row12 && lbr.startsWith(row12.prefix)) {
      candidates.push({ ...row12, problemId: row12.problemId });
    }
  }

  // Precedence 13: convergence exact "CONVERGED_WITHOUT_REPAIR"
  const conv = sidecar.convergence;
  if (conv === "CONVERGED_WITHOUT_REPAIR") {
    candidates.push(NORMALIZATION_TABLE.find(r => r.precedence === 13));
  }

  // Precedence 14: convergence prefix "NOT_CONVERGED_"
  if (typeof conv === "string" && conv.startsWith("NOT_CONVERGED_")) {
    const row14 = NORMALIZATION_TABLE.find(r => r.precedence === 14);
    if (row14) {
      candidates.push({ ...row14, problemId: `non_convergent_${conv}` });
    }
  }

  // Always add precedence 15 as fallback
  candidates.push(NORMALIZATION_TABLE.find(r => r.precedence === 15));

  return candidates;
}

export function normalize(sidecar) {
  if (!sidecar || typeof sidecar !== "object") {
    return { normalized_problem_id: "unclassified", blocker_origin: "cannot_determine", matched_precedence: 15 };
  }

  const candidates = collectCandidates(sidecar);
  // Sort by precedence ascending (lower number = higher priority)
  candidates.sort((a, b) => a.precedence - b.precedence);
  const best = candidates[0];

  // Precedence 13 (CONVERGED_WITHOUT_REPAIR) means no candidate needed
  if (best.precedence === 13 && best.blockerOrigin === null) {
    return { normalized_problem_id: null, blocker_origin: null, matched_precedence: 13, no_candidate: true };
  }

  const problemId = best.problemId || "unclassified";
  const blockerOrigin = best.blockerOrigin || "cannot_determine";

  return { normalized_problem_id: problemId, blocker_origin: blockerOrigin, matched_precedence: best.precedence };
}

export function normalizeFacts(sidecar) {
  // C2A: only normalize fact state (present/missing, valid/invalid)
  // No scoring, no disqualify — that is C2B's responsibility.
  const result = {};

  for (const fact of ["false_pass_confirmed", "authority_violation", "target_expansion_detected",
    "unauthorized_git_operation", "assertion_weakened", "seal_complete"]) {
    const v = sidecar[fact];
    if (v === undefined || v === null) {
      result[fact] = "missing";
    } else if (v === true) {
      result[fact] = "present_true";
    } else if (v === false) {
      result[fact] = "present_false";
    } else {
      result[fact] = "invalid";
    }
  }

  // termination_reason
  const tr = sidecar.termination_reason;
  if (tr === undefined || tr === null) {
    result.termination_reason = "missing";
  } else if (tr === "review_passed") {
    result.termination_reason = "valid_pass";
  } else if (KNOWN_NON_PASS_TERMINATION_REASONS.has(tr)) {
    result.termination_reason = "valid_non_pass";
  } else {
    result.termination_reason = "unknown";
  }

  // convergence
  const conv = sidecar.convergence;
  if (conv === undefined || conv === null) {
    result.convergence = "missing";
  } else if (KNOWN_CONVERGED.has(conv)) {
    result.convergence = "valid_converged";
  } else if (KNOWN_NON_CONVERGED.has(conv)) {
    result.convergence = "valid_non_converged";
  } else {
    result.convergence = "unknown";
  }

  // external_review_verdict
  const erv = sidecar.external_review_verdict;
  if (erv === undefined || erv === null) {
    result.external_review_verdict = "missing";
  } else if (erv === "PASS") {
    result.external_review_verdict = "valid_pass";
  } else if (KNOWN_NON_PASS_EXTERNAL_VERDICTS.has(erv)) {
    result.external_review_verdict = "valid_non_pass";
  } else {
    result.external_review_verdict = "unknown";
  }

  // Rollback conditional — normalize only, no score
  const rr = sidecar.rollback_required;
  if (rr === undefined || rr === null) {
    result.rollback_state = "missing";
  } else if (rr === false) {
    result.rollback_state = "not_applicable";
  } else if (rr === true) {
    const ra = sidecar.rollback_attempted;
    if (ra === undefined || ra === null || ra === false) {
      result.rollback_state = "required_not_attempted";
    } else if (ra === true && sidecar.rollback_succeeded === true) {
      result.rollback_state = "succeeded";
    } else if (ra === true && sidecar.rollback_succeeded === false) {
      result.rollback_state = "failed";
    } else {
      result.rollback_state = "insufficient_evidence";
    }
  } else {
    result.rollback_state = "invalid";
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const sidecarIdx = args.indexOf("--sidecar");
  if (sidecarIdx < 0) {
    console.error("Usage: blocker-normalization.mjs --sidecar <sidecar.json>");
    process.exit(2);
  }
  const sidecar = JSON.parse(readFileSync(args[sidecarIdx + 1], "utf8"));
  const norm = normalize(sidecar);
  const facts = normalizeFacts(sidecar);
  console.log(JSON.stringify({ normalize: norm, normalize_facts: facts }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
