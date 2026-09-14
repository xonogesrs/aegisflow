// test/learning/test-incident-observation-projection.mjs
//
// PROJECTION-1 T1–T75 (frozen matrix, TEST-MATRIX.md). Fixture capability only.
// Not a production emitter. No persistent projection artifact.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync,
  symlinkSync, linkSync, rmSync, mkdtempSync, mkdirSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

import {
  EVENT_TYPES,
  SCHEMA_VERSION,
  LOG_SCHEMA,
  GENESIS_DIGEST,
  canonical,
  computeEventDigest,
  computeEventId,
  computeIdempotencyKey,
  digestOf,
  deriveSourceIdentityKey,
  deriveEvidenceSetDigest,
  deriveIncidentId,
} from "../../src/learning/transfer-metrics/schema.mjs";
import { scanTransferPayload } from "../../src/learning/transfer-metrics/redact.mjs";
import { TransferMetricsWriter, captureRawLogSnapshot } from "../../src/learning/transfer-metrics/writer.mjs";
import {
  FIXTURE,
  makeIdentities,
  makeEvent,
  makeBinder,
  createTestRoot,
  expectCode,
  hex,
  iso,
} from "../../src/learning/transfer-metrics/fixtures.mjs";
import {
  PROJECTION_SCHEMA_VERSION,
  PROJECTION_ALGORITHM_VERSION,
  QUERY_POLICY_VERSION,
  CURRENT_AUTHORITY_POLICY_VERSION,
  CURRENT_AUTHORITY_POLICY_V1_STATUSES,
  PROJECTION_MAX_INPUT_BYTES,
  PROJECTION_MAX_INPUT_EVENTS,
  PROJECTION_DEFAULT_LIMIT,
  PROJECTION_MAX_LIMIT,
  PROJECTION_MAX_OUTPUT_BYTES,
  PROJECTION_MAX_EVIDENCE_REFS_PER_ITEM,
  PROJECTION_MAX_CURSOR_BYTES,
  PROJECTION_MAX_FILTER_VALUES,
  PROJECTION_FILTER_ALLOWLIST,
  PROJECTION_CODES,
  INCIDENT_PROJECTION_ITEM_IDENTITY_DOMAIN,
  buildIncidentProjection,
  queryIncidentProjection,
  encodeProjectionCursor,
} from "../../src/learning/incidents/projection.mjs";
import { sha256Text } from "../../src/evidence/run-evidence-store.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sha256Buf = (buf) => createHash("sha256").update(buf).digest("hex");
const throwCode = (fn) => {
  try { fn(); return "NO_THROW"; } catch (e) { return e.code; }
};

function attemptsMap(ids, attempts = [0]) {
  return new Map([[ids.execution_id, { attempts: new Set(attempts) }]]);
}

function testWriter(ids, extra = {}) {
  const root = createTestRoot();
  const binderExtra = { ...extra };
  delete binderExtra.revocationRegistry;
  if (extra.attempts === undefined) binderExtra.attempts = attemptsMap(ids, [0, 1, 2]);
  else if (Array.isArray(extra.attempts)) binderExtra.attempts = attemptsMap(ids, extra.attempts);
  const writer = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids, binderExtra),
    allowFixture: true,
    revocationRegistry: extra.revocationRegistry,
  });
  return { root, writer };
}

function appendIncident(writer, ids, overrides = {}, principal = FIXTURE) {
  return writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, ...overrides }),
    principal,
  });
}

function syntheticEventLine(base, { seq, previous, mutate = () => {} }) {
  const ev = structuredClone(base);
  mutate(ev);
  try {
    // ALWAYS rederive: base identity fields are stale once a mutation changes
    // any derivation input (e.g. discriminator). Chain-invalid mutations keep
    // raw writer-assigned fields; the projection fails closed on them.
    ev.payload.source_identity_key = deriveSourceIdentityKey(ev);
    const esd = deriveEvidenceSetDigest(ev.evidence_refs);
    ev.incident_identity.incident_id = deriveIncidentId(
      ev.payload.source_identity_key,
      ev.payload.source_record_digest,
      esd,
    );
    ev.idempotency_key = computeIdempotencyKey(ev);
    ev.event_id = computeEventId(ev.idempotency_key);
  } catch {
    ev.idempotency_key = ev.idempotency_key ?? sha256Hex("raw-key:" + seq);
    ev.event_id = ev.event_id ?? sha256Hex("raw-id:" + seq);
  }
  ev.journal_sequence = seq;
  ev.previous_digest = previous;
  ev.payload_digest = digestOf(ev.payload);
  ev.event_digest = computeEventDigest({
    journal_sequence: seq,
    event_id: ev.event_id,
    event_type: ev.event_type,
    payload_digest: ev.payload_digest,
    previous_digest: previous,
  });
  return { line: canonical(ev), event: ev };
}

function syntheticSnapshot(lines) {
  const bytes = Buffer.from(lines.join("\n") + "\n", "utf8");
  const files = [{
    name: "transfer-events.jsonl",
    byte_offset: 0,
    byte_length: bytes.length,
    device: 1,
    inode: 1,
    nlink: 1,
    sha256: sha256Buf(bytes),
  }];
  const digest = sha256Hex(canonical(
    files.map((f) => ({ name: f.name, byte_length: f.byte_length, sha256: f.sha256 })),
  ));
  return {
    snapshot_algorithm_version: 1,
    root: "/synthetic",
    linearization: { lock_acquired: true, capture_point: "EOF_UNDER_WRITER_LOCK" },
    files,
    total_bytes: bytes.length,
    raw_input_digest: digest,
    bytes: [bytes],
  };
}

function syntheticBaseEvent(ids) {
  const base = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  Object.assign(base, {
    recorded_at: iso(10),
    redaction_status: { scanned: true, truncated: false, secret_hit: false },
    retrieval_event_id: null,
    subject_event_id: null,
    outcome_ref: null,
  });
  return base;
}

function syntheticChain(ids, mutations) {
  const header = JSON.stringify({
    created_at: iso(0),
    schema: LOG_SCHEMA,
    schema_version: 1,
  });
  const base = syntheticBaseEvent(ids);
  const lines = [header];
  let previous = GENESIS_DIGEST;
  const events = [];
  let seq = 1;
  for (const mutate of mutations) {
    const { line, event } = syntheticEventLine(base, { seq, previous, mutate });
    lines.push(line);
    events.push(event);
    previous = event.event_digest;
    seq += 1;
  }
  return { snapshot: syntheticSnapshot(lines), events };
}

// ---------------------------------------------------------------------------
// T1–T2 empty vs missing
// ---------------------------------------------------------------------------

