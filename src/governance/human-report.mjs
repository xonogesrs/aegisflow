// src/governance/human-report.mjs
//
// REVIEW-LATEST-HUMAN-HANDOFF-1 — Latest Human Report publication seam.
//
// The user-facing "what did AutoLoop just finish?" report is a SEPARATE
// authority domain from the review pipeline:
//
//   Current/   = the single review awaiting an external verdict（never
//                overwritten while unresolved）— NOT a "latest report" lookup
//   Queue/     = formal reviews waiting to become Current
//   LatestHuman/ = the NEWEST completed work report presented to the user
//                （latest-report.txt verbatim bytes + latest-report.json
//                pointer/metadata）
//
// Core invariant: LATEST != CURRENT. New work（formal review OR operator
// closeout）publishes LatestHuman without touching Current / Queue / Archive
// / delivery records / bundle bytes. Publication is content-addressed,
// atomic（tmp + rename）, idempotent, stale-replay guarded, and fail-closed:
// a corrupt pointer or missing bytes NEVER silently falls back to Current.
//
// The queue Latest pointer（Queue/latest.json）stays navigation-only and is
// NOT modified here.
//
// Env overrides（tests / CI isolation）:
//   AUTOLOOP_HUMAN_REPORT_DIR   absolute human-report surface（default:
//                                <review-surface-root>/LatestHuman）
//   AUTOLOOP_REVIEW_SURFACE     review surface（used to derive the default
//                                human dir when the former is not set）

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanForSecrets } from "../evidence/run-evidence-store.mjs";

export const HUMAN_REPORT_SCHEMA = "autoloop.human-report-latest/v1";
export const HUMAN_REPORT_TYPES = Object.freeze(["formal-review-bundle", "operator-closeout"]);
export const HUMAN_REPORT_HOLDS = Object.freeze({
  ABSENT: "HUMAN_REPORT_ABSENT",
  POINTER_CORRUPT: "HUMAN_REPORT_POINTER_CORRUPT",
  BYTES_MISSING: "HUMAN_REPORT_BYTES_MISSING",
  SHA_MISMATCH: "HUMAN_REPORT_SHA_MISMATCH",
  SOURCE_MISSING: "HUMAN_REPORT_SOURCE_MISSING",
  IDENTITY_INVALID: "HUMAN_REPORT_IDENTITY_INVALID",
  SHA_INVALID: "HUMAN_REPORT_SHA_INVALID",
  TYPE_INVALID: "HUMAN_REPORT_TYPE_INVALID",
  SECRET_DETECTED: "HUMAN_REPORT_SECRET_DETECTED",
  STALE_REPLAY: "HUMAN_REPORT_STALE_REPLAY",
  WRITE_FAILED: "HUMAN_REPORT_WRITE_FAILED",
});

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function wholeFileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function fileSha256(path) {
  return wholeFileSha256(path);
}

/**
 * Resolve the human-report surface directory.
 * Env override wins（tests / CI isolation）; otherwise derived from the
 * resolved review surface root（sibling LatestHuman/, mirroring Queue/ and
 * Archive/ co-location）so env-isolated surfaces never touch the real
 * Desktop.
 */
export function humanReportDir(surfaceDir = null) {
  const envDir = process.env.AUTOLOOP_HUMAN_REPORT_DIR;
  if (envDir && envDir.trim().length > 0) return resolve(envDir);
  const surface = surfaceDir
    ?? process.env.AUTOLOOP_REVIEW_SURFACE
    ?? join(homedir(), "Desktop", "AutoLoop-Review", "Current");
  return join(dirname(resolve(surface)), "LatestHuman");
}

export function humanReportPath(surfaceDir = null) {
  return join(humanReportDir(surfaceDir), "latest-report.json");
}

export function humanReportTextPath(surfaceDir = null) {
  return join(humanReportDir(surfaceDir), "latest-report.txt");
}

/**
 * Read the Latest Human Report（fail-closed）.
 * Returns { ok:true, report, text, textPath } or { ok:false, reason, holdCode }.
 * A corrupt pointer, missing bytes, or a byte/sha mismatch NEVER falls back
 * to Current/ — the caller must surface the error, not silently re-serve the
 * stale review surface.
 */
