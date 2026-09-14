// test/v2/test-structural-validator.mjs
// Structural validator v2 — H1/H2/H3/H5/H7/H8/H12 測試（Step 8）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStructural } from "../../src/orchestration/validators/structural-validator.mjs";

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
  const p = { phase_id, title: phase_id, summary: phase_id, responsibility: phase_id, purpose, effects, covers, depends_on };
  if (plan) p.verification_plan = plan;
  return p;
}

function baseIR() {
  return {
    verdict: "DECOMPOSED",
    parent_goal: "g",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [
      phase("audit", "analysis", baseEffects(),
        [{ requirement_id: "R1", completeness: "complete", claim: "a" }], []),
      phase("impl", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
        { boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] } }),
        [{ requirement_id: "R2", completeness: "complete", claim: "b" }], ["audit"]),
      phase("test", "verification", baseEffects("forbidden", "allowed", "forbidden", "none",
        { boundaries: { artifact: [], runtime: ["src/"], external_system: [], evidence: [] } }),
        [{ requirement_id: "R3", completeness: "complete", claim: "c" }], ["impl"],
        { subject_phase_ids: ["impl"], method: "npm test", success_criteria: "pass", failure_criteria: "fail", evidence: "log" }),
    ],
    dispositions: [],
    decomposition_evidence: ["e"],
  };
}

function gate(gates, id) {
  return gates.find(g => g.gate_id === id);
}

const parent = { scope: { allowed_paths: ["src/", "test/"], forbidden_paths: [] } };

test("H1 schema pass", () => {
  const g = gate(validateStructural(baseIR(), parent), "H1");
  assert.equal(g.pass, true, g.evidence);
});

test("H2 canonicalized collision rejected", () => {
  const ir = baseIR();
  ir.phases.push({ ...ir.phases[0], phase_id: "AUDIT " }); // collides with "audit" after NFKC+lower+trim
  const g = gate(validateStructural(ir, parent), "H2");
  assert.equal(g.pass, false);
  assert.ok(g.evidence.includes("collision"));
});

test("H2 unknown depends_on reference rejected", () => {
  const ir = baseIR();
  ir.phases[0].depends_on = ["ghost"];
  const g = gate(validateStructural(ir, parent), "H2");
  assert.equal(g.pass, false);
});

test("H2 self dependency rejected", () => {
  const ir = baseIR();
  ir.phases[1].depends_on = ["impl"];
  const g = gate(validateStructural(ir, parent), "H2");
  assert.equal(g.pass, false);
});

test("H3 cycle rejected", () => {
  const ir = baseIR();
  ir.phases[0].depends_on = ["test"]; // audit <- test cycle
  const g = gate(validateStructural(ir, parent), "H3");
  assert.equal(g.pass, false);
  assert.ok(g.evidence.includes("cycle"));
});

test("H3 duplicate edge rejected", () => {
  const ir = baseIR();
  ir.phases[2].depends_on = ["impl", "impl"];
  const g = gate(validateStructural(ir, parent), "H3");
  assert.equal(g.pass, false);
});

test("H3 unsafe reverse dependency rejected", () => {
  const ir = baseIR();
  ir.phases[1].depends_on = ["test"]; // subject impl depends on its verifier test
  const g = gate(validateStructural(ir, parent), "H3");
  assert.equal(g.pass, false);
  assert.ok(g.evidence.includes("reverse") || g.evidence.includes("unsafe"));
});

test("H5 path out of scope rejected", () => {
  const ir = baseIR();
  ir.phases[1].effects.boundaries.artifact = ["etc/passwd"];
  const g = gate(validateStructural(ir, parent), "H5");
  assert.equal(g.pass, false);
});

test("H5 artifact mutation without boundary rejected", () => {
  const ir = baseIR();
  ir.phases[1].effects.boundaries.artifact = [];
  const g = gate(validateStructural(ir, parent), "H5");
  assert.equal(g.pass, false);
});

test("H7 persistent evidence without boundary rejected", () => {
  const ir = baseIR();
  ir.phases[0].effects.evidence_output = "persistent"; // evidence boundary empty
  const g = gate(validateStructural(ir, parent), "H7");
  assert.equal(g.pass, false);
});

test("H7 forbidden with non-empty artifact target rejected", () => {
  const ir = baseIR();
  ir.phases[0].effects.boundaries.artifact = ["src/"]; // forbidden + target
  const g = gate(validateStructural(ir, parent), "H7");
  assert.equal(g.pass, false);
});

test("H7 multiple sequential mutation phases allowed (single-writer = runner scheduling)", () => {
  const ir = baseIR();
  ir.phases.push(phase("w2", "implementation", baseEffects("required", "forbidden", "forbidden", "none",
    { boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] } }),
    [], ["impl"])); // w2 depends on impl → 依序 → 合法
  const g = gate(validateStructural(ir, parent), "H7");
  assert.equal(g.pass, true, g.evidence);
});

test("H8 deferred without target/reason rejected (D-16)", () => {
  const ir = baseIR();
  ir.phases[0].covers = []; // make R1 unactionable
  ir.phases[0].phase_id = "audit_only";
  ir.dispositions = [{ requirement_id: "R1", disposition: "deferred", reason_code: "COMMIT_NOT_AUTHORIZED" }];
  const g = gate(validateStructural(ir, parent), "H8");
  assert.equal(g.pass, false);
  assert.ok(g.evidence.includes("target") || g.evidence.includes("reason"));
});

test("H8 unresolved without question rejected", () => {
  const ir = baseIR();
  ir.phases = [];
  ir.dispositions = [{ requirement_id: "R1", disposition: "unresolved", reason_code: "CYCLIC_DEPENDENCY" }];
  const g = gate(validateStructural(ir, parent), "H8");
  assert.equal(g.pass, false);
});

test("H12 execution policy lock", () => {
  const ir = baseIR();
  ir.execution_policy.reviewer = "OPENCODE";
  const g = gate(validateStructural(ir, parent), "H12");
  assert.equal(g.pass, false);
});
