// test/memory/test-graph-colima-writeback.mjs
//
// CBM-3 §22, §33 — Graph read-only integration + ZERO automatic write-back,
// on the REAL colima pipeline（single full clean run; part of test:colima-all）.
//
//   task executes（read-only phase on the pinned colima instance）
//     → memory is READ（AVAILABLE memoryContext on result + node + phase runtime）
//     → memory store record count UNCHANGED
//     → journal UNCHANGED（byte-identical）
//
// The only writes in the system are the test's OWN explicit imports（card §33:
// production Graph runs must have zero implicit memory writes）.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runColimaGraph } from "../../src/runtime/colima-graph-runner.mjs";
import {
  LocalMemoryStore,
  createGraphMemoryProvider,
  resolveRepositoryIdentity,
  validateMemoryRecordV1,
  MEMORY_RECORD_SCHEMA,
  deriveContentHash,
  deriveMemoryRecordId,
} from "../../src/memory/index.mjs";

const HOME = homedir();
const REPO_A = "/Volumes/NVM2T/Development/autoloop";
const SCRATCH = `${HOME}/autoloop-cbm3-graph-writeback-scratch`;
const PROFILE = "autoloop-graph";
const PARENT = { scope: { allowed_paths: ["docs/"], forbidden_paths: [".git"] } };

const ROOT = mkdtempSync(join("/tmp", "cbm3-colima-memory-"));
const silent = { info() {}, warn() {}, error() {} };

function buildVerifiedRecord(repoId, treeSha) {
  const T = "2026-08-07T00:00:00.000Z";
  const rec = {
    schema: MEMORY_RECORD_SCHEMA,
    recordType: "CODE",
    identity: { repositoryIdentity: repoId, commitSha: "b".repeat(40), treeSha, path: "src/memory/retrieval.mjs", knowledgeKind: "FILE" },
    subject: { statement: "deterministic retrieval engine binds repo tree identity", contentHash: null, language: "javascript" },
    content: { kind: "TEXT", text: "CBM-3 read-only graph integration fixture." },
    source: { source: "REPOSITORY", identity: "d".repeat(64) },
    scope: { repository: repoId, tree: treeSha, path: "src/memory/retrieval.mjs" },
    trust: "VERIFIED",
    validity: { status: "CURRENT", validityTree: treeSha },
    lifecycle: { events: [] },
    timestamps: { createdAt: T, updatedAt: T },
    evidence: { manifestDigest: "a".repeat(64), verifierResultIdentity: "b".repeat(64), items: [] },
    security: { scanResult: "clean", ingestionSource: "colima-writeback-test" },
    metadata: {},
  };
  rec.subject.contentHash = deriveContentHash(rec.content);
  rec.recordId = deriveMemoryRecordId(rec);
  return rec;
}

const ir = {
  phases: [
    {
      phase_id: "R1",
      depends_on: [],
      effects: { artifact_mutation: "none" },
      runtime: {
        mode: "readonly",
        command: 'echo "CBM3_MEMORY_READ_ONLY_DONE"; [ ! -e /var/run/docker.sock ] && echo NO_SOCKET',
        expect: { stdoutContains: ["CBM3_MEMORY_READ_ONLY_DONE", "NO_SOCKET"] },
        limits: { memoryMiB: 256, timeoutMs: 60000 },
      },
    },
  ],
};

let store;
let journalPath;
let journalBefore;
let countBefore;

before(() => {
  const id = resolveRepositoryIdentity(REPO_A);
  store = new LocalMemoryStore({ stateRoot: ROOT, log: silent });
  store.open();
  const rec = buildVerifiedRecord(id.repositoryIdentity, id.treeSha);
  const v = validateMemoryRecordV1(rec, { authorizedDirs: [] });
  if (!v.valid) throw new Error(`fixture invalid: ${v.errors.join(";")}`);
  store.explicitImport(rec);
  journalPath = store.journalPath;
  journalBefore = readFileSync(journalPath, "utf8");
  countBefore = store.snapshot().recordCount;
  store.close();
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
});

test("graph reads memory; zero automatic write-back; AVAILABLE context on result + node + phase runtime", { timeout: 600000 }, async (t) => {
  const memory = {
    provider: createGraphMemoryProvider({ stateRoot: ROOT, log: silent }),
  };
  const r = await runColimaGraph({
    ir,
    parent: PARENT,
    cwd: REPO_A,
    executionId: "cbm3-graph-writeback",
    profile: PROFILE,
    repoPath: REPO_A,
    scratchRoot: SCRATCH,
    timeoutMs: 90000,
    memory,
  });
  assert.equal(r.final, "PASS", `graph PASS expected, got ${r.final} (${r.reason})`);
  // memory was READ and surfaced as structured DATA context
  assert.equal(r.memoryContext.state, "AVAILABLE", "memoryContext AVAILABLE");
  assert.equal(r.memoryContext.kind, "MEMORY_CONTEXT_DATA");
  assert.ok(r.memoryContext.selectedRecords.length >= 1, "repo-bound record selected");
  assert.ok(r.memoryContext.selectedRecords.some((x) => x.scope.path === "src/memory/retrieval.mjs"));
  // node result carries the same context
  const node = r.nodeResults.find((n) => n.nodeId === "R1");
  assert.equal(node.memoryContext.state, "AVAILABLE");
  // zero automatic write-back
  const journalAfter = readFileSync(journalPath, "utf8");
  assert.equal(journalAfter, journalBefore, "journal byte-identical after the graph run (zero write-back)");
  const s = new LocalMemoryStore({ stateRoot: ROOT, log: silent });
  s.open();
  assert.equal(s.snapshot().recordCount, countBefore, "record count unchanged");
  s.close();
});
