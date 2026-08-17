// src/governance/review-queue.mjs
//
// CURRENT-LATEST-REVIEW-PRESENTATION-SEMANTICS-1 — durable review LEDGER /
// queue authority, strictly separated from the Current/ presentation surface.
//
// Presentation semantics（top-level invariant）:
//   Current/ = the LATEST COMPLETED formal review bundle. A task completion
//   ALWAYS publishes its review to Current immediately — a verdict on a
//   previous review, the queue contents, or any other review's state never
//   gates publication. Verdict lifecycle NEVER controls the presentation
//   pointer.
//
// Authority separation:
//   - THIS module owns the durable REVIEW LEDGER（queue.json）: ordering,
//     pending states, verdict states, supersession, archive eligibility.
//     It does NOT decide what Current/ displays.
//   - the presentation pointer is the independent `isLatestPresented` flag
//     （+ queue.currentEntryId mirror）on the ledger entry whose bundle is
//     currently published to Current/. state == "CURRENT" does NOT exist:
//     presentation is a pointer, never a review-authority state.
//   - the review bundle + delivery/verdict record stay immutable in the
//     card's outDir + Archive/（lineage）;
//   - review-job ACCEPTED stays the sole acceptance mint（review-job.mjs）;
//   - THIS module is the single writer/owner of the ledger projection and
//     the Latest pointer — navigation, never verdict authority.
//
// Ledger entry states（PENDING REVIEWED REPAIR HOLD ARCHIVED）:
//   PENDING   — awaiting external review verdict（durable; never lost when a
//               newer review overwrites Current/）
//   REVIEWED  — PASS verdict applied, bound to bundleIdentity + bundleSha256;
//               bundle archived（terminal for the generation）
//   REPAIR    — REPAIR verdict applied（rework pending; supersession follows）
//   HOLD      — HOLD verdict applied, or conflicting identity（holdReason）
//   ARCHIVED  — legacy terminal state（migration keeps it）
// `isLatestPresented` on the entry marks the bundle CURRENTLY published to
// Current/ — the only presentation fact in the ledger.
//
// Legacy states（pre-card）are accepted on read and deterministically
// migrated: QUEUED -> PENDING, CURRENT -> PENDING, RESOLVED -> ARCHIVED,
// HOLD -> HOLD, ARCHIVED -> ARCHIVED（see migrateReviewQueue）.
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
//                      transition is surface-scoped so a shared queue file
//                      can never leak a review across surfaces）
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
//   order            = monotonic completion/publication order（never reused）
//   enqueuedAt       = ISO（persisted before Latest update — crash-safe）
//   deliveredAt      = ISO when last published to Current
//   state            = PENDING | REVIEWED | REPAIR | HOLD | ARCHIVED
//   isLatestPresented = true ONLY for the entry whose bundle is on Current/
//   verdict          = { verdict, bundleIdentity, bundleSha256, reviewedAt,
//                        findingsDigest } when resolved（identity-bound）
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

export const QUEUE_STATES = Object.freeze(["PENDING", "REVIEWED", "REPAIR", "HOLD", "ARCHIVED"]);

// Pre-CURRENT-LATEST-REVIEW-PRESENTATION-SEMANTICS-1 states, accepted on
// read（so existing ledger files stay readable）and remapped deterministically
// by migrateReviewQueue（never discarded）.
export const QUEUE_STATES_LEGACY = Object.freeze(["QUEUED", "CURRENT", "RESOLVED"]);

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
    if (!QUEUE_STATES.includes(e.state) && !QUEUE_STATES_LEGACY.includes(e.state)) return false;
    if (typeof e.order !== "number" || e.order < 1) return false;
  }
  return true;
}

/** True when the queue file still uses pre-card states（needs migration）. */
export function queueNeedsMigration(queue) {
  if (!queue) return false;
  return (queue.entries ?? []).some((e) => QUEUE_STATES_LEGACY.includes(e.state) || typeof e.isLatestPresented !== "boolean");
}

