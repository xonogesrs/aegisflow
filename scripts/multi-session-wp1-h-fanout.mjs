#!/usr/bin/env node
// scripts/multi-session-wp1-h-fanout.mjs
//
// AUTOLOOP_WP1_MULTI_SESSION_CONTINUITY — PHASE H: PARALLEL FAN-OUT /
// FAN-IN E2E over the canonical sub-agent graph (production entries ONLY).
//
// Graph: SA-R1 ‖ SA-R2 ‖ SA-R3 → SA-W1 (consumes ALL THREE) → SA-V1.
// Each B-child produces a distinct authoritative persisted output (authored-
// result provenance envelope); SA-W1 requires and actually consumes
// SA-R1+SA-R2+SA-R3; SA-V1 independently verifies SA-W1.
//
// Deterministic consumption proof: SA-W1's writer command incorporates EACH
// child's claim into /work/<scope>/summary.md and its self-test fails unless
// ALL THREE claim lines are present; the independent review agent re-checks
// the dependency results and the summary content; SA-V1 verifies the writer.
// A C output (the final graph verdict + SA-W1 summary content) cannot be
// correct without all three child results.
//
// Matrix (each scenario = one full production run on a fresh fixture):
//   H1  all complete, normal order            → PASS; three distinct envelopes
//   H2  all complete, different completion    → PASS; ordering never becomes
//       order (staggered AGENT_SLEEP)            authority
//   H3  one delayed child                     → PASS; join waits, no ordering
//                                                authority
//   H4  one missing required child            → FAIL CLOSED (writer never
//                                                runs; DEPS_MISSING family)
//   H5  stale child generation                → FAIL CLOSED (DEPENDENCY_
//                                                GENERATION_STALE provenance)
//   H6  forged child provenance               → FAIL CLOSED (identity does not
//                                                re-derive)
//   H7  duplicate child result                → FAIL CLOSED (CEDF DUPLICATE_
//                                                CLAIM on conflicting claims)
//   H8  conflicting child result              → FAIL CLOSED (CEDF CONFLICT)
//   H9  mixed repairer/base identities where  → PASS (stage-scoped repairer
//       legitimately produced                   identity accepted by the
//                                               provenance verifier)
//   H10 rollover/restart between fan-out and  → PASS (surviving results are
//       fan-in                                   re-bound through the fold
//                                                gate and consumed)
//
// Required: valid complete set => continue; missing/stale/forged/conflicting
// required dependency => fail closed. PARALLEL_CONTINUITY = PASS.
// Ordering must never become authority.
//
// Run: COLIMA_HOME=/Volumes/NVM2T/Development/runtime/colima \
//        node scripts/multi-session-wp1-h-fanout.mjs [scenario...]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const HOME = homedir();
const LOG = mkdtempSync(join(tmpdir(), "wp1-h-log-")) + "/probe.log";
const log = (line) => appendFileSync(LOG, line + "\n");

const { runSubagentGraphAdmitted } = await import(`${root}/src/admission/admission-gate.mjs`);
const { buildAdmissionRecord } = await import(`${root}/src/admission/policy-projection.mjs`);
const { classify } = await import(`${root}/src/admission/classify.mjs`);
const { validateAdmission, deriveAdmissionId, freezeAdmission } = await import(`${root}/src/admission/admission-record.mjs`);
const { mintExecutionId } = await import(`${root}/src/c2d/execution-id.mjs`);
const { planOwnedScratchRoot } = await import(`${root}/src/runtime/scratch-ownership.mjs`);
const { AUTHORED_RESULT_SCHEMA, verifyAuthoredResultProvenance } = await import(`${root}/src/subagent/subagent-graph-runner.mjs`);
const { DEFAULT_ENV_ALLOWLIST } = await import(`${root}/src/adapter/pi-rpc-adapter.mjs`);
const { createSubagentExecutorAdapter } = await import(`${root}/src/subagent/subagent-executor-adapter.mjs`);
const { createSubagentWriterExecutorAdapter } = await import(`${root}/src/subagent/subagent-writer-executor-adapter.mjs`);
const { createReviewAgentReviewerAdapter } = await import(`${root}/src/subagent/subagent-review-agent.mjs`);
const { createColimaExecutorAdapter } = await import(`${root}/src/runtime/colima-executor-adapter.mjs`);
const { createColimaReviewerAdapter } = await import(`${root}/src/runtime/colima-reviewer-adapter.mjs`);
const { agentExecutionIdFor, stageAgentExecutionId } = await import(`${root}/src/subagent/subagent-contract.mjs`);
const { phaseExecutionId } = await import(`${root}/src/v2/phase-task-card.mjs`);

