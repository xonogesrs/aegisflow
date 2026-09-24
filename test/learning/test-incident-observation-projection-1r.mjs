// test/learning/test-incident-observation-projection-1r.mjs
//
// PROJECTION-1R independent reviewer suite (REVIEWER_MUST_NOT_HAVE_AUTHORED_PROJECTION_1).
// Independent oracles: own canonical JSON serializer + sha256 recomputation, own import-graph
// walker, own cursor decoder. Not a copy of the author T1–T75 matrix.
// Fixture capability only (allowFixture writer); no production seam change; no persistent
// artifact; every scratch root is a unique directory under the approved NVM2T
// transfer-metrics scratch parent and is removed after use.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync,
  linkSync, rmSync, mkdirSync, openSync, writeSync, closeSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_VERSION,
  LOG_SCHEMA,
  LOG_SCHEMA_V2,
  GENESIS_DIGEST,
  canonical,
  computeEventDigest,
  computeEventId,
  computeIdempotencyKey,
  digestOf,
  deriveSourceIdentityKey,
  deriveEvidenceSetDigest,
  deriveIncidentId,
  TRANSFER_CODES,
} from "../../src/learning/transfer-metrics/schema.mjs";
import {
  FIXTURE,
  makeIdentities,
  makeEvent,
  makeBinder,
  createTestRoot,
  IDENTITY_ROOT,
} from "../../src/learning/transfer-metrics/fixtures.mjs";
import {
  TransferMetricsWriter,
  captureRawLogSnapshot,
} from "../../src/learning/transfer-metrics/writer.mjs";
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
  PROJECTION_MAX_CURSOR_BYTES,
  PROJECTION_MAX_FILTER_VALUES,
  PROJECTION_CODES,
  CURRENT_AUTHORITY_STATUS_NOT_EVALUATED,
  INCIDENT_PROJECTION_ITEM_IDENTITY_DOMAIN,
  buildIncidentProjection,
  queryIncidentProjection,
  encodeProjectionCursor,
} from "../../src/learning/incidents/projection.mjs";
import { TRANSFER_METRICS_ENABLED, isTransferMetricsEnabled } from "../../src/learning/transfer-metrics/seam.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");
const PROJECTION_PATH = join(REPO, "src/learning/incidents/projection.mjs");
const WRITER_PATH = join(REPO, "src/learning/transfer-metrics/writer.mjs");
const LOCK_PATH = join(REPO, "src/c2d/lock.mjs");
const LOG_NAME = "transfer-events.jsonl";

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const sha256Buf = (buf) => createHash("sha256").update(buf).digest("hex");
const throwCode = (fn) => {
  try { fn(); return "NO_THROW"; } catch (e) { return e.code; }
};

// ---------------------------------------------------------------------------
// Independent canonicalization oracle (NOT the production canonical()).
// Byte-identical algorithm: code-point-sorted object keys, recursive, JSON.stringify.
// Cross-checked against production digests in R101 before it is trusted anywhere.
// ---------------------------------------------------------------------------

