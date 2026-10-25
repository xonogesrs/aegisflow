// src/attention/attention.mjs
//
// Read-only "needs your attention" aggregator.
//
// Autonomous evolution and durable execution both finish work without asking.
// What an operator still has to decide (MEDIUM promotions), or must know about
// (breaker tripped, rollback, expired policy, interrupted/corrupt runs), would
// otherwise sit unseen until someone goes looking. This module collects those
// items, applies accumulation thresholds, and says whether to raise an alert.
//
// AUTHORITY FENCE: advisory only. `collectAttention` performs zero writes and
// no production authority consumes its output. The only write in this module is
// `acknowledge`, an explicit operator act that records "seen" for item keys in a
// small state file; it never touches evolution, checkpoint or journal state.

import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { buildEvolutionReport } from "../evolution/operator-view.mjs";
import { classifyResumeCapability, readCheckpoint } from "../v2/checkpoint-bridge.mjs";
import { validateExecutionId } from "../c2d/execution-id.mjs";
import { currentPath } from "../c2d/checkpoint-store.mjs";

export const ATTENTION_REPORT_SCHEMA = "aegisflow.attention-report/v1";
export const ATTENTION_STATE_SCHEMA = "aegisflow.attention-state/v1";

/** Accumulation thresholds. INFO items become ALERT once a threshold is crossed. */
export const DEFAULT_ATTENTION_THRESHOLDS = Object.freeze({
  pendingMediumCount: 3,
  pendingMediumAgeHours: 24,
  interruptedStaleMinutes: 10,
});

const MAX_EXEC_DIRS_SCANNED = 500;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_ACK_ENTRIES = 1000;
const STATE_FILE = "attention-state.json";

function digestKey(parts) {
  return String(parts.join("|")).replace(/[^A-Za-z0-9_.:|-]/g, "_").slice(0, 160);
}

function hoursSince(iso, now) {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? Math.max(0, (now - t) / 3_600_000) : null;
}

// ---------- acknowledgement state (the only write path) ----------

export function readAttentionState(stateDir) {
  const empty = { schema: ATTENTION_STATE_SCHEMA, acknowledged: {} };
  if (!stateDir) return empty;
  const p = join(stateDir, STATE_FILE);
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_STATE_BYTES) return empty;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (parsed?.schema !== ATTENTION_STATE_SCHEMA || typeof parsed.acknowledged !== "object" || parsed.acknowledged === null) return empty;
    return parsed;
  } catch {
    return empty;
  }
}

/** Record that the operator has seen these item keys. Explicit operator act. */
export function acknowledge({ stateDir, keys, now = Date.now() }) {
  if (!stateDir) throw new Error("ATTENTION_STATE_DIR_REQUIRED: acknowledging needs a state directory");
  const state = readAttentionState(stateDir);
  const at = new Date(now).toISOString();
  for (const k of keys) state.acknowledged[k] = at;
  const entries = Object.entries(state.acknowledged).sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, MAX_ACK_ENTRIES);
  state.acknowledged = Object.fromEntries(entries);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const target = join(stateDir, STATE_FILE);
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, target);
  return { acknowledged: keys.length, at };
}

// ---------- collectors (read-only) ----------

