// src/learning/incidents/lifecycle-terminal-adapter.mjs
//
// Offline C3 PHASE_HELD → INCIDENT_OBSERVED adapter.
// Not a production emitter. Not a second writer. Not lifecycle authority.

import {
  existsSync,
  openSync,
  readSync,
  fstatSync,
  closeSync,
  lstatSync,
  readFileSync,
  constants as fsConstants,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import {
  RunEvidenceStore,
  assertValidEvidenceRoot,
  EvidenceHoldError,
  journalDir,
  phasesDir,
  journalFileName,
  DEFAULT_MAX_FREE_TEXT_BYTES,
} from "../../evidence/run-evidence-store.mjs";
import {
  readRunManifest,
  ManifestHoldError,
  manifestShaPath,
} from "../../evidence/run-manifest.mjs";
import {
  assertNotSymlink,
  assertInsideRoot,
  assertPathComponentsNotSymlink,
  resolveSafeRoot,
  sha256Hex,
  C2dHoldError,
  HOLD,
} from "../../c2d/fs-atomic.mjs";
import {
  resolveExecDir,
  readCurrent,
  validateSnapshotStructure,
} from "../../c2d/checkpoint-store.mjs";
import { validateExecutionId } from "../../c2d/execution-id.mjs";
import {
  SCHEMA_VERSION,
  INCIDENT_OBS_SCHEMA,
  TRANSFER_CODES,
  TransferMetricsError,
  ALLOWED_ROOT_PREFIX,
} from "../transfer-metrics/schema.mjs";
import { assertMintedPrincipal } from "../transfer-metrics/identities.mjs";

export const LIFECYCLE_TERMINAL_DISCRIMINATORS_V1 = Object.freeze([
  "REVIEWER_HOLD",
  "REPAIR_BUDGET_EXHAUSTED",
]);

export const SOURCE_AUTHORITY_IDENTITY = "autoloop.lifecycle-runner";
export const MAX_TERMINALS_PER_CALL = 1;
export const HISTORY_SCAN = "NONE";
export const MAX_SOURCE_BYTES = DEFAULT_MAX_FREE_TEXT_BYTES;

export const ADAPTER_CODES = Object.freeze({
  INPUT_INVALID: "LIFECYCLE_TERMINAL_ADAPTER_INPUT_INVALID",
  PATH_UNSAFE: TRANSFER_CODES.PATH_UNSAFE,
  ONE_SOURCE_BOUND: "LIFECYCLE_TERMINAL_ONE_SOURCE_BOUND",
  SOURCE_REFERENCE_MISSING: "LIFECYCLE_TERMINAL_SOURCE_REFERENCE_MISSING",
  INCOMPLETE_PUBLICATION: "LIFECYCLE_TERMINAL_INCOMPLETE_PUBLICATION",
  JOURNAL_CORRUPT: "LIFECYCLE_TERMINAL_JOURNAL_CORRUPT",
  DUPLICATE_EVENT_ID: "LIFECYCLE_TERMINAL_DUPLICATE_EVENT_ID",
  MISSING_EVENT_ID: "LIFECYCLE_TERMINAL_MISSING_EVENT_ID",
  MISSING_PHASE_HELD: "LIFECYCLE_TERMINAL_MISSING_PHASE_HELD",
  PARENT_TERMINAL: "LIFECYCLE_TERMINAL_PARENT_REJECTED",
  TERMINAL_INELIGIBLE: "LIFECYCLE_TERMINAL_INELIGIBLE",
  PHASE_PASSED: "LIFECYCLE_TERMINAL_PHASE_PASSED",
  NON_TERMINAL: "LIFECYCLE_TERMINAL_NON_TERMINAL",
  REASON_NOT_ALLOWLISTED: "LIFECYCLE_TERMINAL_REASON_NOT_ALLOWLISTED",
  REASON_MISSING: "LIFECYCLE_TERMINAL_REASON_MISSING",
  REASON_FREE_FORM: "LIFECYCLE_TERMINAL_REASON_FREE_FORM",
  RESULT_MISSING: "LIFECYCLE_TERMINAL_RESULT_MISSING",
  RESULT_MALFORMED: "LIFECYCLE_TERMINAL_RESULT_MALFORMED",
  RESULT_VERDICT_MISMATCH: "LIFECYCLE_TERMINAL_RESULT_VERDICT_MISMATCH",
  RESULT_REASON_MISMATCH: "LIFECYCLE_TERMINAL_RESULT_REASON_MISMATCH",
  PHASE_ID_MISMATCH: "LIFECYCLE_TERMINAL_PHASE_ID_MISMATCH",
  PHASE_RESULT_HASH_MISSING: "LIFECYCLE_TERMINAL_PHASE_RESULT_HASH_MISSING",
  PHASE_RESULT_HASH_MISMATCH: "LIFECYCLE_TERMINAL_PHASE_RESULT_HASH_MISMATCH",
  MANIFEST_MISSING: "LIFECYCLE_TERMINAL_MANIFEST_MISSING",
  MANIFEST_IDENTITY_MISMATCH: "LIFECYCLE_TERMINAL_MANIFEST_IDENTITY_MISMATCH",
  MANIFEST_HASH_MISMATCH: "LIFECYCLE_TERMINAL_MANIFEST_HASH_MISMATCH",
  SOURCE_IDENTITY_BINDING_MISMATCH: "SOURCE_IDENTITY_BINDING_MISMATCH",
  SOURCE_CONFLICT: "LIFECYCLE_TERMINAL_SOURCE_CONFLICT",
  RECEIPT_FORGED: "LIFECYCLE_TERMINAL_RECEIPT_FORGED",
  RECEIPT_REPLAY: "LIFECYCLE_TERMINAL_RECEIPT_REPLAY",
  SYNTHESIZED_TERMINAL: "LIFECYCLE_TERMINAL_SYNTHESIZED",
  STALE_GENERATION: TRANSFER_CODES.STALE_GENERATION,
  UNAVAILABLE: "LIFECYCLE_TERMINAL_UNAVAILABLE",
});

const OBSERVE_KEYS = Object.freeze([
  "authoritativeSourceReference",
  "expectedIdentityBinding",
  "transferMetricsWriter",
  "observerPrincipal",
]);
const REF_KEYS = Object.freeze(["evidenceRoot", "execution_id", "phase_id"]);
const BINDING_KEYS = Object.freeze([
  "project_identity",
  "task_identity",
  "attempt_identity",
  "writer",
  "revocation_generation",
]);
const FORBIDDEN_INPUT_KEYS = Object.freeze([
  "lifecycleResult",
  "terminal",
  "verdict",
  "source_record_digest",
  "source_identity_key",
  "incident_id",
  "event_id",
  "recorded_at",
  "output_path",
  "glob",
  "history",
  "history_range",
  "batch",
  "is_verified",
  "receipt",
]);
const PHASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FREE_FORM_REASON_RE = /[:\s]|exception:|UNCLASSIFIED_HOLD/;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

const VERIFIED_TERMINAL_RECEIPTS = new WeakSet();

class VerifiedTerminalReceipt {
  constructor(facts) {
    for (const key of Object.keys(facts)) this[key] = facts[key];
    Object.freeze(this);
  }
}

function rejected(code) {
  return Object.freeze({ status: "REJECTED", code });
}

function conflict(code) {
  return Object.freeze({ status: "CONFLICT", code });
}

function isResultEnvelope(value) {
  return value && typeof value === "object" && typeof value.status === "string" && typeof value.code === "string"
    && (value.status === "REJECTED" || value.status === "CONFLICT");
}

function hasForbiddenKeys(obj) {
  if (obj == null || typeof obj !== "object") return false;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_INPUT_KEYS.includes(key)) return true;
  }
  return false;
}

