// test/learning/test-r2-resume-replay-exactly-once.mjs
//
// R2 PHASE 5 — DURABLE RESUME / REPLAY / EXACTLY-ONCE / OWNERSHIP
// (PLAN PHASE-5-RESUME-REPLAY; frozen orders R1–R8, replay 1–9, 5 keyed +
// 6 recomputable effects, ownership c1–c5).
//
// FROZEN AUTHORITY RULES:
//   RESUME_READS = { journal, sqlite-as-derived-view, canonical evidence
//   inventory, committed owner heads } — NEVER process cache, Harness
//   session state, provider state.
//   c4 (R2_REV_F4 corrected): NO advisory lock exists (openSync "a" + fsync);
//   second-writer loss is detected by digest-chain continuity validation
//   (assertChainIntegrity) ⇒ RECOVERY_REQUIRED ⇒ HOLD. No journal lock
//   primitive appears anywhere in R2 (structural sweep below).
//   OWNERSHIP ∈ { RESOLVED, HOLD } — no third state; no takeover.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore, MEMORY_QUERY_SCHEMA } from "../../src/memory/index.mjs";
import { assertChainIntegrity, readJournal, replayJournal } from "../../src/memory/jsonl-journal.mjs";
import { deriveLogicalKey } from "../../src/memory/index.mjs";
import {
  consolidateIncidents,
  rederiveConstituentSetDigest,
} from "../../src/learning/patterns/consolidation.mjs";
import { hex64, REPO, RUN, CARD, NODE, incidentRecord, patternRecord, silentLog } from "../memory/test-r2-helpers.mjs";
import { makeWorld, publishGen1 } from "../v2/helpers/derived-artifact-fixtures.mjs";
import { verifyCandidatePublication } from "../../src/learning/patterns/candidate.mjs";

const ROOTS = [];
function freshRoot(label = "r2-p5") {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  ROOTS.push(root);
  return root;
}
function store(root) {
  return new LocalMemoryStore({ stateRoot: root, log: silentLog() });
}

// ═══ R1 — journal-first read + digest chain ═════════════════════════════════

test("R1. journal is the durable authority; digest chain verified FIRST; sqlite⊆journal after recovery", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const rec = patternRecord();
  s.explicitImport(rec, { source: "R2-TEST" });
  // journal has the event
  const jr = readJournal(join(root, "journal.jsonl"));
  assert.equal(jr.events.length, 1);
  assert.equal(jr.events[0].operation, "UPSERT_RECORD");
  // chain verifies
  const verified = assertChainIntegrity(join(root, "journal.jsonl"));
  assert.equal(verified.events.length, 1);
  s.close();
  // crash simulation: delete sqlite; journal rebuilds it losslessly
  for (const f of ["memory.db", "memory.db-wal", "memory.db-shm"]) rmSync(join(root, f), { force: true });
  const s2 = store(root);
  s2.open();
  const q = s2.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.length, 1, "sqlite rebuilt from journal (sqlite⊆journal)");
  assert.equal(q.selectedRecords[0].recordId, rec.recordId);
  s2.close();
});

test("R1−. torn/ambiguous durable view (digest-chain break) ⇒ JOURNAL_CHAIN_INVALID fail-closed HOLD; no journal advance", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(patternRecord(), { source: "R2-TEST" });
  s.explicitImport(patternRecord({ patternId: "pat-r2-2", statement: "second pattern" }), { source: "R2-TEST" });
  s.close();
  // corrupt a MIDDLE byte of the second event (digest-chain break)
  const jp = join(root, "journal.jsonl");
  const lines = readFileSync(jp, "utf8").split("\n").filter((l) => l.length > 0);
  const mid = JSON.parse(lines[1]);
  mid.payload.record.subject.statement = "tampered";
  lines[1] = JSON.stringify(mid);
  writeFileSync(jp, lines.join("\n") + "\n");
  // resume must NOT advance: chain validation fails closed
  const s2 = store(root);
  assert.throws(() => s2.open(), (e) => String(e?.code ?? e?.message ?? "").includes("JOURNAL_CHAIN_INVALID"));
  // journal itself still fails integrity assert
  assert.throws(() => assertChainIntegrity(jp));
});

