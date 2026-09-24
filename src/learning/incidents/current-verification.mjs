// src/learning/incidents/current-verification.mjs
//
// Stage E incident current verification: an explicit-call, one-item-per-call,
// offline, read-only revalidator of ONE historical incident projection item
// against the EXISTING C3 / generation / durable V2 revocation authorities.
//
// NON-AUTHORITATIVE by construction: never mutates the projection, the raw
// transfer-event log, the authority event log, C3 evidence, or any durable
// owner. Emits no events. Storage of the result is ephemeral (caller memory
// only). The receipt is an opaque, single-use, process-local capability that
// proves a completed bounded observation and nothing more; consumption always
// re-checks every current authority and re-pins the source.
//
// Spec authority: STAGE-E-INCIDENT-OBSERVATION-CURRENT-VERIFICATION-
// IMPLEMENTATION-ADMISSION-1 (sealed admission.md §0–§18, closures 1–55).

import {
  existsSync,
  lstatSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  readFileSync,
  constants as fsConstants,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, timingSafeEqual } from "node:crypto";

import {
  RunEvidenceStore,
  assertValidEvidenceRoot,
  journalDir,
  journalFileName,
  phasesDir,
} from "../../evidence/run-evidence-store.mjs";
import {
  readRunManifest,
  manifestShaPath,
} from "../../evidence/run-manifest.mjs";
import {
  assertNotSymlink,
  assertInsideRoot,
  assertPathComponentsNotSymlink,
  resolveSafeRoot,
  sha256Hex,
  isSha256Hex,
} from "../../c2d/fs-atomic.mjs";
import {
  resolveExecDir,
  readCurrent,
  validateSnapshotStructure,
} from "../../c2d/checkpoint-store.mjs";
import { validateExecutionId } from "../../c2d/execution-id.mjs";
import {
  ALLOWED_ROOT_PREFIX,
  INCIDENT_OBS_SCHEMA,
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2,
  TransferMetricsError,
  canonical,
  deriveEvidenceSetDigest,
} from "../transfer-metrics/schema.mjs";
import { readLog } from "../transfer-metrics/log.mjs";
import { readCurrentLearningAuthorityState } from "../transfer-metrics/authority-state.mjs";
import { assertMintedPrincipal } from "../transfer-metrics/identities.mjs";
import {
  CURRENT_AUTHORITY_STATUS_NOT_EVALUATED,
  PROJECTION_SCHEMA_VERSION,
  PROJECTION_ALGORITHM_VERSION,
  QUERY_POLICY_VERSION,
  CURRENT_AUTHORITY_POLICY_VERSION,
} from "./projection.mjs";

// ---------------------------------------------------------------------------
// Frozen bounds / discriminators (admission §3, §5; adapter:57-60,134 literal)
// ---------------------------------------------------------------------------

export const MAX_ITEMS_PER_CALL = 1;
export const MAX_SOURCE_TERMINALS = 1;
export const MAX_RETRIES = 2;
export const HISTORY_SCAN = "NONE";

const ELIGIBLE_REASONS_V1 = Object.freeze([
  "REVIEWER_HOLD",
  "REPAIR_BUDGET_EXHAUSTED",
]);
const ELIGIBLE_PROFILE_KIND = "LIFECYCLE_TERMINAL";
const ELIGIBLE_OUTCOME_CLASS = "HOLD";
const COMPLETE_CLASS = "COMPLETE";
const SOURCE_AUTHORITY_IDENTITY_FROZEN = "autoloop.lifecycle-runner";

const PHASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FREE_FORM_REASON_RE = /[:\s]|exception:|UNCLASSIFIED_HOLD/;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const MAX_SOURCE_BYTES = 64 * 1024;
const ISO_UTC_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T/;
const HEX64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Closed result model (admission §8 — exact public codes, frozen)
// ---------------------------------------------------------------------------

export const CURRENT_VERIFICATION_RESULTS = Object.freeze([
  "VERIFIED_CURRENT",
  "STALE_GENERATION",
  "REVOKED",
  "SOURCE_MISSING",
  "SOURCE_CONFLICT",
  "IDENTITY_MISMATCH",
  "AUTHORITY_CHANGED",
  "REVOCATION_UNAVAILABLE",
  "STRUCTURAL_INVALID",
  "INTEGRITY_INVALID",
]);

export const RECEIPT_RESULTS = Object.freeze([
  "RECEIPT_CONSUMED",
  "RECEIPT_FORGED",
  "RECEIPT_FOREIGN_INSTANCE",
]);

// Failure precedence (admission §9 + closure 48/55):
//   STRUCTURAL > INTEGRITY > RECEIPT > REVOCATION > STALENESS > ABSENCE
//   > VERIFIED_CURRENT
// Layer membership (closure 48 + 55, complete):
//   STRUCTURAL = {STRUCTURAL_INVALID, IDENTITY_MISMATCH}
//   INTEGRITY  = {INTEGRITY_INVALID, SOURCE_CONFLICT}
//   RECEIPT    = {RECEIPT_CONSUMED, RECEIPT_FORGED, RECEIPT_FOREIGN_INSTANCE}
//   REVOCATION = {REVOKED, AUTHORITY_CHANGED, REVOCATION_UNAVAILABLE}
//   STALENESS  = {STALE_GENERATION}
//   ABSENCE    = {SOURCE_MISSING}
const LAYER_STRUCTURAL = 6;
const LAYER_INTEGRITY = 5;
const LAYER_RECEIPT = 4;
const LAYER_REVOCATION = 3;
const LAYER_STALENESS = 2;
const LAYER_ABSENCE = 1;

const CODE_LAYER = Object.freeze({
  STRUCTURAL_INVALID: LAYER_STRUCTURAL,
  IDENTITY_MISMATCH: LAYER_STRUCTURAL,
  INTEGRITY_INVALID: LAYER_INTEGRITY,
  SOURCE_CONFLICT: LAYER_INTEGRITY,
  RECEIPT_CONSUMED: LAYER_RECEIPT,
  RECEIPT_FORGED: LAYER_RECEIPT,
  RECEIPT_FOREIGN_INSTANCE: LAYER_RECEIPT,
  REVOKED: LAYER_REVOCATION,
  AUTHORITY_CHANGED: LAYER_REVOCATION,
  REVOCATION_UNAVAILABLE: LAYER_REVOCATION,
  STALE_GENERATION: LAYER_STALENESS,
  SOURCE_MISSING: LAYER_ABSENCE,
});

// Non-authoritative result framing (card Phase 15; frozen strings).
export const RESULT_AUTHORITY = "NON_AUTHORITATIVE_OBSERVATION";
export const RESULT_STORAGE = "EPHEMERAL";
export const PROJECTION_MUTATED = "NO";
export const SOURCE_MUTATED = "NO";
export const RAW_LOG_MUTATED = "NO";

// ---------------------------------------------------------------------------
// Input isolation (admission closure 45; card Phase 4)
// Two-pass deep own-data-descriptor snapshot. Getters are rejected from their
// own property descriptors WITHOUT ever being invoked; symbol keys, forbidden
// keys, non-plain prototypes, and Proxy re-read instability all fail closed.
// ---------------------------------------------------------------------------

const FORBIDDEN_INPUT_KEYS = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
  "toJSON",
  "valueOf",
  "symbol",
]);
const SNAPSHOT_MAX_DEPTH = 16;
const SNAPSHOT_MAX_NODES = 8192;

class StructuralFault extends Error {
  constructor(internalCode) {
    super(internalCode);
    this.internalCode = internalCode;
  }
}

function struct(internalCode) {
  throw new StructuralFault(internalCode || "INPUT_UNSAFE");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function captureSnapshot(value, depth, counter) {
  if (depth > SNAPSHOT_MAX_DEPTH || counter.n > SNAPSHOT_MAX_NODES) {
    struct("INPUT_OVERBOUND");
  }
  counter.n += 1;
  const t = typeof value;
  if (value === null) return null;
  if (t === "string") {
    if (value.length > 65536) struct("INPUT_OVERBOUND");
    return value;
  }
  if (t === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) struct("INPUT_UNSAFE_NUMBER");
    return value;
  }
  if (t === "boolean") return value;
  if (value instanceof Uint8Array) {
    counter.n += 1;
    // One-time byte view capture (the projection builder's canonical_bytes):
    // the bytes are copied exactly once and never re-read from the caller.
    return { "\u0000cvbytes": Buffer.from(value).toString("hex") };
  }
  if (t !== "object") {
    struct("INPUT_UNSAFE_TYPE");
  }
  if (Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Array.prototype) struct("INPUT_UNSAFE_PROTO");
    const out = [];
    for (let i = 0; i < value.length; i++) {
      out.push(captureSnapshot(value[i], depth + 1, counter));
    }
    return out;
  }
  if (!isPlainObject(value)) struct("INPUT_UNSAFE_PROTO");
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) struct("INPUT_SYMBOL_KEYS");
  const out = {};
  const keys = Object.keys(value);
  for (const key of keys) {
    if (FORBIDDEN_INPUT_KEYS.includes(key)) struct("INPUT_FORBIDDEN_KEY");
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      struct("INPUT_DESCRIPTOR_TRAP");
    }
    if (!desc) struct("INPUT_KEY_VANISHED");
    if (desc.get !== undefined || desc.set !== undefined) struct("INPUT_ACCESSOR");
    if (!Object.prototype.hasOwnProperty.call(desc, "value")) struct("INPUT_ACCESSOR");
    out[key] = captureSnapshot(desc.value, depth + 1, counter);
  }
  return out;
}

