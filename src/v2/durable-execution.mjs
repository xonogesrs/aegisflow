// src/v2/durable-execution.mjs
//
// C3 — Durable AutoLoop execution（evidence journal + atomic checkpoint +
// safe resume + final manifest）.
//
// Composition:
//  - evidence journal / artifacts: src/evidence/run-evidence-store.mjs
//  - checkpoint CURRENT.json: src/v2/checkpoint-bridge.mjs over the sealed
//    C2D checkpoint store（checksum + CAS + permit + structured lock）
//  - scheduling: sealed runner.mjs via src/v2/execution-orchestrator.mjs
//  - final manifest: src/evidence/run-manifest.mjs
//
// Safety rules enforced here:
//  - Every journal event is durably written before the next model/adapter
//    call; checkpoints are published at every safe boundary（§10）.
//  - A checkpoint publication failure or evidence write failure stops the
//    run（HOLD / CHECKPOINT_PUBLICATION_FAILED）— never silently ignored.
//  - Resume never re-decomposes and never re-runs completed phases.
//  - Interrupted writer phases fail closed
//    （HOLD / INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED）.
//  - Secrets / env dumps / raw reasoning never reach disk.

import { join } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RunEvidenceStore, canonicalJson, sha256Text, EvidenceHoldError } from "../evidence/run-evidence-store.mjs";
import { listDirSafe } from "../c2d/fs-atomic.mjs";
import { finalizeRunManifest, buildRunManifest, writeFinalReport, MANIFEST_FORMAT_VERSION } from "../evidence/run-manifest.mjs";
import {
  validateRunIdentity, collectRepositoryFingerprint, publishCheckpoint, readCheckpoint, checkpointExists,
  buildInputFingerprint, buildConfigurationFingerprint, buildDagFingerprint, buildIrSha256,
  AUTOLOOP_CHECKPOINT_FORMAT_VERSION, deriveChainId, deriveCheckpointId,
  classifyResumeCapability, classifyPostHeadEvent,
} from "./checkpoint-bridge.mjs";
import { runExecutionOrchestrator } from "./execution-orchestrator.mjs";
import { runProductionPipeline } from "./production-pipeline.mjs";
import { requiresWriterLease } from "./runner.mjs";
import { assertValidEvidenceRoot } from "../evidence/run-evidence-store.mjs";

export const DURABLE_FORMAT_VERSION = "1.0.0";

// ── C4F — bounded DECOMPOSITION_HELD diagnostics ───────────────────────────
// On a decomposition hold the rejected IR, the validation/gate snapshots and
// the hardFailures are persisted（bounded, deterministic truncation, still
// passing through the existing SECRET_PATTERNS fail-closed write path）so the
// exact failure gate / field is reconstructable from durable evidence. The
// decomposition decision semantics are untouched: gates, schema, prompt and
// policy are not modified; nothing here adds repair/retry/resample/fallback.
export const DECOMP_HOLD_DIAGNOSTICS_LIMITS = Object.freeze({
  format_version: "1.0.0",
  max_field_chars: 4096,      // per free-text field cap（deterministic truncation）
  max_hard_failures: 64,      // max hardFailures / frontier entries persisted
  max_failure_chars: 512,     // per failure-message cap
  max_ir_bytes: 48 * 1024,    // serialized IR cap（< evidence free-text budget 64 KiB）
  max_reason_chars: 2048,     // final reason cap
});

function boundText(value, maxChars) {
  if (typeof value !== "string") return value;
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

/** Bound a list of failure strings（count + per-entry length caps）. */
function boundFailureList(list, limits = DECOMP_HOLD_DIAGNOSTICS_LIMITS) {
  return (list || []).slice(0, limits.max_hard_failures).map((s) => boundText(String(s), limits.max_failure_chars));
}

/**
 * Bounded clone of the rejected IR for diagnostics: only long free-text
 * fields are truncated（deterministically, marked）; every gate-relevant
 * structural value（phase_id / purpose / effects enums / boundaries /
 * covers requirement_id+completeness / depends_on / subject_phase_ids）is
 * short and preserved unchanged, so the persisted IR can be re-run through
 * the gates to reproduce the exact failure. A defensive whole-IR cap backs
 * the write so it can never exceed the evidence free-text budget.
 */
export function boundIrForDiagnostics(ir, limits = DECOMP_HOLD_DIAGNOSTICS_LIMITS) {
  const truncatedFields = [];
  const originalBytes = ir === null || ir === undefined ? 0 : Buffer.byteLength(JSON.stringify(ir), "utf8");
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    if (node !== null && typeof node === "object") {
      const out = {};
      for (const k of Object.keys(node)) out[k] = walk(node[k], path ? `${path}.${k}` : k);
      return out;
    }
    if (typeof node === "string" && node.length > limits.max_field_chars) {
      truncatedFields.push(path || "<root>");
      return node.slice(0, limits.max_field_chars);
    }
    return node;
  };
  const value = walk(ir, "");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > limits.max_ir_bytes) {
    // Defensive whole-IR cap: never write unbounded.
    return {
      value: {
        __bounded: true,
        reason: "ir_exceeds_diag_cap",
        max_bytes: limits.max_ir_bytes,
        original_bytes: originalBytes,
        truncated_fields: truncatedFields.slice(0, limits.max_hard_failures),
        head: JSON.stringify(value).slice(0, limits.max_field_chars),
      },
      originalBytes,
      truncatedFields: truncatedFields.slice(0, limits.max_hard_failures),
    };
  }
  return { value, originalBytes, truncatedFields: truncatedFields.slice(0, limits.max_hard_failures) };
}

/** Bounded validation + gate snapshot for the hold path. */
export function buildHoldValidationSnapshot(pipeline, bounded, limits = DECOMP_HOLD_DIAGNOSTICS_LIMITS) {
  const gateSnap = (g) => ({
    gate_id: g?.gate_id ?? null,
    name: g?.name ?? null,
    pass: g?.pass === true,
    failure_code: g?.failure_code ?? null,
    evidence: boundText(g?.evidence ?? null, limits.max_failure_chars),
  });
  return {
    schema_valid: pipeline.shape?.valid ?? false,
    structural: (pipeline.structural || []).map(gateSnap),
    semantic: (pipeline.semantic?.gates || []).map(gateSnap),
    frontier_failures: boundFailureList(pipeline.semantic?.frontierFailures, limits),
    extra_edges: pipeline.semantic?.extraEdges ?? null,
    hard_failures: boundFailureList(pipeline.hardFailures, limits),
    scorecard_verdict: pipeline.scorecard?.verdict ?? null,
    prompt_builder_version: pipeline.prompts?.version ?? null,
    diagnostic_meta: {
      format_version: limits.format_version,
      original_ir_bytes: bounded.originalBytes,
      truncated_fields: bounded.truncatedFields,
      limits: { ...limits },
    },
  };
}

