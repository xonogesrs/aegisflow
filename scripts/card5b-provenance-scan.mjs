// scripts/card5b-provenance-scan.mjs
// V2 Card 5B Stage 6 — static source-provenance scan。
// 驗證：所有 hard assertions 具 provenance；E2 無 review gate；無無來源 purpose/phase-count gate；
// source_reference 不含不合格來源；src/v2 無 retired oracle mechanism。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASE_CONTRACTS, PROVENANCE_CLASSIFICATIONS, UNSUPPORTED_PROVENANCE_TERMS } from "../src/v2/case-contracts.mjs";
import { FAILURE_CODES } from "../src/v2/case-evaluator.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function scanProvenance() {
  const problems = [];
  for (const c of CASE_CONTRACTS) {
    for (const inv of c.invariants) {
      const tag = `${c.case_id}:${inv.type}${inv.requirement_id ? ":" + inv.requirement_id : ""}`;
      const pv = inv.provenance;
      if (!pv) { problems.push(`${tag}: missing provenance`); continue; }
      if (!pv.id) problems.push(`${tag}: missing provenance.id`);
      if (!PROVENANCE_CLASSIFICATIONS.includes(pv.classification)) problems.push(`${tag}: bad classification ${pv.classification}`);
      if (!pv.source_reference || !pv.source_reference.trim()) problems.push(`${tag}: missing source_reference`);
      if (!pv.description || !pv.description.trim()) problems.push(`${tag}: missing description`);
      if (!Array.isArray(pv.requirement_ids)) problems.push(`${tag}: requirement_ids not array`);
      for (const term of UNSUPPORTED_PROVENANCE_TERMS) {
        if (pv.source_reference?.includes(term)) problems.push(`${tag}: source_reference cites unsupported "${term}": ${pv.source_reference}`);
      }
    }
    // E2 不得有 review gate
    if (c.case_id === "E2" && JSON.stringify(c.invariants).includes("review")) {
      problems.push("E2: review hard gate still present");
    }
    // 無來源 purpose/phase-count existence gate
    if (c.invariants.some(i => i.type === "required_purpose")) problems.push(`${c.case_id}: required_purpose (no requirement ID) still present`);
    if (c.invariants.some(i => i.type === "phase_count")) problems.push(`${c.case_id}: phase_count shape gate present`);
  }
  return { pass: problems.length === 0, problems };
}

export function scanRetiredOracle() {
  const problems = [];
  const logicFiles = [
    "src/v2/case-evaluator.mjs",
    "src/v2/ir-schema.mjs",
    "src/v2/structural-validator.mjs",
    "src/v2/semantic-consistency.mjs",
    "src/v2/scorecard-v2.mjs",
    "src/v2/prompt-builder.mjs",
    "src/v2/runner.mjs",
    "src/v2/pipeline.mjs",
  ];
  const terms = [
    "CANONICAL_ROLE_WORDS", "KIND_TYPE_MAP", "VERIFICATION_SIGNALS",
    "required_card_types", "roleForPhase", "normalizeDecomposition",
    "contextCanonicalize", "exact graph equality", "fixture exclusivity",
    "repair prompt", "tolerant parse", "substring inference",
  ];
  const stripComments = (t) => t.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rel of logicFiles) {
    const text = stripComments(readFileSync(`${ROOT}/${rel}`, "utf8"));
    for (const t of terms) {
      if (text.includes(t)) problems.push(`${rel}: retired term "${t}"`);
    }
  }
  // case-contracts：排除 denylist 常數定義與「退役」文件化；其餘命中即 active use
  let contractsSrc = readFileSync(`${ROOT}/src/v2/case-contracts.mjs`, "utf8");
  const denylistStart = contractsSrc.indexOf("UNSUPPORTED_PROVENANCE_TERMS");
  if (denylistStart !== -1) {
    const denylistEnd = contractsSrc.indexOf("]);", denylistStart);
    if (denylistEnd !== -1) contractsSrc = contractsSrc.slice(0, denylistStart) + contractsSrc.slice(denylistEnd + 3);
  }
  contractsSrc = stripComments(contractsSrc);
  contractsSrc = contractsSrc.split("\n").filter((l) => !/退役/.test(l)).join("\n");
  for (const t of terms) {
    if (contractsSrc.includes(t)) problems.push(`src/v2/case-contracts.mjs: retired term "${t}"`);
  }
  // exact shape matcher：min/max_cards、required_edges 不得作為 hard gate 邏輯
  if (/min_cards|max_cards|required_edges/.test(contractsSrc)) {
    problems.push("case-contracts: legacy fixture shape fields (min_cards/max_cards/required_edges) referenced");
  }
  return { pass: problems.length === 0, problems };
}

export function scanFailureTaxonomy() {
  const expected = [
    "REQUIRED_RESPONSIBILITY_UNCOVERED", "REQUIRED_PURPOSE_MISSING", "REQUIRED_DISPOSITION_MISSING",
    "REQUIRED_ORDERING_VIOLATION", "PROHIBITED_PURPOSE_PRESENT", "PROHIBITED_EFFECT_PRESENT",
    "INVALID_COVERAGE_CLAIM",
  ];
  const missing = expected.filter((code) => !Object.values(FAILURE_CODES).includes(code));
  // evaluator 必須有 ordering 之 existence-agnostic 處理（before/after 缺失不回報 ordering）
  const evSrc = readFileSync(`${ROOT}/src/v2/case-evaluator.mjs`, "utf8");
  const orderingAgnostic = /before\.length === 0 \|\| after\.length === 0\) break/.test(evSrc);
  return { pass: missing.length === 0 && orderingAgnostic, problems: [...missing.map((m) => `missing code ${m}`), ...(orderingAgnostic ? [] : ["ordering check not existence-agnostic"])] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = scanProvenance();
  const r = scanRetiredOracle();
  const t = scanFailureTaxonomy();
  const allPass = p.pass && r.pass && t.pass;
  process.stdout.write(JSON.stringify({ provenance: p, retired_oracle: r, failure_taxonomy: t, all_pass: allPass }, null, 2) + "\n");
  if (!allPass) process.exitCode = 1;
}
