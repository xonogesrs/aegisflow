// test/learning/test-incident-observation-profile-1r.mjs
// Independent PROFILE-1R reviewer probes. Does not use production
// deriveSourceIdentityKey / deriveIncidentId as the oracle implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSha256, compareCodePoints, recursiveCanonicalJson } from "../../src/memory/canonical.mjs";
import {
  EVENT_TYPES,
  TRANSFER_CODES,
  INCIDENT_OBS_SCHEMA,
  SOURCE_IDENTITY_DOMAIN,
  INCIDENT_ID_DOMAIN,
  EVIDENCE_SET_DOMAIN,
  INCIDENT_OBSERVED_REQUIRED_PAYLOAD_KEYS,
  INCIDENT_OBSERVED_OPTIONAL_PAYLOAD_KEYS,
  deriveSourceIdentityKey,
  deriveIncidentId,
  deriveEvidenceSetDigest,
  computeIdempotencyKey,
  computePayloadDigest,
  computeEventId,
  computeEventDigest,
  GENESIS_DIGEST,
  validateCallerEvent,
} from "../../src/learning/transfer-metrics/schema.mjs";
import { TransferMetricsWriter } from "../../src/learning/transfer-metrics/writer.mjs";
import { readLog, LOG_FILE_NAME } from "../../src/learning/transfer-metrics/log.mjs";
import { reduceTransferMetrics } from "../../src/learning/transfer-metrics/reducer.mjs";
import { FORMULA_VERSION } from "../../src/learning/transfer-metrics/schema.mjs";
import {
  FIXTURE,
  REVIEWER,
  makeIdentities,
  makeEvent,
  createTestWriter,
  expectCode,
  hex,
  iso,
  makeBinder,
  WINDOW,
} from "../../src/learning/transfer-metrics/fixtures.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const OPENING_GOLDENS_PATH = "/Volumes/NVM2T/Development/evidence/autoloop/STAGE-E-INCIDENT-OBSERVATION-PROFILE-1-20260827T110106Z/goldens/other-13-opening.json";

function digestOf(value) {
  return canonicalSha256(value);
}

function oracleSourceKey(event) {
  return digestOf({
    domain: "autoloop.incident-source-identity/v1",
    schema_version: "autoloop.incident-observation/v1",
    source_class: event.payload.source_class,
    source_authority_identity: event.payload.source_authority_identity,
    source_authority_generation: event.payload.source_authority_generation,
    project_identity: event.project_identity,
    task_identity: event.task_identity,
    attempt_identity: event.attempt_identity,
    source_record_id: event.payload.source_record_id,
    failure_finding_discriminator: event.payload.failure_finding_discriminator,
  });
}

function oracleSortRefs(refs) {
  return refs
    .map((ref) => ({ kind: ref.kind, identity: ref.identity, digest: ref.digest }))
    .sort((a, b) => {
      const k = compareCodePoints(a.kind, b.kind);
      if (k !== 0) return k;
      const i = compareCodePoints(a.identity, b.identity);
      if (i !== 0) return i;
      return compareCodePoints(a.digest, b.digest);
    });
}

function oracleEvidenceSetDigest(refs) {
  return digestOf({
    domain: "autoloop.incident-evidence-set/v1",
    schema_version: "autoloop.incident-observation/v1",
    refs: oracleSortRefs(refs ?? []),
  });
}

function oracleIncidentId(sourceKey, sourceRecordDigest, evidenceSetDigest) {
  return digestOf({
    domain: "autoloop.incident-id/v1",
    schema_version: "autoloop.incident-observation/v1",
    source_identity_key: sourceKey,
    source_record_digest: sourceRecordDigest,
    evidence_set_digest: evidenceSetDigest,
  });
}

function oracleIncidentIdempotencyKey(event, sourceKey) {
  return digestOf({
    schema_version: event.schema_version,
    event_type: event.event_type,
    project_identity: event.project_identity,
    task_identity: event.task_identity,
    attempt_identity: event.attempt_identity,
    incident_identity: null,
    pattern_identity: null,
    retrieval_event_id: null,
    producer_kind: event.producer_kind,
    logical_dedupe_key: sourceKey,
  });
}

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