function snapshotInput(root) {
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    struct("INPUT_NOT_OBJECT");
  }
  if (Object.getOwnPropertySymbols(root).length > 0) struct("INPUT_SYMBOL_KEYS");
  const first = captureSnapshot(root, 0, { n: 0 });
  const second = captureSnapshot(root, 0, { n: 0 });
  if (canonical(first) !== canonical(second)) struct("INPUT_UNSTABLE_RE_READ");
  return first;
}

function captureBytes(value, label) {
  // Accepts the one-time tagged byte copy produced by captureSnapshot (the
  // projection builder's canonical_bytes). The bytes were copied exactly
  // once at snapshot time and are never re-read from the caller.
  if (isPlainObject(value) && typeof value["\u0000cvbytes"] === "string") {
    const hex = value["\u0000cvbytes"];
    if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) struct("INPUT_BYTES_UNSAFE");
    return Buffer.from(hex, "hex");
  }
  struct(`${label}_NOT_BYTES`);
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

function assertHex64(value, label) {
  if (typeof value !== "string" || !HEX64_RE.test(value)) struct(`${label}_NOT_HEX64`);
  return value;
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) struct(`${label}_NOT_OBJECT`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) struct(`${label}_UNKNOWN_KEY`);
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) struct(`${label}_MISSING_KEY`);
  }
}

function timingSafeHexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function assertStorageRootInNamespace(root) {
  if (typeof root !== "string" || root.length === 0) struct("PATH_UNSAFE");
  if (!root.startsWith("/") || root.includes("\0") || root.split(sep).includes("..")) {
    struct("PATH_UNSAFE");
  }
  // $HOME ITSELF is refused; the namespace boundary below is the real fence
  // (the portable default learning root lives under ~/.autoloop).
  const home = resolve(homedir());
  const lexical = resolve(root);
  if (lexical === home) struct("PATH_UNSAFE");
  const prefix = ALLOWED_ROOT_PREFIX.endsWith(sep)
    ? ALLOWED_ROOT_PREFIX
    : ALLOWED_ROOT_PREFIX + sep;
  const allowedRoot = ALLOWED_ROOT_PREFIX.replace(/\/$/, "");
  if (lexical !== allowedRoot && !lexical.startsWith(prefix)) struct("PATH_UNSAFE");
  let resolved;
  try {
    resolved = resolveSafeRoot(root);
    assertNotSymlink(resolved);
    assertPathComponentsNotSymlink(resolved, { allowMissingLeaf: false });
  } catch {
    struct("PATH_UNSAFE");
  }
  if (resolved !== allowedRoot && !resolved.startsWith(prefix)) struct("PATH_UNSAFE");
  if (resolved === home) struct("PATH_UNSAFE");
  return resolved;
}

// Single open(O_NOFOLLOW) -> fstat(same fd) -> read(fd). Identical strictness
// to the predecessor safe-file primitive; no path re-open between stat and
// hash (admission §4 step 9, closure 18).
// Regular-file gate taken BEFORE any blocking read: a FIFO (or any
// non-regular inode) swapped into an owner-read path fails closed as
// INTEGRITY_INVALID instead of hanging the verifier.
function lstatRegularOrMissing(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return false; // ENOENT: absent
  }
  if (st.isSymbolicLink() || !st.isFile()) struct("FILE_UNSAFE");
  return true;
}

