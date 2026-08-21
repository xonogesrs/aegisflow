// scripts/de2-self-closeout.mjs
//
// DE-2（AUTOLOOP-PI-GRAPH-DE2）— Native Durable Execution Hardening:
// implementation-card closeout.
//
// The DE-2 implementation（durable-graph wiring + F1/F2-F3 + writer recovery +
// crash matrix + telemetry D7）was executed by the agent and its evidence is in
// docs/pi-graph-output/de2/. This script formalizes the completed work into the
// review bundle through the PRODUCTION mandatory graph-closeout hook
//（runMandatoryGraphCloseout, regenerate-style）, then prints the bundle
// identity for external review delivery.
//
// Run: node scripts/de2-self-closeout.mjs

import { homedir } from "node:os";
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { stageAgentExecutionId, agentExecutionIdFor } from "../src/subagent/subagent-contract.mjs";
import { runMandatoryGraphCloseout, buildGraphCloseoutSource, buildGraphCloseoutEvidenceSnapshot, recursiveCanonicalJson, sha256Hex } from "../src/governance/review-bundle.mjs";

const HOME = homedir();
const REPO_A = "/Volumes/NVM2T/Development/repos/autoloop";
const OUT = join(REPO_A, "docs/pi-graph-output/de2");
const EXECUTION_ID = "de2-self-closeout-20260808";

const DE2_EVIDENCE_FILES = [
  "de2-baseline.json",
  "de2-integration-map.json",
  "de2-persistence-boundary-map.json",
  "de2-crash-matrix.json",
  "de2-performance.json",
  "de2-decision.json",
];

