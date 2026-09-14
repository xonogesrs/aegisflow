// scripts/card5c-freeze-manifest.mjs
// V2 Card 5C Stage 2 — new freeze manifest（Card 5B repair 後；不覆寫舊 manifest）。
// 第一次 live request 前執行。之後所有被 hash 之內容完全凍結。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildSystemPrompt, buildUserPrompt, PROMPT_BUILDER_VERSION } from "../src/orchestration/validators/prompt-builder.mjs";
import { TRANSPORT_FREEZE } from "../src/v2/pi-transport-adapter.mjs";
import { probeSource, PROBE_ORDER } from "./shared/probe-sources.mjs";
import { scanOracleLeak } from "./card5-static-scans.mjs";
import { scanProvenance, scanRetiredOracle, scanFailureTaxonomy } from "./card5b-provenance-scan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_DIR = "/Users/zhengfengqing/aura-plans/autoloop-analysis";
import { EVIDENCE_ROOT } from "./shared/evidence-root.mjs";
export { EVIDENCE_ROOT };

const sha = (s) => createHash("sha256").update(s).digest("hex");
const fsha = (p) => sha(readFileSync(p, "utf8"));

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runSuite(name, args) {
  try {
    const out = execFileSync("node", ["--test", ...args], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
    const m = out.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
    return { name, ok: true, tests: m?.[1], pass: m?.[2], fail: m?.[3] };
  } catch (e) {
    return { name, ok: false, error: String(e.stderr || e.message).slice(0, 300) };
  }
}

export function buildCard5CFreezeManifest() {
  const systemPrompt = buildSystemPrompt();
  const userPrompts = {};
  for (const caseId of PROBE_ORDER) userPrompts[`user_prompt_${caseId}`] = sha(buildUserPrompt(probeSource(caseId)));

  const dirtyLedger = {
    PRE_EXISTING_3_6D: ["src/adapter/direct-structured-transport.mjs", "src/decompose-ir.mjs", "src/prompts/decompose-ir-system.txt",
      "test/pi-decomposition-real-eval.mjs", "test/pi-decomposition-thinking-level-probe.mjs", "test/pi-final-text-transport-probe.mjs",
      "test/pi-ir-eval.mjs", "test/pi-rpc-stream-amplification-diagnostic.mjs", "test/pi-text-print-adapter.mjs",
      "test/pi-v4pro-viability-probe.mjs", "test/test-decompose-ir.mjs", "test/test-direct-structured-transport.mjs",
      "test/test-pi-decomposition-real-eval.mjs"],
    V2_CARD_4_IMPLEMENTATION: ["package.json", "src/decompose-task.mjs", "package-lock.json",
      "src/v2/ir-schema.mjs", "src/v2/pi-transport-adapter.mjs", "src/orchestration/validators/semantic-consistency.mjs", "src/orchestration/validators/structural-validator.mjs",
      "test/v2/helpers/scripted-fetch.mjs", "test/v2/test-ir-schema.mjs", "test/v2/test-pi-transport-adapter.mjs", "test/v2/test-structural-validator.mjs"],
    V2_CARD_5_IMPLEMENTATION: ["src/orchestration/validators/prompt-builder.mjs", "src/v2/runner.mjs", "src/v2/pipeline.mjs",
      "test/v2/test-runner.mjs", "test/v2/test-prompt-builder.mjs", "test/v2/test-pipeline.mjs",
      "scripts/card5-freeze-manifest.mjs", "scripts/card5-live-probe.mjs", "scripts/card5-preflight.mjs",
      "scripts/card5-static-scans.mjs", "scripts/shared/probe-sources.mjs"],
    V2_CARD_5B_REPAIR: ["src/v2/case-contracts.mjs", "src/v2/case-evaluator.mjs", "src/orchestration/validators/scorecard-v2.mjs",
      "test/v2/test-case-evaluator.mjs", "test/v2/test-card5b-contract-repair.mjs",
      "scripts/card5b-provenance-scan.mjs", "scripts/card5b-regression.mjs",
      "/Users/zhengfengqing/aura-plans/autoloop-analysis/v2-card-3-eval-contract-v2-errata-rc1.md",
      "/Users/zhengfengqing/aura-plans/autoloop-analysis/v2-card-3-decision-ledger-errata-rc1.md"],
    V2_CARD_5C_NEW: ["scripts/card5c-freeze-manifest.mjs", "scripts/card5c-live-probe.mjs", "scripts/card5c-evidence/"],
    UNKNOWN: [],
  };

  const tests = {
    card5b_focused: runSuite("card5b-focused", ["test/v2/test-card5b-contract-repair.mjs"]),
    card5_focused: runSuite("card5-focused", ["test/v2/test-runner.mjs", "test/v2/test-pipeline.mjs", "test/v2/test-prompt-builder.mjs"]),
    v2_all: runSuite("v2-all", ["test/v2/*.mjs"]),
    v1_all: runSuite("v1-all", ["test/test-*.mjs"]),
  };
  const scans = {
    provenance: scanProvenance().pass,
    oracle_leak: scanOracleLeak().pass,
    retired_mechanism: scanRetiredOracle().pass,
    failure_taxonomy: scanFailureTaxonomy().pass,
  };

  const sourceTasks = {};
  for (const f of ["task-decomposition-eval-cases.json", "task-decomposition-requirements.md", "task-decomposition-roadmap.md", "task-decomposition-scorecard.md"]) {
    sourceTasks[f] = fsha(`${ROOT}/autoloop-analysis/${f}`);
  }

  return {
    manifest_version: "V2_CARD_5C_FREEZE_MANIFEST_1",
    generated_at: new Date().toISOString(),
    prompt_builder_version: PROMPT_BUILDER_VERSION,
    baseline: {
      branch: git(ROOT, ["branch", "--show-current"]),
      head: git(ROOT, ["rev-parse", "HEAD"]),
      tree: git(ROOT, ["rev-parse", "HEAD^{tree}"]),
      staged: git(ROOT, ["diff", "--cached", "--name-only"]).length === 0 ? 0 : git(ROOT, ["diff", "--cached", "--name-only"]),
      dirty_ownership: dirtyLedger,
    },
    hashes: {
      system_prompt: sha(systemPrompt),
      prompt_builder: fsha(`${ROOT}/src/orchestration/validators/prompt-builder.mjs`),
      ir_schema: fsha(`${ROOT}/src/v2/ir-schema.mjs`),
      semantic_contract: fsha(`${CONTRACTS_DIR}/v2-card-3-semantic-contract.md`),
      scorecard: fsha(`${CONTRACTS_DIR}/v2-card-3-scorecard-v2.md`),
      eval_contract: fsha(`${CONTRACTS_DIR}/v2-card-3-eval-contract-v2.md`),
      case_contracts: fsha(`${ROOT}/src/v2/case-contracts.mjs`),
      case_evaluator: fsha(`${ROOT}/src/v2/case-evaluator.mjs`),
      structural_validator: fsha(`${ROOT}/src/orchestration/validators/structural-validator.mjs`),
      semantic_validator: fsha(`${ROOT}/src/orchestration/validators/semantic-consistency.mjs`),
      pipeline: fsha(`${ROOT}/src/v2/pipeline.mjs`),
      runner: fsha(`${ROOT}/src/v2/runner.mjs`),
      transport_adapter: fsha(`${ROOT}/src/v2/pi-transport-adapter.mjs`),
      package_json: fsha(`${ROOT}/package.json`),
      package_lock: fsha(`${ROOT}/package-lock.json`),
      eval_contract_errata: fsha(`${CONTRACTS_DIR}/v2-card-3-eval-contract-v2-errata-rc1.md`),
      decision_ledger_errata: fsha(`${CONTRACTS_DIR}/v2-card-3-decision-ledger-errata-rc1.md`),
      ...userPrompts,
    },
    source_task_hashes: sourceTasks,
    model_configuration: TRANSPORT_FREEZE,
    test_counts: Object.fromEntries(Object.entries(tests).map(([k, v]) => [k, { tests: v.tests, pass: v.pass, fail: v.fail, ok: v.ok }])),
    scans,
    frozen_before_first_request: true,
  };
}

// CLI：寫入 evidence dir 並印出路徑
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = buildCard5CFreezeManifest();
  const dir = `${EVIDENCE_ROOT}/card-5c-freeze-manifest-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/freeze-manifest.json`;
  writeFileSync(out, JSON.stringify(manifest, null, 2));
  process.stdout.write(`FREEZE_MANIFEST_WRITTEN ${out}\n`);
}
