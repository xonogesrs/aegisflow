// src/admission/pi-command-admission.mjs
//
// RB-SSG2 — PI COMMAND-EXECUTION ADMISSION BRIDGE.
//
// Wires the pure search-scope governor (src/admission/search-scope-governor.mjs)
// into the Pi agent's OWN shell-execution seam — the `bash` tool's pre-spawn
// admission (`tool_call`) and the `!`/`!!` user-bash seam (`user_bash`).
//
// The RB-SSG commit (4dd04a3) governed only the AutoLoop container-launch
// boundary (src/subagent/subagent-executor-adapter.mjs) and the subagent
// envelope (src/subagent/subagent-contract.mjs). Interactive/direct Pi shell
// commands execute through the Pi agent's `bash` tool → spawn path, which
// never called `governSearch` — so `cd $HOME && grep -rl <pattern> .` was
// admitted. This module is the authoritative adapter for that seam.

import { governSearch } from "./search-scope-governor.mjs";

/**
 * Govern a single Pi shell command BEFORE spawn.
 *
 * The session cwd is treated as the bounded subtree allowlist, mirroring how
 * a subagent envelope scopes `authorizedPaths`. A forbidden cwd (HOME /
 * Desktop / filesystem root) is still rejected by the forbidden-root
 * invariant, which is evaluated before the allowlist.
 *
 * @param {object} request
 * @param {string} request.command — raw bash command string
 * @param {string} [request.cwd] — session working directory
 * @param {string} [request.home] — home dir (defaults to os.homedir())
 * @param {string[]} [request.authorizedRoots] — explicit subtree allowlist;
 *   defaults to `[cwd]` (the session's bounded root)
 * @param {object} [request.registry] — injectable failed-strategy registry
 * @returns {object} governor decision plus `spawnAllowed` / `blockReason` for
 *   the Pi extension seam
 */
export function governPiCommand(request = {}) {
  const { command, cwd = process.cwd(), home, authorizedRoots, registry } = request;
  const roots = authorizedRoots ?? (cwd ? [cwd] : []);
  const decision = governSearch({ command, cwd, home, authorizedRoots: roots, registry });
  return {
    command: decision.command,
    family: decision.segments?.[0]?.family ?? null,
    segments: decision.segments ?? [],
    decision: decision.decision,
    admit: decision.admit,
    holdCode: decision.holdCode,
    reason: decision.reason,
    fingerprint: decision.fingerprint,
    spawnAllowed: decision.admit === true,
    blockReason: decision.admit ? null : `search_scope_governor:${decision.holdCode}:${decision.reason}`,
  };
}
