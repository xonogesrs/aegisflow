// src/evolution/production-consumer.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_WIRING_REPAIR_1 — Section A/B/C/D.
//
// THE production consumer. Before this module the production wiring stopped at
// `result.evolutionObservation`: the observation was attached to the envelope
// and nothing consumed it, `runEvolutionCycle` had no production caller, and
// the durable trigger state was never written by the production path
// (AUTOLOOP_CROSS_AGENT_EVOLUTION_APPLICATION_AUDIT_1, 2026-09-24). This
// module closes exactly that gap — it introduces NO second evolution engine:
// every stage below delegates to the EXISTING trigger state machinery
// (trigger.mjs), the EXISTING loop entry (loop.mjs::runEvolutionCycle), the
// EXISTING structured lock (c2d/lock.mjs) and the EXISTING recovery
// reconciliation (recovery.mjs).
//
//   NORMAL_OPERATION (runAdmittedGraph — terminal semantics UNTOUCHED)
//     → durable evidence journal
//     → observer (production-observer.mjs) → evolutionObservation
//     → THIS MODULE (post-result, synchronous, bounded):
//         kill switch → durable trigger gate → durable trigger record
//         → in-process + cross-process single-flight
//         → SCHEDULE runEvolutionCycle (never awaited)
//     → candidate → mutation/validation → fitness → review
//     → promotion → canary
//
// Hard rules (card §A–§E):
//   - §C ISOLATION: the cycle is SCHEDULED, never awaited. The production run
//     returns its own authoritative result first; an evolution failure can
//     never turn a successful normal run into HOLD/FAIL (every path is
//     try/caught, the scheduled task cannot reject, and the run envelope is
//     never rewritten by this module).
//   - §B DURABILITY: a qualified production trigger is recorded through the
//     EXISTING durable trigger state (dedup / cooldown / window cap /
//     signature / circuit breaker) — never only on the result envelope. State
//     survives restart because the record is a durable file.
//   - §D SINGLE-FLIGHT: the same signature can have at most ONE active cycle
//     (in-process reservation + a structured exclusive lock keyed by the
//     signature hash), so mutation/commit/promotion are never duplicated.
//   - §E KILL SWITCH: AUTO_EVOLUTION=SUSPENDED (env or durable marker) stops
//     new cycles at this consumer. The observer may still observe.
//   - INERT BY DEFAULT: the consumer does nothing unless the production caller
//     declares the evolution execution inputs (`runnerOpts.evolution` /
//     AUTOLOOP_EVOLUTION_* env). An undeclared deployment is byte-identical to
//     the pre-repair behaviour.
//   - NO AUTHORITY IS WIDENED: policy preauthorization, risk classification,
//     validation, fitness, review and every promotion gate still apply
//     downstream (loop.mjs). This module only decides WHEN to ask.

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { C2dHoldError, HOLD } from "../c2d/fs-atomic.mjs";
import { readConfigEnv } from "../shared/autoloop-paths.mjs";
import { acquireStructuredLock } from "../c2d/lock.mjs";
import { collectFingerprint } from "../c2d/fingerprint.mjs";
import { readEvolutionPolicy } from "./policy.mjs";
import {
  readTriggerState, writeTriggerState, applyTriggerGates, recordTrigger,
  buildTriggerEvent, sha256Hex,
} from "./trigger.mjs";
import { evolutionSwitchState, readObservationJournal } from "./production-observer.mjs";
import { reconcileEvolutionState } from "./recovery.mjs";
import { deriveAttribution } from "./attribution.mjs";
import { canonicalTaskClass } from "./attribution.mjs";
import {
  EVOLUTION_DECLARATION_ENV, readEvolutionProductionDeclaration,
  declarationInputs, parseStrategyBaselineValues,
} from "./production-declaration.mjs";

export const EVOLUTION_CONSUMER_SCHEMA = "autoloop.evolution-consumer/v1";
export const EVOLUTION_CONSUMER_VERSION = 1;

/** Every terminal disposition the consumer reports on the production result
 *  envelope (`result.evolutionDisposition`) — §A/§B/§D/§E. The scheduled
 *  cycle's own outcome log carries a richer set (see
 *  `EVOLUTION_CONSUMER_OUTCOME_DISPOSITIONS`). */
