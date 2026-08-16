// test/memory/test-writeback-gate.mjs
//
// CBM-4 Stages 5-8 + 12: the governed write-back gate — acceptance,
// idempotency, crash/rebuild safety, conflict surfacing, supersede/invalidate
// lifecycle, staleness, security, scope isolation.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore } from "../../src/memory/index.mjs";
import { createWritebackCandidate } from "../../src/memory/writeback/candidate.mjs";
import { runWritebackGate, findCurrentByLogicalKey, markStaleIfBaselineBroken } from "../../src/memory/writeback/gate.mjs";
import { deriveLogicalKey } from "../../src/memory/identity.mjs";

const ROOTS = [];
function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), "cbm4-gate-"));
  ROOTS.push(r);
  return r;
}
const silent = { info() {}, warn() {}, error() {} };
const REPO = "1".repeat(64);
const REPO_OTHER = "2".repeat(64);
const TREE = "5".repeat(40);
const TREE_OTHER = "6".repeat(40);
const RUN = "cbm4-gate-run";
const REVIEW_ID = "c".repeat(64);
const VERIFIER_ID = "b".repeat(64);

// Canonical evidence inventory for this graph/task（derived in production from
// the FINAL graph result; here stated explicitly）. Only these identities are
// attested — anything well-formed but absent is FORGED and must fail closed.
function canonicalEvidence(o = {}) {
  return {
    graphRunId: RUN,
    taskCardIds: ["AUTOLOOP-PI-GRAPH-CBM4-1", "graph-closeout"],
    resultIdentities: [VERIFIER_ID, REVIEW_ID],
    verifierIdentities: [VERIFIER_ID],
    reviewIdentities: [REVIEW_ID],
    ...o,
  };
}

before(() => {});
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function openStore() {
  const s = new LocalMemoryStore({ stateRoot: freshRoot(), log: silent });
  s.open();
  return s;
}

function candidate(o = {}) {
  return createWritebackCandidate({
    graphRunId: RUN,
    taskCardId: "AUTOLOOP-PI-GRAPH-CBM4-1",
    originatingNode: "SA-W1",
    sourceResultIdentity: `node:${RUN}:SA-W1`,
    proposedRecordType: "EXECUTION",
    proposedIdentity: { repositoryIdentity: REPO, treeSha: TREE, resultStatus: "PASS" },
    proposedSubjectStatement: `graph ${RUN} final PASS`,
    proposedContent: { kind: "TEXT", text: `graph ${RUN} final PASS` },
    proposedScope: { repository: REPO, graphRun: RUN },
    evidenceReferences: ["manifest:" + "a".repeat(64)],
    proposedTrust: "UNVERIFIED",
    proposedRelationships: [],
    lifecycleIntent: "CREATE",
    origin: "graph_closeout",
    ...o,
  });
}

test("G1. clean CREATE -> WRITEBACK_ACCEPTED; record stored and retrievable", async () => {
  const s = openStore();
  const r = await runWritebackGate({ candidate: candidate(), store: s, expectedRepository: REPO });
  assert.equal(r.status, "WRITEBACK_ACCEPTED", JSON.stringify(r));
  assert.match(r.recordId, /^[0-9a-f]{64}$/);
  const got = s.get(r.recordId);
  assert.equal(got.recordId, r.recordId);
  assert.equal(got.trust, "UNVERIFIED");
  assert.equal(got.validity.status, "CURRENT");
  assert.equal(s.verifyJournalParity().ok, true);
  s.close();
});

test("G2. idempotency: retry after success -> WRITEBACK_DUPLICATE; no duplicate record", async () => {
  const s = openStore();
  const r1 = await runWritebackGate({ candidate: candidate(), store: s, expectedRepository: REPO });
  assert.equal(r1.status, "WRITEBACK_ACCEPTED");
  const r2 = await runWritebackGate({ candidate: candidate(), store: s, expectedRepository: REPO });
  assert.equal(r2.status, "WRITEBACK_DUPLICATE", JSON.stringify(r2));
  assert.equal(r2.recordId, r1.recordId, "same record identity");
  const lk = deriveLogicalKey(s.get(r1.recordId));
  assert.equal(findCurrentByLogicalKey(s, lk).length, 1, "exactly one CURRENT record");
  s.close();
});

