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
import { autoloopDefault } from "../shared/autoloop-paths.mjs";
import { runDurableGraph, resumeDurableGraph, DurableGraphHoldError, childResultFoldGate } from "../v2/durable-graph.mjs";
import { checkpointExists, readCheckpoint, validateRunIdentity } from "../v2/checkpoint-bridge.mjs";
import { validateAdmission } from "../admission/admission-record.mjs";
import { projectEnvelopeFields, TOOL_SELECTION_SCHEMA } from "../admission/policy-projection.mjs";
import { createColimaExecutorAdapter } from "../runtime/colima-executor-adapter.mjs";
// WP1-A2 provider-backed sub-agent execution: the dispatch seam routes
// admitted sub-agent node execution through THE production provider adapter
// (createPiRpcAdapter) so the adapter-owned provider session — never agent
// content, never caller input — is the only usage authority surfaced as
// metadata.providerUsage on the existing node-result path.
import { createPiRpcAdapter, DEFAULT_ENV_ALLOWLIST } from "../adapter/pi-rpc-adapter.mjs";
import { canonicalizeProviderBinding } from "../rollover/spawn-registry.mjs";
import { createColimaReviewerAdapter } from "../runtime/colima-reviewer-adapter.mjs";
import { phaseExecutionId } from "../v2/phase-task-card.mjs";
import { createSubagentExecutorAdapter } from "./subagent-executor-adapter.mjs";
import { createSubagentWriterExecutorAdapter } from "./subagent-writer-executor-adapter.mjs";
import { createSubagentReviewerAdapter } from "./subagent-reviewer-adapter.mjs";
import { createReviewAgentReviewerAdapter } from "./subagent-review-agent.mjs";
import { reconcileChildResults, reconciliationFinding } from "./result-reconciliation.mjs";
import { agentExecutionIdFor, stageAgentExecutionId } from "./subagent-contract.mjs";
import { prepareOwnedScratchRoot, planOwnedScratchRoot, getScratchAuthorityToken } from "../runtime/scratch-ownership.mjs";
import { requiresWriterLease } from "../v2/runner.mjs";
import { RunEvidenceStore } from "../evidence/run-evidence-store.mjs";

export const SUBAGENT_GRAPH_RESULT_SCHEMA = "autoloop.subagent.parallel-graph-result/v1";

/**
 * WP1 authoritative-result provenance: the persisted dependency result file
 * `<phaseId>.json` is an ENVELOPE, not a bare agent payload. Host-authored
 * at phase terminal, host-verified at consumption.
 */
export const AUTHORED_RESULT_SCHEMA = "autoloop.subagent.authored-result/v1";
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
      // WP1: the persisted file is the authored-result envelope; the
      // agent-authored payload lives under `result`.
      const payload = raw?.schema_version === AUTHORED_RESULT_SCHEMA && raw.result && typeof raw.result === "object"
        ? raw.result
        : raw;
      return {
        nodeId: d,
        phaseExecutionId: phaseExecutionId(executionId, d),
        status: payload?.status ?? null,
        filesChanged: Array.isArray(payload?.filesChanged) ? payload.filesChanged : null,
      };
    });
}

/**
 * CEDF reconciliation load: the SAME persisted results the
 * dependencyResultIdentities seam reads（existsSync-filtered, unparseable
 * entries yield a null result and carry no claims）, shaped for
 * reconcileChildResults. Role comes from the IR phase runtime so join
 * verifiers are excluded from DUPLICATE_CLAIM.
 */
function persistedDependencyRecords(resultsDir, dependsOn, phaseFor) {
  return (dependsOn ?? [])
    .filter((d) => existsSync(join(resultsDir, `${d}.json`)))
    .map((d) => {
      let raw = null;
      try {
        raw = JSON.parse(readFileSync(join(resultsDir, `${d}.json`), "utf8"));
      } catch {
        raw = null;
      }
      // WP1: the persisted file is the authored-result envelope; the
      // agent-authored payload lives under `result`.
      const payload = raw?.schema_version === AUTHORED_RESULT_SCHEMA && raw.result && typeof raw.result === "object"
        ? raw.result
        : raw;
      const depPhase = phaseFor(d);
      return {
        phaseId: d,
        // CEDF adversarial fence: joinVerify exempts a dependency from
        // DUPLICATE_CLAIM ONLY when it is genuinely non-mutating. A mutating
        // phase self-declaring joinVerify keeps FULL writer authority and
        // therefore NO exemption（it is reconciled as a normal child）.
        role: depPhase?.runtime?.joinVerify && !requiresWriterLease(depPhase) ? "join" : depPhase?.runtime?.agentRole ?? null,
        result: payload,
      };
    });
}

