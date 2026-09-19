#!/usr/bin/env node
// fake-pi-rpc.mjs
//
// Deterministic, fully local stand-in for `pi --mode rpc`. Speaks the same
// JSONL stdin/stdout framing documented in Pi's docs/rpc.md, driven by a
// scenario name in FAKE_PI_CONTROL (JSON-encoded). No network, no provider,
// no real Pi. Used only by test/test-pi-rpc-adapter.mjs and
// test/test-pi-lifecycle-integration.mjs to exercise src/adapter/pi-rpc-adapter.mjs
// without ever spawning the real `pi` binary.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

if (!("FAKE_PI_CONTROL" in process.env)) {
  // Standalone invocation (e.g. bare `node --test` / `node --test test/`
  // fixture discovery) rather than a deliberate fixture activation by the
  // adapter test harness, which always sets FAKE_PI_CONTROL explicitly
  // (even to "{}") before spawning this file. Exit immediately instead of
  // starting the persistent fake Pi RPC runtime below, so test discovery
  // doesn't hang forever on the unconditional keep-alive interval.
  process.exit(0);
}

const control = JSON.parse(process.env.FAKE_PI_CONTROL || "{}");
const scenario = control.scenario || "normal";

if (control.pidFile) {
  writeFileSync(control.pidFile, String(process.pid));
}
if (control.cwdFile) {
  writeFileSync(control.cwdFile, process.cwd());
}

let buffer = "";
let promptSeen = false;
let currentPhase = "executor";
let currentAttempt = 0;
let finalTextByPhase = control.assistantTextByPhase || {};
let ignoreAbort = scenario === "ignore-abort" || scenario === "descendant-child";

if (ignoreAbort) {
  // Only SIGKILL may end this process; SIGTERM is deliberately swallowed so
  // the adapter's escalation ladder (abort -> SIGTERM -> SIGKILL) is
  // actually exercised end to end.
  process.on("SIGTERM", () => {});
}

// Real Pi's RPC server never exits on its own (docs/rpc.md: no "quit"
// command) -- including on stdin close, which the adapter always does as
// its first termination step. A trivial script with only stdin listeners
// would otherwise let Node's event loop empty out and exit gracefully the
// moment stdin ends, defeating every SIGTERM/SIGKILL escalation test. This
// keep-alive handle is what makes that persistent-process behavior
// faithful; scenarios that must self-exit (missing-terminal,
// incomplete-line) call process.exit() explicitly regardless.
setInterval(() => {}, 60_000);

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function writeRaw(text) {
  process.stdout.write(text);
}

function currentPhaseText(phase, attempt) {
  const v = finalTextByPhase[phase];
  if (Array.isArray(v)) return v[Math.min(attempt, v.length - 1)] ?? "OK";
  return v ?? "OK";
}

function emitNormalCompletion(phase, attempt) {
  const text = currentPhaseText(phase, attempt);
  write({ type: "agent_start" });
  write({ type: "turn_start" });
  write({ type: "message_start", message: { role: "assistant", content: [] } });
  if (scenario === "tool-events") {
    write({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: {} });
    write({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: {}, isError: false });
    write({ type: "tool_execution_start", toolCallId: "call_2", toolName: "bash", args: {} });
    write({ type: "tool_execution_end", toolCallId: "call_2", toolName: "bash", result: {}, isError: false });
  }
  if (scenario === "unknown-event") {
    write({ type: "some_future_event_this_adapter_has_never_seen", payload: 123 });
  }
  write({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      // TEST-ONLY control: when the harness sets assistantUsage, the fake
      // session emits a pi-ai Usage object on the FINAL assistant
      // message_end — the same authoritative channel the real provider
      // uses (P3-U1). Never emitted without the explicit control.
      ...(control.assistantUsage ? { usage: control.assistantUsage } : {}),
    },
  });
  write({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text }] }, toolResults: [] });
  write({ type: "agent_end", messages: [], willRetry: false });
  write({ type: "agent_settled" });
}

