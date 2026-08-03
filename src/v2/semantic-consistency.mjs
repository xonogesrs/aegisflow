// src/v2/semantic-consistency.mjs
//
// Semantic consistency layer v2 — 明文、deterministic 的 contract invariants。
// Scorecard v2 H4（requirement completeness）、H6（purpose/effect 一致性）、
// H9（verification/evidence closure）、H10（hard-stop 保留）。
// 嚴格禁止：自由文字 substring、embedding、alias dictionary、phase 名稱推導。
// 本層不宣稱能自動證明自然語言需求完整性——它只檢查顯式宣告之間的一致性。

// purpose × effect 一致性表（Semantic Contract v2 §13，D-11 更新）
// 返回 failure 訊息陣列或 null
const PURPOSE_EFFECT_RULES = {
  analysis: {
    artifact: ["forbidden", "allowed"],   // allowed 僅限交付物/證據（D-11）
    runtime: ["forbidden"],
    external: ["forbidden"],
    note: "analysis 預設不得改 production/source/test artifacts；persistent evidence 需 evidence boundary",
  },
  implementation: {
    artifact: ["allowed", "required"],
    runtime: ["forbidden", "allowed"],
    external: ["forbidden", "allowed"],
    note: "external allowed 限 boundary 且非 production（case contract 判定）",
  },
  verification: {
    artifact: ["forbidden", "required", "allowed"], // C1：寫測試 required；執行 forbidden
    runtime: ["forbidden", "allowed", "required"],
    external: ["forbidden", "allowed"], // 限非 production boundary（E4 sandbox；由 no_production_boundary 判定）
    note: "C1：verification 可 artifact=required（撰寫）或 forbidden（執行）",
  },
  review: {
    artifact: ["forbidden"],
    runtime: ["forbidden"],
    external: ["forbidden"],
    note: "Z8：review 不得要求 mutation authority",
  },
  operation: {
    artifact: ["forbidden", "allowed"],
    runtime: ["allowed", "required"],
    external: ["forbidden", "allowed"],
    note: "operation 限宣告邊界；production → out_of_scope",
  },
};

export function purposeEffectViolations(p) {
  const rule = PURPOSE_EFFECT_RULES[p.purpose];
  if (!rule) return [`${p.phase_id}: unknown purpose ${p.purpose}`];
  const e = p.effects || {};
  const out = [];
  if (!rule.artifact.includes(e.artifact_mutation)) out.push(`${p.phase_id}: purpose=${p.purpose} with artifact_mutation=${e.artifact_mutation} violates contract table`);
  if (!rule.runtime.includes(e.runtime_side_effect)) out.push(`${p.phase_id}: purpose=${p.purpose} with runtime_side_effect=${e.runtime_side_effect} violates contract table`);
  if (!rule.external.includes(e.external_system_mutation)) out.push(`${p.phase_id}: purpose=${p.purpose} with external_system_mutation=${e.external_system_mutation} violates contract table`);
  // D-11: analysis 不得修改 source/test artifacts —— 若 analysis artifact allowed，必須有 contract 授權
  //（此處不檢查路徑語意；由 case contract 的 allowed_effects 與 required_ordering 驗證）
  return out;
}

/**
 * H6 — purpose/effect consistency
 */
export function checkH6(ir) {
  const failures = [];
  if (ir.verdict !== "DECOMPOSED") return gateResult("H6", "Purpose/effect consistency", "SOURCE_DERIVED", true, "no phases", null);
  for (const p of ir.phases) {
    failures.push(...purposeEffectViolations(p));
  }
  return gateResult("H6", "Purpose/effect consistency", "SOURCE_DERIVED",
    failures.length === 0, failures.join("; ") || "ok", "H6_PURPOSE_EFFECT");
}

/**
 * H4 — source requirement completeness（每個 manifest requirement 恰一次 complete 處置）
 * @param {object} manifest [{requirement_id, text}]
 */
