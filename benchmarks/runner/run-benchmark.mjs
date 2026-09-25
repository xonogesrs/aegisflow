#!/usr/bin/env node
// benchmarks/runner/run-benchmark.mjs
//
// AegisFlow effectiveness benchmark — the runner.
//
// Compares three arms on the same tasks, the same agent runtime, the same
// provider route and the same acceptance criteria:
//
//   CONTROL           strategy/evolution features OFF
//   AUTOLOOP_FRESH    treatment ON, no accumulated strategy memory (T0)
//   AUTOLOOP_LEARNED  treatment ON, after a learning period (T1)
//
// Every run is a REAL AegisFlow execution: a frozen admission record, a
// projected per-node tool selection, a real `pi` agent subprocess with exactly
// the admitted tools, harness-run acceptance tests, and a harness-derived
// success verdict (the test exit code, never the model's opinion).
//
// WHAT "STRATEGY FEATURES" MEANS HERE
//   MODEL_ROUTING      an active strategy preference selects the provider route
//   RETRY_REPAIR       an active strategy preference sets the repair budget
//   RETRY_REPAIR       an active strategy preference sets the repair budget
// CONTROL uses the deployment default route and a fixed repair budget.
//
// MODEL_ROUTING and TOOL_SELECTION preferences are recorded in the store but
// are NOT consumed by this runner, deliberately:
//   - MODEL_ROUTING: every arm is pinned to one route (BENCH_ROUTE) so no arm
//     gets a model the others cannot reach. Measuring a routing effect needs
//     two reachable routes and its own comparison (see docs/benchmark.md §6).
//   - TOOL_SELECTION: narrowing one arm's tool subset would change the
//     resources available to it, which is exactly what resource parity
//     forbids. The store still observes the value so the dimension is visible.
//
// Usage:
//   node benchmarks/runner/run-benchmark.mjs --arm CONTROL --runs 5
//   node benchmarks/runner/run-benchmark.mjs --arm AUTOLOOP_FRESH --runs 5
//   node benchmarks/runner/run-benchmark.mjs --all --runs 5
//   node benchmarks/runner/run-benchmark.mjs --all --runs 5 --task 01-... 
//
// Output: benchmarks/results/<arm>.jsonl  (one JSON object per run)
//         benchmarks/results/manifest.json (environment + configuration identity)
//
// The route and model actually used are recorded per run, so a reader can
// verify the arms were not given different resources.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const TASKS_DIR = join(REPO, "benchmarks", "tasks");
const RESULTS_DIR = join(REPO, "benchmarks", "results");

const { buildAdmissionRecord, projectToolSelection, buildAdmissionRecordWithStrategy } = await import(
  join(REPO, "src", "admission", "policy-projection.mjs")
);
const { freezeAdmission } = await import(join(REPO, "src", "admission", "admission-record.mjs"));
const { classify, scanRiskSignals } = await import(join(REPO, "src", "admission", "classify.mjs"));
const { buildPhaseTaskCard, phaseExecutionId } = await import(join(REPO, "src", "v2", "phase-task-card.mjs"));
const { captureScopeSnapshot } = await import(join(REPO, "src", "c2d", "mutation-scope.mjs"));
const { createPiRpcAdapter, DEFAULT_ENV_ALLOWLIST } = await import(join(REPO, "src", "adapter", "pi-rpc-adapter.mjs"));
const { runLifecycle } = await import(join(REPO, "src", "lifecycle-runner.mjs"));
const { digestOf } = await import(join(REPO, "src", "canonical-digest.mjs"));
const routing = await import(join(REPO, "src", "evolution", "strategy-routing.mjs"));
const strategyStore = await import(join(REPO, "src", "evolution", "strategy-store.mjs"));
const { createLifecycleSelectionAuthority, frozenRuntimeIdentity, FROZEN_RUNTIME_VOCABULARY_DIGEST } = await import(
  join(REPO, "src", "admission", "policy-projection.mjs")
);

// ── Arms ───────────────────────────────────────────────────────────────────

export const ARMS = Object.freeze(["CONTROL", "AUTOLOOP_FRESH", "AUTOLOOP_LEARNED"]);