/**
 * Persist bounded hold diagnostics（best-effort; a secret/evidence write
 * failure marks diagnostics_persisted=false in the journal and never blocks
 * the underlying pipeline verdict）. Returns { persisted, error }.
 */
function persistDecompositionHoldDiagnostics(run, pipeline, limits = DECOMP_HOLD_DIAGNOSTICS_LIMITS) {
  try {
    const bounded = boundIrForDiagnostics(pipeline.ir ?? null, limits);
    run.store.writeArtifact("decomposition-response.json", {
      status: pipeline.transport?.status ?? null,
      request_count: pipeline.transport?.requestCount ?? null,
      elapsed_ms: pipeline.transport?.elapsedMs ?? null,
      stop_reason: pipeline.transport?.reason ?? null,
    });
    run.store.writeArtifact("decomposition-ir.json", bounded.value);
    run.store.writeArtifact("decomposition-validation.json", buildHoldValidationSnapshot(pipeline, bounded, limits));
    return { persisted: true, error: null };
  } catch (e) {
    // EvidenceHoldError（secret / budget / control chars）or any write failure:
    // fail-closed on persistence, but keep the underlying HOLD verdict intact.
    return { persisted: false, error: e?.code || e?.name || "unknown" };
  }
}

export class DurableHoldError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.name = "DurableHoldError";
  }
}

// ── AutoLoop source component hashes（runtime compatibility fingerprint）──

const SOURCE_COMPONENTS = [
  "src/autoloop.mjs",
  "src/lifecycle-runner.mjs",
  "src/v2/runner.mjs",
  "src/v2/pipeline.mjs",
  "src/v2/production-pipeline.mjs",
  "src/v2/execution-orchestrator.mjs",
  "src/v2/phase-task-card.mjs",
  "src/v2/system-delta.mjs",
  "src/v2/checkpoint-bridge.mjs",
  "src/v2/durable-execution.mjs",
  "src/v2/ir-schema.mjs",
  "src/v2/structural-validator.mjs",
  "src/v2/semantic-consistency.mjs",
  "src/v2/scorecard-v2.mjs",
  "src/v2/prompt-builder.mjs",
  "src/v2/schema-projection.mjs",
  "src/v2/pi-transport-adapter.mjs",
  "src/evidence/run-evidence-store.mjs",
  "src/evidence/run-manifest.mjs",
  "src/c2d/checkpoint-store.mjs",
  "src/c2d/fs-atomic.mjs",
  "src/c2d/execution-id.mjs",
  "src/c2d/permit.mjs",
  "src/c2d/lock.mjs",
  "src/c2d/lease.mjs",
  "src/c2d/fingerprint.mjs",
  "src/c2d/mutation-scope.mjs",
];

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

export function computeSourceHashes() {
  const out = {};
  for (const rel of SOURCE_COMPONENTS) {
    try {
      out[rel] = sha256Text(readFileSync(join(REPO_ROOT, rel), "utf8"));
    } catch {
      out[rel] = "missing";
    }
  }
  return out;
}

export function runtimeIdentity() {
  return { node: process.version, autoloop_package_version: "0.0.0" };
}

function adapterConfigHash(adapter) {
  if (!adapter || typeof adapter !== "object") return null;
  if (adapter.freeze && typeof adapter.freeze === "object") return sha256Text(canonicalJson(adapter.freeze));
  return null;
}

function policyHash(value) {
  return value === undefined || value === null ? null : sha256Text(canonicalJson(value));
}

const PHASE_TERMINAL_EVENT = {
  passed: "PHASE_PASSED",
  held: "PHASE_HELD",
  failed: "PHASE_FAILED",
};

const TERMINAL_EVENT_FOR = {
  PASS: "RUN_PASSED",
  HOLD: "RUN_HELD",
  NOT_BENEFICIAL: "RUN_NOT_BENEFICIAL",
};

const POST_HEAD_ALLOWED_EVENTS = new Set([
  "CHECKPOINT_PUBLISHED", "PHASE_READY", "PHASE_REPAIR_REQUESTED",
  "RUN_PASSED", "RUN_HELD", "RUN_NOT_BENEFICIAL", "MANIFEST_FINALIZED",
  "RESUME_REQUESTED", "RESUME_VALIDATED", "RESUME_REJECTED",
  "READ_ONLY_PHASE_REQUEUED_AFTER_INTERRUPTION",
  // C4S: SYSTEM_DELTA_READY is journaled before its checkpoint, so an
  // interruption between the two must be resume-safe.
  "SYSTEM_DELTA_READY",
]);

// ── Durable run context ─────────────────────────────────────────────────

class DurableRun {
  constructor({ source, parent, manifest, cwd, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory, maxRepairAttempts, timeoutMs, signal, hooks, persistence }) {
    const identity = validateRunIdentity(persistence.executionId);
    this.source = source;
    this.parent = parent;
    this.manifest = manifest;
    this.cwd = cwd;
    this.decompositionAdapter = decompositionAdapter;
    this.executorAdapterFactory = executorAdapterFactory;
    this.reviewerAdapterFactory = reviewerAdapterFactory;
    this.maxRepairAttempts = maxRepairAttempts;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.hooks = hooks || {};
    this.executionId = identity.executionId;
    this.chainId = identity.chainId;
    this.checkpointId = identity.checkpointId;
    this.root = persistence.root;

    this.store = null;
    this.execDir = null;
    this.createdAt = new Date().toISOString();
    this.repoFingerprint = null;
    this.inputFingerprint = null;
    this.configurationFingerprint = null;
    this.irSha = null;
    this.dagSha = null;
    this.finalVerdict = null;
    this.finalReason = null;
    this.manifestSha = null;
    this.orchestration = null;

    this.state = {
      phaseStates: {},
      phaseAttempts: {},
      phaseResultHashes: {},
      completedPhaseIds: [],
      activePhase: null,
      activeLifecycleStage: null,
      writerPhaseActive: false,
      writerLeaseHolder: null,
      expectedRevision: 0,
      pendingResults: {},
      _lastRunnerStatuses: null,
    };
  }

