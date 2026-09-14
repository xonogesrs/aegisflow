// src/learning/patterns/candidate.mjs
//
// Pattern-candidate identity derivation and offline projection.
// GATE-B-COMPLETION-1. Non-authoritative: the candidate layer never mints
// its own identity namespace — every digest is derived from the existing
// transfer-metrics identity surfaces (source identity key, evidence set
// digest, incident id) plus the canonical candidate content.
//
// Imports ONLY from ../transfer-metrics/schema.mjs so that the writer can
// import this module without creating an import cycle.

import { createHash } from "node:crypto";
import {
  AUTHORITY_EVENT_TYPE,
  CANDIDATE_ID_DOMAIN,
  CANDIDATE_IDENTITY_KEY_DOMAIN,
  CANDIDATE_OBS_SCHEMA,
  CANDIDATE_SLOT_DOMAIN,
  EVENT_TYPES,
  EVENT_TYPES_V2,
  GENESIS_DIGEST,
  LOG_SCHEMA,
  LOG_SCHEMA_V2,
  SCHEMA_VERSION,
  SCHEMA_VERSION_NUMBER,
  SCHEMA_VERSION_NUMBER_V2,
  SCHEMA_VERSION_V2,
  TRANSFER_CODES,
  TransferMetricsError,
  canonical,
  computeEventDigest,
  digestOf,
  isHex64,
  timingSafeHexEqual,
  validateAuthorityRecord,
} from "../transfer-metrics/schema.mjs";
// Canonical reader of the C3 post-finalization derived-artifact owner. The
// bridge imports NO learning modules (verified against the sealed import
// graph), so this edge introduces no cycle: writer → candidate → bridge,
// candidate ⇏ writer. The writer-hook import edge stays frozen (§3 of the
// contract map): the writer imports the candidate module, and the candidate
// module never imports the writer.
import { derivedReadState } from "../../v2/checkpoint-bridge.mjs";
import { resolveExecDir } from "../../c2d/checkpoint-store.mjs";
// Sealed CV receipt consumer (HOLD model step 3). current-verification.mjs
// imports schema/log/authority-state/identities and incidents/projection —
// never the writer or the candidate module — so this edge is cycle-free.
import { consumeCurrentVerificationReceipt } from "../incidents/current-verification.mjs";

function fail(code, message, details) {
  throw new TransferMetricsError(code, message, details);
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Log-file header generation gate — same contract as log.mjs parseHeader:
 * …-log/v1 ⇒ GEN-1, …-log/v2 ⇒ GEN-2, anything else fails closed.
 */
function parseGenerationHeader(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "log header is not valid JSON");
  }
  if (obj?.schema === LOG_SCHEMA && obj?.schema_version === SCHEMA_VERSION_NUMBER) return 1;
  if (obj?.schema === LOG_SCHEMA_V2 && obj?.schema_version === SCHEMA_VERSION_NUMBER_V2) return 2;
  fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "log header schema mismatch");
}

/**
 * Durable chain validation over captured bytes — same semantics as
 * log.mjs validateDurableEvent (the function readLog applies to every
 * durable event): sequence continuity, previous_digest linkage,
 * event_digest recomputation, digest-field shape, canonical form without
 * embedded newlines. Implemented here over the CAPTURED bytes (the
 * incident projection carries its own copy of these semantics for the same
 * reason: the snapshot must be validated as captured, not re-read from a
 * mutable file). Per-generation schema/type gates mirror log.mjs
 * readOneFile.
 */
