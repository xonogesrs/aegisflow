// src/evidence/run-evidence-store.mjs
//
// C3 — AutoLoop durable evidence store.
//
// Responsibilities:
//  - Owner-only durable execution directory（<root>/<executionId>/）.
//  - Append-only evidence journal with an explicit hash chain
//    （previous_event_sha256 → event_sha256）.
//  - Secret-safe artifact writes（bounded free text, pattern scan,
//    control-character rejection, truncation metadata）.
//
// Reuses the sealed C2D primitives（fs-atomic writeExclusiveCreate /
// resolveSafeRoot / assertInsideRoot / assertNotSymlink, execution-id）as the
// atomic-write and path-boundary authority. No second checksum/atomicity/
// symlink model is introduced.
//
// The journal is the "what happened" record（append-only, never rewritten）.
// Checkpoint CURRENT.json（what may safely resume from）lives in
// checkpoint-bridge.mjs on top of the sealed C2D checkpoint store.

import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  C2dHoldError, HOLD, sha256Hex, ensureDir0700, assertNotSymlink,
  assertInsideRoot, resolveSafeRoot, writeExclusiveCreate,
  readExact, listDirSafe,
} from "../c2d/fs-atomic.mjs";
import { resolveExecDir, initExecutionDir } from "../c2d/checkpoint-store.mjs";

export const EVIDENCE_FORMAT_VERSION = "1.0.0";
export const JOURNAL_FORMAT_VERSION = "1.0.0";
export const JOURNAL_GENESIS = "genesis";
export const DEFAULT_MAX_FREE_TEXT_BYTES = 64 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;

// Secret-pattern scan（bounded classification only; never the matched text）.
export const SECRET_PATTERNS = Object.freeze([
  { name: "sk_key", re: /sk-[A-Za-z0-9]{16,}/ },
  { name: "github_token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "pem_private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer_auth", re: /Authorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._-]{16,}/i },
  { name: "env_key_assignment", re: /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[:=]\s*["'][A-Za-z0-9._-]{16,}/ },
]);

export class EvidenceHoldError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.name = "EvidenceHoldError";
  }
}

/** Deterministic canonical JSON（sorted keys）— journal payload / fingerprint basis. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

export function sha256Text(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * Scan a free-text string for secret patterns.
 * @returns {{safe: boolean, matches: string[]}} matched pattern NAMES only.
 */
export function scanForSecrets(text) {
  if (typeof text !== "string") return { safe: true, matches: [] };
  const matches = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) matches.push(name);
  }
  return { safe: matches.length === 0, matches };
}

/** Byte-aware truncation with explicit metadata（never silently cuts）. */
export function truncateFreeText(text, { maxBytes = DEFAULT_MAX_FREE_TEXT_BYTES } = {}) {
  if (typeof text !== "string") return { text: String(text), truncated: false, original_bytes: 0, max_bytes: maxBytes };
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return { text, truncated: false, original_bytes: buf.length, max_bytes: maxBytes };
  }
  return {
    text: buf.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
    original_bytes: buf.length,
    max_bytes: maxBytes,
  };
}

/** Reject control characters（except \n \t）— fail-closed on unprintable junk. */
export function hasUnsafeControlChars(text) {
  if (typeof text !== "string") return false;
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}

/**
 * Redact one free-text value for durable storage.
 * Throws EvidenceHoldError(DURABLE_EVIDENCE_SECRET_RISK) when a secret
 * pattern is detected — the suspect content itself is never written.
 */
export function redactFreeText(text, { maxBytes = DEFAULT_MAX_FREE_TEXT_BYTES } = {}) {
  if (typeof text !== "string") {
    return { value: text, metadata: { type: typeof text, truncated: false } };
  }
  if (hasUnsafeControlChars(text)) {
    throw new EvidenceHoldError("DURABLE_EVIDENCE_SECRET_RISK", "free text contains control characters");
  }
  const scan = scanForSecrets(text);
  if (!scan.safe) {
    throw new EvidenceHoldError("DURABLE_EVIDENCE_SECRET_RISK", `free text matched secret pattern(s): ${scan.matches.join(",")}`);
  }
  const t = truncateFreeText(text, { maxBytes });
  return {
    value: t.text,
    metadata: {
      type: "string",
      truncated: t.truncated,
      original_bytes: t.original_bytes,
      max_bytes: t.max_bytes,
    },
  };
}

/**
 * Recursively redact an object for durable storage: every string field goes
 * through redactFreeText; the result is wrapped with redaction metadata.
 * Arrays/objects are traversed. Non-string leaves are kept as-is.
 * `metadata.truncated` is true if ANY nested string was truncated.
 */
