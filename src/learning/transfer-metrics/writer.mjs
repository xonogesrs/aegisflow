// src/learning/transfer-metrics/writer.mjs
//
// Single writer authority for the transfer-event log.
// Reuses C2D structured lock + fs-atomic path/permission primitives.
// Not a second durable engine, evidence store, or memory journal.
import { createHash } from "node:crypto";

import {
  existsSync,
  openSync,
  readSync,
  writeSync,
  fsyncSync,
  closeSync,
  chmodSync,
  lstatSync,
  fstatSync,
  ftruncateSync,
  renameSync,
  realpathSync,
  constants as fsConstants,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  acquireStructuredLock,
} from "../../c2d/lock.mjs";
import {
  C2dHoldError,
  HOLD,
  ensureDir0700,
  assertNotSymlink,
  assertPathComponentsNotSymlink,
  assertInsideRoot,
} from "../../c2d/fs-atomic.mjs";
import { utcNowIso } from "../../memory/canonical.mjs";
import {
  ALLOWED_ROOT_PREFIX,
  AUTHORITY_DOMAIN,
  AUTHORITY_EVENT_TYPE,
  AUTHORITY_ISSUER_WRITER_ID,
  AUTHORITY_REASONS,
  GENESIS_DIGEST,
  LOG_SCHEMA_V2,
  MAX_EVENT_BYTES,
  MAX_LOG_ACTIVE_BYTES,
  MAX_STRING_BYTES_PER_FIELD,
  SCHEMA_VERSION,
  SCHEMA_VERSION_NUMBER_V2,
  SCHEMA_VERSION_V2,
  INCIDENT_OBS_SCHEMA,
  TRANSFER_CODES,
  TransferMetricsError,
  assertPrincipalBinding,
  assertRolePermissions,
  canonical,
  computeAuthorityIdempotencyKey,
  computeAuthorityPayloadDigest,
  computeEventDigest,
  computeEventId,
  computeIdempotencyKey,
  computePayloadDigest,
  headerObjectFor,
  isHex64,
  normalizeIncidentEvidenceRefs,
  parseIsoMs,
  timingSafeHexEqual,
  validateAuthorityPayload,
  validateAttemptIdentity,
  CLOCK_SKEW_SECONDS,
  validateMeasurementEvent,
  validateTaskIdentity,
  assertIncidentDerivedIdentities,
} from "./schema.mjs";
import {
  PROJECTION_MAX_INPUT_BYTES,
  PROJECTION_INPUT_MISSING,
  PROJECTION_INPUT_TOO_LARGE,
  PROJECTION_NON_REGULAR_INPUT,
  PROJECTION_PATH_REPLACED,
  PROJECTION_SNAPSHOT_RACE,
} from "../incidents/projection.mjs";
import { redactTransferEvent, scanTransferPayload } from "./redact.mjs";
import { lastCompleteEvent, listLogFiles, LOG_FILE_NAME, LOCK_FILE_NAME, readLog, readActiveLogGeneration } from "./log.mjs";
import {
  assertMintedPrincipal,
  assertAuthorityIssuerCapability,
  authorityIssuerPrincipalDigest,
  mintWriterAuthorityIssuer,
} from "./identities.mjs";
import {
  authoritySubjectKey,
  deriveAuthoritySubjectIdentity,
  foldAuthorityEvents,
} from "./authority-state.mjs";
import {
  assertCandidateDerivedIdentities,
} from "../patterns/candidate.mjs";

function fail(code, message, details) {
  throw new TransferMetricsError(code, message, details);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLockRetry(lockPath, identity, timeoutMs = 30000) {
  const start = Date.now();
  while (true) {
    try {
      return acquireStructuredLock(lockPath, identity);
    } catch (e) {
      if (e instanceof C2dHoldError && e.code === HOLD.SYMLINK_REJECTED) {
        fail(TRANSFER_CODES.PATH_UNSAFE, e.message);
      }
      const retryable =
        (e instanceof C2dHoldError &&
          (e.code === HOLD.LOCK_ACTIVE
            || e.code === HOLD.LOCK_RECLAIM_NOT_PROVEN_SAFE
            || e.code === HOLD.LOCK_RECORD_CORRUPT
            || e.code === HOLD.LOCK_RECLAIM_CONFLICT))
        || (e && e.code === "ENOENT");
      if (!retryable || Date.now() - start > timeoutMs) throw e;
      sleepMs(5);
    }
  }
}

function fsyncDir(dir) {
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // directory fsync degradation is reported by C2D lock; append still fsyncs the file
  }
}

function pathCall(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof C2dHoldError) fail(TRANSFER_CODES.PATH_UNSAFE, e.message);
    if (e && (e.code === "ELOOP" || e.code === "EEXIST" && String(e.message || "").includes("symlink"))) {
      fail(TRANSFER_CODES.PATH_UNSAFE, e.message);
    }
    throw e;
  }
}

function assertPrefixAllowed(resolved) {
  const home = resolve(homedir());
  if (resolved === home || resolved.startsWith(home + sep)) {
    fail(TRANSFER_CODES.PATH_UNSAFE, "HOME namespace rejected");
  }
  const prefix = ALLOWED_ROOT_PREFIX.endsWith(sep) ? ALLOWED_ROOT_PREFIX : ALLOWED_ROOT_PREFIX + sep;
  const allowedRoot = ALLOWED_ROOT_PREFIX.replace(/\/$/, "");
  if (resolved !== allowedRoot && !resolved.startsWith(prefix)) {
    fail(TRANSFER_CODES.PATH_UNSAFE, `root outside NVM2T boundary: ${resolved}`);
  }
}

function assertNoSymlinkComponents(absPath) {
  const abs = resolve(absPath);
  if (abs.includes("\0")) fail(TRANSFER_CODES.PATH_UNSAFE, "NUL in path");
  const parts = abs.split(sep).filter(Boolean);
  let cur = abs.startsWith(sep) ? sep : "";
  for (const part of parts) {
    cur = cur === sep ? sep + part : join(cur, part);
    if (!existsSync(cur)) continue;
    const st = lstatSync(cur);
    if (st.isSymbolicLink()) fail(TRANSFER_CODES.PATH_UNSAFE, `symlink component rejected: ${cur}`);
  }
}

function assertAllowedRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    fail(TRANSFER_CODES.PATH_UNSAFE, "transferMetricsRoot required");
  }
  const lexical = resolve(root);
  if (lexical.includes("\0") || lexical.split(sep).includes("..")) {
    fail(TRANSFER_CODES.PATH_UNSAFE, "path escape");
  }
  assertPrefixAllowed(lexical);
  assertNoSymlinkComponents(lexical);
  if (existsSync(lexical)) {
    const st = lstatSync(lexical);
    if (st.isSymbolicLink()) fail(TRANSFER_CODES.PATH_UNSAFE, `symlink root rejected: ${lexical}`);
    if (!st.isDirectory()) fail(TRANSFER_CODES.PATH_UNSAFE, `root is not a directory: ${lexical}`);
    const real = realpathSync(lexical);
    assertPrefixAllowed(real);
    if (real !== lexical) fail(TRANSFER_CODES.PATH_UNSAFE, "resolved path drifted from lexical");
  } else {
    let cur = lexical;
    while (!existsSync(cur)) {
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    if (existsSync(cur)) {
      const real = realpathSync(cur);
      if (real !== resolve(cur)) fail(TRANSFER_CODES.PATH_UNSAFE, `ancestor symlink rejected: ${cur}`);
      assertPrefixAllowed(real);
    }
  }
  return lexical;
}

function assertRegularOrMissing(path) {
  pathCall(() => assertPathComponentsNotSymlink(path, { allowMissingLeaf: true }));
  pathCall(() => assertNotSymlink(path));
  assertNoSymlinkComponents(path);
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) fail(TRANSFER_CODES.PATH_UNSAFE, `symlink rejected: ${path}`);
  if (!st.isFile()) fail(TRANSFER_CODES.PATH_UNSAFE, `non-regular target: ${path}`);
  if (st.nlink !== 1) fail(TRANSFER_CODES.PATH_UNSAFE, `hardlink target rejected: ${path}`);
}

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

function openLogAppend(path) {
  assertRegularOrMissing(path);
  const fd = openSync(path, fsConstants.O_APPEND | fsConstants.O_WRONLY | NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) fail(TRANSFER_CODES.PATH_UNSAFE, `opened non-regular log: ${path}`);
    if (st.nlink !== 1) fail(TRANSFER_CODES.PATH_UNSAFE, `hardlink log target rejected: ${path}`);
    return fd;
  } catch (e) {
    try { closeSync(fd); } catch { /* ignore */ }
    if (e instanceof TransferMetricsError) throw e;
    if (e && (e.code === "ELOOP" || e.code === "EMLINK")) fail(TRANSFER_CODES.PATH_UNSAFE, e.message);
    throw e;
  }
}

