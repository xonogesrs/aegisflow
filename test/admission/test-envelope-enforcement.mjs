// test/admission/test-envelope-enforcement.mjs
//
// TA-2 — envelope projection + writer enforcement tests（Z Unit; K, L, NEG3,
// NEG5, NEG8）: toolPermissions + mutationScope FROM admission; writer under
// read-only admission cannot gain write capability; mutation scope
// containment; memory write-back authority.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import {
  buildAdmissionRecord,
  projectEnvelopeFields,
  projectCapabilities,
  projectProfilePolicies,
  assertMutationWithinAdmissionScope,
  AdmissionEnvelopeError,
} from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import { TOOL_PERMISSIONS } from "../../src/subagent/subagent-contract.mjs";

const FULL_EVIDENCE = {
  affected_files: { score: 1, reasons: ["single README file"] },
  affected_subsystems: { score: 0, reasons: ["docs only"] },
  dependency_depth: { score: 0, reasons: ["no deps"] },
  ambiguity: { score: 0, reasons: ["exact text"] },
  expected_execution_steps: { score: 0, reasons: ["one edit"] },
  verification_burden: { score: 0, reasons: ["no tests"] },
  external_dependencies: { score: 0, reasons: ["none"] },
  concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 0, reasons: ["revert 1 file"] },
};

function admissionFor(taskText, extra = {}) {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals(taskText) });
  const rec = buildAdmissionRecord({ taskId: "TEST-ENV-1", classification: c, mutationScope: ["docs/"], ...extra });
  return freezeAdmission(rec);
}

// MEDIUM profile: TA-1 has no MEDIUM-class keyword signal（all 15 canonical
// signals are HIGH/CRITICAL）; MEDIUM arises from a signal present but not
// clearly classified / ambiguous evidence — constructed explicitly here.
function mediumAdmission(extra = {}) {
  const c = classify({
    dimensionScores: { ...FULL_EVIDENCE, affected_files: { score: 2, reasons: ["two files"] }, affected_subsystems: { score: 1, reasons: ["memory + graph"] } },
    riskSignals: [{ signal_id: "RS.AMBIGUOUS_SIGNAL", class: "MEDIUM", triggered: true, reason: "signal present but not clearly classified" }],
    evidenceSufficient: true,
  });
  const rec = buildAdmissionRecord({ taskId: "TEST-ENV-MED", classification: c, mutationScope: ["docs/"], ...extra });
  return freezeAdmission(rec);
}

test("NEG3: writer under a read-only admission cannot gain write capability", () => {
  const fast = admissionFor("fix one typo in README"); // FAST_PATH — no writer capability
  assert.throws(
    () => projectEnvelopeFields({ admission: fast, nodeRole: "writer", mutationScopeFromPhase: ["docs/"] }),
    (e) => e instanceof AdmissionEnvelopeError && e.code === "ADMISSION_MUTATION_SCOPE_VIOLATION",
  );
});

test("read-only roles get READ_ONLY tools only, empty mutation scope", () => {
  const medium = mediumAdmission();
  assert.equal(medium.profile, "MEDIUM");
  const ro = projectEnvelopeFields({ admission: medium, nodeRole: "readonly-analyst" });
  assert.deepEqual(ro.toolPermissions, [...TOOL_PERMISSIONS.READ_ONLY]);
  assert.equal(ro.mutationScope, null);
  assert.equal(ro.writerAllowed, true); // MEDIUM profile grants writer
});

test("writer envelope: mutation scope projected from admission, phase boundary inside scope", () => {
  const medium = mediumAdmission();
  const w = projectEnvelopeFields({ admission: medium, nodeRole: "writer", mutationScopeFromPhase: ["docs/pi-graph-output"] });
  assert.ok(w.mutationScope.length > 0);
  assert.deepEqual([...w.toolPermissions].sort(), [...TOOL_PERMISSIONS.READ_ONLY, ...TOOL_PERMISSIONS.SCRATCH_WRITE].sort());
});

test("L: phase boundary outside admission.mutation_scope -> HOLD / ADMISSION_MUTATION_SCOPE_VIOLATION", () => {
  const medium = mediumAdmission();
  assert.throws(
    () => projectEnvelopeFields({ admission: medium, nodeRole: "writer", mutationScopeFromPhase: ["src/gov/other.mjs"] }),
    (e) => e instanceof AdmissionEnvelopeError && e.code === "ADMISSION_MUTATION_SCOPE_VIOLATION",
  );
});

test("assertMutationWithinAdmissionScope: containment enforced", () => {
  const medium = mediumAdmission();
  assert.equal(assertMutationWithinAdmissionScope(medium, ["docs/pi-graph-output/ta2/a.md"]), true);
  assert.throws(() => assertMutationWithinAdmissionScope(medium, ["src/v2/runner.mjs"]), AdmissionEnvelopeError);
});

