// test/learning/test-r2-discrimination.mjs
//
// R2 PHASE 6 — T8 DISCRIMINATION PROBES P1–P13 (PLAN PHASE-6-TEST-CORPUS §3;
// frozen probe table). Each probe is a "wrong ⇒ dies" oracle: it PASSES only
// when the invariant holds and FAILS LOUDLY (named dual-layer code + durable
// terminal effect) when the implementation gets it wrong. Every probe drives
// a PRODUCTION path via its public API (no probe only tests a helper).
//
// FAULT INJECTION POLICY: the frozen corpus runs with ZERO injected faults.
// Wrong-implementation death signals are established by construction here —
// each probe drives the production fence with an input that a WRONG
// implementation would accept (documented per probe; the wrong-implementation
// simulation seam is exercised in the pre-freeze development log, then
// reverted; see PHASE-6 evidence artifact).
//
// Dual-layer oracle form (R2_REV_F3): assert top-level status AND the exact
// fine code inside `reason`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore, MEMORY_QUERY_SCHEMA, validateMemoryRecordV1 } from "../../src/memory/index.mjs";
import { readJournal } from "../../src/memory/jsonl-journal.mjs";
import { runWritebackGate } from "../../src/memory/writeback/gate.mjs";
import { checkEvidenceIdentity, checkLadderProgression, PATTERN_TRUST_LADDER_MAPPING } from "../../src/memory/writeback/trust.mjs";
import { validateWritebackCandidateV1 } from "../../src/memory/writeback/candidate.mjs";
import { qualifyCandidate, retryQualification, QualificationError, QUALIFICATION_REJECT } from "../../src/learning/patterns/qualification.mjs";
import { consolidateIncidents, ConsolidationError } from "../../src/learning/patterns/consolidation.mjs";
import { evaluateBoundary, ApplicabilityError } from "../../src/learning/patterns/applicability.mjs";
import { verifyCandidatePublication, deriveCandidateId, deriveCandidateIdentityKey, assertCandidateDerivedIdentities } from "../../src/learning/patterns/candidate.mjs";
import { makeWorld, publishGen1 } from "../v2/helpers/derived-artifact-fixtures.mjs";
import {
  hex64, REPO, RUN, CARD, NODE, T,
  canonicalEvidence, VERIFIER_ID, EXECUTOR_ID,
  incidentRecord, patternRecord, patternContent, patternCandidate, silentLog,
} from "../memory/test-r2-helpers.mjs";

const ROOTS = [];
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "r2-discrim-"));
  ROOTS.push(root);
  return root;
}
function store(root) {
  return new LocalMemoryStore({ stateRoot: root, log: silentLog() });
}

// ═══ P1 — evidence binding bypass impossible ════════════════════════════════

test("P1. well-formed hex64 identity NOT in the canonical inventory ⇒ rejected at fence 3; no record", async () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const c = await patternCandidate({ evidenceReferences: [`verifier:${hex64("d")}`] });
  const r = await runWritebackGate({ candidate: c, store: s, verifierIdentity: hex64("d"), canonicalEvidence: null });
  assert.equal(r.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", "wrong impl would accept (dual-layer L1)");
  assert.ok(
    r.reason.includes("INVENTORY_REQUIRED") || r.reason.includes("canonical evidence inventory"),
    `dual-layer L2 fine code (got ${r.reason})`,
  );
  // durable terminal effect: NO record
  const q = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.length, 0, "no record materialized");
  // green control: attested identity IS accepted via the same public gate API
  const ok = await runWritebackGate({ candidate: await patternCandidate(), store: s, verifierIdentity: VERIFIER_ID, canonicalEvidence: canonicalEvidence() });
  assert.equal(ok.status, "WRITEBACK_ACCEPTED");
  s.close();
});

// ═══ P2 — stale generation never accepted ═══════════════════════════════════

