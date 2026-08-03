// src/v2/case-contracts.mjs
//
// E1–E12 machine-readable v2 case contracts（與舊 eval JSON 並存，不改舊檔）。
// 對應 EVAL_CONTRACT_v2.0.0-rc1。欄位：case_id / expected_verdict / requirements /
// allowed_purposes / required_dispositions / invariants / quality_preferences /
// accepted_examples / known_invalid_examples / source_ambiguities / controller_overrides。
//
// invariants 為純資料結構（無函式），由 case-evaluator.mjs 機械執行：
//   {type:"verdict", verdict}
//   {type:"req_purpose", requirement_id, purposes[], completeness:"complete"}
//   {type:"disposition", requirement_id, disposition, reason_code}
//   {type:"ordering", before_purposes[], after_purposes[]}
//   {type:"no_phase_purpose", purposes[]}
//   {type:"no_production_boundary"}
//   {type:"phase_count", min, max}           // 僅 source 明文要求時使用
//   {type:"all_requirements_disposed", disposition}   // NOT_BENEFICIAL 用
//
// known_invalid_examples 為 declarative mutation ops，由 applyMutation 套用於 reference。

export const MUTATION_OPS = Object.freeze([
  "remove_phase", "drop_coverage", "change_purpose", "change_effect",
  "add_edge", "remove_edge", "change_disposition", "change_verdict",
  "add_phase", "clear_verification_plan", "add_noop_join", "duplicate_complete",
  "add_production_boundary", "change_completeness",
]);

/** 套用 declarative mutation 到 IR（測試與 invalid examples 用；不修改原物件） */
export function applyMutation(ir, m) {
  const clone = structuredClone(ir);
  const phases = clone.phases || [];
  const byId = new Map(phases.map(p => [p.phase_id, p]));
  const findReqCover = (phaseId, rid) =>
    (byId.get(phaseId)?.covers || []).find(c => c.requirement_id === rid);

  switch (m.op) {
    case "remove_phase": {
      const idx = phases.findIndex(p => p.phase_id === m.phase_id);
      if (idx !== -1) phases.splice(idx, 1);
      for (const p of phases) {
        p.depends_on = (p.depends_on || []).filter(d => d !== m.phase_id);
      }
      break;
    }
    case "drop_coverage":
      for (const p of phases) {
        p.covers = (p.covers || []).filter(c => !(c.requirement_id === m.requirement_id && (m.phase_id === undefined || p.phase_id === m.phase_id)));
      }
      break;
    case "change_purpose": {
      const p = byId.get(m.phase_id);
      if (p) p.purpose = m.to;
      break;
    }
    case "change_effect": {
      const p = byId.get(m.phase_id);
      if (p) p.effects[m.field] = m.to;
      break;
    }
    case "add_edge": {
      const p = byId.get(m.from);
      if (p) { p.depends_on = p.depends_on || []; if (!p.depends_on.includes(m.to)) p.depends_on.push(m.to); }
      break;
    }
    case "remove_edge": {
      const p = byId.get(m.from);
      if (p) p.depends_on = (p.depends_on || []).filter(d => d !== m.to);
      break;
    }
    case "change_disposition": {
      const d = (clone.dispositions || []).find(x => x.requirement_id === m.requirement_id);
      if (d) {
        d.disposition = m.to;
        d.reason_code = m.reason_code || d.reason_code;
        if (m.to === "unresolved") d.question = d.question || "why";
        if (m.to === "blocked") d.dependency = d.dependency || "external";
      }
      break;
    }
    case "change_verdict":
      clone.verdict = m.to;
      break;
    case "add_phase":
      phases.push(m.phase);
      break;
    case "clear_verification_plan": {
      const p = byId.get(m.phase_id);
      if (p) delete p.verification_plan;
      break;
    }
    case "add_noop_join": {
      // 純 join barrier：無責任、無 covers、無 plan
      const p = {
        phase_id: m.phase_id || "noop_join",
        title: "join", summary: "join", responsibility: "",
        purpose: "verification",
        effects: { artifact_mutation: "forbidden", runtime_side_effect: "forbidden",
          external_system_mutation: "forbidden", evidence_output: "none",
          boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] } },
        covers: [{ requirement_id: m.requirement_id, completeness: "complete", claim: "join" }],
        depends_on: m.branches || [],
      };
      phases.push(p);
      break;
    }
    case "duplicate_complete": {
      const src = byId.get(m.phase_id);
      if (src) {
        const cov = src.covers.find(c => c.requirement_id === m.requirement_id);
        if (cov) {
          const dup = { ...src, phase_id: m.phase_id + "_dup", covers: [{ ...cov }] };
          phases.push(dup);
        }
      }
      break;
    }
    case "add_production_boundary": {
      const p = byId.get(m.phase_id);
      if (p) {
        p.effects.external_system_mutation = "required";
        p.effects.boundaries.external_system = p.effects.boundaries.external_system || [];
        p.effects.boundaries.external_system.push(m.boundary || "production:db");
      }
      break;
    }
    case "change_completeness": {
      const p = byId.get(m.phase_id);
      const cov = p && findReqCover(m.phase_id, m.requirement_id);
      if (cov) cov.completeness = m.to;
      break;
    }
    default:
      throw new Error(`unknown mutation op: ${m.op}`);
  }
  return clone;
}

// ── 共用 reference builders ──

function baseEffects(artifact = "forbidden", runtime = "forbidden", external = "forbidden",
  evidence = "none", extra = {}) {
  return {
    artifact_mutation: artifact, runtime_side_effect: runtime,
    external_system_mutation: external, evidence_output: evidence,
    boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
    ...extra,
  };
}

function phase(phase_id, purpose, effects, covers, depends_on = [], plan) {
  const p = {
    phase_id, title: phase_id, summary: phase_id, responsibility: phase_id,
    purpose, effects, covers, depends_on,
  };
  if (plan) p.verification_plan = plan;
  return p;
}

function disp(requirement_id, disposition, reason_code, extra = {}) {
  return { requirement_id, disposition, reason_code, ...extra };
}

function plan(subjects, method, success, failure, evidence) {
  return { subject_phase_ids: subjects, method, success_criteria: success, failure_criteria: failure, evidence };
}

// ── E1–E12 case contracts ──

// ── Card 5B assertion provenance model ──
// 每個 hard assertion 必須具有：
//   { id, classification, source_reference, requirement_ids, description }
// classification ∈ {SOURCE_DERIVED, VALID_INFERENCE, CONTROLLER_POLICY, QUALITY_PREFERENCE}
// 不合格來源（不得出現於 source_reference）：legacy fixture shape、canonical role 名稱、
// reference phase count、reference edge set、substring、matcher 既有行為、「一直如此測試」。

