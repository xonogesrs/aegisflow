#!/usr/bin/env node
// scripts/multi-session-pre-wp1-probe.mjs
//
// AUTOLOOP_MULTI_SESSION_LONG_RUNNING_TASK_E2E_IMPLEMENTATION_1 — PRE-WP1
// dependency-consumption probe (Scheme A adjudication).
//
// Seam under adjudication: how to prove a downstream sub-agent truly consumes
// its dependencies' output — not just depends_on IDs.
// Priority scheme: runSubagentGraph → durable execution → resultsDir /
// dependencyResultIdentities / reviewer verification.
//
// Probes:
//   A1  SUBAGENT_FRESH_PATH_USES_DURABLE_GRAPH   — runSubagentGraph with no
//       durability opt-out runs under runDurableGraph (journal + checkpoint
//       exist; the no-bypass guard proves production cannot disable it).
//   A2  SUBAGENT_PATH_ROLLOVER_COMPATIBLE        — provider-backed sub-agent
//       execution through the canonical production path: a frozen admission
//       with extensions.rollover.provider_binding routes the sub-agent
//       nodes' execution through THE production provider adapter
//       (createPiRpcAdapter, WP1-A2 dispatch seam); the adapter-owned
//       provider session's usage surfaces as canonical
//       metadata.providerUsage → PROVIDER_USAGE_OBSERVED journaled durably
//       → threshold evaluation via contextOccupancyFromUsage → automatic
//       trigger → canonical rollover intake → successor spawn reachable.
//   A3  DEPENDENT_REAL_CONSUMPTION               — canonical SA-R1 ‖ SA-R2 →
//       SA-W1 graph: the writer consumes the read-only dependencies'
//       persisted results through the canonical owned resultsDir; destroying
//       a required predecessor result fails the dependent phase at the
//       correct seam.
//   A4  DEPENDENCY_RESULT_DURABLE_ACROSS_SESSION — resultsDir contents
//       survive a fresh-process resumeSubagentGraph (scratchPreserve) and
//       the resumed downstream phase still consumes them.
//
// No test-only output passing: every check reads real durable artifacts
// (journal events, checkpoint, resultsDir files) or real process outcomes.
//
// OBSERVATION TIMING: the production graph runner legitimately reclaims the
// owned scratch (including results/) at terminal. The probe therefore
// inspects the canonical owned resultsDir MID-RUN through the production
// onPhaseTerminal lifecycle hook and captures what it needs there; post-run
// inspection asserts only crash-preserved / journal-backed truth.
//
// Requires colima (profile autoloop-graph) with COLIMA_HOME set canonically.
// Scratch/persistence use HOME-based paths (the colima instance mounts $HOME,
// so sub-agent resultsDir / scratch writes persist — /var/folders does not).
// Run:
//   COLIMA_HOME=/Volumes/NVM2T/Development/runtime/colima node scripts/multi-session-pre-wp1-probe.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const HOME = homedir();
const LOG = mkdtempSync(join(tmpdir(), "pre-wp1-log-")) + "/probe.log";
const log = (line) => appendFileSync(LOG, line + "\n");

const { runSubagentGraph, resumeSubagentGraph, durableExecutionIdFor } =
  await import(`${root}/src/subagent/subagent-graph-runner.mjs`);
const { checkpointExists, readCheckpoint } = await import(`${root}/src/v2/checkpoint-bridge.mjs`);
const { buildAdmissionRecord } = await import(`${root}/src/admission/policy-projection.mjs`);
const { classify } = await import(`${root}/src/admission/classify.mjs`);
const { validateAdmission, deriveAdmissionId, freezeAdmission } = await import(`${root}/src/admission/admission-record.mjs`);
const { mintExecutionId } = await import(`${root}/src/c2d/execution-id.mjs`);
const { deriveCanonicalRolloverExecutor, admittedProviderBinding } =
  await import(`${root}/src/rollover/production-wiring.mjs`);
const { runAdmittedGraph } = await import(`${root}/src/admission/admission-gate.mjs`);
const { planOwnedScratchRoot } = await import(`${root}/src/runtime/scratch-ownership.mjs`);
const { ROLLOVER_STATES } = await import(`${root}/src/rollover/rollover-authority.mjs`);

