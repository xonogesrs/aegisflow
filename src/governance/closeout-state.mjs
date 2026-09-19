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

// ── R-12 closeout acceptance — single canonical graph-evidence validator ───
//
// The state-driven closeout may derive authoritative PASS only from
// STRUCTURALLY VALID, IDENTITY-BOUND, COMPLETE graph evidence for the exact
// closeout lineage. A caller may provide evidence; a caller may NOT provide
// authority. ONE validation path serves both the in-memory graphResult
// entering runStateDrivenCloseout and the disk graph-closeout-evidence/v1
// loader — no weaker CLI path, no divergent second validator.
//
// Fail-closed distinction (GATE 9 NON-PASS SEMANTICS):
//   INVALID EVIDENCE  — schema/identity/structure violation → deterministic
//                       rejection (R12_* hold codes); never normalized into
//                       a plausible-looking result.
//   VALID NON-PASS    — structurally valid evidence whose authoritative
//                       outcome is HOLD/FAILED → normal closeout non-PASS
//                       semantics (source.executiveStatus = the real final;
//                       the gate returns CARD_OUTCOME:HOLD), never an
//                       exception that breaks legitimate HOLD flows.
export const GRAPH_EVIDENCE_SCHEMA = "autoloop.review-bundle.graph-closeout-evidence/v1";

// The terminal node-final vocabulary the canonical runner actually produces
// (colima-graph-runner statusToFinal). No arbitrary aliases are accepted —
// GATE 6 NODE NORMALIZATION supports only shapes produced by canonical code.
export const GRAPH_NODE_FINALS = Object.freeze([
  "PASS", "HOLD", "FAILED", "SKIPPED_DUE_TO_DEPENDENCY", "NOT_RECORDED",
]);

// The aggregate-final vocabulary the canonical runner produces.
export const GRAPH_AGGREGATE_FINALS = Object.freeze(["PASS", "HOLD", "FAILED"]);

// R-12 deterministic hold codes (frozen canonical spellings).
export const GRAPH_EVIDENCE_HOLDS = Object.freeze({
  INVALID: "R12_EVIDENCE_INVALID",
  SCHEMA_MISMATCH: "R12_EVIDENCE_SCHEMA_MISMATCH",
  CARD_MISMATCH: "R12_EVIDENCE_CARD_MISMATCH",
  RUN_MISMATCH: "R12_EVIDENCE_RUN_MISMATCH",
  AGGREGATE_CHILD_CONTRADICTION: "R12_AGGREGATE_CHILD_CONTRADICTION",
});

// ── RB2R1 — closeout stage machine（descriptive vs authoritative）──────────
//
// A persisted closeout record is DESCRIPTIVE CACHED STATE ONLY. No
// caller-controlled persisted field（`stage` / `externalReviewStatus` /
// `final`）may mint REVIEW_ACCEPTED / CLOSEOUT_ELIGIBLE / CLOSED authority.
// Those stages are earned only through VERIFIED underlying facts:
//   IMPLEMENTATION_COMPLETE  — graph work done; no valid canonical bundle
//   REVIEW_BUNDLE_READY      — valid current canonical bundle exists
//   INDEPENDENT_REVIEW_PENDING — bundle valid; no accepted authoritative
//                              review record
//   REVIEW_HOLD              — authoritative bound review verdict = HOLD/REPAIR
//   REVIEW_ACCEPTED          — valid bundle + valid authoritative independent
//                              PASS binding
//   CLOSEOUT_ELIGIBLE        — REVIEW_ACCEPTED + current implementation still
//                              matches the reviewed bytes
//   CLOSED                   — only after an actual authoritative
//                              closeout/commit/seal operation is recorded
//
// The AUTHORITATIVE derivation（which needs I/O: bundle validation + the
// external-review authority record + live repo binding）lives in
// review-bundle.mjs（deriveAuthoritativeCloseoutStage）. This module's
// deriveCloseoutStage is PURE and therefore can only ever return the
// DESCRIPTIVE lower half of the machine — it MUST NOT return
// REVIEW_ACCEPTED / CLOSEOUT_ELIGIBLE / CLOSED.
export const CLOSEOUT_STAGES = Object.freeze([
  "IMPLEMENTATION_COMPLETE",
  "REVIEW_BUNDLE_READY",
  "INDEPENDENT_REVIEW_PENDING",
  "REVIEW_HOLD",
  "REVIEW_ACCEPTED",
  "CLOSEOUT_ELIGIBLE",
  "CLOSED",
]);