function readSafeFileExclusive(absPath, root) {
  assertInsideRoot(root, absPath);
  assertPathComponentsNotSymlink(absPath, { allowMissingLeaf: true });
  assertNotSymlink(absPath);
  if (!existsSync(absPath)) return null;
  lstatRegularOrMissing(absPath);
  const fd = openSync(absPath, fsConstants.O_RDONLY | NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_SOURCE_BYTES) {
      struct("FILE_UNSAFE");
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Fault ledger: collect every fault, resolve by the frozen total precedence.
// ---------------------------------------------------------------------------

function makeLedger() {
  const byLayer = new Map();
  return {
    add(code) {
      const layer = CODE_LAYER[code];
      if (layer === undefined) {
        // Unmapped condition is a spec violation: fail closed as STRUCTURAL
        // rather than inventing a new public code (closure 34).
        throw new StructuralFault(`UNMAPPED_FAULT:${code}`);
      }
      if (!byLayer.has(layer)) byLayer.set(layer, code);
    },
    resolve() {
      if (byLayer.size === 0) return "VERIFIED_CURRENT";
      const highest = Math.max(...byLayer.keys());
      return byLayer.get(highest);
    },
    has(code) {
      for (const code2 of byLayer.values()) if (code2 === code) return true;
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Strict generation parse (admission §5, closure 32/55). Owner is C3
// CURRENT.json graph domain. No truthiness; missing ≠ 0; strings never
// coerced; -0 rejected; only canonical JSON safe integers accepted.
// ---------------------------------------------------------------------------

function parseOwnerGeneration(snapshot) {
  // missing graph domain entirely ⇒ owner uninterpretable
  if (!isPlainObject(snapshot.graph)) return { error: "GENERATION_FIELD_MISSING" };
  if (!Object.prototype.hasOwnProperty.call(snapshot.graph, "recovery_generation")) {
    return { error: "GENERATION_FIELD_MISSING" };
  }
  const g = snapshot.graph.recovery_generation;
  if (g === null) return { error: "GENERATION_NULL" };
  if (typeof g !== "number" || !Number.isFinite(g)) return { error: "GENERATION_NOT_NUMBER" };
  if (Object.is(g, -0)) return { error: "GENERATION_NEGATIVE_ZERO" };
  if (!Number.isSafeInteger(g) || !Number.isInteger(g)) return { error: "GENERATION_NOT_SAFE_INTEGER" };
  if (g < 0) return { error: "GENERATION_NEGATIVE" };
  return { gen: g };
}

function parseResultGeneration(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "graph_generation")) {
    return { error: "RESULT_GENERATION_MISSING" };
  }
  const g = result.graph_generation;
  if (g === null) return { error: "RESULT_GENERATION_NULL" };
  if (typeof g !== "number" || !Number.isFinite(g)) return { error: "RESULT_GENERATION_NOT_NUMBER" };
  if (Object.is(g, -0)) return { error: "RESULT_GENERATION_NEGATIVE_ZERO" };
  if (!Number.isSafeInteger(g) || !Number.isInteger(g)) return { error: "RESULT_GENERATION_NOT_SAFE_INTEGER" };
  if (g < 0) return { error: "RESULT_GENERATION_NEGATIVE" };
  return { gen: g };
}

// ---------------------------------------------------------------------------
// Receipt model (admission §10, closure 43). ONE module-level singleton
// verifier instance; per-instance-equivalent module-private WeakSets; opaque
// frozen class instance carrying its binds under a module-private symbol.
// ---------------------------------------------------------------------------

const RECEIPT_FACTS = Symbol("autoloop.current-verification.receipt.facts");
const ACTIVE_RECEIPTS = new WeakSet();
const CONSUMED_RECEIPTS = new WeakSet();

class CurrentVerificationReceipt {
  constructor(facts) {
    Object.defineProperty(this, RECEIPT_FACTS, {
      value: Object.freeze(facts),
      enumerable: false,
      writable: false,
      configurable: false,
    });
    Object.freeze(this);
  }
  facts() {
    return this[RECEIPT_FACTS] ?? null;
  }
}

function classifyReceipt(receipt) {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    return "RECEIPT_FORGED";
  }
  if (CONSUMED_RECEIPTS.has(receipt)) return "RECEIPT_CONSUMED";
  if (ACTIVE_RECEIPTS.has(receipt)) return "ACTIVE";
  // A spread/JSON-roundtrip/structuredClone copy loses the non-enumerable
  // symbol facts and the class prototype ⇒ forged. A receipt minted by a
  // different verifier instance (same class shape, foreign WeakSet) ⇒
  // foreign instance.
  const proto = Object.getPrototypeOf(receipt);
  if (proto === CurrentVerificationReceipt.prototype) {
    // same-instance object with the receipt prototype but absent from the
    // WeakSets: a proto-grafted clone, not a foreign capability
    return "RECEIPT_FORGED";
  }
  if (proto !== null && proto !== Object.prototype && proto !== Array.prototype) {
    const name = proto.constructor?.name;
    if (name === "CurrentVerificationReceipt") return "RECEIPT_FOREIGN_INSTANCE";
  }
  return "RECEIPT_FORGED";
}

// ---------------------------------------------------------------------------
// Frozen input contract (admission §2, closure 44). bounded_options is an
// EMPTY allowlist: no options are accepted in this slice.
// ---------------------------------------------------------------------------

const VERIFY_INPUT_KEYS = Object.freeze([
  "validated_evidence_root",
  "projection_document",
  "projection_item",
  "selector",
  "verification_principal",
]);
const CONSUME_INPUT_KEYS = Object.freeze([
  "receipt",
  ...VERIFY_INPUT_KEYS,
]);
const SELECTOR_KEYS = Object.freeze(["execution_id", "phase_id"]);
const EVIDENCE_REF_KEYS = Object.freeze(["kind", "identity", "digest"]);
const PROJECT_IDENTITY_KEYS = Object.freeze([
  "repository_root_identity",
  "git_common_dir_identity",
]);
const TASK_IDENTITY_KEYS = Object.freeze(["task_id", "admission_id"]);
const ATTEMPT_IDENTITY_KEYS = Object.freeze(["execution_id", "attempt"]);
const REDACTION_KEYS = Object.freeze(["scanned", "truncated", "secret_hit"]);

const ENVELOPE_KEYS = Object.freeze([
  "projection_schema_version",
  "projection_algorithm_version",
  "raw_schema_versions",
  "input_log_digest",
  "input_first_event_digest",
  "input_final_event_digest",
  "input_byte_range",
  "input_event_count",
  "incident_event_count",
  "projection_item_count",
  "query_policy_version",
  "current_authority_policy_version",
  "items",
  "projection_digest",
]);

const ITEM_KEYS = Object.freeze([
  "projection_item_id",
  "incident_observation_id",
  "incident_id",
  "source_identity_key",
  "source_system",
  "source_record_type",
  "source_record_id",
  "source_record_digest",
  "evidence_set_digest",
  "evidence_refs",
  "project_identity",
  "worktree_identity",
  "task_identity",
  "admission_id",
  "attempt_identity",
  "authority_generation",
  "revocation_generation",
  "recorded_completeness",
  "observed_outcome_class",
  "failure_finding_discriminator",
  "occurred_at",
  "recorded_at",
  "raw_append_ordinal",
  "raw_event_digest",
  "current_authority_status",
  "current_authority_receipt_reference",
  "current_authority_checked_generation",
  "redaction_status",
]);

function isNonNegativeInt(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && Object.is(v, -0) === false;
}

function assertBoundedString(v, label, max = 4096) {
  if (typeof v !== "string" || v.length === 0 || v.length > max) struct(`${label}_INVALID`);
}

// ---------------------------------------------------------------------------
// Input contract validation (pure; no fs). Returns the frozen working set.
// ---------------------------------------------------------------------------

function validateInputs(input, { forConsume }) {
  // Per-key snapshot: the receipt (consume) is an opaque capability that is
  // referenced, never copied/hashed, so it is excluded from the deep
  // snapshot. Key enumeration uses own keys only; getters are rejected at
  // descriptor level without invocation.
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    struct("INPUT_NOT_OBJECT");
  }
  const allowedKeys = forConsume ? CONSUME_INPUT_KEYS : VERIFY_INPUT_KEYS;
  const allowedSet = new Set(allowedKeys);
  if (Object.getOwnPropertySymbols(input).length > 0) struct("INPUT_SYMBOL_KEYS");
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) struct("INPUT_UNKNOWN_KEY");
  }
  const snap = {};
  const captureOnce = (key) => {
    // Descriptor-first read: an accessor at the top level is rejected from its
    // own property descriptor and the getter is NEVER invoked (card Phase 4);
    // an arbitrary getter/Proxy exception is folded into the closed result
    // set instead of escaping the verifier.
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(input, key);
    } catch {
      struct("INPUT_DESCRIPTOR_TRAP");
    }
    if (!desc) struct("INPUT_MISSING_KEY");
    if (desc.get !== undefined || desc.set !== undefined) struct("INPUT_ACCESSOR");
    if (!Object.prototype.hasOwnProperty.call(desc, "value")) struct("INPUT_ACCESSOR");
    try {
      return captureSnapshot(desc.value, 0, { n: 0 });
    } catch (err) {
      if (err instanceof StructuralFault) throw err;
      struct("INPUT_UNSAFE");
    }
  };
  for (const key of VERIFY_INPUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) struct("INPUT_MISSING_KEY");
    const first = captureOnce(key);
    const second = captureOnce(key);
    if (canonical(first) !== canonical(second)) struct("INPUT_UNSTABLE_RE_READ");
    snap[key] = first;
  }
  if (forConsume && !Object.prototype.hasOwnProperty.call(input, "receipt")) {
    struct("INPUT_MISSING_KEY");
  }
  const { validated_evidence_root, projection_document, projection_item, selector } = snap;

  assertBoundedString(validated_evidence_root, "EVIDENCE_ROOT", 4096);

  // principal: capability check runs against the ORIGINAL reference (the
  // snapshot copy is data only; the WeakSet membership is the capability).
  const principalRef = input.verification_principal;
  try {
    assertMintedPrincipal(principalRef);
  } catch {
    struct("PRINCIPAL_NOT_MINTED");
  }

  // selector
  assertExactKeys(selector, SELECTOR_KEYS, "SELECTOR");
  assertBoundedString(selector.execution_id, "SELECTOR_EXECUTION_ID", 256);
  try {
    validateExecutionId(selector.execution_id);
  } catch {
    struct("SELECTOR_EXECUTION_ID_INVALID");
  }
  assertBoundedString(selector.phase_id, "SELECTOR_PHASE_ID", 128);
  if (!PHASE_ID_RE.test(selector.phase_id) || selector.phase_id.includes("..")) {
    struct("SELECTOR_PHASE_ID_INVALID");
  }

  // projection document: builder output only (envelope + canonical bytes).
  assertExactKeys(projection_document, ["envelope", "canonical_bytes", "input_log_digest", "projection_digest"], "PROJECTION_DOCUMENT");
  const envelope = projection_document.envelope;
  assertExactKeys(envelope, ENVELOPE_KEYS, "ENVELOPE");
  if (envelope.projection_schema_version !== PROJECTION_SCHEMA_VERSION
    || envelope.projection_algorithm_version !== PROJECTION_ALGORITHM_VERSION
    || envelope.query_policy_version !== QUERY_POLICY_VERSION
    || envelope.current_authority_policy_version !== CURRENT_AUTHORITY_POLICY_VERSION) {
    struct("PROJECTION_SCHEMA_MISMATCH");
  }
  if (!Array.isArray(envelope.raw_schema_versions)
    || envelope.raw_schema_versions.length === 0
    || !envelope.raw_schema_versions.every(
      (v) => v === SCHEMA_VERSION || v === SCHEMA_VERSION_V2,
    )) {
    struct("PROJECTION_RAW_SCHEMA_INVALID");
  }
  const sortedVersions = [...envelope.raw_schema_versions].sort();
  if (sortedVersions.join("|") !== envelope.raw_schema_versions.join("|")) {
    struct("PROJECTION_RAW_SCHEMA_UNORDERED");
  }
  assertHex64(envelope.input_log_digest, "INPUT_LOG_DIGEST");
  if (envelope.input_first_event_digest !== null) {
    assertHex64(envelope.input_first_event_digest, "INPUT_FIRST_EVENT_DIGEST");
  }
  assertHex64(envelope.input_final_event_digest, "INPUT_FINAL_EVENT_DIGEST");
  if (!Array.isArray(envelope.input_byte_range)) struct("INPUT_BYTE_RANGE_INVALID");
  for (const range of envelope.input_byte_range) {
    assertExactKeys(range, ["name", "byte_offset", "byte_length"], "BYTE_RANGE");
    assertBoundedString(range.name, "BYTE_RANGE_NAME", 1024);
    if (!isNonNegativeInt(range.byte_offset) || !isNonNegativeInt(range.byte_length)) {
      struct("BYTE_RANGE_BOUNDS");
    }
  }
  if (!isNonNegativeInt(envelope.input_event_count)
    || !isNonNegativeInt(envelope.incident_event_count)
    || !isNonNegativeInt(envelope.projection_item_count)) {
    struct("ENVELOPE_COUNTS_INVALID");
  }
  if (!Array.isArray(envelope.items)) struct("ENVELOPE_ITEMS_NOT_ARRAY");
  if (envelope.items.length !== envelope.projection_item_count
    || envelope.items.length !== envelope.incident_event_count) {
    struct("ENVELOPE_COUNT_MISMATCH");
  }
  assertHex64(envelope.projection_digest, "PROJECTION_DIGEST");

  // self-excluding document digest (freeze §5 of projection.mjs): the digest
  // preimage carries projection_digest: null.
  const envelopeForDigest = { ...envelope, projection_digest: null };
  const recomputedDigest = createHash("sha256")
    .update(canonical(envelopeForDigest), "utf8")
    .digest("hex");
  if (!timingSafeHexEqual(recomputedDigest, envelope.projection_digest)) {
    struct("PROJECTION_DIGEST_MISMATCH");
  }
  const canonicalBytes = captureBytes(projection_document.canonical_bytes, "CANONICAL_BYTES");
  const rebuiltBytes = Buffer.from(canonical(envelope), "utf8");
  if (!canonicalBytes.equals(rebuiltBytes)) {
    struct("PROJECTION_BYTES_MISMATCH");
  }

  // projection item: builder item shape, historical-pristine.
  const item = projection_item;
  assertExactKeys(item, ITEM_KEYS, "ITEM");
  assertHex64(item.projection_item_id, "ITEM_ID");
  assertBoundedString(item.incident_observation_id, "INCIDENT_OBSERVATION_ID", 256);
  assertHex64(item.incident_id, "INCIDENT_ID");
  assertHex64(item.source_identity_key, "SOURCE_IDENTITY_KEY");
  assertBoundedString(item.source_system, "SOURCE_SYSTEM", 256);
  assertBoundedString(item.source_record_type, "SOURCE_RECORD_TYPE", 128);
  assertBoundedString(item.source_record_id, "SOURCE_RECORD_ID", 256);
  assertHex64(item.source_record_digest, "SOURCE_RECORD_DIGEST");
  assertHex64(item.evidence_set_digest, "EVIDENCE_SET_DIGEST");
  assertExactKeys(item.project_identity, PROJECT_IDENTITY_KEYS, "PROJECT_IDENTITY");
  assertBoundedString(item.project_identity.repository_root_identity, "REPOSITORY_ROOT_IDENTITY", 4096);
  assertBoundedString(item.project_identity.git_common_dir_identity, "GIT_COMMON_DIR_IDENTITY", 4096);
  assertBoundedString(item.worktree_identity, "WORKTREE_IDENTITY", 4096);
  assertExactKeys(item.task_identity, TASK_IDENTITY_KEYS, "TASK_IDENTITY");
  assertBoundedString(item.task_identity.task_id, "TASK_ID", 512);
  assertHex64(item.task_identity.admission_id, "ADMISSION_ID");
  assertHex64(item.admission_id, "ADMISSION_ID");
  if (item.admission_id !== item.task_identity.admission_id) struct("ADMISSION_IDENTITY_MISMATCH");
  assertExactKeys(item.attempt_identity, ATTEMPT_IDENTITY_KEYS, "ATTEMPT_IDENTITY");
  assertBoundedString(item.attempt_identity.execution_id, "ATTEMPT_EXECUTION_ID", 256);
  try {
    validateExecutionId(item.attempt_identity.execution_id);
  } catch {
    struct("ATTEMPT_EXECUTION_ID_INVALID");
  }
  if (!isNonNegativeInt(item.attempt_identity.attempt)) struct("ATTEMPT_IDENTITY_INVALID");
  if (!isNonNegativeInt(item.authority_generation)) struct("AUTHORITY_GENERATION_INVALID");
  if (item.revocation_generation !== null && !isNonNegativeInt(item.revocation_generation)) {
    struct("REVOCATION_GENERATION_INVALID");
  }
  if (item.recorded_completeness !== COMPLETE_CLASS) struct("SOURCE_INCOMPLETE");
  if (item.observed_outcome_class !== ELIGIBLE_OUTCOME_CLASS) struct("OUTCOME_CLASS_INELIGIBLE");
  assertBoundedString(item.failure_finding_discriminator, "DISCRIMINATOR", 1024);
  assertBoundedString(item.occurred_at, "OCCURRED_AT", 128);
  if (!ISO_UTC_PREFIX_RE.test(item.occurred_at)) struct("OCCURRED_AT_INVALID");
  assertBoundedString(item.recorded_at, "RECORDED_AT", 128);
  if (!ISO_UTC_PREFIX_RE.test(item.recorded_at)) struct("RECORDED_AT_INVALID");
  if (!isNonNegativeInt(item.raw_append_ordinal)) struct("RAW_APPEND_ORDINAL_INVALID");
  assertBoundedString(item.raw_event_digest, "RAW_EVENT_DIGEST", 256);
  if (item.current_authority_status !== CURRENT_AUTHORITY_STATUS_NOT_EVALUATED) {
    struct("CURRENT_STATUS_NOT_HISTORICAL");
  }
  if (item.current_authority_receipt_reference !== null
    || item.current_authority_checked_generation !== null) {
    struct("CURRENT_STATUS_NOT_HISTORICAL");
  }
  assertExactKeys(item.redaction_status, REDACTION_KEYS, "REDACTION_STATUS");
  if (item.redaction_status.scanned !== true) struct("REDACTION_NOT_SCANNED");

  // evidence refs: builder-normalized, sorted tuples.
  if (!Array.isArray(item.evidence_refs) || item.evidence_refs.length < 1) {
    struct("EVIDENCE_REFS_INVALID");
  }
  if (item.evidence_refs.length > 16) struct("EVIDENCE_REFS_OVERBOUND");
  let previousRef = null;
  for (const ref of item.evidence_refs) {
    assertExactKeys(ref, EVIDENCE_REF_KEYS, "EVIDENCE_REF");
    assertBoundedString(ref.kind, "REF_KIND", 64);
    assertBoundedString(ref.identity, "REF_IDENTITY", 512);
    assertHex64(ref.digest, "REF_DIGEST");
    const tuple = `${ref.kind}\n${ref.identity}\n${ref.digest}`;
    if (previousRef !== null && tuple <= previousRef) struct("EVIDENCE_REFS_UNORDERED");
    previousRef = tuple;
  }

  // projection_item_id recomputation (document membership, closure 3/42):
  // the item identity preimage is frozen by projection.mjs buildProjectionItem.
  const itemIdPreimage = {
    domain: "autoloop.incident-projection-item/v1",
    projection_schema_version: PROJECTION_SCHEMA_VERSION,
    projection_algorithm_version: PROJECTION_ALGORITHM_VERSION,
    incident_observation_id: item.incident_observation_id,
    journal_sequence: item.raw_append_ordinal,
    raw_event_digest: item.raw_event_digest,
  };
  const recomputedItemId = createHash("sha256")
    .update(canonical(itemIdPreimage), "utf8")
    .digest("hex");
  if (!timingSafeHexEqual(recomputedItemId, item.projection_item_id)) {
    struct("ITEM_IDENTITY_MISMATCH");
  }

  // membership: the presented item must be a canonical member of THIS document.
  let member = null;
  for (const candidate of envelope.items) {
    if (isPlainObject(candidate)
      && candidate.projection_item_id === item.projection_item_id) {
      if (canonical(candidate) === canonical(item)) {
        member = candidate;
        break;
      }
      struct("ITEM_TAMPERED_VS_DOCUMENT");
    }
  }
  if (!member) struct("ITEM_NOT_IN_DOCUMENT");

  // phase rebind via the frozen artifact-reference rule (admission §1/§4).
  const artifactRefs = item.evidence_refs.filter((r) => r.kind === "artifact");
  if (artifactRefs.length !== 1) struct("ARTIFACT_REF_AMBIGUOUS");
  const phaseId = artifactRefs[0].identity;
  if (!PHASE_ID_RE.test(phaseId) || phaseId.includes("..")) struct("PHASE_ID_INVALID");
  if (selector.phase_id !== phaseId) struct("SELECTOR_PHASE_MISMATCH");
  if (selector.execution_id !== item.attempt_identity.execution_id) {
    struct("SELECTOR_EXECUTION_MISMATCH");
  }
  const eventRef = item.evidence_refs.filter((r) => r.kind === "evidence_event");
  if (eventRef.length !== 1) struct("EVENT_REF_AMBIGUOUS");
  if (eventRef[0].identity !== item.source_record_id) struct("EVENT_REF_IDENTITY_MISMATCH");
  const manifestRefs = item.evidence_refs.filter((r) => r.kind === "evidence_manifest");
  if (manifestRefs.length !== 1) struct("MANIFEST_REF_AMBIGUOUS");
  if (manifestRefs[0].identity !== selector.execution_id) struct("MANIFEST_REF_IDENTITY_MISMATCH");

  return {
    snap,
    envelope,
    item,
    executionId: selector.execution_id,
    phaseId,
    evidenceRootString: validated_evidence_root,
  };
}

