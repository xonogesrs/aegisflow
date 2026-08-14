// test/memory/test-writeback-closed-loop.mjs
//
// CBM-4 Stage 11 — RETRIEVE → EXECUTE → WRITE-BACK → RETRIEVE closed loop.
//
//   Run A: memory does NOT have the knowledge → task executes → verified /
//          reviewer PASS → governed write-back writes the memory.
//   Run B: a NEW graph run retrieves Run A's memory via the CBM-3 retrieval
//          contract — repository scope correct, worktree isolation correct,
//          trust correct, retrievalDigest deterministic, memoryContext is
//          DATA, and task authority is never changed by memory.
//
// This is CBM-4's most important production acceptance.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore, MEMORY_QUERY_SCHEMA, validateMemoryQueryV1, TRUST_RANK } from "../../src/memory/index.mjs";
import { buildMemoryContext } from "../../src/memory/graph-context.mjs";
import { runGraphWriteback } from "../../src/memory/writeback/graph.mjs";

const ROOTS = [];
function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), "cbm4-loop-"));
  ROOTS.push(r);
  return r;
}
const silent = { info() {}, warn() {}, error() {} };
const REPO = "1".repeat(64);
const TREE = "5".repeat(40);
const REVIEW_ID = "c".repeat(64);
const VERIFIER_ID = "b".repeat(64);
const RUN_A = "cbm4-loop-run-A";
const RUN_B = "cbm4-loop-run-B";

before(() => {});
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function runAGraphResult() {
  // Run A: writer changed docs/out.mjs; independent review PASS; closeout PASS
  return {
    executionId: RUN_A,
    final: "PASS",
    holdCode: null,
    treeSha: TREE,
    commitSha: "7".repeat(40),
    memoryContext: { state: "EMPTY_MEMORY" }, // Run A starts with no memory
    nodeResults: [
      {
        nodeId: "SA-W1",
        phaseExecutionId: `exec_${RUN_A}`,
        taskType: "writer",
        attempt: 1,
        final: "PASS",
        reviewResult: { recommendedAction: "PASS", blockingFindings: [], summary: "independent review PASS", resultIdentity: REVIEW_ID },
        worktreeIdentity: { output: { files: [{ path: "docs/out.mjs" }, { path: "src/lib.mjs" }] } },
      },
      {
        nodeId: "SA-V1",
        phaseExecutionId: `exec_${RUN_A}-v1`,
        taskType: "verifier",
        attempt: 0,
        final: "PASS",
        resultIdentity: VERIFIER_ID,
      },
    ],
    transitions: [],
    closeout: { applied: true, final: "PASS", bundle: { identity: "9".repeat(64) } },
  };
}

test("CL1. Run A writes governed memory（EXECUTION + CODE, REVIEWED trust）", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const r = await runGraphWriteback({
    graphResult: runAGraphResult(),
    store: s,
    expectedRepository: REPO,
    reviewIdentity: REVIEW_ID,
    verifierIdentity: VERIFIER_ID,
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcomes.length, 3, "1 EXECUTION + 2 CODE candidates");
  const accepted = r.outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED");
  assert.equal(accepted.length, 3, JSON.stringify(r.outcomes));
  assert.equal(r.statusCounts.WRITEBACK_ACCEPTED, 3);
  // trust is REVIEWED（independent review identity bound）
  for (const o of accepted) {
    const rec = s.get(o.recordId);
    assert.equal(rec.trust, "REVIEWED", "reviewer-backed trust");
    assert.equal(rec.validity.status, "CURRENT");
    assert.equal(rec.evidence.reviewResultIdentity, REVIEW_ID);
  }
  s.close();
});

