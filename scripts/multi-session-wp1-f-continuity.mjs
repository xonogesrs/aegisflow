#!/usr/bin/env node
// scripts/multi-session-wp1-f-continuity.mjs
//
// AUTOLOOP_WP1_MULTI_SESSION_CONTINUITY — PHASE F: Sequential Session A →
// Session B continuity E2E over the canonical sub-agent graph.
//
// Proven (all through PRODUCTION entries — no test-only output passing):
//   F1  SESSION_A_RUN          — A runs the canonical SA-R1 ‖ SA-R2 → SA-W1
//                               graph through runSubagentGraphAdmitted with
//                               a rollover-enabled frozen admission; real
//                               provider-backed sub-agent execution.
//   F2  A_USAGE_OBSERVED       — PROVIDER_USAGE_OBSERVED journaled durably.
//   F3  A_HANDOVER_HOLD        — A freezes at the rollover handover boundary
//                               (CROSS_SESSION_ROLLOVER_IN_PROGRESS_A_FROZEN)
//                               with ownership transfer committed.
//   F4  A_RESULTS_AUTHORED     — A's persisted results carry the authored-
//                               result provenance envelope
//                               (autoloop.subagent.authored-result/v1) with
//                               executionId/phase_id/phaseExecutionId/
//                               agentExecutionId/inputContextIdentity.
//   F5  B_BOOTSTRAP            — Session B resumes through
//                               bootstrapSuccessorSession (locator metadata
//                               ONLY) with the sub-agent wiring re-injected.
//   F6  B_RESUMED              — B continues the SAME graph identity from
//                               durable truth and reaches a terminal verdict.
//   F7  B_CONSUMED_A_RESULTS   — B's dependent phases consumed A's surviving
//                               results through the provenance envelope: the
//                               results were re-bound to B's era (fold gate)
//                               and verified at consumption (no
//                               DEPENDENCY_PROVENANCE blocking findings; the
//                               writer/verifier claims cite the dependency
//                               claims copied OUT of the persisted results).
//   F8  SINGLE_VERIFIER_PASS   — SA-V1 passed exactly once across BOTH eras
//                               (no duplicate execution across the boundary).
//
// OBSERVATION TIMING: the production graph runner legitimately reclaims the
// owned scratch at terminal. resultsDir inspection happens MID-RUN through
// the production onPhaseTerminal hook (A era) and from the durable journal +
// B-era envelope metadata (B era).
//
// Requires colima (profile autoloop-graph) with COLIMA_HOME set canonically
// and MERGE_GATEWAY_API_KEY in the environment. Run:
//   COLIMA_HOME=/Volumes/NVM2T/Development/runtime/colima \
//     node scripts/multi-session-wp1-f-continuity.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const HOME = homedir();
const LOG = mkdtempSync(join(tmpdir(), "wp1-f-log-")) + "/probe.log";
const log = (line) => appendFileSync(LOG, line + "\n");

const { runSubagentGraphAdmitted } = await import(`${root}/src/admission/admission-gate.mjs`);
const { buildAdmissionRecord } = await import(`${root}/src/admission/policy-projection.mjs`);
const { classify } = await import(`${root}/src/admission/classify.mjs`);
const { validateAdmission, deriveAdmissionId, freezeAdmission } = await import(`${root}/src/admission/admission-record.mjs`);
const { mintExecutionId } = await import(`${root}/src/c2d/execution-id.mjs`);
const { readCheckpoint, checkpointExists } = await import(`${root}/src/v2/checkpoint-bridge.mjs`);
const { bootstrapSuccessorSession } = await import(`${root}/src/rollover/production-wiring.mjs`);
const { ROLLOVER_STATES } = await import(`${root}/src/rollover/rollover-authority.mjs`);
const { planOwnedScratchRoot } = await import(`${root}/src/runtime/scratch-ownership.mjs`);
const { durableExecutionIdFor } = await import(`${root}/src/subagent/subagent-graph-runner.mjs`);
const { AUTHORED_RESULT_SCHEMA } = await import(`${root}/src/subagent/subagent-graph-runner.mjs`);
const { DEFAULT_ENV_ALLOWLIST } = await import(`${root}/src/adapter/pi-rpc-adapter.mjs`);
const { createSubagentExecutorAdapter } = await import(`${root}/src/subagent/subagent-executor-adapter.mjs`);
const { createSubagentWriterExecutorAdapter } = await import(`${root}/src/subagent/subagent-writer-executor-adapter.mjs`);
const { createReviewAgentReviewerAdapter } = await import(`${root}/src/subagent/subagent-review-agent.mjs`);
const { createColimaExecutorAdapter } = await import(`${root}/src/runtime/colima-executor-adapter.mjs`);
const { createColimaReviewerAdapter } = await import(`${root}/src/runtime/colima-reviewer-adapter.mjs`);

