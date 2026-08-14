// test/memory/test-writeback-graph.mjs
//
// CBM-4 Stage 13 — Graph integration: write-back happens ONLY after the
// final verified/reviewed boundary; writer self-claims never become CODE
// memory; HOLD graphs record execution history but never unproven CODE
// truth; telemetry is recorded from the first write-back.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore } from "../../src/memory/index.mjs";
import { runGraphWriteback } from "../../src/memory/writeback/graph.mjs";
import { TelemetryStore } from "../../src/telemetry/store.mjs";

const ROOTS = [];
function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), "cbm4-graph-"));
  ROOTS.push(r);
  return r;
}
const silent = { info() {}, warn() {}, error() {} };
const REPO = "1".repeat(64);
const TREE = "5".repeat(40);
const REVIEW_ID = "c".repeat(64);
const VERIFIER_ID = "b".repeat(64);

before(() => {});
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

function graphResult({ final = "PASS", closeoutFinal = "PASS", writerReview = "PASS", writerFiles = ["docs/out.mjs"], nodeCount = 2 } = {}) {
  const nodeResults = [];
  for (let i = 0; i < nodeCount; i++) {
    nodeResults.push({ nodeId: `SA-R${i + 1}`, phaseExecutionId: `p${i}`, taskType: "readonly-analyst", attempt: 0, final: "PASS" });
  }
  nodeResults.push({
    nodeId: "SA-W1",
    phaseExecutionId: "p-w1",
    taskType: "writer",
    attempt: 1,
    final: writerReview === "REPAIR" ? "REPAIR" : "PASS",
    reviewResult: writerReview === "REPAIR"
      ? { recommendedAction: "REPAIR", blockingFindings: ["missing evidence"], summary: "independent review REPAIR", resultIdentity: REVIEW_ID }
      : { recommendedAction: "PASS", blockingFindings: [], summary: "independent review PASS", resultIdentity: REVIEW_ID },
    worktreeIdentity: { output: { files: writerFiles.map((path) => ({ path })) } },
  });
  nodeResults.push({ nodeId: "SA-V1", phaseExecutionId: "p-v1", taskType: "verifier", attempt: 0, final: "PASS", resultIdentity: VERIFIER_ID });
  return {
    executionId: `g-${final}`,
    final,
    holdCode: final === "HOLD" ? "MEMORY_STORE_INVALID" : null,
    treeSha: TREE,
    commitSha: "7".repeat(40),
    nodeResults,
    transitions: [],
    closeout: { applied: true, final: closeoutFinal, bundle: { identity: "9".repeat(64) } },
  };
}

test("G1. PASS graph + review PASS -> EXECUTION + CODE write-back with REVIEWED trust; telemetry recorded", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const t = new TelemetryStore({ stateRoot: freshRoot() });
  t.open();
  const r = await runGraphWriteback({
    graphResult: graphResult(),
    store: s,
    telemetryStore: t,
    expectedRepository: REPO,
    reviewIdentity: REVIEW_ID,
    verifierIdentity: VERIFIER_ID,
  });
  assert.equal(r.ok, true);
  const accepted = r.outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED");
  assert.equal(accepted.length, 2, JSON.stringify(r.outcomes)); // 1 EXECUTION + 1 CODE
  for (const o of accepted) {
    const rec = s.get(o.recordId);
    assert.equal(rec.trust, "REVIEWED");
  }
  // telemetry from the FIRST write-back
  const events = t.readAll();
  const wb = events.filter((e) => e.eventType === "memory.writeback");
  assert.equal(wb.length, 1);
  assert.equal(wb[0].writeback.acceptedCount, 2);
  assert.ok(wb[0].writeback.memoryRecordIdentity, "record identity recorded");
  t.close();
  s.close();
});

test("G2. writer self-claim without verifier/reviewer evidence -> CODE never written（EXECUTION still recorded）", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  // review PASS but NO review/verifier identity bindings -> CODE trust ceiling
  // cannot be reached -> no CODE write-back; EXECUTION stays VERIFIED
  const r = await runGraphWriteback({ graphResult: graphResult(), store: s, expectedRepository: REPO, reviewIdentity: null, verifierIdentity: null });
  assert.equal(r.ok, true);
  const accepted = r.outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED");
  // EXECUTION（graph_closeout origin, UNVERIFIED ceiling ok）accepted; CODE
  // candidates are never even PROPOSED without verifier/reviewer evidence
  //（source map: writer/verifier self-claims are not write-back-permitted）
  assert.equal(accepted.length, 1, JSON.stringify(r.outcomes));
  assert.equal(r.outcomes.filter((o) => o.candidateType === "CODE").length, 0, "no CODE candidates without evidence");
  const codeCount = s.db.prepare("SELECT COUNT(*) n FROM memory_records WHERE record_type='CODE'").get().n;
  assert.equal(codeCount, 0, "no CODE memory written from a bare writer claim");
  const rec = s.get(accepted[0].recordId);
  assert.equal(rec.trust, "UNVERIFIED", "execution history, no fabricated verification");
  s.close();
});

test("G3. REPAIR-final writer review -> no trusted CODE truth from a failed candidate", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const r = await runGraphWriteback({
    graphResult: graphResult({ writerReview: "REPAIR", closeoutFinal: "PASS" }),
    store: s,
    expectedRepository: REPO,
    reviewIdentity: REVIEW_ID,
    verifierIdentity: VERIFIER_ID,
  });
  // the repair-era writer review is NOT PASS -> no CODE write-back; the graph
  // final is PASS so EXECUTION memory is still recorded
  const codeAccepted = r.outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED" && o.candidateType === "CODE");
  assert.equal(codeAccepted.length, 0, "no CODE memory from a non-PASS review");
  const execAccepted = r.outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED" && o.candidateType === "EXECUTION");
  assert.equal(execAccepted.length, 1);
  s.close();
});