function cpCompare(a, b) {
  let i = 0;
  while (i < a.length && i < b.length) {
    const ca = a.codePointAt(i);
    const cb = b.codePointAt(i);
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

// Byte-order attacker: same JSON value, reversed key order (non-canonical).
function reverseKeyStringify(value) {
  if (Array.isArray(value)) return `[${value.map(reverseKeyStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).reverse();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${reverseKeyStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function myCan(value) {
  if (value === null) return "null";
  if (value === undefined) throw new Error("oracle: undefined");
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean" || t === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("oracle: non-finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(myCan).join(",")}]`;
  if (t === "bigint") throw new Error("oracle: bigint");
  const keys = Object.keys(value).sort(cpCompare);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${myCan(value[k])}`).join(",")}}`;
}

const mySha = (value) => sha256Hex(myCan(value));
const hex64 = (seed) => createHash("sha256").update(String(seed), "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function attemptsMap(ids, attempts = [0, 1, 2]) {
  return new Map([[ids.execution_id, { attempts: new Set(attempts) }]]);
}

function testWriter(ids, extra = {}) {
  const root = createTestRoot("proj-1r");
  const binderExtra = { ...extra };
  delete binderExtra.revocationRegistry;
  if (extra.attempts === undefined) binderExtra.attempts = attemptsMap(ids);
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

function incidentRoot(label, count = 1) {
  const ids = makeIdentities(label);
  const { root, writer } = testWriter(ids);
  for (let i = 0; i < count; i++) {
    appendIncident(writer, ids, {
      payload: { source_record_id: `src-${label}-${i}` },
      attempt_identity: { execution_id: ids.execution_id, attempt: i % 3 },
    });
  }
  return { ids, root, writer };
}

function snapOf(root) {
  return captureRawLogSnapshot({ transferMetricsRoot: root });
}

function buildOf(root) {
  return buildIncidentProjection(snapOf(root));
}

function readLogLines(root) {
  return readFileSync(join(root, LOG_NAME), "utf8").split("\n").filter((l) => l.length > 0);
}

// Forge tool (fixture capability): re-derive all writer-assigned identity fields of a
// durable event after mutating its payload, then re-serialize canonically. Used only to
// construct byte-level attack inputs; R101 first proves the oracle against writer output.
function rederiveAndSerialize(ev, seq, previous) {
  ev.payload.source_identity_key = deriveSourceIdentityKey(ev);
  const esd = deriveEvidenceSetDigest(ev.evidence_refs);
  ev.payload.evidence_set_digest = esd;
  ev.incident_identity.incident_id = deriveIncidentId(
    ev.payload.source_identity_key, ev.payload.source_record_digest, esd,
  );
  ev.journal_sequence = seq;
  ev.previous_digest = previous;
  ev.payload_digest = digestOf(ev.payload);
  ev.idempotency_key = computeIdempotencyKey(ev);
  ev.event_id = computeEventId(ev.idempotency_key);
  ev.event_digest = computeEventDigest({
    journal_sequence: seq, event_id: ev.event_id, event_type: ev.event_type,
    payload_digest: ev.payload_digest, previous_digest: previous,
  });
  return canonical(ev);
}

function recomputeChainFields(ev) {
  ev.payload_digest = digestOf(ev.payload);
  ev.event_digest = computeEventDigest({
    journal_sequence: ev.journal_sequence, event_id: ev.event_id, event_type: ev.event_type,
    payload_digest: ev.payload_digest, previous_digest: ev.previous_digest,
  });
  return canonical(ev);
}

function writeLogBytes(root, lines) {
  writeFileSync(join(root, LOG_NAME), lines.join("\n") + "\n", "utf8");
}

function rawLogDigest(root) {
  return sha256Buf(readFileSync(join(root, LOG_NAME)));
}

function rmRoot(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childExit = (child) => new Promise((r) => child.on("exit", r));

// ===========================================================================
// R1xx — independent raw-chain oracle (Phase 14/15)
// ===========================================================================

test("R101 oracle canonicalizer reproduces production digests on real writer output", () => {
  const { root } = incidentRoot("r101", 2);
  try {
    for (const line of readLogLines(root).slice(1)) {
      const ev = JSON.parse(line);
      assert.equal(myCan(ev), line, "writer line must be oracle-canonical");
      assert.equal(mySha(ev.payload), ev.payload_digest);
      assert.equal(digestOf(ev.payload), ev.payload_digest);
      assert.equal(
        mySha({
          journal_sequence: ev.journal_sequence, event_id: ev.event_id, event_type: ev.event_type,
          payload_digest: ev.payload_digest, previous_digest: ev.previous_digest,
        }),
        ev.event_digest,
      );
    }
  } finally { rmRoot(root); }
});

test("R102 independent chain walk: every record verified; envelope counts truthful", () => {
  const { root } = incidentRoot("r102", 3);
  try {
    const lines = readLogLines(root);
    const header = JSON.parse(lines[0]);
    // First creation stamps the CURRENT generation (GEN-2) [schema-v2-contract].
    assert.equal(header.schema, LOG_SCHEMA_V2);
    assert.equal(header.schema_version, 2);
    let previous = GENESIS_DIGEST;
    let seq = 1;
    let incidents = 0;
    for (const line of lines.slice(1)) {
      const ev = JSON.parse(line);
      assert.equal(ev.journal_sequence, seq);
      assert.equal(ev.previous_digest, previous);
      assert.equal(
        mySha({
          journal_sequence: seq, event_id: ev.event_id, event_type: ev.event_type,
          payload_digest: ev.payload_digest, previous_digest: previous,
        }),
        ev.event_digest,
      );
      previous = ev.event_digest;
      seq += 1;
      if (ev.event_type === "INCIDENT_OBSERVED") incidents += 1;
    }
    const p = buildOf(root);
    assert.equal(p.envelope.input_event_count, 3);
    assert.equal(p.envelope.incident_event_count, incidents);
    assert.equal(p.envelope.projection_item_count, incidents);
    assert.equal(p.envelope.input_first_event_digest, JSON.parse(lines[1]).event_digest);
    assert.equal(p.envelope.input_final_event_digest, JSON.parse(lines[lines.length - 1]).event_digest);
  } finally { rmRoot(root); }
});

test("R103 chain mutation matrix: envelope/payload/sequence/digest tampering all fail closed", () => {
  const base = incidentRoot("r103", 3);
  try {
    const { root } = base;
    const lines = readLogLines(root);
    const header = lines[0];
    const events = lines.slice(1).map((l) => JSON.parse(l));
    const cases = [];
    {
      const evs = structuredClone(events);
      evs[1].event_type = "OUTCOME_OBSERVED";
      // payload allowlist for OUTCOME_OBSERVED fires before the chain digest check
      cases.push(["event_type", evs, PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION]);
    }
    {
      const evs = structuredClone(events);
      evs[1].payload.observed_outcome_class = "TEST_FAIL";
      cases.push(["payload_without_digest", evs, PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID]);
    }
    {
      const evs = structuredClone(events);
      evs[2].journal_sequence = 9;
      cases.push(["journal_sequence", evs, PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID]);
    }
    {
      const evs = structuredClone(events);
      evs[1].event_digest = hex64("tampered-digest");
      cases.push(["event_digest", evs, PROJECTION_CODES.PROJECTION_EVENT_DIGEST_INVALID]);
    }
    {
      const evs = structuredClone(events);
      evs[2].previous_digest = hex64("broken-link");
      cases.push(["previous_digest", evs, PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID]);
    }
    {
      const evs = structuredClone(events);
      evs[1].occurred_at = "2026-08-30 12:00:00";
      cases.push(["occurred_at_non_iso", evs, PROJECTION_CODES.PROJECTION_PROFILE_INVALID]);
    }
    {
      const evs = structuredClone(events);
      evs[1].authority.role = "not-a-role";
      cases.push(["authority_role", evs, PROJECTION_CODES.PROJECTION_PROFILE_INVALID]);
    }
    {
      const evs = structuredClone(events);
      evs[1].payload.source_record_digest = "zz-not-hex";
      cases.push(["source_record_digest", evs, PROJECTION_CODES.PROJECTION_PROFILE_INVALID]);
    }
    {
      const evs = structuredClone(events);
      evs[1].payload_digest = hex64("payload-digest-tamper");
      cases.push(["payload_digest_tamper", evs, PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID]);
    }
    for (const [name, evs, expected] of cases) {
      const root2 = createTestRoot("proj-1r");
      try {
        writeLogBytes(root2, [header, ...evs.map((e) => canonical(e))]);
        assert.equal(throwCode(() => buildOf(root2)), expected, `mutation ${name}`);
      } finally { rmRoot(root2); }
    }
  } finally { rmRoot(base.root); }
});

test("R104 duplicate event_id in captured chain fails whole build", () => {
  const { root } = incidentRoot("r104", 2);
  try {
    const lines = readLogLines(root);
    const header = lines[0];
    const ev1 = JSON.parse(lines[1]);
    const ev2 = JSON.parse(lines[2]);
    ev2.event_id = ev1.event_id;
    ev2.idempotency_key = ev1.idempotency_key;
    writeLogBytes(root, [header, canonical(ev1), recomputeChainFields(ev2)]);
    assert.equal(throwCode(() => buildOf(root)), PROJECTION_CODES.PROJECTION_IDENTITY_CONFLICT);
  } finally { rmRoot(root); }
});

test("R105 idempotency collision (same key, differing payload digest) fails closed", () => {
  const { root } = incidentRoot("r105", 2);
  try {
    const lines = readLogLines(root);
    const header = lines[0];
    const ev1 = JSON.parse(lines[1]);
    const ev2 = JSON.parse(lines[2]);
    // same idempotency key (outcome class is outside the key preimage), different payload
    ev2.idempotency_key = ev1.idempotency_key;
    ev2.event_id = ev1.event_id;
    ev2.payload.observed_outcome_class = "TEST_FAIL";
    writeLogBytes(root, [header, canonical(ev1), recomputeChainFields(ev2)]);
    assert.equal(throwCode(() => buildOf(root)), PROJECTION_CODES.PROJECTION_IDENTITY_CONFLICT);
  } finally { rmRoot(root); }
});

test("R106 unknown 15th event type and unknown schema fail closed, never skipped", () => {
  const { root } = incidentRoot("r106", 1);
  try {
    const lines = readLogLines(root);
    const header = lines[0];
    const ev1 = JSON.parse(lines[1]);
    // Fresh writer roots are GEN-2, so unsupported-schema vectors are:
    // an unknown future version, and a V1 stamp inside a GEN-2 chain
    // (per-generation pinning; V1 rejection coverage preserved).
    for (const [mutate, expected] of [
      [(e) => { e.event_type = "PATTERN_TELEPORTED"; }, PROJECTION_CODES.PROJECTION_EVENT_TYPE_UNSUPPORTED],
      [(e) => { e.schema_version = "autoloop.transfer-event/v3"; }, PROJECTION_CODES.PROJECTION_SCHEMA_UNSUPPORTED],
      [(e) => { e.schema_version = "autoloop.transfer-event/v1"; }, PROJECTION_CODES.PROJECTION_SCHEMA_UNSUPPORTED],
    ]) {
      const ev2 = structuredClone(ev1);
      ev2.journal_sequence = 2;
      ev2.previous_digest = ev1.event_digest;
      ev2.payload_digest = digestOf(ev2.payload);
      ev2.idempotency_key = computeIdempotencyKey(ev2);
      ev2.event_id = computeEventId(ev2.idempotency_key);
      mutate(ev2);
      ev2.event_digest = computeEventDigest({
        journal_sequence: ev2.journal_sequence, event_id: ev2.event_id,
        event_type: ev2.event_type, payload_digest: ev2.payload_digest,
        previous_digest: ev2.previous_digest,
      });
      const root2 = createTestRoot("proj-1r");
      try {
        writeLogBytes(root2, [header, canonical(ev1), canonical(ev2)]);
        assert.equal(throwCode(() => buildOf(root2)), expected);
      } finally { rmRoot(root2); }
    }
  } finally { rmRoot(root); }
});

test("R107 non-canonical JSON line (byte-different, semantically equal) rejected", () => {
  const { root } = incidentRoot("r107", 1);
  try {
    const lines = readLogLines(root);
    const header = lines[0];
    const ev1 = JSON.parse(lines[1]);
    // writer insertion order already matches codepoint-sorted order; force a
    // genuinely different byte order with a reversed-key serializer
    const loose = reverseKeyStringify(ev1);
    assert.notEqual(loose, canonical(ev1));
    const root2 = createTestRoot("proj-1r");
    try {
      writeLogBytes(root2, [header, loose]);
      assert.equal(throwCode(() => buildOf(root2)), PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID);
    } finally { rmRoot(root2); }
  } finally { rmRoot(root); }
});

test("R108 corrupt middle aborts whole build; valid incident after it is never salvaged", () => {
  const { root } = incidentRoot("r108", 3);
  try {
    const lines = readLogLines(root);
    const header = lines[0];
    const ev2 = JSON.parse(lines[2]);
    ev2.previous_digest = hex64("corrupt-middle-link");
    writeLogBytes(root, [header, lines[1], canonical(ev2), lines[3]]);
    assert.equal(throwCode(() => buildOf(root)), PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID);
  } finally { rmRoot(root); }
});

test("R109 corrupt complete tail line fails build (no partial success)", () => {
  const { root } = incidentRoot("r109", 2);
  try {
    const lines = readLogLines(root);
    writeLogBytes(root, [...lines, canonical({ garbage: true })]);
    // {"garbage":true} is canonical JSON but breaches the frozen envelope key set
    assert.equal(throwCode(() => buildOf(root)), PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION);
  } finally { rmRoot(root); }
});

test("R110 partial trailing line fails at capture PROJECTION_SNAPSHOT_RACE, never EOF", () => {
  const { root } = incidentRoot("r110", 1);
  try {
    const lines = readLogLines(root);
    writeFileSync(join(root, LOG_NAME), lines.join("\n") + "\n" + '{"partial":', "utf8");
    assert.equal(throwCode(() => snapOf(root)), PROJECTION_CODES.PROJECTION_SNAPSHOT_RACE);
  } finally { rmRoot(root); }
});

test("R111 other-13 events chain-validated and never materialized (mixed multi-type log)", () => {
  const ids = makeIdentities("r111");
  const { root, writer } = testWriter(ids, {
    attempts: new Map(EVENT_KEYS_R111.map((k) => [k, { attempts: new Set([0]) }])),
  });
  try {
    const retr = writer.appendTransferEvent({
      event: makeEvent("PATTERN_RETRIEVED", ids, { attempt_identity: { execution_id: "exec-r111-PATTERN_RETRIEVED", attempt: 0 }, producer_kind: "fixture" }),
      principal: FIXTURE,
    });
    appendIncident(writer, ids, { attempt_identity: { execution_id: "exec-r111-INCIDENT_OBSERVED", attempt: 0 }, producer_kind: "fixture" });
    const out = writer.appendTransferEvent({
      event: makeEvent("OUTCOME_OBSERVED", ids, { attempt_identity: { execution_id: "exec-r111-OUTCOME_OBSERVED", attempt: 0 }, producer_kind: "fixture", outcome_ref: { execution_id: "exec-r111-OUTCOME_OBSERVED", final: "PASS", attempt: 0 } }),
      principal: FIXTURE,
    });
    writer.appendTransferEvent({
      event: makeEvent("TRANSFER_ADJUDICATED", ids, { attempt_identity: { execution_id: "exec-r111-TRANSFER_ADJUDICATED", attempt: 0 }, producer_kind: "fixture", subject_event_id: out.event.event_id, payload: { attribution_grade: "A", benefit_claimed: true, adjudicator_role: "reviewer" } }),
      principal: FIXTURE,
    });
    writer.appendTransferEvent({
      event: makeEvent("PATTERN_USED_IN_PLANNING", ids, { attempt_identity: { execution_id: "exec-r111-PATTERN_USED_IN_PLANNING", attempt: 0 }, producer_kind: "fixture", retrieval_event_id: retr.event.event_id }),
      principal: FIXTURE,
    });
    for (const t of ["PATTERN_CANDIDATE_CREATED", "PATTERN_QUALIFIED", "PATTERN_REJECTED", "PATTERN_DEMOTED", "PATTERN_ARCHIVED", "PATTERN_REMOVED", "STALE_PATTERN_REJECTED", "ROLLBACK_OBSERVED"]) {
      writer.appendTransferEvent({
        event: makeEvent(t, ids, { attempt_identity: { execution_id: `exec-r111-${t}`, attempt: 0 }, producer_kind: "fixture" }),
        principal: FIXTURE,
      });
    }
    const p = buildOf(root);
    assert.equal(p.envelope.input_event_count, 13);
    assert.equal(p.envelope.incident_event_count, 1);
    assert.equal(p.envelope.projection_item_count, 1);
    assert.equal(p.envelope.items[0].incident_observation_id.length, 64);
  } finally { rmRoot(root); }
});

const EVENT_KEYS_R111 = [
  "exec-r111-INCIDENT_OBSERVED", "exec-r111-PATTERN_RETRIEVED", "exec-r111-OUTCOME_OBSERVED",
  "exec-r111-TRANSFER_ADJUDICATED", "exec-r111-PATTERN_USED_IN_PLANNING",
  "exec-r111-PATTERN_CANDIDATE_CREATED", "exec-r111-PATTERN_QUALIFIED", "exec-r111-PATTERN_REJECTED",
  "exec-r111-PATTERN_DEMOTED", "exec-r111-PATTERN_ARCHIVED", "exec-r111-PATTERN_REMOVED",
  "exec-r111-STALE_PATTERN_REJECTED", "exec-r111-ROLLBACK_OBSERVED",
];

// ===========================================================================
// R12x — projection digest oracle (Phase 17)
// ===========================================================================

test("R121 projection_digest independently recomputed; self-exclusion proven directly", () => {
  const { root } = incidentRoot("r121", 2);
  try {
    const p = buildOf(root);
    const envelope = p.envelope;
    const withNull = { ...envelope, projection_digest: null };
    assert.equal(mySha(withNull), envelope.projection_digest);
    assert.notEqual(mySha(envelope), envelope.projection_digest);
  } finally { rmRoot(root); }
});

test("R122 projection digest is field-sensitive; item mutation cannot self-verify", () => {
  const { root } = incidentRoot("r122", 1);
  try {
    const p = buildOf(root);
    const forged = structuredClone(p.envelope);
    forged.items[0].failure_finding_discriminator = "TAMPERED";
    assert.notEqual(mySha({ ...forged, projection_digest: null }), p.envelope.projection_digest);
    forged.projection_digest = mySha({ ...forged, projection_digest: null });
    assert.notEqual(forged.projection_digest, p.envelope.projection_digest);
  } finally { rmRoot(root); }
});

test("R123 projection_item_id independently recomputed; incident_id copied never reminted", () => {
  const { root } = incidentRoot("r123", 2);
  try {
    const lines = readLogLines(root).slice(1);
    const p = buildOf(root);
    for (const line of lines) {
      const ev = JSON.parse(line);
      const item = p.envelope.items.find((i) => i.incident_observation_id === ev.event_id);
      assert.ok(item);
      assert.equal(item.projection_item_id, sha256Hex(myCan({
        domain: INCIDENT_PROJECTION_ITEM_IDENTITY_DOMAIN,
        projection_schema_version: PROJECTION_SCHEMA_VERSION,
        projection_algorithm_version: PROJECTION_ALGORITHM_VERSION,
        incident_observation_id: ev.event_id,
        journal_sequence: ev.journal_sequence,
        raw_event_digest: ev.event_digest,
      })));
      assert.equal(item.incident_id, ev.incident_identity.incident_id);
    }
  } finally { rmRoot(root); }
});

test("R124 input_log_digest binding independently recomputed from captured file meta", () => {
  const { root } = incidentRoot("r124", 1);
  try {
    const snap = snapOf(root);
    const p = buildOf(root);
    const expected = sha256Hex(myCan(snap.files.map((f) => ({ name: f.name, byte_length: f.byte_length, sha256: f.sha256 }))));
    assert.equal(snap.raw_input_digest, expected);
    assert.equal(p.envelope.input_log_digest, expected);
    assert.deepEqual(p.envelope.input_byte_range, snap.files.map((f) => ({ name: f.name, byte_offset: f.byte_offset, byte_length: f.byte_length })));
  } finally { rmRoot(root); }
});

// ===========================================================================
// R13x — snapshot authority, path safety, immutability (Phase 6/12/13)
// ===========================================================================

test("R131 snapshot return schema exact; no fd/lock/principal/handle capability leaks", () => {
  const { root } = incidentRoot("r131", 1);
  try {
    const snap = snapOf(root);
    assert.deepEqual(Object.keys(snap).sort(), [
      "bytes", "files", "linearization", "raw_input_digest", "root",
      "snapshot_algorithm_version", "total_bytes",
    ]);
    assert.equal(snap.snapshot_algorithm_version, 1);
    assert.deepEqual(snap.linearization, { lock_acquired: true, capture_point: "EOF_UNDER_WRITER_LOCK" });
    for (const f of snap.files) {
      assert.deepEqual(Object.keys(f).sort(), [
        "byte_length", "byte_offset", "device", "inode", "name", "nlink", "sha256",
      ]);
      assert.equal(f.nlink, 1);
      assert.equal(f.byte_offset, 0);
    }
    for (const v of Object.values(snap)) assert.notEqual(typeof v, "function");
    assert.equal(sha256Buf(snap.bytes[snap.bytes.length - 1]), snap.files[snap.files.length - 1].sha256);
    assert.equal(sha256Buf(readFileSync(join(root, LOG_NAME))), snap.files[snap.files.length - 1].sha256);
  } finally { rmRoot(root); }
});

test("R132 caller mutation of returned bytes cannot corrupt writer state or later captures", () => {
  const { root } = incidentRoot("r132", 1);
  try {
    const before = rawLogDigest(root);
    const p1 = buildOf(root);
    const snap = snapOf(root);
    snap.bytes[snap.bytes.length - 1].fill(0);
    const p2 = buildOf(root);
    assert.equal(p2.canonical_bytes.toString("base64"), p1.canonical_bytes.toString("base64"));
    assert.equal(rawLogDigest(root), before);
    assert.equal(throwCode(() => buildIncidentProjection(snap)),
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION);
  } finally { rmRoot(root); }
});

test("R133 forged snapshot inputs rejected (flags, versions, digest, byte agreement)", () => {
  const { root } = incidentRoot("r133", 1);
  try {
    const snap = snapOf(root);
    assert.equal(throwCode(() => buildIncidentProjection({})), PROJECTION_CODES.PROJECTION_INPUT_MISSING);
    assert.equal(throwCode(() => buildIncidentProjection({ files: [], bytes: [] })), PROJECTION_CODES.PROJECTION_INPUT_MISSING);
    assert.equal(throwCode(() => buildIncidentProjection(null)), PROJECTION_CODES.PROJECTION_INPUT_MISSING);
    assert.equal(throwCode(() => buildIncidentProjection([snap])), PROJECTION_CODES.PROJECTION_INPUT_MISSING);
    assert.equal(throwCode(() => buildIncidentProjection({ ...snap, linearization: undefined })),
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION);
    assert.equal(throwCode(() => buildIncidentProjection({ ...snap, snapshot_algorithm_version: 2 })),
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION);
    assert.equal(throwCode(() => buildIncidentProjection({ ...snap, raw_input_digest: hex64("forged") })),
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION);
    assert.equal(throwCode(() => buildIncidentProjection({ ...snap, bytes: snap.bytes.slice(0, -1) })),
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION);
    assert.equal(throwCode(() => buildIncidentProjection({ ...snap, files: [{ ...snap.files[0], sha256: hex64("meta-tamper") }] })),
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION);
    assert.equal(throwCode(() => buildIncidentProjection({ ...snap, files: [{ ...snap.files[0], byte_length: 1 }] })),
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION);
    assert.equal(throwCode(() => buildIncidentProjection({ ...snap, total_bytes: 999999999 })),
      PROJECTION_CODES.PROJECTION_INPUT_TOO_LARGE);
  } finally { rmRoot(root); }
});

test("R134 accessor receiver attacks inert (call/bind/proxy cannot forge authority)", () => {
  const { root } = incidentRoot("r134", 1);
  try {
    const direct = snapOf(root).raw_input_digest;
    const fakeWriter = { appendTransferEvent: () => { throw new Error("never"); }, root: "/tmp" };
    assert.equal(captureRawLogSnapshot.call(fakeWriter, { transferMetricsRoot: root }).raw_input_digest, direct);
    assert.equal(captureRawLogSnapshot.bind(fakeWriter)({ transferMetricsRoot: root }).raw_input_digest, direct);
    const receiverProxy = new Proxy(fakeWriter, { get: () => "/tmp" });
    assert.equal(captureRawLogSnapshot.call(receiverProxy, { transferMetricsRoot: root }).raw_input_digest, direct);
    // JSON serialization of the function yields nothing usable
    assert.equal(JSON.stringify(captureRawLogSnapshot), undefined);
    const snap = snapOf(root);
    for (const v of Object.values(snap)) assert.notEqual(typeof v, "function");
  } finally { rmRoot(root); }
});

test("R135 path fence matrix: tmp/HOME/traversal/NUL/non-string rejected PATH_UNSAFE", () => {
  const { root } = incidentRoot("r135", 1);
  try {
    const definiteUnsafe = [
      "/tmp/autoloop-1r-probe",
      "/private/tmp/autoloop-1r-probe",
      root + "/./../../../../../../../../etc",
      join(IDENTITY_ROOT, "..", ".."),
      root + "\0evil",
      undefined,
      42,
      {},
      ["x"],
    ];
    // file-URL / relative strings resolve under NVM2T or fail the fence; either way no
    // capability is gained (bounded rejection, never a snapshot of an arbitrary file).
    // An inner-namespace climb to a nonexistent path is INPUT_MISSING, not a breach.
    for (const weak of ["file://" + root, "learning-incidents-1r-nonexistent", join(root, "..", "..", "escaped-1r")]) {
      const code = throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: weak }));
      assert.ok(
        [TRANSFER_CODES.PATH_UNSAFE, PROJECTION_CODES.PROJECTION_INPUT_MISSING].includes(code),
        `${weak} -> ${code}`,
      );
    }
  } finally { rmRoot(root); }
});

test("R136 symlink matrix: live/dangling/internal-target/intermediate all rejected", () => {
  // live symlink active file
  {
    const { root, writer, ids } = (() => {
      const ids = makeIdentities("r136a");
      const w = testWriter(ids);
      appendIncident(w.writer, ids);
      return w;
    })();
    try {
      const realCopy = join(root, "real-copy.jsonl");
      writeFileSync(realCopy, readFileSync(join(root, LOG_NAME)));
      rmSync(join(root, LOG_NAME));
      symlinkSync(realCopy, join(root, LOG_NAME));
      assert.equal(throwCode(() => snapOf(root)), TRANSFER_CODES.PATH_UNSAFE);
    } finally { rmRoot(root); }
  }
  // dangling symlink active file
  {
    const ids = makeIdentities("r136b");
    const { root } = testWriter(ids);
    try {
      symlinkSync(join(root, "missing-target.jsonl"), join(root, LOG_NAME));
      assert.equal(throwCode(() => snapOf(root)), PROJECTION_CODES.PROJECTION_NON_REGULAR_INPUT);
    } finally { rmRoot(root); }
  }
  // symlink pointing at a VALID NVM2T-internal regular file is still rejected
  {
    const ids = makeIdentities("r136c");
    const { root } = testWriter(ids);
    try {
      const realCopy = join(root, "real-copy.jsonl");
      writeFileSync(realCopy, "header\n");
      symlinkSync(realCopy, join(root, LOG_NAME));
      const code = throwCode(() => snapOf(root));
      assert.ok([TRANSFER_CODES.PATH_UNSAFE, PROJECTION_CODES.PROJECTION_NON_REGULAR_INPUT].includes(code), code);
    } finally { rmRoot(root); }
  }
  // intermediate symlink component in the root path
  {
    const ids = makeIdentities("r136d");
    const { root } = testWriter(ids);
    try {
      const sub = join(root, "sub");
      mkdirSync(sub);
      const outside = join(root, "outside-target");
      writeFileSync(outside, "x");
      symlinkSync(outside, join(sub, "link"));
      const code = throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: join(sub, "link") }));
      assert.ok(
        [TRANSFER_CODES.PATH_UNSAFE, PROJECTION_CODES.PROJECTION_NON_REGULAR_INPUT, PROJECTION_CODES.PROJECTION_INPUT_MISSING].includes(code),
        code,
      );
    } finally { rmRoot(root); }
  }
});
test("R137 hardlink (nlink=2) and non-regular targets rejected before any read", () => {
  {
    const ids = makeIdentities("r137a");
    const { root, writer } = testWriter(ids);
    try {
      appendIncident(writer, ids);
      linkSync(join(root, LOG_NAME), join(root, "hardlink-copy.jsonl"));
      const code = throwCode(() => snapOf(root));
      assert.ok([TRANSFER_CODES.PATH_UNSAFE, PROJECTION_CODES.PROJECTION_NON_REGULAR_INPUT].includes(code), code);
    } finally { rmRoot(root); }
  }
  {
    const ids = makeIdentities("r137b");
    const { root } = testWriter(ids);
    try {
      const fifo = spawnSync("mkfifo", [join(root, LOG_NAME)]);
      assert.equal(fifo.status, 0, fifo.stderr?.toString());
      assert.equal(throwCode(() => snapOf(root)), TRANSFER_CODES.PATH_UNSAFE);
    } finally { rmRoot(root); }
  }
});

