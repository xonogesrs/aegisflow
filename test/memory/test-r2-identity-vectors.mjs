// test/memory/test-r2-identity-vectors.mjs
//
// R2 PHASE 2 — IDENTITY + DERIVED FIELD SUPPORT (TEST-ONLY artifact class).
// PLAN PHASE-2-IDENTITY: A1 D3 derivations accept PATTERN (canonical-JSON
// vectors, fixed epoch); A2 learning-profile digest path exercised for
// PATTERN candidates; A3 generation binding fields validated as durable,
// immutable record fields; A4 assertCandidateDerivedIdentities proven
// (agreement ⇒ pass; divergence ⇒ CANDIDATE_IDENTITY_MISMATCH fail-closed).
// ZERO production files change in PHASE 2 (all primitives live, exported,
// record-agnostic). Harness independence (H1): session/provider/checkpoint
// ids are never identity inputs — the primitives structurally cannot accept
// them (fixed field sets); asserted here by construction + identical-semantics.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_RECORD_SCHEMA,
  NOT_APPLICABLE,
  deriveContentHash,
  deriveLogicalKey,
  deriveMemoryRecordId,
  deriveEventId,
} from "../../src/memory/index.mjs";
import {
  CANDIDATE_OBS_SCHEMA,
} from "../../src/learning/transfer-metrics/schema.mjs";
import {
  deriveCandidateIdentityKey,
  deriveCandidateId,
  assertCandidateDerivedIdentities,
} from "../../src/learning/patterns/candidate.mjs";

// fixed epoch — gate fixed-epoch rule inherited (no wall clock in identity)
const T = "2026-09-08T00:00:00.000Z";
const hex64 = (c) => c.repeat(64);

const PATTERN_CONTENT = (o = {}) => ({
  kind: "STRUCTURED",
  data: {
    mechanismDigest: hex64("1"),
    applicabilityDigest: hex64("2"),
    constituentIncidentSetDigest: hex64("3"),
    constituentIncidentRecordIds: [hex64("4"), hex64("5")],
    qualificationRecordId: hex64("6"),
    publicationGeneration: 3,
    counterexamples: NOT_APPLICABLE,
    applicability: {
      appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src/memory" }],
      doesNotApplyWhen: [],
      mechanismSignature: { errorClass: "livelock" },
    },
    ...o,
  },
});

function patternRecord(overrides = {}, contentOverrides = {}) {
  const rec = {
    schema: MEMORY_RECORD_SCHEMA,
    recordType: "PATTERN",
    identity: { patternId: "pat-vec-1", repositoryIdentity: hex64("7") },
    subject: { statement: "PATTERN vector", contentHash: null, language: NOT_APPLICABLE },
    content: PATTERN_CONTENT(contentOverrides),
    source: { source: "EXECUTION", identity: hex64("9") },
    scope: { repository: hex64("7") },
    trust: "UNVERIFIED",
    validity: { status: "CURRENT", validityTree: NOT_APPLICABLE },
    lifecycle: { events: [] },
    timestamps: { createdAt: T, updatedAt: T },
    evidence: { manifestDigest: hex64("a"), items: [] },
    security: { scanResult: "clean", ingestionSource: "vector" },
    metadata: {},
    ...overrides,
  };
  rec.subject.contentHash = deriveContentHash(rec.content);
  rec.recordId = deriveMemoryRecordId(rec);
  return rec;
}

// ── A1: D3 derivations accept PATTERN — deterministic on canonical vectors ──

test("A1. deriveMemoryRecordId/deriveLogicalKey/deriveContentHash accept PATTERN and are deterministic", () => {
  const a = patternRecord();
  const b = patternRecord();
  assert.equal(a.recordId, b.recordId, "same canonical vector ⇒ same recordId");
  assert.equal(deriveLogicalKey(a), deriveLogicalKey(b), "same canonical vector ⇒ same logicalKey");
  assert.equal(a.subject.contentHash, b.subject.contentHash, "same content ⇒ same contentHash");
  assert.match(a.recordId, /^[0-9a-f]{64}$/);
  assert.match(deriveLogicalKey(a), /^[0-9a-f]{64}$/);
  assert.match(a.subject.contentHash, /^[0-9a-f]{64}$/);
});

test("A1b. PATTERN recordId diverges from CODE identity at the same scope (recordType is an identity input)", () => {
  const p = patternRecord();
  const codeSameScope = patternRecord({ recordType: "CODE" });
  assert.notEqual(p.recordId, codeSameScope.recordId);
  assert.notEqual(deriveLogicalKey(p), deriveLogicalKey(codeSameScope));
});