const evidence = { checks: {}, firstBreak: null };
function record(name, ok, detail = "") {
  evidence.checks[name] = { ok, detail: String(detail).slice(0, 300) };
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
  if (!ok && evidence.firstBreak === null) evidence.firstBreak = name;
}

const SCOPE = "docs/pi-graph-output";
const PARENT = { scope: { allowed_paths: [SCOPE], forbidden_paths: [".git"] } };
const BINDING = { adapterKind: "pi-builtin", providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash", requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"] };
const DIMENSIONS = {};
for (const k of ["affected_files", "affected_subsystems", "dependency_depth", "ambiguity", "expected_execution_steps", "verification_burden", "external_dependencies", "concurrency_potential", "statefulness", "rollback_complexity"]) {
  DIMENSIONS[k] = { score: 1, reasons: ["wp1 phase F probe fixture"] };
}

// Canonical sub-agent phase names (SA-R1 ‖ SA-R2 -> SA-W1 -> SA-V1).
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
  phases: [saReadonlyPhase("SA-R1", "count_todos"), saReadonlyPhase("SA-R2", "inventory_markdown"), saWriterPhase(), saVerifierPhase()],
  dispositions: [],
});

function makeBase(label) {
  const base = join(HOME, ".wp1-f-probe", `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(base, { recursive: true });
  return base;
}
function makeRepo(base) {
  const dir = join(base, "repo");
  mkdirSync(join(dir, "docs"), { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-b", "master"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "probe@autoloop"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "probe"], { stdio: "ignore" });
  writeFileSync(join(dir, "docs", "a.md"), "# a\n\nTODO: probe\n");
  writeFileSync(join(dir, "docs", "b.md"), "# b\n");
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "base"], { stdio: "ignore" });
  return dir;
}
function readJournal(persistenceRoot, durableId) {
  const jdir = join(persistenceRoot, durableId, "journal");
  if (!existsSync(jdir)) return [];
  return readdirSync(jdir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(jdir, f), "utf8")));
}
function canonicalResultsDir(scratchRoot, durableId, repoPath) {
  const ownedRoot = planOwnedScratchRoot({ scratchRoot, executionId: durableId, repoPath });
  return join(ownedRoot, "results");
}
function listResults(resultsDir) {
  return existsSync(resultsDir) ? readdirSync(resultsDir).filter((f) => f.endsWith(".json")).sort() : [];
}

// THE production sub-agent adapter wiring — the same composition
// buildSubagentAdapterFactories derives inside the runner, re-injected for
// B's bootstrap (the successor resume entry takes explicit factories).
function subagentAdapterFactories({ repoPath, scratchRoot, resultsDir, maxRepairAttempts, admission, dispatchLog = null }) {
  return {
    executorAdapterFactory: ({ resultSink } = {}) => {
      dispatchLog?.push({ constructed: true, hasResultSink: Boolean(resultSink) });
      const roSubagent = createSubagentExecutorAdapter({ profile: "autoloop-graph", repoPath, scratchRoot, resultsDir, resultSink });
      const writerSubagent = createSubagentWriterExecutorAdapter({ profile: "autoloop-graph", repoPath, scratchRoot, resultsDir, resultSink, maxRepairAttempts });
      const roColima = createColimaExecutorAdapter({ profile: "autoloop-graph", repoPath, scratchRoot, resultSink });
      return () => ({
        runAdapter: async (request) => {
          const rt = request.taskCard?.runtime ?? {};
          dispatchLog?.push({ phaseId: request.taskCard?.phaseId ?? null, mode: rt.mode ?? null, agentRole: rt.agentRole ?? null, hasWorktreePath: Boolean(rt.worktreePath), hasScratchPath: Boolean(rt.scratchPath), hasViolation: Boolean(rt.admissionViolation) });
          if (Array.isArray(rt.dependencyConflicts) && rt.dependencyConflicts.length > 0) {
            return {
              status: "error",
              executionId: request.executionId,
              error: `DEPENDENCY_CONFLICT_HOLD:${rt.dependencyConflicts.length}`,
              stdout: "",
              stderr: "",
              metadata: { dependencyConflicts: rt.dependencyConflicts },
            };
          }
          let routed = null;
          dispatchLog?.push({ phaseId: request.taskCard?.phaseId ?? null, preAwait: true, mode: rt.mode, agentRole: rt.agentRole });
          try {
            routed = rt.mode === "subagent" && rt.agentRole === "writer"
              ? await writerSubagent.runAdapter(request)
              : rt.mode === "readonly"
                ? await roColima.runAdapter(request)
                : await roSubagent.runAdapter(request);
          } catch (e) {
            dispatchLog?.push({ phaseId: request.taskCard?.phaseId ?? null, thrown: String(e?.name ?? "") + ":" + String(e?.message ?? e).slice(0, 200) });
            throw e;
          }
          dispatchLog?.push({ phaseId: request.taskCard?.phaseId ?? null, routedStatus: routed?.status ?? "THROWN", adapterError: routed?.status === "error" ? String(routed.error ?? "").slice(0, 300) : undefined, stderrTail: routed?.status === "error" ? String(routed.stderr ?? "").slice(-400) : undefined });
          return routed;
        },
      });
    },
    reviewerAdapterFactory: () => ({
      runAdapter: async (request) => {
        const rt = request.taskCard?.runtime ?? {};
        if (rt.mode === "readonly") return createColimaReviewerAdapter().runAdapter(request);
        if (rt.agentRole === "writer") {
          return createReviewAgentReviewerAdapter({ profile: "autoloop-graph", repoPath, scratchRoot, resultsDir }).runAdapter(request);
        }
        return createColimaReviewerAdapter().runAdapter(request);
      },
    }),
  };
}

async function main() {
  const label = Date.now().toString(36);
  const base = makeBase(`f-${label}`);
  const repo = makeRepo(base);
  const scratchRoot = join(base, "scratch");
  const persistenceRoot = join(base, "persist");
  const rsl3Dir = join(base, "rsl3");
  mkdirSync(rsl3Dir, { recursive: true });
  const logicalId = `wp1-f-${label}`;
  const executionId = mintExecutionId();
  // The admitted sub-agent path keys the durable store by the id passed in
  // persistence.executionId（the minted execution id here）— the owned
  // resultsDir must derive from THE SAME id.
  const durableId = executionId;

  const rec = buildAdmissionRecord({
    taskId: logicalId,
    classification: classify({ dimensionScores: DIMENSIONS, riskSignals: [{ signal_id: "wp1_f_probe_subagent_work", class: "MEDIUM", triggered: true, reason: "probe fixture exercises sub-agent execution" }] }),
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
  if (!v.ok) throw new Error(`F admission invalid: ${v.errors.join(";")}`);
  const admission = freezeAdmission(rec);

  const resultsDir = canonicalResultsDir(scratchRoot, durableId, repo);

  // mid-run observation of A's persisted results (production onPhaseTerminal)
  const observed = { files: [], envelopes: {}, bDispatches: [] };
  // THE owned scratch root — the same derivation runSubagentGraph performs;
  // the adapters' private scratch + worktrees live under IT, never the
  // caller-supplied namespace.
  const ownedScratchRoot = planOwnedScratchRoot({ scratchRoot, executionId: durableId, repoPath: repo });
  const sharedFactories = () => subagentAdapterFactories({ repoPath: repo, scratchRoot: ownedScratchRoot, resultsDir, maxRepairAttempts: 0, admission, dispatchLog: observed.bDispatches });

  // ── SESSION A ───────────────────────────────────────────────────────────
  let A = null;
  try {
    A = await runSubagentGraphAdmitted({
      admission,
      ir: CANONICAL_IR(),
      parent: PARENT,
      manifest: [{ requirement_id: "r1", text: "WP1 F continuity probe (session A)" }],
      cwd: repo, repoPath: repo, scratchRoot,
      executionId: logicalId,
      maxRepairAttempts: 0,
      timeoutMs: 240000,
      persistence: { root: persistenceRoot, executionId },
      dirtyScope: [],
      hooks: {
        onPhaseTerminal: (phaseId) => {
          const files = listResults(resultsDir);
          observed.files.push({ phaseId, files: [...files] });
          const p = join(resultsDir, `${phaseId}.json`);
          if (existsSync(p)) {
            try { observed.envelopes[phaseId] = JSON.parse(readFileSync(p, "utf8")); } catch { /* observed below */ }
          }
        },
      },
    });
  } catch (e) {
    record("F1_SESSION_A_RUN", false, `exception: ${e?.code ?? e?.name}: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  record("F1_SESSION_A_RUN", A != null && (A.final === "HOLD" || A.final === "PASS"),
    `final=${A?.final} stage=${A?.stage} holdCode=${A?.holdCode} reason=${String(A?.reason ?? "").slice(0, 140)}`);

  const journal = readJournal(persistenceRoot, executionId);
  const usageEvents = journal.filter((e) => e.event_type === "PROVIDER_USAGE_OBSERVED");
  record("F2_A_USAGE_OBSERVED", usageEvents.length >= 1 && usageEvents.every((e) => e.payload?.provider_reported === true),
    usageEvents.length ? `PROVIDER_USAGE_OBSERVED events=${usageEvents.length} occupancy(1st)=${usageEvents[0]?.payload?.occupancy}` : "no provider-reported usage events");

  const snap = checkpointExists(persistenceRoot, executionId) ? readCheckpoint(persistenceRoot, executionId) : null;
  const mirror = snap?.snapshot?.graph?.rollover ?? null;
  const transferCommitted = mirror?.state === ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED
    || mirror?.state === ROLLOVER_STATES.ACTIVE_B
    || mirror?.state === ROLLOVER_STATES.A_RETIRED;
  record("F3_A_HANDOVER_HOLD", A?.final === "HOLD" && A?.handedOver === true && transferCommitted,
    `final=${A?.final} handedOver=${A?.handedOver === true} mirror=${mirror?.state}`);

  // A's persisted results carry the authored-result provenance envelope.
  // SA-W1 is EXPECTED to be absent here: A froze at SA-W1's quiescent START
  // boundary（the handover fence fires before its dispatch）, so SA-W1's
  // result is produced by B's era — F7 proves B consumed A's SA-R1/SA-R2.
  const authoredPhases = ["SA-R1", "SA-R2"].filter((id) => {
    const e = observed.envelopes[id];
    return e
      && e.schema_version === AUTHORED_RESULT_SCHEMA
      && e.executionId === executionId
      && e.phase_id === id
      && typeof e.phaseExecutionId === "string" && e.phaseExecutionId.length > 0
      && typeof e.agentExecutionId === "string" && e.agentExecutionId.length > 0
      && typeof e.inputContextIdentity === "string" && e.inputContextIdentity.length > 0
      && e.result && typeof e.result === "object";
  });
  record("F4_A_RESULTS_AUTHORED", authoredPhases.length === 2,
    authoredPhases.length === 2 ? `authored envelopes for [${authoredPhases.join(",")}]` : `authored=[${authoredPhases.join(",")}] of [SA-R1,SA-R2]`);

  // ── SESSION B ───────────────────────────────────────────────────────────
  const ownerB = mirror?.owner ?? null;
  let B = null;
  let bootstrapError = null;
  try {
    B = await bootstrapSuccessorSession({
      persistenceRoot,
      executionId,
      spawnMeta: {
        rolloverId: mirror?.active_rollover_id ?? mirror?.last_rollover_id ?? null,
        expectedTargetGeneration: ownerB?.session_generation ?? 1,
        providerBinding: BINDING,
      },
      // sub-agent wiring re-injected for the successor era: the same shared
      // resultsDir + dispatchers the fresh path composes.
      ir: CANONICAL_IR(),
      parent: PARENT,
      manifest: [{ requirement_id: "r1", text: "WP1 F continuity probe (session B)" }],
      cwd: repo, repoPath: repo, scratchRoot,
      maxRepairAttempts: 0,
      timeoutMs: 240000,
      dirtyScope: [],
      admission,
      ...sharedFactories(),
    });
  } catch (e) {
    bootstrapError = e;
  }
  record("F5_B_BOOTSTRAP", B !== null,
    bootstrapError ? `${bootstrapError.code ?? ""} ${String(bootstrapError.message).slice(0, 160)}` : `bootstrap accepted (final=${B?.final} stage=${B?.stage})`);
  if (!B) {
    console.error("B_DISPATCH_LOG", JSON.stringify(observed.bDispatches));
    finish();
    return;
  }
  console.error("B_DISPATCH_LOG", JSON.stringify(observed.bDispatches));

  record("F6_B_RESUMED", B.final === "PASS" || B.final === "HOLD",
    `final=${B.final} stage=${B.stage} reason=${String(B.reason ?? "").slice(0, 140)}`);

  // B consumed A's surviving results through the provenance envelope:
  //   - the writer's envelope carried the dependency identities with the
  //     PRODUCER payload's status/filesChanged (unwrapped from the envelope)
  //   - no DEPENDENCY_PROVENANCE blocking finding was seeded for B's phases
  const w1Node = (B.nodeResults ?? []).find((n) => n.nodeId === "SA-W1") ?? null;
  const env = w1Node?.subagentEnvelope ?? null;
  console.error("F7_DEBUG", JSON.stringify({
    nodeResultsCount: (B.nodeResults ?? []).length,
    w1Found: Boolean(w1Node),
    identities: env?.dependencyResultIdentities ?? null,
  }));
  const identitiesOk = Array.isArray(env?.dependencyResultIdentities)
    && env.dependencyResultIdentities.some((d) => d?.nodeId === "SA-R1" && d?.status === "PASS")
    && env.dependencyResultIdentities.some((d) => d?.nodeId === "SA-R2" && d?.status === "PASS");
  const bJournal = readJournal(persistenceRoot, executionId);
  const provenanceHolds = bJournal.filter((e) => e.phase_id === "SA-W1" && e.event_type === "PHASE_HELD"
    && JSON.stringify(e.payload ?? {}).includes("DEPENDENCY_PROVENANCE"));
  record("F7_B_CONSUMED_A_RESULTS", identitiesOk && provenanceHolds.length === 0,
    `identities carry producer status=${identitiesOk} provenanceHolds=${provenanceHolds.length}`);

  // SA-V1 passed exactly once across BOTH eras
  const v1Passes = bJournal.filter((e) => e.event_type === "PHASE_PASSED" && e.phase_id === "SA-V1").length;
  record("F8_SINGLE_VERIFIER_PASS", v1Passes === 1 && (B.final === "PASS"),
    `SA-V1 PHASE_PASSED count=${v1Passes} B.final=${B.final}`);

  finish();

  function finish() {
    const keys = Object.keys(evidence.checks);
    const failed = keys.filter((k) => !evidence.checks[k].ok);
    console.log("\n=== WP1 PHASE F: SEQUENTIAL A→B CONTINUITY ===");
    for (const k of keys) console.log(`${evidence.checks[k].ok ? "PASS" : "FAIL"} ${k}`);
    console.log(`\nVERDICT = ${failed.length === 0 ? "PASS" : `HOLD (first break: ${evidence.firstBreak})`}`);
    writeFileSync(join(root, "docs", "pi-graph-output", `wp1-f-continuity-${label}.json`),
      JSON.stringify({ schema: "autoloop.wp1-f-continuity/v1", ranAt: new Date().toISOString(), log: LOG, checks: evidence.checks, verdict: failed.length === 0 ? "PASS" : "HOLD", firstBreak: evidence.firstBreak }, null, 2) + "\n");
    if (failed.length > 0) process.exitCode = 1;
    if (!process.env.WP1_F_KEEP) rmSync(base, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("HOLD / PROBE_EXCEPTION", e?.code ?? e?.name, String(e?.message ?? e).slice(0, 400));
  process.exit(1);
});
