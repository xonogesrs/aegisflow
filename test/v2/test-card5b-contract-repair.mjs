// test/v2/test-card5b-contract-repair.mjs
// V2 Card 5B — case-contract repair 驗證：provenance 完整性、E2 review gate 移除、
// Card 5 raw IR deterministic replay、E2 counterfactuals、generic evaluator taxonomy。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CASE_CONTRACTS, CONTRACTS_BY_ID, applyMutation, PROVENANCE_CLASSIFICATIONS, UNSUPPORTED_PROVENANCE_TERMS } from "../../src/v2/case-contracts.mjs";
import { evaluateCase, FAILURE_CODES } from "../../src/v2/case-evaluator.mjs";
import { evaluateScorecardV2 } from "../../src/v2/scorecard-v2.mjs";

const PARENT = { scope: { allowed_paths: ["src/", "test/", "migrations/", "src/auth/", "src/email/", "src/utils/helper.js", "test/utils/"], forbidden_paths: [] } };

function evalWith(ir, caseId, opts = {}) {
  const c = CONTRACTS_BY_ID[caseId];
  const manifest = opts.manifest ?? c.requirements;
  return evaluateScorecardV2(ir, { parent: PARENT, manifest, contract: c });
}

const E2 = CONTRACTS_BY_ID.E2;
const REF4 = structuredClone(E2.accepted_examples[0]); // 4-phase（audit/extract/test/review）
const REF5 = structuredClone(E2.accepted_examples[1]); // 5-phase

function eff(a, r = "forbidden", ext = "forbidden", ev = "none", extra = {}) {
  return {
    artifact_mutation: a, runtime_side_effect: r, external_system_mutation: ext, evidence_output: ev,
    boundaries: { artifact: a !== "forbidden" ? ["src/auth/"] : [], runtime: [], external_system: [], evidence: [] },
    ...extra,
  };
}

// ── Card 5 live raw IR（frozen evidence）──
const LIVE_EVIDENCE_PATH = "/Volumes/NVM2T/Development/AutoLoopEvidence/card-5-live-probe-2026-08-02T15-43-49-242Z/evidence.json";
function liveE2IR() {
  const ev = JSON.parse(readFileSync(LIVE_EVIDENCE_PATH, "utf8"));
  return ev.cases[0].parsed_ir;
}

// ══ Stage 1/3 — provenance 完整性 ══

test("所有 E1–E12 hard assertions 具備有效 provenance", () => {
  for (const c of CASE_CONTRACTS) {
    for (const inv of c.invariants) {
      assert.ok(inv.provenance, `${c.case_id} ${inv.type}: missing provenance`);
      assert.ok(inv.provenance.id, `${c.case_id} ${inv.type}: missing provenance.id`);
      assert.ok(PROVENANCE_CLASSIFICATIONS.includes(inv.provenance.classification), `${c.case_id} ${inv.type}: bad classification ${inv.provenance.classification}`);
      assert.ok(inv.provenance.source_reference && inv.provenance.source_reference.trim().length > 0, `${c.case_id} ${inv.type}: missing source_reference`);
      assert.ok(inv.provenance.description && inv.provenance.description.trim().length > 0, `${c.case_id} ${inv.type}: missing description`);
      assert.ok(Array.isArray(inv.provenance.requirement_ids), `${c.case_id} ${inv.type}: requirement_ids must be array`);
    }
  }
});

test("provenance source_reference 不含不合格來源（fixture shape/edge set/canonical role/matcher/substring）", () => {
  for (const c of CASE_CONTRACTS) {
    for (const inv of c.invariants) {
      const ref = inv.provenance.source_reference;
      for (const term of UNSUPPORTED_PROVENANCE_TERMS) {
        assert.ok(!ref.includes(term), `${c.case_id} ${inv.type}: source_reference cites unsupported term "${term}": ${ref}`);
      }
    }
  }
});

test("不存在 E2 review hard gate", () => {
  const s = JSON.stringify(E2.invariants);
  assert.ok(!s.includes("review"), "E2 must not require review purpose/ordering");
  assert.ok(!s.includes('after_purposes: ["review"]'));
});

test("不存在無 requirement ID 的 hard purpose existence gate（required_purpose type 未被 E1–E12 使用）", () => {
  for (const c of CASE_CONTRACTS) {
    assert.ok(!c.invariants.some(i => i.type === "required_purpose"), `${c.case_id}: required_purpose without requirement IDs`);
    assert.ok(!c.invariants.some(i => i.type === "phase_count"), `${c.case_id}: phase_count shape gate without source justification`);
  }
});

