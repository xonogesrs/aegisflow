// src/telemetry/store.mjs
//
// COST-1 — local telemetry event store（autoloop.telemetry-store/v1）.
//
// Deterministic, local-only, bounded, explicitly-lifecycled JSONL store:
//   <stateRoot>/telemetry.jsonl        active event stream（header + events）
//   <stateRoot>/telemetry-<seq>.jsonl  rotated archive chunks（bounded growth;
//                                      explicit lifecycle, never silent loss）
//
// Fail-closed semantics（card stage 4）:
//   - missing/corrupt header or malformed line on open  -> TELEMETRY_STORE_INVALID
//   - append failure / secret scan hit / invalid event  -> TELEMETRY_STORE_INVALID
//     or TELEMETRY_UNAVAILABLE（caller decides; the graph NEVER fails on it）
//
// Every event is validated（contract allowlist）+ secret-scanned before write
// and re-validated on read. No cloud dependency, no external service.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson, TELEMETRY_STORE_SCHEMA, TELEMETRY_STORE_SCHEMA_VERSION, TELEMETRY_HOLD_CODES, validateTelemetryEventV1 } from "./contract.mjs";
import { scanTelemetryEvent } from "./security.mjs";

export const DEFAULT_MAX_EVENTS = 10000;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB active-file cap

export class TelemetryStoreError extends Error {
  constructor(code, reason) {
    super(`telemetry_store: ${code}: ${reason}`);
    this.name = "TelemetryStoreError";
    this.code = code;
    this.reason = reason;
  }
}

export class TelemetryStore {
  constructor({ stateRoot, maxEvents = DEFAULT_MAX_EVENTS, maxBytes = DEFAULT_MAX_BYTES, log = null } = {}) {
    if (!stateRoot) throw new TelemetryStoreError(TELEMETRY_HOLD_CODES.STORE_INVALID, "stateRoot_required");
    this.stateRoot = stateRoot;
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.log = log ?? null;
    this.activePath = join(stateRoot, "telemetry.jsonl");
    this.open_ = false;
    this.eventCount = 0;
    this.activeBytes = 0;
    this.rotated = 0;
  }

  get status() {
    return this.open_ ? "AVAILABLE" : "UNAVAILABLE";
  }

