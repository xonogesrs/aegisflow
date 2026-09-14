// src/rollover/quarantine-validation.mjs
//
// STAGE D — THE 14-step B quarantine validation ladder (CONTRACT §9).
// Executed by the CORE rollover authority against DURABLE FACTS only.
// Order is normative — first mismatch wins with its exact frozen hold code.
// B contributes only its identity attestation; validation never reads
// process memory, PIDs, or graph.rollover.meta.* (STANDING PROHIBITION).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCheckpoint } from "../v2/checkpoint-bridge.mjs";
import { readIntent } from "../c2d/journal.mjs";
import { reconstructToolSelectionContinuity } from "../v2/durable-graph.mjs";
import { digestOf } from "../canonical-digest.mjs";
import {
  validateCanonicalSessionIdentityFields,
  recomputeRolloverIdFromIntent,
  deriveAuthorityDecisionDigest,
  deriveValidationDigest,
  ROLLOVER_STATES,
} from "./rollover-authority.mjs";
import { knownAdapterPairKeys } from "./spawn-registry.mjs";
import { createBudgetEnforcement } from "../budget/enforcement.mjs";
import { readRevocationLedger } from "../governance/truth-revocation-store.mjs";
import { latestExecutionReviewStatus, verifyLatestExecutionReview } from "../governance/execution-review.mjs";
import { classifyInterruptedWriter } from "../v2/durable-graph.mjs";
import { TOOL_SELECTION_MAPPING } from "../admission/policy-projection.mjs";

const LADDER_STEP_COUNT = 14;

/**
 * Target-kind tool projection for ONE canonical permission id.
 * Coverage: ≥1 ACTIVE row for the target kind. Scope containment: projected
 * capability grants MUST NOT exceed the source row's requiredPermissionId
 * envelope — enforced structurally here by projecting ONLY names declared on
 * rows whose requiredPermissionId equals the source permission id; any row
 * claiming a DIFFERENT permission's canonical id under this projection is a
 * superset grant ⇒ CROSS_SESSION_TOOL_PROJECTION_SCOPE_EXPANSION.
 */
export function deriveTargetKindToolProjection({ commitments, targetAdapterKind, mappingRows = TOOL_SELECTION_MAPPING }) {
  const sourceIds = Object.values(commitments ?? {})
    .flatMap((c) => (Array.isArray(c?.canonicalToolIds) ? c.canonicalToolIds : []));
  if (sourceIds.length === 0) {
    return { ok: true, basis: "LEGITIMATE_EMPTY", projectedNames: [], projectionDigestBasis: [] };
  }
  const projected = [];
  for (const id of sourceIds) {
    const targetRows = mappingRows.filter((r) => r.adapterKind === targetAdapterKind && r.requiredPermissionId === id);
    const active = targetRows.filter((r) => r.status === "ACTIVE");
    if (active.length === 0 || active.every((r) => r.adapterToolNames.length === 0)) {
      return { ok: false, code: "CROSS_SESSION_TARGET_ADAPTER_TOOL_PROJECTION_UNAVAILABLE", reason: `required canonical tool ${id} has no ACTIVE ${targetAdapterKind} mapping row` };
    }
    for (const r of active) {
      // Scope containment: the row must project ITS OWN permission id only.
      if (r.requiredPermissionId !== id || (r.canonicalToolId != null && r.canonicalToolId !== id)) {
        return { ok: false, code: "CROSS_SESSION_TOOL_PROJECTION_SCOPE_EXPANSION", reason: "mapping row projects a foreign canonical permission" };
      }
      projected.push(...r.adapterToolNames);
    }
  }
  return { ok: true, basis: "DERIVED_SELECTION", projectedNames: [...new Set(projected)].sort(), projectionDigestBasis: sourceIds };
}

/**
 * Run the full ladder. Returns
 *   { ok:true, steps, observedRevision, observedDigest, validation,
 *     validationDigest, budgetFingerprint, rsl3Pin }
 *   { ok:false, step, code, reason }
 *
 * @param {object} p
 * @param {string} p.root — durable store root
 * @param {string} p.executionId
 * @param {object} p.snapshot — CURRENT snapshot already read+checksum-verified
 * @param {string} p.checkpointDigest — digest of that CURRENT
 * @param {string} p.rolloverId — active rollover id under validation
 * @param {object} p.spawnedIdentity — { adapterKind, providerKind, opaqueSessionId, sessionGeneration }
 * @param {string} p.sourceSessionIdentityDigest — A's canonical identity digest
 * @param {number} p.sourceGeneration
 * @param {object|null} p.admission — authoritative admission record
 * @param {string|null} p.rsl3SurfaceDir — Latest surface dir override (tests)
 */
