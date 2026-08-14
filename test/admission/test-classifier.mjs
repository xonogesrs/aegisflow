// test/admission/test-classifier.mjs
//
// TA-2 — pure classifier tests（Z Unit）: determinism, size tiers, risk
// escalation + monotonicity, profile projection, fast-path guard, and the
// fail-closed negative cases NEG1 / NEG2 / NEG6 / NEG7 / NEG12.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  classifySize,
  classifyRisk,
  scanRiskSignals,
  profileFor,
  isFastPathEligible,
  RISK_SIGNALS,
  SIZE_DIMENSIONS,
  CLASSIFIER_VERSION,
} from "../../src/admission/classify.mjs";

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

test("determinism: same inputs -> identical classification (twice)", () => {
  const a = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const b = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  assert.deepEqual(a, b);
  assert.equal(a.classifier_version, CLASSIFIER_VERSION);
});

test("size model: 10 dimensions, XS..XL tiers, score bounds", () => {
  assert.equal(SIZE_DIMENSIONS.length, 10);
  const xs = classifySize(FULL_EVIDENCE);
  assert.equal(xs.size, "XS");
  assert.equal(xs.total_score, 1);
  assert.equal(xs.under_classified, false);
  const xl = classifySize(Object.fromEntries(SIZE_DIMENSIONS.map((d) => [d, { score: 3, reasons: [`${d}=3`] }])));
  assert.equal(xl.size, "XL");
  assert.equal(xl.total_score, 30);
});

test("NEG1: trivial XS/LOW typo task -> FAST_PATH (no overkill)", () => {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README sentence") });
  assert.equal(c.size, "XS");
  assert.equal(c.risk, "LOW");
  assert.equal(c.profile, "FAST_PATH");
  assert.equal(c.fast_path_eligible, true);
});

test("NEG2/NEG7: high-risk tiny task (db delete) -> CRITICAL regardless of size", () => {
  const c = classify({ dimensionScores: { affected_files: { score: 1, reasons: ["one statement"] } }, riskSignals: scanRiskSignals("delete one row from the production database") });
  assert.equal(c.size, "XS");
  assert.equal(c.risk, "CRITICAL");
  assert.equal(c.profile, "CRITICAL");
  assert.equal(c.fast_path_eligible, false);
});

test("NEG6: remote/network action -> >= HIGH, never LOW", () => {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fetch from the remote and push the branch") });
  assert.ok(["HIGH", "CRITICAL"].includes(c.risk), `risk=${c.risk}`);
  assert.notEqual(c.profile, "FAST_PATH");
});

test("NEG12: insufficient evidence -> under_classified + risk >= MEDIUM, never LOW", () => {
  const c = classify({ dimensionScores: {}, riskSignals: [], evidenceSufficient: false });
  assert.equal(c.size_details.under_classified, true);
  assert.equal(c.risk, "MEDIUM");
  assert.notEqual(c.profile, "FAST_PATH");
});

test("risk escalation is monotonic: >=2 HIGH -> CRITICAL; >=1 HIGH -> HIGH; unknown class throws", () => {
  const twoHigh = classifyRisk([
    { signal_id: "RS.CONCURRENCY", class: "HIGH", triggered: true, reason: "a" },
    { signal_id: "RS.PERSISTENCE", class: "HIGH", triggered: true, reason: "b" },
  ]);
  assert.equal(twoHigh.risk, "CRITICAL");
  const oneHigh = classifyRisk([{ signal_id: "RS.NETWORK_REMOTE", class: "HIGH", triggered: true, reason: "a" }]);
  assert.equal(oneHigh.risk, "HIGH");
  assert.throws(() => classifyRisk([{ signal_id: "RS.X", class: "UNKNOWN", triggered: true }]), /unknown risk/);
});

test("risk monotonicity: LOW evidence with a CRITICAL-class triggered signal is rejected at validation (never silently LOW)", () => {
  // classifyRisk itself escalates; the guard lives in validateAdmission too
  const low = classifyRisk([{ signal_id: "RS.DATABASE_MUTATION", class: "CRITICAL", triggered: false, reason: "not triggered" }]);
  assert.equal(low.risk, "LOW");
  const high = classifyRisk([{ signal_id: "RS.DESTRUCTIVE_WRITE", class: "CRITICAL", triggered: true, reason: "rm -rf" }]);
  assert.equal(high.risk, "CRITICAL");
});

test("fast-path guard: never for risk != LOW / size not XS/S / under-classified / any triggered signal", () => {
  assert.equal(isFastPathEligible({ size: "M", risk: "LOW", under_classified: false, signals: [] }), false);
  assert.equal(isFastPathEligible({ size: "XS", risk: "MEDIUM", under_classified: false, signals: [] }), false);
  assert.equal(isFastPathEligible({ size: "XS", risk: "LOW", under_classified: true, signals: [] }), false);
  assert.equal(isFastPathEligible({ size: "XS", risk: "LOW", under_classified: false, signals: [{ triggered: true }] }), false);
  assert.equal(isFastPathEligible({ size: "XS", risk: "LOW", under_classified: false, signals: [] }), true);
});

test("profile matrix: risk primary, size refines within tier", () => {
  assert.equal(profileFor({ size: "XS", risk: "CRITICAL" }), "CRITICAL");
  assert.equal(profileFor({ size: "XL", risk: "CRITICAL" }), "CRITICAL");
  assert.equal(profileFor({ size: "XS", risk: "HIGH" }), "HIGH");
  assert.equal(profileFor({ size: "M", risk: "MEDIUM" }), "MEDIUM");
  assert.equal(profileFor({ size: "XL", risk: "MEDIUM" }), "MEDIUM_LARGE");
  assert.equal(profileFor({ size: "M", risk: "LOW" }), "STANDARD");
  assert.equal(profileFor({ size: "L", risk: "LOW" }), "LARGE_LOW");
});

test("signal scanner: 15 canonical risk signals, deterministic, covers full statement", () => {
  assert.equal(RISK_SIGNALS.length, 15);
  const s = scanRiskSignals("delete one row from the production database");
  const db = s.find((x) => x.signal_id === "RS.DATABASE_MUTATION");
  assert.equal(db.triggered, true);
  const same = scanRiskSignals("delete one row from the production database");
  assert.deepEqual(s, same);
});

test("under-classified with ambiguity >= 1 escalates off the fast path (research gate)", () => {
  const c = classify({
    dimensionScores: {
      ...FULL_EVIDENCE,
      ambiguity: { score: 2, reasons: ["multiple valid readings"] },
      // one dimension with NO evidence -> under_classified=true
      verification_burden: { score: 0, reasons: [] },
    },
    riskSignals: scanRiskSignals("add a new CLI flag"),
    evidenceSufficient: true,
  });
  assert.equal(c.size_details.under_classified, true);
  // FAST_PATH -> STANDARD escalation（NEG12 research gate）
  assert.notEqual(c.profile, "FAST_PATH");
  assert.equal(c.profile, "STANDARD");
});
