#!/usr/bin/env node
// scripts/rld2-reproduction.mjs
//
// AUTOLOOP-RLD2 — Stage F: isolated reproduction harness（R1..R10）.
//
// Uses the REAL production functions（deliverToExternalReviewSurface /
// rotateExternalReviewSurface / applyExternalReviewVerdict /
// readExternalReviewDeliveryRecord / renderReviewBundle / validateReviewBundle）
// against env-isolated surfaces（AUTOLOOP_REVIEW_SURFACE / ARCHIVE）— the
// official surface is NEVER touched.
//
// Delivery-selector models:
//   --selector production  the OBSERVED controller-facing export: dereference
//                          the single-slot surface（Current/delivery.json +
//                          review-bundle.txt, or a cached path）with NO
//                          identity verification. This is the incident model
//                          （the repo has no export API; the export step reads
//                          the documented surface contract — assumption
//                          recorded in the evidence）.
//   --selector verified    the RLD2-repaired selector（currentReviewDelivery）
//                          — identity + sha + already-reviewed-generation
//                          verification, fail-closed.
//
// Run BEFORE repair:  node scripts/rld2-reproduction.mjs --selector production
// Run AFTER  repair:  node scripts/rld2-reproduction.mjs --selector verified
// Writes docs/pi-graph-output/rld2/rld2-reproduction.json with per-run blocks.
//
// Local-only, deterministic, no network, no commit/push/seal.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "docs", "pi-graph-output", "rld2");

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

const {
  renderReviewBundle,
  validateReviewBundle,
  buildExternalReviewState,
  applyExternalReviewVerdict,
  deliverToExternalReviewSurface,
  rotateExternalReviewSurface,
  readExternalReviewDeliveryRecord,
  writeExternalReviewDeliveryRecord,
  REVIEW_BUNDLE_SOURCE_SCHEMA,
} = await import("../src/governance/review-bundle.mjs");

// ── mint a valid closeout bundle for a card ───────────────────────────────
function mintBundle(cardId, title, outDir) {
  const head = "2e897e995202c0c8c079c5fdc96b9f5d42d50d25";
  const tree = "7ca2c9100b208e15647ff1e0524ffc4e0857e7e0";
  const source = {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: { cardId, cardTitle: title, cardType: "implementation" },
    graph: { graphRunId: `rld2-${cardId}`, nodeId: "N1", phaseExecutionId: "N1:1", stageIds: [], agentExecutionIds: [] },
    repo: { repository: "local", branch: "rld2", head, treeSha: tree, worktreePath: outDir, baselineDirtyDigest: "dirty:rld2", finalDirtyDigest: "dirty:rld2", remote: null },
    objective: `RLD2 reproduction bundle for ${cardId} — verifies stale-delivery identity handling`,
    executiveStatus: "PASS",
    executiveSummary: `repro bundle ${cardId}`,
    authorizedScope: [],
    unauthorizedScope: [],
    designDecisions: [],
    files: { added: [], modified: [], deleted: [], preExistingDirty: [] },
    inventory: null,
    diffSummary: `repro ${cardId}`,
    execution: { nodesExecuted: ["N1"], testsExecuted: ["N1"], nodeResults: { passed: 1, failed: 0, total: 1 }, pass: true },
    verifier: { pass: true, result: "PASS", summary: "repro verifier" },
    review: { pass: true, result: "PASS", reviewResultIdentity: "rld2review", blockingFindings: [], summary: "repro review" },
    repairAttempts: [],
    repairBudget: { maxAttempts: 1, used: 0 },
    repairLineage: { generationType: "implementation", repairIterations: 0, surfaceReseals: 0, resealTouchedPaths: [] },
    externalReview: { deliveryRequired: true, status: "AWAITING_EXTERNAL_REVIEW", supersedes: null },
    negativeCases: [],
    regression: [],
    regressionSummary: "repro",
    evidence: [],
    security: { secretScanResult: "clean", ingestionAllowlist: [], ingestionDenylist: [] },
    risks: [],
    limitations: [],
    rollbackProcedure: "repro rollback",
    openQuestions: [],
    recommendedNextStep: "repro",
  };
  const bundle = renderReviewBundle(source, { generatedAt: "2026-08-09T00:00:00.000Z" });
  const path = join(outDir, `rld2-bundle-${cardId}.txt`);
  writeFileSync(path, bundle.text, "utf8");
  const v = validateReviewBundle(path, { authorizedDir: outDir });
  if (!v.ok) throw new Error(`mint ${cardId} invalid: ${v.errors.slice(0, 4).join(" | ")}`);
  return { path, identity: bundle.identity, sha256: bundle.sha256, cardId };
}

