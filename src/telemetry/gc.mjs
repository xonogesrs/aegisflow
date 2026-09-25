// src/telemetry/gc.mjs
//
// S16 — GC / retention enforcement engine.
//
// Card: AUTOLOOP_GC_RETENTION_LARGE_IMPLEMENTATION_AND_CLOSEOUT_1.
// Contract: docs/governance/autoloop-s16-telemetry-authority-location-and-retention-contract.md
// (S16 remains THE authority contract; this module implements its §7 GC
// safety contract — it never reinterprets it).
//
// Invariants (fail-closed, all verified by test/telemetry/test-telemetry-gc.mjs):
//   - GC is storage lifecycle enforcement, NEVER execution authority. It
//     reads lifecycle truth (durable checkpoint / closeout state / review
//     surfaces) but no GC decision can create, mutate, or restore any
//     authority record.
//   - Containment: planning and deletion operate ONLY inside the canonical
//     telemetry namespace (resolveTelemetryStateRoot / TELEMETRY_ROOT) or an
//     explicitly admitted temporary namespace. Caller-supplied arbitrary
//     roots are rejected (GC_ARBITRARY_ROOT_DELETE = 0). Symlink components
//     anywhere between the namespace and the candidate abort the candidate
//     (GC_SYMLINK_ESCAPE = 0). Ambiguous ownership ⇒ retain
//     (GC_AMBIGUOUS_DELETE = 0).
//   - Ownership derivation order: derive → validate → containment →
//     ownership → eligibility → delete EXACT candidate. The delete phase
//     re-validates against the FROZEN plan (path + identity + size); it
//     never recomputes permissively.
//   - Protected set: anything required by the active graph / durable resume
//     / rollover / authored results / closeout / external review / verdict /
//     promotion / explicit forensic retention is PROTECTED. Protection
//     derives from authoritative lifecycle state, never from telemetry
//     observations.
//   - R3/R4 never live under the telemetry namespace (S16 Phase E fence) and
//     are never deletion candidates here.
//   - Plan-first: a GC cycle is a deterministic plan (PROTECTED / ELIGIBLE /
//     AMBIGUOUS / MISSING / PLANNED_DELETE / EXPECTED_BYTES_RECLAIMED)
//     executed only after freeze; filesystem drift between plan and execute
//     fails the affected candidate closed.
//   - Deletion is idempotent: a MISSING already-deleted candidate replays
//     safely.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  TELEMETRY_ROOT,
  TELEMETRY_STATE_ROOT_ENV,
  resolveTelemetryStateRoot,
} from "./location.mjs";
import { canonicalHome, readConfigEnv, resolveEvidenceRoot } from "../shared/autoloop-paths.mjs";

// ── Lifecycle vocabulary (S16 Phase F) ──────────────────────────────────────

export const GC_RETENTION_CLASSES = Object.freeze(["R0", "R1", "R2", "R3", "R4"]);

export const GC_PLAN_STATUSES = Object.freeze([
  "PROTECTED",
  "ELIGIBLE",
  "AMBIGUOUS",
  "MISSING",
  "PLANNED_DELETE",
]);

/** Rotated telemetry chunk naming (src/telemetry/store.mjs #rotate). */
const ROTATED_CHUNK_RE = /^telemetry-(\d+)\.jsonl$/;
/** Active telemetry stream file (protected while the run is not terminal). */
const ACTIVE_CHUNK_NAME = "telemetry.jsonl";
/** R-06: run-scoped telemetry init marker (src/telemetry/production-observer.mjs). */
const INIT_MARKER_NAME = "telemetry-init.json";

// ── Errors ──────────────────────────────────────────────────────────────────

export class GcHoldError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.code = code;
    this.name = "GcHoldError";
    this.details = details;
  }
}

export const GC_HOLD_CODES = Object.freeze({
  ARBITRARY_ROOT: "GC_ARBITRARY_ROOT_DELETE",
  SYMLINK_ESCAPE: "GC_SYMLINK_ESCAPE",
  AMBIGUOUS: "GC_AMBIGUOUS_DELETE",
  PLAN_DRIFT: "GC_PLAN_DRIFT",
  NAMESPACE_INVALID: "GC_NAMESPACE_INVALID",
  IDENTITY_INVALID: "GC_IDENTITY_INVALID",
});

// ── Containment helpers (R00 ownership principles) ─────────────────────────

function isWithin(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(".." + sep_) && rel !== "..");
}
const sep_ = "/";

/**
 * Canonical containment check: resolve the deepest existing ancestor via
 * realpath (symlinks can only exist among EXISTING components), then rebuild
 * the candidate path under it. Returns null when any existing component is a
 * symlink that escapes the namespace — the caller must retain, never delete.
 */