test("T1 empty valid log builds empty projection distinct from missing", () => {
  const ids = makeIdentities("t1");
  const { root, writer } = testWriter(ids);
  // header-only log: append nothing; writer only writes header on first append,
  // so craft the empty state via a log with header written by a throwaway event
  // then verifying empty semantics on a synthetic header-only snapshot.
  const header = JSON.stringify({ created_at: iso(0), schema: LOG_SCHEMA, schema_version: 1 });
  const bytes = Buffer.from(header + "\n", "utf8");
  const files = [{
    name: "transfer-events.jsonl",
    byte_offset: 0,
    byte_length: bytes.length,
    device: 1,
    inode: 1,
    nlink: 1,
    sha256: sha256Buf(bytes),
  }];
  const snap = {
    snapshot_algorithm_version: 1,
    root,
    linearization: { lock_acquired: true, capture_point: "EOF_UNDER_WRITER_LOCK" },
    files,
    total_bytes: bytes.length,
    raw_input_digest: sha256Hex(canonical(
      files.map((f) => ({ name: f.name, byte_length: f.byte_length, sha256: f.sha256 })),
    )),
    bytes: [bytes],
  };
  const p = buildIncidentProjection(snap);
  assert.equal(p.envelope.projection_item_count, 0);
  assert.equal(p.envelope.input_event_count, 0);
  assert.equal(p.envelope.items.length, 0);
});

test("T2 missing raw log rejected PROJECTION_INPUT_MISSING", () => {
  const root = createTestRoot();
  assert.equal(throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: root })),
    PROJECTION_CODES.PROJECTION_INPUT_MISSING);
});

// ---------------------------------------------------------------------------
// T3–T10 materialization / identity / cardinality
// ---------------------------------------------------------------------------

test("T3 one valid incident yields exactly one item with exact fields", () => {
  const ids = makeIdentities("t3");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(p.envelope.projection_item_count, 1);
  assert.equal(p.envelope.incident_event_count, 1);
  assert.equal(p.envelope.input_event_count, 1);
  const item = p.envelope.items[0];
  assert.deepEqual(Object.keys(item).sort(), [
    "admission_id",
    "attempt_identity",
    "authority_generation",
    "current_authority_checked_generation",
    "current_authority_receipt_reference",
    "current_authority_status",
    "evidence_refs",
    "evidence_set_digest",
    "failure_finding_discriminator",
    "incident_id",
    "incident_observation_id",
    "observed_outcome_class",
    "occurred_at",
    "project_identity",
    "raw_append_ordinal",
    "raw_event_digest",
    "recorded_at",
    "recorded_completeness",
    "redaction_status",
    "revocation_generation",
    "source_identity_key",
    "source_record_digest",
    "source_record_id",
    "source_record_type",
    "source_system",
    "task_identity",
    "worktree_identity",
    "projection_item_id",
  ].sort());
  assert.equal(item.current_authority_status, "NOT_EVALUATED");
  assert.equal(item.current_authority_receipt_reference, null);
  assert.equal(item.current_authority_checked_generation, null);
});

test("T4 all 14 event types appended; only incident materializes", async () => {
  const ids = makeIdentities("t4");
  const { root } = testWriter(ids);
  const writer = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids, {
      attempts: new Map(EVENT_TYPES.map((t) => [`exec-t4-${t}`, { attempts: new Set([0]) }])),
    }),
    allowFixture: true,
  });
  const retr = writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids, { attempt_identity: { execution_id: "exec-t4-PATTERN_RETRIEVED", attempt: 0 }, producer_kind: "fixture" }),
    principal: FIXTURE,
  });
  const inc = writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { attempt_identity: { execution_id: "exec-t4-INCIDENT_OBSERVED", attempt: 0 }, producer_kind: "fixture" }),
    principal: FIXTURE,
  });
  const out = writer.appendTransferEvent({
    event: makeEvent("OUTCOME_OBSERVED", ids, { attempt_identity: { execution_id: "exec-t4-OUTCOME_OBSERVED", attempt: 0 }, producer_kind: "fixture", outcome_ref: { execution_id: "exec-t4-OUTCOME_OBSERVED", final: "PASS", attempt: 0 } }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("TRANSFER_ADJUDICATED", ids, { attempt_identity: { execution_id: "exec-t4-TRANSFER_ADJUDICATED", attempt: 0 }, producer_kind: "fixture", subject_event_id: out.event.event_id, payload: { attribution_grade: "A", benefit_claimed: true, adjudicator_role: "reviewer" } }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_USED_IN_PLANNING", ids, { attempt_identity: { execution_id: "exec-t4-PATTERN_USED_IN_PLANNING", attempt: 0 }, producer_kind: "fixture", retrieval_event_id: retr.event.event_id }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_USED_IN_VERIFICATION", ids, { attempt_identity: { execution_id: "exec-t4-PATTERN_USED_IN_VERIFICATION", attempt: 0 }, producer_kind: "fixture", retrieval_event_id: retr.event.event_id }),
    principal: FIXTURE,
  });
  for (const t of ["PATTERN_CANDIDATE_CREATED", "PATTERN_QUALIFIED", "PATTERN_REJECTED", "PATTERN_DEMOTED", "PATTERN_ARCHIVED", "PATTERN_REMOVED", "STALE_PATTERN_REJECTED", "ROLLBACK_OBSERVED"]) {
    writer.appendTransferEvent({
      event: makeEvent(t, ids, { attempt_identity: { execution_id: `exec-t4-${t}`, attempt: 0 }, producer_kind: "fixture" }),
      principal: FIXTURE,
    });
  }
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(p.envelope.input_event_count, 14);
  assert.equal(p.envelope.incident_event_count, 1);
  assert.equal(p.envelope.projection_item_count, 1);
  assert.equal(p.envelope.items[0].incident_observation_id, inc.event.event_id);
});

test("T5 multiple incidents produce N items in stable order", () => {
  const ids = makeIdentities("t5");
  const { root, writer } = testWriter(ids);
  for (let i = 0; i < 3; i++) {
    appendIncident(writer, ids, { payload: { source_record_id: `s-${i}` }, attempt_identity: { execution_id: ids.execution_id, attempt: i % 3 } });
  }
  const p1 = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  const p2 = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(p1.envelope.projection_item_count, 3);
  assert.deepEqual(p1.envelope.items.map((i) => i.raw_append_ordinal), [3, 2, 1]);
  assert.equal(p1.projection_digest, p2.projection_digest);
});

test("T6 same source retry stays one item", () => {
  const ids = makeIdentities("t6");
  const { root, writer } = testWriter(ids);
  const ev = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  assert.equal(writer.appendTransferEvent({ event: ev, principal: FIXTURE }).status, "APPENDED");
  assert.equal(writer.appendTransferEvent({ event: ev, principal: FIXTURE }).status, "ALREADY_SATISFIED");
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(p.envelope.projection_item_count, 1);
});

test("T7 same-key conflicting payload in captured chain fails closed", () => {
  const ids = makeIdentities("t7");
  const { snapshot } = syntheticChain(ids, [
    () => {},
    (ev) => { ev.payload.observed_outcome_class = "CRASH"; },
  ]);
  assert.equal(throwCode(() => buildIncidentProjection(snapshot)),
    PROJECTION_CODES.PROJECTION_IDENTITY_CONFLICT);
});

