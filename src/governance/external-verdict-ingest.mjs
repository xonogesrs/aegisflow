// src/governance/external-verdict-ingest.mjs
//
// CURRENT-LATEST-REVIEW-PRESENTATION-SEMANTICS-1 — the single production
// ingress for the external reviewer's verdict, bound to the DURABLE LEDGER.
//
//   A completes -> Current = A -> B completes -> Current = B -> reviewer
//   PASSes A -> verdict packet -> ingestExternalVerdict
//     → exact LEDGER lookup（cardId + bundleIdentity + bundleSha256; card H）
//       — the reviewed card does NOT need to be Current（card G）;
//     → verdict applied to the ledger entry（identity-bound receipt）;
//     → PASS: entry -> REVIEWED, bundle archived（from the immutable ledger
//       artifact）; Current untouched（card I — verdict lifecycle never
//       controls the presentation pointer）;
//     → REPAIR: entry -> REPAIR（supersession seam follows）;
//     → HOLD: entry -> HOLD; downstream closeout stays blocked.
//
// Authority model: the external reviewer is the verdict source; the
// Controller validates and applies. Queue / LatestHuman / internal
// independent review / bundle EXECUTIVE_STATUS can never mint a verdict.
// `acceptReviewJob`（the internal review-job ACCEPTED mint）is untouched.
//
// Idempotency + crash recovery: re-running with the SAME packet is a resume —
// the state machine continues from wherever the previous run stopped
//（apply → archive）. A replay after the lifecycle completed returns
// IDEMPOTENT / NO_DUPLICATE_TRANSITION（verified against the ledger entry
// verdict and the archive record — never a second apply/archive）. A
// DIFFERENT verdict on the same bundle fails closed
//（CONFLICTING_EXTERNAL_VERDICT）unless it is the identical packet.
//
// The reviewer never touches queue.json / Current / Archive / review-job.json
// by hand — human work is: review → verdict packet.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  readExternalReviewDeliveryRecord,
  rotateExternalReviewSurface,
  acquireExternalReviewSurfaceLock,
  releaseExternalReviewSurfaceLock,
  externalReviewSurfaceDir,
  externalReviewArchiveDir,
  recursiveCanonicalJson,
  sha256Hex,
  EXTERNAL_REVIEW_VERDICTS,
} from "./review-bundle.mjs";
import { readReviewQueue, findEntry, findEntryByIdentity, ensureQueueMigrated, presentedEntry, writeReviewQueue } from "./review-queue.mjs";

export const EXTERNAL_VERDICT_PACKET_SCHEMA = "autoloop.external-review-verdict/v1";

export const EXTERNAL_VERDICT_HANDOFF_HOLDS = Object.freeze({
  PACKET_INVALID: "EXTERNAL_VERDICT_PACKET_INVALID",
  LEDGER_TARGET_NOT_FOUND: "REVIEW_LEDGER_TARGET_NOT_FOUND",
  IDENTITY_MISMATCH: "REVIEW_VERDICT_IDENTITY_MISMATCH",
  CONFLICTING: "CONFLICTING_EXTERNAL_VERDICT",
  APPLIED_BUT_ROTATION_FAILED: "EXTERNAL_VERDICT_APPLIED_BUT_ROTATION_FAILED",
  AUTHORITY_REGRESSED: "REVIEW_AUTHORITY_INVARIANT_REGRESSED",
});

export const VERDICT_HANDOFF_IDEMPOTENT = "IDEMPOTENT";
/** Same verdict already applied to the CURRENT bundle; lifecycle continued. */
export const VERDICT_HANDOFF_NO_DUPLICATE_TRANSITION = "NO_DUPLICATE_TRANSITION";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Deterministic FINDINGS_DIGEST（D）: sha256 over the recursive-canonical
 * findings list（`["none"]` when the reviewer recorded no findings）. Same
 * packet input → same digest; the ingest recomputes it and rejects a
 * mismatch（stale / forged digest）.
 */
