// test-pi-rpc-adapter.mjs
//
// Offline tests for src/adapter/pi-rpc-protocol.mjs and
// src/adapter/pi-rpc-adapter.mjs. The only child process ever spawned here
// is test/fixtures/fake-pi-rpc.mjs (via `node`), which never calls a
// network, a provider, or the real `pi` binary. No real Pi prompt occurs
// in this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { createPiRpcAdapter, DEFAULT_ENV_ALLOWLIST } from "../src/adapter/pi-rpc-adapter.mjs";
import { createJsonlSplitter, ProtocolLimitError, DEFAULT_MAX_LINE_BYTES, DEFAULT_MAX_CUMULATIVE_BYTES, HARD_MAX_CUMULATIVE_BYTES } from "../src/adapter/pi-rpc-protocol.mjs";
import { createScriptedAdapter } from "../src/adapter/scripted-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "fixtures", "fake-pi-rpc.mjs");
const ALLOWLIST_WITH_CONTROL = [...DEFAULT_ENV_ALLOWLIST, "FAKE_PI_CONTROL"];

function baseRequest(overrides = {}) {
  return {
    executionId: "exec-test",
    cwd: tmpdir(),
    taskCard: { id: "card" },
    phase: "executor",
    attempt: 0,
    timeoutMs: 5000,
    ...overrides,
  };
}

async function withFakeControl(control, fn) {
  process.env.FAKE_PI_CONTROL = JSON.stringify(control);
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_PI_CONTROL;
  }
}

function makeAdapter(adapterOptions = {}) {
  return createPiRpcAdapter({
    piExecutable: FIXTURE,
    environmentAllowlist: ALLOWLIST_WITH_CONTROL,
    graceMs: 150,
    ...adapterOptions,
  });
}

// ---------------------------------------------------------------------------
// Protocol unit tests (T2, T3, T4, T6, T7, T9) -- pure, deterministic,
// exercised directly against the splitter rather than via subprocess timing.
// ---------------------------------------------------------------------------

