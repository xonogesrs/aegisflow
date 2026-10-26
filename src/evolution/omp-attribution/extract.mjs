// src/evolution/omp-attribution/extract.mjs
//
// AEGISFLOW_OMP_ATTRIBUTION_CONTRACT_DESIGN_1 §3.2/§3.4 — read ONE native OMP
// session JSONL safely and project it onto the closed v1 observation.
//
// Read-only. No network. Never follows a symlink, never leaves the sessions
// root, never keeps a free-text field. A raw value that looks like a credential
// drops the WHOLE record (`sensitive_pattern`), it is never "cleaned".

import {
  constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readdirSync,
  readSync, realpathSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  EVIDENCE_CLASS, EXTRACTOR_VERSION, LIMITS, OUTCOME_UNVERIFIED, SOURCE_KIND, STRATEGY_DIMENSIONS,
  TASK_CLASS, TOKEN_RE, UUID_RE, OMP_OBSERVATION_SCHEMA, KNOWN_TOOLS, boundedCount, looksSensitive,
  looksSensitiveToken, CWD_REF_ALG, observationIdFor, sha256Hex, validateObservation,
} from "./contract.mjs";

export const TAIL_BYTES = 4096;
export const HEAD_BYTES = 65536;
export const SESSION_FILE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const SLUG_RE = /^[A-Za-z0-9._-]{1,200}$/;
export const LSOF_PATH = "/usr/sbin/lsof";

// ── path policy ─────────────────────────────────────────────────────────────

/** macOS: /tmp and /var are symlinks into /private. Normalise lexically so a
 *  deny rule on /private/tmp also catches a header that says /tmp. */
export function normalizeFsPath(p) {
  const abs = resolve(String(p));
  for (const [from, to] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]]) {
    if (abs === from || abs.startsWith(from + sep)) return to + abs.slice(from.length);
  }
  return abs;
}