export function findingsDigest(findings) {
  const normalized = Array.isArray(findings) && findings.length > 0 ? findings.slice() : ["none"];
  return sha256Hex(recursiveCanonicalJson(normalized));
}

/**
 * Validate an external verdict packet against the
 * `autoloop.external-review-verdict/v1` contract（D/E）.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateVerdictPacket(packet) {
  const errors = [];
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    return { ok: false, errors: ["packet_not_object"] };
  }
  if (packet.schema !== EXTERNAL_VERDICT_PACKET_SCHEMA) errors.push(`schema_mismatch:${packet.schema}`);
  if (typeof packet.cardId !== "string" || packet.cardId.length === 0) errors.push("card_id_required");
  if (typeof packet.bundleIdentity !== "string" || !HEX64.test(packet.bundleIdentity)) errors.push("bundle_identity_malformed");
  if (typeof packet.bundleSha256 !== "string" || !HEX64.test(packet.bundleSha256)) errors.push("bundle_sha256_malformed");
  if (!EXTERNAL_REVIEW_VERDICTS.includes(packet.verdict)) errors.push(`verdict_invalid:${packet.verdict}`);
  if (typeof packet.reviewerIdentity !== "string" || packet.reviewerIdentity.length === 0) errors.push("reviewer_identity_required");
  else if (/^agent:/i.test(packet.reviewerIdentity)) errors.push("reviewer_is_agent_self");
  if (typeof packet.reviewedAt !== "string" || Number.isNaN(Date.parse(packet.reviewedAt))) errors.push("reviewed_at_required");
  const findings = packet.findings;
  if (findings !== undefined && findings !== null) {
    if (!Array.isArray(findings) || findings.some((f) => typeof f !== "string")) errors.push("findings_must_be_string_array");
  }
  if (typeof packet.findingsDigest !== "string" || !HEX64.test(packet.findingsDigest)) errors.push("findings_digest_malformed");
  else {
    const recomputed = findingsDigest(findings ?? []);
    if (recomputed !== packet.findingsDigest) errors.push(`findings_digest_mismatch:${packet.findingsDigest}!=${recomputed}`);
  }
  return { ok: errors.length === 0, errors };
}

function loadPacket(packetPath) {
  if (!packetPath || !existsSync(packetPath)) {
    return { ok: false, errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.PACKET_INVALID}:packet_file_missing:${String(packetPath)}`], packet: null };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(packetPath, "utf8"));
  } catch {
    return { ok: false, errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.PACKET_INVALID}:packet_unreadable`], packet: null };
  }
  return { ok: true, errors: [], packet: raw };
}

/**
 * Scan the flat Archive/ for a delivery record bound to the packet's bundle
 * identity. Returns the record + file name, or null.
 */
function findArchivedRecord(archiveDir, bundleIdentity) {
  if (!existsSync(archiveDir)) return null;
  for (const f of readdirSync(archiveDir)) {
    if (!f.endsWith("-delivery.json")) continue;
    try {
      const rec = readExternalReviewDeliveryRecord(join(archiveDir, f));
      if (!rec.ok) continue;
      if (rec.state?.delivery?.reviewBundleIdentity === bundleIdentity) {
        return { record: rec.state, fileName: f };
      }
    } catch { /* unreadable archive entry — skip, fail closed elsewhere */ }
  }
  return null;
}

/**
 * Idempotency / conflict resolution for a packet that does NOT bind the live
 * Current bundle（already rotated, or never was Current）:
 *   - identical verdict + findings digest already applied → IDEMPOTENT;
 *   - a DIFFERENT verdict already applied to the same bundle →
 *     CONFLICTING_EXTERNAL_VERDICT（no silent overwrite, no correction
 *     mechanism exists）;
 *   - nothing found → null（the caller fails with CURRENT_IDENTITY_MISMATCH）.
 */