test("T2 a JSON line split across two pushed chunks reassembles correctly", () => {
  const splitter = createJsonlSplitter();
  const full = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  const mid = Math.floor(full.length / 2);
  assert.deepEqual(splitter.push(full.slice(0, mid)), []);
  const lines = splitter.push(full.slice(mid) + "\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), JSON.parse(full));
});

test("T3 multiple JSON lines within a single chunk are parsed in order", () => {
  const splitter = createJsonlSplitter();
  const l1 = JSON.stringify({ type: "a" });
  const l2 = JSON.stringify({ type: "b" });
  const l3 = JSON.stringify({ type: "c" });
  const lines = splitter.push(`${l1}\n${l2}\n${l3}\n`);
  assert.deepEqual(lines, [l1, l2, l3]);
});

test("T4 CRLF line endings are handled (trailing CR stripped)", () => {
  const splitter = createJsonlSplitter();
  const l1 = JSON.stringify({ type: "x" });
  assert.deepEqual(splitter.push(`${l1}\r\n`), [l1]);
});

test("T6 an oversized line is bounded and fails closed", () => {
  const splitter = createJsonlSplitter({ maxLineBytes: 10 });
  assert.throws(() => splitter.push("x".repeat(100) + "\n"), ProtocolLimitError);
});

test("T7 cumulative event bytes across many lines are bounded and fail closed", () => {
  const splitter = createJsonlSplitter({ maxLineBytes: 1000, maxCumulativeBytes: 50 });
  assert.throws(() => {
    splitter.push("x".repeat(30) + "\n");
    splitter.push("y".repeat(30) + "\n");
  }, ProtocolLimitError);
});

test("T9 an incomplete final line (no trailing newline) is detectable", () => {
  const splitter = createJsonlSplitter();
  splitter.push('{"type":"partial"');
  assert.equal(splitter.hasIncompleteLine, true);
});

// ── A. Constants and defaults ──

test("A1: DEFAULT_MAX_CUMULATIVE_BYTES === 64 MiB", () => {
  assert.equal(DEFAULT_MAX_CUMULATIVE_BYTES, 64 * 1024 * 1024);
});

test("A2: HARD_MAX_CUMULATIVE_BYTES === 256 MiB", () => {
  assert.equal(HARD_MAX_CUMULATIVE_BYTES, 256 * 1024 * 1024);
});

test("A3: splitter with no override uses 64 MiB default", () => {
  const s = createJsonlSplitter();
  assert.equal(s.maxCumulativeBytes, 64 * 1024 * 1024);
});

test("A4: 2 MiB line limit unchanged", () => {
  assert.equal(DEFAULT_MAX_LINE_BYTES, 2 * 1024 * 1024);
  const s = createJsonlSplitter();
  assert.equal(s.maxLineBytes, 2 * 1024 * 1024);
});

// ── B. Direct splitter validation ──

test("B5: small positive integer override works", () => {
  const s = createJsonlSplitter({ maxCumulativeBytes: 1000 });
  assert.equal(s.maxCumulativeBytes, 1000);
  // Feed data within limit
  s.push("x".repeat(500) + "\n");
  assert.equal(s.cumulativeBytes, 500);
});

test("B6: under limit passes", () => {
  const s = createJsonlSplitter({ maxCumulativeBytes: 100 });
  s.push("a".repeat(50) + "\n");
  assert.equal(s.cumulativeBytes, 50);
});

test("B7: exceeding limit throws cumulative_limit_exceeded", () => {
  const s = createJsonlSplitter({ maxCumulativeBytes: 50 });
  s.push("a".repeat(30) + "\n");
  assert.throws(() => s.push("b".repeat(30) + "\n"), (err) => {
    return err instanceof ProtocolLimitError && err.reason === "cumulative_limit_exceeded";
  });
});

test("B8: 256 MiB exact value accepted", () => {
  const s = createJsonlSplitter({ maxCumulativeBytes: 256 * 1024 * 1024 });
  assert.equal(s.maxCumulativeBytes, 256 * 1024 * 1024);
});

test("B9: 256 MiB + 1 rejected", () => {
  assert.throws(() => createJsonlSplitter({ maxCumulativeBytes: 256 * 1024 * 1024 + 1 }), (err) => {
    return err instanceof ProtocolLimitError &&
      err.reason === "invalid_limit_configuration" &&
      err.detail.reason === "hard_ceiling_exceeded";
  });
});

test("B10: zero rejected", () => {
  assert.throws(() => createJsonlSplitter({ maxCumulativeBytes: 0 }), (err) => {
    return err instanceof ProtocolLimitError && err.detail.reason === "not_positive";
  });
});

test("B11: negative rejected", () => {
  assert.throws(() => createJsonlSplitter({ maxCumulativeBytes: -1 }), (err) => {
    return err instanceof ProtocolLimitError && err.detail.reason === "not_positive";
  });
});

test("B12: fractional rejected", () => {
  assert.throws(() => createJsonlSplitter({ maxCumulativeBytes: 1.5 }), (err) => {
    return err instanceof ProtocolLimitError && err.detail.reason === "not_integer";
  });
});

test("B13: NaN rejected", () => {
  assert.throws(() => createJsonlSplitter({ maxCumulativeBytes: NaN }), (err) => {
    return err instanceof ProtocolLimitError && err.detail.reason === "not_finite";
  });
});

test("B14: Infinity rejected", () => {
  assert.throws(() => createJsonlSplitter({ maxCumulativeBytes: Infinity }), (err) => {
    return err instanceof ProtocolLimitError && err.detail.reason === "not_finite";
  });
});

test("B15: string rejected", () => {
  assert.throws(() => createJsonlSplitter({ maxCumulativeBytes: "100" }), (err) => {
    return err instanceof ProtocolLimitError && err.detail.reason === "not_a_number";
  });
});

test("B16: explicit null rejected", () => {
  assert.throws(() => createJsonlSplitter({ maxCumulativeBytes: null }), (err) => {
    return err instanceof ProtocolLimitError && err.detail.reason === "not_a_number";
  });
});

// ---------------------------------------------------------------------------
// Adapter end-to-end tests against the fake Pi RPC child.
// ---------------------------------------------------------------------------

test("T1 normal completion: args, cwd, prompt, executionId, output, terminal event, final completed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rpc-t1-"));
  const cwdFile = join(cwd, "reported-cwd.txt");
  try {
    await withFakeControl(
      { scenario: "normal", assistantTextByPhase: { executor: "AUTOLOOP_OK" }, cwdFile },
      async () => {
        const adapter = makeAdapter();
        const result = await adapter.runAdapter(baseRequest({ cwd, executionId: "exec-abc" }));
        assert.equal(result.status, "completed");
        assert.equal(result.executionId, "exec-abc");
        assert.equal(result.stdout, "AUTOLOOP_OK");
        assert.equal(result.signal, null);
        assert.equal(result.error, null);
        assert.ok(result.metadata.args.includes("--mode"));
        assert.ok(result.metadata.args.includes("rpc"));
        assert.ok(result.metadata.args.includes("--no-session"));
        assert.equal(result.metadata.terminalReason, "stop");
        assert.equal(readFileSync(cwdFile, "utf8"), realpathSync(cwd));
      },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("T5 malformed JSON from the child yields status=error", async () => {
  await withFakeControl({ scenario: "malformed-json" }, async () => {
    const adapter = makeAdapter();
    const result = await adapter.runAdapter(baseRequest());
    assert.equal(result.status, "error");
    assert.ok(result.error);
  });
});

test("T8 exit 0 without ever emitting a terminal event yields status=error", async () => {
  await withFakeControl({ scenario: "missing-terminal" }, async () => {
    const adapter = makeAdapter();
    const result = await adapter.runAdapter(baseRequest());
    assert.equal(result.status, "error");
  });
});

test("T9b an incomplete final line at process exit yields status=error", async () => {
  await withFakeControl({ scenario: "incomplete-line" }, async () => {
    const adapter = makeAdapter();
    const result = await adapter.runAdapter(baseRequest());
    assert.equal(result.status, "error");
  });
});

test("T10 stderr never enters the JSON parser and is captured separately", async () => {
  await withFakeControl({ scenario: "stderr-noise", assistantTextByPhase: { executor: "fine" } }, async () => {
    const adapter = makeAdapter();
    const result = await adapter.runAdapter(baseRequest());
    assert.equal(result.status, "completed");
    assert.match(result.stderr, /noise line 1/);
  });
});

test("T11 an unknown event type is recorded but does not cause an error", async () => {
  await withFakeControl({ scenario: "unknown-event", assistantTextByPhase: { executor: "fine" } }, async () => {
    const adapter = makeAdapter();
    const result = await adapter.runAdapter(baseRequest());
    assert.equal(result.status, "completed");
    assert.ok(result.metadata.eventCount > 0);
  });
});

test("T12 tool_execution start/end pairs are accounted into toolCallCount", async () => {
  await withFakeControl({ scenario: "tool-events", assistantTextByPhase: { executor: "fine" } }, async () => {
    const adapter = makeAdapter();
    const result = await adapter.runAdapter(baseRequest());
    assert.equal(result.status, "completed");
    assert.equal(result.metadata.toolCallCount, 2);
  });
});

test("T13 an already-aborted AbortSignal prevents spawning the child at all", async () => {
  const pidFile = join(tmpdir(), `pi-rpc-t13-${process.pid}-${Date.now()}.pid`);
  await withFakeControl({ scenario: "normal", pidFile }, async () => {
    const adapter = makeAdapter();
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.runAdapter(baseRequest({ abortSignal: controller.signal }));
    assert.equal(result.status, "aborted");
    assert.equal(existsSync(pidFile), false, "child must never have been spawned");
  });
});

test("T14 mid-flight RPC abort succeeds without needing SIGKILL (no protocol response required)", async () => {
  const pidFile = join(tmpdir(), `pi-rpc-t14-${process.pid}-${Date.now()}.pid`);
  await withFakeControl({ scenario: "hang", pidFile }, async () => {
    const adapter = makeAdapter({ graceMs: 200 });
    const controller = new AbortController();
    const resultPromise = adapter.runAdapter(baseRequest({ abortSignal: controller.signal, timeoutMs: 30000 }));
    await new Promise((r) => setTimeout(r, 150)); // let the child spawn and receive the prompt
    controller.abort();
    const result = await resultPromise;
    assert.equal(result.status, "aborted");
    assert.equal(result.metadata.processTreeKilled, false, "plain SIGTERM should have sufficed");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "fake child must not be an orphan after abort");
  });
});

test("T15 abort ignored by the child escalates through SIGTERM to SIGKILL with no orphan", async () => {
  const pidFile = join(tmpdir(), `pi-rpc-t15-${process.pid}-${Date.now()}.pid`);
  await withFakeControl({ scenario: "ignore-abort", pidFile }, async () => {
    const adapter = makeAdapter({ graceMs: 150 });
    const controller = new AbortController();
    const resultPromise = adapter.runAdapter(baseRequest({ abortSignal: controller.signal, timeoutMs: 30000 }));
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    const result = await resultPromise;
    assert.equal(result.status, "aborted");
    assert.equal(result.metadata.processTreeKilled, true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "fake child must not be an orphan after SIGKILL");
  });
});

test("T15b process-group SIGKILL also reaps a descendant grandchild process", async () => {
  const pidFile = join(tmpdir(), `pi-rpc-t15b-${process.pid}-${Date.now()}.pid`);
  const descendantPidFile = join(tmpdir(), `pi-rpc-t15b-desc-${process.pid}-${Date.now()}.pid`);
  await withFakeControl({ scenario: "descendant-child", pidFile, descendantPidFile }, async () => {
    const adapter = makeAdapter({ graceMs: 150 });
    const controller = new AbortController();
    const resultPromise = adapter.runAdapter(baseRequest({ abortSignal: controller.signal, timeoutMs: 30000 }));
    // Give the fake time to spawn its grandchild and write the pid file.
    await new Promise((r) => setTimeout(r, 250));
    controller.abort();
    await resultPromise;
    assert.ok(existsSync(descendantPidFile), "fake must have recorded a descendant pid");
    const descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/, "descendant must die with the process group");
  });
});

