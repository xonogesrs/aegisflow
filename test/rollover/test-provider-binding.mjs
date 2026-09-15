// test/rollover/test-provider-binding.mjs
//
// AUTOLOOP_ROLLOVER_PROVIDER_BINDING_IMPLEMENTATION_1 — WP8
// admission / adapter / env / successor-inheritance / REAL_TASK seams.

import { test } from "node:test";
import assert from "node:assert/strict";


import {
  canonicalizeProviderBinding,
  providerBindingsEqual,
  resolveSpawnAdapter,
  SPAWN_RUNTIME_CAPABILITIES,
} from "../../src/rollover/spawn-registry.mjs";
import {
  spawnArgsFromBinding,
  spawnEnvFromBinding,
  spawnEvidenceFromBinding,
  spawnSuccessorSession,
  sessionIdFromSessionFile,
  PI_SPAWN_OPERATIONAL_ENV_KEYS,
} from "../../src/adapter/pi-spawn-adapter.mjs";
import {
  bootstrapSuccessorSession,
  evaluateRealTaskEvidence,
  observeProviderUsageAndTrigger,
} from "../../src/rollover/production-wiring.mjs";
import { makeAdmission, makeNonTerminalRunFixture } from "../v2/helpers/e1-soak-fixtures.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";

const GLM_BINDING = Object.freeze({
  adapterKind: "pi-builtin",
  providerKind: "merge-gateway",
  modelId: "zai/glm-5.3-flash",
  requiredEnvKeys: Object.freeze(["MERGE_GATEWAY_API_KEY"]),
});
const DEEPSEEK_BINDING = Object.freeze({
  adapterKind: "pi-builtin",
  providerKind: "deepseek",
  modelId: "deepseek-v4-flash",
  requiredEnvKeys: Object.freeze([]),
});

function makeRolloverAdmission(binding) {
  const rec = buildAdmissionRecord({
    taskId: "pb-inherit",
    classification: classify({}),
    extensions: {
      rollover: {
        enabled: true,
        context_occupancy_threshold: 100,
        provider_binding: binding,
      },
    },
  });
  return freezeAdmission(rec);
}

// ── Admission / registry ───────────────────────────────────────────────────

test("ADMISSION valid GLM and DeepSeek bindings are accepted", () => {
  assert.equal(canonicalizeProviderBinding(GLM_BINDING).ok, true);
  assert.equal(canonicalizeProviderBinding(DEEPSEEK_BINDING).ok, true);
  assert.ok(SPAWN_RUNTIME_CAPABILITIES.some((r) => r.providerKind === "merge-gateway"));
  assert.ok(SPAWN_RUNTIME_CAPABILITIES.some((r) => r.providerKind === "deepseek"));
});

