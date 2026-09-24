#!/usr/bin/env node
// scripts/evolution-operator.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Section L: the
// read-only operator evolution view CLI.
//
//   node scripts/evolution-operator.mjs [--store <dir>] [--json]
//
// READ ONLY / ADVISORY: performs zero writes and zero mutations; no
// production authority consumes its output. Safe against an absent store,
// a corrupt store, and an active evolution cycle. The operator can inspect
// the evolution state; normal operation requires no intervention.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildEvolutionReport, renderEvolutionReportText } from "../src/evolution/operator-view.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

const usage = () => {
  console.error("usage:");
  console.error("  node scripts/evolution-operator.mjs [--store <dir>] [--json]");
  process.exit(2);
};

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
const store = arg("--store");
const asJson = process.argv.includes("--json");

const report = buildEvolutionReport({ storeRoot: store ? resolve(store) : undefined });

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderEvolutionReportText(report));
}

// Advisory surface: exit 0 whenever a safe report was produced.
process.exit(report && report.schema ? 0 : 1);