export const EVOLUTION_CONSUMER_DISPOSITIONS = Object.freeze([
  "DISABLED",              // no evolution execution inputs declared — inert
  "NO_QUALIFIED_TRIGGER",  // no signal crossed its threshold (the common case)
  "SUSPENDED",             // kill switch (§E) — no new cycle
  "POLICY_UNAVAILABLE",    // no durable policy → the loop is OFF
  "GATED",                 // qualified, but dedup/cooldown/cap/breaker suppressed it
  "SINGLEFLIGHT",          // an identical cycle is already active (§D)
  "CYCLE_STARTED",         // durable trigger recorded; runEvolutionCycle scheduled
  "SCHEDULE_FAILED",       // the consumer failed open — no cycle (never a run failure)
]);

/** Every disposition the SCHEDULED CYCLE writes to the bounded outcome log
 *  (`evolutionConsumerState().outcomes`), which the verification drain reads. */
export const EVOLUTION_CONSUMER_OUTCOME_DISPOSITIONS = Object.freeze([
  "SINGLEFLIGHT",          // the cross-process lock was contended (§D)
  "BASELINE_UNAVAILABLE",  // no resolvable 40-hex HEAD for the target repo
  "CYCLE_COMPLETED",       // runEvolutionCycle returned a verdict (see loop_verdict)
  "CYCLE_FAILED",          // the cycle threw — recorded, never propagated (§C)
]);

/** Configuration inputs (runnerOpts.evolution / env / deployment declaration). */
export const EVOLUTION_CONFIG_ENV = Object.freeze({
  STORE_ROOT: "AEGISFLOW_EVOLUTION_STORE_ROOT",
  CHECKPOINT_ROOT: "AEGISFLOW_EVOLUTION_CHECKPOINT_ROOT",
  REPO_ROOT: "AEGISFLOW_EVOLUTION_REPO_ROOT",
  REVIEWER: "AEGISFLOW_EVOLUTION_REVIEWER",
  TASK_CLASS: "AEGISFLOW_EVOLUTION_TASK_CLASS",
  PROMPT_PROFILE: "AEGISFLOW_EVOLUTION_PROMPT_PROFILE",
  STRATEGY_DIMENSIONS: "AEGISFLOW_EVOLUTION_STRATEGY_DIMENSIONS",
  STRATEGY_BASELINE_VALUES: "AEGISFLOW_EVOLUTION_STRATEGY_BASELINE_VALUES",
  SYNTHETIC: "AEGISFLOW_EVOLUTION_SYNTHETIC",
  // §J.2: the deployment declaration record (storeRoot / checkpointRoot /
  // repoRoot / taskClass / strategyBaselineValues) — a PATH supplied by the
  // deployment, never a machine-specific constant in source.
  DEPLOYMENT_CONFIG: EVOLUTION_DECLARATION_ENV,
});

// ── Module state (per process; observability + in-process single-flight) ────

/** key → scheduled promise (in-process single-flight, §D). */
const ACTIVE = new Map();
/** Every in-flight scheduled cycle. */
const PENDING = new Set();
/** Bounded, newest-last cycle outcome summaries (operator/verification view). */
const OUTCOMES = [];
const MAX_OUTCOMES = 64;
/** Store roots already reconciled in THIS process (crash recovery, §crash). */
const RECONCILED = new Set();

function rememberOutcome(entry) {
  OUTCOMES.push(entry);
  while (OUTCOMES.length > MAX_OUTCOMES) OUTCOMES.shift();
}

// ── §A configuration ───────────────────────────────────────────────────────

function envValue(env, key) {
  const resolved = readConfigEnv(env, key);
  return resolved ? resolved.value.trim() : null;
}

function cfgValue(cfg, env, key, envKey) {
  const v = cfg?.[key];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return envValue(env, envKey);
}