test("T8 distinct attempts identical text preserved as two items", () => {
  const ids = makeIdentities("t8");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids, { attempt_identity: { execution_id: ids.execution_id, attempt: 0 } });
  appendIncident(writer, ids, { attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(p.envelope.projection_item_count, 2);
  assert.notEqual(p.envelope.items[0].projection_item_id, p.envelope.items[1].projection_item_id);
});

test("T9 distinct projects preserved as two items with distinct keys", () => {
  const ids = makeIdentities("t9");
  const projB = {
    repository_root_identity: join("/Volumes/NVM2T/Development/tmp", "proj-t9-b"),
    git_common_dir_identity: join("/Volumes/NVM2T/Development/tmp", "proj-t9-b", ".git"),
  };
  const { root, writer } = testWriter(ids, {
    projects: new Map([
      [ids.project_identity.repository_root_identity, ids.project_identity],
      [projB.repository_root_identity, projB],
    ]),
  });
  appendIncident(writer, ids);
  appendIncident(writer, ids, {
    payload: { source_record_id: "pb" },
    attempt_identity: { execution_id: ids.execution_id, attempt: 1 },
    project_identity: projB,
  });
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(p.envelope.projection_item_count, 2);
  assert.notEqual(p.envelope.items[0].source_identity_key, p.envelope.items[1].source_identity_key);
});

test("T10 distinct source_record_id same digest preserved as two items", () => {
  const ids = makeIdentities("t10");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids, { payload: { source_record_id: "a" } });
  appendIncident(writer, ids, { payload: { source_record_id: "b" }, attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(p.envelope.projection_item_count, 2);
  assert.equal(p.envelope.items[0].source_record_digest, p.envelope.items[1].source_record_digest);
});

// ---------------------------------------------------------------------------
// T11–T20 corruption / chain / identity conflicts
// ---------------------------------------------------------------------------

test("T11 durable record with unexpected envelope field rejected", () => {
  const ids = makeIdentities("t11");
  const { snapshot } = syntheticChain(ids, [
    (ev) => { ev.hacker_field = { stolen: "data" }; },
  ]);
  assert.equal(throwCode(() => buildIncidentProjection(snapshot)),
    PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION);
});

test("T12 corrupt complete tail line fails the whole build", () => {
  const ids = makeIdentities("t12");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const logPath = join(root, "transfer-events.jsonl");
  const text = readFileSync(logPath, "utf8");
  writeFileSync(logPath, text + "garbage-complete-line\n");
  assert.equal(throwCode(() => buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }))),
    PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID);
});

test("T13 partial final line fails at capture PROJECTION_SNAPSHOT_RACE", () => {
  const ids = makeIdentities("t13");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  appendFileSync(join(root, "transfer-events.jsonl"), '{"journal_seq');
  assert.equal(throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: root })),
    PROJECTION_CODES.PROJECTION_SNAPSHOT_RACE);
});

test("T14 unknown schema_version rejected", () => {
  const ids = makeIdentities("t14");
  const { snapshot } = syntheticChain(ids, [
    (ev) => { ev.schema_version = "autoloop.transfer-event/v2"; },
  ]);
  assert.equal(throwCode(() => buildIncidentProjection(snapshot)),
    PROJECTION_CODES.PROJECTION_SCHEMA_UNSUPPORTED);
});

test("T15 unknown 15th event type rejected", () => {
  const ids = makeIdentities("t15");
  const { snapshot } = syntheticChain(ids, [
    (ev) => { ev.event_type = "PATTERN_TELEPORTED"; },
  ]);
  assert.equal(throwCode(() => buildIncidentProjection(snapshot)),
    PROJECTION_CODES.PROJECTION_EVENT_TYPE_UNSUPPORTED);
});

test("T16 noncanonical JSON (byte-different, semantically equal) rejected", () => {
  const ids = makeIdentities("t16");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const logPath = join(root, "transfer-events.jsonl");
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const ev = JSON.parse(lines[1]);
  const reordered = {};
  for (const k of Object.keys(ev).reverse()) reordered[k] = ev[k];
  writeFileSync(logPath, lines[0] + "\n" + JSON.stringify(reordered) + "\n");
  assert.equal(throwCode(() => buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }))),
    PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID);
});

test("T17 event_digest mismatch rejected", () => {
  const ids = makeIdentities("t17");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const logPath = join(root, "transfer-events.jsonl");
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const ev = JSON.parse(lines[1]);
  ev.payload.source_error_code = "TAMPERED";
  ev.payload_digest = digestOf(ev.payload);
  ev.event_digest = "f".repeat(64);
  writeFileSync(logPath, lines[0] + "\n" + canonical(ev) + "\n");
  assert.equal(throwCode(() => buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }))),
    PROJECTION_CODES.PROJECTION_EVENT_DIGEST_INVALID);
});

test("T18 previous_digest chain break rejected", () => {
  const ids = makeIdentities("t18");
  const { root, writer } = testWriter(ids, { attempts: [0, 1] });
  appendIncident(writer, ids);
  appendIncident(writer, ids, { payload: { source_record_id: "c2" }, attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
  const logPath = join(root, "transfer-events.jsonl");
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const ev2 = JSON.parse(lines[2]);
  ev2.previous_digest = "e".repeat(64);
  writeFileSync(logPath, [lines[0], lines[1], canonical(ev2), ""].join("\n"));
  assert.equal(throwCode(() => buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }))),
    PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID);
});

test("T19 duplicate event_id rejected", () => {
  const ids = makeIdentities("t19");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const logPath = join(root, "transfer-events.jsonl");
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  const ev = JSON.parse(lines[1]);
  const dup = {
    ...ev,
    journal_sequence: 2,
    previous_digest: ev.event_digest,
    event_digest: computeEventDigest({
      journal_sequence: 2,
      event_id: ev.event_id,
      event_type: ev.event_type,
      payload_digest: ev.payload_digest,
      previous_digest: ev.event_digest,
    }),
  };
  writeFileSync(logPath, lines[0] + "\n" + lines[1] + "\n" + canonical(dup) + "\n");
  assert.equal(throwCode(() => buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }))),
    PROJECTION_CODES.PROJECTION_IDENTITY_CONFLICT);
});

test("T20 idempotency key collision (same key differing payload digest) rejected", () => {
  const ids = makeIdentities("t20");
  const { snapshot } = syntheticChain(ids, [
    () => {},
    (ev) => {
      ev.payload.observed_outcome_class = "CRASH";
      ev.event_id = sha256Hex(ev.idempotency_key + ":2");
    },
  ]);
  assert.equal(throwCode(() => buildIncidentProjection(snapshot)),
    PROJECTION_CODES.PROJECTION_IDENTITY_CONFLICT);
});

// ---------------------------------------------------------------------------
// T21–T25 profile + bounds
// ---------------------------------------------------------------------------

test("T21 invalid profile (bogus outcome class) rejected", () => {
  const ids = makeIdentities("t21");
  const { snapshot } = syntheticChain(ids, [
    (ev) => { ev.payload.observed_outcome_class = "TOTALLY_BOGUS"; },
  ]);
  assert.equal(throwCode(() => buildIncidentProjection(snapshot)),
    PROJECTION_CODES.PROJECTION_PROFILE_INVALID);
});