/**
 * Queue-file single-writer lock. The queue.json projection may be shared by
 * several surfaces under one review root（entries are surface-scoped）— its
 * read-modify-write cycles must serialize even when the SURFACE presentation
 * locks are per-surface. Acquire BEFORE any read→mutate→write cycle on the
 * queue and release in a finally（see the surface lock for the same
 * tmp+rename / stale-owner pattern）. Lock order is always surface → queue
 *（never the reverse）— no deadlock.
 */
export function reviewQueueLockPath(surfaceDir = null) {
  return join(reviewQueueDir(surfaceDir), ".queue.lock");
}

export function acquireQueueLock(surfaceDir = null, { spinMs = 3000, stepMs = 10 } = {}) {
  const lockPath = reviewQueueLockPath(surfaceDir);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const write = () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), { flag: "wx" });
    return { ok: true, token, lockPath };
  };
  // Bounded spin: queue critical sections are short（read→mutate→tmp+rename
  // write）and the queue file is shared by several surfaces of one root — a
  // concurrent writer should be WAITED OUT, not failed instantly（a
  // transient queue_busy would otherwise degrade concurrent deliveries）.
  const deadline = Date.now() + spinMs;
  for (;;) {
    try {
      return write();
    } catch (e) {
      if (e.code !== "EEXIST") return { ok: false, reason: `queue_lock_error:${String(e?.message ?? e).slice(0, 120)}`, lockPath };
    }
    try {
      const raw = JSON.parse(readFileSync(lockPath, "utf8"));
      if (raw?.pid && !queueOwnerAlive(raw.pid)) {
        // crashed owner — break the stale lock and retry immediately.
        rmSync(lockPath, { force: true });
        try { return write(); } catch { /* raced breaker — keep spinning */ }
      }
    } catch { /* unreadable lock — fail closed, do not guess */ }
    if (Date.now() >= deadline) {
      return { ok: false, reason: "queue_busy", lockPath };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stepMs);
  }
}

function queueOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export function releaseQueueLock({ lockPath, token } = {}) {
  if (!lockPath || !token) return;
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    if (raw?.token === token) rmSync(lockPath, { force: true });
  } catch { /* best effort */ }
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
  return { ok: true, queue: raw, path, present: true, legacy: queueNeedsMigration(raw) };
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
 *  eligible for review-ordering navigation（a shared queue file can never
 *  leak a review across surfaces）. NAVIGATION metadata only（card J）— it
 *  never controls Current publication.
 */
export function oldestPending(queue, surfaceDir = null) {
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  const pend = (queue.entries ?? []).filter((e) => e.state === "PENDING" && (!scope || e.surfaceDir === scope));
  if (pend.length === 0) return null;
  pend.sort((a, b) => a.order - b.order);
  return pend[0];
}

/** All PENDING（unresolved）entries for a surface, ordered by order. */
export function pendingEntries(queue, surfaceDir = null) {
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  return (queue.entries ?? [])
    .filter((e) => e.state === "PENDING" && (!scope || e.surfaceDir === scope))
    .sort((a, b) => a.order - b.order);
}

/** The ledger entry whose bundle is currently published to Current/（the
 *  presentation pointer）, or null when nothing is presented.
 */
export function presentedEntry(queue, surfaceDir = null) {
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  return (queue.entries ?? []).find((e) => e.isLatestPresented === true && (!scope || e.surfaceDir === scope)) ?? null;
}

/** Newest eligible formal review for a surface by completion/publication
 *  order（migration / recovery pointer; presentation semantics）. "Eligible"
 *  = the immutable bundle artifact still exists.
 */
