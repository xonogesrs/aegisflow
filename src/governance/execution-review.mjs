// src/governance/execution-review.mjs
//
// RSL2 — Domain A: LATEST_EXECUTION_REVIEW surface（universal execution
// review publication）.
//
// RSL1 froze the two-authority surface split:
//   Domain A（this module）— ~/Desktop/AutoLoop-Review/Latest/review.txt:
//     the FIXED absolute human entrypoint for the most recent Formal Agent
//     Execution's review. EVERY formal execution publishes here; the previous
//     occupant is rotated into Latest/archive/（byte-identical, collision-
//     safe, immutable）. Never blocked by external-review inbox state.
//   Domain B（review-bundle.mjs）— ~/Desktop/AutoLoop-Review/Current/ +
//     Archive/: the external review INBOX. Unresolved occupants stay until a
//     reviewer verdict; nothing in this module ever touches that inbox.
//
// Hard rules（RSL2-01/02/03/05）:
//   - publication is atomic（invisible staging + ONE directory/file rename）
//     under a single-owner lock（never a mixed/partial Latest）
//   - rotation copies the previous Latest BYTE-IDENTICALLY into the archive
//     BEFORE the new publish; a crash at any point never leaves Latest empty
//     or corrupt（rename is atomic; the archive copy is idempotent）
//   - archive files are NEVER overwritten（deterministic name
//     YYYYMMDD-<CARD>-<identity8>-review.txt; skip-if-exists）
//   - same-execution retry is idempotent（same executionId + identity ->
//     no duplicate archive, no rewrite）
//   - after publish the file is RE-READ and RE-HASHED（content sha + identity
//     must match — fail closed）
//   - review-requiredness for a formal execution is derived from the frozen
//     admission（authoritative projection）, never from caller declaration
//     alone（RSL2-03; caller declaration is at most an input）
//   - reuse: same identity/sha conventions, atomic-write pattern and
//     stale-lock recovery as review-bundle.mjs — NO second parallel review
//     framework.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanForSecrets, sha256Text } from "../evidence/run-evidence-store.mjs";
import { collectRepoFacts } from "./review-bundle.mjs";
import { currentSurfaceReviewStatus } from "./review-bundle.mjs";

export const EXECUTION_REVIEW_SCHEMA = "autoloop.execution-review/v1";
export const EXECUTION_REVIEW_SOURCE_SCHEMA = "autoloop.execution-review.source/v1";
export const EXECUTION_REVIEW_TERMINATOR = "=== END OF EXECUTION REVIEW ===";

export const EXECUTION_REVIEW_OUTCOMES = Object.freeze(["PASS", "HOLD", "REPAIR", "REPLAN"]);

export const EXECUTION_REVIEW_HOLDS = Object.freeze({
  INVALID: "EXECUTION_REVIEW_INVALID",
  GENERATION_FAILED: "EXECUTION_REVIEW_GENERATION_FAILED",
  SECRET_DETECTED: "EXECUTION_REVIEW_SECRET_DETECTED",
  PUBLISH_FAILED: "EXECUTION_REVIEW_PUBLISH_FAILED",
  REREAD_MISMATCH: "EXECUTION_REVIEW_REREAD_MISMATCH",
  NOT_PUBLISHED: "EXECUTION_REVIEW_NOT_PUBLISHED",
  SOURCE_FAILED: "EXECUTION_REVIEW_SOURCE_FAILED",
});

/** Fixed absolute human entrypoint for the latest formal execution review. */
export function latestReviewDir() {
  return process.env.AUTOLOOP_EXECUTION_REVIEW_SURFACE ?? join(homedir(), "Desktop", "AutoLoop-Review", "Latest");
}

/** Historical execution reviews（rotated from Latest/; flat, immutable）. */
export function latestReviewArchiveDir() {
  return process.env.AUTOLOOP_EXECUTION_REVIEW_ARCHIVE ?? join(homedir(), "Desktop", "AutoLoop-Review", "Latest", "archive");
}