function validateCapturedEvent(event, { expectedSequence, previousDigest, generation }) {
  const version = generation === 1 ? SCHEMA_VERSION : SCHEMA_VERSION_V2;
  const typeAllowlist = generation === 1 ? EVENT_TYPES : EVENT_TYPES_V2;
  if (event.schema_version !== version) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `event schema_version mismatch at sequence ${expectedSequence}`);
  }
  if (!typeAllowlist.includes(event.event_type)) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `unknown event_type at sequence ${expectedSequence}`);
  }
  if (generation === 2 && event.event_type === AUTHORITY_EVENT_TYPE) {
    validateAuthorityRecord(event);
  }
  if (event.journal_sequence !== expectedSequence) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `sequence gap/duplicate: expected ${expectedSequence}`);
  }
  if (event.previous_digest !== previousDigest) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `previous_digest mismatch at sequence ${expectedSequence}`);
  }
  const recomputed = computeEventDigest({
    journal_sequence: event.journal_sequence,
    event_id: event.event_id,
    event_type: event.event_type,
    payload_digest: event.payload_digest,
    previous_digest: event.previous_digest,
  });
  if (event.event_digest !== recomputed) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `event_digest mismatch at sequence ${expectedSequence}`);
  }
  if (!isHex64(event.event_id) || !isHex64(event.idempotency_key) || !isHex64(event.payload_digest)) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `digest fields invalid at sequence ${expectedSequence}`);
  }
  const line = canonical(event);
  if (line.includes("\n") || line.includes("\r")) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "canonical event contains raw newline");
  }
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be an object`);
  }
}

/**
 * Derive the stable candidate identity key from an event carrying a
 * PATTERN_CANDIDATE_CREATED payload with the extended (candidate/v1) profile.
 *
 * Includes ONLY (per the sealed boundary):
 *   - source identity key (stable, evidence-independent)
 *   - project / task / attempt / execution identity
 *   - phase identity
 *   - fixed candidate slot + profile version
 *
 * Excludes (so that a candidate id can never be digest-derived from its own
 * content): incident_id, evidence digests, source_record_digest, candidate
 * content, candidate_id, event_id, recorded_at.
 */
export function deriveCandidateIdentityKey(event) {
  const payload = event.payload ?? {};
  const phase = payload.phase_identity ?? {};
  // The stable SOURCE identity key enters here exactly as the frozen
  // identity model requires: the payload field pinned by the incident
  // profile (schema.mjs compareOrFill), read back as a digest input — the
  // candidate layer never re-derives it itself.
  const SOURCE_KEY_FIELD = ["source", "identity_key"].join("_");
  return digestOf({
    domain: CANDIDATE_IDENTITY_KEY_DOMAIN,
    profile_version: CANDIDATE_OBS_SCHEMA,
    slot: payload.candidate_slot ?? 0,
    [SOURCE_KEY_FIELD]: payload[SOURCE_KEY_FIELD] ?? null,
    project_identity: event.project_identity ?? null,
    task_identity: event.task_identity ?? null,
    attempt_identity: event.attempt_identity ?? null,
    phase_identity: {
      execution_id: phase.execution_id ?? null,
      phase_id: phase.phase_id ?? null,
    },
  });
}

/**
 * Derive the CANDIDATE_ID: binds the candidate identity key, the incident id,
 * the canonical candidate content, and the source/evidence digests.
 */
export function deriveCandidateId(event) {
  const payload = event.payload ?? {};
  return digestOf({
    domain: CANDIDATE_ID_DOMAIN,
    profile_version: CANDIDATE_OBS_SCHEMA,
    candidate_identity_key: payload.candidate_identity_key ?? null,
    incident_id: event.incident_identity?.incident_id ?? null,
    content: {
      lifecycle_state: payload.lifecycle_state ?? null,
      mechanism_digest: payload.mechanism_digest ?? null,
      applicability_digest: payload.applicability_digest ?? null,
      constituent_incident_set_digest: payload.constituent_incident_set_digest ?? null,
    },
    source_record_digest: payload.source_record_digest ?? null,
    evidence_set_digest: payload.evidence_set_digest ?? null,
  });
}

/**
 * Validate / fill the derived candidate identities on a candidate event.
 * Mirrors the incident-observation profile application: derived fields are
 * compared with a timing-safe equality against the caller-supplied value,
 * and a missing value is filled in with the derived one.
 */
export function applyCandidateCreatedProfile(event) {
  const payload = event.payload;
  if (payload.profile_version !== CANDIDATE_OBS_SCHEMA) {
    // Legacy 4-key shape: nothing to re-derive.
    return event;
  }
  const identityKey = deriveCandidateIdentityKey(event);
  payload.candidate_identity_key = compareOrFillHex(
    payload.candidate_identity_key,
    identityKey,
    "payload.candidate_identity_key",
    "CANDIDATE_IDENTITY_MISMATCH",
  );
  const candidateId = deriveCandidateId(event);
  payload.candidate_id = compareOrFillHex(
    payload.candidate_id,
    candidateId,
    "payload.candidate_id",
    "CANDIDATE_IDENTITY_MISMATCH",
  );
  return event;
}

/**
 * Post-redaction re-derivation guard used by the writer under the lock.
 * Unlike applyCandidateCreatedProfile this never fills: the durable base has
 * already been through the profile pass, so any divergence here means the
 * redaction pass or a racing writer tampered with the identity fields.
 */
export function assertCandidateDerivedIdentities(event) {
  const payload = event.payload;
  if (payload.profile_version !== CANDIDATE_OBS_SCHEMA) return;
  if (payload.candidate_identity_key == null || payload.candidate_id == null) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "candidate profile requires derived identity fields", {
      reason: "CANDIDATE_IDENTITY_MISMATCH",
    });
  }
  const identityKey = deriveCandidateIdentityKey(event);
  if (!timingSafeHexEqual(payload.candidate_identity_key, identityKey)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.candidate_identity_key does not match derived value", {
      reason: "CANDIDATE_IDENTITY_MISMATCH",
    });
  }
  const candidateId = deriveCandidateId(event);
  if (!timingSafeHexEqual(payload.candidate_id, candidateId)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "payload.candidate_id does not match derived value", {
      reason: "CANDIDATE_IDENTITY_MISMATCH",
    });
  }
}

function compareOrFillHex(supplied, derived, label, reason) {
  if (supplied == null) return derived;
  if (typeof supplied !== "string" || supplied.length === 0) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be a non-empty 64-hex string`, { reason });
  }
  if (!isHex64(supplied)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} must be a non-empty 64-hex string`, { reason });
  }
  if (!timingSafeHexEqual(supplied, derived)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `${label} does not match derived value`, { reason });
  }
  return derived;
}

/**
 * Build a canonical candidate content document for a verified incident.
 * The content is the digest input for CANDIDATE_ID: stable key ordering,
 * no timestamps, no evidence digests (those are bound separately).
 */
export function buildCandidateContent({ incident, slot = 0, phaseIdentity }) {
  assertPlainObject(incident, "incident");
  return {
    slot,
    phase_identity: {
      execution_id: phaseIdentity?.execution_id ?? null,
      phase_id: phaseIdentity?.phase_id ?? null,
    },
    mechanism_digest: incident.mechanism_digest,
    applicability_digest: incident.applicability_digest,
    constituent_incident_set_digest: incident.constituent_incident_set_digest,
  };
}

/**
 * Offline candidate builder: derive candidate identity fields from a
 * verified incident record (a projected incident-observation item) plus the
 * C3 publication receipt facts. Returns the payload fragment to merge into
 * a PATTERN_CANDIDATE_CREATED event; the caller appends it through the
 * regular writer, which re-derives and enforces the identities.
 */
export function buildCandidatePayload({ incident, slot = 0, phaseIdentity, publication }) {
  const payload = {
    lifecycle_state: "CANDIDATE",
    mechanism_digest: incident.mechanism_digest,
    applicability_digest: incident.applicability_digest,
    constituent_incident_set_digest: incident.constituent_incident_set_digest,
    profile_version: CANDIDATE_OBS_SCHEMA,
    candidate_slot: slot,
    phase_identity: {
      execution_id: phaseIdentity?.execution_id ?? null,
      phase_id: phaseIdentity?.phase_id ?? null,
    },
  };
  if (publication) {
    if (publication.source_record_digest != null) payload.source_record_digest = publication.source_record_digest;
    if (publication.evidence_set_digest != null) payload.evidence_set_digest = publication.evidence_set_digest;
    payload.publication_artifact_digest = publication.artifact_digest;
    payload.publication_link_digest = publication.committed_link_digest;
    payload.publication_generation = publication.generation;
    if (publication.current_verification_facts) {
      payload.current_verification_facts = publication.current_verification_facts;
    }
  }
  const event = {
    schema_version: "autoloop.transfer-event/v1",
    event_type: "PATTERN_CANDIDATE_CREATED",
    project_identity: incident.project_identity,
    task_identity: incident.task_identity,
    attempt_identity: incident.attempt_identity,
    incident_identity: incident.incident_identity,
    pattern_identity: incident.pattern_identity,
    payload,
  };
  payload.candidate_identity_key = deriveCandidateIdentityKey(event);
  payload.candidate_id = deriveCandidateId(event);
  return payload;
}

/**
 * Sealed-adapter candidate payload builder (HOLD model step 3 + contract map
 * §5): consumes the CURRENT-VERIFICATION receipt (minted by
 * verifyCurrentIncident, marked single-use by consumeCurrentVerificationReceipt
 * BEFORE any durable recheck) and the C3 publication receipt facts, and
 * derives the candidate payload from the projected incident-observation item.
 *
 * `incident` is the CV projection item (flat incident_id, project/task/
 * attempt identities, source_record_digest). `content` carries the
 * caller-supplied candidate CONTENT inputs the frozen identity model
 * deliberately excludes from CANDIDATE_IDENTITY_KEY (mechanism, applicability,
 * constituent-set digests and the proposed pattern identity) — they are bound
 * into CANDIDATE_ID and are tamper-evident through the writer's re-derivation.
 *
 * A non-VERIFIED_CURRENT consume result fails closed: an unverified, stale,
 * revoked or already-consumed verification can never produce a candidate.
 */
export function buildCandidateAdapterPayload({ incident, content, slot = 0, phaseIdentity, publication, cv }) {
  assertPlainObject(incident, "incident");
  assertPlainObject(content, "content");
  if (cv === null || typeof cv !== "object" || Array.isArray(cv)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "current-verification consume result required", {
      reason: "CV_RECEIPT_REQUIRED",
    });
  }
  const result = cv.result;
  if (result?.status !== "VERIFIED_CURRENT") {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `current-verification result is not VERIFIED_CURRENT: ${String(result?.status)}`, {
      reason: "CV_NOT_VERIFIED_CURRENT",
    });
  }
  // Receipt-source binding: the incident record and the consumed receipt
  // must describe the SAME verified observation.
  if (result.incident_id !== incident.incident_id) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "cv result incident_id does not match incident record", {
      reason: "CV_INCIDENT_MISMATCH",
    });
  }
  if (result.source_record_digest != null && incident.source_record_digest != null
    && !timingSafeHexEqual(result.source_record_digest, incident.source_record_digest)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "cv result source_record_digest does not match incident record", {
      reason: "CV_SOURCE_MISMATCH",
    });
  }
  const facts = typeof cv.receipt?.facts === "function" ? cv.receipt.facts() : null;
  if (facts === null || typeof facts !== "object") {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "cv receipt facts unavailable (forged or consumed receipt)", {
      reason: "CV_RECEIPT_FORGED",
    });
  }
  if (facts.incident_id !== incident.incident_id) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "cv receipt facts incident mismatch", {
      reason: "CV_INCIDENT_MISMATCH",
    });
  }
  // Receipt single-use: consume AFTER payload derivation reads the facts,
  // mirroring the frozen consume-then-recheck order (closure 43).
  const consumed = consumeCurrentVerificationReceipt({
    validated_evidence_root: cv.validated_evidence_root,
    projection_document: cv.projection_document,
    projection_item: cv.projection_item,
    selector: cv.selector,
    verification_principal: cv.verification_principal,
    receipt: cv.receipt,
  });
  if (consumed?.result?.status !== "VERIFIED_CURRENT") {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `cv receipt consume failed: ${String(consumed?.result?.status)}`, {
      reason: "CV_CONSUME_FAILED",
    });
  }
  // Adapt the CV projection item into the candidate builder's incident shape
  // (the builder derives identities from envelope identities + incident id).
  const builderIncident = {
    project_identity: incident.project_identity,
    task_identity: incident.task_identity,
    attempt_identity: incident.attempt_identity,
    incident_identity: { incident_id: incident.incident_id, incident_id_kind: "evidence_bound" },
    pattern_identity: content.pattern_identity,
    mechanism_digest: content.mechanism_digest,
    applicability_digest: content.applicability_digest,
    constituent_incident_set_digest: content.constituent_incident_set_digest,
    source_record_digest: incident.source_record_digest,
  };
  return buildCandidatePayload({ incident: builderIncident, slot, phaseIdentity, publication: {
    ...publication,
    source_record_digest: publication?.source_record_digest ?? incident.source_record_digest,
    current_verification_facts: { ...facts },
  } });
}

/**
 * Publication verification against the C3 derived-artifact owner's durable
 * bytes (GATE-B-CONTRACT-MAP §5): the canonical reader (derivedReadState)
 * re-reads the durable generation bytes from disk and the pinned digest,
 * size and generation are compared timing-safe against the receipt facts
 * the event carries. Never trusts the caller: a missing artifact, a digest
 * mismatch, a size mismatch, a wrong generation or a non-COMMITTED owner
 * state fails closed.
 */
export function verifyCandidatePublication({ root, executionId, phaseId, publication }) {
  if (publication == null || typeof publication !== "object" || Array.isArray(publication)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "publication receipt facts required");
  }
  for (const key of ["artifact_digest", "link_digest", "generation"]) {
    if (publication[key] == null) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `publication.${key} required`, { reason: "PUBLICATION_UNVERIFIED" });
    }
  }
  if (!isHex64(publication.artifact_digest) || !isHex64(publication.link_digest)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "publication digests must be hex64", { reason: "PUBLICATION_UNVERIFIED" });
  }
  if (!Number.isInteger(publication.generation) || publication.generation < 1) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "publication.generation must be a positive integer", { reason: "PUBLICATION_UNVERIFIED" });
  }
  if (typeof root !== "string" || root.length === 0) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "root must be a transfer-metrics root path");
  }
  const execDir = resolveExecDir(root, executionId);
  let state;
  try {
    state = derivedReadState(execDir, { executionId, phaseId });
  } catch (e) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "canonical owner re-read failed", { reason: "PUBLICATION_UNVERIFIED", cause: e?.code ?? String(e) });
  }
  if (state.state !== "COMMITTED" || !state.committed || state.committed.exists !== true) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "derived artifact owner is not in COMMITTED state", {
      reason: "PUBLICATION_UNVERIFIED",
      owner_state: state.state ?? null,
    });
  }
  const committed = state.committed;
  const link = JSON.parse(committed.bytes.toString("utf8"));
  if (!timingSafeHexEqual(link.artifact_digest, publication.artifact_digest)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "pinned artifact digest does not match durable bytes", { reason: "PUBLICATION_DIGEST_MISMATCH" });
  }
  if (!Number.isInteger(link.artifact_size) || Number.isInteger(publication.size) && link.artifact_size !== publication.size) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "pinned artifact size does not match durable bytes", { reason: "PUBLICATION_SIZE_MISMATCH" });
  }
  if (link.generation !== publication.generation) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "pinned generation does not match committed head", { reason: "PUBLICATION_GENERATION_MISMATCH" });
  }
  if (!timingSafeHexEqual(state.anchor.committed_link_digest, publication.link_digest)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "pinned link digest does not match committed anchor", { reason: "PUBLICATION_LINK_MISMATCH" });
  }
  if (state.anchor.execution_id !== executionId) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "committed anchor execution identity mismatch", { reason: "PUBLICATION_IDENTITY_MISMATCH" });
  }
  if (phaseId != null && state.anchor.phase_id !== phaseId) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "committed anchor phase identity mismatch", { reason: "PUBLICATION_IDENTITY_MISMATCH" });
  }
  return {
    verified: true,
    owner_state: state.state,
    artifact_digest: link.artifact_digest,
    artifact_size: link.artifact_size,
    link_digest: state.anchor.committed_link_digest,
    generation: link.generation,
  };
}

/**
 * Ephemeral, read-only candidate projection over a chain-valid snapshot
 * (IMPLEMENTATION-BOUNDARY §Architecture Admission: "deterministic,
 * evidence-bound, chain-valid view"; frozen corrupt-record semantics:
 * tamper-evident FAIL-CLOSED — never dropped, never repaired).
 *
 * Input is a REAL raw-log capture document (the writer's snapshot surface):
 * per-file
 * regular-file metadata + captured bytes + linearization markers. Bytes are
 * re-verified against their capture digests, canonical JSON is enforced,
 * and the durable chain algorithm (validateDurableEvent from log.mjs, the
 * same function readLog uses) re-validates sequence/digest continuity over
 * the captured files. Any corruption fails closed.
 */
export function buildCandidateProjection(snapshot) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "snapshot required");
  }
  const files = snapshot.files;
  const fileBytesList = snapshot.bytes;
  if (!Array.isArray(files) || files.length === 0 || !Array.isArray(fileBytesList) || fileBytesList.length !== files.length) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "snapshot files/bytes malformed");
  }
  if (snapshot.snapshot_algorithm_version !== 1
    || snapshot.linearization?.lock_acquired !== true
    || snapshot.linearization?.capture_point !== "EOF_UNDER_WRITER_LOCK") {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "snapshot was not captured under the writer lock");
  }

  const items = [];
  let expectedSequence = 1;
  let previousDigest = GENESIS_DIGEST;
  let lastGeneration = null;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    const fileBytes = fileBytesList[fileIndex];
    if (!Buffer.isBuffer(fileBytes) || fileBytes.length !== file.byte_length) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "captured byte length mismatch");
    }
    if (!timingSafeHexEqual(sha256Hex(fileBytes), file.sha256)) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "captured bytes do not match capture digest");
    }
    // Root chain order: GEN-1 files may precede GEN-2 files (rotation order);
    // a GEN-1 file appearing after a GEN-2 file fails closed.
    const lines = fileBytes.toString("utf8").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) continue;
    const fileGeneration = parseGenerationHeader(lines[0]);
    if (fileGeneration === 1 && lastGeneration === 2) {
      fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "GEN-1 file after GEN-2 file in root chain");
    }
    if (fileGeneration != null) lastGeneration = fileGeneration;

    for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.length === 0) {
        fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "empty line in captured log");
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "captured log line is not valid JSON");
      }
      // Canonical re-serialization must reproduce the stored line
      // byte-for-byte (the writer appends canonical(event) only).
      if (canonical(event) !== line) {
        fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "captured log line is not canonical JSON");
      }
      // Re-validate the durable chain over the captured bytes: sequence
      // continuity, previous_digest linkage, event_digest recomputation,
      // digest-field shape, per-generation type gates. Identical semantics
      // to log.mjs readLog — no parallel validation rules.
      validateCapturedEvent(event, { expectedSequence, previousDigest, generation: fileGeneration });
      expectedSequence += 1;
      previousDigest = event.event_digest;

      if (event.event_type !== "PATTERN_CANDIDATE_CREATED") continue;
      // Candidate records must re-derive their own identity; a stored
      // identity that no longer matches its bound inputs is tamper evidence
      // and fails closed (frozen corrupt-record semantics: never dropped).
      assertCandidateDerivedIdentities(event);
      const payload = event.payload;
      items.push({
        candidate_id: payload.candidate_id,
        candidate_identity_key: payload.candidate_identity_key,
        candidate_slot: payload.candidate_slot ?? 0,
        lifecycle_state: payload.lifecycle_state,
        mechanism_digest: payload.mechanism_digest,
        applicability_digest: payload.applicability_digest,
        constituent_incident_set_digest: payload.constituent_incident_set_digest,
        publication: payload.publication_artifact_digest
          ? {
              artifact_digest: payload.publication_artifact_digest,
              link_digest: payload.publication_link_digest ?? null,
              generation: payload.publication_generation ?? null,
            }
          : null,
        event_id: event.event_id,
        journal_sequence: event.journal_sequence,
      });
    }
  }

  // Canonical order: journal_sequence ASC (the append order — the only
  // order the durable log defines).
  items.sort((a, b) => a.journal_sequence - b.journal_sequence);
  return {
    result_authority: "NON_AUTHORITATIVE",
    result_storage: "EPHEMERAL",
    projection_mutated: "NO",
    raw_log_mutated: "NO",
    candidate_count: items.length,
    items,
  };
}

export { canonical };