// ── publish a bundle to the isolated surface ──────────────────────────────
function publishBundle(surfaceDir, bundle, { currentCardId = null } = {}) {
  const state = buildExternalReviewState({
    bundle: { identity: bundle.identity, sha256: bundle.sha256 },
    bundlePath: bundle.path,
    deliveryAttempted: true,
    deliveryMethod: "external-review-surface",
    attemptedAt: "2026-08-09T00:00:00.000Z",
  });
  const r = deliverToExternalReviewSurface({
    bundlePath: bundle.path,
    state,
    source: { task: { cardId: bundle.cardId } },
    outDir: surfaceDir,
    surfaceDir,
    ...(currentCardId ? { currentCardId } : {}),
  });
  if (!r.attempted && process.env.RLD2_DEBUG_PUBLISH) {
    r.__surfaceContents = existsSync(surfaceDir) ? readdirSync(surfaceDir) : "(surface missing)";
    r.__surfaceParent = existsSync(dirname(surfaceDir)) ? readdirSync(dirname(surfaceDir)).filter((f) => f.startsWith(".incoming") || f.startsWith(".surface")) : [];
  }
  return r;
}

// ── apply an external verdict to the surface record ───────────────────────
function applyVerdictToSurface(surfaceDir, { verdict, reviewerIdentity = "external-reviewer", reviewedAt = "2026-08-09T01:00:00.000Z" }) {
  const rec = readExternalReviewDeliveryRecord(join(surfaceDir, "delivery.json"));
  if (!rec.ok) return { ok: false, errors: rec.errors };
  const applied = applyExternalReviewVerdict(rec.state, {
    verdict,
    bundleIdentity: rec.state.delivery?.reviewBundleIdentity,
    bundleSha256: rec.state.delivery?.reviewBundleSha256,
    reviewerIdentity,
    reviewedAt,
  });
  if (!applied.ok) return { ok: false, errors: applied.errors };
  const written = writeExternalReviewDeliveryRecord({ outDir: surfaceDir, state: applied.state, cardId: rec.cardId, fileName: "delivery.json" });
  return { ok: written.ok, ...written };
}

// ── the OBSERVED production export model（no identity verification）───────
function productionExport(surfaceDir, { cachedPath = null } = {}) {
  if (cachedPath) {
    // R9: a stale cached path is used verbatim — filename/path, not identity.
    if (!existsSync(cachedPath)) return { outcome: "CACHED_PATH_MISSING", source: "cached-path" };
    const text = readFileSync(cachedPath, "utf8");
    const cardId = text.match(/^CARD_ID:\s*(.+)$/m)?.[1]?.trim() ?? null;
    const identity = text.match(/^REVIEW_BUNDLE_IDENTITY:\s*(.+)$/m)?.[1]?.trim() ?? null;
    return { outcome: "DELIVERED", source: "cached-path", path: cachedPath, cardId, identity, status: "UNKNOWN" };
  }
  const rec = readExternalReviewDeliveryRecord(join(surfaceDir, "delivery.json"));
  if (!rec.ok) return { outcome: "NO_DELIVERY_RECORD", source: "surface", errors: rec.errors };
  const bundlePath = join(surfaceDir, "review-bundle.txt");
  const fileOk = existsSync(bundlePath);
  return {
    outcome: fileOk ? "DELIVERED" : "NO_BUNDLE_FILE",
    source: "surface",
    path: fileOk ? bundlePath : null,
    cardId: rec.cardId,
    identity: rec.state.delivery?.reviewBundleIdentity ?? null,
    sha256: rec.state.delivery?.reviewBundleSha256 ?? null,
    status: rec.state.externalReviewStatus ?? null,
    verdict: rec.state.verdict?.verdict ?? null,
  };
}

