// src/learning/transfer-metrics/identities.mjs
//
// Adapters over existing admission / lifecycle / fingerprint / evidence identities.
// Transfer events copy those identities; they never mint a parallel namespace.

import { AUTHORITY_DOMAIN, TRANSFER_CODES, TransferMetricsError, digestOf, isHex64, PRINCIPAL_ROLES, SCHEMA_VERSION } from "./schema.mjs";
import { randomBytes } from "node:crypto";
export {
  INCIDENT_OBS_SCHEMA,
  SOURCE_IDENTITY_DOMAIN,
  INCIDENT_ID_DOMAIN,
  EVIDENCE_SET_DOMAIN,
  INCIDENT_SOURCE_CLASSES,
  INCIDENT_OBSERVED_OUTCOME_CLASSES,
  INCIDENT_COMPLETENESS_WRITE_CLASSES,
  deriveSourceIdentityKey,
  deriveIncidentId,
  deriveEvidenceSetDigest,
  normalizeIncidentEvidenceRefs,
  applyIncidentObservedProfile,
  assertIncidentDerivedIdentities,
} from "./schema.mjs";
function fail(code, message, details) {
  throw new TransferMetricsError(code, message, details);
}

const MINTED_PRINCIPALS = new WeakSet();

/**
 * Capability-bearing principal. Role strings copied from JSON/env/spread
 * objects are not capabilities and fail closed at the writer.
 */
export function mintPrincipal({ identity, role } = {}) {
  if (typeof identity !== "string" || identity.length === 0) {
    fail(TRANSFER_CODES.AUTHORITY_FORGED, "principal.identity required");
  }
  if (!PRINCIPAL_ROLES.includes(role)) {
    fail(TRANSFER_CODES.AUTHORITY_FORGED, `unknown principal.role ${role}`);
  }
  const principal = Object.freeze({ identity, role });
  MINTED_PRINCIPALS.add(principal);
  return principal;
}

export function isMintedPrincipal(principal) {
  return principal != null && MINTED_PRINCIPALS.has(principal);
}

export function assertMintedPrincipal(principal) {
  if (!isMintedPrincipal(principal)) {
    fail(TRANSFER_CODES.AUTHORITY_FORGED, "principal is not a minted capability");
  }
}

// ---------------------------------------------------------------------------
// Sealed learning-authority issuer capability [R-independent-review B1].
//
// Minted ONLY inside the transfer-metrics module at writer construction.
// Authority flows from possession of the minted object, never from data:
// the brand symbol is NON-ENUMERABLE, so JSON serialization, spread, and
// Object.assign all lose the capability, structuredClone THROWS on symbol
// keys, and the module-private WeakSet rejects every unminted object. The
// per-issuer random brand value also makes issuer_principal_digest
// instance-unique: a writer validates an issuer by digest equality against
// ITS OWN held issuer, so cross-writer/cross-log/cross-project issuers fail
// AUTHORITY_ISSUER_FORGED, and a generation-mismatched binding fails
// AUTHORITY_STALE_GENERATION.
// ---------------------------------------------------------------------------

const AUTHORITY_ISSUER_BRAND = Symbol("autoloop.transfer-metrics.authority-issuer");
const MINTED_AUTHORITY_ISSUERS = new WeakSet();

