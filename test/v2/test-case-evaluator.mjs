// test/v2/test-case-evaluator.mjs
// Case-contract evaluator v2 — E1–E12 reference/rename/split/merge、
// 所有 known-invalid categories、E2/E6/E9/E10 關鍵驗證、cross-repo（D-16）、
// equivalence invariants（Step 8）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { CASE_CONTRACTS, CONTRACTS_BY_ID, applyMutation } from "../../src/v2/case-contracts.mjs";
import { evaluateCase } from "../../src/v2/case-evaluator.mjs";
import { evaluateScorecardV2 } from "../../src/v2/scorecard-v2.mjs";

const PARENT = { scope: { allowed_paths: ["src/", "test/", "migrations/", "src/auth/", "src/email/", "src/utils/helper.js", "test/utils/"], forbidden_paths: [] } };

function evalWith(ir, caseId, manifestOverride) {
  const c = CONTRACTS_BY_ID[caseId];
  const manifest = manifestOverride ?? c.requirements;
  return evaluateScorecardV2(ir, { parent: PARENT, manifest, contract: c });
}

// ── E1–E12 reference examples 全部 PASS（NOT_BENEFICIAL 案得 NOT_BENEFICIAL verdict）──
test("E1–E12 reference accepted examples all PASS", () => {
  for (const c of CASE_CONTRACTS) {
    for (const ex of c.accepted_examples) {
      const r = evalWith(ex, c.case_id);
      const expectNb = c.expected_verdict === "DECOMPOSITION_NOT_BENEFICIAL";
      const expected = expectNb ? "NOT_BENEFICIAL" : "PASS";
      assert.equal(r.verdict, expected,
        `${c.case_id} reference: got ${r.verdict} want ${expected} — ${r.hardFailures.join("; ")}`);
    }
  }
});

// ── E2：五 phase 與四 phase 皆 PASS；legacy 矛盾 FAIL ──
test("E2 five-phase split PASS (3.6D shape, C1)", () => {
  const ir = CONTRACTS_BY_ID.E2.accepted_examples[1]; // 5-phase
  const r = evalWith(ir, "E2");
  assert.equal(r.verdict, "PASS", r.hardFailures.join("; "));
});

test("E2 corrected four-phase PASS", () => {
  const ir = CONTRACTS_BY_ID.E2.accepted_examples[0]; // 4-phase corrected
  const r = evalWith(ir, "E2");
  assert.equal(r.verdict, "PASS", r.hardFailures.join("; "));
});

test("E2 legacy mutation contradiction FAIL (write tests + mutation forbidden)", () => {
  const ir = applyMutation(CONTRACTS_BY_ID.E2.accepted_examples[0],
    { op: "change_effect", phase_id: "add_and_run_unit_tests", field: "artifact_mutation", to: "forbidden" });
  // 4-phase：add_and_run_unit_tests covers R3 (verification)。artifact=forbidden 但 R3 需撰寫測試。
  // H6 表中 verification+artifact=forbidden 是合法組合 → 但 case invariant req_purpose R3 需 verification complete —
  // 此 mutation 下 R3 仍由 verification complete 覆蓋 → PASS？必須驗證「legacy 矛盾」被攔。
  // 真正攔截點：C1 語意 — 由 known_invalid_examples 的 E2-invalid-8 模式判定：
  const r = evalWith(ir, "E2");
  // 4-phase 合併卡 artifact=forbidden 無法表達「寫測試」→ 依 C1 屬 invalid；
  // 但機械上需以 invariant 表達。此處用 contract 的 E2-invalid-8 宣告驗證 mutation 被拒：
  const invalid8 = applyMutation(CONTRACTS_BY_ID.E2.accepted_examples[0],
    { op: "change_effect", phase_id: "add_and_run_unit_tests", field: "artifact_mutation", to: "forbidden" });
  // 我們要求 evalWith 判定為 HOLD 或至少與 accepted 不同：直接斷言此 shape 不等同 5-phase 語意 —
  // 實際上 reference 4-phase 已把該卡標 allowed。使 forbidden 版本落入「非 accepted」：
  const ref = evalWith(CONTRACTS_BY_ID.E2.accepted_examples[0], "E2");
  const legacyMut = evalWith(invalid8, "E2");
  // 若 reference 用 allowed（PASS），forbidden 版本不應與 reference 相同語意——
  // 以「reference 4-phase 明確宣告 artifact=allowed」為準：forbidden 版不屬於 accepted examples。
  assert.equal(ref.verdict, "PASS");
  // 機械判定：forbidden 版違反 E2 的 C1 不變量（contract 層 declarative check）
  const e2Invalid8 = CONTRACTS_BY_ID.E2.known_invalid_examples.find(x => x.id === "E2-invalid-8");
  const mut = applyMutation(CONTRACTS_BY_ID.E2.accepted_examples[0], e2Invalid8.mutation);
  const r8 = evalWith(mut, "E2");
  // 若 evaluator 未能攔截（PASS），需新增 explicit invariant 攔截——測試即驗證器：
  assert.equal(r8.verdict, "HOLD", "E2 legacy mutation contradiction must be rejected");
});

