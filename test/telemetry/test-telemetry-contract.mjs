// test/telemetry/test-telemetry-contract.mjs
//
// COST-1 — telemetry contract v1: schema allowlist, versioning, identity
// determinism, nullable provider usage, canonical aggregation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTelemetryEvent,
  validateTelemetryEventV1,
  telemetryEventId,
  TELEMETRY_EVENT_SCHEMA,
  TELEMETRY_HOLD_CODES,
} from "../../src/telemetry/contract.mjs";
import { TelemetryStore } from "../../src/telemetry/store.mjs";
import { aggregateGraphRun } from "../../src/telemetry/aggregate.mjs";
import { validateTelemetryBudgetV1, simulateBudgetEnforcement, DEFAULT_BUDGETS } from "../../src/telemetry/budgets.mjs";
import { TELEMETRY_BUDGET_SCHEMA } from "../../src/telemetry/contract.mjs";

function tmpRoot() {
  const d = mkdtempSync(join(tmpdir(), "cost1-contract-"));
  return d;
}

test("1. valid event passes validation and gets a deterministic eventId", () => {
  const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "node.run", sequence: 0 });
  ev.identity = { nodeId: "SA-R1", phaseExecutionId: "p1", agentExecutionId: "a1", attempt: 0, stage: null, taskType: "subagent", risk: null };
  ev.timing = { startedAt: "2026-08-07T00:00:00Z", completedAt: "2026-08-07T00:00:01Z", durationMs: 1000 };
  const v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(v.event.eventId, telemetryEventId({ graphRunId: "g1", eventType: "node.run", nodeId: "SA-R1", attempt: 0, sequence: 0 }), "deterministic id");
});

test("2. unknown field fails closed（allowlist）", () => {
  const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "graph.run", sequence: 0 });
  ev.unknownField = "smuggled";
  const v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("unknown_field")), "unknown field rejected");
});

test("3. schema version mismatch fails", () => {
  const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "graph.run", sequence: 0 });
  ev.schemaVersion = 999;
  const v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("schemaVersion_mismatch")));
});

test("4. unknown eventType fails", () => {
  const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "graph.run", sequence: 0 });
  ev.eventType = "custom.event";
  const v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("unknown_eventType")));
});

test("5. malformed identity fails（graphRunId required / attempt negative）", () => {
  const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "node.run", sequence: 0 });
  ev.identity = { nodeId: null, phaseExecutionId: null, agentExecutionId: null, attempt: -1, stage: null, taskType: null, risk: null };
  const v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("identity_attempt_invalid")));

  const ev2 = createTelemetryEvent({ graphRunId: "g1", eventType: "node.run", sequence: 0 });
  ev2.graph.graphRunId = null;
  assert.equal(validateTelemetryEventV1(ev2).valid, false);
});

test("6. nullable provider usage: NOT_REPORTED forces null token counters; PROVIDER_REPORTED is the only real-value source", () => {
  const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "graph.run", sequence: 0 });
  ev.model = { model: null, provider: null, tokenSource: "NOT_REPORTED", inputTokens: 100, outputTokens: null, cachedInputTokens: null, totalTokens: null };
  const v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, false, "NOT_REPORTED with token counters must fail");
  assert.ok(v.errors.some((e) => e.includes("must_be_null_when_NOT_REPORTED")));

  ev.model.inputTokens = null;
  assert.equal(validateTelemetryEventV1(ev).valid, true, "NOT_REPORTED with null counters is valid");

  ev.model.tokenSource = "PROVIDER_REPORTED";
  ev.model.inputTokens = 100;
  ev.model.totalTokens = 100;
  assert.equal(validateTelemetryEventV1(ev).valid, true, "PROVIDER_REPORTED with counters is valid");
});

test("6b. tool-call unknown semantics: NOT_REPORTED forces null counters（unknown ≠ measured zero）", () => {
  const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "node.run", sequence: 0 });
  // default tools section is NOT_REPORTED with null counters -> valid
  assert.equal(validateTelemetryEventV1(ev).valid, true);
  // NOT_REPORTED with a non-null counter -> INVALID（would read as measured 0）
  ev.tools.toolCallCount = 0;
  let v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("tools_toolCallCount_must_be_null_when_NOT_REPORTED")));
  ev.tools.toolCallCount = null;
  ev.tools.failures = 0;
  v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, false, "failures=0 also invalid when NOT_REPORTED");
  // REPORTED with integer counters -> valid
  ev.tools.failures = null;
  ev.tools.toolCallSource = "REPORTED";
  ev.tools.toolCallCount = 5;
  ev.tools.failures = 1;
  assert.equal(validateTelemetryEventV1(ev).valid, true);
  // unknown source value fails
  ev.tools.toolCallSource = "DERIVED";
  v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("tools_toolCallSource_invalid")));
});