  _resumePolicy() {
    const safeBoundary = this.state.activePhase === null && this.finalVerdict === null;
    return {
      safe_boundary: safeBoundary,
      interrupted_writer: false,
      max_repair_attempts: this.maxRepairAttempts,
      timeout_ms: this.timeoutMs,
    };
  }

  /** Publish a checkpoint（journal head frozen BEFORE the CHECKPOINT_PUBLISHED record）. */
  async checkpoint({ activePhase, activeLifecycleStage, finalVerdict }) {
    const head = this.store.journalHead;
    const pub = await publishCheckpoint({
      root: this.root,
      executionId: this.executionId,
      chainId: this.chainId,
      checkpointId: this.checkpointId,
      repositoryFingerprint: this.repoFingerprint,
      inputFingerprint: this.inputFingerprint,
      configurationFingerprint: this.configurationFingerprint,
      irSha: this.irSha,
      dagSha: this.dagSha,
      journalHead: head,
      phaseStates: this.state.phaseStates,
      phaseAttempts: this.state.phaseAttempts,
      phaseResultHashes: this.state.phaseResultHashes,
      completedPhaseIds: this.state.completedPhaseIds,
      activePhase: activePhase ?? this.state.activePhase,
      activeLifecycleStage: activeLifecycleStage ?? this.state.activeLifecycleStage,
      writerPhaseActive: this.state.writerPhaseActive,
      writerLeaseHolder: this.state.writerLeaseHolder,
      finalVerdict: finalVerdict ?? this.finalVerdict,
      resumePolicy: this._resumePolicy(),
      expectedRevision: this.state.expectedRevision,
      created_at: this.createdAt,
    });
    this.state.expectedRevision = pub.revision;
    this.store.appendEvent({
      event_type: "CHECKPOINT_PUBLISHED",
      stage: "checkpoint",
      payload: { revision: pub.revision, digest: pub.digest, journal_head_sequence: head.seq },
    });
    return pub;
  }

  /** Terminal transition handler（runner onCheckpoint diff）→ journal + artifacts + checkpoint(8). */
  async _onRunnerView(view) {
    this.state.phaseStates = view.statuses;
    this.state.writerLeaseHolder = view.leaseHolder;
    const prev = this.state._lastRunnerStatuses || {};
    const newlyTerminal = [];
    for (const [id, s] of Object.entries(view.statuses)) {
      if (s === "skipped_due_to_dependency") continue;
      if ((s === "passed" || s === "held" || s === "failed") && prev[id] !== s) newlyTerminal.push(id);
    }
    for (const id of newlyTerminal) {
      const s = view.statuses[id];
      const result = this.state.pendingResults[id] || { final: s === "passed" ? "PASS" : "HOLD", reason: null };
      // C4J: persist bounded executor diagnostics BEFORE the journal event
      //（artifact first, journal event = commit point）; a secret/evidence
      // write failure marks diagnostics_persisted=false and never changes the
      // underlying EXECUTOR_EVIDENCE_INVALID verdict.
      const diagAttempted = s === "held" && !!result.diagnostics && typeof result.diagnostics === "object";
      const diagInfo = diagAttempted ? this._persistExecutorDiagnostics(id, result.diagnostics) : null;
      const payload = { final: result.final, reason: result.reason ?? null };
      if (diagInfo) {
        payload.diagnostics_persisted = diagInfo.persisted;
        payload.diagnostic_error = diagInfo.error;
        payload.failure_code = result.reason ?? null;
        payload.artifact_reference = diagInfo.artifact_reference;
        payload.artifact_sha256 = diagInfo.artifact_sha256;
      }
      this.store.appendEvent({
        event_type: PHASE_TERMINAL_EVENT[s],
        stage: "phase",
        phase_id: id,
        attempt: result.attempt ?? null,
        status: s,
        payload,
      });
      const resultRecord = {
        phase_id: id,
        final: result.final,
        status: s,
        attempt: result.attempt ?? null,
        reason: result.reason ?? null,
        recorded_at: new Date().toISOString(),
      };
      const written = this.store.writePhaseArtifact(id, "result.json", resultRecord);
      this.state.phaseResultHashes[id] = written.sha256;
      if (s === "passed") {
        if (!this.state.completedPhaseIds.includes(id)) this.state.completedPhaseIds.push(id);
      }
      await this.checkpoint({});
    }
    for (const id of view.newlySkipped || []) {
      this.store.appendEvent({ event_type: "PHASE_SKIPPED", stage: "phase", phase_id: id, status: "skipped_due_to_dependency", payload: {} });
    }
    if ((view.newlySkipped || []).length > 0) {
      await this.checkpoint({});
    }
    this.state._lastRunnerStatuses = view.statuses;
  }

  /**
   * C4J — persist bounded executor diagnostics for a held phase
   *（best-effort; a secret/evidence write failure marks
   * diagnostics_persisted=false and never changes the underlying
   * EXECUTOR_EVIDENCE_INVALID verdict）. Uses the existing secret-scanned
   * writePhaseArtifact path（DURABLE_EVIDENCE_SECRET_RISK fail-closed）.
   */
  _persistExecutorDiagnostics(phaseId, diagnostics) {
    try {
      const written = this.store.writePhaseArtifact(phaseId, "executor-diagnostics.json", diagnostics);
      return {
        attempted: true,
        persisted: true,
        error: null,
        artifact_reference: `phases/${phaseId}/executor-diagnostics.json`,
        artifact_sha256: written.sha256,
      };
    } catch (e) {
      return {
        attempted: true,
        persisted: false,
        error: e?.code || e?.name || "unknown",
        artifact_reference: null,
        artifact_sha256: null,
      };
    }
  }

