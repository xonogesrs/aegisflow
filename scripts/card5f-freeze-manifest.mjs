// scripts/card5f-freeze-manifest.mjs
// V2 Card 5F Stage 4 — new freeze manifest（prompt-builder-2；不與 Card 5C 混用）。
//
// 固定所有會影響 prompt、schema validation、transport、runner 與 case payload 之輸入，
// 並於任何 live call 前完成 freeze 自我驗證（Card 5F §5 12 項）。
// 首次 live request 前執行；之後所有被 hash 之內容完全凍結。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildSystemPrompt, buildUserPrompt, PROMPT_BUILDER_VERSION } from "../src/v2/prompt-builder.mjs";
import { PROJECTION_BEGIN, PROJECTION_END, verifyPromptSchemaParity } from "../src/v2/schema-projection.mjs";
import { TRANSPORT_FREEZE } from "../src/v2/pi-transport-adapter.mjs";
import { CONTRACTS_BY_ID } from "../src/v2/case-contracts.mjs";
import { probeSource, PROBE_ORDER } from "./shared/probe-sources.mjs";
import { scanOracleLeak, scanRetiredMechanisms, verifyDependencyLock } from "./card5-static-scans.mjs";
import { scanProvenance, scanRetiredOracle, scanFailureTaxonomy } from "./card5b-provenance-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_DIR = "/Users/zhengfengqing/aura-plans/autoloop-analysis";
import { EVIDENCE_ROOT } from "./shared/evidence-root.mjs";
export { EVIDENCE_ROOT };
const PROVIDER_DOCS_DIR = "/tmp/card5f-provider-docs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const fsha = (p) => sha(readFileSync(p, "utf8"));

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runSuite(name, args) {
  try {
    const out = execFileSync("node", ["--test", ...args], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
    const m = out.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
    return { name, ok: m && m[2] === m[1], tests: m?.[1], pass: m?.[2], fail: m?.[3] };
  } catch (e) {
    return { name, ok: false, error: String(e.stderr || e.message).slice(0, 300) };
  }
}

// 現行 dirty classification（Card 5C ledger + Card 5E implementation additions）
const DIRTY_LEDGER = {
  PRE_EXISTING_3_6D: ["src/adapter/direct-structured-transport.mjs", "src/decompose-ir.mjs", "src/prompts/decompose-ir-system.txt",
    "test/pi-decomposition-real-eval.mjs", "test/pi-decomposition-thinking-level-probe.mjs", "test/pi-final-text-transport-probe.mjs",
    "test/pi-ir-eval.mjs", "test/pi-rpc-stream-amplification-diagnostic.mjs", "test/pi-text-print-adapter.mjs",
    "test/pi-v4pro-viability-probe.mjs", "test/test-decompose-ir.mjs", "test/test-direct-structured-transport.mjs",
    "test/test-pi-decomposition-real-eval.mjs"],
  V2_CARD_4_IMPLEMENTATION: ["src/decompose-task.mjs",
    "src/v2/pi-transport-adapter.mjs", "src/v2/semantic-consistency.mjs", "src/v2/structural-validator.mjs",
    "test/v2/helpers/scripted-fetch.mjs", "test/v2/test-ir-schema.mjs", "test/v2/test-pi-transport-adapter.mjs", "test/v2/test-structural-validator.mjs"],
  V2_CARD_5_IMPLEMENTATION: ["src/v2/runner.mjs", "src/v2/pipeline.mjs",
    "test/v2/test-runner.mjs", "test/v2/test-prompt-builder.mjs", "test/v2/test-pipeline.mjs",
    "scripts/card5-freeze-manifest.mjs", "scripts/card5-live-probe.mjs", "scripts/card5-preflight.mjs",
    "scripts/card5-static-scans.mjs", "scripts/shared/probe-sources.mjs"],
  V2_CARD_5B_REPAIR: ["src/v2/case-contracts.mjs", "src/v2/case-evaluator.mjs", "src/v2/scorecard-v2.mjs",
    "test/v2/test-case-evaluator.mjs", "test/v2/test-card5b-contract-repair.mjs",
    "scripts/card5b-provenance-scan.mjs", "scripts/card5b-regression.mjs",
    "/Users/zhengfengqing/aura-plans/autoloop-analysis/v2-card-3-eval-contract-v2-errata-rc1.md",
    "/Users/zhengfengqing/aura-plans/autoloop-analysis/v2-card-3-decision-ledger-errata-rc1.md"],
  V2_CARD_5C_NEW: ["scripts/card5c-freeze-manifest.mjs", "scripts/card5c-live-probe.mjs"],
  V2_CARD_5E_IMPLEMENTATION: ["package.json", "package-lock.json",
    "src/v2/ir-schema.mjs", "src/v2/prompt-builder.mjs", "src/v2/schema-projection.mjs",
    "scripts/card5e-parity-gate.mjs", "test/v2/test-card5e-parity.mjs"],
  V2_CARD_5F_NEW: ["scripts/card5f-freeze-manifest.mjs", "scripts/card5f-live-probe.mjs"],
  UNKNOWN: [],
};

// 驗證 dirty classification 完整（UNKNOWN=0）
function verifyDirtyLedger() {
  // raw output（不 trim）：porcelain v1 每行 = "XY path"；slice(3) 取 path
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: ROOT, encoding: "utf8" });
  const cur = raw.split("\n").filter(Boolean).map((l) => l.slice(3));
  const ledgerPaths = new Set();
  for (const paths of Object.values(DIRTY_LEDGER)) {
    if (Array.isArray(paths)) for (const p of paths) if (!p.startsWith("/Users/")) ledgerPaths.add(p);
  }
  const unknown = cur.filter((p) => !ledgerPaths.has(p));
  const missing = [...ledgerPaths].filter((p) => !cur.includes(p));
  return { current: cur.length, unknown, missing, pass: unknown.length === 0 && missing.length === 0 };
}

