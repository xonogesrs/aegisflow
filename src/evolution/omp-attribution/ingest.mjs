// src/evolution/omp-attribution/ingest.mjs
//
// AEGISFLOW_OMP_ATTRIBUTION_CONTRACT_DESIGN_1 §3.2/§3.5 — the per-session state
// machine and the (only) persistence of the OMP observation domain.
//
//   SEEN → QUIESCENT_CANDIDATE → RECORDED
//                                   ↘ EXTENDED_AFTER_RECORD | PREFIX_MISMATCH
//
// Write order (crash safety): the observation file is created EXCLUSIVELY
// first (one file per observation_id), the state file is replaced atomically
// second. A crash between the two leaves a state that is not yet RECORDED and
// an observation that already exists; the next run reconciles instead of
// writing a second record. "Count" is always the number of final
// `ompobs_<hex>.json` files, so a double count is impossible by construction.
//
// Everything lives under `<store>/omp-observations/`. This module imports
// nothing from strategy-memory / attribution-feed / trigger / promotion, and
// writes nothing outside that directory. Dry-run (the default) persists
// nothing at all.

import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import {
  C2dHoldError, HOLD, acquireExclusiveLock, assertPathComponentsNotSymlink, ensureDir0700,
  releaseExclusiveLock, writeJsonAtomicReplaceUnderLock, writeJsonExclusiveCreate,
} from "../../c2d/fs-atomic.mjs";
import { evolutionSuspensionPath } from "../kill-switch.mjs";
import {
  OBSERVATION_ID_RE, OMP_OBSERVATION_STATE_SCHEMA, assertOutputSafe, observationIdFor, sha256Hex,
  validateObservation,
} from "./contract.mjs";
import {
  SESSION_FILE_RE, buildObservation, cwdDecision, defaultLsof, discoverSessionFiles,
  identityEquals, observeSessionFile, parseSessionBytes, peekHeader, prefixDigest, readSessionBytes,
} from "./extract.mjs";

export const OBS_DIRNAME = "omp-observations";
export const DEFAULT_QUIESCENCE_MS = 30 * 60 * 1000;
export const STATUSES = Object.freeze([
  "SEEN", "QUIESCENT_CANDIDATE", "RECORDED", "EXTENDED_AFTER_RECORD", "PREFIX_MISMATCH",
]);
const SETTLED = new Set(["RECORDED", "EXTENDED_AFTER_RECORD", "PREFIX_MISMATCH"]);
const TRUSTED = new Set(["RECORDED", "EXTENDED_AFTER_RECORD"]);

export const paths = (storeRoot) => {
  const root = join(storeRoot, OBS_DIRNAME);
  return {
    root,
    observations: join(root, "observations"),
    state: join(root, "state"),
    lock: join(root, ".run.lock"),
  };
};

/** Same two rules as evolutionSwitchState(), without importing the observer
 *  (which would drag the strategy-memory side into this domain). */
export function suspendedState({ env = process.env, storeRoot = null } = {}) {
  if (String(env?.AUTO_EVOLUTION ?? "").toUpperCase() === "SUSPENDED") return "env:AUTO_EVOLUTION=SUSPENDED";
  if (storeRoot) {
    // Fail-closed: the mere PRESENCE of the marker path (valid, corrupt, or a
    // symlink — even a dangling one) suspends. readEvolutionSuspension() returns
    // null for the unreadable cases, which would fail OPEN.
    try {
      lstatSync(evolutionSuspensionPath(storeRoot));
      return "durable suspension marker";
    } catch (e) {
      if (e?.code !== "ENOENT") return "suspension marker unreadable (fail-closed)";
    }
  }
  return null;
}

// ── state records ───────────────────────────────────────────────────────────

function isIdentity(v) {
  return v && typeof v === "object"
    && typeof v.dev === "string" && typeof v.ino === "string" && Number.isInteger(v.size)
    && typeof v.mtime_ns === "string" && /^[0-9a-f]{64}$/.test(String(v.tail_sha256));
}

