// src/learning/transfer-metrics/authority-state.mjs
//
// Learning-authority replay fold, readiness state machine, subject-identity
// derivation, and the read-only authority seam. The fold is the ONLY
// reconstruction of current learning authority; it produces an EPHEMERAL
// cache and never a durable artifact, a metric, or a projection item.
// Replay order is RAW APPEND ORDER (journal_sequence ascending across
// archive seq, then active); recorded_at/occurred_at never determine
// authority order. replayAuthorityReadiness and the seam fold read the raw
// log UNDER the existing writer lock (callers hold it or the seam acquires
// it via withTransferMetricsReadLock).

import {
  ALLOWED_ROOT_PREFIX,
  AUTHORITY_DOMAIN,
  AUTHORITY_EVENT_TYPE,
  SCHEMA_VERSION_V2,
  TRANSFER_CODES,
  TransferMetricsError,
  digestOf,
  validateAuthorityRecord,
} from "./schema.mjs";
import { listLogFiles, readLog } from "./log.mjs";
import { withTransferMetricsReadLock } from "./writer.mjs";

function fail(code, message, details) {
  throw new TransferMetricsError(code, message, details);
}

export const AUTHORITY_READINESS = Object.freeze([
  "UNINITIALIZED",
  "REPLAYING",
  "READY",
  "CORRUPT",
  "UNAVAILABLE",
]);

export const AUTHORITY_AVAILABILITY = Object.freeze([
  "AVAILABLE_CURRENT",
  "AVAILABLE_REVOKED",
  "AUTHORITY_UNAVAILABLE",
  "AUTHORITY_CORRUPT",
  "SUBJECT_NOT_FOUND",
]);

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Subject identity (WRITER_PRINCIPAL / CITED_TRUTH) — writer-derived,
// canonical, domain-separated, digest-derived, restart-stable. Never accepted
// as opaque caller data: callers name the subject, the identity is rederived.
// ---------------------------------------------------------------------------

export function deriveAuthoritySubjectIdentity({
  subjectKind,
  storageRoot,
  writerId,
  citedKey,
  taskIdentity,
} = {}) {
  if (typeof storageRoot !== "string" || storageRoot.length === 0
    || !storageRoot.startsWith(ALLOWED_ROOT_PREFIX)) {
    fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, "authority storage root outside NVM2T boundary");
  }
  const project_identity = {
    repository_root_identity: storageRoot,
    git_common_dir_identity: storageRoot,
  };
  if (subjectKind === "WRITER_PRINCIPAL") {
    if (typeof writerId !== "string" || writerId.length === 0) {
      fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, "writerId required for WRITER_PRINCIPAL");
    }
    return deepFreeze({
      authority_domain: AUTHORITY_DOMAIN,
      subject_kind: "WRITER_PRINCIPAL",
      writer_id: writerId,
      project_identity,
      writer_storage_identity: storageRoot,
    });
  }
  if (subjectKind === "CITED_TRUTH") {
    if (typeof citedKey !== "string" || citedKey.length === 0) {
      fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, "citedKey required for CITED_TRUTH");
    }
    if (!taskIdentity || typeof taskIdentity.task_id !== "string" || taskIdentity.task_id.length === 0) {
      fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, "taskIdentity.task_id required for CITED_TRUTH");
    }
    return deepFreeze({
      authority_domain: AUTHORITY_DOMAIN,
      subject_kind: "CITED_TRUTH",
      cited_key: citedKey,
      project_identity,
      task_admission_identity: {
        task_id: taskIdentity.task_id,
        admission_id: taskIdentity.admission_id,
      },
    });
  }
  fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, `unknown subject_kind ${String(subjectKind)}`);
}

export function authoritySubjectKey(subjectIdentity) {
  return digestOf(subjectIdentity);
}

// ---------------------------------------------------------------------------
// Authoritative replay fold (raw append order).
// ---------------------------------------------------------------------------

export function emptyAuthorityFold() {
  return {
    subjects: new Map(),
    records: [],
    revokedWriterIds: new Set(),
    writerGenerations: new Map(),
    citedGenerations: new Map(),
  };
}