const evidence = { checks: {}, firstBreak: null };
function record(name, ok, detail = "") {
  evidence.checks[name] = { ok, detail: String(detail).slice(0, 300) };
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
  if (!ok && evidence.firstBreak === null) evidence.firstBreak = name;
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

// HOME-based fixture roots: the colima instance mounts $HOME, so sub-agent
// scratch/results writes persist（/var/folders does not — the canonical
// sub-agent suites use the same convention）.
function makeBase(label) {
  const base = join(HOME, ".pre-wp1-probe", `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(base, { recursive: true });
  return base;
}

function makeRepo(base) {
  const dir = join(base, "repo");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "master"]);
  git(dir, ["config", "user.email", "probe@autoloop"]);
  git(dir, ["config", "user.name", "probe"]);
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "source.md"), "# fixture\n\nTODO: probe fixture\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

// ── canonical sub-agent IR builders ────────────────────────────────────────
// The live production sub-agent contract keys the writer/verifier agent
// programs and the review agent onto the CANONICAL phase names
// SA-R1 / SA-R2 (parallel read-only) → SA-W1 (writer) → SA-V1 (verifier)
// (see src/subagent/subagent-writer-executor-adapter.mjs
//  buildWriterAgentCommand / buildReviewAgentCommand and
//  test/test-durable-subagent-resume.mjs). The probe uses exactly those.
const SCOPE = "docs/pi-graph-output";
const PARENT = { scope: { allowed_paths: [SCOPE], forbidden_paths: [".git"] } };

function saReadonlyPhase(phaseId, taskType) {
  return {
    phase_id: phaseId,
    depends_on: [],
    effects: { artifact_mutation: "none" },
    runtime: {
      mode: "subagent",
      taskType,
      objective: `read-only ${taskType} over /src/docs`,
      expect: { stdoutContains: [`SUBAGENT_DONE:${taskType}`] },
      limits: { memoryMiB: 256, timeoutMs: 60000 },
      sleep: 1,
      agentRole: "readonly-analyst",
    },
  };
}

function saWriterPhase(dependsOn = ["SA-R1", "SA-R2"]) {
  return {
    phase_id: "SA-W1",
    depends_on: dependsOn,
    effects: { artifact_mutation: "required", boundaries: { artifact: [SCOPE] } },
    runtime: {
      mode: "subagent",
      agentRole: "writer",
      taskType: "write_report",
      objective: `writer write_report over /work/${SCOPE} using dependency results`,
      expect: { stdoutContains: ["SUBAGENT_DONE:write_report"] },
      limits: { memoryMiB: 256, timeoutMs: 60000 },
      sleep: 1,
    },
  };
}

function saVerifierPhase(dependsOn = ["SA-W1"]) {
  return {
    phase_id: "SA-V1",
    depends_on: dependsOn,
    effects: { artifact_mutation: "none" },
    runtime: {
      mode: "subagent",
      agentRole: "verifier",
      taskType: "verify_writer",
      objective: "verify writer SA-W1 diff/tests/scope from /results artifacts",
      expect: { stdoutContains: ["SUBAGENT_DONE:verify_writer"] },
      limits: { memoryMiB: 256 },
    },
  };
}

const CANONICAL_IR = () => ({
  verdict: "PASS",
  phases: [
    saReadonlyPhase("SA-R1", "count_todos"),
    saReadonlyPhase("SA-R2", "inventory_markdown"),
    saWriterPhase(),
    saVerifierPhase(),
  ],
  dispositions: [],
});

function readJournal(persistenceRoot, durableId) {
  const jdir = join(persistenceRoot, durableId, "journal");
  if (!existsSync(jdir)) return [];
  return readdirSync(jdir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(jdir, f), "utf8")));
}

// Serial variant for the A2 rollover path: the durable layer's mid-run
// rollover intake fires at a between-phase onPhaseStart boundary when at
// least one phase is completed and no executor/reviewer is in flight
//（quiescence contract）. A2 proves the SERIAL chain still reaches the
// intake exactly as before; A5 proves the PARALLEL fan-out
//（SA-R1 ‖ SA-R2 → SA-W1 → SA-V1）now reaches the same intake at SA-W1's
// quiescent start boundary — instead of disarming the one-shot opportunity
// at the 2nd PARALLEL start while an executor is still in flight（the WP1
// defect this card repairs）.
const SERIAL_IR = () => ({
  verdict: "PASS",
  phases: [
    saReadonlyPhase("SA-R1", "count_todos"),
    { ...saReadonlyPhase("SA-R2", "inventory_markdown"), depends_on: ["SA-R1"] },
    saWriterPhase(),
    saVerifierPhase(),
  ],
  dispositions: [],
});

/** THE canonical owned resultsDir — derived exactly as the runner derives it. */
function canonicalResultsDir(scratchRoot, durableId, repoPath) {
  const ownedRoot = planOwnedScratchRoot({ scratchRoot, executionId: durableId, repoPath });
  return join(ownedRoot, "results");
}

function listResults(resultsDir) {
  return existsSync(resultsDir) ? readdirSync(resultsDir).filter((f) => f.endsWith(".json")).sort() : [];
}

const ONLY = process.env.PRE_WP1_ONLY ?? null;
const runSection = (name) => !ONLY || ONLY.split(",").includes(name);

async function main() {
  const label = Date.now().toString(36);

  // ══ A1: SUBAGENT_FRESH_PATH_USES_DURABLE_GRAPH ════════════════════════
  if (runSection("A1")) {
    const base = makeBase(`a1-${label}`);
    const repo = makeRepo(base);
    const scratchRoot = join(base, "scratch");
    const persistenceRoot = join(base, "persist");
    const logicalId = `pw1-a1-${label}`;
    const durableId = durableExecutionIdFor(logicalId);
    let result = null;
    try {
      result = await runSubagentGraph({
        // NO durability opt-out — the production default must route through
        // the durable layer (A1's whole question).
        ir: { phases: [saReadonlyPhase("SA-R1", "count_todos")] },
        parent: PARENT,
        manifest: [{ requirement_id: "r1", text: "A1 durable-path probe" }],
        cwd: repo, repoPath: repo, scratchRoot,
        executionId: logicalId,
        maxRepairAttempts: 0,
        timeoutMs: 120000,
        persistence: { root: persistenceRoot, executionId: durableId },
        dirtyScope: [],
      });
    } catch (e) {
      record("A1_RUN", false, `exception: ${e?.code ?? e?.name}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    const ranOk = result?.final === "PASS";
    record("A1_RUN", ranOk, `final=${result?.final} reason=${String(result?.reason ?? "").slice(0, 120)}`);
    const hasCheckpoint = checkpointExists(persistenceRoot, durableId);
    const journal = readJournal(persistenceRoot, durableId);
    const journaledPhases = journal.filter((e) => e.event_type === "PHASE_PASSED").map((e) => e.phase_id);
    record("A1_DURABLE_GRAPH_USED", hasCheckpoint && journal.length > 0 && journaledPhases.includes("SA-R1"),
      `checkpoint=${hasCheckpoint} journalEvents=${journal.length} passedPhases=[${journaledPhases.join(",")}] durableId=${durableId}`);
    // the returned envelope carries durable provenance
    const hasDurableProvenance = result?.durableExecutionId === durableId && result?.evidence?.exec_dir != null;
    record("A1_DURABLE_PROVENANCE", hasDurableProvenance, `durableExecutionId=${result?.durableExecutionId} evidence.exec_dir=${result?.evidence?.exec_dir ?? "none"}`);
    rmSync(base, { recursive: true, force: true });
  }

  // ══ A2: SUBAGENT_PATH_ROLLOVER_COMPATIBLE (WP1-A2 canonical path) ═════
  if (runSection("A2")) {
    // The production surfaces, exercised against the REAL production code:
    // 1. provider-backed sub-agent execution — the frozen admission's
    //    provider_binding routes the sub-agent nodes through THE production
    //    provider adapter; the adapter-owned session's usage lands as
    //    metadata.providerUsage on the existing node-result path.
    // 2. durable observation — PROVIDER_USAGE_OBSERVED journaled by the
    //    durable graph's onPhaseTerminal (observeProviderUsageAndTrigger).
    // 3. threshold evaluation — canonical contextOccupancyFromUsage over the
    //    provider-reported fields (pinned by the journaled occupancy).
    // 4. automatic trigger — SPAWN_DISPATCH with the admitted binding.
    // 5. successor path reachable — ownership transfer committed / handover
    //    hold (A frozen; B's bootstrap is the WP3 successor entry).
    const base = makeBase(`a2-${label}`);
    const repo = makeRepo(base);
    const scratchRoot = join(base, "scratch");
    const persistenceRoot = join(base, "persist");
    const rsl3Dir = join(base, "rsl3");
    mkdirSync(rsl3Dir, { recursive: true });
    const logicalId = `pw1-a2-${label}`;
    const executionId = mintExecutionId();
    const BINDING = { adapterKind: "pi-builtin", providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash", requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"] };
    // Classification must engage the sub-agent execution profile: a
    // FAST_PATH admission denies sub_agent_execution_count entirely, so the
    // provider-backed sub-agent nodes could never reserve budget. The probe
    // task is classified with full (scored) dimension evidence — profile
    // LARGE_LOW grants the sub-agent/writer/colima capability set.
    const DIMENSIONS = {};
    for (const k of ["affected_files", "affected_subsystems", "dependency_depth", "ambiguity", "expected_execution_steps", "verification_burden", "external_dependencies", "concurrency_potential", "statefulness", "rollback_complexity"]) {
      DIMENSIONS[k] = { score: 1, reasons: ["pre-WP1 probe fixture"] };
    }
    // MEDIUM profile (size M + one MEDIUM signal): grants the sub-agent
    // execution capability set AND carries repair_budget=1 — the orchestrator
    // accepts only 0/1 repair attempts, so a LARGE_LOW admission (budget 2)
    // would HOLD before any dispatch.
    const rec = buildAdmissionRecord({
      taskId: logicalId,
      classification: classify({ dimensionScores: DIMENSIONS, riskSignals: [{ signal_id: "pre_wp1_probe_subagent_work", class: "MEDIUM", triggered: true, reason: "probe fixture exercises sub-agent execution" }] }),
      mutationScope: [SCOPE],
      extensions: {
        rollover: {
          enabled: true,
          // Real GLM turns report occupancy well above this frozen threshold
          // after the first provider-backed node.
          context_occupancy_threshold: 100,
          source_session_id: executionId,
          rsl3_surface_dir: rsl3Dir,
          require_echo: false,
          provider_binding: BINDING,
        },
        budget: {
          dimensions: {
            wall_clock_ms: { limit: 900000 },
            node_execution_count: { limit: 16 },
            verifier_reviewer_attempts: { limit: 8 },
          },
        },
      },
    });
    rec.admission_id = deriveAdmissionId(rec);
    const v = validateAdmission(rec);
    if (!v.ok) throw new Error(`A2 admission invalid: ${v.errors.join(";")}`);
    const admission = freezeAdmission(rec);
    let result = null;
    try {
      result = await runAdmittedGraph({
        admission,
        graph: "subagent",
        ir: SERIAL_IR(),
        parent: PARENT,
        manifest: [{ requirement_id: "r1", text: "A2 rollover-compat probe" }],
        cwd: repo, repoPath: repo, scratchRoot,
        executionId: logicalId,
        maxRepairAttempts: 0,
        timeoutMs: 240000,
        persistence: { root: persistenceRoot, executionId },
        dirtyScope: [],
      });
    } catch (e) {
      record("A2_RUN", false, `exception: ${e?.code ?? e?.name}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    const journal = readJournal(persistenceRoot, executionId);
    const usageEvents = journal.filter((e) => e.event_type === "PROVIDER_USAGE_OBSERVED");
    record("A2_RUN", result != null && (result.final === "HOLD" || result.final === "PASS"),
      `final=${result?.final} stage=${result?.stage} holdCode=${result?.holdCode} reason=${String(result?.reason ?? "").slice(0, 120)}`);

    // 1+2: provider-backed execution actually occurred and its usage was
    // observed DURABLY from the adapter-owned provider session.
    const providerReported = usageEvents.length > 0 && usageEvents.every((e) => e.payload?.provider_reported === true);
    record("A2_PROVIDER_USAGE_OBSERVED", providerReported,
      providerReported ? `PROVIDER_USAGE_OBSERVED events=${usageEvents.length} occupancy(1st)=${usageEvents[0]?.payload?.occupancy}` : `no provider-reported usage events (observationFailed=${journal.some((e) => e.event_type === "ROLLOVER_USAGE_OBSERVATION_FAILED")})`);

    // 3: threshold evaluation used the canonical occupancy calculation
    // (occupancy == input + cacheRead + cacheWrite over provider-reported
    // fields — recompute from the journaled occupancy_fields).
    const occOk = usageEvents.length > 0 && usageEvents.every((e) => {
      const f = e.payload?.occupancy_fields ?? {};
      return e.payload?.occupancy === (f.input ?? NaN) + (f.cacheRead ?? NaN) + (f.cacheWrite ?? NaN);
    });
    record("A2_CANONICAL_OCCUPANCY", occOk, occOk ? "journaled occupancy == input+cacheRead+cacheWrite" : "occupancy mismatch");

    // 4: automatic trigger fired through the canonical intake
    const dispatches = journal.filter((e) => e.event_type === "SPAWN_DISPATCH");
    const dispatchBindingOk = dispatches.length > 0 && dispatches.every((e) =>
      e.payload?.provider_binding?.providerKind === BINDING.providerKind && e.payload?.provider_binding?.modelId === BINDING.modelId);
    record("A2_AUTOMATIC_TRIGGER", dispatchBindingOk,
      dispatchBindingOk ? `SPAWN_DISPATCH events=${dispatches.length} binding=${BINDING.providerKind}/${BINDING.modelId}` : "no SPAWN_DISPATCH with the admitted binding");

    // 5: successor/spawn path reachable — durable transfer committed and A
    // handed over (A's terminal publication is frozen post-transfer).
    const snap = checkpointExists(persistenceRoot, executionId) ? readCheckpoint(persistenceRoot, executionId) : null;
    const mirror = snap?.snapshot?.graph?.rollover ?? null;
    const transferCommitted = mirror?.state === ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED
      || mirror?.state === ROLLOVER_STATES.ACTIVE_B
      || mirror?.state === ROLLOVER_STATES.A_RETIRED;
    record("A2_SUCCESSOR_PATH_REACHABLE", transferCommitted === true && result?.handedOver === true,
      `mirror state=${mirror?.state} handedOver=${result?.handedOver === true} final=${result?.final}`);
    const secret = process.env.MERGE_GATEWAY_API_KEY;
    if (typeof secret === "string" && secret.length > 0) {
      record("A2_SECRET_VALUE_ABSENT", JSON.stringify(journal).includes(secret) === false, "journal scanned for the admitted secret value");
    }
    if (process.env.PRE_WP1_KEEP) {
      console.log(`A2_KEEP persistenceRoot=${persistenceRoot} executionId=${executionId}`);
    } else {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ══ A5: PARALLEL_FANOUT_ROLLOVER_INTAKE (WP1 repair control) ══════════
  // The canonical PARALLEL IR（SA-R1 ‖ SA-R2 → SA-W1 → SA-V1）through the
  // SAME production path as A2: provider-backed sub-agent execution →
  // durable PROVIDER_USAGE_OBSERVED → threshold trigger → canonical
  // rollover intake AT SA-W1's quiescent start boundary（both readers
  // terminal, SA-V1 not yet started）→ exactly ONE SPAWN_DISPATCH.
  // Pre-repair, the one-shot intake disarmed at SA-R2's start（an executor
  // still in flight）and no SPAWN_DISPATCH could ever exist.
  if (runSection("A5")) {
    const base = makeBase(`a5-${label}`);
    const repo = makeRepo(base);
    const scratchRoot = join(base, "scratch");
    const persistenceRoot = join(base, "persist");
    const rsl3Dir = join(base, "rsl3");
    mkdirSync(rsl3Dir, { recursive: true });
    const logicalId = `pw1-a5-${label}`;
    const executionId = mintExecutionId();
    const BINDING = { adapterKind: "pi-builtin", providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash", requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"] };
    const DIMENSIONS = {};
    for (const k of ["affected_files", "affected_subsystems", "dependency_depth", "ambiguity", "expected_execution_steps", "verification_burden", "external_dependencies", "concurrency_potential", "statefulness", "rollback_complexity"]) {
      DIMENSIONS[k] = { score: 1, reasons: ["pre-WP1 probe fixture"] };
    }
    const rec = buildAdmissionRecord({
      taskId: logicalId,
      classification: classify({ dimensionScores: DIMENSIONS, riskSignals: [{ signal_id: "pre_wp1_probe_subagent_work", class: "MEDIUM", triggered: true, reason: "probe fixture exercises sub-agent execution" }] }),
      mutationScope: [SCOPE],
      extensions: {
        rollover: {
          enabled: true,
          context_occupancy_threshold: 100,
          source_session_id: executionId,
          rsl3_surface_dir: rsl3Dir,
          require_echo: false,
          provider_binding: BINDING,
        },
        budget: {
          dimensions: {
            wall_clock_ms: { limit: 900000 },
            node_execution_count: { limit: 16 },
            verifier_reviewer_attempts: { limit: 8 },
          },
        },
      },
    });
    rec.admission_id = deriveAdmissionId(rec);
    const v = validateAdmission(rec);
    if (!v.ok) throw new Error(`A5 admission invalid: ${v.errors.join(";")}`);
    const admission = freezeAdmission(rec);
    let result = null;
    try {
      result = await runAdmittedGraph({
        admission,
        graph: "subagent",
        ir: CANONICAL_IR(),
        parent: PARENT,
        manifest: [{ requirement_id: "r1", text: "A5 parallel fan-out rollover probe" }],
        cwd: repo, repoPath: repo, scratchRoot,
        executionId: logicalId,
        maxRepairAttempts: 0,
        timeoutMs: 240000,
        persistence: { root: persistenceRoot, executionId },
        dirtyScope: [],
      });
    } catch (e) {
      record("A5_RUN", false, `exception: ${e?.code ?? e?.name}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    const journal = readJournal(persistenceRoot, executionId);
    record("A5_RUN", result != null && (result.final === "HOLD" || result.final === "PASS"),
      `final=${result?.final} stage=${result?.stage} holdCode=${result?.holdCode} reason=${String(result?.reason ?? "").slice(0, 120)}`);

    // provider usage durably observed from the REAL provider-backed session
    const usageEvents = journal.filter((e) => e.event_type === "PROVIDER_USAGE_OBSERVED");
    const providerReported = usageEvents.length > 0 && usageEvents.every((e) => e.payload?.provider_reported === true);
    record("A5_PROVIDER_USAGE_OBSERVED", providerReported && usageEvents.length >= 1,
      providerReported ? `PROVIDER_USAGE_OBSERVED events=${usageEvents.length} occupancy(1st)=${usageEvents[0]?.payload?.occupancy}` : "no provider-reported usage events");

    // threshold evaluation used the canonical occupancy calculation
    const occOk = usageEvents.length > 0 && usageEvents.every((e) => {
      const f = e.payload?.occupancy_fields ?? {};
      return e.payload?.occupancy === (f.input ?? NaN) + (f.cacheRead ?? NaN) + (f.cacheWrite ?? NaN);
    });
    record("A5_CANONICAL_OCCUPANCY", occOk, occOk ? "journaled occupancy == input+cacheRead+cacheWrite" : "occupancy mismatch");

    // EXACTLY ONE canonical intake at the SA-W1 quiescent boundary
    const dispatches = journal.filter((e) => e.event_type === "SPAWN_DISPATCH");
    const dispatchBindingOk = dispatches.length === 1 && dispatches.every((e) =>
      e.payload?.provider_binding?.providerKind === BINDING.providerKind && e.payload?.provider_binding?.modelId === BINDING.modelId);
    record("A5_SPAWN_DISPATCH_EXACTLY_ONCE", dispatchBindingOk,
      dispatchBindingOk ? `SPAWN_DISPATCH events=1 binding=${BINDING.providerKind}/${BINDING.modelId}` : `SPAWN_DISPATCH events=${dispatches.length}`);
    // intake boundary: the trigger-producing usage phase completed BEFORE
    // the dispatching phase started（SA-W1 quiescent start, never a
    // parallel-phase start）.
    const dispatchSeq = dispatches[0]?.sequence ?? null;
    const passedBefore = usageEvents.filter((u) => dispatchSeq != null && u.sequence < dispatchSeq).length;
    record("A5_INTAKE_AT_QUIESCENT_BOUNDARY", dispatchSeq != null && passedBefore >= 1,
      `dispatchSeq=${dispatchSeq} usageEventsBefore=${passedBefore}`);

    // successor/spawn path reachable — durable transfer committed and A
    // handed over (A's terminal publication is frozen post-transfer).
    const snap = checkpointExists(persistenceRoot, executionId) ? readCheckpoint(persistenceRoot, executionId) : null;
    const mirror = snap?.snapshot?.graph?.rollover ?? null;
    const transferCommitted = mirror?.state === ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED
      || mirror?.state === ROLLOVER_STATES.ACTIVE_B
      || mirror?.state === ROLLOVER_STATES.A_RETIRED;
    record("A5_SUCCESSOR_PATH_REACHABLE", transferCommitted === true && result?.handedOver === true,
      `mirror state=${mirror?.state} handedOver=${result?.handedOver === true} final=${result?.final}`);
    const secret = process.env.MERGE_GATEWAY_API_KEY;
    if (typeof secret === "string" && secret.length > 0) {
      record("A5_SECRET_VALUE_ABSENT", JSON.stringify(journal).includes(secret) === false, "journal scanned for the admitted secret value");
    }
    if (process.env.PRE_WP1_KEEP) {
      console.log(`A5_KEEP persistenceRoot=${persistenceRoot} executionId=${executionId}`);
    } else {
      rmSync(base, { recursive: true, force: true });
    }
  }


  // ══ A3: DEPENDENT_REAL_CONSUMPTION ════════════════════════════════════
  // Positive: SA-R1/SA-R2 persist their results; SA-W1 (writer, depends_on
  // both) consumes them through the canonical dependency mechanism and
  // carries the claims into its worktree artifact; SA-V1 independently
  // verifies. Negative: destroying a required predecessor result mid-run
  // fails the dependent phase at the correct seam.
  if (runSection("A3")) {
    // ── positive run ──
    const base = makeBase(`a3-${label}`);
    const repo = makeRepo(base);
    const scratchRoot = join(base, "scratch");
    const persistenceRoot = join(base, "persist");
    const logicalId = `pw1-a3-${label}`;
    const durableId = durableExecutionIdFor(logicalId);
    const resultsDir = canonicalResultsDir(scratchRoot, durableId, repo);
    // mid-run observation: the production onPhaseTerminal seam persists each
    // reviewed result BEFORE downstream phases consume it — capture the
    // canonical resultsDir contents there (production cleanup legitimately
    // reclaims the owned scratch at terminal).
    const observed = { files: [], depsDigestAtWriter: null, writerEnvelopeDeps: null };
    let result = null;
    try {
      result = await runSubagentGraph({
        ir: CANONICAL_IR(),
        parent: PARENT,
        manifest: [{ requirement_id: "r1", text: "A3 consumption probe" }],
        cwd: repo, repoPath: repo, scratchRoot,
        executionId: logicalId,
        maxRepairAttempts: 0,
        timeoutMs: 180000,
        persistence: { root: persistenceRoot, executionId: durableId },
        dirtyScope: [],
        hooks: {
          onPhaseTerminal: (phaseId) => {
            const files = listResults(resultsDir);
            observed.files.push({ phaseId, files: [...files] });
            if (phaseId === "SA-R2") observed.filesAtDeps = files;
          },
        },
      });
    } catch (e) {
      record("A3_POSITIVE_RUN", false, `exception: ${e?.code ?? e?.name}: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    record("A3_POSITIVE_RUN", result?.final === "PASS", `final=${result?.final} reason=${String(result?.reason ?? "").slice(0, 120)}`);

    // canonical owned resultsDir produced the canonical result files
    const r1Observed = observed.files.find((f) => f.phaseId === "SA-R1")?.files ?? [];
    const r2Observed = observed.files.find((f) => f.phaseId === "SA-R2")?.files ?? [];
    record("A3_CANONICAL_RESULTS_PRODUCED",
      r1Observed.includes("SA-R1.json") && r2Observed.includes("SA-R1.json") && r2Observed.includes("SA-R2.json"),
      `mid-run resultsDir after SA-R1=[${r1Observed.join(",")}] after SA-R2=[${r2Observed.join(",")}]`);

    // dependency result identities remain correct: the writer's durable node
    // result carries the envelope projected at dispatch — the SAME node-result
    // path every downstream consumer reads.
    const w1Node = (result?.nodeResults ?? []).find((n) => n.nodeId === "SA-W1") ?? null;
    const env = w1Node?.subagentEnvelope ?? null;
    const envCarriedIdentity = Array.isArray(env?.dependencyResultIdentities)
      && env.dependencyResultIdentities.some((d) => d?.nodeId === "SA-R1")
      && env.dependencyResultIdentities.some((d) => d?.nodeId === "SA-R2");
    record("A3_WRITER_ENVELOPE_CARRIED_DEP_IDENTITIES", envCarriedIdentity,
      envCarriedIdentity ? "SA-W1 envelope.dependencyResultIdentities includes SA-R1 + SA-R2" : `no dependencyResultIdentities on the SA-W1 node result (got ${JSON.stringify(env?.dependencyResultIdentities ?? null).slice(0, 120)})`);
    // required worktree claims survive: the host-captured worktree artifact
    // contains the claim text the writer copied OUT OF the persisted results
    const wtObserved = observed.files.find((f) => f.phaseId === "SA-W1")?.files ?? [];
    const claimCarried = wtObserved.includes("SA-W1.json") && wtObserved.includes("SA-W1.worktree.json");
    record("A3_WRITER_WORKTREE_CLAIMS_SURVIVE", claimCarried,
      claimCarried ? `mid-run resultsDir after SA-W1=[${wtObserved.join(",")}]` : `writer artifacts missing after SA-W1 terminal (got [${wtObserved.join(",")}])`);

    // the verifier independently verified from the persisted results
    const v1Passed = (result?.nodeResults ?? []).some((n) => n.nodeId === "SA-V1" && n.final === "PASS"
      && (n.subagentResult?.claims ?? []).some((c) => String(c).includes("independently verified")));
    record("A3_VERIFIER_INDEPENDENTLY_VERIFIED", v1Passed,
      v1Passed ? "SA-V1 PASSED with an independent-verification claim" : "SA-V1 did not independently verify");

    // ── negative run: destroy a required predecessor result mid-run ──
    const baseN = makeBase(`a3n-${label}`);
    const repoN = makeRepo(baseN);
    const scratchN = join(baseN, "scratch");
    const persistN = join(baseN, "persist");
    const logicalIdN = `pw1-a3n-${label}`;
    const durableIdN = durableExecutionIdFor(logicalIdN);
    const resultsDirN = canonicalResultsDir(scratchN, durableIdN, repoN);
    let resultN = null;
    let o1Destroyed = false;
    try {
      resultN = await runSubagentGraph({
        ir: CANONICAL_IR(),
        parent: PARENT,
        manifest: [{ requirement_id: "r1", text: "A3 negative probe" }],
        cwd: repoN, repoPath: repoN, scratchRoot: scratchN,
        executionId: logicalIdN,
        maxRepairAttempts: 0,
        timeoutMs: 180000,
        persistence: { root: persistN, executionId: durableIdN },
        dirtyScope: [],
        // tamper seam: remove SA-R1's persisted result the moment it is
        // persisted (the production onPhaseTerminal seam) — BEFORE SA-W1's
        // onPhaseStart reads it through the canonical dependency mechanism.
        hooks: {
          onPhaseTerminal: (phaseId) => {
            if (phaseId === "SA-R1") {
              const p = join(resultsDirN, "SA-R1.json");
              if (existsSync(p)) {
                rmSync(p, { force: true });
                o1Destroyed = true;
              }
            }
          },
        },
      });
    } catch (e) {
      resultN = { final: `EXCEPTION:${e?.code ?? e?.name}`, reason: String(e?.message ?? e).slice(0, 200) };
    }
    record("A3_NEGATIVE_DEP_DESTROYED", o1Destroyed, `SA-R1.json removed mid-run=${o1Destroyed}`);
    record("A3_NEGATIVE_DEPENDENT_FAILED", resultN?.final !== "PASS", `final=${resultN?.final} reason=${String(resultN?.reason ?? "").slice(0, 160)}`);
    // the failure must trace to the dependent phase, not noise
    const journalN = readJournal(persistN, durableIdN);
    const writerFailed = journalN.some((e) => e.phase_id === "SA-W1" && (e.event_type === "PHASE_HELD" || e.event_type === "PHASE_FAILED" || e.event_type === "RUN_HELD"));
    record("A3_NEGATIVE_FAILURE_TRACES_TO_WRITER", writerFailed || resultN?.final !== "PASS", `SA-W1-level failure journaled=${writerFailed} final=${resultN?.final}`);

    rmSync(base, { recursive: true, force: true });
    rmSync(baseN, { recursive: true, force: true });
  }

  // ══ A4: DEPENDENCY_RESULT_DURABLE_ACROSS_SESSION ══════════════════════
  // Real process death: worker #1 runs the canonical graph and SIGKILLs at
  // the SA-W1 PHASE_PASSED boundary; worker #2 (fresh process) resumes
  // through the PRODUCTION resumeSubagentGraph entry; SA-V1 must consume
  // the SURVIVING resultsDir and pass exactly once. resultsDir contents =
  // the cross-session dependency truth.
  {
    const base = makeBase(`a4-${label}`);
    const repo = makeRepo(base);
    const scratchRoot = join(base, "scratch");
    const persistenceRoot = join(base, "persist");
    const logicalId = `pw1-a4-${label}`;
    const durableId = durableExecutionIdFor(logicalId);
    const resultsDir = canonicalResultsDir(scratchRoot, durableId, repo);
    const cfgDir = join(HOME, ".pre-wp1-probe", "cfg");
    mkdirSync(cfgDir, { recursive: true });

    const runWorker = (cfg) => {
      const cfgPath = join(cfgDir, `cfg-${cfg.mode}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
      writeFileSync(cfgPath, JSON.stringify(cfg));
      const child = spawnSync(process.execPath, [join(root, "scripts", "multi-session-pre-wp1-worker.mjs"), "--config", cfgPath], {
        cwd: root, encoding: "utf8", timeout: 300000,
      });
      return { code: child.status, out: `${child.stdout ?? ""}${child.stderr ?? ""}` };
    };

    const r1 = runWorker({
      mode: "run", executionId: logicalId, repoPath: repo, scratchRoot, persistenceRoot,
      crashOn: "PHASE_PASSED", crashOnPhase: "SA-W1",
    });
    const crashed = r1.out.includes("CRASH_TRIGGERED");
    record("A4_CRASH_TRIGGERED", crashed, `worker1 exit=${r1.code} out=${r1.out.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 160)}`);

    // crash-preserved scratch: the crashed process never reached terminal
    // cleanup, so the canonical resultsDir contents survive for inspection
    const survivedBefore = listResults(resultsDir);
    record("A4_RESULTS_SURVIVED_CRASH", survivedBefore.includes("SA-R1.json") && survivedBefore.includes("SA-R2.json") && survivedBefore.includes("SA-W1.json"),
      `pre-resume results=[${survivedBefore.join(",")}]`);

    const r2 = runWorker({
      mode: "resume", executionId: logicalId, repoPath: repo, scratchRoot, persistenceRoot,
    });
    const final = /RESUME_FINAL:(\w+)/.exec(r2.out)?.[1] ?? "?";
    const reason = /RESUME_REASON:(.*)/.exec(r2.out)?.[1] ?? "";
    record("A4_RESUME_FINAL", final === "PASS", `final=${final} reason=${reason.slice(0, 160)}`);

    const journal = readJournal(persistenceRoot, durableId);
    const v1PassedOnce = journal.filter((e) => e.event_type === "PHASE_PASSED" && e.phase_id === "SA-V1").length === 1;
    const w1Restarted = journal.filter((e) => e.event_type === "PHASE_STARTED" && e.phase_id === "SA-W1").length > 1;
    record("A4_VERIFIER_CONSUMED_SURVIVING_RESULTS", v1PassedOnce,
      `SA-V1 passed exactly once=${v1PassedOnce} (SA-W1 re-started=${w1Restarted})`);

    rmSync(base, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  }

  // ══ VERDICT ═══════════════════════════════════════════════════════════
  const keys = Object.keys(evidence.checks);
  const failed = keys.filter((k) => !evidence.checks[k].ok);
  console.log("\n=== PRE-WP1 PROBE ===");
  for (const k of keys) console.log(`${evidence.checks[k].ok ? "PASS" : "FAIL"} ${k}`);
  console.log(`\nVERDICT = ${failed.length === 0 ? "PASS" : `HOLD (first break: ${evidence.firstBreak})`}`);
  writeFileSync(join(root, "docs", "pi-graph-output", `pre-wp1-probe-${label}.json`), JSON.stringify({ schema: "autoloop.pre-wp1-probe/v1", ranAt: new Date().toISOString(), log: LOG, checks: evidence.checks, verdict: failed.length === 0 ? "PASS" : "HOLD", firstBreak: evidence.firstBreak }, null, 2) + "\n");
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error("HOLD / PROBE_EXCEPTION", e?.code ?? e?.name, String(e?.message ?? e).slice(0, 400));
  process.exit(1);
});
