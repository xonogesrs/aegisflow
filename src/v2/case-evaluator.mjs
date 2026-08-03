// src/v2/case-evaluator.mjs
//
// Case-contract evaluator v2 — 機械執行 machine-readable case contract invariants。
// 對應 EVAL_CONTRACT_v2.0.0-rc1（Card 5B erratum 後）。
// 嚴格禁止：名稱/字串/substring/alias 推導；只處理顯式資料欄位。
//
// Card 5B failure taxonomy（分開輸出，不再以 ordering 間接承載 existence）：
//   REQUIRED_RESPONSIBILITY_UNCOVERED — manifest requirement 無 complete coverage 或合法 disposition
//   REQUIRED_PURPOSE_MISSING          — source/policy assertion 要求某 purpose 存在但無 phase
//   REQUIRED_DISPOSITION_MISSING      — 要求之 disposition 缺失或錯誤
//   REQUIRED_ORDERING_VIOLATION       — before/after 皆存在但 dependency 不成立
//   PROHIBITED_PURPOSE_PRESENT        — 禁止之 purpose phase 存在
//   PROHIBITED_EFFECT_PRESENT         — 禁止之 effect/boundary 存在
//   INVALID_COVERAGE_CLAIM            — coverage 或 purpose/effect 宣稱不合法
//   VERDICT_MISMATCH / PHASE_COUNT_VIOLATION（輔助碼）

export const FAILURE_CODES = Object.freeze({
  RESPONSIBILITY_UNCOVERED: "REQUIRED_RESPONSIBILITY_UNCOVERED",
  PURPOSE_MISSING: "REQUIRED_PURPOSE_MISSING",
  DISPOSITION_MISSING: "REQUIRED_DISPOSITION_MISSING",
  ORDERING_VIOLATION: "REQUIRED_ORDERING_VIOLATION",
  PROHIBITED_PURPOSE: "PROHIBITED_PURPOSE_PRESENT",
  PROHIBITED_EFFECT: "PROHIBITED_EFFECT_PRESENT",
  INVALID_COVERAGE: "INVALID_COVERAGE_CLAIM",
  VERDICT_MISMATCH: "VERDICT_MISMATCH",
  PHASE_COUNT: "PHASE_COUNT_VIOLATION",
});

const fail = (code, message) => ({ code, message: `[${code}] ${message}` });

function transitiveClosure(phaseId, phaseById) {
  const seen = new Set();
  const stack = [phaseId];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of phaseById.get(cur)?.depends_on || []) {
      if (phaseById.has(d)) stack.push(d);
    }
  }
  return seen;
}

function completeFrontierFor(ir, requirementId) {
  const found = [];
  for (const p of ir.phases || []) {
    for (const c of p.covers || []) {
      if (c.requirement_id === requirementId && c.completeness === "complete") found.push(p);
    }
  }
  return found;
}

function dispositionFor(ir, requirementId) {
  return (ir.dispositions || []).find(d => d.requirement_id === requirementId);
}

function phaseById(ir) {
  return new Map((ir.phases || []).map(p => [p.phase_id, p]));
}

/**
 * 執行單一 invariant。
 * @returns {{code: string, message: string}[]} failures（空 = pass）
 */