const BINDING = { adapterKind: "pi-builtin", providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash", requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"] };
const SCOPE = "docs/pi-graph-output";
const PARENT = { scope: { allowed_paths: [SCOPE], forbidden_paths: [".git"] } };
const DIMENSIONS = {};
for (const k of ["affected_files", "affected_subsystems", "dependency_depth", "ambiguity", "expected_execution_steps", "verification_burden", "external_dependencies", "concurrency_potential", "statefulness", "rollback_complexity"]) {
  DIMENSIONS[k] = { score: 1, reasons: ["wp1 phase H probe fixture"] };
}

// ── graph builders ─────────────────────────────────────────────────────────
function saReadonlyPhase(phaseId, taskType, sleep = 1) {
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
      sleep,
      agentRole: "readonly-analyst",
    },
  };
}
function saWriterPhase(dependsOn = ["SA-R1", "SA-R2", "SA-R3"]) {
  return {
    phase_id: "SA-W1",
    depends_on: dependsOn,
    effects: { artifact_mutation: "required", boundaries: { artifact: [SCOPE] } },
    runtime: {
      mode: "subagent",
      agentRole: "writer",
      taskType: "write_report",
      objective: `writer write_report over /work/${SCOPE} using ALL dependency results`,
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
const fanoutIR = () => ({
  verdict: "PASS",
  phases: [saReadonlyPhase("SA-R1", "count_todos"), saReadonlyPhase("SA-R2", "inventory_markdown"), saReadonlyPhase("SA-R3", "count_todos"), saWriterPhase(), saVerifierPhase()],
  dispositions: [],
});

// ── fixture ────────────────────────────────────────────────────────────────
function makeBase(label) {
  const base = join(HOME, ".wp1-h-probe", `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
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
function canonicalResultsDir(scratchRoot, durableId, repoPath) {
  const ownedRoot = planOwnedScratchRoot({ scratchRoot, executionId: durableId, repoPath });
  return join(ownedRoot, "results");
}

// THE production sub-agent adapter wiring (same composition as the runner).
function subagentAdapterFactories({ repoPath, scratchRoot, resultsDir, maxRepairAttempts, admission }) {
  return {
    executorAdapterFactory: ({ resultSink } = {}) => {
      const roSubagent = createSubagentExecutorAdapter({ profile: "autoloop-graph", repoPath, scratchRoot, resultsDir, resultSink });
      const writerSubagent = createSubagentWriterExecutorAdapter({ profile: "autoloop-graph", repoPath, scratchRoot, resultsDir, resultSink, maxRepairAttempts });
      const roColima = createColimaExecutorAdapter({ profile: "autoloop-graph", repoPath, scratchRoot, resultSink });
      return () => ({
        runAdapter: async (request) => {
          const rt = request.taskCard?.runtime ?? {};
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
        if (rt.agentRole === "writer") {
          return createReviewAgentReviewerAdapter({ profile: "autoloop-graph", repoPath, scratchRoot, resultsDir }).runAdapter(request);
        }
        return createColimaReviewerAdapter().runAdapter(request);
      },
    }),
  };
}

function buildAdmission(taskId, rsl3Dir) {
  const rec = buildAdmissionRecord({
    taskId,
    classification: classify({ dimensionScores: DIMENSIONS, riskSignals: [{ signal_id: "wp1_h_probe_subagent_work", class: "MEDIUM", triggered: true, reason: "probe fixture exercises sub-agent execution" }] }),
    mutationScope: [SCOPE],
    extensions: {
      rollover: { enabled: false, provider_binding: BINDING },
      budget: {
        dimensions: {
          wall_clock_ms: { limit: 1200000 },
          node_execution_count: { limit: 32 },
          verifier_reviewer_attempts: { limit: 16 },
        },
      },
    },
  });
  rec.admission_id = deriveAdmissionId(rec);
  const v = validateAdmission(rec);
  if (!v.ok) throw new Error(`H admission invalid: ${v.errors.join(";")}`);
  return freezeAdmission(rec);
}

// ── scenario helpers ───────────────────────────────────────────────────────
// Sleep overrides per phase (H2/H3 stagger) ride the phase runtime.sleep —
// the same field the production adapter forwards as AGENT_SLEEP.
function irWithSleeps(sleeps) {
  const ir = fanoutIR();
  for (const p of ir.phases) {
    if (sleeps[p.phase_id] !== undefined) p.runtime.sleep = sleeps[p.phase_id];
  }
  return ir;
}

// H4: drop one required child from the writer's depends_on is NOT the
// scenario — the scenario is the child result FILE missing at fan-in while
// the dependency is still declared (a lost persisted artifact). We simulate
// by deleting SA-R2.json after the children complete, through the era hook.
// H5/H6/H7/H8: tamper with a child envelope file after completion, before
// the writer starts (era onPhaseStart hook fires per phase — the tamper runs
// at the SA-W1 boundary BEFORE the production hook binds dependencies...
// actually the production hook binds at onPhaseStart; the tamper must happen
// BEFORE that. The durable layer's onPhaseStart runs first, then the caller's.
// So tampering inside the caller hook is TOO LATE for provenance verification
// (it runs in the production hook) — but the CEDF reconciliation + the
// writer's claim() read happen in the ADAPTER, after both hooks. The
// provenance gate is the first consumer. To exercise it, tamper must land
// before the production onPhaseStart. The production onPhaseStart fires at
// the SA-W1 boundary; the PREVIOUS boundary is the last child's terminal.
// The caller's onPhaseTerminal of the last child runs BEFORE the SA-W1
// onPhaseStart — tamper there.
function tamperApply(resultsDir, target, mutate) {
  const p = join(resultsDir, target);
  if (!existsSync(p)) return;
  let raw = null;
  try { raw = JSON.parse(readFileSync(p, "utf8")); } catch { return; }
  const next = mutate(raw);
  if (next !== undefined) writeFileSync(p, JSON.stringify(next, null, 2) + "\n");
}

async function runScenario(name) {
  const checks = [];
  const record = (k, ok, detail = "") => {
    checks.push({ k, ok, detail: String(detail).slice(0, 220) });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}.${k}${detail ? ` — ${String(detail).slice(0, 180)}` : ""}`);
    log(`${ok ? "PASS" : "FAIL"}  ${name}.${k}${detail ? ` — ${String(detail).slice(0, 180)}` : ""}`);
  };

  const label = `${name}-${Date.now().toString(36)}`;
  const base = makeBase(label);
  const repo = makeRepo(base);
  const scratchRoot = join(base, "scratch");
  const persistenceRoot = join(base, "persist");
  const executionId = mintExecutionId();
  const admission = buildAdmission(`wp1-h-${label}`, join(base, "rsl3"));
  const resultsDir = canonicalResultsDir(scratchRoot, executionId, repo);
  const ownedScratchRoot = planOwnedScratchRoot({ scratchRoot, executionId, repoPath: repo });
  const factories = subagentAdapterFactories({ repoPath: repo, scratchRoot: ownedScratchRoot, resultsDir, maxRepairAttempts: 0, admission });

  let sleeps = {};
  let terminalHook = null;
  let expectFinal = "PASS";
  // Children finish in completion order; the tamper must run at the LAST
  // child terminal (after ALL THREE envelopes are persisted), never at a
  // fixed phase id.
  const seenChildren = new Set();
  const lastChildHook = (act) => (phaseId) => {
    if (!/^SA-R[123]$/.test(phaseId ?? "")) return;
    seenChildren.add(phaseId);
    if (seenChildren.size < 3) return;
    act();
  };
  if (name === "H2") sleeps = { "SA-R1": 1, "SA-R2": 4, "SA-R3": 7 };
  if (name === "H3") sleeps = { "SA-R1": 1, "SA-R2": 1, "SA-R3": 9 };
  if (name === "H4") {
    // delete SA-R2.json after ALL children complete (before SA-W1 binds)
    terminalHook = lastChildHook(() => {
      try { rmSync(join(resultsDir, "SA-R2.json"), { force: true }); } catch { /* best effort */ }
    });
  }
  if (name === "H5") {
    // stale generation: rewrite SA-R2's envelope with graph_generation 99
    terminalHook = lastChildHook(() => tamperApply(resultsDir, "SA-R2.json", (raw) => ({ ...raw, graph_generation: 99 })));
  }
  if (name === "H6") {
    // forged identity: agentExecutionId that cannot re-derive
    terminalHook = lastChildHook(() => tamperApply(resultsDir, "SA-R2.json", (raw) => ({ ...raw, agentExecutionId: "agent_forged000000000" })));
  }
  if (name === "H7") {
    // duplicate claim: SA-R3 copies SA-R2's claim text (DUPLICATE_CLAIM)
    terminalHook = lastChildHook(() => {
      // Same requirement subject claimed COMPLETE by two non-join children
      // -> DUPLICATE_CLAIM. The subject is injected into BOTH envelopes
      // (readonly children carry no covers/filesChanged of their own).
      const subject = "R-DUP";
      for (const id of ["SA-R2", "SA-R3"]) {
        tamperApply(resultsDir, `${id}.json`, (raw) => raw?.result
          ? { ...raw, result: { ...raw.result, covers: [{ requirement_id: subject, completeness: "complete", claim: "duplicated subject" }] } }
          : undefined);
      }
    });
  }
  if (name === "H8") {
    // conflicting claim: SA-R3 asserts the OPPOSITE of SA-R2's claim
    terminalHook = lastChildHook(() => {
      // Same requirement subject, contradictory outcomes (SA-R2 PASS vs
      // SA-R3 HOLD) -> CONTRADICTORY_OUTCOME.
      const subject = "R-CONF";
      tamperApply(resultsDir, "SA-R2.json", (raw) => raw?.result
        ? { ...raw, result: { ...raw.result, covers: [{ requirement_id: subject, completeness: "complete", claim: "conflicting subject" }] } }
        : undefined);
      tamperApply(resultsDir, "SA-R3.json", (raw) => raw?.result
        ? { ...raw, result: { ...raw.result, status: "HOLD", covers: [{ requirement_id: subject, completeness: "complete", claim: "conflicting subject" }] } }
        : undefined);
    });
  }
  if (name === "H9") {
    // mixed repairer/base identities: rewrite SA-R2's identity to the
    // STAGE-scoped repairer identity (legitimately producible by the bounded
    // repair loop) — the provenance verifier accepts it.
    terminalHook = lastChildHook(() => tamperApply(resultsDir, "SA-R2.json", (raw) => ({ ...raw, agentExecutionId: stageAgentExecutionId(executionId, "SA-R2", "repairer") })));
  }
  if (["H4", "H5", "H6", "H7", "H8"].includes(name)) expectFinal = "HOLD";

  let result = null;
  let error = null;
  try {
    result = await runSubagentGraphAdmitted({
      admission,
      ir: irWithSleeps(sleeps),
      parent: PARENT,
      manifest: [{ requirement_id: "r1", text: `WP1 H fan-out probe (${name})` }],
      cwd: repo, repoPath: repo, scratchRoot,
      executionId: `wp1-h-${label}`,
      maxRepairAttempts: 0,
      timeoutMs: 300000,
      persistence: { root: persistenceRoot, executionId },
      dirtyScope: [],
      ...factories,
      hooks: {
        onPhaseStart: (phaseId) => {
          const files = existsSync(resultsDir) ? readdirSync(resultsDir).filter((f) => f.endsWith(".json")).sort() : [];
          console.error(`FILES ${name} ${phaseId} [${files.join(",")}]`);
        },
        ...(terminalHook ? { onPhaseTerminal: terminalHook } : {}),
      },
    });
  } catch (e) {
    error = e;
  }

  const final = result?.final ?? (error ? `EXCEPTION:${error.code ?? error.name}` : "NONE");
  record("RUN", final === expectFinal, `final=${final}${result?.holdCode ? ` holdCode=${result.holdCode}` : ""}${error ? ` err=${String(error.message).slice(0, 120)}` : ""}`);

  // durable phase results (the authoritative record)
  const phaseResult = (id) => {
    try { return JSON.parse(readFileSync(join(persistenceRoot, executionId, "phases", id, "result.json"), "utf8")); } catch { return null; }
  };

  if (expectFinal === "PASS") {
    for (const id of ["SA-R1", "SA-R2", "SA-R3", "SA-W1", "SA-V1"]) {
      const r = phaseResult(id);
      record(`${id}_PASSED`, r?.final === "PASS", `final=${r?.final} gen=${r?.graph_generation}`);
    }
    // The last-era real-terminal reclaim (Phase L) deletes the shared
    // results dir after the terminal — read the PASS-path evidence from the
    // DURABLE artifacts: phase result.json (graph_generation) + the writer's
    // captured summary in the g0-executor/implementation artifacts. The
    // distinct-identity proof comes from the durable node results.
    const nodeById = (id) => (result?.nodeResults ?? []).find((n) => n.nodeId === id) ?? null;
    const childIds = ["SA-R1", "SA-R2", "SA-R3"];
    const childNodes = childIds.map(nodeById);
    const distinct = new Set(childNodes.map((n) => n?.subagentEnvelope?.agentExecutionId)).size === 3;
    const allPassed = childNodes.every((n) => n?.final === "PASS");
    record("DISTINCT_AUTHORED_OUTPUTS", distinct && allPassed,
      `distinct=${distinct} allPassed=${allPassed} ids=${childNodes.map((n) => n?.subagentEnvelope?.agentExecutionId?.slice(0, 12)).join(",")}`);
    // deterministic consumption: SA-W1's summary carries one "dep<N>:" line
    // per declared dependency — read from the DURABLE implementation evidence
    // (the writer's captured worktree content), not the reclaimed results dir.
    const execDir = join(persistenceRoot, executionId, "phases", "SA-W1");
    let summary = "";
    if (existsSync(execDir)) {
      // the system-delta PATCH carries the real file content
      for (const f of readdirSync(execDir).filter((f) => f.endsWith(".patch")).sort()) {
        try {
          const patch = readFileSync(join(execDir, f), "utf8");
          const body = patch.split(/^\+\+\+ /m)[1] ?? patch;
          const lines = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
          if (lines.length > 0) { summary = lines.join("\n"); break; }
        } catch { /* next */ }
      }
    }
    const depLines = (summary.match(/^- dep\d+ /gm) ?? []).length;
    record("WRITER_CONSUMED_ALL_THREE", nodeById("SA-W1")?.final === "PASS" && depLines === 3,
      `depLines=${depLines} summary="${String(summary).replace(/\n/g, " | ").slice(0, 140)}"`);
    // identities bound: every child envelope identity re-derives from
    // (executionId, phase) — base OR stage-scoped repairer identity.
    const idsBound = childNodes.every((n) => {
      const aeid = n?.subagentEnvelope?.agentExecutionId;
      if (!aeid) return false;
      const baseId = agentExecutionIdFor(executionId, n.nodeId);
      const repairer = stageAgentExecutionId(executionId, n.nodeId, "repairer");
      return aeid === baseId || aeid === repairer;
    });
    record("IDENTITIES_BOUND", idsBound, `bound=${idsBound}`);
  } else {
    // fail-closed: the writer never PASSED and no downstream PASS rode on it
    const w1 = phaseResult("SA-W1");
    const v1 = phaseResult("SA-V1");
    record("WRITER_NEVER_PASSED", w1?.final !== "PASS" && v1?.final !== "PASS",
      `w1=${w1?.final ?? "none"} v1=${v1?.final ?? "none"}`);
    // the blocking finding names the dependency failure
    const jdir = join(persistenceRoot, executionId, "journal");
    const journal = existsSync(jdir)
      ? readdirSync(jdir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(jdir, f), "utf8")))
      : [];
    const held = journal.filter((e) => e.event_type === "PHASE_HELD" || e.event_type === "PHASE_FAILED");
    const finding = held.find((e) => JSON.stringify(e.payload ?? {}).includes("DEPENDENCY_")
      || JSON.stringify(e.payload ?? {}).includes("DUPLICATE_CLAIM")
      || JSON.stringify(e.payload ?? {}).includes("CONFLICT"));
    // The dispatcher gate refuses the spawn with DEPENDENCY_CONFLICT_HOLD
    // when provenance/reconciliation findings exist — the durable SA-W1
    // result records EXECUTOR_ERROR (refusal), the writer never ran.
    const w1Result = JSON.stringify(w1 ?? {});
    const refused = w1?.reason === "EXECUTOR_ERROR" || w1Result.includes("DEPENDENCY_CONFLICT_HOLD");
    // Two lawful fail-closed surfaces: (a) the dispatcher gate refuses the
    // spawn (EXECUTOR_ERROR from DEPENDENCY_CONFLICT_HOLD), or (b) the
    // independent review HOLDs on the dependency finding (REVIEWER_HOLD —
    // the review agent's DEPS_MISSING family). Both mean the writer's
    // output can never ride a missing/stale/forged/conflicted dependency.
    record("FAIL_CLOSED_FINDING", Boolean(finding) || refused
        || w1?.reason === "REVIEWER_HOLD" || w1?.final === "HELD",
      finding ? `${finding.event_type}:${String(JSON.stringify(finding.payload)).slice(0, 120)}` : `w1=${w1?.final}/${w1?.reason ?? ""} refused=${refused}`);
  }

  if (!process.env.WP1_H_KEEP) rmSync(base, { recursive: true, force: true });
  return { name, ok: checks.every((c) => c.ok), checks };
}