/**
 * Resolve the evolution execution inputs for ONE production run.
 *
 * The consumer is INERT unless the production caller declares ALL of
 * storeRoot / checkpointRoot / repoRoot — through (highest precedence first)
 * an explicit `runnerOpts.evolution` object, the `AUTOLOOP_EVOLUTION_*`
 * environment, or the deployment's declaration record
 * (`AEGISFLOW_EVOLUTION_DEPLOYMENT_CONFIG` → production-declaration.mjs §J.2).
 * `reviewerIdentity` is OPTIONAL: without an operator-designated independent
 * reviewer the cycle still runs (mutation + fitness) but the promotion gate
 * fails closed — the loop never self-approves.
 *
 * `strategyBaselineValues` (the strategy each task class currently runs under,
 * per dimension) is a FIRST-CLASS production input: the caller object, the
 * `AEGISFLOW_EVOLUTION_STRATEGY_BASELINE_VALUES` JSON variable, or the
 * declaration record. An invalid value is IGNORED and reported
 * (`strategyBaselineValuesError`) — never silently reinterpreted.
 */
export function resolveEvolutionProductionConfig({ runnerOpts = {}, env = process.env } = {}) {
  const cfg = runnerOpts?.evolution && typeof runnerOpts.evolution === "object" ? runnerOpts.evolution : {};
  // §J.2: read the deployment declaration BEFORE resolving the keys so the
  // record is the deployment DEFAULT and the explicit surfaces override it.
  const declaration = readEvolutionProductionDeclaration({
    path: cfgValue(cfg, env, "deploymentConfig", EVOLUTION_DECLARATION_ENV),
    env,
  });
  const decl = declarationInputs(declaration.declaration);
  const pick = (key, envKey) => cfgValue(cfg, env, key, envKey) ?? (typeof decl[key] === "string" ? decl[key] : null);

  const storeRoot = pick("storeRoot", EVOLUTION_CONFIG_ENV.STORE_ROOT);
  const checkpointRoot = pick("checkpointRoot", EVOLUTION_CONFIG_ENV.CHECKPOINT_ROOT);
  const repoRoot = pick("repoRoot", EVOLUTION_CONFIG_ENV.REPO_ROOT);
  const reviewerIdentity = pick("reviewerIdentity", EVOLUTION_CONFIG_ENV.REVIEWER);
  const taskClassRaw = pick("taskClass", EVOLUTION_CONFIG_ENV.TASK_CLASS);
  const promptProfile = pick("promptProfile", EVOLUTION_CONFIG_ENV.PROMPT_PROFILE);

  // Dimensions: explicit array > comma-separated env > declaration.
  const dimsEnv = envValue(env, EVOLUTION_CONFIG_ENV.STRATEGY_DIMENSIONS);
  const strategyDimensions = Array.isArray(cfg.strategyDimensions) && cfg.strategyDimensions.length > 0
    ? cfg.strategyDimensions
    : (dimsEnv ? dimsEnv.split(",").map((d) => d.trim()).filter(Boolean) : (decl.strategyDimensions ?? null));

  // The strategy each task class is CURRENTLY running under, per dimension.
  // Without this the producer falls back to "most-observed value", which is
  // ambiguous when two strategies have comparable sample counts — so a
  // deployment that knows its current strategy SHOULD declare it.
  const baselineCandidate = (cfg.strategyBaselineValues && typeof cfg.strategyBaselineValues === "object")
    ? { values: cfg.strategyBaselineValues, error: null }
    : (envValue(env, EVOLUTION_CONFIG_ENV.STRATEGY_BASELINE_VALUES)
      ? parseStrategyBaselineValues(envValue(env, EVOLUTION_CONFIG_ENV.STRATEGY_BASELINE_VALUES))
      : { values: decl.strategyBaselineValues ?? null, error: null });
  const strategyBaselineValues = baselineCandidate.values ?? null;

  const syntheticEnv = String(envValue(env, EVOLUTION_CONFIG_ENV.SYNTHETIC) ?? "").toLowerCase();
  const synthetic = cfg.synthetic === true || decl.synthetic === true || syntheticEnv === "1" || syntheticEnv === "true";

  const missing = [];
  if (!storeRoot) missing.push("storeRoot");
  if (!checkpointRoot) missing.push("checkpointRoot");
  if (!repoRoot) missing.push("repoRoot");
  return {
    enabled: missing.length === 0,
    missing,
    storeRoot,
    checkpointRoot,
    repoRoot,
    reviewerIdentity,
    taskClass: taskClassRaw === null ? null : canonicalTaskClass(taskClassRaw),
    promptProfile,
    strategyDimensions,
    strategyBaselineValues,
    strategyBaselineValuesError: baselineCandidate.error ?? null,
    synthetic,
    declaration: {
      provided: declaration.provided,
      path: declaration.path,
      source: declaration.source,
      errors: declaration.errors,
    },
    reviewVerdict: typeof cfg.reviewVerdict === "string" && cfg.reviewVerdict.length > 0 ? cfg.reviewVerdict : "PASS",
    canaryWindowMs: Number.isFinite(cfg.canaryWindowMs) ? cfg.canaryWindowMs : (Number.isFinite(decl.canaryWindowMs) ? decl.canaryWindowMs : undefined),
    thresholds: cfg.thresholds && typeof cfg.thresholds === "object" ? cfg.thresholds : (decl.thresholds ?? {}),
    env,
  };
}

