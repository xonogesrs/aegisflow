#!/usr/bin/env node
// scripts/ta3-capture-baseline.mjs
//
// AUTOLOOP-TA3 — card-start baseline capture（content-v1, mirroring the
// TA-2R process）. Captures docs/pi-graph-output/ta3/ta3-card-start-baseline.json
// with per-path content sha256（pathShas）+ contentDigest + attributionModel
// "content-v1", using the CURRENT（pre-TA-3）worktree state.
//
// MUST be run BEFORE any TA-3 source edit.
//
// Run: node scripts/ta3-capture-baseline.mjs
// Local-only, deterministic, no network, no commit/push/seal.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { collectRepoFacts } from "../src/governance/review-bundle.mjs";
import { CARD_INVENTORY_BASELINE_SCHEMA } from "../src/governance/card-inventory.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_A = join(HERE, "..");
const OUT = join(REPO_A, "docs/pi-graph-output", "ta3");

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
// card-start is a property of the card tooling, not of the delta）.
const SELF_PATHS = new Set(["scripts/ta3-capture-baseline.mjs"]);

const facts = collectRepoFacts(REPO_A);

function fileSha(path) {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}
const pathShas = {};
const baselineDirtyPaths = [];
const baselineCanonicalLines = [];
for (const line of facts.canonicalLines) {
  const arrow = line.indexOf(" -> ");
  const status = line.slice(0, 2).trim();
  const paths = arrow >= 0 ? line.slice(3).split(" -> ").map((x) => x.trim()) : [line.slice(3).trim()];
  if (paths.some((p) => SELF_PATHS.has(p))) continue;
  baselineCanonicalLines.push(line);
  for (const p of paths) {
    if (baselineDirtyPaths.includes(p)) continue;
    baselineDirtyPaths.push(p);
    pathShas[p] = fileSha(join(REPO_A, p));
  }
}
baselineCanonicalLines.sort();

const baseline = {
  schema: CARD_INVENTORY_BASELINE_SCHEMA,
  cardId: "AUTOLOOP-TA3",
  cardTitle: "Admission-Driven Runtime Budget Enforcement (TA-3)",
  cardType: "implementation",
  capturedAt: new Date().toISOString(),
  attributionModel: "content-v1",
  head: facts.head,
  treeSha: facts.treeSha,
  branch: facts.branch,
  dirtyDigest: facts.baselineDirtyDigest,
  canonicalLines: baselineCanonicalLines,
  dirtyPaths: baselineDirtyPaths,
  pathShas,
  contentDigest: sha256(canonical({ head: facts.head, treeSha: facts.treeSha, pathShas })),
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "ta3-card-start-baseline.json"), JSON.stringify(baseline, null, 2) + "\n");
console.log(`TA-3 baseline captured: ${baseline.dirtyPaths.length} dirty paths, contentDigest ${String(baseline.contentDigest).slice(0, 12)}`);
console.log(`output: ${join(OUT, "ta3-card-start-baseline.json")}`);