function hasRecordedBundleIdentity(closeout) {
  return closeout
    && typeof closeout.bundleIdentity === "string"
    && /^[0-9a-f]{64}$/.test(closeout.bundleIdentity);
}

/**
 * Derive the DESCRIPTIVE（provisional）closeout stage from a persisted
 * closeout disposition. PURE（no I/O）: it does NOT prove bundle existence,
 * does NOT verify a bound review verdict, and does NOT bind the live repo —
 * those are the caller's job（see review-bundle.mjs verifyAppliedCloseoutBundle
 * / assertFinalCardCloseout / deriveAuthoritativeCloseoutStage）.
 *
 * Hard rules（RB2R1）:
 *   - a persisted `stage:"CLOSED"` / `CLOSEOUT_ELIGIBLE` / `REVIEW_ACCEPTED`
 *     is NEVER echoed back as authority; it is demoted to the strongest
 *     DESCRIPTIVE stage the record's own evidence supports（or null）.
 *   - a persisted `externalReviewStatus:"PASS"` alone is a CLAIM, not
 *     authority — it maps to INDEPENDENT_REVIEW_PENDING（an accepted
 *     authoritative record has not been verified）. Contradictory persisted
 *     state is reconciled DOWNWARD, never upward.
 */
export function deriveCloseoutStage(closeout) {
  if (!closeout || typeof closeout !== "object" || Array.isArray(closeout)) return null;
  const status = closeout.externalReviewStatus;
  if (status === "REPAIR" || status === "HOLD") return "REVIEW_HOLD";
  if (status === "PASS") {
    // A persisted PASS is evidence of a claim only. Authority for
    // REVIEW_ACCEPTED requires a verified bound review record.
    return "INDEPENDENT_REVIEW_PENDING";
  }
  if (status === "AWAITING_EXTERNAL_REVIEW" || status === "AWAITING_BUNDLE_DELIVERY") {
    return hasRecordedBundleIdentity(closeout) ? "REVIEW_BUNDLE_READY" : "IMPLEMENTATION_COMPLETE";
  }
  // No external-review status recorded → the cached `stage` is descriptive
  // only. CLOSED / CLOSEOUT_ELIGIBLE / REVIEW_ACCEPTED are NEVER trusted from
  // a persisted field（authority requires verified facts）.
  if (closeout.stage && CLOSEOUT_STAGES.includes(closeout.stage)
      && closeout.stage !== "REVIEW_ACCEPTED"
      && closeout.stage !== "CLOSEOUT_ELIGIBLE"
      && closeout.stage !== "CLOSED") {
    return closeout.stage;
  }
  // A recorded bundle identity = bundle ready（independent review outstanding）.
  if (hasRecordedBundleIdentity(closeout)) return "REVIEW_BUNDLE_READY";
  // A PASS disposition WITHOUT a durable bundle identity is NOT a valid
  // bundle-ready stage — demote it to IMPLEMENTATION_COMPLETE（the
  // enforcement layer must then HOLD）.
  if (closeout.final === "PASS") return "IMPLEMENTATION_COMPLETE";
  return null;
}

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
    // R-04 removal: the legacy in-memory contract carried an optional
    // diffSummary override（bundle §10 Diff Summary）; the persisted
    // state record carries the same optional field — absent state falls
    // back to the source builder's derived summary (NOT_APPLICABLE-safe).
    diffSummary: typeof state.diffSummary === "string" && state.diffSummary.length > 0 ? state.diffSummary : undefined,
    negativeCases: Array.isArray(state.negativeCases) ? state.negativeCases.slice() : [],
    regression: Array.isArray(state.regression) ? state.regression.slice() : [],
    regressionSummary: state.regressionSummary ?? null,
    risks: Array.isArray(state.risks) ? state.risks.slice() : [],
    limitations: Array.isArray(state.limitations) ? state.limitations.slice() : [],
    // AUTOLOOP-P4: the declared task success contract（verification plan
    // frozen at card admission/closeout-state write time）is carried through
    // into the closeout gate's PASS ORACLE. Optional: cards without one are
    // still held to the implicit review-bundle-valid + independent-review
    // checks.
    successContract: state.successContract && typeof state.successContract === "object" && !Array.isArray(state.successContract)
      ? state.successContract
      : undefined,
    rollbackProcedure: state.rollbackProcedure ?? null,
    openQuestions: Array.isArray(state.openQuestions) ? state.openQuestions.slice() : [],
    recommendedNextStep: state.recommendedNextStep ?? null,
  };
  return { ok: true, errors: [], contract };
}