/**
 * WP1 authoritative-result provenance verification over ONE persisted
 * dependency record. The provenance envelope (autoloop.subagent.
 * authored-result/v1) is host-authored at persistence time; a consumer
 * verifies it BEFORE binding the record as prerequisite context. Fail
 * closed: any malformed envelope, identity mismatch, or execution/generation
 * mismatch makes the dependency unusable — never silently downgraded to a
 * bare agent payload.
 *
 * @param {object|null} record — the parsed persisted file（null when absent
 *   or unparseable; absence is the pre-existing existsSync-filter behavior,
 *   enforced separately by the downstream dependency gate）.
 * @param {object} p
 * @param {string} p.executionId — the durable graph execution id the
 *   consumer runs under（must equal the producer's stamp）.
 * @param {string} p.phaseId — the dependency node id（must equal the stamp）.
 * @param {number} p.generation — the consumer's durable graph generation;
 *   a producer generation STRICTLY GREATER is a future result (fail closed);
 *   an equal generation is a same-era sibling (legal); a smaller generation
 *   is stale (fail closed — the stale-generation rule).
 * @returns {{ ok: true, result: object } | { ok: false, code: string, reason: string }}
 */
export function verifyAuthoredResultProvenance(record, { executionId, phaseId, generation }) {
  if (record === null) {
    return { ok: false, code: "DEPENDENCY_RESULT_UNREADABLE", reason: "dependency result missing or unparseable" };
  }
  if (typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, code: "DEPENDENCY_RESULT_MALFORMED", reason: "dependency result is not an object" };
  }
  if (record.schema_version !== "autoloop.subagent.authored-result/v1") {
    return { ok: false, code: "DEPENDENCY_RESULT_PROVENANCE_MISSING", reason: `schema_version ${String(record.schema_version)} is not the authored-result envelope` };
  }
  const inner = record.result;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
    return { ok: false, code: "DEPENDENCY_RESULT_MALFORMED", reason: "provenance envelope carries no result object" };
  }
  if (record.executionId !== executionId) {
    return { ok: false, code: "DEPENDENCY_EXECUTION_MISMATCH", reason: `result executionId ${String(record.executionId).slice(0, 24)} != consumer ${String(executionId).slice(0, 24)}` };
  }
  if (record.phase_id !== phaseId) {
    return { ok: false, code: "DEPENDENCY_PHASE_MISMATCH", reason: `result phase_id ${String(record.phase_id)} != expected ${phaseId}` };
  }
  if (record.phaseExecutionId !== phaseExecutionId(executionId, phaseId)) {
    return { ok: false, code: "DEPENDENCY_RESULT_MALFORMED", reason: "phaseExecutionId does not re-derive from executionId + phase_id" };
  }
  if (!Number.isInteger(record.graph_generation)) {
    return { ok: false, code: "DEPENDENCY_RESULT_MALFORMED", reason: "graph_generation missing/not an integer" };
  }
  if (record.graph_generation > generation) {
    return { ok: false, code: "DEPENDENCY_GENERATION_AHEAD", reason: `producer generation ${record.graph_generation} is ahead of consumer generation ${generation}` };
  }
  if (record.graph_generation < generation) {
    return { ok: false, code: "DEPENDENCY_GENERATION_STALE", reason: `producer generation ${record.graph_generation} is behind consumer generation ${generation}` };
  }
  if (typeof record.recorded_at !== "string" || Number.isNaN(Date.parse(record.recorded_at))) {
    return { ok: false, code: "DEPENDENCY_RESULT_MALFORMED", reason: "recorded_at missing/not ISO-8601" };
  }
  if (typeof record.agentExecutionId !== "string" || record.agentExecutionId.length === 0
      || typeof record.inputContextIdentity !== "string" || record.inputContextIdentity.length === 0) {
    return { ok: false, code: "DEPENDENCY_IDENTITY_UNBOUND", reason: "provenance carries no agent identity binding" };
  }
  // Identity binding is host-derivable: the producer's agentExecutionId MUST
  // re-derive from (executionId, phaseId) — either the node's base identity
  // or a STAGE-scoped identity (the bounded repair loop re-authors the
  // result under the repairer's stage identity; both are host-derived and
  // deterministic). A forged / cross-wired identity fails closed — never
  // trusted as a bare string.
  const identityCandidates = [
    agentExecutionIdFor(executionId, phaseId),
    stageAgentExecutionId(executionId, phaseId, "repairer"),
  ];
  if (!identityCandidates.includes(record.agentExecutionId)) {
    return { ok: false, code: "DEPENDENCY_IDENTITY_MISMATCH", reason: `agentExecutionId ${String(record.agentExecutionId).slice(0, 24)} does not re-derive from executionId + phase_id` };
  }
  return { ok: true, result: inner };
}

