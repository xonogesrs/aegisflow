// src/governance/review-bundle.mjs
//
// Automatic Review Bundle Generation and Closeout Gate（RB-1）.
//
// Card-closeout governance: any research / implementation / repair /
// integration / closeout card that produces reviewable output MUST generate
// and validate ONE complete UTF-8 text review bundle before it may declare a
// FINAL closeout PASS.
//
//   INTERNAL_REVIEW_PASS != FINAL_CLOSEOUT_PASS
//   final PASS = execution PASS + verifier PASS + independent review PASS
//              + review bundle generated + review bundle validated
//
// Bundle generation is deterministic and local-only; it renders a FIXED
// 25-section text from STRUCTURED source data（never re-parses free-text
// stdout）; it never trusts writer-supplied repo identity or test PASS —
// repo facts are recomputed from git by the closeout gate.
//
// Bundle identity（avoids circularity: identity NEVER includes the bundle's
// own hash）:
//   reviewBundleIdentity = sha256(recursiveCanonical({
//     reviewBundleSchema, taskIdentity, repoIdentity, head, treeSha,
//     graphRunId, finalReviewResultIdentity, evidenceManifestDigest }))
//   reviewBundleSha256   = sha256(bundle file bytes)（recomputed by validator）
//
// Recursive canonical serialization is MANDATORY（CBM-1 probe finding）:
//   JSON.stringify(value, Object.keys(value)) is a shallow replacer that
//   strips object fields and makes digests count-only. Never use it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { scanForSecrets, sha256Text } from "../evidence/run-evidence-store.mjs";
import { readReviewJob, findingsPath, verdictPath, updateReviewJob } from "./review-job.mjs";
import {
  CLOSEOUT_HOLDS,
  CLOSEOUT_STATE_SCHEMA,
  assertGraphAggregateConsistency,
  closeoutStatePath,
  deriveCloseoutStage,
  loadGraphResultFromEvidence,
  materializeCloseoutContract,
  readCloseoutState,
  validateGraphEvidence,
  writeCloseoutState,
} from "./closeout-state.mjs";
import {
  CARD_INVENTORY_BASELINE_SCHEMA,
  CARD_INVENTORY_MODEL,
  computeInventoryDelta,
  validateCardInventoryConsistency,
} from "./card-inventory.mjs";
import { assertColimaAllClaims } from "./colima-scope-gate.mjs";
import {
  ORACLE_EVIDENCE_SCHEMA,
  ORACLE_REJECTIONS as PASS_ORACLE_REJECTIONS,
  evaluatePassOracle,
  normalizeSuccessContract,
} from "./pass-oracle.mjs";
import {
  computeCascade,
  revocationFactsForOracle,
} from "./truth-revocation.mjs";
import {
  readRevocationLedger,
  revocationLedgerPath,
} from "./truth-revocation-store.mjs";

export const REVIEW_BUNDLE_SCHEMA = "autoloop.review-bundle/v1";
export const REVIEW_BUNDLE_SOURCE_SCHEMA = "autoloop.review-bundle.source/v1";
export const REVIEW_BUNDLE_TERMINATOR = "=== END OF REVIEW BUNDLE ===";
export const REVIEW_BUNDLE_SECTIONS = Object.freeze([
  "Review Request",
  "Executive Status",
  "Task Identity",
  "Repository and Worktree Identity",
  "Objective",
  "Authorized Scope",
  "Explicitly Unauthorized Scope",
  "Architecture and Design Decisions",
  "Files Added / Modified / Deleted",
  "Diff Summary",
  "Execution Results",
  "Verification Results",
  "Independent Review Results",
  "Repair Attempts",
  "Negative and Fail-Closed Cases",
  "Regression Results",
  "Evidence Inventory",
  "Evidence Hashes",
  "Security and Secret Scan",
  "Repository Integrity",
  "Known Risks and Limitations",
  "Rollback Procedure",
  "Open Questions",
  "Recommended Next Step",
  "External Reviewer Verdict Template",
]);

// VCA-1 W1A (S9) — single authoritative bundle per generation.
export const BUNDLE_AUTHORITY_HOLDS = Object.freeze({
  ALREADY_AUTHORITATIVE: "BUNDLE_GENERATION_ALREADY_AUTHORITATIVE",
});

export const REVIEW_BUNDLE_HOLDS = Object.freeze({
  MISSING: "REVIEW_BUNDLE_MISSING",
  GENERATION_FAILED: "REVIEW_BUNDLE_GENERATION_FAILED",
  INVALID: "REVIEW_BUNDLE_INVALID",
  IDENTITY_MISMATCH: "REVIEW_BUNDLE_IDENTITY_MISMATCH",
  SECRET_DETECTED: "REVIEW_BUNDLE_SECRET_DETECTED",
  // FM-3: authorized / actually-touched / CARD_IMPLEMENTATION_FILES are no
  // longer independent claims — a structured inventory cross-check runs for
  // bundles that carry the inventory model; any inconsistency fails closed.
  INVENTORY_INCONSISTENT: "REVIEW_BUNDLE_INVENTORY_INCONSISTENT",
});

export const CARD_TYPES = Object.freeze(["implementation", "research", "repair", "integration", "closeout"]);
export const EXECUTIVE_STATUSES = Object.freeze(["PASS", "HOLD", "REPAIR"]);

// ---------------------------------------------------------------------------
// External review bundle delivery governance（RB-1G）.
// ---------------------------------------------------------------------------
//
// One externally reviewed card requires ONE complete review bundle available
// to the external reviewer. Bundle generation, validation, internal review,
// path, identity, and SHA are necessary evidence but do NOT constitute
// external review. External review is complete only after the external
// reviewer has received and reviewed the ACTUAL bundle content and issued a
// verdict.
//
//   INTERNAL_REVIEW_PASS（graph reviewer verdict）!= EXTERNAL_REVIEW_PASS
//   final card external review = bundle generated + bundle validated
//     + the external reviewer RECEIVED and REVIEWED the actual bundle content
//     + verdict（PASS / REPAIR / HOLD）bound to the CURRENT valid bundle.
//
// RECEIPT MODEL（RB-1G repair, external finding）: the sender can never
// authoritatively confirm delivery. The external reviewer's verdict — which
// binds the CURRENT bundle identity + sha256, a real reviewer identity and a
// reviewedAt timestamp — IS the receipt acknowledgment: applying it proves
// RECEIVED + REVIEWED in one step. The execution side may only record a
// non-authoritative DELIVERY_ATTEMPTED（informational）; that never changes
// status and never contributes to completion.
//
// Closeout therefore carries structured state（never inferred from paths or
// SHA）:
//   reviewBundleGenerated = true
//   reviewBundleValidated = true
//   reviewBundleDeliveryRequired = true
//   externalReviewStatus =
//     AWAITING_EXTERNAL_REVIEW | AWAITING_BUNDLE_DELIVERY | PASS | REPAIR | HOLD
//
// A bundle path / SHA-256 / reviewBundleIdentity / execution summary / agent
// self-report / internal reviewer PASS / bundle validator `valid=true` / a
// sender-side delivery attempt never substitute for the external verdict.
// Path + SHA only locate and verify the artifact; they do not constitute
// receipt or review.

export const EXTERNAL_REVIEW_STATUSES = Object.freeze([
  "AWAITING_EXTERNAL_REVIEW", // bundle generated + validated; verdict（the receipt）outstanding
  "AWAITING_BUNDLE_DELIVERY", // delivery required but the execution environment cannot hand the artifact over
  "PASS",
  "REPAIR",
  "HOLD",
]);

export const EXTERNAL_REVIEW_VERDICTS = Object.freeze(["PASS", "REPAIR", "HOLD"]);

export const EXTERNAL_REVIEW_HOLDS = Object.freeze({
  NOT_COMPLETE: "EXTERNAL_REVIEW_NOT_COMPLETE",
  DELIVERY_NOT_CONFIRMED: "EXTERNAL_REVIEW_DELIVERY_NOT_CONFIRMED",
  STALE_BUNDLE: "EXTERNAL_REVIEW_STALE_BUNDLE",
  SELF_DECLARED: "EXTERNAL_REVIEW_SELF_DECLARED",
  INVALID_VERDICT: "EXTERNAL_REVIEW_INVALID_VERDICT",
  // R-13 residual repair: verdict-time artifact verification fencing.
  ARTIFACT_INVALID: "EXTERNAL_REVIEW_ARTIFACT_INVALID",
  CARD_MISMATCH: "EXTERNAL_REVIEW_CARD_MISMATCH",
  VERDICT_CONFLICT: "EXTERNAL_REVIEW_VERDICT_CONFLICT",
});

export const EXTERNAL_REVIEW_DELIVERY_RECORD_SCHEMA = "autoloop.external-review-delivery/v2";

// ---------------------------------------------------------------------------
// Fixed external-review delivery surface（RB-1H）.
// ---------------------------------------------------------------------------
// The reviewer's inbox is a SINGLE fixed location — never scattered across
// per-card output dirs. Two responsibilities are strictly separated:
//   internal evidence store  = repo docs/pi-graph-output/<run>/（durable）
//   external review surface  = ~/Desktop/AutoLoop-Review/Current/（收件匣）
// The surface holds at most ONE card:
//   Current/review-bundle.txt   the current valid bundle（atomic copy）
//   Current/delivery.json      delivery/verdict state（identity, sha,
//                               supersedes, externalReviewStatus）
//   Current/evidence.json      this card's closeout evidence snapshot
// A requiresReview card that fails to atomically deliver to the fixed
// surface stays AWAITING_BUNDLE_DELIVERY（fail-closed; hard rule enforced
// by runCloseoutGate's default surface deliverer）. After PASS / REPAIR /
// HOLD the surface is rotated into ~/Desktop/AutoLoop-Review/Archive/
//（flat, never nested）; Current/ never retains the previous card.
// Paths are resolved LAZILY（env override for tests / CI isolation）.

export function externalReviewSurfaceDir() {
  return process.env.AUTOLOOP_REVIEW_SURFACE ?? join(homedir(), "Desktop", "AutoLoop-Review", "Current");
}

export function externalReviewArchiveDir() {
  return process.env.AUTOLOOP_REVIEW_ARCHIVE ?? join(homedir(), "Desktop", "AutoLoop-Review", "Archive");
}

export function isValidExternalReviewStatus(s) {
  return EXTERNAL_REVIEW_STATUSES.includes(s);
}

/**
 * VCA-1 Phase 0B — AUTHORITATIVE_SOURCE_FIRST entry point for "is anything
 * still AWAITING_EXTERNAL_REVIEW". The surface holds at most one card at a
 * time (see the comment above externalReviewSurfaceDir), so this is a
 * single structured-file read, never a filesystem search. Callers asking
 * this question MUST use this function instead of grepping for the status
 * string anywhere — see docs/pi-graph-output/vca1/ for the incident this
 * closes (VCA1-F1).
 *
 * @returns {{ cardId: string|null, status: string|null, present: boolean }}
 *   present:false means the surface currently holds no delivery record at
 *   all (nothing awaiting review) — that is a valid, authoritative answer,
 *   not a reason to search further.
 */
export function currentSurfaceReviewStatus({ surfaceDir = null } = {}) {
  const dir = resolve(surfaceDir ?? externalReviewSurfaceDir());
  const deliveryPath = join(dir, "delivery.json");
  if (!existsSync(deliveryPath)) {
    return { cardId: null, status: null, present: false };
  }
  const rec = readExternalReviewDeliveryRecord(deliveryPath);
  if (!rec.ok) {
    return { cardId: null, status: null, present: false, invalid: true, errors: rec.errors };
  }
  return { cardId: rec.cardId ?? null, status: rec.state?.externalReviewStatus ?? null, present: true };
}

export function isValidExternalReviewVerdict(v) {
  return EXTERNAL_REVIEW_VERDICTS.includes(v);
}

/**
 * Build the structured external-review delivery state for a card closeout
 * whose bundle was generated AND validated. The bundle artifact is bound by
 * identity + sha256. Status starts at AWAITING_EXTERNAL_REVIEW — the sender
 * may record at most a non-authoritative delivery attempt; RECEIVED is
 * proven only by the reviewer's verdict（applyExternalReviewVerdict）.
 *
 * If the execution environment cannot hand the artifact over（delivery
 * attempt failed）, the status becomes AWAITING_BUNDLE_DELIVERY — and the
 * card may not declare EXTERNAL_REVIEW_PASS / CARD_COMPLETE.
 */
export function buildExternalReviewState({
  bundle,
  bundlePath = null,
  deliveryAttempted = false,
  deliveryMethod = null,
  attemptedAt = null,
  verdict = null,
  supersedes = null,
} = {}) {
  const identity = bundle?.identity ?? null;
  const sha256 = bundle?.sha256 ?? null;
  const state = {
    reviewBundleGenerated: true,
    reviewBundleValidated: true,
    reviewBundleDeliveryRequired: true,
    externalReviewStatus: EXTERNAL_REVIEW_STATUSES[0], // AWAITING_EXTERNAL_REVIEW
    externalReviewStatusReason: null,
    delivery: {
      required: true,
      // INFORMATIONAL ONLY — the sender can never confirm receipt. The
      // reviewer's verdict is the sole receipt acknowledgment.
      attempted: deliveryAttempted === true,
      method: deliveryAttempted ? (deliveryMethod ?? "sender-provided") : null,
      attemptedAt: deliveryAttempted ? (attemptedAt ?? new Date().toISOString()) : null,
      bundlePath: bundlePath ?? null,
      reviewBundleIdentity: identity,
      reviewBundleSha256: sha256,
    },
    verdict: null,
    supersedes: supersedes ?? null,
  };
  if (verdict && verdict.verdict) {
    const applied = applyExternalReviewVerdict(state, verdict);
    if (applied.ok) return applied.state;
  }
  return state;
}

/**
 * Record that the execution side provided the bundle artifact to the external
 * reviewer. NON-AUTHORITATIVE: the sender can never confirm receipt. This
 * only records an attempt（method + timestamp）; it does NOT change the
 * status and does NOT contribute to external review completion. RECEIVED is
 * proven solely by the reviewer's verdict bound to the current bundle.
 */
export function recordDeliveryAttempt(state, { method = "sender-provided", attemptedAt = new Date().toISOString() } = {}) {
  if (!state) return null;
  const next = structuredClone(state);
  next.delivery = {
    ...next.delivery,
    attempted: true,
    method,
    attemptedAt,
  };
  return next;
}

/**
 * Apply an external reviewer verdict — the authoritative RECEIPT
 * acknowledgment. Fail-closed conditions — ALL required:
 *   1. verdict ∈ { PASS, REPAIR, HOLD }
 *   2. the verdict references the CURRENT valid bundle（identity + sha256）;
 *      a verdict on a superseded / stale bundle is rejected（repair rule）
 *   3. reviewer identity is present and is NOT the agent itself
 *   4. reviewedAt is a real timestamp
 *
 * Only then may externalReviewStatus become PASS / REPAIR / HOLD. There is
 * no separate sender-side delivery flag: the verdict itself proves the
 * reviewer received AND reviewed the actual bundle content.
 */
export function applyExternalReviewVerdict(state, input = {}) {
  const errors = [];
  const fail = (code, err) => errors.push(`${code}:${err}`);
  if (!state) return { ok: false, errors: [`${EXTERNAL_REVIEW_HOLDS.INVALID_VERDICT}:no_state`], state: null };
  const verdict = input.verdict;
  if (!isValidExternalReviewVerdict(verdict)) fail(EXTERNAL_REVIEW_HOLDS.INVALID_VERDICT, `verdict_${String(verdict)}`);
  const bundleIdentity = input.bundleIdentity ?? input.reviewBundleIdentity ?? null;
  const bundleSha256 = input.bundleSha256 ?? input.reviewBundleSha256 ?? null;
  if (!bundleIdentity || bundleIdentity !== state.delivery?.reviewBundleIdentity) {
    fail(EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE, `bundle_identity_mismatch:${bundleIdentity ?? "missing"}`);
  }
  if (!bundleSha256 || bundleSha256 !== state.delivery?.reviewBundleSha256) {
    fail(EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE, "bundle_sha256_mismatch");
  }
  const reviewer = input.reviewerIdentity ?? null;
  if (!reviewer || typeof reviewer !== "string" || reviewer.length === 0) {
    fail(EXTERNAL_REVIEW_HOLDS.INVALID_VERDICT, "reviewer_identity_required");
  } else if (/^agent:/i.test(reviewer) || (input.agentIdentity && reviewer === input.agentIdentity)) {
    fail(EXTERNAL_REVIEW_HOLDS.SELF_DECLARED, "reviewer_is_agent_self");
  }
  const reviewedAt = input.reviewedAt ?? null;
  if (!reviewedAt || Number.isNaN(Date.parse(reviewedAt))) {
    fail(EXTERNAL_REVIEW_HOLDS.INVALID_VERDICT, "reviewed_at_required");
  }
  if (errors.length) return { ok: false, errors, state: null };
  const next = structuredClone(state);
  next.externalReviewStatus = verdict;
  next.externalReviewStatusReason = `verdict ${verdict} bound to reviewBundleIdentity=${bundleIdentity}（verdict is the receipt: RECEIVED + REVIEWED proven in one step）`;
  next.verdict = {
    verdict,
    reviewerIdentity: reviewer,
    reviewedAt,
    bundleIdentity,
    bundleSha256,
    findingsDigest: input.findingsDigest ?? null,
  };
  return { ok: true, errors: [], state: next };
}

/**
 * True ONLY when the external reviewer's PASS verdict（the receipt）is bound
 * to the current bundle. This is the sole authority for EXTERNAL_REVIEW_PASS
 * / CARD_COMPLETE for requiresReview cards. No sender-side flag participates.
 */
export function externalReviewComplete(state) {
  if (!state) return false;
  if (state.externalReviewStatus !== "PASS") return false;
  if (!state.verdict) return false;
  return state.verdict.bundleIdentity === state.delivery.reviewBundleIdentity
    && state.verdict.bundleSha256 === state.delivery.reviewBundleSha256;
}

/**
 * Card-level external review status guard（for downstream consumers）:
 *   { complete, status, holdCode, reason }
 * complete=true ONLY when externalReviewComplete(state). Any
 * AWAITING_EXTERNAL_REVIEW / AWAITING_BUNDLE_DELIVERY / REPAIR / HOLD state
 * keeps the card from being declared externally reviewed and complete.
 */
export function cardExternalReviewStatus(state) {
  if (!state) {
    return { complete: false, status: null, holdCode: EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE, reason: "no_external_review_state" };
  }
  const status = state.externalReviewStatus;
  if (status === "PASS") {
    const complete = externalReviewComplete(state);
    return { complete, status, holdCode: complete ? null : EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE, reason: state.externalReviewStatusReason };
  }
  if (status === "REPAIR" || status === "HOLD") {
    return { complete: false, status, holdCode: null, reason: state.externalReviewStatusReason };
  }
  // AWAITING_EXTERNAL_REVIEW / AWAITING_BUNDLE_DELIVERY
  return {
    complete: false,
    status,
    holdCode: status === "AWAITING_BUNDLE_DELIVERY" ? EXTERNAL_REVIEW_HOLDS.DELIVERY_NOT_CONFIRMED : EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE,
    reason: state.externalReviewStatusReason,
  };
}

/**
 * Supersede binding for a repair generation: the NEW bundle must explicitly
 * supersede the PREVIOUS bundle（new identity + new sha256; old artifact
 * retained, never overwritten; repair attempt history preserved）.
 */
export function buildSupersedeRecord(previousState) {
  if (!previousState?.delivery) return null;
  return {
    reviewBundleIdentity: previousState.delivery.reviewBundleIdentity ?? null,
    reviewBundleSha256: previousState.delivery.reviewBundleSha256 ?? null,
    bundlePath: previousState.delivery.bundlePath ?? null,
    verdict: previousState.verdict?.verdict ?? null,
    reviewedAt: previousState.verdict?.reviewedAt ?? null,
  };
}

/**
 * Parse the SUPERSEDES_* binding（section 14）from a review bundle's text.
 * Returns null when the bundle declares no supersede. Fail-closed: a bundle
 * that declares SUPERSEDES_BUNDLE_IDENTITY WITHOUT the matching sha256 is
 * inconsistent evidence and surfaces an error instead of a partial record.
 */
export function supersedesFromBundleText(text) {
  const ident = String(text ?? "").match(/^SUPERSEDES_BUNDLE_IDENTITY: ([0-9a-f]{64})$/m)?.[1] ?? null;
  const sha = String(text ?? "").match(/^SUPERSEDES_BUNDLE_SHA256: ([0-9a-f]{64})$/m)?.[1] ?? null;
  const path = String(text ?? "").match(/^SUPERSEDES_BUNDLE_PATH: (.+)$/m)?.[1] ?? null;
  if (!ident) return { supersedes: null, error: null };
  if (!sha) return { supersedes: null, error: "supersedes_sha256_missing" };
  return { supersedes: { reviewBundleIdentity: ident, reviewBundleSha256: sha, bundlePath: path }, error: null };
}

// ---------------------------------------------------------------------------
// Repair lineage contract（TA-2R HOLD / TA2R_REPAIR_LINEAGE_ACCOUNTING_NOT_
// CUMULATIVE）: machine-readable generation classification + CUMULATIVE repair
// budget across the authoritative supersede lineage.
// ---------------------------------------------------------------------------
//
// GENERATION_TYPE（section 14）:
//   implementation    — the card's original closeout（no supersede）
//   repair-iteration  — a bounded-repair generation（supersedes a reviewed
//                       bundle AND performs substantive task repair）; adds
//                       +1 to the cumulative repair count
//   surface-reseal    — a review-surface / governance-metadata correction of
//                       an existing generation（supersedes a reviewed bundle,
//                       touches ONLY the governance layer）; adds +0
//
// REPAIR_BUDGET_USED is CUMULATIVE: it sums the repair-iteration generations
// across the whole authoritative chain（never just the immediate parent）, so
// a later generation can never re-report USED=1/MAX=1 after the budget was
// already consumed by an earlier repair（the reviewer's finding）. Surface
// reseals may keep USED = the lineage total, but the reseal touch set is
// contract-checked（RESEAL_TOUCHED_PATHS must stay within the governance
// scope; the validator independently recomputes the touch set from the two
// bundles' section-9 attributions）. Legacy bundles（generated before this
// contract）carry no GENERATION_TYPE; a §14 attempt of the
// external-review-superseding-repair kind is inferred as one repair iteration.

// Review-surface / governance scope — the ONLY paths a surface-reseal may
// touch. Anything else（src/admission, src/runtime, src/subagent, src/v2,
// src/telemetry, src/memory, src/schema, test/admission, test/v2, …）is
// substantive implementation: touching it makes the generation a
// repair-iteration（consuming budget）, never a reseal.
export const RESEAL_GOVERNANCE_SCOPE = [
  "src/governance/",
  "scripts/",
  "docs/pi-graph-output/",
  "test/governance/",
];

export function isSubstantiveImplementationPath(p) {
  const n = String(p ?? "").replace(/\/+$/, "");
  if (!n) return false;
  return !RESEAL_GOVERNANCE_SCOPE.some((g) => n === g.replace(/\/+$/, "") || n.startsWith(g));
}

/**
 * Parse the machine-readable repair-lineage fields from a bundle's §14
 *（GENERATION_TYPE / REPAIR_BUDGET_* / REPAIR_LINEAGE_*）. Best-effort: every
 * field that is absent returns null（legacy bundles carry none）. A §14
 * attempt of the superseding-repair kind marks a legacy generation as having
 * consumed one repair iteration.
 */
export function parseRepairLineage(text) {
  const src = String(text ?? "");
  const l = (prefix) => src.match(new RegExp(`^${prefix}: (.+)$`, "m"))?.[1] ?? null;
  const num = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    generationType: l("GENERATION_TYPE") ?? null,
    budgetUsed: num(l("REPAIR_BUDGET_USED")),
    budgetMax: num(l("REPAIR_BUDGET_MAX")),
    repairIterations: num(l("REPAIR_LINEAGE_REPAIR_ITERATIONS")),
    surfaceReseals: num(l("REPAIR_LINEAGE_SURFACE_RESEALS")),
    hasSupersedingRepairAttempt: /taskType=external-review-superseding-repair status=REPAIR/.test(src),
  };
}

/**
 * Parse a bundle's §9 DELTA_ATTRIBUTION into path -> { kind, endSha12 }（the
 * content proof rendered as 12-char shas）. Used to compute a generation's
 * own touch set relative to the superseded bundle（reseal scope contract）.
 */
export function parseDeltaAttribution(text) {
  const map = new Map();
  const block = String(text ?? "").split("DELTA_ATTRIBUTION:")[1]?.split("\nADDED:")[0] ?? "";
  for (const l of block.split("\n")) {
    const m = l.match(/^\s+- (ADDED|MODIFIED|DELETED) (.+?)(?: \(content: ([0-9a-f]{12})\.\.\. -> ([0-9a-f]{12}|deleted)\.\.\.\))?$/);
    if (!m) continue;
    map.set(m[2].trim(), { kind: m[1], endSha12: m[4] && m[4] !== "deleted" ? m[4] : null });
  }
  return map;
}

/**
 * Parse a bundle's §9 CURRENT_CARD_DELTA_PATHS list.
 */
export function parseDeltaPaths(text) {
  const block = String(text ?? "").split("CURRENT_CARD_DELTA_PATHS:")[1]?.split("\nDELTA_ATTRIBUTION:")[0] ?? "";
  const paths = [];
  for (const l of block.split("\n")) {
    const m = l.match(/^\s{4}-\s+(.+)$/);
    if (m && m[1] !== "(none)") paths.push(m[1].trim());
  }
  return paths;
}

/**
 * Parse a bundle's §14 RESEAL_TOUCHED_PATHS list.
 */
export function parseResealTouchedPaths(text) {
  const block = String(text ?? "").split("RESEAL_TOUCHED_PATHS:")[1]?.split("\nSUPERSEDES_BUNDLE_IDENTITY:")[0] ?? "";
  const paths = [];
  for (const l of block.split("\n")) {
    const m = l.match(/^\s+- (.+)$/);
    if (m && m[1] !== "(none)") paths.push(m[1].trim());
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Durable delivery record（closeout-layer owned; binds the bundle artifact）.
// ---------------------------------------------------------------------------

export function serializeExternalReviewState(state, { cardId = null, fileName = null } = {}) {
  return {
    schema: EXTERNAL_REVIEW_DELIVERY_RECORD_SCHEMA,
    cardId,
    fileName,
    ...structuredClone(state ?? {}),
  };
}

/**
 * Atomically persist the external-review delivery/verdict state next to the
 * bundle（same outDir）. Secret-scanned before write; path-escape checked.
 */
export function writeExternalReviewDeliveryRecord({ outDir, state, cardId = null, fileName = null }) {
  if (!outDir || !state) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE, reason: "delivery_record_out_dir_or_state_absent" };
  }
  const root = resolve(outDir);
  mkdirSync(root, { recursive: true });
  const identity = state.delivery?.reviewBundleIdentity ?? "unknown";
  const fname = fileName ?? `external-review-delivery-${identity.slice(0, 8)}.json`;
  const target = resolve(root, fname);
  if (target !== root && !target.startsWith(root + "/")) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE, reason: "EXTERNAL_REVIEW_NOT_COMPLETE:delivery_record_path_escape" };
  }
  const text = JSON.stringify(serializeExternalReviewState(state, { cardId, fileName: fname }), null, 2) + "\n";
  const scan = scanForSecrets(text);
  if (!scan.safe) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE, reason: `EXTERNAL_REVIEW_NOT_COMPLETE:secret:${scan.matches.join(",")}` };
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
  } catch (e) {
    try { if (existsSync(tmp)) rmSyncSafe(tmp); } catch { /* best effort */ }
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE, reason: `EXTERNAL_REVIEW_NOT_COMPLETE:write:${String(e?.message ?? e).slice(0, 200)}` };
  }
  return { ok: true, path: target, fileName: fname };
}

