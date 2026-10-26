// src/attention/switch.mjs
//
// On/off switch for the AUTOMATIC attention banner (session-start hooks, skill
// preambles). It silences nothing else: an explicit `aegisflow-status.mjs` run,
// `--detail` and `--json` still report, and it is unrelated to the evolution
// kill switch (which stops new evolution cycles). Default is ON.
//
// Precedence: AEGISFLOW_ATTENTION env (off|0|false|no → OFF; on|1|true|yes → ON)
// wins over the persisted switch file `<AEGISFLOW_HOME>/attention-switch.json`.

import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { autoloopHome, readConfigEnv } from "../shared/autoloop-paths.mjs";

export const ATTENTION_SWITCH_SCHEMA = "aegisflow.attention-switch/v1";
const SWITCH_FILE = "attention-switch.json";
const OFF_VALUES = new Set(["off", "0", "false", "no"]);
const ON_VALUES = new Set(["on", "1", "true", "yes"]);

function switchPath(env, home) {
  return join(autoloopHome({ env, ...(home ? { home } : {}) }), SWITCH_FILE);
}

/** @returns {{ enabled: boolean, source: "env"|"file"|"default", changedAt: string|null }} */
export function readAttentionSwitch({ env = process.env, home } = {}) {
  const fromEnv = readConfigEnv(env, "AEGISFLOW_ATTENTION")?.value?.trim().toLowerCase();
  if (fromEnv && OFF_VALUES.has(fromEnv)) return { enabled: false, source: "env", changedAt: null };
  if (fromEnv && ON_VALUES.has(fromEnv)) return { enabled: true, source: "env", changedAt: null };
  try {
    const p = switchPath(env, home);
    const st = lstatSync(p);
    if (st.isFile() && st.size <= 4096) {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (parsed?.schema === ATTENTION_SWITCH_SCHEMA && typeof parsed.enabled === "boolean") {
        return { enabled: parsed.enabled, source: "file", changedAt: typeof parsed.changedAt === "string" ? parsed.changedAt : null };
      }
    }
  } catch { /* absent or unreadable → default */ }
  return { enabled: true, source: "default", changedAt: null };
}

/** Persist the switch. Explicit operator act; writes only the switch file. */
export function setAttentionSwitch({ enabled, env = process.env, home, now = Date.now() }) {
  if (typeof enabled !== "boolean") throw new Error("ATTENTION_SWITCH_INVALID: enabled must be boolean");
  const target = switchPath(env, home);
  const dir = join(target, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  const changedAt = new Date(now).toISOString();
  writeFileSync(tmp, `${JSON.stringify({ schema: ATTENTION_SWITCH_SCHEMA, enabled, changedAt }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, target);
  return { enabled, changedAt, path: target };
}
