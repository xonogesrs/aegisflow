// test/telemetry/test-telemetry-location.mjs
//
// S16 — telemetry authority/location/retention contract: code-frozen subset.
//
// Tests the contract invariants of src/telemetry/location.mjs:
//   - run-scoped resolution (identity binding mandatory, flat identity only)
//   - fail-closed rejection of $HOME, relative overrides, traversal
//   - env override precedence + isolation
//   - namespace separation as the authority fence: no GC_PROTECTED (R3/R4)
//     surface is assigned to the telemetry namespace; the canonical telemetry
//     root is a SIBLING of the authoritative evidence root
//   - retention assignment totality: every class value is a legal class.

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  TELEMETRY_ROOT,
  TELEMETRY_STATE_ROOT_ENV,
  RETENTION_CLASSES,
  TELEMETRY_RETENTION_ASSIGNMENT,
  retentionClassFor,
  isGcProtected,
  resolveTelemetryStateRoot,
} from "../../src/telemetry/location.mjs";

test("L1. resolution is run-scoped and deterministic", () => {
  const root = resolveTelemetryStateRoot({ graphRunId: "g1" });
  assert.equal(root, join(TELEMETRY_ROOT, "g1"));
  assert.equal(resolveTelemetryStateRoot({ graphRunId: "g1" }), root, "deterministic");
});

test("L2. identity binding is mandatory (no shared/global store root)", () => {
  assert.throws(() => resolveTelemetryStateRoot({ graphRunId: "" }), /graphRunId required/);
  assert.throws(() => resolveTelemetryStateRoot({ graphRunId: "  " }), /graphRunId required/);
  assert.throws(() => resolveTelemetryStateRoot({ graphRunId: "a/b" }), /flat identity/);
  assert.throws(() => resolveTelemetryStateRoot({ graphRunId: ".." }), /flat identity/);
});

test("L3. fail-closed: $HOME namespace and relative overrides rejected", () => {
  assert.throws(
    () => resolveTelemetryStateRoot({ graphRunId: "g1", env: { [TELEMETRY_STATE_ROOT_ENV]: homedir() } }),
    /rejected/,
  );
  assert.throws(
    () => resolveTelemetryStateRoot({ graphRunId: "g1", env: { [TELEMETRY_STATE_ROOT_ENV]: join(homedir(), "x") } }),
    /rejected/,
  );
  assert.throws(
    () => resolveTelemetryStateRoot({ graphRunId: "g1", env: { [TELEMETRY_STATE_ROOT_ENV]: "relative/path" } }),
    /absolute/,
  );
  // canonical namespace itself is not under $HOME
  assert.ok(!resolve(TELEMETRY_ROOT).startsWith(resolve(homedir())));
});

test("L4. env override wins and stays isolated from the canonical namespace", () => {
  const override = resolve("/tmp/s16-telemetry-test/store");
  const root = resolveTelemetryStateRoot({ graphRunId: "g1", env: { [TELEMETRY_STATE_ROOT_ENV]: override } });
  assert.equal(root, override, "override is the EXACT root (test isolation), not a child");
  assert.equal(resolveTelemetryStateRoot({ graphRunId: "g1", env: {} }), join(TELEMETRY_ROOT, "g1"));
  // blank override falls through to the canonical namespace
  assert.equal(resolveTelemetryStateRoot({ graphRunId: "g1", env: { [TELEMETRY_STATE_ROOT_ENV]: "  " } }), join(TELEMETRY_ROOT, "g1"));
});

test("L5. authority fence: no GC_PROTECTED surface lives in the telemetry namespace", () => {
  // The canonical telemetry root must be a SIBLING of (never inside) the
  // authoritative evidence root — namespace separation is the fence.
  assert.equal(TELEMETRY_ROOT, "/Volumes/NVM2T/Development/evidence/autoloop-telemetry");
  assert.ok(TELEMETRY_ROOT.endsWith("autoloop-telemetry"), "sibling of the evidence/autoloop root");
  assert.ok(!TELEMETRY_ROOT.startsWith("/Volumes/NVM2T/Development/evidence/autoloop/"), "not inside the authoritative root");
});

test("L6. retention assignment totality + legal classes", () => {
  const names = Object.keys(TELEMETRY_RETENTION_ASSIGNMENT);
  assert.ok(names.length >= 25, "contract Phase B surfaces all assigned");
  for (const name of names) {
    const cls = TELEMETRY_RETENTION_ASSIGNMENT[name];
    assert.ok(cls === null || RETENTION_CLASSES.includes(cls), `${name}: legal class`);
    assert.equal(retentionClassFor(name), cls);
  }
  assert.throws(() => retentionClassFor("noSuchSurface"), /unknown telemetry surface/, "unknown fails closed");
});

test("L7. GC protection boundary: R3/R4 protected, R0/R1/R2 eligible classes", () => {
  for (const cls of RETENTION_CLASSES) {
    assert.equal(isGcProtected(cls), cls === "R3" || cls === "R4");
  }
  // The two surfaces the contract marks CONTINUATION_REQUIRED / authority are protected.
  assert.equal(isGcProtected(retentionClassFor("ownedScratchResults")), true);
  assert.equal(isGcProtected(retentionClassFor("checkpointStore")), true);
  assert.equal(isGcProtected(retentionClassFor("telemetryEventStore")), false);
});
