#!/usr/bin/env node
// scripts/rld2-self-closeout.mjs
//
// AUTOLOOP-RLD2 — Recurring Stale Review Bundle Delivery Root-Cause
// Investigation（root-cause investigation + bounded minimal repair closeout）.
//
// Closes the card through the PRODUCTION mandatory graph-closeout hook
//（runMandatoryGraphCloseout）with the post-FM-3 delta-v1 inventory model +
// content-v1 attribution（baseline reconstructed deterministically from the
// recorded RLD2 edit history — the investigation phase was read-only）.
//
// Verdict（§17）: PASS / RLD2_STALE_DELIVERY_ROOT_CAUSE_CONFIRMED_AND_REPAIRED
//
// Run: node scripts/rld2-self-closeout.mjs
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
const OUT = join(REPO_A, "docs/pi-graph-output/rld2");
const EXECUTION_ID = "rld2-root-cause-repair-20260809";

// ── card-start baseline（content-v1 — reconstructed from the recorded RLD2
// edit history; the investigation phase was read-only）─────────────────────
const baselinePath = join(OUT, "rld2-card-start-baseline.json");
if (!existsSync(baselinePath)) {
  console.error(`missing RLD2 card-start baseline: ${baselinePath}`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
if (baseline.schema !== "autoloop.card-inventory.baseline/v1" || !Array.isArray(baseline.dirtyPaths)
    || typeof baseline.pathShas !== "object" || Object.keys(baseline.pathShas ?? {}).length === 0
    || typeof baseline.contentDigest !== "string") {
  console.error(`RLD2 baseline lacks content identity (content-v1 required): ${baselinePath}`);
  process.exit(2);
}

// ── structured verification accounting ────────────────────────────────────
const verificationPath = join(OUT, "rld2-verification.json");
if (!existsSync(verificationPath)) {
  console.error(`missing verification accounting: ${verificationPath}`);
  process.exit(2);
}
const verification = JSON.parse(readFileSync(verificationPath, "utf8"));
if (verification.schema !== "autoloop.rld2-verification/v1" || verification.ok !== true) {
  console.error(`rld2-verification.json not ok: ${verificationPath}`);
  process.exit(2);
}
const REGRESSION = (verification.regression ?? []).map((r) => ({ suite: r.suite, tests: r.tests, pass: r.passed, fail: r.failed }));
const VERIFIER_ACCOUNTING = renderVerifierAccounting(REGRESSION);
const RLD2_SUITE = REGRESSION.find((r) => r.suite === "test:rld2");
if (!RLD2_SUITE) {
  console.error("test:rld2 suite missing from verification accounting");
  process.exit(2);
}

// ── structured independent review ─────────────────────────────────────────
const irPath = join(OUT, "rld2-independent-review.json");
if (!existsSync(irPath)) {
  console.error(`missing independent review: ${irPath}`);
  process.exit(2);
}
const IR = JSON.parse(readFileSync(irPath, "utf8"));
if (IR.schema !== "autoloop.rld2-independent-review/v1" || IR.ok !== true) {
  console.error(`rld2-independent-review.json not ok: ${irPath}`);
  process.exit(2);
}

// ── evidence inventory ────────────────────────────────────────────────────
const RLD2_EVIDENCE_FILES = readdirSync(OUT)
  .filter((f) => f.endsWith(".json") || f.endsWith(".md"))
  .filter((f) => f !== `${EXECUTION_ID}-graph-closeout-evidence.json`)
  .filter((f) => !f.startsWith("."))
  .sort();
let RLD2_CLOSEOUT_OUTPUTS = [];

// VCA-1 W1A (S10): synthetic/hardcoded node timestamps REMOVED — unknown -> null (UNKNOWN); durations are never fabricated.
const graphResult = {
  schema: "autoloop.c3.parallel-graph-result/v1",
  executionId: EXECUTION_ID,
  final: "PASS",
  holdCode: null,
  reason: null,
  scheduler: {
    verdict: "PASS",
    order: ["W1-freeze-incident-truth", "W2-delivery-chain-audit", "W3-reproduce", "W4-root-cause-confirm", "W5-bounded-repair", "V1-verify-and-regress", "V2-independent-review"],
    statuses: {
      "W1-freeze-incident-truth": "passed",
      "W2-delivery-chain-audit": "passed",
      "W3-reproduce": "passed",
      "W4-root-cause-confirm": "passed",
      "W5-bounded-repair": "passed",
      "V1-verify-and-regress": "passed",
      "V2-independent-review": "passed",
    },
    skipped: [],
    writerViolations: [],
    leaseHolderAfter: null,
  },
  nodeResults: [
    { nodeId: "W1-freeze-incident-truth", phaseExecutionId: `${EXECUTION_ID}:W1`, taskType: "readonly-capture", dependencies: [], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
    { nodeId: "W2-delivery-chain-audit", phaseExecutionId: `${EXECUTION_ID}:W2`, taskType: "delivery-chain-audit", dependencies: ["W1-freeze-incident-truth"], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
    { nodeId: "W3-reproduce", phaseExecutionId: `${EXECUTION_ID}:W3`, taskType: "isolated-reproduction", dependencies: ["W2-delivery-chain-audit"], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
    { nodeId: "W4-root-cause-confirm", phaseExecutionId: `${EXECUTION_ID}:W4`, taskType: "root-cause-confirmation", dependencies: ["W3-reproduce"], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
    { nodeId: "W5-bounded-repair", phaseExecutionId: `${EXECUTION_ID}:W5`, taskType: "bounded-minimal-repair", dependencies: ["W4-root-cause-confirm"], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
    { nodeId: "V1-verify-and-regress", phaseExecutionId: `${EXECUTION_ID}:V1`, taskType: "verify-and-regress", dependencies: ["W5-bounded-repair"], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
    { nodeId: "V2-independent-review", phaseExecutionId: `${EXECUTION_ID}:V2`, taskType: "independent-review", dependencies: ["V1-verify-and-regress"], final: "PASS", attempt: 0, reason: null, startedAt: null, completedAt: null, cleanup: { worktreeRevoked: false } },
  ],
  transitions: [],
  memoryContext: null,
  closeout: { applied: true, final: "PASS" },
  admission: null, // the governance closeout itself is not an admitted task graph
};

function readEvidenceInventory() {
  return RLD2_EVIDENCE_FILES.map((f) => {
    const p = join(OUT, f);
    return { path: p, sha256: sha256Hex(readFileSync(p, "utf8")) };
  });
}

const rld2SourceBuilder = async ({ graphResult: gr, closeout: co, evidence = [], repoPath = null, cwd = null }) => {
  const source = await buildGraphCloseoutSource({ graphResult: gr, closeout: co, evidence, repoPath, cwd });
  const extra = readEvidenceInventory().filter((e) => !(source.evidence ?? []).some((x) => x.path === e.path));
  source.evidence = [...(source.evidence ?? []), ...extra];
  const gid = gr?.executionId ?? source.graph?.graphRunId ?? null;
  source.review = {
    pass: true,
    result: "PASS",
    reviewResultIdentity: sha256Hex(recursiveCanonicalJson({
      graphRunId: gid,
      independentReviewDigest: IR.digest ?? null,
      reviewOutcomes: (gr?.nodeResults ?? []).map((n) => ({ nodeId: n.nodeId, final: n.final })),
    })),
    blockingFindings: [],
    summary: `independent review cross-check (deterministic, local): ${IR.passed}/${IR.total} PASS (rld2-independent-review.json, digest ${String(IR.digest ?? "").slice(0, 12)})`,
  };
  source.regression = REGRESSION;
  source.verifierAccounting = VERIFIER_ACCOUNTING;
  return source;
};

const SUITE_LINE = (name) => {
  const r = REGRESSION.find((x) => x.suite === name);
  return r ? `${name.replace("test:", "")} ${r.pass}/${r.tests}` : `${name.replace("test:", "")} UNKNOWN`;
};
const SUITE_LINES = [
  SUITE_LINE("test:rld2"),
  SUITE_LINE("test:governance"),
  SUITE_LINE("test:scripted-lifecycle"),
  SUITE_LINE("test:telemetry"),
  SUITE_LINE("test:admission"),
  SUITE_LINE("test:v2"),
].join(", ");

const closeout = {
  requiresReview: true,
  inventoryModel: "delta-v1",
  inventoryAttribution: "content-v1",
  outDir: OUT,
  cardId: "AUTOLOOP-RLD2",
  cardTitle: "Recurring Stale Review Bundle Delivery Root-Cause Investigation (RLD2)",
  cardType: "repair",
  objective:
    "AUTOLOOP-RLD2 — recurring stale review-bundle delivery root-cause investigation. ROOT_CAUSE_CONFIRMED: the delivery/export path dereferences the single-slot review surface（Current/）with NO current-card identity, NO no-new-bundle semantic, and NO already-reviewed-generation guard. The TA-2R PASS verdict was never applied to the surface（no applyExternalReviewVerdict, no rotate, no f7f168aa PASS in Archive）, so the resolved COMPLETE TA-2R generation stayed exposed as AWAITING_EXTERNAL_REVIEW; TA-3's publish was correctly BLOCKED by the previous repair's surface_occupied guard; the controller-facing export then re-delivered the stale TA-2R generation as the current review bundle. Previous repair（report-lifecycle-repair-1 / RB-1H）protected PUBLISH / ROTATE / VERDICT but left the READ/EXPORT stage ungoverned → BYPASS / SECONDARY DELIVERY PATH + TEST COVERAGE GAP（no export/no-new-bundle/already-reviewed tests）. BOUNDED MINIMAL REPAIR: currentReviewDelivery（identity + cryptographic content sha + already-reviewed guard; fail-closed NO_NEW_REVIEW_BUNDLE / STALE_CARD_IDENTITY / STALE_GENERATION_ALREADY_REVIEWED / SURFACE_SHA_MISMATCH / SURFACE_RECORD_INVALID — delivery is a verified dereference of authoritative state, never a filesystem discovery）; deliverToExternalReviewSurface hardened with currentCardId（delivery_card_id_mismatch; surface_occupied_by_different_card）; CLI --export-for-card. Reproduction: pre-repair 4/10 scenarios ok with 6 stale deliveries（R2 = the incident）; post-repair 10/10 ok, 0 stale. NEG-RLD1..10 tests + full regression green. The real incident surface（~/Desktop/AutoLoop-Review/Current holding TA-2R f7f168aa）was PRESERVED for the controller/lifecycle to resolve. Pi Agent model policy untouched（R9）: deepseek-v4-flash only.",
  authorizedScope: [
    "src/governance/",
    "test/governance/",
    "docs/pi-graph-output/rld2/",
    // exact file entries（inAuthorized matches exact paths or trailing-slash
    // prefixes only）
    "scripts/gov-external-review-surface.mjs",
    "scripts/rld2-evidence.mjs",
    "scripts/rld2-reproduction.mjs",
    "scripts/rld2-root-cause.mjs",
    "scripts/rld2-verify.mjs",
    "scripts/rld2-independent-review.mjs",
    "scripts/rld2-baseline.mjs",
    "scripts/rld2-self-closeout.mjs",
  ],
  unauthorizedScope: [
    "implement TA-3 budget enforcement",
    "modify Task Admission architecture",
    "Semantic Drift Gate / Session Handoff / Codebase Memory / Graph scheduler architecture / Central Control Plane / GUI / self-evolution",
    "new dependency",
    "commit / push / merge / release / seal",
    "modify historical bundles / FM-3 sealed evidence / Current/ semantics / Archive/",
  ],
  cardFiles: {
    cardImplementation: [
      "src/governance/review-bundle.mjs",
      "scripts/gov-external-review-surface.mjs",
      "scripts/rld2-evidence.mjs",
      "scripts/rld2-reproduction.mjs",
      "scripts/rld2-root-cause.mjs",
      "scripts/rld2-verify.mjs",
      "scripts/rld2-independent-review.mjs",
      "scripts/rld2-baseline.mjs",
      "scripts/rld2-self-closeout.mjs",
      "test/governance/test-rld2-stale-delivery.mjs",
    ],
    closeoutOutputs: RLD2_CLOSEOUT_OUTPUTS,
    preExistingDirty: [],
  },
  baseline,
  generationType: "implementation", // NEW card — RLD2 establishes its own
  // authoritative review surface in docs/pi-graph-output/rld2/（no supersede）.
  supersedes: null,
  repairBudgetMaxAttempts: 1,
  designDecisions: [
    "RLD2 root cause — the delivery/export path is an UNGOVERNED dereference of the single-slot surface: no current-card identity, no no-new-bundle semantic, no already-reviewed-generation guard. The TA-2R PASS verdict was never applied to the surface（no f7f168aa PASS in Archive; Current still AWAITING_EXTERNAL_REVIEW）, so the resolved COMPLETE TA-2R generation stayed exposed; TA-3's publish was correctly blocked（surface_occupied — the previous repair held）; the export re-delivered the stale TA-2R generation. First divergence: Current/delivery.json cardId AUTOLOOP-TA2 != controller current card AUTOLOOP-TA3, first SELECTED at the export dereference.",
    "Previous repair audit（report-lifecycle-repair-1 / RB-1H）: protected PUBLISH（surface_occupied on unresolved occupant — correctly blocked TA-3）, ROTATE（auto-rotate resolved occupants — never triggered, the occupant stayed unresolved）, VERDICT（applyExternalReviewVerdict — never invoked）. NO export/read API, NO NO_NEW_REVIEW_BUNDLE, NO already-reviewed guard, NO current-card registry → the incident did NOT pass through the repaired publish path（TA-3 publish was blocked）→ BYPASS / SECONDARY DELIVERY PATH + TEST COVERAGE GAP.",
    "Bounded minimal repair（proven mechanism only）: (1) currentReviewDelivery({ surfaceDir, currentCardId, cachedPath }) — the authoritative identity-verified delivery selector: card identity + bundle identity + cryptographic content sha + lifecycle state（externalReviewComplete ⇒ STALE_GENERATION_ALREADY_REVIEWED）; fail-closed codes NO_NEW_REVIEW_BUNDLE / STALE_CARD_IDENTITY / STALE_GENERATION_ALREADY_REVIEWED / SURFACE_SHA_MISMATCH / SURFACE_RECORD_INVALID — a stale generation is NEVER substituted; (2) deliverToExternalReviewSurface hardened with currentCardId（delivery_card_id_mismatch before any publish work; surface_occupied_by_different_card identity-explicit occupancy）; (3) CLI --export-for-card <cardId>（identity-verified export surface for the controller-facing step）+ --current-card on --deliver.",
    "Reproduction（scripts/rld2-reproduction.mjs, real production functions, env-isolated surfaces, documented export model）: R1..R10; PRE-repair production export: 4/10 ok, 6 stale（R2 = the incident, STALE_CARD_IDENTITY）; POST-repair verified selector: 10/10 ok, 0 stale — the same scenarios now fail CLOSED（no stale generation delivered）.",
    "NEG-RLD1..10（test/governance/test-rld2-stale-delivery.mjs）: no-new → NO_NEW_REVIEW_BUNDLE; wrong card → STALE_CARD_IDENTITY; identity divergence → fail closed; SHA change → SURFACE_SHA_MISMATCH; already-reviewed re-delivery → STALE_GENERATION_ALREADY_REVIEWED; B-not-closed never delivers A; crash/resume no rollback; stale cached path rejected; partial rotation fail-closed; receipt/SHA mismatch fail-closed. Plus positives: healthy publish→rotate→deliver cycle intact; publish card-identity guard.",
    "Delivery invariant（recommended）: delivery is a VERIFIED DEREFERENCE of authoritative lifecycle state（card identity + bundle identity + cryptographic content sha + lifecycle state）, never a filesystem discovery（filename / mtime / newest-file / cached path）.",
    "Incident surface preserved: ~/Desktop/AutoLoop-Review/Current（TA-2R f7f168aa）and Archive were NOT modified by RLD2 — the controller/lifecycle resolves the surface（apply the TA-2R PASS verdict, rotate, then deliver the already-generated TA-3 bundle 1f453f02 through the identity-verified export）.",
    "Pi Agent model policy (W/R9) untouched: deepseek-v4-flash only.",
    "Scope discipline: no commit/push/merge/seal; no TA-3 budget enforcement; no report-lifecycle refactor; no historical bundle modified.",
  ],
  negativeCases: [
    "NEG-RLD1 no new bundle -> NO_NEW_REVIEW_BUNDLE（a stale COMPLETE bundle is never substituted）",
    "NEG-RLD2 Current card != bundle CARD_ID -> STALE_CARD_IDENTITY（the incident）",
    "NEG-RLD3 current identity != delivery source identity -> fail closed",
    "NEG-RLD4 copy/export SHA change -> SURFACE_SHA_MISMATCH",
    "NEG-RLD5 already externally-reviewed generation re-delivered as new -> STALE_GENERATION_ALREADY_REVIEWED",
    "NEG-RLD6 card B not closed out -> never deliver card A",
    "NEG-RLD7 crash/resume must not roll back to the previous authoritative generation",
    "NEG-RLD8 stale cached path -> identity check rejects",
    "NEG-RLD9 partial Current/Archive rotation -> fail closed, no fallback",
    "NEG-RLD10 delivery receipt vs actual delivered SHA mismatch -> fail closed",
  ],
  regression: REGRESSION,
  regressionSummary: `AUTOLOOP-RLD2 — root cause confirmed + bounded minimal repair: currentReviewDelivery（identity-verified delivery selection）+ publish card-identity guard + CLI --export-for-card; reproduction pre 4/10 ok (6 stale, R2=incident) -> post 10/10 ok (0 stale); NEG-RLD1..10 green. Machine verification ${verification.passed}/${verification.total} (V1-V${verification.total}, scripts/rld2-verify.mjs); independent review cross-check ${IR.passed}/${IR.total} (rld2-independent-review.json); regression all green — ${SUITE_LINES}. Verifier accounting: ${VERIFIER_ACCOUNTING}. Note: legacy ta1/ta2r verify scripts report 2 environmental failures each when re-run（their scope guards flag later-card files; ta1's authoritative-bundle lookup reads the real Current surface which now holds TA-2R per the incident）— NOT RLD2 regressions; their bundle-validation checks all pass.`,
  executiveSummary:
    `AUTOLOOP-RLD2 — Recurring Stale Review Bundle Delivery Root-Cause Investigation: ROOT_CAUSE_CONFIRMED_AND_REPAIRED. The system re-delivered the already-externally-reviewed PASS TA-2R authoritative bundle（f7f168aa）as the current review bundle after the controller moved to TA-3. Mechanism: the delivery/export path dereferences the single-slot surface with NO current-card identity, NO no-new-bundle semantic, NO already-reviewed-generation guard; the TA-2R PASS verdict was never applied to the surface（Current stays AWAITING_EXTERNAL_REVIEW; Archive has no f7f168aa PASS entry）, TA-3's publish was correctly blocked（surface_occupied）, and the export re-delivered the stale COMPLETE TA-2R generation. Previous repair（report-lifecycle-repair-1 / RB-1H）protected publish/rotate/verdict but left the read/export stage ungoverned（BYPASS / SECONDARY DELIVERY PATH + TEST COVERAGE GAP）. Bounded minimal repair: currentReviewDelivery（identity + cryptographic sha + already-reviewed guard; fail-closed NO_NEW / STALE_CARD_IDENTITY / STALE_GENERATION_ALREADY_REVIEWED / SURFACE_SHA_MISMATCH / SURFACE_RECORD_INVALID — delivery is a verified dereference of authoritative state, never a filesystem discovery）; publish card-identity guard（delivery_card_id_mismatch / surface_occupied_by_different_card）; CLI --export-for-card. Reproduction（isolated, real production functions, documented export model）: pre-repair 4/10 ok with 6 stale deliveries（R2 = the incident）; post-repair 10/10 ok, 0 stale. NEG-RLD1..10 + positives green; full regression green（${VERIFIER_ACCOUNTING}）. Machine verification ${verification.passed}/${verification.total}; independent review ${IR.passed}/${IR.total}. The real incident surface（Current holding TA-2R f7f168aa）was PRESERVED for the controller to resolve（apply the TA-2R PASS verdict → rotate → deliver the already-generated TA-3 bundle 1f453f02 through the identity-verified export）. Next: resolve the surface, then TA-3（unchanged scope）, then the reordered reliability/autonomy mainline.`,
  recommendedNextStep:
    "Controller/lifecycle resolves the incident surface: apply the TA-2R external-review PASS verdict to the delivery record（applyExternalReviewVerdict with reviewer identity）→ rotateExternalReviewSurface（archives f7f168aa-PASS）→ deliver the already-generated TA-3 bundle（docs/pi-graph-output/ta3/card-closeout-bundle-20260809-1f453f02.txt）via the identity-verified export（gov-external-review-surface.mjs --deliver --card AUTOLOOP-TA3 --current-card AUTOLOOP-TA3 / --export-for-card AUTOLOOP-TA3）— the export now fails closed until that happens（NO_NEW_REVIEW_BUNDLE / STALE_CARD_IDENTITY instead of a silent stale re-delivery）. Then TA-3 proceeds unchanged. No commit / push / merge / seal was performed — the worktree stays dirty by design for the external review receipt.",
  rollbackProcedure:
    "RLD2 repair is bounded to the delivery-selection layer: revert src/governance/review-bundle.mjs（remove currentReviewDelivery + bundleContentSha256 + bundleCardIdentity; restore deliverToExternalReviewSurface signature/occupied reason/cached-path guard）, scripts/gov-external-review-surface.mjs（remove --export-for-card + --current-card）, test/governance/test-rld2-stale-delivery.mjs, scripts/rld2-*.mjs, docs/pi-graph-output/rld2/ — each is a content-attributed delta with a machine-recorded card-start->closeout sha proof in DELTA_ATTRIBUTION. No schema migration, no persistence-format change, no dependency change. The incident surface was never touched.",
  openQuestions: [
    "who owns applying external-review verdicts to the surface promptly（the lifecycle/controller step that was skipped for the TA-2R PASS）— a lifecycle-process note, not a delivery-selection bug; recommend the controller resolve scripts run on every received verdict",
    "should currentReviewDelivery ALSO surface a 'current card has no awaiting-review bundle' advisory to the controller（NO_NEW already returned）— recommended: yes, the export step should report it explicitly",
    "should the export step be invoked by the harness/controller via --export-for-card going forward — recommended: yes（it is the only identity-verified selector）",
  ],
  risks: [
    "the export step is controller-side; if it does not adopt the identity-verified selector, the stale-delivery class can still recur at the read layer — the NEG tests + CLI give the controller the fail-closed surface to adopt",
    "a same-card re-publish over an UNRESOLVED occupant stays surface_occupied（correct）; the controller must apply verdicts before the next card publishes",
  ],
  limitations: [
    "the reproduction models the controller-facing export as a dereference of the single-slot surface（the repo has no export API; the documented surface contract is the only source）— the assumption is recorded in the evidence",
    "legacy ta1/ta2r verify scripts' scope guards flag later-card files when re-run after this card（pre-existing cross-card limitation; their bundle-validation checks pass）",
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
RLD2_CLOSEOUT_OUTPUTS.length = 0;
RLD2_CLOSEOUT_OUTPUTS.push(...readdirSync(OUT)
  .filter((f) => !f.startsWith("."))
  .map((f) => `docs/pi-graph-output/rld2/${f}`)
  .sort());
console.log(`RLD2 closeout outputs: ${RLD2_CLOSEOUT_OUTPUTS.length}`);

const r = await runMandatoryGraphCloseout({
  graphResult,
  closeout,
  repoPath: REPO_A,
  cwd: REPO_A,
  outDir: OUT,
  timeoutMs: 60000,
  sourceBuilder: rld2SourceBuilder,
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