/**
 * Arm labels that are not compared directly but produce a sample the strategy
 * memory learns from. A LEARNING_PERIOD run is a CONTROL run under an
 * exploration override: it exists to give the fitness gate alternative values
 * to compare, and it is never reported as a treatment arm beside the others.
 */
export const LEARNING_ARM = "LEARNING_PERIOD";

const STRATEGY_FEATURES_ON = (arm) => arm !== "CONTROL" && arm !== LEARNING_ARM;

/**
 * The provider route for one run.
 *
 * CONTROL takes the deployment default. The treatment arms consult the
 * strategy store — which is EMPTY for AUTOLOOP_FRESH and populated for
 * AUTOLOOP_LEARNED — through the same production seam a deployment uses
 * (`resolveProductionRoute`). If the store holds no preference, the seam falls
 * back to the default, so the two treatment arms differ only by what has been
 * learned.
 */
function routeForArm(arm, { taskClass, storeRoot }) {
  const explicit = explicitRouteFromEnv();
  if (explicit) {
    // Every arm uses the SAME explicit route when one is configured: a
    // benchmark must never give treatment a model control cannot reach.
    return { route: explicit.route, binding: explicit.binding, source: "EXPLICIT" };
  }
  if (!STRATEGY_FEATURES_ON(arm)) return { ...routing.defaultRoute(), source: "ARM_DEFAULT" };
  const resolved = strategyStore.resolveProductionRoute({ storeRoot, taskClass, explicitBinding: null, allowlist: null });
  return resolved;
}

/**
 * The provider route used by this benchmark environment.
 *
 * Set BENCH_ROUTE=provider/model to pin it. When unset, the harness probes the
 * default route and falls back to any other supported route that answers, so a
 * deployment whose default route has no credit can still benchmark honestly —
 * with both arms pinned to the SAME route, recorded in the manifest.
 */
function explicitRouteFromEnv() {
  const v = process.env.BENCH_ROUTE;
  if (typeof v !== "string" || v.length === 0) return null;
  if (!routing.isSupportedRouteValue(v)) {
    throw new Error(`BENCH_ROUTE=${v} is not a supported capability row: ${routing.SUPPORTED_ROUTE_VALUES.join(", ")}`);
  }
  return routing.selectRouteForTaskClass({ strategyPreference: v });
}

/**
 * Repair budget per run (RETRY_REPAIR strategy dimension).
 *
 * Resolution order — each step is a *mechanism*, not a hardcoded benchmark value:
 *
 *   1. BENCH_REPAIR_ATTEMPTS  an explicit exploration override. This is the
 *      LEARNING PERIOD: a deployment samples alternative strategy values so the
 *      fitness gate has something to compare. Without it the memory only ever
 *      observes the current value and can never propose a change.
 *   2. the arm's strategy store preference — what AUTOLOOP_LEARNED actually
 *      reads. Empty store ⇒ no preference ⇒ step 3.
 *   3. 0 (the deployment default for CONTROL and for an empty-store arm).
 */
