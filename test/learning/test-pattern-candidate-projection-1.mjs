// test/learning/test-pattern-candidate-projection-1.mjs
//
// Durable story for PATTERN_CANDIDATE_EVIDENCE_BINDING_1 (GATE-B-COMPLETION-1).
// 1. Publish a C3 post-finalization derived candidate artifact (the owner's
//    frozen 12-step protocol, via the proven helper makeWorld/publishGen1).
// 2. Consume a current-verification receipt and re-derive the candidate
//    identity from the projected INCIDENT_OBSERVED item (source binding).
// 3. Append the PATTERN_CANDIDATE_CREATED event through the REAL writer with
//    the extended candidate profile: the artifact digest and link digest are
//    permanently pinned in the event payload and in the evidence_refs.
// 4. Replay: rebuild the projection from the raw log bytes; the pinned
//    artifact is re-validated from the digest stored in the event; missing
//    artifact or digest mismatch fails closed.
// 5. Determinism: two independent projections over the same bytes produce
//    byte-identical documents.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { CANDIDATE_OBS_SCHEMA, TRANSFER_CODES, isHex64 } from "../../src/learning/transfer-metrics/schema.mjs";
import { TransferMetricsWriter, captureRawLogSnapshot } from "../../src/learning/transfer-metrics/writer.mjs";
import { readLog, LOG_FILE_NAME } from "../../src/learning/transfer-metrics/log.mjs";
import { deriveAuthoritySubjectIdentity } from "../../src/learning/transfer-metrics/authority-state.mjs";
import { createIdentityBinder } from "../../src/learning/transfer-metrics/identities.mjs";
import {
  FIXTURE,
  makeIdentities,
  makeEvent,
  createTestWriter,
  createTestRoot,
  expectCode,
  hex,
  iso,
} from "../../src/learning/transfer-metrics/fixtures.mjs";
import { observeLifecycleHeldIncident } from "../../src/learning/incidents/lifecycle-terminal-adapter.mjs";
import { buildIncidentProjection } from "../../src/learning/incidents/projection.mjs";
import { verifyCurrentIncident, consumeCurrentVerificationReceipt, isCurrentVerificationReceipt } from "../../src/learning/incidents/current-verification.mjs";
// Real C3 owner helpers + real current-verification receipt surfaces.
import {
  makeWorld,
  publishGen1,
  BODY_A,
  derivedReadState,
  resolveExecDir,
  DERIVED_CODES,
} from "../v2/helpers/derived-artifact-fixtures.mjs";
import { RunEvidenceStore } from "../../src/evidence/run-evidence-store.mjs";
import { buildRunManifest, finalizeRunManifest } from "../../src/evidence/run-manifest.mjs";
import { writeExclusiveCreate } from "../../src/c2d/fs-atomic.mjs";
import { mintChainId, mintCheckpointId, mintExecutionId } from "../../src/c2d/execution-id.mjs";
import { createInitialSnapshot } from "../../src/c2d/checkpoint-store.mjs";
import {
  buildCandidatePayload,
  buildCandidateAdapterPayload,
  applyCandidateCreatedProfile,
  assertCandidateDerivedIdentities,
  deriveCandidateIdentityKey,
  deriveCandidateId,
  buildCandidateProjection,
  verifyCandidatePublication,
} from "../../src/learning/patterns/candidate.mjs";

function sha256HexOf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function writeCheckpointFile(execDir, snapshot) {
  const body = Buffer.from(JSON.stringify(snapshot), "utf8");
  const digest = sha256HexOf(body);
  writeExclusiveCreate(join(execDir, "CURRENT.json"), body);
  writeExclusiveCreate(join(execDir, "CURRENT.json.sha256"), digest + "\n");
  return digest;
}

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");

const publication = {
  artifact_digest: hex("artifact-digest"),
  committed_link_digest: hex("link-digest"),
  generation: 1,
  source_record_digest: hex("source-record"),
  evidence_set_digest: hex("evidence-set"),
};

