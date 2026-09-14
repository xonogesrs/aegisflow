// test/subagent/test-result-reconciliation.mjs
//
// CEDF Foundation — child-result reconciliation（pure module + graph-runner
// hook wiring）. Covers:
//   - reconcileChildResults: COHERENT / CONTRADICTORY_OUTCOME /
//     DUPLICATE_CLAIM / trivial inputs / join exclusion / fail-closed input
//   - buildSubagentGraphHooks.onPhaseStart: reconciliation record +
//     dependencyConflicts injection while dependencyResultsDigest stays
//     computable（but is NOT treated as a clean prerequisite）
//   - conflicts ride the EXISTING buildSubagentEnvelope blockingFindings
//     channel（format + validation）

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { reconcileChildResults, reconciliationFinding } from "../../src/subagent/result-reconciliation.mjs";
import { buildSubagentGraphHooks, digestResultsDir } from "../../src/subagent/subagent-graph-runner.mjs";
import { buildSubagentEnvelope, validateSubagentEnvelope } from "../../src/subagent/subagent-contract.mjs";
import { buildReviewAgentCommand } from "../../src/subagent/subagent-review-agent.mjs";

// ── helpers ──────────────────────────────────────────────────────────────

function rec(phaseId, result, role = null) {
  return { phaseId, role, result };
}

function writerResult(status, filesChanged) {
  return {
    schema_version: "autoloop.subagent.writer-result/v1",
    status,
    filesChanged,
    diffSummary: "changed",
    scopeVerification: { ok: true, violations: [] },
    testsExecuted: [],
    testResults: { passed: 1, failed: 0, total: 1 },
  };
}

function coversResult(status, requirementIds) {
  return { status, covers: requirementIds.map((requirement_id) => ({ requirement_id })) };
}

// ── pure module ──────────────────────────────────────────────────────────

test("reconcile: empty dependencies are trivially COHERENT", () => {
  assert.deepEqual(reconcileChildResults([]), { verdict: "COHERENT", conflicts: [] });
});

test("reconcile: a single dependency is trivially COHERENT", () => {
  const r = reconcileChildResults([rec("SA-R1", writerResult("PASS", ["docs/a.md"]))]);
  assert.equal(r.verdict, "COHERENT");
  assert.deepEqual(r.conflicts, []);
});

test("reconcile: disjoint sibling claims stay COHERENT", () => {
  const r = reconcileChildResults([
    rec("W1", writerResult("PASS", ["docs/a.md"])),
    rec("W2", writerResult("PASS", ["docs/b.md"])),
  ]);
  assert.equal(r.verdict, "COHERENT");
  assert.deepEqual(r.conflicts, []);
});

test("reconcile: CONTRADICTORY_OUTCOME on the same file path（one PASS one HOLD）", () => {
  const r = reconcileChildResults([
    rec("W1", writerResult("PASS", ["docs/a.md"])),
    rec("W2", writerResult("HOLD", ["docs/a.md"])),
  ]);
  assert.equal(r.verdict, "CONFLICT");
  assert.deepEqual(r.conflicts, [
    { kind: "CONTRADICTORY_OUTCOME", leftPhaseId: "W1", rightPhaseId: "W2", subject: "docs/a.md" },
  ]);
});

test("reconcile: REPAIR/CANCELLED/error outcomes contradict a PASS", () => {
  for (const status of ["REPAIR", "CANCELLED", "error"]) {
    const r = reconcileChildResults([
      rec("W1", writerResult(status, ["docs/a.md"])),
      rec("W2", writerResult("PASS", ["docs/a.md"])),
    ]);
    assert.equal(r.verdict, "CONFLICT", status);
    assert.equal(r.conflicts[0].kind, "CONTRADICTORY_OUTCOME", status);
  }
});

test("reconcile: CONTRADICTORY_OUTCOME on the same covers requirement_id", () => {
  const r = reconcileChildResults([
    rec("W1", coversResult("PASS", ["R7"])),
    rec("W2", coversResult("REPAIR", ["R7"])),
  ]);
  assert.equal(r.verdict, "CONFLICT");
  assert.deepEqual(r.conflicts, [
    { kind: "CONTRADICTORY_OUTCOME", leftPhaseId: "W1", rightPhaseId: "W2", subject: "requirement:R7" },
  ]);
});

test("reconcile: DUPLICATE_CLAIM when two non-join children claim the same subject complete", () => {
  const r = reconcileChildResults([
    rec("W1", writerResult("PASS", ["docs/a.md"])),
    rec("W2", writerResult("PASS", ["docs/a.md", "docs/b.md"])),
  ]);
  assert.equal(r.verdict, "CONFLICT");
  assert.deepEqual(r.conflicts, [
    { kind: "DUPLICATE_CLAIM", leftPhaseId: "W1", rightPhaseId: "W2", subject: "docs/a.md" },
  ]);
});

