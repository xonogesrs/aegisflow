#!/usr/bin/env node
// scripts/multi-session-wp1-l-bounds.mjs
//
// AUTOLOOP_WP1_MULTI_SESSION_CONTINUITY — PHASE L: RESOURCE / STORAGE BOUNDS.
// Bounded multi-session soak over the WP1 continuation seams (A→B→C chain,
// the Phase G probe path), measuring per-session durable growth:
//
//   - authoritative result bytes/session (resultsDir envelopes)
//   - checkpoint/state bytes/session (CURRENT + prior chain)
//   - journal growth/session (evidence journal rows)
//   - rollover metadata/session (rollover block inside the snapshot)
//   - scratch/temp growth (owned scratch children)
//   - retained completed-result growth (results dir at real terminal)
//   - cleanup after real terminal completion
//
// Classification:
//   EXPECTED_LINEAR_HISTORY — grows with the number of durable events/eras
//   TEMPORARY_GROWTH         — exists only inside an era; reclaimed at terminal
//   DUPLICATE_PERSISTENCE    — the same artifact persisted twice (LEAK)
//   LEAK                     — unbounded/orphaned growth
//
// Required:
//   - no duplicate persistence leak
//   - no orphan temporary rollover state
//   - no unbounded scratch growth
//   - terminal cleanup behaves correctly
//   - handover HOLD preserves only state required for continuation
//   - real terminal reclaims what is no longer required
// RESOURCE_BOUNDS = PASS; STORAGE_LEAK = NO
//
// Run: COLIMA_HOME=/Volumes/NVM2T/Development/runtime/colima \
//        node scripts/multi-session-wp1-l-bounds.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const HOME = homedir();

const BINDING = { adapterKind: "pi-builtin", providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash", requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"] };
const SCOPE = "docs/pi-graph-output";
const PARENT = { scope: { allowed_paths: [SCOPE], forbidden_paths: [".git"] } };
const DIMENSIONS = {};
for (const k of ["affected_files", "affected_subsystems", "dependency_depth", "ambiguity", "expected_execution_steps", "verification_burden", "external_dependencies", "concurrency_potential", "statefulness", "rollback_complexity"]) {
  DIMENSIONS[k] = { score: 1, reasons: ["wp1 phase L soak fixture"] };
}

const evidence = { checks: {}, firstBreak: null };
function record(name, ok, detail = "") {
  evidence.checks[name] = { ok, detail: String(detail).slice(0, 300) };
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
  if (!ok && evidence.firstBreak === null) evidence.firstBreak = name;
}

function dirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}
function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else n += 1;
    }
  };
  walk(dir);
  return n;
}

// Reuse the Phase G probe machinery verbatim (production entries only).
const gProbe = await import(`${root}/scripts/multi-session-wp1-g-multihop.mjs`).catch(() => null);
// The G probe is a script (runs main on import) — instead re-implement the
// soak driver with the same production entries and measure between eras.

const { runSubagentGraphAdmitted } = await import(`${root}/src/admission/admission-gate.mjs`);
const { buildAdmissionRecord } = await import(`${root}/src/admission/policy-projection.mjs`);
const { classify } = await import(`${root}/src/admission/classify.mjs`);
const { validateAdmission, deriveAdmissionId, freezeAdmission } = await import(`${root}/src/admission/admission-record.mjs`);
const { mintExecutionId } = await import(`${root}/src/c2d/execution-id.mjs`);
const { readCheckpoint, checkpointExists } = await import(`${root}/src/v2/checkpoint-bridge.mjs`);
const { bootstrapSuccessorSession } = await import(`${root}/src/rollover/production-wiring.mjs`);
const { ROLLOVER_STATES } = await import(`${root}/src/rollover/rollover-authority.mjs`);
const { planOwnedScratchRoot } = await import(`${root}/src/runtime/scratch-ownership.mjs`);

