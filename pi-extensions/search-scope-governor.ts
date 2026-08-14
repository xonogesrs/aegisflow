// pi-extensions/search-scope-governor.ts
//
// RB-SSG2 — Pi command-execution admission extension.
//
// Wires the AutoLoop search-scope / recursive-traversal governor
// (src/admission/search-scope-governor.mjs) into the Pi agent's OWN
// shell-execution seams so interactive/direct Pi shell commands are governed
// BEFORE subprocess spawn — not only AutoLoop subagent launch commands.
//
// Seams covered:
//   - `tool_call` (bash tool): the LLM's bash tool call, blocked pre-spawn.
//   - `user_bash` (`!` / `!!`): interactive user shell commands, replaced
//     with a blocking result (no spawn).
//
// The governor is imported from the authoritative AutoLoop source. The path is
// overridable via AUTOLOOP_SRC; if it cannot be loaded the extension fails
// CLOSED for recursive-search commands (they are blocked rather than admitted
// ungoverned).

const AUTOLOOP_SRC = (process.env.AUTOLOOP_SRC ?? "/Volumes/NVM2T/Development/autoloop").replace(/\/+$/, "");
const BRIDGE_PATH = `${AUTOLOOP_SRC}/src/admission/pi-command-admission.mjs`;

/** Crude fail-closed heuristic for search commands when the governor is down. */
const LOOKS_LIKE_SEARCH = /(^|[;&|(]\s*)(find|rg|ripgrep|grep|egrep|fgrep)(\s|$)/;

let governPiCommand = null;
let loadError = null;

async function loadGovernor() {
  if (governPiCommand) return governPiCommand;
  if (loadError) return null;
  try {
    const mod = await import(BRIDGE_PATH);
    governPiCommand = mod.governPiCommand;
    return governPiCommand;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

function blockedResult(holdCode, reason) {
  return {
    output: `BLOCKED search_scope_governor:${holdCode}:${reason}`,
    exitCode: 1,
    cancelled: false,
    truncated: false,
  };
}

function unavailableResult() {
  return blockedResult("unavailable", loadError ?? "governor load failed");
}

export default function (pi) {
  // LLM-issued bash tool calls — the pre-spawn admission seam.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = event.input && typeof event.input === "object" ? event.input.command : undefined;
    if (typeof command !== "string") return;

    const gov = await loadGovernor();
    if (!gov) {
      if (LOOKS_LIKE_SEARCH.test(command)) {
        return { block: true, reason: `search_scope_governor:unavailable:${loadError ?? "governor load failed"}`, terminate: true };
      }
      return;
    }

    const decision = gov({ command, cwd: ctx.cwd });
    if (!decision.spawnAllowed) {
      return { block: true, reason: decision.blockReason, terminate: true };
    }
  });

  // Interactive `!` / `!!` user shell commands.
  pi.on("user_bash", async (event, ctx) => {
    const command = typeof event.command === "string" ? event.command : "";
    const gov = await loadGovernor();
    if (!gov) {
      return LOOKS_LIKE_SEARCH.test(command) ? { result: unavailableResult() } : undefined;
    }
    const decision = gov({ command, cwd: event.cwd ?? ctx.cwd });
    if (!decision.spawnAllowed) {
      return { result: blockedResult(decision.holdCode, decision.reason) };
    }
    return undefined;
  });
}
