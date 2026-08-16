// pi-extensions/search-scope-governor/index.ts
//
// RB-SSG4-FR4 — Pi command-execution admission extension (self-contained
// runtime artifact). Wires the FR4 bounded-search governor into the Pi
// agent's own execution seams:
//
//   1. STRUCTURED SEARCH PRIMARY PATH (Phase A) — registers governed bounded
//      `grep` / `find` tools in the coding toolset (explicit root + .gitignore
//      + result limits, root policy-checked before execution).
//   2. COARSE BASH GUARD (Phase B) — governs `bash` tool calls and `!`/`!!`
//      user-bash pre-spawn with the coarse three-way classifier.
//   3. RUNTIME BACKSTOP (Phase C) — injects a default wall-clock timeout for
//      recursive-search bash commands when none was specified.
//   4. FAILED-STRATEGY → REPLAN (Phase D) — wires a session-persisted
//      failed-strategy registry into the live path and feeds runtime failures
//      back into it.
//
// Deployment convergence: the governor + admission bridge are BUNDLED into
// ./vendor (byte-identical to the authoritative AutoLoop source). The
// installed extension therefore does NOT depend on /Volumes/NVM2T/Development
// /autoloop at runtime.
//
// Resolution order (fail-closed):
//   1. bundled ./vendor/pi-command-admission.mjs  (authoritative runtime copy)
//   2. AUTOLOOP_SRC override                       (dev/testing only, optional)
//   else -> recursive-search commands are BLOCKED (never admitted ungoverned).

import {
  createGrepToolDefinition,
  createFindToolDefinition,
} from "@earendil-works/pi-coding-agent";

const VENDOR_BRIDGE = "./vendor/pi-command-admission.mjs";
const VENDOR_GOVERNOR = "./vendor/search-scope-governor.mjs";
const AUTOLOOP_SRC_OVERRIDE = process.env.AUTOLOOP_SRC?.trim().replace(/\/+$/, "");