function scanSrcScripts(needles) {
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
      const rel = relative(REPO, p);
      if (rel.startsWith("src/learning/transfer-metrics/") || rel.startsWith("src/learning/incidents/") || rel.startsWith("test/")) continue;
      const text = readFileSync(p, "utf8");
      for (const n of needles) {
        if (text.includes(n)) hits.push({ rel, needle: n });
      }
    }
  }
  walk(join(REPO, "src"));
  if (existsSync(join(REPO, "scripts"))) walk(join(REPO, "scripts"));
  return hits;
}

test("1R profile field set is flat required+optional with no nested incident object", () => {
  const required = [...INCIDENT_OBSERVED_REQUIRED_PAYLOAD_KEYS];
  const optional = [...INCIDENT_OBSERVED_OPTIONAL_PAYLOAD_KEYS];
  assert.deepEqual(required, [
    "profile_version", "source_class", "source_record_id", "source_authority_identity",
    "source_authority_generation", "failure_finding_discriminator", "source_record_digest",
    "evidence_set_digest", "evidence_completeness_class", "source_identity_key",
    "observed_outcome_class",
  ]);
  assert.deepEqual(optional, [
    "source_linkage", "excluded_from_product_defect", "repaired", "source_error_code", "source_invariant_id",
  ]);
  assert.equal(EVENT_TYPES.length, 14);
  assert.equal(EVENT_TYPES[0], "INCIDENT_OBSERVED");
});

test("1R independent source-identity oracle S1-S15", () => {
  const ids = makeIdentities("1r-s");
  const base = incident(ids);
  const s1 = oracleSourceKey(base);
  assert.equal(s1, deriveSourceIdentityKey(base));
  assert.match(s1, /^[0-9a-f]{64}$/);
  const preimage = recursiveCanonicalJson({
    domain: "autoloop.incident-source-identity/v1",
    schema_version: "autoloop.incident-observation/v1",
    source_class: base.payload.source_class,
    source_authority_identity: base.payload.source_authority_identity,
    source_authority_generation: base.payload.source_authority_generation,
    project_identity: base.project_identity,
    task_identity: base.task_identity,
    attempt_identity: base.attempt_identity,
    source_record_id: base.payload.source_record_id,
    failure_finding_discriminator: base.payload.failure_finding_discriminator,
  });
  assert.equal(preimage.includes(base.payload.source_record_digest), false);
  assert.equal(preimage.includes(base.evidence_refs[0].digest), false);
  assert.equal(preimage.includes("recorded_at"), false);
  assert.equal(SOURCE_IDENTITY_DOMAIN, "autoloop.incident-source-identity/v1");

  const s2 = incident(ids, { payload: { source_record_digest: hex("other-src") } });
  const s3 = incident(ids, { evidence_refs: [{ kind: "evidence_event", identity: "ev1", digest: hex("other-ev") }] });
  const s4 = incident(ids);
  s4.incident_identity = { incident_id: hex("forged-iid"), incident_id_kind: "evidence_bound" };
  const s5 = incident(ids, { occurred_at: iso(99) });
  assert.equal(oracleSourceKey(s2), s1);
  assert.equal(oracleSourceKey(s3), s1);
  assert.equal(oracleSourceKey(s4), s1);
  assert.equal(oracleSourceKey(s5), s1);

  const s6 = incident(ids, { payload: { source_record_id: "src-other" } });
  const s7 = incident(ids, { attempt_identity: { execution_id: ids.execution_id, attempt: 1 } });
  const s8 = incident(ids, { task_identity: { task_id: "task-other", admission_id: ids.admission_id } });
  const s9 = incident(ids, { project_identity: { repository_root_identity: hex("proj-b"), git_common_dir_identity: hex("git-b") } });
  const s11 = incident(ids, { payload: { source_authority_generation: 7 } });
  const s12 = incident(ids, { payload: { source_class: "VERIFIER_FAILURE" } });
  const s13 = incident(ids, { payload: { failure_finding_discriminator: "OTHER-DISC" } });
  for (const ev of [s6, s7, s8, s9, s11, s12, s13]) {
    assert.notEqual(oracleSourceKey(ev), s1);
    assert.equal(oracleSourceKey(ev), deriveSourceIdentityKey(ev));
  }

  const s10a = incident(ids);
  const s10b = incident(ids, { attempt_identity: { execution_id: "exec-other-worktree", attempt: 0 } });
  assert.notEqual(oracleSourceKey(s10a), oracleSourceKey(s10b));

  const cafe = incident(ids, { payload: { source_record_id: "caf\u00e9" } });
  const combining = incident(ids, { payload: { source_record_id: "cafe\u0301" } });
  assert.notEqual(oracleSourceKey(cafe), oracleSourceKey(combining));

  const perm = incident(ids);
  const reorderedPayload = {
    observed_outcome_class: perm.payload.observed_outcome_class,
    source_record_id: perm.payload.source_record_id,
    source_class: perm.payload.source_class,
    failure_finding_discriminator: perm.payload.failure_finding_discriminator,
    source_authority_generation: perm.payload.source_authority_generation,
    source_authority_identity: perm.payload.source_authority_identity,
    source_record_digest: perm.payload.source_record_digest,
    evidence_completeness_class: perm.payload.evidence_completeness_class,
    profile_version: perm.payload.profile_version,
  };
  perm.payload = { ...reorderedPayload };
  assert.equal(oracleSourceKey(perm), s1);
});

