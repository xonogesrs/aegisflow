// test/learning/test-lifecycle-terminal-incident-adapter.mjs
// Offline C3 PHASE_HELD adapter T1–T48. Not a production emitter.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  RunEvidenceStore,
  canonicalJson,
  sha256Text,
  journalDir,
  journalFileName,
} from "../../src/evidence/run-evidence-store.mjs";
import { finalizeRunManifest, buildRunManifest } from "../../src/evidence/run-manifest.mjs";
import { writeExclusiveCreate, sha256Hex } from "../../src/c2d/fs-atomic.mjs";
import { createInitialSnapshot as makeSnap } from "../../src/c2d/checkpoint-store.mjs";
import { mintExecutionId, mintChainId, mintCheckpointId } from "../../src/c2d/execution-id.mjs";
import {
  EVENT_TYPES,
  TRANSFER_CODES,
} from "../../src/learning/transfer-metrics/schema.mjs";
import {
  isTransferMetricsEnabled,
  getTransferMetricsWriter,
  TRANSFER_METRICS_ENABLED,
} from "../../src/learning/transfer-metrics/seam.mjs";
import { TransferMetricsWriter } from "../../src/learning/transfer-metrics/writer.mjs";
import { readLog, LOG_FILE_NAME } from "../../src/learning/transfer-metrics/log.mjs";
import {
  FIXTURE,
  SYSTEM,
  makeIdentities,
  makeBinder,
  createTestWriter,
  createTestRoot,
} from "../../src/learning/transfer-metrics/fixtures.mjs";
import {
  observeLifecycleHeldIncident,
  verifyLifecycleHeldTerminal,
  appendFromVerifiedTerminalReceipt,
  isVerifiedTerminalReceipt,
  ADAPTER_CODES,
  LIFECYCLE_TERMINAL_DISCRIMINATORS_V1,
  SOURCE_AUTHORITY_IDENTITY,
  MAX_TERMINALS_PER_CALL,
  HISTORY_SCAN,
} from "../../src/learning/incidents/lifecycle-terminal-adapter.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");

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

