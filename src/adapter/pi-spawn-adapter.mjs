// src/adapter/pi-spawn-adapter.mjs
//
// STAGE D — THE generic PRIMARY successor-spawn adapter (pi-rpc projection).
//
// PORTABILITY-CONTRACT §1 PI_ADAPTER: thin projection with exactly two duties
// — spawnSuccessorSession + tool-row projection rows for its kind (the rows
// already exist in THE mapping table; this module adds no catalog).
//
// Provider/model/env identity is NEVER hardcoded here. The admitted
// provider_binding on the spawn request is the only execution authority.
// This module registers the pi-builtin factory for every spawn-runtime
// capability row of adapterKind=pi-builtin. No provider-specific behavior.
//
// Quarantine launch discipline (CONTRACT §8): B starts with NO tool grants
// and NO execution prompt beyond the quarantine validation payload
// (--no-tools --no-skills precedent). The adapter starts a REAL provider
// session and returns its REAL opaque session id — derived from the session
// file Pi actually creates (never minted, never hardcoded). It CANNOT mint
// authority, mutate checkpoints, transfer ownership or declare ACK-readiness:
// those functions do not exist on this interface (T65/T66).

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  registerSpawnAdapterKind,
  SPAWN_RUNTIME_CAPABILITIES,
  canonicalizeProviderBinding,
} from "../rollover/spawn-registry.mjs";

export const PI_SPAWN_ADAPTER_KIND = "pi-builtin";
export const PI_SPAWN_OPERATIONAL_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM",
]);

const FORBIDDEN_ARGS = new Set([
  "--approve", "-a", "--continue", "-c", "--resume", "-r",
  "--session", "--fork",
]);

function spawnTimeoutMs() {
  // R2: window sizing is configuration, never a magic constant.
  const raw = Number(process.env.AUTOLOOP_ROLLOVER_SPAWN_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 180000;
}

export function spawnArgsFromBinding({ sessionDir, providerKind, modelId }) {
  if (typeof sessionDir !== "string" || sessionDir.length === 0) {
    throw new Error("pi_spawn_adapter_session_dir_required");
  }
  if (typeof providerKind !== "string" || providerKind.length === 0) {
    throw new Error("pi_spawn_adapter_provider_kind_required");
  }
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error("pi_spawn_adapter_model_id_required");
  }
  return [
    "--mode", "rpc",
    "--session-dir", sessionDir,
    "--no-tools",
    "--no-skills",
    "--no-extensions",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--provider", providerKind,
    "--model", modelId,
  ];
}

function assertNoForbidden(args) {
  for (const a of args) {
    if (FORBIDDEN_ARGS.has(a)) throw new Error(`pi_spawn_adapter_forbidden_arg: ${a}`);
  }
}

/**
 * Successor child env: operational keys + explicitly admitted requiredEnvKeys.
 * Arbitrary caller keys are never forwarded. Missing required key fails closed
 * before any provider spawn. Values are returned for the child process only —
 * they must never enter durable evidence.
 */
export function spawnEnvFromBinding({ requiredEnvKeys, parentEnv = process.env }) {
  if (!Array.isArray(requiredEnvKeys)) {
    return { ok: false, error: "requiredEnvKeys must be an array of admitted key names" };
  }
  const env = {};
  for (const key of PI_SPAWN_OPERATIONAL_ENV_KEYS) {
    if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
  }
  for (const key of requiredEnvKeys) {
    if (typeof key !== "string" || key.length === 0) {
      return { ok: false, error: "requiredEnvKeys entries must be non-empty names" };
    }
    if (parentEnv[key] === undefined || parentEnv[key] === "") {
      return { ok: false, error: `required env key missing: ${key}` };
    }
    env[key] = parentEnv[key];
  }
  return { ok: true, env };
}

/** Durable-safe projection of a binding: key names only, never values. */
export function spawnEvidenceFromBinding(binding) {
  const canon = canonicalizeProviderBinding(binding);
  if (!canon.ok) return { ok: false, error: canon.reason };
  return {
    ok: true,
    evidence: {
      adapterKind: canon.value.adapterKind,
      providerKind: canon.value.providerKind,
      modelId: canon.value.modelId,
      requiredEnvKeys: [...canon.value.requiredEnvKeys],
    },
  };
}

/** Derive the REAL provider-created session id from the session file name. */
export function sessionIdFromSessionFile(fileName) {
  // Pi session files: <ISO-ish timestamp>_<uuid>.jsonl — the UUID IS the id.
  const m = String(fileName).match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
  return m ? m[1] : null;
}

/**
 * spawnSuccessorSession(request) →
 *   { status:"spawned", identity, startedAt, replyText }   (replyText is a
 *    NON-authoritative attestation carrier — B's echo of the binding payload;
 *    the core decides what it proves)
 * | { status:"error"|"timed_out"|"aborted", error }
 * Request per ADAPTER-INVENTORY.md §6 (validated by core before us).
 */
