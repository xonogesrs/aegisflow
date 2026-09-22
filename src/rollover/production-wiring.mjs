// src/rollover/production-wiring.mjs
//
// STAGE D — coordinator-level trigger intake + THE production rollover
// sequence composition (CALL-GRAPH §5.1: "Trigger intake: coordinator level,
// post-admission, pre-dispatch").
//
// This module is the ONLY place that composes the core rollover authority
// with an adapter-layer factory (agent-kind strings stay in the registry /
// adapter projection — T59-safe). It is injected into runDurableGraph as
// `rolloverRequestExecutor` by the AUTHORIZED intake path; caller options
// can never supply it (AUTHORITATIVE_RUN_KEYS / AUTHORITY_SEAM_RUNNER_KEYS
// fence those keys at both sinks).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import "./../adapter/pi-spawn-adapter.mjs"; // registers THE production row
import { resolveSpawnAdapter, canonicalizeProviderBinding, providerBindingsEqual } from "./spawn-registry.mjs";
import {
  declareSafeFreezePoint, beginRollover, recordSpawnDispatched,
  recordSpawnReceipt, recordValidationPassed, publishDurableAck,
  commitOwnershipTransfer, enterActiveB,
} from "./rollover-controller.mjs";
import { coordinateSuccessorSpawn, verifyQuarantineAttestation } from "./session-spawn.mjs";
import {
  runQuarantineValidationLadder, verifyRsl3PinStillValid,
} from "./quarantine-validation.mjs";
import { sessionIdentityDigest } from "./rollover-authority.mjs";
import { readCheckpoint } from "../v2/checkpoint-bridge.mjs";
import { RunEvidenceStore } from "../evidence/run-evidence-store.mjs";

// WP2 canonical rollover executor factory (moved here from admission-gate.mjs
// — SINGLE definition; the fresh durable path and the successor resume path
// both derive through THIS function, never a second implementation).

export function admittedProviderBinding(admission) {
  return canonicalizeProviderBinding(admission?.extensions?.rollover?.provider_binding);
}

/**
 * REAL_TASK evidence: provider-reported usage must be durably observed with
 * positive occupancy and journal linkage. Fake/failed/missing provider
 * activity cannot satisfy REAL_TASK.
 */
export function evaluateRealTaskEvidence({ observation = null, journalEvents = null } = {}) {
  if (observation && typeof observation === "object") {
    if (observation.observed !== true) {
      return { ok: false, reason: "provider usage not observed" };
    }
    if (typeof observation.occupancy !== "number" || !Number.isFinite(observation.occupancy) || observation.occupancy <= 0) {
      return { ok: false, reason: "occupancy not positive" };
    }
    if (typeof observation.usageEventId !== "string" || observation.usageEventId.length === 0) {
      return { ok: false, reason: "no journal usageRecordId" };
    }
    return { ok: true, occupancy: observation.occupancy, usageEventId: observation.usageEventId };
  }
  if (Array.isArray(journalEvents)) {
    const observed = journalEvents.filter((e) => e.event_type === "PROVIDER_USAGE_OBSERVED");
    if (observed.length === 0) {
      return { ok: false, reason: "no PROVIDER_USAGE_OBSERVED journal event" };
    }
    const last = observed[observed.length - 1];
    const payload = last.payload ?? {};
    if (payload.provider_reported !== true) {
      return { ok: false, reason: "usage not provider-reported" };
    }
    if (typeof payload.occupancy !== "number" || !Number.isFinite(payload.occupancy) || payload.occupancy <= 0) {
      return { ok: false, reason: "occupancy not positive" };
    }
    return { ok: true, occupancy: payload.occupancy, usageEventId: last.event_id ?? last.sequence };
  }
  return { ok: false, reason: "no provider usage evidence" };
}


// ── WP1 — AUTOMATIC CONTEXT TRIGGER PRODUCER ───────────────────────────────
// Provider message_end.usage → durable usage observation → deterministic
// context occupancy → CONTEXT_THRESHOLD_REACHED. NO model-estimated usage,
// NO self-minted usage: every trigger event pins providerReported=true and
// a durable usageRecordId (the evidence journal event id that carries the
// raw provider-reported fields). Occupancy = input + cacheRead + cacheWrite
// (the P3-U1-admitted provider-reported fields).

/**
 * Deterministic context occupancy from ONE provider-reported usage object.
 * Non-numeric / missing fields fail closed (NaN), never guessed to 0.
 * @returns {{ ok: true, occupancy: number, fields: {input,cacheRead,cacheWrite} }
 *          | { ok: false, reason: string }}
 */
export function contextOccupancyFromUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return { ok: false, reason: "usage object missing" };
  }
  const fields = {};
  for (const f of ["input", "cacheRead", "cacheWrite"]) {
    const v = usage[f];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return { ok: false, reason: `usage field ${f} is not a non-negative finite number` };
    }
    fields[f] = v;
  }
  return { ok: true, occupancy: fields.input + fields.cacheRead + fields.cacheWrite, fields };
}

/**
 * THE frozen context-occupancy threshold for ONE admitted run.
 * Authority = the frozen admission record ONLY (extensions.rollover.
 * context_occupancy_threshold — admission is digest-bound, so the threshold
 * is frozen at admission time). No magic hardcoded threshold, no
 * environment variable, no runtime input.
 * @returns {{ ok: true, threshold: number } | { ok: false, reason: string }}
 */
export function contextOccupancyThreshold(admission) {
  const t = admission?.extensions?.rollover?.context_occupancy_threshold;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0 || !Number.isInteger(t)) {
    return { ok: false, reason: "admission extensions.rollover.context_occupancy_threshold missing/invalid (no runtime fallback)" };
  }
  return { ok: true, threshold: t };
}