/**
 * Fold chain-validated events into authority state. Measurement events are
 * skipped (already validated by the chain reader); each authority record is
 * re-validated against the closed V2 authority schema and the fold-so-far.
 * Gaps/rollback/terminal violations fail closed with the frozen codes.
 * Never writes, never repairs, never skips, never orders by timestamp.
 */
export function foldAuthorityEvents(events) {
  const fold = emptyAuthorityFold();
  for (const event of events) {
    if (event.event_type !== AUTHORITY_EVENT_TYPE) continue;
    validateAuthorityRecord(event);
    const payload = event.payload;
    const identityKey = authoritySubjectKey(payload.subject_identity);
    const prior = fold.subjects.get(identityKey);
    const priorState = prior ? prior.state : null;
    const priorGeneration = prior ? prior.generation : 0;
    if ((payload.previous_state ?? null) !== priorState) {
      fail(
        TRANSFER_CODES.AUTHORITY_LOG_CHAIN_INVALID,
        `authority previous_state mismatch for subject ${identityKey}`,
      );
    }
    if (payload.previous_generation !== priorGeneration) {
      fail(
        TRANSFER_CODES.AUTHORITY_LOG_CHAIN_INVALID,
        `authority generation gap for subject ${identityKey}`,
      );
    }
    if (priorState === "REVOKED") {
      fail(TRANSFER_CODES.AUTHORITY_SUBJECT_TERMINAL, "authority record after terminal REVOKED subject");
    }
    fold.subjects.set(identityKey, {
      state: payload.new_state,
      generation: payload.new_generation,
      identity: payload.subject_identity,
      final_event_id: event.event_id,
      final_event_digest: event.event_digest,
    });
    if (payload.subject_kind === "WRITER_PRINCIPAL") {
      fold.writerGenerations.set(payload.subject_identity.writer_id, payload.new_generation);
      if (payload.new_state === "REVOKED") {
        fold.revokedWriterIds.add(payload.subject_identity.writer_id);
      }
    } else {
      fold.citedGenerations.set(payload.subject_identity.cited_key, payload.new_generation);
    }
    fold.records.push({
      journal_sequence: event.journal_sequence,
      event_id: event.event_id,
      event_digest: event.event_digest,
      subject_key: identityKey,
    });
  }
  return fold;
}

export function authorityInputDigest(fold) {
  return digestOf({
    domain: AUTHORITY_DOMAIN,
    schema: SCHEMA_VERSION_V2,
    records: fold.records,
  });
}

// ---------------------------------------------------------------------------
// Readiness model: UNINITIALIZED -> REPLAYING -> READY | CORRUPT | UNAVAILABLE.
// MUST be invoked while the existing writer lock is held (or from the seam,
// which acquires it). Sync replay: REPLAYING is the in-call state.
// ---------------------------------------------------------------------------

export function replayAuthorityReadiness({ transferMetricsRoot } = {}) {
  if (typeof transferMetricsRoot !== "string" || transferMetricsRoot.length === 0) {
    fail(TRANSFER_CODES.AUTHORITY_UNAVAILABLE, "transferMetricsRoot required");
  }
  let files;
  try {
    files = listLogFiles(transferMetricsRoot);
  } catch (e) {
    if (e instanceof TransferMetricsError && e.code === TRANSFER_CODES.PATH_UNSAFE) throw e;
    return { status: "UNAVAILABLE", fold: null, activeGeneration: null };
  }
  if (files.length === 0) {
    // Missing log: never CURRENT@0; authority unavailable.
    return { status: "UNAVAILABLE", fold: null, activeGeneration: null };
  }
  let snapshot;
  try {
    snapshot = readLog(transferMetricsRoot);
  } catch (e) {
    // Any invalid/corrupt durable record (chain, schema, fold rules) is
    // CORRUPT — fail closed, never a fallback to cache, never UNAVAILABLE.
    const corruptCodes = new Set([
      TRANSFER_CODES.LOG_CHAIN_INVALID,
      TRANSFER_CODES.LOG_PARTIAL_TAIL,
      TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID,
      TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID,
      TRANSFER_CODES.AUTHORITY_LOG_CHAIN_INVALID,
      TRANSFER_CODES.AUTHORITY_LOG_CORRUPT,
      TRANSFER_CODES.AUTHORITY_GENERATION_CONFLICT,
      TRANSFER_CODES.AUTHORITY_STATE_ROLLBACK,
      TRANSFER_CODES.AUTHORITY_MUTATION_CONFLICT,
      TRANSFER_CODES.AUTHORITY_SUBJECT_TERMINAL,
    ]);
    if (e instanceof TransferMetricsError && corruptCodes.has(e.code)) {
      return { status: "CORRUPT", fold: null, activeGeneration: null };
    }
    throw e;
  }
  if (snapshot.activeGeneration !== 2) {
    // GEN-1 legacy active root: LEGACY_READ_ONLY for authority; measurement
    // continuity is untouched. Never CURRENT@0 from a v1 root.
    return { status: "UNAVAILABLE", fold: null, activeGeneration: snapshot.activeGeneration };
  }
  return { status: "READY", fold: foldAuthorityEvents(snapshot.events), activeGeneration: 2 };
}

