// test/subagent/test-cedf-conflict-enforcement.mjs
//
// CEDF Phase 21 adversarial-gate repair proofs:
//   R-B(P1): dependency-reconciliation CONFLICT fail-closes EVERY consumer
//     channel at the executor dispatcher BEFORE any spawn（writer / read-only
//     sub-agent / readonly-joinVerify colima alike）— contradictory child
//     claims can never silently chain into a downstream PASS.
//   R-C(P2): runtime.joinVerify exempts a dependency from DUPLICATE_CLAIM
//     ONLY when it is genuinely non-mutating; a full-authority writer
//     self-declaring joinVerify gets NO exemption.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSubagentGraphHooks, subagentExecutorFactory } from "../../src/subagent/subagent-graph-runner.mjs";

function tmp(label) {
  return mkdtempSync(join(tmpdir(), `cedf-conflict-${label}-`));
}

const IR = {
  verdict: "PASS",
  phases: [
    {
      phase_id: "W1", depends_on: [],
      effects: { artifact_mutation: "required" },
      runtime: { mode: "subagent", agentRole: "writer" },
    },
    // W2: full writer authority that (adversarially) self-declares joinVerify.
    {
      phase_id: "W2", depends_on: [],
      effects: { artifact_mutation: "required" },
      runtime: { mode: "subagent", agentRole: "writer", joinVerify: true },
    },
    {
      phase_id: "V", depends_on: ["W1", "W2"],
      effects: { artifact_mutation: "none" },
      runtime: { mode: "readonly", joinVerify: true },
    },
  ],
  dispositions: [],
};

test("CEDF R-C: mutating phase self-declaring joinVerify gets NO DUPLICATE_CLAIM exemption", () => {
  const resultsDir = tmp("rc-results");
  try {
    for (const w of ["W1", "W2"]) {
      writeFileSync(join(resultsDir, `${w}.json`), JSON.stringify({ status: "PASS", filesChanged: ["src/a.js"] }));
    }
    const hooks = buildSubagentGraphHooks({ ir: IR, resultsDir, dependencyExecutionId: "exec_x", hooks: {} });
    hooks.onPhaseStart("V");
    // IR is mutated in place by the hook（production wiring contract）.
    const v = IR.phases.find((p) => p.phase_id === "V");
    assert.equal(v.runtime.dependencyReconciliation.verdict, "CONFLICT");
    assert.ok(
      v.runtime.dependencyConflicts.some((c) => c.startsWith("DEPENDENCY_CONFLICT:DUPLICATE_CLAIM")),
      `expected DUPLICATE_CLAIM conflict, got ${JSON.stringify(v.runtime.dependencyConflicts)}`,
    );
  } finally { rmSync(resultsDir, { recursive: true, force: true }); }
});

test("CEDF R-C: genuine non-mutating join verifier stays exempt from DUPLICATE_CLAIM", () => {
  const ir = {
    verdict: "PASS",
    phases: [
      { phase_id: "W1", depends_on: [], effects: { artifact_mutation: "required" }, runtime: { mode: "subagent", agentRole: "writer" } },
      // A real readonly join verifier overlapping the same subject.
      { phase_id: "J", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "subagent", agentRole: "readonly-analyst", joinVerify: true } },
      { phase_id: "V", depends_on: ["W1", "J"], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly", joinVerify: true } },
    ],
    dispositions: [],
  };
  const resultsDir = tmp("rc-exempt-results");
  try {
    writeFileSync(join(resultsDir, "W1.json"), JSON.stringify({ status: "PASS", filesChanged: ["src/a.js"] }));
    writeFileSync(join(resultsDir, "J.json"), JSON.stringify({ status: "PASS", filesInspected: ["src/a.js"] }));
    const hooks = buildSubagentGraphHooks({ ir, resultsDir, dependencyExecutionId: "exec_x", hooks: {} });
    hooks.onPhaseStart("V");
    const v = ir.phases.find((p) => p.phase_id === "V");
    assert.equal(v.runtime.dependencyReconciliation.verdict, "COHERENT");
    assert.equal(v.runtime.dependencyConflicts, undefined);
  } finally { rmSync(resultsDir, { recursive: true, force: true }); }
});

test("CEDF R-B: dispatcher gate fails closed BEFORE any spawn on every consumer channel", async () => {
  const repoPath = tmp("rb-repo");
  const scratchRoot = tmp("rb-scratch");
  const resultsDir = tmp("rb-results");
  try {
    const factoryHost = subagentExecutorFactory({ profile: "test", repoPath, scratchRoot, resultsDir, maxRepairAttempts: 0 });
    const adapter = factoryHost({ resultSink: null })().runAdapter;
    const conflicts = ["DEPENDENCY_CONFLICT:DUPLICATE_CLAIM:W1!W2:src/a.js"];
    // All three routing modes must short-circuit identically.
    for (const rt of [
      { mode: "subagent", agentRole: "writer", dependencyConflicts: conflicts },
      { mode: "readonly", dependencyConflicts: conflicts },
      { mode: "subagent", agentRole: "readonly-analyst", dependencyConflicts: conflicts },
    ]) {
      const result = await adapter({ executionId: "exec_rb", taskCard: { runtime: rt } });
      assert.equal(result.status, "error");
      assert.ok(String(result.error).startsWith("DEPENDENCY_CONFLICT_HOLD"));
    }
    // Negative control: without conflicts the readonly channel dispatches
    // past the gate. The bare request fails downstream adapter-contract
    // validation（colima unavailable in unit context）— what matters is that
    // the rejection is NOT the dispatcher's own conflict gate.
    let dispatched = null;
    try {
      await adapter({ executionId: "exec_rb2", taskCard: { runtime: { mode: "readonly" } } });
    } catch (e) {
      dispatched = e;
    }
    assert.ok(dispatched, "expected the unconflicted readonly dispatch to proceed and fail downstream");
    assert.ok(!String(dispatched?.message ?? dispatched).startsWith("DEPENDENCY_CONFLICT_HOLD"));
  } finally {
    for (const d of [repoPath, scratchRoot, resultsDir]) rmSync(d, { recursive: true, force: true });
  }
});