// ---------------------------------------------------------------------------
// Revocation collection. Single seam, two subjects, one replay per call
// (admission §6/§7, closure 46). transferMetricsRoot IS the validated
// evidence root: the explicit authority location holds both the C3 exec dirs
// and the V2 learning-authority log. Subject keys are never constructed by
// the verifier — only seam-derived identities are used.
// ---------------------------------------------------------------------------

function deriveWriterIdFromRawLog(resolvedRoot, item, ledger) {
  // Frozen revocation-subject derivation: the WRITER_PRINCIPAL subject is
  // the writer.writer_id recorded on the historical raw event (architecture
  // revocation-authority-matrix). The raw event is bound by the projection
  // item via (raw_append_ordinal, raw_event_digest) — an exact single-record
  // lookup over durable bytes, never a history scan for sources. Any
  // divergence between the item and the durable log is an integrity fault.
  let replay;
  try {
    replay = readLog(resolvedRoot);
  } catch (err) {
    // An unreadable/corrupt V2 log means the authority replay cannot
    // complete: the frozen mapping is seam-unavailable (§6), which the caller
    // resolves to REVOCATION_UNAVAILABLE. Item-vs-log divergence below is a
    // genuine binding integrity fault.
    if (err instanceof TransferMetricsError) return null;
    ledger.add("INTEGRITY_INVALID");
    return null;
  }
  if (replay.activeGeneration !== 2) {
    // Missing log (null) or GEN-1 legacy active root: the seam itself is
    // UNAVAILABLE — never a silent CURRENT@0 (admission §6, closure 9).
    return null;
  }
  const events = replay.events;
  let match = null;
  for (const ev of events) {
    if (ev.journal_sequence === item.raw_append_ordinal) {
      if (typeof ev.event_digest !== "string" || ev.event_digest !== item.raw_event_digest) {
        ledger.add("INTEGRITY_INVALID");
        return null;
      }
      if (match !== null) {
        ledger.add("INTEGRITY_INVALID");
        return null;
      }
      match = ev;
    }
  }
  if (match === null) {
    ledger.add("INTEGRITY_INVALID");
    return null;
  }
  const w = match.writer;
  if (!isPlainObject(w) || typeof w.writer_id !== "string" || w.writer_id.length === 0) {
    ledger.add("INTEGRITY_INVALID");
    return null;
  }
  return w.writer_id;
}