/** Crude fail-closed heuristic for search commands when the governor is down. */
const LOOKS_LIKE_SEARCH = /(^|[;&|(]\s*)(find|rg|ripgrep|grep|egrep|fgrep)(\s|$)/;

// ── FR4 Phase C — centrally-defined default recursive-search wall-clock
// bound (seconds). Overridable only through an explicit environment mechanism.
const DEFAULT_RECURSIVE_SEARCH_TIMEOUT_SECONDS = (() => {
  const v = Number(process.env.RB_SSG_DEFAULT_TIMEOUT_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : 120;
})();

const FAILED_STRATEGY_ENTRY_TYPE = "rb-ssg-failed-strategies";

let bridge = null; // { governPiCommand, governStructuredSearch }
let gov = null;    // { createFailedStrategyRegistry }
let resolvedFrom = null;
let loadError = null;

let registry = null;
const pendingFingerprints = new Map(); // toolCallId -> string[]
let registeredStructuredTools = false;

async function loadModules() {
  if (bridge && gov) return { ok: true, resolvedFrom };
  if (loadError) return { ok: false, error: loadError };

  const loadFrom = async (bridgePath, governorPath, label) => {
    const b = await import(bridgePath);
    const g = await import(governorPath);
    if (typeof b.governPiCommand !== "function") throw new Error(`governPiCommand missing from ${label} bridge`);
    if (typeof b.governStructuredSearch !== "function") throw new Error(`governStructuredSearch missing from ${label} bridge`);
    if (typeof g.createFailedStrategyRegistry !== "function") throw new Error(`createFailedStrategyRegistry missing from ${label} governor`);
    return { b, g, label };
  };

  // 1) Bundled authoritative runtime copy (preferred, self-contained).
  try {
    const { b, g, label } = await loadFrom(VENDOR_BRIDGE, VENDOR_GOVERNOR, "bundled-vendor");
    bridge = b;
    gov = g;
    resolvedFrom = label;
    return { ok: true, resolvedFrom };
  } catch (err) {
    const vendorError = err instanceof Error ? err.message : String(err);
    // 2) Dev/testing override (optional, explicit).
    if (AUTOLOOP_SRC_OVERRIDE) {
      try {
        const { b, g, label } = await loadFrom(
          `${AUTOLOOP_SRC_OVERRIDE}/src/admission/pi-command-admission.mjs`,
          `${AUTOLOOP_SRC_OVERRIDE}/src/admission/search-scope-governor.mjs`,
          "autoloop-src-override",
        );
        bridge = b;
        gov = g;
        resolvedFrom = label;
        return { ok: true, resolvedFrom };
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

function collectRecursiveFingerprints(decision) {
  const fps = [];
  for (const seg of decision.segments ?? []) {
    if (seg && seg.recursive === true && typeof seg.fingerprint === "string" && seg.fingerprint.length > 0) {
      fps.push(seg.fingerprint);
    }
  }
  return [...new Set(fps)];
}

function hydrateRegistry(entries) {
  if (!registry) return;
  const persisted = (entries ?? [])
    .filter((e) => e?.type === "custom" && e?.customType === FAILED_STRATEGY_ENTRY_TYPE)
    .map((e) => e?.data)
    .filter(Boolean)
    .reverse(); // latest first
  const latest = persisted[0];
  if (latest && Array.isArray(latest.entries)) {
    registry.hydrate(latest.entries);
  }
}

function persistRegistry(pi, ctx, reg) {
  if (!reg) return;
  const entries = reg.entries();
  if (entries.length === 0) return;
  pi.appendEntry(FAILED_STRATEGY_ENTRY_TYPE, {
    entries,
    updatedAt: new Date().toISOString(),
  });
}

function ensureRegistry(ctx) {
  if (!registry) {
    registry = gov.createFailedStrategyRegistry();
    try {
      hydrateRegistry(ctx?.sessionManager?.getEntries?.() ?? []);
    } catch {
      // hydration is best-effort; an empty registry is still fail-closed
    }
  }
  return registry;
}

function registerStructuredTools(pi, cwd) {
  if (registeredStructuredTools) return;
  registeredStructuredTools = true;

  const existing = new Set((pi.getAllTools?.() ?? []).map((t) => t?.name).filter(Boolean));

  const governRoot = async (path, toolCwd) => {
    await loadModules();
    return bridge.governStructuredSearch({ path, cwd: toolCwd });
  };

  if (!existing.has("grep")) {
    const def = createGrepToolDefinition(cwd);
    pi.registerTool({
      ...def,
      promptSnippet: def.promptSnippet ?? "Search file contents for patterns (respects .gitignore)",
      promptGuidelines: [
        "Use grep (the structured tool) for bounded content search with an explicit path. Prefer it over `bash` + recursive grep/rg for routine repository discovery.",
      ],
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const g = await governRoot(params.path ?? ".", ctx.cwd);
        if (!g.admit) throw new Error(g.blockReason);
        return def.execute(toolCallId, params, signal, onUpdate, ctx);
      },
    });
  }

  if (!existing.has("find")) {
    const def = createFindToolDefinition(cwd);
    pi.registerTool({
      ...def,
      promptSnippet: def.promptSnippet ?? "Find files by glob pattern (respects .gitignore)",
      promptGuidelines: [
        "Use find (the structured tool) for bounded file-name/glob discovery with an explicit path. Prefer it over `bash` + recursive find for routine repository discovery.",
      ],
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const g = await governRoot(params.path ?? ".", ctx.cwd);
        if (!g.admit) throw new Error(g.blockReason);
        return def.execute(toolCallId, params, signal, onUpdate, ctx);
      },
    });
  }

  // Enable the structured tools additively (never remove currently-active tools).
  try {
    const active = pi.getActiveTools?.() ?? [];
    const want = new Set([...active, "grep", "find"]);
    pi.setActiveTools([...want]);
  } catch {
    // setActiveTools is best-effort; registration alone still exposes the tools.
  }
}

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    const loaded = await loadModules();
    if (!loaded.ok) return;
    ensureRegistry(ctx);
    registerStructuredTools(pi, ctx.cwd);
  });

  // LLM-issued bash tool calls — the pre-spawn admission seam.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = event.input && typeof event.input === "object" ? event.input.command : undefined;
    if (typeof command !== "string") return;

    const loaded = await loadModules();
    if (!loaded.ok) {
      if (LOOKS_LIKE_SEARCH.test(command)) {
        return { block: true, reason: `search_scope_governor:unavailable:${loaded.error ?? "governor load failed"}`, terminate: true };
      }
      return;
    }

    const reg = ensureRegistry(ctx);
    const decision = bridge.governPiCommand({ command, cwd: ctx.cwd, registry: reg });
    if (!decision.spawnAllowed) {
      // FR4 — bounded-search rewrite: if a safe bounded equivalent was derived
      // AND re-admitted, mutate the tool input to run it instead of the unsafe
      // original. The unsafe original never reaches spawn.
      if (typeof decision.rewrittenCommand === "string" && decision.rewrittenCommand.length > 0) {
        event.input.command = decision.rewrittenCommand;
      } else {
        return { block: true, reason: decision.blockReason, terminate: true };
      }
    }

    // FR4 Phase D — remember the recursive-search fingerprints of what will
    // actually spawn, so a later runtime failure can be fed back as evidence.
    const finalCommand = typeof decision.rewrittenCommand === "string" && decision.rewrittenCommand.length > 0
      ? decision.rewrittenCommand
      : command;
    const finalDecision = finalCommand === command
      ? decision
      : bridge.governPiCommand({ command: finalCommand, cwd: ctx.cwd, registry: reg });
    const fps = collectRecursiveFingerprints(finalDecision);
    if (fps.length > 0) {
      pendingFingerprints.set(event.toolCallId, fps);
      // FR4 Phase C — default wall-clock bound for recursive discovery.
      if (event.input.timeout === undefined) {
        event.input.timeout = DEFAULT_RECURSIVE_SEARCH_TIMEOUT_SECONDS;
      }
    }
  });

  // Interactive `!` / `!!` user shell commands.
  pi.on("user_bash", async (event, ctx) => {
    const command = typeof event.command === "string" ? event.command : "";
    const loaded = await loadModules();
    if (!loaded.ok) {
      return LOOKS_LIKE_SEARCH.test(command) ? { result: unavailableResult() } : undefined;
    }
    const reg = ensureRegistry(ctx);
    const decision = bridge.governPiCommand({ command, cwd: event.cwd ?? ctx.cwd, registry: reg });
    if (!decision.spawnAllowed) {
      const safeRewrite = typeof decision.rewrittenCommand === "string" && decision.rewrittenCommand.length > 0
        ? `\nSAFE_REWRITE: ${decision.rewrittenCommand}`
        : "";
      return { result: blockedResult(decision.holdCode, decision.reason + safeRewrite) };
    }
    return undefined;
  });

  // FR4 Phase D — ingest runtime failure back into the failed-strategy registry.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const fps = pendingFingerprints.get(event.toolCallId);
    pendingFingerprints.delete(event.toolCallId);
    if (!fps || fps.length === 0) return;
    // Mechanical failure signals: timeout, abort, or non-zero exit all surface
    // as isError on the bash tool result.
    if (event.isError === true) {
      const reg = ensureRegistry(ctx);
      for (const fp of fps) {
        reg.recordFailure(fp, { reason: "runtime failure", toolFamily: "bash" });
      }
      persistRegistry(pi, ctx, reg);
    }
  });
}
