// test/v2/test-ir-schema.mjs
// IR Schema v2 — 純結構檢查測試（Step 8：schema and structure）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIRShape, PURPOSES, DISPOSITION_VALUES } from "../../src/v2/ir-schema.mjs";

function baseEffects(artifact = "forbidden", runtime = "forbidden", external = "forbidden",
  evidence = "none", extra = {}) {
  return {
    artifact_mutation: artifact, runtime_side_effect: runtime,
    external_system_mutation: external, evidence_output: evidence,
    boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
    ...extra,
  };
}

function basePhase(over = {}) {
  return {
    phase_id: "p1", title: "p1", summary: "p1", responsibility: "p1",
    purpose: "implementation",
    effects: baseEffects("required", "forbidden", "forbidden", "none",
      { boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] } }),
    covers: [{ requirement_id: "R1", completeness: "complete", claim: "x" }],
    depends_on: [],
    ...over,
  };
}

function baseIR(over = {}) {
  return {
    verdict: "DECOMPOSED",
    parent_goal: "g",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [basePhase()],
    dispositions: [],
    decomposition_evidence: ["e"],
    ...over,
  };
}

test("valid IR passes", () => {
  const r = validateIRShape(baseIR());
  assert.equal(r.valid, true, r.errors.join("; "));
});

test("unknown top-level field rejected", () => {
  const r = validateIRShape(baseIR({ surprise: 1 }));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("unknown top-level field")));
});

test("unknown phase field rejected", () => {
  const ir = baseIR();
  ir.phases[0].role_id = "legacy_role";
  const r = validateIRShape(ir);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("unknown phase field")));
});

test("duplicate phase id rejected (structure level)", () => {
  const ir = baseIR({ phases: [basePhase(), basePhase()] });
  // duplicate 由 H2 查；schema 層不查重複，但兩 phase 皆需合法 → valid（重複檢查在 H2）
  const r = validateIRShape(ir);
  assert.equal(r.valid, true);
});

test("invalid purpose rejected", () => {
  const ir = baseIR();
  ir.phases[0].purpose = "analysis_x";
  const r = validateIRShape(ir);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("purpose")));
});

test("invalid effect value rejected", () => {
  const ir = baseIR();
  ir.phases[0].effects.artifact_mutation = "maybe";
  const r = validateIRShape(ir);
  assert.equal(r.valid, false);
});

test("missing boundary field rejected", () => {
  const ir = baseIR();
  delete ir.phases[0].effects.boundaries;
  const r = validateIRShape(ir);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("boundaries")));
});

test("invalid disposition value rejected", () => {
  const ir = baseIR({
    verdict: "DECOMPOSITION_BLOCKED",
    phases: [],
    dispositions: [{ requirement_id: "R1", disposition: "waiting", reason_code: "OTHER" }],
  });
  const r = validateIRShape(ir);
  assert.equal(r.valid, false);
});

test("deferred without reason rejected", () => {
  const ir = baseIR({
    verdict: "DECOMPOSITION_BLOCKED",
    phases: [],
    dispositions: [{ requirement_id: "R1", disposition: "deferred", reason_code: "COMMIT_NOT_AUTHORIZED" }],
  });
  const r = validateIRShape(ir);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("deferred")));
});

test("out_of_scope requires reason_code in allowed set", () => {
  const ir = baseIR({
    verdict: "DECOMPOSITION_BLOCKED",
    phases: [],
    dispositions: [{ requirement_id: "R1", disposition: "out_of_scope", reason_code: "CYCLIC_DEPENDENCY", reason: "r", evidence: "e" }],
  });
  const r = validateIRShape(ir);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("reason_code")));
});

test("NOT_BENEFICIAL requires reason + evidence, no phases", () => {
  const ir = {
    verdict: "DECOMPOSITION_NOT_BENEFICIAL",
    reason: "trivial",
    decomposition_evidence: ["e"],
  };
  assert.equal(validateIRShape(ir).valid, true);
  const bad = { ...ir, phases: [{ phase_id: "x", title: "x", summary: "x", responsibility: "x", purpose: "implementation", effects: baseEffects(), covers: [], depends_on: [] }] };
  assert.equal(validateIRShape(bad).valid, false);
});

test("verification_plan unknown field rejected", () => {
  const ir = baseIR();
  ir.phases[0].verification_plan = {
    subject_phase_ids: ["p1"], method: "m", success_criteria: "s", failure_criteria: "f", evidence: "e", extra: 1,
  };
  const r = validateIRShape(ir);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes("verification_plan")));
});

test("purposes and dispositions are closed enums", () => {
  assert.deepEqual(PURPOSES, ["analysis", "implementation", "verification", "review", "operation"]);
  assert.deepEqual(DISPOSITION_VALUES, ["actionable", "deferred", "unresolved", "blocked", "out_of_scope", "not_beneficial"]);
});