test("1R independent incident-id and evidence-set oracle I1-I15", () => {
  const ids = makeIdentities("1r-i");
  const aRef = { kind: "artifact", identity: "b", digest: hex("ev-b") };
  const bRef = { kind: "evidence_event", identity: "a", digest: hex("ev-a") };
  const first = incident(ids, { evidence_refs: [aRef, bRef] });
  const key = oracleSourceKey(first);
  const es = oracleEvidenceSetDigest(first.evidence_refs);
  const iid = oracleIncidentId(key, first.payload.source_record_digest, es);
  assert.equal(es, deriveEvidenceSetDigest(first.evidence_refs));
  assert.equal(iid, deriveIncidentId(key, first.payload.source_record_digest, es));
  const reversed = incident(ids, { evidence_refs: [bRef, aRef] });
  assert.equal(oracleEvidenceSetDigest(reversed.evidence_refs), es);
  assert.equal(oracleIncidentId(oracleSourceKey(reversed), reversed.payload.source_record_digest, oracleEvidenceSetDigest(reversed.evidence_refs)), iid);

  const i3 = incident(ids, { evidence_refs: [aRef, bRef], payload: { source_record_digest: hex("src-changed") } });
  assert.notEqual(oracleIncidentId(oracleSourceKey(i3), i3.payload.source_record_digest, oracleEvidenceSetDigest(i3.evidence_refs)), iid);

  const i4 = incident(ids, { evidence_refs: [aRef, { ...bRef, digest: hex("ev-a-changed") }] });
  assert.notEqual(oracleEvidenceSetDigest(i4.evidence_refs), es);

  const extra = { kind: "evidence_manifest", identity: "c", digest: hex("ev-c") };
  const i5 = incident(ids, { evidence_refs: [aRef, bRef, extra] });
  assert.notEqual(oracleEvidenceSetDigest(i5.evidence_refs), es);

  const i6 = incident(ids, { evidence_refs: [aRef] });
  assert.notEqual(oracleEvidenceSetDigest(i6.evidence_refs), es);

  const i9 = incident(ids, { evidence_refs: [aRef, bRef], payload: { failure_finding_discriminator: "CHANGED" } });
  assert.notEqual(oracleSourceKey(i9), key);
  assert.notEqual(oracleIncidentId(oracleSourceKey(i9), i9.payload.source_record_digest, oracleEvidenceSetDigest(i9.evidence_refs)), iid);

  const i11 = incident(ids, { evidence_refs: [aRef, bRef], occurred_at: iso(50) });
  assert.equal(oracleIncidentId(oracleSourceKey(i11), i11.payload.source_record_digest, oracleEvidenceSetDigest(i11.evidence_refs)), iid);

  const i12 = incident(ids, { evidence_refs: [aRef, bRef], payload: { observed_outcome_class: "CRASH" } });
  assert.equal(oracleIncidentId(oracleSourceKey(i12), i12.payload.source_record_digest, oracleEvidenceSetDigest(i12.evidence_refs)), iid);

  const { writer } = createTestWriter(ids);
  expectCode(() => writer.appendTransferEvent({
    event: incident(ids, { evidence_refs: [bRef, bRef] }),
    principal: FIXTURE,
  }), TRANSFER_CODES.PAYLOAD_MALFORMED);
  expectCode(() => writer.appendTransferEvent({
    event: incident(ids, { evidence_refs: [bRef, { ...bRef, digest: hex("other") }] }),
    principal: FIXTURE,
  }), TRANSFER_CODES.PAYLOAD_MALFORMED);
});