function resultDigest(execDir, phaseId) {
  return sha256Hex(readFileSync(join(execDir, "phases", phaseId, "result.json")));
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

function publishHeld(label, overrides = {}) {
  const ids = makeIdentities(label);
  const execution_id = mintExecutionId();
  const chainId = mintChainId();
  const checkpointId = mintCheckpointId();
  ids.execution_id = execution_id;
  const attempt = overrides.attempt ?? 0;
  ids.attempt_identity = { execution_id, attempt };
  const phaseId = overrides.phaseId ?? "p_impl";
  const reason = Object.prototype.hasOwnProperty.call(overrides, "reason") ? overrides.reason : "REVIEWER_HOLD";
  const final = overrides.final ?? "HOLD";
  const status = overrides.status ?? "held";
  const eventType = overrides.eventType ?? "PHASE_HELD";
  const graph_generation = Object.prototype.hasOwnProperty.call(overrides, "graph_generation")
    ? overrides.graph_generation
    : 0;
  const evidenceRoot = createTestRoot(`c3-${label}`);
  const store = new RunEvidenceStore({
    root: evidenceRoot,
    executionId: execution_id,
    chainId,
    checkpointId,
    repoRoot: ids.project_identity.repository_root_identity,
  });
  store.init();
  const extraEvents = overrides.extraJournalEvents ?? [];
  for (const ev of extraEvents) store.appendEvent(ev);
  let held = null;
  if (overrides.skipHeld !== true) {
    const payload = { final, reason, ...(overrides.journalPayload ?? {}) };
    if (overrides.omitJournalReason) delete payload.reason;
    held = store.appendEvent({
      event_type: eventType,
      stage: "phase",
      phase_id: phaseId,
      attempt: Object.prototype.hasOwnProperty.call(overrides, "journalAttempt") ? overrides.journalAttempt : attempt,
      status,
      payload,
    });
    if (overrides.stripEventId) {
      const path = join(journalDir(store.execDir), journalFileName(held.sequence));
      const event = JSON.parse(readFileSync(path, "utf8"));
      delete event.event_id;
      const withoutSelf = { ...event };
      delete withoutSelf.event_sha256;
      event.event_sha256 = sha256Text(canonicalJson(withoutSelf) + "\n");
      unlinkSync(path);
      writeExclusiveCreate(path, canonicalJson(event) + "\n");
      held = event;
    }
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
      attempt: Object.prototype.hasOwnProperty.call(overrides, "resultAttempt") ? overrides.resultAttempt : attempt,
      reason: Object.prototype.hasOwnProperty.call(overrides, "resultReason") ? overrides.resultReason : reason,
      graph_generation,
      recorded_at: new Date().toISOString(),
      ...(overrides.synthesized ? { synthesized: true } : {}),
      ...(overrides.resultExtra ?? {}),
    };
    written = store.writePhaseArtifact(phaseId, "result.json", resultRecord);
  }
  for (const art of overrides.extraPhaseArtifacts ?? []) {
    store.writePhaseArtifact(phaseId, art.name, art.obj);
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
    if (overrides.recovery_generation != null) {
      snapshot.graph = { recovery_generation: overrides.recovery_generation };
    }
    if (overrides.checkpointExecutionId) snapshot.execution_id = overrides.checkpointExecutionId;
    writeCheckpoint(store.execDir, snapshot);
  }
  if (overrides.writeManifest !== false) {
    const manifest = buildRunManifest({
      executionId: overrides.manifestExecutionId ?? execution_id,
      chainId,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      final_verdict: final,
      final_reason: reason,
      input_fingerprint: "0".repeat(64),
      configuration_fingerprint: "0".repeat(64),
      repository_fingerprint: "0".repeat(64),
      decomposition_ir_sha256: "0".repeat(64),
      dag_sha256: "0".repeat(64),
      journal_event_count: store.journalHead.seq,
      journal_head_sha256: store.journalHead.sha256,
      checkpoint_revision: 0,
      checkpoint_sha256: "0".repeat(64),
      phase_results: overrides.omitManifestPin
        ? []
        : [{ phase_id: phaseId, result_hash: overrides.wrongManifestPin ?? pin }],
      artifact_inventory: [],
      secret_scan_result: { scanned: true, matches: [] },
      format_versions: {},
    });
    if (overrides.corruptManifestSha) {
      writeExclusiveCreate(join(store.execDir, "manifest.json"), canonicalJson(manifest) + "\n");
      writeExclusiveCreate(join(store.execDir, "manifest.json.sha256"), "ab".repeat(32) + "\n");
    } else {
      finalizeRunManifest(store.execDir, manifest);
    }
  }
  const binderExtra = {
    attempts: new Map([[execution_id, { attempts: new Set([attempt, 0, 1, 2]) }]]),
    ...(overrides.binderExtra ?? {}),
  };
  const { root, writer } = createTestWriter(ids, {
    identityBinder: makeBinder(ids, binderExtra),
    clock: nowClock(),
    allowFixture: overrides.allowFixture ?? true,
    crashHooks: overrides.crashHooks ?? {},
    revocationRegistry: overrides.revocationRegistry,
  });
  const binding = {
    project_identity: overrides.project_identity ?? ids.project_identity,
    task_identity: overrides.task_identity ?? ids.task_identity,
    attempt_identity: overrides.includeAttempt === false ? undefined : ids.attempt_identity,
    writer: { writer_id: "w1", writer_generation: 0 },
  };
  if (Object.prototype.hasOwnProperty.call(overrides, "revocation_generation")) {
    binding.revocation_generation = overrides.revocation_generation;
  }
  return {
    ids,
    store,
    evidenceRoot,
    execution_id,
    phaseId,
    held,
    pin,
    writer,
    metricsRoot: root,
    binding,
    reference: {
      evidenceRoot,
      execution_id,
      phase_id: overrides.observePhaseId ?? phaseId,
    },
  };
}

function observe(ctx, extra = {}) {
  return observeLifecycleHeldIncident({
    authoritativeSourceReference: extra.reference ?? ctx.reference,
    expectedIdentityBinding: extra.binding ?? ctx.binding,
    transferMetricsWriter: extra.writer ?? ctx.writer,
    observerPrincipal: extra.principal ?? FIXTURE,
  });
}

