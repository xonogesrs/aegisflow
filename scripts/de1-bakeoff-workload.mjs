// scripts/de1-bakeoff-workload.mjs
//
// DE-1 Stage 7 — shared bake-off workload for the EXISTING AutoLoop durable
// execution (Candidate A). The SAME deterministic workload, adapters and
// config are used by BOTH:
//   - the worker child process (which gets killed at injection points), and
//   - the harness resume call (fresh process — proves process-restart
//     semantics).
//
// The workload is a 4-phase DAG:
//   p_ro1 (read-only) -> p_ro2 (read-only) -> p_writer (writer) -> p_verifier (read-only)
// Each adapter call writes a side-effect marker under <sidefxDir> so the
// harness can count EXACTLY which executions happened (duplicates / lost
// results / writer replay). The repo fixture itself stays CLEAN (the
// writer's "mutation" is simulated by a marker write, mirroring the
// isolated-worktree model of the production Graph path).

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export const MANIFEST_REQ = [
  { requirement_id: "R1", text: "analyze A" },
  { requirement_id: "R2", text: "analyze B" },
  { requirement_id: "R3", text: "implement" },
  { requirement_id: "R4", text: "verify" },
];
export const PARENT = { scope: { allowed_paths: ["src/"], forbidden_paths: [] } };
export const SOURCE = { goal: "task", requirements: MANIFEST_REQ, authority: { allowed_paths: ["src/"], mutation_allowed: true, commit_allowed: false } };
export const TOOL_POLICY = { mode: "no-tools" };
export const HARNESS_HOOKS = {
  environmentAllowlist: ["PATH", "HOME", "TMPDIR"],
  verificationCommand: ["node", "-e", "process.exit(0)"],
  expectedExecutorModel: "bakeoff-model",
  expectedExecutorProvider: "bakeoff",
};

export function bakeoffIr() {
  const ro = (id, title, depends, req) => ({
    phase_id: id,
    title,
    summary: "ro",
    responsibility: req,
    purpose: "analysis",
    effects: {
      artifact_mutation: "forbidden", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
      evidence_output: "ephemeral", boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
    },
    covers: [{ requirement_id: req, completeness: "complete", claim: "c" }],
    depends_on: depends,
  });
  return {
    verdict: "DECOMPOSED",
    parent_goal: "goal",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases: [
      ro("p_ro1", "Analysis 1", [], "R1"),
      ro("p_ro2", "Analysis 2", ["p_ro1"], "R2"),
      {
        phase_id: "p_writer",
        title: "Writer", summary: "w", responsibility: "R3", purpose: "implementation",
        effects: {
          artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
          evidence_output: "persistent", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: ["evidence/"] },
        },
        covers: [{ requirement_id: "R3", completeness: "complete", claim: "c" }],
        depends_on: ["p_ro2"],
      },
      ro("p_verifier", "Verifier", ["p_writer"], "R4"),
    ],
    dispositions: [],
    decomposition_evidence: ["e"],
  };
}

export function decompositionAdapterFor(ir) {
  return { generate: async () => ({ status: "completed", parsed: ir, content: JSON.stringify(ir), thinking: "", usage: null, stopReason: "stop", elapsedMs: 1, requestCount: 1 }) };
}

function writeMarker(sidefxDir, name, obj) {
  mkdirSync(sidefxDir, { recursive: true });
  writeFileSync(join(sidefxDir, name), JSON.stringify(obj) + "\n", "utf8");
}

/**
 * Deterministic adapter factories（custom — NOT call-order-scripted, so the
 * same factories work for the original run AND any resumed continuation）.
 * Every adapter call writes a side-effect marker; the harness counts markers
 * to measure duplicated execution / lost results / writer replay.
 *
 * @param {object} o
 * @param {string} o.sidefxDir - where markers are written
 * @param {string} [o.writerResult] - "PASS" | "REPAIR" (T7 repair injection)
 */
export function makeAdapterFactories({ sidefxDir, writerResult = "PASS", executorSleepMs = 0 }) {
  const phaseOf = (request) => request?.taskCard?.phaseId ?? request?.phase ?? "unknown";
  const executor = {
    async runAdapter(request) {
      if (request.abortSignal?.aborted) {
        return { status: "aborted", executionId: request.executionId, stdout: "", stderr: "", signal: null, error: null, metadata: {} };
      }
      if (executorSleepMs > 0) await new Promise((r) => setTimeout(r, executorSleepMs));
      writeMarker(sidefxDir, `${phaseOf(request)}-exec-a${request.attempt}.json`, {
        phaseId: phaseOf(request), attempt: request.attempt, kind: "executor", writerResult, at: Date.now(),
      });
      return { status: "completed", executionId: request.executionId, stdout: "bakeoff executor ok", stderr: "", signal: null, error: null, metadata: { exitCode: 0 } };
    },
  };
  const reviewer = {
    async runAdapter(request) {
      if (request.abortSignal?.aborted) {
        return { status: "aborted", executionId: request.executionId, stdout: "", stderr: "", signal: null, error: null, metadata: {} };
      }
      // T7 repair injection: the writer's review is NEEDS_SUPPLEMENT/REPAIR on
      // attempt 0 and PASS on attempt >= 1（bounded by maxRepairAttempts=1）.
      const verdict = phaseOf(request) === "p_writer" && writerResult === "REPAIR" && request.attempt === 0
        ? { verdict: "NEEDS_SUPPLEMENT", confidence: "HIGH", model: "bakeoff", summary: "gap", evidence_gaps: ["bakeoff gap"], recommended_next_action: "REPAIR" }
        : { verdict: "PASS", confidence: "HIGH", model: "bakeoff", summary: "ok", recommended_next_action: "STOP" };
      writeMarker(sidefxDir, `${phaseOf(request)}-review-a${request.attempt}.json`, {
        phaseId: phaseOf(request), attempt: request.attempt, kind: "review", verdict: verdict.verdict, at: Date.now(),
      });
      return { status: "completed", executionId: request.executionId, stdout: JSON.stringify(verdict), stderr: "", signal: null, error: null, metadata: { exitCode: 0 } };
    },
  };
  return { executorAdapterFactory: () => executor, reviewerAdapterFactory: () => reviewer };
}

/** Count side-effect markers by (phaseId, kind) — e.g. { "p_ro1-exec-a0": 1 }. */
export function listMarkers(sidefxDir) {
  if (!existsSync(sidefxDir)) return [];
  return readdirSync(sidefxDir).filter((f) => f.endsWith(".json")).sort();
}

export function markerNames(sidefxDir) {
  return listMarkers(sidefxDir).map((f) => f.replace(/\.json$/, ""));
}

export function countMarker(sidefxDir, name) {
  return listMarkers(sidefxDir).filter((f) => f.replace(/\.json$/, "") === name).length;
}
