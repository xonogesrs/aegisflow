// scripts/de1-self-closeout.mjs
//
// DE-1（AUTOLOOP-PI-GRAPH-DE1）— Durable Execution / Crash-Recovery
// Architecture & Bake-off: research-card closeout.
//
// Produces the DE-1 review bundle through the PRODUCTION Graph closeout hook
//（SA-R1 ‖ SA-R2 -> SA-W1 -> SA-V1, writer -> independent review agent ->
// bounded repair（budget 1）-> verifier）with the full DE-1 evidence set
//（capability map / failure model / invariants / candidate research /
// provider contract / bake-off results / security findings / decision）.
//
// Run: node scripts/de1-self-closeout.mjs
//      node scripts/de1-self-closeout.mjs --regenerate

import { homedir } from "node:os";
import { mkdirSync, rmSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runSubagentGraph } from "../src/subagent/subagent-graph-runner.mjs";
import { agentExecutionIdFor, stageAgentExecutionId } from "../src/subagent/subagent-contract.mjs";
import { createGraphMemoryProvider, LocalMemoryStore, resolveRepositoryIdentity } from "../src/memory/index.mjs";
import { runMandatoryGraphCloseout, buildGraphCloseoutSource, recursiveCanonicalJson, sha256Hex } from "../src/governance/review-bundle.mjs";
import { TelemetryStore, recordGraphTelemetry } from "../src/telemetry/index.mjs";

const HOME = homedir();
const REPO_A = "/Volumes/NVM2T/Development/repos/autoloop";
const SCRATCH = `${HOME}/autoloop-de1-self-closeout`;
const PROFILE = "autoloop-graph";
const PARENT = { scope: { allowed_paths: ["docs/"], forbidden_paths: [".git"] } };
const SCOPE = "docs/pi-graph-output/de1";
const EXECUTION_ID = "de1-self-closeout-20260808";
const OUT = join(REPO_A, SCOPE);
const TELEMETRY_ROOT = `${HOME}/.autoloop-telemetry-de1`;
const MEMORY_ROOT = `${HOME}/.autoloop/memory`;

const roPhase = (phaseId, taskType) => ({
  phase_id: phaseId,
  depends_on: [],
  effects: { artifact_mutation: "none" },
  runtime: {
    mode: "subagent",
    agentRole: "readonly-analyst",
    taskType,
    objective: `read-only ${taskType} over /src/docs`,
    expect: { stdoutContains: [`SUBAGENT_DONE:${taskType}`] },
    limits: { memoryMiB: 256 },
    sleep: 3,
  },
});

const writerPhase = {
  phase_id: "SA-W1",
  depends_on: ["SA-R1", "SA-R2"],
  effects: { artifact_mutation: "required", boundaries: { artifact: [SCOPE] } },
  runtime: {
    mode: "subagent",
    agentRole: "writer",
    taskType: "write_report_with_gap",
    repairTaskType: "repair_report",
    objective: `writer write_report_with_gap over /work/${SCOPE} using dependency results`,
    expect: { stdoutContains: ["SUBAGENT_DONE:write_report_with_gap"] },
    limits: { memoryMiB: 256 },
  },
};

const verifierPhase = {
  phase_id: "SA-V1",
  depends_on: ["SA-W1"],
  effects: { artifact_mutation: "none" },
  runtime: {
    mode: "subagent",
    agentRole: "verifier",
    taskType: "verify_writer",
    objective: "verify writer SA-W1 diff/tests/scope + independent review from /results artifacts",
    expect: { stdoutContains: ["SUBAGENT_DONE:verify_writer"] },
    limits: { memoryMiB: 256 },
  },
};

const ir = { phases: [roPhase("SA-R1", "count_todos"), roPhase("SA-R2", "inventory_markdown"), writerPhase, verifierPhase] };

// ── DE-1 evidence files（Section 17/18 inventory）─────────────────────────
const DE1_EVIDENCE_FILES = [
  "de1-durable-capability-map.json",
  "de1-failure-model.json",
  "de1-durable-invariants.json",
  "de1-candidate-research.json",
  "de1-provider-contract.json",
  "de1-bakeoff-results.json",
  "de1-security-findings.json",
  "de1-decision-evidence.json",
  "de1-independent-review.json",
];

function readEvidenceInventory() {
  const out = [];
  for (const f of DE1_EVIDENCE_FILES) {
    const p = join(OUT, f);
    if (existsSync(p)) out.push({ path: p, sha256: sha256Hex(readFileSync(p, "utf8")) });
  }
  return out;
}

