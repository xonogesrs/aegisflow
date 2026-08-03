// test/v2/test-runner.mjs
// V2 Card 5 Stage 3 — Runner single-writer boundary deterministic tests。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PHASE_STATUS, RUN_VERDICTS, ArtifactWriterLease,
  isRepositoryWriter, acquiresEvidenceWriterLease, requiresWriterLease,
  runDecompositionGraph, isRepoPathEntry,
} from "../../src/v2/runner.mjs";

// ── fixtures ──

function eff(artifact = "forbidden", evidence = "none", evidenceBoundaries = []) {
  return {
    artifact_mutation: artifact,
    runtime_side_effect: "forbidden",
    external_system_mutation: "forbidden",
    evidence_output: evidence,
    boundaries: { artifact: artifact !== "forbidden" ? ["src/"] : [], runtime: [], external_system: [], evidence: evidenceBoundaries },
  };
}

function phase(id, over = {}) {
  return {
    phase_id: id,
    title: id,
    summary: id,
    responsibility: id,
    purpose: "implementation",
    effects: eff(),
    covers: [],
    depends_on: [],
    ...over,
  };
}

function ir(phases, extra = {}) {
  return {
    verdict: "DECOMPOSED",
    parent_goal: "g",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases,
    dispositions: [],
    decomposition_evidence: ["e"],
    ...extra,
  };
}

function stubExecute(plan = {}) {
  // plan: { phaseId: "passed"|"held"|"failed"|fn }
  return async (p) => {
    const v = plan[p.phase_id];
    if (typeof v === "function") return v(p);
    return { status: v || "passed" };
  };
}

// ── writer classification（§五.1 項 6–10 的基礎）──

test("isRepositoryWriter: artifact_mutation allowed/required → writer", () => {
  assert.equal(isRepositoryWriter(phase("a", { effects: eff("allowed") })), true);
  assert.equal(isRepositoryWriter(phase("b", { effects: eff("required") })), true);
  assert.equal(isRepositoryWriter(phase("c", { effects: eff("forbidden") })), false);
});

test("isRepositoryWriter: title/ID/responsibility 字串不影響判定", () => {
  const p = phase("test_impl_review", { title: "implementation", responsibility: "implementation", effects: eff("forbidden") });
  assert.equal(isRepositoryWriter(p), false, "title containing implementation must not make it a writer");
  const q = phase("plain", { title: "read", responsibility: "read", effects: eff("required") });
  assert.equal(isRepositoryWriter(q), true, "required mutation is a writer regardless of title");
});

test("persistent evidence with repo-boundary → acquires evidence writer lease", () => {
  const p = phase("p", { effects: eff("forbidden", "persistent", ["evidence/report.md"]) });
  assert.equal(acquiresEvidenceWriterLease(p), true);
  assert.equal(requiresWriterLease(p), true);
});

test("persistent evidence pointing outside repo → no writer lease", () => {
  const p = phase("p", { effects: eff("forbidden", "persistent", ["external:audit-store"]) });
  assert.equal(acquiresEvidenceWriterLease(p), false);
  assert.equal(requiresWriterLease(p), false);
});

test("ephemeral evidence → no writer lease", () => {
  const p = phase("p", { effects: eff("forbidden", "ephemeral", ["tmp/notes"]) });
  assert.equal(acquiresEvidenceWriterLease(p), false);
  assert.equal(requiresWriterLease(p), false);
});

test("isRepoPathEntry: external schemes vs repo paths", () => {
  assert.equal(isRepoPathEntry("evidence/schema-check.md"), true);
  assert.equal(isRepoPathEntry("src/auth/"), true);
  assert.equal(isRepoPathEntry("sandbox:db"), false);
  assert.equal(isRepoPathEntry("external:store"), false);
  assert.equal(isRepoPathEntry("https://x"), false);
});

// ── lease class ──

test("ArtifactWriterLease: single holder, idempotent release", () => {
  const l = new ArtifactWriterLease("ws");
  const a = l.acquire(phase("w1"));
  assert.equal(a.ok, true);
  assert.equal(l.isHeld(), true);
  const b = l.acquire(phase("w2"));
  assert.equal(b.ok, false);
  assert.equal(b.holder, "w1");
  l.release();
  assert.equal(l.isHeld(), false);
  l.release(); // idempotent
  assert.equal(l.holder, null);
});

