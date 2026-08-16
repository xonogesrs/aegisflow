#!/usr/bin/env node
// scripts/ta2r-capture-baseline.mjs
//
// TA-2R（REPAIR / TA2_ADMISSION_AUTHORITY_AND_CLOSEOUT_SURFACE_INCONSISTENT,
// findings digest 984d3bd60f26eb0028fd13dcdf0e80e616e613be7244ebe26224151b004d6d76,
// superseding bundle 432e85b5742b194d24c4558b1eec8f1415dcdc6ee52c2f934eff900f9e0a6272
// / d776ff5a91269c413c15fdd6cd3668cdb5f4b823b6e6837c6f52e1803224a12b）.
//
// The TA-2 card-start baseline（ta2-card-start-baseline.json）predates
// content-identity capture: it records only PATH membership（dirtyPaths +
// canonicalLines + dirtyDigest）, so which pre-existing dirty files were
// content-modified during TA-2 is NOT machine-attributable. Per the external
// review's fail-closed attribution rule, TA-2R does NOT guess retroactively;
// instead it establishes the CONTENT-IDENTITY baseline model going forward
// and captures a TRUE card-start snapshot for THIS repair generation.
//
// This script captures docs/pi-graph-output/ta2r/ta2r-card-start-baseline.json
// with per-path content sha256（pathShas）+ contentDigest + attributionModel
// "content-v1", using the CURRENT（pre-repair）worktree — i.e. the true
// TA-2R card-start state（TA-2 final）. It self-excludes the capture artifact
// itself so the delta（closeout − this baseline）attributes exactly the TA-2R
// changes with content proof.
//
// MUST be run BEFORE any other TA-2R source edit.
//
// Run: node scripts/ta2r-capture-baseline.mjs
// Local-only, deterministic, no network, no commit/push/seal.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { collectRepoFacts } from "../src/governance/review-bundle.mjs";
import { CARD_INVENTORY_BASELINE_SCHEMA } from "../src/governance/card-inventory.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_A = join(HERE, "..");
const OUT = join(REPO_A, "docs/pi-graph-output", "ta2r");

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const canonical = (v) => {
  const sort = (x) => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  };
  return JSON.stringify(sort(v));
};

// The capture artifact itself is excluded from the snapshot（its presence at
// card-start is a property of the repair tooling, not of the delta）.
const SELF_PATHS = new Set(["scripts/ta2r-capture-baseline.mjs"]);

// ── current（TA-2 final == TA-2R card start）repo facts ───────────────────
const facts = collectRepoFacts(REPO_A);

// ── per-path content identity（sha256 of the working-tree file at capture）─
function fileSha(path) {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null; // deleted / unreadable at capture time
  }
}
const pathShas = {};
const baselineDirtyPaths = [];
const baselineCanonicalLines = [];
for (const line of facts.canonicalLines) {
  const arrow = line.indexOf(" -> ");
  const status = line.slice(0, 2).trim();
  const paths = arrow >= 0 ? line.slice(3).split(" -> ").map((x) => x.trim()) : [line.slice(3).trim()];
  if (paths.some((p) => SELF_PATHS.has(p))) continue; // exclude the capture artifact
  baselineCanonicalLines.push(line);
  for (const p of paths) {
    if (baselineDirtyPaths.includes(p)) continue;
    baselineDirtyPaths.push(p);
    pathShas[p] = fileSha(join(REPO_A, p));
  }
}
baselineCanonicalLines.sort();
baselineDirtyPaths.sort();
const dirtyDigest = baselineCanonicalLines.length > 0 ? `dirty:${sha256(baselineCanonicalLines.join("\n"))}` : "clean";
const contentDigest = sha256(canonical(pathShas));

// ── write the snapshot ────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const baseline = {
  schema: CARD_INVENTORY_BASELINE_SCHEMA,
  cardId: "AUTOLOOP-TA2",
  generation: "TA-2R",
  capturedAt: new Date().toISOString(),
  repository: facts.repository,
  branch: facts.branch,
  head: facts.head,
  treeSha: facts.treeSha,
  worktreePath: facts.worktreePath,
  dirtyPaths: baselineDirtyPaths,
  untrackedFiles: baselineCanonicalLines.filter((l) => l.startsWith("?? ")).map((l) => l.slice(3).trim()),
  canonicalLines: baselineCanonicalLines,
  dirtyDigest,
  attributionModel: "content-v1",
  pathShas,
  contentDigest,
  provenance: {
    method: "TA-2R card-start content-identity capture (pre-repair worktree == TA-2 final)",
    reason: "external review finding 2: TA-2 card-start baseline predates content-identity capture; TA-2R captures a true card-start snapshot with per-path sha256 so its own delta is machine-attributable, and records the TA-2 wire-edit attribution as fail-closed (not guessed)",
    supersededBundleIdentity: "432e85b5742b194d24c4558b1eec8f1415dcdc6ee52c2f934eff900f9e0a6272",
    supersededBundleSha256: "d776ff5a91269c413c15fdd6cd3668cdb5f4b823b6e6837c6f52e1803224a12b",
    excludedCaptureArtifacts: [...SELF_PATHS],
    dirtyPaths: baselineDirtyPaths.length,
    untrackedFiles: baselineCanonicalLines.filter((l) => l.startsWith("?? ")).length,
  },
};
const outPath = join(OUT, "ta2r-card-start-baseline.json");
writeFileSync(outPath, JSON.stringify(baseline, null, 2) + "\n");

console.log(`baseline written: ${outPath}`);
console.log(`baseline head=${baseline.head} treeSha=${baseline.treeSha} dirtyPaths=${baselineDirtyPaths.length} dirtyDigest=${dirtyDigest}`);
console.log(`content identity: ${Object.keys(pathShas).length} paths, contentDigest=${contentDigest}`);
process.exit(0);
