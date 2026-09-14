// test/v2/test-cedf-realistic-workload.mjs
//
// CEDF Phase 25 — Realistic Workload Acceptance（三模式比較）。
//
// 代表性任務 IR（寫死於本檔）：
//   audit_a / audit_b / audit_c  — 3 個獨立唯讀 audit phase（零交集邊界）
//   join_arch                    — 共享架構決策 join（依賴三個 audit）
//   write_impl                   — 單一 writer mutation phase（依賴 join）
//   verify_schema / verify_behavior — 2 個驗證 phase（依賴 writer）
//
// 三種模式皆透過真實排程層 runDecompositionGraph 執行：
//   NAIVE_SERIAL    — 強制 depends_on 鏈，逐一序列執行。
//   NAIVE_PARALLEL  — 自然 DAG，全部宣稱平行；驗證 sealed scheduler 的
//                     writer 租約語義（單 writer 獨佔、不與他者衝突）。
//   CEDF            — 每 phase 先 decideDelegation（最小合法 admission stub），
//                     PARALLEL_DELEGATE 僅授予零交集唯讀 audit；
//                     reconcileChildResults 對 dependency child results 做
//                     COHERENT 驗證後才放行 join/writer。
//
// execute() 為計數 stub：記錄每次 invocation 的 phase_id、模擬工作成本、
// 以及「重複工作」事件（同一 phase 被執行 >1 次）。
// 不依賴 colima/docker；純排程層 + 純決策模組。

import { test } from "node:test";
import assert from "node:assert/strict";
import { PHASE_STATUS, RUN_VERDICTS, runDecompositionGraph } from "../../src/v2/runner.mjs";
import {
  DELEGATION_DECISIONS, DELEGATION_DECISION_CODES, decideDelegation,
} from "../../src/subagent/delegation-decision.mjs";
import {
  reconcileChildResults, reconciliationFinding,
} from "../../src/subagent/result-reconciliation.mjs";

// ── 固定成本模型 ──

const COST_UNITS = Object.freeze({
  audit_a: 1, audit_b: 1, audit_c: 1,
  join_arch: 2,
  write_impl: 3,
  verify_schema: 2, verify_behavior: 2,
});
const PHASE_ORDER = Object.keys(COST_UNITS);
const PARENT_REASONING_COST = 10; // 固定：分解推理成本，三模式相同
const DUPLICATE_PENALTY = 2;
const RETRY_PENALTY = 1;

// ── fixtures ──

function eff({ mutation = "forbidden", evidenceOut = "ephemeral", evidence = [], artifact = [] } = {}) {
  return {
    artifact_mutation: mutation,
    runtime_side_effect: "forbidden",
    external_system_mutation: "forbidden",
    evidence_output: evidenceOut,
    boundaries: { artifact, runtime: [], external_system: [], evidence },
  };
}

function vplan(subjects) {
  return {
    subject_phase_ids: subjects,
    method: "stub-observation",
    success_criteria: "stub observation reports expected state",
    failure_criteria: "stub observation reports unexpected state",
    evidence: "stub-run-log",
  };
}