// ── scheduler tests（§五.1 項 1–5、11–15）──

test("1. two independent ready writers never run simultaneously", async () => {
  const running = [];
  const executed = [];
  const execute = async (p) => {
    running.push(p.phase_id);
    await new Promise((r) => setTimeout(r, 10));
    executed.push(p.phase_id);
    running.splice(running.indexOf(p.phase_id), 1);
    return { status: "passed" };
  };
  const g = ir([phase("w1", { effects: eff("required") }), phase("w2", { effects: eff("required") })]);
  const r = await runDecompositionGraph({ ir: g, execute });
  assert.equal(r.verdict, "PASS");
  assert.equal(r.writerViolations.length, 0);
  // 從 runLog 驗證：任何時刻至多一個 running writer
  let writersRunning = 0;
  let maxConcurrent = 0;
  for (const e of r.runLog) {
    if (e.transition === "running" && e.writer) writersRunning += 1;
    if (e.transition === "passed" && e.writer) writersRunning -= 1;
    maxConcurrent = Math.max(maxConcurrent, writersRunning);
  }
  assert.ok(maxConcurrent <= 1, `max concurrent writers=${maxConcurrent}`);
  assert.deepEqual(executed.sort(), ["w1", "w2"]);
});

test("2. second writer starts after first PASS", async () => {
  const order = [];
  const execute = async (p) => { order.push(p.phase_id); return { status: "passed" }; };
  const g = ir([phase("w1", { effects: eff("required") }), phase("w2", { effects: eff("required") })]);
  const r = await runDecompositionGraph({ ir: g, execute });
  assert.equal(r.verdict, "PASS");
  // w1 declared first → runs first; w2 waits then runs
  assert.deepEqual(order, ["w1", "w2"]);
  const w1Idx = r.order.indexOf("w1");
  const w2Idx = r.order.indexOf("w2");
  assert.ok(w1Idx < w2Idx);
  // w2 曾進入 waiting_for_writer
  assert.ok(r.runLog.some((e) => e.phase_id === "w2" && e.transition === "waiting_for_writer"));
});

test("3. first writer HOLD → lease released, whole run stops", async () => {
  const g = ir([
    phase("w1", { effects: eff("required") }),
    phase("w2", { effects: eff("required"), depends_on: ["w1"] }),
    phase("pre", { purpose: "analysis" }), // 與 w1 同輪 ready 的 non-writer（合法並行）
    phase("late", { purpose: "analysis", depends_on: ["pre"] }), // 僅在 hold 後才 eligible → 不得啟動
  ]);
  const r = await runDecompositionGraph({ ir: g, execute: stubExecute({ w1: "held" }) });
  assert.equal(r.verdict, "HOLD");
  assert.equal(r.leaseHolderAfter, null, "lease must be released after HOLD");
  assert.equal(r.statuses.w1, "held");
  assert.equal(r.statuses.w2, "skipped_due_to_dependency", "downstream of HOLD skipped");
  // 整體 run 停止：hold 之後才 eligible 的 phase 不得被啟動
  assert.equal(r.statuses.late, "pending", "no new phase may start after HOLD");
  assert.equal(r.order.includes("late"), false);
});

test("4. writer exception → lease released", async () => {
  const g = ir([phase("w1", { effects: eff("required") }), phase("w2", { effects: eff("required") })]);
  const r = await runDecompositionGraph({
    ir: g,
    execute: async (p) => { if (p.phase_id === "w1") throw new Error("boom"); return { status: "passed" }; },
  });
  assert.equal(r.verdict, "HOLD");
  assert.equal(r.statuses.w1, "failed");
  assert.equal(r.leaseHolderAfter, null, "lease released after exception");
});

