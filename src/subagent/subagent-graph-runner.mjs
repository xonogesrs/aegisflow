// src/subagent/subagent-graph-runner.mjs
//
// Sub-agent Graph runner — wires REAL sub-agents（read-only AND writer）into
// Graph nodes through the existing scheduler + Colima pipeline:
//
//   read-only node: Graph node -> sub-agent envelope -> real agent process
//     （isolated Colima container, repo ro / scratch rw / shared results rw /
//     network none / no socket）-> structured result
//     （autoloop.subagent.structured-result/v1）-> executor collection +
//     validation -> reviewer verification
//
//   writer node: Graph node -> writer sub-agent envelope（worktree identity +
//     base commit + mutation scope + dependency result identities + repair
//     budget）-> real writer agent process bound to a DEDICATED git worktree
//     （repo ro /scratch rw / worktree rw at /work / shared results rw）->
//     structured writer result（autoloop.subagent.writer-result/v1）-> host
//     scope/diff verification（fail-closed）-> reviewer verification ->
//     worktree output captured and worktree revoked（PASS / HOLD closeout）;
//     REPAIR keeps the SAME worktree identity for the bounded repair attempt.
//
// A shared results dir（owned scratch child/results）is mounted rw into every
// sub-agent node and the JOIN/verifier node. Each sub-agent's validated
// structured result is persisted host-side to /results/<nodeId>.json at phase
// terminal（deterministic, reviewed state）; a writer's captured worktree
// output（diff + files + scope）is persisted to /results/<nodeId>.worktree.json
// BEFORE the worktree is revoked, so downstream read-only verifiers can
// independently check the writer's changes.
//
// Read-only JOIN/verifier nodes（runtime.mode = "readonly" + joinVerify）run
// their real verification command through the Colima read-only executor, so
// their stdout markers are actually produced and checked.

import { createHash } from "node:crypto";

function sha256Hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { runColimaGraph, isWriterPhase } from "../runtime/colima-graph-runner.mjs";
import { runDurableGraph, resumeDurableGraph, DurableGraphHoldError } from "../v2/durable-graph.mjs";
import { checkpointExists } from "../v2/checkpoint-bridge.mjs";
import { validateAdmission } from "../admission/admission-record.mjs";
import { projectEnvelopeFields } from "../admission/policy-projection.mjs";
import { createColimaExecutorAdapter } from "../runtime/colima-executor-adapter.mjs";
import { createColimaReviewerAdapter } from "../runtime/colima-reviewer-adapter.mjs";
import { phaseExecutionId } from "../v2/phase-task-card.mjs";
import { createSubagentExecutorAdapter } from "./subagent-executor-adapter.mjs";
import { createSubagentWriterExecutorAdapter } from "./subagent-writer-executor-adapter.mjs";
import { createSubagentReviewerAdapter } from "./subagent-reviewer-adapter.mjs";
import { createReviewAgentReviewerAdapter } from "./subagent-review-agent.mjs";
import { prepareOwnedScratchRoot, planOwnedScratchRoot, getScratchAuthorityToken } from "../runtime/scratch-ownership.mjs";

export const SUBAGENT_GRAPH_RESULT_SCHEMA = "autoloop.subagent.parallel-graph-result/v1";
/** sha256 over the concatenated canonical contents of all result files. */
export function digestResultsDir(resultsDir) {
  const files = readdirSync(resultsDir).filter((f) => f.endsWith(".json")).sort();
  const digest = createHash("sha256");
  for (const f of files) {
    digest.update(`${f}\n`);
    digest.update(readFileSync(join(resultsDir, f), "utf8"));
    digest.update("\n");
  }
  return digest.digest("hex");
}

/**
 * DE-2 production wiring: the durable layer（runDurableGraph）requires a
 * C2D-minted execution id（`exec_[0-9a-f]{32}`）. Production callers pass a
 * logical run id（e.g. `cbm4-self-closeout-20260807`）. Map it deterministically
 * so the durable store id is stable across crash + resume; valid ids pass
 * through unchanged.
 */
export function durableExecutionIdFor(requestExecutionId) {
  if (/^exec_[0-9a-f]{32}$/.test(requestExecutionId)) return requestExecutionId;
  return `exec_${createHash("sha256").update(`subagent-graph:${requestExecutionId}`).digest("hex").slice(0, 32)}`;
}

function isWriterSubagentPhase(phase) {
  return phase?.runtime?.mode === "subagent" && phase?.runtime?.agentRole === "writer";
}