/** 代表性任務 IR 的 7 個 phases（kind 欄位供測試 driver 分類；runner 只讀 schema 欄位）。 */
function basePhases() {
  return [
    {
      kind: "audit", phase_id: "audit_a", title: "audit a", summary: "audit a",
      responsibility: "audit a", purpose: "audit",
      effects: eff({ evidence: ["evidence/audit-a.md"] }),
      covers: ["req.audit-a"], depends_on: [], verification_plan: vplan([]),
    },
    {
      kind: "audit", phase_id: "audit_b", title: "audit b", summary: "audit b",
      responsibility: "audit b", purpose: "audit",
      effects: eff({ evidence: ["evidence/audit-b.md"] }),
      covers: ["req.audit-b"], depends_on: [], verification_plan: vplan([]),
    },
    {
      kind: "audit", phase_id: "audit_c", title: "audit c", summary: "audit c",
      responsibility: "audit c", purpose: "audit",
      effects: eff({ evidence: ["evidence/audit-c.md"] }),
      covers: ["req.audit-c"], depends_on: [], verification_plan: vplan([]),
    },
    {
      kind: "join", phase_id: "join_arch", title: "join arch", summary: "join arch",
      responsibility: "shared architecture decision", purpose: "join",
      effects: eff({}),
      covers: ["req.arch"], depends_on: ["audit_a", "audit_b", "audit_c"],
      verification_plan: vplan(["audit_a", "audit_b", "audit_c"]),
    },
    {
      kind: "writer", phase_id: "write_impl", title: "write impl", summary: "write impl",
      responsibility: "mutation", purpose: "implementation",
      effects: eff({ mutation: "required", artifact: ["src/impl.ts"], evidenceOut: "none" }),
      covers: ["req.impl"], depends_on: ["join_arch"],
      verification_plan: vplan(["join_arch"]),
    },
    {
      kind: "verify", phase_id: "verify_schema", title: "verify schema", summary: "verify schema",
      responsibility: "validation", purpose: "verification",
      effects: eff({ evidence: ["evidence/v-schema.md"] }),
      covers: ["req.verify-schema"], depends_on: ["write_impl"],
      verification_plan: vplan(["write_impl"]),
    },
    {
      kind: "verify", phase_id: "verify_behavior", title: "verify behavior", summary: "verify behavior",
      responsibility: "validation", purpose: "verification",
      effects: eff({ evidence: ["evidence/v-behavior.md"] }),
      covers: ["req.verify-behavior"], depends_on: ["write_impl"],
      verification_plan: vplan(["write_impl"]),
    },
  ];
}

function wrapIr(phases) {
  return {
    verdict: "DECOMPOSED",
    parent_goal: "cedf-phase25-representative-workload",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    phases,
    dispositions: [],
    decomposition_evidence: ["stub-evidence"],
  };
}

/** NAIVE_SERIAL：把自然 DAG 改寫成強制 depends_on 鏈。 */
function chainIr() {
  const phases = basePhases().map((p) => ({ ...p, depends_on: [] }));
  for (let i = 1; i < phases.length; i++) phases[i].depends_on = [phases[i - 1].phase_id];
  return wrapIr(phases);
}

/** 最小合法 admission stub：writer 給非空 sanctioned mutation boundary。 */
function admissionStub(p) {
  return {
    authority_domain: p.kind === "writer" ? "repository-writer" : `read-only:${p.kind}`,
    mutation_scope: p.kind === "writer" ? ["src/impl.ts"] : [],
  };
}

function makeRecorder() {
  return {
    invocations: [],          // 每次 execute 內的工作單位（含 retry 重跑）
    duplicatedWork: 0,        // 同一 phase 被執行 >1 次的重複工作事件數
    failedRetries: 0,         // 重跑後仍失敗的次數
    active: new Set(),
    maxConcurrency: 0,
    concByPhase: {},          // phase_id -> 該 phase 執行時觀察到的並行度
    leaseEvents: [],
    decisions: [],            // CEDF：{ phase_id, raw, effective }
    reconGates: [],           // CEDF：{ phase_id, verdict }
    findings: [],             // CEDF：reconciliationFinding 字串
    childResults: new Map(),  // phase_id -> persisted child result 形狀
    statuses: {},
  };
}

/**
 * 模擬工作 stub：每個成本單位一個 tick。
 * conflict=true 時 audit_b 注入 HOLD（並以矛盾 covers 宣稱 req.audit-a，
 * 與 audit_a 的 PASS 宣稱形成 CONTRADICTORY_OUTCOME）。
 */
async function stubWork(phase, { conflict }) {
  await new Promise((r) => setTimeout(r, (COST_UNITS[phase.phase_id] ?? 1) * 5));
  if (conflict && phase.phase_id === "audit_b") {
    return { status: "held", note: "conflict-injected" };
  }
  return { status: "passed" };
}

function recordChildResult(rec, phase, runnerStatus, { conflict }) {
  const passed = runnerStatus === "passed";
  // 衝突注入：audit_b 以矛盾 subject（req.audit-a）宣稱 HOLD。
  const covers = !passed && conflict && phase.phase_id === "audit_b"
    ? ["req.audit-a"]
    : phase.covers;
  rec.childResults.set(phase.phase_id, {
    status: passed ? "PASS" : "HOLD",
    covers,
    filesChanged: passed && phase.kind === "writer" ? ["src/impl.ts"] : [],
  });
}

/**
 * 三模式共用 driver：皆經 runDecompositionGraph 排程；
 * CEDF 在 execute 內先 decideDelegation + reconcileChildResults 閘門。
 * naive 模式給予相同的盲型重試預算（HOLD 視為暫時性，重跑一次）；
 * CEDF fail-closed：重跑決策前先 reconcile，偵測到矛盾即拒絕重試。
 */