test("不存在由 fixture phase shape 生成的 hard ordering（E2 已移除 verification→review）", () => {
  const ord = E2.invariants.filter(i => i.type === "ordering");
  assert.deepEqual(ord.map(o => o.before_purposes.join("+") + "->" + o.after_purposes.join("+")), ["analysis->implementation", "implementation->verification"]);
});

// ══ Stage 2 — E2 repair 驗證 ══

test("Card 5 E2 raw IR deterministic replay → PASS（模型語意成功、oracle 誤拒已修）", () => {
  const ir = liveE2IR();
  const r = evalWith(ir, "E2");
  assert.equal(r.verdict, "PASS", `Card 5 raw IR must PASS repaired E2 contract — ${r.hardFailures.join("; ")}`);
});

// ══ Stage 5 — E2 counterfactuals ══

test("CF1: Card 5 live 三 phase＋R4 deferred → PASS", () => {
  assert.equal(evalWith(liveE2IR(), "E2").verdict, "PASS");
});

test("CF2: 五 phase audit/extract/add tests/run tests/review → PASS", () => {
  assert.equal(evalWith(REF5, "E2").verdict, "PASS");
});

test("CF3: 修正後四 phase reference → PASS", () => {
  assert.equal(evalWith(REF4, "E2").verdict, "PASS");
});

test("CF4: 無 review → PASS", () => {
  const ir = structuredClone(REF4);
  ir.phases = ir.phases.filter(p => p.purpose !== "review");
  assert.equal(evalWith(ir, "E2").verdict, "PASS", "missing review must not hard-fail E2");
});

test("CF5: 額外 review 且 dependency 正確 → PASS", () => {
  assert.equal(evalWith(REF4, "E2").verdict, "PASS");
});

test("CF6: 額外 review 且 verification plan subject 不存在 → HOLD (H9)", () => {
  const ir = structuredClone(REF4);
  const rev = ir.phases.find(p => p.purpose === "review");
  rev.verification_plan.subject_phase_ids = ["ghost_phase"];
  const r = evalWith(ir, "E2");
  assert.equal(r.verdict, "HOLD");
  assert.ok(r.hardFailures.some(h => /H9/.test(h)));
});

test("CF7: title 含 review、purpose 非 review → 不影響 correctness（PASS）", () => {
  const ir = structuredClone(REF4);
  const rev = ir.phases.find(p => p.purpose === "review");
  rev.title = "final_review"; // title 保留 review 字樣
  rev.purpose = "analysis";   // purpose 改變 → 不再是 review phase（extra analysis phase）
  rev.effects = eff("forbidden");
  rev.depends_on = ["extract_common_logic"];
  delete rev.verification_plan;
  const r = evalWith(ir, "E2");
  assert.equal(r.verdict, "PASS", "title text must never drive purpose (C5)");
});

test("CF8: test authoring 與 review 合併但責任完整 → 依 effects/H9 判定，不得因缺獨立 review phase 失敗", () => {
  const ir = structuredClone(REF4);
  const testPhase = ir.phases.find(p => p.purpose === "verification");
  ir.phases = ir.phases.filter(p => p.purpose !== "review");
  testPhase.responsibility += "；並執行最終 review";
  const r = evalWith(ir, "E2");
  assert.equal(r.verdict, "PASS", "merge of review into verification must not fail for missing independent review");
});

test("CF9: R3 缺漏 → HOLD / REQUIRED_RESPONSIBILITY_UNCOVERED", () => {
  const ir = applyMutation(REF4, { op: "drop_coverage", requirement_id: "R3" });
  const r = evalWith(ir, "E2");
  assert.equal(r.verdict, "HOLD");
  assert.ok(r.caseCodes?.includes(FAILURE_CODES.RESPONSIBILITY_UNCOVERED) || r.hardFailures.some(h => /H4/.test(h)),
    "R3 uncovered must be classified as responsibility-uncovered (H4)");
});

test("CF10: R4 被標 actionable commit → HOLD / REQUIRED_DISPOSITION_MISSING", () => {
  const ir = structuredClone(REF4);
  // R4 被 phase complete 覆蓋（當成可執行 commit）而非 deferred
  ir.phases.push({
    phase_id: "commit_results", title: "commit", summary: "commit results", responsibility: "commit results",
    purpose: "operation",
    effects: { artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
      evidence_output: "none", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] } },
    covers: [{ requirement_id: "R4", completeness: "complete", claim: "commit results" }],
    depends_on: ["add_and_run_unit_tests"],
  });
  ir.dispositions = ir.dispositions.filter(d => d.requirement_id !== "R4");
  const r = evalWith(ir, "E2");
  assert.equal(r.verdict, "HOLD");
  assert.ok(r.caseCodes?.includes(FAILURE_CODES.DISPOSITION_MISSING), "R4 must be deferred, not actionable");
});