function resolveAlreadyDecided({ packet, surfaceDir, archiveDir }) {
  const arch = resolve(archiveDir ?? externalReviewArchiveDir());
  const archived = findArchivedRecord(arch, packet.bundleIdentity);
  if (archived) {
    const v = archived.record?.verdict;
    if (v && v.bundleIdentity === packet.bundleIdentity) {
      if (v.verdict === packet.verdict && (v.findingsDigest ?? null) === packet.findingsDigest) {
        return { code: VERDICT_HANDOFF_IDEMPOTENT, evidence: archived };
      }
      return { code: EXTERNAL_VERDICT_HANDOFF_HOLDS.CONFLICTING, evidence: archived, reason: `verdict ${v.verdict} already applied to bundle ${packet.bundleIdentity.slice(0, 8)}` };
    }
  }
  const qr = readReviewQueue(surfaceDir ?? null);
  if (qr.ok) {
    const entry = findEntryByIdentity(qr.queue, packet.bundleIdentity);
    if (entry && entry.verdict && entry.verdict.bundleIdentity === packet.bundleIdentity) {
      const v = entry.verdict;
      if (v.verdict === packet.verdict && (v.findingsDigest ?? null) === packet.findingsDigest) {
        return { code: VERDICT_HANDOFF_IDEMPOTENT, evidence: { entry } };
      }
      return { code: EXTERNAL_VERDICT_HANDOFF_HOLDS.CONFLICTING, evidence: { entry }, reason: `verdict ${v.verdict} already applied to bundle ${packet.bundleIdentity.slice(0, 8)}` };
    }
  }
  return null;
}

/**
 * Single production ingress: read verdict → schema validate → exact DURABLE
 * LEDGER lookup（cardId + bundleIdentity + bundleSha256; card H）→ apply to
 * the ledger entry → verdict-specific lifecycle（PASS archive / REPAIR /
 * HOLD）. The verdict NEVER requires the target to be Current（card G）and
 * NEVER changes the presentation pointer（card I）.
 *
 * Crash-resume safe: identical-packet re-runs continue from the last durable
 * step（apply → archive）.
 *
 * @param {object} opts — { packet?, packetPath?, surfaceDir?, archiveDir?,
 *   agentIdentity? }
 * @returns {{ ok, code, errors, result }}
 *   result: { status, packet, currentBefore, archived, promoted:null,
 *             currentAfter, previousArchiveRecord? }
 */
