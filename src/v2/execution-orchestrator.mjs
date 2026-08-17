// src/v2/execution-orchestrator.mjs
//
// C2 — DAG-to-lifecycle execution orchestrator.
//
// Uses the sealed deterministic scheduler (runner.mjs runDecompositionGraph)
// unchanged. Its injected `execute(phase)`:
//   1. builds the phase task card (phase-task-card.mjs hard gates),
//   2. captures the scope baseline snapshot immediately before the phase runs,
//   3. creates FRESH executor and reviewer adapters (session reuse = 0),
//   4. runs the phase through lifecycle-runner.mjs (never bypassed),
//   5. maps the lifecycle outcome: PASS → passed, HOLD → held, exception → failed.
//
// The orchestrator never repairs in-scheduler, never reorders the DAG to
// avoid writer conflicts, never adds/removes edges, and never starts a new
// phase after HOLD (all enforced by the sealed runner).
//
// DECOMP-OPT1-PC1（optional `inheritance`）: when enabled, the orchestrator
// observes the parent/run facts ONCE（frozen decomposition-inheritance
// manifest）, then every child deterministically inherits:
//   - F3A per-child guard（single `git rev-parse HEAD` == frozen head）;
//   - per-child disposition（REUSE / REVALIDATE / RECOMPUTE）over the
//     manifest facts; ambiguity fails closed（HOLD）;
//   - Child Execution Packet attached to the task card（never widens scope —
//     the phase-task-card containment gates still run per child）;
//   - frozen F3A repository baseline for evidence builders（no 9-command
//     re-collection per child）;
//   - verification layering: the verification command runs for writer /
//     explicitly-flagged verification phases only（read-only phases skip）.
// When disabled, behavior is byte-identical to the pre-inheritance path.

import { readFileSync } from "node:fs";
import { runDecompositionGraph, requiresWriterLease } from "./runner.mjs";
import { buildPhaseTaskCard, deriveScopePatterns, PhaseCardError } from "./phase-task-card.mjs";
import { runLifecycle } from "../lifecycle-runner.mjs";
import { captureScopeSnapshot } from "../c2d/mutation-scope.mjs";
import { validateImplementationEvidence } from "../validate-role-artifacts.mjs";
import { buildInputFingerprint, buildDagFingerprint, buildIrSha256 } from "./checkpoint-bridge.mjs";
import { canonicalJson, sha256Text } from "../evidence/run-evidence-store.mjs";
import {
  buildInheritanceManifest,
  buildChildExecutionPacket,
  deriveF3ABaseline,
  guardRepositoryIdentity,
  probeRepositoryIdentity,
  mergeFingerprintIntoRepositoryIdentity,
  verifyManifestIntegrity,
  evaluateInvalidations,
  emptyInheritanceTelemetry,
  emptyCbmMetrics,
  INHERITANCE_HOLD,
} from "./decomposition-inheritance.mjs";
import {
  queryInheritanceManifest,
  queryChildEvidenceRefs,
  recordInheritanceManifest,
} from "../memory/inheritance-cbm.mjs";

// C4J: the lifecycle hold detail may carry bounded executor diagnostics
//（final assistant text + parse error + protocol counters）. The durable
// persistence path needs them, but unscanned worker audit sinks
//（run-result.json）must never receive them — strip before recording.
function stripDiagnosticsFromDetail(detail) {
  if (!detail || typeof detail !== "object" || !("diagnostics" in detail)) return detail;
  const { diagnostics, ...rest } = detail;
  return rest;
}

export const ORCHESTRATOR_HOLD = Object.freeze({
  MISSING_EXECUTOR_ADAPTER_FACTORY: "MISSING_EXECUTOR_ADAPTER_FACTORY",
  MISSING_REVIEWER_ADAPTER_FACTORY: "MISSING_REVIEWER_ADAPTER_FACTORY",
  INVALID_REPAIR_BUDGET: "INVALID_REPAIR_BUDGET",
  INVALID_TIMEOUT: "INVALID_TIMEOUT",
});

export class InheritanceHoldError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.name = "InheritanceHoldError";
  }
}

/** Deterministic contract refs（repair budget / reviewer model / tool policy）. */
function buildContractRefs(hooks = {}, maxRepairAttempts = 1) {
  return [
    { key: "repair_budget", value: String(maxRepairAttempts) },
    { key: "expected_reviewer_model", value: String(hooks.expectedReviewerModel ?? "") },
    { key: "tool_policy", value: sha256Text(canonicalJson(hooks.toolPolicy ?? null)) },
  ];
}

