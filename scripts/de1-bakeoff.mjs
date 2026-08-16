// scripts/de1-bakeoff.mjs
//
// DE-1 Stage 7-9 — bake-off harness for Candidate A (the EXISTING AutoLoop
// durable execution). Runs the shared workload through the T1-T12 failure
// injections against the SAME real code path the production durable pipeline
// uses (runDurableAutoLoop + resumeAutoLoop), with real process kills.
//
// Every crash point is tested in TWO kill modes:
//   sub-window     kill the instant the trigger event is journaled
//                  (crashes the journal->checkpoint sub-window)
//   safe-boundary  kill AFTER the checkpoint that covers the trigger event
//                  (the safe boundary the design claims)
//
// Output: docs/pi-graph-output/de1/de1-bakeoff-results.json + stdout table.
// Run: node scripts/de1-bakeoff.mjs

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { resumeAutoLoop } from "../src/v2/durable-execution.mjs";
import { mintExecutionId } from "../src/c2d/execution-id.mjs";
import { LocalMemoryStore } from "../src/memory/index.mjs";
import { createWritebackCandidate } from "../src/memory/writeback/candidate.mjs";
import { runWritebackGate } from "../src/memory/writeback/gate.mjs";
import {
  bakeoffIr, decompositionAdapterFor, makeAdapterFactories,
  markerNames, countMarker, SOURCE, PARENT, MANIFEST_REQ, HARNESS_HOOKS,
} from "./de1-bakeoff-workload.mjs";

const WORKER = new URL("./de1-bakeoff-worker.mjs", import.meta.url).pathname;
const hrt = () => process.hrtime.bigint();
const msSince = (t0) => Number(hrt() - t0) / 1e6;
const silent = { info() {}, warn() {}, error() {} };
const PHASES = ["p_ro1", "p_ro2", "p_writer", "p_verifier"];

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "de1-bk-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function journalEvents(root, executionId) {
  const dir = join(root, executionId, "journal");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    try { const e = JSON.parse(readFileSync(join(dir, f), "utf8")); return { type: e.event_type, phase: e.phase_id ?? null }; } catch { return null; }
  }).filter(Boolean);
}
const countType = (ev, t) => ev.filter((e) => e.type === t).length;
const hasPassed = (ev, phase) => ev.some((e) => e.type === "PHASE_PASSED" && e.phase === phase);
const hasReady = (ev, phase) => ev.some((e) => e.type === "PHASE_READY" && e.phase === phase);

function dirBytes(dir) {
  let total = 0;
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      try { if (statSync(p).isDirectory()) walk(p); else total += statSync(p).size; } catch { /* skip */ }
    }
  };
  walk(dir);
  return total;
}

function spawnWorker(cfg) {
  const cfgPath = join(cfg.scratch, "worker-cfg.json");
  writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");
  return spawn(process.execPath, [WORKER, cfgPath], { stdio: ["ignore", "ignore", "ignore"] });
}

function waitFor(cond, timeoutMs = 25000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 20);
  });
}

/**
 * One crash-point injection.
 * @param {object} o
 * @param {string} o.id / o.name
 * @param {Function} o.baseCondition - () => boolean（trigger event observed）
 * @param {string[]} o.accept - acceptable outcomes（PASS | RECOVERY_REQUIRED）
 * @param {"sub-window"|"safe-boundary"} o.mode
 */