test("R1−. digest-chain corruption is detected WITHOUT any lock primitive (c4: no advisory lock exists)", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(patternRecord(), { source: "R2-TEST" });
  s.close();
  const jp = join(root, "journal.jsonl");
  const lines = readFileSync(jp, "utf8").split("\n").filter((l) => l.length > 0);
  appendFileSync(jp, JSON.stringify({ schema: "autoloop.memory-journal-event/v1", journalSequence: 99, forged: true }) + "\n");
  // chain-continuity validation detects the forged line (no lock taken)
  assert.throws(() => assertChainIntegrity(jp));
  // structural: the R2 phase surface contains no lock primitives
  const src = readFileSync(new URL("../../src/memory/jsonl-journal.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes("flock"), "no flock");
  assert.ok(!/lockSync|LOCK_EX/.test(src), "no lockSync/LOCK_EX");
});

// ═══ R2/R3 — execution identity + lineage re-derivation ═════════════════════

test("R3. candidate lineage re-derives from journal payloads; durable inputs reproduce identity exactly", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const rec = patternRecord();
  s.explicitImport(rec, { source: "R2-TEST" });
  s.close();
  // re-derive EVERYTHING from the journal payload alone (no process cache)
  const jr = readJournal(join(root, "journal.jsonl"));
  const stored = jr.events[0].payload.record;
  const { deriveMemoryRecordId, deriveContentHash } = deriveFromIndex();
  assert.equal(deriveMemoryRecordId(stored), rec.recordId, "recordId re-derives from durable journal bytes");
  assert.equal(deriveContentHash(stored.content), stored.subject.contentHash);
  assert.equal(deriveLogicalKey(stored), deriveLogicalKey(rec));
});

function deriveFromIndex() {
  // static import kept at top via index module (no dynamic cache)
  return { deriveMemoryRecordId: deriveMemoryRecordIdRef, deriveContentHash: deriveContentHashRef };
}
import { deriveMemoryRecordId as deriveMemoryRecordIdRef, deriveContentHash as deriveContentHashRef } from "../../src/memory/index.mjs";

// ═══ R5 — generation binding on resume ══════════════════════════════════════

test("R5. resume re-validates the generation binding vs the committed owner head; stale ⇒ WRONG_GENERATION, incumbent stays authority", async () => {
  const world = makeWorld("r2-p5-gen");
  try {
    const pub = await publishGen1(world, { mutationId: "mut-r2-p5" });
    // fresh verification reproduces the binding (resume reads committed owner head)
    const ok = verifyCandidatePublication({
      root: world.root, executionId: world.executionId, phaseId: "p1",
      publication: { artifact_digest: pub.artifact_digest, link_digest: pub.committed_link_digest, generation: pub.generation },
    });
    assert.equal(ok.verified, true);
    // a journaled binding that no longer matches the committed head fails closed
    assert.throws(
      () => verifyCandidatePublication({
        root: world.root, executionId: world.executionId, phaseId: "p1",
        publication: { artifact_digest: pub.artifact_digest, link_digest: pub.committed_link_digest, generation: 7 },
      }),
      (e) => (e?.details?.reason ?? "") === "PUBLICATION_GENERATION_MISMATCH",
    );
  } finally {
    rmSync(world.root, { recursive: true, force: true });
  }
});

// ═══ R6 — terminal detection ⇒ resume is a NO-OP ════════════════════════════

test("R6. journaled PATTERN record with durable sqlite row ⇒ TERMINAL ⇒ re-execution is an idempotent no-op (same recordId)", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const rec = patternRecord();
  s.explicitImport(rec, { source: "R2-TEST" });
  const firstCount = readJournal(join(root, "journal.jsonl")).events.length;
  // replay of the SAME record (exact retry) — journal-first write is idempotent
  s.explicitImport(rec, { source: "R2-TEST" });
  const jr = readJournal(join(root, "journal.jsonl"));
  const recordEvents = jr.events.filter((e) => e.operation === "UPSERT_RECORD" && e.recordId === rec.recordId);
  assert.equal(recordEvents.length >= 1, true);
  const q = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  const rows = q.selectedRecords.filter((r) => r.recordId === rec.recordId);
  assert.equal(rows.length, 1, "one logical candidate ⇒ one durable record (no duplicate authority)");
  s.close();
});

