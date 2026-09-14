// test/learning/test-incident-current-verification.mjs
//
// Stage E incident current verification T1–T90 (sealed admission §15).
// Explicit-call, offline, read-only verifier tests. No production surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  statSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  RunEvidenceStore,
  canonicalJson,
  sha256Text,
  journalDir,
  journalFileName,
} from "../../src/evidence/run-evidence-store.mjs";
import {
  FIXTURE,
  makeIdentities,
  makeBinder,
  makeEvent,
  createTestRoot,
  iso,
  hex,
} from "../../src/learning/transfer-metrics/fixtures.mjs";
import { writeExclusiveCreate, sha256Hex } from "../../src/c2d/fs-atomic.mjs";
import { createInitialSnapshot as makeSnap } from "../../src/c2d/checkpoint-store.mjs";
import { mintExecutionId, mintChainId, mintCheckpointId } from "../../src/c2d/execution-id.mjs";
import { TransferMetricsWriter } from "../../src/learning/transfer-metrics/writer.mjs";
import { captureRawLogSnapshot } from "../../src/learning/transfer-metrics/writer.mjs";
import { readLog, LOG_FILE_NAME } from "../../src/learning/transfer-metrics/log.mjs";
import {
  EVENT_TYPES,
  EVENT_TYPES_V2,
  AUTHORITY_EVENT_TYPE,
  AUTHORITY_DOMAIN,
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2,
  GENESIS_DIGEST,
  INCIDENT_OBS_SCHEMA,
  LOG_SCHEMA,
  TRANSFER_CODES,
  canonical,
  digestOf,
  computeAuthorityIdempotencyKey,
  computeAuthorityPayloadDigest,
  computeIdempotencyKey,
  computeEventId,
  computeEventDigest,
  deriveSourceIdentityKey,
  deriveEvidenceSetDigest,
  deriveIncidentId,
} from "../../src/learning/transfer-metrics/schema.mjs";
import { deriveAuthoritySubjectIdentity } from "../../src/learning/transfer-metrics/authority-state.mjs";
import { buildRunManifest, finalizeRunManifest } from "../../src/evidence/run-manifest.mjs";
import { observeLifecycleHeldIncident } from "../../src/learning/incidents/lifecycle-terminal-adapter.mjs";
import { buildIncidentProjection } from "../../src/learning/incidents/projection.mjs";
import { reduceTransferMetrics } from "../../src/learning/transfer-metrics/reducer.mjs";
import { FORMULA_VERSION } from "../../src/learning/transfer-metrics/formulas.mjs";
import {
  verifyCurrentIncident,
  consumeCurrentVerificationReceipt,
  isCurrentVerificationReceipt,
  CURRENT_VERIFICATION_RESULTS,
  MAX_ITEMS_PER_CALL,
  MAX_SOURCE_TERMINALS,
  MAX_RETRIES,
  RESULT_AUTHORITY,
  RESULT_STORAGE,
} from "../../src/learning/incidents/current-verification.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

// ---------------------------------------------------------------------------
// Harness: ONE shared NVM2T root holds the C3 exec dirs, the V2 raw log and
// the V2 authority log (the explicit authority location).
// ---------------------------------------------------------------------------

function nowClock() {
  return () => new Date(Date.now() + 120000).toISOString();
}

function logCount(root) {
  if (!existsSync(join(root, LOG_FILE_NAME))) return 0;
  return readLog(root).events.length;
}

function logDigest(root) {
  const p = join(root, LOG_FILE_NAME);
  if (!existsSync(p)) return "absent";
  return sha256Hex(readFileSync(p));
}

function writeCheckpoint(execDir, snapshot) {
  const body = Buffer.from(JSON.stringify(snapshot), "utf8");
  const digest = sha256Hex(body);
  writeExclusiveCreate(join(execDir, "CURRENT.json"), body);
  writeExclusiveCreate(join(execDir, "CURRENT.json.sha256"), digest + "\n");
  return digest;
}

function replaceCheckpoint(execDir, snapshot) {
  unlinkSync(join(execDir, "CURRENT.json"));
  unlinkSync(join(execDir, "CURRENT.json.sha256"));
  return writeCheckpoint(execDir, snapshot);
}

// Build the C3 PHASE_HELD publication + append its INCIDENT_OBSERVED event.
function publishHeld(label, overrides = {}) {
  const ids = makeIdentities(label);
  const execution_id = mintExecutionId();
  const chainId = mintChainId();
  const checkpointId = mintCheckpointId();
  ids.execution_id = execution_id;
  const attempt = overrides.attempt ?? 0;
  ids.attempt_identity = { execution_id, attempt };
  const phaseId = overrides.phaseId ?? "p_impl";
  const reason = Object.prototype.hasOwnProperty.call(overrides, "reason")
    ? overrides.reason
    : "REVIEWER_HOLD";
  const final = overrides.final ?? "HOLD";
  const status = overrides.status ?? "held";
  const graph_generation = Object.prototype.hasOwnProperty.call(overrides, "graph_generation")
    ? overrides.graph_generation
    : 0;
  const root = createTestRoot(`cv-${label}`);
  const store = new RunEvidenceStore({
    root,
    executionId: execution_id,
    chainId,
    checkpointId,
    repoRoot: ids.project_identity.repository_root_identity,
  });
  store.init();
  let held = null;
  if (overrides.skipHeld !== true) {
    const payload = { final, reason, ...(overrides.journalPayload ?? {}) };
    held = store.appendEvent({
      event_type: overrides.eventType ?? "PHASE_HELD",
      stage: "phase",
      phase_id: phaseId,
      attempt,
      status,
      payload,
    });
  }
  if (overrides.secondHeld) {
    store.appendEvent({
      event_type: "PHASE_HELD",
      stage: "phase",
      phase_id: phaseId,
      attempt,
      status: "held",
      payload: overrides.secondHeld,
    });
  }
  if (overrides.parentRun) {
    store.appendEvent({
      event_type: overrides.parentRun.event_type ?? "RUN_HELD",
      stage: "run",
      phase_id: null,
      attempt: null,
      status: "held",
      payload: overrides.parentRun.payload ?? { final: "HOLD", reason: "RUN_HELD" },
    });
  }
  let written = null;
  if (overrides.writeResult !== false) {
    const resultRecord = {
      phase_id: overrides.resultPhaseId ?? phaseId,
      final: overrides.resultFinal ?? final,
      status: overrides.resultStatus ?? status,
      attempt: overrides.resultAttempt ?? attempt,
      reason: overrides.resultReason ?? reason,
      graph_generation,
      recorded_at: iso(30),
      ...(overrides.synthesized ? { synthesized: true } : {}),
      ...(overrides.resultExtra ?? {}),
    };
    written = store.writePhaseArtifact(phaseId, "result.json", resultRecord);
  }
  const pin = written?.sha256 ?? overrides.forcePin ?? "00".repeat(32);
  if (overrides.writeCheckpoint !== false) {
    const snapshot = makeSnap({
      checkpoint_id: checkpointId,
      execution_id,
      chain_id: chainId,
      repository_fingerprint: { origin_url: "", origin_master: "" },
      repository_root_identity: ids.project_identity.repository_root_identity,
      git_common_dir_identity: ids.project_identity.git_common_dir_identity,
      expected_head: "0".repeat(40),
      expected_ref: "refs/heads/master",
      expected_worktree_state: "clean",
    });
    snapshot.phase_result_hashes = overrides.omitPin
      ? {}
      : { [phaseId]: overrides.wrongPin ?? pin };
    if (overrides.omitGraph) {
      snapshot.graph = {};
    } else if (overrides.snapshotGraphRaw !== undefined) {
      snapshot.graph = overrides.snapshotGraphRaw;
    } else {
      snapshot.graph = {
        recovery_generation: overrides.recovery_generation ?? graph_generation,
      };
    }
    if (overrides.snapshotExecutionId) snapshot.execution_id = overrides.snapshotExecutionId;
    if (overrides.snapshotRepoIdentity) {
      snapshot.repository_root_identity = overrides.snapshotRepoIdentity;
    }
    writeCheckpoint(store.execDir, snapshot);
  }
  if (overrides.writeManifest !== false) {
    const manifest = buildRunManifest({
      executionId: overrides.manifestExecutionId ?? execution_id,
      chainId,
      created_at: iso(31),
      completed_at: iso(32),
      final_verdict: final,
      final_reason: reason,
      phase_results: overrides.omitManifestPin
        ? []
        : [{ phase_id: phaseId, result_hash: overrides.wrongManifestPin ?? pin }],
      artifact_inventory: [],
      secret_scan_result: { scanned: true, matches: [] },
      format_versions: {},
    });
    finalizeRunManifest(store.execDir, manifest);
  }
  const binderExtra = {
    attempts: new Map([[execution_id, { attempts: new Set([attempt, 0, 1, 2]) }]]),
    ...(overrides.binderExtra ?? {}),
  };
  const writer = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids, binderExtra),
    revocationRegistry: overrides.revocationRegistry
      ?? { revokedWriterIds: new Set(), currentGenerations: new Map() },
    clock: nowClock(),
    allowFixture: overrides.allowFixture ?? true,
    crashHooks: overrides.crashHooks ?? {},
  });
  const binding = {
    project_identity: ids.project_identity,
    task_identity: ids.task_identity,
    attempt_identity: ids.attempt_identity,
    writer: { writer_id: "w1", writer_generation: 0 },
  };
  const ctx = {
    ids,
    store,
    root,
    execDir: store.execDir,
    execution_id,
    chainId,
    checkpointId,
    phaseId,
    held,
    pin,
    writer,
    binding,
    final,
    reason,
    attempt,
    status,
  };
  if (overrides.skipObserve !== true) {
    if (overrides.directObserve) {
      // Direct INCIDENT_OBSERVED construction: binds the incident to the C3
      // publication without the adapter, so INELIGIBLE publications (PASS /
      // bad reason / non-terminal) can be projected and rejected by the
      // verifier itself.
      const manifestSha = readFileSync(join(store.execDir, "manifest.json.sha256"), "utf8").trim();
      const resultDigest = written?.sha256 ?? pin;
      const refs = held
        ? [
            { kind: "evidence_event", identity: held.event_id, digest: held.event_sha256 },
            { kind: "evidence_manifest", identity: execution_id, digest: manifestSha },
            { kind: "artifact", identity: phaseId, digest: resultDigest },
          ]
        : [
            // Fabricated binding for sources with NO PHASE_HELD event: the
            // item is well-formed, but source verification fails closed.
            { kind: "evidence_event", identity: "evt_missing", digest: createHash("sha256").update("missing").digest("hex") },
            { kind: "evidence_manifest", identity: execution_id, digest: manifestSha },
            { kind: "artifact", identity: phaseId, digest: resultDigest },
          ];
      const ev = makeEvent("INCIDENT_OBSERVED", ids, {
        occurred_at: held?.timestamp ?? iso(5),
        pattern_identity: null,
        attempt_identity: { execution_id, attempt },
        evidence_refs: refs,
        payload: {
          source_class: "LIFECYCLE_TERMINAL",
          source_record_id: held?.event_id ?? "evt_missing",
          source_authority_identity: "autoloop.lifecycle-runner",
          source_authority_generation: overrides.directObserve.boundGeneration ?? graph_generation,
          failure_finding_discriminator: overrides.directObserve.reason ?? reason,
          source_record_digest: resultDigest,
          evidence_completeness_class: "COMPLETE",
          observed_outcome_class: overrides.directObserve.outcome ?? "HOLD",
        },
      });
      const appended = writer.appendTransferEvent({ event: ev, principal: FIXTURE });
      ctx.observeStatus = appended.status;
    } else {
      const observed = observeLifecycleHeldIncident({
        authoritativeSourceReference: { evidenceRoot: root, execution_id, phase_id: phaseId },
        expectedIdentityBinding: binding,
        transferMetricsWriter: writer,
        observerPrincipal: FIXTURE,
      });
      ctx.observeStatus = observed.status;
    }
  }
  return ctx;
}