export async function spawnSuccessorSession(request) {
  const startedAt = new Date().toISOString();
  if (request?.env !== undefined || request?.environmentAllowlist !== undefined || request?.extraEnv !== undefined) {
    return { status: "error", error: "caller env expansion forbidden" };
  }
  const canon = canonicalizeProviderBinding({
    adapterKind: request?.adapterKind,
    providerKind: request?.providerKind,
    modelId: request?.modelId,
    requiredEnvKeys: request?.requiredEnvKeys,
  });
  if (!canon.ok) {
    return { status: "error", error: `${canon.code}: ${canon.reason}` };
  }
  const binding = canon.value;

  const envResult = spawnEnvFromBinding({ requiredEnvKeys: binding.requiredEnvKeys });
  if (!envResult.ok) {
    return { status: "error", error: envResult.error };
  }

  const sessionDir = join(request.checkpointLocator.root, request.checkpointLocator.executionId, "artifacts", "rollover-session-dir");
  try {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return { status: "error", error: `session_dir_create_failed:${String(e?.message ?? e).slice(0, 160)}` };
  }

  let args;
  try {
    args = spawnArgsFromBinding({
      sessionDir,
      providerKind: binding.providerKind,
      modelId: binding.modelId,
    });
    assertNoForbidden(args);
  } catch (e) {
    return { status: "error", error: String(e?.message ?? e) };
  }

  // Quarantine validation payload — identity binding ONLY, never an
  // execution prompt, never tool instructions. PLAIN TEXT: the pi rpc
  // channel treats a leading '{' as an RPC command object and exits.
  const payload = [
    "AUTOLOOP QUARANTINE VALIDATION BINDING (autoloop.quarantine-validation/v1)",
    `rolloverId: ${request.rolloverId}`,
    `expectedTargetGeneration: ${request.expectedTargetGeneration}`,
    `checkpointDigest: ${request.checkpointDigest}`,
    `taskIdentity: ${request.taskIdentity}`,
    `runIdentity: ${request.runIdentity}`,
    "You are a quarantined successor session. Do not execute any work.",
    "Acknowledge the binding by restating the rolloverId verbatim.",
  ].join("\n");

  const executable = process.env.PI_EXECUTABLE || "pi";

  let child;
  try {
    child = spawn(executable, args, { cwd: process.cwd(), env: envResult.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    return { status: "error", error: `spawn_failed:${String(e?.message ?? e).slice(0, 160)}` };
  }

  let lastAssistantText = ""; // non-authoritative attestation carrier (B's echo)
  const outcome = await new Promise((resolve) => {
    let buf = "";
    let sawSettled = false;
    let settledDone = false;
    let stderrTail = "";
    const finish = (result) => {
      if (settledDone) return;
      settledDone = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ status: "timed_out", error: `quarantine_session_not_settled_within_${spawnTimeoutMs()}ms` });
    }, spawnTimeoutMs());
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (process.env.AUTOLOOP_SPAWN_DEBUG) process.stderr.write(`[spawn-dbg] ${evt.type} ${String(lastAssistantText).slice(0, 60)}\n`);
          if (evt.type === "agent_settled") sawSettled = true;
          if ((evt.type === "message_update" || evt.type === "message_end")
              && evt.message?.role === "assistant" && Array.isArray(evt.message.content)) {
            const texts = evt.message.content.filter((c) => typeof c?.text === "string").map((c) => c.text);
            if (texts.length > 0) lastAssistantText = texts.join("");
          }
        } catch { /* non-JSON line */ }
      }
    });
    child.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString("utf8")).slice(-400); });
    child.on("error", (e) => finish({ status: "error", error: `child_error:${String(e?.message ?? e).slice(0, 160)}` }));
    child.on("exit", (code, sig) => {
      if (!sawSettled) finish({ status: "aborted", error: `child_exited_before_settle code=${code} signal=${sig} stderr=${stderrTail.replace(/\s+/g, " ").slice(-200)}` });
    });
    try {
      // Keep the rpc channel OPEN: pi --mode rpc exits when its stdin closes,
      // which would race the settle observation. We SIGKILL on settle instead.
      child.stdin.write(JSON.stringify({ type: "prompt", message: payload }) + "\n");
    } catch { /* exit handler decides */ }
    const poll = setInterval(() => {
      if (sawSettled) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        finish({ status: "ok" });
      }
    }, 100);
  });

  if (outcome.status !== "ok") {
    return { status: outcome.status, error: outcome.error };
  }

  // The REAL identity: read back the session file Pi actually created.
  let files = [];
  try { files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")); } catch { files = []; }
  let opaqueSessionId = null;
  for (const f of files) {
    const id = sessionIdFromSessionFile(f);
    if (id) { opaqueSessionId = id; break; }
  }
  if (!opaqueSessionId) {
    return { status: "error", error: "no_real_provider_session_file_created (identity unavailable)" };
  }

  return {
    status: "spawned",
    identity: {
      adapterKind: binding.adapterKind,
      providerKind: binding.providerKind,
      opaqueSessionId,
    },
    startedAt,
    replyText: lastAssistantText.slice(0, 4096),
  };
}

// Register THE generic factory for every supported pi-builtin capability row.
for (const row of SPAWN_RUNTIME_CAPABILITIES) {
  if (row.adapterKind !== PI_SPAWN_ADAPTER_KIND) continue;
  registerSpawnAdapterKind({
    adapterKind: row.adapterKind,
    providerKind: row.providerKind,
    factory: { spawnSuccessorSession },
  });
}