// ═══ REPLAY MATRIX (PLAN §2; cases 1–9) ═════════════════════════════════════

test("REPLAY 1/2. exact retry + same-identity different derivation path ⇒ idempotent no-op, SAME recordId", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const rec = patternRecord();
  s.explicitImport(rec, { source: "A" });
  // case 1: exact retry
  s.explicitImport(rec, { source: "A" });
  // case 2: same logical content, different source label (derivation path) — identity is content-derived
  const rec2 = patternRecord();
  assert.equal(rec2.recordId, rec.recordId, "deterministic identity ⇒ same recordId from durable inputs");
  s.explicitImport(rec2, { source: "B" });
  const q = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.length, 1);
  s.close();
});

test("REPLAY 3. same logicalKey + different content ⇒ WRITEBACK_CONFLICT surfaced (conflict is not a write)", async () => {
  const { runWritebackGate } = await import("../../src/memory/writeback/gate.mjs");
  const { patternCandidate } = await import("../memory/test-r2-helpers.mjs");
  const root = freshRoot();
  const s = store(root);
  s.open();
  const c1 = await patternCandidate({ evidenceReferences: [`verifier:${hex64("b")}`] });
  const r1 = await runWritebackGate({ candidate: c1, store: s, verifierIdentity: hex64("b"), canonicalEvidence: (await import("../memory/test-r2-helpers.mjs")).canonicalEvidence() });
  assert.equal(r1.status, "WRITEBACK_ACCEPTED");
  // same logicalKey (same patternId+repo), different content statement
  const { createWritebackCandidate } = await import("../../src/memory/writeback/candidate.mjs");
  const { patternContent } = await import("../memory/test-r2-helpers.mjs");
  const c2 = createWritebackCandidate({
    graphRunId: RUN, taskCardId: CARD, originatingNode: NODE,
    sourceResultIdentity: `node:${RUN}:${NODE}`,
    proposedRecordType: "PATTERN",
    proposedIdentity: { patternId: "pat-r2-1", repositoryIdentity: REPO },
    proposedSubjectStatement: "PATTERN: different mechanism statement entirely",
    proposedContent: patternContent({ mechanismDigest: hex64("9") }),
    proposedScope: { repository: REPO },
    evidenceReferences: [`manifest:${hex64("f")}`, `verifier:${hex64("b")}`],
    proposedTrust: "VERIFIED",
    lifecycleIntent: "CREATE",
    origin: "independent_reviewer",
  });
  const r2 = await runWritebackGate({ candidate: c2, store: s, verifierIdentity: hex64("b"), canonicalEvidence: (await import("../memory/test-r2-helpers.mjs")).canonicalEvidence() });
  assert.equal(r2.status, "WRITEBACK_CONFLICT");
  assert.ok(Array.isArray(r2.conflictWith) && r2.conflictWith.length === 1, "both records surfaced");
  s.close();
});

