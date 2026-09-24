// test/test-c3-colima-pipeline.mjs
//
// C3 Colima isolated-writer pipeline — regression tests running the OFFICIAL
// entry path (src/runtime/colima-pipeline.mjs -> lifecycle-runner.mjs with the
// Colima executor + deterministic reviewer). Read-only and writer tasks flow
// through the pipeline; worktrees are created/bound/verified/revoked
// automatically; cleanup is deterministic on PASS and HOLD; execution identity
// is structured for later review/repair/scheduler consumption.
//
// Run: node --test test/test-c3-colima-pipeline.mjs
// Requires: Colima installed (colima 0.10.3), the frozen alpine test image
// pullable, and the AutoLoop source repo at the default repoPath.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runColimaTask } from "../src/runtime/colima-pipeline.mjs";
import { phaseExecutionId } from "../src/v2/phase-task-card.mjs";
import { deleteInstance, instanceSocket, cleanupStale } from "../src/runtime/colima-runtime.mjs";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const REPO_A = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
const SCRATCH = `${HOME}/autoloop-c3-test-scratch`;
const PROFILE = "autoloop-c3";
const PHASE_ID = "c3-phase";

const RO_COMMAND = [
  'echo "READ_OK:$(head -1 /src/README.md)"',
  'touch /src/.c3-ro-probe 2>&1 && echo SRC_WRITABLE || echo SRC_WRITE_DENIED',
  'touch /scratch/ro-probe.txt && echo SCRATCH_OK',
  '[ ! -e /var/run/docker.sock ] && echo NO_SOCKET || echo SOCKET_PRESENT',
  'wget -T3 -O- http://example.com >/dev/null 2>&1 && echo NET_OPEN || echo NET_NONE',
  'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes',
].join("; ");

const WT_COMMAND = [
  'mkdir -p /work/docs',
  'echo "c3-writer-proof-$(date -u +%s)" > /work/docs/c3-proof.md',
  'cat /work/docs/c3-proof.md',
  'touch /src/.c3-wt-probe 2>&1 && echo SRC_WRITABLE || echo SRC_WRITE_DENIED',
].join("; ");

const repoHeadBefore = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

before(() => {
  mkdirSync(SCRATCH, { recursive: true });
});

after(() => {
  deleteInstance(PROFILE);
  rmSync(SCRATCH, { recursive: true, force: true });
});

function baseCard(mode, command, expect) {
  return {
    id: `c3-test-${mode}`,
    executionId: `c3-test-${mode}-${Date.now()}`,
    runtime: { mode, command, expect: { stdoutContains: expect }, limits: { memoryMiB: 256, pidsLimit: 128 } },
  };
}

test("C3 pipeline: read-only task through official entry (PASS, repo untouched, cleanup)", { timeout: 240000 }, async (t) => {
  const card = baseCard("readonly", RO_COMMAND, ["SRC_WRITE_DENIED", "SCRATCH_OK", "NO_SOCKET", "NET_NONE", "268435456"]);
  const r = await runColimaTask({ taskCard: card, profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 90000 });
  assert.equal(r.final, "PASS", `expected PASS, got ${r.final} (${r.reason})`);
  assert.equal(r.mode, "readonly");
  assert.equal(r.schema, "autoloop.c3.colima-task-result/v1");
  assert.equal(r.executionId, card.executionId);
  assert.equal(r.phaseExecutionId, phaseExecutionId(card.executionId, PHASE_ID));
  assert.ok(Array.isArray(r.transitions) && r.transitions.length > 0);
  assert.ok(r.output.scratchProbe.includes("SRC_WRITE_DENIED"));
  assert.equal(r.cleanup.worktreeRevoked, false); // no worktree for readonly
  assert.equal(r.cleanup.containersFound, 0);     // nothing stale after run
  assert.equal(r.cleanup.instanceAlive, true);
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "repo A HEAD must not change");
});

test("C3 pipeline: isolated-worktree writer task (PASS, worktree created->verified->revoked, repo unpolluted)", { timeout: 240000 }, async (t) => {
  const card = baseCard("writer", WT_COMMAND, ["c3-writer-proof", "SRC_WRITE_DENIED"]);
  const r = await runColimaTask({ taskCard: card, profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 90000 });
  assert.equal(r.final, "PASS", `expected PASS, got ${r.final} (${r.reason})`);
  assert.equal(r.mode, "writer");
  assert.equal(r.output.worktreeVerified.ok, true, "worktree bound to clone before run");
  assert.ok(r.output.worktree.files.length >= 1, `writer output recorded (${r.output.worktree.files.length} file(s))`);
  assert.ok(
    r.output.worktree.diff.includes("c3-proof.md") || r.output.worktree.untrackedFiles.some((f) => f.path === "docs/c3-proof.md" && f.content.includes("c3-writer-proof")),
    "writer output reviewable (diff or untracked content)",
  );
  assert.equal(r.cleanup.worktreeRevoked, true, "worktree revoked after run");
  assert.equal(r.cleanup.containersFound, 0);
  // main repo untouched
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore);
  // worktree actually gone
  assert.ok(!existsSync(r.output.worktreeVerified.root));
});