// ── R-12 — SINGLE CANONICAL GRAPH EVIDENCE VALIDATOR ───────────────────────
//
// ONE validation path for BOTH the in-memory graphResult entering
// runStateDrivenCloseout and the disk graph-closeout-evidence/v1 loader
// (GATE A SHARED_GRAPH_VALIDATOR / GATE P DISK_MEMORY_PARITY). Accepts a
// graph-evidence structure (runner-shaped or evidence-shaped), validates it
// structurally + identity-wise, and returns either a VALIDATED, NORMALIZED
// graphResult or a deterministic fail-closed error — never a partially
// defaulted shape that could look authoritative.
//
// Non-goals: this is NOT a new authority subsystem — it is the pre-oracle
// seam fence. The PASS oracle, bundle validation and delivery authority are
// untouched.
//
// opts:
//   expectedCardId    — bind evidence.task.cardId === expectedCardId
//                       (GATE D CARD_IDENTITY_BINDING; required for
//                       authoritative use — closeout lineage binding).
//   expectedGraphRunId — when the closeout lineage records an expected run
//                       identity, bind equality (GATE E GRAPH_RUN_BINDING;
//                       replay from a mismatched recorded run fails closed).
//   requireSchema     — enforce the exact graph-closeout-evidence/v1 schema
//                       marker on disk evidence (GATE B SCHEMA ENFORCEMENT).
//
// Failure mode: { ok:false, holdCode, errors:[...] } — deterministic,
// machine-checkable, never silent-defaulted.
export function validateGraphEvidence(input, opts = {}) {
  const errors = [];
  const fail = (holdCode, errs) => ({ ok: false, holdCode, errors: errs, graphResult: null });

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail(GRAPH_EVIDENCE_HOLDS.INVALID, ["R12_EVIDENCE_INVALID:not_an_object"]);
  }

  // ── GATE B — schema enforcement (disk evidence; exact schema marker) ──
  if (opts.requireSchema === true) {
    if (input.schema !== GRAPH_EVIDENCE_SCHEMA) {
      return fail(GRAPH_EVIDENCE_HOLDS.SCHEMA_MISMATCH, [
        `R12_EVIDENCE_SCHEMA_MISMATCH:${input.schema == null ? "absent" : String(input.schema)}`,
      ]);
    }
  }

  // ── GATE C — required identity fields (no silent synthesis) ──────────
  // executionId/graphRunId: a real run identity is MANDATORY. The historical
  // `graph-unknown` default synthesized an identity for authoritative
  // evidence — removed (fail closed instead).
  const executionId = input.executionId ?? input.graphRunId ?? null;
  if (typeof executionId !== "string" || executionId.length === 0 || executionId === "graph-unknown") {
    errors.push("R12_EVIDENCE_INVALID:graphRunId_missing_or_reserved_placeholder");
  }
  // Aggregate final: MANDATORY. The historical `?? "HOLD"` default let
  // malformed evidence continue as though it were valid — removed.
  const final = input.final ?? null;
  if (typeof final !== "string" || !GRAPH_AGGREGATE_FINALS.includes(final)) {
    errors.push(`R12_EVIDENCE_INVALID:aggregate_final_missing_or_unknown${final == null ? "" : `:${final}`}`);
  }
  if (errors.length > 0) return fail(GRAPH_EVIDENCE_HOLDS.INVALID, errors);

  // ── GATE C/D — required identity fields + card binding ───────────────
  // requireTaskIdentity (disk evidence): task.cardId is a MANDATORY identity
  // field of the persisted snapshot — absent/malformed fails closed.
  // In-memory runner shape: card identity lives in the closeout contract, so
  // task.cardId is optional HERE but, when present, must MATCH
  // expectedCardId (a forged claim cannot contradict the lineage).
  const cardId = input.task && typeof input.task === "object" ? input.task.cardId ?? null : null;
  if (opts.requireTaskIdentity === true) {
    if (typeof cardId !== "string" || cardId.length === 0) {
      return fail(GRAPH_EVIDENCE_HOLDS.INVALID, ["R12_EVIDENCE_INVALID:task_cardId_missing"]);
    }
  }
  if (opts.expectedCardId != null && cardId != null) {
    if (cardId !== opts.expectedCardId) {
      return fail(GRAPH_EVIDENCE_HOLDS.CARD_MISMATCH, [
        `R12_EVIDENCE_CARD_MISMATCH:${cardId}!=${opts.expectedCardId}`,
      ]);
    }
  }

  // ── GATE E — graph run binding ────────────────────────────────────────
  if (opts.expectedGraphRunId != null && executionId !== opts.expectedGraphRunId) {
    return fail(GRAPH_EVIDENCE_HOLDS.RUN_MISMATCH, [
      `R12_EVIDENCE_RUN_MISMATCH:${executionId}!=${opts.expectedGraphRunId}`,
    ]);
  }

  // ── GATE F — node normalization (runner/evidence shapes → one form) ───
  // Accept ONLY the two shapes canonical AutoLoop code produces:
  //   runner-shaped   graphResult.nodeResults[] (in-memory path)
  //   evidence-shaped evidence.nodes[] (persisted v1 snapshot)
  // Arbitrary aliases (nodeResults on disk-only evidence, nodes on runner
  // input) are NOT broadened acceptance — see normalizeGraphNodes.
  const rawNodes = normalizeGraphNodes(input);
  if (rawNodes == null) {
    return fail(GRAPH_EVIDENCE_HOLDS.INVALID, [
      "R12_EVIDENCE_INVALID:node_collection_missing_or_malformed",
    ]);
  }
  if (rawNodes.length === 0) {
    return fail(GRAPH_EVIDENCE_HOLDS.INVALID, ["R12_EVIDENCE_INVALID:node_collection_empty"]);
  }
  const seen = new Map();
  for (const n of rawNodes) {
    if (!n || typeof n !== "object" || Array.isArray(n)) {
      return fail(GRAPH_EVIDENCE_HOLDS.INVALID, ["R12_EVIDENCE_INVALID:node_not_object"]);
    }
    if (typeof n.nodeId !== "string" || n.nodeId.length === 0) {
      return fail(GRAPH_EVIDENCE_HOLDS.INVALID, ["R12_EVIDENCE_INVALID:node_nodeId_missing"]);
    }
    if (typeof n.final !== "string" || !GRAPH_NODE_FINALS.includes(n.final)) {
      return fail(GRAPH_EVIDENCE_HOLDS.INVALID, [
        `R12_EVIDENCE_INVALID:node_final_unknown:${n.nodeId}:${n.final == null ? "null" : String(n.final)}`,
      ]);
    }
    // A node carrying a runner execution identity must belong to THIS run —
    // cross-run node replay inside one evidence file is a contradiction.
    if (typeof n.graphExecutionId === "string" && n.graphExecutionId.length > 0 && n.graphExecutionId !== executionId) {
      return fail(GRAPH_EVIDENCE_HOLDS.RUN_MISMATCH, [
        `R12_EVIDENCE_RUN_MISMATCH:node:${n.nodeId}:${n.graphExecutionId}!=${executionId}`,
      ]);
    }
    const prev = seen.get(n.nodeId);
    if (prev && (prev.final !== n.final)) {
      return fail(GRAPH_EVIDENCE_HOLDS.INVALID, [
        `R12_EVIDENCE_INVALID:duplicate_conflicting_node:${n.nodeId}:${prev.final}vs${n.final}`,
      ]);
    }
    seen.set(n.nodeId, n);
  }

  // scheduler must be an object when present (canonical runner always sends
  // one; evidence snapshots persist it).
  if (input.scheduler != null && (typeof input.scheduler !== "object" || Array.isArray(input.scheduler))) {
    return fail(GRAPH_EVIDENCE_HOLDS.INVALID, ["R12_EVIDENCE_INVALID:scheduler_malformed"]);
  }
  if (input.transitions != null && !Array.isArray(input.transitions)) {
    return fail(GRAPH_EVIDENCE_HOLDS.INVALID, ["R12_EVIDENCE_INVALID:transitions_malformed"]);
  }

  // ── GATE G — admission preservation (AUTOLOOP_R12_ADMISSION_SECTION_REGRESSION_REPAIR_1) ──
  // The runner-shaped graphResult carries the FROZEN admission that governed
  // the run (colima-graph-runner: `admission: admission ?? null`, validated
  // fail-closed at the runner entry before any execution). §1.5 Admission
  // Decision rendering consumes it downstream (buildGraphCloseoutSource).
  // The original R-12 normalization dropped the field, silently stripping
  // the admission section from every validated bundle — a rendering-contract
  // regression, not an authority change. Preservation rules:
  //   - absent / null  -> normalized result carries admission: null
  //     (unadmitted graph, canonical runner shape — NOT a fabrication);
  //   - present        -> must be a non-array object with a non-empty string
  //     admission_id, else deterministic fail-closed R12 rejection (a
  //     malformed admission can never enter the bundle; no partial repair,
  //     no synthesis). The record is carried VERBATIM — the runner already
  //     validated it against validateAdmission at dispatch; this gate only
  //     refuses malformed shapes, it does not re-derive or amend authority.
  const rawAdmission = input.admission ?? null;
  if (rawAdmission != null && (typeof rawAdmission !== "object" || Array.isArray(rawAdmission))) {
    return fail(GRAPH_EVIDENCE_HOLDS.INVALID, ["R12_EVIDENCE_INVALID:admission_malformed"]);
  }
  if (rawAdmission != null && (typeof rawAdmission.admission_id !== "string" || rawAdmission.admission_id.length === 0)) {
    return fail(GRAPH_EVIDENCE_HOLDS.INVALID, ["R12_EVIDENCE_INVALID:admission_id_missing"]);
  }

  // ── VALIDATED — normalize into the runner graphResult shape ───────────
  const graphResult = {
    executionId,
    final,
    holdCode: input.holdCode ?? null,
    reason: input.reason ?? null,
    scheduler: { ...(input.scheduler ?? {}) },
    nodeResults: rawNodes.map((n) => normalizeNodeResult(n, executionId)),
    transitions: (Array.isArray(input.transitions) ? input.transitions : []).map((t) => ({ ...t })),
    admission: rawAdmission ?? null,
  };
  return { ok: true, errors: [], graphResult };
}