/** Build dependency result identities from the persisted results dir. */
function dependencyResultIdentities(resultsDir, executionId, dependsOn) {
  return (dependsOn ?? [])
    .filter((d) => existsSync(join(resultsDir, `${d}.json`)))
    .map((d) => {
      let raw = null;
      try {
        raw = JSON.parse(readFileSync(join(resultsDir, `${d}.json`), "utf8"));
      } catch {
        raw = null;
      }
      return {
        nodeId: d,
        phaseExecutionId: phaseExecutionId(executionId, d),
        status: raw?.status ?? null,
        filesChanged: Array.isArray(raw?.filesChanged) ? raw.filesChanged : null,
      };
    });
}

/**
 * Run a sub-agent Graph（SA-R1 ‖ SA-R2 -> SA-W1 -> SA-V1 style）.
 *
 * Phase routing（by runtime.mode / agentRole）:
 *   - { mode: "subagent", agentRole: "writer", effects.artifact_mutation:
 *       "required", effects.boundaries.artifact: [scope...] } -> writer
 *       sub-agent（dedicated worktree; single-writer lease from the sealed
 *       scheduler）
 *   - { mode: "subagent", taskType: count_todos | inventory_markdown |
 *       verify_writer } -> read-only sub-agent
 *   - { mode: "readonly", joinVerify: true, command } -> read-only verification
 *       command（real stdout markers checked by the colima reviewer）
 */