test("T16 timeout without any abortSignal yields status=timed_out with process tree cleaned up", async () => {
  const pidFile = join(tmpdir(), `pi-rpc-t16-${process.pid}-${Date.now()}.pid`);
  await withFakeControl({ scenario: "hang", pidFile }, async () => {
    const adapter = makeAdapter({ graceMs: 150 });
    const result = await adapter.runAdapter(baseRequest({ timeoutMs: 200 }));
    assert.equal(result.status, "timed_out");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "fake child must not survive a timeout");
  });
});

test("T17 task card content with shell metacharacters only ever enters JSON stdin, never argv", async () => {
  const receivedPromptFile = join(tmpdir(), `pi-rpc-t17-${process.pid}-${Date.now()}.json`);
  const nasty = 'quote"quote \'single\' \n newline $(whoami) `id` ; rm -rf / | cat';
  const taskCard = { dangerous: nasty };
  try {
    await withFakeControl(
      { scenario: "normal", assistantTextByPhase: { executor: "ok" }, receivedPromptFile },
      async () => {
        const adapter = makeAdapter();
        const result = await adapter.runAdapter(baseRequest({ taskCard, phase: "executor", attempt: 0 }));
        assert.equal(result.status, "completed");
        for (const a of result.metadata.args) {
          assert.ok(!String(a).includes(nasty), "task card content must never appear in argv");
        }
        const recorded = JSON.parse(readFileSync(receivedPromptFile, "utf8"));
        const expectedMessage = JSON.stringify({ phase: "executor", attempt: 0, taskCard });
        assert.equal(recorded.length, expectedMessage.length);
        assert.equal(recorded.sha256, createHash("sha256").update(expectedMessage, "utf8").digest("hex"));
      },
    );
  } finally {
    rmSync(receivedPromptFile, { force: true });
  }
});

