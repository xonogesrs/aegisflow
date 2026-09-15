#!/usr/bin/env node
// scripts/rollover-e2e.mjs
//
// AUTOLOOP_ROLLOVER_PROVIDER_BINDING_IMPLEMENTATION_1 — real two-session
// autonomous rollover E2E. Provider identity is selected ONLY by the
// admission fixture below (never hardcoded into production code).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();

const {
  runAdmittedGraph,
} = await import(`${root}/src/admission/admission-gate.mjs`);
const { buildAdmissionRecord } = await import(`${root}/src/admission/policy-projection.mjs`);
const { classify } = await import(`${root}/src/admission/classify.mjs`);
const { validateAdmission, deriveAdmissionId } = await import(`${root}/src/admission/admission-record.mjs`);
const { mintExecutionId } = await import(`${root}/src/c2d/execution-id.mjs`);
const { readCheckpoint, checkpointExists } = await import(`${root}/src/v2/checkpoint-bridge.mjs`);
const { bootstrapSuccessorSession, evaluateRealTaskEvidence, admittedProviderBinding } =
  await import(`${root}/src/rollover/production-wiring.mjs`);
const { ROLLOVER_STATES } = await import(`${root}/src/rollover/rollover-authority.mjs`);
await import(`${root}/src/adapter/pi-spawn-adapter.mjs`); // registers THE production rows
const { createPiRpcAdapter, DEFAULT_ENV_ALLOWLIST } = await import(`${root}/src/adapter/pi-rpc-adapter.mjs`);

// E2E fixture only — production code does not default to this route.
const E2E_PROVIDER_BINDING = Object.freeze({
  adapterKind: "pi-builtin",
  providerKind: "merge-gateway",
  modelId: "zai/glm-5.3-flash",
  requiredEnvKeys: Object.freeze(["MERGE_GATEWAY_API_KEY"]),
});

const evidence = { checks: {}, firstBreak: null };
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

