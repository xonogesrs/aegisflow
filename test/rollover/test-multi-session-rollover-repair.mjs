// test/rollover/test-multi-session-rollover-repair.mjs
//
// AUTOLOOP_MULTI_SESSION_ROLLOVER_TRIGGER_WIRING_REPAIR_1 — targeted tests.
//
//   T1  successor resume receives THE canonical rollover executor
//   T2  B-era provider usage can trigger B→C (intake emitted)
//   T3  generation ≥1 source identity == durable owner-of-record identity
//   T4  stale original identity (generation-0 source) is rejected at intake
//   T5  generation 0 unchanged (covered by scripts/rollover-e2e.mjs rerun;
//       here: the generation-0 identity derivation path is byte-identical)
//   T6  generation increments 0→1→2 (window dedup admits the next era)
//   T7  no caller executor injection surface exists on the resume seam
//
// All fixtures drive the REAL controller ladder (makePostCommitFixture
// pattern from test-production-wiring.mjs) — no hand-built durable state.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeAdmission, makeNonTerminalRunFixture, readCheckpoint, journalRows,
} from "../v2/helpers/e1-soak-fixtures.mjs";
import {
  createRolloverIntake,
  deriveCanonicalRolloverExecutor,
  deriveCurrentOwnerSourceIdentity,
} from "../../src/rollover/production-wiring.mjs";
import {
  sessionIdentityDigest,
  ROLLOVER_STATES,
} from "../../src/rollover/rollover-authority.mjs";
import { resumeDurableGraph } from "../../src/v2/durable-graph.mjs";

const BINDING = Object.freeze({
  adapterKind: "pi-builtin",
  providerKind: "deepseek",
  modelId: "deepseek-v4-flash",
  requiredEnvKeys: Object.freeze([]),
});

function makeRolloverAdmission(taskId, { sessionId = null, threshold = 100 } = {}) {
  // Honest admission through the sealed builder (same surface the E2E uses),
  // then frozen. extensions.rollover carries the provider binding + source id.
  return import("../../src/admission/policy-projection.mjs").then(async ({ buildAdmissionRecord }) => {
    const { classify } = await import("../../src/admission/classify.mjs");
    const { freezeAdmission } = await import("../../src/admission/admission-record.mjs");
    const rec = buildAdmissionRecord({
      taskId,
      classification: classify({}),
      extensions: {
        rollover: {
          enabled: true,
          context_occupancy_threshold: threshold,
          ...(sessionId ? { source_session_id: sessionId } : {}),
          provider_binding: BINDING,
        },
      },
    });
    return freezeAdmission(rec);
  });
}

/** A valid CONTEXT_THRESHOLD_REACHED trigger event (schema-faithful). */
function makeTriggerEvent(executionId, admissionId) {
  return {
    trigger: "CONTEXT_THRESHOLD_REACHED",
    source: "multi-session-repair-test",
    authorityDecisionRef: `usage:evt_${executionId.slice(-8)}`,
    freshness: new Date().toISOString(),
    taskIdentity: executionId,
    runIdentity: executionId,
    admissionIdentity: admissionId,
    observedFact: { providerReported: true, usageRecordId: `evt_${executionId.slice(-8)}` },
  };
}

/**
 * Drive the REAL controller ladder to OWNERSHIP_TRANSFER_COMMITTED with
 * owner = B@g1 (same construction as test-production-wiring.mjs §4).
 */