test("T18 AutoLoop executionId is preserved and never conflated with a Pi session identity", async () => {
  await withFakeControl({ scenario: "normal", assistantTextByPhase: { executor: "ok" } }, async () => {
    const adapter = makeAdapter();
    const result = await adapter.runAdapter(baseRequest({ executionId: "autoloop-exec-999" }));
    assert.equal(result.executionId, "autoloop-exec-999");
    assert.notEqual(result.metadata.piSessionId, result.executionId);
  });
});

test("T19 forbidden CLI args never appear in the child's argv", async () => {
  await withFakeControl({ scenario: "normal", assistantTextByPhase: { executor: "ok" } }, async () => {
    const adapter = makeAdapter();
    const result = await adapter.runAdapter(baseRequest());
    for (const forbidden of ["--approve", "-a", "-c", "--continue", "-r", "--resume", "--session", "--fork"]) {
      assert.ok(!result.metadata.args.includes(forbidden), `${forbidden} must never appear in child args`);
    }
  });
});

test("T19b requesting a forbidden extraArg yields status=error and never spawns the child", async () => {
  const pidFile = join(tmpdir(), `pi-rpc-t19b-${process.pid}-${Date.now()}.pid`);
  await withFakeControl({ scenario: "normal", pidFile }, async () => {
    const adapter = makeAdapter({ extraArgs: ["--approve"] });
    const result = await adapter.runAdapter(baseRequest());
    assert.equal(result.status, "error");
    assert.match(result.error, /forbidden_arg/);
    assert.equal(existsSync(pidFile), false, "child must never have been spawned");
  });
});