test("CL2. Run B retrieves Run A's memory（repository scope, trust, deterministic digests, DATA-only）", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const rA = await runGraphWriteback({
    graphResult: runAGraphResult(),
    store: s,
    expectedRepository: REPO,
    reviewIdentity: REVIEW_ID,
    verifierIdentity: VERIFIER_ID,
  });
  assert.equal(rA.outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED").length, 3);
  const snapshot1 = s.snapshot();
  s.close();

  // ── Run B: a NEW graph run retrieves Run A's memory ────────────────────
  const s2 = new LocalMemoryStore({ stateRoot: root, log: silent });
  s2.open();
  const query = {
    schema: MEMORY_QUERY_SCHEMA,
    context: { repository: REPO, tree: TREE, graphRunId: RUN_A },
    trustFloor: "VERIFIED",
    validityPolicy: "CURRENT",
    conflictPolicy: "SURFACE",
    limits: { maxRecords: 50, maxBytes: 65536 },
  };
  const v = validateMemoryQueryV1(query);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const retrieval = s2.query(v.query);
  // Run A's records are retrievable（REVIEWED >= VERIFIED floor; CURRENT）
  assert.ok(retrieval.selectedRecords.length >= 3, `expected >=3 selected, got ${retrieval.selectedRecords.length}`);
  const selectedIds = retrieval.selectedRecords.map((x) => x.recordId);
  for (const o of rA.outcomes.filter((x) => x.status === "WRITEBACK_ACCEPTED")) {
    assert.ok(selectedIds.includes(o.recordId), `Run A record ${o.recordId.slice(0, 8)} retrievable in Run B`);
  }
  // repository isolation: a DIFFERENT repo cannot see Run A's memory
  const crossRepo = {
    schema: MEMORY_QUERY_SCHEMA,
    context: { repository: "2".repeat(64), tree: TREE },
    trustFloor: "VERIFIED",
    validityPolicy: "CURRENT",
    conflictPolicy: "SURFACE",
    limits: { maxRecords: 50, maxBytes: 65536 },
  };
  const cv = validateMemoryQueryV1(crossRepo);
  const cross = s2.query(cv.query);
  assert.equal(cross.selectedRecords.length, 0, "cross-repo isolation holds");
  // digest determinism: repeat query -> identical retrievalDigest + snapshot
  const r2 = s2.query(v.query);
  assert.equal(r2.retrievalDigest, retrieval.retrievalDigest, "retrievalDigest deterministic across repeats");
  assert.equal(r2.storeSnapshotDigest, retrieval.storeSnapshotDigest);
  const snapshot2 = s2.snapshot();
  assert.equal(snapshot2.storeSnapshotDigest, snapshot1.storeSnapshotDigest, "store snapshot digest stable across reopen");
  // memoryContext is DATA（never instructions; authority boundary explicit）
  const ctx = buildMemoryContext({ retrieval, repository: { repositoryIdentity: REPO } });
  assert.equal(ctx.kind, "MEMORY_CONTEXT_DATA");
  assert.equal(ctx.state, "AVAILABLE");
  assert.ok(String(ctx.authorityBoundary).includes("DATA"));
  assert.ok(String(ctx.authorityBoundary).includes("never overrides"), "authority boundary: memory never overrides governance");
  assert.ok(!String(ctx.authorityBoundary).includes("always obeys memory"), "no instruction semantics");
  // task authority unchanged: memory carries no scheduler/instruction payloads
  assert.ok(!JSON.stringify(ctx.selectedRecords).includes("instruction"), "no instruction payload in selected records");
  s2.close();
});

test("CL3. closed-loop idempotency: repeated closeout of the same graph -> no duplicate trusted records", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const r1 = await runGraphWriteback({ graphResult: runAGraphResult(), store: s, expectedRepository: REPO, reviewIdentity: REVIEW_ID, verifierIdentity: VERIFIER_ID });
  const r2 = await runGraphWriteback({ graphResult: runAGraphResult(), store: s, expectedRepository: REPO, reviewIdentity: REVIEW_ID, verifierIdentity: VERIFIER_ID });
  const a1 = r1.outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED").length;
  const d2 = r2.outcomes.filter((o) => o.status === "WRITEBACK_DUPLICATE").length;
  assert.equal(a1, 3);
  assert.equal(d2, 3, "repeated closeout is idempotent (DUPLICATE, no new records)");
  const all = s.db.prepare("SELECT COUNT(*) n FROM memory_records WHERE validity_status='CURRENT'").get().n;
  assert.equal(all, 3, "exactly the Run A records exist as CURRENT");
  s.close();
});

test("CL4. trust ladder: Run A EXECUTION memory never exceeds REVIEWED; no CONFIRMED anywhere", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const r = await runGraphWriteback({ graphResult: runAGraphResult(), store: s, expectedRepository: REPO, reviewIdentity: REVIEW_ID, verifierIdentity: VERIFIER_ID });
  for (const o of r.outcomes) {
    const rec = o.recordId ? s.get(o.recordId) : null;
    if (rec) assert.ok(TRUST_RANK[rec.trust] <= TRUST_RANK.REVIEWED, `${rec.trust} <= REVIEWED`);
  }
  const confirmed = s.db.prepare("SELECT COUNT(*) n FROM memory_records WHERE trust='CONFIRMED'").get().n;
  assert.equal(confirmed, 0, "no CONFIRMED auto-written");
  s.close();
});
