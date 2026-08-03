// src/v2/runner.mjs
//
// V2 Card 5 — Runner scheduler + ArtifactWriterLease（single-writer hard gate）。
//
// 核心規則（runtime hard gate，不是 decomposition shape gate）：
//  - repository writer 判定只依 effects.artifact_mutation ∈ {allowed, required}；
//  - evidence_output=persistent 不自動等於 writer；只有其 evidence boundary 指向
//    repository artifact 時才取得 artifact writer lease；
//  - 同一 workspace 同時最多一個 lease 持有者；
//  - 只有 ready phase 能請求 lease；phase 啟動前取得、terminal 後釋放；
//  - PASS/HOLD/error/abort 均釋放；
//  - 不得由 phase title/ID/responsibility 字串判斷 writer；
//  - 不得修改 DAG 以序列化 writers；不得自動補 dependency edge；
//  - 多個 ready writers：只啟動一個，其餘維持 ready/waiting-for-writer；
//    deterministic tie-break = 原始 phase declaration order，再以 phase_id 穩定排序；
//  - 因等待 writer lease 不判定為 blocked；
//  - failure propagation：任一 phase HOLD/failed → 釋放 lease、依賴它的後續 phase
//    skipped_due_to_dependency、不得啟動其他 writer phase、整體 run verdict = HOLD。
//
// 本檔不判定 correctness（H1–H12 由 scorecard）；只排程。

export const PHASE_STATUS = Object.freeze({
  PENDING: "pending",
  READY: "ready",
  WAITING_FOR_WRITER: "waiting_for_writer",
  RUNNING: "running",
  PASSED: "passed",
  HELD: "held",
  FAILED: "failed",
  SKIPPED_DUE_TO_DEPENDENCY: "skipped_due_to_dependency",
});

export const RUN_VERDICTS = Object.freeze({ PASS: "PASS", HOLD: "HOLD" });

// Evidence boundary entries that point OUTSIDE the repository workspace.
// 資料導向分類（非字串語意推論）：外部 scheme 前綴為顯式清單。
export const EXTERNAL_BOUNDARY_PREFIXES = Object.freeze([
  "external:", "sandbox:", "db:", "http://", "https://", "ftp://",
  "s3://", "gs://", "memory:", "env:",
]);

/**
 * 判定 evidence boundary entry 是否指向 repository artifact。
 * @param {unknown} entry
 */
export function isRepoPathEntry(entry) {
  const s = String(entry);
  return !EXTERNAL_BOUNDARY_PREFIXES.some((p) => s.startsWith(p));
}

/**
 * Repository writer 判定 — 只依 effects.artifact_mutation。
 * title/ID/responsibility 字串一律不參與。
 * @param {object} phase
 */
export function isRepositoryWriter(phase) {
  const am = phase?.effects?.artifact_mutation;
  return am === "allowed" || am === "required";
}

/**
 * Persistent evidence 是否指向 repository artifact 而取得 writer lease。
 * @param {object} phase
 */
export function acquiresEvidenceWriterLease(phase) {
  if (phase?.effects?.evidence_output !== "persistent") return false;
  const evidence = phase?.effects?.boundaries?.evidence || [];
  return evidence.some((e) => isRepoPathEntry(e));
}

/**
 * Phase 是否需要在 runner 取得 artifact writer lease。
 * @param {object} phase
 */
export function requiresWriterLease(phase) {
  return isRepositoryWriter(phase) || acquiresEvidenceWriterLease(phase);
}

export class WriterLeaseBusyError extends Error {
  constructor(workspace, holder, phaseId) {
    super(`[writer-lease] workspace "${workspace}" already held by ${holder}; ${phaseId} denied`);
    this.code = "WRITER_LEASE_BUSY";
    this.name = "WriterLeaseBusyError";
  }
}

/**
 * ArtifactWriterLease — 同一 workspace 單一持有者。
 */
export class ArtifactWriterLease {
  constructor(workspace = "workspace") {
    this.workspace = workspace;
    this.holder = null;
  }

  isHeld() {
    return this.holder !== null;
  }

  /**
   * 取得 lease。phase 必須為 ready（由 runner 調用前保證）。
   * @returns {{ok: boolean, holder: string|null}}
   */
  acquire(phase) {
    if (this.holder !== null) {
      return { ok: false, holder: this.holder, error: new WriterLeaseBusyError(this.workspace, this.holder, phase?.phase_id) };
    }
    this.holder = phase?.phase_id ?? null;
    return { ok: true, holder: this.holder };
  }

  /** 釋放 lease（冪等）。 */
  release() {
    this.holder = null;
  }
}

function declIndexMap(ir) {
  const m = new Map();
  (ir.phases || []).forEach((p, i) => m.set(p.phase_id, i));
  return m;
}

function tieBreak(ir) {
  const decl = declIndexMap(ir);
  return (a, b) => {
    const da = decl.get(a.phase_id) ?? Number.MAX_SAFE_INTEGER;
    const db = decl.get(b.phase_id) ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a.phase_id < b.phase_id ? -1 : a.phase_id > b.phase_id ? 1 : 0;
  };
}