/**
 * GATE F — node-collection normalization. Accepts exactly the shapes
 * canonical AutoLoop code produces:
 *   - graphResult-shaped input: `nodeResults[]` (colima-graph-runner,
 *     subagent runner, durable graph — in-memory authority path)
 *   - evidence-shaped input: `nodes[]` (the persisted
 *     autoloop.review-bundle.graph-closeout-evidence/v1 snapshot)
 * Anything else (both present and conflicting, neither present) fails
 * closed — no alias broadening.
 */
function normalizeGraphNodes(input) {
  const nodeResults = Array.isArray(input.nodeResults) ? input.nodeResults : null;
  const nodes = Array.isArray(input.nodes) ? input.nodes : null;
  if (nodeResults && nodes) {
    // Both shapes present: tolerate only when they are the same collection
    // length (a runner result that also embedded an evidence view). Any
    // ambiguity fails closed.
    return nodeResults.length === nodes.length ? nodeResults : null;
  }
  return nodeResults ?? nodes;
}

/** Normalize one validated node into the canonical runner node-result shape. */
function normalizeNodeResult(n, executionId) {
  return {
    graphExecutionId: typeof n.graphExecutionId === "string" ? n.graphExecutionId : executionId,
    nodeId: n.nodeId,
    phaseExecutionId: n.phaseExecutionId ?? null,
    taskType: n.taskType ?? null,
    dependencies: Array.isArray(n.dependencies) ? n.dependencies.slice() : [],
    final: n.final,
    attempt: n.attempt ?? null,
    reason: n.reason ?? null,
    startedAt: n.startedAt ?? null,
    completedAt: n.completedAt ?? null,
    skipped: n.skipped === true,
    cleanup: { worktreeRevoked: n.cleanup?.worktreeRevoked === true || n.worktreeRevoked === true },
    worktreeIdentity: n.worktreeIdentity && typeof n.worktreeIdentity === "object"
      ? n.worktreeIdentity
      : (n.worktreeVerified === true ? { verified: true } : null),
    subagentResult: n.subagentResult && typeof n.subagentResult === "object"
      ? n.subagentResult
      : (n.subagentResultStatus
        ? { status: n.subagentResultStatus, testResults: n.subagentTestResults ?? null, testsExecuted: ["regenerated from graph evidence"] }
        : null),
    reviewResult: n.reviewResult && typeof n.reviewResult === "object"
      ? n.reviewResult
      : (n.reviewResultStatus
        ? {
            recommendedAction: n.reviewResultStatus,
            blockingFindings: Array.isArray(n.reviewBlockingFindings) ? n.reviewBlockingFindings.slice() : [],
            summary: `independent review agent result (${executionId})`,
          }
        : null),
  };
}