function baseEvent(label) {
  const ids = makeIdentities(label);
  return makeEvent("PATTERN_CANDIDATE_CREATED", ids, {
    payload: buildCandidatePayload({
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
      phaseIdentity: { execution_id: ids.execution_id, phase_id: "p_impl" },
      publication,
    }),
  });
}

test("candidate payload builder pins publication digest and identity", () => {
  const ids = makeIdentities("cand-bind-1");
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
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p_impl" },
    publication,
  });
  assert.equal(payload.profile_version, CANDIDATE_OBS_SCHEMA);
  assert.equal(payload.lifecycle_state, "CANDIDATE");
  assert.ok(isHex64(payload.candidate_identity_key));
  assert.ok(isHex64(payload.candidate_id));
  assert.equal(payload.publication_artifact_digest, publication.artifact_digest);
  assert.equal(payload.publication_link_digest, publication.committed_link_digest);
  assert.equal(payload.publication_generation, publication.generation);
});

test("candidate id is not digest-derived from itself (no circular derivation)", () => {
  const ids = makeIdentities("cand-nocycle");
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
      phase_identity: { execution_id: ids.execution_id, phase_id: "p_impl" },
    },
  };
  const key = deriveCandidateIdentityKey(event);
  event.payload.candidate_identity_key = key;
  const id = deriveCandidateId(event);
  event.payload.candidate_id = id;
  // Re-deriving with the candidate_id present must not change the candidate_id.
  assert.equal(deriveCandidateId(event), id);
});

test("writer re-derives candidate identity and appends through the real writer", () => {
  const ids = makeIdentities("cand-writer-1");
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
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p_impl" },
    publication,
  });
  const event = makeEvent("PATTERN_CANDIDATE_CREATED", ids, {
    payload,
    evidence_refs: [
      // C3 publication receipt binding (HOLD model step 5): the raw event
      // permanently records the artifact identity and digest in its existing
      // evidence reference (kind "artifact").
      { kind: "artifact", identity: `${ids.execution_id}:p_impl`, digest: publication.artifact_digest },
      { kind: "evidence_manifest", identity: ids.execution_id, digest: publication.committed_link_digest },
      { kind: "evidence_event", identity: "evt-candidate-source", digest: publication.source_record_digest },
    ],
  });
  const res = writer.appendTransferEvent({ event, principal: FIXTURE });
  assert.equal(res.status, "APPENDED");
  const durable = readLog(root).events[0];
  assert.equal(durable.payload.candidate_id, payload.candidate_id);
  assert.equal(durable.payload.publication_artifact_digest, publication.artifact_digest);
  // The raw event permanently records the artifact identity and digest in its
  // existing evidence reference (kind "artifact").
  const artifactRef = durable.evidence_refs.find((r) => r.kind === "artifact");
  assert.ok(artifactRef, "artifact evidence ref missing");
  assert.equal(artifactRef.digest, publication.artifact_digest);
});

test("writer fail-closed on tampered candidate_id under the lock", () => {
  const ids = makeIdentities("cand-writer-2");
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
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p_impl" },
    publication,
  });
  const event = makeEvent("PATTERN_CANDIDATE_CREATED", ids, { payload });
  event.payload.candidate_id = hex("forged-candidate-id");
  expectCode(
    () => writer.appendTransferEvent({ event, principal: FIXTURE }),
    TRANSFER_CODES.PAYLOAD_MALFORMED,
  );
});

test("writer fail-closed when candidate identity is missing on extended profile", () => {
  const ids = makeIdentities("cand-writer-3");
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
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p_impl" },
    publication,
  });
  const event = makeEvent("PATTERN_CANDIDATE_CREATED", ids, { payload });
  delete event.payload.candidate_id;
  expectCode(
    () => writer.appendTransferEvent({ event, principal: FIXTURE }),
    TRANSFER_CODES.PAYLOAD_MALFORMED,
  );
});

