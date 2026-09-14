// test/v2/test-cedf-freshness-fencing.mjs
//
// CEDF Phase 7/11 direct proofs — stale-child-result fencing at the durable
// graph resume seam.
//
// Bypass being closed（CEDF adversarial A5）: resumeDurableGraph Stage 11 and
// classifyInterruptedWriter previously accepted ANY parseable
// phases/<id>/result.json as durable truth — no checkpoint-hash comparison,
// no journal PHASE_PASSED/HELD proof, no generation binding. A result.json
// left by a crashed/aborted generation suppressed re-execution.
//
// These tests pin the evidence-reuse validity gate（childResultFoldGate）and
// its consumption by classifyInterruptedWriter + the terminal result record's
// generation binding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  DurableGraphRun,
  childResultFoldGate,
  classifyInterruptedWriter,
} from "../../src/v2/durable-graph.mjs";
import { RunEvidenceStore, sha256Text } from "../../src/evidence/run-evidence-store.mjs";
import { collectRepositoryFingerprint, buildIrSha256, buildDagFingerprint } from "../../src/v2/checkpoint-bridge.mjs";

const EXEC = "exec_" + "0b".repeat(16);

const IR = {
  verdict: "PASS",
  phases: [
    { phase_id: "P1", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly" } },
  ],
  dispositions: [],
};

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "cedf-fresh-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "cedf@test"]);
  git(dir, ["config", "user.name", "cedf"]);
  writeFileSync(join(dir, "README.md"), "# cedf freshness fixture\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

// Minimal durable-run fixture exposing a real RunEvidenceStore + execDir.
function makeRunFixture(label) {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), `cedf-fresh-persist-${label}-`));
  const run = new DurableGraphRun({
    ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
    cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), `cedf-fresh-scratch-${label}-`)),
    maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
    persistence: { root: persistenceRoot, executionId: EXEC },
  });
  const store = new RunEvidenceStore({
    root: persistenceRoot, executionId: run.executionId, chainId: run.chainId,
    checkpointId: run.checkpointId, repoRoot: repo,
  });
  run.execDir = store.init();
  run.store = store;
  run.repoFingerprint = collectRepositoryFingerprint(repo);
  run.inputFingerprint = run._graphInputFingerprint();
  run.configurationFingerprint = run._configurationFingerprint();
  run.irSha = buildIrSha256(IR);
  run.dagSha = buildDagFingerprint(IR);
  return { repo, persistenceRoot, run, store, execDir: run.execDir };
}

function writeResultArtifact(execDir, phaseId, obj) {
  mkdirSync(join(execDir, "phases", phaseId), { recursive: true });
  writeFileSync(join(execDir, "phases", phaseId, "result.json"), JSON.stringify(obj));
}

const SNAPSHOT = (over = {}) => ({ phase_result_hashes: {}, graph: { recovery_generation: 0 }, ...over });

function cleanup(fx) {
  rmSync(fx.repo, { recursive: true, force: true });
  rmSync(fx.persistenceRoot, { recursive: true, force: true });
}

test("CEDF F1: same-generation journaled result folds (legitimate crash window)", () => {
  const fx = makeRunFixture("f1");
  try {
    // Crash window: PHASE_PASSED journaled, checkpoint never landed
    //（snapshot pins no hash, phase state still pending）.
    fx.store.appendEvent({ event_type: "PHASE_PASSED", stage: "phase", phase_id: "P1", attempt: 0, status: "passed", payload: { final: "PASS" } });
    writeResultArtifact(fx.execDir, "P1", { phase_id: "P1", final: "PASS", status: "passed", graph_generation: 0 });
    const gate = childResultFoldGate({ snapshot: SNAPSHOT(), store: fx.store, execDir: fx.execDir, phaseId: "P1" });
    assert.equal(gate.ok, true);
    assert.equal(gate.record.final, "PASS");
  } finally { cleanup(fx); }
});

test("CEDF F2: parseable result WITHOUT journal proof is rejected (the Stage-11 bypass)", () => {
  const fx = makeRunFixture("f2");
  try {
    writeResultArtifact(fx.execDir, "P1", { phase_id: "P1", final: "PASS", status: "passed" });
    const gate = childResultFoldGate({ snapshot: SNAPSHOT(), store: fx.store, execDir: fx.execDir, phaseId: "P1" });
    assert.deepEqual({ ok: gate.ok, code: gate.code }, { ok: false, code: "JOURNAL_PROOF_MISSING" });
  } finally { cleanup(fx); }
});

test("CEDF F3: tampered bytes rejected against the checkpoint-pinned sha256", () => {
  const fx = makeRunFixture("f3");
  try {
    fx.store.appendEvent({ event_type: "PHASE_PASSED", stage: "phase", phase_id: "P1", attempt: 0, status: "passed", payload: { final: "PASS" } });
    writeResultArtifact(fx.execDir, "P1", { phase_id: "P1", final: "PASS", status: "passed" });
    // Pin a DIFFERENT digest than what is on disk（tamper / regeneration）.
    const snapshot = SNAPSHOT({ phase_result_hashes: { P1: sha256Text('{"forged":true}') } });
    const gate = childResultFoldGate({ snapshot, store: fx.store, execDir: fx.execDir, phaseId: "P1" });
    assert.deepEqual({ ok: gate.ok, code: gate.code }, { ok: false, code: "RESULT_HASH_MISMATCH" });
  } finally { cleanup(fx); }
});