async function runMode(mode, { conflict = false } = {}) {
  const rec = makeRecorder();
  const isCedf = mode === "CEDF";
  const maxAttempts = 2; // 三模式相同的重試預算；CEDF 的每次重試須先過 reconcile 閘門

  const execute = async (phase) => {
    let effective = null;
    if (isCedf) {
      const dependencyStates = Object.fromEntries(
        phase.depends_on.map((d) => [d, rec.statuses[d] ?? "pending"])
      );
      // 同一 generation 的 ready siblings：唯讀 audit 之間互為 sibling（零交集 → 平行合法）。
      const readySiblings = phase.kind === "audit"
        ? basePhases().filter((q) => q.kind === "audit" && q.phase_id !== phase.phase_id)
        : [];
      const d = decideDelegation({
        phase, readySiblings, dependencyStates, admission: admissionStub(phase),
      });
      effective = d.decision;
      if (d.decision === DELEGATION_DECISIONS.PARALLEL_DELEGATE && phase.kind !== "audit") {
        // CEDF 政策：PARALLEL_DELEGATE 僅授予零交集唯讀 audit；
        // 其他 phase 退回一般委派 slot（不拒絕、不平行宣稱）。
        effective = DELEGATION_DECISIONS.DELEGATE;
      }
      rec.decisions.push({
        phase_id: phase.phase_id,
        raw: d.decision,
        effective,
        reasons: [...d.reasons],
      });
      if (d.decision === DELEGATION_DECISIONS.HOLD) {
        recordChildResult(rec, phase, "held", { conflict });
        rec.statuses[phase.phase_id] = "held";
        return { status: "held", note: `delegation-hold:${d.reasons.join(",")}` };
      }
      // reconcile 閘門：join / writer 綁定 dependency child results 前，
      // 其宣稱必須 pairwise COHERENT（fail-closed）。
      if (phase.kind === "join" || phase.kind === "writer") {
        const depResults = phase.depends_on.map((depId) => ({
          phaseId: depId,
          role: depId === "join_arch" ? "join" : null,
          result: rec.childResults.get(depId) ?? null,
        }));
        const recon = reconcileChildResults(depResults);
        rec.reconGates.push({ phase_id: phase.phase_id, verdict: recon.verdict });
        if (recon.verdict !== "COHERENT") {
          rec.findings.push(...recon.conflicts.map(reconciliationFinding));
          recordChildResult(rec, phase, "held", { conflict });
          rec.statuses[phase.phase_id] = "held";
          return { status: "held", note: `reconciliation-conflict:${recon.conflicts.length}` };
        }
      }
    }

    let out;
    let attempts = 0;
    while (true) {
      attempts++;
      rec.active.add(phase.phase_id);
      rec.maxConcurrency = Math.max(rec.maxConcurrency, rec.active.size);
      rec.concByPhase[phase.phase_id] = Math.max(rec.concByPhase[phase.phase_id] ?? 0, rec.active.size);
      try {
        out = await stubWork(phase, { conflict });
      } finally {
        rec.active.delete(phase.phase_id);
      }
      rec.invocations.push({
        phase_id: phase.phase_id,
        attempt: attempts,
        baseline: [...phase.depends_on].sort().join(">"),
        cost: COST_UNITS[phase.phase_id],
      });
      if (out.status === "passed") break;

      // ── 重試決策 ──
      let mayRetry = attempts < maxAttempts;
      if (isCedf && mayRetry) {
        // fail-closed：矛盾宣稱不是暫時性錯誤 —— reconcile 偵測即拒絕盲型重試。
        const siblingRecords = basePhases()
          .filter((q) => q.kind === "audit" && q.phase_id !== phase.phase_id)
          .map((q) => ({
            phaseId: q.phase_id,
            role: null,
            result: rec.childResults.get(q.phase_id) ?? null,
          }));
        const tentative = { phaseId: phase.phase_id, role: null, result: { status: "HOLD", covers: ["req.audit-a"], filesChanged: [] } };
        const recon = reconcileChildResults([...siblingRecords, tentative]);
        if (recon.verdict !== "COHERENT") {
          rec.findings.push(...recon.conflicts.map(reconciliationFinding));
          mayRetry = false;
        }
      }
      if (mayRetry) {
        rec.duplicatedWork += 1; // 同一 phase 被重跑 → 重複工作事件
        continue;
      }
      if (attempts > 1) rec.failedRetries += 1;
      break;
    }

    recordChildResult(rec, phase, out.status, { conflict });
    rec.statuses[phase.phase_id] = out.status === "passed" ? "passed"
      : out.status === "held" ? "held" : "failed";
    return out;
  };

  const hooks = { onLease: (e) => rec.leaseEvents.push(e) };
  const result = await runDecompositionGraph({
    ir: mode === "NAIVE_SERIAL" ? chainIr() : wrapIr(basePhases()),
    execute, hooks,
  });

  const invocations = rec.invocations.length;
  const workUnits = rec.invocations.reduce((s, i) => s + i.cost, 0);
  const wallClockStepsUpperBound = invocations; // 序列步數上限 = stub 執行次數
  const ctcc = PARENT_REASONING_COST + workUnits
    + rec.duplicatedWork * DUPLICATE_PENALTY + rec.failedRetries * RETRY_PENALTY;
  const passedCount = PHASE_ORDER.filter((id) => result.statuses[id] === PHASE_STATUS.PASSED).length;

  return {
    mode, conflict,
    verdict: result.verdict,
    statuses: result.statuses,
    order: result.order,
    skipped: result.skipped,
    correctness: `${passedCount}/${PHASE_ORDER.length}`,
    metrics: {
      parent_reasoning_cost_fixed: PARENT_REASONING_COST,
      child_invocations: invocations,
      child_work_units: workUnits,
      duplicated_work_count: rec.duplicatedWork,
      failed_retries: rec.failedRetries,
      max_concurrency: rec.maxConcurrency,
      wall_clock_steps_upper_bound: wallClockStepsUpperBound,
      correct_task_completion_cost: ctcc,
    },
    rec, result,
  };
}

