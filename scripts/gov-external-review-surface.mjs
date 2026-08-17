#!/usr/bin/env node
// scripts/gov-external-review-surface.mjs
//
// RB-1H — fixed external-review delivery surface CLI.
//
// The reviewer's inbox is ONE fixed location（never scattered across per-card
// output dirs）:
//   ~/Desktop/AutoLoop-Review/Current/   the single card awaiting review
//     review-bundle.txt                  current valid bundle（atomic copy）
//     delivery.json                      delivery/verdict state（identity,
//                                        sha, supersedes, status）
//     evidence.json                      this card's closeout evidence
//   ~/Desktop/AutoLoop-Review/Archive/   flat archive of reviewed/rotated cards
//
// Env overrides（tests / CI isolation）: AUTOLOOP_REVIEW_SURFACE,
// AUTOLOOP_REVIEW_ARCHIVE.
//
//   --status
//       Print the current surface: files present + parsed delivery state.
//
//   --deliver <bundle.txt> [--evidence <evidence.json>] [--card <id>]
//       [--method <m>] [--attempted-at <ISO>] [--force]
//       Standalone surface delivery（e.g. a bundle generated before the
//       surface convention）: validates the bundle, builds the external-review
//       delivery state（supersedes parsed from the bundle's own section 14）
//       and atomically writes Current/review-bundle.txt + delivery.json +
//       evidence.json. Exit 0 iff delivered. `--force` delivers a
//       pre-convention bundle that fails the CURRENT validator — the external
//       reviewer renders the verdict on it.（transition case only; the hard
//       rule for NEW closeouts stays strict.）
//
//   --rotate --verdict PASS|REPAIR|HOLD [--card <id>] [--identity <hex>]
//       [--date <YYYYMMDD>]
//       Archive the current surface（flat naming
//       YYYYMMDD-<CARD>-<identity8>-<VERDICT>-<kind>）and clear Current/.
//       Automatically promotes the next pending review（queue handoff）.
//       Exit 0 iff rotated.
//
//   --queue
//       Print the pending-review queue（entries + state + Current/Latest
//       pointers）.
//
//   --latest
//       Print the Latest navigation pointer（newest formal review generated;
//       never verdict authority）.
//
//   --promote
//       Presentation recovery: ensure the NEWEST eligible formal review is
//       published to Current（idempotent; recovery after a crash between
//       ledger persist and publication）. NEVER an older review（stale
//       replay cannot regress Current）.
//
//   --reconcile
//       Startup reconciliation: same as --promote（crash-safe recovery on
//       every restart; card N1/N2）.
//
//   --migrate
//       Deterministic ledger migration（card M）: remap legacy states
//       （QUEUED/CURRENT/RESOLVED -> PENDING/ARCHIVED）, add the
//       isLatestPresented presentation pointer, then publish the newest
//       eligible formal review to Current. Preserves identity / sha /
//       verdict / order / supersession — never regenerates bundles.
//
// Local-only, deterministic, no network. Never commits/pushes/seals.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateReviewBundle,
  buildExternalReviewState,
  recordDeliveryAttempt,
  readExternalReviewDeliveryRecord,
  supersedesFromBundleText,
  deliverToExternalReviewSurface,
  rotateExternalReviewSurface,
  currentReviewDelivery,
  externalReviewSurfaceDir,
  promoteNextPendingReview,
  reconcileReviewQueue,
  latestReviewPointer,
} from "../src/governance/review-bundle.mjs";
import {
  reviewQueueStatus,
  reviewQueueDir,
  readReviewQueue,
  migrateReviewQueue,
  writeReviewQueue,
} from "../src/governance/review-queue.mjs";
import {
  publishHumanReport,
  readHumanReport,
  humanReportStatus,
  humanReportDir,
} from "../src/governance/human-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const mode = process.argv.includes("--status") ? "status"
  : process.argv.includes("--deliver") ? "deliver"
    : process.argv.includes("--rotate") ? "rotate"
      : process.argv.includes("--export-for-card") ? "export-for-card"
        : process.argv.includes("--queue") ? "queue"
          : process.argv.includes("--latest") ? "latest"
            : process.argv.includes("--promote") ? "promote"
              : process.argv.includes("--reconcile") ? "reconcile"
                : process.argv.includes("--migrate") ? "migrate"
                  : process.argv.includes("--human-latest") ? "human-latest"
                    : process.argv.includes("--human-publish") ? "human-publish" : null;