// ── E2 known-invalid 8 類別全拒 ──
test("E2 all known-invalid categories rejected", () => {
  const base = CONTRACTS_BY_ID.E2.accepted_examples[0];
  for (const inv of CONTRACTS_BY_ID.E2.known_invalid_examples) {
    const mut = applyMutation(base, inv.mutation);
    const r = evalWith(mut, "E2");
    assert.equal(r.verdict, "HOLD", `E2 ${inv.id} (${inv.category}) should HOLD, got ${r.verdict} — ${r.hardFailures.join("; ")}`);
  }
});

// ── E3 known-invalid ──
test("E3 known-invalid categories rejected", () => {
  const base = CONTRACTS_BY_ID.E3.accepted_examples[0];
  for (const inv of CONTRACTS_BY_ID.E3.known_invalid_examples) {
    const mut = applyMutation(base, inv.mutation);
    const r = evalWith(mut, "E3");
    assert.equal(r.verdict, "HOLD", `E3 ${inv.id} should HOLD, got ${r.verdict} — ${r.hardFailures.join("; ")}`);
  }
});

// ── E4：production 判 out_of_scope；deferred 被拒；no_production_boundary ──
test("E4 reference PASS (R3 out_of_scope, C4)", () => {
  const r = evalWith(CONTRACTS_BY_ID.E4.accepted_examples[0], "E4");
  assert.equal(r.verdict, "PASS", r.hardFailures.join("; "));
});

test("E4 production boundary declared → FAIL", () => {
  const base = CONTRACTS_BY_ID.E4.accepted_examples[0];
  const mut = applyMutation(base, { op: "add_production_boundary", phase_id: "offline_validation" });
  const r = evalWith(mut, "E4");
  assert.equal(r.verdict, "HOLD", "production boundary must be rejected");
});

test("E4 R3 deferred instead of out_of_scope → FAIL (C4/D-15)", () => {
  const base = CONTRACTS_BY_ID.E4.accepted_examples[0];
  const mut = applyMutation(base, { op: "change_disposition", requirement_id: "R3", to: "deferred", reason_code: "PRODUCTION_RUNTIME_OUT_OF_SCOPE" });
  const r = evalWith(mut, "E4");
  assert.equal(r.verdict, "HOLD");
});

// ── E5 cross-repo：D-16 五情境 ──
test("E5 reference PASS (deferred with target, D-16)", () => {
  const r = evalWith(CONTRACTS_BY_ID.E5.accepted_examples[0], "E5");
  assert.equal(r.verdict, "PASS", r.hardFailures.join("; "));
});

test("E5 cross-repo claimed actionable → FAIL (D-16)", () => {
  const base = CONTRACTS_BY_ID.E5.accepted_examples[0];
  const mut = applyMutation(base, CONTRACTS_BY_ID.E5.known_invalid_examples[0].mutation);
  const r = evalWith(mut, "E5");
  assert.equal(r.verdict, "HOLD");
});

test("cross-repo actionable when explicitly in scope (D-16 table)", () => {
  // 多 repo 明確包含於目前 scope 且已授權 → actionable
  const ir = {
    verdict: "DECOMPOSED",
    parent_goal: "multi-repo in scope",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [{
      phase_id: "sync_both", title: "s", summary: "s", responsibility: "update both repos",
      purpose: "implementation",
      effects: { artifact_mutation: "required", runtime_side_effect: "forbidden",
        external_system_mutation: "forbidden", evidence_output: "none",
        boundaries: { artifact: ["src/", "../other-repo/src/"], runtime: [], external_system: [], evidence: [] } },
      covers: [{ requirement_id: "R1", completeness: "complete", claim: "feature" },
        { requirement_id: "R2", completeness: "complete", claim: "other repo" }],
      depends_on: [],
    }],
    dispositions: [],
    decomposition_evidence: ["multi-repo explicitly in authorized scope (D-16 → actionable)"],
  };
  // parent scope 需含兩 repo（以 test parent 近似；此處用 contract E5 但覆蓋 R2 → invariant 要求 deferred → HOLD 是預期：
  // 在 E5 contract 下 R2 必須 deferred。因此改用自訂 contract 驗證「actionable 合法」：
  const c = {
    case_id: "X-REPO-ACTIONABLE", expected_verdict: "DECOMPOSED",
    requirements: [
      { requirement_id: "R1", text: "repo A feature" },
      { requirement_id: "R2", text: "repo B docs (in scope)" },
    ],
    allowed_purposes: ["implementation"],
    invariants: [
      { type: "verdict", verdict: "DECOMPOSED" },
      { type: "req_purpose", requirement_id: "R1", purposes: ["implementation"], completeness: "complete" },
      { type: "req_purpose", requirement_id: "R2", purposes: ["implementation"], completeness: "complete" },
    ],
    quality_preferences: [], production_markers: [],
    accepted_examples: [], known_invalid_examples: [], source_ambiguities: [], controller_overrides: ["D-16"],
  };
  const r = evaluateScorecardV2(ir, { parent: { scope: { allowed_paths: ["src/", "../other-repo/"], forbidden_paths: [] } }, manifest: c.requirements, contract: c });
  assert.equal(r.verdict, "PASS", r.hardFailures.join("; "));
});

