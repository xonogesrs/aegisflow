// scripts/de1r-self-closeout.mjs
//
// DE-1R（AUTOLOOP-PI-GRAPH-DE1R）— External Candidate Live Prototype Bake-off:
// research-card closeout.
//
// The DE-1R research (live Temporal deployment + real-SIGKILL failure classes
// S0-S6 + Restate Stage-13 disposition + selection rubric) was executed by the
// agent directly and its evidence is in docs/pi-graph-output/de1r/. This script
// formalizes that completed research into the review bundle through the
// PRODUCTION mandatory graph-closeout hook (runMandatoryGraphCloseout) using
// the regenerate-style graph result (mirrors scripts/de1-self-closeout.mjs
// --regenerate), then prints the bundle identity for external review delivery.
//
// Run: node scripts/de1r-self-closeout.mjs

import { homedir } from "node:os";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stageAgentExecutionId, agentExecutionIdFor } from "../src/subagent/subagent-contract.mjs";
import { runMandatoryGraphCloseout, buildGraphCloseoutSource, recursiveCanonicalJson, sha256Hex } from "../src/governance/review-bundle.mjs";

const HOME = homedir();
const REPO_A = "/Volumes/NVM2T/Development/repos/autoloop";
const OUT = join(REPO_A, "docs/pi-graph-output/de1r");
const EXECUTION_ID = "de1r-self-closeout-20260808";

// ── DE-1R evidence files（Section 17/18 inventory）─────────────────────────
const DE1R_EVIDENCE_FILES = [
  "de1r-deployment.json",
  "de1r-bakeoff-results.json",
  "de1r-restate-disposition.json",
  "de1r-comparison.json",
  "de1r-decision.json",
];

function readEvidenceInventory() {
  const out = [];
  for (const f of DE1R_EVIDENCE_FILES) {
    const p = join(OUT, f);
    if (existsSync(p)) out.push({ path: p, sha256: sha256Hex(readFileSync(p, "utf8")) });
  }
  return out;
}

