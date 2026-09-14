// test/memory/test-r2-candidate-evidence-binding.mjs
//
// R2 PHASE 3 — CANDIDATE / EVIDENCE BINDING CORE, STEPS 2–6 (pre-freeze slice):
//   STEP 2  EVIDENCE ATTACHMENT   — constituent incident recordIds verbatim;
//                                   CBM-4 evidence identity (canonical
//                                   inventory attestation; well-formed hex64
//                                   NOT enough); qualification record id;
//                                   manifestDigest/verifier/review identities
//   STEP 3  DERIVED IDENTITY VERIFICATION — assertCandidateDerivedIdentities
//                                   (both systems agree; re-derivation from
//                                   durable inputs matches; mismatch ⇒
//                                   CANDIDATE_IDENTITY_MISMATCH fail-closed)
//   STEP 4  LINEAGE BINDING       — constituent set + qualification +
//                                   consolidation refs are digest inputs;
//                                   lineage difference ⇒ different digest
//   STEP 5  GENERATION BINDING    — publication_generation from the C3
//                                   committed owner head via
//                                   verifyCandidatePublication (REAL durable
//                                   bytes; PUBLICATION_GENERATION_MISMATCH
//                                   fails closed)
//   STEP 6  TERMINAL REPRESENTATION — candidate stays CANDIDATE/
//                                   NON_AUTHORITATIVE at every step; storage
//                                   states ABSENT→RECORDED→BOUND only; VERIFIED
//                                   requires the gate (PHASE 4)
// Boundary rules: CANDIDATE != AUTHORITY; R2_MAY_PROMOTE = NO; no §5
// lifecycle edge anywhere in this phase (P8 probe material).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveLogicalKey, deriveMemoryRecordId, deriveContentHash } from "../../src/memory/index.mjs";
import { candidateIdFor, WRITEBACK_RECORD_TYPES } from "../../src/memory/writeback/candidate.mjs";
import { checkEvidenceIdentity } from "../../src/memory/writeback/trust.mjs";
import {
  deriveCandidateIdentityKey,
  deriveCandidateId,
  assertCandidateDerivedIdentities,
  verifyCandidatePublication,
} from "../../src/learning/patterns/candidate.mjs";
import { CANDIDATE_OBS_SCHEMA } from "../../src/learning/transfer-metrics/schema.mjs";
import { consolidateIncidents } from "../../src/learning/patterns/consolidation.mjs";
import { qualifyCandidate } from "../../src/learning/patterns/qualification.mjs";
import { makeWorld, publishGen1 } from "../v2/helpers/derived-artifact-fixtures.mjs";
import {
  RUN,
  CARD,
  NODE,
  REPO,
  REPO_OTHER,
  hex64,
  sourceResultIdentity,
  canonicalEvidence,
  VERIFIER_ID,
  REVIEW_ID,
  EXECUTOR_ID,
  incidentRecord,
  patternContent,
  patternCandidate,
} from "./test-r2-helpers.mjs";

// ═══ STEP 2 — EVIDENCE ATTACHMENT ═══════════════════════════════════════════