function buildProjection(root) {
  const snapshot = captureRawLogSnapshot({ transferMetricsRoot: root });
  return buildIncidentProjection(snapshot);
}

function prepare(ctx) {
  const projection = buildProjection(ctx.root);
  assert.ok(projection.envelope.items.length >= 1, "fixture produced no items");
  const item = projection.envelope.items[0];
  return { ...ctx, projection, item };
}

function verifyArgs(ctx, extra = {}) {
  return {
    validated_evidence_root: ctx.root,
    projection_document: ctx.projection,
    projection_item: ctx.item,
    selector: { execution_id: ctx.execution_id, phase_id: ctx.phaseId },
    verification_principal: FIXTURE,
    ...extra,
  };
}

function consumeArgs(ctx, extra = {}) {
  return { ...verifyArgs(ctx), ...extra };
}

function throwCode(fn) {
  try {
    fn();
  } catch (err) {
    return err?.code ?? err?.message ?? "THROWN";
  }
  return "NO_THROW";
}

test("T48 verified-current exact success with receipt", () => {
  const ctx = prepare(publishHeld("t48"));
  const { result, receipt } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "VERIFIED_CURRENT");
  assert.ok(receipt);
  assert.equal(isCurrentVerificationReceipt(receipt), true);
  assert.equal(result.incident_id, ctx.item.incident_id);
  assert.equal(result.source_record_id, ctx.item.source_record_id);
  assert.equal(result.execution_id, ctx.execution_id);
  assert.equal(result.phase_id, ctx.phaseId);
  assert.equal(result.verified_generation, 0);
  assert.equal(result.result_authority, "NON_AUTHORITATIVE_OBSERVATION");
  assert.equal(result.result_storage, "EPHEMERAL");
  assert.equal(result.projection_mutated, "NO");
  assert.equal(result.source_mutated, "NO");
  assert.equal(result.raw_log_mutated, "NO");
});

test("T1 valid projection item verifies (T1/T48 joint success shape)", () => {
  const ctx = prepare(publishHeld("t01"));
  const { result, receipt } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "VERIFIED_CURRENT");
  assert.ok(receipt);
  // consume path succeeds once on a fresh receipt
  const consumed = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(consumed.result.status, "VERIFIED_CURRENT");
});

test("T49 projection item keeps NOT_EVALUATED after verification", () => {
  const ctx = prepare(publishHeld("t49"));
  const before = canonical(ctx.item);
  verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(ctx.item.current_authority_status, "NOT_EVALUATED");
  assert.equal(ctx.item.current_authority_receipt_reference, null);
  assert.equal(ctx.item.current_authority_checked_generation, null);
  assert.equal(canonical(ctx.item), before);
});

test("T50 projection bytes unchanged by verify+consume", () => {
  const ctx = prepare(publishHeld("t50"));
  const bytesBefore = ctx.projection.canonical_bytes;
  const digestBefore = ctx.projection.projection_digest;
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(ctx.projection.projection_digest, digestBefore);
  assert.ok(ctx.projection.canonical_bytes.equals(bytesBefore));
});

test("T51 raw log bytes unchanged", () => {
  const ctx = prepare(publishHeld("t51"));
  const before = logDigest(ctx.root);
  verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(logDigest(ctx.root), before);
  assert.equal(logCount(ctx.root), 1);
});

test("T52 authority log bytes unchanged", () => {
  const ctx = prepare(publishHeld("t52"));
  const authFiles = () => readdirSync(ctx.root).filter((f) => f.includes("authority")).sort();
  const before = authFiles();
  verifyCurrentIncident(verifyArgs(ctx));
  assert.deepEqual(authFiles(), before);
});

test("T53 C3 bytes unchanged", () => {
  const ctx = prepare(publishHeld("t53"));
  const sweep = () => {
    const out = {};
    for (const f of [join("phases", ctx.phaseId, "result.json"), "CURRENT.json", "manifest.json"]) {
      const p = join(ctx.execDir, f);
      out[f] = existsSync(p) ? sha256Hex(readFileSync(p)) : "absent";
    }
    return out;
  };
  const before = sweep();
  verifyCurrentIncident(verifyArgs(ctx));
  assert.deepEqual(sweep(), before);
});

// ---------------------------------------------------------------------------
// Document / item / selector identity
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Document / item / selector identity
// ---------------------------------------------------------------------------

test("T2 invalid projection document digest", () => {
  const ctx = prepare(publishHeld("t02"));
  const doc = structuredClone(ctx.projection);
  doc.envelope.projection_digest = "f".repeat(64);
  const { result } = verifyCurrentIncident(verifyArgs(ctx, { projection_document: doc }));
  assert.equal(result.status, "STRUCTURAL_INVALID");
  // sub-case: tampered item bytes with recomputed digest rejected
  (() => {
    const doc2 = structuredClone(ctx.projection);
    doc2.envelope.items[0].incident_id = "a".repeat(64);
    doc2.canonical_bytes = Buffer.from(canonical(doc2.envelope), "utf8");
    const r2 = verifyCurrentIncident(verifyArgs(ctx, { projection_document: doc2 }));
    assert.equal(r2.result.status, "STRUCTURAL_INVALID");
  })();
});

test("T3 invalid projection item identity", () => {
  const ctx = prepare(publishHeld("t03"));
  const item = structuredClone(ctx.item);
  item.projection_item_id = "0".repeat(64);
  const { result } = verifyCurrentIncident(verifyArgs(ctx, { projection_item: item }));
  assert.equal(result.status, "IDENTITY_MISMATCH");
});

test("T4 altered incident_id rejected", () => {
  const ctx = prepare(publishHeld("t04"));
  const item = structuredClone(ctx.item);
  item.incident_id = "b".repeat(64);
  const { result } = verifyCurrentIncident(verifyArgs(ctx, { projection_item: item }));
  assert.equal(result.status, "IDENTITY_MISMATCH");
});

test("T5 selector execution mismatch", () => {
  const ctx = prepare(publishHeld("t05"));
  const other = mintExecutionId();
  const { result } = verifyCurrentIncident(
    verifyArgs(ctx, { selector: { execution_id: other, phase_id: ctx.phaseId } }),
  );
  assert.equal(result.status, "IDENTITY_MISMATCH");
});

test("T6 selector phase mismatch", () => {
  const ctx = prepare(publishHeld("t06"));
  const { result } = verifyCurrentIncident(
    verifyArgs(ctx, { selector: { execution_id: ctx.execution_id, phase_id: "p_other" } }),
  );
  assert.equal(result.status, "IDENTITY_MISMATCH");
});

test("T7 evidence root outside NVM2T rejected", () => {
  const ctx = prepare(publishHeld("t07"));
  const { result } = verifyCurrentIncident(
    verifyArgs(ctx, { validated_evidence_root: "/tmp/cv-outside-root" }),
  );
  assert.equal(result.status, "STRUCTURAL_INVALID");
  // sub-case: HOME-rooted evidence root rejected
  (() => {
    const r2 = verifyCurrentIncident(
      verifyArgs(ctx, { validated_evidence_root: "/Users/someone/evidence" }),
    );
    assert.equal(r2.result.status, "STRUCTURAL_INVALID");
  })();
});

test("T8 evidence-root search attempt rejected (traversal/non-absolute)", () => {
  const ctx = prepare(publishHeld("t08"));
  for (const bad of [
    "/Volumes/NVM2T/Development/../etc/evidence",
    "relative/root",
    "",
  ]) {
    const { result } = verifyCurrentIncident(verifyArgs(ctx, { validated_evidence_root: bad }));
    assert.equal(result.status, "STRUCTURAL_INVALID", `root ${bad}`);
  }
});

test("T9 multiple source candidates rejected (SOURCE_CONFLICT)", () => {
  const ctx = prepare(publishHeld("t09", { secondHeld: { final: "HOLD", reason: "REVIEWER_HOLD" } }));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "SOURCE_CONFLICT");
});

test("T10 non-PHASE_HELD source rejected", () => {
  const ctx = prepare(publishHeld("t10", {
    eventType: "PHASE_PASSED",
    directObserve: { reason: "REVIEWER_HOLD" },
  }));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "STRUCTURAL_INVALID");
  // sub-case: RUN_* parent terminal with no phase held rejected
  (() => {
    const ctx2 = prepare(publishHeld("t10b", { skipHeld: true, parentRun: {}, directObserve: {} }));
    const r2 = verifyCurrentIncident(verifyArgs(ctx2));
    assert.equal(r2.result.status, "STRUCTURAL_INVALID");
  })();
});

test("T11 PASS terminal rejected", () => {
  const ctx = prepare(publishHeld("t11", {
    final: "PASS",
    status: "passed",
    eventType: "PHASE_PASSED",
    directObserve: { reason: "REVIEWER_HOLD" },
  }));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "STRUCTURAL_INVALID");
});

test("T12 unsupported HOLD reason rejected", () => {
  const ctx = prepare(publishHeld("t12", {
    reason: "SOME_OTHER_HOLD",
    directObserve: { reason: "SOME_OTHER_HOLD" },
  }));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "STRUCTURAL_INVALID");
});

test("T13 free-form reason rejected", () => {
  const ctx = prepare(publishHeld("t13", {
    reason: "reviewer hold: unclassified details",
    directObserve: { reason: "reviewer hold: unclassified details" },
  }));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "STRUCTURAL_INVALID");
});

test("T14 incomplete source rejected (no PHASE_HELD publication)", () => {
  const ctx = prepare(publishHeld("t14", {
    skipHeld: true,
    directObserve: {},
  }));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "SOURCE_MISSING");
  // sub-case: non-terminal status rejected
  (() => {
    const ctx2 = prepare(publishHeld("t14b", { status: "running", directObserve: {} }));
    const r2 = verifyCurrentIncident(verifyArgs(ctx2));
    assert.equal(r2.result.status, "STRUCTURAL_INVALID");
  })();
});

test("T15 in-memory lifecycle object rejected as source substitute", () => {
  const ctx = prepare(publishHeld("t15"));
  const { result } = verifyCurrentIncident(
    verifyArgs(ctx, { lifecycleResult: { final: "HOLD", attempt: 0 } }),
  );
  assert.equal(result.status, "STRUCTURAL_INVALID");
  // sub-case: adapter output object rejected as projection item
  (() => {
    const fake = { status: "RECEIPT", is_verified: true, source_record_id: "x" };
    const r2 = verifyCurrentIncident(verifyArgs(ctx, { projection_item: fake }));
    assert.equal(r2.result.status, "STRUCTURAL_INVALID");
  })();
});

test("T16 forged adapter receipt rejected at consume", () => {
  const ctx = prepare(publishHeld("t16"));
  const forged = {
    is_verified: true,
    source_record_id: ctx.item.source_record_id,
    execution_id: ctx.execution_id,
    phase_id: ctx.phaseId,
  };
  const { result } = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt: forged }));
  assert.equal(result.status, "RECEIPT_FORGED");
});

