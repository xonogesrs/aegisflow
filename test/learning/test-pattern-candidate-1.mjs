import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readFileSync as readFile, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_OBS_SCHEMA,
  TRANSFER_CODES,
  isHex64,
  canonical,
  LOG_SCHEMA,
  computeEventId,
  computeEventDigest,
  computeAuthorityPayloadDigest,
  computeAuthorityIdempotencyKey,
  GENESIS_DIGEST,
} from "../../src/learning/transfer-metrics/schema.mjs";
import { TransferMetricsWriter, captureRawLogSnapshot } from "../../src/learning/transfer-metrics/writer.mjs";
import { readLog, LOG_FILE_NAME } from "../../src/learning/transfer-metrics/log.mjs";
import {
  FIXTURE,
  makeIdentities,
  makeEvent,
  createTestWriter,
  expectCode,
  hex,
  iso,
  rawLogLines,
  writeRawLogBytes,
} from "../../src/learning/transfer-metrics/fixtures.mjs";
import {
  buildCandidatePayload,
  applyCandidateCreatedProfile,
  assertCandidateDerivedIdentities,
  deriveCandidateIdentityKey,
  deriveCandidateId,
  buildCandidateProjection,
} from "../../src/learning/patterns/candidate.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");

test("candidate identity key is stable and excludes content/evidence", () => {
  const ids = makeIdentities("cand-1");
  const event = {
    schema_version: "autoloop.transfer-event/v1",
    event_type: "PATTERN_CANDIDATE_CREATED",
    project_identity: ids.project_identity,
    task_identity: ids.task_identity,
    attempt_identity: ids.attempt_identity,
    incident_identity: { incident_id: ids.incident_id, incident_id_kind: "evidence_bound" },
    pattern_identity: { pattern_id: ids.pattern_id, generation: 0 },
    payload: {
      lifecycle_state: "CANDIDATE",
      mechanism_digest: ids.mechanism_digest,
      applicability_digest: ids.applicability_digest,
      constituent_incident_set_digest: ids.constituent_incident_set_digest,
      profile_version: CANDIDATE_OBS_SCHEMA,
      candidate_slot: 0,
      phase_identity: { execution_id: ids.execution_id, phase_id: "p1" },
    },
  };
  const key1 = deriveCandidateIdentityKey(event);
  const key2 = deriveCandidateIdentityKey(event);
  assert.ok(isHex64(key1));
  assert.equal(key1, key2);

  // Mutating candidate content (not part of identity key) must NOT change the key.
  const mutated = structuredClone(event);
  mutated.payload.mechanism_digest = hex("other-mechanism");
  assert.equal(deriveCandidateIdentityKey(mutated), key1);

  // Mutating identity-relevant fields MUST change the key.
  const otherSlot = structuredClone(event);
  otherSlot.payload.candidate_slot = 1;
  assert.notEqual(deriveCandidateIdentityKey(otherSlot), key1);
});

test("candidate_id binds identity key, incident, content, and evidence", () => {
  const ids = makeIdentities("cand-2");
  const event = {
    schema_version: "autoloop.transfer-event/v1",
    event_type: "PATTERN_CANDIDATE_CREATED",
    project_identity: ids.project_identity,
    task_identity: ids.task_identity,
    attempt_identity: ids.attempt_identity,
    incident_identity: { incident_id: ids.incident_id, incident_id_kind: "evidence_bound" },
    pattern_identity: { pattern_id: ids.pattern_id, generation: 0 },
    payload: {
      lifecycle_state: "CANDIDATE",
      mechanism_digest: ids.mechanism_digest,
      applicability_digest: ids.applicability_digest,
      constituent_incident_set_digest: ids.constituent_incident_set_digest,
      profile_version: CANDIDATE_OBS_SCHEMA,
      candidate_slot: 0,
      phase_identity: { execution_id: ids.execution_id, phase_id: "p1" },
      candidate_identity_key: hex("k"),
    },
  };
  const id1 = deriveCandidateId(event);
  assert.ok(isHex64(id1));

  // Content change must change candidate_id.
  const contentChanged = structuredClone(event);
  contentChanged.payload.mechanism_digest = hex("other");
  assert.notEqual(deriveCandidateId(contentChanged), id1);

  // Evidence change must change candidate_id.
  const evidenceChanged = structuredClone(event);
  evidenceChanged.payload.source_record_digest = hex("other-src");
  assert.notEqual(deriveCandidateId(evidenceChanged), id1);

  // Identity key change must change candidate_id.
  const keyChanged = structuredClone(event);
  keyChanged.payload.candidate_identity_key = hex("other-key");
  assert.notEqual(deriveCandidateId(keyChanged), id1);
});