test("5. non-writer can run while writer holds lease", async () => {
  let writerHolding = false;
  let nonWriterDuringWriter = false;
  let release;
  const gate = new Promise((res) => (release = res));
  const execute = async (p) => {
    if (p.phase_id === "w1") {
      writerHolding = true;
      await gate;
      writerHolding = false;
      return { status: "passed" };
    }
    if (p.phase_id === "n1") {
      nonWriterDuringWriter = writerHolding === true;
      return { status: "passed" };
    }
    return { status: "passed" };
  };
  const g = ir([phase("w1", { effects: eff("required") }), phase("n1", { purpose: "analysis" })]);
  const runPromise = runDecompositionGraph({ ir: g, execute });
  await new Promise((r) => setTimeout(r, 20)); // 讓 w1 啟動並持有 lease
  release();
  const r = await runPromise;
  assert.equal(r.verdict, "PASS");
  assert.equal(nonWriterDuringWriter, true, "non-writer executed while writer held the lease");
});

test("6. artifact_mutation=forbidden 不取得 lease", async () => {
  const g = ir([phase("r1", { effects: eff("forbidden") })]);
  const r = await runDecompositionGraph({ ir: g, execute: stubExecute() });
  assert.equal(r.runLog.some((e) => e.transition === "lease_acquired"), false);
  assert.equal(r.runLog.some((e) => e.phase_id === "r1" && e.transition === "running" && !e.writer), true);
  assert.equal(r.verdict, "PASS");
});

test("7. persistent evidence → repo boundary 取得 lease", async () => {
  const g = ir([phase("w1", { effects: eff("forbidden", "persistent", ["evidence/report.md"]) })]);
  const r = await runDecompositionGraph({ ir: g, execute: stubExecute() });
  assert.ok(r.runLog.some((e) => e.phase_id === "w1" && e.transition === "lease_acquired"), "evidence writer acquires lease");
  assert.ok(r.runLog.some((e) => e.phase_id === "w1" && e.transition === "lease_released"));
  assert.equal(r.leaseHolderAfter, null);
});

test("8. ephemeral evidence 不取得 lease", async () => {
  const g = ir([phase("n1", { effects: eff("forbidden", "ephemeral", ["tmp/notes"]) })]);
  const r = await runDecompositionGraph({ ir: g, execute: stubExecute() });
  assert.equal(r.runLog.some((e) => e.transition === "lease_acquired"), false);
});

test("9. phase title 含 implementation 不影響 writer 判定", async () => {
  const g = ir([phase("p1", { title: "implementation of feature", effects: eff("forbidden") })]);
  const r = await runDecompositionGraph({ ir: g, execute: stubExecute() });
  assert.equal(r.runLog.some((e) => e.transition === "lease_acquired"), false);
});

test("10. phase ID 含 test 不影響 writer 判定", async () => {
  const g = ir([phase("test_runner_phase", { effects: eff("required") })]);
  const r = await runDecompositionGraph({ ir: g, execute: stubExecute() });
  assert.ok(r.runLog.some((e) => e.phase_id === "test_runner_phase" && e.transition === "lease_acquired"), "required mutation is writer regardless of ID");
});

test("11. deterministic tie-break 穩定（declaration order 優先，phase_id 次之）", async () => {
  const orderA = [];
  await runDecompositionGraph({
    ir: ir([phase("b", { effects: eff("required") }), phase("a", { effects: eff("required") })]),
    execute: async (p) => { orderA.push(p.phase_id); return { status: "passed" }; },
  });
  assert.deepEqual(orderA, ["b", "a"], "declaration order wins over phase_id sort");

  const orderB = [];
  await runDecompositionGraph({
    ir: ir([phase("a", { effects: eff("required") }), phase("b", { effects: eff("required") })]),
    execute: async (p) => { orderB.push(p.phase_id); return { status: "passed" }; },
  });
  assert.deepEqual(orderB, ["a", "b"]);

  // 同 declaration order 下 phase_id 為穩定次序
  const orderC = [];
  await runDecompositionGraph({
    ir: ir([phase("a", { effects: eff("required") }), phase("c", { effects: eff("required") }), phase("b", { effects: eff("required") })]),
    execute: async (p) => { orderC.push(p.phase_id); return { status: "passed" }; },
  });
  assert.deepEqual(orderC, ["a", "c", "b"]);
});