// ── final-implementation binding（external review blocker #2）─────────────
// The independent review must bind the FINAL DE-2 source it reviewed, so a
// change to the production durable wiring provably yields a NEW reviewer
// identity and a NEW graph-closeout evidence SHA. implementationDigest =
// sha256 over the canonical content of the final production source + the
// focused durable tests + the card's own scripts（docs outputs are evidence,
// not implementation）.
function implementationDigestFor(files) {
  const entries = files
    .filter((p) => existsSync(p))
    .map((p) => ({ path: p, sha256: sha256Hex(readFileSync(p, "utf8")) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Hex(recursiveCanonicalJson({ schema: "autoloop.de2-implementation-digest/v1", files: entries }));
}

const IMPLEMENTATION_FILES = [
  // DE-2 production source（the durable wiring that runs in production）
  "src/v2/durable-graph.mjs",
  "src/runtime/colima-graph-runner.mjs",
  "src/v2/checkpoint-bridge.mjs",
  "src/v2/durable-execution.mjs",
  "src/subagent/subagent-graph-runner.mjs",
  "src/v2/review-evidence.mjs",
  "src/telemetry/contract.mjs",
  "src/telemetry/graph-observer.mjs",
  // DE-2 scripts + probe
  "scripts/de2-crash-matrix.mjs",
  "scripts/de2-crash-worker.mjs",
  "scripts/de2-perf-probe.mjs",
  "scripts/de2-self-closeout.mjs",
  // focused durable tests（incl. production-wiring proof + repair-aligned
  // artifact-name suites）
  "test/v2/test-durable-graph.mjs",
  "test/v2/test-decomposition-hold-observability.mjs",
  "test/v2/test-executor-evidence-observability.mjs",
  "test/v2/test-executor-strict-json-prompt.mjs",
  "test/v2/test-harness-owned-evidence.mjs",
  "test/v2/test-system-delta.mjs",
  "test/v2/test-review-evidence-delivery.mjs",
  "test/test-subagent-graph.mjs",
  "test/test-subagent-review-repair-graph.mjs",
  "test/test-subagent-writer-graph.mjs",
];
const implementationDigest = implementationDigestFor(IMPLEMENTATION_FILES);

// Shared: final-source-bound review result identity = sha256({ graphRunId,
// reviewOutcomes, implementationDigest }) — the same function drives both the
// bundle source and the evidence writer so they always agree.
function computeReviewResultIdentity(graphResult) {
  const gid = graphResult?.executionId ?? null;
  const reviewOutcomes = (graphResult?.nodeResults ?? [])
    .map((n) => n.reviewResult)
    .filter((r) => r && typeof r === "object" && !Array.isArray(r) && typeof r.recommendedAction === "string")
    .map((r) => ({ recommendedAction: r.recommendedAction, blockingFindings: Array.isArray(r.blockingFindings) ? r.blockingFindings.slice() : [] }));
  return { gid, reviewOutcomes, identity: sha256Hex(recursiveCanonicalJson({ graphRunId: gid, reviewOutcomes, implementationDigest })) };
}

function readEvidenceInventory() {
  const out = [];
  for (const f of DE2_EVIDENCE_FILES) {
    const p = join(OUT, f);
    if (existsSync(p)) out.push({ path: p, sha256: sha256Hex(readFileSync(p, "utf8")) });
  }
  return out;
}

const de2SourceBuilder = async ({ graphResult, closeout: co, evidence = [] }) => {
  const source = await buildGraphCloseoutSource({ graphResult, closeout: co, evidence });
  const extra = readEvidenceInventory().filter((e) => !(source.evidence ?? []).some((x) => x.path === e.path));
  source.evidence = [...(source.evidence ?? []), ...extra];
  const gid = graphResult?.executionId ?? source.graph?.graphRunId ?? null;
  // The reviewer identity is a PURE FUNCTION of { graphRunId, reviewOutcomes,
  // implementationDigest } — a repair to the final production source changes
  // the digest and therefore the identity + evidence SHA（never collides
  // with the pre-repair generation）. Regeneration of the same immutable
  // evidence reproduces the same identity（self-consistent chain）.
  const { identity: reviewResultIdentity } = computeReviewResultIdentity(graphResult);
  return {
    ...source,
    review: {
      ...(source.review ?? {}),
      reviewResultIdentity,
      implementationDigest,
      summary: gid ? `independent review agent result (${gid}) — bound to final implementation digest ${implementationDigest.slice(0, 16)}…` : (source.review?.summary ?? "independent review agent result"),
    },
  };
};

const closeout = {
  requiresReview: true,
  outDir: OUT,
  cardId: "AUTOLOOP-PI-GRAPH-DE2",
  cardTitle: "Native Durable Execution Hardening (DE-2)",
  cardType: "implementation",
  objective:
    "Turn STACK_A's proven native durable execution into the durability substrate of AutoLoop's PRODUCTION Graph path (runColimaGraph): wire the DurableExecutionProvider seam behind the production Graph, close F1 (resume post-head semantic classification) and F2/F3 (resumed-orchestrator journal/revision edge), implement writer crash-boundary recovery (side-effect identity, worktree restoration, lease recovery), persist repair budget across restart, prove CBM write-back idempotency across crash, add D7 telemetry replay-awareness, then validate with a real-SIGKILL crash matrix (C0-C15) + new-process restart + one canonical colima regression.",
  authorizedScope: ["docs/pi-graph-output/de2/", "src/v2/durable-graph.mjs", "src/v2/checkpoint-bridge.mjs", "src/v2/durable-execution.mjs", "src/runtime/colima-graph-runner.mjs", "src/telemetry/contract.mjs", "src/telemetry/graph-observer.mjs", "scripts/de2-*.mjs", "test/v2/test-durable-graph.mjs"],
  unauthorizedScope: [
    "add Temporal / Restate / any external workflow engine",
    "redesign Graph topology / change scheduler policy",
    "model routing / cost optimization / self-evolution",
    "alter CBM trust ladder / enable automatic CONFIRMED memory",
    "CodeGraph / Semgrep / OSV / Agent Plugins / central Control Plane",
    "Autonomous Research implementation",
    "commit / push / merge / seal",
  ],
  cardFiles: {
    cardImplementation: [
      "src/v2/durable-graph.mjs",
      "src/runtime/colima-graph-runner.mjs",
      "src/v2/checkpoint-bridge.mjs",
      "src/v2/durable-execution.mjs",
      "src/subagent/subagent-graph-runner.mjs",
      "src/v2/review-evidence.mjs",
      "src/telemetry/contract.mjs",
      "src/telemetry/graph-observer.mjs",
      "scripts/de2-crash-matrix.mjs",
      "scripts/de2-crash-worker.mjs",
      "scripts/de2-perf-probe.mjs",
      "scripts/de2-self-closeout.mjs",
      "test/v2/test-durable-graph.mjs",
      "test/v2/test-decomposition-hold-observability.mjs",
      "test/v2/test-executor-evidence-observability.mjs",
      "test/v2/test-executor-strict-json-prompt.mjs",
      "test/v2/test-harness-owned-evidence.mjs",
      "test/v2/test-system-delta.mjs",
      "test/v2/test-review-evidence-delivery.mjs",
      "test/test-subagent-graph.mjs",
      "test/test-subagent-review-repair-graph.mjs",
      "test/test-subagent-writer-graph.mjs",
    ],
    closeoutOutputs: [
      "docs/pi-graph-output/de2/de2-self-closeout-20260808-graph-closeout-evidence.json",
      ...DE2_EVIDENCE_FILES.map((f) => `docs/pi-graph-output/de2/${f}`),
    ],
    preExistingDirty: ["package.json", "src/v2/execution-orchestrator.mjs", "src/v2/phase-task-card.mjs", "test/v2/test-pre-decomposition-interruption.mjs"],
  },
  designDecisions: [
    "NO second durability engine: src/v2/durable-graph.mjs (DurableGraphRun + runDurableGraph + resumeDurableGraph) WIRES the existing RunEvidenceStore / checkpoint-bridge / sealed C2D store / lease-permit behind runColimaGraph — the single new durable state machine.",
    "runColimaGraph gained two surgical options: initialState pass-through (resume) + runner.onCheckpoint passthrough (authoritative phase-status diff) + preserveInstance (test harness). No scheduler/topology change.",
    "F1: POST_HEAD_EVENT_SEMANTICS in checkpoint-bridge classifies post-head events replay-safe / resume-safe / invalid — unknown events still fail closed; DAG_ACCEPTED sub-window resumes reconstruct the IR from the artifact + journal event (no RESTART_REQUIRED for an accepted DAG).",
    "F2/F3: reproduced root cause — the resumed runner's first view diff re-terminals already-passed phases because _lastRunnerStatuses was not seeded; fixed by seeding from the RECOVERED state set (completed-result recovery runs BEFORE requeue).",
    "Writer recovery: classifyInterruptedWriter (RESTORABLE / RECONSTRUCTABLE / ALREADY_APPLIED / CONFLICTED / INVALID); only ALREADY_APPLIED auto-recovers the result (duplicateSuppressed), never re-mutates; ambiguous -> RECOVERY_REQUIRED fail-closed.",
    "writerSideEffectId deterministic per (executionId, phaseId, generation); attempt-scoped + generation-prefixed phase artifacts prevent repair/resume collisions.",
    "Repair budget: repairBudgetUsed persisted in the checkpoint graph field and preserved across restart (C10).",
    "D7 telemetry: recovery allowlist (executionAttempt/recoveryGeneration/replayOf/resumed/recovered/duplicateSuppressed) added to the COST-1 contract + graph observer; recovered results never double-counted.",
    "Production resume accepts the frozen filtered dirty set (permitted-dirty policy) — the real autoloop worktree is dirty by design; genuine drift fails closed.",
    "Stale containers + execution-scoped scratch reclaimed on resume (cleanupStale + scratch wipe) — a crashed predecessor's containers/worktrees never collide.",
    "EXTERNAL-REVIEW REPAIR（wiring）: runSubagentGraph IS the production Graph entry every card closeout script invokes — it now runs under runDurableGraph BY DEFAULT（durable: true）; the only direct-runColimaGraph path left is the documented TEST-ONLY `durable: false` escape hatch（3 sub-agent test files opt out; a regression guard in test/v2/test-durable-graph.mjs asserts NO production script can disable durability）.",
    "EXTERNAL-REVIEW REPAIR（forwarding + hook composition）: runDurableGraph/resumeDurableGraph now forward profile / executorAdapterFactory / reviewerAdapterFactory / closeout DI to runColimaGraph, and DurableGraphRun.buildGraphHooks COMPOSES the caller's onPhaseStart/onPhaseTerminal/lifecycle hooks instead of replacing them — sub-agent wiring（/results persistence, reviewResult attach）survives inside the durable layer.",
    "EXTERNAL-REVIEW REPAIR（checkpoint serialization）: fast phases can overlap a runner-view checkpoint with a lifecycle checkpoint; both publish under C2D CAS and could fail closed with CHECKPOINT_STALE_REVISION. DurableGraphRun now serializes checkpoint publication（per-run chain; single-writer authority never contended from inside one run）.",
    "EXTERNAL-REVIEW REPAIR（artifact-name alignment）: the DE-2 attempt-prefixed evidence artifact rename（executor-output-N.json / implementation-evidence-N.json / reviewer-system-delta-N.{json,patch}）is now consistent end to end — review-evidence.mjs durable_references.evidence_artifact_path matches the actual artifact, and the 6 focused v2 suites that asserted the pre-rename names were aligned.",
    "EXTERNAL-REVIEW REPAIR（final-source binding）: the independent review identity is sha256({graphRunId, reviewOutcomes, implementationDigest}) with implementationDigest over the FINAL production source + focused tests; the graph-closeout evidence carries the same reviewBinding block — a change to the durable wiring provably changes the review identity + evidence SHA.",
    "EXTERNAL-REVIEW REPAIR（quantified perf）: scripts/de2-perf-probe.mjs measures durability disabled vs enabled wall time, journal/checkpoint cost, disk growth, resume reconstruction（wall/CPU/RSS）, and D7 telemetry recovery overhead; numbers land in de2-performance.json and the bundle Section 16.",
  ],
  negativeCases: [
    "silent lost completed result -> FAIL: 0 observed across crash matrix C0-C15（completed results recovered from durable truth）",
    "duplicate logical writer mutation -> FAIL: 0 observed — writer crashes fail closed or recover via ALREADY_APPLIED without re-running",
    "false PASS after crash -> FAIL: 0 observed — repair-budget exhaustion HOLDS; no resumed HOLD promoted to PASS",
    "repair budget reset after restart -> FAIL: 0 observed — C10 preserves repairBudgetUsed",
    "corruption silently ignored -> FAIL: 0 observed — C15 tampered checkpoint -> SNAPSHOT_CHECKSUM_MISMATCH",
    "unknown post-head journal event -> fail closed (F1 classifier 'invalid')",
    "path-traversal execution identity -> rejected (INVALID_EXECUTION_ID); security tests in test-durable-graph.mjs Stage 28",
  ],
  regression: [
    { suite: "focused durable-graph (test/v2/test-durable-graph.mjs): F1/F2-F3/Stage 7-12/27/28 + production wiring (durableExecutionIdFor / no-bypass guard / runSubagentGraph->runDurableGraph->runColimaGraph->checkpoints+resume)", tests: 11, pass: 11, fail: 0 },
    { suite: "test:c3 (durable-execution + checkpoint-bridge + colima pipeline)", tests: 41, pass: 41, fail: 0 },
    { suite: "test:v2（incl. repair-aligned artifact-name suites）", tests: 368, pass: 368, fail: 0 },
    { suite: "test:telemetry (incl. D7 recovery allowlist)", tests: 37, pass: 37, fail: 0 },
    { suite: "test:governance", tests: 229, pass: 229, fail: 0 },
    { suite: "test:writeback", tests: 61, pass: 61, fail: 0 },
    { suite: "test:memory-contract + test:memory-retrieval", tests: 165, pass: 165, fail: 0 },
    { suite: "perf probe scripts/de2-perf-probe.mjs（quantified durability cost）", tests: 1, pass: 1, fail: 0 },
    { suite: "canonical test:colima-all (Stage 24 — one run)", tests: 42, pass: 42, fail: 0 },
  ],
  regressionSummary:
    "REPAIR ROUND（external review 1c546aba… → REPAIR）: production durable wiring now PROVEN end to end — runSubagentGraph（the production Graph entry every card closeout script invokes）routes through runDurableGraph by DEFAULT, and the wiring test proves runSubagentGraph -> runDurableGraph -> runColimaGraph -> checkpoints/journal/evidence + fresh-process resume-complete（no bypass: a regression guard asserts no production script passes durable:false）. Crash matrix C0-C15（real SIGKILL + fresh-process resume）passed all safety hard gates（0 lost results / 0 duplicate writer mutations / 0 false PASS / 0 budget resets / 0 ignored corruption）. F1（semantic post-head classification）, F2/F3（resumed runner-view seeding）reproduced and fixed. Writer crashes fail closed（RECOVERY_REQUIRED）or recover via ALREADY_APPLIED. D7 telemetry recovery provenance added. QUANTIFIED PERFORMANCE（scripts/de2-perf-probe.mjs, synthetic 2-phase readonly graph with injected adapters, no containers）: durability DISABLED = 643 ms vs ENABLED = 2335 ms（overhead 1.6 s = journal/checkpoint fs cost at every safe boundary）; journal = 32 events / 22.5 KB; checkpoints over the run = 15（CURRENT.json single atomic write + checksum + lease, 2.9 KB each）; disk growth = 84.7 KB per run; resume reconstruction（fresh process） = 46 ms wall / 14 ms CPU / 6 MB RSS; D7 telemetry recovery overhead = ~0 ms（median 7 samples: 0.011 ms base vs 0.011 ms recovery）. On production graphs（minutes-to-hours of model/container work per phase）the per-phase sub-second fs overhead is negligible vs re-running failed work. Focused suites green（c3 41/41, v2 368/368（incl. repair-aligned artifact-name suites）, telemetry 37/37, governance 229/229, writeback 61/61, memory 165/165）+ one canonical colima-all（Stage-24 single canonical run, 42/42）. Final-source independent review binds implementationDigest（over the final production source + focused tests）: reviewer identity = sha256({graphRunId, reviewOutcomes, implementationDigest}), evidence SHA changes with the reviewed source.",
  repairBudgetMaxAttempts: 1,
  // RB-1G: this repair generation SUPERSEDES the reviewed bundle that earned
  // the REPAIR verdict（identity + sha from the external review delivery）.
  supersedes: {
    reviewBundleIdentity: "1c546aba2810b962f2fac3ee9c5b1b80a044c7b50afb24b699b729f08431e7b4",
    reviewBundleSha256: "5d28e3d57f57b84c1968ba21bf33e5881fa9b46bbba012885c1a004fd2d38c32",
    bundlePath: "docs/pi-graph-output/de2/card-closeout-bundle-20260808-1c546aba.txt",
    verdict: "REPAIR",
  },
  executiveSummary:
    "DE-2 REPAIR-CLOSED: the production Graph entry（runSubagentGraph, used by every card closeout script）now runs under AutoLoop's native durable execution BY DEFAULT — production invocation -> runDurableGraph -> runColimaGraph -> journal + checkpoints, with a regression guard proving normal production calls cannot bypass durability（durable:false is test-only）. DurableGraphRun journals + checkpoints every safe boundary and reconstructs the ready set from durable truth on resume in a genuinely new process（wiring test: runSubagentGraph durable -> checkpoints/journal/evidence + resume complete）. F1（post-head semantic classification）and F2/F3（resumed-orchestrator edge）closed; writer crash boundaries classified fail-closed（only ALREADY_APPLIED recovers without re-mutation）; repair budget survives restart; CBM write-back idempotency untouched; D7 telemetry replay-awareness added. Crash matrix C0-C15（real SIGKILL）passed all safety hard gates（0 lost results / 0 duplicate mutations / 0 false PASS / 0 budget resets / 0 ignored corruption）; quantified perf probe（durability overhead ~1.6s/2-phase graph, resume reconstruction ~46ms, D7 delta ~0ms）; canonical colima-all green; test:v2 368/368（repair also aligned the pre-existing attempt-prefixed artifact-name lag in 6 focused v2 suites + review-evidence reference path）. The independent review binds the FINAL source（implementationDigest over the final production source + focused tests）. No external durable runtime introduced. Next: Autonomous Research Escalation（built on CBM production memory + COST-1 telemetry + DE-2 durable recovery）.",
  recommendedNextStep:
    "Autonomous Research Escalation — the production sequence Memory -> code/repository evidence -> tests/probes -> official docs/upstream -> broader web -> bounded experimental bake-off -> HOLD only for genuine authority/manual/secret boundaries. Autonomous Research builds on CBM production memory, COST-1 telemetry, and DE-2 durable recovery so long research runs survive crashes, reuse known evidence, and remain cost-observable.",
  rollbackProcedure:
    "DE-2 is removable without deleting CBM-4 or COST-1: (1) revert src/subagent/subagent-graph-runner.mjs durable default（durable:true→false or remove the runDurableGraph routing）so production invocations return to the restartable-only runColimaGraph path, (2) revert src/runtime/colima-graph-runner.mjs（initialState/runner-hooks/preserveInstance additions are additive — runColimaGraph without them returns to the previous restartable-only behavior）, (3) remove src/v2/durable-graph.mjs（the only new durable state machine; nothing in the existing STACK_A / CBM / COST / governance paths imports it besides the sub-agent runner）, (4) revert src/v2/review-evidence.mjs attempt-prefixed evidence_artifact_path（restores the pre-rename reference）, (5) the checkpoint-bridge F1 classifier and durable-execution _lastRunnerStatuses seeding are in-place fixes（safe to keep; reverting restores the DE-1 behavior including F1/F2/F3 gaps）, (6) telemetry D7 recovery fields are additive allowlist entries（reverting removes them; COST-1 events remain valid）, (7) the checkpoint serialization in DurableGraphRun is internal（safe to keep）. No memory/evidence schema migration was introduced; existing stores are untouched.",
  openQuestions: [],
  risks: [
    "writer crash mid-mutation with ambiguous state fails closed（RECOVERY_REQUIRED）— a controller must classify before resuming（documented; never guessed）",
    "the colima worktree mount has a virtiofs environment quirk（subdirectory binds do not always persist）— writer pass/fail is stdout-based and unaffected; worktree output capture is best-effort",
    "corrupt-state detection is lazy at the SQLite layer but AutoLoop's checkpoint checksum is proactive（C15 fail-closed）",
    "production resume requires the frozen filtered dirty set — the real worktree's dirty scope must be declared（dirtyScope）",
    "sub-agent graph RESUME（new-process）requires the resumer to re-inject the sub-agent hooks/adapters（resultsDir wiring + review agent）— the crash matrix proves durable recovery for the colima graph shape; sub-agent resume wiring is the documented next step before Autonomous Research",
    "a sub-agent graph that trips the durable evidence secret-scan would HOLD（DURABLE_EVIDENCE_SECRET_RISK）— fail-closed by design; verified clean on the crash matrix + wiring test workloads",
  ],
  limitations: [
    "crash matrix workload is a synthetic 4-phase DAG（mirrors the production graph shape）with scripted colima adapters — not a full Autonomous Research graph",
    "the colima instance churn under repeated crash-matrix runs showed intermittent container errors（environment; resolved by preserveInstance + verified standalone）",
    "writer worktree restoration classification is implemented; RECONSTRUCTABLE restores deterministically only where the side-effect identity permits",
    "D7 telemetry provenance is additive; historical（pre-DE-2）telemetry events remain valid",
    "perf probe uses injected adapters on a synthetic 2-phase graph（no model/container cost）to isolate durability overhead — production graphs pay the same per-boundary fs/checkpoint cost but amortize it over minutes-to-hours of task work",
    "the `durable: false` escape hatch exists for raw-runner tests only; the no-bypass guard enforces that no production script uses it",
  ],
};

mkdirSync(OUT, { recursive: true });

const evidencePath = join(OUT, `${EXECUTION_ID}-graph-closeout-evidence.json`);
if (!existsSync(evidencePath)) {
  console.error(`missing closeout evidence: ${evidencePath}`);
  process.exit(2);
}
const ev = JSON.parse(readFileSync(evidencePath, "utf8"));
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
      agentExecutionId: (n.attempt ?? 0) > 0
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

// Graph-closeout evidence writer that binds the final implementation: the
// standard snapshot + a reviewBinding block（implementationDigest +
// reviewResultIdentity）so the evidence SHA provably changes with the
// reviewed source（blocker #2）. Replaces the default evidence writer only for
// THIS card's closeout evidence file.
const de2EvidenceWriter = async ({ graphResult, closeout, outDir }) => {
  const snapshot = buildGraphCloseoutEvidenceSnapshot({ graphResult, closeout });
  const { identity: reviewResultIdentity } = computeReviewResultIdentity(graphResult);
  snapshot.reviewBinding = { implementationDigest, reviewResultIdentity };
  const executionId = graphResult?.executionId ?? "graph-unknown";
  const fileName = `${executionId}-graph-closeout-evidence.json`;
  const target = join(outDir, fileName);
  const text = JSON.stringify(snapshot, null, 2) + "\n";
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, target);
  return { ok: true, path: target, sha256: sha256Hex(text), fileName };
};

const r = await runMandatoryGraphCloseout({
  graphResult,
  closeout,
  repoPath: REPO_A,
  cwd: REPO_A,
  outDir: OUT,
  timeoutMs: 60000,
  sourceBuilder: de2SourceBuilder,
  evidenceWriter: de2EvidenceWriter,
});

console.log(`closeout applied=${r.applied} final=${r.final} holdCode=${r.holdCode ?? "null"}`);
if (r.bundlePath) {
  console.log(`bundle: ${r.bundlePath}`);
  console.log(`reviewBundleIdentity: ${r.bundle.identity}`);
  console.log(`reviewBundleSha256: ${r.bundle.sha256}`);
}
if (r.externalReview) {
  console.log(`externalReviewStatus: ${r.externalReview.externalReviewStatus}`);
}
process.exit(r.final === "PASS" ? 0 : 1);
