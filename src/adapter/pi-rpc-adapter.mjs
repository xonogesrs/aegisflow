// adapter/pi-rpc-adapter.mjs
//
// Pi RPC adapter: spawns a child `pi --mode rpc --no-session` process,
// sends one task-card prompt over its stdin JSONL channel, collects the
// documented event stream, and returns a normalized adapter/contract.mjs
// result. This module owns exactly one thing: getting a well-formed result
// out of a Pi child process. It never decides PASS, never validates
// mutation scope, never grows the repair budget, never commits -- all of
// that stays in lifecycle-runner.mjs and the existing C2D layers.
//
// PI TOOL POLICY IS NOT AN OS SANDBOX. --no-tools (the default here) only
// stops the model from being offered tools; it is not a filesystem,
// process, or network boundary. See docs/security.md in the installed Pi
// package: "Pi does not include a built-in sandbox."
//
// RPC mode is a persistent server: per Pi's own docs/rpc.md there is no
// "quit" command, so the child never exits on its own. This adapter always
// terminates the child itself once a result is known -- on the success
// path as much as on error/timeout/abort -- and never reports that
// self-initiated shutdown signal as the result's top-level `signal` field.

import { spawn } from "node:child_process";
import { assertAdapterRequest, assertAdapterResult } from "./contract.mjs";
import {
  createJsonlSplitter, parseEventLine, ProtocolLimitError,
  HARD_MAX_CUMULATIVE_BYTES, DEFAULT_MAX_CUMULATIVE_BYTES, DEFAULT_MAX_LINE_BYTES,
  resetSnapshotAccounting,
} from "./pi-rpc-protocol.mjs";
import { validateToolSelection, TOOL_SELECTION_SCHEMA } from "../admission/policy-projection.mjs";

