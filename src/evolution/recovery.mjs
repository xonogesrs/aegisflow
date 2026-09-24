// src/evolution/recovery.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1 — Section I:
// crash/restart recovery reconciliation for the evolution store.
//
// After an AutoLoop restart/crash mid-cycle the durable artifacts are the
// ONLY truth (same convention as the C2D checkpoint reconciliation). This
// module rebuilds a consistent evolution state from those artifacts and
// proves the card §I invariants:
//
//   - evolution state is RECOVERABLE: every stage writes its durable
//     artifact BEFORE the next stage runs (policy → trigger state →
//     candidate → review → canary → outcome), so the post-crash state is
//     exactly the last completed stage.
//   - NO duplicate candidate: derivation is identity-deduped at
//     (signature, baseline) via the durable derivation index + the
//     exclusive-create candidate artifact — a re-run after a crash
//     re-derives the SAME candidate or returns EXISTING (candidate.mjs).
//   - NO duplicate promotion: the promotion gate requires the durable
//     review artifact + live HEAD == frozen baseline, and the branch
//     advance is a compare-and-swap fast-forward from the baseline
//     (promotion.mjs update-ref with expected old value) — a replayed
//     promotion either sees CANDIDATE_EXISTS upstream or fails the
//     HEAD_MISMATCH gate closed.
//   - INCOMPLETE mutations CANNOT pollute production: mutations run in an
//     isolated C3B worktree that is removed on failure; the production
//     checkout is only ever READ. A crashed mutation leaves at most an
//     orphaned worktree + exec dir — never a production change.
//   - canary/rollback authority RECOVERS: the canary record is durable and
//     self-describing (branch, commit_oid, baseline_head); this module
//     re-verifies the branch ref against the record and completes an
//     interrupted rollback (rolled_back=true in the record but the ref not
//     yet restored).
//   - circuit-breaker state is NOT LOST: it lives in the durable trigger
//     state file (readTriggerState), written atomically (tmp+rename).
//
// Reconciliation is READ-ONLY over production refs except for the ONE
// repair case: completing an interrupted canary rollback (ref-only, to the
// recorded pre-promotion baseline — the exact rollbackCandidate semantics).

import { spawnSync } from "node:child_process";
import { digestOf } from "../canonical-digest.mjs";
import { readCanary, rollbackCandidate } from "./canary.mjs";
import { readTriggerState } from "./trigger.mjs";
import { listCandidates } from "./candidate.mjs";

export const EVOLUTION_RECOVERY_SCHEMA = "autoloop.evolution-recovery/v1";

function gitRevParse(repoRoot, ref) {
  const r = spawnSync("git", ["rev-parse", "--verify", ref], { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Reconcile the evolution state after a restart.
 *
 * @param {object} p
 * @param {string} p.repoRoot — production repository (read-only except the
 *        interrupted-rollback repair, which is ref-only)
 * @param {string} p.storeRoot — evolution store root
 * @returns recovery report: { schema, store_root, circuit_breaker, candidates,
 *          pending_rollback_repair, recovered, at, recovery_digest }
 */
export function reconcileEvolutionState({ repoRoot, storeRoot }) {
  const at = new Date().toISOString();
  const report = {
    schema: EVOLUTION_RECOVERY_SCHEMA,
    version: 1,
    store_root: storeRoot,
    circuit_breaker: null,
    candidates: [],
    pending_rollback_repair: [],
    recovered: [],
    at,
  };

  // Circuit breaker state (durable trigger state — never lost across restart).
  const ts = readTriggerState(storeRoot);
  report.circuit_breaker = ts.circuitBreaker
    ? { tripped: true, at: ts.circuitBreaker.at, reason: ts.circuitBreaker.reason }
    : { tripped: false, at: null, reason: null };

  // Per-candidate canary reconciliation: complete interrupted rollbacks.
  for (const c of listCandidates(storeRoot)) {
    const canary = readCanary(storeRoot, c.candidate_id);
    const entry = {
      candidate_id: c.candidate_id,
      status: c.status,
      canary: canary ? { verdict: canary.verdict, rolled_back: canary.rolled_back === true } : null,
      branch_oid: null,
      repair: null,
    };
    if (canary && !canary.rolled_back && canary.verdict === "REGRESSED") {
      // Rollback decision recorded but interrupted before/while the ref was
      // restored: complete it (ref-only, to the recorded baseline).
      const rb = rollbackCandidate({ repoRoot, storeRoot, candidate: c });
      entry.repair = { kind: "complete_rollback", restored_to: rb.restored_to, from: rb.from };
      report.recovered.push(`rollback_completed:${c.candidate_id}`);
    } else if (canary && canary.rolled_back) {
      // Rollback claims completed — VERIFY the ref actually sits at baseline.
      const cur = gitRevParse(repoRoot, `refs/heads/${canary.branch}`);
      entry.branch_oid = cur;
      if (cur && cur !== canary.baseline_head) {
        const rb = rollbackCandidate({ repoRoot, storeRoot, candidate: c });
        entry.repair = { kind: "rollback_ref_mismatch_repaired", restored_to: rb.restored_to, from: cur };
        report.recovered.push(`rollback_ref_repaired:${c.candidate_id}`);
      }
    } else if (canary && canary.verdict === "HEALTHY" && canary.closes_at && Date.parse(canary.closes_at) > Date.now()) {
      // Window still open after restart: the window state is durable and
      // time-based — evaluation resumes from the record, nothing to repair.
      entry.repair = { kind: "canary_window_resumes", closes_at: canary.closes_at };
    }
    report.candidates.push(entry);
  }

  report.recovery_digest = digestOf({ ...report, recovery_digest: undefined });
  return report;
}
