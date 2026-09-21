// scripts/multi-session-wp1-i-worker.mjs
//
// WP1 PHASE I crash worker — like de2r-subagent-resume-worker.mjs but with a
// ROLLOVER-ENABLED frozen admission (production gate entry) so the automatic
// rollover trigger fires inside the crashed run, and with a "bootstrap"
// mode that continues the graph through bootstrapSuccessorSession.
//
//   node scripts/multi-session-wp1-i-worker.mjs --config <cfg.json>
//
// cfg: {
//   mode: "run" | "resume" | "bootstrap",
//   point, executionId(durable), repoPath, scratchRoot, persistenceRoot,
//   crashOn, crashOnPhase, crashOnCount,
// }

import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = "/Volumes/NVM2T/Development/repos/autoloop";
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null; };
const cfg = JSON.parse(readFileSync(arg("--config"), "utf8"));

const { runSubagentGraphAdmitted } = await import(`${root}/src/admission/admission-gate.mjs`);
const { buildAdmissionRecord } = await import(`${root}/src/admission/policy-projection.mjs`);
const { classify } = await import(`${root}/src/admission/classify.mjs`);
const { validateAdmission, deriveAdmissionId, freezeAdmission } = await import(`${root}/src/admission/admission-record.mjs`);
const { bootstrapSuccessorSession } = await import(`${root}/src/rollover/production-wiring.mjs`);
const { readCheckpoint } = await import(`${root}/src/v2/checkpoint-bridge.mjs`);
const { planOwnedScratchRoot } = await import(`${root}/src/runtime/scratch-ownership.mjs`);
const { createSubagentExecutorAdapter } = await import(`${root}/src/subagent/subagent-executor-adapter.mjs`);
const { createSubagentWriterExecutorAdapter } = await import(`${root}/src/subagent/subagent-writer-executor-adapter.mjs`);
const { createReviewAgentReviewerAdapter } = await import(`${root}/src/subagent/subagent-review-agent.mjs`);
const { createColimaExecutorAdapter } = await import(`${root}/src/runtime/colima-executor-adapter.mjs`);
const { createColimaReviewerAdapter } = await import(`${root}/src/runtime/colima-reviewer-adapter.mjs`);

const PROFILE = "autoloop-graph";
const SCOPE = "docs/pi-graph-output";
const PARENT = { scope: { allowed_paths: [SCOPE], forbidden_paths: [".git"] } };
const BINDING = { adapterKind: "pi-builtin", providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash", requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"] };
const DIMENSIONS = {};
for (const k of ["affected_files", "affected_subsystems", "dependency_depth", "ambiguity", "expected_execution_steps", "verification_burden", "external_dependencies", "concurrency_potential", "statefulness", "rollback_complexity"]) {
  DIMENSIONS[k] = { score: 1, reasons: ["wp1 phase I worker"] };
}

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

function buildAdmission(executionId) {
  const rec = buildAdmissionRecord({
    taskId: `wp1-i-${executionId}`,
    classification: classify({ dimensionScores: DIMENSIONS, riskSignals: [{ signal_id: "wp1_i_worker", class: "MEDIUM", triggered: true, reason: "worker" }] }),
    mutationScope: [SCOPE],
    extensions: {
      rollover: {
        // I10 exercises repeated same-state resume on a PLAIN durable run —
        // no rollover, no provider-backed dispatch (container-only executors).
        enabled: cfg.plain !== true,
        context_occupancy_threshold: 100,
        source_session_id: executionId,
        rsl3_surface_dir: join(cfg.persistenceRoot, executionId, "rsl3"),
        require_echo: false,
        provider_binding: BINDING,
      },
      budget: { dimensions: { wall_clock_ms: { limit: 1800000 }, node_execution_count: { limit: 48 }, verifier_reviewer_attempts: { limit: 24 } } },
    },
  });
  rec.admission_id = deriveAdmissionId(rec);
  const v = validateAdmission(rec);
  if (!v.ok) throw new Error(`worker admission invalid: ${v.errors.join(";")}`);
  return freezeAdmission(rec);
}

