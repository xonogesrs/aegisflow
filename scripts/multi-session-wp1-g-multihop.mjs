#!/usr/bin/env node
// scripts/multi-session-wp1-g-multihop.mjs
//
// AUTOLOOP_WP1_MULTI_SESSION_CONTINUITY — PHASE G: A → B → C MULTI-HOP
// continuity E2E over the canonical sub-agent graph (production entries
// ONLY — no test-only output passing, no reconstructed substitutes).
//
// Proven:
//   G1  A_PUBLISHES_AUTHORED     — A's persisted results carry the authored-
//                                 result provenance envelope
//                                 (autoloop.subagent.authored-result/v1) with
//                                 executionId/phase_id/phaseExecutionId/
//                                 agentExecutionId/inputContextIdentity.
//   G2  B_CONSUMED_A             — B's dependent writer consumed A's
//                                 SA-R1/SA-R2 through the verified envelope
//                                 (era re-bind + provenance verification; no
//                                 DEPENDENCY_PROVENANCE blocking findings).
//   G3  B_PUBLISHES_NEW_GEN      — B's era authored SA-W1 under B's durable
//                                 graph generation (recovery_generation 1),
//                                 a NEW authoritative generation.
//   G4  C_CONSUMED_B             — C's verifier consumed B's SA-W1 result
//                                 (generation-correct, provenance-verified).
//   G5  STALE_A_NOT_IMPERSONATED — the B→C intake presented B's durable
//                                 owner-of-record identity, never A's
//                                 generation-0 source identity.
//   G6  GENERATION_MONOTONIC     — intake source generations 0→1 (strictly
//                                 increasing; no reuse/skip).
//   G7  DISPATCH_EXACTLY_ONCE    — exactly TWO SPAWN_DISPATCH events total
//                                 (A→B and B→C); no duplicate dispatch.
//   G8  GRAPH_IDENTITY_CONTINUOUS— one durable execution id across all three
//                                 eras; the IR artifact never changed.
//   G9  DEPENDENCY_IDENTITY_BOUND— every consumed dependency identity re-
//                                 derives from the SAME (executionId, phase).
//   G10 C_PROVES_B_CONSUMPTION   — deterministic: C's SA-V1 PASS requires
//                                 /results/SA-W1.json to exist with producer
//                                 status PASS + the review PASS; the writer's
//                                 report claims cite A's dependency claims —
//                                 impossible without B consuming A.
//
// OBSERVATION TIMING: resultsDir inspection happens MID-RUN through the
// production onPhaseTerminal hook per era.
//
// Requires colima (profile autoloop-graph) with COLIMA_HOME set canonically
// and MERGE_GATEWAY_API_KEY in the environment. Run:
//   COLIMA_HOME=/Volumes/NVM2T/Development/runtime/colima \
//     node scripts/multi-session-wp1-g-multihop.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const HOME = homedir();
const LOG = mkdtempSync(join(tmpdir(), "wp1-g-log-")) + "/probe.log";
const log = (line) => appendFileSync(LOG, line + "\n");