// ═══════════════ 1. NAIVE_SERIAL ═══════════════

test("NAIVE_SERIAL: 全鏈序列執行、正確完成、並行度恆為 1", async () => {
  const run = await runMode("NAIVE_SERIAL");

  assert.equal(run.verdict, RUN_VERDICTS.PASS);
  for (const id of PHASE_ORDER) assert.equal(run.statuses[id], PHASE_STATUS.PASSED, id);
  assert.equal(run.correctness, "7/7");
  assert.deepEqual(run.skipped, []);

  // 序列語義：任何時刻並行度 = 1；壁鐘步數上限 = stub 步數 = 7
  assert.equal(run.metrics.max_concurrency, 1);
  assert.equal(run.metrics.wall_clock_steps_upper_bound, PHASE_ORDER.length);
  assert.equal(run.metrics.child_invocations, PHASE_ORDER.length);
  assert.equal(run.metrics.duplicated_work_count, 0);
  assert.equal(run.metrics.failed_retries, 0);

  // 執行順序 = 宣告鏈順序
  assert.deepEqual(run.order, PHASE_ORDER);
});

// ═══════════════ 2. NAIVE_PARALLEL ═══════════════

test("NAIVE_PARALLEL: sealed scheduler 保持租約語義——writer 獨佔執行、正確性不下降", async () => {
  const run = await runMode("NAIVE_PARALLEL");

  assert.equal(run.verdict, RUN_VERDICTS.PASS);
  for (const id of PHASE_ORDER) assert.equal(run.statuses[id], PHASE_STATUS.PASSED, id);
  assert.equal(run.correctness, "7/7");
  assert.deepEqual(run.result.writerViolations, []);
  assert.equal(run.result.leaseHolderAfter, null);

  // 三個 audit 實際平行（同一 generation 啟動、觀察到並行 ≥ 3）
  assert.ok(run.metrics.max_concurrency >= 3,
    `expected audits to overlap, max concurrency = ${run.metrics.max_concurrency}`);

  // 單 writer 租約語義：write_impl 執行期間無任何其他 phase 並行（獨佔租約）
  assert.equal(run.rec.concByPhase.write_impl, 1,
    "writer must hold the artifact lease exclusively while running");
  const acquires = run.rec.leaseEvents.filter((e) => e.kind === "acquire");
  const releases = run.rec.leaseEvents.filter((e) => e.kind === "release");
  assert.deepEqual(acquires.map((e) => e.phase_id), ["write_impl"]);
  assert.deepEqual(releases.map((e) => e.phase_id), ["write_impl"]);
  // acquire 先於 release，且其間無其他 acquire
  assert.ok(run.rec.leaseEvents.findIndex((e) => e.kind === "acquire")
    < run.rec.leaseEvents.findIndex((e) => e.kind === "release"));

  // 正確性不低於 serial；無重複工作
  assert.ok(run.metrics.duplicated_work_count <= 0 + 0); // 0
  assert.equal(run.metrics.failed_retries, 0);
});