test("7. store round-trip: append / read / digest（deterministic）", () => {
  const root = tmpRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    for (let i = 0; i < 3; i++) {
      const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "node.run", sequence: i });
      ev.identity = { nodeId: `N${i}`, phaseExecutionId: `p${i}`, agentExecutionId: null, attempt: 0, stage: null, taskType: "subagent", risk: null };
      store.append(ev);
    }
    store.close();

    const re = new TelemetryStore({ stateRoot: root });
    re.open();
    const all = re.readAll();
    assert.equal(all.length, 3);
    const d1 = re.streamDigest();
    re.close();

    const re2 = new TelemetryStore({ stateRoot: root });
    re2.open();
    assert.equal(re2.streamDigest(), d1, "digest stable across reopen");
    re2.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("8. corrupt store line -> TELEMETRY_STORE_INVALID（fail closed, never silent）", () => {
  const root = tmpRoot();
  try {
    const store = new TelemetryStore({ stateRoot: root });
    store.open();
    const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "graph.run", sequence: 0 });
    store.append(ev);
    store.close();
    // corrupt the second line
    const p = join(root, "telemetry.jsonl");
    const lines = readFileSync(p, "utf8").split("\n");
    lines[1] = "{not json";
    writeFileSync(p, lines.join("\n"), "utf8");
    const re = new TelemetryStore({ stateRoot: root });
    assert.throws(() => re.open(), (e) => e.code === TELEMETRY_HOLD_CODES.STORE_INVALID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9. aggregate: honest token coverage（NOT_REPORTED -> coverage 0, unknownUsageCount = events）", () => {
  const events = [];
  for (let i = 0; i < 4; i++) {
    const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "node.run", sequence: i });
    ev.identity = { nodeId: `N${i}`, phaseExecutionId: null, agentExecutionId: `a${i}`, attempt: 0, stage: null, taskType: "subagent", risk: null };
    ev.timing = { startedAt: null, completedAt: null, durationMs: 10 };
    ev.agent = { finalVerdict: "PASS" };
    events.push(ev);
  }
  const agg = aggregateGraphRun({ events, graphRunId: "g1" });
  assert.equal(agg.reportedTokens.total, 0, "no fabricated tokens");
  assert.equal(agg.tokenCoverage, 0, "zero coverage when nothing is reported");
  assert.equal(agg.unknownUsageCount, 4, "all 4 token-observable events unknown");
  assert.equal(agg.tokenSource, "NOT_REPORTED");
  assert.equal(agg.nodeCount, 4);
  // tool-call honesty: unknown tool usage is NEVER a measured 0
  assert.equal(agg.toolCallCount, null, "unknown tool calls -> null, not 0");
  assert.equal(agg.toolCallSource, "NOT_REPORTED");
  assert.equal(agg.reportedToolCalls, 0);
  assert.equal(agg.toolCallCoverage, 0);
  assert.equal(agg.unknownToolUsageCount, 4);
});

test("9b. aggregate: REPORTED tool calls sum + coverage（REPORTED is the only real count）", () => {
  const events = [];
  for (let i = 0; i < 3; i++) {
    const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "node.run", sequence: i });
    ev.identity = { nodeId: `N${i}`, phaseExecutionId: null, agentExecutionId: `a${i}`, attempt: 0, stage: null, taskType: "subagent", risk: null };
    ev.timing = { startedAt: null, completedAt: null, durationMs: 10 };
    ev.tools = { toolCallCount: 4 + i, toolCategories: ["fs.read"], failures: 1, toolCallSource: "REPORTED" };
    events.push(ev);
  }
  const agg = aggregateGraphRun({ events, graphRunId: "g1" });
  assert.equal(agg.toolCallSource, "REPORTED");
  assert.equal(agg.toolCallCount, 4 + 5 + 6);
  assert.equal(agg.reportedToolCalls, 15);
  assert.equal(agg.toolCallCoverage, 1);
  assert.equal(agg.unknownToolUsageCount, 0);
  assert.equal(agg.toolFailures, 3);
});

test("10. aggregate: PROVIDER_REPORTED tokens sum + coverage", () => {
  const events = [];
  for (let i = 0; i < 4; i++) {
    const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "node.run", sequence: i });
    ev.identity = { nodeId: `N${i}`, phaseExecutionId: null, agentExecutionId: `a${i}`, attempt: 0, stage: null, taskType: "subagent", risk: null };
    ev.timing = { startedAt: null, completedAt: null, durationMs: 10 };
    ev.model = { model: "m1", provider: "p1", tokenSource: "PROVIDER_REPORTED", inputTokens: 100, outputTokens: 25, cachedInputTokens: 0, totalTokens: 125 };
    events.push(ev);
  }
  const agg = aggregateGraphRun({ events, graphRunId: "g1" });
  assert.equal(agg.reportedTokens.total, 500);
  assert.equal(agg.reportedTokens.input, 400);
  assert.equal(agg.reportedTokens.output, 100);
  assert.equal(agg.tokenCoverage, 1);
  assert.equal(agg.unknownUsageCount, 0);
  assert.equal(agg.tokenSource, "PROVIDER_REPORTED");
});

test("11. budget contract: schema valid, enforced must be false in COST-1, simulation reports violations without changing anything", () => {
  const budget = {
    schema: TELEMETRY_BUDGET_SCHEMA,
    name: "cost1-default",
    version: 1,
    ...DEFAULT_BUDGETS,
    tokenBudget: { limit: 1000, unit: "tokens", policy: "soft", enforced: false },
    repairBudget: { limit: 1, unit: "repairs", policy: "soft", enforced: false },
  };
  assert.equal(validateTelemetryBudgetV1(budget).valid, true);
  const bad = { ...budget, repairBudget: { limit: 1, unit: "repairs", policy: "hard", enforced: true } };
  assert.equal(validateTelemetryBudgetV1(bad).valid, false, "enforced=true rejected in COST-1");
  const agg = { reportedTokens: { total: 2000 }, repairCount: 2 };
  const sim = simulateBudgetEnforcement({ budget, aggregate: agg });
  assert.equal(sim.enforced, false, "simulation never enforces");
  assert.ok(sim.violations.some((v) => v.includes("tokenBudget_exceeded")));
  assert.ok(sim.violations.some((v) => v.includes("repairBudget_exceeded")));
});