// ── E6：email verification 功能 vs 流程驗證 ──
test("E6 reference PASS (R5 email verification = implementation feature)", () => {
  const r = evalWith(CONTRACTS_BY_ID.E6.accepted_examples[0], "E6");
  assert.equal(r.verdict, "PASS", r.hardFailures.join("; "));
});

test("E6 substring trap: R5 covered by verification without subject → FAIL (H9)", () => {
  const base = CONTRACTS_BY_ID.E6.accepted_examples[0];
  const mut = applyMutation(base, CONTRACTS_BY_ID.E6.known_invalid_examples[0].mutation); // p2 → verification
  const r = evalWith(mut, "E6");
  assert.equal(r.verdict, "HOLD");
});

test("E6 no substring inference: phase titled with 'verification' but purpose=implementation passes", () => {
  const ir = structuredClone(CONTRACTS_BY_ID.E6.accepted_examples[0]);
  ir.phases[1].title = "implement email verification feature"; // 標題含 verification 但 purpose=implementation
  const r = evalWith(ir, "E6");
  assert.equal(r.verdict, "PASS", "title text must never influence purpose (no substring inference)");
});

// ── E9/E10：無 role dictionary ──
test("E9 reference + rename-equivalent both PASS (C2)", () => {
  for (const ex of CONTRACTS_BY_ID.E9.accepted_examples) {
    const r = evalWith(ex, "E9");
    assert.equal(r.verdict, "PASS", r.hardFailures.join("; "));
  }
});

test("E10 reference PASS; wrong purpose FAIL; extra verification phase not hard (Card 5B)", () => {
  const r = evalWith(CONTRACTS_BY_ID.E10.accepted_examples[0], "E10");
  assert.equal(r.verdict, "PASS", r.hardFailures.join("; "));
  // wrong purpose（impl→analysis）→ req_purpose R2 implementation 失敗
  const mut = applyMutation(CONTRACTS_BY_ID.E10.accepted_examples[0], CONTRACTS_BY_ID.E10.known_invalid_examples[0].mutation);
  const r2 = evalWith(mut, "E10");
  assert.equal(r2.verdict, "HOLD");
  // Card 5B：額外合法 verification phase（無來源禁止）不使 correctness 失敗
  const extra = structuredClone(CONTRACTS_BY_ID.E10.accepted_examples[0]);
  extra.phases.push({
    phase_id: "v", title: "v", summary: "v", responsibility: "verify", purpose: "verification",
    effects: { artifact_mutation: "forbidden", runtime_side_effect: "allowed", external_system_mutation: "forbidden",
      evidence_output: "none", boundaries: { artifact: [], runtime: ["src/"], external_system: [], evidence: [] } },
    covers: [], depends_on: ["impl"],
    verification_plan: { subject_phase_ids: ["impl"], method: "test", success_criteria: "pass", failure_criteria: "fail", evidence: "log" },
  });
  const r3 = evalWith(extra, "E10");
  assert.equal(r3.verdict, "PASS", "extra valid verification phase must not hard-fail E10 (no_phase_purpose downgraded to advisory)");
});

// ── Equivalence：rename / split / merge ──
test("rename invariance: renaming phase_ids + refs does not change verdict", () => {
  const ir = structuredClone(CONTRACTS_BY_ID.E9.accepted_examples[0]);
  const rename = { audit: "a1", impl: "a2", test: "a3", review: "a4" };
  const mapId = (id) => rename[id] || id;
  ir.phases = ir.phases.map(p => ({
    ...p, phase_id: mapId(p.phase_id),
    depends_on: (p.depends_on || []).map(mapId),
    verification_plan: p.verification_plan ? { ...p.verification_plan, subject_phase_ids: (p.verification_plan.subject_phase_ids || []).map(mapId) } : undefined,
  }));
  const before = evalWith(CONTRACTS_BY_ID.E9.accepted_examples[0], "E9");
  const after = evalWith(ir, "E9");
  assert.equal(after.verdict, before.verdict, "rename must not change correctness (C5)");
});

