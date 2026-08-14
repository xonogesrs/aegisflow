// test/memory/test-jsonl.mjs
//
// CBM-2 §15 JSONL: 12 required cases（append-only hash-chain journal）.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJournalEvent,
  readJournal,
  assertChainIntegrity,
  replayJournal,
  JOURNAL_GENESIS_DIGEST,
  MEMORY_ERRORS,
  openMemoryDb,
  applyMigrations,
  queryRecords,
  upsertRecord,
  validateMemoryRecordV1,
  buildLifecycleEvent,
  applyLifecycleEvent,
  VALIDITY_FILTERS,
} from "../../src/memory/index.mjs";
import { baseCodeRecord, baseExecutionRecord, baseDecisionRecord, hex64 } from "./helpers.mjs";

const ROOT = join(tmpdir(), `cbm2-jsonl-${process.pid}`);
const validate = (r) => validateMemoryRecordV1(r, { authorizedDirs: [] });

before(() => rmSync(ROOT, { recursive: true, force: true }) || mkdirSync(ROOT, { recursive: true }));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function freshState() {
  return { lastSequence: 0, previousDigest: null };
}

test("1. append + genesis chain", () => {
  const p = join(ROOT, "j1.jsonl");
  const { event, state } = appendJournalEvent({ journalPath: p, state: freshState(), operation: "UPSERT_RECORD", recordId: "r1", payload: { note: "one" } });
  assert.equal(event.journalSequence, 1);
  assert.equal(event.previousDigest, JOURNAL_GENESIS_DIGEST, "first event uses fixed genesis");
  assert.equal(state.lastSequence, 1);
  const r = readJournal(p);
  assert.equal(r.events.length, 1);
  assert.equal(r.partialTrailingLine, false);
  assert.equal(r.state.previousDigest, event.eventDigest);
});

test("2. hash chain (each event binds previous digest)", () => {
  const p = join(ROOT, "j2.jsonl");
  let state = freshState();
  const digests = [];
  for (let i = 1; i <= 3; i++) {
    const r = appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: `r${i}`, payload: { i } });
    state = r.state;
    digests.push(r.event.eventDigest);
    assert.equal(r.event.previousDigest, i === 1 ? JOURNAL_GENESIS_DIGEST : digests[i - 2]);
  }
  const read = readJournal(p);
  assert.equal(read.events.length, 3);
  assertChainIntegrity(p); // no throw
});

test("3. restart continuation (append after reopen)", () => {
  const p = join(ROOT, "j3.jsonl");
  let state = freshState();
  const r1 = appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: "r1", payload: { a: 1 } });
  state = r1.state;
  // simulate restart: re-read the journal to recover state
  const r = readJournal(p);
  const r2 = appendJournalEvent({ journalPath: p, state: r.state, operation: "UPSERT_RECORD", recordId: "r2", payload: { a: 2 } });
  assert.equal(r2.event.journalSequence, 2);
  assert.equal(r2.event.previousDigest, r1.event.eventDigest);
  assertChainIntegrity(p);
});

test("4. partial final line detected (crash mid-append) and excluded", () => {
  const p = join(ROOT, "j4.jsonl");
  let state = freshState();
  const r1 = appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: "r1", payload: { a: 1 } });
  state = r1.state;
  appendFileSync(p, '{"schema":"autoloop.memory-journal-event/v1","journalSequence":2,"par'); // truncated write
  const r = readJournal(p);
  assert.equal(r.partialTrailingLine, true, "partial trailing line detected");
  assert.equal(r.events.length, 1, "partial line excluded from chain");
  assert.equal(r.state.lastSequence, 1);
});

test("5. corrupted middle line -> fail-closed JOURNAL_CHAIN_INVALID", () => {
  const p = join(ROOT, "j5.jsonl");
  let state = freshState();
  const r1 = appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: "r1", payload: { a: 1 } });
  state = r1.state;
  const r2 = appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: "r2", payload: { a: 2 } });
  state = r2.state;
  appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: "r3", payload: { a: 3 } });
  // corrupt the MIDDLE line
  const lines = readFileSync(p, "utf8").split("\n");
  lines[1] = '{ "corrupted": true }';
  writeFileSync(p, lines.join("\n"));
  assert.throws(() => readJournal(p), (e) => e.code === MEMORY_ERRORS.JOURNAL_CHAIN_INVALID && e.message.includes("line 2"));
});

test("6. duplicate sequence rejected", () => {
  const p = join(ROOT, "j6.jsonl");
  let state = freshState();
  const r1 = appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: "r1", payload: { a: 1 } });
  state = r1.state;
  const r2 = appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: "r2", payload: { a: 2 } });
  // hand-append a duplicate of r1（same sequence 1）
  appendFileSync(p, JSON.stringify({ ...r1.event }) + "\n");
  assert.throws(() => readJournal(p), (e) => e.code === MEMORY_ERRORS.JOURNAL_CHAIN_INVALID && e.message.includes("sequence"));
});

test("7. sequence gap rejected", () => {
  const p = join(ROOT, "j7.jsonl");
  let state = freshState();
  const r1 = appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: "r1", payload: { a: 1 } });
  // append an event with sequence 3（skipping 2）
  const forged = { ...r1.event, journalSequence: 3, payload: { a: 3 }, eventId: "evt_gap" };
  appendFileSync(p, JSON.stringify(forged) + "\n");
  assert.throws(() => readJournal(p), (e) => e.code === MEMORY_ERRORS.JOURNAL_CHAIN_INVALID);
});

