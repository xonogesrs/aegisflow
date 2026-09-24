#!/usr/bin/env node
// benchmarks/analysis/analyze.mjs
//
// Reads benchmarks/results/*.jsonl and produces the statistics the benchmark
// report publishes.
//
// It reports, per arm and per task class:
//   count, mean, median, standard deviation, p25/p75 for every continuous
//   metric; success proportion for the binary ones; and absolute + relative
//   differences between arms. A 95% confidence interval is reported when the
//   sample is large enough to make one meaningful, and omitted (with a note)
//   when it is not.
//
// Deliberately not computed: any composite "score". The point is to show the
// raw distributions, including the ones that look bad for AutoLoop.
//
// Usage:
//   node benchmarks/analysis/analyze.mjs                     # all arms present
//   node benchmarks/analysis/analyze.mjs --json              # machine-readable
//   node benchmarks/analysis/analyze.mjs --baseline CONTROL

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const RESULTS_DIR = join(REPO, "benchmarks", "results");

export const CONTINUOUS_METRICS = Object.freeze([
  "wall_clock_ms",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "context_occupancy",
  "model_call_count",
  "executor_attempts",
  "reviewer_attempts",
  "repairs",
]);

export const PROPORTION_METRICS = Object.freeze([
  "task_success",
  "first_pass",
  "hold",
]);

