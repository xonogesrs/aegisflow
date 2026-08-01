// test-scripted-adapter.mjs
//
// Offline unit tests for adapter/scripted-adapter.mjs and adapter/contract.mjs.
// No subprocess, no network, no provider. Node built-in test runner only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createScriptedAdapter, ScriptedAdapterSequenceError } from "../src/adapter/scripted-adapter.mjs";
import { AdapterContractError } from "../src/adapter/contract.mjs";

function baseRequest(overrides = {}) {
  return {
    executionId: "exec-1",
    cwd: "/tmp/does-not-need-to-exist",
    taskCard: { id: "card-1" },
    phase: "executor",
    attempt: 0,
    timeoutMs: 1000,
    ...overrides,
  };
}

test("completed result round-trips and is recorded in callRecord", async () => {
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 0 },
      result: {
        status: "completed",
        stdout: "hello",
        stderr: "",
        signal: null,
        error: null,
        metadata: { exitCode: 0 },
      },
    },
  ]);

  const result = await adapter.runAdapter(baseRequest());
  assert.equal(result.status, "completed");
  assert.equal(result.executionId, "exec-1");
  assert.equal(result.stdout, "hello");
  assert.equal(result.metadata.exitCode, 0);

  assert.equal(adapter.callRecord.length, 1);
  assert.equal(adapter.callRecord[0].phase, "executor");
  assert.equal(adapter.callRecord[0].attempt, 0);
  assert.equal(adapter.callRecord[0].consumed, true);
  assert.equal(adapter.remaining, 0);
});

test("error result propagates status and error message", async () => {
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 0 },
      result: { status: "error", stdout: "", stderr: "boom", signal: null, error: "boom", metadata: {} },
    },
  ]);
  const result = await adapter.runAdapter(baseRequest());
  assert.equal(result.status, "error");
  assert.equal(result.error, "boom");
});

test("timed_out result propagates", async () => {
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 0 },
      result: { status: "timed_out", stdout: "", stderr: "", signal: null, error: null, metadata: {} },
    },
  ]);
  const result = await adapter.runAdapter(baseRequest());
  assert.equal(result.status, "timed_out");
});

test("an already-aborted signal short-circuits without consuming the scripted step", async () => {
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 0 },
      result: { status: "completed", stdout: "should not be reached", stderr: "", signal: null, error: null, metadata: {} },
    },
  ]);
  const controller = new AbortController();
  controller.abort();

  const result = await adapter.runAdapter(baseRequest({ abortSignal: controller.signal }));
  assert.equal(result.status, "aborted");
  assert.equal(adapter.remaining, 1, "scripted step must not be consumed on upfront abort");
  assert.equal(adapter.callRecord[0].consumed, false);
});

test("phase mismatch fails closed with ScriptedAdapterSequenceError", async () => {
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "reviewer", attempt: 0 },
      result: { status: "completed", stdout: "", stderr: "", signal: null, error: null, metadata: {} },
    },
  ]);
  await assert.rejects(
    () => adapter.runAdapter(baseRequest({ phase: "executor" })),
    ScriptedAdapterSequenceError,
  );
});

test("attempt mismatch fails closed with ScriptedAdapterSequenceError", async () => {
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 1 },
      result: { status: "completed", stdout: "", stderr: "", signal: null, error: null, metadata: {} },
    },
  ]);
  await assert.rejects(
    () => adapter.runAdapter(baseRequest({ phase: "executor", attempt: 0 })),
    ScriptedAdapterSequenceError,
  );
});

test("exhausted script fails closed with ScriptedAdapterSequenceError", async () => {
  const adapter = createScriptedAdapter([]);
  await assert.rejects(() => adapter.runAdapter(baseRequest()), ScriptedAdapterSequenceError);
});

test("malformed scripted result rejects via adapter contract validation", async () => {
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 0 },
      // "completed" status must not carry a signal per the contract.
      result: { status: "completed", stdout: "", stderr: "", signal: "SIGKILL", error: null, metadata: {} },
    },
  ]);
  await assert.rejects(() => adapter.runAdapter(baseRequest()), AdapterContractError);
});

test("malformed request rejects via adapter contract validation before touching the script", async () => {
  const adapter = createScriptedAdapter([
    {
      expect: { phase: "executor", attempt: 0 },
      result: { status: "completed", stdout: "", stderr: "", signal: null, error: null, metadata: {} },
    },
  ]);
  await assert.rejects(
    () => adapter.runAdapter(baseRequest({ attempt: -1 })),
    AdapterContractError,
  );
  assert.equal(adapter.remaining, 1, "invalid request must not consume the script");
});