function scanProductionAdapterHits() {
  const hits = [];
  const needles = [
    "learning/incidents/lifecycle-terminal-adapter",
    "observeLifecycleHeldIncident",
    "verifyLifecycleHeldTerminal",
  ];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!(name.endsWith(".mjs") || name.endsWith(".js"))) continue;
      const rel = relative(REPO, p);
      if (rel === "src/learning/incidents/lifecycle-terminal-adapter.mjs") continue;
      if (rel.startsWith("test/")) continue;
      const text = readFileSync(p, "utf8");
      for (const n of needles) {
        if (text.includes(n)) hits.push({ rel, needle: n });
      }
    }
  }
  walk(join(REPO, "src"));
  if (existsSync(join(REPO, "scripts"))) walk(join(REPO, "scripts"));
  return hits;
}

test("T1 valid REVIEWER_HOLD", () => {
  const ctx = publishHeld("t1");
  const before = resultDigest(ctx.store.execDir, ctx.phaseId);
  const beforeLog = logDigest(ctx.metricsRoot);
  const r = observe(ctx);
  assert.equal(r.status, "APPENDED");
  assert.equal(r.event_type, "INCIDENT_OBSERVED");
  assert.equal(r.source_record_id, ctx.held.event_id);
  assert.equal(logCount(ctx.metricsRoot), 1);
  const ev = readLog(ctx.metricsRoot).events[0];
  assert.equal(ev.event_type, "INCIDENT_OBSERVED");
  assert.equal(ev.payload.source_class, "LIFECYCLE_TERMINAL");
  assert.equal(ev.payload.failure_finding_discriminator, "REVIEWER_HOLD");
  assert.equal(ev.payload.source_record_id, ctx.held.event_id);
  assert.equal(ev.payload.source_authority_identity, SOURCE_AUTHORITY_IDENTITY);
  assert.equal(ev.payload.evidence_completeness_class, "COMPLETE");
  assert.equal(ev.payload.observed_outcome_class, "HOLD");
  assert.equal(resultDigest(ctx.store.execDir, ctx.phaseId), before);
  assert.notEqual(logDigest(ctx.metricsRoot), beforeLog);
});

test("T2 valid REPAIR_BUDGET_EXHAUSTED", () => {
  const ctx = publishHeld("t2", { reason: "REPAIR_BUDGET_EXHAUSTED" });
  const r = observe(ctx);
  assert.equal(r.status, "APPENDED");
  assert.equal(readLog(ctx.metricsRoot).events[0].payload.failure_finding_discriminator, "REPAIR_BUDGET_EXHAUSTED");
  assert.equal(LIFECYCLE_TERMINAL_DISCRIMINATORS_V1.length, 2);
});

test("T3 PHASE_PASSED rejected", () => {
  const ctx = publishHeld("t3", { final: "PASS", status: "passed", eventType: "PHASE_PASSED", reason: null, resultReason: null });
  const before = logDigest(ctx.metricsRoot);
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.PHASE_PASSED);
  assert.equal(logCount(ctx.metricsRoot), 0);
  assert.equal(logDigest(ctx.metricsRoot), before);
});

