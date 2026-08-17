// src/governance/external-verdict-ingest.mjs
//
// EXTERNAL-REVIEW-VERDICT-HANDOFF-1 — the single production ingress for the
// external reviewer's verdict on the CURRENT review.
//
//   Current A → external reviewer PASS / REPAIR / HOLD → verdict packet
//   → ingestExternalVerdict
//     → strict live-Current binding（cardId + bundle identity + content sha）
//     → applyExternalReviewVerdict（the authoritative receipt）
//     → PASS:    archive Current → rotate → promote the oldest eligible
//                queued review（bytes verbatim, never regenerated）
//     → REPAIR:  record the verdict; Current stays in its authoritative
//                position（the repair generation supersedes through the
//                existing sanctioned seam — never promotes an unrelated
//                queued review）
//     → HOLD:    record the verdict; Current stays; no rotate / promote;
//                downstream closeout stays blocked
//
// Authority model（C）: the external reviewer is the verdict source; the
// Controller validates and applies. Queue / LatestHuman / internal
// independent review / bundle EXECUTIVE_STATUS can never mint a verdict.
// `acceptReviewJob`（the internal review-job ACCEPTED mint）is untouched.
//
// Idempotency + crash recovery（J/L）: re-running with the SAME packet is a
// resume — the state machine continues from wherever the previous run
// stopped（apply → archive → rotate → promote → evidence）. A replay after
// the lifecycle completed returns IDEMPOTENT / NO_DUPLICATE_TRANSITION
//（verified against the archive record — never a second archive/rotate/
// promote）. A DIFFERENT verdict on the same bundle fails closed
//（CONFLICTING_EXTERNAL_VERDICT）unless it is the identical packet.
//
// The reviewer never touches queue.json / Current / Archive / review-job.json
// by hand（M）— human work is: review → verdict packet.

import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import {
  applyExternalReviewVerdict,
  readExternalReviewDeliveryRecord,
  writeExternalReviewDeliveryRecord,
  rotateExternalReviewSurface,
  reconcileReviewQueue,
  acquireExternalReviewSurfaceLock,
  releaseExternalReviewSurfaceLock,
  externalReviewSurfaceDir,
  externalReviewArchiveDir,
  bundleContentSha256,
  recursiveCanonicalJson,
  sha256Hex,
  EXTERNAL_REVIEW_VERDICTS,
} from "./review-bundle.mjs";
import { readReviewQueue, findEntryByIdentity } from "./review-queue.mjs";

export const EXTERNAL_VERDICT_PACKET_SCHEMA = "autoloop.external-review-verdict/v1";

export const EXTERNAL_VERDICT_HANDOFF_HOLDS = Object.freeze({
  PACKET_INVALID: "EXTERNAL_VERDICT_PACKET_INVALID",
  CURRENT_IDENTITY_MISMATCH: "EXTERNAL_VERDICT_CURRENT_IDENTITY_MISMATCH",
  CONFLICTING: "CONFLICTING_EXTERNAL_VERDICT",
  APPLIED_BUT_ROTATION_FAILED: "EXTERNAL_VERDICT_APPLIED_BUT_ROTATION_FAILED",
  PROMOTION_FAILED: "QUEUED_REVIEW_PROMOTION_FAILED",
  DID_NOT_ADVANCE: "EXTERNAL_VERDICT_HANDOFF_DID_NOT_ADVANCE_CURRENT",
  AUTHORITY_REGRESSED: "REVIEW_AUTHORITY_INVARIANT_REGRESSED",
});