test("1R idempotency key excludes incident id and digests", () => {
  const ids = makeIdentities("1r-k");
  const event = incident(ids);
  const key = oracleSourceKey(event);
  const idem = oracleIncidentIdempotencyKey(event, key);
  const isolated = validateCallerEvent(event);
  assert.equal(idem, computeIdempotencyKey(isolated));
  const canon = recursiveCanonicalJson({
    schema_version: event.schema_version,
    event_type: event.event_type,
    project_identity: event.project_identity,
    task_identity: event.task_identity,
    attempt_identity: event.attempt_identity,
    incident_identity: null,
    pattern_identity: null,
    retrieval_event_id: null,
    producer_kind: event.producer_kind,
    logical_dedupe_key: key,
  });
  assert.equal(canon.includes(event.incident_identity.incident_id), false);
  assert.equal(canon.includes(event.payload.source_record_digest), false);
  assert.equal(canon.includes("recorded_at"), false);
  const other = makeEvent("PATTERN_CANDIDATE_CREATED", ids);
  assert.notEqual(computeIdempotencyKey(validateCallerEvent(other)), idem);
});

test("1R G1-G12 writer conflict matrix", () => {
  const ids = makeIdentities("1r-g");
  const extra = hex("extra-g3");
  const { root, writer } = createTestWriter(ids, { evidence: new Set([ids.evidence, extra, hex("g12")]) });

  const g1 = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  const g1retry = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(g1.status, "APPENDED");
  assert.equal(g1retry.status, "ALREADY_SATISFIED");
  assert.equal(g1retry.event.event_id, g1.event.event_id);
  assert.equal(g1retry.event.recorded_at, g1.event.recorded_at);
  const before = readFileSync(join(root, LOG_FILE_NAME));

  const g2 = incident(ids, { payload: { source_record_digest: hex("g2-src") } });
  const g2err = expectCode(() => writer.appendTransferEvent({ event: g2, principal: FIXTURE }), TRANSFER_CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(g2err.details.reason, "INCIDENT_SOURCE_IDENTITY_CONFLICT");
  assert.deepEqual(readFileSync(join(root, LOG_FILE_NAME)), before);

  const g3 = incident(ids, {
    evidence_refs: [
      { kind: "evidence_event", identity: "ev1", digest: ids.evidence },
      { kind: "artifact", identity: "ev2", digest: extra },
    ],
  });
  const g3err = expectCode(() => writer.appendTransferEvent({ event: g3, principal: FIXTURE }), TRANSFER_CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(g3err.details.reason, "INCIDENT_SOURCE_IDENTITY_CONFLICT");
  assert.equal(readLog(root).events.length, 1);
  assert.equal(JSON.parse(readFileSync(join(root, LOG_FILE_NAME), "utf8").trim().split("\n").pop()).evidence_refs.length, 1);

  const g4 = writer.appendTransferEvent({
    event: incident(ids, { attempt_identity: { execution_id: ids.execution_id, attempt: 1 } }),
    principal: FIXTURE,
  });
  assert.equal(g4.status, "APPENDED");

  const g5err = expectCode(() => writer.appendTransferEvent({
    event: incident(ids, { payload: { observed_outcome_class: "TEST_FAIL" } }),
    principal: FIXTURE,
  }), TRANSFER_CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(g5err.details.reason, "INCIDENT_PAYLOAD_CONFLICT");

  const g6 = writer.appendTransferEvent({
    event: incident(ids, { payload: { failure_finding_discriminator: "OTHER-DISC", source_record_id: "src-g6" } }),
    principal: FIXTURE,
  });
  assert.equal(g6.status, "APPENDED");
  assert.notEqual(g6.event.payload.source_identity_key, g1.event.payload.source_identity_key);

  const forgedKey = incident(ids, { payload: { failure_finding_discriminator: "FORGED-DISC" } });
  forgedKey.payload.source_identity_key = g1.event.payload.source_identity_key;
  expectCode(() => writer.appendTransferEvent({ event: forgedKey, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);

  const g8 = incident(ids, {
    evidence_refs: [
      { kind: "evidence_event", identity: "ev1", digest: ids.evidence },
    ].reverse(),
  });
  const g8retry = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(g8retry.status, "ALREADY_SATISFIED");
  void g8;

  const g11 = incident(ids, { payload: { source_record_id: "src-g11" } });
  g11.incident_identity = { incident_id: "not-a-digest", incident_id_kind: "evidence_bound" };
  expectCode(() => writer.appendTransferEvent({ event: g11, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);

  const g12ids = makeIdentities("1r-g12");
  const { writer: w12, root: r12 } = createTestWriter(g12ids, {
    evidence: new Set([ids.evidence, g12ids.evidence]),
  });
  w12.appendTransferEvent({ event: incident(g12ids), principal: FIXTURE });
  const g12b = incident(g12ids, {
    payload: { source_record_id: "other-source" },
    evidence_refs: [{ kind: "evidence_event", identity: "ev1", digest: ids.evidence }],
  });
  const g12r = w12.appendTransferEvent({ event: g12b, principal: FIXTURE });
  assert.equal(g12r.status, "APPENDED");
  assert.equal(readLog(r12).events.length, 2);
});

test("1R recorded_at Option B writer-owned across clock jump rollback and caller stamp", () => {
  let now = 10;
  const ids = makeIdentities("1r-clock");
  const { writer, root } = createTestWriter(ids, { clock: () => iso(now) });
  const stamped = incident(ids);
  stamped.recorded_at = iso(0);
  const first = writer.appendTransferEvent({ event: stamped, principal: FIXTURE });
  assert.equal(first.status, "APPENDED");
  assert.equal(first.event.recorded_at, iso(10));
  now = 10 + 86400;
  const jump = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(jump.status, "ALREADY_SATISFIED");
  assert.equal(jump.event.recorded_at, first.event.recorded_at);
  now = 10 - 86400;
  const rollback = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(rollback.status, "ALREADY_SATISFIED");
  assert.equal(rollback.event.recorded_at, first.event.recorded_at);
  const restarted = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids),
    allowFixture: true,
    clock: () => iso(99999),
    revocationRegistry: { revokedWriterIds: new Set(), currentGenerations: new Map([["w1", 0]]) },
  });
  const afterRestart = restarted.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(afterRestart.status, "ALREADY_SATISFIED");
  assert.equal(afterRestart.event.recorded_at, first.event.recorded_at);
});

test("1R revoked retry fail-closed without event readback", () => {
  const ids = makeIdentities("1r-rev");
  const { writer } = createTestWriter(ids);
  const first = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(first.status, "APPENDED");
  writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "1r-rev-revoke", expected: 0, task_identity: ids.task_identity });
  const err = expectCode(
    () => writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE }),
    TRANSFER_CODES.WRITER_REVOKED,
  );
  assert.equal(err.event, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(err, "event"), false);
});