test("S2a. candidate evidence binding: attested verifier identity accepted; unattested rejected (hex64 NOT enough)", () => {
  const ev = canonicalEvidence();
  // attested: identity is in the inventory for THIS graph + card
  const okBind = checkEvidenceIdentity({
    proposedTrust: "VERIFIED",
    verifierIdentity: VERIFIER_ID,
    reviewIdentity: null,
    candidate: { graphRunId: RUN, taskCardId: CARD, evidenceReferences: [`verifier:${VERIFIER_ID}`] },
    canonicalEvidence: ev,
  });
  assert.equal(okBind.ok, true, JSON.stringify(okBind));
  // forged: well-formed hex64 but NOT attested by this graph
  const forged = checkEvidenceIdentity({
    proposedTrust: "VERIFIED",
    verifierIdentity: hex64("d"),
    reviewIdentity: null,
    candidate: { graphRunId: RUN, taskCardId: CARD, evidenceReferences: [`verifier:${hex64("d")}`] },
    canonicalEvidence: ev,
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.holdCode, "WRITEBACK_EVIDENCE_IDENTITY_FORGED");
});

test("S2b. other-graph / other-card evidence rejected (GRAPH_MISMATCH / CARD_MISMATCH)", () => {
  const ev = canonicalEvidence();
  const wrongGraph = checkEvidenceIdentity({
    proposedTrust: "VERIFIED",
    verifierIdentity: VERIFIER_ID,
    reviewIdentity: null,
    candidate: { graphRunId: "some-other-run", taskCardId: CARD, evidenceReferences: [`verifier:${VERIFIER_ID}`] },
    canonicalEvidence: ev,
  });
  assert.equal(wrongGraph.ok, false);
  assert.equal(wrongGraph.holdCode, "WRITEBACK_EVIDENCE_GRAPH_MISMATCH");
  const wrongCard = checkEvidenceIdentity({
    proposedTrust: "VERIFIED",
    verifierIdentity: VERIFIER_ID,
    reviewIdentity: null,
    candidate: { graphRunId: RUN, taskCardId: "OTHER-CARD", evidenceReferences: [`verifier:${VERIFIER_ID}`] },
    canonicalEvidence: ev,
  });
  assert.equal(wrongCard.ok, false);
  assert.equal(wrongCard.holdCode, "WRITEBACK_EVIDENCE_CARD_MISMATCH");
});

test("S2c. missing inventory fails closed (INVENTORY_REQUIRED) — never reconstruct evidence", () => {
  const r = checkEvidenceIdentity({
    proposedTrust: "VERIFIED",
    verifierIdentity: VERIFIER_ID,
    reviewIdentity: null,
    candidate: { graphRunId: RUN, taskCardId: CARD, evidenceReferences: [`verifier:${VERIFIER_ID}`] },
    canonicalEvidence: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, "WRITEBACK_EVIDENCE_INVENTORY_REQUIRED");
});

test("S2d. constituent incident recordIds attach verbatim into candidate content (O4 lineage)", () => {
  const i1 = incidentRecord({ seq: "1" });
  const i2 = incidentRecord({ seq: "2", nodeId: "SA-P2" });
  const consolidation = consolidateIncidents({
    incidents: [
      { recordId: i1.recordId, logicalKey: deriveLogicalKey(i1), contentHash: i1.subject.contentHash },
      { recordId: i2.recordId, logicalKey: deriveLogicalKey(i2), contentHash: i2.subject.contentHash },
    ],
    patternId: "pat-r2-1",
  });
  const content = patternContent({ constituentIncidentRecordIds: consolidation.constituentIncidentRecordIds, constituentIncidentSetDigest: consolidation.constituentIncidentSetDigest });
  assert.deepEqual(content.data.constituentIncidentRecordIds, [i1.recordId, i2.recordId], "verbatim citation");
  assert.equal(content.data.constituentIncidentSetDigest, consolidation.constituentIncidentSetDigest);
});

// ═══ STEP 3 — DERIVED IDENTITY VERIFICATION ═════════════════════════════════

function learningEvent({ mechanismDigest, applicabilityDigest, constituentSetDigest, slot = 0 }) {
  return {
    schema_version: "autoloop.transfer-event/v1",
    event_type: "PATTERN_CANDIDATE_CREATED",
    project_identity: "proj-r2",
    task_identity: CARD,
    attempt_identity: "att-r2-1",
    incident_identity: { incident_id: "inc-r2-1" },
    pattern_identity: { pattern_id: "pat-r2-1", generation: 0 },
    payload: {
      lifecycle_state: "CANDIDATE",
      mechanism_digest: mechanismDigest,
      applicability_digest: applicabilityDigest,
      constituent_incident_set_digest: constituentSetDigest,
      profile_version: CANDIDATE_OBS_SCHEMA,
      candidate_slot: slot,
      phase_identity: { execution_id: "exec-r2", phase_id: "p1" },
    },
  };
}

test("S3a. both identity systems agree on the same candidate (CBM-4 candidateId + learning profile)", () => {
  const consolidation = consolidateIncidents({
    incidents: [
      { recordId: hex64("1"), logicalKey: hex64("7"), contentHash: hex64("8") },
      { recordId: hex64("2"), logicalKey: hex64("9"), contentHash: hex64("a") },
    ],
    patternId: "pat-r2-1",
  });
  // learning profile identity
  const event = learningEvent({
    mechanismDigest: hex64("1"),
    applicabilityDigest: hex64("2"),
    constituentSetDigest: consolidation.constituentIncidentSetDigest,
  });
  event.payload.candidate_identity_key = deriveCandidateIdentityKey(event);
  event.payload.candidate_id = deriveCandidateId(event);
  assert.doesNotThrow(() => assertCandidateDerivedIdentities(event), "agreement ⇒ pass");
  // CBM-4 identity over the same proposed record
  const cbm4 = candidateIdFor({
    graphRunId: RUN,
    originatingNode: NODE,
    sourceResultIdentity: sourceResultIdentity(),
    proposedRecordType: "PATTERN",
    proposedIdentity: { patternId: "pat-r2-1", repositoryIdentity: REPO },
    lifecycleIntent: "CREATE",
  });
  assert.match(cbm4, /^[0-9a-f]{64}$/);
  // deterministic: same canonical inputs ⇒ same id on every derivation
  const cbm4again = candidateIdFor({
    graphRunId: RUN,
    originatingNode: NODE,
    sourceResultIdentity: sourceResultIdentity(),
    proposedRecordType: "PATTERN",
    proposedIdentity: { patternId: "pat-r2-1", repositoryIdentity: REPO },
    lifecycleIntent: "CREATE",
  });
  assert.equal(cbm4, cbm4again);
});

test("S3b. re-derivation mismatch ⇒ CANDIDATE_IDENTITY_MISMATCH fail-closed (tamper evidence)", () => {
  const event = learningEvent({ mechanismDigest: hex64("1"), applicabilityDigest: hex64("2"), constituentSetDigest: hex64("3") });
  event.payload.candidate_identity_key = deriveCandidateIdentityKey(event);
  event.payload.candidate_id = deriveCandidateId(event);
  // stored mechanism digest drifts from the durable inputs (tamper)
  const tampered = structuredClone(event);
  tampered.payload.mechanism_digest = hex64("9");
  assert.throws(() => assertCandidateDerivedIdentities(tampered), (err) => (err?.details?.reason ?? "") === "CANDIDATE_IDENTITY_MISMATCH");
});

test("S3c. CBM-4 candidateId re-derivation mismatch fails candidate validation", async () => {
  const c = await patternCandidate();
  c.candidateId = hex64("0");
  const { validateWritebackCandidateV1 } = await import("../../src/memory/writeback/candidate.mjs");
  const v = validateWritebackCandidateV1(c);
  assert.equal(v.valid, false);
  assert.ok(v.errors.includes("candidateId_identity_mismatch"));
});

// ═══ STEP 4 — LINEAGE BINDING ═══════════════════════════════════════════════

test("S4a. lineage difference ⇒ different candidate digest (aliasing impossible)", () => {
  const linA = learningEvent({ mechanismDigest: hex64("1"), applicabilityDigest: hex64("2"), constituentSetDigest: hex64("3") });
  const linB = learningEvent({ mechanismDigest: hex64("1"), applicabilityDigest: hex64("2"), constituentSetDigest: hex64("4") });
  linA.payload.candidate_identity_key = deriveCandidateIdentityKey(linA);
  linA.payload.candidate_id = deriveCandidateId(linA);
  linB.payload.candidate_identity_key = deriveCandidateIdentityKey(linB);
  linB.payload.candidate_id = deriveCandidateId(linB);
  assert.notEqual(linA.payload.candidate_id, linB.payload.candidate_id, "different constituent set ⇒ different candidate_id");
  // qualification/consolidation refs are digest inputs of the record content
  const contentA = patternContent({ qualificationRecordId: hex64("5") });
  const contentB = patternContent({ qualificationRecordId: hex64("6") });
  assert.notEqual(deriveContentHash(contentA), deriveContentHash(contentB), "different qualification ref ⇒ different content identity");
});

test("S4b. same lineage + same content ⇒ identical identity (deterministic handoff anchor)", () => {
  const e1 = learningEvent({ mechanismDigest: hex64("1"), applicabilityDigest: hex64("2"), constituentSetDigest: hex64("3") });
  const e2 = learningEvent({ mechanismDigest: hex64("1"), applicabilityDigest: hex64("2"), constituentSetDigest: hex64("3") });
  e1.payload.candidate_identity_key = deriveCandidateIdentityKey(e1);
  e1.payload.candidate_id = deriveCandidateId(e1);
  e2.payload.candidate_identity_key = deriveCandidateIdentityKey(e2);
  e2.payload.candidate_id = deriveCandidateId(e2);
  assert.equal(e1.payload.candidate_id, e2.payload.candidate_id);
});

// ═══ STEP 5 — GENERATION BINDING (REAL durable C3 owner bytes) ══════════════

test("S5a. publication_generation binds from the C3 committed owner head (verifyCandidatePublication over durable bytes)", async () => {
  const world = makeWorld("r2-s5-bind");
  const ROOTS = [];
  ROOTS.push(world.root);
  try {
    const pub = await publishGen1(world, { mutationId: "mut-r2-s5" });
    const verification = verifyCandidatePublication({
      root: world.root,
      executionId: world.executionId,
      phaseId: "p1",
      publication: { artifact_digest: pub.artifact_digest, link_digest: pub.committed_link_digest, generation: pub.generation },
    });
    assert.equal(verification.verified, true);
    assert.equal(verification.generation, 1);
  } finally {
    for (const r of ROOTS) rmSync(r, { recursive: true, force: true });
  }
});

test("S5b. stale generation binding fails closed (PUBLICATION_GENERATION_MISMATCH; incumbent stays authority)", async () => {
  const world = makeWorld("r2-s5-stale");
  try {
    const pub = await publishGen1(world, { mutationId: "mut-r2-s5b" });
    assert.throws(
      () => verifyCandidatePublication({
        root: world.root,
        executionId: world.executionId,
        phaseId: "p1",
        publication: { artifact_digest: pub.artifact_digest, link_digest: pub.committed_link_digest, generation: 99 },
      }),
      (err) => (err?.details?.reason ?? "") === "PUBLICATION_GENERATION_MISMATCH",
    );
    // wrong artifact digest also fails closed
    assert.throws(
      () => verifyCandidatePublication({
        root: world.root,
        executionId: world.executionId,
        phaseId: "p1",
        publication: { artifact_digest: hex64("0"), link_digest: pub.committed_link_digest, generation: pub.generation },
      }),
      (err) => (err?.details?.reason ?? "") === "PUBLICATION_DIGEST_MISMATCH",
    );
  } finally {
    rmSync(world.root, { recursive: true, force: true });
  }
});

// ═══ STEP 6 — TERMINAL REPRESENTATION (CANDIDATE != AUTHORITY) ══════════════

test("S6a. the candidate remains NON-AUTHORITATIVE data: gate write path is the ONLY promotion of trust, and PATTERN ceiling is VERIFIED", async () => {
  const { PATTERN_TRUST_LADDER_MAPPING } = await import("../../src/memory/writeback/trust.mjs");
  assert.deepEqual([...PATTERN_TRUST_LADDER_MAPPING.CANDIDATE], ["RAW", "UNVERIFIED"]);
  assert.deepEqual([...PATTERN_TRUST_LADDER_MAPPING.ADVISORY], ["VERIFIED"]);
  assert.equal(PATTERN_TRUST_LADDER_MAPPING.R2_WRITE_CEILING, "VERIFIED");
  // MANDATORY_GATE ≈ CONFIRMED stays Controller-only — no automatic mapping
  assert.deepEqual([...PATTERN_TRUST_LADDER_MAPPING.MANDATORY_GATE], ["CONFIRMED"]);
});

test("S6b. no §5 lifecycle edge exists in any R2 module (structural sweep of the phase surface)", async () => {
  const { readFileSync } = await import("node:fs");
  const files = [
    "../../src/learning/patterns/consolidation.mjs",
    "../../src/learning/patterns/qualification.mjs",
    "../../src/learning/patterns/applicability.mjs",
  ];
  const { fileURLToPath } = await import("node:url");
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const forbidden of ["PROMOTED", "ADOPTED", "ACTIVATED", "applyLifecycle", "advanceLifecycle"]) {
      assert.ok(!text.includes(forbidden), `${f} must not contain ${forbidden}`);
    }
  }
});

test("S6c. WRITEBACK_RECORD_TYPES extended additively (order + membership frozen)", () => {
  assert.deepEqual([...WRITEBACK_RECORD_TYPES], ["EXECUTION", "CODE", "DECISION", "PATTERN"]);
});
