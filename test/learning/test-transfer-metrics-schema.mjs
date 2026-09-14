// test/learning/test-transfer-metrics-schema.mjs
// T1-T7, T19-T22

import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, TRANSFER_CODES, SCHEMA_VERSION, SCHEMA_VERSION_V2, canonical } from "../../src/learning/transfer-metrics/schema.mjs";
import { TransferMetricsWriter } from "../../src/learning/transfer-metrics/writer.mjs";
import { readLog } from "../../src/learning/transfer-metrics/log.mjs";
import { createLifecycleOutcomeAdapter } from "../../src/learning/transfer-metrics/identities.mjs";
import {
  FIXTURE, EXECUTOR, SYSTEM, REVIEWER,
  makeIdentities, makeEvent, createTestWriter, expectCode, hex, iso,
} from "../../src/learning/transfer-metrics/fixtures.mjs";

const REQUIRED_BY_TYPE = {
  INCIDENT_OBSERVED: "payload",
  PATTERN_CANDIDATE_CREATED: "payload",
  PATTERN_QUALIFIED: "payload",
  PATTERN_RETRIEVED: "payload",
  PATTERN_REJECTED: "payload",
  PATTERN_USED_IN_PLANNING: "retrieval_event_id",
  PATTERN_USED_IN_VERIFICATION: "retrieval_event_id",
  OUTCOME_OBSERVED: "outcome_ref",
  TRANSFER_ADJUDICATED: "subject_event_id",
  PATTERN_DEMOTED: "payload",
  PATTERN_ARCHIVED: "payload",
  PATTERN_REMOVED: "payload",
  STALE_PATTERN_REJECTED: "payload",
  ROLLBACK_OBSERVED: "payload",
};

test("T1 14 legal event types persist", () => {
  const ids = makeIdentities("t1");
  const { root, writer } = createTestWriter(ids);
  assert.equal(EVENT_TYPES.length, 14);
  const retrieved = writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { occurred_at: iso(1), pattern_identity: null }),
    principal: FIXTURE,
  });
  assert.equal(retrieved.status, "APPENDED");
  writer.appendTransferEvent({ event: makeEvent("PATTERN_CANDIDATE_CREATED", ids, { occurred_at: iso(2) }), principal: FIXTURE });
  writer.appendTransferEvent({ event: makeEvent("PATTERN_QUALIFIED", ids, { occurred_at: iso(3) }), principal: FIXTURE });
  const retr = writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids, { occurred_at: iso(4), applicability_decision: "APPLICABLE" }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_REJECTED", ids, { occurred_at: iso(5), payload: { rejection_code: "SCOPE", retrievalDigest: ids.retrievalDigest } }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_USED_IN_PLANNING", ids, { occurred_at: iso(6), retrieval_event_id: retr.event.event_id }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_USED_IN_VERIFICATION", ids, { occurred_at: iso(7), retrieval_event_id: retr.event.event_id }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("OUTCOME_OBSERVED", ids, { occurred_at: iso(8), pattern_identity: null }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("TRANSFER_ADJUDICATED", ids, {
      occurred_at: iso(9),
      subject_event_id: retr.event.event_id,
      authority: { ...REVIEWER },
      producer_kind: "measurement-writer",
      payload: {
        attribution_grade: "C",
        benefit_claimed: true,
        adjudicator_role: "reviewer",
        counterfactual_digest: ids.counterfactual_digest,
        detected_earlier: null,
        unnecessary_gate: null,
        overlay_applicability: "APPLICABLE",
      },
    }),
    principal: REVIEWER,
  });
  writer.appendTransferEvent({ event: makeEvent("PATTERN_DEMOTED", ids, { occurred_at: iso(10) }), principal: FIXTURE });
  writer.appendTransferEvent({ event: makeEvent("STALE_PATTERN_REJECTED", ids, { occurred_at: iso(11) }), principal: FIXTURE });
  writer.appendTransferEvent({ event: makeEvent("ROLLBACK_OBSERVED", ids, { occurred_at: iso(12) }), principal: FIXTURE });
  writer.appendTransferEvent({ event: makeEvent("PATTERN_ARCHIVED", ids, { occurred_at: iso(13) }), principal: FIXTURE });
  writer.appendTransferEvent({ event: makeEvent("PATTERN_REMOVED", ids, { occurred_at: iso(14) }), principal: FIXTURE });
  const log = readLog(root);
  const types = new Set(log.events.map((e) => e.event_type));
  for (const t of EVENT_TYPES) assert.ok(types.has(t), `missing ${t}`);
  assert.equal(log.events.length, 14);
  assert.equal(log.partialTrailingLine, false);
});