if (!mode) {
  console.error("usage: node scripts/gov-external-review-surface.mjs --status");
  console.error("       node scripts/gov-external-review-surface.mjs --deliver <bundle.txt> [--evidence <evidence.json>] [--card <id>] [--method <m>] [--attempted-at <ISO>] [--force] [--current-card <id>] [--identity <hex64>] [--sha256 <hex64>]");
  console.error("       node scripts/gov-external-review-surface.mjs --rotate --verdict PASS|REPAIR|HOLD --card <id> --identity <hex> [--date <YYYYMMDD>]");
  console.error("       node scripts/gov-external-review-surface.mjs --export-for-card <cardId> [--cached-path <bundle.txt>]");
  console.error("       node scripts/gov-external-review-surface.mjs --queue");
  console.error("       node scripts/gov-external-review-surface.mjs --latest");
  console.error("       node scripts/gov-external-review-surface.mjs --promote");
  console.error("       node scripts/gov-external-review-surface.mjs --reconcile");
  console.error("       node scripts/gov-external-review-surface.mjs --migrate");
  console.error("       node scripts/gov-external-review-surface.mjs --human-latest");
  console.error("       node scripts/gov-external-review-surface.mjs --human-publish <report.txt> --card <id> [--report-type operator-closeout|formal-review-bundle] [--identity <hex>] [--job <id>] [--requires-external-review true|false] [--current-review-state <s>] [--created-at <ISO>] [--published-at <ISO>] [--force]");
  process.exit(2);
}

const SURFACE = externalReviewSurfaceDir();

if (mode === "human-latest") {
  const st = humanReportStatus({ surfaceDir: SURFACE });
  if (!st.ok) {
    console.error(`human_latest_missing: ${st.reason}`);
    process.exit(1);
  }
  console.log(`dir: ${st.dir}`);
  console.log(`cardId: ${st.report.cardId}`);
  console.log(`reportType: ${st.report.reportType}`);
  console.log(`reportIdentity: ${st.report.reportIdentity}`);
  console.log(`sha256: ${st.report.sha256}`);
  console.log(`sourcePath: ${st.report.sourcePath}`);
  console.log(`requiresExternalReview: ${st.report.requiresExternalReview}`);
  console.log(`currentReviewState: ${st.report.currentReviewState ?? "(none)"}`);
  console.log(`createdAt: ${st.report.createdAt}`);
  console.log(`publishedAt: ${st.report.publishedAt}`);
  console.log(`report: ${st.textPath}`);
  process.exit(0);
}