test("reconcile: join verifiers never produce DUPLICATE_CLAIM", () => {
  const r = reconcileChildResults([
    rec("W1", writerResult("PASS", ["docs/a.md"])),
    rec("V1", writerResult("PASS", ["docs/a.md"]), "join"),
  ]);
  assert.equal(r.verdict, "COHERENT");
  assert.deepEqual(r.conflicts, []);
});

test("reconcile: unknown statuses carry no outcome claim（no false contradiction）", () => {
  const r = reconcileChildResults([
    rec("W1", writerResult("PASS", ["docs/a.md"])),
    rec("W2", { schema_version: "autoloop.subagent.writer-result/v1", filesChanged: ["docs/a.md"] }),
  ]);
  assert.equal(r.verdict, "COHERENT");
});

test("reconcile: filesInspected is an observation, not an outcome claim", () => {
  const r = reconcileChildResults([
    rec("R1", { status: "PASS", filesInspected: ["docs/a.md"] }),
    rec("R2", { status: "HOLD", filesInspected: ["docs/a.md"] }),
  ]);
  assert.equal(r.verdict, "COHERENT");
});

test("reconcile: unparseable dependency results contribute no claims", () => {
  const r = reconcileChildResults([
    rec("W1", writerResult("PASS", ["docs/a.md"])),
    rec("W2", null),
  ]);
  assert.equal(r.verdict, "COHERENT");
});

test("reconcile: deterministic ordering across multiple conflicts", () => {
  const input = [
    rec("B", writerResult("PASS", ["z.md", "a.md"])),
    rec("A", writerResult("HOLD", ["a.md"])),
    rec("C", writerResult("PASS", ["z.md"])),
  ];
  const forward = reconcileChildResults(input);
  const again = reconcileChildResults(input);
  assert.equal(forward.verdict, "CONFLICT");
  // pure + deterministic: identical input -> identical output（pair
  // orientation follows the caller's fixed dependency order）
  assert.deepEqual(forward, again);
  assert.deepEqual(
    forward.conflicts.map((c) => [c.kind, c.leftPhaseId, c.rightPhaseId, c.subject]),
    [
      ["CONTRADICTORY_OUTCOME", "B", "A", "a.md"],
      ["DUPLICATE_CLAIM", "B", "C", "z.md"],
    ],
  );
});

test("reconcile: fail-closed on malformed input", () => {
  assert.throws(() => reconcileChildResults(null), TypeError);
  assert.throws(() => reconcileChildResults(["not-a-record"]), TypeError);
  assert.throws(() => reconcileChildResults([{ result: {} }]), TypeError); // missing phaseId
  assert.throws(() => reconcileChildResults([rec("W1", 42)]), TypeError);
});

test("reconciliationFinding renders space-free blocking codes", () => {
  const finding = reconciliationFinding({
    kind: "CONTRADICTORY_OUTCOME", leftPhaseId: "W1", rightPhaseId: "W2", subject: "docs/a.md",
  });
  assert.equal(finding, "DEPENDENCY_CONFLICT:CONTRADICTORY_OUTCOME:W1!W2:docs/a.md");
  assert.ok(!/\s/.test(finding), "finding code must be space-free");
});

// ── hook-level wiring ────────────────────────────────────────────────────

function setupHooks(results, phaseExtras = {}) {
  const resultsDir = mkdtempSync(join(tmpdir(), "cedf-recon-"));
  for (const [name, content] of Object.entries(results)) {
    writeFileSync(join(resultsDir, `${name}.json`), JSON.stringify(content, null, 2) + "\n");
  }
  const ir = {
    phases: [
      { phase_id: "SA-R1", runtime: { mode: "subagent", agentRole: "writer", ...phaseExtras.r1 }, depends_on: [] },
      { phase_id: "SA-R2", runtime: { mode: "subagent", agentRole: "writer", ...phaseExtras.r2 }, depends_on: [] },
      { phase_id: "SA-W1", runtime: { mode: "subagent", agentRole: "writer" }, depends_on: ["SA-R1", "SA-R2"] },
      { phase_id: "SA-V1", runtime: { mode: "subagent", ...(phaseExtras.v1 ?? { joinVerify: true }) }, depends_on: ["SA-W1"] },
    ],
  };
  const hooks = buildSubagentGraphHooks({ ir, resultsDir, dependencyExecutionId: "exec_test_0000", hooks: {} });
  const phaseFor = (id) => ir.phases.find((p) => p.phase_id === id);
  const cleanup = () => rmSync(resultsDir, { recursive: true, force: true });
  return { resultsDir, ir, hooks, phaseFor, cleanup };
}