/** Deterministic authority ref（parent scope digest）. */
function buildAuthorityRefs(parent) {
  return [{ key: "parent_scope", value: sha256Text(canonicalJson(parent?.scope ?? null)) }];
}

/** Deterministic dependency ref（IR depends_on map digest）. */
function buildDependencyRefs(ir) {
  const map = {};
  for (const p of ir?.phases ?? []) map[p.phase_id] = [...(p.depends_on ?? [])];
  return [sha256Text(canonicalJson(map))];
}

/** Resolve the inheritance manifest ONCE per run（CBM-first; §C）. */
async function resolveInheritanceManifest({
  inheritance,
  ir,
  parent,
  manifest,
  cwd,
  executionId,
  hooks,
  maxRepairAttempts,
  telemetry,
}) {
  // Prebuilt manifest（resume path）→ verify integrity, never rebuild.
  if (inheritance.prebuiltManifest) {
    const iv = verifyManifestIntegrity(inheritance.prebuiltManifest);
    if (!iv.ok) {
      return { ok: false, code: iv.code, reason: `prebuilt manifest failed integrity: ${iv.reason}` };
    }
    return { ok: true, manifest: inheritance.prebuiltManifest, rebuilt: false, cbm: emptyCbmMetrics() };
  }

  const cbm = emptyCbmMetrics();
  const cbmStore = inheritance.cbm?.store ?? null;

  // F3A probe（once per run; tree is not in the durable fingerprint）.
  const probe = probeRepositoryIdentity(cwd);
  if (!probe.ok) {
    return { ok: false, code: probe.code, reason: probe.reason };
  }
  const repositoryIdentity = mergeFingerprintIntoRepositoryIdentity(
    inheritance.repositoryIdentity ?? null,
    probe.identity
  );

  const inputFingerprint = inheritance.inputFingerprint ?? buildInputFingerprint({ source: null, parent, manifest });
  const irSha = buildIrSha256(ir);
  const dagSha = buildDagFingerprint(ir);
  const phaseIds = (ir.phases || []).map((p) => p.phase_id);

  // CBM-first: reuse a verified recorded manifest（same parent + tree）.
  let reuseRecorded = null;
  if (cbmStore && inheritance.cbm?.repositoryIdentityHex) {
    cbm.queryCount += 1;
    const q = await queryInheritanceManifest({
      store: cbmStore,
      repositoryIdentity: inheritance.cbm.repositoryIdentityHex,
      parentCardId: inheritance.parentCardId ?? executionId,
      treeSha: repositoryIdentity.expected_tree,
    });
    if (q.status === "HIT" && q.manifest) {
      cbm.hitCount += 1;
      reuseRecorded = q.manifest;
    } else if (q.status === "STALE") {
      cbm.staleCount += 1;
      cbm.boundedFallbackCount += 1;
    } else if (q.status === "CONFLICT") {
      cbm.conflictCount += 1;
      cbm.boundedFallbackCount += 1;
    } else {
      cbm.missCount += 1;
      cbm.boundedFallbackCount += 1;
    }
  }

  let resolvedManifest;
  if (reuseRecorded) {
    resolvedManifest = reuseRecorded;
    cbm.factsReused += Array.isArray(resolvedManifest.facts) ? resolvedManifest.facts.length : 0;
  } else {
    // Bounded source build — parent/run facts observed ONCE here.
    const specFileDigests = [];
    for (const rel of inheritance.specFilePaths ?? []) {
      try {
        const buf = readFileSync(new URL(`file://${cwd}/${rel}`));
        specFileDigests.push({ path: rel, sha256: sha256Text(buf) });
      } catch {
        specFileDigests.push({ path: rel, sha256: null });
      }
    }
    const built = buildInheritanceManifest({
      parentCardId: inheritance.parentCardId ?? executionId,
      parentGeneration: inheritance.parentGeneration ?? 1,
      graphRunId: executionId,
      repositoryIdentity,
      inputFingerprint,
      irSha,
      dagSha,
      phaseIds,
      authorityRefs: inheritance.authorityRefs ?? buildAuthorityRefs(parent),
      contractRefs: inheritance.contractRefs ?? buildContractRefs(hooks, maxRepairAttempts),
      dependencyRefs: inheritance.dependencyRefs ?? buildDependencyRefs(ir),
      evidenceRefs: inheritance.evidenceRefs ?? [],
      specFileDigests,
      createdAt: null,
    });
    resolvedManifest = built.manifest;
    telemetry.parentFactsObservedOnce += Array.isArray(resolvedManifest.facts) ? resolvedManifest.facts.length : 0;
  }

  // Best-effort CBM write-back of the manifest（governed gate; gap recorded,
  // never a failure — §S）.
  if (cbmStore && inheritance.cbm?.repositoryIdentityHex && !reuseRecorded && inheritance.cbm?.writebackAllowed !== false) {
    const rec = await recordInheritanceManifest({
      store: cbmStore,
      manifest: resolvedManifest,
      graphRunId: executionId,
      repositoryIdentity: inheritance.cbm.repositoryIdentityHex,
      expectedRepository: inheritance.cbm.expectedRepository ?? inheritance.cbm.repositoryIdentityHex,
    });
    if (!rec.ok) {
      cbm.writebackGap = true;
      cbm.writebackGapReason = `${rec.status}:${rec.reason ?? ""}`;
    }
  }

  return { ok: true, manifest: resolvedManifest, rebuilt: !reuseRecorded, cbm };
}