export async function runSubagentGraph({
  ir,
  parent,
  manifest = [],
  cwd,
  executionId,
  profile = "autoloop-graph",
  repoPath,
  scratchRoot,
  maxRepairAttempts = 1,
  timeoutMs = 90000,
  signal,
  hooks = {},
  closeout,
  closeoutGate,
  closeoutSourceBuilder,
  closeoutEvidenceWriter,
  memory = null,
  // COST-1 passive telemetry（opt-in）— forwarded to runColimaGraph; the
  // observer runs post-result and can never alter task semantics.
  telemetry = null,
  // CBM-4 governed memory write-back（opt-in）— forwarded to runColimaGraph;
  // runs post-final as an evidence-governed side effect, never a task authority.
  writeback = null,
  // DE-2 PRODUCTION WIRING: this runner IS the production Graph entry that
  // every card closeout script invokes, and it runs under native durable
  // execution by default（runDurableGraph → runColimaGraph → journal +
  // checkpoints）. `durable: false` is the documented TEST-ONLY escape hatch
  //（raw-runner semantics; no production caller uses it — enforced by a
  // regression guard in test/v2/test-durable-graph.mjs）.
  durable = true,
  // Explicit durable store（resume requires knowing the root + execution id）.
  // Auto-derived under ~/.autoloop/durable/<durableExecutionId> when omitted.
  persistence = null,
  dirtyScope = [],
  preserveInstance = false,
  // TA-2 admission（K; compatibility surface — the PRODUCTION entrypoint is
  // runAdmittedGraph / runSubagentGraphAdmitted in src/admission/admission-gate.mjs）:
  // the frozen admission drives envelope toolPermissions
  // + mutationScope + repair budget. Fail-closed when present.
  admission = null,
  // TA-3 budget enforcement（production authority — injected by runAdmittedGraph）:
  // forwarded to runDurableGraph / runColimaGraph so the pre-dispatch gate,
  // settlement and reconciliation run inside the production graph path.
  budget = null,
}) {
  const durableExecutionId = durable ? (persistence?.executionId ?? durableExecutionIdFor(executionId)) : null;

  // TA-2 admission gate: malformed / inconsistent admission -> HOLD /
  // ADMISSION_INVALID before any graph work（A3）. The scheduler only
  // CONSUMES the frozen record（A1 / J）.
  if (admission) {
    const av = validateAdmission(admission);
    if (!av.ok) {
      return {
        schema: SUBAGENT_GRAPH_RESULT_SCHEMA,
        executionId,
        final: "HOLD",
        holdCode: "ADMISSION_INVALID",
        reason: `ADMISSION_INVALID: ${av.errors.slice(0, 4).join("; ")}`,
        scheduler: null,
        nodeResults: [],
        transitions: [],
        closeout: { applied: false },
      };
    }
  }
  const admissionDigest_ = admission ? sha256Hex(JSON.stringify({ admission_id: admission.admission_id, size: admission.size, risk: admission.risk, profile: admission.profile })) : null;
  const scratchExecutionId = durableExecutionId ?? executionId;
  const ownedScratchRoot = durable
    ? planOwnedScratchRoot({ scratchRoot, executionId: scratchExecutionId, repoPath })
    : prepareOwnedScratchRoot({ scratchRoot, executionId: scratchExecutionId, repoPath });
  const scratchAuthorityToken = durable ? null : getScratchAuthorityToken(ownedScratchRoot);
  if (!durable && typeof scratchAuthorityToken !== "string") throw new Error("scratch authority unavailable");
  // Results stay directly under stable owned execution child so fresh-process
  // resume can preserve them without recreating caller-controlled paths.
  const resultsDir = join(ownedScratchRoot, "results");
  if (!durable) mkdirSync(resultsDir, { recursive: true });

  if (durable) {
    // ── PRODUCTION DURABLE PATH ──────────────────────────────────────────
    // production invocation -> runSubagentGraph -> runDurableGraph ->
    // runColimaGraph -> journal + checkpoint store（single new durable
    // state machine; see src/v2/durable-graph.mjs）. The returned envelope
    // keeps the caller's logical executionId（resume maps it back via
    // durableExecutionIdFor）+ exposes durableExecutionId + the recovery /
    // evidence provenance ONLY the durable layer produces.
    const root = persistence?.root ?? join(homedir(), ".autoloop", "durable", durableExecutionId);
    const { executorAdapterFactory, reviewerAdapterFactory } = buildSubagentAdapterFactories({ profile, repoPath, scratchRoot: ownedScratchRoot, resultsDir, maxRepairAttempts });
    const durableResult = await runDurableGraph({
      ir,
      parent,
      manifest,
      cwd,
      executionId: durableExecutionId,
      profile,
      repoPath,
      scratchRoot,
      maxRepairAttempts,
      timeoutMs,
      signal,
      // Shared production sub-agent wiring（resultsDir persistence + review
      // result attach + writer/JOIN phase prep）, composed over the caller's
      // hooks. Runs AFTER durable-graph's own hooks（journal + checkpoint +
      // colima prep）— the production sub-agent wiring keeps running inside
      // the durable layer.
      hooks: buildSubagentGraphHooks({ ir, resultsDir, dependencyExecutionId: durableExecutionId, hooks, admission, admissionDigest: admissionDigest_ }),
      closeout,
      closeoutGate,
      closeoutSourceBuilder,
      closeoutEvidenceWriter,
      memory,
      telemetry,
      writeback,
      dirtyScope,
      preserveInstance,
      executorAdapterFactory,
      reviewerAdapterFactory,
      persistence: { root, executionId: durableExecutionId },
      admission,
      budget,
    });
    return { ...durableResult, executionId, durableExecutionId };
  }

  // ── TEST-ONLY RAW PATH（durable: false）───────────────────────────────
  const { executorAdapterFactory: rawExecutorFactory, reviewerAdapterFactory: rawReviewerFactory } = buildSubagentAdapterFactories({ profile, repoPath, scratchRoot: ownedScratchRoot, resultsDir, maxRepairAttempts });
  return runColimaGraph({
    ir,
    parent,
    manifest,
    cwd,
    executionId,
    profile,
    repoPath,
    scratchRoot,
    maxRepairAttempts,
    timeoutMs,
    signal,
    memory,
    telemetry,
    writeback,
    closeout,
    closeoutGate,
    closeoutSourceBuilder,
    closeoutEvidenceWriter,
    // Same shared sub-agent wiring as the durable path（dependency
    // identities keyed to the logical executionId, raw-runner semantics）.
    hooks: buildSubagentGraphHooks({ ir, resultsDir, dependencyExecutionId: executionId, hooks, admission, admissionDigest: admissionDigest_ }),
    executorAdapterFactory: rawExecutorFactory,
    reviewerAdapterFactory: rawReviewerFactory,
    scratchAuthorityToken,
    admission,
    budget,
  });
}