  buildOrchestratorHooks(ir) {
    const self = this;
    return {
      ...self.hooks,
      onPhaseStart: async ({ phaseId }) => {
        const phase = (ir.phases || []).find((p) => p.phase_id === phaseId);
        const writer = phase ? requiresWriterLease(phase) : false;
        self.state.activePhase = phaseId;
        self.state.activeLifecycleStage = null;
        self.state.writerPhaseActive = writer;
        self.state.writerLeaseHolder = writer ? phaseId : null;
        self.store.appendEvent({ event_type: "PHASE_READY", stage: "phase", phase_id: phaseId, payload: {} });
        self.store.appendEvent({ event_type: "PHASE_STARTED", stage: "phase", phase_id: phaseId, payload: { writer } });
        await self.checkpoint({});
      },
      onPhaseTerminal: async ({ phaseId, final, attempt, reason, detail }) => {
        self.state.pendingResults[phaseId] = {
          final,
          attempt: attempt ?? null,
          reason: reason ?? null,
          // C4J: bounded executor diagnostics（only EXECUTOR_EVIDENCE_INVALID
          // produces these）— persisted via the secret-scanned write path.
          diagnostics: detail?.diagnostics ?? null,
        };
        self.state.phaseAttempts[phaseId] = attempt ?? null;
        self.state.activePhase = null;
        self.state.activeLifecycleStage = null;
        self.state.writerPhaseActive = false;
        self.state.writerLeaseHolder = null;
      },
      lifecycle: {
        onExecutorOutput: async ({ phaseId, attempt, diagnostic }) => {
          // C4Q: bounded non-authoritative executor output diagnostic.
          try {
            self.store.writePhaseArtifact(phaseId, `executor-output-${attempt ?? 0}.json`, diagnostic ?? {});
          } catch (e) {
            if (e instanceof EvidenceHoldError) throw new DurableHoldError("DURABLE_EVIDENCE_SECRET_RISK", e.message);
            throw e;
          }
        },
        onExecutorCompleted: async ({ phaseId, attempt, evidence }) => {
          self.state.activeLifecycleStage = "executor_completed";
          try {
            // C4Q: the persisted artifact is the harness-owned implementation
            // evidence（AutoLoop-assembled; executor text is non-authoritative）.
            self.store.writePhaseArtifact(phaseId, `implementation-evidence-${attempt ?? 0}.json`, evidence ?? {});
          } catch (e) {
            if (e instanceof EvidenceHoldError) throw new DurableHoldError("DURABLE_EVIDENCE_SECRET_RISK", e.message);
            throw e;
          }
          self.store.appendEvent({
            event_type: "EXECUTOR_COMPLETED",
            stage: "phase",
            phase_id: phaseId,
            attempt,
            payload: { evidence_hash: evidence ? sha256Text(canonicalJson(evidence)) : null },
          });
          await self.checkpoint({});
        },
        onReviewerCompleted: async ({ phaseId, attempt, verdict, verdictObject }) => {
          self.state.activeLifecycleStage = "reviewer_completed";
          try {
            self.store.writePhaseArtifact(phaseId, `reviewer-verdict-${attempt ?? 0}.json`, verdictObject ?? { verdict });
          } catch (e) {
            if (e instanceof EvidenceHoldError) throw new DurableHoldError("DURABLE_EVIDENCE_SECRET_RISK", e.message);
            throw e;
          }
          self.store.appendEvent({
            event_type: "REVIEWER_COMPLETED",
            stage: "phase",
            phase_id: phaseId,
            attempt,
            payload: { verdict: verdict ?? null },
          });
          await self.checkpoint({});
        },
        // C4S — persist the system-observed delta（json metadata + raw patch）
        // before the reviewer is invoked. Both artifacts carry the SAME
        // sha256 the C4N bundle references（artifact = bundle = evidence =
        // journal = manifest consistency）. A persistence failure is a
        // journaled HOLD（the run never silently continues）.
        onSystemDeltaReady: async ({ phaseId, attempt, delta }) => {
          self.state.activeLifecycleStage = "system_delta_ready";
          try {
            self.store.writePhaseArtifact(phaseId, `reviewer-system-delta-${attempt ?? 0}.json`, delta.persistable_json);
            self.store.writePhaseRawArtifact(phaseId, `reviewer-system-delta-${attempt ?? 0}.patch`, delta.patch.text);
          } catch (e) {
            try {
              self.store.appendEvent({
                event_type: "SYSTEM_DELTA_PERSISTENCE_FAILED",
                stage: "phase",
                phase_id: phaseId,
                attempt,
                payload: { error: e?.code || e?.name || "unknown" },
              });
            } catch { /* best-effort; the hold below is the authority */ }
            if (e instanceof EvidenceHoldError) throw new DurableHoldError("DURABLE_EVIDENCE_SECRET_RISK", e.message);
            throw e;
          }
          self.store.appendEvent({
            event_type: "SYSTEM_DELTA_READY",
            stage: "phase",
            phase_id: phaseId,
            attempt,
            payload: {
              patch_sha256: delta.patch.sha256,
              json_artifact_sha256: delta.artifacts.json.sha256,
              patch_artifact_sha256: delta.artifacts.patch.sha256,
              changed_path_count: Array.isArray(delta.changed_paths) ? delta.changed_paths.length : 0,
            },
          });
          await self.checkpoint({});
        },
        onRepairRequested: async ({ phaseId, attempt }) => {
          self.store.appendEvent({ event_type: "PHASE_REPAIR_REQUESTED", stage: "phase", phase_id: phaseId, attempt, payload: {} });
        },
      },
      runner: {
        ...(self.hooks.runner || {}),
        onCheckpoint: (view) => self._onRunnerView(view),
      },
    };
  }
}

function artifactInventory(execDir) {
  const out = [];
  const walk = (rel) => {
    const dir = join(execDir, rel);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      const full = join(dir, e);
      try {
        const st = readFileSync(full);
        out.push({ path: `${rel}/${e}`.replace(/^\/+/, ""), sha256: sha256Text(st) });
      } catch {
        // directories（e.g. phases/<id>/）are walked recursively
        walk(`${rel}/${e}`);
      }
    }
  };
  for (const sub of ["journal", "artifacts", "phases"]) {
    if (listDirSafe(join(execDir, sub)).length > 0) walk(sub);
  }
  return out;
}

// ── Durable run ─────────────────────────────────────────────────────────

export async function runDurableAutoLoop({
  source, parent, manifest, cwd,
  decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory,
  maxRepairAttempts, timeoutMs, signal, hooks = {}, persistence,
}) {
  const run = new DurableRun({
    source, parent, manifest, cwd, decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory,
    maxRepairAttempts, timeoutMs, signal, hooks, persistence,
  });

  try {
    return await runDurableInner({
      run, source, parent, manifest, cwd,
      decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory,
      maxRepairAttempts, timeoutMs, signal, hooks, persistence,
    });
  } catch (e) {
    // Any durable write / checkpoint failure fails the run closed（never
    // silently ignored）; evidence already written is retained.
    try {
      return await terminateDurableRun(run, {
        final: "HOLD",
        reason: `CHECKPOINT_OR_EVIDENCE_FAILURE:${e?.code || e?.name || "unknown"}`,
        ir: run.ir,
      });
    } catch {
      return minimalHoldResult(run, e);
    }
  }
}

