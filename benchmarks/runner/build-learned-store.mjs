#!/usr/bin/env node
// benchmarks/runner/build-learned-store.mjs
//
// Builds the strategy store that the AUTOLOOP_LEARNED arm reads, from real
// prior runs — the learning period.
//
// It does exactly what a production deployment's attribution feed does:
//
//   prior run records
//     → attribution records (secret-free bounded projection)
//     → strategy observations (idempotent by run identity)
//     → per (task class × dimension × value) summaries
//     → a strategy preference activated ONLY where the evidence is sufficient
//
// The evidence floor is the production constant (MIN_SAMPLES_FOR_SUFFICIENCY),
// so a class whose prior runs are too few activates NOTHING — the learned arm
// then behaves exactly like the control arm for that class. That is the honest
// outcome and it is reported as such, not worked around.
//
// Usage:
//   node benchmarks/runner/build-learned-store.mjs \
//     --from benchmarks/results/CONTROL.jsonl \
//     --store /path/to/learned-store

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const { deriveAttribution } = await import(join(REPO, "src", "evolution", "attribution.mjs"));
const memory = await import(join(REPO, "src", "evolution", "strategy-memory.mjs"));
const store = await import(join(REPO, "src", "evolution", "strategy-store.mjs"));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

/**
 * Project one benchmark run record into an attribution record.
 *
 * The benchmark's raw record is already a bounded, secret-free observation, so
 * this is a field mapping — not a filter that might miss something.
 */
function attributionFromRun(run) {
  return deriveAttribution({
    events: [
      { event_type: run.lifecycle_final === "PASS" ? "RUN_PASSED" : run.lifecycle_final === "HOLD" ? "RUN_HELD" : "RUN_NOT_BENEFICIAL", phase_id: "P1", attempt: 0, payload: { holdCode: run.lifecycle_reason ?? null } },
      { event_type: "PROVIDER_USAGE_OBSERVED", phase_id: "P1", attempt: 0, payload: { provider_reported: true, occupancy: run.context_occupancy ?? null } },
      ...Array.from({ length: run.repairs ?? 0 }, (_, i) => ({ event_type: "PHASE_REPAIR_REQUESTED", phase_id: "P1", attempt: i, payload: {} })),
      { event_type: "DAG_ACCEPTED", payload: { phase_count: 1 } },
    ],
    taskClass: run.task_class,
    executionId: run.execution_id,
    admissionId: run.admission_id ?? null,
  });
}

/** Strategy values this benchmark measures, and how to read them off a run. */
function strategyValuesOf(run) {
  return {
    MODEL_ROUTING: run.route ?? null,
    RETRY_REPAIR: `max_attempts=${run.max_repair_attempts ?? 0}`,
    TOOL_SELECTION: Array.isArray(run.tool_selection) ? [...run.tool_selection].sort().join("+") : null,
  };
}