export function redactObject(value, { maxBytes = DEFAULT_MAX_FREE_TEXT_BYTES } = {}) {
  if (value === null || value === undefined) return { value, metadata: { truncated: false } };
  if (typeof value === "string") return redactFreeText(value, { maxBytes });
  if (Array.isArray(value)) {
    let truncated = false;
    const items = [];
    for (const item of value) {
      const r = redactObject(item, { maxBytes });
      if (r.metadata?.truncated) truncated = true;
      items.push(r.value);
    }
    return { value: items, metadata: { truncated } };
  }
  if (typeof value === "object") {
    let truncated = false;
    const out = {};
    for (const k of Object.keys(value)) {
      const r = redactObject(value[k], { maxBytes });
      if (r.metadata?.truncated) truncated = true;
      out[k] = r.value;
    }
    return { value: out, metadata: { truncated } };
  }
  return { value, metadata: { truncated: false } };
}

function padSeq(n) {
  return String(n).padStart(12, "0");
}

export function journalFileName(seq) {
  return `${padSeq(seq)}.json`;
}

export function journalDir(execDir) {
  return join(execDir, "journal");
}

export function artifactsDir(execDir) {
  return join(execDir, "artifacts");
}

export function phasesDir(execDir) {
  return join(execDir, "phases");
}

export class RunEvidenceStore {
  /**
   * @param {object} opts
   * @param {string} opts.root — checkpoint/evidence root（absolute, outside repo）
   * @param {string} opts.executionId — exec_<32hex>
   * @param {string} opts.chainId
   * @param {string} opts.checkpointId
   * @param {string} [opts.repoRoot] — repository root; when provided the root is
   *   validated to be outside the repository tree.
   */
  constructor({ root, executionId, chainId, checkpointId, repoRoot }) {
    this.root = root;
    this.executionId = executionId;
    this.chainId = chainId;
    this.checkpointId = checkpointId;
    this.repoRoot = repoRoot || null;
    this.execDir = null;
    this._journalHead = { seq: 0, sha256: JOURNAL_GENESIS };
    this._journalCache = [];
  }

  init() {
    assertValidEvidenceRoot(this.root, this.repoRoot);
    const execDir = initExecutionDir(this.root, this.executionId);
    ensureDir0700(journalDir(execDir));
    ensureDir0700(artifactsDir(execDir));
    ensureDir0700(phasesDir(execDir));
    this.execDir = execDir;
    // Resume/continuation: load the existing journal head so new events append
    // after the last durable sequence（never rewriting sequence 1）.
    const files = listDirSafe(journalDir(execDir)).filter((f) => f.endsWith(".json")).sort();
    if (files.length > 0) {
      const last = files[files.length - 1];
      const seq = parseInt(last.replace(/\.json$/, ""), 10);
      const { event } = this.readEvent(seq);
      this._journalHead = { seq, sha256: event.event_sha256 };
    }
    return execDir;
  }

  get journalHead() {
    return { ...this._journalHead };
  }

  /** Append one journal event（exclusive create; sequence never rewritten）. */
  appendEvent({ event_type, stage, phase_id, attempt, status, payload = {} }) {
    if (!this.execDir) throw new EvidenceHoldError("EVIDENCE_STORE_NOT_INITIALIZED", "init() first");
    const seq = this._journalHead.seq + 1;
    const now = new Date().toISOString();
    // Secret-safe: redact the payload; a secret pattern fails closed（the
    // suspect content is never written）and over-budget free text is stored
    // only with explicit truncation metadata.
    const redacted = redactObject(payload, { maxBytes: DEFAULT_MAX_FREE_TEXT_BYTES });
    const event = {
      format_version: JOURNAL_FORMAT_VERSION,
      sequence: seq,
      event_id: `evt_${seq}_${sha256Text(`${this.executionId}:${seq}:${now}`).slice(0, 16)}`,
      execution_id: this.executionId,
      chain_id: this.chainId,
      timestamp: now,
      event_type,
      stage: stage ?? null,
      phase_id: phase_id ?? null,
      attempt: attempt ?? null,
      status: status ?? null,
      previous_event_sha256: this._journalHead.sha256,
      payload_sha256: sha256Text(canonicalJson(redacted.value)),
      redaction: { truncated: redacted.metadata.truncated === true },
      payload: redacted.value,
    };
    // event_sha256 hashes the serialized event WITHOUT its own hash field,
    // matching verifyJournal's recomputation.
    event.event_sha256 = sha256Text(canonicalJson({ ...event, event_sha256: undefined }) + "\n");
    const storedBody = canonicalJson(event) + "\n";
    const path = join(journalDir(this.execDir), journalFileName(seq));
    try {
      writeExclusiveCreate(path, storedBody);
    } catch (e) {
      if (e instanceof C2dHoldError && e.code === HOLD.JOURNAL_OUT_OF_ORDER) {
        throw new EvidenceHoldError("JOURNAL_SEQUENCE_CONFLICT", `journal sequence ${seq} already exists`);
      }
      throw e;
    }
    this._journalHead = { seq, sha256: event.event_sha256 };
    this._journalCache.push({ seq, event, body: storedBody });
    return event;
  }