function collectRevocation(resolvedRoot, item, ledger) {
  const writerId = deriveWriterIdFromRawLog(resolvedRoot, item, ledger);
  if (writerId === null) return { unavailable: "WRITER_SUBJECT_UNRESOLVED" };
  let writer;
  let cited;
  try {
    writer = readCurrentLearningAuthorityState({
      transferMetricsRoot: resolvedRoot,
      subjectKind: "WRITER_PRINCIPAL",
      writerId,
    });
    cited = readCurrentLearningAuthorityState({
      transferMetricsRoot: resolvedRoot,
      subjectKind: "CITED_TRUTH",
      citedKey: item.source_record_digest,
      taskIdentity: {
        task_id: item.task_identity.task_id,
        admission_id: item.task_identity.admission_id,
      },
    });
  } catch (err) {
    if (err instanceof TransferMetricsError) return { unavailable: "AUTHORITY_UNAVAILABLE" };
    throw err;
  }
  const bind = (r) => ({
    availability: r.availability,
    state: r.state,
    generation: r.generation,
    replay_generation: r.replay_generation,
    authority_input_digest: r.authority_input_digest,
    final_authority_event: r.final_authority_event,
  });
  return { writer: bind(writer), cited: bind(cited) };
}

function revocationStable(a, b) {
  if (a.unavailable !== undefined || b.unavailable !== undefined) {
    return a.unavailable === b.unavailable;
  }
  for (const key of ["writer", "cited"]) {
    const x = a[key];
    const y = b[key];
    if (x.availability !== y.availability) return false;
    if (x.state !== y.state) return false;
    // closure 33: R2 generation / replay_generation must be >= R1's; a
    // durable rollback or restore between reads is never masked by equality.
    if (!(y.generation >= x.generation)) return false;
    if (!(y.replay_generation >= x.replay_generation)) return false;
    if (!timingSafeHexEqual(x.authority_input_digest ?? "", y.authority_input_digest ?? "")) {
      return false;
    }
    const fx = x.final_authority_event;
    const fy = y.final_authority_event;
    const fxk = fx === null ? "null" : `${fx.event_id}|${fx.event_digest}`;
    const fyk = fy === null ? "null" : `${fy.event_id}|${fy.event_digest}`;
    if (fxk !== fyk) return false;
  }
  return true;
}

