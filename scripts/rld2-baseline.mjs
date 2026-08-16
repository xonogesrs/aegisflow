#!/usr/bin/env node
// scripts/rld2-baseline.mjs
//
// AUTOLOOP-RLD2 — card-start baseline（content-v1, reconstructed）.
//
// The RLD2 investigation was READ-ONLY until the bounded repair; the only
// pre-repair sources modified were:
//   src/governance/review-bundle.mjs
//   scripts/gov-external-review-surface.mjs
// This script reconstructs the EXACT pre-repair content of those two files
//（deterministic structural reversal of the recorded RLD2 edits）and builds
// the RLD2 card-start baseline: every other pre-existing dirty path keeps its
// CURRENT sha（RLD2 never touched it → current == pre-RLD2）; the two modified
// files get the reconstructed pre-RLD2 sha（content proof in
// DELTA_ATTRIBUTION）.
//
// Run: node scripts/rld2-baseline.mjs
// Local-only, deterministic, no network, no commit/push/seal.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "docs", "pi-graph-output", "rld2");

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const canonical = (v) => {
  const sort = (x) => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  };
  return JSON.stringify(sort(v));
};

/** Reconstruct the PRE-RLD2 src/governance/review-bundle.mjs（deterministic
 *  reverse of the RLD2 edits — structural slices, no string-quoting fragility）. */
function reconstructPreRld2ReviewBundle(current) {
  let s = current;
  // 1) remove the RLD2 identity-verified delivery SELECTION block
  //    （comment + bundleContentSha256 + bundleCardIdentity + currentReviewDelivery）:
  //    from the RLD2 comment header up to the next "Recursive canonical JSON".
  const selStart = s.indexOf("// ---------------------------------------------------------------------------\n// RLD2 repair — identity-verified delivery SELECTION");
  if (selStart === -1) throw new Error("review-bundle.mjs: RLD2 selection block marker missing");
  const selEnd = s.indexOf("// Recursive canonical JSON", selStart);
  if (selEnd === -1 || selEnd < selStart) throw new Error("review-bundle.mjs: selection block end marker missing");
  // back up to the START of the separator line preceding the RLD2 comment
  const sep = s.lastIndexOf("// ---------------------------------------------------------------------------\n", selStart);
  s = s.slice(0, sep >= 0 ? sep : selStart) + s.slice(selEnd);
  // 2) revert deliverToExternalReviewSurface signature + currentCardId guard
  const sigOld = "export function deliverToExternalReviewSurface({ bundlePath, state, source = {}, outDir, surfaceDir = null, lock = null, currentCardId = null }) {";
  const sigNew = "export function deliverToExternalReviewSurface({ bundlePath, state, source = {}, outDir, surfaceDir = null, lock = null }) {";
  if (!s.includes(sigOld)) throw new Error("review-bundle.mjs: deliver signature marker missing");
  s = s.replace(sigOld, sigNew);
  const guardStart = s.indexOf("  // RLD2 repair — publish is identity-guarded:");
  if (guardStart === -1) throw new Error("review-bundle.mjs: publish guard marker missing");
  const guardEnd = s.indexOf("  const ownLock = lock ?? acquireExternalReviewSurfaceLock(dir);");
  if (guardEnd === -1 || guardEnd < guardStart) throw new Error("review-bundle.mjs: publish guard end missing");
  s = s.slice(0, guardStart) + s.slice(guardEnd);
  // 3) revert the surface_occupied_by_different_card reason to plain occupied
  const occMark = "surface_occupied_by_different_card";
  const occStart = s.indexOf("        // RLD2 — identity-explicit occupancy: when the occupant belongs to a");
  if (occStart === -1) throw new Error("review-bundle.mjs: occupied reason marker missing");
  const occEnd = s.indexOf("      }\n", occStart);
  if (occEnd === -1 || occEnd < occStart) throw new Error("review-bundle.mjs: occupied reason end missing");
  const plain = "        return { attempted: false, reason: `surface_occupied:${occupied.slice(0, 5).join(\",\")}`, surfaceDir: dir };\n      }\n";
  s = s.slice(0, occStart) + plain + s.slice(occEnd + "      }\n".length);
  if (s.includes(occMark)) throw new Error("review-bundle.mjs: occupied reason reversal incomplete");
  // 4) revert the cached-path identity-divergence guard（structural slice）
  const cStart = s.indexOf("    // When the surface still holds the authoritative record, the cached");
  if (cStart !== -1) {
    const cEnd = s.indexOf("    return {\n      ok: true,\n      bundle: { path: cachedPath");
    if (cEnd === -1 || cEnd < cStart) throw new Error("review-bundle.mjs: cached-path guard slice markers missing");
    s = s.slice(0, cStart) + s.slice(cEnd);
  }
  return s;
}