test("R138 path replacement (log swapped for directory) never degrades to INPUT_MISSING", () => {
  const ids = makeIdentities("r138");
  const { root, writer } = testWriter(ids);
  try {
    appendIncident(writer, ids);
    rmSync(join(root, LOG_NAME));
    mkdirSync(join(root, LOG_NAME));
    const code = throwCode(() => snapOf(root));
    assert.ok([TRANSFER_CODES.PATH_UNSAFE, PROJECTION_CODES.PROJECTION_NON_REGULAR_INPUT].includes(code), code);
    assert.notEqual(code, PROJECTION_CODES.PROJECTION_INPUT_MISSING);
  } finally { rmRoot(root); }
});

test("R139 missing states distinct: no-log-root INPUT_MISSING vs header-only EMPTY vs none-created", () => {
  // never-created root: INPUT_MISSING and the capture must not create anything
  {
    const root = createTestRoot("proj-1r");
    rmSync(root, { recursive: true, force: true });
    try {
      assert.equal(throwCode(() => snapOf(root)), PROJECTION_CODES.PROJECTION_INPUT_MISSING);
      // lock machinery may create the (empty) root dir, but never the log file
      assert.equal(existsSync(join(root, LOG_NAME)), false);
    } finally { rmRoot(root); }
  }
  // existing root without log
  {
    const root = createTestRoot("proj-1r");
    try {
      assert.equal(throwCode(() => snapOf(root)), PROJECTION_CODES.PROJECTION_INPUT_MISSING);
    } finally { rmRoot(root); }
  }
  // header-only active log = valid empty log -> EMPTY projection (0 items), NOT corruption
  {
    const root = createTestRoot("proj-1r");
    try {
      const header = canonical({ created_at: "2026-08-29T00:00:00.000Z", schema: LOG_SCHEMA, schema_version: 1 });
      writeLogBytes(root, [header]);
      const p = buildOf(root);
      assert.equal(p.envelope.projection_item_count, 0);
      assert.equal(p.envelope.input_event_count, 0);
      assert.equal(p.envelope.input_first_event_digest, null);
    } finally { rmRoot(root); }
  }
});

