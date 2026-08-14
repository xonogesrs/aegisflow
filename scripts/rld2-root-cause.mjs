#!/usr/bin/env node
// scripts/rld2-root-cause.mjs
//
// AUTOLOOP-RLD2 — ROOT_CAUSE_CONFIRMED record（written after the isolated
// reproduction proved the mechanism）.
//
// Verdict: PASS / RLD2_STALE_DELIVERY_ROOT_CAUSE_CONFIRMED_AND_REPAIRED
//（declared by the closeout; this record freezes the proof + the falsifying
// negative tests）.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "docs", "pi-graph-output", "rld2");

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

// Read the frozen incident + reproduction evidence to bind into the record.
const incident = JSON.parse(readFileSync(join(OUT, "rld2-incident-snapshot.json"), "utf8"));
const chain = JSON.parse(readFileSync(join(OUT, "rld2-delivery-chain.json"), "utf8"));
const audit = JSON.parse(readFileSync(join(OUT, "rld2-previous-repair-audit.json"), "utf8"));
const repro = JSON.parse(readFileSync(join(OUT, "rld2-reproduction.json"), "utf8"));
const pre = repro.pre_repair ?? {};
const post = repro.post_repair ?? {};

const record = {
  schema: "autoloop.rld2.root-cause/v1",
  verdict: "ROOT_CAUSE_CONFIRMED",
  card: "AUTOLOOP-RLD2",
  incident: "Controller requested AUTOLOOP-TA3; the delivered review bundle was the already-externally-reviewed PASS TA-2R authoritative bundle (identity f7f168aa...) — a stale, COMPLETE generation re-delivered as the current review bundle.",
  rootCause: {
    mechanism: "The delivery/export path is an ungoverned dereference of the single-slot review surface (Current/) with NO current-card identity, NO no-new-bundle semantic, and NO already-reviewed-generation guard. After an external review PASS that is NOT applied to the surface (the TA-2R PASS verdict was never applied: no applyExternalReviewVerdict call, no rotate, no f7f168aa PASS entry in Archive), the surface keeps exposing the resolved COMPLETE TA-2R generation as AWAITING_EXTERNAL_REVIEW. The next card's (TA-3) publish is then correctly BLOCKED by the previous repair's surface_occupied guard — so no new authoritative bundle ever occupies the surface. The controller-facing export dereferences Current and re-delivers the stale TA-2R generation.",
    codePath: [
      "PUBLISH (protected, held): src/governance/review-bundle.mjs deliverToExternalReviewSurface — blocked TA-3 with surface_occupied (correct fail-closed from report-lifecycle-repair-1/RB-1H)",
      "ROTATE (protected, never triggered): rotateExternalReviewSurface + applyExternalReviewVerdict — requires the verdict to be APPLIED; the TA-2R PASS was never applied to the surface",
      "READ/EXPORT (UNGOVERNED — the gap): no export API exists; the controller-facing step dereferences Current/delivery.json + Current/review-bundle.txt with zero identity verification",
    ],
    persistentState: [
      "~/Desktop/AutoLoop-Review/Current/delivery.json — cardId AUTOLOOP-TA2, status AWAITING_EXTERNAL_REVIEW, verdict null, identity f7f168aa, bundlePath docs/pi-graph-output/ta2r/card-closeout-bundle-20260809-f7f168aa.txt",
      "~/Desktop/AutoLoop-Review/Current/review-bundle.txt — sha 921360ad22fa... (byte-identical to the TA-2R bundle)",
      "~/Desktop/AutoLoop-Review/Archive/ — NO 20260809-AUTOLOOP-TA2-f7f168aa-PASS-* entry (verdict never applied/rotated)",
      "docs/pi-graph-output/ta3/card-closeout-bundle-20260809-1f453f02.txt — TA-3 bundle generated + validateReviewBundle OK, but delivery blocked (no ta3 delivery record)",
    ],
    firstIdentityDivergence: "Current/delivery.json cardId (AUTOLOOP-TA2) != controller current card (AUTOLOOP-TA3) — present from the moment the controller moved to TA-3 while Current was never rotated; first SELECTED at the export dereference of Current (Stage B chain step 'external-review delivery selection').",
    reproduction: {
      harness: "scripts/rld2-reproduction.mjs — real production functions, env-isolated surfaces (AUTOLOOP_REVIEW_SURFACE/ARCHIVE), documented export model (controller-side step dereferences the single-slot surface)",
      preRepair: { selector: "production", scenarioOk: pre.scenarioOkCount, scenarioTotal: pre.scenarioTotal, staleDeliveries: pre.staleDeliveries, violatedScenarios: (pre.scenarios ?? []).filter((s) => s.invariant?.ok === false).map((s) => `${s.id}[${s.invariant?.code}]`) },
      postRepair: { selector: "verified", scenarioOk: post.scenarioOkCount, scenarioTotal: post.scenarioTotal, staleDeliveries: post.staleDeliveries, violatedScenarios: (post.scenarios ?? []).filter((s) => s.invariant?.ok === false).map((s) => `${s.id}[${s.invariant?.code}]`) },
      requirement: "repair before/after: same scenarios; pre-repair stale scenarios FAIL (silent stale delivery), post-repair fail CLOSED (no stale generation delivered)",
    },
  },
  previousRepairAssessment: {
    judgment: "BYPASS / SECONDARY DELIVERY PATH + TEST COVERAGE GAP",
    detail: audit.conclusion,
    whyNotCaught: [
      "report-lifecycle-repair-1 (RB-1H) protected PUBLISH (surface_occupied — correctly blocked TA-3), ROTATE (auto-rotate resolved occupants — never triggered because the TA-2R occupant stayed UNRESOLVED), and VERDICT receipt (applyExternalReviewVerdict — never invoked). It added NO read/export API, NO NO_NEW_REVIEW_BUNDLE semantic, NO already-reviewed-generation guard, NO current-card registry.",
      "The 10 surface tests + 15 delivery tests cover publish/rotate/verdict/concurrency/crash-trio; ZERO cover export/read selection, no-new-bundle, already-reviewed re-delivery, or current-card identity — the incident's failure stage had no tests at all.",
    ],
  },
  repair: {
    scope: "delivery-selection layer ONLY（proven mechanism）:",
    changes: [
      "src/governance/review-bundle.mjs — NEW currentReviewDelivery({ surfaceDir, currentCardId, cachedPath }) : the authoritative identity-verified delivery selector — card identity + cryptographic content sha + already-reviewed-generation guard; fail-closed codes NO_NEW_REVIEW_BUNDLE / STALE_CARD_IDENTITY / STALE_GENERATION_ALREADY_REVIEWED / SURFACE_SHA_MISMATCH / SURFACE_RECORD_INVALID; a stale generation is NEVER substituted",
      "src/governance/review-bundle.mjs — deliverToExternalReviewSurface hardened with currentCardId: refuses to publish a bundle whose CARD_ID != current card (delivery_card_id_mismatch); occupant block reason becomes identity-explicit (surface_occupied_by_different_card)",
      "scripts/gov-external-review-surface.mjs — NEW --export-for-card <cardId> (identity-verified export surface) + --current-card <id> on --deliver",
    ],
    explicitlyNotChanged: ["no refactor of report lifecycle", "no change to applyExternalReviewVerdict semantics", "no historical bundle modified", "no manual evidence override", "no new dependency", "no commit/push/merge/seal", "no TA-3 budget enforcement work"],
  },
  falsifyingNegativeTests: [
    "NEG-RLD1 no new bundle -> NO_NEW_REVIEW_BUNDLE (never fallback to old COMPLETE bundle)",
    "NEG-RLD2 Current card != bundle CARD_ID -> STALE_CARD_IDENTITY",
    "NEG-RLD3 Current identity != delivery source identity -> fail closed",
    "NEG-RLD4 copy/export SHA change -> SURFACE_SHA_MISMATCH",
    "NEG-RLD5 already externally-reviewed generation re-delivered as new -> STALE_GENERATION_ALREADY_REVIEWED",
    "NEG-RLD6 card B not closed out -> never deliver card A",
    "NEG-RLD7 crash/resume must not roll back to previous authoritative generation",
    "NEG-RLD8 stale cached path -> identity check rejects",
    "NEG-RLD9 partial Current/Archive rotation -> fail closed, no fallback",
    "NEG-RLD10 delivery receipt vs actual delivered SHA mismatch -> fail closed",
  ],
  incidentStatePreserved: incident.incidentStateFrozen === true,
  evidenceBound: {
    incidentSnapshot: sha256(readFileSync(join(OUT, "rld2-incident-snapshot.json"), "utf8")),
    deliveryChain: sha256(readFileSync(join(OUT, "rld2-delivery-chain.json"), "utf8")),
    previousRepairAudit: sha256(readFileSync(join(OUT, "rld2-previous-repair-audit.json"), "utf8")),
    hypothesisMatrix: sha256(readFileSync(join(OUT, "rld2-hypothesis-matrix.json"), "utf8")),
    reproduction: sha256(readFileSync(join(OUT, "rld2-reproduction.json"), "utf8")),
  },
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "rld2-root-cause.json"), JSON.stringify(record, null, 2) + "\n");
console.log("rld2-root-cause.json written");
console.log("verdict: ROOT_CAUSE_CONFIRMED");
console.log(`reproduction pre_repair: ${pre.scenarioOkCount}/${pre.scenarioTotal} ok, ${pre.staleDeliveries} stale`);
console.log(`reproduction post_repair: ${post.scenarioOkCount}/${post.scenarioTotal} ok, ${post.staleDeliveries} stale`);
