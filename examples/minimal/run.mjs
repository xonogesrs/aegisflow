#!/usr/bin/env node
// examples/minimal/run.mjs
//
// The smallest complete AegisFlow execution, end to end.
//
// WHAT THIS DEMONSTRATES
//   task → classify → admit → project → execute → review → scope gate → verdict
//
// It uses a SCRIPTED adapter instead of a real agent runtime, so it runs with
// nothing but Node: no `pi`, no provider credential, no container. What you see
// is the HARNESS — classification, the frozen admission, the projected scope,
// harness-owned evidence, and the gates that refuse. The model's output is a
// deterministic fixture, which is the point: the harness does not trust it.
//
// Run:  node examples/minimal/run.mjs
//
// For the same flow against a real agent, see docs/getting-started.md step 4b.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission, validateAdmission } from "../../src/admission/admission-record.mjs";
import { createScriptedAdapter } from "../../src/adapter/scripted-adapter.mjs";
import { runLifecycle } from "../../src/lifecycle-runner.mjs";
import { buildPhaseTaskCard } from "../../src/v2/phase-task-card.mjs";
import { captureScopeSnapshot, enforceScopeGate } from "../../src/c2d/mutation-scope.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_EVIDENCE = JSON.parse(
  readFileSync(join(HERE, "..", "..", "test", "fixtures", "implementation-evidence-valid.json"), "utf8"),
);

const hr = (title) => console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);

// ── A throwaway git repo to act on ─────────────────────────────────────────
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "aegisflow-example-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "example@example.invalid"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "example"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# example target\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

// ── The task ───────────────────────────────────────────────────────────────
// A single, low-risk, one-file documentation change. The evidence scores are
// the CLASSIFIER's input: they are claims about the task, not by the model.
const TASK = {
  taskId: "example-minimal-1",
  goal: "Add a usage note to the README",
  evidence: {
    affected_files: { score: 1, reasons: ["one file"] },
    affected_subsystems: { score: 0, reasons: ["docs only"] },
    dependency_depth: { score: 0, reasons: ["no dependencies"] },
    ambiguity: { score: 0, reasons: ["explicit instruction"] },
    expected_execution_steps: { score: 0, reasons: ["one edit"] },
    verification_burden: { score: 0, reasons: ["read the file back"] },
    external_dependencies: { score: 0, reasons: ["none"] },
    concurrency_potential: { score: 0, reasons: ["none"] },
    statefulness: { score: 0, reasons: ["stateless"] },
    rollback_complexity: { score: 0, reasons: ["revert one file"] },
  },
  riskSignals: "add a short usage note to README.md",
};

const EXECUTION_ID = "exec_example_minimal_1";
const PHASE = {
  phase_id: "p_docs",
  title: "Documentation note",
  summary: "Add a usage note to the README",
  responsibility: "Produce the README note",
  purpose: "implementation",
  effects: {
    artifact_mutation: "required",
    runtime_side_effect: "forbidden",
    external_system_mutation: "forbidden",
    evidence_output: "persistent",
    boundaries: { artifact: ["README.md"], runtime: [], external_system: [], evidence: [] },
  },
  covers: [{ requirement_id: "R1", completeness: "complete", claim: "README note added" }],
  depends_on: [],
};

/** Build a phase card and fill in the fields the harness reads from it. */
function cardFor({ phase, allowedPaths, repo, executionId }) {
  const card = buildPhaseTaskCard({
    phase,
    parent: { scope: { allowed_paths: allowedPaths, forbidden_paths: [] } },
    executionId,
    cwd: repo,
    maxRepairAttempts: 0,
  });
  // The harness runs its OWN verification command and records the result as
  // harness-owned evidence. A writer phase cannot pass without it: an executor
  // claiming "tests pass" is not evidence, and the gate says so.
  card.verificationCommand = ["git", "status", "--porcelain"];
  card.environmentAllowlist = ["PATH", "HOME", "TMPDIR"];
  // Provider/model identity is part of the evidence contract: the harness
  // records WHICH model was expected, so a reviewer can later distinguish
  // "a model ran" from "the authorised model ran".
  card.expectedExecutorModel = "deepseek-v4-flash";
  card.expectedExecutorProvider = "deepseek";
  card.expectedReviewerModel = "deepseek-v4-flash";
  return card;
}