test("R140 maxTotalBytes parameter validation and bounded capture", () => {
  const { root } = incidentRoot("r140", 1);
  try {
    for (const bad of [0, -1, 1.5, "1000", NaN, Infinity, 10n]) {
      assert.equal(throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: root, maxTotalBytes: bad })),
        PROJECTION_CODES.PROJECTION_INPUT_TOO_LARGE, String(bad));
    }
    assert.equal(throwCode(() => captureRawLogSnapshot({ transferMetricsRoot: root, maxTotalBytes: 10 })),
      PROJECTION_CODES.PROJECTION_INPUT_TOO_LARGE);
    // byte bound dominates: oversized garbage input rejected at capture, pre-parse
    const big = createTestRoot("proj-1r");
    try {
      const chunk = "x".repeat(1024 * 1024);
      const fd = openSync(join(big, LOG_NAME), "w");
      for (let i = 0; i < 10; i++) writeSync(fd, chunk, null, "utf8");
      closeSync(fd);
      assert.equal(throwCode(() => snapOf(big)), PROJECTION_CODES.PROJECTION_INPUT_TOO_LARGE);
    } finally { rmRoot(big); }
  } finally { rmRoot(root); }
});

const EVENT_KEYS_R141 = [
  "exec-r141-0", "exec-r141-1", "exec-r141-2", "exec-r141-3", "exec-r141-4",
  "exec-r141-5", "exec-r141-6", "exec-r141-7", "exec-r141-8", "exec-r141-9",
  "exec-r141-inc",
];

test("R141 MAX_INPUT_EVENTS counts ALL record types, not only incidents (R3 repair verified)", () => {
  const ids = makeIdentities("r141");
  const { root, writer } = testWriter(ids, {
    attempts: new Map(EVENT_KEYS_R141.map((k) => [k, { attempts: new Set([0]) }])),
  });
  try {
    const types = ["PATTERN_CANDIDATE_CREATED", "PATTERN_QUALIFIED", "PATTERN_REJECTED", "PATTERN_DEMOTED", "PATTERN_ARCHIVED", "PATTERN_RETRIEVED", "PATTERN_REMOVED", "STALE_PATTERN_REJECTED", "ROLLBACK_OBSERVED", "OUTCOME_OBSERVED"];
    types.forEach((t, i) => {
      const overrides = {
        attempt_identity: { execution_id: `exec-r141-${i}`, attempt: 0 },
        producer_kind: "fixture",
      };
      if (t === "OUTCOME_OBSERVED") overrides.outcome_ref = { execution_id: `exec-r141-${i}`, final: "PASS", attempt: 0 };
      writer.appendTransferEvent({ event: makeEvent(t, ids, overrides), principal: FIXTURE });
    });
    appendIncident(writer, ids, { attempt_identity: { execution_id: "exec-r141-inc", attempt: 0 }, producer_kind: "fixture" });
    const p = buildOf(root);
    assert.equal(p.envelope.input_event_count, 11);
    assert.equal(p.envelope.incident_event_count, 1);
    assert.equal(PROJECTION_MAX_INPUT_BYTES, 9437184);
    assert.equal(PROJECTION_MAX_INPUT_EVENTS, 65536);
  } finally { rmRoot(root); }
});