  /** Open the store: validate header + every existing line（fail-closed）. */
  open() {
    if (this.open_) return { ok: true, status: this.status };
    mkdirSync(this.stateRoot, { recursive: true });
    if (!existsSync(this.activePath)) {
      writeFileSync(this.activePath, this.#headerLine(), "utf8");
    }
    const raw = readFileSync(this.activePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      writeFileSync(this.activePath, this.#headerLine(), "utf8");
    } else {
      const header = lines[0];
      let h = null;
      try { h = JSON.parse(header); } catch { /* fall through */ }
      if (!h || h.schema !== TELEMETRY_STORE_SCHEMA || h.schemaVersion !== TELEMETRY_STORE_SCHEMA_VERSION) {
        throw new TelemetryStoreError(TELEMETRY_HOLD_CODES.STORE_INVALID, "header_missing_or_corrupt");
      }
      // re-validate every recorded event（corruption / tampering never
      // silently served — the store fails closed instead）
      let count = 0;
      for (let i = 1; i < lines.length; i++) {
        let ev = null;
        try { ev = JSON.parse(lines[i]); } catch { throw new TelemetryStoreError(TELEMETRY_HOLD_CODES.STORE_INVALID, `line_${i + 1}_unparseable`); }
        const v = validateTelemetryEventV1(ev);
        if (!v.valid) throw new TelemetryStoreError(TELEMETRY_HOLD_CODES.STORE_INVALID, `line_${i + 1}_invalid:${v.errors.slice(0, 3).join(";")}`);
        const scan = scanTelemetryEvent(lines[i]);
        if (!scan.safe) throw new TelemetryStoreError(TELEMETRY_HOLD_CODES.SECRET_DETECTED, `line_${i + 1}_secret:${scan.matches.join(",")}`);
        count++;
      }
      this.eventCount = count;
    }
    // Byte accounting is tracked incrementally (below) so append() never has
    // to re-read the whole active file: the previous implementation read the
    // entire chunk on every append, which made a bounded benchmark O(n²) in
    // I/O and made its latency threshold depend on which volume the state root
    // happened to sit on.
    this.activeBytes = Buffer.byteLength(readFileSync(this.activePath, "utf8"), "utf8");
    this.open_ = true;
    return { ok: true, status: this.status };
  }

  #headerLine() {
    return canonicalJson({ schema: TELEMETRY_STORE_SCHEMA, schemaVersion: TELEMETRY_STORE_SCHEMA_VERSION, createdAt: null }) + "\n";
  }

  /**
   * Append one validated event（bounded; fail-closed）. Returns
   * { ok, status, event } or throws TelemetryStoreError.
   */
  append(event) {
    if (!this.open_) throw new TelemetryStoreError(TELEMETRY_HOLD_CODES.UNAVAILABLE, "store_not_open");
    const v = validateTelemetryEventV1(event);
    if (!v.valid) throw new TelemetryStoreError(TELEMETRY_HOLD_CODES.EVENT_INVALID, v.errors.join(";"));
    const ev = v.event;
    const line = canonicalJson(ev) + "\n";
    const scan = scanTelemetryEvent(line);
    if (!scan.safe) throw new TelemetryStoreError(TELEMETRY_HOLD_CODES.SECRET_DETECTED, scan.matches.join(","));
    // bounded growth: rotate BEFORE append when the active file is at cap.
    // Size accounting is O(1): the active chunk's byte length is tracked
    // incrementally and reset on rotation.
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.eventCount >= this.maxEvents || this.activeBytes + lineBytes >= this.maxBytes) {
      this.#rotate();
    }
    writeFileSync(this.activePath, line, { flag: "a" });
    this.activeBytes += lineBytes;
    this.eventCount++;
    return { ok: true, status: this.status, event: ev };
  }

  /** Bounded-growth rotation: archive the active file, start a fresh one. */
  #rotate() {
    const seq = this.rotated + 1;
    const dest = join(this.stateRoot, `telemetry-${seq}.jsonl`);
    renameSync(this.activePath, dest);
    const header = this.#headerLine();
    writeFileSync(this.activePath, header, "utf8");
    this.rotated = seq;
    this.eventCount = 0;
    this.activeBytes = Buffer.byteLength(header, "utf8");
    if (this.log) this.log(`telemetry: rotated active file -> ${dest}`);
  }

  /** Read all events across active + rotated chunks in order. */
  readAll() {
    if (!this.open_) throw new TelemetryStoreError(TELEMETRY_HOLD_CODES.UNAVAILABLE, "store_not_open");
    const files = readdirSync(this.stateRoot).filter((f) => f.startsWith("telemetry-") && f.endsWith(".jsonl")).sort();
    const out = [];
    for (const f of files) {
      const lines = readFileSync(join(this.stateRoot, f), "utf8").split("\n").filter((l) => l.trim().length > 0);
      for (let i = 1; i < lines.length; i++) out.push(JSON.parse(lines[i]));
    }
    const active = readFileSync(this.activePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    for (let i = 1; i < active.length; i++) out.push(JSON.parse(active[i]));
    return out;
  }

  /** Serialized bytes currently held（bounded-growth accounting）. */
  byteCount() {
    let total = 0;
    if (!existsSync(this.stateRoot)) return 0;
    for (const f of readdirSync(this.stateRoot)) {
      if (!f.startsWith("telemetry") || !f.endsWith(".jsonl")) continue;
      total += readFileSync(join(this.stateRoot, f), "utf8").length;
    }
    return total;
  }

  close() {
    this.open_ = false;
    return { ok: true };
  }

  /** Store-level sha256 over the canonical event stream（deterministic identity）. */
  streamDigest() {
    const events = this.readAll();
    const h = createHash("sha256");
    for (const ev of events) h.update(canonicalJson(ev) + "\n");
    return h.digest("hex");
  }
}