/** CBM per-child evidence-location resolution（bounded; §S / §H）: miss → the
 * manifest's own evidenceRefs（bounded fallback）. */
async function resolveChildEvidenceRefs({ cbm, manifest, childCardId, executionId }) {
  const refs = [...(manifest.evidenceRefs ?? [])];
  if (!cbm?.store || !cbm?.repositoryIdentityHex) return { refs, fallback: refs.length > 0 };
  cbm.queryCount += 1;
  const r = await queryChildEvidenceRefs({
    store: cbm.store,
    repositoryIdentity: cbm.repositoryIdentityHex,
    parentCardId: manifest.parentCardId,
    childCardId,
  });
  if (r.status === "HIT" && r.refs && r.refs.length > 0) {
    cbm.hitCount += 1;
    for (const ref of r.refs) if (!refs.includes(ref)) refs.push(ref);
    return { refs, fallback: false };
  }
  cbm.missCount += 1;
  cbm.boundedFallbackCount += 1;
  return { refs, fallback: refs.length > 0 };
}

/**
 * Execute a validated DECOMPOSED IR DAG through the lifecycle runner.
 *
 * @param {object} opts
 * @param {object} opts.ir — validated IR (DECOMPOSED)
 * @param {object} opts.parent — { scope: { allowed_paths, forbidden_paths } }
 * @param {object[]} opts.manifest — [{ requirement_id, text }]
 * @param {string} opts.cwd — repository root
 * @param {string} opts.executionId — parent run execution id
 * @param {Function} opts.executorAdapterFactory — () => adapter（fresh per phase）
 * @param {Function} opts.reviewerAdapterFactory — () => adapter（fresh per phase）
 * @param {number} opts.maxRepairAttempts — 0 or 1
 * @param {number} opts.timeoutMs — positive
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.hooks] — { onLease, onStatus, onPhase }
 * @param {object} [opts.inheritance] — DECOMP-OPT1-PC1（null = disabled）:
 *   { enabled, parentCardId, parentGeneration, inputFingerprint,
 *     repositoryIdentity, authorityRefs, contractRefs, dependencyRefs,
 *     evidenceRefs, specFilePaths, prebuiltManifest,
 *     cbm: { store, repositoryIdentityHex, expectedRepository,
 *            writebackAllowed } }
 * @returns {Promise<object>} { final, holdCode?, reason?, scheduler,
 *   phaseResults, transitions, inheritance? }
 */