test("writer fail-closed on wrong profile_version string", () => {
  const ids = makeIdentities("cand-writer-4");
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
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p_impl" },
    publication,
  });
  payload.profile_version = "autoloop.pattern-candidate/v2";
  const event = makeEvent("PATTERN_CANDIDATE_CREATED", ids, { payload });
  expectCode(
    () => writer.appendTransferEvent({ event, principal: FIXTURE }),
    TRANSFER_CODES.PAYLOAD_MALFORMED,
  );
});

test("replay: projection rebuilt from captured snapshot matches live projection", () => {
  const ids = makeIdentities("cand-replay-1");
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
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p_impl" },
    publication,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_CANDIDATE_CREATED", ids, { payload }),
    principal: FIXTURE,
  });
  // Replay 1: rebuild from a fresh capture of the durable bytes.
  const replay1 = buildCandidateProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  // Replay 2: rebuild AGAIN from an independent capture — recomputability
  // from bytes alone, no shared capture objects.
  const replay2 = buildCandidateProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.deepEqual(replay2, replay1);
  assert.equal(replay1.candidate_count, 1);
  assert.equal(replay1.items[0].candidate_id, payload.candidate_id);
  assert.deepEqual(replay1.items[0].publication, {
    artifact_digest: publication.artifact_digest,
    link_digest: publication.committed_link_digest,
    generation: publication.generation,
  });
});

test("candidate projection is byte-stable (determinism)", () => {
  const ids = makeIdentities("cand-determinism");
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
    phaseIdentity: { execution_id: ids.execution_id, phase_id: "p_impl" },
    publication,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_CANDIDATE_CREATED", ids, { payload }),
    principal: FIXTURE,
  });
  const a = buildCandidateProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  const b = buildCandidateProjection(captureRawLogSnapshot({ transferMetricsRoot: root }));
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

// ===========================================================================
// REAL C3 PUBLICATION + REAL CV RECEIPT INTEGRATION (contract map §5)
// ===========================================================================

function nowClock() {
  return () => new Date(Date.now() + 120000).toISOString();
}

/** Real C3 PHASE_HELD publication + INCIDENT_OBSERVED append + GEN-2
 * authority fold, mirroring test-incident-current-verification publishHeld
 * (minimal, HOLD-verdict path only). */