function evolutionItems({ evolutionStoreRoot, env, now, thresholds }) {
  const items = [];
  const diagnostics = [];
  if (!evolutionStoreRoot) return { items, diagnostics, summary: null };
  const r = buildEvolutionReport({ storeRoot: evolutionStoreRoot, env });
  for (const d of r.diagnostics) {
    if (d.code === "NO_EVOLUTION_STORE") diagnostics.push(d);
  }

  if (r.circuitBreaker.state === "TRIPPED") {
    items.push({
      key: digestKey(["breaker", r.circuitBreaker.trippedAt]), kind: "EVOLUTION_BREAKER_TRIPPED", severity: "ALERT",
      count: 1, since: r.circuitBreaker.trippedAt,
      summary: `進化迴圈的 circuit breaker 已跳開(${String(r.circuitBreaker.reason ?? "").slice(0, 80)}),自動進化已停止`,
      action: "node scripts/evolution-operator.mjs --store <dir>",
    });
  }
  if (r.policy.state === "EXPIRED") {
    items.push({
      key: digestKey(["policy-expired", r.policy.expiresAt]), kind: "EVOLUTION_POLICY_EXPIRED", severity: "ALERT",
      count: 1, since: r.policy.expiresAt,
      summary: "進化 policy 已過期,自動進化不會再啟動",
      action: "node scripts/evolution-issue-policy.mjs --store <dir> --successor",
    });
  }
  for (const rb of r.rollbacks) {
    items.push({
      key: digestKey(["rollback", rb.candidate_id]), kind: "EVOLUTION_ROLLBACK", severity: "ALERT",
      count: 1, since: null,
      summary: `候選 ${String(rb.candidate_id).slice(0, 16)} 在 canary 期間被回滾`,
      action: "node scripts/evolution-operator.mjs --store <dir>",
    });
  }

  const pending = r.candidates.filter((c) => c.risk_class === "MEDIUM" && !c.promotion?.promoted && !c.canary?.rolled_back);
  if (pending.length > 0) {
    const oldest = pending.map((c) => hoursSince(c.created_at, now)).filter((h) => h !== null).sort((a, b) => b - a)[0] ?? null;
    const crossed = pending.length >= thresholds.pendingMediumCount || (oldest !== null && oldest >= thresholds.pendingMediumAgeHours);
    items.push({
      key: digestKey(["medium-pending", ...pending.map((c) => c.candidate_id).sort()]), kind: "EVOLUTION_MEDIUM_PENDING",
      severity: crossed ? "ALERT" : "INFO", count: pending.length,
      since: pending.map((c) => c.created_at).filter(Boolean).sort()[0] ?? null,
      summary: `${pending.length} 個 MEDIUM 進化候選已自動評估完,等你批准升級${oldest !== null ? `(最早 ${Math.floor(oldest)} 小時前)` : ""}`,
      action: "node scripts/evolution-operator.mjs --store <dir>",
    });
  }

  const autoPromoted = r.candidates.filter((c) => c.risk_class === "LOW" && c.promotion?.promoted);
  const summary = { autoPromotedLow: autoPromoted.length, candidates: r.candidates.length, triggers: r.triggers.count };
  if (autoPromoted.length > 0) {
    items.push({
      key: digestKey(["auto-low", ...autoPromoted.map((c) => c.candidate_id).sort()]), kind: "EVOLUTION_AUTO_ACTIVITY", severity: "INFO",
      count: autoPromoted.length, since: null,
      summary: `${autoPromoted.length} 個 LOW 風險改進已自動升級(僅供知悉)`,
      action: "node scripts/evolution-operator.mjs --store <dir>",
    });
  }
  return { items, diagnostics, summary };
}