export function checkInvariant(ir, contract, inv) {
  const failures = [];
  const byId = phaseById(ir);

  switch (inv.type) {
    case "verdict":
      if (ir.verdict !== inv.verdict) {
        failures.push(fail(FAILURE_CODES.VERDICT_MISMATCH, `verdict: expected ${inv.verdict}, got ${ir.verdict}`));
      }
      break;

    case "req_purpose": {
      const frontiers = completeFrontierFor(ir, inv.requirement_id);
      if (frontiers.length === 0) {
        // existence/coverage 由 H4 處理（REQUIRED_RESPONSIBILITY_UNCOVERED）；此處不重複誤報
        break;
      }
      for (const f of frontiers) {
        if (!inv.purposes.includes(f.purpose)) {
          failures.push(fail(FAILURE_CODES.INVALID_COVERAGE,
            `${inv.requirement_id}: complete frontier ${f.phase_id} has purpose ${f.purpose}, expected one of ${inv.purposes.join("|")}`));
        }
      }
      break;
    }

    case "coverage_effect": {
      // ∃ phase 覆蓋 requirement_id（complete 或 partial）且 purpose 相符且 effect 值合法
      const carriers = (ir.phases || []).filter(p =>
        p.purpose === inv.purpose && (p.covers || []).some(c => c.requirement_id === inv.requirement_id));
      const ok = carriers.some(p => inv.values.includes(p.effects?.[inv.field]));
      if (!ok) {
        failures.push(fail(FAILURE_CODES.INVALID_COVERAGE,
          `${inv.requirement_id}: no ${inv.purpose} phase covers it with ${inv.field} ∈ ${inv.values.join("|")} (${inv.note || ""})`));
      }
      break;
    }

    case "required_purpose": {
      const found = (ir.phases || []).some(p => inv.purposes.includes(p.purpose));
      if (!found) {
        failures.push(fail(FAILURE_CODES.PURPOSE_MISSING, `required purpose missing: ${inv.purposes.join("|")}`));
      }
      break;
    }

    case "disposition": {
      const d = dispositionFor(ir, inv.requirement_id);
      if (!d) {
        failures.push(fail(FAILURE_CODES.DISPOSITION_MISSING, `${inv.requirement_id}: missing disposition (expected ${inv.disposition})`));
      } else {
        if (d.disposition !== inv.disposition) {
          failures.push(fail(FAILURE_CODES.DISPOSITION_MISSING,
            `${inv.requirement_id}: disposition ${d.disposition} ≠ expected ${inv.disposition}`));
        }
        if (inv.reason_code !== undefined && d.reason_code !== inv.reason_code) {
          failures.push(fail(FAILURE_CODES.DISPOSITION_MISSING,
            `${inv.requirement_id}: reason_code ${d.reason_code} ≠ expected ${inv.reason_code}`));
        }
      }
      break;
    }

    case "ordering": {
      // Card 5B：existence 與 ordering 分離。before/after 任一不存在 → 非 ordering 問題；
      // 由 H4（REQUIRED_RESPONSIBILITY_UNCOVERED）或 required_purpose assertion 判定。
      const before = (ir.phases || []).filter(p => inv.before_purposes.includes(p.purpose));
      const after = (ir.phases || []).filter(p => inv.after_purposes.includes(p.purpose));
      if (before.length === 0 || after.length === 0) break;
      let ok = false;
      for (const b of after) {
        const closure = transitiveClosure(b.phase_id, byId);
        if (before.some(a => closure.has(a.phase_id))) { ok = true; break; }
      }
      if (!ok) {
        failures.push(fail(FAILURE_CODES.ORDERING_VIOLATION,
          `no ${inv.after_purposes.join("|")} phase depends on any ${inv.before_purposes.join("|")} phase`));
      }
      break;
    }

    case "no_phase_purpose": {
      for (const p of ir.phases || []) {
        if (inv.purposes.includes(p.purpose)) {
          failures.push(fail(FAILURE_CODES.PROHIBITED_PURPOSE, `unexpected phase purpose ${p.purpose} (${p.phase_id})`));
        }
      }
      break;
    }

    case "no_production_boundary": {
      const markers = contract.production_markers || [];
      for (const p of ir.phases || []) {
        const b = p.effects?.boundaries || {};
        for (const key of ["runtime", "external_system"]) {
          for (const entry of b[key] || []) {
            if (markers.some(m => entry === m || entry.startsWith(m + ":") || entry.startsWith(m + "/"))) {
              failures.push(fail(FAILURE_CODES.PROHIBITED_EFFECT,
                `${p.phase_id}: boundary "${entry}" matches production marker "${markers.find(m => entry === m || entry.startsWith(m + ":") || entry.startsWith(m + "/"))}"`));
            }
          }
        }
      }
      break;
    }

    case "phase_count": {
      const n = (ir.phases || []).length;
      if (inv.min !== undefined && n < inv.min) failures.push(fail(FAILURE_CODES.PHASE_COUNT, `phase count ${n} < min ${inv.min}`));
      if (inv.max !== undefined && n > inv.max) failures.push(fail(FAILURE_CODES.PHASE_COUNT, `phase count ${n} > max ${inv.max}`));
      break;
    }

    case "all_requirements_disposed": {
      const reqs = contract.requirements || [];
      for (const r of reqs) {
        const d = dispositionFor(ir, r.requirement_id);
        if (!d || d.disposition !== inv.disposition) {
          failures.push(fail(FAILURE_CODES.DISPOSITION_MISSING, `${r.requirement_id}: expected disposition ${inv.disposition}`));
        }
      }
      break;
    }

    default:
      failures.push(fail("UNKNOWN_INVARIANT", `unknown invariant type: ${inv.type}`));
  }
  return failures;
}

/**
 * 評估 decomposition 是否符合 case contract。
 * @param {object} ir
 * @param {object} contract
 * @returns {{pass: boolean, failures: string[], codes: string[]}}
 */
export function evaluateCase(ir, contract) {
  const failures = [];
  const codes = [];
  for (const inv of contract.invariants || []) {
    const f = checkInvariant(ir, contract, inv);
    for (const x of f) {
      failures.push(x.message);
      codes.push(x.code);
    }
  }
  return { pass: failures.length === 0, failures, codes };
}
