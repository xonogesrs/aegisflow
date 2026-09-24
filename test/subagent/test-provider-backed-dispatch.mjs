// test/subagent/test-provider-backed-dispatch.mjs
//
// WP1-A2 — PROVIDER-BACKED SUB-AGENT EXECUTION (deterministic offline proof
// of the dispatch seam in src/subagent/subagent-graph-runner.mjs).
//
// Proves, against the REAL production dispatcher (subagentExecutorFactory):
//   PB1  an admitted provider_binding routes sub-agent node execution through
//        THE production provider adapter (createPiRpcAdapter) and the
//        adapter-owned provider session's usage surfaces as canonical
//        metadata.providerUsage on the node result (the exact channel
//        captureNodeResult / onPhaseTerminal consume), alongside the intact
//        container sub-agent structured-result contract;
//   PB2  without an admitted binding the dispatch is unchanged
//        (container-only) and NO providerUsage / providerBacked metadata
//        ever exists — regardless of the container outcome;
//   PB3  the node's usage authority is the adapter-owned session ONLY:
//        agent-authored structured-result content carries no usage authority
//        and is never promoted to metadata.providerUsage;
//   PB4  a failed provider session fails the node closed
//        (PROVIDER_BACKING_FAILED) with providerUsage null — no fabricated
//        usage, no silent container-only fallback;
//   PB5  the STAGE C §7 selection fence is preserved: a canonical
//        toolSelection rides the wired adapter (re-validated fail-closed);
//        a non-canonical request on a wired admission keeps the legacy safe
//        default through the unwired adapter.
//
// The provider session child is test/fixtures/fake-pi-rpc.mjs (via
// PI_EXECUTABLE) — no network, no real provider. The container sub-agent
// leg runs the real Colima read-only agent (profile autoloop-graph).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { subagentExecutorFactory } from "../../src/subagent/subagent-graph-runner.mjs";
import { ensureInstance } from "../../src/runtime/colima-runtime.mjs";
import { SUBAGENT_RESULT_SCHEMA } from "../../src/subagent/subagent-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "..", "fixtures", "fake-pi-rpc.mjs");
const USAGE = Object.freeze({ input: 530, output: 25, cacheRead: 0, cacheWrite: 0, totalTokens: 555 });
// HOME-based scratch/persistence convention (same as test-durable-subagent-resume.mjs):
// the colima instance mounts $HOME, so the sub-agent resultsDir / scratch writes
// persist（/var/folders does not）.
const BASE = join(homedir(), ".pb-dispatch-test");