// ---------------------------------------------------------------------------
// Identity / hashing（same conventions as review-bundle.mjs）.
// ---------------------------------------------------------------------------

function sha256Hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function recursiveCanonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Deterministic execution-review identity（independent of publish bookkeeping
 * and of generatedAt — same-execution retry must re-derive the SAME identity）.
 * Never includes the review's own bytes/hash（no circularity）.
 */
export function executionReviewIdentity(source) {
  const exec = source?.execution ?? {};
  const repo = source?.repository ?? {};
  const req = source?.admissionRequirement ?? {};
  return sha256Hex(recursiveCanonicalJson({
    schema: EXECUTION_REVIEW_SCHEMA,
    executionId: exec.executionId,
    cardId: exec.cardId,
    cardTitle: exec.cardTitle,
    outcome: exec.outcome,
    repository: { repository: repo.repository ?? null, branch: repo.branch ?? null, head: repo.head ?? null, treeSha: repo.treeSha ?? null },
    admissionRequirement: { admissionId: req.admissionId ?? null, reviewPolicyStrength: req.reviewPolicyStrength ?? null, externalReviewRequired: req.externalReviewRequired ?? false },
  }));
}

/**
 * Content sha256 of a published execution review: everything up to and
 * including the END terminator line, plus trailing newline. The footer
 * (REVIEW_PUBLICATION_IDENTITY / REVIEW_PUBLICATION_SHA256) is excluded —
 * mirrors the bundle validator's recompute convention.
 */
export function executionReviewContentSha256(text) {
  const linesArr = String(text ?? "").split("\n");
  const idx = [...linesArr].reverse().findIndex((l) => l.trim() === EXECUTION_REVIEW_TERMINATOR);
  if (idx < 0) return null;
  const termIdx = linesArr.length - 1 - idx;
  return sha256Hex(linesArr.slice(0, termIdx + 1).join("\n") + "\n");
}

