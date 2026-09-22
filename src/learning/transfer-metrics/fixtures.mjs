// src/learning/transfer-metrics/fixtures.mjs
//
// Synthetic/offline fixtures. Same redaction/bounds as production events.
// Never a production outcome authority.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENESIS_DIGEST,
  INCIDENT_OBS_SCHEMA,
  LOG_SCHEMA,
  LOG_SCHEMA_V2,
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2,
  canonical,
  computeEventDigest,
  computeEventId,
  computeIdempotencyKey,
  computePayloadDigest,
  deriveEvidenceSetDigest,
  deriveIncidentId,
  deriveSourceIdentityKey,
} from "./schema.mjs";
import { createIdentityBinder, mintPrincipal } from "./identities.mjs";
import { TransferMetricsWriter } from "./writer.mjs";

export const TMP_PARENT = "/Volumes/NVM2T/Development/tmp/transfer-metrics-core-1";

export const FIXTURE = mintPrincipal({ identity: "fix-1", role: "fixture" });
export const EXECUTOR = mintPrincipal({ identity: "ex-1", role: "executor" });
export const SYSTEM = mintPrincipal({ identity: "sys-1", role: "system" });
export const REVIEWER = mintPrincipal({ identity: "rev-1", role: "reviewer" });
export const OPERATOR = mintPrincipal({ identity: "op-1", role: "operator" });

export function hex(seed) {
  return createHash("sha256").update(String(seed), "utf8").digest("hex");
}

export function iso(offsetSeconds = 0) {
  return new Date(Date.parse("2026-08-01T00:00:00.000Z") + offsetSeconds * 1000).toISOString();
}

export const WINDOW = Object.freeze({
  start: "2026-08-01T00:00:00.000Z",
  end: "2026-09-01T00:00:00.000Z",
  producer_kind: "fixture",
});

let seq = 0;
// S16 GC card (Phase G): every fixture root is tracked so a suite-level
// attestation can prove no temporary material outlives the test process.
// The tracked set is per-process; the trackedCleanupAttestation helper is
// the T9-discipline seam (test/learning/test-r2-cross-process.mjs T5).
const TRACKED_TEST_ROOTS = new Set();

export function trackedTestRoots() {
  return [...TRACKED_TEST_ROOTS];
}

export function trackedCleanupAttestation({ remove = true } = {}) {
  const removed = [];
  const failed = [];
  for (const root of TRACKED_TEST_ROOTS) {
    try {
      if (remove && existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
      }
      removed.push(root);
    } catch {
      failed.push(root);
    }
  }
  TRACKED_TEST_ROOTS.clear();
  return { removed, failed };
}

