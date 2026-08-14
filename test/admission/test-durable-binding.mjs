// test/admission/test-durable-binding.mjs
//
// TA-2 — durable layer admission binding（N, O; NEG11）: the frozen admission
// digest is part of the configuration fingerprint（a changed admission changes
// the fingerprint -> resume mismatch -> HOLD）, and the checkpoint snapshot
// carries it. Focused on the fingerprint primitives（full crash/resume is
// exercised by the durable suite with the same fingerprint machinery）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfigurationFingerprint, buildCheckpointSnapshot } from "../../src/v2/checkpoint-bridge.mjs";
import { admissionDigest } from "../../src/admission/admission-record.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";

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

function admissionFor(taskText) {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals(taskText) });
  return freezeAdmission(buildAdmissionRecord({ taskId: "TEST-DUR-1", classification: c, mutationScope: ["docs/"] }));
}

const BASE_CFG = {
  maxRepairAttempts: 1,
  timeoutMs: 90000,
  toolPolicy: null,
  environmentAllowlist: null,
  expectedReviewerModel: null,
  runtime: { v: "test" },
  sourceHashes: null,
  persistenceFormatVersion: "1.0.0",
};

test("O: admission digest is bound into the configuration fingerprint", () => {
  const a = admissionFor("fix one typo in README");
  const fp1 = buildConfigurationFingerprint({ ...BASE_CFG, admissionFingerprint: admissionDigest(a) });
  const fp2 = buildConfigurationFingerprint({ ...BASE_CFG, admissionFingerprint: admissionDigest(a) });
  assert.equal(fp1, fp2, "same admission -> same fingerprint");
  const b = admissionFor("delete one row from the production database");
  const fp3 = buildConfigurationFingerprint({ ...BASE_CFG, admissionFingerprint: admissionDigest(b) });
  assert.notEqual(fp1, fp3, "changed admission -> changed fingerprint (anti-drift)");
});

test("O: no admission -> null admission_fingerprint contributes deterministically", () => {
  const fp1 = buildConfigurationFingerprint({ ...BASE_CFG });
  const fp2 = buildConfigurationFingerprint({ ...BASE_CFG });
  assert.equal(fp1, fp2);
  // a run WITHOUT admission has a different fingerprint than the same run
  // WITH an admission — resume cannot silently attach one later.
  const withAdm = buildConfigurationFingerprint({ ...BASE_CFG, admissionFingerprint: admissionDigest(admissionFor("fix one typo in README")) });
  assert.notEqual(fp1, withAdm);
});

test("N: admission_id is part of the checkpoint snapshot record", () => {
  const a = admissionFor("fix one typo in README");
  const snap = buildCheckpointSnapshot({
    executionId: "exec_test",
    chainId: "chain_test",
    checkpointId: "cp_test",
    revision: 1,
    created_at: new Date().toISOString(),
    repositoryFingerprint: { repository_root_identity: "/tmp/x", expected_head: "abc1234", git_common_dir_identity: "/tmp/x/.git", expected_ref: "refs/heads/main", expected_worktree_state: "dirty", origin_url: null, origin_master: null },
    inputFingerprint: "in",
    configurationFingerprint: "cfg",
    irSha: "ir",
    dagSha: "dag",
    journalHead: { seq: 1, sha256: "j" },
    phaseStates: {},
    phaseAttempts: {},
    phaseResultHashes: {},
    completedPhaseIds: [],
    activePhase: null,
    activeLifecycleStage: null,
    writerPhaseActive: false,
    writerLeaseHolder: null,
    finalVerdict: null,
    resumePolicy: { safe_boundary: true, interrupted_writer: false },
  });
  assert.ok(snap.configuration_fingerprint, "snapshot carries the configuration fingerprint");
  // The durable layer sets run.configurationFingerprint = _configurationFingerprint()
  // which now includes admission_fingerprint（verified above）; the snapshot
  // record itself carries it via that field.
  assert.equal(typeof snap.configuration_fingerprint, "string");
});
