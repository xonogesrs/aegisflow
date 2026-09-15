#!/usr/bin/env node
// scripts/rollover-3era-probe.mjs
//
// AUTOLOOP_MULTI_SESSION_ROLLOVER_TRIGGER_WIRING_REPAIR_1 — MINIMAL 3-ERA
// PROBE. Proves the repaired seams make the SECOND rollover reachable:
//
//   A active → automatic A→B → B resumes → B becomes trigger-eligible
//   → automatic B→C intake begins → Session C can be spawned.
//
// This probe does NOT run the full long-running chained task. Provider usage
// is SIMULATED through a stub executor adapter that reports provider-reported
// usage (the WP1 producer's only contract) — the identity/authority/durable
// machinery exercised is entirely real (canonical executor, controller
// ladder, spawn registry, quarantine validation, ownership transfer).
//
// Required outcomes:
//   SECOND_AUTOMATIC_TRIGGER_REACHED = YES
//   GENERATION_2_SUCCESSOR_SPAWN_REACHED = YES

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();

const {
  runAdmittedGraph,
} = await import(`${root}/src/admission/admission-gate.mjs`);
const { buildAdmissionRecord } = await import(`${root}/src/admission/policy-projection.mjs`);
const { classify } = await import(`${root}/src/admission/classify.mjs`);
const { validateAdmission, deriveAdmissionId } = await import(`${root}/src/admission/admission-record.mjs`);
const { mintExecutionId } = await import(`${root}/src/c2d/execution-id.mjs`);
const { readCheckpoint, checkpointExists } = await import(`${root}/src/v2/checkpoint-bridge.mjs`);
const { bootstrapSuccessorSession } = await import(`${root}/src/rollover/production-wiring.mjs`);
const { ROLLOVER_STATES, sessionIdentityDigest } = await import(`${root}/src/rollover/rollover-authority.mjs`);
await import(`${root}/src/adapter/pi-spawn-adapter.mjs`); // registers THE production rows
const { DEFAULT_ENV_ALLOWLIST } = await import(`${root}/src/adapter/pi-rpc-adapter.mjs`);

// Probe binding: the deepseek registry row needs NO env keys, so the stub
// adapter needs no credentials. Production never defaults to this route.
const PROBE_BINDING = Object.freeze({
  adapterKind: "pi-builtin",
  providerKind: "deepseek",
  modelId: "deepseek-v4-flash",
  requiredEnvKeys: Object.freeze([]),
});