/**
 * Observe provider-reported usage DURABLY and produce the automatic trigger
 * event when the frozen threshold is reached.
 *
 * Failure semantics (WP1): a usage-observation failure is a JOURNAL
 * OBSERVABILITY failure — it returns { triggered:false, observed:false }
 * and NEVER fabricates a rollover trigger. A continues when otherwise legal.
 *
 * @param {object} p
 * @param {object} p.store — the run's RunEvidenceStore (durable journal)
 * @param {object} p.admission — the frozen admission (threshold authority)
 * @param {object} p.usage — provider message_end.usage (pi-ai Usage)
 * @param {string} p.executionId
 * @param {string} p.phaseId — phase whose executor produced this usage
 * @returns {{ triggered: boolean, observed: boolean, reason?: string,
 *             triggerEvent?: object, usageEventId?: string, occupancy?: number }}
 */
export function observeProviderUsageAndTrigger({ store, admission, usage, executionId, phaseId }) {
  const occ = contextOccupancyFromUsage(usage);
  if (!occ.ok) {
    // Malformed/absent provider usage: journal the observability failure,
    // never fabricate a trigger (WP1 failure policy).
    try {
      store.appendEvent({
        event_type: "ROLLOVER_USAGE_OBSERVATION_FAILED",
        stage: "rollover",
        phase_id: phaseId ?? null,
        payload: { reason: occ.reason.slice(0, 160) },
      });
    } catch { /* journal itself unavailable — still no fabricated trigger */ }
    return { triggered: false, observed: false, reason: occ.reason };
  }
  const th = contextOccupancyThreshold(admission);
  if (!th.ok) {
    try {
      store.appendEvent({
        event_type: "ROLLOVER_USAGE_OBSERVATION_FAILED",
        stage: "rollover",
        phase_id: phaseId ?? null,
        payload: { reason: th.reason.slice(0, 160) },
      });
    } catch { /* same: never a fabricated trigger */ }
    return { triggered: false, observed: false, reason: th.reason };
  }
  // Durable usage observation FIRST: the usageRecordId is the evidence
  // journal event id carrying the raw provider-reported fields.
  let usageEvent = null;
  try {
    usageEvent = store.appendEvent({
      event_type: "PROVIDER_USAGE_OBSERVED",
      stage: "rollover",
      phase_id: phaseId ?? null,
      payload: {
        provider_reported: true,
        occupancy_fields: occ.fields,
        occupancy: occ.occupancy,
        threshold: th.threshold,
      },
    });
  } catch (e) {
    return { triggered: false, observed: false, reason: `usage observation journal failed: ${String(e?.code ?? e?.message ?? e).slice(0, 120)}` };
  }
  if (occ.occupancy < th.threshold) {
    return { triggered: false, observed: true, occupancy: occ.occupancy, usageEventId: usageEvent.event_id };
  }
  const triggerEvent = {
    trigger: "CONTEXT_THRESHOLD_REACHED",
    source: "autoloop.production-context-occupancy-producer",
    authorityDecisionRef: `usage:${usageEvent.event_id}`,
    freshness: new Date().toISOString(),
    taskIdentity: executionId,
    runIdentity: executionId,
    admissionIdentity: String(admission?.admission_id ?? ""),
    observedFact: {
      providerReported: true,
      usageRecordId: usageEvent.event_id,
      occupancy: occ.occupancy,
      threshold: th.threshold,
      occupancyFields: occ.fields,
    },
  };
  return { triggered: true, observed: true, occupancy: occ.occupancy, usageEventId: usageEvent.event_id, triggerEvent };
}

/**
 * Window dedup for the automatic producer: exactly ONE eligible trigger per
 * rollover window. The durable CURRENT mirror is the ONLY authority — the
 * in-run `_rolloverExecuted` flag and the ACTIVE pre-commit fence stay the
 * primary dedupe; this predicate adds the explicit "window already used"
 * check so a re-observed threshold after a transfer/retirement can never
 * mint a second successor for the same owner generation.
 * @returns {{ eligible: boolean, reason?: string }}
 */
export function automaticTriggerEligible({ rolloverBlock, sourceGeneration }) {
  if (!rolloverBlock || typeof rolloverBlock !== "object") return { eligible: true };
  // MULTI-SESSION REPAIR-1: `active_rollover_id` is NON-null through the
  // whole post-commit era (OWNERSHIP_TRANSFER_COMMITTED / ACTIVE_B) until
  // the retirement progression clears it — but a post-commit state is NOT
  // an active window for the CURRENT owner generation: the pinned id
  // belongs to the PREVIOUS transfer. An active window is exactly an ACTIVE
  // PRE-COMMIT rollover state (the §9a owner-frozen world). Post-commit /
  // closed-era states are gated by the per-generation intent dedup below,
  // never by the previous transfer's id. Any UNKNOWN state token fails
  // closed (ineligible) — never defaults open.
  const POST_COMMIT_OR_CLOSED = new Set([
    "OWNERSHIP_TRANSFER_COMMITTED", "ACTIVE_B", "A_RETIREMENT_PENDING",
    "A_RETIRED", "A_RETIREMENT_CONFIRMED",
  ]);
  if (!POST_COMMIT_OR_CLOSED.has(rolloverBlock.state)) {
    if (rolloverBlock.active_rollover_id) {
      return { eligible: false, reason: "a rollover is already active for this window" };
    }
  }
  const intents = rolloverBlock.intents ?? {};
  for (const intent of Object.values(intents)) {
    if (!intent || typeof intent !== "object") continue;
    if (intent.trigger === "CONTEXT_THRESHOLD_REACHED"
        && Number(intent.sourceGeneration) === Number(sourceGeneration)) {
      return { eligible: false, reason: "an automatic trigger already fired for this owner generation" };
    }
  }
  return { eligible: true };
}