function maxRepairAttemptsForArm(arm, { taskClass, storeRoot, exploration }) {
  if (exploration !== null && exploration !== undefined) return exploration;
  if (!STRATEGY_FEATURES_ON(arm)) return 0;
  const pref = strategyStore.resolveStrategyPreference({ storeRoot, taskClass, dimension: "RETRY_REPAIR" });
  if (!pref) return 0; // no learned preference yet — identical to control
  // The bounded parameter schema for RETRY_REPAIR is `max_attempts` (see
  // BOUNDED_STRATEGY_PARAMS in src/evolution/strategy-store.mjs) — reading a
  // differently-named field silently yielded the default and made a learned
  // preference unobservable.
  const n = pref.params?.max_attempts;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// ── Fixture ────────────────────────────────────────────────────────────────

function materialiseFixture(task, parentDir) {
  const dir = mkdtempSync(join(parentDir, `bench-${task.task_id}-`));
  for (const [rel, content] of Object.entries(task.fixture.files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "bench@autoloop.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "bench"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "fixture baseline"], { cwd: dir });
  return dir;
}

/** The task prompt handed to the agent. */
function promptFor(task) {
  return [
    "You are an autonomous coding agent working in a git repository at the current working directory.",
    "",
    "TASK:",
    task.instruction,
    "",
    "RULES:",
    "- Use the file-editing tools to change files on disk. Do not merely describe the change.",
    "- Change only the files the task says you may change.",
    "- When you are done, the acceptance test command must exit 0:",
    `    ${task.acceptance.test_command.join(" ")}`,
    "- Do not modify the test file.",
    "",
    "When the task is complete, reply with a single line: BENCH_DONE",
  ].join("\n");
}

// ── One run ────────────────────────────────────────────────────────────────

async function runOnce({ task, arm, runIndex, storeRoot, scratchParent, route, exploration = null }) {
  const started = process.hrtime.bigint();
  const repo = materialiseFixture(task, scratchParent);
  const executionId = `exec_bench_${createHash("sha256").update(`${task.task_id}|${arm}|${runIndex}|${Date.now()}`).digest("hex").slice(0, 24)}`;
  const record = {
    schema: "autoloop.benchmark-run/v1",
    task_id: task.task_id,
    task_class: task.task_class,
    arm,
    run_index: runIndex,
    execution_id: executionId,
    route: route.route,
    route_source: route.source,
    started_at: new Date().toISOString(),
  };

  try {
    // ── Admission (the same construction for every arm) ───────────────────
    // Real code-writing work needs the writer capability, which the classifier
    // grants only above the FAST_PATH tier. These scores describe the task
    // truthfully (it edits source files and must satisfy a suite) and are
    // IDENTICAL for every arm — the classification is not a variable.
    const dimensionScores = {
      affected_files: { score: Math.max(4, Math.min(3, task.fixture.expected_changed_paths.length)), reasons: ["source files must change"] },
      affected_subsystems: { score: 3, reasons: ["implementation area"] },
      dependency_depth: { score: 1, reasons: ["module-local dependency"] },
      ambiguity: { score: 1, reasons: ["contract stated, approach open"] },
      expected_execution_steps: { score: 3, reasons: ["multiple edits plus verification"] },
      verification_burden: { score: 3, reasons: ["acceptance suite must pass"] },
      external_dependencies: { score: 0, reasons: ["none"] },
      concurrency_potential: { score: 0, reasons: ["single writer"] },
      statefulness: { score: 0, reasons: ["stateless"] },
      rollback_complexity: { score: 1, reasons: ["revert edited files"] },
    };
    const classification = classify({ dimensionScores, riskSignals: scanRiskSignals(task.instruction) });
    const admission = freezeAdmission(buildAdmissionRecord({
      taskId: task.task_id,
      classification,
      mutationScope: [...task.fixture.expected_changed_paths],
    }));
    record.admission_id = admission.admission_id;
    record.risk = admission.risk;

    // ── Allocation ─────────────────────────────────────────────────────────
    // Static and identical per task for every arm: the arms differ only in the
    // strategy features being measured, never in the resources granted.
    const allocation = {
      taskId: task.task_id,
      admissionId: admission.admission_id,
      dimensions: {
        node_execution_count: 4, repair_attempt_count: 1, retry_count: 2,
        sub_agent_execution_count: 0, verifier_reviewer_attempts: 1, wall_clock_ms: 300_000,
      },
    };
    allocation.allocationId = digestOf({
      taskId: allocation.taskId, admissionId: allocation.admissionId, dimensions: allocation.dimensions,
    });

    // ── Phase card (built FIRST: it owns the phase execution identity) ────
    const phase = {
      phase_id: "P1",
      title: task.title,
      summary: task.instruction,
      responsibility: task.title,
      purpose: "implementation",
      effects: {
        artifact_mutation: "required",
        runtime_side_effect: "forbidden",
        external_system_mutation: "forbidden",
        evidence_output: "persistent",
        boundaries: { artifact: [...task.fixture.expected_changed_paths], runtime: [], external_system: [], evidence: [] },
      },
      covers: [{ requirement_id: "R1", completeness: "complete", claim: "task implemented" }],
      depends_on: [],
    };
    const card = buildPhaseTaskCard({
      phase,
      parent: { scope: { allowed_paths: [...task.fixture.expected_changed_paths], forbidden_paths: [] } },
      executionId,
      cwd: repo,
      maxRepairAttempts: maxRepairAttemptsForArm(arm, { taskClass: task.task_class, storeRoot, exploration }),
    });
    record.max_repair_attempts = card.maxRepairAttempts;
    record.phase_execution_id = card.executionId;

    // ── Tool selection: the production selector, minted for THIS card ─────
    // The tools the agent may use are DERIVED from the admission, never chosen
    // by the benchmark. The selection is minted against the card's phase
    // execution identity because that is what the adapter re-validates against
    // before any tool name reaches argv.
    const selectionAuthority = createLifecycleSelectionAuthority({ admission, taskAllocation: allocation });
    const selection = projectToolSelection({
      admission,
      nodeRole: "writer",
      taskAllocation: allocation,
      runtimeIdentity: frozenRuntimeIdentity(),
      runtimeVocabularyDigest: FROZEN_RUNTIME_VOCABULARY_DIGEST,
      executionId: card.executionId,
    });
    record.tool_selection = selection.canonicalToolIds;
    record.adapter_tools = selection.adapterToolNames;
    record.selection_basis = selection.selectionBasis;

    card.toolPolicy = selection;
    card.verificationCommand = task.acceptance.test_command;
    card.environmentAllowlist = [...DEFAULT_ENV_ALLOWLIST, ...PROVIDER_ENV_KEYS(route.route)];
    card.expectedExecutorModel = modelOf(route.route);
    card.expectedExecutorProvider = providerOf(route.route);
    card.expectedReviewerModel = modelOf(route.route);
    card.mutationScope = {
      repositoryRoot: repo,
      baselineSnapshot: captureScopeSnapshot(repo),
      allowedPaths: [...task.fixture.expected_changed_paths],
      forbiddenPaths: [],
    };

    // Record the raw adapter results: a benchmark that hides why a run failed
    // is not evidence. Only bounded, secret-free metadata is kept.
    const adapterTrace = [];
    const traced = (adapter, role) => ({
      runAdapter: async (req) => {
        const res = await adapter.runAdapter(req);
        adapterTrace.push({
          role,
          status: res.status,
          error: res.error ?? null,
          terminalReason: res.metadata?.terminalReason ?? null,
          toolSelection: res.metadata?.toolSelection ?? null,
          argvTools: (res.metadata?.args ?? []).filter((a) => /^(--tools|--no-tools)$/.test(a) || a.includes(",")),
          providerUsage: res.metadata?.providerUsage ?? null,
          stdoutHead: typeof res.stdout === "string" ? res.stdout.slice(0, 400) : null,
          stderrHead: typeof res.stderr === "string" ? res.stderr.slice(0, 400) : null,
        });
        return res;
      },
    });

    // `selectionAuthority` is what lets the adapter authenticate the selection
    // it was handed; without it the adapter fails closed to --no-tools. The
    // reviewer deliberately gets NO selectionAuthority: its tool policy is
    // hard-pinned to no-tools, so a reviewer can never mutate anything.
    const adapterEnv = [...DEFAULT_ENV_ALLOWLIST, ...PROVIDER_ENV_KEYS(route.route)];
    const executorAdapter = createPiRpcAdapter({
      piExecutable: (process.env.AEGISFLOW_PI_RUNTIME_PATH ?? process.env.AUTOLOOP_PI_RUNTIME_PATH) || "pi",
      provider: providerOf(route.route),
      model: modelOf(route.route),
      environmentAllowlist: adapterEnv,
      selectionAuthority,
      graceMs: 500,
    });
    const reviewerAdapter = createPiRpcAdapter({
      piExecutable: (process.env.AEGISFLOW_PI_RUNTIME_PATH ?? process.env.AUTOLOOP_PI_RUNTIME_PATH) || "pi",
      provider: providerOf(route.route),
      model: modelOf(route.route),
      environmentAllowlist: adapterEnv,
      graceMs: 500,
    });

    const result = await runLifecycle({
      cwd: repo,
      taskCard: card,
      executorAdapter: traced(executorAdapter, "executor"),
      reviewerAdapter: traced(reviewerAdapter, "reviewer"),
      maxRepairAttempts: card.maxRepairAttempts,
      timeoutMs: 300_000,
    });
    record.adapter_trace = adapterTrace;

    // ── Harness-owned acceptance verdict ──────────────────────────────────
    // Success is the acceptance test's exit code, observed by the HARNESS on
    // the resulting tree — never the agent's claim and never the reviewer's.
    const acceptance = spawnSync(task.acceptance.test_command[0], task.acceptance.test_command.slice(1), {
      cwd: repo, encoding: "utf8", timeout: 120_000,
    });
    record.acceptance_exit_code = acceptance.status;
    record.task_success = acceptance.status === task.acceptance.expect_exit_code &&
      result.final === "PASS";

    // ── Observed change surface ───────────────────────────────────────────
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })
      .split("\n").filter((l) => l.trim().length > 0)
      .map((l) => l.slice(3).trim());
    record.changed_paths = porcelain;
    record.scope_clean = porcelain.every((p) => task.fixture.expected_changed_paths.some((a) => p === a || p.startsWith(`${a}/`)));

    // ── AegisFlow outcome + metrics ────────────────────────────────────────
    record.lifecycle_final = result.final;
    record.lifecycle_reason = result.reason ?? null;
    // A "repair" is the lifecycle LOOPING BACK for another attempt: the executor
    // runs a second (or later) time because the reviewer asked for a repair.
    // Counting a transition literally named "repair" measured nothing — the
    // runner names its transitions by PHASE (executor/reviewer/runner), so that
    // counter reported 0 even when a repair had genuinely happened. The trace is
    // the honest source: one executor invocation per attempt.
    const transitions = result.transitions ?? [];
    record.executor_attempts = transitions.filter((t) => t.phase === "executor").length;
    record.reviewer_attempts = transitions.filter((t) => t.phase === "reviewer").length;
    record.repairs = Math.max(0, record.executor_attempts - 1);
    record.hold = result.final === "HOLD";
    record.first_pass = result.final === "PASS" && record.repairs === 0;
    // Distinguish "would have repaired but the budget was 0" from a genuine
    // non-repairable HOLD: the lifecycle emits REPAIR_BUDGET_EXHAUSTED when the
    // reviewer asked for a repair and the budget could not cover it.
    record.repair_available_but_exhausted = result.reason === "REPAIR_BUDGET_EXHAUSTED";

    // Token/call accounting comes from the ADAPTER trace, which observes the
    // real provider usage returned by the runtime. Summing over transitions
    // would miss it: the transitions carry lifecycle status, not usage.
    const usage = collectTraceUsage(adapterTrace);
    record.input_tokens = usage.input;
    record.output_tokens = usage.output;
    record.cache_read_tokens = usage.cacheRead;
    record.cache_write_tokens = usage.cacheWrite;
    record.total_tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    record.context_occupancy = usage.totalTokens;
    record.model_call_count = usage.calls;
    record.estimated_provider_cost_usd = usage.cost;
  } catch (e) {
    record.error = `${e?.code ?? e?.name ?? "error"}: ${String(e?.message ?? e).slice(0, 400)}`;
    record.task_success = false;
    record.lifecycle_final = "ERROR";
  } finally {
    record.wall_clock_ms = Number(process.hrtime.bigint() - started) / 1e6;
    record.finished_at = new Date().toISOString();
    rmSync(repo, { recursive: true, force: true });
  }
  return record;
}

// ── Route helpers ──────────────────────────────────────────────────────────

function providerOf(route) {
  const row = routing.SUPPORTED_ROUTE_VALUES.includes(route) ? route : routing.defaultRoute().route;
  return row.split("/")[0];
}
function modelOf(route) {
  const row = routing.SUPPORTED_ROUTE_VALUES.includes(route) ? route : routing.defaultRoute().route;
  return row.split("/").slice(1).join("/");
}

/**
 * Env var NAMES a route's credential lives in. The benchmark must not invent a
 * secret; it forwards whatever the operator already exported. Only names appear
 * here, and only the names the selected route needs.
 */
function PROVIDER_ENV_KEYS(route) {
  const p = providerOf(route);
  if (p === "merge-gateway") return ["MERGE_GATEWAY_API_KEY"];
  if (p === "deepseek") return ["DEEPSEEK_API_KEY"];
  return [];
}

/** Sum provider usage observed by the traced adapters. */
function collectTraceUsage(trace) {
  const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, calls: 0 };
  for (const entry of trace ?? []) {
    const u = entry?.providerUsage;
    if (!u || typeof u !== "object") continue;
    acc.input += u.input ?? 0;
    acc.output += u.output ?? 0;
    acc.cacheRead += u.cacheRead ?? 0;
    acc.cacheWrite += u.cacheWrite ?? 0;
    acc.totalTokens += u.totalTokens ?? 0;
    acc.cost += u.cost?.total ?? 0;
    acc.calls += 1;
  }
  return acc;
}

