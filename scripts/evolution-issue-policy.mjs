#!/usr/bin/env node
// scripts/evolution-issue-policy.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1 — Section B: THE
// operator step that issues the first production evolution policy.
//
//   node scripts/evolution-issue-policy.mjs --store <dir> [--scope "src/**"] \
//     [--strategy-dimensions "MODEL_ROUTING,RETRY_REPAIR"] \
//     [--expires "2026-10-24T00:00:00.000Z"] [--json]
//
// Default production policy (card §B):
//   LOW    = AUTONOMOUS   (bounded single-concern, no authority surface)
//   MEDIUM = HUMAN/CONTROLLER REQUIRED (autonomous evaluation; operator promotion)
//   HIGH   = DENY (structural — the policy artifact cannot allow it)
//
// LOW scope is BOUNDED: default scope is a narrow set of runtime-leaf
// patterns; authority surfaces (src/governance, src/admission, src/evolution,
// src/schema, docs/governance, .git) are FORBIDDEN structurally inside
// createEvolutionPolicy and can never be widened by input. No unrestricted
// wildcard mutation scope is accepted (a bare "**" / "*" is refused).
//
// The policy is a durable, digest-bound, exclusive-create artifact — the
// ONE lawful operator/Controller step for autonomous LOW-risk evolution.
// Re-issuing an identical policy is idempotent; a conflicting record fails
// closed (EVOLUTION_POLICY_CONFLICT).

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createEvolutionPolicy, readEvolutionPolicy } from "../src/evolution/policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

const usage = () => {
  console.error("usage:");
  console.error("  node scripts/evolution-issue-policy.mjs --store <dir> [--scope <glob>] [--scope <glob> ...]");
  console.error("      [--strategy-dimensions <DIM[,DIM...]>] [--expires <iso>] [--json]");
  console.error("  --strategy-dimensions is OPT-IN: omitted = the policy preauthorizes NO agent-strategy dimension.");
  process.exit(2);
};

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
const store = arg("--store");
if (!store) usage();
const asJson = process.argv.includes("--json");

// Bounded LOW scope. Default: runtime leaf surfaces a bounded constant/bug
// repair can safely touch. Callers may narrow or extend with --scope, but
// the structural forbidden list (authority surfaces) is enforced inside
// createEvolutionPolicy regardless of input.
const DEFAULT_SCOPE = [
  "src/telemetry/**",
  "src/memory/retrieval/**",
  "src/runtime/**",
  "src/sop/**",
];
const scopes = [];
for (let i = 0; i < process.argv.length - 1; i++) {
  if (process.argv[i] === "--scope") scopes.push(process.argv[i + 1]);
}
const scope_patterns = scopes.length ? scopes : DEFAULT_SCOPE;
// No unrestricted wildcard mutation scope (card §B).
for (const s of scope_patterns) {
  if (s === "**" || s === "*" || s === "src/**" || s === "src/*") {
    console.error(`EVOLUTION_POLICY_INVALID: unrestricted mutation scope refused: ${s}`);
    process.exit(1);
  }
}

// AGENT-STRATEGY authority is OPT-IN (AUTOLOOP_AGENT_STRATEGY_EVOLUTION_
// COMPLETION_1 §C/J): omitting --strategy-dimensions issues a policy that
// preauthorizes NO strategy dimension, so agent-strategy adaptation cannot be
// enabled by implication. Only LOW-risk dimensions are accepted here — the
// MEDIUM floor (PROMPT_EVOLUTION) is deliberately NOT issuable through this
// bounded production lane.
const ALLOWED_STRATEGY_DIMENSIONS = [
  "MODEL_ROUTING", "DECOMPOSITION", "CONTEXT_ALLOCATION",
  "RETRY_REPAIR", "FANOUT_PARALLELISM", "TOOL_SELECTION",
];
const strategyDimsArg = arg("--strategy-dimensions");
let strategy_dimensions_allowed;
if (strategyDimsArg) {
  strategy_dimensions_allowed = strategyDimsArg.split(",").map((d) => d.trim()).filter(Boolean);
  for (const d of strategy_dimensions_allowed) {
    if (!ALLOWED_STRATEGY_DIMENSIONS.includes(d)) {
      console.error(`EVOLUTION_POLICY_INVALID: strategy dimension not issuable through this lane: ${d}`);
      console.error(`allowed: ${ALLOWED_STRATEGY_DIMENSIONS.join(",")}`);
      process.exit(1);
    }
  }
}

const expires = arg("--expires") ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const input = {
  policy_name: "autoloop-production-evolution-v1",
  // LOW = AUTONOMOUS. MEDIUM is intentionally NOT in the allowed list: the
  // production policy's autonomous lane is LOW-only (a MEDIUM candidate is
  // derived/evaluated only when an operator widens the policy explicitly —
  // its promotion is the operator boundary either way).
  risk_classes_allowed: ["LOW"],
  scope_patterns,
  forbidden_patterns: [
    // HIGH boundary, spelled out (card §B) — structural in policy.mjs AND
    // explicit here for auditability:
    "src/governance/**",      // governance authority
    "src/admission/**",       // admission authority
    "src/evolution/**",       // the evolution policy/loop itself
    "src/schema/**",          // schema/migration-like surfaces
    "src/c2d/**",             // mutation authority machinery
    "src/budget/**",          // budget authority
    "docs/governance/**",     // governance records
    ".git/**",                // repository internals
    "src/memory/writeback/**",// writeback trust surface
    "src/learning/lifecycle/**", // learning authority
  ],
  allowed_commands: ["node", "git"],
  validation_plan_id: "autoloop-evolution-validation-v1",
  validation_plan: {
    commands: [
      { cmd: "node", args: ["--check", "src/autoloop.mjs"], timeout_ms: 60000 },
    ],
  },
  ...(strategy_dimensions_allowed ? { strategy_dimensions_allowed } : {}),
  budget: {
    max_mutation_runs: 4,
    max_wall_clock_ms_per_run: 300000,
    max_evolutions_per_window: 2,
    window_ms: 24 * 60 * 60 * 1000,
  },
  issued_by: "operator:autoloop-production-activation-1",
  authorization_ref: "autoloop://governance/AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1",
  expires_at: expires,
};

try {
  const r = createEvolutionPolicy(resolve(store), input);
  const policy = readEvolutionPolicy(resolve(store));
  const summary = {
    status: r.status,
    policy_id: policy.policy_id,
    policy_digest: policy.policy_digest,
    policy_name: policy.policy_name,
    risk_classes_allowed: policy.risk_classes_allowed,
    strategy_dimensions_allowed: policy.strategy_dimensions_allowed,
    scope_patterns: policy.scope_patterns,
    forbidden_patterns: policy.forbidden_patterns,
    budget: policy.budget,
    expires_at: policy.expires_at,
  };
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`status: ${r.status}`);
    console.log(`policy_id: ${summary.policy_id}`);
    console.log(`risk_classes_allowed: ${summary.risk_classes_allowed.join(",")}`);
    console.log(`strategy_dimensions_allowed: ${policy.strategy_dimensions_allowed ? policy.strategy_dimensions_allowed.join(",") : "(none — no agent-strategy authority)"}`);
    console.log(`scope: ${summary.scope_patterns.join(", ")}`);
    console.log(`expires: ${summary.expires_at}`);
  }
  process.exit(0);
} catch (e) {
  console.error(`EVOLUTION_POLICY_ISSUE_FAILED: ${e?.message ?? e}`);
  process.exit(1);
}
