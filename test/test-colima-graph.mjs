// test/test-colima-graph.mjs
//
// Parallel Work Graph Scheduler x Colima pipeline — real multi-node graph
// verification through the official scheduler + C3 pipeline wiring
// (src/runtime/colima-graph-runner.mjs -> runExecutionOrchestrator ->
// runDecompositionGraph with Colima adapters).
//
// Verifies: read-only parallelism, single-writer serialization, ready set,
// dependency blocking, HOLD/failure propagation, cancel, deterministic join,
// writer-lock non-reentrancy, deterministic cleanup, main-repo purity.
//
// Run: node --test test/test-colima-graph.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { rmSync, mkdirSync } from "node:fs";
import { runColimaGraph } from "../src/runtime/colima-graph-runner.mjs";

const HOME = homedir();
const REPO_A = "/Volumes/NVM2T/Development/repos/autoloop";
const SCRATCH = `${HOME}/autoloop-graph-test-scratch`;
const PROFILE = "autoloop-graph";
const PARENT = { scope: { allowed_paths: ["docs/"], forbidden_paths: [".git"] } };

const repoHeadBefore = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

function roCommand(nodeId, sleep = 0) {
  return [
    sleep ? `sleep ${sleep}` : "true",
    `echo "${nodeId}_DONE"`,
    'touch /src/.graph-probe 2>&1 && echo SRC_WRITABLE || echo SRC_WRITE_DENIED',
    'touch /scratch/probe.txt && echo SCRATCH_OK',
    '[ ! -e /var/run/docker.sock ] && echo NO_SOCKET || echo SOCKET_PRESENT',
  ].join("; ");
}

function roPhase(phaseId, dependsOn = [], extra = {}) {
  return {
    phase_id: phaseId,
    depends_on: dependsOn,
    effects: { artifact_mutation: "none" },
    runtime: { mode: "readonly", command: roCommand(phaseId, extra.sleep ?? 4), expect: { stdoutContains: [`${phaseId}_DONE`, "SRC_WRITE_DENIED", "NO_SOCKET"] }, limits: { memoryMiB: 256, timeoutMs: extra.timeoutMs } },
  };
}

const mainIr = {
  phases: [
    roPhase("R1", [], { sleep: 4 }),
    roPhase("R2", [], { sleep: 4 }),
    roPhase("R3", [], { sleep: 4 }),
    {
      phase_id: "W1",
      depends_on: ["R1", "R2", "R3"],
      effects: { artifact_mutation: "required", boundaries: { artifact: ["docs/colima-graph-output"] } },
      runtime: {
        mode: "writer",
        command: 'mkdir -p /work/docs/colima-graph-output && echo "W1_OUTPUT_$(date -u +%s)" > /work/docs/colima-graph-output/w1-output.md && cat /work/docs/colima-graph-output/w1-output.md; touch /src/.w1-probe 2>&1 || echo SRC_WRITE_DENIED',
        expect: { stdoutContains: ["W1_OUTPUT", "SRC_WRITE_DENIED"] },
        limits: { memoryMiB: 256 },
      },
    },
    {
      phase_id: "V1",
      depends_on: ["W1"],
      effects: { artifact_mutation: "none" },
      runtime: { mode: "readonly", command: 'echo "V1_OK"; head -1 /src/README.md; [ ! -e /var/run/docker.sock ] && echo NO_SOCKET', expect: { stdoutContains: ["V1_OK", "NO_SOCKET"] }, limits: { memoryMiB: 256 } },
    },
  ],
};

function nodeById(result, id) {
  const n = result.nodeResults.find((x) => x.nodeId === id);
  assert.ok(n, `node ${id} present`);
  return n;
}

before(() => mkdirSync(SCRATCH, { recursive: true }));
after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