/** Read + validate a persisted delivery record（fail-closed）.**/
export function readExternalReviewDeliveryRecord(path) {
  if (!path || !existsSync(path)) {
    return { ok: false, errors: ["delivery_record_missing"], state: null };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, errors: ["delivery_record_unreadable"], state: null };
  }
  if (raw?.schema !== EXTERNAL_REVIEW_DELIVERY_RECORD_SCHEMA) {
    return { ok: false, errors: [`delivery_record_schema_mismatch:${raw?.schema}`], state: null };
  }
  if (!isValidExternalReviewStatus(raw.externalReviewStatus)) {
    return { ok: false, errors: [`delivery_record_status_invalid:${raw.externalReviewStatus}`], state: null };
  }
  const ident = raw.delivery?.reviewBundleIdentity;
  const sha = raw.delivery?.reviewBundleSha256;
  if (ident !== null && ident !== undefined && !/^[0-9a-f]{64}$/.test(ident)) {
    return { ok: false, errors: ["delivery_record_identity_malformed"], state: null };
  }
  if (sha !== null && sha !== undefined && !/^[0-9a-f]{64}$/.test(sha)) {
    return { ok: false, errors: ["delivery_record_sha_malformed"], state: null };
  }
  const { schema: _s, cardId: _c, fileName: _f, ...state } = raw;
  // supersedes（if present）must be a well-formed binding — a repair-generation
  // delivery record carries the superseded bundle; a malformed partial binding
  // is rejected（fail-closed）so the record can never silently lose the chain.
  const sup = raw.supersedes;
  if (sup !== null && sup !== undefined) {
    if (typeof sup !== "object" || !sup.reviewBundleIdentity || !/^[0-9a-f]{64}$/.test(sup.reviewBundleIdentity)) {
      return { ok: false, errors: ["delivery_record_supersedes_malformed"], state: null };
    }
    if (sup.reviewBundleSha256 && !/^[0-9a-f]{64}$/.test(sup.reviewBundleSha256)) {
      return { ok: false, errors: ["delivery_record_supersedes_sha_malformed"], state: null };
    }
  }
  return { ok: true, errors: [], state, cardId: raw.cardId ?? null, fileName: raw.fileName ?? null };
}

// ---------------------------------------------------------------------------
// Fixed external-review delivery surface（RB-1H）— atomic publish / rotate.
// ---------------------------------------------------------------------------

/**
 * Single-owner publication lock（RB-1H repair）: O_EXCL lock file in the
 * SURFACE'S PARENT（survives the directory-swap publish）. A second
 * concurrent delivery cannot acquire it -> surface_busy -> fail-closed. A
 * crashed owner's lock（dead pid）is broken so the surface never wedges.
 */
export function acquireExternalReviewSurfaceLock(surfaceDir = null) {
  const dir = resolve(surfaceDir ?? externalReviewSurfaceDir());
  const lockPath = join(dirname(dir), ".surface.lock");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const acquire = () => {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), { flag: "wx" });
      return { ok: true, token, lockPath, dir };
    } catch (e) {
      if (e.code === "EEXIST") {
        // stale-lock recovery: a DEAD owner must not block the surface forever
        try {
          const raw = JSON.parse(readFileSync(lockPath, "utf8"));
          if (raw?.pid && !surfaceProcessAlive(raw.pid)) {
            rmSync(lockPath, { force: true });
            try {
              writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), { flag: "wx" });
              return { ok: true, token, lockPath, dir };
            } catch { /* raced with another breaker — fall through to busy */ }
          }
        } catch { /* unreadable lock — fail closed, do not guess */ }
      }
      return { ok: false, reason: "surface_busy", lockPath, dir };
    }
  };
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* best effort */ }
  return acquire();
}

function surfaceProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Release the lock only if WE own it（token match）— never breaks a foreign lock. */
export function releaseExternalReviewSurfaceLock({ lockPath, token } = {}) {
  if (!lockPath || !token) return;
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    if (raw?.token === token) rmSync(lockPath, { force: true });
  } catch { /* best effort */ }
}

/**
 * Atomically deliver the current valid bundle to the fixed external-review
 * surface（Current/）: review-bundle.txt + delivery.json + evidence.json.
 *
 * RB-1H repair（atomic-publication / concurrency contract）:
 *   1. single-owner publication: the whole publish runs under the surface
 *      lock — a second concurrent delivery fails surface_busy, never
 *      overwrites the first
 *   2. occupancy fail-closed: if Current/ already holds a published trio
 *      （any non-dot entry）the delivery REFUSES（surface_occupied）— an
 *      un-rotated valid review is never overwritten
 *   3. the trio is fully built in an INVISIBLE staging dir
 *      （parent/.incoming-<token>）, then exposed to the reviewer by ONE
 *      directory-level rename — the reviewer can never observe a mixed trio
 *      or a partial publication
 *   4. any failure returns attempted:false — the caller（runCloseoutGate）
 *      keeps the card at AWAITING_BUNDLE_DELIVERY
 */
export function deliverToExternalReviewSurface({ bundlePath, state, source = {}, outDir, surfaceDir = null, lock = null, currentCardId = null }) {
  const dir = resolve(surfaceDir ?? externalReviewSurfaceDir());
  const parent = dirname(dir);
  if (!bundlePath || !existsSync(bundlePath) || !state) {
    return { attempted: false, reason: "surface_delivery_input_missing" };
  }
  // RLD2 repair — publish is identity-guarded: a bundle whose CARD_ID does not
  // match the controller's CURRENT card is refused BEFORE any publish work
  //（delivery_card_id_mismatch）. The low-level compat callers（no
  // currentCardId）keep the previous behavior.
  if (currentCardId && typeof currentCardId === "string") {
    const ci = bundleCardIdentity(bundlePath);
    if (!ci.cardId || ci.cardId !== currentCardId) {
      return { attempted: false, reason: `delivery_card_id_mismatch:${String(ci.cardId ?? "unknown")}!=${currentCardId}` };
    }
  }
  const ownLock = lock ?? acquireExternalReviewSurfaceLock(dir);
  if (!ownLock.ok) {
    return { attempted: false, reason: ownLock.reason ?? "surface_busy", surfaceDir: dir };
  }
  const token = ownLock.token;
  const lockPath = ownLock.lockPath;
  const staging = join(parent, `.incoming-${token}`);
  try {
    // occupancy fail-closed: an un-rotated published review is NEVER overwritten.
    // AUTOLOOP_REPORT_LIFECYCLE_REPAIR_1（R7）: a RESOLVED occupant（verdict
    // bound to its own bundle）is auto-rotated to Archive/ under the same lock
    // before the next card publishes — a resolved card can never permanently
    // block the next required review. An UNRESOLVED occupant stays
    // surface_occupied（fail-closed; never overwritten, never auto-rotated）.
    // Idempotent re-delivery: an occupant whose identity + sha match THIS
    // bundle is already our own delivery（crash-after-publish / retry）—
    // reported as an attempt without touching the trio.
    mkdirSync(dir, { recursive: true });
    const occupied = readdirSync(dir).filter((f) => !f.startsWith("."));
    if (occupied.length > 0) {
      const occDelivery = join(dir, "delivery.json");
      const occRec = existsSync(occDelivery) ? readExternalReviewDeliveryRecord(occDelivery) : { ok: false, errors: ["surface_delivery_record_missing"] };
      if (occRec.ok && occRec.state?.delivery?.reviewBundleIdentity && state?.delivery?.reviewBundleIdentity
          && occRec.state.delivery.reviewBundleIdentity === state.delivery.reviewBundleIdentity
          && occRec.state.delivery.reviewBundleSha256 === state.delivery.reviewBundleSha256) {
        return { attempted: true, method: "external-review-surface", idempotent: true, attemptedAt: new Date().toISOString(), surfaceDir: dir, files: ["review-bundle.txt", "delivery.json"] };
      }
      const resolved = occRec.ok
        && occRec.state?.verdict
        && typeof occRec.state.verdict.bundleIdentity === "string"
        && occRec.state.verdict.bundleIdentity === occRec.state.delivery?.reviewBundleIdentity
        && EXTERNAL_REVIEW_VERDICTS.includes(occRec.state.externalReviewStatus);
      if (resolved) {
        const rot = rotateExternalReviewSurface({
          surfaceDir: dir,
          cardId: occRec.cardId ?? "CARD",
          identity: occRec.state.delivery?.reviewBundleIdentity ?? "unknown",
          verdict: occRec.state.externalReviewStatus,
          lock: ownLock,
        });
        if (!rot.ok) {
          return { attempted: false, reason: `surface_occupied:auto_rotate_failed:${rot.reason}`, surfaceDir: dir };
        }
      } else {
        // RLD2 — identity-explicit occupancy: when the occupant belongs to a
        // DIFFERENT card than the one being published, the reason names it
        //（surface_occupied_by_different_card）so the caller can distinguish
        // a stale-card block from a same-card re-publish block.
        const occCard = occRec.cardId ?? "unknown";
        const stale = currentCardId && typeof currentCardId === "string" && occCard !== currentCardId;
        return { attempted: false, reason: stale ? `surface_occupied_by_different_card:${occCard}!=${currentCardId}` : `surface_occupied:${occupied.slice(0, 5).join(",")}`, surfaceDir: dir };
      }
    }
    // build the trio in invisible staging（reviewer cannot see it）…
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    // the surface delivery record honestly records THIS delivery attempt
    //（informational — never a receipt; the verdict stays the receipt）.
    const attemptedAt = new Date().toISOString();
    const recordState = state && typeof state === "object"
      ? { ...state, delivery: { ...(state.delivery ?? {}), attempted: true, method: "external-review-surface", attemptedAt } }
      : state;
    const files = {
      "review-bundle.txt": readFileSync(bundlePath, "utf8"),
      "delivery.json": JSON.stringify(serializeExternalReviewState(recordState, { cardId: source.task?.cardId ?? null, fileName: "delivery.json" }), null, 2) + "\n",
    };
    const ev = Array.isArray(source.evidence) && source.evidence.length > 0 ? source.evidence[0] : null;
    if (ev?.path && existsSync(ev.path)) {
      files["evidence.json"] = readFileSync(ev.path, "utf8");
    }
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(staging, name), content, "utf8");
    }
    // …then publish with ONE directory-level rename（atomic; no mixed trio
    // possible: the reviewer either sees the previous state or the full trio）
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".")) rmSync(join(dir, f), { recursive: true, force: true });
    }
    renameSync(staging, dir);
    return { attempted: true, method: "external-review-surface", attemptedAt: new Date().toISOString(), surfaceDir: dir, files: Object.keys(files) };
  } catch (e) {
    return { attempted: false, reason: `surface_delivery_failed:${String(e?.message ?? e).slice(0, 200)}`, surfaceDir: dir };
  } finally {
    releaseExternalReviewSurfaceLock({ lockPath, token });
    try {
      // stale staging cleanup: under OUR lock no other publisher is mid-flight,
      // so any leftover .incoming-* in the parent is a crashed attempt's residue
      for (const f of readdirSync(parent)) {
        if (f.startsWith(".incoming-")) rmSync(join(parent, f), { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }
}

/**
 * Rotate the current surface into the flat Archive/ after a verdict:
 *   Archive/<YYYYMMDD>-<CARD>-<identity8>-<VERDICT>-<kind>（kind = the
 *   original file name: review-bundle.txt / delivery.json / evidence.json）
 * then clear Current/. `verdict` defaults to PENDING when the card was
 * superseded before an external verdict. Runs under the same single-owner
 * lock（never races a concurrent publish）. Returns the archived paths.
 */
export function rotateExternalReviewSurface({ surfaceDir = null, archiveDir = null, cardId = "CARD", identity = "unknown", verdict = "PENDING", dateStr = null, lock = null } = {}) {
  const dir = resolve(surfaceDir ?? externalReviewSurfaceDir());
  const arch = resolve(archiveDir ?? externalReviewArchiveDir());
  const prefix = dateStr ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const label = `${prefix}-${cardId}-${String(identity).slice(0, 8)}-${verdict}`;
  if (!existsSync(dir)) return { ok: true, archived: [], cleared: true };
  const ownLock = lock ?? acquireExternalReviewSurfaceLock(dir);
  if (!ownLock.ok) {
    return { ok: false, reason: ownLock.reason ?? "surface_busy", archived: [] };
  }
  const archived = [];
  try {
    mkdirSync(arch, { recursive: true });
    for (const name of ["review-bundle.txt", "delivery.json", "evidence.json"]) {
      const src = join(dir, name);
      if (!existsSync(src)) continue;
      const dest = join(arch, `${label}-${name}`);
      renameSync(src, dest);
      archived.push(dest);
    }
    // stray tmp files（dot-prefixed）are temp — removable, never archived
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".")) { try { rmSync(join(dir, f), { force: true }); } catch { /* best effort */ } }
    }
    return { ok: true, archived, cleared: readdirSync(dir).length === 0 };
  } catch (e) {
    return { ok: false, reason: `surface_rotate_failed:${String(e?.message ?? e).slice(0, 200)}`, archived };
  } finally {
    // Release only a lock WE acquired. A caller that passed its own lock
    //（R7 auto-rotation inside deliverToExternalReviewSurface）owns release.
    if (!lock) {
      releaseExternalReviewSurfaceLock({ lockPath: ownLock.lockPath, token: ownLock.token });
    }
  }
}

// ---------------------------------------------------------------------------
// Recursive canonical JSON（CBM-1 fix）— NEVER the shallow replacer form.
// ---------------------------------------------------------------------------

/**
 * R5 — artifact-level proof that the required bundle currently exists on the
 * configured Current/ surface with a matching delivery record. The writer's
 * own "delivery attempted" claim is never the proof: the surface files are
 * re-read and the bundle identity + SHA-256 are recomputed independently.
 * Used by runCloseoutGate so that an AWAITING_EXTERNAL_REVIEW state can only
 * accompany a truly present artifact（fail-closed）.
 */
export function verifyExternalReviewSurface({ surfaceDir = null, expected = {} } = {}) {
  const dir = resolve(surfaceDir ?? externalReviewSurfaceDir());
  const errors = [];
  const bundlePath = join(dir, "review-bundle.txt");
  const deliveryPath = join(dir, "delivery.json");

  if (!existsSync(bundlePath)) {
    errors.push("surface_bundle_missing");
  } else {
    const raw = readFileSync(bundlePath, "utf8");
    const ident = raw.match(/^REVIEW_BUNDLE_IDENTITY: ([0-9a-f]{64})$/m)?.[1] ?? null;
    if (expected.identity && ident !== expected.identity) {
      errors.push(`surface_bundle_identity_mismatch:${ident ? ident.slice(0, 8) : "none"}!=${expected.identity.slice(0, 8)}`);
    }
    const linesArr = raw.split("\n");
    const shaLineIdx = [...linesArr].reverse().findIndex((l) => l.trim().startsWith("REVIEW_BUNDLE_SHA256:"));
    const statedSha = shaLineIdx >= 0 ? linesArr[linesArr.length - 1 - shaLineIdx].split(":")[1]?.trim() : null;
    const contentOnly = shaLineIdx >= 0 ? linesArr.slice(0, linesArr.length - 1 - shaLineIdx).join("\n") + "\n" : raw;
    const actualSha = sha256Hex(contentOnly);
    if (expected.sha256 && statedSha !== expected.sha256) {
      errors.push("surface_bundle_sha_mismatch");
    }
    if (expected.sha256 && actualSha !== expected.sha256) {
      errors.push("surface_bundle_sha_recompute_mismatch");
    }
  }

  if (!existsSync(deliveryPath)) {
    errors.push("surface_delivery_record_missing");
  } else {
    const rec = readExternalReviewDeliveryRecord(deliveryPath);
    if (!rec.ok) {
      errors.push(`surface_delivery_record_invalid:${rec.errors.join(";")}`);
    } else {
      if (expected.identity && rec.state?.delivery?.reviewBundleIdentity !== expected.identity) {
        errors.push("surface_delivery_identity_mismatch");
      }
      if (expected.sha256 && rec.state?.delivery?.reviewBundleSha256 !== expected.sha256) {
        errors.push("surface_delivery_sha_mismatch");
      }
      if (expected.cardId && rec.cardId && rec.cardId !== expected.cardId) {
        errors.push(`surface_delivery_card_mismatch:${rec.cardId}`);
      }
      if (rec.state?.externalReviewStatus === EXTERNAL_REVIEW_STATUSES[1]) {
        errors.push("surface_delivery_blocked");
      }
    }
  }

  return { ok: errors.length === 0, errors, surfaceDir: dir };
}

// ---------------------------------------------------------------------------
// R-13 — verdict-time artifact verification (single fresh read).
// ---------------------------------------------------------------------------

/**
 * R-13 — SINGLE-READ VERDICT-TIME ARTIFACT VERIFICATION.
 *
 * Residual defect repaired here: a self-consistent forged review artifact
 * (any content + a recomputed footer SHA) paired with a correspondingly
 * forged delivery record could previously receive an external verdict,
 * because verdict application compared record values against a text
 * extraction without structurally validating the artifact and without
 * binding its CARD_ID. Delivery-record fields are EXPECTED VALUES — never
 * proof. Caller-supplied identity/SHA values have ZERO authority.
 *
 * One fresh read of the canonical delivered artifact feeds ALL of:
 *   - structural validation (canonical validateReviewBundle requirements);
 *   - content SHA derivation (footer-excluded, canonical convention);
 *   - bundle identity extraction (trusted only AFTER structural validation);
 *   - artifact card identity extraction.
 * The result is compared against the delivery record's expected values
 * (identity / SHA / card) and returned as the verified truth used for
 * verdict persistence. Fail-closed on every mismatch.
 *
 * @param {object} opts
 *   deliveryPath    — canonical delivery.json beside the artifact.
 *   expectedCardId  — explicit verdict target card (when the caller knows
 *                     which card the verdict is for); artifact card must
 *                     match it as well.
 *   surfaceBundlePath — optional explicit artifact path (tests); default is
 *                     review-bundle.txt beside the delivery record.
 * @returns {{ ok:true, artifact:{ path, text, sha256, identity, cardId } }
 *          | { ok:false, holdCode, reason }}
 */
export function verifyDeliveredArtifactForVerdict({ deliveryPath, expectedCardId = null, surfaceBundlePath = null } = {}) {
  const rec = readExternalReviewDeliveryRecord(deliveryPath);
  if (!rec.ok) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE, reason: `EXTERNAL_REVIEW_STALE_BUNDLE:delivery_record_invalid:${rec.errors.join(";")}` };
  }
  const delivery = rec.state?.delivery ?? null;
  const expectedIdentity = delivery?.reviewBundleIdentity ?? null;
  const expectedSha = delivery?.reviewBundleSha256 ?? null;
  if (typeof expectedIdentity !== "string" || !/^[0-9a-f]{64}$/.test(expectedIdentity)) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE, reason: "EXTERNAL_REVIEW_STALE_BUNDLE:recorded_bundle_identity_absent_or_malformed" };
  }
  if (typeof expectedSha !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha)) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE, reason: "EXTERNAL_REVIEW_STALE_BUNDLE:recorded_bundle_sha_absent_or_malformed" };
  }
  const artifactPath = surfaceBundlePath ?? join(dirname(resolve(deliveryPath)), "review-bundle.txt");
  if (!existsSync(artifactPath)) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.ARTIFACT_INVALID, reason: `EXTERNAL_REVIEW_ARTIFACT_INVALID:surface_bundle_missing:${artifactPath}` };
  }
  // ── ONE fresh read. Every derivation below consumes THESE exact bytes. ──
  const text = readFileSync(artifactPath, "utf8");
  // Content SHA from the SAME fresh bytes (footer-excluded canonical rule).
  // Compared FIRST: a stale/rotated generation is precisely diagnosed even
  // when it is also structurally invalid.
  const linesArr = text.split("\n");
  const shaLineIdx = [...linesArr].reverse().findIndex((l) => l.trim().startsWith("REVIEW_BUNDLE_SHA256:"));
  const contentOnly = shaLineIdx >= 0 ? linesArr.slice(0, linesArr.length - 1 - shaLineIdx).join("\n") + "\n" : text;
  const freshSha = sha256Hex(contentOnly);
  if (freshSha !== expectedSha) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE, reason: `EXTERNAL_REVIEW_STALE_BUNDLE:surface_bundle_sha_diverges_from_record:${freshSha.slice(0, 12)}!=${expectedSha.slice(0, 12)}` };
  }
  // Structural validation over the canonical artifact (validateReviewBundle
  // re-reads the path internally; the single-read contract is enforced by the
  // recheck guard below: the bytes we derive values from must be the bytes
  // that validated — a concurrent rewrite between our read and the
  // validator's read fails closed). A self-consistent forged artifact
  // (content + recomputed footer SHA) cannot survive this.
  const validation = validateReviewBundle(artifactPath, {});
  if (!validation.ok) {
    return { ok: false, holdCode: validation.holdCode ?? EXTERNAL_REVIEW_HOLDS.ARTIFACT_INVALID, reason: `EXTERNAL_REVIEW_ARTIFACT_INVALID:${validation.errors.join(";").slice(0, 400)}` };
  }
  const recheck = readFileSync(artifactPath, "utf8");
  if (recheck !== text) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.ARTIFACT_INVALID, reason: "EXTERNAL_REVIEW_ARTIFACT_INVALID:artifact_mutated_during_verification" };
  }
  // Identity from the SAME fresh bytes — trusted only after structural
  // validation passed (a forged identity line cannot survive validation).
  const freshIdentity = text.match(/^REVIEW_BUNDLE_IDENTITY:\s*([0-9a-f]{64})$/m)?.[1] ?? null;
  if (!freshIdentity || freshIdentity !== expectedIdentity) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE, reason: `EXTERNAL_REVIEW_STALE_BUNDLE:surface_bundle_identity_diverges_from_record:${freshIdentity ? freshIdentity.slice(0, 8) : "none"}!=${expectedIdentity.slice(0, 8)}` };
  }
  // Card binding from the SAME fresh bytes.
  const artifactCardId = text.match(/^CARD_ID:\s*(.+)$/m)?.[1]?.trim() ?? null;
  if (!artifactCardId) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.CARD_MISMATCH, reason: "EXTERNAL_REVIEW_CARD_MISMATCH:artifact_card_id_missing" };
  }
  if (rec.cardId && artifactCardId !== rec.cardId) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.CARD_MISMATCH, reason: `EXTERNAL_REVIEW_CARD_MISMATCH:artifact_card:${artifactCardId}!=delivery_card:${rec.cardId}` };
  }
  if (expectedCardId && artifactCardId !== expectedCardId) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.CARD_MISMATCH, reason: `EXTERNAL_REVIEW_CARD_MISMATCH:artifact_card:${artifactCardId}!=target_card:${expectedCardId}` };
  }
  return {
    ok: true,
    artifact: Object.freeze({ path: artifactPath, text, sha256: freshSha, identity: freshIdentity, cardId: artifactCardId }),
  };
}

/**
 * R-13 — ARTIFACT-AWARE VERDICT APPLICATION (the production library seam).
 *
 * The low-level applyExternalReviewVerdict is a pure state transition: it
 * compares caller-supplied identity/SHA against the delivery record and can
 * therefore be satisfied by a caller that merely echoes the record. Production
 * callers MUST use this entry point instead: artifact truth is established by
 * verifyDeliveredArtifactForVerdict (single fresh read + structural validation
 * + SHA/identity/card binding) BEFORE any state mutation, and the persisted
 * verdict binds the FRESHLY VERIFIED values — never caller copies.
 *
 * Conflict fence: an already-finalized receipt (verdict bound to the current
 * bundle) cannot be overwritten by a different verdict — a new generation via
 * REPAIR/supersedes is the only change path. Re-applying the SAME verdict with
 * the same reviewer semantics over the same verified artifact is idempotent.
 *
 * @param {object} opts
 *   deliveryPath   — canonical delivery.json.
 *   verdict        — PASS | REPAIR | HOLD
 *   reviewerIdentity, reviewedAt, agentIdentity, findingsDigest — as in
 *                    applyExternalReviewVerdict.
 *   expectedCardId — explicit verdict target card (optional).
 *   artifact       — optional pre-verified artifact from
 *                    verifyDeliveredArtifactForVerdict (callers that already
 *                    verified MUST pass it; the helper re-verifies otherwise).
 */
export function applyExternalReviewVerdictForDelivery(opts = {}) {
  const deliveryPath = opts.deliveryPath ?? null;
  if (!deliveryPath) {
    return { ok: false, errors: [`${EXTERNAL_REVIEW_HOLDS.INVALID_VERDICT}:delivery_path_required`], state: null };
  }
  const verified = opts.artifact ?? verifyDeliveredArtifactForVerdict({ deliveryPath, expectedCardId: opts.expectedCardId ?? null });
  if (!verified.ok) {
    return { ok: false, errors: [verified.reason ?? `${EXTERNAL_REVIEW_HOLDS.ARTIFACT_INVALID}:verification_failed`], state: null, holdCode: verified.holdCode };
  }
  const rec = readExternalReviewDeliveryRecord(deliveryPath);
  if (!rec.ok) {
    return { ok: false, errors: [`delivery_record_invalid:${rec.errors.join(";")}`], state: null };
  }
  const state = rec.state;
  // Conflict fence: a finalized receipt (verdict bound to the CURRENT bundle)
  // is immutable except through a new generation. Same verdict + same reviewer
  // over the same verified artifact stays idempotent.
  const existing = state?.verdict ?? null;
  if (existing && typeof existing.bundleIdentity === "string" && existing.bundleIdentity === state.delivery?.reviewBundleIdentity) {
    const sameVerdict = existing.verdict === opts.verdict
      && existing.bundleSha256 === verified.artifact.sha256
      && existing.reviewerIdentity === (opts.reviewerIdentity ?? null);
    if (!sameVerdict) {
      return {
        ok: false,
        holdCode: EXTERNAL_REVIEW_HOLDS.VERDICT_CONFLICT,
        errors: [`${EXTERNAL_REVIEW_HOLDS.VERDICT_CONFLICT}:finalized_receipt:${existing.verdict}!=${opts.verdict}`],
        state: null,
      };
    }
    // Idempotent re-apply: re-run the low-level transition (same inputs) so
    // the receipt stays deterministic; reviewedAt may refresh.
    const applied = applyExternalReviewVerdict(state, {
      verdict: opts.verdict,
      reviewerIdentity: opts.reviewerIdentity,
      reviewedAt: opts.reviewedAt ?? new Date().toISOString(),
      bundleIdentity: verified.artifact.identity,
      bundleSha256: verified.artifact.sha256,
      agentIdentity: opts.agentIdentity,
      findingsDigest: opts.findingsDigest,
    });
    if (!applied.ok) return applied;
    return { ok: true, errors: [], state: applied.state, idempotent: true, artifact: verified.artifact };
  }
  const applied = applyExternalReviewVerdict(state, {
    verdict: opts.verdict,
    reviewerIdentity: opts.reviewerIdentity,
    reviewedAt: opts.reviewedAt ?? new Date().toISOString(),
    // VERDICT BINDING: freshly verified values only — caller identity/SHA
    // fields are never consulted for authority.
    bundleIdentity: verified.artifact.identity,
    bundleSha256: verified.artifact.sha256,
    agentIdentity: opts.agentIdentity,
    findingsDigest: opts.findingsDigest,
  });
  if (!applied.ok) return applied;
  return { ok: true, errors: [], state: applied.state, artifact: verified.artifact };
}

// ---------------------------------------------------------------------------
// RLD2 repair — identity-verified delivery SELECTION（delivery is a verified
// dereference of authoritative state, never a filesystem discovery）.
// ---------------------------------------------------------------------------

/** Recompute a bundle's CONTENT sha256（the footer REVIEW_BUNDLE_SHA256 line
 *  is excluded — mirrors the validator's recompute）. */
export function bundleContentSha256(bundlePath) {
  const raw = readFileSync(bundlePath, "utf8");
  const linesArr = raw.split("\n");
  const shaLineIdx = [...linesArr].reverse().findIndex((l) => l.trim().startsWith("REVIEW_BUNDLE_SHA256:"));
  const contentOnly = shaLineIdx >= 0 ? linesArr.slice(0, linesArr.length - 1 - shaLineIdx).join("\n") + "\n" : raw;
  return sha256Hex(contentOnly);
}

/** Parse CARD_ID + REVIEW_BUNDLE_IDENTITY from a bundle text（for identity
 *  verification — never used to SELECT）. */
export function bundleCardIdentity(bundlePath) {
  const raw = readFileSync(bundlePath, "utf8");
  return {
    cardId: raw.match(/^CARD_ID:\s*(.+)$/m)?.[1]?.trim() ?? null,
    identity: raw.match(/^REVIEW_BUNDLE_IDENTITY:\s*([0-9a-f]{64})$/m)?.[1] ?? null,
  };
}

/**
 * RLD2 — the AUTHORITATIVE delivery selector. "The current review bundle" is
 * a VERIFIED DEREFERENCE of the surface + delivery record against the
 * controller's CURRENT CARD — never a filename / mtime / newest-file
 * discovery. Fail-closed outcomes:
 *   NO_NEW_REVIEW_BUNDLE             — no awaiting-review bundle exists for
 *                                      the current card; a stale generation is
 *                                      NEVER substituted
 *   STALE_CARD_IDENTITY              — the surface holds a DIFFERENT card's
 *                                      generation
 *   STALE_GENERATION_ALREADY_REVIEWED — the current card's generation was
 *                                      already externally reviewed（PASS
 *                                      bound）— never re-delivered as a new
 *                                      generation
 *   SURFACE_SHA_MISMATCH             — the bundle file's content sha does not
 *                                      match the delivery record
 *   SURFACE_RECORD_INVALID           — the delivery record is unreadable /
 *                                      malformed / missing
 *
 * @param {object} opts — { surfaceDir, currentCardId, cachedPath? };
 *   cachedPath models a stale attachment/export cache: the file is verified
 *   by identity + sha（rejected when stale）instead of being trusted.
 * @returns {{ ok: true, bundle: { path, identity, sha256, cardId, status,
 *           verdict, supersedes } } | { ok: false, holdCode, reason }}
 */