/**
 * DE-2R: PRODUCTION SUB-AGENT RESUME ENTRY — the fresh-process counterpart of
 * runSubagentGraph.
 *
 * A crashed durable sub-agent graph is resumed by re-injecting the EXACT same
 * production sub-agent wiring the original run used（shared resultsDir
 * persistence hooks + executor/reviewer dispatchers + independent review
 * agent）into resumeDurableGraph, then continuing the same graph identity
 * from durable truth. Nothing is reconstructed from memory; the IR, phase
 * states, side-effect ids, repair budget and resultsDir contents all come
 * from the durable store on disk. The caller's logical executionId maps back
 * to the same durable execution id（durableExecutionIdFor）so resume always
 * targets the crashed run's store.
 *
 * @param {object} opts — same opts as runSubagentGraph EXCEPT `ir`（the IR is
 *   reconstructed from durable truth; a caller-supplied `ir` is ignored）.
 *   `persistence`（{ root, executionId }）must match the original run.
 */
export async function resumeSubagentGraph({
  ir: _ignoredIr, // resume reconstructs the IR from durable truth on disk
  parent,
  manifest = [],
  cwd,
  executionId,
  profile = "autoloop-graph",
  repoPath,
  scratchRoot,
  maxRepairAttempts = 1,
  timeoutMs = 90000,
  signal,
  hooks = {},
  closeout,
  closeoutGate,
  closeoutSourceBuilder,
  closeoutEvidenceWriter,
  memory = null,
  telemetry = null,
  writeback = null,
  persistence = null,
  dirtyScope = [],
  preserveInstance = false,
  // TA-2（N）: the authoritative admission re-verified on resume（stored
  // admission_id mismatch -> HOLD / ADMISSION_DRIFT）.
  admission = null,
}) {
  const durableExecutionId = persistence?.executionId ?? durableExecutionIdFor(executionId);
  const root = persistence?.root ?? join(homedir(), ".autoloop", "durable", durableExecutionId);
  if (!checkpointExists(root, durableExecutionId)) {
    throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "no checkpoint exists for this execution");
  }
  let scratchAuthorityToken = null;
  try {
    scratchAuthorityToken = JSON.parse(readFileSync(join(root, durableExecutionId, "artifacts", "scratch-ownership.json"), "utf8")).authorityToken;
  } catch {
    throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "scratch ownership authority missing");
  }
  if (typeof scratchAuthorityToken !== "string") {
    throw new DurableGraphHoldError("RESUME_FINGERPRINT_MISMATCH", "scratch ownership authority missing");
  }
  const ownedScratchRoot = planOwnedScratchRoot({ scratchRoot, executionId: durableExecutionId, repoPath });
  // Preserve stable results across resume scratch wipe; all other owned child
  // contents remain reclaimable.
  const resultsDir = join(ownedScratchRoot, "results");
  // Reconstruct the IR from the durable store so the composed hooks mutate
  // the EXACT phase objects resumeDurableGraph drives（resumeDurableGraph
  // adopts a caller IR only when it reproduces the durable artifact）. A
  // missing/unreadable artifact is fine — resumeDurableGraph fails closed
  // with RESUME_FINGERPRINT_MISMATCH / RESTART_REQUIRED before any hook runs.
  let irFromDisk = null;
  try {
    irFromDisk = JSON.parse(readFileSync(join(root, durableExecutionId, "artifacts", "decomposition-ir.json"), "utf8"));
  } catch { /* handled fail-closed inside resumeDurableGraph */ }
  const { executorAdapterFactory, reviewerAdapterFactory } = buildSubagentAdapterFactories({ profile, repoPath, scratchRoot: ownedScratchRoot, resultsDir, maxRepairAttempts });
  const admissionDigest_ = admission ? sha256Hex(JSON.stringify({ admission_id: admission.admission_id, size: admission.size, risk: admission.risk, profile: admission.profile })) : null;
  const durableResult = await resumeDurableGraph({
    ir: irFromDisk,
    parent,
    manifest,
    cwd,
    executionId: durableExecutionId,
    profile,
    repoPath,
    scratchRoot,
    maxRepairAttempts,
    timeoutMs,
    signal,
    hooks: buildSubagentGraphHooks({ ir: irFromDisk, resultsDir, dependencyExecutionId: durableExecutionId, hooks, admission, admissionDigest: admissionDigest_ }),
    closeout,
    closeoutGate,
    closeoutSourceBuilder,
    closeoutEvidenceWriter,
    memory,
    telemetry,
    writeback,
    dirtyScope,
    preserveInstance,
    executorAdapterFactory,
    reviewerAdapterFactory,
    persistenceRoot: root,
    // Keep the crashed run's persisted sub-agent results across the resume
    // scratch wipe（worktrees / phase scratch are still reclaimed）.
    scratchPreserve: ["results"],
    admission,
  });
  return { ...durableResult, executionId, durableExecutionId };
}