/** Idempotent replay of the identical packet（lifecycle already complete）. */
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
 * Single production ingress（F）: read verdict → schema validate → re-read
 * live Current → strict identity bind（E）→ findings digest validate → apply
 * via applyExternalReviewVerdict（the existing authority）→ verdict-specific
 * lifecycle action（G/H/I）.
 *
 * Crash-resume safe（L）: identical-packet re-runs continue from the last
 * durable step（apply → archive → rotate → promote → evidence）.
 *
 * @param {object} opts — { packet?, packetPath?, surfaceDir?, archiveDir?,
 *   agentIdentity? }
 * @returns {{ ok, code, errors, result }}
 *   result: { status, packet, currentBefore, archived, promoted,
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
    // ── E. strict binding against the LIVE Current ──────────────────────
    const deliveryPath = join(dir, "delivery.json");
    const rec = existsSync(deliveryPath) ? readExternalReviewDeliveryRecord(deliveryPath) : { ok: false, errors: ["delivery_record_missing"], state: null, cardId: null };
    const currentBefore = rec.ok
      ? { cardId: rec.cardId, bundleIdentity: rec.state.delivery?.reviewBundleIdentity ?? null, bundleSha256: rec.state.delivery?.reviewBundleSha256 ?? null, status: rec.state.externalReviewStatus ?? null }
      : null;

    let boundToCurrent = false;
    if (rec.ok) {
      const sameCard = rec.cardId === packet.cardId;
      const sameIdentity = rec.state.delivery?.reviewBundleIdentity === packet.bundleIdentity;
      const sameSha = rec.state.delivery?.reviewBundleSha256 === packet.bundleSha256;
      // belt-and-braces: the record's sha must match the ACTUAL Current
      // bundle bytes（recomputed — never trusted from the record alone）.
      let byteSha = null;
      const bundlePath = join(dir, "review-bundle.txt");
      if (existsSync(bundlePath)) byteSha = bundleContentSha256(bundlePath);
      const bytesMatch = byteSha !== null && byteSha === packet.bundleSha256;
      boundToCurrent = sameCard && sameIdentity && sameSha && bytesMatch;
      if (!sameCard || !sameIdentity || !sameSha || !bytesMatch) {
        const detail = [
          sameCard ? null : `card:${rec.cardId}!=${packet.cardId}`,
          sameIdentity ? null : `identity:${String(rec.state.delivery?.reviewBundleIdentity ?? "?").slice(0, 8)}!=${packet.bundleIdentity.slice(0, 8)}`,
          sameSha ? null : `sha:${String(rec.state.delivery?.reviewBundleSha256 ?? "?").slice(0, 8)}!=${packet.bundleSha256.slice(0, 8)}`,
          bytesMatch ? null : "record_sha_vs_bytes_diverged",
        ].filter(Boolean).join(";");
        // already decided elsewhere（archive / queue）→ idempotent or conflict
        const decided = resolveAlreadyDecided({ packet, surfaceDir: dir, archiveDir: arch });
        if (decided) {
          if (decided.code === VERDICT_HANDOFF_IDEMPOTENT) {
            // L3: archive done but promotion may not have run — reconcile
            //（promote the oldest eligible queued review when Current is
            // empty; no-op otherwise）.
            const rec2 = reconcileReviewQueue({ surfaceDir: dir, archiveDir: arch, lock });
            return {
              ok: true,
              code: VERDICT_HANDOFF_IDEMPOTENT,
              errors: [],
              result: { status: "idempotent", packet, currentBefore, archived: [], promoted: rec2.promoted ?? null, currentAfter: null, previousArchiveRecord: decided.evidence },
            };
          }
          return { ok: false, code: decided.code, errors: [`${decided.code}:${decided.reason ?? "already_decided"}`], result: { packet, currentBefore, previousArchiveRecord: decided.evidence } };
        }
        return { ok: false, code: EXTERNAL_VERDICT_HANDOFF_HOLDS.CURRENT_IDENTITY_MISMATCH, errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.CURRENT_IDENTITY_MISMATCH}:${detail}`], result: { packet, currentBefore } };
      }
    } else {
      const decided = resolveAlreadyDecided({ packet, surfaceDir: dir, archiveDir: arch });
      if (decided) {
        if (decided.code === VERDICT_HANDOFF_IDEMPOTENT) {
          const rec2 = reconcileReviewQueue({ surfaceDir: dir, archiveDir: arch, lock });
          return { ok: true, code: VERDICT_HANDOFF_IDEMPOTENT, errors: [], result: { status: "idempotent", packet, currentBefore: null, archived: [], promoted: rec2.promoted ?? null, currentAfter: null, previousArchiveRecord: decided.evidence } };
        }
        return { ok: false, code: decided.code, errors: [`${decided.code}:${decided.reason ?? "already_decided"}`], result: { packet, currentBefore: null, previousArchiveRecord: decided.evidence } };
      }
      return { ok: false, code: EXTERNAL_VERDICT_HANDOFF_HOLDS.CURRENT_IDENTITY_MISMATCH, errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.CURRENT_IDENTITY_MISMATCH}:no_current_delivery_record`], result: { packet, currentBefore: null } };
    }

    // ── already applied to the CURRENT bundle（L1/L2 resume）─────────────
    const existing = rec.state.verdict ?? null;
    if (existing && existing.bundleIdentity === packet.bundleIdentity) {
      if (existing.verdict === packet.verdict && (existing.findingsDigest ?? null) === packet.findingsDigest) {
        // same verdict already applied — continue the lifecycle without
        // re-applying（apply is durable; never mint twice）.
        return finishLifecycle({ packet, dir, arch, lock, alreadyApplied: true, currentBefore });
      }
      return {
        ok: false,
        code: EXTERNAL_VERDICT_HANDOFF_HOLDS.CONFLICTING,
        errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.CONFLICTING}:verdict ${existing.verdict} already applied to bundle ${packet.bundleIdentity.slice(0, 8)}`],
        result: { packet, currentBefore },
      };
    }

    // ── apply through the existing authority（never bypassed）────────────
    const applied = applyExternalReviewVerdict(rec.state, {
      verdict: packet.verdict,
      bundleIdentity: packet.bundleIdentity,
      bundleSha256: packet.bundleSha256,
      reviewerIdentity: packet.reviewerIdentity,
      reviewedAt: packet.reviewedAt,
      agentIdentity: agentIdentity ?? null,
      findingsDigest: packet.findingsDigest,
    });
    if (!applied.ok) {
      return { ok: false, code: EXTERNAL_VERDICT_HANDOFF_HOLDS.PACKET_INVALID, errors: applied.errors.map((e) => `${EXTERNAL_VERDICT_HANDOFF_HOLDS.PACKET_INVALID}:${e}`), result: { packet, currentBefore } };
    }
    const written = writeExternalReviewDeliveryRecord({ outDir: dir, state: applied.state, cardId: rec.cardId, fileName: "delivery.json" });
    if (!written.ok) {
      return { ok: false, code: EXTERNAL_VERDICT_HANDOFF_HOLDS.APPLIED_BUT_ROTATION_FAILED, errors: [`record_write_failed:${written.reason}`], result: { packet, currentBefore } };
    }
    return finishLifecycle({ packet, dir, arch, lock, alreadyApplied: false, currentBefore });
  } finally {
    releaseExternalReviewSurfaceLock({ lockPath: lock.lockPath, token: lock.token });
  }
}

/** Verdict-specific lifecycle（G PASS / H REPAIR / I HOLD）after the verdict
 *  is durably applied to the Current delivery record. */
function finishLifecycle({ packet, dir, arch, lock, alreadyApplied, currentBefore }) {
  const code = alreadyApplied ? VERDICT_HANDOFF_NO_DUPLICATE_TRANSITION : "APPLIED";
  if (packet.verdict !== "PASS") {
    // REPAIR / HOLD: the record is the durable state; Current stays in its
    // authoritative position; no rotate, no promote（repair supersession
    // runs through the existing sanctioned seam）. Downstream closeout stays
    // blocked（cardExternalReviewStatus / final-closeout gate）.
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
        note: packet.verdict === "REPAIR" ? "verdict recorded; repair generation supersedes through the sanctioned seam" : "verdict recorded; Current stays; downstream blocked",
      },
    };
  }

  // ── PASS: archive Current → rotate → promote the oldest eligible ─────
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
      result: { status: "PASS_APPLIED", packet, currentBefore, archived: rot.archived ?? [], promoted: null, currentAfter: null },
    };
  }

  // verify the promotion（P5/P6）: promoted bundle bytes are verbatim — the
  // Current identity/sha must equal the promoted queue entry's.
  let promoted = rot.promoted ?? null;
  const currentAfter = { cardId: null, bundleIdentity: null, bundleSha256: null };
  const deliveryPath = join(dir, "delivery.json");
  const afterRec = existsSync(deliveryPath) ? readExternalReviewDeliveryRecord(deliveryPath) : { ok: false };
  if (afterRec.ok) {
    currentAfter.cardId = afterRec.cardId;
    currentAfter.bundleIdentity = afterRec.state.delivery?.reviewBundleIdentity ?? null;
    currentAfter.bundleSha256 = afterRec.state.delivery?.reviewBundleSha256 ?? null;
  }
  if (promoted) {
    const sameIdentity = currentAfter.bundleIdentity === promoted.bundleIdentity;
    const sameSha = currentAfter.bundleSha256 === promoted.bundleSha256;
    const bundlePath = join(dir, "review-bundle.txt");
    const bytesMatch = existsSync(bundlePath) && bundleContentSha256(bundlePath) === promoted.bundleSha256;
    if (!sameIdentity || !sameSha || !bytesMatch) {
      return {
        ok: false,
        code: EXTERNAL_VERDICT_HANDOFF_HOLDS.DID_NOT_ADVANCE,
        errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.DID_NOT_ADVANCE}:promoted_identity_mismatch`],
        result: { status: "PASS", packet, currentBefore, archived: rot.archived ?? [], promoted, currentAfter },
      };
    }
    // L4: write the missing promotion evidence only（idempotent; the trio is
    // otherwise complete）.
    if (promoted.evidencePath && existsSync(promoted.evidencePath) && !existsSync(join(dir, "evidence.json"))) {
      try {
        copyFileSync(promoted.evidencePath, join(dir, "evidence.json"));
      } catch { /* best effort — the bundle + delivery record are authoritative */ }
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
        promoted,
        currentAfter,
        alreadyApplied,
      },
    };
  }
  // no promotion: legal only when nothing is pending（PASS with empty Queue）
  const qr = readReviewQueue(dir);
  let pendingExists = false;
  if (qr.ok) {
    const entries = (qr.queue.entries ?? []).filter((e) => e.state === "QUEUED" && e.surfaceDir === resolve(dir));
    pendingExists = entries.length > 0;
  }
  if (pendingExists) {
    return {
      ok: false,
      code: EXTERNAL_VERDICT_HANDOFF_HOLDS.PROMOTION_FAILED,
      errors: [`${EXTERNAL_VERDICT_HANDOFF_HOLDS.PROMOTION_FAILED}:${rot.promotionReason ?? "pending_review_not_promoted"}`],
      result: { status: "PASS", packet, currentBefore, archived: rot.archived ?? [], promoted: null, currentAfter },
    };
  }
  return {
    ok: true,
    code,
    errors: [],
    result: { status: "PASS", packet, currentBefore, archived: rot.archived ?? [], promoted: null, currentAfter, alreadyApplied, note: "PASS with empty Queue: Current archived and left empty（legal）" },
  };
}