  /** Read one journal event by sequence. */
  readEvent(seq) {
    if (!this.execDir) throw new EvidenceHoldError("EVIDENCE_STORE_NOT_INITIALIZED", "init() first");
    const path = join(journalDir(this.execDir), journalFileName(seq));
    try {
      const raw = readExact(path).toString("utf8");
      const event = JSON.parse(raw);
      if (event.sequence !== seq) throw new EvidenceHoldError("JOURNAL_INTEGRITY_FAILURE", `sequence mismatch in ${path}`);
      return { event, raw };
    } catch (e) {
      if (e instanceof EvidenceHoldError) throw e;
      throw new EvidenceHoldError("JOURNAL_INTEGRITY_FAILURE", `unreadable journal ${path}: ${e?.message}`);
    }
  }

  /**
   * Verify the full journal: monotonic sequence from 1, no gaps, hash chain
   * continuity, per-event integrity. Returns { ok, head, count }.
   */
  verifyJournal() {
    if (!this.execDir) throw new EvidenceHoldError("EVIDENCE_STORE_NOT_INITIALIZED", "init() first");
    const files = listDirSafe(journalDir(this.execDir)).filter((f) => f.endsWith(".json")).sort();
    let previous = JOURNAL_GENESIS;
    let seq = 0;
    for (const f of files) {
      seq += 1;
      if (f !== journalFileName(seq)) {
        throw new EvidenceHoldError("JOURNAL_INTEGRITY_FAILURE", `journal gap or ordering violation at ${f} (expected ${journalFileName(seq)})`);
      }
      const { event } = this.readEvent(seq);
      // event_sha256 is the hash of the event WITHOUT its own hash field.
      const withoutSelf = { ...event };
      delete withoutSelf.event_sha256;
      const recomputed = sha256Text(canonicalJson(withoutSelf) + "\n");
      if (event.event_sha256 !== recomputed) {
        throw new EvidenceHoldError("JOURNAL_INTEGRITY_FAILURE", `event_sha256 mismatch at seq ${seq}`);
      }
      if (event.previous_event_sha256 !== previous) {
        throw new EvidenceHoldError("JOURNAL_INTEGRITY_FAILURE", `hash chain break at seq ${seq}`);
      }
      if (event.sequence !== seq) {
        throw new EvidenceHoldError("JOURNAL_INTEGRITY_FAILURE", `sequence field mismatch at ${f}`);
      }
      const payloadHash = sha256Text(canonicalJson(event.payload));
      if (event.payload_sha256 !== payloadHash) {
        throw new EvidenceHoldError("JOURNAL_INTEGRITY_FAILURE", `payload_sha256 mismatch at seq ${seq}`);
      }
      previous = event.event_sha256;
    }
    return { ok: true, head: previous, count: seq };
  }

  /** Write one artifact under artifacts/（sanitized）. */
  writeArtifact(relName, obj, { sanitize = true } = {}) {
    if (!this.execDir) throw new EvidenceHoldError("EVIDENCE_STORE_NOT_INITIALIZED", "init() first");
    const target = join(artifactsDir(this.execDir), relName);
    assertInsideRoot(artifactsDir(this.execDir), target);
    const { value, metadata } = sanitize ? redactObject(obj) : { value: obj, metadata: { truncated: false } };
    if (metadata.truncated) {
      throw new EvidenceHoldError("DURABLE_EVIDENCE_SECRET_RISK", `artifact ${relName} exceeds free-text budget; refuse to persist truncated content`);
    }
    writeExclusiveCreate(target, canonicalJson(value) + "\n");
    return { path: target, sha256: sha256Text(canonicalJson(value) + "\n") };
  }