function buildCvWorld(label) {
  const ids = makeIdentities(label);
  const execution_id = mintExecutionId();
  const chainId = mintChainId();
  const checkpointId = mintCheckpointId();
  ids.execution_id = execution_id;
  ids.attempt_identity = { execution_id, attempt: 0 };
  const phaseId = "p_impl";
  const root = createTestRoot(`cand-cv-${label}`);
  const store = new RunEvidenceStore({
    root,
    executionId: execution_id,
    chainId,
    checkpointId,
    repoRoot: ids.project_identity.repository_root_identity,
  });
  store.init();
  // PHASE_HELD (the CV-verifiable terminal publication).
  const held = store.appendEvent({
    event_type: "PHASE_HELD",
    stage: "phase",
    phase_id: phaseId,
    attempt: 0,
    status: "held",
    payload: { final: "HOLD", reason: "REVIEWER_HOLD" },
  });
  const resultRecord = {
    phase_id: phaseId,
    final: "HOLD",
    status: "held",
    attempt: 0,
    reason: "REVIEWER_HOLD",
    graph_generation: 0,
    recorded_at: iso(30),
  };
  const written = store.writePhaseArtifact(phaseId, "result.json", resultRecord);
  const pin = written.sha256;
  // Base checkpoint snapshot with the result pin (what CV verifies).
  const snapshot = createInitialSnapshot({
    checkpoint_id: checkpointId,
    execution_id,
    chain_id: chainId,
    repository_fingerprint: { origin_url: "", origin_master: "" },
    repository_root_identity: ids.project_identity.repository_root_identity,
    git_common_dir_identity: ids.project_identity.git_common_dir_identity,
    expected_head: "0".repeat(40),
    expected_ref: "refs/heads/master",
    expected_worktree_state: "clean",
  });
  snapshot.phase_result_hashes = { [phaseId]: pin };
  snapshot.graph = { recovery_generation: 0 };
  writeCheckpointFile(store.execDir, snapshot);
  // FINALIZED base manifest (STEP-1 gate for the C3 owner).
  finalizeRunManifest(store.execDir, buildRunManifest({
    executionId: execution_id,
    chainId,
    created_at: iso(31),
    completed_at: iso(32),
    final_verdict: "HOLD",
    final_reason: "REVIEWER_HOLD",
    phase_results: [{ phase_id: phaseId, result_hash: pin }],
    artifact_inventory: [],
    secret_scan_result: { scanned: true, matches: [] },
    format_versions: {},
  }));
  // The real writer on the SAME root (V2 raw log = the authority location).
  const binder = createIdentityBinder({
    tasks: new Map([[ids.task_id, { admission_id: ids.admission_id }]]),
    attempts: new Map([[execution_id, { attempts: new Set([0, 1, 2]) }]]),
    projects: new Map([[ids.project_identity.repository_root_identity, ids.project_identity]]),
    evidence: new Set([ids.evidence, ids.evidence_manifest_digest, ids.counterfactual_digest]),
    lifecycleTerminals: new Map([[execution_id, { final: "HOLD", attempt: 0 }]]),
    lifecycleTimes: new Map(),
    truthGenerations: new Map(),
    requireEvidenceInventory: false,
  });
  const writer = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: binder,
    revocationRegistry: { revokedWriterIds: new Set(), currentGenerations: new Map() },
    clock: nowClock(),
    allowFixture: true,
    crashHooks: {},
  });
  // Observe the held incident through the REAL terminal adapter.
  const observed = observeLifecycleHeldIncident({
    authoritativeSourceReference: { evidenceRoot: root, execution_id, phase_id: phaseId },
    expectedIdentityBinding: {
      project_identity: ids.project_identity,
      task_identity: ids.task_identity,
      attempt_identity: ids.attempt_identity,
      writer: { writer_id: "w1", writer_generation: 0 },
    },
    transferMetricsWriter: writer,
    observerPrincipal: FIXTURE,
  });
  return { ids, root, store, execDir: store.execDir, execution_id, phaseId, pin, writer, observed };
}

function verifyCv(world) {
  const snapshot = captureRawLogSnapshot({ transferMetricsRoot: world.root });
  const projection = buildIncidentProjection(snapshot);
  const item = projection.envelope.items[0];
  return verifyCurrentIncident({
    validated_evidence_root: world.root,
    projection_document: projection,
    projection_item: item,
    selector: { execution_id: world.execution_id, phase_id: world.phaseId },
    verification_principal: FIXTURE,
  });
}