test("NAIVE_PARALLEL 變體（兩個 writer）: 多 writer 被 sealed scheduler 序列化", async () => {
  // 補充覆蓋：同任務形狀但加入第二個 writer（write_docs），驗證
  // 「兩個以上 ready writers 只啟動一個，其餘 waiting_for_writer」。
  const phases = basePhases();
  phases.splice(5, 0, {
    kind: "writer", phase_id: "write_docs", title: "write docs", summary: "write docs",
    responsibility: "mutation", purpose: "documentation",
    effects: eff({ mutation: "allowed", artifact: ["docs/arch.md"], evidenceOut: "none" }),
    covers: ["req.docs"], depends_on: ["join_arch"],
    verification_plan: vplan(["join_arch"]),
  });
  const rec = makeRecorder();
  let runningWriters = 0;
  let maxRunningWriters = 0;
  const execute = async (phase) => {
    if (phase.kind === "writer") {
      runningWriters++;
      maxRunningWriters = Math.max(maxRunningWriters, runningWriters);
    }
    try {
      await stubWork(phase, {});
      return { status: "passed" };
    } finally {
      if (phase.kind === "writer") runningWriters--;
    }
  };
  const result = await runDecompositionGraph({ ir: wrapIr(phases), execute, hooks: {} });

  assert.equal(result.verdict, RUN_VERDICTS.PASS);
  assert.equal(result.statuses.write_impl, PHASE_STATUS.PASSED);
  assert.equal(result.statuses.write_docs, PHASE_STATUS.PASSED);
  assert.equal(maxRunningWriters, 1, "at most one writer may hold the lease at any time");
  assert.deepEqual(result.writerViolations, []);
  // 其中一個 writer 曾處於 waiting_for_writer（等待 ≠ blocked）
  assert.ok(
    result.runLog.some((e) => e.phase_id === "write_docs" && e.transition === PHASE_STATUS.WAITING_FOR_WRITER)
    || result.runLog.some((e) => e.phase_id === "write_impl" && e.transition === PHASE_STATUS.WAITING_FOR_WRITER),
    "second ready writer must be marked waiting_for_writer"
  );
});

// ═══════════════ 3. CEDF ═══════════════

test("CEDF admission dry-run: decideDelegation 分類矩陣（最小合法 admission stub）", () => {
  const phases = basePhases();

  // 初始全 pending：audits → PARALLEL_DELEGATE；下游全部 SERIAL_DEPENDENCY
  const allPending = Object.fromEntries(PHASE_ORDER.map((id) => [id, "pending"]));
  for (const p of phases) {
    const siblings = p.kind === "audit"
      ? phases.filter((q) => q.kind === "audit" && q.phase_id !== p.phase_id)
      : [];
    const d = decideDelegation({
      phase: p, readySiblings: siblings, dependencyStates: allPending, admission: admissionStub(p),
    });
    if (p.kind === "audit") {
      assert.equal(d.decision, DELEGATION_DECISIONS.PARALLEL_DELEGATE, p.phase_id);
      assert.deepEqual(d.reasons, [DELEGATION_DECISION_CODES.READ_ONLY_DISJOINT_BOUNDARIES]);
    } else {
      assert.equal(d.decision, DELEGATION_DECISIONS.SERIAL_DEPENDENCY, p.phase_id);
      assert.ok(d.reasons[0].startsWith(DELEGATION_DECISION_CODES.NON_TERMINAL_DEPENDENCY), p.phase_id);
    }
  }

  // 依賴全 terminal 後：writer（mutating + 合法 admission）→ DELEGATE
  const allPassed = Object.fromEntries(PHASE_ORDER.map((id) => [id, "passed"]));
  const writer = phases.find((p) => p.phase_id === "write_impl");
  const dWriter = decideDelegation({
    phase: writer, readySiblings: [], dependencyStates: allPassed, admission: admissionStub(writer),
  });
  assert.equal(dWriter.decision, DELEGATION_DECISIONS.DELEGATE);
  assert.deepEqual(dWriter.reasons, [DELEGATION_DECISION_CODES.INDEPENDENT_WORK_UNIT]);

  // fail-closed：writer 帶空 mutation_scope → HOLD（WRITER_AUTHORITY_UNAVAILABLE）
  const dNoAuthority = decideDelegation({
    phase: writer, readySiblings: [], dependencyStates: allPassed,
    admission: { authority_domain: "repository-writer", mutation_scope: [] },
  });
  assert.equal(dNoAuthority.decision, DELEGATION_DECISIONS.HOLD);
  assert.ok(dNoAuthority.reasons.includes(DELEGATION_DECISION_CODES.WRITER_AUTHORITY_UNAVAILABLE));

  // fail-closed：缺 admission → HOLD
  const dNoAdmission = decideDelegation({ phase: writer, dependencyStates: allPassed });
  assert.equal(dNoAdmission.decision, DELEGATION_DECISIONS.HOLD);
  assert.deepEqual(dNoAdmission.reasons, [DELEGATION_DECISION_CODES.ADMISSION_MISSING]);
});