test("REPLAY 4. stale generation ⇒ WRONG_GENERATION-class rejection; incumbent byte-identical", async () => {
  const { runWritebackGate } = await import("../../src/memory/writeback/gate.mjs");
  const { patternCandidate, canonicalEvidence } = await import("../memory/test-r2-helpers.mjs");
  const root = freshRoot();
  const s = store(root);
  s.open();
  const c1 = await patternCandidate();
  const r1 = await runWritebackGate({ candidate: c1, store: s, verifierIdentity: hex64("b"), canonicalEvidence: canonicalEvidence() });
  assert.equal(r1.status, "WRITEBACK_ACCEPTED");
  const qBefore = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  // stale candidate: same identity, pre-freeze generation 0 ⇒ schema fence
  // rejects fail-closed (SCHEMA_INVALID:pattern_publication_generation_required;
  // the D6 binding makes generation < 1 structurally invalid — the durable
  // incumbent is untouched either way: rejection is not a write)
  const { createWritebackCandidate } = await import("../../src/memory/writeback/candidate.mjs");
  const { patternContent } = await import("../memory/test-r2-helpers.mjs");
  const stale = createWritebackCandidate({
    graphRunId: RUN, taskCardId: CARD, originatingNode: NODE,
    sourceResultIdentity: `node:${RUN}:${NODE}`,
    proposedRecordType: "PATTERN",
    proposedIdentity: { patternId: "pat-r2-1", repositoryIdentity: REPO },
    proposedSubjectStatement: "PATTERN: retry loop without backoff livelocks",
    proposedContent: patternContent({ publicationGeneration: 0 }),
    proposedScope: { repository: REPO },
    evidenceReferences: [`manifest:${hex64("f")}`, `verifier:${hex64("b")}`],
    proposedTrust: "VERIFIED",
    lifecycleIntent: "CREATE",
    origin: "independent_reviewer",
  });
  const r2 = await runWritebackGate({ candidate: stale, store: s, verifierIdentity: hex64("b"), canonicalEvidence: canonicalEvidence() });
  assert.equal(r2.status, "WRITEBACK_EVIDENCE_INVALID");
  assert.ok(r2.reason.includes("SCHEMA_INVALID:pattern_publication_generation_required"), `exact fine code (got ${r2.reason})`);
  const qAfter = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(qAfter.selectedRecords.length, qBefore.selectedRecords.length, "incumbent untouched");
  s.close();
});

test("REPLAY 7. journal replay after crash: sqlite rebuild ONLY (derived view); same records; chain verified FIRST", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const a = patternRecord();
  const b = patternRecord({ patternId: "pat-r2-2", statement: "second" });
  s.explicitImport(a, { source: "R2-TEST" });
  s.explicitImport(b, { source: "R2-TEST" });
  const journalBefore = readJournal(join(root, "journal.jsonl")).events.length;
  s.close();
  // wipe sqlite, replay journal into a fresh db through the store's recovery
  for (const f of ["memory.db", "memory.db-wal", "memory.db-shm"]) rmSync(join(root, f), { force: true });
  const s2 = store(root);
  s2.open(); // asserts chain BEFORE rebuild
  assert.equal(s2.lastRecovery?.action, "rebuilt_from_journal");
  const q = s2.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.length, 2, "same records after replay");
  assert.equal(readJournal(join(root, "journal.jsonl")).events.length, journalBefore, "journal unchanged by replay");
  s2.close();
});

test("REPLAY 8. retrieval re-query: same snapshot + same query ⇒ same ordered result + same retrievalDigest; no new record/metric", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(patternRecord(), { source: "R2-TEST" });
  s.explicitImport(patternRecord({ patternId: "pat-r2-2", statement: "second" }), { source: "R2-TEST" });
  const q = { schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" };
  const r1 = s.query(q);
  const r2 = s.query(q);
  assert.deepEqual(r1.selectedRecords.map((x) => x.recordId), r2.selectedRecords.map((x) => x.recordId));
  assert.equal(r1.retrievalDigest, r2.retrievalDigest);
  s.close();
});

test("REPLAY 9. duplicate consolidation (same root event twice) ⇒ duplicate inflation REJECTED; single cited lineage", () => {
  const a = { recordId: hex64("1"), logicalKey: hex64("7"), contentHash: hex64("a") };
  assert.throws(
    () => consolidateIncidents({ incidents: [a, { recordId: hex64("2"), logicalKey: hex64("7"), contentHash: hex64("a") }], patternId: "pat-r2-1" }),
    (e) => e?.code === "CONSOLIDATION_DUPLICATE_INFLATION",
  );
  // loss recovery: the derived digest recomputes from durable constituents
  const c = consolidateIncidents({ incidents: [a, { recordId: hex64("2"), logicalKey: hex64("8"), contentHash: hex64("b") }], patternId: "pat-r2-1" });
  assert.equal(rederiveConstituentSetDigest(c, [a, { recordId: hex64("2"), logicalKey: hex64("8"), contentHash: hex64("b") }]).ok, true);
});