export function currentReviewDelivery({ surfaceDir = null, currentCardId = null, cachedPath = null } = {}) {
  const dir = resolve(surfaceDir ?? externalReviewSurfaceDir());
  if (!currentCardId || typeof currentCardId !== "string" || currentCardId.length === 0) {
    return { ok: false, holdCode: "NO_NEW_REVIEW_BUNDLE", reason: "currentReviewDelivery requires the controller's current card id" };
  }
  if (cachedPath) {
    // A cached/exported path is verified by IDENTITY, never trusted by path.
    if (!existsSync(cachedPath)) {
      return { ok: false, holdCode: "NO_NEW_REVIEW_BUNDLE", reason: `cached path ${cachedPath} missing — a stale generation is never substituted` };
    }
    const ci = bundleCardIdentity(cachedPath);
    if (!ci.cardId || ci.cardId !== currentCardId) {
      return { ok: false, holdCode: "STALE_CARD_IDENTITY", reason: `cached bundle CARD_ID ${String(ci.cardId)} != current card ${currentCardId}` };
    }
    // When the surface still holds the authoritative record, the cached
    // artifact must MATCH it（delivery source identity == authoritative
    // source identity — NEG-RLD3）. A divergent cached source is stale.
    const deliveryPath = join(dir, "delivery.json");
    if (existsSync(deliveryPath)) {
      const rec = readExternalReviewDeliveryRecord(deliveryPath);
      if (rec.ok && rec.state?.delivery?.reviewBundleIdentity && ci.identity && ci.identity !== rec.state.delivery.reviewBundleIdentity) {
        return { ok: false, holdCode: "STALE_CARD_IDENTITY", reason: `cached bundle identity ${String(ci.identity).slice(0, 8)} diverges from authoritative surface identity ${String(rec.state.delivery.reviewBundleIdentity).slice(0, 8)}` };
      }
    }
    return {
      ok: true,
      bundle: { path: cachedPath, identity: ci.identity, sha256: bundleContentSha256(cachedPath), cardId: ci.cardId, status: null, verdict: null, supersedes: null },
      source: "cached-path-verified",
    };
  }
  const deliveryPath = join(dir, "delivery.json");
  if (!existsSync(deliveryPath)) {
    return { ok: false, holdCode: "NO_NEW_REVIEW_BUNDLE", reason: `no delivery record on the surface for current card ${currentCardId} — no new review bundle` };
  }
  const rec = readExternalReviewDeliveryRecord(deliveryPath);
  if (!rec.ok) {
    return { ok: false, holdCode: "SURFACE_RECORD_INVALID", reason: `surface delivery record invalid: ${rec.errors.join("; ")}` };
  }
  if (rec.cardId && rec.cardId !== currentCardId) {
    return { ok: false, holdCode: "STALE_CARD_IDENTITY", reason: `surface holds card ${rec.cardId} (identity ${String(rec.state?.delivery?.reviewBundleIdentity ?? "").slice(0, 8)}) != current card ${currentCardId}` };
  }
  // An already-externally-reviewed COMPLETE generation is never re-delivered
  // as a new generation（unless explicitly requested by identity — out of the
  // automatic path）.
  if (externalReviewComplete(rec.state)) {
    return { ok: false, holdCode: "STALE_GENERATION_ALREADY_REVIEWED", reason: `generation ${String(rec.state.delivery?.reviewBundleIdentity ?? "").slice(0, 8)} of ${currentCardId} was already externally reviewed (PASS) — never re-delivered as a new generation` };
  }
  const bundlePath = join(dir, "review-bundle.txt");
  if (!existsSync(bundlePath)) {
    return { ok: false, holdCode: "NO_NEW_REVIEW_BUNDLE", reason: `surface holds a delivery record but no review-bundle.txt — no new review bundle` };
  }
  const ci = bundleCardIdentity(bundlePath);
  if (ci.cardId && ci.cardId !== currentCardId) {
    return { ok: false, holdCode: "STALE_CARD_IDENTITY", reason: `surface bundle CARD_ID ${ci.cardId} != current card ${currentCardId}` };
  }
  const actualSha = bundleContentSha256(bundlePath);
  const recordSha = rec.state?.delivery?.reviewBundleSha256 ?? null;
  if (recordSha && actualSha !== recordSha) {
    return { ok: false, holdCode: "SURFACE_SHA_MISMATCH", reason: `surface bundle content sha ${actualSha.slice(0, 12)} != delivery record sha ${recordSha.slice(0, 12)}` };
  }
  return {
    ok: true,
    bundle: {
      path: bundlePath,
      identity: ci.identity ?? rec.state?.delivery?.reviewBundleIdentity ?? null,
      sha256: actualSha,
      cardId: ci.cardId ?? rec.cardId ?? null,
      status: rec.state?.externalReviewStatus ?? null,
      verdict: rec.state?.verdict?.verdict ?? null,
      supersedes: rec.state?.supersedes ?? null,
    },
    source: "surface-verified",
  };
}


// ---------------------------------------------------------------------------
// Recursive canonical JSON（CBM-1 fix）— NEVER the shallow replacer form.
// ---------------------------------------------------------------------------

export function recursiveCanonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function sha256Hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

// ---------------------------------------------------------------------------
// Repo facts（git-derived, authoritative — never trusted from the source）.
// ---------------------------------------------------------------------------

function git(repoPath, args) {
  const r = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (r.status !== 0) return { ok: false, stdout: "", stderr: r.stderr || r.stdout || "" };
  return { ok: true, stdout: r.stdout.trim() };
}

// Raw（NUL-delimited）git output. NEVER trimmed: trimming the whole output
// would eat the leading whitespace of the FIRST porcelain record and then a
// fixed `slice(3)` would cut the first character of the first path（the RB-1
// `package.json` -> `ackage.json` defect）.
function gitRaw(repoPath, args) {
  const r = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if (r.status !== 0) return { ok: false, stdout: "", stderr: r.stderr || r.stdout || "" };
  return { ok: true, stdout: r.stdout };
}

/**
 * Parse `git status --porcelain=v1 -z` output into structured records.
 *
 * Machine-readable format（NUL-terminated fields; never line-sliced）:
 *   normal         : `XY <path>\0`            — X = index status, Y = worktree status
 *   rename / copy  : `XY <dest>\0<source>\0`  — git status -z emits the
 *                     DESTINATION first, then the SOURCE（empirically
 *                     verified; the human-readable form is
 *                     `XY <source> -> <dest>`）.
 *
 * Paths are kept intact（spaces / Unicode / nesting）; no fixed-character
 * slicing of trimmed lines, no whitespace-split of full paths, no unchecked
 * rename-string dissection. Records that do not parse are flagged
 * `malformed` so the caller can fail closed instead of emitting a wrong
 * path identity.
 */
export function parseGitStatusPorcelainZ(raw) {
  const records = [];
  const fields = String(raw ?? "").split("\0");
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    i += 1;
    if (f.length === 0) continue; // leading / trailing NUL
    if (f.length < 3) {
      records.push({ status: f, path: null, source: null, destination: null, rename: false, malformed: true });
      continue;
    }
    const status = f.slice(0, 2);
    const destination = f.slice(3);
    // Rename / copy entries carry a second NUL-terminated path（the source）.
    // A rename WITHOUT its source field is malformed（fail closed — never
    // silently record a wrong/partial path identity）.
    if (status[0] === "R" || status[0] === "C") {
      if (i >= fields.length) {
        records.push({ status, path: null, source: null, destination: null, rename: true, malformed: true });
        continue;
      }
      const source = fields[i];
      i += 1;
      records.push({ status, path: destination, source, destination, rename: true, malformed: false });
      continue;
    }
    records.push({ status, path: destination, source: null, destination: null, rename: false, malformed: false });
  }
  return records;
}

/** Deterministic canonical record（matches the human-readable porcelain form）. */
export function canonicalStatusRecord(rec) {
  if (rec?.rename) return `${rec.status} ${rec.source ?? ""} -> ${rec.destination ?? ""}`;
  return `${rec.status} ${rec.path ?? ""}`;
}

/** All repository-relative paths affected by a record（renames affect both）. */
export function statusRecordPaths(rec) {
  if (rec?.rename) {
    const out = [];
    if (rec.source) out.push(rec.source);
    if (rec.destination) out.push(rec.destination);
    return out;
  }
  return rec?.path ? [rec.path] : [];
}

export function collectRepoFacts(repoPath, { baseline = null } = {}) {
  const head = git(repoPath, ["rev-parse", "HEAD"]);
  const tree = git(repoPath, ["rev-parse", "HEAD^{tree}"]);
  const branch = git(repoPath, ["branch", "--show-current"]);
  const remote = git(repoPath, ["remote", "get-url", "origin"]);
  if (!head.ok || !tree.ok) {
    throw new Error(`review-bundle: cannot read repo identity at ${repoPath}: ${head.stderr}${tree.stderr}`);
  }
  // NUL-delimited porcelain v1（RB-1R path-identity fix）:
  //   `-c core.quotepath=false` keeps Unicode paths unquoted;
  //   `--untracked-files=all` lists every untracked FILE（never collapses a
  //   directory to `?? dir/`）.
  const status = gitRaw(repoPath, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) {
    throw new Error(`review-bundle: cannot read git status at ${repoPath}: ${status.stderr}`);
  }
  const records = parseGitStatusPorcelainZ(status.stdout);
  const malformed = records.filter((r) => r.malformed);
  if (malformed.length > 0) {
    throw new Error(`review-bundle: unparseable git status records at ${repoPath}: ${malformed.map((r) => JSON.stringify(r.status)).join(",")}`);
  }
  const dirtyPaths = [];
  for (const rec of records) {
    for (const p of statusRecordPaths(rec)) {
      if (!dirtyPaths.includes(p)) dirtyPaths.push(p);
    }
  }
  const untrackedFiles = records.filter((r) => r.status === "??").map((r) => r.path);
  const canonicalLines = records.map(canonicalStatusRecord).sort();
  const dirtyText = canonicalLines.join("\n");
  const dirtyDigest = dirtyText.length > 0 ? `dirty:${sha256Hex(dirtyText)}` : "clean";
  // FM-3 baseline / delta provenance: when a machine-captured baseline
  // snapshot is supplied（captured at card START）, the baseline digest is
  // authoritative for BASELINE_DIRTY_DIGEST and the delta（current-card
  // touched candidates）is derived as final − baseline — NEVER the whole
  // final dirty tree（the production repo may hold大量 pre-existing dirty
  // state）. Without a baseline the legacy behavior is unchanged
  //（baseline digest == final digest）— historical / backfill bundles are
  // unaffected（R5）.
  const baselinePaths = baseline && typeof baseline === "object" && Array.isArray(baseline.dirtyPaths)
    ? [...new Set(baseline.dirtyPaths.filter((p) => typeof p === "string" && p.length > 0))]
    : [];
  // TA-2R content identity: per-path sha256 of the CURRENT working-tree file
  //（final side）. A missing file（deleted）hashes null — content change vs the
  // card-start sha proves DELETED attribution. The content mode activates only
  // when the baseline snapshot carries its own pathShas（content-v1）. Both
  // digests（dirty + content）stay git/live-derived — never trusted from the
  // source.
  const pathShas = {};
  for (const p of dirtyPaths) {
    pathShas[p] = fileSha256(join(repoPath, p));
  }
  const contentDigest = sha256Hex(recursiveCanonicalJson(pathShas));
  const delta = computeInventoryDelta({
    baselinePaths,
    finalDirtyPaths: dirtyPaths,
    baselinePathShas: baseline && typeof baseline === "object" ? baseline.pathShas : null,
    finalPathShas: pathShas,
  });
  return {
    repository: remote.ok ? remote.stdout : null,
    branch: branch.ok ? branch.stdout : "",
    head: head.stdout,
    treeSha: tree.stdout,
    worktreePath: realpathSync(repoPath),
    // A supplied baseline snapshot is authoritative for the baseline digest
    // EVEN when it is clean（dirtyPaths=[] / digest `clean`）— otherwise a
    // clean-baseline card would render section 4（final digest）≠ section 9
    //（`clean`）and the validator's digest cross-check would false-fail.
    baselineDirtyDigest: baseline && typeof baseline.dirtyDigest === "string" ? baseline.dirtyDigest : dirtyDigest,
    finalDirtyDigest: dirtyDigest,
    baselineDirtyPaths: delta.baselinePaths,
    deltaPaths: delta.deltaPaths,
    membershipDelta: delta.membershipDelta,
    contentModified: delta.contentModified,
    unattributable: delta.unattributable,
    pathShas,
    contentDigest,
    dirtyPaths,
    untrackedFiles,
    canonicalLines,
    worktreeClean: canonicalLines.length === 0,
    remote: remote.ok ? remote.stdout : null,
  };
}

/**
 * FM-3 — capture the machine baseline snapshot for a card（call at card
 * START, before any implementation work）: the full dirty-path inventory +
 * digest over the canonical porcelain records. This snapshot is the
 * authoritative `pre-existing dirty` boundary; the closeout delta is
 * derived against it, so pre-existing dirty paths are never misclassified
 * as current-card changes（R3）. Persist it in the card's closeout-state
 * record（`baseline`）.
 */
export function captureBaselineInventory(repoPath, { cardId = "UNKNOWN-CARD", recordedAt = new Date().toISOString() } = {}) {
  const facts = collectRepoFacts(repoPath);
  // TA-2R content-v1: the snapshot binds per-path content identity（sha256 of
  // the working-tree file at card START）so the closeout delta can attribute
  // modifications to pre-existing dirty paths with content proof — and fail
  // closed（unattributable）when any card-start sha is missing.
  const pathShas = {};
  for (const p of facts.dirtyPaths) {
    pathShas[p] = fileSha256(join(repoPath, p));
  }
  return {
    schema: CARD_INVENTORY_BASELINE_SCHEMA,
    cardId,
    capturedAt: recordedAt,
    repository: facts.repository ?? null,
    branch: facts.branch,
    head: facts.head,
    treeSha: facts.treeSha,
    worktreePath: facts.worktreePath,
    dirtyPaths: facts.dirtyPaths,
    untrackedFiles: facts.untrackedFiles,
    canonicalLines: facts.canonicalLines,
    dirtyDigest: facts.baselineDirtyDigest,
    attributionModel: "content-v1",
    pathShas,
    contentDigest: sha256Hex(recursiveCanonicalJson(pathShas)),
  };
}

/**
 * TA-2（V2）— classify the card delta（ADDED / MODIFIED / DELETED）from the
 * SINGLE machine delta truth: collectRepoFacts(baseline) + per-path porcelain
 * status. One derivation feeds CURRENT_CARD_DELTA_PATHS, the §9 lists and the
 * Diff Summary — no second independent diff can ever diverge（NEG14;
 * TA1_REPAIRED_DELTA_SURFACE_STILL_INTERNALLY_CONTRADICTORY guard）.
 */
export function classifyDeltaFromFacts(facts) {
  const statusByPath = new Map();
  for (const rec of facts.canonicalLines ?? []) {
    const arrow = rec.indexOf(" -> ");
    const status = rec.slice(0, 2).trim();
    const rest = arrow >= 0 ? rec.slice(3).split(" -> ") : [rec.slice(3)];
    for (const p of rest.map((x) => x.trim()).filter(Boolean)) statusByPath.set(p, status);
  }
  // TA-2R content identity: a pre-existing dirty path whose CONTENT changed
  // during the card is MODIFIED（never ADDED — it was already present at card
  // start）; a pre-existing dirty path whose content vanished is DELETED. Only
  // membership-delta paths（not present at card start）classify from the
  // porcelain status（?? / A -> ADDED, D -> DELETED, else MODIFIED）.
  const contentModified = new Set(facts.contentModified ?? []);
  const added = [], modified = [], deleted = [];
  for (const p of facts.deltaPaths ?? []) {
    if (contentModified.has(p)) { modified.push(p); continue; }
    const st = statusByPath.get(p) ?? "??";
    if (st === "??" || st.startsWith("A")) added.push(p);
    else if (st.startsWith("D")) deleted.push(p);
    else modified.push(p);
  }
  added.sort(); modified.sort(); deleted.sort();
  return { added, modified, deleted };
}

/**
 * TA-2（V1）— post-FM-3 card-start baseline gate: every card declaring the
 * delta-v1 inventory contract MUST carry a machine-captured card-start
 * baseline（captureBaselineInventory at card START）. A closeout without one
 * is HOLD / CARD_START_BASELINE_MISSING（the FM-3 gate only activates with a
 * captured baseline; this makes the contract mandatory for post-FM-3 cards）.
 */
export function assertCardStartBaseline({ closeout }) {
  if (!closeout) return { ok: false, reason: "closeout_contract_missing" };
  // The delta-v1 inventory contract is the explicit post-FM-3 marker. A card
  // that declares it MUST carry a machine-captured card-start baseline
  //（captureBaselineInventory at card START）. Legacy contracts that never
  // declare the model stay non-retroactive（R5）.
  const declaresDeltaModel = closeout.inventoryModel === CARD_INVENTORY_MODEL;
  if (!declaresDeltaModel) return { ok: true };
  if (!closeout.baseline || closeout.baseline.schema !== CARD_INVENTORY_BASELINE_SCHEMA || !Array.isArray(closeout.baseline.dirtyPaths)) {
    return { ok: false, holdCode: "CARD_START_BASELINE_MISSING", reason: "CARD_START_BASELINE_MISSING: post-FM-3 closeout requires a machine-captured card-start baseline (captureBaselineInventory at card START)" };
  }
  // TA-2R content-v1: a card that opts into content-identity attribution MUST
  // carry per-path card-start content shas. A baseline that predates
  // content-identity capture cannot prove which pre-existing dirty files the
  // card modified — per the fail-closed attribution rule the closeout HOLDS
  // instead of guessing（finding 2; NEG17）.
  if (closeout.inventoryAttribution === "content-v1") {
    const hasContentIdentity = closeout.baseline
      && typeof closeout.baseline.pathShas === "object"
      && !Array.isArray(closeout.baseline.pathShas)
      && Object.keys(closeout.baseline.pathShas).length > 0
      && typeof closeout.baseline.contentDigest === "string"
      && /^[0-9a-f]{64}$/.test(closeout.baseline.contentDigest);
    if (!hasContentIdentity) {
      return { ok: false, holdCode: "BASELINE_CONTENT_IDENTITY_MISSING", reason: "BASELINE_CONTENT_IDENTITY_MISSING: content-v1 attribution requires card-start pathShas + contentDigest in the baseline snapshot (captureBaselineInventory content-v1); pre-content-identity baselines fail closed instead of guessing attribution" };
    }
  }
  return { ok: true };
}

/**
 * TA-2R（finding 3 / NEG18）— complete-bundle fail-closed template scan.
 * A rendered review bundle must NEVER contain residual template residue:
 *   - JS template-literal residue（`${...}`）— e.g. a narrative string that
 *     was authored as a JS template literal but never interpolated; and
 *   - the machine-inventory placeholders（{DELTA_PATHS_COUNT} /
 *     {BASELINE_PATHS_COUNT}）after substitution.
 * Scans the COMPLETE bundle text（not renderer internals）so a stale literal
 * anywhere on the surface fails closed.
 * @returns {{ok: boolean, matches: string[]}}
 */