test("G3. crash/rebuild safety: journal-first durability; rebuild keeps the record; retry after rebuild -> DUPLICATE", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const r = await runWritebackGate({ candidate: candidate(), store: s, expectedRepository: REPO });
  assert.equal(r.status, "WRITEBACK_ACCEPTED");
  s.close();
  // simulate crash: sqlite gone, journal intact -> lossless rebuild
  for (const f of ["memory.db", "memory.db-wal", "memory.db-shm"]) {
    const p = join(root, f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  const s2 = new LocalMemoryStore({ stateRoot: root, log: silent });
  s2.open();
  assert.equal(s2.verifyJournalParity().ok, true, "parity ok after sqlite loss");
  assert.ok(s2.get(r.recordId), "record losslessly rebuilt from journal");
  const dup = await runWritebackGate({ candidate: candidate(), store: s2, expectedRepository: REPO });
  assert.equal(dup.status, "WRITEBACK_DUPLICATE", "retry after rebuild is idempotent");
  s2.close();
});

test("G4. crash BEFORE journal append: nothing persisted（no partial write）", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  // secret-bearing candidate is rejected BEFORE journal append -> no partial state
  const bad = candidate({ proposedContent: { kind: "TEXT", text: "password=sk-abcdefghijklmnopqrstuvwxyz0123456789" } });
  const r = await runWritebackGate({ candidate: bad, store: s, expectedRepository: REPO });
  assert.equal(r.status, "WRITEBACK_REJECTED", JSON.stringify(r));
  assert.ok(String(r.reason).includes("secret"), "secret rejected before append");
  if (existsSync(join(root, "journal.jsonl"))) {
    const journal = readFileSync(join(root, "journal.jsonl"), "utf8");
    assert.ok(!journal.includes("sk-abcdefghijklmnopqrstuvwxyz"), "secret never reached the journal");
  } else {
    assert.ok(true, "journal not even created — nothing was appended");
  }
  assert.equal(findCurrentByLogicalKey(s, deriveLogicalKey({ schema: "autoloop.memory-record/v1", recordType: "EXECUTION", identity: {}, scope: {} })).length, 0);
  s.close();
});