test("applyCandidateCreatedProfile fills missing derived fields", () => {
  const ids = makeIdentities("cand-3");
  const event = {
    schema_version: "autoloop.transfer-event/v1",
    event_type: "PATTERN_CANDIDATE_CREATED",
    project_identity: ids.project_identity,
    task_identity: ids.task_identity,
    attempt_identity: ids.attempt_identity,
    incident_identity: { incident_id: ids.incident_id, incident_id_kind: "evidence_bound" },
    pattern_identity: { pattern_id: ids.pattern_id, generation: 0 },
    payload: {
      lifecycle_state: "CANDIDATE",
      mechanism_digest: ids.mechanism_digest,
      applicability_digest: ids.applicability_digest,
      constituent_incident_set_digest: ids.constituent_incident_set_digest,
      profile_version: CANDIDATE_OBS_SCHEMA,
      candidate_slot: 0,
      phase_identity: { execution_id: ids.execution_id, phase_id: "p1" },
    },
  };
  const out = applyCandidateCreatedProfile(event);
  assert.ok(isHex64(out.payload.candidate_identity_key));
  assert.ok(isHex64(out.payload.candidate_id));
});

test("applyCandidateCreatedProfile rejects mismatched candidate_id", () => {
  const ids = makeIdentities("cand-4");
  const event = {
    schema_version: "autoloop.transfer-event/v1",
    event_type: "PATTERN_CANDIDATE_CREATED",
    project_identity: ids.project_identity,
    task_identity: ids.task_identity,
    attempt_identity: ids.attempt_identity,
    incident_identity: { incident_id: ids.incident_id, incident_id_kind: "evidence_bound" },
    pattern_identity: { pattern_id: ids.pattern_id, generation: 0 },
    payload: {
      lifecycle_state: "CANDIDATE",
      mechanism_digest: ids.mechanism_digest,
      applicability_digest: ids.applicability_digest,
      constituent_incident_set_digest: ids.constituent_incident_set_digest,
      profile_version: CANDIDATE_OBS_SCHEMA,
      candidate_slot: 0,
      phase_identity: { execution_id: ids.execution_id, phase_id: "p1" },
      candidate_identity_key: hex("k"),
      candidate_id: hex("wrong"),
    },
  };
  try {
    applyCandidateCreatedProfile(event);
    assert.fail("expected failure");
  } catch (e) {
    assert.equal(e.code, TRANSFER_CODES.PAYLOAD_MALFORMED);
  }
});

test("legacy 4-key candidate payload passes through unchanged", () => {
  const ids = makeIdentities("cand-5");
  const event = {
    schema_version: "autoloop.transfer-event/v1",
    event_type: "PATTERN_CANDIDATE_CREATED",
    project_identity: ids.project_identity,
    task_identity: ids.task_identity,
    attempt_identity: ids.attempt_identity,
    incident_identity: { incident_id: ids.incident_id, incident_id_kind: "evidence_bound" },
    pattern_identity: { pattern_id: ids.pattern_id, generation: 0 },
    payload: {
      lifecycle_state: "CANDIDATE",
      mechanism_digest: ids.mechanism_digest,
      applicability_digest: ids.applicability_digest,
      constituent_incident_set_digest: ids.constituent_incident_set_digest,
    },
  };
  const out = applyCandidateCreatedProfile(event);
  assert.equal(out.payload.candidate_id, undefined);
  assert.equal(out.payload.candidate_identity_key, undefined);
  assert.equal(out.payload.profile_version, undefined);
});

// ---------------------------------------------------------------------------
// Writer enforcement
// ---------------------------------------------------------------------------

test("writer rejects tampered candidate_id on candidate events", () => {
  const ids = makeIdentities("cand-w1");
  const { writer } = createTestWriter(ids);
  const payload = buildCandidatePayload({
    incident: {
      project_identity: ids.project_identity,
      task_identity: ids.task_identity,
      attempt_identity: ids.attempt_identity,
      incident_identity: { incident_id: ids.incident_id, incident_id_kind: "evidence_bound" },
      pattern_identity: { pattern_id: ids.pattern_id, generation: 0 },
      mechanism_digest: ids.mechanism_digest,
      applicability_digest: ids.applicability_digest,
      constituent_incident_set_digest: ids.constituent_incident_set_digest,
    },
    slot: 0,
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p1" },
  });
  payload.candidate_id = hex("tampered");
  const event = makeEvent("PATTERN_CANDIDATE_CREATED", ids, { payload });
  expectCode(
    () => writer.appendTransferEvent({ event, principal: FIXTURE }),
    TRANSFER_CODES.PAYLOAD_MALFORMED,
  );
});