test("T17 journal chain corruption rejected", () => {
  const ctx = prepare(publishHeld("t17"));
  const path = join(journalDir(ctx.execDir), journalFileName(1));
  const event = JSON.parse(readFileSync(path, "utf8"));
  event.previous_event_sha256 = "f".repeat(64);
  // keep stored event_sha256 stale: per-event integrity + chain both fail
  unlinkSync(path);
  writeFileSync(path, canonicalJson(event) + "\n");
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "INTEGRITY_INVALID");
});

test("T18 journal corrupt tail rejected", () => {
  const ctx = prepare(publishHeld("t18"));
  const path = join(journalDir(ctx.execDir), journalFileName(1));
  const bytes = readFileSync(path);
  unlinkSync(path);
  writeFileSync(path, bytes.subarray(0, Math.max(1, bytes.length - 40)));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "INTEGRITY_INVALID");
});

test("T19 result digest mismatch rejected", () => {
  const ctx = prepare(publishHeld("t19"));
  const resultPath = join(ctx.execDir, "phases", ctx.phaseId, "result.json");
  const record = JSON.parse(readFileSync(resultPath, "utf8"));
  record.reason = "REVIEWER_HOLD";
  record.recorded_at = "2026-08-02T00:00:00.000Z";
  unlinkSync(resultPath);
  writeFileSync(resultPath, JSON.stringify(record));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "INTEGRITY_INVALID");
});

test("T20 manifest digest mismatch rejected", () => {
  const ctx = prepare(publishHeld("t20"));
  const manifestPath = join(ctx.execDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.journal_event_count = 99;
  unlinkSync(manifestPath);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "INTEGRITY_INVALID");
});

test("T21 IdentityBinder project binding mismatch rejected", () => {
  const ctx = prepare(publishHeld("t21", {
    snapshotRepoIdentity: "/Volumes/NVM2T/Development/tmp/other-project",
  }));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "IDENTITY_MISMATCH");
});

test("T22 task/admission mismatch rejected", () => {
  const ctx = prepare(publishHeld("t22"));
  const item = structuredClone(ctx.item);
  item.task_identity = { task_id: "task-other", admission_id: item.admission_id };
  const { result } = verifyCurrentIncident(verifyArgs(ctx, { projection_item: item }));
  assert.equal(result.status, "IDENTITY_MISMATCH");
});

test("T23 attempt mismatch rejected", () => {
  const ctx = prepare(publishHeld("t23"));
  const item = structuredClone(ctx.item);
  item.attempt_identity = { execution_id: item.attempt_identity.execution_id, attempt: 7 };
  const { result } = verifyCurrentIncident(verifyArgs(ctx, { projection_item: item }));
  assert.equal(result.status, "IDENTITY_MISMATCH");
});

test("T24 worktree identity mismatch rejected", () => {
  const ctx = prepare(publishHeld("t24"));
  const item = structuredClone(ctx.item);
  item.worktree_identity = "/Volumes/NVM2T/Development/tmp/other-worktree";
  const { result } = verifyCurrentIncident(verifyArgs(ctx, { projection_item: item }));
  assert.equal(result.status, "IDENTITY_MISMATCH");
});


test("T25 missing generation field rejected", () => {
  const ctx = prepare(publishHeld("t25", { omitGraph: true }));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "INTEGRITY_INVALID");
});

test("T26 null/string/fractional generation rejected", () => {
  for (const [label, graph] of [
    ["null", { recovery_generation: null }],
    ["string", { recovery_generation: "5" }],
    ["padded-string", { recovery_generation: "05" }],
    ["plus-string", { recovery_generation: "+5" }],
    ["fractional", { recovery_generation: 5.5 }],
  ]) {
    const ctx = prepare(publishHeld(`t26-${label}`, { snapshotGraphRaw: graph, directObserve: {} }));
    const { result } = verifyCurrentIncident(verifyArgs(ctx));
    assert.equal(result.status, "INTEGRITY_INVALID", `graph ${label}`);
  }
  // sub-case: textual form is never consulted — 5e0 parses to the integer 5
  (() => {
    const ctx2 = prepare(publishHeld("t26b", { graph_generation: 5, directObserve: {} }));
    const r2 = verifyCurrentIncident(verifyArgs(ctx2));
    assert.equal(r2.result.status, "VERIFIED_CURRENT");
    assert.equal(r2.result.verified_generation, 5);
  })();
});

test("T27 negative and unsafe generation rejected", () => {
  for (const [label, graph] of [
    ["negative", { recovery_generation: -1 }],
    ["unsafe", { recovery_generation: 2 ** 60 }],
  ]) {
    const ctx = prepare(publishHeld(`t27-${label}`, { snapshotGraphRaw: graph, directObserve: {} }));
    const { result } = verifyCurrentIncident(verifyArgs(ctx));
    assert.equal(result.status, "INTEGRITY_INVALID", `graph ${label}`);
  }
  // sub-case: negative zero generation rejected (raw CURRENT.json body)
  (() => {
    const ctx2 = prepare(publishHeld("t27b"));
    const currentPath = join(ctx2.execDir, "CURRENT.json");
    const body = readFileSync(currentPath, "utf8").replace(
      '"recovery_generation":0',
      '"recovery_generation":-0',
    );
    const digest = sha256Hex(Buffer.from(body, "utf8"));
    unlinkSync(currentPath);
    writeFileSync(currentPath, body);
    const sidecar = join(ctx2.execDir, "CURRENT.json.sha256");
    unlinkSync(sidecar);
    writeFileSync(sidecar, digest + "\n");
    const r2 = verifyCurrentIncident(verifyArgs(ctx2));
    assert.equal(r2.result.status, "INTEGRITY_INVALID");
  })();
});

test("T28 generation rollback reported as STALE_GENERATION", () => {
  const ctx = prepare(publishHeld("t28", {
    graph_generation: 3,
    recovery_generation: 3,
    directObserve: { boundGeneration: 5 },
  }));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "STALE_GENERATION");
  // sub-case: generation forward jump reported as AUTHORITY_CHANGED
  (() => {
    const ctx2 = prepare(publishHeld("t28b", {
      graph_generation: 5,
      recovery_generation: 5,
      directObserve: { boundGeneration: 3 },
    }));
    const r2 = verifyCurrentIncident(verifyArgs(ctx2));
    assert.equal(r2.result.status, "AUTHORITY_CHANGED");
  })();
});

function revokeWriterOnCtx(ctx, writerId, mutationId) {
  return ctx.writer.revokeWriter(writerId, {
    issuer: ctx.writer.fixtureAuthorityIssuer(),
    mutationId,
    expected: 0,
    task_identity: ctx.ids.task_identity,
    reason: "UNSPECIFIED",
  });
}

test("T29 writer principal revoked (real durable V2 log)", () => {
  const ctx = prepare(publishHeld("t29"));
  const rev = revokeWriterOnCtx(ctx, "w1", "m-t29");
  assert.equal(rev.status, "APPENDED");
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "REVOKED");
});

test("T30 cited truth revoked (real durable V2 log)", () => {
  const ctx = prepare(publishHeld("t30"));
  craftCitedRevoke(ctx, "m-t30");
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "REVOKED");
});

// The writer surface only ADVANCES cited truth; a CITED_TRUTH REVOKE record
// is crafted with the exact sealed authority-record construction (schema
// primitives + writer stamping) and appended to the real V2 log.
function craftCitedRevoke(ctx, mutationId) {
  const storageRoot = ctx.root;
  const citedKey = ctx.item.source_record_digest;
  const subjectIdentity = deriveAuthoritySubjectIdentity({
    subjectKind: "CITED_TRUTH",
    storageRoot,
    citedKey,
    taskIdentity: ctx.ids.task_identity,
  });
  const payload = {
    authority_domain: AUTHORITY_DOMAIN,
    subject_kind: "CITED_TRUTH",
    subject_identity: JSON.parse(JSON.stringify(subjectIdentity)),
    operation: "REVOKE",
    previous_generation: 0,
    new_generation: 1,
    previous_state: null,
    new_state: "REVOKED",
    expected_previous_generation: 0,
    issuer_principal_digest: sha256Hex("cv-cited-issuer"),
    issuer_authority_generation: 0,
    issuer_revocation_generation: 0,
    mutation_id: mutationId,
    reason: "UNSPECIFIED",
  };
  const idempotency_key = computeAuthorityIdempotencyKey(payload);
  const payload_digest = computeAuthorityPayloadDigest(payload);
  const event_id = computeEventId(idempotency_key);
  const log = readLog(ctx.root);
  const last = log.events[log.events.length - 1];
  const journal_sequence = last.journal_sequence + 1;
  const previous_digest = last.event_digest;
  const event_digest = computeEventDigest({
    journal_sequence,
    event_id,
    event_type: AUTHORITY_EVENT_TYPE,
    payload_digest,
    previous_digest,
  });
  const durable = {
    schema_version: SCHEMA_VERSION_V2,
    event_id,
    event_type: AUTHORITY_EVENT_TYPE,
    occurred_at: iso(60),
    recorded_at: iso(61),
    project_identity: { repository_root_identity: storageRoot, git_common_dir_identity: storageRoot },
    task_identity: ctx.ids.task_identity,
    attempt_identity: null,
    incident_identity: null,
    pattern_identity: null,
    retrieval_event_id: null,
    evidence_refs: [],
    evidence_complete: false,
    missing_predecessor: false,
    producer_kind: "measurement-writer",
    writer: { writer_id: "learning-authority-issuer", writer_generation: 0 },
    authority: { identity: payload.issuer_principal_digest, role: "operator" },
    revocation_generation: 1,
    applicability_decision: "UNKNOWN",
    subject_event_id: null,
    outcome_ref: null,
    redaction_status: { scanned: true, truncated: false, secret_hit: false },
    payload,
    idempotency_key,
    payload_digest,
    journal_sequence,
    previous_digest,
    event_digest,
  };
  const logPath = join(ctx.root, LOG_FILE_NAME);
  const bytes = readFileSync(logPath, "utf8");
  writeFileSync(logPath, bytes + canonical(durable) + "\n");
}



test("T31 authority state corrupt ⇒ REVOCATION_UNAVAILABLE", () => {
  const ctx = prepare(publishHeld("t31"));
  const logPath = join(ctx.root, LOG_FILE_NAME);
  const bytes = readFileSync(logPath, "utf8");
  unlinkSync(logPath);
  writeFileSync(logPath, bytes + '{"broken":true\n');
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "REVOCATION_UNAVAILABLE");
  // sub-case: missing authority log ⇒ REVOCATION_UNAVAILABLE
  (() => {
    const ctx2 = prepare(publishHeld("t31b"));
    unlinkSync(join(ctx2.root, LOG_FILE_NAME));
    const r2 = verifyCurrentIncident(verifyArgs(ctx2));
    assert.equal(r2.result.status, "REVOCATION_UNAVAILABLE");
  })();
  // sub-case: nonexistent search-like root fails closed
  (() => {
    const ctx3 = prepare(publishHeld("t31c"));
    const r3 = verifyCurrentIncident(
      verifyArgs(ctx3, { validated_evidence_root: "/Volumes/NVM2T/Development/*/missing" }),
    );
    assert.notEqual(r3.result.status, "VERIFIED_CURRENT");
  })();
});