export const DEFAULT_ENV_ALLOWLIST = Object.freeze(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"]);

const FORBIDDEN_ARGS = new Set([
  "--approve", "-a",
  "--continue", "-c",
  "--resume", "-r",
  "--session",
  "--fork",
]);

function buildChildEnv(allowlist) {
  const env = {};
  for (const key of allowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

// STAGE C (contract §7): the raw caller allowlist/denylist JOIN IS REMOVED.
// Caller raw tool strings have ZERO authority post-implementation; unknown/
// unshaped toolPolicy continues to fail closed to the safest default. Only a
// canonical autoloop.tool-selection/v1 output that passes validateToolSelection
// reaches argv (see resolveToolSpawnArgs below).
function toolPolicyArgs(toolPolicy) {
  if (!toolPolicy || toolPolicy.mode === "no-tools") return ["--no-tools"];
  if (toolPolicy.mode === "no-builtin-tools") return ["--no-builtin-tools"];
  return ["--no-tools"];
}

/**
 * STAGE C §7 adapter re-validation. Canonical selection outputs are resolved
 * against THE authoritative lifecycle binding (issuance authentication) and
 * re-verified with the SAME validator module as the selector; only then do
 * the selected adapterToolNames reach argv. Any failure is a pre-spawn HOLD:
 * applied=false, zero tool invocations, TOOL_SELECTION_PROVENANCE_INVALID
 * (or its specific drift code).
 */
async function resolveToolSpawnArgs({ toolPolicy, selectionAuthority, executionId, phase, attempt }) {
  const canonicalShape = toolPolicy && typeof toolPolicy === "object" && !Array.isArray(toolPolicy) &&
    toolPolicy.contractVersion === TOOL_SELECTION_SCHEMA;
  // STAGE C PRODUCTION WIRING (T5): an adapter WIRED with the lifecycle
  // selection authority is part of a canonical composition. An invocation
  // reaching it WITHOUT a canonical selection means the bind was lost
  // upstream — downgrading to the legacy --no-tools spawn would be exactly
  // the forbidden silent no-tools success. Fail closed BEFORE any spawn:
  // applied=false, zero tool invocations. Un-wired adapters (standalone /
  // unaffiliated use) keep the contract §7 legacy safe default below.
  if (!canonicalShape && typeof selectionAuthority === "function") {
    return { hold: true, code: "TOOL_SELECTION_PROVENANCE_INVALID", reason: "wired executor received no canonical toolSelectionBind for THIS invocation" };
  }
  if (canonicalShape) {
    let binding = null;
    if (typeof selectionAuthority === "function") {
      try {
        binding = await selectionAuthority({ executionId, phase, attempt });
      } catch {
        binding = null; // authority resolution failure = unauthenticated
      }
    }
    const verdict = validateToolSelection(toolPolicy, { authorityBinding: binding });
    if (!verdict.ok) {
      return { hold: true, code: verdict.code, reason: verdict.reason };
    }
    const args = verdict.basis === "LEGITIMATE_EMPTY"
      ? ["--no-tools"]
      : ["--tools", verdict.argvToolNames.join(",")];
    return { hold: false, args, basis: verdict.basis, names: verdict.argvToolNames };
  }
  return { hold: false, legacy: true, args: toolPolicyArgs(toolPolicy), basis: null, names: [] };
}

function buildArgs({ provider, model, toolSpawnArgs, extraArgs = [] }) {
  for (const a of extraArgs) {
    if (FORBIDDEN_ARGS.has(a)) {
      throw new Error(`pi_rpc_adapter_forbidden_arg: ${a}`);
    }
  }
  const args = [
    "--mode", "rpc",
    "--no-session",
    ...toolSpawnArgs,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ];
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  args.push(...extraArgs);
  return args;
}

function completedResult({ executionId, stdout, stderr, metadata }) {
  return { status: "completed", executionId, stdout, stderr, signal: null, error: null, metadata };
}
function errorResult({ executionId, stdout, stderr, error, metadata }) {
  return { status: "error", executionId, stdout, stderr: stderr ?? "", signal: null, error, metadata };
}
function timedOutResult({ executionId, stdout, stderr, signal, metadata }) {
  return { status: "timed_out", executionId, stdout: stdout ?? "", stderr: stderr ?? "", signal: signal ?? null, error: null, metadata };
}
function abortedResult({ executionId, stdout, stderr, signal, metadata }) {
  return { status: "aborted", executionId, stdout: stdout ?? "", stderr: stderr ?? "", signal: signal ?? null, error: null, metadata };
}

/**
 * Terminate a detached child (and its process group) with a bounded,
 * escalating sequence. Mirrors c2d/mutation-run.mjs's runBoundedCommand
 * kill semantics (detached group leader, group SIGKILL, single-process
 * fallback) rather than inventing a second scheme.
 */
function terminateChild(child, { graceMs = 300 } = {}) {
  return new Promise((resolveTerminate) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveTerminate({ processTreeKilled: false });
      return;
    }
    let killedGroup = false;
    let settled = false;
    const finish = (info) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolveTerminate(info);
    };
    child.once("exit", () => finish({ processTreeKilled: killedGroup }));

    try {
      child.stdin.end();
    } catch {
      /* best-effort */
    }

    // First grace window: gives an already-sent RPC abort (see onAbort/timer
    // above) a real chance to stop the agent before any signal is sent at
    // all. Only after this elapses without an exit do we escalate to SIGTERM,
    // then a second grace window before SIGKILL of the whole process group --
    // mirroring c2d/mutation-run.mjs's runBoundedCommand kill semantics.
    const termTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try { child.kill("SIGTERM"); } catch { /* best-effort */ }
      }
    }, graceMs);

    const killTimer = setTimeout(() => {
      killedGroup = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* best-effort */ }
      }
      // Give the OS a moment to reap; if it still hasn't exited, report
      // best-effort completion rather than hanging the adapter forever.
      setTimeout(() => finish({ processTreeKilled: true }), 500);
    }, graceMs * 2);
  });
}

