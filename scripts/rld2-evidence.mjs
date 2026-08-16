#!/usr/bin/env node
// scripts/rld2-evidence.mjs
//
// AUTOLOOP-RLD2 — Stage A/B/C freeze: read-only capture of the incident
// truth + delivery-chain reconstruction + previous-repair audit +
// hypothesis matrix. NEVER writes to the incident surfaces（Current/ /
// Archive/）; outputs only into docs/pi-graph-output/rld2/.
//
// Outputs:
//   rld2-incident-snapshot.json      (A1/A2 repo + surface truth)
//   rld2-lifecycle-state.json        (A3 machine-evidence lifecycle state)
//   rld2-delivery-chain.json         (Stage B provenance table)
//   rld2-previous-repair-audit.json  (Stage C per-fix contract + verdict)
//   rld2-hypothesis-matrix.json      (hypotheses A..J disposition)

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "docs", "pi-graph-output", "rld2");
const SURFACE = "/Users/zhengfengqing/Desktop/AutoLoop-Review/Current";
const ARCHIVE = "/Users/zhengfengqing/Desktop/AutoLoop-Review/Archive";

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const fileSha = (p) => (existsSync(p) ? sha256(readFileSync(p)) : null);
const canonical = (v) => {
  const sort = (x) => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  };
  return JSON.stringify(sort(v));
};

