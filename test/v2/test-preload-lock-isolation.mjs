// The E1/E2/E3 isolation preload must give every test process a PRIVATE Colima
// profile lock root. The lock is machine-wide and deliberately not shimmed, so
// without this the parallel soak suites contend for the lock in the operator's
// real home and one of them fails with HOLD / COLIMA_PROFILE_BUSY.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const PRELOAD = new URL("./helpers/e1-runtime-isolation-preload.mjs", import.meta.url).pathname;
const PRINT = "console.log(JSON.stringify({ root: process.env.AEGISFLOW_COLIMA_PROFILE_LOCK_ROOT ?? '', tmp: require('node:os').tmpdir() }))";

function lockRootSeenBy(env) {
  const r = spawnSync(process.execPath, ["--import", PRELOAD, "-e", PRINT], {
    env: { PATH: process.env.PATH, ...env }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}

test("each process gets its own lock root under the OS temp, never the operator's home", () => {
  const a = lockRootSeenBy({});
  const b = lockRootSeenBy({});
  assert.ok(a.root.length > 0 && b.root.length > 0);
  assert.ok(a.root.startsWith(a.tmp), `not under the process's temp dir: ${a.root}`);
  assert.ok(!a.root.startsWith(homedir()), "must not point into the operator's home");
  assert.notEqual(a.root, b.root, "two processes must not share a lock root");
});

test("an operator-configured lock root is respected", () => {
  assert.equal(lockRootSeenBy({ AEGISFLOW_COLIMA_PROFILE_LOCK_ROOT: "/explicit/root" }).root, "/explicit/root");
  assert.equal(lockRootSeenBy({ AUTOLOOP_COLIMA_PROFILE_LOCK_ROOT: "/legacy/root" }).root, "", "legacy name counts as configured, so nothing is overridden");
});