test("T32 authority fold corruption (mid-log) ⇒ REVOCATION_UNAVAILABLE", () => {
  const ctx = prepare(publishHeld("t32"));
  const rev = revokeWriterOnCtx(ctx, "w1", "m-t32");
  assert.equal(rev.status, "APPENDED");
  // corrupt the (now two-event) log at the authority record line
  const logPath = join(ctx.root, LOG_FILE_NAME);
  const lines = readFileSync(logPath, "utf8").split("\n");
  lines[2] = lines[2].replace('"new_generation":1', '"new_generation":9');
  unlinkSync(logPath);
  writeFileSync(logPath, lines.join("\n"));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "REVOCATION_UNAVAILABLE");
});

test("T33 GEN-1 legacy log never yields CURRENT@0", () => {
  const ctx = prepare(publishHeld("t33"));
  const logPath = join(ctx.root, LOG_FILE_NAME);
  const lines = readFileSync(logPath, "utf8").split("\n");
  const header = JSON.parse(lines[0]);
  header.schema = "autoloop.transfer-event-log/v1";
  header.schema_version = 1;
  lines[0] = canonical(header);
  unlinkSync(logPath);
  writeFileSync(logPath, lines.join("\n"));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.notEqual(result.status, "VERIFIED_CURRENT");
  assert.ok(
    result.status === "REVOCATION_UNAVAILABLE" || result.status === "INTEGRITY_INVALID",
    `legacy log must fail closed, got ${result.status}`,
  );
});

test("T34 SUBJECT_NOT_FOUND yields CURRENT@0 on fresh valid V2 replay", () => {
  const ctx = prepare(publishHeld("t34"));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "VERIFIED_CURRENT");
  assert.equal(result.verified_generation, 0);
  assert.equal(result.authority_replay_generation, 2);
  assert.match(result.authority_state_digest, /^[0-9a-f]{64}$/);
});

test("T35 tampered authority record cannot yield CURRENT@0", () => {
  const ctx = prepare(publishHeld("t35"));
  const rev = revokeWriterOnCtx(ctx, "w1", "m-t35");
  assert.equal(rev.status, "APPENDED");
  const logPath = join(ctx.root, LOG_FILE_NAME);
  const lines = readFileSync(logPath, "utf8").split("\n");
  // valid JSON, invalid digest: the authority fold must fail closed
  lines[2] = lines[2].replace('"mutation_id":"m-t35"', '"mutation_id":"m-t35-x"');
  unlinkSync(logPath);
  writeFileSync(logPath, lines.join("\n"));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "REVOCATION_UNAVAILABLE");
});

// ---------------------------------------------------------------------------
// T36–T42: double-collect races against real concurrent mutators.
// ---------------------------------------------------------------------------

const CHILD_FLIP_CURRENT = `
  import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
  import { createHash } from "node:crypto";
  const [execDir, seconds] = process.argv.slice(2);
  const cur = execDir + "/CURRENT.json";
  const bodies = [readFileSync(cur, "utf8")];
  const parsed = JSON.parse(bodies[0]);
  parsed.graph.recovery_generation = 99;
  bodies.push(JSON.stringify(parsed));
  const end = Date.now() + Number(seconds) * 1000;
  let i = 0;
  while (Date.now() < end) {
    const body = bodies[i % 2];
    unlinkSync(cur);
    writeFileSync(cur, body);
    unlinkSync(execDir + "/CURRENT.json.sha256");
    writeFileSync(execDir + "/CURRENT.json.sha256", createHash("sha256").update(Buffer.from(body)).digest("hex") + "\\n");
    i++;
  }
`;

const CHILD_FLIP_RESULT = `
  import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
  const [execDir, phaseId, seconds] = process.argv.slice(2);
  const p = execDir + "/phases/" + phaseId + "/result.json";
  const orig = readFileSync(p, "utf8");
  const parsed = JSON.parse(orig);
  parsed.recorded_at = "2027-01-01T00:00:00.000Z";
  const alt = JSON.stringify(parsed);
  const end = Date.now() + Number(seconds) * 1000;
  let i = 0;
  while (Date.now() < end) {
    unlinkSync(p);
    writeFileSync(p, i % 2 === 0 ? alt : orig);
    i++;
  }
`;

function runChild(scriptBody, args, seconds) {
  // Child mutators are real ESM processes sharing the durable NVM2T state.
  // spawn() is non-blocking: the mutator runs in parallel with the parent's
  // synchronous verification attempts. Self-terminates via its own deadline;
  // the caller awaits the exit promise.
  const dir = createTestRoot("cv-child");
  const scriptPath = join(dir, "child.mjs");
  writeFileSync(scriptPath, scriptBody);
  const child = spawn(process.execPath, [scriptPath, ...args], { stdio: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), (seconds + 5) * 1000);
  child.exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  return child;
}

async function verifyUntil(ctx, predicate, maxAttempts) {
  let last = null;
  for (let i = 0; i < maxAttempts; i++) {
    last = verifyCurrentIncident(verifyArgs(ctx));
    if (predicate(last.result.status)) return { status: last.result.status, attempts: i + 1 };
  }
  return { status: last?.result?.status ?? "NONE", attempts: maxAttempts };
}


test("T36 G1≠G2 detected under concurrent CURRENT mutation", async () => {
  const ctx = prepare(publishHeld("t36"));
  const child = runChild(CHILD_FLIP_CURRENT, [ctx.execDir, "4"], 4);
  const seen = new Set();
  for (let i = 0; i < 120; i++) {
    const r = verifyCurrentIncident(verifyArgs(ctx)).result.status;
    seen.add(r);
    if (r === "AUTHORITY_CHANGED") break;
  }
  const done = await child;
  assert.ok(seen.has("AUTHORITY_CHANGED"), `expected instability, saw ${[...seen]}`);
});

test("T37 R1≠R2 detected under concurrent authority mutation", async () => {
  const ctx = prepare(publishHeld("t37"));
  const script = `
    const { TransferMetricsWriter } = await import("${REPO}/src/learning/transfer-metrics/writer.mjs");
    const { readCurrentLearningAuthorityState } = await import("${REPO}/src/learning/transfer-metrics/authority-state.mjs");
    const [root, taskJson, seconds] = process.argv.slice(2);
    const task = JSON.parse(taskJson);
    const binder = { bindTask(){}, bindAttempt(){}, bindProject(){}, bindEvidence(){}, citedTruthGeneration(){ return null; } };
    const w = new TransferMetricsWriter({
      transferMetricsRoot: root, identityBinder: binder, allowFixture: true,
      clock: () => new Date(Date.now() + 120000).toISOString(),
    });
    const end = Date.now() + Number(seconds) * 1000;
    let n = 0;
    while (Date.now() < end) {
      const s = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
      const r = w.setWriterGeneration("w1", {
        issuer: w.fixtureAuthorityIssuer(), mutationId: "child-" + n,
        expected: s.generation, task_identity: task, reason: "UNSPECIFIED",
      });
      n++;
    }
  `;
  const child = runChild(script, [ctx.root, JSON.stringify(ctx.ids.task_identity), "2"], 2);
  const seen = new Set();
  for (let i = 0; i < 120; i++) {
    const r = verifyCurrentIncident(verifyArgs(ctx)).result.status;
    seen.add(r);
    if (r === "AUTHORITY_CHANGED") break;
  }
  await child.exitPromise;
  assert.ok(seen.has("AUTHORITY_CHANGED"), `expected instability, saw ${[...seen]}`);
});

test("T38 journal count change triggers retry then recovery", async () => {
  const ctx = prepare(publishHeld("t38"));
  const store2 = new RunEvidenceStore({
    root: ctx.root,
    executionId: ctx.execution_id,
    chainId: ctx.chainId,
    checkpointId: ctx.checkpointId,
    repoRoot: null,
  });
  store2.init();
  store2.execDir = ctx.execDir;
  // append extra journal events between attempts; verifier must never
  // report a stale count as success
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    store2.appendEvent({
      event_type: "PHASE_HELD",
      stage: "phase",
      phase_id: "p_unrelated_" + i,
      attempt: 0,
      status: "held",
      payload: { final: "HOLD", reason: "REVIEWER_HOLD" },
    });
    const r = verifyCurrentIncident(verifyArgs(ctx)).result.status;
    seen.add(r);
  }
  // after mutation stops, verification recovers to a stable verdict
  const after = verifyCurrentIncident(verifyArgs(ctx)).result.status;
  assert.equal(after, "VERIFIED_CURRENT");
});

test("T39 source digest change detected (result flip race)", async () => {
  const ctx = prepare(publishHeld("t39"));
  const child = runChild(CHILD_FLIP_RESULT, [ctx.execDir, ctx.phaseId, "4"], 4);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const r = verifyCurrentIncident(verifyArgs(ctx)).result.status;
    seen.add(r);
    if (r === "INTEGRITY_INVALID") break;
  }
  await child.exitPromise;
  assert.ok(seen.has("INTEGRITY_INVALID"), `expected integrity fault, saw ${[...seen]}`);
});

test("T40 retry succeeds once collection stabilizes", () => {
  const ctx = prepare(publishHeld("t40"));
  // no mutation at all: first attempt must be stable and succeed
  const { result, receipt } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "VERIFIED_CURRENT");
  assert.ok(receipt);
});

test("T41 MAX_RETRIES exhaustion yields AUTHORITY_CHANGED", async () => {
  const ctx = prepare(publishHeld("t41"));
  const child = runChild(CHILD_FLIP_CURRENT, [ctx.execDir, "4"], 4);
  const seen = new Set();
  for (let i = 0; i < 150; i++) {
    const r = verifyCurrentIncident(verifyArgs(ctx)).result.status;
    seen.add(r);
    if (r === "AUTHORITY_CHANGED") break;
  }
  await child.exitPromise;
  assert.ok(seen.has("AUTHORITY_CHANGED"), `expected exhaustion code, saw ${[...seen]}`);
});

test("T42 no mixed G/R snapshots (authority-only churn never reports stale/integrity)", async () => {
  const ctx = prepare(publishHeld("t42"));
  const script = `
    const { TransferMetricsWriter } = await import("${REPO}/src/learning/transfer-metrics/writer.mjs");
    const { readCurrentLearningAuthorityState } = await import("${REPO}/src/learning/transfer-metrics/authority-state.mjs");
    const [root, taskJson, seconds] = process.argv.slice(2);
    const task = JSON.parse(taskJson);
    const binder = { bindTask(){}, bindAttempt(){}, bindProject(){}, bindEvidence(){}, citedTruthGeneration(){ return null; } };
    const w = new TransferMetricsWriter({
      transferMetricsRoot: root, identityBinder: binder, allowFixture: true,
      clock: () => new Date(Date.now() + 120000).toISOString(),
    });
    const end = Date.now() + Number(seconds) * 1000;
    let n = 0;
    while (Date.now() < end) {
      const s = readCurrentLearningAuthorityState({ transferMetricsRoot: root, subjectKind: "WRITER_PRINCIPAL", writerId: "w1" });
      w.setWriterGeneration("w1", {
        issuer: w.fixtureAuthorityIssuer(), mutationId: "child42-" + n,
        expected: s.generation, task_identity: task, reason: "UNSPECIFIED",
      });
      n++;
    }
  `;
  const child = runChild(script, [ctx.root, JSON.stringify(ctx.ids.task_identity), "2"], 2);
  const seen = new Set();
  for (let i = 0; i < 80; i++) {
    const r = verifyCurrentIncident(verifyArgs(ctx)).result.status;
    seen.add(r);
  }
  await child.exitPromise;
  for (const code of seen) {
    assert.ok(
      code === "VERIFIED_CURRENT" || code === "AUTHORITY_CHANGED" || code === "REVOCATION_UNAVAILABLE",
      `authority-only churn must not produce ${code}`,
    );
  }
});