test("1R sorting does not mutate caller-owned evidence_refs", () => {
  const ids = makeIdentities("1r-mut");
  const refs = [
    { kind: "artifact", identity: "z", digest: hex("z") },
    { kind: "evidence_event", identity: "a", digest: hex("a") },
  ];
  const original = JSON.parse(JSON.stringify(refs));
  const { writer } = createTestWriter(ids, { evidence: new Set([hex("z"), hex("a")]) });
  const event = incident(ids, { evidence_refs: refs });
  const r = writer.appendTransferEvent({ event, principal: FIXTURE });
  assert.equal(r.status, "APPENDED");
  assert.deepEqual(refs, original);
  assert.deepEqual(r.event.evidence_refs, oracleSortRefs(original));
});

test("1R observed_outcome_class is not reducer outcome authority", () => {
  const ids = makeIdentities("1r-out");
  const { writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: incident(ids, { payload: { observed_outcome_class: "HOLD" } }),
    principal: FIXTURE,
  });
  const events = readLog(writer.root).events;
  const doc = reduceTransferMetrics({ events, window: WINDOW, formula_version: FORMULA_VERSION });
  assert.equal(doc.metrics.M1.status, "NOT_MEASURABLE");
  assert.equal(events.some((e) => e.event_type === "OUTCOME_OBSERVED"), false);
});

