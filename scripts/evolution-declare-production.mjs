#!/usr/bin/env node
// scripts/evolution-declare-production.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVIDENCE_FEED_REPAIR_1 — Section J.2: THE operator
// step that WRITES the deployment's evolution production declaration.
//
//   node scripts/evolution-declare-production.mjs \
//     --out <path/to/declaration.json> \
//     --store-root <dir> --checkpoint-root <dir> --repo-root <dir> \
//     --task-class <token> \
//     --strategy-baseline MODEL_ROUTING=provider/model [--strategy-baseline ...] \
//     [--strategy-dimension MODEL_ROUTING] [--reviewer <identity>] \
//     [--prompt-profile <token>] [--canary-window-ms <int>] \
//     [--declared-by <identity>] [--json]
//
// The written record is validated by readEvolutionProductionDeclaration before
// it is published (exclusive-create; an identical re-declaration is
// idempotent and a conflicting one fails closed). The file is then read by the
// production gate through `AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG`, so a
// deployment declares its paths in ONE place — no machine-specific absolute
// path belongs in source.
//
// READ-ONLY over production refs: this script writes exactly one JSON record
// and touches nothing else.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  EVOLUTION_DECLARATION_SCHEMA, EVOLUTION_DECLARATION_ENV,
  validateEvolutionDeclaration,
} from "../src/evolution/production-declaration.mjs";

function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === name) out.push(process.argv[i + 1]);
  }
  return out;
}
function arg(name) {
  const v = argAll(name);
  return v.length > 0 ? v[v.length - 1] : null;
}

const usage = () => {
  console.error("usage:");
  console.error("  node scripts/evolution-declare-production.mjs --out <path> \\");
  console.error("      --store-root <dir> --checkpoint-root <dir> --repo-root <dir> \\");
  console.error("      [--task-class <token>] [--strategy-baseline DIM=value ...] \\");
  console.error("      [--strategy-dimension DIM ...] [--reviewer <identity>] \\");
  console.error("      [--prompt-profile <token>] [--canary-window-ms <int>] \\");
  console.error("      [--declared-by <identity>] [--json]");
  console.error("");
  console.error(`The declaration is read from ${EVOLUTION_DECLARATION_ENV} by the production gate.`);
  console.error("A declaration is OPTIONAL: leaving it unset keeps the env / caller-object inputs.");
  process.exit(2);
};

if (process.argv.includes("--help") || process.argv.includes("-h") || process.argv.length <= 2) usage();

const out = arg("--out");
if (!out) usage();

const baselineRaw = argAll("--strategy-baseline");
const strategyBaselineValues = {};
for (const entry of baselineRaw) {
  const idx = entry.indexOf("=");
  if (idx <= 0) {
    console.error(`EVOLUTION_DECLARATION_INVALID: --strategy-baseline expects DIMENSION=value, got: ${entry}`);
    process.exit(1);
  }
  strategyBaselineValues[entry.slice(0, idx)] = entry.slice(idx + 1);
}

const canaryRaw = arg("--canary-window-ms");
const record = {
  schema: EVOLUTION_DECLARATION_SCHEMA,
  declared_by: arg("--declared-by") ?? "operator:evolution-declare-production",
  declared_at: new Date().toISOString(),
  ...(arg("--store-root") ? { storeRoot: arg("--store-root") } : {}),
  ...(arg("--checkpoint-root") ? { checkpointRoot: arg("--checkpoint-root") } : {}),
  ...(arg("--repo-root") ? { repoRoot: arg("--repo-root") } : {}),
  ...(arg("--task-class") ? { taskClass: arg("--task-class") } : {}),
  ...(Object.keys(strategyBaselineValues).length > 0 ? { strategyBaselineValues } : {}),
  ...(argAll("--strategy-dimension").length > 0 ? { strategyDimensions: argAll("--strategy-dimension") } : {}),
  ...(arg("--reviewer") ? { reviewerIdentity: arg("--reviewer") } : {}),
  ...(arg("--prompt-profile") ? { promptProfile: arg("--prompt-profile") } : {}),
  ...(canaryRaw ? { canaryWindowMs: Number(canaryRaw) } : {}),
};

const errors = validateEvolutionDeclaration(record);
if (errors.length > 0) {
  console.error(`EVOLUTION_DECLARATION_INVALID: ${errors.join(",")}`);
  process.exit(1);
}
for (const k of ["storeRoot", "checkpointRoot", "repoRoot"]) {
  if (!record[k]) console.error(`warning: ${k} is not declared — the consumer stays INERT until it is (or the env provides it)`);
}

const target = resolve(out);
if (existsSync(target)) {
  const existing = JSON.parse(readFileSync(target, "utf8"));
  const identical = JSON.stringify({ ...existing, declared_at: undefined }) === JSON.stringify({ ...record, declared_at: undefined });
  if (!identical) {
    console.error(`EVOLUTION_DECLARATION_CONFLICT: a different declaration already exists at ${target}`);
    process.exit(1);
  }
  console.log(`status: UNCHANGED_IDENTICAL`);
} else {
  writeFileSync(target, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(`status: DECLARED`);
}

if (process.argv.includes("--json")) console.log(JSON.stringify(record, null, 2));
else {
  console.log(`declaration: ${target}`);
  console.log(`task_class: ${record.taskClass ?? "(unset)"}`);
  console.log(`strategy_baseline_values: ${record.strategyBaselineValues ? JSON.stringify(record.strategyBaselineValues) : "(none)"}`);
  console.log(`read by: ${EVOLUTION_DECLARATION_ENV}=${target}`);
}
process.exit(0);
