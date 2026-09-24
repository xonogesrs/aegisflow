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
  assertSingleWritableMount,
  roundTripProbe,
  assertColimaHome,
  ensureInstance,
} from "../src/runtime/colima-runtime.mjs";
import { validateAdapterResult, validateAdapterRequest } from "../src/adapter/contract.mjs";

// An arbitrary absolute, non-$HOME runtime home: the gate is configuration-
// driven, so the test needs a PATH, not one machine's volume.
const CANON = "/srv/autoloop/runtime/colima";
/**
 * A runtime home that actually exists on disk.
 *
 * The gate requires the directory to exist and be writable, so a purely
 * synthetic path cannot be used to exercise the helpers that read
 * `process.env.COLIMA_HOME` at call time. The tests that need that create one
 * here and clean it up.
 */
function withRealColimaHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-colima-home-"));
  const prev = process.env.COLIMA_HOME;
  process.env.COLIMA_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.COLIMA_HOME; else process.env.COLIMA_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}
// The gate these tests configure: the mount that CONTAINS CANON, so the
// containment check is exercised with a coherent pair.
const GATE = Object.freeze({ AUTOLOOP_COLIMA_MOUNT: "/srv/autoloop", AUTOLOOP_COLIMA_MOUNT_UUID: "UUID-1" });
/** Injected filesystem/id observations so no real volume is required. */
const okFacts = Object.freeze({
  statOf: () => ({ isDirectory: () => true }),
  accessOf: () => {},
});

test("instanceSocket is pinned to the profile under the configured COLIMA_HOME", () => {
  // These helpers read process.env at call time, so the test sets it rather
  // than depending on the ambient shell being configured.
  withRealColimaHome((home) => {
    assert.equal(instanceSocket("autoloop-w1"), `unix://${home}/autoloop-w1/docker.sock`);
    assert.notEqual(instanceSocket("autoloop-w1"), instanceSocket("autoloop-w2"));
  });
});

// ── COLIMA storage gate: rejects every fallback / drift shape ──────────

const uuidOk = () => "971A7EA8-5108-4B8E-B9A8-5141F0C04A8A";
const uuidNone = () => null;

test("N1: a gated mount with no volume UUID fails closed", () => {
  assert.throws(
    () =>
      assertColimaHome({ env: { COLIMA_HOME: CANON, ...GATE }, uuidOf: uuidNone, volumesOf: () => ["autoloop"], ...okFacts }),
    (e) => e instanceof ColimaRuntimeError && e.message.includes("COLIMA_MOUNT_IDENTITY_FAILED"),
  );
});

test("N2: COLIMA_HOME unset fails closed and states no fallback", () => {
  assert.throws(
    () => assertColimaHome({ env: {}, ...okFacts }),
    (e) =>
      e instanceof ColimaRuntimeError &&
      e.message.includes("COLIMA_HOME_NOT_CANONICAL") &&
      /refusing to fall back/.test(e.message),
  );
});

test("N3: COLIMA_HOME pointing at ~/.colima fails closed and names no fallback", () => {
  assert.throws(
    () => assertColimaHome({ env: { COLIMA_HOME: `${homedir()}/.colima` }, ...okFacts }),
    (e) => e instanceof ColimaRuntimeError && e.message.includes("COLIMA_HOME_NOT_CANONICAL"),
  );
});

test("N4: COLIMA_HOME on another system-disk path fails closed", () => {
  assert.throws(
    () => assertColimaHome({ env: { COLIMA_HOME: join(homedir(), "colima-elsewhere") }, ...okFacts }),
    (e) => e instanceof ColimaRuntimeError && e.message.includes("COLIMA_HOME_NOT_CANONICAL"),
  );
});

test("N5: runtime directory unavailable fails closed", () => {
  assert.throws(
    () =>
      assertColimaHome({
        env: { COLIMA_HOME: CANON },
        statOf: () => {
          throw new Error("ENOENT");
        },
        accessOf: () => {},
      }),
    (e) => e instanceof ColimaRuntimeError && e.message.includes("COLIMA_RUNTIME_HOME_UNAVAILABLE"),
  );
});

test("N6: a shadow mount of the gated volume fails closed — no guessing", () => {
  // The gate is configuration-driven, so the mount name is derived from the
  // configured gate rather than being one machine's volume name.
  assert.throws(
    () =>
      assertColimaHome({
        env: { COLIMA_HOME: CANON, ...GATE },
        uuidOf: () => GATE.AUTOLOOP_COLIMA_MOUNT_UUID,
        volumesOf: () => ["autoloop", "autoloop 1"],
        ...okFacts,
      }),
    (e) => e instanceof ColimaRuntimeError && e.message.includes("COLIMA_SHADOW_MOUNT"),
  );
});