export function runQuarantineValidationLadder({
  root, executionId, snapshot, checkpointDigest, rolloverId,
  spawnedIdentity, sourceSessionIdentityDigest, sourceGeneration,
  admission = null, rsl3SurfaceDir = null,
}) {
  const execDir = join(root, executionId);
  const steps = [];
  const pass = (i, detail = "") => { steps.push({ step: i, result: "PASS", detail }); return null; };
  const fail = (i, code, reason) => ({ ok: false, step: i, code, reason, steps });

  let rollover;
  try {
    rollover = snapshot.graph?.rollover ?? null;
  } catch { rollover = null; }
  if (!rollover || typeof rollover !== "object") {
    return fail(3, "CROSS_SESSION_ROLLOVER_INTENT_MISSING", "checkpoint carries no graph.rollover block");
  }

  // ── Step 1: checkpoint integrity — readCurrent checksum verify ──────────
  // The caller obtained `snapshot` through readCheckpoint (readCurrent),
  // which throws C2dHoldError(SNAPSHOT_CHECKSUM_MISMATCH) on any tamper.
  // Re-verify presence of the integrity marker defensively.
  if (!snapshot || snapshot.checkpoint_integrity?.digest_basis !== "external_current_file" || !checkpointDigest) {
    return fail(1, "CROSS_SESSION_CHECKPOINT_MISMATCH", "checkpoint integrity marker/digest missing");
  }
  pass(1);

  // ── Step 2: schema/version gate ──────────────────────────────────────────
  const major = parseInt(String(snapshot.autoloop_format_version ?? "1.0.0").split(".")[0], 10);
  if (major !== 1) {
    return fail(2, "CROSS_SESSION_CHECKPOINT_MISMATCH", `unsupported autoloop_format_version ${snapshot.autoloop_format_version}`);
  }
  pass(2);

  // ── Step 3: rollover intent integrity — journal INTENT + digests ────────
  const intentMeta = rollover.intents?.[rolloverId];
  if (!intentMeta || typeof intentMeta !== "object") {
    return fail(3, "CROSS_SESSION_ROLLOVER_INTENT_MISSING", `no intent recorded for ${rolloverId}`);
  }
  const journalRevision = intentMeta.journalRevision;
  let journaledIntent = null;
  try {
    journaledIntent = journalRevision != null ? readIntent(execDir, journalRevision) : null;
  } catch { journaledIntent = null; }
  if (!journaledIntent) {
    return fail(3, "CROSS_SESSION_ROLLOVER_INTENT_MISSING", "journal INTENT row absent");
  }
  if (recomputeRolloverIdFromIntent(journaledIntent.intent ?? journaledIntent) !== rolloverId) {
    return fail(3, "CROSS_SESSION_CHECKPOINT_MISMATCH", "journal intent rolloverId recompute mismatch");
  }
  if (intentMeta.status && intentMeta.status !== "ACTIVE") {
    return fail(4, "CROSS_SESSION_ACK_REPLAYED", `intent status ${intentMeta.status}`);
  }
  pass(3);

  // ── Step 4: rollover ID is THE active one, not superseded/aborted ───────
  if (rollover.active_rollover_id !== rolloverId) {
    return fail(4, "CROSS_SESSION_ACK_REPLAYED", "validated rolloverId is not the active rollover");
  }
  if (ROLLOVER_ABORTED_SET.has(rollover.state)) {
    return fail(4, "CROSS_SESSION_SUCCESSOR_VALIDATION_FAILED", `rollover state ${rollover.state}`);
  }
  pass(4);

  // ── Step 5: source identity/generation match intent + CURRENT owner ─────
  if (intentMeta.sourceSessionIdentityDigest !== sourceSessionIdentityDigest ||
      rollover.owner?.session_identity_digest !== sourceSessionIdentityDigest) {
    return fail(5, "CROSS_SESSION_AUTHORITY_MISMATCH", "source session identity does not own this execution");
  }
  if (intentMeta.sourceGeneration !== sourceGeneration || rollover.owner?.session_generation !== sourceGeneration) {
    return fail(5, "CROSS_SESSION_GENERATION_MISMATCH", "source generation drift against owner-of-record");
  }
  pass(5);

  // ── Step 6: target adapter/provider binding known + matches request ─────
  const pairOk = typeof intentMeta.targetAdapterKind === "string"
    && typeof intentMeta.targetProviderKind === "string"
    && knownAdapterPairKeys().has(`${intentMeta.targetAdapterKind}\u0000${intentMeta.targetProviderKind}`);
  if (!pairOk) {
    return fail(6, "CROSS_SESSION_SUCCESSOR_ADAPTER_UNKNOWN", `${intentMeta.targetAdapterKind}/${intentMeta.targetProviderKind}`);
  }
  const iv = validateCanonicalSessionIdentityFields(spawnedIdentity, knownAdapterPairKeys());
  if (!iv.ok) return fail(6, iv.code, iv.reason);
  if (spawnedIdentity.adapterKind !== intentMeta.targetAdapterKind || spawnedIdentity.providerKind !== intentMeta.targetProviderKind) {
    return fail(6, "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", "spawned identity kind pair differs from requested target binding");
  }
  pass(6);

  // ── Step 7: expected target generation == g+1 ────────────────────────────
  if (spawnedIdentity.sessionGeneration !== sourceGeneration + 1 ||
      intentMeta.expectedTargetGeneration !== sourceGeneration + 1) {
    return fail(7, "CROSS_SESSION_GENERATION_MISMATCH", `expected ${sourceGeneration + 1}`);
  }
  pass(7);

  // ── Step 8: task/run/admission/graph/budget identities vs pins ──────────
  if (String(intentMeta.taskIdentity) !== String(snapshot.input_manifest?.execution_id ?? executionId)) {
    return fail(8, "CROSS_SESSION_AUTHORITY_MISMATCH", "task identity pin mismatch");
  }
  if (String(intentMeta.runIdentity) !== String(snapshot.input_manifest?.execution_id ?? executionId)) {
    return fail(8, "CROSS_SESSION_AUTHORITY_MISMATCH", "run identity pin mismatch");
  }
  if (admission && String(intentMeta.admissionIdentity) !== String(admission.admission_id)) {
    return fail(8, "CROSS_SESSION_AUTHORITY_MISMATCH", "admission identity pin mismatch");
  }
  const graphIdentity = intentMeta.graphIdentity ?? {};
  if ((graphIdentity.ir_sha256 ?? null) !== (snapshot.decomposition_ir_sha256 ?? null) ||
      (graphIdentity.dag_sha256 ?? null) !== (snapshot.dag_sha256 ?? null)) {
    return fail(8, "CROSS_SESSION_CHECKPOINT_MISMATCH", "graph identity (ir/dag) pin mismatch");
  }
  pass(8);

  // ── Step 9: authority decision digest recompute over pinned provenance ──
  const recomputedDecision = deriveAuthorityDecisionDigest({
    trigger: intentMeta.trigger,
    source: intentMeta.triggerSource,
    observedFact: intentMeta.triggerObservedFact,
    freshness: intentMeta.triggerFreshness,
    decisionRef: intentMeta.triggerDecisionRef,
  });
  if (recomputedDecision !== intentMeta.authorityDecisionDigest) {
    return fail(9, "CROSS_SESSION_AUTHORITY_MISMATCH", "authority decision digest recompute failed (provenance altered)");
  }
  pass(9);

  // ── Step 10: tool-selection commitment reconstruction + projection ──────
  const commitments = snapshot.graph?.tool_selection_commitments ?? {};
  let projection = { ok: true, basis: "LEGITIMATE_EMPTY", projectedNames: [], projectionDigestBasis: [] };
  if (admission && Object.keys(commitments).length > 0) {
    try {
      reconstructToolSelectionContinuity({ executionId, admission, commitments });
    } catch (e) {
      return fail(10, "CROSS_SESSION_SUCCESSOR_VALIDATION_FAILED", `tool-selection continuity: ${String(e?.code ?? e?.message ?? e).slice(0, 160)}`);
    }
    projection = deriveTargetKindToolProjection({ commitments, targetAdapterKind: intentMeta.targetAdapterKind });
    if (!projection.ok) return fail(10, projection.code, projection.reason);
  }
  pass(10);

  // ── Step 11: budget state + reservations reconstruct identically ────────
  let budgetContinuity = null;
  let budgetFingerprint = null;
  const ledgerPath = join(execDir, "artifacts", "budget-ledger.json");
  if (existsSync(ledgerPath)) {
    if (!admission || typeof admission !== "object") {
      return fail(11, "CROSS_SESSION_BUDGET_RECONSTRUCTION_FAILED", "budget state present but no authoritative admission");
    }
    let ledgerState = null;
    try { ledgerState = JSON.parse(readFileSync(ledgerPath, "utf8")); } catch {
      return fail(11, "CROSS_SESSION_BUDGET_RECONSTRUCTION_FAILED", "budget ledger artifact malformed");
    }
    const enc = createBudgetEnforcement({ admission, checkpointState: ledgerState });
    if (!enc.ok) {
      return fail(11, enc.holdCode ?? "CROSS_SESSION_BUDGET_RECONSTRUCTION_FAILED", String(enc.reason ?? "ledger resume failed").slice(0, 160));
    }
    budgetFingerprint = enc.enforcement.checkpointState();
    budgetContinuity = digestOf(budgetFingerprint);
  }
  pass(11);

  // ── Step 12: lifecycle/graph state fold-clean ────────────────────────────
  if (snapshot.writer_phase_active === true || snapshot.writer_lease_holder) {
    return fail(12, "CROSS_SESSION_SUCCESSOR_VALIDATION_FAILED", "interrupted writer phase active at freeze point");
  }
  for (const id of snapshot.completed_phase_ids ?? []) {
    if (typeof snapshot.phase_result_hashes?.[id] !== "string") {
      return fail(12, "CROSS_SESSION_SUCCESSOR_VALIDATION_FAILED", `completed phase ${id} lacks result hash`);
    }
  }
  if (snapshot.active_phase) {
    const phase = { phase_id: snapshot.active_phase };
    const classification = classifyInterruptedWriter({ snapshot, phase, execDir, graphMeta: snapshot.graph ?? {} });
    if (classification === "CONFLICTED" || classification === "INVALID") {
      return fail(12, "CROSS_SESSION_SUCCESSOR_VALIDATION_FAILED", `interrupted-writer classification ${classification}`);
    }
  }
  pass(12);

  // ── Step 13: revocation status clean over pinned authorities ────────────
  const ledgerDir = join(execDir, "truth-revocations");
  const rev = readRevocationLedger(existsSync(ledgerDir) ? ledgerDir : null);
  if (!rev.ok) {
    return fail(13, "CROSS_SESSION_REVOCATION_OBSERVED", "revocation ledger unreadable (fail closed)");
  }
  const applies = rev.events.filter((e) => {
    const blob = JSON.stringify(e.subjects ?? e ?? {});
    return blob.includes(String(intentMeta.admissionIdentity)) || blob.includes(executionId);
  });
  if (applies.length > 0) {
    return fail(13, "CROSS_SESSION_REVOCATION_OBSERVED", `${applies.length} revocation(s) apply to pinned authorities`);
  }
  pass(13);

  // ── Step 14: RSL3 publication continuity pin ─────────────────────────────
  const rsl3 = latestExecutionReviewStatus({ surfaceDir: rsl3SurfaceDir ?? undefined });
  const rsl3Pin = rsl3.identity ?? null;
  pass(14);

  const validation = {
    rolloverId,
    checkpointRevision: snapshot.revision,
    checkpointDigest,
    steps: steps.map(({ step, result }) => ({ step, result })),
    toolSelectionProjection: digestOf({ basis: projection.basis, ids: projection.projectionDigestBasis, names: projection.projectedNames }),
    budgetContinuity,
    revocationCheck: "CLEAN",
    rsl3LatestIdentityPin: rsl3Pin,
  };
  return {
    ok: true,
    steps,
    observedRevision: snapshot.revision,
    observedDigest: checkpointDigest,
    validation,
    validationDigest: deriveValidationDigest(validation),
    budgetFingerprint,
    rsl3Pin,
  };
}

/**
 * ACK/transfer-time RSL3 re-check (step 14 continuation): the pinned Latest
 * identity must still verify, else monotonicity was broken mid-flight.
 */
export function verifyRsl3PinStillValid({ rsl3Pin, rsl3SurfaceDir = null }) {
  if (rsl3Pin == null) return { ok: true }; // nothing published yet at freeze
  const v = verifyLatestExecutionReview({ surfaceDir: rsl3SurfaceDir ?? undefined, expected: { identity: rsl3Pin } });
  if (v.ok) return { ok: true };
  return { ok: false, code: "CROSS_SESSION_REVOCATION_OBSERVED", reason: "RSL3 Latest identity changed since freeze pin (rotation raced the rollover)" };
}


const ROLLOVER_ABORTED_SET = new Set([
  ROLLOVER_STATES.ROLLOVER_ABORTED_PRE_TRANSFER,
  ROLLOVER_STATES.B_SPAWN_FAILED,
  ROLLOVER_STATES.B_VALIDATION_FAILED,
  ROLLOVER_STATES.B_ACK_TIMEOUT,
]);