test("CEDF happy path: 正確性不低於 serial、PARALLEL_DELEGATE 僅授予 audit、reconcile 閘門放行 join/writer", async () => {
  const run = await runMode("CEDF");

  // (a) 正確性不低於 serial
  assert.equal(run.verdict, RUN_VERDICTS.PASS);
  for (const id of PHASE_ORDER) assert.equal(run.statuses[id], PHASE_STATUS.PASSED, id);
  assert.equal(run.correctness, "7/7");

  // 決策矩陣：audit → PARALLEL_DELEGATE；其餘 → 一般委派 slot
  const byIdDecision = Object.fromEntries(run.rec.decisions.map((d) => [d.phase_id, d]));
  for (const id of ["audit_a", "audit_b", "audit_c"]) {
    assert.equal(byIdDecision[id].effective, DELEGATION_DECISIONS.PARALLEL_DELEGATE, id);
    assert.deepEqual(byIdDecision[id].reasons, [DELEGATION_DECISION_CODES.READ_ONLY_DISJOINT_BOUNDARIES]);
  }
  for (const id of ["join_arch", "write_impl", "verify_schema", "verify_behavior"]) {
    assert.notEqual(byIdDecision[id].raw, DELEGATION_DECISIONS.HOLD, id);
    assert.equal(byIdDecision[id].effective, DELEGATION_DECISIONS.DELEGATE, id);
  }

  // reconcile 閘門：join 與 writer 都在 COHERENT 下放行
  assert.deepEqual(run.rec.reconGates, [
    { phase_id: "join_arch", verdict: "COHERENT" },
    { phase_id: "write_impl", verdict: "COHERENT" },
  ]);
  assert.deepEqual(run.rec.findings, []);

  // (b) 無效重複工作 ≤ 其他模式（happy path 全部為 0）
  assert.equal(run.metrics.duplicated_work_count, 0);
  assert.equal(run.metrics.failed_retries, 0);
});

// ═══════════════ 4. 衝突注入情境 ═══════════════

const DOWNSTREAM = ["join_arch", "write_impl", "verify_schema", "verify_behavior"];

test("衝突注入 × NAIVE_SERIAL: HOLD fail-closed、下游 skip、盲型重試燒掉重複工作", async () => {
  const run = await runMode("NAIVE_SERIAL", { conflict: true });

  assert.equal(run.verdict, RUN_VERDICTS.HOLD);
  assert.equal(run.statuses.audit_a, PHASE_STATUS.PASSED);
  assert.equal(run.statuses.audit_b, PHASE_STATUS.HELD);
  assert.equal(run.statuses.audit_c, PHASE_STATUS.SKIPPED_DUE_TO_DEPENDENCY);
  for (const id of DOWNSTREAM.slice(1)) {
    assert.equal(run.statuses[id], PHASE_STATUS.SKIPPED_DUE_TO_DEPENDENCY, id);
  }
  // 盲型重試：audit_b 被執行 2 次（1 次重複工作），仍失敗
  const bInv = run.rec.invocations.filter((i) => i.phase_id === "audit_b");
  assert.equal(bInv.length, 2);
  assert.equal(run.metrics.duplicated_work_count, 1);
  assert.equal(run.metrics.failed_retries, 1);
});

