// src/governance/closeout-state.mjs
//
// AUTOLOOP_REPORT_LIFECYCLE_REPAIR_1 — structured review-required lifecycle
// state for mandatory closeout（FM-1 lifecycle trigger）.
//
// The formal review requirement MUST be machine-readable state, never
// conversation wording / a remembered "正式開卡" ritual / a card-specific
// script that happens to be invoked. This module owns:
//
//   - the persisted per-card closeout-state record（atomic writes, secret
//     scanned, fail-closed reads）; it is the authoritative source of
//     `requiresReview`, task identity, authorized scope and output directory
//   - deterministic materialization of the mandatory closeout contract from
//     that state（R2: missing metadata fails closed as
//     CLOSEOUT_METADATA_INCOMPLETE — never a silent skip, never a PASS）
//   - the reverse mapping from a persisted graph-closeout evidence snapshot
//     back to the structured graphResult the closeout gate consumes
//     （authoritative structured metadata only — free-text stdout is never
//     parsed）
//
// The trigger（runStateDrivenCloseout）lives in review-bundle.mjs next to the
// gate it drives; this module stays dependency-free so it can be imported by
// the runner wiring without cycles.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scanForSecrets, sha256Text } from "../evidence/run-evidence-store.mjs";

export const CLOSEOUT_STATE_SCHEMA = "autoloop.closeout-state/v1";

export const CLOSEOUT_HOLDS = Object.freeze({
  STATE_UNREADABLE: "CLOSEOUT_STATE_UNREADABLE",
  METADATA_INCOMPLETE: "CLOSEOUT_METADATA_INCOMPLETE",
  EVIDENCE_UNREADABLE: "CLOSEOUT_EVIDENCE_UNREADABLE",
  GRAPH_RESULT_ABSENT: "CLOSEOUT_GRAPH_RESULT_ABSENT",
});

/**
 * Required closeout-contract fields for a requiresReview card. Dot paths
 * into the state record. A requiresReview card missing any of these cannot
 * materialize a mandatory closeout and MUST fail closed
 * （CLOSEOUT_METADATA_INCOMPLETE）— never silently skipped.
 */
export const CLOSEOUT_REQUIRED_FIELDS = Object.freeze([
  "task.cardId",
  "task.cardTitle",
  "task.cardType",
  "outDir",
]);