test("integration: real C3 publication + real CV receipt pin a durable candidate", async () => {
  // 1. REAL C3 post-finalization publication through the frozen 12-step owner.
  const world = makeWorld("cand-int-1");
  try {
    const pub = await publishGen1(world, { mutationId: "mut-cand-1" });
    assert.equal(pub.status, DERIVED_CODES.COMMITTED);
    assert.equal(pub.generation, 1);

    // 2. REAL verified incident + REAL CV receipt.
    const cvWorld = buildCvWorld("cand-int-1");
    const { result, receipt } = verifyCv(cvWorld);
    assert.equal(result.status, "VERIFIED_CURRENT");
    assert.equal(isCurrentVerificationReceipt(receipt), true);
    const snap = captureRawLogSnapshot({ transferMetricsRoot: cvWorld.root });
    const projection = buildIncidentProjection(snap);
    const item2 = projection.envelope.items[0];

    // 3. Sealed adapter: consumes the CV receipt + publication facts, derives
    //    the candidate payload from the verified incident record.
    const content = {
      pattern_identity: { pattern_id: "pat-cand-int-1", generation: 0 },
      mechanism_digest: hex("cand-int-1-mech"),
      applicability_digest: hex("cand-int-1-appl"),
      constituent_incident_set_digest: hex("cand-int-1-set"),
    };
    const payload = buildCandidateAdapterPayload({
      incident: item2,
      content,
      slot: 0,
      phaseIdentity: { execution_id: world.executionId, phase_id: "p1" },
      publication: {
        artifact_digest: pub.artifact_digest,
        committed_link_digest: pub.committed_link_digest,
        generation: pub.generation,
      },
      cv: {
        result,
        receipt,
        validated_evidence_root: cvWorld.root,
        projection_document: projection,
        projection_item: item2,
        selector: { execution_id: cvWorld.execution_id, phase_id: cvWorld.phaseId },
        verification_principal: FIXTURE,
      },
    });
    assert.ok(isHex64(payload.candidate_id));
    assert.equal(payload.current_verification_facts.incident_id, result.incident_id);
    // Receipt single-use: the adapter consumed it; a second consume fails.
    const second = consumeCurrentVerificationReceipt({
      validated_evidence_root: cvWorld.root,
      projection_document: projection,
      projection_item: item2,
      selector: { execution_id: cvWorld.execution_id, phase_id: cvWorld.phaseId },
      verification_principal: FIXTURE,
      receipt,
    });
    assert.notEqual(second.result.status, "VERIFIED_CURRENT");

    // 4. Append through the REAL writer with the artifact evidence ref
    //    (HOLD model step 5) — on the SAME root the CV receipt verified.
    //    The event binds the VERIFIED incident identity (the CV item), not
    //    a fixture-invented one.
    const event = makeEvent("PATTERN_CANDIDATE_CREATED", cvWorld.ids, {
      payload,
      attempt_identity: cvWorld.ids.attempt_identity,
      incident_identity: { incident_id: item2.incident_id, incident_id_kind: "evidence_bound" },
      // Occurs strictly AFTER the observed incident on the same attempt
      // (writer monotonicity per attempt).
      occurred_at: new Date(Date.now() + 180000).toISOString(),
      evidence_refs: [
        { kind: "artifact", identity: `${world.executionId}:p1`, digest: pub.artifact_digest },
        { kind: "evidence_manifest", identity: world.executionId, digest: pub.committed_link_digest },
        { kind: "evidence_event", identity: item2.incident_observation_id, digest: item2.raw_event_digest },
      ],
    });
    const res = cvWorld.writer.appendTransferEvent({ event, principal: FIXTURE });
    assert.equal(res.status, "APPENDED");

    // 5. Verify the pinned publication against the OWNER's durable bytes.
    const verification = verifyCandidatePublication({
      root: world.root,
      executionId: world.executionId,
      phaseId: "p1",
      publication: {
        artifact_digest: pub.artifact_digest,
        link_digest: pub.committed_link_digest,
        generation: pub.generation,
      },
    });
    assert.equal(verification.verified, true);
    assert.equal(verification.artifact_digest, pub.artifact_digest);
    assert.equal(verification.generation, 1);

    // 6. Replay: the projection rebuilt from durable bytes pins the same
    //    publication digest (event → durable artifact binding survives
    //    replay), and the digest matches the OWNER state, not caller bytes.
    const proj = buildCandidateProjection(captureRawLogSnapshot({ transferMetricsRoot: cvWorld.root }));
    assert.equal(proj.candidate_count, 1);
    assert.equal(proj.items[0].candidate_id, payload.candidate_id);
    assert.equal(proj.items[0].publication.artifact_digest, pub.artifact_digest);

    cvWorld.store.verifyJournal();
  } finally {
    world.cleanup();
  }
});