function handlePrompt(cmd) {
  promptSeen = true;
  let phase = "executor";
  let attempt = 0;
  try {
    const payload = JSON.parse(cmd.message);
    phase = payload.phase ?? phase;
    attempt = payload.attempt ?? attempt;
  } catch {
    // Non-JSON message: some offline tests send plain strings; fall back to
    // executor/attempt 0 defaults above.
  }
  currentPhase = phase;
  currentAttempt = attempt;

  if (control.receivedPromptFile) {
    const raw = cmd.message ?? "";
    const digest = createHash("sha256").update(raw, "utf8").digest("hex");
    writeFileSync(control.receivedPromptFile, JSON.stringify({ length: raw.length, sha256: digest, raw }));
  }

  if (cmd.id) write({ id: cmd.id, type: "response", command: "prompt", success: true });

  switch (scenario) {
    case "malformed-json": {
      write({ type: "agent_start" });
      writeRaw('{"type": "message_end", "message": {"role": "assistant"'); // truncated, no newline yet
      writeRaw("\n"); // now it's a malformed complete "line"
      write({ type: "agent_settled" });
      return;
    }
    case "oversized-line": {
      write({ type: "agent_start" });
      writeRaw(JSON.stringify({ type: "message_update", huge: "x".repeat(5 * 1024 * 1024) }) + "\n");
      write({ type: "agent_settled" });
      return;
    }
    case "cumulative-overflow": {
      write({ type: "agent_start" });
      for (let i = 0; i < 200; i++) {
        write({ type: "message_update", chunk: "y".repeat(500_000), i });
      }
      write({ type: "agent_settled" });
      return;
    }
    case "missing-terminal": {
      write({ type: "agent_start" });
      write({ type: "turn_start" });
      write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "stop" } });
      write({ type: "agent_end", messages: [], willRetry: false });
      // Deliberately never emit agent_settled, then exit.
      process.exit(0);
      return; // unreachable
    }
    case "incomplete-line": {
      write({ type: "agent_start" });
      writeRaw('{"type": "message_end", "message": {"role": "assistant"'); // no trailing newline at all
      process.exit(0);
      return; // unreachable
    }
    case "stderr-noise": {
      process.stderr.write("noise line 1\nnoise line 2 with {not json\n");
      emitNormalCompletion(phase, attempt);
      return;
    }
    case "hang":
    case "ignore-abort": {
      // Never responds again after acking the prompt; "hang" relies on the
      // adapter's timeout path, "ignore-abort" additionally traps SIGTERM
      // (see top of file) so only SIGKILL can end the process, exercising
      // the full abort -> SIGTERM -> SIGKILL escalation ladder.
      return;
    }
    case "error-stop-reason": {
      write({ type: "agent_start" });
      write({ type: "turn_start" });
      write({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "simulated provider error" },
      });
      write({ type: "agent_end", messages: [], willRetry: false });
      write({ type: "agent_settled" });
      return;
    }
    case "descendant-child": {
      const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
        detached: false,
        stdio: "ignore",
      });
      if (control.descendantPidFile) writeFileSync(control.descendantPidFile, String(grandchild.pid));
      return; // then behaves like ignore-abort: only SIGKILL ends it
    }
    default: {
      emitNormalCompletion(phase, attempt);
      return;
    }
  }
}

function handleLine(line) {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  if (cmd.type === "prompt") {
    handlePrompt(cmd);
  } else if (cmd.type === "abort" || cmd.type === "abort_bash") {
    if (cmd.id) write({ id: cmd.id, type: "response", command: cmd.type, success: true });
    if (!ignoreAbort && promptSeen) {
      write({ type: "agent_settled" });
    }
    // ignore-abort scenario: swallow silently, forcing SIGTERM/SIGKILL escalation.
  } else if (cmd.type === "get_last_assistant_text") {
    const text = currentPhaseText(currentPhase, currentAttempt);
    write({ id: cmd.id, type: "response", command: "get_last_assistant_text", success: true, data: { text } });
  } else {
    if (cmd.id) write({ id: cmd.id, type: "response", command: cmd.type || "unknown", success: true });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim().length > 0) handleLine(line);
  }
});

process.stdin.on("end", () => {
  // Real Pi's RPC server does not exit on stdin close either; mirror that
  // by staying alive until the adapter terminates the process explicitly.
});