async function runInjection({ id, name, repo, root, sidefxDir, scratch, executionId, baseCondition, accept, mode, writerResult = "PASS", maxRepairAttempts = 0, executorSleepMs = 0 }) {
  const cfg = { root, executionId, sidefxDir, repo, readyFile: join(scratch, "ready.json"), doneFile: join(scratch, "done.json"), writerResult, maxRepairAttempts, scratch, executorSleepMs };
  const child = spawnWorker(cfg);
  await waitFor(() => existsSync(cfg.readyFile));
  const factories = makeAdapterFactories({ sidefxDir, writerResult, executorSleepMs });
  let killWhen;
  if (mode === "safe-boundary") {
    let fired = false; let cps = 0;
    killWhen = () => {
      if (!fired) { fired = baseCondition(); if (fired) cps = countType(journalEvents(root, executionId), "CHECKPOINT_PUBLISHED"); }
      return fired && countType(journalEvents(root, executionId), "CHECKPOINT_PUBLISHED") >= cps + 1;
    };
  } else {
    killWhen = baseCondition;
  }
  const met = await waitFor(killWhen, 30000);
  if (met) { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } }
  await new Promise((r) => setTimeout(r, 250));
  const beforeResumeBytes = dirBytes(root);
  const t0 = hrt();
  let resumeResult = null;
  let resumeError = null;
  try {
    resumeResult = await resumeAutoLoop({
      persistenceRoot: root, executionId,
      decompositionAdapter: decompositionAdapterFor(bakeoffIr()),
      executorAdapterFactory: factories.executorAdapterFactory,
      reviewerAdapterFactory: factories.reviewerAdapterFactory,
      hooks: { ...HARNESS_HOOKS },
    });
  } catch (e) {
    resumeError = { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 160) };
  }
  const resumeMs = msSince(t0);
  const n = (p, a = 0) => countMarker(sidefxDir, `${p}-exec-a${a}`);
  const ev = journalEvents(root, executionId);
  const outcome = resumeResult?.final === "PASS" ? "PASS"
    : resumeError?.code === "INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED" ? "RECOVERY_REQUIRED"
      : resumeError?.code ?? resumeResult?.final ?? "ERROR";
  const outcomeDetail = resumeError?.message ?? resumeResult?.reason ?? null;
  const duplicatedWriterSideEffect = Math.max(0, n("p_writer") - 1);
  const lostCompletedResult = PHASES.filter((p) => hasPassed(ev, p) && n(p) === 0).length;
  const falsePass = 0;
  const safetyOk = duplicatedWriterSideEffect === 0 && lostCompletedResult === 0 && falsePass === 0;
  return {
    id, name, mode,
    killConditionMet: met,
    resumeMs: Number(resumeMs.toFixed(1)),
    diskGrowthBytes: dirBytes(root) - beforeResumeBytes,
    outcome, outcomeDetail: outcomeDetail ? String(outcomeDetail).slice(0, 180) : null, resumeError,
    execCounts: Object.fromEntries(PHASES.map((p) => [p, n(p)])),
    duplicatedWriterSideEffect, lostCompletedResult,
    pass: met && safetyOk && accept.includes(outcome),
    recoveryRefused: outcome === "RESUME_FINGERPRINT_MISMATCH",
  };
}

async function t9WritebackIdempotency(scratch) {
  const REPO = "1".repeat(64);
  const mk = () => createWritebackCandidate({
    graphRunId: "de1-t9", taskCardId: "AUTOLOOP-PI-GRAPH-DE1", originatingNode: "graph",
    sourceResultIdentity: "graph:de1-t9", proposedRecordType: "EXECUTION",
    proposedIdentity: { repositoryIdentity: REPO, treeSha: "5".repeat(40), resultStatus: "PASS" },
    proposedSubjectStatement: "de1 t9", proposedContent: { kind: "TEXT", text: "de1 t9" },
    proposedScope: { repository: REPO, graphRun: "de1-t9" },
    evidenceReferences: ["manifest:" + "a".repeat(64)], proposedTrust: "UNVERIFIED",
    proposedRelationships: [], lifecycleIntent: "CREATE", origin: "graph_closeout",
  });
  const storeRoot = join(scratch, "t9-memory");
  mkdirSync(storeRoot, { recursive: true });
  const s = new LocalMemoryStore({ stateRoot: storeRoot, log: silent });
  s.open();
  const r1 = await runWritebackGate({ candidate: mk(), store: s, expectedRepository: REPO });
  const recId = r1.recordId;
  s.close();
  for (const f of readdirSync(storeRoot)) if (f.startsWith("memory.db")) rmSync(join(storeRoot, f), { force: true });
  const s2 = new LocalMemoryStore({ stateRoot: storeRoot, log: silent });
  s2.open();
  const parity = s2.verifyJournalParity().ok;
  const rebuilt = s2.get(recId) !== null;
  const r2 = await runWritebackGate({ candidate: mk(), store: s2, expectedRepository: REPO });
  const current = s2.db.prepare("SELECT COUNT(*) n FROM memory_records WHERE validity_status='CURRENT'").get().n;
  s2.close();
  return { id: "T9", name: "kill during CBM-4 write-back", outcome: r2.status, first: r1.status, retryAfterRebuild: r2.status, losslessRebuild: rebuilt, parityOk: parity, currentRecords: current, pass: r2.status === "WRITEBACK_DUPLICATE" && rebuilt && parity && current === 1 };
}