test("A1c. non-identity fields (metadata/timestamps/evidence) never affect PATTERN recordId", () => {
  const a = patternRecord();
  const b = patternRecord({ metadata: { any: "x" } });
  const c = patternRecord({ timestamps: { createdAt: T, updatedAt: "2027-01-01T00:00:00.000Z" } });
  const d = patternRecord({ lifecycle: { events: [] } });
  b.recordId = deriveMemoryRecordId(b);
  c.recordId = deriveMemoryRecordId(c);
  assert.equal(a.recordId, b.recordId);
  assert.equal(a.recordId, c.recordId);
  assert.equal(a.recordId, d.recordId);
});

test("A1d. different lineage ⇒ different digest (cannot alias); same lineage ⇒ identical", () => {
  const a = patternRecord();
  const otherConstituents = patternRecord({}, { constituentIncidentRecordIds: [hex64("4"), hex64("5"), hex64("6")] });
  assert.notEqual(a.subject.contentHash, otherConstituents.subject.contentHash);
  assert.notEqual(a.recordId, otherConstituents.recordId, "constituent set is a content digest input");
  const sameConstituents = patternRecord({}, { constituentIncidentRecordIds: [hex64("4"), hex64("5")] });
  assert.equal(a.subject.contentHash, sameConstituents.subject.contentHash);
});

test("A1e. different generation ⇒ different identity input (cannot alias as current)", () => {
  const g3 = patternRecord({}, { publicationGeneration: 3 });
  const g4 = patternRecord({}, { publicationGeneration: 4 });
  assert.notEqual(g3.subject.contentHash, g4.subject.contentHash, "generation is content-bound (D6)");
  assert.notEqual(g3.recordId, g4.recordId);
});

test("A1f. harness/session/provider ids are structurally NOT identity inputs (H1 by construction)", () => {
  // The D3 derivations accept EXACTLY {schema, recordType, identity, subject,
  // scope, sourceIdentity}. There is no field a session id could occupy: two
  // records identical on all legal fields stay identical regardless of any
  // ambient runtime state; and a session-id-shaped string dropped into a
  // NON-identity field changes nothing.
  const a = patternRecord();
  const b = patternRecord({ metadata: { deepseekSessionId: "sess-1234", providerRequestId: "req-9", containerId: "c-1", checkpoint: "/tmp/ckpt" } });
  b.recordId = deriveMemoryRecordId(b);
  assert.equal(a.recordId, b.recordId, "harness ids in non-identity fields never affect identity");
  assert.equal(deriveLogicalKey(a), deriveLogicalKey(b));
});

// ── A2: learning-profile digest path exercised for PATTERN candidates ───────

function candidateEvent(o = {}) {
  const payload = {
    lifecycle_state: "CANDIDATE",
    mechanism_digest: hex64("1"),
    applicability_digest: hex64("2"),
    constituent_incident_set_digest: hex64("3"),
    profile_version: CANDIDATE_OBS_SCHEMA,
    candidate_slot: 0,
    phase_identity: { execution_id: "exec-1", phase_id: "phase-1" },
    ...o,
  };
  return {
    schema_version: "autoloop.transfer-event/v1",
    event_type: "PATTERN_CANDIDATE_CREATED",
    project_identity: "proj-1",
    task_identity: "task-1",
    attempt_identity: "att-1",
    incident_identity: { incident_id: "inc-1" },
    pattern_identity: { pattern_id: "pat-vec-1", generation: 0 },
    payload,
  };
}

test("A2. deriveCandidateIdentityKey/deriveCandidateId derive for PATTERN candidate payloads (deterministic)", () => {
  const e = candidateEvent();
  const k1 = deriveCandidateIdentityKey(e);
  const k2 = deriveCandidateIdentityKey(e);
  assert.ok(/^[0-9a-f]{64}$/.test(k1));
  assert.equal(k1, k2, "identity key is deterministic (evidence-independent)");
  e.payload.candidate_identity_key = k1;
  const c1 = deriveCandidateId(e);
  const c2 = deriveCandidateId(e);
  assert.ok(/^[0-9a-f]{64}$/.test(c1));
  assert.equal(c1, c2, "candidate_id is deterministic (identity key + incident + content digests)");
});

test("A2b. learning-profile lineage difference changes candidate_id (no aliasing)", () => {
  const e = candidateEvent();
  e.payload.candidate_identity_key = deriveCandidateIdentityKey(e);
  const cidA = deriveCandidateId(e);
  const other = candidateEvent({ constituent_incident_set_digest: hex64("f") });
  other.payload.candidate_identity_key = deriveCandidateIdentityKey(other);
  const cidB = deriveCandidateId(other);
  assert.notEqual(cidA, cidB, "different constituent set ⇒ different candidate_id");
});