function assertKnownOwnKeys(obj, allowed) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    return rejected(ADAPTER_CODES.INPUT_INVALID);
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    return rejected(ADAPTER_CODES.INPUT_INVALID);
  }
  if (hasForbiddenKeys(obj)) return rejected(ADAPTER_CODES.INPUT_INVALID);
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (!allowed.includes(key)) return rejected(ADAPTER_CODES.INPUT_INVALID);
  }
  return null;
}

function mapThrown(err) {
  if (isResultEnvelope(err)) return err;
  if (err instanceof TransferMetricsError) {
    if (err.code === TRANSFER_CODES.IDEMPOTENCY_CONFLICT) {
      return conflict(TRANSFER_CODES.IDEMPOTENCY_CONFLICT);
    }
    return rejected(err.code);
  }
  if (err instanceof EvidenceHoldError) {
    if (err.code === "JOURNAL_INTEGRITY_FAILURE") return rejected(ADAPTER_CODES.JOURNAL_CORRUPT);
    if (err.code === "PERSISTENCE_ROOT_INVALID") return rejected(ADAPTER_CODES.PATH_UNSAFE);
    return rejected(ADAPTER_CODES.INCOMPLETE_PUBLICATION);
  }
  if (err instanceof ManifestHoldError) {
    if (err.code === "MANIFEST_SHA_MISMATCH") return rejected(ADAPTER_CODES.MANIFEST_HASH_MISMATCH);
    return rejected(ADAPTER_CODES.MANIFEST_MISSING);
  }
  if (err instanceof C2dHoldError) {
    if (err.code === HOLD.SYMLINK_REJECTED || err.code === HOLD.PATH_TRAVERSAL || err.code === HOLD.INVALID_EXECUTION_ID) {
      return rejected(ADAPTER_CODES.PATH_UNSAFE);
    }
    if (err.code === HOLD.SNAPSHOT_CHECKSUM_MISMATCH || err.code === HOLD.CHECKPOINT_CORRUPT) {
      return rejected(ADAPTER_CODES.INCOMPLETE_PUBLICATION);
    }
    return rejected(ADAPTER_CODES.PATH_UNSAFE);
  }
  throw err;
}

