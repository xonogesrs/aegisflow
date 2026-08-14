#!/usr/bin/env node
// scripts/ta2r-resolve-ta2-verdict.mjs
//
// TA-2R — apply the external reviewer's REPAIR verdict to the TA-2 bundle
// occupying the fixed surface（432e85b5742b194d24c4558b1eec8f1415dcdc6ee52c2f934eff900f9e0a6272 /
// d776ff5a91269c413c15fdd6cd3668cdb5f4b823b6e6837c6f52e1803224a12b）and rotate
// the resolved occupant into Archive/. This is the standard surface rotation
//（the same pattern ta2-resolve-ta1-verdict.mjs used for TA-1）: nothing is
// deleted — the TA-2 bundle is archived with its REPAIR verdict record so the
// TA-2R closeout can publish its superseding bundle on the single
// authoritative surface（one-card-one-review-surface; NEG9/NEG10）.
//
// Verdict source: the external review of the TA-2 closeout bundle
//（REPAIR / TA2_ADMISSION_AUTHORITY_AND_CLOSEOUT_SURFACE_INCONSISTENT,
// findings digest 984d3bd60f26eb0028fd13dcdf0e80e616e613be7244ebe26224151b004d6d76,
// NEXT_ACTION_IF_REPAIR: TA-2R — mandatory admission authority + dirty-baseline
// delta provenance + final-surface rendering/accounting repair）.
//
// Run: node scripts/ta2r-resolve-ta2-verdict.mjs
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

const EXPECTED_IDENTITY = "432e85b5742b194d24c4558b1eec8f1415dcdc6ee52c2f934eff900f9e0a6272";
const EXPECTED_SHA = "d776ff5a91269c413c15fdd6cd3668cdb5f4b823b6e6837c6f52e1803224a12b";
const FINDINGS_DIGEST = "984d3bd60f26eb0028fd13dcdf0e80e616e613be7244ebe26224151b004d6d76";

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
  reviewerIdentity: "GPT-5.6 Sol", // the external review channel（same as TA-1's Controller review）
  reviewedAt: "2026-08-09",
  bundleIdentity: identity,
  bundleSha256: sha,
  findingsDigest: FINDINGS_DIGEST,
});
if (!applied.ok) {
  console.error(`verdict not applied: ${applied.errors.join(";")}`);
  process.exit(2);
}

const verdictText = `**VERDICT: REPAIR / TA2_ADMISSION_AUTHORITY_AND_CLOSEOUT_SURFACE_INCONSISTENT**

External review of card AUTOLOOP-TA2, bundle ${identity}, sha256 ${sha}.

FINDINGS_DIGEST: ${FINDINGS_DIGEST}

Findings (3 blocking):
1. Admission not the single non-bypassable authority — production entry must be gated (mandatory admission gate + negative test).
2. Card delta cannot support the claimed Graph wiring — content-identity attribution required; fail closed when the card-start baseline lacks it.
3. Closeout surface fails its own contract — complete-bundle template scan, structured counts, unified section 11/16 accounting.

NEXT_ACTION_IF_REPAIR: TA-2R — mandatory admission authority + dirty-baseline delta provenance + final-surface rendering/accounting repair.
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
  console.log(`TA-2 surface resolved: ${rot.archived.length} artifacts archived as ${label}-*`);
  console.log(`verdict record: ${ARCHIVE}/${label}-verdict.txt`);
  console.log(`surface cleared=${rot.cleared} — ready for the TA-2R superseding delivery`);
} finally {
  releaseExternalReviewSurfaceLock({ lockPath: lock.lockPath, token: lock.token });
}
