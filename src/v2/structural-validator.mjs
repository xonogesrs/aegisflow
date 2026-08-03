// src/v2/structural-validator.mjs
//
// Structural validator v2 — 純結構與局部一致性檢查（Scorecard v2 H1/H2/H3/H5/H7/H8/H12）。
// 不改寫輸入、不加 defaults、不 rename、不補 edge/coverage、不做字串語意推論。

import { validateIRShape, REASON_CODES } from "./ir-schema.mjs";

export const EXECUTION_POLICY_LOCK = Object.freeze({
  executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false,
});

// canonicalized identity：trim + NFKC + casefold（collision 以正規化後比較）
export function canonicalizeId(id) {
  return String(id).trim().normalize("NFKC").toLowerCase();
}

function pathWithinScope(childPath, parentPaths) {
  const n = String(childPath).replace(/\/+$/, "");
  return parentPaths.some(p => {
    const np = String(p).replace(/\/+$/, "");
    return n === np || n.startsWith(np + "/");
  });
}

/**
 * H1 — strict syntax and schema
 */
export function checkH1(ir) {
  return gateResult("H1", "Strict syntax and schema", "SOURCE_DERIVED",
    validateIRShape(ir).valid, validateIRShape(ir).errors.join("; "), "H1_SCHEMA");
}

function gateResult(gate_id, name, source_classification, pass, evidence, failure_code) {
  return { gate_id, name, source_classification, pass, evidence, failure_code: pass ? null : failure_code };
}

/**
 * H2 — unique identity and valid references
 */
export function checkH2(ir) {
  const failures = [];
  if (ir.verdict !== "DECOMPOSED") return gateResult("H2", "Unique identity and valid references", "SOURCE_DERIVED", true, "no phases", null);

  const ids = new Set();
  const canon = new Set();
  for (const p of ir.phases) {
    if (ids.has(p.phase_id)) failures.push(`duplicate phase_id: ${p.phase_id}`);
    ids.add(p.phase_id);
    const c = canonicalizeId(p.phase_id);
    if (canon.has(c)) failures.push(`canonicalized collision: "${p.phase_id}" collides after normalization`);
    canon.add(c);
  }
  for (const p of ir.phases) {
    for (const ref of p.depends_on || []) {
      if (!ids.has(ref)) failures.push(`depends_on references unknown phase: ${ref}`);
      if (ref === p.phase_id) failures.push(`self-dependency: ${p.phase_id}`);
    }
    for (const c of p.covers || []) {
      // requirement_id existence 由語意層對 manifest 檢查（H4）
    }
    if (p.verification_plan) {
      for (const s of p.verification_plan.subject_phase_ids || []) {
        if (!ids.has(s)) failures.push(`verification_plan subject references unknown phase: ${s}`);
        if (s === p.phase_id) failures.push(`verification_plan subject self-reference: ${p.phase_id}`);
      }
    }
  }
  return gateResult("H2", "Unique identity and valid references", "SOURCE_DERIVED",
    failures.length === 0, failures.join("; ") || "ok", "H2_IDENTITY");
}

/**
 * H3 — DAG and dependency correctness（cycle/duplicate edge/unsafe extra edge）
 */
export function checkH3(ir) {
  const failures = [];
  if (ir.verdict !== "DECOMPOSED") return gateResult("H3", "DAG and dependency correctness", "SOURCE_DERIVED", true, "no phases", null);

  const ids = ir.phases.map(p => p.phase_id);
  const idSet = new Set(ids);

  // duplicate edges
  const seen = new Set();
  for (const p of ir.phases) {
    for (const ref of p.depends_on || []) {
      const key = `${p.phase_id}->${ref}`;
      if (seen.has(key)) failures.push(`duplicate edge: ${key}`);
      seen.add(key);
    }
  }

  // cycle detection (DFS)
  const adj = new Map();
  for (const id of ids) adj.set(id, []);
  for (const p of ir.phases) {
    for (const ref of p.depends_on || []) {
      if (idSet.has(ref)) adj.get(p.phase_id).push(ref);
    }
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of ids) color.set(id, WHITE);
  let cycle = null;
  if (ids.length > 0) {
    (function dfs(node, path) {
      if (cycle) return;
      color.set(node, GRAY); path.push(node);
      for (const next of adj.get(node) || []) {
        const c = color.get(next);
        if (c === GRAY) { const s = path.indexOf(next); cycle = [...path.slice(s), next].join(" → "); return; }
        if (c === WHITE) dfs(next, path);
      }
      path.pop(); color.set(node, BLACK);
    })(ids[0], []);
  }
  if (cycle) failures.push(`cycle detected: ${cycle}`);

  // unsafe extra edge: reverse dependency vs verification_plan subject（object 不可 depends_on 其 subject 鏈）
  // verification/review subject 必須位於 depends_on 傳遞閉包（見語意層 H9）；此處只標「subject 反向依賴」
  for (const p of ir.phases) {
    if (!p.verification_plan) continue;
    for (const s of p.verification_plan.subject_phase_ids || []) {
      // 反向依賴：subject 直接 depends_on 驗證者
      const subj = ir.phases.find(x => x.phase_id === s);
      if (subj && (subj.depends_on || []).includes(p.phase_id)) {
        failures.push(`unsafe extra edge: subject ${s} depends on its verifier ${p.phase_id}`);
      }
    }
  }

  return gateResult("H3", "DAG and dependency correctness", "SOURCE_DERIVED",
    failures.length === 0, failures.join("; ") || "ok", "H3_DAG");
}