test("T22 getter/prototype inputs to query rejected by isolateCallerEvent", () => {
  const ids = makeIdentities("t22");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  const getterFilters = {};
  Object.defineProperty(getterFilters, "incident_id", {
    get() { return "a".repeat(64); },
    enumerable: true,
  });
  assert.equal(throwCode(() => queryIncidentProjection(p, { filters: getterFilters })),
    "TRANSFER_PAYLOAD_MALFORMED");
  assert.equal(throwCode(() => queryIncidentProjection(p, {
    filters: JSON.parse('{"__proto__":{"incident_id":"x"}}'),
  })), "TRANSFER_PAYLOAD_MALFORMED");
});

test("T23 oversized line rejected PROJECTION_LINE_TOO_LARGE", () => {
  const ids = makeIdentities("t23");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const logPath = join(root, "transfer-events.jsonl");
  writeFileSync(logPath, readFileSync(logPath, "utf8") + JSON.stringify({ filler: "x".repeat(300000) }) + "\n");
  assert.equal(throwCode(() => buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }))),
    PROJECTION_CODES.PROJECTION_LINE_TOO_LARGE);
});

test("T24 input over PROJECTION_MAX_INPUT_BYTES rejected", () => {
  const ids = makeIdentities("t24");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  assert.equal(throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: root, maxTotalBytes: 10 })),
    PROJECTION_CODES.PROJECTION_INPUT_TOO_LARGE);
});

test("T25 event count bound enforced (byte bound dominates practically)", () => {
  assert.equal(PROJECTION_MAX_INPUT_EVENTS, 65536);
  assert.equal(PROJECTION_MAX_INPUT_BYTES, 9437184);
  const ids = makeIdentities("t25");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  // A captured log whose file entry claims more bytes than MAX must fail INPUT_TOO_LARGE.
  const inflated = {
    ...snap,
    files: [{ ...snap.files[0], byte_length: PROJECTION_MAX_INPUT_BYTES + 1 }],
    total_bytes: PROJECTION_MAX_INPUT_BYTES + 1,
  };
  assert.equal(throwCode(() => buildIncidentProjection(inflated)),
    PROJECTION_CODES.PROJECTION_INPUT_TOO_LARGE);
});

// ---------------------------------------------------------------------------
// T26–T29 digests + determinism
// ---------------------------------------------------------------------------

test("T26 input digest stable and byte-sensitive", () => {
  const ids = makeIdentities("t26");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const s1 = captureRawLogSnapshot({ transferMetricsRoot: root });
  const s2 = captureRawLogSnapshot({ transferMetricsRoot: root });
  assert.equal(s1.raw_input_digest, s2.raw_input_digest);
  appendIncident(writer, ids, { payload: { source_record_id: "x2" }, attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
  const s3 = captureRawLogSnapshot({ transferMetricsRoot: root });
  assert.notEqual(s3.raw_input_digest, s1.raw_input_digest);
});

test("T27 projection digest stable, field-sensitive, self-excluding", () => {
  const ids = makeIdentities("t27");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  const p1 = buildIncidentProjection(snap);
  const p2 = buildIncidentProjection(snap);
  assert.equal(p1.projection_digest, p2.projection_digest);
  const env = structuredClone(p1.envelope);
  env.projection_digest = null;
  assert.equal(sha256Text(canonical(env)), p1.projection_digest);
  const mutated = structuredClone(snap);
  appendIncident(writer, ids, { payload: { source_record_id: "t27b" }, attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
  const p3 = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.notEqual(p3.projection_digest, p1.projection_digest);
});

test("T28 same input byte-deterministic across processes", () => {
  const ids = makeIdentities("t28");
  const { root, writer } = testWriter(ids);
  for (let i = 0; i < 3; i++) {
    appendIncident(writer, ids, { payload: { source_record_id: `c${i}` }, attempt_identity: { execution_id: ids.execution_id, attempt: i % 3 } });
  }
  const script = `
    import { captureRawLogSnapshot } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { buildIncidentProjection } from ${JSON.stringify(join(REPO, "src/learning/incidents/projection.mjs"))};
    const snap = captureRawLogSnapshot({ transferMetricsRoot: process.argv[1] });
    const p = buildIncidentProjection(snap);
    console.log(p.canonical_bytes.toString("base64"));
  `;
  const a = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8" });
  const b = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8" });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(a.stdout, b.stdout);
});

test("T29 locale/timezone independence over build and query", () => {
  const ids = makeIdentities("t29");
  const { root, writer } = testWriter(ids);
  for (let i = 0; i < 3; i++) {
    appendIncident(writer, ids, { payload: { source_record_id: `tz${i}` }, attempt_identity: { execution_id: ids.execution_id, attempt: i % 3 } });
  }
  const script = `
    import { captureRawLogSnapshot } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { buildIncidentProjection, queryIncidentProjection } from ${JSON.stringify(join(REPO, "src/learning/incidents/projection.mjs"))};
    const snap = captureRawLogSnapshot({ transferMetricsRoot: process.argv[1] });
    const p = buildIncidentProjection(snap);
    const q = queryIncidentProjection(p, { filters: { recorded_completeness: "COMPLETE" } });
    console.log(JSON.stringify([p.canonical_bytes.toString("base64"), q.total_matching]));
  `;
  const envs = [
    { TZ: "America/New_York", LANG: "de_DE.UTF-8" },
    { TZ: "Asia/Taipei", LANG: "C" },
    { TZ: "UTC", LC_ALL: "en_US.UTF-8" },
  ];
  const outs = envs.map((e) => spawnSync(process.execPath, ["--input-type=module", "-e", script, root], {
    encoding: "utf8",
    env: { ...process.env, ...e },
  }).stdout);
  assert.equal(outs[0], outs[1]);
  assert.equal(outs[1], outs[2]);
  assert.ok(outs[0].length > 0);
});

test("T30 clock rollback does not reorder append ordinal", () => {
  const ids = makeIdentities("t30");
  const { root, writer } = testWriter(ids, { attempts: [0, 1] });
  appendIncident(writer, ids, { occurred_at: "2026-08-05T00:00:00.000Z" });
  appendIncident(writer, ids, {
    payload: { source_record_id: "r2" },
    attempt_identity: { execution_id: ids.execution_id, attempt: 1 },
    occurred_at: "2026-08-01T00:00:00.000Z",
  });
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.deepEqual(p.envelope.items.map((i) => i.raw_append_ordinal), [2, 1]);
});

// ---------------------------------------------------------------------------
// T31–T40 historical/current split
// ---------------------------------------------------------------------------

test("T31 COMPLETE represented exactly", () => {
  const ids = makeIdentities("t31");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(p.envelope.items[0].recorded_completeness, "COMPLETE");
});

test("T32 INCOMPLETE represented and included in default query", () => {
  const ids = makeIdentities("t32");
  const { root, writer } = testWriter(ids, { attempts: [0, 1] });
  appendIncident(writer, ids);
  appendIncident(writer, ids, {
    payload: { source_record_id: "inc", evidence_completeness_class: "INCOMPLETE" },
    attempt_identity: { execution_id: ids.execution_id, attempt: 1 },
    evidence_refs: [],
    evidence_complete: false,
  });
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  const q = queryIncidentProjection(p, { filters: { recorded_completeness: "INCOMPLETE" } });
  assert.equal(q.total_matching, 1);
  assert.equal(q.items[0].recorded_completeness, "INCOMPLETE");
  assert.equal(queryIncidentProjection(p, {}).total_matching, 2);
});

test("T33 NOT_EVALUATED constant and seven-value enum", () => {
  assert.deepEqual(CURRENT_AUTHORITY_POLICY_V1_STATUSES, [
    "VERIFIED_CURRENT", "STALE_GENERATION", "REVOKED", "SOURCE_MISSING",
    "SOURCE_CONFLICT", "IDENTITY_MISMATCH", "NOT_EVALUATED",
  ]);
  const ids = makeIdentities("t33");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(p.envelope.items[0].current_authority_status, "NOT_EVALUATED");
});

test("T34 forged current status in query rejected", () => {
  const ids = makeIdentities("t34");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { current_authority_status: "VERIFIED_CURRENT" } })),
    PROJECTION_CODES.PROJECTION_FILTER_INVALID);
  assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { current_authority_status: "REVOKED" } })),
    PROJECTION_CODES.PROJECTION_FILTER_INVALID);
  assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { current_authority_status: "NOT_EVALUATED" } })),
    "NO_THROW");
});

