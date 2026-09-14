// test/learning/test-transfer-metrics-reducer.mjs
// T23-T35

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSFER_CODES, FORMULA_VERSION, canonical } from "../../src/learning/transfer-metrics/schema.mjs";
import { CANONICAL_METRICS, COMPANION_METRICS } from "../../src/learning/transfer-metrics/formulas.mjs";
import { reduceTransferMetrics, serializeDerived } from "../../src/learning/transfer-metrics/reducer.mjs";
import { readLog } from "../../src/learning/transfer-metrics/log.mjs";
import {
  FIXTURE, REVIEWER,
  makeIdentities, makeEvent, createTestWriter, expectCode, hex, iso, WINDOW,
} from "../../src/learning/transfer-metrics/fixtures.mjs";

function appendChain(writer, ids, { applicable = true, outcome = "PASS", grade = "C", overlay = "APPLICABLE" } = {}) {
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, occurred_at: iso(1) }),
    principal: FIXTURE,
  });
  const retr = writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids, {
      occurred_at: iso(2),
      applicability_decision: applicable ? "APPLICABLE" : "UNKNOWN",
    }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_USED_IN_PLANNING", ids, {
      occurred_at: iso(3),
      retrieval_event_id: retr.event.event_id,
    }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_USED_IN_VERIFICATION", ids, {
      occurred_at: iso(4),
      retrieval_event_id: retr.event.event_id,
    }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("OUTCOME_OBSERVED", ids, {
      occurred_at: iso(5),
      pattern_identity: null,
      payload: { final: outcome, hold_code: outcome === "HOLD" ? "H" : null, repair_attempts: outcome === "HOLD" ? 1 : 0, evidence_manifest_digest: ids.evidence_manifest_digest },
    }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("TRANSFER_ADJUDICATED", ids, {
      occurred_at: iso(6),
      subject_event_id: retr.event.event_id,
      authority: { ...FIXTURE },
      payload: {
        attribution_grade: grade,
        benefit_claimed: grade !== "A",
        adjudicator_role: "reviewer",
        counterfactual_digest: grade === "C" || grade === "D" ? ids.counterfactual_digest : null,
        detected_earlier: null,
        unnecessary_gate: null,
        overlay_applicability: overlay,
      },
    }),
    principal: FIXTURE,
  });
  return retr.event;
}

test("T23 15 canonical formulas present", () => {
  assert.equal(CANONICAL_METRICS.length, 15);
  const ids = makeIdentities("t23");
  const { writer } = createTestWriter(ids, {
    lifecycleTerminals: new Map([[ids.execution_id, { final: "PASS", attempt: 0 }]]),
  });
  appendChain(writer, ids, { grade: "C" });
  const doc = reduceTransferMetrics({ events: readLog(writer.root).events, window: WINDOW, formula_version: FORMULA_VERSION });
  for (const id of CANONICAL_METRICS) {
    assert.ok(doc.metrics[id], `missing ${id}`);
    assert.ok(["MEASURED", "NOT_MEASURABLE", "UNKNOWN"].includes(doc.metrics[id].status), id);
  }
});

test("T24 M1C M2C M12C companions present", () => {
  assert.equal(COMPANION_METRICS.length, 3);
  const ids = makeIdentities("t24");
  const { writer } = createTestWriter(ids);
  appendChain(writer, ids);
  const doc = reduceTransferMetrics({
    events: readLog(writer.root).events,
    window: WINDOW,
    formula_version: FORMULA_VERSION,
    applicable_universe: {
      episodes: [{ retrievalDigest: ids.retrievalDigest, pattern_ids: [ids.pattern_id], execution_id: ids.execution_id }],
    },
  });
  for (const id of COMPANION_METRICS) {
    assert.ok(doc.metrics[id], `missing ${id}`);
  }
  assert.equal(doc.metrics.M1C.status, "MEASURED");
});

test("T25 denominator zero is NOT_MEASURABLE null", () => {
  const doc = reduceTransferMetrics({
    events: [],
    window: WINDOW,
    formula_version: FORMULA_VERSION,
  });
  assert.equal(doc.metrics.M1.status, "NOT_MEASURABLE");
  assert.equal(doc.metrics.M1.value, null);
  assert.equal(doc.metrics.M2.status, "NOT_MEASURABLE");
});

test("T26 missing outcome is UNKNOWN not success", () => {
  const ids = makeIdentities("t26");
  const { writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids, { applicability_decision: "APPLICABLE" }),
    principal: FIXTURE,
  });
  const doc = reduceTransferMetrics({
    events: readLog(writer.root).events,
    window: WINDOW,
    formula_version: FORMULA_VERSION,
  });
  assert.equal(doc.metrics.M12.status, "UNKNOWN");
  assert.equal(doc.metrics.M12.value, null);
});

test("T27 retry inflation rejected", () => {
  const ids = makeIdentities("t27");
  const { writer } = createTestWriter(ids);
  const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  writer.appendTransferEvent({ event, principal: FIXTURE });
  writer.appendTransferEvent({ event, principal: FIXTURE });
  appendChain(writer, ids);
  const events = readLog(writer.root).events;
  const incidents = events.filter((e) => e.event_type === "INCIDENT_OBSERVED");
  assert.equal(incidents.length, 1);
  const doc = reduceTransferMetrics({ events, window: WINDOW, formula_version: FORMULA_VERSION });
  const outcomes = events.filter((e) => e.event_type === "OUTCOME_OBSERVED");
  assert.equal(outcomes.length, 1);
  void doc;
});

