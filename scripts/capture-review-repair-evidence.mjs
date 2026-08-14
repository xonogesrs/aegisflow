// scripts/capture-review-repair-evidence.mjs
//
// Captures the REAL review-agent + repair-agent graph evidence for the card:
//   SA-R1 ‖ SA-R2 -> SA-W1 -> SA-V1
// where SA-W1's lifecycle realizes W1 -> REVIEW1 -> REPAIR1 -> REVIEW2:
//   attempt 0 = writer agent writes a report WITH an evidence gap that its
//     own weak self-test passes
//   REVIEW1  = independent review agent finds the gap (blocking finding)
//   REPAIR1  = repair agent fixes the report in the same worktree
//   REVIEW2  = review agent re-reviews -> PASS
//   SA-V1    = read-only verifier runs only after the final review PASS.
//
// Writes the full structured graph result to the governance c3-results dir.
// Run: node scripts/capture-review-repair-evidence.mjs

import { homedir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSubagentGraph } from "../src/subagent/subagent-graph-runner.mjs";

const HOME = homedir();
const REPO_A = "/Volumes/NVM2T/Development/autoloop";
const SCRATCH = `${HOME}/autoloop-review-repair-evidence`;
const PROFILE = "autoloop-graph";
const PARENT = { scope: { allowed_paths: ["docs/"], forbidden_paths: [".git"] } };
const SCOPE = "docs/pi-graph-output";
const EXECUTION_ID = "review-repair-evidence-20260806";
const OUT = "/Users/zhengfengqing/Desktop/AutoLoop-Review/governance/c3-results/review-repair-graph-evidence-20260806.json";

const roPhase = (phaseId, taskType) => ({
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
});

const writerPhase = {
  phase_id: "SA-W1",
  depends_on: ["SA-R1", "SA-R2"],
  effects: { artifact_mutation: "required", boundaries: { artifact: [SCOPE] } },
  runtime: {
    mode: "subagent",
    agentRole: "writer",
    taskType: "write_report_with_gap",
    repairTaskType: "repair_report",
    objective: `writer write_report_with_gap over /work/${SCOPE} using dependency results`,
    expect: { stdoutContains: ["SUBAGENT_DONE:write_report_with_gap"] },
    limits: { memoryMiB: 256 },
  },
};

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

mkdirSync(SCRATCH, { recursive: true });
const ir = { phases: [roPhase("SA-R1", "count_todos"), roPhase("SA-R2", "inventory_markdown"), writerPhase, verifierPhase] };
const r = await runSubagentGraph({
  ir, parent: PARENT, cwd: REPO_A, executionId: EXECUTION_ID, profile: PROFILE,
  repoPath: REPO_A, scratchRoot: SCRATCH, maxRepairAttempts: 1, timeoutMs: 180000,
});
mkdirSync(join(OUT, ".."), { recursive: true });
writeFileSync(OUT, JSON.stringify(r, null, 2) + "\n");
rmSync(SCRATCH, { recursive: true, force: true });

console.log(`final=${r.final} reason=${r.reason ?? "null"} executionId=${r.executionId}`);
console.log(`join order: ${r.join.map((n) => `${n.nodeId}:${n.final}`).join(" -> ")}`);
const w1 = r.nodeResults.find((n) => n.nodeId === "SA-W1");
const tx = r.transitions.find((t) => t.phaseId === "SA-W1");
const verdicts = tx.lifecycleTransitions.filter((lt) => lt.phase === "reviewer_verdict");
console.log(`W1 attempt=${w1.attempt} review verdicts: ${verdicts.map((v) => v.recommended_next_action).join(" -> ")}`);
console.log(`final review: recommendedAction=${w1.reviewResult?.recommendedAction} blocking=${JSON.stringify(w1.reviewResult?.blockingFindings)}`);
console.log(`cleanup: containersFound=${r.cleanup.containersFound} instanceDeleted=${r.cleanup.instanceDeleted}`);
console.log(`evidence written: ${OUT}`);
process.exit(r.final === "PASS" ? 0 : 1);