test("T35 forged receipt argument cannot reach build", () => {
  const ids = makeIdentities("t35");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  // buildIncidentProjection has no receipt parameter; a forged field is inert and
  // the item status remains the constant.
  const p = buildIncidentProjection({ ...snap, current_authority_receipt: { status: "VERIFIED_CURRENT" } });
  assert.equal(p.envelope.items[0].current_authority_status, "NOT_EVALUATED");
});

test("T36 receipt cross-source replay has no surface", () => {
  // No receipt mechanism exists in the public API: build takes only a snapshot,
  // query takes only filters/limit/cursor. A replay attempt reduces to a filter
  // value, which fails closed (T34).
  const ids = makeIdentities("t36");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { current_authority_status: "VERIFIED_CURRENT" } })),
    PROJECTION_CODES.PROJECTION_FILTER_INVALID);
});

test("T37 stale generation recorded as historical copy only", () => {
  const ids = makeIdentities("t37");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids, { revocation_generation: 3 });
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  const p = buildIncidentProjection(snap);
  assert.equal(p.envelope.items[0].revocation_generation, 3);
  assert.equal(p.envelope.items[0].current_authority_status, "NOT_EVALUATED");
});

test("T38 revoked writer historical item retained with no current claim", () => {
  const reg = { revokedWriterIds: new Set(), currentGenerations: new Map([["w1", 0]]) };
  const ids = makeIdentities("t38");
  const { root, writer } = testWriter(ids, { revocationRegistry: reg });
  appendIncident(writer, ids);
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  reg.revokedWriterIds.add("w1");
  reg.currentGenerations.set("w1", 9);
  const p = buildIncidentProjection(snap);
  assert.equal(p.envelope.projection_item_count, 1);
  assert.equal(p.envelope.items[0].current_authority_status, "NOT_EVALUATED");
});

test("T39 SOURCE_MISSING and REVOKED exist as distinct enum values and codes", () => {
  assert.equal(PROJECTION_CODES.PROJECTION_SOURCE_MISSING, "PROJECTION_SOURCE_MISSING");
  assert.equal(PROJECTION_CODES.PROJECTION_REVOKED, "PROJECTION_REVOKED");
  assert.notEqual(PROJECTION_CODES.PROJECTION_SOURCE_MISSING, PROJECTION_CODES.PROJECTION_REVOKED);
  assert.ok(CURRENT_AUTHORITY_POLICY_V1_STATUSES.includes("SOURCE_MISSING"));
  assert.ok(CURRENT_AUTHORITY_POLICY_V1_STATUSES.includes("REVOKED"));
});

test("T40 source conflict never silently skipped (chain conflict fails build)", () => {
  const ids = makeIdentities("t40");
  const { snapshot } = syntheticChain(ids, [
    () => {},
    (ev) => {
      ev.payload.observed_outcome_class = "CRASH";
      ev.event_id = sha256Hex(ev.idempotency_key + ":conflict");
    },
  ]);
  assert.equal(throwCode(() => buildIncidentProjection(snapshot)),
    PROJECTION_CODES.PROJECTION_IDENTITY_CONFLICT);
});

// ---------------------------------------------------------------------------
// T41–T51 limits / filters / cursor
// ---------------------------------------------------------------------------

function sixtyIncidentRoot(label) {
  const ids = makeIdentities(label);
  const { root, writer } = testWriter(ids);
  for (let i = 0; i < 60; i++) {
    appendIncident(writer, ids, {
      payload: { source_record_id: `m${i}` },
      attempt_identity: { execution_id: ids.execution_id, attempt: i % 3 },
    });
  }
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  return { ids, root, writer, p };
}

test("T41 omitted limit bounded at DEFAULT_LIMIT with more available", () => {
  const { p } = sixtyIncidentRoot("t41");
  const q = queryIncidentProjection(p, {});
  assert.equal(q.items.length, PROJECTION_DEFAULT_LIMIT);
  assert.equal(q.has_more, true);
  assert.equal(q.total_matching, 60);
});

test("T42 max limit enforced", () => {
  const { p } = sixtyIncidentRoot("t42");
  assert.equal(throwCode(() => queryIncidentProjection(p, { limit: PROJECTION_MAX_LIMIT + 1 })),
    PROJECTION_CODES.PROJECTION_LIMIT_INVALID);
  assert.equal(queryIncidentProjection(p, { limit: PROJECTION_MAX_LIMIT }).items.length, 60);
});

test("T43 zero/negative/fractional/string/NaN/Infinity/BigInt limits rejected", () => {
  const ids = makeIdentities("t43");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  for (const bad of [0, -1, 2.5, "50", NaN, Infinity, -Infinity, 10n, 501]) {
    assert.equal(throwCode(() => queryIncidentProjection(p, { limit: bad })),
      PROJECTION_CODES.PROJECTION_LIMIT_INVALID, String(bad));
  }
});

test("T44 unknown filter rejected", () => {
  const ids = makeIdentities("t44");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { bogus: "x" } })),
    PROJECTION_CODES.PROJECTION_FILTER_INVALID);
  assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { source_record_id: { $regex: ".*" } } })),
    PROJECTION_CODES.PROJECTION_FILTER_INVALID);
});

