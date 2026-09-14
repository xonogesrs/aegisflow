// test/test-durable-subagent-resume.mjs
//
// DE-2R — PRODUCTION SUB-AGENT RESUME ENTRY（colima integration）.
//
// This file lives OUTSIDE test/v2（and outside the parallel test:v2 glob）so
// its real-colima graph never races the DE-2 wiring test over the shared
// autoloop-graph instance. It joins the SERIAL canonical suite（colima-all /
// test:de2r）exactly like the other sub-agent colima suites.
//
// Proof: runSubagentGraph（durable by default）completes a production
// sub-agent graph（SA-R1 ‖ SA-R2 -> SA-W1 -> SA-V1, independent review
// agent）; resumeSubagentGraph（the DE-2R fresh-process resume entry）
// short-circuits the completed run to terminal truth（stage=complete）with
// zero re-execution, preserving the caller's logical executionId + the
// durable execution id. The mid-flight crash/resume matrix（real SIGKILL at
// RO-node / writer-result / review boundaries）lives in
// scripts/de2r-subagent-resume-probe.mjs.
//
// Run: node --test --test-concurrency=1 test/test-durable-subagent-resume.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runSubagentGraph, resumeSubagentGraph, durableExecutionIdFor } from "../src/subagent/subagent-graph-runner.mjs";

const HOME = homedir();

test("DE-2R resumeSubagentGraph: completed durable run -> terminal short-circuit, no re-execution, ids preserved", { timeout: 600000 }, async (t) => {
  const repo = makeFixtureRepo();
  // HOME-based scratch/persistence: the colima instance mounts $HOME, so the
  // sub-agent resultsDir / scratch writes persist（/var/folders does not）.
  const persistenceRoot = join(HOME, ".de2r-test", `persist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const scratchRoot = join(HOME, ".de2r-test", `scratch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(persistenceRoot, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });
  const logicalId = "de2r-resume-entry-1";
  const durableId = durableExecutionIdFor(logicalId);
  const SCOPE = "docs/pi-graph-output/de2r-resume-output";
  const ir = {
    verdict: "PASS",
    phases: [
      { phase_id: "SA-R1", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "subagent", taskType: "count_todos", objective: "read-only count_todos over /src/docs", expect: { stdoutContains: ["SUBAGENT_DONE:count_todos"] }, limits: { memoryMiB: 256, timeoutMs: 60000 }, sleep: 1, agentRole: "readonly-analyst" } },
      { phase_id: "SA-R2", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "subagent", taskType: "inventory_markdown", objective: "read-only inventory_markdown over /src/docs", expect: { stdoutContains: ["SUBAGENT_DONE:inventory_markdown"] }, limits: { memoryMiB: 256, timeoutMs: 60000 }, sleep: 1, agentRole: "readonly-analyst" } },
      { phase_id: "SA-W1", depends_on: ["SA-R1", "SA-R2"], effects: { artifact_mutation: "required", boundaries: { artifact: [SCOPE] } }, runtime: { mode: "subagent", agentRole: "writer", taskType: "write_report", objective: "writer write_report over /work/" + SCOPE + " using dependency results", expect: { stdoutContains: ["SUBAGENT_DONE:write_report"] }, limits: { memoryMiB: 256, timeoutMs: 60000 }, sleep: 1 } },
      { phase_id: "SA-V1", depends_on: ["SA-W1"], effects: { artifact_mutation: "none" }, runtime: { mode: "subagent", agentRole: "verifier", taskType: "verify_writer", objective: "verify writer SA-W1 diff/tests/scope from /results artifacts", expect: { stdoutContains: ["SUBAGENT_DONE:verify_writer"] }, limits: { memoryMiB: 256 } } },
    ],
    dispositions: [],
  };
  try {
    const run = await runSubagentGraph({
      ir,
      parent: { scope: { allowed_paths: [SCOPE], forbidden_paths: [".git"] } },
      manifest: [{ requirement_id: "r1", text: "de2r resume entry" }],
      cwd: repo,
      executionId: logicalId,
      profile: "autoloop-graph",
      repoPath: repo,
      scratchRoot,
      maxRepairAttempts: 1,
      timeoutMs: 120000,
      // durable defaults to TRUE — the production durable path.
      persistence: { root: persistenceRoot, executionId: durableId },
      dirtyScope: [],
      preserveInstance: true,
    });
    assert.equal(run.final, "PASS", `production durable sub-agent graph PASS (${run.reason})`);
    assert.equal(run.durableExecutionId, durableId, "run exposes the durable execution id");

    // ── fresh-process resume through the PRODUCTION entry ──────────────
    // Resume must present the SAME scratch namespace as the original run
    // (fail-closed namespace-drift fence in resumeDurableGraph rejects a
    // changed scratchRoot). A fresh-process resume reuses persisted truth.
    const resumeScratch = scratchRoot;
    const resume = await resumeSubagentGraph({
      parent: { scope: { allowed_paths: [SCOPE], forbidden_paths: [".git"] } },
      manifest: [],
      cwd: repo,
      executionId: logicalId,
      profile: "autoloop-graph",
      repoPath: repo,
      scratchRoot: resumeScratch,
      maxRepairAttempts: 1,
      timeoutMs: 60000,
      signal: undefined,
      hooks: {},
      dirtyScope: [],
      preserveInstance: true,
      persistence: { root: persistenceRoot },
    });
    assert.equal(resume.final, "PASS", "resume of a completed durable run returns PASS");
    assert.equal(resume.stage, "complete", "resume short-circuits on terminal truth");
    assert.equal(resume.complete, true, "complete flag set");
    assert.equal(resume.executionId, logicalId, "caller's logical executionId preserved");
    assert.equal(resume.durableExecutionId, durableId, "durable execution id preserved");

    // no re-execution: the terminal run's journal has exactly one PHASE_PASSED per phase
    const journal = readJournal(persistenceRoot, durableId);
    for (const id of ["SA-R1", "SA-R2", "SA-W1", "SA-V1"]) {
      const passed = journal.filter((e) => e.event_type === "PHASE_PASSED" && e.phase_id === id).length;
      assert.equal(passed, 1, `${id} executed exactly once across run + resume`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

function makeFixtureRepo() {
  const base = join(HOME, ".de2r-test");
  mkdirSync(join(base, "docs"), { recursive: true });
  const dir = join(base, `fixture-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(join(dir, "docs"), { recursive: true });
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "de2r@test"]);
  git(["config", "user.name", "de2r"]);
  writeFileSync(join(dir, "docs", "README.md"), "# de2r fixture\n\nTODO: probe\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

function readJournal(persistenceRoot, durableId) {
  const jdir = join(persistenceRoot, durableId, "journal");
  if (!existsSync(jdir)) return [];
  return readdirSync(jdir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(jdir, f), "utf8")));
}