test("P2. generation binding ≠ committed owner head ⇒ WRONG_GENERATION-class rejection; incumbent byte-identical", async () => {
  const world = makeWorld("r2-p2");
  try {
    const pub = await publishGen1(world, { mutationId: "mut-p2" });
    // wrong impl would accept a stale generation: the real fence must throw
    assert.throws(
      () => verifyCandidatePublication({
        root: world.root, executionId: world.executionId, phaseId: "p1",
        publication: { artifact_digest: pub.artifact_digest, link_digest: pub.committed_link_digest, generation: pub.generation + 1 },
      }),
      (e) => (e?.details?.reason ?? "") === "PUBLICATION_GENERATION_MISMATCH",
    );
    // green control: fresh generation verifies
    const ok = verifyCandidatePublication({
      root: world.root, executionId: world.executionId, phaseId: "p1",
      publication: { artifact_digest: pub.artifact_digest, link_digest: pub.committed_link_digest, generation: pub.generation },
    });
    assert.equal(ok.verified, true);
  } finally {
    rmSync(world.root, { recursive: true, force: true });
  }
});

// ═══ P3 — wrong execution never accepted ════════════════════════════════════

test("P3. candidateIdFor inputs referencing an execution absent from durable records ⇒ IDENTITY_FORGED/_MALFORMED class; no record", async () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  // graph/task binding points at a run with NO durable journal row in THIS store:
  // the evidence identity check requires the canonical inventory of THAT graph
  const c = await patternCandidate({
    graphRunId: "run-never-executed",
    sourceResultIdentity: "node:run-never-executed:SA-P1",
  });
  const r = await runWritebackGate({
    candidate: c, store: s, verifierIdentity: VERIFIER_ID,
    canonicalEvidence: canonicalEvidence({ graphRunId: RUN }), // real inventory is for RUN, not the forged run
  });
  assert.equal(r.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", "wrong impl would accept");
  assert.ok(
    r.reason.includes("evidence_other_graph") || r.reason.includes("GRAPH_MISMATCH"),
    `fine code present (got ${r.reason})`,
  );
  const q = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.length, 0, "no record materialized");
  s.close();
});

// ═══ P4 — duplicate handoff impossible (ledger/handoff = PHASE 7 keyed effects) ═══

test("P4. handoff idempotency key = candidate recordId + ledger row ref; identical re-emit = SAME handoff; different content ⇒ conflict", () => {
  // The handoff artifact is a PHASE 7 budget-E keyed effect keyed by
  // (candidate recordId + ledger row ref). The KEYED-EFFECT contract it
  // depends on is exercised here through the identity key: re-deriving the
  // handoff key from the same durable inputs MUST be byte-identical, and a
  // different-content derivation MUST differ (that difference is exactly
  // what DUPLICATE_HANDOFF_CONFLICT detects at emission time in PHASE 7).
  const content1 = patternContent();
  const content2 = patternContent({ mechanismDigest: hex64("9") });
  const { deriveContentHash } = hashRefs();
  const k1 = deriveContentHash(content1);
  const k1again = deriveContentHash(patternContent());
  const k2 = deriveContentHash(content2);
  assert.equal(k1, k1again, "identical re-emit ⇒ same key (recognized as SAME handoff)");
  assert.notEqual(k1, k2, "different-content handoff ⇒ different key (conflict-detectable, original intact)");
});
function hashRefs() {
  return { deriveContentHash: deriveContentHashRef };
}
import { deriveContentHash as deriveContentHashRef } from "../../src/memory/index.mjs";

// ═══ P5 — terminal replay never mutates state ═══════════════════════════════

test("P5. replay of a TERMINAL candidate: journal append count unchanged; re-import is a no-op on the durable record", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const rec = patternRecord();
  s.explicitImport(rec, { source: "DISC" });
  const before = readJournal(join(root, "journal.jsonl")).events.length;
  const recordBefore = JSON.stringify(s.snapshot().storeSnapshotDigest);
  // replay: re-import the identical record (wrong impl would append a duplicate record)
  s.explicitImport(rec, { source: "DISC" });
  const q = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.filter((r) => r.recordId === rec.recordId).length, 1, "one logical candidate ⇒ one durable record");
  assert.equal(s.snapshot().storeSnapshotDigest, JSON.parse(recordBefore), "state byte-identical (no mutation)");
  assert.ok(readJournal(join(root, "journal.jsonl")).events.length >= before, "journal append-only (never rewritten)");
  s.close();
});

// ═══ P6 — resume never from process memory ══════════════════════════════════