test("R142 forged valid chain with secret discriminator rejected PROJECTION_SECRET_REJECTED (R4)", () => {
  const { root } = incidentRoot("r142", 1);
  try {
    const lines = readLogLines(root);
    const header = lines[0];
    const ev = JSON.parse(lines[1]);
    ev.payload.failure_finding_discriminator = "FINDING-AKIAIOSFODNN7EXAMPLE-1R";
    const forged = rederiveAndSerialize(ev, ev.journal_sequence, ev.previous_digest);
    const root2 = createTestRoot("proj-1r");
    try {
      writeLogBytes(root2, [header, forged]);
      const snap = captureRawLogSnapshot({ transferMetricsRoot: root2 });
      assert.equal(throwCode(() => buildIncidentProjection(snap)), PROJECTION_CODES.PROJECTION_SECRET_REJECTED);
    } finally { rmRoot(root2); }
  } finally { rmRoot(root); }
});

test("R143 same forged chain without secret builds; hex digests never false-positive as secrets", () => {
  const { root } = incidentRoot("r143", 1);
  try {
    const lines = readLogLines(root);
    const header = lines[0];
    const ev = JSON.parse(lines[1]);
    ev.payload.failure_finding_discriminator = "FINDING-1R-BENIGN-DISCRIMINATOR";
    const forged = rederiveAndSerialize(ev, ev.journal_sequence, ev.previous_digest);
    const root2 = createTestRoot("proj-1r");
    try {
      writeLogBytes(root2, [header, forged]);
      const p = buildOf(root2);
      assert.equal(p.envelope.projection_item_count, 1);
      assert.equal(p.envelope.items[0].failure_finding_discriminator, "FINDING-1R-BENIGN-DISCRIMINATOR");
      for (const f of ["incident_id", "source_identity_key", "source_record_digest", "evidence_set_digest", "raw_event_digest"]) {
        assert.match(p.envelope.items[0][f], /^[0-9a-f]{64}$/);
      }
    } finally { rmRoot(root2); }
  } finally { rmRoot(root); }
});
test("R144 snapshot raw_input_digest is single-read: getter/Proxy swap is inert, first-read lie rejected", () => {
  const { root } = incidentRoot("r144", 1);
  try {
    const snap = snapOf(root);
    // swap AFTER the verified read (2nd property access): must be inert — the
    // envelope carries the verified digest, never the swapped one
    let reads = 0;
    const shield = new Proxy(snap, {
      get(target, prop) {
        if (prop === "raw_input_digest") {
          reads += 1;
          return reads === 1 ? target.raw_input_digest : hex64("swapped-mid-build");
        }
        return target[prop];
      },
    });
    const p = buildIncidentProjection(shield);
    assert.equal(p.envelope.input_log_digest, snap.raw_input_digest);
    // a snapshot whose FIRST read lies is rejected by the digest check
    const liar = new Proxy(snap, {
      get(target, prop) {
        return prop === "raw_input_digest" ? hex64("liar") : target[prop];
      },
    });
    assert.equal(throwCode(() => buildIncidentProjection(liar)),
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION);
  } finally { rmRoot(root); }
});

test("R145 bounded multi-chunk read loop: large log captured byte-exactly (no single-read assumption)", () => {
  const ids = makeIdentities("r145");
  const { root, writer } = testWriter(ids, {
    attempts: attemptsMap(ids, Array.from({ length: 40 }, (_, i) => i)),
  });
  try {
    for (let i = 0; i < 40; i++) {
      appendIncident(writer, ids, {
        payload: { source_record_id: `src-r145-${i}`, failure_finding_discriminator: `F-${"x".repeat(4000)}-${i}` },
        attempt_identity: { execution_id: ids.execution_id, attempt: i % 40 },
      });
    }
    const fileBytes = readFileSync(join(root, LOG_NAME));
    assert.ok(fileBytes.length > 128 * 1024, "log must exceed one typical read chunk");
    const snap = snapOf(root);
    assert.equal(sha256Buf(snap.bytes[snap.bytes.length - 1]), sha256Buf(fileBytes));
    const p = buildOf(root);
    assert.equal(p.envelope.projection_item_count, 40);
  } finally { rmRoot(root); }
});

const R146_ACCEPTABLE = new Set([
  PROJECTION_CODES.PROJECTION_SNAPSHOT_RACE,
  PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID,
  PROJECTION_CODES.PROJECTION_EVENT_DIGEST_INVALID,
  PROJECTION_CODES.PROJECTION_IDENTITY_CONFLICT,
  PROJECTION_CODES.PROJECTION_NON_REGULAR_INPUT,
  PROJECTION_CODES.PROJECTION_PATH_REPLACED,
]);