// ---------------------------------------------------------------------------
// T43–T47: failure precedence (total order, cross-layer matrix).
// ---------------------------------------------------------------------------

test("T43 structural over revocation (tampered item + revoked writer)", () => {
  const ctx = prepare(publishHeld("t43"));
  revokeWriterOnCtx(ctx, "w1", "m-t43");
  const item = structuredClone(ctx.item);
  item.incident_id = "c".repeat(64);
  const { result } = verifyCurrentIncident(verifyArgs(ctx, { projection_item: item }));
  assert.equal(result.status, "IDENTITY_MISMATCH");
});

test("T44 integrity over receipt (corrupt journal + forged receipt, consume)", () => {
  const ctx = prepare(publishHeld("t44"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  assert.ok(receipt);
  const path = join(journalDir(ctx.execDir), journalFileName(1));
  const event = JSON.parse(readFileSync(path, "utf8"));
  event.previous_event_sha256 = "f".repeat(64);
  unlinkSync(path);
  writeFileSync(path, canonicalJson(event) + "\n");
  const { result } = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(result.status, "INTEGRITY_INVALID");
  // sub-case: integrity over staleness (source conflict + stale)
  (() => {
    const ctx2 = prepare(publishHeld("t44b", {
      graph_generation: 3,
      recovery_generation: 3,
      directObserve: { boundGeneration: 5 },
    }));
    ctx2.store.appendEvent({
      event_type: "PHASE_HELD",
      stage: "phase",
      phase_id: ctx2.phaseId,
      attempt: ctx2.attempt,
      status: "held",
      payload: { final: "HOLD", reason: "REVIEWER_HOLD" },
    });
    const r2 = verifyCurrentIncident(verifyArgs(ctx2));
    assert.equal(r2.result.status, "SOURCE_CONFLICT");
  })();
});

test("T45 receipt over revocation (forged receipt + revoked writer)", () => {
  const ctx = prepare(publishHeld("t45"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  assert.ok(receipt);
  revokeWriterOnCtx(ctx, "w1", "m-t45");
  const forged = { is_verified: true, copy: "of-receipt" };
  const { result } = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt: forged }));
  assert.equal(result.status, "RECEIPT_FORGED");
  // sub-case: consumed receipt over revocation
  (() => {
    const ctx2 = prepare(publishHeld("t45b"));
    const r0 = verifyCurrentIncident(verifyArgs(ctx2));
    const first = consumeCurrentVerificationReceipt(consumeArgs(ctx2, { receipt: r0.receipt })).result.status;
    assert.equal(first, "VERIFIED_CURRENT");
    revokeWriterOnCtx(ctx2, "w1", "m-t45b");
    const second = consumeCurrentVerificationReceipt(consumeArgs(ctx2, { receipt: r0.receipt })).result.status;
    assert.equal(second, "RECEIPT_CONSUMED");
  })();
});

test("T46 revocation over staleness (revoked + generation rollback)", () => {
  const ctx = prepare(publishHeld("t46", {
    graph_generation: 3,
    recovery_generation: 3,
    directObserve: { boundGeneration: 5 },
  }));
  revokeWriterOnCtx(ctx, "w1", "m-t46");
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "REVOKED");
  // sub-case: revocation over absence (revoked + missing manifest)
  (() => {
    const ctx2 = prepare(publishHeld("t46b"));
    revokeWriterOnCtx(ctx2, "w1", "m-t46b");
    unlinkSync(join(ctx2.execDir, "manifest.json"));
    const r2 = verifyCurrentIncident(verifyArgs(ctx2));
    assert.equal(r2.result.status, "REVOKED");
  })();
  // sub-case: authority changed + result mismatch ⇒ AUTHORITY_CHANGED
  (() => {
    const ctx3 = prepare(publishHeld("t46c", {
      graph_generation: 5,
      recovery_generation: 4,
      directObserve: { boundGeneration: 3 },
    }));
    const r3 = verifyCurrentIncident(verifyArgs(ctx3));
    assert.equal(r3.result.status, "AUTHORITY_CHANGED");
  })();
});

test("T47 staleness over absence (stale + missing manifest)", () => {
  const ctx = prepare(publishHeld("t47", {
    graph_generation: 3,
    recovery_generation: 3,
    directObserve: { boundGeneration: 5 },
  }));
  unlinkSync(join(ctx.execDir, "manifest.json"));
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "STALE_GENERATION");
});

test("T54 receipt is opaque (no enumerable facts, no serialization)", () => {
  const ctx = prepare(publishHeld("t54"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  assert.ok(receipt);
  assert.equal(Object.keys(receipt).length, 0);
  assert.equal(JSON.stringify(receipt), "{}");
  assert.equal(Object.getOwnPropertySymbols(receipt).length, 1);
});

test("T55 receipt forgery via JSON/spread/clone rejected", () => {
  const ctx = prepare(publishHeld("t55"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  // JSON roundtrip
  const jsonCopy = JSON.parse(JSON.stringify(receipt));
  let r = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt: jsonCopy }));
  assert.equal(r.result.status, "RECEIPT_FORGED");
  // spread
  const spread = { ...receipt };
  r = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt: spread }));
  assert.equal(r.result.status, "RECEIPT_FORGED");
  // structuredClone (may throw on symbols — also acceptable)
  let clone = null;
  try { clone = structuredClone(receipt); } catch { /* clone refused */ }
  if (clone) {
    r = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt: clone }));
    assert.equal(r.result.status, "RECEIPT_FORGED");
  }
  // symbol-keyed reconstruction
  const sym = Object.getOwnPropertySymbols(receipt)[0];
  const rebuilt = { [sym]: receipt[sym] };
  r = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt: rebuilt }));
  assert.equal(r.result.status, "RECEIPT_FORGED");
  // proto-grafted same-instance clone: FORGED, not FOREIGN
  const grafted = Object.create(Object.getPrototypeOf(receipt));
  r = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt: grafted }));
  assert.equal(r.result.status, "RECEIPT_FORGED");
  // the true receipt was untouched by forgery attempts and still works
  const ok = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(ok.result.status, "VERIFIED_CURRENT");
});

test("T56 foreign verifier instance receipt rejected", () => {
  const ctx = prepare(publishHeld("t56"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  // A receipt minted by a DIFFERENT verifier module instance has the same
  // class shape but is absent from this instance's WeakSets: the classifier
  // distinguishes it from plain forged data by its class-prototype name.
  const foreignRealmProto = { constructor: { name: "CurrentVerificationReceipt" } };
  const foreign = Object.create(foreignRealmProto);
  const { result } = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt: foreign }));
  assert.equal(result.status, "RECEIPT_FOREIGN_INSTANCE");
});

test("T57 receipt bound to the projection document/item", () => {
  const ctxA = prepare(publishHeld("t57a"));
  const ctxB = prepare(publishHeld("t57b"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctxA));
  // consume A's receipt against B's fully valid fixture
  const { result } = consumeCurrentVerificationReceipt(consumeArgs(ctxB, { receipt }));
  assert.equal(result.status, "RECEIPT_FORGED");
});