export function checkH4(ir, manifest) {
  const failures = [];
  if (ir.verdict !== "DECOMPOSED") {
    if (ir.verdict === "DECOMPOSITION_NOT_BENEFICIAL") {
      // C3：NOT_BENEFICIAL 需所有 requirement not_beneficial
      if (manifest && manifest.length > 0) {
        const nb = new Set((ir.dispositions || []).filter(d => d.disposition === "not_beneficial").map(d => d.requirement_id));
        for (const r of manifest) {
          if (!nb.has(r.requirement_id)) failures.push(`NOT_BENEFICIAL: ${r.requirement_id} not dispositioned not_beneficial`);
        }
      }
      return gateResult("H4", "Source requirement completeness", "SOURCE_DERIVED",
        failures.length === 0, failures.join("; ") || "ok", "H4_COMPLETENESS");
    }
    return gateResult("H4", "Source requirement completeness", "SOURCE_DERIVED", true, "no manifest treatment for non-DECOMPOSED", null);
  }

  if (!manifest || manifest.length === 0) {
    return gateResult("H4", "Source requirement completeness", "SOURCE_DERIVED", true,
      "no manifest — cannot claim 100% coverage (Z1 holds at campaign level)", null);
  }

  const manifestIds = manifest.map(r => r.requirement_id);
  const completeOf = new Map(); // requirement_id -> [phase_id...]
  const partialOf = new Map();
  for (const p of ir.phases) {
    for (const c of p.covers || []) {
      if (c.completeness === "complete") {
        if (!completeOf.has(c.requirement_id)) completeOf.set(c.requirement_id, []);
        completeOf.get(c.requirement_id).push(p.phase_id);
      } else if (c.completeness === "partial") {
        if (!partialOf.has(c.requirement_id)) partialOf.set(c.requirement_id, []);
        partialOf.get(c.requirement_id).push(p.phase_id);
      }
    }
  }
  const dispositionOf = new Set((ir.dispositions || []).map(d => d.requirement_id));

  for (const rid of manifestIds) {
    const nComplete = (completeOf.get(rid) || []).length;
    const covered = nComplete > 0;
    const disposed = dispositionOf.has(rid);
    if (covered && disposed) failures.push(`${rid}: both complete-covered and dispositioned`);
    if (!covered && !disposed) failures.push(`${rid}: not covered nor dispositioned (Z1)`);
    if (nComplete > 1) failures.push(`${rid}: multiple complete frontiers: ${completeOf.get(rid).join(", ")} (D-13)`);
  }
  for (const rid of completeOf.keys()) {
    if (!manifestIds.includes(rid)) failures.push(`coverage references unknown requirement: ${rid}`);
  }
  for (const d of ir.dispositions || []) {
    if (!manifestIds.includes(d.requirement_id)) failures.push(`disposition references unknown requirement: ${d.requirement_id}`);
  }

  return gateResult("H4", "Source requirement completeness", "SOURCE_DERIVED",
    failures.length === 0, failures.join("; ") || "ok", "H4_COMPLETENESS");
}

/**
 * D-13 — completion frontier graph ordering：
 * complete frontier 必須位於所有必要 partial coverage 之後（transitively）。
 * 回傳 failures。
 */
export function frontierOrderingViolations(ir) {
  const failures = [];
  if (ir.verdict !== "DECOMPOSED") return failures;

  const idSet = new Set(ir.phases.map(p => p.phase_id));
  const phaseBy = new Map(ir.phases.map(p => [p.phase_id, p]));
  const partialBranches = new Map(); // requirement_id -> phase_ids (partial)
  const completeFrontier = new Map(); // requirement_id -> phase_id

  for (const p of ir.phases) {
    for (const c of p.covers || []) {
      if (c.completeness === "partial") {
        if (!partialBranches.has(c.requirement_id)) partialBranches.set(c.requirement_id, []);
        partialBranches.get(c.requirement_id).push(p.phase_id);
      } else if (c.completeness === "complete") {
        completeFrontier.set(c.requirement_id, p.phase_id);
      }
    }
  }

  // depends_on 傳遞閉包
  function closure(node, seen = new Set()) {
    if (seen.has(node)) return seen;
    seen.add(node);
    for (const d of phaseBy.get(node)?.depends_on || []) {
      if (idSet.has(d)) closure(d, seen);
    }
    return seen;
  }

  for (const [rid, frontierPhase] of completeFrontier) {
    const branches = partialBranches.get(rid) || [];
    if (branches.length === 0) {
      // 無 partial 分支：frontier 直接 complete 合法（單 phase 覆蓋）
      continue;
    }
    const fc = closure(frontierPhase);
    for (const b of branches) {
      if (!fc.has(b)) {
        failures.push(`complete frontier ${frontierPhase} for ${rid} does not depend on partial branch ${b} (D-13)`);
      }
    }
  }

  // 純 no-op barrier 檢查：complete frontier 不得為「無 covers 以外責任」的純 join 節點
  for (const [rid, frontierPhase] of completeFrontier) {
    const p = phaseBy.get(frontierPhase);
    const branches = partialBranches.get(rid) || [];
    if (branches.length > 1) {
      const coversOthers = (p.covers || []).some(c => c.requirement_id !== rid);
      const hasVerification = p.verification_plan !== undefined;
      const hasResponsibility = typeof p.responsibility === "string" && p.responsibility.trim().length > 0;
      if (!coversOthers && !hasVerification && !hasResponsibility) {
        failures.push(`complete frontier ${frontierPhase} for ${rid} is a pure no-op barrier (D-13)`);
      }
    }
  }

  return failures;
}

/**
 * H9 — verification and evidence closure（verification/review 必帶 plan；subject 前置）
 */