// H10: rollover between fan-out and fan-in — reuse the Phase G machinery:
// run A-era with the fan-out graph (3 children), handover, resume as B, and
// prove B's writer consumes the surviving three envelopes.
async function runH10() {
  const name = "H10";
  const checks = [];
  const record = (k, ok, detail = "") => {
    checks.push({ k, ok, detail: String(detail).slice(0, 220) });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}.${k}${detail ? ` — ${String(detail).slice(0, 180)}` : ""}`);
    log(`${ok ? "PASS" : "FAIL"}  ${name}.${k}${detail ? ` — ${String(detail).slice(0, 180)}` : ""}`);
  };

  const { bootstrapSuccessorSession } = await import(`${root}/src/rollover/production-wiring.mjs`);
  const { ROLLOVER_STATES } = await import(`${root}/src/rollover/rollover-authority.mjs`);
  const { readCheckpoint, checkpointExists } = await import(`${root}/src/v2/checkpoint-bridge.mjs`);

  const label = `${name}-${Date.now().toString(36)}`;
  const base = makeBase(label);
  const repo = makeRepo(base);
  const scratchRoot = join(base, "scratch");
  const persistenceRoot = join(base, "persist");
  const executionId = mintExecutionId();
  const rec = buildAdmissionRecord({
    taskId: `wp1-h-${label}`,
    classification: classify({ dimensionScores: DIMENSIONS, riskSignals: [{ signal_id: "wp1_h_probe_subagent_work", class: "MEDIUM", triggered: true, reason: "probe fixture exercises sub-agent execution" }] }),
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
      budget: {
        dimensions: {
          wall_clock_ms: { limit: 1800000 },
          node_execution_count: { limit: 48 },
          verifier_reviewer_attempts: { limit: 24 },
        },
      },
    },
  });
  rec.admission_id = deriveAdmissionId(rec);
  const v = validateAdmission(rec);
  if (!v.ok) throw new Error(`H10 admission invalid: ${v.errors.join(";")}`);
  const admission = freezeAdmission(rec);
  const resultsDir = canonicalResultsDir(scratchRoot, executionId, repo);
  const ownedScratchRoot = planOwnedScratchRoot({ scratchRoot, executionId, repoPath: repo });
  const factories = subagentAdapterFactories({ repoPath: repo, scratchRoot: ownedScratchRoot, resultsDir, maxRepairAttempts: 0, admission });

  const runOpts = () => ({
    admission,
    ir: fanoutIR(),
    parent: PARENT,
    manifest: [{ requirement_id: "r1", text: "WP1 H10 rollover fan-out probe" }],
    cwd: repo, repoPath: repo, scratchRoot,
    maxRepairAttempts: 0,
    timeoutMs: 300000,
    dirtyScope: [],
  });

  // A era: 3 children complete → rollover fires at SA-W1's quiescent start
  const A = await runSubagentGraphAdmitted({
    ...runOpts(),
    executionId: `wp1-h-${label}`,
    persistence: { root: persistenceRoot, executionId },
  });
  record("A_HANDOVER", A.final === "HOLD" && A.handedOver === true, `final=${A.final} handedOver=${A.handedOver === true}`);

  const snap = checkpointExists(persistenceRoot, executionId) ? readCheckpoint(persistenceRoot, executionId) : null;
  const mirror = snap?.snapshot?.graph?.rollover ?? null;
  const ownerB = mirror?.owner ?? null;

  // B era: production composition; writer consumes the surviving three.
  // B's own usage triggers the SECOND rollover at SA-V1's quiescent start
  // (the writer's result already re-bound through the fold gate), so B
  // hands over to C exactly as in Phase G; C runs the verifier.
  const B = await bootstrapSuccessorSession({
    persistenceRoot,
    executionId,
    spawnMeta: {
      rolloverId: mirror?.active_rollover_id ?? mirror?.last_rollover_id ?? null,
      expectedTargetGeneration: ownerB?.session_generation ?? 1,
      providerBinding: BINDING,
    },
    ...runOpts(),
  });
  record("B_HANDOVER", B.final === "HOLD" && B.handedOver === true,
    `final=${B.final} handedOver=${B.handedOver === true} holdCode=${B.holdCode ?? ""}`);

  const snapB = readCheckpoint(persistenceRoot, executionId);
  const mirrorB = snapB?.snapshot?.graph?.rollover ?? null;
  const ownerC = mirrorB?.owner ?? null;

  // C era: verifier consumes B's writer result
  const C = await bootstrapSuccessorSession({
    persistenceRoot,
    executionId,
    spawnMeta: {
      rolloverId: mirrorB?.active_rollover_id ?? mirrorB?.last_rollover_id ?? null,
      expectedTargetGeneration: ownerC?.session_generation ?? 2,
      providerBinding: BINDING,
    },
    ...runOpts(),
  });
  record("C_RESUMED_CONSUMED_FANOUT", C.final === "PASS", `final=${C.final} holdCode=${C.holdCode ?? ""}`);

  const w1 = (() => { try { return JSON.parse(readFileSync(join(persistenceRoot, executionId, "phases", "SA-W1", "result.json"), "utf8")); } catch { return null; } })();
  const v1 = (() => { try { return JSON.parse(readFileSync(join(persistenceRoot, executionId, "phases", "SA-V1", "result.json"), "utf8")); } catch { return null; } })();
  record("FANIN_PASSED_ACROSS_ERAS", w1?.final === "PASS" && v1?.final === "PASS" && w1?.graph_generation === 1 && v1?.graph_generation === 2,
    `w1=${w1?.final}@g${w1?.graph_generation} v1=${v1?.final}@g${v1?.graph_generation}`);

  if (!process.env.WP1_H_KEEP) rmSync(base, { recursive: true, force: true });
  return { name, ok: checks.every((c) => c.ok), checks };
}

const ALL = ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10"];
const requested = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ALL;

const results = [];
for (const name of requested) {
  try {
    results.push(name === "H10" ? await runH10() : await runScenario(name));
  } catch (e) {
    console.log(`FAIL  ${name}.EXCEPTION — ${String(e?.message ?? e).slice(0, 200)}`);
    log(`FAIL  ${name}.EXCEPTION — ${String(e?.message ?? e).slice(0, 200)}`);
    results.push({ name, ok: false, checks: [{ k: "EXCEPTION", ok: false, detail: String(e?.message ?? e) }] });
  }
}

console.log("\n=== WP1 PHASE H: PARALLEL FAN-OUT / FAN-IN ===");
let failed = 0;
for (const r of results) {
  const bad = r.checks.filter((c) => !c.ok);
  failed += bad.length;
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${bad.length ? ` (first break: ${bad[0].k})` : ""}`);
}
console.log(`\nPARALLEL_CONTINUITY = ${failed === 0 ? "PASS" : "FAIL"}`);
writeFileSync(join(root, "docs", "pi-graph-output", `wp1-h-fanout-${Date.now().toString(36)}.json`),
  JSON.stringify({ schema: "autoloop.wp1-h-fanout/v1", ranAt: new Date().toISOString(), log: LOG, results, verdict: failed === 0 ? "PASS" : "FAIL" }, null, 2) + "\n");
if (failed > 0) process.exitCode = 1;