function canonicalInsideNamespace(candidate, namespace) {
  // Normalize the namespace through its deepest existing ancestor so macOS
  // /var→/private/var aliases compare equal on both sides.
  let nsProbe = resolve(namespace);
  const nsMissing = [];
  while (!existsSync(nsProbe)) {
    const parent = dirname(nsProbe);
    if (parent === nsProbe) return null;
    nsMissing.unshift(basename(nsProbe));
    nsProbe = parent;
  }
  let nsCanonical;
  try {
    nsCanonical = realpathSync(nsProbe);
  } catch {
    return null;
  }
  for (const part of nsMissing) nsCanonical = join(nsCanonical, part);

  let probe = resolve(candidate);
  const missing = [];
  for (;;) {
    if (existsSync(probe)) break;
    const parent = dirname(probe);
    if (parent === probe) return null;
    missing.unshift(basename(probe));
    probe = parent;
  }
  let canonical;
  try {
    canonical = realpathSync(probe);
  } catch {
    return null;
  }
  // The deepest EXISTING component must itself resolve inside the namespace
  // (a symlinked parent is an escape even when the leaf is missing).
  if (!isWithin(canonical, nsCanonical)) return null;
  for (const part of missing) canonical = join(canonical, part);
  // The rebuilt path (and the original) must both be inside the namespace.
  if (!isWithin(canonical, nsCanonical)) return null;
  if (!isWithin(resolve(candidate), resolve(namespace))) return null;
  return canonical;
}

/** Reject symlink components along the path (fail closed on any). */
function assertNoSymlinkComponents(path, label, stopAt = null) {
  let cur = resolve(path);
  // Walk from the candidate up to the namespace root; lstat every component.
  // Components at/above `stopAt` (the admitted namespace root itself) are not
  // walked — macOS /var→/private/var style aliases live there and are the
  // caller's admission decision, not a candidate escape.
  const stop = stopAt ? resolve(stopAt) : null;
  const parts = [];
  for (;;) {
    parts.unshift(cur);
    if (stop && (cur === stop || !isWithin(cur, stop))) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const p of parts) {
    let st;
    try {
      st = lstatSync(p);
    } catch (e) {
      if (e?.code === "ENOENT") continue; // missing components are fine
      throw new GcHoldError(GC_HOLD_CODES.SYMLINK_ESCAPE, `${label}: lstat failed: ${p}`);
    }
    if (st.isSymbolicLink()) {
      throw new GcHoldError(GC_HOLD_CODES.SYMLINK_ESCAPE, `${label}: symlink component: ${p}`);
    }
  }
}

// ── Identity validation (flat identities only — mirrors location.mjs) ──────

function assertFlatIdentity(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GcHoldError(GC_HOLD_CODES.IDENTITY_INVALID, `${label} required`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new GcHoldError(GC_HOLD_CODES.IDENTITY_INVALID, `${label} must be a flat identity: ${value}`);
  }
  return value;
}

// ── Lifecycle authority readers ────────────────────────────────────────────
//
// These read AUTHORITATIVE lifecycle state (durable checkpoint, closeout
// state, external review surface). They never read telemetry content to
// decide anything (S16 Phase C: telemetry is not execution authority).

// ── Namespace admission ────────────────────────────────────────────────────

/**
 * Resolve + validate a GC namespace. Only two shapes are admitted:
 *   1. the canonical run-scoped telemetry root for a graphRunId
 *      (resolveTelemetryStateRoot), or
 *   2. the canonical TELEMETRY_ROOT itself (namespace-wide sweep; each child
 *      is still validated individually), or
 *   3. an explicitly admitted temporary namespace via
 *      { tempNamespaceRoot } — must be an absolute path that is NOT $HOME,
 *      NOT a repo worktree, and NOT the authoritative evidence root.
 * Everything else fails closed (GC_ARBITRARY_ROOT_DELETE).
 */
export function resolveGcNamespace({ graphRunId = null, env = process.env, tempNamespaceRoot = null } = {}) {
  const evidenceRoot = resolveEvidenceRoot({ env });
  // The candidate below is realpath-resolved, so the fence must compare it
  // against a canonical HOME: a lexical `resolve(homedir())` is a different
  // string when home is reached through a symlink (macOS /tmp → /private/tmp),
  // and the $HOME fence would silently not fire.
  const home = canonicalHome();
  if (tempNamespaceRoot != null) {
    if (typeof tempNamespaceRoot !== "string" || !isAbsolute(tempNamespaceRoot)) {
      throw new GcHoldError(GC_HOLD_CODES.ARBITRARY_ROOT, `temp namespace must be absolute: ${tempNamespaceRoot}`);
    }
    // Resolve through the deepest existing ancestor so macOS /var→/private/var
    // style aliases cannot smuggle a $HOME path past the fence.
    let probe = resolve(tempNamespaceRoot);
    const missing = [];
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      missing.unshift(basename(probe));
      probe = parent;
    }
    let realBase;
    try {
      realBase = realpathSync(probe);
    } catch {
      throw new GcHoldError(GC_HOLD_CODES.ARBITRARY_ROOT, `temp namespace unresolvable: ${tempNamespaceRoot}`);
    }
    let resolved = realBase;
    for (const part of missing) resolved = join(resolved, part);
    if (isWithin(resolved, home)) {
      throw new GcHoldError(GC_HOLD_CODES.ARBITRARY_ROOT, `temp namespace inside $HOME rejected: ${resolved}`);
    }
    if (isWithin(resolved, evidenceRoot) || isWithin(evidenceRoot, resolved)) {
      throw new GcHoldError(GC_HOLD_CODES.ARBITRARY_ROOT, `temp namespace overlaps the authoritative evidence root: ${resolved}`);
    }
    if (resolved === resolve(TELEMETRY_ROOT)) {
      throw new GcHoldError(GC_HOLD_CODES.ARBITRARY_ROOT, "temp namespace must not be the canonical telemetry root itself");
    }
    return { kind: "TEMP", root: resolved };
  }
  if (graphRunId != null) {
    assertFlatIdentity(graphRunId, "graphRunId");
    const root = resolveTelemetryStateRoot({ graphRunId, env });
    // location.mjs semantics: without an override the resolver returns
    // join(TELEMETRY_ROOT, graphRunId) — the run-scoped child. With an
    // override (tests/CI isolation) it returns the override EXACTLY — the
    // run-scoped store root. Either way the resolver's return value IS the
    // run root; the GC namespace adopts it verbatim.
    return { kind: "RUN", root: resolve(root), graphRunId };
  }
  // Namespace-wide sweep. With an override in effect the sweep root is the
  // override (the isolated store root); without one it is the canonical
  // TELEMETRY_ROOT whose children are the run-scoped stores.
  const override = readConfigEnv(env, TELEMETRY_STATE_ROOT_ENV);
  const sweepRoot = (override && isAbsolute(override.value))
    ? resolve(override.value)
    : resolve(TELEMETRY_ROOT);
  return { kind: "CANONICAL_SWEEP", root: sweepRoot };
}