export async function runExecutionOrchestrator({
  ir,
  parent,
  manifest,
  cwd,
  executionId,
  executorAdapterFactory,
  reviewerAdapterFactory,
  maxRepairAttempts = 1,
  timeoutMs,
  signal,
  initialState,
  hooks = {},
  inheritance = null,
} = {}) {
  // Fail-closed input gates, before any adapter/lifecycle call.
  if (typeof executorAdapterFactory !== "function") {
    return { final: "HOLD", holdCode: ORCHESTRATOR_HOLD.MISSING_EXECUTOR_ADAPTER_FACTORY, reason: ORCHESTRATOR_HOLD.MISSING_EXECUTOR_ADAPTER_FACTORY, scheduler: null, phaseResults: [], transitions: [] };
  }
  if (typeof reviewerAdapterFactory !== "function") {
    return { final: "HOLD", holdCode: ORCHESTRATOR_HOLD.MISSING_REVIEWER_ADAPTER_FACTORY, reason: ORCHESTRATOR_HOLD.MISSING_REVIEWER_ADAPTER_FACTORY, scheduler: null, phaseResults: [], transitions: [] };
  }
  if (maxRepairAttempts !== 0 && maxRepairAttempts !== 1) {
    return { final: "HOLD", holdCode: ORCHESTRATOR_HOLD.INVALID_REPAIR_BUDGET, reason: ORCHESTRATOR_HOLD.INVALID_REPAIR_BUDGET, scheduler: null, phaseResults: [], transitions: [] };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { final: "HOLD", holdCode: ORCHESTRATOR_HOLD.INVALID_TIMEOUT, reason: ORCHESTRATOR_HOLD.INVALID_TIMEOUT, scheduler: null, phaseResults: [], transitions: [] };
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    return { final: "HOLD", holdCode: "ORCHESTRATOR_CWD_INVALID", reason: "ORCHESTRATOR_CWD_INVALID", scheduler: null, phaseResults: [], transitions: [] };
  }

  const phaseResults = [];
  const transitions = [];

  // ── DECOMP-OPT1-PC1: parent/run facts observed ONCE（frozen manifest）──
  const telemetry = emptyInheritanceTelemetry();
  let inheritanceCtx = null;
  if (inheritance && inheritance.enabled === true) {
    const resolved = await resolveInheritanceManifest({
      inheritance,
      ir,
      parent,
      manifest,
      cwd,
      executionId,
      hooks,
      maxRepairAttempts,
      telemetry,
    });
    if (!resolved.ok) {
      telemetry.inheritanceHoldCount += 1;
      return {
        final: "HOLD",
        holdCode: resolved.code,
        reason: resolved.reason,
        scheduler: null,
        phaseResults: [],
        transitions: [],
        inheritance: { enabled: true, manifest: null, manifestSha256: null, manifestIdentity: null, telemetry, dispositionCounts: {} },
      };
    }
    inheritanceCtx = {
      manifest: resolved.manifest,
      cbm: { ...emptyCbmMetrics(), ...resolved.cbm },
    };
    telemetry.cbm = inheritanceCtx.cbm;
  }

  const execute = async (phase) => {
    const phaseId = phase?.phase_id ?? "unknown";
    try {
      await hooks.onPhaseStart?.({ phaseId });

      // ── DECOMP-OPT1-PC1: F3A per-child guard BEFORE any child work ──
      if (inheritanceCtx) {
        const guard = guardRepositoryIdentity({
          cwd,
          expectedHead: inheritanceCtx.manifest.repositoryIdentity?.expected_head ?? null,
        });
        if (!guard.ok) {
          telemetry.invalidationTriggerCount += 1;
          telemetry.inheritanceHoldCount += 1;
          throw new InheritanceHoldError(INHERITANCE_HOLD.FRESHNESS_UNPROVEN, `inheritance guard failed: ${guard.reason}`);
        }
        telemetry.identityObservationsPerChild.guard += 1;
      }

      const taskCard = buildPhaseTaskCard({
        phase,
        parent,
        executionId,
        cwd,
        maxRepairAttempts,
        expectedReviewerModel: hooks.expectedReviewerModel || "",
        toolPolicy: hooks.toolPolicy,
        environmentAllowlist: hooks.environmentAllowlist,
      });
      // C4Q: harness-owned evidence wiring — the verification command and the
      // executor model identity come from harness configuration（never from
      // model text）and are attached to the task card for the evidence builder.
      // DECOMP-OPT1 verification layering: the command runs for writer /
      // explicitly-flagged verification phases only; read-only phases skip
      // the redundant process（design §7 / card §I PARENT_GLOBAL layering）.
      const verificationFlagged =
        phase?.verification_plan?.requires_system_verification === true ||
        phase?.runtime?.mode === "verification";
      taskCard.verificationCommand = Array.isArray(hooks.verificationCommand)
        ? ((inheritanceCtx ? (requiresWriterLease(phase) || verificationFlagged) : true)
            ? hooks.verificationCommand
            : null)
        : null;
      taskCard.expectedExecutorModel = hooks.expectedExecutorModel ?? "";
      taskCard.expectedExecutorProvider = hooks.expectedExecutorProvider ?? "";

      // ── DECOMP-OPT1-PC1: per-child dispositions + execution packet ──
      if (inheritanceCtx) {
        const manifest = inheritanceCtx.manifest;
        // Child-local REVALIDATE obligations: digest the parent-spec files the
        // manifest bound（cheap freshness check; never full rediscovery）.
        const relevantFileDigests = {};
        const specPaths = (manifest.facts || [])
          .filter((f) => Array.isArray(f.filePaths) && f.filePaths.length > 0)
          .flatMap((f) => f.filePaths);
        for (const rel of specPaths) {
          try {
            relevantFileDigests[rel] = sha256Text(readFileSync(new URL(`file://${cwd}/${rel}`)));
          } catch {
            relevantFileDigests[rel] = null;
          }
        }
        const dispositions = evaluateInvalidations({
          manifest,
          live: {
            head: guardHead(inheritanceCtx),
            treeSha: manifest.repositoryIdentity?.expected_tree ?? null,
            manifestIntegrity: true,
            relevantFileDigests,
            allowRecompute: false,
          },
        });
        for (const d of dispositions) {
          if (d.disposition === "REUSE") telemetry.reuseCount += 1;
          else if (d.disposition === "REVALIDATE") telemetry.revalidateCount += 1;
          else if (d.disposition === "RECOMPUTE") telemetry.recomputeCount += 1;
          else telemetry.inheritanceHoldCount += 1;
          if (d.disposition !== "REUSE") telemetry.invalidationTriggerCount += 1;
        }
        telemetry.inheritedFactCount += dispositions.length;

        const childEvidence = await resolveChildEvidenceRefs({
          cbm: inheritanceCtx.cbm,
          manifest,
          childCardId: phaseId,
          executionId,
        });
        const { packet } = buildChildExecutionPacket({
          childCardId: phaseId,
          manifest,
          phase,
          dispositions,
          inheritedEvidenceRefs: childEvidence.refs,
          childLocalEvidenceRequirements: requiresWriterLease(phase)
            ? ["mutation-scope-gate", "system-observed-delta", "writer-test-evidence"]
            : ["mutation-scope-gate", "system-observed-delta"],
          authorizedScope: taskCard.allowedPaths,
          unauthorizedScope: taskCard.forbiddenPaths,
          mutationAuthority: requiresWriterLease(phase) ? "writer-lease" : "none",
          dependencyBoundary: Array.isArray(phase.depends_on) ? phase.depends_on.slice() : [],
          explicitInvalidationConditions: [],
        });
        taskCard.inheritancePacket = packet;
        taskCard.inheritedBaseline = deriveF3ABaseline(manifest);
        telemetry.childPacketCount += 1;
        telemetry.duplicateContextReconstructionAvoided += 1;
        if (taskCard.verificationCommand === null) telemetry.duplicateVerificationAvoided += 1;
      }

      // Baseline snapshot taken immediately before this phase runs, so a
      // serialized later phase sees the state AFTER earlier phases. The
      // wiring may scope mutation verification to a per-phase root（e.g. an
      // isolated worktree）via hooks.scopeBaselineForPhase; otherwise the
      // shared repository root is used.
      const scopeInfo = (hooks.scopeBaselineForPhase && hooks.scopeBaselineForPhase(phase)) || {
        repositoryRoot: cwd,
        baselineSnapshot: captureScopeSnapshot(cwd),
      };
      // The sealed scope gate matches full changed-file paths against glob
      // patterns; a concrete canonical boundary is expanded to its subtree
      // patterns here (mechanical, never wider than the boundary).
      taskCard.mutationScope = {
        repositoryRoot: scopeInfo.repositoryRoot,
        baselineSnapshot: scopeInfo.baselineSnapshot,
        allowedPaths: deriveScopePatterns(taskCard.allowedPaths),
        forbiddenPaths: deriveScopePatterns(taskCard.forbiddenPaths),
      };

      const executorAdapter = executorAdapterFactory();
      const reviewerAdapter = reviewerAdapterFactory();

      const lifecycle = await runLifecycle({
        cwd,
        taskCard,
        executorAdapter,
        reviewerAdapter,
        executorEvidenceValidator: validateImplementationEvidence,
        maxRepairAttempts,
        timeoutMs,
        abortSignal: signal,
        hooks: {
          onExecutorOutput: (info) => hooks.lifecycle?.onExecutorOutput?.({ phaseId, ...info }),
          onExecutorCompleted: (info) => hooks.lifecycle?.onExecutorCompleted?.({ phaseId, ...info }),
          onReviewerCompleted: (info) => hooks.lifecycle?.onReviewerCompleted?.({ phaseId, ...info }),
          onRepairRequested: (info) => hooks.lifecycle?.onRepairRequested?.({ phaseId, ...info }),
          // C4S: the system-observed delta（patch + metadata）is persisted
          // before the reviewer is invoked; persistence failure HOLDS.
          onSystemDeltaReady: (info) => hooks.lifecycle?.onSystemDeltaReady?.({ phaseId, ...info }),
        },
      });

      transitions.push({
        phaseId,
        executionId: taskCard.executionId,
        final: lifecycle.final,
        attempt: lifecycle.attempt,
        reason: lifecycle.reason ?? null,
        lifecycleTransitions: (lifecycle.transitions || []).map((t) => ({
          ...t,
          detail: stripDiagnosticsFromDetail(t.detail),
        })),
      });
      await hooks.onPhase?.({ phaseId, final: lifecycle.final, attempt: lifecycle.attempt });
      await hooks.onPhaseTerminal?.({
        phaseId,
        final: lifecycle.final,
        attempt: lifecycle.attempt,
        reason: lifecycle.reason ?? null,
        detail: lifecycle.detail ?? null,
      });

      if (lifecycle.final === "PASS") {
        phaseResults.push({ phaseId, status: "passed", final: "PASS", attempt: lifecycle.attempt });
        return { status: "passed" };
      }
      phaseResults.push({ phaseId, status: "held", final: "HOLD", attempt: lifecycle.attempt, reason: lifecycle.reason ?? null });
      return { status: "held" };
    } catch (e) {
      if (e instanceof InheritanceHoldError) {
        transitions.push({ phaseId, executionId: null, final: "HOLD", attempt: null, reason: e.code, lifecycleTransitions: [] });
        phaseResults.push({ phaseId, status: "held", final: "HOLD", reason: e.code });
        await hooks.onPhaseTerminal?.({ phaseId, final: "HOLD", reason: e.code });
        return { status: "held" };
      }
      if (e instanceof PhaseCardError) {
        transitions.push({ phaseId, executionId: null, final: "HOLD", attempt: null, reason: e.code, lifecycleTransitions: [] });
        phaseResults.push({ phaseId, status: "held", final: "HOLD", reason: e.code });
        await hooks.onPhaseTerminal?.({ phaseId, final: "HOLD", reason: e.code });
        return { status: "held" };
      }
      // Unexpected exception → failed（runner propagates to HOLD + skips descendants）
      transitions.push({ phaseId, executionId: null, final: "HOLD", attempt: null, reason: `exception:${e?.code || e?.name || "unknown"}`, lifecycleTransitions: [] });
      phaseResults.push({ phaseId, status: "failed", final: "HOLD", reason: `exception:${e?.code || e?.name || "unknown"}` });
      await hooks.onPhaseTerminal?.({ phaseId, final: "HOLD", reason: `exception:${e?.code || e?.name || "unknown"}` });
      return { status: "failed" };
    }
  };

  const run = await runDecompositionGraph({
    ir,
    execute,
    workspace: cwd,
    signal,
    initialState,
    hooks: hooks.runner || {},
  });

  const dispositionCounts = {
    reuseCount: telemetry.reuseCount,
    revalidateCount: telemetry.revalidateCount,
    recomputeCount: telemetry.recomputeCount,
    holdCount: telemetry.inheritanceHoldCount,
  };

  return {
    final: run.verdict === "PASS" ? "PASS" : "HOLD",
    holdCode: run.verdict === "PASS" ? null : "ORCHESTRATION_HOLD",
    reason: run.verdict === "PASS" ? null : (run.writerViolations.length > 0
      ? `WRITER_LEASE_VIOLATION:${run.writerViolations.join(";")}`
      : run.verdict),
    scheduler: {
      verdict: run.verdict,
      order: run.order,
      statuses: run.statuses,
      skipped: run.skipped,
      writerViolations: run.writerViolations,
      leaseHolderAfter: run.leaseHolderAfter,
      phases: run.phases,
    },
    phaseResults,
    transitions,
    inheritance: inheritanceCtx
      ? {
          enabled: true,
          manifest: inheritanceCtx.manifest,
          manifestSha256: inheritanceCtx.manifest.manifestSha256,
          manifestIdentity: inheritanceCtx.manifest.manifestIdentity,
          dispositionCounts,
          telemetry,
        }
      : null,
  };
}

/** Current head for disposition evaluation（post-guard: frozen head is live）. */
function guardHead(ctx) {
  return ctx.manifest.repositoryIdentity?.expected_head ?? null;
}
