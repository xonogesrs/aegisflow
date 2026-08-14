// pi-extensions/search-scope-governor/index.ts
//
// RB-SSG3 — Pi command-execution admission extension (self-contained runtime
// artifact). Wires the AutoLoop search-scope / recursive-traversal governor
// into the Pi agent's OWN shell-execution seams so interactive/direct Pi shell
// commands are governed BEFORE subprocess spawn.
//
// Deployment convergence: the governor + admission bridge are BUNDLED into
// ./vendor (byte-identical to the authoritative AutoLoop source, hash-pinned by
// test/admission/test-rb-ssg-vendor-integrity.mjs). The installed extension
// therefore does NOT depend on /Volumes/NVM2T/Development/autoloop at runtime.
//
// Resolution order (fail-closed):
//   1. bundled ./vendor/pi-command-admission.mjs  (authoritative runtime copy)
//   2. AUTOLOOP_SRC override                       (dev/testing only, optional)
//   else -> recursive-search commands are BLOCKED (never admitted ungoverned).
//
// Seams covered:
//   - `tool_call` (bash tool): the LLM's bash tool call, blocked pre-spawn.
//   - `user_bash` (`!` / `!!`): interactive user shell commands, replaced
//     with a blocking result (no spawn).

const VENDOR_PATH = "./vendor/pi-command-admission.mjs";
const AUTOLOOP_SRC_OVERRIDE = process.env.AUTOLOOP_SRC?.trim().replace(/\/+$/, "");

/** Crude fail-closed heuristic for search commands when the governor is down. */
const LOOKS_LIKE_SEARCH = /(^|[;&|(]\s*)(find|rg|ripgrep|grep|egrep|fgrep)(\s|$)/;

let governPiCommand = null;
let resolvedFrom = null;
let loadError = null;

async function loadGovernor() {
  if (governPiCommand) return { ok: true, resolvedFrom };
  if (loadError) return { ok: false, error: loadError };

  // 1) Bundled authoritative runtime copy (preferred, self-contained).
  try {
    const mod = await import(VENDOR_PATH);
    if (typeof mod.governPiCommand === "function") {
      governPiCommand = mod.governPiCommand;
      resolvedFrom = "bundled-vendor";
      return { ok: true, resolvedFrom };
    }
    throw new Error("governPiCommand export missing from bundled vendor");
  } catch (err) {
    const vendorError = err instanceof Error ? err.message : String(err);

    // 2) Dev/testing override (optional, explicit).
    if (AUTOLOOP_SRC_OVERRIDE) {
      try {
        const mod = await import(`${AUTOLOOP_SRC_OVERRIDE}/src/admission/pi-command-admission.mjs`);
        if (typeof mod.governPiCommand === "function") {
          governPiCommand = mod.governPiCommand;
          resolvedFrom = "autoloop-src-override";
          return { ok: true, resolvedFrom };
        }
        throw new Error("governPiCommand export missing from AUTOLOOP_SRC override");
      } catch (err2) {
        loadError = err2 instanceof Error ? err2.message : String(err2);
        return { ok: false, error: loadError };
      }
    }

    loadError = vendorError;
    return { ok: false, error: loadError };
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

    const loaded = await loadGovernor();
    if (!loaded.ok) {
      if (LOOKS_LIKE_SEARCH.test(command)) {
        return { block: true, reason: `search_scope_governor:unavailable:${loaded.error ?? "governor load failed"}`, terminate: true };
      }
      return;
    }

    const decision = governPiCommand({ command, cwd: ctx.cwd });
    if (!decision.spawnAllowed) {
      return { block: true, reason: decision.blockReason, terminate: true };
    }
  });

  // Interactive `!` / `!!` user shell commands.
  pi.on("user_bash", async (event, ctx) => {
    const command = typeof event.command === "string" ? event.command : "";
    const loaded = await loadGovernor();
    if (!loaded.ok) {
      return LOOKS_LIKE_SEARCH.test(command) ? { result: unavailableResult() } : undefined;
    }
    const decision = governPiCommand({ command, cwd: event.cwd ?? ctx.cwd });
    if (!decision.spawnAllowed) {
      return { result: blockedResult(decision.holdCode, decision.reason) };
    }
    return undefined;
  });
}
