#!/usr/bin/env node
// scripts/gov-external-review-surface.mjs
//
// RB-1H — fixed external-review delivery surface CLI.
//
// The reviewer's inbox is ONE fixed location（never scattered across per-card
// output dirs）:
//   <review surface>/Current/   the single card awaiting review
//     review-bundle.txt                  current valid bundle（atomic copy）
//     delivery.json                      delivery/verdict state（identity,
//                                        sha, supersedes, status）
//     evidence.json                      this card's closeout evidence
//   <review archive>/           flat archive of reviewed/rotated cards
//
// Env overrides（tests / CI isolation）: AEGISFLOW_REVIEW_SURFACE,
// AEGISFLOW_REVIEW_ARCHIVE.
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
//       Exit 0 iff rotated.
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
} from "../src/governance/review-bundle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const mode = process.argv.includes("--status") ? "status"
  : process.argv.includes("--deliver") ? "deliver"
    : process.argv.includes("--rotate") ? "rotate"
      : process.argv.includes("--export-for-card") ? "export-for-card" : null;

if (!mode) {
  console.error("usage: node scripts/gov-external-review-surface.mjs --status");
  console.error("       node scripts/gov-external-review-surface.mjs --deliver <bundle.txt> [--evidence <evidence.json>] [--card <id>] [--method <m>] [--attempted-at <ISO>] [--force] [--current-card <id>]");
  console.error("       node scripts/gov-external-review-surface.mjs --rotate --verdict PASS|REPAIR|HOLD [--card <id>] [--identity <hex>] [--date <YYYYMMDD>]");
  console.error("       node scripts/gov-external-review-surface.mjs --export-for-card <cardId> [--cached-path <bundle.txt>]");
  process.exit(2);
}

const SURFACE = externalReviewSurfaceDir();

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
    process.exit(0);
  }
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
  process.exit(0);
}

if (mode === "deliver") {
  const bp = arg("--deliver", null);
  const evPath = arg("--evidence", null);
  const card = arg("--card", null);
  const method = arg("--method", "external-review-surface");
  const attemptedAt = arg("--attempted-at", new Date().toISOString());
  if (!bp || !existsSync(bp)) {
    console.error("usage: node scripts/gov-external-review-surface.mjs --deliver <bundle.txt> [--evidence <evidence.json>] [--card <id>] [--method <m>] [--attempted-at <ISO>]");
    process.exit(2);
  }
  // R-13（RSL2-06）: validation can never be bypassed. A bundle that fails the
  // CURRENT validator cannot be delivered（fail-closed）— the forced path
  //（--force, reviewBundleValidated=false）is removed; it allowed an
  // unvalidated artifact to reach the inbox surface.
  const check = validateReviewBundle(bp, { authorizedDir: dirname(bp) });
  if (!check.ok) {
    console.error(`deliver_blocked valid=false holdCode=${check.holdCode ?? "null"}`);
    for (const e of check.errors ?? []) console.error(`  error: ${e}`);
    process.exit(1);
  }
  const txt = readFileSync(bp, "utf8");
  const identity = txt.match(/^REVIEW_BUNDLE_IDENTITY: ([0-9a-f]{64})$/m)?.[1] ?? null;
  const shaLines = txt.split("\n");
  const shaLine = [...shaLines].reverse().find((l) => l.startsWith("REVIEW_BUNDLE_SHA256:"));
  const sha = shaLine ? shaLine.split(":")[1]?.trim() : null;
  if (!identity || !sha) {
    console.error("deliver_blocked: bundle identity/sha256 unreadable");
    process.exit(1);
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
  console.log(`delivered=true method=${d.method} surface=${d.surfaceDir}`);
  console.log(`files: ${d.files.join(", ")}`);
  console.log(`reviewBundleIdentity: ${identity}`);
  console.log(`reviewBundleSha256: ${sha}`);
  console.log(`externalReviewStatus: ${attempted.externalReviewStatus} deliveryAttempted=${attempted.delivery.attempted}`);
  console.log("note: RECEIVED is proven solely by the external reviewer's verdict");
  process.exit(0);
}

if (mode === "rotate") {
  const verdict = arg("--verdict", null);
  const card = arg("--card", "CARD");
  const identity = arg("--identity", "unknown");
  const dateStr = arg("--date", null);
  if (!verdict || !["PASS", "REPAIR", "HOLD", "PENDING", "SUPERSEDED"].includes(verdict)) {
    console.error("usage: node scripts/gov-external-review-surface.mjs --rotate --verdict PASS|REPAIR|HOLD [--card <id>] [--identity <hex>] [--date <YYYYMMDD>]");
    process.exit(2);
  }
  const r = rotateExternalReviewSurface({ surfaceDir: SURFACE, cardId: card, identity, verdict, dateStr });
  if (!r.ok) {
    console.error(`rotate_failed: ${r.reason}`);
    process.exit(1);
  }
  console.log(`rotated=${r.archived.length} cleared=${r.cleared}`);
  for (const p of r.archived) console.log(`  archive: ${p}`);
  process.exit(0);
}