test("hook: CONFLICT injects dependencyConflicts while dependencyResultsDigest stays computable", () => {
  const t = setupHooks({
    "SA-R1": writerResult("PASS", ["docs/pi-graph-output/summary.md"]),
    "SA-R2": writerResult("HOLD", ["docs/pi-graph-output/summary.md"]),
  });
  try {
    t.hooks.onPhaseStart("SA-W1");
    const rt = t.phaseFor("SA-W1").runtime;
    // digest still computable（unchanged seam）…
    assert.match(rt.dependencyResultsDigest, /^[0-9a-f]{64}$/);
    assert.equal(rt.dependencyResultsDigest, digestResultsDir(t.resultsDir));
    assert.ok(Array.isArray(rt.dependencyResultIdentities) && rt.dependencyResultIdentities.length === 2);
    // …but it is NOT treated as a clean prerequisite:
    assert.equal(rt.dependencyReconciliation.verdict, "CONFLICT");
    assert.equal(rt.dependencyReconciliation.conflicts[0].kind, "CONTRADICTORY_OUTCOME");
    assert.deepEqual(rt.dependencyConflicts, [
      "DEPENDENCY_CONFLICT:CONTRADICTORY_OUTCOME:SA-R1!SA-R2:docs/pi-graph-output/summary.md",
    ]);
  } finally {
    t.cleanup();
  }
});

test("hook: COHERENT dependencies compute the digest without a dirty marker", () => {
  const t = setupHooks({
    "SA-R1": writerResult("PASS", ["docs/a.md"]),
    "SA-R2": writerResult("PASS", ["docs/b.md"]),
  });
  try {
    t.hooks.onPhaseStart("SA-W1");
    const rt = t.phaseFor("SA-W1").runtime;
    assert.match(rt.dependencyResultsDigest, /^[0-9a-f]{64}$/);
    assert.equal(rt.dependencyReconciliation.verdict, "COHERENT");
    assert.equal(rt.dependencyConflicts, undefined);
  } finally {
    t.cleanup();
  }
});

test("hook: join verifier dependencies are excluded from DUPLICATE_CLAIM at the hook level", () => {
  const t = setupHooks({ "SA-R1": writerResult("PASS", ["docs/a.md"]) });
  try {
    t.hooks.onPhaseStart("SA-V1"); // SA-V1 is joinVerify over SA-W1's result
    const rt = t.phaseFor("SA-V1").runtime;
    // SA-W1 has no persisted result yet -> single loaded record -> COHERENT;
    // the join role marking must not itself introduce claims.
    assert.equal(rt.dependencyReconciliation.verdict, "COHERENT");
  } finally {
    t.cleanup();
  }
});

test("hook: phases without depends_on are untouched", () => {
  const t = setupHooks({});
  try {
    t.hooks.onPhaseStart("SA-R1");
    const rt = t.phaseFor("SA-R1").runtime;
    assert.equal(rt.dependencyReconciliation, undefined);
    assert.equal(rt.dependencyConflicts, undefined);
  } finally {
    t.cleanup();
  }
});

// ── envelope blockingFindings channel（existing consumption surface）──────

test("envelope: conflict findings ride buildSubagentEnvelope.blockingFindings and validate cleanly", () => {
  const conflicts = [
    reconciliationFinding({ kind: "CONTRADICTORY_OUTCOME", leftPhaseId: "W1", rightPhaseId: "W2", subject: "docs/a.md" }),
  ].concat([
    reconciliationFinding({ kind: "DUPLICATE_CLAIM", leftPhaseId: "W1", rightPhaseId: "W3", subject: "docs/b.md" }),
  ]);
  const envelope = buildSubagentEnvelope({
    graphExecutionId: "exec_graph",
    nodeId: "SA-W1",
    phaseExecutionId: "exec_phase",
    agentRole: "writer",
    objective: "o",
    authorizedPaths: ["/work"],
    toolPermissions: ["READ_ONLY"],
    runtimeInstance: { profile: "p", socket: null },
    timeoutMs: 1000,
    dependencyResultsDigest: "d".repeat(64),
    outputSchemaIdentity: "autoloop.subagent.writer-result/v1",
    worktreeIdentity: { worktreeDir: "/wt", head: "h" },
    baseCommit: "h",
    mutationScope: ["docs/a.md"],
    repairBudget: { maxAttempts: 1, remaining: 1 },
    blockingFindings: conflicts,
  });
  assert.deepEqual(envelope.blockingFindings, conflicts);
  const validation = validateSubagentEnvelope(envelope);
  assert.deepEqual(validation, { ok: true, errors: [] });
});

test("review agent command consumes seeded conflict findings as structural HOLD", () => {
  const cmd = buildReviewAgentCommand();
  assert.ok(cmd.includes("REVIEW_SEED_BLOCKING"), "seed env consumed");
  assert.ok(cmd.includes("*DEPENDENCY_CONFLICT*"), "seeded conflicts classified as HOLD");
});