test("1R forbidden fields and unknown event have no incident fallback", () => {
  const ids = makeIdentities("1r-forb");
  const { writer } = createTestWriter(ids);
  for (const key of ["root_cause", "mechanism", "incident_family_id", "pattern_id", "planning_instruction", "NON_AUTHORITATIVE_NOTE"]) {
    expectCode(() => writer.appendTransferEvent({
      event: incident(ids, { payload: { [key]: "x" } }),
      principal: FIXTURE,
    }), TRANSFER_CODES.PAYLOAD_MALFORMED);
  }
  const unknown = incident(ids);
  unknown.event_type = "NOT_A_TYPE";
  expectCode(() => writer.appendTransferEvent({ event: unknown, principal: FIXTURE }), TRANSFER_CODES.EVENT_UNKNOWN_TYPE);
});

test("1R INCOMPLETE cannot skip identity or source digest", () => {
  const ids = makeIdentities("1r-inc");
  const { writer } = createTestWriter(ids);
  const missingDigest = incident(ids, {
    evidence_complete: false,
    evidence_refs: [],
    payload: { evidence_completeness_class: "INCOMPLETE" },
  });
  delete missingDigest.payload.source_record_digest;
  expectCode(() => writer.appendTransferEvent({ event: missingDigest, principal: FIXTURE }), TRANSFER_CODES.PAYLOAD_MALFORMED);
  const ok = writer.appendTransferEvent({
    event: incident(ids, {
      evidence_complete: false,
      evidence_refs: [],
      payload: { evidence_completeness_class: "INCOMPLETE" },
    }),
    principal: FIXTURE,
  });
  assert.equal(ok.status, "APPENDED");
});

test("1R other-13 opening goldens remain byte-identical", () => {
  const goldens = JSON.parse(readFileSync(OPENING_GOLDENS_PATH, "utf8"));
  assert.equal(goldens.length, 13);
  const byType = Object.fromEntries(goldens.map((g) => [g.event_type, g]));
  const other = EVENT_TYPES.filter((t) => t !== "INCIDENT_OBSERVED");
  assert.equal(other.length, 13);
  for (const type of other) {
    const ids = makeIdentities(`gold-${type}`);
    const { writer } = createTestWriter(ids);
    const overrides = {};
    if (!(type.startsWith("PATTERN") || type === "ROLLBACK_OBSERVED" || type === "STALE_PATTERN_REJECTED")) {
      overrides.pattern_identity = null;
    }
    // V1 goldens stay byte-identical: the predecessor chain ids are derived
    // from the V1-stamped CALLER event (durable stamps now follow the active
    // header generation [A63]; the goldens are V1 inputs by definition).
    if (type === "PATTERN_USED_IN_PLANNING" || type === "PATTERN_USED_IN_VERIFICATION") {
      const retrCaller = validateCallerEvent(makeEvent("PATTERN_RETRIEVED", ids, { occurred_at: iso(1), applicability_decision: "APPLICABLE" }));
      overrides.retrieval_event_id = computeEventId(computeIdempotencyKey(retrCaller));
      overrides.occurred_at = iso(2);
    }
    if (type === "TRANSFER_ADJUDICATED") {
      const retrCaller = validateCallerEvent(makeEvent("PATTERN_RETRIEVED", ids, { occurred_at: iso(1), applicability_decision: "APPLICABLE" }));
      overrides.subject_event_id = computeEventId(computeIdempotencyKey(retrCaller));
      overrides.occurred_at = iso(2);
      overrides.authority = { ...REVIEWER };
      overrides.producer_kind = "measurement-writer";
    }
    const event = makeEvent(type, ids, overrides);
    const isolated = validateCallerEvent(event);
    const expected = byType[type];
    assert.ok(expected, type);
    assert.equal(computeIdempotencyKey(isolated), expected.idempotency_key, type);
    assert.equal(computePayloadDigest(isolated.payload), expected.payload_digest, type);
    assert.equal(computeEventId(computeIdempotencyKey(isolated)), expected.event_id, type);
  }
});