/** Reconstruct the PRE-RLD2 scripts/gov-external-review-surface.mjs. */
function reconstructPreRld2Cli(current) {
  let s = current;
  // remove currentReviewDelivery import
  if (!s.includes("  currentReviewDelivery,\n")) throw new Error("cli: import marker missing");
  s = s.replace("  currentReviewDelivery,\n", "");
  // (a) FIRST remove the export-for-card mode block（its usage line also
  //     contains <cardId>, which would trip the usage marker check）
  const expStart = s.indexOf("if (mode === \"export-for-card\") {");
  if (expStart === -1) throw new Error("cli: export-for-card block missing");
  const expEnd = s.indexOf("if (mode === \"deliver\") {");
  if (expEnd === -1 || expEnd < expStart) throw new Error("cli: export-for-card end missing");
  s = s.slice(0, expStart) + s.slice(expEnd);
  // (b) revert usage text
  const usageMark = "--export-for-card <cardId>";
  const uStart = s.indexOf("  console.error(\"       node scripts/gov-external-review-surface.mjs --deliver <bundle.txt> [--evidence <evidence.json>] [--card <id>] [--method <m>] [--attempted-at <ISO>] [--force] [--current-card <id>]\");\n");
  if (uStart === -1) throw new Error("cli: usage marker missing");
  const uEnd = s.indexOf("process.exit(2);", uStart);
  if (uEnd === -1 || uEnd < uStart) throw new Error("cli: usage end missing");
  const usagePlain = "  console.error(\"       node scripts/gov-external-review-surface.mjs --deliver <bundle.txt> [--evidence <evidence.json>] [--card <id>] [--method <m>] [--attempted-at <ISO>] [--force]\");\n  console.error(\"       node scripts/gov-external-review-surface.mjs --rotate --verdict PASS|REPAIR|HOLD [--card <id>] [--identity <hex>] [--date <YYYYMMDD>]\");\n";
  s = s.slice(0, uStart) + usagePlain + s.slice(uEnd);
  if (s.includes(usageMark)) throw new Error("cli: usage reversal incomplete");
  // revert mode detection
  const modeOld = "    : process.argv.includes(\"--rotate\") ? \"rotate\"\n      : process.argv.includes(\"--export-for-card\") ? \"export-for-card\" : null;";
  const modeNew = "    : process.argv.includes(\"--rotate\") ? \"rotate\" : null;";
  if (!s.includes(modeOld)) throw new Error("cli: mode marker missing");
  s = s.replace(modeOld, modeNew);
  // revert the --current-card guard in deliver
  const ccMark = "delivery_card_id_mismatch";
  const ccStart = s.indexOf("  const currentCard = arg(\"--current-card\", null);\n");
  if (ccStart !== -1) {
    const ccEnd = s.indexOf("  const source = {\n", ccStart);
    if (ccEnd === -1 || ccEnd < ccStart) throw new Error("cli: current-card guard end missing");
    s = s.slice(0, ccStart) + s.slice(ccEnd);
  }
  if (s.includes(ccMark)) throw new Error("cli: current-card guard reversal incomplete");
  const callOld = "  const d = deliverToExternalReviewSurface({ bundlePath: bp, state: attempted, source, surfaceDir: SURFACE, ...(currentCard ? { currentCardId: currentCard } : {}) });";
  const callNew = "  const d = deliverToExternalReviewSurface({ bundlePath: bp, state: attempted, source, surfaceDir: SURFACE });";
  if (!s.includes(callOld)) throw new Error("cli: deliver call marker missing");
  s = s.replace(callOld, callNew);
  return s;
}