export function pathIsUnder(path, root) {
  const p = normalizeFsPath(path);
  const r = normalizeFsPath(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Header `cwd` decision. Deny wins over allow. No filesystem access. */
export function cwdDecision({ cwd, allowRoots, denyRoots }) {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 1024 || cwd.includes("\0")) {
    return { ok: false, reason: "cwd_invalid" };
  }
  if ((denyRoots ?? []).some((d) => pathIsUnder(cwd, d))) return { ok: false, reason: "cwd_denied" };
  if (!(allowRoots ?? []).some((a) => pathIsUnder(cwd, a))) return { ok: false, reason: "cwd_not_allowlisted" };
  return { ok: true, reason: null };
}

// ── lsof (conservative) ─────────────────────────────────────────────────────

/**
 * `lsof <file>` exits 1 with EMPTY stdout and EMPTY stderr when nothing holds
 * the file — the one and only "not held" answer. Everything else (exit 0,
 * stderr noise, a spawn error, a timeout, a signal, an odd status) is "held" or
 * "unknown", and both mean: do not process this file.
 */
export function classifyLsofResult(r) {
  if (!r || r.error || r.signal) return "unknown";
  if (r.status === 1 && String(r.stdout ?? "") === "" && String(r.stderr ?? "") === "") return "not_held";
  if (r.status === 0 && /^p\d+/m.test(String(r.stdout ?? ""))) return "held";
  return "unknown";
}

export function defaultLsof(path) {
  const r = spawnSync(LSOF_PATH, ["-F", "p", "--", path], { encoding: "utf8", timeout: 5000, maxBuffer: 1 << 20 });
  return classifyLsofResult(r);
}

// ── safe observation of a file ──────────────────────────────────────────────

const EXCLUDE = (reason) => ({ ok: false, reason });

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Observe a candidate file WITHOUT trusting its path:
 * lstat (no symlink, regular, nlink 1, size cap) → realpath stays under the
 * sessions root → open O_NOFOLLOW → fstat must be the same dev/ino → read the
 * tail → fstat again must be unchanged.
 * `fault` is a test seam fired right after open.
 */
export function observeSessionFile(path, { sessionsRoot, fault = null }) {
  let realRoot;
  try { realRoot = realpathSync(sessionsRoot); } catch { return EXCLUDE("sessions_root_unreadable"); }
  let lst;
  try { lst = lstatSync(path, { bigint: true }); } catch { return EXCLUDE("stat_failed"); }
  if (lst.isSymbolicLink()) return EXCLUDE("symlink");
  if (!lst.isFile()) return EXCLUDE("not_regular_file");
  if (lst.nlink !== 1n) return EXCLUDE("hardlink");
  if (lst.size > BigInt(LIMITS.MAX_FILE_BYTES)) return EXCLUDE("too_large");
  let real;
  try { real = realpathSync(path); } catch { return EXCLUDE("stat_failed"); }
  if (!real.startsWith(realRoot + sep)) return EXCLUDE("path_escape");

  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch { return EXCLUDE("open_failed"); }
  try {
    if (fault) fault("after_open", path);
    const a = fstatSync(fd, { bigint: true });
    if (a.nlink !== 1n) return EXCLUDE("hardlink"); // a link made after lstat
    if (!sameFile(a, lst) || a.size !== lst.size) return EXCLUDE("changed_during_read");
    const size = Number(a.size);
    const tailLen = Math.min(TAIL_BYTES, size);
    const tail = Buffer.alloc(tailLen);
    if (tailLen > 0) readSync(fd, tail, 0, tailLen, size - tailLen);
    const headLen = Math.min(HEAD_BYTES, size);
    const head = Buffer.alloc(headLen);
    if (headLen > 0) readSync(fd, head, 0, headLen, 0);
    const b = fstatSync(fd, { bigint: true });
    if (b.size !== a.size || b.mtimeNs !== a.mtimeNs) return EXCLUDE("changed_during_read");
    return {
      ok: true,
      head,
      identity: {
        dev: String(a.dev), ino: String(a.ino), size,
        mtime_ns: String(a.mtimeNs), tail_sha256: sha256Hex(tail),
      },
    };
  } finally {
    closeSync(fd);
  }
}

export const HEADER_SCAN_LINES = 8;

/**
 * Find the `session` header among the first few COMPLETE lines of the head
 * bytes (real OMP files start with a `title` entry; the header is line 2), so a
 * session of a non-allowlisted cwd is excluded BEFORE anything about it is
 * persisted. Only the header's id and cwd are returned.
 * @returns {{ id: string|null, cwd: string|null }}
 */
export function peekHeader(head) {
  let start = 0;
  for (let n = 0; n < HEADER_SCAN_LINES; n++) {
    const nl = head.indexOf(0x0a, start);
    if (nl < 0) break; // an incomplete (or oversized) line is never parsed
    try {
      const e = JSON.parse(head.subarray(start, nl).toString("utf8"));
      if (isObj(e) && e.type === "session") {
        return { id: typeof e.id === "string" ? e.id : null, cwd: typeof e.cwd === "string" ? e.cwd : null };
      }
    } catch { /* not JSON: skip this line */ }
    start = nl + 1;
  }
  return { id: null, cwd: null };
}

/** Read the WHOLE file, verifying it still matches the earlier observation. */
export function readSessionBytes(path, { sessionsRoot, identity, fault = null }) {
  const pre = observeSessionFile(path, { sessionsRoot });
  if (!pre.ok) return pre;
  if (!identityEquals(pre.identity, identity)) return EXCLUDE("changed_during_read");
  let fd;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { return EXCLUDE("open_failed"); }
  try {
    if (fault) fault("after_open_full", path);
    const a = fstatSync(fd, { bigint: true });
    if (a.nlink !== 1n) return EXCLUDE("hardlink");
    if (String(a.dev) !== identity.dev || String(a.ino) !== identity.ino) return EXCLUDE("changed_during_read");
    const buf = Buffer.alloc(Number(a.size));
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    if (fault) fault("after_read", path);
    const b = fstatSync(fd, { bigint: true });
    if (off !== buf.length || b.size !== a.size || b.mtimeNs !== a.mtimeNs || String(b.mtimeNs) !== identity.mtime_ns) {
      return EXCLUDE("changed_during_read");
    }
    return { ok: true, bytes: buf };
  } finally {
    closeSync(fd);
  }
}

export function identityEquals(a, b) {
  return Boolean(a && b)
    && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtime_ns === b.mtime_ns && a.tail_sha256 === b.tail_sha256;
}

/** Top-level `<root>/<slug>/<ts>_<uuid>.jsonl` only; subagent dirs, symlinks
 *  and anything oddly named are never returned. */
export function discoverSessionFiles(sessionsRoot, onlySlugs = null) {
  const out = [];
  let slugs;
  try { slugs = readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return out; }
  for (const slug of slugs) {
    if (!slug.isDirectory() || slug.isSymbolicLink() || !SLUG_RE.test(slug.name)) continue;
    // When the operator names slug directories, no OTHER directory is opened.
    if (Array.isArray(onlySlugs) && !onlySlugs.includes(slug.name)) continue;
    const dir = join(sessionsRoot, slug.name);
    let files;
    try { files = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (f.isFile() && !f.isSymbolicLink() && SESSION_FILE_RE.test(f.name)) out.push(join(dir, f.name));
    }
  }
  return out.sort();
}

// ── parse + project ─────────────────────────────────────────────────────────

export function parseSessionBytes(bytes) {
  const text = bytes.toString("utf8");
  const entries = [];
  let parseErrors = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    if (Buffer.byteLength(line) > LIMITS.MAX_LINE_BYTES) return { ok: false, reason: "line_too_long" };
    try {
      entries.push(JSON.parse(line));
    } catch {
      parseErrors += 1;
      if (parseErrors > LIMITS.MAX_PARSE_ERRORS) return { ok: false, reason: "parse_errors" };
    }
    if (entries.length > LIMITS.MAX_ENTRIES) return { ok: false, reason: "too_many_entries" };
  }
  return { ok: true, entries, parseErrors };
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

class Counter {
  constructor(max, allow = null) { this.max = max; this.allow = allow; this.map = new Map(); this.other = 0; }
  add(raw, n = 1) {
    if (typeof raw !== "string" || !TOKEN_RE.test(raw)) { this.other += n; return; }
    if (this.allow && !this.allow.has(raw)) { this.other += n; return; }
    if (!this.map.has(raw) && this.map.size >= this.max) { this.other += n; return; }
    this.map.set(raw, (this.map.get(raw) ?? 0) + n);
  }
  keys() { return [...this.map.keys()]; }
}

function sum(into, key, v) {
  const n = boundedCount(v);
  if (n !== null) into[key] = Math.min(into[key] + n, LIMITS.MAX_COUNTER);
}

/**
 * Project parsed entries onto the closed v1 observation.
 * @returns {{ ok: true, observation: object } | { ok: false, reason: string }}
 */
export function buildObservation({ entries, fileInfo, nameUuid, allowRoots, denyRoots, nowIso, cwdKey, synthetic = false }) {
  if (!cwdKey || typeof cwdKey.mac !== "function" || typeof cwdKey.keyId !== "string") return EXCLUDE("cwd_key_missing");
  const header = entries.find((e) => isObj(e) && e.type === "session");
  if (!header) return EXCLUDE("no_session_header");
  if (typeof header.id !== "string" || !UUID_RE.test(header.id) || header.id !== nameUuid) {
    return EXCLUDE("session_id_mismatch");
  }
  if (looksSensitive(header.cwd)) return EXCLUDE("sensitive_pattern");
  const cwd = cwdDecision({ cwd: header.cwd, allowRoots, denyRoots });
  if (!cwd.ok) return EXCLUDE(cwd.reason);

  const providers = new Counter(LIMITS.MAX_DISTINCT_PROVIDERS);
  const models = new Counter(LIMITS.MAX_DISTINCT_MODELS);
  const modelUse = new Map();
  const tools = new Counter(LIMITS.MAX_DISTINCT_TOOLS, KNOWN_TOOLS);
  const stops = new Counter(LIMITS.MAX_DISTINCT_STOP_REASONS);
  const usage = {
    assistant_messages: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    cache_write_tokens: 0, reasoning_tokens: 0, total_tokens: 0, duration_ms: 0,
  };
  const errs = { tool_results: 0, tool_result_errors: 0 };
  let fallbackUsed = false;
  let firstId = null;
  let lastId = null;
  let sensitive = false;

  const check = (s) => { if (looksSensitiveToken(s)) sensitive = true; return s; };

  for (const e of entries) {
    if (!isObj(e)) continue;
    if (typeof e.id === "string") {
      check(e.id);
      if (TOKEN_RE.test(e.id)) { if (firstId === null) firstId = e.id; lastId = e.id; }
    }
    if (e.type === "model_change") {
      models.add(check(e.model));
      if (e.resolvedModelIsFallback === true) fallbackUsed = true;
      continue;
    }
    if (e.type !== "message" || !isObj(e.message)) continue;
    const m = e.message;
    if (m.role === "toolResult") {
      errs.tool_results += 1;
      if (m.isError === true) errs.tool_result_errors += 1;
    } else if (m.role === "assistant") {
      usage.assistant_messages += 1;
      providers.add(check(m.provider));
      models.add(check(m.model));
      stops.add(check(m.stopReason));
      if (typeof m.model === "string" && TOKEN_RE.test(m.model)) {
        const key = typeof m.provider === "string" && TOKEN_RE.test(m.provider) ? `${m.provider}/${m.model}` : m.model;
        modelUse.set(key, (modelUse.get(key) ?? 0) + 1);
      }
      const u = isObj(m.usage) ? m.usage : {};
      sum(usage, "input_tokens", u.input);
      sum(usage, "output_tokens", u.output);
      sum(usage, "cache_read_tokens", u.cacheRead);
      sum(usage, "cache_write_tokens", u.cacheWrite);
      sum(usage, "reasoning_tokens", u.reasoningTokens);
      sum(usage, "total_tokens", u.totalTokens);
      if (typeof m.duration === "number" && Number.isFinite(m.duration) && m.duration >= 0) {
        sum(usage, "duration_ms", Math.round(m.duration));
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) if (isObj(b) && b.type === "toolCall") tools.add(check(b.name));
      }
    }
  }
  if (sensitive) return EXCLUDE("sensitive_pattern");

  let topModel = null;
  let topN = 0;
  for (const [k, n] of [...modelUse.entries()].sort()) if (n > topN) { topModel = k; topN = n; }
  const toolNames = tools.keys().sort();

  const strategy = Object.fromEntries(STRATEGY_DIMENSIONS.map((d) => [d, null]));
  if (topModel && TOKEN_RE.test(topModel)) strategy.MODEL_ROUTING = topModel;
  if (toolNames.length > 0) strategy.TOOL_SELECTION = `toolset_${sha256Hex(toolNames.join("\n")).slice(0, 12)}`;

  const observation = {
    schema: OMP_OBSERVATION_SCHEMA,
    observation_id: observationIdFor(header.id),
    evidence_class: EVIDENCE_CLASS,
    task_class: TASK_CLASS,
    outcome: OUTCOME_UNVERIFIED,
    synthetic: Boolean(synthetic),
    observed_at: nowIso,
    source: {
      kind: SOURCE_KIND,
      session_id: header.id,
      file_sha256: fileInfo.file_sha256,
      size_bytes: fileInfo.size_bytes,
      tail_sha256: fileInfo.tail_sha256,
      first_entry_id: firstId,
      last_entry_id: lastId,
      entry_count: entries.length,
      extractor_version: EXTRACTOR_VERSION,
    },
    cwd_ref: { alg: CWD_REF_ALG, key_id: cwdKey.keyId, mac: cwdKey.mac(normalizeFsPath(header.cwd)), allowlisted: true },
    model: {
      providers: providers.keys().sort(),
      models: models.keys().sort(),
      other_count: providers.other + models.other,
      fallback_used: fallbackUsed,
    },
    tools: { counts: Object.fromEntries([...tools.map.entries()].sort()), other_count: tools.other },
    usage,
    stop_reasons: Object.fromEntries([...stops.map.entries()].sort()),
    errors: errs,
    strategy_projection: strategy,
  };
  const v = validateObservation(observation);
  if (!v.ok) return EXCLUDE(v.errors.includes("sensitive_pattern") ? "sensitive_pattern" : "schema_invalid");
  return { ok: true, observation };
}

/** Prefix check used after a session was recorded: did it only grow? */
export function prefixDigest(bytes, length) {
  return sha256Hex(bytes.subarray(0, length));
}