test("N7: with no mount gate configured, a valid COLIMA_HOME is admitted", () => {
  assert.equal(assertColimaHome({ env: { COLIMA_HOME: CANON }, ...okFacts }), CANON);
});

test("N8: a COLIMA_HOME outside the configured mount fails closed", () => {
  assert.throws(
    () => assertColimaHome({ env: { COLIMA_HOME: "/other/colima", ...GATE }, ...okFacts }),
    (e) => e instanceof ColimaRuntimeError && e.message.includes("COLIMA_HOME_NOT_CANONICAL"),
  );
});

test("gate passes with a configured mount and matching volume identity", () => {
  assert.equal(
    assertColimaHome({
      env: { COLIMA_HOME: CANON, ...GATE },
      uuidOf: () => GATE.AUTOLOOP_COLIMA_MOUNT_UUID,
      volumesOf: () => ["autoloop"],
      ...okFacts,
    }),
    CANON,
  );
});

test("instanceSocket requires the runtime home to be configured", () => {
  // Without COLIMA_HOME the socket cannot be resolved — fail closed, never a
  // fallback to ~/.colima.
  assert.throws(() => instanceSocket("autoloop-w1"), (e) => e instanceof ColimaRuntimeError && e.message.includes("COLIMA_HOME_NOT_CANONICAL"));
});

test("ensureInstance runs the storage gate before any machine action", () => {
  assert.throws(
    () => ensureInstance({ profile: "autoloop-graph", roMounts: [], rwMounts: ["/tmp/x"], env: { COLIMA_HOME: join(homedir(), ".colima") } }),
    (e) => e instanceof ColimaRuntimeError && e.message.includes("COLIMA_HOME_NOT_CANONICAL"),
  );
});

test("test image is the frozen immutable alpine digest", () => {
  assert.equal(TEST_IMAGE, "docker.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce");
});

test("card label is stable for stale cleanup scoping", () => {
  assert.equal(CARD_LABEL, "autoloop.card=colima-autoloop-real-integration");
});