test("CF11: R4 被標 unresolved → HOLD / REQUIRED_DISPOSITION_MISSING", () => {
  const ir = applyMutation(REF4, { op: "change_disposition", requirement_id: "R4", to: "unresolved", reason_code: "CYCLIC_DEPENDENCY" });
  const r = evalWith(ir, "E2");
  assert.equal(r.verdict, "HOLD");
  assert.ok(r.caseCodes?.includes(FAILURE_CODES.DISPOSITION_MISSING), "wrong disposition must be classified as disposition-missing");
});

test("CF12: test authoring artifact mutation forbidden → HOLD / INVALID_COVERAGE_CLAIM (C1)", () => {
  // 3-phase：R3 由 verification phase complete 覆蓋但 artifact=forbidden 且無 authoring 分支
  const ir = {
    verdict: "DECOMPOSED",
    parent_goal: "g",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [
      { phase_id: "p1", title: "p1", summary: "p1", responsibility: "analyze", purpose: "analysis",
        effects: eff("forbidden"), covers: [{ requirement_id: "R1", completeness: "complete", claim: "a" }], depends_on: [] },
      { phase_id: "p2", title: "p2", summary: "p2", responsibility: "extract", purpose: "implementation",
        effects: eff("required"), covers: [{ requirement_id: "R2", completeness: "complete", claim: "b" }], depends_on: ["p1"] },
      { phase_id: "p3", title: "p3", summary: "p3", responsibility: "run tests only", purpose: "verification",
        effects: { artifact_mutation: "forbidden", runtime_side_effect: "allowed", external_system_mutation: "forbidden",
          evidence_output: "none", boundaries: { artifact: [], runtime: ["test/auth/"], external_system: [], evidence: [] } },
        covers: [{ requirement_id: "R3", completeness: "complete", claim: "run tests" }], depends_on: ["p2"],
        verification_plan: { subject_phase_ids: ["p2"], method: "m", success_criteria: "s", failure_criteria: "f", evidence: "e" } },
    ],
    dispositions: [{ requirement_id: "R4", disposition: "deferred", reason_code: "COMMIT_NOT_AUTHORIZED", reason: "no commit" }],
    decomposition_evidence: ["e"],
  };
  const r = evalWith(ir, "E2");
  assert.equal(r.verdict, "HOLD");
  assert.ok(r.caseCodes?.includes(FAILURE_CODES.INVALID_COVERAGE), "execution-only coverage of R3 must be invalid (C1 authoring)");
});

// ══ Generic evaluator taxonomy ══

function fixtureContract(overrides = {}) {
  return {
    case_id: "GEN", expected_verdict: "DECOMPOSED",
    requirements: [
      { requirement_id: "R1", text: "analyze" },
      { requirement_id: "R2", text: "implement" },
      { requirement_id: "R3", text: "verify" },
    ],
    allowed_purposes: [],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSED" },
      { type: "req_purpose", requirement_id: "R1", purposes: ["analysis"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R2", purposes: ["implementation"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R3", purposes: ["verification"], completeness: "complete" },
      ...(overrides.invariants || []),
    ],
    quality_preferences: overrides.quality_preferences || [],
    production_markers: [], accepted_examples: [], known_invalid_examples: [],
    source_ambiguities: [], controller_overrides: [],
  };
}

function genIr(phases, dispositions = []) {
  return {
    verdict: "DECOMPOSED", parent_goal: "g",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases, dispositions, decomposition_evidence: ["e"],
  };
}
function gphase(id, purpose, covers, depends_on = [], plan) {
  const p = { phase_id: id, title: id, summary: id, responsibility: id, purpose,
    effects: purpose === "implementation" ? eff("required") : eff("forbidden"), covers, depends_on };
  if (plan) p.verification_plan = plan;
  return p;
}

const VERIFY_PLAN = { subject_phase_ids: ["impl"], method: "m", success_criteria: "s", failure_criteria: "f", evidence: "e" };