// ═══ EXACTLY-ONCE — boundary rule (PLAN §3) ═════════════════════════════════

test("EO1. keyed effect: PATTERN durable record is keyed by recordId — repeated attempt does NOT duplicate the durable effect", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const rec = patternRecord();
  s.explicitImport(rec, { source: "R2-TEST" });
  const after1 = readJournal(join(root, "journal.jsonl")).events.length;
  s.explicitImport(rec, { source: "R2-TEST" });
  const after2 = readJournal(join(root, "journal.jsonl")).events.length;
  assert.ok(after2 >= after1, "journal appends are append-only events");
  // but the durable RECORD count stays exactly one
  const q = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.length, 1);
  s.close();
});

test("EO2. recomputable effect: sqlite lost ⇒ recomputed from the authoritative journal (lost derived effect IS recovered)", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const rec = patternRecord();
  s.explicitImport(rec, { source: "R2-TEST" });
  s.close();
  rmSync(join(root, "memory.db"), { force: true });
  const s2 = store(root);
  s2.open();
  const q = s2.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.length, 1, "derived view recomputed");
  s2.close();
});

test("EO3. in-flight consolidation draft (pre-journal) is ephemeral: only journaled consolidation lineage is owned", () => {
  // a draft that was never journaled is discarded on resume — re-executed
  // from durable inputs; re-execution from the SAME durable constituents
  // reproduces the SAME digest (deterministic recompute, not takeover).
  const i1 = { recordId: hex64("1"), logicalKey: hex64("7"), contentHash: hex64("a") };
  const i2 = { recordId: hex64("2"), logicalKey: hex64("8"), contentHash: hex64("b") };
  const draft1 = consolidateIncidents({ incidents: [i1, i2], patternId: "pat-r2-1" });
  const draft2 = consolidateIncidents({ incidents: [i1, i2], patternId: "pat-r2-1" });
  assert.equal(draft1.digest, draft2.digest, "re-execution from durable inputs reproduces the same consolidation");
  assert.deepEqual(draft1.constituentIncidentRecordIds, [i1.recordId, i2.recordId]);
});

// ═══ OWNERSHIP (PLAN §4; c1–c5) ═════════════════════════════════════════════

test("OWN c2. stored identity fields fail re-derivation ⇒ CANDIDATE_IDENTITY_MISMATCH fail-closed (no takeover)", async () => {
  const { assertCandidateDerivedIdentities } = await import("../../src/learning/patterns/candidate.mjs");
  const { CANDIDATE_OBS_SCHEMA } = await import("../../src/learning/transfer-metrics/schema.mjs");
  const event = {
    schema_version: "autoloop.transfer-event/v1",
    event_type: "PATTERN_CANDIDATE_CREATED",
    project_identity: "proj-r2",
    task_identity: CARD,
    attempt_identity: "att-r2-1",
    incident_identity: { incident_id: "inc-r2-1" },
    pattern_identity: { pattern_id: "pat-r2-1", generation: 0 },
    payload: {
      lifecycle_state: "CANDIDATE",
      mechanism_digest: hex64("1"),
      applicability_digest: hex64("2"),
      constituent_incident_set_digest: hex64("3"),
      profile_version: CANDIDATE_OBS_SCHEMA,
      candidate_slot: 0,
      phase_identity: { execution_id: "exec-r2", phase_id: "p1" },
    },
  };
  event.payload.candidate_identity_key = (await import("../../src/learning/patterns/candidate.mjs")).deriveCandidateIdentityKey(event);
  event.payload.candidate_id = (await import("../../src/learning/patterns/candidate.mjs")).deriveCandidateId(event);
  const tampered = structuredClone(event);
  tampered.payload.constituent_incident_set_digest = hex64("4");
  assert.throws(() => assertCandidateDerivedIdentities(tampered), (e) => (e?.details?.reason ?? "") === "CANDIDATE_IDENTITY_MISMATCH");
});

