// test/v2/test-process-group-termination.mjs
//
// TASK-TERMINATION LIFECYCLE REPAIR — task-scoped process-group teardown.
//
// Proves the two repaired seams terminate every descendant they own, and that
// the harness verification command settles in bounded time even when a
// descendant keeps the stdio pipes open.
//
// Before the repair:
//   - runVerificationCommand killed only the leader, so a `sleep` grandchild
//     survived with PPID 1 and held the stdout/stderr pipes open, hanging the
//     caller for 60s against a 2s timeout.
//   - spawnSuccessorSession used child.kill("SIGKILL") on a detached child and
//     did not terminate at all on the timeout path.
//
// Offline only: no provider, no credentials, no container.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runVerificationCommand } from "../../src/v2/harness-evidence.mjs";
import { spawnSuccessorSession } from "../../src/adapter/pi-spawn-adapter.mjs";
import { spawnTaskScoped, terminateProcessGroup, signalProcessGroup } from "../../src/shared/process-group.mjs";

/** True while `pid` is still addressable (EPERM counts as alive). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function readPids(dir) {
  const out = [];
  for (const name of ["child", "grandchild", "child2"]) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    const pid = Number(readFileSync(p, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) out.push(pid);
  }
  return out;
}

/** Bounded wait for recorded pids to disappear; returns the survivors. */
async function survivorsAfter(dir, ms = 1500) {
  const pids = readPids(dir);
  const deadline = Date.now() + ms;
  let live = pids.filter(alive);
  while (live.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    live = pids.filter(alive);
  }
  return live;
}

/** A verification command that builds a leader -> child -> grandchild tree. */
function writeTreeScript(dir) {
  const script = join(dir, "tree.sh");
  writeFileSync(script, [
    "#!/bin/bash",
    '( sleep 30 & echo $! > "$1/grandchild"; wait ) &',
    'echo $! > "$1/child"',
    'sleep 30 & echo $! > "$1/child2"',
    "wait",
    "",
  ].join("\n"));
  chmodSync(script, 0o755);
  return script;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── CASE 1: timeout terminates the whole task-scoped group ───────────────

test("verification timeout terminates leader, child and grandchild", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-case1-"));
  try {
    const script = writeTreeScript(dir);
    const r = await runVerificationCommand({ command: [script, dir], cwd: dir, timeoutMs: 600 });

    assert.equal(r.ok, false);
    assert.equal(r.code, "HARNESS_TEST_RUN_UNAVAILABLE");
    assert.equal(r.reason, "verification command timed out");
    assert.deepEqual(await survivorsAfter(dir), [], "no descendant may survive the timeout");
  } finally {
    for (const pid of readPids(dir)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    cleanup(dir);
  }
});

// ── CASE 3: descendant holding the stdout pipe cannot block the caller ───

test("timeout settles in bounded time while a descendant holds the stdout pipe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-case3-"));
  try {
    // The grandchild inherits stdout and keeps it open past the leader's death.
    const script = join(dir, "pipe.sh");
    writeFileSync(script, [
      "#!/bin/bash",
      'sleep 30 & echo $! > "$1/grandchild"',
      "sleep 30",
      "",
    ].join("\n"));
    chmodSync(script, 0o755);

    const started = Date.now();
    const r = await runVerificationCommand({ command: [script, dir], cwd: dir, timeoutMs: 600 });
    const elapsed = Date.now() - started;

    assert.equal(r.ok, false);
    assert.equal(r.reason, "verification command timed out");
    // timeout + grace + escalation + reap slack, with generous scheduling slack.
    assert.ok(elapsed < 4000, `caller must settle in bounded time, took ${elapsed}ms`);
    assert.deepEqual(await survivorsAfter(dir), [], "pipe-holding descendant must be gone");
  } finally {
    for (const pid of readPids(dir)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    cleanup(dir);
  }
});

// ── CASE 3b: a shell that waits on a background child must not leak it ───