test("TAX-1: required ordering 的 before 缺失 → 不回報 REQUIRED_ORDERING_VIOLATION", () => {
  const c = fixtureContract({ invariants: [{ type: "ordering", before_purposes: ["analysis"], after_purposes: ["implementation"] }] });
  // 無 analysis phase（R1 未覆蓋 → H4 responsibility-uncovered）
  const ir = genIr([
    gphase("impl", "implementation", [{ requirement_id: "R2", completeness: "complete", claim: "x" }]),
    gphase("verify", "verification", [{ requirement_id: "R3", completeness: "complete", claim: "x" }], ["impl"], VERIFY_PLAN),
  ]);
  const r = evaluateScorecardV2(ir, { parent: PARENT, manifest: c.requirements, contract: c });
  assert.equal(r.verdict, "HOLD");
  assert.ok(!r.caseCodes?.includes(FAILURE_CODES.ORDERING_VIOLATION), "missing before must not be reported as ordering violation");
  assert.ok(r.hardFailures.some(h => /H4/.test(h)), "missing responsibility must surface via H4");
});

test("TAX-2: required ordering 的 after 缺失 → 不回報 REQUIRED_ORDERING_VIOLATION", () => {
  const c = fixtureContract({ invariants: [{ type: "ordering", before_purposes: ["implementation"], after_purposes: ["review"] }] });
  const ir = genIr([
    gphase("analyze", "analysis", [{ requirement_id: "R1", completeness: "complete", claim: "x" }]),
    gphase("impl", "implementation", [{ requirement_id: "R2", completeness: "complete", claim: "x" }], ["analyze"]),
    gphase("verify", "verification", [{ requirement_id: "R3", completeness: "complete", claim: "x" }], ["impl"], VERIFY_PLAN),
  ]);
  const r = evaluateScorecardV2(ir, { parent: PARENT, manifest: c.requirements, contract: c });
  assert.equal(r.verdict, "PASS", "optional after (review) missing → no failure（若來源不要求）");
  assert.ok(!r.caseCodes?.includes(FAILURE_CODES.ORDERING_VIOLATION));
});

test("TAX-3: before/after 均存在但無 dependency → REQUIRED_ORDERING_VIOLATION", () => {
  const c = fixtureContract({ invariants: [{ type: "ordering", before_purposes: ["analysis"], after_purposes: ["implementation"] }] });
  const ir = genIr([
    gphase("analyze", "analysis", [{ requirement_id: "R1", completeness: "complete", claim: "x" }]),
    gphase("impl", "implementation", [{ requirement_id: "R2", completeness: "complete", claim: "x" }]), // 無依賴
    gphase("verify", "verification", [{ requirement_id: "R3", completeness: "complete", claim: "x" }], ["impl"], VERIFY_PLAN),
  ]);
  const r = evaluateScorecardV2(ir, { parent: PARENT, manifest: c.requirements, contract: c });
  assert.equal(r.verdict, "HOLD");
  assert.ok(r.caseCodes?.includes(FAILURE_CODES.ORDERING_VIOLATION));
});

test("TAX-4: before/after ordering 正確 → PASS", () => {
  const c = fixtureContract({ invariants: [{ type: "ordering", before_purposes: ["analysis"], after_purposes: ["implementation"] }] });
  const ir = genIr([
    gphase("analyze", "analysis", [{ requirement_id: "R1", completeness: "complete", claim: "x" }]),
    gphase("impl", "implementation", [{ requirement_id: "R2", completeness: "complete", claim: "x" }], ["analyze"]),
    gphase("verify", "verification", [{ requirement_id: "R3", completeness: "complete", claim: "x" }], ["impl"], VERIFY_PLAN),
  ]);
  assert.equal(evaluateScorecardV2(ir, { parent: PARENT, manifest: c.requirements, contract: c }).verdict, "PASS");
});

test("TAX-5: optional after purpose 缺失 → 不 failure（若來源不要求）", () => {
  const c = fixtureContract({ invariants: [{ type: "ordering", before_purposes: ["verification"], after_purposes: ["review"] }] });
  const ir = genIr([
    gphase("analyze", "analysis", [{ requirement_id: "R1", completeness: "complete", claim: "x" }]),
    gphase("impl", "implementation", [{ requirement_id: "R2", completeness: "complete", claim: "x" }], ["analyze"]),
    gphase("verify", "verification", [{ requirement_id: "R3", completeness: "complete", claim: "x" }], ["impl"], VERIFY_PLAN),
  ]);
  const r = evaluateScorecardV2(ir, { parent: PARENT, manifest: c.requirements, contract: c });
  assert.equal(r.verdict, "PASS", "optional review missing → PASS（若無 required_purpose 或 requirement）");
});

