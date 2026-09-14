// src/rollover/session-spawn.mjs
//
// STAGE D — core side of the spawn adapter boundary (CONTRACT §8 /
// ADAPTER-INVENTORY.md §6 spawn-contract). The core calls exactly one
// function on the projected adapter: spawnSuccessorSession(request).
//
// Core duties here (authority NEVER leaves the core):
//   - request schema validation (assertAdapterRequest-style strictness)
//   - unknown kind fails closed BEFORE any provider call
//   - durable-spawn corroboration: the coordinator journaled a spawn_dispatch
//     evidence event BEFORE dispatch; the accepted receipt MUST reference that
//     event id with a matching bound sequence (GAP-1 fence, T69)
//   - P3 receipt digest re-derivation from returned fields
//   - duplicate/conflicting receipt fencing (K4/K5)
//
// Adapter duties (projection only): start a REAL provider session in
// quarantine mode and return its REAL identity — or an explicit declined
// status. The adapter cannot mint authority, mutate checkpoints, transfer
// ownership or declare ACK-readiness: those functions do not exist on its
// interface.

import {
  validateCanonicalSessionIdentityFields,
  deriveSpawnReceiptDigest,
} from "./rollover-authority.mjs";
import { knownAdapterPairKeys, resolveSpawnAdapter } from "./spawn-registry.mjs";

export const SPAWN_REQUEST_SCHEMA_VERSION = 1;

const SPAWN_RESULT_STATUSES = ["spawned", "error", "timed_out", "aborted"];

/**
 * Validate the frozen spawn request shape.
 * request := { schemaVersion, adapterKind, providerKind, rolloverId,
 *              expectedTargetGeneration, checkpointLocator{root,executionId},
 *              checkpointDigest, taskIdentity, runIdentity, admissionIdentity,
 *              authorityDecisionDigest, spawnDispatchEventId }
 */
export function validateSpawnRequest(request) {
  if (!request || typeof request !== "object") {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "spawn request missing" };
  }
  if (request.schemaVersion !== SPAWN_REQUEST_SCHEMA_VERSION) {
    return { ok: false, code: "CROSS_SESSION_ROLLOVER_SCHEMA_UNSUPPORTED", reason: `schemaVersion ${String(request.schemaVersion)} unsupported` };
  }
  // NOTE: spawnDispatchEventId is injected by the CORE from the pre-journaled
  // evidence event (durable-spawn corroboration) — never a caller input.
  for (const f of ["adapterKind", "providerKind", "rolloverId", "checkpointDigest", "taskIdentity", "runIdentity", "admissionIdentity", "authorityDecisionDigest"]) {
    const v = request[f];
    if (typeof v !== "string" || v.length === 0) {
      return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: `spawn request field ${f} must be non-empty string` };
    }
  }
  if (!Number.isInteger(request.expectedTargetGeneration) || request.expectedTargetGeneration < 1) {
    return { ok: false, code: "CROSS_SESSION_GENERATION_MISMATCH", reason: "expectedTargetGeneration must be positive integer" };
  }
  const loc = request.checkpointLocator;
  if (!loc || typeof loc !== "object" || typeof loc.root !== "string" || typeof loc.executionId !== "string") {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "checkpointLocator{root,executionId} required" };
  }
  if (!knownAdapterPairKeys().has(`${request.adapterKind}\u0000${request.providerKind}`)) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_ADAPTER_UNKNOWN", reason: `${request.adapterKind}/${request.providerKind} not in frozen registry` };
  }
  return { ok: true };
}

function identityKnownPairs() {
  return knownAdapterPairKeys();
}

/**
 * Core-side spawn coordination. Performs NO provider I/O itself: resolves the
 * registered factory and enforces the contract around it.
 *
 * @param {object} p
 * @param {object} p.request — validated spawn request (see validateSpawnRequest)
 * @param {object} p.evidenceEvent — { event_id, sequence } of the pre-journaled
 *   spawn_dispatch evidence event (durable-spawn corroboration anchor)
 * @returns {{ok:true, identity, spawnReceiptDigest, startedAt}|{ok:false, code, reason}}
 */