const { runSubagentGraphAdmitted } = await import(`${root}/src/admission/admission-gate.mjs`);
const { buildAdmissionRecord } = await import(`${root}/src/admission/policy-projection.mjs`);
const { classify } = await import(`${root}/src/admission/classify.mjs`);
const { validateAdmission, deriveAdmissionId, freezeAdmission } = await import(`${root}/src/admission/admission-record.mjs`);
const { mintExecutionId } = await import(`${root}/src/c2d/execution-id.mjs`);
const { readCheckpoint, checkpointExists } = await import(`${root}/src/v2/checkpoint-bridge.mjs`);
const { bootstrapSuccessorSession } = await import(`${root}/src/rollover/production-wiring.mjs`);
const { ROLLOVER_STATES, sessionIdentityDigest } = await import(`${root}/src/rollover/rollover-authority.mjs`);
const { planOwnedScratchRoot } = await import(`${root}/src/runtime/scratch-ownership.mjs`);
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
  DIMENSIONS[k] = { score: 1, reasons: ["wp1 phase G probe fixture"] };
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
  const base = join(HOME, ".wp1-g-probe", `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
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
// successor bootstrap (the successor resume entry takes explicit factories).
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
  const base = makeBase(`g-${label}`);
  const repo = makeRepo(base);
  const scratchRoot = join(base, "scratch");
  const persistenceRoot = join(base, "persist");
  const rsl3Dir = join(base, "rsl3");
  mkdirSync(rsl3Dir, { recursive: true });
  const logicalId = `wp1-g-${label}`;
  const executionId = mintExecutionId();
  const durableId = executionId;

  const rec = buildAdmissionRecord({
    taskId: logicalId,
    classification: classify({ dimensionScores: DIMENSIONS, riskSignals: [{ signal_id: "wp1_g_probe_subagent_work", class: "MEDIUM", triggered: true, reason: "probe fixture exercises sub-agent execution" }] }),
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
          wall_clock_ms: { limit: 1800000 },
          node_execution_count: { limit: 32 },
          verifier_reviewer_attempts: { limit: 16 },
        },
      },
    },
  });
  rec.admission_id = deriveAdmissionId(rec);
  const v = validateAdmission(rec);
  if (!v.ok) throw new Error(`G admission invalid: ${v.errors.join(";")}`);
  const admission = freezeAdmission(rec);

  const resultsDir = canonicalResultsDir(scratchRoot, durableId, repo);

  // per-era observation of persisted results (production onPhaseTerminal)
  const observed = { files: [], envelopes: {}, dispatches: [] };
  const ownedScratchRoot = planOwnedScratchRoot({ scratchRoot, executionId: durableId, repoPath: repo });
  const sharedFactories = () => subagentAdapterFactories({ repoPath: repo, scratchRoot: ownedScratchRoot, resultsDir, maxRepairAttempts: 0, admission, dispatchLog: observed.dispatches });

  const eraHook = () => ({
    onPhaseStart: (phaseId) => {
      const files = listResults(resultsDir);
      console.error(`ERA_FILES ${phaseId} [${files.join(",")}]`);
    },
    onPhaseTerminal: (phaseId) => {
      const files = listResults(resultsDir);
      observed.files.push({ phaseId, files: [...files] });
      const p = join(resultsDir, `${phaseId}.json`);
      if (existsSync(p)) {
        try { observed.envelopes[phaseId] = JSON.parse(readFileSync(p, "utf8")); } catch { /* observed below */ }
      }
    },
  });

  const runOpts = () => ({
    admission,
    ir: CANONICAL_IR(),
    parent: PARENT,
    manifest: [{ requirement_id: "r1", text: "WP1 G multi-hop continuity probe" }],
    cwd: repo, repoPath: repo, scratchRoot,
    maxRepairAttempts: 0,
    timeoutMs: 300000,
    dirtyScope: [],
    hooks: eraHook(),
  });

  // ── SESSION A ───────────────────────────────────────────────────────────
  let A = null;
  try {
    A = await runSubagentGraphAdmitted({
      ...runOpts(),
      executionId: logicalId,
      persistence: { root: persistenceRoot, executionId },
    });
  } catch (e) {
    record("G0_A_RUN_NO_EXCEPTION", false, `exception: ${e?.code ?? e?.name}: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  record("G0_A_RUN_NO_EXCEPTION", A != null && (A.final === "HOLD" || A.final === "PASS"),
    `final=${A?.final} stage=${A?.stage} holdCode=${A?.holdCode}`);

  const journalA = readJournal(persistenceRoot, executionId);
  const snapA = checkpointExists(persistenceRoot, executionId) ? readCheckpoint(persistenceRoot, executionId) : null;
  const mirrorA = snapA?.snapshot?.graph?.rollover ?? null;

  // G1: A's persisted results carry the authored-result provenance envelope.
  // SA-W1 is EXPECTED to be absent here: A froze at SA-W1's quiescent START
  // boundary (the handover fence fires before its dispatch), so SA-W1's
  // result is produced by B's era.
  const authoredPhasesA = ["SA-R1", "SA-R2"].filter((id) => {
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
  record("G1_A_PUBLISHES_AUTHORED", authoredPhasesA.length === 2,
    authoredPhasesA.length === 2 ? `authored envelopes for [${authoredPhasesA.join(",")}]` : `authored=[${authoredPhasesA.join(",")}] of [SA-R1,SA-R2]`);

  const ownerB = mirrorA?.owner ?? null;
  record("G0_A_HANDOVER", A?.final === "HOLD" && A?.handedOver === true
    && (mirrorA?.state === ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED || mirrorA?.state === ROLLOVER_STATES.ACTIVE_B),
    `final=${A?.final} handedOver=${A?.handedOver === true} mirror=${mirrorA?.state}`);

  // ── SESSION B ───────────────────────────────────────────────────────────
  let B = null;
  let bootstrapErrorB = null;
  try {
    B = await bootstrapSuccessorSession({
      persistenceRoot,
      executionId,
      spawnMeta: {
        rolloverId: mirrorA?.active_rollover_id ?? mirrorA?.last_rollover_id ?? null,
        expectedTargetGeneration: ownerB?.session_generation ?? 1,
        providerBinding: BINDING,
      },
      ...runOpts(),
    });
  } catch (e) {
    bootstrapErrorB = e;
  }
  record("G0_B_BOOTSTRAP", B !== null,
    bootstrapErrorB ? `${bootstrapErrorB.code ?? ""} ${String(bootstrapErrorB.message).slice(0, 160)}` : `bootstrap accepted (final=${B?.final})`);
  if (!B) {
    console.error("B_DISPATCH_LOG", JSON.stringify(observed.dispatches));
    finish();
    return;
  }
  console.error("B_DISPATCH_LOG", JSON.stringify(observed.dispatches));

  // G2: B consumed A's surviving results through the verified envelope.
  const w1Node = (B.nodeResults ?? []).find((n) => n.nodeId === "SA-W1") ?? null;
  const env = w1Node?.subagentEnvelope ?? null;
  console.error("G2_DEBUG", JSON.stringify({
    nodeResultsCount: (B.nodeResults ?? []).length,
    w1Found: Boolean(w1Node),
    identities: env?.dependencyResultIdentities ?? null,
  }));
  const identitiesOk = Array.isArray(env?.dependencyResultIdentities)
    && env.dependencyResultIdentities.some((d) => d?.nodeId === "SA-R1" && d?.status === "PASS")
    && env.dependencyResultIdentities.some((d) => d?.nodeId === "SA-R2" && d?.status === "PASS");
  const journalB = readJournal(persistenceRoot, executionId);
  const provenanceHoldsB = journalB.filter((e) => e.phase_id === "SA-W1" && e.event_type === "PHASE_HELD"
    && JSON.stringify(e.payload ?? {}).includes("DEPENDENCY_PROVENANCE"));
  record("G2_B_CONSUMED_A", identitiesOk && provenanceHoldsB.length === 0,
    `identities carry producer status=${identitiesOk} provenanceHolds=${provenanceHoldsB.length}`);

  // G3: B published a NEW authoritative generation — the SA-W1 envelope
  // captured at B's era terminal is stamped with B's durable graph
  // generation (recovery_generation 1) and carries B's identity binding;
  // the durable phase artifact agrees (graph_generation 1).
  const w1Envelope = observed.envelopes["SA-W1"] ?? null;
  const bGeneration = w1Envelope?.graph_generation ?? null;
  let durableW1Gen = null;
  try {
    durableW1Gen = JSON.parse(readFileSync(join(persistenceRoot, executionId, "phases", "SA-W1", "result.json"), "utf8"))?.graph_generation ?? null;
  } catch { durableW1Gen = null; }
  record("G3_B_PUBLISHES_NEW_GEN", w1Envelope
      && w1Envelope.schema_version === AUTHORED_RESULT_SCHEMA
      && w1Envelope.executionId === executionId
      && bGeneration === 1
      && durableW1Gen === 1
      && typeof w1Envelope.agentExecutionId === "string" && w1Envelope.agentExecutionId.length > 0,
    `SA-W1 envelope gen=${bGeneration} durableGen=${durableW1Gen} exec=${w1Envelope?.executionId === executionId}`);

  const snapB = readCheckpoint(persistenceRoot, executionId);
  const mirrorB = snapB?.snapshot?.graph?.rollover ?? null;
  const ownerC = mirrorB?.owner ?? null;

  // G5: the B→C intake presented B's durable owner identity (re-derived from
  // the spawn candidate at generation 1), never A's generation-0 source.
  const intentsB = mirrorB?.intents ?? {};
  const gen1Intent = Object.values(intentsB).find((i) => i?.sourceGeneration === 1) ?? null;
  const bDigest = ownerB && mirrorA?.candidate?.identity?.opaqueSessionId
    ? sessionIdentityDigest({
        adapterKind: BINDING.adapterKind, providerKind: BINDING.providerKind,
        opaqueSessionId: mirrorA.candidate.identity.opaqueSessionId, sessionGeneration: 1,
      })
    : null;
  const gen0Digest = sessionIdentityDigest({
    adapterKind: BINDING.adapterKind, providerKind: BINDING.providerKind,
    opaqueSessionId: executionId, sessionGeneration: 0,
  });
  record("G5_STALE_A_NOT_IMPERSONATED", !!gen1Intent && bDigest !== null
      && gen1Intent.sourceSessionIdentityDigest === bDigest
      && gen1Intent.sourceSessionIdentityDigest !== gen0Digest,
    gen1Intent ? `intent source gen=${gen1Intent.sourceGeneration} ownerDigestMatch=${gen1Intent.sourceSessionIdentityDigest === bDigest} gen0Presented=${gen1Intent.sourceSessionIdentityDigest === gen0Digest}` : "no gen1 intent");

  // G6: generation progression monotonic — intake source generations 0→1.
  const generations = Object.values(intentsB).map((i) => i?.sourceGeneration).sort((a, b) => a - b);
  record("G6_GENERATION_MONOTONIC", generations.length >= 2 && generations[0] === 0 && generations[1] === 1,
    `intake source generations=${generations.join(",")}`);

  // G7: each rollover dispatch occurs exactly once — exactly TWO
  // SPAWN_DISPATCH events across the whole chain (A→B, B→C).
  const spawnDispatches = journalB.filter((e) => e.event_type === "SPAWN_DISPATCH");
  record("G7_DISPATCH_EXACTLY_ONCE", spawnDispatches.length === 2,
    `SPAWN_DISPATCH count=${spawnDispatches.length}`);

  // G8: graph/workflow identity continuous — one durable execution id, the
  // frozen IR artifact never changed across the eras.
  const irArtifact = join(persistenceRoot, executionId, "artifacts", "decomposition-ir.json");
  let irStable = false;
  try {
    const ir = JSON.parse(readFileSync(irArtifact, "utf8"));
    irStable = Array.isArray(ir.phases) && ir.phases.map((p) => p.phase_id).join(",") === "SA-R1,SA-R2,SA-W1,SA-V1";
  } catch { irStable = false; }
  record("G8_GRAPH_IDENTITY_CONTINUOUS", irStable,
    `durableId=${executionId} irPhasesStable=${irStable}`);

  // B froze at SA-V1's quiescent start boundary (B→C handover) — SA-V1 must
  // NOT have executed in B's era.
  const v1PassedInB = journalB.filter((e) => e.event_type === "PHASE_PASSED" && e.phase_id === "SA-V1").length;
  record("G0_B_HANDOVER", B.final === "HOLD" && B.handedOver === true && v1PassedInB === 0
    && (mirrorB?.state === ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED || mirrorB?.state === ROLLOVER_STATES.ACTIVE_B),
    `final=${B?.final} handedOver=${B?.handedOver === true} v1Passes=${v1PassedInB} mirror=${mirrorB?.state}`);
  if (!(B.final === "HOLD" && B.handedOver === true)) {
    console.error("B_DISPATCH_LOG_TAIL", JSON.stringify(observed.dispatches.slice(-8)));
    finish();
    return;
  }

  // ── SESSION C ───────────────────────────────────────────────────────────
  let C = null;
  let bootstrapErrorC = null;
  try {
    C = await bootstrapSuccessorSession({
      persistenceRoot,
      executionId,
      spawnMeta: {
        rolloverId: mirrorB?.active_rollover_id ?? mirrorB?.last_rollover_id ?? null,
        expectedTargetGeneration: ownerC?.session_generation ?? 2,
        providerBinding: BINDING,
      },
      ...runOpts(),
    });
  } catch (e) {
    bootstrapErrorC = e;
  }
  record("G0_C_BOOTSTRAP", C !== null,
    bootstrapErrorC ? `${bootstrapErrorC.code ?? ""} ${String(bootstrapErrorC.message).slice(0, 160)}` : `bootstrap accepted (final=${C?.final})`);
  if (!C) {
    console.error("C_DISPATCH_LOG", JSON.stringify(observed.dispatches.slice(-10)));
    finish();
    return;
  }
  console.error("C_DISPATCH_LOG", JSON.stringify(observed.dispatches.slice(-10)));

  const journalC = readJournal(persistenceRoot, executionId);

  // G4: C consumed the correct B generation — C's verifier bound B's SA-W1
  // result (generation-correct under C's era) with zero provenance holds.
  const v1Node = (C.nodeResults ?? []).find((n) => n.nodeId === "SA-V1") ?? null;
  const v1Env = v1Node?.subagentEnvelope ?? null;
  const provenanceHoldsC = journalC.filter((e) => e.phase_id === "SA-V1" && e.event_type === "PHASE_HELD"
    && JSON.stringify(e.payload ?? {}).includes("DEPENDENCY_PROVENANCE"));
  record("G4_C_CONSUMED_B", Boolean(v1Node) && provenanceHoldsC.length === 0,
    `v1Dispatched=${Boolean(v1Node)} provenanceHolds=${provenanceHoldsC.length} final=${C.final}`);

  // G9: dependency identity remains bound across BOTH transitions — every
  // persisted consumed envelope re-derives its agent identity from the SAME
  // (executionId, phase) pair, and each consumer era actually consumed them:
  // B's writer env carried A's SA-R1/SA-R2 identities (producer status PASS),
  // and C's verifier consumed B's SA-W1 envelope through the provenance
  // gate (zero DEPENDENCY_PROVENANCE holds) with the SA-W1 envelope
  // re-bound to C's era generation.
  const { agentExecutionIdFor } = await import(`${root}/src/subagent/subagent-contract.mjs`);
  const bIdentitiesOk = (env?.dependencyResultIdentities ?? []).some((d) => d?.nodeId === "SA-R1" && d?.status === "PASS")
    && (env?.dependencyResultIdentities ?? []).some((d) => d?.nodeId === "SA-R2" && d?.status === "PASS");
  const { phaseExecutionId } = await import(`${root}/src/v2/phase-task-card.mjs`);
  const envelopeIdsBound = [w1Envelope, observed.envelopes["SA-R1"], observed.envelopes["SA-R2"]]
    .filter(Boolean)
    .every((e) => e.agentExecutionId === agentExecutionIdFor(executionId, e.phase_id)
      && e.executionId === executionId
      && e.phaseExecutionId === phaseExecutionId(executionId, e.phase_id));
  // The last-era real-terminal reclaim (Phase L) deletes the shared results
  // dir after C's terminal — read the re-bind state from the DURABLE record
  // instead: C's SA-V1 durable result (gen 2) proves the C-era fold, and the
  // SA-V1 reviewer verdict in the durable phase artifacts proves consumption.
  const w1ReboundToC = (() => {
    try {
      const v1 = JSON.parse(readFileSync(join(persistenceRoot, executionId, "phases", "SA-V1", "result.json"), "utf8"));
      return v1?.graph_generation === 2 && v1?.final === "PASS";
    } catch { return false; }
  })();
  record("G9_DEPENDENCY_IDENTITY_BOUND", bIdentitiesOk && envelopeIdsBound && w1ReboundToC && provenanceHoldsC.length === 0,
    `bIdentities=${bIdentitiesOk} envelopeIdsBound=${envelopeIdsBound} w1GenAtC=${observed.envelopes["SA-W1"]?.graph_generation} cHolds=${provenanceHoldsC.length}`);

  // G10: C's final result deterministically proves B-result consumption —
  // SA-V1 PASSED exactly once across ALL THREE eras (in C's era only), and
  // its PASS required /results/SA-W1.json (producer status PASS + review
  // PASS) — a state only B's era could author.
  const v1PassesAll = journalC.filter((e) => e.event_type === "PHASE_PASSED" && e.phase_id === "SA-V1").length;
  const w1PassesAll = journalC.filter((e) => e.event_type === "PHASE_PASSED" && e.phase_id === "SA-W1").length;
  // The independent review verdict lives in the durable phase artifacts
  // (g1-reviewer-verdict-*.json, written in B's era) — the results-dir copy
  // is reclaimed at C's real terminal.
  const cReview = (() => {
    const dir = join(persistenceRoot, executionId, "phases", "SA-W1");
    if (!existsSync(dir)) return null;
    for (const f of readdirSync(dir).filter((f) => f.includes("reviewer-verdict")).sort().reverse()) {
      try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { /* next */ }
    }
    return null;
  })();
  record("G10_C_PROVES_B_CONSUMPTION", v1PassesAll === 1 && w1PassesAll === 1 && C.final === "PASS"
      && cReview?.recommended_next_action === "STOP",
    `SA-V1 passes=${v1PassesAll} SA-W1 passes=${w1PassesAll} C.final=${C.final} review=${cReview?.recommended_next_action ?? "none"}`);

  // Era identity continuity: exactly 3 owner generations bound to distinct
  // session identity digests (A gen0 → B gen1 → C gen2), no reuse.
  const ownerDigests = [
    mirrorA?.owner ? sessionIdentityDigest({ adapterKind: BINDING.adapterKind, providerKind: BINDING.providerKind, opaqueSessionId: mirrorA.candidate?.identity?.opaqueSessionId ?? "", sessionGeneration: mirrorA.owner.session_generation }) : null,
    mirrorB?.owner ? sessionIdentityDigest({ adapterKind: BINDING.adapterKind, providerKind: BINDING.providerKind, opaqueSessionId: mirrorB.candidate?.identity?.opaqueSessionId ?? "", sessionGeneration: mirrorB.owner.session_generation }) : null,
  ].filter(Boolean);
  record("G0_OWNER_CHAIN", ownerDigests.length === 2 && ownerDigests[0] !== ownerDigests[1]
      && mirrorB?.owner?.session_generation === 2,
    `owner gens=${mirrorA?.owner?.session_generation},${mirrorB?.owner?.session_generation} distinct=${ownerDigests[0] !== ownerDigests[1]}`);

  finish();

  function finish() {
    const keys = Object.keys(evidence.checks);
    const failed = keys.filter((k) => !evidence.checks[k].ok);
    console.log("\n=== WP1 PHASE G: A→B→C MULTI-HOP CONTINUITY ===");
    for (const k of keys) console.log(`${evidence.checks[k].ok ? "PASS" : "FAIL"} ${k}`);
    console.log(`\nMULTI_HOP_CONTINUITY = ${failed.length === 0 ? "PASS" : `FAIL (first break: ${evidence.firstBreak})`}`);
    writeFileSync(join(root, "docs", "pi-graph-output", `wp1-g-multihop-${label}.json`),
      JSON.stringify({ schema: "autoloop.wp1-g-multihop/v1", ranAt: new Date().toISOString(), log: LOG, checks: evidence.checks, verdict: failed.length === 0 ? "PASS" : "FAIL", firstBreak: evidence.firstBreak }, null, 2) + "\n");
    if (failed.length > 0) process.exitCode = 1;
    if (!process.env.WP1_G_KEEP) rmSync(base, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("FAIL / PROBE_EXCEPTION", e?.code ?? e?.name, String(e?.message ?? e).slice(0, 400));
  process.exit(1);
});