/**
 * WP1 authoritative-result provenance: re-bind a SURVIVING dependency result
 * to the resumed era. A crash/resume advances the durable graph generation
 * (snapshot.graph.recovery_generation + 1); the pre-crash persisted results
 * keep the producer's generation, so strict-equality verification would
 * fail-closed on exactly the continuity path the durable layer already
 * validated (childResultFoldGate: hash pin + journal proof + generation
 * binding against the OLD snapshot). This consumes that gate's verdict —
 * never a second authority — and re-authors ONLY the era fields of the
 * envelope; the agent payload and identity binding stay VERBATIM.
 *
 * A record that does not already carry the authored-result envelope is
 * refused (fail closed): legacy bare payloads are not silently upgraded.
 *
 * @param {object} record — the parsed persisted envelope.
 * @param {object} p
 * @param {number} p.generation — the resumed era's durable graph generation.
 * @returns {object} the re-authored envelope.
 * @throws {Error} code DEPENDENCY_RESULT_PROVENANCE_MISSING when the record
 *   is not an authored-result envelope.
 */
export function rebindAuthoredResultForEra(record, { generation }) {
  if (!record || typeof record !== "object" || Array.isArray(record)
      || record.schema_version !== AUTHORED_RESULT_SCHEMA) {
    const e = new Error("rebindAuthoredResultForEra: record is not an authored-result envelope");
    e.code = "DEPENDENCY_RESULT_PROVENANCE_MISSING";
    throw e;
  }
  return {
    ...record,
    graph_generation: generation,
    recorded_at: new Date().toISOString(),
  };
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
  // STAGE D: authorized mid-run rollover intake executor（coordinator-level,
  // derived by runAdmittedGraph from the frozen admission — NEVER a caller
  // override; the key is fenced at the admission-gate sink）. Forwarded to
  // runDurableGraph so the WP1 provider-usage observation + automatic
  // trigger are reachable through the sub-agent graph path too.
  rolloverRequestExecutor = null,
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
    const root = persistence?.root ?? autoloopDefault("durable", durableExecutionId);
    const { executorAdapterFactory, reviewerAdapterFactory } = buildSubagentAdapterFactories({ profile, repoPath, scratchRoot: ownedScratchRoot, resultsDir, maxRepairAttempts, admission });
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
      // the durable layer. Fresh run: durable graph generation is 0（the
      // initial era）; resume stamps recovery_generation + 1.
      hooks: buildSubagentGraphHooks({ ir, resultsDir, dependencyExecutionId: durableExecutionId, hooks, admission, admissionDigest: admissionDigest_, durableGraphGeneration: 0, telemetry }),
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
      rolloverRequestExecutor,
    });
    return { ...durableResult, executionId, durableExecutionId };
  }

  // ── TEST-ONLY RAW PATH（durable: false）───────────────────────────────
  const { executorAdapterFactory: rawExecutorFactory, reviewerAdapterFactory: rawReviewerFactory } = buildSubagentAdapterFactories({ profile, repoPath, scratchRoot: ownedScratchRoot, resultsDir, maxRepairAttempts, admission });
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
    hooks: buildSubagentGraphHooks({ ir, resultsDir, dependencyExecutionId: executionId, hooks, admission, admissionDigest: admissionDigest_, durableGraphGeneration: 0, telemetry }),
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
 *   `durableGraphGeneration`（optional）— override for the resumed era's
 *   durable graph generation. Default: DERIVED from durable truth
 *   (snapshot.graph.recovery_generation + 1 — the same derivation
 *   resumeDurableGraph performs). Surviving authored-result envelopes are
 *   re-bound to this era through the childResultFoldGate BEFORE consumption.
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
  // STAGE D: successor session binding forwarded to THE durable §9a/§13a
  // cross-session gate inside resumeDurableGraph (never authority by itself).
  rolloverSessionBinding = null,
  // WP1 authoritative-result provenance: the durable graph generation this
  // resumed era executes under. DERIVED from durable truth by default
  //（snapshot.graph.recovery_generation + 1, the same derivation
  // resumeDurableGraph performs）; an explicit nonnegative integer overrides.
  durableGraphGeneration = null,
}) {
  const durableExecutionId = persistence?.executionId ?? durableExecutionIdFor(executionId);
  const root = persistence?.root ?? autoloopDefault("durable", durableExecutionId);
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
  // WP1 authoritative-result provenance: a crash/resume advances the durable
  // graph generation (recovery_generation + 1 inside resumeDurableGraph).
  // Surviving persisted results keep the producer's era stamp, so they are
  // re-bound to THIS era BEFORE the hooks consume them — through THE
  // existing evidence-reuse authority (childResultFoldGate: checkpoint-pinned
  // hash + journal PHASE_PASSED/HELD proof + generation binding against the
  // crashed-era snapshot). A result the gate refuses stays untouched and
  // keeps failing closed downstream; a gate-accepted result is re-authored
  // with only its era fields (payload + identity binding stay verbatim).
  // The era is DERIVED from durable truth（snapshot.graph.recovery_generation
  // + 1 — the same derivation resumeDurableGraph performs）; the caller
  // parameter only OVERRIDES it（an explicit value must be a nonnegative
  // integer, never a guess）.
  const snapshot = readCheckpoint(root, durableExecutionId).snapshot;
  const derivedGeneration = (snapshot?.graph?.recovery_generation ?? 0) + 1;
  const resumedGeneration = Number.isInteger(durableGraphGeneration) && durableGraphGeneration >= 0
    ? durableGraphGeneration
    : derivedGeneration;
  rebindSurvivingResultsForEra({ root, executionId: durableExecutionId, resultsDir, ir: irFromDisk, generation: resumedGeneration });
  const { executorAdapterFactory, reviewerAdapterFactory } = buildSubagentAdapterFactories({ profile, repoPath, scratchRoot: ownedScratchRoot, resultsDir, maxRepairAttempts, admission });
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
    hooks: buildSubagentGraphHooks({ ir: irFromDisk, resultsDir, dependencyExecutionId: durableExecutionId, hooks, admission, admissionDigest: admissionDigest_, durableGraphGeneration: resumedGeneration, telemetry }),
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
    rolloverSessionBinding,
  });
  return { ...durableResult, executionId, durableExecutionId };
}