test("timeout reaps a background child the shell was waiting on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-case3b-"));
  try {
    const script = join(dir, "wait.sh");
    writeFileSync(script, [
      "#!/bin/bash",
      'sleep 30 & echo $! > "$1/grandchild"',
      "wait",
      "",
    ].join("\n"));
    chmodSync(script, 0o755);

    const r = await runVerificationCommand({ command: [script, dir], cwd: dir, timeoutMs: 600 });
    assert.equal(r.reason, "verification command timed out");
    assert.deepEqual(await survivorsAfter(dir), [], "shell's background child must not survive");
  } finally {
    for (const pid of readPids(dir)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    cleanup(dir);
  }
});

// ── CASE 4: a command that finishes on its own is never spuriously killed ─

test("normal completion preserves exit code, stdout and stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-case4-"));
  try {
    const r = await runVerificationCommand({
      command: ["/bin/bash", "-c", "echo OUT_LINE; echo ERR_LINE >&2; exit 7"],
      cwd: dir,
      timeoutMs: 10_000,
    });
    assert.equal(r.ok, true);
    assert.equal(r.exit_code, 7);
    assert.equal(r.stdout, "OUT_LINE\n");
    assert.equal(r.stderr, "ERR_LINE\n");
    assert.equal(r.stdout_truncated, false);
  } finally {
    cleanup(dir);
  }
});

test("normal completion does not truncate output that arrives just before exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-case4b-"));
  try {
    // ~200KB written immediately before exit: the pipes must not be destroyed
    // out from under the buffered output.
    const r = await runVerificationCommand({
      command: ["/bin/bash", "-c", "node -e 'process.stdout.write(\"x\".repeat(200000))'"],
      cwd: dir,
      timeoutMs: 30_000,
      limits: { maxStdoutBytes: 256 * 1024 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.exit_code, 0);
    assert.equal(r.stdout.length, 200_000);
    assert.equal(r.stdout_truncated, false);
  } finally {
    cleanup(dir);
  }
});

// ── CASE 5: cleanup is idempotent when the group is already gone ─────────

test("termination is idempotent for an already-exited child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-case5-"));
  try {
    const child = spawnTaskScoped("/bin/bash", ["-c", "exit 0"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve) => child.once("exit", resolve));
    child.stdout.destroy();
    child.stderr.destroy();

    // A reaped leader must not produce a false failure, and must not throw.
    const first = await terminateProcessGroup(child);
    const second = await terminateProcessGroup(child);
    assert.equal(typeof first.processTreeKilled, "boolean");
    assert.equal(second.reason, "leader_already_exited");
    // The group was already signalled and is empty, so nothing is delivered
    // and no error surfaces — this is the idempotency contract.
    assert.deepEqual(signalProcessGroup(child, "SIGKILL"), { group: false, delivered: false });
    assert.deepEqual(signalProcessGroup(child, "SIGTERM"), { group: false, delivered: false });
  } finally {
    cleanup(dir);
  }
});

// ── CASE 2: pi successor spawn terminates its group on settle and timeout ─

function writeFakePi(dir, { settle }) {
  const fake = join(dir, "pi");
  // The adapter forwards a restricted environment, so the fake pi writes its
  // descendant pid to a path baked into the script rather than reading $ENV.
  writeFileSync(fake, [
    "#!/bin/bash",
    `sleep 30 & echo $! > ${join(dir, "grandchild")}`,
    ...(settle ? ['echo \'{"type":"agent_settled"}\''] : []),
    "sleep 30",
    "",
  ].join("\n"));
  chmodSync(fake, 0o755);
  return fake;
}