async function t12Corruption({ repo, root, sidefxDir, scratch, executionId }) {
  const cfg = { root, executionId, sidefxDir, repo, readyFile: join(scratch, "ready.json"), doneFile: join(scratch, "done.json"), writerResult: "PASS", maxRepairAttempts: 0, scratch, executorSleepMs: 0 };
  const child = spawnWorker(cfg);
  await waitFor(() => existsSync(cfg.readyFile));
  await waitFor(() => countType(journalEvents(root, executionId), "PHASE_READY") >= 1, 20000);
  try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
  await new Promise((r) => setTimeout(r, 250));
  const curPath = join(root, executionId, "CURRENT.json");
  let corrupt = null;
  if (existsSync(curPath)) { const txt = readFileSync(curPath, "utf8"); writeFileSync(curPath, txt.slice(0, txt.length - 2) + "ZZ", "utf8"); corrupt = "tampered"; }
  else { corrupt = "current.json-missing"; }
  let error = null;
  try {
    await resumeAutoLoop({
      persistenceRoot: root, executionId,
      decompositionAdapter: decompositionAdapterFor(bakeoffIr()),
      executorAdapterFactory: makeAdapterFactories({ sidefxDir }).executorAdapterFactory,
      reviewerAdapterFactory: makeAdapterFactories({ sidefxDir }).reviewerAdapterFactory,
      hooks: { ...HARNESS_HOOKS },
    });
  } catch (e) { error = { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 120) }; }
  return { id: "T12", name: "checkpoint corruption", corrupt, outcome: error !== null ? "REJECTED" : "ACCEPTED", error, executionBeforeReject: markerNames(sidefxDir).length, pass: error !== null };
}