/**
 * GATE G — GRAPH COMPLETENESS + GATE H — AGGREGATE/CHILD CONSISTENCY.
 *
 * For an aggregate PASS the validated graph must be COMPLETE and
 * CONTRADICTION-FREE against every required node:
 *   - at least one required node (already enforced: non-empty collection);
 *   - every required node represented (scheduler.order, when the canonical
 *     runner exposes it, is the required-node set — completeness is never
 *     inferred from nodes.length > 0 when stronger information exists);
 *   - every required node final = PASS;
 *   - no required node skipped (SKIPPED_DUE_TO_DEPENDENCY / NOT_RECORDED /
 *     scheduler.skipped / node.skipped);
 *   - no writer violation on a required node (scheduler.writerViolations);
 *   - no unresolved blocking condition (per-node review blockingFindings and
 *     reviewer_verdict transition verdicts);
 *   - aggregate PASS ⇒ every required child PASS (any FAIL/HOLD/missing/
 *     unknown/contradictory duplicate prevents PASS —
 *     R12_AGGREGATE_CHILD_CONTRADICTION).
 *
 * Returns { ok:true } or { ok:false, holdCode, errors } — deterministic.
 * Non-PASS aggregates are NOT validated here (GATE 9: valid evidence with a
 * non-PASS outcome keeps normal closeout semantics).
 */
