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
// The PRIMARY production row (pi-builtin × deepseek, per FROZEN_RUNTIME_
// IDENTITY / auth store) is registered by the adapter-layer projection
// (src/adapter/pi-spawn-adapter.mjs registers itself through the same API).

const rows = new Map(); // "kind\u0000provider" -> { factory: function|null }

export function registerSpawnAdapterKind({ adapterKind, providerKind, factory }) {
  if (typeof adapterKind !== "string" || adapterKind.length === 0) {
    throw new TypeError("registerSpawnAdapterKind: adapterKind required");
  }
  if (typeof providerKind !== "string" || providerKind.length === 0) {
    throw new TypeError("registerSpawnAdapterKind: providerKind required");
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