function assertStorageRootInNamespace(root) {
  if (typeof root !== "string" || root.length === 0) {
    return rejected(ADAPTER_CODES.PATH_UNSAFE);
  }
  if (!root.startsWith("/") || root.includes("\0") || root.split(sep).includes("..")) {
    return rejected(ADAPTER_CODES.PATH_UNSAFE);
  }
  // $HOME ITSELF is refused; the namespace boundary below is the real fence
  // (the portable default learning root lives under ~/.autoloop).
  const home = resolve(homedir());
  const lexical = resolve(root);
  if (lexical === home) {
    return rejected(ADAPTER_CODES.PATH_UNSAFE);
  }
  const prefix = ALLOWED_ROOT_PREFIX.endsWith(sep) ? ALLOWED_ROOT_PREFIX : ALLOWED_ROOT_PREFIX + sep;
  const allowedRoot = ALLOWED_ROOT_PREFIX.replace(/\/$/, "");
  if (lexical !== allowedRoot && !lexical.startsWith(prefix)) {
    return rejected(ADAPTER_CODES.PATH_UNSAFE);
  }
  try {
    const resolved = resolveSafeRoot(root);
    assertNotSymlink(resolved);
    assertPathComponentsNotSymlink(resolved, { allowMissingLeaf: false });
    if (resolved !== allowedRoot && !resolved.startsWith(prefix)) {
      return rejected(ADAPTER_CODES.PATH_UNSAFE);
    }
    if (resolved === home) {
      return rejected(ADAPTER_CODES.PATH_UNSAFE);
    }
  } catch (err) {
    return mapThrown(err);
  }
  return null;
}

function assertSafeRegularFile(absPath, root) {
  assertInsideRoot(root, absPath);
  assertPathComponentsNotSymlink(absPath, { allowMissingLeaf: true });
  assertNotSymlink(absPath);
  if (!existsSync(absPath)) return null;
  const st = lstatSync(absPath);
  if (st.isSymbolicLink()) {
    throw new C2dHoldError(HOLD.SYMLINK_REJECTED, "symlink rejected");
  }
  if (!st.isFile()) {
    throw new C2dHoldError(HOLD.PATH_TRAVERSAL, "non-regular file");
  }
  if (st.nlink !== 1) {
    throw new C2dHoldError(HOLD.PATH_TRAVERSAL, "hardlink rejected");
  }
  if (st.size > MAX_SOURCE_BYTES) {
    throw new EvidenceHoldError("DURABLE_EVIDENCE_SECRET_RISK", "source exceeds byte bound");
  }
  return st;
}