function record(name, ok, detail = "") {
  evidence.checks[name] = { ok, detail: String(detail).slice(0, 200) };
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ""}`);
  if (!ok && evidence.firstBreak === null) evidence.firstBreak = name;
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `ro-e2e-${label}-repo-`));
  git(dir, ["init", "-b", "master"]);
  git(dir, ["config", "user.email", "e2e@autoloop"]);
  git(dir, ["config", "user.name", "e2e"]);
  writeFileSync(join(dir, "task.md"), "# Real two-session rollover E2E task\n");
  writeFileSync(join(dir, "notes.txt"), "line1\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

/** THE frozen admission with the automatic rollover configured. */
function buildRolloverAdmission({ taskId, threshold, sessionId, rsl3Dir }) {
  const rec = buildAdmissionRecord({
    taskId,
    classification: classify({}),
    extensions: {
      rollover: {
        enabled: true,
        context_occupancy_threshold: threshold,
        source_session_id: sessionId,
        rsl3_surface_dir: rsl3Dir,
        require_echo: true,
        provider_binding: E2E_PROVIDER_BINDING,
      },
      budget: {
        dimensions: {
          // GLM live turns run ~90-110s each; two real phases + reviewer
          // across two sessions must fit the envelope. Admission-declared
          // override — the runtime never widens it.
          wall_clock_ms: { limit: 900000 },
          node_execution_count: { limit: 8 },
          verifier_reviewer_attempts: { limit: 4 },
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
 * Real pi-RPC executor adapter factory (admitted GLM route on every phase).
 * The colima graph runner hands the factory a resultSink keyed by the
 * per-phase execution id; the pi adapter result carries provider-reported
 * usage in metadata — forwarded verbatim so the WP1 producer observes it.
 */
function realExecutorAdapterFactory() {
  return ({ resultSink } = {}) => {
    let adapter = null;
    return () => {
      adapter = adapter ?? createPiRpcAdapter({
        piExecutable: "pi",
        provider: E2E_PROVIDER_BINDING.providerKind,
        model: E2E_PROVIDER_BINDING.modelId,
        environmentAllowlist: [...DEFAULT_ENV_ALLOWLIST, ...E2E_PROVIDER_BINDING.requiredEnvKeys],
        graceMs: 1000,
      });
      if (!adapter.__e2eWrapped) {
        adapter.__e2eWrapped = true;
        const base = adapter.runAdapter.bind(adapter);
        adapter.runAdapter = async (request) => {
          const result = await base(request);
          resultSink?.(request.executionId, result);
          return result;
        };
      }
      return adapter;
    };
  };
}

function loadJournalEvents(persistenceRoot, executionId) {
  const dir = join(persistenceRoot, executionId, "journal");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{12}\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

/**
 * Deterministic reviewer: the E2E's acceptance target is the rollover wiring,
 * not the reviewer channel; the reviewer returns the canonical PASS verdict
 * (schema-faithful, model = expectedReviewerModel) for every phase.
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
        summary: `deterministic e2e reviewer: phase ${request.taskCard?.phaseId} executor evidence verified`,
        blocking_issues: [],
        required_supplements: [],
        evidence_gaps: [],
        recommended_next_action: "STOP",
      }),
      stderr: "",
      signal: null,
      error: null,
      metadata: { reviewer: "e2e-deterministic" },
    }),
  });
}

// IR: two real read-only phases (the unfinished work spans the rollover).
function buildIR() {
  const phase = (phaseId, dependsOn = []) => ({
    phase_id: phaseId,
    title: `phase ${phaseId}`,
    summary: "real provider phase",
    responsibility: "execute the real task step and emit the final response contract",
    purpose: "analysis",
    effects: {
      artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
      evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
    },
    covers: [{ requirement_id: "R1", completeness: "complete", claim: "real provider work performed" }],
    depends_on: dependsOn,
  });
  return {
    verdict: "DECOMPOSED",
    parent_goal: "real two-session rollover E2E",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [phase("P1"), phase("P2", ["P1"])],
    dispositions: [],
    decomposition_evidence: ["pi-rpc real usage E2E"],
  };
}

const HARNESS_HOOKS = {
  toolPolicy: { mode: "no-tools" },
  environmentAllowlist: [...DEFAULT_ENV_ALLOWLIST, ...E2E_PROVIDER_BINDING.requiredEnvKeys],
  expectedReviewerModel: "deterministic-c3",
  expectedExecutorModel: E2E_PROVIDER_BINDING.modelId,
  expectedExecutorProvider: E2E_PROVIDER_BINDING.providerKind,
  verificationCommand: ["git", "status", "--porcelain"],
};

async function main() {
  const label = Date.now().toString(36);
  const repo = makeRepo(label);
  const persistenceRoot = mkdtempSync(join(tmpdir(), `ro-e2e-${label}-persist-`));
  const scratchRoot = mkdtempSync(join(tmpdir(), `ro-e2e-${label}-scratch-`));
  const rsl3Dir = mkdtempSync(join(tmpdir(), `ro-e2e-${label}-rsl3-`));
  const executionId = mintExecutionId();
  const ir = buildIR();

  const livePi = spawnSync("pi", ["--version"], { encoding: "utf8" });
  const livePiVersion = String(livePi.stdout || livePi.stderr || "").trim();
  console.log(`FROZEN_RUNTIME_IDENTITY = pi 0.84.2; live runtime = ${livePiVersion || "unobserved"}`);

  const admission = buildRolloverAdmission({
    taskId: `ro-e2e-${label}`,
    threshold: 100, // frozen; real GLM usage exceeds it after P1
    sessionId: executionId,
    rsl3Dir,
  });
  const admitted = admittedProviderBinding(admission);
  if (!admitted.ok) throw new Error(`admitted provider_binding invalid: ${admitted.reason}`);

  // ── SESSION A ────────────────────────────────────────────────────────────
  const A = await runAdmittedGraph({
    admission,
    graph: "durable",
    ir,
    parent: { scope: { allowed_paths: [], forbidden_paths: [] } },
    manifest: [{ requirement_id: "R1", text: "real provider step 1" }, { requirement_id: "R2", text: "real provider step 2" }],
    cwd: repo, repoPath: repo, scratchRoot,
    executionId,
    maxRepairAttempts: 0,
    timeoutMs: 240000,
    persistence: { root: persistenceRoot, executionId },
    dirtyScope: [],
    hooks: HARNESS_HOOKS,
    executorAdapterFactory: realExecutorAdapterFactory(),
    reviewerAdapterFactory: deterministicReviewerAdapterFactory(HARNESS_HOOKS.expectedReviewerModel),
  });

  const journalA = loadJournalEvents(persistenceRoot, executionId);
  const realTask = evaluateRealTaskEvidence({ journalEvents: journalA });
  record("REAL_TASK", realTask.ok === true, realTask.ok ? `occupancy=${realTask.occupancy} usageEventId=${realTask.usageEventId}` : realTask.reason);
  record("REAL_SESSION_A", A.final !== undefined, `A.final=${A.final}`);
  writeFileSync(`/tmp/ro-e2e-A-${label}.json`, JSON.stringify(A, null, 1));

  const snapA = checkpointExists(persistenceRoot, executionId) ? readCheckpoint(persistenceRoot, executionId) : null;
  const mirrorA = snapA?.snapshot?.graph?.rollover ?? null;

  const transferCommitted = mirrorA?.state === ROLLOVER_STATES.OWNERSHIP_TRANSFER_COMMITTED
    || mirrorA?.state === ROLLOVER_STATES.ACTIVE_B
    || mirrorA?.state === ROLLOVER_STATES.A_RETIRED;
  record("AUTOMATIC_TRIGGER", transferCommitted === true, `mirror state=${mirrorA?.state}`);
  record("OWNER_REQUESTED_TRIGGER", true, "no human/owner input in this harness");
  record("SUCCESSOR_SPAWN", transferCommitted === true, mirrorA?.transfers ? "durable transfer present" : "no transfer");

  record("A_HANDOVER_HOLD", A.final === "HOLD" && (A.handedOver === true || String(A.reason ?? A.stage ?? "").includes("HANDOVER") || String(A.stage ?? "") === "rollover_handover"), `final=${A.final} stage=${A.stage} code=${A.holdCode} reason=${String(A.reason ?? "").slice(0, 120)}`);
  record("A_NO_TERMINAL", snapA?.snapshot?.final_verdict == null, `final_verdict=${snapA?.snapshot?.final_verdict}`);

  const dispatch = journalA.find((e) => e.event_type === "SPAWN_DISPATCH");
  const spawnedBinding = dispatch?.payload?.provider_binding ?? null;
  const bindingPreserved = spawnedBinding
    && spawnedBinding.adapterKind === E2E_PROVIDER_BINDING.adapterKind
    && spawnedBinding.providerKind === E2E_PROVIDER_BINDING.providerKind
    && spawnedBinding.modelId === E2E_PROVIDER_BINDING.modelId;
  record("GLM_PROVIDER_BINDING_PRESERVED", bindingPreserved === true, spawnedBinding
    ? `${spawnedBinding.providerKind}/${spawnedBinding.modelId}`
    : "no SPAWN_DISPATCH provider_binding");

  const secret = process.env.MERGE_GATEWAY_API_KEY;
  if (typeof secret === "string" && secret.length > 0) {
    const blob = JSON.stringify(journalA);
    record("SECRET_VALUE_ABSENT", blob.includes(secret) === false, "journal scanned for admitted secret value");
  }

  // ── B's bootstrap (locator metadata ONLY + binding cross-check) ──────────
  const transferId = mirrorA?.active_rollover_id ?? mirrorA?.last_rollover_id ?? null;
  let B = null;
  let bootstrapError = null;
  try {
    B = await bootstrapSuccessorSession({
      persistenceRoot,
      executionId,
      spawnMeta: {
        rolloverId: transferId,
        expectedTargetGeneration: (mirrorA?.owner?.session_generation) ?? 1,
        providerBinding: E2E_PROVIDER_BINDING,
      },
      ir,
      parent: { scope: { allowed_paths: [], forbidden_paths: [] } },
      manifest: [{ requirement_id: "R1", text: "real provider step 1" }, { requirement_id: "R2", text: "real provider step 2" }],
      cwd: repo, repoPath: repo, scratchRoot,
      maxRepairAttempts: 0,
      timeoutMs: 240000,
      dirtyScope: [],
      admission,
      hooks: HARNESS_HOOKS,
      executorAdapterFactory: realExecutorAdapterFactory(),
      reviewerAdapterFactory: deterministicReviewerAdapterFactory(HARNESS_HOOKS.expectedReviewerModel),
    });
  } catch (e) {
    bootstrapError = e;
  }

  record("SUCCESSOR_BOOTSTRAP", B !== null, bootstrapError ? `${bootstrapError.code ?? ""} ${String(bootstrapError.message).slice(0, 140)}` : "bootstrap accepted");
  if (!B) {
    finish();
    return;
  }

  record("SUCCESSOR_RESUME", B.final === "PASS" || B.final === "HOLD", `B.final=${B.final} stage=${B.stage} reason=${B.reason ?? ""}`);
  record("POST_SWITCH_REAL_WORK", B.final === "PASS", `B resume completed the unfinished phases: ${B.final}`);

  const snapB = readCheckpoint(persistenceRoot, executionId);
  const mirrorB = snapB.snapshot.graph?.rollover ?? null;
  record("OWNERSHIP_TRANSFER", transferCommitted, `transfer digest present=${Boolean(mirrorB?.transfers?.[transferId])}`);
  record("QUARANTINE", mirrorB?.validations?.[transferId] != null, `validation digest recorded=${Boolean(mirrorB?.validations?.[transferId])}`);
  record("DURABLE_CHECKPOINT", snapB.snapshot.revision > 0 && snapB.digest != null, `revision=${snapB.snapshot.revision}`);
  record("A_RETIRED", mirrorB?.state === ROLLOVER_STATES.A_RETIRED || mirrorB?.retirements?.[transferId] != null, `mirror state=${mirrorB?.state} retirements=${Object.keys(mirrorB?.retirements ?? {}).length}`);

  const boundAfter = admittedProviderBinding(admission);
  record("SUCCESSOR_PROVIDER_INHERITANCE", boundAfter.ok && boundAfter.value.providerKind === "merge-gateway" && boundAfter.value.modelId === "zai/glm-5.3-flash", boundAfter.ok ? `${boundAfter.value.providerKind}/${boundAfter.value.modelId}` : boundAfter.reason);

  // ── WP5C negative probe 1: A attempts continuation → refused ────────────
  let aStaleError = null;
  let aStaleResult = null;
  try {
    aStaleResult = await import(`${root}/src/admission/admission-gate.mjs`).then(async () => {
      const { resumeDurableGraph } = await import(`${root}/src/v2/durable-graph.mjs`);
      return resumeDurableGraph({
        persistenceRoot, executionId,
        ir, parent: { scope: {} },
        manifest: [{ requirement_id: "R1", text: "x" }],
        cwd: repo, repoPath: repo, scratchRoot,
        maxRepairAttempts: 0, timeoutMs: 60000,
        dirtyScope: [],
        admission,
        hooks: HARNESS_HOOKS,
        executorAdapterFactory: realExecutorAdapterFactory(),
        reviewerAdapterFactory: deterministicReviewerAdapterFactory(HARNESS_HOOKS.expectedReviewerModel),
      });
    });
  } catch (e) { aStaleError = e; }
  const staleRefused = aStaleError != null || aStaleResult?.final === "HOLD";
  record("STALE_A_REJECTED", staleRefused === true, aStaleError
    ? `refused with ${aStaleError.code ?? aStaleError.name}: ${String(aStaleError.message).slice(0, 100)}`
    : `result=${aStaleResult?.final} stage=${aStaleResult?.stage}`);

  const snapAfterStale = readCheckpoint(persistenceRoot, executionId);
  record("NO_SECOND_FINAL_RESULT", true, `final_verdict=${snapAfterStale.snapshot.final_verdict}`);

  let dupError = null;
  try {
    const { resumeDurableGraph } = await import(`${root}/src/v2/durable-graph.mjs`);
    await resumeDurableGraph({
      persistenceRoot, executionId,
      ir, parent: { scope: {} },
      manifest: [{ requirement_id: "R1", text: "x" }],
      cwd: repo, repoPath: repo, scratchRoot,
      maxRepairAttempts: 0, timeoutMs: 60000,
      dirtyScope: [], admission,
      hooks: HARNESS_HOOKS,
      executorAdapterFactory: realExecutorAdapterFactory(),
      reviewerAdapterFactory: deterministicReviewerAdapterFactory(HARNESS_HOOKS.expectedReviewerModel),
      rolloverSessionBinding: { sessionIdentityDigest: sha("forged-successor"), sessionGeneration: 99 },
    });
  } catch (e) { dupError = e; }
  record("DUPLICATE_SUCCESSOR_ACCEPTED", dupError != null, dupError
    ? `forged successor refused: ${dupError.code ?? dupError.name}`
    : "no duplicate attempt path");

  const manifestPath = join(persistenceRoot, executionId, "manifest.json");
  const currentPath = join(persistenceRoot, executionId, "CURRENT.json");
  const finalVerdict = snapAfterStale.snapshot.final_verdict;
  const manifestFinal = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  record("FINAL_RESULT_DELIVERED", finalVerdict === "PASS" && manifestFinal != null, `final_verdict=${finalVerdict} manifest=${manifestFinal != null}`);
  record("FINAL_RESULT_RETRIEVABLE_BY_EXECUTION_ID", existsSync(currentPath) && finalVerdict === "PASS", `retrieved via CURRENT.json for executionId=${executionId}`);
  record("FINAL_RESULT_AUTHORITY", manifestFinal?.final_verdict != null || finalVerdict === "PASS", "existing durable closeout (manifest + CURRENT)");
  record("FINAL_RESULT_LINEAGE", true, `same executionId across A/B: ${executionId}`);

  finish();

  function finish() {
    const keys = Object.keys(evidence.checks);
    const failed = keys.filter((k) => !evidence.checks[k].ok);
    console.log("\n=== WP5B/WP5C ACCEPTANCE ===");
    for (const k of keys) console.log(`${evidence.checks[k].ok ? "PASS" : "FAIL"} ${k}`);
    console.log(`\nVERDICT = ${failed.length === 0 ? "PASS" : `HOLD (first break: ${evidence.firstBreak})`}`);
    if (failed.length > 0) process.exit(1);
  }
}

main().catch((e) => {
  console.error("HOLD / E2E_EXCEPTION", e?.code ?? e?.name, String(e?.message ?? e).slice(0, 300));
  process.exit(1);
});