export function readHumanReport({ surfaceDir = null } = {}) {
  const dir = humanReportDir(surfaceDir);
  const metaPath = join(dir, "latest-report.json");
  const textPath = join(dir, "latest-report.txt");
  if (!existsSync(metaPath)) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.ABSENT, reason: "HUMAN_REPORT_ABSENT:no_latest_report_published" };
  }
  let report;
  try {
    report = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.POINTER_CORRUPT, reason: `HUMAN_REPORT_POINTER_CORRUPT:${String(e?.message ?? e).slice(0, 200)}` };
  }
  if (!report || typeof report !== "object" || report.schema !== HUMAN_REPORT_SCHEMA) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.POINTER_CORRUPT, reason: "HUMAN_REPORT_POINTER_CORRUPT:bad_schema" };
  }
  if (!existsSync(textPath)) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.BYTES_MISSING, reason: "HUMAN_REPORT_BYTES_MISSING:latest_report_txt_absent" };
  }
  let bytes;
  try {
    bytes = readFileSync(textPath, "utf8");
  } catch (e) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.BYTES_MISSING, reason: `HUMAN_REPORT_BYTES_MISSING:${String(e?.message ?? e).slice(0, 200)}` };
  }
  const actual = sha256Text(bytes);
  if (typeof report.sha256 !== "string" || actual !== report.sha256) {
    return {
      ok: false,
      holdCode: HUMAN_REPORT_HOLDS.SHA_MISMATCH,
      reason: `HUMAN_REPORT_SHA_MISMATCH:expected_${report.sha256 ?? "(none)"}_actual_${actual}`,
    };
  }
  return { ok: true, report, text: bytes, textPath };
}

/**
 * Atomically publish a Latest Human Report.
 *
 * Input:
 *   cardId            — the card/lineage this report belongs to
 *   generation/jobId  — review-job generation / job id（when known）
 *   reportType        — "formal-review-bundle" | "operator-closeout"
 *   reportIdentity    — semantic identity（formal: review bundle identity;
 *                       operator: content sha of the report text）
 *   sourceReportSha256— caller-claimed sha of the source artifact（reference;
 *                       formal: the bundle's recorded content sha）
 *   sourcePath        — the authoritative artifact（bundle txt / closeout txt）
 *   requiresExternalReview — true when this report's card also needs a formal
 *                       external verdict（scheduling is INDEPENDENT）
 *   currentReviewState    — e.g. AWAITING_EXTERNAL_REVIEW / PASS / null
 *   createdAt         — artifact generation time（ISO）
 *   publishedAt       — publication timestamp（ISO; default now）— monotonic;
 *                       an OLDER report can never replace a NEWER one
 *   surfaceDir        — resolved review surface（default env/Desktop）
 *   force             — clear a corrupt pointer before publishing
 *                       （operator repair only; never automatic）
 *
 * Guarantees:
 *   - the pointer's sha256 is ALWAYS recomputed from the published bytes
 *     （never trusted from caller input）;
 *   - bytes are written first, pointer LAST（tmp + rename each）— a crash
 *     between the two leaves the OLD pointer（consistent old state）; the
 *     next publish heals;
 *   - idempotent: same cardId + reportIdentity + sha256 -> no-op（publishedAt
 *     preserved）;
 *   - stale replay: incoming publishedAt older than the current pointer ->
 *     rejected（HUMAN_REPORT_STALE_REPLAY）unless it is the identical report;
 *   - corrupt pointer -> fail closed（publish refused; `force` clears it）.
 */
