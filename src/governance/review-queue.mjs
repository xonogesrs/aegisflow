// src/governance/review-queue.mjs
//
// REVART-LC1-REVIEW-QUEUE-AUTOMATIC-HANDOFF-REPAIR — pending-review queue
// authority.
//
// The canonical review surface（Current/）is a SINGLE slot: exactly one card
// awaits action, fail-closed. Additional formal reviews must NOT be lost or
// overwritten while that slot is occupied — they wait in a durable pending
// queue and promote to Current automatically once the occupant is resolved
// and rotated.
//
// Authority separation（this module owns ONLY the queue projection）:
//   - the review bundle + delivery/verdict record stay AUTHORITATIVE in
//     Current/delivery.json + Archive/（immutable lineage）;
//   - review-job ACCEPTED stays the sole acceptance mint（review-job.mjs）;
//   - THIS module is the single writer/owner of the pending-queue projection
//     and the Latest pointer — navigation, never verdict authority.
//
// Durable queue file（env-overridable for tests / CI isolation）:
//   AUTOLOOP_REVIEW_QUEUE  default  ~/Desktop/AutoLoop-Review/Queue/queue.json
//
// Queue entry（minimal — references immutable artifacts, never duplicates
// findings/verdict content）:
//   entryId          = cardId（one queue entry per card lineage）
//   cardId
//   surfaceDir       = the review surface this entry is bound to（queue file
//                      may co-locate several surfaces under one root; every
//                      transition/promotion is surface-scoped so a shared
//                      queue file can never leak a review across surfaces）
//   generation       = review-job generation（g0001…）when known, else null
//   jobId            = cardId.gNNNN when known, else null
//   bundleIdentity   = reviewBundleIdentity of the CURRENT generation
//   bundleSha256     = content sha of the CURRENT bundle artifact
//   bundlePath       = absolute path of the immutable bundle artifact
//   evidencePath     = absolute path of the card's evidence.json（optional）
//   supersedes       = { reviewBundleIdentity, reviewBundleSha256,
//                       bundlePath } of the superseded generation
//   supersededBy     = { identity, entryId } when a later generation replaced
//                       this one
//   order            = monotonic FIFO order（never reused）
//   enqueuedAt       = ISO（persisted before Latest update — crash-safe）
//   deliveredAt      = ISO when promoted to Current
//   state            = QUEUED | CURRENT | RESOLVED | ARCHIVED | HOLD
//   verdict          = { verdict, bundleIdentity, bundleSha256, reviewedAt }
//                      reference when resolved（authority stays in Archive/）
//   holdReason       = string when HOLD
//
// Latest pointer file（navigation ONLY — "what is the newest formal review
// generated", NEVER "what blocks the queue"）:
//   AUTOLOOP_REVIEW_QUEUE  default  ~/Desktop/AutoLoop-Review/Queue/latest.json
//   schema autoloop.review-queue-latest/v1
//
// The harness Latest/review.txt（Domain A execution review, rsl2 branch）is a
// SEPARATE authority domain and is deliberately NOT touched here — this is
// the explicit bridge for the external-review lifecycle（Phase 4）.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanForSecrets } from "../evidence/run-evidence-store.mjs";

export const REVIEW_QUEUE_SCHEMA = "autoloop.review-queue/v1";
export const REVIEW_QUEUE_LATEST_SCHEMA = "autoloop.review-queue-latest/v1";

export const QUEUE_STATES = Object.freeze(["QUEUED", "CURRENT", "RESOLVED", "ARCHIVED", "HOLD"]);

export const QUEUE_HOLDS = Object.freeze({
  CORRUPT: "REVIEW_QUEUE_CORRUPT",
  CONFLICT: "REVIEW_QUEUE_CONFLICT",
  UNWRITABLE: "REVIEW_QUEUE_UNWRITABLE",
  LATEST_UNWRITABLE: "REVIEW_QUEUE_LATEST_UNWRITABLE",
  PROMOTE_BLOCKED: "REVIEW_QUEUE_PROMOTE_BLOCKED",
});

/**
 * Resolve the queue directory. Env override wins（tests / CI isolation）;
 * default is the Queue/ sibling of the external-review surface root.
 */
export function reviewQueueDir(surfaceDir = null) {
  if (process.env.AUTOLOOP_REVIEW_QUEUE) return resolve(process.env.AUTOLOOP_REVIEW_QUEUE);
  if (surfaceDir) return join(dirname(resolve(surfaceDir)), "Queue");
  return join(homedir(), "Desktop", "AutoLoop-Review", "Queue");
}