test("TAX-6: required_purpose assertion 缺失 → REQUIRED_PURPOSE_MISSING", () => {
  const c = fixtureContract({ invariants: [{ type: "required_purpose", purposes: ["review"] }] });
  const ir = genIr([
    gphase("analyze", "analysis", [{ requirement_id: "R1", completeness: "complete", claim: "x" }]),
    gphase("impl", "implementation", [{ requirement_id: "R2", completeness: "complete", claim: "x" }], ["analyze"]),
    gphase("verify", "verification", [{ requirement_id: "R3", completeness: "complete", claim: "x" }], ["impl"], VERIFY_PLAN),
  ]);
  const r = evaluateScorecardV2(ir, { parent: PARENT, manifest: c.requirements, contract: c });
  assert.equal(r.verdict, "HOLD");
  assert.ok(r.caseCodes?.includes(FAILURE_CODES.PURPOSE_MISSING), "required review purpose missing → REQUIRED_PURPOSE_MISSING");
});

test("TAX-7: quality preference 不改變 hard verdict", () => {
  const c = fixtureContract({ quality_preferences: ["2-phase reference; 3-phase acceptable"] });
  const ir = genIr([
    gphase("analyze", "analysis", [{ requirement_id: "R1", completeness: "complete", claim: "x" }]),
    gphase("impl", "implementation", [{ requirement_id: "R2", completeness: "complete", claim: "x" }], ["analyze"]),
    gphase("verify", "verification", [{ requirement_id: "R3", completeness: "complete", claim: "x" }], ["impl"], VERIFY_PLAN),
  ]);
  const r = evaluateScorecardV2(ir, { parent: PARENT, manifest: c.requirements, contract: c });
  assert.equal(r.verdict, "PASS", "quality preferences never change hard verdict");
});

test("TAX-8: rename invariance（E9 改名）", () => {
  const ir = structuredClone(CONTRACTS_BY_ID.E9.accepted_examples[0]);
  const rename = { foundation: "a1", impl: "a2", test: "a3", review: "a4" };
  const mapId = (id) => rename[id] || id;
  ir.phases = ir.phases.map(p => ({
    ...p, phase_id: mapId(p.phase_id),
    depends_on: (p.depends_on || []).map(mapId),
    verification_plan: p.verification_plan ? { ...p.verification_plan, subject_phase_ids: (p.verification_plan.subject_phase_ids || []).map(mapId) } : undefined,
  }));
  const before = evalWith(CONTRACTS_BY_ID.E9.accepted_examples[0], "E9");
  const after = evalWith(ir, "E9");
  assert.equal(after.verdict, before.verdict, "rename invariance (C5)");
  assert.equal(after.verdict, "PASS");
});

test("TAX-9: split invariance（E2 4→5 phase）", () => {
  assert.equal(evalWith(REF4, "E2").verdict, "PASS");
  assert.equal(evalWith(REF5, "E2").verdict, "PASS");
});

test("TAX-10: merge invariance（E3 test+smoke 合併）", () => {
  const base = structuredClone(CONTRACTS_BY_ID.E3.accepted_examples[0]);
  const scripted = base.phases.find(p => p.phase_id === "scripted_tests");
  const smoke = base.phases.find(p => p.phase_id === "smoke");
  scripted.phase_id = "test_and_smoke";
  scripted.covers = [
    { requirement_id: "R3", completeness: "complete", claim: "scripted" },
    { requirement_id: "R4", completeness: "complete", claim: "smoke" },
  ];
  scripted.effects.artifact_mutation = "required";
  scripted.effects.runtime_side_effect = "allowed";
  scripted.effects.boundaries.runtime = ["test/"];
  scripted.verification_plan = { subject_phase_ids: ["impl"], method: "tests+smoke", success_criteria: "pass", failure_criteria: "fail", evidence: "log" };
  base.phases = base.phases.filter(p => p.phase_id !== "smoke");
  for (const p of base.phases) {
    p.depends_on = (p.depends_on || []).map(d => d === "smoke" || d === "scripted_tests" ? "test_and_smoke" : d);
    if (p.verification_plan) p.verification_plan.subject_phase_ids = (p.verification_plan.subject_phase_ids || []).map(s => s === "smoke" || s === "scripted_tests" ? "test_and_smoke" : s);
  }
  const r = evalWith(base, "E3");
  assert.equal(r.verdict, "PASS", "merge invariance — " + r.hardFailures.join("; "));
});

test("E3 review requirement 仍為 SOURCE（R5 明文）——對照組", () => {
  const c = CONTRACTS_BY_ID.E3;
  const r5 = c.invariants.find(i => i.type === "req_purpose" && i.requirement_id === "R5");
  assert.ok(r5, "E3 must retain review requirement R5");
  assert.equal(r5.provenance.classification, "SOURCE_DERIVED");
  assert.match(r5.provenance.source_reference, /R5/);
});
