// src/evolution/omp-attribution/contract.mjs
//
// AEGISFLOW_OMP_ATTRIBUTION_CONTRACT_DESIGN_1 §3.1/§3.4/§3.5 — the v1 contract.
//
// A DESCRIPTIVE observation of one native OMP session. It is NOT evolution
// evidence: `outcome` is fixed to UNVERIFIED in v1 (a clean session end is
// never a task success), and this module deliberately imports nothing from the
// strategy-memory / attribution-feed / trigger / promotion side of
// src/evolution/. test-omp-attribution-extractor.mjs enforces that
// transitively.
//
// The schema is CLOSED: exact key sets, bounded types, regex-limited strings.
// A value that does not fit is never kept verbatim.

import { createHash } from "node:crypto";
import { scanForSecrets } from "../../evidence/run-evidence-store.mjs";

export const OMP_OBSERVATION_SCHEMA = "aegisflow.omp-attribution/v1";
export const OMP_OBSERVATION_STATE_SCHEMA = "aegisflow.omp-attribution-state/v1";
export const EXTRACTOR_VERSION = "1";
export const EVIDENCE_CLASS = "OBSERVED_NATIVE_SESSION";
export const TASK_CLASS = "OMP_GENERAL";
export const OUTCOME_UNVERIFIED = "UNVERIFIED";
export const SOURCE_KIND = "omp-native-session";

export const LIMITS = Object.freeze({
  MAX_FILE_BYTES: 64 * 1024 * 1024,
  MAX_LINE_BYTES: 1024 * 1024,
  MAX_ENTRIES: 200_000,
  MAX_PARSE_ERRORS: 20,
  MAX_DISTINCT_MODELS: 8,
  MAX_DISTINCT_PROVIDERS: 8,
  MAX_DISTINCT_TOOLS: 64,
  MAX_DISTINCT_STOP_REASONS: 16,
  MAX_COUNTER: 1_000_000_000_000,
});

/** Strings that may be kept verbatim (model / provider / tool / stop reason / entry id). */
export const TOKEN_RE = /^[A-Za-z0-9._:/-]{1,96}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;
export const OBSERVATION_ID_RE = /^ompobs_[0-9a-f]{32}$/;

/**
 * Tool names are model/runtime output. Only names on this fixed list are kept
 * verbatim; everything else is counted in `other_count`. (Unknown names, e.g.
 * MCP tools, lose resolution but cannot carry a payload into the store.)
 */
export const KNOWN_TOOLS = Object.freeze(new Set([
  "read", "write", "edit", "bash", "grep", "glob", "lsp", "todo", "wait", "task", "hub",
  "web_search", "browser", "computer", "github", "fetch", "notebook", "ast_grep", "ast_edit",
  "find", "ls", "patch", "generate_image", "security_scan", "checkpoint", "rewind",
  "retain", "recall", "reflect", "memory_edit", "learn", "manage_skill",
]));

export const STRATEGY_DIMENSIONS = Object.freeze([
  "MODEL_ROUTING", "DECOMPOSITION", "CONTEXT_ALLOCATION",
  "RETRY_REPAIR", "FANOUT_PARALLELISM", "TOOL_SELECTION",
]);

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function observationIdFor(sessionId) {
  return `ompobs_${sha256Hex(`omp-session:${sessionId}`).slice(0, 32)}`;
}

/** Bounded non-negative integer, or null when the value is not a usable number. */
export function boundedCount(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.min(Math.floor(v), LIMITS.MAX_COUNTER);
}

// scanForSecrets() needs 16+ contiguous alphanumerics after `sk-`, so
// hyphen-segmented vendor keys slip through it. Token-typed fields (names that
// pass TOKEN_RE and would otherwise be kept verbatim) get two extra patterns.
const TOKEN_EXTRA_SECRET_RES = Object.freeze([
  /sk-[A-Za-z0-9_-]{16,}/,
  /[A-Za-z0-9_-]{40,}/, // a long unbroken run is a credential, not a model/tool name
]);