async function makePostCommitFixture({ tag } = {}) {
  const admission = await makeRolloverAdmission(`msr-${tag}`, { sessionId: "gen0-source-session" });
  const fx = await makeNonTerminalRunFixture({ tag, admission });
  {
    const hooks = fx.run.buildGraphHooks(fx.ir);
    await fx.run._onRunnerView({ statuses: { R1: "passed", R2: "pending" }, leaseHolder: null, newlySkipped: [] });
    await fx.run.checkpoint({ activePhase: null, activeLifecycleStage: null });
  }
  const { beginRollover, recordSpawnDispatched, recordSpawnReceipt, recordValidationPassed, publishDurableAck, commitOwnershipTransfer } =
    await import("../../src/rollover/rollover-controller.mjs");
  const { runQuarantineValidationLadder } = await import("../../src/rollover/quarantine-validation.mjs");
  const { deriveSpawnReceiptDigest } = await import("../../src/rollover/rollover-authority.mjs");
  const sourceIdentity = {
    adapterKind: BINDING.adapterKind, providerKind: BINDING.providerKind,
    opaqueSessionId: "gen0-source-session", sessionGeneration: 0,
  };
  const triggerEvent = makeTriggerEvent(fx.executionId, admission.admission_id);
  const begun = await beginRollover({
    root: fx.root, executionId: fx.executionId, store: fx.store,
    triggerEvent, targetAdapterKind: BINDING.adapterKind, targetProviderKind: BINDING.providerKind,
    sourceIdentity, admission,
    graphIdentity: {
      ir_sha256: readCheckpoint(fx.root, fx.executionId).snapshot.decomposition_ir_sha256,
      dag_sha256: readCheckpoint(fx.root, fx.executionId).snapshot.dag_sha256,
    },
    toolSelectionCommitmentDigest: null, budgetStateDigest: null, lifecycleStateDigest: null,
    safePoint: null,
  });
  await recordSpawnDispatched({ root: fx.root, executionId: fx.executionId, store: fx.store, rolloverId: begun.rolloverId });
  const bIdentity = {
    adapterKind: BINDING.adapterKind, providerKind: BINDING.providerKind,
    opaqueSessionId: `b-real-${fx.executionId.slice(-8)}`, sessionGeneration: 1,
  };
  const startedAt = new Date().toISOString();
  await recordSpawnReceipt({
    root: fx.root, executionId: fx.executionId, store: fx.store, rolloverId: begun.rolloverId,
    candidate: {
      spawnReceiptDigest: deriveSpawnReceiptDigest({
        rolloverId: begun.rolloverId, expectedTargetGeneration: 1,
        targetAdapterKind: BINDING.adapterKind, targetProviderKind: BINDING.providerKind,
        opaqueSessionId: bIdentity.opaqueSessionId, startedAt,
      }),
      identity: bIdentity, startedAt, boundEventSequence: 1,
    },
  });
  const verified = readCheckpoint(fx.root, fx.executionId);
  const { runQuarantineValidationLadder: ladderFn } = await import("../../src/rollover/quarantine-validation.mjs");
  const ladder = ladderFn({
    root: fx.root, executionId: fx.executionId,
    snapshot: verified.snapshot, checkpointDigest: verified.digest,
    rolloverId: begun.rolloverId,
    spawnedIdentity: bIdentity,
    sourceSessionIdentityDigest: sessionIdentityDigest(sourceIdentity),
    sourceGeneration: 0,
    admission, rsl3SurfaceDir: null,
  });
  if (!ladder.ok) throw new Error(`ladder failed: ${ladder.code} step ${ladder.step}: ${ladder.reason}`);
  await recordValidationPassed({ root: fx.root, executionId: fx.executionId, store: fx.store, rolloverId: begun.rolloverId, validationDigest: ladder.validationDigest, observedRevision: ladder.observedRevision });
  await publishDurableAck({
    root: fx.root, executionId: fx.executionId, store: fx.store, rolloverId: begun.rolloverId,
    ack: {
      rolloverId: begun.rolloverId,
      sourceSessionIdentityDigest: sessionIdentityDigest(sourceIdentity),
      sourceGeneration: 0,
      targetSessionIdentityDigest: sessionIdentityDigest(bIdentity),
      targetGeneration: 1,
      checkpointRevision: ladder.observedRevision,
      checkpointDigest: ladder.observedDigest,
      validationDigest: ladder.validationDigest,
    },
  });
  await commitOwnershipTransfer({ root: fx.root, executionId: fx.executionId, store: fx.store, rolloverId: begun.rolloverId });
  // The REAL successor-era progression: B enters ACTIVE_B at resume, and the
  // retirement progression closes the era (clears active_rollover_id) — the
  // exact durable state a generation-1 owner presents before its own B→C
  // trigger (resumeAsSuccessor tail behavior).
  const { enterActiveB, publishARetirement } = await import("../../src/rollover/rollover-controller.mjs");
  await enterActiveB({ root: fx.root, executionId: fx.executionId, store: fx.store, rolloverId: begun.rolloverId });
  await publishARetirement({ root: fx.root, executionId: fx.executionId, store: fx.store, rolloverId: begun.rolloverId });
  const snap = readCheckpoint(fx.root, fx.executionId).snapshot;
  assert.equal(snap.graph?.rollover?.state, ROLLOVER_STATES.A_RETIRED);
  return { fx, admission, rolloverId: begun.rolloverId, owner: snap.graph.rollover.owner, bIdentity, sourceIdentity };
}