test("assertMountAllowlist accepts only repo ro + scratch rw", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
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

// ── Mount lifecycle authority（R2: desired==runtime or fail closed）───────

import {
  AUTOLOOP_TEST_PROFILES,
  INSTANCE_ACTION,
  limaRuntimeYamlPath,
  normalizeMountPath,
  parseLimaMounts,
  mountFingerprint,
  runtimeMountFingerprint,
  listInstances,
  planInstanceAction,
} from "../src/runtime/colima-runtime.mjs";
import { mkdtempSync, symlinkSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { C2dHoldError } from "../src/c2d/fs-atomic.mjs";

const FP_A = { location: "/tmp/suite-a", writable: true };
const FP_B = { location: "/tmp/suite-b", writable: true };
const REPO_RO = { location: fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, ""), writable: false };

test("mountFingerprint: stable ordering, mode-sensitive, alias-normalized", () => {
  const base = [REPO_RO, FP_A];
  const reordered = [FP_A, REPO_RO];
  assert.equal(mountFingerprint(base), mountFingerprint(reordered));
  // mode mismatch must change the fingerprint
  assert.notEqual(
    mountFingerprint([{ location: "/x", writable: false }]),
    mountFingerprint([{ location: "/x", writable: true }]),
  );
  // trailing-slash + symlink alias normalize to the same entry
  const dir = mkdtempSync(join(tmpdir(), "autoloop-fp-"));
  const link = join(dir, "alias");
  try { symlinkSync(dir, link); } catch { /* best effort */ }
  assert.equal(
    mountFingerprint([{ location: `${dir}/`, writable: true }]),
    mountFingerprint([{ location: dir, writable: true }]),
  );
});

test("parseLimaMounts parses the runtime generation incl. trailing slashes", () => {
  const yaml = [
    "disk: 20GiB",
    "mounts:",
    "    - location: /Users/x/repo/",
    "      writable: false",
    "    - location: /Users/x/scratch/.autoloop-owned/abc/",
    "      writable: true",
    "mountType: virtiofs",
    "",
  ].join("\n");
  assert.deepEqual(parseLimaMounts(yaml), [
    { location: "/Users/x/repo/", writable: false },
    { location: "/Users/x/scratch/.autoloop-owned/abc/", writable: true },
  ]);
  assert.equal(
    mountFingerprint(parseLimaMounts(yaml)),
    mountFingerprint([{ location: "/Users/x/repo", writable: false }, { location: "/Users/x/scratch/.autoloop-owned/abc", writable: true }]),
  );
});

test("planInstanceAction: matching runtime reuses a running instance (T3), never restarts", () => {
  const fp = mountFingerprint([REPO_RO, FP_A]);
  assert.equal(planInstanceAction({ profile: "autoloop-graph", desiredFingerprint: fp, runtimeFingerprint: fp, running: true }).action, INSTANCE_ACTION.REUSE);
});

test("planInstanceAction: stale runtime on test-owned profile reconciles (T4); unowned/default/look-alike HOLD fail closed (T5/T13)", () => {
  const desired = mountFingerprint([REPO_RO, FP_B]);
  const stale = mountFingerprint([REPO_RO, FP_A]);
  for (const profile of AUTOLOOP_TEST_PROFILES) {
    assert.equal(planInstanceAction({ profile, desiredFingerprint: desired, runtimeFingerprint: stale, running: true }).action, INSTANCE_ACTION.RECONCILE);
  }
  for (const profile of ["default", "autoloop-graph2", "autoloop-grap", "Autoloop-Graph", "some-user-profile"]) {
    const plan = planInstanceAction({ profile, desiredFingerprint: desired, runtimeFingerprint: stale, running: true });
    assert.equal(plan.action, INSTANCE_ACTION.HOLD);
    assert.equal(plan.holdCode, "COLIMA_PROFILE_NOT_TEST_OWNED");
  }
});

test("planInstanceAction: never-created profile starts through the seam; unowned never mutates even then (T5)", () => {
  const desired = mountFingerprint([REPO_RO, FP_B]);
  assert.equal(planInstanceAction({ profile: "autoloop-graph", desiredFingerprint: desired, runtimeFingerprint: null, running: false }).action, INSTANCE_ACTION.START);
  assert.equal(planInstanceAction({ profile: "default", desiredFingerprint: desired, runtimeFingerprint: null, running: false }).action, INSTANCE_ACTION.HOLD);
});

/** Gate facts every injected dep set carries, so a configured COLIMA_HOME suffices. */
const GATE_FACTS = Object.freeze({
  uuidOf: () => null,
  volumesOf: () => [],
  statOf: () => ({ isDirectory: () => true }),
  accessOf: () => {},
});

function fakeDeps({ runtimeNow, runtimeAfter, probeOk = true, listRows }) {
  const calls = { stop: 0, start: [] };
  const run = (bin, args) => {
    if (args[0] === "list") {
      return { status: 0, stdout: ["PROFILE STATUS ARCH CPUS MEMORY DISK RUNTIME ADDRESS", ...listRows].join("\n") };
    }
    if (args[0] === "stop") calls.stop += 1;
    if (args[0] === "start") calls.start.push(args);
    return { status: 0, stdout: "", stderr: "" }; // colima "already running" would also be status 0
  };
  let fpReads = 0;
  const runtimeFingerprint = () => (fpReads++ === 0 ? runtimeNow : runtimeAfter);
  const resolve = () => ({ socket: "unix:///tmp/x.sock", ok: true, serverVersion: "27", error: null });
  const probeCalls = [];
  const probe = (arg) => { probeCalls.push(arg); return { ok: probeOk, direction: probeOk ? "ROUND_TRIP" : "HOST_TO_GUEST", reason: probeOk ? "" : "nonce mismatch" }; };
  return { deps: { run, resolve, probe, runtimeFingerprint, ...GATE_FACTS }, calls, probeCalls };
}

test("ensureInstance T1/T2/T8: 'already running' with stale mounts is NOT ready -> bounded reconcile; still-stale after start -> HOLD", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
  const desiredB = mountFingerprint([{ location: repo, writable: false }, FP_B]);
  const staleA = mountFingerprint([{ location: repo, writable: false }, FP_A]);
  // Reconcile path runs and the VM now carries the desired generation.
  {
    const { deps, calls } = fakeDeps({ runtimeNow: staleA, runtimeAfter: desiredB, listRows: ["autoloop-graph Running aarch64 2 2GiB 20GiB docker"] });
    const r = ensureInstance({ profile: "autoloop-graph", roMounts: [repo], rwMounts: ["/tmp/suite-b"], deps , env: COLIMA_ENV});
    assert.equal(calls.stop, 1, "stale running profile must be stopped before start");
    assert.equal(calls.start.length, 1);
    assert.ok(calls.start[0].includes("--mount"));
    assert.equal(r.reused, false);
    assert.equal(r.reconciled, true);
  }
  // Fake success simulation: start is a no-op ("already running"), VM stays on stale A -> HOLD, no ready.
  {
    const { deps, probeCalls } = fakeDeps({ runtimeNow: staleA, runtimeAfter: staleA, listRows: ["autoloop-graph Running aarch64 2 2GiB 20GiB docker"] });
    assert.throws(
      () => ensureInstance({ profile: "autoloop-graph", roMounts: [repo], rwMounts: ["/tmp/suite-b"], deps , env: COLIMA_ENV}),
      (e) => e instanceof ColimaRuntimeError && e.message.includes("COLIMA_RUNTIME_MOUNT_RECONCILE_INCOMPLETE"),
    );
    assert.equal(probeCalls.length, 0, "no readiness published when runtime generation still stale");
  }
});