function validState(s, oid) {
  return s && typeof s === "object" && s.schema === OMP_OBSERVATION_STATE_SCHEMA
    && s.observation_id === oid && STATUSES.includes(s.status) && isIdentity(s.identity)
    && typeof s.first_seen_at === "string" && typeof s.last_seen_at === "string"
    && typeof s.stable_since === "string"
    && (!SETTLED.has(s.status) || (Number.isInteger(s.recorded_size) && /^[0-9a-f]{64}$/.test(String(s.recorded_file_sha256))));
}

/** @returns {{ kind: "absent" } | { kind: "ok", state: object } | { kind: "corrupt" }} */
function readState(storeRoot, oid) {
  const p = join(paths(storeRoot).state, `${oid}.json`);
  if (!existsSync(p)) return { kind: "absent" };
  try {
    const st = lstatSync(p);
    if (!st.isFile()) return { kind: "corrupt" };
    const s = JSON.parse(readFileSync(p, "utf8"));
    return validState(s, oid) ? { kind: "ok", state: s } : { kind: "corrupt" };
  } catch { return { kind: "corrupt" }; }
}

function writeState(storeRoot, state) {
  assertOutputSafe(state);
  writeJsonAtomicReplaceUnderLock(join(paths(storeRoot).state, `${state.observation_id}.json`), state);
}

/** Observations that count: final file present, schema-valid, state settled-and-trusted. */
export function listTrustedObservations(storeRoot) {
  const p = paths(storeRoot);
  if (!existsSync(p.observations)) return [];
  const out = [];
  for (const name of readdirSync(p.observations).sort()) {
    const m = /^(ompobs_[0-9a-f]{32})\.json$/.exec(name);
    if (!m) continue; // *.tmp.* leftovers and anything else never count
    const s = readState(storeRoot, m[1]);
    if (s.kind !== "ok" || !TRUSTED.has(s.state.status)) continue;
    try {
      const o = JSON.parse(readFileSync(join(p.observations, name), "utf8"));
      if (validateObservation(o).ok) out.push(o);
    } catch { /* unreadable observation: not trusted */ }
  }
  return out;
}

export function countObservationFiles(storeRoot) {
  const p = paths(storeRoot);
  if (!existsSync(p.observations)) return 0;
  return readdirSync(p.observations).filter((n) => /^ompobs_[0-9a-f]{32}\.json$/.test(n)).length;
}

// ── the run ─────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.storeRoot      evolution store root (must already exist)
 * @param {string} o.sessionsRoot   OMP sessions root (no default — caller decides)
 * @param {string[]} o.allowRoots   explicit cwd allowlist; empty ⇒ refuse to run
 * @param {string[]} [o.denyRoots]
 * @param {boolean} [o.write=false] dry-run unless true
 * @param {number} [o.quiescenceMs]
 * @param {() => number} [o.nowMs]  injected clock
 * @param {(path: string) => "not_held"|"held"|"unknown"} [o.lsof]
 * @param {boolean} [o.synthetic]
 * @param {object} [o.env]
 * @param {(step: string, path?: string) => void} [o.fault] test seam
 */