/** Sensitive check for strings that may be KEPT as tokens. */
export function looksSensitiveToken(s) {
  if (typeof s !== "string") return false;
  if (looksSensitive(s)) return true;
  return TOKEN_EXTRA_SECRET_RES.some((re) => re.test(s));
}

/**
 * Secret check on a RAW candidate string, before any sanitising. Returns true
 * when the string looks like a credential — the caller must then drop the
 * whole record, never a single field.
 */
export function looksSensitive(s) {
  return typeof s === "string" && !scanForSecrets(s).safe;
}

// ── closed-schema validation ────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function exactKeys(obj, keys, path, errors) {
  if (!isPlainObject(obj)) { errors.push(`${path}: not an object`); return false; }
  const have = Object.keys(obj).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
    errors.push(`${path}: keys ${JSON.stringify(have)} != ${JSON.stringify(want)}`);
    return false;
  }
  return true;
}

const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= LIMITS.MAX_COUNTER;
const isToken = (v) => typeof v === "string" && TOKEN_RE.test(v) && !looksSensitiveToken(v);
const isIso = (v) => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));

function checkTokenList(list, max, path, errors) {
  if (!Array.isArray(list) || list.length > max) { errors.push(`${path}: not a bounded array`); return; }
  for (const t of list) if (!isToken(t)) errors.push(`${path}: bad token`);
}

function checkCounterMap(map, max, path, errors) {
  if (!isPlainObject(map)) { errors.push(`${path}: not an object`); return; }
  const keys = Object.keys(map);
  if (keys.length > max) errors.push(`${path}: too many keys`);
  for (const k of keys) {
    if (!isToken(k)) errors.push(`${path}: bad key`);
    if (!isCount(map[k])) errors.push(`${path}: bad count`);
  }
}

function collectStrings(value, out) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) { out.push(k); collectStrings(v, out); }
  }
}

/**
 * Validate a v1 observation against the closed schema.
 * @returns {{ ok: boolean, errors: string[] }} error TEXT never echoes a value.
 */
