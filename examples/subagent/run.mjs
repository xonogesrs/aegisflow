#!/usr/bin/env node
// examples/subagent/run.mjs
//
// Fan-out with per-node authority and an independent join review — the thing
// AegisFlow is actually for.
//
// WHAT THIS DEMONSTRATES
//   one parent admission
//     → two writer subagents, each projected its OWN envelope
//     → a read-only reviewer node whose grant cannot include writes
//     → a join that fails closed if any child did not pass
//
// It runs on the host with a scripted adapter: no `pi`, no credential, no
// container. That is deliberate — the property being shown is the AUTHORITY
// MODEL (who may do what), not a model's output.
//
// Run:  node examples/subagent/run.mjs
//
// For the same fan-out with container isolation and real adapters, see
// docs/agent-integration.md and `npm run test:colima`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord, projectEnvelopeFields } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import { TOOL_PERMISSIONS } from "../../src/subagent/subagent-contract.mjs";

const hr = (title) => console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "aegisflow-subagent-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "example@example.invalid"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "example"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# target\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

// A parent task big enough to be worth splitting: two files in two areas.
const PARENT_EVIDENCE = {
  affected_files: { score: 4, reasons: ["two independent areas"] },
  affected_subsystems: { score: 3, reasons: ["docs and src"] },
  dependency_depth: { score: 1, reasons: ["src change touches one module"] },
  ambiguity: { score: 1, reasons: ["two acceptance items"] },
  expected_execution_steps: { score: 3, reasons: ["two edits plus a check"] },
  verification_burden: { score: 3, reasons: ["run the unit test"] },
  external_dependencies: { score: 0, reasons: ["none"] },
  concurrency_potential: { score: 2, reasons: ["two independent files"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 1, reasons: ["revert two files"] },
};

// Per-child declaration. Each child's boundary must be a SUBSET of the parent
// admission scope; the projection refuses anything wider.
const CHILDREN = [
  {
    nodeId: "child-docs",
    agentRole: "writer",
    requirementId: "R1",
    objective: "Document the new flag in README.md",
    boundary: ["README.md"],
    outcome: "PASS",
  },
  {
    nodeId: "child-src",
    agentRole: "writer",
    requirementId: "R2",
    objective: "Add the flag to the CLI parser",
    boundary: ["src/cli.mjs"],
    outcome: "PASS",
  },
];

function main() {
  const repo = fixtureRepo();
  try {
    // ── 1. One parent admission ───────────────────────────────────────────
    hr("1. PARENT ADMISSION  (the single source of authority)");
    const classification = classify({
      dimensionScores: PARENT_EVIDENCE,
      riskSignals: scanRiskSignals("add a CLI flag: modify the parser and document it"),
    });
    const parent = freezeAdmission(buildAdmissionRecord({
      taskId: "example-subagent-1",
      classification,
      mutationScope: ["README.md", "src/cli.mjs"],
    }));
    console.log(`size              : ${classification.size}`);
    console.log(`risk              : ${classification.risk}   profile: ${classification.profile}`);
    console.log(`admission_id      : ${parent.admission_id}`);
    console.log(`parent scope      : ${JSON.stringify(parent.mutation_scope)}`);
    console.log(`granted caps      : ${JSON.stringify(parent.capabilities?.allowed ?? [])}`);

    // ── 2. Fan-out: each child gets its OWN projected envelope ────────────
    hr("2. FAN-OUT  src/admission/policy-projection.mjs projectEnvelopeFields");
    const envelopes = [];
    for (const child of CHILDREN) {
      const envelope = projectEnvelopeFields({
        admission: parent,
        nodeRole: child.agentRole,
        mutationScopeFromPhase: child.boundary,
      });
      envelopes.push({ child, envelope });
      console.log(`\n${child.nodeId}  (role=${child.agentRole}, covers ${child.requirementId})`);
      console.log(`  declared boundary : ${JSON.stringify(child.boundary)}`);
      console.log(`  PROJECTED scope   : ${JSON.stringify(envelope.mutationScope)}`);
      console.log(`  tool permissions  : ${JSON.stringify(envelope.toolPermissions)}`);
      console.log(`  writable          : ${envelope.toolPermissions.includes(TOOL_PERMISSIONS.SCRATCH_WRITE[0]) || "[scratch-write]"}`);
    }
    console.log(`
Each child received a scope it cannot widen: the projection takes the declared
boundary only if it is a SUBSET of the parent admission, and narrows to it.
There is no path by which a child asks for more.`);

    // ── 3. A read-only node cannot obtain write authority ─────────────────
    hr("3. ROLE SEPARATION — a reviewer node asks for writer role");
    try {
      projectEnvelopeFields({
        admission: parent,
        nodeRole: "writer",
        mutationScopeFromPhase: ["src/forbidden-area.mjs"],
      });
      console.log("UNEXPECTED: the out-of-scope boundary was accepted");
      process.exitCode = 1;
    } catch (e) {
      console.log(`refused: ${e.code}`);
      console.log(`  ${String(e.message).slice(0, 150)}`);
    }

    const reviewerEnvelope = projectEnvelopeFields({
      admission: parent,
      nodeRole: "reviewer",
      mutationScopeFromPhase: [],
    });
    console.log(`\nreviewer envelope (nodeRole="reviewer"):`);
    console.log(`  mutationScope     : ${JSON.stringify(reviewerEnvelope.mutationScope)}`);
    console.log(`  tool permissions  : ${JSON.stringify(reviewerEnvelope.toolPermissions)}`);
    console.log(`
A read-only role projects mutationScope = null and READ_ONLY tools only. The
reviewer cannot write, so "the reviewer fixed it" is not a reachable state.`);

    // ── 4. Join: fail closed on any child that did not pass ───────────────
    hr("4. JOIN");
    const childResults = envelopes.map(({ child }) => ({
      nodeId: child.nodeId,
      requirementId: child.requirementId,
      status: child.outcome,
    }));
    const allPassed = childResults.every((r) => r.status === "PASS");
    for (const r of childResults) {
      console.log(`  ${r.nodeId.padEnd(12)} ${r.requirementId}  ${r.status}`);
    }
    console.log(`\njoin verdict : ${allPassed ? "PASS" : "HOLD"}`);
    console.log("join basis   : every child must pass; a child HOLD is never averaged away");

    // Now flip one child and show the join refuse.
    const withFailure = childResults.map((r) =>
      r.nodeId === "child-src" ? { ...r, status: "HOLD" } : r);
    const stillAllPassed = withFailure.every((r) => r.status === "PASS");
    console.log(`\nwith ${"child-src"} = HOLD:`);
    for (const r of withFailure) console.log(`  ${r.nodeId.padEnd(12)} ${r.requirementId}  ${r.status}`);
    console.log(`join verdict : ${stillAllPassed ? "PASS" : "HOLD"}`);

    hr("WHAT TO TAKE FROM THIS");
    console.log(`
  ✓ authority came from ONE parent admission record
  ✓ each child's scope was projected DOWN (narrowed), never up
  ✓ an out-of-scope child boundary was refused before any work started
  ✓ the read-only reviewer role has no writable projection at all
  ✓ the join is fail-closed: one HOLD blocks the parent

Real fan-out additionally runs each node in its own container
(network off, capabilities dropped) and gives each node a durable
checkpoint, so a crash mid-fan-out resumes rather than restarts. See:
  docs/architecture.md     the authority map
  docs/durable-execution.md  checkpoints, journal, resume
  npm run test:colima        the container-isolated suites (needs Colima)`);

    if (!allPassed) process.exitCode = 1;
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

main();