test("pi successor spawn terminates its process group after settle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-case2a-"));
  const prevExe = process.env.PI_EXECUTABLE;
  const prevTimeout = process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS;
  try {
    const fake = writeFakePi(dir, { settle: true });
    process.env.PI_EXECUTABLE = fake;
    process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS = "8000";

    const r = await spawnSuccessorSession({
      adapterKind: "pi-builtin",
      providerKind: "merge-gateway",
      modelId: "zai/glm-5.3-flash",
      requiredEnvKeys: [],
      rolloverId: "rollover-test",
      expectedTargetGeneration: 1,
      checkpointDigest: "digest-test",
      taskIdentity: "task-test",
      runIdentity: "run-test",
      checkpointLocator: { root: join(dir, "root"), executionId: "exec-test" },
    });

    // The fake creates no real provider session file, so identity is
    // unavailable — but the settle was observed, which is what drives teardown.
    assert.equal(r.status, "error");
    assert.match(r.error, /no_real_provider_session_file_created/);
    assert.deepEqual(await survivorsAfter(dir), [], "settled session descendants must not survive");
  } finally {
    if (prevExe === undefined) delete process.env.PI_EXECUTABLE; else process.env.PI_EXECUTABLE = prevExe;
    if (prevTimeout === undefined) delete process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS; else process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS = prevTimeout;
    for (const pid of readPids(dir)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    cleanup(dir);
  }
});

test("pi successor spawn terminates its process group on timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-case2b-"));
  const prevExe = process.env.PI_EXECUTABLE;
  const prevTimeout = process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS;
  try {
    const fake = writeFakePi(dir, { settle: false });
    process.env.PI_EXECUTABLE = fake;
    process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS = "800";

    const r = await spawnSuccessorSession({
      adapterKind: "pi-builtin",
      providerKind: "merge-gateway",
      modelId: "zai/glm-5.3-flash",
      requiredEnvKeys: [],
      rolloverId: "rollover-test",
      expectedTargetGeneration: 1,
      checkpointDigest: "digest-test",
      taskIdentity: "task-test",
      runIdentity: "run-test",
      checkpointLocator: { root: join(dir, "root"), executionId: "exec-test" },
    });

    assert.equal(r.status, "timed_out");
    assert.deepEqual(await survivorsAfter(dir), [], "timed-out session descendants must not survive");
  } finally {
    if (prevExe === undefined) delete process.env.PI_EXECUTABLE; else process.env.PI_EXECUTABLE = prevExe;
    if (prevTimeout === undefined) delete process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS; else process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS = prevTimeout;
    for (const pid of readPids(dir)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    cleanup(dir);
  }
});

// ── ACTIVE-TASK CANCELLATION (CANCEL-CONTRACT-REPAIR-1) ──────────────────
//
// The cancellation counterpart of the timeout cases above: a user/controller
// AbortSignal must reach the verification process and the successor spawn,
// with the same group-scoped teardown and a bounded settle.

test("verification abort before start never spawns the process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-abor0-"));
  try {
    const script = writeTreeScript(dir);
    const ac = new AbortController();
    ac.abort();
    const r = await runVerificationCommand({ command: [script, dir], cwd: dir, timeoutMs: 5000, abortSignal: ac.signal });
    assert.equal(r.ok, false);
    assert.equal(r.code, "HARNESS_TEST_RUN_ABORTED");
    // The decisive assertion: no process was started at all.
    assert.deepEqual(readPids(dir), [], "an aborted signal must not spawn the verification command");
  } finally {
    cleanup(dir);
  }
});

