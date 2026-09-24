// test/evolution/test-evolution-operator-view.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Section L acceptance:
// the read-only operator evolution view.
//
//   O1  populated store → complete report (policy/breaker/triggers/
//       candidates/reviews/canary/rollbacks), reportIdentity re-derives
//   O2  absent store → truthful UNKNOWN report, never fabricated state
//   O3  read-only: the CLI performs zero writes (store bytes unchanged)
//   O4  CLI: --json and text forms both exit 0 on a safe report
//
// Run: node --test test/evolution/test-evolution-operator-view.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { buildEvolutionReport, renderEvolutionReportText, EVOLUTION_OPERATOR_REPORT_SCHEMA } from "../../src/evolution/operator-view.mjs";
import { createEvolutionPolicy } from "../../src/evolution/policy.mjs";
import { buildTriggerEvent, writeTriggerState, recordTrigger, readTriggerState, tripCircuitBreaker } from "../../src/evolution/trigger.mjs";
import { deriveImprovementCandidate } from "../../src/evolution/candidate.mjs";
import { bindEvolutionReview } from "../../src/evolution/promotion.mjs";
import { openCanaryWindow, evaluateCanary, rollbackCandidate } from "../../src/evolution/canary.mjs";

const ROOTS = [];
function freshDir(label) {
  const d = mkdtempSync(join(tmpdir(), `evol-view-${label}-`));
  ROOTS.push(d);
  return d;
}
test.after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

const PATCH = ["--- a/lib/a.ts", "+++ b/lib/a.ts", "@@ -1 +1 @@", "-x", "+y", ""].join("\n");

function populateStore(store, { withCanary = false } = {}) {
  createEvolutionPolicy(store, {
    policy_name: "view-test-policy", scope_patterns: ["lib/**"], forbidden_patterns: [], allowed_commands: ["node"],
    validation_plan_id: "v1", validation_plan: { commands: [{ cmd: "node", args: ["-e", ""], timeout_ms: 1000 }] },
    budget: { max_mutation_runs: 4, max_wall_clock_ms_per_run: 60000, max_evolutions_per_window: 2, window_ms: 86400000 },
    issued_by: "operator", authorization_ref: "test://policy", expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  const trigger = buildTriggerEvent({
    signal: { signalClass: "REPEATED_EQUIVALENT_FAILURE", count: 3, minCount: 3, signature: "view-sig", evidenceRefs: ["e1", "e2", "e3"], observation: { patchPlan: { patch: PATCH }, affectedScope: ["lib/a.ts"] } },
    graphRunId: "view-run",
  });
  let st = readTriggerState(store);
  st = recordTrigger(st, trigger);
  writeTriggerState(store, st);
  const derived = deriveImprovementCandidate({ triggerEvent: trigger, baselineHead: "a".repeat(40), baselineRevision: 3, storeRoot: store });
  const candidate = derived.candidate;
  const fitness = { fitness_digest: "f".repeat(64), verdict: "IMPROVED", decision: "ACCEPT" };
  bindEvolutionReview({ storeRoot: store, candidate, fitness, reviewerIdentity: "reviewer:view", verdict: "PASS", summary: "view test" });
  if (withCanary) {
    // a real git fixture for the canary rollback record
    const repo = freshDir("view-repo");
    execFileSync("git", ["init", "-b", "master"], { cwd: repo });
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "x\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"]);
    const baselineHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const commitOid = spawnSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", baselineHead, "-m", "evo"], { encoding: "utf8" }).stdout.trim();
    const branch = `evolution/${candidate.candidate_id}`;
    execFileSync("git", ["-C", repo, "update-ref", `refs/heads/${branch}`, commitOid]);
    const promotion = { branch, commit_oid: commitOid, parent: baselineHead };
    openCanaryWindow({ storeRoot: store, candidate, promotion, fitness, baselineMetric: { metric: "failure_or_repair_count", value: 0 } });
    // regress it → rollback record
    const post = Array.from({ length: 2 }, (_, i) => ({ event_type: "RUN_HELD", timestamp: new Date().toISOString(), event_id: `p${i}`, payload: { reason: candidate.problem_signature } }));
    evaluateCanary({ storeRoot: store, candidate, postEvents: post });
    rollbackCandidate({ repoRoot: repo, storeRoot: store, candidate });
  }
  return candidate;
}