/**
 * WP1 authoritative-result provenance: re-bind SURVIVING authored-result
 * envelopes to a resumed era. A crash/resume (or rollover handover) advances
 * the durable graph generation (recovery_generation + 1); the pre-crash
 * persisted results keep the producer's era stamp, so strict-equality
 * verification would fail-closed on exactly the continuity path the durable
 * layer already validated. This consumes THE existing evidence-reuse
 * authority (childResultFoldGate: checkpoint-pinned hash + journal
 * PHASE_PASSED/HELD proof + generation binding against the OLD snapshot) —
 * never a second authority — and re-authors ONLY the era fields of
 * gate-accepted envelopes; the agent payload and identity binding stay
 * verbatim. Results the gate refuses stay untouched and keep failing closed
 * downstream.
 *
 * @param {object} p
 * @param {string} p.root — the durable persistence root.
 * @param {string} p.executionId — the durable execution id.
 * @param {string} p.resultsDir — the shared results dir.
 * @param {object|null} p.ir — the IR (phases enumerated; null is a no-op).
 * @param {number} p.generation — the era generation to re-bind to.
 * @returns {number} count of re-bound envelopes.
 */
export function rebindSurvivingResultsForEra({ root, executionId, resultsDir, ir, generation }) {
  if (!ir || !Array.isArray(ir.phases)) return 0;
  const snapshot = readCheckpoint(root, executionId).snapshot;
  const execDir = join(root, executionId);
  // Read-only journal reader over the SAME durable store — the fold gate's
  // PHASE_PASSED/HELD journal proof. init() on an existing execution dir is
  // idempotent（no event appended; head re-derived from disk）.
  const identity = validateRunIdentity(executionId);
  const journalStore = new RunEvidenceStore({ root, executionId: identity.executionId, chainId: identity.chainId, checkpointId: identity.checkpointId });
  journalStore.init();
  let rebound = 0;
  for (const p of ir.phases) {
    const resultsPath = join(resultsDir, `${p.phase_id}.json`);
    if (!existsSync(resultsPath)) continue;
    let raw = null;
    try {
      raw = JSON.parse(readFileSync(resultsPath, "utf8"));
    } catch { raw = null; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema_version !== AUTHORED_RESULT_SCHEMA) continue;
    const gate = childResultFoldGate({ snapshot, store: journalStore, execDir, phaseId: p.phase_id });
    if (!gate.ok) continue; // fail closed: the unverifiable result is never re-bound
    writeFileSync(resultsPath, JSON.stringify(rebindAuthoredResultForEra(raw, { generation }), null, 2) + "\n");
    rebound += 1;
  }
  return rebound;
}