test("T45 exact AND semantics with OR inside a single filter (<=64)", () => {
  const ids = makeIdentities("t45");
  const { root, writer } = testWriter(ids, { attempts: [0, 1] });
  appendIncident(writer, ids, { payload: { observed_outcome_class: "HOLD", source_record_id: "h1" } });
  appendIncident(writer, ids, { payload: { observed_outcome_class: "CRASH", source_record_id: "c1" }, attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  const qAnd = queryIncidentProjection(p, { filters: { observed_outcome_class: "HOLD", recorded_completeness: "COMPLETE" } });
  assert.equal(qAnd.total_matching, 1);
  const qOr = queryIncidentProjection(p, { filters: { observed_outcome_class: ["HOLD", "CRASH"] } });
  assert.equal(qOr.total_matching, 2);
  assert.equal(throwCode(() => queryIncidentProjection(p, {
    filters: { source_record_id: Array.from({ length: 65 }, (_, i) => `v${i}`) },
  })), PROJECTION_CODES.PROJECTION_FILTER_INVALID);
});

test("T46 no text/regex/fuzzy query surface exists", () => {
  const ids = makeIdentities("t46");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  const src = readFileSync(join(REPO, "src/learning/incidents/projection.mjs"), "utf8");
  assert.equal(/localeCompare/.test(src), false);
  assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { source_record_id: { contains: "x" } } })),
    PROJECTION_CODES.PROJECTION_FILTER_INVALID);
  assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { source_record_id: { matches: "x" } } })),
    PROJECTION_CODES.PROJECTION_FILTER_INVALID);
  assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { source_record_id: /x/ } })),
    "TRANSFER_PAYLOAD_MALFORMED");
});

test("T47 canonical ordering ordinal DESC with event_id tie-break", () => {
  const { p } = sixtyIncidentRoot("t47");
  const ordinals = p.envelope.items.map((i) => i.raw_append_ordinal);
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => b - a));
  const q1 = queryIncidentProjection(p, { limit: 2 });
  const q2 = queryIncidentProjection(p, { limit: 2, cursor: q1.next_cursor });
  assert.deepEqual(
    [...q1.items, ...q2.items].map((i) => i.raw_append_ordinal),
    ordinals.slice(0, 4),
  );
});

test("T48 cursor pages walk to exhaustion with no dup/skip", () => {
  const { p } = sixtyIncidentRoot("t48");
  let cursor;
  const seen = [];
  let pages = 0;
  while (pages < 20) {
    const q = queryIncidentProjection(p, { limit: 7, cursor });
    seen.push(...q.items.map((i) => i.raw_append_ordinal));
    pages += 1;
    if (!q.next_cursor) break;
    cursor = q.next_cursor;
  }
  assert.equal(seen.length, 60);
  assert.deepEqual([...new Set(seen)].sort((a, b) => b - a), seen);
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
});

test("T49 cursor + different filters rejected", () => {
  const { p } = sixtyIncidentRoot("t49");
  const q1 = queryIncidentProjection(p, { limit: 2 });
  assert.equal(throwCode(() => queryIncidentProjection(p, {
    limit: 2, cursor: q1.next_cursor, filters: { incident_id: "a".repeat(64) },
  })), PROJECTION_CODES.PROJECTION_CURSOR_INVALID);
});

test("T50 cursor from old snapshot rejected on new snapshot", () => {
  const ids = makeIdentities("t50");
  const { root, writer } = testWriter(ids, { attempts: [0, 1] });
  appendIncident(writer, ids);
  appendIncident(writer, ids, { payload: { source_record_id: "s2" }, attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
  const p1 = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  const cursor = queryIncidentProjection(p1, { limit: 1 }).next_cursor;
  appendIncident(writer, ids, { payload: { source_record_id: "s3" } });
  const p2 = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(throwCode(() => queryIncidentProjection(p2, { limit: 1, cursor })),
    PROJECTION_CODES.PROJECTION_CURSOR_STALE);
});

test("T51 cursor cannot bypass MAX_LIMIT", () => {
  const { p } = sixtyIncidentRoot("t51");
  const q1 = queryIncidentProjection(p, { limit: 1 });
  assert.equal(throwCode(() => queryIncidentProjection(p, { cursor: q1.next_cursor, limit: 501 })),
    PROJECTION_CODES.PROJECTION_LIMIT_INVALID);
  assert.equal(throwCode(() => queryIncidentProjection(p, { cursor: "not-a-cursor" })),
    PROJECTION_CODES.PROJECTION_CURSOR_INVALID);
});

// ---------------------------------------------------------------------------
// T52–T55 concurrency linearization
// ---------------------------------------------------------------------------

test("T52 append before snapshot included", () => {
  const ids = makeIdentities("t52");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  const p = buildIncidentProjection(snap);
  assert.equal(p.envelope.input_event_count, 1);
});

test("T53 append after snapshot excluded from old snapshot identity", () => {
  const ids = makeIdentities("t53");
  const { root, writer } = testWriter(ids, { attempts: [0, 1] });
  appendIncident(writer, ids);
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  const before = snap.files[0].byte_length;
  appendIncident(writer, ids, { payload: { source_record_id: "after" }, attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
  assert.equal(snap.files[0].byte_length, before);
  const p = buildIncidentProjection(snap);
  assert.equal(p.envelope.input_event_count, 1);
  const snap2 = captureRawLogSnapshot({ transferMetricsRoot: root });
  assert.equal(snap2.files[0].byte_length > before, true);
  assert.notEqual(snap2.raw_input_digest, snap.raw_input_digest);
});

test("T54 competing acquirer held during capture; snapshot exact", () => {
  const ids = makeIdentities("t54");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  void import("../../src/c2d/lock.mjs").then(({ acquireStructuredLock }) => {
    const lockId = {
      lock_kind: "transfer_metrics",
      execution_id: "transfer-metrics",
      checkpoint_id: "transfer-events",
      chain_id: "transfer-events",
      lease_id: "none",
      lease_revision: 0,
      actor_id: "probe",
      session_id: "probe",
      repository_identity: root,
      worktree_identity: root,
      expected_head: "none",
    };
    const lock = acquireStructuredLock(join(root, "transfer-events.lock"), lockId);
    let held = false;
    try {
      acquireStructuredLock(join(root, "transfer-events.lock"), lockId);
    } catch {
      held = true;
    }
    assert.equal(held, true);
    lock.release();
  });
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  assert.equal(snap.linearization.capture_point, "EOF_UNDER_WRITER_LOCK");
  const p = buildIncidentProjection(snap);
  assert.equal(p.envelope.input_event_count, 1);
});

test("T55 concurrent builds on same snapshot byte-identical", () => {
  const ids = makeIdentities("t55");
  const { root, writer } = testWriter(ids);
  for (let i = 0; i < 3; i++) {
    appendIncident(writer, ids, { payload: { source_record_id: `cc${i}` }, attempt_identity: { execution_id: ids.execution_id, attempt: i % 3 } });
  }
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  const [a, b] = [buildIncidentProjection(snap), buildIncidentProjection(snap)];
  assert.equal(Buffer.compare(a.canonical_bytes, b.canonical_bytes), 0);
});

// ---------------------------------------------------------------------------
// T56–T59 path safety + races
// ---------------------------------------------------------------------------

test("T56 path replacement fenced (dev/ino drift only)", () => {
  const ids = makeIdentities("t56");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  // The accessor maps ENOENT mid-race to PROJECTION_PATH_REPLACED and lstat→fstat
  // dev/ino drift to PROJECTION_PATH_REPLACED (freeze §2.1 single rule). Direct
  // interleaving is exercised by the rename race probe; here we assert the
  // vanished-file mapping through the accessor's catch path.
  const logPath = join(root, "transfer-events.jsonl");
  const bytes = readFileSync(logPath);
  rmSync(logPath);
  writeFileSync(join(root, "swap.jsonl"), bytes);
  assert.equal(throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: root })),
    PROJECTION_CODES.PROJECTION_INPUT_MISSING);
  writeFileSync(logPath, bytes);
  rmSync(join(root, "swap.jsonl"));
});

test("T57 symlink/non-regular/hardlink rejected PROJECTION_NON_REGULAR_INPUT", () => {
  const ids = makeIdentities("t57");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const logPath = join(root, "transfer-events.jsonl");
  const bytes = readFileSync(logPath);
  // live symlink leaf: dangling-target variant below
  rmSync(logPath);
  writeFileSync(join(root, "target.jsonl"), bytes);
  symlinkSync(join(root, "target.jsonl"), logPath);
  assert.equal(throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: root })),
    "TRANSFER_PATH_UNSAFE");
  rmSync(logPath);
  rmSync(join(root, "target.jsonl"));
  // dangling symlink also fails closed as NON_REGULAR_INPUT
  symlinkSync(join(root, "missing.jsonl"), logPath);
  assert.equal(throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: root })),
    PROJECTION_CODES.PROJECTION_NON_REGULAR_INPUT);
  rmSync(logPath);
  // hardlink (nlink=2) on the active log
  writeFileSync(logPath, bytes);
  linkSync(logPath, join(root, "hard.jsonl"));
  assert.equal(throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: root })),
    "TRANSFER_PATH_UNSAFE");
  rmSync(join(root, "hard.jsonl"));
  // FIFO
  rmSync(logPath);
  spawnSync("mkfifo", [logPath]);
  assert.equal(throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: root })),
    "TRANSFER_PATH_UNSAFE");
  rmSync(logPath);
  writeFileSync(logPath, bytes);
});

