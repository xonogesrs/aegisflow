// test/admission/test-graph-wiring.mjs
//
// TA-2 — Graph scheduler consumption tests（Z Integration; J, Q）:
//   - runColimaGraph rejects a malformed admission BEFORE any Colima/instance
//     work（fail-closed ADMISSION_INVALID — the gate short-circuits）;
//   - runSubagentGraph rejects the same;
//   - a valid admission record passes validation + carries the projected
//     repair budget（full Colima execution of admitted graphs is exercised by
//     the durable/sub-agent suites — this suite must stay environment-free）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { runColimaGraph } from "../../src/runtime/colima-graph-runner.mjs";
import { runSubagentGraph } from "../../src/subagent/subagent-graph-runner.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission, validateAdmission } from "../../src/admission/admission-record.mjs";

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

function validAdmission() {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  return freezeAdmission(buildAdmissionRecord({ taskId: "TEST-GRAPH-1", classification: c, mutationScope: ["docs/"] }));
}

function makeIr() {
  return {
    schema: "autoloop.ir/v2",
    phases: [
      { phase_id: "P1", depends_on: [], effects: { artifact_mutation: "none", evidence_output: "none" }, runtime: { mode: "readonly", taskType: "inventory_markdown", objective: "count todos", limits: { timeoutMs: 5000 } } },
    ],
  };
}

test("J: runColimaGraph rejects malformed admission -> HOLD / ADMISSION_INVALID (before any instance work)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ta2-adm-invalid-"));
  const scratchRoot = join(tmp, "scratch");
  try {
    const bad = { ...validAdmission(), capabilities: { required: [], allowed: ["CAP.BOGUS"], denied: [] } };
    const r = await runColimaGraph({
      ir: makeIr(),
      parent: { scope: { allowed_paths: ["docs/"], forbidden_paths: [] } },
      cwd: tmp,
      executionId: "exec_ta2invalid",
      repoPath: tmp,
      scratchRoot,
      maxRepairAttempts: 1,
      timeoutMs: 5000,
      admission: bad,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.holdCode, "ADMISSION_INVALID");
    // the gate short-circuits: no instance / closeout / scheduler was engaged
    assert.deepEqual(r.nodeResults, []);
    assert.equal(r.closeout.applied, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("J: runSubagentGraph rejects malformed admission -> HOLD / ADMISSION_INVALID (durable:false raw path)", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ta2-adm-sub-"));
  const scratchRoot = join(tmp, "scratch");
  try {
    const bad = { ...validAdmission(), risk: "NOT_A_RISK" };
    const r = await runSubagentGraph({
      ir: makeIr(),
      parent: { scope: { allowed_paths: ["docs/"], forbidden_paths: [] } },
      cwd: tmp,
      executionId: "ta2-sub-invalid",
      repoPath: tmp,
      scratchRoot,
      maxRepairAttempts: 1,
      timeoutMs: 5000,
      durable: false,
      admission: bad,
    });
    assert.equal(r.final, "HOLD");
    assert.equal(r.holdCode, "ADMISSION_INVALID");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("J: a valid admission validates cleanly and is accepted by the graph entry (no ADMISSION_INVALID)", async () => {
  const admission = validAdmission();
  const v = validateAdmission(admission);
  assert.equal(v.ok, true, v.errors.join("; "));
  // the runner's gate only rejects invalid admissions — a valid record is
  // passed through to execution. With Colima unavailable the run throws an
  // ENVIRONMENTAL error（never ADMISSION_INVALID）; with Colima available it
  // executes. Either way the admission gate passed.
  const tmp = mkdtempSync(join(tmpdir(), "ta2-adm-valid-"));
  const scratchRoot = join(tmp, "scratch");
  try {
    try {
      const r = await runSubagentGraph({
        ir: makeIr(),
        parent: { scope: { allowed_paths: ["docs/"], forbidden_paths: [] } },
        cwd: tmp,
        executionId: "ta2-sub-valid",
        repoPath: tmp,
        scratchRoot,
        maxRepairAttempts: 1,
        timeoutMs: 5000,
        durable: false,
        admission,
      });
      assert.notEqual(r.holdCode, "ADMISSION_INVALID");
    } catch (e) {
      assert.ok(!String(e?.message ?? e).includes("ADMISSION_INVALID"), `admission gate must not reject a valid record: ${e?.message}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Q: FAST_PATH repair budget is 0 and carried on the frozen record", () => {
  const admission = validAdmission();
  assert.equal(admission.profile, "FAST_PATH");
  assert.equal(admission.repair_budget, 0);
  assert.equal(admission.evidence_policy, "none");
  assert.equal(admission.review_policy.external_review_required, false);
});

test("R/S: HIGH risk cannot be fast-path; CRITICAL grants the strict lifecycle", () => {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("delete one row from the production database") });
  const rec = freezeAdmission(buildAdmissionRecord({ taskId: "TEST-GRAPH-HIGH", classification: c, mutationScope: ["db/"] }));
  assert.equal(rec.profile, "CRITICAL");
  assert.equal(rec.risk, "CRITICAL");
  assert.equal(rec.fast_path_eligible ?? false, false);
  assert.equal(rec.review_policy.external_review_required, true);
  assert.equal(rec.durability_policy, "durable_resume");
  assert.ok(rec.human_gates.includes("controller_pre_execution"));
  assert.ok(rec.capabilities.required.includes("CAP.INDEPENDENT_REVIEW"));
  assert.ok(rec.capabilities.required.includes("CAP.EXTERNAL_REVIEW_DELIVERY"));
});
