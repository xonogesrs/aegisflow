// test/test-subagent-review-repair-graph.mjs
//
// Review Agent + Repair Agent integration — REAL independent review and
// bounded repair as Graph lifecycle stages through the official scheduler +
// Colima pipeline (src/subagent/subagent-review-agent.mjs +
// subagent-writer-executor-adapter.mjs repair dispatch).
//
// Pipeline under test:
//   writer node lifecycle: writer agent (attempt 0) -> INDEPENDENT review
//   agent (read-only process; cross-checks identity / dependency results /
//   diff + mutation scope / tests / evidence / claims vs actual worktree
//   content / /src read-only boundary) -> PASS | REPAIR | HOLD ->
//   repair agent (attempt 1; SAME graphExecutionId / node / worktree
//   identity; bound to the exact review findings; same mutationScope;
//   single-writer lease; repairBudget) -> re-review -> deterministic closeout
//
// Real graph: SA-R1 ‖ SA-R2 -> SA-W1 -> SA-V1
//   SA-W1 lifecycle realizes W1 -> REVIEW1 -> REPAIR1 -> REVIEW2:
//     attempt 0 = writer agent writes a report WITH an evidence gap that its
//       own weak self-test passes
//     REVIEW1 = review agent finds the gap (blocking finding) -> REPAIR
//     REPAIR1 = repair agent fixes the report in the same worktree
//     REVIEW2 = review agent re-reviews -> PASS
//   SA-V1 runs only after the final review PASS (W1 node terminal).
//
// Run: node --test test/test-subagent-review-repair-graph.mjs

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
import { agentExecutionIdFor, stageAgentExecutionId, SUBAGENT_REVIEW_RESULT_SCHEMA } from "../src/subagent/subagent-contract.mjs";

const HOME = homedir();
const REPO_A = "/Volumes/NVM2T/Development/repos/autoloop";
const SCRATCH = `${HOME}/autoloop-review-repair-test-scratch`;
const PROFILE = "autoloop-graph";
// Ownership contract: the runner deletes the instance only when it created it.
const instancePreExisted = resolveInstance(PROFILE).ok;
const PARENT = { scope: { allowed_paths: ["docs/"], forbidden_paths: [".git"] } };
const SCOPE = "docs/pi-graph-output";

const repoHeadBefore = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

function roPhase(phaseId, taskType) {
  return {
    phase_id: phaseId,
    depends_on: [],
    effects: { artifact_mutation: "none" },
    runtime: {
      mode: "subagent",
      agentRole: "readonly-analyst",
      taskType,
      objective: `read-only ${taskType} over /src/docs`,
      expect: { stdoutContains: [`SUBAGENT_DONE:${taskType}`] },
      limits: { memoryMiB: 256 },
      sleep: 3,
    },
  };
}

function writerPhase(phaseId, { taskType = "write_report", repairTaskType = null, dependsOn = [], extra = {} } = {}) {
  return {
    phase_id: phaseId,
    depends_on: dependsOn,
    effects: { artifact_mutation: "required", boundaries: { artifact: [SCOPE] } },
    runtime: {
      mode: "subagent",
      agentRole: "writer",
      taskType,
      repairTaskType,
      objective: `writer ${taskType} over /work/${SCOPE} using dependency results`,
      expect: { stdoutContains: [`SUBAGENT_DONE:${taskType}`] },
      limits: { memoryMiB: 256 },
      repairScopeViolation: extra.repairScopeViolation,
      // review-agent injections（contract-test only）
      reviewMalformed: extra.reviewMalformed,
      reviewSleep: extra.reviewSleep,
      reviewTimeoutMs: extra.reviewTimeoutMs,
      reviewCrashAfter: extra.reviewCrashAfter,
    },
  };
}

const verifierPhase = {
  phase_id: "SA-V1",
  depends_on: ["SA-W1"],
  effects: { artifact_mutation: "none" },
  runtime: {
    mode: "subagent",
    agentRole: "verifier",
    taskType: "verify_writer",
    objective: "verify writer SA-W1 diff/tests/scope + independent review from /results artifacts",
    expect: { stdoutContains: ["SUBAGENT_DONE:verify_writer"] },
    limits: { memoryMiB: 256 },
  },
};

/** The main review-repair graph: writer with an evidence gap + repair. */
const mainIr = {
  phases: [
    roPhase("SA-R1", "count_todos"),
    roPhase("SA-R2", "inventory_markdown"),
    writerPhase("SA-W1", { taskType: "write_report_with_gap", repairTaskType: "repair_report", dependsOn: ["SA-R1", "SA-R2"] }),
    verifierPhase,
  ],
};