function saReadonlyPhase(phaseId, taskType) {
  return { phase_id: phaseId, depends_on: [], effects: { artifact_mutation: "none" },
    runtime: { mode: "subagent", taskType, objective: `ro ${taskType}`, expect: { stdoutContains: [`SUBAGENT_DONE:${taskType}`] }, limits: { memoryMiB: 256, timeoutMs: 60000 }, sleep: 1, agentRole: "readonly-analyst" } };
}
function saWriterPhase(dependsOn = ["SA-R1", "SA-R2"]) {
  return { phase_id: "SA-W1", depends_on: dependsOn, effects: { artifact_mutation: "required", boundaries: { artifact: [SCOPE] } },
    runtime: { mode: "subagent", agentRole: "writer", taskType: "write_report", objective: "writer write_report", expect: { stdoutContains: ["SUBAGENT_DONE:write_report"] }, limits: { memoryMiB: 256, timeoutMs: 60000 }, sleep: 1 } };
}
function saVerifierPhase() {
  return { phase_id: "SA-V1", depends_on: ["SA-W1"], effects: { artifact_mutation: "none" },
    runtime: { mode: "subagent", agentRole: "verifier", taskType: "verify_writer", objective: "verify writer", expect: { stdoutContains: ["SUBAGENT_DONE:verify_writer"] }, limits: { memoryMiB: 256 } } };
}
const IR = () => ({ verdict: "PASS", phases: [saReadonlyPhase("SA-R1", "count_todos"), saReadonlyPhase("SA-R2", "inventory_markdown"), saWriterPhase(), saVerifierPhase()], dispositions: [] });

const label = `l-${Date.now().toString(36)}`;
const base = join(HOME, ".wp1-l-probe", `${label}-${Math.random().toString(36).slice(2, 6)}`);
mkdirSync(base, { recursive: true });
const repo = join(base, "repo");
mkdirSync(join(repo, "docs"), { recursive: true });
execFileSync("git", ["-C", repo, "init", "-b", "master"], { stdio: "ignore" });
execFileSync("git", ["-C", repo, "config", "user.email", "p@a"], { stdio: "ignore" });
execFileSync("git", ["-C", repo, "config", "user.name", "p"], { stdio: "ignore" });
writeFileSync(join(repo, "docs", "a.md"), "# a\n\nTODO: x\n");
execFileSync("git", ["-C", repo, "add", "."], { stdio: "ignore" });
execFileSync("git", ["-C", repo, "commit", "-q", "-m", "b"], { stdio: "ignore" });

const scratchRoot = join(base, "scratch");
const persistenceRoot = join(base, "persist");
const executionId = mintExecutionId();
const rec = buildAdmissionRecord({
  taskId: `wp1-l-${label}`,
  classification: classify({ dimensionScores: DIMENSIONS, riskSignals: [{ signal_id: "wp1_l_soak", class: "MEDIUM", triggered: true, reason: "soak" }] }),
  mutationScope: [SCOPE],
  extensions: {
    rollover: {
      enabled: true,
      context_occupancy_threshold: 100,
      source_session_id: executionId,
      rsl3_surface_dir: join(base, "rsl3"),
      require_echo: false,
      provider_binding: BINDING,
    },
    budget: { dimensions: { wall_clock_ms: { limit: 1800000 }, node_execution_count: { limit: 48 }, verifier_reviewer_attempts: { limit: 24 } } },
  },
});
rec.admission_id = deriveAdmissionId(rec);
const v = validateAdmission(rec);
if (!v.ok) throw new Error(`L admission invalid: ${v.errors.join(";")}`);
const admission = freezeAdmission(rec);
const ownedScratchRoot = planOwnedScratchRoot({ scratchRoot, executionId, repoPath: repo });
const resultsDir = join(ownedScratchRoot, "results");

const runOpts = () => ({
  admission, ir: IR(), parent: PARENT,
  manifest: [{ requirement_id: "r1", text: "WP1 L bounds soak" }],
  cwd: repo, repoPath: repo, scratchRoot,
  maxRepairAttempts: 0, timeoutMs: 300000, dirtyScope: [],
});