test("C3 pipeline: failing task -> HOLD EXECUTOR_ERROR with deterministic cleanup", { timeout: 240000 }, async (t) => {
  const card = baseCard("readonly", 'echo boom; exit 3', []);
  const r = await runColimaTask({ taskCard: card, profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 30000 });
  assert.equal(r.final, "HOLD");
  assert.equal(r.reason, "EXECUTOR_ERROR");
  assert.equal(r.cleanup.containersFound, 0, "no stale containers after failure");
  assert.equal(r.cleanup.instanceAlive, true);
});

test("C3 pipeline: timeout -> HOLD EXECUTOR_TIMEOUT, container terminated + cleaned", { timeout: 240000 }, async (t) => {
  const card = baseCard("readonly", 'sleep 120', []);
  const r = await runColimaTask({ taskCard: card, profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 6000 });
  assert.equal(r.final, "HOLD");
  assert.equal(r.reason, "EXECUTOR_TIMEOUT");
  assert.equal(r.cleanup.containersFound, 0, "timed-out container cleaned");
  assert.equal(r.cleanup.instanceAlive, true);
});

test("C3 pipeline: unmet expectation -> REPAIR budget exhausted -> HOLD, clean state", { timeout: 240000 }, async (t) => {
  const card = baseCard("readonly", 'echo no-marker-here', ["MARKER_THAT_NEVER_APPEARS"]);
  const r = await runColimaTask({ taskCard: card, profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 30000 });
  assert.equal(r.final, "HOLD");
  assert.equal(r.reason, "REPAIR_BUDGET_EXHAUSTED");
  assert.equal(r.cleanup.containersFound, 0);
});

test("C3 pipeline: restart-safety — repeated runs stay clean, no cross-task containers", { timeout: 240000 }, async (t) => {
  for (let i = 0; i < 2; i += 1) {
    const card = baseCard("readonly", RO_COMMAND, ["SRC_WRITE_DENIED"]);
    const r = await runColimaTask({ taskCard: card, profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 60000 });
    assert.equal(r.final, "PASS", `iteration ${i} failed: ${r.reason}`);
    assert.equal(r.cleanup.containersFound, 0);
  }
  const stale = cleanupStale(PROFILE);
  assert.equal(stale.found, 0, "no leftover labeled containers across restarts");
  assert.ok(existsSync(instanceSocket(PROFILE).replace("unix://", "")), "dedicated instance socket alive");
});

// VCA-1 Phase 0D — this is the OFFICIAL production entrypoint (run:c3).
// timeoutMs must fail closed before any container/mount work when it isn't a
// finite positive number, so a bad CLI flag (Number("abc") => NaN) can never
// silently produce an unbounded or effectively-instant kill window downstream.
// These cases throw synchronously before any Colima instance/container is
// touched, so they need no real Colima/Docker infra.
test("C3 pipeline: non-finite timeoutMs (NaN) fails closed before any container work", async () => {
  const card = baseCard("readonly", "echo hi", []);
  await assert.rejects(
    () => runColimaTask({ taskCard: card, profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: NaN }),
    (e) => e.name === "ColimaPipelineError" && /invalid_timeout_ms/.test(e.reason),
  );
});

test("C3 pipeline: zero/negative timeoutMs fails closed before any container work", async () => {
  const card = baseCard("readonly", "echo hi", []);
  await assert.rejects(
    () => runColimaTask({ taskCard: card, profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: 0 }),
    (e) => e.name === "ColimaPipelineError" && /invalid_timeout_ms/.test(e.reason),
  );
  await assert.rejects(
    () => runColimaTask({ taskCard: card, profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: -1 }),
    (e) => e.name === "ColimaPipelineError" && /invalid_timeout_ms/.test(e.reason),
  );
});

test("C3 pipeline: Infinity timeoutMs fails closed (never an unbounded verification window)", async () => {
  const card = baseCard("readonly", "echo hi", []);
  await assert.rejects(
    () => runColimaTask({ taskCard: card, profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, timeoutMs: Infinity }),
    (e) => e.name === "ColimaPipelineError" && /invalid_timeout_ms/.test(e.reason),
  );
});
