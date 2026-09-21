// test/subagent/test-authored-result-provenance.mjs
//
// WP1 — authoritative-result provenance（multi-session continuity）:
//   - a persisted dependency result is an ENVELOPE
//     (autoloop.subagent.authored-result/v1), host-authored at phase
//     terminal, host-verified at consumption — never a bare agent payload;
//   - verifyAuthoredResultProvenance fail-closes on: malformed envelope,
//     wrong execution, wrong producer phase, future generation, stale
//     generation, missing identity binding, tampered / cross-wired identity;
//   - a rejected dependency rides the EXISTING blockingFindings channel
//     (runtime.dependencyConflicts) and the executor dispatcher refuses to
//     spawn the dependent phase;
//   - a VALID dependency is actually consumed: the dependent phase's
//     dependencyResultIdentities carry the producer's status/filesChanged
//     (unwrapped from the envelope), not merely a found file;
//   - rebindAuthoredResultForEra re-authors ONLY the era fields of a
//     gate-accepted surviving result and refuses non-envelope records.
//
// Run: node --test test/subagent/test-authored-result-provenance.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTHORED_RESULT_SCHEMA,
  verifyAuthoredResultProvenance,
  rebindAuthoredResultForEra,
  buildSubagentGraphHooks,
  subagentExecutorFactory,
} from "../../src/subagent/subagent-graph-runner.mjs";
import { phaseExecutionId } from "../../src/v2/phase-task-card.mjs";
import { agentExecutionIdFor, stageAgentExecutionId } from "../../src/subagent/subagent-contract.mjs";

const EXEC = "exec_0123456789abcdef0123456789abcdef";

function envelope(overrides = {}) {
  return {
    schema_version: AUTHORED_RESULT_SCHEMA,
    executionId: EXEC,
    phase_id: "SA-R1",
    phaseExecutionId: phaseExecutionId(EXEC, "SA-R1"),
    agentExecutionId: agentExecutionIdFor(EXEC, "SA-R1"),
    inputContextIdentity: "icid_0123456789abcdef",
    graph_generation: 0,
    recorded_at: new Date().toISOString(),
    result: {
      schema_version: "autoloop.subagent.structured-result/v1",
      status: "PASS",
      claims: ["found 3 file(s) containing TODO under /src/docs"],
    },
    ...overrides,
  };
}

function tmp(label) {
  return mkdtempSync(join(tmpdir(), `authored-prov-${label}-`));
}

// ── verifyAuthoredResultProvenance ────────────────────────────────────────

test("provenance: valid authored-result envelope is accepted and unwraps the payload", () => {
  const v = verifyAuthoredResultProvenance(envelope(), { executionId: EXEC, phaseId: "SA-R1", generation: 0 });
  assert.equal(v.ok, true);
  assert.equal(v.result.status, "PASS");
  assert.deepEqual(v.result.claims, ["found 3 file(s) containing TODO under /src/docs"]);
});

test("provenance: malformed envelope rejected", () => {
  for (const bad of [
    null,
    "not-an-object",
    42,
    { status: "PASS" }, // bare legacy payload — no envelope
    { ...envelope(), schema_version: "autoloop.subagent.authored-result/v2" },
    { ...envelope(), result: null },
    { ...envelope(), phaseExecutionId: "exec_forged" },
    { ...envelope(), graph_generation: "0" },
    { ...envelope(), recorded_at: "not-a-date" },
  ]) {
    const v = verifyAuthoredResultProvenance(bad, { executionId: EXEC, phaseId: "SA-R1", generation: 0 });
    assert.equal(v.ok, false, `expected rejection for ${JSON.stringify(bad)?.slice(0, 60)}`);
    assert.match(v.code, /^DEPENDENCY_/);
  }
});

test("provenance: wrong execution rejected", () => {
  const v = verifyAuthoredResultProvenance(envelope({ executionId: "exec_ffffffffffffffffffffffffffffffff" }), { executionId: EXEC, phaseId: "SA-R1", generation: 0 });
  assert.equal(v.ok, false);
  assert.equal(v.code, "DEPENDENCY_EXECUTION_MISMATCH");
});

test("provenance: wrong producer phase rejected", () => {
  const v = verifyAuthoredResultProvenance(envelope({ phase_id: "SA-R2", phaseExecutionId: phaseExecutionId(EXEC, "SA-R2") }), { executionId: EXEC, phaseId: "SA-R1", generation: 0 });
  assert.equal(v.ok, false);
  assert.equal(v.code, "DEPENDENCY_PHASE_MISMATCH");
});

