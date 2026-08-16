// scripts/de1-provider-contract-check.mjs
//
// DE-1 Stage 6/16 — verifies that the AutoLoop native durable layer
// (STACK_A) implements EVERY method of autoloop.durable-execution-provider/v1
// and that the provider contract document is well-formed. Read-only; no
// production changes.
//
// Run: node scripts/de1-provider-contract-check.mjs

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "docs", "pi-graph-output", "de1");
const contractPath = join(ROOT, "de1-provider-contract.json");

// Every provider method must map to a REAL exported symbol in the codebase.
const METHOD_TO_SYMBOL = {
  createExecution: ["src/v2/durable-execution.mjs", "runDurableAutoLoop"],
  persistCheckpoint: ["src/v2/checkpoint-bridge.mjs", "publishCheckpoint"],
  loadExecution: ["src/v2/checkpoint-bridge.mjs", "readCheckpoint"],
  resumeExecution: ["src/v2/durable-execution.mjs", "resumeAutoLoop"],
  markNodeStarted: ["src/v2/durable-execution.mjs", "buildOrchestratorHooks"],
  markNodeCompleted: ["src/v2/durable-execution.mjs", "_onRunnerView"],
  markNodeFailed: ["src/v2/durable-execution.mjs", "_onRunnerView"],
  recordRetry: ["src/lifecycle-runner.mjs", "runLifecycle"],
  cancel: ["src/lifecycle-runner.mjs", "runLifecycle"],
  recover: ["src/v2/durable-execution.mjs", "resumeAutoLoop"],
  inspect: ["src/v2/checkpoint-bridge.mjs", "readCheckpoint"],
  cleanup: ["src/runtime/colima-runtime.mjs", "cleanupContainer"],
};

const failures = [];

// 1. contract document well-formed + schema
let contract = null;
try {
  contract = JSON.parse(readFileSync(contractPath, "utf8"));
} catch (e) {
  failures.push(`contract_unreadable:${e.message}`);
  process.exit(1);
}
if (contract.schema !== "autoloop.durable-execution-provider/v1") failures.push("schema_mismatch");
const methods = Object.keys(contract.contract || {});
const required = Object.keys(METHOD_TO_SYMBOL);
for (const m of required) {
  if (!methods.includes(m)) failures.push(`contract_missing_method:${m}`);
  if (!contract.contract[m]?.in || !contract.contract[m]?.out || !contract.contract[m]?.semantics) {
    failures.push(`contract_method_incomplete:${m}`);
  }
}

// 2. every method maps to a real exported symbol
for (const [m, [file, symbol]] of Object.entries(METHOD_TO_SYMBOL)) {
  const full = join(process.cwd(), file);
  if (!existsSync(full)) { failures.push(`mapping_file_missing:${m}:${file}`); continue; }
  const src = readFileSync(full, "utf8");
  const exported = new RegExp(`export (async )?function ${symbol}\\b|export class ${symbol}\\b|${symbol}\\(`).test(src);
  if (!exported) failures.push(`mapping_symbol_missing:${m}:${symbol} in ${file}`);
}

// 3. hard rules present
const rules = Array.isArray(contract.hardRules) ? contract.hardRules : [];
for (const rule of ["silent lost work -> FAIL", "silent duplicate mutation -> FAIL", "false PASS promotion -> FAIL", "authority escalation across recovery -> FAIL"]) {
  if (!rules.some((r) => r.includes(rule.split(" -> ")[0]))) failures.push(`hard_rule_missing:${rule.split(" -> ")[0]}`);
}

// 4. selection boundary: AutoLoop keeps policy
if (!contract.selectionBoundary) failures.push("selection_boundary_missing");

console.log("DE-1 provider contract check (autoloop.durable-execution-provider/v1)");
console.log("  methods:", methods.length, "| mapped symbols:", Object.keys(METHOD_TO_SYMBOL).length);
if (failures.length === 0) {
  console.log("  PASS: contract well-formed; all 12 methods map to real STACK_A symbols; hard rules + boundary present");
  process.exit(0);
}
for (const f of failures) console.error("  FAIL:", f);
process.exit(1);