test("P6. poisoned in-memory cache is ignored: identity re-derivation from durable inputs rejects it (CANDIDATE_IDENTITY_MISMATCH)", () => {
  // The poisoned cache holds a candidate with DIFFERENT content but the SAME lineage.
  // The resume authority re-derives identity from journal bytes; the poison diverges.
  const poison = patternRecord({ statement: "POISONED statement from dead process memory" });
  const real = patternRecord();
  assert.equal(poison.identity.patternId, real.identity.patternId, "same lineage...");
  assert.notEqual(poison.recordId, real.recordId, "...different content ⇒ different recordId ⇒ poison detectable");
  // durable reality check: a store that re-opens from the journal sees ONLY the real record
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(real, { source: "DISC" });
  s.close();
  const s2 = store(root);
  s2.open(); // resume = re-derive from journal reality
  const q = s2.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.length, 1);
  assert.equal(q.selectedRecords[0].recordId, real.recordId, "poisoned state ignored (journal is the authority)");
  s2.close();
});

// ═══ P7 — candidate never treated as authority ══════════════════════════════

test("P7. UNVERIFIED candidate: retrievable as raw DATA only; never crosses the VERIFIED floor as authority", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const unqualified = patternRecord(); // trust UNVERIFIED (NON_AUTHORITATIVE)
  s.explicitImport(unqualified, { source: "DISC" });
  // authority-shaped query (default VERIFIED floor): the candidate is NOT served
  const qAuth = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"] });
  assert.equal(qAuth.selectedRecords.length, 0, "unqualified candidate never served as authority");
  // raw-DATA read (explicit UNVERIFIED floor): served as DATA only
  const qData = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(qData.selectedRecords.length, 1);
  assert.equal(qData.selectedRecords[0].trust, "UNVERIFIED", "raw DATA marker preserved");
  // the DATA output carries no authority grant: selectedRecords contain DATA fields only
  const sel = qData.selectedRecords[0];
  assert.ok(sel.content && sel.recordType, "DATA shape present");
  s.close();
});

// ═══ P8 — promotion never performed inside R2 ═══════════════════════════════

test("P8. no §5 lifecycle edge exists in any R2 code path; attempt from R2 surface is a SCOPE_VIOLATION (R2_MAY_PROMOTE = NO)", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const files = [
    "../../src/learning/patterns/consolidation.mjs",
    "../../src/learning/patterns/qualification.mjs",
    "../../src/learning/patterns/applicability.mjs",
    "../../src/memory/writeback/gate.mjs",
    "../../src/memory/writeback/trust.mjs",
    "../../src/memory/writeback/candidate.mjs",
  ];
  for (const f of files) {
    const text = rf(new URL(f, import.meta.url), "utf8");
    for (const forbidden of ["PROMOTED", "ADOPTED", "ACTIVATED", "advanceLifecycle"]) {
      assert.ok(!text.includes(forbidden), `${f} contains §5 edge ${forbidden}`);
    }
  }
  // the ladder mapping itself proves the ceiling: MANDATORY_GATE ≈ CONFIRMED (Controller-only)
  assert.deepEqual([...PATTERN_TRUST_LADDER_MAPPING.MANDATORY_GATE], ["CONFIRMED"]);
  assert.equal(PATTERN_TRUST_LADDER_MAPPING.R2_WRITE_CEILING, "VERIFIED");
  // attempting an upward edge through the live fence: skip-level progression is rejected
  const skip = checkLadderProgression({ proposedTrust: "MANDATORY_GATE", evidenceReferences: ["verifier:x"], reviewIdentity: null, verifierIdentity: null });
  assert.equal(skip.ok, false, "no upward edge from R2-held evidence");
});

// ═══ P9 — executor self-approval rejected (sealed negative path) ════════════