export function newestEligibleEntry(queue, surfaceDir = null) {
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  const es = (queue.entries ?? []).filter((e) => !scope || e.surfaceDir === scope);
  if (es.length === 0) return null;
  es.sort((a, b) => b.order - a.order);
  return es[0] ?? null;
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
    // The replaced generation's verdict（if any）is preserved inside the
    // supersession record; the entry itself becomes a PENDING review for the
    // NEW generation（a superseding generation always awaits fresh review）.
    const oldVerdict = existing.verdict ?? null;
    existing.bundleIdentity = bundleIdentity;
    existing.bundleSha256 = bundleSha256;
    existing.bundlePath = bundlePath;
    existing.evidencePath = evidencePath ?? existing.evidencePath ?? null;
    existing.generation = generation ?? existing.generation ?? null;
    existing.jobId = jobId ?? existing.jobId ?? null;
    existing.supersededBy = existing.supersededBy ?? null;
    existing.supersedes = sup ? {
      reviewBundleIdentity: sup.reviewBundleIdentity,
      reviewBundleSha256: sup.reviewBundleSha256,
      bundlePath: sup.bundlePath ?? null,
      verdict: oldVerdict?.verdict ?? null,
    } : null;
    existing.state = "PENDING";
    existing.verdict = null;
    existing.holdReason = null;
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
    state: "PENDING",
    isLatestPresented: false,
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

/**
 * Mark ONE entry as the current presentation（isLatestPresented = true）and
 * clear the flag on every other entry of the same surface. `currentEntryId`
 * mirrors the pointer for backward compatibility. Presentation NEVER derives
 * from a review-authority state — this pointer is the ONLY presentation fact.
 */
export function markPresented(queue, cardId, { deliveredAt = null, now = new Date().toISOString(), surfaceDir = null } = {}) {
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  const e = findEntry(queue, cardId, scope);
  if (!e) return { ok: false, reason: `entry_missing:${cardId}`, queue };
  for (const other of queue.entries ?? []) {
    if (other === e) continue;
    if (scope && other.surfaceDir !== scope) continue;
    if (other.isLatestPresented) other.isLatestPresented = false;
  }
  e.isLatestPresented = true;
  e.updatedAt = now;
  if (deliveredAt) e.deliveredAt = deliveredAt;
  queue.currentEntryId = cardId;
  return { ok: true, entry: e, queue };
}

/** Clear the presentation pointer for a surface（no entry presented）. */
export function markUnpresented(queue, { now = new Date().toISOString(), surfaceDir = null } = {}) {
  const scope = surfaceDir ? resolve(surfaceDir) : null;
  for (const e of queue.entries ?? []) {
    if (scope && e.surfaceDir !== scope) continue;
    if (e.isLatestPresented) {
      e.isLatestPresented = false;
      e.updatedAt = now;
    }
  }
  if (queue.currentEntryId) {
    const cur = scope ? findEntry(queue, queue.currentEntryId, scope) : (queue.entries ?? []).find((en) => en.entryId === queue.currentEntryId);
    if (!cur) queue.currentEntryId = null;
  }
  return { ok: true, queue };
}

export function markArchived(queue, cardId, { now = new Date().toISOString(), surfaceDir = null } = {}) {
  // ARCHIVED is a terminal LEDGER state — it never clears the presentation
  // pointer（verdict lifecycle must not control Current/; card I）.
  return markEntryState(queue, cardId, "ARCHIVED", { now, surfaceDir });
}

export function markHold(queue, cardId, reason, { now = new Date().toISOString(), surfaceDir = null } = {}) {
  const r = markEntryState(queue, cardId, "HOLD", { now, surfaceDir });
  if (r.ok) r.entry.holdReason = reason ?? r.entry.holdReason ?? null;
  return r;
}

// ── Deterministic migration（CURRENT-LATEST-REVIEW-PRESENTATION-SEMANTICS-1
// ── card M）───────────────────────────────────────────────────────────────
//
// Existing live ledgers carry ARCHIVED / CURRENT / QUEUED（+ RESOLVED）.
// Migration NEVER discards data:
//   old CURRENT  -> PENDING（presentation pointer lost its meaning; the entry
//                   is an unresolved review awaiting a verdict）
//   old QUEUED   -> PENDING
//   old RESOLVED -> ARCHIVED（terminal）
//   old ARCHIVED -> ARCHIVED
//   old HOLD     -> HOLD
//   isLatestPresented = true ONLY for the entry the old `currentEntryId`
//                   pointed at; otherwise the newest eligible entry by
//                   completion/publication order（card M）.
// Bundle identity / sha / verdict / order / supersession are preserved
// verbatim — nothing is regenerated.

const LEGACY_TO_STATE = Object.freeze({
  QUEUED: "PENDING",
  CURRENT: "PENDING",
  RESOLVED: "ARCHIVED",
  ARCHIVED: "ARCHIVED",
  HOLD: "HOLD",
});

/**
 * Deterministic in-memory state migration. Returns { ok, queue, migrated }.
 * Idempotent — a fully migrated queue migrates nothing.
 */
export function migrateReviewQueue(queue) {
  if (!queue || !Array.isArray(queue.entries)) {
    return { ok: false, reason: "queue_absent_or_invalid", queue: null, migrated: 0 };
  }
  let migrated = 0;
  for (const e of queue.entries) {
    if (QUEUE_STATES_LEGACY.includes(e.state)) {
      e.state = LEGACY_TO_STATE[e.state] ?? "PENDING";
      migrated += 1;
    }
    if (typeof e.isLatestPresented !== "boolean") {
      e.isLatestPresented = false;
      migrated += 1;
    }
  }
  if (queue.currentEntryId) {
    const cur = queue.entries.find((e) => e.entryId === queue.currentEntryId);
    if (cur) {
      for (const e of queue.entries) e.isLatestPresented = e === cur;
      cur.isLatestPresented = true;
    } else {
      queue.currentEntryId = null;
    }
  } else {
    // no recorded presentation pointer -> derive deterministically by
    // completion/publication order（card M）: clear any stale flags first.
    for (const e of queue.entries) e.isLatestPresented = false;
  }
  // presentation pointer: when nothing is marked presented, the newest
  // eligible entry by completion/publication order is presented.
  const presented = queue.entries.filter((e) => e.isLatestPresented === true);
  if (presented.length === 0) {
    const newest = queue.entries.filter((e) => existsSync(e.bundlePath)).sort((a, b) => b.order - a.order)[0] ?? null;
    if (newest) {
      newest.isLatestPresented = true;
      queue.currentEntryId = newest.entryId;
    } else {
      queue.currentEntryId = null;
    }
  }
  return { ok: true, queue, migrated };
}

/**
 * Read + migrate + persist when the queue file still uses legacy states.
 * Idempotent; safe on every restart / write path（crash-safe migration）.
 */
export function ensureQueueMigrated(surfaceDir = null) {
  const qr = readReviewQueue(surfaceDir ?? null);
  if (!qr.ok) return { ok: false, holdCode: qr.holdCode, reason: qr.reason, queue: null, migrated: false };
  if (!qr.legacy) return { ok: true, queue: qr.queue, migrated: false, path: qr.path };
  const m = migrateReviewQueue(qr.queue);
  if (!m.ok) return { ok: false, reason: m.reason, queue: null, migrated: false };
  const w = writeReviewQueue(m.queue, { surfaceDir: surfaceDir ?? null });
  if (!w.ok) return { ok: false, holdCode: w.holdCode, reason: w.reason, queue: null, migrated: false };
  return { ok: true, queue: m.queue, migrated: true, path: qr.path };
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
  const current = presentedEntry(r.queue, scope);
  return {
    ok: true,
    queue: r.queue,
    current,
    pending: scoped.filter((e) => e.state === "PENDING").sort((a, b) => a.order - b.order),
    archived: scoped.filter((e) => e.state === "REVIEWED" || e.state === "ARCHIVED"),
    reviewed: scoped.filter((e) => e.state === "REVIEWED"),
    held: scoped.filter((e) => e.state === "HOLD" || e.state === "REPAIR"),
    latest: latest.ok ? latest.latest : null,
    latestError: latest.ok ? null : latest.reason,
    path: r.path,
  };
}