// ── Protected-set derivation (S16 Phase D) ─────────────────────────────────

/**
 * Derive the GC_PROTECTED set for one run-scoped telemetry namespace.
 *
 * Protection sources (authoritative lifecycle state only):
 *   - activeChunk: the active telemetry stream is R1 while the run is not
 *     terminal; a terminal run's active stream is R1→R2 with a bounded
 *     recovery window (recoveryWindowActive).
 *   - recoveryWindow: after terminal, the whole run root stays protected for
 *     `recoveryWindowMs` (crash/resume protection; bounded, default 24h).
 *   - durable resume: a resumable execution bound to this run keeps
 *     everything protected (resume-required semantics).
 *   - external review: an unresolved Current-surface delivery protects the
 *     run (review surface may cite run telemetry identity).
 *   - closeout: an unresolved closeout-state record protects the run.
 *   - rollover: caller-declared rollover-in-progress / successor-dispatch
 *     state (authoritative flags, never telemetry-derived).
 *
 * The returned set is a set of PROTECTION REASONS plus per-path decisions —
 * it is consumed by planTelemetryGc.
 */
export function deriveProtectedSet({
  lifecycle = {},
  now = Date.now(),
  recoveryWindowMs = 24 * 60 * 60 * 1000,
} = {}) {
  const protectedSet = {
    reasons: [],
    runProtected: false, // whole run root protected (no deletion at all)
    activeChunkProtected: false,
    recoveryWindowActive: false,
  };
  const {
    runTerminal = null, // null = unknown ⇒ fail closed to protected
    resumableExecution = false,
    rolloverInProgress = false,
    successorDispatchPending = false,
    // Caller-provided authoritative flags. When omitted these are treated as
    // NOT protecting this run: the Current external-review surface and
    // closeout-state records are CARD-scoped (they bind a card/outDir, not a
    // graphRunId), so a per-run GC namespace cannot infer protection from
    // them — callers that know a run is cited by review/closeout state pass
    // the flag explicitly. Fail-closed behavior is preserved at the
    // whole-namespace level: LIFECYCLE_UNKNOWN still protects everything.
    externalReviewUnresolved = false,
    closeoutUnresolved = false,
    terminalAt = null,
  } = lifecycle;

  if (runTerminal === null) {
    protectedSet.reasons.push("LIFECYCLE_UNKNOWN");
    protectedSet.runProtected = true;
  }
  if (resumableExecution) {
    protectedSet.reasons.push("RESUME_REQUIRED");
    protectedSet.runProtected = true;
  }
  if (rolloverInProgress) {
    protectedSet.reasons.push("ROLLOVER_IN_PROGRESS");
    protectedSet.runProtected = true;
  }
  if (successorDispatchPending) {
    protectedSet.reasons.push("SUCCESSOR_DISPATCH_PENDING");
    protectedSet.runProtected = true;
  }
  if (externalReviewUnresolved) {
    protectedSet.reasons.push("EXTERNAL_REVIEW_SURFACE");
    protectedSet.runProtected = true;
  }
  if (closeoutUnresolved ?? false) {
    protectedSet.reasons.push("CLOSEOUT_UNRESOLVED");
    protectedSet.runProtected = true;
  }
  if (runTerminal === false) {
    protectedSet.reasons.push("RUN_ACTIVE");
    protectedSet.activeChunkProtected = true;
    protectedSet.runProtected = true;
  }
  if (runTerminal === true) {
    if (typeof terminalAt === "number" && now - terminalAt < recoveryWindowMs) {
      protectedSet.reasons.push("RECOVERY_WINDOW");
      protectedSet.recoveryWindowActive = true;
      protectedSet.runProtected = true;
    }
    // terminal + window elapsed: the active chunk is R1→R2; rotated chunks
    // are R2 with bounded retention. runProtected stays false.
  }
  return protectedSet;
}

// ── Rotated-chunk eligibility (S16 Phase E) ────────────────────────────────