test("ADMISSION unsupported pair is rejected", () => {
  const r = canonicalizeProviderBinding({
    adapterKind: "pi-builtin",
    providerKind: "openai",
    modelId: "gpt-4",
    requiredEnvKeys: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "CROSS_SESSION_SUCCESSOR_ADAPTER_UNKNOWN");
});

test("ADMISSION missing model is rejected", () => {
  const r = canonicalizeProviderBinding({
    adapterKind: "pi-builtin",
    providerKind: "merge-gateway",
    requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"],
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /modelId/);
});

test("ADMISSION extra secret-bearing fields are rejected", () => {
  const r = canonicalizeProviderBinding({
    ...GLM_BINDING,
    apiKey: "sk-thisMustNeverBePersisted12",
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /extra fields/);
});

// ── Adapter ────────────────────────────────────────────────────────────────

test("ADAPTER merge-gateway and deepseek routes are accepted; unknown pair rejected", async () => {
  const glm = resolveSpawnAdapter({ adapterKind: "pi-builtin", providerKind: "merge-gateway" });
  const ds = resolveSpawnAdapter({ adapterKind: "pi-builtin", providerKind: "deepseek" });
  const unknown = resolveSpawnAdapter({ adapterKind: "pi-builtin", providerKind: "openai" });
  assert.equal(glm.ok, true);
  assert.equal(ds.ok, true);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "CROSS_SESSION_SUCCESSOR_ADAPTER_UNKNOWN");
});

test("ADAPTER spawn args carry admitted provider/model and block resume/fork/session", () => {
  const glmArgs = spawnArgsFromBinding({
    sessionDir: "/tmp/sess",
    providerKind: GLM_BINDING.providerKind,
    modelId: GLM_BINDING.modelId,
  });
  const dsArgs = spawnArgsFromBinding({
    sessionDir: "/tmp/sess",
    providerKind: DEEPSEEK_BINDING.providerKind,
    modelId: DEEPSEEK_BINDING.modelId,
  });
  assert.deepEqual(glmArgs.slice(glmArgs.indexOf("--provider")), ["--provider", "merge-gateway", "--model", "zai/glm-5.3-flash"]);
  assert.deepEqual(dsArgs.slice(dsArgs.indexOf("--provider")), ["--provider", "deepseek", "--model", "deepseek-v4-flash"]);
  for (const args of [glmArgs, dsArgs]) {
    for (const forbidden of ["--resume", "-r", "--fork", "--session", "--continue", "-c"]) {
      assert.equal(args.includes(forbidden), false, forbidden);
    }
  }
});

test("ADAPTER real session identity derivation is unchanged", () => {
  assert.equal(
    sessionIdFromSessionFile("2026-09-15T07-00-00-000Z_3fa85f64-5717-4562-b3fc-2c963f66afa6.jsonl"),
    "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  );
  assert.equal(sessionIdFromSessionFile("nope.jsonl"), null);
});

test("ADAPTER caller env expansion is forbidden before spawn", async () => {
  const r = await spawnSuccessorSession({ environmentAllowlist: ["UNADMITTED_KEY"] });
  assert.equal(r.status, "error");
  assert.match(r.error, /env expansion/);
});

// ── Environment ────────────────────────────────────────────────────────────

test("ENV admitted key is forwarded; unadmitted key is not", () => {
  const parentEnv = {
    PATH: "/bin",
    HOME: "/tmp",
    MERGE_GATEWAY_API_KEY: "sentinel-not-for-logs",
    UNADMITTED_SECRET: "must-not-leak",
    DEEPSEEK_API_KEY: "also-must-not-leak",
  };
  const r = spawnEnvFromBinding({ requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"], parentEnv });
  assert.equal(r.ok, true);
  assert.equal(Object.hasOwn(r.env, "MERGE_GATEWAY_API_KEY"), true);
  assert.equal(Object.hasOwn(r.env, "UNADMITTED_SECRET"), false);
  assert.equal(Object.hasOwn(r.env, "DEEPSEEK_API_KEY"), false);
  assert.equal(Object.hasOwn(r.env, "PATH"), true);
  for (const k of PI_SPAWN_OPERATIONAL_ENV_KEYS) {
    if (parentEnv[k] !== undefined) assert.equal(r.env[k], parentEnv[k]);
  }
});

test("ENV missing required key fails closed", () => {
  const r = spawnEnvFromBinding({
    requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"],
    parentEnv: { PATH: "/bin" },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /MERGE_GATEWAY_API_KEY/);
  assert.equal(r.error.includes("sentinel"), false);
});

test("ENV secret values never enter spawn evidence", () => {
  const secret = "sk-thisIsAFakeGatewaySecretValue12";
  const r = spawnEnvFromBinding({
    requiredEnvKeys: ["MERGE_GATEWAY_API_KEY"],
    parentEnv: { PATH: "/bin", MERGE_GATEWAY_API_KEY: secret },
  });
  assert.equal(r.ok, true);
  const ev = spawnEvidenceFromBinding(GLM_BINDING);
  assert.equal(ev.ok, true);
  const serialized = JSON.stringify(ev.evidence);
  assert.equal(serialized.includes(secret), false);
  assert.deepEqual(ev.evidence.requiredEnvKeys, ["MERGE_GATEWAY_API_KEY"]);
  assert.equal(Object.hasOwn(ev.evidence, "apiKey"), false);
});

// ── Successor inheritance ──────────────────────────────────────────────────

test("INHERIT exact admitted binding is accepted as bootstrap cross-check", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "pb-exact", admission: makeAdmission("pb-exact") });
  try {
    await assert.rejects(
      () => bootstrapSuccessorSession({
        persistenceRoot: fx.root,
        executionId: fx.executionId,
        admission: makeRolloverAdmission(GLM_BINDING),
        spawnMeta: { providerBinding: GLM_BINDING },
      }),
      (e) => e.code !== "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID",
    );
  } finally { fx.cleanup(); }
});

test("INHERIT provider mismatch is rejected", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "pb-prov", admission: makeAdmission("pb-prov") });
  try {
    await assert.rejects(
      () => bootstrapSuccessorSession({
        persistenceRoot: fx.root,
        executionId: fx.executionId,
        admission: makeRolloverAdmission(GLM_BINDING),
        spawnMeta: { providerBinding: DEEPSEEK_BINDING },
      }),
      (e) => e.code === "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID"
        && String(e.message).includes("providerBinding"),
    );
  } finally { fx.cleanup(); }
});

test("INHERIT model mismatch is rejected", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "pb-model", admission: makeAdmission("pb-model") });
  try {
    await assert.rejects(
      () => bootstrapSuccessorSession({
        persistenceRoot: fx.root,
        executionId: fx.executionId,
        admission: makeRolloverAdmission(GLM_BINDING),
        spawnMeta: {
          providerBinding: { ...GLM_BINDING, modelId: "deepseek-v4-flash", providerKind: "merge-gateway" },
        },
      }),
      (e) => e.code === "CROSS_SESSION_SUCCESSOR_ADAPTER_UNKNOWN"
        || e.code === "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID",
    );
  } finally { fx.cleanup(); }
});