export function createTestRoot(label = "run") {
  seq += 1;
  mkdirSync(TMP_PARENT, { recursive: true, mode: 0o700 });
  const root = join(TMP_PARENT, `${label}-${process.pid}-${Date.now()}-${seq}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  TRACKED_TEST_ROOTS.add(root);
  registerExitSweep();
  return root;
}

// Process-exit sweep (S16 GC card Phase G): a fixture root must never
// outlive the test process that created it. Registered once on first
// createTestRoot; exit-time failures are swallowed (best-effort reclaim —
// the trackedCleanupAttestation seam remains the assertable surface).
let exitSweepRegistered = false;
function registerExitSweep() {
  if (exitSweepRegistered) return;
  exitSweepRegistered = true;
  process.on("exit", () => {
    for (const root of TRACKED_TEST_ROOTS) {
      try {
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
      } catch { /* best-effort at exit */ }
    }
  });
}

export function makeIdentities(label = "t") {
  const task_id = `task-${label}`;
  const admission_id = hex(`admission-${label}`);
  const execution_id = `exec-${label}`;
  const repository_root_identity = join(TMP_PARENT, `proj-${label}`);
  const git_common_dir_identity = join(repository_root_identity, ".git");
  return {
    task_id,
    admission_id,
    execution_id,
    project_identity: { repository_root_identity, git_common_dir_identity },
    task_identity: { task_id, admission_id },
    attempt_identity: { execution_id, attempt: 0 },
    evidence: hex(`evidence-${label}`),
    incident_id: hex(`incident-${label}`),
    source_record_id: `src-${label}`,
    source_authority_identity: `src-auth-${label}`,
    source_record_digest: hex(`source-record-${label}`),
    failure_finding_discriminator: `FINDING-${label}`,
    pattern_id: `pat-${label}`,
    mechanism_digest: hex(`mech-${label}`),
    applicability_digest: hex(`appl-${label}`),
    retrievalDigest: hex(`retr-${label}`),
    storeSnapshotDigest: hex(`snap-${label}`),
    artifact_digest: hex(`art-${label}`),
    lifecycle_event_digest: hex(`life-${label}`),
    constituent_incident_set_digest: hex(`cset-${label}`),
    evidence_manifest_digest: hex(`man-${label}`),
    counterfactual_digest: hex(`cf-${label}`),
  };
}

export function makeBinder(ids, extra = {}) {
  return createIdentityBinder({
    tasks: extra.tasks ?? new Map([[ids.task_id, { admission_id: ids.admission_id }]]),
    attempts: extra.attempts ?? new Map([[ids.execution_id, { attempts: new Set([0, 1, 2]) }]]),
    projects: extra.projects ?? new Map([[ids.project_identity.repository_root_identity, ids.project_identity]]),
    evidence: extra.evidence ?? new Set([ids.evidence, ids.evidence_manifest_digest, ids.counterfactual_digest]),
    lifecycleTerminals: extra.lifecycleTerminals ?? new Map([[ids.execution_id, { final: extra.final ?? "PASS", attempt: extra.terminalAttempt ?? 0 }]]),
    lifecycleTimes: extra.lifecycleTimes ?? new Map(),
    truthGenerations: extra.truthGenerations ?? new Map(),
    requireEvidenceInventory: extra.requireEvidenceInventory ?? false,
  });
}

export function createTestWriter(ids, extra = {}) {
  const root = extra.root ?? createTestRoot();
  const writer = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: extra.identityBinder ?? makeBinder(ids, extra),
    revocationRegistry: extra.revocationRegistry ?? { revokedWriterIds: new Set(), currentGenerations: new Map([[ "w1", 0 ]]) },
    clock: extra.clock ?? (() => iso(10)),
    allowFixture: extra.allowFixture ?? true,
    crashHooks: extra.crashHooks ?? {},
  });
  return { root, writer };
}

const TYPE_PAYLOADS = {
  INCIDENT_OBSERVED: (ids) => ({
    profile_version: INCIDENT_OBS_SCHEMA,
    source_class: "LIFECYCLE_TERMINAL",
    source_record_id: ids.source_record_id,
    source_authority_identity: ids.source_authority_identity,
    source_authority_generation: 0,
    failure_finding_discriminator: ids.failure_finding_discriminator,
    source_record_digest: ids.source_record_digest,
    evidence_completeness_class: "COMPLETE",
    observed_outcome_class: "HOLD",
  }),
  PATTERN_CANDIDATE_CREATED: (ids) => ({
    lifecycle_state: "CANDIDATE",
    mechanism_digest: ids.mechanism_digest,
    applicability_digest: ids.applicability_digest,
    constituent_incident_set_digest: ids.constituent_incident_set_digest,
  }),
  PATTERN_QUALIFIED: (ids) => ({
    lifecycle_state: "ADVISORY",
    mechanism_digest: ids.mechanism_digest,
    applicability_digest: ids.applicability_digest,
    lifecycle_event_digest: ids.lifecycle_event_digest,
  }),
  PATTERN_RETRIEVED: (ids) => ({
    retrievalDigest: ids.retrievalDigest,
    storeSnapshotDigest: ids.storeSnapshotDigest,
    rank: 0,
    truncated: false,
  }),
  PATTERN_REJECTED: (ids) => ({
    rejection_code: "NOT_APPLICABLE",
    retrievalDigest: ids.retrievalDigest,
  }),
  PATTERN_USED_IN_PLANNING: (ids) => ({
    artifact_digest: ids.artifact_digest,
    citation_kind: "explicit_reference",
  }),
  PATTERN_USED_IN_VERIFICATION: (ids) => ({
    artifact_digest: hex(`ver-${ids.task_id}`),
    citation_kind: "explicit_reference",
  }),
  OUTCOME_OBSERVED: (ids) => ({
    final: "PASS",
    hold_code: null,
    repair_attempts: 0,
    evidence_manifest_digest: ids.evidence_manifest_digest,
  }),
  TRANSFER_ADJUDICATED: (ids) => ({
    attribution_grade: "C",
    benefit_claimed: true,
    adjudicator_role: "reviewer",
    counterfactual_digest: ids.counterfactual_digest,
    detected_earlier: null,
    unnecessary_gate: null,
    overlay_applicability: "APPLICABLE",
  }),
  PATTERN_DEMOTED: (ids) => ({
    lifecycle_state: "DEMOTED",
    mechanism_digest: ids.mechanism_digest,
    applicability_digest: ids.applicability_digest,
    lifecycle_event_digest: hex(`demote-${ids.task_id}`),
  }),
  PATTERN_ARCHIVED: (ids) => ({
    lifecycle_state: "ARCHIVED",
    mechanism_digest: ids.mechanism_digest,
    applicability_digest: ids.applicability_digest,
    lifecycle_event_digest: hex(`arch-${ids.task_id}`),
  }),
  PATTERN_REMOVED: (ids) => ({
    lifecycle_state: "REMOVED",
    mechanism_digest: ids.mechanism_digest,
    applicability_digest: ids.applicability_digest,
    lifecycle_event_digest: hex(`rem-${ids.task_id}`),
  }),
  STALE_PATTERN_REJECTED: (ids) => ({
    rejection_code: "STALE_GENERATION",
    retrievalDigest: ids.retrievalDigest,
  }),
  ROLLBACK_OBSERVED: (ids) => ({
    from_generation: 1,
    to_generation: 0,
    reason_code: "REGRESSION",
  }),
};

export function makeEvent(type, ids, overrides = {}) {
  const payload = { ...TYPE_PAYLOADS[type](ids), ...(overrides.payload ?? {}) };
  const event = {
    schema_version: SCHEMA_VERSION,
    event_type: type,
    occurred_at: overrides.occurred_at ?? iso(1),
    project_identity: overrides.project_identity ?? ids.project_identity,
    task_identity: overrides.task_identity ?? ids.task_identity,
    attempt_identity: overrides.attempt_identity ?? ids.attempt_identity,
    incident_identity: overrides.incident_identity ?? {
      incident_id: ids.incident_id,
      incident_id_kind: "evidence_bound",
    },
    pattern_identity: Object.prototype.hasOwnProperty.call(overrides, "pattern_identity")
      ? overrides.pattern_identity
      : { pattern_id: ids.pattern_id, generation: 0 },
    retrieval_event_id: Object.prototype.hasOwnProperty.call(overrides, "retrieval_event_id")
      ? overrides.retrieval_event_id
      : null,
    evidence_refs: overrides.evidence_refs ?? [
      { kind: "evidence_event", identity: "ev1", digest: ids.evidence },
    ],
    evidence_complete: overrides.evidence_complete ?? true,
    missing_predecessor: overrides.missing_predecessor ?? false,
    producer_kind: overrides.producer_kind ?? "fixture",
    writer: overrides.writer ?? { writer_id: "w1", writer_generation: 0 },
    authority: overrides.authority ?? { ...FIXTURE },
    revocation_generation: Object.prototype.hasOwnProperty.call(overrides, "revocation_generation")
      ? overrides.revocation_generation
      : null,
    applicability_decision: overrides.applicability_decision ?? "UNKNOWN",
    subject_event_id: Object.prototype.hasOwnProperty.call(overrides, "subject_event_id")
      ? overrides.subject_event_id
      : null,
    outcome_ref: Object.prototype.hasOwnProperty.call(overrides, "outcome_ref")
      ? overrides.outcome_ref
      : (type === "OUTCOME_OBSERVED"
        ? { execution_id: ids.execution_id, final: payload.final, attempt: (overrides.attempt_identity ?? ids.attempt_identity).attempt }
        : null),
    payload,
  };
  if (type === "INCIDENT_OBSERVED") {
    const payloadComplete = event.payload?.source_class && event.payload?.source_record_id && event.payload?.source_record_digest;
    if (payloadComplete) {
      const key = deriveSourceIdentityKey(event);
      const es = deriveEvidenceSetDigest(event.evidence_refs ?? []);
      const iid = deriveIncidentId(key, event.payload.source_record_digest, es);
      if (event.payload.source_identity_key == null) event.payload.source_identity_key = key;
      if (event.payload.evidence_set_digest == null) event.payload.evidence_set_digest = es;
      if (!Object.prototype.hasOwnProperty.call(overrides, "incident_identity")) {
        event.incident_identity = {
          incident_id: iid,
          incident_id_kind: event.incident_identity?.incident_id_kind ?? "evidence_bound",
        };
      }
    }
  }
  return event;
}

export function expectCode(fn, code) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(`expected ${code}, nothing thrown`);
  if (err.code !== code) throw new Error(`expected ${code}, got ${err.code}: ${err.message}`);
  return err;
}


/**
 * Raw JSONL log builder for compatibility fixtures (V1 historical goldens,
 * mixed-generation roots, corrupt-tail probes). TEST FIXTURE ONLY — never a
 * migration and never presented as one. Caller events must already satisfy
 * their generation's caller-event schema.
 */
export function rawLogLines({ generation = 1, events = [], createdAt = iso(0) } = {}) {
  const schema = generation === 1 ? LOG_SCHEMA : LOG_SCHEMA_V2;
  const schemaVersion = generation === 1 ? SCHEMA_VERSION : SCHEMA_VERSION_V2;
  const lines = [canonical({ created_at: createdAt, schema, schema_version: generation })];
  let previous = GENESIS_DIGEST;
  let seq = 1;
  for (const raw of events) {
    const event = { ...raw, schema_version: schemaVersion };
    const payload_digest = computePayloadDigest(event.payload);
    const idempotency_key = computeIdempotencyKey(event);
    const event_id = computeEventId(idempotency_key);
    const event_digest = computeEventDigest({
      journal_sequence: seq, event_id, event_type: event.event_type, payload_digest, previous_digest: previous,
    });
    const durable = {
      ...event,
      event_id,
      recorded_at: event.recorded_at ?? iso(2),
      idempotency_key,
      payload_digest,
      redaction_status: { scanned: true, truncated: false, secret_hit: false },
      journal_sequence: seq,
      previous_digest: previous,
      event_digest,
    };
    lines.push(canonical(durable));
    previous = event_digest;
    seq += 1;
  }
  return lines;
}

export function writeRawLogBytes(root, name, text) {
  writeFileSync(join(root, name), text);
}

export function writeRawLog(root, { generation = 1, events = [], name = "transfer-events.jsonl", createdAt } = {}) {
  writeRawLogBytes(root, name, rawLogLines({ generation, events, createdAt }).join("\n") + "\n");
}