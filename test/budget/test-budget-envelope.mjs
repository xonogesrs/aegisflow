// test/budget/test-budget-envelope.mjs
//
// AUTOLOOP-TA3 — budget ENVELOPE（the immutable, admission-bound authority）.
//   - envelope derived from a frozen admission（profile defaults + overrides）;
//   - B1: the runtime can never widen the envelope（deep-frozen + id binding）;
//   - NEG2: tampering the admission / envelope fails closed;
//   - NEG8/NEG9: an admission declaring an unsupported meter fails at
//     envelope derivation（BUDGET_AUTHORITY_INVALID）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission, deriveAdmissionId, validateAdmission } from "../../src/admission/admission-record.mjs";
import { deriveBudgetEnvelope, assertEnvelopeUntampered, BUDGET_ENVELOPE_SCHEMA } from "../../src/budget/envelope.mjs";
import { PROFILE_DEFAULT_CONTRACTS } from "../../src/budget/contract.mjs";

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

function classifyFastPath(text = "fix one typo in README") {
  return classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals(text) });
}

function admissionWith({ extensions = {}, text = "fix one typo in README", profile = null } = {}) {
  const c = classifyFastPath(text);
  const rec = buildAdmissionRecord({ taskId: "ENV-TEST", classification: profile ? { ...c, profile } : c, mutationScope: ["docs/"], extensions });
  return freezeAdmission(rec);
}

test("envelope: derived from a frozen admission; profile defaults apply", () => {
  const rec = admissionWith();
  assert.equal(validateAdmission(rec).ok, true);
  const r = deriveBudgetEnvelope(rec);
  assert.equal(r.ok, true);
  const env = r.envelope;
  assert.equal(env.schema, BUDGET_ENVELOPE_SCHEMA);
  assert.equal(env.admissionId, rec.admission_id);
  assert.equal(env.contractSource, "profile");
  assert.equal(env.dimensions.node_execution_count.limit, PROFILE_DEFAULT_CONTRACTS[rec.profile].node_execution_count);
  assert.ok(/^[0-9a-f]{64}$/.test(env.envelopeId));
  // envelope is immutable by construction
  assert.throws(() => { env.dimensions.node_execution_count.limit = 99999; }, TypeError);
});

test("envelope: admission-declared contract overrides profile (B1)", () => {
  const rec = admissionWith({
    extensions: {
      budget: {
        schema: "autoloop.budget-contract/v1",
        version: 1,
        approachingRatio: 0.5,
        dimensions: { node_execution_count: { limit: 3 }, wall_clock_ms: { limit: 12345 } },
      },
    },
  });
  const r = deriveBudgetEnvelope(rec);
  assert.equal(r.ok, true);
  assert.equal(r.envelope.contractSource, "admission");
  assert.equal(r.envelope.dimensions.node_execution_count.limit, 3);
  assert.equal(r.envelope.dimensions.wall_clock_ms.limit, 12345);
  assert.equal(r.envelope.approachingRatio, 0.5);
});

test("envelope: NEG2 — a tampered admission derives a DIFFERENT envelope id / fails the gate", () => {
  const rec = admissionWith();
  const env1 = deriveBudgetEnvelope(rec).envelope;
  // widening the budget changes the admission payload -> admission_id drifts
  //（the production gate rejects ADMISSION_DRIFT before any dispatch）.
  const tampered = { ...rec, extensions: { budget: { schema: "autoloop.budget-contract/v1", version: 1, dimensions: { node_execution_count: { limit: 999 } } } } };
  assert.notEqual(deriveAdmissionId(tampered), rec.admission_id);
  // the envelope is derived only from the FROZEN admission — a fresh
  // derivation from the tampered payload yields a DIFFERENT envelope.
  const env2 = deriveBudgetEnvelope({ ...tampered, admission_id: deriveAdmissionId(tampered) });
  assert.notEqual(env2.envelope.envelopeId, env1.envelopeId);
  // direct envelope tampering fails the untampered check
  const forged = { ...env1, dimensions: { ...env1.dimensions, node_execution_count: { ...env1.dimensions.node_execution_count, limit: 999 } } };
  const check = assertEnvelopeUntampered(forged);
  assert.equal(check.ok, false);
  assert.equal(check.holdCode, "BUDGET_AUTHORITY_INVALID");
});

test("envelope: NEG8/NEG9 — unsupported-meter declaration -> BUDGET_AUTHORITY_INVALID", () => {
  const rec = admissionWith({
    extensions: {
      budget: { schema: "autoloop.budget-contract/v1", version: 1, dimensions: { token_budget: { limit: 1000 } } },
    },
  });
  const r = deriveBudgetEnvelope(rec);
  assert.equal(r.ok, false);
  assert.equal(r.holdCode, "BUDGET_AUTHORITY_INVALID");
  assert.ok(r.reason.includes("token_budget"), r.reason);
});

test("envelope: NEG1 — envelope requires a frozen admission (no admission -> fail closed)", () => {
  assert.equal(deriveBudgetEnvelope(null).ok, false);
  assert.equal(deriveBudgetEnvelope({}).ok, false);
  assert.equal(deriveBudgetEnvelope({ admission_id: "not-a-hash" }).ok, false);
});

test("envelope: deterministic envelopeId for the same admission", () => {
  const a = admissionWith({ extensions: { budget: { schema: "autoloop.budget-contract/v1", version: 1, dimensions: { retry_count: { limit: 2 } } } } });
  const b = admissionWith({ extensions: { budget: { schema: "autoloop.budget-contract/v1", version: 1, dimensions: { retry_count: { limit: 2 } } } } });
  assert.equal(deriveBudgetEnvelope(a).envelope.envelopeId, deriveBudgetEnvelope(b).envelope.envelopeId);
});