export function buildCard5FFreezeManifest(freezeId) {
  const systemPrompt = buildSystemPrompt();
  const userPrompts = {};
  const caseContracts = {};
  for (const caseId of PROBE_ORDER) {
    userPrompts[`user_prompt_${caseId}`] = sha(buildUserPrompt(probeSource(caseId)));
    caseContracts[`case_contract_${caseId}`] = sha(JSON.stringify(CONTRACTS_BY_ID[caseId]));
  }

  // §5 items 1-3: projection parse + deep parity
  let projectionParseable = false;
  let parityOk = false;
  let parityProblems = [];
  const b = systemPrompt.indexOf(PROJECTION_BEGIN);
  const e = systemPrompt.indexOf(PROJECTION_END);
  if (b >= 0 && e > b) {
    try {
      const parsed = JSON.parse(systemPrompt.slice(b + PROJECTION_BEGIN.length, e).trim());
      projectionParseable = true;
      const r = verifyPromptSchemaParity(parsed);
      parityOk = r.pass;
      parityProblems = r.problems;
    } catch {
      projectionParseable = false;
    }
  }

  const tests = {
    card5e_focused: runSuite("card5e-focused", ["test/v2/test-card5e-parity.mjs"]),
    v2_all: runSuite("v2-all", ["test/v2/*.mjs"]),
    v1_all: runSuite("v1-all", ["test/test-*.mjs"]),
  };
  const scans = {
    oracle_leak: scanOracleLeak().pass,
    retired_mechanism: scanRetiredMechanisms().pass,
    retired_oracle: scanRetiredOracle().pass,
    dependency_lock: verifyDependencyLock().pass,
    provenance: scanProvenance().pass,
    failure_taxonomy: scanFailureTaxonomy().pass,
  };

  const dirty = verifyDirtyLedger();
  const providerContext = {
    model: TRANSPORT_FREEZE.model,
    context_length: 1_000_000,
    max_output_maximum: 384_000,
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    snapshot_hashes: {
      pricing: existsSync(`${PROVIDER_DOCS_DIR}/pricing.html`) ? fsha(`${PROVIDER_DOCS_DIR}/pricing.html`) : null,
      api_chat: existsSync(`${PROVIDER_DOCS_DIR}/api-chat.html`) ? fsha(`${PROVIDER_DOCS_DIR}/api-chat.html`) : null,
    },
    fetched_at: "2026-08-03T10:50:00Z",
    semantics: "max_tokens: input+generated limited by model context length; usage.total_tokens = prompt_tokens + completion_tokens; completion_tokens_details.reasoning_tokens is a breakdown of completion; finish_reason=length => truncation/context-exceeded.",
  };

  return {
    manifest_version: "V2_CARD_5F_FREEZE_MANIFEST_1",
    freeze_id: freezeId,
    generated_at: new Date().toISOString(),
    prompt_builder_version: PROMPT_BUILDER_VERSION,
    baseline: {
      branch: git(ROOT, ["branch", "--show-current"]),
      head: git(ROOT, ["rev-parse", "HEAD"]),
      tree: git(ROOT, ["rev-parse", "HEAD^{tree}"]),
      staged: git(ROOT, ["diff", "--cached", "--name-only"]).length === 0 ? 0 : git(ROOT, ["diff", "--cached", "--name-only"]),
      dirty_ownership: DIRTY_LEDGER,
      dirty_classification: { current: dirty.current, unknown: dirty.unknown, missing: dirty.missing, pass: dirty.pass },
    },
    hashes: {
      // prompt & schema
      prompt_builder: fsha(`${ROOT}/src/v2/prompt-builder.mjs`),
      ir_schema: fsha(`${ROOT}/src/v2/ir-schema.mjs`),
      schema_projection: fsha(`${ROOT}/src/v2/schema-projection.mjs`),
      system_prompt: sha(systemPrompt),
      // validation
      schema_validator: fsha(`${ROOT}/src/v2/ir-schema.mjs`),
      structural_validator: fsha(`${ROOT}/src/v2/structural-validator.mjs`),
      semantic_validator: fsha(`${ROOT}/src/v2/semantic-consistency.mjs`),
      case_evaluator: fsha(`${ROOT}/src/v2/case-evaluator.mjs`),
      scorecard_contract: fsha(`${CONTRACTS_DIR}/v2-card-3-scorecard-v2.md`),
      scorecard_impl: fsha(`${ROOT}/src/v2/scorecard-v2.mjs`),
      oracle_leak_scanner: fsha(`${ROOT}/scripts/card5-static-scans.mjs`),
      retired_scanner: fsha(`${ROOT}/scripts/card5b-provenance-scan.mjs`),
      parity_gate: fsha(`${ROOT}/scripts/card5e-parity-gate.mjs`),
      // execution
      transport_adapter: fsha(`${ROOT}/src/v2/pi-transport-adapter.mjs`),
      runner: fsha(`${ROOT}/src/v2/runner.mjs`),
      pipeline: fsha(`${ROOT}/src/v2/pipeline.mjs`),
      package_json: fsha(`${ROOT}/package.json`),
      package_lock: fsha(`${ROOT}/package-lock.json`),
      // cases
      case_contracts: fsha(`${ROOT}/src/v2/case-contracts.mjs`),
      probe_sources: fsha(`${ROOT}/scripts/shared/probe-sources.mjs`),
      ...userPrompts,
      ...caseContracts,
    },
    runtime: {
      node: process.version,
      pi_ai_package: TRANSPORT_FREEZE.package,
      pi_ai_version: TRANSPORT_FREEZE.version,
    },
    provider_context: providerContext,
    model_configuration: TRANSPORT_FREEZE,
    preflight: {
      projection_parseable: projectionParseable,
      parity_gate: parityOk,
      parity_problems: parityProblems,
      tests,
      scans,
      dirty_classification: dirty.pass,
      frozen_before_first_request: true,
    },
  };
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const freezeId = `v2-card5f-${ts}-prompt-builder-2`;
  const manifest = buildCard5FFreezeManifest(freezeId);
  const dir = `${EVIDENCE_ROOT}/${freezeId}`;
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/freeze-manifest.json`;
  writeFileSync(out, JSON.stringify(manifest, null, 2));
  process.stdout.write(`FREEZE_MANIFEST_WRITTEN ${out}\nFREEZE_ID ${freezeId}\n`);
  // preflight failures → exit 1（不得 live）
  const pre = manifest.preflight;
  const fail = [];
  if (!pre.projection_parseable) fail.push("projection not parseable");
  if (!pre.parity_gate) fail.push(`parity gate: ${pre.parity_problems.join("; ")}`);
  for (const [k, v] of Object.entries(pre.tests)) if (!v.ok) fail.push(`${k} tests fail: ${JSON.stringify(v)}`);
  for (const [k, v] of Object.entries(pre.scans)) if (!v) fail.push(`scan ${k} fail`);
  if (!pre.dirty_classification) fail.push("dirty classification incomplete (UNKNOWN>0)");
  if (fail.length) {
    process.stderr.write(`HOLD / CARD_5F_FREEZE_PRECONDITION_FAILED: ${fail.join("; ")}\n`);
    process.exitCode = 1;
  }
}