async function runDurableInner({
  run, source, parent, manifest, cwd,
  decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory,
  maxRepairAttempts, timeoutMs, signal, hooks = {}, persistence,
}) {

  // Root validation（absolute, outside repo, no symlink — sealed checks）.
  const resolvedRoot = assertValidEvidenceRoot(persistence.root, cwd);
  const store = new RunEvidenceStore({
    root: resolvedRoot,
    executionId: run.executionId,
    chainId: run.chainId,
    checkpointId: run.checkpointId,
    repoRoot: cwd,
  });
  run.execDir = store.init();
  run.store = store;
  run.root = resolvedRoot;

  // Repository + input + configuration fingerprints（before any provider call）.
  run.repoFingerprint = collectRepositoryFingerprint(cwd);
  const frozenInput = { source, parent, manifest };
  store.writeArtifact("input.json", frozenInput);
  run.inputFingerprint = buildInputFingerprint(frozenInput);
  run.configurationFingerprint = buildConfigurationFingerprint({
    maxRepairAttempts,
    timeoutMs,
    toolPolicy: hooks.toolPolicy,
    environmentAllowlist: hooks.environmentAllowlist,
    expectedReviewerModel: hooks.expectedReviewerModel,
    runtime: runtimeIdentity(),
    sourceHashes: computeSourceHashes(),
    decompositionAdapterConfigHash: adapterConfigHash(decompositionAdapter),
    executorAdapterPolicyHash: policyHash(hooks.executorAdapterPolicy),
    reviewerAdapterPolicyHash: policyHash(hooks.reviewerAdapterPolicy),
    persistenceFormatVersion: AUTOLOOP_CHECKPOINT_FORMAT_VERSION,
  });

  store.appendEvent({ event_type: "RUN_CREATED", stage: "run", payload: {} });
  await run.checkpoint({});
  store.appendEvent({ event_type: "INPUT_FROZEN", stage: "input", payload: { input_fingerprint: run.inputFingerprint } });
  await run.checkpoint({});

  // ── Decomposition（one request）──
  let pipeline;
  try {
    store.appendEvent({ event_type: "DECOMPOSITION_STARTED", stage: "decomposition", payload: {} });
    pipeline = await runProductionPipeline({
      source, parent, manifest, decompositionAdapter,
      hooks: { onStage: hooks.onStage },
    });
  } catch (e) {
    return terminateDurableRun(run, { final: "HOLD", reason: `DECOMPOSITION_EXCEPTION:${e?.code || e?.name || "unknown"}`, ir: null });
  }

  if (pipeline.final !== "PASS") {
    const eventType = pipeline.final === "NOT_BENEFICIAL" ? "DECOMPOSITION_COMPLETED" : "DECOMPOSITION_HELD";
    // C4F: persist bounded hold diagnostics BEFORE the journal event so a
    // readback that observes DECOMPOSITION_HELD always finds the artifacts
    //（or an explicit diagnostics_persisted=false marker with the error
    // classification — never the secret content）.
    const diag = pipeline.final === "NOT_BENEFICIAL"
      ? { persisted: null, error: null }
      : persistDecompositionHoldDiagnostics(run, pipeline);
    store.appendEvent({
      event_type: eventType,
      stage: "decomposition",
      payload: {
        final: pipeline.final,
        stage: pipeline.stage,
        reason: boundText(pipeline.reason ?? null, DECOMP_HOLD_DIAGNOSTICS_LIMITS.max_reason_chars),
        hard_failures: boundFailureList(pipeline.hardFailures),
        diagnostics_persisted: diag.persisted,
        diagnostic_error: diag.error ?? null,
      },
    });
    return terminateDurableRun(run, {
      final: pipeline.final,
      reason: boundText(pipeline.reason ?? pipeline.hardFailures?.join("; ") ?? null, DECOMP_HOLD_DIAGNOSTICS_LIMITS.max_reason_chars),
      ir: pipeline.ir ?? null,
    });
  }

  run.ir = pipeline.ir;

  // C4I: freeze the phase state set as soon as the DAG is validated so a
  // post-decomposition safe-boundary checkpoint carries the full resume
  // material (phase set frozen) and is genuinely AUTOLOOP_RESUMABLE.
  run.state.phaseStates = {};
  for (const p of (pipeline.ir.phases || [])) run.state.phaseStates[p.phase_id] = "pending";

  store.writeArtifact("decomposition-response.json", {
    status: pipeline.transport?.status ?? null,
    request_count: pipeline.transport?.requestCount ?? null,
    elapsed_ms: pipeline.transport?.elapsedMs ?? null,
    stop_reason: pipeline.transport?.reason ?? null,
  });
  store.writeArtifact("decomposition-ir.json", pipeline.ir);
  store.writeArtifact("decomposition-validation.json", {
    schema_valid: pipeline.shape?.valid ?? false,
    structural: (pipeline.structural || []).map((g) => ({ gate_id: g.gate_id, pass: g.pass })),
    semantic: (pipeline.semantic?.gates || []).map((g) => ({ gate_id: g.gate_id, pass: g.pass })),
    scorecard_verdict: pipeline.scorecard?.verdict ?? null,
    prompt_builder_version: pipeline.prompts?.version ?? null,
  });
  run.irSha = buildIrSha256(pipeline.ir);
  run.dagSha = buildDagFingerprint(pipeline.ir);
  store.appendEvent({ event_type: "DECOMPOSITION_COMPLETED", stage: "decomposition", payload: { final: "PASS", ir_sha256: run.irSha, dag_sha256: run.dagSha } });
  await run.checkpoint({});
  store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: { phase_count: (pipeline.ir.phases || []).length } });
  await run.checkpoint({});

  // ── DAG execution（checkpoints at phase/lifecycle/terminal boundaries）──
  const orchestratorHooks = run.buildOrchestratorHooks(pipeline.ir);
  try {
    run.orchestration = await runExecutionOrchestrator({
      ir: pipeline.ir,
      parent,
      manifest,
      cwd,
      executionId: run.executionId,
      executorAdapterFactory,
      reviewerAdapterFactory,
      maxRepairAttempts,
      timeoutMs,
      signal,
      initialState: run.resumeInitialState,
      hooks: orchestratorHooks,
    });
  } catch (e) {
    return terminateDurableRun(run, { final: "HOLD", reason: `ORCHESTRATION_EXCEPTION:${e?.code || e?.name || "unknown"}`, ir: pipeline.ir });
  }

  if (run.orchestration.final === "PASS") {
    return terminateDurableRun(run, { final: "PASS", reason: null, ir: pipeline.ir });
  }
  return terminateDurableRun(run, { final: "HOLD", reason: run.orchestration.reason ?? "ORCHESTRATION_HOLD", ir: pipeline.ir });
}