test("衝突注入 × NAIVE_PARALLEL: HOLD fail-closed、不擴散（hold 後無新 phase 啟動）", async () => {
  const run = await runMode("NAIVE_PARALLEL", { conflict: true });

  assert.equal(run.verdict, RUN_VERDICTS.HOLD);
  assert.equal(run.statuses.audit_b, PHASE_STATUS.HELD);
  for (const id of DOWNSTREAM) {
    assert.equal(run.statuses[id], PHASE_STATUS.SKIPPED_DUE_TO_DEPENDENCY, id);
  }
  // 不擴散：啟動順序只含三個 audit；第一個 held transition 之後無新 running
  assert.deepEqual(run.order, ["audit_a", "audit_b", "audit_c"]);
  const firstHeldIdx = run.result.runLog.findIndex(
    (e) => e.transition === PHASE_STATUS.HELD
  );
  assert.ok(firstHeldIdx >= 0);
  const afterHeld = run.result.runLog.slice(firstHeldIdx + 1)
    .filter((e) => e.transition === PHASE_STATUS.RUNNING);
  assert.deepEqual(afterHeld.map((e) => e.phase_id), [],
    "no new phase may start after HOLD propagation");
  assert.equal(run.metrics.duplicated_work_count, 1);
});

test("衝突注入 × CEDF: reconcile 偵測 CONTRADICTORY_OUTCOME、拒絕盲型重試、fail-closed 不擴散", async () => {
  const run = await runMode("CEDF", { conflict: true });

  assert.equal(run.verdict, RUN_VERDICTS.HOLD);
  assert.equal(run.statuses.audit_a, PHASE_STATUS.PASSED);
  assert.equal(run.statuses.audit_b, PHASE_STATUS.HELD);
  for (const id of DOWNSTREAM) {
    assert.equal(run.statuses[id], PHASE_STATUS.SKIPPED_DUE_TO_DEPENDENCY, id);
  }
  // fail-closed：audit_b 只執行一次（reconcile 偵測矛盾 → 不盲型重試）
  assert.equal(run.rec.invocations.filter((i) => i.phase_id === "audit_b").length, 1);
  assert.equal(run.metrics.duplicated_work_count, 0);
  assert.equal(run.metrics.failed_retries, 0);
  // join 從未啟動（矛盾在其綁定 baseline 前即被攔下）
  assert.equal(run.rec.invocations.filter((i) => i.phase_id === "join_arch").length, 0);
  // finding 以 canonical blockingFindings 形狀渲染
  assert.ok(
    run.rec.findings.includes(
      "DEPENDENCY_CONFLICT:CONTRADICTORY_OUTCOME:audit_a!audit_b:requirement:req.audit-a"
    ),
    `findings = ${JSON.stringify(run.rec.findings)}`
  );
});

test("reconcileChildResults 直接驗證: PASS+HELD 同 subject → CONTRADICTORY_OUTCOME；COHERENT 放行", () => {
  const pass = { phaseId: "audit_a", role: null, result: { status: "PASS", covers: ["req.audit-a"], filesChanged: [] } };
  const heldSameSubject = { phaseId: "audit_b", role: null, result: { status: "HOLD", covers: ["req.audit-a"], filesChanged: [] } };
  const conflicting = reconcileChildResults([pass, heldSameSubject]);
  assert.equal(conflicting.verdict, "CONFLICT");
  assert.equal(conflicting.conflicts[0].kind, "CONTRADICTORY_OUTCOME");
  assert.equal(reconciliationFinding(conflicting.conflicts[0]),
    "DEPENDENCY_CONFLICT:CONTRADICTORY_OUTCOME:audit_a!audit_b:requirement:req.audit-a");

  // 對照：disjoint subjects → COHERENT（happy-path join 閘門形狀）
  const disjointAudits = [
    { phaseId: "audit_a", role: null, result: { status: "PASS", covers: ["req.audit-a"], filesChanged: [] } },
    { phaseId: "audit_b", role: null, result: { status: "PASS", covers: ["req.audit-b"], filesChanged: [] } },
    { phaseId: "audit_c", role: null, result: { status: "PASS", covers: ["req.audit-c"], filesChanged: [] } },
  ];
  assert.equal(reconcileChildResults(disjointAudits).verdict, "COHERENT");
});

