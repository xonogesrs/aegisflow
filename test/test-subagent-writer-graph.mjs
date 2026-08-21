// test/test-subagent-writer-graph.mjs
//
// Writer sub-agent Graph integration — REAL writer sub-agents running as
// Graph nodes through the official scheduler + Colima pipeline
// (src/subagent/subagent-graph-runner.mjs + subagent-writer-executor-adapter.mjs).
//
// Pipeline under test:
//   Graph writer node -> writer sub-agent envelope（worktree identity + base
//   commit + mutation scope + dependency result identities + repair budget）
//   -> real writer agent in an isolated Colima container bound to a DEDICATED
//   git worktree（network none, no socket, cap-drop ALL）-> structured writer
//   result（autoloop.subagent.writer-result/v1）-> host scope/diff/identity
//   verification（fail-closed）-> reviewer verification -> worktree capture +
//   revoke（PASS/HOLD closeout）; REPAIR retains the same worktree identity.
//
// Real graph: SA-R1 ‖ SA-R2 -> SA-W1 -> SA-V1
//   SA-R1/SA-R2 : read-only sub-agents（parallel analysis）
//   SA-W1       : writer sub-agent（uses the two analysis results, writes a
//                 report under the mutation scope in its dedicated worktree,
//                 runs its own tests）
//   SA-V1       : read-only verifier sub-agent（independently checks the
//                 writer's persisted result + worktree diff artifact + scope +
//                 tests + dependency results）
//
// Run: node --test test/test-subagent-writer-graph.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { rmSync, mkdirSync } from "node:fs";
import { runSubagentGraph } from "../src/subagent/subagent-graph-runner.mjs";

// DE-2 production wiring: runSubagentGraph runs under native durable execution
// by DEFAULT (runDurableGraph -> runColimaGraph -> journal + checkpoints). The
// tests in this file exercise the RAW runner semantics (timeout/cancel/crash/
// lease edge cases with exact node-result envelopes), so each call explicitly
// opts out via the documented TEST-ONLY `durable: false` escape hatch. The
// durable production path itself is proven in test/v2/test-durable-graph.mjs
// (production-wiring test) + the canonical test:colima-all acceptance.
import { agentExecutionIdFor, SUBAGENT_WRITER_RESULT_SCHEMA } from "../src/subagent/subagent-contract.mjs";

const HOME = homedir();
const REPO_A = "/Volumes/NVM2T/Development/repos/autoloop";
const SCRATCH = `${HOME}/autoloop-subagent-writer-test-scratch`;
const PROFILE = "autoloop-graph";
const PARENT = { scope: { allowed_paths: ["docs/"], forbidden_paths: [".git"] } };
const SCOPE = "docs/pi-graph-output";

const repoHeadBefore = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

function roPhase(phaseId, taskType, extra = {}) {
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
      agentRole: "readonly-analyst",
    },
  };
}

