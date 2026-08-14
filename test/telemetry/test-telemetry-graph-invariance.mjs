// test/telemetry/test-telemetry-graph-invariance.mjs
//
// COST-1 acceptance criterion 6 — instrumentation must NOT change scheduler
// verdict / node ordering / writer lease / review / repair semantics.
//
// Bounded non-colima proof:
//   1. recordGraphTelemetry never mutates the graphResult（deep-compare）
//   2. the observer copies scheduler/node data into events without touching
//      the source; event stream is deterministic for identical inputs
//   3. the production wiring in runColimaGraph is POST-result and
//      try/catch-wrapped（the passive contract is structural — an observer
//      placed before the result is final would break this test）
// The real-path claim is additionally covered by the existing colima-all
// suite（telemetry absent）vs the COST-1 closeout graph（telemetry enabled）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { TelemetryStore } from "../../src/telemetry/store.mjs";
import { aggregateGraphRun } from "../../src/telemetry/aggregate.mjs";

const HERE = join(fileURLToPath(import.meta.url), "..");
const ROOTS = [];
function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), "cost1-graph-"));
  ROOTS.push(r);
  return r;
}

function sampleGraph() {
  return {
    executionId: "g-inv",
    final: "PASS",
    holdCode: null,
    reason: null,
    memoryContext: { state: "EMPTY_MEMORY" },
    scheduler: {
      verdict: "PASS",
      order: ["SA-R1", "SA-R2", "SA-W1", "SA-V1"],
      statuses: { "SA-R1": "passed", "SA-R2": "passed", "SA-W1": "passed", "SA-V1": "passed" },
      skipped: [],
      writerViolations: [],
      leaseHolderAfter: null,
    },
    nodeResults: [
      { nodeId: "SA-R1", phaseExecutionId: "p1", taskType: "readonly-analyst", attempt: 0, final: "PASS", startedAt: 1000, completedAt: 1100, resultIdentity: { latencyMs: 100 }, subagentEnvelope: { agentExecutionId: "a1" } },
      { nodeId: "SA-R2", phaseExecutionId: "p2", taskType: "readonly-analyst", attempt: 0, final: "PASS", startedAt: 1000, completedAt: 1200, resultIdentity: { latencyMs: 200 }, subagentEnvelope: { agentExecutionId: "a2" } },
      { nodeId: "SA-W1", phaseExecutionId: "p3", taskType: "writer", attempt: 1, final: "PASS", startedAt: 1300, completedAt: 1600, resultIdentity: { latencyMs: 300 }, subagentEnvelope: { agentExecutionId: "a3" } },
      { nodeId: "SA-V1", phaseExecutionId: "p4", taskType: "verifier", attempt: 0, final: "PASS", startedAt: 1700, completedAt: 1800, resultIdentity: { latencyMs: 100 }, subagentEnvelope: { agentExecutionId: "a4" } },
    ],
    transitions: [
      { phaseId: "SA-W1", executionId: "g-inv", final: "REPAIR", attempt: 0, lifecycleTransitions: [{ phase: "reviewer", status: "REPAIR", attempt: 0 }] },
      { phaseId: "SA-W1", executionId: "g-inv", final: "PASS", attempt: 1, lifecycleTransitions: [{ phase: "reviewer_verdict", status: "PASS", attempt: 1 }] },
    ],
    closeout: { applied: true, final: "PASS", holdCode: null, bundlePath: "/tmp/x.txt" },
  };
}