// ── §A/§B/§D/§E the production consumption entry ───────────────────────────

function disposition(config, name, extra = {}) {
  return {
    schema: EVOLUTION_CONSUMER_SCHEMA,
    version: EVOLUTION_CONSUMER_VERSION,
    at: new Date().toISOString(),
    disposition: name,
    cycle_started: name === "CYCLE_STARTED",
    store_root: config?.storeRoot ?? null,
    enabled: config?.enabled === true,
    ...extra,
  };
}

/**
 * Consume ONE production evolution observation (§A) — SYNCHRONOUS and
 * bounded: it writes the durable trigger record, reserves single-flight and
 * SCHEDULES the cycle. It never awaits, never throws, and never rewrites the
 * caller's result.
 *
 * @param {object} p
 * @param {object} p.observation — observeRunForEvolutionTriggers output
 * @param {object} p.config — resolveEvolutionProductionConfig output
 * @param {string} [p.evidenceRoot] — the run's durable evidence root (journal)
 * @param {string} [p.executionId] — the run's durable execution id
 * @param {string} [p.graphRunId]
 * @param {object} [p.attribution] — the attribution derived by THE every-run
 *   evidence feed (attribution-feed.mjs §A). When present it is REUSED here so
 *   the loop's plan inputs come from the same derivation the observation was
 *   built from. When absent (a standalone caller) the consumer derives one for
 *   the loop — it NEVER writes the strategy memory: the memory write belongs to
 *   the feed, which runs for EVERY eligible run, not only for firing triggers.
 * @param {object} [p.attributionFeed] — the feed disposition record (envelope
 *   observability; never an authority)
 * @returns {object} disposition record (also worth attaching to the envelope)
 */
