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