test("writer accepts well-formed candidate payload and persists it", () => {
  const ids = makeIdentities("cand-w2");
  const { root, writer } = createTestWriter(ids);
  const payload = buildCandidatePayload({
    incident: {
      project_identity: ids.project_identity,
      task_identity: ids.task_identity,
      attempt_identity: ids.attempt_identity,
      incident_identity: { incident_id: ids.incident_id, incident_id_kind: "evidence_bound" },
      pattern_identity: { pattern_id: ids.pattern_id, generation: 0 },
      mechanism_digest: ids.mechanism_digest,
      applicability_digest: ids.applicability_digest,
      constituent_incident_set_digest: ids.constituent_incident_set_digest,
    },
    slot: 0,
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p1" },
  });
  const event = makeEvent("PATTERN_CANDIDATE_CREATED", ids, { payload });
  const res = writer.appendTransferEvent({ event, principal: FIXTURE });
  assert.equal(res.status, "APPENDED");
  const log = readLog(root);
  assert.equal(log.events.length, 1);
  assert.equal(log.events[0].payload.candidate_id, payload.candidate_id);
  assert.equal(log.events[0].payload.candidate_identity_key, payload.candidate_identity_key);
});

test("same candidate content retried returns ALREADY_SATISFIED", () => {
  const ids = makeIdentities("cand-w3");
  const { writer } = createTestWriter(ids);
  const payload = buildCandidatePayload({
    incident: {
      project_identity: ids.project_identity,
      task_identity: ids.task_identity,
      attempt_identity: ids.attempt_identity,
      incident_identity: { incident_id: ids.incident_id, incident_id_kind: "evidence_bound" },
      pattern_identity: { pattern_id: ids.pattern_id, generation: 0 },
      mechanism_digest: ids.mechanism_digest,
      applicability_digest: ids.applicability_digest,
      constituent_incident_set_digest: ids.constituent_incident_set_digest,
    },
    slot: 0,
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p1" },
  });
  const e1 = makeEvent("PATTERN_CANDIDATE_CREATED", ids, { payload });
  const e2 = makeEvent("PATTERN_CANDIDATE_CREATED", ids, { payload });
  const r1 = writer.appendTransferEvent({ event: e1, principal: FIXTURE });
  const r2 = writer.appendTransferEvent({ event: e2, principal: FIXTURE });
  assert.equal(r1.status, "APPENDED");
  assert.equal(r2.status, "ALREADY_SATISFIED");
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

test("buildCandidateProjection derives candidates from a real snapshot", () => {
  const ids = makeIdentities("cand-p1");
  const { root, writer } = createTestWriter(ids);
  const payload = buildCandidatePayload({
    incident: {
      project_identity: ids.project_identity,
      task_identity: ids.task_identity,
      attempt_identity: ids.attempt_identity,
      incident_identity: { incident_id: ids.incident_id, incident_id_kind: "evidence_bound" },
      pattern_identity: { pattern_id: ids.pattern_id, generation: 0 },
      mechanism_digest: ids.mechanism_digest,
      applicability_digest: ids.applicability_digest,
      constituent_incident_set_digest: ids.constituent_incident_set_digest,
    },
    slot: 0,
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p1" },
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_CANDIDATE_CREATED", ids, { payload }),
    principal: FIXTURE,
  });
  const snapshot = captureRawLogSnapshot({ transferMetricsRoot: root });
  const proj = buildCandidateProjection(snapshot);
  assert.equal(proj.result_authority, "NON_AUTHORITATIVE");
  assert.equal(proj.result_storage, "EPHEMERAL");
  assert.equal(proj.projection_mutated, "NO");
  assert.equal(proj.raw_log_mutated, "NO");
  assert.equal(proj.candidate_count, 1);
  assert.equal(proj.items[0].candidate_id, payload.candidate_id);
  assert.equal(proj.items[0].lifecycle_state, "CANDIDATE");
  assert.equal(proj.items[0].publication, null);
});

test("buildCandidateProjection fails closed on a tampered durable record", () => {
  const ids = makeIdentities("cand-p2");
  const { root, writer } = createTestWriter(ids);
  const payload = buildCandidatePayload({
    incident: {
      project_identity: ids.project_identity,
      task_identity: ids.task_identity,
      attempt_identity: ids.attempt_identity,
      incident_identity: { incident_id: ids.incident_id, incident_id_kind: "evidence_bound" },
      pattern_identity: { pattern_id: ids.pattern_id, generation: 0 },
      mechanism_digest: ids.mechanism_digest,
      applicability_digest: ids.applicability_digest,
      constituent_incident_set_digest: ids.constituent_incident_set_digest,
    },
    slot: 0,
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p1" },
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_CANDIDATE_CREATED", ids, { payload }),
    principal: FIXTURE,
  });
  // Simulate durable-bytes tampering: alter the stored candidate_id so the
  // line stays valid JSON but breaks identity re-derivation AND the chain
  // digest. Projection must FAIL CLOSED — never drop, never repair.
  const logPath = join(root, LOG_FILE_NAME);
  const lines = readFile(logPath, "utf8").split("\n");
  const eventLine = lines[1];
  const forged = eventLine.replace(
    /"candidate_id":"[0-9a-f]{4}/,
    (m) => m.slice(0, -4) + "dead",
  );
  assert.notEqual(forged, eventLine, "tamper did not change the line");
  lines[1] = forged;
  writeFileSync(logPath, lines.join("\n"));
  assert.throws(
    () => buildCandidateProjection(captureRawLogSnapshot({ transferMetricsRoot: root })),
    (e) => e.code === TRANSFER_CODES.PAYLOAD_MALFORMED || e.code === TRANSFER_CODES.LOG_CHAIN_INVALID,
  );
});

test("buildCandidateProjection ignores non-candidate events", () => {
  const ids = makeIdentities("cand-p3");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  });
  const proj = buildCandidateProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(proj.candidate_count, 0);
  assert.deepEqual(proj.items, []);
});