test("1R production reachability remains zero", () => {
  const hits = scanSrcScripts([
    "learning/transfer-metrics", "getTransferMetricsWriter", "recordTransferEvent",
    "appendTransferEvent", "INCIDENT_OBSERVED", "deriveSourceIdentityKey",
    "applyIncidentObservedProfile", "source_identity_key",
  ]);
  assert.equal(hits.length, 0, JSON.stringify(hits));
  const incidentsDir = join(REPO, "src/learning/incidents");
  if (existsSync(incidentsDir)) {
    assert.deepEqual(readdirSync(incidentsDir).sort(), ["current-verification.mjs", "lifecycle-terminal-adapter.mjs", "projection.mjs"]);
  }
  assert.equal(existsSync(join(REPO, "src/learning/incident-observation")), false);
});

test("1R no persistent pre-profile transfer log in repo", () => {
  const found = [];
  function walk(dir, depth = 0) {
    if (depth > 6) return;
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (name === "transfer-events.jsonl" || name === "incident-index.json" || name === "journal.sqlite") {
        found.push(p);
      }
    }
  }
  walk(join(REPO, "src"));
  walk(join(REPO, "test"));
  assert.deepEqual(found, []);
});

test("1R chain-valid pre-profile INCIDENT_OBSERVED is ineligible for profile append", () => {
  const ids = makeIdentities("1r-leg");
  const { root, writer } = createTestWriter(ids);
  const first = writer.appendTransferEvent({ event: incident(ids), principal: FIXTURE });
  assert.equal(first.status, "APPENDED");
  const logPath = join(root, LOG_FILE_NAME);
  const lines = readFileSync(logPath, "utf8").split("\n");
  const header = lines[0];
  const durable = JSON.parse(lines[1]);
  const beforeBytes = readFileSync(logPath);
  const payload = { observed_outcome_class: "HOLD" };
  const payload_digest = computePayloadDigest(payload);
  const event_id = hex("legacy-event-id");
  const idempotency_key = hex("legacy-idempotency-key");
  const event_digest = computeEventDigest({
    journal_sequence: 1,
    event_id,
    event_type: "INCIDENT_OBSERVED",
    payload_digest,
    previous_digest: durable.previous_digest,
  });
  const legacy = {
    ...durable,
    payload,
    payload_digest,
    event_id,
    idempotency_key,
    event_digest,
    journal_sequence: 1,
    previous_digest: durable.previous_digest,
  };
  writeFileSync(logPath, `${header}\n${JSON.stringify(legacy)}\n`);
  const snap = readLog(root);
  assert.equal(snap.events.length, 1);
  assert.equal(snap.events[0].payload.profile_version, undefined);
  const err = expectCode(
    () => writer.appendTransferEvent({
      event: incident(ids, { payload: { source_record_id: "src-after-legacy" } }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.LOG_CHAIN_INVALID,
  );
  assert.match(err.message, /pre-profile INCIDENT_OBSERVED is not eligible/);
  assert.equal(readLog(root).events.length, 1);
  void beforeBytes;
  void GENESIS_DIGEST;
});

test("1R 64-process same-source same-payload one winner", async () => {
  const ids = makeIdentities("1r-p64");
  const { root } = createTestWriter(ids);
  const worker = join(root, "w.mjs");
  writeFileSync(worker, `
    import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { makeIdentities, makeEvent, makeBinder, FIXTURE } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
    const ids = makeIdentities("1r-p64");
    const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
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
  `);
  const jobs = [];
  for (let i = 0; i < 64; i += 1) {
    jobs.push(spawnNode([worker]));
  }
  const results = await Promise.all(jobs);
  const outs = results.map((r) => r.out);
  assert.equal(outs.filter((s) => s === "APPENDED").length, 1);
  assert.equal(outs.filter((s) => s === "ALREADY_SATISFIED").length, 63);
  assert.equal(readLog(root).events.length, 1);
});

test("1R 64-process mixed source digest fail-closed one durable", async () => {
  const ids = makeIdentities("1r-mix");
  const { root } = createTestWriter(ids);
  const worker = join(root, "wm.mjs");
  writeFileSync(worker, `
    import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { makeIdentities, makeEvent, makeBinder, FIXTURE, hex } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
    import { TRANSFER_CODES } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/schema.mjs"))};
    const ids = makeIdentities("1r-mix");
    const digest = process.argv[2];
    const event = makeEvent("INCIDENT_OBSERVED", ids, {
      pattern_identity: null,
      payload: { source_record_digest: digest },
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
    const digest = i === 0 ? ids.source_record_digest : hex(`mix-${i}`);
    jobs.push(spawnNode([worker, digest]));
  }
  const results = await Promise.all(jobs);
  const outs = results.map((r) => r.out);
  const appended = outs.filter((s) => s === "APPENDED").length;
  const conflict = outs.filter((s) => s === TRANSFER_CODES.IDEMPOTENCY_CONFLICT).length;
  const satisfied = outs.filter((s) => s === "ALREADY_SATISFIED").length;
  assert.equal(appended, 1);
  assert.equal(appended + conflict + satisfied, 64);
  assert.equal(readLog(root).events.length, 1);
});

test("1R 64-process evidence-order permutations AlreadySatisfied", async () => {
  const ids = makeIdentities("1r-ord");
  const a = hex("ord-a");
  const b = hex("ord-b");
  const { root } = createTestWriter(ids, { evidence: new Set([a, b]) });
  const worker = join(root, "wo.mjs");
  writeFileSync(worker, `
    import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { makeIdentities, makeEvent, makeBinder, FIXTURE } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
    const ids = makeIdentities("1r-ord");
    const a = ${JSON.stringify(a)};
    const b = ${JSON.stringify(b)};
    const flip = process.argv[2] === "1";
    const refs = flip
      ? [{ kind: "artifact", identity: "b", digest: b }, { kind: "evidence_event", identity: "a", digest: a }]
      : [{ kind: "evidence_event", identity: "a", digest: a }, { kind: "artifact", identity: "b", digest: b }];
    const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, evidence_refs: refs });
    const writer = new TransferMetricsWriter({
      transferMetricsRoot: ${JSON.stringify(root)},
      identityBinder: makeBinder(ids, { evidence: new Set([a, b]) }),
      allowFixture: true,
    });
    try {
      const r = writer.appendTransferEvent({ event, principal: FIXTURE });
      process.stdout.write(r.status);
    } catch (e) {
      process.stdout.write(e.code || "ERR");
    }
  `);
  const jobs = [];
  for (let i = 0; i < 64; i += 1) jobs.push(spawnNode([worker, String(i % 2)]));
  const results = await Promise.all(jobs);
  const outs = results.map((r) => r.out);
  assert.equal(outs.filter((s) => s === "APPENDED").length, 1);
  assert.equal(outs.filter((s) => s === "ALREADY_SATISFIED").length, 63);
  assert.equal(readLog(root).events.length, 1);
});

test("1R original T11 input (same source, different evidence digest) is now conflict", () => {
  const ids = makeIdentities("1r-t11old");
  const evidenceB = hex("evidence-t11-b");
  const { writer, root } = createTestWriter(ids, { evidence: new Set([ids.evidence, evidenceB]) });
  const a = incident(ids);
  const b = incident(ids, {
    evidence_refs: [{ kind: "evidence_event", identity: "ev2", digest: evidenceB }],
  });
  const first = writer.appendTransferEvent({ event: a, principal: FIXTURE });
  assert.equal(first.status, "APPENDED");
  expectCode(() => writer.appendTransferEvent({ event: b, principal: FIXTURE }), TRANSFER_CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(readLog(root).events.length, 1);
});