export function reviewQueuePath(surfaceDir = null) {
  return join(reviewQueueDir(surfaceDir), "queue.json");
}

export function reviewLatestPath(surfaceDir = null) {
  return join(reviewQueueDir(surfaceDir), "latest.json");
}

export function emptyQueue() {
  return {
    schema: REVIEW_QUEUE_SCHEMA,
    updatedAt: null,
    nextOrder: 1,
    entries: [],
    currentEntryId: null,
    latestEntryId: null,
  };
}

/** Validate a queue record structure（fail-closed）.**/
export function isValidQueueRecord(q) {
  if (!q || typeof q !== "object") return false;
  if (q.schema !== REVIEW_QUEUE_SCHEMA) return false;
  if (!Array.isArray(q.entries)) return false;
  if (typeof q.nextOrder !== "number" || q.nextOrder < 1) return false;
  for (const e of q.entries) {
    if (!e || typeof e !== "object") return false;
    if (typeof e.cardId !== "string" || !e.cardId) return false;
    if (typeof e.bundleIdentity !== "string" || !/^[0-9a-f]{64}$/.test(e.bundleIdentity)) return false;
    if (typeof e.bundleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.bundleSha256)) return false;
    if (typeof e.bundlePath !== "string" || !e.bundlePath) return false;
    if (!QUEUE_STATES.includes(e.state)) return false;
    if (typeof e.order !== "number" || e.order < 1) return false;
  }
  return true;
}

/**
 * Read the durable queue（fail-closed）. Missing file = empty queue（valid）;
 * present-but-corrupt = { ok:false, holdCode: REVIEW_QUEUE_CORRUPT } — never
 * silently discard entries.
 */
export function readReviewQueue(surfaceDir = null) {
  const path = reviewQueuePath(surfaceDir);
  if (!existsSync(path)) return { ok: true, queue: emptyQueue(), path, present: false };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, holdCode: QUEUE_HOLDS.CORRUPT, reason: "REVIEW_QUEUE_CORRUPT:unreadable_json", path, present: true };
  }
  if (!isValidQueueRecord(raw)) {
    return { ok: false, holdCode: QUEUE_HOLDS.CORRUPT, reason: "REVIEW_QUEUE_CORRUPT:invalid_schema", path, present: true };
  }
  return { ok: true, queue: raw, path, present: true };
}

/**
 * Atomically persist the queue（tmp + rename; secret-scanned; path-escape
 * checked）. Single writer/owner — callers MUST hold the surface lock.
 */
export function writeReviewQueue(queue, { surfaceDir = null } = {}) {
  if (!queue) return { ok: false, holdCode: QUEUE_HOLDS.UNWRITABLE, reason: "REVIEW_QUEUE_UNWRITABLE:queue_absent" };
  const dir = reviewQueueDir(surfaceDir);
  const target = join(dir, "queue.json");
  mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(queue, null, 2) + "\n";
  const scan = scanForSecrets(text);
  if (!scan.safe) {
    return { ok: false, holdCode: QUEUE_HOLDS.UNWRITABLE, reason: `REVIEW_QUEUE_UNWRITABLE:secret:${scan.matches.join(",")}` };
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return { ok: false, holdCode: QUEUE_HOLDS.UNWRITABLE, reason: `REVIEW_QUEUE_UNWRITABLE:${String(e?.message ?? e).slice(0, 200)}` };
  }
  return { ok: true, path: target };
}

// ── Entry helpers ────────────────────────────────────────────────────────

export function findEntry(queue, cardId, surfaceDir = null) {
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  return (queue.entries ?? []).find((e) => e.cardId === cardId && (!scope || e.surfaceDir === scope)) ?? null;
}

export function findEntryByIdentity(queue, bundleIdentity) {
  return (queue.entries ?? []).find((e) => e.bundleIdentity === bundleIdentity) ?? null;
}

/** Surface-scoped pending selection: only entries bound to THIS surface are
 *  eligible for promotion（a shared queue file can never leak a review
 *  across surfaces）.
 */
export function oldestPending(queue, surfaceDir = null) {
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  const pend = (queue.entries ?? []).filter((e) => e.state === "QUEUED" && (!scope || e.surfaceDir === scope));
  if (pend.length === 0) return null;
  pend.sort((a, b) => a.order - b.order);
  return pend[0];
}