function nodeById(r, id) {
  const n = r.nodeResults.find((x) => x.nodeId === id);
  assert.ok(n, `node ${id} present`);
  return n;
}

before(() => mkdirSync(SCRATCH, { recursive: true }));
after(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

test("R1 || R2 -> W1 (writer gap -> REVIEW1 finds it -> REPAIR1 fixes -> REVIEW2 PASS) -> V1: ALL PASS", { timeout: 900000 }, async (t) => {
  const r = await runSubagentGraph({ durable: false, ir: mainIr, parent: PARENT, cwd: REPO_A, executionId: "review-repair-main-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 180000 });
  assert.equal(r.final, "PASS", `expected PASS, got ${r.final} (${r.reason})`);
  for (const id of ["SA-R1", "SA-R2", "SA-W1", "SA-V1"]) assert.equal(nodeById(r, id).final, "PASS");

  const w1 = nodeById(r, "SA-W1");
  const v1 = nodeById(r, "SA-V1");

  // ── review/repair loop really ran ──
  assert.equal(w1.attempt, 1, "one repair attempt consumed");
  const tx = r.transitions.find((x) => x.phaseId === "SA-W1");
  const verdicts = tx.lifecycleTransitions.filter((lt) => lt.phase === "reviewer_verdict");
  assert.ok(verdicts.length >= 2, "at least two reviews (initial + re-review)");
  assert.equal(verdicts[0].recommended_next_action, "REPAIR", "REVIEW1 -> REPAIR (independent review found the gap)");
  assert.equal(verdicts[verdicts.length - 1].recommended_next_action, "STOP", "REVIEW2 -> PASS (re-review closes the loop)");

  // ── independent review agent result（final re-review attached to node）──
  const review = w1.reviewResult;
  assert.ok(review, "review result attached to node");
  assert.equal(review.schema_version, SUBAGENT_REVIEW_RESULT_SCHEMA);
  assert.equal(review.recommendedAction, "PASS");
  assert.deepEqual(review.blockingFindings, []);
  assert.equal(review.scopeVerified, true);
  assert.equal(review.testsVerified, true);
  // review agent had its own stage-scoped identity（not the writer's）
  assert.equal(review.agentExecutionId, stageAgentExecutionId("review-repair-main-1", "SA-W1", "reviewer"));

  // ── writer + repair result（repair echo = bound review findings）──
  assert.equal(w1.subagentResult.status, "PASS");
  assert.equal(w1.subagentResult.testResults.failed, 0);
  // cross-wiring protection: repair result echoes the review-findings identity
  // from its envelope, and the blocking findings it responded to
  assert.equal(w1.subagentResult.reviewFindingsIdentity, w1.subagentEnvelope.reviewFindingsIdentity);
  assert.ok(w1.subagentResult.reviewFindingsIdentity && w1.subagentResult.reviewFindingsIdentity.length === 64, "sha256 review-findings identity");
  assert.ok(Array.isArray(w1.subagentResult.blockingFindings), "repair result carries the blocking findings it answered");

  // ── same worktree identity retained through the repair ──
  assert.equal(w1.worktreeIdentity.verified, true);
  assert.equal(w1.cleanup.worktreeRevoked, true);

  // ── single writer lease ──
  assert.deepEqual(r.scheduler.writerViolations, []);
  assert.equal(r.scheduler.leaseHolderAfter, null);

  // ── downstream only after final review PASS ──
  assert.ok(v1.startedAt >= w1.completedAt, "SA-V1 starts after W1 (which passed only after REVIEW2)");
  assert.equal(v1.subagentResult.status, "PASS");
  assert.ok(v1.subagentResult.claims.some((c) => c.includes("independent review PASS")), "verifier confirms the independent review");

  // ── deterministic join + cleanup + main repo purity ──
  assert.deepEqual(r.join.map((n) => n.nodeId), ["SA-R1", "SA-R2", "SA-W1", "SA-V1"]);
  assert.equal(r.cleanup.containersFound, 0);
  assert.equal(r.cleanup.instanceDeleted, !instancePreExisted);
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "main repo untouched");
});

test("review agent malformed result -> HOLD（no blind repair; no downstream）", { timeout: 900000 }, async (t) => {
  const ir = { phases: [writerPhase("SA-W1", { extra: { reviewMalformed: true } })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "review-repair-malformed-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000 });
  assert.equal(r.final, "HOLD");
  const w1 = nodeById(r, "SA-W1");
  assert.notEqual(w1.final, "PASS");
  assert.equal(w1.attempt, 0, "no repair attempt after a malformed review");
  assert.equal(w1.cleanup.worktreeRevoked, true);
  assert.equal(r.cleanup.containersFound, 0);
  assert.equal(r.cleanup.instanceDeleted, !instancePreExisted);
});

test("review agent timeout -> HOLD REVIEWER_TIMEOUT; agent terminated; cleanup", { timeout: 900000 }, async (t) => {
  const ir = { phases: [writerPhase("SA-W1", { extra: { reviewSleep: 60, reviewTimeoutMs: 4000 } })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "review-repair-tmo-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000 });
  assert.equal(r.final, "HOLD");
  const w1 = nodeById(r, "SA-W1");
  assert.equal(w1.reason, "REVIEWER_TIMEOUT", `reviewer timeout reason (got ${w1.reason})`);
  assert.notEqual(w1.final, "PASS");
  assert.equal(w1.cleanup.worktreeRevoked, true);
  assert.equal(r.cleanup.containersFound, 0);
});

test("review agent process crash -> HOLD REVIEWER_ERROR; no residue", { timeout: 900000 }, async (t) => {
  const ir = { phases: [writerPhase("SA-W1", { extra: { reviewCrashAfter: true } })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "review-repair-crash-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000 });
  assert.equal(r.final, "HOLD");
  assert.notEqual(nodeById(r, "SA-W1").final, "PASS");
  assert.equal(r.cleanup.containersFound, 0);
});

test("review agent cancel via AbortSignal -> HOLD + deterministic cleanup", { timeout: 900000 }, async (t) => {
  const ac = new AbortController();
  const ir = { phases: [writerPhase("SA-W1", { extra: { reviewSleep: 30 } })] };
  setTimeout(() => ac.abort(), 2000);
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "review-repair-cancel-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000, signal: ac.signal });
  assert.equal(r.final, "HOLD");
  assert.equal(r.cleanup.containersFound, 0, "cancel leaves no containers");
  assert.equal(r.cleanup.instanceDeleted, !instancePreExisted);
});

test("repair agent out-of-scope write -> HOLD（repair stays inside original mutationScope）", { timeout: 900000 }, async (t) => {
  const ir = { phases: [writerPhase("SA-W1", { taskType: "write_report_with_gap", repairTaskType: "repair_report", extra: { repairScopeViolation: true } })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "review-repair-scope-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000 });
  assert.equal(r.final, "HOLD");
  const w1 = nodeById(r, "SA-W1");
  assert.notEqual(w1.final, "PASS", "repair outside scope must not PASS");
  assert.equal(w1.cleanup.worktreeRevoked, true);
  assert.equal(r.cleanup.containersFound, 0);
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "main repo untouched");
});

test("repair does not fix tests -> re-review REPAIR -> repair budget exhausted -> HOLD", { timeout: 900000 }, async (t) => {
  const ir = { phases: [writerPhase("SA-W1", { taskType: "write_report_with_gap", repairTaskType: "repair_report_fail" })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "review-repair-budget-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000 });
  assert.equal(r.final, "HOLD");
  const w1 = nodeById(r, "SA-W1");
  assert.equal(w1.reason, "REPAIR_BUDGET_EXHAUSTED", "bounded repair budget exhausted");
  assert.notEqual(w1.final, "PASS");
  assert.equal(w1.cleanup.worktreeRevoked, true);
  assert.equal(r.cleanup.containersFound, 0);
});

test("rerun with new executionId: no residue, no identity conflicts, deterministic join", { timeout: 900000 }, async (t) => {
  const a = await runSubagentGraph({ durable: false, ir: mainIr, parent: PARENT, cwd: REPO_A, executionId: "review-repair-rerun-A", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 180000 });
  assert.equal(a.final, "PASS");
  const b = await runSubagentGraph({ durable: false, ir: mainIr, parent: PARENT, cwd: REPO_A, executionId: "review-repair-rerun-B", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 180000 });
  assert.equal(b.final, "PASS");
  // executionId-scoped stage identities — no cross-run conflict
  assert.notEqual(stageAgentExecutionId("review-repair-rerun-A", "SA-W1", "reviewer"), stageAgentExecutionId("review-repair-rerun-B", "SA-W1", "reviewer"));
  assert.notEqual(agentExecutionIdFor("review-repair-rerun-A", "SA-W1"), agentExecutionIdFor("review-repair-rerun-B", "SA-W1"));
  const strip = (joinArr) => joinArr.map((n) => ({ nodeId: n.nodeId, final: n.final, taskType: n.taskType }));
  assert.deepEqual(strip(b.join), strip(a.join), "deterministic join across reruns");
  assert.equal(a.cleanup.containersFound, 0);
  assert.equal(b.cleanup.containersFound, 0, "rerun leaves no containers");
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "main repo untouched");
});