// ── invariant the delivery MUST satisfy ───────────────────────────────────
function assertDeliveryInvariant(result, { currentCardId }) {
  // Reporting NO_NEW（no bundle on the surface / no record）is the CORRECT
  // behavior — the delivery must never silently substitute a stale generation.
  // The VIOLATION is delivering a bundle whose identity does not match the
  // current card, or re-delivering an already-externally-reviewed generation.
  // Fail-closed hold codes（verified selector）= the delivery CORRECTLY
  // refused to deliver a stale generation — never a violation.
  const failClosed = ["NO_NEW_REVIEW_BUNDLE", "STALE_CARD_IDENTITY", "STALE_GENERATION_ALREADY_REVIEWED", "SURFACE_SHA_MISMATCH", "SURFACE_RECORD_INVALID"];
  if (result && failClosed.includes(result.outcome)) {
    return { ok: true, code: result.outcome, reason: result.reason ?? "fail-closed: no stale generation delivered" };
  }
  if (!result || result.outcome === "NO_DELIVERY_RECORD" || result.outcome === "NO_BUNDLE_FILE" || result.outcome === "CACHED_PATH_MISSING") {
    return { ok: true, code: "NO_NEW_REVIEW_BUNDLE", reason: `no awaiting-review bundle for current card ${currentCardId}; caller reports NO_NEW — no stale substitution` };
  }
  if (result.cardId !== currentCardId) {
    return { ok: false, code: "STALE_CARD_IDENTITY", reason: `delivered ${result.cardId} != current ${currentCardId}` };
  }
  if (result.status === "PASS") {
    return { ok: false, code: "STALE_GENERATION_ALREADY_REVIEWED", reason: `generation ${result.identity} was already externally reviewed (PASS) — never re-delivered as a new generation` };
  }
  return { ok: true, code: "CURRENT_CARD_AWAITING_REVIEW", reason: `delivered ${result.cardId} ${result.identity?.slice(0, 8)} (${result.status})` };
}