function nextArchiveSeq(root) {
  let max = 0;
  for (const file of listLogFiles(root)) {
    const m = /transfer-events-(\d+)\.jsonl$/.exec(file);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export class TransferMetricsWriter {
  #authorityIssuer;
  #issuerDigest;
  #issuerAuthorityGeneration;
  #issuerRevocationGeneration;
  #authorityCache;
  #lockHeld;
  #mutationDepth;

  constructor({
    transferMetricsRoot,
    identityBinder,
    revocationRegistry = { revokedWriterIds: new Set(), currentGenerations: new Map() },
    clock = utcNowIso,
    allowFixture = false,
    crashHooks = {},
    lockIdentity = null,
  } = {}) {
    if (!transferMetricsRoot) fail(TRANSFER_CODES.PATH_UNSAFE, "transferMetricsRoot required");
    this.root = assertAllowedRoot(transferMetricsRoot);
    this.logPath = join(this.root, LOG_FILE_NAME);
    this.lockPath = join(this.root, LOCK_FILE_NAME);
    pathCall(() => assertInsideRoot(this.root, this.logPath));
    pathCall(() => assertInsideRoot(this.root, this.lockPath));
    this.identityBinder = identityBinder;
    this.revocationRegistry = revocationRegistry;
    this.clock = clock;
    this.allowFixture = allowFixture;
    this.crashHooks = crashHooks;
    this.lockIdentity = lockIdentity ?? {
      lock_kind: "transfer_metrics",
      execution_id: "transfer-metrics",
      checkpoint_id: "transfer-events",
      chain_id: "transfer-events",
      lease_id: "none",
      lease_revision: 0,
      actor_id: "transfer-metrics-writer",
      session_id: "transfer-metrics",
      repository_identity: this.root,
      worktree_identity: this.root,
      expected_head: "none",
    };
    // Sealed learning-authority issuer: minted module-privately, held by THIS
    // writer instance, never exposed outside fixture mode. Its digest is the
    // only accepted issuer_principal_digest for mutations on this writer.
    this.#authorityIssuer = mintWriterAuthorityIssuer({ storageRoot: this.root });
    this.#issuerDigest = authorityIssuerPrincipalDigest(this.#authorityIssuer);
    this.#issuerAuthorityGeneration = this.#authorityIssuer.authority_generation;
    this.#issuerRevocationGeneration = this.#authorityIssuer.revocation_generation;
    this.#authorityCache = { status: "UNINITIALIZED", fold: null, activeGeneration: null };
    this.#lockHeld = false;
    this.#mutationDepth = 0;
  }

  /**
   * Fixture-gated access to THIS writer's sealed issuer (test-only surface;
   * no production-reachable mint exists). Cloning/spreading/serializing the
   * returned capability destroys its module-private brand and fails closed.
   */
  fixtureAuthorityIssuer() {
    if (!this.allowFixture) {
      fail(TRANSFER_CODES.AUTHORITY_ISSUER_FORGED, "authority issuer is not available outside fixture mode");
    }
    return this.#authorityIssuer;
  }

  // ---- Durable authority mutations (sealed issuer ONLY) -------------------

  revokeWriter(writerId, options = {}) {
    return this.#authorityMutation({
      subjectKind: "WRITER_PRINCIPAL",
      subjectRef: { writerId },
      operation: "REVOKE",
      newState: "REVOKED",
      options,
    });
  }

  setWriterGeneration(writerId, options = {}) {
    // Durable form: a strict +1 SET_GENERATION advance. Arbitrary set-to-N
    // is not part of the durable contract.
    return this.#authorityMutation({
      subjectKind: "WRITER_PRINCIPAL",
      subjectRef: { writerId },
      operation: "SET_GENERATION",
      newState: "CURRENT",
      options,
    });
  }

  citedTruthAdvance(citedKey, options = {}) {
    return this.#authorityMutation({
      subjectKind: "CITED_TRUTH",
      subjectRef: { citedKey },
      operation: "SET_GENERATION",
      newState: "CURRENT",
      options,
    });
  }

  // ---- Sealed issuer validation (module-private origin + instance fence) --

  #validateIssuer(issuer) {
    assertAuthorityIssuerCapability(issuer);
    if (issuer.authority_domain !== AUTHORITY_DOMAIN || issuer.storage_root !== this.root) {
      fail(TRANSFER_CODES.AUTHORITY_ISSUER_FORGED, "issuer binding does not match this writer");
    }
    if (issuer.authority_generation !== this.#issuerAuthorityGeneration
      || issuer.revocation_generation !== this.#issuerRevocationGeneration) {
      fail(TRANSFER_CODES.AUTHORITY_STALE_GENERATION, "issuer authority/revocation generation is stale");
    }
    // Instance-binding fence [B1]: the presented issuer must be THIS
    // writer's own capability, proven by digest equality over the
    // module-private per-issuer brand. Clones/foreign mints never match.
    if (!timingSafeHexEqual(authorityIssuerPrincipalDigest(issuer), this.#issuerDigest)) {
      fail(TRANSFER_CODES.AUTHORITY_ISSUER_FORGED, "issuer is not this writer's sealed authority issuer");
    }
    return this.#issuerDigest;
  }

  #assertAuthorityBounded(value, label) {
    if (typeof value !== "string" || value.length === 0
      || Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES_PER_FIELD
      || /[\u0000\r\n]/.test(value)) {
      fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `${label} must be a bounded non-empty string`);
    }
  }

  // ---- Durable authority mutation (frozen 14-step order; sync; fsync is
  // THE linearization point under the EXISTING writer lock) ---------------

  #authorityMutation({ subjectKind, subjectRef, operation, newState, options }) {
    // [A61/B3/T81/T82] re-entrancy fence: no mutation entry may run while
    // this writer holds the lock, inside another mutation (pre-lock or
    // lock-held hook), or recursively.
    if (this.#lockHeld || this.#mutationDepth > 0) {
      fail(TRANSFER_CODES.AUTHORITY_INTERNAL_CONTRACT_VIOLATION, "authority mutation re-entered inside a writer mutation");
    }
    this.#mutationDepth += 1;
    try {
      return this.#authorityMutationInner({ subjectKind, subjectRef, operation, newState, options });
    } finally {
      this.#mutationDepth -= 1;
    }
  }

  #authorityMutationInner({ subjectKind, subjectRef, operation, newState, options }) {
    if (this.#lockHeld) {
      fail(TRANSFER_CODES.AUTHORITY_INTERNAL_CONTRACT_VIOLATION, "authority mutation re-entered while writer lock is held");
    }
    if (this.crashHooks.beforeAppend) this.crashHooks.beforeAppend();
    // Steps 1-3 (pre-lock advisory; all revalidated under lock).
    const issuer = options?.issuer;
    const issuerDigest = this.#validateIssuer(issuer);
    const taskIdentity = options?.task_identity;
    if (taskIdentity != null) validateTaskIdentity(taskIdentity);
    const subjectIdentity = deriveAuthoritySubjectIdentity({
      subjectKind,
      storageRoot: this.root,
      writerId: subjectRef.writerId,
      citedKey: subjectRef.citedKey,
      taskIdentity,
    });
    this.#assertAuthorityBounded(options?.mutationId, "mutation_id");
    const expected = options?.expected;
    if (!Number.isSafeInteger(expected) || expected < 0) {
      fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, "expected_previous_generation must be a safe integer >= 0");
    }
    if (this.identityBinder) this.identityBinder.bindTask(taskIdentity);
    const attemptIdentity = options?.attempt_identity ?? null;
    if (attemptIdentity != null) {
      validateAttemptIdentity(attemptIdentity);
      this.identityBinder?.bindAttempt(attemptIdentity);
    }
    const evidenceRefs = options?.evidenceRefs != null
      ? normalizeIncidentEvidenceRefs(options.evidenceRefs)
      : [];
    const reason = options?.reason ?? null;
    if (reason != null && !AUTHORITY_REASONS.includes(reason)) {
      fail(TRANSFER_CODES.AUTHORITY_EVENT_SCHEMA_INVALID, `unknown reason ${String(reason)}`);
    }
    const occurredAt = options?.occurredAt ?? this.clock();

    if (this.crashHooks.afterAuthorizeBeforeLock) this.crashHooks.afterAuthorizeBeforeLock();
    pathCall(() => ensureDir0700(this.root));
    this.#revalidateMutationFence();
    // Step 4: acquire the EXISTING writer lock (same path, same identity,
    // same structured lock module — no second lock may exist).
    const lock = acquireLockRetry(this.lockPath, this.lockIdentity);
    this.#lockHeld = true;
    try {
      return this.#authorityMutationLocked({
        issuer, issuerDigest, subjectKind, subjectIdentity, operation, newState,
        mutationId: options.mutationId, expected, taskIdentity, attemptIdentity,
        evidenceRefs, reason, occurredAt,
      });
    } finally {
      this.#lockHeld = false;
      lock.release();
    }
  }

  #authorityMutationLocked(ctx) {
    // Step 5: revalidate the issuer under the lock (forged/stale/binding).
    const issuerDigest = this.#validateIssuer(ctx.issuer);
    this.#revalidateMutationFence();
    // Step 6: full chain replay (readLog validates the WHOLE chain per file
    // generation; fold validates every authority record against the fold).
    const snapshot = readLog(this.root);
    const activeGeneration = snapshot.activeGeneration ?? 2;
    if (activeGeneration === 1) {
      // LEGACY_READ_ONLY: no authority mutation against a GEN-1 active root.
      fail(TRANSFER_CODES.AUTHORITY_UNAVAILABLE, "legacy GEN-1 active root is read-only for authority mutations");
    }
    const fold = foldAuthorityEvents(snapshot.events);
    const identityKey = authoritySubjectKey(ctx.subjectIdentity);
    const prior = fold.subjects.get(identityKey);
    const previousState = prior ? prior.state : null;
    const previousGeneration = prior ? prior.generation : 0;
    // Caller-asserted transition: the idempotency key is derived from the
    // caller-asserted generations so a retry reconstructs the SAME key.
    const candidate = {
      authority_domain: AUTHORITY_DOMAIN,
      subject_kind: ctx.subjectKind,
      subject_identity: ctx.subjectIdentity,
      operation: ctx.operation,
      previous_generation: ctx.expected,
      new_generation: ctx.expected + 1,
      mutation_id: ctx.mutationId,
    };
    const idempotency_key = computeAuthorityIdempotencyKey(candidate);
    const existing = snapshot.idempotencyIndex.get(idempotency_key);
    if (existing && existing.event_type === AUTHORITY_EVENT_TYPE) {
      // Step 7 outcome: same key + same caller payload ⇒ ALREADY_SATISFIED
      // with the ORIGINAL event and original recorded_at; any caller-field
      // divergence ⇒ AUTHORITY_MUTATION_CONFLICT (never masked).
      const p = existing.payload;
      const sameCallerPayload = p.operation === ctx.operation
        && p.previous_generation === ctx.expected
        && p.new_generation === ctx.expected + 1
        && p.subject_kind === ctx.subjectKind
        && p.mutation_id === ctx.mutationId
        // issuer_principal_digest is writer-instance provenance, not caller
        // payload identity: a retry after restart from a re-minted instance
        // still reports the durably recorded original (C11/T56) — the caller
        // payload fields (subject/operation/generations/mutationId/reason/
        // evidence) must match exactly.
        && timingSafeHexEqual(authoritySubjectKey(p.subject_identity), identityKey)
        && (p.reason ?? null) === ctx.reason
        && JSON.stringify(p.evidence_refs ?? null) === JSON.stringify(ctx.evidenceRefs.length > 0 ? ctx.evidenceRefs : null);
      if (sameCallerPayload) {
        return { status: "ALREADY_SATISFIED", event: existing };
      }
      fail(TRANSFER_CODES.AUTHORITY_MUTATION_CONFLICT, "same authority idempotency key with different payload");
    }
    // Terminal rule: REVOKED has no outgoing edge — checked before stale.
    if (previousState === "REVOKED") {
      fail(TRANSFER_CODES.AUTHORITY_SUBJECT_TERMINAL, "subject is REVOKED (terminal); no outgoing edge");
    }
    if (ctx.expected !== previousGeneration) {
      fail(TRANSFER_CODES.AUTHORITY_STALE_GENERATION, `expected_previous_generation ${ctx.expected} does not match durable ${previousGeneration}`);
    }
    // Step 8: construct the canonical closed authority payload (writer-owned
    // previous state/generation; caller digest is never authority).
    const payload = {
      authority_domain: AUTHORITY_DOMAIN,
      subject_kind: ctx.subjectKind,
      subject_identity: JSON.parse(JSON.stringify(ctx.subjectIdentity)),
      operation: ctx.operation,
      previous_generation: previousGeneration,
      new_generation: previousGeneration + 1,
      previous_state: previousState,
      new_state: ctx.newState,
      expected_previous_generation: ctx.expected,
      issuer_principal_digest: issuerDigest,
      issuer_authority_generation: this.#issuerAuthorityGeneration,
      issuer_revocation_generation: this.#issuerRevocationGeneration,
      mutation_id: ctx.mutationId,
    };
    if (ctx.evidenceRefs.length > 0) payload.evidence_refs = ctx.evidenceRefs;
    if (ctx.reason != null) payload.reason = ctx.reason;
    validateAuthorityPayload(payload);
    const payload_digest = computeAuthorityPayloadDigest(payload);
    const event_id = computeEventId(idempotency_key);
    const recorded_at = this.clock();
    if (parseIsoMs(ctx.occurredAt) > parseIsoMs(recorded_at) + CLOCK_SKEW_SECONDS * 1000) {
      fail(TRANSFER_CODES.CLOCK_ANOMALY, "occurred_at is more than 300s after recorded_at");
    }
    const previous_digest = snapshot.state.previousDigest ?? GENESIS_DIGEST;
    const journal_sequence = snapshot.state.lastSequence + 1;
    const event_digest = computeEventDigest({
      journal_sequence,
      event_id,
      event_type: AUTHORITY_EVENT_TYPE,
      payload_digest,
      previous_digest,
    });
    const durable = {
      schema_version: SCHEMA_VERSION_V2,
      event_id,
      event_type: AUTHORITY_EVENT_TYPE,
      occurred_at: ctx.occurredAt,
      recorded_at,
      project_identity: { repository_root_identity: this.root, git_common_dir_identity: this.root },
      task_identity: { ...ctx.taskIdentity },
      attempt_identity: ctx.attemptIdentity ? { ...ctx.attemptIdentity } : null,
      incident_identity: null,
      pattern_identity: null,
      retrieval_event_id: null,
      evidence_refs: [],
      evidence_complete: false,
      missing_predecessor: false,
      producer_kind: "measurement-writer",
      writer: { writer_id: AUTHORITY_ISSUER_WRITER_ID, writer_generation: 0 },
      authority: { identity: issuerDigest, role: "operator" },
      revocation_generation: payload.new_generation,
      applicability_decision: "UNKNOWN",
      subject_event_id: null,
      outcome_ref: null,
      redaction_status: { scanned: true, truncated: false, secret_hit: false },
      payload,
      idempotency_key,
      payload_digest,
      journal_sequence,
      previous_digest,
      event_digest,
    };
    const line = canonical(durable);
    if (line.includes("\n") || line.includes("\r")) {
      fail(TRANSFER_CODES.PAYLOAD_UNSAFE, "canonical line contains newline");
    }
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
      fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "authority event exceeds MAX_EVENT_BYTES");
    }
    // Zero-write secret gate: pure scan BEFORE any byte is written; on a hit
    // nothing is consumed, nothing is cached, raw bytes are unchanged.
    const scan = scanTransferPayload(line);
    if (!scan.safe) {
      fail(TRANSFER_CODES.AUTHORITY_SECRET_REJECTED, `secret pattern(s): ${scan.matches.join(",")}`);
    }
    // First-creation header (GEN-2) + parent-dir sync happen only now —
    // AFTER the zero-write secret gate — so a rejected mutation writes
    // ZERO bytes (nothing consumed, nothing cached).
    this.#ensureLogFile();
    if (snapshot.partialTrailingLine) {
      this.#reconcilePartialTail(snapshot.lastValidOffset);
    }
    // Steps 9-10: append ONE complete JSONL line, then fsync (the ONE
    // linearization point).
    this.#appendLine(line);
    this.#maybeRotate();
    // Step 12: publish the process cache strictly AFTER fsync — never
    // before, never as authority ahead of the durable log.
    const nextSnapshot = readLog(this.root);
    this.#authorityCache = {
      status: "READY",
      fold: foldAuthorityEvents(nextSnapshot.events),
      activeGeneration: 2,
    };
    return { status: "APPENDED", event: durable };
  }

  appendTransferEvent({ event, principal }) {
    if (this.#lockHeld || this.#mutationDepth > 0) {
      fail(TRANSFER_CODES.AUTHORITY_INTERNAL_CONTRACT_VIOLATION, "append re-entered inside a writer mutation");
    }
    this.#mutationDepth += 1;
    try {
      return this.#appendTransferEventInner({ event, principal });
    } finally {
      this.#mutationDepth -= 1;
    }
  }

  #appendTransferEventInner({ event, principal }) {
    if (this.#lockHeld) {
      fail(TRANSFER_CODES.AUTHORITY_INTERNAL_CONTRACT_VIOLATION, "append re-entered while writer lock is held");
    }
    if (this.crashHooks.beforeAppend) this.crashHooks.beforeAppend();
    // No public append path for authority events exists [A-5/T13].
    if (event?.event_type === AUTHORITY_EVENT_TYPE) {
      fail(TRANSFER_CODES.AUTHORITY_ISSUER_FORGED, "authority events have no public append path");
    }
    // Measurement events are stamped from the ACTIVE file header generation
    // [A63/T84]: GEN-1 active ⇒ v1 continuity; GEN-2 active (and first
    // creation) ⇒ v2. Caller schema_version must be a KNOWN version; the
    // writer always stamps the active generation itself.
    if (event?.schema_version !== SCHEMA_VERSION && event?.schema_version !== SCHEMA_VERSION_V2) {
      fail(TRANSFER_CODES.EVENT_UNKNOWN_SCHEMA, `schema_version ${String(event?.schema_version)}`);
    }
    const activeGeneration = readActiveLogGeneration(this.root);
    const schemaVersion = activeGeneration === 1 ? SCHEMA_VERSION : SCHEMA_VERSION_V2;
    event = validateMeasurementEvent({ ...event, schema_version: schemaVersion }, schemaVersion);
    assertMintedPrincipal(principal);
    assertPrincipalBinding(event, principal);
    assertRolePermissions(event, principal, { allowFixture: this.allowFixture });
    this.#assertIdentities(event);
    if (event.event_type === "PATTERN_CANDIDATE_CREATED") {
      // GATE-B-COMPLETION-1: candidate identity re-derivation before the
      // idempotency computation. A tampered candidate_id / identity key /
      // slot never reaches the durable log.
      assertCandidateDerivedIdentities(event);
    }
    this.#assertWriterLive(event.writer);

    const payload_digest = computePayloadDigest(event.payload);
    const idempotency_key = computeIdempotencyKey(event);
    const event_id = computeEventId(idempotency_key);
    if (event.subject_event_id && event.subject_event_id === event_id) {
      fail(TRANSFER_CODES.SUBJECT_UNBOUND, "subject_event_id must not be self-referential");
    }
    const recorded_at = this.clock();
    // Option B: clock skew applies to first append only. Same-key retry
    // must return the original recorded_at even if the writer clock jumped
    // or rolled back beyond CLOCK_SKEW_SECONDS.

    const prepared = {
      ...event,
      schema_version: schemaVersion,
      event_id,
      recorded_at,
      idempotency_key,
      payload_digest,
    };
    const redacted = redactTransferEvent(prepared);
    const durableBase = {
      ...redacted.event,
      redaction_status: {
        scanned: true,
        truncated: redacted.truncated,
        secret_hit: false,
      },
    };

    if (this.crashHooks.afterAuthorizeBeforeLock) this.crashHooks.afterAuthorizeBeforeLock();
    pathCall(() => ensureDir0700(this.root));
    this.root = assertAllowedRoot(this.root);
    this.logPath = join(this.root, LOG_FILE_NAME);
    this.lockPath = join(this.root, LOCK_FILE_NAME);
    pathCall(() => assertInsideRoot(this.root, this.logPath));
    pathCall(() => assertInsideRoot(this.root, this.lockPath));
    assertRegularOrMissing(this.logPath);
    const lock = acquireLockRetry(this.lockPath, this.lockIdentity);
    this.#lockHeld = true;
    try {
      return this.#appendLocked(durableBase);
    } finally {
      this.#lockHeld = false;
      lock.release();
    }
  }

  #revalidateMutationFence() {
    this.root = assertAllowedRoot(this.root);
    this.logPath = join(this.root, LOG_FILE_NAME);
    this.lockPath = join(this.root, LOCK_FILE_NAME);
    pathCall(() => assertInsideRoot(this.root, this.logPath));
    pathCall(() => assertInsideRoot(this.root, this.lockPath));
    assertRegularOrMissing(this.logPath);
  }

  #appendLocked(durableBase) {
    this.#revalidateMutationFence();
    this.#ensureLogFile();
    const snapshot = readLog(this.root);
    // Durable-backed fence refresh UNDER the lock: the authority fold from
    // the just-read chain governs WRITER_REVOKED / STALE_GENERATION on
    // GEN-2 roots (stale process cache can never authorize an append).
    this.#refreshAuthorityCache(snapshot);
    this.#assertWriterLive(durableBase.writer);
    this.#assertIdentities(durableBase);
    if (durableBase.event_type === "PATTERN_CANDIDATE_CREATED") {
      // GATE-B-COMPLETION-1: re-derive candidate identity under the lock on
      // the redacted durable base so tampering cannot slip past the pre-lock
      // check.
      assertCandidateDerivedIdentities(durableBase);
    }
    if (durableBase.event_type === "INCIDENT_OBSERVED") {
      for (const e of snapshot.events) {
        if (e.event_type === "INCIDENT_OBSERVED" && e.payload?.profile_version !== INCIDENT_OBS_SCHEMA) {
          fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "pre-profile INCIDENT_OBSERVED is not eligible");
        }
      }
    }
    if (snapshot.events.some((e) => e.event_type === "OUTCOME_OBSERVED"
      && e.attempt_identity?.execution_id === durableBase.attempt_identity?.execution_id
      && durableBase.event_type === "OUTCOME_OBSERVED"
      && e.idempotency_key !== durableBase.idempotency_key)) {
      fail(TRANSFER_CODES.IDEMPOTENCY_CONFLICT, "OUTCOME_OBSERVED already exists for execution_id");
    }

    const existing = snapshot.idempotencyIndex.get(durableBase.idempotency_key);
    if (existing) {
      if (existing.payload_digest === durableBase.payload_digest) {
        return { status: "ALREADY_SATISFIED", event: existing };
      }
      if (durableBase.event_type === "INCIDENT_OBSERVED") {
        const reason = existing.incident_identity?.incident_id !== durableBase.incident_identity?.incident_id
          ? "INCIDENT_SOURCE_IDENTITY_CONFLICT"
          : "INCIDENT_PAYLOAD_CONFLICT";
        fail(TRANSFER_CODES.IDEMPOTENCY_CONFLICT, reason, { reason });
      }
      fail(TRANSFER_CODES.IDEMPOTENCY_CONFLICT, "same idempotency_key different payload_digest");
    }
    this.#assertClock(durableBase, durableBase.recorded_at);


    this.#assertLogBindings(durableBase, snapshot.events);

    if (snapshot.partialTrailingLine) {
      this.#reconcilePartialTail(snapshot.lastValidOffset);
    }

    const previous_digest = snapshot.state.previousDigest ?? GENESIS_DIGEST;
    const journal_sequence = snapshot.state.lastSequence + 1;
    const event_digest = computeEventDigest({
      journal_sequence,
      event_id: durableBase.event_id,
      event_type: durableBase.event_type,
      payload_digest: durableBase.payload_digest,
      previous_digest,
    });
    const durable = {
      ...durableBase,
      journal_sequence,
      previous_digest,
      event_digest,
    };
    const line = canonical(durable);
    if (line.includes("\n") || line.includes("\r")) {
      fail(TRANSFER_CODES.PAYLOAD_UNSAFE, "canonical line contains newline");
    }
    this.#appendLine(line);
    this.#maybeRotate();
    return { status: "APPENDED", event: durable };
  }

  #ensureLogFile() {
    if (existsSync(this.logPath)) {
      assertRegularOrMissing(this.logPath);
      return;
    }
    pathCall(() => ensureDir0700(this.root));
    const header = canonical(headerObjectFor(this.clock(), SCHEMA_VERSION_NUMBER_V2));
    const fd = openSync(
      this.logPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NOFOLLOW,
    );
    try {
      writeSync(fd, header + "\n", null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try { chmodSync(this.logPath, 0o600); } catch { /* best-effort */ }
    fsyncDir(this.root);
  }

  #reconcilePartialTail(lastValidOffset) {
    const fd = openSync(this.logPath, "r+");
    try {
      ftruncateSync(fd, lastValidOffset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  #appendLine(line) {
    const fd = openLogAppend(this.logPath);
    try {
      if (this.crashHooks.writeLine) {
        this.crashHooks.writeLine(fd, line);
      } else {
        writeSync(fd, line + "\n", null, "utf8");
      }
      if (this.crashHooks.afterWriteBeforeFsync) this.crashHooks.afterWriteBeforeFsync(fd);
      fsyncSync(fd);
      if (this.crashHooks.afterFsync) this.crashHooks.afterFsync(fd);
    } finally {
      closeSync(fd);
    }
    try { chmodSync(this.logPath, 0o600); } catch { /* best-effort */ }
  }


  #maybeRotate() {
    if (!existsSync(this.logPath)) return;
    const st = lstatSync(this.logPath);
    if (st.size <= MAX_LOG_ACTIVE_BYTES) return;
    const seq = nextArchiveSeq(this.root);
    const archive = join(this.root, `transfer-events-${seq}.jsonl`);
    assertInsideRoot(this.root, archive);
    renameSync(this.logPath, archive);
    fsyncDir(this.root);
    this.#ensureLogFile();
  }

  // ---- Durable-backed authority view (NON_AUTHORITATIVE replay cache) -----

  #refreshAuthorityCache(snapshot) {
    if (snapshot.activeGeneration === 2) {
      this.#authorityCache = {
        status: "READY",
        fold: foldAuthorityEvents(snapshot.events),
        activeGeneration: 2,
      };
    } else {
      // GEN-1 active root (or headerless): legacy measurement continuity;
      // the constructor registry seeds the measurement fence only.
      this.#authorityCache = { status: "UNAVAILABLE", fold: null, activeGeneration: snapshot.activeGeneration ?? null };
    }
  }

  #durableCitedGeneration(citedKey) {
    if (!citedKey) return null;
    if (this.#authorityCache.status === "READY" && this.#authorityCache.fold) {
      return this.#authorityCache.fold.citedGenerations.get(citedKey) ?? null;
    }
    return null;
  }

  #assertWriterLive(writer) {
    if (this.#authorityCache.status === "READY" && this.#authorityCache.fold) {
      // GEN-2 durable fold governs; divergence resolves TOWARD durable.
      if (this.#authorityCache.fold.revokedWriterIds.has(writer.writer_id)) {
        fail(TRANSFER_CODES.WRITER_REVOKED, `writer ${writer.writer_id} revoked`);
      }
      const gen = this.#authorityCache.fold.writerGenerations.get(writer.writer_id);
      if (gen != null && writer.writer_generation !== gen) {
        fail(TRANSFER_CODES.STALE_GENERATION, "writer_generation is stale");
      }
      return;
    }
    // Legacy path: GEN-1 active root / no durable view — constructor
    // registry (fixture/measurement-fence seeding) as today.
    if (this.revocationRegistry.revokedWriterIds.has(writer.writer_id)) {
      fail(TRANSFER_CODES.WRITER_REVOKED, `writer ${writer.writer_id} revoked`);
    }
    const current = this.revocationRegistry.currentGenerations.get(writer.writer_id);
    if (current != null && writer.writer_generation !== current) {
      fail(TRANSFER_CODES.STALE_GENERATION, "writer_generation is stale");
    }
  }

  #assertIdentities(event) {
    if (!this.identityBinder) fail(TRANSFER_CODES.TASK_UNBOUND, "identityBinder required");
    this.identityBinder.bindTask(event.task_identity);
    this.identityBinder.bindAttempt(event.attempt_identity);
    this.identityBinder.bindProject(event.project_identity);
    this.identityBinder.bindEvidence(event.evidence_refs);
    const citedKey = event.pattern_identity?.pattern_id ?? event.evidence_refs?.[0]?.digest ?? null;
    let cited = this.identityBinder.citedTruthGeneration?.(citedKey) ?? null;
    const durableCited = this.#durableCitedGeneration(citedKey);
    if (durableCited != null) cited = durableCited;
    if (cited != null) {
      if (event.revocation_generation == null) {
        fail(TRANSFER_CODES.WRONG_GENERATION, "revocation_generation omitted while cited truth has generation");
      }
      if (event.revocation_generation !== cited) {
        fail(TRANSFER_CODES.STALE_GENERATION, "revocation_generation does not match cited truth");
      }
    }
    const lifeTime = this.identityBinder.lifecycleTime?.(event.attempt_identity.execution_id);
    if (lifeTime != null && event.occurred_at !== lifeTime) {
      fail(TRANSFER_CODES.TIME_UNBOUND, "occurred_at must equal lifecycle/evidence timestamp");
    }
    if (event.event_type === "OUTCOME_OBSERVED") {
      const terminal = this.identityBinder.lifecycleTerminal?.(event.attempt_identity.execution_id);
      if (terminal) {
        if (terminal.final !== event.payload.final || terminal.attempt !== event.attempt_identity.attempt) {
          fail(TRANSFER_CODES.OUTCOME_MISMATCH, "OUTCOME_OBSERVED must copy lifecycle terminal {final, attempt}");
        }
      }
    }
  }

  #assertClock(event, recordedAt) {
    const occurred = parseIsoMs(event.occurred_at);
    const recorded = parseIsoMs(recordedAt);
    if (occurred > recorded + CLOCK_SKEW_SECONDS * 1000) {
      fail(TRANSFER_CODES.CLOCK_ANOMALY, "occurred_at is more than 300s after recorded_at");
    }
    const snap = existsSync(this.logPath) ? lastCompleteEvent(this.root) : { event: null };
    // prior same-attempt check uses durable events; performed again under lock in #assertLogBindings
    void snap;
  }

  #assertLogBindings(event, events) {
    const priorSameAttempt = events.filter((e) =>
      e.attempt_identity?.execution_id === event.attempt_identity.execution_id
      && e.attempt_identity?.attempt === event.attempt_identity.attempt,
    );
    const occurred = parseIsoMs(event.occurred_at);
    for (const prior of priorSameAttempt) {
      if (occurred < parseIsoMs(prior.occurred_at)) {
        fail(TRANSFER_CODES.CLOCK_ANOMALY, "occurred_at precedes prior same-attempt event");
      }
    }
    if (event.retrieval_event_id) {
      const found = events.find((e) => e.event_id === event.retrieval_event_id);
      if (!found || !["PATTERN_RETRIEVED", "PATTERN_REJECTED", "STALE_PATTERN_REJECTED"].includes(found.event_type)) {
        fail(TRANSFER_CODES.RETRIEVAL_UNBOUND, "retrieval_event_id not a prior retrieval event in this log");
      }
    }
    if (event.subject_event_id) {
      const found = events.find((e) => e.event_id === event.subject_event_id);
      if (!found) fail(TRANSFER_CODES.SUBJECT_UNBOUND, "subject_event_id not a prior event in this log");
    }
    if (event.event_type === "PATTERN_RETRIEVED" || event.event_type === "PATTERN_USED_IN_PLANNING" || event.event_type === "PATTERN_USED_IN_VERIFICATION") {
      const removed = events.some((e) =>
        e.event_type === "PATTERN_REMOVED"
        && e.pattern_identity?.pattern_id === event.pattern_identity?.pattern_id,
      );
      if (removed) fail(TRANSFER_CODES.PATTERN_REMOVED, "pattern has been removed");
    }
  }
}