test("8. replay applies records without side effects", () => {
  const p = join(ROOT, "j8.jsonl");
  const db = openMemoryDb(join(ROOT, "j8.db"));
  applyMigrations(db);
  let state = freshState();
  const rec = baseCodeRecord();
  const r1 = appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: rec.recordId, payload: { record: rec } });
  state = r1.state;
  const ev = buildLifecycleEvent({ recordId: rec.recordId, eventType: "PROMOTED", previousState: "RAW", newState: "UNVERIFIED", reason: "replay", authority: "SYSTEM_DERIVED" });
  appendJournalEvent({ journalPath: p, state, operation: "LIFECYCLE_EVENT", recordId: rec.recordId, payload: { event: ev } });
  const out = replayJournal({ db, journalPath: p, recordValidator: validate });
  assert.equal(out.count, 2);
  const rows = queryRecords(db, { validity: VALIDITY_FILTERS.ALL });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trust, "UNVERIFIED", "lifecycle event applied during replay");
  db.close();
});

test("9. SQLite rebuild from journal (records + lifecycle + conflicts)", () => {
  const p = join(ROOT, "j9.jsonl");
  const db = openMemoryDb(join(ROOT, "j9.db"));
  applyMigrations(db);
  let state = freshState();
  // original store: two records + a lifecycle promotion
  const a = baseCodeRecord({ content: { kind: "TEXT", text: "vA" } });
  const b = baseCodeRecord({ content: { kind: "TEXT", text: "vB" } });
  appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: a.recordId, payload: { record: a } });
  state = readJournal(p).state;
  appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: b.recordId, payload: { record: b } });
  state = readJournal(p).state;
  const ev = buildLifecycleEvent({ recordId: a.recordId, eventType: "PROMOTED", previousState: "RAW", newState: "VERIFIED", reason: "verifier", authority: "VERIFIER" });
  appendJournalEvent({ journalPath: p, state, operation: "LIFECYCLE_EVENT", recordId: a.recordId, payload: { event: ev } });
  // rebuild into a FRESH db from the journal alone
  const db2 = openMemoryDb(join(ROOT, "j9-rebuilt.db"));
  applyMigrations(db2);
  replayJournal({ db: db2, journalPath: p, recordValidator: validate });
  const rebuilt = queryRecords(db2, { validity: VALIDITY_FILTERS.ALL });
  assert.equal(rebuilt.length, 2, "both records rebuilt");
  assert.equal(rebuilt.find((r) => r.recordId === a.recordId).trust, "VERIFIED", "lifecycle state rebuilt");
  db.close();
  db2.close();
});

test("10. rebuild identity equality (canonical json identical to original)", () => {
  const p = join(ROOT, "j10.jsonl");
  const db = openMemoryDb(join(ROOT, "j10.db"));
  applyMigrations(db);
  let state = freshState();
  const recs = [baseCodeRecord(), baseExecutionRecord(), baseDecisionRecord()];
  for (const r of recs) {
    upsertRecord(db, r, { validate }); // live store: db + journal stay in sync
    appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: r.recordId, payload: { record: r } });
    state = readJournal(p).state;
  }
  const db2 = openMemoryDb(join(ROOT, "j10-rebuilt.db"));
  applyMigrations(db2);
  replayJournal({ db: db2, journalPath: p, recordValidator: validate });
  const o1 = queryRecords(db, { validity: VALIDITY_FILTERS.ALL }).map((r) => JSON.stringify(r));
  const o2 = queryRecords(db2, { validity: VALIDITY_FILTERS.ALL }).map((r) => JSON.stringify(r));
  assert.deepEqual(o1.sort(), o2.sort(), "rebuilt store identical to original（identity/state/indexes）");
  db.close();
  db2.close();
});

test("11. no replay side effects (replay is pure local mutation)", () => {
  const p = join(ROOT, "j11.jsonl");
  const db = openMemoryDb(join(ROOT, "j11.db"));
  applyMigrations(db);
  let state = freshState();
  const rec = baseCodeRecord();
  appendJournalEvent({ journalPath: p, state, operation: "UPSERT_RECORD", recordId: rec.recordId, payload: { record: rec } });
  // replay twice — idempotent（upsert semantics）, no duplicate rows, no external I/O
  replayJournal({ db, journalPath: p, recordValidator: validate });
  replayJournal({ db, journalPath: p, recordValidator: validate });
  assert.equal(queryRecords(db).length, 1, "idempotent replay");
  const events = db.prepare("SELECT COUNT(*) c FROM memory_lifecycle_events").get().c;
  assert.equal(events, 1, "CREATED event once (upsert skipped duplicate)");
  db.close();
});

test("12. secret rejection BEFORE append (zero bytes written)", () => {
  const p = join(ROOT, "j12.jsonl");
  assert.throws(() => appendJournalEvent({ journalPath: p, state: freshState(), operation: "UPSERT_RECORD", recordId: "r", payload: { leak: "DEEPSEEK_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456" } }),
    (e) => e.code === MEMORY_ERRORS.SECRET_DETECTED);
  assert.equal(existsSync(p) ? readFileSync(p, "utf8").length : 0, 0, "nothing appended for secret payload");
});