test("G4. HOLD graph -> execution history only; no unproven CODE truth", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const r = await runGraphWriteback({
    graphResult: graphResult({ final: "HOLD", closeoutFinal: "HOLD" }),
    store: s,
    expectedRepository: REPO,
    reviewIdentity: REVIEW_ID,
    verifierIdentity: VERIFIER_ID,
  });
  const accepted = r.outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED");
  // closeout NOT PASS -> CODE never written; EXECUTION history allowed
  const code = accepted.filter((o) => o.candidateType === "CODE");
  assert.equal(code.length, 0);
  const exec = accepted.filter((o) => o.candidateType === "EXECUTION");
  assert.equal(exec.length, 1, "execution history recorded for a HOLD graph");
  assert.ok(s.get(exec[0].recordId).validity.status === "CURRENT");
  s.close();
});

test("G5. graph write-back failure never changes the graph outcome（passive side effect）", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  const gr = graphResult();
  const decidedVerdict = gr.final;
  // store closed AFTER the graph decided -> write-back fails, verdict intact
  s.close();
  const r = await runGraphWriteback({ graphResult: gr, store: s, expectedRepository: REPO, reviewIdentity: REVIEW_ID, verifierIdentity: VERIFIER_ID });
  assert.ok(r.outcomes.every((o) => o.status !== "WRITEBACK_ACCEPTED"), "no accepted writes on a broken store");
  assert.equal(gr.final, decidedVerdict, "graph verdict untouched");
  assert.equal(gr.closeout.final, "PASS", "closeout outcome untouched");
});

test("G6. write-back through the real runColimaGraph wiring（post-result, opt-in, passive）", async () => {
  // The wiring contract is structural: runColimaGraph accepts the opt-in
  // `writeback` param and runs it AFTER the result is final. Verify the
  // wiring exists and is post-result + try/catch-wrapped（same passive
  // contract as telemetry）.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(process.cwd(), "src/runtime/colima-graph-runner.mjs"), "utf8");
  const resultIdx = src.indexOf("const result = {");
  const wbIdx = src.indexOf("CBM-4 governed memory write-back（POST-final, opt-in）");
  assert.ok(resultIdx !== -1 && wbIdx !== -1, "writeback wiring present");
  assert.ok(wbIdx > resultIdx, "writeback runs AFTER the result is final");
  assert.ok(src.includes("result.writeback = await runGraphWriteback"), "runGraphWriteback wired");
  assert.ok(src.includes("result.writeback = { ok: false"), "failure degrades, never throws");
});

test("G7. well-formed but NONEXISTENT verifier identity -> no trusted record（bound to the graph's canonical inventory）", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  // attacker supplies a format-perfect 64-hex identity the graph never produced
  const forged = "a".repeat(64);
  const r = await runGraphWriteback({
    graphResult: graphResult(),
    store: s,
    expectedRepository: REPO,
    reviewIdentity: REVIEW_ID,
    verifierIdentity: forged,
  });
  assert.equal(r.ok, true);
  const accepted = r.outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED");
  assert.equal(accepted.length, 0, `no record may be written on a forged identity: ${JSON.stringify(r.outcomes)}`);
  for (const o of r.outcomes) {
    assert.ok(
      o.status === "WRITEBACK_AUTHORITY_INSUFFICIENT" || o.status === "WRITEBACK_DUPLICATE" || o.status === "WRITEBACK_CONFLICT",
      `unexpected ${o.status}`,
    );
    if (o.status === "WRITEBACK_AUTHORITY_INSUFFICIENT") {
      assert.ok(String(o.reason).includes("not_in_canonical_inventory"), `reason=${o.reason}`);
    }
  }
  const n = s.db.prepare("SELECT COUNT(*) n FROM memory_records").get().n;
  assert.equal(n, 0, "forged verifier identity wrote nothing");
  s.close();
});

test("G8. reviewer identity from ANOTHER graph -> rejected; canonical-for-this-graph identity -> accepted", async () => {
  const root = freshRoot();
  const s = new LocalMemoryStore({ stateRoot: root, log: silent });
  s.open();
  // (a) review identity canonical for a DIFFERENT graph run — rejected
  const otherReview = "d".repeat(64);
  const rForeign = await runGraphWriteback({
    graphResult: graphResult(),
    store: s,
    expectedRepository: REPO,
    reviewIdentity: otherReview,
    verifierIdentity: VERIFIER_ID,
  });
  const acceptedForeign = rForeign.outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED");
  assert.equal(acceptedForeign.length, 0, JSON.stringify(rForeign.outcomes));
  // (b) same graph, canonical REVIEW_ID + VERIFIER_ID（attested in nodeResults）— accepted
  const rOk = await runGraphWriteback({
    graphResult: graphResult(),
    store: s,
    expectedRepository: REPO,
    reviewIdentity: REVIEW_ID,
    verifierIdentity: VERIFIER_ID,
  });
  const acceptedOk = rOk.outcomes.filter((o) => o.status === "WRITEBACK_ACCEPTED");
  assert.equal(acceptedOk.length, 2, JSON.stringify(rOk.outcomes)); // 1 EXECUTION + 1 CODE
  for (const o of acceptedOk) assert.equal(s.get(o.recordId).trust, "REVIEWED");
  s.close();
});