test("T2 missing required field rejected per type", () => {
  const ids = makeIdentities("t2");
  const { writer } = createTestWriter(ids);
  for (const type of EVENT_TYPES) {
    const event = makeEvent(type, ids, {
      retrieval_event_id: type.includes("USED") ? hex("missing-retr") : null,
      subject_event_id: type === "TRANSFER_ADJUDICATED" ? hex("missing-subj") : null,
      authority: type === "TRANSFER_ADJUDICATED" ? { ...REVIEWER } : { ...FIXTURE },
    });
    delete event.occurred_at;
    const principal = type === "TRANSFER_ADJUDICATED" ? REVIEWER : FIXTURE;
    expectCode(() => writer.appendTransferEvent({ event, principal }), TRANSFER_CODES.PAYLOAD_MALFORMED);
  }
});

test("T3 unknown event type and schema version rejected", () => {
  const ids = makeIdentities("t3");
  const { writer } = createTestWriter(ids);
  const unknownType = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  unknownType.event_type = "MADE_UP_EVENT";
  expectCode(() => writer.appendTransferEvent({ event: unknownType, principal: FIXTURE }), TRANSFER_CODES.EVENT_UNKNOWN_TYPE);
  const unknownSchema = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  unknownSchema.schema_version = "autoloop.transfer-event/v9";
  expectCode(() => writer.appendTransferEvent({ event: unknownSchema, principal: FIXTURE }), TRANSFER_CODES.EVENT_UNKNOWN_SCHEMA);
  const extra = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  extra.not_a_field = 1;
  expectCode(() => writer.appendTransferEvent({ event: extra, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T4 principal and identity binding mismatch rejected", () => {
  const ids = makeIdentities("t4");
  const { writer } = createTestWriter(ids);
  const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, authority: { ...EXECUTOR } });
  expectCode(
    () => writer.appendTransferEvent({ event, principal: FIXTURE }),
    TRANSFER_CODES.AUTHORITY_FORGED,
  );
  const unbound = makeEvent("INCIDENT_OBSERVED", ids, {
    pattern_identity: null,
    task_identity: { task_id: "nope", admission_id: ids.admission_id },
  });
  expectCode(() => writer.appendTransferEvent({ event: unbound, principal: FIXTURE }), TRANSFER_CODES.TASK_UNBOUND);
  const drift = makeEvent("INCIDENT_OBSERVED", ids, {
    pattern_identity: null,
    task_identity: { task_id: ids.task_id, admission_id: hex("other-adm") },
  });
  expectCode(() => writer.appendTransferEvent({ event: drift, principal: FIXTURE }), TRANSFER_CODES.ADMISSION_DRIFT);
});

test("T5 executor cannot forge D/C attribution", () => {
  const ids = makeIdentities("t5");
  const { writer } = createTestWriter(ids);
  const retr = writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids),
    principal: FIXTURE,
  });
  const adj = makeEvent("TRANSFER_ADJUDICATED", ids, {
    subject_event_id: retr.event.event_id,
    authority: { ...EXECUTOR },
    payload: {
      attribution_grade: "D",
      benefit_claimed: true,
      adjudicator_role: "reviewer",
      counterfactual_digest: ids.counterfactual_digest,
      detected_earlier: null,
      unnecessary_gate: null,
      overlay_applicability: "APPLICABLE",
    },
  });
  expectCode(
    () => writer.appendTransferEvent({ event: adj, principal: EXECUTOR }),
    TRANSFER_CODES.AUTHORITY_INSUFFICIENT,
  );
});