function writerPhase(phaseId, { taskType = "write_report", dependsOn = [], extra = {} } = {}) {
  return {
    phase_id: phaseId,
    depends_on: dependsOn,
    effects: { artifact_mutation: "required", boundaries: { artifact: [SCOPE] } },
    runtime: {
      mode: "subagent",
      agentRole: "writer",
      taskType,
      objective: `writer ${taskType} over /work/${SCOPE} using dependency results`,
      expect: { stdoutContains: [`SUBAGENT_DONE:${taskType}`] },
      limits: { memoryMiB: 256, timeoutMs: extra.timeoutMs },
      sleep: extra.sleep,
      emitMalformed: extra.emitMalformed,
      crashAfter: extra.crashAfter,
      scopeViolation: extra.scopeViolation,
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
    objective: "verify writer SA-W1 diff/tests/scope from /results artifacts",
    expect: { stdoutContains: ["SUBAGENT_DONE:verify_writer"] },
    limits: { memoryMiB: 256 },
  },
};

const mainIr = {
  phases: [
    roPhase("SA-R1", "count_todos", { sleep: 3 }),
    roPhase("SA-R2", "inventory_markdown", { sleep: 3 }),
    writerPhase("SA-W1", { dependsOn: ["SA-R1", "SA-R2"] }),
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

test("SA-R1 || SA-R2 -> SA-W1 -> SA-V1: PASS; writer sub-agent bound to dedicated worktree, dependency results flow in, verifier independently verifies", { timeout: 900000 }, async (t) => {
  const r = await runSubagentGraph({ durable: false, ir: mainIr, parent: PARENT, cwd: REPO_A, executionId: "subagent-writer-main-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000 });
  assert.equal(r.final, "PASS", `expected PASS, got ${r.final} (${r.reason})`);
  for (const id of ["SA-R1", "SA-R2", "SA-W1", "SA-V1"]) assert.equal(nodeById(r, id).final, "PASS", `${id} PASS`);

  // ── read-only dependencies：parallel, distinct identity ──
  const r1 = nodeById(r, "SA-R1");
  const r2 = nodeById(r, "SA-R2");
  assert.notEqual(agentExecutionIdFor("subagent-writer-main-1", "SA-R1"), agentExecutionIdFor("subagent-writer-main-1", "SA-R2"));
  assert.ok(Math.max(r1.startedAt, r2.startedAt) < Math.min(r1.completedAt, r2.completedAt), "SA-R1/SA-R2 overlap in time");

  // ── writer sub-agent contract binding ──
  const w1 = nodeById(r, "SA-W1");
  assert.equal(w1.subagentValidation?.ok, true, `writer validation ok (${JSON.stringify(w1.subagentValidation?.errors ?? [])})`);
  const env = w1.subagentEnvelope;
  assert.equal(env.agentRole, "writer");
  assert.equal(env.outputSchemaIdentity, SUBAGENT_WRITER_RESULT_SCHEMA);
  // worktree identity + base commit bound
  assert.ok(env.worktreeIdentity?.worktreeDir, "envelope worktreeIdentity present");
  assert.equal(env.worktreeIdentity.head, env.baseCommit, "baseCommit == worktree head");
  // mutation scope bound
  assert.deepEqual(env.mutationScope, [SCOPE]);
  // dependency result identities flowed in（both read-only deps）
  assert.equal(env.dependencyResultIdentities.length, 2);
  assert.deepEqual(env.dependencyResultIdentities.map((d) => d.nodeId).sort(), ["SA-R1", "SA-R2"]);
  // dependency digest is non-empty（real results were persisted）
  assert.notEqual(env.dependencyResultsDigest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "dependency results digest non-empty");
  // repair budget bound
  assert.deepEqual(env.repairBudget, { maxAttempts: 1, remaining: 1 });
  // runtime instance: no socket
  assert.equal(env.runtimeInstance.socket, null);

  // ── writer structured result（writer schema, fail-closed fields）──
  const wres = w1.subagentResult;
  assert.equal(wres.schema_version, SUBAGENT_WRITER_RESULT_SCHEMA);
  assert.equal(wres.status, "PASS");
  assert.equal(wres.agentExecutionId, env.agentExecutionId);
  assert.equal(wres.inputContextIdentity, env.inputContextIdentity);
  assert.ok(Array.isArray(wres.filesChanged) && wres.filesChanged.length >= 1, "filesChanged present");
  for (const f of wres.filesChanged) assert.ok(f.startsWith(SCOPE + "/"), `file ${f} inside mutation scope`);
  assert.equal(wres.scopeVerification.ok, true, "scope verification ok");
  assert.deepEqual(wres.scopeVerification.violations, []);
  assert.ok(typeof wres.diffSummary === "string" && wres.diffSummary.length > 0, "diffSummary non-empty (host-filled)");
  assert.equal(wres.testResults.passed, 1);
  assert.equal(wres.testResults.failed, 0);
  assert.equal(wres.testResults.total, 1);
  assert.equal(wres.worktreeIdentity.head, env.baseCommit, "agent-observed worktree head == envelope base commit");
  assert.equal(wres.worktreeIdentity.head, wres.worktreeIdentity.baseCommit);

  // ── worktree lifecycle：verified + output captured + revoked ──
  assert.equal(w1.worktreeIdentity.verified, true);
  assert.ok(Array.isArray(w1.worktreeIdentity.output?.files) && w1.worktreeIdentity.output.files.length >= 1, "worktree output captured");
  assert.equal(w1.cleanup.worktreeRevoked, true);

  // ── single writer：no lease violations ──
  assert.deepEqual(r.scheduler.writerViolations, []);
  assert.equal(r.scheduler.leaseHolderAfter, null);

  // ── SA-V1 independently verified the writer（diff/tests/scope/deps）──
  const v1 = nodeById(r, "SA-V1");
  assert.equal(v1.subagentValidation?.ok, true);
  assert.equal(v1.subagentResult.status, "PASS");
  assert.ok(v1.subagentResult.claims.some((c) => c.includes("independently verified")), "verifier claim present");
  assert.ok(v1.startedAt >= w1.completedAt, "SA-V1 starts after SA-W1 completes");

  // ── deterministic join + cleanup + repo purity ──
  assert.deepEqual(r.join.map((n) => n.nodeId), ["SA-R1", "SA-R2", "SA-W1", "SA-V1"]);
  assert.equal(r.cleanup.containersFound, 0);
  assert.equal(r.cleanup.instanceDeleted, true);
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "repo A head unchanged (zero pollution)");
});

test("two independent writer sub-agents serialized by the single-writer lease (never overlapping)", { timeout: 900000 }, async (t) => {
  const ir = {
    phases: [
      writerPhase("SA-W1"),
      writerPhase("SA-W2", { taskType: "write_report" }),
    ],
  };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-writer-lock-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000 });
  assert.equal(r.final, "PASS", `expected PASS, got ${r.final} (${r.reason})`);
  const w1 = nodeById(r, "SA-W1");
  const w2 = nodeById(r, "SA-W2");
  assert.equal(w1.final, "PASS");
  assert.equal(w2.final, "PASS");
  assert.ok(w2.startedAt >= w1.completedAt, `writers never overlap (W2 start ${w2.startedAt} >= W1 end ${w1.completedAt})`);
  assert.deepEqual(r.scheduler.writerViolations, [], "no lease violations");
  assert.equal(r.scheduler.leaseHolderAfter, null);
  assert.equal(r.cleanup.containersFound, 0);
});

test("writer sub-agent timeout -> HOLD; agent terminated; worktree revoked; cleanup", { timeout: 900000 }, async (t) => {
  const ir = { phases: [writerPhase("SA-W1", { extra: { timeoutMs: 4000, sleep: 60 } })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-writer-tmo-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 90000 });
  assert.equal(r.final, "HOLD");
  const w1 = nodeById(r, "SA-W1");
  assert.equal(w1.resultIdentity?.status, "timed_out");
  assert.equal(w1.final, "HOLD");
  assert.equal(w1.cleanup.worktreeRevoked, true, "timed-out writer worktree revoked");
  assert.equal(r.cleanup.containersFound, 0);
  assert.equal(r.cleanup.instanceDeleted, true);
});

test("writer sub-agent cancel via AbortSignal -> HOLD + deterministic cleanup", { timeout: 900000 }, async (t) => {
  const ac = new AbortController();
  const ir = { phases: [writerPhase("SA-W1", { extra: { sleep: 30 } })] };
  setTimeout(() => ac.abort(), 2000);
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-writer-cancel-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000, signal: ac.signal });
  assert.equal(r.final, "HOLD");
  assert.equal(nodeById(r, "SA-W1").final, "HOLD");
  assert.equal(r.cleanup.containersFound, 0, "cancel leaves no containers");
  assert.equal(r.cleanup.instanceDeleted, true);
});

