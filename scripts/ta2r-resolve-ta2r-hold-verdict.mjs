#!/usr/bin/env node
// scripts/ta2r-resolve-ta2r-hold-verdict.mjs
//
// TA-2R — apply the external reviewer's HOLD verdict to the TA-2R bundle
// occupying the fixed surface（2d63309140c7cd1f4563e0db073876c410482326fd72fcbf25cdfec5f7c84c05 /
// 483054ab9f998de3d59acd6cabfa4fbc671fb5b92ead8287fedc328a48d49bb8）and rotate
// the resolved occupant into Archive/. This is the standard surface rotation
//（the same pattern ta2r-resolve-ta2r-verdict.mjs used for the 82831126 bundle）:
// nothing is deleted — the TA-2R bundle is archived with its HOLD verdict
// record so the lineage-correction reseal generation can publish its
// superseding bundle on the single authoritative surface（one-card-one-review-
// surface; NEG9/NEG10）.
//
// Verdict source: the external review of the TA-2R closeout-accounting bundle
//（HOLD / TA2R_REPAIR_LINEAGE_ACCOUNTING_NOT_CUMULATIVE, findings digest
// 23f9f19899ad7d3d21fc3fe377df20aaa110cbbc7608426253a8ba8e6f657010,
// NEXT_ACTION_IF_HOLD: governance reseal / repair-lineage semantics correction —
// distinguish repair-iteration vs surface-reseal as machine classifications,
// make REPAIR_BUDGET_USED cumulative across the authoritative supersede
// lineage, and validator-enforce the reseal governance-scope contract）.
//
// Run: node scripts/ta2r-resolve-ta2r-hold-verdict.mjs
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

const EXPECTED_IDENTITY = "2d63309140c7cd1f4563e0db073876c410482326fd72fcbf25cdfec5f7c84c05";
const EXPECTED_SHA = "483054ab9f998de3d59acd6cabfa4fbc671fb5b92ead8287fedc328a48d49bb8";
const FINDINGS_DIGEST = "23f9f19899ad7d3d21fc3fe377df20aaa110cbbc7608426253a8ba8e6f657010";

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

// The external reviewer's HOLD verdict（the receipt: RECEIVED + REVIEWED
// proven in one step）.
const applied = applyExternalReviewVerdict(state, {
  verdict: "HOLD",
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

const verdictText = `**VERDICT: HOLD / TA2R_REPAIR_LINEAGE_ACCOUNTING_NOT_CUMULATIVE**

External review of card AUTOLOOP-TA2, TA-2R closeout-accounting bundle ${identity}, sha256 ${sha}.

FINDINGS_DIGEST: ${FINDINGS_DIGEST}

Prior findings F1-F4 are RESOLVED（mandatory admission gate, content-identity
delta provenance, final-surface accounting, USED=1/MAX=1）— no new architecture
blocker. Remaining（governance semantics only）: REPAIR_BUDGET_USED is applied
to the IMMEDIATE superseded verdict, not accumulated across the authoritative
supersede lineage（82831126 already consumed the single bounded repair; 2d633091
re-reports USED=1/MAX=1 and labels itself external-review-superseding-repair）.
The repair-iteration vs surface-reseal distinction is narrative-only — a later
generation could in theory still supersede a REPAIR bundle and re-report
USED=1/MAX=1.

NEXT_ACTION_IF_HOLD: governance reseal / repair-lineage semantics correction —
(1) machine-readable GENERATION_TYPE（implementation | repair-iteration |
surface-reseal）; (2) REPAIR_BUDGET_USED cumulative across the whole supersede
lineage（reseal adds +0）; (3) validator rejects cumulative repairs > MAX, a
reseal touching substantive implementation, a repair relabeled as a reseal;
(4) reseal keeps USED=1/MAX=1 only with review-surface/governance-metadata
touch（contract-determined, not narrative）; (5) reseal touch set machine-
checkable（RESEAL_TOUCHED_PATHS + independent recompute）.
`;

const dateStr = "20260809";
const label = `${dateStr}-AUTOLOOP-TA2-${identity.slice(0, 8)}-HOLD`;
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
  const rot = rotateExternalReviewSurface({ surfaceDir: SURFACE, archiveDir: ARCHIVE, cardId: "AUTOLOOP-TA2", identity, verdict: "HOLD", dateStr, lock });
  if (!rot.ok) {
    console.error(`rotation failed: ${rot.reason}`);
    process.exit(1);
  }
  console.log(`TA-2R surface resolved: ${rot.archived.length} artifacts archived as ${label}-*`);
  console.log(`verdict record: ${ARCHIVE}/${label}-verdict.txt`);
  console.log(`surface cleared=${rot.cleared} — ready for the lineage-correction reseal delivery`);
} finally {
  releaseExternalReviewSurfaceLock({ lockPath: lock.lockPath, token: lock.token });
}