const completed = (stdout, executionId) => ({
  status: "completed", executionId, stdout, stderr: "", signal: null, error: null, metadata: { exitCode: 0 },
});

function executorAdapter(executionId) {
  const evidence = JSON.stringify({ ...FIXTURE_EVIDENCE, contract_id: executionId });
  return createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: () => completed(evidence, executionId) },
  ]);
}

/** A reviewer that always says PASS — used to show a verdict cannot overrule a fact. */
function optimisticReviewer(executionId) {
  return createScriptedAdapter([
    {
      expect: { phase: "reviewer", attempt: 0 },
      result: () => completed(JSON.stringify({
        verdict: "PASS",
        confidence: "HIGH",
        model: "deepseek-v4-flash",
        summary: "Note is present and matches the requirement.",
        recommended_next_action: "COMMIT_CANDIDATE",
      }), executionId),
    },
  ]);
}

async function main() {
  const repo = fixtureRepo();
  try {
    // ── 1. CLASSIFY (deterministic; no model involved) ────────────────────
    hr("1. CLASSIFY  src/admission/classify.mjs");
    const classification = classify({
      dimensionScores: TASK.evidence,
      riskSignals: scanRiskSignals(TASK.riskSignals),
    });
    console.log(`size            : ${classification.size}`);
    console.log(`risk            : ${classification.risk}`);
    console.log(`profile         : ${classification.profile}`);
    console.log(`reasons         : ${JSON.stringify(classification.reasons)}`);

    // ── 2. ADMIT (immutable, digest-bound) ────────────────────────────────
    hr("2. ADMIT  src/admission/admission-record.mjs");
    const admission = freezeAdmission(buildAdmissionRecord({
      taskId: TASK.taskId,
      classification,
      mutationScope: ["README.md"],
    }));
    console.log(`admission_id      : ${admission.admission_id}`);
    console.log(`validates         : ${validateAdmission(admission).ok}`);
    console.log(`risk              : ${admission.risk}`);
    console.log(`mutation_scope    : ${JSON.stringify(admission.mutation_scope)}`);
    console.log(`capabilities      : allowed=${JSON.stringify(admission.capabilities?.allowed ?? [])}`);
    console.log(`tool_permissions  : ${JSON.stringify(admission.tool_permissions ?? [])}`);
    console.log(`isolation_policy  : ${admission.isolation_policy}`);
    console.log(`durability_policy : ${admission.durability_policy}`);
    console.log("\nThis record is frozen. The agent never receives it as an editable");
    console.log("input, and every downstream limit is DERIVED from it.");

    // ── 3. PROJECT (admission → the executable phase contract) ────────────
    hr("3. PROJECT  src/v2/phase-task-card.mjs");
    const taskCard = cardFor({
      phase: PHASE,
      allowedPaths: admission.mutation_scope,
      repo,
      executionId: EXECUTION_ID,
    });
    console.log(`executionId       : ${taskCard.executionId}`);
    console.log(`phaseId           : ${taskCard.phaseId}`);
    console.log(`allowedPaths      : ${JSON.stringify(taskCard.allowedPaths)}`);
    console.log(`forbiddenPaths    : ${JSON.stringify(taskCard.forbiddenPaths)}`);
    console.log(`toolPolicy        : ${JSON.stringify(taskCard.toolPolicy)}`);
    console.log("\nA read-only phase projects an EMPTY writable allowlist: any repository");
    console.log("change by a read-only executor is a scope violation by construction.");

    // ── 4+5. EXECUTE then REVIEW (role-separated) ─────────────────────────
    hr("4.+5. EXECUTE then REVIEW  src/lifecycle-runner.mjs");
    const result = await runLifecycle({
      cwd: repo,
      taskCard,
      executorAdapter: executorAdapter(EXECUTION_ID),
      reviewerAdapter: optimisticReviewer(EXECUTION_ID),
      maxRepairAttempts: 0,
      timeoutMs: 30_000,
    });
    console.log(`final             : ${result.final}`);
    console.log(`reason            : ${result.reason ?? "(none)"}`);
    console.log(`executionId       : ${result.executionId}`);
    console.log("transitions       :");
    for (const t of result.transitions ?? []) {
      console.log(`  ${String(t.phase).padEnd(10)} ${String(t.status).padEnd(9)} ${t.reason ?? ""}`);
    }

    // ── 6. VERDICT ────────────────────────────────────────────────────────
    hr("6. VERDICT");
    console.log(result.final === "PASS"
      ? "PASS — the requirement was met and an independent reviewer role agreed."
      : `Not PASS: ${result.final} / ${result.reason}`);

    // ── 7. THE GATE ACTUALLY REFUSES ──────────────────────────────────────
    // A gate that only ever passes is decoration. Same pipeline, but the
    // executor writes OUTSIDE the admitted scope. The scope gate is what the
    // graph runners apply before a phase result is allowed to count; calling it
    // directly shows the refusal in isolation.
    hr("7. NEGATIVE — a scope violation on the same pipeline");

    const scopedCard = cardFor({
      phase: { ...PHASE, effects: { ...PHASE.effects, boundaries: { artifact: ["REPORT.md"], runtime: [], external_system: [], evidence: [] } } },
      allowedPaths: ["REPORT.md"],
      repo,
      executionId: `${EXECUTION_ID}_scoped`,
    });

    const before = captureScopeSnapshot(repo);
    // Admission allows REPORT.md only. The executor writes an unlisted file.
    writeFileSync(join(repo, "UNLISTED.md"), "not in the admitted scope\n");
    const after = captureScopeSnapshot(repo);
    const gate = enforceScopeGate(repo, before, after, ["REPORT.md"], []);

    console.log(`gate.ok           : ${gate.ok}`);
    console.log(`observed delta    : ${JSON.stringify(gate.delta.map((d) => d.path))}`);
    console.log("violations        :");
    for (const v of gate.violations) {
      console.log(`  ${v.path} -> ${v.reason}`);
    }

    // The same lifecycle run, with a reviewer that declares PASS regardless.
    const violated = await runLifecycle({
      cwd: repo,
      taskCard: scopedCard,
      executorAdapter: executorAdapter(scopedCard.executionId),
      reviewerAdapter: optimisticReviewer(scopedCard.executionId),
      maxRepairAttempts: 0,
      timeoutMs: 30_000,
    });
    console.log(`\nlifecycle final   : ${violated.final}`);
    console.log(`lifecycle reason  : ${violated.reason ?? "(none)"}`);

    hr("WHAT TO TAKE FROM THIS");
    console.log(`
  ✓ every limit came from ONE frozen admission record, not from the prompt
  ✓ the executor and reviewer were separate roles with separate adapters
  ✓ the reviewer's tool policy grants no writes, so it cannot mutate anything
  ✓ the scope gate reported OUTSIDE_ALLOWLIST from the real tree — a harness
    observation, not a model claim
  ✗ the model did not get to declare success: its "evidence" was a fixture this
    program chose in advance, and the harness still ran the gates over it

The last point is the design rule worth remembering: a verdict cannot overrule
a fact the harness observed for itself. Harness facts first, model opinion
second.

Next:
  examples/subagent/run.mjs        fan-out with an independently-reviewed join
  docs/architecture.md             why the projection step is a single seam
  docs/governance.md               the full gate chain`);

    if (result.final !== "PASS") {
      console.error("\nexample did not reach PASS — see the transitions above");
      process.exitCode = 1;
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("example failed:", e?.stack ?? e);
  process.exitCode = 1;
});