export function mintWriterAuthorityIssuer({ storageRoot, authorityGeneration = 0, revocationGeneration = 0 } = {}) {
  if (typeof storageRoot !== "string" || storageRoot.length === 0) {
    fail(TRANSFER_CODES.AUTHORITY_ISSUER_FORGED, "authority issuer storageRoot required");
  }
  const issuer = {};
  Object.defineProperties(issuer, {
    authority_domain: { value: AUTHORITY_DOMAIN, enumerable: true },
    storage_root: { value: storageRoot, enumerable: true },
    authority_generation: { value: authorityGeneration, enumerable: true },
    revocation_generation: { value: revocationGeneration, enumerable: true },
  });
  Object.defineProperty(issuer, AUTHORITY_ISSUER_BRAND, {
    value: randomBytes(32).toString("hex"),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.freeze(issuer);
  MINTED_AUTHORITY_ISSUERS.add(issuer);
  return issuer;
}

export function isMintedAuthorityIssuer(issuer) {
  return issuer != null
    && typeof issuer === "object"
    && MINTED_AUTHORITY_ISSUERS.has(issuer)
    && typeof issuer[AUTHORITY_ISSUER_BRAND] === "string";
}

export function assertAuthorityIssuerCapability(issuer) {
  if (!isMintedAuthorityIssuer(issuer)) {
    fail(TRANSFER_CODES.AUTHORITY_ISSUER_FORGED, "issuer is not a minted learning-authority capability");
  }
}

export function authorityIssuerPrincipalDigest(issuer) {
  assertAuthorityIssuerCapability(issuer);
  return digestOf({
    domain: AUTHORITY_DOMAIN,
    brand: issuer[AUTHORITY_ISSUER_BRAND],
    authority_domain: issuer.authority_domain,
    storage_root: issuer.storage_root,
    authority_generation: issuer.authority_generation,
    revocation_generation: issuer.revocation_generation,
  });
}

/**
 * Fixture / measurement identity binder.
 * Production CORE-1 never constructs a writer; tests inject known identities.
 * Live admission/lifecycle/fingerprint remain the authority — this adapter only
 * fail-closes when a cited identity is absent or drifted.
 */
export function createIdentityBinder({
  tasks = new Map(),
  attempts = new Map(),
  projects = new Map(),
  evidence = new Set(),
  truthGenerations = new Map(),
  lifecycleTimes = new Map(),
  lifecycleTerminals = new Map(),
  requireEvidenceInventory = false,
} = {}) {
  return {
    bindTask(taskIdentity) {
      const known = tasks.get(taskIdentity.task_id);
      if (!known) fail(TRANSFER_CODES.TASK_UNBOUND, `unknown task_id ${taskIdentity.task_id}`);
      if (known.admission_id !== taskIdentity.admission_id) {
        fail(TRANSFER_CODES.ADMISSION_DRIFT, "admission_id does not match frozen admission");
      }
    },
    bindAttempt(attemptIdentity) {
      const known = attempts.get(attemptIdentity.execution_id);
      if (!known) fail(TRANSFER_CODES.ATTEMPT_UNBOUND, `unknown execution_id ${attemptIdentity.execution_id}`);
      const allowed = known.attempts instanceof Set ? known.attempts : new Set(known.attempts ?? []);
      if (!allowed.has(attemptIdentity.attempt)) {
        fail(TRANSFER_CODES.ATTEMPT_UNBOUND, `attempt ${attemptIdentity.attempt} not a lifecycle transition`);
      }
    },
    bindProject(projectIdentity) {
      const known = projects.get(projectIdentity.repository_root_identity);
      if (!known) {
        fail(TRANSFER_CODES.PROJECT_UNBOUND, "project_identity not in C2D fingerprint set");
      }
      if (known.git_common_dir_identity !== projectIdentity.git_common_dir_identity) {
        fail(TRANSFER_CODES.PROJECT_UNBOUND, "git_common_dir_identity mismatch");
      }
    },
    bindEvidence(refs) {
      for (const ref of refs ?? []) {
        if (!isHex64(ref.digest)) {
          fail(TRANSFER_CODES.EVIDENCE_MISSING, "evidence digest not 64-hex");
        }
        if (requireEvidenceInventory && !evidence.has(ref.digest)) {
          fail(TRANSFER_CODES.EVIDENCE_MISSING, "evidence digest not in inventory");
        }
      }
    },
    citedTruthGeneration(key) {
      if (!key) return null;
      return truthGenerations.has(key) ? truthGenerations.get(key) : null;
    },
    lifecycleTime(executionId) {
      return lifecycleTimes.get(executionId) ?? null;
    },
    lifecycleTerminal(executionId) {
      return lifecycleTerminals.get(executionId) ?? null;
    },
  };
}

/**
 * Sole legal production-shaped path for OUTCOME_OBSERVED.
 * Copies lifecycle-runner terminal {final, attempt, executionId}.
 * Cannot be used by executor principals.
 */
export function createLifecycleOutcomeAdapter({ writer, principal, lifecycleResult }) {
  if (!writer) fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "lifecycle adapter requires writer");
  assertMintedPrincipal(principal);
  if (!principal || principal.role !== "system") {
    fail(TRANSFER_CODES.AUTHORITY_INSUFFICIENT, "lifecycle adapter principal.role must be system");
  }
  if (!lifecycleResult || !["PASS", "HOLD"].includes(lifecycleResult.final)) {
    fail(TRANSFER_CODES.OUTCOME_MISMATCH, "lifecycle adapter requires terminal PASS|HOLD");
  }
  return {
    recordTerminalOutcome(eventPartial = {}) {
      const executionId = lifecycleResult.executionId;
      const attempt = lifecycleResult.attempt;
      const final = lifecycleResult.final;
      const payload = {
        ...(eventPartial.payload ?? {}),
        final,
        hold_code: eventPartial.payload?.hold_code ?? lifecycleResult.holdCode ?? null,
        repair_attempts: eventPartial.payload?.repair_attempts ?? lifecycleResult.repair_attempts ?? 0,
        evidence_manifest_digest: eventPartial.payload?.evidence_manifest_digest,
      };
      return writer.appendTransferEvent({
        event: {
          schema_version: SCHEMA_VERSION,
          ...eventPartial,
          event_type: "OUTCOME_OBSERVED",
          attempt_identity: { execution_id: executionId, attempt },
          outcome_ref: { execution_id: executionId, final, attempt },
          payload,
          authority: { identity: principal.identity, role: "system" },
        },
        principal,
      });
    },
  };
}
