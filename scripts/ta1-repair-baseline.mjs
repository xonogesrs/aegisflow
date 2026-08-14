#!/usr/bin/env node
// scripts/ta1-repair-baseline.mjs
//
// TA-1 bounded repair (REPAIR / TA1_POST_FM3_INVENTORY_PROVENANCE_MISSING,
// findings digest 77db57de...): reconstruct the TA-1 CARD-START baseline
// snapshot (schema autoloop.card-inventory.baseline/v1) with a PROVEN
// provenance chain, and write it to docs/pi-graph-output/ta1/ so the closeout
// contract can bind FM-3's delta-v1 inventory model (CARD_INVENTORY_MODEL,
// BASELINE_HEAD, card-start baseline, CURRENT_CARD_DELTA_PATHS).
//
// Why the baseline was missing: the first TA-1 closeout ran the legacy
// regenerate-style path (mirroring de1r-self-closeout.mjs) whose closeout
// contract carried no `baseline` snapshot — the FM-3 gate only activates
// (renders delta-v1 + runs validateCardInventoryConsistency) when the closeout
// contract captured a card-start baseline. Root cause is therefore:
// the TA-1 self-closeout script did not call captureBaselineInventory() /
// supply closeout.baseline. This is the lifecycle bug this repair fixes for
// TA-1; the same fix is mandatory for every future card (see
// ta1-machine-readable-admission-contract.json + ta1-integration-map.json
// "card-start baseline captured and persisted" requirement, which TA-1 itself
// prescribed and now dogfoods).
//
// Provenance reconstruction (honest + machine-checkable):
//   TA-1 card start == FM-3 final on-disk state, because FM-3 formally closed
//   before TA-1 began and nothing else touched the repo between FM-3's final
//   bundle (d82c7010) and TA-1's first artifact. FM-3's final state is itself
//   DOCUMENTED in the d82c7010 bundle §20 (DIRTY_PATHS + UNTRACKED_FILES) —
//   captured before the bundle file itself was written, so the on-disk card
//   start additionally contains FM-3's own authoritative bundle artifact.
//   Proof: current-worktree-minus-TA-1-artifacts must EXACTLY equal
//   (FM-3 §20 inventory ∪ {fm3-rbi/card-closeout-bundle-20260808-d82c7010.txt}).
//   The script ABORTS (exit 2) if the equality fails — the reconstruction is
//   only ever accepted with proof.
//
// Run: node scripts/ta1-repair-baseline.mjs
// Local-only, deterministic, no network, no commit/push/seal.

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { collectRepoFacts } from "../src/governance/review-bundle.mjs";
import { CARD_INVENTORY_BASELINE_SCHEMA } from "../src/governance/card-inventory.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_A = join(HERE, "..");
const OUT = join(REPO_A, "docs/pi-graph-output/ta1");
const FM3_BUNDLE = join(REPO_A, "docs/pi-graph-output/fm3-rbi/card-closeout-bundle-20260808-d82c7010.txt");
const FM3_FINAL_DIGEST = "dirty:edc257f829aa72596a86cd0e6be172bc3995c35c14dca3be9043b74653b690f9";
const FM3_BUNDLE_ARTIFACT = "docs/pi-graph-output/fm3-rbi/card-closeout-bundle-20260808-d82c7010.txt";

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

// ── 1) FM-3 documented final inventory（§20）───────────────────────────────
const fm3Text = readFileSync(FM3_BUNDLE, "utf8");
const dirtyLine = fm3Text.match(/^DIRTY_PATHS:\s*(.+)$/m)?.[1] ?? "";
const untrackedLine = fm3Text.match(/^UNTRACKED_FILES:\s*(.+)$/m)?.[1] ?? "";
const split = (s) => s.split(",").map((p) => p.trim()).filter((p) => p && p !== "[]" && p !== "NOT_APPLICABLE");
const fm3Dirty = new Set(split(dirtyLine));
const fm3Untracked = new Set(split(untrackedLine));
const fm3Expected = new Set([...fm3Dirty, ...fm3Untracked]);
// FM-3's own authoritative bundle artifact was written after its §20 capture:
// it is part of the on-disk card-start state.
fm3Expected.add(FM3_BUNDLE_ARTIFACT);
console.log(`FM-3 documented inventory: ${fm3Dirty.size} dirty / ${fm3Untracked.size} untracked -> ${fm3Expected.size} unique card-start paths (incl. FM-3 bundle artifact)`);

// ── 2) current facts + TA-1 artifact paths ─────────────────────────────────
const facts = collectRepoFacts(REPO_A);
const ta1Files = readdirSync(OUT).filter((f) => !f.startsWith("."));
const ta1Paths = new Set([
  "scripts/ta1-verify.mjs",
  "scripts/ta1-self-closeout.mjs",
  "scripts/ta1-repair-baseline.mjs",
  ...ta1Files.map((f) => `docs/pi-graph-output/ta1/${f}`),
]);
console.log(`TA-1 artifacts to exclude: ${ta1Paths.size} (${ta1Files.length} in ta1/ + 2 scripts)`);