test("provenance: stale generation rejected", () => {
  const v = verifyAuthoredResultProvenance(envelope({ graph_generation: 0 }), { executionId: EXEC, phaseId: "SA-R1", generation: 1 });
  assert.equal(v.ok, false);
  assert.equal(v.code, "DEPENDENCY_GENERATION_STALE");
});

test("provenance: future generation rejected", () => {
  const v = verifyAuthoredResultProvenance(envelope({ graph_generation: 2 }), { executionId: EXEC, phaseId: "SA-R1", generation: 1 });
  assert.equal(v.ok, false);
  assert.equal(v.code, "DEPENDENCY_GENERATION_AHEAD");
});

test("provenance: same generation accepted (same-era sibling)", () => {
  const v = verifyAuthoredResultProvenance(envelope({ graph_generation: 1 }), { executionId: EXEC, phaseId: "SA-R1", generation: 1 });
  assert.equal(v.ok, true);
});

test("provenance: missing identity binding rejected", () => {
  for (const [k, v] of [["agentExecutionId", null], ["inputContextIdentity", ""], ["agentExecutionId", 42]]) {
    const r = verifyAuthoredResultProvenance(envelope({ [k]: v }), { executionId: EXEC, phaseId: "SA-R1", generation: 0 });
    assert.equal(r.ok, false, `${k}=${JSON.stringify(v)} must be rejected`);
    assert.equal(r.code, "DEPENDENCY_IDENTITY_UNBOUND");
  }
});

test("provenance: tampered / cross-wired identity rejected (re-derivation)", () => {
  for (const forged of [
    "agent_forged",
    agentExecutionIdFor(EXEC, "SA-R2"), // cross-wired from another node
    agentExecutionIdFor("exec_other", "SA-R1"), // another execution
    agentExecutionIdFor(EXEC, "SA-R1") + "0", // near-miss tamper
  ]) {
    const r = verifyAuthoredResultProvenance(envelope({ agentExecutionId: forged }), { executionId: EXEC, phaseId: "SA-R1", generation: 0 });
    assert.equal(r.ok, false, `forged identity ${forged} must be rejected`);
    assert.equal(r.code, "DEPENDENCY_IDENTITY_MISMATCH");
  }
});

test("provenance: stage-scoped repairer identity accepted (bounded repair loop re-authors the result)", () => {
  const repairer = stageAgentExecutionId(EXEC, "SA-R1", "repairer");
  const r = verifyAuthoredResultProvenance(envelope({ agentExecutionId: repairer }), { executionId: EXEC, phaseId: "SA-R1", generation: 0 });
  assert.equal(r.ok, true, "the repairer's stage identity is a legitimate producer identity");
});

// ── rebindAuthoredResultForEra ────────────────────────────────────────────

test("rebind: re-authors ONLY era fields; payload + identity stay verbatim", () => {
  const e = envelope({ graph_generation: 0 });
  const rb = rebindAuthoredResultForEra(e, { generation: 3 });
  assert.equal(rb.graph_generation, 3);
  assert.equal(rb.result, e.result, "agent payload stays the same object");
  assert.equal(rb.agentExecutionId, e.agentExecutionId);
  assert.equal(rb.inputContextIdentity, e.inputContextIdentity);
  assert.equal(rb.phaseExecutionId, e.phaseExecutionId);
  assert.equal(rb.executionId, e.executionId);
  assert.ok(Date.parse(rb.recorded_at) >= Date.parse(e.recorded_at));
});

test("rebind: refuses non-envelope records (no silent legacy upgrade)", () => {
  for (const bad of [null, { status: "PASS" }, { ...envelope(), schema_version: "other/v1" }]) {
    assert.throws(() => rebindAuthoredResultForEra(bad, { generation: 1 }), (e) => e.code === "DEPENDENCY_RESULT_PROVENANCE_MISSING");
  }
});

// ── consumption wiring: onPhaseStart + dispatcher gate ────────────────────

function makeIr() {
  return {
    verdict: "PASS",
    phases: [
      { phase_id: "SA-R1", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "subagent", agentRole: "readonly-analyst" } },
      { phase_id: "SA-W1", depends_on: ["SA-R1"], effects: { artifact_mutation: "required" }, runtime: { mode: "subagent", agentRole: "writer" } },
    ],
    dispositions: [],
  };
}