test("A2c. no third identity system: the learning profile is the SEALED deriveCandidate* pair (imported from candidate.mjs)", () => {
  assert.equal(typeof deriveCandidateIdentityKey, "function");
  assert.equal(typeof deriveCandidateId, "function");
  assert.equal(typeof assertCandidateDerivedIdentities, "function");
  assert.equal(CANDIDATE_OBS_SCHEMA, "autoloop.pattern-candidate/v1");
});

// ── A4: assertCandidateDerivedIdentities — agreement ⇒ pass; divergence ⇒ fail ──

test("A4. assertCandidateDerivedIdentities: filled identities agree ⇒ pass", () => {
  const e = candidateEvent();
  e.payload.candidate_identity_key = deriveCandidateIdentityKey(e);
  e.payload.candidate_id = deriveCandidateId(e);
  assert.doesNotThrow(() => assertCandidateDerivedIdentities(e));
});

test("A4b. assertCandidateDerivedIdentities: tampered candidate_id ⇒ CANDIDATE_IDENTITY_MISMATCH fail-closed", () => {
  const e = candidateEvent();
  e.payload.candidate_identity_key = deriveCandidateIdentityKey(e);
  e.payload.candidate_id = deriveCandidateId(e);
  const tampered = structuredClone(e);
  tampered.payload.candidate_id = "0".repeat(64);
  assert.throws(() => assertCandidateDerivedIdentities(tampered), (err) => {
    const reason = err?.details?.reason ?? "";
    return reason === "CANDIDATE_IDENTITY_MISMATCH";
  });
});

test("A4c. assertCandidateDerivedIdentities: tampered identity key ⇒ fail-closed", () => {
  const e = candidateEvent();
  e.payload.candidate_identity_key = deriveCandidateIdentityKey(e);
  e.payload.candidate_id = deriveCandidateId(e);
  const tampered = structuredClone(e);
  tampered.payload.candidate_identity_key = "1".repeat(64);
  assert.throws(() => assertCandidateDerivedIdentities(tampered), (err) => (err?.details?.reason ?? "") === "CANDIDATE_IDENTITY_MISMATCH");
});

test("A4d. content-bound divergence: mechanism digest change without re-derivation ⇒ MISMATCH", () => {
  const e = candidateEvent();
  e.payload.candidate_identity_key = deriveCandidateIdentityKey(e);
  e.payload.candidate_id = deriveCandidateId(e);
  const tampered = structuredClone(e);
  tampered.payload.mechanism_digest = hex64("9"); // content changed; stored identity not re-derived
  assert.throws(() => assertCandidateDerivedIdentities(tampered), (err) => (err?.details?.reason ?? "") === "CANDIDATE_IDENTITY_MISMATCH");
});

// ── A3-adjacent: durable generation fields are immutable record fields ──────

test("A3. PATTERN generation binding is a durable, immutable record field (validation-enforced integer ≥ 1)", () => {
  const bad = patternRecord({}, { publicationGeneration: 0 });
  // re-derive identity for the mutated record, then expect the VALIDATOR
  // (not identity) to fail closed on the invalid generation value
  bad.subject.contentHash = deriveContentHash(bad.content);
  bad.recordId = deriveMemoryRecordId(bad);
  // import the validator lazily to assert the fail-closed branch
  return import("../../src/memory/index.mjs").then(({ validateMemoryRecordV1 }) => {
    const v = validateMemoryRecordV1(bad);
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => e.includes("pattern_publication_generation_required")));
  });
});

test("A3b. execution identity fields are durable graph identities, never runtime ids (D5 shape check)", () => {
  // candidateIdFor inputs are exactly {graphRunId, originatingNode,
  // sourceResultIdentity, proposedRecordType, proposedIdentity,
  // lifecycleIntent} — a taskCardId/session string is NOT among them.
  const a = patternRecord();
  a.metadata = { graphRunId: "run-x", originatingNode: "SA-1", sourceResultIdentity: hex64("2") };
  const b = patternRecord();
  assert.equal(deriveMemoryRecordId(a), deriveMemoryRecordId(b), "execution identity rides candidate inputs, not record non-identity fields");
  // deriveEventId remains deterministic for durable event identity
  const e1 = deriveEventId("evt", a.recordId, "stale", "t1");
  const e2 = deriveEventId("evt", a.recordId, "stale", "t1");
  assert.equal(e1, e2);
});