export function buildLearnedStore({ runs, storeRoot }) {
  mkdirSync(storeRoot, { recursive: true });
  const report = { ingested: 0, skipped: 0, recorded: 0, existing: 0, refused: [], activated: [], refused_activation: [] };

  for (const run of runs) {
    const attribution = attributionFromRun(run);
    let observation;
    try {
      observation = memory.buildStrategyObservation({
        attribution,
        evidenceRefs: [run.task_id, run.arm].filter(Boolean).filter((s) => typeof s === "string" && s.length > 0),
      });
    } catch (e) {
      report.skipped += 1;
      report.refused.push({ execution_id: run.execution_id, code: e?.code ?? "ERROR", reason: String(e?.message ?? e).slice(0, 160) });
      continue;
    }
    // Pin the measured strategy values onto the observation's axes so the
    // summary is keyed by what actually ran.
    const values = strategyValuesOf(run);
    for (const [dim, value] of Object.entries(values)) {
      if (value === null) continue;
      observation.strategy = { ...(observation.strategy ?? {}), [dim]: value };
    }
    try {
      const out = memory.recordStrategyObservation({ storeRoot, observation });
      report.ingested += 1;
      if (out.status === "RECORDED") report.recorded += 1; else report.existing += 1;
    } catch (e) {
      report.skipped += 1;
      report.refused.push({ execution_id: run.execution_id, code: e?.code ?? "ERROR", reason: String(e?.message ?? e).slice(0, 160) });
    }
  }

  // ── Activate a preference ONLY where the evidence clears the production floor
  const taskClasses = [...new Set(runs.map((r) => r.task_class))].sort();
  for (const taskClass of taskClasses) {
    for (const dimension of ["RETRY_REPAIR", "MODEL_ROUTING", "TOOL_SELECTION"]) {
      let summary;
      try {
        summary = memory.summarizeStrategyDimension({ storeRoot, taskClass, dimension });
      } catch (e) {
        report.refused_activation.push({ taskClass, dimension, code: e?.code ?? "ERROR", reason: String(e?.message ?? e).slice(0, 160) });
        continue;
      }
      const sufficient = (summary.values ?? []).filter((v) => v.evidence_sufficient === true && v.samples > 0);
      if (sufficient.length === 0) {
        report.refused_activation.push({
          taskClass, dimension, code: "EVIDENCE_INSUFFICIENT",
          reason: `no value reached ${memory.MIN_SAMPLES_FOR_SUFFICIENCY} samples; nothing activated`,
        });
        continue;
      }
      // Pick the best by success_rate, then by fewest repairs, then by value
      // string — deterministic, and honestly a heuristic (see docs/benchmark.md).
      const best = [...sufficient].sort((a, b) =>
        (b.success_rate ?? -1) - (a.success_rate ?? -1) ||
        (a.repairs_total ?? 0) - (b.repairs_total ?? 0) ||
        String(a.value).localeCompare(String(b.value)))[0];
      const params = paramsFor(dimension, best.value);
      if (params === null) {
        report.refused_activation.push({ taskClass, dimension, code: "VALUE_UNPARSEABLE", reason: `cannot derive params from ${String(best.value).slice(0, 80)}` });
        continue;
      }
      try {
        const out = store.activateStrategyValue({
          storeRoot, taskClass, dimension, params,
          candidateId: `bench-learned-${taskClass}-${dimension}`,
        });
        report.activated.push({ taskClass, dimension, value: best.value, samples: best.samples, success_rate: best.success_rate, generation: out?.policy?.generation ?? null });
      } catch (e) {
        report.refused_activation.push({ taskClass, dimension, code: e?.code ?? "ERROR", reason: String(e?.message ?? e).slice(0, 200) });
      }
    }
  }
  return report;
}

function paramsFor(dimension, value) {
  if (dimension === "RETRY_REPAIR") {
    // Bounded parameter name per BOUNDED_STRATEGY_PARAMS: `max_attempts`
    // (integer, 0..5). A different field name is silently out of schema.
    const m = /^max_attempts=(\d+)$/.exec(String(value));
    return m ? { max_attempts: Number(m[1]) } : null;
  }
  if (dimension === "MODEL_ROUTING") {
    return { route: String(value) };
  }
  if (dimension === "TOOL_SELECTION") {
    const ids = String(value).split("+").filter(Boolean);
    return ids.length > 0 ? { canonical_tool_ids: ids } : null;
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const from = String(arg("from", join(REPO, "benchmarks", "results", "CONTROL.jsonl")));
  const storeRoot = String(arg("store", join(REPO, "benchmarks", "results", "learned-strategy-store")));
  if (!existsSync(from)) { console.error(`no prior-run file at ${from}`); process.exitCode = 1; }
  else {
    const runs = readFileSync(from, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const report = buildLearnedStore({ runs, storeRoot });
    console.log(JSON.stringify({ store_root: storeRoot, prior_runs: runs.length, ...report }, null, 2));
  }
}
