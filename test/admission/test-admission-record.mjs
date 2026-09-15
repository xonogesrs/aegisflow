// test/admission/test-admission-record.mjs
//
// TA-2 — admission record tests（Z Unit; G, I, N, NEG11）: schema validation,
// canonicalization, deterministic admission_id, freeze, tamper/drift
// detection, mutation -> new id.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveAdmissionId,
  validateAdmission,
  freezeAdmission,
  assertAdmissionFrozen,
  canonicalAdmissionJson,
  admissionDigest,
} from "../../src/admission/admission-record.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord, projectCapabilities } from "../../src/admission/policy-projection.mjs";

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

function buildTask(overrides = {}) {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const rec = buildAdmissionRecord({ taskId: "TEST-ADM-1", classification: c, ...overrides });
  return freezeAdmission(rec);
}

test("freeze produces a valid, schema-compliant, deterministic record", () => {
  const a = buildTask();
  const v = validateAdmission(a);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(a.schema, "autoloop.task-admission/v1");
  assert.equal(a.schema_version, 1);
  assert.equal(a.fail_closed, true);
  assert.equal(a.classifier_version, "1.0.0");
});

test("admission_id deterministic: same facts -> same id (G)", () => {
  const a = buildTask();
  const b = buildTask();
  assert.equal(a.admission_id, b.admission_id);
  // re-derivation from the payload is stable
  assert.equal(deriveAdmissionId(a), a.admission_id);
});

test("admission_id excludes admission_id + decision_time (non-authoritative fields)", () => {
  const a = buildTask();
  const clone = { ...a, decision_time: "2099-01-01T00:00:00.000Z" };
  assert.equal(deriveAdmissionId(clone), a.admission_id);
});

test("mutation -> new id: changing risk / size / capability changes admission_id", () => {
  const a = buildTask();
  const highRisk = { ...a, risk: "HIGH", profile: "HIGH" };
  assert.notEqual(deriveAdmissionId(highRisk), a.admission_id);
  const noCap = { ...a, capabilities: { required: [], allowed: ["direct_execution"], denied: Object.keys(projectCapabilities({ profile: "FAST_PATH", risk: "LOW" }).denied) } };
  // capabilities changed -> id changes
  assert.notEqual(deriveAdmissionId(noCap), a.admission_id);
});

test("tamper detection: altered payload fails re-derivation (NEG11)", () => {
  const a = buildTask();
  const tampered = { ...a, risk: "HIGH" };
  const drift = assertAdmissionFrozen({ stored: tampered, authoritativeAdmissionId: a.admission_id, authoritativeRecord: tampered });
  assert.equal(drift.ok, false);
  assert.match(drift.reason, /ADMISSION_DRIFT/);
});

test("drift: stored id != authoritative id -> HOLD / ADMISSION_DRIFT; no stored -> drift", () => {
  const a = buildTask();
  // deterministic id: a differently-classified record has a different id
  const other = freezeAdmission(buildAdmissionRecord({
    taskId: "TEST-ADM-1",
    classification: classify({ dimensionScores: { ...FULL_EVIDENCE, affected_files: { score: 2, reasons: ["two files"] } }, riskSignals: scanRiskSignals("fix one typo in README") }),
  }));
  assert.notEqual(other.admission_id, a.admission_id);
  const tamperedStored = { ...other, admission_id: a.admission_id };
  const drift = assertAdmissionFrozen({ stored: tamperedStored, authoritativeAdmissionId: other.admission_id, authoritativeRecord: other });
  assert.equal(drift.ok, false);
  assert.equal(assertAdmissionFrozen({ stored: null, authoritativeAdmissionId: a.admission_id }).ok, false);
  assert.equal(assertAdmissionFrozen({ stored: a, authoritativeAdmissionId: a.admission_id, authoritativeRecord: a }).ok, true);
});

test("canonical serialization: key order independent", () => {
  const a = { b: 1, a: [2, 1], c: { y: 1, x: 2 } };
  const b = { c: { x: 2, y: 1 }, a: [2, 1], b: 1 };
  assert.equal(canonicalAdmissionJson(a), canonicalAdmissionJson(b));
});

test("invalid records fail closed: unknown capability, profile mismatch, FAST_PATH guard, non-enumerated capability", () => {
  const a = buildTask();
  const unknownCap = { ...a, capabilities: { ...a.capabilities, allowed: [...a.capabilities.allowed, "CAP.NOPE"] } };
  assert.equal(validateAdmission(unknownCap).ok, false);
  const profileMismatch = { ...a, profile: "CRITICAL" };
  assert.equal(validateAdmission(profileMismatch).ok, false);
  const fastRisk = { ...a, profile: "FAST_PATH", risk: "HIGH" };
  assert.equal(validateAdmission(fastRisk).ok, false);
  const notEnumerated = { ...a, capabilities: { required: [], allowed: ["direct_execution"], denied: [] } };
  assert.equal(validateAdmission(notEnumerated).ok, false);
});