const de1SourceBuilder = async ({ graphResult, closeout: co, evidence = [] }) => {
  const source = await buildGraphCloseoutSource({ graphResult, closeout: co, evidence });
  // add the DE-1 evidence inventory
  const extra = readEvidenceInventory().filter((e) => !(source.evidence ?? []).some((x) => x.path === e.path));
  source.evidence = [...(source.evidence ?? []), ...extra];
  const gid = graphResult?.executionId ?? source.graph?.graphRunId ?? null;
  const reviewOutcomes = (graphResult?.nodeResults ?? [])
    .map((n) => n.reviewResult)
    .filter((r) => r && typeof r === "object" && !Array.isArray(r) && typeof r.recommendedAction === "string")
    .map((r) => ({ recommendedAction: r.recommendedAction, blockingFindings: Array.isArray(r.blockingFindings) ? r.blockingFindings.slice() : [] }));
  const reviewResultIdentity = sha256Hex(recursiveCanonicalJson({ graphRunId: gid, reviewOutcomes }));
  return {
    ...source,
    review: {
      ...(source.review ?? {}),
      reviewResultIdentity,
      summary: gid ? `independent review agent result (${gid})` : (source.review?.summary ?? "independent review agent result"),
    },
  };
};

const closeout = {
  requiresReview: true,
  outDir: OUT,
  cardId: "AUTOLOOP-PI-GRAPH-DE1",
  cardTitle: "Durable Execution / Crash-Recovery Architecture & Bake-off",
  cardType: "research",
  objective:
    "Determine the durable-execution / crash-recovery foundation AutoLoop needs for long-running autonomous execution: audit the existing AutoLoop durable layer, define the failure model + invariants, research Temporal and Restate from current official sources, run the same failure-injection bake-off harness, enforce safety hard gates, measure cost/complexity, and select a winner — with Existing AutoLoop as a first-class candidate, never a default to an external framework.",
  authorizedScope: ["docs/pi-graph-output/de1/", "scripts/de1-*.mjs", "test/v2/test-durable-*.mjs"],
  unauthorizedScope: [
    "production durable runtime replacement",
    "external runtime as a production dependency",
    "scheduler policy changes",
    "Graph topology semantics changes",
    "writer lease authority changes",
    "memory trust model changes",
    "model routing changes",
    "self-evolution / CodeGraph / Semgrep / OSV / DSPy / GEPA / MCP",
    "commit / push / merge / seal",
  ],
  cardFiles: {
    cardImplementation: [
      "scripts/de1-bakeoff.mjs",
      "scripts/de1-bakeoff-worker.mjs",
      "scripts/de1-bakeoff-workload.mjs",
      "scripts/de1-provider-contract-check.mjs",
      "scripts/de1-self-closeout.mjs",
    ],
    closeoutOutputs: [
      "docs/pi-graph-output/de1/de1-self-closeout-20260808-graph-closeout-evidence.json",
      ...DE1_EVIDENCE_FILES.map((f) => `docs/pi-graph-output/de1/${f}`),
    ],
    preExistingDirty: [],
  },
  designDecisions: [
    "TWO execution stacks exist: STACK_A (src/autoloop.mjs -> runDurableAutoLoop/resumeAutoLoop — evidence journal + atomic checkpoint + fingerprint chain + safe resume + manifest; durable) and STACK_B (src/runtime/colima-graph-runner.mjs -> runExecutionOrchestrator DIRECTLY — the production Graph path used by CBM-2/3/4; ZERO persistence during the run; node state is in-memory; crash = full re-run)",
    "capability audit (autoloop.durable-capability-map/v1): STACK_A is ALREADY DURABLE for task/graph/node state, checkpoint, resume, retry, repair state, dependency restoration, writer-lease fail-closed, cancellation, timeout, evidence identity; STACK_B is EPHEMERAL/RESTARTABLE-ONLY for all of these",
    "invariants (autoloop.durable-invariants/v1): STACK_A satisfies D1-D8 except D7 (telemetry replay-awareness at the durable layer); STACK_B fails D1 (lost completed results) and D5 (ready set not durable) outright — the dominant gap is wiring, not engine capability",
    "failure model (autoloop.durable-failure-model/v1): process / worker / runtime / storage / external-dependency / lifecycle-phase classes with exactly-once / at-least-once / idempotent requirements; forbidden duplicates = writer mutation replay, trusted memory duplicate, false PASS promotion",
    "candidate research (autoloop.durable-candidate-research/v1, verified 2026-08-08 from npm registry + official docs): Temporal temporalio@1.9.3 (MIT SDK; server + DB; deterministic workflow replay; all model IO must be activities); Restate @restatedev/restate-sdk@1.16.4 (MIT SDK) + @restatedev/restate-server@1.7.3 (BSL) with journaled invocations",
    "provider seam (autoloop.durable-execution-provider/v1): AutoLoop Graph -> DurableExecutionProvider -> backend; 12 methods (createExecution/persistCheckpoint/loadExecution/resumeExecution/markNodeStarted/markNodeCompleted/markNodeFailed/recordRetry/cancel/recover/inspect/cleanup); STACK_A implements all 12 natively (verified by scripts/de1-provider-contract-check.mjs); a third-party engine may ONLY provide lifecycle durability, never the AutoLoop brain",
    "bake-off (scripts/de1-bakeoff.mjs, real SIGKILL, 2 kill modes x 10 crash points + T0/T9/T11/T12): SAFETY HARD GATES 100% — zero silent duplicate mutations, zero lost completed results, zero false PASS, zero authority escalation; recoverability gaps found at journal->checkpoint sub-windows (resume post-head whitelist missing DAG_ACCEPTED/PHASE_STARTED/EXECUTOR_COMPLETED/REVIEWER_COMPLETED/PHASE_PASSED/PHASE_SKIPPED) and a resumed-orchestrator JOURNAL_OUT_OF_ORDER edge — fail-closed, bounded, in-process fixes",
    "security audit (autoloop.durable-security-findings/v1): Restate FAILS the Stage 13 gate — @restatedev/restate-server depends on @scarf/scarf (default phone-home analytics) and is BSL-licensed; Temporal SDK is clean (only @temporalio/* deps) but adds a server+DB deployment surface",
    "decision (autoloop.durable-execution-bakeoff-result/v1): WINNER = Candidate A (Existing AutoLoop durable execution) — PASS / EXISTING_DURABLE_EXECUTION_SELECTED; Temporal and Restate rejected; next card DE-2 = Native Durable Execution Hardening (wire STACK_A behind runColimaGraph + complete the resume whitelist + fix the resumed-orchestrator edge + telemetry replay-awareness + worktree restoration)",
  ],
  negativeCases: [
    "silent lost work -> FAIL (hard gate): never observed — bake-off T0-T12: lostCompletedResult = 0",
    "silent duplicate writer mutation -> FAIL (hard gate): never observed — duplicatedWriterSideEffect = 0 in every run",
    "false PASS promotion -> FAIL (hard gate): never observed; interrupted writer always RECOVERY_REQUIRED (D3)",
    "authority escalation across recovery -> FAIL (hard gate): never observed; config fingerprint (source hashes + adapter policy) rejects drift (D8)",
    "crash in journal->checkpoint sub-window -> resume REFUSED fail-closed (RESUME_FINGERPRINT_MISMATCH 'unexpected journal event ... beyond checkpoint head') — a recoverability gap (F1), never a safety violation",
    "corrupt checkpoint (tampered CURRENT.json) -> resume REJECTED (T12, fail-closed)",
    "duplicate recovery invocation -> second resume returns COMPLETE with zero re-execution (T11)",
    "CBM-4 write-back under crash -> WRITEBACK_DUPLICATE with exactly one CURRENT record after lossless journal rebuild (T9, D6)",
    "Restate server telemetry (Scarf) -> REJECTED under Stage 13 (unexplained network behavior)",
  ],
  regression: [
    { suite: "bake-off harness (scripts/de1-bakeoff.mjs; T0-T12 real SIGKILL)", tests: 22, pass: 9, fail: 13, note: "safety hard gates 100% PASS; recoverability gaps documented (F1 whitelist, F2/F3 resumed-orchestrator edge) — the DE-2 work item" },
    { suite: "provider-contract check (scripts/de1-provider-contract-check.mjs)", tests: 12, pass: 12, fail: 0 },
    { suite: "test:c3 (durable-execution + checkpoint-bridge + pre-decomposition interruption; existing durable-related)", tests: 41, pass: 41, fail: 0 },
    { suite: "test:v2 (orchestrator/runner/pipeline)", tests: 357, pass: 357, fail: 0 },
    { suite: "test:governance", tests: 229, pass: 229, fail: 0 },
  ],
  regressionSummary:
    "DE-1 closeout: bake-off harness ran the SAME 4-phase workload through T0-T12 real-SIGKILL injections in two kill modes — SAFETY HARD GATES all PASS (silentDuplicateMutation=0, lostCompletedResult=0, falsePass=0, authorityEscalation=0). 8 of the recoverability failures are the resume post-head whitelist gap (F1: events journaled before their checkpoint — DAG_ACCEPTED/PHASE_STARTED/EXECUTOR_COMPLETED/REVIEWER_COMPLETED/PHASE_PASSED/PHASE_SKIPPED — refuse resume when left beyond the checkpoint head), and 3 are the resumed-orchestrator edge (F2/F3: JOURNAL_OUT_OF_ORDER / read-only requeue HOLD). These are fail-closed, in-process, bounded fixes (DE-2). Provider contract check 12/12; existing durable-related suites green (test:c3 41/41, test:v2 357/357, test:governance 229/229). colima-all NOT re-run (no production source changed — research card, per Stage 16).",
  repairBudgetMaxAttempts: 1,
  executiveSummary:
    "DE-1 complete: Durable Execution / Crash-Recovery Architecture & Bake-off — full audit of the existing AutoLoop durable layer (STACK_A durable: journal+checkpoint+resume+manifest; STACK_B production Graph path NOT durable), formal failure model + D1-D8 invariants, current-source research of Temporal (temporalio@1.9.3) and Restate (sdk@1.16.4 / server@1.7.3 BSL + Scarf telemetry), the same real-SIGKILL failure-injection bake-off (safety hard gates 100% PASS; recoverability gaps F1/F2/F3 documented as bounded DE-2 work), security/supply-chain audit (Restate FAILS Stage 13), the DurableExecutionProvider seam (12 methods, all implemented natively), and the decision: WINNER = Existing AutoLoop durable execution (PASS / EXISTING_DURABLE_EXECUTION_SELECTED); Temporal and Restate rejected. Next: DE-2 — Native Durable Execution Hardening.",
  recommendedNextStep: "DE-2 — Native Durable Execution Hardening: (1) wire the durable layer behind runColimaGraph (production Graph path durability), (2) complete the resume post-head whitelist (F1), (3) fix the resumed-orchestrator journal/revision edge (F2/F3), (4) telemetry replay-awareness (D7), (5) writer worktree restoration policy. Then Autonomous Research Escalation.",
  rollbackProcedure:
    "Research card — no production source changed. Remove scripts/de1-*.mjs and docs/pi-graph-output/de1/ if not retained as the DE-2 design basis. No runtime, dependency, or schema migration was introduced.",
  openQuestions: [],
  risks: [
    "STACK_B (production Graph path) still has no durable checkpoint/resume — a process crash mid-graph requires a full re-run (the single most important DE-2 item)",
    "the resume post-head whitelist gap (F1) makes sub-checkpoint-window crashes non-resumable (fail-closed)",
    "telemetry replay-awareness (D7) unproven at the durable layer",
    "writer worktree restoration on resume is not persisted (RESTARTABLE-ONLY)",
  ],
  limitations: [
    "Temporal/Restate were not executed as full server deployments in this bake-off (their adoption would require server+DB); the comparison is design/security/complexity-grounded, and both were rejected on grounds independent of a live run",
    "bake-off workload is a synthetic 4-phase DAG (mirrors the production graph shape: ro->ro->writer->verifier) with scripted adapters — not the full colima worker runtime",
  ],
};