test("ensureInstance T3/T14: matching running instance reuses without restart; disk policy untouched", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
  const fp = mountFingerprint([{ location: repo, writable: false }, FP_A]);
  const { deps, calls, probeCalls } = fakeDeps({ runtimeNow: fp, runtimeAfter: fp, listRows: ["autoloop-graph Running aarch64 2 2GiB 20GiB docker"] });
  const r = ensureInstance({ profile: "autoloop-graph", roMounts: [repo], rwMounts: ["/tmp/suite-a"], deps , env: COLIMA_ENV});
  assert.equal(calls.start.length, 0, "matching runtime must not restart");
  assert.equal(calls.stop, 0);
  assert.equal(r.reused, true);
  assert.equal(probeCalls.length, 1, "round-trip probe still required for readiness");
  assert.equal(r.diskBefore, "20GiB");
  assert.equal(r.diskAfter, "20GiB");
});

test("ensureInstance T16: crash during reconcile propagates and never publishes readiness", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
  const desiredB = mountFingerprint([{ location: repo, writable: false }, FP_B]);
  const staleA = mountFingerprint([{ location: repo, writable: false }, FP_A]);
  const base = fakeDeps({ runtimeNow: staleA, runtimeAfter: desiredB, listRows: ["autoloop-graph Running aarch64 2 2GiB 20GiB docker"] });
  const run = (bin, args) => {
    if (args[0] === "start") throw new Error("SIGKILL mid-reconcile");
    if (args[0] === "list") return { status: 0, stdout: "PROFILE STATUS ARCH CPUS MEMORY DISK RUNTIME ADDRESS\nautoloop-graph Running aarch64 2 2GiB 20GiB docker" };
    return { status: 0, stdout: "", stderr: "" };
  };
  base.deps.run = run;
  let probed = 0;
  base.deps.probe = () => { probed += 1; return { ok: true, direction: "ROUND_TRIP" }; };
  assert.throws(() => ensureInstance({ profile: "autoloop-graph", roMounts: [repo], rwMounts: ["/tmp/suite-b"], deps: base.deps , env: COLIMA_ENV}), /SIGKILL mid-reconcile/);
  assert.equal(probed, 0);
});

test("ensureInstance T6/T7: failed round-trip probe fails closed with explicit HOLD code", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
  const fp = mountFingerprint([{ location: repo, writable: false }, FP_A]);
  const { deps } = fakeDeps({ runtimeNow: fp, runtimeAfter: fp, probeOk: false, listRows: ["autoloop-graph Running aarch64 2 2GiB 20GiB docker"] });
  assert.throws(
    () => ensureInstance({ profile: "autoloop-graph", roMounts: [repo], rwMounts: ["/tmp/suite-a"], deps , env: COLIMA_ENV}),
    (e) => e instanceof ColimaRuntimeError && e.message.includes("COLIMA_ROUND_TRIP_PROBE_FAILED"),
  );
});

test("runtime fingerprint helpers are total over missing instances", () => {
  withRealColimaHome(() => {
    assert.equal(runtimeMountFingerprint("autoloop-does-not-exist-anywhere"), null);
    assert.ok(limaRuntimeYamlPath("p").endsWith("/_lima/colima-p/lima.yaml"));
  });
  // listInstances is total regardless of the runtime home.
  assert.deepEqual(listInstances(() => ({ status: 1, stdout: "", stderr: "boom" })), []);
});

