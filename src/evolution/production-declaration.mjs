// src/evolution/production-declaration.mjs
//
// AUTOLOOP_AGENT_STRATEGY_EVIDENCE_FEED_REPAIR_1 — Section J.2:
// THE production configuration declaration seam.
//
// Before this module the only production surfaces for the evolution
// execution inputs were (a) an in-process `runnerOpts.evolution` object and
// (b) the `AUTOLOOP_EVOLUTION_*` environment. A deployment could therefore
// declare `storeRoot` / `checkpointRoot` / `repoRoot` / `taskClass` only by
// threading an object through its call site, and `strategyBaselineValues` had
// NO production surface at all (internal config object only). The audit also
// found that the practical workaround — hardcoding a machine-specific absolute
// path in source — is exactly what a declaration seam must make unnecessary.
//
// This module defines a DURABLE, bounded declaration record:
//
//   {
//     "schema": "autoloop.evolution-production-declaration/v1",
//     "declared_by": "operator:...",
//     "storeRoot": "...", "checkpointRoot": "...", "repoRoot": "...",
//     "taskClass": "...",
//     "strategyBaselineValues": { "MODEL_ROUTING": "provider/model", ... },
//     "strategyDimensions": ["MODEL_ROUTING", ...],          // optional
//     "reviewerIdentity": "...", "promptProfile": "...",     // optional
//     "canaryWindowMs": 3600000, "thresholds": { ... },      // optional
//     "synthetic": false                                     // optional
//   }
//
// WHERE the file lives is a DEPLOYMENT decision, never a source constant: the
// path is supplied per deployment (`AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG`, or
// `runnerOpts.evolution.deploymentConfig`). No machine-specific absolute path
// is burned into this repository.
//
// Precedence (highest first), resolved in production-consumer.mjs:
//   1. explicit `runnerOpts.evolution` fields (a caller that already knows)
//   2. the individual `AUTOLOOP_EVOLUTION_*` environment variables
//   3. this declaration record (the deployment default)
//
// Hard rules: bounded keys/values only; a malformed declaration is IGNORED
// (fail-open — the deployment keeps its environment/object inputs) but the
// error is surfaced on the resolved config and in the operator report, never
// swallowed.

import { existsSync, readFileSync } from "node:fs";

import { STRATEGY_DIMENSIONS, canonicalTaskClass } from "./attribution.mjs";

export const EVOLUTION_DECLARATION_SCHEMA = "autoloop.evolution-production-declaration/v1";
export const EVOLUTION_DECLARATION_ENV = "AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG";

/** The bounded key set of a declaration record. Anything else is an error. */
export const EVOLUTION_DECLARATION_KEYS = Object.freeze([
  "schema", "declared_by", "declared_at",
  "storeRoot", "checkpointRoot", "repoRoot", "taskClass",
  "strategyBaselineValues", "strategyDimensions",
  "reviewerIdentity", "promptProfile", "canaryWindowMs", "thresholds", "synthetic",
]);

/** The keys that carry a bounded path/token string. */
export const EVOLUTION_DECLARATION_STRING_KEYS = Object.freeze([
  "storeRoot", "checkpointRoot", "repoRoot", "taskClass", "reviewerIdentity", "promptProfile", "declared_by", "declared_at",
]);

const MAX_STRING = 4096;
const VALUE_TOKEN_RE = /^[A-Za-z0-9_./:@-]{1,160}$/;

function isBoundedString(v) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= MAX_STRING && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
}

/**
 * Parse `strategyBaselineValues` from EITHER a plain object OR a JSON string
 * (the environment form). Declared per dimension: the strategy value each task
 * class is CURRENTLY running under, so the plan producer's baseline is the
 * deployment's truth rather than a "most-observed" heuristic.
 *
 * @returns {{ values: object|null, error: string|null }}
 */