test("T28 UNKNOWN applicability excluded from positive transfer", () => {
  const ids = makeIdentities("t28");
  const { writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids, { applicability_decision: "UNKNOWN" }),
    principal: FIXTURE,
  });
  const doc = reduceTransferMetrics({
    events: readLog(writer.root).events,
    window: WINDOW,
    formula_version: FORMULA_VERSION,
  });
  assert.equal(doc.metrics.M1.status, "UNKNOWN");
  assert.equal(doc.metrics.M1.value, null);
});

test("T29 A/B do not count as verified benefit", () => {
  const ids = makeIdentities("t29");
  const { writer } = createTestWriter(ids);
  appendChain(writer, ids, { grade: "B", overlay: "APPLICABLE" });
  const doc = reduceTransferMetrics({
    events: readLog(writer.root).events,
    window: WINDOW,
    formula_version: FORMULA_VERSION,
  });
  assert.equal(doc.metrics.M12.status, "MEASURED");
  assert.equal(doc.metrics.M12.numerator, 0);
  assert.equal(doc.metrics.M3v.numerator, 0);
});

test("T30 C/D count as verified benefit", () => {
  const ids = makeIdentities("t30");
  const { writer } = createTestWriter(ids);
  appendChain(writer, ids, { grade: "C", overlay: "APPLICABLE" });
  const doc = reduceTransferMetrics({
    events: readLog(writer.root).events,
    window: WINDOW,
    formula_version: FORMULA_VERSION,
  });
  assert.equal(doc.metrics.M12.status, "MEASURED");
  assert.equal(doc.metrics.M12.numerator, 1);
  assert.equal(doc.metrics.M12.denominator, 1);
});

test("T31 mixed formula/schema version rejected", () => {
  const ids = makeIdentities("t31");
  const { writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  });
  const events = readLog(writer.root).events;
  expectCode(
    () => reduceTransferMetrics({ events, window: WINDOW, formula_version: "transfer-metrics-formulas/v2" }),
    TRANSFER_CODES.FORMULA_MIXED,
  );
  const mixed = [{ ...events[0], schema_version: "autoloop.transfer-event/v0" }, events[0]];
  expectCode(
    () => reduceTransferMetrics({ events: mixed, window: WINDOW, formula_version: FORMULA_VERSION }),
    TRANSFER_CODES.FORMULA_MIXED,
  );
});

test("T32 cross-project false mechanism match rejected via M11 NOT_MEASURABLE", () => {
  const ids = makeIdentities("t32");
  const { writer } = createTestWriter(ids);
  appendChain(writer, ids);
  const doc = reduceTransferMetrics({
    events: readLog(writer.root).events,
    window: WINDOW,
    formula_version: FORMULA_VERSION,
  });
  assert.equal(doc.metrics.M11.status, "NOT_MEASURABLE");
  assert.equal(doc.metrics.M11.value, null);
  assert.match(doc.metrics.M11.reason, /ISSUE_5_15/);
});

test("T33 raw log remains unchanged by reducer", () => {
  const ids = makeIdentities("t33");
  const { root, writer } = createTestWriter(ids);
  appendChain(writer, ids);
  const path = join(root, "transfer-events.jsonl");
  const before = readFileSync(path);
  reduceTransferMetrics({
    events: readLog(root).events,
    window: WINDOW,
    formula_version: FORMULA_VERSION,
  });
  const after = readFileSync(path);
  assert.deepEqual(before, after);
});

test("T34 reducer output is byte-deterministic", () => {
  const ids = makeIdentities("t34");
  const { writer } = createTestWriter(ids);
  appendChain(writer, ids);
  const events = readLog(writer.root).events;
  const a = reduceTransferMetrics({ events, window: WINDOW, formula_version: FORMULA_VERSION });
  const b = reduceTransferMetrics({ events, window: WINDOW, formula_version: FORMULA_VERSION });
  assert.equal(serializeDerived(a), serializeDerived(b));
  assert.equal(canonical(a), canonical(b));
  assert.ok(Array.isArray(a.event_ids));
  assert.equal(a.formula_version, FORMULA_VERSION);
});

test("T35 M11 and M14 remain NOT_MEASURABLE", () => {
  const ids = makeIdentities("t35");
  const { writer } = createTestWriter(ids);
  appendChain(writer, ids);
  writer.appendTransferEvent({
    event: makeEvent("STALE_PATTERN_REJECTED", ids, { occurred_at: iso(7) }),
    principal: FIXTURE,
  });
  const doc = reduceTransferMetrics({
    events: readLog(writer.root).events,
    window: WINDOW,
    formula_version: FORMULA_VERSION,
  });
  assert.equal(doc.metrics.M11.status, "NOT_MEASURABLE");
  assert.equal(doc.metrics.M11.value, null);
  assert.equal(doc.metrics.M14.status, "NOT_MEASURABLE");
  assert.equal(doc.metrics.M14.value, null);
});