test("T4 RUN_HELD rejected", () => {
  const ctx = publishHeld("t4", {
    skipHeld: true,
    writeResult: false,
    parentRun: { event_type: "RUN_HELD" },
    forcePin: "11".repeat(32),
  });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.ok([ADAPTER_CODES.PARENT_TERMINAL, ADAPTER_CODES.RESULT_MISSING, ADAPTER_CODES.MISSING_PHASE_HELD].includes(r.code));
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T5 RUN_ABORTED rejected", () => {
  const ctx = publishHeld("t5", {
    skipHeld: true,
    writeResult: false,
    parentRun: { event_type: "RUN_ABORTED" },
    forcePin: "11".repeat(32),
  });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T6 PHASE_RUNNING rejected", () => {
  const ctx = publishHeld("t6", {
    skipHeld: true,
    extraJournalEvents: [{ event_type: "PHASE_STARTED", stage: "phase", phase_id: "p_impl", status: "running", payload: {} }],
    writeResult: false,
    forcePin: "11".repeat(32),
  });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.ok([ADAPTER_CODES.NON_TERMINAL, ADAPTER_CODES.RESULT_MISSING, ADAPTER_CODES.MISSING_PHASE_HELD].includes(r.code));
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T7 timeout rejected", () => {
  const ctx = publishHeld("t7", { reason: "EXECUTOR_TIMEOUT" });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.REASON_NOT_ALLOWLISTED);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T8 environment failure rejected", () => {
  const ctx = publishHeld("t8", { reason: "ENVIRONMENT_FAILURE" });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.REASON_NOT_ALLOWLISTED);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T9 cancelled/user stop rejected", () => {
  const ctx = publishHeld("t9", { reason: "EXECUTOR_ABORTED" });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.REASON_NOT_ALLOWLISTED);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T10 unknown reason rejected", () => {
  const ctx = publishHeld("t10", { reason: "UNKNOWN_HOLD_CODE" });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.REASON_NOT_ALLOWLISTED);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T11 free-form reason rejected", () => {
  const ctx = publishHeld("t11", { reason: "exception:boom" });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.REASON_FREE_FORM);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T12 missing reason rejected", () => {
  const ctx = publishHeld("t12", { reason: null });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.REASON_MISSING);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T13 missing PHASE_HELD event ID", () => {
  const ctx = publishHeld("t13", { stripEventId: true });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.MISSING_EVENT_ID);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T14 duplicate PHASE_HELD event ID", () => {
  const ctx = publishHeld("t14", {
    extraJournalEvents: [{ event_type: "RUN_CREATED", stage: "run", payload: { a: 1 } }],
  });
  const firstPath = join(journalDir(ctx.store.execDir), journalFileName(ctx.held.sequence));
  const dup = ctx.store.appendEvent({
    event_type: "PHASE_HELD",
    stage: "phase",
    phase_id: ctx.phaseId,
    attempt: 0,
    status: "held",
    payload: { final: "HOLD", reason: "REVIEWER_HOLD" },
  });
  const dupPath = join(journalDir(ctx.store.execDir), journalFileName(dup.sequence));
  const event = JSON.parse(readFileSync(dupPath, "utf8"));
  event.event_id = JSON.parse(readFileSync(firstPath, "utf8")).event_id;
  const withoutSelf = { ...event };
  delete withoutSelf.event_sha256;
  event.event_sha256 = sha256Text(canonicalJson(withoutSelf) + "\n");
  unlinkSync(dupPath);
  writeExclusiveCreate(dupPath, canonicalJson(event) + "\n");
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.DUPLICATE_EVENT_ID);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T15 conflicting duplicate journal event", () => {
  const ctx = publishHeld("t15", {
    secondHeld: { final: "HOLD", reason: "REPAIR_BUDGET_EXHAUSTED" },
  });
  const r = observe(ctx);
  assert.equal(r.status, "CONFLICT");
  assert.equal(r.code, ADAPTER_CODES.SOURCE_CONFLICT);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T16 corrupt journal middle", () => {
  const ctx = publishHeld("t16", {
    extraJournalEvents: [{ event_type: "RUN_CREATED", stage: "run", payload: { a: 1 } }],
  });
  const mid = join(journalDir(ctx.store.execDir), journalFileName(1));
  writeFileSync(mid, "{not-json");
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.JOURNAL_CORRUPT);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T17 corrupt journal tail", () => {
  const ctx = publishHeld("t17");
  const tail = join(journalDir(ctx.store.execDir), journalFileName(ctx.held.sequence));
  writeFileSync(tail, readFileSync(tail).subarray(0, 12));
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.JOURNAL_CORRUPT);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T18 wrong phase ID", () => {
  const ctx = publishHeld("t18", { observePhaseId: "p_other" });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.ok([ADAPTER_CODES.RESULT_MISSING, ADAPTER_CODES.PHASE_ID_MISMATCH, ADAPTER_CODES.PHASE_RESULT_HASH_MISSING].includes(r.code));
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T19 result missing", () => {
  const ctx = publishHeld("t19", { writeResult: false, forcePin: "11".repeat(32) });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.RESULT_MISSING);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T20 result malformed", () => {
  const ctx = publishHeld("t20", { writeResult: false, forcePin: "11".repeat(32) });
  mkdirSync(join(ctx.store.execDir, "phases", ctx.phaseId), { recursive: true, mode: 0o700 });
  writeExclusiveCreate(join(ctx.store.execDir, "phases", ctx.phaseId, "result.json"), "not-json\n");
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.ok([ADAPTER_CODES.RESULT_MALFORMED, ADAPTER_CODES.PHASE_RESULT_HASH_MISMATCH].includes(r.code));
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T21 result verdict mismatch", () => {
  const ctx = publishHeld("t21", { resultFinal: "PASS", resultStatus: "passed" });
  const r = observe(ctx);
  assert.ok(r.status === "REJECTED" || r.status === "CONFLICT");
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T22 result reason mismatch", () => {
  const ctx = publishHeld("t22", { resultReason: "REPAIR_BUDGET_EXHAUSTED" });
  const r = observe(ctx);
  assert.ok(r.status === "REJECTED" || r.status === "CONFLICT");
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T23 phase_result_hash missing", () => {
  const ctx = publishHeld("t23", { omitPin: true });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.PHASE_RESULT_HASH_MISSING);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T24 phase_result_hash mismatch", () => {
  const ctx = publishHeld("t24", { wrongPin: "ab".repeat(32) });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.PHASE_RESULT_HASH_MISMATCH);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T25 manifest missing", () => {
  const ctx = publishHeld("t25", { writeManifest: false });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.MANIFEST_MISSING);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T26 manifest identity mismatch", () => {
  const ctx = publishHeld("t26", { manifestExecutionId: mintExecutionId() });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.MANIFEST_IDENTITY_MISMATCH);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T27 manifest self-hash mismatch", () => {
  const ctx = publishHeld("t27", { corruptManifestSha: true });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.MANIFEST_HASH_MISMATCH);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T28 wrong project/worktree", () => {
  const ctx = publishHeld("t28");
  const other = makeIdentities("t28-other");
  ctx.binding.project_identity = other.project_identity;
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.ok([ADAPTER_CODES.SOURCE_IDENTITY_BINDING_MISMATCH, TRANSFER_CODES.PROJECT_UNBOUND].includes(r.code));
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T29 wrong task", () => {
  const ctx = publishHeld("t29");
  ctx.binding.task_identity = { task_id: "nope", admission_id: "ab".repeat(32) };
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.ok([ADAPTER_CODES.SOURCE_IDENTITY_BINDING_MISMATCH, TRANSFER_CODES.TASK_UNBOUND].includes(r.code));
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T30 wrong attempt", () => {
  const ctx = publishHeld("t30", { includeAttempt: true });
  ctx.binding.attempt_identity = { execution_id: ctx.execution_id, attempt: 9 };
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.ok([ADAPTER_CODES.SOURCE_IDENTITY_BINDING_MISMATCH, TRANSFER_CODES.ATTEMPT_UNBOUND].includes(r.code));
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T31 wrong authority generation", () => {
  const ctx = publishHeld("t31", { graph_generation: 2, recovery_generation: 0 });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.STALE_GENERATION);
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T32 wrong revocation generation", () => {
  const ctx = publishHeld("t32", {
    binderExtra: { truthGenerations: new Map() },
  });
  const pin = ctx.pin;
  ctx.writer.identityBinder = makeBinder(ctx.ids, {
    attempts: new Map([[ctx.execution_id, { attempts: new Set([0, 1, 2]) }]]),
    truthGenerations: new Map([[pin, 4]]),
  });
  ctx.binding.revocation_generation = 0;
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.ok([TRANSFER_CODES.STALE_GENERATION, TRANSFER_CODES.WRONG_GENERATION].includes(r.code));
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T33 revoked source", () => {
  const ctx = publishHeld("t33");
  ctx.writer.identityBinder = makeBinder(ctx.ids, {
    attempts: new Map([[ctx.execution_id, { attempts: new Set([0, 1, 2]) }]]),
    truthGenerations: new Map([[ctx.pin, 1]]),
  });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.ok([TRANSFER_CODES.WRONG_GENERATION, TRANSFER_CODES.STALE_GENERATION].includes(r.code));
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T34 revoked observer", () => {
  const ctx = publishHeld("t34");
  ctx.writer.revokeWriter("w1", { issuer: ctx.writer.fixtureAuthorityIssuer(), mutationId: "t34-revoke", expected: 0, task_identity: ctx.ids.task_identity });
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, TRANSFER_CODES.WRITER_REVOKED);
  // Durable revocation wrote exactly ONE sealed authority record; the
  // rejected observation appended no measurement event.
  assert.equal(logCount(ctx.metricsRoot), 1);
});