// ---------------------------------------------------------------------------
// Fences (structural, from the boundary)
// ---------------------------------------------------------------------------

test("fences: no CandidateStore symbol in src", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".mjs")) files.push(p);
    }
  };
  walk(join(REPO, "src"));
  const offenders = files.filter((f) => {
    const text = readFileSync(f, "utf8");
    return /CandidateStore/.test(text);
  });
  assert.deepEqual(offenders, []);
});

test("projection fails closed on a chain-consistent GEN-1 authority record", () => {
  // M7 discriminating killer: the forged record is FULLY chain-consistent
  // (sequence, previous_digest, event_digest recomputed over the WRONG
  // event_type), so only the per-generation type gate can reject it. A
  // candidate projection that trusts the shared EVENT_TYPES list alone
  // would admit a v1-stamped authority record into the candidate view.
  const ids = makeIdentities("cand-p5");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  });
  const durable = readLog(root).events[0];
  const forged = {
    ...durable,
    event_type: "LEARNING_AUTHORITY_STATE_CHANGED",
    schema_version: "autoloop.transfer-event/v1",
    journal_sequence: 1,
    previous_digest: GENESIS_DIGEST,
    incident_identity: null,
    pattern_identity: null,
    retrieval_event_id: null,
    subject_event_id: null,
    outcome_ref: null,
    payload: {
      authority_domain: "autoloop.learning-authority/v1",
      subject_kind: "WRITER_PRINCIPAL",
      subject_identity: ids.writer?.writer_id ?? "w1",
      operation: "REVOKE",
      previous_generation: 0,
      new_generation: 1,
      previous_state: "ACTIVE",
      new_state: "REVOKED",
      expected_previous_generation: 0,
      issuer_principal_digest: hex("issuer"),
      issuer_authority_generation: 0,
      issuer_revocation_generation: 0,
      mutation_id: "mut-forge-1",
    },
  };
  const pd = computeAuthorityPayloadDigest(forged.payload);
  const ik = computeAuthorityIdempotencyKey(forged.payload);
  const eid = computeEventId(ik);
  forged.event_id = eid;
  forged.idempotency_key = ik;
  forged.payload_digest = pd;
  forged.event_digest = computeEventDigest({
    journal_sequence: 1,
    event_id: eid,
    event_type: forged.event_type,
    payload_digest: pd,
    previous_digest: GENESIS_DIGEST,
  });
  const v1Header = canonical({ created_at: iso(0), schema: LOG_SCHEMA, schema_version: 1 });
  writeRawLogBytes(root, LOG_FILE_NAME, [v1Header, canonical(forged)].join("\n") + "\n");
  assert.throws(
    () => buildCandidateProjection(captureRawLogSnapshot({ transferMetricsRoot: root })),
    (e) => e.code === TRANSFER_CODES.LOG_CHAIN_INVALID || e.code === TRANSFER_CODES.EVENT_UNKNOWN_TYPE || e.code === TRANSFER_CODES.PAYLOAD_MALFORMED,
  );
});