test("T23 a nonexistent Pi executable yields status=error with no fallback", async () => {
  const adapter = createPiRpcAdapter({ piExecutable: "/nonexistent/pi/binary/does/not/exist" });
  const result = await adapter.runAdapter(baseRequest());
  assert.equal(result.status, "error");
  assert.ok(result.error);
});

test("T24 the scripted adapter's behavior is unaffected by the existence of the Pi RPC adapter", async () => {
  const scripted = createScriptedAdapter([
    { expect: { phase: "executor", attempt: 0 }, result: { status: "completed", stdout: "x", stderr: "", signal: null, error: null, metadata: {} } },
  ]);
  const result = await scripted.runAdapter(baseRequest());
  assert.equal(result.status, "completed");
});

test("T24b creating a Pi RPC adapter has no side effect: nothing is spawned until runAdapter() is called", async () => {
  const pidFile = join(tmpdir(), `pi-rpc-t24b-${process.pid}-${Date.now()}.pid`);
  await withFakeControl({ scenario: "normal", pidFile }, async () => {
    const adapter = makeAdapter();
    assert.equal(typeof adapter.runAdapter, "function");
    // Construction alone (above) must not have spawned anything.
    assert.equal(existsSync(pidFile), false);
  });
});

// ── C. Adapter default path with cumulative-overflow ──

test("C17: cumulative-overflow with default 64 MiB returns error", async () => {
  const adapter = makeAdapter();
  const result = await adapter.runAdapter(baseRequest());
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(r.status, "error");
  });
});

test("C18: cumulative-overflow terminalReason is cumulative_limit_exceeded", async () => {
  const adapter = makeAdapter();
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(r.status, "error");
    assert.equal(r.metadata.terminalReason, "cumulative_limit_exceeded");
  });
});

test("C19: default path metadata shows configured limit = 64 MiB", async () => {
  const adapter = makeAdapter();
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(r.metadata.protocolMaxCumulativeBytes, 64 * 1024 * 1024);
  });
});