// ── Termination（journal RUN_* → checkpoint → manifest → report）─────────

export async function terminateDurableRun(run, { final, reason, ir }) {
  run.finalVerdict = final;
  run.finalReason = reason;
  let checkpoint = null;
  try {
    run.store.appendEvent({ event_type: TERMINAL_EVENT_FOR[final] || "RUN_HELD", stage: "terminal", payload: { reason: reason ?? null } });
    await run.checkpoint({ finalVerdict: final, activePhase: null, activeLifecycleStage: null, writerPhaseActive: false, writerLeaseHolder: null });

    checkpoint = readCheckpoint(run.root, run.executionId);
    const journal = run.store.verifyJournal();
    const manifest = buildRunManifest({
      executionId: run.executionId,
      chainId: run.chainId,
      created_at: run.createdAt,
      completed_at: new Date().toISOString(),
      final_verdict: final,
      final_reason: reason,
      input_fingerprint: run.inputFingerprint,
      configuration_fingerprint: run.configurationFingerprint,
      repository_fingerprint: run.repoFingerprint,
      decomposition_ir_sha256: run.irSha,
      dag_sha256: run.dagSha,
      journal_event_count: journal.count,
      journal_head_sha256: journal.head,
      checkpoint_revision: checkpoint.snapshot.revision,
      checkpoint_sha256: checkpoint.digest,
      phase_results: run.state.completedPhaseIds.map((id) => ({ phase_id: id, result_hash: run.state.phaseResultHashes[id] ?? null })),
      artifact_inventory: artifactInventory(run.execDir),
      secret_scan_result: { scanned: true, matches: [] },
      format_versions: {
        evidence: "1.0.0",
        journal: "1.0.0",
        manifest: MANIFEST_FORMAT_VERSION,
        checkpoint: AUTOLOOP_CHECKPOINT_FORMAT_VERSION,
      },
    });
    const finalized = finalizeRunManifest(run.execDir, manifest);
    run.manifestSha = finalized.sha256;
    run.store.appendEvent({ event_type: "MANIFEST_FINALIZED", stage: "terminal", payload: { manifest_sha256: finalized.sha256 } });
    await run.checkpoint({ finalVerdict: final, activePhase: null, activeLifecycleStage: null, writerPhaseActive: false, writerLeaseHolder: null });
    writeFinalReport(run.execDir, {
      execution_id: run.executionId,
      final_verdict: final,
      final_reason: reason,
      manifest_sha256: finalized.sha256,
      checkpoint_revision: checkpoint.snapshot.revision,
      evidence_format_version: "1.0.0",
    });
  } catch (e) {
    run.finalVerdict = "HOLD";
    run.finalReason = `TERMINAL_EVIDENCE_FAILURE:${e?.code || e?.name || "unknown"}`;
  }

  const result = {
    final: run.finalVerdict,
    stage: run.finalVerdict === "PASS" ? "execution" : "execution_hold",
    reason: run.finalReason,
    executionId: run.executionId,
    phaseResults: run.orchestration?.phaseResults ?? [],
    scheduler: run.orchestration?.scheduler ?? null,
    transitions: run.orchestration?.transitions ?? [],
    diagnostics: {},
    decomposition: ir
      ? {
          verdict: ir.verdict,
          phase_count: (ir.phases || []).length,
          phase_ids: (ir.phases || []).map((p) => p.phase_id),
          disposition_count: (ir.dispositions || []).length,
        }
      : null,
  };
  result.evidence = {
    root: run.root,
    exec_dir: run.execDir,
    execution_id: run.executionId,
    chain_id: run.chainId,
    checkpoint_revision: run.state.expectedRevision,
    manifest_sha256: run.manifestSha,
    journal_head_sha256: run.store.journalHead.sha256,
    final_verdict: run.finalVerdict,
    state: run.finalVerdict === "PASS" ? "TERMINAL_PASS"
      : run.finalVerdict === "NOT_BENEFICIAL" ? "TERMINAL_NOT_BENEFICIAL"
        : "TERMINAL_HOLD",
  };
  return result;
}

// ── Resume ──────────────────────────────────────────────────────────────

function readJsonSafe(execDir, rel) {
  const p = join(execDir, rel);
  return JSON.parse(readFileSync(p, "utf8"));
}

function findJournalEventByHead(store, headSequence, headSha256) {
  const { event } = store.readEvent(headSequence);
  if (event.sequence !== headSequence || event.event_sha256 !== headSha256) {
    throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", `journal head mismatch at seq ${headSequence}`);
  }
  return event;
}

/**
 * Resume an AutoLoop run from its durable checkpoint.
 * The caller provides ONLY runtime capability（adapter factories）; the
 * original source / parent / manifest / IR are read from the frozen durable
 * artifacts. Every fingerprint mismatch fails closed.
 */