export function createPiRpcAdapter(options = {}) {
  const {
    piExecutable = "pi",
    provider,
    model,
    extraArgs = [],
    environmentAllowlist = DEFAULT_ENV_ALLOWLIST,
    toolPolicy: defaultToolPolicy,
    // STAGE C §7 item 6: issuance-authentication resolver over THE
    // authoritative frozen admission / lifecycle bind context. Provided by
    // the production composition; absent = no binding authority configured.
    selectionAuthority,
    protocolLimits = {},
    graceMs = 300,
  } = options;

  // Validate protocolLimits early (before any spawn)
  let configuredMaxCumulativeBytes;
  try {
    const maxCumulativeLimit = protocolLimits.maxCumulativeBytes ?? DEFAULT_MAX_CUMULATIVE_BYTES;
    createJsonlSplitter({ maxCumulativeBytes: maxCumulativeLimit });
    configuredMaxCumulativeBytes = maxCumulativeLimit;
  } catch (e) {
    // Invalid protocolLimits — return an adapter that always fails closed
    const validationError = e.message;
    return {
      runAdapter: async (request) => {
        assertAdapterRequest(request);
        return assertAdapterResult(errorResult({
          executionId: request.executionId,
          stdout: "",
          stderr: "",
          error: validationError,
          metadata: {
            protocolMaxCumulativeBytes: protocolLimits.maxCumulativeBytes,
            protocolHardMaxCumulativeBytes: HARD_MAX_CUMULATIVE_BYTES,
          }
        }));
      }
    };
  }

  async function runAdapter(request) {
    assertAdapterRequest(request);
    const { executionId, cwd, phase, attempt, timeoutMs, abortSignal, taskCard, reviewEvidence } = request;
    const allowlist = request.environmentAllowlist || environmentAllowlist;
    const toolPolicy = request.toolPolicy || defaultToolPolicy;

    if (abortSignal && abortSignal.aborted) {
      return assertAdapterResult(abortedResult({ executionId, stdout: "", stderr: "", metadata: {} }));
    }

    const toolResolution = await resolveToolSpawnArgs({ toolPolicy, selectionAuthority, executionId, phase, attempt });
    if (toolResolution.hold) {
      // Pre-spawn HOLD: applied=false, ZERO tool invocations, truthful hold code.
      return assertAdapterResult(errorResult({
        executionId,
        stdout: "",
        stderr: "",
        error: `${toolResolution.code}: ${toolResolution.reason}`,
        metadata: {
          selectionHoldCode: toolResolution.code,
          selectionTelemetryState: "SELECTED_REJECTED",
          applied: false,
          toolInvocationCount: 0,
        },
      }));
    }

    let args;
    try {
      args = buildArgs({ provider, model, toolSpawnArgs: toolResolution.args, extraArgs });
    } catch (e) {
      return assertAdapterResult(errorResult({ executionId, stdout: "", stderr: "", error: e.message, metadata: {} }));
    }
    const toolSelectionMeta = toolResolution.legacy ? null : {
      selectionBasis: toolResolution.basis,
      adapterToolNames: toolResolution.names,
      telemetryState: toolResolution.basis === "LEGITIMATE_EMPTY" ? "NOT_SELECTED" : "SELECTED",
    };
    const env = buildChildEnv(allowlist);

    let child;
    try {
      child = spawn(piExecutable, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return assertAdapterResult(errorResult({ executionId, stdout: "", stderr: "", error: e.message, metadata: { args } }));
    }

    // Observability: pid / start / last-activity / exit (for HOLD-on-disappearance)
    const childPid = child.pid;
    const spawnedAt = Date.now();
    let lastActivityAt = spawnedAt;
    let exitedAt = null;

    resetSnapshotAccounting();
    const splitter = createJsonlSplitter({ maxCumulativeBytes: configuredMaxCumulativeBytes });
    let stderrBuf = "";
    let eventCount = 0;
    let toolCallStarts = new Set();
    let toolCallEnds = new Set();
    let sawAgentSettled = false;
    let lastAssistantStopReason = null;
    let lastAssistantErrorMessage = null;
    let lastAssistantUsage = null; // P3-U1 authoritative provider usage (message_end)
    let finalText = null;
    let awaitingFinalText = false;
    let spawnError = null;
    let childExited = false;
    let childExitInfo = { code: null, signal: null };

    // Diagnostic counters — numeric only, no raw content
    const eventTypeCounts = new Map();
    const bytesByEventType = new Map();
    let messageSnapshotBytes = 0;
    let messagePartialBytes = 0;
    let messageDeltaBytes = 0;
    let messageUpdateSubtypeCounts = { snapshot: 0, partial: 0, delta: 0, unknown: 0 };
    let thinkingDeltaCount = 0;
    let thinkingDeltaBytes = 0;
    let textDeltaCount = 0;
    let textDeltaBytes = 0;
    let maxObservedLineBytes = 0;
    let totalLineBytes = 0;
    let totalLineCount = 0;

    const outcome = { kind: null, detail: null }; // "completed" | "error" | "timed_out" | "aborted"

    let resolveDone;
    const done = new Promise((res) => { resolveDone = res; });

    function finishOnce(kind, detail) {
      if (outcome.kind) return;
      outcome.kind = kind;
      outcome.detail = detail || {};
      resolveDone();
    }

    function send(cmd) {
      try {
        child.stdin.write(JSON.stringify(cmd) + "\n");
      } catch {
        /* child may already be gone; ignore */
      }
    }

    function handleEvent(evt, lineBytes) {
      eventCount += 1;
      lastActivityAt = Date.now();

      // Diagnostic: count by event type
      const etype = evt.type || "unknown";
      eventTypeCounts.set(etype, (eventTypeCounts.get(etype) || 0) + 1);
      bytesByEventType.set(etype, (bytesByEventType.get(etype) || 0) + lineBytes);
      totalLineBytes += lineBytes;
      totalLineCount += 1;
      if (lineBytes > maxObservedLineBytes) maxObservedLineBytes = lineBytes;

      if (evt.type === "tool_execution_start" && evt.toolCallId) toolCallStarts.add(evt.toolCallId);
      if (evt.type === "tool_execution_end" && evt.toolCallId) toolCallEnds.add(evt.toolCallId);
      if (evt.type === "message_end" && evt.message && evt.message.role === "assistant") {
        lastAssistantStopReason = evt.message.stopReason ?? lastAssistantStopReason;
        lastAssistantErrorMessage = evt.message.errorMessage ?? lastAssistantErrorMessage;
        // P3-U1-admitted authoritative usage source: the FINAL assistant
        // message_end carries the pi-ai Usage object (input/output/cacheRead/
        // cacheWrite/totalTokens). Captured verbatim as provider-reported
        // facts — never estimated, never summed from message_update deltas.
        if (evt.message.usage && typeof evt.message.usage === "object") {
          lastAssistantUsage = evt.message.usage;
        }
      }
      // message_update diagnostic classification
      if (evt.type === "message_update") {
        const msg = evt.message;
        if (msg && Array.isArray(msg.content)) {
          // Determine if this is a snapshot (full message so far) or delta (incremental)
          // Pi RPC: partial messages carry complete text; delta updates add new chunks
          let hasThinkingContent = false;
          let hasTextContent = false;
          for (const block of msg.content) {
            if (block && typeof block.type === "string" && typeof block.text === "string") {
              const blockBytes = Buffer.byteLength(block.text, "utf8");
              if (block.type === "thinking" || block.type === "reasoning") {
                thinkingDeltaCount += 1;
                thinkingDeltaBytes += blockBytes;
                hasThinkingContent = true;
              } else if (block.type === "text" || block.type === "output") {
                textDeltaCount += 1;
                textDeltaBytes += blockBytes;
                hasTextContent = true;
              }
            }
          }
          // Classify update subtype based on content structure
          // Heuristic: if content looks like a complete reconstruction → snapshot;
          // if it's an append → partial; if just the delta → delta
          if (msg.partial === true || (hasTextContent && !hasThinkingContent)) {
            // Pi sends partial=true for streaming updates that carry full text so far
            messagePartialBytes += lineBytes;
            messageUpdateSubtypeCounts.partial += 1;
          } else if (hasThinkingContent && hasTextContent) {
            messageSnapshotBytes += lineBytes;
            messageUpdateSubtypeCounts.snapshot += 1;
          } else {
            messageDeltaBytes += lineBytes;
            messageUpdateSubtypeCounts.delta += 1;
          }
        } else {
          messageDeltaBytes += lineBytes;
          messageUpdateSubtypeCounts.unknown += 1;
        }
      }
      if (evt.type === "agent_settled") {
        sawAgentSettled = true;
        if (!awaitingFinalText) {
          awaitingFinalText = true;
          send({ id: "final-text", type: "get_last_assistant_text" });
        }
      }
      if (evt.type === "response" && evt.command === "get_last_assistant_text") {
        finalText = (evt.data && evt.data.text) ?? "";
        finishOnce("completed", {});
      }
      // Unknown event types are recorded (via eventCount) and otherwise
      // ignored -- never treated as an error on their own.
    }

    child.stdout.setEncoding("utf8");
    let rawWireBytes = 0;
    child.stdout.on("data", (chunk) => {
      rawWireBytes += Buffer.byteLength(chunk, "utf8");
      if (outcome.kind) return;
      try {
        const lines = splitter.push(chunk);
        for (const line of lines) {
          const parsed = parseEventLine(line);
          if (!parsed.ok) {
            finishOnce("error", { reason: "malformed_json", detail: parsed.error });
            return;
          }
          handleEvent(parsed.value, Buffer.byteLength(line, "utf8"));
          if (outcome.kind) return;
        }
      } catch (e) {
        if (e instanceof ProtocolLimitError) {
          finishOnce("error", { reason: e.reason, detail: e.detail });
        } else {
          finishOnce("error", { reason: "protocol_exception", detail: e.message });
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      lastActivityAt = Date.now();
      stderrBuf += chunk;
    });

    child.on("error", (err) => {
      spawnError = err.message;
      finishOnce("error", { reason: "spawn_error", detail: err.message });
    });

    child.on("exit", (code, signal) => {
      childExited = true;
      childExitInfo = { code, signal };
      exitedAt = Date.now();
      lastActivityAt = exitedAt;
      if (!outcome.kind) {
        // Child process disappeared before reaching a terminal event / final text.
        finishOnce("error", {
          reason: "process_disappeared",
          detail: { code, signal, incompleteFinalLine: splitter.hasIncompleteLine }
        });
      }
    });

    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      if (outcome.kind) return;
      timedOut = true;
      send({ type: "abort" });
      send({ type: "abort_bash" });
      finishOnce("timed_out", {});
    }, timeoutMs);

    function onAbort() {
      if (outcome.kind) return;
      aborted = true;
      send({ type: "abort" });
      send({ type: "abort_bash" });
      finishOnce("aborted", {});
    }
    if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });

    // Send the prompt: task card is carried entirely inside the JSON
    // "message" field of the RPC command, never in argv or a shell string.
    // C4N: the system-assembled reviewer evidence bundle is delivered as a
    // top-level message field when present（reviewer request only）.
    const message = { phase, attempt, taskCard };
    if (reviewEvidence !== undefined && reviewEvidence !== null) message.reviewEvidence = reviewEvidence;
    send({ type: "prompt", message: JSON.stringify(message) });

    await done;
    clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener("abort", onAbort);

    const termInfo = await terminateChild(child, { graceMs });

    const metadata = {
      piSessionId: null,
      providerUsage: lastAssistantUsage, // provider-reported usage or null (NOT_REPORTED)
      childPid,
      spawnedAt,
      lastActivityAt,
      exitedAt,
      piExecutable,
      piVersion: null,
      piSessionId: null,
      eventCount,
      toolCallCount: toolCallEnds.size,
      terminalReason: outcome.kind === "completed"
        ? (lastAssistantStopReason || "stop")
        : (outcome.detail && outcome.detail.reason) || outcome.kind,
      processTreeKilled: termInfo.processTreeKilled,
      args,
      toolSelection: toolSelectionMeta,
      rawWireBytes,
      protocolCumulativeBytes: splitter.cumulativeBytes,
      protocolMaxCumulativeBytes: configuredMaxCumulativeBytes,
      protocolHardMaxCumulativeBytes: HARD_MAX_CUMULATIVE_BYTES,
      protocolEventTypeCounts: Object.fromEntries(eventTypeCounts),
      protocolBytesByEventType: Object.fromEntries(bytesByEventType),
      protocolMessageUpdateBytes: (bytesByEventType.get("message_update") || 0),
      protocolMessageSnapshotBytes: messageSnapshotBytes,
      protocolMessagePartialBytes: messagePartialBytes,
      protocolMessageDeltaBytes: messageDeltaBytes,
      protocolMessageUpdateSubtypeCounts: messageUpdateSubtypeCounts,
      protocolThinkingDeltaCount: thinkingDeltaCount,
      protocolThinkingDeltaBytes: thinkingDeltaBytes,
      protocolTextDeltaCount: textDeltaCount,
      protocolTextDeltaBytes: textDeltaBytes,
      protocolMaxObservedLineBytes: maxObservedLineBytes,
      protocolAverageObservedLineBytes: totalLineCount > 0 ? Math.round(totalLineBytes / totalLineCount) : 0,
    };

    if (outcome.kind === "completed") {
      if (lastAssistantStopReason === "error" || lastAssistantStopReason === "aborted") {
        return assertAdapterResult(errorResult({
          executionId, stdout: finalText || "", stderr: stderrBuf,
          error: lastAssistantErrorMessage || `assistant stopReason=${lastAssistantStopReason}`,
          metadata,
        }));
      }
      return assertAdapterResult(completedResult({ executionId, stdout: finalText || "", stderr: stderrBuf, metadata }));
    }
    if (outcome.kind === "timed_out") {
      return assertAdapterResult(timedOutResult({
        executionId, stdout: "", stderr: stderrBuf,
        signal: termInfo.processTreeKilled ? "SIGKILL" : null, metadata,
      }));
    }
    if (outcome.kind === "aborted") {
      return assertAdapterResult(abortedResult({
        executionId, stdout: "", stderr: stderrBuf,
        signal: termInfo.processTreeKilled ? "SIGKILL" : null, metadata,
      }));
    }
    // "error"
    const detail = outcome.detail || {};
    return assertAdapterResult(errorResult({
      executionId, stdout: "", stderr: stderrBuf,
      error: spawnError || `pi_rpc_adapter_error: ${detail.reason || "unknown"}`,
      metadata,
    }));
  }

  return { runAdapter };
}