export function assertGraphAggregateConsistency(graphResult) {
  const errors = [];
  const nodes = Array.isArray(graphResult?.nodeResults) ? graphResult.nodeResults : [];
  const scheduler = graphResult?.scheduler && typeof graphResult.scheduler === "object" ? graphResult.scheduler : {};
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));

  // Required-node set: scheduler.order when present (the runner's actual
  // started-phase sequence), else the node collection itself. scheduler.order
  // entries missing from nodeResults are REQUIRED-BUT-MISSING children.
  const order = Array.isArray(scheduler.order) ? scheduler.order : null;
  const requiredIds = order && order.length > 0 ? order : nodes.map((n) => n.nodeId);
  if (requiredIds.length === 0) {
    return { ok: false, holdCode: GRAPH_EVIDENCE_HOLDS.AGGREGATE_CHILD_CONTRADICTION, errors: ["R12_AGGREGATE_CHILD_CONTRADICTION:no_required_nodes"] };
  }

  const nonPass = [];
  for (const id of requiredIds) {
    const n = byId.get(id);
    if (!n) {
      nonPass.push(`${id}:MISSING`);
      continue;
    }
    if (n.final !== "PASS") nonPass.push(`${id}:${n.final}`);
  }
  // Any node present but NOT in the required set with a non-PASS final is
  // still an unresolved child — it cannot be silently ignored.
  for (const n of nodes) {
    if (!requiredIds.includes(n.nodeId) && n.final !== "PASS") nonPass.push(`${n.nodeId}:${n.final}:unrequired`);
  }

  // No required node skipped.
  for (const n of nodes) {
    if (n.final === "SKIPPED_DUE_TO_DEPENDENCY" || n.final === "NOT_RECORDED" || n.skipped === true) {
      nonPass.push(`${n.nodeId}:${n.final ?? "SKIPPED"}`);
    }
  }
  const skippedList = Array.isArray(scheduler.skipped) ? scheduler.skipped : [];
  for (const id of skippedList) {
    if (requiredIds.includes(id)) nonPass.push(`${id}:SKIPPED`);
  }

  // No writer violation on a required node.
  const writerViolations = Array.isArray(scheduler.writerViolations) ? scheduler.writerViolations : [];
  if (writerViolations.length > 0) {
    for (const v of writerViolations) {
      const id = typeof v === "string" ? v.split(":")[0] : null;
      if (id == null || requiredIds.includes(id)) {
        errors.push(`R12_AGGREGATE_CHILD_CONTRADICTION:writer_violation:${String(v).slice(0, 80)}`);
      }
    }
  }

  // Scheduler truth must agree with an aggregate PASS: a HOLD scheduler
  // verdict or any non-passed status over a required node contradicts the
  // claimed aggregate（a caller cannot declare PASS above a scheduler HOLD）.
  if (scheduler.verdict != null && scheduler.verdict !== "PASS") {
    errors.push(`R12_AGGREGATE_CHILD_CONTRADICTION:scheduler_verdict:${scheduler.verdict}`);
  }
  const statuses = scheduler.statuses && typeof scheduler.statuses === "object" && !Array.isArray(scheduler.statuses)
    ? scheduler.statuses
    : {};
  for (const id of requiredIds) {
    const s = statuses[id];
    if (s != null && s !== "passed") {
      errors.push(`R12_AGGREGATE_CHILD_CONTRADICTION:scheduler_status:${id}:${s}`);
    }
  }

  // No unresolved blocking condition on a required node: per-node review
  // blockingFindings and reviewer_verdict transition verdicts.
  for (const n of nodes) {
    const blocking = n.reviewResult?.blockingFindings;
    if (Array.isArray(blocking) && blocking.length > 0) {
      nonPass.push(`${n.nodeId}:BLOCKING_FINDINGS`);
    }
  }
  const transitions = Array.isArray(graphResult?.transitions) ? graphResult.transitions : [];
  for (const tx of transitions) {
    if (!requiredIds.includes(tx.phaseId)) continue;
    const verdicts = (tx.lifecycleTransitions ?? []).filter((t) => t.phase === "reviewer_verdict");
    const last = verdicts[verdicts.length - 1];
    if (last && last.verdict !== "PASS") nonPass.push(`${tx.phaseId}:REVIEWER_${last.verdict}`);
  }

  if (nonPass.length > 0) {
    errors.push(`R12_AGGREGATE_CHILD_CONTRADICTION:${nonPass.slice(0, 8).join(",")}`);
  }
  if (errors.length > 0) {
    return { ok: false, holdCode: GRAPH_EVIDENCE_HOLDS.AGGREGATE_CHILD_CONTRADICTION, errors };
  }
  return { ok: true, errors: [] };
}