export function assertNoTemplateResidue(text) {
  const matches = [];
  if (typeof text !== "string" || text.length === 0) return { ok: true, matches };
  const re = /\$\{|\{(DELTA|BASELINE|CURRENT|FINAL)_[A-Z0-9_]+\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = text.slice(0, m.index).split("\n").pop().slice(0, 120);
    matches.push(`${m[0]} @ ${line}`);
  }
  return { ok: matches.length === 0, matches };
}

/**
 * TA-2（V4）— render verifier accounting from STRUCTURED verification results
 *（never hand-written narrative）: "{total}/{total} (V1–Vn)" style claims are
 * derived from the machine test-results list so the narrative can never
 * contradict the formal accounting（NEG16; TA1_REGENERATED_SURFACE_SUMMARY_STALE
 * guard）.
 *
 * @param {Array<{suite: string, tests: number, passed: number, failed: number}>} results
 * @param {object} [opts] — { prefix = "V", key = (i) => String(i) }
 * @returns {string} e.g. "18/18 (V1-V18)" — or "0/0" when empty.
 */
export function renderVerifierAccounting(results = [], { prefix = "V" } = {}) {
  const total = results.reduce((a, r) => a + Number(r.tests ?? 0), 0);
  // accept both naming conventions（pass/fail = bundle renderer; passed/failed
  // = node --test output）.
  const passed = results.reduce((a, r) => a + Number(r.passed ?? r.pass ?? 0), 0);
  const failed = results.reduce((a, r) => a + Number(r.failed ?? r.fail ?? 0), 0);
  const keys = results.map((r) => r.key ?? r.suite).filter((k) => k && k !== "suite");
  const range = keys.length ? `${prefix}1-${prefix}${keys.length}` : "";
  return `${passed}/${total}${range ? ` (${range})` : ""}${failed ? ` failed:${failed}` : ""}`;
}

/**
 * TA-2（V4）— machine-verify that a narrative accounting claim matches the
 * structured results（fail-closed on mismatch）.
 */
export function assertAccountingMatches(results, narrative) {
  const total = results.reduce((a, r) => a + Number(r.tests ?? 0), 0);
  const passed = results.reduce((a, r) => a + Number(r.passed ?? 0), 0);
  const m = String(narrative ?? "").match(/(\d+)\/(\d+)/);
  if (!m) return { ok: false, reason: "no X/Y accounting claim found" };
  if (Number(m[1]) !== passed || Number(m[2]) !== total) {
    return { ok: false, reason: `accounting mismatch: narrative ${m[1]}/${m[2]} != structured ${passed}/${total}` };
  }
  return { ok: true };
}

/**
 * Evidence manifest digest.
 */

export function evidenceManifestDigest(evidence) {
  const items = (evidence || []).map((e) => ({ path: e.path, sha256: e.sha256 }));
  return sha256Hex(recursiveCanonicalJson(items.sort((a, b) => a.path.localeCompare(b.path))));
}

function fileSha256(path) {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Bundle identity（excludes the bundle's own hash — no circularity）.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// VCA-1 W1A (S9) — one authoritative review bundle per generation.
// ---------------------------------------------------------------------------
//
// The R1/R2 audit found cards carrying 4-5 full 25-section bundles for ONE
// generation（ta1: 5, ta2: 4, ta2r: 4 — each re-rendered / re-validated）.
// The rule enforced here:
//   - a card + generation key（cardId + the bundle identity it SUPERSEDES）
//     holds at most ONE authoritative bundle;
//   - a same-generation re-closeout is IDEMPOTENT（alreadyApplied — never
//     renders a second authoritative bundle）;
//   - repair / supersede generations（a different supersedes target）are the
//     explicit exception and produce a new authoritative bundle;
//   - `regenerateAuthoritative: true` on the closeout contract retires the
//     same-generation bundle to .superseded/ and renders a fresh one.

/**
 * Generation key parsed from a rendered bundle's text: cardId +
 * GENERATION_TYPE + the SUPERSEDES_BUNDLE_IDENTITY target.
 */
export function generationKeyFromBundleText(text) {
  const src = String(text ?? "");
  const cardId = src.match(/^CARD_ID:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const identity = src.match(/^REVIEW_BUNDLE_IDENTITY:\s*([0-9a-f]{64})$/m)?.[1] ?? null;
  const supersededIdentity = src.match(/^SUPERSEDES_BUNDLE_IDENTITY:\s*([0-9a-f]{64})$/m)?.[1] ?? null;
  const lineage = parseRepairLineage(src);
  return {
    cardId,
    identity,
    supersededIdentity,
    generationType: lineage.generationType ?? "implementation",
    fileName: null,
    path: null,
  };
}

/**
 * Scan an outDir for existing authoritative bundles, parsing each one's
 * generation key. Optional cardId filter（never classify other cards' dirs）.
 * Returns array of { cardId, identity, supersededIdentity, generationType,
 * fileName, path }.
 */
export function scanAuthoritativeBundles(outDir, { cardId = null } = {}) {
  if (!outDir || !existsSync(outDir)) return [];
  const out = [];
  for (const f of readdirSync(outDir).sort()) {
    if (!f.startsWith("card-closeout-bundle-") || !f.endsWith(".txt")) continue;
    if (f.includes(".superseded.")) continue;
    const p = join(outDir, f);
    let key;
    try {
      key = generationKeyFromBundleText(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (cardId !== null && key.cardId !== null && key.cardId !== cardId) continue;
    out.push({ ...key, fileName: f, path: p });
  }
  return out;
}

/**
 * Decide whether a new closeout may render a bundle.
 *
 * @param {object} opts — { outDir, cardId, supersedes, allowRegenerate }
 *   supersedes = the closeout's supersede target（null for a first
 *   generation）; allowRegenerate = explicit same-generation re-render.
 * @returns { ok, existing, sameGeneration, retire }
 *   ok:false + sameGeneration>0 -> idempotent（already authoritative）;
 *   ok:true + retire:[] -> new generation, may render;
 *   ok:true + retire:[...] -> same-generation re-render: retire first.
 */
export function assertAuthoritativeBundle({ outDir, cardId, supersedes = null, allowRegenerate = false } = {}) {
  const existing = scanAuthoritativeBundles(outDir, { cardId: cardId ?? null });
  const incomingSupersede = supersedes?.reviewBundleIdentity ?? null;
  const sameGeneration = existing.filter((b) => (b.supersededIdentity ?? null) === incomingSupersede);
  if (sameGeneration.length > 0 && !allowRegenerate) {
    return {
      ok: false,
      holdCode: BUNDLE_AUTHORITY_HOLDS.ALREADY_AUTHORITATIVE,
      reason: `${BUNDLE_AUTHORITY_HOLDS.ALREADY_AUTHORITATIVE}:same_generation_authoritative_bundle_exists:${sameGeneration[0].fileName}`,
      existing,
      sameGeneration,
      retire: [],
    };
  }
  return { ok: true, existing, sameGeneration, retire: allowRegenerate ? sameGeneration : [] };
}

/**
 * Move superseded same-generation bundles out of the authoritative outDir
 * root into <outDir>/.superseded/（content preserved; no longer scanned as
 * authoritative）. Returns the list of retired file names.
 */
export function retireAuthoritativeBundles(outDir, bundles = []) {
  const retired = [];
  for (const b of bundles) {
    if (!b?.path || !existsSync(b.path)) continue;
    const archiveDir = join(outDir, ".superseded");
    mkdirSync(archiveDir, { recursive: true });
    const target = join(archiveDir, b.fileName);
    renameSync(b.path, target);
    retired.push(b.fileName);
  }
  return retired;
}

export function reviewBundleIdentity(input) {
  const payload = {
    reviewBundleSchema: REVIEW_BUNDLE_SCHEMA,
    taskIdentity: { cardId: input.cardId, cardTitle: input.cardTitle, cardType: input.cardType },
    repoIdentity: { repository: input.repository ?? null, branch: input.branch ?? null },
    head: input.head,
    treeSha: input.treeSha,
    graphRunId: input.graphRunId ?? null,
    finalReviewResultIdentity: input.finalReviewResultIdentity ?? null,
    evidenceManifestDigest: input.evidenceManifestDigest ?? null,
    // RB-1G: a repair generation binds the superseded bundle so the new
    // bundle gets a NEW identity（never reuses the old bundle's identity or
    // file name — old artifact is retained, not overwritten）.
    supersedes: input.supersedes
      ? {
          reviewBundleIdentity: input.supersedes.reviewBundleIdentity ?? null,
          reviewBundleSha256: input.supersedes.reviewBundleSha256 ?? null,
        }
      : null,
  };
  return sha256Hex(recursiveCanonicalJson(payload));
}

// ---------------------------------------------------------------------------
// Section rendering.
// ---------------------------------------------------------------------------

const rule = "================================================================================\n";
const section = (n, title, body) =>
  `${rule}${n}. ${title}\n${rule}${body === undefined || body === null || body === "" ? "NOT_APPLICABLE" : String(body)}\n\n`;

const lines = (items, prefix = "  - ") => (Array.isArray(items) && items.length ? items.map((i) => `${prefix}${i}`).join("\n") : "  (none)");

function renderStatusLine(name, value) {
  return `${name}: ${value === undefined || value === null || value === "" ? "NOT_APPLICABLE" : String(value)}\n`;
}

function renderSource(source) {
  const repo = source.repo || {};
  const integrity = source.repoIntegrity || {};
  const exec = source.execution || {};
  const review = source.review || {};
  const s = [];

  s.push(section(1, "Review Request",
    `CARD_ID: ${source.task?.cardId ?? ""}\nCARD_TITLE: ${source.task?.cardTitle ?? ""}\nCARD_TYPE: ${source.task?.cardType ?? ""}\n` +
    `GRAPH_RUN_ID: ${source.graph?.graphRunId ?? "NOT_APPLICABLE"}\n` +
    `NODE_ID: ${source.graph?.nodeId ?? "NOT_APPLICABLE"}\n` +
    `PHASE_EXECUTION_ID: ${source.graph?.phaseExecutionId ?? "NOT_APPLICABLE"}\n` +
    `STAGE_IDS: ${Array.isArray(source.graph?.stageIds) && source.graph.stageIds.length ? source.graph.stageIds.join(", ") : "NOT_APPLICABLE"}\n` +
    `AGENT_EXECUTION_IDS: ${Array.isArray(source.graph?.agentExecutionIds) && source.graph.agentExecutionIds.length ? source.graph.agentExecutionIds.join(", ") : "NOT_APPLICABLE"}\n` +
    `REQUESTED_REVIEW_VERDICT: PASS / REPAIR / HOLD\n` +
    `This bundle is the single complete text artifact submitted for external review of card ${source.task?.cardId ?? ""}.`));

  // TA-2（U）: the admission decision that governed this graph — recorded in
  // the bundle（self-contained, no chat dependence）. Unadmitted graphs
  // render NOT_APPLICABLE.
  if (source.admission && source.admission.admission_id) {
    const a = source.admission;
    const capLine = (k) => Array.isArray(a.capabilities?.[k]) && a.capabilities[k].length
      ? `ADMISSION_CAPABILITIES_${k.toUpperCase()}: ${a.capabilities[k].join(", ")}\n`
      : `ADMISSION_CAPABILITIES_${k.toUpperCase()}: (none)\n`;
    s.push(section(1.5, "Admission Decision",
      renderStatusLine("ADMISSION_SCHEMA", a.schema) +
      renderStatusLine("ADMISSION_TASK_ID", a.task_id) +
      renderStatusLine("ADMISSION_ID", a.admission_id) +
      renderStatusLine("ADMISSION_SIZE", a.size) +
      renderStatusLine("ADMISSION_RISK", a.risk) +
      renderStatusLine("ADMISSION_PROFILE", a.profile) +
      renderStatusLine("ADMISSION_REPAIR_BUDGET", a.repair_budget) +
      renderStatusLine("ADMISSION_EVIDENCE_POLICY", a.evidence_policy) +
      renderStatusLine("ADMISSION_EXTERNAL_REVIEW_REQUIRED", a.external_review_required) +
      capLine("required") + capLine("allowed") + capLine("denied") +
      `ADMISSION_REASONS:\n${lines(a.reasons ?? [], "  - ")}\n`));
  }

  s.push(section(2, "Executive Status",
    renderStatusLine("EXECUTIVE_STATUS", source.executiveStatus) +
    renderStatusLine("EXECUTION_PASS", exec.pass ?? "NOT_APPLICABLE") +
    renderStatusLine("VERIFIER_PASS", source.verifier?.pass ?? "NOT_APPLICABLE") +
    renderStatusLine("INDEPENDENT_REVIEW_PASS", review.pass ?? "NOT_APPLICABLE") +
    renderStatusLine("REVIEW_BUNDLE_READY", source.bundleReady ?? "NOT_APPLICABLE") +
    renderStatusLine("REVIEW_BUNDLE_DELIVERY_REQUIRED", source.externalReview?.deliveryRequired ?? "NOT_APPLICABLE") +
    renderStatusLine("EXTERNAL_REVIEW_STATUS", source.externalReview?.status ?? "NOT_APPLICABLE") +
    renderStatusLine("SUMMARY", source.executiveSummary ?? "NOT_APPLICABLE")));

  s.push(section(3, "Task Identity",
    renderStatusLine("CARD_ID", source.task?.cardId) +
    renderStatusLine("CARD_TITLE", source.task?.cardTitle) +
    renderStatusLine("CARD_TYPE", source.task?.cardType) +
    renderStatusLine("GRAPH_RUN_ID", source.graph?.graphRunId) +
    renderStatusLine("NODE_ID", source.graph?.nodeId) +
    renderStatusLine("PHASE_EXECUTION_ID", source.graph?.phaseExecutionId) +
    renderStatusLine("STAGE_IDS", Array.isArray(source.graph?.stageIds) && source.graph.stageIds.length ? source.graph.stageIds.join(", ") : null) +
    renderStatusLine("AGENT_EXECUTION_IDS", Array.isArray(source.graph?.agentExecutionIds) && source.graph.agentExecutionIds.length ? source.graph.agentExecutionIds.join(", ") : null)));

  s.push(section(4, "Repository and Worktree Identity",
    renderStatusLine("REPOSITORY", repo.repository) +
    renderStatusLine("BRANCH", repo.branch) +
    renderStatusLine("HEAD", repo.head) +
    renderStatusLine("TREE_SHA", repo.treeSha) +
    renderStatusLine("WORKTREE_PATH", repo.worktreePath) +
    renderStatusLine("BASELINE_DIRTY_DIGEST", repo.baselineDirtyDigest) +
    renderStatusLine("FINAL_DIRTY_DIGEST", repo.finalDirtyDigest) +
    renderStatusLine("REMOTE", repo.remote)));

  s.push(section(5, "Objective", source.objective ?? "NOT_APPLICABLE"));

  // TA-3: budget enforcement evidence（admission-derived envelope + ledger +
  // state + reconciliation）. Rendered only when the graph result carried the
  // structured budget section（production enforced runs）.
  const b = source.budget;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    const dimLines = Object.entries(b.dimensions ?? {}).map(([d, v]) =>
      `  - ${d}: limit=${v?.limit ?? "unlimited"} ${v?.unit ?? ""} consumed=${v?.consumed ?? 0} reserved=${v?.reserved ?? 0} remaining=${v?.remaining ?? "-"}${v?.approaching ? " (approaching)" : ""}`);
    s.push(section(5.5, "Budget Enforcement",
      renderStatusLine("BUDGET_ENFORCEMENT_SCHEMA", "autoloop.budget-enforcement-result/v1") +
      renderStatusLine("BUDGET_AUTHORIZED", b.authorized === true ? "true" : "false") +
      renderStatusLine("BUDGET_SURFACE", b.surface ?? "compat") +
      renderStatusLine("BUDGET_ADMISSION_ID", b.admissionId ?? null) +
      renderStatusLine("BUDGET_ENVELOPE_ID", b.envelopeId ?? null) +
      renderStatusLine("BUDGET_ENVELOPE_SOURCE", b.envelopeSource ?? null) +
      renderStatusLine("BUDGET_STATE", b.state ?? null) +
      renderStatusLine("BUDGET_APPROACHING_RATIO", b.approachingRatio ?? null) +
      renderStatusLine("BUDGET_CLOSEOUT_AUTHORIZED", b.closeoutAuthorized === true ? "true" : "false") +
      renderStatusLine("BUDGET_RECONCILIATION_DIVERGED", Array.isArray(b.reconciliation?.diverged) && b.reconciliation.diverged.length ? b.reconciliation.diverged.join("; ") : "none") +
      "BUDGET_DIMENSIONS:\n" + (dimLines.length ? dimLines.join("\n") : "  (none)") + "\n" +
      "BUDGET_ENFORCEMENT_SECTIONS:\n" + lines(Array.isArray(b.enforcementSections) ? b.enforcementSections : [], "  - ") + "\n"));
  }

  s.push(section(6, "Authorized Scope",
    lines(source.authorizedScope, "  - ") + "\n" +
    renderStatusLine("AUTHORIZED_PATHS", Array.isArray(source.authorizedScope) && source.authorizedScope.length ? source.authorizedScope.join(", ") : null)));

  s.push(section(7, "Explicitly Unauthorized Scope",
    lines(source.unauthorizedScope, "  - ") + "\n" +
    renderStatusLine("UNAUTHORIZED_PATHS", Array.isArray(source.unauthorizedScope) && source.unauthorizedScope.length ? source.unauthorizedScope.join(", ") : null)));

  s.push(section(8, "Architecture and Design Decisions", lines(source.designDecisions, "  - ")));

  const files = source.files || {};
  // RB-1H/CBM-2R: card-level changed-file inventory. When the closeout
  // supplies categorized lists（CARD_IMPLEMENTATION_FILES / GRAPH_CLOSEOUT_
  // OUTPUTS / PRE_EXISTING_DIRTY_FILES）they render EXPLICITLY — the reviewer
  // can see what the card actually implemented instead of a single
  // closeout-output entry or the whole worktree dirty list.
  const inv = [];
  // FM-3: when the inventory model is active the three categories ALWAYS
  // render（empty categories show `(none)`）so the reviewer can confirm each
  // category is explicit and disjoint（R4）.
  const invActive = !!(source.inventory && source.inventory.model === CARD_INVENTORY_MODEL);
  if (invActive || (Array.isArray(files.cardImplementation) && files.cardImplementation.length)) {
    inv.push("CARD_IMPLEMENTATION_FILES:\n" + lines(files.cardImplementation, "    - "));
  }
  if (invActive || (Array.isArray(files.closeoutOutputs) && files.closeoutOutputs.length)) {
    inv.push("GRAPH_CLOSEOUT_OUTPUTS:\n" + lines(files.closeoutOutputs, "    - "));
  }
  if (invActive || (Array.isArray(files.preExistingDirty) && files.preExistingDirty.length)) {
    inv.push("PRE_EXISTING_DIRTY_FILES:\n" + lines(files.preExistingDirty, "    - "));
  }
  // FM-3 inventory consistency model（delta-v1）: the machine-captured
  // baseline snapshot + derived current-card delta render EXPLICITLY so the
  // validator（and the external reviewer）can deterministically cross-check
  // authorized / actually-touched / CARD_IMPLEMENTATION_FILES. Rendered only
  // when the closeout contract carried a captured baseline（historical
  // bundles never contain this block — R5 non-retroactive）.
  const inventoryBlock = [];
  const invModel = source.inventory;
  if (invModel && invModel.model === CARD_INVENTORY_MODEL) {
    const bl = invModel.baseline && typeof invModel.baseline === "object" && !Array.isArray(invModel.baseline) ? invModel.baseline : {};
    inventoryBlock.push(`CARD_INVENTORY_MODEL: ${invModel.model}`);
    inventoryBlock.push(`ATTRIBUTION_MODEL: ${invModel.attribution ?? "membership-v1"}`);
    inventoryBlock.push(`BASELINE_HEAD: ${bl.head ?? "NOT_APPLICABLE"}`);
    inventoryBlock.push(`BASELINE_DIRTY_DIGEST: ${bl.dirtyDigest ?? "NOT_APPLICABLE"}`);
    if (bl.contentDigest) inventoryBlock.push(`BASELINE_CONTENT_DIGEST: ${bl.contentDigest}`);
    inventoryBlock.push("BASELINE_DIRTY_PATHS:\n" + lines(Array.isArray(bl.dirtyPaths) ? bl.dirtyPaths : [], "    - "));
    inventoryBlock.push("CURRENT_CARD_DELTA_PATHS:\n" + lines(Array.isArray(invModel.deltaPaths) ? invModel.deltaPaths : [], "    - "));
    // TA-2R（content-v1）: per-path attribution proof — the rendered kind + the
    // card-start->closeout content shas for pre-existing dirty files the card
    // modified（machine proof; NEG14/TA2_DELTA_ATTRIBUTION; finding 2）.
    if (Array.isArray(invModel.deltaKinds) && invModel.deltaKinds.length) {
      inventoryBlock.push("DELTA_ATTRIBUTION:\n" + invModel.deltaKinds
        .map((k) => {
          const base = `    - ${k.kind} ${k.path}`;
          if (k.kind === "MODIFIED" && k.baselineSha && k.finalSha) {
            return `${base} (content: ${String(k.baselineSha).slice(0, 12)}... -> ${String(k.finalSha).slice(0, 12)}...)`;
          }
          if (k.kind === "DELETED" && k.baselineSha) {
            return `${base} (content: ${String(k.baselineSha).slice(0, 12)}... -> deleted)`;
          }
          return base;
        })
        .join("\n"));
    }
    if (Array.isArray(source.authorizationExceptions) && source.authorizationExceptions.length) {
      inventoryBlock.push("AUTHORIZATION_EXCEPTIONS:\n" + source.authorizationExceptions
        .map((e) => `    - ${e?.path ?? ""} :: ${e?.reason ?? "authorized by card scope"}`)
        .join("\n"));
    }
  }
  s.push(section(9, "Files Added / Modified / Deleted",
    (inv.length ? inv.join("\n") + "\n" : "") +
    (inventoryBlock.length ? inventoryBlock.join("\n") + "\n" : "") +
    "ADDED:\n" + lines(files.added, "    - ") + "\n" +
    "MODIFIED:\n" + lines(files.modified, "    - ") + "\n" +
    "DELETED:\n" + lines(files.deleted, "    - ")));

  s.push(section(10, "Diff Summary", source.diffSummary ?? "NOT_APPLICABLE"));

  s.push(section(11, "Execution Results",
    // TA-2R: section 11 counts GRAPH NODES（execution surface）, never the
    // regression suites（section 16）. Two conflicting TESTS_* surfaces were
    // the external finding 3 root cause（§11 TESTS_TOTAL: 0 vs §16 849）— the
    // node surface now renders NODES_*（and, only when a graph node embeds
    // real sub-agent test results, a separate EMBEDDED_TESTS_* block）.
    "NODES_EXECUTED:\n" + lines(exec.nodesExecuted ?? exec.testsExecuted, "    - ") + "\n" +
    renderStatusLine("NODES_PASSED", exec.nodeResults?.passed) +
    renderStatusLine("NODES_FAILED", exec.nodeResults?.failed) +
    renderStatusLine("NODES_TOTAL", exec.nodeResults?.total) +
    (exec.embeddedTestResults?.total
      ? renderStatusLine("EMBEDDED_TESTS_TOTAL", exec.embeddedTestResults.total) +
        renderStatusLine("EMBEDDED_TESTS_PASSED", exec.embeddedTestResults.passed) +
        renderStatusLine("EMBEDDED_TESTS_FAILED", exec.embeddedTestResults.failed)
      : "") +
    renderStatusLine("EXECUTION_PASS", exec.pass)));

  s.push(section(12, "Verification Results",
    renderStatusLine("VERIFIER_PASS", source.verifier?.pass) +
    renderStatusLine("VERIFIER_RESULT", source.verifier?.result) +
    renderStatusLine("VERIFIER_SUMMARY", source.verifier?.summary)));

  s.push(section(13, "Independent Review Results",
    renderStatusLine("REVIEW_PASS", review.pass) +
    renderStatusLine("REVIEW_RESULT", review.result) +
    renderStatusLine("REVIEW_RESULT_IDENTITY", review.reviewResultIdentity) +
    renderStatusLine("BLOCKING_FINDINGS", Array.isArray(review.blockingFindings) && review.blockingFindings.length ? review.blockingFindings.join(" | ") : "[]") +
    renderStatusLine("REVIEW_SUMMARY", review.summary)));

  s.push(section(14, "Repair Attempts",
    (Array.isArray(source.repairAttempts) && source.repairAttempts.length
      ? source.repairAttempts.map((a) => `  - attempt=${a.attempt} taskType=${a.taskType ?? "NOT_APPLICABLE"} status=${a.status ?? "NOT_APPLICABLE"} resultIdentity=${a.resultIdentity ?? "NOT_APPLICABLE"}`).join("\n")
      : "  NOT_APPLICABLE (no repair attempts)") + "\n" +
    renderStatusLine("REPAIR_BUDGET_MAX", source.repairBudget?.maxAttempts) +
    renderStatusLine("REPAIR_BUDGET_USED", source.repairBudget?.used) +
    renderStatusLine("GENERATION_TYPE", source.repairLineage?.generationType) +
    renderStatusLine("REPAIR_LINEAGE_REPAIR_ITERATIONS", source.repairLineage?.repairIterations) +
    renderStatusLine("REPAIR_LINEAGE_SURFACE_RESEALS", source.repairLineage?.surfaceReseals) +
    (Array.isArray(source.repairLineage?.resealTouchedPaths) && source.repairLineage.resealTouchedPaths.length
      ? `RESEAL_TOUCHED_PATHS:\n${lines(source.repairLineage.resealTouchedPaths, "    - ")}\n`
      : "") +
    renderStatusLine("SUPERSEDES_BUNDLE_IDENTITY", source.externalReview?.supersedes?.reviewBundleIdentity) +
    renderStatusLine("SUPERSEDES_BUNDLE_SHA256", source.externalReview?.supersedes?.reviewBundleSha256) +
    renderStatusLine("SUPERSEDES_BUNDLE_PATH", source.externalReview?.supersedes?.bundlePath) +
    renderStatusLine("SUPERSEDES_BUNDLE_VERDICT", source.externalReview?.supersedes?.verdict)));

  s.push(section(15, "Negative and Fail-Closed Cases", lines(source.negativeCases, "  - ")));

  s.push(section(16, "Regression Results",
    (Array.isArray(source.regression) && source.regression.length
      ? source.regression.map((r) => `  - suite=${r.suite} tests=${r.tests} pass=${r.pass} fail=${r.fail}`).join("\n")
      : "  (none)") + "\n" +
    renderStatusLine("REGRESSION_OVERALL", source.regressionSummary)));

  s.push(section(17, "Evidence Inventory",
    (Array.isArray(source.evidence) && source.evidence.length
      ? source.evidence.map((e) => `  - ${e.path}`).join("\n")
      : "  (none)") + "\n" +
    renderStatusLine("EVIDENCE_MANIFEST_DIGEST", source.evidenceManifestDigest)));

  s.push(section(18, "Evidence Hashes",
    (Array.isArray(source.evidence) && source.evidence.length
      ? source.evidence.map((e) => `  - ${e.path}\n      sha256=${e.sha256}`).join("\n")
      : "  (none)")));

  s.push(section(19, "Security and Secret Scan",
    renderStatusLine("SECRET_SCAN_RESULT", source.security?.secretScanResult) +
    renderStatusLine("SECRET_SCAN_NOTES", source.security?.notes) +
    "SECRET_DETECTED: false\n" +
    "INGESTION_ALLOWLIST: " + (Array.isArray(source.security?.ingestionAllowlist) ? source.security.ingestionAllowlist.join(", ") : "NOT_APPLICABLE") + "\n" +
    "INGESTION_DENYLIST: " + (Array.isArray(source.security?.ingestionDenylist) ? source.security.ingestionDenylist.join(", ") : "NOT_APPLICABLE")));

  s.push(section(20, "Repository Integrity",
    renderStatusLine("HEAD", integrity.head) +
    renderStatusLine("TREE_SHA", integrity.treeSha) +
    renderStatusLine("WORKTREE_CLEAN", integrity.worktreeClean) +
    renderStatusLine("DIRTY_PATHS", Array.isArray(integrity.dirtyPaths) && integrity.dirtyPaths.length ? integrity.dirtyPaths.join(", ") : "[]") +
    renderStatusLine("UNTRACKED_FILES", Array.isArray(integrity.untrackedFiles) && integrity.untrackedFiles.length ? integrity.untrackedFiles.join(", ") : "[]") +
    renderStatusLine("REMOTE", integrity.remote)));

  s.push(section(21, "Known Risks and Limitations", lines(source.risks, "  - ") + "\n" + lines(source.limitations, "  - ")));

  s.push(section(22, "Rollback Procedure", source.rollbackProcedure ?? "NOT_APPLICABLE"));

  s.push(section(23, "Open Questions", lines(source.openQuestions, "  - ")));

  s.push(section(24, "Recommended Next Step", source.recommendedNextStep ?? "NOT_APPLICABLE"));

  s.push(section(25, "External Reviewer Verdict Template",
    "VERDICT: PASS / REPAIR / HOLD\n" +
    "REVIEWER_IDENTITY: <reviewer>\n" +
    "REVIEWED_AT: <date>\n" +
    "FINDINGS_DIGEST: <sha256>\n" +
    "NEXT_ACTION_IF_PASS: <next card>\n" +
    "NEXT_ACTION_IF_REPAIR: <bounded repair within budget>\n" +
    "NEXT_ACTION_IF_HOLD: <stop downstream>\n"));

  // Research-card extension（kept as part of section 17/18? no — separate block
  // appended to Evidence + a dedicated research note in Executive Status）:
  if (source.research) {
    s.push("RESEARCH_ARTIFACTS:\n" + [
      `SOURCE_MARKERS: ${source.research.sourceMarkers ?? "NOT_APPLICABLE"}`,
      `PROBE_SOURCE: ${source.research.probe?.sourcePath ?? "NOT_APPLICABLE"}`,
      `PROBE_COMMAND: ${source.research.probe?.command ?? "NOT_APPLICABLE"}`,
      `PROBE_RESULT: ${source.research.probe?.resultPath ?? "NOT_APPLICABLE"}`,
      `PROBE_SUMMARY: ${source.research.probe?.summary ?? "NOT_APPLICABLE"}`,
      `PROBE_CLEANUP: ${source.research.probe?.cleanupNote ?? "NOT_APPLICABLE"}`,
    ].join("\n") + "\n");
  }
  return s.join("");
}

// ---------------------------------------------------------------------------
// Generator: structured source -> complete 25-section UTF-8 text bundle.
// ---------------------------------------------------------------------------

function validateSource(source) {
  const errors = [];
  if (!source || typeof source !== "object" || Array.isArray(source)) errors.push("source_not_object");
  if (source.schema !== REVIEW_BUNDLE_SOURCE_SCHEMA) errors.push(`schema_mismatch:${source?.schema}`);
  if (!source.task?.cardId) errors.push("task.cardId_required");
  if (!source.task?.cardTitle) errors.push("task.cardTitle_required");
  if (!CARD_TYPES.includes(source.task?.cardType)) errors.push(`task.cardType_invalid:${source.task?.cardType}`);
  if (!EXECUTIVE_STATUSES.includes(source.executiveStatus)) errors.push(`executiveStatus_invalid:${source.executiveStatus}`);
  if (!source.repo?.head || !source.repo?.treeSha) errors.push("repo.head_tree_required");
  if (!source.objective) errors.push("objective_required");
  return errors;
}

function renderHeader({ identity, sha256, source, generatedAt }) {
  const t = source.task;
  // NOTE: REVIEW_BUNDLE_SHA256 is deliberately NOT here. The bundle's own
  // hash is appended as the FINAL footer line（sha256 over everything above
  // it）, so the validator can recompute it without circularity.
  return (
    `${rule}AUTOLOOP REVIEW BUNDLE (CLOSEOUT)\n${rule}` +
    `REVIEW_BUNDLE_SCHEMA: ${REVIEW_BUNDLE_SCHEMA}\n` +
    `REVIEW_BUNDLE_IDENTITY: ${identity}\n` +
    `CARD_ID: ${t.cardId}\nCARD_TITLE: ${t.cardTitle}\nCARD_TYPE: ${t.cardType}\n` +
    `GENERATED_AT: ${generatedAt}\n\n`
  );
}

export function renderReviewBundle(source, { generatedAt = new Date().toISOString() } = {}) {
  const errs = validateSource(source);
  if (errs.length) throw new Error(`review_bundle_source_invalid: ${errs.join(";")}`);

  // evidence manifest digest computed from the inventory（never trusted input）
  const evidence = (source.evidence || []).map((e) => ({ path: e.path, sha256: e.sha256 }));
  const manifestDigest = evidenceManifestDigest(evidence);
  const bodySource = { ...source, evidenceManifestDigest: manifestDigest };

  const identity = reviewBundleIdentity({
    cardId: source.task.cardId,
    cardTitle: source.task.cardTitle,
    cardType: source.task.cardType,
    repository: source.repo.repository ?? null,
    branch: source.repo.branch ?? null,
    head: source.repo.head,
    treeSha: source.repo.treeSha,
    graphRunId: source.graph?.graphRunId ?? null,
    finalReviewResultIdentity: source.review?.reviewResultIdentity ?? null,
    evidenceManifestDigest: manifestDigest,
    supersedes: source.externalReview?.supersedes ?? null,
  });

  // sha256 is computed over the FULL content WITHOUT the footer sha line
  //（terminator included）; the footer line is then appended. Recomputable.
  //
  // TA-2（V3）: narrative counts are DERIVED — the renderer substitutes
  // {DELTA_PATHS_COUNT} / {BASELINE_PATHS_COUNT} placeholders in the narrative
  // with the machine inventory values at render time（no hardcoded counts that
  // can go stale when the bundle itself is a new generated file — NEG15）。
  const inventory = source.inventory ?? null;
  const deltaCount = String(inventory?.deltaPaths?.length ?? 0);
  const baselineCount = String(inventory?.baseline?.dirtyPaths?.length ?? 0);
  const substitute = (v) => (typeof v === "string"
    ? v.replaceAll("{DELTA_PATHS_COUNT}", deltaCount).replaceAll("{BASELINE_PATHS_COUNT}", baselineCount)
    : v);
  const bodySource2 = { ...bodySource };
  for (const field of ["objective", "executiveSummary", "designDecisions", "negativeCases", "risks", "limitations", "openQuestions", "recommendedNextStep", "regressionSummary", "rollbackProcedure"]) {
    if (typeof bodySource2[field] === "string") bodySource2[field] = substitute(bodySource2[field]);
    else if (Array.isArray(bodySource2[field])) bodySource2[field] = bodySource2[field].map(substitute);
  }

  const content = renderHeader({ identity, sha256: null, source, generatedAt }) + renderSource(bodySource2) + `${REVIEW_BUNDLE_TERMINATOR}\n`;
  // TA-2R（finding 3 / NEG18）: complete-bundle fail-closed template scan — a
  // residual `${...}` / placeholder literal makes the bundle INVALID before it
  // is ever written（the closeout gate re-runs the scan on the written file
  // and the independent validator also fails the artifact）.
  const residue = assertNoTemplateResidue(content);
  if (!residue.ok) {
    throw new Error(`review_bundle_template_residue: ${residue.matches.slice(0, 5).join(" | ")}`);
  }
  const sha256 = sha256Hex(content);
  const full = content + `REVIEW_BUNDLE_SHA256: ${sha256}\n`;
  return { text: full, identity, sha256, evidenceManifestDigest: manifestDigest, generatedAt };
}

export function writeReviewBundle(bundle, outDir, { fileName } = {}) {
  if (!fileName) {
    const d = bundle.generatedAt.slice(0, 10).replace(/-/g, "");
    fileName = `card-closeout-bundle-${d}-${bundle.identity.slice(0, 8)}.txt`;
  }
  const target = resolve(outDir, fileName);
  // path containment（no escape; symlink-free target dir）
  const root = resolve(outDir);
  if (target !== root && !target.startsWith(root + "/")) {
    throw new Error(`review_bundle_path_escape: ${target}`);
  }
  mkdirSync(outDir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bundle.text, "utf8");
  // atomic rename after full write
  renameSync(tmp, target);
  return { path: target, fileName };
}

// ---------------------------------------------------------------------------
// Validator（independent; run by Controller/closeout layer — never only by
// the writer）. Returns { ok, errors, holdCode }.
// ---------------------------------------------------------------------------

export function validateReviewBundle(bundlePath, {
  authorizedDir = null,
  expected = {},
} = {}) {
  const errors = [];
  const fail = (code, err) => errors.push(`${code}:${err}`);

  // existence / type / symlink / authorized dir
  if (!bundlePath) return { ok: false, errors: [`${REVIEW_BUNDLE_HOLDS.MISSING}:bundle_path_absent`], holdCode: REVIEW_BUNDLE_HOLDS.MISSING };
  if (!existsSync(bundlePath)) return { ok: false, errors: [`${REVIEW_BUNDLE_HOLDS.MISSING}:file_not_found`], holdCode: REVIEW_BUNDLE_HOLDS.MISSING };
  let st;
  try {
    st = lstatSync(bundlePath);
  } catch {
    return { ok: false, errors: [`${REVIEW_BUNDLE_HOLDS.MISSING}:cannot_stat`], holdCode: REVIEW_BUNDLE_HOLDS.MISSING };
  }
  if (st.isSymbolicLink()) fail(REVIEW_BUNDLE_HOLDS.INVALID, "symlink_output");
  if (!st.isFile()) fail(REVIEW_BUNDLE_HOLDS.INVALID, "not_regular_file");
  if (authorizedDir) {
    const root = resolve(authorizedDir);
    const target = resolve(bundlePath);
    if (target !== root && !target.startsWith(root + "/")) fail(REVIEW_BUNDLE_HOLDS.MISSING, "path_outside_authorized_dir");
  }
  if (errors.length) return { ok: false, errors, holdCode: REVIEW_BUNDLE_HOLDS.INVALID };

  const raw = readFileSync(bundlePath, "utf8");
  if (raw.length === 0) return { ok: false, errors: [`${REVIEW_BUNDLE_HOLDS.INVALID}:empty_file`], holdCode: REVIEW_BUNDLE_HOLDS.INVALID };
  // malformed encoding（UTF-8 replacement char）
  if (raw.includes("\uFFFD")) fail(REVIEW_BUNDLE_HOLDS.INVALID, "malformed_encoding");

  const linesArr = raw.split("\n");
  const text = raw;

  // schema
  const schemaLine = linesArr.find((l) => l.startsWith("REVIEW_BUNDLE_SCHEMA:"));
  if (!schemaLine || !schemaLine.includes(REVIEW_BUNDLE_SCHEMA)) fail(REVIEW_BUNDLE_HOLDS.INVALID, "schema_version_missing_or_wrong");
  // all required sections present（in order）
  let idx = 0;
  for (const sec of REVIEW_BUNDLE_SECTIONS) {
    const re = new RegExp(`^\\d+\\. ${sec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
    const m = text.match(re);
    if (!m) fail(REVIEW_BUNDLE_HOLDS.INVALID, `section_missing:${sec}`);
    else {
      const pos = text.indexOf(m[0]);
      if (pos < idx) fail(REVIEW_BUNDLE_HOLDS.INVALID, `section_out_of_order:${sec}`);
      idx = pos;
    }
  }
  // sha256 recompute（footer line = last non-empty line; recompute over the
  // content above it — no circularity）
  const shaLineIdx = [...linesArr].reverse().findIndex((l) => l.trim().startsWith("REVIEW_BUNDLE_SHA256:"));
  const statedSha = shaLineIdx >= 0 ? linesArr[linesArr.length - 1 - shaLineIdx].split(":")[1]?.trim() : null;
  const contentOnly = shaLineIdx >= 0
    ? linesArr.slice(0, linesArr.length - 1 - shaLineIdx).join("\n") + "\n"
    : text;
  const actualSha = sha256Hex(contentOnly);
  if (!statedSha || statedSha !== actualSha) fail(REVIEW_BUNDLE_HOLDS.INVALID, "bundle_sha256_mismatch");

  // terminator（truncation）— the terminator must close the CONTENT（before
  // the footer sha line）; anything after it other than the sha line is truncation
  if (!contentOnly.trimEnd().endsWith(REVIEW_BUNDLE_TERMINATOR)) fail(REVIEW_BUNDLE_HOLDS.INVALID, "truncated_missing_terminator");

  // identity fields
  const line = (prefix) => linesArr.find((l) => l.startsWith(prefix + ":"))?.slice(prefix.length + 1).trim();
  const identityLine = line("REVIEW_BUNDLE_IDENTITY");
  if (!identityLine || !/^[0-9a-f]{64}$/.test(identityLine)) fail(REVIEW_BUNDLE_HOLDS.INVALID, "bundle_identity_missing_or_malformed");

  if (expected.taskId && line("CARD_ID") !== expected.taskId) fail(REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, "task_identity_mismatch");
  if (expected.cardTitle && line("CARD_TITLE") !== expected.cardTitle) fail(REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, "card_title_mismatch");
  if (expected.repository && line("REPOSITORY") !== expected.repository) fail(REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, "repo_identity_mismatch");
  if (expected.branch && line("BRANCH") !== expected.branch) fail(REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, "branch_mismatch");
  if (expected.head && line("HEAD") !== expected.head) fail(REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, "head_mismatch");
  if (expected.treeSha && line("TREE_SHA") !== expected.treeSha) fail(REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, "tree_mismatch");
  if (expected.graphRunId && line("GRAPH_RUN_ID") !== expected.graphRunId) fail(REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, "graph_run_id_mismatch");
  if (expected.reviewResultIdentity && line("REVIEW_RESULT_IDENTITY") !== expected.reviewResultIdentity) fail(REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, "review_result_identity_mismatch");
  if (expected.evidenceManifestDigest && line("EVIDENCE_MANIFEST_DIGEST") !== expected.evidenceManifestDigest) fail(REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, "evidence_manifest_digest_mismatch");

  // unresolved placeholder
  if (/<(TODO|PLACEHOLDER|TBD|pending)>/i.test(text)) fail(REVIEW_BUNDLE_HOLDS.INVALID, "unresolved_placeholder");

  // TA-2R（finding 3 / NEG18）: complete-bundle template residue — a residual
  // `${...}` or machine-placeholder literal anywhere on the surface is a
  // stale-template defect（independent of the generator's own scan）.
  const residue = assertNoTemplateResidue(text);
  if (!residue.ok) fail(REVIEW_BUNDLE_HOLDS.INVALID, `template_residue:${residue.matches.slice(0, 5).join("|")}`);

  // secret scan
  const scan = scanForSecrets(text);
  if (!scan.safe) fail(REVIEW_BUNDLE_HOLDS.SECRET_DETECTED, `secret_patterns:${scan.matches.join(",")}`);

  // evidence references exist + per-file hashes recomputed（never trust the
  // bundle's stated hashes）
  const invSection = text.split("17. Evidence Inventory")[1]?.split("18. Evidence Hashes")[0] ?? "";
  for (const l of invSection.split("\n")) {
    const m = l.match(/^\s+-\s+(.+)$/);
    if (m && m[1] !== "(none)") {
      const p = m[1].trim();
      if (p.includes(":") || p === "sha256=") continue;
      if (!existsSync(p)) fail(REVIEW_BUNDLE_HOLDS.INVALID, `evidence_ref_missing:${p}`);
    }
  }
  const hashSection = text.split("18. Evidence Hashes")[1]?.split("19. Security and Secret Scan")[0] ?? "";
  let curPath = null;
  for (const l of hashSection.split("\n")) {
    const pathM = l.match(/^\s+-\s+(.+)$/);
    if (pathM && pathM[1] !== "(none)") { curPath = pathM[1].trim(); continue; }
    const hashM = l.match(/^\s+sha256=([0-9a-f]{64})$/) ?? l.match(/^\s+sha256=([0-9a-f]{64})/);
    if (hashM && curPath) {
      if (!existsSync(curPath)) continue; // already reported above
      const actual = fileSha256(curPath);
      if (actual && actual !== hashM[1]) fail(REVIEW_BUNDLE_HOLDS.INVALID, `evidence_hash_mismatch:${curPath}`);
    }
  }

  // PASS bundle must not carry blocking findings; HOLD/FAIL must not claim PASS
  const execStatus = line("EXECUTIVE_STATUS");
  const blocking = line("BLOCKING_FINDINGS");
  const reviewPass = line("REVIEW_PASS");
  if (execStatus === "PASS") {
    if (blocking && blocking !== "[]" && blocking !== "NOT_APPLICABLE") fail(REVIEW_BUNDLE_HOLDS.INVALID, "pass_bundle_with_blocking_findings");
    if (reviewPass !== "true") fail(REVIEW_BUNDLE_HOLDS.INVALID, "pass_bundle_without_review_pass");
    const reviewResult = line("REVIEW_RESULT");
    if (reviewResult !== "PASS") fail(REVIEW_BUNDLE_HOLDS.INVALID, "pass_bundle_with_nonpass_review_result");
  } else if (execStatus === "HOLD" || execStatus === "REPAIR") {
    const bundleReady = line("REVIEW_BUNDLE_READY");
    if (bundleReady === "true") fail(REVIEW_BUNDLE_HOLDS.INVALID, "hold_bundle_masquerading_as_final_pass");
  }

  // repair budget invariant（RB-1G repair）: REPAIR_BUDGET_USED is the number
  // of repair iterations actually consumed and must NEVER exceed
  // REPAIR_BUDGET_MAX. A bundle claiming used > max is over-budget evidence
  // and cannot validate（fail-closed; the generator must recount）. NOT_APPLICABLE
  // / absent budget lines are left untouched for non-repair cards.
  const budgetMax = line("REPAIR_BUDGET_MAX");
  const budgetUsed = line("REPAIR_BUDGET_USED");
  if (budgetMax && budgetMax !== "NOT_APPLICABLE" && budgetUsed && budgetUsed !== "NOT_APPLICABLE") {
    const max = Number(budgetMax);
    const used = Number(budgetUsed);
    if (!Number.isFinite(max) || !Number.isFinite(used) || max < 0 || used < 0) {
      fail(REVIEW_BUNDLE_HOLDS.INVALID, `repair_budget_malformed:max=${budgetMax},used=${budgetUsed}`);
    } else if (used > max) {
      fail(REVIEW_BUNDLE_HOLDS.INVALID, `repair_budget_used_exceeds_max:${used}>${max}`);
    }
  }

  // TA-2R（external-review-triggered superseding repair generation —
  // closeout-accounting invariant）: a bundle that supersedes a bundle whose
  // external review verdict was REPAIR IS a bounded-repair generation and
  // MUST have consumed repair budget. REPAIR_BUDGET_USED == 0 next to a
  // SUPERSEDES_BUNDLE_VERDICT: REPAIR binding is contradictory evidence（the
  // control plane could otherwise still allow another repair round）and
  // cannot validate（fail-closed; the generator must recount）. The declared
  // superseded verdict is part of the same section-14 binding the generator
  // wrote（closeout.supersedes.verdict — machine-recorded on archive）.
  const supersedeIdentity = line("SUPERSEDES_BUNDLE_IDENTITY");
  const supersededVerdict = line("SUPERSEDES_BUNDLE_VERDICT");
  if (supersedeIdentity && supersededVerdict === "REPAIR") {
    const usedVal = budgetUsed && budgetUsed !== "NOT_APPLICABLE" ? Number(budgetUsed) : NaN;
    if (!Number.isFinite(usedVal) || usedVal < 1) {
      fail(REVIEW_BUNDLE_HOLDS.INVALID, "repair_budget_unconsumed_despite_superseding_repair");
    }
  }

  // ── TA-2R lineage contract（HOLD / TA2R_REPAIR_LINEAGE_ACCOUNTING_NOT_
  //    CUMULATIVE）: GENERATION_TYPE + REPAIR_LINEAGE_* are the machine-
  //    readable classification. Enforced rules（fail-closed）:
  //      1. cumulative repair iterations can never exceed REPAIR_BUDGET_MAX;
  //      2. the iteration count must accumulate from the superseded bundle's
  //         own lineage（never reset / never skip a consumed repair）;
  //      3. a surface-reseal may touch ONLY the review-surface/governance
  //         scope — a substantive implementation touch means the generation
  //         is a repair（relabeling a repair as a reseal to dodge budget is
  //         rejected）; the validator independently recomputes the touch set
  //         from the two bundles' section-9 attributions（anti-hiding）.
  const generationType = line("GENERATION_TYPE");
  const iterLine = line("REPAIR_LINEAGE_REPAIR_ITERATIONS");
  const resealLine = line("REPAIR_LINEAGE_SURFACE_RESEALS");
  if (generationType && generationType !== "NOT_APPLICABLE") {
    if (!["implementation", "repair-iteration", "surface-reseal"].includes(generationType)) {
      fail(REVIEW_BUNDLE_HOLDS.INVALID, `generation_type_invalid:${generationType}`);
    }
    const iterations = Number(iterLine);
    const reseals = Number(resealLine);
    if (!Number.isFinite(iterations) || iterations < 0) {
      fail(REVIEW_BUNDLE_HOLDS.INVALID, `repair_lineage_iterations_malformed:${iterLine}`);
    }
    if (!Number.isFinite(reseals) || reseals < 0) {
      fail(REVIEW_BUNDLE_HOLDS.INVALID, `repair_lineage_reseals_malformed:${resealLine}`);
    }
    const maxVal = budgetMax && budgetMax !== "NOT_APPLICABLE" ? Number(budgetMax) : NaN;
    if (Number.isFinite(maxVal) && Number.isFinite(iterations) && iterations > maxVal) {
      fail(REVIEW_BUNDLE_HOLDS.INVALID, `repair_lineage_cumulative_exceeds_max:${iterations}>${maxVal}`);
    }
    const usedVal = budgetUsed && budgetUsed !== "NOT_APPLICABLE" ? Number(budgetUsed) : NaN;
    if (Number.isFinite(iterations) && Number.isFinite(usedVal) && usedVal < iterations) {
      fail(REVIEW_BUNDLE_HOLDS.INVALID, `repair_budget_used_below_lineage:${usedVal}<${iterations}`);
    }
    // cumulative lineage consistency against the superseded bundle（when its
    // artifact is present — history is preserved, so a repair generation's
    // predecessor is always readable）.
    const supPath = line("SUPERSEDES_BUNDLE_PATH");
    if (supPath && existsSync(supPath)) {
      try {
        const sup = parseRepairLineage(readFileSync(supPath, "utf8"));
        const supIter = Math.max(sup.repairIterations ?? 0, sup.hasSupersedingRepairAttempt ? 1 : 0, (sup.budgetUsed ?? 0) >= 1 ? 1 : 0);
        const expected = supIter + (generationType === "repair-iteration" ? 1 : 0);
        if (Number.isFinite(iterations) && iterations !== expected) {
          fail(REVIEW_BUNDLE_HOLDS.INVALID, `repair_lineage_iterations_inconsistent:${iterations}!=${expected}`);
        }
        // Repair-budget authority immutability（HOLD AUTH1_PROMOTION_BLOCKED_
        // BY_REPAIR_BUDGET_AUTHORITY_DRIFT）: REPAIR_BUDGET_MAX must NEVER
        // expand across a successor generation. A successor's max must be <=
        // the predecessor's max（when the predecessor records one）. This
        // closes the loop where USED==MAX → MAX++ self-expansion — the
        // bounded-repair loop keeps a real termination boundary. Expanding
        // the budget requires a distinct explicit authority transition
        //（reauthorization）, never a successor self-increase.
        if (Number.isFinite(maxVal) && Number.isFinite(sup.budgetMax) && maxVal > sup.budgetMax) {
          fail(REVIEW_BUNDLE_HOLDS.INVALID, `repair_budget_max_expanded:${maxVal}>${sup.budgetMax}`);
        }
      } catch {
        fail(REVIEW_BUNDLE_HOLDS.INVALID, "repair_lineage_superseded_unparseable");
      }
    }
    if (generationType === "surface-reseal") {
      // declared touch set: every entry must be governance scope and must
      // actually appear in the card delta（a reseal cannot claim a touch it
      // did not make, nor hide a substantive touch behind the label）.
      const deltaSet = new Set(parseDeltaPaths(text));
      for (const p of parseResealTouchedPaths(text)) {
        if (isSubstantiveImplementationPath(p)) {
          fail(REVIEW_BUNDLE_HOLDS.INVALID, `reseal_touches_substantive_implementation:${p}`);
        }
        if (deltaSet.size > 0 && !deltaSet.has(p)) {
          fail(REVIEW_BUNDLE_HOLDS.INVALID, `reseal_touched_path_not_in_delta:${p}`);
        }
      }
      // independent recompute（anti-hiding）: the superseded bundle must be
      // readable — a reseal must PROVE its scope（fail-closed otherwise）— and
      // every path the reseal actually changed (attribution diff) must stay
      // within the governance scope.
      if (!supPath || !existsSync(supPath)) {
        fail(REVIEW_BUNDLE_HOLDS.INVALID, "reseal_superseded_bundle_unreadable");
      } else {
        try {
          const supAtt = parseDeltaAttribution(readFileSync(supPath, "utf8"));
          const curAtt = parseDeltaAttribution(text);
          for (const [p, cur] of curAtt) {
            let touched = false;
            if (cur.kind === "MODIFIED") {
              const prev = supAtt.get(p);
              touched = !prev || prev.kind !== "MODIFIED" || (prev.endSha12 && cur.endSha12 && prev.endSha12 !== cur.endSha12);
            } else if (cur.kind === "ADDED" || cur.kind === "DELETED") {
              touched = !supAtt.has(p);
            }
            if (touched && isSubstantiveImplementationPath(p)) {
              fail(REVIEW_BUNDLE_HOLDS.INVALID, `reseal_hides_substantive_touch:${p}`);
            }
          }
        } catch {
          fail(REVIEW_BUNDLE_HOLDS.INVALID, "reseal_superseded_unparseable");
        }
      }
    }
  }

  // ── FM-3 inventory consistency（authorized / actually-touched /
  // CARD_IMPLEMENTATION_FILES cross-check）─────────────────────────────────
  // Active ONLY when the bundle carries the structured inventory model
  //（CARD_INVENTORY_MODEL: delta-v1）— historical / backfill bundles（and any
  // bundle generated without a captured baseline）never contain the marker,
  // so the new rule is NON-RETROACTIVE（R5: DE-2R etc. are not re-validated
  // to failure）. When the marker IS present the checks are MANDATORY and
  // fail-closed: missing baseline provenance, unauthorized mutation and
  // missing implementation files all hold the bundle.
  const invModel = line("CARD_INVENTORY_MODEL");
  if (invModel && invModel !== "NOT_APPLICABLE") {
    const sec9 = text.split("9. Files Added / Modified / Deleted")[1]?.split("10. Diff Summary")[0] ?? "";
    const blockHeaders = new Set([
      "ADDED", "MODIFIED", "DELETED",
      "CARD_IMPLEMENTATION_FILES", "GRAPH_CLOSEOUT_OUTPUTS", "PRE_EXISTING_DIRTY_FILES",
      "BASELINE_DIRTY_PATHS", "CURRENT_CARD_DELTA_PATHS", "DELTA_ATTRIBUTION", "AUTHORIZATION_EXCEPTIONS",
    ]);
    const blocks = {};
    let cur = null;
    for (const l of sec9.split("\n")) {
      const h = l.match(/^([A-Z_]+):\s*$/);
      if (h && blockHeaders.has(h[1])) { cur = h[1]; blocks[cur] = blocks[cur] ?? []; continue; }
      const m = l.match(/^\s{4}-\s+(.+)$/);
      if (m && cur) {
        if (cur === "AUTHORIZATION_EXCEPTIONS") {
          const sep = m[1].indexOf(" :: ");
          if (sep >= 0) blocks[cur].push({ path: m[1].slice(0, sep).trim(), reason: m[1].slice(sep + 4).trim() });
        } else if (cur === "DELTA_ATTRIBUTION") {
          // `KIND path (content: <sha12>... -> <sha12>...|deleted)`
          const kindM = m[1].match(/^(ADDED|MODIFIED|DELETED) (.+?)(?: \(content: ([0-9a-f]{12}\.\.\. -> ([0-9a-f]{12}\.\.\.|deleted))\))?$/);
          if (kindM) {
            blocks[cur].push({ path: kindM[2].trim(), kind: kindM[1], contentProof: kindM[3] ?? null });
          } else {
            blocks[cur].push({ path: m[1], kind: null, malformed: true });
          }
        } else {
          blocks[cur].push(m[1].trim());
        }
      }
    }
    const deltaKinds = Array.isArray(blocks["DELTA_ATTRIBUTION"]) && blocks["DELTA_ATTRIBUTION"].length
      ? blocks["DELTA_ATTRIBUTION"].map((k) => {
          if (k?.malformed) return { path: k.path, kind: "__MALFORMED__" };
          return { path: k.path, kind: k.kind };
        })
      : null;
    // content-proof well-formedness: a MODIFIED / DELETED entry for a
    // PRE-EXISTING dirty path（in the baseline）must carry a content proof
    //（card-start -> closeout shas; the fail-closed attribution contract）—
    // membership-modified tracked files（clean at card start, status M）need
    // no proof, membership itself is the proof. Any presented proof must be
    // well-formed with distinct sides.
    const baselineSet = new Set(blocks["BASELINE_DIRTY_PATHS"] ?? []);
    for (const k of blocks["DELTA_ATTRIBUTION"] ?? []) {
      if (k?.malformed) fail(REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT, `inventory_delta_kind_malformed:${k.path}`);
      if (k && (k.kind === "MODIFIED" || k.kind === "DELETED") && baselineSet.has(k.path) && !k.contentProof) {
        fail(REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT, `inventory_delta_kind_missing_content_proof:${k.path}`);
      }
      if (k && k.contentProof && k.kind === "MODIFIED") {
        const sides = k.contentProof.split(" -> ");
        if (sides.length !== 2 || sides[1] === "deleted" || sides[0] === sides[1]) {
          fail(REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT, `inventory_delta_kind_bad_content_proof:${k.path}`);
        }
      }
      if (k && k.contentProof && k.kind === "DELETED") {
        const sides = k.contentProof.split(" -> ");
        if (sides.length !== 2 || sides[1] !== "deleted") {
          fail(REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT, `inventory_delta_kind_bad_content_proof:${k.path}`);
        }
      }
    }
    const baselineBlockPresent = /^BASELINE_DIRTY_PATHS:\s*$/m.test(sec9);
    const deltaBlockPresent = /^CURRENT_CARD_DELTA_PATHS:\s*$/m.test(sec9);
    if (!baselineBlockPresent) {
      fail(REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT, "inventory_baseline_missing");
    } else if (!deltaBlockPresent) {
      fail(REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT, "inventory_delta_block_missing");
    } else {
      const sec9Digest = sec9.match(/^BASELINE_DIRTY_DIGEST:\s*(.+)$/m)?.[1]?.trim() ?? null;
      const sec4Digest = line("BASELINE_DIRTY_DIGEST"); // first occurrence = section 4
      if (sec9Digest && sec4Digest && sec9Digest !== sec4Digest) {
        fail(REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT, "inventory_baseline_digest_mismatch");
      }
      const baselineHead = sec9.match(/^BASELINE_HEAD:\s*(.+)$/m)?.[1]?.trim() ?? null;
      const currentHead = line("HEAD");
      if (baselineHead && currentHead && baselineHead !== currentHead) {
        fail(REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT, "inventory_baseline_head_mismatch");
      }
      const cleanSplit = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter((p) => p && p !== "NOT_APPLICABLE" && p !== "[]");
      const inv = validateCardInventoryConsistency({
        authorizedPaths: cleanSplit(line("AUTHORIZED_PATHS")),
        implementationPaths: blocks["CARD_IMPLEMENTATION_FILES"] ?? [],
        closeoutOutputPaths: blocks["GRAPH_CLOSEOUT_OUTPUTS"] ?? [],
        preExistingDirtyPaths: blocks["PRE_EXISTING_DIRTY_FILES"] ?? [],
        baselinePaths: blocks["BASELINE_DIRTY_PATHS"] ?? [],
        finalDirtyPaths: cleanSplit(line("DIRTY_PATHS")),
        deletedPaths: blocks["DELETED"] ?? [],
        deltaPaths: blocks["CURRENT_CARD_DELTA_PATHS"] ?? [],
        deltaKinds,
        exceptions: blocks["AUTHORIZATION_EXCEPTIONS"] ?? [],
      });
      for (const e of inv.errors) fail(REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT, e);
    }
  }

  const ok = errors.length === 0;
  const holdCode = ok ? null : (errors.some((e) => e.startsWith(REVIEW_BUNDLE_HOLDS.SECRET_DETECTED))
    ? REVIEW_BUNDLE_HOLDS.SECRET_DETECTED
    : errors.some((e) => e.startsWith(REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH))
      ? REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH
      : errors.some((e) => e.startsWith(REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT))
        ? REVIEW_BUNDLE_HOLDS.INVENTORY_INCONSISTENT
        : REVIEW_BUNDLE_HOLDS.INVALID);
  return { ok, errors, holdCode };
}

// ---------------------------------------------------------------------------
// Closeout gate: final internal review -> generate -> validate -> verdict.
// ---------------------------------------------------------------------------

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_timeout_after_${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function runCloseoutGate({
  source,
  repoPath,
  outDir,
  timeoutMs = 30000,
  fileName,
  expected = {},
  generate = renderReviewBundle,
  write = writeReviewBundle,
  validate = validateReviewBundle,
  repoFacts = null,
  // RB-1G external review bundle delivery:
  //   deliver     = undefined → hard rule（RB-1H）: formal review closeouts
  //                 atomically deliver to the FIXED external-review surface
  //                 （Current/）; a failed surface write keeps the card at
  //                 AWAITING_BUNDLE_DELIVERY. Pass an explicit hook to
  //                 override, or null to opt out（non-formal test paths only）.
  deliver = undefined,   // async ({ bundlePath, bundle, state, source, outDir }) -> { attempted, method?, attemptedAt?, reason? }
  deliveryMethod = null, // fallback method name when `deliver` reports success without one
  // RB2-B2（AUTOLOOP-V1-REVFIX-B2 — MANDATORY REVIEW DELIVERY INVARIANT）:
  // formal:true marks the FORMAL Review closeout boundary（set only by the
  // production entry points runMandatoryGraphCloseout and
  // gov-closeout-bundle --generate）. Once the formal gate is reached with a
  // valid bundle, publication is REQUIRED — the caller-supplied source flag
  // `externalReview.deliveryRequired` is derived-informational ONLY and can
  // never suppress it（nor can its absence / malformed shape silently skip
  // it）. Non-formal invocations（unit-test helpers）never set formal and opt
  // out with deliver: null — they never touch the desktop surface.
  formal = false,        // formal Review closeout boundary reached
  supersedes = null,     // { reviewBundleIdentity, reviewBundleSha256, bundlePath, verdict?, reviewedAt? }
  agentIdentity = null,  // identity of the implementing agent（verdict self-declaration guard）
  surfaceDir = null,     // fixed surface override（defaults to externalReviewSurfaceDir()）
  // AUTOLOOP-P4 — task success contract（frozen verification plan）+ authority
  // revocation, forwarded into THE PASS ORACLE that decides the final
  // verdict. successContract: { requiredChecks: [{ id, kind:
  //   "regression-suite"|"verifier", suite?, freshness?, requiresIndependent?
  // }], invariantResults?: [{ id, ok, detail? }] }. The implicit checks
  // review-bundle-valid + independent-review are ALWAYS required and cannot
  // be removed.
  successContract = null, // declared task success conditions（bound pre-execution）
  authorityRevocation = null, // { revoked: true, reason } — fail-closed when set
  // POST-P4 Truth Revocation Cascade — validated revocation EVENTS（or a
  // precomputed { evidenceIds, artifactShas } facts object）from the durable
  // ledger. Forwarded into THE PASS ORACLE: revoked required evidence can
  // never satisfy PASS; unrelated truth is untouched. The oracle stays the
  // only PASS authority — revocation integrates THROUGH it.
  truthRevocations = null,
} = {}) {
  // 1) source present with a completed final review
  if (!source || typeof source !== "object") {
    return { final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:closeout_source_absent" };
  }
  const review = source.review || {};
  if (!review.result || !review.reviewResultIdentity) {
    return { final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:final_review_not_completed" };
  }
  // A PASS closeout cannot ride on a review that still has blocking findings.
  if (source.executiveStatus === "PASS" && Array.isArray(review.blockingFindings) && review.blockingFindings.length > 0) {
    return { final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.INVALID, reason: "REVIEW_BUNDLE_INVALID:pass_closeout_with_blocking_review" };
  }
  if (!outDir) return { final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:out_dir_absent" };

  // 2) repo facts are git-derived（authoritative）— override any caller claim.
  //    FM-3: when the source carries the captured baseline snapshot the
  //    baseline digest + delta are derived against it（pre-existing dirty
  //    stays outside the current-card delta）.
  let facts;
  try {
    facts = repoFacts ?? (repoPath ? collectRepoFacts(repoPath, { baseline: source?.inventory?.baseline ?? null }) : null);
    if (!facts) return { final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.GENERATION_FAILED, reason: "REVIEW_BUNDLE_GENERATION_FAILED:repo_facts_unavailable" };
  } catch (e) {
    return { final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.GENERATION_FAILED, reason: `REVIEW_BUNDLE_GENERATION_FAILED:${String(e?.message ?? e).slice(0, 300)}` };
  }
  const merged = {
    ...source,
    repo: {
      repository: source.repo?.repository ?? facts.repository,
      branch: facts.branch,
      head: facts.head,
      treeSha: facts.treeSha,
      worktreePath: facts.worktreePath,
      baselineDirtyDigest: facts.baselineDirtyDigest,
      finalDirtyDigest: facts.finalDirtyDigest,
      remote: facts.remote,
    },
    repoIntegrity: {
      head: facts.head,
      treeSha: facts.treeSha,
      worktreeClean: facts.worktreeClean,
      dirtyPaths: facts.dirtyPaths,
      untrackedFiles: facts.untrackedFiles,
      remote: facts.remote,
    },
    bundleReady: source.executiveStatus === "PASS",
    // RB2-B2: for a FORMAL review closeout the delivery-required truth is
    // DERIVED（informational §2 rendering）— a caller-supplied
    // externalReview.deliveryRequired that is missing / false / malformed /
    // non-object can never change it. Non-formal sources keep their own
    // shape untouched（NOT_APPLICABLE rendering unchanged）.
    externalReview: (formal === true && (!source.externalReview || typeof source.externalReview !== "object" || Array.isArray(source.externalReview)))
      ? { deliveryRequired: true, status: source.externalReview?.status ?? "AWAITING_EXTERNAL_REVIEW", supersedes: source.externalReview?.supersedes ?? null }
      : (formal === true ? { ...source.externalReview, deliveryRequired: true } : source.externalReview),
  };

  // 2b) TA-2R（finding 2 / NEG17）— content-identity attribution fail-closed.
  // A card that opted into content-v1 attribution whose delta contains a path
  // with an UNAVAILABLE card-start sha（baseline predates content capture）is
  // held — attribution is never guessed. The check runs on the gate's OWN
  // git-derived facts（never the caller's claim）.
  if (source.inventory?.attribution === "content-v1" || source.inventory?.baseline?.contentDigest) {
    if (Array.isArray(facts.unattributable) && facts.unattributable.length > 0) {
      return {
        final: "HOLD",
        holdCode: "DELTA_ATTRIBUTION_FAIL_CLOSED",
        reason: `DELTA_ATTRIBUTION_FAIL_CLOSED:${facts.unattributable.slice(0, 10).join(",")}${facts.unattributable.length > 10 ? `(+${facts.unattributable.length - 10} more)` : ""}`,
      };
    }
  }

  // 3) generate（bounded; deterministic）
  let bundle;
  try {
    bundle = await withTimeout(Promise.resolve().then(() => generate(merged, { generatedAt: new Date().toISOString() })), timeoutMs, "review_bundle_generation");
  } catch (e) {
    // TA-2R（finding 3 / NEG18）: a template-residue throw（renderReviewBundle
    // fail-closed scan）surfaces as its own hold code, never a generic
    // generation failure.
    if (String(e?.message ?? e).includes("review_bundle_template_residue")) {
      return { final: "HOLD", holdCode: "TEMPLATE_RESIDUE", reason: String(e?.message ?? e).slice(0, 400) };
    }
    return { final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.GENERATION_FAILED, reason: `REVIEW_BUNDLE_GENERATION_FAILED:${String(e?.message ?? e).slice(0, 300)}` };
  }
  if (!bundle || !bundle.text || !bundle.sha256) {
    return { final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.GENERATION_FAILED, reason: "REVIEW_BUNDLE_GENERATION_FAILED:incomplete_bundle_object" };
  }

  // 3b) pre-write secret scan（fail-closed BEFORE anything touches disk）
  const preScan = scanForSecrets(bundle.text);
  if (!preScan.safe) {
    return { final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.SECRET_DETECTED, reason: `REVIEW_BUNDLE_SECRET_DETECTED:${preScan.matches.join(",")}` };
  }
  // 3c) TA-2R（finding 3 / NEG18）— complete-bundle template residue scan
  //（fail-closed before write; the independent validator re-runs it）.
  const residue = assertNoTemplateResidue(bundle.text);
  if (!residue.ok) {
    return { final: "HOLD", holdCode: "TEMPLATE_RESIDUE", reason: `TEMPLATE_RESIDUE:${residue.matches.slice(0, 5).join(" | ")}` };
  }

  // 4) atomic write（secret scan is also re-run by the validator）
  let path;
  try {
    const w = await withTimeout(Promise.resolve().then(() => write(bundle, outDir, { fileName })), timeoutMs, "review_bundle_write");
    path = w.path;
  } catch (e) {
    return { final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.GENERATION_FAILED, reason: `REVIEW_BUNDLE_GENERATION_FAILED:write:${String(e?.message ?? e).slice(0, 300)}` };
  }

  // 5) independent validation
  const validation = validate(path, {
    authorizedDir: outDir,
    expected: {
      taskId: source.task?.cardId,
      cardTitle: source.task?.cardTitle,
      repository: merged.repo.repository ?? null,
      branch: merged.repo.branch ?? null,
      head: merged.repo.head,
      treeSha: merged.repo.treeSha,
      graphRunId: source.graph?.graphRunId ?? null,
      reviewResultIdentity: review.reviewResultIdentity ?? null,
      evidenceManifestDigest: bundle.evidenceManifestDigest ?? null,
      ...expected,
    },
  });
  if (!validation.ok) {
    return { final: "HOLD", holdCode: validation.holdCode ?? REVIEW_BUNDLE_HOLDS.INVALID, reason: `${validation.holdCode ?? "REVIEW_BUNDLE_INVALID"}:${validation.errors.join(";").slice(0, 500)}` };
  }

  // 5b) RB-1G structured external-review state. The bundle artifact is bound
  //     by identity + sha256. The sender may record at most a NON-AUTHORITATIVE
  //     delivery attempt; RECEIVED is proven solely by the external reviewer's
  //     verdict（applyExternalReviewVerdict）. Until then the status is
  //     AWAITING_EXTERNAL_REVIEW（or AWAITING_BUNDLE_DELIVERY when the
  //     environment cannot hand the artifact over）and the card may not
  //     declare EXTERNAL_REVIEW_PASS / CARD_COMPLETE.
  let externalReview = buildExternalReviewState({
    bundle: { identity: bundle.identity, sha256: bundle.sha256 },
    bundlePath: path,
    supersedes: supersedes ?? null,
  });
  // ── RB2-B2 MANDATORY REVIEW DELIVERY INVARIANT ────────────────────────
  // AUTOLOOP-V1-REVFIX-B2（SOURCE_CONTRACT_GAP）: publication for a FORMAL
  // review closeout is REQUIRED once the gate is reached with a valid
  // bundle. The caller-supplied source flag `externalReview.deliveryRequired`
  // is derived-informational ONLY — it can never suppress publication, and
  // its absence / false / malformed shape can never silently skip it:
  //   FORMAL_REVIEW_CLOSEOUT + bundle valid  →  DELIVERY_REQUIRED
  // No fixed surface delivery -> the card stays AWAITING_BUNDLE_DELIVERY
  // （never a PASS/external-review claim without a delivered artifact）. The
  // default surface deliverer is used unless the caller passed an explicit
  // hook（a custom hook is still a delivery attempt — attempted:false keeps
  // the closeout non-PASS）.
  const formalCloseout = formal === true;
  if (formalCloseout && deliver === undefined) {
    // hard rule: default surface deliverer（flag-independent）
    deliver = (d) => deliverToExternalReviewSurface({ ...d, source: merged, surfaceDir: surfaceDir ?? null });
  }
  if (formalCloseout && deliver === null) {
    // an explicit opt-out can never suppress a FORMAL closeout's delivery —
    // this input cannot be safely canonicalized, so it fails closed.
    return {
      final: "HOLD",
      holdCode: EXTERNAL_REVIEW_HOLDS.DELIVERY_NOT_CONFIRMED,
      reason: "FORMAL_CLOSEOUT_DELIVERY_OPT_OUT_DENIED:deliver=null cannot suppress mandatory formal delivery",
      bundlePath: path,
      bundle: { identity: bundle.identity, sha256: bundle.sha256, evidenceManifestDigest: bundle.evidenceManifestDigest, generatedAt: bundle.generatedAt, fileName },
      externalReview,
      supersedes: supersedes ?? null,
    };
  }
  if (deliver) {
    try {
      const d = await withTimeout(
        Promise.resolve().then(() => deliver({ bundlePath: path, bundle: externalReview.delivery, state: externalReview, source: merged, outDir })),
        timeoutMs,
        "review_bundle_delivery",
      );
      if (d && d.attempted !== false) {
        // sender-side attempt is INFORMATIONAL ONLY — never a receipt
        externalReview.delivery.attempted = true;
        externalReview.delivery.method = d?.method ?? (deliveryMethod ?? "sender-provided");
        externalReview.delivery.attemptedAt = d?.attemptedAt ?? new Date().toISOString();
      } else {
        // the environment reported it cannot hand the artifact over
        externalReview.externalReviewStatus = EXTERNAL_REVIEW_STATUSES[1]; // AWAITING_BUNDLE_DELIVERY
        externalReview.externalReviewStatusReason = (d && d.reason) ? `delivery_blocked:${d.reason}` : "NO_DELIVERY_CHANNEL";
      }
    } catch (e) {
      externalReview.externalReviewStatus = EXTERNAL_REVIEW_STATUSES[1];
      externalReview.externalReviewStatusReason = `delivery_error:${String(e?.message ?? e).slice(0, 200)}`;
    }
  }

  // AUTOLOOP_REPORT_LIFECYCLE_REPAIR_1（FM-2 / R4 / R5 / R6）: delivery is
  // part of successful closeout. For a FORMAL closeout（RB2-B2: delivery is
  // mandatory at the formal gate — never caller-optional）:
  //   - a failed / declined / blocked delivery（AWAITING_BUNDLE_DELIVERY）
  //     makes the top-level final non-PASS（R4 / R6 propagation）;
  //   - when the fixed-surface default channel reported success, the surface
  //     artifact is re-verified（identity + recomputed SHA + delivery record）
  //     so an AWAITING_EXTERNAL_REVIEW state can only accompany a truly
  //     present bundle（R5 invariant）.
  const requiresDelivery = formalCloseout;
  let deliveryUnconfirmed = requiresDelivery
    && (externalReview.externalReviewStatus === EXTERNAL_REVIEW_STATUSES[1] || externalReview.delivery.attempted !== true);
  if (!deliveryUnconfirmed && requiresDelivery && externalReview.delivery.method === "external-review-surface") {
    const proof = verifyExternalReviewSurface({
      surfaceDir: surfaceDir ?? null,
      expected: { identity: bundle.identity, sha256: bundle.sha256, cardId: source.task?.cardId ?? null },
    });
    if (!proof.ok) {
      externalReview.externalReviewStatus = EXTERNAL_REVIEW_STATUSES[1]; // AWAITING_BUNDLE_DELIVERY
      externalReview.externalReviewStatusReason = `surface_invariant_failed:${proof.errors.join(";")}`;
      deliveryUnconfirmed = true;
    }
  }

  // 6) AUTOLOOP-P4 — THE PASS ORACLE. Every formal closeout PASS converges
  //    on evaluatePassOracle: the declared success contract + attributable
  //    evidence（bundle validation, independent review, task-specific
  //    checks）+ invariants + authority state → PASS | NOT_PASS. A NOT_PASS
  //    oracle NEVER returns final PASS（fail-closed）.
  const p4CardId = typeof source.task?.cardId === "string" ? source.task.cardId : null;
  const p4Generation = Number.isInteger(source.task?.generation) ? source.task.generation : null;
  const p4Norm = normalizeSuccessContract({
    requiredChecks: Array.isArray(successContract?.requiredChecks) ? successContract.requiredChecks : [],
    head: merged.repo.head ?? null,
    treeSha: merged.repo.treeSha ?? null,
    authority: authorityRevocation && authorityRevocation.revoked ? authorityRevocation : undefined,
  });
  const p4Contract = { ok: p4Norm.ok, errors: p4Norm.errors, contract: { ...p4Norm.contract, cardId: p4CardId, generation: p4Generation } };
  const p4Now = new Date().toISOString();
  const p4Binding = { head: merged.repo.head ?? null, treeSha: merged.repo.treeSha ?? null };
  const p4Evidence = [
    {
      schema: ORACLE_EVIDENCE_SCHEMA, evidenceId: "gate:review-bundle-valid", cardId: p4CardId, generation: p4Generation ?? 0,
      checkId: "review-bundle-valid", kind: "deterministic",
      producer: { identity: "review-bundle-validator", role: "independent" },
      result: "PASS", at: p4Now, command: "validateReviewBundle", binding: p4Binding,
    },
    {
      schema: ORACLE_EVIDENCE_SCHEMA, evidenceId: "gate:independent-review", cardId: p4CardId, generation: p4Generation ?? 0,
      checkId: "independent-review", kind: "semantic",
      producer: { identity: review.reviewResultIdentity ?? "graph-final-review", role: "independent" },
      // buildGraphCloseoutSource keeps result and pass consistent; a
      // hand-built source may carry only `result` — both spellings accepted,
      // anything else is a FAIL（fail-closed）.
      result: (review.pass === true || review.result === "PASS") ? "PASS" : "FAIL",
      at: p4Now, command: "finalReviewerVerdicts", binding: p4Binding,
    },
  ];
  for (const c of p4Norm.contract.requiredChecks) {
    if (c.id === "review-bundle-valid" || c.id === "independent-review") continue;
    let result = null;
    let command = null;
    if ((c.kind ?? "regression-suite") === "verifier") {
      command = "closeout-verifier";
      if (source.verifier && typeof source.verifier === "object") {
        result = source.verifier.pass === true || source.verifier.result === "PASS" ? "PASS" : "FAIL";
      }
    } else {
      const suite = c.suite ?? c.id;
      command = `regression:${suite}`;
      const entry = Array.isArray(source.regression)
        ? source.regression.find((r) => r && r.suite === suite)
        : null;
      if (entry) {
        // Repo convention（§16）: regression entries carry COUNTS
        // {suite, tests, pass, fail} — a passing suite is tests > 0,
        // fail === 0 and every test passed.
        result = Number(entry.tests) > 0 && Number(entry.fail) === 0 && Number(entry.pass) === Number(entry.tests) ? "PASS" : "FAIL";
      }
    }
    if (result !== null) {
      p4Evidence.push({
        schema: ORACLE_EVIDENCE_SCHEMA, evidenceId: `gate:${c.id}`, cardId: p4CardId, generation: p4Generation ?? 0,
        checkId: c.id, kind: "deterministic",
        producer: { identity: "closeout-gate", role: "executor" },
        result, at: p4Now, command, binding: p4Binding,
      });
    }
  }
  // POST-P4 Truth Revocation Cascade — the gate SELF-LOADS the durable
  // ledger from <outDir>/truth-revocations/（red-team finding: relying on
  // callers to supply facts left every production path unwired）. A caller-
  // supplied truthRevocations array is an OVERRIDE for tests/direct use and
  // is fully re-validated. Any unreadable/corrupt ledger or invalid event
  // fails closed — never a PASS derived from a partial revocation view.
  let p4RevocationFacts = null;
  if (Array.isArray(truthRevocations)) {
    const p4Cascade = computeCascade({ events: truthRevocations, evidence: p4Evidence });
    if (p4Cascade.rejectedEvents.length > 0) {
      return {
        final: "HOLD",
        holdCode: "TRUTH_REVOCATION_INVALID",
        reason: `TRUTH_REVOCATION_INVALID:${p4Cascade.rejectedEvents.map((r) => r.revocationId ?? "unnamed").join(",")}`,
        bundlePath: path,
      };
    }
    p4RevocationFacts = revocationFactsForOracle(p4Cascade);
  } else {
    const p4Ledger = readRevocationLedger(revocationLedgerPath(outDir));
    if (!p4Ledger.ok) {
      return {
        final: "HOLD",
        holdCode: p4Ledger.holdCode ?? "TRUTH_REVOCATION_LEDGER_INVALID",
        reason: `${p4Ledger.holdCode ?? "TRUTH_REVOCATION_LEDGER_INVALID"}:${p4Ledger.reason ?? "unreadable"}`,
        bundlePath: path,
      };
    }
    p4RevocationFacts = revocationFactsForOracle(computeCascade({ events: p4Ledger.events, evidence: p4Evidence }));
  }
  const oracle = evaluatePassOracle({
    contract: p4Contract,
    evidence: p4Evidence,
    invariants: Array.isArray(successContract?.invariantResults) ? successContract.invariantResults : [],
    revocations: p4RevocationFacts,
    now: p4Now,
  });
  if (!oracle.pass) {
    return {
      final: "HOLD",
      holdCode: "PASS_ORACLE_REJECTED",
      reason: `PASS_ORACLE_REJECTED:${oracle.failures.map((f) => `${f.code}${f.checkId ? `@${f.checkId}` : ""}`).join(",")}`,
      bundlePath: path,
      bundle: { identity: bundle.identity, sha256: bundle.sha256, evidenceManifestDigest: bundle.evidenceManifestDigest, generatedAt: bundle.generatedAt, fileName },
      externalReview,
      supersedes: supersedes ?? null,
      oracle,
    };
  }

  // 7) final closeout verdict（reached ONLY through a PASS oracle）
  if (source.executiveStatus === "PASS") {
    if (deliveryUnconfirmed) {
      return {
        final: "AWAITING_BUNDLE_DELIVERY",
        holdCode: EXTERNAL_REVIEW_HOLDS.DELIVERY_NOT_CONFIRMED,
        reason: externalReview.externalReviewStatusReason ?? "AWAITING_BUNDLE_DELIVERY",
        bundlePath: path,
        bundle: { identity: bundle.identity, sha256: bundle.sha256, evidenceManifestDigest: bundle.evidenceManifestDigest, generatedAt: bundle.generatedAt, fileName },
        externalReview,
        supersedes: supersedes ?? null,
        oracle,
      };
    }
    return {
      final: "PASS",
      holdCode: null,
      reason: null,
      bundlePath: path,
      bundle: { identity: bundle.identity, sha256: bundle.sha256, evidenceManifestDigest: bundle.evidenceManifestDigest, generatedAt: bundle.generatedAt, fileName },
      externalReview,
      supersedes: supersedes ?? null,
      oracle,
    };
  }
  return {
    final: "HOLD",
    holdCode: null,
    reason: `CARD_OUTCOME:${source.executiveStatus}`,
    bundlePath: path,
    bundle: { identity: bundle.identity, sha256: bundle.sha256, evidenceManifestDigest: bundle.evidenceManifestDigest, generatedAt: bundle.generatedAt, fileName },
    externalReview,
    supersedes: supersedes ?? null,
    oracle,
  };
}

// ---------------------------------------------------------------------------
// Mandatory Graph closeout（RB-1R）— the single card-level closeout boundary.
// ---------------------------------------------------------------------------
//
// `runCloseoutGate` is the ONE gate（CLI / backfill / Graph all call it）.
// `runMandatoryGraphCloseout` makes it MANDATORY for Graph cards marked
// `requiresReview`（structured field — never parsed from free-text stdout）.
// The generic Graph runner（runColimaGraph）calls it at card closeout, BEFORE
// the final verdict is returned; a PASS graph whose bundle gate does not pass
// is downgraded to HOLD（fail-closed; no downstream PASS without a validated
// bundle）.
//
// Distinction（applicability contract）:
//   node-level interim completion  = per-node `final: "PASS"`（a phase passed）
//   card-level final closeout      = the graph `final` AFTER the mandatory
//                                     bundle gate — only THIS may declare
//                                     the card's formal PASS.

function firstDefined(...vals) {
  return vals.find((v) => v !== undefined && v !== null && v !== "");
}

/**
 * Bounded, secret-scanned structured snapshot of a Graph run, written by the
 * closeout layer（never by the writer）and referenced as bundle evidence.
 * Excludes stdout / full diff text / container metadata.
 */
export function buildGraphCloseoutEvidenceSnapshot({ graphResult, closeout }) {
  const nodes = (graphResult?.nodeResults ?? []).filter(Boolean);
  const transitions = (graphResult?.transitions ?? []).filter(Boolean);
  return {
    schema: "autoloop.review-bundle.graph-closeout-evidence/v1",
    graphRunId: graphResult?.executionId ?? null,
    final: graphResult?.final ?? null,
    holdCode: graphResult?.holdCode ?? null,
    reason: graphResult?.reason ?? null,
    task: {
      cardId: closeout?.cardId ?? null,
      cardTitle: closeout?.cardTitle ?? null,
      cardType: closeout?.cardType ?? null,
    },
    scheduler: {
      verdict: graphResult?.scheduler?.verdict ?? null,
      order: (graphResult?.scheduler?.order ?? []).slice(),
      statuses: graphResult?.scheduler?.statuses ?? {},
      skipped: (graphResult?.scheduler?.skipped ?? []).slice(),
      writerViolations: (graphResult?.scheduler?.writerViolations ?? []).slice(),
      leaseHolderAfter: graphResult?.scheduler?.leaseHolderAfter ?? null,
    },
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      phaseExecutionId: n.phaseExecutionId ?? null,
      taskType: n.taskType ?? null,
      dependencies: Array.isArray(n.dependencies) ? n.dependencies.slice() : [],
      final: n.final ?? null,
      attempt: n.attempt ?? null,
      reason: n.reason ?? null,
      startedAt: n.startedAt ?? null,
      completedAt: n.completedAt ?? null,
      // VCA-1 W1A (S10) — never fabricate durations: a node without a real
      // measured start/end is explicitly UNKNOWN（null timestamps）.
      timingSource: Number.isFinite(n.startedAt) && Number.isFinite(n.completedAt) ? "MEASURED" : "UNKNOWN",
      worktreeVerified: n.worktreeIdentity?.verified ?? null,
      worktreeRevoked: n.cleanup?.worktreeRevoked ?? null,
      subagentResultStatus: n.subagentResult?.status ?? null,
      subagentTestResults: n.subagentResult?.testResults ?? null,
      reviewResultStatus: n.reviewResult?.recommendedAction ?? null,
      reviewBlockingFindings: Array.isArray(n.reviewResult?.blockingFindings) ? n.reviewResult.blockingFindings.slice() : [],
    })),
    transitions: transitions.map((tx) => ({
      phaseId: tx.phaseId,
      final: tx.final ?? null,
      attempt: tx.attempt ?? null,
      reason: tx.reason ?? null,
      lifecycleTransitions: (tx.lifecycleTransitions ?? []).map((t) => ({
        phase: t.phase ?? null,
        attempt: t.attempt ?? null,
        status: t.status ?? null,
        verdict: t.verdict ?? null,
        recommended_next_action: t.recommended_next_action ?? null,
      })),
    })),
  };
}

/**
 * Write the evidence snapshot atomically into outDir and return its path +
 * sha256（tool-computed）. Fail-closed on secret pattern / path escape.
 */
export function writeGraphCloseoutEvidence({ graphResult, closeout, outDir }) {
  if (!outDir) {
    return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:evidence_out_dir_absent" };
  }
  const root = resolve(outDir);
  mkdirSync(root, { recursive: true });
  const executionId = graphResult?.executionId ?? "graph-unknown";
  const fileName = `${executionId}-graph-closeout-evidence.json`;
  const target = resolve(root, fileName);
  if (target !== root && !target.startsWith(root + "/")) {
    return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.INVALID, reason: "REVIEW_BUNDLE_INVALID:evidence_path_escape" };
  }
  const snapshot = buildGraphCloseoutEvidenceSnapshot({ graphResult, closeout });
  const text = JSON.stringify(snapshot, null, 2) + "\n";
  const scan = scanForSecrets(text);
  if (!scan.safe) {
    return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.SECRET_DETECTED, reason: `REVIEW_BUNDLE_SECRET_DETECTED:evidence:${scan.matches.join(",")}` };
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
  } catch (e) {
    try {
      if (existsSync(tmp)) rmSyncSafe(tmp);
    } catch { /* best effort */ }
    return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.GENERATION_FAILED, reason: `REVIEW_BUNDLE_GENERATION_FAILED:evidence_write:${String(e?.message ?? e).slice(0, 300)}` };
  }
  return { ok: true, path: target, sha256: sha256Hex(text), fileName };
}

function rmSyncSafe(p) {
  rmSync(p, { force: true });
}

/**
 * Build a REVIEW_BUNDLE_SOURCE_SCHEMA source from a REAL Graph run. Every
 * field is derived from STRUCTURED graph data（node results / lifecycle
 * transitions / review-agent results / scheduler verdict）— free-text stdout
 * is never parsed; repo identity stays git-derived by the gate.
 */
export function buildGraphCloseoutSource({ graphResult, closeout, repoPath = null, cwd = null, evidence = [] } = {}) {
  // ── R-12 GATE K — SOURCE BUILDER HARDENING ─────────────────────────────
  // The builder consumes VALIDATED, NORMALIZED graph evidence only. Raw
  // caller aggregate status can never bypass consistency checks here:
  //   - the graphResult must pass the single canonical validator (structure
  //     + identity + node normalization) — malformed evidence fails closed;
  //   - an aggregate PASS must be consistent with every required child
  //     (completeness + aggregate/child consistency) — a forged PASS over
  //     missing/HOLD/FAIL/skipped/blocked children is downgraded to HOLD
  //     with the deterministic R12 violation, never rendered as authority;
  //   - derived source.executiveStatus reflects VALIDATED graph truth, not
  //     the caller's claimed final.
  // This is the nearest pre-oracle seam: the PASS oracle downstream consumes
  // source.executiveStatus / source.review / source.verifier, so the fence
  // must hold BEFORE derivation.
  const graphValidation = validateGraphEvidence(graphResult ?? null, {});
  if (!graphValidation.ok) {
    throw new Error(`${graphValidation.holdCode ?? "R12_EVIDENCE_INVALID"}:${graphValidation.errors.join(";")}`.slice(0, 400));
  }
  const vgr = graphValidation.graphResult;
  let graphFinal = vgr.final;
  if (graphFinal === "PASS") {
    const consistency = assertGraphAggregateConsistency(vgr);
    if (!consistency.ok) {
      // Aggregate PASS contradicted by required children → the source can
      // only ever describe a HOLD. The deterministic violation travels in
      // the reason so the gate/bundle records WHY authority was withheld.
      graphFinal = "HOLD";
    }
  }
  const nodes = vgr.nodeResults;
  const transitions = vgr.transitions;
  const executionId = vgr.executionId;
  const aggregateContradiction = vgr.final === "PASS" && graphFinal === "HOLD"
    ? assertGraphAggregateConsistency(vgr).errors.join(";")
    : null;
  const allNodesPassed = nodes.length > 0 && nodes.every((n) => n.final === "PASS");

  // ── execution（graph-NODE surface only; the regression suites are section
  // 16 — never mixed into section 11. TA-2R finding 3）──
  let testsPassed = 0;
  let testsFailed = 0;
  let testsTotal = 0;
  const testsExecuted = [];
  for (const n of nodes) {
    const tr = n.subagentResult?.testResults;
    if (tr && Number.isInteger(tr.total)) {
      testsPassed += Number(tr.passed ?? 0);
      testsFailed += Number(tr.failed ?? 0);
      testsTotal += Number(tr.total ?? 0);
    }
    if (Array.isArray(n.subagentResult?.testsExecuted)) {
      for (const t of n.subagentResult.testsExecuted) {
        if (typeof t === "string" && !testsExecuted.includes(t)) testsExecuted.push(t);
      }
    }
    const ntt = n.taskType;
    if (typeof ntt === "string" && !testsExecuted.includes(`graph node ${n.nodeId}:${ntt}`)) {
      testsExecuted.push(`graph node ${n.nodeId}:${ntt}`);
    }
  }
  const nodesPassed = nodes.filter((n) => n.final === "PASS").length;
  const nodesFailed = nodes.filter((n) => n.final !== "PASS").length;

  // ── independent final review ───────────────────────────────────────────
  // Writer sub-agent nodes carry the INDEPENDENT review-agent result;
  // research / read-only nodes carry their per-node reviewer verdict in the
  // lifecycle transitions. Both are structured（never free text）.
  const reviewResults = nodes
    .map((n) => n.reviewResult)
    .filter((r) => r && typeof r === "object" && !Array.isArray(r) && typeof r.recommendedAction === "string");
  const finalReviewerVerdicts = [];
  for (const tx of transitions) {
    const verdicts = (tx.lifecycleTransitions ?? []).filter((t) => t.phase === "reviewer_verdict");
    if (verdicts.length > 0) {
      finalReviewerVerdicts.push({ phaseId: tx.phaseId, ...verdicts[verdicts.length - 1] });
    }
  }
  let review = { pass: false, result: "HOLD", reviewResultIdentity: null, blockingFindings: [], summary: "NOT_APPLICABLE" };
  if (reviewResults.length > 0) {
    const blocking = [];
    for (const r of reviewResults) {
      if (Array.isArray(r.blockingFindings)) blocking.push(...r.blockingFindings);
    }
    const pass = reviewResults.every((r) => r.recommendedAction === "PASS") && blocking.length === 0;
    review = {
      pass,
      result: pass ? "PASS" : "HOLD",
      reviewResultIdentity: sha256Hex(recursiveCanonicalJson(reviewResults)),
      blockingFindings: blocking,
      summary: firstDefined(reviewResults.map((r) => r.summary).filter(Boolean).join(" | "), "independent review agent result"),
    };
  } else if (finalReviewerVerdicts.length > 0) {
    const pass = finalReviewerVerdicts.every((v) => v.verdict === "PASS");
    review = {
      pass,
      result: pass ? "PASS" : "HOLD",
      reviewResultIdentity: sha256Hex(recursiveCanonicalJson(finalReviewerVerdicts.map((v) => ({
        phaseId: v.phaseId, verdict: v.verdict, recommended_next_action: v.recommended_next_action,
      })))),
      blockingFindings: finalReviewerVerdicts.filter((v) => v.verdict !== "PASS").map((v) => `${v.phaseId}:${v.verdict}`),
      summary: `${finalReviewerVerdicts.length} node reviewer verdict(s); final ${pass ? "PASS" : "HOLD"}`,
    };
  }

  // ── files（from captured worktree output; structured records）──
  const files = { added: [], modified: [], deleted: [] };
  for (const n of nodes) {
    const out = n.worktreeIdentity?.output;
    if (!out || !Array.isArray(out.files)) continue;
    for (const f of out.files) {
      const st = f?.status ?? "";
      for (const p of statusRecordPaths(f)) {
        if (st === "??" || st.startsWith("A")) { if (!files.added.includes(p)) files.added.push(p); }
        else if (st.startsWith("D")) { if (!files.deleted.includes(p)) files.deleted.push(p); }
        else if (p) { if (!files.modified.includes(p)) files.modified.push(p); }
      }
    }
  }

  // ── FM-3 inventory model: baseline / delta provenance ──────────────────
  // The closeout contract's machine-captured baseline snapshot（captured at
  // card START, persisted in closeout-state）is the authoritative
  // `pre-existing dirty` boundary. The current-card touched paths are the
  // DELTA（final dirty − baseline）— never the whole final dirty tree, so
  // pre-existing dirty paths can never be misclassified as current-card
  // implementation（R3）. The bundle renders the baseline + delta explicitly
  // and the validator cross-checks them against the final dirty state, the
  // authorized scope and CARD_IMPLEMENTATION_FILES（single repo-diff truth;
  // no second independent diff is ever introduced）.
  //
  // TA-2（V2）: when the baseline is present, the §9 ADDED / MODIFIED /
  // DELETED lists AND the Diff Summary are DERIVED from this same machine
  // delta（classifyDeltaFromFacts over collectRepoFacts(baseline)）— the
  // worktree-output derivation below is superseded for delta-v1 cards so no
  // independent second derivation can diverge（NEG14）.
  let inventory = null;
  if (closeout?.baseline) {
    if (closeout.baseline.schema !== CARD_INVENTORY_BASELINE_SCHEMA || !Array.isArray(closeout.baseline.dirtyPaths)) {
      throw new Error("card_inventory_baseline_invalid:expected_" + CARD_INVENTORY_BASELINE_SCHEMA);
    }
    let repoFactsForInventory = null;
    try {
      repoFactsForInventory = collectRepoFacts(repoPath ?? cwd ?? ".", { baseline: closeout.baseline });
    } catch { /* leave null — the gate re-derives authoritative facts */ }
    if (repoFactsForInventory) {
      const baselineDirtyPaths = [...new Set(closeout.baseline.dirtyPaths.filter((p) => typeof p === "string" && p.length > 0))];
      // TA-2（V2）: single machine delta truth — ADDED/MODIFIED/DELETED and
      // the Diff Summary all derive from classifyDeltaFromFacts(repoFacts).
      const cls = classifyDeltaFromFacts(repoFactsForInventory);
      // TA-2R（content-v1）: per-delta-path attribution kinds with the
      // card-start -> closeout content shas（machine proof for pre-existing
      // dirty files the card modified — finding 2 / NEG17）.
      const clsSet = {
        added: new Set(cls.added),
        modified: new Set(cls.modified),
        deleted: new Set(cls.deleted),
      };
      const baselineShas = closeout.baseline.pathShas && typeof closeout.baseline.pathShas === "object" ? closeout.baseline.pathShas : {};
      const finalShas = repoFactsForInventory.pathShas ?? {};
      const deltaKinds = repoFactsForInventory.deltaPaths.map((p) => {
        if (clsSet.deleted.has(p)) {
          return { path: p, kind: "DELETED", baselineSha: baselineShas[p] ?? null, finalSha: null };
        }
        if (clsSet.modified.has(p)) {
          return { path: p, kind: "MODIFIED", baselineSha: baselineShas[p] ?? null, finalSha: finalShas[p] ?? null };
        }
        return { path: p, kind: "ADDED", baselineSha: null, finalSha: null };
      });
      inventory = {
        model: CARD_INVENTORY_MODEL,
        attribution: closeout.inventoryAttribution ?? closeout.baseline.attributionModel ?? "membership-v1",
        baseline: {
          head: closeout.baseline.head ?? null,
          treeSha: closeout.baseline.treeSha ?? null,
          dirtyDigest: closeout.baseline.dirtyDigest ?? null,
          contentDigest: closeout.baseline.contentDigest ?? null,
          dirtyPaths: baselineDirtyPaths,
          // TA-2R content-v1: card-start content identity travels with the
          // source so the closeout GATE's authoritative collectRepoFacts can
          // re-derive the content-aware delta（single truth）and fail closed
          // on unattributable paths. Only the digest renders in the bundle.
          pathShas: closeout.baseline.pathShas ?? null,
        },
        deltaPaths: repoFactsForInventory.deltaPaths,
        deltaKinds,
        unattributable: repoFactsForInventory.unattributable ?? [],
      };
      // the baseline is the AUTHORITATIVE pre-existing dirty set（R3）— it
      // overrides any card-declared preExistingDirty claim.
      files.preExistingDirty = baselineDirtyPaths;
      files.added = cls.added;
      files.modified = cls.modified;
      files.deleted = cls.deleted;
    }
  }

  // ── repair attempts（structured lifecycle attempts）──
  const repairAttempts = [];
  for (const tx of transitions) {
    const n = nodes.find((x) => x.nodeId === tx.phaseId);
    const taskType = n?.taskType ?? tx.phaseId ?? "unknown";
    const consumed = Number(tx.attempt ?? 0);
    if (consumed > 0) {
      for (let a = 0; a < consumed; a++) {
        repairAttempts.push({ attempt: a, taskType: `${taskType} (repair)`, status: "REPAIR", resultIdentity: `graph:${executionId}:${tx.phaseId}:repair:${a}` });
      }
      repairAttempts.push({ attempt: consumed, taskType: `${taskType} (repair)`, status: n?.final === "PASS" ? "PASS" : (n?.final ?? "HOLD"), resultIdentity: `graph:${executionId}:${tx.phaseId}:attempt:${consumed}` });
    }
  }
  // REPAIR_BUDGET_USED counts REPAIR iterations consumed（REPAIR-status
  // attempts）— the final PASS attempt is NOT a repair. Invariant:
  // REPAIR_BUDGET_USED <= REPAIR_BUDGET_MAX（enforced by the validator; a
  // bundle over budget is not a valid closeout）. attempt history stays the
  // full attempt list（REPAIR + final PASS）above.
  //
  // TA-2R（closeout-accounting / HOLD TA2R_REPAIR_LINEAGE_ACCOUNTING_NOT_
  // CUMULATIVE）: machine-readable generation classification + CUMULATIVE
  // repair budget across the authoritative supersede lineage. REPAIR_BUDGET_USED
  // = in-graph REPAIR attempts + cumulative repair-iteration generations（a
  // generation that supersedes a REPAIR/HOLD-reviewed bundle is a
  // repair-iteration only when it performs substantive task repair; a
  // surface-reseal adds +0）. The control plane can never observe a later
  // generation re-reporting USED=1/MAX=1 after an earlier repair already
  // consumed the budget — the count accumulates from the superseded bundle's
  // own lineage（read from its §14; legacy bundles infer one repair from a
  // superseding-repair attempt / USED≥1）. A surface-reseal renders
  // RESEAL_TOUCHED_PATHS（declared ∪ machine-derived from the attribution
  // diff vs the superseded bundle）and the validator enforces the governance-
  // scope contract（no substantive implementation touch; independent recompute
  // from the two bundles' section-9 attributions）.
  const supersedeChain = closeout?.supersedes ?? null;
  const generationType = closeout?.generationType ?? (supersedeChain ? "repair-iteration" : "implementation");
  const inGraphRepairs = repairAttempts.filter((a) => a.status === "REPAIR").length;
  let prevLineage = { generationType: null, budgetUsed: 0, repairIterations: 0, surfaceReseals: 0, hasSupersedingRepairAttempt: false };
  let prevAttribution = new Map();
  const supPath = supersedeChain?.bundlePath ?? null;
  if (supPath && existsSync(supPath)) {
    try {
      const supText = readFileSync(supPath, "utf8");
      prevLineage = { ...prevLineage, ...parseRepairLineage(supText) };
      prevAttribution = parseDeltaAttribution(supText);
    } catch { /* best-effort — lineage falls back to defaults */ }
  }
  const prevIterations = Math.max(
    prevLineage.repairIterations ?? 0,
    prevLineage.hasSupersedingRepairAttempt ? 1 : 0,
    (prevLineage.budgetUsed ?? 0) >= 1 ? 1 : 0,
  );
  const prevReseals = prevLineage.surfaceReseals ?? 0;
  const repairIterations = prevIterations + (generationType === "repair-iteration" ? 1 : 0);
  const surfaceReseals = prevReseals + (generationType === "surface-reseal" ? 1 : 0);
  if (generationType === "repair-iteration") {
    repairAttempts.push({
      attempt: repairAttempts.length,
      taskType: "external-review-superseding-repair",
      status: "REPAIR",
      resultIdentity: `external-review:${supersedeChain?.reviewBundleIdentity ?? "unknown"}:REPAIR`,
    });
  } else if (generationType === "surface-reseal") {
    repairAttempts.push({
      attempt: repairAttempts.length,
      taskType: "surface-reseal",
      status: "RESEAL",
      resultIdentity: `surface-reseal:${supersedeChain?.reviewBundleIdentity ?? "unknown"}:${supersedeChain?.verdict ?? "unknown"}`,
    });
  }
  const repairsUsed = inGraphRepairs + repairIterations;
  // reseal touch set（declared ∪ machine-derived attribution diff）— rendered
  // in §14 so the reviewer and the validator can machine-check the scope.
  const resealTouchedPaths = [];
  if (generationType === "surface-reseal") {
    for (const p of Array.isArray(closeout?.resealTouchedPaths) ? closeout.resealTouchedPaths : []) {
      if (typeof p === "string" && !resealTouchedPaths.includes(p)) resealTouchedPaths.push(p);
    }
    for (const k of inventory?.deltaKinds ?? []) {
      if (typeof k?.path !== "string") continue;
      const prev = prevAttribution.get(k.path);
      let touched = false;
      if (k.kind === "MODIFIED") {
        const end12 = k.finalSha ? String(k.finalSha).slice(0, 12) : null;
        touched = !prev || prev.kind !== "MODIFIED" || (prev.endSha12 && end12 && prev.endSha12 !== end12);
      } else if (k.kind === "ADDED" || k.kind === "DELETED") {
        touched = !prev;
      }
      if (touched && !resealTouchedPaths.includes(k.path)) resealTouchedPaths.push(k.path);
    }
    resealTouchedPaths.sort();
  }

  const diffSummary = firstDefined(
    closeout?.diffSummary,
    allNodesPassed
      ? `Graph ${executionId}: ${nodes.length} node(s) all PASS; ${files.added.length} added / ${files.modified.length} modified / ${files.deleted.length} deleted (worktree outputs)`
      : `Graph ${executionId}: final ${graphFinal} (${vgr.reason ?? ""})`,
  );

  return {
    schema: REVIEW_BUNDLE_SOURCE_SCHEMA,
    task: {
      cardId: closeout?.cardId ?? executionId ?? "UNKNOWN-CARD",
      cardTitle: closeout?.cardTitle ?? "Graph card closeout",
      cardType: closeout?.cardType ?? "implementation",
    },
    // TA-2（U）: the admission decision that governed this graph is recorded
    // in the bundle（admission_id + size + risk + profile + capability sets +
    // reasons）— self-contained, no chat dependence.
    admission: vgr.admission
      ? {
          schema: vgr.admission.schema ?? "autoloop.task-admission/v1",
          task_id: vgr.admission.task_id ?? null,
          admission_id: vgr.admission.admission_id ?? null,
          size: vgr.admission.size ?? null,
          risk: vgr.admission.risk ?? null,
          profile: vgr.admission.profile ?? null,
          repair_budget: vgr.admission.repair_budget ?? null,
          evidence_policy: vgr.admission.evidence_policy ?? null,
          external_review_required: vgr.admission.review_policy?.external_review_required ?? null,
          capabilities: vgr.admission.capabilities ?? null,
          reasons: vgr.admission.reasons ?? null,
          review_surface_policy: vgr.admission.review_surface_policy ?? null,
        }
      : null,
    graph: {
      graphRunId: executionId,
      nodeId: nodes.map((n) => n.nodeId).join(", "),
      phaseExecutionId: nodes.map((n) => n.phaseExecutionId).filter(Boolean).join(", "),
      stageIds: [...new Set((transitions.flatMap((tx) => tx.lifecycleTransitions ?? []).map((t) => t.phase)).filter(Boolean))],
      agentExecutionIds: [...new Set(nodes.map((n) => n.subagentEnvelope?.agentExecutionId).filter(Boolean))],
    },
    repo: {},
    objective: closeout?.objective ?? "Graph card closeout via the generic Graph runner",
    executiveStatus: graphFinal,
    executiveSummary: firstDefined(
      closeout?.executiveSummary,
      aggregateContradiction
        ? `${nodes.length} node(s) in ${executionId}; graph final ${graphFinal}; R-12 aggregate/child contradiction fenced: ${aggregateContradiction.slice(0, 200)}`
        : `${nodes.length} node(s) in ${executionId}; graph final ${graphFinal}; closeout gate ${vgr.closeout?.final ?? "pending"}`,
    ),
    authorizedScope: Array.isArray(closeout?.authorizedScope) ? closeout.authorizedScope.slice() : [],
    unauthorizedScope: Array.isArray(closeout?.unauthorizedScope) ? closeout.unauthorizedScope.slice() : [],
    designDecisions: Array.isArray(closeout?.designDecisions) ? closeout.designDecisions.slice() : [],
    // RB-1H/CBM-2R: card-level inventory categories merge over the
    // worktree-derived added/modified/deleted（never误算 whole-dirty as card
    // changes; never hide the card's real implementation scope）.
    files: {
      ...(closeout?.cardFiles ?? {}),
      ...files,
    },
    // FM-3: structured authorization exceptions（R2）— a path may leave the
    // authorized scope ONLY with an explicit {path, reason} record, never
    // free-text justification alone. Rendered for the reviewer and enforced
    // by the validator.
    authorizationExceptions: Array.isArray(closeout?.authorizationExceptions) ? closeout.authorizationExceptions.slice() : [],
    inventory,
    diffSummary,
    execution: {
      nodesExecuted: testsExecuted,
      testsExecuted,
      nodeResults: { passed: nodesPassed, failed: nodesFailed, total: nodes.length },
      embeddedTestResults: testsTotal > 0 ? { passed: testsPassed, failed: testsFailed, total: testsTotal } : null,
      pass: allNodesPassed,
    },
    verifier: {
      pass: graphFinal === "PASS",
      result: graphFinal,
      summary: `scheduler verdict ${vgr.scheduler?.verdict ?? graphFinal}; join: ${nodes.map((n) => `${n.nodeId}:${n.final}`).join(" -> ")}`,
    },
    review,
    repairAttempts,
    // Repair-budget authority（HOLD AUTH1_PROMOTION_BLOCKED_BY_REPAIR_BUDGET_
    // AUTHORITY_DRIFT）: REPAIR_BUDGET_MAX must NEVER expand across a
    // successor generation. A successor（supersedeChain present）inherits
    // the predecessor's max（read from its §14 lineage）and IGNORES any
    // caller-supplied repairBudgetMaxAttempts — the caller may not increase
    // the budget, only match it. Only a FIRST generation（no predecessor）
    // takes the caller-declared max. This makes MAX immutable across the
    // authorized repair lineage; exhaustion must fail closed into
    // HOLD/escalation（validator: repair_budget_used_exceeds_max /
    // repair_lineage_cumulative_exceeds_max; review-unit gate:
    // REVIEW_UNIT_LIMIT_EXCEEDED）. Extra budget requires a distinct explicit
    // authority transition — never a successor self-increase.
    repairBudget: {
      maxAttempts: supersedeChain
        ? Math.min(prevLineage.budgetMax ?? Infinity, closeout?.repairBudgetMaxAttempts ?? Infinity)
        : (closeout?.repairBudgetMaxAttempts ?? 1),
      used: repairsUsed,
    },
    repairLineage: {
      generationType,
      repairIterations,
      surfaceReseals,
      resealTouchedPaths,
    },
    // RB-1G: the bundle source carries the external review delivery contract
    //（delivery required + current status at generation + supersede binding）.
    externalReview: {
      deliveryRequired: closeout?.requiresReview === true,
      status: closeout?.externalReviewStatus ?? "AWAITING_EXTERNAL_REVIEW",
      supersedes: closeout?.supersedes ?? null,
    },
    negativeCases: Array.isArray(closeout?.negativeCases) ? closeout.negativeCases.slice() : [],
    regression: Array.isArray(closeout?.regression) ? closeout.regression.slice() : [],
    // TA-3: the structured budget enforcement result（envelope + ledger +
    // reconciliation）travels into the bundle as section 5.5 evidence.
    budget: vgr.budget ?? null,
    regressionSummary: firstDefined(closeout?.regressionSummary, "see card evidence"),
    evidence: evidence.map((e) => ({ path: e.path, sha256: e.sha256 })),
    security: {
      secretScanResult: "clean",
      ingestionAllowlist: ["structured graph node results", "review-agent results", "lifecycle transitions", "closeout evidence snapshot"],
      ingestionDenylist: ["secrets/credentials/private keys/logs/db contents/user data", "unvalidated free-text stdout"],
    },
    risks: Array.isArray(closeout?.risks) ? closeout.risks.slice() : [],
    limitations: Array.isArray(closeout?.limitations) ? closeout.limitations.slice() : [],
    rollbackProcedure: firstDefined(closeout?.rollbackProcedure, "Worktree outputs are revocable; re-run the graph closeout gate to regenerate the bundle."),
    openQuestions: Array.isArray(closeout?.openQuestions) ? closeout.openQuestions.slice() : [],
    recommendedNextStep: closeout?.recommendedNextStep ?? null,
  };
}

/**
 * MANDATORY card-level closeout for Graph cards. Applicability is decided by
 * the STRUCTURED `closeout.requiresReview === true` flag — never by parsing
 * free-text stdout. Returns `{ applied: false }` for cards that do not
 * require external review（internal nodes keep node-level interim PASS only）.
 */
export async function runMandatoryGraphCloseout({
  graphResult,
  closeout,
  repoPath,
  cwd,
  outDir,
  timeoutMs = 30000,
  fileName,
  gate = runCloseoutGate,
  sourceBuilder = buildGraphCloseoutSource,
  evidenceWriter = writeGraphCloseoutEvidence,
} = {}) {
  // Applicability contract（structured field only）.
  if (!closeout || closeout.requiresReview !== true) {
    return { applied: false, final: null, holdCode: null, reason: "closeout_not_required" };
  }
  // TA-2（V1）— post-FM-3 card-start baseline gate（fail-closed before any
  // evidence / source work）.
  const baselineGate = assertCardStartBaseline({ closeout });
  if (!baselineGate.ok) {
    return { applied: true, final: "HOLD", holdCode: baselineGate.holdCode ?? "CARD_START_BASELINE_MISSING", reason: baselineGate.reason };
  }
  const dir = outDir ?? closeout.outDir;
  if (!dir) {
    return { applied: true, final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:closeout_out_dir_absent" };
  }
  if (!graphResult) {
    return { applied: true, final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:graph_result_absent" };
  }

  // VCA-1 W1A (S6) — test:colima-all scope gate: a closeout claiming a full
  // colima-all run for a card whose own files do not touch the runtime
  // surface fails closed（substitute = ta-line V17 set）.
  const colimaGate = assertColimaAllClaims({ closeout });
  if (!colimaGate.ok) {
    return { applied: true, final: "HOLD", holdCode: colimaGate.holdCode, reason: colimaGate.reason };
  }

  // VCA-1 W1A (S9) — one authoritative bundle per generation. The closeout
  // gate never BLOCKS a re-closeout（delivery retries re-render with the
  // same deterministic identity; HOLD->fix->re-run must stay possible）;
  // instead, after a VALID render the closeout retires other same-generation
  // authoritative bundles to .superseded/ so exactly ONE remains
  // authoritative. repair / supersede generations（a different supersedes
  // target）are the explicit exception and accumulate as a chain.
  //（assertAuthoritativeBundle / BUNDLE_AUTHORITY_HOLDS remain exported for
  // callers that want the idempotency decision up front.）

  // 1) durable evidence snapshot（closeout-layer written; tool-hashed）.
  let evidence;
  try {
    const w = await withTimeout(Promise.resolve().then(() => evidenceWriter({ graphResult, closeout, outDir: dir })), timeoutMs, "review_bundle_evidence");
    if (!w.ok) {
      return { applied: true, final: "HOLD", holdCode: w.holdCode ?? REVIEW_BUNDLE_HOLDS.GENERATION_FAILED, reason: w.reason ?? "REVIEW_BUNDLE_GENERATION_FAILED:evidence" };
    }
    evidence = w;
  } catch (e) {
    return { applied: true, final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.GENERATION_FAILED, reason: `REVIEW_BUNDLE_GENERATION_FAILED:evidence:${String(e?.message ?? e).slice(0, 300)}` };
  }

  // 2) structured source（never trusts writer claims）.
  let source;
  try {
    source = await withTimeout(
      Promise.resolve().then(() => sourceBuilder({ graphResult, closeout, repoPath, cwd, evidence: [{ path: evidence.path, sha256: evidence.sha256 }] })),
      timeoutMs,
      "review_bundle_source",
    );
  } catch (e) {
    return { applied: true, final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.GENERATION_FAILED, reason: `REVIEW_BUNDLE_GENERATION_FAILED:source:${String(e?.message ?? e).slice(0, 300)}` };
  }

  // 3) the SAME single closeout gate as CLI / backfill（generate -> pre-write
  //    secret scan -> atomic write -> independent validation -> verdict; RB-1G
  //    delivery state attached by the gate）.
  try {
    const result = await withTimeout(
      gate({
        source,
        repoPath,
        outDir: dir,
        // AUTOLOOP-P4: the declared task success contract（frozen in the
        // closeout-state record / closeout contract pre-execution）is
        // forwarded into THE PASS ORACLE. The executor cannot weaken it at
        // gate time — it arrives from persisted state, not caller output.
        successContract: closeout?.successContract ?? graphResult?.successContract ?? null,
        timeoutMs,
        fileName,
        // RB2-B2: this IS the formal Review closeout boundary（applicability
        // already requires closeout.requiresReview === true）— delivery is
        // mandatory at the gate regardless of the source's derived
        // deliveryRequired flag.
        formal: true,
        // RB-1G external review bundle delivery options（forwarded from the
        // card closeout contract）:
        deliver: closeout?.deliver ?? undefined,
        deliveryMethod: closeout?.deliveryMethod ?? null,
        supersedes: closeout?.supersedes ?? null,
        agentIdentity: closeout?.agentIdentity ?? null,
        surfaceDir: closeout?.surfaceDir ?? null,
      }),
      timeoutMs,
      "review_bundle_gate",
    );

    // VCA-1 W1A (S9) — retire other same-generation authoritative bundles
    // after a VALID render（PASS or AWAITING_BUNDLE_DELIVERY both carry a
    // validated bundle）. An invalid/HOLD render never displaces the
    // previous authoritative bundle.
    if (result.bundlePath && existsSync(result.bundlePath)
      && (result.final === "PASS" || result.final === "AWAITING_BUNDLE_DELIVERY")) {
      try {
        const newKey = generationKeyFromBundleText(readFileSync(result.bundlePath, "utf8"));
        const peers = scanAuthoritativeBundles(dir, { cardId: closeout.cardId })
          .filter((b) => b.path !== result.bundlePath
            && (b.supersededIdentity ?? null) === (newKey.supersededIdentity ?? null));
        if (peers.length) {
          const retired = retireAuthoritativeBundles(dir, peers);
          console.error(`VCA-1 W1A (S9): retired ${retired.length} same-generation bundle(s) -> .superseded/: ${retired.join(", ")}`);
        }
      } catch { /* never let S9 bookkeeping turn a valid closeout into a failure */ }
    }

    return { applied: true, ...result };
  } catch (e) {
    return { applied: true, final: "HOLD", holdCode: REVIEW_BUNDLE_HOLDS.GENERATION_FAILED, reason: `REVIEW_BUNDLE_GENERATION_FAILED:gate:${String(e?.message ?? e).slice(0, 300)}` };
  }
}

export { sha256Text };

// ---------------------------------------------------------------------------
// RB2 — MANDATORY REVIEW-BUNDLE CLOSEOUT ENFORCEMENT CONVERGENCE.
// ---------------------------------------------------------------------------
//
// CP-2 exposed a mechanical bypass: an implementation path could report a
// PASS-style closeout while no canonical durable review bundle existed. The
// seam was the closeout-state idempotency path trusting a caller-controlled
// `closeout.final` field. These functions close that seam:
//   verifyAppliedCloseoutBundle — re-derive the durable invariant（a real
//     canonical bundle must exist, validate, match the recorded identity/sha
//     and, when a repoPath is supplied, still bind the current HEAD/tree）
//   assertFinalCardCloseout   — the FINAL card closeout bar（invariant #2）:
//     independent review must be ACCEPTED（verdict PASS bound to the bundle）
//     before the card may be treated as closed/closeout-eligible.

/**
 * Verify that a recorded APPLIED PASS disposition is backed by a real,
 * durable canonical bundle. Fail-closed: a caller-controlled closeout.final
 * field（or a stale/superseded/mismatched bundle）cannot mint an
 * implementation closeout PASS.
 *
 * @returns {{ ok: true, path, identity, sha256 } | { ok: false, holdCode,
 *           reason }}
 */
export function verifyAppliedCloseoutBundle({ outDir = null, closeout = null, cardId = null, repoPath = null } = {}) {
  if (!outDir) {
    return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:closeout_out_dir_absent" };
  }
  if (!closeout || typeof closeout !== "object" || Array.isArray(closeout)) {
    return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:closeout_disposition_absent" };
  }
  const identity = closeout.bundleIdentity ?? null;
  if (typeof identity !== "string" || !/^[0-9a-f]{64}$/.test(identity)) {
    return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:recorded_bundle_identity_absent_or_malformed" };
  }
  // RB2R1 (BLOCKER 2): the recorded canonical bundle SHA is a MANDATORY
  // authority binding for a review-required closeout. Missing/malformed SHA
  // is HOLD — a reconstructed/inferred SHA must never silently substitute
  // for missing persisted authority.
  const recordedSha = closeout.bundleSha256 ?? null;
  if (typeof recordedSha !== "string" || !/^[0-9a-f]{64}$/.test(recordedSha)) {
    return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:recorded_bundle_sha256_absent_or_malformed" };
  }
  const bundles = scanAuthoritativeBundles(outDir, { cardId });
  const match = bundles.find((b) => b.identity === identity);
  if (!match) {
    return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.MISSING, reason: "REVIEW_BUNDLE_MISSING:no_authoritative_bundle_matches_recorded_identity" };
  }
  const validation = validateReviewBundle(match.path, { authorizedDir: outDir, expected: { taskId: cardId ?? undefined } });
  if (!validation.ok) {
    return { ok: false, holdCode: validation.holdCode ?? REVIEW_BUNDLE_HOLDS.INVALID, reason: `${validation.holdCode ?? "REVIEW_BUNDLE_INVALID"}:${validation.errors.join(";").slice(0, 400)}` };
  }
  const sha = bundleContentSha256(match.path);
  if (sha !== recordedSha) {
    return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, reason: "REVIEW_BUNDLE_IDENTITY_MISMATCH:bundle_sha256_mismatch_with_recorded_disposition" };
  }
  // RB2R1 (BLOCKER 3): live repository binding FAILS CLOSED. When a repoPath
  // is supplied（current HEAD/tree/implementation binding required）, any
  // inability to establish live repository truth is itself a HOLD — never a
  // catch-and-ignore of an authority/provenance check. Optional diagnostics
  // may degrade gracefully; authoritative binding checks may not.
  if (repoPath) {
    let facts;
    try {
      facts = collectRepoFacts(repoPath);
    } catch (e) {
      return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, reason: `REVIEW_BUNDLE_IDENTITY_MISMATCH:live_repository_unavailable:${String(e?.message ?? e).slice(0, 200)}` };
    }
    if (!facts?.head || !facts?.treeSha) {
      return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, reason: "REVIEW_BUNDLE_IDENTITY_MISMATCH:live_repository_head_or_tree_unavailable" };
    }
    const text = readFileSync(match.path, "utf8");
    const boundHead = text.match(/^HEAD:\s*(.+)$/m)?.[1]?.trim() ?? null;
    const boundTree = text.match(/^TREE_SHA:\s*(.+)$/m)?.[1]?.trim() ?? null;
    if (!boundHead || !boundTree) {
      return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, reason: "REVIEW_BUNDLE_IDENTITY_MISMATCH:bundle_head_or_tree_binding_missing" };
    }
    if (boundHead !== facts.head) {
      return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, reason: `REVIEW_BUNDLE_IDENTITY_MISMATCH:stale_implementation_head:${boundHead.slice(0, 12)} != ${facts.head.slice(0, 12)}` };
    }
    if (boundTree !== facts.treeSha) {
      return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, reason: `REVIEW_BUNDLE_IDENTITY_MISMATCH:stale_implementation_tree:${boundTree.slice(0, 12)} != ${facts.treeSha.slice(0, 12)}` };
    }
    // RB2R1 (WORKING-TREE MUTATION BINDING): HEAD/tree equality is NOT enough.
    // The bundle records the repo's FINAL_DIRTY_DIGEST（tracked + staged +
    // untracked working-tree state）at generation time; the current working
    // tree must still match it. A tracked/staged/untracked mutation after
    // bundle/review therefore FAILS CLOSED even when HEAD has not moved.
    const boundDirty = text.match(/^FINAL_DIRTY_DIGEST:\s*(.+)$/m)?.[1]?.trim() ?? null;
    if (boundDirty && facts.finalDirtyDigest && boundDirty !== facts.finalDirtyDigest) {
      return { ok: false, holdCode: REVIEW_BUNDLE_HOLDS.IDENTITY_MISMATCH, reason: `REVIEW_BUNDLE_IDENTITY_MISMATCH:working_tree_mutated:${boundDirty.slice(0, 24)} != ${facts.finalDirtyDigest.slice(0, 24)}` };
    }
  }
  return { ok: true, path: match.path, identity: match.identity, sha256: sha };
}

/**
 * RB2R2 — resolve the AUTHORITATIVE external-review record for a card's
 * canonical bundle. The authority record is the persisted
 * autoloop.external-review-delivery/v2 record on the FIXED review surface
 * （Current/delivery.json）— the canonical reviewer-facing durable surface.
 * There is NO fallback source and NO caller-supplied record parameter:
 *   - a missing / unreadable / malformed surface record is FAIL-CLOSED;
 *   - a card-mismatched / bundle-mismatched surface record is FAIL-CLOSED;
 *   - outDir external-review-delivery-*.json files are SENDER-SIDE evidence
 *     only and are NEVER authority（canonical surface only）.
 */
export function resolveAuthoritativeExternalReviewRecord({ cardId = null, bundleIdentity = null, surfaceDir = null } = {}) {
  const dir = resolve(surfaceDir ?? externalReviewSurfaceDir());
  const deliveryPath = join(dir, "delivery.json");
  if (!existsSync(deliveryPath)) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE, reason: "EXTERNAL_REVIEW_NOT_COMPLETE:surface_delivery_record_missing", record: null };
  }
  const rec = readExternalReviewDeliveryRecord(deliveryPath);
  if (!rec.ok) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE, reason: `EXTERNAL_REVIEW_NOT_COMPLETE:surface_delivery_record_invalid:${rec.errors.join(";")}`, record: null };
  }
  if (cardId && rec.cardId && rec.cardId !== cardId) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE, reason: `EXTERNAL_REVIEW_STALE_BUNDLE:surface_card_mismatch:${rec.cardId}!=${cardId}`, record: null };
  }
  if (bundleIdentity && rec.state?.delivery?.reviewBundleIdentity && rec.state.delivery.reviewBundleIdentity !== bundleIdentity) {
    return { ok: false, holdCode: EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE, reason: "EXTERNAL_REVIEW_STALE_BUNDLE:surface_delivery_identity_mismatch", record: null };
  }
  return { ok: true, record: rec, source: "surface" };
}

/**
 * RB2R2 invariant #2 — FINAL card closeout requires an ACCEPTED independent
 * review verdict bound to the canonical bundle, read from the AUTHORITATIVE
 * external-review record on the canonical review surface. The record is
 * loaded HERE from disk — there is NO caller-supplied externalReviewRecord
 * parameter（RB2R2 REMOVE CALLER AUTHORITY）. Persisted
 * `externalReviewStatus` / `verdict` fields on a caller-controlled closeout
 * object are evidence only and cannot mint review acceptance.
 *
 * Returns ok:true ONLY when ALL of:
 *   - the canonical bundle still exists + validates + recorded identity AND
 *     recorded sha256 are both present and match（verifyAppliedCloseoutBundle）
 *   - the authoritative record's externalReviewStatus is PASS
 *   - the record's verdict is PASS, bound to the EXACT bundle identity + sha
 *   - reviewer identity is present, is not `agent:` self, and is not the
 *     implementer（independent reviewer != implementer）
 *   - reviewedAt is a real timestamp
 *   - the record's own delivery binding matches the bundle
 * Anything else（PENDING / REPAIR / HOLD / missing record / self-review /
 * unbound PASS）is NOT final-closeout-eligible and FAILS CLOSED.
 */
export function assertFinalCardCloseout({
  closeout = null,
  outDir = null,
  cardId = null,
  repoPath = null,
  surfaceDir = null,
  agentIdentity = null,
  implementerIdentity = null,
} = {}) {
  const bundleCheck = verifyAppliedCloseoutBundle({ outDir, closeout, cardId, repoPath });
  if (!bundleCheck.ok) {
    return { ok: false, stage: "IMPLEMENTATION_COMPLETE", holdCode: bundleCheck.holdCode, reason: bundleCheck.reason };
  }

  // RB2R2 — REMOVE CALLER AUTHORITY. The final gate loads the authoritative
  // record itself from the canonical review surface. There is NO
  // externalReviewRecord parameter: caller-supplied review-shaped data can
  // never substitute for the durable delivery record.
  const resolved = resolveAuthoritativeExternalReviewRecord({
    cardId,
    bundleIdentity: bundleCheck.identity,
    surfaceDir,
  });
  if (!resolved.ok) {
    return { ok: false, stage: "REVIEW_BUNDLE_READY", holdCode: resolved.holdCode, reason: resolved.reason };
  }
  const record = resolved.record;
  const recordSource = resolved.source;

  const state = record?.state ?? null;
  const delivery = state?.delivery ?? null;
  const verdict = state?.verdict ?? null;
  const implementer = implementerIdentity ?? agentIdentity ?? closeout?.agentIdentity ?? null;
  if (state?.externalReviewStatus !== "PASS") {
    return { ok: false, stage: "REVIEW_BUNDLE_READY", holdCode: EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE, reason: "EXTERNAL_REVIEW_NOT_COMPLETE:authoritative_review_record_not_pass" };
  }
  if (!verdict || verdict.verdict !== "PASS") {
    return { ok: false, stage: "REVIEW_BUNDLE_READY", holdCode: EXTERNAL_REVIEW_HOLDS.INVALID_VERDICT, reason: "EXTERNAL_REVIEW_INVALID_VERDICT:final closeout requires a bound PASS verdict" };
  }
  const reviewer = verdict.reviewerIdentity ?? null;
  if (!reviewer || typeof reviewer !== "string" || reviewer.length === 0) {
    return { ok: false, stage: "REVIEW_BUNDLE_READY", holdCode: EXTERNAL_REVIEW_HOLDS.INVALID_VERDICT, reason: "EXTERNAL_REVIEW_INVALID_VERDICT:reviewer_identity_required" };
  }
  if (/^agent:/i.test(reviewer)) {
    return { ok: false, stage: "REVIEW_BUNDLE_READY", holdCode: EXTERNAL_REVIEW_HOLDS.SELF_DECLARED, reason: "EXTERNAL_REVIEW_SELF_DECLARED:reviewer_is_agent_self" };
  }
  if (implementer && reviewer === implementer) {
    return { ok: false, stage: "REVIEW_BUNDLE_READY", holdCode: EXTERNAL_REVIEW_HOLDS.SELF_DECLARED, reason: `EXTERNAL_REVIEW_SELF_DECLARED:reviewer_equals_implementer:${reviewer}` };
  }
  const reviewedAt = verdict.reviewedAt ?? null;
  if (!reviewedAt || Number.isNaN(Date.parse(reviewedAt))) {
    return { ok: false, stage: "REVIEW_BUNDLE_READY", holdCode: EXTERNAL_REVIEW_HOLDS.INVALID_VERDICT, reason: "EXTERNAL_REVIEW_INVALID_VERDICT:reviewed_at_required" };
  }
  if (verdict.bundleIdentity !== bundleCheck.identity || verdict.bundleSha256 !== bundleCheck.sha256) {
    return { ok: false, stage: "REVIEW_BUNDLE_READY", holdCode: EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE, reason: "EXTERNAL_REVIEW_STALE_BUNDLE:verdict bound to a different bundle identity/sha" };
  }
  if (delivery?.reviewBundleIdentity !== bundleCheck.identity || delivery?.reviewBundleSha256 !== bundleCheck.sha256) {
    return { ok: false, stage: "REVIEW_BUNDLE_READY", holdCode: EXTERNAL_REVIEW_HOLDS.STALE_BUNDLE, reason: "EXTERNAL_REVIEW_STALE_BUNDLE:delivery record bound to a different bundle identity/sha" };
  }
  let p4Head = null;
  let p4Tree = null;
  if (repoPath) {
    try {
      const p4Facts = collectRepoFacts(repoPath);
      p4Head = p4Facts?.head ?? null;
      p4Tree = p4Facts?.treeSha ?? null;
    } catch { /* verifyAppliedCloseoutBundle already failed closed on live-repo unavailability */ }
  }
  // POST-P4 Truth Revocation Cascade — the FINAL acceptance bar re-derives
  // revocation facts from the durable ledger itself（red-team finding: this
  // second oracle call previously ignored revocations and could re-mint a
  // CURRENT CLOSED/PASS over revoked truth）. Authority-level revocations
  // fence by producer identity, covering this bar's distinct synthetic
  // evidence ids. Ledger unreadable/corrupt → HOLD（fail-closed）.
  const p4Ledger = readRevocationLedger(revocationLedgerPath(outDir));
  if (!p4Ledger.ok) {
    return { ok: false, stage: "REVIEW_BUNDLE_READY", holdCode: p4Ledger.holdCode ?? "TRUTH_REVOCATION_LEDGER_INVALID", reason: `${p4Ledger.holdCode ?? "TRUTH_REVOCATION_LEDGER_INVALID"}:${p4Ledger.reason ?? "unreadable"}` };
  }
  const p4Now = new Date().toISOString();
  const p4Norm = normalizeSuccessContract({ head: p4Head, treeSha: p4Tree });
  const p4Binding = { head: p4Head, treeSha: p4Tree };
  const p4FinalEvidence = [
    {
      schema: ORACLE_EVIDENCE_SCHEMA, evidenceId: "final-bar:review-bundle-valid", cardId, generation: 0,
      checkId: "review-bundle-valid", kind: "deterministic",
      producer: { identity: "verifyAppliedCloseoutBundle", role: "independent" },
      result: "PASS", at: p4Now, command: "validateReviewBundle+bundle_sha256+head/tree/dirty-binding", binding: p4Binding,
    },
    {
      schema: ORACLE_EVIDENCE_SCHEMA, evidenceId: "final-bar:independent-review", cardId, generation: 0,
      checkId: "independent-review", kind: "semantic",
      producer: { identity: reviewer, role: "independent" },
      result: "PASS", at: reviewedAt, command: "external-review-verdict-bound-to-current-bundle", binding: p4Binding,
    },
  ];
  const p4Oracle = evaluatePassOracle({
    contract: { ok: true, errors: [], contract: { ...p4Norm.contract, cardId, generation: null } },
    evidence: p4FinalEvidence,
    invariants: [],
    revocations: revocationFactsForOracle(computeCascade({ events: p4Ledger.events, evidence: p4FinalEvidence })),
    now: p4Now,
  });
  if (!p4Oracle.pass) {
    return { ok: false, stage: "REVIEW_BUNDLE_READY", holdCode: "PASS_ORACLE_REJECTED", reason: `PASS_ORACLE_REJECTED:${p4Oracle.failures.map((f) => f.code).join(",")}` };
  }
  return { ok: true, stage: "REVIEW_ACCEPTED", bundlePath: bundleCheck.path, reviewerIdentity: reviewer, reviewedAt, source: recordSource };
}

/**
 * RB2R2 — the AUTHORITATIVE closeout stage derivation（I/O-backed）. This is
 * the ONLY place that may return REVIEW_ACCEPTED / CLOSEOUT_ELIGIBLE /
 * CLOSED, because it verifies the underlying facts:
 *   bundle exists + validates + recorded identity/sha match
 *   → the canonical surface delivery record is an accepted independent PASS
 *     bound to the exact bundle（loaded from disk — no caller record）
 *   → (repoPath supplied) current implementation still matches reviewed bytes
 *   → CLOSED only when an actual authoritative closeout/commit/seal operation
 *     is recorded（closeoutRecorded）.
 * Persisted `stage` / `externalReviewStatus` fields are consulted for
 * contradiction reconciliation DOWNWARD only — never to advance state.
 */
export function deriveAuthoritativeCloseoutStage({
  closeout = null,
  outDir = null,
  cardId = null,
  repoPath = null,
  surfaceDir = null,
  agentIdentity = null,
  implementerIdentity = null,
  closeoutRecorded = false,
} = {}) {
  const bundleCheck = verifyAppliedCloseoutBundle({ outDir, closeout, cardId, repoPath });
  if (!bundleCheck.ok) {
    return { ok: false, stage: "IMPLEMENTATION_COMPLETE", holdCode: bundleCheck.holdCode, reason: bundleCheck.reason, bundle: null, review: null };
  }
  // RB2R2 — no caller-supplied review record is forwarded into authority
  // evaluation. assertFinalCardCloseout re-loads the canonical surface
  // record itself; here we only re-resolve that same record to label the
  // descriptive failure stage（never to advance state）.
  const finalCheck = assertFinalCardCloseout({
    closeout, outDir, cardId, repoPath, surfaceDir, agentIdentity, implementerIdentity,
  });
  if (!finalCheck.ok) {
    const resolved = resolveAuthoritativeExternalReviewRecord({ cardId, bundleIdentity: bundleCheck.identity, surfaceDir });
    const status = resolved.ok ? (resolved.record?.state?.externalReviewStatus ?? null) : null;
    let stage = "REVIEW_BUNDLE_READY";
    if (status === "REPAIR" || status === "HOLD") stage = "REVIEW_HOLD";
    else if (status === "PASS") stage = "INDEPENDENT_REVIEW_PENDING";
    return { ok: false, stage, holdCode: finalCheck.holdCode, reason: finalCheck.reason, bundle: bundleCheck, review: resolved.ok ? (resolved.record?.state ?? null) : null };
  }
  const stage = repoPath ? "CLOSEOUT_ELIGIBLE" : "REVIEW_ACCEPTED";
  if (closeoutRecorded && repoPath) {
    return { ok: true, stage: "CLOSED", holdCode: null, reason: null, bundle: bundleCheck, review: finalCheck, source: finalCheck.source };
  }
  return { ok: true, stage, holdCode: null, reason: null, bundle: bundleCheck, review: finalCheck, source: finalCheck.source };
}

// ---------------------------------------------------------------------------
// AUTOLOOP_REPORT_LIFECYCLE_REPAIR_1 — state-driven mandatory closeout
// trigger（FM-1 lifecycle trigger）.
// ---------------------------------------------------------------------------
//
// The SINGLE production entry that turns structured lifecycle state into a
// mandatory closeout. It is wired into the generic Graph runner
// （runColimaGraph, when a closeout-state record is declared）and exposed via
// scripts/gov-closeout-bundle.mjs --state-driven-closeout. It is what makes
// "work completed + review required" deterministically produce the review
// bundle + Current/ delivery WITHOUT a card-specific closeout script and
// WITHOUT any conversation ritual.
//
// Contract:
//   - reads the persisted closeout-state record（fail-closed）
//   - requiresReview !== true        -> { applied: false }（no review work）
//   - already applied with final PASS -> { alreadyApplied: true }（idempotent;
//     never re-generates / re-delivers）
//   - metadata incomplete             -> CLOSEOUT_METADATA_INCOMPLETE
//     （fail-closed; never silent skip, never PASS）
//   - otherwise runs runMandatoryGraphCloseout with the materialized contract
//     and records the disposition back into the state record（atomic）.
//
// Retry semantics（T6）: a non-PASS disposition（AWAITING_BUNDLE_DELIVERY /
// HOLD）is NOT terminal — re-running re-attempts the delivery with the SAME
// deterministic bundle identity; a PASS disposition is terminal and skipped.
// Crash safety（T7）: the bundle identity is deterministic, so a re-run after
// an interrupted process rewrites an identical artifact and delivers exactly
// one trio; the state record is only flipped to APPLIED after the gate ran.

export async function runStateDrivenCloseout({
  statePath,
  graphResult = null,
  graphResultPath = null,
  repoPath,
  cwd,
  outDir = null,
  timeoutMs = 30000,
  fileName,
  gate = runCloseoutGate,
  sourceBuilder = buildGraphCloseoutSource,
  evidenceWriter = writeGraphCloseoutEvidence,
  surfaceDir = null,
  agentIdentity = null,
} = {}) {
  if (!statePath) {
    return { applied: true, final: "HOLD", holdCode: CLOSEOUT_HOLDS.STATE_UNREADABLE, reason: "CLOSEOUT_STATE_UNREADABLE:state_path_absent" };
  }
  const st = readCloseoutState(statePath);
  if (!st.ok) {
    return { applied: true, final: "HOLD", holdCode: CLOSEOUT_HOLDS.STATE_UNREADABLE, reason: `CLOSEOUT_STATE_UNREADABLE:${st.errors.join(";")}` };
  }
  const state = st.state;

  // No review required -> not applicable（never forced to produce a bundle）.
  if (state.requiresReview !== true) {
    return { applied: false, final: null, holdCode: null, reason: "closeout_not_required", statePath };
  }

  // Idempotent: an already-applied PASS closeout is never re-run, BUT the
  // durable invariant is re-verified（RB2 Finding: a caller-controlled
  // closeout.final field must not mint PASS without a canonical bundle on
  // disk）.
  if (state.closeout?.status === "APPLIED" && state.closeout?.final === "PASS") {
    const dir = outDir ?? state.outDir ?? null;
    const bundleCheck = verifyAppliedCloseoutBundle({
      outDir: dir,
      closeout: state.closeout,
      cardId: state.task?.cardId ?? null,
      repoPath: repoPath ?? null,
    });
    if (!bundleCheck.ok) {
      return {
        applied: true,
        final: "HOLD",
        holdCode: bundleCheck.holdCode,
        reason: bundleCheck.reason,
        bundlePath: null,
        bundle: null,
        externalReview: state.closeout?.externalReviewStatus ? { externalReviewStatus: state.closeout.externalReviewStatus } : null,
        stage: "IMPLEMENTATION_COMPLETE",
        statePath,
      };
    }
    // RB2R1 (BLOCKER 5): `final: PASS` has ONE meaning — FINAL AUTHORITATIVE
    // CLOSEOUT PASS. An idempotent re-entry while review is still pending
    // must return a NON-final state, never final PASS. `alreadyApplied`
    // records that the bundle closeout ran; it does NOT imply review
    // acceptance. Only when the full final-authority predicate
    //（assertFinalCardCloseout）is true may a re-entry return final PASS.
    const finalGate = assertFinalCardCloseout({
      closeout: state.closeout,
      outDir: dir,
      cardId: state.task?.cardId ?? null,
      repoPath: repoPath ?? null,
      surfaceDir: surfaceDir ?? null,
      agentIdentity: agentIdentity ?? state.agentIdentity ?? null,
    });
    if (!finalGate.ok) {
      return {
        applied: true,
        alreadyApplied: true,
        final: "AWAITING_EXTERNAL_REVIEW",
        holdCode: finalGate.holdCode ?? EXTERNAL_REVIEW_HOLDS.NOT_COMPLETE,
        reason: finalGate.reason,
        bundlePath: bundleCheck.path,
        bundle: { identity: bundleCheck.identity, sha256: bundleCheck.sha256 },
        externalReview: state.closeout?.externalReviewStatus ? { externalReviewStatus: state.closeout.externalReviewStatus } : null,
        stage: finalGate.stage,
        statePath,
      };
    }
    return {
      applied: true,
      alreadyApplied: true,
      final: "PASS",
      holdCode: null,
      reason: null,
      bundlePath: finalGate.bundlePath ?? bundleCheck.path,
      bundle: { identity: bundleCheck.identity, sha256: bundleCheck.sha256 },
      externalReview: state.closeout?.externalReviewStatus ? { externalReviewStatus: state.closeout.externalReviewStatus } : null,
      stage: finalGate.stage,
      statePath,
    };
  }

  // R2: deterministic materialization; incomplete metadata fails closed.
  const materialized = materializeCloseoutContract(state);
  if (!materialized.ok) {
    return {
      applied: true,
      final: "HOLD",
      holdCode: CLOSEOUT_HOLDS.METADATA_INCOMPLETE,
      reason: `CLOSEOUT_METADATA_INCOMPLETE:${materialized.errors.join(";")}`,
      statePath,
    };
  }
  const contract = {
    ...materialized.contract,
    outDir: outDir ?? materialized.contract.outDir,
    surfaceDir: surfaceDir ?? materialized.contract.surfaceDir ?? null,
    agentIdentity: agentIdentity ?? materialized.contract.agentIdentity ?? null,
    fileName,
    deliver: undefined, // RB-1H default surface deliverer（hard rule）
  };

  // Graph result: authoritative structured metadata only（in-memory result or
  // a persisted graph-closeout evidence snapshot — never free-text stdout）.
  //
  // R-12 — STATE IS PROJECTION, NOT AUTHORITY: BOTH paths now pass through
  // the ONE canonical graph-evidence validator before any of this evidence
  // can influence closeout. A caller may provide evidence; a caller may NOT
  // provide authority:
  //   - disk evidence: exact graph-closeout-evidence/v1 schema + structure +
  //     identity binding（cardId against state.task.cardId; graphRunId
  //     against the recorded lineage when the state carries one）;
  //   - in-memory graphResult: the SAME structural + identity validation —
  //     no weaker CLI path, no stronger accidental path.
  // Structural/identity violations fail closed with deterministic R12_*
  // hold codes BEFORE any PASS derivation; a VALID non-PASS result keeps
  // normal closeout semantics (GATE 9).
  const expectedCardId = state.task?.cardId ?? null;
  // GATE E — bind against the recorded closeout lineage when the state
  // records an expected graph/run identity. The current architecture records
  // graphRunId on the closeout disposition/retry lineage only when present;
  // no stronger cross-system identifier is invented here.
  const expectedGraphRunId = typeof state.closeout?.graphRunId === "string" && state.closeout.graphRunId.length > 0
    ? state.closeout.graphRunId
    : (typeof state.expectedGraphRunId === "string" && state.expectedGraphRunId.length > 0 ? state.expectedGraphRunId : null);
  let gr = null;
  if (graphResult) {
    const v = validateGraphEvidence(graphResult, { expectedCardId, expectedGraphRunId });
    if (!v.ok) {
      return { applied: true, final: "HOLD", holdCode: v.holdCode ?? CLOSEOUT_HOLDS.EVIDENCE_UNREADABLE, reason: `${v.holdCode ?? "R12_EVIDENCE_INVALID"}:${v.errors.join(";")}`.slice(0, 500), statePath };
    }
    gr = v.graphResult;
  } else if (graphResultPath) {
    const loaded = loadGraphResultFromEvidence(graphResultPath, { expectedCardId, expectedGraphRunId });
    if (!loaded.ok) {
      const code = loaded.holdCode ?? CLOSEOUT_HOLDS.EVIDENCE_UNREADABLE;
      return { applied: true, final: "HOLD", holdCode: code, reason: `${code}:${loaded.errors.join(";")}`.slice(0, 500), statePath };
    }
    gr = loaded.graphResult;
  }
  if (!gr) {
    return { applied: true, final: "HOLD", holdCode: CLOSEOUT_HOLDS.GRAPH_RESULT_ABSENT, reason: "CLOSEOUT_GRAPH_RESULT_ABSENT:no_graph_result_or_evidence", statePath };
  }

  // GATE H — aggregate/child consistency is enforced at the SAME seam for
  // both paths: an aggregate PASS over missing/HOLD/FAIL/skipped/blocked
  // required children can never enter the source builder (the contradiction
  // is fenced BEFORE buildGraphCloseoutSource sees it). Valid non-PASS
  // evidence skips this check (normal closeout semantics).
  if (gr.final === "PASS") {
    const consistency = assertGraphAggregateConsistency(gr);
    if (!consistency.ok) {
      return { applied: true, final: "HOLD", holdCode: consistency.holdCode, reason: `${consistency.holdCode}:${consistency.errors.join(";")}`.slice(0, 500), statePath };
    }
  }

  const r = await runMandatoryGraphCloseout({
    graphResult: gr,
    closeout: contract,
    repoPath,
    cwd,
    outDir: contract.outDir,
    timeoutMs,
    fileName,
    gate,
    sourceBuilder,
    evidenceWriter,
  });

  // Record the disposition back into the state（atomic）. A PASS is terminal;
  // a non-PASS disposition（AWAITING_BUNDLE_DELIVERY / HOLD）is recorded but
  // retryable（re-entry re-attempts delivery with the same identity）.
  const nextState = {
    ...state,
    closeout: {
      status: "APPLIED",
      final: r.final ?? null,
      stage: r.final === "PASS" ? "REVIEW_BUNDLE_READY" : "IMPLEMENTATION_COMPLETE",
      bundleIdentity: r.bundle?.identity ?? null,
      bundleSha256: r.bundle?.sha256 ?? null,
      externalReviewStatus: r.externalReview?.externalReviewStatus ?? null,
      verdict: r.externalReview?.verdict ?? null,
      appliedAt: new Date().toISOString(),
      blockedReason: r.final !== "PASS" ? (r.reason ?? null) : null,
    },
  };
  // R-13（RSL2-06）: a REQUIRED state persistence failure fails closed — the
  // disposition is never silently dropped（previously the write result was
  // ignored）.
  const writeResult = writeCloseoutState({ path: statePath, state: nextState });
  if (!writeResult.ok) {
    return {
      applied: true,
      final: "HOLD",
      holdCode: "CLOSEOUT_STATE_WRITE_FAILED",
      reason: `CLOSEOUT_STATE_WRITE_FAILED:${writeResult.reason}`,
      bundlePath: r.bundlePath ?? null,
      bundle: r.bundle ?? null,
      externalReview: r.externalReview ?? null,
      statePath,
    };
  }

  return { ...r, statePath };
}

// ── IMPL1 review-job delivery binding (Flow 2 downstream publication) ────
//
// Current/delivery.json remains the AUTHORITATIVE downstream publication
// surface. These helpers bind an ACCEPTED review-job into that surface's
// projection: only an ACCEPTED generation may publish, and every digest is
// recomputed from persisted bytes — never trusted from bound fields alone.

/**
 * Build the downstream delivery projection for an ACCEPTED review-job.
 * Rejects non-ACCEPTED (PERSISTED/STAGED/HOLD/SUPERSEDED), missing artifacts,
 * and digest mismatches. Current/delivery.json does NOT mint acceptance.
 */
export function buildReviewJobDeliveryProjection({ cardId, root = null } = {}) {
  const opts = root ? { root } : {};
  const current = readReviewJob(cardId, opts);
  if (!current.ok) return current;
  const job = current.job;
  if (job.state !== "ACCEPTED" && job.state !== "DOWNSTREAM_AUTHORIZED") {
    return { ok: false, code: "REVIEW_JOB_NOT_ACCEPTED", state: job.state, job, path: current.path };
  }
  if (!job.findingsDigest || !job.verdictDigest) {
    return { ok: false, code: "REVIEW_JOB_DIGESTS_UNBOUND", job, path: current.path };
  }
  let fbytes, vbytes;
  try {
    fbytes = readFileSync(findingsPath(cardId, job.generation, opts), "utf8");
    vbytes = readFileSync(verdictPath(cardId, job.generation, opts), "utf8");
  } catch {
    return { ok: false, code: "REVIEW_ARTIFACT_MISSING", job, path: current.path };
  }
  if (sha256Text(fbytes) !== job.findingsDigest) {
    return { ok: false, code: "REVIEW_FINDINGS_DIGEST_MISMATCH", job, path: current.path };
  }
  if (sha256Text(vbytes) !== job.verdictDigest) {
    return { ok: false, code: "REVIEW_VERDICT_DIGEST_MISMATCH", job, path: current.path };
  }
  return {
    ok: true,
    delivery: {
      schema: "autoloop.review-job-delivery/v1",
      jobId: job.jobId,
      generation: job.generation,
      candidateIdentity: job.candidateIdentity,
      specIdentity: { specId: job.specId, specDigest: job.specDigest },
      findingsDigest: job.findingsDigest,
      verdictDigest: job.verdictDigest,
      acceptance: job.acceptedAt
        ? { acceptedAt: job.acceptedAt, acceptanceAuthority: job.acceptanceAuthority ?? null }
        : null,
      supersedes: job.supersedes ?? null,
      supersededBy: job.supersededBy ?? null,
    },
    job,
    path: current.path,
  };
}

/**
 * Publish the accepted review-job downstream: verify ACCEPTED, recompute the
 * full chain, and transition ACCEPTED → DOWNSTREAM_AUTHORIZED (idempotent).
 * Downstream publication is NOT acceptance — only the acceptance authority
 * mints ACCEPTED (STAGED → ACCEPTED). This only publishes an already-ACCEPTED
 * generation and marks it authorized for downstream admission.
 */
export function deliverAcceptedReviewJob({ cardId, root = null } = {}) {
  const proj = buildReviewJobDeliveryProjection({ cardId, root });
  if (!proj.ok) return proj;
  const job = proj.job;
  if (job.state === "DOWNSTREAM_AUTHORIZED") {
    return { ok: true, idempotent: true, delivery: proj.delivery, job, path: proj.path };
  }
  const updated = updateReviewJob(cardId, {
    expectedStateVersion: job.stateVersion,
    patch: { state: "DOWNSTREAM_AUTHORIZED" },
  }, root ? { root } : {});
  if (!updated.ok) return updated;
  return { ok: true, delivery: proj.delivery, job: updated.job, path: proj.path };
}