/** The canonical closeout-state path for a card output directory. */
export function closeoutStatePath(outDir) {
  return join(resolve(outDir), "closeout-state.json");
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * Atomically persist a closeout-state record. Secret-scanned before write;
 * path-escape checked; written via tmp + rename so a crash never leaves a
 * half-written record.
 */
export function writeCloseoutState({ path, state }) {
  if (!path || !state || typeof state !== "object") {
    return { ok: false, holdCode: CLOSEOUT_HOLDS.STATE_UNREADABLE, reason: "closeout_state_path_or_state_absent" };
  }
  const target = resolve(path);
  const root = dirname(target);
  if (target !== root && !target.startsWith(root + "/")) {
    return { ok: false, holdCode: CLOSEOUT_HOLDS.STATE_UNREADABLE, reason: "closeout_state_path_escape" };
  }
  mkdirSync(root, { recursive: true });
  const text = JSON.stringify(state, null, 2) + "\n";
  const scan = scanForSecrets(text);
  if (!scan.safe) {
    return { ok: false, holdCode: CLOSEOUT_HOLDS.STATE_UNREADABLE, reason: `closeout_state_secret:${scan.matches.join(",")}` };
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return { ok: false, holdCode: CLOSEOUT_HOLDS.STATE_UNREADABLE, reason: `closeout_state_write:${String(e?.message ?? e).slice(0, 200)}` };
  }
  return { ok: true, path: target };
}

/**
 * Read + validate a persisted closeout-state record（fail-closed）.
 */
export function readCloseoutState(path) {
  if (!path || !existsSync(path)) {
    return { ok: false, errors: ["closeout_state_missing"], state: null, path };
  }
  const parsed = readJson(path);
  if (!parsed.ok) {
    return { ok: false, errors: [`closeout_state_unreadable:${parsed.error}`], state: null, path };
  }
  const v = parsed.value;
  if (v?.schema !== CLOSEOUT_STATE_SCHEMA) {
    return { ok: false, errors: [`closeout_state_schema_mismatch:${v?.schema}`], state: null, path };
  }
  if (v.task && (typeof v.task !== "object" || Array.isArray(v.task))) {
    return { ok: false, errors: ["closeout_state_task_malformed"], state: null, path };
  }
  return { ok: true, errors: [], state: v, path };
}

/**
 * R2 — deterministically materialize the mandatory closeout contract from
 * the persisted state. Fail-closed: a requiresReview card missing any
 * CLOSEOUT_REQUIRED_FIELDS entry returns CLOSEOUT_METADATA_INCOMPLETE with
 * the exact missing field list — never a silent skip, never a PASS.
 * Optional fields fall back to safe defaults so a complete-but-sparse card
 * still materializes.
 */
export function materializeCloseoutContract(state) {
  if (!state || typeof state !== "object") {
    return { ok: false, errors: ["state_absent"], contract: null };
  }
  const missing = [];
  for (const field of CLOSEOUT_REQUIRED_FIELDS) {
    const parts = field.split(".");
    let cur = state;
    for (const p of parts) {
      if (cur && typeof cur === "object" && !Array.isArray(cur) && p in cur) cur = cur[p];
      else { cur = undefined; break; }
    }
    if (cur === undefined || cur === null || cur === "") missing.push(field);
  }
  if (missing.length > 0) {
    return { ok: false, errors: [`missing:${missing.join(",")}`], contract: null };
  }
  const contract = {
    requiresReview: state.requiresReview === true,
    cardId: state.task.cardId,
    cardTitle: state.task.cardTitle,
    cardType: state.task.cardType,
    objective: state.objective ?? `Card closeout via state-driven mandatory closeout (${state.task.cardId})`,
    authorizedScope: Array.isArray(state.authorizedScope) ? state.authorizedScope.slice() : [],
    unauthorizedScope: Array.isArray(state.unauthorizedScope) ? state.unauthorizedScope.slice() : [],
    designDecisions: Array.isArray(state.designDecisions) ? state.designDecisions.slice() : [],
    cardFiles: state.cardFiles && typeof state.cardFiles === "object"
      ? {
          cardImplementation: Array.isArray(state.cardFiles.cardImplementation) ? state.cardFiles.cardImplementation.slice() : [],
          closeoutOutputs: Array.isArray(state.cardFiles.closeoutOutputs) ? state.cardFiles.closeoutOutputs.slice() : [],
          preExistingDirty: Array.isArray(state.cardFiles.preExistingDirty) ? state.cardFiles.preExistingDirty.slice() : [],
        }
      : undefined,
    // FM-3 inventory consistency: the machine-captured baseline snapshot
    //（captured at card START, persisted here）is the authoritative
    // pre-existing dirty boundary; the closeout delta is derived against it.
    baseline: state.baseline && typeof state.baseline === "object" && !Array.isArray(state.baseline)
      ? state.baseline
      : null,
    // FM-3 structured authorization exceptions（R2）: [{path, reason}] — never
    // free-text justification alone.
    authorizationExceptions: Array.isArray(state.authorizationExceptions) ? state.authorizationExceptions.slice() : [],
    outDir: state.outDir,
    repairBudgetMaxAttempts: Number.isInteger(state.repairBudgetMaxAttempts) ? state.repairBudgetMaxAttempts : 1,
    supersedes: state.supersedes ?? null,
    negativeCases: Array.isArray(state.negativeCases) ? state.negativeCases.slice() : [],
    regression: Array.isArray(state.regression) ? state.regression.slice() : [],
    regressionSummary: state.regressionSummary ?? null,
    risks: Array.isArray(state.risks) ? state.risks.slice() : [],
    limitations: Array.isArray(state.limitations) ? state.limitations.slice() : [],
    rollbackProcedure: state.rollbackProcedure ?? null,
    openQuestions: Array.isArray(state.openQuestions) ? state.openQuestions.slice() : [],
    recommendedNextStep: state.recommendedNextStep ?? null,
  };
  return { ok: true, errors: [], contract };
}

/**
 * Reverse-map a persisted graph-closeout evidence snapshot（the
 * autoloop.review-bundle.graph-closeout-evidence/v1 file written by
 * writeGraphCloseoutEvidence）back into the structured graphResult shape the
 * closeout gate consumes. This is the SAME authoritative mapping the legacy
 * card-specific closeout scripts hand-rolled — centralized here so no card
 * needs its own reconstruction script. Free-text stdout is never parsed.
 */
export function loadGraphResultFromEvidence(evidencePath) {
  if (!evidencePath || !existsSync(evidencePath)) {
    return { ok: false, errors: ["closeout_evidence_missing"], graphResult: null };
  }
  const parsed = readJson(evidencePath);
  if (!parsed.ok) {
    return { ok: false, errors: [`closeout_evidence_unreadable:${parsed.error}`], graphResult: null };
  }
  const ev = parsed.value;
  if (!ev || typeof ev !== "object") {
    return { ok: false, errors: ["closeout_evidence_not_object"], graphResult: null };
  }
  const graphResult = {
    executionId: ev.graphRunId ?? "graph-unknown",
    final: ev.final ?? "HOLD",
    holdCode: ev.holdCode ?? null,
    reason: ev.reason ?? null,
    scheduler: { ...(ev.scheduler ?? {}) },
    nodeResults: (Array.isArray(ev.nodes) ? ev.nodes : []).map((n) => ({
      nodeId: n.nodeId,
      phaseExecutionId: n.phaseExecutionId ?? null,
      taskType: n.taskType ?? null,
      dependencies: Array.isArray(n.dependencies) ? n.dependencies.slice() : [],
      final: n.final ?? null,
      attempt: n.attempt ?? null,
      reason: n.reason ?? null,
      startedAt: n.startedAt ?? null,
      completedAt: n.completedAt ?? null,
      cleanup: { worktreeRevoked: n.worktreeRevoked === true },
      worktreeIdentity: n.worktreeVerified === true ? { verified: true } : null,
      subagentResult: n.subagentResultStatus
        ? { status: n.subagentResultStatus, testResults: n.subagentTestResults ?? null, testsExecuted: ["regenerated from graph evidence"] }
        : null,
      reviewResult: n.reviewResultStatus
        ? {
            recommendedAction: n.reviewResultStatus,
            blockingFindings: Array.isArray(n.reviewBlockingFindings) ? n.reviewBlockingFindings.slice() : [],
            summary: `independent review agent result (${ev.graphRunId ?? "graph"})`,
          }
        : null,
    })),
    transitions: (Array.isArray(ev.transitions) ? ev.transitions : []).map((t) => ({ ...t })),
  };
  return { ok: true, errors: [], graphResult };
}

export { sha256Text };