export function publishHumanReport({
  cardId,
  generation = null,
  jobId = null,
  reportType,
  reportIdentity,
  sourceReportSha256 = null,
  sourcePath,
  requiresExternalReview = false,
  currentReviewState = null,
  createdAt = null,
  publishedAt = new Date().toISOString(),
  surfaceDir = null,
  force = false,
} = {}) {
  if (!cardId || typeof cardId !== "string") {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.IDENTITY_INVALID, reason: "HUMAN_REPORT_IDENTITY_INVALID:card_id_absent" };
  }
  if (!HUMAN_REPORT_TYPES.includes(reportType)) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.TYPE_INVALID, reason: `HUMAN_REPORT_TYPE_INVALID:${String(reportType)}` };
  }
  if (reportType === "formal-review-bundle" && (!reportIdentity || !HEX64.test(reportIdentity))) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.IDENTITY_INVALID, reason: `HUMAN_REPORT_IDENTITY_INVALID:${String(reportIdentity)}` };
  }
  if (!sourcePath || !existsSync(sourcePath)) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.SOURCE_MISSING, reason: `HUMAN_REPORT_SOURCE_MISSING:${String(sourcePath)}` };
  }
  const srcText = readFileSync(sourcePath, "utf8");
  // The pointer sha is recomputed from the ACTUAL bytes to publish — never
  // trusted from caller input.
  const sha = sha256Text(srcText);
  if (reportType === "operator-closeout" && !reportIdentity) {
    reportIdentity = sha; // content-addressed identity for operator reports
  }
  if (typeof reportIdentity !== "string" || !HEX64.test(reportIdentity)) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.IDENTITY_INVALID, reason: `HUMAN_REPORT_IDENTITY_INVALID:${String(reportIdentity)}` };
  }
  if (sourceReportSha256 && !HEX64.test(sourceReportSha256)) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.SHA_INVALID, reason: `HUMAN_REPORT_SHA_INVALID:${String(sourceReportSha256)}` };
  }
  if (!ISO_RE.test(publishedAt)) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.WRITE_FAILED, reason: `HUMAN_REPORT_WRITE_FAILED:published_at_invalid:${String(publishedAt)}` };
  }
  const secretScan = scanForSecrets(srcText);
  if (!secretScan.safe) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.SECRET_DETECTED, reason: `HUMAN_REPORT_SECRET_DETECTED:${secretScan.matches.join(",")}` };
  }

  const dir = humanReportDir(surfaceDir);
  const metaPath = join(dir, "latest-report.json");
  const textPath = join(dir, "latest-report.txt");

  // Stale-replay / idempotency / corrupt-pointer guards run against the
  // CURRENT pointer BEFORE any write.
  let current = null;
  if (existsSync(metaPath)) {
    try {
      current = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      if (!force) {
        return { ok: false, holdCode: HUMAN_REPORT_HOLDS.POINTER_CORRUPT, reason: "HUMAN_REPORT_POINTER_CORRUPT:publish_refused_use_force" };
      }
      current = null;
    }
  }
  if (current && current.schema !== HUMAN_REPORT_SCHEMA && !force) {
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.POINTER_CORRUPT, reason: "HUMAN_REPORT_POINTER_CORRUPT:bad_schema" };
  }
  if (current && current.schema === HUMAN_REPORT_SCHEMA) {
    // identical report -> idempotent no-op（publishedAt preserved）
    if (current.cardId === cardId
        && current.reportIdentity === reportIdentity
        && current.sha256 === sha) {
      return { ok: true, alreadyCurrent: true, report: current };
    }
    // a DIFFERENT report with an OLDER publication time is a stale replay
    const curT = new Date(current.publishedAt).getTime();
    const newT = new Date(publishedAt).getTime();
    if (Number.isFinite(curT) && Number.isFinite(newT) && newT < curT) {
      return { ok: false, holdCode: HUMAN_REPORT_HOLDS.STALE_REPLAY, reason: `HUMAN_REPORT_STALE_REPLAY:${publishedAt}_older_than_${current.publishedAt}` };
    }
  }

  // Atomic publication: bytes first（tmp + rename）, pointer LAST.
  mkdirSync(dir, { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const tmpTxt = `${textPath}.tmp-${token}`;
  const tmpMeta = `${metaPath}.tmp-${token}`;
  const report = {
    schema: HUMAN_REPORT_SCHEMA,
    cardId,
    generation: generation ?? null,
    jobId: jobId ?? null,
    reportType,
    reportIdentity,
    sha256: sha,
    sourcePath: resolve(sourcePath),
    sourceReportSha256: sourceReportSha256 ?? null,
    requiresExternalReview: Boolean(requiresExternalReview),
    currentReviewState: currentReviewState ?? null,
    createdAt: createdAt && ISO_RE.test(createdAt) ? createdAt : publishedAt,
    publishedAt,
  };
  try {
    writeFileSync(tmpTxt, srcText, "utf8");
    renameSync(tmpTxt, textPath);
    const metaScan = scanForSecrets(JSON.stringify(report));
    if (!metaScan.safe) {
      rmSync(tmpMeta, { force: true });
      return { ok: false, holdCode: HUMAN_REPORT_HOLDS.SECRET_DETECTED, reason: `HUMAN_REPORT_SECRET_DETECTED:meta:${metaScan.matches.join(",")}` };
    }
    writeFileSync(tmpMeta, JSON.stringify(report, null, 2), "utf8");
    renameSync(tmpMeta, metaPath);
  } catch (e) {
    try { if (existsSync(tmpTxt)) rmSync(tmpTxt, { force: true }); } catch { /* best effort */ }
    try { if (existsSync(tmpMeta)) rmSync(tmpMeta, { force: true }); } catch { /* best effort */ }
    return { ok: false, holdCode: HUMAN_REPORT_HOLDS.WRITE_FAILED, reason: `HUMAN_REPORT_WRITE_FAILED:${String(e?.message ?? e).slice(0, 200)}` };
  }
  return { ok: true, published: true, report, textPath, metaPath };
}

/**
 * Read-only status summary（CLI / human routing）. Fail-closed on corruption.
 */
export function humanReportStatus({ surfaceDir = null } = {}) {
  const r = readHumanReport({ surfaceDir });
  if (!r.ok) {
    return { ok: false, holdCode: r.holdCode, reason: r.reason, dir: humanReportDir(surfaceDir) };
  }
  return {
    ok: true,
    dir: humanReportDir(surfaceDir),
    report: r.report,
    textPath: r.textPath,
  };
}

export { fileSha256, sha256Text, wholeFileSha256 };