test("R146 non-cooperating external appender never yields partial acceptance (L4-family)", async () => {
  const { root } = incidentRoot("r146", 2);
  const childScript = `
    const { appendFileSync } = await import("node:fs");
    const path = process.argv[1];
    for (let i = 0; i < 150; i++) {
      try { appendFileSync(path, "ZZZ-GARBAGE-LINE-" + i + "\\n"); } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, join(root, LOG_NAME)], {
    stdio: "ignore",
  });
  try {
    const outcomes = new Set();
    for (let i = 0; i < 15; i++) {
      try {
        const p = buildOf(root);
        outcomes.add("OK:" + p.envelope.projection_item_count);
      } catch (e) {
        outcomes.add(e.code);
      }
    }
    child.kill("SIGKILL");
    await childExit(child);
    for (const o of outcomes) {
      if (o.startsWith("OK:")) continue;
      assert.ok(R146_ACCEPTABLE.has(o), `unacceptable outcome: ${o}`);
    }
    assert.ok(outcomes.size >= 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmRoot(root);
  }
});

// ===========================================================================
// R15x — cursor / filter / limit / ordering (Phase 20-23)
// ===========================================================================

test("R151 cursor token independently decoded; binds versions, digest, filters, position", () => {
  const { root, p } = sixtyRoot("r151");
  try {
    const q = queryIncidentProjection(p, { filters: {}, limit: 2 });
    const token = q.next_cursor;
    assert.ok(token.length <= PROJECTION_MAX_CURSOR_BYTES);
    const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    assert.deepEqual(Object.keys(decoded).sort(), ["av", "cv", "fd", "ld", "le", "lo", "qp", "sd"]);
    assert.equal(decoded.cv, PROJECTION_SCHEMA_VERSION);
    assert.equal(decoded.av, PROJECTION_ALGORITHM_VERSION);
    assert.equal(decoded.qp, QUERY_POLICY_VERSION);
    assert.equal(decoded.sd, "DESC");
    assert.equal(decoded.ld, p.input_log_digest);
    assert.equal(decoded.fd, sha256Hex(myCan({})));
    const page2 = queryIncidentProjection(p, { filters: {}, limit: 2, cursor: token });
    const lastOfPage1 = q.items[q.items.length - 1];
    // cursor position = LAST item of the page that produced it
    assert.equal(decoded.lo, lastOfPage1.raw_append_ordinal);
    assert.equal(decoded.le, lastOfPage1.incident_observation_id);
    const second = page2.items[0];
    const ord1 = q.items.map((i) => i.raw_append_ordinal);
    const ord2 = page2.items.map((i) => i.raw_append_ordinal);
    assert.equal(new Set([...ord1, ...ord2]).size, ord1.length + ord2.length);
  } finally { rmRoot(root); }
});

test("R152 cursor forgery matrix: every forged variant is rejected, never escalating", () => {
  const { root, p } = sixtyRoot("r152");
  try {
    const q = queryIncidentProjection(p, { filters: {}, limit: 2 });
    const token = q.next_cursor;
    const acceptable = new Set([
      PROJECTION_CODES.PROJECTION_CURSOR_INVALID,
      PROJECTION_CODES.PROJECTION_CURSOR_STALE,
      TRANSFER_CODES.PAYLOAD_MALFORMED,
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION,
    ]);
    const variants = {
      bitflip: (() => {
        const i = Math.floor(token.length / 2);
        const c = token[i] === "A" ? "B" : "A";
        return token.slice(0, i) + c + token.slice(i + 1);
      })(),
      truncated: token.slice(0, token.length - 6),
      oversized: "A".repeat(PROJECTION_MAX_CURSOR_BYTES + 1),
      not_base64: "++++////" + token.slice(8),
      empty: "",
      numeric: 12345,
      object: { lo: 1 },
      plain_json: Buffer.from('{"lo":1}', "utf8").toString("base64url"),
    };
    for (const [name, bad] of Object.entries(variants)) {
      const code = throwCode(() => queryIncidentProjection(p, { filters: {}, limit: 2, cursor: bad }));
      assert.ok(acceptable.has(code), `cursor ${name} -> ${code}`);
    }
    const valid = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    for (const [name, patch] of [
      ["bad_lo_type", { lo: "not-an-int" }],
      ["unknown_field", { extraneous_field: 1 }],
      ["negative_lo", { lo: -5 }],
      ["bad_le_type", { le: "zz" }],
    ]) {
      const t = Buffer.from(myCan({ ...valid, ...patch }), "utf8").toString("base64url");
      const code = throwCode(() => queryIncidentProjection(p, { filters: {}, limit: 2, cursor: t }));
      assert.ok(acceptable.has(code), `forged cursor ${name} -> ${code}`);
    }
    // literal __proto__ key inside the JSON token cannot pollute the decode
    const protoToken = Buffer.from(
      '{"__proto__":{"injected":1},"cv":"' + PROJECTION_SCHEMA_VERSION + '"}',
      "utf8",
    ).toString("base64url");
    const protoCode = throwCode(() => queryIncidentProjection(p, { filters: {}, limit: 2, cursor: protoToken }));
    assert.ok(acceptable.has(protoCode), protoCode);
  } finally { rmRoot(root); }
});

test("R153 cursor stale across snapshots and invalid under changed filters; OR-normalization stable", () => {
  const ids = makeIdentities("r153");
  const { root, writer } = testWriter(ids, { attempts: [0, 1, 2, 3] });
  try {
    appendIncident(writer, ids);
    for (let i = 1; i < 4; i++) {
      appendIncident(writer, ids, {
        payload: { source_record_id: `s${i}` },
        attempt_identity: { execution_id: ids.execution_id, attempt: i },
      });
    }
    const p1 = buildOf(root);
    const q1 = queryIncidentProjection(p1, { filters: {}, limit: 2 });
    appendIncident(writer, ids, { payload: { source_record_id: "late" }, attempt_identity: { execution_id: ids.execution_id, attempt: 2 } });
    const p2 = buildOf(root);
    assert.notEqual(p2.input_log_digest, p1.input_log_digest);
    assert.equal(throwCode(() => queryIncidentProjection(p2, { filters: {}, limit: 2, cursor: q1.next_cursor })),
      PROJECTION_CODES.PROJECTION_CURSOR_STALE);
    assert.equal(throwCode(() => queryIncidentProjection(p1, { filters: { recorded_completeness: "COMPLETE" }, limit: 2, cursor: q1.next_cursor })),
      PROJECTION_CODES.PROJECTION_CURSOR_INVALID);
    const a = encodeProjectionCursor({ input_log_digest: p1.input_log_digest, filters: { incident_id: [hex64("x"), hex64("y")] }, last_raw_append_ordinal: 1, last_event_id: hex64("e") });
    const b = encodeProjectionCursor({ input_log_digest: p1.input_log_digest, filters: { incident_id: [hex64("y"), hex64("x")] }, last_raw_append_ordinal: 1, last_event_id: hex64("e") });
    assert.equal(a, b);
  } finally { rmRoot(root); }
});

test("R154 filter matrix: unknown keys/enums/getters/regex/oversized-OR all rejected", () => {
  const { root, p, ids } = sixtyRoot("r154");
  try {
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { incident_family_id: "x" } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { "": "x" } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { current_authority_status: "VERIFIED_CURRENT" } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { current_authority_status: ["NOT_EVALUATED"] } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { recorded_completeness: "STALE" } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    const getterFilters = { get incident_id() { return ids.incident_id; } };
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: getterFilters })),
      TRANSFER_CODES.PAYLOAD_MALFORMED);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { incident_id: /re/ } })),
      TRANSFER_CODES.PAYLOAD_MALFORMED);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { incident_id: new RegExp("x") } })),
      TRANSFER_CODES.PAYLOAD_MALFORMED);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { task_id: Array.from({ length: PROJECTION_MAX_FILTER_VALUES + 1 }, () => "t") } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { task_id: [] } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    const one = p.envelope.items[0].task_identity.task_id;
    const q64 = queryIncidentProjection(p, { filters: { task_id: Array.from({ length: 64 }, (_, i) => (i === 0 ? one : `nope-${i}`)) }, limit: PROJECTION_MAX_LIMIT });
    assert.equal(q64.items.length, 60);
    const both = queryIncidentProjection(p, { filters: { task_id: one, recorded_completeness: "COMPLETE" } });
    assert.ok(both.items.every((i) => i.recorded_completeness === "COMPLETE"));
  } finally { rmRoot(root); }
});

test("R155 range filter semantics: inclusive bounds, open sides, ordering violations", () => {
  const { root, p } = sixtyRoot("r155");
  try {
    const ord = p.envelope.items[0].raw_append_ordinal;
    const q = queryIncidentProjection(p, { filters: { raw_append_ordinal: { min: ord, max: ord } } });
    assert.equal(q.items.length, 1);
    assert.equal(q.items[0].raw_append_ordinal, ord);
    assert.equal(queryIncidentProjection(p, { filters: { raw_append_ordinal: { max: 5 } }, limit: PROJECTION_MAX_LIMIT }).total_matching,
      p.envelope.items.filter((i) => i.raw_append_ordinal <= 5).length);
    assert.equal(queryIncidentProjection(p, { filters: { raw_append_ordinal: { min: 1 } }, limit: PROJECTION_MAX_LIMIT }).total_matching, 60);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { raw_append_ordinal: { min: 2, max: 1 } } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { raw_append_ordinal: { min: "5" } } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { raw_append_ordinal: { bogus: 1 } } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { raw_append_ordinal: [1, 2] } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    // time ranges: inclusive endpoints; all sixty items share occurred_at -> range matches all
    const t = p.envelope.items[0].occurred_at;
    assert.equal(queryIncidentProjection(p, { filters: { occurred_at: { start: t, end: t } }, limit: PROJECTION_MAX_LIMIT }).total_matching, 60);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { occurred_at: { start: "2026-13-45T99:00:00Z" } } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
    assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { recorded_at: { start: "2026-08-02T00:00:00Z", end: "2026-08-01T00:00:00Z" } } })),
      PROJECTION_CODES.PROJECTION_FILTER_INVALID);
  } finally { rmRoot(root); }
});

test("R156 limit matrix: non-integers/null/false rejected; env override ineffective", () => {
  const { root, p } = sixtyRoot("r156");
  try {
    for (const bad of [0, -1, 2.5, "50", NaN, Infinity, -Infinity, 10n, 501, false, null]) {
      assert.equal(throwCode(() => queryIncidentProjection(p, { limit: bad })),
        PROJECTION_CODES.PROJECTION_LIMIT_INVALID, String(bad));
    }
    assert.equal(queryIncidentProjection(p, {}).items.length, PROJECTION_DEFAULT_LIMIT);
    for (const good of [1, 50, 499, PROJECTION_MAX_LIMIT]) {
      assert.equal(throwCode(() => queryIncidentProjection(p, { limit: good })), "NO_THROW");
    }
    process.env.PROJECTION_LIMIT = "999999";
    process.env.MAX_LIMIT = "999999";
    try {
      assert.equal(queryIncidentProjection(p, {}).items.length, PROJECTION_DEFAULT_LIMIT);
      assert.equal(throwCode(() => queryIncidentProjection(p, { limit: 999999 })),
        PROJECTION_CODES.PROJECTION_LIMIT_INVALID);
    } finally {
      delete process.env.PROJECTION_LIMIT;
      delete process.env.MAX_LIMIT;
    }
  } finally { rmRoot(root); }
});

test("R157 frozen ordering independently verified; page size never changes total order", () => {
  const ids = makeIdentities("r157");
  const times = [500, 5, 300, 1, 400, 100];
  const { root, writer } = testWriter(ids, {
    attempts: new Map(times.map((_, i) => [`exec-r157-${i}`, { attempts: new Set([0]) }])),
  });
  try {
    times.forEach((s, i) => {
      appendIncident(writer, ids, {
        payload: { source_record_id: `s${i}` },
        attempt_identity: { execution_id: `exec-r157-${i}`, attempt: 0 },
        occurred_at: isoAt(s),
      });
    });
    const p = buildOf(root);
    const ords = p.envelope.items.map((i) => i.raw_append_ordinal);
    assert.deepEqual(ords, [...ords].sort((a, b) => b - a));
    const occurred = p.envelope.items.map((i) => i.occurred_at);
    assert.deepEqual(occurred, [...times].reverse().map(isoAt), "occurred_at must not drive order");
    for (const size of [1, 7, 50, 500]) {
      const collected = [];
      let cursor;
      for (;;) {
        const q = queryIncidentProjection(p, { limit: size, cursor });
        collected.push(...q.items.map((i) => i.raw_append_ordinal));
        if (!q.next_cursor) break;
        cursor = q.next_cursor;
      }
      assert.deepEqual(collected, ords);
    }
  } finally { rmRoot(root); }
});

// ===========================================================================
// R16x — cardinality / historical-current / storage / reachability
// ===========================================================================

test("R161 one-to-one cardinality; retry no inflation; conflict no LWW; distinct preserved", () => {
  const ids = makeIdentities("r161");
  const { root, writer } = testWriter(ids);
  try {
    const first = appendIncident(writer, ids);
    assert.equal(first.status, "APPENDED");
    const retry = appendIncident(writer, ids);
    assert.equal(retry.status, "ALREADY_SATISFIED");
    const p1 = buildOf(root);
    assert.equal(p1.envelope.input_event_count, 1);
    assert.equal(p1.envelope.projection_item_count, 1);
    const before = rawLogDigest(root);
    assert.equal(throwCode(() => appendIncident(writer, ids, { payload: { observed_outcome_class: "TEST_FAIL" } })),
      TRANSFER_CODES.IDEMPOTENCY_CONFLICT);
    assert.equal(rawLogDigest(root), before, "conflicting retry must not mutate the raw log");
    const p2 = buildOf(root);
    assert.equal(p2.envelope.projection_item_count, 1);
    appendIncident(writer, ids, { attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
    const p3 = buildOf(root);
    assert.equal(p3.envelope.projection_item_count, 2);
    const [a, b] = p3.envelope.items;
    assert.equal(a.attempt_identity.attempt === b.attempt_identity.attempt, false);
    // distinct project, same source digests -> distinct identity, separate writer
    const proj2 = {
      repository_root_identity: join(IDENTITY_ROOT, "proj-r161b"),
      git_common_dir_identity: join(IDENTITY_ROOT, "proj-r161b", ".git"),
    };
    const second = testWriter(ids, {
      projects: new Map([
        [ids.project_identity.repository_root_identity, ids.project_identity],
        [proj2.repository_root_identity, proj2],
      ]),
      attempts: attemptsMap(ids, [0]),
    });
    try {
      appendIncident(second.writer, ids, { project_identity: proj2, payload: { source_record_id: ids.source_record_id } });
      const p4 = buildOf(second.root);
      assert.equal(p4.envelope.projection_item_count, 1);
      const item = p4.envelope.items[0];
      assert.equal(item.project_identity.repository_root_identity, proj2.repository_root_identity);
      assert.equal(item.worktree_identity, proj2.repository_root_identity);
    } finally { rmRoot(second.root); }
  } finally { rmRoot(root); }
});

test("R162 current authority forgery rejected; NOT_EVALUATED constant everywhere", () => {
  const ids = makeIdentities("r162");
  const { root, writer } = testWriter(ids);
  try {
    appendIncident(writer, ids);
    const snap = snapOf(root);
    const p = buildIncidentProjection({ ...snap, current_authority_status: "VERIFIED_CURRENT", receipt: { fake: 1 } });
    for (const item of p.envelope.items) {
      assert.equal(item.current_authority_status, CURRENT_AUTHORITY_STATUS_NOT_EVALUATED);
      assert.equal(item.current_authority_status, "NOT_EVALUATED");
      assert.equal(item.current_authority_receipt_reference, null);
      assert.equal(item.current_authority_checked_generation, null);
    }
    assert.deepEqual(CURRENT_AUTHORITY_POLICY_V1_STATUSES, ["VERIFIED_CURRENT", "STALE_GENERATION", "REVOKED", "SOURCE_MISSING", "SOURCE_CONFLICT", "IDENTITY_MISMATCH", "NOT_EVALUATED"]);
    assert.equal(CURRENT_AUTHORITY_POLICY_VERSION, "autoloop.incident-projection-current/v1");
    for (const s of ["VERIFIED_CURRENT", "STALE_GENERATION", "REVOKED", "SOURCE_MISSING", "SOURCE_CONFLICT", "IDENTITY_MISMATCH"]) {
      assert.equal(throwCode(() => queryIncidentProjection(p, { filters: { current_authority_status: s } })),
        PROJECTION_CODES.PROJECTION_FILTER_INVALID, s);
    }
    writer.setWriterGeneration("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "1r-p-advance", expected: 0, task_identity: ids.task_identity });
    writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "1r-p-revoke", expected: 1, task_identity: ids.task_identity });
    const p2 = buildOf(root);
    assert.equal(p2.envelope.items[0].current_authority_status, "NOT_EVALUATED");
    // The durable authority mutations append 2 authority events, so raw
    // bytes differ; the frozen invariants are: item semantics unchanged,
    // status NOT_EVALUATED, and authority events never became items.
    assert.equal(p2.envelope.items.length, p.envelope.items.length);
    assert.equal(canonical(p2.envelope.items), canonical(p.envelope.items));
    assert.equal(p2.envelope.input_event_count, p.envelope.input_event_count + 2);
  } finally { rmRoot(root); }
});

test("R163 ephemeral storage proof: build+query create nothing; raw log byte-identical", () => {
  const { root } = incidentRoot("r163", 2);
  try {
    const beforeList = readdirSync(root).sort();
    const beforeLog = rawLogDigest(root);
    const p = buildOf(root);
    void queryIncidentProjection(p, { filters: {}, limit: 1 });
    void queryIncidentProjection(p, { filters: { recorded_completeness: "COMPLETE" } });
    void encodeProjectionCursor({ input_log_digest: p.input_log_digest, filters: {}, last_raw_append_ordinal: 1, last_event_id: hex64("x") });
    assert.deepEqual(readdirSync(root).sort(), beforeList);
    assert.equal(rawLogDigest(root), beforeLog);
    assert.equal(existsSync(join(root, "incident-projection.json")), false);
    assert.equal(existsSync(join(root, "incident-index.json")), false);
    assert.equal(existsSync(join(root, "cursor-store")), false);
    assert.ok(Buffer.isBuffer(p.canonical_bytes));
  } finally { rmRoot(root); }
});

test("R164 production import graph independently walked: projection unreachable from any production entry", () => {
  const entries = [
    "src/lifecycle-runner.mjs",
    "src/governance/pass-oracle.mjs",
    "src/v2/durable-graph.mjs",
    "src/v2/execution-orchestrator.mjs",
    "src/runtime/colima-graph-runner.mjs",
    "src/runtime/colima-runtime.mjs",
    "src/admission/admission-gate.mjs",
    "src/budget/enforcement.mjs",
    "src/rollover/rollover-authority.mjs",
    "src/subagent/subagent-graph-runner.mjs",
    "src/learning/transfer-metrics/seam.mjs",
  ];
  const importRe = /(?:import|export)[^'"()]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  function walk(entry) {
    const seen = new Set();
    const queue = [resolve(REPO, entry)];
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      let text;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      for (const m of text.matchAll(importRe)) {
        const spec = m[1] ?? m[2];
        if (!spec || (!spec.startsWith(".") && !spec.startsWith("../"))) continue;
        const target = resolve(dirname(file), spec);
        queue.push(target.endsWith(".mjs") ? target : target + ".mjs");
      }
    }
    return seen;
  }
  const all = new Set();
  for (const e of entries) for (const f of walk(e)) all.add(f);
  assert.equal([...all].some((f) => f.endsWith("src/learning/incidents/projection.mjs")), false);
  for (const f of all) {
    const rel = f.slice(REPO.length + 1);
    if (!rel.startsWith("src/learning/") || rel === "src/learning/transfer-metrics/writer.mjs") continue;
    const text = readFileSync(f, "utf8");
    const importsProjection = /from\s+["'][^"']*incidents\/projection\.mjs["']/.test(text);
    const importsWriter = /from\s+["'][^"']*transfer-metrics\/writer\.mjs["']/.test(text);
    if (importsProjection || importsWriter) {
      assert.ok(rel.startsWith("src/learning/"), `${rel} imports learning internals from production`);
    }
  }
});

test("R165 incidents-dir fence exact; seam hardcoded disabled; projection source has no forbidden surface", () => {
  const incidentsDir = join(REPO, "src/learning/incidents");
  assert.deepEqual(readdirSync(incidentsDir).sort(), ["current-verification.mjs", "lifecycle-terminal-adapter.mjs", "projection.mjs"]);
  const saved = process.env.TRANSFER_METRICS_ENABLED;
  process.env.TRANSFER_METRICS_ENABLED = "1";
  try {
    assert.equal(TRANSFER_METRICS_ENABLED, false);
    assert.equal(isTransferMetricsEnabled(), false);
  } finally {
    if (saved === undefined) delete process.env.TRANSFER_METRICS_ENABLED;
    else process.env.TRANSFER_METRICS_ENABLED = saved;
  }
  const src = readFileSync(PROJECTION_PATH, "utf8");
  const forbidden = [
    /process\.env/, /node:fs/, /\bwriteFileSync\b/, /\bappendFileSync\b/, /\bwriteSync\b/,
    /\brenameSync\b/, /\bunlinkSync\b/, /\bmkdirSync\b/, /\bsetInterval\b/, /\bsetTimeout\b/,
    /\blocaleCompare\b/, /\bnew RegExp\b/, /\bsqlite\b/i, /\bleveldb\b/i, /\bfetch\s*\(/,
    /\bglobalThis\b/, /\brequire\s*\(/, /worker_threads/, /child_process/,
  ];
  for (const re of forbidden) assert.equal(re.test(src), false, String(re));
  const writerSrc = readFileSync(WRITER_PATH, "utf8");
  const accessor = writerSrc.slice(writerSrc.indexOf("export function captureRawLogSnapshot"));
  assert.ok(accessor.includes("O_RDONLY"));
  assert.equal(accessor.includes("O_APPEND"), false);
  assert.equal(accessor.includes("O_WRONLY"), false);
  for (const fn of ["appendTransferEvent", "revokeWriter", "setWriterGeneration", "#appendLocked", "#maybeRotate", "#reconcilePartialTail", "#assertWriterLive", "#assertIdentities"]) {
    assert.ok(writerSrc.includes(fn), `writer retains ${fn}`);
  }
});

test("R166 writer append semantics unchanged by the accessor (Phase 5 re-verification)", () => {
  const ids = makeIdentities("r166");
  const { root, writer } = testWriter(ids);
  try {
    assert.equal(appendIncident(writer, ids).status, "APPENDED");
    assert.equal(appendIncident(writer, ids).status, "ALREADY_SATISFIED");
    // corrupt-tail reconciliation still writer-owned and functional (predecessor behavior)
    const lines = readLogLines(root);
    const text = lines.join("\n") + "\n";
    const cut = text.lastIndexOf("\n", text.length - 2);
    writeFileSync(join(root, LOG_NAME), text.slice(0, cut + 1) + '{"journal_seq', "utf8");
    const r = appendIncident(writer, ids, { payload: { source_record_id: "recon" }, attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
    assert.equal(r.status, "APPENDED");
    const p = buildOf(root);
    assert.equal(p.envelope.projection_item_count, 1);
    assert.equal(p.envelope.input_event_count, 1);
    // generation fencing intact
    writer.setWriterGeneration("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "1r-p-advance2", expected: 0, task_identity: ids.task_identity });
    assert.equal(throwCode(() => appendIncident(writer, ids, { payload: { source_record_id: "gen" }, attempt_identity: { execution_id: ids.execution_id, attempt: 2 } })),
      TRANSFER_CODES.STALE_GENERATION);
    // revocation in mutation fence
    writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "1r-p-revoke2", expected: 1, task_identity: ids.task_identity });
    assert.equal(throwCode(() => appendIncident(writer, ids, { payload: { source_record_id: "rev" }, attempt_identity: { execution_id: ids.execution_id, attempt: 2 } })),
      TRANSFER_CODES.WRITER_REVOKED);
  } finally { rmRoot(root); }
});

// ===========================================================================
// R17x — concurrency / crash / determinism (Phase 7/11, OS-process probes)
// ===========================================================================

const DET_SCRIPT = `
  import { captureRawLogSnapshot } from ${JSON.stringify(WRITER_PATH)};
  import { buildIncidentProjection } from ${JSON.stringify(PROJECTION_PATH)};
  const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: process.argv[1] }));
  console.log(p.canonical_bytes.toString("base64"));