/**
 * Run `fn(root)` while holding the EXISTING writer lock (same lock path,
 * same structured lock module, same identity shape as the append path).
 * Used by the read-only authority seam and replay folds (OPTION B
 * discipline): a fold always reads a consistent chain snapshot.
 */
export function withTransferMetricsReadLock(transferMetricsRoot, fn) {
  if (typeof transferMetricsRoot !== "string" || transferMetricsRoot.length === 0) {
    fail(TRANSFER_CODES.PATH_UNSAFE, "transferMetricsRoot required");
  }
  const root = assertAllowedRoot(transferMetricsRoot);
  const lockPath = join(root, LOCK_FILE_NAME);
  pathCall(() => assertInsideRoot(root, lockPath));
  assertRegularOrMissing(join(root, LOG_FILE_NAME));
  const lock = acquireLockRetry(lockPath, {
    lock_kind: "transfer_metrics",
    execution_id: "transfer-metrics",
    checkpoint_id: "transfer-events",
    chain_id: "transfer-events",
    lease_id: "none",
    lease_revision: 0,
    actor_id: "transfer-metrics-writer",
    session_id: "transfer-metrics",
    repository_identity: root,
    worktree_identity: root,
    expected_head: "none",
  });
  try {
    return fn(root);
  } finally {
    lock.release();
  }
}