export function validateObservation(o) {
  const errors = [];
  if (!exactKeys(o, [
    "schema", "observation_id", "evidence_class", "task_class", "outcome", "synthetic",
    "observed_at", "source", "cwd_ref", "model", "tools", "usage", "stop_reasons",
    "errors", "strategy_projection",
  ], "observation", errors)) return { ok: false, errors };

  if (o.schema !== OMP_OBSERVATION_SCHEMA) errors.push("schema: wrong");
  if (!OBSERVATION_ID_RE.test(String(o.observation_id))) errors.push("observation_id: bad");
  if (o.evidence_class !== EVIDENCE_CLASS) errors.push("evidence_class: wrong");
  if (o.task_class !== TASK_CLASS) errors.push("task_class: wrong");
  // v1: VERIFIED_* is not representable. A clean end is not a success.
  if (o.outcome !== OUTCOME_UNVERIFIED) errors.push("outcome: v1 allows only UNVERIFIED");
  if (typeof o.synthetic !== "boolean") errors.push("synthetic: not boolean");
  if (!isIso(o.observed_at)) errors.push("observed_at: bad");

  if (exactKeys(o.source, [
    "kind", "session_id", "file_sha256", "size_bytes", "tail_sha256",
    "first_entry_id", "last_entry_id", "entry_count", "extractor_version",
  ], "source", errors)) {
    const s = o.source;
    if (s.kind !== SOURCE_KIND) errors.push("source.kind: wrong");
    if (!UUID_RE.test(String(s.session_id))) errors.push("source.session_id: not a UUID");
    if (!HEX64_RE.test(String(s.file_sha256))) errors.push("source.file_sha256: bad");
    if (!HEX64_RE.test(String(s.tail_sha256))) errors.push("source.tail_sha256: bad");
    if (!isCount(s.size_bytes)) errors.push("source.size_bytes: bad");
    if (!isCount(s.entry_count)) errors.push("source.entry_count: bad");
    for (const k of ["first_entry_id", "last_entry_id"]) {
      if (s[k] !== null && !isToken(s[k])) errors.push(`source.${k}: bad`);
    }
    if (s.extractor_version !== EXTRACTOR_VERSION) errors.push("source.extractor_version: wrong");
    if (OBSERVATION_ID_RE.test(String(o.observation_id)) && UUID_RE.test(String(s.session_id))
      && o.observation_id !== observationIdFor(s.session_id)) {
      errors.push("observation_id: does not match session_id");
    }
  }

  if (exactKeys(o.cwd_ref, ["sha256", "allowlisted"], "cwd_ref", errors)) {
    if (!HEX64_RE.test(String(o.cwd_ref.sha256))) errors.push("cwd_ref.sha256: bad");
    if (o.cwd_ref.allowlisted !== true) errors.push("cwd_ref.allowlisted: must be true");
  }

  if (exactKeys(o.model, ["providers", "models", "other_count", "fallback_used"], "model", errors)) {
    checkTokenList(o.model.providers, LIMITS.MAX_DISTINCT_PROVIDERS, "model.providers", errors);
    checkTokenList(o.model.models, LIMITS.MAX_DISTINCT_MODELS, "model.models", errors);
    if (!isCount(o.model.other_count)) errors.push("model.other_count: bad");
    if (typeof o.model.fallback_used !== "boolean") errors.push("model.fallback_used: not boolean");
  }

  if (exactKeys(o.tools, ["counts", "other_count"], "tools", errors)) {
    checkCounterMap(o.tools.counts, LIMITS.MAX_DISTINCT_TOOLS, "tools.counts", errors);
    if (isPlainObject(o.tools.counts)) {
      for (const k of Object.keys(o.tools.counts)) if (!KNOWN_TOOLS.has(k)) errors.push("tools.counts: unknown tool name");
    }
    if (!isCount(o.tools.other_count)) errors.push("tools.other_count: bad");
  }

  if (exactKeys(o.usage, [
    "assistant_messages", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "reasoning_tokens", "total_tokens", "duration_ms",
  ], "usage", errors)) {
    for (const [k, v] of Object.entries(o.usage)) if (!isCount(v)) errors.push(`usage.${k}: bad`);
  }

  checkCounterMap(o.stop_reasons, LIMITS.MAX_DISTINCT_STOP_REASONS, "stop_reasons", errors);

  if (exactKeys(o.errors, ["tool_results", "tool_result_errors"], "errors", errors)) {
    if (!isCount(o.errors.tool_results)) errors.push("errors.tool_results: bad");
    if (!isCount(o.errors.tool_result_errors)) errors.push("errors.tool_result_errors: bad");
  }

  if (exactKeys(o.strategy_projection, STRATEGY_DIMENSIONS, "strategy_projection", errors)) {
    for (const d of STRATEGY_DIMENSIONS) {
      const v = o.strategy_projection[d];
      if (v !== null && !isToken(v)) errors.push(`strategy_projection.${d}: bad`);
    }
  }

  // Defence in depth: ANY string anywhere (keys included) that looks like a
  // credential invalidates the whole record.
  const strings = [];
  collectStrings(o, strings);
  if (strings.some(looksSensitive)) errors.push("sensitive_pattern");

  return { ok: errors.length === 0, errors };
}

/**
 * Output-safety gate for anything the CLI prints or persists besides a
 * validated observation (dispositions, state records, summaries).
 */
export function assertOutputSafe(value) {
  const strings = [];
  collectStrings(value, strings);
  if (strings.some(looksSensitive)) {
    const e = new Error("sensitive pattern in output");
    e.code = "OMP_ATTRIBUTION_OUTPUT_SENSITIVE";
    throw e;
  }
  return value;
}