mkdirSync(SCRATCH, { recursive: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(TELEMETRY_ROOT, { recursive: true });

const telemetryStore = new TelemetryStore({ stateRoot: TELEMETRY_ROOT });
try { telemetryStore.open(); } catch { /* UNAVAILABLE — graph continues */ }
const telemetry = { store: telemetryStore, observer: async ({ graphResult, closeout: co, store, verification }) => recordGraphTelemetry({ graphResult, closeout: co, store, verification }) };

const repoIdentity = resolveRepositoryIdentity(REPO_A).repositoryIdentity;
const memoryStore = new LocalMemoryStore({ stateRoot: MEMORY_ROOT });
try { memoryStore.open(); } catch { /* MEMORY_STORE_INVALID — graph continues */ }
const writeback = { store: memoryStore, telemetryStore, reviewIdentity: null, verifierIdentity: null, expectedRepository: repoIdentity };

const REGENERATE = process.argv.includes("--regenerate");

if (REGENERATE) {
  const evidencePath = join(OUT, `${EXECUTION_ID}-graph-closeout-evidence.json`);
  const ev = JSON.parse(readFileSync(evidencePath, "utf8"));
  const repairedNodes = new Set((ev.transitions ?? []).filter((t) => t.final === "REPAIR").map((t) => t.phaseId));
  const graphResult = {
    executionId: ev.graphRunId,
    final: ev.final,
    holdCode: ev.holdCode ?? null,
    reason: ev.reason ?? null,
    scheduler: { ...(ev.scheduler ?? {}) },
    nodeResults: (ev.nodes ?? []).map((n) => ({
      nodeId: n.nodeId,
      phaseExecutionId: n.phaseExecutionId ?? null,
      taskType: n.taskType ?? null,
      dependencies: Array.isArray(n.dependencies) ? n.dependencies.slice() : [],
      final: n.final ?? null,
      attempt: n.attempt ?? null,
      reason: n.reason ?? null,
      startedAt: n.startedAt ?? null,
      completedAt: n.completedAt ?? null,
      cleanup: { worktreeRevoked: n.worktreeRevoked === true },
      worktreeIdentity: n.worktreeVerified === true ? { verified: true } : null,
      subagentEnvelope: {
        agentExecutionId: (repairedNodes.has(n.nodeId) || (n.attempt ?? 0) > 0)
          ? stageAgentExecutionId(ev.graphRunId, n.nodeId, "repairer")
          : agentExecutionIdFor(ev.graphRunId, n.nodeId),
      },
      subagentResult: n.subagentResultStatus
        ? { status: n.subagentResultStatus, testResults: n.subagentTestResults ?? null, testsExecuted: n.subagentTestResults ? ["regenerated from graph evidence"] : [] }
        : null,
      reviewResult: n.reviewResultStatus
        ? { recommendedAction: n.reviewResultStatus, blockingFindings: Array.isArray(n.reviewBlockingFindings) ? n.reviewBlockingFindings.slice() : [], summary: `independent review agent result (${ev.graphRunId})` }
        : null,
    })),
    transitions: (ev.transitions ?? []).map((t) => ({ ...t })),
  };
  const r = await runMandatoryGraphCloseout({
    graphResult,
    closeout,
    repoPath: REPO_A,
    cwd: REPO_A,
    outDir: OUT,
    timeoutMs: 60000,
    sourceBuilder: de1SourceBuilder,
  });
  console.log(`regenerate applied=${r.applied} final=${r.final} holdCode=${r.holdCode ?? "null"}`);
  if (r.bundlePath) {
    console.log(`bundle: ${r.bundlePath}`);
    console.log(`reviewBundleIdentity: ${r.bundle.identity}`);
    console.log(`reviewBundleSha256: ${r.bundle.sha256}`);
  }
  process.exit(r.final === "PASS" ? 0 : 1);
}

const r = await runSubagentGraph({
  ir,
  parent: PARENT,
  cwd: REPO_A,
  executionId: EXECUTION_ID,
  profile: PROFILE,
  repoPath: REPO_A,
  scratchRoot: SCRATCH,
  maxRepairAttempts: 1,
  timeoutMs: 240000,
  memory: { provider: createGraphMemoryProvider({ stateRoot: MEMORY_ROOT }) },
  telemetry,
  writeback,
  closeoutSourceBuilder: de1SourceBuilder,
  closeout,
});

console.log(`graph final=${r.final} reason=${r.reason ?? "null"}`);
console.log(`closeout applied=${r.closeout.applied} final=${r.closeout.final} holdCode=${r.closeout.holdCode ?? "null"}`);
if (r.closeout.bundlePath) {
  console.log(`bundle: ${r.closeout.bundlePath}`);
  console.log(`reviewBundleIdentity: ${r.closeout.bundle.identity}`);
  console.log(`reviewBundleSha256: ${r.closeout.bundle.sha256}`);
}
if (r.closeout.externalReview) {
  console.log(`externalReviewStatus: ${r.closeout.externalReview.externalReviewStatus}`);
}
try { telemetryStore.close(); } catch { /* best effort */ }
try { memoryStore.close(); } catch { /* best effort */ }
rmSync(SCRATCH, { recursive: true, force: true });
process.exit(r.final === "PASS" && r.closeout.final === "PASS" ? 0 : 1);