test("consumption: valid dependency is ACTUALLY consumed (identities carry producer status/filesChanged)", () => {
  const ir = makeIr();
  const resultsDir = tmp("valid-results");
  try {
    writeFileSync(join(resultsDir, "SA-R1.json"), JSON.stringify(envelope(), null, 2) + "\n");
    const hooks = buildSubagentGraphHooks({ ir, resultsDir, dependencyExecutionId: EXEC, hooks: {}, durableGraphGeneration: 0 });
    hooks.onPhaseStart("SA-W1");
    const w1 = ir.phases.find((p) => p.phase_id === "SA-W1");
    // consumed, not merely found: the writer's envelope carries the producer
    // payload's status/filesChanged through the canonical identity channel.
    assert.deepEqual(w1.runtime.dependencyResultIdentities, [
      { nodeId: "SA-R1", phaseExecutionId: phaseExecutionId(EXEC, "SA-R1"), status: "PASS", filesChanged: null },
    ]);
    assert.equal(w1.runtime.dependencyConflicts, undefined, "no blocking findings for a valid envelope");
    // reconciliation consumed the unwrapped payload (no conflicts)
    assert.equal(w1.runtime.dependencyReconciliation.verdict, "COHERENT");
  } finally { rmSync(resultsDir, { recursive: true, force: true }); }
});

test("consumption: rejected provenance seeds blockingFindings and the dispatcher refuses to spawn", async () => {
  const ir = makeIr();
  const resultsDir = tmp("reject-results");
  try {
    // stale generation: producer era 0, consumer era 1
    writeFileSync(join(resultsDir, "SA-R1.json"), JSON.stringify(envelope({ graph_generation: 0 }), null, 2) + "\n");
    const hooks = buildSubagentGraphHooks({ ir, resultsDir, dependencyExecutionId: EXEC, hooks: {}, durableGraphGeneration: 1 });
    hooks.onPhaseStart("SA-W1");
    const w1 = ir.phases.find((p) => p.phase_id === "SA-W1");
    assert.ok(
      Array.isArray(w1.runtime.dependencyConflicts)
        && w1.runtime.dependencyConflicts.some((f) => f.startsWith("DEPENDENCY_PROVENANCE:DEPENDENCY_GENERATION_STALE:SA-R1:")),
      `expected a provenance blocking finding, got ${JSON.stringify(w1.runtime.dependencyConflicts)}`,
    );

    // the EXISTING dispatcher gate refuses every consumer channel BEFORE any
    // spawn（same mechanism as the CEDF reconciliation CONFLICT gate）.
    const repoPath = tmp("reject-repo");
    const scratchRoot = tmp("reject-scratch");
    try {
      const factoryHost = subagentExecutorFactory({ profile: "test", repoPath, scratchRoot, resultsDir, maxRepairAttempts: 0 });
      const adapter = factoryHost({ resultSink: null })().runAdapter;
      const result = await adapter({ executionId: EXEC, taskCard: { runtime: { mode: "subagent", agentRole: "writer", dependencyConflicts: w1.runtime.dependencyConflicts } } });
      assert.equal(result.status, "error");
      assert.ok(String(result.error).startsWith("DEPENDENCY_CONFLICT_HOLD"), `expected the conflict hold, got ${result.error}`);
      assert.ok(result.metadata.dependencyConflicts.some((f) => f.startsWith("DEPENDENCY_PROVENANCE:")));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  } finally { rmSync(resultsDir, { recursive: true, force: true }); }
});

test("consumption: absent dependency file stays the pre-existing existsSync-filter behavior", () => {
  const ir = makeIr();
  const resultsDir = tmp("absent-results");
  mkdirSync(resultsDir, { recursive: true });
  try {
    const hooks = buildSubagentGraphHooks({ ir, resultsDir, dependencyExecutionId: EXEC, hooks: {}, durableGraphGeneration: 0 });
    hooks.onPhaseStart("SA-W1");
    const w1 = ir.phases.find((p) => p.phase_id === "SA-W1");
    assert.equal(w1.runtime.dependencyConflicts, undefined, "absence is NOT a provenance finding");
    assert.deepEqual(w1.runtime.dependencyResultIdentities, [], "absent dependency carries no identity");
  } finally { rmSync(resultsDir, { recursive: true, force: true }); }
});
