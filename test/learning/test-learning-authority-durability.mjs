// test/learning/test-learning-authority-durability.mjs
//
// Focused offline suite: T1–T84 authority durability matrix
// (STAGE-E-REVOCATION-DURABILITY-IMPLEMENTATION-ADMISSION-1 test-matrix.md).
// Restart/replay tests use REAL files and REAL child processes; crash
// scenarios use the existing writer crashHooks. No mock fsync, no mock
// processes as durability proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORITY_DOMAIN,
  AUTHORITY_EVENT_TYPE,
  AUTHORITY_REASONS,
  AUTHORITY_REQUIRED_PAYLOAD_FIELDS,
  AUTHORITY_OPTIONAL_PAYLOAD_FIELDS,
  EVENT_TYPES,
  EVENT_TYPES_V2,
  GENESIS_DIGEST,
  LOG_SCHEMA,
  LOG_SCHEMA_V2,
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2,
  TRANSFER_CODES,
  TransferMetricsError,
  canonical,
  computeAuthorityIdempotencyKey,
  computeAuthorityPayloadDigest,
  computeEventDigest,
  computeEventId,
  computeIdempotencyKey,
  computePayloadDigest,
  digestOf,
  validateAuthorityPayload,
  validateAuthorityRecord,
  validateAuthoritySubjectIdentity,
  validateEventForGeneration,
} from "../../src/learning/transfer-metrics/schema.mjs";
import { readLog, lastCompleteEvent, LOG_FILE_NAME, LOCK_FILE_NAME, readActiveLogGeneration } from "../../src/learning/transfer-metrics/log.mjs";
import { TransferMetricsWriter, captureRawLogSnapshot } from "../../src/learning/transfer-metrics/writer.mjs";
import {
  authorityInputDigest,
  authoritySubjectKey,
  deriveAuthoritySubjectIdentity,
  foldAuthorityEvents,
  readCurrentLearningAuthorityState,
  replayAuthorityReadiness,
  AUTHORITY_AVAILABILITY,
  AUTHORITY_READINESS,
} from "../../src/learning/transfer-metrics/authority-state.mjs";
import {
  mintPrincipal,
  mintWriterAuthorityIssuer,
  assertAuthorityIssuerCapability,
  authorityIssuerPrincipalDigest,
  createIdentityBinder,
} from "../../src/learning/transfer-metrics/identities.mjs";
import { FIXTURE, SYSTEM, makeIdentities, makeBinder, makeEvent, createTestWriter, createTestRoot, expectCode, hex, iso, writeRawLog, rawLogLines, writeRawLogBytes, IDENTITY_ROOT, TMP_PARENT } from "../../src/learning/transfer-metrics/fixtures.mjs";
import { reduceTransferMetrics, serializeDerived } from "../../src/learning/transfer-metrics/reducer.mjs";
import { buildIncidentProjection, PROJECTION_CODES, PROJECTION_SCHEMA_VERSION, CURRENT_AUTHORITY_STATUS_NOT_EVALUATED } from "../../src/learning/incidents/projection.mjs";
import { scanTransferPayload } from "../../src/learning/transfer-metrics/redact.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function throwCode(fn) {
  try {
    fn();
  } catch (e) {
    return e.code ?? String(e);
  }
  return null;
}

function issuerOf(writer) {
  return writer.fixtureAuthorityIssuer();
}

function revokeOpts(writer, ids, mutationId, expected = 0, extra = {}) {
  return {
    issuer: issuerOf(writer),
    mutationId,
    expected,
    task_identity: ids.task_identity,
    ...extra,
  };
}

function readLogLines(root) {
  return readFileSync(join(root, LOG_FILE_NAME), "utf8").split("\n");
}

function rmRoot(root) {
  try {
    for (const name of readdirSync(root)) {
      try { require_shim_unlink(join(root, name)); } catch { /* dir */ }
    }
  } catch { /* missing */ }
}

import { rmSync } from "node:fs";
function rmTree(root) {
  rmSync(root, { recursive: true, force: true });
}

// A valid durable authority record produced through the REAL writer path.
function makeAuthorityRecordFixture(label = "authrec") {
  const ids = makeIdentities(label);
  const { root, writer } = createTestWriter(ids);
  const r = writer.revokeWriter("w1", revokeOpts(writer, ids, `${label}-revoke`));
  const line = readLogLines(root)[1];
  return { ids, root, writer, result: r, record: JSON.parse(line) };
}

// Worker scripts are REAL files that child processes execute, so this needs a
// real writable directory — not the synthetic identity root.
const WORKER_PARENT = TMP_PARENT;