/**
 * WP1 successor-era sub-agent composition — the ONE definition the rollover
 * successor path consumes so Session B's era runs with the SAME production
 * sub-agent wiring Session A had（resultsDir persistence hooks + writer
 * mutationScope projection + dependency identities/digest + executor/
 * reviewer dispatchers + independent review agent）. No new authority: this
 * composes the EXISTING buildSubagentGraphHooks / buildSubagentAdapterFactories
 * / planOwnedScratchRoot pieces over the durable successor resume options.
 *
 * The scratch namespace / repoPath / profile / admission / repair budget come
 * from the durable successor opts（already admission-re-verified by
 * resumeDurableGraph）; the era generation is derived from durable truth.
 *
 * @param {object} opts — the successor resume options（persistenceRoot,
 *   executionId, parent, manifest, cwd, repoPath, scratchRoot, admission,
 *   hooks, ...）plus the preconditions resumeSubagentGraph establishes.
 * @returns {object} the opts to forward to resumeDurableGraph with the
 *   sub-agent hooks + factories composed in.
 */
export function composeSuccessorSubagentGraphOpts(opts) {
  const {
    persistenceRoot,
    executionId,
    parent,
    manifest = [],
    cwd,
    repoPath,
    scratchRoot,
    profile = "autoloop-graph",
    maxRepairAttempts = 1,
    admission = null,
    hooks = {},
    resultsDir: callerResultsDir = null,
    executorAdapterFactory = null,
    reviewerAdapterFactory = null,
    // R-06: canonical telemetry wiring forwarded through the composed opts so
    // the successor era emits into the SAME run-scoped stream.
    telemetry = null,
  } = opts;
  if (typeof persistenceRoot !== "string" || persistenceRoot.length === 0
      || typeof executionId !== "string" || executionId.length === 0
      || typeof repoPath !== "string" || repoPath.length === 0
      || typeof scratchRoot !== "string" || scratchRoot.length === 0) {
    const e = new Error("composeSuccessorSubagentGraphOpts: persistenceRoot/executionId/repoPath/scratchRoot required");
    e.code = "SUBAGENT_SUCCESSOR_COMPOSITION_INVALID";
    throw e;
  }
  const ownedScratchRoot = planOwnedScratchRoot({ scratchRoot, executionId, repoPath });
  const resultsDir = callerResultsDir ?? join(ownedScratchRoot, "results");
  if (process.env.WP1_DEBUG_COMPOSER) {
    const files = existsSync(resultsDir) ? readdirSync(resultsDir) : [];
    console.error(`COMPOSER_DEBUG ownedRoot=${ownedScratchRoot} resultsDir=${resultsDir} files=[${files.join(",")}]`);
  }
  const factories = buildSubagentAdapterFactories({ profile, repoPath, scratchRoot: ownedScratchRoot, resultsDir, maxRepairAttempts, admission });
  const admissionDigest_ = admission ? sha256Hex(JSON.stringify({ admission_id: admission.admission_id, size: admission.size, risk: admission.risk, profile: admission.profile })) : null;
  // The era generation is derived from durable truth by the caller-side
  // resume entry（resumeSubagentGraph）or the durable layer itself; the hooks
  // accept either an explicit generation or the durable default（0 for an
  // unstamped era is fail-closed for nonzero envelopes — the successor path
  // ALWAYS passes the derived generation）.
  const snapshot = readCheckpoint(persistenceRoot, executionId).snapshot;
  const durableGraphGeneration = (snapshot?.graph?.recovery_generation ?? 0) + 1;
  // WP1: re-bind the surviving authored-result envelopes to THIS era through
  // the fold gate BEFORE the hooks consume them（same authority as the
  // DE-2R resume entry — otherwise strict-generation verification
  // fail-closes the successor's first dependent phase on the producer's
  // older era stamp）.
  rebindSurvivingResultsForEra({ root: persistenceRoot, executionId, resultsDir, ir: opts.ir ?? null, generation: durableGraphGeneration });
  return {
    ...opts,
    hooks: buildSubagentGraphHooks({ ir: opts.ir ?? null, resultsDir, dependencyExecutionId: executionId, hooks, admission, admissionDigest: admissionDigest_, durableGraphGeneration, telemetry }),
    executorAdapterFactory: executorAdapterFactory ?? factories.executorAdapterFactory,
    reviewerAdapterFactory: reviewerAdapterFactory ?? factories.reviewerAdapterFactory,
    // DE-2R parity: the successor era's resume wipe must keep the persisted
    // sub-agent results（the same preserve contract resumeSubagentGraph
    // passes）; without it the wipe deletes results/ before the first
    // dependent phase reads them.
    scratchPreserve: ["results"],
  };
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
 * @param {number|null} opts.durableGraphGeneration — the durable graph
 *   generation（recovery_generation）this era executes under, stamped into
 *   persisted result provenance（WP1 authoritative-result provenance）.
 */
function buildSubagentGraphHooks({ ir, resultsDir, dependencyExecutionId, hooks, admission = null, admissionDigest = null, durableGraphGeneration = null, telemetry = null }) {
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
        // CEDF child-result reconciliation: before this phase binds its
        // dependencies' persisted results as frozen prerequisite context,
        // their claims are reconciled（pure, deterministic）. The digest
        // below stays computable regardless; a CONFLICT verdict rides the
        // EXISTING envelope blockingFindings channel
        //（runtime.dependencyConflicts -> buildSubagentEnvelope
        // blockingFindings -> reviewer HOLD / governance PASS-closeout
        // block）so conflicting siblings are never silently chained.
        if ((phase.depends_on ?? []).length > 0) {
          // R-06: dependency consumption observability（identity fields only;
          // the provenance/fold gates remain THE dependency authority）.
          telemetry?.lifecycle?.emit?.("dependency.consumed", {
            phaseId,
            outcome: "CONSUMING",
            detail: (phase.depends_on ?? []).join(",") || null,
            generation: Number.isInteger(durableGraphGeneration) ? durableGraphGeneration : 0,
          });
          // WP1 authoritative-result provenance: verify EVERY persisted
          // dependency record's envelope BEFORE binding it as prerequisite
          // context. The consumer's durable graph generation is this era's
          // recovery generation (0 on a fresh run). Fail closed: any
          // malformed envelope / execution / phase / generation / identity
          // mismatch makes the dependency unusable — the finding rides the
          // EXISTING blockingFindings channel and the dependent phase is
          // never dispatched (same gate as the reconciliation CONFLICT).
          const consumerGeneration = Number.isInteger(durableGraphGeneration) ? durableGraphGeneration : 0;
          const provenanceFindings = (phase.depends_on ?? []).map((d) => {
            const p = join(resultsDir, `${d}.json`);
            if (!existsSync(p)) return null; // absence is the pre-existing existsSync-filter behavior; enforced downstream
            let raw = null;
            try {
              raw = JSON.parse(readFileSync(p, "utf8"));
            } catch {
              raw = null;
            }
            const v = verifyAuthoredResultProvenance(raw, { executionId: dependencyExecutionId, phaseId: d, generation: consumerGeneration });
            return v.ok ? null : `DEPENDENCY_PROVENANCE:${v.code}:${d}:${String(v.reason).slice(0, 120)}`;
          }).filter(Boolean);
          if (provenanceFindings.length > 0) {
            phase.runtime.dependencyConflicts = [
              ...(Array.isArray(phase.runtime.dependencyConflicts) ? phase.runtime.dependencyConflicts : []),
              ...provenanceFindings,
            ];
          }
          const reconciliation = reconcileChildResults(persistedDependencyRecords(resultsDir, phase.depends_on, phaseFor));
          phase.runtime.dependencyReconciliation = reconciliation;
          if (reconciliation.verdict === "CONFLICT") {
            phase.runtime.dependencyConflicts = [
              ...(Array.isArray(phase.runtime.dependencyConflicts) ? phase.runtime.dependencyConflicts : []),
              ...reconciliation.conflicts.map(reconciliationFinding),
            ];
          }
        }
        if (isWriterSubagentPhase(phase)) {
          // TA-2（K）: writer envelope fields（mutationScope + tool
          // permissions）are projected FROM the admission — never from the
          // agent or hardcoded in the scheduler. A phase boundary outside
          // admission.mutation_scope or a writer under a read-only admission
          // records a fail-closed violation（NEG3 / L）; the writer adapter
          // refuses to run.
          if (admission) {
            try {
              // The isolated worktree root is the boundary's reference root
              //（colima-graph-runner sets runtime.worktreePath before this hook）,
              // so the projection and the enforcement gate resolve the boundary
              // identically — including symlink-adjacent representations. Where
              // no root is known the projection stays lexical; the gate remains
              // the authority.
              const projected = projectEnvelopeFields({
                admission,
                nodeRole: "writer",
                mutationScopeFromPhase: phase.effects?.boundaries?.artifact ?? [],
                repositoryRoot: phase.runtime?.worktreePath ?? null,
              });
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
      // WP1 authoritative-result provenance: a persisted dependency result
      // is never a bare agent payload — it carries its identity binding
      // (the validated envelope's agentExecutionId / inputContextIdentity
      // / phaseExecutionId, the graph execution id, the durable graph
      // generation, and the recorded-at timestamp) so a downstream
      // consumer can verify provenance instead of trusting file presence.
      // The agent-authored payload stays VERBATIM under `result`; the
      // provenance fields are host-derived only (never agent input).
      const wrapResult = (result) => {
        const envelope = node?.subagentEnvelope ?? null;
        return {
          schema_version: "autoloop.subagent.authored-result/v1",
          executionId: dependencyExecutionId,
          phase_id: phaseId,
          phaseExecutionId: phaseExecutionId(dependencyExecutionId, phaseId),
          agentExecutionId: envelope?.agentExecutionId ?? null,
          inputContextIdentity: envelope?.inputContextIdentity ?? null,
          graph_generation: Number.isInteger(durableGraphGeneration) ? durableGraphGeneration : 0,
          recorded_at: new Date().toISOString(),
          result,
        };
      };
      if (phase?.runtime?.mode === "subagent" && node?.subagentResult && typeof node.subagentResult === "object") {
        writeFileSync(join(resultsDir, `${phaseId}.json`), JSON.stringify(wrapResult(node.subagentResult), null, 2) + "\n");
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
function buildSubagentAdapterFactories({ profile, repoPath, scratchRoot, resultsDir, maxRepairAttempts, admission = null }) {
  return {
    executorAdapterFactory: subagentExecutorFactory({ profile, repoPath, scratchRoot, resultsDir, maxRepairAttempts, admission }),
    reviewerAdapterFactory: subagentReviewerFactory({ profile, repoPath, scratchRoot, resultsDir }),
  };
}
/**
 * Shared executor dispatcher for sub-agent graphs（routes on the phase's
 * runtime spec）— used by BOTH the raw path, the durable production path,
 * and the DE-2R resume entry.
 */
function subagentExecutorFactory({ profile, repoPath, scratchRoot, resultsDir, maxRepairAttempts, admission = null }) {
  return ({ resultSink, selectionAuthority } = {}) => {
    const roSubagent = createSubagentExecutorAdapter({ profile, repoPath, scratchRoot, resultsDir, resultSink });
    const writerSubagent = createSubagentWriterExecutorAdapter({ profile, repoPath, scratchRoot, resultsDir, resultSink, maxRepairAttempts });
    const roColima = createColimaExecutorAdapter({ profile, repoPath, scratchRoot, resultSink });
    // ── WP1-A2 PROVIDER-BACKED DISPATCH ──────────────────────────────────
    // The frozen admission is the ONLY authority that can authorize a
    // provider-backed sub-agent node: a canonical
    // admission.extensions.rollover.provider_binding routes the node's
    // execution through THE production provider adapter
    // (src/adapter/pi-rpc-adapter.mjs). The adapter-owned provider session
    // is the sole usage authority: its message_end usage surfaces as
    // metadata.providerUsage on the EXISTING node-result path
    // (captureNodeResult -> onPhaseTerminal -> observeProviderUsageAndTrigger).
    // No estimation, no synthesis, no second representation: when no
    // binding is admitted the dispatch is unchanged (container-only) and
    // providerUsage never exists.
    const providerBinding = canonicalizeProviderBinding(admission?.extensions?.rollover?.provider_binding);
    const makeProviderAdapter = (wired) => createPiRpcAdapter({
      piExecutable: process.env.PI_EXECUTABLE || "pi",
      provider: providerBinding.value.providerKind,
      model: providerBinding.value.modelId,
      environmentAllowlist: [...DEFAULT_ENV_ALLOWLIST, ...providerBinding.value.requiredEnvKeys],
      // STAGE C §7 fence preserved verbatim: the selection authority is
      // wired ONLY for a wired adapter, and a wired adapter that receives
      // a non-canonical toolPolicy fails closed before any spawn. Requests
      // without a canonical selection go to the unwired adapter and keep
      // the legacy safe default (--no-tools).
      ...(wired ? { selectionAuthority } : {}),
    });
    let wiredProviderAdapter = null;
    let bareProviderAdapter = null;
    return () => ({
      runAdapter: async (request) => {
        const rt = request.taskCard?.runtime ?? {};
        // CEDF adversarial fence（P1 repair）: a dependency-reconciliation
        // CONFLICT fail-closes EVERY consumer channel BEFORE any spawn —
        // writer, read-only sub-agent, and readonly/joinVerify colima alike.
        // The writer review channel keeps its blockingFindings seeding as
        // defense-in-depth; this gate removes the silent-chain path where
        // non-writer consumers never read envelope blockingFindings.
        if (Array.isArray(rt.dependencyConflicts) && rt.dependencyConflicts.length > 0) {
          if (process.env.WP1_DEBUG_GATE) console.error(`GATE_DEBUG ${rt.dependencyConflicts ? rt.dependencyConflicts.join(" | ") : ""}`);
          return {
            status: "error",
            executionId: request.executionId,
            error: `DEPENDENCY_CONFLICT_HOLD:${rt.dependencyConflicts.length}`,
            stdout: "",
            stderr: "",
            metadata: { dependencyConflicts: rt.dependencyConflicts },
          };
        }
        // Provider-backed backing runs BEFORE the container execution and
        // fails the node closed when the admitted provider session cannot
        // complete: a provider-backed node without its provider backing is
        // an execution failure, never a silent container-only fallback.
        let providerUsage = null;
        let providerBacked = null;
        if (providerBinding.ok && request.phase === "executor" && rt.mode === "subagent") {
          const canonicalSelection = request.toolPolicy?.contractVersion === TOOL_SELECTION_SCHEMA;
          if (canonicalSelection && wiredProviderAdapter === null) wiredProviderAdapter = makeProviderAdapter(true);
          if (!canonicalSelection && bareProviderAdapter === null) bareProviderAdapter = makeProviderAdapter(false);
          const providerResult = await (canonicalSelection ? wiredProviderAdapter : bareProviderAdapter).runAdapter(request);
          // The ONLY usage authority: the adapter-owned provider session's
          // own metadata. Agent-authored result content is never consulted.
          providerUsage = providerResult?.metadata?.providerUsage ?? null;
          providerBacked = {
            adapterKind: providerBinding.value.adapterKind,
            providerKind: providerBinding.value.providerKind,
            modelId: providerBinding.value.modelId,
            status: providerResult?.status ?? null,
          };
          if (providerResult?.status !== "completed") {
            const failResult = {
              status: "error",
              executionId: request.executionId,
              error: `PROVIDER_BACKING_FAILED:${providerResult?.status ?? "unknown"}:${String(providerResult?.error ?? "no detail").slice(0, 160)}`,
              stdout: "",
              stderr: "",
              metadata: { providerBacked, providerUsage: null },
            };
            resultSink?.(request.executionId, failResult);
            if (request.taskCard && typeof request.taskCard === "object") {
              request.taskCard.runtime = request.taskCard.runtime ?? {};
              request.taskCard.runtime.lastExecutorResult = failResult;
            }
            return failResult;
          }
        }
        const result = rt.mode === "subagent" && rt.agentRole === "writer"
          ? await writerSubagent.runAdapter(request)
          : rt.mode === "readonly"
            ? await roColima.runAdapter(request)
            : await roSubagent.runAdapter(request);
        if (providerBacked) {
          // Re-sink the MERGED result: the downstream node-result projection
          // (captureNodeResult) reads the resultSink channel, and the
          // lifecycle reviewer reads taskCard.runtime.lastExecutorResult —
          // both must observe the adapter-owned providerUsage.
          const merged = {
            ...result,
            metadata: { ...(result.metadata ?? {}), providerUsage, providerBacked },
          };
          resultSink?.(request.executionId, merged);
          if (request.taskCard && typeof request.taskCard === "object") {
            request.taskCard.runtime = request.taskCard.runtime ?? {};
            request.taskCard.runtime.lastExecutorResult = merged;
          }
          return merged;
        }
        return result;
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

export { isWriterPhase, buildSubagentGraphHooks, subagentExecutorFactory };