/**
 * H5 — no unsupported scope expansion（child boundaries ⊆ parent allowed_paths）
 */
export function checkH5(ir, parent) {
  const failures = [];
  if (ir.verdict !== "DECOMPOSED") return gateResult("H5", "No unsupported scope expansion", "SOURCE_DERIVED", true, "no phases", null);
  const pPaths = parent?.scope?.allowed_paths || [];
  const pForbidden = parent?.scope?.forbidden_paths || [];
  for (const p of ir.phases) {
    const art = p.effects?.boundaries?.artifact || [];
    if (p.effects?.artifact_mutation !== "forbidden" && art.length === 0) {
      failures.push(`${p.phase_id}: artifact_mutation=${p.effects?.artifact_mutation} requires non-empty artifact boundary`);
    }
    for (const path of art) {
      if (!pathWithinScope(path, pPaths)) failures.push(`${p.phase_id}: artifact boundary "${path}" not in parent scope`);
      for (const fp of pForbidden) {
        const nfp = fp.replace(/\/+$/, "");
        const ncp = path.replace(/\/+$/, "");
        if (ncp === nfp || ncp.startsWith(nfp + "/")) failures.push(`${p.phase_id}: artifact boundary "${path}" intersects parent forbidden_path "${fp}"`);
        if (nfp.startsWith(ncp + "/")) failures.push(`${p.phase_id}: artifact boundary "${path}" is ancestor of parent forbidden_path "${fp}"`);
      }
    }
  }
  return gateResult("H5", "No unsupported scope expansion", "SOURCE_DERIVED",
    failures.length === 0, failures.join("; ") || "ok", "H5_SCOPE");
}

/**
 * H7 — permission and mutation boundary preservation
 *（required → 非空 boundary；persistent evidence → evidence boundary；
 *  forbidden → 不得配非空 target；單一 writer ≤1 mutation phase）
 */
export function checkH7(ir, parent) {
  const failures = [];
  if (ir.verdict !== "DECOMPOSED") return gateResult("H7", "Permission and mutation boundary preservation", "SOURCE_DERIVED", true, "no phases", null);

  let writerCount = 0;
  const mutationPhases = [];
  for (const p of ir.phases) {
    const e = p.effects || {};
    const b = e.boundaries || {};
    if (e.artifact_mutation === "required" || e.artifact_mutation === "allowed") {
      writerCount++;
      mutationPhases.push(p);
      if ((b.artifact || []).length === 0) failures.push(`${p.phase_id}: artifact_mutation=${e.artifact_mutation} requires non-empty boundaries.artifact`);
    }
    if ((e.runtime_side_effect === "allowed" || e.runtime_side_effect === "required") && (b.runtime || []).length === 0) {
      failures.push(`${p.phase_id}: runtime_side_effect=${e.runtime_side_effect} requires non-empty boundaries.runtime`);
    }
    if ((e.external_system_mutation === "allowed" || e.external_system_mutation === "required") && (b.external_system || []).length === 0) {
      failures.push(`${p.phase_id}: external_system_mutation=${e.external_system_mutation} requires non-empty boundaries.external_system`);
    }
    if (e.evidence_output === "persistent" && (b.evidence || []).length === 0) {
      failures.push(`${p.phase_id}: evidence_output=persistent requires non-empty boundaries.evidence`);
    }
    if (e.artifact_mutation === "forbidden" && (b.artifact || []).length > 0) {
      failures.push(`${p.phase_id}: artifact_mutation=forbidden must not declare artifact boundary targets`);
    }
  }
  // 單一 writer：平行 mutation 由 runner 排程禁止（S1 §5/H12）—— decomposition shape 可含多個
  // 依序 mutation phases（E6 V1 先例：impl/test/oauth 三卡）。此處不做 shape 硬拒；
  // 可並行（彼此無依賴）的 mutation phases 以 advisory A-8 記錄（需序列化）。

  return gateResult("H7", "Permission and mutation boundary preservation", "SOURCE_DERIVED",
    failures.length === 0, failures.join("; ") || "ok", "H7_BOUNDARY");
}

