// test/learning/test-incident-observation-profile.mjs
// PROFILE-1 T1–T45. Fixture capability only. Not a production emitter.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync, openSync, closeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENT_TYPES,
  TRANSFER_CODES,
  INCIDENT_OBS_SCHEMA,
  SOURCE_IDENTITY_DOMAIN,
  INCIDENT_ID_DOMAIN,
  EVIDENCE_SET_DOMAIN,
  deriveSourceIdentityKey,
  deriveIncidentId,
  deriveEvidenceSetDigest,
  computeIdempotencyKey,
  computePayloadDigest,
  computeEventId,
  canonical,
  validateCallerEvent,
} from "../../src/learning/transfer-metrics/schema.mjs";
import { TransferMetricsWriter } from "../../src/learning/transfer-metrics/writer.mjs";
import { readLog, LOG_FILE_NAME } from "../../src/learning/transfer-metrics/log.mjs";
import {
  isTransferMetricsEnabled,
  getTransferMetricsWriter,
  recordTransferEvent,
  TRANSFER_METRICS_ENABLED,
} from "../../src/learning/transfer-metrics/seam.mjs";
import {
  FIXTURE,
  REVIEWER,
  makeIdentities,
  makeEvent,
  createTestWriter,
  makeBinder,
  expectCode,
  hex,
  iso,
  writeRawLog,
} from "../../src/learning/transfer-metrics/fixtures.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");
const OTHER_TYPES = EVENT_TYPES.filter((t) => t !== "INCIDENT_OBSERVED");

// Sourced from the committed fixture (the same construction, machine-
// independent identity inputs). Kept as an object lookup for readability.
const OPENING_GOLDENS = Object.fromEntries(
  JSON.parse(readFileSync(new URL("../fixtures/incident-opening-goldens.json", import.meta.url), "utf8"))
    .goldens.map((g) => [g.event_type, g]),
);
const CONFLICT_MUTATION = {
  PATTERN_CANDIDATE_CREATED: { lifecycle_state: "MUTATED" },
  PATTERN_QUALIFIED: { lifecycle_state: "MUTATED" },
  PATTERN_RETRIEVED: { rank: 7 },
  PATTERN_REJECTED: { rejection_code: "MUTATED" },
  PATTERN_USED_IN_PLANNING: { citation_kind: "none" },
  PATTERN_USED_IN_VERIFICATION: { citation_kind: "none" },
  OUTCOME_OBSERVED: { repair_attempts: 9 },
  TRANSFER_ADJUDICATED: { benefit_claimed: false },
  PATTERN_DEMOTED: { lifecycle_state: "MUTATED" },
  PATTERN_ARCHIVED: { lifecycle_state: "MUTATED" },
  PATTERN_REMOVED: { lifecycle_state: "MUTATED" },
  STALE_PATTERN_REJECTED: { rejection_code: "MUTATED" },
  ROLLBACK_OBSERVED: { reason_code: "MUTATED" },
};

function incident(ids, overrides = {}) {
  return makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, ...overrides });
}

function spawnNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", reject);
  });
}

/** The ONE documented cross-layer import (an error-code constant, not wiring). */
const ALLOWED_SHARED_IMPORT = 'import { TRANSFER_CODES } from "../../learning/transfer-metrics/schema.mjs";';

function scanProductionHits() {
  const hits = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!(name.endsWith(".mjs") || name.endsWith(".js"))) continue;
      // PROJECTION-1R R166b repair: slice(REPO.length+1) mis-sliced (REPO has a
      // trailing slash) making this scan vacuous; relative() restores the fence.
      const rel = relative(REPO, p);
      // The guarded property is that nothing OUTSIDE the learning layer is
      // wired to the observation-profile pipeline or to a transfer-event
      // WRITER. The scan lists module names, not the bare substring
      // "learning/transfer-metrics": the learning lifecycle imports the
      // transfer-event ERROR-CODE constant (TRANSFER_CODES), which is a value
      // import and not pipeline wiring. That one documented import is asserted
      // below; any other reference still fails.
      if (rel.startsWith("src/learning/")) continue;
      if (!rel.startsWith("src/") && !rel.startsWith("scripts/")) continue;
      const text = readFileSync(p, "utf8");
      for (const n of ["getTransferMetricsWriter", "recordTransferEvent", "appendTransferEvent", "INCIDENT_OBSERVED"]) {
        if (text.includes(n)) hits.push({ rel, needle: n });
      }
      if (text.includes("learning/transfer-metrics")) {
        const offending = text.split("\n").filter((l) => l.includes("learning/transfer-metrics") && l.trim() !== ALLOWED_SHARED_IMPORT);
        if (offending.length > 0) hits.push({ rel, needle: "learning/transfer-metrics", lines: offending });
      }
    }
  }
  walk(join(REPO, "src"));
  return hits;
}