test("T35 forged plain-object receipt", () => {
  const ctx = publishHeld("t35");
  const r = appendFromVerifiedTerminalReceipt({
    receipt: { is_verified: true, source_record_id: "evt_forged", verified: true },
    transferMetricsWriter: ctx.writer,
    observerPrincipal: FIXTURE,
  });
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.RECEIPT_FORGED);
  assert.equal(logCount(ctx.metricsRoot), 0);
  assert.equal(isVerifiedTerminalReceipt({ is_verified: true }), false);
});

test("T36 serialized/cloned receipt replay", () => {
  const ctx = publishHeld("t36");
  const receipt = verifyLifecycleHeldTerminal({
    authoritativeSourceReference: ctx.reference,
    expectedIdentityBinding: ctx.binding,
    identityBinder: ctx.writer.identityBinder,
  });
  assert.equal(isVerifiedTerminalReceipt(receipt), true);
  const jsonReplay = appendFromVerifiedTerminalReceipt({
    receipt: JSON.parse(JSON.stringify(receipt)),
    transferMetricsWriter: ctx.writer,
    observerPrincipal: FIXTURE,
  });
  assert.equal(jsonReplay.status, "REJECTED");
  assert.ok([ADAPTER_CODES.RECEIPT_REPLAY, ADAPTER_CODES.RECEIPT_FORGED].includes(jsonReplay.code));
  const cloned = appendFromVerifiedTerminalReceipt({
    receipt: { ...receipt },
    transferMetricsWriter: ctx.writer,
    observerPrincipal: FIXTURE,
  });
  assert.equal(cloned.status, "REJECTED");
  assert.equal(logCount(ctx.metricsRoot), 0);
});