function factoriesFor(repoPath, ownedScratchRoot, resultsDir) {
  return {
    executorAdapterFactory: ({ resultSink } = {}) => {
      const roSubagent = createSubagentExecutorAdapter({ profile: PROFILE, repoPath, scratchRoot: ownedScratchRoot, resultsDir, resultSink });
      const writerSubagent = createSubagentWriterExecutorAdapter({ profile: PROFILE, repoPath, scratchRoot: ownedScratchRoot, resultsDir, resultSink, maxRepairAttempts: 0 });
      const roColima = createColimaExecutorAdapter({ profile: PROFILE, repoPath, scratchRoot: ownedScratchRoot, resultSink });
      return () => ({
        runAdapter: async (request) => {
          const rt = request.taskCard?.runtime ?? {};
          if (Array.isArray(rt.dependencyConflicts) && rt.dependencyConflicts.length > 0) {
            return { status: "error", executionId: request.executionId, error: `DEPENDENCY_CONFLICT_HOLD:${rt.dependencyConflicts.length}`, stdout: "", stderr: "", metadata: { dependencyConflicts: rt.dependencyConflicts } };
          }
          return rt.mode === "subagent" && rt.agentRole === "writer"
            ? await writerSubagent.runAdapter(request)
            : rt.mode === "readonly"
              ? await roColima.runAdapter(request)
              : await roSubagent.runAdapter(request);
        },
      });
    },
    reviewerAdapterFactory: () => ({
      runAdapter: async (request) => {
        const rt = request.taskCard?.runtime ?? {};
        if (rt.mode === "readonly") return createColimaReviewerAdapter().runAdapter(request);
        if (rt.agentRole === "writer") return createReviewAgentReviewerAdapter({ profile: PROFILE, repoPath, scratchRoot: ownedScratchRoot, resultsDir }).runAdapter(request);
        return createColimaReviewerAdapter().runAdapter(request);
      },
    }),
  };
}