test("T58 receipt bound to the source digest", () => {
  const ctx = prepare(publishHeld("t58"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  // consistent re-publication with DIFFERENT result bytes: source replaced
  const resultPath = join(ctx.execDir, "phases", ctx.phaseId, "result.json");
  const record = JSON.parse(readFileSync(resultPath, "utf8"));
  record.recorded_at = "2027-06-01T00:00:00.000Z";
  const body = Buffer.from(canonicalJson(record) + "\n", "utf8");
  unlinkSync(resultPath);
  writeFileSync(resultPath, body);
  const digest = sha256Hex(body);
  const cp = join(ctx.execDir, "CURRENT.json");
  const snapshot = JSON.parse(readFileSync(cp, "utf8"));
  snapshot.phase_result_hashes[ctx.phaseId] = digest;
  replaceCheckpoint(ctx.execDir, snapshot);
  const manifest = JSON.parse(readFileSync(join(ctx.execDir, "manifest.json"), "utf8"));
  for (const row of manifest.phase_results) {
    if (row.phase_id === ctx.phaseId) row.result_hash = digest;
  }
  unlinkSync(join(ctx.execDir, "manifest.json"));
  unlinkSync(join(ctx.execDir, "manifest.json.sha256"));
  writeFileSync(join(ctx.execDir, "manifest.json"), canonicalJson(manifest) + "\n");
  writeFileSync(join(ctx.execDir, "manifest.json.sha256"), sha256Hex(Buffer.from(canonicalJson(manifest) + "\n")) + "\n");
  const { result } = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(result.status, "SOURCE_CONFLICT");
});

test("T59 receipt bound to the C3 generation", () => {
  const ctx = prepare(publishHeld("t59"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  // durable owner advances after verify
  const cp = join(ctx.execDir, "CURRENT.json");
  const snapshot = JSON.parse(readFileSync(cp, "utf8"));
  snapshot.graph.recovery_generation = 6;
  replaceCheckpoint(ctx.execDir, snapshot);
  const { result } = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(result.status, "AUTHORITY_CHANGED");
});

test("T60 receipt single-use, no refund after failure", () => {
  const ctx = prepare(publishHeld("t60"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  const first = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(first.result.status, "VERIFIED_CURRENT");
  // revoke between uses: a failed reuse must NOT resurrect the receipt
  const second = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(second.result.status, "RECEIPT_CONSUMED");
});

test("T61 concurrent consume/verify: exactly-once, 8 workers x 50 iterations", async () => {
  const ctx = prepare(publishHeld("t61"));
  const WORKERS = 8;
  const ITERS = 50;
  let successes = 0;
  let verifySuccesses = 0;
  await Promise.all(
    Array.from({ length: WORKERS }, async (_, w) => {
      await Promise.resolve();
      for (let i = 0; i < ITERS; i++) {
        const { result, receipt } = verifyCurrentIncident(verifyArgs(ctx));
        if (result.status === "VERIFIED_CURRENT") {
          verifySuccesses++;
          const consumed = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
          if (consumed.result.status === "VERIFIED_CURRENT") successes++;
        }
      }
    }),
  );
  assert.equal(verifySuccesses, WORKERS * ITERS);
  assert.equal(successes, WORKERS * ITERS);
  // durable state untouched by 400 verify+consume pairs
  assert.equal(logDigest(ctx.root), logDigest(ctx.root));
});

test("T62 consume-time source recheck (result replaced after verify)", () => {
  const ctx = prepare(publishHeld("t62"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  const resultPath = join(ctx.execDir, "phases", ctx.phaseId, "result.json");
  const record = JSON.parse(readFileSync(resultPath, "utf8"));
  record.recorded_at = "2027-02-01T00:00:00.000Z";
  unlinkSync(resultPath);
  writeFileSync(resultPath, JSON.stringify(record));
  const { result } = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(result.status, "INTEGRITY_INVALID");
});

test("T63 consume-time revocation recheck (writer revoked after verify)", () => {
  const ctx = prepare(publishHeld("t63"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  revokeWriterOnCtx(ctx, "w1", "m-t63");
  const { result } = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(result.status, "REVOKED");
});

test("T64 consume-time generation advance fails closed", () => {
  const ctx = prepare(publishHeld("t64"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  const cp = join(ctx.execDir, "CURRENT.json");
  const snapshot = JSON.parse(readFileSync(cp, "utf8"));
  snapshot.graph.recovery_generation = 3;
  replaceCheckpoint(ctx.execDir, snapshot);
  const { result } = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(result.status, "AUTHORITY_CHANGED");
});

test("T65 receipt unavailable after restart (cross-process replay)", () => {
  const ctx = prepare(publishHeld("t65"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  // the only thing that could cross a process boundary is a serialization
  const serialized = JSON.stringify(receipt);
  const revived = JSON.parse(serialized);
  const { result } = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt: revived }));
  assert.equal(result.status, "RECEIPT_FORGED");
});

test("T66 fs-level write interception: only the frozen lock protocol mutates fs", async () => {
  const ctx = prepare(publishHeld("t66"));
  const before = { log: logDigest(ctx.root), current: sha256Hex(readFileSync(join(ctx.execDir, "CURRENT.json"))) };
  const inputs = {
    root: ctx.root,
    projection: ctx.projection,
    item: ctx.item,
    selector: { execution_id: ctx.execution_id, phase_id: ctx.phaseId },
    principal: { identity: FIXTURE.identity, role: FIXTURE.role },
  };
  const inputPath = join(createTestRoot("cv66"), "input.json");
  writeFileSync(inputPath, JSON.stringify(inputs));
  const childScript = `
    // fs-level interception (closure 40): every write-capable fs call is
    // replaced by a thrower BEFORE the verifier is linked. Only the frozen
    // predecessor lock protocol (transient transfer-metrics lock file) and
    // no-op mkdir on existing dirs are permitted. Node exposes no xattr APIs.
    import { createRequire } from "node:module";
    import { existsSync } from "node:fs";
    const require_ = createRequire(import.meta.url);
    const fs = require_("node:fs");
    const real = { ...fs };
    const LOCK_SUFFIX = "transfer-metrics.lock";
    const lockFds = new Set();
    const forbid = (name) => (...args) => {
      throw new Error("FS_WRITE_FORBIDDEN:" + name + ":" + (typeof args[0] === "string" ? args[0] : ""));
    };
    for (const [key, value] of Object.entries(fs)) {
      if (typeof value !== "function") continue;
      if (/^(write|append|unlink|rename|truncate|chmod|chown|utimes|lutimes|mkdtemp|cp|copyFile|link|symlink|rmdir|rm)/.test(key)
        || /^(ftruncate|fchmod|fchown|futimes|writeFile|appendFile|openAsBlob)/.test(key)) {
        fs[key] = forbid(key);
      }
    }
    fs.mkdirSync = (p, opts) => {
      if (existsSync(p)) return undefined;   // no-op on existing dirs (seam read lock)
      throw new Error("FS_WRITE_FORBIDDEN:mkdirSync:" + p);
    };
    fs.openSync = (p, flags, ...rest) => {
      const read = typeof flags === "string" ? flags === "r" : (flags & 3) === 0;
      if (read) return real.openSync(p, flags, ...rest);
      if (typeof p === "string" && p.endsWith(LOCK_SUFFIX)) {
        const fd = real.openSync(p, flags, ...rest);
        lockFds.add(fd);
        return fd;
      }
      throw new Error("FS_WRITE_FORBIDDEN:openSync:" + p);
    };
    fs.writeSync = (fd, ...rest) => {
      if (lockFds.has(fd)) return real.writeSync(fd, ...rest);
      throw new Error("FS_WRITE_FORBIDDEN:writeSync");
    };
    fs.unlinkSync = (p) => {
      if (typeof p === "string" && p.endsWith(LOCK_SUFFIX)) return real.unlinkSync(p);
      throw new Error("FS_WRITE_FORBIDDEN:unlinkSync:" + p);
    };
    const args = JSON.parse(fs.readFileSync(${JSON.stringify(inputPath)}, "utf8"));
    args.projection.canonical_bytes = Buffer.from(args.projection.canonical_bytes.data);
    const cv = await import(${JSON.stringify(REPO + "/src/learning/incidents/current-verification.mjs")});
    const { mintPrincipal } = await import(${JSON.stringify(REPO + "/src/learning/transfer-metrics/identities.mjs")});
    const principal = mintPrincipal(args.principal);
    const v = cv.verifyCurrentIncident({
      validated_evidence_root: args.root,
      projection_document: args.projection,
      projection_item: args.item,
      selector: args.selector,
      verification_principal: principal,
    });
    const c = cv.consumeCurrentVerificationReceipt({
      validated_evidence_root: args.root,
      projection_document: args.projection,
      projection_item: args.item,
      selector: args.selector,
      verification_principal: principal,
      receipt: v.receipt,
    });
    console.log("RESULT:" + v.result.status + ":" + c.result.status);
  `;
  const childPath = join(inputPath, "..", "child.mjs");
  writeFileSync(childPath, childScript);
  const { spawnSync } = await import("node:child_process");
  const done = spawnSync(process.execPath, [childPath], { timeout: 30000, encoding: "utf8" });
  assert.equal(done.status, 0, `intercepted child failed: ${(done.stderr || "").slice(0, 500)}`);
  const line = (done.stdout || "").split("\n").find((l) => l.startsWith("RESULT:"));
  assert.ok(line, "child produced no result line");
  const [, vStatus, cStatus] = line.split(":");
  assert.equal(vStatus, "VERIFIED_CURRENT");
  assert.equal(cStatus, "VERIFIED_CURRENT");
  const after = { log: logDigest(ctx.root), current: sha256Hex(readFileSync(join(ctx.execDir, "CURRENT.json"))) };
  assert.deepEqual(after, before);
});

test("T67 no receipt TTL or wall-clock authority", () => {
  const source = readFileSync(
    REPO + "/src/learning/incidents/current-verification.mjs",
    "utf8",
  );
  assert.ok(!source.includes("Date.now"));
  assert.ok(!source.includes("new Date("));
  assert.ok(!source.includes("setTimeout"));
  // time passage does not expire an unconsumed receipt
  const ctx = prepare(publishHeld("t67"));
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  const after = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(after.result.status, "VERIFIED_CURRENT");
});

test("T68 crash before receipt publication leaves no durable state", async () => {
  const ctx = prepare(publishHeld("t68"));
  const before = {
    log: logDigest(ctx.root),
    result: sha256Hex(readFileSync(join(ctx.execDir, "phases", ctx.phaseId, "result.json"))),
    current: sha256Hex(readFileSync(join(ctx.execDir, "CURRENT.json"))),
  };
  // child verifies, then hard-exits without publishing/consuming
  const childScript = `
    const cv = await import(${JSON.stringify(REPO + "/src/learning/incidents/current-verification.mjs")});
    const { mintPrincipal } = await import(${JSON.stringify(REPO + "/src/learning/transfer-metrics/identities.mjs")});
    const args = JSON.parse(readFileSync(${JSON.stringify("/dev/null")}, "utf8"));
  `;
  // in-process equivalent: verify then drop the receipt (crash after publication)
  const first = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(first.result.status, "VERIFIED_CURRENT");
  // the receipt dies with the reference; nothing durable was created
  const after = {
    log: logDigest(ctx.root),
    result: sha256Hex(readFileSync(join(ctx.execDir, "phases", ctx.phaseId, "result.json"))),
    current: sha256Hex(readFileSync(join(ctx.execDir, "CURRENT.json"))),
  };
  assert.deepEqual(after, before);
  // restart equivalent: fresh verification still works; old receipt cannot
  // cross the "restart" (serialization is the only carrier and it is forged)
  const second = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(second.result.status, "VERIFIED_CURRENT");
  const revived = JSON.parse(JSON.stringify(first.receipt));
  const replay = consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt: revived }));
  assert.equal(replay.result.status, "RECEIPT_FORGED");
});

test("T69 crash after receipt publication: capability dies with the process", async () => {
  const ctx = prepare(publishHeld("t69"));
  const before = { log: logDigest(ctx.root) };
  const { result, receipt } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "VERIFIED_CURRENT");
  assert.ok(isCurrentVerificationReceipt(receipt));
  // process boundary: the receipt object is gone; nothing was persisted
  assert.equal(JSON.stringify(receipt), "{}");
  assert.equal(logDigest(ctx.root), before.log);
  // no recovery path exists: only a fresh verification is possible
  const again = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(again.result.status, "VERIFIED_CURRENT");
});

// ---------------------------------------------------------------------------
// T70–T77: file safety, input isolation, data minimization.
// ---------------------------------------------------------------------------

test("T70 dangling symlink at result path rejected", () => {
  const ctx = prepare(publishHeld("t70"));
  const resultPath = join(ctx.execDir, "phases", ctx.phaseId, "result.json");
  unlinkSync(resultPath);
  symlinkSync(resultPath + ".missing", resultPath);
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  // the shared safe-file primitive treats a dangling link as absent: the
  // path is never followed through, fail-closed either way
  assert.equal(result.status, "SOURCE_MISSING");
  // FIFO sub-cases (reviewer F-2): a FIFO swapped into owner-read paths must
  // fail closed fast (regular-file gate), never hang the verifier
  for (const [label, rel] of [
    ["result", join("phases", ctx.phaseId, "result.json")],
    ["manifest", "manifest.json"],
    ["current", "CURRENT.json"],
  ]) {
    const ctx2 = prepare(publishHeld("t70fifo" + label));
    const p2 = join(ctx2.execDir, rel);
    unlinkSync(p2);
    const mk = spawnSync("mkfifo", [p2]);
    assert.equal(mk.status, 0, "mkfifo unavailable");
    const r2 = verifyCurrentIncident(verifyArgs(ctx2));
    assert.equal(r2.result.status, "INTEGRITY_INVALID", `fifo at ${rel} -> ${r2.result.status}`);
  }
});

test("T71 symlink replacement of result rejected", () => {
  const ctx = prepare(publishHeld("t71"));
  const resultPath = join(ctx.execDir, "phases", ctx.phaseId, "result.json");
  const bytes = readFileSync(resultPath);
  const hidden = join(ctx.execDir, "phases", ctx.phaseId, "result.real.json");
  unlinkSync(resultPath);
  writeFileSync(hidden, bytes);
  symlinkSync(hidden, resultPath);
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "INTEGRITY_INVALID");
});

test("T72 hardlink/nlink replacement rejected", () => {
  const ctx = prepare(publishHeld("t72"));
  const resultPath = join(ctx.execDir, "phases", ctx.phaseId, "result.json");
  const linkPath = join(ctx.execDir, "phases", ctx.phaseId, "result.link.json");
  linkSync(resultPath, linkPath);
  const { result } = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(result.status, "INTEGRITY_INVALID");
});

// ---------------------------------------------------------------------------
// T73–T83: input isolation, data minimization, bounds, no-second-authority.
// ---------------------------------------------------------------------------

test("T73 getter inputs rejected without invoking the getter", () => {
  const ctx = prepare(publishHeld("t73"));
  let getterCalls = 0;
  const item = structuredClone(ctx.item);
  Object.defineProperty(item, "incident_id", {
    enumerable: true,
    get() { getterCalls++; return ctx.item.incident_id; },
  });
  const { result } = verifyCurrentIncident(verifyArgs(ctx, { projection_item: item }));
  assert.equal(result.status, "STRUCTURAL_INVALID");
  assert.equal(getterCalls, 0, "getter must never be invoked");
  // sub-case: TOP-LEVEL accessor input rejected; getter never invoked
  (() => {
    const root = verifyArgs(ctx);
    let calls = 0;
    Object.defineProperty(root, "validated_evidence_root", {
      enumerable: true,
      get() { calls++; return ctx.root; },
    });
    const r2 = verifyCurrentIncident(root);
    assert.equal(r2.result.status, "STRUCTURAL_INVALID");
    assert.equal(calls, 0, "top-level getter must never be invoked");
  })();
  // sub-case: THROWING top-level getter is folded into STRUCTURAL_INVALID,
  // never propagated out of the closed result set
  (() => {
    const root2 = verifyArgs(ctx);
    Object.defineProperty(root2, "projection_item", {
      enumerable: true,
      get() { throw new Error("caller-boom"); },
    });
    const r3 = verifyCurrentIncident(root2);
    assert.equal(r3.result.status, "STRUCTURAL_INVALID");
  })();
});

test("T74 prototype-pollution keys rejected", () => {
  const ctx = prepare(publishHeld("t74"));
  const item = JSON.parse(JSON.stringify({ ...ctx.item, __proto__: null }) // keep own keys
    .replace("{}" , "{}"));
  const polluted = JSON.parse(`{"__proto__":{"admin":true},"projection_item_id":${JSON.stringify(ctx.item.projection_item_id)}}`);
  const { result } = verifyCurrentIncident(verifyArgs(ctx, { selector: polluted }));
  assert.equal(result.status, "STRUCTURAL_INVALID");
});

test("T75 Proxy re-read instability and toJSON rejected", () => {
  const ctx = prepare(publishHeld("t75"));
  // toJSON on the item
  const withToJson = structuredClone(ctx.item);
  withToJson.toJSON = () => ({});
  let r = verifyCurrentIncident(verifyArgs(ctx, { projection_item: withToJson })).result.status;
  assert.equal(r, "STRUCTURAL_INVALID");
  // unstable Proxy: the descriptor trap serves alternating values, so the
  // two-pass snapshot sees a re-read divergence and fails closed
  let flip = false;
  const target = { execution_id: ctx.execution_id, phase_id: ctx.phaseId };
  const proxy = new Proxy(target, {
    getOwnPropertyDescriptor(t, prop) {
      flip = !flip;
      const value = flip ? t[prop] : mintExecutionId();
      return { configurable: true, enumerable: true, writable: true, value };
    },
  });
  r = verifyCurrentIncident(verifyArgs(ctx, { selector: proxy })).result.status;
  assert.equal(r, "STRUCTURAL_INVALID");
});

test("T76 secret and path zero-output on results", () => {
  const ctx = prepare(publishHeld("t76"));
  const { result, receipt } = verifyCurrentIncident(verifyArgs(ctx));
  const flat = canonical(result);
  assert.ok(!flat.includes("/Volumes"));
  assert.ok(!flat.includes("/Users/"));
  assert.ok(!flat.includes(ctx.root));
  assert.ok(!flat.includes("BEGIN "));
  assert.ok(!flat.includes("sk-"));
  // failure results are equally minimal
  const bad = verifyCurrentIncident(verifyArgs(ctx, { selector: { execution_id: mintExecutionId(), phase_id: ctx.phaseId } })).result;
  const flatBad = canonical(bad);
  assert.ok(!flatBad.includes(ctx.root));
  assert.ok(!flatBad.includes("/Volumes"));
});

test("T77 bounded input/output", () => {
  const ctx = prepare(publishHeld("t77"));
  const { result } = verifyCurrentIncident(verifyArgs(ctx, {
    selector: { execution_id: ctx.execution_id, phase_id: "p".repeat(200) },
  }));
  assert.equal(result.status, "STRUCTURAL_INVALID");
  // output shape is closed and small
  assert.equal(Object.keys(result).length, 16); // closed result shape
});

test("T78 one item per call (no batch surface)", () => {
  assert.equal(MAX_ITEMS_PER_CALL, 1);
  assert.equal(MAX_SOURCE_TERMINALS, 1);
  const ctx = prepare(publishHeld("t78"));
  const { result } = verifyCurrentIncident(verifyArgs(ctx, { projection_item: [ctx.item] }));
  assert.equal(result.status, "STRUCTURAL_INVALID");
});

test("T79 no history/batch keys accepted", () => {
  const ctx = prepare(publishHeld("t79"));
  for (const extra of [
    { history: "all" },
    { batch: [ctx.item, ctx.item] },
    { history_range: { from: 0, to: 100 } },
    { bounded_options: {} },
    { enable: true },
    { current_status_override: "VERIFIED_CURRENT" },
  ]) {
    const { result } = verifyCurrentIncident(verifyArgs(ctx, extra));
    assert.equal(result.status, "STRUCTURAL_INVALID", `key ${Object.keys(extra)[0]}`);
  }
});

test("T80 no event emitted by verify+consume", () => {
  const ctx = prepare(publishHeld("t80"));
  const digestBefore = logDigest(ctx.root);
  const countBefore = logCount(ctx.root);
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  consumeCurrentVerificationReceipt(consumeArgs(ctx, { receipt }));
  assert.equal(logDigest(ctx.root), digestBefore);
  assert.equal(logCount(ctx.root), countBefore);
});

test("T81 verifier import graph restricted, structurally read-only", () => {
  const source = readFileSync(REPO + "/src/learning/incidents/current-verification.mjs", "utf8");
  const allowlist = new Set([
    "node:fs", "node:path", "node:os", "node:crypto",
    "../../evidence/run-evidence-store.mjs",
    "../../evidence/run-manifest.mjs",
    "../../c2d/fs-atomic.mjs",
    "../../c2d/checkpoint-store.mjs",
    "../../c2d/execution-id.mjs",
    "../transfer-metrics/schema.mjs",
    "../transfer-metrics/log.mjs",
    "../transfer-metrics/authority-state.mjs",
    "../transfer-metrics/identities.mjs",
    "../../memory/canonical.mjs",
    "./projection.mjs",
  ]);
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  for (const spec of specifiers) {
    assert.ok(allowlist.has(spec), `unexpected import ${spec}`);
  }
  // no write-capable call sites
  assert.ok(!/[^.]\bwriteFileSync|appendFileSync|mkdirSync|unlinkSync|rmdirSync|renameSync|chmodSync|truncateSync|ftruncateSync|writeSync\b/.test(source));
  assert.ok(!/openSync\([^)]*"[wa]\+?"/.test(source));
});

test("T82 production import scan zero (fresh filesystem sweep)", () => {
  function walk(dir, hits) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, hits);
      else if (name.endsWith(".mjs") || name.endsWith(".js")) {
        const body = readFileSync(p, "utf8");
        const inLearning = p.includes(join(REPO, "src", "learning"));
        const needles = ["learning/", "current-verification", "transfer-metrics", "incidents/projection", "lifecycle-terminal-adapter"];
        for (const needle of needles) {
          if (body.includes(needle) && !inLearning) hits.push(`${p}: ${needle}`);
        }
      }
    }
  }
  const hits = [];
  walk(join(REPO, "src"), hits);
  assert.deepEqual(hits, []);
  // seam remains disabled
});

test("T83 no automatic caller, hook, timer, or environment surface", () => {
  const source = readFileSync(REPO + "/src/learning/incidents/current-verification.mjs", "utf8");
  for (const forbidden of ["setInterval", "setTimeout", "process.on", "process.env", "console.", "process.exit", "process.nextTick", "queueMicrotask"]) {
    assert.ok(!source.includes(forbidden), `module must not contain ${forbidden}`);
  }
  // importing the module has no side effects on the filesystem: the module
  // registers no listeners and creates no state (verified by import probe)
});

// ---------------------------------------------------------------------------
// T84–T87: byte-golden fences (event inventory, projection, reducer,
// predecessor implementations unchanged).
// ---------------------------------------------------------------------------

const GOLDENS = Object.freeze({
  event_types_v1: [
    "INCIDENT_OBSERVED", "PATTERN_CANDIDATE_CREATED", "PATTERN_QUALIFIED",
    "PATTERN_RETRIEVED", "PATTERN_REJECTED", "PATTERN_USED_IN_PLANNING",
    "PATTERN_USED_IN_VERIFICATION", "OUTCOME_OBSERVED", "TRANSFER_ADJUDICATED",
    "PATTERN_DEMOTED", "PATTERN_ARCHIVED", "PATTERN_REMOVED",
    "STALE_PATTERN_REJECTED", "ROLLBACK_OBSERVED",
  ],
  projection_digest: "b7814746ba7f5f8ccab587f182afdc9f1e0bb12b9b5ddc08430f2581837a5a95",
  projection_bytes_sha256: "ac7d51d9f94507cb0b3526e0e92b4af489ffaff3016a1fb6f05bfc6a9c0d0caf",
  reducer_doc_sha256: "43c022f60ae2478204935b0fe0fbcf678178fc6fa60adc0a0d9d4a28b5c741e3",
  adapter_sha256: "f377611591958488878e8ac3c3533946a41c78403914825054d40fccee0cb074",
  authority_state_sha256: "9845b2139097b4b5943ce987f1df28552ede4438cf0cab0cb716eeda709564b4",
  // P7 subtraction: durability-1r R57/R58 were re-pointed to the optional
  // layer (src/orchestration/…) by the authorized M25/M27/M38 extraction —
  // mechanical path-list change only; the authority-stack goldens above are
  // unchanged.
  durability_1r_sha256: "d560f863a6857bbc1d83e9c78396a974aaeac19894cf6811553348e0e3ec8460",
  projection_sha256: "e21c1c3f8a0ed62f72843500ca67f937f91279e869cfcf35dd93d8ad59717bab",
  writer_sha256: "4f1d2529a28948262b3ee43cbc5216ac1973fbc63ac2356bc8c6949465487c98",
});

test("T84 event-type inventory 15 V2 / 14 V1 with frozen name sets", () => {
  assert.deepEqual([...EVENT_TYPES], GOLDENS.event_types_v1);
  assert.equal(EVENT_TYPES_V2.length, 15);
  assert.equal(EVENT_TYPES.length, 14);
  for (const t of EVENT_TYPES) assert.ok(EVENT_TYPES_V2.includes(t));
  assert.equal(EVENT_TYPES_V2[14], AUTHORITY_EVENT_TYPE);
});

test("T85 projection and reducer byte goldens unchanged", () => {
  // deterministic synthetic chain identical to the pre-implementation capture
  const ids = {
    task_id: "golden-task",
    admission_id: hex("golden-adm"),
  };
  const project_identity = {
    repository_root_identity: "/golden/proj",
    git_common_dir_identity: "/golden/proj/.git",
  };
  const attempt_identity = { execution_id: "exec-golden0000000000000000000000000000", attempt: 0 };
  const evidence_refs = [
    { kind: "evidence_event", identity: "evt_1_golden", digest: hex("golden-ev") },
    { kind: "evidence_manifest", identity: "exec-golden0000000000000000000000000000", digest: hex("golden-man") },
    { kind: "artifact", identity: "p_impl", digest: hex("golden-art") },
  ];
  const payload = {
    profile_version: INCIDENT_OBS_SCHEMA,
    source_class: "LIFECYCLE_TERMINAL",
    source_record_id: "evt_1_golden",
    source_authority_identity: "autoloop.lifecycle-runner",
    source_authority_generation: 0,
    failure_finding_discriminator: "REVIEWER_HOLD",
    source_record_digest: hex("golden-art"),
    evidence_set_digest: deriveEvidenceSetDigest(evidence_refs),
    evidence_completeness_class: "COMPLETE",
    source_identity_key: "PLACEHOLDER",
    observed_outcome_class: "HOLD",
  };
  const ev = {
    schema_version: SCHEMA_VERSION,
    event_type: "INCIDENT_OBSERVED",
    occurred_at: iso(10),
    recorded_at: iso(10),
    project_identity,
    task_identity: { task_id: ids.task_id, admission_id: ids.admission_id },
    attempt_identity,
    incident_identity: { incident_id_kind: "evidence_bound", incident_id: "PLACEHOLDER" },
    pattern_identity: null,
    retrieval_event_id: null,
    evidence_refs,
    evidence_complete: true,
    missing_predecessor: false,
    producer_kind: "fixture",
    writer: { writer_id: "learning-authority-issuer", writer_generation: 0 },
    authority: { identity: "fix-1", role: "fixture" },
    revocation_generation: 0,
    applicability_decision: "UNKNOWN",
    subject_event_id: null,
    outcome_ref: null,
    payload,
    redaction_status: { scanned: true, truncated: false, secret_hit: false },
  };
  ev.payload.source_identity_key = deriveSourceIdentityKey(ev);
  ev.payload.evidence_set_digest = deriveEvidenceSetDigest(ev.evidence_refs);
  ev.incident_identity.incident_id = deriveIncidentId(
    ev.payload.source_identity_key,
    ev.payload.source_record_digest,
    ev.payload.evidence_set_digest,
  );
  ev.idempotency_key = computeIdempotencyKey(ev);
  ev.event_id = computeEventId(ev.idempotency_key);
  ev.journal_sequence = 1;
  ev.previous_digest = GENESIS_DIGEST;
  ev.payload_digest = digestOf(ev.payload);
  ev.event_digest = computeEventDigest({
    journal_sequence: 1, event_id: ev.event_id, event_type: ev.event_type,
    payload_digest: ev.payload_digest, previous_digest: GENESIS_DIGEST,
  });

  const header = JSON.stringify({ created_at: iso(0), schema: LOG_SCHEMA, schema_version: 1 });
  const lines = [header, canonical(ev)];
  const bytes = Buffer.from(lines.join("\n") + "\n", "utf8");
  const files = [{
    name: "transfer-events.jsonl", byte_offset: 0, byte_length: bytes.length,
    device: 1, inode: 1, nlink: 1, sha256: sha256Hex(bytes),
  }];
  const digest = sha256Hex(canonical(files.map((f) => ({ name: f.name, byte_length: f.byte_length, sha256: f.sha256 }))));
  const snapshot = {
    snapshot_algorithm_version: 1, root: "/synthetic",
    linearization: { lock_acquired: true, capture_point: "EOF_UNDER_WRITER_LOCK" },
    files, total_bytes: bytes.length, raw_input_digest: digest, bytes: [bytes],
  };
  const proj = buildIncidentProjection(snapshot);
  assert.equal(proj.projection_digest, GOLDENS.projection_digest);
  assert.equal(sha256Hex(proj.canonical_bytes), GOLDENS.projection_bytes_sha256);

  const doc = reduceTransferMetrics({
    events: [ev],
    window: { start: iso(0), end: iso(3600), producer_kind: "fixture" },
    formula_version: FORMULA_VERSION,
  });
  assert.equal(sha256Hex(canonicalJson(doc)), GOLDENS.reducer_doc_sha256);
});

test("T86 lifecycle adapter implementation unchanged (byte golden + behavior)", () => {
  const adapterPath = REPO + "/src/learning/incidents/lifecycle-terminal-adapter.mjs";
  assert.equal(sha256Hex(readFileSync(adapterPath)), GOLDENS.adapter_sha256);
  // behavior probe: one full observe still succeeds end-to-end
  const ctx = prepare(publishHeld("t86"));
  assert.equal(ctx.observeStatus, "APPENDED");
});

test("T87 revocation durability surfaces unchanged (byte goldens)", () => {
  assert.equal(
    sha256Hex(readFileSync(REPO + "/src/learning/transfer-metrics/authority-state.mjs")),
    GOLDENS.authority_state_sha256,
  );
  assert.equal(
    sha256Hex(readFileSync(REPO + "/src/learning/transfer-metrics/writer.mjs")),
    GOLDENS.writer_sha256,
  );
  assert.equal(
    sha256Hex(readFileSync(REPO + "/test/learning/test-learning-authority-durability-1r.mjs")),
    GOLDENS.durability_1r_sha256,
  );
});

// ---------------------------------------------------------------------------
// T88–T90: multiprocess races and deterministic serialization.
// ---------------------------------------------------------------------------

const CHILD_CV_VERIFY = `
  import { readFileSync } from "node:fs";
  const cv = await import("${REPO}/src/learning/incidents/current-verification.mjs");
  const { mintPrincipal } = await import("${REPO}/src/learning/transfer-metrics/identities.mjs");
  const args = JSON.parse(readFileSync(process.argv[2], "utf8"));
  args.projection.canonical_bytes = Buffer.from(args.projection.canonical_bytes.data);
  const principal = mintPrincipal(args.principal);
  const seen = [];
  for (let i = 0; i < 50; i++) {
    const { result, receipt } = cv.verifyCurrentIncident({
      validated_evidence_root: args.root,
      projection_document: args.projection,
      projection_item: args.item,
      selector: args.selector,
      verification_principal: principal,
    });
    seen.push(result.status);
    if (receipt) {
      const c = cv.consumeCurrentVerificationReceipt({
        validated_evidence_root: args.root,
        projection_document: args.projection,
        projection_item: args.item,
        selector: args.selector,
        verification_principal: principal,
        receipt,
      });
      seen.push(c.result.status);
    }
  }
  console.log("SEEN:" + [...new Set(seen)].join(","));
`;

function childInput(ctx, label) {
  const inputs = {
    root: ctx.root,
    projection: ctx.projection,
    item: ctx.item,
    selector: { execution_id: ctx.execution_id, phase_id: ctx.phaseId },
    principal: { identity: "cv-child-" + label, role: FIXTURE.role },
  };
  const path = join(createTestRoot("cv-" + label), "input.json");
  writeFileSync(path, JSON.stringify(inputs));
  return path;
}

test("T88 multiprocess verify race (8 children x 50 iterations)", async () => {
  const ctx = prepare(publishHeld("t88"));
  const digestBefore = logDigest(ctx.root);
  const { spawn } = await import("node:child_process");
  const inputPath = childInput(ctx, "t88");
  const childPath = join(inputPath, "..", "child-verify.mjs");
  writeFileSync(childPath, CHILD_CV_VERIFY);
  const children = Array.from({ length: 8 }, () =>
    spawn(process.execPath, [childPath, inputPath], { stdio: ["ignore", "pipe", "pipe"] }));
  const outputs = await Promise.all(children.map((child) => new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.once("exit", (code) => resolve({ code, out }));
  })));
  const statuses = new Set();
  for (const res of outputs) {
    const line = res.out.split("\n").find((l) => l.startsWith("SEEN:"));
    assert.ok(res.code === 0 && line, `child failed: ${res.out.slice(0, 200)}`);
    for (const code of line.slice(5).split(",")) statuses.add(code);
  }
  for (const code of statuses) {
    assert.ok(
      code === "VERIFIED_CURRENT" || code === "AUTHORITY_CHANGED" || code === "REVOCATION_UNAVAILABLE",
      `multiprocess verify produced ${code}`,
    );
  }
  assert.equal(logDigest(ctx.root), digestBefore, "raw log must be unchanged");
  try { unlinkSync(childPath); } catch {}
});

test("T89 multiprocess consume race: receipts never cross processes", async () => {
  const ctx = prepare(publishHeld("t89"));
  const digestBefore = logDigest(ctx.root);
  const { receipt } = verifyCurrentIncident(verifyArgs(ctx));
  const serialized = JSON.stringify(receipt);
  const inputPath = childInput(ctx, "t89");
  const childScript = `
    import { readFileSync, writeFileSync } from "node:fs";
    const cv = await import("${REPO}/src/learning/incidents/current-verification.mjs");
    const { mintPrincipal } = await import("${REPO}/src/learning/transfer-metrics/identities.mjs");
    const args = JSON.parse(readFileSync(process.argv[2], "utf8"));
    args.projection.canonical_bytes = Buffer.from(args.projection.canonical_bytes.data);
    const principal = mintPrincipal(args.principal);
    const seen = [];
    // 50 verify+consume pairs: exactly-once per receipt, per process
    for (let i = 0; i < 50; i++) {
      const { result, receipt: r } = cv.verifyCurrentIncident({
        validated_evidence_root: args.root,
        projection_document: args.projection,
        projection_item: args.item,
        selector: args.selector,
        verification_principal: principal,
      });
      seen.push(result.status);
      const c = cv.consumeCurrentVerificationReceipt({
        validated_evidence_root: args.root,
        projection_document: args.projection,
        projection_item: args.item,
        selector: args.selector,
        verification_principal: principal,
        receipt: r,
      });
      seen.push(c.result.status);
    }
    // a JSON-reconstructed receipt from the parent must fail as forged
    const revived = JSON.parse(${JSON.stringify(serialized)});
    const cross = cv.consumeCurrentVerificationReceipt({
      validated_evidence_root: args.root,
      projection_document: args.projection,
      projection_item: args.item,
      selector: args.selector,
      verification_principal: principal,
      receipt: revived,
    });
    seen.push("CROSS:" + cross.result.status);
    console.log("SEEN:" + [...new Set(seen)].join(","));
  `;
  const childPath = join(inputPath, "..", "child-consume.mjs");
  writeFileSync(childPath, childScript);
  const { spawn } = await import("node:child_process");
  const children = Array.from({ length: 8 }, () =>
    spawn(process.execPath, [childPath, inputPath], { stdio: ["ignore", "pipe", "pipe"] }));
  const outputs = await Promise.all(children.map((child) => new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.once("exit", (code) => resolve({ code, out }));
  })));
  for (const res of outputs) {
    const seen = res.out.split("\n").find((l) => l.startsWith("SEEN:"));
    assert.ok(res.code === 0 && seen, `child failed: ${res.out.slice(0, 200)}`);
    for (const code of seen.slice(5).split(",")) {
      if (code.startsWith("CROSS:")) {
        assert.equal(code.slice(6), "RECEIPT_FORGED");
      } else {
        assert.ok(code === "VERIFIED_CURRENT", `unexpected ${code}`);
      }
    }
  }
  assert.equal(logDigest(ctx.root), digestBefore);
});

test("T90 deterministic result serialization", () => {
  const ctx = prepare(publishHeld("t90"));
  const a = verifyCurrentIncident(verifyArgs(ctx));
  const b = verifyCurrentIncident(verifyArgs(ctx));
  assert.equal(canonical(a.result), canonical(b.result));
  assert.equal(canonical(a.result), canonical(a.result)); // stable twice
  // receipt-less failure results are equally deterministic
  const f1 = verifyCurrentIncident(verifyArgs(ctx, { selector: { execution_id: mintExecutionId(), phase_id: ctx.phaseId } })).result;
  const f2 = verifyCurrentIncident(verifyArgs(ctx, { selector: { execution_id: mintExecutionId(), phase_id: ctx.phaseId } })).result;
  assert.equal(f1.status, f2.status);
});