export const PROVENANCE_CLASSIFICATIONS = Object.freeze([
  "SOURCE_DERIVED", "VALID_INFERENCE", "CONTROLLER_POLICY", "QUALITY_PREFERENCE",
]);

export const UNSUPPORTED_PROVENANCE_TERMS = Object.freeze([
  "required_edges", "required_card_types", "min_cards", "max_cards",
  "fixture", "matcher", "一直如此", "canonical role", "substring",
]);

const P = (id, classification, source_reference, requirement_ids, description) => ({
  id, classification, source_reference, requirement_ids: [...requirement_ids], description,
});

// provenance keyed by case + invariant signature
const PROVENANCE = Object.freeze({
  // E1
  "E1:verdict": P("E1-verdict-1", "SOURCE_DERIVED", "E1 parent_task_summary「在 README.md 修正一個 typo」；C3 NB-1..7", [], "單一 typo 屬 trivial，無分解效益（NOT_BENEFICIAL）"),
  // E2
  "E2:verdict": P("E2-verdict-1", "SOURCE_DERIVED", "E2 parent_requirement_manifest R1–R4 具多項可執行責任", ["R1", "R2", "R3", "R4"], "任務含分析/實作/驗證等可分解責任"),
  "E2:req:R1": P("E2-req-1", "SOURCE_DERIVED", "R1「分析現有結構」", ["R1"], "分析責任由 analysis purpose 承載"),
  "E2:req:R2": P("E2-req-2", "SOURCE_DERIVED", "R2「提取共用邏輯」", ["R2"], "提取/修改共用邏輯 = implementation"),
  "E2:req:R3": P("E2-req-3", "CONTROLLER_POLICY", "R3「加入單元測試」；C1（測試撰寫=verification）", ["R3"], "測試撰寫由 verification purpose 承載（C1）"),
  "E2:ceffect:R3": P("E2-ceffect-1", "CONTROLLER_POLICY", "R3「加入單元測試」；C1（撰寫需 mutation）", ["R3"], "R3 需測試撰寫能力：至少一 verification phase 具 artifact allowed/required"),
  "E2:disp:R4": P("E2-disp-1", "SOURCE_DERIVED", "R4「提交結果」＋authority commit_allowed=false", ["R4"], "commit 未授權 → deferred/COMMIT_NOT_AUTHORIZED"),
  "E2:ord:analysis->implementation": P("E2-ord-1", "VALID_INFERENCE", "R1→R2 語意依賴（先分析後提取）", ["R1", "R2"], "提取共用邏輯需先理解現有結構"),
  "E2:ord:implementation->verification": P("E2-ord-2", "VALID_INFERENCE", "R2→R3 語意依賴（先實作後測試）", ["R2", "R3"], "單元測試需先有被測實作"),
  // E3
  "E3:verdict": P("E3-verdict-1", "SOURCE_DERIVED", "E3 parent_requirement_manifest R1–R5", ["R1", "R2", "R3", "R4", "R5"], "任務含完整 DAG 責任"),
  "E3:req:R1": P("E3-req-1", "SOURCE_DERIVED", "R1「定義 contract」；D-02（設計/契約由 analysis 承載）", ["R1"], "定義 contract = analysis"),
  "E3:req:R2": P("E3-req-2", "SOURCE_DERIVED", "R2「實作 adapter」", ["R2"], "實作 = implementation"),
  "E3:req:R3": P("E3-req-3", "CONTROLLER_POLICY", "R3「寫 scripted tests」；C1", ["R3"], "測試撰寫 = verification"),
  "E3:req:R4": P("E3-req-4", "SOURCE_DERIVED", "R4「跑 real smoke」", ["R4"], "執行驗證 = verification"),
  "E3:req:R5": P("E3-req-5", "SOURCE_DERIVED", "R5「GPT review」明文", ["R5"], "外部 review 責任 = review purpose"),
  "E3:ord:analysis->implementation": P("E3-ord-1", "VALID_INFERENCE", "R1→R2 語意依賴", ["R1", "R2"], "先定義 contract 再實作 adapter"),
  "E3:ord:implementation->verification": P("E3-ord-2", "VALID_INFERENCE", "R2→R3/R4 語意依賴", ["R2", "R3", "R4"], "測試/煙霧需先有實作"),
  "E3:ord:verification->review": P("E3-ord-3", "VALID_INFERENCE", "R5 review 對象為 R3/R4 產物；H9 subject 前置", ["R3", "R4", "R5"], "review 需在驗證產物之後"),
  // E4
  "E4:verdict": P("E4-verdict-1", "SOURCE_DERIVED", "E4 parent_requirement_manifest R1–R3", ["R1", "R2", "R3"], "離線工作可分解"),
  "E4:req:R1": P("E4-req-1", "SOURCE_DERIVED", "R1「產生 migration 檔案」", ["R1"], "撰寫檔案 = implementation"),
  "E4:req:R2": P("E4-req-2", "SOURCE_DERIVED", "R2「離線驗證 schema integrity」", ["R2"], "離線驗證 = verification"),
  "E4:disp:R3": P("E4-disp-1", "CONTROLLER_POLICY", "R3「實際更新 production database」；C4（PRODUCTION_RUNTIME_OUT_OF_SCOPE）", ["R3"], "production 操作超出 scope → out_of_scope"),
  "E4:ord:implementation->verification": P("E4-ord-1", "VALID_INFERENCE", "R1→R2 語意依賴（先產生 migration 再驗證）", ["R1", "R2"], "驗證對象需先存在"),
  "E4:npb": P("E4-npb-1", "CONTROLLER_POLICY", "C4/H-DISP-5（production 不可宣稱可執行）", ["R2"], "任何 phase 不得宣告 production runtime/external boundary"),
  // E5
  "E5:verdict": P("E5-verdict-1", "SOURCE_DERIVED", "E5 parent_requirement_manifest R1–R2", ["R1", "R2"], "主 repo 責任可執行"),
  "E5:req:R1": P("E5-req-1", "SOURCE_DERIVED", "R1「autoloop 實作新功能」", ["R1"], "實作 = implementation（analysis 前置可接受）"),
  "E5:disp:R2": P("E5-disp-1", "CONTROLLER_POLICY", "R2「aura-plans 更新」；D-16（跨 repo 非 disposition；S2 明文 deferred）", ["R2"], "跨 repo 責任延後到已知 owner → deferred/CROSS_REPO_AUTHORITY_REQUIRED"),
  // E6
  "E6:verdict": P("E6-verdict-1", "SOURCE_DERIVED", "E6 parent_requirement_manifest R1–R6", ["R1", "R2", "R3", "R4", "R5", "R6"], "六個功能責任可分解"),
  "E6:req:R1": P("E6-req-1", "SOURCE_DERIVED", "R1「login」", ["R1"], "功能實作 = implementation（analysis 前置可接受）"),
  "E6:req:R2": P("E6-req-2", "SOURCE_DERIVED", "R2「logout」", ["R2"], "功能實作 = implementation（analysis 前置可接受）"),
  "E6:req:R3": P("E6-req-3", "SOURCE_DERIVED", "R3「session management」", ["R3"], "功能實作 = implementation（analysis 前置可接受）"),
  "E6:req:R4": P("E6-req-4", "SOURCE_DERIVED", "R4「password reset」", ["R4"], "功能實作 = implementation（analysis 前置可接受）"),
  "E6:req:R5": P("E6-req-5", "CONTROLLER_POLICY", "R5「email verification」= 功能；退役 VERIFICATION_SIGNALS（禁止流程 verification 誤標）", ["R5"], "email verification 是功能 → implementation，禁止 substring 推導"),
  "E6:req:R6": P("E6-req-6", "SOURCE_DERIVED", "R6「OAuth2」", ["R6"], "功能實作 = implementation（analysis 前置可接受）"),
  // E7
  "E7:verdict": P("E7-verdict-1", "SOURCE_DERIVED", "E7 parent_requirement_manifest R1–R3", ["R1", "R2", "R3"], "診斷/修正/驗證可分解"),
  "E7:req:R1": P("E7-req-1", "SOURCE_DERIVED", "R1「診斷跨模組 bug 根因」", ["R1"], "診斷 = analysis"),
  "E7:req:R2": P("E7-req-2", "SOURCE_DERIVED", "R2「修正 src/utils/helper.js」", ["R2"], "修正 = implementation"),
  "E7:req:R3": P("E7-req-3", "SOURCE_DERIVED", "R3「驗證修正不影響其他模組」", ["R3"], "流程驗證 = verification"),
  "E7:ord:analysis->implementation": P("E7-ord-1", "VALID_INFERENCE", "R1→R2 語意依賴", ["R1", "R2"], "先診斷根因再修正"),
  "E7:ord:implementation->verification": P("E7-ord-2", "VALID_INFERENCE", "R2→R3 語意依賴", ["R2", "R3"], "修正後才能驗證無影響"),
  // E8
  "E8:verdict": P("E8-verdict-1", "SOURCE_DERIVED", "R1「三模組互相依賴」；S1 無安全 DAG → BLOCKED", ["R1"], "循環依賴無法形成安全 DAG"),
  "E8:disp:R1": P("E8-disp-1", "SOURCE_DERIVED", "R1 循環依賴；S1 unresolved 語意", ["R1"], "需決策打破循環 → unresolved/CYCLIC_DEPENDENCY"),
  // E9
  "E9:verdict": P("E9-verdict-1", "SOURCE_DERIVED", "E9 TEST-ONLY manifest R1–R4", ["R1", "R2", "R3", "R4"], "四責任可分解（execution-conformance）"),
  "E9:req:R1": P("E9-req-1", "SOURCE_DERIVED", "R1「建立 foundation/baseline 分析」", ["R1"], "baseline 分析 = analysis"),
  "E9:req:R2": P("E9-req-2", "SOURCE_DERIVED", "R2「實作 feature」", ["R2"], "實作 = implementation"),
  "E9:req:R3": P("E9-req-3", "SOURCE_DERIVED", "R3「執行測試驗證」", ["R3"], "驗證 = verification"),
  "E9:req:R4": P("E9-req-4", "SOURCE_DERIVED", "R4「外部 review」明文", ["R4"], "review 責任 = review purpose"),
  "E9:ord:analysis->implementation": P("E9-ord-1", "VALID_INFERENCE", "R1→R2 語意依賴", ["R1", "R2"], "先建立 baseline 再實作"),
  "E9:ord:implementation->verification": P("E9-ord-2", "VALID_INFERENCE", "R2→R3 語意依賴", ["R2", "R3"], "測試需先有實作"),
  "E9:ord:verification->review": P("E9-ord-3", "VALID_INFERENCE", "R4 review 對象為驗證產物；H9 subject 前置", ["R3", "R4"], "review 需在驗證之後"),
  // E10
  "E10:verdict": P("E10-verdict-1", "SOURCE_DERIVED", "E10 TEST-ONLY manifest R1–R3", ["R1", "R2", "R3"], "三責任可分解（resume-conformance）"),
  "E10:req:R1": P("E10-req-1", "SOURCE_DERIVED", "R1「audit baseline」", ["R1"], "baseline audit = analysis"),
  "E10:req:R2": P("E10-req-2", "SOURCE_DERIVED", "R2「實作」", ["R2"], "實作 = implementation"),
  "E10:req:R3": P("E10-req-3", "SOURCE_DERIVED", "R3「review」明文", ["R3"], "review 責任 = review purpose"),
  "E10:ord:analysis->implementation": P("E10-ord-1", "VALID_INFERENCE", "R1→R2 語意依賴", ["R1", "R2"], "先 baseline 再實作"),
  "E10:ord:implementation->review": P("E10-ord-2", "VALID_INFERENCE", "R2→R3 語意依賴；H9 subject 前置", ["R2", "R3"], "review 需在實作之後"),
  // E11
  "E11:verdict": P("E11-verdict-1", "SOURCE_DERIVED", "E11 單檔 3 行 helper；C3 NB-1..7", [], "trivial 單點改動無分解效益（NOT_BENEFICIAL）"),
  // E12
  "E12:verdict": P("E12-verdict-1", "SOURCE_DERIVED", "E12 parent_requirement_manifest R1–R2", ["R1", "R2"], "功能責任可執行，多模型責任延後"),
  "E12:req:R1": P("E12-req-1", "SOURCE_DERIVED", "R1「實作功能 X」", ["R1"], "實作 = implementation（analysis 前置可接受）"),
  "E12:disp:R2": P("E12-disp-2", "CONTROLLER_POLICY", "R2 多模型分工；S1 Z10/H12 multi_model_orchestration=false", ["R2"], "多模型 orchestration 禁止 → deferred/MULTI_MODEL_ORCHESTRATION_FORBIDDEN"),
});

