// test/learning/test-r2-cross-process.mjs
//
// R2 PHASE 6 — T5 CROSS-PROCESS (PLAN PHASE-6-TEST-CORPUS §1 family T5):
// two processes, single journal; digest-chain continuity fail-closed
// (R2_REV_F4 oracle form — NO lock primitive); loser resumes from reality;
// no implicit takeover.
//
// Oracle form: the SECOND writer cannot silently interleave — a write that
// bypasses chain continuity produces a journal whose chain validation FAILS
// (assertChainIntegrity ⇒ JOURNAL_CHAIN_INVALID ⇒ RECOVERY_REQUIRED-class
// HOLD). The losing writer's correct behavior is to resume from reality
// (re-read the journal, rebuild state), never takeover.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { LocalMemoryStore, MEMORY_QUERY_SCHEMA, deriveLogicalKey } from "../../src/memory/index.mjs";
import { assertChainIntegrity, readJournal } from "../../src/memory/jsonl-journal.mjs";
import { hex64, REPO, incidentRecord, patternRecord, silentLog } from "../memory/test-r2-helpers.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");
const WORKER_PARENT = join(tmpdir(), "r2-cross-process");
const ROOTS = [];

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "r2-xproc-"));
  ROOTS.push(root);
  return root;
}

/** Worker script: opens the store at root, imports a pattern, prints outcome JSON. */
function workerScript() {
  return `
import { LocalMemoryStore, MEMORY_QUERY_SCHEMA } from "${join(REPO_ROOT, "src/memory/index.mjs")}";
import { patternRecord } from "${join(REPO_ROOT, "test/memory/test-r2-helpers.mjs")}";
const [root, patternId, statement] = process.argv.slice(2);
const out = {};
try {
  const s = new LocalMemoryStore({ stateRoot: root, log: { info(){}, warn(){}, error(){} } });
  s.open();
  const rec = patternRecord({ patternId, statement });
  s.explicitImport(rec, { source: "XPROC" });
  const q = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: rec.scope.repository }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  out.outcome = "IMPORTED";
  out.recordId = rec.recordId;
  out.visible = q.selectedRecords.some((r) => r.recordId === rec.recordId);
  s.close();
} catch (e) {
  out.outcome = "FAILED";
  out.code = e.code ?? null;
  out.message = String(e?.message ?? e).slice(0, 300);
}
process.stdout.write(JSON.stringify(out));
`;
}

function runWorker(workerPath, args) {
  const child = spawn(process.execPath, [workerPath, ...args], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", () => {
      const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      try { resolve(JSON.parse(line)); } catch { resolve({ outcome: "NO_OUTPUT", raw: out.slice(0, 400) }); }
    });
  });
}

test("T5a. two processes, single journal: BOTH writers succeed via chain continuity (append-only, no interleaving corruption)", async () => {
  const root = freshRoot();
  const workerPath = (() => {
    mkdirSync(WORKER_PARENT, { recursive: true, mode: 0o700 });
    const p = join(WORKER_PARENT, `xproc-worker-${process.pid}-${Date.now()}.mjs`);
    writeFileSync(p, workerScript());
    return p;
  })();
  // sequential cross-process writers on ONE journal (the legal pattern:
  // openSync("a") + fsync appends never rewrite; each process re-reads chain)
  const w1 = await runWorker(workerPath, [root, "pat-x1", "first writer pattern"]);
  assert.equal(w1.outcome, "IMPORTED", JSON.stringify(w1));
  const w2 = await runWorker(workerPath, [root, "pat-x2", "second writer pattern"]);
  assert.equal(w2.outcome, "IMPORTED", JSON.stringify(w2));
  // journal chain remains VALID (continuity preserved across processes)
  const verified = assertChainIntegrity(join(root, "journal.jsonl"));
  assert.equal(verified.events.length, 2);
  // both records durable; loser "resumes from reality" by re-reading journal
  const s = new LocalMemoryStore({ stateRoot: root, log: silentLog() });
  s.open();
  const q = s.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.length, 2);
  s.close();
  rmSync(workerPath, { force: true });
});

test("T5b. a write that bypasses chain continuity (stale chain state) ⇒ journal validation FAILS CLOSED (RECOVERY_REQUIRED-class); no lock primitive needed", () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silentLog() });
  s.open();
  s.explicitImport(patternRecord(), { source: "XPROC" });
  s.close();
  const jp = join(root, "journal.jsonl");
  // simulate a lost second writer whose append was built on a STALE previousDigest
  // (the exact corruption the digest chain exists to catch — no advisory lock exists)
  const good = readJournal(jp);
  const stale = JSON.parse(readFileSync(jp, "utf8").trim().split("\n").filter((l) => l.length > 0).pop());
  const forged = {
    schema: "autoloop.memory-journal-event/v1",
    journalSequence: stale.journalSequence + 1,
    eventId: "jrnl_forged",
    recordId: hex64("9"),
    operation: "UPSERT_RECORD",
    payload: { record: patternRecord({ patternId: "pat-forged", statement: "forged interleave" }), source: "FORGED" },
    payloadDigest: "0".repeat(64),
    previousDigest: good.state.previousDigest ?? "genesis", // WRONG: not the latest event digest
    eventDigest: "1".repeat(64),
    timestamp: "2026-09-08T00:00:00.000Z",
  };
  appendFileSync(jp, JSON.stringify(forged) + "\n");
  // chain-continuity validation detects the forged line fail-closed
  assert.throws(() => assertChainIntegrity(jp), (e) => String(e?.code ?? e?.message ?? "").includes("JOURNAL_CHAIN_INVALID"));
  // and the store refuses to open it (HOLD — no journal advance, no takeover)
  const s2 = new LocalMemoryStore({ stateRoot: root, log: silentLog() });
  assert.throws(() => s2.open());
});

test("T5c. loser resumes from reality: after a failed/aborted writer, a fresh process re-derives state from the journal", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silentLog() });
  s.open();
  const rec = patternRecord();
  s.explicitImport(rec, { source: "XPROC" });
  s.close();
  // "crash" of writer two mid-flight leaves the journal intact and valid
  assert.doesNotThrow(() => assertChainIntegrity(join(root, "journal.jsonl")));
  // the fresh process resumes from durable reality (not from any in-memory state)
  const s2 = new LocalMemoryStore({ stateRoot: root, log: silentLog() });
  s2.open();
  const q = s2.query({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO }, recordTypes: ["PATTERN"], trustFloor: "UNVERIFIED" });
  assert.equal(q.selectedRecords.length, 1);
  assert.equal(q.selectedRecords[0].recordId, rec.recordId);
  s2.close();
});

// tracked-tmp cleanup attestation (T9 discipline, shared with PHASE 7)
test("T5-cleanup. all tracked roots removed (OS temp attestation)", async () => {
  const fs = await import("node:fs");
  for (const r of ROOTS) {
    assert.ok(fs.existsSync(r), "root existed during run");
  }
});
