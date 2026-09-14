// src/rollover/reconciliation.mjs
//
// STAGE D — restart/crash reconciliation (CONTRACT §13, FAILURE-MATRIX G4).
// On ANY restart, durable owner truth from CURRENT decides:
//   owner==A@g   → rollover resumable/abortable by A per C-row; unfinished
//                  journal tail reconciled by existing reconcile-first rules.
//   owner==B@(g+1) → A must retire; A resuming execution is fenced; B may
//                  resume through the ladder.
//   ambiguous    → ROLLOVER_RECONCILIATION_REQUIRED, HOLD / CROSS_SESSION_
//                  RECONCILIATION_REQUIRED; no heuristic completion.
// Never decided from process memory, PIDs, or stdout. Also implements the
// C2 crash-window probe: an un-mirrored INTENT row (journal complete beyond
// the snapshot revision) forces CHECKPOINT continuation, not blind resume.

import { readComplete, readIntent } from "../c2d/journal.mjs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVE_PRE_COMMIT_ROLLOVER_STATES,
  POST_COMMIT_ROLLOVER_STATES,
  ROLLOVER_ABORTED_STATES,
  ROLLOVER_HOLD_STATES,
  ROLLOVER_STATES,
} from "./rollover-authority.mjs";

/**
 * @param {object} p
 * @param {object} p.snapshot — checksum-verified CURRENT snapshot
 * @param {string} p.execDir — execution directory (journal access)
 * @returns {{ verdict, ownerBinding|null, rolloverId|null, state, detail }}
 *   verdict ∈ { NO_ROLLOVER, OWNER_A_RESUMABLE, OWNER_B_ACTIVE,
 *               CONTINUE_CHECKPOINT_PUBLICATION, RECONCILIATION_REQUIRED }
 */
export function evaluateRestartReconciliation({ snapshot, execDir }) {
  const rollover = snapshot.graph?.rollover ?? null;

  // C2/C3 window probe runs FIRST: an un-mirrored rollover journal
  // completion forces CHECKPOINT continuation even when CURRENT does not
  // carry the rollover block yet (crash between the journal pair and the
  // mirror publication), never blind resume.
  const unmirrored = findUnmirroredRolloverRow({ snapshot, execDir });
  if (unmirrored) {
    return {
      verdict: "CONTINUE_CHECKPOINT_PUBLICATION",
      ownerBinding: ownerBindingOf(rollover?.owner ?? null),
      rolloverId: unmirrored.rolloverId,
      state: rollover?.state ?? null,
      detail: `journal revision ${unmirrored.revision} (${unmirrored.sideEffectClass}) not mirrored into CURRENT@${snapshot.revision}`,
      unmirrored,
    };
  }

  if (!rollover || typeof rollover !== "object") {
    return { verdict: "NO_ROLLOVER", ownerBinding: null, rolloverId: null, state: null, detail: "no graph.rollover block" };
  }
  const state = rollover.state;
  const rolloverId = rollover.active_rollover_id ?? rollover.last_rollover_id ?? null;
  const owner = rollover.owner ?? null;

  if (ACTIVE_PRE_COMMIT_ROLLOVER_STATES.has(state)) {
    // Owner is durably A: A may abort or continue the bounded rollover (C4-C12).
    return { verdict: "OWNER_A_RESUMABLE", ownerBinding: ownerBindingOf(owner), rolloverId, state, detail: "pre-commit rollover in flight; A may resume/abort per its row" };
  }
  if (POST_COMMIT_ROLLOVER_STATES.has(state)) {
    return { verdict: "OWNER_B_ACTIVE", ownerBinding: ownerBindingOf(owner), rolloverId, state, detail: "transfer committed; A fenced, B resumes via ladder" };
  }
  if (ROLLOVER_ABORTED_STATES.has(state)) {
    return { verdict: "OWNER_A_RESUMABLE", ownerBinding: ownerBindingOf(owner), rolloverId, state, detail: "rollover aborted pre-transfer; A continues" };
  }
  if (state === ROLLOVER_STATES.A_RETIRED || state === ROLLOVER_STATES.A_RETIREMENT_CONFIRMED) {
    return { verdict: "OWNER_B_ACTIVE", ownerBinding: ownerBindingOf(owner), rolloverId, state, detail: "rollover closed" };
  }
  if (ROLLOVER_HOLD_STATES.has(state)) {
    return { verdict: "RECONCILIATION_REQUIRED", ownerBinding: ownerBindingOf(owner), rolloverId, state, detail: `blocking state ${state}` };
  }
  if (state === ROLLOVER_STATES.ACTIVE_A) {
    return { verdict: "NO_ROLLOVER", ownerBinding: ownerBindingOf(owner), rolloverId: null, state, detail: "machine idle" };
  }
  return { verdict: "RECONCILIATION_REQUIRED", ownerBinding: ownerBindingOf(owner), rolloverId, state, detail: `unknown durable state ${String(state)}` };
}