test("writer sub-agent process crash -> HOLD; no residue", { timeout: 900000 }, async (t) => {
  const ir = { phases: [writerPhase("SA-W1", { extra: { crashAfter: true } })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-writer-crash-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 90000 });
  assert.equal(r.final, "HOLD");
  assert.notEqual(nodeById(r, "SA-W1").final, "PASS");
  assert.equal(r.cleanup.containersFound, 0);
  assert.equal(r.cleanup.instanceDeleted, true);
});

test("writer out-of-mutation-scope write -> HOLD（scope gate + executor fail-closed）; main repo untouched", { timeout: 900000 }, async (t) => {
  const ir = { phases: [writerPhase("SA-W1", { extra: { scopeViolation: true } })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-writer-scope-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 90000 });
  assert.equal(r.final, "HOLD");
  const w1 = nodeById(r, "SA-W1");
  assert.notEqual(w1.final, "PASS", "scope violation must not PASS");
  assert.equal(w1.cleanup.worktreeRevoked, true);
  assert.equal(r.cleanup.containersFound, 0);
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "main repo untouched");
});

test("malformed writer structured result -> node cannot PASS (fail-closed)", { timeout: 900000 }, async (t) => {
  const ir = { phases: [writerPhase("SA-W1", { extra: { emitMalformed: true } })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-writer-malformed-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 90000 });
  assert.equal(r.final, "HOLD");
  assert.notEqual(nodeById(r, "SA-W1").final, "PASS");
  assert.equal(r.cleanup.containersFound, 0);
});

