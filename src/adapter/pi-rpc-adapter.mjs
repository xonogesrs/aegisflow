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
import { createJsonlSplitter, parseEventLine, ProtocolLimitError } from "./pi-rpc-protocol.mjs";

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

function toolPolicyArgs(toolPolicy) {
  if (!toolPolicy || toolPolicy.mode === "no-tools") return ["--no-tools"];
  if (toolPolicy.mode === "no-builtin-tools") return ["--no-builtin-tools"];
  if (toolPolicy.mode === "allowlist" && Array.isArray(toolPolicy.tools)) return ["--tools", toolPolicy.tools.join(",")];
  if (toolPolicy.mode === "denylist" && Array.isArray(toolPolicy.tools)) return ["--exclude-tools", toolPolicy.tools.join(",")];
  // Unknown/unspecified toolPolicy fails closed to the safest default rather
  // than guessing a permissive one.
  return ["--no-tools"];
}

function buildArgs({ provider, model, toolPolicy, extraArgs = [] }) {
  for (const a of extraArgs) {
    if (FORBIDDEN_ARGS.has(a)) {
      throw new Error(`pi_rpc_adapter_forbidden_arg: ${a}`);
    }
  }
  const args = [
    "--mode", "rpc",
    "--no-session",
    ...toolPolicyArgs(toolPolicy),
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
    graceMs = 300,
  } = options;

  async function runAdapter(request) {
    assertAdapterRequest(request);
    const { executionId, cwd, phase, attempt, timeoutMs, abortSignal, taskCard } = request;
    const allowlist = request.environmentAllowlist || environmentAllowlist;
    const toolPolicy = request.toolPolicy || defaultToolPolicy;

    if (abortSignal && abortSignal.aborted) {
      return assertAdapterResult(abortedResult({ executionId, stdout: "", stderr: "", metadata: {} }));
    }

    let args;
    try {
      args = buildArgs({ provider, model, toolPolicy, extraArgs });
    } catch (e) {
      return assertAdapterResult(errorResult({ executionId, stdout: "", stderr: "", error: e.message, metadata: {} }));
    }
    const env = buildChildEnv(allowlist);

    let child;
    try {
      child = spawn(piExecutable, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return assertAdapterResult(errorResult({ executionId, stdout: "", stderr: "", error: e.message, metadata: { args } }));
    }

    const splitter = createJsonlSplitter();
    let stderrBuf = "";
    let eventCount = 0;
    let toolCallStarts = new Set();
    let toolCallEnds = new Set();
    let sawAgentSettled = false;
    let lastAssistantStopReason = null;
    let lastAssistantErrorMessage = null;
    let protocolError = null;
    let finalText = null;
    let awaitingFinalText = false;
    let spawnError = null;
    let childExited = false;
    let childExitInfo = { code: null, signal: null };

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

    function handleEvent(evt) {
      eventCount += 1;
      if (evt.type === "tool_execution_start" && evt.toolCallId) toolCallStarts.add(evt.toolCallId);
      if (evt.type === "tool_execution_end" && evt.toolCallId) toolCallEnds.add(evt.toolCallId);
      if (evt.type === "message_end" && evt.message && evt.message.role === "assistant") {
        lastAssistantStopReason = evt.message.stopReason ?? lastAssistantStopReason;
        lastAssistantErrorMessage = evt.message.errorMessage ?? lastAssistantErrorMessage;
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
    child.stdout.on("data", (chunk) => {
      if (outcome.kind) return;
      try {
        const lines = splitter.push(chunk);
        for (const line of lines) {
          const parsed = parseEventLine(line);
          if (!parsed.ok) {
            finishOnce("error", { reason: "malformed_json", detail: parsed.error });
            return;
          }
          handleEvent(parsed.value);
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
      stderrBuf += chunk;
    });

    child.on("error", (err) => {
      spawnError = err.message;
      finishOnce("error", { reason: "spawn_error", detail: err.message });
    });

    child.on("exit", (code, signal) => {
      childExited = true;
      childExitInfo = { code, signal };
      if (!outcome.kind) {
        // Child ended before we ever reached a terminal event / final text.
        const reason = splitter.hasIncompleteLine ? "incomplete_final_line" : "missing_terminal_event";
        finishOnce("error", { reason, detail: { code, signal } });
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
    send({ type: "prompt", message: JSON.stringify({ phase, attempt, taskCard }) });

    await done;
    clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener("abort", onAbort);

    const termInfo = await terminateChild(child, { graceMs });

    const metadata = {
      exitCode: childExited ? childExitInfo.code : null,
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