function revocationFaults(ledger, rev) {
  if (rev.unavailable !== undefined) {
    ledger.add("REVOCATION_UNAVAILABLE");
    return;
  }
  for (const key of ["writer", "cited"]) {
    const subject = rev[key];
    if (subject.availability === "AUTHORITY_CORRUPT" || subject.availability === "AUTHORITY_UNAVAILABLE") {
      ledger.add("REVOCATION_UNAVAILABLE");
      return;
    }
    if (subject.state === "REVOKED") {
      ledger.add("REVOKED");
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Source reverification (admission §4: the 16 mandatory steps, read-only
// reimplementation over existing owner exports; adapter import forbidden).
// ---------------------------------------------------------------------------

function eligibilityFromResult(result) {
  // Mirrors adapter eligibility() from recomputed result bytes (closure 53).
  if (result.synthesized === true) return "SYNTHESIZED_TERMINAL";
  if (result.final === "PASS") return "PASS_TERMINAL";
  if (result.final !== "HOLD") return "TERMINAL_INELIGIBLE";
  if (result.status === "running" || result.status === "started") return "NON_TERMINAL";
  if (result.reason === null || result.reason === undefined || result.reason === "") {
    return "REASON_MISSING";
  }
  if (typeof result.reason !== "string") return "REASON_NOT_ALLOWLISTED";
  if (FREE_FORM_REASON_RE.test(result.reason) && !ELIGIBLE_REASONS_V1.includes(result.reason)) {
    return "REASON_FREE_FORM";
  }
  if (!ELIGIBLE_REASONS_V1.includes(result.reason)) return "REASON_NOT_ALLOWLISTED";
  if (!Number.isInteger(result.attempt) || result.attempt < 0) return "INCOMPLETE_PUBLICATION";
  return null;
}

function selectPhaseHeld(store, phaseId, result, ledger, execDir) {
  // Mirrors adapter selectPhaseHeld read-only over RunEvidenceStore exports.
  let verified;
  try {
    verified = store.verifyJournal();
  } catch {
    // Journal framing/chain/integrity failure (T17/T18): fail closed.
    ledger.add("INTEGRITY_INVALID");
    throw new StructuralFault("JOURNAL_UNREADABLE");
  }
  const journalRoot = journalDir(store.execDir);
  const ids = new Set();
  const matching = [];
  let sawParent = false;
  let sawPassed = false;
  let sawNonTerminal = false;
  for (let seq = 1; seq <= verified.count; seq++) {
    const path = join(journalRoot, journalFileName(seq));
    try {
      assertInsideRoot(execDir, path);
      assertPathComponentsNotSymlink(path, { allowMissingLeaf: true });
      assertNotSymlink(path);
    } catch {
      ledger.add("INTEGRITY_INVALID");
      throw new StructuralFault("JOURNAL_FILE_UNSAFE");
    }
    let event;
    try {
      event = store.readEvent(seq).event;
    } catch {
      ledger.add("INTEGRITY_INVALID");
      throw new StructuralFault("JOURNAL_UNREADABLE");
    }
    if (typeof event.event_id !== "string" || event.event_id.length === 0) {
      if (event.event_type === "PHASE_HELD" && event.phase_id === phaseId) {
        ledger.add("INTEGRITY_INVALID");
        throw new StructuralFault("MISSING_EVENT_ID");
      }
    } else if (ids.has(event.event_id)) {
      ledger.add("SOURCE_CONFLICT");
      throw new StructuralFault("DUPLICATE_EVENT_ID");
    } else {
      ids.add(event.event_id);
    }
    if (typeof event.event_type === "string" && event.event_type.startsWith("RUN_")) {
      sawParent = true;
    }
    if (event.event_type === "PHASE_PASSED") sawPassed = true;
    if (event.event_type === "PHASE_STARTED" || event.event_type === "PHASE_RUNNING") {
      sawNonTerminal = true;
    }
    if (event.event_type === "PHASE_HELD" && event.phase_id === phaseId) {
      matching.push(event);
    }
  }
  if (matching.length === 0) {
    if (sawParent) return { absentBecause: "RUN_PARENT_TERMINAL" };
    if (sawPassed) return { absentBecause: "PHASE_PASSED" };
    if (sawNonTerminal) return { absentBecause: "NON_TERMINAL" };
    return { absentBecause: "MISSING_PHASE_HELD" };
  }
  for (const ev of matching) {
    if (
      ev.payload?.final !== result.final
      || ev.payload?.reason !== result.reason
      || ev.attempt !== result.attempt
    ) {
      ledger.add("SOURCE_CONFLICT");
      throw new StructuralFault("REPRESENTATION_CONFLICT");
    }
  }
  // closure 49: first-wins applies ONLY when exactly one canonical candidate
  if (matching.length > 1) {
    ledger.add("SOURCE_CONFLICT");
    throw new StructuralFault("CANDIDATE_MULTIPLICITY");
  }
  return { held: matching[0], journalCount: verified.count };
}

function verifySource(ctx, ledger, observedGen) {
  const { resolvedRoot, execDir, executionId, phaseId, item } = ctx;
  // (1) evidence root: validated once at the public boundary; the same
  // explicit authority location is reused — never a search start.
  if (!existsSync(execDir)) {
    ledger.add("SOURCE_MISSING");
    return { pinned: false };
  }
  // (3) snapshot: CURRENT.json via the single durable reader primitive.
  let current;
  try {
    lstatRegularOrMissing(join(execDir, "CURRENT.json"));
    current = readCurrent(execDir);
  } catch {
    ledger.add("INTEGRITY_INVALID");
    current = null;
  }
  let snapshot = null;
  if (current) {
    try {
      validateSnapshotStructure(current.snapshot);
      snapshot = current.snapshot;
    } catch {
      ledger.add("INTEGRITY_INVALID");
      snapshot = null;
    }
  }
  if (snapshot) {
    if (snapshot.execution_id !== executionId) {
      ledger.add("IDENTITY_MISMATCH");
    }
    // project binding: C3 snapshot fingerprint vs projection item identity.
    if (snapshot.repository_root_identity !== item.project_identity.repository_root_identity
      || snapshot.git_common_dir_identity !== item.project_identity.git_common_dir_identity) {
      ledger.add("IDENTITY_MISMATCH");
    }
  }
  // generation (owner parse is integrity; §5/§55)
  let ownerGen = null;
  if (snapshot) {
    const parsed = parseOwnerGeneration(snapshot);
    if (parsed.error) {
      ledger.add("INTEGRITY_INVALID");
    } else {
      ownerGen = parsed.gen;
      if (observedGen !== undefined && parsed.gen !== observedGen) {
        throw new StructuralFault("GENERATION_UNSTABLE");
      }
    }
  }
  // (4-7) journal framing + chain + unique canonical PHASE_HELD
  let held = null;
  let journalCount = 0;
  if (snapshot) {
    const store = new RunEvidenceStore({
      root: resolvedRoot,
      executionId,
      chainId: snapshot.chain_id,
      checkpointId: snapshot.checkpoint_id,
      repoRoot: null,
    });
    store.execDir = execDir;
    // result.json must exist before representation comparison (§4 step 8).
    const resultPath = join(phasesDir(execDir), phaseId, "result.json");
    let resultBytes;
    try {
      resultBytes = readSafeFileExclusive(resultPath, execDir);
    } catch {
      ledger.add("INTEGRITY_INVALID");
      resultBytes = null;
    }
    if (!resultBytes) {
      ledger.add("SOURCE_MISSING");
      return { pinned: false, ownerGen };
    }
    let result;
    try {
      result = JSON.parse(resultBytes.toString("utf8"));
    } catch {
      ledger.add("INTEGRITY_INVALID");
      return { pinned: false, ownerGen };
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      ledger.add("INTEGRITY_INVALID");
      return { pinned: false, ownerGen };
    }
    for (const key of ["phase_id", "final", "status", "attempt", "reason"]) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) {
        ledger.add("INTEGRITY_INVALID");
        return { pinned: false, ownerGen };
      }
    }
    if (result.phase_id !== phaseId) ledger.add("IDENTITY_MISMATCH");
    const sourceRecordDigest = sha256Hex(resultBytes);
    // (10-11) checkpoint phase-result hash pin — same frozen snapshot.
    const pinned = snapshot.phase_result_hashes?.[phaseId];
    if (typeof pinned !== "string" || !HEX64_RE.test(pinned)) {
      ledger.add("INTEGRITY_INVALID");
    } else if (!timingSafeHexEqual(pinned, sourceRecordDigest)) {
      ledger.add("INTEGRITY_INVALID");
    }
    // (12-13) run manifest + sidecar + manifest pin
    let manifest = null;
    let manifestSha = null;
    try {
      lstatRegularOrMissing(join(execDir, "manifest.json"));
      manifest = readRunManifest(execDir);
    } catch {
      ledger.add("INTEGRITY_INVALID");
      manifest = null;
    }
    if (!manifest) {
      ledger.add("SOURCE_MISSING");
      return { pinned: false, ownerGen };
    }
    if (manifest.execution_id !== executionId) {
      ledger.add("IDENTITY_MISMATCH");
    }
    try {
      const shaBytes = readSafeFileExclusive(manifestShaPath(execDir), execDir);
      if (!shaBytes) {
        ledger.add("SOURCE_MISSING");
        return { pinned: false, ownerGen };
      }
      const sha = shaBytes.toString("utf8").trim();
      if (!HEX64_RE.test(sha)) {
        ledger.add("INTEGRITY_INVALID");
      } else {
        manifestSha = sha;
      }
    } catch {
      ledger.add("INTEGRITY_INVALID");
      return { pinned: false, ownerGen };
    }
    const phasePins = Array.isArray(manifest.phase_results)
      ? manifest.phase_results.filter((row) => row && row.phase_id === phaseId)
      : [];
    if (phasePins.length > 1) {
      ledger.add("SOURCE_CONFLICT");
    } else if (phasePins.length === 1) {
      if (typeof phasePins[0].result_hash !== "string"
        || !HEX64_RE.test(phasePins[0].result_hash)
        || !timingSafeHexEqual(phasePins[0].result_hash, sourceRecordDigest)) {
        ledger.add("INTEGRITY_INVALID");
      }
    }
    // (5-7) journal + unique candidate; eligibility from recomputed bytes.
    let selection;
    try {
      selection = selectPhaseHeld(store, phaseId, result, ledger, execDir);
    } catch (err) {
      // Defensive: every throw site records a fault first; an empty ledger
      // here means an unmapped failure — fail closed as integrity.
      if (err instanceof StructuralFault && ledger.resolve() === "VERIFIED_CURRENT") {
        ledger.add("INTEGRITY_INVALID");
      }
      return { pinned: false, ownerGen };
    }
    if (selection.absentBecause) {
      if (selection.absentBecause === "MISSING_PHASE_HELD") {
        ledger.add("SOURCE_MISSING");
      } else {
        // RUN_* parent terminal / PASS terminal / non-terminal ⇒ ineligible.
        ledger.add("STRUCTURAL_INVALID");
      }
      return { pinned: false, ownerGen };
    }
    held = selection.held;
    journalCount = selection.journalCount;
    if (held.execution_id !== undefined && held.execution_id !== executionId) {
      ledger.add("IDENTITY_MISMATCH");
    }
    if (held.phase_id !== phaseId) ledger.add("IDENTITY_MISMATCH");
    if (held.event_id !== item.source_record_id) ledger.add("IDENTITY_MISMATCH");
    // (16-eligibility) reason/profile enforcement from recomputed bytes.
    const elig = eligibilityFromResult(result);
    if (elig === "INCOMPLETE_PUBLICATION") {
      ledger.add("SOURCE_MISSING");
    } else if (elig) {
      ledger.add("STRUCTURAL_INVALID");
    }
    // profile binding vs projection item (closure 34: representation conflict).
    if (item.source_record_type !== ELIGIBLE_PROFILE_KIND) ledger.add("STRUCTURAL_INVALID");
    if (item.failure_finding_discriminator !== result.reason) ledger.add("SOURCE_CONFLICT");
    if (item.attempt_identity.attempt !== result.attempt) ledger.add("IDENTITY_MISMATCH");
    if (item.observed_outcome_class !== result.final) ledger.add("SOURCE_CONFLICT");
    if (item.source_system !== SOURCE_AUTHORITY_IDENTITY_FROZEN) ledger.add("IDENTITY_MISMATCH");
    // evidence-ref cross-check (closure 30) + evidence-set digest recompute.
    if (manifestSha !== null) {
      const cmpTuple = (a, b) => {
        if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
        if (a.identity !== b.identity) return a.identity < b.identity ? -1 : 1;
        if (a.digest !== b.digest) return a.digest < b.digest ? -1 : 1;
        return 0;
      };
      const recomputedRefs = [
        { kind: "evidence_event", identity: held.event_id, digest: held.event_sha256 },
        { kind: "evidence_manifest", identity: executionId, digest: manifestSha },
        { kind: "artifact", identity: phaseId, digest: sourceRecordDigest },
      ].sort(cmpTuple);
      const itemRefs = [...item.evidence_refs].sort(cmpTuple);
      if (canonical(recomputedRefs) !== canonical(itemRefs)) {
        ledger.add("SOURCE_CONFLICT");
      }
    }
    try {
      const recomputedSet = deriveEvidenceSetDigest(item.evidence_refs);
      if (!timingSafeHexEqual(recomputedSet, item.evidence_set_digest)) {
        ledger.add("SOURCE_CONFLICT");
      }
    } catch {
      ledger.add("SOURCE_CONFLICT");
    }
    // generation cross-check: result-carried generation vs the owner
    // snapshot (§5: mandatory, missing result field cannot skip).
    const resultGenParsed = parseResultGeneration(result);
    if (resultGenParsed.error) {
      ledger.add("INTEGRITY_INVALID");
    } else if (ownerGen !== null && resultGenParsed.gen !== ownerGen) {
      ledger.add("STALE_GENERATION");
    }
    return {
      pinned: true,
      ownerGen,
      resultGen: resultGenParsed.error ? null : resultGenParsed.gen,
      journalCount,
      heldEventId: held.event_id,
      heldSha: held.event_sha256,
      sourceRecordDigest,
      manifestSha,
      attempt: result.attempt,
    };
  }
  return { pinned: false, ownerGen };
}

// ---------------------------------------------------------------------------
// One full G1 → R1 → S → G2 → R2 → P pipeline (admission §7).
// ---------------------------------------------------------------------------

function runRound(ctx, ledger, item) {
  // Deterministic corruption/eligibility faults recorded inside verifySource
  // are round-completing (retry cannot cure them); GENERATION_UNSTABLE marks
  // owner drift inside the round and triggers a full retry.
  try {
    // G1
    const g1 = collectGeneration(ctx, ledger);
    // R1
    const r1 = collectRevocation(ctx.resolvedRoot, item, ledger);
    revocationFaults(ledger, r1);
    // S (steps 1–15)
    const s = verifySource(ctx, ledger, g1.gen);
    // Generation dynamics vs the projection-bound generation. Computed from
    // the durable owner read (G1), independent of source-publication state:
    // staleness/advance must surface even when the publication is absent
    // (closure 34 layering: REVOCATION/STALENESS rank over ABSENCE).
    if (g1.gen !== undefined) {
      if (g1.gen > item.authority_generation) {
        ledger.add("AUTHORITY_CHANGED");
      } else if (g1.gen < item.authority_generation) {
        ledger.add("STALE_GENERATION");
      }
    }
    // G2
    const g2 = collectGeneration(ctx, ledger);
    // R2
    const r2 = collectRevocation(ctx.resolvedRoot, item, ledger);
    // P: re-pin journal count, candidate uniqueness, eligibility, digests
    // (closure 31: full re-derivation, not just count/digest equality).
    const p = rePin(ctx, ledger, s, item);
    const stable = g1.gen === g2.gen && revocationStable(r1, r2) && p;
    return { stable, rev: r1, s };
  } catch (err) {
    if (err instanceof StructuralFault) {
      if (err.internalCode === "GENERATION_UNSTABLE") {
        return { stable: false, rev: null, s: { pinned: false } };
      }
      return { stable: true, rev: null, s: { pinned: false } };
    }
    throw err;
  }
}

function collectGeneration(ctx, ledger) {
  let current = null;
  try {
    lstatRegularOrMissing(join(ctx.execDir, "CURRENT.json"));
    current = readCurrent(ctx.execDir);
  } catch {
    ledger.add("INTEGRITY_INVALID");
  }
  if (!current) {
    if (!ledger.has("INTEGRITY_INVALID")) ledger.add("SOURCE_MISSING");
    return { gen: undefined };
  }
  const parsed = parseOwnerGeneration(current.snapshot);
  if (parsed.error) {
    ledger.add("INTEGRITY_INVALID");
    return { gen: undefined };
  }
  return { gen: parsed.gen };
}

function rePin(ctx, ledger, s, item) {
  // Re-derives the journal count, the unique canonical candidate, eligibility
  // and every pinned digest from fresh bytes; any drift ⇒ instability.
  if (!s.pinned) return true;
  const fresh = verifySource(ctx, makeLedger(), undefined);
  if (!fresh.pinned) return false;
  return (
    fresh.journalCount === s.journalCount
    && fresh.heldEventId === s.heldEventId
    && fresh.heldSha === s.heldSha
    && fresh.sourceRecordDigest === s.sourceRecordDigest
    && fresh.manifestSha === s.manifestSha
    && fresh.ownerGen === s.ownerGen
    && fresh.resultGen === s.resultGen
  );
}

// ---------------------------------------------------------------------------
// Result assembly (closed shape; data minimization; deterministic form).
// ---------------------------------------------------------------------------

function buildResult(status, ctx, extras = {}) {
  const item = ctx.item;
  return Object.freeze({
    status,
    incident_id: item.incident_id,
    source_record_id: item.source_record_id,
    execution_id: ctx.executionId,
    phase_id: ctx.phaseId,
    projection_digest: ctx.envelope.projection_digest,
    projection_item_id: item.projection_item_id,
    source_record_digest: extras.sourceRecordDigest ?? null,
    verified_generation: extras.verifiedGeneration ?? null,
    authority_state_digest: extras.authorityStateDigest ?? null,
    authority_replay_generation: extras.authorityReplayGeneration ?? null,
    result_authority: RESULT_AUTHORITY,
    result_storage: RESULT_STORAGE,
    projection_mutated: PROJECTION_MUTATED,
    source_mutated: SOURCE_MUTATED,
    raw_log_mutated: RAW_LOG_MUTATED,
  });
}

function buildFailure(status) {
  // Failures carry only the closed status; no input echo, no paths, no
  // internals (admission §12/§13).
  return Object.freeze({
    status,
    incident_id: null,
    source_record_id: null,
    execution_id: null,
    phase_id: null,
    projection_digest: null,
    projection_item_id: null,
    source_record_digest: null,
    verified_generation: null,
    authority_state_digest: null,
    authority_replay_generation: null,
    result_authority: RESULT_AUTHORITY,
    result_storage: RESULT_STORAGE,
    projection_mutated: PROJECTION_MUTATED,
    source_mutated: SOURCE_MUTATED,
    raw_log_mutated: RAW_LOG_MUTATED,
  });
}

// ---------------------------------------------------------------------------
// Public API. Explicit call, one item, offline, read-only.
// ---------------------------------------------------------------------------

export function verifyCurrentIncident(input) {
  let ctx;
  try {
    ctx = validateInputs(input, { forConsume: false });
  } catch (err) {
    if (err instanceof StructuralFault) {
      if (err.internalCode === "ITEM_IDENTITY_MISMATCH"
        || err.internalCode === "ITEM_NOT_IN_DOCUMENT"
        || err.internalCode === "ITEM_TAMPERED_VS_DOCUMENT"
        || err.internalCode === "SELECTOR_EXECUTION_MISMATCH"
        || err.internalCode === "SELECTOR_PHASE_MISMATCH"
        || err.internalCode === "ADMISSION_IDENTITY_MISMATCH"
        || err.internalCode === "EVENT_REF_IDENTITY_MISMATCH"
        || err.internalCode === "MANIFEST_REF_IDENTITY_MISMATCH"
        || err.internalCode === "EVENT_REF_AMBIGUOUS") {
        return { result: buildFailure("IDENTITY_MISMATCH"), receipt: null };
      }
      return { result: buildFailure("STRUCTURAL_INVALID"), receipt: null };
    }
    throw err;
  }
  let root;
  try {
    root = assertValidEvidenceRoot(ctx.evidenceRootString, null);
    root = assertStorageRootInNamespace(root);
  } catch {
    return { result: buildFailure("STRUCTURAL_INVALID"), receipt: null };
  }
  let execDir;
  try {
    execDir = resolveExecDir(root, ctx.executionId);
  } catch {
    return { result: buildFailure("STRUCTURAL_INVALID"), receipt: null };
  }
  const runCtx = { resolvedRoot: root, execDir, executionId: ctx.executionId, phaseId: ctx.phaseId, item: ctx.item };

  // MAX_RETRIES = 2: initial attempt + exactly 2 retries = 3 full pipelines.
  let ledger = makeLedger();
  let last = runRound(runCtx, ledger, ctx.item);
  let retries = 0;
  while (!last.stable && retries < MAX_RETRIES) {
    retries += 1;
    ledger = makeLedger();
    last = runRound(runCtx, ledger, ctx.item);
  }
  if (!last.stable) {
    return { result: buildFailure("AUTHORITY_CHANGED"), receipt: null };
  }
  const status = ledger.resolve();
  if (status !== "VERIFIED_CURRENT") {
    return { result: buildFailure(status), receipt: null };
  }
  const r = last.rev;
  if (r.unavailable !== undefined) {
    return { result: buildFailure("REVOCATION_UNAVAILABLE"), receipt: null };
  }
  const facts = Object.freeze({
    projection_digest: ctx.envelope.projection_digest,
    projection_item_id: ctx.item.projection_item_id,
    incident_id: ctx.item.incident_id,
    source_record_id: ctx.item.source_record_id,
    source_record_digest: last.s.sourceRecordDigest,
    execution_id: ctx.executionId,
    phase_id: ctx.phaseId,
    verified_generation: last.s.ownerGen,
    writer_state_digest: r.writer.authority_input_digest,
    cited_state_digest: r.cited.authority_input_digest,
    writer_generation: r.writer.generation,
    cited_generation: r.cited.generation,
  });
  const receipt = new CurrentVerificationReceipt(facts);
  ACTIVE_RECEIPTS.add(receipt);
  const result = buildResult("VERIFIED_CURRENT", ctx, {
    sourceRecordDigest: last.s.sourceRecordDigest,
    verifiedGeneration: last.s.ownerGen,
    authorityStateDigest: r.writer.authority_input_digest,
    authorityReplayGeneration: r.writer.replay_generation,
  });
  return { result, receipt };
}

export function consumeCurrentVerificationReceipt(input) {
  // Receipt layer resolves BEFORE any await/durable recheck (closure 43):
  // classification + synchronous single-use mark happen first.
  let receiptCode = null;
  let receiptRef = null;
  let facts = null;
  const inputIsObject = input !== null && typeof input === "object" && !Array.isArray(input);
  if (inputIsObject && Object.prototype.hasOwnProperty.call(input, "receipt")) {
    // descriptor-first read: never invoke a caller getter on the receipt key
    const rdesc = Object.getOwnPropertyDescriptor(input, "receipt");
    if (!rdesc || rdesc.get !== undefined || rdesc.set !== undefined
      || !Object.prototype.hasOwnProperty.call(rdesc, "value")) {
      receiptCode = "RECEIPT_FORGED";
    } else {
      const code = classifyReceipt(rdesc.value);
      if (code === "ACTIVE") {
        receiptRef = rdesc.value;
        facts = rdesc.value.facts();
      } else {
        receiptCode = code;
      }
    }
  } else {
    receiptCode = "RECEIPT_FORGED";
  }
  let ctx;
  try {
    ctx = validateInputs(input, { forConsume: true });
  } catch (err) {
    if (err instanceof StructuralFault) {
      // STRUCTURAL beats RECEIPT (precedence): malformed input is never
      // masked by receipt state — and the receipt must already be marked
      // used if it was presented validly.
      if (receiptRef) {
        ACTIVE_RECEIPTS.delete(receiptRef);
        CONSUMED_RECEIPTS.add(receiptRef);
      }
      const identityLike = err.internalCode === "ITEM_IDENTITY_MISMATCH"
        || err.internalCode === "ITEM_NOT_IN_DOCUMENT"
        || err.internalCode === "ITEM_TAMPERED_VS_DOCUMENT"
        || err.internalCode === "SELECTOR_EXECUTION_MISMATCH"
        || err.internalCode === "SELECTOR_PHASE_MISMATCH"
        || err.internalCode === "ADMISSION_IDENTITY_MISMATCH"
        || err.internalCode === "EVENT_REF_IDENTITY_MISMATCH"
        || err.internalCode === "MANIFEST_REF_IDENTITY_MISMATCH"
        || err.internalCode === "EVENT_REF_AMBIGUOUS";
      return {
        result: buildFailure(identityLike ? "IDENTITY_MISMATCH" : "STRUCTURAL_INVALID"),
      };
    }
    throw err;
  }
  // The receipt fault is a RECEIPT-layer fault: it must compete in the frozen
  // total precedence (INTEGRITY beats RECEIPT beats REVOCATION), so it is
  // recorded and the consume-time recheck still runs. The exactly-once mark
  // itself stays synchronous BEFORE any durable recheck (closure 43).
  const receiptLedger = makeLedger();
  let bindsMatch = false;
  if (receiptCode === null) {
    // Synchronous exactly-once mark BEFORE any durable recheck (closure 43).
    ACTIVE_RECEIPTS.delete(receiptRef);
    CONSUMED_RECEIPTS.add(receiptRef);
    // Receipt binding comparison (closure 35): re-derive ALL binds from the
    // presented input; mismatch ⇒ RECEIPT_FORGED, which outranks revocation.
    bindsMatch =
      facts.projection_digest === ctx.envelope.projection_digest
      && facts.projection_item_id === ctx.item.projection_item_id
      && facts.incident_id === ctx.item.incident_id
      && facts.source_record_id === ctx.item.source_record_id
      && facts.execution_id === ctx.executionId
      && facts.phase_id === ctx.phaseId;
    if (!bindsMatch) receiptLedger.add("RECEIPT_FORGED");
  } else {
    receiptLedger.add(receiptCode);
  }

  let root;
  try {
    root = assertValidEvidenceRoot(ctx.evidenceRootString, null);
    root = assertStorageRootInNamespace(root);
  } catch {
    return { result: buildFailure("STRUCTURAL_INVALID") };
  }
  let execDir;
  try {
    execDir = resolveExecDir(root, ctx.executionId);
  } catch {
    return { result: buildFailure("STRUCTURAL_INVALID") };
  }
  const runCtx = { resolvedRoot: root, execDir, executionId: ctx.executionId, phaseId: ctx.phaseId, item: ctx.item };
  let ledger = makeLedger();
  let last = runRound(runCtx, ledger, ctx.item);
  let retries = 0;
  while (!last.stable && retries < MAX_RETRIES) {
    retries += 1;
    ledger = makeLedger();
    last = runRound(runCtx, ledger, ctx.item);
  }
  if (!last.stable) {
    receiptLedger.add("AUTHORITY_CHANGED");
  } else {
    // fold every durable fault into the receipt-carrying ledger
    const durableStatus = ledger.resolve();
    if (durableStatus !== "VERIFIED_CURRENT") receiptLedger.add(durableStatus);
  }
  const status = receiptLedger.resolve();
  if (status !== "VERIFIED_CURRENT") {
    return { result: buildFailure(status) };
  }
  // Consume-time generation dynamics vs the receipt-bound generation
  // (closure 32: advance ⇒ AUTHORITY_CHANGED; regression ⇒ STALE_GENERATION).
  const observed = last.s.ownerGen;
  if (observed !== null && facts.verified_generation !== null) {
    if (observed > facts.verified_generation) {
      return { result: buildFailure("AUTHORITY_CHANGED") };
    }
    if (observed < facts.verified_generation) {
      return { result: buildFailure("STALE_GENERATION") };
    }
  }
  // Revocation-state drift vs receipt binds (§10: authority changed between
  // verify and consume ⇒ fail-closed).
  const r = last.rev;
  if (r.unavailable !== undefined) {
    return { result: buildFailure("REVOCATION_UNAVAILABLE") };
  }
  const writerDigest = r.writer.authority_input_digest;
  const citedDigest = r.cited.authority_input_digest;
  if (!timingSafeHexEqual(writerDigest ?? "", facts.writer_state_digest ?? "")
    || !timingSafeHexEqual(citedDigest ?? "", facts.cited_state_digest ?? "")) {
    return { result: buildFailure("AUTHORITY_CHANGED") };
  }
  if (last.s.sourceRecordDigest === null
    || !timingSafeHexEqual(last.s.sourceRecordDigest, facts.source_record_digest ?? "")) {
    return { result: buildFailure("SOURCE_CONFLICT") };
  }
  const result = buildResult("VERIFIED_CURRENT", ctx, {
    sourceRecordDigest: last.s.sourceRecordDigest,
    verifiedGeneration: last.s.ownerGen,
    authorityStateDigest: writerDigest,
    authorityReplayGeneration: r.writer.replay_generation,
  });
  return { result };
}

export function isCurrentVerificationReceipt(value) {
  return value != null && ACTIVE_RECEIPTS.has(value);
}