test("O1 populated store yields a complete report with re-derivable identity", () => {
  const store = freshDir("o1");
  const candidate = populateStore(store, { withCanary: true });
  const report = buildEvolutionReport({ storeRoot: store });
  assert.equal(report.schema, EVOLUTION_OPERATOR_REPORT_SCHEMA);
  assert.equal(report.policy.state, "ACTIVE");
  assert.equal(report.policy.policyName, "view-test-policy");
  assert.equal(report.circuitBreaker.state, "CLEAR");
  assert.equal(report.triggers.count, 1);
  assert.equal(report.triggers.latest[0].signal_class, "REPEATED_EQUIVALENT_FAILURE");
  assert.equal(report.candidates.length, 1);
  const c = report.candidates[0];
  assert.equal(c.candidate_id, candidate.candidate_id);
  assert.equal(c.risk_class, "LOW");
  assert.equal(c.review.verdict, "PASS");
  assert.equal(c.canary.rolled_back, true);
  assert.equal(report.rollbacks.length, 1);
  assert.ok(/^[0-9a-f]{64}$/.test(report.reportIdentity));
  // identity re-derives (idempotent read)
  const r2 = buildEvolutionReport({ storeRoot: store });
  assert.equal(r2.reportIdentity, report.reportIdentity);
  // text renderer is total
  const text = renderEvolutionReportText(report);
  assert.ok(text.includes("policy: ACTIVE"));
  assert.ok(text.includes(candidate.candidate_id));
  assert.ok(text.includes("ROLLED_BACK"));
});

test("O2 absent store yields a truthful UNKNOWN report", () => {
  const report = buildEvolutionReport({ storeRoot: "/tmp/definitely-absent-evol-view" });
  assert.equal(report.candidates.length, 0);
  assert.equal(report.policy.state, "UNKNOWN");
  assert.ok(report.diagnostics.some((d) => d.code === "NO_EVOLUTION_STORE"));
  assert.ok(/^[0-9a-f]{64}$/.test(report.reportIdentity));
  const text = renderEvolutionReportText(report);
  assert.ok(text.includes("candidates: none"));
});

test("O3 the report build is read-only (store bytes unchanged)", () => {
  const store = freshDir("o3");
  populateStore(store);
  const before = {};
  for (const f of ["evolution-policy.json", "evolution-trigger-state.json", "evolution-derivation-index.json"]) {
    const p = join(store, f);
    if (existsSync(p)) before[f] = readFileSync(p, "utf8");
  }
  buildEvolutionReport({ storeRoot: store });
  buildEvolutionReport({ storeRoot: store });
  for (const [f, content] of Object.entries(before)) {
    assert.equal(readFileSync(join(store, f), "utf8"), content, `${f} changed during report build`);
  }
});

test("O4 the CLI exits 0 with a safe report in both forms", () => {
  const store = freshDir("o4");
  populateStore(store);
  const text = spawnSync(process.execPath, [join(process.cwd(), "scripts", "evolution-operator.mjs"), "--store", store], { encoding: "utf8" });
  assert.equal(text.status, 0, `text form failed: ${text.stderr}`);
  assert.ok(text.stdout.includes("AutoLoop evolution report"));
  const json = spawnSync(process.execPath, [join(process.cwd(), "scripts", "evolution-operator.mjs"), "--store", store, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 0, `json form failed: ${json.stderr}`);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.schema, EVOLUTION_OPERATOR_REPORT_SCHEMA);
  // tripped breaker is surfaced
  let st = readTriggerState(store);
  writeTriggerState(store, tripCircuitBreaker(st, { reason: "test-trip" }));
  const tripped = spawnSync(process.execPath, [join(process.cwd(), "scripts", "evolution-operator.mjs"), "--store", store], { encoding: "utf8" });
  assert.equal(tripped.status, 0);
  assert.ok(tripped.stdout.includes("TRIPPED"));
});