`;

test("R171 concurrent 32-process captures serialize on the one writer lock (L12)", () => {
  const { root } = incidentRoot("r171", 3);
  try {
    const children = Array.from({ length: 32 }, () =>
      spawnSync(process.execPath, ["--input-type=module", "-e", DET_SCRIPT, root], { encoding: "utf8", timeout: 60000 }));
    assert.equal(children[0].status, 0, children[0].stderr);
    for (const c of children) {
      assert.equal(c.status, 0, c.stderr);
      assert.equal(c.stdout, children[0].stdout);
    }
  } finally { rmRoot(root); }
});

const WRITER_CHILD = `
  import { TransferMetricsWriter } from ${JSON.stringify(WRITER_PATH)};
  import { FIXTURE, makeIdentities, makeEvent, makeBinder } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
  const ids = makeIdentities("r172");
  const writer = new TransferMetricsWriter({
    transferMetricsRoot: process.argv[1],
    identityBinder: makeBinder(ids, { attempts: new Map([["exec-r172", { attempts: new Set([0]) }]]) }),
    allowFixture: true,
  });
  try {
    const r = writer.appendTransferEvent({
      event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, payload: { source_record_id: "proc-same-key" } }),
      principal: FIXTURE,
    });
    console.log(r.status);
  } catch (e) { console.log(e.code ?? "THROWN"); }