test("G5. writer self-promote -> AUTHORITY_INSUFFICIENT", async () => {
  const s = openStore();
  const r = await runWritebackGate({ candidate: candidate({ origin: "writer", proposedTrust: "VERIFIED" }), store: s, expectedRepository: REPO });
  assert.equal(r.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", JSON.stringify(r));
  assert.ok(String(r.reason).includes("self_promotion"));
  s.close();
});

test("G6. missing evidence is rejected（contract）; fake verifier/reviewer identity -> AUTHORITY_INSUFFICIENT", async () => {
  const s = openStore();
  // a candidate without evidence references is rejected at creation（the
  // contract requires evidence binding before the gate is even reached）
  assert.throws(() => createWritebackCandidate({ graphRunId: RUN, taskCardId: "AUTOLOOP-PI-GRAPH-CBM4-1", originatingNode: "SA-W1", sourceResultIdentity: "x", proposedRecordType: "EXECUTION", proposedIdentity: { repositoryIdentity: REPO }, proposedSubjectStatement: "s", proposedScope: { repository: REPO }, evidenceReferences: [], proposedTrust: "UNVERIFIED", origin: "graph_closeout" }), (e) => e.name === "WritebackCandidateError");
  // fake verifier: VERIFIED trust without verifier-bound evidence ref
  const fakeVerifier = candidate({ proposedTrust: "VERIFIED", evidenceReferences: ["manifest:" + "a".repeat(64)] });
  const rv = await runWritebackGate({ candidate: fakeVerifier, store: s, expectedRepository: REPO });
  assert.equal(rv.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", "VERIFIED without verifier binding");
  // fake reviewer: REVIEWED without review binding
  const fakeReviewer = candidate({ proposedTrust: "REVIEWED", evidenceReferences: ["manifest:" + "a".repeat(64), "verifier:" + "b".repeat(64)] });
  const rr = await runWritebackGate({ candidate: fakeReviewer, store: s, expectedRepository: REPO, verifierIdentity: "vid" });
  assert.equal(rr.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", "REVIEWED without review binding");
  s.close();
});

test("G7. malformed / unknown-schema candidate -> EVIDENCE_INVALID", async () => {
  const s = openStore();
  const c = candidate();
  c.schema = "autoloop.unknown/v1";
  const r = await runWritebackGate({ candidate: c, store: s, expectedRepository: REPO });
  assert.equal(r.status, "WRITEBACK_EVIDENCE_INVALID", JSON.stringify(r));
  const c2 = candidate();
  c2.proposedRecordType = "MAGIC";
  const r2 = await runWritebackGate({ candidate: c2, store: s, expectedRepository: REPO });
  assert.equal(r2.status, "WRITEBACK_EVIDENCE_INVALID");
  s.close();
});

test("G8. cross-repo write-back -> REJECTED; cross-worktree scope violation -> REJECTED", async () => {
  const s = openStore();
  const cross = candidate({ proposedScope: { repository: REPO_OTHER, graphRun: RUN }, proposedIdentity: { repositoryIdentity: REPO_OTHER, treeSha: TREE, resultStatus: "PASS" } });
  const r = await runWritebackGate({ candidate: cross, store: s, expectedRepository: REPO });
  assert.equal(r.status, "WRITEBACK_REJECTED", JSON.stringify(r));
  assert.ok(String(r.reason).includes("cross_repo"));
  const wt = "3".repeat(64);
  const wtOther = "4".repeat(64);
  const wtCross = candidate({ proposedScope: { repository: REPO, graphRun: RUN, worktree: wtOther }, proposedIdentity: { repositoryIdentity: REPO, treeSha: TREE, worktreeIdentity: wt, resultStatus: "PASS" } });
  const r2 = await runWritebackGate({ candidate: wtCross, store: s, expectedRepository: REPO });
  assert.equal(r2.status, "WRITEBACK_REJECTED", JSON.stringify(r2));
  assert.ok(String(r2.reason).includes("cross_worktree"));
  s.close();
});

test("G9. conflicting CURRENT record -> WRITEBACK_CONFLICT（surfaced, never overwritten）", async () => {
  const s = openStore();
  const c1 = candidate({ proposedSubjectStatement: "fact v1", proposedContent: { kind: "TEXT", text: "fact v1" } });
  const r1 = await runWritebackGate({ candidate: c1, store: s, expectedRepository: REPO });
  assert.equal(r1.status, "WRITEBACK_ACCEPTED");
  // same logicalKey, different content -> conflict
  const c2 = candidate({ proposedSubjectStatement: "fact v2", proposedContent: { kind: "TEXT", text: "fact v2" } });
  const r2 = await runWritebackGate({ candidate: c2, store: s, expectedRepository: REPO });
  assert.equal(r2.status, "WRITEBACK_CONFLICT", JSON.stringify(r2));
  assert.ok(Array.isArray(r2.conflictWith) && r2.conflictWith.includes(r1.recordId));
  const lk = deriveLogicalKey(s.get(r1.recordId));
  assert.equal(findCurrentByLogicalKey(s, lk).length, 1, "old record untouched");
  s.close();
});

test("G10. SUPERSEDE with evidence binding -> ACCEPTED; old record SUPERSEDED + relationship", async () => {
  const s = openStore();
  const c1 = candidate({ proposedSubjectStatement: "old fact", proposedContent: { kind: "TEXT", text: "old fact" } });
  const r1 = await runWritebackGate({ candidate: c1, store: s, expectedRepository: REPO });
  assert.equal(r1.status, "WRITEBACK_ACCEPTED");
  const sup = candidate({
    proposedSubjectStatement: "new fact (supersedes old)",
    proposedContent: { kind: "TEXT", text: "new fact" },
    lifecycleIntent: "SUPERSEDE",
    proposedRelationships: [{ relationshipType: "SUPERSEDES", targetRecordId: r1.recordId }],
  });
  const r2 = await runWritebackGate({ candidate: sup, store: s, expectedRepository: REPO });
  assert.equal(r2.status, "WRITEBACK_ACCEPTED", JSON.stringify(r2));
  assert.equal(r2.supersedes, r1.recordId);
  assert.equal(s.get(r1.recordId).validity.status, "INVALIDATED", "superseded record is no longer current truth");
  const rels = s.db.prepare("SELECT * FROM memory_relationships WHERE relationship_type='SUPERSEDES'").all();
  assert.equal(rels.length, 1);
  assert.equal(rels[0].target_record_id, r1.recordId);
  const hist = s.db.prepare("SELECT event_type FROM memory_lifecycle_events WHERE record_id = ?").all(r1.recordId);
  assert.ok(hist.some((h) => h.event_type === "SUPERSEDED"), "SUPERSEDED lifecycle history preserved");
  s.close();
});

test("G11. SUPERSEDE without evidence binding -> AUTHORITY_INSUFFICIENT（no silent supersede）", async () => {
  const s = openStore();
  const c1 = candidate({ proposedSubjectStatement: "old", proposedContent: { kind: "TEXT", text: "old" } });
  const r1 = await runWritebackGate({ candidate: c1, store: s, expectedRepository: REPO });
  assert.equal(r1.status, "WRITEBACK_ACCEPTED");
  const sup = candidate({ proposedSubjectStatement: "new", proposedContent: { kind: "TEXT", text: "new" }, lifecycleIntent: "SUPERSEDE" });
  const r2 = await runWritebackGate({ candidate: sup, store: s, expectedRepository: REPO });
  assert.equal(r2.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", JSON.stringify(r2));
  assert.equal(s.get(r1.recordId).validity.status, "CURRENT", "old record NOT touched without evidence");
  s.close();
});

test("G12. INVALIDATE with evidence binding -> old record INVALIDATED", async () => {
  const s = openStore();
  const c1 = candidate({ proposedSubjectStatement: "old", proposedContent: { kind: "TEXT", text: "old" } });
  const r1 = await runWritebackGate({ candidate: c1, store: s, expectedRepository: REPO });
  assert.equal(r1.status, "WRITEBACK_ACCEPTED");
  const inv = candidate({
    proposedSubjectStatement: "invalidate old",
    proposedContent: { kind: "TEXT", text: "invalidate" },
    lifecycleIntent: "INVALIDATE",
    proposedRelationships: [{ relationshipType: "INVALIDATES", targetRecordId: r1.recordId }],
  });
  const r2 = await runWritebackGate({ candidate: inv, store: s, expectedRepository: REPO });
  assert.equal(r2.status, "WRITEBACK_ACCEPTED", JSON.stringify(r2));
  assert.equal(s.get(r1.recordId).validity.status, "INVALIDATED");
  s.close();
});

test("G13. stale baseline: tree change marks tree/path-bound CODE record STALE", async () => {
  const s = openStore();
  const code = candidate({
    proposedRecordType: "CODE",
    proposedIdentity: { repositoryIdentity: REPO, commitSha: "7".repeat(40), treeSha: TREE, path: "src/a.mjs", knowledgeKind: "FILE" },
    proposedSubjectStatement: "path src/a.mjs fact",
    proposedContent: { kind: "TEXT", text: "src/a.mjs fact" },
    proposedScope: { repository: REPO, tree: TREE, path: "src/a.mjs" },
    proposedTrust: "VERIFIED",
    evidenceReferences: ["manifest:" + "a".repeat(64), "verifier:" + "b".repeat(64)],
  });
  const r = await runWritebackGate({ candidate: code, store: s, expectedRepository: REPO, verifierIdentity: "b".repeat(64), canonicalEvidence: canonicalEvidence() });
  assert.equal(r.status, "WRITEBACK_ACCEPTED", JSON.stringify(r));
  assert.equal(s.get(r.recordId).validity.status, "CURRENT");
  // baseline no longer holds: tree changed
  const stale = markStaleIfBaselineBroken(s, { repository: REPO, tree: TREE_OTHER, path: "src/a.mjs" });
  assert.ok(stale.applied.includes(r.recordId), JSON.stringify(stale));
  assert.equal(s.get(r.recordId).validity.status, "STALE", "no longer current truth");
  s.close();
});

test("G14. corrupt memory store -> WRITEBACK_STORE_INVALID（never silent）", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const ok = await runWritebackGate({ candidate: candidate(), store: s, expectedRepository: REPO });
  assert.equal(ok.status, "WRITEBACK_ACCEPTED");
  s.close();
  // corrupt the journal middle line
  const jp = join(root, "journal.jsonl");
  const lines = readFileSync(jp, "utf8").trim().split("\n");
  lines[0] = "{ corrupted JSON";
  writeFileSync(jp, lines.join("\n") + "\n", "utf8");
  const s2 = new LocalMemoryStore({ stateRoot: root, log: silent });
  assert.throws(() => s2.open(), (e) => String(e.code ?? e.message).includes("MEMORY_STORE_INVALID") || String(e.message).includes("journal"));
});

test("G15. repeated closeout / duplicated delivery attempt -> no duplicate trusted record", async () => {
  const s = openStore();
  const r1 = await runWritebackGate({ candidate: candidate(), store: s, expectedRepository: REPO });
  const r2 = await runWritebackGate({ candidate: candidate(), store: s, expectedRepository: REPO });
  const r3 = await runWritebackGate({ candidate: candidate(), store: s, expectedRepository: REPO });
  assert.equal(r1.status, "WRITEBACK_ACCEPTED");
  assert.equal(r2.status, "WRITEBACK_DUPLICATE");
  assert.equal(r3.status, "WRITEBACK_DUPLICATE");
  const lk = deriveLogicalKey(s.get(r1.recordId));
  assert.equal(findCurrentByLogicalKey(s, lk).length, 1);
  s.close();
});

test("G16. REVIEWED trust with correct review binding -> ACCEPTED", async () => {
  const s = openStore();
  const r = await runWritebackGate({
    candidate: candidate({ proposedTrust: "REVIEWED", evidenceReferences: ["manifest:" + "a".repeat(64), "verifier:" + "b".repeat(64), `review:${REVIEW_ID}`] }),
    store: s,
    expectedRepository: REPO,
    reviewIdentity: REVIEW_ID,
    verifierIdentity: "b".repeat(64),
    canonicalEvidence: canonicalEvidence(),
  });
  assert.equal(r.status, "WRITEBACK_ACCEPTED", JSON.stringify(r));
  assert.equal(s.get(r.recordId).trust, "REVIEWED");
  assert.equal(s.get(r.recordId).evidence.reviewResultIdentity, REVIEW_ID);
  s.close();
});

test("G17. well-formed but NONEXISTENT verifier identity -> AUTHORITY_INSUFFICIENT（bound to canonical inventory, not hex64）", async () => {
  const s = openStore();
  // 64-hex, format-perfect, but the graph never produced it（attacker's
  // `aaaaaaaa...`）— must be rejected even though it is well-formed.
  const forged = "a".repeat(64);
  const c = candidate({ proposedTrust: "VERIFIED", evidenceReferences: ["manifest:" + "a".repeat(64), `verifier:${forged}`] });
  const r = await runWritebackGate({ candidate: c, store: s, expectedRepository: REPO, verifierIdentity: forged, canonicalEvidence: canonicalEvidence() });
  assert.equal(r.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", JSON.stringify(r));
  assert.ok(String(r.reason).includes("not_in_canonical_inventory"), `reason=${r.reason}`);
  const n = s.db.prepare("SELECT COUNT(*) n FROM memory_records").get().n;
  assert.equal(n, 0, "nothing written for a forged verifier identity");
  s.close();
});

test("G18. well-formed but WRONG review identity -> AUTHORITY_INSUFFICIENT", async () => {
  const s = openStore();
  const forgedReview = "d".repeat(64); // well-formed, not attested
  const c = candidate({
    proposedTrust: "REVIEWED",
    evidenceReferences: ["manifest:" + "a".repeat(64), `verifier:${VERIFIER_ID}`, `review:${forgedReview}`],
  });
  const r = await runWritebackGate({
    candidate: c, store: s, expectedRepository: REPO,
    verifierIdentity: VERIFIER_ID, reviewIdentity: forgedReview,
    canonicalEvidence: canonicalEvidence(),
  });
  assert.equal(r.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", JSON.stringify(r));
  assert.ok(String(r.reason).includes("not_in_canonical_inventory"), `reason=${r.reason}`);
  s.close();
});

test("G19. reviewer identity canonical for ANOTHER graph/card -> AUTHORITY_INSUFFICIENT", async () => {
  const s = openStore();
  const otherGraphReview = "e".repeat(64); // canonical in graph B, not graph A
  // (a) other GRAPH: candidate claims graphRunId B while the inventory is A's
  const cA = candidate({ graphRunId: "other-graph-run", proposedTrust: "REVIEWED", evidenceReferences: ["manifest:" + "a".repeat(64), `verifier:${VERIFIER_ID}`, `review:${otherGraphReview}`] });
  const rA = await runWritebackGate({
    candidate: cA, store: s, expectedRepository: REPO,
    verifierIdentity: VERIFIER_ID, reviewIdentity: otherGraphReview,
    canonicalEvidence: canonicalEvidence(),
  });
  assert.equal(rA.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", JSON.stringify(rA));
  assert.ok(String(rA.reason).includes("evidence_other_graph"), `reason=${rA.reason}`);
  // (b) other CARD: same graph, but a taskCardId this graph never ran
  const cB = candidate({ taskCardId: "AUTOLOOP-PI-GRAPH-OTHER-1", proposedTrust: "REVIEWED", evidenceReferences: ["manifest:" + "a".repeat(64), `verifier:${VERIFIER_ID}`, `review:${REVIEW_ID}`] });
  const rB = await runWritebackGate({
    candidate: cB, store: s, expectedRepository: REPO,
    verifierIdentity: VERIFIER_ID, reviewIdentity: REVIEW_ID,
    canonicalEvidence: canonicalEvidence(),
  });
  assert.equal(rB.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", JSON.stringify(rB));
  assert.ok(String(rB.reason).includes("evidence_other_card"), `reason=${rB.reason}`);
  // (c) well-formed identity that IS canonical for another graph: not in THIS
  // graph's inventory -> forged, never accepted
  const rC = await runWritebackGate({
    candidate: candidate({ proposedTrust: "REVIEWED", evidenceReferences: ["manifest:" + "a".repeat(64), `verifier:${VERIFIER_ID}`, `review:${otherGraphReview}`] }),
    store: s, expectedRepository: REPO,
    verifierIdentity: VERIFIER_ID, reviewIdentity: otherGraphReview,
    canonicalEvidence: canonicalEvidence(),
  });
  assert.equal(rC.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", JSON.stringify(rC));
  assert.ok(String(rC.reason).includes("not_in_canonical_inventory"), `reason=${rC.reason}`);
  s.close();
});

test("G20. VERIFIED/REVIEWED without a canonical evidence inventory -> fail closed（never hex64-only）", async () => {
  const s = openStore();
  const c = candidate({ proposedTrust: "VERIFIED", evidenceReferences: ["manifest:" + "a".repeat(64), `verifier:${VERIFIER_ID}`] });
  const r = await runWritebackGate({ candidate: c, store: s, expectedRepository: REPO, verifierIdentity: VERIFIER_ID, canonicalEvidence: null });
  assert.equal(r.status, "WRITEBACK_AUTHORITY_INSUFFICIENT", JSON.stringify(r));
  assert.ok(String(r.reason).includes("canonical evidence inventory"), `reason=${r.reason}`);
  s.close();
});