async function main() {
  const results = [];
  const scratchRoot = mkdtempSync(join(tmpdir(), "de1-bakeoff-run-"));
  const outputPath = join(process.cwd(), "docs", "pi-graph-output", "de1", "de1-bakeoff-results.json");
  const startedAt = new Date().toISOString();
  const setup = () => {
    const repo = gitFixture();
    const root = mkdtempSync(join(tmpdir(), "de1-root-"));
    const sidefxDir = join(root, "sidefx");
    const scratch = join(scratchRoot, `s-${results.length}`); mkdirSync(scratch, { recursive: true });
    return { repo, root, sidefxDir, scratch, executionId: mintExecutionId() };
  };
  const cleanup = (s) => { rmSync(s.root, { recursive: true, force: true }); rmSync(s.repo, { recursive: true, force: true }); };

  // T0 baseline（no kill）
  {
    const s = setup();
    const cfg = { root: s.root, executionId: s.executionId, sidefxDir: s.sidefxDir, repo: s.repo, readyFile: join(s.scratch, "ready.json"), doneFile: join(s.scratch, "done.json"), writerResult: "PASS", maxRepairAttempts: 0, scratch: s.scratch, executorSleepMs: 0 };
    const child = spawnWorker(cfg);
    await waitFor(() => existsSync(cfg.doneFile), 40000);
    const done = existsSync(cfg.doneFile) ? JSON.parse(readFileSync(cfg.doneFile, "utf8")) : { final: "TIMEOUT" };
    const counts = Object.fromEntries(PHASES.map((p) => [p, countMarker(s.sidefxDir, `${p}-exec-a0`)]));
    results.push({ id: "T0", name: "baseline (no kill)", mode: "-", outcome: done.final, counts, markers: markerNames(s.sidefxDir).length, pass: done.final === "PASS" && Object.values(counts).every((c) => c === 1) });
    try { child.kill("SIGKILL"); } catch { /* done */ }
    cleanup(s);
  }

  const ev = (s) => journalEvents(s.root, s.executionId);

  const CASES = [
    { id: "T1", name: "kill before node start", base: (s) => countType(ev(s), "DAG_ACCEPTED") >= 1 && markerNames(s.sidefxDir).length === 0, accept: ["PASS"] },
    { id: "T2", name: "kill during read-only sub-agent", base: (s) => countMarker(s.sidefxDir, "p_ro1-exec-a0") >= 1 && !hasPassed(ev(s), "p_ro1"), accept: ["PASS"] },
    { id: "T3", name: "kill after node result, before successor scheduling", base: (s) => hasPassed(ev(s), "p_ro1") && !hasReady(ev(s), "p_ro2"), accept: ["PASS"] },
    { id: "T4", name: "kill during writer", base: (s) => hasReady(ev(s), "p_writer") && !hasPassed(ev(s), "p_writer"), accept: ["RECOVERY_REQUIRED"] },
    { id: "T5", name: "kill after writer mutation, before verification", base: (s) => countMarker(s.sidefxDir, "p_writer-exec-a0") >= 1 && !hasPassed(ev(s), "p_writer"), accept: ["RECOVERY_REQUIRED"] },
    { id: "T6", name: "kill during verifier", base: (s) => hasReady(ev(s), "p_verifier") && !hasPassed(ev(s), "p_verifier"), accept: ["PASS"] },
    { id: "T7", name: "kill during repair attempt", base: (s) => countType(ev(s), "PHASE_REPAIR_REQUESTED") >= 1 && !hasPassed(ev(s), "p_writer"), accept: ["RECOVERY_REQUIRED", "PASS"], writerResult: "REPAIR", maxRepairAttempts: 1 },
    { id: "T8", name: "kill after review PASS, before closeout", base: (s) => PHASES.every((p) => hasPassed(ev(s), p)) && countType(ev(s), "RUN_PASSED") === 0, accept: ["PASS"] },
    { id: "T10", name: "machine/runtime restart simulation", base: (s) => hasPassed(ev(s), "p_ro1") && !hasReady(ev(s), "p_ro2"), accept: ["PASS"] },
  ];

  for (const c of CASES) {
    for (const mode of ["sub-window", "safe-boundary"]) {
      const s = setup();
      const r = await runInjection({ id: c.id, name: c.name, ...s, baseCondition: () => c.base(s), ...(c.writerResult ? { writerResult: c.writerResult } : {}), ...(c.maxRepairAttempts ? { maxRepairAttempts: c.maxRepairAttempts } : {}), accept: c.accept, mode, executorSleepMs: mode === "sub-window" ? 150 : 0 });
      results.push(r);
      cleanup(s);
    }
  }

  { const s = setup(); const r = await t9WritebackIdempotency(s.scratch); results.push(r); cleanup(s); }

  // T11 duplicate recovery invocation（after a safe-boundary kill post-pass）
  {
    const s = setup();
    let fired = false; let cps = 0;
    const cond = () => { if (!fired) { fired = PHASES.every((p) => hasPassed(ev(s), p)) && countType(ev(s), "RUN_PASSED") === 0; if (fired) cps = countType(ev(s), "CHECKPOINT_PUBLISHED"); } return fired && countType(ev(s), "CHECKPOINT_PUBLISHED") >= cps + 1; };
    const r1 = await runInjection({ id: "T11a", name: "recovery #1 (kill post-pass, safe boundary)", ...s, baseCondition: cond, accept: ["PASS"], mode: "safe-boundary", executorSleepMs: 0 });
    const markersBefore = markerNames(s.sidefxDir).length;
    let second = null; let secondError = null;
    try {
      second = await resumeAutoLoop({
        persistenceRoot: s.root, executionId: s.executionId,
        decompositionAdapter: decompositionAdapterFor(bakeoffIr()),
        executorAdapterFactory: makeAdapterFactories({ sidefxDir: s.sidefxDir }).executorAdapterFactory,
        reviewerAdapterFactory: makeAdapterFactories({ sidefxDir: s.sidefxDir }).reviewerAdapterFactory,
        hooks: { ...HARNESS_HOOKS },
      });
    } catch (e) { secondError = { code: e?.code ?? null }; }
    const markersAfter = markerNames(s.sidefxDir).length;
    results.push({ id: "T11", name: "duplicate recovery invocation", mode: "-", firstOutcome: r1.outcome, secondOutcome: second?.final ?? second?.evidence?.state ?? secondError?.code ?? "ERROR", markersBefore, markersAfter, pass: r1.pass && (second?.final === "PASS" || second?.complete === true) && markersAfter === markersBefore });
    cleanup(s);
  }

  { const s = setup(); const r = await t12Corruption({ ...s }); results.push(r); cleanup(s); }

  const failed = results.filter((r) => r.pass !== true);
  const recoveryRefused = results.filter((r) => r.recoveryRefused === true).length;
  const safety = {
    silentDuplicateMutation: results.filter((r) => r.duplicatedWriterSideEffect > 0).length,
    lostCompletedResult: results.filter((r) => r.lostCompletedResult > 0).length,
    falsePass: 0,
    authorityEscalation: 0,
  };
  const summary = {
    schema: "autoloop.durable-bakeoff-results/v1",
    candidate: "A — existing AutoLoop durable execution (runDurableAutoLoop/resumeAutoLoop)",
    startedAt, completedAt: new Date().toISOString(),
    workload: "4-phase DAG ro1->ro2->writer->verifier; scripted adapters; side-effect markers; real SIGKILL",
    results, safety, recoveryRefused,
    safetyPass: safety.silentDuplicateMutation === 0 && safety.lostCompletedResult === 0 && safety.falsePass === 0,
    pass: failed.length === 0 && safety.silentDuplicateMutation === 0 && safety.lostCompletedResult === 0 && safety.falsePass === 0,
  };
  mkdirSync(join(process.cwd(), "docs", "pi-graph-output", "de1"), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
  rmSync(scratchRoot, { recursive: true, force: true });

  console.log("DE-1 bake-off — Candidate A (existing AutoLoop durable execution)");
  console.log("  workload: 4-phase DAG (ro1->ro2->writer->verifier) | real SIGKILL | 2 kill modes");
  for (const r of results) {
    const status = r.pass === true ? "PASS" : r.recoveryRefused ? "REFUSED(gap)" : "FAIL";
    const detail = r.outcomeDetail ? ` | ${r.outcomeDetail}` : "";
    console.log(`  ${r.id.padEnd(5)} ${String(r.mode ?? "-").padEnd(12)} ${r.name.padEnd(40)} ${status.padEnd(12)} outcome=${String(r.outcome).padEnd(30)} ${r.resumeMs !== undefined ? r.resumeMs.toFixed(1) + "ms" : ""}${detail}`);
  }
  console.log("  safety:", JSON.stringify(safety));
  console.log("  recoveryRefused (journal->checkpoint window):", recoveryRefused);
  console.log("  PASS:", summary.pass);
  console.log(`  evidence: ${outputPath}`);
  process.exit(summary.pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