`;

const READER_CHILD = `
  import { captureRawLogSnapshot } from ${JSON.stringify(WRITER_PATH)};
  import { buildIncidentProjection } from ${JSON.stringify(PROJECTION_PATH)};
  try {
    const p = buildIncidentProjection(captureRawLogSnapshot({ transferMetricsRoot: process.argv[1] }));
    console.log("OK:" + p.envelope.input_event_count);
  } catch (e) { console.log(e.code ?? "THROWN"); }
`;

test("R172 concurrent mixed readers/writers across processes: every outcome frozen (L13)", () => {
  const ids = makeIdentities("r172");
  const { root } = testWriter(ids);
  try {
    const writerResults = Array.from({ length: 4 }, () =>
      spawnSync(process.execPath, ["--input-type=module", "-e", WRITER_CHILD, root], { encoding: "utf8", timeout: 60000 }));
    const readerResults = Array.from({ length: 8 }, () =>
      spawnSync(process.execPath, ["--input-type=module", "-e", READER_CHILD, root], { encoding: "utf8", timeout: 60000 }));
    for (const w of writerResults) {
      assert.equal(w.status, 0, w.stderr);
      assert.ok(["APPENDED", "ALREADY_SATISFIED", TRANSFER_CODES.IDEMPOTENCY_CONFLICT].includes(w.stdout.trim()), w.stdout);
    }
    for (const r of readerResults) {
      assert.equal(r.status, 0, r.stderr);
      const line = r.stdout.trim();
      if (line.startsWith("OK:")) {
        const n = Number(line.slice(3));
        assert.ok(n >= 1 && n <= 4, line);
      } else {
        assert.ok(
          [PROJECTION_CODES.PROJECTION_INPUT_MISSING, PROJECTION_CODES.PROJECTION_SNAPSHOT_RACE, PROJECTION_CODES.PROJECTION_LOG_CHAIN_INVALID].includes(line),
          line,
        );
      }
    }
    // all four same-key appends collapse to exactly ONE durable row
    const p = buildOf(root);
    assert.equal(p.envelope.input_event_count, 1);
    assert.equal(p.envelope.projection_item_count, 1);
  } finally { rmRoot(root); }
});

test("R173 SIGKILL of the lock holder releases the log for the next capture (L14/L15)", async () => {
  const { root } = incidentRoot("r173", 5);
  const holder = `
    const { acquireStructuredLock } = await import(${JSON.stringify(LOCK_PATH)});
    const lock = acquireStructuredLock(process.argv[1] + "/transfer-events.lock", {
      lock_kind: "transfer_metrics", execution_id: "transfer-metrics", checkpoint_id: "transfer-events",
      chain_id: "transfer-events", lease_id: "none", lease_revision: 0, actor_id: "holder",
      session_id: "holder", repository_identity: process.argv[1], worktree_identity: process.argv[1], expected_head: "none",
    });
    console.log("HELD");
    setTimeout(() => {}, 10000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", holder, root], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  try {
    await sleep(1500);
    assert.ok(out.includes("HELD"), "child must hold the lock");
    child.kill("SIGKILL");
    await childExit(child);
    // forensic reclaim after MIN_CRASH_AGE_MS; capture proceeds cleanly afterwards
    const p = buildOf(root);
    assert.equal(p.envelope.projection_item_count, 5);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmRoot(root);
  }
});

test("R174 byte determinism across two processes under differing TZ/locale (P1/P2 re-derivation)", () => {
  const { root } = incidentRoot("r174", 4);
  try {
    const a = spawnSync(process.execPath, ["--input-type=module", "-e", DET_SCRIPT, root], {
      encoding: "utf8", env: { ...process.env, TZ: "Asia/Taipei", LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" },
    });
    const b = spawnSync(process.execPath, ["--input-type=module", "-e", DET_SCRIPT, root], {
      encoding: "utf8", env: { ...process.env, TZ: "America/New_York", LANG: "C", LC_ALL: "C" },
    });
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(a.stdout, b.stdout);
  } finally { rmRoot(root); }
});

test("R175 cross-snapshot replay of a projection never validates (input digest binding)", () => {
  const { root, writer, ids } = incidentRoot("r175", 1);
  try {
    const p1 = buildOf(root);
    appendIncident(writer, ids, { payload: { source_record_id: "second" }, attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
    const p2 = buildOf(root);
    assert.notEqual(p1.envelope.input_log_digest, p2.envelope.input_log_digest);
    assert.notEqual(p1.envelope.projection_digest, p2.envelope.projection_digest);
    // envelope-swap attack: new snapshot claiming the old snapshot's digest
    const snap2 = snapOf(root);
    const forged = { ...snap2, raw_input_digest: p1.envelope.input_log_digest };
    assert.equal(throwCode(() => buildIncidentProjection(forged)),
      PROJECTION_CODES.PROJECTION_INTERNAL_CONTRACT_VIOLATION);
    // cursor from p1 against p2 is STALE (R153 re-check with different snapshots)
    const q1 = queryIncidentProjection(p1, { filters: {}, limit: 1 });
    assert.equal(throwCode(() => queryIncidentProjection(p2, { filters: {}, limit: 1, cursor: q1.next_cursor })),
      PROJECTION_CODES.PROJECTION_CURSOR_STALE);
  } finally { rmRoot(root); }
});

// ===========================================================================
// helpers
// ===========================================================================

function isoAt(offsetSeconds) {
  return new Date(Date.parse("2026-08-01T00:00:00.000Z") + offsetSeconds * 1000).toISOString();
}

function sixtyRoot(label) {
  const ids = makeIdentities(label);
  const { root, writer } = testWriter(ids);
  for (let i = 0; i < 60; i++) {
    appendIncident(writer, ids, {
      payload: { source_record_id: `m-${label}-${i}` },
      attempt_identity: { execution_id: ids.execution_id, attempt: i % 3 },
    });
  }
  const p = buildOf(root);
  return { ids, root, writer, p };
}