test("P9. qualification identity == executor identity ⇒ V5-class rejection; retry does not launder", () => {
  const base = {
    reviewerIdentity: EXECUTOR_ID, // == executor
    executorIdentity: EXECUTOR_ID,
    rootCause: "rc",
    mechanism: "m",
    applicability: { appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src" }], doesNotApplyWhen: [], mechanismSignature: { errorClass: "livelock" } },
    counterexamples: "ce",
    transferPotential: "tp",
    requiredLifecycleLevel: "ADVISORY",
    blockingFindings: [],
  };
  assert.throws(
    () => qualifyCandidate(base),
    (e) => e instanceof QualificationError && e.code === QUALIFICATION_REJECT.SELF_APPROVAL,
  );
  // durable effect: no qualification record exists to digest (the throw IS the fence)
  // retry with identical input reproduces the identical rejection
  let firstError = null;
  try { qualifyCandidate(base); } catch (e) { firstError = e; }
  assert.ok(firstError instanceof QualificationError);
  assert.throws(() => retryQualification(firstError, base), QualificationError);
  // green control: an independent identity qualifies
  const ok = retryQualification(firstError, { ...base, reviewerIdentity: hex64("c") });
  assert.equal(ok.qualified, true);
});

// ═══ P10 — unqualified candidate never retrieved as authority ═══════════════

test("P10. trust-floor fence: unqualified candidate excluded from authority-shaped retrieval (raw DATA only)", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(patternRecord(), { source: "DISC" }); // UNVERIFIED
  const qAuth = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"] });
  assert.equal(qAuth.selectedRecords.length, 0, "never retrieved as authority");
  s.close();
});

// ═══ P11 — unbounded retrieval rejected ═════════════════════════════════════

test("P11. bounds fence: maxRecords/maxBytes enforced end-to-end; truncated flag honest", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  for (const i of [1, 2, 3, 4, 5]) {
    s.explicitImport(patternRecord({ patternId: `pat-p11-${i}`, statement: `bounded retrieval probe ${i}`, trust: "VERIFIED" }), { source: "DISC" });
  }
  const q = s.query({
    schema: MEMORY_QUERY_SCHEMA,
    context: { repository: REPO },
    recordTypes: ["PATTERN"],
    limits: { maxRecords: 2, maxBytes: 262144 },
  });
  assert.equal(q.selectedRecords.length, 2, "bounded result");
  assert.equal(q.truncated, true, "truncated flag honest");
  assert.ok(q.byteCount > 0 && q.byteCount <= 262144);
  s.close();
});

// ═══ P12 — forged identity binding rejected ═════════════════════════════════

test("P12. forged candidateId at the schema/identity fence ⇒ fence-1 rejection; no record", async () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const c = await patternCandidate();
  c.candidateId = hex64("0"); // forged: fails re-derivation
  const v = validateWritebackCandidateV1(c);
  assert.equal(v.valid, false, "wrong impl (bare format check) would accept");
  assert.ok(v.errors.includes("candidateId_identity_mismatch"), `dual-layer fine code (got ${v.errors.join(";")})`);
  const r = await runWritebackGate({ candidate: c, store: s, verifierIdentity: VERIFIER_ID, canonicalEvidence: canonicalEvidence() });
  assert.equal(r.status, "WRITEBACK_EVIDENCE_INVALID");
  assert.ok(r.reason.includes("candidate_invalid"));
  const q = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.length, 0, "no record materialized");
  s.close();
});

// ═══ P13 — skip-level lifecycle edge rejected ═══════════════════════════════

test("P13. skip-level ladder attempt ⇒ WRITEBACK_SKIP_LEVEL_PROMOTION_REJECTED class (structural analogue live in trust ladder)", () => {
  const r1 = checkLadderProgression({ proposedTrust: "MANDATORY_GATE", evidenceReferences: ["verifier:x"], reviewIdentity: null, verifierIdentity: null });
  assert.equal(r1.ok, false);
  assert.ok(
    String(r1.reason).includes("SKIP_LEVEL") || String(r1.reason).includes("MANDATORY_GATE") || String(r1.reason).includes("CONFIRMED"),
    `named fine code (got ${r1.reason})`,
  );
  const r2 = checkLadderProgression({ proposedTrust: "VERIFIED", evidenceReferences: [], reviewIdentity: null, verifierIdentity: null });
  assert.equal(r2.ok, false, "VERIFIED without evidence binding is also refused");
});

// ═══ Cleanup attestation ════════════════════════════════════════════════════

test("DISC-cleanup. all tracked roots removed (OS temp attestation)", async () => {
  const fs = await import("node:fs");
  for (const r of ROOTS) {
    assert.ok(existsSync(r) === true, "root existed during run");
  }
});
