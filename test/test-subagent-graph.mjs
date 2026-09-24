// test/test-subagent-graph.mjs
//
// Sub-agent Graph integration — REAL read-only sub-agents running as Graph
// nodes through the official scheduler + Colima pipeline
// (src/subagent/subagent-graph-runner.mjs).
//
// Verifies: two parallel read-only sub-agents (distinct agentExecutionIds,
// isolated context/scratch/process), deterministic JOIN, structured-result
// validation + identity binding, timeout/cancel/malformed/crash propagation,
// rerun without residue or identity conflicts, main-repo purity, cleanup.
//
// Run: node --test test/test-subagent-graph.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { rmSync, mkdirSync } from "node:fs";
import { runSubagentGraph } from "../src/subagent/subagent-graph-runner.mjs";
import { resolveInstance } from "../src/runtime/colima-runtime.mjs";

// DE-2 production wiring: runSubagentGraph runs under native durable execution
// by DEFAULT (runDurableGraph -> runColimaGraph -> journal + checkpoints). The
// tests in this file exercise the RAW runner semantics (timeout/cancel/crash/
// lease edge cases with exact node-result envelopes), so each call explicitly
// opts out via the documented TEST-ONLY `durable: false` escape hatch. The
// durable production path itself is proven in test/v2/test-durable-graph.mjs
// (production-wiring test) + the canonical test:colima-all acceptance.
import { agentExecutionIdFor, SUBAGENT_RESULT_SCHEMA } from "../src/subagent/subagent-contract.mjs";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const REPO_A = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
const SCRATCH = `${HOME}/autoloop-subagent-test-scratch`;
const PROFILE = "autoloop-graph";
// Ownership contract: the runner deletes the instance only when it created it.
const instancePreExisted = resolveInstance(PROFILE).ok;
const PARENT = { scope: { allowed_paths: [], forbidden_paths: [] } };

const repoHeadBefore = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

function saPhase(phaseId, taskType, extra = {}) {
  return {
    phase_id: phaseId,
    depends_on: [],
    effects: { artifact_mutation: "none" },
    runtime: {
      mode: "subagent",
      taskType,
      objective: `read-only ${taskType} over /src/docs`,
      expect: { stdoutContains: [`SUBAGENT_DONE:${taskType}`] },
      limits: { memoryMiB: 256, timeoutMs: extra.timeoutMs },
      sleep: extra.sleep,
      emitMalformed: extra.emitMalformed,
      crashAfter: extra.crashAfter,
    },
  };
}

const joinPhase = {
  phase_id: "JOIN",
  depends_on: ["SA-R1", "SA-R2"],
  effects: { artifact_mutation: "none" },
  runtime: {
    mode: "readonly",
    joinVerify: true,
    command: [
      '[ -f /results/SA-R1.json ] && echo R1_PRESENT || echo R1_MISSING',
      '[ -f /results/SA-R2.json ] && echo R2_PRESENT || echo R2_MISSING',
      'A1=$(grep -o \'"agentExecutionId": *"[^"]*"\' /results/SA-R1.json | head -1)',
      'A2=$(grep -o \'"agentExecutionId": *"[^"]*"\' /results/SA-R2.json | head -1)',
      '[ -n "$A1" ] && [ -n "$A2" ] && [ "$A1" != "$A2" ] && echo DISTINCT_AGENTS || echo AGENT_ISSUE',
      'grep -q \'"status": "PASS"\' /results/SA-R1.json && grep -q \'"status": "PASS"\' /results/SA-R2.json && echo RESULTS_VALID || echo RESULTS_ISSUE',
      'echo JOIN_OK',
    ].join("; "),
    expect: { stdoutContains: ["R1_PRESENT", "R2_PRESENT", "DISTINCT_AGENTS", "RESULTS_VALID", "JOIN_OK"] },
    limits: { memoryMiB: 256 },
  },
};

const mainIr = {
  phases: [saPhase("SA-R1", "count_todos", { sleep: 3 }), saPhase("SA-R2", "inventory_markdown", { sleep: 3 }), joinPhase],
};

function nodeById(r, id) {
  const n = r.nodeResults.find((x) => x.nodeId === id);
  assert.ok(n, `node ${id} present`);
  return n;
}

function saResult(n) {
  // the sub-agent structured result is carried in the executor's metadata via
  // resultIdentity; reconstruct from the graph's results dir? — instead use
  // the node's executor result metadata captured at runtime.
  return n.subagentResult ?? null;
}

before(() => mkdirSync(SCRATCH, { recursive: true }));
after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