export async function ingestExternalVerdict({ packet = null, packetPath = null, surfaceDir = null, archiveDir = null, agentIdentity = null } = {}) {
  const dir = resolve(surfaceDir ?? externalReviewSurfaceDir());
  const arch = resolve(archiveDir ?? externalReviewArchiveDir());
  let loaded;
  if (packet === null && packetPath !== null) {
    loaded = loadPacket(packetPath);
    if (!loaded.ok) return { ok: false, code: EXTERNAL_VERDICT_HANDOFF_HOLDS.PACKET_INVALID, errors: loaded.errors, result: null };
    packet = loaded.packet;
  }
  const check = validateVerdictPacket(packet);
  if (!check.ok) {
    return { ok: false, code: EXTERNAL_VERDICT_HANDOFF_HOLDS.PACKET_INVALID, errors: check.errors.map((e) => `${EXTERNAL_VERDICT_HANDOFF_HOLDS.PACKET_INVALID}:${e}`), result: null };
  }

  const lock = acquireExternalReviewSurfaceLock(dir);
  if (!lock.ok) {
    return { ok: false, code: EXTERNAL_VERDICT_HANDOFF_HOLDS.AUTHORITY_REGRESSED, errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.AUTHORITY_REGRESSED}:${lock.reason ?? "surface_busy"}`], result: null };
  }
  try {
    const migrated = ensureQueueMigrated(dir);
    if (!migrated.ok) {
      return { ok: false, code: EXTERNAL_VERDICT_HANDOFF_HOLDS.LEDGER_TARGET_NOT_FOUND, errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.LEDGER_TARGET_NOT_FOUND}:queue_hold:${migrated.reason ?? ""}`], result: { packet, currentBefore: null } };
    }
    const queue = migrated.queue;
    const currentBefore = presentedInfo(queue, dir);
    const entry = findEntry(queue, packet.cardId, dir);
    if (!entry) {
      // already decided elsewhere（archive / queue verdict）→ idempotent/conflict
      const decided = resolveAlreadyDecided({ packet, surfaceDir: dir, archiveDir: arch });
      if (decided) {
        if (decided.code === VERDICT_HANDOFF_IDEMPOTENT) {
          return { ok: true, code: VERDICT_HANDOFF_IDEMPOTENT, errors: [], result: { status: "idempotent", packet, currentBefore, archived: [], promoted: null, currentAfter: currentBefore, previousArchiveRecord: decided.evidence } };
        }
        return { ok: false, code: decided.code, errors: [`${decided.code}:${decided.reason ?? "already_decided"}`], result: { packet, currentBefore, previousArchiveRecord: decided.evidence } };
      }
      return { ok: false, code: EXTERNAL_VERDICT_HANDOFF_HOLDS.LEDGER_TARGET_NOT_FOUND, errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.LEDGER_TARGET_NOT_FOUND}:no_ledger_entry:${packet.cardId}`], result: { packet, currentBefore } };
    }
    // exact identity binding（card H）— no guessing.
    if (entry.bundleIdentity !== packet.bundleIdentity || entry.bundleSha256 !== packet.bundleSha256) {
      const detail = [
        entry.bundleIdentity !== packet.bundleIdentity ? `identity:${entry.bundleIdentity.slice(0, 8)}!=${packet.bundleIdentity.slice(0, 8)}` : null,
        entry.bundleSha256 !== packet.bundleSha256 ? `sha:${entry.bundleSha256.slice(0, 8)}!=${packet.bundleSha256.slice(0, 8)}` : null,
      ].filter(Boolean).join(";");
      const decided = resolveAlreadyDecided({ packet, surfaceDir: dir, archiveDir: arch });
      if (decided) {
        if (decided.code === VERDICT_HANDOFF_IDEMPOTENT) {
          return { ok: true, code: VERDICT_HANDOFF_IDEMPOTENT, errors: [], result: { status: "idempotent", packet, currentBefore, archived: [], promoted: null, currentAfter: currentBefore, previousArchiveRecord: decided.evidence } };
        }
        return { ok: false, code: decided.code, errors: [`${decided.code}:${decided.reason ?? "already_decided"}`], result: { packet, currentBefore, previousArchiveRecord: decided.evidence } };
      }
      return { ok: false, code: EXTERNAL_VERDICT_HANDOFF_HOLDS.IDENTITY_MISMATCH, errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.IDENTITY_MISMATCH}:${detail}`], result: { packet, currentBefore } };
    }

    // ── already applied to this ledger generation（resume paths）─────────
    if (entry.verdict && entry.verdict.bundleIdentity === packet.bundleIdentity) {
      if (entry.verdict.verdict === packet.verdict && (entry.verdict.findingsDigest ?? null) === packet.findingsDigest) {
        return finishLifecycle({ packet, dir, arch, lock, alreadyApplied: true, currentBefore, queue });
      }
      return {
        ok: false,
        code: EXTERNAL_VERDICT_HANDOFF_HOLDS.CONFLICTING,
        errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.CONFLICTING}:verdict ${entry.verdict.verdict} already applied to bundle ${packet.bundleIdentity.slice(0, 8)}`],
        result: { packet, currentBefore },
      };
    }

    // ── apply to the durable ledger entry（authority first — a crash before
    // the archive loses nothing; resume completes the archive）───────────
    entry.verdict = {
      verdict: packet.verdict,
      reviewerIdentity: packet.reviewerIdentity,
      reviewedAt: packet.reviewedAt,
      bundleIdentity: packet.bundleIdentity,
      bundleSha256: packet.bundleSha256,
      findingsDigest: packet.findingsDigest,
    };
    entry.state = packet.verdict === "PASS" ? "REVIEWED" : packet.verdict; // REVIEWED | REPAIR | HOLD
    entry.updatedAt = new Date().toISOString();
    const wq = writeReviewQueue(queue, { surfaceDir: dir });
    if (!wq.ok) {
      return { ok: false, code: EXTERNAL_VERDICT_HANDOFF_HOLDS.APPLIED_BUT_ROTATION_FAILED, errors: [`ledger_write_failed:${wq.reason}`], result: { packet, currentBefore } };
    }
    return finishLifecycle({ packet, dir, arch, lock, alreadyApplied: false, currentBefore, queue });
  } finally {
    releaseExternalReviewSurfaceLock({ lockPath: lock.lockPath, token: lock.token });
  }
}

/** The presented ledger entry summary（presentation is never verdict authority）. */
function presentedInfo(queue, dir) {
  const e = presentedEntry(queue, dir);
  return e ? { cardId: e.cardId, bundleIdentity: e.bundleIdentity, bundleSha256: e.bundleSha256, state: e.state } : null;
}

/** Verdict-specific lifecycle（PASS archive / REPAIR / HOLD）after the
 *  verdict is durably applied to the LEDGER entry. Verdict lifecycle never
 *  controls the presentation pointer（card I）: Current stays exactly as it
 *  was; PASS additionally archives the reviewed bundle from the immutable
 *  ledger artifact（card I — never from Current files）. */
function finishLifecycle({ packet, dir, arch, lock, alreadyApplied, currentBefore, queue }) {
  const code = alreadyApplied ? VERDICT_HANDOFF_NO_DUPLICATE_TRANSITION : "APPLIED";
  if (packet.verdict !== "PASS") {
    // REPAIR / HOLD: the ledger entry is the durable state; Current untouched;
    // no archive（repair supersession runs through the sanctioned seam）.
    return {
      ok: true,
      code,
      errors: [],
      result: {
        status: packet.verdict,
        packet,
        currentBefore,
        archived: [],
        promoted: null,
        currentAfter: currentBefore,
        alreadyApplied,
        note: packet.verdict === "REPAIR" ? "verdict recorded on ledger; repair generation supersedes through the sanctioned seam" : "verdict recorded on ledger; Current unchanged; downstream blocked",
      },
    };
  }

  // ── PASS: archive the reviewed bundle from the immutable ledger artifact
  //（rotateExternalReviewSurface re-resolves the SAME ledger entry — the
  // verdict fields already applied are preserved）. Idempotent resume: a
  // completed archive is detected by the ledger state + archive record. ──
  const archivedAlready = (queue?.entries ?? []).find((e) => e.cardId === packet.cardId)?.state === "REVIEWED"
    && findArchivedRecord(arch, packet.bundleIdentity) !== null;
  if (archivedAlready) {
    return {
      ok: true,
      code,
      errors: [],
      result: { status: "PASS", packet, currentBefore, archived: [], promoted: null, currentAfter: currentBefore, alreadyApplied, note: "PASS already archived; ledger + archive complete" },
    };
  }
  const rot = rotateExternalReviewSurface({
    surfaceDir: dir,
    archiveDir: arch,
    cardId: packet.cardId,
    identity: packet.bundleIdentity,
    verdict: "PASS",
    lock,
  });
  if (!rot.ok) {
    return {
      ok: false,
      code: EXTERNAL_VERDICT_HANDOFF_HOLDS.APPLIED_BUT_ROTATION_FAILED,
      errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.APPLIED_BUT_ROTATION_FAILED}:${rot.reason}`],
      result: { status: "PASS_APPLIED", packet, currentBefore, archived: rot.archived ?? [], promoted: null, currentAfter: currentBefore },
    };
  }
  return {
    ok: true,
    code,
    errors: [],
    result: {
      status: "PASS",
      packet,
      currentBefore,
      archived: rot.archived ?? [],
      promoted: null,
      currentAfter: currentBefore,
      alreadyApplied,
      note: "verdict recorded on ledger; bundle archived; Current unchanged（presentation independent of verdicts）",
    },
  };
}