test("12. runner 不新增 dependency edge（DAG 不被修改）", async () => {
  const g = ir([
    phase("a", { effects: eff("required") }),
    phase("b", { effects: eff("required"), depends_on: ["a"] }),
    phase("c", { effects: eff("required") }),
  ]);
  const before = JSON.parse(JSON.stringify(g.phases.map((p) => p.depends_on)));
  await runDecompositionGraph({ ir: g, execute: stubExecute() });
  const after = g.phases.map((p) => p.depends_on);
  assert.deepEqual(after, before, "runner must not add edges");
});

test("13. waiting-for-writer 不等於 blocked", async () => {
  const g = ir([
    phase("w1", { effects: eff("required") }),
    phase("w2", { effects: eff("required") }),
  ]);
  const r = await runDecompositionGraph({ ir: g, execute: stubExecute() });
  assert.ok(r.runLog.some((e) => e.phase_id === "w2" && e.transition === "waiting_for_writer"));
  assert.ok(!Object.values(r.statuses).some((s) => s === "blocked"), "no blocked status in scheduler state machine");
  assert.equal(r.statuses.w2, "passed");
  assert.equal(r.verdict, "PASS");
});

test("14. dependency failure 阻止 downstream", async () => {
  const g = ir([
    phase("a", { effects: eff("required") }),
    phase("b", { effects: eff("required"), depends_on: ["a"] }),
    phase("c", { effects: eff("forbidden"), depends_on: ["b"] }),
  ]);
  const r = await runDecompositionGraph({ ir: g, execute: stubExecute({ a: "failed" }) });
  assert.equal(r.verdict, "HOLD");
  assert.equal(r.statuses.b, "skipped_due_to_dependency");
  assert.equal(r.statuses.c, "skipped_due_to_dependency");
});

test("15. terminal／abort 路徑無 lease leak", async () => {
  // passed path
  let r = await runDecompositionGraph({ ir: ir([phase("w1", { effects: eff("required") })]), execute: stubExecute({ w1: "passed" }) });
  assert.equal(r.leaseHolderAfter, null);
  // held path
  r = await runDecompositionGraph({ ir: ir([phase("w1", { effects: eff("required") })]), execute: stubExecute({ w1: "held" }) });
  assert.equal(r.leaseHolderAfter, null);
  // failed path
  r = await runDecompositionGraph({ ir: ir([phase("w1", { effects: eff("required") })]), execute: stubExecute({ w1: "failed" }) });
  assert.equal(r.leaseHolderAfter, null);
  // abort path
  const ac = new AbortController();
  ac.abort();
  r = await runDecompositionGraph({ ir: ir([phase("w1", { effects: eff("required") })]), execute: stubExecute(), signal: ac.signal });
  assert.equal(r.verdict, "HOLD");
  assert.equal(r.leaseHolderAfter, null, "abort must release lease");
});

// ── 其他排程語義 ──

test("NOT_BENEFICIAL IR → 不產生任何 actionable phases", async () => {
  const r = await runDecompositionGraph({
    ir: { verdict: "DECOMPOSITION_NOT_BENEFICIAL", reason: "x", decomposition_evidence: ["e"] },
    execute: stubExecute(),
  });
  assert.equal(r.verdict, "PASS");
  assert.equal(r.order.length, 0);
  assert.equal(r.runLog.length, 0);
});

test("serialized writers with dependency run in dependency order", async () => {
  const order = [];
  const g = ir([
    phase("w2", { effects: eff("required"), depends_on: ["w1"] }),
    phase("w1", { effects: eff("required") }),
  ]);
  const r = await runDecompositionGraph({ ir: g, execute: async (p) => { order.push(p.phase_id); return { status: "passed" }; } });
  assert.equal(r.verdict, "PASS");
  assert.deepEqual(order, ["w1", "w2"]);
});

test("runner does not classify by responsibility string", () => {
  const p = phase("x", { responsibility: "implement the change", effects: eff("forbidden") });
  assert.equal(requiresWriterLease(p), false);
});