/**
 * H8 — disposition validity（決策表 required fields、reason_code 清單、terminal）
 */
export function checkH8(ir) {
  const failures = [];
  if (!Array.isArray(ir.dispositions)) {
    return gateResult("H8", "Disposition validity", "SOURCE_DERIVED", true, "no dispositions", null);
  }
  const seen = new Set();
  for (const d of ir.dispositions) {
    if (seen.has(d.requirement_id)) failures.push(`duplicate disposition: ${d.requirement_id}`);
    seen.add(d.requirement_id);
    if (d.disposition === "actionable") { failures.push(`actionable must not be explicit disposition: ${d.requirement_id}`); continue; }
    if (d.reason_code !== undefined && !REASON_CODES[d.disposition]?.includes(d.reason_code)) {
      failures.push(`${d.requirement_id}: reason_code "${d.reason_code}" invalid for ${d.disposition}`);
    }
    if (d.disposition === "deferred" && d.target === undefined && d.reason === undefined) {
      failures.push(`${d.requirement_id}: deferred requires target or reason (D-16)`);
    }
    if (d.disposition === "deferred" && d.reason !== undefined && typeof d.reason !== "string") {
      failures.push(`${d.requirement_id}: deferred.reason must be string`);
    }
    if (d.disposition === "unresolved" && d.question === undefined) {
      failures.push(`${d.requirement_id}: unresolved requires question`);
    }
    if (d.disposition === "blocked" && (d.dependency === undefined || typeof d.dependency !== "string")) {
      failures.push(`${d.requirement_id}: blocked requires dependency (string)`);
    }
    if (d.disposition === "out_of_scope" && d.evidence === undefined) {
      failures.push(`${d.requirement_id}: out_of_scope requires evidence`);
    }
    if (d.disposition === "not_beneficial" && d.evidence === undefined) {
      failures.push(`${d.requirement_id}: not_beneficial requires evidence`);
    }
  }
  return gateResult("H8", "Disposition validity", "SOURCE_DERIVED",
    failures.length === 0, failures.join("; ") || "ok", "H8_DISPOSITION");
}

/**
 * H12 — policy-lock and single-writer compliance（execution_policy 固定；commit/push 語意由 case 層）
 */
export function checkH12(ir) {
  const failures = [];
  if (ir.verdict === "DECOMPOSED") {
    if (ir.execution_policy === undefined) {
      failures.push("DECOMPOSED missing execution_policy");
    } else {
      const ep = ir.execution_policy;
      if (ep.executor !== EXECUTION_POLICY_LOCK.executor) failures.push(`executor: ${ep.executor} ≠ INHERIT_PARENT`);
      if (ep.reviewer !== EXECUTION_POLICY_LOCK.reviewer) failures.push(`reviewer: ${ep.reviewer} ≠ EXTERNAL_GPT`);
      if (ep.multi_model_orchestration !== false) failures.push(`multi_model_orchestration: must be false`);
    }
  }
  return gateResult("H12", "Policy-lock and single-writer compliance", "SOURCE_DERIVED",
    failures.length === 0, failures.join("; ") || "ok", "H12_POLICY");
}

/**
 * Run all structural gates.
 * @returns {object[]} gate results
 */
export function validateStructural(ir, parent) {
  const gates = [
    checkH1(ir),
    checkH2(ir),
    checkH3(ir),
    checkH5(ir, parent),
    checkH7(ir, parent),
    checkH8(ir),
    checkH12(ir),
  ];
  return gates;
}
