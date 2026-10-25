import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { acknowledge, collectAttention, renderBanner, readAttentionState } from "../../src/attention/attention.mjs";
import { candidateStorePath } from "../../src/evolution/candidate.mjs";
import { readTriggerState, writeTriggerState } from "../../src/evolution/trigger.mjs";
import { mintExecutionId } from "../../src/c2d/execution-id.mjs";

const mk = () => realpathSync(mkdtempSync(join(tmpdir(), "attn-")));
const NOW = Date.parse("2026-10-26T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

function addCandidate(store, id, { risk = "MEDIUM", createdHoursAgo = 1 } = {}) {
  const dir = candidateStorePath(store);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    schema: "autoloop.evolution-candidate/v1", candidate_id: id, signal_class: "RECURRING_HOLD_PATTERN",
    risk_class: risk, status: "DERIVED", created_at: hoursAgo(createdHoursAgo),
  }));
}

function addExecution(root, snapshot, { ageMinutes = 0, badChecksum = false } = {}) {
  const id = mintExecutionId();
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(snapshot));
  writeFileSync(join(dir, "CURRENT.json"), bytes);
  writeFileSync(join(dir, "CURRENT.json.sha256"), badChecksum ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex"));
  const t = new Date(NOW - ageMinutes * 60_000);
  utimesSync(join(dir, "CURRENT.json"), t, t);
  return id;
}

test("nothing configured → no alert, no banner", () => {
  const r = collectAttention({ now: NOW });
  assert.equal(r.shouldAlert, false);
  assert.equal(renderBanner(r), "");
});

test("MEDIUM candidates accumulate: INFO below threshold, ALERT at 3, ack suppresses until the set changes", () => {
  const store = mk();
  const state = mk();
  addCandidate(store, "cand_a"); addCandidate(store, "cand_b");
  let r = collectAttention({ evolutionStoreRoot: store, stateDir: state, now: NOW });
  assert.equal(r.shouldAlert, false, "2 fresh MEDIUM candidates stay informational");
  assert.equal(r.items.find((i) => i.kind === "EVOLUTION_MEDIUM_PENDING").severity, "INFO");

  addCandidate(store, "cand_c");
  r = collectAttention({ evolutionStoreRoot: store, stateDir: state, now: NOW });
  assert.equal(r.shouldAlert, true, "third pending candidate crosses the count threshold");
  assert.match(renderBanner(r), /3 個 MEDIUM/);

  acknowledge({ stateDir: state, keys: r.items.filter((i) => i.severity === "ALERT").map((i) => i.key), now: NOW });
  r = collectAttention({ evolutionStoreRoot: store, stateDir: state, now: NOW });
  assert.equal(r.shouldAlert, false, "acknowledged alert is quiet");

  addCandidate(store, "cand_d");
  r = collectAttention({ evolutionStoreRoot: store, stateDir: state, now: NOW });
  assert.equal(r.shouldAlert, true, "a changed pending set re-raises the alert");
});

test("one old MEDIUM candidate alerts on age alone", () => {
  const store = mk();
  addCandidate(store, "cand_old", { createdHoursAgo: 30 });
  const r = collectAttention({ evolutionStoreRoot: store, now: NOW });
  assert.equal(r.shouldAlert, true);
});

test("LOW promotions are informational only; a tripped circuit breaker alerts immediately", () => {
  const store = mk();
  addCandidate(store, "cand_low", { risk: "LOW" });
  let r = collectAttention({ evolutionStoreRoot: store, now: NOW });
  assert.equal(r.shouldAlert, false);

  const st = readTriggerState(store);
  st.circuitBreaker = { at: hoursAgo(1), reason: "repeated candidate failure" };
  writeTriggerState(store, st);
  r = collectAttention({ evolutionStoreRoot: store, now: NOW });
  assert.equal(r.shouldAlert, true);
  assert.ok(r.items.some((i) => i.kind === "EVOLUTION_BREAKER_TRIPPED" && i.severity === "ALERT"));
});

test("executions: stale non-terminal run alerts; fresh run, terminal run do not; corrupt run alerts", () => {
  const root = mk();
  const terminal = { final_verdict: "PASS" };
  const interrupted = { active_phase: "writer", decomposition_ir_sha256: "a".repeat(64), dag_sha256: "b".repeat(64), phase_states: { writer: "RUNNING" } };
  addExecution(root, terminal, { ageMinutes: 600 });
  const fresh = addExecution(root, interrupted, { ageMinutes: 1 });
  let r = collectAttention({ checkpointRoots: [root], now: NOW });
  assert.equal(r.shouldAlert, false, "terminal and fresh runs are quiet");
  assert.ok(r.items.some((i) => i.kind === "EXECUTION_INTERRUPTED" && i.severity === "INFO" && i.summary.includes(fresh)));

  const stale = addExecution(root, interrupted, { ageMinutes: 120 });
  r = collectAttention({ checkpointRoots: [root], now: NOW });
  assert.equal(r.shouldAlert, true);
  assert.ok(r.items.some((i) => i.kind === "EXECUTION_INTERRUPTED" && i.severity === "ALERT" && i.summary.includes(stale)));

  addExecution(root, interrupted, { badChecksum: true });
  r = collectAttention({ checkpointRoots: [root], now: NOW });
  assert.ok(r.items.some((i) => i.kind === "EXECUTION_CORRUPT" && i.severity === "ALERT"));
});

test("collectAttention is read-only; acknowledge writes only the state file", () => {
  const store = mk();
  const state = mk();
  const root = mk();
  addCandidate(store, "cand_x", { createdHoursAgo: 48 });
  addExecution(root, { active_phase: "p" }, { ageMinutes: 100 });
  const listing = (d) => JSON.stringify(readdirSync(d, { recursive: true }).sort());
  const before = [listing(store), listing(root), listing(state)];
  collectAttention({ evolutionStoreRoot: store, checkpointRoots: [root], stateDir: state, now: NOW });
  assert.deepEqual([listing(store), listing(root), listing(state)], before, "collect must not create or remove anything");

  acknowledge({ stateDir: state, keys: ["k1"], now: NOW });
  assert.deepEqual(readdirSync(state), ["attention-state.json"]);
  assert.ok(Object.hasOwn(readAttentionState(state).acknowledged, "k1"));
});
