// test/admission/test-admission-gate.mjs
//
// TA-2R（finding 1 / NEG19）— MANDATORY production admission gate:
//   - no admission            -> HOLD / ADMISSION_REQUIRED and the runner is
//                                NEVER invoked（no decomposition/execution）;
//   - malformed admission     -> HOLD / ADMISSION_INVALID, runner not invoked;
//   - tampered / unfrozen     -> HOLD / ADMISSION_DRIFT, runner not invoked;
//   - valid frozen admission  -> gate passes, runner invoked WITH the same
//                                frozen admission（unchanged）;
//   - per-runner *Admitted wrappers dispatch to the right production runner.
//
// The spy-runner proof is the non-bypassability evidence: the gate returns
// before ANY await of the runner, so a production caller cannot reach
// decomposition/execution without a frozen admission.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission, validateAdmission, deriveAdmissionId } from "../../src/admission/admission-record.mjs";
import {
  assertProductionAdmission,
  runAdmittedGraph,
  runColimaGraphAdmitted,
  runSubagentGraphAdmitted,
  runDurableGraphAdmitted,
  PRODUCTION_GATE_HOLDS,
} from "../../src/admission/admission-gate.mjs";

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
  return freezeAdmission(buildAdmissionRecord({ taskId: "TEST-GATE-1", classification: c, mutationScope: ["docs/"] }));
}

// A record whose id re-derives but whose payload is schema-invalid
//（CAP.BOGUS）-> ADMISSION_INVALID. freezeAdmission refuses malformed records
//（it validates + throws）, so the malformed record is constructed with a
// correctly-derived id over the bad payload.
function malformedFrozenAdmission() {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const raw = buildAdmissionRecord({ taskId: "TEST-GATE-BAD", classification: c, mutationScope: ["docs/"] });
  raw.capabilities = { required: [], allowed: ["CAP.BOGUS"], denied: [] };
  raw.admission_id = deriveAdmissionId(raw);
  return raw;
}

function spyRunner(recorded) {
  return async (opts) => {
    recorded.push(opts);
    // TA-3: a faithful production runner honors the budget chain（pre-dispatch
    // -> record -> post-op）— the spy simulates the colima runner's wiring so
    // the finalize reconciliation sees matching ledger + evidence.
    const enc = opts?.budget?.enforcement;
    if (enc) {
      const gate = enc.preDispatch({ executionId: "g", phase_id: "P1", nodeId: "P1", attempt: 0, runtime: { mode: "readonly", limits: { timeoutMs: 60000 } } });
      if (gate.ok) enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
    }
    return { final: "PASS", nodeResults: [{ nodeId: "P1", final: "PASS", attempt: 0, resultIdentity: { latencyMs: 5 } }], admission: opts?.admission ?? null };
  };
}

// ── assertProductionAdmission unit ─────────────────────────────────────────

test("gate unit: no admission -> ADMISSION_REQUIRED; null / undefined / non-object all fail closed", () => {
  for (const bad of [null, undefined, "admission", 42, [], {}]) {
    const g = assertProductionAdmission(bad);
    assert.equal(g.ok, false);
    assert.equal(g.holdCode, PRODUCTION_GATE_HOLDS.ADMISSION_REQUIRED, `expected ADMISSION_REQUIRED for ${JSON.stringify(bad)}`);
  }
});

test("gate unit: malformed admission -> ADMISSION_INVALID", () => {
  const bad = malformedFrozenAdmission();
  const g = assertProductionAdmission(bad);
  assert.equal(g.ok, false);
  assert.equal(g.holdCode, PRODUCTION_GATE_HOLDS.ADMISSION_INVALID);
});

test("gate unit: tampered (unfrozen) admission -> ADMISSION_DRIFT", () => {
  const rec = validAdmission();
  const tampered = { ...rec, risk: "HIGH" }; // payload no longer re-derives admission_id
  const g = assertProductionAdmission(tampered);
  assert.equal(g.ok, false);
  assert.equal(g.holdCode, PRODUCTION_GATE_HOLDS.ADMISSION_DRIFT);
  // a record whose id was stripped is also not frozen
  const stripped = { ...rec };
  delete stripped.admission_id;
  const g2 = assertProductionAdmission(stripped);
  assert.equal(g2.ok, false);
  assert.equal(g2.holdCode, PRODUCTION_GATE_HOLDS.ADMISSION_DRIFT);
});

test("gate unit: valid frozen admission passes and returns the same record", () => {
  const rec = validAdmission();
  assert.equal(validateAdmission(rec).ok, true);
  const g = assertProductionAdmission(rec);
  assert.equal(g.ok, true);
  assert.equal(g.admission, rec);
});

// ── runAdmittedGraph: non-bypassability（spy proof）───────────────────────

test("NEG19: production entry WITHOUT admission -> HOLD / ADMISSION_REQUIRED, runner NEVER invoked", async () => {
  const calls = [];
  const r = await runAdmittedGraph({ admission: null, runner: spyRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "ADMISSION_REQUIRED");
  assert.deepEqual(r.nodeResults, []);
  assert.equal(r.closeout.applied, false);
  assert.equal(calls.length, 0, "runner must never be invoked without a frozen admission");
});

test("NEG19: production entry with MALFORMED admission -> HOLD / ADMISSION_INVALID, runner NEVER invoked", async () => {
  const calls = [];
  const bad = malformedFrozenAdmission();
  const r = await runAdmittedGraph({ admission: bad, runner: spyRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "ADMISSION_INVALID");
  assert.equal(calls.length, 0, "runner must never be invoked with a malformed admission");
});

test("NEG19: production entry with TAMPERED admission -> HOLD / ADMISSION_DRIFT, runner NEVER invoked", async () => {
  const calls = [];
  const tampered = { ...validAdmission(), mutation_scope: ["src/"] };
  const r = await runAdmittedGraph({ admission: tampered, runner: spyRunner(calls) });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "ADMISSION_DRIFT");
  assert.equal(calls.length, 0, "runner must never be invoked with a drifted admission");
});

test("NEG19: production entry with a VALID frozen admission dispatches with the SAME admission", async () => {
  const calls = [];
  const rec = validAdmission();
  const r = await runAdmittedGraph({ admission: rec, runner: spyRunner(calls), ir: { phases: [] } });
  assert.equal(r.final, "PASS");
  assert.equal(calls.length, 1, "runner invoked exactly once");
  assert.equal(calls[0].admission, rec, "the frozen admission is forwarded unchanged");
});

test("NEG19: gate without graph or runner -> HOLD / ADMISSION_INVALID (no dispatch target)", async () => {
  const r = await runAdmittedGraph({ admission: validAdmission(), graph: null, runner: null });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "ADMISSION_INVALID");
});

// ── per-runner *Admitted wrappers ─────────────────────────────────────────

test("runColimaGraphAdmitted / runSubagentGraphAdmitted / runDurableGraphAdmitted require admission (no dispatch)", async () => {
  const colima = await runColimaGraphAdmitted({ admission: null });
  assert.equal(colima.holdCode, "ADMISSION_REQUIRED");
  const subagent = await runSubagentGraphAdmitted({ admission: undefined });
  assert.equal(subagent.holdCode, "ADMISSION_REQUIRED");
  const durable = await runDurableGraphAdmitted({ admission: null });
  assert.equal(durable.holdCode, "ADMISSION_REQUIRED");
});