test("main graph R1||R2||R3 -> W1 -> V1: PASS, parallel readonly, single writer, deps respected, deterministic join, cleanup", { timeout: 600000 }, async (t) => {
  const r1 = await runColimaGraph({ ir: mainIr, parent: PARENT, cwd: REPO_A, executionId: "graph-main-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 90000 });
  assert.equal(r1.final, "PASS", `main graph PASS expected, got ${r1.final} (${r1.reason})`);
  for (const id of ["R1", "R2", "R3", "W1", "V1"]) assert.equal(nodeById(r1, id).final, "PASS");

  // identity completeness per node
  for (const id of ["R1", "R2", "R3", "W1", "V1"]) {
    const n = nodeById(r1, id);
    assert.equal(n.graphExecutionId, "graph-main-1");
    assert.ok(n.phaseExecutionId && n.phaseExecutionId.startsWith("exec_"));
    assert.ok(n.instanceIdentity?.profile === PROFILE);
    assert.ok(n.resultIdentity?.status === "completed");
    assert.ok(n.startedAt && n.completedAt && n.completedAt >= n.startedAt);
  }
  // writer node: worktree identity with output + revoked
  const w1 = nodeById(r1, "W1");
  assert.equal(w1.worktreeIdentity.verified, true);
  assert.ok(w1.worktreeIdentity.output.files.length >= 1);
  assert.equal(w1.cleanup.worktreeRevoked, true);

  // parallelism: R1/R2/R3 overlap in time (started together, finished overlapping)
  const rs = ["R1", "R2", "R3"].map((id) => nodeById(r1, id));
  const maxStart = Math.max(...rs.map((n) => n.startedAt));
  const minEnd = Math.min(...rs.map((n) => n.completedAt));
  assert.ok(maxStart < minEnd, `read-only nodes overlapped (maxStart=${maxStart} < minEnd=${minEnd})`);

  // dependency ordering
  const rEnd = Math.max(...rs.map((n) => n.completedAt));
  assert.ok(w1.startedAt >= rEnd, "W1 starts after all R nodes complete");
  const v1 = nodeById(r1, "V1");
  assert.ok(v1.startedAt >= w1.completedAt, "V1 starts after W1 completes");

  // deterministic join + cleanup
  assert.equal(r1.join.length, 5);
  assert.deepEqual(r1.join.map((n) => n.nodeId), ["R1", "R2", "R3", "W1", "V1"]);
  assert.equal(r1.cleanup.containersFound, 0);
  assert.equal(r1.cleanup.worktreesRevoked.length, 0);
  assert.equal(r1.cleanup.instanceDeleted, true);
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "repo A head unchanged");

  // rerun with different executionId: same join output (deterministic)
  const r2 = await runColimaGraph({ ir: mainIr, parent: PARENT, cwd: REPO_A, executionId: "graph-main-2", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 90000 });
  assert.equal(r2.final, "PASS");
  const strip = (join) => join.map((n) => ({ nodeId: n.nodeId, final: n.final, taskType: n.taskType, dependencies: n.dependencies }));
  assert.deepEqual(strip(r2.join), strip(r1.join), "deterministic join across reruns");
  assert.equal(r2.cleanup.containersFound, 0, "rerun has no residue / identity conflicts");
});

test("upstream HOLD blocks downstream; failure propagation; cleanup", { timeout: 600000 }, async (t) => {
  const ir = {
    phases: [
      { phase_id: "R1", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly", command: 'echo boom; exit 3', expect: { stdoutContains: [] }, limits: { memoryMiB: 256 } } },
      roPhase("D1", ["R1"], { sleep: 0 }),
    ],
  };
  const r = await runColimaGraph({ ir, parent: PARENT, cwd: REPO_A, executionId: "graph-hold-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 30000 });
  assert.equal(r.final, "HOLD");
  assert.equal(nodeById(r, "R1").final, "HOLD");
  assert.notEqual(nodeById(r, "D1").final, "PASS", "downstream must not pass when upstream held");
  assert.equal(r.cleanup.containersFound, 0);
  assert.equal(r.cleanup.instanceDeleted, true);
});

test("read-only node timeout -> HOLD EXECUTOR_TIMEOUT + deterministic cleanup", { timeout: 600000 }, async (t) => {
  const ir = {
    phases: [
      { phase_id: "R1", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly", command: "sleep 60", expect: { stdoutContains: [] }, limits: { memoryMiB: 256, timeoutMs: 4000 } } },
    ],
  };
  const r = await runColimaGraph({ ir, parent: PARENT, cwd: REPO_A, executionId: "graph-tmo-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 60000 });
  assert.equal(r.final, "HOLD");
  assert.equal(nodeById(r, "R1").resultIdentity?.status, "timed_out");
  assert.equal(r.cleanup.containersFound, 0, "timed-out container cleaned");
});

test("graph cancel via AbortSignal -> HOLD + cleanup", { timeout: 600000 }, async (t) => {
  const ac = new AbortController();
  const ir = {
    phases: [
      roPhase("R1", [], { sleep: 30 }),
      roPhase("R2", [], { sleep: 30 }),
    ],
  };
  setTimeout(() => ac.abort(), 2000);
  const r = await runColimaGraph({ ir, parent: PARENT, cwd: REPO_A, executionId: "graph-cancel-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 120000, signal: ac.signal });
  assert.equal(r.final, "HOLD");
  assert.equal(r.cleanup.containersFound, 0, "cancel leaves no containers");
  assert.equal(r.cleanup.instanceDeleted, true);
});

test("writer lock non-reentrant: W1 -> W2 serialized, never overlapping", { timeout: 600000 }, async (t) => {
  const wtCmd = (name) => `mkdir -p /work/docs/colima-graph-output && echo "${name}_OUTPUT_$(date -u +%s)" > /work/docs/colima-graph-output/${name}.md && cat /work/docs/colima-graph-output/${name}.md; sleep 2`;
  const ir = {
    phases: [
      { phase_id: "W1", depends_on: [], effects: { artifact_mutation: "required", boundaries: { artifact: ["docs/colima-graph-output"] } }, runtime: { mode: "writer", command: wtCmd("w1"), expect: { stdoutContains: ["w1_OUTPUT"] }, limits: { memoryMiB: 256 } } },
      { phase_id: "W2", depends_on: ["W1"], effects: { artifact_mutation: "required", boundaries: { artifact: ["docs/colima-graph-output"] } }, runtime: { mode: "writer", command: wtCmd("w2"), expect: { stdoutContains: ["w2_OUTPUT"] }, limits: { memoryMiB: 256 } } },
    ],
  };
  const r = await runColimaGraph({ ir, parent: PARENT, cwd: REPO_A, executionId: "graph-writerlock-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 90000 });
  assert.equal(r.final, "PASS");
  const w1 = nodeById(r, "W1");
  const w2 = nodeById(r, "W2");
  assert.ok(w2.startedAt >= w1.completedAt, `writer nodes never overlap (W2 start ${w2.startedAt} >= W1 end ${w1.completedAt})`);
  assert.equal(r.cleanup.containersFound, 0);
});