export function consumeEvolutionObservationForProduction({
  observation = null, config = null, evidenceRoot = null, executionId = null, graphRunId = null,
  admission = null, attribution = null, attributionFeed = null,
} = {}) {
  try {
    if (!config?.enabled) {
      return disposition(config, "DISABLED", { reason: `evolution execution inputs not declared: ${(config?.missing ?? ["config"]).join(",")}` });
    }
    // §E kill switch — BEFORE reading anything else, so a suspended deployment
    // reports the truth (`SUSPENDED`) rather than "no trigger". The observer
    // already resolved it for this run; only a standalone call pays the stat.
    const sw = observation?.switch_state ?? evolutionSwitchState({ env: config.env ?? process.env, storeRoot: config.storeRoot });
    if (sw?.state === "SUSPENDED") {
      return disposition(config, "SUSPENDED", {
        fired_count: Array.isArray(observation?.fired) ? observation.fired.length : 0,
        reason: sw.reason ?? "AUTO_EVOLUTION=SUSPENDED",
      });
    }
    const fired = Array.isArray(observation?.fired) ? observation.fired : [];
    if (fired.length === 0) {
      return disposition(config, "NO_QUALIFIED_TRIGGER", { fired_count: 0 });
    }

    // The loop is OFF without a durable policy — fail closed before any write.
    let policy;
    try {
      policy = readEvolutionPolicy(config.storeRoot);
    } catch (e) {
      return disposition(config, "POLICY_UNAVAILABLE", { fired_count: fired.length, reason: String(e?.message ?? e).slice(0, 200) });
    }

    // §B durable trigger state — THE existing machinery, persisted here (the
    // production path, not just the result envelope). Gate signals one at a
    // time so only the signal actually acted on consumes its cooldown/window
    // slot; every suppressed signal is reported (not silently dropped).
    let state = readTriggerState(config.storeRoot);
    let chosen = null;
    const suppressed = [];
    for (const signal of fired) {
      const gated = applyTriggerGates({ fired: [signal], state });
      state = gated.state;
      if (gated.allowed.length > 0) { chosen = gated.allowed[0]; break; }
      suppressed.push({ signal_class: signal?.signalClass ?? null, reason: gated.suppressed[0]?.reason ?? "gated" });
    }
    if (!chosen) {
      return disposition(config, "GATED", {
        fired_count: fired.length, suppressed_count: suppressed.length, suppressed,
      });
    }
    const triggerEvent = buildTriggerEvent({
      signal: chosen,
      executionId: executionId ?? null,
      graphRunId: graphRunId ?? null,
      source: "autoloop.evolution-production-consumer",
      thresholdPolicyDigest: policy.policy_digest,
    });
    state = recordTrigger(state, triggerEvent);
    writeTriggerState(config.storeRoot, state);

    // §D single-flight — in-process reservation first, then the cross-process
    // structured lock (forensic orphan reclaim built in: a crashed holder is
    // reclaimed by host + dead-PID + age classification).
    const key = `${config.storeRoot}\u0000${triggerEvent.signature}`;
    if (ACTIVE.has(key)) {
      return disposition(config, "SINGLEFLIGHT", {
        fired_count: fired.length, trigger_id: triggerEvent.trigger_id,
        signature: triggerEvent.signature, reason: "an identical evolution cycle is already active in this process",
      });
    }
    ACTIVE.set(key, null); // reserve BEFORE scheduling (sync section is race-free)
    let scheduled;
    try {
      scheduled = scheduleCycle({
        config, key, triggerEvent, evidenceRoot, executionId, graphRunId, admission,
        attribution,
      });
    } catch (e) {
      ACTIVE.delete(key);
      return disposition(config, "SCHEDULE_FAILED", {
        fired_count: fired.length, trigger_id: triggerEvent.trigger_id,
        signature: triggerEvent.signature, signal_class: triggerEvent.signal_class,
        reason: `schedule failed: ${String(e?.message ?? e).slice(0, 200)}`,
      });
    }
    ACTIVE.set(key, scheduled);
    return disposition(config, "CYCLE_STARTED", {
      fired_count: fired.length,
      signal_class: triggerEvent.signal_class,
      signature: triggerEvent.signature,
      trigger_id: triggerEvent.trigger_id,
      policy_id: policy.policy_id,
      reviewer_configured: Boolean(config.reviewerIdentity),
      suppressed_count: suppressed.length,
      // §A/§G: the attribution observation was recorded by the every-run feed
      // (BEFORE the trigger was evaluated), independent of this cycle.
      attribution_disposition: attributionFeed?.disposition ?? null,
      attribution_recorded: attributionFeed?.recorded === true,
    });
  } catch (e) {
    // §C fail-open: evolution wiring failure is NEVER a run failure.
    return disposition(config, "SCHEDULE_FAILED", {
      reason: `consumer failed open: ${String(e?.message ?? e).slice(0, 200)}`,
    });
  }
}

// ── §C the scheduled (never awaited) cycle ─────────────────────────────────

function gitOut(repoRoot, args) {
  const r = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? String(r.stdout ?? "").trim() : null;
}

function cycleLockPath(storeRoot, signature) {
  return join(storeRoot, "evolution-cycles", `sig-${sha256Hex(signature).slice(0, 32)}.lock`);
}

/** Crash recovery is best-effort and ONCE per store per process (fail-open:
 *  the loop still fails closed per stage on its own). */
function reconcileOnce(config) {
  if (RECONCILED.has(config.storeRoot)) return;
  RECONCILED.add(config.storeRoot);
  try {
    reconcileEvolutionState({ repoRoot: config.repoRoot, storeRoot: config.storeRoot });
  } catch { /* recovery is best-effort; never a run failure */ }
}