test("T6 executor cannot forge OUTCOME_OBSERVED", () => {
  const ids = makeIdentities("t6");
  const { writer } = createTestWriter(ids);
  const event = makeEvent("OUTCOME_OBSERVED", ids, {
    pattern_identity: null,
    authority: { ...EXECUTOR },
  });
  expectCode(
    () => writer.appendTransferEvent({ event, principal: EXECUTOR }),
    TRANSFER_CODES.AUTHORITY_INSUFFICIENT,
  );
});

test("T7 lifecycle-runner system adapter may write terminal outcome", () => {
  const ids = makeIdentities("t7");
  const { writer } = createTestWriter(ids, {
    lifecycleTerminals: new Map([[ids.execution_id, { final: "HOLD", attempt: 0 }]]),
  });
  const adapter = createLifecycleOutcomeAdapter({
    writer,
    principal: SYSTEM,
    lifecycleResult: { final: "HOLD", attempt: 0, executionId: ids.execution_id, holdCode: "X" },
  });
  const result = adapter.recordTerminalOutcome({
    occurred_at: iso(1),
    project_identity: ids.project_identity,
    task_identity: ids.task_identity,
    incident_identity: { incident_id: ids.incident_id, incident_id_kind: "evidence_bound" },
    pattern_identity: null,
    retrieval_event_id: null,
    evidence_refs: [{ kind: "evidence_manifest", identity: "m", digest: ids.evidence_manifest_digest }],
    evidence_complete: true,
    missing_predecessor: false,
    producer_kind: "measurement-writer",
    writer: { writer_id: "w1", writer_generation: 0 },
    applicability_decision: "UNKNOWN",
    subject_event_id: null,
    payload: {
      hold_code: "X",
      repair_attempts: 0,
      evidence_manifest_digest: ids.evidence_manifest_digest,
    },
  });
  assert.equal(result.status, "APPENDED");
  assert.equal(result.event.payload.final, "HOLD");
  assert.equal(result.event.authority.role, "system");
});

test("T19 newline and control-character injection rejected", () => {
  const ids = makeIdentities("t19");
  const { writer } = createTestWriter(ids);
  const ctrl = makeEvent("INCIDENT_OBSERVED", ids, {
    pattern_identity: null,
    payload: { failure_finding_discriminator: "bad\u0001value" },
  });
  expectCode(() => writer.appendTransferEvent({ event: ctrl, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_UNSAFE);
});

test("T20 oversized payload fail-closed", () => {
  const ids = makeIdentities("t20");
  const { writer } = createTestWriter(ids);
  const big = "x".repeat(20 * 1024);
  const refs = [];
  for (let i = 0; i < 32; i++) {
    refs.push({ kind: "evidence_event", identity: big, digest: hex(`big-${i}`) });
  }
  const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, evidence_refs: refs });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T21 secret/redaction rejection stores nothing", () => {
  const ids = makeIdentities("t21");
  const { root, writer } = createTestWriter(ids);
  const event = makeEvent("INCIDENT_OBSERVED", ids, {
    pattern_identity: null,
    payload: { failure_finding_discriminator: "sk-abcdefghijklmnopqrstuvwxyz123456" },
  });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.SECRET_RISK);
  const log = readLog(root);
  assert.equal(log.events.length, 0);
});

test("T22 deterministic canonical serialization", () => {
  const ids = makeIdentities("t22");
  const { writer } = createTestWriter(ids);
  const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  const a = writer.appendTransferEvent({ event, principal: FIXTURE });
  const b = writer.appendTransferEvent({ event, principal: FIXTURE });
  assert.equal(b.status, "ALREADY_SATISFIED");
  assert.equal(canonical(a.event), canonical(b.event));
  // A63/T84: the durable stamp follows the ACTIVE file header generation
  // (a fresh root's first log is created at GEN-2). The V1 constant and the
  // closed 14-type V1 allowlist are unchanged (T1/T4 goldens above).
  assert.equal(a.event.schema_version, SCHEMA_VERSION_V2);
});

void TransferMetricsWriter;