test("verification mid-flight abort terminates leader, child and grandchild", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-abor1-"));
  try {
    const script = writeTreeScript(dir);
    const ac = new AbortController();
    const started = Date.now();
    // timeoutMs is far above the abort, so only the abort can settle this.
    const p = runVerificationCommand({ command: [script, dir], cwd: dir, timeoutMs: 60000, abortSignal: ac.signal });
    // Wait until the whole tree is up, then cancel like a user STOP.
    const deadline = Date.now() + 3000;
    while (readPids(dir).length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.equal(readPids(dir).length >= 2, true, "tree must be running before the abort");
    ac.abort();
    const r = await p;
    const elapsed = Date.now() - started;

    assert.equal(r.ok, false);
    assert.equal(r.code, "HARNESS_TEST_RUN_ABORTED");
    // Bounded settle: nowhere near the 60s timeout the command would otherwise
    // have consumed.
    assert.ok(elapsed < 5000, `abort must settle in bounded time (took ${elapsed}ms)`);
    assert.deepEqual(await survivorsAfter(dir), [], "no descendant may survive a cancellation");
  } finally {
    for (const pid of readPids(dir)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    cleanup(dir);
  }
});

test("verification abort settles in bounded time while a descendant holds the stdout pipe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-abor2-"));
  try {
    // Same pipe-holding shape as the timeout case: a backgrounded descendant
    // inherits stdout and outlives its leader.
    const script = join(dir, "hold.sh");
    writeFileSync(script, [
      "#!/bin/bash",
      'sh -c "exec 1>&1; sleep 30" &',
      'echo $! > "$1/grandchild"',
      "sleep 30",
      "",
    ].join("\n"));
    chmodSync(script, 0o755);

    const ac = new AbortController();
    const started = Date.now();
    const p = runVerificationCommand({ command: [script, dir], cwd: dir, timeoutMs: 60000, abortSignal: ac.signal });
    const deadline = Date.now() + 3000;
    while (readPids(dir).length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    ac.abort();
    const r = await p;

    assert.equal(r.code, "HARNESS_TEST_RUN_ABORTED");
    assert.ok(Date.now() - started < 5000, "pipe-holding descendant must not block the abort settle");
    assert.deepEqual(await survivorsAfter(dir), []);
  } finally {
    for (const pid of readPids(dir)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    cleanup(dir);
  }
});

test("successor spawn aborts mid-flight and reaps its process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-abor3-"));
  const prevExe = process.env.PI_EXECUTABLE;
  const prevTimeout = process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS;
  try {
    const fake = writeFakePi(dir, { settle: false });
    process.env.PI_EXECUTABLE = fake;
    process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS = "30000"; // only the abort can end it
    const ac = new AbortController();
    const started = Date.now();
    const p = spawnSuccessorSession({
      adapterKind: "pi-builtin", providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash",
      requiredEnvKeys: [], rolloverId: "rollover-test", expectedTargetGeneration: 1,
      checkpointDigest: "digest-test", taskIdentity: "task-test", runIdentity: "run-test",
      checkpointLocator: { root: join(dir, "root"), executionId: "exec-test" },
      abortSignal: ac.signal,
    });
    const deadline = Date.now() + 3000;
    while (readPids(dir).length < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    ac.abort();
    const r = await p;
    assert.equal(r.status, "aborted");
    assert.ok(Date.now() - started < 5000, "abort must not wait for the 30s spawn timeout");
    assert.deepEqual(await survivorsAfter(dir), [], "aborted session descendants must not survive");
  } finally {
    if (prevExe === undefined) delete process.env.PI_EXECUTABLE; else process.env.PI_EXECUTABLE = prevExe;
    if (prevTimeout === undefined) delete process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS; else process.env.AEGISFLOW_ROLLOVER_SPAWN_TIMEOUT_MS = prevTimeout;
    for (const pid of readPids(dir)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    cleanup(dir);
  }
});

test("successor spawn with an already-aborted signal never spawns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pgr-abor4-"));
  const prevExe = process.env.PI_EXECUTABLE;
  try {
    const fake = writeFakePi(dir, { settle: false });
    process.env.PI_EXECUTABLE = fake;
    const ac = new AbortController();
    ac.abort();
    const r = await spawnSuccessorSession({
      adapterKind: "pi-builtin", providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash",
      requiredEnvKeys: [], rolloverId: "rollover-test", expectedTargetGeneration: 1,
      checkpointDigest: "digest-test", taskIdentity: "task-test", runIdentity: "run-test",
      checkpointLocator: { root: join(dir, "root"), executionId: "exec-test" },
      abortSignal: ac.signal,
    });
    assert.equal(r.status, "aborted");
    assert.deepEqual(readPids(dir), [], "an aborted signal must not spawn a provider session");
  } finally {
    if (prevExe === undefined) delete process.env.PI_EXECUTABLE; else process.env.PI_EXECUTABLE = prevExe;
    cleanup(dir);
  }
});