test("valid split: E2 5-phase (split of 4-phase) passes", () => {
  // reference 4-phase split into 5-phase = accepted_examples[1]
  const four = evalWith(CONTRACTS_BY_ID.E2.accepted_examples[0], "E2");
  const five = evalWith(CONTRACTS_BY_ID.E2.accepted_examples[1], "E2");
  assert.equal(four.verdict, "PASS");
  assert.equal(five.verdict, "PASS", "split invariance (D-13)");
});

test("split missing branch → FAIL (complete frontier without partial branch dependency)", () => {
  // 5-phase 中 run_unit_tests 是 R3 frontier；移除 add_unit_tests → R3 無 partial 分支亦無 frontier
  const base = CONTRACTS_BY_ID.E2.accepted_examples[1];
  const mut = applyMutation(base, { op: "remove_phase", phase_id: "add_unit_tests" });
  const r = evalWith(mut, "E2");
  assert.equal(r.verdict, "HOLD");
});

test("split implicit join attempt → FAIL (no-op barrier)", () => {
  const base = CONTRACTS_BY_ID.E2.accepted_examples[1];
  // 加入純 no-op join barrier 作為 R3 的 complete frontier（無責任、無 plan）
  const mut = applyMutation(base, {
    op: "add_noop_join", phase_id: "noop_join", requirement_id: "R3", branches: ["add_unit_tests"],
  });
  // 同時把原 run_unit_tests 的 R3 partial 移除?（noop join 自帶 complete）
  const r = evalWith(mut, "E2");
  // no-op barrier 因無責任/無 plan 被 D-13 攔截
  assert.equal(r.verdict, "HOLD");
});

test("valid merge: E3 test+smoke merged still passes", () => {
  const base = CONTRACTS_BY_ID.E3.accepted_examples[0];
  // merge scripted_tests + smoke → 單一 verification phase（effects allowed+runtime）
  const merged = structuredClone(base);
  const scripted = merged.phases.find(p => p.phase_id === "scripted_tests");
  const smoke = merged.phases.find(p => p.phase_id === "smoke");
  scripted.phase_id = "test_and_smoke";
  scripted.covers = [
    { requirement_id: "R3", completeness: "complete", claim: "scripted" },
    { requirement_id: "R4", completeness: "complete", claim: "smoke" },
  ];
  scripted.effects.artifact_mutation = "required";
  scripted.effects.runtime_side_effect = "allowed";
  scripted.effects.boundaries.runtime = ["test/"];
  scripted.verification_plan = { subject_phase_ids: ["impl"], method: "tests+smoke", success_criteria: "pass", failure_criteria: "fail", evidence: "log" };
  merged.phases = merged.phases.filter(p => p.phase_id !== "smoke");
  for (const p of merged.phases) {
    p.depends_on = (p.depends_on || []).map(d => d === "smoke" ? "test_and_smoke" : d === "scripted_tests" ? "test_and_smoke" : d);
    if (p.verification_plan) p.verification_plan.subject_phase_ids = (p.verification_plan.subject_phase_ids || []).map(s => s === "scripted_tests" ? "test_and_smoke" : s === "smoke" ? "test_and_smoke" : s);
  }
  const r = evalWith(merged, "E3");
  assert.equal(r.verdict, "PASS", "merge invariance — " + r.hardFailures.join("; "));
});

test("merge effect contradiction → FAIL (review merged with mutation, H6)", () => {
  const base = structuredClone(CONTRACTS_BY_ID.E3.accepted_examples[0]);
  // 合併產生矛盾的 effect：review phase 帶 artifact_mutation=required → H6 表拒絕
  const review = base.phases.find(p => p.phase_id === "review");
  review.effects.artifact_mutation = "required";
  review.effects.boundaries.artifact = ["src/"];
  const r = evalWith(base, "E3");
  assert.equal(r.verdict, "HOLD");
});

// ── NOT_BENEFICIAL ──
test("E1/E11 NOT_BENEFICIAL PASS", () => {
  assert.equal(evalWith(CONTRACTS_BY_ID.E1.accepted_examples[0], "E1").verdict, "NOT_BENEFICIAL");
  assert.equal(evalWith(CONTRACTS_BY_ID.E11.accepted_examples[0], "E11").verdict, "NOT_BENEFICIAL");
});

test("E8 BLOCKED PASS", () => {
  assert.equal(evalWith(CONTRACTS_BY_ID.E8.accepted_examples[0], "E8").verdict, "PASS");
});

// ── Advisory 分離 ──
test("advisory metrics do not fail correctness", () => {
  const r = evalWith(CONTRACTS_BY_ID.E2.accepted_examples[1], "E2"); // 5-phase
  assert.equal(r.verdict, "PASS");
  assert.ok(Array.isArray(r.advisory) && r.advisory.length > 0, "advisory must be present");
  assert.ok(r.advisory.every(a => typeof a.metric === "string"));
});
