// test/admission/test-admission-memory-provider.mjs
//
// AUTOLOOP-CBM-LIVE-INTEGRATION-1 — Phase 2/3 production provider wiring
// (A3/A4/A5): runAdmittedGraph constructs the read-only memory provider
// automatically ONLY for admissions that authorize retrieval
// (memory_policy.retrieval_allowed === true, an explicit capability — never
// a global default); an unauthorized admission gets no provider (fail-closed
// at the runner gate); an authorized admission can actually retrieve
// repository-bound records through the injected provider.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdmittedGraph } from "../../src/admission/admission-gate.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import { classify } from "../../src/admission/classify.mjs";
import { LocalMemoryStore, resolveRepositoryIdentity } from "../../src/memory/index.mjs";
import { codeRecord } from "../memory/helpers-cbm3.mjs";

const DIMS = ["affected_files", "affected_subsystems", "dependency_depth", "ambiguity", "expected_execution_steps", "verification_burden", "external_dependencies", "concurrency_potential", "statefulness", "rollback_complexity"];

// Explicit capability through the authoritative profile path: FAST_PATH is
// the ONLY profile with memory_retrieval_allowed=false; STANDARD enables
// retrieval WITHOUT review requirements (so no review binding is needed in
// these wiring tests). Built through the real classifier (deterministic):
// FAST_PATH = XS/LOW (all-zero scores); STANDARD = M/LOW (total 10).
function admissionFor(profile) {
  const scores = profile === "FAST_PATH"
    ? Object.fromEntries(DIMS.map((d) => [d, 0]))
    : Object.fromEntries(DIMS.map((d) => [d, 1])); // total 10 -> size M
  const classification = classify({
    dimensionScores: Object.fromEntries(DIMS.map((d) => [d, { score: scores[d], reasons: ["test fixture"] }])),
    riskSignals: [],
    evidenceSufficient: true,
  });
  assert.equal(classification.profile, profile, `classify produced ${classification.profile}`);
  return freezeAdmission(buildAdmissionRecord({
    taskId: `test-${profile.toLowerCase()}`,
    classification,
    mutationScope: ["src/", "test/", "scripts/", "docs/"],
  }));
}

const roots = [];
function tmpRoot() {
  const d = mkdtempSync(join(tmpdir(), "cbm-live-adm-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeRepo() {
  const dir = tmpRoot();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "r1"], { cwd: dir });
  return dir;
}
function treeOf(dir) {
  return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
}

const PASS_RESULT = { final: "PASS", executionId: "t", nodeResults: [], transitions: [] };

test("A4: memory_retrieval_allowed=false (FAST_PATH) -> no provider, retrieval denied", async () => {
  let received = null;
  const r = await runAdmittedGraph({
    admission: admissionFor("FAST_PATH"),
    runner: async (opts) => { received = opts; return { ...PASS_RESULT, executionId: "a4" }; },
  });
  assert.equal(r.final, "PASS");
  assert.equal(received.memory, undefined, "unauthorized admission must not receive a provider");
});

test("A3/A5: memory_retrieval_allowed=true (STANDARD) -> provider auto-constructed", async () => {
  let received = null;
  const r = await runAdmittedGraph({
    admission: admissionFor("STANDARD"),
    runner: async (opts) => { received = opts; return { ...PASS_RESULT, executionId: "a5" }; },
  });
  assert.equal(r.final, "PASS");
  assert.ok(received.memory, "authorized admission must receive the provider automatically");
  assert.equal(typeof received.memory.provider.retrieveGraphMemory, "function");
});

test("A5: authorized admission -> provider retrieves repository-bound records", async () => {
  const repo = makeRepo();
  const stateRoot = tmpRoot();
  const id = resolveRepositoryIdentity(repo);

  const s = new LocalMemoryStore({ stateRoot, log: { info() {}, warn() {}, error() {} } });
  s.open();
  s.explicitImport(codeRecord({
    repo: id.repositoryIdentity,
    commit: id.commitSha,
    tree: treeOf(repo),
    path: "src/parse.mjs",
    symbol: "parseMemoryRecord",
    statement: "parseMemoryRecord validates memory records deterministically",
  }));
  s.close();

  const prev = process.env.AUTOLOOP_MEMORY_STATE_ROOT;
  process.env.AUTOLOOP_MEMORY_STATE_ROOT = stateRoot;
  let retrieval = null;
  try {
    const r = await runAdmittedGraph({
      admission: admissionFor("STANDARD"),
      runner: async (opts) => {
        retrieval = await opts.memory.provider.retrieveGraphMemory({ repoPath: repo, cwd: repo, executionId: "a5-live", graphRunId: "a5-live", taskIdentity: null });
        return { ...PASS_RESULT, executionId: "a5-live" };
      },
    });
    assert.equal(r.final, "PASS");
  } finally {
    if (prev === undefined) delete process.env.AUTOLOOP_MEMORY_STATE_ROOT;
    else process.env.AUTOLOOP_MEMORY_STATE_ROOT = prev;
  }
  assert.ok(retrieval, "provider must have been invoked");
  assert.equal(retrieval.state, "AVAILABLE");
  assert.equal(retrieval.memoryContext.state, "AVAILABLE");
  assert.ok(retrieval.memoryContext.counts.selected >= 1, "repository-bound record must be retrieved");
});