// ── R2A28: RW mount cardinality authority（EXACTLY ONE）────────────────────
// A28 bypass: fingerprint covered [A,B] but roundTripProbe only verified
// rwMounts[0], so an invalid B could still publish readiness. The contract
// is frozen at exactly one writable scratch mount, validated before ANY
// machine action / filesystem effect / probe.

const HOLD_CODE = /COLIMA_RW_MOUNT_CARDINALITY_INVALID/;

/** Every dependency is a tripwire: touching it means a side effect escaped
 *  ahead of cardinality validation. */
/**
 * A dependency set where every machine action explodes: the cardinality tests
 * assert that a malformed request is rejected BEFORE anything runs.
 *
 * It also satisfies the storage gate (with `COLIMA_HOME` supplied explicitly by
 * the caller) so the tests reach the cardinality seam rather than stopping at
 * the environment check — and so they do not depend on the ambient
 * environment being configured.
 */
function inertDeps() {
  const boom = () => { throw new Error("SIDE_EFFECT_BEFORE_CARDINALITY_VALIDATION"); };
  return { run: boom, resolve: boom, probe: boom, runtimeFingerprint: boom, ...GATE_FACTS };
}

/** The env every ensureInstance call in this file uses. */
const COLIMA_ENV = Object.freeze({ COLIMA_HOME: CANON });

test("R2A28 T1 ZERO_RW_MOUNTS: [] fails closed before any action", () => {
  assert.throws(
    () => ensureInstance({ profile: "autoloop-graph", roMounts: [], rwMounts: [], deps: inertDeps(), env: COLIMA_ENV }),
    (e) => e instanceof ColimaRuntimeError && HOLD_CODE.test(e.message),
  );
  assert.throws(() => assertSingleWritableMount([]), HOLD_CODE);
});

test("R2A28 T2 TWO_RW_MOUNTS: A28 reproduction now HOLDs at the seam", () => {
  // Exact R2R reproduction shape: two writable mounts whose joint fingerprint
  // used to publish readiness while only [0] was probed.
  assert.throws(
    () => ensureInstance({ profile: "autoloop-graph", roMounts: [], rwMounts: ["/tmp/a28-x", "/tmp/a28-y"], deps: inertDeps(), env: COLIMA_ENV }),
    (e) => e instanceof ColimaRuntimeError && HOLD_CODE.test(e.message),
  );
});

test("R2A28 T3 THREE_RW_MOUNTS and duplicate guest targets fail closed", () => {
  for (const bad of [["/a", "/b", "/c"], ["/dup", "/dup"]]) {
    assert.throws(
      () => ensureInstance({ profile: "autoloop-graph", roMounts: [], rwMounts: bad, deps: inertDeps(), env: COLIMA_ENV }),
      (e) => e instanceof ColimaRuntimeError && HOLD_CODE.test(e.message),
    );
  }
});

test("R2A28 T4 NON_ARRAY_RW_MOUNTS: null/object/string/undefined fail closed", () => {
  for (const bad of [null, {}, { length: 1, 0: "/x" }, "/tmp/solo", undefined]) {
    assert.throws(() => assertSingleWritableMount(bad), HOLD_CODE);
    assert.throws(
      () => ensureInstance({ profile: "autoloop-graph", roMounts: [], rwMounts: bad, deps: inertDeps(), env: COLIMA_ENV }),
      (e) => e instanceof ColimaRuntimeError && HOLD_CODE.test(e.message),
    );
  }
});

test("R2A28 T5 MALFORMED_SINGLE_RW_MOUNT: missing host path fails closed", () => {
  for (const bad of [[""], ["   "], [null], [42], [{ source: "/x", target: "/y" }]]) {
    assert.throws(
      () => ensureInstance({ profile: "autoloop-graph", roMounts: [], rwMounts: bad, deps: inertDeps(), env: COLIMA_ENV }),
      (e) => e instanceof ColimaRuntimeError && HOLD_CODE.test(e.message),
    );
  }
});

test("R2A28 T6 INVALID_INPUT_ZERO_MACHINE_ACTION: no list/start/stop/docker/probe", () => {
  const touched = [];
  const spy = (...k) => () => { touched.push(k.join(":")); throw new Error("ESCAPED"); };
  const deps = { run: spy("run"), resolve: spy("resolve"), probe: spy("probe"), runtimeFingerprint: spy("fp"), ...GATE_FACTS };
  assert.throws(
    () => ensureInstance({ profile: "autoloop-graph", roMounts: [], rwMounts: ["/x", "/y"], deps , env: COLIMA_ENV}),
    HOLD_CODE,
  );
  assert.deepEqual(touched, [], `machine actions leaked past validation: ${JSON.stringify(touched)}`);
});