test("writer self-test failure -> bounded repair succeeds on the SAME worktree identity (attempt 1 PASS)", { timeout: 900000 }, async (t) => {
  const ir = { phases: [writerPhase("SA-W1", { taskType: "write_report_repair" })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-writer-repair-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000 });
  assert.equal(r.final, "PASS", `expected PASS after bounded repair, got ${r.final} (${r.reason})`);
  const w1 = nodeById(r, "SA-W1");
  assert.equal(w1.final, "PASS");
  assert.equal(w1.attempt, 1, "one repair attempt consumed");
  assert.equal(w1.subagentResult.status, "PASS");
  assert.equal(w1.subagentResult.testResults.failed, 0);
  // same worktree identity retained across the repair attempt
  assert.equal(w1.worktreeIdentity.verified, true);
  assert.equal(w1.cleanup.worktreeRevoked, true);
  // a repair transition was recorded
  const tx = r.transitions.find((x) => x.phaseId === "SA-W1");
  assert.ok(tx.lifecycleTransitions.some((lt) => lt.phase === "reviewer_verdict" && lt.recommended_next_action === "REPAIR"), "REPAIR verdict recorded");
  assert.equal(r.cleanup.containersFound, 0);
});

test("repair budget exhausted -> HOLD REPAIR_BUDGET_EXHAUSTED; worktree revoked", { timeout: 900000 }, async (t) => {
  const ir = { phases: [writerPhase("SA-W1", { taskType: "write_report_fail" })] };
  const r = await runSubagentGraph({ durable: false, ir, parent: PARENT, cwd: REPO_A, executionId: "subagent-writer-budget-1", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000 });
  assert.equal(r.final, "HOLD");
  const w1 = nodeById(r, "SA-W1");
  assert.notEqual(w1.final, "PASS");
  assert.equal(w1.reason, "REPAIR_BUDGET_EXHAUSTED", "repair budget exhausted reason");
  assert.equal(w1.cleanup.worktreeRevoked, true);
  assert.equal(r.cleanup.containersFound, 0);
});

test("rerun with new executionId: no residue, no identity conflicts, deterministic join", { timeout: 900000 }, async (t) => {
  const a = await runSubagentGraph({ durable: false, ir: mainIr, parent: PARENT, cwd: REPO_A, executionId: "subagent-writer-rerun-A", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000 });
  assert.equal(a.final, "PASS");
  const b = await runSubagentGraph({ durable: false, ir: mainIr, parent: PARENT, cwd: REPO_A, executionId: "subagent-writer-rerun-B", profile: PROFILE, repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 120000 });
  assert.equal(b.final, "PASS");
  // executionId-scoped agent identities — no cross-run conflict
  assert.notEqual(agentExecutionIdFor("subagent-writer-rerun-A", "SA-W1"), agentExecutionIdFor("subagent-writer-rerun-B", "SA-W1"));
  // deterministic join across reruns
  const strip = (joinArr) => joinArr.map((n) => ({ nodeId: n.nodeId, final: n.final, taskType: n.taskType }));
  assert.deepEqual(strip(b.join), strip(a.join));
  assert.equal(a.cleanup.containersFound, 0);
  assert.equal(b.cleanup.containersFound, 0, "rerun leaves no containers");
  const headAfter = spawnSync("git", ["-C", REPO_A, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  assert.equal(headAfter, repoHeadBefore, "repo A head unchanged");
});