export function runIngest({
  storeRoot, sessionsRoot, allowRoots, denyRoots = [], write = false,
  quiescenceMs = DEFAULT_QUIESCENCE_MS, nowMs = () => Date.now(), lsof = defaultLsof,
  synthetic = false, env = process.env, fault = null,
}) {
  if (!storeRoot || !sessionsRoot) throw usage("storeRoot and sessionsRoot are required");
  if (!Array.isArray(allowRoots) || allowRoots.length === 0) throw usage("cwd allowlist is empty (fail-closed)");
  if (!existsSync(storeRoot)) throw usage("store root does not exist");

  const report = {
    mode: write ? "write" : "dry-run",
    suspended: null,
    lock: write ? "pending" : "not_needed",
    counts: {},
    results: [],
  };
  const tally = (disposition, sessionId, oid, reason = null) => {
    report.counts[disposition] = (report.counts[disposition] ?? 0) + 1;
    report.results.push({ session_id: sessionId, observation_id: oid, disposition, reason });
  };

  const suspended = suspendedState({ env, storeRoot });
  report.suspended = suspended;
  if (write && suspended) {
    report.lock = "not_needed";
    report.counts.SUSPENDED = 1;
    return assertOutputSafe(report);
  }

  const p = paths(storeRoot);
  let lock = null;
  if (write) {
    assertPathComponentsNotSymlink(p.root, { allowMissingLeaf: true });
    ensureDir0700(p.root);
    try {
      lock = acquireExclusiveLock(p.lock);
      report.lock = "acquired";
    } catch (e) {
      if (e instanceof C2dHoldError && e.code === HOLD.CHECKPOINT_STALE_REVISION) {
        report.lock = "busy"; // never stolen: an operator inspects a stale lock
        report.counts.LOCK_BUSY = 1;
        return assertOutputSafe(report);
      }
      throw e;
    }
  }

  try {
    if (write) { ensureDir0700(p.observations); ensureDir0700(p.state); }
    const files = discoverSessionFiles(sessionsRoot);
    const perUuid = new Map();
    for (const f of files) {
      const u = SESSION_FILE_RE.exec(f.slice(f.lastIndexOf("/") + 1))?.[1];
      perUuid.set(u, (perUuid.get(u) ?? 0) + 1);
    }
    for (const file of files) {
      if (write) {
        const again = suspendedState({ env, storeRoot });
        if (again) { report.suspended = again; report.counts.SUSPENDED_MID_RUN = 1; break; }
      }
      processFile(file, perUuid);
    }
  } finally {
    if (lock) releaseExclusiveLock(lock);
  }
  return assertOutputSafe(report);

  function processFile(file, perUuid) {
    const base = file.slice(file.lastIndexOf("/") + 1);
    const nameUuid = SESSION_FILE_RE.exec(base)?.[1];
    if (!nameUuid) return;
    const oid = observationIdFor(nameUuid);
    const exclude = (reason) => tally("EXCLUDED", nameUuid, oid, reason);
    // One session id must map to ONE file. A copy or a resume written to a new
    // timestamped file would otherwise flip a recorded identity run after run.
    if ((perUuid.get(nameUuid) ?? 0) > 1) return exclude("duplicate_session_id");

    const obs = observeSessionFile(file, { sessionsRoot, fault });
    if (!obs.ok) return exclude(obs.reason);

    // Header gate BEFORE anything about the session is persisted.
    const head = peekHeader(obs.head);
    if (head.id !== nameUuid) return exclude("session_id_mismatch");
    const cwd = cwdDecision({ cwd: head.cwd, allowRoots, denyRoots });
    if (!cwd.ok) return exclude(cwd.reason);

    const prior = readState(storeRoot, oid);
    if (prior.kind === "corrupt") return tally("STATE_CORRUPT", nameUuid, oid, "state_unreadable");
    const nowIso = new Date(nowMs()).toISOString();
    const st = prior.kind === "ok" ? prior.state : null;

    // A session held by a process (or whose holder is unknown) is never read,
    // recorded or re-judged: this gate precedes every branch below.
    const holder = lsof(file);

    // ── already settled: only growth / rewrite matter ────────────────────────
    if (st && SETTLED.has(st.status)) {
      if (identityEquals(st.identity, obs.identity)) return tally("ALREADY_RECORDED", nameUuid, oid, st.status);
      if (holder !== "not_held") return tally("PENDING_HELD_OR_UNKNOWN", nameUuid, oid, holder);
      const full = readSessionBytes(file, { sessionsRoot, identity: obs.identity, fault });
      if (!full.ok) return exclude(full.reason);
      let status = "PREFIX_MISMATCH";
      if (st.status !== "PREFIX_MISMATCH" && full.bytes.length >= st.recorded_size
        && prefixDigest(full.bytes, st.recorded_size) === st.recorded_file_sha256) {
        status = "EXTENDED_AFTER_RECORD";
      }
      if (write) {
        writeState(storeRoot, { ...st, status, identity: obs.identity, last_seen_at: nowIso, current_size: full.bytes.length });
      }
      return tally(status, nameUuid, oid);
    }

    // ── not yet recorded ─────────────────────────────────────────────────────
    const unchanged = st !== null && identityEquals(st.identity, obs.identity);
    const base0 = {
      schema: OMP_OBSERVATION_STATE_SCHEMA,
      observation_id: oid,
      status: "SEEN",
      identity: obs.identity,
      first_seen_at: st?.first_seen_at ?? nowIso,
      last_seen_at: nowIso,
      stable_since: unchanged ? st.stable_since : nowIso,
    };
    const persistSeen = () => { if (write) writeState(storeRoot, base0); };

    if (holder !== "not_held") { persistSeen(); return tally("PENDING_HELD_OR_UNKNOWN", nameUuid, oid, holder); }
    if (st === null) { persistSeen(); return tally("PENDING_FIRST_OBSERVATION", nameUuid, oid); }
    if (!unchanged) { persistSeen(); return tally("PENDING_IDENTITY_CHANGED", nameUuid, oid); }
    const mtimeMs = Number(BigInt(obs.identity.mtime_ns) / 1_000_000n);
    if (nowMs() - Date.parse(base0.stable_since) < quiescenceMs || nowMs() - mtimeMs < quiescenceMs) {
      persistSeen(); return tally("PENDING_NOT_QUIET", nameUuid, oid);
    }

    // ── quiescent candidate: read, project, validate ─────────────────────────
    base0.status = "QUIESCENT_CANDIDATE";
    if (write) writeState(storeRoot, base0);
    const full = readSessionBytes(file, { sessionsRoot, identity: obs.identity, fault });
    if (!full.ok) return exclude(full.reason);
    const parsed = parseSessionBytes(full.bytes);
    if (!parsed.ok) return exclude(parsed.reason);
    const fileInfo = {
      file_sha256: sha256Hex(full.bytes),
      size_bytes: full.bytes.length,
      tail_sha256: obs.identity.tail_sha256,
    };
    const built = buildObservation({
      entries: parsed.entries, fileInfo, nameUuid, allowRoots, denyRoots, nowIso, synthetic,
    });
    if (!built.ok) return exclude(built.reason);
    if (!write) return tally("WOULD_RECORD", nameUuid, oid);

    return record({ oid, nameUuid, observation: built.observation, base0, fileInfo, bytes: full.bytes });
  }

  function record({ oid, nameUuid, observation, base0, fileInfo, bytes }) {
    const final = join(p.observations, `${oid}.json`);
    let reconciled = false;
    try {
      writeJsonExclusiveCreate(final, observation);
    } catch (e) {
      if (!(e instanceof C2dHoldError) || e.code !== HOLD.JOURNAL_OUT_OF_ORDER) throw e;
      // The observation already exists (a previous run died before the state
      // write, or two runs raced). Same source ⇒ reconcile; different ⇒ flag.
      let existing = null;
      try { existing = JSON.parse(readFileSync(final, "utf8")); } catch { /* corrupt */ }
      const same = existing && validateObservation(existing).ok
        && existing.source.file_sha256 === observation.source.file_sha256
        && existing.source.size_bytes === observation.source.size_bytes;
      // Crash-then-append: the observation was recorded from a shorter prefix of
      // this very file. If that prefix is intact the session only GREW.
      const grew = !same && existing && validateObservation(existing).ok
        && bytes.length >= existing.source.size_bytes
        && prefixDigest(bytes, existing.source.size_bytes) === existing.source.file_sha256;
      if (grew) {
        writeState(storeRoot, {
          ...base0, status: "EXTENDED_AFTER_RECORD",
          recorded_size: existing.source.size_bytes, recorded_file_sha256: existing.source.file_sha256,
          current_size: bytes.length,
        });
        return tally("EXTENDED_AFTER_RECORD", nameUuid, oid, "reconciled_after_crash");
      }
      if (!same) {
        writeState(storeRoot, { ...base0, status: "PREFIX_MISMATCH", recorded_size: fileInfo.size_bytes, recorded_file_sha256: fileInfo.file_sha256 });
        return tally("PREFIX_MISMATCH", nameUuid, oid, "existing_observation_differs");
      }
      reconciled = true;
    }
    if (fault) fault("after_observation_written");
    writeState(storeRoot, {
      ...base0,
      status: "RECORDED",
      recorded_size: fileInfo.size_bytes,
      recorded_file_sha256: fileInfo.file_sha256,
    });
    return tally(reconciled ? "RECONCILED" : "RECORDED", nameUuid, oid);
  }
}

function usage(msg) {
  const e = new Error(msg);
  e.code = "OMP_ATTRIBUTION_USAGE";
  return e;
}

export { OBSERVATION_ID_RE };