test("R2A28 T7 INVALID_INPUT_ZERO_FILESYSTEM_EFFECT: no undefined/.autoloop-probe created", () => {
  const prev = process.cwd();
  const tmp = mkdtempSync(join(tmpdir(), "r2a28-t7-"));
  process.chdir(tmp);
  try {
    assert.throws(
      () => ensureInstance({ profile: "autoloop-graph", roMounts: [], rwMounts: [], deps: inertDeps(), env: COLIMA_ENV }),
      HOLD_CODE,
    );
    assert.deepEqual(readdirSync(tmp), [], "invalid input must not create probe directories");
  } finally {
    process.chdir(prev);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("R2A28 T8 EXACTLY_ONE_REUSE: single rw mount + matching runtime reuses", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
  const fp = mountFingerprint([{ location: repo, writable: false }, FP_A]);
  const { deps, calls, probeCalls } = fakeDeps({ runtimeNow: fp, runtimeAfter: fp, listRows: ["autoloop-graph Running aarch64 2 2GiB 20GiB docker"] });
  const r = ensureInstance({ profile: "autoloop-graph", roMounts: [repo], rwMounts: ["/tmp/suite-a"], deps , env: COLIMA_ENV});
  assert.equal(r.reused, true);
  assert.equal(r.ok, true);
  assert.equal(calls.start.length, 0);
  assert.equal(calls.stop, 0);
});

test("R2A28 T9 EXACTLY_ONE_RECONCILE: stale runtime still bounded-reconciles", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
  const desired = mountFingerprint([{ location: repo, writable: false }, FP_B]);
  const stale = mountFingerprint([{ location: repo, writable: false }, FP_A]);
  const { deps, calls } = fakeDeps({ runtimeNow: stale, runtimeAfter: desired, listRows: ["autoloop-graph Running aarch64 2 2GiB 20GiB docker"] });
  const r = ensureInstance({ profile: "autoloop-graph", roMounts: [repo], rwMounts: ["/tmp/suite-b"], deps , env: COLIMA_ENV});
  assert.equal(r.reconciled, true);
  assert.equal(calls.stop, 1);
  assert.equal(calls.start.length, 1);
});

test("R2A28 T10 EXACTLY_ONE_ROUND_TRIP: probe receives the validated mount only", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
  const fp = mountFingerprint([{ location: repo, writable: false }, FP_A]);
  const { deps, probeCalls } = fakeDeps({ runtimeNow: fp, runtimeAfter: fp, listRows: ["autoloop-graph Running aarch64 2 2GiB 20GiB docker"] });
  ensureInstance({ profile: "autoloop-graph", roMounts: [repo], rwMounts: ["/tmp/suite-a/"], deps , env: COLIMA_ENV});
  assert.equal(probeCalls.length, 1);
  assert.equal(probeCalls[0].scratchRoot, "/tmp/suite-a", "probe must get the normalized validated mount, never rwMounts[i]");
  assert.equal(probeCalls[0].profile, "autoloop-graph");
});

test("R2A28 T11 MULTIPLE_RO_MOUNTS_PRESERVED: several read-only mounts unaffected", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
  // Any real directory works: this test is about the FINGERPRINT including all
  // mounts, not about which directory it is.
  const extraRo = tmpdir();
  const fp = mountFingerprint([
    { location: repo, writable: false },
    { location: extraRo, writable: false },
    FP_A,
  ]);
  const { deps, calls, probeCalls } = fakeDeps({ runtimeNow: fp, runtimeAfter: fp, listRows: ["autoloop-graph Running aarch64 2 2GiB 20GiB docker"] });
  const r = ensureInstance({ profile: "autoloop-graph", roMounts: [repo, extraRo], rwMounts: ["/tmp/suite-a"], deps , env: COLIMA_ENV});
  assert.equal(r.ok, true);
  assert.equal(calls.start.length, 0, "matching multi-ro generation must reuse");
  assert.equal(probeCalls.length, 1);
});

