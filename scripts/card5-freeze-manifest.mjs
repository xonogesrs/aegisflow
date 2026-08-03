// scripts/card5-freeze-manifest.mjs
// V2 Card 5 Stage 4 step 7 — Freeze manifest generation。
// 在第一次 live request 前執行；保存 system prompt / user prompt builder / schema /
// Semantic Contract / Scorecard / Eval Contract / case-contracts / transport adapter /
// model configuration / package-lock 之 SHA-256。

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt, buildUserPrompt, PROMPT_BUILDER_VERSION } from "../src/v2/prompt-builder.mjs";
import { TRANSPORT_FREEZE } from "../src/v2/pi-transport-adapter.mjs";
import { probeSource, PROBE_ORDER } from "./shared/probe-sources.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_DIR = "/Users/zhengfengqing/aura-plans/autoloop-analysis";
export const EVIDENCE_ROOT = "/Volumes/NVM2T/Development/AutoLoopEvidence";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
function fileHash(p) {
  return sha256(readFileSync(p, "utf8"));
}

export function buildFreezeManifest() {
  const systemPrompt = buildSystemPrompt();
  const userPromptHashes = {};
  for (const caseId of PROBE_ORDER) {
    userPromptHashes[`user_prompt_${caseId}`] = sha256(buildUserPrompt(probeSource(caseId)));
  }
  return {
    manifest_version: "V2_CARD_5_FREEZE_MANIFEST_1",
    generated_at: new Date().toISOString(),
    prompt_builder_version: PROMPT_BUILDER_VERSION,
    hashes: {
      system_prompt: sha256(systemPrompt),
      user_prompt_builder_file: fileHash(`${ROOT}/src/v2/prompt-builder.mjs`),
      ...userPromptHashes,
      ir_schema: fileHash(`${ROOT}/src/v2/ir-schema.mjs`),
      semantic_contract: fileHash(`${CONTRACTS_DIR}/v2-card-3-semantic-contract.md`),
      scorecard: fileHash(`${CONTRACTS_DIR}/v2-card-3-scorecard-v2.md`),
      eval_contract: fileHash(`${CONTRACTS_DIR}/v2-card-3-eval-contract-v2.md`),
      case_contracts_E1_E12: fileHash(`${ROOT}/src/v2/case-contracts.mjs`),
      transport_adapter: fileHash(`${ROOT}/src/v2/pi-transport-adapter.mjs`),
      package_lock: fileHash(`${ROOT}/package-lock.json`),
      package_json: fileHash(`${ROOT}/package.json`),
    },
    model_configuration: TRANSPORT_FREEZE,
  };
}

// CLI：寫入 evidence dir 並印出
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = buildFreezeManifest();
  const dir = `${EVIDENCE_ROOT}/card-5-freeze-manifest-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/freeze-manifest.json`;
  writeFileSync(out, JSON.stringify(manifest, null, 2));
  process.stdout.write(`FREEZE_MANIFEST_WRITTEN ${out}\n`);
}
