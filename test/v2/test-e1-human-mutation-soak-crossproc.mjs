// test/v2/test-e1-human-mutation-soak-crossproc.mjs
//
// E1 HUMAN MUTATION SOAK — CROSS-PROCESS MATRIX (5 tests: C1, C4, C8, C14,
// C19). Per the sealed SOAK-TEST-CONTRACT §2 these five cases re-run their
// oracle with a FRESH node child per leg: the restart leg is a real process
// boundary, so the verdict can only come from durable bytes on disk — the
// child imports production modules directly and re-derives everything from
// the persistence root (restart never depends on chat memory, §1.8).
//
// Worker protocol (same sealed pattern as
// test/rollover/test-rollover-crash-matrix.mjs): a worker script is written
// to tmp, spawned with process.execPath, and reports via `KEY:json` lines on
// stdout. Children inherit the runtime-isolation shim through the bootstrap
// module (isolation rule 3: zero VM lifecycle in ANY process).

// Run: node --import ./test/v2/helpers/e1-runtime-isolation-preload.mjs --test test/v2/test-e1-human-mutation-soak-crossproc.mjs
import "./helpers/e1-runtime-isolation-preload.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeNonTerminalRunFixture, makeTerminalPassFixture, makeGraphStoreFixture,
  makeProductionRunFixture, git, fileDigest, readCheckpoint, validateContinuity,
  mkdtempSync, tmpdir, join, rmSync, writeFileSync, readFileSync, existsSync,
  runWorker, workerLine, isolatedHome, cleanupAttestation,
  captureResumeVerdict, journalRows,
} from "./helpers/e1-soak-fixtures.mjs";

const WORKERS = [];
// Repo root passed to every worker (durable-byte-only restarts must import
// production modules from THIS checkout; the URL is set by the harness).
process.env.E1_REPO_ROOT = new URL("../../", import.meta.url).pathname;