function tmp(label) {
  const dir = join(BASE, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRepo(dir) {
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "master"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "pb@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "pb"]);
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "source.md"), "# fixture\n\nTODO: probe fixture\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "base"]);
}

function admittedAdmission({ withBinding = true } = {}) {
  // Minimal frozen-shaped admission carrying THE provider binding. The
  // dispatcher reads ONLY admission.extensions.rollover.provider_binding —
  // the same canonical surface the rollover authority derives from.
  // FAKE_PI_CONTROL rides requiredEnvKeys so the offline fixture session
  // receives its scenario control through the SAME env gate a real
  // admitted key would use.
  return {
    admission_id: "pb-test-admission",
    extensions: {
      rollover: {
        enabled: true,
        context_occupancy_threshold: 100,
        provider_binding: withBinding
          ? { adapterKind: "pi-builtin", providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash", requiredEnvKeys: ["MERGE_GATEWAY_API_KEY", "FAKE_PI_CONTROL"] }
          : null,
      },
    },
  };
}

function baseRequest({ scratchRoot = null, overrides = {} } = {}) {
  const runtime = { mode: "subagent", taskType: "count_todos", agentRole: "readonly-analyst" };
  if (scratchRoot) {
    mkdirSync(join(scratchRoot, "SA-R1", "scratch"), { recursive: true });
    runtime.scratchPath = join(scratchRoot, "SA-R1", "scratch");
    runtime.limits = { memoryMiB: 256, timeoutMs: 60000 };
  }
  return {
    executionId: "exec-pb-1",
    cwd: tmpdir(),
    taskCard: {
      parentExecutionId: "graph-pb",
      phaseId: "SA-R1",
      runtime,
    },
    phase: "executor",
    attempt: 0,
    timeoutMs: 120000,
    ...overrides,
  };
}

async function withFixtureControl(control, { repo = null, scratchRoot = null } = {}, fn) {
  const prevHome = process.env.COLIMA_HOME;
  process.env.COLIMA_HOME = process.env.COLIMA_HOME ?? "/var/lib/autoloop-colima";
  // The container leg mounts repoPath(ro) + owned scratch(rw) — the SAME
  // instance-mount reconciliation the production graph runner performs
  // (ensureInstance with the desired mount generation).
  if (repo && scratchRoot) {
    // Mount-location parity with the production runner: the owned scratch
    // path is REALPATH-normalized BEFORE the instance mount generation is
    // registered (the probe/round-trip seam normalizes the same way).
    ensureInstance({ profile: "autoloop-graph", cpus: 2, memory: 2, disk: 20, roMounts: [realpathSync(repo)], rwMounts: [realpathSync(scratchRoot)] });
  }
  const prevPi = process.env.PI_EXECUTABLE;
  const prevControl = process.env.FAKE_PI_CONTROL;
  const prevKey = process.env.MERGE_GATEWAY_API_KEY;
  process.env.PI_EXECUTABLE = FIXTURE;
  process.env.FAKE_PI_CONTROL = JSON.stringify(control);
  process.env.MERGE_GATEWAY_API_KEY = process.env.MERGE_GATEWAY_API_KEY ?? "pb-test-key";
  try {
    return await fn();
  } finally {
    if (prevPi === undefined) delete process.env.PI_EXECUTABLE;
    else process.env.PI_EXECUTABLE = prevPi;
    if (prevControl === undefined) delete process.env.FAKE_PI_CONTROL;
    else process.env.FAKE_PI_CONTROL = prevControl;
    if (prevHome === undefined) delete process.env.COLIMA_HOME;
    else process.env.COLIMA_HOME = prevHome;
  }
}
test("PB1: admitted binding routes sub-agent execution through the provider adapter; adapter-owned usage surfaces as metadata.providerUsage", { timeout: 300000 }, async () => {
  const repo = tmp("pb1-repo");
  const scratchRoot = tmp("pb1-scratch");
  const resultsDir = join(scratchRoot, "results");
  mkdirSync(resultsDir, { recursive: true });
  makeRepo(repo);
  try {
    await withFixtureControl({ assistantUsage: USAGE }, { repo, scratchRoot }, async () => {
      const factoryHost = subagentExecutorFactory({
        profile: "autoloop-graph", repoPath: repo, scratchRoot, resultsDir,
        maxRepairAttempts: 0,
        admission: admittedAdmission(),
      });
      const sinkCalls = [];
      const adapter = factoryHost({ resultSink: (id, r) => sinkCalls.push([id, r]) })().runAdapter;
      const result = await adapter(baseRequest({ scratchRoot }));
      assert.equal(result.status, "completed", `dispatch completed (error=${result.error ?? "none"})`);
      // canonical providerUsage: the adapter-owned session's usage object,
      // verbatim — never estimated, never synthesized.
      assert.deepEqual(result.metadata.providerUsage, USAGE);
      assert.deepEqual(result.metadata.providerBacked, {
        adapterKind: "pi-builtin",
        providerKind: "merge-gateway",
        modelId: "zai/glm-5.3-flash",
        status: "completed",
      });
      // the merged result is what the downstream node-result projection
      // consumes (the LAST sink call for this execution id wins)
      const sunk = sinkCalls.filter(([id]) => id === "exec-pb-1").pop();
      assert.ok(sunk, "merged result re-sunk for captureNodeResult");
      assert.deepEqual(sunk[1].metadata.providerUsage, USAGE);
      // the sub-agent structured-result contract is intact alongside the
      // provider backing (same node-result path, no second representation)
      assert.equal(result.metadata.subagent?.validation?.ok, true);
      assert.equal(result.metadata.subagent?.result?.schema_version, SUBAGENT_RESULT_SCHEMA);
    });
  } finally {
    for (const d of [repo, scratchRoot, resultsDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("PB2: no admitted binding -> dispatch unchanged (container-only), no providerUsage, no provider session", { timeout: 120000 }, async () => {
  const repo = tmp("pb2-repo");
  const scratchRoot = tmp("pb2-scratch");
  const resultsDir = tmp("pb2-results");
  makeRepo(repo);
  try {
    await withFixtureControl({ assistantUsage: USAGE }, {}, async () => {
      // no scratchPath -> the container adapter fails fast; the assertion
      // target is the ABSENCE of provider metadata on ANY outcome.
      const factoryHost = subagentExecutorFactory({
        profile: "autoloop-graph", repoPath: repo, scratchRoot, resultsDir,
        maxRepairAttempts: 0,
        admission: admittedAdmission({ withBinding: false }),
      });
      const adapter = factoryHost({ resultSink: null })().runAdapter;
      const result = await adapter(baseRequest());
      assert.equal(result.metadata.providerUsage, undefined, "no providerUsage without an admitted binding");
      assert.equal(result.metadata.providerBacked, undefined);
      assert.equal(result.metadata.subagent, undefined);
    });
    // also: NO admission at all
    const factoryHost = subagentExecutorFactory({
      profile: "autoloop-graph", repoPath: repo, scratchRoot, resultsDir, maxRepairAttempts: 0, admission: null,
    });
    const adapter = factoryHost({ resultSink: null })().runAdapter;
    const result = await adapter(baseRequest());
    assert.equal(result.metadata.providerUsage, undefined);
    assert.equal(result.metadata.providerBacked, undefined);
  } finally {
    for (const d of [repo, scratchRoot, resultsDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("PB3: the node's usage authority is the adapter-owned session only; agent-authored result content carries no usage authority", { timeout: 300000 }, async () => {
  const repo = tmp("pb3-repo");
  const scratchRoot = tmp("pb3-scratch");
  const resultsDir = join(scratchRoot, "results");
  mkdirSync(resultsDir, { recursive: true });
  makeRepo(repo);
  try {
    await withFixtureControl({ assistantUsage: USAGE }, { repo, scratchRoot }, async () => {
      const factoryHost = subagentExecutorFactory({
        profile: "autoloop-graph", repoPath: repo, scratchRoot, resultsDir,
        maxRepairAttempts: 0,
        admission: admittedAdmission(),
      });
      const adapter = factoryHost({ resultSink: null })().runAdapter;
      const result = await adapter(baseRequest({ scratchRoot }));
      assert.equal(result.status, "completed");
      assert.deepEqual(result.metadata.providerUsage, USAGE, "node usage == adapter-owned session usage");
      // agent-authored content is quarantined under metadata.subagent.result
      // and is never consulted as the usage authority
      const agentResult = result.metadata.subagent?.result ?? null;
      assert.ok(agentResult, "agent structured result present");
      assert.equal(agentResult.providerUsage, undefined,
        "agent-authored result content carries no usage authority");
      assert.equal(result.metadata.providerUsage?.input, USAGE.input);
    });
  } finally {
    for (const d of [repo, scratchRoot, resultsDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("PB4: failed provider session fails the node closed (PROVIDER_BACKING_FAILED), providerUsage null, no container fallback", async () => {
  const repo = tmp("pb4-repo");
  const scratchRoot = tmp("pb4-scratch");
  const resultsDir = tmp("pb4-results");
  makeRepo(repo);
  try {
    await withFixtureControl({ scenario: "error-stop-reason" }, {}, async () => {
      const factoryHost = subagentExecutorFactory({
        profile: "autoloop-graph", repoPath: repo, scratchRoot, resultsDir,
        maxRepairAttempts: 0,
        admission: admittedAdmission(),
      });
      const sinkCalls = [];
      const adapter = factoryHost({ resultSink: (id, r) => sinkCalls.push([id, r]) })().runAdapter;
      const result = await adapter(baseRequest());
      assert.equal(result.status, "error");
      assert.ok(String(result.error).startsWith("PROVIDER_BACKING_FAILED"), `fail-closed error, got ${result.error}`);
      assert.equal(result.metadata.providerUsage, null, "no usage from a failed provider session");
      assert.equal(result.metadata.providerBacked?.status, "error");
      const sunk = sinkCalls.filter(([id]) => id === "exec-pb-1").pop();
      assert.ok(sunk, "failed result re-sunk for the observation failure path");
      assert.equal(sunk[1].metadata.providerUsage, null);
    });
  } finally {
    for (const d of [repo, scratchRoot, resultsDir]) rmSync(d, { recursive: true, force: true });
  }
});

test("PB5: STAGE C fence preserved — non-canonical request keeps the legacy safe default; canonical selection is re-validated fail-closed", async () => {
  const repo = tmp("pb5-repo");
  const scratchRoot = tmp("pb5-scratch");
  const resultsDir = join(scratchRoot, "results");
  makeRepo(repo);
  try {
    await withFixtureControl({ assistantUsage: USAGE }, { repo, scratchRoot }, async () => {
      const factoryHost = subagentExecutorFactory({
        profile: "autoloop-graph", repoPath: repo, scratchRoot, resultsDir,
        maxRepairAttempts: 0,
        admission: admittedAdmission(),
      });
      const adapter = factoryHost({
        resultSink: null,
        selectionAuthority: async () => ({ taskId: "t", taskAllocationDigest: "d", admissionId: "a", admissionDigestValue: "ad", admission: {} }),
      })().runAdapter;
      // non-canonical toolPolicy on a wired admission -> UNWIRED adapter,
      // legacy --no-tools default, provider session still completes and its
      // usage still surfaces (the container leg then fails fast without a
      // scratchPath — the provider-backed metadata remains on the result).
      const legacy = await adapter(baseRequest({ overrides: { toolPolicy: { mode: "no-builtin-tools" } } }));
      assert.deepEqual(legacy.metadata.providerUsage, USAGE, "legacy safe default preserved through the unwired adapter");
      assert.equal(legacy.metadata.providerBacked?.status, "completed");
      // canonical-shaped toolPolicy routes to the WIRED adapter; the
      // authority binding above is deliberately invalid, so the STAGE C
      // re-validation must fail closed BEFORE any spawn.
      const canonical = await adapter(baseRequest({
        overrides: {
          toolPolicy: {
            contractVersion: "autoloop.tool-selection/v1",
            taskIdentity: { taskId: "t", taskAllocationDigest: "d" },
            runIdentity: "exec-pb-1",
            admissionIdentity: { admissionId: "a", admissionDigest: "ad" },
            nodeRole: "readonly-analyst",
            canonicalToolIds: [], permissionIds: [], adapterKind: "pi-builtin",
            adapterToolNames: [], registryDigest: "0".repeat(64),
            runtimeVocabularyDigest: "0".repeat(64),
            mappingVersion: 1,
          },
        },
      }));
      assert.equal(canonical.status, "error");
      assert.ok(String(canonical.error).includes("TOOL_SELECTION_PROVENANCE_INVALID"),
        `wired adapter re-validated fail-closed, got ${canonical.error}`);
      assert.equal(canonical.metadata.providerUsage, null);
    });
  } finally {
    for (const d of [repo, scratchRoot, resultsDir]) rmSync(d, { recursive: true, force: true });
  }
});
