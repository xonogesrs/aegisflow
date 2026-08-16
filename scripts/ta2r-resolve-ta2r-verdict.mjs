#!/usr/bin/env node
// scripts/ta2r-resolve-ta2r-verdict.mjs
//
// TA-2R — apply the external reviewer's REPAIR verdict to the TA-2R bundle
// occupying the fixed surface（82831126badcc733cc108b3b8c5726308f90275be363c412aa69e0ad12ec43ae /
// 11b9a7a375a41f64eeba170945e33708de5186603ac431e70b11ad644d59c275）and rotate
// the resolved occupant into Archive/. This is the standard surface rotation
//（the same pattern ta2r-resolve-ta2-verdict.mjs used for the TA-2 bundle）:
// nothing is deleted — the TA-2R bundle is archived with its REPAIR verdict
// record so the closeout-accounting correction generation can publish its
// superseding bundle on the single authoritative surface（one-card-one-review-
// surface; NEG9/NEG10）.
//
// Verdict source: the external review of the TA-2R closeout bundle
//（REPAIR / TA2R_REPAIR_BUDGET_ACCOUNTING_INCONSISTENT, findings digest
// 3b00107a837f3d6e19194c45bce7cab168012478e182100f9198fdc67f1d2e4f,
// NEXT_ACTION_IF_REPAIR: TA-2R closeout-accounting micro-repair — define
// REPAIR_BUDGET_USED to count external-review-triggered superseding repair
// generations, record USED=1/MAX=1, add the validator invariant
//（supersede REPAIR -> usage != 0）, regenerate the authoritative bundle with
// a linear supersede, and drop the duplicated "admission 76/76" summary）.
//
// Run: node scripts/ta2r-resolve-ta2r-verdict.mjs
// Local-only, deterministic, no network, no commit/push/seal.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import {
  externalReviewSurfaceDir,
  externalReviewArchiveDir,
  readExternalReviewDeliveryRecord,
  applyExternalReviewVerdict,
  writeExternalReviewDeliveryRecord,
  rotateExternalReviewSurface,
  acquireExternalReviewSurfaceLock,
  releaseExternalReviewSurfaceLock,
} from "../src/governance/review-bundle.mjs";

const SURFACE = externalReviewSurfaceDir();
const ARCHIVE = externalReviewArchiveDir();

const EXPECTED_IDENTITY = "82831126badcc733cc108b3b8c5726308f90275be363c412aa69e0ad12ec43ae";
const EXPECTED_SHA = "11b9a7a375a41f64eeba170945e33708de5186603ac431e70b11ad644d59c275";
const FINDINGS_DIGEST = "3b00107a837f3d6e19194c45bce7cab168012478e182100f9198fdc67f1d2e4f";

const deliveryPath = join(SURFACE, "delivery.json");
if (!existsSync(deliveryPath)) {
  console.error("no delivery.json on the surface — nothing to resolve");
  process.exit(2);
}
const rec = readExternalReviewDeliveryRecord(deliveryPath);
if (!rec.ok) {
  console.error(`surface delivery record invalid: ${rec.errors.join(";")}`);
  process.exit(2);
}
const state = rec.state;
const identity = state.delivery?.reviewBundleIdentity;
const sha = state.delivery?.reviewBundleSha256;
if (identity !== EXPECTED_IDENTITY || sha !== EXPECTED_SHA) {
  console.error(`surface occupant mismatch: got ${identity}/${sha}, expected ${EXPECTED_IDENTITY}/${EXPECTED_SHA}`);
  process.exit(2);
}

// The external reviewer's REPAIR verdict（the receipt: RECEIVED + REVIEWED
// proven in one step）.
const applied = applyExternalReviewVerdict(state, {
  verdict: "REPAIR",
  reviewerIdentity: "GPT-5.6 Sol", // the external review channel（same as TA-1/TA-2 reviews）
  reviewedAt: "2026-08-09",
  bundleIdentity: identity,
  bundleSha256: sha,
  findingsDigest: FINDINGS_DIGEST,
});
if (!applied.ok) {
  console.error(`verdict not applied: ${applied.errors.join(";")}`);
  process.exit(2);
}

const verdictText = `**VERDICT: REPAIR / TA2R_REPAIR_BUDGET_ACCOUNTING_INCONSISTENT**

External review of card AUTOLOOP-TA2, TA-2R closeout bundle ${identity}, sha256 ${sha}.

FINDINGS_DIGEST: ${FINDINGS_DIGEST}

Prior findings F1/F2/F3 are RESOLVED（mandatory admission gate, content-identity
delta provenance, final-surface accounting — no new architecture blocker）.
Remaining（lifecycle/accounting only）: section 14 renders
"NOT_APPLICABLE (no repair attempts)" + REPAIR_BUDGET_USED: 0 next to
SUPERSEDES_BUNDLE_* = 432e85b5（a bundle archived with the external REPAIR
verdict）— TA-2R IS that bounded repair, so the card-level budget must read
USED=1 / MAX=1; USED=0 would let the control plane allow another repair round
and break bounded-repair semantics.

NEXT_ACTION_IF_REPAIR: TA-2R closeout-accounting micro-repair —
(1) define REPAIR_BUDGET_USED to count external-review-triggered superseding
repair generations; (2) record USED=1 / MAX=1; (3) closeout validator
invariant: SUPERSEDES_BUNDLE_* with superseded verdict = REPAIR requires
repair usage != 0; (4) regenerate the authoritative bundle with a linear
supersede of this bundle; (5) drop the duplicated "admission 76/76" in the
Executive Summary（not a blocker）.
`;

const dateStr = "20260809";
const label = `${dateStr}-AUTOLOOP-TA2-${identity.slice(0, 8)}-REPAIR`;
mkdirSync(ARCHIVE, { recursive: true });
writeFileSync(join(ARCHIVE, `${label}-verdict.txt`), verdictText);

const lock = acquireExternalReviewSurfaceLock(SURFACE);
if (!lock.ok) {
  console.error(`surface lock failed: ${lock.reason}`);
  process.exit(1);
}
try {
  // persist the resolved delivery record（verdict bound）…
  const w = writeExternalReviewDeliveryRecord({ outDir: SURFACE, state: applied.state, cardId: "AUTOLOOP-TA2", fileName: "delivery.json" });
  if (!w.ok) {
    console.error(`delivery record write failed: ${w.reason}`);
    process.exit(1);
  }
  // …then rotate the resolved occupant into Archive/（nothing deleted）.
  const rot = rotateExternalReviewSurface({ surfaceDir: SURFACE, archiveDir: ARCHIVE, cardId: "AUTOLOOP-TA2", identity, verdict: "REPAIR", dateStr, lock });
  if (!rot.ok) {
    console.error(`rotation failed: ${rot.reason}`);
    process.exit(1);
  }
  console.log(`TA-2R surface resolved: ${rot.archived.length} artifacts archived as ${label}-*`);
  console.log(`verdict record: ${ARCHIVE}/${label}-verdict.txt`);
  console.log(`surface cleared=${rot.cleared} — ready for the closeout-accounting correction delivery`);
} finally {
  releaseExternalReviewSurfaceLock({ lockPath: lock.lockPath, token: lock.token });
}
