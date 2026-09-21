// test/rollover/test-usage-observation-crash-seam.mjs
//
// WP1 E3 — crash-seam targeted verification for the usage-observation
// journaling window:
//
//   usage journaled (PROVIDER_USAGE_OBSERVED / ROLLOVER_USAGE_OBSERVATION_FAILED)
//     -> crash BEFORE the phase-terminal checkpoint
//     -> resume
//
// Required: no false RESUME_FINGERPRINT_MISMATCH — the usage markers are
// journaled at the phase-terminal observation point BEFORE the phase-terminal
// checkpoint, so a crash in that sub-window leaves them BEYOND the checkpoint
// head. They are pure observability records (the producer re-observes from
// live provider usage at the next boundary; the window-dedup authority is the
// durable rollover block, never the usage rows), so POST_HEAD_EVENT_SEMANTICS
// classifies them replay-safe and resume proceeds.
// Also: a genuinely inconsistent post-head event still fails closed.
//
// Run: node --test test/rollover/test-usage-observation-crash-seam.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  makeNonTerminalRunFixture, readCheckpoint, journalRows,
} from "../v2/helpers/e1-soak-fixtures.mjs";
import { observeProviderUsageAndTrigger } from "../../src/rollover/production-wiring.mjs";
import { classifyPostHeadEvent } from "../../src/v2/checkpoint-bridge.mjs";
import { resumeDurableGraph } from "../../src/v2/durable-graph.mjs";
import { classify } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";

// A rollover-enabled admission with the threshold FROZEN at admission time
// (extensions ride the digest — post-freeze extension injection would be
// ADMISSION_DRIFT on resume). Below-threshold usage: observation without a
// fabricated trigger. The provider_binding is required for any
// rollover-enabled admission (CROSS_SESSION_SUCCESSOR_IDENTITY gate); it is
// never exercised by these tests (no successor spawn — usage stays below
// threshold).
const E3_BINDING = Object.freeze({
  adapterKind: "pi-builtin",
  providerKind: "merge-gateway",
  modelId: "zai/glm-5.3-flash",
  requiredEnvKeys: Object.freeze(["MERGE_GATEWAY_API_KEY"]),
});

function makeRolloverAdmission(taskId) {
  return freezeAdmission(buildAdmissionRecord({
    taskId,
    classification: classify({}),
    extensions: {
      rollover: {
        enabled: true,
        context_occupancy_threshold: 10000,
        provider_binding: E3_BINDING,
      },
    },
  }));
}

// ── crash window reproduction: usage journaled AFTER the last checkpoint ──

test("E3: usage journaled then crash before phase-terminal checkpoint -> resume sees it replay-safe (no false RESUME_FINGERPRINT_MISMATCH)", async () => {
  const admission = makeRolloverAdmission("e3-crash");
  const fx = await makeNonTerminalRunFixture({ tag: "e3-crash", admission });
  try {
    // The observation point fires at phase terminal, BEFORE the phase-terminal
    // checkpoint. The fixture's last checkpoint predates the observation, so
    // journaling usage NOW leaves the event beyond the checkpoint head — the
    // exact crash sub-window (usage journaled -> crash -> no checkpoint).
    const r = observeProviderUsageAndTrigger({
      store: fx.store, admission, executionId: fx.executionId, phaseId: "R1",
      usage: { input: 10, cacheRead: 0, cacheWrite: 0 },
    });
    assert.equal(r.triggered, false);
    assert.equal(r.observed, true);
    const usageRows = journalRows(fx.store, ["PROVIDER_USAGE_OBSERVED"]);
    assert.equal(usageRows.length, 1, "usage row journaled");

    // crash-window precondition: the event IS beyond the checkpoint head
    const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.ok(snap.journal_head_sequence < usageRows[0].sequence, "usage row is post-head (crash sub-window reproduced)");

    // resume: the post-head scan must classify PROVIDER_USAGE_OBSERVED
    // replay-safe and proceed — never a false RESUME_FINGERPRINT_MISMATCH.
    let thrown = null;
    let result = null;
    try {
      result = await resumeDurableGraph({
        persistenceRoot: fx.root,
        executionId: fx.executionId,
        parent: { scope: {} },
        manifest: [{ requirement_id: "r1", text: "e3" }],
        cwd: fx.repo,
        repoPath: fx.repo,
        scratchRoot: fx.scratch,
        maxRepairAttempts: 1,
        timeoutMs: 60000,
        signal: undefined,
        hooks: {},
        dirtyScope: [],
        admission,
        executorAdapterFactory: () => ({ runAdapter: async (req) => ({ status: "error", executionId: req.executionId, error: "e3:offline-stub", stdout: "", stderr: "", metadata: {} }) }),
        reviewerAdapterFactory: () => ({ runAdapter: async (req) => ({ status: "error", executionId: req.executionId, error: "e3:offline-stub", stdout: "", stderr: "", metadata: {} }) }),
      });
    } catch (e) { thrown = e; }
    assert.equal(thrown, null, `resume must not throw on a post-head usage row (got ${thrown?.code}: ${thrown?.message?.slice(0, 120)})`);
    assert.ok(result, "resume returned a result");
    assert.notEqual(result?.reason, undefined);
    assert.ok(
      !String(result?.reason ?? "").startsWith("RESUME_FINGERPRINT_MISMATCH"),
      `no false RESUME_FINGERPRINT_MISMATCH (reason=${result?.reason})`,
    );
  } finally { fx.cleanup(); }
});

