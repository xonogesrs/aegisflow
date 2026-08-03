// src/v2/scorecard-v2.mjs
//
// Scorecard v2 — H1–H12 hard gates + A-1..A-10 advisory + verdict。
// 對應 SCORECARD_v2.0.0-rc1。Advisory 不得單獨使 correctness verdict 失敗
// （除非達到 §3.2 明文安全/可執行性下限）。

import { validateStructural } from "./structural-validator.mjs";
import { validateSemantic, frontierOrderingViolations, classifyExtraEdges } from "./semantic-consistency.mjs";
import { evaluateCase } from "./case-evaluator.mjs";

// Advisory 下限（Scorecard v2 §3.2）— 達標即 HOLD
function advisoryFloorFailures(ir, extraEdges) {
  const failures = [];
  if (ir.verdict !== "DECOMPOSED") return failures;
  // A-9 下限：完全重複 responsibility + covers → HOLD
  const byId = new Map(ir.phases.map(p => [p.phase_id, p]));
  const seen = new Map();
  for (const p of ir.phases) {
    const key = `${p.purpose}|${JSON.stringify((p.covers || []).map(c => c.requirement_id).sort())}|${p.responsibility}`;
    if (seen.has(key)) failures.push(`duplicate responsibility floor: ${p.phase_id} duplicates ${seen.get(key)}`);
    seen.set(key, p.phase_id);
  }
  // A-1 下限：phase 數 > 7（M9 SOURCE 硬界，已由 H2 檢查；此處保險）
  if (ir.phases.length > 7) failures.push("phase count > 7 (M9)");
  return failures;
}

function computeAdvisory(ir, extraEdges) {
  const out = [];
  if (ir.verdict !== "DECOMPOSED") return out;
  const n = ir.phases.length;
  const reqCount = (ir.phases || []).reduce((acc, p) => acc + (p.covers || []).length, 0);
  out.push({ metric: "A-1", name: "over-split", value: reqCount > 0 ? +(n / reqCount).toFixed(2) : null, note: `phases=${n} covers=${reqCount}` });
  out.push({ metric: "A-2", name: "unnecessary serialization", value: extraEdges.unnecessary.length, note: extraEdges.unnecessary.slice(0, 3).join("; ") });
  const perPhase = ir.phases.map(p => (p.covers || []).length);
  out.push({ metric: "A-3", name: "over-merge", value: Math.max(0, ...perPhase, 0), note: "max responsibility per phase" });
  out.push({ metric: "A-4", name: "naming clarity", value: null, note: "display-only; not a correctness gate (C5)" });
  const unplan = ir.phases.filter(p => (p.purpose === "verification" || p.purpose === "review") && !p.verification_plan).length;
  out.push({ metric: "A-5", name: "phase executability", value: unplan, note: "verification/review without plan (H9 catches as hard)" });
  const unResolvedBlocked = (ir.dispositions || []).filter(d => d.disposition === "unresolved" || d.disposition === "blocked").length;
  out.push({ metric: "A-10", name: "unresolved/blocked count", value: unResolvedBlocked, note: "advisory ≤3" });
  const dupResp = new Set();
  const seen = new Set();
  for (const p of ir.phases) {
    const key = `${p.purpose}|${p.responsibility}`;
    if (seen.has(key)) dupResp.add(p.phase_id);
    seen.add(key);
  }
  out.push({ metric: "A-9", name: "duplicate responsibility", value: dupResp.size, note: [...dupResp].join(",") || "none" });
  return out;
}

/**
 * 完整評估 v2 decomposition。
 * @param {object} ir
 * @param {object} opts {parent, manifest, contract}
 * @returns {{gates: object[], advisory: object[], frontierFailures: string[],
 *             caseFailures: string[], verdict: "PASS"|"HOLD"|"NOT_BENEFICIAL",
 *             advisoryHold: string[]}}
 */
export function evaluateScorecardV2(ir, { parent, manifest, contract } = {}) {
  const structuralGates = validateStructural(ir, parent);
  const semantic = validateSemantic(ir, manifest);
  const frontierFailures = frontierOrderingViolations(ir);
  const extraEdges = classifyExtraEdges(ir);
  const caseResult = contract ? evaluateCase(ir, contract) : { failures: [], codes: [] };
  const caseFailures = caseResult.failures;
  const caseCodes = caseResult.codes;

  const allGates = [...structuralGates, ...semantic.gates];

  const hardFailures = [];
  for (const g of allGates) {
    if (!g.pass) hardFailures.push(`${g.gate_id}: ${g.evidence}`);
  }
  if (frontierFailures.length) hardFailures.push(`D-13 frontier: ${frontierFailures.join("; ")}`);
  if (caseFailures.length) hardFailures.push(`case contract: ${caseFailures.join("; ")}`);

  const advisoryHold = advisoryFloorFailures(ir, extraEdges);
  if (advisoryHold.length) hardFailures.push(`advisory floor: ${advisoryHold.join("; ")}`);

  const advisory = computeAdvisory(ir, extraEdges);

  let verdict;
  if (hardFailures.length > 0) {
    verdict = "HOLD";
  } else if (ir.verdict === "DECOMPOSITION_NOT_BENEFICIAL") {
    verdict = "NOT_BENEFICIAL";
  } else {
    verdict = "PASS";
  }

  return {
    gates: allGates,
    advisory,
    frontierFailures,
    caseFailures,
    caseCodes,
    advisoryHold,
    verdict,
    hardFailures,
  };
}