async function spawnWorker(src, args) {
  const p = join(tmpdir(), `e1-xproc-worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(p, src);
  const home = isolatedHome();
  const r = await runWorker(p, args, { homeShim: home });
  home.cleanup();
  WORKERS.push({ path: p, pid: r.pid });
  return r;
}

// ── worker payloads (fresh-process legs; see SOAK-TEST-CONTRACT §2) ─────────

const WORKER_RESUME = `
const E1_REPO_ROOT = process.env.E1_REPO_ROOT;
function arg(name) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : null; }
const { resumeDurableGraph } = await import(E1_REPO_ROOT + "/src/v2/durable-graph.mjs");
const root = arg("root"), executionId = arg("exec"), repo = arg("repo"), scratch = arg("scratch");
const admissionArg = arg("admission");
let admission = null;
if (admissionArg === "file") {
  admission = JSON.parse((await import("node:fs")).readFileSync(arg("admissionPath"), "utf8"));
}
let thrown = null, result = null;
try {
  result = await resumeDurableGraph({
    persistenceRoot: root, executionId,
    parent: { scope: {} }, manifest: [{ requirement_id: "r1", text: "x" }],
    cwd: repo, repoPath: repo, scratchRoot: scratch,
    maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
    dirtyScope: arg("dirtyScope") ? [arg("dirtyScope")] : [], admission,
  });
} catch (e) { thrown = { code: e?.code ?? e?.name, message: String(e?.message).slice(0, 200) }; }
process.stdout.write("RESUME:" + JSON.stringify({
  thrown,
  final: result?.final ?? null, stage: result?.stage ?? null, complete: result?.complete ?? null,
  resumed: result?.resumed ?? (result?.recovery?.resumed ?? null),
  replayOf: result?.recovery?.replayOf ?? null,
  recoveryGeneration: result?.recovery?.recoveryGeneration ?? null,
  duplicateSuppressed: result?.recovery?.duplicateSuppressed ?? null,
}) + "\\n");
process.exit(0);
`;

const WORKER_FOLD = `
const E1_REPO_ROOT = process.env.E1_REPO_ROOT;
const { childResultFoldGate } = await import(E1_REPO_ROOT + "/src/v2/durable-graph.mjs");
const bridge = await import(E1_REPO_ROOT + "/src/v2/checkpoint-bridge.mjs");
const evidence = await import(E1_REPO_ROOT + "/src/evidence/run-evidence-store.mjs");
const readCheckpoint = bridge.readCheckpoint;
const RunEvidenceStore = evidence.RunEvidenceStore;
const root = process.argv[process.argv.indexOf("--root") + 1];
const executionId = process.argv[process.argv.indexOf("--exec") + 1];
const cp = readCheckpoint(root, executionId);
const store = new RunEvidenceStore({ root, executionId, chainId: cp.snapshot.chain_id, checkpointId: cp.snapshot.checkpoint_id });
store.init();
const gate = childResultFoldGate({ snapshot: cp.snapshot, store, execDir: store.execDir, phaseId: "R1" });
process.stdout.write("FOLD:" + JSON.stringify({ ok: gate.ok, code: gate.code ?? null, record: gate.record ?? null }) + "\\n");
process.exit(0);
`;

const WORKER_MUTATE = `
const { writeFileSync, mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");
const { execFileSync } = await import("node:child_process");
const ops = JSON.parse(process.argv[process.argv.indexOf("--ops") + 1]);
for (const op of ops) {
  if (op.op === "write") { mkdirSync(dirname(op.path), { recursive: true }); writeFileSync(op.path, op.bytes); }
  else if (op.op === "git") { execFileSync("git", ["-C", op.repo, ...op.args], { stdio: "ignore" }); }
}
process.stdout.write("MUTATED:" + JSON.stringify({ count: ops.length }) + "\\n");
process.exit(0);
`;

// ─────────────────────────────────────────────────────────────────────────────

test("E1 C1 CROSS-PROCESS: human commit observed only through a fresh-process resume (expected_head)", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "xc1" });
  try {
    // Leg 1 (harness process): checkpoint published, non-terminal.
    const snap = fx.checkpoint.snapshot;
    assert.equal(snap.final_verdict, null);
    // HUMAN MUTATES (independent child process, no executor references).
    const mut = await spawnWorker(WORKER_MUTATE, ["--ops", JSON.stringify([
      { op: "write", path: join(fx.repo, "human.txt"), bytes: "cross-process commit\n" },
      { op: "git", repo: fx.repo, args: ["add", "human.txt"] },
      { op: "git", repo: fx.repo, args: ["commit", "-q", "-m", "human cross-process commit"] },
    ])]);
    assert.ok(workerLine(mut.out, "MUTATED"), "external actor acknowledged");
    // Leg 2 (FRESH PROCESS): the restart leg reads durable bytes only.
    const leg2 = await spawnWorker(WORKER_RESUME, ["--root", fx.root, "--exec", fx.executionId, "--repo", fx.repo, "--scratch", fx.scratch]);
    const v = workerLine(leg2.out, "RESUME");
    assert.equal(v.thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.match(v.thrown.message, /repository fingerprint mismatch: expected_head/);
    assert.equal(v.final, null, "stale generation publishes nothing across the process boundary");
    // Cross-process restart stability: leg 3 re-observes the same verdict.
    const leg3 = await spawnWorker(WORKER_RESUME, ["--root", fx.root, "--exec", fx.executionId, "--repo", fx.repo, "--scratch", fx.scratch]);
    assert.equal(workerLine(leg3.out, "RESUME").thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    // Recovery leg in a fresh process: re-baseline ⇒ the SAME durable bytes
    // (journal + artifacts + CURRENT) validate and continue.
    const frozenHead = fx.checkpoint.snapshot.repository_fingerprint.expected_head;
    git(fx.repo, ["reset", "-q", "--hard", frozenHead]);
    git(fx.repo, ["clean", "-fdq"]);
    const leg4 = await spawnWorker(WORKER_RESUME, ["--root", fx.root, "--exec", fx.executionId, "--repo", fx.repo, "--scratch", fx.scratch]);
    const v4 = workerLine(leg4.out, "RESUME");
    assert.equal(v4.thrown, null, "re-baselined run resumes in a fresh process");
    assert.equal(v4.recoveryGeneration, 1);
  } finally { fx.cleanup(); }
});

test("E1 C4 CROSS-PROCESS: permitted-dirty continuation vs out-of-scope drift across process boundaries", async () => {
  const scope = "docs/pi-graph-output";
  const fx = await makeProductionRunFixture({ tag: "xc4", dirtyScope: [scope], dirtySeed: scope });
  try {
    assert.match(String(fx.checkpoint.snapshot.graph?.permitted_dirty_digest), /^dirty_filtered:/);
    // Leg 1 (fresh process): same filtered dirty set ⇒ the fingerprint gate
    // ACCEPTS (the resume reaches terminal truth: stage complete, no
    // fingerprint rejection — in-scope dirty state never fences a restart).
    const leg1 = await spawnWorker(WORKER_RESUME, ["--root", fx.root, "--exec", fx.executionId, "--repo", fx.repo, "--scratch", fx.scratch, "--dirtyScope", scope]);
    const v1 = workerLine(leg1.out, "RESUME");
    assert.equal(v1.thrown?.code ?? null, null, "in-scope dirty state resumes in a fresh process");
    assert.equal(v1.stage, "complete");
    assert.equal(v1.complete, true);
    // HUMAN DRIFTS outside the scope (independent child).
    const mut = await spawnWorker(WORKER_MUTATE, ["--ops", JSON.stringify([
      { op: "write", path: join(fx.repo, "README.md"), bytes: "# cross-process drift\n" },
    ])]);
    assert.ok(workerLine(mut.out, "MUTATED"));
    // Leg 2 (fresh process): drift beyond the frozen scope ⇒ exact reject code.
    const leg2 = await spawnWorker(WORKER_RESUME, ["--root", fx.root, "--exec", fx.executionId, "--repo", fx.repo, "--scratch", fx.scratch, "--dirtyScope", scope]);
    const v2 = workerLine(leg2.out, "RESUME");
    assert.equal(v2.thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.match(v2.thrown.message, /expected_worktree_state|drifted beyond the frozen\/permitted dirty set/);
  } finally { fx.cleanup(); }
});

test("E1 C8 CROSS-PROCESS: tampered phase result refused by the fold gate in a fresh process (RESULT_HASH_MISMATCH)", async () => {
  const fx = await makeGraphStoreFixture({ tag: "xc8" });
  try {
    // Pin an honest R1 result through the real hooks/journal (harness process).
    const hooks = fx.run.buildGraphHooks(fx.ir);
    await hooks.onPhaseStart({ phaseId: "R1" });
    await fx.run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    await fx.run.checkpoint({});
    const resultPath = join(fx.execDir, "phases", "R1", "result.json");
    const pre = fileDigest(resultPath);
    // Positive control in a FRESH process: honest bytes fold (record returned).
    const leg0 = await spawnWorker(WORKER_FOLD, ["--root", fx.root, "--exec", fx.executionId]);
    const g0 = workerLine(leg0.out, "FOLD");
    assert.equal(g0.ok, true);
    // HUMAN EDITS the pinned artifact.
    const mut = await spawnWorker(WORKER_MUTATE, ["--ops", JSON.stringify([
      { op: "write", path: resultPath, bytes: JSON.stringify({ ...JSON.parse(readFileSync(resultPath, "utf8")), reason: "cross-process-human-rewrite" }) },
    ])]);
    assert.ok(workerLine(mut.out, "MUTATED"));
    assert.notEqual(fileDigest(resultPath), pre);
    // Fresh process: the fold gate refuses on the pinned hash — presence of
    // the artifact NEVER proves application across a process boundary.
    const leg1 = await spawnWorker(WORKER_FOLD, ["--root", fx.root, "--exec", fx.executionId]);
    const g1 = workerLine(leg1.out, "FOLD");
    assert.deepEqual({ ok: g1.ok, code: g1.code }, { ok: false, code: "RESULT_HASH_MISMATCH" });
    assert.equal(g1.record ?? null, null, "no fold record for tampered bytes");
    // Restart stability in another fresh process.
    const leg2 = await spawnWorker(WORKER_FOLD, ["--root", fx.root, "--exec", fx.executionId]);
    assert.equal(workerLine(leg2.out, "FOLD").code, "RESULT_HASH_MISMATCH");
  } finally { fx.cleanup(); }
});

test("E1 C14 CROSS-PROCESS: terminal run re-asked from a fresh process short-circuits (zero re-execution)", async () => {
  const fx = await makeTerminalPassFixture({ tag: "xc14" });
  try {
    assert.equal(fx.checkpoint.snapshot.final_verdict, "PASS");
    // Fresh process: resume of the terminal run short-circuits to terminal
    // truth — final PASS, stage complete, resumed=false, duplicates=0.
    const leg1 = await spawnWorker(WORKER_RESUME, ["--root", fx.root, "--exec", fx.executionId, "--repo", fx.repo, "--scratch", fx.scratch]);
    const v = workerLine(leg1.out, "RESUME");
    assert.equal(v.thrown, null);
    assert.equal(v.final, "PASS");
    assert.equal(v.stage, "complete");
    assert.equal(v.complete, true);
    assert.equal(v.resumed, false, "no replay across the process boundary");
    assert.equal(v.duplicateSuppressed, 0);
    // Second fresh process: identical terminal short-circuit.
    const leg2 = await spawnWorker(WORKER_RESUME, ["--root", fx.root, "--exec", fx.executionId, "--repo", fx.repo, "--scratch", fx.scratch]);
    const v2 = workerLine(leg2.out, "RESUME");
    assert.equal(v2.final, "PASS");
    assert.equal(v2.stage, "complete");
    assert.equal(v2.resumed, false);
    assert.equal(v2.duplicateSuppressed, 0);
  } finally { fx.cleanup(); }
});

test("E1 C19 CROSS-PROCESS negative: no mutation ⇒ fresh-process resume continues with recovery provenance", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "xc19" });
  try {
    const before = fx.checkpoint.snapshot;
    assert.equal(before.final_verdict, null);
    // Fresh process, NO mutation: the resumed envelope must carry recovery
    // provenance (replayOf = the original execution id) that only the durable
    // layer can emit — reconstruction from durable bytes, chat-independent.
    const leg1 = await spawnWorker(WORKER_RESUME, ["--root", fx.root, "--exec", fx.executionId, "--repo", fx.repo, "--scratch", fx.scratch]);
    const v = workerLine(leg1.out, "RESUME");
    assert.equal(v.thrown, null);
    assert.equal(v.resumed, true);
    assert.equal(v.replayOf, fx.executionId);
    assert.equal(v.recoveryGeneration, (before.graph?.recovery_generation ?? 0) + 1);
    // Second fresh process: leg1 continued and reached its terminal state;
    // leg2 re-observes the SAME terminal truth with zero re-execution
    // (restarted graph = short-circuit, no new provenance generation).
    const leg2 = await spawnWorker(WORKER_RESUME, ["--root", fx.root, "--exec", fx.executionId, "--repo", fx.repo, "--scratch", fx.scratch]);
    const v2 = workerLine(leg2.out, "RESUME");
    assert.equal(v2.thrown, null);
    assert.equal(v2.stage, "complete");
    assert.equal(v2.resumed, false);
    assert.equal(v2.recoveryGeneration, v.recoveryGeneration, "no generation bump on terminal short-circuit");
  } finally { fx.cleanup(); }
});

// ── Suite-level attestation: every worker died; no orphans (§1.9). ──────────
test("E1 CROSS-PROCESS SUITE CLEANUP: zero surviving worker processes; worker scripts removed", async () => {
  const attestation = cleanupAttestation(WORKERS.map((w) => w.pid));
  assert.equal(attestation.orphanCount, 0, `survivors: ${JSON.stringify(attestation.survivors)}`);
  for (const w of WORKERS) {
    rmSync(w.path, { force: true });
    assert.equal(existsSync(w.path), false, "worker script removed");
  }
});