export async function coordinateSuccessorSpawn({ request, evidenceEvent }) {
  const gate = validateSpawnRequest(request);
  if (!gate.ok) return gate;
  if (!evidenceEvent || typeof evidenceEvent.event_id !== "string" || evidenceEvent.event_id.length === 0
      || !Number.isInteger(evidenceEvent.sequence)) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "spawn_dispatch evidence event anchor required before dispatch" };
  }

  const resolved = resolveSpawnAdapter({ adapterKind: request.adapterKind, providerKind: request.providerKind });
  if (!resolved.ok) return resolved;

  let result;
  try {
    result = await resolved.factory({
      ...request,
      spawnDispatchEventId: evidenceEvent.event_id,
    });
  } catch (e) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_SPAWN_FAILED", reason: `adapter threw: ${String(e?.message ?? e).slice(0, 200)}` };
  }

  if (!result || typeof result !== "object" || !SPAWN_RESULT_STATUSES.includes(result.status)) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_SPAWN_FAILED", reason: "adapter result missing/unknown status" };
  }
  if (result.status !== "spawned") {
    // Explicit declined/failure status — lawful abort path, never adopted.
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_SPAWN_FAILED", reason: String(result.error ?? result.status).slice(0, 200) };
  }
  if (result.omitCorroboration === true) {
    // Identity-without-spawn fence (T69): a "spawned" status without durable
    // corroboration of a real provider session is never adoptable.
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "spawned status without durable-spawn session corroboration" };
  }

  // Identity validation against the registry data + P3 re-derivation.
  // The adapter returns the RAW identity triple only — generation is a CORE
  // allocation (g+1 exists only inside a committed transfer). Validate the
  // triple's structure/kinds, then bind expectedTargetGeneration as THE
  // generation for every durable record.
  const iv = validateCanonicalSessionIdentityFields(
    { ...result.identity, sessionGeneration: request.expectedTargetGeneration },
    identityKnownPairs(),
  );
  if (result.identity.sessionGeneration !== undefined
      && result.identity.sessionGeneration !== request.expectedTargetGeneration) {
    return { ok: false, code: "CROSS_SESSION_GENERATION_MISMATCH", reason: "adapter attempted to allocate sessionGeneration (core-only authority)" };
  }
  if (result.identity.adapterKind !== request.adapterKind || result.identity.providerKind !== request.providerKind) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "returned identity kind pair differs from the requested projection" };
  }
  const expectedDigest = deriveSpawnReceiptDigest({
    rolloverId: request.rolloverId,
    expectedTargetGeneration: request.expectedTargetGeneration,
    targetAdapterKind: request.adapterKind,
    targetProviderKind: request.providerKind,
    opaqueSessionId: result.identity.opaqueSessionId,
    startedAt: result.startedAt,
  });
  if (result.spawnReceiptDigest !== undefined && result.spawnReceiptDigest !== expectedDigest) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "P3 receipt digest mismatch (forged/altered receipt)" };
  }
  if (!Number.isFinite(Date.parse(String(result.startedAt)))) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "startedAt not ISO-8601" };
  }

  return {
    ok: true,
    identity: result.identity,
    startedAt: result.startedAt,
    spawnReceiptDigest: expectedDigest,
    boundEventSequence: evidenceEvent.sequence,
    spawnDispatchEventId: evidenceEvent.event_id,
    // Non-authoritative quarantine-channel acknowledgment carrier (may be
    // empty for scripted fixtures); authority stays with core recomputation.
    replyText: typeof result.replyText === "string" ? result.replyText : "",
  };
}

/**
 * K2/K5 fence: one successor candidate per rolloverId. A second receipt for
 * the same rolloverId is either an identical retry (identical P3 field set ⇒
 * idempotent no-op) or a conflicting candidate (fail closed + abort).
 */
export function reconcileCandidateReceipt({ existingReceipt, incoming }) {
  if (!existingReceipt) return { ok: true, adopted: true };
  const fields = (r) => [r.spawnReceiptDigest, r.identity?.opaqueSessionId, r.startedAt].join("\u0000");
  if (fields(existingReceipt) === fields(incoming)) {
    return { ok: true, adopted: false }; // identical duplicate → no-op
  }
  return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "conflicting second candidate for the same rolloverId (K5)" };
}

/**
 * Quarantine attestation binding check (pre-ACK): B's attestation must carry
 * exactly the spawned identity digest and recomputed validationDigest.
 */
export function verifyQuarantineAttestation({ attestation, spawnedIdentityDigest, expectedValidationDigest }) {
  if (!attestation || typeof attestation !== "object") {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_VALIDATION_FAILED", reason: "quarantine attestation missing" };
  }
  if (attestation.sessionIdentityDigest !== spawnedIdentityDigest) {
    return { ok: false, code: "CROSS_SESSION_ACK_INVALID", reason: "attestation bound to a different session identity than the spawned candidate" };
  }
  if (attestation.validationDigest !== expectedValidationDigest) {
    return { ok: false, code: "CROSS_SESSION_ACK_INVALID", reason: "attestation validationDigest does not recompute from durable facts" };
  }
  return { ok: true };
}