export function newestEntry(queue, surfaceDir = null) {
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  const es = (queue.entries ?? []).filter((e) => !scope || e.surfaceDir === scope);
  if (es.length === 0) return null;
  es.sort((a, b) => b.order - a.order);
  return es[0];
}

/** Deterministic FIFO order for the next enqueue（monotonic, never reused）.**/
export function nextOrder(queue) {
  return queue.nextOrder;
}

/**
 * Upsert a pending-queue entry for a card lineage（one entry per card）.
 *
 * Return codes:
 *   enqueued   — new entry appended（QUEUED）
 *   idempotent — same bundle identity already queued/current（no duplicate;
 *                reuses the existing entry）— T7
 *   superseded — the incoming bundle supersedes the entry's CURRENT
 *                generation: the entry is UPDATED to the successor generation
 *                in place（position/order preserved; supersession history
 *                kept）— T9
 *   conflict   — same card, different bundle identity, NO valid supersession:
 *                HOLD（fail-closed; never enqueue both as independent work）—
 *                T8
 */
export function upsertQueueEntry(queue, {
  cardId,
  surfaceDir = null,
  generation = null,
  jobId = null,
  bundleIdentity,
  bundleSha256,
  bundlePath,
  evidencePath = null,
  supersedes = null,
  now = new Date().toISOString(),
}) {
  if (!cardId || !bundleIdentity || !bundleSha256 || !bundlePath) {
    return { ok: false, code: "invalid_entry", reason: "queue_entry_incomplete", queue };
  }
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  const existing = findEntry(queue, cardId, scope);
  if (existing) {
    if (existing.bundleIdentity === bundleIdentity && existing.bundleSha256 === bundleSha256) {
      return { ok: true, code: "idempotent", entry: existing, queue };
    }
    // supersession: the incoming bundle must explicitly supersede the entry's
    // current generation（identity AND sha binding）.
    const sup = supersedes ?? null;
    const validSupersession = sup
      && sup.reviewBundleIdentity === existing.bundleIdentity
      && sup.reviewBundleSha256 === existing.bundleSha256;
    if (!validSupersession) {
      existing.state = "HOLD";
      existing.holdReason = `conflicting_identity:${existing.bundleIdentity}!=${bundleIdentity}_without_valid_supersession`;
      existing.updatedAt = now;
      return { ok: true, code: "conflict", entry: existing, queue };
    }
    // supersede in place — position preserved; the obsolete generation is
    // never an independent queue entry. `supersedes` references the replaced
    // generation（the binding the incoming bundle explicitly supersedes）.
    existing.bundleIdentity = bundleIdentity;
    existing.bundleSha256 = bundleSha256;
    existing.bundlePath = bundlePath;
    existing.evidencePath = evidencePath ?? existing.evidencePath ?? null;
    existing.generation = generation ?? existing.generation ?? null;
    existing.jobId = jobId ?? existing.jobId ?? null;
    existing.supersededBy = existing.supersededBy ?? null;
    existing.supersedes = sup ? { reviewBundleIdentity: sup.reviewBundleIdentity, reviewBundleSha256: sup.reviewBundleSha256, bundlePath: sup.bundlePath ?? null } : null;
    existing.updatedAt = now;
    return { ok: true, code: "superseded", entry: existing, queue };
  }
  const entry = {
    entryId: cardId,
    cardId,
    surfaceDir: scope,
    generation,
    jobId,
    bundleIdentity,
    bundleSha256,
    bundlePath,
    evidencePath,
    supersedes: supersedes ?? null,
    supersededBy: null,
    order: queue.nextOrder,
    enqueuedAt: now,
    deliveredAt: null,
    state: "QUEUED",
    verdict: null,
    holdReason: null,
    updatedAt: now,
  };
  queue.entries.push(entry);
  queue.nextOrder += 1;
  return { ok: true, code: "enqueued", entry, queue };
}

export function markEntryState(queue, cardId, state, { deliveredAt = null, verdict = null, now = new Date().toISOString(), surfaceDir = null } = {}) {
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  const e = findEntry(queue, cardId, scope);
  if (!e) return { ok: false, reason: `entry_missing:${cardId}`, queue };
  if (!QUEUE_STATES.includes(state)) return { ok: false, reason: `invalid_state:${state}`, queue };
  e.state = state;
  e.updatedAt = now;
  if (deliveredAt) e.deliveredAt = deliveredAt;
  if (verdict) e.verdict = verdict;
  return { ok: true, entry: e, queue };
}