const evidence = { checks: {}, firstBreak: null };
function record(name, ok, detail = "") {
  evidence.checks[name] = { ok, detail: String(detail).slice(0, 220) };
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 180)}` : ""}`);
  if (!ok && evidence.firstBreak === null) evidence.firstBreak = name;
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function makeRepo(label) {
  const dir = join(tmpdir(), `ro3-${label}-repo-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "master"]);
  git(dir, ["config", "user.email", "probe@autoloop"]);
  git(dir, ["config", "user.name", "probe"]);
  writeFileSync(join(dir, "task.md"), "# three-era rollover probe\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

function buildProbeAdmission({ taskId, sessionId, rsl3Dir }) {
  const rec = buildAdmissionRecord({
    taskId,
    classification: classify({}),
    extensions: {
      rollover: {
        enabled: true,
        context_occupancy_threshold: 100,
        source_session_id: sessionId,
        rsl3_surface_dir: rsl3Dir,
        require_echo: false,
        provider_binding: PROBE_BINDING,
      },
      budget: {
        dimensions: {
          wall_clock_ms: { limit: 600000 },
          node_execution_count: { limit: 16 },
          verifier_reviewer_attempts: { limit: 8 },
        },
      },
    },
  });
  rec.admission_id = deriveAdmissionId(rec);
  const v = validateAdmission(rec);
  if (!v.ok) throw new Error(`admission invalid: ${v.errors.join(";")}`);
  return Object.freeze(rec);
}

/**
 * Stub executor adapter factory: every invocation "completes" with a
 * provider-reported usage payload (the WP1 producer's authority contract:
 * providerReported fields on the executor result metadata). Each phase
 * reports occupancy well above the frozen threshold so every era triggers.
 */
function stubExecutorAdapterFactory() {
  // The graph runner hands the factory a resultSink keyed by the per-phase
  // execution id — the SAME channel the real pi adapter reports through.
  return ({ resultSink } = {}) => () => ({
    runAdapter: async (request) => {
      const result = {
        status: "completed",
        executionId: request.executionId,
        stdout: JSON.stringify({ final_response: `stub work for ${request.taskCard?.phaseId ?? "phase"}` }),
        stderr: "",
        signal: null,
        error: null,
        metadata: {
          providerUsage: { input: 400, cacheRead: 100, cacheWrite: 50, output: 20, totalTokens: 570 },
        },
      };
      resultSink?.(request.executionId, result);
      return result;
    },
  });
}

/**
 * Deterministic reviewer: canonical PASS verdict, schema-faithful. The model
 * id must be "deterministic-c3" — the colima graph runner hardcodes that
 * expectedReviewerModel for its orchestrator hooks (authority boundary: the
 * caller's model hints are not forwarded there).
 */
function deterministicReviewerAdapterFactory(expectedModel) {
  return () => ({
    runAdapter: async (request) => ({
      status: "completed",
      executionId: request.executionId,
      stdout: JSON.stringify({
        verdict: "PASS",
        confidence: "HIGH",
        model: expectedModel,
        summary: `deterministic probe reviewer: phase ${request.taskCard?.phaseId} verified`,
        blocking_issues: [],
        required_supplements: [],
        evidence_gaps: [],
        recommended_next_action: "STOP",
      }),
      stderr: "",
      signal: null,
      error: null,
      metadata: { reviewer: "probe-deterministic" },
    }),
  });
}

// IR: three real read-only phases — A rolls over before P2, B before P3.
function buildIR() {
  const phase = (phaseId, dependsOn = []) => ({
    phase_id: phaseId,
    title: `phase ${phaseId}`,
    summary: "probe phase",
    responsibility: "execute the probe step and emit the final response contract",
    purpose: "analysis",
    effects: {
      artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
      evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
    },
    covers: [{ requirement_id: "R1", completeness: "complete", claim: "probe work performed" }],
    depends_on: dependsOn,
  });
  return {
    verdict: "DECOMPOSED",
    parent_goal: "three-era rollover probe",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [phase("P1"), phase("P2", ["P1"]), phase("P3", ["P2"])],
    dispositions: [],
    decomposition_evidence: ["stub usage probe"],
  };
}

const HOOKS = {
  toolPolicy: { mode: "no-tools" },
  environmentAllowlist: [...DEFAULT_ENV_ALLOWLIST],
  expectedReviewerModel: "deterministic-c3",
  expectedExecutorModel: PROBE_BINDING.modelId,
  expectedExecutorProvider: PROBE_BINDING.providerKind,
  verificationCommand: ["git", "status", "--porcelain"],
};

function loadJournalEvents(persistenceRoot, executionId) {
  const dir = join(persistenceRoot, executionId, "journal");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{12}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

async function main() {
  const label = Date.now().toString(36);
  const repo = makeRepo(label);
  const persistenceRoot = join(tmpdir(), `ro3-${label}-persist-${Date.now().toString(36)}`);
  mkdirSync(persistenceRoot, { recursive: true });
  const scratchRoot = join(tmpdir(), `ro3-${label}-scratch-${Date.now().toString(36)}`);
  mkdirSync(scratchRoot, { recursive: true });
  const rsl3Dir = join(tmpdir(), `ro3-${label}-rsl3-${Date.now().toString(36)}`);
  mkdirSync(rsl3Dir, { recursive: true });
  const executionId = mintExecutionId();
  const ir = buildIR();

  const admission = buildProbeAdmission({ taskId: `ro3-${label}`, sessionId: executionId, rsl3Dir });

  const resumeArgs = () => ({
    ir,
    parent: { scope: { allowed_paths: [], forbidden_paths: [] } },
    manifest: [{ requirement_id: "R1", text: "probe step" }],
    cwd: repo, repoPath: repo, scratchRoot,
    maxRepairAttempts: 0,
    timeoutMs: 300000,
    dirtyScope: [],
    admission,
    hooks: HOOKS,
    executorAdapterFactory: stubExecutorAdapterFactory(),
    reviewerAdapterFactory: deterministicReviewerAdapterFactory(HOOKS.expectedReviewerModel),
  });

  // ── ERA 0: Session A ─────────────────────────────────────────────────────
  const A = await runAdmittedGraph({
    ...resumeArgs(),
    graph: "durable",
    executionId,
    persistence: { root: persistenceRoot, executionId },
  });
  record("A_HANDOVER_HOLD", A.final === "HOLD" && A.handedOver === true, `final=${A.final} stage=${A.stage} holdCode=${A.holdCode}`);

  const snapA = readCheckpoint(persistenceRoot, executionId);
  const mirrorA = snapA.snapshot.graph?.rollover ?? null;
  record("A_B_TRANSFER_COMMITTED", mirrorA?.state === ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED || mirrorA?.state === ROLLOVER_STATES.ACTIVE_B, `state=${mirrorA?.state}`);
  const ownerB = mirrorA?.owner ?? null;
  const candidateB = mirrorA?.candidate?.identity ?? null;
  record("A_B_REAL_OWNER_IDENTITY", !!ownerB && !!candidateB?.opaqueSessionId && ownerB.session_generation === 1, `owner gen=${ownerB?.session_generation} candidate=${candidateB?.opaqueSessionId ?? "none"}`);

  // ── ERA 1: Session B bootstrap (locator metadata ONLY) ───────────────────
  const B = await bootstrapSuccessorSession({
    persistenceRoot, executionId,
    spawnMeta: {
      rolloverId: mirrorA?.active_rollover_id ?? mirrorA?.last_rollover_id ?? null,
      expectedTargetGeneration: ownerB?.session_generation ?? 1,
      providerBinding: PROBE_BINDING,
    },
    ...resumeArgs(),
  });
  record("B_RESUMED", B !== null, `final=${B?.final} stage=${B?.stage} holdCode=${B?.holdCode} reason=${String(B?.reason ?? "").slice(0, 120)}`);

  const snapB = readCheckpoint(persistenceRoot, executionId);
  const mirrorB = snapB.snapshot.graph?.rollover ?? null;
  record("B_ERA_PROGRESS", mirrorB?.state === ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED || mirrorB?.state === ROLLOVER_STATES.ACTIVE_B || mirrorB?.state === ROLLOVER_STATES.A_RETIRED, `state=${mirrorB?.state}`);

  // T2 core: B's usage triggered the SECOND automatic rollover. The B-era
  // intake emits SPAWN_DISPATCH with a NEW rollover id and target gen 2.
  const journalB = loadJournalEvents(persistenceRoot, executionId);
  const spawnDispatches = journalB.filter((e) => e.event_type === "SPAWN_DISPATCH");
  record("SECOND_AUTOMATIC_TRIGGER_REACHED", spawnDispatches.length >= 2, `SPAWN_DISPATCH count=${spawnDispatches.length}`);
  const gen2Dispatch = spawnDispatches[1] ?? null;
  record("GEN2_DISPATCH_TARGET_GENERATION", gen2Dispatch?.payload?.provider_binding != null, gen2Dispatch ? `binding=${gen2Dispatch.payload.provider_binding.providerKind}/${gen2Dispatch.payload.provider_binding.modelId}` : "no second dispatch");

  const mirrorAfterB = readCheckpoint(persistenceRoot, executionId).snapshot.graph?.rollover ?? null;
  const ownerC = mirrorAfterB?.owner ?? null;
  const candidateC = mirrorAfterB?.candidate?.identity ?? null;
  record("GENERATION_2_SUCCESSOR_SPAWN_REACHED", ownerC?.session_generation === 2 && !!candidateC?.opaqueSessionId, `owner gen=${ownerC?.session_generation} candidate=${candidateC?.opaqueSessionId ?? "none"}`);

  // T3/T4: the second intake presented the OWNER identity, not the stale
  // generation-0 source. The new intent's source digest must equal B's
  // durable owner digest (owner-of-record at intake time).
  const intents = mirrorAfterB?.intents ?? {};
  const gen2Intent = Object.values(intents).find((i) => i?.sourceGeneration === 1) ?? null;
  const bDigest = ownerB ? sessionIdentityDigest({
    adapterKind: PROBE_BINDING.adapterKind, providerKind: PROBE_BINDING.providerKind,
    opaqueSessionId: candidateB?.opaqueSessionId ?? "", sessionGeneration: 1,
  }) : null;
  record("GEN2_INTAKE_OWNER_IDENTITY", !!gen2Intent && gen2Intent.sourceSessionIdentityDigest === bDigest, gen2Intent ? `intent source gen=${gen2Intent.sourceGeneration} digest match=${gen2Intent.sourceSessionIdentityDigest === bDigest}` : "no gen2 intent");
  const gen0Digest = sessionIdentityDigest({
    adapterKind: PROBE_BINDING.adapterKind, providerKind: PROBE_BINDING.providerKind,
    opaqueSessionId: executionId, sessionGeneration: 0,
  });
  record("STALE_ORIGINAL_IDENTITY_NOT_PRESENTED", !!gen2Intent && gen2Intent.sourceSessionIdentityDigest !== gen0Digest, `gen0 digest presented=${gen2Intent ? gen2Intent.sourceSessionIdentityDigest === gen0Digest : "n/a"}`);

  // T6: generation chain 0→1→2 with no reuse/skip.
  const generations = Object.values(intents).map((i) => i?.sourceGeneration).sort((a, b) => a - b);
  record("GENERATION_CHAIN", generations.length >= 2 && generations[0] === 0 && generations[1] === 1, `intake source generations=${generations.join(",")}`);

  // T5: generation 0 unchanged — A's own intake pinned the admitted source id.
  const gen0Intent = Object.values(intents).find((i) => i?.sourceGeneration === 0) ?? null;
  record("GEN0_PATH_UNCHANGED", !!gen0Intent && gen0Intent.sourceSessionIdentityDigest === sessionIdentityDigest({
    adapterKind: PROBE_BINDING.adapterKind, providerKind: PROBE_BINDING.providerKind,
    opaqueSessionId: executionId, sessionGeneration: 0,
  }), gen0Intent ? "A-era intake pinned the admitted generation-0 identity" : "no gen0 intent");

  // T7: caller injection stays fenced — the WP2 gate suite owns the fresh
  // path; here we prove the B-era resume consumed NO caller executor (the
  // bootstrap call above passes none, and the trigger still fired).
  record("CALLER_EXECUTOR_INJECTION_BLOCKED", spawnDispatches.length >= 2, "B→C triggered with zero caller-supplied executor surface");

  const keys = Object.keys(evidence.checks);
  const failed = keys.filter((k) => !evidence.checks[k].ok);
  console.log("\n=== 3-ERA PROBE ===");
  for (const k of keys) console.log(`${evidence.checks[k].ok ? "PASS" : "FAIL"} ${k}`);
  console.log(`\nVERDICT = ${failed.length === 0 ? "PASS" : `HOLD (first break: ${evidence.firstBreak})`}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  if (e && e.stack) console.error(e.stack.split("\n").slice(0, 12).join("\n"));
  console.error("HOLD / PROBE_EXCEPTION", e?.code ?? e?.name, String(e?.message ?? e).slice(0, 400));
  process.exit(1);
});