function provenanceKey(caseId, inv) {
  switch (inv.type) {
    case "verdict": return `${caseId}:verdict`;
    case "req_purpose": return `${caseId}:req:${inv.requirement_id}`;
    case "disposition": return `${caseId}:disp:${inv.requirement_id}`;
    case "ordering": return `${caseId}:ord:${inv.before_purposes.join("+")}->${inv.after_purposes.join("+")}`;
    case "no_phase_purpose": return `${caseId}:npp:${inv.purposes.join("+")}`;
    case "no_production_boundary": return `${caseId}:npb`;
    case "phase_count": return `${caseId}:count`;
    case "all_requirements_disposed": return `${caseId}:alldisp`;
    case "required_purpose": return `${caseId}:reqpurpose:${inv.purposes.join("+")}`;
    case "coverage_effect": return `${caseId}:ceffect:${inv.requirement_id}`;
    default: return `${caseId}:unknown:${inv.type}`;
  }
}

/**
 * 為每個 invariant 附加 provenance；缺表項即 throw（fail-closed）。
 * @param {object[]} contracts
 */
export function attachProvenance(contracts) {
  return contracts.map((c) => ({
    ...c,
    invariants: c.invariants.map((inv) => {
      const key = provenanceKey(c.case_id, inv);
      const pv = PROVENANCE[key];
      if (!pv) throw new Error(`missing provenance for ${key}`);
      return { ...inv, provenance: pv };
    }),
  }));
}