/**
 * Reverse-map a persisted graph-closeout evidence snapshot（the
 * autoloop.review-bundle.graph-closeout-evidence/v1 file written by
 * writeGraphCloseoutEvidence）back into the structured graphResult the
 * closeout gate consumes. This is the SAME authoritative mapping the legacy
 * card-specific closeout scripts hand-rolled — centralized here so no card
 * needs its own reconstruction script. Free-text stdout is never parsed.
 *
 * R-12: the loader is now a THIN adapter over the single canonical validator.
 * The exact v1 schema marker is enforced (GATE B), required identity fields
 * are mandatory with NO silent defaults (GATE C — no `graph-unknown`, no
 * default-HOLD), and identity binding (cardId / graphRunId) runs here so
 * disk evidence can never become authoritative before validation (GATE 6
 * caller-shaped authority removal). Structural or identity violations return
 * fail-closed R12_* errors; a VALID snapshot whose aggregate outcome is
 * non-PASS still loads normally (GATE 9 semantics).
 */
export function loadGraphResultFromEvidence(evidencePath, opts = {}) {
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
  const v = validateGraphEvidence(ev, {
    requireSchema: true,
    requireTaskIdentity: true,
    expectedCardId: opts.expectedCardId ?? null,
    expectedGraphRunId: opts.expectedGraphRunId ?? null,
  });
  if (!v.ok) {
    return { ok: false, errors: v.errors, holdCode: v.holdCode, graphResult: null };
  }
  return { ok: true, errors: [], graphResult: v.graphResult };
}

export { sha256Text };
