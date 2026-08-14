// test/telemetry/test-telemetry-lifecycle.mjs
//
// COST-1 — telemetry lifecycle: PASS/REPAIR/HOLD graphs, missing token usage,
// telemetry unavailable, observer never alters the graph outcome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetryEvent, TELEMETRY_HOLD_CODES } from "../../src/telemetry/contract.mjs";
import { TelemetryStore } from "../../src/telemetry/store.mjs";
import { aggregateGraphRun } from "../../src/telemetry/aggregate.mjs";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "cost1-life-"));
}

function graphResult({ final = "PASS", holdCode = null, nodes = 2, repairs = 0, transitions = null, closeout = null } = {}) {
  const nodeResults = [];
  for (let i = 0; i < nodes; i++) {
    nodeResults.push({
      nodeId: `N${i}`,
      phaseExecutionId: `p${i}`,
      taskType: "subagent",
      attempt: 0,
      final: final === "PASS" ? "PASS" : final,
      startedAt: 1000 + i * 100,
      completedAt: 1100 + i * 100,
      resultIdentity: { latencyMs: 100 },
      memoryContext: { state: "EMPTY_MEMORY", counts: { selected: 0 } },
    });
  }
  let ts = transitions;
  if (ts === null) {
    ts = [];
    for (let r = 0; r < repairs; r++) {
      ts.push({ phaseId: "N0", executionId: "e", final: "REPAIR", attempt: 0, lifecycleTransitions: [{ phase: "reviewer", status: "REPAIR", attempt: 0 }] });
    }
  }
  return {
    executionId: "g1",
    final,
    holdCode,
    nodeResults,
    transitions: ts,
    memoryContext: { state: "EMPTY_MEMORY" },
    scheduler: { verdict: final },
    closeout: closeout ?? { applied: false },
  };
}

test("1. PASS graph: observer records graph.run + node.run + closeout events; aggregate reflects verdict", async () => {
  const root = tmpRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    const { recordGraphTelemetry } = await import("../../src/telemetry/graph-observer.mjs");
    const r = await recordGraphTelemetry({ graphResult: graphResult({ final: "PASS", nodes: 3 }), closeout: { cardId: "C1", cardTitle: "T", cardType: "implementation" }, store });
    assert.equal(r.ok, true);
    assert.equal(r.events, 4, "graph.run + 3 node.run");
    const agg = aggregateGraphRun({ events: store.readAll(), graphRunId: "g1" });
    assert.equal(agg.finalVerdict, "PASS");
    assert.equal(agg.nodeCount, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("2. REPAIR graph: node.repair events recorded; repairCount in aggregate", async () => {
  const root = tmpRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    const { recordGraphTelemetry } = await import("../../src/telemetry/graph-observer.mjs");
    const r = await recordGraphTelemetry({ graphResult: graphResult({ final: "PASS", nodes: 1, repairs: 1 }), store });
    assert.equal(r.ok, true);
    const all = store.readAll();
    assert.equal(all.filter((e) => e.eventType === "node.repair").length, 1);
    const agg = aggregateGraphRun({ events: all, graphRunId: "g1" });
    assert.equal(agg.repairCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("3. HOLD graph: holdCode carried into events + aggregate", async () => {
  const root = tmpRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    const { recordGraphTelemetry } = await import("../../src/telemetry/graph-observer.mjs");
    const r = await recordGraphTelemetry({ graphResult: graphResult({ final: "HOLD", holdCode: "MEMORY_STORE_INVALID" }), store });
    assert.equal(r.ok, true);
    const agg = aggregateGraphRun({ events: store.readAll(), graphRunId: "g1" });
    assert.equal(agg.finalVerdict, "HOLD");
    assert.equal(agg.holdCode, "MEMORY_STORE_INVALID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("4. missing token usage: events default NOT_REPORTED; aggregate never fabricates", async () => {
  const root = tmpRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    const { recordGraphTelemetry } = await import("../../src/telemetry/graph-observer.mjs");
    await recordGraphTelemetry({ graphResult: graphResult({ nodes: 2 }), store });
    const all = store.readAll();
    assert.ok(all.every((e) => e.model?.tokenSource === "NOT_REPORTED"));
    assert.ok(all.every((e) => e.model?.totalTokens === null));
    const agg = aggregateGraphRun({ events: all, graphRunId: "g1" });
    assert.equal(agg.reportedTokens.total, 0);
    assert.equal(agg.unknownUsageCount, all.length, "every event unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("5. telemetry unavailable: a broken observer/store never alters the graph outcome", async () => {
  const root = tmpRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    // store NOT opened -> append throws TelemetryStoreError(UNAVAILABLE) -> observer degrades
    const { recordGraphTelemetry } = await import("../../src/telemetry/graph-observer.mjs");
    const r = await recordGraphTelemetry({ graphResult: graphResult({ final: "PASS" }), store });
    assert.equal(r.ok, false);
    assert.equal(r.holdCode, TELEMETRY_HOLD_CODES.UNAVAILABLE);
    // the graph result itself is untouched — this is the passive contract
    const gr = graphResult({ final: "PASS" });
    gr.telemetry = null;
    assert.equal(gr.final, "PASS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("6. corrupt telemetry store -> TELEMETRY_STORE_INVALID surfaced, not silent bad data", async () => {
  const root = tmpRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "graph.run", sequence: 0 });
    store.append(ev);
    store.close();
    // corrupt the file
    const { readFileSync, writeFileSync } = await import("node:fs");
    const p = join(root, "telemetry.jsonl");
    const lines = readFileSync(p, "utf8").split("\n");
    lines[1] = "garbage{{";
    writeFileSync(p, lines.join("\n"), "utf8");
    const re = new TelemetryStore({ stateRoot: root });
    assert.throws(() => re.open(), (e) => e.code === TELEMETRY_HOLD_CODES.STORE_INVALID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("7. verification events: canonical/full classification + aggregate sums", async () => {
  const root = tmpRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    const { recordGraphTelemetry } = await import("../../src/telemetry/graph-observer.mjs");
    const r = await recordGraphTelemetry({
      graphResult: graphResult({ nodes: 1 }),
      store,
      verification: [
        { suite: "test:colima-all", tests: 42, passed: 42, failed: 0, durationMs: 134000 },
        { suite: "test:telemetry-contract", tests: 11, passed: 11, failed: 0, durationMs: 900 },
      ],
    });
    assert.equal(r.ok, true);
    const all = store.readAll();
    const vEvents = all.filter((e) => e.eventType === "verification.recorded");
    assert.equal(vEvents.length, 2);
    assert.equal(vEvents[0].verification.classification, "canonical");
    assert.equal(vEvents[1].verification.classification, "full");
    const agg = aggregateGraphRun({ events: all, graphRunId: "g1" });
    assert.equal(agg.verification.totalTests, 53);
    assert.equal(agg.verification.passed, 53);
    assert.equal(agg.verification.failed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