/** z for a 95% two-sided interval. */
const Z95 = 1.959963984540054;

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function describe(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return { n: 0, mean: null, median: null, stdev: null, p25: null, p75: null, min: null, max: null };
  const sorted = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.length > 1 ? v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1) : 0;
  return {
    n: v.length,
    mean,
    median: quantile(sorted, 0.5),
    stdev: Math.sqrt(variance),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * 95% CI for a proportion (Wald). Reported only for n >= 10: below that the
 * normal approximation is not defensible, and a bogus interval is worse than
 * an explicit "insufficient sample".
 */
export function proportionCI(successes, n) {
  if (n === 0) return null;
  const p = successes / n;
  if (n < 10) return { p, n, lower: null, upper: null, note: "n < 10: interval omitted (normal approximation not defensible)" };
  const se = Math.sqrt((p * (1 - p)) / n);
  return { p, n, lower: Math.max(0, p - Z95 * se), upper: Math.min(1, p + Z95 * se) };
}

/** CI for a mean difference (Welch), reported only when both arms have n >= 10. */
export function meanDifferenceCI(a, b) {
  const da = describe(a);
  const db = describe(b);
  if (da.n < 10 || db.n < 10) {
    return { absolute: (db.mean ?? 0) - (da.mean ?? 0), relative: null, lower: null, upper: null, note: "interval omitted: need n >= 10 in both arms" };
  }
  const se = Math.sqrt((da.stdev ** 2) / da.n + (db.stdev ** 2) / db.n);
  const diff = db.mean - da.mean;
  return {
    absolute: diff,
    relative: da.mean === 0 ? null : diff / da.mean,
    lower: diff - Z95 * se,
    upper: diff + Z95 * se,
    note: null,
  };
}

export function loadRuns({ resultsDir = RESULTS_DIR } = {}) {
  if (!existsSync(resultsDir)) return { runs: [], arms: [], manifest: null };
  const files = readdirSync(resultsDir).filter((f) => f.endsWith(".jsonl"));
  const runs = [];
  for (const f of files) {
    const text = readFileSync(join(resultsDir, f), "utf8").trim();
    if (text.length === 0) continue;
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      runs.push(JSON.parse(line));
    }
  }
  const manifestPath = join(resultsDir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  return { runs, arms: [...new Set(runs.map((r) => r.arm))].sort(), manifest };
}

/** Group runs by (arm) and (arm, task_class). */
export function group(runs) {
  const byArm = new Map();
  const byArmClass = new Map();
  for (const r of runs) {
    if (!byArm.has(r.arm)) byArm.set(r.arm, []);
    byArm.get(r.arm).push(r);
    const k = `${r.arm}|${r.task_class}`;
    if (!byArmClass.has(k)) byArmClass.set(k, []);
    byArmClass.get(k).push(r);
  }
  return { byArm, byArmClass };
}

export function summarizeArm(rows) {
  const out = { n_runs: rows.length, task_ids: [...new Set(rows.map((r) => r.task_id))].sort() };
  for (const m of CONTINUOUS_METRICS) out[m] = describe(rows.map((r) => r[m]));
  for (const m of PROPORTION_METRICS) {
    const successes = rows.filter((r) => r[m] === true).length;
    out[m] = proportionCI(successes, rows.length);
  }
  out.errors = rows.filter((r) => typeof r.error === "string").length;
  out.scope_clean_proportion = proportionCI(rows.filter((r) => r.scope_clean === true).length, rows.length);
  return out;
}

export function analyze({ resultsDir = RESULTS_DIR, baseline = "CONTROL" } = {}) {
  const { runs, arms, manifest } = loadRuns({ resultsDir });
  if (runs.length === 0) {
    return { schema: "autoloop.benchmark-analysis/v1", generated_at: new Date().toISOString(), manifest, arms: [], runs: 0, note: "no raw results present", by_arm: {}, by_arm_class: {}, comparisons: [] };
  }
  const { byArm, byArmClass } = group(runs);
  const by_arm = {};
  for (const [arm, rows] of byArm) by_arm[arm] = summarizeArm(rows);
  const by_arm_class = {};
  for (const [k, rows] of byArmClass) by_arm_class[k] = summarizeArm(rows);

  // Comparisons: every other arm against the baseline, overall and per class.
  //
  // A LEARNING_PERIOD sample is compared too, but flagged: it is an EXPLORATION
  // sample (a different strategy value, run to give the memory evidence), not a
  // treatment condition. Reporting its numbers is informative — it shows the
  // effect of the value it explored — while the flag stops a reader from
  // treating it as an arm of the experiment.
  const comparisons = [];
  const baselineRows = byArm.get(baseline) ?? [];
  for (const arm of arms) {
    if (arm === baseline) continue;
    const rows = byArm.get(arm) ?? [];
    const cmp = {
      arm,
      baseline,
      n_baseline: baselineRows.length,
      n_arm: rows.length,
      is_exploration_sample: arm === "LEARNING_PERIOD",
      ...(arm === "LEARNING_PERIOD"
        ? { exploration_note: "EXPLORATION SAMPLE, not a treatment arm: it runs an alternative strategy value so the strategy memory has evidence to learn from (see docs/benchmark.md §1)." }
        : {}),
      metrics: {},
    };
    for (const m of CONTINUOUS_METRICS) {
      cmp.metrics[m] = meanDifferenceCI(baselineRows.map((r) => r[m]), rows.map((r) => r[m]));
    }
    for (const m of PROPORTION_METRICS) {
      const pb = proportionCI(baselineRows.filter((r) => r[m] === true).length, baselineRows.length);
      const pa = proportionCI(rows.filter((r) => r[m] === true).length, rows.length);
      cmp.metrics[m] = {
        baseline: pb, arm: pa,
        absolute_difference: (pa?.p ?? null) !== null && (pb?.p ?? null) !== null ? pa.p - pb.p : null,
        relative_difference: pb?.p ? (pa.p - pb.p) / pb.p : null,
      };
    }
    comparisons.push(cmp);
  }

  return {
    schema: "autoloop.benchmark-analysis/v1",
    generated_at: new Date().toISOString(),
    manifest,
    runs: runs.length,
    arms,
    baseline,
    by_arm,
    by_arm_class,
    comparisons,
  };
}

// ── Console report ─────────────────────────────────────────────────────────

function fmt(x, digits = 2) {
  return typeof x === "number" && Number.isFinite(x) ? x.toFixed(digits) : "n/a";
}
function pct(x) {
  return typeof x === "number" && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
}

function printReport(a) {
  if (a.runs === 0) { console.log(a.note); return; }
  console.log(`AutoLoop effectiveness benchmark — analysis`);
  console.log(`generated: ${a.generated_at}`);
  console.log(`runs: ${a.runs}   arms: ${a.arms.join(", ")}   baseline: ${a.baseline}`);
  if (a.manifest) {
    console.log(`node: ${a.manifest.node_version}   platform: ${a.manifest.platform}   runs/arm/task: ${a.manifest.runs_per_arm_per_task}`);
    for (const arm of a.arms) console.log(`route[${arm}] = ${a.manifest[`route_${arm}`] ?? "n/a"} (${a.manifest[`route_source_${arm}`] ?? "?"})`);
  }

  console.log("\n── BY ARM ─────────────────────────────────────────────────────────");
  const header = ["metric", ...a.arms];
  console.log(header.map((h) => String(h).padEnd(22)).join(""));
  const rowsFor = (key, render) => {
    console.log([key, ...a.arms.map((arm) => render(a.by_arm[arm]))].map((c) => String(c).padEnd(22)).join(""));
  };
  rowsFor("n_runs", (s) => s.n_runs);
  for (const m of PROPORTION_METRICS) rowsFor(`${m} (prop)`, (s) => `${pct(s[m]?.p)} [${s[m]?.n ?? 0}]`);
  for (const m of ["wall_clock_ms", "input_tokens", "output_tokens", "total_tokens", "model_call_count", "repairs", "executor_attempts"]) {
    rowsFor(`${m} median`, (s) => fmt(s[m].median));
  }
  for (const m of ["wall_clock_ms", "total_tokens"]) {
    rowsFor(`${m} p25/p75`, (s) => `${fmt(s[m].p25)}/${fmt(s[m].p75)}`);
  }
  rowsFor("mean stdev (tokens)", (s) => fmt(s.total_tokens.stdev));
  rowsFor("errors", (s) => s.errors);

  console.log("\n── COMPARISONS vs BASELINE ───────────────────────────────────────");
  for (const c of a.comparisons) {
    console.log(`\n${c.arm}  (n=${c.n_arm}) vs ${c.baseline} (n=${c.n_baseline})`);
    if (c.is_exploration_sample) console.log(`  ⚠ ${c.exploration_note}`);
    for (const m of PROPORTION_METRICS) {
      const x = c.metrics[m];
      console.log(`  ${m.padEnd(16)} baseline ${pct(x.baseline?.p)} → ${pct(x.arm?.p)}   abs ${x.absolute_difference === null ? "n/a" : (x.absolute_difference * 100).toFixed(1) + "pp"}   rel ${x.relative_difference === null ? "n/a" : (x.relative_difference * 100).toFixed(1) + "%"}`);
    }
    for (const m of ["wall_clock_ms", "total_tokens", "repairs"]) {
      const x = c.metrics[m];
      console.log(`  ${m.padEnd(16)} abs ${fmt(x.absolute)}   rel ${x.relative === null ? "n/a" : (x.relative * 100).toFixed(1) + "%"}${x.note ? `   (${x.note})` : `   95% CI [${fmt(x.lower)}, ${fmt(x.upper)}]`}`);
    }
  }

  console.log("\n── HONESTY NOTES ────────────────────────────────────────────────");
  console.log("  • Proportions and differences are reported with their sample sizes.");
  console.log("  • Confidence intervals are omitted below n=10 rather than approximated.");
  console.log("  • No composite score is computed: every metric above, including the ones");
  console.log("    unfavourable to AutoLoop, is part of the reported result.");
  const negative = [];
  for (const c of a.comparisons) {
    if ((c.metrics.task_success.absolute_difference ?? 0) < 0) negative.push(`${c.arm}: success rate lower than baseline`);
    if ((c.metrics.wall_clock_ms.absolute ?? 0) > 0) negative.push(`${c.arm}: slower than baseline (median delta ${fmt(c.metrics.wall_clock_ms.absolute)} ms)`);
    if ((c.metrics.total_tokens.absolute ?? 0) > 0) negative.push(`${c.arm}: more tokens than baseline (median delta ${fmt(c.metrics.total_tokens.absolute)})`);
  }
  console.log(negative.length > 0
    ? `  • Observed negative results: ${negative.join("; ")}`
    : "  • No negative deltas observed in the sampled metrics.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const json = process.argv.includes("--json");
  const bi = process.argv.indexOf("--baseline");
  const baseline = bi === -1 ? "CONTROL" : process.argv[bi + 1];
  const a = analyze({ baseline });
  if (json) console.log(JSON.stringify(a, null, 2));
  else printReport(a);
}