/**
 * Shared production sub-agent wiring, used by the durable path, the raw
 * test path, and the DE-2R resume entry — one definition so fresh-run and
 * fresh-process-resume can never drift apart.
 *
 * Composes over the caller's hooks（called AFTER durable-graph's own
 * hooks）:
 *   - onPhaseStart: inject writer mutation scope + dependency result
 *     identities/digest, and the /results mount for JOIN verifier phases;
 *   - onPhaseTerminal: persist reviewed sub-agent results + writer worktree
 *     artifacts to the shared results dir, and attach the writer's final
 *     independent review result（resultsDir/<phaseId>.review.json）.
 *
 * @param {object} opts.ir — the IR object runColimaGraph drives（its phase
 *   objects receive the runtime mutations）; null on resume-safe paths where
 *   the IR is reconstructed by the durable layer.
 * @param {string} opts.dependencyExecutionId — execution id used to build
 *   dependency result identities（durable id inside the durable layer）.
 */
function buildSubagentGraphHooks({ ir, resultsDir, dependencyExecutionId, hooks, admission = null, admissionDigest = null }) {
  const phases = () => ir?.phases || [];
  const phaseFor = (phaseId) => phases().find((p) => p.phase_id === phaseId);
  return {
    ...hooks,
    // Runs AFTER durable-graph's own onPhaseStart（journal + checkpoint）
    // and after colima-graph-runner's colima prep — the production
    // sub-agent wiring must keep running inside the durable layer.
    onPhaseStart: (phaseId) => {
      mkdirSync(resultsDir, { recursive: true });
      const phase = phaseFor(phaseId);
      if (phase) {
        if (isWriterSubagentPhase(phase)) {
          // TA-2（K）: writer envelope fields（mutationScope + tool
          // permissions）are projected FROM the admission — never from the
          // agent or hardcoded in the scheduler. A phase boundary outside
          // admission.mutation_scope or a writer under a read-only admission
          // records a fail-closed violation（NEG3 / L）; the writer adapter
          // refuses to run.
          if (admission) {
            try {
              const projected = projectEnvelopeFields({ admission, nodeRole: "writer", mutationScopeFromPhase: phase.effects?.boundaries?.artifact ?? [] });
              phase.runtime.mutationScope = [...projected.mutationScope];
              phase.runtime.toolPermissions = [...projected.toolPermissions];
              phase.runtime.admissionId = admission.admission_id;
              phase.runtime.admissionDigest = admissionDigest;
              delete phase.runtime.admissionViolation;
            } catch (e) {
              phase.runtime.admissionViolation = { code: e.code ?? "ADMISSION_ENVELOPE_VIOLATION", message: e.message };
            }
          } else {
            phase.runtime.mutationScope = [...(phase.effects?.boundaries?.artifact ?? [])];
          }
          phase.runtime.dependencyResultsDigest = digestResultsDir(resultsDir);
          phase.runtime.dependencyResultIdentities = dependencyResultIdentities(resultsDir, dependencyExecutionId, phase.depends_on);
        } else if (phase.runtime?.joinVerify) {
          phase.runtime.extraRwMounts = [{ source: resultsDir, target: "/results" }];
          phase.runtime.dependencyResultsDigest = digestResultsDir(resultsDir);
        }
        // TA-2（K）: every sub-agent node carries the admission binding in
        // its envelope context（identity-bound; a changed admission
        // invalidates in-flight envelopes）.
        if (admission && phase?.runtime && typeof phase.runtime === "object") {
          phase.runtime.admissionId = phase.runtime.admissionId ?? admission.admission_id;
          phase.runtime.admissionDigest = phase.runtime.admissionDigest ?? admissionDigest;
        }
        // Read-only sub-agent roles keep READ_ONLY tools（projected below）;
        // the envelope adapter reads runtime.toolPermissions when present.
        if (admission && phase?.runtime && typeof phase.runtime === "object" && !isWriterSubagentPhase(phase)) {
          try {
            const projected = projectEnvelopeFields({ admission, nodeRole: phase.runtime?.agentRole ?? "readonly-analyst" });
            phase.runtime.toolPermissions = [...projected.toolPermissions];
          } catch (e) {
            phase.runtime.admissionViolation = { code: e.code ?? "ADMISSION_ENVELOPE_VIOLATION", message: e.message };
          }
        }
      }
      hooks.onPhaseStart?.(phaseId);
    },
    // Runs AFTER durable-graph's own onPhaseTerminal（pendingResults
    // record）and after colima-graph-runner's node capture + worktree
    // revoke — persist reviewed results + worktree artifacts for
    // downstream read-only verification.
    onPhaseTerminal: (phaseId, node) => {
      const phase = phaseFor(phaseId);
      if (phase?.runtime?.mode === "subagent" && node?.subagentResult && typeof node.subagentResult === "object") {
        writeFileSync(join(resultsDir, `${phaseId}.json`), JSON.stringify(node.subagentResult, null, 2) + "\n");
      }
      if (isWriterSubagentPhase(phase) && node?.worktreeIdentity?.output) {
        const artifact = {
          ...node.worktreeIdentity.output,
          mutationScope: phase.effects?.boundaries?.artifact ?? [],
          head: node.worktreeIdentity.head,
          verified: node.worktreeIdentity.verified,
        };
        writeFileSync(join(resultsDir, `${phaseId}.worktree.json`), JSON.stringify(artifact, null, 2) + "\n");
      }
      if (isWriterSubagentPhase(phase)) {
        const reviewPath = join(resultsDir, `${phaseId}.review.json`);
        if (existsSync(reviewPath)) {
          try {
            node.reviewResult = JSON.parse(readFileSync(reviewPath, "utf8"));
          } catch {
            node.reviewResult = null;
          }
        }
      }
      hooks.onPhaseTerminal?.(phaseId, node);
    },
  };
}

