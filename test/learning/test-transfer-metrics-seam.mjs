// test/learning/test-transfer-metrics-seam.mjs
// T36-T37

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import {
  isTransferMetricsEnabled,
  recordTransferEvent,
  getTransferMetricsWriter,
  TRANSFER_METRICS_ENABLED,
  DISABLED_STATUS,
  PRODUCTION_EFFECT,
} from "../../src/learning/transfer-metrics/seam.mjs";
import { createTestRoot, makeEvent, makeIdentities, FIXTURE } from "../../src/learning/transfer-metrics/fixtures.mjs";

test("T36 disabled seam writes nothing", () => {
  const root = createTestRoot("t36");
  const before = existsSync(root) ? readdirSync(root) : [];
  const result = recordTransferEvent(makeEvent("INCIDENT_OBSERVED", makeIdentities("t36")), FIXTURE);
  assert.equal(result.status, DISABLED_STATUS);
  assert.equal(result.production_effect, PRODUCTION_EFFECT);
  assert.equal(isTransferMetricsEnabled(), false);
  assert.equal(TRANSFER_METRICS_ENABLED, false);
  assert.equal(getTransferMetricsWriter(), null);
  const after = readdirSync(root);
  assert.deepEqual(after, before);
});

test("T37 env/CLI/config cannot enable seam", () => {
  const previous = {
    TRANSFER_METRICS_ENABLED: process.env.TRANSFER_METRICS_ENABLED,
    AUTOLOOP_TRANSFER_METRICS: process.env.AUTOLOOP_TRANSFER_METRICS,
    TRANSFER_METRICS: process.env.TRANSFER_METRICS,
  };
  process.env.TRANSFER_METRICS_ENABLED = "true";
  process.env.AUTOLOOP_TRANSFER_METRICS = "1";
  process.env.TRANSFER_METRICS = "on";
  try {
    assert.equal(isTransferMetricsEnabled(), false);
    const result = recordTransferEvent({ env: "true" }, { role: "operator", identity: "x" });
    assert.equal(result.status, "DISABLED");
    assert.equal(result.production_effect, "NO_PRODUCTION_EFFECT");
    assert.equal(TRANSFER_METRICS_ENABLED, false);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