test("T37 same terminal retry", () => {
  const ctx = publishHeld("t37");
  const first = observe(ctx);
  assert.equal(first.status, "APPENDED");
  const retry = observe(ctx);
  assert.equal(retry.status, "ALREADY_SATISFIED");
  assert.equal(retry.source_record_id, first.source_record_id);
  assert.equal(logCount(ctx.metricsRoot), 1);
});

test("T38 reconcile replay", () => {
  const ctx = publishHeld("t38");
  observe(ctx);
  const restarted = new TransferMetricsWriter({
    transferMetricsRoot: ctx.metricsRoot,
    identityBinder: ctx.writer.identityBinder,
    allowFixture: true,
    clock: nowClock(),
  });
  const replay = observe(ctx, { writer: restarted });
  assert.equal(replay.status, "ALREADY_SATISFIED");
  assert.equal(logCount(ctx.metricsRoot), 1);
});

test("T39 same source ID/different result digest", () => {
  const ctx = publishHeld("t39");
  assert.equal(observe(ctx).status, "APPENDED");
  const resultPath = join(ctx.store.execDir, "phases", ctx.phaseId, "result.json");
  const prev = JSON.parse(readFileSync(resultPath, "utf8"));
  unlinkSync(resultPath);
  const written = ctx.store.writePhaseArtifact(ctx.phaseId, "result.json", { ...prev, recorded_at: "2099-01-01T00:00:00.000Z" });
  const snap = JSON.parse(readFileSync(join(ctx.store.execDir, "CURRENT.json"), "utf8"));
  snap.phase_result_hashes[ctx.phaseId] = written.sha256;
  replaceCheckpoint(ctx.store.execDir, snap);
  unlinkSync(join(ctx.store.execDir, "manifest.json"));
  unlinkSync(join(ctx.store.execDir, "manifest.json.sha256"));
  finalizeRunManifest(ctx.store.execDir, buildRunManifest({
    executionId: ctx.execution_id,
    chainId: ctx.store.chainId,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    final_verdict: "HOLD",
    final_reason: "REVIEWER_HOLD",
    input_fingerprint: "0".repeat(64),
    configuration_fingerprint: "0".repeat(64),
    repository_fingerprint: "0".repeat(64),
    decomposition_ir_sha256: "0".repeat(64),
    dag_sha256: "0".repeat(64),
    journal_event_count: ctx.store.journalHead.seq,
    journal_head_sha256: ctx.store.journalHead.sha256,
    checkpoint_revision: 0,
    checkpoint_sha256: "0".repeat(64),
    phase_results: [{ phase_id: ctx.phaseId, result_hash: written.sha256 }],
    artifact_inventory: [],
    secret_scan_result: { scanned: true, matches: [] },
    format_versions: {},
  }));
  const r = observe(ctx);
  assert.equal(r.status, "CONFLICT");
  assert.equal(r.code, TRANSFER_CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(logCount(ctx.metricsRoot), 1);
});

test("T40 same source ID/different evidence", () => {
  const ctx = publishHeld("t40");
  assert.equal(observe(ctx).status, "APPENDED");
  unlinkSync(join(ctx.store.execDir, "manifest.json"));
  unlinkSync(join(ctx.store.execDir, "manifest.json.sha256"));
  finalizeRunManifest(ctx.store.execDir, buildRunManifest({
    executionId: ctx.execution_id,
    chainId: ctx.store.chainId,
    created_at: "2020-01-01T00:00:00.000Z",
    completed_at: "2020-01-01T00:00:01.000Z",
    final_verdict: "HOLD",
    final_reason: "REVIEWER_HOLD",
    input_fingerprint: "0".repeat(64),
    configuration_fingerprint: "0".repeat(64),
    repository_fingerprint: "0".repeat(64),
    decomposition_ir_sha256: "0".repeat(64),
    dag_sha256: "0".repeat(64),
    journal_event_count: ctx.store.journalHead.seq,
    journal_head_sha256: ctx.store.journalHead.sha256,
    checkpoint_revision: 0,
    checkpoint_sha256: "0".repeat(64),
    phase_results: [{ phase_id: ctx.phaseId, result_hash: ctx.pin }],
    artifact_inventory: [],
    secret_scan_result: { scanned: true, matches: [] },
    format_versions: {},
  }));
  const r = observe(ctx);
  assert.equal(r.status, "CONFLICT");
  assert.equal(r.code, TRANSFER_CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(logCount(ctx.metricsRoot), 1);
});

test("T41 distinct attempt same reason", () => {
  const a = publishHeld("t41a", { attempt: 0 });
  const b = publishHeld("t41b", { attempt: 1 });
  b.writer = a.writer;
  b.metricsRoot = a.metricsRoot;
  b.ids.project_identity = a.ids.project_identity;
  b.ids.task_identity = a.ids.task_identity;
  b.binding.project_identity = a.binding.project_identity;
  b.binding.task_identity = a.binding.task_identity;
  a.writer.identityBinder = makeBinder(a.ids, {
    attempts: new Map([
      [a.execution_id, { attempts: new Set([0, 1, 2]) }],
      [b.execution_id, { attempts: new Set([0, 1, 2]) }],
    ]),
  });
  assert.equal(observe(a).status, "APPENDED");
  assert.equal(observe(b).status, "APPENDED");
  assert.equal(logCount(a.metricsRoot), 2);
  const events = readLog(a.metricsRoot).events;
  assert.notEqual(events[0].payload.source_record_id, events[1].payload.source_record_id);
});

test("T42 parent RUN_HELD no double count", () => {
  const ctx = publishHeld("t42", { parentRun: { event_type: "RUN_HELD" } });
  assert.equal(observe(ctx).status, "APPENDED");
  assert.equal(logCount(ctx.metricsRoot), 1);
  const parent = observeLifecycleHeldIncident({
    authoritativeSourceReference: ctx.reference,
    expectedIdentityBinding: ctx.binding,
    transferMetricsWriter: ctx.writer,
    observerPrincipal: FIXTURE,
  });
  assert.equal(parent.status, "ALREADY_SATISFIED");
  assert.equal(logCount(ctx.metricsRoot), 1);
});

test("T43 reviewer finding not expanded", () => {
  const ctx = publishHeld("t43", {
    extraPhaseArtifacts: [{
      name: "reviewer-verdict-0.json",
      obj: { findings: [{ id: "f1", prose: "issue one" }, { id: "f2", prose: "issue two" }] },
    }],
  });
  assert.equal(observe(ctx).status, "APPENDED");
  assert.equal(logCount(ctx.metricsRoot), 1);
  const ev = readLog(ctx.metricsRoot).events[0];
  assert.equal(ev.event_type, "INCIDENT_OBSERVED");
  assert.equal(ev.payload.failure_finding_discriminator, "REVIEWER_HOLD");
  assert.equal(JSON.stringify(ev).includes("issue one"), false);
});

test("T44 recorded_at writer-owned", () => {
  const ctx = publishHeld("t44");
  const r = observeLifecycleHeldIncident({
    authoritativeSourceReference: ctx.reference,
    expectedIdentityBinding: ctx.binding,
    transferMetricsWriter: ctx.writer,
    observerPrincipal: FIXTURE,
    recorded_at: "1999-01-01T00:00:00.000Z",
  });
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, ADAPTER_CODES.INPUT_INVALID);
  const ok = observe(ctx);
  assert.equal(ok.status, "APPENDED");
  const ev = readLog(ctx.metricsRoot).events[0];
  assert.notEqual(ev.recorded_at, "1999-01-01T00:00:00.000Z");
  assert.notEqual(ev.recorded_at, ev.occurred_at);
});

test("T45 crash after durable append/restart retry", () => {
  let crashed = false;
  const ctx = publishHeld("t45", {
    crashHooks: {
      afterFsync() {
        if (!crashed) {
          crashed = true;
          throw new Error("crash-after-fsync");
        }
      },
    },
  });
  assert.throws(() => observe(ctx));
  assert.equal(logCount(ctx.metricsRoot), 1);
  const retry = observe(ctx);
  assert.equal(retry.status, "ALREADY_SATISFIED");
  assert.equal(logCount(ctx.metricsRoot), 1);
});

test("T46 raw log corruption fail-closed", () => {
  const ctx = publishHeld("t46");
  assert.equal(observe(ctx).status, "APPENDED");
  const logPath = join(ctx.metricsRoot, LOG_FILE_NAME);
  const text = readFileSync(logPath, "utf8");
  const lines = text.split("\n");
  lines.splice(1, 0, "{not-json");
  writeFileSync(logPath, lines.join("\n"));
  const r = observe(ctx);
  assert.equal(r.status, "REJECTED");
  assert.equal(r.code, TRANSFER_CODES.LOG_CHAIN_INVALID);
});

test("T47 one-source bound/data minimization", () => {
  const ctx = publishHeld("t47");
  const batch = observeLifecycleHeldIncident({
    authoritativeSourceReference: [ctx.reference, ctx.reference],
    expectedIdentityBinding: ctx.binding,
    transferMetricsWriter: ctx.writer,
    observerPrincipal: FIXTURE,
  });
  assert.equal(batch.status, "REJECTED");
  assert.equal(batch.code, ADAPTER_CODES.ONE_SOURCE_BOUND);
  const ok = observe(ctx);
  assert.equal(ok.status, "APPENDED");
  const dumped = JSON.stringify(ok);
  assert.equal(dumped.includes("/Volumes/"), false);
  assert.equal(dumped.includes("sk-"), false);
  assert.equal(dumped.includes("prompt"), false);
  assert.equal(dumped.includes("stdout"), false);
  const ev = JSON.stringify(readLog(ctx.metricsRoot).events[0]);
  assert.equal(ev.includes("root_cause"), false);
  assert.equal(MAX_TERMINALS_PER_CALL, 1);
  assert.equal(HISTORY_SCAN, "NONE");
});

test("T48 no production importer/hook/second engine", () => {
  const adapterPath = join(REPO, "src/learning/incidents/lifecycle-terminal-adapter.mjs");
  assert.equal(existsSync(adapterPath), true);
  const src = readFileSync(adapterPath, "utf8");
  assert.equal(/from\s+['\"][^'\"]*lifecycle-runner/.test(src), false);
  assert.equal(src.includes("createLifecycleOutcomeAdapter"), false);
  assert.equal(/from\s+['\"][^'\"]*durable-graph/.test(src), false);
  assert.equal(/from\s+['\"][^'\"]*durable-execution/.test(src), false);
  assert.equal(/from\s+['\"][^'\"]*execution-orchestrator/.test(src), false);
  assert.equal(src.includes("appendFileSync"), false);
  assert.equal(src.includes("sqlite"), false);
  assert.equal(EVENT_TYPES.length, 14);
  assert.equal(TRANSFER_METRICS_ENABLED, false);
  assert.equal(isTransferMetricsEnabled(), false);
  assert.equal(getTransferMetricsWriter(), null);
  process.env.TRANSFER_METRICS_ENABLED = "true";
  assert.equal(isTransferMetricsEnabled(), false);
  delete process.env.TRANSFER_METRICS_ENABLED;
  const hits = scanProductionAdapterHits();
  assert.equal(hits.length, 0, JSON.stringify(hits));
  assert.equal(existsSync(join(REPO, "src/learning/incident-observation")), false);
});