/**
 * Build THE authorized mid-run rollover executor for ONE execution.
 *
 * Provider identity is derived INSIDE run() from the durable admitted
 * provider_binding. Caller targetAdapterKind/targetProviderKind/model
 * defaults do not exist — no DeepSeek (or any) provider authority here.
 *
 * @param {object} p
 * @param {object} p.triggerEvent — validated against the closed set at begin()
 * @param {object} p.sourceIdentity — A's canonical identity triple (generation g)
 * @param {string|null} p.rsl3SurfaceDir — Latest surface under observation;
 *   REQUIRED in production wiring (explicit > implicit); tests pass a temp dir.
 * @param {boolean} [p.requireEcho=true] — real-adapter attestation echo check.
 * @returns {{ run: (runner) => Promise<object>, state: () => object }}
 */
export function createRolloverIntake({
  triggerEvent, sourceIdentity, rsl3SurfaceDir = null, requireEcho = true,
}) {
  const st = { executed: false, result: null, error: null };
  const run = async (runner) => {
    if (st.executed) return st.result;
    st.executed = true;
    try {
      const providerBound = admittedProviderBinding(runner.admission);
      if (!providerBound.ok) throw new Error(`${providerBound.code}: ${providerBound.reason}`);
      const { adapterKind: targetAdapterKind, providerKind: targetProviderKind, modelId, requiredEnvKeys } = providerBound.value;
      if (sourceIdentity?.adapterKind !== targetAdapterKind || sourceIdentity?.providerKind !== targetProviderKind) {
        throw new Error("CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID: source identity provider pair != admitted provider_binding");
      }
      // 1. Safe freeze point — between-phase boundary quiescence proof (§7).
      const safePoint = declareSafeFreezePoint({ root: runner.root, executionId: runner.executionId, atSafeBoundary: true });
      // 2. Durable INTENT pinned to the verified clean head H (§6).
      const begun = await beginRollover({
        root: runner.root, executionId: runner.executionId, store: runner.store,
        triggerEvent,
        targetAdapterKind, targetProviderKind,
        sourceIdentity,
        admission: runner.admission,
        graphIdentity: { ir_sha256: runner.irSha, dag_sha256: runner.dagSha },
        toolSelectionCommitmentDigest: null,
        budgetStateDigest: null,
        lifecycleStateDigest: null,
        safePoint,
      });
      // 3. Spawn dispatch — event-bound BEFORE any provider call (GAP-1).
      await recordSpawnDispatched({ root: runner.root, executionId: runner.executionId, store: runner.store, rolloverId: begun.rolloverId });
      const dispatchEvent = runner.store.appendEvent({
        event_type: "SPAWN_DISPATCH", stage: "rollover",
        payload: {
          rollover_id: begun.rolloverId,
          provider_binding: { adapterKind: targetAdapterKind, providerKind: targetProviderKind, modelId, requiredEnvKeys: [...requiredEnvKeys] },
        },
      });
      const resolved = resolveSpawnAdapter({ adapterKind: targetAdapterKind, providerKind: targetProviderKind });
      if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.reason}`);
      const spawned = await coordinateSuccessorSpawn({
        request: {
          schemaVersion: 1,
          adapterKind: targetAdapterKind, providerKind: targetProviderKind,
          modelId, requiredEnvKeys: [...requiredEnvKeys],
          rolloverId: begun.rolloverId,
          expectedTargetGeneration: sourceIdentity.sessionGeneration + 1,
          checkpointLocator: { root: runner.root, executionId: runner.executionId },
          checkpointDigest: safePoint.checkpointDigest,
          taskIdentity: String(triggerEvent.taskIdentity),
          runIdentity: String(triggerEvent.runIdentity),
          admissionIdentity: String(runner.admission?.admission_id ?? triggerEvent.admissionIdentity),
          authorityDecisionDigest: begun.intent.authorityDecisionDigest,
        },
        evidenceEvent: { event_id: dispatchEvent.event_id, sequence: dispatchEvent.sequence },
      });
      if (!spawned.ok) throw new Error(`${spawned.code}: ${spawned.reason}`);
      // 4. Receipt durable (C6 boundary).
      await recordSpawnReceipt({
        root: runner.root, executionId: runner.executionId, store: runner.store,
        rolloverId: begun.rolloverId,
        candidate: {
          spawnReceiptDigest: spawned.spawnReceiptDigest,
          identity: spawned.identity,
          startedAt: spawned.startedAt,
          boundEventSequence: spawned.boundEventSequence,
        },
      });
      // 5. Quarantine validation ladder on THIS checkpoint (§9).
      const verified = readCheckpoint(runner.root, runner.executionId);
      const ladder = runQuarantineValidationLadder({
        root: runner.root, executionId: runner.executionId,
        snapshot: verified.snapshot, checkpointDigest: verified.digest,
        rolloverId: begun.rolloverId,
        spawnedIdentity: { ...spawned.identity, sessionGeneration: sourceIdentity.sessionGeneration + 1 },
        sourceSessionIdentityDigest: sessionIdentityDigest(sourceIdentity),
        sourceGeneration: sourceIdentity.sessionGeneration,
        admission: runner.admission,
        rsl3SurfaceDir,
      });
      if (!ladder.ok) throw new Error(`${ladder.code}: step ${ladder.step}: ${ladder.reason}`);
      // 6. B identity attestation binding (identity echo through the REAL
      //    adapter channel; the ACK authority stays with the core).
      const bDigest = sessionIdentityDigest({ ...spawned.identity, sessionGeneration: sourceIdentity.sessionGeneration + 1 });
      const replyText = typeof spawned.replyText === "string" ? spawned.replyText : "";
      // The quarantined session must acknowledge through its bound channel
      // (non-empty reply). Verbatim echo is NOT required by the frozen
      // contract: the ACK authority is the core's recomputation over durable
      // facts (P5), and B's identity is already durably corroborated by the
      // event-bound REAL spawn receipt (P3 + session file).
      if (requireEcho && replyText.trim().length === 0) {
        throw new Error("CROSS_SESSION_SUCCESSOR_VALIDATION_FAILED: quarantined session produced no acknowledgment on its bound channel");
      }
      const attestation = {
        kind: "autoloop.quarantine-attestation/v1",
        rolloverId: begun.rolloverId,
        sessionIdentityDigest: bDigest,
        validationDigest: ladder.validationDigest,
        attestedAt: new Date().toISOString(),
      };
      const bound = verifyQuarantineAttestation({ attestation, spawnedIdentityDigest: bDigest, expectedValidationDigest: ladder.validationDigest });
      if (!bound.ok) throw new Error(`${bound.code}: ${bound.reason}`);
      await recordValidationPassed({ root: runner.root, executionId: runner.executionId, store: runner.store, rolloverId: begun.rolloverId, validationDigest: ladder.validationDigest, observedRevision: ladder.observedRevision });
      // 7. Durable ACK (§10).
      const ackRes = await publishDurableAck({
        root: runner.root, executionId: runner.executionId, store: runner.store,
        rolloverId: begun.rolloverId,
        ack: {
          rolloverId: begun.rolloverId,
          sourceSessionIdentityDigest: sessionIdentityDigest(sourceIdentity),
          sourceGeneration: sourceIdentity.sessionGeneration,
          targetSessionIdentityDigest: bDigest,
          targetGeneration: sourceIdentity.sessionGeneration + 1,
          checkpointRevision: ladder.observedRevision,
          checkpointDigest: ladder.observedDigest,
          validationDigest: ladder.validationDigest,
        },
      });
      if (!ackRes.ok && !ackRes.idempotent) throw new Error("ACK publication failed");
      // 8. Atomic ownership transfer CAS (§13), RSL3 pin re-checked first.
      const transfer = await commitOwnershipTransfer({
        root: runner.root, executionId: runner.executionId, store: runner.store,
        rolloverId: begun.rolloverId,
        rsl3PinCheck: () => verifyRsl3PinStillValid({ rsl3Pin: ladder.rsl3Pin, rsl3SurfaceDir }),
      });
      if (!transfer.ok && !transfer.idempotent) throw new Error("ownership transfer failed");
      st.result = {
        ok: true,
        rolloverId: begun.rolloverId,
        successorBinding: { sessionIdentityDigest: bDigest, sessionGeneration: sourceIdentity.sessionGeneration + 1 },
        transfer: transfer.transfer ?? null,
      };
      return st.result;
    } catch (e) {
      st.error = e;
      throw e;
    }
  };
  return { run, state: () => ({ ...st }) };
}

/**
 * WP3 — THE THINNEST AUTONOMOUS SUCCESSOR BOOTSTRAP (production).
 *
 * A freshly spawned quarantined Session B calls THIS with locator/bootstrap
 * metadata ONLY (no prompt, no task context, no human reprompt). The binding
 * authority is CANONICAL DURABLE TRUTH — CURRENT.rollover.owner — never the
 * spawn payload, never an environment variable, never a self-minted identity.
 *
 * Steps:
 *   1. locate persistence root + execution id (locator metadata);
 *   2. read the checksummed canonical CURRENT;
 *   3. derive the owner/session binding from durable truth (rollover.owner);
 *   4. cross-check the spawn metadata against that truth (rolloverId,
 *      expected generation, checkpoint digest basis);
 *   5. call the existing resumeAsSuccessor with the derived binding.
 *
 * Required negative behavior (fail closed, exact codes):
 *   - stale generation / wrong execution id / wrong rollover id /
 *     mismatched checkpoint digest basis / mismatched session identity /
 *     self-minted successor identity → refused BEFORE any dispatch.
 *
 * @param {object} p
 * @param {string} p.persistenceRoot — durable evidence root (locator)
 * @param {string} p.executionId — the SAME durable execution id A ran
 * @param {object} [p.spawnMeta] — bootstrap metadata from the spawn payload
 *   { rolloverId?, expectedTargetGeneration?, checkpointDigest? } — CROSS-
 *   CHECKED against CURRENT, never trusted by itself.
 * @param {object} rest — forwarded to resumeAsSuccessor (admission, ir,
 *   parent, manifest, cwd, repoPath, scratchRoot, hooks, ...).
 */
export async function bootstrapSuccessorSession({ persistenceRoot, executionId, spawnMeta = null, ...rest }) {
  const fail = (code, reason) => {
    const err = new Error(`${code}: ${reason}`);
    err.code = code;
    return err;
  };
  if (typeof persistenceRoot !== "string" || persistenceRoot.length === 0
      || typeof executionId !== "string" || executionId.length === 0) {
    throw fail("CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", "bootstrap locator requires persistenceRoot + executionId");
  }
  if (spawnMeta && typeof spawnMeta === "object" && spawnMeta.providerBinding !== undefined && spawnMeta.providerBinding !== null) {
    const admitted = admittedProviderBinding(rest.admission);
    if (!admitted.ok) {
      throw fail("CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", "durable admission provider_binding missing/invalid");
    }
    const incoming = canonicalizeProviderBinding(spawnMeta.providerBinding);
    if (!incoming.ok || !providerBindingsEqual(incoming.value, admitted.value)) {
      throw fail("CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", "spawn metadata providerBinding != durable admission providerBinding");
    }
  }

  const rb = await import("./rollover-authority.mjs");

  // 2. Canonical CURRENT (checksum-verified; tamper throws SNAPSHOT_CHECKSUM_MISMATCH).
  // A missing checkpoint (wrong execution id / wrong root) fails closed with
  // the exact resume-entry code — never a silent open door.
  const verified = (() => {
    try { return readCheckpoint(persistenceRoot, executionId); }
    catch (e) {
      if (e instanceof TypeError) {
        // readCurrent returns null for a MISSING checkpoint — the exact
        // resume-entry refusal code, never a silent open door.
        throw fail("RESUME_FINGERPRINT_MISMATCH", "no checkpoint exists for this execution");
      }
      throw e; // checksum/corrupt holds propagate verbatim (fail closed)
    }
  })();
  if (!verified || !verified.snapshot) {
    throw fail("RESUME_FINGERPRINT_MISMATCH", "no checkpoint exists for this execution");
  }
  const rollover = verified.snapshot.graph?.rollover ?? null;
  if (!rollover || typeof rollover !== "object" || rollover.schema !== rb.ROLLOVER_INTENT_SCHEMA) {
    throw fail("CROSS_SESSION_ROLLOVER_INTENT_MISSING", "no canonical rollover block on CURRENT");
  }
  if (rollover.state !== rb.ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED
      && rollover.state !== rb.ROLLOVER_STATES.ACTIVE_B) {
    throw fail("CROSS_SESSION_STALE_SOURCE_FENCED", `durable rollover state ${rollover.state} is not post-commit; no successor era exists`);
  }
  const owner = rollover.owner ?? null;
  if (!owner || typeof owner.session_identity_digest !== "string" || !Number.isInteger(owner.session_generation)) {
    throw fail("CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", "durable owner-of-record missing/malformed (self-minted successor identity refused)");
  }
  const activeId = rollover.active_rollover_id ?? null;
  if (!activeId) {
    throw fail("CROSS_SESSION_ROLLOVER_INTENT_MISSING", "post-commit rollover without an active rolloverId (poisoned store)");
  }

  // 3. THE canonical binding — derived from durable truth, not from input.
  const binding = { sessionIdentityDigest: owner.session_identity_digest, sessionGeneration: owner.session_generation };

  // 4. Cross-check spawn metadata against durable truth (present ⇒ must match).
  if (spawnMeta && typeof spawnMeta === "object") {
    if (spawnMeta.rolloverId !== undefined && spawnMeta.rolloverId !== null && spawnMeta.rolloverId !== activeId) {
      throw fail("CROSS_SESSION_ACK_REPLAYED", `spawn metadata rolloverId ${String(spawnMeta.rolloverId).slice(0, 16)} != durable active ${activeId.slice(0, 16)}`);
    }
    if (spawnMeta.expectedTargetGeneration !== undefined && spawnMeta.expectedTargetGeneration !== null
        && Number(spawnMeta.expectedTargetGeneration) !== owner.session_generation) {
      throw fail("CROSS_SESSION_GENERATION_MISMATCH", `spawn metadata generation ${String(spawnMeta.expectedTargetGeneration)} != durable owner generation ${owner.session_generation} (stale generation refused)`);
    }
    if (spawnMeta.checkpointDigest !== undefined && spawnMeta.checkpointDigest !== null
        && spawnMeta.checkpointDigest !== verified.digest) {
      // The spawn pinned the digest at freeze time; CURRENT legitimately
      // advanced with the rollover publications themselves — a mismatch is
      // only fatal when the pinned digest is NEWER than the transfer pin.
      const transfer = rollover.transfers?.[activeId] ?? null;
      const ackDigestBasis = transfer?.checkpointRevision ?? null;
      if (ackDigestBasis !== null && verified.snapshot.revision < ackDigestBasis) {
        throw fail("CROSS_SESSION_CHECKPOINT_MISMATCH", "spawn metadata checkpoint digest does not match CURRENT and CURRENT predates the transfer pin");
      }
    }
  }

  // 5. Existing gated continuation (ACTIVE_B entry + §13a fence + resume).
  return resumeAsSuccessor({ persistenceRoot, executionId, binding, ...rest });
}

/**
 * B-side continuation entry after handover: publishes the ACTIVE_B entry
 * (OWNERSHIP_TRANSFER_COMMITTED → ACTIVE_B) when the §13a gate will pass,
 * THEN resumes through the standard ladder with the successor binding.
 */
export async function resumeAsSuccessor({ persistenceRoot, executionId, binding, ...rest }) {
  if (!binding || typeof binding !== "object") {
    throw new Error("CROSS_SESSION_STALE_SOURCE_FENCED: successor binding required");
  }
  // STAGE-D BUDGET HANDOVER (DISPOSITION-1 — supersedes the ADV-REVIEW P1-3
  // fail-closed disposition): B-era metering now continues through THE
  // EXISTING budget authority. The caller's live enforcement NEVER crosses
  // the ownership boundary (double-baseline); the durable ledger artifact
  // plus the re-verified admission are the only truth inputs, and the
  // reconstruction itself happens exactly once inside resumeDurableGraph's
  // protected seam (createBudgetEnforcement over budget-ledger.json).
  // No second meter, no second ledger, no new schema, no new hold codes:
  // failures map onto the frozen §9 code CROSS_SESSION_BUDGET_RECONSTRUCTION_FAILED.
  delete rest.budget;
  const admission = rest.admission ?? null;
  const artifactsDir = join(persistenceRoot, executionId, "artifacts");
  const hadLedger = existsSync(join(artifactsDir, "budget-ledger.json"));
  const hadAdmissionArtifact = existsSync(join(artifactsDir, "admission.json"));
  const budgetHandoverFailure = (reason) => {
    const err = new Error(`CROSS_SESSION_BUDGET_RECONSTRUCTION_FAILED: ${reason}`);
    err.code = "CROSS_SESSION_BUDGET_RECONSTRUCTION_FAILED";
    return err;
  };
  if (hadLedger && (!admission || typeof admission !== "object")) {
    // A metered era exists on disk: continuation without the authoritative
    // admission would be un-attributable consumption — never presume zero.
    throw budgetHandoverFailure("metered era requires an authoritative admission on successor resume");
  }
  if (!hadLedger && hadAdmissionArtifact) {
    // Production-admitted runs are ALWAYS metered (runAdmittedGraph derives
    // the envelope from the frozen admission). An admitted era that lost its
    // durable ledger truth must not continue silently un-metered — fail
    // closed; there is no reset path in Contract V1 §18.
    throw budgetHandoverFailure("admitted era lost budget-ledger.json; successor continuation refused");
  }
  const dg = await import("../v2/durable-graph.mjs");
  const rc = await import("./rollover-controller.mjs");
  const rb = await import("./rollover-authority.mjs");

  // R-07: successor-era telemetry continuity (bounded repair). The
  // successor era previously ran WITHOUT the canonical R-06 telemetry
  // wiring (bootstrapSuccessorSession is not the admission gate, so no
  // wiring was ever resolved for it) — the era emitted nothing into the
  // run-scoped store and the operator surface could not observe it. The
  // canonical seam is the SAME run-scoped store (S16 §5): re-open it
  // through buildProductionTelemetryWiring (idempotent init — the store
  // already exists from era A) and forward the wiring so era B appends to
  // the SAME lifecycle stream. Emissions remain best-effort observability
  // (Phase D authority fence): init failure degrades, never blocks the
  // resume. Callers that pass their own telemetry wiring keep it (compat).
  if (rest.telemetry == null) {
    try {
      const { buildProductionTelemetryWiring } = await import("../telemetry/production-observer.mjs");
      const owner = readCheckpoint(persistenceRoot, executionId).snapshot?.graph?.rollover?.owner ?? null;
      const built = buildProductionTelemetryWiring({
        graphRunId: executionId,
        sessionId: owner?.session_identity_digest ?? null,
        generation: Number.isInteger(owner?.session_generation) && owner.session_generation >= 0 ? owner.session_generation : 0,
      });
      if (built.ok) rest.telemetry = built.wiring;
    } catch { /* telemetry degradation is never a resume failure (S16 §J) */ }
  }

  // Pre-check against durable truth, then publish ACTIVE_B entry BEFORE any
  // phase dispatch (C14 ordering: commit → ACTIVE_B entry → first dispatch).
  const verified = readCheckpoint(persistenceRoot, executionId);
  const rollover = verified.snapshot.graph?.rollover ?? null;
  const activeId = rollover?.active_rollover_id ?? null;
  if (activeId && rollover.state === rb.ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED) {
    const owner = rollover.owner ?? {};
    if (binding.sessionIdentityDigest !== owner.session_identity_digest ||
        binding.sessionGeneration !== owner.session_generation) {
      const err = new Error("CROSS_SESSION_STALE_SOURCE_FENCED: resume binding != durable owner-of-record");
      err.code = "CROSS_SESSION_STALE_SOURCE_FENCED";
      throw err;
    }
    const store = new RunEvidenceStore({
      root: persistenceRoot, executionId,
      chainId: verified.snapshot.chain_id, checkpointId: verified.snapshot.checkpoint_id,
    });
    store.init();
    await rc.enterActiveB({ root: persistenceRoot, executionId, store, rolloverId: activeId });
  }

  let result;
  try {
    // WP1: when the frozen IR is a sub-agent graph（any phase declares
    // runtime.mode === "subagent"）, compose THE production sub-agent wiring
    // for the successor era — the SAME definition the fresh path and the
    // DE-2R resume entry use（buildSubagentGraphHooks + the sub-agent
    // adapter factories）. Without it the successor era runs bare durable
    // hooks: the writer's mutationScope is never projected from the
    // admission（scope gate fails closed on any change）, dependency results
    // are never persisted/verified, and the /results mount never reaches
    // verifier phases. Non-subagent graphs keep the exact prior behavior.
    const composedOpts = await (async () => {
      try {
        const ir = rest.ir ?? null;
        const isSubagentGraph = ir && Array.isArray(ir.phases)
          && ir.phases.some((p) => p?.runtime?.mode === "subagent");
        if (!isSubagentGraph) return rest;
        const { composeSuccessorSubagentGraphOpts } = await import("../subagent/subagent-graph-runner.mjs");
        return composeSuccessorSubagentGraphOpts({ ...rest, persistenceRoot, executionId });
      } catch (e) {
        if (e?.code === "SUBAGENT_SUCCESSOR_COMPOSITION_INVALID") throw e;
        return rest; // composition is best-effort wiring, never an authority gate
      }
    })();
    result = await dg.resumeDurableGraph({ ...composedOpts, persistenceRoot, executionId, rolloverSessionBinding: binding });
  } catch (e) {
    // Frozen §9 cause table: a ledger reconstruction/reservation-continuity
    // failure at successor resume maps onto CROSS_SESSION_BUDGET_RECONSTRUCTION_FAILED.
    // The underlying budget-domain reason is preserved verbatim (fail closed).
    if (e?.code === "BUDGET_AUTHORITY_INVALID") {
      throw budgetHandoverFailure(String(e?.message ?? e).replace(/^BUDGET_AUTHORITY_INVALID:\s*/, ""));
    }
    throw e;
  }
  // ── WP3B — PREDECESSOR RETIREMENT PROGRESSION ──────────────────────────
  // Canonical ordering: ownership committed → ACTIVE_B → B safely resumed →
  // predecessor retirement. B has passed the §13a gate (this closure only
  // runs after resumeDurableGraph accepted the successor binding) and has
  // COMPLETED its era; A's retirement is now publishable (ACTIVE_B →
  // A_RETIRED). Retirement failure never fabricates a B verdict: it is a
  // durable observability failure surfaced on the result envelope.
  let retirementOutcome = null;
  try {
    const verifiedAfter = readCheckpoint(persistenceRoot, executionId);
    const rolloverAfter = verifiedAfter.snapshot.graph?.rollover ?? null;
    const retireId = rolloverAfter?.active_rollover_id
      ?? (rolloverAfter?.state === rb.ROLLOVER_STATES.ACTIVE_B ? (rolloverAfter?.last_rollover_id ?? activeId) : activeId);
    if (retireId) {
      const storeAfter = new RunEvidenceStore({
        root: persistenceRoot, executionId,
        chainId: verifiedAfter.snapshot.chain_id, checkpointId: verifiedAfter.snapshot.checkpoint_id,
      });
      storeAfter.init();
      const retired = await rc.publishARetirement({
        root: persistenceRoot, executionId, store: storeAfter, rolloverId: retireId,
      });
      retirementOutcome = retired.ok ? { retired: true, rolloverId: retireId } : { retired: false, rolloverId: retireId };
    }
  } catch (e) {
    retirementOutcome = { retired: false, reason: String(e?.code ?? e?.message ?? e).slice(0, 160) };
  }
  if (result && typeof result === "object") {
    result.predecessorRetirement = retirementOutcome;
  }
  // WP1 multi-session continuity — real-terminal reclaim for the LAST era.
  // The handover branch inside resumeDurableGraph returns before its own
  // reclaim whenever the mirror is still OWNERSHIP_TRANSFER_COMMITTED at the
  // era's terminal (the retirement progression above advances it only after
  // the return). This era published ITS OWN terminal verdict（RUN_PASSED /
  // RUN_HELD journaled; final_verdict pinned）and the mirror is now
  // closed-era — no successor era will consume the shared results, so the
  // owned scratch child is reclaimable under the durable authority token.
  try {
    const finalVerdictPinned = readCheckpoint(persistenceRoot, executionId).snapshot?.final_verdict ?? null;
    const closedEra = readCheckpoint(persistenceRoot, executionId).snapshot?.graph?.rollover?.state;
    const CLOSED = new Set(["A_RETIRED", "A_RETIREMENT_CONFIRMED"]);
    if (finalVerdictPinned && CLOSED.has(closedEra)) {
      const ownershipArtifact = JSON.parse(readFileSync(join(persistenceRoot, executionId, "artifacts", "scratch-ownership.json"), "utf8"));
      const { removeOwnedScratchRoot } = await import("../runtime/scratch-ownership.mjs");
      const scratchRootForReclaim = rest.scratchRoot ?? null;
      if (typeof scratchRootForReclaim === "string" && scratchRootForReclaim.length > 0) {
        try {
          removeOwnedScratchRoot({ scratchRoot: scratchRootForReclaim, executionId, repoPath: rest.repoPath ?? null, authorityToken: ownershipArtifact.authorityToken });
        } catch { /* best-effort: the terminal verdict is already published */ }
      }
    }
  } catch { /* best-effort observability; never fabricates a verdict */ }
  return result;
}

// ── WP2 — THE CANONICAL ROLLOVER EXECUTOR FACTORY (single definition) ──────
// Authority inputs (closed set): the frozen admission record (threshold +
// rollover config + provider_binding), durable checkpoint truth
// (CURRENT.rollover owner/candidate), the canonical rollover production
// wiring (THIS module), the spawn registry capability row matching the
// admitted binding. A caller- or environment-supplied executor is NEVER
// accepted (the key is fenced in AUTHORITY_SEAM_RUNNER_KEYS at the
// admission gate and AUTHORITATIVE_RUN_KEYS at the coordinator; both the
// fresh durable path and the successor resume path inject THIS derived
// closure internally). Provider identity is the admitted provider_binding.
//
// MULTI-SESSION REPAIR-1 R2 — current owner session identity: the source
// identity presented at rollover intake MUST be the durable owner-of-record
// of the CURRENT era, not the original generation-0 source. Derivation:
//   mirror.owner present (post-first-transfer era)
//     → opaqueSessionId from mirror.candidate.identity (the REAL spawned
//       session file identity of the CURRENT owner),
//       cross-checked: sessionIdentityDigest({...candidate, generation:
//       owner.session_generation}) == owner.session_identity_digest
//       == transfers[active|last].to.sessionIdentityDigest (fail closed on
//       any mismatch — a stale/tampered candidate never presents identity)
//   mirror.owner absent (generation 0)
//     → admitted generation-0 source identity
//       (cfg.source_session_id ?? executionId — unchanged legacy behavior)
// No ambiguous fallback chain: either the durable owner identity re-derives
// exactly, or the executor refuses to trigger (never presents a stale id).

/**
 * REPAIR-1 R2 — derive the CURRENT owner-of-record source identity for ONE
 * rollover intake from durable mirror truth.
 *
 *   mirror.owner present (post-first-transfer era)
 *     → opaqueSessionId from mirror.candidate.identity (the REAL spawned
 *       session file identity of the CURRENT owner), cross-checked:
 *       sessionIdentityDigest({...candidate, generation:
 *       owner.session_generation}) == owner.session_identity_digest
 *       == transfers[active|last].to.sessionIdentityDigest — fail closed on
 *       any mismatch (a stale/tampered candidate never presents identity).
 *   mirror.owner absent (generation 0)
 *     → the admitted generation-0 source identity
 *       (cfg.source_session_id ?? executionId — unchanged legacy behavior).
 *
 * No ambiguous fallback chain: either the durable owner identity re-derives
 * exactly, or the intake is refused (never a stale source id).
 *
 * @param {object} p
 * @param {object|null} p.mirror — CURRENT graph.rollover mirror
 * @param {object} p.bound — canonicalized admitted provider binding value
 * @param {object} p.cfg — admission extensions.rollover config
 * @param {string} p.executionId — the durable execution id (generation-0
 *   fallback basis only)
 * @returns {{ ok: true, sourceIdentity: object }
 *          | { ok: false, code: string, reason: string }}
 */
export function deriveCurrentOwnerSourceIdentity({ mirror, bound, cfg, executionId }) {
  const owner = mirror?.owner ?? null;
  if (owner && typeof owner.session_identity_digest === "string"
      && Number.isInteger(owner.session_generation)) {
    const transferId = mirror.active_rollover_id ?? mirror.last_rollover_id ?? null;
    const transfer = transferId ? (mirror.transfers?.[transferId] ?? null) : null;
    const candidate = mirror.candidate?.identity ?? null;
    if (!transfer || !candidate || typeof candidate.opaqueSessionId !== "string") {
      return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID",
        reason: "current owner era cannot re-derive its spawn identity from durable truth (refusing to present a stale source identity)" };
    }
    const ownerDigest = sessionIdentityDigest({
      adapterKind: bound.adapterKind,
      providerKind: bound.providerKind,
      opaqueSessionId: candidate.opaqueSessionId,
      sessionGeneration: owner.session_generation,
    });
    if (ownerDigest !== owner.session_identity_digest
        || ownerDigest !== transfer.to.sessionIdentityDigest) {
      return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID",
        reason: "durable owner-of-record does not re-derive from the recorded spawn candidate (tampered/mismatched mirror)" };
    }
    return { ok: true, sourceIdentity: {
      adapterKind: bound.adapterKind,
      providerKind: bound.providerKind,
      opaqueSessionId: candidate.opaqueSessionId,
      sessionGeneration: owner.session_generation,
    } };
  }
  return { ok: true, sourceIdentity: {
    adapterKind: bound.adapterKind,
    providerKind: bound.providerKind,
    opaqueSessionId: String(cfg.source_session_id ?? executionId),
    sessionGeneration: Number(mirror?.owner?.session_generation ?? 0),
  } };
}

/**
 * Derive THE canonical rollover executor for ONE execution.
 * @param {object} p
 * @param {object} p.admission — the frozen admission record
 * @returns {Promise<Function|null>} the authorized executor, or null when
 *   rollover is not configured on the admission (rollover remains inert —
 *   the exact legacy same-session semantics).
 */
export async function deriveCanonicalRolloverExecutor({ admission }) {
  const cfg = admission?.extensions?.rollover ?? null;
  if (!cfg || cfg.enabled !== true) return null;
  return async function canonicalRolloverRequestExecutor(runner) {
    // The trigger authority is the RUNNER'S DURABLE OBSERVATION (produced by
    // the WP1 producer inside the durable graph's between-phase hooks from
    // provider-reported usage). No observation ⇒ no rollover: A continues if
    // otherwise legal (WP1 failure policy — never a fabricated trigger).
    const observation = runner.state?._rolloverObservation ?? null;
    if (!observation || observation.triggered !== true || typeof observation.triggerEvent !== "object") {
      return { ok: true, skipped: true, reason: observation?.reason ?? "no automatic trigger observed" };
    }
    // Window dedup against DURABLE truth: exactly one eligible trigger per
    // rollover window (the in-run _rolloverExecuted flag and the ACTIVE
    // pre-commit fence remain the primary dedupe layers).
    const mirror = (() => {
      try { return readCheckpoint(runner.root, runner.executionId).snapshot.graph?.rollover ?? null; }
      catch { return null; }
    })();
    const sourceGeneration = Number(mirror?.owner?.session_generation ?? 0);
    const eligibility = automaticTriggerEligible({ rolloverBlock: mirror, sourceGeneration });
    if (!eligibility.eligible) {
      return { ok: true, skipped: true, reason: eligibility.reason };
    }
    const bound = admittedProviderBinding(runner.admission ?? admission);
    if (!bound.ok) {
      return { ok: false, code: bound.code, reason: bound.reason };
    }
    // Durable-truth source identity (REPAIR-1 R2) — THE single derivation
    const ident = deriveCurrentOwnerSourceIdentity({
      mirror, bound: bound.value, cfg, executionId: runner.executionId,
    });
    if (!ident.ok) {
      return { ok: false, code: ident.code, reason: ident.reason };
    }
    const intake = createRolloverIntake({
      triggerEvent: observation.triggerEvent,
      sourceIdentity: ident.sourceIdentity,
      rsl3SurfaceDir: cfg.rsl3_surface_dir ?? null,
      requireEcho: cfg.require_echo !== false,
    });
    return intake.run(runner);
  };
}