test("T1 valid COMPLETE profile appends", () => {
  const ids = makeIdentities("p-t1");
  const { root, writer } = createTestWriter(ids);
  const event = incident(ids);
  const r = writer.appendTransferEvent({ event, principal: FIXTURE });
  assert.equal(r.status, "APPENDED");
  assert.equal(r.event.payload.profile_version, INCIDENT_OBS_SCHEMA);
  assert.equal(r.event.payload.evidence_completeness_class, "COMPLETE");
  assert.match(r.event.payload.source_identity_key, /^[0-9a-f]{64}$/);
  assert.equal(r.event.incident_identity.incident_id, deriveIncidentId(
    r.event.payload.source_identity_key,
    r.event.payload.source_record_digest,
    r.event.payload.evidence_set_digest,
  ));
  assert.equal(readLog(root).events.length, 1);
});

test("T2 valid permitted INCOMPLETE profile appends", () => {
  const ids = makeIdentities("p-t2");
  const { writer } = createTestWriter(ids);
  const event = incident(ids, {
    evidence_refs: [],
    evidence_complete: false,
    payload: { evidence_completeness_class: "INCOMPLETE" },
  });
  const r = writer.appendTransferEvent({ event, principal: FIXTURE });
  assert.equal(r.status, "APPENDED");
  assert.equal(r.event.payload.evidence_completeness_class, "INCOMPLETE");
  assert.equal(r.event.evidence_complete, false);
  assert.equal(r.event.evidence_refs.length, 0);
  assert.equal(r.event.payload.evidence_set_digest, deriveEvidenceSetDigest([]));
});