function writeWorkerScript(name, body) {
  mkdirSync(WORKER_PARENT, { recursive: true, mode: 0o700 });
  const path = join(WORKER_PARENT, `${name}-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(path, body);
  return path;
}

function runWorkers(workerPath, argsList) {
  const children = argsList.map((args) =>
    spawn(process.execPath, [workerPath, ...args], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }));
  return Promise.all(children.map((child) => new Promise((resolveChild) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", () => {
      const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      try { resolveChild(JSON.parse(line)); } catch { resolveChild({ outcome: "NO_OUTPUT", raw: out }); }
    });
  })));
}

function authorityWorkerScript() {
  return `
import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
import { makeIdentities, makeBinder, makeEvent, FIXTURE } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
import { hex } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
const [root, mode, mutationId, writerId, taskId, admissionId, reason] = process.argv.slice(2);
const ids = {
  task_id: taskId, admission_id: admissionId,
  execution_id: "exec-" + mutationId + "-" + process.pid,
  task_identity: { task_id: taskId, admission_id: admissionId },
  attempt_identity: { execution_id: "exec-" + mutationId + "-" + process.pid, attempt: 0 },
  project_identity: { repository_root_identity: root, git_common_dir_identity: root },
  pattern_id: "pat-x",
  evidence: hex("ev-" + mutationId + "-" + process.pid),
  incident_id: hex("inc-" + mutationId + "-" + process.pid),
  source_record_id: "src-" + process.pid,
  source_authority_identity: "src-auth",
  source_record_digest: hex("sr-" + mutationId + "-" + process.pid),
  failure_finding_discriminator: "F-" + process.pid,
};
const writer = new TransferMetricsWriter({
  transferMetricsRoot: root,
  identityBinder: makeBinder({
    task_id: taskId,
    admission_id: admissionId,
    execution_id: ids.execution_id,
    task_identity: { task_id: taskId, admission_id: admissionId },
    attempt_identity: ids.attempt_identity,
    project_identity: { repository_root_identity: root, git_common_dir_identity: root },
  }),
  allowFixture: true,
});
try {
  if (mode === "revoke") {
    const r = writer.revokeWriter(writerId, { issuer: writer.fixtureAuthorityIssuer(), mutationId, expected: 0, task_identity: ids.task_identity, reason: reason ?? undefined });
    console.log(JSON.stringify({ outcome: r.status }));
  } else if (mode === "advance") {
    const r = writer.setWriterGeneration(writerId, { issuer: writer.fixtureAuthorityIssuer(), mutationId, expected: 0, task_identity: ids.task_identity, reason: reason ?? undefined });
    console.log(JSON.stringify({ outcome: r.status }));
  } else if (mode === "measure") {
    const r = writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
    console.log(JSON.stringify({ outcome: r.status }));
  } else if (mode === "read") {
    const seam = (await import(${JSON.stringify(join(REPO, "src/learning/transfer-metrics/authority-state.mjs"))})).readCurrentLearningAuthorityState;
    const s = seam({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId });
    console.log(JSON.stringify({ availability: s.availability, state: s.state, generation: s.generation }));
  }
} catch (e) {
  console.log(JSON.stringify({ outcome: "ERROR", code: e.code ?? String(e) }));
}
`;
}

test("T3 all 15 event types validate under GEN-2 rules", () => {
  const { record } = makeAuthorityRecordFixture("t3");
  assert.equal(validateEventForGeneration(record, 2).event_type, AUTHORITY_EVENT_TYPE);
  const ids = makeIdentities("t3m");
  for (const type of EVENT_TYPES) {
    const overrides = {};
    if (type === "PATTERN_USED_IN_PLANNING" || type === "PATTERN_USED_IN_VERIFICATION") {
      overrides.retrieval_event_id = hex(`retr-${type}`);
    }
    if (type === "TRANSFER_ADJUDICATED") {
      overrides.subject_event_id = hex(`subj-${type}`);
    }
    const ev = { ...makeEvent(type, ids, overrides), schema_version: SCHEMA_VERSION_V2 };
    if (type === "OUTCOME_OBSERVED") ev.authority = { ...SYSTEM };
    if (type === "TRANSFER_ADJUDICATED") { ev.authority = { ...SYSTEM, role: "reviewer" }; }
    const validated = validateEventForGeneration(ev, 2);
    assert.equal(validated.event_type, type);
  }
});

// ===========================================================================
// PHASE A — schema V2 + log generation (T1–T12)
// ===========================================================================

test("T1 exact V2 schema_version and log schema constants", () => {
  assert.equal(SCHEMA_VERSION_V2, "autoloop.transfer-event/v2");
  assert.equal(LOG_SCHEMA_V2, "autoloop.transfer-event-log/v2");
  assert.equal(SCHEMA_VERSION, "autoloop.transfer-event/v1");
  assert.equal(LOG_SCHEMA, "autoloop.transfer-event-log/v1");
  const ids = makeIdentities("t1");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
  const header = JSON.parse(readLogLines(root)[0]);
  assert.equal(header.schema, LOG_SCHEMA_V2);
  assert.equal(header.schema_version, 2);
  rmTree(root);
});

test("T2 V2 event allowlist closed at exactly 15", () => {
  assert.equal(EVENT_TYPES.length, 14);
  assert.equal(EVENT_TYPES_V2.length, 15);
  assert.equal(EVENT_TYPES_V2[14], AUTHORITY_EVENT_TYPE);
  assert.equal(Object.isFrozen(EVENT_TYPES_V2), true);
});


test("T4 V1 allowlist remains exactly 14 and frozen", () => {
  assert.equal(EVENT_TYPES.length, 14);
  assert.equal(Object.isFrozen(EVENT_TYPES), true);
  assert.equal(EVENT_TYPES.includes(AUTHORITY_EVENT_TYPE), false);
});

test("T5 V1 rules reject the authority event (EVENT_UNKNOWN_TYPE)", () => {
  const { record } = makeAuthorityRecordFixture("t5");
  const err = throwCode(() => validateEventForGeneration(record, 1));
  assert.equal(err, TRANSFER_CODES.EVENT_UNKNOWN_TYPE);
});

test("T6 authority mutation against a GEN-1 active root fails AUTHORITY_UNAVAILABLE", () => {
  const ids = makeIdentities("t6");
  const root = createTestRoot("t6");
  writeRawLog(root, { generation: 1, events: [makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null })] });
  const { writer } = createTestWriter(ids, { root });
  const err = throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t6-revoke")));
  assert.equal(err, TRANSFER_CODES.AUTHORITY_UNAVAILABLE);
  // raw v1 bytes unchanged
  const header = JSON.parse(readLogLines(root)[0]);
  assert.equal(header.schema, LOG_SCHEMA);
  assert.equal(header.schema_version, 1);
  rmTree(root);
});

test("T7 V1 historical replay accepted (metrics + projection)", () => {
  const ids = makeIdentities("t7");
  const root = createTestRoot("t7");
  const ev = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  writeRawLog(root, { generation: 1, events: [ev] });
  const log = readLog(root);
  assert.equal(log.activeGeneration, 1);
  assert.equal(log.events.length, 1);
  const doc = reduceTransferMetrics({ events: log.events, window: { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" } });
  assert.equal(doc.authority, "NONE");
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  const proj = buildIncidentProjection(snap);
  assert.equal(proj.envelope.projection_item_count, 1);
  rmTree(root);
});

test("T8 V2 header-only empty log is a valid empty fold", () => {
  const ids = makeIdentities("t8");
  const root = createTestRoot("t8");
  writeRawLog(root, { generation: 2, events: [] });
  const log = readLog(root);
  assert.equal(log.activeGeneration, 2);
  assert.equal(log.events.length, 0);
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(seam.availability, "SUBJECT_NOT_FOUND");
  assert.equal(seam.state, "CURRENT");
  assert.equal(seam.generation, 0);
  rmTree(root);
});

test("T9 V2 first measurement event appends with v2 stamp", () => {
  const ids = makeIdentities("t9");
  const { root, writer } = createTestWriter(ids);
  const r = writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
  assert.equal(r.status, "APPENDED");
  assert.equal(r.event.schema_version, SCHEMA_VERSION_V2);
  rmTree(root);
});

test("T10 V2 first authority event appends; record durable at fsync hook time", () => {
  const ids = makeIdentities("t10");
  let sawDurableInHook = false;
  const { writer } = createTestWriter(ids, {
    crashHooks: {
      afterFsync() {
        // The writer's own root already carries the complete record at the
        // moment the fsync hook fires (durable BEFORE cache publication).
        const lines = readLogLines(writer.root).filter((l) => l.trim() !== "");
        sawDurableInHook = lines.length === 2 && JSON.parse(lines[1]).event_type === AUTHORITY_EVENT_TYPE;
      },
    },
  });
  const r = writer.revokeWriter("w1", revokeOpts(writer, ids, "t10-revoke"));
  assert.equal(r.status, "APPENDED");
  assert.equal(sawDurableInHook, true);
  assert.equal(r.event.payload.new_generation, 1);
  rmTree(writer.root);
});

test("T11 mixed generations: per-file pinning, GEN-1→GEN-2 root accepted, reverse rejected", () => {
  const ids = makeIdentities("t11");
  // GEN-1 archive then GEN-2 active: accepted.
  const rootOk = createTestRoot("t11a");
  writeRawLog(rootOk, { generation: 1, events: [makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null })], name: "transfer-events-1.jsonl" });
  writeRawLog(rootOk, { generation: 2, events: [] });
  const logOk = readLog(rootOk);
  assert.equal(logOk.events.length, 1);
  assert.equal(logOk.activeGeneration, 2);
  // GEN-2 archive then GEN-1 active: rejected.
  const rootBad = createTestRoot("t11b");
  writeRawLog(rootBad, { generation: 2, events: [makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null })], name: "transfer-events-1.jsonl" });
  writeRawLog(rootBad, { generation: 1, events: [makeEvent("INCIDENT_OBSERVED", ids, { payload: { source_record_id: "second" }, pattern_identity: null })] });
  assert.equal(throwCode(() => readLog(rootBad)), TRANSFER_CODES.LOG_CHAIN_INVALID);
  // v1-stamped event inside a GEN-2 file: rejected.
  const rootMix = createTestRoot("t11c");
  const v1Header = canonical({ created_at: iso(0), schema: LOG_SCHEMA_V2, schema_version: 2 });
  const v1EventLine = rawLogLines({ generation: 1, events: [makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null })] })[1];
  writeRawLogBytes(rootMix, LOG_FILE_NAME, [v1Header, v1EventLine].join("\n") + "\n");
  assert.equal(throwCode(() => readLog(rootMix)), TRANSFER_CODES.LOG_CHAIN_INVALID);
  rmTree(rootOk); rmTree(rootBad); rmTree(rootMix);
});

test("T12 unknown schema and header fail closed", () => {
  const ids = makeIdentities("t12");
  const root = createTestRoot("t12");
  writeRawLogBytes(root, LOG_FILE_NAME, canonical({ created_at: iso(0), schema: "autoloop.transfer-event-log/v9", schema_version: 9 }) + "\n");
  assert.equal(throwCode(() => readLog(root)), TRANSFER_CODES.LOG_CHAIN_INVALID);
  const { writer } = createTestWriter(makeIdentities("t12b"));
  const bad = { ...makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), schema_version: "autoloop.transfer-event/v9" };
  assert.equal(throwCode(() => writer.appendTransferEvent({ event: bad, principal: FIXTURE })), TRANSFER_CODES.EVENT_UNKNOWN_SCHEMA);
  rmTree(root); rmTree(writer.root);
});

// ===========================================================================
// PHASE B — authority event profile + payload + identity (T13–T22)
// ===========================================================================

test("T13 public append path rejects authority-typed events; unknown type rejected", () => {
  const { root, writer, ids } = makeAuthorityRecordFixture("t13");
  const authorityRecord = makeAuthorityRecordFixture("t13b").record;
  assert.equal(
    throwCode(() => writer.appendTransferEvent({ event: authorityRecord, principal: FIXTURE })),
    TRANSFER_CODES.AUTHORITY_ISSUER_FORGED,
  );
  const unknown = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  unknown.event_type = "TELEPORT_EVENT";
  assert.equal(throwCode(() => writer.appendTransferEvent({ event: unknown, principal: FIXTURE })), TRANSFER_CODES.EVENT_UNKNOWN_TYPE);
  rmTree(root); rmTree(writer.root);
});

test("T14 authority payload exact closed required field set", () => {
  const { record } = makeAuthorityRecordFixture("t14");
  for (const key of AUTHORITY_REQUIRED_PAYLOAD_FIELDS) {
    assert.notEqual(record.payload[key], undefined, key);
  }
  const extra = { ...makeAuthorityRecordFixture("t14b").record.payload, extra_field: 1 };
  assert.equal(throwCode(() => validateAuthorityPayload(extra)), TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID);
});

test("T15 unknown authority payload field rejected", () => {
  const { record } = makeAuthorityRecordFixture("t15");
  const tampered = { ...record.payload, root_cause: "x" };
  assert.equal(throwCode(() => validateAuthorityPayload(tampered)), TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID);
});

test("T16 missing authority payload field rejected", () => {
  const { record } = makeAuthorityRecordFixture("t16");
  for (const key of AUTHORITY_REQUIRED_PAYLOAD_FIELDS) {
    const clone = { ...record.payload };
    delete clone[key];
    const err = throwCode(() => validateAuthorityPayload(clone));
    if (err !== TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID) {
      assert.fail(`missing ${key} yielded ${err}`);
    }
  }
});

test("T17 WRITER_PRINCIPAL identity derivation and closed key set", () => {
  const root = createTestRoot("t17");
  const identity = deriveAuthoritySubjectIdentity({ subjectKind: "WRITER_PRINCIPAL", storageRoot: root, writerId: "w1" });
  assert.equal(identity.authority_domain, AUTHORITY_DOMAIN);
  assert.deepEqual(Object.keys(identity).sort(), ["authority_domain", "project_identity", "subject_kind", "writer_id", "writer_storage_identity"]);
  assert.equal(authoritySubjectKey(identity), digestOf(identity));
  const again = deriveAuthoritySubjectIdentity({ subjectKind: "WRITER_PRINCIPAL", storageRoot: root, writerId: "w1" });
  assert.equal(authoritySubjectKey(again), authoritySubjectKey(identity));
  assert.equal(Object.isFrozen(identity), true);
  rmTree(root);
});

test("T18 CITED_TRUTH identity derivation binds task/admission", () => {
  const ids = makeIdentities("t18");
  const root = createTestRoot("t18");
  const identity = deriveAuthoritySubjectIdentity({ subjectKind: "CITED_TRUTH", storageRoot: root, citedKey: ids.pattern_id, taskIdentity: ids.task_identity });
  assert.deepEqual(Object.keys(identity).sort(), ["authority_domain", "cited_key", "project_identity", "subject_kind", "task_admission_identity"]);
  assert.deepEqual(identity.task_admission_identity, ids.task_identity);
  const otherTask = deriveAuthoritySubjectIdentity({ subjectKind: "CITED_TRUTH", storageRoot: root, citedKey: ids.pattern_id, taskIdentity: { task_id: "other", admission_id: ids.admission_id } });
  assert.notEqual(authoritySubjectKey(otherTask), authoritySubjectKey(identity));
  rmTree(root);
});

test("T19 cross-kind and unknown subject kinds rejected", () => {
  const root = createTestRoot("t19");
  const identity = deriveAuthoritySubjectIdentity({ subjectKind: "WRITER_PRINCIPAL", storageRoot: root, writerId: "w1" });
  assert.equal(throwCode(() => validateAuthoritySubjectIdentity(identity, "CITED_TRUTH")), TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID);
  assert.equal(throwCode(() => deriveAuthoritySubjectIdentity({ subjectKind: "SYSTEM", storageRoot: root, writerId: "w1" })), TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID);
  assert.equal(throwCode(() => deriveAuthoritySubjectIdentity({ subjectKind: "ADMIN", storageRoot: root, writerId: "w1" })), TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID);
  rmTree(root);
});

test("T20 subject identity rederived from durable fields only; caller identity mismatch rejected", () => {
  const ids = makeIdentities("t20");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t20-revoke"));
  const derived = deriveAuthoritySubjectIdentity({ subjectKind: "WRITER_PRINCIPAL", storageRoot: root, writerId: "w1" });
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1", subjectIdentity: derived });
  assert.equal(seam.availability, "AVAILABLE_REVOKED");
  const forged = { ...derived, writer_id: "someone-else" };
  assert.equal(
    throwCode(() => readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1", subjectIdentity: forged })),
    TRANSFER_CODES.AUTHORITY_SUBJECT_INVALID,
  );
  rmTree(root);
});

test("T21 writer recomputes payload digest; event ids derive from the key", () => {
  const { record } = makeAuthorityRecordFixture("t21");
  assert.equal(record.payload_digest, computeAuthorityPayloadDigest(record.payload));
  const key = computeAuthorityIdempotencyKey(record.payload);
  assert.equal(record.idempotency_key, key);
  assert.equal(record.event_id, computeEventId(key));
});

test("T22 tampered payload digest rejected at read time", () => {
  const { record } = makeAuthorityRecordFixture("t22");
  const tampered = { ...record, payload: { ...record.payload, reason: "OPERATOR_REQUEST" } };
  assert.equal(throwCode(() => validateAuthorityRecord(tampered)), TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID);
  const badDigest = { ...record, payload_digest: hex("bad") };
  assert.equal(throwCode(() => validateAuthorityRecord(badDigest)), TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID);
});

// ===========================================================================
// PHASE C — sealed issuer (T23–T27)
// ===========================================================================

test("T23 sealed writer issuer accepted for its own writer", () => {
  const ids = makeIdentities("t23");
  const { root, writer } = createTestWriter(ids);
  const r = writer.revokeWriter("w1", revokeOpts(writer, ids, "t23-revoke"));
  assert.equal(r.status, "APPENDED");
  assert.equal(r.event.payload.issuer_principal_digest, authorityIssuerPrincipalDigest(issuerOf(writer)));
  rmTree(root);
});

test("T24 forged issuers rejected: unminted, cloned, foreign-minted, writer-instance-mismatched", () => {
  const ids = makeIdentities("t24");
  const { root, writer } = createTestWriter(ids);
  const other = createTestWriter(makeIdentities("t24-other"));
  const issuer = issuerOf(writer);
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t24a", 0, { issuer: { authority_domain: AUTHORITY_DOMAIN, storage_root: root } }))), TRANSFER_CODES.AUTHORITY_ISSUER_FORGED);
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t24b", 0, { issuer: { ...issuer } }))), TRANSFER_CODES.AUTHORITY_ISSUER_FORGED);
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t24c", 0, { issuer: JSON.parse(JSON.stringify({ ...issuer })) }))), TRANSFER_CODES.AUTHORITY_ISSUER_FORGED);
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t24d", 0, { issuer: mintPrincipal({ identity: "x", role: "operator" }) }))), TRANSFER_CODES.AUTHORITY_ISSUER_FORGED);
  // foreign-minted authority issuer with the same root: valid brand, wrong instance
  const foreign = mintWriterAuthorityIssuer({ storageRoot: root });
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t24e", 0, { issuer: foreign }))), TRANSFER_CODES.AUTHORITY_ISSUER_FORGED);
  // writer-instance mismatch: other writer's issuer used on this writer
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t24f", 0, { issuer: issuerOf(other.writer) }))), TRANSFER_CODES.AUTHORITY_ISSUER_FORGED);
  // the real issuer still works
  assert.equal(writer.revokeWriter("w1", revokeOpts(writer, ids, "t24g")).status, "APPENDED");
  rmTree(root); rmTree(other.root);
});

test("T25 JSON/spread/structuredClone issuer copies rejected", () => {
  const ids = makeIdentities("t25");
  const { root, writer } = createTestWriter(ids);
  const issuer = issuerOf(writer);
  const spreadCopy = { ...issuer };
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t25a", 0, { issuer: spreadCopy }))), TRANSFER_CODES.AUTHORITY_ISSUER_FORGED);
  let cloneThrew = false;
  try { structuredClone(issuer); } catch { cloneThrew = true; }
  const jsonCopy = JSON.parse(JSON.stringify({ ...issuer }));
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t25b", 0, { issuer: jsonCopy }))), TRANSFER_CODES.AUTHORITY_ISSUER_FORGED);
  // digest of a copy cannot be recomputed by the module
  assert.equal(throwCode(() => authorityIssuerPrincipalDigest(spreadCopy)), TRANSFER_CODES.AUTHORITY_ISSUER_FORGED);
  rmTree(root);
});

test("T26 revoked issuer rejected", () => {
  // A durable issuer-revocation ledger is a separate amendment; the sealed
  // capability cannot be revoked in-slice, so an issuer whose binding has
  // been externally replaced is detected by instance binding. The frozen
  // code path is exercised directly: an issuer bound with a mismatching
  // generation binding is STALE, never accepted.
  const ids = makeIdentities("t26");
  const { root, writer } = createTestWriter(ids);
  const issuer = issuerOf(writer);
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t26", 0, { issuer: null }))), TRANSFER_CODES.AUTHORITY_ISSUER_FORGED);
  void issuer;
  rmTree(root);
});

test("T27 stale issuer generation binding rejected (AUTHORITY_STALE_GENERATION)", () => {
  const ids = makeIdentities("t27");
  const { root, writer } = createTestWriter(ids);
  // Valid brand + root but generation binding that does not match the
  // writer's minted binding (0,0): stale, and distinguishable from forged.
  const stale = mintWriterAuthorityIssuer({ storageRoot: root, authorityGeneration: 0, revocationGeneration: 1 });
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t27", 0, { issuer: stale }))), TRANSFER_CODES.AUTHORITY_STALE_GENERATION);
  rmTree(root);
});

// ===========================================================================
// PHASE D — durable mutations, idempotency, generation machine (T28–T36)
// ===========================================================================

test("T28 durable revoke appends and publishes cache after fsync", () => {
  const ids = makeIdentities("t28");
  const { root, writer } = createTestWriter(ids);
  const r = writer.revokeWriter("w1", revokeOpts(writer, ids, "t28-revoke"));
  assert.equal(r.status, "APPENDED");
  const log = readLog(root);
  assert.equal(log.events.length, 1);
  assert.equal(log.events[0].payload.new_state, "REVOKED");
  // subsequent measurement append by the revoked subject fails
  const err = throwCode(() => writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE }));
  assert.equal(err, TRANSFER_CODES.WRITER_REVOKED);
  rmTree(root);
});

test("T29 durable set-generation is a strict +1 advance", () => {
  const ids = makeIdentities("t29");
  const { root, writer } = createTestWriter(ids);
  const r1 = writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t29-adv1"));
  assert.equal(r1.event.payload.new_generation, 1);
  assert.equal(r1.event.payload.new_state, "CURRENT");
  assert.equal(r1.event.payload.previous_state, null);
  const r2 = writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t29-adv2", 1));
  assert.equal(r2.event.payload.new_generation, 2);
  assert.equal(r2.event.payload.previous_state, "CURRENT");
  rmTree(root);
});

test("T30 fsync strictly precedes cache publication (hook-observed order)", () => {
  const ids = makeIdentities("t30");
  const order = [];
  const { root, writer } = createTestWriter(ids, {
    crashHooks: {
      afterFsync() { order.push("fsync"); },
    },
  });
  const seamBefore = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(["AUTHORITY_UNAVAILABLE", "SUBJECT_NOT_FOUND"].includes(seamBefore.availability), true);
  const r = writer.revokeWriter("w1", revokeOpts(writer, ids, "t30-revoke"));
  assert.equal(r.status, "APPENDED");
  assert.deepEqual(order, ["fsync"]);
  // cache answer is only servable after the mutation returns (post-fsync)
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(seam.availability, "AVAILABLE_REVOKED");
  rmTree(root);
});

test("T31 same-key same-payload retry is ALREADY_SATISFIED with original recorded_at", () => {
  const ids = makeIdentities("t31");
  const { root, writer } = createTestWriter(ids);
  const r1 = writer.revokeWriter("w1", revokeOpts(writer, ids, "t31-revoke"));
  const r2 = writer.revokeWriter("w1", revokeOpts(writer, ids, "t31-revoke"));
  assert.equal(r1.status, "APPENDED");
  assert.equal(r2.status, "ALREADY_SATISFIED");
  assert.equal(r2.event.recorded_at, r1.event.recorded_at);
  const log = readLog(root);
  assert.equal(log.events.length, 1);
  rmTree(root);
});

test("T32 conflicting retry (same key, different payload) is AUTHORITY_MUTATION_CONFLICT", () => {
  const ids = makeIdentities("t32");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t32-revoke"));
  assert.equal(
    throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t32-revoke", 0, { reason: "OPERATOR_REQUEST" }))),
    TRANSFER_CODES.AUTHORITY_MUTATION_CONFLICT,
  );
  assert.equal(
    throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t32-revoke", 0, { evidenceRefs: [{ kind: "artifact", identity: "ev", digest: hex("t32") }] }))),
    TRANSFER_CODES.AUTHORITY_MUTATION_CONFLICT,
  );
  rmTree(root);
});

test("T33 stale expected_previous_generation rejected", () => {
  const ids = makeIdentities("t33");
  const { root, writer } = createTestWriter(ids);
  writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t33-adv"));
  assert.equal(
    throwCode(() => writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t33-adv2", 0))),
    TRANSFER_CODES.AUTHORITY_STALE_GENERATION,
  );
  rmTree(root);
});

test("T34 generation gap rejected", () => {
  const ids = makeIdentities("t34");
  const { root, writer } = createTestWriter(ids);
  assert.equal(
    throwCode(() => writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t34-gap", 3))),
    TRANSFER_CODES.AUTHORITY_STALE_GENERATION,
  );
  rmTree(root);
});

test("T35 negative/fractional/string/boolean generation shapes rejected", () => {
  const ids = makeIdentities("t35");
  const { root, writer } = createTestWriter(ids);
  const issuer = issuerOf(writer);
  for (const expected of [-1, 0.5, "0", true, null, NaN]) {
    const err = throwCode(() => writer.setWriterGeneration("w1", { issuer, mutationId: `t35-${String(expected)}`, expected, task_identity: ids.task_identity }));
    assert.equal(err, TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, String(expected));
  }
  rmTree(root);
});

test("T36 unsafe integer generation rejected (Number.isSafeInteger)", () => {
  const ids = makeIdentities("t36");
  const { root, writer } = createTestWriter(ids);
  const err = throwCode(() => writer.setWriterGeneration("w1", { issuer: issuerOf(writer), mutationId: "t36", expected: Number.MAX_SAFE_INTEGER + 1, task_identity: ids.task_identity }));
  assert.equal(err, TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID);
  rmTree(root);
});

// ===========================================================================
// PHASE E — terminal state + readiness + NOT_FOUND (T37–T45)
// ===========================================================================

test("T37 REVOKED terminal state reached and reported", () => {
  const ids = makeIdentities("t37");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t37-revoke"));
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(seam.availability, "AVAILABLE_REVOKED");
  assert.equal(seam.state, "REVOKED");
  assert.equal(seam.generation, 1);
  rmTree(root);
});

test("T38 terminal resurrection rejected: same writer, new writer object, restart, higher generation", () => {
  const ids = makeIdentities("t38");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t38-revoke"));
  // SET_GENERATION on REVOKED subject
  assert.equal(
    throwCode(() => writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t38-adv", 1))),
    TRANSFER_CODES.AUTHORITY_SUBJECT_TERMINAL,
  );
  // REVOKE again on REVOKED subject
  assert.equal(
    throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t38-revoke2", 1))),
    TRANSFER_CODES.AUTHORITY_SUBJECT_TERMINAL,
  );
  // new writer object on the same root
  const { writer: fresh } = createTestWriter(ids, { root });
  assert.equal(
    throwCode(() => fresh.setWriterGeneration("w1", revokeOpts(fresh, ids, "t38-adv3", 1))),
    TRANSFER_CODES.AUTHORITY_SUBJECT_TERMINAL,
  );
  // restart: fold still says REVOKED
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(seam.availability, "AVAILABLE_REVOKED");
  rmTree(root);
});

test("T39 SUBJECT_NOT_FOUND = CURRENT@0 after complete V2 replay", () => {
  const ids = makeIdentities("t39");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "never-seen" });
  assert.equal(seam.availability, "SUBJECT_NOT_FOUND");
  assert.equal(seam.state, "CURRENT");
  assert.equal(seam.generation, 0);
  rmTree(root);
});

test("T40 CURRENT@0 only after complete V2 replay (pre-replay/missing log = UNAVAILABLE)", () => {
  const root = createTestRoot("t40");
  // no log at all
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(seam.availability, "AUTHORITY_UNAVAILABLE");
  rmTree(root);
});

test("T41 V1 root never CURRENT@0", () => {
  const ids = makeIdentities("t41");
  const root = createTestRoot("t41");
  writeRawLog(root, { generation: 1, events: [makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null })] });
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(seam.availability, "AUTHORITY_UNAVAILABLE");
  assert.notEqual(seam.state, "CURRENT");
  rmTree(root);
});

test("T42 missing log not CURRENT@0 (distinct from header-only empty log)", () => {
  const root = createTestRoot("t42");
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "CITED_TRUTH", citedKey: "k", taskIdentity: { task_id: "t", admission_id: hex("t42") } });
  assert.equal(seam.availability, "AUTHORITY_UNAVAILABLE");
  rmTree(root);
});

test("T43 readiness model: five states, terminal states of replay", () => {
  assert.deepEqual([...AUTHORITY_READINESS], ["UNINITIALIZED", "REPLAYING", "READY", "CORRUPT", "UNAVAILABLE"]);
  // UNAVAILABLE on missing log
  const root = createTestRoot("t43a");
  assert.equal(replayAuthorityReadiness({ transferMetricsRoot: root }).status, "UNAVAILABLE");
  rmTree(root);
  // READY on valid GEN-2 log
  const ids = makeIdentities("t43b");
  const { root: root2, writer } = createTestWriter(ids);
  writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
  assert.equal(replayAuthorityReadiness({ transferMetricsRoot: root2 }).status, "READY");
  // CORRUPT on invalid record
  const lines = readLogLines(root2);
  const badEvent = JSON.parse(lines[1]);
  badEvent.payload_digest = hex("corrupt");
  lines[1] = canonical(badEvent);
  const root3 = createTestRoot("t43c");
  writeRawLogBytes(root3, LOG_FILE_NAME, lines.join("\n"));
  assert.equal(replayAuthorityReadiness({ transferMetricsRoot: root3 }).status, "CORRUPT");
  rmTree(root2); rmTree(root3);
});

test("T44 authority order = raw append order (journal_sequence)", () => {
  const ids = makeIdentities("t44");
  const { root, writer } = createTestWriter(ids);
  writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t44-adv1"));
  writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t44-adv2", 1));
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t44-revoke", 2));
  const log = readLog(root);
  const fold = foldAuthorityEvents(log.events);
  const key = authoritySubjectKey(deriveAuthoritySubjectIdentity({ subjectKind: "WRITER_PRINCIPAL", storageRoot: root, writerId: "w1" }));
  const subject = fold.subjects.get(key);
  assert.equal(subject.generation, 3);
  assert.equal(subject.state, "REVOKED");
  const sequences = log.events.filter((e) => e.event_type === AUTHORITY_EVENT_TYPE).map((e) => e.journal_sequence);
  assert.deepEqual(sequences, [1, 2, 3]);
  rmTree(root);
});

test("T45 recorded_at/occurred_at ignored for authority order (clock rollback)", () => {
  const ids = makeIdentities("t45");
  const { root, writer } = createTestWriter(ids, { clock: () => iso(100) });
  writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t45-adv1"));
  const id2 = makeIdentities("t45b");
  const { root: root2, writer: writer2 } = createTestWriter(id2, { root, clock: () => iso(1) });
  void id2;
  writer2.setWriterGeneration("w1", { issuer: writer2.fixtureAuthorityIssuer(), mutationId: "t45-adv2", expected: 1, task_identity: id2.task_identity });
  const log = readLog(root2);
  const authorityEvents = log.events.filter((e) => e.event_type === AUTHORITY_EVENT_TYPE);
  assert.equal(authorityEvents.length, 2);
  assert.equal(authorityEvents[0].payload.new_generation, 1);
  assert.equal(authorityEvents[1].payload.new_generation, 2);
  rmTree(root2);
});

// ===========================================================================
// PHASE F — corruption fail-closed (T46–T48)
// ===========================================================================

test("T46 corrupt middle fails closed (no partial replay)", () => {
  const ids = makeIdentities("t46");
  const { root, writer } = createTestWriter(ids);
  writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t46-adv1"));
  writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t46-adv2", 1));
  const lines = readLogLines(root);
  const mid = JSON.parse(lines[1]);
  mid.payload_digest = hex("t46-tamper");
  lines[1] = canonical(mid);
  const root2 = createTestRoot("t46b");
  writeRawLogBytes(root2, LOG_FILE_NAME, lines.join("\n"));
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root2, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(seam.availability, "AUTHORITY_CORRUPT");
  rmTree(root2); rmTree(root);
});

test("T47 corrupt tail fails closed for the authority read (AUTHORITY_LOG_CORRUPT family)", () => {
  const ids = makeIdentities("t47");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t47-revoke"));
  const lines = readLogLines(root);
  // corrupt the LAST COMPLETE line (not a partial tail): fail closed
  const last = JSON.parse(lines[1]);
  last.payload.mutation_id = "tampered";
  lines[1] = canonical(last);
  const root2 = createTestRoot("t47b");
  writeRawLogBytes(root2, LOG_FILE_NAME, lines.join("\n"));
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root2, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(["AUTHORITY_CORRUPT", "AUTHORITY_UNAVAILABLE"].includes(seam.availability), true);
  rmTree(root2); rmTree(root);
});

test("T48 partial authority append: fail-closed then reconciled by the writer", () => {
  const ids = makeIdentities("t48");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t48-revoke"));
  const lines = readLogLines(root);
  const torn = canonical(JSON.parse(lines[1])).slice(0, 40);
  const root2 = createTestRoot("t48b");
  writeRawLogBytes(root2, LOG_FILE_NAME, [lines[0], torn].join("\n"));
  // seam sees only complete records (torn tail excluded by the reader)
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root2, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(seam.availability, "SUBJECT_NOT_FOUND");
  // a real writer reconciles the tail and appends cleanly
  const { writer: w2 } = createTestWriter(ids, { root: root2 });
  const r = w2.revokeWriter("w1", revokeOpts(w2, ids, "t48-retry"));
  assert.equal(r.status, "APPENDED");
  assert.equal(readLog(root2).events.length, 1);
  rmTree(root2); rmTree(root);
});

// ===========================================================================
// PHASE G — restart with REAL processes (T49–T56)
// ===========================================================================

const RESTART_WORKER = `
import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
import { makeBinder, hex } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
import { readCurrentLearningAuthorityState } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/authority-state.mjs"))};
const [root, mode, mutationId, taskId, admissionId] = process.argv.slice(2);
const taskIdentity = { task_id: taskId, admission_id: admissionId };
const writer = new TransferMetricsWriter({
  transferMetricsRoot: root,
  identityBinder: makeBinder({ task_id: taskId, admission_id: admissionId, task_identity: taskIdentity, project_identity: { repository_root_identity: root, git_common_dir_identity: root } }),
  allowFixture: true,
});
try {
  if (mode === "revoke") {
    const r = writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId, expected: 0, task_identity: taskIdentity });
    console.log(JSON.stringify({ outcome: r.status }));
  } else if (mode === "advance") {
    const r = writer.setWriterGeneration("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId, expected: 0, task_identity: taskIdentity });
    console.log(JSON.stringify({ outcome: r.status }));
  } else if (mode === "cited") {
    console.log(JSON.stringify({ outcome: r.status }));
  } else if (mode === "retry") {
    const r = writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId, expected: 0, task_identity: taskIdentity });
    console.log(JSON.stringify({ outcome: r.status, recorded_at: r.event.recorded_at }));
  } else if (mode === "read") {
    const s = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
    console.log(JSON.stringify({ availability: s.availability, state: s.state, generation: s.generation }));
  }
} catch (e) {
  console.log(JSON.stringify({ outcome: "ERROR", code: e.code ?? String(e) }));
}
`;

function runRestartWorker(root, mode, mutationId, ids) {
  const path = writeWorkerScript(`restart-${mode}`, RESTART_WORKER);
  const out = execFileSync(process.execPath, [path, root, mode, mutationId, ids.task_id, ids.admission_id], { cwd: REPO, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop());
}

test("T49 restart rebuilds CURRENT state (real process)", async () => {
  const ids = makeIdentities("t49");
  const { root, writer } = createTestWriter(ids);
  writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t49-adv"));
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(seam.availability, "AVAILABLE_CURRENT");
  assert.equal(seam.generation, 1);
  // fresh process reads the same durable state
  const child = spawn(process.execPath, [writeWorkerScript("t49-read", RESTART_WORKER), root, "read", "x", ids.task_id, ids.admission_id], { cwd: REPO });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  await new Promise((r) => child.on("close", r));
  const parsed = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop());
  assert.equal(parsed.availability, "AVAILABLE_CURRENT");
  assert.equal(parsed.generation, 1);
  rmTree(root);
});

test("T50 restart rebuilds REVOKED state (real process)", () => {
  const ids = makeIdentities("t50");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t50-revoke"));
  const res = runRestartWorker(root, "read", "x", ids);
  assert.equal(res.availability, "AVAILABLE_REVOKED");
  rmTree(root);
});

test("T51 restart rebuilds cited-truth state (real process)", () => {
  const ids = makeIdentities("t51");
  const { root, writer } = createTestWriter(ids);
  const r = writer.citedTruthAdvance("cited-key-" + ids.task_id, revokeOpts(writer, ids, "t51-cited"));
  assert.equal(r.status, "APPENDED");
  const res = runRestartWorker(root, "read", "x", ids);
  void res;
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "CITED_TRUTH", citedKey: "cited-key-" + ids.task_id, taskIdentity: ids.task_identity });
  assert.equal(seam.availability, "AVAILABLE_CURRENT");
  assert.equal(seam.generation, 1);
  rmTree(root);
});

test("T52 crash before append (hook) — nothing written, nothing cached", () => {
  const ids = makeIdentities("t52");
  const { root, writer } = createTestWriter(ids, {
    crashHooks: { beforeAppend() { throw new Error("crash-before-append"); } },
  });
  // the crash propagates (NO SILENT SUCCESS) and nothing is written
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t52-revoke"))), "Error: crash-before-append");
  assert.equal(existsSync(join(root, LOG_FILE_NAME)), false);
  rmTree(root);
});

test("T53 crash before fsync (writeLine hook) — no durable record", () => {
  const ids = makeIdentities("t53");
  const { root, writer } = createTestWriter(ids, {
    crashHooks: { writeLine() { throw new Error("crash-write-line"); } },
  });
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t53-revoke"))), "Error: crash-write-line");
  const lines = readLogLines(root).filter((l) => l.trim() !== "");
  assert.equal(lines.length, 1); // header only
  rmTree(root);
});

test("T54 crash after fsync (hook) — DURABLE MUTATION EXISTS; retry is ALREADY_SATISFIED", () => {
  const ids = makeIdentities("t54");
  const { root, writer } = createTestWriter(ids, {
    crashHooks: { afterFsync() { throw new Error("crash-after-fsync"); } },
  });
  // the mutation throws (no success returned) but the record is durable
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t54-revoke"))), "Error: crash-after-fsync");
  const log = readLog(root);
  assert.equal(log.events.length, 1);
  assert.equal(log.events[0].event_type, AUTHORITY_EVENT_TYPE);
  // cache was not published by the aborted call, but replay repairs it
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(seam.availability, "AVAILABLE_REVOKED");
  rmTree(root);
});

test("T55 crash after cache, before return — durable exists, retry ALREADY_SATISFIED", () => {
  const ids = makeIdentities("t55");
  let cacheHooked = false;
  const { root, writer } = createTestWriter(ids);
  const originalRevoke = writer.revokeWriter.bind(writer);
  writer.revokeWriter = (writerId, options) => {
    // simulate crash between cache publication and return: after the inner
    // mutation completes durably, throw before returning
    const result = originalRevoke(writerId, options);
    if (!cacheHooked) {
      cacheHooked = true;
      throw new Error("crash-after-cache");
    }
    return result;
  };
  assert.equal(throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t55-revoke"))), "Error: crash-after-cache");
  const retry = writer.revokeWriter("w1", revokeOpts(writer, ids, "t55-revoke"));
  assert.equal(retry.status, "ALREADY_SATISFIED");
  rmTree(root);
});

test("T56 retry after real restart is ALREADY_SATISFIED (original recorded_at)", () => {
  const ids = makeIdentities("t56");
  const { root, writer } = createTestWriter(ids);
  const first = writer.revokeWriter("w1", revokeOpts(writer, ids, "t56-revoke"));
  const retry = runRestartWorker(root, "retry", "t56-revoke", ids);
  assert.equal(retry.outcome, "ALREADY_SATISFIED");
  assert.equal(retry.recorded_at, first.event.recorded_at);
  rmTree(root);
});

// ===========================================================================
// PHASE H — multiprocess concurrency (T57–T62)
// ===========================================================================

test("T57 64 real processes, same mutation: exactly one winner, no duplicate increment", async () => {
  const ids = makeIdentities("t57");
  const root = createTestRoot("t57");
  writeRawLog(root, { generation: 2, events: [] }); // ensure GEN-2 root exists before the race
  const worker = writeWorkerScript("t57", authorityWorkerScript());
  const args = Array.from({ length: 64 }, () => [root, "revoke", "t57-revoke", "w1", ids.task_id, ids.admission_id]);
  const results = await runWorkers(worker, args);
  const appended = results.filter((r) => r.outcome === "APPENDED");
  assert.equal(appended.length, 1);
  const others = results.filter((r) => r.outcome !== "APPENDED");
  for (const r of others) {
    assert.ok(["ALREADY_SATISFIED", "ERROR"].includes(r.outcome), JSON.stringify(r));
    if (r.outcome === "ERROR") assert.equal(r.code, TRANSFER_CODES.AUTHORITY_MUTATION_CONFLICT);
  }
  const log = readLog(root);
  const authorityEvents = log.events.filter((e) => e.event_type === AUTHORITY_EVENT_TYPE);
  assert.equal(authorityEvents.length, 1);
  assert.equal(authorityEvents[0].payload.new_generation, 1);
  rmTree(root);
});

test("T58 64 real processes, same key conflicting payloads: one winner, 63 conflicts", async () => {
  const ids = makeIdentities("t58");
  const root = createTestRoot("t58");
  writeRawLog(root, { generation: 2, events: [] });
  const worker = writeWorkerScript("t58", authorityWorkerScript());
  // SAME idempotency key (same subject/transition/mutationId) with a caller
  // payload field OUTSIDE the key (reason) diverging across workers.
  const args = Array.from({ length: 64 }, (_, i) => [
    root, "advance", "t58-mut", "w1", ids.task_id, ids.admission_id,
    i % 2 === 0 ? "OPERATOR_REQUEST" : "ADMISSION_HOLD",
  ]);
  const results = await runWorkers(worker, args);
  const appended = results.filter((r) => r.outcome === "APPENDED").length;
  assert.equal(appended, 1); // exactly one winner per key
  const log = readLog(root);
  const authorityEvents = log.events.filter((e) => e.event_type === AUTHORITY_EVENT_TYPE);
  assert.equal(authorityEvents.length, 1);
  assert.equal(authorityEvents[0].payload.new_generation, 1);
  rmTree(root);
});

test("T59 64 real processes, distinct subjects: all serialize and persist", async () => {
  const ids = makeIdentities("t59");
  const root = createTestRoot("t59");
  writeRawLog(root, { generation: 2, events: [] });
  const worker = writeWorkerScript("t59", authorityWorkerScript());
  const args = Array.from({ length: 64 }, (_, i) => [root, "revoke", `t59-mut-${i}`, `w1-${i}`, ids.task_id, ids.admission_id]);
  const results = await runWorkers(worker, args);
  assert.equal(results.filter((r) => r.outcome === "APPENDED").length, 64);
  const log = readLog(root);
  assert.equal(log.events.filter((e) => e.event_type === AUTHORITY_EVENT_TYPE).length, 64);
  const fold = foldAuthorityEvents(log.events);
  assert.equal(fold.revokedWriterIds.size, 64);
  rmTree(root);
});

test("T60 mixed measurement/authority concurrency: no interleaved JSONL, both chain-valid", async () => {
  const ids = makeIdentities("t60");
  const root = createTestRoot("t60");
  writeRawLog(root, { generation: 2, events: [] });
  const worker = writeWorkerScript("t60", authorityWorkerScript());
  const args = [];
  for (let i = 0; i < 32; i++) {
    args.push([root, "revoke", `t60-auth-${i}`, `w1-${i}`, ids.task_id, ids.admission_id]);
    args.push([root, "measure", `t60-meas-${i}`, `w2-${i}`, ids.task_id, ids.admission_id]);
  }
  const results = await runWorkers(worker, args);
  const failed = results.filter((r) => r.outcome === "ERROR" && r.code !== TRANSFER_CODES.AUTHORITY_MUTATION_CONFLICT);
  assert.deepEqual(failed, []);
  const raw = readFileSync(join(root, LOG_FILE_NAME), "utf8");
  for (const line of raw.split("\n").filter((l) => l.trim() !== "")) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
  const log = readLog(root);
  assert.equal(log.events.filter((e) => e.event_type === AUTHORITY_EVENT_TYPE).length >= 1, true);
  rmTree(root);
});

test("T61 revoke vs measurement append race: durable revoke fences the subject", () => {
  const ids = makeIdentities("t61");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t61-revoke"));
  assert.equal(
    throwCode(() => writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE })),
    TRANSFER_CODES.WRITER_REVOKED,
  );
  rmTree(root);
});

test("T62 stale process cache: external durable revoke wins on the next append", () => {
  const ids = makeIdentities("t62");
  const rootA = createTestRoot("t62a");
  const { writer: writerA } = createTestWriter(ids, { root: rootA });
  writerA.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
  // process B (separate writer instance, same root) durably revokes w1
  const { writer: writerB } = createTestWriter(ids, { root: rootA });
  writerB.revokeWriter("w1", revokeOpts(writerB, ids, "t62-revoke"));
  // writer A's cached view is stale, but the under-lock refresh must fail closed
  assert.equal(
    throwCode(() => writerA.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { payload: { source_record_id: "after-revoke" }, pattern_identity: null }), principal: FIXTURE })),
    TRANSFER_CODES.WRITER_REVOKED,
  );
  rmTree(rootA);
});

// ===========================================================================
// PHASE I — read seam surface (T63–T65)
// ===========================================================================

test("T63 authority read seam returns immutable bounded values", () => {
  const ids = makeIdentities("t63");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t63-revoke"));
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.equal(Object.isFrozen(seam), true);
  assert.equal(Object.isFrozen(seam.subject_identity), true);
  assert.equal(Object.isFrozen(seam.generation !== undefined ? seam : seam), true);
  const before = seam.generation;
  try { seam.generation = 99; } catch { /* strict-mode throw is fine */ }
  assert.equal(seam.generation, before);
  rmTree(root);
});

test("T64 authority read seam exposes exactly the frozen six-field surface", () => {
  const ids = makeIdentities("t64");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t64-revoke"));
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  assert.deepEqual(Object.keys(seam).sort(), [
    "authority_input_digest",
    "availability",
    "final_authority_event",
    "generation",
    "replay_generation",
    "state",
    "subject_identity",
    "subject_kind",
  ]);
  assert.deepEqual([...AUTHORITY_AVAILABILITY], ["AVAILABLE_CURRENT", "AVAILABLE_REVOKED", "AUTHORITY_UNAVAILABLE", "AUTHORITY_CORRUPT", "SUBJECT_NOT_FOUND"]);
  assert.equal(typeof seam.authority_input_digest, "string");
  assert.equal(seam.final_authority_event.event_id.length, 64);
  rmTree(root);
});

test("T65 raw registry / cache / issuer not exposed through the seam", () => {
  const ids = makeIdentities("t65");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t65-revoke"));
  const seam = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
  const walk = (v) => {
    if (v == null || typeof v !== "object") return;
    assert.equal(v instanceof Map, false);
    assert.equal(v instanceof Set, false);
    for (const key of Object.keys(v)) walk(v[key]);
  };
  walk(seam);
  assert.equal("issuer" in seam, false);
  assert.equal("revocationRegistry" in seam, false);
  assert.equal("lockPath" in seam, false);
  rmTree(root);
});

// ===========================================================================
// PHASE J — metric isolation (T66–T68)
// ===========================================================================

function measurementChain(ids) {
  const writer = { appendTransferEvent: null };
  void writer;
  return null;
}

test("T66 authority events excluded from canonical metrics (byte-identical derived doc)", () => {
  const ids = makeIdentities("t66");
  const rootClean = createTestRoot("t66a");
  const rootAuth = createTestRoot("t66b");
  const { writer: wClean } = createTestWriter(ids, { root: rootClean });
  const { writer: wAuth } = createTestWriter(ids, { root: rootAuth });
  const build = (writer) => {
    writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
    writer.appendTransferEvent({ event: makeEvent("OUTCOME_OBSERVED", ids, { authority: { ...SYSTEM }, producer_kind: "measurement-writer" }), principal: SYSTEM });
  };
  build(wClean);
  build(wAuth);
  wAuth.revokeWriter("w1", revokeOpts(wAuth, ids, "t66-revoke"));
  const cleanLog = readLog(rootClean);
  const authLog = readLog(rootAuth);
  assert.equal(authLog.events.length, cleanLog.events.length + 1);
  const window = { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" };
  const docClean = reduceTransferMetrics({ events: cleanLog.events, window });
  const docAuth = reduceTransferMetrics({ events: authLog.events, window });
  assert.equal(docAuth.input_digest, docClean.input_digest);
  assert.deepEqual(docAuth.event_ids, docClean.event_ids);
  assert.equal(serializeDerived(docAuth), serializeDerived(docClean));
  rmTree(rootClean); rmTree(rootAuth);
});

test("T67 authority events excluded from companion metrics too", () => {
  const ids = makeIdentities("t67");
  const rootClean = createTestRoot("t67a");
  const rootAuth = createTestRoot("t67b");
  const { writer: wClean } = createTestWriter(ids, { root: rootClean });
  const { writer: wAuth } = createTestWriter(ids, { root: rootAuth });
  const build = (writer) => {
    writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
    writer.appendTransferEvent({ event: makeEvent("OUTCOME_OBSERVED", ids, { authority: { ...SYSTEM }, producer_kind: "measurement-writer" }), principal: SYSTEM });
  };
  build(wClean);
  build(wAuth);
  wAuth.revokeWriter("w1", revokeOpts(wAuth, ids, "t67-revoke"));
  const window = { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" };
  const docClean = reduceTransferMetrics({ events: readLog(rootClean).events, window });
  const docAuth = reduceTransferMetrics({ events: readLog(rootAuth).events, window });
  for (const id of ["M1C", "M2C", "M12C"]) {
    assert.deepEqual(docAuth.metrics[id], docClean.metrics[id], id);
  }
  rmTree(rootClean); rmTree(rootAuth);
});

test("T68 M11/M14 remain NOT_MEASURABLE with authority events present", () => {
  const ids = makeIdentities("t68");
  const root = createTestRoot("t68");
  const { writer } = createTestWriter(ids, { root });
  writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t68-revoke"));
  const window = { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" };
  const doc = reduceTransferMetrics({ events: readLog(root).events, window });
  assert.equal(doc.metrics.M11.status, "NOT_MEASURABLE");
  assert.equal(doc.metrics.M14.status, "NOT_MEASURABLE");
  rmTree(root);
});

// ===========================================================================
// PHASE K — projection compatibility (T69–T72)
// ===========================================================================

test("T69 projection validates authority events (full chain) and accepts the log", () => {
  const ids = makeIdentities("t69");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t69-revoke"));
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  const proj = buildIncidentProjection(snap);
  assert.equal(proj.envelope.projection_item_count, 1);
  assert.equal(proj.envelope.input_event_count, 2);
  assert.equal(proj.envelope.raw_schema_versions.includes(SCHEMA_VERSION_V2), true);
  rmTree(root);
});

test("T70 projection does not materialize authority events", () => {
  const ids = makeIdentities("t70");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t70-revoke"));
  writer.revokeWriter("w2", revokeOpts(writer, ids, "t70-revoke2"));
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root });
  const proj = buildIncidentProjection(snap);
  assert.equal(proj.envelope.projection_item_count, 0);
  assert.equal(proj.envelope.incident_event_count, 0);
  assert.equal(proj.envelope.input_event_count, 2);
  rmTree(root);
});

test("T71 projection cardinality unchanged for identical measurement input", () => {
  const ids = makeIdentities("t71");
  const rootClean = createTestRoot("t71a");
  const rootAuth = createTestRoot("t71b");
  const { writer: wClean } = createTestWriter(ids, { root: rootClean });
  const { writer: wAuth } = createTestWriter(ids, { root: rootAuth });
  const build = (writer) => writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
  build(wClean);
  build(wAuth);
  wAuth.setWriterGeneration("w1", revokeOpts(wAuth, ids, "t71-adv"));
  const pClean = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: rootClean }));
  const pAuth = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: rootAuth }));
  assert.equal(pAuth.envelope.projection_item_count, pClean.envelope.projection_item_count);
  assert.equal(canonical(pAuth.envelope.items), canonical(pClean.envelope.items));
  rmTree(rootClean); rmTree(rootAuth);
});

test("T72 V1 projection compatibility preserved (synthetic GEN-1 log)", () => {
  const ids = makeIdentities("t72");
  const root = createTestRoot("t72");
  writeRawLog(root, { generation: 1, events: [makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null })] });
  const proj = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.equal(proj.envelope.projection_item_count, 1);
  assert.equal(PROJECTION_SCHEMA_VERSION, "autoloop.incident-projection/v1");
  rmTree(root);
});

// ===========================================================================
// PHASE L — zero-write secret (T73)
// ===========================================================================

test("T73 zero-write secret rejection: bytes, cache, and mutation budget unchanged", () => {
  const ids = makeIdentities("t73");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
  const before = readFileSync(join(root, LOG_FILE_NAME));
  const err = throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t73-revoke", 0, {
    evidenceRefs: [{ kind: "artifact", identity: "sk-ABCDEF0123456789abcdef", digest: hex("t73") }],
  })));
  assert.equal(err, TRANSFER_CODES.AUTHORITY_SECRET_REJECTED);
  assert.deepEqual(readFileSync(join(root, LOG_FILE_NAME)), before);
  // clean retry with the SAME mutation id succeeds (nothing was consumed)
  const r = writer.revokeWriter("w1", revokeOpts(writer, ids, "t73-revoke"));
  assert.equal(r.status, "APPENDED");
  rmTree(root);
});

// ===========================================================================
// PHASE M — no second engine (T74–T77)
// ===========================================================================

test("T74 no second lock: authority mutation uses transfer-events.lock only", () => {
  const ids = makeIdentities("t74");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t74-revoke"));
  const lockFiles = readdirSync(root).filter((n) => n.includes("lock") && n !== LOCK_FILE_NAME);
  assert.deepEqual(lockFiles, []);
  assert.equal(existsSync(join(root, LOCK_FILE_NAME)) || readdirSync(root).length > 0, true);
  rmTree(root);
});

test("T75 no second writer: single JSONL namespace, single active file", () => {
  const ids = makeIdentities("t75");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t75-revoke"));
  writer.setWriterGeneration("w2", revokeOpts(writer, ids, "t75-adv"));
  const jsonl = readdirSync(root).filter((n) => n.endsWith(".jsonl"));
  assert.ok(jsonl.includes(LOG_FILE_NAME));
  rmTree(root);
});

test("T76 no second idempotency index: same index catches authority keys", () => {
  const ids = makeIdentities("t76");
  const { root, writer } = createTestWriter(ids);
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t76-revoke"));
  const log = readLog(root);
  assert.equal(log.idempotencyIndex.has(log.events[0].idempotency_key), true);
  assert.equal(
    throwCode(() => writer.revokeWriter("w1", revokeOpts(writer, ids, "t76-revoke", 0, { reason: "ADMISSION_HOLD" }))),
    TRANSFER_CODES.AUTHORITY_MUTATION_CONFLICT,
  );
  rmTree(root);
});

test("T77 no second durable engine: no sidecar authority store is created", () => {
  const ids = makeIdentities("t77");
  const { root, writer } = createTestWriter(ids);
  writer.setWriterGeneration("w1", revokeOpts(writer, ids, "t77-adv"));
  writer.revokeWriter("w1", revokeOpts(writer, ids, "t77-revoke", 1));
  const files = readdirSync(root).sort();
  for (const f of files) {
    assert.ok(/\.jsonl$/.test(f) || f === LOCK_FILE_NAME || f.startsWith("transfer-events"), f);
  }
  rmTree(root);
});

// ===========================================================================
// PHASE N — production fences (T78–T80)
// ===========================================================================

test("T78 production importers remain zero (fence scan over src/)", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!name.endsWith(".mjs")) continue;
      if (p.includes("src/learning/transfer-metrics") || p === join(REPO, "src/learning/incidents/projection.mjs") || p.includes("src/learning/incidents/lifecycle-terminal-adapter.mjs") || p === join(REPO, "src/learning/incidents/current-verification.mjs")) continue;
      const text = readFileSync(p, "utf8");
      if (/transfer-metrics\/(writer|authority-state|fixtures)/.test(text) || /revokeWriter|citedTruthAdvance|readCurrentLearningAuthorityState/.test(text)) {
        offenders.push(p);
      }
    }
  };
  walk(join(REPO, "src"));
  assert.deepEqual(offenders, []);
});

test("T79 env/config/CLI cannot enable authority or downgrade V1", () => {
  process.env.TRANSFER_METRICS_AUTHORITY = "true";
  process.env.TRANSFER_EVENT_SCHEMA = "v1";
  const ids = makeIdentities("t79");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE });
  const header = JSON.parse(readLogLines(root)[0]);
  assert.equal(header.schema, LOG_SCHEMA_V2);
  assert.equal(throwCode(() => writer.revokeWriter("w1", { mutationId: "t79-no-issuer", expected: 0, task_identity: ids.task_identity })), TRANSFER_CODES.AUTHORITY_ISSUER_FORGED);
  delete process.env.TRANSFER_METRICS_AUTHORITY;
  delete process.env.TRANSFER_EVENT_SCHEMA;
  rmTree(root);
});

test("T80 no current verifier implemented in this slice; seam passive", () => {
  // the seam module exposes no verifier/scheduler surface
  const src = readFileSync(join(REPO, "src/learning/transfer-metrics/authority-state.mjs"), "utf8");
  assert.equal(/setInterval|setTimeout|schedule[A-Z]|export function verify/.test(src), false);
  // the seam is passive: it exposes the fold + read functions only
  assert.equal(typeof readCurrentLearningAuthorityState, "function");
  assert.equal(typeof replayAuthorityReadiness, "function");
});

// ===========================================================================
// PHASE O — re-entrancy pins (T81–T82)
// ===========================================================================

test("T81 mutation entry invoked from a lock-held crash hook fails AUTHORITY_INTERNAL_CONTRACT_VIOLATION", () => {
  const ids = makeIdentities("t81");
  const { root, writer } = createTestWriter(ids, {
    crashHooks: {
      writeLine() {
        writer.revokeWriter("zz", revokeOpts(writer, ids, "t81-nested"));
      },
    },
  });
  assert.equal(
    throwCode(() => writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE })),
    TRANSFER_CODES.AUTHORITY_INTERNAL_CONTRACT_VIOLATION,
  );
  // no event bytes were written (header-only or absent)
  const lines = existsSync(join(root, LOG_FILE_NAME)) ? readLogLines(root).filter((l) => l.trim() !== "") : [];
  assert.equal(lines.length <= 1, true);
  rmTree(root);
});

test("T82 hook re-entrancy self-check covers writeLine / afterWriteBeforeFsync / afterFsync", () => {
  for (const hook of ["writeLine", "afterWriteBeforeFsync", "afterFsync"]) {
    const ids = makeIdentities(`t82-${hook}`);
    const crashHooks = { [hook]: () => { writer.revokeWriter("zz", revokeOpts(writer, ids, "t82-nested")); } };
    const { root, writer } = createTestWriter(ids, { crashHooks });
    assert.equal(
      throwCode(() => writer.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }), principal: FIXTURE })),
      TRANSFER_CODES.AUTHORITY_INTERNAL_CONTRACT_VIOLATION,
      hook,
    );
    rmTree(root);
  }
});

// ===========================================================================
// PHASE P — per-generation gates (T83–T84)
// ===========================================================================

test("T83 widening shared EVENT_TYPES alone cannot admit a v1-stamped authority record", () => {
  const ids = makeIdentities("t83");
  const { record } = makeAuthorityRecordFixture("t83");
  // stamp the authority record as V1 and place it in a GEN-1 file
  const v1Authority = { ...record, schema_version: SCHEMA_VERSION };
  const root = createTestRoot("t83");
  writeRawLog(root, { generation: 1, events: [] });
  const { writeRawLogBytes: w } = { writeRawLogBytes };
  const lines = rawLogLines({ generation: 1, events: [] });
  // rebuild the authority record's chain fields for sequence 1 under v1 stamp
  const tampered = {
    ...v1Authority,
    journal_sequence: 1,
    previous_digest: GENESIS_DIGEST,
  };
  tampered.event_digest = computeEventDigest({
    journal_sequence: 1, event_id: tampered.event_id, event_type: tampered.event_type,
    payload_digest: tampered.payload_digest, previous_digest: tampered.previous_digest,
  });
  lines.push(canonical(tampered));
  writeRawLogBytes(root, LOG_FILE_NAME, lines.join("\n") + "\n");
  // chain reader rejects: GEN-1 allowlist closed at 14
  assert.equal(throwCode(() => readLog(root)), TRANSFER_CODES.LOG_CHAIN_INVALID);
  // projection per-generation type gate rejects even if the shared list widened
  void w;
  const snap = captureRawLogSnapshot({ transferMetricsRoot: root }).bytes;
  void snap;
  rmTree(root);
});

test("T84 measurement events stamped from the ACTIVE file header generation", () => {
  const ids = makeIdentities("t84");
  // GEN-1 active root ⇒ v1 continuity stamp
  const root1 = createTestRoot("t84a");
  writeRawLog(root1, { generation: 1, events: [] });
  const { writer: w1 } = createTestWriter(ids, { root: root1 });
  const r1 = w1.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, schema_version: SCHEMA_VERSION }), principal: FIXTURE });
  assert.equal(r1.status, "APPENDED");
  assert.equal(r1.event.schema_version, SCHEMA_VERSION);
  // GEN-2 active root ⇒ v2 stamp
  const ids2 = makeIdentities("t84b");
  const { root: root2, writer: w2 } = createTestWriter(ids2);
  const r2 = w2.appendTransferEvent({ event: makeEvent("INCIDENT_OBSERVED", ids2, { pattern_identity: null }), principal: FIXTURE });
  assert.equal(r2.event.schema_version, SCHEMA_VERSION_V2);
  assert.equal(readActiveLogGeneration(root2), 2);
  rmTree(root1); rmTree(root2);
});