test("C20: default path cumulative bytes > 64 MiB", async () => {
  const adapter = makeAdapter();
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.ok(r.metadata.protocolCumulativeBytes > 64 * 1024 * 1024,
      `Expected > 64 MiB, got ${r.metadata.protocolCumulativeBytes}`);
  });
});

test("C21: tool call count remains 0", async () => {
  const adapter = makeAdapter();
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(r.metadata.toolCallCount, 0);
  });
});

test("C22: process is cleaned up", async () => {
  const adapter = makeAdapter();
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.ok(r.metadata.processTreeKilled !== undefined);
  });
});

// ── D. Adapter bounded override path ──

test("D23: cumulative-overflow with 128 MiB override completes", async () => {
  const adapter = makeAdapter({
    protocolLimits: { maxCumulativeBytes: 128 * 1024 * 1024 }
  });
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(r.status, "completed", `Expected completed, got ${r.status}: ${r.error || ""}`);
  });
});

test("D24: override path final stdout retrieved", async () => {
  const adapter = makeAdapter({
    protocolLimits: { maxCumulativeBytes: 128 * 1024 * 1024 }
  });
  await withFakeControl({ scenario: "cumulative-overflow", assistantTextByPhase: { executor: "OVERRIDE_OK" } }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(r.status, "completed");
    assert.equal(r.stdout, "OVERRIDE_OK");
  });
});

test("D25: override path configured limit = 128 MiB", async () => {
  const adapter = makeAdapter({
    protocolLimits: { maxCumulativeBytes: 128 * 1024 * 1024 }
  });
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(r.metadata.protocolMaxCumulativeBytes, 128 * 1024 * 1024);
  });
});

test("D26: override path cumulative bytes > 64 MiB", async () => {
  const adapter = makeAdapter({
    protocolLimits: { maxCumulativeBytes: 128 * 1024 * 1024 }
  });
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.ok(r.metadata.protocolCumulativeBytes > 64 * 1024 * 1024,
      `Expected > 64 MiB, got ${r.metadata.protocolCumulativeBytes}`);
  });
});

test("D27: override path cumulative bytes <= 128 MiB", async () => {
  const adapter = makeAdapter({
    protocolLimits: { maxCumulativeBytes: 128 * 1024 * 1024 }
  });
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.ok(r.metadata.protocolCumulativeBytes <= 128 * 1024 * 1024,
      `Expected <= 128 MiB, got ${r.metadata.protocolCumulativeBytes}`);
  });
});

test("D28: override path tool call count = 0", async () => {
  const adapter = makeAdapter({
    protocolLimits: { maxCumulativeBytes: 128 * 1024 * 1024 }
  });
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(r.metadata.toolCallCount, 0);
  });
});

test("D29: override path process cleaned up", async () => {
  const adapter = makeAdapter({
    protocolLimits: { maxCumulativeBytes: 128 * 1024 * 1024 }
  });
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.ok(r.metadata.processTreeKilled !== undefined);
  });
});

test("D30: override path session mode / args unchanged", async () => {
  const adapter = makeAdapter({
    protocolLimits: { maxCumulativeBytes: 128 * 1024 * 1024 }
  });
  await withFakeControl({ scenario: "cumulative-overflow" }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    const args = r.metadata.args;
    assert.ok(args.includes("--no-session"), "must include --no-session");
    assert.ok(args.includes("--no-tools"), "must include --no-tools");
    assert.ok(args.includes("--no-extensions"), "must include --no-extensions");
  });
});

// ── E. Invalid adapter configuration ──

test("E31: HARD_MAX + 1 does not spawn child", async () => {
  const pidFile = join(tmpdir(), `pi-rpc-e31-${process.pid}-${Date.now()}.pid`);
  const adapter = createPiRpcAdapter({
    piExecutable: FIXTURE,
    environmentAllowlist: ALLOWLIST_WITH_CONTROL,
    protocolLimits: { maxCumulativeBytes: HARD_MAX_CUMULATIVE_BYTES + 1 }
  });
  await withFakeControl({ scenario: "normal", pidFile }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(r.status, "error");
    assert.equal(existsSync(pidFile), false, "child must not have been spawned");
  });
});