export function checkH9(ir) {
  const failures = [];
  if (ir.verdict !== "DECOMPOSED") return gateResult("H9", "Verification and evidence closure", "VALID_INFERENCE", true, "no phases", null);

  const idSet = new Set(ir.phases.map(p => p.phase_id));
  const phaseBy = new Map(ir.phases.map(p => [p.phase_id, p]));

  function closure(node, seen = new Set()) {
    if (seen.has(node)) return seen;
    seen.add(node);
    for (const d of phaseBy.get(node)?.depends_on || []) {
      if (idSet.has(d)) closure(d, seen);
    }
    return seen;
  }

  for (const p of ir.phases) {
    if (p.purpose === "verification" || p.purpose === "review") {
      if (!p.verification_plan) {
        failures.push(`${p.phase_id}: ${p.purpose} requires verification_plan`);
        continue;
      }
      const vp = p.verification_plan;
      const subjects = vp.subject_phase_ids || [];
      if (subjects.length === 0) failures.push(`${p.phase_id}: verification_plan requires subject_phase_ids`);
      const fc = closure(p.phase_id);
      for (const s of subjects) {
        if (!idSet.has(s)) failures.push(`${p.phase_id}: subject ${s} unknown`);
        else if (!fc.has(s)) failures.push(`${p.phase_id}: verifies subject ${s} that is not a transitive prerequisite (H3/H9)`);
      }
      // evidence boundary 一致性：persistent evidence 需 evidence boundary（H7 已查）；此處查 plan.evidence 非空
      if (typeof vp.evidence !== "string" || vp.evidence.trim().length === 0) {
        failures.push(`${p.phase_id}: verification_plan.evidence required`);
      }
    } else {
      // analysis/implementation/operation 可帶 plan（允許），不強制（依 contract）
    }
  }

  return gateResult("H9", "Verification and evidence closure", "VALID_INFERENCE",
    failures.length === 0, failures.join("; ") || "ok", "H9_CLOSURE");
}

/**
 * H10 — hard-stop and failure semantics preservation
 * （phase 不得宣稱 production runtime 可執行 — 由 case contract 的 production_markers 判定，
 *   此處僅檢查 IR 自身：verification/review 之 subject 存在已由 H9；此 gate 檢查
 *   NOT_BENEFICIAL 是否誤用於 blocked/out_of_scope 情境——由 C3 表判定）
 */
export function checkH10(ir) {
  const failures = [];
  if (ir.verdict === "DECOMPOSITION_NOT_BENEFICIAL") {
    const disps = ir.dispositions || [];
    for (const d of disps) {
      if (d.disposition === "blocked" || d.disposition === "out_of_scope" || d.disposition === "unresolved") {
        failures.push(`NOT_BENEFICIAL contains ${d.disposition} for ${d.requirement_id} — NOT_BENEFICIAL cannot substitute blocked/out_of_scope/unresolved (C3)`);
      }
    }
  }
  return gateResult("H10", "Hard-stop and failure semantics preservation", "SOURCE_DERIVED",
    failures.length === 0, failures.join("; ") || "ok", "H10_HARDSTOP");
}

/**
 * Extra edge classification（advisory A-2 用）：
 * safe-but-unnecessary = 無環、無違反，但序列化可並行獨立 phase。
 * @returns {{unsafe: string[], unnecessary: string[]}}
 */
export function classifyExtraEdges(ir) {
  const unsafe = [];
  const unnecessary = [];
  if (ir.verdict !== "DECOMPOSED") return { unsafe, unnecessary };

  const phaseBy = new Map(ir.phases.map(p => [p.phase_id, p]));
  const idSet = new Set(ir.phases.map(p => p.phase_id));

  for (const p of ir.phases) {
    for (const d of p.depends_on || []) {
      if (!idSet.has(d)) { unsafe.push(`${p.phase_id}->${d}: unknown reference`); continue; }
      if (d === p.phase_id) { unsafe.push(`${p.phase_id}->${d}: self-dependency`); continue; }
      const dep = phaseBy.get(d);
      // unnecessary serialization：dependency 之間無 object 關係、且無 sharing 語意
      const isVerificationDep = p.purpose === "verification" && (p.verification_plan?.subject_phase_ids || []).includes(d);
      const isReviewDep = p.purpose === "review" && (p.verification_plan?.subject_phase_ids || []).includes(d);
      const samePurposeIndependent = dep.purpose === p.purpose && dep.purpose !== "implementation" && !isVerificationDep && !isReviewDep;
      if (samePurposeIndependent) unnecessary.push(`${p.phase_id}->${d}: serializes independent ${p.purpose} phases`);
    }
  }
  return { unsafe, unnecessary };
}

function gateResult(gate_id, name, source_classification, pass, evidence, failure_code) {
  return { gate_id, name, source_classification, pass, evidence, failure_code: pass ? null : failure_code };
}

/**
 * Run all semantic gates + frontier rules.
 * @returns {{gates: object[], frontierFailures: string[], extraEdges: object}}
 */
export function validateSemantic(ir, manifest) {
  const gates = [
    checkH4(ir, manifest),
    checkH6(ir),
    checkH9(ir),
    checkH10(ir),
  ];
  const frontierFailures = frontierOrderingViolations(ir);
  const extraEdges = classifyExtraEdges(ir);
  return { gates, frontierFailures, extraEdges };
}