test("E3: observation-failure marker journaled then crash -> resume proceeds (replay-safe)", async () => {
  const admission = makeRolloverAdmission("e3-fail");
  const fx = await makeNonTerminalRunFixture({ tag: "e3-fail", admission });
  try {
    const r = observeProviderUsageAndTrigger({
      store: fx.store, admission, executionId: fx.executionId, phaseId: "R1",
      usage: null, // malformed/absent usage -> ROLLOVER_USAGE_OBSERVATION_FAILED
    });
    assert.equal(r.observed, false);
    const failRows = journalRows(fx.store, ["ROLLOVER_USAGE_OBSERVATION_FAILED"]);
    assert.equal(failRows.length, 1, "observation-failure row journaled");
    const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.ok(snap.journal_head_sequence < failRows[0].sequence, "failure row is post-head (crash sub-window reproduced)");

    let thrown = null;
    try {
      await resumeDurableGraph({
        persistenceRoot: fx.root,
        executionId: fx.executionId,
        parent: { scope: {} },
        manifest: [{ requirement_id: "r1", text: "e3" }],
        cwd: fx.repo,
        repoPath: fx.repo,
        scratchRoot: fx.scratch,
        maxRepairAttempts: 1,
        timeoutMs: 60000,
        signal: undefined,
        hooks: {},
        dirtyScope: [],
        admission,
        executorAdapterFactory: () => ({ runAdapter: async (req) => ({ status: "error", executionId: req.executionId, error: "e3:offline-stub", stdout: "", stderr: "", metadata: {} }) }),
        reviewerAdapterFactory: () => ({ runAdapter: async (req) => ({ status: "error", executionId: req.executionId, error: "e3:offline-stub", stdout: "", stderr: "", metadata: {} }) }),
      });
    } catch (e) { thrown = e; }
    assert.equal(thrown, null, `resume must not throw on a post-head observation-failure row (got ${thrown?.code})`);
  } finally { fx.cleanup(); }
});

test("E3: genuinely inconsistent post-head event still fails closed", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "e3-neg" });
  try {
    // an UNKNOWN event beyond the head: the post-head scan must still reject
    fx.store.appendEvent({ event_type: "TOTALLY_UNKNOWN_EVENT", stage: "run", payload: {} });
    const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
    assert.equal(classifyPostHeadEvent("TOTALLY_UNKNOWN_EVENT"), "invalid");
    let thrown = null;
    try {
      await resumeDurableGraph({
        persistenceRoot: fx.root,
        executionId: fx.executionId,
        parent: { scope: {} },
        manifest: [{ requirement_id: "r1", text: "e3" }],
        cwd: fx.repo,
        repoPath: fx.repo,
        scratchRoot: fx.scratch,
        maxRepairAttempts: 1,
        timeoutMs: 60000,
        signal: undefined,
        hooks: {},
        dirtyScope: [],
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown, "unknown post-head event must fail closed");
    assert.equal(thrown?.code, "RESUME_FINGERPRINT_MISMATCH");
    assert.match(String(thrown?.message), /TOTALLY_UNKNOWN_EVENT beyond checkpoint head/);
  } finally { fx.cleanup(); }
});