function readNoFollow(absPath, root) {
  const before = assertSafeRegularFile(absPath, root);
  if (!before) return null;
  const fd = openSync(absPath, fsConstants.O_RDONLY | NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_SOURCE_BYTES) {
      throw new C2dHoldError(HOLD.PATH_TRAVERSAL, "unsafe fd");
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

function identitiesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function selectPhaseHeld(store, phaseId, result) {
  const verified = store.verifyJournal();
  const journalRoot = journalDir(store.execDir);
  const ids = new Set();
  const matching = [];
  let sawParent = false;
  let sawNonTerminal = false;
  let sawPassed = false;
  for (let seq = 1; seq <= verified.count; seq++) {
    const path = join(journalRoot, journalFileName(seq));
    assertSafeRegularFile(path, store.execDir);
    const { event } = store.readEvent(seq);
    if (typeof event.event_id !== "string" || event.event_id.length === 0) {
      if (event.event_type === "PHASE_HELD" && event.phase_id === phaseId) {
        return rejected(ADAPTER_CODES.MISSING_EVENT_ID);
      }
    } else if (ids.has(event.event_id)) {
      return rejected(ADAPTER_CODES.DUPLICATE_EVENT_ID);
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
    if (sawParent) return rejected(ADAPTER_CODES.PARENT_TERMINAL);
    if (sawPassed) return rejected(ADAPTER_CODES.PHASE_PASSED);
    if (sawNonTerminal) return rejected(ADAPTER_CODES.NON_TERMINAL);
    return rejected(ADAPTER_CODES.MISSING_PHASE_HELD);
  }
  for (const ev of matching) {
    if (
      ev.payload?.final !== result.final
      || ev.payload?.reason !== result.reason
      || ev.attempt !== result.attempt
    ) {
      return conflict(ADAPTER_CODES.SOURCE_CONFLICT);
    }
  }
  return matching[0];
}

function eligibility(result, held) {
  if (result.synthesized === true) return rejected(ADAPTER_CODES.SYNTHESIZED_TERMINAL);
  if (result.final === "PASS" || held.event_type === "PHASE_PASSED") {
    return rejected(ADAPTER_CODES.PHASE_PASSED);
  }
  if (result.final !== "HOLD" || held.event_type !== "PHASE_HELD") {
    return rejected(ADAPTER_CODES.TERMINAL_INELIGIBLE);
  }
  if (result.status === "running" || result.status === "started") {
    return rejected(ADAPTER_CODES.NON_TERMINAL);
  }
  if (result.reason == null || result.reason === "") {
    return rejected(ADAPTER_CODES.REASON_MISSING);
  }
  if (typeof result.reason !== "string") {
    return rejected(ADAPTER_CODES.REASON_NOT_ALLOWLISTED);
  }
  if (FREE_FORM_REASON_RE.test(result.reason) && !LIFECYCLE_TERMINAL_DISCRIMINATORS_V1.includes(result.reason)) {
    return rejected(ADAPTER_CODES.REASON_FREE_FORM);
  }
  if (!LIFECYCLE_TERMINAL_DISCRIMINATORS_V1.includes(result.reason)) {
    return rejected(ADAPTER_CODES.REASON_NOT_ALLOWLISTED);
  }
  if (!Number.isInteger(result.attempt) || result.attempt < 0) {
    return rejected(ADAPTER_CODES.INCOMPLETE_PUBLICATION);
  }
  return null;
}

function bindIdentities(binder, expected, attemptIdentity, projectIdentity) {
  if (!binder) {
    throw new TransferMetricsError(TRANSFER_CODES.TASK_UNBOUND, "identityBinder required");
  }
  try {
    binder.bindProject(projectIdentity);
    binder.bindTask(expected.task_identity);
    binder.bindAttempt(attemptIdentity);
  } catch (err) {
    if (err instanceof TransferMetricsError) throw err;
    throw err;
  }
  if (expected.attempt_identity) {
    if (
      expected.attempt_identity.execution_id !== attemptIdentity.execution_id
      || expected.attempt_identity.attempt !== attemptIdentity.attempt
    ) {
      throw rejected(ADAPTER_CODES.SOURCE_IDENTITY_BINDING_MISMATCH);
    }
  }
  if (!identitiesEqual(expected.project_identity, projectIdentity)) {
    throw rejected(ADAPTER_CODES.SOURCE_IDENTITY_BINDING_MISMATCH);
  }
}

function mintReceipt(facts) {
  const receipt = new VerifiedTerminalReceipt(facts);
  VERIFIED_TERMINAL_RECEIPTS.add(receipt);
  return receipt;
}

function assertReceipt(receipt) {
  if (receipt == null || typeof receipt !== "object") {
    return rejected(ADAPTER_CODES.RECEIPT_FORGED);
  }
  if (!VERIFIED_TERMINAL_RECEIPTS.has(receipt)) {
    if (Object.prototype.hasOwnProperty.call(receipt, "is_verified") || receipt.role || receipt.verified === true) {
      return rejected(ADAPTER_CODES.RECEIPT_FORGED);
    }
    return rejected(ADAPTER_CODES.RECEIPT_REPLAY);
  }
  return null;
}

/**
 * Verify one C3 PHASE_HELD publication. Mints an opaque non-authoritative receipt.
 * Does not append. Does not import lifecycle-runner.
 */
export function verifyLifecycleHeldTerminal({
  authoritativeSourceReference,
  expectedIdentityBinding,
  identityBinder,
} = {}) {
  const refErr = assertKnownOwnKeys(authoritativeSourceReference, REF_KEYS);
  if (refErr) return refErr;
  const bindErr = assertKnownOwnKeys(expectedIdentityBinding, BINDING_KEYS);
  if (bindErr) return bindErr;
  if (!authoritativeSourceReference.evidenceRoot || !authoritativeSourceReference.execution_id || !authoritativeSourceReference.phase_id) {
    return rejected(ADAPTER_CODES.SOURCE_REFERENCE_MISSING);
  }
  if (Array.isArray(authoritativeSourceReference) || Array.isArray(expectedIdentityBinding)) {
    return rejected(ADAPTER_CODES.ONE_SOURCE_BOUND);
  }
  const { evidenceRoot, execution_id, phase_id } = authoritativeSourceReference;
  const nvmErr = assertStorageRootInNamespace(evidenceRoot);
  if (nvmErr) return nvmErr;
  if (typeof phase_id !== "string" || !PHASE_ID_RE.test(phase_id) || phase_id.includes("..")) {
    return rejected(ADAPTER_CODES.PATH_UNSAFE);
  }
  try {
    validateExecutionId(execution_id);
  } catch {
    return rejected(ADAPTER_CODES.PATH_UNSAFE);
  }
  if (!expectedIdentityBinding.project_identity || !expectedIdentityBinding.task_identity || !expectedIdentityBinding.writer) {
    return rejected(ADAPTER_CODES.INPUT_INVALID);
  }

  const repoRoot = expectedIdentityBinding.project_identity.repository_root_identity;
  let resolvedRoot;
  try {
    resolvedRoot = assertValidEvidenceRoot(evidenceRoot, typeof repoRoot === "string" && repoRoot.startsWith("/") ? repoRoot : null);
  } catch (err) {
    return mapThrown(err);
  }
  const nvm2 = assertStorageRootInNamespace(resolvedRoot);
  if (nvm2) return nvm2;

  let execDir;
  try {
    execDir = resolveExecDir(resolvedRoot, execution_id);
  } catch (err) {
    return mapThrown(err);
  }

  let current;
  try {
    current = readCurrent(execDir);
  } catch (err) {
    return mapThrown(err);
  }
  if (!current) return rejected(ADAPTER_CODES.INCOMPLETE_PUBLICATION);
  try {
    validateSnapshotStructure(current.snapshot);
  } catch (err) {
    return mapThrown(err);
  }
  if (current.snapshot.execution_id !== execution_id) {
    return rejected(ADAPTER_CODES.SOURCE_IDENTITY_BINDING_MISMATCH);
  }

  const resultPath = join(phasesDir(execDir), phase_id, "result.json");
  let resultBytes;
  try {
    resultBytes = readNoFollow(resultPath, execDir);
  } catch (err) {
    return mapThrown(err);
  }
  if (!resultBytes) return rejected(ADAPTER_CODES.RESULT_MISSING);
  let result;
  try {
    result = JSON.parse(resultBytes.toString("utf8"));
  } catch {
    return rejected(ADAPTER_CODES.RESULT_MALFORMED);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return rejected(ADAPTER_CODES.RESULT_MALFORMED);
  }
  for (const key of ["phase_id", "final", "status", "attempt", "reason"]) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      return rejected(ADAPTER_CODES.RESULT_MALFORMED);
    }
  }
  if (result.phase_id !== phase_id) return rejected(ADAPTER_CODES.PHASE_ID_MISMATCH);
  if (result.final !== "PASS" && result.final !== "HOLD") {
    return rejected(ADAPTER_CODES.RESULT_MALFORMED);
  }

  const sourceRecordDigest = sha256Hex(resultBytes);
  const pinned = current.snapshot.phase_result_hashes?.[phase_id];
  if (typeof pinned !== "string" || !/^[0-9a-f]{64}$/.test(pinned)) {
    return rejected(ADAPTER_CODES.PHASE_RESULT_HASH_MISSING);
  }
  if (pinned !== sourceRecordDigest) {
    return rejected(ADAPTER_CODES.PHASE_RESULT_HASH_MISMATCH);
  }

  let manifest;
  try {
    manifest = readRunManifest(execDir);
  } catch (err) {
    return mapThrown(err);
  }
  if (!manifest) return rejected(ADAPTER_CODES.MANIFEST_MISSING);
  if (manifest.execution_id !== execution_id) {
    return rejected(ADAPTER_CODES.MANIFEST_IDENTITY_MISMATCH);
  }
  let manifestSha;
  try {
    const shaPath = manifestShaPath(execDir);
    assertSafeRegularFile(shaPath, execDir);
    manifestSha = readFileSync(shaPath, "utf8").trim();
  } catch (err) {
    return mapThrown(err);
  }
  if (!/^[0-9a-f]{64}$/.test(manifestSha)) {
    return rejected(ADAPTER_CODES.MANIFEST_HASH_MISMATCH);
  }
  const phasePins = Array.isArray(manifest.phase_results)
    ? manifest.phase_results.filter((row) => row && row.phase_id === phase_id)
    : [];
  if (phasePins.length > 1) return conflict(ADAPTER_CODES.SOURCE_CONFLICT);
  if (phasePins.length === 1 && phasePins[0].result_hash !== sourceRecordDigest) {
    return rejected(ADAPTER_CODES.PHASE_RESULT_HASH_MISMATCH);
  }

  const store = new RunEvidenceStore({
    root: resolvedRoot,
    executionId: execution_id,
    chainId: current.snapshot.chain_id,
    checkpointId: current.snapshot.checkpoint_id,
    repoRoot: typeof repoRoot === "string" && repoRoot.startsWith("/") ? repoRoot : null,
  });
  store.execDir = execDir;

  let held;
  try {
    held = selectPhaseHeld(store, phase_id, result);
  } catch (err) {
    return mapThrown(err);
  }
  if (isResultEnvelope(held)) return held;
  if (typeof held.event_id !== "string" || held.event_id.length === 0) {
    return rejected(ADAPTER_CODES.MISSING_EVENT_ID);
  }
  if (held.execution_id !== execution_id) {
    return rejected(ADAPTER_CODES.SOURCE_IDENTITY_BINDING_MISMATCH);
  }
  if (held.phase_id !== phase_id) return rejected(ADAPTER_CODES.PHASE_ID_MISMATCH);
  if (held.payload?.final !== result.final) return rejected(ADAPTER_CODES.RESULT_VERDICT_MISMATCH);
  if (held.payload?.reason !== result.reason) return rejected(ADAPTER_CODES.RESULT_REASON_MISMATCH);
  if (held.attempt !== result.attempt) return rejected(ADAPTER_CODES.RESULT_VERDICT_MISMATCH);

  const elig = eligibility(result, held);
  if (elig) return elig;

  const resultGen = Number.isInteger(result.graph_generation) && result.graph_generation >= 0
    ? result.graph_generation
    : 0;
  const snapGen = current.snapshot.graph?.recovery_generation;
  if (snapGen != null && result.graph_generation != null && resultGen !== snapGen) {
    return rejected(ADAPTER_CODES.STALE_GENERATION);
  }

  const attemptIdentity = { execution_id, attempt: result.attempt };
  try {
    bindIdentities(identityBinder, expectedIdentityBinding, attemptIdentity, expectedIdentityBinding.project_identity);
  } catch (err) {
    return mapThrown(err);
  }

  const occurredAt = held.timestamp;
  if (typeof occurredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(occurredAt)) {
    return rejected(ADAPTER_CODES.INCOMPLETE_PUBLICATION);
  }

  const evidenceRefs = [
    { kind: "evidence_event", identity: held.event_id, digest: held.event_sha256 },
    { kind: "evidence_manifest", identity: execution_id, digest: manifestSha },
    { kind: "artifact", identity: phase_id, digest: sourceRecordDigest },
  ];

  return mintReceipt({
    source_record_id: held.event_id,
    source_record_digest: sourceRecordDigest,
    project_identity: expectedIdentityBinding.project_identity,
    task_identity: expectedIdentityBinding.task_identity,
    attempt_identity: attemptIdentity,
    source_authority_identity: SOURCE_AUTHORITY_IDENTITY,
    source_authority_generation: resultGen,
    failure_finding_discriminator: result.reason,
    observed_outcome_class: "HOLD",
    source_occurred_at: occurredAt,
    evidence_refs: evidenceRefs,
    writer: expectedIdentityBinding.writer,
    revocation_generation: Object.prototype.hasOwnProperty.call(expectedIdentityBinding, "revocation_generation")
      ? expectedIdentityBinding.revocation_generation
      : null,
    execution_id,
    phase_id,
    result_path_digest: sourceRecordDigest,
  });
}

function mapIncidentFromReceipt(receipt, principal) {
  const producerKind = principal.role === "fixture" ? "fixture" : "measurement-writer";
  return {
    schema_version: SCHEMA_VERSION,
    event_type: "INCIDENT_OBSERVED",
    occurred_at: receipt.source_occurred_at,
    project_identity: receipt.project_identity,
    task_identity: receipt.task_identity,
    attempt_identity: receipt.attempt_identity,
    incident_identity: { incident_id_kind: "evidence_bound" },
    pattern_identity: null,
    retrieval_event_id: null,
    evidence_refs: receipt.evidence_refs,
    evidence_complete: true,
    missing_predecessor: false,
    producer_kind: producerKind,
    writer: receipt.writer,
    authority: { identity: principal.identity, role: principal.role },
    revocation_generation: receipt.revocation_generation,
    applicability_decision: "UNKNOWN",
    subject_event_id: null,
    outcome_ref: null,
    payload: {
      profile_version: INCIDENT_OBS_SCHEMA,
      source_class: "LIFECYCLE_TERMINAL",
      source_record_id: receipt.source_record_id,
      source_authority_identity: receipt.source_authority_identity,
      source_authority_generation: receipt.source_authority_generation,
      failure_finding_discriminator: receipt.failure_finding_discriminator,
      source_record_digest: receipt.source_record_digest,
      evidence_completeness_class: "COMPLETE",
      observed_outcome_class: receipt.observed_outcome_class,
    },
  };
}

function safeAppendStatus(status, sourceRecordId) {
  return Object.freeze({
    status,
    event_type: "INCIDENT_OBSERVED",
    source_record_id: sourceRecordId,
  });
}

/**
 * Consume an opaque verified receipt. Writer still locks and revalidates.
 */
export function appendFromVerifiedTerminalReceipt({
  receipt,
  transferMetricsWriter,
  observerPrincipal,
} = {}) {
  const forged = assertReceipt(receipt);
  if (forged) return forged;
  if (!transferMetricsWriter || typeof transferMetricsWriter.appendTransferEvent !== "function") {
    return rejected(ADAPTER_CODES.UNAVAILABLE);
  }
  try {
    assertMintedPrincipal(observerPrincipal);
  } catch (err) {
    return mapThrown(err);
  }
  const event = mapIncidentFromReceipt(receipt, observerPrincipal);
  try {
    const result = transferMetricsWriter.appendTransferEvent({
      event,
      principal: observerPrincipal,
    });
    if (result.status === "APPENDED") {
      return safeAppendStatus("APPENDED", receipt.source_record_id);
    }
    if (result.status === "ALREADY_SATISFIED") {
      return safeAppendStatus("ALREADY_SATISFIED", receipt.source_record_id);
    }
    return rejected(ADAPTER_CODES.UNAVAILABLE);
  } catch (err) {
    return mapThrown(err);
  }
}

function revalidatePinnedResult(reference, receipt) {
  let execDir;
  try {
    const resolved = resolveSafeRoot(reference.evidenceRoot);
    execDir = resolveExecDir(resolved, reference.execution_id);
  } catch (err) {
    return mapThrown(err);
  }
  const resultPath = join(phasesDir(execDir), reference.phase_id, "result.json");
  let bytes;
  try {
    bytes = readNoFollow(resultPath, execDir);
  } catch (err) {
    return mapThrown(err);
  }
  if (!bytes) return rejected(ADAPTER_CODES.RESULT_MISSING);
  if (sha256Hex(bytes) !== receipt.source_record_digest) {
    return conflict(ADAPTER_CODES.SOURCE_CONFLICT);
  }
  return null;
}

/**
 * Single explicit offline entry. One C3 source reference per call.
 */
export function observeLifecycleHeldIncident(args = {}) {
  if (args == null || typeof args !== "object" || Array.isArray(args)) {
    return rejected(ADAPTER_CODES.INPUT_INVALID);
  }
  if (hasForbiddenKeys(args)) return rejected(ADAPTER_CODES.INPUT_INVALID);
  for (const key of Object.getOwnPropertyNames(args)) {
    if (!OBSERVE_KEYS.includes(key)) return rejected(ADAPTER_CODES.INPUT_INVALID);
  }
  const {
    authoritativeSourceReference,
    expectedIdentityBinding,
    transferMetricsWriter,
    observerPrincipal,
  } = args;
  if (Array.isArray(authoritativeSourceReference)) {
    return rejected(ADAPTER_CODES.ONE_SOURCE_BOUND);
  }
  if (!transferMetricsWriter || typeof transferMetricsWriter.appendTransferEvent !== "function") {
    return rejected(ADAPTER_CODES.UNAVAILABLE);
  }
  try {
    assertMintedPrincipal(observerPrincipal);
  } catch (err) {
    return mapThrown(err);
  }
  const verified = verifyLifecycleHeldTerminal({
    authoritativeSourceReference,
    expectedIdentityBinding,
    identityBinder: transferMetricsWriter.identityBinder,
  });
  if (isResultEnvelope(verified)) return verified;
  const drift = revalidatePinnedResult(authoritativeSourceReference, verified);
  if (drift) return drift;
  return appendFromVerifiedTerminalReceipt({
    receipt: verified,
    transferMetricsWriter,
    observerPrincipal,
  });
}

export function isVerifiedTerminalReceipt(value) {
  return value != null && VERIFIED_TERMINAL_RECEIPTS.has(value);
}