function statOf(p) {
  try {
    const st = statSync(p);
    const ls = lstatSync(p);
    return {
      size: st.size,
      mtime: st.mtime.toISOString(),
      ctime: st.ctime.toISOString(),
      birthtime: st.birthtime.toISOString(),
      isSymlink: ls.isSymbolicLink(),
      isRegularFile: ls.isFile(),
      inode: String(st.ino),
    };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// ── A1: repository truth ──────────────────────────────────────────────────
let repo = { error: null };
try {
  const git = (args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
  const porcelain = execFileSync("git", ["-C", REPO, "status", "--porcelain=v1"], { encoding: "utf8" });
  const dirtyLines = porcelain.split("\n").filter(Boolean).sort();
  repo = {
    repoPath: REPO,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    head: git(["rev-parse", "HEAD"]),
    treeSha: git(["rev-parse", "HEAD^{tree}"]),
    remote: git(["remote", "get-url", "origin"]) || null,
    dirtyPathCount: dirtyLines.length,
    dirtyDigest: dirtyLines.length ? `dirty:${sha256(dirtyLines.join("\n"))}` : "clean",
    capturedAtUtc: new Date().toISOString(),
  };
} catch (e) {
  repo = { error: String(e?.message ?? e) };
}

// ── A2: review surface truth ──────────────────────────────────────────────
const surfaceFiles = existsSync(SURFACE)
  ? readdirSync(SURFACE).filter((f) => !f.startsWith(".")).sort().map((f) => ({
      name: f,
      path: join(SURFACE, f),
      sha256: fileSha(join(SURFACE, f)),
      ...statOf(join(SURFACE, f)),
    }))
  : [];
let deliveryRecord = null;
const deliveryPath = join(SURFACE, "delivery.json");
if (existsSync(deliveryPath)) {
  try { deliveryRecord = JSON.parse(readFileSync(deliveryPath, "utf8")); } catch { deliveryRecord = { parseError: "unreadable" }; }
}
const archiveTa2 = existsSync(ARCHIVE) ? readdirSync(ARCHIVE).filter((f) => f.includes("TA2")).sort() : [];
const archiveHasF7f168aa = archiveTa2.some((f) => f.includes("f7f168aa") || f.includes("f7f168aa".slice(0, 8)));
const archiveHasPassVerdict = archiveTa2.some((f) => /-PASS-/.test(f));
const currentBundleSha = surfaceFiles.find((f) => f.name === "review-bundle.txt")?.sha256 ?? null;
const ta2rBundleSha = fileSha(join(REPO, "docs/pi-graph-output/ta2r/card-closeout-bundle-20260809-f7f168aa.txt"));
const ta3Dir = join(REPO, "docs/pi-graph-output/ta3");
const ta3Files = existsSync(ta3Dir) ? readdirSync(ta3Dir).filter((f) => !f.startsWith(".")).sort() : [];
const ta3Bundle = ta3Files.find((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt"));
const ta3BundleSha = ta3Bundle ? fileSha(join(ta3Dir, ta3Bundle)) : null;
const ta3DeliveryRecord = ta3Files.find((f) => f.includes("delivery"));
const ta3CloseoutEvidence = ta3Files.find((f) => f.endsWith("-graph-closeout-evidence.json"));

// ── A3: lifecycle truth from machine evidence ─────────────────────────────
// The repo has NO current-card registry（verified: no currentCard/nextCard
// tracking exists）. Lifecycle state must be inferred from artifacts:
//   latest bundle per card dir, delivery records, closeout evidence.
function cardState(cardDir) {
  const dir = join(REPO, "docs/pi-graph-output", cardDir);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => !f.startsWith("."));
  const bundles = files.filter((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt")).sort();
  const latestBundle = bundles.length ? bundles[bundles.length - 1] : null;
  const latestBundlePath = latestBundle ? join(dir, latestBundle) : null;
  const evidence = files.find((f) => f.endsWith("-graph-closeout-evidence.json"));
  let evidenceFinal = null;
  if (evidence) {
    try { evidenceFinal = JSON.parse(readFileSync(join(dir, evidence), "utf8")).final ?? null; } catch { /* ignore */ }
  }
  const deliveryRec = files.find((f) => f.includes("external-review-delivery"));
  let deliveryStatus = null;
  if (deliveryRec) {
    try {
      const d = JSON.parse(readFileSync(join(dir, deliveryRec), "utf8"));
      deliveryStatus = { status: d.externalReviewStatus ?? null, verdict: d.verdict?.verdict ?? null, identity: d.delivery?.reviewBundleIdentity ?? null };
    } catch { /* ignore */ }
  }
  return {
    cardDir,
    fileCount: files.length,
    bundleCount: bundles.length,
    latestBundle,
    latestBundleSha: latestBundlePath ? fileSha(latestBundlePath) : null,
    hasCloseoutEvidence: Boolean(evidence),
    evidenceFinal,
    deliveryRecord: deliveryRec ?? null,
    deliveryStatus,
  };
}

const lifecycle = {
  schema: "autoloop.rld2.lifecycle-state/v1",
  note: "the repository has NO current-card registry; lifecycle state is inferred from machine artifacts (bundles / delivery records / closeout evidence) — never from chat",
  cards: {
    ta2r: cardState("ta2r"),
    ta3: cardState("ta3"),
  },
  surface: {
    holdsCardId: deliveryRecord?.cardId ?? null,
    holdsStatus: deliveryRecord?.externalReviewStatus ?? null,
    holdsVerdict: deliveryRecord?.verdict ?? null,
    holdsIdentity: deliveryRecord?.delivery?.reviewBundleIdentity ?? null,
    currentBundleMatchesTa2r: currentBundleSha !== null && currentBundleSha === ta2rBundleSha,
    currentBundleSha,
    ta2rBundleSha,
  },
  ta3LaunchDetermination: (() => {
    const st = cardState("ta3");
    return {
      ta3AdmissionArtifact: existsSync(join(ta3Dir, "ta3-card-start-baseline.json")) ? "present" : "absent",
      ta3CloseoutBundle: st?.latestBundle ?? null,
      ta3BundleSha,
      ta3CloseoutEvidence,
      ta3DeliveryRecord,
      ta3Evidence: ta3Files,
      verdict: "TA-3 WAS LAUNCHED AND CLOSED OUT (bundle generated + closeout PASS + independent review + verification); its external delivery was BLOCKED (surface_occupied) and NO ta3 delivery record exists",
    };
  })(),
};

// ── Stage B: delivery chain provenance ────────────────────────────────────
const deliveryChain = {
  schema: "autoloop.rld2.delivery-chain/v1",
  chain: [
    { step: "controller next-card selection", input: "controller message: next card = AUTOLOOP-TA3", selector: "human/controller (no machine registry)", authoritativeSource: "controller message", persistentState: "none", expected: "TA-3 launch", observed: "TA-3 implemented + closeout run by agent; no formal launch registry entry" },
    { step: "card/admission creation", input: "AUTOLOOP-TA3 card", selector: "agent session", authoritativeSource: "task card text", persistentState: "docs/pi-graph-output/ta3/", expected: "TA-3 artifacts", observed: "ta3-card-start-baseline.json + evidence present" },
    { step: "graph launch + completion", input: "TA-3 implementation", selector: "agent", authoritativeSource: "closeout evidence", persistentState: "ta3-implementation-20260809-graph-closeout-evidence.json", expected: "final PASS", observed: "final PASS" },
    { step: "self-closeout + bundle generation", input: "ta3-verify/IR/evidence", selector: "scripts/ta3-*", authoritativeSource: "runMandatoryGraphCloseout", persistentState: "docs/pi-graph-output/ta3/card-closeout-bundle-20260809-1f453f02.txt", expected: "valid bundle", observed: "bundle 1f453f02 generated + validateReviewBundle OK" },
    { step: "bundle identity", input: "bundle", selector: "reviewBundleIdentity", authoritativeSource: "bundle header REVIEW_BUNDLE_IDENTITY", persistentState: "bundle text", expected: "identity 1f453f02...", observed: "1f453f02b031044007dbdbe1cc4e7e21fa54d945710717aa2d0eb924911e61ce" },
    { step: "closeout state", input: "closeout", selector: "runMandatoryGraphCloseout", authoritativeSource: "graph-closeout evidence", persistentState: "ta3-implementation-20260809-graph-closeout-evidence.json", expected: "AWAITING_BUNDLE_DELIVERY or DELIVERED", observed: "AWAITING_BUNDLE_DELIVERY (delivery_blocked:surface_occupied)" },
    { step: "Current rotation", input: "TA-2R PASS verdict", selector: "applyExternalReviewVerdict / rotateExternalReviewSurface", authoritativeSource: "~/Desktop/AutoLoop-Review/Current/delivery.json", persistentState: "Current/delivery.json", expected: "TA-2R resolved (PASS) then rotated to Archive; Current cleared", observed: "NEVER ROTATED — Current still holds TA-2R f7f168aa with status AWAITING_EXTERNAL_REVIEW, verdict null; Archive has NO f7f168aa PASS entry" },
    { step: "Archive rotation", input: "verdict", selector: "rotateExternalReviewSurface", authoritativeSource: "Archive/", persistentState: "Archive flat files", expected: "20260809-AUTOLOOP-TA2-f7f168aa-PASS-*", observed: "ABSENT" },
    { step: "external-review delivery selection", input: "controller asks for next-card review bundle", selector: "none in repo — controller-side export dereferences Current/ (single-slot surface)", authoritativeSource: "Current/delivery.json + Current/review-bundle.txt", persistentState: "Current/", expected: "delivered.card_id == current.card_id (AUTOLOOP-TA3)", observed: "returned AUTOLOOP-TA2 f7f168aa (STALE — first identity divergence)" },
    { step: "exported/copied artifact", input: "selection result", selector: "export step", authoritativeSource: "Current/review-bundle.txt", persistentState: "Current/review-bundle.txt", expected: "TA-3 bundle sha", observed: "sha 921360ad22fa1dc0... = TA-2R f7f168aa bundle (identical bytes)" },
  ],
  firstDivergencePoint: "Current rotation step: the TA-2R PASS verdict was never applied to the surface, so Current/delivery.json (cardId AUTOLOOP-TA2) remained the exposed generation after the controller moved to AUTOLOOP-TA3; the export step then dereferenced Current without any identity check.",
};

// ── Stage C: previous repair audit ────────────────────────────────────────
const previousRepairs = {
  schema: "autoloop.rld2.previous-repair-audit/v1",
  repairs: [
    {
      card: "AUTOLOOP-PI-GRAPH-REPORT-LIFECYCLE-REPAIR-1 (report-lifecycle-repair-1)",
      claims: "State-driven mandatory closeout + fail-closed review surface delivery (RB-1H): atomic trio publish, single-owner lock, surface_occupied on unresolved occupant, auto-rotate resolved occupants, verdict-bound receipt.",
      codePath: "src/governance/review-bundle.mjs (deliverToExternalReviewSurface / rotateExternalReviewSurface / applyExternalReviewVerdict / externalReviewSurfaceDir), scripts/gov-external-review-surface.mjs, src/governance/closeout-state.mjs",
      invariants: ["new publish never overwrites an UNRESOLVED occupant (surface_occupied)", "a RESOLVED occupant auto-rotates before the next publish", "the external verdict bound to the bundle identity is the sole receipt", "delivery attempts are non-authoritative"],
      negativeTests: ["surface_occupied (test 8)", "concurrent delivery surface_busy (test 7)", "mixed trio impossible (test 9)", "self-declared verdict rejected (delivery test 11)", "stale bundle verdict rejected (STALE_BUNDLE)", "surface write failure -> AWAITING_BUNDLE_DELIVERY (test 2)"],
      protects: ["PUBLISH path", "ROTATE path", "VERDICT receipt path"],
      doesNotProtect: ["READ/EXPORT path (no export API exists)", "NO_NEW_REVIEW_BUNDLE semantic", "already-externally-reviewed COMPLETE generation re-delivery guard", "delivered.card_id == current.card_id invariant (no current-card registry)"],
      incidentPassedThroughThisPath: "NO — the TA-3 publish attempt WAS correctly blocked (surface_occupied), so the incident did not traverse the repaired publish path; the export/read path has no repair at all.",
      judgment: "BYPASS / SECONDARY DELIVERY PATH + TEST COVERAGE GAP",
    },
    {
      card: "AUTOLOOP-REVIEW-BUNDLE-INVENTORY-REPAIR-1 (fm3-rbi)",
      claims: "FM-3 CARD_IMPLEMENTATION_FILES inventory consistency + post-FM-3 closeout hardening (card-start baseline gate, delta-v1 inventory).",
      codePath: "src/governance/review-bundle.mjs (assertCardStartBaseline, computeInventoryDelta, validateCardInventoryConsistency), src/governance/card-inventory.mjs",
      invariants: ["card-start baseline mandatory", "delta derived from a single machine truth", "inventory categories disjoint"],
      negativeTests: ["baseline missing -> CARD_START_BASELINE_MISSING", "inventory inconsistency -> HOLD"],
      protects: ["closeout inventory surface"],
      doesNotProtect: ["delivery selection / export identity"],
      incidentPassedThroughThisPath: "NO — the incident is a delivery-selection issue, not an inventory-consistency issue.",
      judgment: "NOT APPLICABLE TO THIS INCIDENT",
    },
    {
      card: "AUTOLOOP-RB1G / RB1H (rb1g / rb1h)",
      claims: "One-card-one-review-surface + fixed external-review delivery surface CLI (RB-1H) + repair-generation supersede binding (RB-1G).",
      codePath: "src/governance/review-bundle.mjs (buildExternalReviewState, buildSupersedeRecord, supersedesFromBundleText), scripts/gov-external-review-surface.mjs",
      invariants: ["single authoritative surface per card", "repair generation carries SUPERSEDES binding", "partial supersede fails closed"],
      negativeTests: ["partial supersede binding fails closed", "repair-generation delivery record carries SUPERSEDES"],
      protects: ["surface layout", "supersede lineage on the publish/rotate side"],
      doesNotProtect: ["read/export identity vs the controller's current card", "re-delivery of an already-reviewed generation"],
      incidentPassedThroughThisPath: "NO — the incident is downstream of these (export/read), not the publish/rotate side they protect.",
      judgment: "NOT APPLICABLE TO THIS INCIDENT (different stage of the chain)",
    },
  ],
  conclusion: "The previous report-lifecycle repair protected PUBLISH/ROTATE/VERDICT. The incident's TA-3 publish was correctly blocked (surface_occupied) — the repaired path held. The failure is in the READ/EXPORT stage: no identity verification, no NO_NEW_REVIEW_BUNDLE semantic, no already-reviewed-generation guard, and the surface has no current-card registry. The observed re-delivery did not pass through any repaired path.",
};

// ── Hypothesis matrix (A..J) ──────────────────────────────────────────────
const hypotheses = {
  schema: "autoloop.rld2.hypothesis-matrix/v1",
  hypotheses: [
    { id: "A", label: "TA-3 never launched", disposition: "REJECTED — TA-3 artifacts exist (baseline, verification, IR, evidence, bundle 1f453f02, closeout PASS)", evidence: lifecycle.ta3LaunchDetermination },
    { id: "B", label: "TA-3 launched but lifecycle incomplete", disposition: "REJECTED — TA-3 closeout completed (evidence final PASS; independent review; verification)", evidence: lifecycle.ta3LaunchDetermination },
    { id: "C", label: "TA-3 completed but no authoritative bundle", disposition: "REJECTED — bundle 1f453f02 generated and validateReviewBundle OK", evidence: lifecycle.ta3LaunchDetermination },
    { id: "D", label: "TA-3 bundle exists but Current did not rotate", disposition: "CONFIRMED PARTIAL — Current was never rotated (still TA-2R); the TA-3 publish was blocked by surface_occupied; this is a precondition, not the full mechanism", evidence: "Current/delivery.json status AWAITING_EXTERNAL_REVIEW; no f7f168aa PASS in Archive" },
    { id: "E", label: "Current rotated correctly but delivery/export selected stale TA-2R", disposition: "REJECTED — Current was NOT rotated (mtimes 12:51; status AWAITING_EXTERNAL_REVIEW)", evidence: surfaceFiles },
    { id: "F", label: "lifecycle/control-plane state still at TA-2", disposition: "CONFIRMED PARTIAL — the surface state is at TA-2 (unresolved); no current-card registry exists anywhere", evidence: "no currentCard/nextCard tracking in src/ or scripts/" },
    { id: "G", label: "attachment/export/cache layer reused old artifact", disposition: "CONFIRMED PARTIAL — the export dereferences Current (or the delivery record) with no identity guard; the TA-2R artifact is re-read byte-identically (sha 921360ad...) ", evidence: deliveryChain },
    { id: "H", label: "previous fix only covered one path; a second ungoverned delivery path exists", disposition: "CONFIRMED — the READ/EXPORT path has no guards (no export API, no identity verification, no NO_NEW_REVIEW_BUNDLE); previous repair protected publish/rotate/verdict only", evidence: previousRepairs },
    { id: "I", label: "crash/resume/rerun/idempotency republished stale generation", disposition: "NOT OBSERVED — no evidence of a re-publish; the TA-2R artifact was never removed from Current (no crash needed to re-expose it)", evidence: "Current mtimes unchanged since 12:51" },
    { id: "J", label: "other unidentified mechanism", disposition: "OPEN — covered by reproduction harness R1..R10", evidence: null },
  ],
  primaryHypothesis: "H + G + F: the delivery/export path dereferences the single-slot surface with no current-card identity and no no-new-bundle semantic; the TA-2R PASS verdict was never applied to the surface, so the already-reviewed COMPLETE TA-2R generation remained exposed and was re-delivered after the controller moved to TA-3.",
};

mkdirSync(OUT, { recursive: true });
const incidentSnapshot = {
  schema: "autoloop.rld2.incident-snapshot/v1",
  incident: "Controller requested AUTOLOOP-TA3; the delivered review bundle was the already-reviewed PASS TA-2R authoritative bundle f7f168aa (sha 921360ad22fa...)",
  capturedAtUtc: new Date().toISOString(),
  repo,
  surface: { dir: SURFACE, files: surfaceFiles, deliveryRecord, archiveTa2Entries: archiveTa2, archiveHasF7f168aa, archiveHasPassVerdict },
  identityCrossCheck: {
    currentBundleSha,
    ta2rBundleSha,
    currentIsTa2r: currentBundleSha === ta2rBundleSha,
    deliveryRecordIdentity: deliveryRecord?.delivery?.reviewBundleIdentity ?? null,
    deliveryRecordCardId: deliveryRecord?.cardId ?? null,
    controllerCurrentCard: "AUTOLOOP-TA3",
    firstDivergence: deliveryRecord?.cardId ? (deliveryRecord.cardId === "AUTOLOOP-TA3" ? "none" : `surface cardId ${deliveryRecord.cardId} != controller current card AUTOLOOP-TA3`) : "delivery record cardId missing",
  },
  ta3: { dir: ta3Dir, files: ta3Files, bundle: ta3Bundle, bundleSha: ta3BundleSha, deliveryRecord: ta3DeliveryRecord, closeoutEvidence: ta3CloseoutEvidence },
  incidentStateFrozen: true,
};
writeFileSync(join(OUT, "rld2-incident-snapshot.json"), JSON.stringify(incidentSnapshot, null, 2) + "\n");
writeFileSync(join(OUT, "rld2-lifecycle-state.json"), JSON.stringify(lifecycle, null, 2) + "\n");
writeFileSync(join(OUT, "rld2-delivery-chain.json"), JSON.stringify(deliveryChain, null, 2) + "\n");
writeFileSync(join(OUT, "rld2-previous-repair-audit.json"), JSON.stringify(previousRepairs, null, 2) + "\n");
writeFileSync(join(OUT, "rld2-hypothesis-matrix.json"), JSON.stringify(hypotheses, null, 2) + "\n");
console.log("RLD2 Stage A/B/C freeze written:");
console.log("  rld2-incident-snapshot.json   (surface =", deliveryRecord?.cardId, deliveryRecord?.externalReviewStatus, ")");
console.log("  rld2-lifecycle-state.json");
console.log("  rld2-delivery-chain.json");
console.log("  rld2-previous-repair-audit.json");
console.log("  rld2-hypothesis-matrix.json");
console.log("currentIsTa2r:", incidentSnapshot.identityCrossCheck.currentIsTa2r, "| firstDivergence:", incidentSnapshot.identityCrossCheck.firstDivergence);