test("SA-R1 || SA-R2 -> JOIN: PASS, two real parallel sub-agents, distinct identity, structured results validated, deterministic join", { timeout: 600000 }, async (t) => {
  const r = await runSubagentGraph({ durable: false, ir: mainIr, parent: PARENT, cwd: REPO_A, executionId: "subagent-main-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 90000 });
  assert.equal(r.final, "PASS", `expected PASS, got ${r.final} (${r.reason})`);
  for (const id of ["SA-R1", "SA-R2", "JOIN"]) assert.equal(nodeById(r, id).final, "PASS");

  const a1 = nodeById(r, "SA-R1");
  const a2 = nodeById(r, "SA-R2");
  // distinct deterministic agent execution identities
  assert.equal(a1.phaseExecutionId.startsWith("exec_"), true);
  assert.notEqual(agentExecutionIdFor("subagent-main-1", "SA-R1"), agentExecutionIdFor("subagent-main-1", "SA-R2"));
  // structured result validated by the executor (resultIdentity status completed)
  assert.equal(a1.resultIdentity?.status, "completed");
  assert.equal(a2.resultIdentity?.status, "completed");

  // parallelism: SA-R1 / SA-R2 overlap in time
  assert.ok(Math.max(a1.startedAt, a2.startedAt) < Math.min(a1.completedAt, a2.completedAt), "sub-agents overlapped");

  // dependency + join order
  const join = nodeById(r, "JOIN");
  assert.ok(join.startedAt >= Math.max(a1.completedAt, a2.completedAt), "JOIN starts after both sub-agents");
  assert.deepEqual(r.join.map((n) => n.nodeId), ["SA-R1", "SA-R2", "JOIN"], "deterministic join order");

  // cleanup + repo purity
  assert.equal(r.cleanup.containersFound, 0);
  assert.equal(r.cleanup.instanceDeleted, !instancePreExisted);
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "repo A head unchanged");

  // deterministic join across rerun
  const r2 = await runSubagentGraph({ durable: false, ir: mainIr, parent: PARENT, cwd: REPO_A, executionId: "subagent-main-2", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 90000 });
  assert.equal(r2.final, "PASS");
  const strip = (joinArr) => joinArr.map((n) => ({ nodeId: n.nodeId, final: n.final, taskType: n.taskType }));
  assert.deepEqual(strip(r2.join), strip(r.join), "deterministic join across reruns");
  assert.equal(r2.cleanup.containersFound, 0, "rerun leaves no residue");
});

test("sub-agent timeout -> HOLD, agent process terminated, cleanup", { timeout: 600000 }, async (t) => {
  const ir = { phases: [saPhase("SA-R1", "count_todos", { timeoutMs: 4000, sleep: 60 })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-tmo-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 60000 });
  assert.equal(r.final, "HOLD");
  const n = nodeById(r, "SA-R1");
  assert.equal(n.resultIdentity?.status, "timed_out", "agent process terminated by timeout");
  assert.equal(n.final, "HOLD");
  assert.equal(r.cleanup.containersFound, 0);
});

test("sub-agent cancel via AbortSignal -> HOLD + cleanup", { timeout: 600000 }, async (t) => {
  const ac = new AbortController();
  const ir = { phases: [saPhase("SA-R1", "count_todos", { sleep: 30 }), saPhase("SA-R2", "inventory_markdown", { sleep: 30 })] };
  setTimeout(() => ac.abort(), 2000);
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-cancel-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 120000, signal: ac.signal });
  assert.equal(r.final, "HOLD");
  assert.equal(r.cleanup.containersFound, 0, "cancel leaves no containers");
  assert.equal(r.cleanup.instanceDeleted, !instancePreExisted);
});

test("malformed structured result -> node cannot PASS (fail-closed)", { timeout: 600000 }, async (t) => {
  const ir = { phases: [saPhase("SA-R1", "count_todos", { emitMalformed: true })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-malformed-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 60000 });
  assert.equal(r.final, "HOLD");
  const n = nodeById(r, "SA-R1");
  assert.notEqual(n.final, "PASS", "malformed result must not PASS");
  assert.equal(r.cleanup.containersFound, 0);
});

test("sub-agent process crash -> HOLD, cleanup, no residue", { timeout: 600000 }, async (t) => {
  const ir = { phases: [saPhase("SA-R1", "count_todos", { crashAfter: true })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-crash-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 60000 });
  assert.equal(r.final, "HOLD");
  assert.notEqual(nodeById(r, "SA-R1").final, "PASS");
  assert.equal(r.cleanup.containersFound, 0, "crashed agent container cleaned");
  assert.equal(r.cleanup.instanceDeleted, !instancePreExisted);
});