export async function resumeAutoLoop({
  persistenceRoot,
  executionId,
  decompositionAdapter,
  executorAdapterFactory,
  reviewerAdapterFactory,
  signal,
  hooks = {},
}) {
  const identity = validateRunIdentity(executionId);
  if (!checkpointExists(persistenceRoot, executionId)) {
    throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", "no checkpoint exists for this execution");
  }

  const { execDir, snapshot, digest: checkpointDigest } = readCheckpoint(persistenceRoot, executionId);

  const store = new RunEvidenceStore({
    root: persistenceRoot,
    executionId: identity.executionId,
    chainId: identity.chainId,
    checkpointId: identity.checkpointId,
  });
  store.init();

  // ── C4I read-only pre-gate（BEFORE any journal write / provider call）──
  // Format-major and journal chain/head alignment are validated first so a
  // restart-required run is classified without mutating its journal, and so
  // the precise PRE_DECOMPOSITION_RESTART_REQUIRED result is returned before
  // any adapter/provider call. The post-head event whitelist is checked only
  // AFTER classification（a mid-decomposition interruption legitimately has
  // post-head events such as DECOMPOSITION_STARTED）.
  let journal;
  try {
    const major = parseInt(String(snapshot.autoloop_format_version ?? "0").split(".")[0], 10);
    if (major !== 1) {
      throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", `unsupported checkpoint format major ${major}`);
    }
    journal = store.verifyJournal();
    findJournalEventByHead(store, snapshot.journal_head_sequence, snapshot.journal_head_sha256);
  } catch (e) {
    throw e;
  }

  // ── C4I single resume-capability classification（precise restart gate）──
  const classification = classifyResumeCapability({
    checkpoint: snapshot,
    artifacts: { decompositionIrExists: existsSync(join(execDir, "artifacts", "decomposition-ir.json")) },
    journal: { valid: true, headMatches: true },
  });
  if (classification.capability === "RESTART_REQUIRED") {
    // Pre-decomposition / incomplete-decomposition interruption: the run
    // cannot be resumed and must be restarted under a NEW execution id.
    // No journal event is appended（the interrupted run stays immutable）and
    // no adapter/provider call is made.
    return {
      final: "HOLD",
      stage: "restart_required",
      reason: "PRE_DECOMPOSITION_RESTART_REQUIRED",
      executionId,
      resumed: false,
      complete: false,
      provider_calls: 0,
      phase_calls: 0,
      phaseResults: [],
      scheduler: null,
      transitions: [],
      diagnostics: {},
      decomposition: null,
      evidence: {
        root: persistenceRoot,
        exec_dir: execDir,
        execution_id: executionId,
        chain_id: identity.chainId,
        checkpoint_revision: snapshot.revision,
        checkpoint_sha256: checkpointDigest,
        manifest_sha256: null,
        final_verdict: null,
        state: "RESTART_REQUIRED",
      },
    };
  }

  // Post-head event semantics（DE-2 F1）: each event beyond the checkpoint
  // head is CLASSIFIED, never blindly allowed. replay-safe / resume-safe
  // proceed（the checkpoint is the durable truth; intermediate markers fold
  // into resumed state）; invalid / unknown events still fail closed.
  try {
    for (let s = snapshot.journal_head_sequence + 1; s <= journal.count; s++) {
      const { event } = store.readEvent(s);
      const cls = classifyPostHeadEvent(event.event_type);
      if (cls === "invalid") {
        throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", `unexpected journal event ${event.event_type} beyond checkpoint head`);
      }
    }
  } catch (e) {
    throw e;
  }

  store.appendEvent({ event_type: "RESUME_REQUESTED", stage: "resume", payload: { execution_id: identity.executionId } });

  // ── Validation（any failure → HOLD / RESUME_FINGERPRINT_MISMATCH）──
  let ir = null;
  let expectedFp = null;
  try {
    // (format major + journal chain/head alignment were validated in the
    // read-only pre-gate above; the remaining fingerprint checks follow.)

    // 3. repository fingerprint（worktree must match the frozen one）
    const repoRoot = snapshot.repository_fingerprint?.repository_root_identity;
    if (typeof repoRoot !== "string" || repoRoot.length === 0) {
      throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", "repository identity missing from checkpoint");
    }
    let currentFp;
    try {
      currentFp = collectRepositoryFingerprint(repoRoot);
    } catch (e) {
      throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", `repository unavailable or changed: ${e?.message || e}`);
    }
    expectedFp = snapshot.repository_fingerprint;
    const fpFields = [
      "expected_head", "repository_root_identity", "worktree_identity", "git_common_dir_identity",
      "expected_ref", "origin_url", "origin_master", "expected_worktree_state",
    ];
    for (const f of fpFields) {
      if (currentFp[f] !== expectedFp[f]) {
        throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", `repository fingerprint mismatch: ${f}`);
      }
    }
    if (currentFp.dirty) {
      throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", "repository worktree is dirty; resume requires the frozen worktree state");
    }

    // 4. input fingerprint（recomputed from the frozen artifact）
    const frozen = readJsonSafe(execDir, "artifacts/input.json");
    const inputFp = buildInputFingerprint(frozen);
    if (inputFp !== snapshot.input_fingerprint) {
      throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", "input fingerprint mismatch");
    }

    // 5. configuration fingerprint（recomputed from the CURRENT caller config）
    const configFp = buildConfigurationFingerprint({
      maxRepairAttempts: snapshot.resume_policy?.max_repair_attempts ?? 0,
      timeoutMs: snapshot.resume_policy?.timeout_ms ?? 0,
      toolPolicy: hooks.toolPolicy,
      environmentAllowlist: hooks.environmentAllowlist,
      expectedReviewerModel: hooks.expectedReviewerModel,
      runtime: runtimeIdentity(),
      sourceHashes: computeSourceHashes(),
      decompositionAdapterConfigHash: adapterConfigHash(decompositionAdapter),
      executorAdapterPolicyHash: policyHash(hooks.executorAdapterPolicy),
      reviewerAdapterPolicyHash: policyHash(hooks.reviewerAdapterPolicy),
      persistenceFormatVersion: AUTOLOOP_CHECKPOINT_FORMAT_VERSION,
    });
    if (configFp !== snapshot.configuration_fingerprint) {
      throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", "configuration fingerprint mismatch");
    }

    // 6. IR + DAG hashes（recomputed from the frozen IR artifact）
    ir = readJsonSafe(execDir, "artifacts/decomposition-ir.json");
    if (buildIrSha256(ir) !== snapshot.decomposition_ir_sha256) {
      throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", "IR hash mismatch");
    }
    if (buildDagFingerprint(ir) !== snapshot.dag_sha256) {
      throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", "DAG fingerprint mismatch");
    }

    // 7. completed phase result hashes（every completed phase must be pinned）
    for (const id of snapshot.completed_phase_ids || []) {
      if (!snapshot.phase_result_hashes || typeof snapshot.phase_result_hashes[id] !== "string") {
        throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", `completed phase ${id} missing result hash`);
      }
    }

    // 7b. stale writer lease with no active phase is an inconsistent snapshot
    if (!snapshot.active_phase && (snapshot.writer_lease_holder || snapshot.writer_phase_active)) {
      throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", "stale writer lease remnant without an active phase");
    }


    // 8. phase set must exactly match the IR（no unknown / no missing phases）
    const irPhaseIds = new Set((ir.phases || []).map((p) => p.phase_id));
    for (const id of Object.keys(snapshot.phase_states || {})) {
      if (!irPhaseIds.has(id)) {
        throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", `phase_states references unknown phase: ${id}`);
      }
    }
    for (const id of irPhaseIds) {
      if (!snapshot.phase_states || !(id in snapshot.phase_states)) {
        throw new DurableHoldError("RESUME_FINGERPRINT_MISMATCH", `phase_states missing phase: ${id}`);
      }
    }

    store.appendEvent({ event_type: "RESUME_VALIDATED", stage: "resume", payload: { checkpoint_digest: checkpointDigest } });
  } catch (e) {
    try {
      store.appendEvent({ event_type: "RESUME_REJECTED", stage: "resume", payload: { code: e?.code || "RESUME_FINGERPRINT_MISMATCH" } });
    } catch { /* journal append failure on the rejection path is best-effort */ }
    throw e;
  }

  // ── Terminal run already complete ──
  if (snapshot.final_verdict) {
    return {
      final: snapshot.final_verdict,
      stage: "complete",
      reason: snapshot.final_verdict === "PASS" ? null : "already_terminal",
      executionId,
      resumed: false,
      complete: true,
      phaseResults: [],
      scheduler: null,
      transitions: [],
      diagnostics: {},
      decomposition: {
        verdict: ir.verdict,
        phase_count: (ir.phases || []).length,
        phase_ids: (ir.phases || []).map((p) => p.phase_id),
        disposition_count: (ir.dispositions || []).length,
      },
      evidence: {
        root: persistenceRoot,
        exec_dir: execDir,
        execution_id: executionId,
        chain_id: identity.chainId,
        checkpoint_revision: snapshot.revision,
        checkpoint_sha256: checkpointDigest,
        manifest_sha256: null,
        final_verdict: snapshot.final_verdict,
        state: "COMPLETE",
      },
    };
  }

  // ── Resume policy（§12）──
  const frozen = readJsonSafe(execDir, "artifacts/input.json");
  const { source, parent, manifest } = frozen;
  const cwd = snapshot.repository_fingerprint?.worktree_identity;

  let initialState = { statuses: { ...snapshot.phase_states } };
  const active = snapshot.active_phase;
  if (active) {
    const phase = (ir.phases || []).find((p) => p.phase_id === active);
    const isWriter = phase ? requiresWriterLease(phase) : true;
    const hasRuntimeOrExternal = phase
      && (phase.effects?.runtime_side_effect !== "forbidden" || phase.effects?.external_system_mutation !== "forbidden");
    const leaseEmpty = !snapshot.writer_phase_active && !snapshot.writer_lease_holder;
    if (!isWriter && !hasRuntimeOrExternal && leaseEmpty) {
      // Interrupted read-only phase → safe requeue（§12）.
      initialState.statuses[active] = "ready";
      store.appendEvent({ event_type: "READ_ONLY_PHASE_REQUEUED_AFTER_INTERRUPTION", stage: "resume", phase_id: active, payload: {} });
    } else {
      try {
        store.appendEvent({ event_type: "RESUME_REJECTED", stage: "resume", payload: { code: "INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED", phase_id: active } });
      } catch { /* best-effort */ }
      throw new DurableHoldError("INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED", `interrupted phase ${active} is not safely resumable`);
    }
  }

  // ── Continue the DAG from the safe boundary ──
  const run = new DurableRun({
    source, parent, manifest, cwd,
    decompositionAdapter, executorAdapterFactory, reviewerAdapterFactory,
    maxRepairAttempts: snapshot.resume_policy?.max_repair_attempts ?? 0,
    timeoutMs: snapshot.resume_policy?.timeout_ms ?? 0,
    signal, hooks,
    persistence: { root: persistenceRoot, executionId },
  });
  run.execDir = execDir;
  run.store = store;
  run.root = persistenceRoot;
  run.repoFingerprint = expectedFp;
  run.inputFingerprint = snapshot.input_fingerprint;
  run.configurationFingerprint = snapshot.configuration_fingerprint;
  run.irSha = snapshot.decomposition_ir_sha256;
  run.dagSha = snapshot.dag_sha256;
  run.createdAt = snapshot.created_at;
  run.state.expectedRevision = snapshot.revision;
  run.state.phaseStates = { ...snapshot.phase_states };
  run.state.phaseAttempts = { ...(snapshot.phase_attempts || {}) };
  run.state.phaseResultHashes = { ...(snapshot.phase_result_hashes || {}) };
  run.state.completedPhaseIds = [...(snapshot.completed_phase_ids || [])];
  // DE-2 F2/F3 fix: seed the runner-status baseline from the persisted
  // checkpoint so the FIRST resumed runner view does not treat every
  // already-passed phase as newly terminal (the DE-1 resumed-orchestrator
  // JOURNAL_OUT_OF_ORDER / false re-terminalization root cause).
  run.state._lastRunnerStatuses = { ...snapshot.phase_states };
  run.resumeInitialState = initialState;

  const orchestratorHooks = run.buildOrchestratorHooks(ir);
  try {
    run.orchestration = await runExecutionOrchestrator({
      ir,
      parent,
      manifest,
      cwd,
      executionId,
      executorAdapterFactory,
      reviewerAdapterFactory,
      maxRepairAttempts: snapshot.resume_policy?.max_repair_attempts ?? 0,
      timeoutMs: snapshot.resume_policy?.timeout_ms ?? 0,
      signal,
      initialState,
      hooks: orchestratorHooks,
    });
  } catch (e) {
    return terminateDurableRun(run, { final: "HOLD", reason: `ORCHESTRATION_EXCEPTION:${e?.code || e?.name || "unknown"}`, ir });
  }

  if (run.orchestration.final === "PASS") {
    return terminateDurableRun(run, { final: "PASS", reason: null, ir });
  }
  return terminateDurableRun(run, { final: "HOLD", reason: run.orchestration.reason ?? "ORCHESTRATION_HOLD", ir });
}

function minimalHoldResult(run, e) {
  return {
    final: "HOLD",
    stage: "execution_hold",
    reason: `CHECKPOINT_OR_EVIDENCE_FAILURE:${e?.code || e?.name || "unknown"}`,
    executionId: run.executionId,
    phaseResults: [],
    scheduler: null,
    transitions: [],
    diagnostics: {},
    decomposition: null,
    evidence: {
      root: run.root,
      exec_dir: run.execDir,
      execution_id: run.executionId,
      chain_id: run.chainId,
      checkpoint_revision: run.state.expectedRevision,
      manifest_sha256: null,
      journal_head_sha256: run.store ? run.store.journalHead.sha256 : null,
      final_verdict: "HOLD",
      state: "RECOVERY_REQUIRED",
    },
  };
}