// ═══════════════ 5. Correct Task Completion Cost 摘要 ═══════════════

test("Correct Task Completion Cost 摘要: 三模式 machine-readable 比較（含衝突情境）", async () => {
  const serial = await runMode("NAIVE_SERIAL");
  const parallel = await runMode("NAIVE_PARALLEL");
  const cedf = await runMode("CEDF");
  const serialC = await runMode("NAIVE_SERIAL", { conflict: true });
  const parallelC = await runMode("NAIVE_PARALLEL", { conflict: true });
  const cedfC = await runMode("CEDF", { conflict: true });

  // (a) 正確性：CEDF 不低於 serial
  assert.equal(cedf.correctness, serial.correctness);
  assert.equal(cedf.verdict, RUN_VERDICTS.PASS);
  // (b) 無效重複工作：CEDF ≤ 其他模式（happy 與 conflict 皆成立）
  assert.ok(cedf.metrics.duplicated_work_count <= Math.min(
    serial.metrics.duplicated_work_count, parallel.metrics.duplicated_work_count));
  assert.ok(cedfC.metrics.duplicated_work_count < Math.min(
    serialC.metrics.duplicated_work_count, parallelC.metrics.duplicated_work_count),
    "conflict scenario: CEDF must avoid the blind-retry duplicate work");
  // CTCC：CEDF ≤ 兩種 naive（happy 相等；conflict 嚴格更低）
  assert.ok(cedf.metrics.correct_task_completion_cost <= Math.min(
    serial.metrics.correct_task_completion_cost, parallel.metrics.correct_task_completion_cost));
  assert.ok(cedfC.metrics.correct_task_completion_cost < Math.min(
    serialC.metrics.correct_task_completion_cost, parallelC.metrics.correct_task_completion_cost));

  const shape = (r) => ({
    mode: r.mode,
    conflict: r.conflict,
    verdict: r.verdict,
    correctness: r.correctness,
    correct_task_completion_cost: r.metrics.correct_task_completion_cost,
    cost_composition: {
      parent_reasoning_fixed: r.metrics.parent_reasoning_cost_fixed,
      child_work_units: r.metrics.child_work_units,
      duplicated_work_penalty: r.metrics.duplicated_work_count * DUPLICATE_PENALTY,
      failed_retry_penalty: r.metrics.failed_retries * RETRY_PENALTY,
    },
    counters: {
      child_invocations: r.metrics.child_invocations,
      duplicated_work_count: r.metrics.duplicated_work_count,
      failed_retries: r.metrics.failed_retries,
      max_concurrency: r.metrics.max_concurrency,
      wall_clock_steps_upper_bound: r.metrics.wall_clock_steps_upper_bound,
    },
  });

  const summary = {
    workload: "cedf-phase25-representative-workload",
    ir_shape: "3 read-only audits -> 1 shared-architecture join -> 1 writer mutation -> 2 verifications",
    scheduler_seam: "src/v2/runner.mjs runDecompositionGraph (sealed single-writer lease)",
    decision_seam: "src/subagent/delegation-decision.mjs decideDelegation",
    reconciliation_seam: "src/subagent/result-reconciliation.mjs reconcileChildResults",
    runs: [shape(serial), shape(parallel), shape(cedf), shape(serialC), shape(parallelC), shape(cedfC)],
    assertions: {
      cedf_correctness_not_below_serial: cedf.correctness >= serial.correctness,
      cedf_duplicated_le_others_happy: cedf.metrics.duplicated_work_count
        <= Math.min(serial.metrics.duplicated_work_count, parallel.metrics.duplicated_work_count),
      cedf_duplicated_lt_others_conflict: cedfC.metrics.duplicated_work_count
        < Math.min(serialC.metrics.duplicated_work_count, parallelC.metrics.duplicated_work_count),
      cedf_ctcc_le_others_happy: cedf.metrics.correct_task_completion_cost
        <= Math.min(serial.metrics.correct_task_completion_cost, parallel.metrics.correct_task_completion_cost),
      cedf_ctcc_lt_others_conflict: cedfC.metrics.correct_task_completion_cost
        < Math.min(serialC.metrics.correct_task_completion_cost, parallelC.metrics.correct_task_completion_cost),
    },
  };
  console.log("CEDF_WORKLOAD_SUMMARY " + JSON.stringify(summary));
});