test("R2A28 T12 A28_SHORTEST_PATH: matching dual-rw runtime still cannot go ready", () => {
  // Even when the VM already runs the exact [repo, A, B] generation — i.e.
  // planInstanceAction would say REUSE and the old code probed only A —
  // dual writable mounts are rejected before any action or probe.
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
  const dualFp = mountFingerprint([{ location: repo, writable: false }, FP_A, FP_B]);
  let fpReads = 0;
  const deps = inertDeps();
  deps.runtimeFingerprint = () => { fpReads += 1; return dualFp; };
  assert.throws(
    () => ensureInstance({ profile: "autoloop-graph", roMounts: [repo], rwMounts: ["/tmp/suite-a", "/tmp/suite-b"], deps , env: COLIMA_ENV}),
    (e) => e instanceof ColimaRuntimeError && HOLD_CODE.test(e.message),
  );
  assert.equal(fpReads, 0, "runtime fingerprint must not even be read after invalid cardinality");
});

test("R2A28 T13 DIRECT_PROBE_BYPASS: roundTripProbe rejects unvalidated mount arrays", () => {
  assert.throws(() => roundTripProbe({ profile: "autoloop-graph", scratchRoot: ["/a", "/b"] }), HOLD_CODE);
  assert.throws(() => roundTripProbe({ profile: "autoloop-graph", scratchRoot: undefined }), HOLD_CODE);
  assert.throws(() => roundTripProbe({ profile: "autoloop-graph", scratchRoot: "" }), HOLD_CODE);
  assert.throws(() => roundTripProbe({ profile: "autoloop-graph", scratchRoot: 42 }), HOLD_CODE);
});

test("R2A28 T14 READINESS_NOT_PUBLISHED: invalid cardinality never returns ready/reused", () => {
  for (const bad of [[], ["/a", "/b"], null]) {
    let result;
    try {
      result = ensureInstance({ profile: "autoloop-graph", roMounts: [], rwMounts: bad, deps: inertDeps(), env: COLIMA_ENV });
      assert.fail(`invalid cardinality ${JSON.stringify(bad)} published readiness: ${JSON.stringify(result)}`);
    } catch (e) {
      assert.ok(e instanceof ColimaRuntimeError && HOLD_CODE.test(e.message));
    }
  }
});

test("R2A28 authority returns the normalized validated mount path", () => {
  assert.equal(assertSingleWritableMount(["/tmp/suite-a"]), "/tmp/suite-a");
  assert.equal(assertSingleWritableMount(["/tmp/suite-a/"]), "/tmp/suite-a");
});

// ── F/G profile single-flight (AUTOLOOP_BACKGROUND_WAITER_COALESCING_AND_
// PROFILE_SINGLEFLIGHT_1) ──────────────────────────────────────────────────
// The lock module is standalone (no colima-runtime import) so the E1/E2
// isolation shims stay link-clean; the profile allowlist mirrors
// AUTOLOOP_TEST_PROFILES and parity is asserted below.

import {
  acquireColimaProfileLock,
  colimaProfileLockPath,
  COLIMA_PROFILE_LOCK_HOLD,
  COLIMA_PROFILE_LOCK_ALLOWED,
  colimaProfileLockDefaultRoot,
} from "../src/runtime/colima-profile-lock.mjs";
import { mkdirSync, readFileSync as readLockFileSync, rmSync as rmLockDirSync } from "node:fs";

function lockTestRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), "profile-lock-"));
  t.after(() => rmLockDirSync(dir, { recursive: true, force: true }));
  return dir;
}

test("F/G parity: lock allowlist mirrors AUTOLOOP_TEST_PROFILES exactly", () => {
  assert.deepEqual([...COLIMA_PROFILE_LOCK_ALLOWED].sort(), [...AUTOLOOP_TEST_PROFILES].sort());
  assert.equal(colimaProfileLockDefaultRoot({ env: { COLIMA_HOME: CANON } }), join(CANON, "autoloop-locks"));
});

test("F/G lock path is per-profile under the lock root", () => {
  assert.equal(
    colimaProfileLockPath("autoloop-graph", "/locks"),
    "/locks/colima-profile-autoloop-graph.lock",
  );
});

test("F/G unowned profile refuses to lock (mirrors the ensureInstance fence)", (t) => {
  const root = lockTestRoot(t);
  for (const profile of ["default", "autoloop-graph2", "autoloop-grap", "some-user-profile", "", undefined]) {
    assert.throws(
      () => acquireColimaProfileLock({ profile, root }),
      (e) => e instanceof C2dHoldError && e.code === COLIMA_PROFILE_LOCK_HOLD.NOT_TEST_OWNED,
      `profile ${String(profile)} must be refused`,
    );
  }
});