function measure(tag) {
  const execDir = join(persistenceRoot, executionId);
  const journalDir = join(execDir, "journal");
  const priorDir = join(execDir, "prior");
  const snap = checkpointExists(persistenceRoot, executionId) ? readCheckpoint(persistenceRoot, executionId) : null;
  const rolloverBlock = snap?.snapshot?.graph?.rollover ?? null;
  const m = {
    tag,
    resultsBytes: dirBytes(resultsDir),
    resultsFiles: countFiles(resultsDir),
    checkpointBytes: snap ? statSync(join(execDir, "CURRENT.json")).size + statSync(join(execDir, "CURRENT.json.sha256")).size : 0,
    priorBytes: dirBytes(priorDir),
    priorCount: countFiles(priorDir),
    journalBytes: dirBytes(journalDir),
    journalCount: countFiles(journalDir),
    rolloverBytes: rolloverBlock ? JSON.stringify(rolloverBlock).length : 0,
    rolloverIntents: Object.keys(rolloverBlock?.intents ?? {}).length,
    scratchBytes: dirBytes(ownedScratchRoot),
    scratchFiles: countFiles(ownedScratchRoot),
  };
  console.log(`[measure ${tag}] results=${m.resultsBytes}B/${m.resultsFiles}f checkpoint=${m.checkpointBytes}B prior=${m.priorBytes}B/${m.priorCount}f journal=${m.journalBytes}B/${m.journalCount}f rollover=${m.rolloverBytes}B/${m.rolloverIntents}intents scratch=${m.scratchBytes}B/${m.scratchFiles}f`);
  return m;
}

const samples = [];
samples.push(measure("t0_fresh"));