// ---------------------------------------------------------------------------
// Read-only authority seam. Passive; never scheduled; never automatic; NOT
// the current verifier and it triggers nothing. Folds UNDER the existing
// writer lock. SUBJECT_NOT_FOUND folds to the proven initial CURRENT@0 only
// after a complete validated V2 replay.
// ---------------------------------------------------------------------------

export function readCurrentLearningAuthorityState({
  transferMetricsRoot,
  subjectKind,
  writerId,
  citedKey,
  taskIdentity,
  subjectIdentity,
  expectedDomain = AUTHORITY_DOMAIN,
} = {}) {
  if (expectedDomain !== AUTHORITY_DOMAIN) {
    fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, `unknown authority domain ${String(expectedDomain)}`);
  }
  const derived = deriveAuthoritySubjectIdentity({
    subjectKind,
    storageRoot: transferMetricsRoot,
    writerId,
    citedKey,
    taskIdentity,
  });
  if (subjectIdentity != null) {
    if (authoritySubjectKey(subjectIdentity) !== authoritySubjectKey(derived)) {
      fail(TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID, "caller subject identity does not match writer-derived identity");
    }
  }
  return withTransferMetricsReadLock(transferMetricsRoot, (root) => {
    const replay = replayAuthorityReadiness({ transferMetricsRoot: root });
    if (replay.status === "CORRUPT") {
      return frozenSeamResult({
        availability: "AUTHORITY_CORRUPT",
        state: null,
        generation: null,
        derived,
        inputDigest: null,
        finalEvent: null,
        replayGeneration: replay.activeGeneration,
      });
    }
    if (replay.status !== "READY") {
      return frozenSeamResult({
        availability: "AUTHORITY_UNAVAILABLE",
        state: null,
        generation: null,
        derived,
        inputDigest: null,
        finalEvent: null,
        replayGeneration: replay.activeGeneration,
      });
    }
    const subject = replay.fold.subjects.get(authoritySubjectKey(derived));
    if (!subject) {
      return frozenSeamResult({
        availability: "SUBJECT_NOT_FOUND",
        state: "CURRENT",
        generation: 0,
        derived,
        inputDigest: authorityInputDigest(replay.fold),
        finalEvent: null,
        replayGeneration: replay.activeGeneration,
      });
    }
    return frozenSeamResult({
      availability: subject.state === "REVOKED" ? "AVAILABLE_REVOKED" : "AVAILABLE_CURRENT",
      state: subject.state,
      generation: subject.generation,
      derived,
      inputDigest: authorityInputDigest(replay.fold),
      finalEvent: { event_id: subject.final_event_id, event_digest: subject.final_event_digest },
      replayGeneration: replay.activeGeneration,
    });
  });
}

function frozenSeamResult({ availability, state, generation, derived, inputDigest, finalEvent, replayGeneration }) {
  return deepFreeze({
    availability,
    state,
    generation,
    subject_kind: derived.subject_kind,
    subject_identity: derived,
    authority_input_digest: inputDigest,
    final_authority_event: finalEvent,
    replay_generation: replayGeneration,
  });
}
