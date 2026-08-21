// test/test-colima-runtime.mjs
//
// Unit tests for the Colima runtime adapter that do NOT require a running
// instance (pure functions + contract shape). The real integration is
// exercised by scripts/colima-runtime-integration.mjs.
//
// Run: node --test test/test-colima-runtime.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import {
  instanceSocket,
  assertMountAllowlist,
  ColimaRuntimeError,
  TEST_IMAGE,
  CARD_LABEL,
} from "../src/runtime/colima-runtime.mjs";
import { validateAdapterResult, validateAdapterRequest } from "../src/adapter/contract.mjs";

test("instanceSocket is pinned to the profile under ~/.colima", () => {
  assert.equal(instanceSocket("autoloop-w1"), `unix://${homedir()}/.colima/autoloop-w1/docker.sock`);
  assert.notEqual(instanceSocket("autoloop-w1"), instanceSocket("autoloop-w2"));
});

test("test image is the frozen immutable alpine digest", () => {
  assert.equal(TEST_IMAGE, "docker.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce");
});

test("card label is stable for stale cleanup scoping", () => {
  assert.equal(CARD_LABEL, "autoloop.card=colima-autoloop-real-integration");
});

test("assertMountAllowlist accepts only repo ro + scratch rw", () => {
  const repo = "/Volumes/NVM2T/Development/repos/autoloop";
  const scratch = `${homedir()}/autoloop-runtime`;
  // allowed
  assert.doesNotThrow(() =>
    assertMountAllowlist({
      roMounts: [{ source: repo, target: "/src" }],
      rwMounts: [{ source: `${scratch}/w1`, target: "/work" }, { source: scratch, target: "/scratch" }],
      repoPaths: [repo],
      scratchRoot: scratch,
    }),
  );
  // ro mount outside repo allowlist -> fail closed
  assert.throws(
    () =>
      assertMountAllowlist({
        roMounts: [{ source: "/etc/hosts", target: "/x" }],
        rwMounts: [],
        repoPaths: [repo],
        scratchRoot: scratch,
      }),
    ColimaRuntimeError,
  );
  // rw mount outside scratchRoot -> fail closed
  assert.throws(
    () =>
      assertMountAllowlist({
        roMounts: [],
        rwMounts: [{ source: "/tmp/elsewhere", target: "/x" }],
        repoPaths: [repo],
        scratchRoot: scratch,
      }),
    ColimaRuntimeError,
  );
  // whole-$HOME is NOT auto-allowed as rw
  assert.throws(
    () =>
      assertMountAllowlist({
        roMounts: [],
        rwMounts: [{ source: homedir(), target: "/home" }],
        repoPaths: [repo],
        scratchRoot: scratch,
      }),
    ColimaRuntimeError,
  );
});

test("adapter result shape satisfies the executor contract", () => {
  // runTask result shape (status + executionId required by contract)
  const completed = {
    status: "completed",
    executionId: "ro-1",
    exitCode: 0,
    stdout: "x",
    stderr: "",
    containerName: "autoloop-ro-1",
    latencyMs: 123,
  };
  assert.equal(validateAdapterResult(completed).valid, true);
  for (const status of ["timed_out", "aborted"]) {
    assert.equal(validateAdapterResult({ status, executionId: "t-1" }).valid, true);
  }
  assert.equal(validateAdapterResult({ status: "error", executionId: "e-1", error: "boom" }).valid, true);
  // invalid ones
  assert.equal(validateAdapterResult({ status: "completed" }).valid, false); // missing executionId
  assert.equal(validateAdapterResult({ status: "bogus", executionId: "x" }).valid, false);
  assert.equal(validateAdapterResult({ status: "error", executionId: "x" }).valid, false); // error needs message
  // request side: task-level fields the adapter consumes
  const req = { executionId: "e", cwd: "/tmp", taskCard: "{}", phase: "executor", attempt: 0, timeoutMs: 5000 };
  assert.equal(validateAdapterRequest(req).valid, true);
});