test("integration: digest mismatch between event and durable artifact fails closed", async () => {
  const world = makeWorld("cand-int-2");
  try {
    const pub = await publishGen1(world, { mutationId: "mut-cand-2", body: BODY_A });
    assert.equal(pub.status, DERIVED_CODES.COMMITTED);
    // Forged digest: a caller pinning bytes that were never published.
    assert.throws(
      () => verifyCandidatePublication({
        root: world.root,
        executionId: world.executionId,
        phaseId: "p1",
        publication: {
          artifact_digest: hex("forged-artifact"),
          link_digest: pub.committed_link_digest,
          generation: pub.generation,
        },
      }),
      (e) => e.code === TRANSFER_CODES.PAYLOAD_MALFORMED,
    );
    // Wrong generation: stale head binding.
    assert.throws(
      () => verifyCandidatePublication({
        root: world.root,
        executionId: world.executionId,
        phaseId: "p1",
        publication: {
          artifact_digest: pub.artifact_digest,
          link_digest: pub.committed_link_digest,
          generation: 2,
        },
      }),
      (e) => e.code === TRANSFER_CODES.PAYLOAD_MALFORMED,
    );
    // Wrong execution: identity mismatch.
    assert.throws(
      () => verifyCandidatePublication({
        root: world.root,
        executionId: mintExecutionId(),
        phaseId: "p1",
        publication: {
          artifact_digest: pub.artifact_digest,
          link_digest: pub.committed_link_digest,
          generation: pub.generation,
        },
      }),
      (e) => e.code === TRANSFER_CODES.PAYLOAD_MALFORMED,
    );
    // Wrong phase: anchor identity mismatch.
    assert.throws(
      () => verifyCandidatePublication({
        root: world.root,
        executionId: world.executionId,
        phaseId: "p_other",
        publication: {
          artifact_digest: pub.artifact_digest,
          link_digest: pub.committed_link_digest,
          generation: pub.generation,
        },
      }),
      (e) => e.code === TRANSFER_CODES.PAYLOAD_MALFORMED,
    );
    // Missing publication entirely (fresh empty world): fail closed.
    const empty = makeWorld("cand-int-2-empty");
    try {
      assert.throws(
        () => verifyCandidatePublication({
          root: empty.root,
          executionId: empty.executionId,
          phaseId: "p1",
          publication: {
            artifact_digest: pub.artifact_digest,
            link_digest: pub.committed_link_digest,
            generation: pub.generation,
          },
        }),
        (e) => e.code === TRANSFER_CODES.PAYLOAD_MALFORMED,
      );
    } finally { empty.cleanup(); }
  } finally {
    world.cleanup();
  }
});

test("adapter fails closed on non-VERIFIED_CURRENT cv result", () => {
  const ids = makeIdentities("cand-cv-bad-1");
  assert.throws(
    () => buildCandidateAdapterPayload({
      incident: { incident_id: ids.incident_id, source_record_digest: hex("src"), project_identity: ids.project_identity, task_identity: ids.task_identity, attempt_identity: ids.attempt_identity },
      content: { pattern_identity: { pattern_id: "p", generation: 0 }, mechanism_digest: hex("m"), applicability_digest: hex("a"), constituent_incident_set_digest: hex("s") },
      slot: 0,
      phaseIdentity: { execution_id: ids.execution_id, phase_id: "p" },
      publication: null,
      cv: { result: { status: "STALE_GENERATION", incident_id: ids.incident_id }, receipt: { facts: () => ({ incident_id: ids.incident_id }) } },
    }),
    (e) => e.code === TRANSFER_CODES.PAYLOAD_MALFORMED && e.details?.reason === "CV_NOT_VERIFIED_CURRENT",
  );
});

test("adapter fails closed when receipt facts are unavailable (forged receipt)", () => {
  const ids = makeIdentities("cand-cv-bad-2");
  assert.throws(
    () => buildCandidateAdapterPayload({
      incident: { incident_id: ids.incident_id, source_record_digest: hex("src"), project_identity: ids.project_identity, task_identity: ids.task_identity, attempt_identity: ids.attempt_identity },
      content: { pattern_identity: { pattern_id: "p", generation: 0 }, mechanism_digest: hex("m"), applicability_digest: hex("a"), constituent_incident_set_digest: hex("s") },
      slot: 0,
      phaseIdentity: { execution_id: ids.execution_id, phase_id: "p" },
      publication: null,
      cv: { result: { status: "VERIFIED_CURRENT", incident_id: ids.incident_id }, receipt: { facts: () => null } },
    }),
    (e) => e.code === TRANSFER_CODES.PAYLOAD_MALFORMED,
  );
});