function transitiveDependents(dependentsOf, startId) {
  const out = new Set();
  const stack = [...(dependentsOf.get(startId) || [])];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;
    out.add(cur);
    stack.push(...(dependentsOf.get(cur) || []));
  }
  return out;
}

/**
 * 排程並執行 v2 decomposition DAG。
 *
 * @param {object} opts
 * @param {object} opts.ir — DECOMPOSED IR（含 phases/depends_on）
 * @param {Function} [opts.execute] — async (phase, ctx) => { status: "passed"|"held"|"failed", note? }
 * @param {object} [opts.hooks] — { onLease, onStatus }
 * @param {string} [opts.workspace]
 * @param {AbortSignal} [opts.signal] — abort 時釋放 lease 並停止
 * @returns {Promise<{
 *   verdict: "PASS"|"HOLD",
 *   statuses: object, order: string[], runLog: object[],
 *   skipped: string[], writerViolations: string[],
 *   leaseHolderAfter: string|null, phases: object[]
 * }>}
 */
export async function runDecompositionGraph({ ir, execute, hooks = {}, workspace = "workspace", signal } = {}) {
  const phases = (ir?.phases || []).map((p) => ({ ...p, depends_on: [...(p.depends_on || [])] }));
  const byId = new Map(phases.map((p) => [p.phase_id, p]));
  const decl = declIndexMap(ir);

  // 建圖：只讀 depends_on；絕不新增 edge（runner 不得修改 DAG）。
  const depOf = new Map();
  const dependentsOf = new Map();
  for (const p of phases) {
    depOf.set(p.phase_id, (p.depends_on || []).filter((d) => byId.has(d)));
    dependentsOf.set(p.phase_id, []);
  }
  for (const p of phases) {
    for (const d of depOf.get(p.phase_id)) dependentsOf.get(d).push(p.phase_id);
  }

  const status = new Map();
  for (const p of phases) status.set(p.phase_id, PHASE_STATUS.PENDING);

  const lease = new ArtifactWriterLease(workspace);
  const runLog = [];
  const writerViolations = [];
  const order = [];
  const log = (phase_id, transition, writer) => {
    runLog.push({ phase_id, transition, writer: !!writer });
    hooks.onStatus?.(phase_id, transition, writer);
  };

  const pendingRun = new Map(); // phase_id -> promise

  const runPhase = async (phaseId) => {
    const phase = byId.get(phaseId);
    const writer = requiresWriterLease(phase);
    if (writer) {
      const acq = lease.acquire(phase);
      if (!acq.ok) {
        writerViolations.push(`${phaseId}: ${acq.error.message}`);
        status.set(phaseId, PHASE_STATUS.FAILED);
        log(phaseId, PHASE_STATUS.FAILED, true);
        return;
      }
      hooks.onLease?.({ kind: "acquire", phase_id: phaseId, workspace });
      log(phaseId, "lease_acquired", true);
    }
    status.set(phaseId, PHASE_STATUS.RUNNING);
    log(phaseId, PHASE_STATUS.RUNNING, writer);
    let result;
    try {
      result = await execute(phase, { ir, byId, runLog });
    } catch (e) {
      result = { status: "failed", note: String(e?.message || e) };
    }
    if (signal?.aborted) result = { status: "failed", note: "aborted" };
    const final = result?.status === "passed" ? PHASE_STATUS.PASSED
      : result?.status === "held" ? PHASE_STATUS.HELD
        : PHASE_STATUS.FAILED;
    if (writer) {
      lease.release();
      hooks.onLease?.({ kind: "release", phase_id: phaseId, workspace });
      log(phaseId, "lease_released", true);
    }
    status.set(phaseId, final);
    log(phaseId, final, writer);
  };

  const startPhase = (phaseId) => {
    const phase = byId.get(phaseId);
    const writer = requiresWriterLease(phase);
    status.set(phaseId, PHASE_STATUS.READY);
    log(phaseId, PHASE_STATUS.READY, writer);
    if (writer) {
      status.set(phaseId, PHASE_STATUS.RUNNING); // acquire 於 runPhase 內
    }
    order.push(phaseId);
    const p = runPhase(phaseId).finally(() => pendingRun.delete(phaseId));
    pendingRun.set(phaseId, p);
    return p;
  };

  const isTerminal = (s) =>
    s === PHASE_STATUS.PASSED || s === PHASE_STATUS.HELD || s === PHASE_STATUS.FAILED || s === PHASE_STATUS.SKIPPED_DUE_TO_DEPENDENCY;

  const depsPassed = (phaseId) => depOf.get(phaseId).every((d) => status.get(d) === PHASE_STATUS.PASSED);

  let holdTriggered = false;
  let verdict = RUN_VERDICTS.PASS;

  // ── 主迴圈（deterministic）──
  while (true) {
    if (signal?.aborted) {
      holdTriggered = true;
      verdict = RUN_VERDICTS.HOLD;
      break;
    }

    // 1) 檢查已終止之 HOLD/failed → 停止排程、標記下游 skipped、整體 HOLD
    const failures = phases
      .filter((p) => status.get(p.phase_id) === PHASE_STATUS.HELD || status.get(p.phase_id) === PHASE_STATUS.FAILED)
      .sort(tieBreak(ir));
    if (failures.length > 0 && !holdTriggered) {
      holdTriggered = true;
      verdict = RUN_VERDICTS.HOLD;
      const failedIds = new Set(failures.map((p) => p.phase_id));
      const skipped = new Set();
      for (const f of failures) {
        for (const d of transitiveDependents(dependentsOf, f.phase_id)) skipped.add(d);
      }
      for (const s of skipped) {
        if (!failedIds.has(s) && !isTerminal(status.get(s))) {
          status.set(s, PHASE_STATUS.SKIPPED_DUE_TO_DEPENDENCY);
          const w = requiresWriterLease(byId.get(s));
          log(s, PHASE_STATUS.SKIPPED_DUE_TO_DEPENDENCY, w);
        }
      }
    }

    if (holdTriggered) {
      // 不再啟動任何新 phase；等待已在跑的 phase 結束（其 lease 於 terminal 釋放）。
      if (pendingRun.size === 0) break;
      await Promise.all([...pendingRun.values()]);
      continue;
    }

    // 2) 找出 eligible phases（deps 全 passed 且未終止；含已 waiting_for_writer 的 ready）
    const eligible = phases.filter((p) => {
      const s = status.get(p.phase_id);
      if (isTerminal(s) || s === PHASE_STATUS.RUNNING) return false;
      return depsPassed(p.phase_id);
    });
    if (eligible.length === 0 && pendingRun.size === 0) break;

    const readyWriters = eligible.filter((p) => requiresWriterLease(p)).sort(tieBreak(ir));
    const readyOthers = eligible.filter((p) => !requiresWriterLease(p)).sort(tieBreak(ir));

    // 3) writer 判定：只有準備啟動的 writer 才算持有；其餘 ready writers 標 waiting_for_writer
    const writerRunning = [...pendingRun.keys()].some((id) => requiresWriterLease(byId.get(id)));

    // 4) 決定本輪啟動集合：最多一個 ready writer（deterministic tie-break 第一個）
    const starts = [];
    let firstWriter = null;
    if (!writerRunning && readyWriters.length > 0) {
      firstWriter = readyWriters[0];
      starts.push(firstWriter);
    }
    for (const o of readyOthers) starts.push(o);

    // 5) 標記未啟動的 ready writers 為 waiting_for_writer（waiting ≠ blocked）
    const deferredWriters = readyWriters.filter((w) => w !== firstWriter);
    for (const w of deferredWriters) {
      if (status.get(w.phase_id) !== PHASE_STATUS.WAITING_FOR_WRITER) {
        status.set(w.phase_id, PHASE_STATUS.WAITING_FOR_WRITER);
        log(w.phase_id, PHASE_STATUS.WAITING_FOR_WRITER, true);
      }
    }
    if (writerRunning) {
      for (const w of readyWriters) {
        if (status.get(w.phase_id) !== PHASE_STATUS.WAITING_FOR_WRITER) {
          status.set(w.phase_id, PHASE_STATUS.WAITING_FOR_WRITER);
          log(w.phase_id, PHASE_STATUS.WAITING_FOR_WRITER, true);
        }
      }
    }

    // 6) non-writers 可與 writer 並行；等待 writer lease 不判定為 blocked
    const startPromises = starts.map((p) => startPhase(p.phase_id));
    if (startPromises.length) {
      await Promise.all(startPromises);
    } else if (pendingRun.size === 0) {
      // 全部 waiting_for_writer 且無在跑 → 死結不可發生（writer 終究會釋放）；安全防護 break
      break;
    }
  }

  // 等待殘餘
  if (pendingRun.size) await Promise.all([...pendingRun.values()]);

  const skipped = phases.filter((p) => status.get(p.phase_id) === PHASE_STATUS.SKIPPED_DUE_TO_DEPENDENCY).map((p) => p.phase_id);
  const statuses = Object.fromEntries([...status.entries()]);

  return {
    verdict,
    statuses,
    order,
    runLog,
    skipped,
    writerViolations,
    leaseHolderAfter: lease.holder,
    phases,
  };
}

/**
 * 同步排程模擬（tests 用）：以 stub executor 直接執行，回傳完整排程。
 */
export async function simulateSchedule(ir, opts = {}) {
  const results = new Map();
  const execute = opts.execute || (async (phase) => ({ status: phase._simStatus || "passed" }));
  return runDecompositionGraph({
    ir,
    execute,
    hooks: opts.hooks,
    workspace: opts.workspace,
    signal: opts.signal,
  });
}