  /** Write one phase artifact under phases/<phaseId>/（sanitized）. */
  writePhaseArtifact(phaseId, name, obj) {
    if (!this.execDir) throw new EvidenceHoldError("EVIDENCE_STORE_NOT_INITIALIZED", "init() first");
    const dir = join(phasesDir(this.execDir), phaseId);
    ensureDir0700(dir);
    const target = join(dir, name);
    assertInsideRoot(phasesDir(this.execDir), target);
    const { value, metadata } = redactObject(obj);
    if (metadata.truncated) {
      throw new EvidenceHoldError("DURABLE_EVIDENCE_SECRET_RISK", `phase artifact ${phaseId}/${name} exceeds free-text budget`);
    }
    const body = canonicalJson(value) + "\n";
    writeExclusiveCreate(target, body);
    return { path: target, sha256: sha256Text(body) };
  }

  /**
   * Write one RAW text artifact under phases/<phaseId>/ — exact bytes, no
   * JSON re-encoding. Used by C4S for the reviewer-system-delta.patch file
   * so the durable patch bytes hash exactly match the patch SHA the C4N
   * bundle / implementation evidence / journal reference. Secret-pattern
   * scan, control-character rejection and the free-text byte budget all
   * fail closed（the artifact is never persisted）.
   */
  writePhaseRawArtifact(phaseId, name, text, { maxBytes = DEFAULT_MAX_FREE_TEXT_BYTES } = {}) {
    if (!this.execDir) throw new EvidenceHoldError("EVIDENCE_STORE_NOT_INITIALIZED", "init() first");
    const dir = join(phasesDir(this.execDir), phaseId);
    ensureDir0700(dir);
    const target = join(dir, name);
    assertInsideRoot(phasesDir(this.execDir), target);
    if (typeof text !== "string") {
      throw new EvidenceHoldError("DURABLE_EVIDENCE_SECRET_RISK", `raw artifact ${phaseId}/${name} must be a string`);
    }
    if (hasUnsafeControlChars(text)) {
      throw new EvidenceHoldError("DURABLE_EVIDENCE_SECRET_RISK", `raw artifact ${phaseId}/${name} contains control characters; refuse to persist`);
    }
    const scan = scanForSecrets(text);
    if (!scan.safe) {
      throw new EvidenceHoldError("DURABLE_EVIDENCE_SECRET_RISK", `raw artifact ${phaseId}/${name} matched secret pattern(s): ${scan.matches.join(",")}`);
    }
    const buf = Buffer.from(text, "utf8");
    if (buf.length > maxBytes) {
      throw new EvidenceHoldError("DURABLE_EVIDENCE_SECRET_RISK", `raw artifact ${phaseId}/${name} exceeds byte budget; refuse to persist truncated content`);
    }
    writeExclusiveCreate(target, text);
    return { path: target, sha256: sha256Text(text) };
  }

  /** Append one line to a phase lifecycle events file（jsonl, append via exclusive create of a new seq file is not possible for jsonl —
   * we use a bounded, write-once-per-call append via exclusive-create of monotonically named entries instead）. */
  appendPhaseLifecycleEvent(phaseId, entry) {
    if (!this.execDir) throw new EvidenceHoldError("EVIDENCE_STORE_NOT_INITIALIZED", "init() first");
    const dir = join(phasesDir(this.execDir), phaseId);
    ensureDir0700(dir);
    const { value } = redactObject(entry);
    const seq = listDirSafe(dir).filter((f) => f.startsWith("lifecycle-")).length + 1;
    const target = join(dir, `lifecycle-${padSeq(seq)}.json`);
    assertInsideRoot(phasesDir(this.execDir), target);
    writeExclusiveCreate(target, canonicalJson(value) + "\n");
    return target;
  }
}

/**
 * Validate an evidence root against the C3 contract:
 *  - absolute path
 *  - must not be a symlink（sealed resolveSafeRoot rejects）
 *  - must be OUTSIDE the repository worktree（and thus outside .git /
 *    node_modules / source tree）
 *  - owner-only（0700）created by initExecutionDir
 */
export function assertValidEvidenceRoot(root, repoRoot) {
  if (typeof root !== "string" || root.length === 0) {
    throw new EvidenceHoldError("PERSISTENCE_ROOT_INVALID", "root must be a non-empty string");
  }
  if (!root.startsWith("/")) {
    throw new EvidenceHoldError("PERSISTENCE_ROOT_INVALID", `root must be absolute: ${root}`);
  }
  const resolved = resolveSafeRoot(root);
  assertNotSymlink(resolved);
  if (repoRoot) {
    const repo = resolveSafeRoot(repoRoot);
    const repoPrefix = repo.endsWith("/") ? repo : repo + "/";
    if (resolved === repo || resolved.startsWith(repoPrefix)) {
      throw new EvidenceHoldError("PERSISTENCE_ROOT_INVALID", "evidence root must be OUTSIDE the repository worktree");
    }
  }
  return resolved;
}
