// test/memory/test-writeback-candidate.mjs
//
// CBM-4 Stage 2 — write-back candidate contract: deterministic identity,
// allowlist validation, CONFIRMED never an automatic intent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWritebackCandidate, validateWritebackCandidateV1, candidateIdFor, WRITEBACK_CANDIDATE_SCHEMA } from "../../src/memory/writeback/candidate.mjs";

const REPO = "1".repeat(64);
const TREE = "5".repeat(40);
const RUN = "cbm4-test-run-1";

function baseCandidate(o = {}) {
  return createWritebackCandidate({
    graphRunId: RUN,
    taskCardId: "AUTOLOOP-PI-GRAPH-CBM4-1",
    originatingNode: "SA-W1",
    sourceResultIdentity: "node:cbm4-test-run-1:SA-W1",
    proposedRecordType: "EXECUTION",
    proposedIdentity: { repositoryIdentity: REPO, treeSha: TREE, resultStatus: "PASS" },
    proposedSubjectStatement: "graph cbm4-test-run-1 final PASS (closeout PASS)",
    proposedContent: { kind: "TEXT", text: "graph cbm4-test-run-1 final PASS" },
    proposedScope: { repository: REPO, graphRun: RUN },
    evidenceReferences: ["manifest:abc", "review:def"],
    proposedTrust: "REVIEWED",
    proposedRelationships: [],
    lifecycleIntent: "CREATE",
    origin: "independent_reviewer",
    ...o,
  });
}

test("1. candidate identity is deterministic and independent of timestamps/order", () => {
  const c1 = baseCandidate();
  const c2 = baseCandidate();
  assert.equal(c1.candidateId, c2.candidateId, "same canonical source -> same id");
  // identical semantics regardless of field insertion order
  const c3 = createWritebackCandidate({
    origin: "independent_reviewer",
    lifecycleIntent: "CREATE",
    proposedRelationships: [],
    proposedTrust: "REVIEWED",
    evidenceReferences: ["manifest:abc", "review:def"],
    proposedScope: { graphRun: RUN, repository: REPO },
    proposedContent: { text: "graph cbm4-test-run-1 final PASS", kind: "TEXT" },
    proposedSubjectStatement: "graph cbm4-test-run-1 final PASS (closeout PASS)",
    proposedIdentity: { resultStatus: "PASS", treeSha: TREE, repositoryIdentity: REPO },
    proposedRecordType: "EXECUTION",
    sourceResultIdentity: "node:cbm4-test-run-1:SA-W1",
    originatingNode: "SA-W1",
    taskCardId: "AUTOLOOP-PI-GRAPH-CBM4-1",
    graphRunId: RUN,
  });
  assert.equal(c3.candidateId, c1.candidateId, "order-independent");
  assert.match(c1.candidateId, /^[0-9a-f]{64}$/);
  // explicit formula matches
  assert.equal(candidateIdFor({ graphRunId: RUN, originatingNode: "SA-W1", sourceResultIdentity: "node:cbm4-test-run-1:SA-W1", proposedRecordType: "EXECUTION", proposedIdentity: { repositoryIdentity: REPO, treeSha: TREE, resultStatus: "PASS" }, lifecycleIntent: "CREATE" }), c1.candidateId);
});

test("2. candidate schema + version validated; unknown fields fail closed", () => {
  const c = baseCandidate();
  assert.equal(validateWritebackCandidateV1(c).valid, true);
  c.unknownField = "x";
  assert.equal(validateWritebackCandidateV1(c).valid, false);
  c.schema = "wrong";
  assert.equal(validateWritebackCandidateV1(c).valid, false);
});

test("3. candidateId mismatch (tampered identity) fails validation", () => {
  const c = baseCandidate();
  c.candidateId = "f".repeat(64);
  const v = validateWritebackCandidateV1(c);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("candidateId_identity_mismatch")));
});

test("4. CONFIRMED is never an automatic write-back intent", () => {
  assert.throws(() => baseCandidate({ proposedTrust: "CONFIRMED" }), (e) => e.name === "WritebackCandidateError");
});

test("5. required bindings enforced（graphRunId / evidence / identity / scope）", () => {
  assert.throws(() => baseCandidate({ graphRunId: null }));
  assert.throws(() => baseCandidate({ evidenceReferences: [] }));
  assert.throws(() => baseCandidate({ proposedIdentity: null }));
  assert.throws(() => baseCandidate({ proposedScope: null }));
  assert.throws(() => baseCandidate({ origin: "mystery-agent" }));
  assert.throws(() => baseCandidate({ proposedRecordType: "MAGIC" }));
});

test("6. lifecycle intents enum enforced", () => {
  const c = baseCandidate({ lifecycleIntent: "SUPERSEDE" });
  assert.equal(validateWritebackCandidateV1(c).valid, true);
  assert.throws(() => baseCandidate({ lifecycleIntent: "MERGE" }), (e) => e.name === "WritebackCandidateError");
});