test("OWN c3. torn/ambiguous view ⇒ RECOVERY_REQUIRED-class fail-closed (duplicate sequence / gap)", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(patternRecord(), { source: "R2-TEST" });
  s.close();
  const jp = join(root, "journal.jsonl");
  const lines = readFileSync(jp, "utf8").split("\n").filter((l) => l.length > 0);
  // gap: drop the last event's line (sequence 1 missing but sequence 2 appended)
  const valid = JSON.parse(lines[0]);
  writeFileSync(jp, JSON.stringify(lines.map((l) => l)) === "" ? "" : lines[0] + "\n" + lines[lines.length - 1].replace(`"journalSequence":${valid.journalSequence}`, `"journalSequence":${valid.journalSequence + 5}`));
  assert.throws(() => assertChainIntegrity(jp), /sequence gap|JOURNAL_CHAIN_INVALID|digest/i);
});

test("OWN c5. unjournaled side effect ⇒ NOT owned ⇒ discarded (no journal row ⇒ no authority)", async () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const rec = patternRecord();
  // import journal-first; then simulate an unjournaled sqlite-only mutation
  s.explicitImport(rec, { source: "R2-TEST" });
  s.close();
  // a sqlite row with NO journal event is a parity violation ⇒ fail-closed on open
  const { openMemoryDb, applyMigrations } = await import("../../src/memory/sqlite-schema.mjs");
  const db = openMemoryDb(join(root, "memory.db"));
  applyMigrations(db);
  const ghost = patternRecord({ patternId: "pat-ghost", statement: "never journaled" });
  db.prepare(`INSERT INTO memory_records (
    record_id, logical_key, schema_version, record_type, trust, trust_rank, validity_status,
    scope_repository, scope_global, content_hash, source, source_identity, created_at, updated_at, json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ghost.recordId, deriveLogicalKey(ghost), ghost.schema, "PATTERN", ghost.trust, 1, "CURRENT",
    REPO, 0, ghost.subject.contentHash, ghost.source.source, ghost.source.identity, ghost.timestamps.createdAt, ghost.timestamps.updatedAt, JSON.stringify(ghost),
  );
  db.close();
  const s2 = store(root);
  // records missing from the journal cannot reconcile ⇒ fail closed
  assert.throws(() => s2.open(), (e) => String(e?.message ?? e).length > 0 && (String(e?.code ?? e?.message ?? "").includes("JOURNAL") || String(e?.message ?? e).includes("parity") || String(e?.message ?? e).includes("journal")));
});

// ═══ PROHIBITED AUTHORITIES (P6/H2/H3 structural) ═══════════════════════════

test("PROH. resume reads ONLY {journal, sqlite-as-derived-view, canonical evidence inventory, committed owner heads}", async () => {
  // structural sweep of the R2 phase surface: no Harness/session/provider
  // state reads for any authoritative decision
  const { readFileSync: rf } = await import("node:fs");
  const files = [
    "../../src/learning/patterns/consolidation.mjs",
    "../../src/learning/patterns/qualification.mjs",
    "../../src/learning/patterns/applicability.mjs",
  ];
  for (const f of files) {
    const text = rf(new URL(f, import.meta.url), "utf8");
    for (const forbidden of ["process.env", "sessionState", "providerCheckpoint", "checkpoint-bridge"]) {
      assert.ok(!text.includes(forbidden), `${f} must not read ${forbidden}`);
    }
  }
});

test("PROH. no journal lock primitive anywhere in the R2 surface (R2_REV_F4: digest-chain only)", async () => {
  const { readFileSync: rf } = await import("node:fs");
  const files = [
    "../../src/memory/jsonl-journal.mjs",
    "../../src/learning/patterns/consolidation.mjs",
    "../../src/learning/patterns/qualification.mjs",
    "../../src/learning/patterns/applicability.mjs",
  ];
  for (const f of files) {
    const text = rf(new URL(f, import.meta.url), "utf8");
    assert.ok(!/flock|lockSync|LOCK_EX|lockfile/.test(text), `${f} contains a lock primitive`);
  }
});