export const DEFAULT_ROTATED_CHUNK_KEEP = 4;

/**
 * Classify one rotated chunk for retention. NOT filename-order authority:
 * each chunk must parse to a valid store header (schema + schemaVersion) and
 * carry a positive sequence; classification uses the sequence number ONLY
 * after the content validates, and the newest `keep` VALID chunks are
 * retained as bounded historical observability. Malformed/ambiguous chunks
 * are retained (fail closed) and reported as AMBIGUOUS.
 */
export function classifyRotatedChunk({ path, keep = DEFAULT_ROTATED_CHUNK_KEEP, validChunks = null }) {
  const name = basename(path);
  const m = ROTATED_CHUNK_RE.exec(name);
  if (!m) return { status: "AMBIGUOUS", reason: "name_not_a_rotated_chunk" };
  const seq = Number(m[1]);
  if (!Number.isInteger(seq) || seq <= 0) return { status: "AMBIGUOUS", reason: "sequence_invalid" };
  let header = null;
  try {
    const first = readFileSync(path, "utf8").split("\n")[0];
    header = JSON.parse(first);
  } catch {
    return { status: "AMBIGUOUS", reason: "header_unreadable" };
  }
  if (!header || typeof header !== "object" || header.schema !== "autoloop.telemetry-store/v1") {
    return { status: "AMBIGUOUS", reason: "header_schema_unknown" };
  }
  const rank = validChunks?.get(seq);
  if (rank == null) return { status: "AMBIGUOUS", reason: "sequence_not_in_valid_set" };
  if (rank < keep) return { status: "PROTECTED", reason: "BOUNDED_OBSERVABILITY_WINDOW" };
  return { status: "ELIGIBLE", reason: "ROTATED_CHUNK_BEYOND_KEEP" };
}

// ── Plan (S16 Phase H) ─────────────────────────────────────────────────────

/**
 * Plan one GC cycle over an admitted namespace. PURE W.R.T. MUTATION: reads
 * the filesystem, never deletes. Deterministic: same state ⇒ same plan.
 *
 * Returns { namespace, plan: { PROTECTED, ELIGIBLE, AMBIGUOUS, MISSING,
 * PLANNED_DELETE, EXPECTED_BYTES_RECLAIMED }, frozenAt }.
 */
export function planTelemetryGc({
  namespace,
  lifecycle = {},
  rotatedChunkKeep = DEFAULT_ROTATED_CHUNK_KEEP,
  now = Date.now(),
  recoveryWindowMs = 24 * 60 * 60 * 1000,
} = {}) {
  if (!namespace || typeof namespace.root !== "string") {
    throw new GcHoldError(GC_HOLD_CODES.NAMESPACE_INVALID, "namespace required");
  }
  const nsRoot = resolve(namespace.root);
  const plan = {
    PROTECTED: [],
    ELIGIBLE: [],
    AMBIGUOUS: [],
    MISSING: [],
    PLANNED_DELETE: [],
    EXPECTED_BYTES_RECLAIMED: 0,
  };

  if (namespace.kind === "RUN") {
    planRunNamespace({ nsRoot, graphRunId: namespace.graphRunId, lifecycle, rotatedChunkKeep, now, recoveryWindowMs, plan });
  } else if (namespace.kind === "CANONICAL_SWEEP") {
    // Enumerate run children; each child is validated as its own namespace.
    let children = [];
    try {
      children = readdirSync(nsRoot, { withFileTypes: true });
    } catch (e) {
      if (e?.code === "ENOENT") return { namespace, plan, frozenAt: now };
      throw new GcHoldError(GC_HOLD_CODES.NAMESPACE_INVALID, `canonical sweep read failed: ${e?.code ?? e}`);
    }
    for (const child of children) {
      const childPath = join(nsRoot, child.name);
      if (child.isSymbolicLink()) {
        plan.AMBIGUOUS.push({ path: childPath, reason: "SYMLINK_IN_CANONICAL_ROOT" });
        continue;
      }
      if (!child.isDirectory()) {
        plan.AMBIGUOUS.push({ path: childPath, reason: "NOT_A_RUN_DIRECTORY" });
        continue;
      }
      let runId = child.name;
      try {
        assertFlatIdentity(runId, "graphRunId");
      } catch {
        plan.AMBIGUOUS.push({ path: childPath, reason: "IDENTITY_INVALID" });
        continue;
      }
      planRunNamespace({ nsRoot: childPath, graphRunId: runId, lifecycle, rotatedChunkKeep, now, recoveryWindowMs, plan });
    }
  } else if (namespace.kind === "TEMP") {
    planTempNamespace({ nsRoot, plan });
  } else {
    throw new GcHoldError(GC_HOLD_CODES.NAMESPACE_INVALID, `unknown namespace kind: ${namespace.kind}`);
  }

  plan.PLANNED_DELETE = plan.ELIGIBLE.slice();
  plan.EXPECTED_BYTES_RECLAIMED = plan.PLANNED_DELETE.reduce((sum, c) => sum + (c.bytes ?? 0), 0);
  return { namespace, plan, frozenAt: now };
}

