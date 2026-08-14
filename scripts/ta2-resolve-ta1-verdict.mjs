#!/usr/bin/env node
// scripts/ta2-resolve-ta1-verdict.mjs
//
// TA-2 — resolve the TA-1 external-review occupant on the fixed surface with
// the Controller's PASS verdict（provided 2026-08-09; see the TA-2 card
// opening message）. The resolution is the standard surface rotation: the
// Current/ trio is archived with a PASS label + a verdict record; nothing is
// deleted. This frees the single authoritative surface for the TA-2 card's
// own closeout delivery（one-card-one-review-surface: one card owns the
// surface at a time）.
//
// Run: node scripts/ta2-resolve-ta1-verdict.mjs

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  externalReviewSurfaceDir,
  externalReviewArchiveDir,
  rotateExternalReviewSurface,
  acquireExternalReviewSurfaceLock,
  releaseExternalReviewSurfaceLock,
} from "../src/governance/review-bundle.mjs";

const SURFACE = externalReviewSurfaceDir();
const ARCHIVE = externalReviewArchiveDir();

const deliveryPath = join(SURFACE, "delivery.json");
if (!existsSync(deliveryPath)) {
  console.error("no delivery.json on the surface — nothing to resolve");
  process.exit(2);
}
const delivery = JSON.parse(readFileSync(deliveryPath, "utf8"));
const cardId = delivery.cardId ?? "AUTOLOOP-TA1";
const identity = delivery.delivery?.reviewBundleIdentity ?? delivery.reviewBundleIdentity ?? "unknown";
const sha = delivery.delivery?.reviewBundleSha256 ?? null;

// Controller verdict（from the TA-2 card opening message; machine-checked
// identities）。
const VERDICT = {
  verdict: "PASS",
  reviewerIdentity: "GPT-5.6 Sol",
  reviewedAt: "2026-08-09",
  cardId,
  bundleIdentity: identity,
  bundleSha256: sha,
  findingsDigest: "ef885aaca86eef9ba0423fb8e91437d66441724741eb08e4ea8af5fe861b4375",
  blockingFindings: "NONE",
  notes: [
    "Controller external review: PASS / TA1_RESEARCH_AND_DESIGN_EXTERNAL_REVIEW_CONFIRMED",
    "CURRENT_CARD_DELTA_PATHS = 27; ADDED = 27; MODIFIED = 0; DELETED = 0; three-way delta consistency exact",
    "V18 formally included in verifier accounting (V1-V18, 18/18)",
    "supersede binding of f134374c complete; repair budget stays 1/1 (reseal not a second bounded repair)",
    "new reseal uses independent graphRunId / evidence path; TA-1 research semantics unchanged",
    "raw bundle prefix SHA-256 equals the bundle tail 1ebc25d471a25c248d66458509978a2845c8c69d4f8a1e362efe46dcecc9469f",
    "TA-1 formally closed; next card = TA-2",
  ],
};

const verdictText = `**VERDICT: PASS / TA1_RESEARCH_AND_DESIGN_EXTERNAL_REVIEW_CONFIRMED**

Controller external review of card ${cardId}, bundle ${identity}, sha256 ${sha}.

${VERDICT.notes.map((n) => `- ${n}`).join("\n")}

NEXT_ACTION: formally close/archive TA-1, then enter TA-2 Task Admission + Capability Policy Implementation and Graph Wiring.
`;

const dateStr = "20260809";
const label = `${dateStr}-${cardId}-${identity.slice(0, 8)}-PASS`;
mkdirSync(ARCHIVE, { recursive: true });
writeFileSync(join(ARCHIVE, `${label}-verdict.txt`), verdictText);

const lock = acquireExternalReviewSurfaceLock(SURFACE);
if (!lock.ok) {
  console.error(`surface lock failed: ${lock.reason}`);
  process.exit(1);
}
try {
  const rot = rotateExternalReviewSurface({ surfaceDir: SURFACE, archiveDir: ARCHIVE, cardId, identity, verdict: "PASS", dateStr, lock });
  if (!rot.ok) {
    console.error(`rotation failed: ${rot.reason}`);
    process.exit(1);
  }
  console.log(`TA-1 surface resolved: ${rot.archived.length} artifacts archived as ${label}-*`);
  console.log(`verdict record: ${ARCHIVE}/${label}-verdict.txt`);
} finally {
  releaseExternalReviewSurfaceLock({ lockPath: lock.lockPath, token: lock.token });
}