/** Parse identity + header fields from a published execution review text. */
export function parseExecutionReviewText(text) {
  const src = String(text ?? "");
  return {
    identity: src.match(/^REVIEW_PUBLICATION_IDENTITY:\s*([0-9a-f]{64})$/m)?.[1] ?? null,
    sha256: src.match(/^REVIEW_PUBLICATION_SHA256:\s*([0-9a-f]{64})$/m)?.[1] ?? null,
    executionId: src.match(/^EXECUTION_ID:\s*(.+)$/m)?.[1]?.trim() ?? null,
    cardId: src.match(/^CARD_ID:\s*(.+)$/m)?.[1]?.trim() ?? null,
    outcome: src.match(/^OUTCOME:\s*(.+)$/m)?.[1]?.trim() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Source validation / rendering.
// ---------------------------------------------------------------------------

export const EXECUTION_REVIEW_REQUIRED_FIELDS = Object.freeze([
  "execution.executionId",
  "execution.cardId",
  "execution.cardTitle",
  "execution.outcome",
]);

function at(source, dot) {
  let v = source;
  for (const k of dot.split(".")) {
    if (v === null || v === undefined || typeof v !== "object") return undefined;
    v = v[k];
  }
  return v;
}

/** Fail-closed source validation（missing/invalid fields -> errors）. */
export function validateExecutionReviewSource(source) {
  const errors = [];
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { ok: false, errors: ["source_not_object"] };
  }
  if (source.schema !== EXECUTION_REVIEW_SOURCE_SCHEMA) {
    errors.push(`schema_mismatch:${source.schema ?? "missing"}`);
  }
  for (const f of EXECUTION_REVIEW_REQUIRED_FIELDS) {
    const v = at(source, f);
    if (v === undefined || v === null || String(v).trim() === "") errors.push(`missing:${f}`);
  }
  const outcome = at(source, "execution.outcome");
  if (outcome !== undefined && outcome !== null && !EXECUTION_REVIEW_OUTCOMES.includes(outcome)) {
    errors.push(`invalid_outcome:${outcome}`);
  }
  if (source.execution && (typeof source.execution !== "object" || Array.isArray(source.execution))) {
    errors.push("execution_malformed");
  }
  return { ok: errors.length === 0, errors };
}

function statusLine(name, value) {
  const v = value === undefined || value === null || value === "" ? "NOT_APPLICABLE" : String(value);
  return `${name}: ${v}\n`;
}

function listBlock(title, items, prefix = "  - ") {
  const arr = Array.isArray(items) ? items : [];
  const out = [`\n${title}\n`];
  if (arr.length === 0) out.push(`${prefix}(none)\n`);
  else for (const it of arr) out.push(`${prefix}${typeof it === "string" ? it : JSON.stringify(it)}\n`);
  return out.join("");
}

/**
 * Render a human-readable execution review. `publicationRecord` is filled by
 * the publisher（archive/identity/inbox bookkeeping）and is part of the hashed
 * content; the footer lines are appended by the publisher AFTER hashing.
 */
export function renderExecutionReview(source, publicationRecord = null) {
  const exec = source?.execution ?? {};
  const repo = source?.repository ?? {};
  const req = source?.admissionRequirement ?? {};
  const generatedAt = source?.generatedAt ?? null;
  const s = [];
  s.push("================================================================================\n");
  s.push("AUTOLOOP EXECUTION REVIEW\n");
  s.push("================================================================================\n");
  s.push(statusLine("REVIEW_SCHEMA", EXECUTION_REVIEW_SCHEMA));
  s.push(statusLine("EXECUTION_ID", exec.executionId));
  s.push(statusLine("CARD_ID", exec.cardId));
  s.push(statusLine("CARD_TITLE", exec.cardTitle));
  s.push(statusLine("OUTCOME", exec.outcome));
  s.push(statusLine("HOLD_CODE", exec.holdCode));
  s.push(statusLine("REASON", exec.reason));
  s.push(statusLine("GENERATED_AT", generatedAt));
  s.push(statusLine("ADMISSION_REVIEW_REQUIREMENT", req.required === true ? `REQUIRED (admission ${req.admissionId ?? "?"}; strength ${req.reviewPolicyStrength ?? "?"}; external ${req.externalReviewRequired === true ? "yes" : "no"})` : "NOT_APPLICABLE"));

  s.push("\n================================================================================\n");
  s.push("1. Requested Task\n");
  s.push("================================================================================\n");
  s.push(statusLine("OBJECTIVE", source?.objective ?? exec.cardTitle));

  s.push("\n================================================================================\n");
  s.push("2. Repository Identity\n");
  s.push("================================================================================\n");
  s.push(statusLine("REPOSITORY", repo.repository));
  s.push(statusLine("BRANCH", repo.branch));
  s.push(statusLine("HEAD", repo.head));
  s.push(statusLine("TREE_SHA", repo.treeSha));
  s.push(statusLine("WORKTREE", repo.worktreePath));

  s.push("\n================================================================================\n");
  s.push("3. Work Performed\n");
  s.push("================================================================================\n");
  s.push(statusLine("SUMMARY", source?.workSummary));
  if (Array.isArray(source?.designDecisions) && source.designDecisions.length > 0) {
    s.push(listBlock("DESIGN_DECISIONS", source.designDecisions));
  }

  s.push("\n================================================================================\n");
  s.push("4. Mutations\n");
  s.push("================================================================================\n");
  const files = source?.mutations ?? {};
  s.push(listBlock("ADDED", files.added));
  s.push(listBlock("MODIFIED", files.modified));
  s.push(listBlock("DELETED", files.deleted));

  s.push("\n================================================================================\n");
  s.push("5. Verification / Tests\n");
  s.push("================================================================================\n");
  s.push(listBlock("TEST_RESULTS", source?.tests));

  s.push("\n================================================================================\n");
  s.push("6. Findings\n");
  s.push("================================================================================\n");
  s.push(listBlock("FINDINGS", source?.findings));

  s.push("\n================================================================================\n");
  s.push("7. Result / Verdict\n");
  s.push("================================================================================\n");
  s.push(statusLine("OUTCOME", exec.outcome));
  s.push(statusLine("EXTERNAL_REVIEW_REQUIRED", req.externalReviewRequired === true ? "true" : "false"));
  s.push(statusLine("EXTERNAL_REVIEW_STATUS", source?.closeout?.externalReviewStatus));

  s.push("\n================================================================================\n");
  s.push("8. Remaining Blocker / Debt\n");
  s.push("================================================================================\n");
  s.push(listBlock("RISKS", source?.risks));
  s.push(listBlock("LIMITATIONS", source?.limitations));

  s.push("\n================================================================================\n");
  s.push("9. Next Action\n");
  s.push("================================================================================\n");
  s.push(statusLine("NEXT_ACTION", source?.nextAction));

  if (publicationRecord && typeof publicationRecord === "object") {
    s.push("\n================================================================================\n");
    s.push("Publication Record\n");
    s.push("================================================================================\n");
    s.push(statusLine("LATEST_PREVIOUS_IDENTITY", publicationRecord.previousIdentity));
    s.push(statusLine("LATEST_ARCHIVED_PATH", publicationRecord.archivedPath));
    s.push(statusLine("LATEST_NEW_IDENTITY", publicationRecord.newIdentity));
    s.push(statusLine("EXTERNAL_INBOX_OCCUPANT", publicationRecord.inboxOccupant));
    s.push(statusLine("EXTERNAL_INBOX_MUTATED", "false"));
    s.push(statusLine("TERMINAL_COMPLETION_BARRIER_RESULT", publicationRecord.barrierResult));
  }

  s.push("\n" + EXECUTION_REVIEW_TERMINATOR + "\n");
  return s.join("");
}

// ---------------------------------------------------------------------------
// Single-owner lock（same pattern as the inbox surface lock; separate file
// so the two domains never contend）.
// ---------------------------------------------------------------------------

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export function acquireLatestReviewLock(surfaceDir = null) {
  const dir = resolve(surfaceDir ?? latestReviewDir());
  const lockPath = join(dirname(dir), ".latest.lock");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const acquire = () => {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), { flag: "wx" });
      return { ok: true, token, lockPath, dir };
    } catch (e) {
      if (e.code === "EEXIST") {
        try {
          const raw = JSON.parse(readFileSync(lockPath, "utf8"));
          if (raw?.pid && !processAlive(raw.pid)) {
            rmSync(lockPath, { force: true });
            try {
              writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), { flag: "wx" });
              return { ok: true, token, lockPath, dir };
            } catch { /* raced — fall through */ }
          }
        } catch { /* unreadable lock — fail closed */ }
      }
      return { ok: false, reason: "latest_surface_busy", lockPath, dir };
    }
  };
  try { mkdirSync(dirname(lockPath), { recursive: true }); } catch { /* best effort */ }
  return acquire();
}