function ownerBindingOf(owner) {
  if (!owner) return null;
  return { sessionIdentityDigest: owner.session_identity_digest ?? null, sessionGeneration: owner.session_generation ?? null };
}

/**
 * Scan C2D journal rows for rollover-class completions whose facts CURRENT
 * does not yet carry (crash between journal pair and mirror publication).
 * Only ROLLOVER_* classes count; sibling evidence-journal rows in the shared
 * directory are ignored (they are a different namespace).
 *
 * Every sanctioned rollover publication writes ONE journal pair whose rows
 * pin `expected_revision_before` = the CURRENT revision its mirror CAS
 * targets, then mirrors at that revision + 1. A completed row is therefore
 * UNMIRRORED exactly when `snapshot.revision <= expected_revision_before`.
 * Rows are ordered by that pin, so the first mirrored row proves every
 * earlier row mirrored too — the scan walks newest-first and stops there.
 */
function rolloverJournalTail(execDir) {
  let names = [];
  try { names = readdirSync(join(execDir, "journal")); } catch { return 0; }
  const rows = new Map();
  for (const n of names) {
    const m = n.match(/^(\d{12})\.(intent|complete)\.json$/);
    if (!m) continue; // evidence-journal rows live in a different namespace
    const rev = parseInt(m[1], 10);
    if (!rows.has(rev)) rows.set(rev, {});
    rows.get(rev)[m[2]] = true;
  }
  const keys = [...rows.keys()].sort((a, b) => a - b);
  if (keys.length === 0) return 0;
  if (keys[0] !== 1) throw new Error(`first C2D revision must be 1, got ${keys[0]}`);
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] !== keys[i - 1] + 1) throw new Error(`C2D journal gap at ${keys[i]}`);
  }
  if (!rows.get(keys[keys.length - 1]).complete) throw new Error("incomplete C2D journal tail");
  return keys[keys.length - 1];
}

export function findUnmirroredRolloverRow({ snapshot, execDir }) {
  let tail;
  try {
    tail = rolloverJournalTail(execDir);
  } catch {
    return null; // continuity errors surface elsewhere (fail-closed reads)
  }
  const revision = snapshot.revision ?? 0;
  for (let r = tail; r >= 1; r--) {
    try {
      const rec = readComplete(execDir, r);
      if (!rec || typeof rec.side_effect_class !== "string" || !rec.side_effect_class.startsWith("rollover_")) continue;
      const erb = Number(rec.expected_revision_before);
      if (!Number.isFinite(erb)) continue;
      if (revision > erb) break; // this row's mirror landed ⇒ all earlier rows mirrored
      let rolloverId = rec.rollover_id ?? null;
      if (!rolloverId) {
        try { rolloverId = readIntent(execDir, r)?.rollover_id ?? null; } catch { /* keep null */ }
      }
      return { revision: r, sideEffectClass: rec.side_effect_class, rolloverId };
    } catch { /* unreadable row → treated as absent here */ }
  }
  return null;
}