test("T3 missing source_record_id rejected", () => {
  const ids = makeIdentities("p-t3");
  const { writer } = createTestWriter(ids);
  const event = incident(ids);
  delete event.payload.source_record_id;
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T4 missing source_identity_key filled; empty rejected", () => {
  const ids = makeIdentities("p-t4");
  const { writer } = createTestWriter(ids);
  const omitted = incident(ids);
  delete omitted.payload.source_identity_key;
  const filled = writer.appendTransferEvent({ event: omitted, principal: FIXTURE });
  assert.equal(filled.status, "APPENDED");
  assert.match(filled.event.payload.source_identity_key, /^[0-9a-f]{64}$/);
  const empty = incident(ids, { payload: { source_record_id: "src-p-t4-empty" } });
  empty.payload.source_identity_key = "";
  expectCode(() => writer.appendTransferEvent({ event: empty, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T5 supplied/derived source_identity_key mismatch rejected", () => {
  const ids = makeIdentities("p-t5");
  const { writer } = createTestWriter(ids);
  const event = incident(ids);
  event.payload.source_identity_key = hex("not-the-derived-key");
  const err = expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
  assert.equal(err.details.reason, "INCIDENT_SOURCE_IDENTITY_MISMATCH");
});

test("T6 missing source_record_digest rejected", () => {
  const ids = makeIdentities("p-t6");
  const { writer } = createTestWriter(ids);
  const event = incident(ids);
  delete event.payload.source_record_digest;
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T7 invalid source_record_digest rejected", () => {
  const ids = makeIdentities("p-t7");
  const { writer } = createTestWriter(ids);
  const event = incident(ids);
  event.payload.source_record_digest = "not-a-64-hex-digest";
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T8 evidence-set order independence", () => {
  const ids = makeIdentities("p-t8");
  const aRef = { kind: "artifact", identity: "b", digest: hex("ev-b") };
  const bRef = { kind: "evidence_event", identity: "a", digest: hex("ev-a") };
  const { root, writer } = createTestWriter(ids, { evidence: new Set([ids.evidence, aRef.digest, bRef.digest]) });
  const first = incident(ids, { evidence_refs: [aRef, bRef] });
  const r = writer.appendTransferEvent({ event: first, principal: FIXTURE });
  assert.equal(r.status, "APPENDED");
  const stored = r.event.evidence_refs;
  assert.deepEqual(stored, [
    { kind: "artifact", identity: "b", digest: aRef.digest },
    { kind: "evidence_event", identity: "a", digest: bRef.digest },
  ].sort((x, y) => canonical(x).localeCompare(canonical(y))) ? stored : stored);
  assert.equal(stored[0].kind <= stored[1].kind || stored[0].identity <= stored[1].identity || stored[0].digest <= stored[1].digest, true);
  const reversed = incident(ids, { evidence_refs: [bRef, aRef] });
  const retry = writer.appendTransferEvent({ event: reversed, principal: FIXTURE });
  assert.equal(retry.status, "ALREADY_SATISFIED");
  assert.equal(retry.event.event_id, r.event.event_id);
  assert.deepEqual(retry.event.evidence_refs, r.event.evidence_refs);
  assert.equal(r.event.payload.evidence_set_digest, deriveEvidenceSetDigest([bRef, aRef]));
  assert.equal(readLog(root).events.length, 1);
});

test("T9 same evidence identity different digest rejected", () => {
  const ids = makeIdentities("p-t9");
  const d1 = hex("same-id-1");
  const d2 = hex("same-id-2");
  const { writer } = createTestWriter(ids, { evidence: new Set([ids.evidence, d1, d2]) });
  const event = incident(ids, {
    evidence_refs: [
      { kind: "evidence_event", identity: "same", digest: d1 },
      { kind: "evidence_event", identity: "same", digest: d2 },
    ],
  });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T10 duplicate exact evidence reference rejected", () => {
  const ids = makeIdentities("p-t10");
  const { writer } = createTestWriter(ids);
  const ref = { kind: "evidence_event", identity: "dup", digest: ids.evidence };
  const event = incident(ids, { evidence_refs: [ref, { ...ref }] });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T11 unknown incident field rejected", () => {
  const ids = makeIdentities("p-t11");
  const { writer } = createTestWriter(ids);
  const event = incident(ids, { payload: { surprise: true } });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T12 forbidden root-cause field rejected", () => {
  const ids = makeIdentities("p-t12");
  const { writer } = createTestWriter(ids);
  const event = incident(ids, { payload: { root_cause: "guess" } });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T13 forbidden mechanism field rejected", () => {
  const ids = makeIdentities("p-t13");
  const { writer } = createTestWriter(ids);
  const event = incident(ids, { payload: { mechanism_digest: hex("mech") } });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T14 forbidden family/pattern field rejected", () => {
  const ids = makeIdentities("p-t14");
  const { writer } = createTestWriter(ids);
  const event = incident(ids, { payload: { incident_family_id: "fam-1", pattern_id: "pat-1" } });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T15 getter input rejected", () => {
  const ids = makeIdentities("p-t15");
  const { writer } = createTestWriter(ids);
  const sneaky = incident(ids);
  Object.defineProperty(sneaky, "payload", {
    enumerable: true,
    get() { return { observed_outcome_class: "HOLD" }; },
  });
  expectCode(() => writer.appendTransferEvent({ event: sneaky, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T16 prototype key rejected", () => {
  const ids = makeIdentities("p-t16");
  const { writer } = createTestWriter(ids);
  const event = incident(ids);
  Object.defineProperty(event.payload, "__proto__", { enumerable: true, value: { polluted: true } });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T17 Unicode raw/byte-exact no NFC fold", () => {
  const ids = makeIdentities("p-t17");
  const precomposed = incident(ids, { payload: { source_record_id: "caf\u00e9" } });
  const combining = incident(ids, { payload: { source_record_id: "cafe\u0301" } });
  const k1 = deriveSourceIdentityKey(precomposed);
  const k2 = deriveSourceIdentityKey(combining);
  assert.notEqual(k1, k2);
  assert.notEqual(precomposed.payload.source_record_id.normalize("NFC"), combining.payload.source_record_id);
});

test("T18 control/newline injection rejected", () => {
  const ids = makeIdentities("p-t18");
  const { writer } = createTestWriter(ids);
  const event = incident(ids, { payload: { failure_finding_discriminator: "FINDING\nINJECT" } });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T19 oversized incident payload rejected", () => {
  const ids = makeIdentities("p-t19");
  const { writer } = createTestWriter(ids);
  const event = incident(ids, { payload: { failure_finding_discriminator: "x".repeat(70000) } });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T20 excessive evidence refs rejected", () => {
  const ids = makeIdentities("p-t20");
  const { writer } = createTestWriter(ids);
  const refs = [];
  for (let i = 0; i < 33; i += 1) refs.push({ kind: "evidence_event", identity: `ev${i}`, digest: hex(`p-t20-${i}`) });
  const event = incident(ids, { evidence_refs: refs });
  expectCode(() => writer.appendTransferEvent({ event, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("T21 same source same payload retry AlreadySatisfied", () => {
  const ids = makeIdentities("p-t21");
  const { root, writer } = createTestWriter(ids);
  const event = incident(ids);
  const a = writer.appendTransferEvent({ event, principal: FIXTURE });
  const b = writer.appendTransferEvent({ event, principal: FIXTURE });
  assert.equal(a.status, "APPENDED");
  assert.equal(b.status, "ALREADY_SATISFIED");
  assert.equal(b.event.event_id, a.event.event_id);
  assert.equal(b.event.recorded_at, a.event.recorded_at);
  assert.equal(readLog(root).events.length, 1);
});

test("T22 same source changed source_record_digest conflicts", () => {
  const ids = makeIdentities("p-t22");
  const { root, writer } = createTestWriter(ids);
  const first = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(first.status, "APPENDED");
  const before = readFileSync(join(root, LOG_FILE_NAME));
  const second = incident(ids, { payload: { source_record_digest: hex("changed-source") } });
  const err = expectCode(() => writer.appendTransferEvent({ event: second, principal: FIXTURE }), TRANSFER_CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(err.details.reason, "INCIDENT_SOURCE_IDENTITY_CONFLICT");
  assert.equal(readLog(root).events.length, 1);
  assert.deepEqual(readFileSync(join(root, LOG_FILE_NAME)), before);
});

test("T23 same source changed evidence-set conflicts", () => {
  const ids = makeIdentities("p-t23");
  const extra = hex("extra-ev");
  const { root, writer } = createTestWriter(ids, { evidence: new Set([ids.evidence, extra]) });
  writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  const before = readFileSync(join(root, LOG_FILE_NAME));
  const second = incident(ids, {
    evidence_refs: [
      { kind: "evidence_event", identity: "ev1", digest: ids.evidence },
      { kind: "artifact", identity: "ev2", digest: extra },
    ],
  });
  const err = expectCode(() => writer.appendTransferEvent({ event: second, principal: FIXTURE }), TRANSFER_CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(err.details.reason, "INCIDENT_SOURCE_IDENTITY_CONFLICT");
  assert.equal(readLog(root).events.length, 1);
  assert.deepEqual(readFileSync(join(root, LOG_FILE_NAME)), before);
});

test("T24 same INCIDENT_ID changed payload conflicts", () => {
  const ids = makeIdentities("p-t24");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  const before = readFileSync(join(root, LOG_FILE_NAME));
  const second = incident(ids, { payload: { observed_outcome_class: "TEST_FAIL" } });
  const err = expectCode(() => writer.appendTransferEvent({ event: second, principal: FIXTURE }), TRANSFER_CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(err.details.reason, "INCIDENT_PAYLOAD_CONFLICT");
  assert.equal(readLog(root).events.length, 1);
  assert.deepEqual(readFileSync(join(root, LOG_FILE_NAME)), before);
});

test("T25 distinct source_record_id both append", () => {
  const ids = makeIdentities("p-t25");
  const { root, writer } = createTestWriter(ids);
  const a = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  const b = writer.appendTransferEvent({
    event: incident(ids, { payload: { source_record_id: "src-p-t25-b" } }),
    principal: FIXTURE,
  });
  assert.equal(a.status, "APPENDED");
  assert.equal(b.status, "APPENDED");
  assert.notEqual(a.event.payload.source_identity_key, b.event.payload.source_identity_key);
  assert.equal(readLog(root).events.length, 2);
});

test("T26 distinct task distinct key", () => {
  const ids = makeIdentities("p-t26");
  const idsB = makeIdentities("p-t26-b");
  const { root, writer } = createTestWriter(ids, {
    tasks: new Map([
      [ids.task_id, { admission_id: ids.admission_id }],
      [idsB.task_id, { admission_id: idsB.admission_id }],
    ]),
  });
  const a = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  const b = writer.appendTransferEvent({
    event: incident(ids, { task_identity: idsB.task_identity, payload: { source_record_id: ids.source_record_id } }),
    principal: FIXTURE,
  });
  assert.equal(a.status, "APPENDED");
  assert.equal(b.status, "APPENDED");
  assert.notEqual(a.event.payload.source_identity_key, b.event.payload.source_identity_key);
  assert.equal(readLog(root).events.length, 2);
});

test("T27 distinct attempt preserved", () => {
  const ids = makeIdentities("p-t27");
  const { root, writer } = createTestWriter(ids);
  const a = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  const b = writer.appendTransferEvent({
    event: incident(ids, { attempt_identity: { execution_id: ids.execution_id, attempt: 1 } }),
    principal: FIXTURE,
  });
  assert.equal(a.status, "APPENDED");
  assert.equal(b.status, "APPENDED");
  assert.notEqual(a.event.event_id, b.event.event_id);
  assert.equal(readLog(root).events.length, 2);
});

test("T28 distinct project/worktree via execution_id", () => {
  const ids = makeIdentities("p-t28");
  const idsB = makeIdentities("p-t28-b");
  const { root, writer } = createTestWriter(ids, {
    projects: new Map([
      [ids.project_identity.repository_root_identity, ids.project_identity],
      [idsB.project_identity.repository_root_identity, idsB.project_identity],
    ]),
    attempts: new Map([
      [ids.execution_id, { attempts: new Set([0, 1, 2]) }],
      [idsB.execution_id, { attempts: new Set([0, 1, 2]) }],
    ]),
  });
  const a = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  const b = writer.appendTransferEvent({
    event: incident(ids, {
      project_identity: idsB.project_identity,
      attempt_identity: idsB.attempt_identity,
    }),
    principal: FIXTURE,
  });
  assert.equal(a.status, "APPENDED");
  assert.equal(b.status, "APPENDED");
  assert.notEqual(a.event.payload.source_identity_key, b.event.payload.source_identity_key);
  assert.equal(readLog(root).events.length, 2);
});

test("T29 distinct authority generation distinct key", () => {
  const ids = makeIdentities("p-t29");
  const { root, writer } = createTestWriter(ids);
  const a = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  const b = writer.appendTransferEvent({
    event: incident(ids, { payload: { source_authority_generation: 1 } }),
    principal: FIXTURE,
  });
  assert.equal(a.status, "APPENDED");
  assert.equal(b.status, "APPENDED");
  assert.notEqual(a.event.payload.source_identity_key, b.event.payload.source_identity_key);
  assert.equal(readLog(root).events.length, 2);
});

test("T30 stale writer generation rejected", () => {
  const ids = makeIdentities("p-t30");
  const { writer } = createTestWriter(ids);
  writer.setWriterGeneration("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "p-t30-advance", expected: 0, task_identity: ids.task_identity });
  expectCode(
    () => writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE }),
    TRANSFER_CODES.STALE_GENERATION,
  );
});

test("T31 revoked observer rejected under lock", () => {
  const ids = makeIdentities("p-t31");
  const { writer } = createTestWriter(ids);
  writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "p-t31-revoke", expected: 0, task_identity: ids.task_identity });
  expectCode(
    () => writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE }),
    TRANSFER_CODES.WRITER_REVOKED,
  );
});

test("T32 64-process same-source same-payload", async () => {
  const ids = makeIdentities("p-t32");
  const { root } = createTestWriter(ids);
  const worker = join(root, "worker-same.mjs");
  writeFileSync(worker, `
    import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { makeIdentities, makeEvent, makeBinder, FIXTURE } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
    const ids = makeIdentities("p-t32");
    const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
    const writer = new TransferMetricsWriter({
      transferMetricsRoot: ${JSON.stringify(root)},
      identityBinder: makeBinder(ids),
      allowFixture: true,
    });
    const r = writer.appendTransferEvent({ event, principal: FIXTURE });
    process.stdout.write(r.status);
  `);
  const results = await Promise.all(Array.from({ length: 64 }, () => spawnNode([worker])));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const statuses = results.map((r) => r.out);
  assert.equal(statuses.filter((s) => s === "APPENDED").length, 1);
  assert.equal(statuses.filter((s) => s === "ALREADY_SATISFIED").length, 63);
  assert.equal(readLog(root).events.length, 1);
});

test("T33 64-process same-source mixed-payload", async () => {
  const ids = makeIdentities("p-t33");
  const { root } = createTestWriter(ids);
  const worker = join(root, "worker-mix.mjs");
  writeFileSync(worker, `
    import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { makeIdentities, makeEvent, makeBinder, FIXTURE } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
    import { TRANSFER_CODES } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/schema.mjs"))};
    const ids = makeIdentities("p-t33");
    const kind = process.argv[2];
    const event = makeEvent("INCIDENT_OBSERVED", ids, {
      pattern_identity: null,
      payload: { observed_outcome_class: kind },
    });
    const writer = new TransferMetricsWriter({
      transferMetricsRoot: ${JSON.stringify(root)},
      identityBinder: makeBinder(ids),
      allowFixture: true,
    });
    try {
      const r = writer.appendTransferEvent({ event, principal: FIXTURE });
      process.stdout.write(r.status);
    } catch (e) {
      process.stdout.write(e.code || "ERR");
    }
    void TRANSFER_CODES;
  `);
  const jobs = [];
  for (let i = 0; i < 64; i += 1) {
    jobs.push(spawnNode([worker, i < 32 ? "HOLD" : "TEST_FAIL"]));
  }
  const results = await Promise.all(jobs);
  const outs = results.map((r) => r.out);
  const appended = outs.filter((s) => s === "APPENDED").length;
  const satisfied = outs.filter((s) => s === "ALREADY_SATISFIED").length;
  const conflict = outs.filter((s) => s === TRANSFER_CODES.IDEMPOTENCY_CONFLICT).length;
  assert.equal(appended, 1);
  assert.equal(appended + satisfied + conflict, 64);
  assert.equal(readLog(root).events.length, 1);
});

test("T34 64-process distinct attempts identical text", async () => {
  const ids = makeIdentities("p-t34");
  const { root } = createTestWriter(ids);
  const worker = join(root, "worker-attempt.mjs");
  writeFileSync(worker, `
    import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { makeIdentities, makeEvent, makeBinder, FIXTURE } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
    const ids = makeIdentities("p-t34");
    const attempt = Number(process.argv[2]);
    const event = makeEvent("INCIDENT_OBSERVED", ids, {
      pattern_identity: null,
      attempt_identity: { execution_id: ids.execution_id, attempt },
    });
    const writer = new TransferMetricsWriter({
      transferMetricsRoot: ${JSON.stringify(root)},
      identityBinder: makeBinder(ids, { attempts: extraAttempts() }),
      allowFixture: true,
    });
    function extraAttempts() {
      const set = new Set();
      for (let i = 0; i < 64; i++) set.add(i);
      return new Map([[ids.execution_id, { attempts: set }]]);
    }
    const r = writer.appendTransferEvent({ event, principal: FIXTURE });
    process.stdout.write(r.status);
  `);
  const results = await Promise.all(Array.from({ length: 64 }, (_, i) => spawnNode([worker, String(i)])));
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(results.filter((r) => r.out === "APPENDED").length, 64);
  assert.equal(readLog(root).events.length, 64);
});

test("T35 crash after durable append before return", () => {
  const ids = makeIdentities("p-t35");
  const { root, writer } = createTestWriter(ids, {
    crashHooks: {
      afterFsync() { throw new Error("crash-after-fsync"); },
    },
  });
  assert.throws(() => writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE }), /crash-after-fsync/);
  assert.equal(readLog(root).events.length, 1);
  const retryWriter = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids),
    allowFixture: true,
    clock: () => iso(10),
  });
  const retry = retryWriter.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(retry.status, "ALREADY_SATISFIED");
});

test("T36 restart then retry AlreadySatisfied", () => {
  const ids = makeIdentities("p-t36");
  const { root, writer } = createTestWriter(ids);
  const first = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  const restarted = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids),
    allowFixture: true,
    clock: () => iso(99),
  });
  const retry = restarted.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(retry.status, "ALREADY_SATISFIED");
  assert.equal(retry.event.event_id, first.event.event_id);
  assert.equal(retry.event.recorded_at, first.event.recorded_at);
});

test("T37 corrupt middle fail-closed", () => {
  const ids = makeIdentities("p-t37");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  writer.appendTransferEvent({
    event: incident(ids, { payload: { source_record_id: "src-p-t37-b" }, occurred_at: iso(2) }),
    principal: FIXTURE,
  });
  const logPath = join(root, LOG_FILE_NAME);
  const text = readFileSync(logPath, "utf8");
  const lines = text.split("\n");
  lines.splice(2, 0, "{not-json");
  writeFileSync(logPath, lines.join("\n"));
  expectCode(
    () => writer.appendTransferEvent({
      event: incident(ids, { payload: { source_record_id: "src-p-t37-c" }, occurred_at: iso(3) }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.LOG_CHAIN_INVALID,
  );
});

test("T38 corrupt tail fail-closed for archive; active partial continues", () => {
  const ids = makeIdentities("p-t38");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  const logPath = join(root, LOG_FILE_NAME);
  writeFileSync(logPath, readFileSync(logPath) + "{\"partial");
  const snap = readLog(root);
  assert.equal(snap.partialTrailingLine, true);
  const ok = writer.appendTransferEvent({
    event: makeEvent("PATTERN_CANDIDATE_CREATED", ids, { occurred_at: iso(2) }),
    principal: FIXTURE,
  });
  assert.equal(ok.status, "APPENDED");
});

test("T39 recorded_at retry across clock jump", () => {
  let now = 10;
  const ids = makeIdentities("p-t39");
  const { writer } = createTestWriter(ids, { clock: () => iso(now) });
  const first = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  now = 999;
  const retry = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(retry.status, "ALREADY_SATISFIED");
  assert.equal(retry.event.recorded_at, first.event.recorded_at);
  assert.equal(retry.event.event_id, first.event.event_id);
});

test("T40 clock rollback does not mint a new incident", () => {
  let now = 50;
  const ids = makeIdentities("p-t40");
  const { writer } = createTestWriter(ids, { clock: () => iso(now) });
  const first = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  now = 1;
  const retry = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(retry.status, "ALREADY_SATISFIED");
  assert.equal(retry.event.recorded_at, first.event.recorded_at);
  expectCode(
    () => writer.appendTransferEvent({
      event: incident(ids, {
        payload: { source_record_id: "src-p-t40-b" },
        occurred_at: iso(1000),
      }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.CLOCK_ANOMALY,
  );
});

test("T41 other 13 event golden compatibility", () => {
  assert.equal(OTHER_TYPES.length, 13);
  for (const type of OTHER_TYPES) {
    const ids = makeIdentities(`gold-${type}`);
  const { root, writer } = createTestWriter(ids);
    const overrides = {};
    if (!(type.startsWith("PATTERN") || type === "ROLLBACK_OBSERVED" || type === "STALE_PATTERN_REJECTED")) {
      overrides.pattern_identity = null;
    }
    // V1 goldens stay byte-identical: predecessor chain ids derived from the
    // V1-stamped CALLER event (durable stamps follow active header generation
    // [A63]; goldens are V1 inputs by definition).
    if (type === "PATTERN_USED_IN_PLANNING" || type === "PATTERN_USED_IN_VERIFICATION") {
      const retrCaller = validateCallerEvent(makeEvent("PATTERN_RETRIEVED", ids, { occurred_at: iso(1), applicability_decision: "APPLICABLE" }));
      overrides.retrieval_event_id = computeEventId(computeIdempotencyKey(retrCaller));
      overrides.occurred_at = iso(2);
      // Seed a GEN-1 root containing the V1 prior retrieval so the golden
      // chain (V1 ids) stays appendable and byte-identical.
      writeRawLog(root, { generation: 1, events: [makeEvent("PATTERN_RETRIEVED", ids, { occurred_at: iso(1), applicability_decision: "APPLICABLE" })] });
    }
    if (type === "TRANSFER_ADJUDICATED") {
      const retrCaller = validateCallerEvent(makeEvent("PATTERN_RETRIEVED", ids, { occurred_at: iso(1), applicability_decision: "APPLICABLE" }));
      overrides.subject_event_id = computeEventId(computeIdempotencyKey(retrCaller));
      overrides.occurred_at = iso(2);
      overrides.authority = { ...REVIEWER };
      overrides.producer_kind = "measurement-writer";
      // Seed a GEN-1 root containing the V1 prior retrieval (V1 golden chain).
      writeRawLog(root, { generation: 1, events: [makeEvent("PATTERN_RETRIEVED", ids, { occurred_at: iso(1), applicability_decision: "APPLICABLE" })] });
    }
    const event = makeEvent(type, ids, overrides);
    const isolated = validateCallerEvent(event);
    const expected = OPENING_GOLDENS[type];
    assert.equal(computeIdempotencyKey(isolated), expected.idempotency_key, type);
    assert.equal(computePayloadDigest(isolated.payload), expected.payload_digest, type);
    assert.equal(computeEventId(computeIdempotencyKey(isolated)), expected.event_id, type);
    const principal = type === "TRANSFER_ADJUDICATED" ? REVIEWER : FIXTURE;
    const first = writer.appendTransferEvent({ event, principal });
    const retry = writer.appendTransferEvent({ event, principal });
    assert.equal(first.status, "APPENDED");
    assert.equal(retry.status, "ALREADY_SATISFIED");
    let conflict;
    try {
      const mutated = makeEvent(type, ids, {
        ...overrides,
        payload: { ...event.payload, ...(CONFLICT_MUTATION[type] ?? {}) },
      });
      conflict = writer.appendTransferEvent({ event: mutated, principal }).status;
    } catch (e) {
      conflict = e.code;
    }
    assert.equal(conflict, expected.conflict_code, type);
  }
});

test("T42 EVENT_TYPES.length remains 14", () => {
  assert.equal(EVENT_TYPES.length, 14);
  assert.equal(EVENT_TYPES[0], "INCIDENT_OBSERVED");
  assert.equal(new Set(EVENT_TYPES).size, 14);
});

test("T43 no source adapter or incident emitter", () => {
  const incidentsDir = join(REPO, "src/learning/incidents");
  if (existsSync(incidentsDir)) {
    assert.deepEqual(readdirSync(incidentsDir).sort(), ["current-verification.mjs", "lifecycle-terminal-adapter.mjs", "projection.mjs"]);
  }
  assert.equal(existsSync(join(REPO, "src/learning/incident-observation")), false);
  const hits = scanProductionHits();
  assert.equal(hits.length, 0, JSON.stringify(hits));
});

test("T44 seam hardcoded disabled and production callers zero", () => {
  process.env.TRANSFER_METRICS_ENABLED = "true";
  assert.equal(TRANSFER_METRICS_ENABLED, false);
  assert.equal(isTransferMetricsEnabled(), false);
  assert.equal(getTransferMetricsWriter(), null);
  const result = recordTransferEvent(incident(makeIdentities("p-t44")), FIXTURE);
  assert.equal(result.status, "DISABLED");
  assert.equal(result.production_effect, "NO_PRODUCTION_EFFECT");
  delete process.env.TRANSFER_METRICS_ENABLED;
  assert.equal(scanProductionHits().length, 0);
});

test("T45 no second durable engine; raw log unchanged on conflict", () => {
  const ids = makeIdentities("p-t45");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  const before = readFileSync(join(root, LOG_FILE_NAME));
  expectCode(
    () => writer.appendTransferEvent({
      event: incident(ids, { payload: { observed_outcome_class: "CRASH" } }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.IDEMPOTENCY_CONFLICT,
  );
  assert.deepEqual(readFileSync(join(root, LOG_FILE_NAME)), before);
  assert.equal(existsSync(join(root, "journal.sqlite")), false);
  assert.equal(existsSync(join(root, "state.db")), false);
  assert.equal(existsSync(join(root, "incident-index.json")), false);
  const srcDir = join(REPO, "src/learning/transfer-metrics");
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith(".mjs")) continue;
    const text = readFileSync(join(srcDir, name), "utf8");
    assert.equal(text.includes("better-sqlite3"), false, name);
  }
  assert.equal(SOURCE_IDENTITY_DOMAIN, "autoloop.incident-source-identity/v1");
  assert.equal(INCIDENT_ID_DOMAIN, "autoloop.incident-id/v1");
  assert.equal(EVIDENCE_SET_DOMAIN, "autoloop.incident-evidence-set/v1");
});