function collectUsage(transitions) {
  const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, calls: 0 };
  const visit = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v.providerUsage && typeof v.providerUsage === "object") {
      const u = v.providerUsage;
      acc.input += u.input ?? 0;
      acc.output += u.output ?? 0;
      acc.cacheRead += u.cacheRead ?? 0;
      acc.cacheWrite += u.cacheWrite ?? 0;
      acc.totalTokens += u.totalTokens ?? 0;
      acc.cost += u.cost?.total ?? 0;
      acc.calls += 1;
    }
    for (const x of Object.values(v)) visit(x);
  };
  visit(transitions);
  return acc;
}

// ── CLI ────────────────────────────────────────────────────────────────────

/** Parse --explore-repair; null when absent. */
function explorationArg() {
  const raw = arg("explore-repair", null);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--explore-repair must be a non-negative integer, got ${raw}`);
  return n;
}

/** Print usage and exit — guards against an accidental bare invocation. */
function usage() {
  console.log(`AegisFlow effectiveness benchmark runner

  node benchmarks/runner/run-benchmark.mjs --arm <ARM> [--runs N] [options]
  node benchmarks/runner/run-benchmark.mjs --all [--runs N] [options]

Arms:   ${[...ARMS, LEARNING_ARM].join(", ")}

Options:
  --runs N               runs per arm per task (default 5)
  --task <prefix>        restrict to task ids starting with <prefix>
  --store <dir>          strategy store the treatment arms read
  --explore-repair N     LEARNING PERIOD: run this arm with max_repair_attempts=N
                         so the strategy memory observes an alternative value
  --append               add to an existing <ARM>.jsonl instead of refusing
  --out <name>           write results to <name>.jsonl
  --help                 print this message

Environment:
  BENCH_ROUTE            pin the provider route for every arm (recorded in the manifest)
  AEGISFLOW_PI_RUNTIME_PATH   absolute path to the 'pi' CLI when it is not on PATH
                              (the pre-rename AUTOLOOP_PI_RUNTIME_PATH is still honored)

Results: benchmarks/results/<ARM>.jsonl plus manifest.json`);
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

export function loadTasks() {
  return readdirSync(TASKS_DIR).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(readFileSync(join(TASKS_DIR, f), "utf8")));
}

export async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) { usage(); return []; }
  const runs = Number(arg("runs", "5"));
  const only = arg("task", null);
  const all = arg("all", false) === true;
  const arms = all ? [...ARMS] : [String(arg("arm", "CONTROL"))];
  const isLearningRun = explorationArg() !== null;
  for (const a of arms) {
    if (!ARMS.includes(a) && !(isLearningRun && a === LEARNING_ARM)) {
      throw new Error(`unknown arm ${a}; expected one of ${ARMS.join(", ")}${isLearningRun ? ` (or ${LEARNING_ARM} with --explore-repair)` : ""}`);
    }
  }

  const tasks = loadTasks().filter((t) => !only || t.task_id === only || t.task_id.startsWith(String(only)));
  if (tasks.length === 0) throw new Error("no tasks selected");

  mkdirSync(RESULTS_DIR, { recursive: true });
  const scratchParent = mkdtempSync(join(tmpdir(), "autoloop-bench-"));
  // One store per arm is what makes the arms differ: FRESH starts empty,
  // LEARNED reads what a learning period wrote. A caller supplies the learned
  // store with --store (see benchmarks/README.md).
  const storeRoot = String(arg("store", join(scratchParent, "strategy-store")));
  // --explore-repair N runs this arm as a LEARNING PERIOD with N repair
  // attempts, so the strategy memory observes an alternative value. Without it
  // the memory only ever sees the current value and can never propose a change
  // (an honest outcome, but not an experiment).
  const exploration = explorationArg();
  // --append adds to an existing arm file; --out names a different file. Both
  // exist so a published sample can never be silently replaced.
  const append = arg("append", false) === true;
  const outName = arg("out", null) === null ? null : String(arg("out"));
  if (STRATEGY_FEATURES_ON(arms[0])) mkdirSync(storeRoot, { recursive: true });

  const manifest = {
    schema: "autoloop.benchmark-manifest/v1",
    generated_at: new Date().toISOString(),
    node_version: process.version,
    platform: `${process.platform}/${process.arch}`,
    runs_per_arm_per_task: runs,
    arms,
    task_ids: tasks.map((t) => t.task_id),
    strategy_store_root: storeRoot,
    strategy_store_populated: existsSync(join(storeRoot, "strategy-policy.json")),
    supported_routes: [...routing.SUPPORTED_ROUTE_VALUES],
    route_override: process.env.BENCH_ROUTE ?? null,
    exploration_repair_attempts: exploration,
    exploration_note: exploration === null
      ? "no exploration override: this arm runs the arm's own strategy resolution"
      : `LEARNING PERIOD: every run in this arm uses max_repair_attempts=${exploration} so the strategy memory observes an alternative value`,
  };

  const results = [];
  for (const arm of arms) {
    const route = routeForArm(arm, { taskClass: null, storeRoot });
    manifest[`route_${arm}`] = route.route;
    manifest[`route_source_${arm}`] = route.source;
    const lines = [];
    for (const task of tasks) {
      for (let i = 0; i < runs; i++) {
        process.stderr.write(`[${arm}] ${task.task_id} run ${i + 1}/${runs}\n`);
        const rec = await runOnce({ task, arm, runIndex: i, storeRoot, scratchParent, route, exploration });
        lines.push(JSON.stringify(rec));
        results.push(rec);
      }
    }
    // Never silently clobber an existing arm file: a re-run of the same arm is
    // a DIFFERENT sample and must not overwrite the one already published.
    // Use --append to add to it, or --out to write somewhere else.
    const outPath = append
      ? join(RESULTS_DIR, `${arm}.jsonl`)
      : join(RESULTS_DIR, outName ? `${outName}.jsonl` : `${arm}.jsonl`);
    if (append && existsSync(outPath)) {
      const prior = readFileSync(outPath, "utf8").trim();
      writeFileSync(outPath, `${prior}\n${lines.join("\n")}\n`);
    } else if (!append && existsSync(outPath)) {
      throw new Error(`${outPath} already exists — refusing to overwrite a published sample (use --append to add, or --out <name>)`);
    } else {
      writeFileSync(outPath, `${lines.join("\n")}\n`);
    }
  }
  const manifestPath = join(RESULTS_DIR, "manifest.json");
  if (existsSync(manifestPath)) {
    // Keep the history of runs this directory contains rather than replacing
    // the record of an earlier arm.
    const prior = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.prior_runs = [...(prior.prior_runs ?? []), {
      generated_at: prior.generated_at,
      arms: prior.arms,
      runs_per_arm_per_task: prior.runs_per_arm_per_task,
      task_ids: prior.task_ids,
      route_override: prior.route_override ?? null,
      exploration_repair_attempts: prior.exploration_repair_attempts ?? null,
    }];
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(scratchParent, { recursive: true, force: true });

  const ok = results.filter((r) => r.task_success).length;
  console.log(`runs=${results.length} success=${ok} failures=${results.length - ok}`);
  console.log(`raw results: benchmarks/results/{${arms.join(",")}}.jsonl`);
  console.log(`manifest:    benchmarks/results/manifest.json`);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(String(e?.stack ?? e)); process.exitCode = 1; });
}