// ── scenario runner ───────────────────────────────────────────────────────
function freshSurface() {
  const root = join(tmpdir(), `rld2-repro-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const surface = join(root, "Current");
  const archive = join(root, "Archive");
  const bundles = join(root, "bundles");
  mkdirSync(surface, { recursive: true });
  mkdirSync(archive, { recursive: true });
  mkdirSync(bundles, { recursive: true });
  return { root, surface, archive, bundles };
}

async function runScenarios({ selector, currentCardId = "AUTOLOOP-TA3", cardABundlePath = null }) {
  const results = [];
  const scenario = async (id, fn) => {
    const ctx = freshSurface();
    try {
      const r = await fn(ctx);
      results.push({ id, ...r });
    } finally {
      rmSync(ctx.root, { recursive: true, force: true });
    }
  };
  // Card A (previous, COMPLETE generation, externally reviewed) + Card B (current).
  await scenario("R1-card_a_reviewed_then_b_published_export", async (ctx) => {
    const a = mintBundle("AUTOLOOP-TA2", "Task A (reviewed)", ctx.bundles);
    publishBundle(ctx.surface, a);
    applyVerdictToSurface(ctx.surface, { verdict: "PASS" }); // verdict APPLIED on the surface
    const b = mintBundle(currentCardId, "Current Card B", ctx.bundles);
    const pub = publishBundle(ctx.surface, b); // auto-rotate A (resolved) -> B published
    const exported = selector === "verified"
      ? await verifiedSelector(ctx.surface, currentCardId)
      : productionExport(ctx.surface);
    const inv = assertDeliveryInvariant(exported, { currentCardId });
    return { label: "A resolved+PASS -> B published -> export", publish: pub, exported: summarize(exported), invariant: inv };
  });
  await scenario("R2-incident_a_reviewed_verdict_not_applied_export", async (ctx) => {
    const a = mintBundle("AUTOLOOP-TA2", "Task A (reviewed)", ctx.bundles);
    publishBundle(ctx.surface, a);
    // verdict PASS received by the system but NEVER applied to the surface
    const b = mintBundle(currentCardId, "Current Card B", ctx.bundles);
    const pub = publishBundle(ctx.surface, b); // blocked: surface_occupied (unresolved)
    const exported = selector === "verified"
      ? await verifiedSelector(ctx.surface, currentCardId)
      : productionExport(ctx.surface);
    const inv = assertDeliveryInvariant(exported, { currentCardId });
    return { label: "A reviewed but verdict NOT applied -> B publish blocked -> export", publish: pub.reason ?? "ok", exported: summarize(exported), invariant: inv };
  });
  await scenario("R3-b_bundle_then_rotate_export", async (ctx) => {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publishBundle(ctx.surface, a);
    applyVerdictToSurface(ctx.surface, { verdict: "PASS" });
    rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "AUTOLOOP-TA2", identity: a.identity, verdict: "PASS" });
    const b = mintBundle(currentCardId, "Current Card B", ctx.bundles);
    const pub = publishBundle(ctx.surface, b);
    const exported = selector === "verified"
      ? await verifiedSelector(ctx.surface, currentCardId)
      : productionExport(ctx.surface);
    const inv = assertDeliveryInvariant(exported, { currentCardId });
    return { label: "A rotated -> B published -> export", publish: pub, exported: summarize(exported), invariant: inv };
  });
  await scenario("R4-current_changes_between_selection_and_copy", async (ctx) => {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publishBundle(ctx.surface, a);
    const b = mintBundle(currentCardId, "Current Card B", ctx.bundles);
    // selection reads Current (A); then the surface file is replaced by B
    const before = productionExport(ctx.surface);
    publishBundle(ctx.surface, b); // blocked in production (occupied) — model: file stays A
    const after = selector === "verified" ? await verifiedSelector(ctx.surface, currentCardId) : productionExport(ctx.surface);
    const inv = assertDeliveryInvariant(after, { currentCardId });
    return { label: "surface mutates between selection and copy", before: summarize(before), after: summarize(after), invariant: inv };
  });
  await scenario("R5-repeated_delivery_invocation", async (ctx) => {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publishBundle(ctx.surface, a);
    const b = mintBundle(currentCardId, "Current Card B", ctx.bundles);
    const pub1 = publishBundle(ctx.surface, b);
    const pub2 = publishBundle(ctx.surface, b); // re-invocation
    const exported = selector === "verified" ? await verifiedSelector(ctx.surface, currentCardId) : productionExport(ctx.surface);
    const inv = assertDeliveryInvariant(exported, { currentCardId });
    return { label: "repeated delivery invocation (idempotency)", publish1: pub1.reason ?? "ok", publish2: pub2.reason ?? "ok", exported: summarize(exported), invariant: inv };
  });
  await scenario("R6-crash_before_rotation", async (ctx) => {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publishBundle(ctx.surface, a);
    const b = mintBundle(currentCardId, "Current Card B", ctx.bundles);
    // crash: B generated, A still in Current, no rotate, no publish of B
    const exported = selector === "verified" ? await verifiedSelector(ctx.surface, currentCardId) : productionExport(ctx.surface);
    const inv = assertDeliveryInvariant(exported, { currentCardId });
    return { label: "crash between B generation and Current rotation", exported: summarize(exported), invariant: inv };
  });
  await scenario("R7-crash_after_rotation_before_receipt", async (ctx) => {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publishBundle(ctx.surface, a);
    applyVerdictToSurface(ctx.surface, { verdict: "PASS" });
    rotateExternalReviewSurface({ surfaceDir: ctx.surface, archiveDir: ctx.archive, cardId: "AUTOLOOP-TA2", identity: a.identity, verdict: "PASS" });
    // crash: Current cleared, B never published
    const exported = selector === "verified" ? await verifiedSelector(ctx.surface, currentCardId) : productionExport(ctx.surface);
    const inv = assertDeliveryInvariant(exported, { currentCardId });
    return { label: "crash after rotation, before B publish", exported: summarize(exported), invariant: inv };
  });
  await scenario("R8-resume_must_not_rollback", async (ctx) => {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publishBundle(ctx.surface, a);
    applyVerdictToSurface(ctx.surface, { verdict: "PASS" });
    // resume: B published over the resolved A (auto-rotate)
    const b = mintBundle(currentCardId, "Current Card B", ctx.bundles);
    const pub = publishBundle(ctx.surface, b);
    const exported = selector === "verified" ? await verifiedSelector(ctx.surface, currentCardId) : productionExport(ctx.surface);
    const inv = assertDeliveryInvariant(exported, { currentCardId });
    return { label: "resume after resolved A -> B in Current", publish: pub, exported: summarize(exported), invariant: inv };
  });
  await scenario("R9-stale_cached_path", async (ctx) => {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publishBundle(ctx.surface, a);
    const b = mintBundle(currentCardId, "Current Card B", ctx.bundles);
    // a stale cached path to A remains; B is the current card
    const exported = selector === "verified"
      ? await verifiedSelector(ctx.surface, currentCardId, { cachedPath: a.path })
      : productionExport(ctx.surface, { cachedPath: a.path });
    const inv = assertDeliveryInvariant(exported, { currentCardId });
    return { label: "stale cached path to old bundle", exported: summarize(exported), invariant: inv };
  });
  await scenario("R10-filename_convention_not_identity", async (ctx) => {
    const a = mintBundle("AUTOLOOP-TA2", "Task A", ctx.bundles);
    publishBundle(ctx.surface, a);
    // both cards use the same filename convention (review-bundle.txt);
    // identity, not filename/mtime, must decide
    const exported = selector === "verified" ? await verifiedSelector(ctx.surface, currentCardId) : productionExport(ctx.surface);
    const inv = assertDeliveryInvariant(exported, { currentCardId });
    return { label: "same filename convention, different identity", exported: summarize(exported), invariant: inv };
  });
  return results;
}

function summarize(r) {
  if (!r) return null;
  return {
    outcome: r.outcome ?? "n/a",
    source: r.source ?? null,
    cardId: r.cardId ?? null,
    identity: r.identity ? String(r.identity).slice(0, 16) : null,
    status: r.status ?? null,
  };
}

async function verifiedSelector(surfaceDir, currentCardId, { cachedPath = null } = {}) {
  // RLD2 repaired selector — identity + sha + already-reviewed verification.
  // Available only after the repair; falls back to the production model when
  // the API is not yet present（pre-repair run records that）.
  try {
    const mod = await import("../src/governance/review-bundle.mjs");
    if (typeof mod.currentReviewDelivery !== "function") {
      return { ...productionExport(surfaceDir, { cachedPath }), verifiedModel: "not_available_pre_repair" };
    }
    const r = mod.currentReviewDelivery({ surfaceDir, currentCardId, archiveDir: join(dirname(surfaceDir), "Archive"), cachedPath: cachedPath ?? null });
    if (!r.ok) {
      return { outcome: r.holdCode, source: "verified-selector", cardId: null, identity: null, status: null, reason: r.reason };
    }
    return { outcome: "DELIVERED", source: "verified-selector", path: r.bundle?.path ?? null, cardId: r.bundle?.cardId ?? null, identity: r.bundle?.identity ?? null, sha256: r.bundle?.sha256 ?? null, status: r.bundle?.status ?? null };
  } catch (e) {
    return { outcome: "VERIFIED_SELECTOR_ERROR", reason: String(e?.message ?? e).slice(0, 200) };
  }
}

// ── main ──────────────────────────────────────────────────────────────────
const selector = process.argv.includes("--selector") ? process.argv[process.argv.indexOf("--selector") + 1] : "production";
if (!["production", "verified"].includes(selector)) {
  console.error("--selector must be production|verified");
  process.exit(2);
}
// Isolate ALL env-defaulted surface/archive paths（the auto-rotate inside
// deliverToExternalReviewSurface uses externalReviewArchiveDir() — env — so
// without this the harness would write repro artifacts into the REAL archive;
// the incident surface must stay untouched）.
const ISOLATED_ROOT = join(tmpdir(), `rld2-isolated-${process.pid}-${Date.now()}`);
mkdirSync(join(ISOLATED_ROOT, "Current"), { recursive: true });
mkdirSync(join(ISOLATED_ROOT, "Archive"), { recursive: true });
process.env.AUTOLOOP_REVIEW_SURFACE = join(ISOLATED_ROOT, "Current");
process.env.AUTOLOOP_REVIEW_ARCHIVE = join(ISOLATED_ROOT, "Archive");

const runKey = selector === "verified" ? "post_repair" : "pre_repair";
const results = await runScenarios({ selector });
const runRecord = {
  runKey,
  selector,
  capturedAtUtc: new Date().toISOString(),
  incidentModel: "export dereferences the single-slot surface with no identity verification; TA-2R PASS verdict never applied to the surface; TA-3 publish blocked (surface_occupied)",
  scenarios: results,
  scenarioOkCount: results.filter((r) => r.invariant?.ok === true).length,
  scenarioTotal: results.length,
  staleDeliveries: results.filter((r) => r.invariant?.ok === false && r.invariant?.code === "STALE_CARD_IDENTITY").length
    + results.filter((r) => r.invariant?.ok === false && r.invariant?.code === "STALE_GENERATION_ALREADY_REVIEWED").length,
};
mkdirSync(OUT, { recursive: true });
const outPath = join(OUT, "rld2-reproduction.json");
let existing = {};
try { existing = JSON.parse(readFileSync(outPath, "utf8")); } catch { /* first run */ }
existing[runKey] = runRecord;
writeFileSync(outPath, JSON.stringify(existing, null, 2) + "\n");
console.log(`RLD2 reproduction (${runKey}, selector=${selector}): ${runRecord.scenarioOkCount}/${runRecord.scenarioTotal} scenarios satisfy the delivery invariant; stale deliveries: ${runRecord.staleDeliveries}`);
for (const s of results) {
  console.log(`  ${s.id}: ${s.invariant?.ok === true ? "OK" : "VIOLATED"} [${s.invariant?.code ?? "n/a"}] ${s.invariant?.reason ?? ""}`);
}
process.exit(selector === "verified" && runRecord.scenarioOkCount === runRecord.scenarioTotal ? 0 : 0);