function executionItems({ checkpointRoots, now, thresholds }) {
  const items = [];
  const diagnostics = [];
  const runs = [];
  for (const root of checkpointRoots) {
    if (!existsSync(root)) { diagnostics.push({ code: "NO_CHECKPOINT_ROOT", detail: root }); continue; }
    let names = [];
    try { names = readdirSync(root); } catch { diagnostics.push({ code: "CHECKPOINT_ROOT_UNREADABLE", detail: root }); continue; }
    if (names.length > MAX_EXEC_DIRS_SCANNED) diagnostics.push({ code: "CHECKPOINT_SCAN_TRUNCATED", detail: `${names.length} entries, scanned ${MAX_EXEC_DIRS_SCANNED}` });
    for (const name of names.slice(0, MAX_EXEC_DIRS_SCANNED)) {
      try { validateExecutionId(name); } catch { continue; }
      const execDir = join(root, name);
      let mtimeMs = null;
      try { mtimeMs = statSync(currentPath(execDir)).mtimeMs; } catch { continue; }
      let cap;
      try {
        const { snapshot } = readCheckpoint(root, name);
        cap = classifyResumeCapability({ checkpoint: snapshot });
      } catch (e) {
        cap = { capability: "CORRUPT", reason: String(e?.code ?? e?.message ?? "unreadable").slice(0, 60) };
      }
      runs.push({ executionId: name, capability: cap.capability, reason: cap.reason, lastActivity: new Date(mtimeMs).toISOString(), ageMinutes: (now - mtimeMs) / 60_000 });
    }
  }
  for (const run of runs) {
    if (run.capability === "TERMINAL") continue;
    if (run.capability === "CORRUPT") {
      items.push({
        key: digestKey(["exec-corrupt", run.executionId]), kind: "EXECUTION_CORRUPT", severity: "ALERT", count: 1, since: run.lastActivity,
        summary: `執行 ${run.executionId} 的 checkpoint 損毀或與 journal 不一致(${run.reason})`,
        action: "不要自動重試;先人工檢查該執行目錄",
      });
      continue;
    }
    const stale = run.ageMinutes >= thresholds.interruptedStaleMinutes;
    items.push({
      key: digestKey(["exec-interrupted", run.executionId, run.lastActivity]), kind: "EXECUTION_INTERRUPTED",
      severity: stale ? "ALERT" : "INFO", count: 1, since: run.lastActivity,
      summary: stale
        ? `執行 ${run.executionId} 在 ${run.lastActivity} 之後沒有進展(${run.capability}:${run.reason})`
        : `執行 ${run.executionId} 進行中(${run.capability})`,
      action: run.capability === "RESTART_REQUIRED" ? "此執行無法續跑,需要用新的 execution id 重新開始" : "經 runAdmittedGraph 續跑(會做 fingerprint 檢查)",
    });
  }
  return { items, diagnostics, runs: runs.length };
}

/**
 * Collect everything that needs attention. Total and read-only: unreadable or
 * absent sources become diagnostics, never invented items.
 */
export function collectAttention({
  evolutionStoreRoot = null,
  checkpointRoots = [],
  stateDir = null,
  env = process.env,
  now = Date.now(),
  thresholds = DEFAULT_ATTENTION_THRESHOLDS,
} = {}) {
  const th = { ...DEFAULT_ATTENTION_THRESHOLDS, ...thresholds };
  const evo = evolutionItems({ evolutionStoreRoot, env, now, thresholds: th });
  const exe = executionItems({ checkpointRoots, now, thresholds: th });
  const state = readAttentionState(stateDir);

  const items = [...evo.items, ...exe.items].map((it) => ({ ...it, acknowledged: Object.hasOwn(state.acknowledged, it.key) }));
  const alerts = items.filter((it) => it.severity === "ALERT" && !it.acknowledged);
  return {
    schema: ATTENTION_REPORT_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    thresholds: th,
    shouldAlert: alerts.length > 0,
    alertCount: alerts.length,
    items,
    evolution: evo.summary,
    executions: { scanned: exe.runs },
    diagnostics: [...evo.diagnostics, ...exe.diagnostics],
  };
}

/** Banner text for humans: empty string when nothing needs attention. */
export function renderBanner(report, { detail = false } = {}) {
  const alerts = report.items.filter((it) => it.severity === "ALERT" && !it.acknowledged);
  if (alerts.length === 0 && !detail) return "";
  const lines = [];
  if (alerts.length > 0) lines.push(`[!] AegisFlow 有 ${alerts.length} 項需要你注意:`);
  const shown = detail ? report.items : alerts;
  for (const it of shown) {
    const tag = it.severity === "ALERT" ? (it.acknowledged ? "已確認" : "注意") : "資訊";
    lines.push(`  - [${tag}] ${it.summary}`);
    if (detail || it.severity === "ALERT") lines.push(`      -> ${it.action}`);
  }
  if (alerts.length > 0) lines.push("  看完後執行 `node scripts/aegisflow-status.mjs --ack` 可暫時不再提醒(有新狀況會再提醒)。");
  return lines.join("\n");
}