const de1rSourceBuilder = async ({ graphResult, closeout: co, evidence = [] }) => {
  const source = await buildGraphCloseoutSource({ graphResult, closeout: co, evidence });
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
  cardId: "AUTOLOOP-PI-GRAPH-DE1R",
  cardTitle: "External Candidate Live Prototype Bake-off (DE-1R)",
  cardType: "research",
  objective:
    "Complete the DE-1 bake-off by running the external candidates as LIVE runtimes under the same failure classes: deploy Temporal as a minimal local isolated server (SQLite), run the same 4-phase DAG with real-SIGKILL injection (crash during node / result-persisted-successor-unscheduled / writer side-effect boundary / duplicate recovery / corrupt-state equivalent), measure correctness / recovery latency / duplicates / footprint / operational complexity, adjudicate Restate under the Stage 13 security gate (eliminate by gate with written proof, or run it), then re-apply the SAME selection rubric and finalize the DE-1 provisional selection.",
  authorizedScope: ["docs/pi-graph-output/de1r/", "scripts/de1r-*.mjs", "test/v2/test-durable-*.mjs"],
  unauthorizedScope: [
    "production durable runtime replacement",
    "external runtime as a production dependency",
    "production Colima / Graph runner / scheduler / writer / memory / telemetry changes",
    "modifying DE-1 evidence files",
    "entering DE-2 hardening (waits for this card to close)",
    "commit / push / merge / seal",
  ],
  cardFiles: {
    cardImplementation: [
      "scripts/de1r-bakeoff.mjs",
      "scripts/de1r-worker.mjs",
      "scripts/de1r-workflow.mjs",
      "scripts/de1r-activities.mjs",
      "scripts/de1r-self-closeout.mjs",
    ],
    closeoutOutputs: [
      "docs/pi-graph-output/de1r/de1r-self-closeout-20260808-graph-closeout-evidence.json",
      ...DE1R_EVIDENCE_FILES.map((f) => `docs/pi-graph-output/de1r/${f}`),
    ],
    preExistingDirty: [],
  },
  designDecisions: [
    "DE-1R closes the single DE-1 blocker: external candidates were research-only in DE-1. Temporal was deployed as a LIVE local isolated dev server (CLI 1.8.2 / server 1.31.2, SQLite, localhost only) with temporalio@1.9.3 SDK in an isolated harness dir (NOT the repo; no production dependency).",
    "bake-off harness (scripts/de1r-*.mjs): same 4-phase DAG shape as DE-1 (ro1->ro2->writer->verifier); activities append to an append-only side-effect marker log + writer artifact; real SIGKILL of the worker process; per-scenario task queue + side-effect log for hermetic isolation.",
    "failure classes (mirror DE-1): S1 crash during node (kill mid-ro1); S2 result persisted / successor not scheduled (kill after ro1); S3 writer side-effect boundary RAW (kill after mutation -> retry -> duplicate, FAIL_DUPLICATE); S4 writer side-effect boundary idempotent (commit-token pattern -> exactly-once, PASS); S5 duplicate recovery (workflowId reuse policies); S6 corrupt state (corrupt SQLite history copy).",
    "Restate Stage-13 adjudication: @restatedev/restate-server@1.7.3 depends on @scarf/scarf@^1.4.0 (default phone-home analytics) — BLOCKER — and is BSL-licensed — HIGH. The gate is a hard REJECTION rule; the candidate is eliminated BY GATE with written proof, not by omission (de1r-restate-disposition.json).",
    "Temporal measured findings: automatic re-dispatch + deterministic replay, zero lost completed results; at-least-once activities re-execute ENTIRE activities from scratch after a mid-activity kill (S3 duplicates the committed writer side effect unless the app implements an idempotency pattern — S4); workflowId reuse gives NO automatic exactly-once invocation guard after completion (S5); SQLite detects corruption but the server validates lazily on access, not proactively (S6).",
    "footprint (measured): 1 server process (196MB RSS) + SQLite (1.6MB) + 3 listeners (7233/8233/61177) + 1 worker process + 154 SDK packages vs STACK_A = 0 added services.",
    "selection (de1r-decision.json): PASS / EXISTING_DURABLE_EXECUTION_SELECTED — the DE-1 provisional selection (EXISTING AUTOLOOP LEADS) is FINALIZED by measurement. Temporal's recovery improvement (automatic re-dispatch/replay) does not offset the server+DB+deterministic-constraints cost for AutoLoop's graph model; the writer-dedup burden is not removed by Temporal (it is relocated to app code that DE-2 would add to STACK_A anyway); F1/F2/F3 remain bounded in-process DE-2 fixes.",
  ],
  negativeCases: [
    "silent duplicate writer mutation -> Temporal RAW (S3): OBSERVED 1 duplicate on mid-activity kill (activity re-executed) — the framework does NOT protect the writer side-effect boundary by default",
    "silent lost completed result -> FAIL (hard gate): NOT observed — server history verified each phase completed exactly once in all scenarios",
    "false PASS -> FAIL (hard gate): NOT observed",
    "duplicate recovery invocation -> STACK_A returns COMPLETE with zero re-execution (DE-1 T11); Temporal default workflowId reuse starts a NEW execution after completion (S5) — no automatic guard",
    "corrupt state -> STACK_A rejects tampered checkpoint at resume (fail-closed, DE-1 T12); Temporal/SQLite detects corruption via integrity_check but the server fails lazily on access (S6) — no wrong data in either",
    "Restate server telemetry (Scarf) -> REJECTED under Stage 13 (re-verified live 2026-08-08)",
  ],
  regression: [
    { suite: "DE-1R live Temporal bake-off (S0-S6, real SIGKILL)", tests: 7, pass: 6, fail: 1, note: "S3 FAIL_DUPLICATE is the documented RAW at-least-once finding (writer duplicate on mid-activity kill), not a harness defect; S4 proves the idempotent pattern removes it" },
    { suite: "server history verification (temporal workflow show per scenario)", tests: 7, pass: 7, fail: 0 },
    { suite: "DE-1 existing suites (unchanged by DE-1R — research card, no production source touched)", tests: 0, pass: 0, fail: 0, note: "colima-all NOT re-run (per Stage 16 research-card rule)" },
  ],
  regressionSummary:
    "DE-1R closeout: Temporal ran LIVE under the same 4-phase DAG with real-SIGKILL failure injection (S0-S6). Safety: zero lost completed results, zero false PASS; server history verified exactly-once activity completion per phase. Recoverability: automatic re-dispatch + replay with recovery latencies 6.2-7.3s (dominated by full activity re-execution + 2s heartbeat timeout). Writer boundary: RAW at-least-once duplicated the committed side effect on mid-activity kill (S3, FAIL_DUPLICATE — the key measured finding); the idempotent commit-token pattern achieves exactly-once (S4, PASS). Duplicate recovery: no automatic workflowId guard after completion (S5). Corrupt state: SQLite detects corruption, server validates lazily (S6). Restate eliminated by Stage 13 gate (Scarf + BSL, re-verified live). Selection rubric re-applied: Temporal's recovery improvement does not offset server+DB+deterministic constraints for AutoLoop's graph model — PASS / EXISTING_DURABLE_EXECUTION_SELECTED, finalizing the DE-1 provisional selection. Next: DE-2 Native Durable Execution Hardening.",
  repairBudgetMaxAttempts: 1,
  executiveSummary:
    "DE-1R complete: Temporal was deployed as a LIVE local isolated server (CLI 1.8.2 / server 1.31.2 / temporalio@1.9.3, SQLite) and run under the same real-SIGKILL failure classes as DE-1 (crash during node / result-persisted-successor-unscheduled / writer side-effect boundary RAW + idempotent / duplicate recovery / corrupt state). Measured: automatic re-dispatch + deterministic replay with zero lost results; RAW at-least-once duplicates a committed writer side effect on mid-activity kill (idempotent pattern restores exactly-once — app-level code); no automatic workflowId dedup after completion; SQLite detects corruption but validation is lazy. Restate eliminated BY the Stage 13 gate (Scarf phone-home + BSL, re-verified live) with written proof. Footprint: 1 server process (196MB) + DB + 3 listeners vs zero for STACK_A. Selection rubric re-applied: PASS / EXISTING_DURABLE_EXECUTION_SELECTED — the DE-1 provisional selection (EXISTING AUTOLOOP LEADS) is FINALIZED by measurement. Next: DE-2 — Native Durable Execution Hardening.",
  recommendedNextStep:
    "DE-2 — Native Durable Execution Hardening: (1) wire STACK_A behind runColimaGraph (production Graph path durability), (2) complete the resume post-head whitelist (F1), (3) fix the resumed-orchestrator journal/revision edge (F2/F3), (4) telemetry replay-awareness (D7), (5) writer worktree restoration policy. Optional reference: Temporal's idempotency commit-token pattern (DE-1R S4) for DE-2 writer dedup. After DE-2, close DE-1 formally and proceed to Autonomous Research Escalation.",
  rollbackProcedure:
    "Research card — no production source changed. Remove scripts/de1r-*.mjs and docs/pi-graph-output/de1r/ if not retained as the DE-2 design basis. The Temporal dev server / SDK live ONLY in ~/.de1r (outside the repo); no runtime, dependency, or schema migration was introduced.",
  openQuestions: [],
  risks: [
    "Temporal's at-least-once activity semantics require app-level idempotency for writer side effects (S3) — the same dedup burden DE-2 must add to STACK_A",
    "no automatic workflowId exactly-once guard after completion (S5) — app-level idempotency keys required if duplicate invocation matters",
    "corrupt-state detection is lazy (SQLite) rather than proactive (S6)",
    "STACK_B (production Graph path) still has no durable checkpoint/resume — the single most important DE-2 item (unchanged by DE-1R)",
  ],
  limitations: [
    "Temporal was run as a dev server (single CLI process + SQLite), not a production multi-service deployment (Postgres/MySQL, TLS, namespaces) — the production footprint would be larger",
    "bake-off workload is a synthetic 4-phase DAG (mirrors the production graph shape) with scripted activities — not the full colima worker runtime",
    "Restate did not run a performance bake-off — it is eliminated by the Stage 13 gate with written proof (de1r-restate-disposition.json); if the Controller later adjudicates the gate as mitigable, Restate would need the same live bake-off",
    "durability engine decision is for the AutoLoop graph model's current needs; durable timers/signals/long-running requirements would change the calculus",
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

const r = await runMandatoryGraphCloseout({
  graphResult,
  closeout,
  repoPath: REPO_A,
  cwd: REPO_A,
  outDir: OUT,
  timeoutMs: 60000,
  sourceBuilder: de1rSourceBuilder,
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