export function parseStrategyBaselineValues(value) {
  if (value === null || value === undefined) return { values: null, error: null };
  let obj = value;
  if (typeof value === "string") {
    const t = value.trim();
    if (t.length === 0) return { values: null, error: null };
    try { obj = JSON.parse(t); } catch { return { values: null, error: "not valid JSON" }; }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { values: null, error: "must be an object" };
  const out = {};
  for (const [dim, val] of Object.entries(obj)) {
    if (!STRATEGY_DIMENSIONS.includes(dim)) return { values: null, error: `unknown strategy dimension: ${dim}` };
    if (typeof val !== "string" || !VALUE_TOKEN_RE.test(val)) return { values: null, error: `invalid strategy value for ${dim}` };
    out[dim] = val;
  }
  return { values: Object.keys(out).length > 0 ? out : null, error: null };
}

/**
 * Structural validation of a declaration record. Mirrors the repo's minimal
 * validator convention: bounded keys, bounded values, bounded types only.
 * @returns {string[]} errors (empty ⇒ valid)
 */
export function validateEvolutionDeclaration(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["not_object"];
  for (const k of Object.keys(record)) if (!EVOLUTION_DECLARATION_KEYS.includes(k)) errors.push(`unknown_${k}`);
  if (record.schema !== undefined && record.schema !== EVOLUTION_DECLARATION_SCHEMA) errors.push("schema_invalid");
  for (const k of EVOLUTION_DECLARATION_STRING_KEYS) {
    if (record[k] === undefined) continue;
    if (!isBoundedString(record[k])) errors.push(`invalid_${k}`);
  }
  if (record.strategyBaselineValues !== undefined) {
    const r = parseStrategyBaselineValues(record.strategyBaselineValues);
    if (r.error) errors.push(`strategyBaselineValues_${r.error}`);
  }
  if (record.strategyDimensions !== undefined) {
    if (!Array.isArray(record.strategyDimensions) || record.strategyDimensions.length === 0
      || !record.strategyDimensions.every((d) => STRATEGY_DIMENSIONS.includes(d))) errors.push("strategyDimensions_invalid");
  }
  if (record.canaryWindowMs !== undefined && (!Number.isFinite(record.canaryWindowMs) || record.canaryWindowMs <= 0)) errors.push("canaryWindowMs_invalid");
  if (record.synthetic !== undefined && typeof record.synthetic !== "boolean") errors.push("synthetic_invalid");
  if (record.thresholds !== undefined && (typeof record.thresholds !== "object" || record.thresholds === null || Array.isArray(record.thresholds))) errors.push("thresholds_invalid");
  return errors;
}

/**
 * Read the deployment's evolution declaration. TOTAL — never throws:
 * absent path ⇒ `provided:false`; unreadable/malformed ⇒ `declaration:null`
 * with the errors recorded so the caller (and the operator report) can SEE
 * the misconfiguration instead of silently falling back.
 *
 * @param {object} p
 * @param {string|null} [p.path] — explicit path (wins over the env var)
 * @param {object} [p.env]
 */
export function readEvolutionProductionDeclaration({ path = null, env = process.env } = {}) {
  const chosen = (typeof path === "string" && path.trim().length > 0)
    ? path.trim()
    : (typeof env?.[EVOLUTION_DECLARATION_ENV] === "string" && env[EVOLUTION_DECLARATION_ENV].trim().length > 0
      ? env[EVOLUTION_DECLARATION_ENV].trim()
      : null);
  if (!chosen) return { provided: false, path: null, source: null, declaration: null, errors: [] };
  if (!existsSync(chosen)) {
    return { provided: true, path: chosen, source: "file", declaration: null, errors: [`unreadable: no declaration at ${chosen}`] };
  }
  let record;
  try {
    record = JSON.parse(readFileSync(chosen, "utf8"));
  } catch (e) {
    return { provided: true, path: chosen, source: "file", declaration: null, errors: [`unparsable: ${String(e?.message ?? e).slice(0, 160)}`] };
  }
  const errors = validateEvolutionDeclaration(record);
  if (errors.length > 0) return { provided: true, path: chosen, source: "file", declaration: null, errors };
  return { provided: true, path: chosen, source: "file", declaration: record, errors: [] };
}

/** The bounded declaration defaults a resolver may fall back to (per key). */
export function declarationInputs(declaration) {
  if (!declaration) return {};
  const out = {};
  for (const k of EVOLUTION_DECLARATION_STRING_KEYS) {
    if (typeof declaration[k] === "string" && declaration[k].trim().length > 0) {
      out[k] = k === "taskClass" ? canonicalTaskClass(declaration[k]) : declaration[k].trim();
    }
  }
  const baseline = parseStrategyBaselineValues(declaration.strategyBaselineValues);
  if (baseline.values) out.strategyBaselineValues = baseline.values;
  if (Array.isArray(declaration.strategyDimensions)) out.strategyDimensions = [...declaration.strategyDimensions];
  if (Number.isFinite(declaration.canaryWindowMs)) out.canaryWindowMs = declaration.canaryWindowMs;
  if (declaration.thresholds && typeof declaration.thresholds === "object") out.thresholds = declaration.thresholds;
  if (declaration.synthetic === true) out.synthetic = true;
  return out;
}