test("F/G single-flight: second acquirer on the same profile gets COLIMA_PROFILE_BUSY; distinct profiles never contend", (t) => {
  const root = lockTestRoot(t);
  const first = acquireColimaProfileLock({ profile: "autoloop-graph", actorId: "graph-A", sessionId: "sess-A", root });
  assert.equal(first.profile, "autoloop-graph");
  assert.equal(first.reclaimed, false);
  // same profile -> BUSY (never a wait, never a steal)
  assert.throws(
    () => acquireColimaProfileLock({ profile: "autoloop-graph", actorId: "graph-B", sessionId: "sess-B", root }),
    (e) => e instanceof C2dHoldError && e.code === COLIMA_PROFILE_LOCK_HOLD.BUSY,
  );
  // the durable record names the holder for forensics
  const rec = JSON.parse(readLockFileSync(first.path, "utf8"));
  assert.equal(rec.actor_id, "graph-A");
  assert.equal(rec.lock_kind, "colima_profile");
  assert.equal(rec.process_id, process.pid);
  // distinct profile -> independent (card NON-GOAL: don't serialize independent work)
  const other = acquireColimaProfileLock({ profile: "autoloop-w1", actorId: "graph-B", sessionId: "sess-B", root });
  other.release();
  first.release();
});

test("F/G release frees the profile; released handle cannot release again; forged handle cannot release", (t) => {
  const root = lockTestRoot(t);
  const h = acquireColimaProfileLock({ profile: "autoloop-c3", actorId: "a", root });
  h.release();
  // profile is free: a second acquirer succeeds
  const h2 = acquireColimaProfileLock({ profile: "autoloop-c3", actorId: "b", root });
  h2.release();
  // double release on the issued handle fails closed
  assert.throws(
    () => h.release(),
    (e) => e instanceof C2dHoldError && e.code === COLIMA_PROFILE_LOCK_HOLD.RELEASE_OWNER_MISMATCH,
  );
  // a copied handle is not the capability
  const copy = { ...h2, release: h2.release };
  assert.throws(
    () => copy.release(),
    (e) => e instanceof C2dHoldError && e.code === COLIMA_PROFILE_LOCK_HOLD.RELEASE_OWNER_MISMATCH,
  );
});

test("F/G crash recovery: same-host dead-pid orphan is reclaimed; cross-host orphan is NOT", (t) => {
  const root = lockTestRoot(t);
  const fixed = {
    lock_kind: "colima_profile",
    execution_id: "colima-profile-lock",
    checkpoint_id: "profile",
    chain_id: "profile",
    lease_id: "none",
    lease_revision: 0,
    expected_head: "none",
    acquired_at: new Date(Date.now() - 60000).toISOString(),
  };
  // same-host orphan (dead pid)
  const localPath = colimaProfileLockPath("autoloop-graph", root);
  mkdirSync(root, { recursive: true });
  writeLockFileSync(localPath, JSON.stringify({
    format_version: "1.0.0", lock_id: "lock_orphan_local", ...fixed,
    actor_id: "dead-run", session_id: "dead-sess",
    process_id: 999999999, host_identity: hostname(),
    repository_identity: "colima-profile:autoloop-graph", worktree_identity: "colima-profile:autoloop-graph",
  }, null, 2) + "\n");
  const reclaimed = acquireColimaProfileLock({ profile: "autoloop-graph", actorId: "new", root });
  assert.equal(reclaimed.reclaimed, true);
  reclaimed.release();

  // cross-host orphan: never reclaimed, fails closed
  const remotePath = colimaProfileLockPath("autoloop-w2", root);
  writeLockFileSync(remotePath, JSON.stringify({
    format_version: "1.0.0", lock_id: "lock_orphan_remote", ...fixed,
    actor_id: "remote-run", session_id: "remote-sess",
    process_id: 4242, host_identity: "some-other-host",
    repository_identity: "colima-profile:autoloop-w2", worktree_identity: "colima-profile:autoloop-w2",
  }, null, 2) + "\n");
  assert.throws(
    () => acquireColimaProfileLock({ profile: "autoloop-w2", actorId: "new", root }),
    (e) => e instanceof C2dHoldError && e.code === COLIMA_PROFILE_LOCK_HOLD.RECLAIM_UNPROVEN,
  );
});

import { writeFileSync as writeLockFileSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
