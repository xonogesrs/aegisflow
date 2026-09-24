// scripts/shared/probe-sources.mjs
// V2 Card 5 — 四案 live probe source 構造（單一來源，避免 manifest／probe／test 之間漂移）。
//
// requirements 來自 case contract（frozen src/v2/case-contracts.mjs）；
// authority boundary 來自原始 Task Decomposition eval fixture（frozen autoloop-analysis/
// task-decomposition-eval-cases.json）。不讀 expected_decomposition / title /
// min_cards / required_edges（避免 oracle 洩漏）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTRACTS_BY_ID } from "../../src/v2/case-contracts.mjs";

const EVAL_CASES_RAW = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../test/fixtures/task-decomposition-eval-cases.json", import.meta.url)), "utf8"),
);
const EVAL_CASES = Array.isArray(EVAL_CASES_RAW) ? EVAL_CASES_RAW : EVAL_CASES_RAW.cases || EVAL_CASES_RAW.eval_cases || [];

export const PROBE_ORDER = Object.freeze(["E2", "E6", "E9", "E4"]);

export function probeSource(caseId) {
  const contract = CONTRACTS_BY_ID[caseId];
  const ev = EVAL_CASES.find((e) => e.case_id === caseId);
  return {
    caseId,
    requirements: contract.requirements,
    authority: {
      allowed_paths: ev?.authority_boundary?.allowed_paths || [],
      mutation_allowed: ev?.authority_boundary?.mutation_allowed ?? true,
      commit_allowed: ev?.authority_boundary?.commit_allowed ?? false,
    },
  };
}

export function probeParent(caseId) {
  const src = probeSource(caseId);
  return { scope: { allowed_paths: src.authority.allowed_paths, forbidden_paths: [] } };
}