function planRunNamespace({ nsRoot, graphRunId, lifecycle, rotatedChunkKeep, now, recoveryWindowMs, plan }) {
  assertFlatIdentity(graphRunId, "graphRunId");
  if (!existsSync(nsRoot)) {
    // Whole run missing: nothing to do; record as MISSING (idempotent replay).
    plan.MISSING.push({ path: nsRoot, reason: "RUN_ROOT_ABSENT" });
    return;
  }
  assertNoSymlinkComponents(nsRoot, "run root", nsRoot);
  // Containment was enforced at admission time (resolveGcNamespace admits
  // only the canonical telemetry namespace / an admitted temp namespace) and
  // is re-verified per candidate below; realpath divergence of the run root
  // itself (macOS /var→/private/var aliases) is the caller's admission
  // decision, not a candidate escape vector.

  const protectedSet = deriveProtectedSet({ lifecycle, now, recoveryWindowMs });
  if (protectedSet.runProtected) {
    // Whole-run protection: every entry recorded PROTECTED with its reason.
    const entries = listRunEntries(nsRoot);
    for (const e of entries) {
      plan.PROTECTED.push({ path: e.path, reason: protectedSet.reasons.join("|"), bytes: e.bytes });
    }
    return;
  }

  const entries = listRunEntries(nsRoot);
  // Pass 1: validate rotated chunks (content authority, not filename order).
  const rotated = entries.filter((e) => ROTATED_CHUNK_RE.test(basename(e.path)));
  const validChunks = new Map(); // seq -> rank (0 = newest)
  const parsed = [];
  for (const e of rotated) {
    const m = ROTATED_CHUNK_RE.exec(basename(e.path));
    const seq = Number(m[1]);
    let headerOk = false;
    try {
      const first = readFileSync(e.path, "utf8").split("\n")[0];
      const h = JSON.parse(first);
      headerOk = Boolean(h && typeof h === "object" && h.schema === "autoloop.telemetry-store/v1");
    } catch { headerOk = false; }
    if (headerOk && Number.isInteger(seq) && seq > 0) parsed.push({ seq, e });
  }
  parsed.sort((a, b) => b.seq - a.seq);
  parsed.forEach((p, i) => validChunks.set(p.seq, i));

  for (const e of entries) {
    const name = basename(e.path);
    if (e.symlink) {
      // A symlinked entry inside the run root is an escape vector: retain,
      // classify AMBIGUOUS, never delete (GC_SYMLINK_ESCAPE = 0).
      plan.AMBIGUOUS.push({ path: e.path, reason: "SYMLINK_IN_RUN_ROOT", bytes: 0 });
      continue;
    }
    if (name === ACTIVE_CHUNK_NAME) {
      // Terminal + window elapsed: the active stream is R1→R2 and becomes
      // bounded-historical; it is retained with the rotated window (the
      // newest observability) — reclaiming it would erase the run's tail.
      plan.PROTECTED.push({ path: e.path, reason: "ACTIVE_STREAM_RETAINED_POST_WINDOW", bytes: e.bytes });
      continue;
    }
    if (name === INIT_MARKER_NAME) {
      // R-06: the run's telemetry-init marker (autoloop.telemetry-init/v1) —
      // run-identity observability bound to the store; retained with the
      // active stream, never a deletion candidate.
      plan.PROTECTED.push({ path: e.path, reason: "TELEMETRY_INIT_MARKER_RETAINED", bytes: e.bytes });
      continue;
    }
    const cls = classifyRotatedChunk({ path: e.path, keep: rotatedChunkKeep, validChunks });
    if (cls.status === "AMBIGUOUS") {
      plan.AMBIGUOUS.push({ path: e.path, reason: cls.reason, bytes: e.bytes });
      continue;
    }
    if (cls.status === "PROTECTED") {
      plan.PROTECTED.push({ path: e.path, reason: cls.reason, bytes: e.bytes });
      continue;
    }
    // ELIGIBLE: re-verify containment + no symlink before listing.
    try {
      assertNoSymlinkComponents(e.path, "candidate", nsRoot);
    } catch (err) {
      plan.AMBIGUOUS.push({ path: e.path, reason: `SYMLINK_ESCAPE:${err.code}`, bytes: e.bytes });
      continue;
    }
    const canonical = canonicalInsideNamespace(e.path, nsRoot);
    if (!canonical) {
      plan.AMBIGUOUS.push({ path: e.path, reason: "CONTAINMENT_UNRESOLVABLE", bytes: e.bytes });
      continue;
    }
    plan.ELIGIBLE.push({ path: e.path, graphRunId, retentionClass: "R2", bytes: e.bytes, plannedIsDir: Boolean(e.isDir), identity: { graphRunId, seq: Number(ROTATED_CHUNK_RE.exec(name)[1]) } });
  }
}

function listRunEntries(nsRoot) {
  const out = [];
  let dirents;
  try {
    dirents = readdirSync(nsRoot, { withFileTypes: true });
  } catch (e) {
    throw new GcHoldError(GC_HOLD_CODES.NAMESPACE_INVALID, `run root read failed: ${e?.code ?? e}`);
  }
  for (const d of dirents) {
    const p = join(nsRoot, d.name);
    if (d.isSymbolicLink()) {
      out.push({ path: p, bytes: 0, symlink: true });
      continue;
    }
    let bytes = 0;
    try {
      bytes = d.isDirectory() ? dirBytes(p) : statSync(p).size;
    } catch { bytes = 0; }
    out.push({ path: p, bytes, symlink: false, isDir: d.isDirectory() });
  }
  return out;
}

function dirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) total += dirBytes(p);
      else total += statSync(p).size;
    } catch { /* best-effort accounting */ }
  }
  return total;
}

function planTempNamespace({ nsRoot, plan }) {
  // An admitted temporary namespace is GC-eligible ONLY when it carries the
  // AegisFlow temporary-admission marker; anything else inside is AMBIGUOUS.
  const marker = join(nsRoot, ".autoloop-gc-temp");
  if (!existsSync(marker)) {
    plan.AMBIGUOUS.push({ path: nsRoot, reason: "TEMP_NAMESPACE_UNMARKED" });
    return;
  }
  let record = null;
  try {
    record = JSON.parse(readFileSync(marker, "utf8"));
  } catch {
    plan.AMBIGUOUS.push({ path: nsRoot, reason: "TEMP_MARKER_UNREADABLE" });
    return;
  }
  if (record?.schema !== "autoloop.gc-temp-admission/v1" || typeof record?.ownerLifecycle !== "string") {
    plan.AMBIGUOUS.push({ path: nsRoot, reason: "TEMP_MARKER_INVALID" });
    return;
  }
  if (record.ownerLifecycle !== "ENDED") {
    plan.PROTECTED.push({ path: nsRoot, reason: "TEMP_OWNER_LIFETIME_ACTIVE", bytes: 0 });
    return;
  }
  plan.ELIGIBLE.push({
    path: nsRoot,
    retentionClass: "R0",
    bytes: dirBytes(nsRoot),
    plannedIsDir: true,
    identity: { tempNamespace: nsRoot, ownerLifecycle: record.ownerLifecycle },
  });
}

// ── Execute the frozen plan (S16 Phase H/I) ────────────────────────────────

/**
 * Execute a frozen plan. Re-validates every candidate against the plan and
 * the live filesystem BEFORE deletion:
 *   - path must be exactly a planned path (no permissive recomputation);
 *   - the candidate must still exist (MISSING ⇒ recorded, idempotent);
 *   - containment + symlink checks re-run (drift ⇒ skip, fail closed);
 *   - deletion is unlink/rm of the EXACT planned path only.
 * Never deletes a PROTECTED/AMBIGUOUS entry. Returns a receipt.
 */
export function executeGcPlan({ planResult } = {}) {
  if (!planResult?.plan) throw new GcHoldError(GC_HOLD_CODES.PLAN_DRIFT, "frozen plan required");
  const { plan, namespace } = planResult;
  const receipt = { deleted: [], missing: [], skipped: [], reclaimedBytes: 0, plannedCount: plan.PLANNED_DELETE.length };
  const plannedPaths = new Set(plan.PLANNED_DELETE.map((c) => c.path));
  for (const candidate of plan.PLANNED_DELETE) {
    const p = resolve(candidate.path);
    if (!plannedPaths.has(p)) {
      receipt.skipped.push({ path: p, reason: "NOT_IN_FROZEN_PLAN" });
      continue;
    }
    if (!existsSync(p) && !existsSyncDeref(p)) {
      receipt.missing.push({ path: p, reason: "ALREADY_DELETED" });
      continue;
    }
    const nsRoot = namespace?.root ? resolve(namespace.root) : null;
    if (!nsRoot || !isWithin(p, nsRoot)) {
      receipt.skipped.push({ path: p, reason: "DRIFT:OUTSIDE_NAMESPACE" });
      continue;
    }
    try {
      assertNoSymlinkComponents(p, "execute candidate", nsRoot);
    } catch (err) {
      receipt.skipped.push({ path: p, reason: `DRIFT:${err.code}` });
      continue;
    }
    const canonical = canonicalInsideNamespace(p, nsRoot);
    if (!canonical) {
      receipt.skipped.push({ path: p, reason: "DRIFT:CONTAINMENT_UNRESOLVABLE" });
      continue;
    }
    // Re-derive eligibility class from the candidate record itself.
    if (candidate.retentionClass !== "R2" && candidate.retentionClass !== "R0") {
      receipt.skipped.push({ path: p, reason: `DRIFT:CLASS_${candidate.retentionClass}` });
      continue;
    }
    // Cross-check against the plan's own PROTECTED/AMBIGUOUS sets: a tampered
    // plan that promotes a protected path into PLANNED_DELETE is refused.
    if (plan.PROTECTED.some((e) => resolve(e.path) === p) || plan.AMBIGUOUS.some((e) => resolve(e.path) === p)) {
      receipt.skipped.push({ path: p, reason: "DRIFT:PATH_IN_PROTECTED_SET" });
      continue;
    }
    try {
      const st = lstatSync(p);
      // Shape drift: the plan froze a FILE candidate but the live entry is a
      // directory (or vice versa) — the frozen identity no longer describes
      // what is on disk. Fail closed: skip, never blindly recurse.
      const plannedIsDir = candidate.plannedIsDir === true;
      if (st.isDirectory() !== plannedIsDir) {
        receipt.skipped.push({ path: p, reason: "DRIFT:ENTRY_SHAPE_CHANGED" });
        continue;
      }
      rmSync(p, { recursive: st.isDirectory(), force: true });
      receipt.deleted.push({ path: p, bytes: candidate.bytes ?? 0 });
      receipt.reclaimedBytes += candidate.bytes ?? 0;
    } catch (e) {
      receipt.skipped.push({ path: p, reason: `DELETE_FAILED:${e?.code ?? e}` });
    }
  }
  return receipt;
}