test("INHERIT adapter mismatch is rejected", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "pb-adp", admission: makeAdmission("pb-adp") });
  try {
    await assert.rejects(
      () => bootstrapSuccessorSession({
        persistenceRoot: fx.root,
        executionId: fx.executionId,
        admission: makeRolloverAdmission(GLM_BINDING),
        spawnMeta: { providerBinding: { ...GLM_BINDING, adapterKind: "omp-builtin" } },
      }),
      (e) => e.code === "CROSS_SESSION_SUCCESSOR_ADAPTER_UNKNOWN"
        || e.code === "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID",
    );
  } finally { fx.cleanup(); }
});

test("INHERIT env-key declaration mismatch is rejected", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "pb-env", admission: makeAdmission("pb-env") });
  try {
    await assert.rejects(
      () => bootstrapSuccessorSession({
        persistenceRoot: fx.root,
        executionId: fx.executionId,
        admission: makeRolloverAdmission(GLM_BINDING),
        spawnMeta: { providerBinding: { ...GLM_BINDING, requiredEnvKeys: [] } },
      }),
      (e) => e.code === "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID"
        && String(e.message).includes("providerBinding"),
    );
  } finally { fx.cleanup(); }
});

test("INHERIT successor default fallback cannot replace admitted binding", () => {
  process.env.AUTOLOOP_ROLLOVER_PROVIDER = "deepseek";
  process.env.AUTOLOOP_ROLLOVER_MODEL = "deepseek-v4-flash";
  try {
    const admitted = canonicalizeProviderBinding(GLM_BINDING);
    assert.equal(admitted.ok, true);
    const fallback = canonicalizeProviderBinding({
      adapterKind: "pi-builtin",
      providerKind: process.env.AUTOLOOP_ROLLOVER_PROVIDER,
      modelId: process.env.AUTOLOOP_ROLLOVER_MODEL,
      requiredEnvKeys: [],
    });
    assert.equal(providerBindingsEqual(admitted.value, fallback.ok ? fallback.value : null), false);
  } finally {
    delete process.env.AUTOLOOP_ROLLOVER_PROVIDER;
    delete process.env.AUTOLOOP_ROLLOVER_MODEL;
  }
});

test("INHERIT environment override cannot replace admitted binding", () => {
  process.env.AUTOLOOP_ROLLOVER_PROVIDER = "openai";
  try {
    const admitted = canonicalizeProviderBinding(GLM_BINDING);
    assert.equal(admitted.ok, true);
    assert.equal(admitted.value.providerKind, "merge-gateway");
    assert.notEqual(admitted.value.providerKind, process.env.AUTOLOOP_ROLLOVER_PROVIDER);
  } finally {
    delete process.env.AUTOLOOP_ROLLOVER_PROVIDER;
  }
});

// ── REAL_TASK ──────────────────────────────────────────────────────────────

test("REAL_TASK provider 402/failed usage cannot PASS", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "rt-fail", admission: makeAdmission("rt-fail") });
  try {
    const observation = observeProviderUsageAndTrigger({
      store: fx.store,
      admission: { extensions: { rollover: { enabled: true, context_occupancy_threshold: 1 } } },
      executionId: fx.executionId,
      phaseId: "R1",
      usage: null,
    });
    const r = evaluateRealTaskEvidence({ observation });
    assert.equal(r.ok, false);
    const fromJournal = evaluateRealTaskEvidence({
      journalEvents: [{ event_type: "ROLLOVER_USAGE_OBSERVATION_FAILED", payload: { reason: "402" } }],
    });
    assert.equal(fromJournal.ok, false);
  } finally { fx.cleanup(); }
});

test("REAL_TASK real provider success can PASS", async () => {
  const fx = await makeNonTerminalRunFixture({ tag: "rt-ok", admission: makeAdmission("rt-ok") });
  try {
    const observation = observeProviderUsageAndTrigger({
      store: fx.store,
      admission: { extensions: { rollover: { enabled: true, context_occupancy_threshold: 10 } } },
      executionId: fx.executionId,
      phaseId: "R1",
      usage: { input: 80, cacheRead: 20, cacheWrite: 0, output: 12, totalTokens: 112 },
    });
    const r = evaluateRealTaskEvidence({ observation });
    assert.equal(r.ok, true);
    assert.equal(r.occupancy, 100);
    const fromJournal = evaluateRealTaskEvidence({
      journalEvents: [{
        event_type: "PROVIDER_USAGE_OBSERVED",
        event_id: "evt_real",
        payload: { provider_reported: true, occupancy: 100 },
      }],
    });
    assert.equal(fromJournal.ok, true);
  } finally { fx.cleanup(); }
});

test("REAL_TASK zero occupancy cannot PASS", () => {
  const r = evaluateRealTaskEvidence({
    observation: { observed: true, occupancy: 0, usageEventId: "evt_zero" },
  });
  assert.equal(r.ok, false);
});