if (mode === "human-publish") {
  const rp = arg("--human-publish", null);
  const card = arg("--card", null);
  const reportType = arg("--report-type", "operator-closeout");
  const identity = arg("--identity", null);
  const job = arg("--job", null);
  const requiresExt = arg("--requires-external-review", "false") === "true";
  const curStateRaw = arg("--current-review-state", null);
  const curState = curStateRaw === "null" || curStateRaw === "" ? null : curStateRaw;
  const createdAt = arg("--created-at", null);
  const publishedAt = arg("--published-at", new Date().toISOString());
  const force = process.argv.includes("--force");
  if (!rp || !existsSync(rp) || !card) {
    console.error("usage: node scripts/gov-external-review-surface.mjs --human-publish <report.txt> --card <id> [--report-type operator-closeout|formal-review-bundle] [--identity <hex>] [--job <id>] [--requires-external-review true|false] [--current-review-state <s>] [--created-at <ISO>] [--published-at <ISO>] [--force]");
    process.exit(2);
  }
  const r = publishHumanReport({
    cardId: card,
    jobId: job ?? null,
    reportType,
    reportIdentity: identity ?? null,
    sourcePath: rp,
    requiresExternalReview: requiresExt,
    currentReviewState: curState ?? null,
    createdAt: createdAt ?? null,
    publishedAt,
    surfaceDir: SURFACE,
    force,
  });
  if (!r.ok) {
    console.error(`human_publish_failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`published=${r.published ? "true" : "false"}${r.alreadyCurrent ? " (already current)" : ""}`);
  console.log(`cardId: ${r.report.cardId}`);
  console.log(`reportType: ${r.report.reportType}`);
  console.log(`reportIdentity: ${r.report.reportIdentity}`);
  console.log(`sha256: ${r.report.sha256}`);
  console.log(`publishedAt: ${r.report.publishedAt}`);
  console.log(`dir: ${humanReportDir(SURFACE)}`);
  process.exit(0);
}

if (mode === "queue") {
  const st = reviewQueueStatus(SURFACE);
  if (!st.ok) {
    console.error(`queue_failed: ${st.reason}`);
    process.exit(1);
  }
  console.log(`queueDir=${reviewQueueDir(SURFACE)}`);
  console.log(`current=${st.current ? `${st.current.cardId} ${st.current.bundleIdentity.slice(0, 8)}` : "(none)"}`);
  console.log(`pending=${st.pending.length}`);
  for (const e of st.pending) {
    console.log(`  [${e.order}] ${e.cardId} ${e.bundleIdentity.slice(0, 8)} enqueuedAt=${e.enqueuedAt}`);
  }
  console.log(`held=${st.held.length}`);
  for (const e of st.held) {
    console.log(`  [${e.order}] ${e.cardId} reason=${e.holdReason ?? "(none)"}`);
  }
  console.log(`archived=${st.archived.length}`);
  if (st.latest) {
    console.log(`latest=${st.latest.cardId} ${st.latest.bundleIdentity.slice(0, 8)} updatedAt=${st.latest.updatedAt}`);
  } else {
    console.log(`latest=(none)${st.latestError ? ` (${st.latestError})` : ""}`);
  }
  process.exit(0);
}

if (mode === "latest") {
  const l = latestReviewPointer({ surfaceDir: SURFACE });
  if (!l.ok) {
    console.error(`latest_missing: ${l.reason}`);
    process.exit(1);
  }
  console.log(`cardId: ${l.latest.cardId}`);
  console.log(`reviewBundleIdentity: ${l.latest.bundleIdentity}`);
  console.log(`reviewBundleSha256: ${l.latest.bundleSha256}`);
  console.log(`bundle: ${l.latest.bundlePath}`);
  console.log(`updatedAt: ${l.latest.updatedAt}`);
  process.exit(0);
}

if (mode === "promote" || mode === "reconcile") {
  const r = mode === "promote"
    ? promoteNextPendingReview({ surfaceDir: SURFACE })
    : reconcileReviewQueue({ surfaceDir: SURFACE });
  if (!r.ok) {
    console.error(`${mode}_failed: ${r.reason}`);
    process.exit(1);
  }
  if (r.promoted) {
    console.log(`promoted=${r.promoted.cardId} identity=${r.promoted.bundleIdentity.slice(0, 8)} deliveredAt=${r.promoted.deliveredAt}`);
  } else {
    console.log(`promoted=(none) reason=${r.reason ?? "already_current"}`);
  }
  process.exit(0);
}

if (mode === "migrate") {
  const qr = readReviewQueue(SURFACE);
  if (!qr.ok) {
    console.error(`migrate_failed: ${qr.reason}`);
    process.exit(1);
  }
  const m = migrateReviewQueue(qr.queue);
  if (!m.ok) {
    console.error(`migrate_failed: ${m.reason}`);
    process.exit(1);
  }
  const w = writeReviewQueue(m.queue, { surfaceDir: SURFACE });
  if (!w.ok) {
    console.error(`migrate_failed: ${w.reason}`);
    process.exit(1);
  }
  console.log(`migrated=${m.migrated} entries=${m.queue.entries.length}`);
  // publish the newest eligible formal review to Current（card M presentation
  // pointer; recovery-safe）.
  const rec = reconcileReviewQueue({ surfaceDir: SURFACE });
  if (!rec.ok) {
    console.error(`migrate_publish_failed: ${rec.reason}`);
    process.exit(1);
  }
  console.log(`presented=${rec.promoted ? `${rec.promoted.cardId} ${rec.promoted.bundleIdentity.slice(0, 8)}` : "(none)"}`);
  process.exit(0);
}

if (mode === "export-for-card") {
  // RLD2 repair — the AUTHORITATIVE export surface for the controller-facing
  // delivery/attachment step: identity + sha + already-reviewed verification,
  // fail-closed. Never a filename/mtime/newest-file selection.
  const cardId = arg("--export-for-card", null);
  const cachedPath = arg("--cached-path", null);
  if (!cardId) {
    console.error("usage: node scripts/gov-external-review-surface.mjs --export-for-card <cardId> [--cached-path <bundle.txt>]");
    process.exit(2);
  }
  const r = currentReviewDelivery({ surfaceDir: SURFACE, currentCardId: cardId, cachedPath: cachedPath || null });
  if (!r.ok) {
    console.log(`cardId=${cardId}`);
    console.log(`status=${r.holdCode}`);
    console.log(`reason=${r.reason}`);
    console.log(`bundle=(none)`);
    process.exit(2);
  }
  console.log(`cardId=${r.bundle.cardId}`);
  console.log(`status=${r.bundle.status ?? "VERIFIED"}`);
  console.log(`reviewBundleIdentity=${r.bundle.identity}`);
  console.log(`reviewBundleSha256=${r.bundle.sha256}`);
  console.log(`bundle=${r.bundle.path}`);
  console.log(`source=${r.source}`);
  process.exit(0);
}

if (mode === "status") {
  if (!existsSync(SURFACE)) {
    console.log(`surface=${SURFACE}`);
    console.log("files: (none)");
  } else {
    console.log(`surface=${SURFACE}`);
    const files = readdirSync(SURFACE).filter((f) => !f.startsWith(".")).sort();
    console.log(`files: ${files.length ? files.join(", ") : "(none)"}`);
    const recPath = join(SURFACE, "delivery.json");
    if (existsSync(recPath)) {
      const rec = readExternalReviewDeliveryRecord(recPath);
      if (rec.ok) {
        console.log(`cardId: ${rec.cardId ?? "?"}`);
        console.log(`externalReviewStatus: ${rec.state.externalReviewStatus}`);
        console.log(`reviewBundleIdentity: ${rec.state.delivery?.reviewBundleIdentity}`);
        console.log(`reviewBundleSha256: ${rec.state.delivery?.reviewBundleSha256}`);
        console.log(`supersedes: ${rec.state.supersedes?.reviewBundleIdentity ?? "(none)"}`);
        if (rec.state.verdict) console.log(`verdict: ${rec.state.verdict.verdict} reviewer=${rec.state.verdict.reviewerIdentity} reviewedAt=${rec.state.verdict.reviewedAt}`);
      } else {
        console.log(`delivery.json: unreadable (${rec.errors.join(";")})`);
      }
    }
  }
  // queue summary（REVART-LC1）— distinct routing answer for "what else is
  // waiting?" / "what is the newest formal review?"
  const st = reviewQueueStatus(SURFACE);
  if (st.ok) {
    console.log(`queueDir=${reviewQueueDir(SURFACE)}`);
    console.log(`queuePending=${st.pending.length} queueHeld=${st.held.length}`);
    if (st.pending.length) {
      for (const e of st.pending) {
        console.log(`  pending [${e.order}] ${e.cardId} ${e.bundleIdentity.slice(0, 8)} enqueuedAt=${e.enqueuedAt}`);
      }
    }
    if (st.held.length) {
      for (const e of st.held) {
        console.log(`  held [${e.order}] ${e.cardId} reason=${e.holdReason ?? "(none)"}`);
      }
    }
    if (st.latest) {
      console.log(`latest=${st.latest.cardId} ${st.latest.bundleIdentity.slice(0, 8)} updatedAt=${st.latest.updatedAt}`);
    }
  } else {
    console.log(`queue: unreadable (${st.reason})`);
  }
  process.exit(0);
}

if (mode === "deliver") {
  const bp = arg("--deliver", null);
  const evPath = arg("--evidence", null);
  const card = arg("--card", null);
  const method = arg("--method", "external-review-surface");
  const attemptedAt = arg("--attempted-at", new Date().toISOString());
  const force = process.argv.includes("--force");
  if (!bp || !existsSync(bp)) {
    console.error("usage: node scripts/gov-external-review-surface.mjs --deliver <bundle.txt> [--evidence <evidence.json>] [--card <id>] [--method <m>] [--attempted-at <ISO>] [--force]");
    process.exit(2);
  }
  const check = validateReviewBundle(bp, { authorizedDir: dirname(bp) });
  if (!check.ok && !force) {
    console.error(`deliver_blocked valid=false holdCode=${check.holdCode ?? "null"}`);
    for (const e of check.errors ?? []) console.error(`  error: ${e}`);
    console.error("  (use --force to deliver a pre-convention bundle that fails the CURRENT validator —") ;
    console.error("   the external reviewer is the one who renders the verdict on it)");
    process.exit(1);
  }
  if (!check.ok) {
    console.error(`deliver_forced valid=false（validator: ${check.errors.join(";")}）`);
  }
  const txt = readFileSync(bp, "utf8");
  let identity = txt.match(/^REVIEW_BUNDLE_IDENTITY: ([0-9a-f]{64})$/m)?.[1] ?? null;
  const shaLines = txt.split("\n");
  const shaLine = [...shaLines].reverse().find((l) => l.startsWith("REVIEW_BUNDLE_SHA256:"));
  let sha = shaLine ? shaLine.split(":")[1]?.trim() : null;
  // forced（transition）delivery of a pre-convention bundle that carries no
  // identity footer: the operator supplies the content identities explicitly
  //（deterministic; e.g. sha256 of the bundle bytes）. Never guessed.
  if (!identity || !sha) {
    const idArg = arg("--identity", null);
    const shaArg = arg("--sha256", null);
    const hex64 = /^[0-9a-f]{64}$/;
    if (!force || !idArg || !shaArg || !hex64.test(idArg) || !hex64.test(shaArg)) {
      console.error("deliver_blocked: bundle identity/sha256 unreadable — supply --force --identity <hex64> --sha256 <hex64> for a pre-convention bundle");
      process.exit(1);
    }
    identity = identity ?? idArg;
    sha = sha ?? shaArg;
  }
  const parsedSup = supersedesFromBundleText(txt);
  if (parsedSup.error) {
    console.error(`deliver_blocked: ${parsedSup.error}`);
    process.exit(1);
  }
  const state = buildExternalReviewState({ bundle: { identity, sha256: sha }, bundlePath: bp, supersedes: parsedSup.supersedes });
  if (force) {
    // honest record for a forced（transition）delivery: the bundle is NOT
    // valid under the CURRENT validator — the external reviewer renders the
    // verdict on it.
    state.reviewBundleValidated = false;
    state.externalReviewStatusReason = `forced_delivery:pre_convention_bundle_rejected_by_current_validator:${check.errors.join(";")}`;
  }
  const attempted = recordDeliveryAttempt(state, { method, attemptedAt });
  const currentCard = arg("--current-card", null);
  if (currentCard && card && card !== currentCard) {
    console.error(`deliver_blocked: delivery_card_id_mismatch:${card}!=${currentCard}`);
    process.exit(1);
  }
  const source = {
    task: { cardId: card ?? "UNKNOWN-CARD" },
    evidence: evPath && existsSync(evPath) ? [{ path: evPath, sha256: "0".repeat(64) }] : [],
  };
  const d = deliverToExternalReviewSurface({ bundlePath: bp, state: attempted, source, surfaceDir: SURFACE, ...(currentCard ? { currentCardId: currentCard } : {}) });
  if (!d.attempted) {
    console.error(`deliver_failed: ${d.reason}`);
    process.exit(1);
  }
  if (d.queued) {
    // Only reachable for an OLDER completion replay（staleReplay）: the
    // ledger entry stays durable; the presentation is never regressed.
    console.log(`delivered=true queued=true staleReplay=true method=${d.method} surface=${d.surfaceDir}`);
    console.log(`queueEntry=${d.entryId} order=${d.order}`);
    console.log(`reviewBundleIdentity: ${identity}`);
    console.log(`reviewBundleSha256: ${sha}`);
    console.log(`externalReviewStatus: ${attempted.externalReviewStatus} deliveryAttempted=${attempted.delivery.attempted}`);
    if (d.latestError) console.log(`latestWarning: ${d.latestError}`);
    console.log("note: older completion replay — ledger entry durable; Current NOT regressed（stale-replay guard, card N4）");
    process.exit(0);
  }
  console.log(`delivered=true method=${d.method} surface=${d.surfaceDir}`);
  console.log(`files: ${(d.files ?? []).join(", ")}`);
  console.log(`reviewBundleIdentity: ${identity}`);
  console.log(`reviewBundleSha256: ${sha}`);
  console.log(`externalReviewStatus: ${attempted.externalReviewStatus} deliveryAttempted=${attempted.delivery.attempted}`);
  if (d.latestError) console.log(`latestWarning: ${d.latestError}`);
  console.log("note: RECEIVED is proven solely by the external reviewer's verdict");
  process.exit(0);
}

if (mode === "rotate") {
  const verdict = arg("--verdict", null);
  const card = arg("--card", null);
  const identity = arg("--identity", null);
  const dateStr = arg("--date", null);
  if (!verdict || !["PASS", "REPAIR", "HOLD"].includes(verdict) || !card || !identity) {
    console.error("usage: node scripts/gov-external-review-surface.mjs --rotate --verdict PASS|REPAIR|HOLD --card <id> --identity <hex> [--date <YYYYMMDD>]");
    process.exit(2);
  }
  const r = rotateExternalReviewSurface({ surfaceDir: SURFACE, cardId: card, identity, verdict, dateStr });
  if (!r.ok) {
    console.error(`rotate_failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`rotated=${r.archived.length} verdict=${verdict}`);
  for (const p of r.archived) console.log(`  archive: ${p}`);
  console.log("note: verdict applied to the durable ledger entry; Current unchanged (presentation independent of verdicts)");
  process.exit(0);
}