test("under-classified risk (LOW record with triggered CRITICAL signal) fails validation", () => {
  const c = classify({
    dimensionScores: FULL_EVIDENCE,
    riskSignals: [{ signal_id: "RS.DATABASE_MUTATION", class: "CRITICAL", triggered: true, reason: "db delete" }],
  });
  const rec = buildAdmissionRecord({ taskId: "T-UNDER", classification: c });
  const frozen = freezeAdmission(rec);
  assert.equal(frozen.risk, "CRITICAL");
  // force the inconsistent record: LOW risk with triggered CRITICAL signal
  const bad = { ...frozen, risk: "LOW", profile: "FAST_PATH" };
  assert.equal(validateAdmission(bad).ok, false);
});

test("admissionDigest is stable for the same frozen record", () => {
  const a = buildTask();
  const b = buildTask();
  assert.equal(admissionDigest(a), admissionDigest(b));
  assert.equal(admissionDigest({ ...a, risk: "HIGH" }) !== admissionDigest(a), true);
});

test("bounded refinement: new facts -> new deterministic admission_id, old preserved (I)", () => {
  const first = buildTask();
  const refined = buildTask();
  // refinement with new evidence（e.g. discovery changed ambiguity）is a NEW
  // record with a NEW id — original preserved as provenance.
  const refined2 = buildAdmissionRecord({
    taskId: "TEST-ADM-1",
    classification: classify({ dimensionScores: { ...FULL_EVIDENCE, ambiguity: { score: 1, reasons: ["minor gaps after discovery"] } }, riskSignals: scanRiskSignals("fix one typo in README") }),
  });
  const f2 = freezeAdmission(refined2);
  assert.notEqual(f2.admission_id, first.admission_id);
  assert.equal(first.admission_id, refined.admission_id);
});

const GLM_BINDING = {
  adapterKind: "pi-builtin",
  providerKind: "merge-gateway",
  modelId: "zai/glm-5.3-flash",
  requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"],
};

test("valid provider_binding is accepted and included in admission_id", () => {
  const a = buildTask({
    extensions: { rollover: { enabled: true, context_occupancy_threshold: 100, provider_binding: GLM_BINDING } },
  });
  assert.equal(a.extensions.rollover.provider_binding.modelId, "zai/glm-5.3-flash");
  assert.equal(deriveAdmissionId(a), a.admission_id);
});

test("unsupported adapter/provider/model pair is rejected", () => {
  const rec = buildAdmissionRecord({
    taskId: "TEST-ADM-1",
    classification: classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") }),
    extensions: {
      rollover: {
        enabled: true,
        context_occupancy_threshold: 100,
        provider_binding: { ...GLM_BINDING, providerKind: "openai", modelId: "gpt-4" },
      },
    },
  });
  rec.admission_id = deriveAdmissionId(rec);
  const v = validateAdmission(rec);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("provider_binding") && e.includes("unsupported")));
});

test("missing modelId on enabled rollover is rejected", () => {
  const rec = buildAdmissionRecord({
    taskId: "TEST-ADM-1",
    classification: classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") }),
    extensions: {
      rollover: {
        enabled: true,
        context_occupancy_threshold: 100,
        provider_binding: { adapterKind: "pi-builtin", providerKind: "merge-gateway", requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"] },
      },
    },
  });
  rec.admission_id = deriveAdmissionId(rec);
  const v = validateAdmission(rec);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("modelId")));
});

test("binding mutation changes admission_id", () => {
  const a = buildTask({
    extensions: { rollover: { enabled: true, context_occupancy_threshold: 100, provider_binding: GLM_BINDING } },
  });
  const mutated = {
    ...a,
    extensions: {
      rollover: {
        ...a.extensions.rollover,
        provider_binding: { ...GLM_BINDING, modelId: "deepseek-v4-flash", providerKind: "deepseek", requiredEnvKeys: [] },
      },
    },
  };
  assert.notEqual(deriveAdmissionId(mutated), a.admission_id);
});

test("post-admission binding mutation is rejected", () => {
  const a = buildTask({
    extensions: { rollover: { enabled: true, context_occupancy_threshold: 100, provider_binding: GLM_BINDING } },
  });
  const tampered = {
    ...a,
    extensions: {
      rollover: {
        ...a.extensions.rollover,
        provider_binding: { ...GLM_BINDING, modelId: "deepseek-v4-flash", providerKind: "deepseek", requiredEnvKeys: [] },
      },
    },
  };
  const v = validateAdmission(tampered);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith("admission_id_mismatch")));
  const drift = assertAdmissionFrozen({ stored: tampered, authoritativeAdmissionId: a.admission_id, authoritativeRecord: tampered });
  assert.equal(drift.ok, false);
});