export function markCurrent(queue, cardId, { deliveredAt = null, now = new Date().toISOString(), surfaceDir = null } = {}) {
  const r = markEntryState(queue, cardId, "CURRENT", { deliveredAt, now, surfaceDir });
  if (r.ok) queue.currentEntryId = cardId;
  return r;
}

export function markArchived(queue, cardId, { now = new Date().toISOString(), surfaceDir = null } = {}) {
  const r = markEntryState(queue, cardId, "ARCHIVED", { now, surfaceDir });
  if (r.ok && queue.currentEntryId === cardId) queue.currentEntryId = null;
  return r;
}

export function markHold(queue, cardId, reason, { now = new Date().toISOString(), surfaceDir = null } = {}) {
  const r = markEntryState(queue, cardId, "HOLD", { now, surfaceDir });
  if (r.ok) r.entry.holdReason = reason ?? r.entry.holdReason ?? null;
  return r;
}

// ── Latest pointer（navigation only; NEVER verdict authority）─────────────

/**
 * Update the Latest pointer to the newest formal review generation. This is
 * a convenience navigation projection — a failure to write it MUST NOT lose
 * or invalidate the queue entry（Phase 6: Latest failure does not block
 * review authority）.
 */
export function writeLatestPointer({ cardId, generation = null, jobId = null, bundleIdentity, bundleSha256, bundlePath, supersedes = null, order = null }, { surfaceDir = null, now = new Date().toISOString() } = {}) {
  const dir = reviewQueueDir(surfaceDir);
  const target = join(dir, "latest.json");
  const latest = {
    schema: REVIEW_QUEUE_LATEST_SCHEMA,
    updatedAt: now,
    cardId,
    generation,
    jobId,
    bundleIdentity,
    bundleSha256,
    bundlePath,
    supersedes: supersedes ?? null,
    order,
  };
  const text = JSON.stringify(latest, null, 2) + "\n";
  const scan = scanForSecrets(text);
  if (!scan.safe) {
    return { ok: false, holdCode: QUEUE_HOLDS.LATEST_UNWRITABLE, reason: `REVIEW_QUEUE_LATEST_UNWRITABLE:secret:${scan.matches.join(",")}` };
  }
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
  } catch (e) {
    return { ok: false, holdCode: QUEUE_HOLDS.LATEST_UNWRITABLE, reason: `REVIEW_QUEUE_LATEST_UNWRITABLE:${String(e?.message ?? e).slice(0, 200)}` };
  }
  return { ok: true, path: target };
}

export function readLatestPointer(surfaceDir = null) {
  const path = reviewLatestPath(surfaceDir);
  if (!existsSync(path)) return { ok: false, reason: "latest_missing", path };
  try {
    const latest = JSON.parse(readFileSync(path, "utf8"));
    if (latest?.schema !== REVIEW_QUEUE_LATEST_SCHEMA) {
      return { ok: false, reason: `latest_schema_mismatch:${latest?.schema}`, path };
    }
    return { ok: true, latest, path };
  } catch {
    return { ok: false, reason: "latest_unreadable", path };
  }
}

/**
 * Queue status summary for CLI / human routing（read-only; fail-closed on a
 * corrupt queue file）.
 */
export function reviewQueueStatus(surfaceDir = null) {
  const r = readReviewQueue(surfaceDir);
  if (!r.ok) {
    return { ok: false, holdCode: r.holdCode, reason: r.reason, queue: null, latest: null, path: r.path };
  }
  const latest = readLatestPointer(surfaceDir);
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  const scoped = (r.queue.entries ?? []).filter((e) => !scope || e.surfaceDir === scope);
  const current = (r.queue.currentEntryId ? (findEntry(r.queue, r.queue.currentEntryId) ?? null) : null);
  return {
    ok: true,
    queue: r.queue,
    current: current && (!scope || current.surfaceDir === scope) ? current : null,
    pending: scoped.filter((e) => e.state === "QUEUED").sort((a, b) => a.order - b.order),
    archived: scoped.filter((e) => e.state === "ARCHIVED" || e.state === "RESOLVED"),
    held: scoped.filter((e) => e.state === "HOLD"),
    latest: latest.ok ? latest.latest : null,
    latestError: latest.ok ? null : latest.reason,
    path: r.path,
  };
}