/**
 * Shared adapter dispatchers for sub-agent graphs — used by BOTH the raw
 * path, the durable production path, and the DE-2R resume entry.
 */
function buildSubagentAdapterFactories({ profile, repoPath, scratchRoot, resultsDir, maxRepairAttempts }) {
  return {
    executorAdapterFactory: subagentExecutorFactory({ profile, repoPath, scratchRoot, resultsDir, maxRepairAttempts }),
    reviewerAdapterFactory: subagentReviewerFactory({ profile, repoPath, scratchRoot, resultsDir }),
  };
}

/**
 * Shared executor dispatcher for sub-agent graphs（routes on the phase's
 * runtime spec）— used by BOTH the raw path and the durable production path.
 */
function subagentExecutorFactory({ profile, repoPath, scratchRoot, resultsDir, maxRepairAttempts }) {
  return ({ resultSink }) => {
    const roSubagent = createSubagentExecutorAdapter({ profile, repoPath, scratchRoot, resultsDir, resultSink });
    const writerSubagent = createSubagentWriterExecutorAdapter({ profile, repoPath, scratchRoot, resultsDir, resultSink, maxRepairAttempts });
    const roColima = createColimaExecutorAdapter({ profile, repoPath, scratchRoot, resultSink });
    // One dispatcher for all phases; routes on the phase's runtime spec.
    return () => ({
      runAdapter: async (request) => {
        const rt = request.taskCard?.runtime ?? {};
        if (rt.mode === "subagent" && rt.agentRole === "writer") return writerSubagent.runAdapter(request);
        if (rt.mode === "readonly") return roColima.runAdapter(request);
        return roSubagent.runAdapter(request);
      },
    });
  };
}

/**
 * Shared reviewer dispatcher for sub-agent graphs（read-only phases use the
 * deterministic colima reviewer; writer sub-agents use the INDEPENDENT review
 * agent; read-only sub-agents keep deterministic validation）— used by BOTH
 * the raw path and the durable production path.
 */
function subagentReviewerFactory({ profile, repoPath, scratchRoot, resultsDir }) {
  return () => {
    const deterministicReviewer = createSubagentReviewerAdapter();
    const colimaReviewer = createColimaReviewerAdapter();
    const reviewAgentReviewer = createReviewAgentReviewerAdapter({ profile, repoPath, scratchRoot, resultsDir });
    return {
      runAdapter: async (request) => {
        const rt = request.taskCard?.runtime ?? {};
        if (rt.mode === "readonly") return colimaReviewer.runAdapter(request);
        // Writer sub-agent phases are reviewed by the INDEPENDENT review
        // agent（real read-only process）; read-only sub-agent phases keep
        // the deterministic validation.
        if (rt.agentRole === "writer") return reviewAgentReviewer.runAdapter(request);
        return deterministicReviewer.runAdapter(request);
      },
    };
  };
}

export { isWriterPhase };
