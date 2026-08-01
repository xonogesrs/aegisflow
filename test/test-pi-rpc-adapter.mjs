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
import { createJsonlSplitter, ProtocolLimitError } from "../src/adapter/pi-rpc-protocol.mjs";
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