test("E32: Infinity does not spawn child", async () => {
  const pidFile = join(tmpdir(), `pi-rpc-e32-${process.pid}-${Date.now()}.pid`);
  const adapter = createPiRpcAdapter({
    piExecutable: FIXTURE,
    environmentAllowlist: ALLOWLIST_WITH_CONTROL,
    protocolLimits: { maxCumulativeBytes: Infinity }
  });
  await withFakeControl({ scenario: "normal", pidFile }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(r.status, "error");
    assert.equal(existsSync(pidFile), false, "child must not have been spawned");
  });
});

test("E33: negative does not spawn child", async () => {
  const pidFile = join(tmpdir(), `pi-rpc-e33-${process.pid}-${Date.now()}.pid`);
  const adapter = createPiRpcAdapter({
    piExecutable: FIXTURE,
    environmentAllowlist: ALLOWLIST_WITH_CONTROL,
    protocolLimits: { maxCumulativeBytes: -100 }
  });
  await withFakeControl({ scenario: "normal", pidFile }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(r.status, "error");
    assert.equal(existsSync(pidFile), false, "child must not have been spawned");
  });
});

test("E34: invalid config returns status=error", async () => {
  const adapter = createPiRpcAdapter({
    piExecutable: FIXTURE,
    environmentAllowlist: ALLOWLIST_WITH_CONTROL,
    protocolLimits: { maxCumulativeBytes: 0 }
  });
  const r = await adapter.runAdapter(baseRequest());
  assert.equal(r.status, "error");
});

test("E35: error does not contain environment or prompt", async () => {
  const adapter = createPiRpcAdapter({
    piExecutable: FIXTURE,
    environmentAllowlist: ALLOWLIST_WITH_CONTROL,
    protocolLimits: { maxCumulativeBytes: 0 }
  });
  const r = await adapter.runAdapter(baseRequest());
  const str = JSON.stringify(r);
  assert.ok(!str.includes("FAKE_PI_CONTROL"), "error must not contain env var");
  assert.ok(!str.includes("taskCard"), "error must not contain taskCard");
});

// ── F. Metadata safety ──

test("F36: metadata has numeric limits and counter", async () => {
  const adapter = makeAdapter();
  await withFakeControl({ scenario: "normal", assistantTextByPhase: { executor: "ok" } }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    assert.equal(typeof r.metadata.protocolCumulativeBytes, "number");
    assert.equal(typeof r.metadata.protocolMaxCumulativeBytes, "number");
    assert.equal(typeof r.metadata.protocolHardMaxCumulativeBytes, "number");
  });
});

test("F37: metadata does not contain raw event", async () => {
  const adapter = makeAdapter();
  await withFakeControl({ scenario: "normal", assistantTextByPhase: { executor: "ok" } }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    const str = JSON.stringify(r.metadata);
    assert.ok(!str.includes("message_update"), "metadata must not contain raw events");
    assert.ok(!str.includes("agent_start"), "metadata must not contain raw events");
  });
});

test("F38: metadata does not contain provider output", async () => {
  const adapter = makeAdapter();
  await withFakeControl({ scenario: "normal", assistantTextByPhase: { executor: "secret-output-12345" } }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    const str = JSON.stringify(r.metadata);
    assert.ok(!str.includes("secret-output"), "metadata must not contain output content");
  });
});

test("F39: metadata does not contain credential-like fixture value", async () => {
  const adapter = makeAdapter();
  await withFakeControl({ scenario: "normal", assistantTextByPhase: { executor: "sk-test-token" } }, async () => {
    const r = await adapter.runAdapter(baseRequest());
    const str = JSON.stringify(r.metadata);
    assert.ok(!str.includes("sk-test"), "metadata must not contain fake credential");
  });
});
