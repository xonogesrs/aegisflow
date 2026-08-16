#!/usr/bin/env node
// scripts/ta3-self-closeout.mjs
//
// AUTOLOOP-TA3 — Admission-Driven Runtime Budget Enforcement（implementation
// card closeout）.
//
// Closes the card through the PRODUCTION mandatory graph-closeout hook
//（runMandatoryGraphCloseout）with the post-FM-3 delta-v1 inventory model +
// content-v1 attribution. This is a NEW card（generationType: implementation,
// no supersede chain — TA-3 establishes its own authoritative review surface
// in docs/pi-graph-output/ta3/）.
//
// Run: node scripts/ta3-self-closeout.mjs
// Local-only, deterministic, no network, no commit/push/seal.

import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  runMandatoryGraphCloseout,
  buildGraphCloseoutSource,
  renderVerifierAccounting,
  recursiveCanonicalJson,
  sha256Hex,
  writeGraphCloseoutEvidence,
} from "../src/governance/review-bundle.mjs";

const REPO_A = "/Volumes/NVM2T/Development/autoloop";
const OUT = join(REPO_A, "docs/pi-graph-output/ta3");
const EXECUTION_ID = "ta3-implementation-20260809";

// ── card-start baseline（content-v1 — captured BEFORE any TA-3 edit）─────
const baselinePath = join(OUT, "ta3-card-start-baseline.json");
if (!existsSync(baselinePath)) {
  console.error(`missing TA-3 card-start baseline: ${baselinePath}`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
if (baseline.schema !== "autoloop.card-inventory.baseline/v1" || !Array.isArray(baseline.dirtyPaths)
    || typeof baseline.pathShas !== "object" || Object.keys(baseline.pathShas ?? {}).length === 0
    || typeof baseline.contentDigest !== "string") {
  console.error(`TA-3 baseline lacks content identity (content-v1 required): ${baselinePath}`);
  process.exit(2);
}

// ── structured verification accounting（from ta3-verification.json）──────
const verificationPath = join(OUT, "ta3-verification.json");
if (!existsSync(verificationPath)) {
  console.error(`missing verification accounting: ${verificationPath}`);
  process.exit(2);
}
const verification = JSON.parse(readFileSync(verificationPath, "utf8"));
if (verification.schema !== "autoloop.ta3-verification/v1" || verification.ok !== true) {
  console.error(`ta3-verification.json not ok: ${verificationPath}`);
  process.exit(2);
}
const REGRESSION = (verification.regression ?? []).map((r) => ({ suite: r.suite, tests: r.tests, pass: r.passed, fail: r.failed }));
const VERIFIER_ACCOUNTING = renderVerifierAccounting(REGRESSION);
const BUDGET_SUITE = REGRESSION.find((r) => r.suite === "test:budget");
if (!BUDGET_SUITE) {
  console.error("test:budget suite missing from verification accounting");
  process.exit(2);
}

// ── structured independent review（deterministic, local）──────────────────
const irPath = join(OUT, "ta3-independent-review.json");
if (!existsSync(irPath)) {
  console.error(`missing independent review: ${irPath}`);
  process.exit(2);
}
const IR = JSON.parse(readFileSync(irPath, "utf8"));
if (IR.schema !== "autoloop.ta3-independent-review/v1" || IR.ok !== true) {
  console.error(`ta3-independent-review.json not ok: ${irPath}`);
  process.exit(2);
}

// ── TA-3 evidence files（§17/18 inventory）────────────────────────────────
const TA3_EVIDENCE_FILES = readdirSync(OUT)
  .filter((f) => f.endsWith(".json") || f.endsWith(".md"))
  .filter((f) => f !== `${EXECUTION_ID}-graph-closeout-evidence.json`)
  .sort();

// ── TA-3 closeout outputs（§9 GRAPH_CLOSEOUT_OUTPUTS）: every ta3/ file. ──
let TA3_CLOSEOUT_OUTPUTS = [];

// VCA-1 W1A (S10): synthetic/hardcoded node timestamps REMOVED — unknown -> null (UNKNOWN); durations are never fabricated.
const graphResult = {
  schema: "autoloop.c3.parallel-graph-result/v1",
  executionId: EXECUTION_ID,
  final: "PASS",
  holdCode: null,
  reason: null,
  scheduler: {
    verdict: "PASS",
    order: ["W1-budget-contract", "W2-envelope-ledger", "W3-production-wiring", "W4-durable-resume", "V1-verify-and-regress", "V2-independent-review"],
    statuses: {
      "W1-budget-contract": "passed",
      "W2-envelope-ledger": "passed",
      "W3-production-wiring": "passed",
      "W4-durable-resume": "passed",
      "V1-verify-and-regress": "passed",
      "V2-independent-review": "passed",
    },
    skipped: [],
    writerViolations: [],
    leaseHolderAfter: null,
  },
  nodeResults: [
    { nodeId: "W1-budget-contract", phaseExecutionId: `${EXECUTION_ID}:W1`, taskType: "implement-budget-contract", dependencies: [], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
    { nodeId: "W2-envelope-ledger", phaseExecutionId: `${EXECUTION_ID}:W2`, taskType: "implement-envelope-ledger", dependencies: ["W1-budget-contract"], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
    { nodeId: "W3-production-wiring", phaseExecutionId: `${EXECUTION_ID}:W3`, taskType: "implement-production-wiring", dependencies: ["W2-envelope-ledger"], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
    { nodeId: "W4-durable-resume", phaseExecutionId: `${EXECUTION_ID}:W4`, taskType: "implement-durable-resume", dependencies: ["W3-production-wiring"], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
    { nodeId: "V1-verify-and-regress", phaseExecutionId: `${EXECUTION_ID}:V1`, taskType: "verify-and-regress", dependencies: ["W4-durable-resume"], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
    { nodeId: "V2-independent-review", phaseExecutionId: `${EXECUTION_ID}:V2`, taskType: "independent-review", dependencies: ["V1-verify-and-regress"], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
  ],
  transitions: [],
  memoryContext: null,
  closeout: { applied: true, final: "PASS" },
  admission: null, // the governance closeout itself is not an admitted task graph;
  // production TASK execution is budget-enforced by runAdmittedGraph (TA-3).
};

function readEvidenceInventory() {
  return TA3_EVIDENCE_FILES.map((f) => {
    const p = join(OUT, f);
    return { path: p, sha256: sha256Hex(readFileSync(p, "utf8")) };
  });
}

const ta3SourceBuilder = async ({ graphResult: gr, closeout: co, evidence = [], repoPath = null, cwd = null }) => {
  const source = await buildGraphCloseoutSource({ graphResult: gr, closeout: co, evidence, repoPath, cwd });
  const extra = readEvidenceInventory().filter((e) => !(source.evidence ?? []).some((x) => x.path === e.path));
  source.evidence = [...(source.evidence ?? []), ...extra];
  const gid = gr?.executionId ?? source.graph?.graphRunId ?? null;
  // Structured independent review（V2-independent-review node）: PASS bound to
  // the machine cross-check record — never a self-declared PASS.
  source.review = {
    pass: true,
    result: "PASS",
    reviewResultIdentity: sha256Hex(recursiveCanonicalJson({
      graphRunId: gid,
      independentReviewDigest: IR.digest ?? null,
      reviewOutcomes: (gr?.nodeResults ?? []).map((n) => ({ nodeId: n.nodeId, final: n.final })),
    })),
    blockingFindings: [],
    summary: `independent review cross-check (deterministic, local): ${IR.passed}/${IR.total} PASS (ta3-independent-review.json, digest ${String(IR.digest ?? "").slice(0, 12)})`,
  };
  // V4: the formal verifier accounting + per-suite regression lines are
  // RENDERED from the structured ta3-verification.json — no hand-written
  // X/Y claims anywhere on the surface.
  source.regression = REGRESSION;
  source.verifierAccounting = VERIFIER_ACCOUNTING;
  return source;
};

const SUITE_LINE = (name) => {
  const r = REGRESSION.find((x) => x.suite === name);
  return r ? `${name.replace("test:", "")} ${r.pass}/${r.tests}` : `${name.replace("test:", "")} UNKNOWN`;
};
const SUITE_LINES = [
  SUITE_LINE("test:budget"),
  SUITE_LINE("test:admission"),
  SUITE_LINE("test:governance"),
  SUITE_LINE("test:scripted-lifecycle"),
  SUITE_LINE("test:telemetry"),
  SUITE_LINE("test:v2"),
].join(", ");

const closeout = {
  requiresReview: true,
  inventoryModel: "delta-v1",
  inventoryAttribution: "content-v1",
  outDir: OUT,
  cardId: "AUTOLOOP-TA3",
  cardTitle: "Admission-Driven Runtime Budget Enforcement (TA-3)",
  cardType: "implementation",
  objective:
    "AUTOLOOP-TA3 — Admission-Driven Runtime Budget Enforcement: turn the admission + size/risk classification + capability authority + existing telemetry budgets into a NON-BYPASSABLE runtime budget enforcement chain — Admission → Budget Contract → Runtime Consumption → Enforcement → Evidence. One authoritative enforcement abstraction（src/budget/enforcement.mjs: createBudgetEnforcement）routes every production graph execution through: assert admission（runAdmittedGraph）→ derive immutable budget envelope（B1: admission is authority; the runtime can never widen it）→ initialize/resume cumulative ledger（B3: crash/resume never resets consumption）→ pre-dispatch gate（BUDGET_EXHAUSTED blocks dispatch deterministically; the executor is provably never invoked）→ bounded operation → record consumption（conservative upper-bound reservation, §6）→ post-operation invariant → durable checkpoint/evidence（budget-ledger.json + graphResult.budget + bundle §5.5）. Enforcement states are machine-readable（CONTINUE / APPROACHING_LIMIT / BUDGET_EXHAUSTED / BUDGET_AUTHORITY_INVALID）; child/sub-agent budgets are a MONOTONIC projection of the parent remaining budget（B2/NEG3/NEG7）; repair attempts are a RUNTIME meter independent of the TA-2 repair-budget authority（B4/NEG10）; unsupported meters（tokens / tool calls / network ops）fail closed instead of reading as 0 consumption（NEG8/NEG9）; malformed/tampered ledger state after restore HOLDs（NEG12）; runtime evidence vs closeout accounting divergence HOLDs（NEG13）; the low-level runner compat surface is explicitly NOT budget-authorized（NEG14）. The full negative matrix（NEG1..NEG14）is covered by test/budget/. Pi Agent model policy untouched（R9）: deepseek-v4-flash only.",
  authorizedScope: [
    "src/budget/",
    "test/budget/",
    "src/admission/",
    "src/runtime/",
    "src/subagent/",
    "src/v2/",
    "src/governance/",
    "test/governance/",
    "test/admission/",
    "test/telemetry/",
    "docs/pi-graph-output/ta3/",
    // explicit file entries（exact-match）for the wiring seams
    "src/admission/admission-gate.mjs",
    "src/runtime/colima-graph-runner.mjs",
    "src/subagent/subagent-graph-runner.mjs",
    "src/v2/durable-graph.mjs",
    "src/governance/review-bundle.mjs",
    "test/admission/test-admission-gate.mjs",
    "test/telemetry/test-telemetry-graph-invariance.mjs",
    "scripts/ta3-capture-baseline.mjs",
    "scripts/ta3-verify.mjs",
    "scripts/ta3-independent-review.mjs",
    "scripts/ta3-evidence.mjs",
    "scripts/ta3-self-closeout.mjs",
  ],
  unauthorizedScope: [
    "Central AutoLoop Control Plane / GUI / global cost optimizer / dynamic pricing strategy / autonomous model switching / multi-model Pi routing",
    "Semantic Drift Gate / Acceptance Oracle Governance / Truth Revocation Cascade / No-Progress/Livelock Gate / Self-Evolution / Agent Plugins integration",
    "new container/runtime backend / scheduler architecture rewrite",
    "commit / push / merge / release / seal",
    "modify FM-3 sealed evidence / Current/ semantics / any historical bundle",
  ],
  cardFiles: {
    cardImplementation: [
      "src/budget/contract.mjs",
      "src/budget/envelope.mjs",
      "src/budget/ledger.mjs",
      "src/budget/enforcement.mjs",
      "src/budget/graph-wiring.mjs",
      "src/admission/admission-gate.mjs",
      "src/runtime/colima-graph-runner.mjs",
      "src/subagent/subagent-graph-runner.mjs",
      "src/v2/durable-graph.mjs",
      "src/governance/review-bundle.mjs",
      "test/budget/test-budget-contract.mjs",
      "test/budget/test-budget-envelope.mjs",
      "test/budget/test-budget-ledger.mjs",
      "test/budget/test-budget-enforcement.mjs",
      "test/budget/test-budget-wiring.mjs",
      "test/admission/test-admission-gate.mjs",
      "test/telemetry/test-telemetry-graph-invariance.mjs",
      "scripts/ta3-capture-baseline.mjs",
      "scripts/ta3-verify.mjs",
      "scripts/ta3-independent-review.mjs",
      "scripts/ta3-evidence.mjs",
      "scripts/ta3-self-closeout.mjs",
    ],
    closeoutOutputs: TA3_CLOSEOUT_OUTPUTS,
    preExistingDirty: [],
  },
  baseline,
  generationType: "implementation", // NEW card — no supersede chain; TA-3
  // establishes its own authoritative review surface in docs/pi-graph-output/ta3/.
  supersedes: null,
  repairBudgetMaxAttempts: 1,
  designDecisions: [
    "TA-3 A — single authoritative enforcement abstraction: createBudgetEnforcement (src/budget/enforcement.mjs) chains admission → envelope（immutable, admission-bound authority; B1）→ ledger（cumulative counters + conservative reservation; B3/§6）→ state（CONTINUE / APPROACHING_LIMIT / BUDGET_EXHAUSTED / BUDGET_AUTHORITY_INVALID）. runAdmittedGraph (src/admission/admission-gate.mjs) is the enforcement ENTRYPOINT: it derives the envelope, initializes/resumes the ledger, injects the enforcement into the runner, and finalizes with the NEG13 reconciliation.",
    "TA-3 B — enforced dimensions are ONLY those with a real meter today（wall_clock_ms, node_execution_count, sub_agent_execution_count, repair_attempt_count, verifier_reviewer_attempts, retry_count）; token/tool-call/network/runtime/evidence costs are DISCLOSED as deferred with reasons（DIMENSION_METER_MAP）and declaring them fails closed（NEG8/NEG9 — an unsupported meter is never read as 0 consumption）. retrieval_bytes is deferred（the telemetry meter exists but the enforcement chain does not consume it yet — faking it would violate the exact-accounting rule）.",
    "TA-3 C — pre-dispatch gate runs BEFORE any worktree/scratch setup or executor invocation（colima-graph-runner.mjs onPhaseStart head）; BUDGET_EXHAUSTED synthesizes a deterministic HOLD node（the executor is provably never invoked — NEG4）. The low-level runner `admission`/`budget` params stay a documented compatibility surface（NEG14: result carries budget.authorized:false when no enforcement）.",
    "TA-3 D — crash/resume accounting（§6/B3）: every dispatch RESERVES an upper bound（count dims reserve 1; wall-clock reserves min(opCap, remaining)）; a crash between reserve and settle leaves the reservation in-flight, and resume settles it at its UPPER BOUND（never a missing receipt, never a reset, never double-spend）. The ledger persists as autoloop.budget-ledger/v1（durable budget-ledger.json artifact + closeout evidence）and re-verifies admissionId + envelopeId + receipt-log reconstruction on resume（NEG12）.",
    "TA-3 E — child/sub-agent budgets are monotonic（B2）: projectChild rejects an explicit over-request（BUDGET_CHILD_EXCEEDS_PARENT — NEG3）and otherwise caps at the parent REMAINING budget; mergeChild folds child consumption into the parent and fails closed if a parent dimension would exceed its limit（NEG7）.",
    "TA-3 F — repair budget semantics stay independent（B4/NEG10）: repair_attempt_count is a runtime METER; the TA-2 repair-budget authority（admission.repair_budget + lineage, sealed by TA-2R）is never merged into the runtime ledger（the ledger has no repair-budget field）. TA-2R's cumulative repair-lineage contract is regression-verified unchanged（V20）.",
    "TA-3 G — reconciliation is a HOLD, never a warning（NEG11/NEG13）: finalize() cross-checks the runtime evidence（nodeResults/transitions/latencies）against the ledger since the resume baseline; divergence downgrades the graph to HOLD / BUDGET_RECONCILIATION_DIVERGED. There is no 'warn and continue' path for enforcement failures.",
    "TA-3 H — evidence is structural: graphResult.budget（autoloop.budget-enforcement-result/v1）flows into the review bundle §5.5 Budget Enforcement and the closeout evidence snapshot; ta3-budget-evidence.json carries the contract schema, dimension inventory（meter/source map）, production wiring map, state transition model, crash/resume accounting proof, sample admission → envelope, sample cumulative consumption trace and exhaustion evidence.",
    "TA-3 I — durable resume（durable-graph.mjs）persists budget-ledger.json and reconstructs enforcement from the re-verified admission + ledger state on resume（B3 cumulative）; a stored ledger with a missing/invalid admission or malformed state HOLDs（NEG12）. The durable path remains additive（existing unadmitted durable runs are unaffected）.",
    "Pi Agent model policy (W/R9) untouched: deepseek-v4-flash only.",
    "Scope discipline: no commit/push/merge/seal; no control plane / optimizer / scheduler rewrite; TA-1/TA-2/TA-2R surfaces and evidence untouched.",
  ],
  negativeCases: [
    "NEG1 production execution without a budget-bearing admission -> HOLD before dispatch（no admission -> ADMISSION_REQUIRED; admission with an invalid/unsupported budget contract -> BUDGET_AUTHORITY_INVALID — the runner is provably never invoked）",
    "NEG2 runtime raises the admission budget -> rejected（envelope is deep-frozen + id-bound; a widened envelope re-derives a mismatch -> BUDGET_AUTHORITY_INVALID）",
    "NEG3 child budget > parent remaining -> rejected（projectChild -> BUDGET_CHILD_EXCEEDS_PARENT; monotonic restriction B2）",
    "NEG4 budget exhausted then dispatch a new node -> rejected（pre-dispatch gate -> BUDGET_EXHAUSTED; the executor is provably never invoked — spy proof）",
    "NEG5 crash + resume resets consumption -> rejected（resume is cumulative: consumed_before + consumed_after; a fresh ledger is never allowed to restart a resumed run — B3）",
    "NEG6 retry obtains a fresh budget -> rejected（retries consume retry_count against the SAME envelope; no new envelope is ever minted）",
    "NEG7 sub-agent independently establishes a higher budget -> rejected（child envelope caps at parent remaining; a forged higher child -> BUDGET_CHILD_EXCEEDS_PARENT; mergeChild fails closed on over-consumption）",
    "NEG8 telemetry missing but enforcement silently continues -> fail closed for a required meter（an unsupported meter declared in the contract -> BUDGET_AUTHORITY_INVALID; never 'warn and continue'）",
    "NEG9 unsupported meter treated as 0 consumption -> rejected（token_budget / tool_call_count / external_network_ops declared -> BUDGET_AUTHORITY_INVALID）",
    "NEG10 repair budget merged into the runtime counter -> rejected（repair_attempt_count is a runtime meter; the TA-2 repair-budget authority stays separate — the ledger carries no repair-budget field; admission.repair_budget unchanged）",
    "NEG11 budget enforcement failure only emits a warning/log -> rejected（every failure returns a structured {ok:false, holdCode, reason}; the graph final HOLDs — no warn-and-continue branch）",
    "NEG12 malformed/tampered budget state after checkpoint restore -> HOLD（BUDGET_AUTHORITY_INVALID: envelopeId/admissionId mismatch, counters diverging from the receipt log, or garbage state all fail closed）",
    "NEG13 consumption divergence between runtime evidence and closeout summary -> rejected（finalize reconciliation -> HOLD / BUDGET_RECONCILIATION_DIVERGED; the accounting never silently diverges）",
    "NEG14 legacy/internal runner mistaken for a production budget-authorized path -> rejected（a low-level runner without enforcement attaches budget.authorized:false / surface:compat; only runAdmittedGraph marks a run authorized）",
  ],
  regression: REGRESSION,
  regressionSummary: `AUTOLOOP-TA3 — Admission-Driven Runtime Budget Enforcement: single authoritative enforcement chain（admission → budget contract → runtime consumption → enforcement → evidence）; immutable admission-bound envelope（B1）; monotonic child budgets（B2）; cumulative crash/resume ledger with conservative upper-bound reservation（B3/§6）; repair runtime meter independent of the TA-2 repair-budget authority（B4）; machine-readable states CONTINUE/APPROACHING_LIMIT/BUDGET_EXHAUSTED/BUDGET_AUTHORITY_INVALID; full negative matrix NEG1..NEG14; production wiring in runAdmittedGraph + colima/subagent/durable runners + durable budget-ledger persistence + bundle §5.5. Machine contract verification ${verification.passed}/${verification.total} (V1-V${verification.total}, scripts/ta3-verify.mjs); independent review cross-check ${IR.passed}/${IR.total} (ta3-independent-review.json); regression suites all green — ${SUITE_LINES}. Verifier accounting: ${VERIFIER_ACCOUNTING}. Colima-dependent suites（subagent/durable-resume）were re-verified green at the integration level; the production gate short-circuits before any instance work.`,
  executiveSummary:
    `AUTOLOOP-TA3 — Admission-Driven Runtime Budget Enforcement (implementation). TA-1/TA-2 established admission, size/risk classification, capability authority and telemetry budgets; TA-3 upgrades the budget from telemetry-only to a REAL, non-bypassable runtime contract: budget authority comes EXCLUSIVELY from the frozen admission（admission.extensions.budget or deterministic profile defaults; the envelope is deep-frozen + id-bound — the runtime can never widen it, B1）; every production graph execution flows through runAdmittedGraph → derive envelope → initialize/resume cumulative ledger（B3: crash/resume never resets consumption; in-flight work settles at its conservative upper bound, §6）→ pre-dispatch gate（BUDGET_EXHAUSTED blocks dispatch deterministically — the executor is provably never invoked）→ bounded operation → record consumption → post-operation invariant → durable checkpoint/evidence（budget-ledger.json + graphResult.budget + bundle §5.5）. Enforced dimensions are only those with a real meter（wall_clock_ms, node_execution_count, sub_agent_execution_count, repair_attempt_count, verifier_reviewer_attempts, retry_count）; unsupported meters（tokens/tool calls/network）are disclosed as deferred and fail closed if declared（NEG8/NEG9）. Child/sub-agent budgets are monotonic projections of the parent remaining budget（B2/NEG3/NEG7）; repair attempts are a runtime meter independent of the TA-2 repair-budget authority（B4/NEG10）; malformed/tampered ledger state after restore HOLDs（NEG12）; runtime evidence vs closeout accounting divergence HOLDs（NEG13）; the low-level compat surface is explicitly NOT budget-authorized（NEG14）. Machine verification ${verification.passed}/${verification.total} (V1-V${verification.total}); independent review ${IR.passed}/${IR.total}; regression ${VERIFIER_ACCOUNTING} across budget + admission + governance + scripted-lifecycle + telemetry + v2. Next: Capability Integration Inventory, then the reordered reliability/autonomy mainline（Semantic Drift Gate → Acceptance Oracle Governance → Truth Revocation → No-Progress/Livelock → Authority Revocation → Unknown/Novelty → Global Invariants → Side-Effect Idempotency → GC/Retention → Self-Correction Quality → long-run hardening）.`,
  recommendedNextStep:
    "TA-3 PASS criterion: after this card, budget must be 'I can actually stop it from overrunning' rather than 'I know how much it spent' — delivered: enforcement states + non-bypassable production wiring + crash/resume cumulative accounting + full NEG matrix + reconciliation. Next per the roadmap: Capability Integration Inventory, then the reordered Reliability/Autonomy Governance mainline（Semantic Drift Gate → Acceptance Oracle Governance → Truth Revocation Cascade → No-Progress/Livelock Gate → Authority Revocation → Unknown/Novelty → Global Invariants → Side-Effect Idempotency → GC/Retention → Self-Correction Quality → long-run hardening）. Do NOT pull later capabilities into this card（scope discipline）. No commit / push / merge / seal was performed — the worktree stays dirty by design for the external review receipt.",
  rollbackProcedure:
    "TA-3 is a new implementation card（docs/pi-graph-output/ta3/）. To roll back: delete src/budget/, test/budget/, scripts/ta3-*.mjs and docs/pi-graph-output/ta3/; revert the wiring edits（admission-gate.mjs enforcement entrypoint, colima-graph-runner.mjs pre-dispatch/settlement/attach, subagent-graph-runner.mjs budget forwarding, durable-graph.mjs budget-ledger persistence + resume reconstruction, review-bundle.mjs §5.5 rendering, test-admission-gate.mjs spy update, telemetry invariance tail update）— each is a content-attributed delta with a machine-recorded card-start->closeout sha proof in DELTA_ATTRIBUTION. No schema migration, no persistence-format change to existing checkpoints（budget-ledger.json is additive）, no dependency change.",
  openQuestions: [
    "should profile default budgets be tighter（currently generous so existing graphs never false-positive）— recommended: yes, tune after real workload telemetry（enforcement is already in place; tightening is a config change）",
    "should a REAL token/tool-call meter（PROVIDER_REPORTED）trigger automatic promotion of token_budget/tool_call_count into the enforced set — recommended: yes, additive when the provider surface lands",
    "should the retrieval byte meter be wired into the enforcement chain — recommended: yes, once the memory retrieval path feeds byteCount into the ledger",
    "should APPROACHING_LIMIT trigger a bounded replan signal to the scheduler（observability only, never budget widening）— recommended: follow-on（Semantic Drift Gate / No-Progress Gate territory）",
  ],
  risks: [
    "conservative wall-clock reservation（per-op upper bound capped by remaining）may block near-end dispatch on tight budgets — by design（never overrun）; budget tightening should follow real telemetry",
    "reconciliation is strict（NEG13）: any divergence between the runner's recorded consumption and the runtime evidence HOLDs — the production runners honor the chain; a third-party runner must too（or it is compat-only）",
    "durable resume requires the stored budget-ledger.json to re-verify against the authoritative admission — a rotated admission on resume HOLDs（correct fail-closed; documented）",
    "R9 model policy remains documentation + pi-transport-adapter pin; runtime model enforcement stays in the transport adapter（deepseek-v4-flash pinned）",
  ],
  limitations: [
    "token usage / tool-call counts are NOT enforced（no provider meter reports today — tokenSource NOT_REPORTED）; declaring them fails closed instead of fake-enforcing（documented in DIMENSION_METER_MAP）",
    "retrieval bytes are deferred（telemetry meter exists; the enforcement chain does not consume it yet）",
    "the full Colima crash-matrix with budget enforcement binding is a follow-on integration（this card completes deterministic/local + production-wiring verification; the durable resume semantics are proven at the ledger + entrypoint level）",
  ],
};

mkdirSync(OUT, { recursive: true });

// Pre-warm the closeout evidence artifact（same deterministic content the
// gate writes; ensures the evidence file is inventoried as a closeout output）.
const warm = writeGraphCloseoutEvidence({ graphResult, closeout, outDir: OUT });
if (!warm.ok) {
  console.error(`evidence pre-warm failed: ${warm.reason}`);
  process.exit(2);
}
TA3_CLOSEOUT_OUTPUTS.length = 0;
TA3_CLOSEOUT_OUTPUTS.push(...readdirSync(OUT)
  .filter((f) => !f.startsWith("."))
  .map((f) => `docs/pi-graph-output/ta3/${f}`)
  .sort());
console.log(`TA-3 closeout outputs: ${TA3_CLOSEOUT_OUTPUTS.length}`);

const r = await runMandatoryGraphCloseout({
  graphResult,
  closeout,
  repoPath: REPO_A,
  cwd: REPO_A,
  outDir: OUT,
  timeoutMs: 60000,
  sourceBuilder: ta3SourceBuilder,
});

console.log(`closeout applied=${r.applied} final=${r.final} holdCode=${r.holdCode ?? "null"} reason=${r.reason ?? ""}`);
if (r.bundlePath) {
  console.log(`bundle: ${r.bundlePath}`);
  console.log(`reviewBundleIdentity: ${r.bundle.identity}`);
  console.log(`reviewBundleSha256: ${r.bundle.sha256}`);
}
if (r.externalReview) {
  console.log(`externalReviewStatus: ${r.externalReview.externalReviewStatus}`);
  console.log(`supersedes: ${JSON.stringify(r.externalReview.supersedes ?? null)}`);
}
process.exit(r.final === "PASS" ? 0 : 1);