// eslint-disable-next-line
const RAW_CASE_CONTRACTS = [
  {
    case_id: "E1",
    expected_verdict: "DECOMPOSITION_NOT_BENEFICIAL",
    requirements: [],           // 無 manifest
    allowed_purposes: [],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSITION_NOT_BENEFICIAL" },
    ],
    quality_preferences: [],
    production_markers: [],
    accepted_examples: [{
      verdict: "DECOMPOSITION_NOT_BENEFICIAL",
      reason: "Single typo fix in README.md; decomposition overhead exceeds task complexity.",
      decomposition_evidence: ["Task scope limited to one file with a one-line change"],
    }],
    known_invalid_examples: [
      { id: "E1-invalid-1", category: "wrong verdict with phases", mutation: { op: "change_verdict", to: "DECOMPOSED" }, note: "no phases under DECOMPOSED → H1" },
    ],
    source_ambiguities: ["NOT_BENEFICIAL vs 1-card DECOMPOSED boundary (O-5; C3 NB-1..7)"],
    controller_overrides: ["C3"],
  },

  {
    case_id: "E2",
    expected_verdict: "DECOMPOSED",
    requirements: [
      { requirement_id: "R1", text: "分析現有結構" },
      { requirement_id: "R2", text: "提取共用邏輯" },
      { requirement_id: "R3", text: "加入單元測試" },
      { requirement_id: "R4", text: "提交結果" },
    ],
    allowed_purposes: ["analysis", "implementation", "verification", "review"],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSED" },
      { type: "req_purpose", requirement_id: "R1", purposes: ["analysis"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R2", purposes: ["implementation"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R3", purposes: ["verification"], completeness: "complete" },
      // Card 5B（C1）：R3「加入單元測試」需要測試撰寫能力——任一覆蓋 R3 的 verification phase
      // 必須具 artifact_mutation allowed/required（authoring）。執行-only 覆蓋不滿足「加入測試」。
      { type: "coverage_effect", requirement_id: "R3", purpose: "verification", field: "artifact_mutation", values: ["allowed", "required"], note: "R3 加入單元測試需測試撰寫能力（C1）" },
      { type: "disposition", requirement_id: "R4", disposition: "deferred", reason_code: "COMMIT_NOT_AUTHORIZED" },
      { type: "ordering", before_purposes: ["analysis"], after_purposes: ["implementation"] },
      { type: "ordering", before_purposes: ["implementation"], after_purposes: ["verification"] },
      // Card 5B：移除無來源依據之 verification→review ordering（5A audit：E2 source 無 review requirement）
    ],
    quality_preferences: ["5-phase (authoring/execution split) and 4-phase (merged, effects corrected) both acceptable"],
    production_markers: [],
    accepted_examples: [
      // reference 4-phase（test 卡修正：verification + artifact allowed）
      {
        verdict: "DECOMPOSED",
        parent_goal: "Analyze existing auth structure, extract shared logic, add unit tests, commit results",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [
          phase("audit", "analysis", baseEffects(), [{ requirement_id: "R1", completeness: "complete", claim: "analysis" }], []),
          phase("extract_common_logic", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/auth/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R2", completeness: "complete", claim: "extract" }], ["audit"]),
          phase("add_and_run_unit_tests", "verification",
            baseEffects("allowed", "allowed", "forbidden", "none", { boundaries: { artifact: ["test/auth/"], runtime: ["test/auth/"], external_system: [], evidence: [] } }),
            [{ requirement_id: "R3", completeness: "complete", claim: "write and run unit tests" }],
            ["extract_common_logic"],
            plan(["extract_common_logic"], "npm test", "all tests pass", "any failure", "test report")),
          phase("final_review", "review", baseEffects(), [], ["add_and_run_unit_tests"],
            plan(["extract_common_logic", "add_and_run_unit_tests"], "review", "no open findings", "findings remain", "review notes")),
        ],
        dispositions: [disp("R4", "deferred", "COMMIT_NOT_AUTHORIZED", { reason: "commit not authorized", target: "future authorized card" })],
        decomposition_evidence: ["reference 4-phase corrected"],
      },
      // 5-phase（authoring/execution 分離，3.6D 形狀；C1）
      {
        verdict: "DECOMPOSED",
        parent_goal: "Analyze existing auth structure, extract shared logic, add unit tests, commit results",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [
          phase("audit_existing_structure", "analysis", baseEffects(), [{ requirement_id: "R1", completeness: "complete", claim: "analysis" }], []),
          phase("extract_common_logic", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/auth/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R2", completeness: "complete", claim: "extract" }], ["audit_existing_structure"]),
          phase("add_unit_tests", "verification", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["test/auth/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R3", completeness: "partial", claim: "write tests" }], ["extract_common_logic"],
            plan(["extract_common_logic"], "author tests per contract", "tests written in boundary", "tests not written", "test files")),
          phase("run_unit_tests", "verification", baseEffects("forbidden", "allowed", "forbidden", "none",
            { boundaries: { artifact: [], runtime: ["test/auth/"], external_system: [], evidence: [] } }),
            [{ requirement_id: "R3", completeness: "complete", claim: "run tests" }], ["add_unit_tests"],
            plan(["extract_common_logic", "add_unit_tests"], "npm test", "all tests pass", "any failure", "test report")),
          phase("final_review", "review", baseEffects(), [], ["run_unit_tests"],
            plan(["extract_common_logic", "run_unit_tests"], "review", "no open findings", "findings remain", "review notes")),
        ],
        dispositions: [disp("R4", "deferred", "COMMIT_NOT_AUTHORIZED", { reason: "commit not authorized", target: "future authorized card" })],
        decomposition_evidence: ["5-phase split with completion frontier run_unit_tests"],
      },
    ],
    known_invalid_examples: [
      { id: "E2-invalid-1", category: "missing requirement", mutation: { op: "drop_coverage", requirement_id: "R2" }, note: "H4 Z1" },
      { id: "E2-invalid-2", category: "wrong dependency", mutation: { op: "remove_edge", from: "extract_common_logic", to: "audit" }, note: "ordering invariant fails" },
      { id: "E2-invalid-3", category: "wrong purpose/effect", mutation: { op: "change_purpose", phase_id: "audit", to: "implementation" }, note: "R1 requires analysis; H6" },
      { id: "E2-invalid-4", category: "unauthorized mutation", mutation: { op: "change_effect", phase_id: "final_review", field: "artifact_mutation", to: "required" }, note: "H6 review forbidden" },
      { id: "E2-invalid-5", category: "unsupported scope expansion", mutation: { op: "change_effect", phase_id: "extract_common_logic", field: "boundaries", to: { artifact: ["etc/passwd"], runtime: [], external_system: [], evidence: [] } }, note: "artifact boundary outside parent scope; H5" },
      { id: "E2-invalid-6", category: "invalid disposition", mutation: { op: "change_disposition", requirement_id: "R4", to: "unresolved", reason_code: "CYCLIC_DEPENDENCY" }, note: "H8/H4 disposition mismatch" },
      { id: "E2-invalid-7", category: "evidence gap", mutation: { op: "clear_verification_plan", phase_id: "add_and_run_unit_tests" }, note: "H9" },
      { id: "E2-invalid-8", category: "legacy mutation contradiction", mutation: { op: "change_effect", phase_id: "add_and_run_unit_tests", field: "artifact_mutation", to: "forbidden" }, note: "R3 requires test authoring with mutation allowed (C1)" },
      { id: "E2-invalid-9", category: "multiple complete frontiers", mutation: { op: "duplicate_complete", phase_id: "add_and_run_unit_tests", requirement_id: "R3" }, note: "H4 D-13" },
    ],
    source_ambiguities: ["R3 mutation semantics (O-2; C1 frozen)"],
    controller_overrides: ["C1", "C5", "C6"],
  },

  {
    case_id: "E3",
    expected_verdict: "DECOMPOSED",
    requirements: [
      { requirement_id: "R1", text: "定義 contract" },
      { requirement_id: "R2", text: "實作 adapter" },
      { requirement_id: "R3", text: "寫 scripted tests" },
      { requirement_id: "R4", text: "跑 real smoke" },
      { requirement_id: "R5", text: "GPT review" },
    ],
    allowed_purposes: ["analysis", "implementation", "verification", "review"],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSED" },
      { type: "req_purpose", requirement_id: "R1", purposes: ["analysis"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R2", purposes: ["implementation"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R3", purposes: ["verification"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R4", purposes: ["verification"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R5", purposes: ["review"], completeness: "complete" },
      { type: "ordering", before_purposes: ["analysis"], after_purposes: ["implementation"] },
      { type: "ordering", before_purposes: ["implementation"], after_purposes: ["verification"] },
      { type: "ordering", before_purposes: ["verification"], after_purposes: ["review"] },
    ],
    quality_preferences: ["test+smoke may merge or split"],
    production_markers: [],
    accepted_examples: [
      {
        verdict: "DECOMPOSED",
        parent_goal: "Contract → adapter → scripted tests → smoke → GPT review",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [
          phase("contract", "analysis", baseEffects(), [{ requirement_id: "R1", completeness: "complete", claim: "define contract" }], []),
          phase("impl", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/adapter/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R2", completeness: "complete", claim: "implement adapter" }], ["contract"]),
          phase("scripted_tests", "verification", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["test/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R3", completeness: "complete", claim: "write scripted tests" }], ["impl"],
            plan(["impl"], "author scripted tests per contract", "tests written in boundary", "tests not written", "test files")),
          phase("smoke", "verification", baseEffects("forbidden", "allowed", "forbidden", "none",
            { boundaries: { artifact: [], runtime: ["test/"], external_system: [], evidence: [] } }),
            [{ requirement_id: "R4", completeness: "complete", claim: "run smoke" }], ["scripted_tests"],
            plan(["impl", "scripted_tests"], "smoke script", "integration passes", "integration fails", "smoke log")),
          phase("review", "review", baseEffects(), [{ requirement_id: "R5", completeness: "complete", claim: "GPT review" }], ["smoke"],
            plan(["impl", "smoke"], "review", "no open findings", "findings remain", "review notes")),
        ],
        dispositions: [],
        decomposition_evidence: ["reference 5-phase"],
      },
    ],
    known_invalid_examples: [
      { id: "E3-invalid-1", category: "missing requirement", mutation: { op: "drop_coverage", requirement_id: "R4" }, note: "H4" },
      { id: "E3-invalid-2", category: "wrong dependency", mutation: { op: "remove_edge", from: "smoke", to: "scripted_tests" }, note: "ordering invariant" },
      { id: "E3-invalid-3", category: "wrong purpose/effect", mutation: { op: "change_purpose", phase_id: "contract", to: "implementation" }, note: "R1 requires analysis" },
      { id: "E3-invalid-4", category: "unauthorized mutation", mutation: { op: "change_effect", phase_id: "review", field: "artifact_mutation", to: "allowed" }, note: "H6 review" },
      { id: "E3-invalid-5", category: "scope expansion", mutation: { op: "add_production_boundary", phase_id: "smoke" }, note: "H7 production" },
      { id: "E3-invalid-6", category: "evidence gap", mutation: { op: "clear_verification_plan", phase_id: "smoke" }, note: "H9" },
    ],
    source_ambiguities: ["contract carried by analysis purpose (D-02)"],
    controller_overrides: ["C1"],
  },

  {
    case_id: "E4",
    expected_verdict: "DECOMPOSED",
    requirements: [
      { requirement_id: "R1", text: "產生 migration 檔案" },
      { requirement_id: "R2", text: "離線驗證 schema integrity" },
      { requirement_id: "R3", text: "實際更新 production database" },
    ],
    allowed_purposes: ["analysis", "implementation", "verification", "operation"],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSED" },
      { type: "req_purpose", requirement_id: "R1", purposes: ["implementation"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R2", purposes: ["verification"], completeness: "complete" },
      { type: "disposition", requirement_id: "R3", disposition: "out_of_scope", reason_code: "PRODUCTION_RUNTIME_OUT_OF_SCOPE" },
      { type: "ordering", before_purposes: ["implementation"], after_purposes: ["verification"] },
      { type: "no_production_boundary" },
    ],
    quality_preferences: ["2-phase reference; 3-phase (with design) acceptable"],
    production_markers: ["production", "prod"],
    accepted_examples: [
      {
        verdict: "DECOMPOSED",
        parent_goal: "Generate migration, validate offline, production update out of scope",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [
          phase("generate_migration", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["migrations/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R1", completeness: "complete", claim: "generate migration file" }], []),
          phase("offline_validation", "verification", baseEffects("forbidden", "allowed", "allowed", "persistent",
            { boundaries: { artifact: [], runtime: ["sandbox"], external_system: ["sandbox:db"], evidence: ["evidence/schema-check.md"] } }),
            [{ requirement_id: "R2", completeness: "complete", claim: "offline schema validation" }], ["generate_migration"],
            plan(["generate_migration"], "schema check against sandbox", "integrity verified", "integrity fails", "schema check report")),
        ],
        dispositions: [disp("R3", "out_of_scope", "PRODUCTION_RUNTIME_OUT_OF_SCOPE",
          { reason: "production DB update outside parent authority", evidence: "authority boundary excludes production" })],
        decomposition_evidence: ["reference 2-phase; R3 out_of_scope (C4/D-15)"],
      },
    ],
    known_invalid_examples: [
      { id: "E4-invalid-1", category: "production claimed executable", mutation: { op: "add_production_boundary", phase_id: "offline_validation" }, note: "no_production_boundary invariant" },
      { id: "E4-invalid-2", category: "invalid disposition (deferred instead of out_of_scope)", mutation: { op: "change_disposition", requirement_id: "R3", to: "deferred", reason_code: "PRODUCTION_RUNTIME_OUT_OF_SCOPE" }, note: "H8/C4" },
      { id: "E4-invalid-3", category: "missing requirement", mutation: { op: "drop_coverage", requirement_id: "R2" }, note: "H4" },
      { id: "E4-invalid-4", category: "wrong dependency", mutation: { op: "remove_edge", from: "offline_validation", to: "generate_migration" }, note: "ordering" },
    ],
    source_ambiguities: ["PRODUCTION_RUNTIME deferred/unresolved dual-list resolved to out_of_scope (O-4; C4/D-15)"],
    controller_overrides: ["C4", "D-15"],
  },

  {
    case_id: "E5",
    expected_verdict: "DECOMPOSED",
    requirements: [
      { requirement_id: "R1", text: "autoloop 實作新功能" },
      { requirement_id: "R2", text: "aura-plans 更新對應文件" },
    ],
    allowed_purposes: ["analysis", "implementation"],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSED" },
      { type: "req_purpose", requirement_id: "R1", purposes: ["implementation", "analysis"], completeness: "complete" },
      // D-16：跨 repo 非 disposition。E5 case contract 依五情境表宣告：R2 為「總體目標但延後到已知後續 owner」→ deferred（含 target）
      { type: "disposition", requirement_id: "R2", disposition: "deferred", reason_code: "CROSS_REPO_AUTHORITY_REQUIRED" },
    ],
    quality_preferences: ["1-phase reference; 2-phase split acceptable"],
    production_markers: [],
    accepted_examples: [
      {
        verdict: "DECOMPOSED",
        parent_goal: "Implement feature in autoloop; aura-plans docs deferred",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [
          phase("impl_feature", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R1", completeness: "complete", claim: "implement feature" }], []),
        ],
        dispositions: [disp("R2", "deferred", "CROSS_REPO_AUTHORITY_REQUIRED",
          { reason: "aura-plans owned by separate repo/owner", target: "known follow-up card in aura-plans repo" })],
        decomposition_evidence: ["cross-repo location does not determine disposition (D-16); deferred with target"],
      },
    ],
    known_invalid_examples: [
      { id: "E5-invalid-1", category: "cross-repo claimed actionable", mutation: { op: "add_phase", phase: { phase_id: "aura_docs", title: "docs", summary: "docs", responsibility: "update aura-plans", purpose: "implementation", effects: baseEffects("required"), covers: [{ requirement_id: "R2", completeness: "complete", claim: "docs" }], depends_on: ["impl_feature"] } }, note: "R2 must be deferred (D-16 table)" },
      { id: "E5-invalid-2", category: "missing requirement", mutation: { op: "drop_coverage", requirement_id: "R1" }, note: "H4" },
    ],
    source_ambiguities: ["deferred-with-target rule (D-16) supersedes S2 bare code usage"],
    controller_overrides: ["D-16"],
  },

  {
    case_id: "E6",
    expected_verdict: "DECOMPOSED",
    requirements: [
      { requirement_id: "R1", text: "login" },
      { requirement_id: "R2", text: "logout" },
      { requirement_id: "R3", text: "session management" },
      { requirement_id: "R4", text: "password reset" },
      { requirement_id: "R5", text: "email verification" },
      { requirement_id: "R6", text: "OAuth2" },
    ],
    allowed_purposes: ["analysis", "implementation", "verification", "review"],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSED" },
      { type: "req_purpose", requirement_id: "R1", purposes: ["implementation", "analysis"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R2", purposes: ["implementation", "analysis"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R3", purposes: ["implementation", "analysis"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R4", purposes: ["implementation", "analysis"], completeness: "complete" },
      // R5「email verification」= 功能 → implementation 可覆蓋；禁止 substring 推導（E6 必要驗證）
      { type: "req_purpose", requirement_id: "R5", purposes: ["implementation"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R6", purposes: ["implementation", "analysis"], completeness: "complete" },
    ],
    quality_preferences: ["verification phase optional (not hard)"],
    production_markers: [],
    accepted_examples: [
      {
        verdict: "DECOMPOSED",
        parent_goal: "Implement 6 auth/email features",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [
          phase("p1", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/auth/"], runtime: [], external_system: [], evidence: [] } }),
            [
              { requirement_id: "R1", completeness: "complete", claim: "login" },
              { requirement_id: "R2", completeness: "complete", claim: "logout" },
              { requirement_id: "R3", completeness: "complete", claim: "session" },
            ], []),
          phase("p2", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/auth/", "src/email/"], runtime: [], external_system: [], evidence: [] } }),
            [
              { requirement_id: "R4", completeness: "complete", claim: "password reset" },
              { requirement_id: "R5", completeness: "complete", claim: "implement email verification feature" },
            ], []),
          phase("p3", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/auth/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R6", completeness: "complete", claim: "oauth2" }], []),
        ],
        dispositions: [],
        decomposition_evidence: ["R5 is a feature (implementation), not process verification"],
      },
    ],
    known_invalid_examples: [
      // substring trap：把 R5 標成 verification 且無有效 subject → H9
      {
        id: "E6-invalid-1", category: "verification-substring trap", mutation: {
          op: "change_purpose", phase_id: "p2", to: "verification",
        }, note: "p2 covers R5 as verification without subject → H9; also R5 requires implementation" },
      { id: "E6-invalid-2", category: "missing requirement", mutation: { op: "drop_coverage", requirement_id: "R6" }, note: "H4" },
      { id: "E6-invalid-3", category: "misleading coverage", mutation: { op: "change_completeness", phase_id: "p1", requirement_id: "R1", to: "partial" }, note: "H4 no complete frontier" },
    ],
    source_ambiguities: ["verification phase not mandatory (Card 2 X-2)"],
    controller_overrides: [],
  },

  {
    case_id: "E7",
    expected_verdict: "DECOMPOSED",
    requirements: [
      { requirement_id: "R1", text: "診斷跨模組 bug 根因" },
      { requirement_id: "R2", text: "修正 src/utils/helper.js" },
      { requirement_id: "R3", text: "驗證修正不影響其他模組" },
    ],
    allowed_purposes: ["analysis", "implementation", "verification"],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSED" },
      { type: "req_purpose", requirement_id: "R1", purposes: ["analysis"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R2", purposes: ["implementation"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R3", purposes: ["verification"], completeness: "complete" },
      { type: "ordering", before_purposes: ["analysis"], after_purposes: ["implementation"] },
      { type: "ordering", before_purposes: ["implementation"], after_purposes: ["verification"] },
    ],
    quality_preferences: ["3-phase reference; 4-phase with design acceptable"],
    production_markers: [],
    accepted_examples: [
      {
        verdict: "DECOMPOSED",
        parent_goal: "Diagnose bug root cause, fix helper.js, verify no impact",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [
          phase("diagnose", "analysis", baseEffects(), [{ requirement_id: "R1", completeness: "complete", claim: "diagnose" }], []),
          phase("fix_helper", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/utils/helper.js"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R2", completeness: "complete", claim: "fix" }], ["diagnose"]),
          phase("verify_no_impact", "verification", baseEffects("forbidden", "allowed", "forbidden", "none",
            { boundaries: { artifact: [], runtime: ["test/utils/"], external_system: [], evidence: [] } }),
            [{ requirement_id: "R3", completeness: "complete", claim: "verify" }], ["fix_helper"],
            plan(["fix_helper"], "test suite", "no regressions", "regression found", "test report")),
        ],
        dispositions: [],
        decomposition_evidence: ["reference 3-phase; role names are display only (C2/D-24)"],
      },
    ],
    known_invalid_examples: [
      { id: "E7-invalid-1", category: "missing requirement", mutation: { op: "drop_coverage", requirement_id: "R3" }, note: "H4" },
      { id: "E7-invalid-2", category: "wrong dependency", mutation: { op: "remove_edge", from: "verify_no_impact", to: "fix_helper" }, note: "ordering" },
      { id: "E7-invalid-3", category: "wrong purpose/effect", mutation: { op: "change_purpose", phase_id: "fix_helper", to: "analysis" }, note: "R2 requires implementation" },
      { id: "E7-invalid-4", category: "scope expansion", mutation: { op: "add_phase", phase: { phase_id: "touch_other", title: "x", summary: "x", responsibility: "modify elsewhere", purpose: "implementation", effects: baseEffects("required", "forbidden", "forbidden", "none", { boundaries: { artifact: ["src/other/"], runtime: [], external_system: [], evidence: [] } }), covers: [], depends_on: [] } }, note: "artifact boundary outside allowed (H5 via parent scope)" },
    ],
    source_ambiguities: ["fix role name is display only (L-1 retired)"],
    controller_overrides: ["C2"],
  },

  {
    case_id: "E8",
    expected_verdict: "DECOMPOSITION_BLOCKED",
    requirements: [{ requirement_id: "R1", text: "實作 A、B、C 三個互相依賴的模組" }],
    allowed_purposes: [],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSITION_BLOCKED" },
      { type: "disposition", requirement_id: "R1", disposition: "unresolved", reason_code: "CYCLIC_DEPENDENCY" },
    ],
    quality_preferences: [],
    production_markers: [],
    accepted_examples: [{
      verdict: "DECOMPOSITION_BLOCKED",
      dispositions: [disp("R1", "unresolved", "CYCLIC_DEPENDENCY", { question: "How to break the cycle?" })],
      decomposition_evidence: ["cyclic imports detected"],
    }],
    known_invalid_examples: [
      { id: "E8-invalid-1", category: "blocked with phases", mutation: { op: "add_phase", phase: { phase_id: "x", title: "x", summary: "x", responsibility: "x", purpose: "implementation", effects: baseEffects("required"), covers: [], depends_on: [] } }, note: "H1 BLOCKED phases empty" },
      { id: "E8-invalid-2", category: "wrong disposition", mutation: { op: "change_disposition", requirement_id: "R1", to: "deferred", reason_code: "COMMIT_NOT_AUTHORIZED" }, note: "H8" },
    ],
    source_ambiguities: ["BLOCKED vs refactor-DECOMPOSED boundary (O-7)"],
    controller_overrides: [],
  },

  {
    case_id: "E9",
    expected_verdict: "DECOMPOSED",
    // TEST-ONLY manifest（harness 既有模式；C2）
    requirements: [
      { requirement_id: "R1", text: "建立 foundation／baseline 分析" },
      { requirement_id: "R2", text: "實作 feature" },
      { requirement_id: "R3", text: "執行測試驗證" },
      { requirement_id: "R4", text: "外部 review" },
    ],
    allowed_purposes: ["analysis", "implementation", "verification", "review"],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSED" },
      { type: "req_purpose", requirement_id: "R1", purposes: ["analysis"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R2", purposes: ["implementation"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R3", purposes: ["verification"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R4", purposes: ["review"], completeness: "complete" },
      { type: "ordering", before_purposes: ["analysis"], after_purposes: ["implementation"] },
      { type: "ordering", before_purposes: ["implementation"], after_purposes: ["verification"] },
      { type: "ordering", before_purposes: ["verification"], after_purposes: ["review"] },
    ],
    quality_preferences: ["display labels foundation/impl/test/review are arbitrary (C2)"],
    production_markers: [],
    accepted_examples: [
      {
        verdict: "DECOMPOSED",
        parent_goal: "4-phase execution-conformance DAG",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [
          phase("foundation", "analysis", baseEffects(), [{ requirement_id: "R1", completeness: "complete", claim: "baseline" }], []),
          phase("impl", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R2", completeness: "complete", claim: "implement" }], ["foundation"]),
          phase("test", "verification", baseEffects("forbidden", "allowed", "forbidden", "none",
            { boundaries: { artifact: [], runtime: ["src/"], external_system: [], evidence: [] } }),
            [{ requirement_id: "R3", completeness: "complete", claim: "verify" }], ["impl"],
            plan(["impl"], "run tests", "pass", "fail", "test log")),
          phase("review", "review", baseEffects(), [{ requirement_id: "R4", completeness: "complete", claim: "review" }], ["test"],
            plan(["impl", "test"], "review", "ok", "findings", "notes")),
        ],
        dispositions: [],
        decomposition_evidence: ["no global role dictionary; display labels arbitrary (C2)"],
      },
      // rename-equivalent：display 全改，語意不變
      {
        verdict: "DECOMPOSED",
        parent_goal: "4-phase execution-conformance DAG",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [
          phase("analyze_base", "analysis", baseEffects(), [{ requirement_id: "R1", completeness: "complete", claim: "baseline" }], []),
          phase("build_feature", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R2", completeness: "complete", claim: "implement" }], ["analyze_base"]),
          phase("verify_all", "verification", baseEffects("forbidden", "allowed", "forbidden", "none",
            { boundaries: { artifact: [], runtime: ["src/"], external_system: [], evidence: [] } }),
            [{ requirement_id: "R3", completeness: "complete", claim: "verify" }], ["build_feature"],
            plan(["build_feature"], "run tests", "pass", "fail", "test log")),
          phase("external_review", "review", baseEffects(), [{ requirement_id: "R4", completeness: "complete", claim: "review" }], ["verify_all"],
            plan(["build_feature", "verify_all"], "review", "ok", "findings", "notes")),
        ],
        dispositions: [],
        decomposition_evidence: ["rename invariance proof (C5)"],
      },
    ],
    known_invalid_examples: [
      { id: "E9-invalid-1", category: "missing requirement", mutation: { op: "drop_coverage", requirement_id: "R3" }, note: "H4" },
      { id: "E9-invalid-2", category: "wrong dependency", mutation: { op: "remove_edge", from: "test", to: "impl" }, note: "ordering" },
      { id: "E9-invalid-3", category: "wrong purpose/effect", mutation: { op: "change_purpose", phase_id: "foundation", to: "implementation" }, note: "R1 requires analysis" },
      { id: "E9-invalid-4", category: "evidence gap", mutation: { op: "clear_verification_plan", phase_id: "test" }, note: "H9" },
    ],
    source_ambiguities: ["execution-conformance case; evaluated by case contract semantics (X-6/C2)"],
    controller_overrides: ["C2"],
  },

  {
    case_id: "E10",
    expected_verdict: "DECOMPOSED",
    requirements: [
      { requirement_id: "R1", text: "audit baseline" },
      { requirement_id: "R2", text: "實作" },
      { requirement_id: "R3", text: "review" },
    ],
    allowed_purposes: ["analysis", "implementation", "review"],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSED" },
      { type: "req_purpose", requirement_id: "R1", purposes: ["analysis"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R2", purposes: ["implementation"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R3", purposes: ["review"], completeness: "complete" },
      { type: "ordering", before_purposes: ["analysis"], after_purposes: ["implementation"] },
      { type: "ordering", before_purposes: ["implementation"], after_purposes: ["review"] },
      // Card 5B：移除 no_phase_purpose verification（fixture shape 而非來源責任；降為 quality_preference）
    ],
    quality_preferences: ["reference shape 無 verification phase；額外合法 verification phase 不使 correctness 失敗（advisory A-5 記錄）"],
    production_markers: [],
    accepted_examples: [
      {
        verdict: "DECOMPOSED",
        parent_goal: "3-phase resume-conformance DAG",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [
          phase("audit", "analysis", baseEffects(), [{ requirement_id: "R1", completeness: "complete", claim: "baseline" }], []),
          phase("impl", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R2", completeness: "complete", claim: "implement" }], ["audit"]),
          phase("review", "review", baseEffects(), [{ requirement_id: "R3", completeness: "complete", claim: "review" }], ["impl"],
            plan(["impl"], "review", "ok", "findings", "notes")),
        ],
        dispositions: [],
        decomposition_evidence: ["no verification phase per case contract (C2)"],
      },
    ],
    known_invalid_examples: [
      // Card 5B：無來源禁止 verification phase；改以 wrong purpose 驗證 req_purpose 攔截
      { id: "E10-invalid-1", category: "wrong purpose", mutation: { op: "change_purpose", phase_id: "impl", to: "analysis" }, note: "R2 requires implementation; req_purpose" },
      { id: "E10-invalid-2", category: "missing requirement", mutation: { op: "drop_coverage", requirement_id: "R2" }, note: "H4" },
    ],
    source_ambiguities: ["no verification card vs E6 (X-2); resolved by case contract"],
    controller_overrides: ["C2"],
  },

  {
    case_id: "E11",
    expected_verdict: "DECOMPOSITION_NOT_BENEFICIAL",
    requirements: [],
    allowed_purposes: [],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSITION_NOT_BENEFICIAL" },
    ],
    quality_preferences: [],
    production_markers: [],
    accepted_examples: [{
      verdict: "DECOMPOSITION_NOT_BENEFICIAL",
      reason: "3-line helper in single file; no benefit from decomposition.",
      decomposition_evidence: ["single file, single change, no cross-module dependency"],
    }],
    known_invalid_examples: [
      { id: "E11-invalid-1", category: "not_beneficial with dispositions", mutation: { op: "change_verdict", to: "DECOMPOSITION_NOT_BENEFICIAL" }, note: "requires reason/evidence (H1)" },
    ],
    source_ambiguities: ["NOT_BENEFICIAL boundary (O-5; C3)"],
    controller_overrides: ["C3"],
  },

  {
    case_id: "E12",
    expected_verdict: "DECOMPOSED",
    requirements: [
      { requirement_id: "R1", text: "實作功能 X" },
      { requirement_id: "R2", text: "使用 Claude 執行、OpenCode review、DeepSeek 測試" },
    ],
    allowed_purposes: ["analysis", "implementation", "verification", "review"],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSED" },
      { type: "req_purpose", requirement_id: "R1", purposes: ["implementation", "analysis"], completeness: "complete" },
      { type: "disposition", requirement_id: "R2", disposition: "deferred", reason_code: "MULTI_MODEL_ORCHESTRATION_FORBIDDEN" },
    ],
    quality_preferences: ["1-5 phases acceptable"],
    production_markers: [],
    accepted_examples: [
      {
        verdict: "DECOMPOSED",
        parent_goal: "Implement feature X; multi-model orchestration forbidden",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        phases: [
          phase("impl_x", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
            { boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] } }),
            [{ requirement_id: "R1", completeness: "complete", claim: "implement" }], []),
        ],
        dispositions: [disp("R2", "deferred", "MULTI_MODEL_ORCHESTRATION_FORBIDDEN", { reason: "single-model policy" })],
        decomposition_evidence: ["execution_policy locked"],
      },
    ],
    known_invalid_examples: [
      { id: "E12-invalid-1", category: "invalid disposition code", mutation: { op: "change_disposition", requirement_id: "R2", to: "unresolved", reason_code: "CYCLIC_DEPENDENCY" }, note: "H8" },
      { id: "E12-invalid-2", category: "missing requirement", mutation: { op: "drop_coverage", requirement_id: "R1" }, note: "H4" },
    ],
    source_ambiguities: [],
    controller_overrides: [],
  },
];

export const CASE_CONTRACTS = Object.freeze(attachProvenance(RAW_CASE_CONTRACTS));

export const CONTRACTS_BY_ID = Object.freeze(
  Object.fromEntries(CASE_CONTRACTS.map(c => [c.case_id, c])),
);
