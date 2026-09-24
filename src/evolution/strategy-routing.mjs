// src/evolution/strategy-routing.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVOLUTION_COMPLETION_1 — Section E: the adaptive
// MODEL ROUTING seam over the routes this deployment actually supports.
//
// AUTHORITY BOUNDARY (unchanged, and the whole point of this module):
//   - `SPAWN_RUNTIME_CAPABILITIES` (rollover/spawn-registry.mjs) remains the
//     ONLY capability authority: a route that is not a row there can never be
//     selected, produced or persisted.
//   - the admitted `provider_binding` remains the ONLY execution-time provider
//     authority. This module NEVER replaces a supplied binding; it can only
//     return a binding for the case where the deployment left the route open,
//     and it validates that binding against the capability registry.
//   - therefore: an explicit/authority binding always wins and a strategy
//     preference can never widen the route set — only choose within it.
//
// The seam exists so a fitness-gated strategy preference (a promoted
// MODEL_ROUTING candidate) can influence the route of FUTURE same-task-class
// work — the §I cross-agent path.

import { SPAWN_RUNTIME_CAPABILITIES, canonicalizeProviderBinding } from "../rollover/spawn-registry.mjs";

/** The routes this deployment supports, as canonical `provider/model` values. */
export const SUPPORTED_ROUTE_VALUES = Object.freeze(
  SPAWN_RUNTIME_CAPABILITIES.map((r) => `${r.providerKind}/${r.modelId}`),
);

const ROUTE_VALUE_RE = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_./-]{1,96}$/;

/** Canonical route value for a binding (null when the binding is not canonical). */
export function routeValueOf(binding) {
  const c = canonicalizeProviderBinding(binding);
  if (!c.ok) return null;
  return `${c.value.providerKind}/${c.value.modelId}`;
}

/** Is this route value one of the deployment's supported capability rows? */
export function isSupportedRouteValue(value) {
  return typeof value === "string" && SUPPORTED_ROUTE_VALUES.includes(value);
}

/**
 * Resolve the route for ONE task class.
 *
 * @param {object} p
 * @param {string} [p.strategyPreference] — a promoted MODEL_ROUTING preference
 *        (the strategy store's active value; null when none)
 * @param {object|null} [p.explicitBinding] — an authority-supplied binding
 *        (admission). ALWAYS wins when present and canonical.
 * @param {string[]} [p.allowlist] — optional narrower allowlist (route values)
 * @returns {{ binding: object|null, route: string|null, source: string, reason: string|null }}
 *   `source` is one of EXPLICIT | STRATEGY | DEFAULT | STRATEGY_REFUSED |
 *   STRATEGY_UNSUPPORTED | ALLOWLIST_REFUSED.
 */
export function selectRouteForTaskClass({ strategyPreference = null, explicitBinding = null, allowlist = null } = {}) {
  const allow = Array.isArray(allowlist) && allowlist.length > 0 ? allowlist : null;

  // 1. Authority binding always wins — the seam never overrides admission.
  if (explicitBinding !== null && explicitBinding !== undefined) {
    const value = routeValueOf(explicitBinding);
    if (value !== null) {
      return { binding: canonicalizeProviderBinding(explicitBinding).value, route: value, source: "EXPLICIT", reason: "authority/admission binding is the execution-time provider authority" };
    }
    return { binding: null, route: null, source: "EXPLICIT", reason: "explicit binding present but not canonical" };
  }

  // 2. A strategy preference may choose ONLY inside the capability rows and,
  //    when supplied, inside the deployment allowlist.
  if (typeof strategyPreference === "string" && strategyPreference.length > 0) {
    if (!ROUTE_VALUE_RE.test(strategyPreference)) {
      return { ...defaultRoute(), source: "STRATEGY_REFUSED", reason: `preference is not a canonical route value: ${strategyPreference.slice(0, 64)}` };
    }
    if (!isSupportedRouteValue(strategyPreference)) {
      return { ...defaultRoute(), source: "STRATEGY_UNSUPPORTED", reason: `preference is not a supported capability row: ${strategyPreference.slice(0, 64)}` };
    }
    if (allow && !allow.includes(strategyPreference)) {
      return { ...defaultRoute(), source: "ALLOWLIST_REFUSED", reason: `preference outside the deployment allowlist: ${strategyPreference.slice(0, 64)}` };
    }
    const row = SPAWN_RUNTIME_CAPABILITIES.find((r) => `${r.providerKind}/${r.modelId}` === strategyPreference);
    const c = canonicalizeProviderBinding({ adapterKind: row.adapterKind, providerKind: row.providerKind, modelId: row.modelId, requiredEnvKeys: [] });
    if (!c.ok) return { ...defaultRoute(), source: "STRATEGY_REFUSED", reason: `capability row did not canonicalize: ${c.reason}` };
    return { binding: c.value, route: strategyPreference, source: "STRATEGY", reason: "fitness-gated strategy preference within the supported routes" };
  }

  // 3. No preference, no authority binding: the deployment default (first
  //    supported row) — never an invented route.
  return defaultRoute();
}

/** The deployment default route (the first supported capability row). */
export function defaultRoute() {
  const row = SPAWN_RUNTIME_CAPABILITIES[0];
  if (!row) return { binding: null, route: null, source: "DEFAULT", reason: "no supported capability rows" };
  const c = canonicalizeProviderBinding({ adapterKind: row.adapterKind, providerKind: row.providerKind, modelId: row.modelId, requiredEnvKeys: [] });
  const value = `${row.providerKind}/${row.modelId}`;
  return c.ok
    ? { binding: c.value, route: value, source: "DEFAULT", reason: "deployment default (no strategy preference)" }
    : { binding: null, route: value, source: "DEFAULT", reason: `default row did not canonicalize: ${c.reason}` };
}

/**
 * Narrow a preference to a route value, validating it fully. Returns null when
 * the value may not be activated (the caller records the refusal).
 */
export function validateRoutingPreference(value) {
  if (!ROUTE_VALUE_RE.test(value ?? "")) return { ok: false, reason: "not a canonical route value" };
  if (!isSupportedRouteValue(value)) return { ok: false, reason: "not a supported capability row" };
  return { ok: true, reason: null };
}
