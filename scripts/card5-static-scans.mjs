// scripts/card5-static-scans.mjs
// V2 Card 5 Stage 4 steps 4–6 — 靜態 no-oracle-leak scan、no-retired-mechanism scan、
// dependency/lock verification。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt, buildUserPrompt } from "../src/orchestration/validators/prompt-builder.mjs";
import { CASE_CONTRACTS } from "../src/v2/case-contracts.mjs";
import { probeSource, PROBE_ORDER } from "./shared/probe-sources.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONTRACT_VOCAB = new Set([
  "verification", "implementation", "analysis", "review", "operation",
  "forbidden", "allowed", "required", "persistent", "ephemeral", "none",
  "complete", "partial", "deferred", "unresolved", "blocked", "out_of_scope", "not_beneficial",
  "DECOMPOSED", "DECOMPOSITION_NOT_BENEFICIAL", "DECOMPOSITION_BLOCKED",
  "CYCLIC_DEPENDENCY", "AMBIGUOUS_SCOPE", "MISSING_AUTHORITY", "OTHER",
  "EXTERNAL_DEPENDENCY_PENDING", "PRODUCTION_RUNTIME_OUT_OF_SCOPE",
  "COMMIT_NOT_AUTHORIZED", "CROSS_REPO_AUTHORITY_REQUIRED",
  "MULTI_MODEL_ORCHESTRATION_FORBIDDEN", "ALREADY_SATISFIED", "NO_EFFECTIVE_IMPROVEMENT",
]);

function referenceSlugs() {
  const out = new Set();
  for (const c of CASE_CONTRACTS) {
    for (const ex of c.accepted_examples || []) {
      for (const p of ex.phases || []) out.add(p.phase_id);
    }
    for (const inv of c.known_invalid_examples || []) {
      const m = inv.mutation || {};
      if (m.phase_id) out.add(m.phase_id);
      if (m.from) out.add(m.from);
      if (m.to) out.add(m.to);
      if (m.phase?.phase_id) out.add(m.phase.phase_id);
    }
  }
  return [...out].filter((s) => s.length >= 6 && !CONTRACT_VOCAB.has(s));
}

const SLUGS = referenceSlugs();
const KNOWN_INVALID_RE = /E\d+-invalid-\d+/;
const COUNT_HINTS = ["4 張卡", "five-phase", "5-phase", "4-phase", "3-phase", "2-phase", "min_cards", "max_cards", "expected phase count"];
const ROLE_DICT_HINTS = ["role dictionary", "canonical role vocabulary", "foundation", "offline_validation", "generate_migration", "extract_common_logic"];
const GATE_TOKENS = ["expected_verdict", "invariants:", "H1:", "H2:", "H12", "gate result"];

export function scanOracleLeak() {
  const problems = [];
  const system = buildSystemPrompt();

  const check = (label, text) => {
    for (const s of SLUGS) if (text.includes(s)) problems.push(`${label}: reference slug "${s}"`);
    if (KNOWN_INVALID_RE.test(text)) problems.push(`${label}: known-invalid id`);
    for (const h of COUNT_HINTS) if (text.includes(h)) problems.push(`${label}: phase-count hint "${h}"`);
    for (const h of ROLE_DICT_HINTS) if (text.includes(h)) problems.push(`${label}: role-dictionary hint "${h}"`);
    for (const t of GATE_TOKENS) if (text.includes(t)) problems.push(`${label}: evaluator-gate token "${t}"`);
  };

  check("system_prompt", system);
  for (const caseId of PROBE_ORDER) {
    const src = probeSource(caseId);
    const up = buildUserPrompt(src);
    const allowed = JSON.stringify(src).replace(/[^a-z0-9_\u4e00-\u9fff]/gi, " ");
    for (const s of SLUGS) {
      if (up.includes(s) && !allowed.includes(s)) problems.push(`user_prompt_${caseId}: reference slug "${s}"`);
    }
    if (KNOWN_INVALID_RE.test(up)) problems.push(`user_prompt_${caseId}: known-invalid id`);
  }

  return { pass: problems.length === 0, problems };
}

// retired V1 mechanisms（Scorecard v2 §4 banned list / Semantic Contract §17.2）
const RETIRED_TERMS = [
  "CANONICAL_ROLE_WORDS", "KIND_TYPE_MAP", "VERIFICATION_SIGNALS",
  "required_card_types", "roleForPhase", "normalizeDecomposition",
  "contextCanonicalize", "exact graph equality", "fixture exclusivity",
  "repair prompt", "tolerant parse", "substring inference",
];
const SCAN_FILES = [
  "src/orchestration/validators/prompt-builder.mjs",
  "src/v2/runner.mjs",
  "src/v2/pipeline.mjs",
  "src/v2/ir-schema.mjs",
  "src/orchestration/validators/structural-validator.mjs",
  "src/orchestration/validators/semantic-consistency.mjs",
  "src/v2/case-evaluator.mjs",
  "src/orchestration/validators/scorecard-v2.mjs",
];

export function scanRetiredMechanisms() {
  const problems = [];
  for (const rel of SCAN_FILES) {
    const text = readFileSync(`${ROOT}/${rel}`, "utf8");
    for (const term of RETIRED_TERMS) {
      if (text.includes(term)) problems.push(`${rel}: retired mechanism term "${term}"`);
    }
  }
  return { pass: problems.length === 0, problems };
}

export function verifyDependencyLock() {
  const problems = [];
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
  if (pkg.dependencies?.["@earendil-works/pi-ai"] !== "0.83.0") {
    problems.push(`package.json pin: ${pkg.dependencies?.["@earendil-works/pi-ai"]} (want 0.83.0)`);
  }
  const lock = JSON.parse(readFileSync(`${ROOT}/package-lock.json`, "utf8"));
  const entry = lock.packages?.["node_modules/@earendil-works/pi-ai"];
  if (entry?.version !== "0.83.0") problems.push(`lockfile resolved: ${entry?.version} (want 0.83.0)`);
  const installed = JSON.parse(readFileSync(`${ROOT}/node_modules/@earendil-works/pi-ai/package.json`, "utf8"));
  if (installed.version !== "0.83.0") problems.push(`installed pi-ai: ${installed.version} (want 0.83.0)`);
  return { pass: problems.length === 0, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const leak = scanOracleLeak();
  const retired = scanRetiredMechanisms();
  const dep = verifyDependencyLock();
  const allPass = leak.pass && retired.pass && dep.pass;
  process.stdout.write(JSON.stringify({ oracle_leak: leak, retired_mechanism: retired, dependency_lock: dep, all_pass: allPass }, null, 2) + "\n");
  if (!allPass) process.exitCode = 1;
}