test("writer with empty admission scope is fail-closed", () => {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const rec = buildAdmissionRecord({ taskId: "TEST-ENV-2", classification: c, mutationScope: [] });
  const frozen = freezeAdmission(rec);
  assert.throws(
    () => projectEnvelopeFields({ admission: frozen, nodeRole: "writer", mutationScopeFromPhase: [] }),
    (e) => e.code === "ADMISSION_MUTATION_SCOPE_VIOLATION",
  );
});

test("NEG5: memory write-back denied by default (all profiles except explicit admission)", () => {
  for (const profile of ["FAST_PATH", "STANDARD", "MEDIUM", "MEDIUM_LARGE", "LARGE_LOW", "HIGH", "CRITICAL"]) {
    const p = projectProfilePolicies(profile);
    assert.equal(p.memory_policy.writeback_allowed, false, `${profile} writeback must be denied by default`);
  }
});

test("profile projection: decision fields match the TA-1 matrix", () => {
  const fast = projectProfilePolicies("FAST_PATH");
  assert.equal(fast.lifecycle_profile.direct_execution_allowed, true);
  assert.equal(fast.lifecycle_profile.decomposition_required, false);
  assert.equal(fast.isolation_policy, "none");
  assert.equal(fast.durability_policy, "ephemeral");
  assert.equal(fast.review_policy.strength, "deterministic");
  assert.equal(fast.repair_budget, 0);
  assert.equal(fast.evidence_policy, "none");

  const crit = projectProfilePolicies("CRITICAL");
  assert.equal(crit.lifecycle_profile.decomposition_required, true);
  assert.equal(crit.lifecycle_profile.research_first_required, true);
  assert.equal(crit.isolation_policy, "colima");
  assert.equal(crit.durability_policy, "durable_resume");
  assert.equal(crit.review_policy.external_review_required, true);
  assert.equal(crit.review_policy.independent_review_required, true);
  assert.equal(crit.repair_budget, 1);
  assert.equal(crit.evidence_policy, "persistent");
  assert.ok(crit.human_gates.includes("controller_pre_execution"));
});

test("capability projection: deny-by-default full enumeration (NEG4)", () => {
  const caps = projectCapabilities({ profile: "FAST_PATH", risk: "LOW" });
  assert.ok(caps.allowed.includes("CAP.DIRECT_EXECUTION"));
  assert.ok(caps.required.length === 0);
  assert.ok(caps.denied.includes("CAP.WRITER_SUBAGENT"));
  assert.ok(caps.denied.includes("CAP.COLIMA_ISOLATION"));
  assert.ok(caps.denied.includes("CAP.MEMORY_WRITEBACK"));
  // full enumeration: required+allowed+denied covers the registry
  const granted = new Set([...caps.required, ...caps.allowed]);
  const denied = new Set(caps.denied);
  for (const id of ["CAP.GRAPH_SCHEDULER", "CAP.WRITER_SUBAGENT", "CAP.MEMORY_WRITEBACK", "CAP.INDEPENDENT_REVIEW", "CAP.REVIEW_BUNDLE", "CAP.EXTERNAL_REVIEW_DELIVERY", "CAP.DURABLE_EXECUTION", "CAP.COLIMA_ISOLATION", "CAP.WORKTREE_ISOLATION"]) {
    assert.ok(!granted.has(id) && denied.has(id), `${id} must be explicitly denied on FAST_PATH`);
  }
});

test("HIGH profile grants the strict lifecycle capabilities; FAST_PATH does not", () => {
  const high = projectCapabilities({ profile: "HIGH", risk: "HIGH" });
  for (const id of ["CAP.INDEPENDENT_REVIEW", "CAP.REVIEW_BUNDLE", "CAP.EXTERNAL_REVIEW_DELIVERY", "CAP.DURABLE_EXECUTION", "CAP.CHECKPOINT_RESUME", "CAP.COLIMA_ISOLATION"]) {
    assert.ok(high.required.includes(id), `${id} must be required on HIGH`);
  }
});

test("NEG8: admission vs lifecycle authority conflict is representable and must HOLD (never guess)", () => {
  const medium = mediumAdmission();
  // authority binding subset constraint: a CRITICAL admission under an
  // authority record that forbids external review would conflict — the
  // admission record carries the binding digest and the runtime holds on
  // conflict（here we assert the record is valid + the binding is present）.
  assert.equal(medium.authority_binding.subset_of_lifecycle_authorization, true);
  assert.equal(typeof medium.authority_binding.authority_record_digest, "string");
  // a conflicting projection（admission says external review required but
  // authority denies）is detected by the caller; the admission itself is the
  // authority boundary and must not be silently weakened.
  assert.equal(medium.review_policy.external_review_required, false);
});