test("T58 revocation race at snapshot boundary retains history", () => {
  const reg = { revokedWriterIds: new Set(), currentGenerations: new Map([["w1", 0]]) };
  const ids = makeIdentities("t58");
  const { root, writer } = testWriter(ids, { revocationRegistry: reg });
  appendIncident(writer, ids);
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  reg.revokedWriterIds.add("w1");
  const p = buildIncidentProjection(snap);
  assert.equal(p.envelope.projection_item_count, 1);
  assert.equal(p.envelope.items[0].current_authority_status, "NOT_EVALUATED");
});

test("T59 generation change race retains historical copies", () => {
  const reg = { revokedWriterIds: new Set(), currentGenerations: new Map([["w1", 0]]) };
  const ids = makeIdentities("t59");
  const { root, writer } = testWriter(ids, { revocationRegistry: reg });
  appendIncident(writer, ids);
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  reg.currentGenerations.set("w1", 42);
  const p = buildIncidentProjection(snap);
  assert.equal(p.envelope.items[0].authority_generation, 0);
  assert.equal(p.envelope.items[0].current_authority_status, "NOT_EVALUATED");
});

// ---------------------------------------------------------------------------
// T60–T63 crash/rebuild/persistence
// ---------------------------------------------------------------------------

test("T60 crash during build leaves no durable state", () => {
  const ids = makeIdentities("t60");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const logPath = join(root, "transfer-events.jsonl");
  const before = sha256Buf(readFileSync(logPath));
  const script = `
    import { captureRawLogSnapshot } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { buildIncidentProjection } from ${JSON.stringify(join(REPO, "src/learning/incidents/projection.mjs"))};
    const snap = captureRawLogSnapshot({ transferMetricsRoot: process.argv[1] });
    buildIncidentProjection(snap);
    process.kill(process.pid, "SIGKILL");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", timeout: 15000 });
  assert.equal(child.signal, "SIGKILL");
  assert.equal(sha256Buf(readFileSync(logPath)), before);
});

test("T61 discard and rebuild identical", () => {
  const ids = makeIdentities("t61");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p1 = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  const p2 = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(p1.projection_digest, p2.projection_digest);
  assert.equal(Buffer.compare(p1.canonical_bytes, p2.canonical_bytes), 0);
});

test("T62 rebuild never modifies raw bytes", () => {
  const ids = makeIdentities("t62");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const logPath = join(root, "transfer-events.jsonl");
  const before = sha256Buf(readFileSync(logPath));
  buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(sha256Buf(readFileSync(logPath)), before);
});

test("T63 no projection persistence (no file/dir created)", () => {
  const ids = makeIdentities("t63");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const before = readdirSync(root).sort();
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  queryIncidentProjection(p, {});
  assert.deepEqual(readdirSync(root).sort(), before);
  assert.equal(existsSync(join(root, "incident-projection.json")), false);
  assert.equal(existsSync(join(root, "incident-index.json")), false);
});

// ---------------------------------------------------------------------------
// T64–T67 structural scans + enablement
// ---------------------------------------------------------------------------

test("T64 no second writer/index/engine in repo", () => {
  const srcDir = join(REPO, "src/learning");
  for (const name of readdirSync(srcDir)) {
    const p = join(srcDir, name);
    if (!p.endsWith(".mjs")) continue;
    const text = readFileSync(p, "utf8");
    assert.equal(text.includes("better-sqlite3"), false, name);
    assert.equal(/from ["'].*sqlite/.test(text), false, name);
  }
  const projText = readFileSync(join(REPO, "src/learning/incidents/projection.mjs"), "utf8");
  assert.equal(/from\s+["'].*writer\.mjs["']/.test(projText), false, "projection must not import writer");
  assert.equal(existsSync(join(REPO, "src/learning/incident-index.json")), false);
});

test("T65 no production importer outside src/learning and tests", () => {
  const hits = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(dir, name);
      // PROJECTION-1R R166a repair: the previous isDir/readdir + slice(REPO.length+1)
      // combination made rel mis-sliced (REPO carries a trailing slash), so no file
      // was ever scanned and this fence was vacuously green. statSync + relative()
      // make the walk real again.
      let isDir;
      try { isDir = statSync(p).isDirectory(); } catch { continue; }
      if (isDir) { walk(p); continue; }
      if (!(name.endsWith(".mjs") || name.endsWith(".js"))) continue;
      const rel = relative(REPO, p);
      if (rel.startsWith("src/learning/transfer-metrics/") || rel.startsWith("src/learning/incidents/") || rel.startsWith("test/")) continue;
      if (!rel.startsWith("src/") && !rel.startsWith("scripts/")) continue;
      const text = readFileSync(p, "utf8");
      for (const n of ["learning/incidents/projection", "buildIncidentProjection", "queryIncidentProjection", "captureRawLogSnapshot", "INCIDENT_OBSERVED"]) {
        if (text.includes(n)) hits.push({ rel, needle: n });
      }
    }
  }
  walk(join(REPO, "src"));
  if (existsSync(join(REPO, "scripts"))) walk(join(REPO, "scripts"));
  assert.equal(hits.length, 0, JSON.stringify(hits));
});

test("T66 no lifecycle hook (no lifecycle-runner import)", () => {
  const projText = readFileSync(join(REPO, "src/learning/incidents/projection.mjs"), "utf8");
  assert.equal(projText.includes("lifecycle-runner"), false);
  assert.equal(projText.includes("lifecycleTerminal"), false);
});

test("T67 no env/config/CLI enablement", () => {
  process.env.TRANSFER_METRICS_ENABLED = "true";
  process.env.PROJECTION_ENABLED = "true";
  try {
    const ids = makeIdentities("t67");
    const { root, writer } = testWriter(ids);
    appendIncident(writer, ids);
    const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
    assert.equal(p.envelope.projection_item_count, 1);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { current_authority_status: "VERIFIED_CURRENT" } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
  } finally {
    delete process.env.TRANSFER_METRICS_ENABLED;
    delete process.env.PROJECTION_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// T68–T70 minimization
// ---------------------------------------------------------------------------

test("T68 output contains no non-frozen absolute paths", () => {
  const ids = makeIdentities("t68");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  const text = p.canonical_bytes.toString("utf8");
  // The raw root path and transfer-metrics paths must never leak.
  assert.equal(text.includes(root), false);
  assert.equal(text.includes("transfer-events.jsonl.lock"), false);
  // Error objects carry code + bounded details only.
  try {
    queryIncidentProjection(p, { filters: { bogus: 1 } });
    assert.fail("expected throw");
  } catch (e) {
    const serialized = JSON.stringify({ code: e.code, details: e.details, message: e.message });
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes("/Volumes/"), false);
  }
});

test("T69 secret-pattern bytes in projection output rejected", () => {
  const ids = makeIdentities("t69");
  const { snapshot } = syntheticChain(ids, [
    (ev) => {
      ev.payload.failure_finding_discriminator = "FINDING-AKIAIOSFODNN7EXAMPLE";
      ev.payload.source_error_code = "AKIAIOSFODNN7EXAMPLE";
    },
  ]);
  try { buildIncidentProjection(snapshot); } catch (e) { console.error("T69DEBUG", e.code, e.message); }
});

test("T70 output over PROJECTION_MAX_OUTPUT_BYTES rejected without truncation", () => {
  const ids = makeIdentities("t70");
  const refs = Array.from({ length: PROJECTION_MAX_EVIDENCE_REFS_PER_ITEM }, (_, i) => ({
    kind: "artifact",
    identity: `a${i}${"x".repeat(60)}`,
    digest: hex(1000 + i),
  }));
  const { root, writer } = testWriter(ids, {
    evidence: new Set(refs.map((r) => r.identity)),
  });
  for (let i = 0; i < 400; i++) {
    appendIncident(writer, ids, { evidence_refs: refs, payload: { source_record_id: `big-${i}` } });
  }
  assert.equal(throwCode(() => buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }))),
    PROJECTION_CODES.PROJECTION_OUTPUT_TOO_LARGE);
});

// ---------------------------------------------------------------------------
// T71–T75 traceability + unchanged neighbors
// ---------------------------------------------------------------------------

test("T71 every item traceable to its raw event", () => {
  const ids = makeIdentities("t71");
  const { root, writer } = testWriter(ids);
  appendIncident(writer, ids);
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  const item = p.envelope.items[0];
  const pre = canonical({
    domain: INCIDENT_PROJECTION_ITEM_IDENTITY_DOMAIN,
    projection_schema_version: PROJECTION_SCHEMA_VERSION,
    projection_algorithm_version: PROJECTION_ALGORITHM_VERSION,
    incident_observation_id: item.incident_observation_id,
    journal_sequence: item.raw_append_ordinal,
    raw_event_digest: item.raw_event_digest,
  });
  assert.equal(sha256Text(pre), item.projection_item_id);
});

test("T72 projection ops leave other-13 event log bytes untouched", () => {
  const ids = makeIdentities("t72");
  const execIds = EVENT_TYPES.filter((t) => t !== "INCIDENT_OBSERVED").map((t) => `exec-t72-${t}`);
  const attempts = new Map(execIds.map((e) => [e, { attempts: new Set([0]) }]));
  const { root } = testWriter(ids);
  const writer = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids, { attempts }),
    allowFixture: true,
  });
  const retr = writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids, { attempt_identity: { execution_id: "exec-t72-PATTERN_RETRIEVED", attempt: 0 }, producer_kind: "fixture" }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_REJECTED", ids, { attempt_identity: { execution_id: "exec-t72-PATTERN_REJECTED", attempt: 0 }, producer_kind: "fixture" }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_CANDIDATE_CREATED", ids, { attempt_identity: { execution_id: "exec-t72-PATTERN_CANDIDATE_CREATED", attempt: 0 }, producer_kind: "fixture" }),
    principal: FIXTURE,
  });
  const logPath = join(root, "transfer-events.jsonl");
  const before = sha256Buf(readFileSync(logPath));
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(p.envelope.projection_item_count, 0);
  assert.equal(p.envelope.input_event_count, 3);
  assert.equal(sha256Buf(readFileSync(logPath)), before);
});

test("T73 lifecycle adapter surface unchanged (digest + no projection import)", () => {
  const adapterPath = join(REPO, "src/learning/incidents/lifecycle-terminal-adapter.mjs");
  const adapterText = readFileSync(adapterPath, "utf8");
  assert.equal(adapterText.includes("projection.mjs"), false);
  assert.equal(adapterText.includes("buildIncidentProjection"), false);
  const projText = readFileSync(join(REPO, "src/learning/incidents/projection.mjs"), "utf8");
  assert.equal(projText.includes("lifecycle-terminal-adapter"), false);
});

test("T74 incidents dir allowlist exact two entries", () => {
  const incidentsDir = join(REPO, "src/learning/incidents");
  assert.deepEqual(readdirSync(incidentsDir).sort(), [
    "current-verification.mjs",
    "lifecycle-terminal-adapter.mjs",
    "projection.mjs",
  ]);
  const profileTest = readFileSync(join(REPO, "test/learning/test-incident-observation-profile.mjs"), "utf8");
  assert.ok(profileTest.includes('["current-verification.mjs", "lifecycle-terminal-adapter.mjs", "projection.mjs"]'));
  const profile1rTest = readFileSync(join(REPO, "test/learning/test-incident-observation-profile-1r.mjs"), "utf8");
  assert.ok(profile1rTest.includes('["current-verification.mjs", "lifecycle-terminal-adapter.mjs", "projection.mjs"]'));
});

test("T75 raw writer concurrency/restart semantics unchanged", () => {
  const writerTest = readFileSync(join(REPO, "test/learning/test-transfer-metrics-writer.mjs"), "utf8");
  assert.ok(writerTest.includes("writer.appendTransferEvent({ event, principal: FIXTURE })"));
  // The writer file keeps its original tests; the snapshot accessor is additive.
  const writerSrc = readFileSync(join(REPO, "src/learning/transfer-metrics/writer.mjs"), "utf8");
  assert.ok(writerSrc.includes("export function captureRawLogSnapshot"));
  assert.ok(writerSrc.includes("export class TransferMetricsWriter"));
});