test("CEDF F4: journal outcome must match the artifact final (PASS<->HELD)", () => {
  const fx = makeRunFixture("f4");
  try {
    fx.store.appendEvent({ event_type: "PHASE_HELD", stage: "phase", phase_id: "P1", attempt: 0, status: "held", payload: { final: "HOLD" } });
    writeResultArtifact(fx.execDir, "P1", { phase_id: "P1", final: "PASS", status: "passed" });
    const gate = childResultFoldGate({ snapshot: SNAPSHOT(), store: fx.store, execDir: fx.execDir, phaseId: "P1" });
    assert.deepEqual({ ok: gate.ok, code: gate.code }, { ok: false, code: "JOURNAL_OUTCOME_MISMATCH" });
  } finally { cleanup(fx); }
});

test("CEDF F5: stale-generation result rejected by generation binding", () => {
  const fx = makeRunFixture("f5");
  try {
    fx.store.appendEvent({ event_type: "PHASE_PASSED", stage: "phase", phase_id: "P1", attempt: 0, status: "passed", payload: { final: "PASS" } });
    writeResultArtifact(fx.execDir, "P1", { phase_id: "P1", final: "PASS", status: "passed", graph_generation: 0 });
    const snapshot = SNAPSHOT({ graph: { recovery_generation: 1 } });
    const gate = childResultFoldGate({ snapshot, store: fx.store, execDir: fx.execDir, phaseId: "P1" });
    assert.deepEqual({ ok: gate.ok, code: gate.code }, { ok: false, code: "STALE_GENERATION" });
  } finally { cleanup(fx); }
});

test("CEDF F6: malformed / invalid-final artifacts never fold", () => {
  const fx = makeRunFixture("f6");
  try {
    mkdirSync(join(fx.execDir, "phases", "P1"), { recursive: true });
    writeFileSync(join(fx.execDir, "phases", "P1", "result.json"), "{not json");
    let gate = childResultFoldGate({ snapshot: SNAPSHOT(), store: fx.store, execDir: fx.execDir, phaseId: "P1" });
    assert.equal(gate.code, "RESULT_ARTIFACT_MALFORMED");
    writeResultArtifact(fx.execDir, "P1", { phase_id: "P1", final: "REPAIR" });
    gate = childResultFoldGate({ snapshot: SNAPSHOT(), store: fx.store, execDir: fx.execDir, phaseId: "P1" });
    assert.equal(gate.code, "RESULT_FINAL_INVALID");
  } finally { cleanup(fx); }
});

test("CEDF F7: classifyInterruptedWriter ALREADY_APPLIED requires gate proof when store present", () => {
  const fx = makeRunFixture("f7");
  try {
    const phase = { phase_id: "W" };
    // Artifact WITH journal proof -> ALREADY_APPLIED（never re-mutate）.
    fx.store.appendEvent({ event_type: "PHASE_PASSED", stage: "phase", phase_id: "W", attempt: 0, status: "passed", payload: { final: "PASS" } });
    writeResultArtifact(fx.execDir, "W", { phase_id: "W", final: "PASS", status: "passed", graph_generation: 0 });
    assert.equal(
      classifyInterruptedWriter({ snapshot: SNAPSHOT(), phase, execDir: fx.execDir, graphMeta: {}, store: fx.store }),
      "ALREADY_APPLIED",
    );
    // Same artifact WITHOUT proof -> presence alone proves nothing; with no
    // side-effect id and an existing（unverified）artifact -> INVALID.
    const fx2 = makeRunFixture("f7b");
    try {
      writeResultArtifact(fx2.execDir, "W", { phase_id: "W", final: "PASS", status: "passed" });
      assert.equal(
        classifyInterruptedWriter({ snapshot: SNAPSHOT(), phase, execDir: fx2.execDir, graphMeta: {}, store: fx2.store }),
        "INVALID",
      );
    } finally { cleanup(fx2); }
  } finally { cleanup(fx); }
});

test("CEDF F8: terminal result records carry graph_generation provenance", async () => {
  const fx = makeRunFixture("f8");
  try {
    fx.run.state.phaseStates = { P1: "pending" };
    fx.run.state.pendingResults = { P1: { final: "PASS", attempt: 0, reason: null, graph_generation: 0 } };
    await fx.run._onRunnerView({ statuses: { P1: "passed" }, leaseHolder: null, newlySkipped: [] });
    const recordPath = join(fx.execDir, "phases", "P1", "result.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.final, "PASS");
    assert.equal(record.graph_generation, 0);
    assert.notEqual(record.reason, "PENDING_RESULT_SYNTHESIZED");

    // Synthesized fallback（pendingResult missing）is stamped, never silent.
    const fx2 = makeRunFixture("f8b");
    try {
      fx2.run.state.phaseStates = { P1: "pending" };
      await fx2.run._onRunnerView({ statuses: { P1: "passed" }, leaseHolder: null, newlySkipped: [] });
      const synthesized = JSON.parse(readFileSync(join(fx2.execDir, "phases", "P1", "result.json"), "utf8"));
      assert.equal(synthesized.reason, "PENDING_RESULT_SYNTHESIZED");
      assert.equal(synthesized.synthesized, true);
      assert.equal(synthesized.graph_generation, 0);
    } finally { cleanup(fx2); }
  } finally { cleanup(fx); }
});