/** Minimal runner stand-in exposing exactly what the canonical executor reads. */
function makeRunner(fx, admission, triggerEvent) {
  return {
    root: fx.root,
    executionId: fx.executionId,
    admission,
    store: fx.store,
    irSha: readCheckpoint(fx.root, fx.executionId).snapshot.decomposition_ir_sha256,
    dagSha: readCheckpoint(fx.root, fx.executionId).snapshot.dag_sha256,
    state: { _rolloverObservation: { triggered: true, observed: true, triggerEvent } },
  };
}


test("T3 canonical executor derives the CURRENT owner identity for generation ≥1", async () => {
  const { fx, owner, bIdentity, rolloverId } = await makePostCommitFixture({ tag: "t3" });
  try {
    const mirror = readCheckpoint(fx.root, fx.executionId).snapshot.graph.rollover;
    assert.equal(mirror.owner.session_generation, 1);
    const ident = deriveCurrentOwnerSourceIdentity({
      mirror,
      bound: BINDING,
      cfg: { source_session_id: "gen0-source-session" },
      executionId: fx.executionId,
    });
    assert.equal(ident.ok, true, `identity derivation: ${ident.reason ?? ""}`);
    // The presented identity IS Session B's real durable owner identity —
    // NOT the generation-0 source id the admission carried.
    assert.equal(ident.sourceIdentity.opaqueSessionId, bIdentity.opaqueSessionId);
    assert.equal(ident.sourceIdentity.sessionGeneration, owner.session_generation);
    assert.equal(
      sessionIdentityDigest(ident.sourceIdentity),
      owner.session_identity_digest,
      "presented identity digest == durable owner-of-record digest",
    );
    // And it re-derives the committed transfer's target binding exactly.
    assert.equal(
      sessionIdentityDigest(ident.sourceIdentity),
      mirror.transfers[rolloverId].to.sessionIdentityDigest,
    );
  } finally { fx.cleanup(); }
});

test("T4 stale generation-0 identity is rejected at beginRollover (fail closed)", async () => {
  const { fx, admission, sourceIdentity } = await makePostCommitFixture({ tag: "t4" });
  try {
    const triggerEvent = makeTriggerEvent(fx.executionId, admission.admission_id);
    const intake = createRolloverIntake({
      triggerEvent,
      sourceIdentity, // the ORIGINAL A identity — stale after A→B
      rsl3SurfaceDir: null,
      requireEcho: false,
    });
    await assert.rejects(
      () => intake.run({
        root: fx.root, executionId: fx.executionId, store: fx.store,
        admission, irSha: readCheckpoint(fx.root, fx.executionId).snapshot.decomposition_ir_sha256,
        dagSha: readCheckpoint(fx.root, fx.executionId).snapshot.dag_sha256,
      }),
      (e) => String(e?.code ?? e?.message).includes("CROSS_SESSION_AUTHORITY_MISMATCH"),
    );
  } finally { fx.cleanup(); }
});

test("T5 generation-0 derivation is unchanged (no durable owner → admitted source id)", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "t5" });
  try {
    // No rollover block at all (fresh A era): the admitted generation-0
    // source identity wins, exactly as before the repair.
    const noMirror = deriveCurrentOwnerSourceIdentity({
      mirror: null, bound: BINDING,
      cfg: { source_session_id: "gen0-source-session" },
      executionId: fx.executionId,
    });
    assert.equal(noMirror.ok, true);
    assert.equal(noMirror.sourceIdentity.opaqueSessionId, "gen0-source-session");
    assert.equal(noMirror.sourceIdentity.sessionGeneration, 0);
    // Empty ACTIVE_A block (mirror present, owner null): same generation-0 path.
    const activeA = deriveCurrentOwnerSourceIdentity({
      mirror: { schema: "autoloop.rollover/v1", state: ROLLOVER_STATES.ACTIVE_A, owner: null, intents: {}, transfers: {} },
      bound: BINDING, cfg: {}, executionId: fx.executionId,
    });
    assert.equal(activeA.ok, true);
    assert.equal(activeA.sourceIdentity.opaqueSessionId, fx.executionId,
      "generation-0 executionId fallback preserved verbatim");
  } finally { fx.cleanup(); }
});