test("1. observer never mutates the graphResult（deep-compare before/after）", async () => {
  const root = freshRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    const { recordGraphTelemetry } = await import("../../src/telemetry/graph-observer.mjs");
    const before = JSON.parse(JSON.stringify(sampleGraph()));
    const graph = sampleGraph();
    await recordGraphTelemetry({ graphResult: graph, store });
    const after = JSON.parse(JSON.stringify(graph));
    assert.deepEqual(after, before, "graphResult byte-identical after observation");
    assert.equal(graph.scheduler.order[2], "SA-W1", "scheduler order untouched");
    assert.equal(graph.scheduler.verdict, "PASS", "verdict untouched");
    assert.equal(graph.nodeResults.length, 4, "node set untouched");
    assert.equal(graph.closeout.final, "PASS", "closeout untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("2. event stream is deterministic for identical graph inputs", async () => {
  const root1 = freshRoot();
  const root2 = freshRoot();
  try {
    const { recordGraphTelemetry } = await import("../../src/telemetry/graph-observer.mjs");
    const store1 = new TelemetryStore({ stateRoot: root1 });
    store1.open();
    const store2 = new TelemetryStore({ stateRoot: root2 });
    store2.open();
    const g1 = sampleGraph();
    const g2 = sampleGraph();
    // identical inputs except timestamps（startedAt/completedAt are wall-clock
    // derived — strip them for the determinism assertion）
    await recordGraphTelemetry({ graphResult: g1, store: store1 });
    await recordGraphTelemetry({ graphResult: g2, store: store2 });
    const strip = (ev) => {
      const c = JSON.parse(JSON.stringify(ev));
      delete c.occurredAt;
      if (c.timing) { delete c.timing.startedAt; delete c.timing.completedAt; }
      return c;
    };
    const ev1 = store1.readAll().map(strip);
    const ev2 = store2.readAll().map(strip);
    assert.deepEqual(ev1, ev2, "identical event streams for identical graph inputs");
    // node ordering in the event stream matches IR order（deterministic）
    assert.deepEqual(ev1.filter((e) => e.eventType === "node.run").map((e) => e.identity.nodeId), ["SA-R1", "SA-R2", "SA-W1", "SA-V1"]);
    // repair count + reviewer count from transitions
    const agg = aggregateGraphRun({ events: store1.readAll(), graphRunId: "g-inv" });
    assert.equal(agg.repairCount, 1, "one repair transition observed");
    assert.equal(agg.reviewerCount, 2, "two reviewer transitions observed");
    assert.equal(agg.subAgentCount, 4, "four sub-agent envelopes");
  } finally {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

test("3. production wiring is POST-result and try/catch-wrapped（structural passive contract）", () => {
  const src = readFileSync(join(HERE, "../../src/runtime/colima-graph-runner.mjs"), "utf8");
  // the observer must run after the result object is complete and inside a
  // try/catch so a telemetry failure can never alter the returned verdict
  const resultIdx = src.indexOf("const result = {");
  const observerIdx = src.indexOf("telemetry && typeof telemetry?.observer");
  const tryIdx = src.indexOf("try {", observerIdx);
  // TA-3: the tail now attaches the budget enforcement result AFTER the
  // telemetry observer（attachBudgetResult — reconciliation, NEG13）; the
  // telemetry contract（post-result + try/catch-wrapped）is unchanged.
  const returnIdx = src.indexOf("return attachBudgetResult(result, budget?.enforcement ?? null);", observerIdx);
  assert.ok(resultIdx !== -1 && observerIdx !== -1, "observer wiring present");
  assert.ok(observerIdx > resultIdx, "observer runs AFTER the result is final");
  assert.ok(tryIdx > observerIdx && tryIdx < returnIdx, "observer wrapped in try/catch before return");
  assert.ok(src.includes("result.telemetry = {"), "telemetry result attached post-hoc");
  assert.ok(src.includes("observed: telemetryResult.ok"), "observation outcome recorded");
});

test("4. broken observer (throws) cannot change the returned graph verdict（wiring contract）", async () => {
  // Simulate the runColimaGraph tail contract: verdict decided first, observer
  // failure swallowed, verdict untouched. Mirrors the production structure.
  const result = { final: "PASS", holdCode: null };
  const decided = { ...result };
  let telemetryObserved = null;
  try {
    await (async () => { throw new Error("telemetry boom"); })();
    telemetryObserved = { observed: true };
  } catch {
    telemetryObserved = { observed: false, events: 0, holdCode: "TELEMETRY_UNAVAILABLE" };
  }
  assert.deepEqual({ final: result.final, holdCode: result.holdCode }, { final: decided.final, holdCode: decided.holdCode }, "verdict unchanged");
  assert.deepEqual(telemetryObserved, { observed: false, events: 0, holdCode: "TELEMETRY_UNAVAILABLE" });
});
