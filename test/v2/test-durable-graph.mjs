// test/v2/test-durable-graph.mjs
//
// DE-2 — production Graph durability focused tests.
//
// Covers（focused strategy, Stage 23; colima-dependent full-path tests live in
// scripts/de2-crash-matrix.mjs + the canonical acceptance）:
//   - F1 semantic post-head event classification（fail closed on unknown）
//   - F2/F3 regression: resumed runner-view must NOT re-terminalize already-
//     passed phases（_lastRunnerStatuses seeding）
//   - writer side-effect identity determinism（Stage 8）
//   - interrupted-writer classification（Stage 7/9/10）
//   - permitted-dirty resume policy（production dirty worktree）
//   - DurableGraphRun state machine on a temp repo（journal + checkpoint +
//     resume reconstruction, no colima）
//
// Run: node --test test/v2/test-durable-graph.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  classifyPostHeadEvent, POST_HEAD_EVENT_SEMANTICS, buildDagFingerprint, buildIrSha256,
  buildInputFingerprint, collectRepositoryFingerprint, validateRunIdentity,
  readCheckpoint, classifyResumeCapability,
} from "../../src/v2/checkpoint-bridge.mjs";
import { RunEvidenceStore, assertValidEvidenceRoot, canonicalJson, sha256Text } from "../../src/evidence/run-evidence-store.mjs";
import {
  DurableGraphRun, writerSideEffectId, classifyInterruptedWriter,
  captureWorktreeDirtyState, resumeDirtyAllowed, resumeDurableGraph,
} from "../../src/v2/durable-graph.mjs";
import { runSubagentGraph, durableExecutionIdFor } from "../../src/subagent/subagent-graph-runner.mjs";

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// valid execution id（mintExecutionId format: exec_ + 32 hex）
const EXEC = "exec_" + "0a".repeat(16);

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "de2-test-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "de2@test"]);
  git(dir, ["config", "user.name", "de2"]);
  writeFileSync(join(dir, "README.md"), "# de2 fixture\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

const IR = {
  verdict: "PASS",
  phases: [
    { phase_id: "R1", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly" } },
    { phase_id: "R2", depends_on: ["R1"], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly" } },
  ],
  dispositions: [],
};

// ── F1: semantic post-head classification ────────────────────────────────
test("DE-2 F1: post-head events are classified semantically; unknown fails closed", () => {
  // DE-1 observed post-head events must be replay-safe or resume-safe
  for (const ev of ["DAG_ACCEPTED", "PHASE_STARTED", "EXECUTOR_COMPLETED", "REVIEWER_COMPLETED", "PHASE_PASSED", "PHASE_SKIPPED", "SYSTEM_DELTA_READY"]) {
    assert.notEqual(classifyPostHeadEvent(ev), "invalid", `${ev} must not fail closed after F1`);
  }
  assert.equal(classifyPostHeadEvent("CHECKPOINT_PUBLISHED"), "replay-safe");
  assert.equal(classifyPostHeadEvent("PHASE_READY"), "replay-safe");
  assert.equal(classifyPostHeadEvent("RUN_PASSED"), "replay-safe");
  // unknown / unclassified events STILL fail closed
  assert.equal(classifyPostHeadEvent("TOTALLY_UNKNOWN_EVENT"), "invalid");
  assert.equal(classifyPostHeadEvent(null), "invalid");
  assert.equal(classifyPostHeadEvent(undefined), "invalid");
});

// ── F2/F3: resumed runner view must not re-terminalize passed phases ────
test("DE-2 F2/F3: seeding _lastRunnerStatuses prevents duplicate terminal journaling on resume", async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-persist-"));
  try {
    const run = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-scratch-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
    });
    const store = new RunEvidenceStore({ root: persistenceRoot, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
    run.execDir = store.init();
    run.store = store;
    run.repoFingerprint = collectRepositoryFingerprint(repo);
    run.inputFingerprint = run._graphInputFingerprint();
    run.configurationFingerprint = run._configurationFingerprint();
    run.irSha = buildIrSha256(IR);
    run.dagSha = buildDagFingerprint(IR);
    run.state.phaseStates = { R1: "pending", R2: "pending" };
    store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
    await run.checkpoint({});
    store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: {} });
    await run.checkpoint({});

    // First-run view: R1 terminal.
    await run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    const passedEventsAfterFirst = journalEvents(store).filter((e) => e.event_type === "PHASE_PASSED");
    assert.equal(passedEventsAfterFirst.length, 1);
    // A real resume shares the SAME journal (same executionId): capture the
    // pre-resume journal count, then assert the resumed view adds ZERO events.
    const journalCountBeforeResume = store.verifyJournal().count;

    // Simulate crash + NEW process resume: reconstruct from the checkpoint,
    // seed _lastRunnerStatuses from persisted phase_states (the F2/F3 fix).
    const run2 = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-scratch2-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
      recovery: { executionAttempt: 2, recoveryGeneration: 1, resumed: true, replayOf: EXEC, recovered: false, duplicateSuppressed: 0 },
    });
    const store2 = new RunEvidenceStore({ root: persistenceRoot, executionId: run2.executionId, chainId: run2.chainId, checkpointId: run2.checkpointId, repoRoot: repo });
    run2.execDir = store2.init();
    run2.store = store2;
    run2.state.phaseStates = { R1: "passed", R2: "pending" };
    // THE FIX: seed the baseline so the resumed view does not re-terminalize R1.
    run2.state._lastRunnerStatuses = { ...run2.state.phaseStates };

    await run2._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    const journalCountAfterSeeded = store2.verifyJournal().count;
    // R1 was already passed in the baseline -> the seeded resumed view must
    // add ZERO new journal events（no duplicate terminal journaling）.
    assert.equal(journalCountAfterSeeded, journalCountBeforeResume, "F2/F3 regression: seeded resume re-terminalized an already-passed phase");

    // WITHOUT the seed, the same view re-terminals R1 and the exclusive
    // result-artifact write collides -> JOURNAL_OUT_OF_ORDER（the DE-1
    // reproduced defect）. Regression proof: the unseeded resume THROWS.
    const run3 = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-scratch3-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
    });
    const store3 = new RunEvidenceStore({ root: persistenceRoot, executionId: run3.executionId, chainId: run3.chainId, checkpointId: run3.checkpointId, repoRoot: repo });
    run3.execDir = store3.init();
    run3.store = store3;
    run3.state.phaseStates = { R1: "passed", R2: "pending" };
    // NO seed（the pre-F2/F3 behavior）
    let unseededError = null;
    try {
      await run3._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    } catch (e) {
      unseededError = e?.code ?? e?.message ?? String(e);
    }
    assert.ok(unseededError, "regression must reproduce: unseeded resume fails (JOURNAL_OUT_OF_ORDER)");
    assert.match(String(unseededError), /JOURNAL_OUT_OF_ORDER|EEXIST/, `expected JOURNAL_OUT_OF_ORDER, got ${unseededError}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

function journalEvents(store) {
  const j = store.verifyJournal();
  const out = [];
  for (let s = 1; s <= j.count; s++) {
    try { out.push(store.readEvent(s).event); } catch { break; }
  }
  return out;
}

// ── Stage 8: writer side-effect identity ────────────────────────────────
test("DE-2 Stage 8: writer side-effect identity is deterministic and per-phase", () => {
  const a1 = writerSideEffectId({ executionId: "exec-1", phaseId: "W", graphGeneration: 0 });
  const a2 = writerSideEffectId({ executionId: "exec-1", phaseId: "W", graphGeneration: 0 });
  const b = writerSideEffectId({ executionId: "exec-1", phaseId: "W", graphGeneration: 1 });
  const c = writerSideEffectId({ executionId: "exec-2", phaseId: "W", graphGeneration: 0 });
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.notEqual(a1, c);
});

// ── Stage 7/9/10: interrupted-writer classification ─────────────────────
test("DE-2 Stage 7/9/10: interrupted writer is classified from durable truth, never guessed", () => {
  const execDir = mkdtempSync(join(tmpdir(), "de2-writer-"));
  const snapshot = { writer_phase_active: true };
  const graphMeta = { side_effect_ids: { W: "sid-1" }, worktree_info: { W: { worktreeDir: join(execDir, "wt"), verified: false } } };
  try {
    // no result artifact, no worktree -> RECONSTRUCTABLE（side effect id known）
    const c1 = classifyInterruptedWriter({ snapshot, phase: { phase_id: "W" }, execDir, graphMeta });
    assert.equal(c1, "RECONSTRUCTABLE");

    // worktree exists + verified -> RESTORABLE
    mkdirSync(join(execDir, "wt"), { recursive: true });
    const c2 = classifyInterruptedWriter({ snapshot, phase: { phase_id: "W" }, execDir, graphMeta: { side_effect_ids: { W: "sid-1" }, worktree_info: { W: { worktreeDir: join(execDir, "wt"), verified: true } } } });
    assert.equal(c2, "RESTORABLE");

    // worktree exists but unverified -> CONFLICTED
    const c3 = classifyInterruptedWriter({ snapshot, phase: { phase_id: "W" }, execDir, graphMeta: { side_effect_ids: { W: "sid-1" }, worktree_info: { W: { worktreeDir: join(execDir, "wt"), verified: false } } } });
    assert.equal(c3, "CONFLICTED");

    // committed result artifact -> ALREADY_APPLIED（never re-mutate）
    mkdirSync(join(execDir, "phases", "W"), { recursive: true });
    writeFileSync(join(execDir, "phases", "W", "result.json"), JSON.stringify({ phase_id: "W", final: "PASS", status: "passed" }));
    const c4 = classifyInterruptedWriter({ snapshot, phase: { phase_id: "W" }, execDir, graphMeta });
    assert.equal(c4, "ALREADY_APPLIED");

    // nothing known -> INVALID（fail closed）; remove the c4 result artifact
    // so the durable truth is genuinely empty.
    rmSync(join(execDir, "phases", "W", "result.json"), { force: true });
    const c5 = classifyInterruptedWriter({ snapshot, phase: { phase_id: "W" }, execDir, graphMeta: { side_effect_ids: {}, worktree_info: {} } });
    assert.equal(c5, "INVALID");
  } finally {
    rmSync(execDir, { recursive: true, force: true });
  }
});

// ── Permitted-dirty resume policy ───────────────────────────────────────
test("DE-2 production resume: permitted-dirty policy accepts frozen set + graph output scope, rejects drift", () => {
  const repo = makeFixtureRepo();
  try {
    // baseline dirty: one pre-existing modified file
    writeFileSync(join(repo, "README.md"), "# de2 fixture\nmodified\n");
    const dirtyScope = ["docs/pi-graph-output"];
    const frozen = captureWorktreeDirtyState(repo, dirtyScope);
    assert.notEqual(frozen.filteredDigest, "clean");

    // same dirty set -> allowed
    assert.equal(resumeDirtyAllowed({ currentPorcelain: frozen.porcelain, permittedDigest: frozen.filteredDigest, dirtyScope }), true);

    // graph writes ONLY inside its own output scope -> still allowed
    mkdirSync(join(repo, "docs/pi-graph-output", "de2"), { recursive: true });
    writeFileSync(join(repo, "docs/pi-graph-output", "de2", "out.json"), "{}");
    const afterGraph = captureWorktreeDirtyState(repo, dirtyScope);
    assert.equal(resumeDirtyAllowed({ currentPorcelain: afterGraph.porcelain, permittedDigest: frozen.filteredDigest, dirtyScope }), true);

    // unrelated drift -> fail closed
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "unrelated.mjs"), "// drift\n");
    const drifted = captureWorktreeDirtyState(repo, dirtyScope);
    assert.equal(resumeDirtyAllowed({ currentPorcelain: drifted.porcelain, permittedDigest: frozen.filteredDigest, dirtyScope }), false);

    // clean worktree -> allowed
    git(repo, ["checkout", "--", "."]);
    git(repo, ["clean", "-fdq"]);
    assert.equal(resumeDirtyAllowed({ currentPorcelain: "", permittedDigest: frozen.filteredDigest, dirtyScope }), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── DurableGraphRun state machine（no colima; temp repo + real store）───
test("DE-2 DurableGraphRun: journal + checkpoint + resume reconstruction on a temp repo", async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-sm-"));
  const scratchRoot = mkdtempSync(join(tmpdir(), "de2-sm-scratch-"));
  const executionId = EXEC;
  try {
    const run = new DurableGraphRun({
      ir: IR, parent: { scope: { allowed_paths: ["docs/"] } }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot,
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId },
    });
    const store = new RunEvidenceStore({ root: persistenceRoot, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
    run.execDir = store.init();
    run.store = store;
    run.repoFingerprint = collectRepositoryFingerprint(repo);
    run.inputFingerprint = run._graphInputFingerprint();
    run.configurationFingerprint = run._configurationFingerprint();
    run.irSha = buildIrSha256(IR);
    run.dagSha = buildDagFingerprint(IR);
    run.state.phaseStates = { R1: "pending", R2: "pending" };
    store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
    await run.checkpoint({});
    store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: {} });
    await run.checkpoint({});

    // drive the durable hooks for R1 (phase start + terminal view)
    const hooks = run.buildGraphHooks(IR);
    await hooks.onPhaseStart({ phaseId: "R1" });
    await run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });

    // checkpoint must reflect R1 passed + journal aligned
    const cp = run.store ? await run.checkpoint({}) : null;
    const j = run.store.verifyJournal();
    const events = journalEvents(run.store);
    assert.ok(events.some((e) => e.event_type === "PHASE_READY" && e.phase_id === "R1"));
    assert.ok(events.some((e) => e.event_type === "PHASE_STARTED" && e.phase_id === "R1"));
    assert.ok(events.some((e) => e.event_type === "PHASE_PASSED" && e.phase_id === "R1"));
    assert.ok(j.count >= 6);

    // terminal: RUN_PASSED + manifest
    await run.terminal("PASS", null);
    assert.ok(run.manifestSha);
    const rm = JSON.parse(readFileSync(join(run.execDir, "manifest.json"), "utf8"));
    assert.equal(rm.final_verdict, "PASS");
    assert.ok(rm.checkpoint_sha256);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

// ── recovery manifest shape（Stage 27）───────────────────────────────────
test("DE-2 Stage 27: recovery manifest is machine-readable and carries no content blobs", async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-rm-"));
  try {
    const run = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-rm-scratch-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
      recovery: { executionAttempt: 2, recoveryGeneration: 1, resumed: true, replayOf: EXEC, recovered: true, duplicateSuppressed: 1 },
    });
    run.state.phaseStates = { R1: "passed", R2: "pending" };
    run.state.repairBudgetUsed = 1;
    const m = run.buildRecoveryManifest();
    assert.equal(m.schema, "autoloop.recovery-manifest/v1");
    assert.equal(m.recoveryGeneration, 1);
    assert.equal(m.resumed, true);
    assert.equal(m.repairBudget.used, 1);
    assert.deepEqual(m.nodeStates, { R1: "passed", R2: "pending" });
    // no content blobs: keys are identities/counters only
    const blobKeys = Object.keys(m).filter((k) => /content|secret|text|body/i.test(k));
    assert.equal(blobKeys.length, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

// ── Stage 28: security negative cases（fail closed）─────────────────────
import { join as j2 } from "node:path";

test("DE-2 Stage 28: resume rejects tampered checkpoint / foreign repo / invalid identity", async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-sec-"));
  const execId = "exec_" + "12".repeat(16);
  try {
    const run = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-sec-scratch-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: execId },
    });
    const store = new RunEvidenceStore({ root: persistenceRoot, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
    run.execDir = store.init();
    run.store = store;
    run.repoFingerprint = collectRepositoryFingerprint(repo);
    run.inputFingerprint = run._graphInputFingerprint();
    run.configurationFingerprint = run._configurationFingerprint();
    run.irSha = buildIrSha256(IR);
    run.dagSha = buildDagFingerprint(IR);
    run.state.phaseStates = { R1: "pending", R2: "pending" };
    store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
    await run.checkpoint({});

    // 1. tampered checkpoint -> checksum mismatch（fail closed）
    const { resumeDurableGraph } = await import("../../src/v2/durable-graph.mjs");
    const curPath = join(persistenceRoot, execId, "CURRENT.json");
    const good = readFileSync(curPath, "utf8");
    writeFileSync(curPath, good.slice(0, Math.floor(good.length / 2)) + "TAMPERED");
    let err1 = null;
    try {
      await resumeDurableGraph({ persistenceRoot, executionId: execId, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }], cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-sec-scratch2-")), maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {}, dirtyScope: [] });
    } catch (e) { err1 = e?.code ?? e?.message; }
    assert.match(String(err1 ?? ""), /CHECKSUM|CORRUPT|MISMATCH|RESUME_FINGERPRINT/i, "tampered checkpoint must fail closed");

    // 2. invalid execution identity -> rejected（no path traversal possible）
    let err2 = null;
    try {
      await resumeDurableGraph({ persistenceRoot, executionId: "../../etc/passwd", parent: { scope: {} }, manifest: [], cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-sec-scratch3-")), maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {}, dirtyScope: [] });
    } catch (e) { err2 = e?.code ?? e?.message; }
    assert.match(String(err2 ?? ""), /INVALID_EXECUTION_ID|RESUME_FINGERPRINT/i, "path-traversal execution id must be rejected");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

// ── DE-2 PRODUCTION WIRING（external review blocker #1）───────────────────
// The production Graph entry（runSubagentGraph — every card closeout script
// invokes it）runs under native durable execution BY DEFAULT:
//   production invocation -> runSubagentGraph -> runDurableGraph ->
//   runColimaGraph -> journal + checkpoint store.
// These tests prove the call chain and that normal production calls cannot
// bypass durability.

test("DE-2 production wiring: durableExecutionIdFor maps logical run ids deterministically", () => {
  // valid C2D-minted ids pass through unchanged
  assert.equal(durableExecutionIdFor("exec_" + "ab".repeat(16)), "exec_" + "ab".repeat(16));
  // logical production run ids map deterministically to a valid durable id
  const a = durableExecutionIdFor("cbm4-self-closeout-20260807");
  const b = durableExecutionIdFor("cbm4-self-closeout-20260807");
  const c = durableExecutionIdFor("cbm4-self-closeout-20260808");
  assert.equal(a, b, "same logical id -> same durable id（stable across crash + resume）");
  assert.match(a, /^exec_[0-9a-f]{32}$/, "durable id is a valid C2D execution id");
  assert.notEqual(a, c, "different logical id -> different durable id");
});

test("DE-2 production wiring: every production caller stays durable (no durable:false bypass)", () => {
  const scriptDir = join(process.cwd(), "scripts");
  const offenders = [];
  const callers = [];
  // DE-2R: scan only ACTUAL runner-call bodies. A plain /durable:false/
  // regex also matches the literal prose ``durable: false`` inside card
  // closeout scripts' design-decision text（de2-self-closeout.mjs）— a false
  // positive that hid the guard's intent. The call-body scan below still
  // catches any production script passing durable:false to runSubagentGraph /
  // runColimaGraph, while ignoring prose outside calls.
  const runnerCallBodies = (src) => {
    const bodies = [];
    for (const fn of ["runSubagentGraph(", "runColimaGraph("]) {
      let from = 0;
      while (true) {
        const start = src.indexOf(fn, from);
        if (start < 0) break;
        let depth = 0;
        let i = start + fn.length - 1;
        for (; i < src.length; i++) {
          if (src[i] === "(") depth++;
          else if (src[i] === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        bodies.push(src.slice(start, i + 1));
        from = i + 1;
      }
    }
    return bodies;
  };
  for (const f of readdirSync(scriptDir).filter((f) => f.endsWith(".mjs")).sort()) {
    const src = readFileSync(join(scriptDir, f), "utf8");
    if (!src.includes("runSubagentGraph")) continue;
    if (runnerCallBodies(src).some((body) => /\bdurable\s*:\s*false\b/.test(body))) offenders.push(f);
    if (src.includes("await runSubagentGraph(")) callers.push(f);
  }
  // NO production script may opt out of durable execution（durable: false is
  // a documented TEST-ONLY escape hatch）.
  assert.deepEqual(offenders, [], "production scripts must not disable durability");
  // every production card closeout script invokes the production Graph entry.
  assert.ok(callers.length >= 8, `expected >=8 production callers, got ${callers.length}: ${callers.join(", ")}`);
});

// Real end-to-end proof: runSubagentGraph（production entry）with the DEFAULT
// durable wiring produces journal + checkpoints + manifest on disk, returns
// recovery/evidence provenance only the durable layer emits, and a fresh
// process can resume the completed run from durable truth. Uses the REAL
// colima pipeline（tiny readonly graph）exactly like the crash matrix.
test("DE-2 production wiring: runSubagentGraph default durable -> checkpoints/journal/evidence; resume complete", { timeout: 600000 }, async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-wiring-persist-"));
  const scratchRoot = mkdtempSync(join(tmpdir(), "de2-wiring-scratch-"));
  const logicalId = "de2-production-wiring-run-1";
  const durableId = durableExecutionIdFor(logicalId);
  const roCommand = (nodeId) => `true; echo "${nodeId}_DONE"; touch /src/.de2-probe 2>&1 && echo SRC_WRITABLE || echo SRC_WRITE_DENIED`;
  const PROD_IR = {
    verdict: "PASS",
    phases: [
      { phase_id: "R1", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly", command: roCommand("R1"), expect: { stdoutContains: ["R1_DONE", "SRC_WRITE_DENIED"] }, limits: { memoryMiB: 256, timeoutMs: 60000 } } },
      { phase_id: "V1", depends_on: ["R1"], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly", command: roCommand("V1"), expect: { stdoutContains: ["V1_DONE", "SRC_WRITE_DENIED"] }, limits: { memoryMiB: 256, timeoutMs: 60000 } } },
    ],
    dispositions: [],
  };
  try {
    const r = await runSubagentGraph({
      ir: PROD_IR,
      parent: { scope: { allowed_paths: [], forbidden_paths: [] } },
      manifest: [{ requirement_id: "r1", text: "de2 production wiring" }],
      cwd: repo,
      executionId: logicalId,
      repoPath: repo,
      scratchRoot,
      maxRepairAttempts: 1,
      timeoutMs: 120000,
      // durable defaults to TRUE — this is the production wiring being proven.
      persistence: { root: persistenceRoot, executionId: durableId },
      dirtyScope: [],
    });
    assert.equal(r.final, "PASS", `production graph PASS via durable wiring (${r.reason})`);
    // logical id preserved for downstream callers; durable id exposed
    assert.equal(r.executionId, logicalId, "caller's logical executionId preserved");
    assert.equal(r.durableExecutionId, durableId, "durable execution id exposed");
    // recovery provenance ONLY the durable layer emits（runColimaGraph alone
    // never adds `recovery`/`evidence`）— proves the durable wrapper ran.
    assert.deepEqual(r.recovery, { executionAttempt: 1, recoveryGeneration: 0, resumed: false, replayOf: null, recovered: false, duplicateSuppressed: 0 });
    // assertValidEvidenceRoot resolves symlinks（macOS /var -> /private/var）,
    // so compare against the resolved root.
    assert.equal(r.evidence?.root, realpathSync(persistenceRoot), "evidence root bound");
    assert.ok(r.evidence?.manifest_sha256, "final manifest bound");
    assert.equal(r.evidence?.final_verdict, "PASS");
    assert.ok(r.evidence?.recovery_manifest, "recovery manifest present");

    // durable artifacts on disk: checkpoint + journal + manifest
    const execDir = join(persistenceRoot, durableId);
    assert.ok(existsSync(join(execDir, "CURRENT.json")), "checkpoint (CURRENT.json) durably written");
    const journalFiles = readdirSync(join(execDir, "journal")).filter((f) => f.endsWith(".json")).sort();
    assert.ok(journalFiles.length >= 6, `journal events durably written (${journalFiles.length})`);
    assert.ok(existsSync(join(execDir, "manifest.json")), "run manifest written");
    assert.ok(existsSync(join(execDir, "artifacts", "decomposition-ir.json")), "frozen IR artifact written");

    // fresh-process resume of the completed run returns the terminal verdict
    // from durable truth（no graph re-execution）. Resume must reuse the SAME
    // repoPath/scratchRoot namespace the run froze（namespace drift fails
    // closed）.
    const resume = await resumeDurableGraph({
      persistenceRoot,
      executionId: durableId,
      parent: { scope: {} },
      manifest: [],
      cwd: repo,
      repoPath: repo,
      scratchRoot,
      maxRepairAttempts: 1,
      timeoutMs: 60000,
      signal: undefined,
      hooks: {},
      dirtyScope: [],
    });
    assert.equal(resume.final, "PASS", "resume of a completed durable run returns PASS");
    assert.equal(resume.stage, "complete", "resume short-circuits on terminal truth");
    assert.equal(resume.complete, true, "resume complete flag");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});
// ── WP1: PARALLEL_FANOUT_ROLLOVER_INTAKE (reverse control) ───────────────
// Drives the REAL DurableGraphRun + buildGraphHooks onPhaseStart seam with
// the canonical parallel IR（SA-R1 ‖ SA-R2 → SA-W1 → SA-V1）and the REAL
// canonical executor shape（deriveCanonicalRolloverExecutor contract:
// skipped when no trigger, ok:true + rolloverId when accepted）.
//
// Required parallel chronology:
//   SA-R1 starts → SA-R2 starts WHILE SA-R1 is non-terminal
//   → executor NOT invoked/consumed at SA-R2
//   → parallel phases terminal → triggered observation exists
//   → SA-W1 boundary → executor invoked EXACTLY ONCE with a
//   triggered === true observation.
//
// Pre-repair（_phaseStartCount authority）the intake disarmed at SA-R2's
// start and SA-W1 saw no executor call — this control FAILS. Post-repair
//（quiescence gate + accepted-only consumption）it PASSES.
test("WP1 parallel fan-out: rollover intake defers through in-flight parallel start and fires exactly once at the quiescent SA-W1 boundary", { timeout: 120000 }, async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-wp1-parallel-persist-"));
  try {
    const PARALLEL_IR = {
      verdict: "PASS",
      phases: [
        { phase_id: "SA-R1", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly" } },
        { phase_id: "SA-R2", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly" } },
        { phase_id: "SA-W1", depends_on: ["SA-R1", "SA-R2"], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly" } },
        { phase_id: "SA-V1", depends_on: ["SA-W1"], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly" } },
      ],
      dispositions: [],
    };
    const run = new DurableGraphRun({
      ir: PARALLEL_IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-wp1-parallel-scratch-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
    });
    const store = new RunEvidenceStore({ root: persistenceRoot, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
    run.execDir = store.init();
    run.store = store;
    run.repoFingerprint = collectRepositoryFingerprint(repo);
    run.inputFingerprint = run._graphInputFingerprint();
    run.configurationFingerprint = run._configurationFingerprint();
    run.irSha = buildIrSha256(PARALLEL_IR);
    run.dagSha = buildDagFingerprint(PARALLEL_IR);
    run.state.phaseStates = { "SA-R1": "pending", "SA-R2": "pending", "SA-W1": "pending", "SA-V1": "pending" };
    store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
    await run.checkpoint({});
    store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: {} });
    await run.checkpoint({});

    // THE canonical executor shape（deriveCanonicalRolloverExecutor）:
    // skipped when the runner has no triggered observation; otherwise the
    // accepted-intake result. The trigger event the real intake would carry
    // lives on run.state._rolloverObservation（the WP1 producer's output）.
    let executorCalls = [];
    run.rolloverRequestExecutor = async (r) => {
      const observation = r.state?._rolloverObservation ?? null;
      if (!observation || observation.triggered !== true) {
        return { ok: true, skipped: true, reason: observation?.reason ?? "no automatic trigger observed" };
      }
      executorCalls.push({
        phaseStates: { ...r.state.phaseStates },
        completed: [...r.state.completedPhaseIds],
        triggered: observation.triggered === true,
        observation,
      });
      return { ok: true, rolloverId: "ro_wp1_reverse_control", successorBinding: { sessionGeneration: 1 } };
    };

    const hooks = run.buildGraphHooks(PARALLEL_IR);

    // 1. SA-R1 starts（first boundary — no completed phase yet）.
    await hooks.onPhaseStart({ phaseId: "SA-R1" });
    // 2. SA-R2 starts WHILE SA-R1 is non-terminal（the parallel fan-out）.
    await hooks.onPhaseStart({ phaseId: "SA-R2" });
    // 3. The executor must NOT have been invoked/consumed at SA-R2.
    assert.equal(executorCalls.length, 0,
      "executor must not be invoked while a parallel phase is in flight");
    assert.notEqual(run.state._rolloverExecuted, true,
      "the one-shot opportunity must not be consumed at an in-flight start");

    // 4. Parallel phases finish（canonical runner view → durable terminal）.
    await run._onRunnerView({ statuses: { "SA-R1": "passed", "SA-R2": "passed", "SA-W1": "pending", "SA-V1": "pending" }, leaseHolder: null, newlySkipped: [] });

    // 5. The triggered observation exists（WP1 producer output; here set to
    //    the exact shape observeProviderUsageAndTrigger returns on a
    //    threshold-crossing usage）.
    run.state._rolloverObservation = {
      triggered: true, observed: true,
      occupancy: 7000, usageEventId: "evt_wp1_reverse_control",
      triggerEvent: {
        trigger: "CONTEXT_THRESHOLD_REACHED",
        source: "wp1-reverse-control",
        authorityDecisionRef: "usage:evt_wp1_reverse_control",
        freshness: new Date().toISOString(),
        taskIdentity: EXEC, runIdentity: EXEC,
        admissionIdentity: "wp1-reverse-control-admission",
        observedFact: { providerReported: true, usageRecordId: "evt_wp1_reverse_control", occupancy: 7000 },
      },
    };

    // 6. SA-W1 reaches the first legitimate quiescent start boundary.
    await hooks.onPhaseStart({ phaseId: "SA-W1" });
    // 7+8. The executor was invoked EXACTLY ONCE, at a boundary where both
    //      parallel phases are terminal, and the observation it saw carried
    //      triggered === true.
    assert.equal(executorCalls.length, 1,
      `executor must be invoked exactly once at the SA-W1 boundary（got ${executorCalls.length}）`);
    assert.equal(executorCalls[0].triggered, true,
      "the observation at the accepted intake must be triggered === true");
    assert.deepEqual(executorCalls[0].completed.sort(), ["SA-R1", "SA-R2"],
      "the completed evidence at intake must be the parallel pair");
    assert.equal(run.state._rolloverExecuted, true,
      "an ACCEPTED rollover consumes the one-shot opportunity");

    // 9. Duplicate boundary/replay: another start must NOT re-invoke.
    await hooks.onPhaseStart({ phaseId: "SA-V1" });
    assert.equal(executorCalls.length, 1, "no second intake after acceptance");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

// N2: a legitimate quiescent boundary WITHOUT a triggered observation must
// leave the future opportunity available（skipped result does not consume）.
test("WP1 quiescent boundary without a trigger: executor runs, reports skipped, future opportunity remains available", { timeout: 120000 }, async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-wp1-skip-persist-"));
  try {
    const run = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-wp1-skip-scratch-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
    });
    const store = new RunEvidenceStore({ root: persistenceRoot, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
    run.execDir = store.init();
    run.store = store;
    run.repoFingerprint = collectRepositoryFingerprint(repo);
    run.inputFingerprint = run._graphInputFingerprint();
    run.configurationFingerprint = run._configurationFingerprint();
    run.irSha = buildIrSha256(IR);
    run.dagSha = buildDagFingerprint(IR);
    run.state.phaseStates = { R1: "pending", R2: "pending" };
    store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
    await run.checkpoint({});
    store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: {} });
    await run.checkpoint({});

    let calls = 0;
    run.rolloverRequestExecutor = async () => {
      calls += 1;
      // no triggered observation exists → the canonical executor skips
      return { ok: true, skipped: true, reason: "no automatic trigger observed" };
    };

    const hooks = run.buildGraphHooks(IR);
    await hooks.onPhaseStart({ phaseId: "R1" });
    await run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });

    // First quiescent boundary: executor invoked, skipped, NOT consumed.
    await hooks.onPhaseStart({ phaseId: "R2" });
    assert.equal(calls, 1, "executor invoked at the first quiescent boundary");
    assert.notEqual(run.state._rolloverExecuted, true,
      "a skipped result must NOT consume the future opportunity");

    // A later trigger + a later quiescent boundary still reaches the intake.
    run.state._rolloverObservation = { triggered: true, observed: true, triggerEvent: { trigger: "CONTEXT_THRESHOLD_REACHED" } };
    let accepted = 0;
    run.rolloverRequestExecutor = async () => {
      calls += 1;
      accepted += 1;
      return { ok: true, rolloverId: "ro_wp1_late" };
    };
    await hooks.onPhaseStart({ phaseId: "R2" });
    assert.equal(calls, 2, "the executor is reachable again after a skipped boundary");
    assert.equal(accepted, 1, "the later trigger is accepted");
    assert.equal(run.state._rolloverExecuted, true, "the accepted intake consumes the opportunity");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

// N3: below-threshold usage at a legitimate boundary → no rollover; a later
// above-threshold observation may still trigger.
test("WP1 N3 below-threshold usage: skipped at the boundary, later above-threshold observation triggers", { timeout: 120000 }, async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-wp1-n3-persist-"));
  try {
    const run = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-wp1-n3-scratch-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
    });
    const store = new RunEvidenceStore({ root: persistenceRoot, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
    run.execDir = store.init();
    run.store = store;
    run.repoFingerprint = collectRepositoryFingerprint(repo);
    run.inputFingerprint = run._graphInputFingerprint();
    run.configurationFingerprint = run._configurationFingerprint();
    run.irSha = buildIrSha256(IR);
    run.dagSha = buildDagFingerprint(IR);
    run.state.phaseStates = { R1: "pending", R2: "pending" };
    store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
    await run.checkpoint({});
    store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: {} });
    await run.checkpoint({});

    let calls = 0;
    run.rolloverRequestExecutor = async (r) => {
      calls += 1;
      const observation = r.state?._rolloverObservation ?? null;
      if (!observation || observation.triggered !== true) return { ok: true, skipped: true, reason: "no automatic trigger observed" };
      return { ok: true, rolloverId: "ro_wp1_n3" };
    };

    const hooks = run.buildGraphHooks(IR);
    await hooks.onPhaseStart({ phaseId: "R1" });
    await run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    // below-threshold observation（observed but NOT triggered）
    run.state._rolloverObservation = { triggered: false, observed: true, occupancy: 50, reason: "below threshold" };
    await hooks.onPhaseStart({ phaseId: "R2" });
    assert.equal(calls, 1, "executor consulted at the legitimate boundary");
    assert.notEqual(run.state._rolloverExecuted, true, "below-threshold does not consume");

    // later above-threshold observation at the next quiescent boundary
    run.state._rolloverObservation = { triggered: true, observed: true, occupancy: 7000, triggerEvent: { trigger: "CONTEXT_THRESHOLD_REACHED" } };
    await hooks.onPhaseStart({ phaseId: "R2" });
    assert.equal(calls, 2, "executor reachable after below-threshold skip");
    assert.equal(run.state._rolloverExecuted, true, "later above-threshold observation triggers");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

// N4/N5: exactly-once semantics over duplicate boundaries.
test("WP1 N4/N5 accepted intake at a legitimate boundary: exactly one rollover across duplicate/replay boundaries", { timeout: 120000 }, async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-wp1-n45-persist-"));
  try {
    const run = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-wp1-n45-scratch-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
    });
    const store = new RunEvidenceStore({ root: persistenceRoot, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
    run.execDir = store.init();
    run.store = store;
    run.repoFingerprint = collectRepositoryFingerprint(repo);
    run.inputFingerprint = run._graphInputFingerprint();
    run.configurationFingerprint = run._configurationFingerprint();
    run.irSha = buildIrSha256(IR);
    run.dagSha = buildDagFingerprint(IR);
    run.state.phaseStates = { R1: "pending", R2: "pending" };
    store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
    await run.checkpoint({});
    store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: {} });
    await run.checkpoint({});

    let accepted = 0;
    run.rolloverRequestExecutor = async (r) => {
      const observation = r.state?._rolloverObservation ?? null;
      if (!observation || observation.triggered !== true) return { ok: true, skipped: true, reason: "no automatic trigger observed" };
      accepted += 1;
      return { ok: true, rolloverId: `ro_wp1_n45_${accepted}` };
    };

    const hooks = run.buildGraphHooks(IR);
    await hooks.onPhaseStart({ phaseId: "R1" });
    await run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    run.state._rolloverObservation = { triggered: true, observed: true, triggerEvent: { trigger: "CONTEXT_THRESHOLD_REACHED" } };
    // N4: legitimate boundary with above-threshold usage → exactly one rollover.
    await hooks.onPhaseStart({ phaseId: "R2" });
    assert.equal(accepted, 1, "exactly one rollover at the legitimate boundary");
    // N5: duplicate boundary / replay of the same phase start → no second rollover.
    await hooks.onPhaseStart({ phaseId: "R2" });
    await hooks.onPhaseStart({ phaseId: "R2" });
    assert.equal(accepted, 1, "duplicate boundary/replay never mints a second rollover");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

// N6: canonical rollover already active → the canonical executor's window
// dedup skips; the seam must not treat that skip as consumption failure and
// must never re-drive a second successor.
test("WP1 N6 rollover already active: executor skips, no duplicate successor, opportunity closed by durable dedup", { timeout: 120000 }, async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-wp1-n6-persist-"));
  try {
    const run = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-wp1-n6-scratch-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
    });
    const store = new RunEvidenceStore({ root: persistenceRoot, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
    run.execDir = store.init();
    run.store = store;
    run.repoFingerprint = collectRepositoryFingerprint(repo);
    run.inputFingerprint = run._graphInputFingerprint();
    run.configurationFingerprint = run._configurationFingerprint();
    run.irSha = buildIrSha256(IR);
    run.dagSha = buildDagFingerprint(IR);
    run.state.phaseStates = { R1: "pending", R2: "pending" };
    store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
    await run.checkpoint({});
    store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: {} });
    await run.checkpoint({});

    let accepted = 0;
    run.rolloverRequestExecutor = async (r) => {
      const observation = r.state?._rolloverObservation ?? null;
      if (!observation || observation.triggered !== true) return { ok: true, skipped: true, reason: "no automatic trigger observed" };
      // canonical window dedup（automaticTriggerEligible）: an intent for
      // this owner generation already exists → skipped, NOT ok:false.
      return { ok: true, skipped: true, reason: "an automatic trigger already fired for this owner generation" };
    };

    const hooks = run.buildGraphHooks(IR);
    await hooks.onPhaseStart({ phaseId: "R1" });
    await run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    run.state._rolloverObservation = { triggered: true, observed: true, triggerEvent: { trigger: "CONTEXT_THRESHOLD_REACHED" } };
    await hooks.onPhaseStart({ phaseId: "R2" });
    await hooks.onPhaseStart({ phaseId: "R2" });
    assert.equal(accepted, 0, "an already-active window never mints a successor through the seam");
    assert.notEqual(run.state._rolloverExecuted, true, "a dedup skip is not an accepted intake");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

// N7: stale generation → the canonical executor returns ok:false（the
// beginRollover fence）; the seam propagates it without consuming.
test("WP1 N7 stale generation: {ok:false} executor result is not a consumption event", { timeout: 120000 }, async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-wp1-n7-persist-"));
  try {
    const run = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-wp1-n7-scratch-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
    });
    const store = new RunEvidenceStore({ root: persistenceRoot, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
    run.execDir = store.init();
    run.store = store;
    run.repoFingerprint = collectRepositoryFingerprint(repo);
    run.inputFingerprint = run._graphInputFingerprint();
    run.configurationFingerprint = run._configurationFingerprint();
    run.irSha = buildIrSha256(IR);
    run.dagSha = buildDagFingerprint(IR);
    run.state.phaseStates = { R1: "pending", R2: "pending" };
    store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
    await run.checkpoint({});
    store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: {} });
    await run.checkpoint({});

    let calls = 0;
    run.rolloverRequestExecutor = async () => {
      calls += 1;
      return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "stale generation-0 source identity" };
    };

    const hooks = run.buildGraphHooks(IR);
    await hooks.onPhaseStart({ phaseId: "R1" });
    await run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    run.state._rolloverObservation = { triggered: true, observed: true, triggerEvent: { trigger: "CONTEXT_THRESHOLD_REACHED" } };
    await hooks.onPhaseStart({ phaseId: "R2" });
    assert.equal(calls, 1);
    assert.notEqual(run.state._rolloverExecuted, true, "an {ok:false} result does not consume the opportunity");
    // the §9a gate below still runs on the unchanged durable truth（no
    // rollover block → PROCEED; the fence itself is unchanged and stays
    // green — proven by test/rollover suites）.
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

// N8: terminal task — after run.terminal the run can never reopen: the
// seam only fires from buildGraphHooks' onPhaseStart, which the terminal
// scheduler never re-enters, and _rolloverExecuted is run-local.
test("WP1 N8 terminal task: no lifecycle reopen after terminal publication", { timeout: 120000 }, async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-wp1-n8-persist-"));
  try {
    const run = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-wp1-n8-scratch-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
    });
    const store = new RunEvidenceStore({ root: persistenceRoot, executionId: run.executionId, chainId: run.chainId, checkpointId: run.checkpointId, repoRoot: repo });
    run.execDir = store.init();
    run.store = store;
    run.repoFingerprint = collectRepositoryFingerprint(repo);
    run.inputFingerprint = run._graphInputFingerprint();
    run.configurationFingerprint = run._configurationFingerprint();
    run.irSha = buildIrSha256(IR);
    run.dagSha = buildDagFingerprint(IR);
    run.state.phaseStates = { R1: "pending", R2: "pending" };
    store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
    await run.checkpoint({});
    store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: {} });
    await run.checkpoint({});

    const hooks = run.buildGraphHooks(IR);
    await hooks.onPhaseStart({ phaseId: "R1" });
    await run._onRunnerView({ statuses: { R1: "passed", R2: "passed" }, leaseHolder: null, newlySkipped: [] });
    await run.terminal("PASS", null);
    const countBefore = store.verifyJournal().count;
    // any post-terminal boundary invocation must not reopen the lifecycle
    await hooks.onPhaseStart({ phaseId: "R2" });
    await run._onRunnerView({ statuses: { R1: "passed", R2: "passed" }, leaseHolder: null, newlySkipped: [] });
    const events = journalEvents(store);
    assert.equal(events.filter((e) => e.event_type === "RUN_PASSED").length, 1,
      "terminal publication stays single");
    assert.ok(!events.some((e) => e.event_type === "RUN_STARTED" || e.event_type === "RUN_REOPENED"),
      "no lifecycle reopen event exists");
    // the graph-level reopen refusal is the resume entry's classifyResumeCapability
    const cap = classifyResumeCapability(readCheckpoint(persistenceRoot, EXEC).snapshot);
    assert.notEqual(cap.action, "RESUME", "a terminal run never resumes for re-execution");
    void countBefore;
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});

// N9: crash/replay around the repaired boundary — correctness never depends
// on the in-memory _rolloverExecuted flag: a resumed run reconstructs
// phaseStates/completedPhaseIds from durable truth and the durable window
// dedup（automaticTriggerEligible + beginRollover idempotency）remains the
// primary exactly-once authority.
test("WP1 N9 crash/replay: resumed run re-derives the boundary from durable truth; no duplicate rollover", { timeout: 120000 }, async (t) => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2-wp1-n9-persist-"));
  try {
    // ── attempt 1: quiescent boundary reached, intake accepted, then crash
    const run1 = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-wp1-n9-scratch-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
    });
    const store1 = new RunEvidenceStore({ root: persistenceRoot, executionId: run1.executionId, chainId: run1.chainId, checkpointId: run1.checkpointId, repoRoot: repo });
    run1.execDir = store1.init();
    run1.store = store1;
    run1.repoFingerprint = collectRepositoryFingerprint(repo);
    run1.inputFingerprint = run1._graphInputFingerprint();
    run1.configurationFingerprint = run1._configurationFingerprint();
    run1.irSha = buildIrSha256(IR);
    run1.dagSha = buildDagFingerprint(IR);
    run1.state.phaseStates = { R1: "pending", R2: "pending" };
    store1.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
    await run1.checkpoint({});
    store1.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: {} });
    await run1.checkpoint({});
    const { deriveAckStableFieldDigest, deriveTransferDigest, sessionIdentityDigest } =
      await import("../../src/rollover/rollover-authority.mjs");
    let accepted1 = 0;
    run1.rolloverRequestExecutor = async (r) => {
      const observation = r.state?._rolloverObservation ?? null;
      if (!observation || observation.triggered !== true) return { ok: true, skipped: true, reason: "no automatic trigger observed" };
      accepted1 += 1;
      // the real intake publishes durable rollover state BEFORE returning
      //（beginRollover → … → commitOwnershipTransfer journal + mirror the
      // block through the single-writer checkpoint authority）. Mirror that
      // durable-truth shape with REAL digest authorities so the resumed era
      // sees the window as used — exactly the post-transfer block the
      // canonical ladder leaves on CURRENT（intents carry the automatic
      // trigger for this owner generation; owner = B@g1）.
      const rolloverId = "ro_wp1_n9";
      const srcDigest = sessionIdentityDigest({ adapterKind: "pi-builtin", providerKind: "deepseek", opaqueSessionId: "n9-source", sessionGeneration: 0 });
      const bDigest = sessionIdentityDigest({ adapterKind: "pi-builtin", providerKind: "deepseek", opaqueSessionId: "n9-successor", sessionGeneration: 1 });
      const ack = {
        rolloverId,
        sourceSessionIdentityDigest: srcDigest,
        sourceGeneration: 0,
        targetSessionIdentityDigest: bDigest,
        targetGeneration: 1,
        checkpointRevision: r.state.expectedRevision,
        checkpointDigest: "n9-checkpoint-digest",
        validationDigest: "n9-validation-digest",
      };
      const transfer = {
        rolloverId,
        from: { sessionIdentityDigest: srcDigest, sessionGeneration: 0 },
        to: { sessionIdentityDigest: bDigest, sessionGeneration: 1 },
        checkpointRevision: r.state.expectedRevision,
        ackDigest: deriveAckStableFieldDigest(ack),
        committedAt: new Date().toISOString(),
      };
      transfer.transferDigest = deriveTransferDigest(transfer);
      r.state.rolloverMirror = {
        schema: "autoloop.rollover/v1",
        state: "OWNERSHIP_TRANSFER_COMMITTED",
        owner: { session_identity_digest: bDigest, session_generation: 1 },
        active_rollover_id: rolloverId,
        intents: { [rolloverId]: { trigger: "CONTEXT_THRESHOLD_REACHED", sourceGeneration: 0 } },
        acks: { [rolloverId]: { ...ack, readyAt: new Date().toISOString(), status: "READY" } },
        transfers: { [rolloverId]: transfer },
        retirements: {},
      };
      await r.checkpoint({});
      return { ok: true, rolloverId };
    };
    const hooks1 = run1.buildGraphHooks(IR);
    await hooks1.onPhaseStart({ phaseId: "R1" });
    await run1._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    run1.state._rolloverObservation = { triggered: true, observed: true, triggerEvent: { trigger: "CONTEXT_THRESHOLD_REACHED" } };
    // After an ACCEPTED intake the §9a gate refuses the entering phase's
    // dispatch（A frozen; handover-hold is A's real outcome — the same
    // production timeline the pre-WP1 probe journals as
    // ROLLOVER_HANDOVER_FENCE）. The intake itself already happened.
    try {
      await hooks1.onPhaseStart({ phaseId: "R2" });
    } catch (e) {
      if (!(e instanceof (await import("../../src/v2/durable-graph.mjs")).DurableGraphHoldError)) throw e;
    }
    assert.equal(accepted1, 1, "attempt 1 accepted exactly one intake");
    await run1.checkpoint({}); // crash AFTER the accepted intake checkpoint

    // ── attempt 2: fresh process resumes from durable truth ──
    const run2 = new DurableGraphRun({
      ir: IR, parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot: mkdtempSync(join(tmpdir(), "de2-wp1-n9-scratch2-")),
      maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
      persistence: { root: persistenceRoot, executionId: EXEC },
      recovery: { executionAttempt: 2, recoveryGeneration: 1, resumed: true, replayOf: EXEC, recovered: false, duplicateSuppressed: 0 },
      // the crashed era had ALREADY transferred ownership — the resumed
      // process IS the successor era, gated through the §13a binding exactly
      // as resumeAsSuccessor wires it.
      rolloverSessionBinding: {
        sessionIdentityDigest: sessionIdentityDigest({ adapterKind: "pi-builtin", providerKind: "deepseek", opaqueSessionId: "n9-successor", sessionGeneration: 1 }),
        sessionGeneration: 1,
      },
    });
    const store2 = new RunEvidenceStore({ root: persistenceRoot, executionId: run2.executionId, chainId: run2.chainId, checkpointId: run2.checkpointId, repoRoot: repo });
    run2.execDir = store2.init();
    run2.store = store2;
    // reconstruct from durable truth exactly as resumeDurableGraph does
    const snap = readCheckpoint(persistenceRoot, EXEC).snapshot;
    run2.repoFingerprint = collectRepositoryFingerprint(repo);
    run2.inputFingerprint = run1.inputFingerprint;
    run2.configurationFingerprint = run1.configurationFingerprint;
    run2.irSha = run1.irSha;
    run2.dagSha = run1.dagSha;
    run2.state.expectedRevision = snap.revision;
    run2.state.rolloverMirror = snap.graph?.rollover ?? null;
    run2.state.phaseStates = { ...(snap.phase_states ?? {}) };
    run2.state.completedPhaseIds = [...(snap.completed_phase_ids ?? [])];
    run2.state._lastRunnerStatuses = { ...run2.state.phaseStates };
    assert.equal(run2.state._rolloverExecuted ?? false, false,
      "the run-local flag does not survive the crash（correctness must not depend on it）");

    let accepted2 = 0;
    run2.rolloverRequestExecutor = async (r) => {
      const observation = r.state?._rolloverObservation ?? null;
      if (!observation || observation.triggered !== true) return { ok: true, skipped: true, reason: "no automatic trigger observed" };
      // canonical window dedup over DURABLE truth: the intent for this
      // owner generation already fired → skipped（automaticTriggerEligible）
      const mirror = r.state.rolloverMirror;
      const already = mirror?.intents && Object.values(mirror.intents).some((i) => i?.trigger === "CONTEXT_THRESHOLD_REACHED");
      if (already) return { ok: true, skipped: true, reason: "an automatic trigger already fired for this owner generation" };
      accepted2 += 1;
      return { ok: true, rolloverId: "ro_wp1_n9_dup" };
    };
    const hooks2 = run2.buildGraphHooks(IR);
    run2.state._rolloverObservation = { triggered: true, observed: true, triggerEvent: { trigger: "CONTEXT_THRESHOLD_REACHED" } };
    await hooks2.onPhaseStart({ phaseId: "R2" });
    assert.equal(accepted2, 0, "the resumed era never mints a duplicate rollover");
    assert.notEqual(run2.state._rolloverExecuted, true, "the dedup skip is not a consumption event");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
  }
});