async function main() {
  mkdirSync(cfg.scratchRoot, { recursive: true });
  mkdirSync(join(cfg.persistenceRoot, cfg.executionId, "rsl3"), { recursive: true });
  // The durable store requires the exec_-form id; a logical id is mapped
  // deterministically (the SAME mapping runSubagentGraph applies when
  // persistence.executionId is omitted) so the crash window and the resume
  // address the SAME store.
  const { durableExecutionIdFor } = await import(`${root}/src/subagent/subagent-graph-runner.mjs`);
  if (!/^exec_[0-9a-f]{32}$/.test(cfg.executionId)) {
    cfg.executionId = durableExecutionIdFor(cfg.executionId);
  }
  const admission = buildAdmission(cfg.executionId);
  const ownedScratchRoot = planOwnedScratchRoot({ scratchRoot: cfg.scratchRoot, executionId: cfg.executionId, repoPath: cfg.repoPath });
  const resultsDir = join(ownedScratchRoot, "results");
  const factories = factoriesFor(cfg.repoPath, ownedScratchRoot, resultsDir);
  const runOpts = () => ({
    admission, ir: IR(), parent: PARENT,
    manifest: [{ requirement_id: "r1", text: "WP1 I crash worker" }],
    cwd: cfg.repoPath, repoPath: cfg.repoPath, scratchRoot: cfg.scratchRoot,
    maxRepairAttempts: 0, timeoutMs: 300000, dirtyScope: [],
    // NO caller factory override: the runner derives THE production sub-agent
    // wiring (provider-backed dispatch + usage authority) from the admission.
    // A caller-supplied executorAdapterFactory would replace it and strip the
    // provider usage — exactly the silent fallback the WP1 contract forbids.
  });

  if (cfg.mode === "run") {
    const result = await runSubagentGraphAdmitted({
      ...runOpts(),
      executionId: cfg.logicalId ?? `wp1-i-${cfg.point}-${Date.now().toString(36)}`,
      persistence: { root: cfg.persistenceRoot, executionId: cfg.executionId },
      hooks: {
        onDurableEvent: async ({ event_type }) => {
          if (!cfg.crashOn) return;
          let hit = event_type === cfg.crashOn;
          // Rollover-seam windows: the intake/mirror events are journaled but
          // NOT forwarded to onDurableEvent — bound the window with a
          // forwarded PHASE_READY plus the DURABLE mirror state read from
          // the checksummed CURRENT (read-only observation, never authority
          // mutation):
          //   I4 "after transfer committed / before successor dispatch":
          //      PHASE_READY while rollover state is post-commit.
          //   I5 "after dispatch request / before boot": PHASE_READY while
          //      post-commit AND a SPAWN_DISPATCH row exists in the journal.
          //   I6 "after successor boot / before dependency consumption":
          //      PHASE_READY while state == ACTIVE_B.
          if (event_type === "PHASE_READY" && (cfg.crashOn === "OWNERSHIP_TRANSFER_COMMITTED" || cfg.crashOn === "SPAWN_DISPATCH" || cfg.crashOn === "ACTIVE_B")) {
            try {
              const snap = readCheckpoint(cfg.persistenceRoot, cfg.executionId);
              const st = snap?.snapshot?.graph?.rollover?.state ?? null;
              if (cfg.crashOn === "ACTIVE_B") {
                hit = st === "ACTIVE_B";
              } else if (st === "OWNERSHIP_TRANSFER_COMMITTED" || st === "ACTIVE_B") {
                if (cfg.crashOn === "SPAWN_DISPATCH") {
                  const jdir = join(cfg.persistenceRoot, cfg.executionId, "journal");
                  hit = existsSync(jdir) && readdirSync(jdir).some((f) => {
                    if (!f.endsWith(".json")) return false;
                    try { return JSON.parse(readFileSync(join(jdir, f), "utf8"))?.event_type === "SPAWN_DISPATCH"; } catch { return false; }
                  });
                } else {
                  hit = true;
                }
              }
            } catch { hit = false; }
          }
          if (hit) {
            cfg._count = (cfg._count ?? 0) + 1;
            if ((cfg.crashOnCount ?? 1) <= cfg._count) {
              console.log(`CRASH_TRIGGERED:${event_type}:${cfg.crashOn}`);
              process.kill(process.pid, "SIGKILL");
            }
          }
        },
      },
    });
    console.log(`RUN_FINAL:${result.final}`);
    process.exit(0);
  }

  if (cfg.mode === "resume") {
    const { resumeSubagentGraph } = await import(`${root}/src/subagent/subagent-graph-runner.mjs`);
    const result = await resumeSubagentGraph({
      parent: PARENT,
      manifest: [{ requirement_id: "r1", text: "WP1 I crash worker resume" }],
      cwd: cfg.repoPath, repoPath: cfg.repoPath, scratchRoot: cfg.scratchRoot,
      maxRepairAttempts: 0, timeoutMs: 300000, dirtyScope: [],
      executionId: cfg.logicalId ?? cfg.executionId,
      persistence: { root: cfg.persistenceRoot, executionId: cfg.executionId },
      admission,
    });
    console.log(`RESUME_FINAL:${result.final}`);
    console.log(`RESUME_REASON:${String(result.reason ?? "").slice(0, 120)}`);
    process.exit(0);
  }

  if (cfg.mode === "bootstrap") {
    const snap = readCheckpoint(cfg.persistenceRoot, cfg.executionId);
    const mirror = snap?.snapshot?.graph?.rollover ?? null;
    const owner = mirror?.owner ?? null;
    const result = await bootstrapSuccessorSession({
      persistenceRoot: cfg.persistenceRoot,
      executionId: cfg.executionId,
      spawnMeta: {
        rolloverId: mirror?.active_rollover_id ?? mirror?.last_rollover_id ?? null,
        expectedTargetGeneration: owner?.session_generation ?? 1,
        providerBinding: BINDING,
      },
      ...runOpts(),
      hooks: {
        ...((runOpts().hooks) ?? {}),
        // crash seam for the SUCCESSOR era (I7: after dependency consumption
        // / before the checkpoint that pins it)
        onDurableEvent: cfg.crashOn
          ? async ({ event_type, phase_id }) => {
              if (event_type === cfg.crashOn && (!cfg.crashOnPhase || phase_id === cfg.crashOnPhase)) {
                cfg._count = (cfg._count ?? 0) + 1;
                if ((cfg.crashOnCount ?? 1) <= cfg._count) {
                  console.log(`CRASH_TRIGGERED:${event_type}:${phase_id ?? "-"}`);
                  process.kill(process.pid, "SIGKILL");
                }
              }
            }
          : undefined,
      },
    });
    console.log(`BOOTSTRAP_FINAL:${result?.final ?? "NONE"}`);
    console.log(`BOOTSTRAP_HANDED:${result?.handedOver === true}`);
    console.log(`BOOTSTRAP_REASON:${String(result?.reason ?? "").slice(0, 120)}`);
    process.exit(0);
  }

  process.exit(2);
}

main().catch((e) => { console.error(`WORKER_ERROR:${e?.code || e?.name || "unknown"}:${(e?.message || "").slice(0, 240)}`); process.exit(1); });