// ── reconstruct + sanity-check the two pre-RLD2 sources ───────────────────
const currentBundleSrc = readFileSync(join(REPO, "src/governance/review-bundle.mjs"), "utf8");
const currentCliSrc = readFileSync(join(REPO, "scripts/gov-external-review-surface.mjs"), "utf8");
const preBundle = reconstructPreRld2ReviewBundle(currentBundleSrc);
const preCli = reconstructPreRld2Cli(currentCliSrc);
// syntax check the reconstructed sources（write to temp files; --check -e is
// unreliable for large modules）
const { writeFileSync: wf } = await import("node:fs");
const tmpBundle = join(OUT, ".pre-rld2-review-bundle.mjs");
const tmpCli = join(OUT, ".pre-rld2-cli.mjs");
mkdirSync(OUT, { recursive: true });
wf(tmpBundle, preBundle, "utf8");
wf(tmpCli, preCli, "utf8");
execFileSync("node", ["--check", tmpBundle], { stdio: "pipe" });
execFileSync("node", ["--check", tmpCli], { stdio: "pipe" });
// remove the syntax-check temp files（they must not leak into the delta）.
const { rmSync } = await import("node:fs");
rmSync(tmpBundle, { force: true });
rmSync(tmpCli, { force: true });
const preBundleSha = sha256(preBundle);
const preCliSha = sha256(preCli);
console.log(`reconstructed pre-RLD2 review-bundle.mjs sha: ${preBundleSha}`);
console.log(`reconstructed pre-RLD2 gov-external-review-surface.mjs sha: ${preCliSha}`);

// ── build the baseline ────────────────────────────────────────────────────
const MODIFIED = new Set(["src/governance/review-bundle.mjs", "scripts/gov-external-review-surface.mjs"]);
const ADDED_PREFIXES = ["scripts/rld2-", "docs/pi-graph-output/rld2/", "test/governance/test-rld2-stale-delivery.mjs"];
const isAdded = (p) => ADDED_PREFIXES.some((a) => p === a.replace(/\/$/, "") || p.startsWith(a));

// Enumerate individual dirty paths via the same canonical-status machinery the
// ta2/ta3 baselines use（raw porcelain collapses untracked DIRECTORIES into a
// single entry — that would mis-attribute every historical file as ADDED）.
const { collectRepoFacts } = await import("../src/governance/review-bundle.mjs");
const facts = collectRepoFacts(REPO);
const dirtyPaths = [];
const canonicalLines = [];
for (const line of facts.canonicalLines) {
  const arrow = line.indexOf(" -> ");
  const paths = arrow >= 0 ? line.slice(3).split(" -> ").map((x) => x.trim()) : [line.slice(3).trim()];
  const kept = paths.map((p) => p.replace(/\/$/, "")).filter((p) => !isAdded(p));
  for (const p of kept) if (!dirtyPaths.includes(p)) dirtyPaths.push(p);
  if (kept.length === paths.length) canonicalLines.push(line);
}
canonicalLines.sort();

const pathShas = {};
const { statSync } = await import("node:fs");
for (const p of dirtyPaths) {
  const full = join(REPO, p);
  if (MODIFIED.has(p)) {
    pathShas[p] = p === "src/governance/review-bundle.mjs" ? preBundleSha : preCliSha;
  } else {
    let isFile = false;
    try { isFile = statSync(full).isFile(); } catch { /* missing/dir */ }
    pathShas[p] = isFile ? sha256(readFileSync(full)) : null;
  }
}
const head = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const treeSha = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
const branch = execFileSync("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
const baseline = {
  schema: "autoloop.card-inventory.baseline/v1",
  cardId: "AUTOLOOP-RLD2",
  cardTitle: "Recurring Stale Review Bundle Delivery Root-Cause Investigation (RLD2)",
  cardType: "repair",
  capturedAt: new Date().toISOString(),
  attributionModel: "content-v1",
  head,
  treeSha,
  branch,
  dirtyDigest: `dirty:${sha256(canonicalLines.join("\n"))}`,
  canonicalLines,
  dirtyPaths,
  pathShas,
  reconstructionNote: "pre-RLD2 content of the two modified sources was reconstructed by deterministic structural reversal of the recorded RLD2 edits (the investigation phase was read-only; no other source was modified)",
};
baseline.contentDigest = sha256(canonical({ head, treeSha, pathShas }));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "rld2-card-start-baseline.json"), JSON.stringify(baseline, null, 2) + "\n");
console.log(`RLD2 baseline: ${baseline.dirtyPaths.length} dirty paths; contentDigest ${String(baseline.contentDigest).slice(0, 12)}`);
console.log(`output: ${join(OUT, "rld2-card-start-baseline.json")}`);
