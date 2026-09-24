#!/usr/bin/env node
// benchmarks/analysis/append-analysis.mjs
//
// Generates the committed analysis artifact from the raw results, so
// `results/analysis.json` is reproducible rather than hand-maintained.
//
// Usage: node benchmarks/analysis/append-analysis.mjs [--baseline ARM]

import { writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, loadRuns } from "./analyze.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const RESULTS = join(REPO, "benchmarks", "results");

const bi = process.argv.indexOf("--baseline");
const baseline = bi === -1 ? "CONTROL" : process.argv[bi + 1];

// Include any learning-period samples in the record, but never as a compared
// arm: `analyze` only compares arms present in the runs, so pass them through
// and let the comparison section stay honest about which arms are treatments.
const { runs, arms } = loadRuns({ resultsDir: RESULTS });
if (runs.length === 0) {
  console.error("no raw results in benchmarks/results — run the benchmark first");
  process.exitCode = 1;
} else {
  const report = analyze({ resultsDir: RESULTS, baseline });
  const out = join(RESULTS, "analysis.json");
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${out}`);
  console.log(`runs=${report.runs} arms=${report.arms.join(",")} baseline=${baseline}`);
  for (const arm of report.arms) {
    const s = report.by_arm[arm];
    console.log(`  ${arm.padEnd(18)} n=${s.n_runs} success=${(s.task_success.p * 100).toFixed(1)}% hold=${(s.hold.p * 100).toFixed(1)}% median_ms=${Math.round(s.wall_clock_ms.median)} median_tokens=${Math.round(s.total_tokens.median)}`);
  }
}

// Also record which raw files contributed, so the analysis is traceable.
const files = existsSync(RESULTS) ? readdirSync(RESULTS).filter((f) => f.endsWith(".jsonl")).sort() : [];
const provenance = {
  schema: "autoloop.benchmark-results-provenance/v1",
  generated_at: new Date().toISOString(),
  raw_files: files.map((f) => ({ file: f, runs: readFileSync(join(RESULTS, f), "utf8").trim().split("\n").filter(Boolean).length })),
  baseline,
};
writeFileSync(join(RESULTS, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`wrote ${join(RESULTS, "provenance.json")}`);