function existsSyncDeref(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** One-shot convenience: plan + execute + receipt (still plan-first inside). */
export function runTelemetryGc(opts = {}) {
  const planResult = planTelemetryGc(opts);
  const receipt = executeGcPlan({ planResult });
  return { planResult, receipt };
}

// ── Within-run checkpoint/prior bounds (S16 Phase F) ───────────────────────
//
// The checkpoint store's `prior/` directory holds one immutable snapshot per
// revision (CURRENT.<12-digit-revision>.json). CURRENT.json itself is
// CURRENT_REQUIRED; the newest prior snapshots form the RESUME/ROLLOVER
// protection window; older ones are HISTORICAL_ONLY → GC_ELIGIBLE.
// Eligibility follows durable lifecycle authority (terminal verdict),
// NEVER filename recency alone.

export const DEFAULT_PRIOR_SNAPSHOT_KEEP = 8;

export function classifyPriorSnapshot({ path, terminalVerdict = false, keep = DEFAULT_PRIOR_SNAPSHOT_KEEP, validRanks = null }) {
  const name = basename(path);
  const m = /^CURRENT\.(\d{12})\.json$/.exec(name);
  if (!m) return { status: "AMBIGUOUS", reason: "name_not_a_prior_snapshot" };
  const revision = Number(m[1]);
  if (!Number.isInteger(revision) || revision < 0) return { status: "AMBIGUOUS", reason: "revision_invalid" };
  if (!terminalVerdict) return { status: "PROTECTED", reason: "RUN_NOT_TERMINAL_RESUME_REQUIRED" };
  const rank = validRanks?.get(revision);
  if (rank == null) return { status: "AMBIGUOUS", reason: "revision_not_in_valid_set" };
  if (rank < keep) return { status: "PROTECTED", reason: "BOUNDED_PRIOR_WINDOW" };
  return { status: "ELIGIBLE", reason: "PRIOR_BEYOND_KEEP_POST_TERMINAL" };
}

/**
 * Plan a within-run prior/ bound sweep for one durable execution directory.
 * The execDir must live under an evidence-root-validated persistence root;
 * CURRENT.json + checksum + lock are always PROTECTED (CURRENT_REQUIRED).
 * Only `prior/CURRENT.<rev>.json` snapshots beyond the bounded keep window,
 * and only after a TERMINAL checkpoint verdict, are eligible.
 */
export function planPriorSnapshotGc({
  persistenceRoot,
  executionId,
  keep = DEFAULT_PRIOR_SNAPSHOT_KEEP,
  env = process.env,
} = {}) {
  assertFlatIdentity(executionId, "executionId");
  const evidenceRoot = resolveEvidenceRoot({ env });
  const root = resolve(persistenceRoot ?? "");
  if (!isAbsolute(root)) throw new GcHoldError(GC_HOLD_CODES.ARBITRARY_ROOT, "persistenceRoot must be absolute");
  // Containment: the execDir must be inside the admitted persistence root
  // and must NOT be the evidence root or a repo worktree. The canonical
  // production default (~/.autoloop/durable) is admitted; the authoritative
  // evidence namespace is NOT (it is R3 wholesale).
  if (isWithin(root, evidenceRoot)) {
    throw new GcHoldError(GC_HOLD_CODES.ARBITRARY_ROOT, `persistence root inside authoritative evidence root rejected: ${root}`);
  }
  const execDir = join(root, executionId);
  const plan = { PROTECTED: [], ELIGIBLE: [], AMBIGUOUS: [], MISSING: [], PLANNED_DELETE: [], EXPECTED_BYTES_RECLAIMED: 0 };
  const current = join(execDir, "CURRENT.json");
  if (!existsSync(current)) {
    plan.MISSING.push({ path: execDir, reason: "EXEC_DIR_OR_CURRENT_ABSENT" });
    return { plan, execDir };
  }
  assertNoSymlinkComponents(current, "CURRENT.json", execDir);
  let cp;
  try {
    cp = JSON.parse(readFileSync(current, "utf8"));
  } catch {
    plan.PROTECTED.push({ path: execDir, reason: "CURRENT_UNREADABLE_FAIL_CLOSED", bytes: 0 });
    return { plan, execDir };
  }
  const terminal = Boolean(cp?.final_verdict);
  // CURRENT_REQUIRED + RESUME_REQUIRED surface files.
  for (const f of ["CURRENT.json", "CURRENT.json.sha256", "CURRENT.json.lock"]) {
    const p = join(execDir, f);
    if (existsSync(p)) plan.PROTECTED.push({ path: p, reason: terminal ? "CURRENT_REQUIRED" : "CURRENT_AND_RESUME_REQUIRED", bytes: fileSize(p) });
  }
  const priorDir = join(execDir, "prior");
  if (!existsSync(priorDir)) return { plan, execDir };
  assertNoSymlinkComponents(priorDir, "prior dir", execDir);
  const names = readdirSync(priorDir).sort();
  const parsed = [];
  for (const name of names) {
    const m = /^CURRENT\.(\d{12})\.json$/.exec(name);
    if (!m) {
      plan.AMBIGUOUS.push({ path: join(priorDir, name), reason: "name_not_a_prior_snapshot", bytes: fileSize(join(priorDir, name)) });
      continue;
    }
    const revision = Number(m[1]);
    let bytesOk = false;
    const p = join(priorDir, name);
    try {
      const parsedSnapshot = JSON.parse(readFileSync(p, "utf8"));
      bytesOk = parsedSnapshot && typeof parsedSnapshot === "object" && parsedSnapshot.execution_id === executionId && parsedSnapshot.revision === revision;
    } catch { bytesOk = false; }
    if (!bytesOk) {
      plan.AMBIGUOUS.push({ path: p, reason: "snapshot_identity_or_revision_mismatch", bytes: fileSize(p) });
      continue;
    }
    parsed.push({ revision, path: p, bytes: fileSize(p) });
  }
  parsed.sort((a, b) => b.revision - a.revision);
  const validRanks = new Map(parsed.map((s, i) => [s.revision, i]));
  for (const s of parsed) {
    const cls = classifyPriorSnapshot({ path: s.path, terminalVerdict: terminal, keep, validRanks });
    if (cls.status === "ELIGIBLE") {
      plan.ELIGIBLE.push({ path: s.path, executionId, retentionClass: "R2", bytes: s.bytes, plannedIsDir: false, identity: { executionId, revision: s.revision } });
    } else {
      plan.PROTECTED.push({ path: s.path, reason: cls.reason, bytes: s.bytes });
    }
  }
  plan.PLANNED_DELETE = plan.ELIGIBLE.slice();
  plan.EXPECTED_BYTES_RECLAIMED = plan.PLANNED_DELETE.reduce((sum, c) => sum + (c.bytes ?? 0), 0);
  return { plan, execDir };
}

function fileSize(p) {
  try {
    const st = lstatSync(p);
    return st.isDirectory() ? dirBytes(p) : st.size;
  } catch {
    return 0;
  }
}

/** Execute a frozen prior-snapshot plan (same discipline as telemetry GC). */
export function executePriorSnapshotGc({ planResult } = {}) {
  if (!planResult?.plan) throw new GcHoldError(GC_HOLD_CODES.PLAN_DRIFT, "frozen plan required");
  const { plan } = planResult;
  const receipt = { deleted: [], missing: [], skipped: [], reclaimedBytes: 0, plannedCount: plan.PLANNED_DELETE.length };
  const plannedPaths = new Set(plan.PLANNED_DELETE.map((c) => c.path));
  for (const candidate of plan.PLANNED_DELETE) {
    const p = resolve(candidate.path);
    if (!plannedPaths.has(p)) {
      receipt.skipped.push({ path: p, reason: "NOT_IN_FROZEN_PLAN" });
      continue;
    }
    if (!existsSync(p)) {
      receipt.missing.push({ path: p, reason: "ALREADY_DELETED" });
      continue;
    }
    // A prior snapshot must remain inside its execDir/prior and must never
    // be a symlink; CURRENT.json must STILL exist (resume authority intact).
    const execDir = dirname(dirname(p));
    if (basename(dirname(p)) !== "prior" || !existsSync(join(execDir, "CURRENT.json"))) {
      receipt.skipped.push({ path: p, reason: "DRIFT:EXEC_AUTHORITY_CHANGED" });
      continue;
    }
    try {
      assertNoSymlinkComponents(p, "prior candidate", execDir);
    } catch (err) {
      receipt.skipped.push({ path: p, reason: `DRIFT:${err.code}` });
      continue;
    }
    try {
      rmSync(p, { force: true });
      receipt.deleted.push({ path: p, bytes: candidate.bytes ?? 0 });
      receipt.reclaimedBytes += candidate.bytes ?? 0;
    } catch (e) {
      receipt.skipped.push({ path: p, reason: `DELETE_FAILED:${e?.code ?? e}` });
    }
  }
  return receipt;
}

// ── Temporary namespace admission helper (S16 Phase G) ─────────────────────

/**
 * Mark a temporary namespace as GC-admitted for one owning lifecycle.
 * The marker is what makes a temp root GC-eligible at all; without it the
 * namespace is AMBIGUOUS (retain). `ownerLifecycle: "ENDED"` is written only
 * by the OWNING lifecycle's own cleanup seam — GC never flips it.
 */
export function admitTempNamespace({ root, owner, ownerLifecycle = "ACTIVE" } = {}) {
  if (!root || !isAbsolute(root)) throw new GcHoldError(GC_HOLD_CODES.NAMESPACE_INVALID, "temp root must be absolute");
  const resolved = resolve(root);
  const marker = join(resolved, ".autoloop-gc-temp");
  writeMarkerAtomic(marker, {
    schema: "autoloop.gc-temp-admission/v1",
    owner: owner ?? null,
    ownerLifecycle,
    admittedAt: new Date().toISOString(),
  });
  return marker;
}

function writeMarkerAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