const isTa1 = (p) => ta1Paths.has(p);
const currentAll = [...new Set([...facts.dirtyPaths, ...facts.untrackedFiles])];
const reconstructed = currentAll.filter((p) => !isTa1(p)).sort();

// ── 3) PROOF: reconstructed card-start == FM-3 documented state ───────────
const expectedList = [...fm3Expected].sort();
const missing = expectedList.filter((p) => !reconstructed.includes(p));
const extra = reconstructed.filter((p) => !fm3Expected.has(p));
if (missing.length || extra.length) {
  console.error("PROVENANCE_PROOF_FAILED — reconstructed card-start does not match FM-3 documented state");
  if (missing.length) console.error(`  missing from reconstruction (in FM-3 §20 but not in current-minus-TA1):\n    ${missing.slice(0, 20).join("\n    ")}`);
  if (extra.length) console.error(`  unexpected in reconstruction (in current-minus-TA1 but not in FM-3 §20):\n    ${extra.slice(0, 20).join("\n    ")}`);
  process.exit(2);
}
console.log(`PROOF OK: reconstructed card-start == FM-3 documented final state (${reconstructed.length} paths)`);

// ── 4) canonical records at card start（same porcelain parser truth）───────
// Reconstruct canonical lines by filtering the CURRENT canonical records:
// keep only records whose affected paths are all non-TA-1. (collectRepoFacts'
// canonical lines are `STATUS path` / `STATUS src -> dst` strings.)
function recordPaths(canonicalLine) {
  const arrow = canonicalLine.indexOf(" -> ");
  const st = canonicalLine.slice(0, 3).trim();
  if (arrow >= 0) return [canonicalLine.slice(0, arrow).split(" ").slice(1).join(" ").trim(), canonicalLine.slice(arrow + 4).trim()];
  return [canonicalLine.slice(3).trim()];
}
const baselineCanonicalLines = facts.canonicalLines
  .filter((l) => !recordPaths(l).some((p) => isTa1(p)))
  .sort();
const baselineDigest = baselineCanonicalLines.length > 0 ? `dirty:${sha256(baselineCanonicalLines.join("\n"))}` : "clean";
const baselineDirtyPaths = [...new Set(baselineCanonicalLines.flatMap(recordPaths))].sort();
const baselineUntracked = baselineCanonicalLines.filter((l) => l.startsWith("?? ")).map((l) => l.slice(3).trim());

// sanity: reconstructed path set == baselineDirtyPaths（same truth）.
const fromCanonical = new Set(baselineDirtyPaths);
const diff = reconstructed.filter((p) => !fromCanonical.has(p)).concat([...fromCanonical].filter((p) => !reconstructed.includes(p)));
if (diff.length) {
  console.error(`PROVENANCE_INTERNAL_MISMATCH: path-set vs canonical-record reconstruction differ: ${diff.slice(0, 10).join(", ")}`);
  process.exit(2);
}

// ── 5) write the baseline snapshot ─────────────────────────────────────────
const baseline = {
  schema: CARD_INVENTORY_BASELINE_SCHEMA,
  cardId: "AUTOLOOP-TA1",
  capturedAt: new Date().toISOString(),
  repository: facts.repository,
  branch: facts.branch,
  head: facts.head,
  treeSha: facts.treeSha,
  worktreePath: facts.worktreePath,
  dirtyPaths: baselineDirtyPaths,
  untrackedFiles: baselineUntracked,
  canonicalLines: baselineCanonicalLines,
  dirtyDigest: baselineDigest,
  provenance: {
    method: "bounded-repair reconstruction with machine-checkable proof",
    reason: "first TA-1 closeout ran the legacy regenerate path without a card-start baseline (FM-3 delta-v1 gate never activated); reconstructed during bounded repair per REPAIR / TA1_POST_FM3_INVENTORY_PROVENANCE_MISSING (findings digest 77db57de45441603a1a3cd64821d4c2091b427adfe102d9107d64f180b701783)",
    proof: "current-worktree-minus-TA-1-artifacts EXACTLY equals FM-3 bundle d82c7010 §20 DIRTY_PATHS ∪ UNTRACKED_FILES plus FM-3's own authoritative bundle artifact (written after its §20 capture)",
    fm3BundleIdentity: "d82c70109150e94e41fa28176ab99212bef904b602e882efde6743859f2dd23c",
    fm3FinalDirtyDigest: FM3_FINAL_DIGEST,
    fm3DocumentedPaths: fm3Expected.size,
    reconstructedPaths: reconstructed.length,
    ta1ArtifactPathsExcluded: ta1Paths.size,
  },
};
const outPath = join(OUT, "ta1-card-start-baseline.json");
writeFileSync(outPath, JSON.stringify(baseline, null, 2) + "\n");

console.log(`baseline written: ${outPath}`);
console.log(`baseline head=${baseline.head} treeSha=${baseline.treeSha} dirtyPaths=${baselineDirtyPaths.length} dirtyDigest=${baselineDigest}`);
process.exit(0);
