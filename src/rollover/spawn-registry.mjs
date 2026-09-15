// src/rollover/spawn-registry.mjs
//
// STAGE D — THE frozen {adapterKind, providerKind} → spawn-factory registry.
//
// PORTABILITY-CONTRACT.md §1: a future agent adapter requires NO core edits
// beyond registering its row here. This file holds REGISTRY DATA ONLY — it
// never imports any adapter implementation (agent-neutrality, T59). The
// factory for a row is injected at production/test wiring time through
// registerSpawnAdapterKind; the core consumes only the resolved closure via
// resolveSpawnAdapter.
//
// Runtime capability rows identify supported (adapterKind × providerKind ×
// modelId) combinations. They MUST NOT contain credentials. Factories are
// registered separately; an unknown pair fail-closes before any provider call.
//
// Admission provider_binding is the only execution-time provider authority.
// This registry answers "is this combination supported?", never "which
// provider should this run use?".

const rows = new Map(); // "kind\u0000provider" -> { factory: function|null }

export const SPAWN_RUNTIME_CAPABILITIES = Object.freeze([
  Object.freeze({ adapterKind: "pi-builtin", providerKind: "deepseek", modelId: "deepseek-v4-flash" }),
  Object.freeze({ adapterKind: "pi-builtin", providerKind: "merge-gateway", modelId: "zai/glm-5.3-flash" }),
]);

const BINDING_FIELDS = Object.freeze(["adapterKind", "providerKind", "modelId", "requiredEnvKeys"]);
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

export function registerSpawnAdapterKind({ adapterKind, providerKind, factory }) {
  if (typeof adapterKind !== "string" || adapterKind.length === 0) {
    throw new TypeError("registerSpawnAdapterKind: adapterKind required");
  }
  if (typeof providerKind !== "string" || providerKind.length === 0) {
    throw new TypeError("registerSpawnAdapterKind: providerKind required");
  }
  if (!SPAWN_RUNTIME_CAPABILITIES.some((r) => r.adapterKind === adapterKind && r.providerKind === providerKind)) {
    throw new Error(`spawn_adapter_kind_unsupported: ${adapterKind}/${providerKind}`);
  }
  // Two accepted shapes (one convention at the call site):
  //   - { spawnSuccessorSession(request) } object (adapter module surface)
  //   - async (request) => result function
  const callable = typeof factory === "function"
    ? factory
    : (factory && typeof factory.spawnSuccessorSession === "function"
        ? factory.spawnSuccessorSession.bind(factory)
        : null);
  if (!callable) {
    throw new TypeError("registerSpawnAdapterKind: factory must expose spawnSuccessorSession");
  }
  const key = `${adapterKind}\u0000${providerKind}`;
  const existing = rows.get(key);
  if (existing && existing.factory && existing.factory !== callable) {
    // Re-registration with a DIFFERENT factory would fork the authority.
    throw new Error(`spawn_adapter_kind_conflict: ${key}`);
  }
  rows.set(key, { factory: callable });
  return key;
}

export function isKnownAdapterPair(adapterKind, providerKind) {
  return rows.has(`${adapterKind}\u0000${providerKind}`);
}

export function knownAdapterKinds() {
  return new Set([...rows.keys()].map((k) => k.split("\u0000")[0]));
}

/** Pair keys in the "kind\u0000provider" form consumed by identity validation. */
export function knownAdapterPairKeys() {
  return new Set(rows.keys());
}

/**
 * Resolve THE one factory for the requested pair. Unknown kind ⇒ the exact
 * frozen hold code (fail closed before any provider call).
 */
export function resolveSpawnAdapter({ adapterKind, providerKind }) {
  const key = `${adapterKind}\u0000${providerKind}`;
  const row = rows.get(key);
  if (!row || typeof row.factory !== "function") {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_ADAPTER_UNKNOWN", reason: `no spawn factory registered for ${adapterKind}/${providerKind}` };
  }
  return { ok: true, factory: row.factory };
}

/**
 * Canonical admission/spawn provider binding. Persists key NAMES only —
 * never secret values. Unsupported adapter/provider/model combinations
 * fail closed.
 *
 * @returns {{ ok: true, value: object } | { ok: false, code: string, reason: string }}
 */
export function canonicalizeProviderBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "provider_binding missing" };
  }
  const extra = Object.keys(binding).filter((k) => !BINDING_FIELDS.includes(k));
  if (extra.length > 0) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: `provider_binding extra fields forbidden: ${extra.join(",")}` };
  }
  for (const f of ["adapterKind", "providerKind", "modelId"]) {
    if (typeof binding[f] !== "string" || binding[f].length === 0) {
      return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: `provider_binding.${f} missing` };
    }
  }
  if (!Array.isArray(binding.requiredEnvKeys)) {
    return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "provider_binding.requiredEnvKeys must be an array of key names" };
  }
  const seen = new Set();
  for (const key of binding.requiredEnvKeys) {
    if (typeof key !== "string" || !ENV_KEY_RE.test(key)) {
      return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: "provider_binding.requiredEnvKeys must be env-key names only" };
    }
    if (seen.has(key)) {
      return { ok: false, code: "CROSS_SESSION_SUCCESSOR_IDENTITY_INVALID", reason: `provider_binding.requiredEnvKeys duplicate: ${key}` };
    }
    seen.add(key);
  }
  const supported = SPAWN_RUNTIME_CAPABILITIES.some((r) =>
    r.adapterKind === binding.adapterKind
    && r.providerKind === binding.providerKind
    && r.modelId === binding.modelId,
  );
  if (!supported) {
    return {
      ok: false,
      code: "CROSS_SESSION_SUCCESSOR_ADAPTER_UNKNOWN",
      reason: `unsupported provider pair ${binding.adapterKind}/${binding.providerKind}/${binding.modelId}`,
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      adapterKind: binding.adapterKind,
      providerKind: binding.providerKind,
      modelId: binding.modelId,
      requiredEnvKeys: Object.freeze([...binding.requiredEnvKeys]),
    }),
  };
}

export function providerBindingsEqual(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (a.adapterKind !== b.adapterKind || a.providerKind !== b.providerKind || a.modelId !== b.modelId) {
    return false;
  }
  const ak = Array.isArray(a.requiredEnvKeys) ? a.requiredEnvKeys : null;
  const bk = Array.isArray(b.requiredEnvKeys) ? b.requiredEnvKeys : null;
  if (!ak || !bk || ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
  }
  return true;
}