export function releaseLatestReviewLock({ lockPath, token } = {}) {
  if (!lockPath || !token) return;
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    if (raw?.token === token) rmSync(lockPath, { force: true });
  } catch { /* best effort */ }
}

function sanitizeName(s) {
  return String(s ?? "CARD").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "CARD";
}

/**
 * Rotate the current Latest/review.txt into the flat archive — BYTE-IDENTICAL
 * copy via tmp + rename（the archived file is immutable; the original is left
 * in place and replaced only by the publish rename）. Collision-safe: a target
 * that already exists means the same review was already archived（skip — never
 * overwrite）. Runs under the caller's lock.
 */
export function archivePreviousLatest({ surfaceDir = null, archiveDir = null, dateStr = null, lock = null } = {}) {
  const dir = resolve(surfaceDir ?? latestReviewDir());
  const arch = resolve(archiveDir ?? latestReviewArchiveDir());
  const currentPath = join(dir, "review.txt");
  if (!existsSync(currentPath)) {
    return { ok: true, archived: false, archivedPath: null, previousIdentity: null, previousCard: null };
  }
  const ownLock = lock ?? acquireLatestReviewLock(dir);
  if (!ownLock.ok) {
    return { ok: false, reason: ownLock.reason ?? "latest_surface_busy", archived: false, archivedPath: null };
  }
  try {
    const raw = readFileSync(currentPath, "utf8");
    const parsed = parseExecutionReviewText(raw);
    const previousIdentity = parsed.identity ?? null;
    const previousCard = parsed.cardId ?? "UNKNOWN-CARD";
    const prefix = dateStr ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const target = join(arch, `${prefix}-${sanitizeName(previousCard)}-${String(previousIdentity ?? "unknown").slice(0, 8)}-review.txt`);
    if (existsSync(target)) {
      return { ok: true, archived: false, archivedPath: target, previousIdentity, previousCard, skipped: true };
    }
    mkdirSync(arch, { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, raw, "utf8");
    renameSync(tmp, target);
    return { ok: true, archived: true, archivedPath: target, previousIdentity, previousCard };
  } catch (e) {
    return { ok: false, reason: `latest_rotate_failed:${String(e?.message ?? e).slice(0, 200)}`, archived: false, archivedPath: null };
  } finally {
    if (!lock) releaseLatestReviewLock({ lockPath: ownLock.lockPath, token: ownLock.token });
  }
}

/**
 * RSL2-01 — the single execution-review publication path:
 *
 *   render -> secret scan -> identity -> lock -> archive previous Latest
 *   -> stage -> atomic rename -> unlock -> reread + recompute -> proof
 *
 * Returns `{ ok: true, identity, sha256, path, archivedPath, previousIdentity,
 * idempotent }` or a fail-closed `{ ok: false, holdCode, reason }` — the
 * previous valid Latest is NEVER removed on failure（the archive step copies;
 * only the atomic rename replaces）.
 */
export function publishExecutionReview(source, {
  surfaceDir = null,
  archiveDir = null,
  generatedAt = null,
  lock = null,
  barrierResult = null,
  inboxOccupant = null,
} = {}) {
  const v = validateExecutionReviewSource(source);
  if (!v.ok) {
    return { ok: false, holdCode: EXECUTION_REVIEW_HOLDS.INVALID, reason: `EXECUTION_REVIEW_INVALID:${v.errors.join(";")}` };
  }
  const dir = resolve(surfaceDir ?? latestReviewDir());
  const parent = dirname(dir);
  const identity = executionReviewIdentity(source);
  const exec = source.execution ?? {};
  let baseText;
  try {
    baseText = renderExecutionReview({ ...source, generatedAt: generatedAt ?? source.generatedAt ?? new Date().toISOString() }, null);
  } catch (e) {
    return { ok: false, holdCode: EXECUTION_REVIEW_HOLDS.GENERATION_FAILED, reason: `EXECUTION_REVIEW_GENERATION_FAILED:${String(e?.message ?? e).slice(0, 200)}` };
  }
  const preScan = scanForSecrets(baseText);
  if (!preScan.safe) {
    return { ok: false, holdCode: EXECUTION_REVIEW_HOLDS.SECRET_DETECTED, reason: `EXECUTION_REVIEW_SECRET_DETECTED:${preScan.matches.join(",")}` };
  }
  const ownLock = lock ?? acquireLatestReviewLock(dir);
  if (!ownLock.ok) {
    return { ok: false, holdCode: EXECUTION_REVIEW_HOLDS.PUBLISH_FAILED, reason: ownLock.reason ?? "latest_surface_busy" };
  }
  const token = ownLock.token;
  const lockPath = ownLock.lockPath;
  const staging = join(parent, `.latest-incoming-${token}`);
  try {
    mkdirSync(dir, { recursive: true });
    const currentPath = join(dir, "review.txt");
    // ── idempotent retry（T12）: same execution + same identity already on
    // the surface -> no archive, no rewrite.
    if (existsSync(currentPath)) {
      const cur = parseExecutionReviewText(readFileSync(currentPath, "utf8"));
      if (cur.executionId && cur.executionId === exec.executionId && cur.identity === identity) {
        return { ok: true, idempotent: true, identity, sha256: cur.sha256 ?? executionReviewContentSha256(readFileSync(currentPath, "utf8")), path: currentPath, archivedPath: null, previousIdentity: cur.identity };
      }
    }
    // ── archive previous（byte-identical; collision-safe; crash-safe）────
    const arch = archivePreviousLatest({ surfaceDir: dir, archiveDir: archiveDir ?? undefined, lock: ownLock });
    if (!arch.ok) {
      return { ok: false, holdCode: EXECUTION_REVIEW_HOLDS.PUBLISH_FAILED, reason: `latest_rotate_failed:${arch.reason}` };
    }
    // ── publication record + footer（identity + content sha）────────────
    // The external-review inbox is resolved via the authoritative
    // currentSurfaceReviewStatus（env-overridable, same as the inbox CLI）so
    // the record is honest in tests as well; this module NEVER mutates it.
    const inboxCard = inboxOccupant !== null && inboxOccupant !== undefined
      ? inboxOccupant
      : (currentSurfaceReviewStatus().cardId ?? "NONE");
    const content = renderExecutionReview({ ...source, generatedAt: generatedAt ?? source.generatedAt ?? new Date().toISOString() }, {
      previousIdentity: arch.previousIdentity ?? "NONE",
      archivedPath: arch.archivedPath ?? "NONE",
      newIdentity: identity,
      inboxOccupant: inboxCard === null || inboxCard === undefined ? "NONE" : inboxCard,
      barrierResult: barrierResult ?? "PASS",
    });
    const sha256 = executionReviewContentSha256(content);
    if (!sha256) {
      return { ok: false, holdCode: EXECUTION_REVIEW_HOLDS.GENERATION_FAILED, reason: "EXECUTION_REVIEW_GENERATION_FAILED:terminator_missing" };
    }
    const fullText = `${content}REVIEW_PUBLICATION_IDENTITY: ${identity}\nREVIEW_PUBLICATION_SHA256: ${sha256}\n`;
    // ── atomic publish（staging + single rename; never a partial file）───
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "review.txt"), fullText, "utf8");
    renameSync(join(staging, "review.txt"), currentPath);
    // stale staging cleanup under OUR lock
    for (const f of readdirSync(parent)) {
      if (f.startsWith(".latest-incoming-")) {
        try { rmSync(join(parent, f), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    // ── reread + recompute（fail closed on mismatch）────────────────────
    const reread = readFileSync(currentPath, "utf8");
    const reParsed = parseExecutionReviewText(reread);
    const reSha = executionReviewContentSha256(reread);
    if (reParsed.identity !== identity || reSha !== sha256) {
      return { ok: false, holdCode: EXECUTION_REVIEW_HOLDS.REREAD_MISMATCH, reason: `EXECUTION_REVIEW_REREAD_MISMATCH:identity:${reParsed.identity === identity};sha:${reSha === sha256}` };
    }
    return {
      ok: true,
      idempotent: false,
      identity,
      sha256,
      path: currentPath,
      archivedPath: arch.archivedPath ?? null,
      previousIdentity: arch.previousIdentity ?? null,
    };
  } catch (e) {
    return { ok: false, holdCode: EXECUTION_REVIEW_HOLDS.PUBLISH_FAILED, reason: `EXECUTION_REVIEW_PUBLISH_FAILED:${String(e?.message ?? e).slice(0, 200)}` };
  } finally {
    if (!lock) releaseLatestReviewLock({ lockPath, token });
  }
}

/**
 * RSL2-05 — reread/recompute verification of the published artifact.
 * `expected` may carry identity / sha256 / executionId / cardId.
 */
export function verifyLatestExecutionReview({ surfaceDir = null, expected = {} } = {}) {
  const dir = resolve(surfaceDir ?? latestReviewDir());
  const currentPath = join(dir, "review.txt");
  const errors = [];
  if (!existsSync(currentPath)) {
    errors.push("latest_review_missing");
    return { ok: false, errors, path: currentPath };
  }
  const raw = readFileSync(currentPath, "utf8");
  const parsed = parseExecutionReviewText(raw);
  const contentSha = executionReviewContentSha256(raw);
  if (!parsed.identity) errors.push("latest_review_identity_missing");
  if (!parsed.sha256) errors.push("latest_review_sha_missing");
  if (contentSha === null) {
    errors.push("latest_review_terminator_missing");
  } else if (parsed.sha256 && parsed.sha256 !== contentSha) {
    errors.push("latest_review_sha_recompute_mismatch");
  }
  if (expected.identity && parsed.identity !== expected.identity) errors.push("latest_review_identity_mismatch");
  if (expected.sha256 && parsed.sha256 !== expected.sha256) errors.push("latest_review_sha_mismatch");
  if (expected.executionId && parsed.executionId !== expected.executionId) errors.push("latest_review_execution_mismatch");
  if (expected.cardId && parsed.cardId !== expected.cardId) errors.push("latest_review_card_mismatch");
  return { ok: errors.length === 0, errors, path: currentPath, parsed };
}

export function latestExecutionReviewStatus({ surfaceDir = null } = {}) {
  const dir = resolve(surfaceDir ?? latestReviewDir());
  const currentPath = join(dir, "review.txt");
  if (!existsSync(currentPath)) {
    return { present: false, executionId: null, cardId: null, identity: null, sha256: null, path: currentPath };
  }
  const parsed = parseExecutionReviewText(readFileSync(currentPath, "utf8"));
  return { present: true, ...parsed, path: currentPath };
}

// ---------------------------------------------------------------------------
// RSL2-03 — admission-derived review requirement（authoritative projection）.
// ---------------------------------------------------------------------------

/**
 * The frozen RSL1/RSL2 contract: EVERY formal execution（= an execution under
 * a frozen admission — the only production path）must publish an execution
 * review to Latest before its terminal transition may complete. The caller's
 * `closeout.requiresReview` declaration is at most an input to the external-
 * review（Domain B）decision; the execution-review（Domain A）requirement is
 * derived from the authoritative admission record here — never from the
 * caller. The admission schema pins review_surface_policy.authoritative_
 * single_surface === true for every admitted execution, so admitted executions
 * are universally review-publishing.
 */
export function deriveExecutionReviewRequirement(admission = null) {
  if (!admission || typeof admission !== "object") {
    return { required: false, source: "none", reason: "no_admission" };
  }
  return {
    required: true,
    source: "admission",
    admissionId: admission.admission_id ?? null,
    reviewPolicyStrength: admission.review_policy?.strength ?? null,
    externalReviewRequired: admission.review_policy?.external_review_required ?? false,
    reviewSurfacePolicy: admission.review_surface_policy ?? null,
  };
}

/** Structured execution-review source built from a graph terminal view. */
export function buildGraphExecutionReviewSource({ graphView = null, admission = null, closeout = null, repoPath = null, cwd = null } = {}) {
  const execId = graphView?.executionId ?? "unknown-graph";
  const outcome = graphView?.final ?? "HOLD";
  const nodes = (graphView?.nodeResults ?? []).filter(Boolean);
  const req = deriveExecutionReviewRequirement(admission);
  let facts = null;
  try {
    facts = repoPath ? collectRepoFacts(repoPath) : null;
  } catch { /* repo facts unavailable — leave null; the review records what it can */ }
  const files = closeout?.cardFiles ?? {};
  return {
    schema: EXECUTION_REVIEW_SOURCE_SCHEMA,
    execution: {
      executionId: execId,
      cardId: closeout?.cardId ?? execId,
      cardTitle: closeout?.cardTitle ?? "Formal agent execution",
      outcome,
      holdCode: graphView?.holdCode ?? null,
      reason: graphView?.reason ?? null,
    },
    objective: closeout?.objective ?? null,
    repository: facts
      ? { repository: facts.repository, branch: facts.branch, head: facts.head, treeSha: facts.treeSha, worktreePath: facts.worktreePath }
      : null,
    workSummary: closeout?.executiveSummary
      ?? `${nodes.length} node(s) in ${execId}; outcome ${outcome}${graphView?.reason ? ` (${graphView.reason})` : ""}`,
    mutations: {
      added: Array.isArray(files.added) ? files.added : [],
      modified: Array.isArray(files.modified) ? files.modified : [],
      deleted: Array.isArray(files.deleted) ? files.deleted : [],
    },
    tests: Array.isArray(closeout?.regression) ? closeout.regression : [],
    findings: Array.isArray(closeout?.negativeCases) ? closeout.negativeCases : [],
    designDecisions: Array.isArray(closeout?.designDecisions) ? closeout.designDecisions : [],
    risks: Array.isArray(closeout?.risks) ? closeout.risks : [],
    limitations: Array.isArray(closeout?.limitations) ? closeout.limitations : [],
    nextAction: closeout?.recommendedNextStep ?? null,
    admissionRequirement: {
      required: req.required,
      admissionId: req.admissionId ?? null,
      reviewPolicyStrength: req.reviewPolicyStrength ?? null,
      externalReviewRequired: req.externalReviewRequired ?? false,
    },
    closeout: {
      externalReviewStatus: closeout?.externalReviewStatus ?? null,
    },
  };
}

/**
 * RSL2-05 — the terminal completion barrier. Returns
 * `{ required, ok, holdCode, reason, result }`. When required, a failed
 * publish / invalid source / reread mismatch makes `ok:false` — the caller
 * MUST NOT transition to COMPLETE.
 */
export async function applyExecutionReviewBarrier({
  graphView = null,
  admission = null,
  closeout = null,
  repoPath = null,
  cwd = null,
  surfaceDir = null,
  archiveDir = null,
  require = null,
  sourceBuilder = buildGraphExecutionReviewSource,
  publisher = publishExecutionReview,
  barrierResult = null,
  inboxOccupant = null,
} = {}) {
  const req = require !== null && require !== undefined
    ? { required: Boolean(require), source: "caller-override" }
    : deriveExecutionReviewRequirement(admission);
  if (!req.required || !graphView) {
    return { required: false, ok: true, holdCode: null, reason: null, result: null };
  }
  let source;
  try {
    source = await sourceBuilder({ graphView, admission, closeout, repoPath, cwd });
  } catch (e) {
    return { required: true, ok: false, holdCode: EXECUTION_REVIEW_HOLDS.SOURCE_FAILED, reason: `EXECUTION_REVIEW_SOURCE_FAILED:${String(e?.message ?? e).slice(0, 200)}`, result: null };
  }
  const result = publisher(source, { surfaceDir, archiveDir, barrierResult, inboxOccupant });
  if (!result?.ok) {
    return { required: true, ok: false, holdCode: result?.holdCode ?? EXECUTION_REVIEW_HOLDS.NOT_PUBLISHED, reason: result?.reason ?? EXECUTION_REVIEW_HOLDS.NOT_PUBLISHED, result };
  }
  return { required: true, ok: true, holdCode: null, reason: null, result };
}