function summarizeCycle(result) {
  return {
    loop_verdict: result?.loop_verdict ?? null,
    hold_code: result?.hold_code ?? null,
    stage: result?.stage ?? null,
    candidate_id: result?.candidate_id ?? null,
    branch: result?.branch ?? null,
    candidate_kind: result?.candidate_kind ?? null,
    strategy_activation: result?.strategy_activation ?? null,
    fitness_digest: result?.fitness_digest ?? null,
    canary: result?.canary ?? null,
    reason: result?.reason ? String(result.reason).slice(0, 300) : null,
  };
}

function scheduleCycle({ config, key, triggerEvent, evidenceRoot, executionId, graphRunId, admission = null, attribution = null }) {
  const signature = triggerEvent.signature;
  const lockPath = cycleLockPath(config.storeRoot, signature);
  // Affinity fields MUST be identical for every acquirer of the SAME signature
  // (contention → LOCK_ACTIVE) and distinct per signature (distinct paths).
  const sigHash = sha256Hex(signature).slice(0, 32);
  const lockIdentity = {
    lock_kind: "evolution_cycle",
    execution_id: `evolution-cycle:${sigHash}`,
    checkpoint_id: "evolution",
    chain_id: "evolution",
    lease_id: "none",
    lease_revision: 0,
    actor_id: String(executionId ?? "unknown-execution").slice(0, 120),
    session_id: String(graphRunId ?? "unknown-run").slice(0, 120),
    repository_identity: `evolution-store:${config.storeRoot}`,
    worktree_identity: `evolution-signature:${sigHash}`,
    expected_head: "none",
  };

  const task = (async () => {
    // Yield FIRST: the recycle/lock/journal work below is synchronous until the
    // loop's own awaits, and the consumer is called from the production
    // post-result path. Deferring to the next macrotask guarantees the run's
    // terminal handling completes with ZERO evolution work on its stack.
    await new Promise((resolve) => setImmediate(resolve));
    const base = { at: new Date().toISOString(), signature, trigger_id: triggerEvent.trigger_id, signal_class: triggerEvent.signal_class };
    let lock = null;
    try {
      reconcileOnce(config);

      // Cross-process single-flight (§D): a contended signature records a
      // skipped outcome and starts NO second cycle, mutation, commit or
      // promotion. Orphaned locks are reclaimed by the shared lock primitive.
      try {
        lock = acquireStructuredLock(lockPath, lockIdentity);
      } catch (e) {
        const busy = e instanceof C2dHoldError && (e.code === HOLD.LOCK_ACTIVE || e.code === HOLD.LOCK_AFFINITY_MISMATCH || e.code === HOLD.LOCK_RECORD_CORRUPT);
        const entry = { ...base, disposition: "SINGLEFLIGHT", reason: String(e?.code ?? e?.message ?? e).slice(0, 200), busy };
        rememberOutcome(entry);
        return entry;
      }

      // The run's REAL durable evidence is the fitness baseline side. ONE
      // shared reader (production-observer.mjs) — no second journal contract.
      const journal = readObservationJournal({ evidenceRoot, executionId });

      // §A (EVIDENCE FEED REPAIR): the attribution + strategy-memory write now
      // happen in the every-run feed (attribution-feed.mjs), which runs in the
      // production POST-RESULT path for EVERY eligible run — BEFORE the trigger
      // is evaluated and independently of whether a cycle is scheduled. This
      // scheduler therefore no longer records observations (a memory write
      // behind a fired trigger was the deficient-run selection bias).
      //
      // The feed hands its derivation down here so the loop's plan inputs come
      // from the SAME attribution the observation was built from. A standalone
      // caller that supplied none gets a derivation for the loop's inputs only
      // (still no memory write — the memory belongs to the feed).
      let cycleAttribution = attribution;
      if (!cycleAttribution) {
        try {
          cycleAttribution = deriveAttribution({
            events: journal.events,
            admittedBinding: admission?.extensions?.rollover?.provider_binding ?? null,
            taskClass: config.taskClass,
            executionId,
            graphRunId,
            admissionId: admission?.admission_id ?? null,
            promptProfile: config.promptProfile,
          });
        } catch { cycleAttribution = null; /* attribution is advisory evidence; never a run failure */ }
      }

      const baselineHead = gitOut(config.repoRoot, ["rev-parse", "HEAD"]);
      if (!/^[0-9a-f]{40}$/.test(baselineHead ?? "")) {
        const entry = { ...base, disposition: "BASELINE_UNAVAILABLE", reason: `cannot resolve a 40-hex HEAD for ${config.repoRoot}`, cycle: null };
        rememberOutcome(entry);
        return entry;
      }
      const revisionCount = gitOut(config.repoRoot, ["rev-list", "--count", "HEAD"]);
      const baselineRevision = Number.parseInt(revisionCount ?? "", 10);

      // The loop (and with it the C3B mutation/worktree machinery) is loaded
      // LAZILY and only here: the producer path that merely OBSERVES must not
      // link the mutation subsystem into admission (same convention as
      // runCandidateMutation's dynamic runMutation import).
      const { runEvolutionCycle } = await import("./loop.mjs");
      const result = await runEvolutionCycle({
        repoRoot: config.repoRoot,
        policyRoot: config.storeRoot,
        checkpointRoot: config.checkpointRoot,
        baselineHead,
        baselineRevision: Number.isInteger(baselineRevision) && baselineRevision > 0 ? baselineRevision : 1,
        baselineEvents: journal.events,
        fingerprint: collectFingerprint(config.repoRoot),
        // The pre-gated, durably recorded production trigger (§A/§B): the loop
        // does NOT re-derive or re-gate it (that would double-record).
        triggerEvent,
        // §B/§I: the loop's plan/diagnosis inputs. NO plan is passed in — the
        // natural plan producer derives one from the attributed evidence and
        // the strategy memory. A hand-fed patchPlan is never required.
        attribution: cycleAttribution,
        taskClass: config.taskClass,
        strategyDimensions: config.strategyDimensions ?? undefined,
        strategyBaselineValues: config.strategyBaselineValues ?? undefined,
        reviewerIdentity: config.reviewerIdentity ?? null,
        reviewVerdict: config.reviewVerdict,
        canaryWindowMs: config.canaryWindowMs,
        env: config.env ?? process.env,
      });
      const entry = { ...base, disposition: "CYCLE_COMPLETED", loop_verdict: result?.loop_verdict ?? null, cycle: summarizeCycle(result) };
      rememberOutcome(entry);
      return entry;
    } catch (e) {
      // §C: an evolution failure is recorded and observable, never propagated.
      const entry = {
        ...base, disposition: "CYCLE_FAILED", loop_verdict: null,
        reason: String(e?.code ?? e?.message ?? e).slice(0, 300),
        cycle: { hold_code: String(e?.code ?? ""), reason: String(e?.message ?? e).slice(0, 300) },
      };
      rememberOutcome(entry);
      return entry;
    } finally {
      if (lock) { try { lock.release(); } catch { /* foreign/lost lock: nothing this process may release */ } }
      ACTIVE.delete(key);
    }
  })();

  // The task never rejects (every path is caught), but attach a defensive
  // catch so a future edit can never surface an unhandled rejection into the
  // production run's process.
  task.catch(() => {});
  PENDING.add(task);
  task.then(() => { PENDING.delete(task); }, () => { PENDING.delete(task); });
  return task;
}

// ── Verification / operator view (read-only) ────────────────────────────────

/** Await every scheduled cycle (bounded). Production NEVER awaits; this is the
 *  verification/Operator drain — same read-only spirit as the observer. */
export async function drainEvolutionCycles({ timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (PENDING.size > 0 && Date.now() < deadline) {
    const batch = [...PENDING];
    const remaining = Math.max(1, deadline - Date.now());
    let timer;
    await Promise.race([
      Promise.allSettled(batch),
      new Promise((resolve) => { timer = setTimeout(resolve, remaining); if (typeof timer.unref === "function") timer.unref(); }),
    ]);
    clearTimeout(timer);
  }
  return evolutionConsumerState();
}

/** Read-only consumer state (pending tasks + bounded cycle outcomes). */
export function evolutionConsumerState() {
  return {
    schema: EVOLUTION_CONSUMER_SCHEMA,
    version: EVOLUTION_CONSUMER_VERSION,
    pending: PENDING.size,
    active_signatures: [...ACTIVE.keys()].map((k) => k.split("\u0000").slice(1).join("\u0000")),
    reconciled_stores: [...RECONCILED],
    outcomes: [...OUTCOMES],
  };
}