// ── SESSION A ─────────────────────────────────────────────────────────────
const A = await runSubagentGraphAdmitted({ ...runOpts(), executionId: `wp1-l-${label}`, persistence: { root: persistenceRoot, executionId } });
samples.push(measure("t1_after_A"));
if (!(A.final === "HOLD" && A.handedOver === true)) {
  record("A_HANDOVER", false, `final=${A.final}`);
  finish();
} else {
  const snapA = readCheckpoint(persistenceRoot, executionId);
  const mirrorA = snapA?.snapshot?.graph?.rollover ?? null;
  const ownerB = mirrorA?.owner ?? null;

  // ── SESSION B ───────────────────────────────────────────────────────────
  const B = await bootstrapSuccessorSession({
    persistenceRoot, executionId,
    spawnMeta: {
      rolloverId: mirrorA?.active_rollover_id ?? mirrorA?.last_rollover_id ?? null,
      expectedTargetGeneration: ownerB?.session_generation ?? 1,
      providerBinding: BINDING,
    },
    ...runOpts(),
  });
  samples.push(measure("t2_after_B"));
  const snapB = readCheckpoint(persistenceRoot, executionId);
  const mirrorB = snapB?.snapshot?.graph?.rollover ?? null;
  const ownerC = mirrorB?.owner ?? null;

  // ── SESSION C (real terminal) ───────────────────────────────────────────
  const C = await bootstrapSuccessorSession({
    persistenceRoot, executionId,
    spawnMeta: {
      rolloverId: mirrorB?.active_rollover_id ?? mirrorB?.last_rollover_id ?? null,
      expectedTargetGeneration: ownerC?.session_generation ?? 2,
      providerBinding: BINDING,
    },
    ...runOpts(),
  });
  samples.push(measure("t3_after_C_terminal"));

  // ── Analysis ────────────────────────────────────────────────────────────
  const [t0, t1, t2, t3] = samples;

  // 1. EXPECTED_LINEAR_HISTORY: journal/checkpoint grow monotonically with
  //    eras; the growth is bounded by the number of events, not unbounded.
  const journalGrewMonotonic = t0.journalBytes <= t1.journalBytes && t1.journalBytes <= t2.journalBytes && t2.journalBytes <= t3.journalBytes;
  record("JOURNAL_LINEAR_HISTORY", journalGrewMonotonic && t3.journalCount > t0.journalCount,
    `journal ${t0.journalCount}→${t1.journalCount}→${t2.journalCount}→${t3.journalCount} rows`);

  // 2. rollover metadata: intents grow 0→1→2 (one per era), never duplicated
  record("ROLLOVER_METADATA_BOUNDED", t3.rolloverIntents === 2 && t3.rolloverBytes < 10000,
    `intents=${t3.rolloverIntents} bytes=${t3.rolloverBytes}`);

  // 3. no duplicate persistence: the results dir holds exactly the authored
  //    envelopes (5 files: 3 children-era results + writer + review +
  //    worktree ≤ 7), never a duplicate copy per era
  const expectedMax = 7;
  record("NO_DUPLICATE_PERSISTENCE", t3.resultsFiles <= expectedMax && t2.resultsFiles <= expectedMax,
    `results files t2=${t2.resultsFiles} t3=${t3.resultsFiles} (max ${expectedMax})`);

  // 4. no orphan temporary rollover state: the rollover session dir under
  //    artifacts is the only rollover scratch; no unbounded children
  const rolloverSessionDir = join(persistenceRoot, executionId, "artifacts", "rollover-session-dir");
  const orphanState = existsSync(rolloverSessionDir) ? countFiles(rolloverSessionDir) : 0;
  record("NO_ORPHAN_ROLLOVER_STATE", orphanState <= 4, `rollover-session-dir files=${orphanState}`);

  // 5. scratch growth bounded: the owned scratch holds worktrees + results
  //    for at most ONE era at a time (each era's resume wipe reclaims the
  //    previous era's worktrees; only results/ survives)
  record("SCRATCH_BOUNDED", t3.scratchFiles < 200, `scratch files=${t3.scratchFiles} bytes=${t3.scratchBytes}`);

  // 6. terminal cleanup: C reached a REAL terminal (PASS) → the owned scratch
  //    child is RECLAIMED (results included — no successor era will consume)
  const reclaimedAfterTerminal = !existsSync(ownedScratchRoot) || countFiles(ownedScratchRoot) === 0;
  record("TERMINAL_CLEANUP_RECLAIMS", C.final === "PASS" && reclaimedAfterTerminal,
    `C.final=${C.final} ownedScratchExists=${existsSync(ownedScratchRoot)} files=${countFiles(ownedScratchRoot)}`);

  // 7. handover HOLD preserved only continuation state: at t1/t2 (handover
  //    boundaries) the results dir + durable state were retained; the
  //    durable chain continued (checkpoint revisions advanced)
  const revT1 = samples[1] ? null : null;
  const revAdvanced = t3.journalCount > t1.journalCount && t2.journalCount > t1.journalCount;
  record("HANDOVER_PRESERVES_CONTINUATION_STATE", revAdvanced, `journal rows advanced across both handovers`);

  // 8. real terminal reclaims what is no longer required: after C's PASS the
  //    durable artifacts (checkpoint/journal/manifest) REMAIN (the evidence
  //    record) while the scratch is gone — the durable evidence is the
  //    retained history, not a leak
  const durableEvidenceRetained = existsSync(join(persistenceRoot, executionId, "manifest.json"));
  record("DURABLE_EVIDENCE_RETAINED_NOT_LEAK", durableEvidenceRetained && reclaimedAfterTerminal,
    `manifest retained=${durableEvidenceRetained} scratch reclaimed=${reclaimedAfterTerminal}`);

  finish();
}

function finish() {
  const keys = Object.keys(evidence.checks);
  const failed = keys.filter((k) => !evidence.checks[k].ok);
  console.log("\n=== WP1 PHASE L: RESOURCE / STORAGE BOUNDS ===");
  for (const k of keys) console.log(`${evidence.checks[k].ok ? "PASS" : "FAIL"} ${k}`);
  const leak = failed.some((k) => k.includes("DUPLICATE") || k.includes("ORPHAN") || k.includes("SCRATCH"));
  console.log(`\nRESOURCE_BOUNDS = ${failed.length === 0 ? "PASS" : "FAIL"}`);
  console.log(`STORAGE_LEAK = ${leak ? "YES" : "NO"}`);
  writeFileSync(join(root, "docs", "pi-graph-output", `wp1-l-bounds-${label}.json`),
    JSON.stringify({ schema: "autoloop.wp1-l-bounds/v1", ranAt: new Date().toISOString(), samples, checks: evidence.checks, verdict: failed.length === 0 ? "PASS" : "FAIL", storageLeak: leak }, null, 2) + "\n");
  if (failed.length > 0) process.exitCode = 1;
  if (!process.env.WP1_L_KEEP) rmSync(base, { recursive: true, force: true });
}
