#!/usr/bin/env node
// scripts/cbm3-memory-probe.mjs
//
// CBM-3 §30 — Performance / resource evidence on a local synthetic dataset
// （10,000 MemoryRecords）. Measures:
//   store open (cold reopen) / snapshot digest / exact lookup / path+symbol
//   lookup / FTS candidate query / deterministic retrieval + RSS observation.
//
// Determinism rules hold under load: every measurement is bounded; there is
// no unbounded linear memory growth, no network, no per-query full DB
// serialization（queries hit indexed sqlite + FTS5）; correctness contract is
// NEVER changed to hit a number.
//
// Uses an isolated temporary store root（never the production store）.
//
// Run: node scripts/cbm3-memory-probe.mjs [--records 10000]

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  LocalMemoryStore,
  MEMORY_QUERY_SCHEMA,
  validateMemoryRecordV1,
  validateMemoryQueryV1,
} from "../src/memory/index.mjs";
import { codeRecord, REPO, TREE } from "../test/memory/helpers-cbm3.mjs";

const N = Number(process.argv[process.argv.indexOf("--records") + 1] ?? 10000);
const silent = { info() {}, warn() {}, error() {} };

function ms(t0) {
  return Math.round((performance.now() - t0) * 10) / 10;
}
function rss() {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "cbm3-probe-"));
  const results = {};
  const tImport = performance.now();

  // ── build the synthetic dataset（validated imports; journal-first）───────
  const store = new LocalMemoryStore({ stateRoot: root, log: silent });
  store.open();
  for (let i = 0; i < N; i++) {
    const rec = codeRecord({
      repo: REPO,
      tree: TREE,
      path: `src/mod${String(i).padStart(5, "0")}/impl-${i}.mjs`,
      symbol: `symbol${i}`,
      statement: `synthetic record ${i}: deterministic retrieval engine binding for module impl-${i}`,
      text: `body text for record ${i}: parseMemoryRecord validateMemoryQueryV1 storeSnapshotDigest`,
      trust: i % 3 === 0 ? "REVIEWED" : i % 3 === 1 ? "CONFIRMED" : "VERIFIED",
      knowledgeKind: "FILE",
    });
    const v = validateMemoryRecordV1(rec, { authorizedDirs: [] });
    if (!v.valid) throw new Error(`record ${i} invalid: ${v.errors.join(";")}`);
    store.explicitImport(rec);
  }
  results.importRecords = N;
  results.importMs = ms(tImport);
  results.importRecPerSec = Math.round(N / (results.importMs / 1000));
  const journalBytes = statSync(join(root, "journal.jsonl")).size;
  const dbBytes = statSync(join(root, "memory.db")).size;
  results.journalBytes = journalBytes;
  results.dbBytes = dbBytes;
  results.rssAfterImport = rss();

  // ── store open（cold reopen, parity verified）───────────────────────────
  store.close();
  const tOpen = performance.now();
  const s2 = new LocalMemoryStore({ stateRoot: root, log: silent });
  s2.open();
  results.openMs = ms(tOpen);
  results.openParityOk = s2.verifyJournalParity().ok;

  // ── snapshot digest（10k-record projection）──────────────────────────────
  const tSnap = performance.now();
  const snap = s2.snapshot();
  results.snapshotMs = ms(tSnap);
  results.snapshotDigest = snap.storeSnapshotDigest;
  results.recordCount = snap.recordCount;

  // ── exact lookup（recordId point lookup）─────────────────────────────────
  const probe = codeRecord({ path: "src/x.mjs", statement: "probe", text: "probe" });
  const tGet = performance.now();
  const got = s2.get(probe.recordId);
  results.exactLookupMs = ms(tGet);
  results.exactLookupFound = got !== null;

  // ── path+symbol lookup（indexed query）───────────────────────────────────
  const tPath = performance.now();
  const pathQ = validateMemoryQueryV1({
    schema: MEMORY_QUERY_SCHEMA,
    context: { repository: REPO, tree: TREE },
    path: "src/mod00042/impl-42.mjs",
    symbol: "symbol42",
    trustFloor: "VERIFIED",
  }).query;
  const pathR = s2.query(pathQ);
  results.pathLookupMs = ms(tPath);
  results.pathLookupFound = pathR.selectedRecords.length >= 1;

  // ── FTS candidate query（lexical terms）──────────────────────────────────
  const tFts = performance.now();
  const ftsQ = validateMemoryQueryV1({
    schema: MEMORY_QUERY_SCHEMA,
    context: { repository: REPO, tree: TREE },
    terms: "deterministic retrieval engine",
    trustFloor: "VERIFIED",
  }).query;
  const ftsR = s2.query(ftsQ);
  results.ftsQueryMs = ms(tFts);
  results.ftsSelected = ftsR.selectedRecords.length;

  // ── deterministic retrieval（full query, bounded limits）──────────────────
  const tRet = performance.now();
  const fullQ = validateMemoryQueryV1({
    schema: MEMORY_QUERY_SCHEMA,
    context: { repository: REPO, tree: TREE },
    terms: "deterministic binding",
    trustFloor: "VERIFIED",
  }).query;
  const fullR = s2.query(fullQ);
  results.deterministicRetrievalMs = ms(tRet);
  results.retrievalSelected = fullR.selectedRecords.length;
  results.retrievalDigest = fullR.retrievalDigest;
  results.truncated = fullR.truncated;

  // ── repeat determinism under load ────────────────────────────────────────
  const tRep = performance.now();
  const rA = s2.query(fullQ);
  const rB = s2.query(fullQ);
  results.repeatDeterministic = rA.retrievalDigest === rB.retrievalDigest;
  results.repeatMs = ms(tRep);
  results.rssAfterQueries = rss();

  s2.close();
  rmSync(root, { recursive: true, force: true });

  console.log(JSON.stringify({
    schema: "autoloop.cbm3.memory-probe/v1",
    dataset: { records: N, journalBytes, dbBytes },
    measurements: {
      importMs: results.importMs,
      importRecPerSec: results.importRecPerSec,
      openMs: results.openMs,
      openParityOk: results.openParityOk,
      snapshotMs: results.snapshotMs,
      exactLookupMs: results.exactLookupMs,
      exactLookupFound: results.exactLookupFound,
      pathLookupMs: results.pathLookupMs,
      pathLookupFound: results.pathLookupFound,
      ftsQueryMs: results.ftsQueryMs,
      ftsSelected: results.ftsSelected,
      deterministicRetrievalMs: results.deterministicRetrievalMs,
      retrievalSelected: results.retrievalSelected,
      truncated: results.truncated,
      repeatDeterministic: results.repeatDeterministic,
      repeatMs: results.repeatMs,
    },
    resource: {
      rssAfterImportMiB: results.rssAfterImport,
      rssAfterQueriesMiB: results.rssAfterQueries,
      rssDeltaMiB: results.rssAfterQueries - results.rssAfterImport,
    },
    determinism: {
      snapshotDigest: results.snapshotDigest,
      retrievalDigest: results.retrievalDigest,
    },
    notes: [
      "isolated temp store root; production store untouched",
      "journal append fsync per import（durability contract）— import is NOT the measured hot path",
      "queries hit indexed sqlite + FTS5; no full DB serialization per query",
      "no network; no external dependencies",
    ],
  }, null, 2));
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