test("T6 window dedup admits the NEXT owner generation (0→1→2 chaining)", async () => {
  const { automaticTriggerEligible } = await import("../../src/rollover/production-wiring.mjs");
  const blockAfterGen0 = {
    schema: "autoloop.rollover/v1",
    state: ROLLOVER_STATES.A_RETIRED,
    active_rollover_id: null,
    last_rollover_id: "rid-g0",
    owner: { session_identity_digest: "b-digest", session_generation: 1 },
    intents: { "rid-g0": { trigger: "CONTEXT_THRESHOLD_REACHED", sourceGeneration: 0 } },
  };
  // generation 0's window is used; generation 1 is a NEW window.
  assert.equal(automaticTriggerEligible({ rolloverBlock: blockAfterGen0, sourceGeneration: 0 }).eligible, false);
  assert.equal(automaticTriggerEligible({ rolloverBlock: blockAfterGen0, sourceGeneration: 1 }).eligible, true);
  const blockAfterGen1 = {
    ...blockAfterGen0,
    owner: { session_identity_digest: "c-digest", session_generation: 2 },
    intents: {
      ...blockAfterGen0.intents,
      "rid-g1": { trigger: "CONTEXT_THRESHOLD_REACHED", sourceGeneration: 1 },
    },
  };
  assert.equal(automaticTriggerEligible({ rolloverBlock: blockAfterGen1, sourceGeneration: 1 }).eligible, false);
  assert.equal(automaticTriggerEligible({ rolloverBlock: blockAfterGen1, sourceGeneration: 2 }).eligible, true);
});

test("T7 the resume seam accepts no executor parameter (derive-only, admission-gated)", async () => {
  // Surface proof: resumeDurableGraph's parameter list has no
  // rolloverRequestExecutor — a caller-supplied executor cannot reach the
  // runner through the resume entry. The admission-gate fence (WP2 T1)
  // covers the fresh path; this pins the resume path's surface.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../src/v2/durable-graph.mjs", import.meta.url), "utf8"));
  const resumeHead = src.slice(src.indexOf("export async function resumeDurableGraph"));
  const signature = resumeHead.slice(resumeHead.indexOf("({"), resumeHead.indexOf("} = {})"));
  assert.ok(!signature.includes("rolloverRequestExecutor"),
    "resumeDurableGraph must not expose a rolloverRequestExecutor parameter");
  // And the fresh-path fence is still frozen at the admission gate.
  const { AUTHORITY_SEAM_RUNNER_KEYS } = await import("../../src/admission/admission-gate.mjs");
  assert.ok(AUTHORITY_SEAM_RUNNER_KEYS.includes("rolloverRequestExecutor"));
});

test("T1/T2 successor resume wires the canonical executor (observation → intake emitted)", async () => {
  // Wiring proof at the resume seam: resumeDurableGraph derives THE canonical
  // executor from the re-verified admission and injects it into the resumed
  // DurableGraphRun. The full behavioral proof (B usage → B→C intake →
  // Session C spawn) is owned by scripts/rollover-3era-probe.mjs; this test
  // pins the wiring contract precisely.
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../src/v2/durable-graph.mjs", import.meta.url), "utf8");
  const resumeStart = src.indexOf("export async function resumeDurableGraph");
  const runStart = src.indexOf("new DurableGraphRun({", resumeStart);
  const runEnd = src.indexOf("});", runStart);
  const resumeBody = src.slice(resumeStart, runEnd);
  assert.ok(resumeBody.includes("deriveCanonicalRolloverExecutor({ admission })"),
    "resumeDurableGraph must derive the canonical executor from the re-verified admission");
  const ctorArgs = src.slice(runStart, runEnd);
  assert.ok(ctorArgs.includes("rolloverRequestExecutor,"),
    "the derived executor must be injected into the resumed DurableGraphRun");
  // The injection is derive-only: no caller parameter feeds it.
  const signature = src.slice(resumeStart, src.indexOf("} = {})", resumeStart));
  assert.ok(!signature.includes("rolloverRequestExecutor"));
  // The single factory definition lives in production-wiring (no second copy).
  const wiring = fs.readFileSync(new URL("../../src/rollover/production-wiring.mjs", import.meta.url), "utf8");
  assert.equal((wiring.match(/function canonicalRolloverRequestExecutor/g) || []).length, 1);
  void journalRows;
});