const RAW_SNAPSHOT_ALGORITHM_VERSION = 1;
const RAW_LOG_ACTIVE_NAME = LOG_FILE_NAME;

function snapshotFail(code, message, details) {
  throw new TransferMetricsError(code, message, details);
}

function snapshotFileMeta(file) {
  return { name: file.name, byte_length: file.byte_length, sha256: file.sha256 };
}

function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Read-only raw-log snapshot under the EXISTING writer lock (OPTION B).
 * Linearization point: completion of the active-file read while the writer
 * lock is held. Reads O_RDONLY|O_NOFOLLOW only; never appends, truncates,
 * repairs, renames, or deletes log bytes. Not a generic reader: only the
 * transfer-metrics root namespace is accepted, no caller-supplied paths.
 */
export function captureRawLogSnapshot({ transferMetricsRoot, maxTotalBytes = PROJECTION_MAX_INPUT_BYTES } = {}) {
  if (typeof transferMetricsRoot !== "string" || transferMetricsRoot.length === 0) {
    fail(TRANSFER_CODES.PATH_UNSAFE, "transferMetricsRoot required");
  }
  if (maxTotalBytes !== undefined) {
    if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1) {
      snapshotFail(PROJECTION_INPUT_TOO_LARGE, "maxTotalBytes must be a positive integer");
    }
  }
  const root = assertAllowedRoot(transferMetricsRoot);
  const logPath = join(root, RAW_LOG_ACTIVE_NAME);
  const lockPath = join(root, LOCK_FILE_NAME);
  pathCall(() => assertInsideRoot(root, logPath));
  pathCall(() => assertInsideRoot(root, lockPath));
  assertRegularOrMissing(logPath);

  const lockIdentity = {
    lock_kind: "transfer_metrics",
    execution_id: "transfer-metrics",
    checkpoint_id: "transfer-events",
    chain_id: "transfer-events",
    lease_id: "none",
    lease_revision: 0,
    actor_id: "transfer-metrics-writer",
    session_id: "transfer-metrics",
    repository_identity: root,
    worktree_identity: root,
    expected_head: "none",
  };

  const lock = acquireLockRetry(lockPath, lockIdentity);
  try {
    // Revalidate fences under the lock, mirroring the append path.
    const rootUnderLock = assertAllowedRoot(root);
    const logPathUnderLock = join(rootUnderLock, RAW_LOG_ACTIVE_NAME);
    const lockPathUnderLock = join(rootUnderLock, LOCK_FILE_NAME);
    pathCall(() => assertInsideRoot(rootUnderLock, logPathUnderLock));
    pathCall(() => assertInsideRoot(rootUnderLock, lockPathUnderLock));
    assertRegularOrMissing(logPathUnderLock);

    // Dangling or regular symlink at the active leaf: lstat (never stat) so a
    // symlink whose target is missing still fails closed as non-regular.
    if (lstatSafe(logPathUnderLock)?.isSymbolicLink()) {
      snapshotFail(PROJECTION_NON_REGULAR_INPUT, "active log path is a symlink");
    }

    const candidateFiles = listLogFiles(rootUnderLock);

    const captured = [];
    let totalBytes = 0;
    for (const file of candidateFiles) {
      const name = basename(file);
      let preSt;
      try {
        preSt = lstatSync(file);
      } catch (e) {
        if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
          snapshotFail(PROJECTION_PATH_REPLACED, `log file disappeared during capture: ${name}`);
        }
        throw e;
      }
      if (preSt.isSymbolicLink() || !preSt.isFile() || preSt.nlink !== 1) {
        snapshotFail(PROJECTION_NON_REGULAR_INPUT, `log target is not a unique regular file: ${name}`);
      }
      let fd;
      try {
        fd = openSync(file, fsConstants.O_RDONLY | NOFOLLOW);
      } catch (e) {
        if (e && (e.code === "ENOENT" || e.code === "ELOOP" || e.code === "ENXIO")) {
          snapshotFail(PROJECTION_NON_REGULAR_INPUT, `log path replaced or symlinked during capture: ${name}`);
        }
        throw e;
      }
      try {
        const postSt = fstatSync(fd);
        if (postSt.dev !== preSt.dev || postSt.ino !== preSt.ino) {
          snapshotFail(PROJECTION_PATH_REPLACED, `log path replaced after open: ${name}`);
        }
        if (!postSt.isFile() || postSt.nlink !== 1) {
          snapshotFail(PROJECTION_NON_REGULAR_INPUT, `opened target is not a unique regular file: ${name}`);
        }
        const size = postSt.size;
        if (totalBytes + size > maxTotalBytes) {
          snapshotFail(PROJECTION_INPUT_TOO_LARGE, "raw log exceeds max input bytes");
        }
        const bytes = Buffer.alloc(size);
        let read = 0;
        while (read < size) {
          const n = readSync(fd, bytes, read, size - read, read);
          if (n <= 0) break;
          read += n;
        }
        if (read !== size) {
          snapshotFail(PROJECTION_NON_REGULAR_INPUT, `short read on log file: ${name}`);
        }
        const postReadSt = fstatSync(fd);
        if (postReadSt.dev !== preSt.dev
          || postReadSt.ino !== preSt.ino
          || postReadSt.nlink !== 1
          || postReadSt.size !== size) {
          snapshotFail(PROJECTION_NON_REGULAR_INPUT, `log file identity or size changed during capture: ${name}`);
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        captured.push({
          name,
          byte_offset: 0,
          byte_length: size,
          device: postReadSt.dev,
          inode: postReadSt.ino,
          nlink: postReadSt.nlink,
          sha256,
          bytes,
        });
        totalBytes += size;
      } finally {
        try { closeSync(fd); } catch { /* descriptor already closed */ }
      }
    }

    if (captured.length === 0) {
      snapshotFail(PROJECTION_INPUT_MISSING, "no raw log file exists in transfer metrics root");
    }

    // PARTIAL TAIL: captured partial trailing line fails closed. NOT repaired,
    // NOT truncated, NOT treated as EOF.
    const active = captured[captured.length - 1];
    if (active.name === RAW_LOG_ACTIVE_NAME && active.byte_length > 0) {
      const text = active.bytes.toString("utf8");
      if (!text.endsWith("\n")) {
        snapshotFail(PROJECTION_SNAPSHOT_RACE, "partial trailing line captured in active log");
      }
    }

    const resultFiles = captured.map(({ bytes, ...meta }) => ({ ...meta }));
    const rawInputDigest = createHash("sha256")
      .update(canonical(resultFiles.map(snapshotFileMeta)))
      .digest("hex");
    return {
      snapshot_algorithm_version: RAW_SNAPSHOT_ALGORITHM_VERSION,
      root: rootUnderLock,
      linearization: { lock_acquired: true, capture_point: "EOF_UNDER_WRITER_LOCK" },
      files: resultFiles,
      total_bytes: totalBytes,
      raw_input_digest: rawInputDigest,
      bytes: captured.map((entry) => entry.bytes),
    };
  } finally {
    lock.release();
  }
}

export { lastCompleteEvent, readLog };
