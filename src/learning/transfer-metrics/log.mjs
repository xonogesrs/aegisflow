// src/learning/transfer-metrics/log.mjs
//
// Read + chain-validate the transfer-event JSONL. Copies CBM journal crash
// algorithm: partial trailing line excluded; corrupt middle fail-closed.
// Does not mutate the raw log.

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import {
  AUTHORITY_EVENT_TYPE,
  EVENT_TYPES,
  EVENT_TYPES_V2,
  GENESIS_DIGEST,
  LOG_SCHEMA,
  LOG_SCHEMA_V2,
  SCHEMA_VERSION,
  SCHEMA_VERSION_NUMBER,
  SCHEMA_VERSION_NUMBER_V2,
  SCHEMA_VERSION_V2,
  TRANSFER_CODES,
  TransferMetricsError,
  computeEventDigest,
  validateAuthorityRecord,
  canonical,
  isHex64,
} from "./schema.mjs";

export const LOG_FILE_NAME = "transfer-events.jsonl";
export const LOCK_FILE_NAME = "transfer-events.lock";

function fail(code, message, details) {
  throw new TransferMetricsError(code, message, details);
}

export function listLogFiles(root) {
  if (!existsSync(root)) return [];
  const names = readdirSync(root);
  const archives = [];
  for (const name of names) {
    const m = /^transfer-events-(\d+)\.jsonl$/.exec(name);
    if (m) archives.push({ seq: Number(m[1]), name });
  }
  archives.sort((a, b) => a.seq - b.seq);
  const files = archives.map((a) => join(root, a.name));
  const active = join(root, LOG_FILE_NAME);
  if (existsSync(active)) files.push(active);
  return files;
}

function parseHeader(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "log header is not valid JSON");
  }
  // Generation of a file = its header: …-log/v1 + 1 ⇒ GEN-1,
  // …-log/v2 + 2 ⇒ GEN-2. Any other header value fails closed.
  if (obj?.schema === LOG_SCHEMA && obj?.schema_version === SCHEMA_VERSION_NUMBER) return { header: obj, generation: 1 };
  if (obj?.schema === LOG_SCHEMA_V2 && obj?.schema_version === SCHEMA_VERSION_NUMBER_V2) return { header: obj, generation: 2 };
  fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "log header schema mismatch");
}

function validateDurableEvent(event, { expectedSequence, previousDigest }) {
  if (!event || typeof event !== "object") {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "event is not an object");
  }
  if (event.journal_sequence !== expectedSequence) {
    fail(
      TRANSFER_CODES.LOG_CHAIN_INVALID,
      `sequence gap/duplicate: expected ${expectedSequence}, got ${event.journal_sequence}`,
    );
  }
  if (event.previous_digest !== previousDigest) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `previous_digest mismatch at sequence ${expectedSequence}`);
  }
  const recomputed = computeEventDigest({
    journal_sequence: event.journal_sequence,
    event_id: event.event_id,
    event_type: event.event_type,
    payload_digest: event.payload_digest,
    previous_digest: event.previous_digest,
  });
  if (event.event_digest !== recomputed) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `event_digest mismatch at sequence ${expectedSequence}`);
  }
  if (!isHex64(event.event_id) || !isHex64(event.idempotency_key) || !isHex64(event.payload_digest)) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `digest fields invalid at sequence ${expectedSequence}`);
  }
  const line = canonical(event);
  if (line.includes("\n") || line.includes("\r")) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "canonical event contains raw newline");
  }
}

function readOneFile(path, { expectedSequence, previousDigest }) {
  if (!existsSync(path)) {
    return {
      events: [],
      expectedSequence,
      previousDigest,
      partialTrailingLine: false,
      lastValidOffset: 0,
      byteLength: 0,
      generation: null,
    };
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) {
    fail(TRANSFER_CODES.PATH_UNSAFE, `log target is not a regular file: ${path}`);
  }
  const raw = readFileSync(path);
  const text = raw.toString("utf8");
  const byteLength = raw.length;
  if (text.length === 0) {
    return {
      events: [],
      expectedSequence,
      previousDigest,
      partialTrailingLine: false,
      lastValidOffset: 0,
      byteLength: 0,
      generation: null,
    };
  }
  const lines = text.split("\n");
  const events = [];
  let seq = expectedSequence;
  let prev = previousDigest;
  let lastValidOffset = 0;
  let offset = 0;
  let partialTrailingLine = false;
  let sawHeader = false;
  let generation = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf8");
    const isLast = i === lines.length - 1;
    const hasTrailingNewline = !isLast || text.endsWith("\n");

    if (!sawHeader) {
      if (line.trim() === "") {
        if (isLast && !hasTrailingNewline) {
          partialTrailingLine = line.length > 0;
          break;
        }
        offset += lineBytes + (isLast ? 0 : 1);
        continue;
      }
      generation = parseHeader(line).generation;
      sawHeader = true;
      offset += lineBytes + (isLast ? 0 : 1);
      lastValidOffset = offset;
      continue;
    }

    if (line.trim() === "") {
      if (isLast && !hasTrailingNewline) break;
      offset += lineBytes + (isLast ? 0 : 1);
      lastValidOffset = offset;
      continue;
    }

    if (isLast && !hasTrailingNewline) {
      partialTrailingLine = true;
      break;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (isLast && !hasTrailingNewline) {
        partialTrailingLine = true;
        break;
      }
      fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `line ${i + 1} of ${basename(path)} is not valid JSON (corrupted middle)`);
    }

    // Per-file generation pinning: every event is validated against ITS
    // FILE's header generation; the authority event type exists only in
    // GEN-2 files. Unknown versions/types fail closed (no skip, no repair).
    if (generation === 1) {
      if (event.schema_version !== SCHEMA_VERSION) {
        fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `event schema_version mismatch at sequence ${seq}`);
      }
      if (!EVENT_TYPES.includes(event.event_type)) {
        fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `unknown event_type at sequence ${seq}`);
      }
    } else {
      if (event.schema_version !== SCHEMA_VERSION_V2) {
        fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `event schema_version mismatch at sequence ${seq}`);
      }
      if (!EVENT_TYPES_V2.includes(event.event_type)) {
        fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `unknown event_type at sequence ${seq}`);
      }
      if (event.event_type === AUTHORITY_EVENT_TYPE) {
        validateAuthorityRecord(event);
      }
    }

    if (prev === null) prev = GENESIS_DIGEST;
    validateDurableEvent(event, { expectedSequence: seq, previousDigest: prev });
    events.push(event);
    seq += 1;
    prev = event.event_digest;
    offset += lineBytes + 1;
    lastValidOffset = offset;
  }

  if (!sawHeader && events.length === 0 && byteLength > 0 && !partialTrailingLine) {
    fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "log missing header");
  }

  return {
    events,
    expectedSequence: seq,
    previousDigest: prev,
    partialTrailingLine,
    lastValidOffset,
    byteLength,
    generation,
  };
}


export function readLog(root) {
  const files = listLogFiles(root);
  const events = [];
  let expectedSequence = 1;
  let previousDigest = GENESIS_DIGEST;
  let partialTrailingLine = false;
  let lastValidOffset = 0;
  let activePath = join(root, LOG_FILE_NAME);
  let lastGeneration = null;
  let activeGeneration = null;
  const idempotencyIndex = new Map();
  const generationBySequence = new Map();
  const filesMeta = [];

  for (const file of files) {
    const isActive = basename(file) === LOG_FILE_NAME;
    const chunk = readOneFile(file, { expectedSequence, previousDigest });
    if (chunk.partialTrailingLine && !isActive) {
      fail(TRANSFER_CODES.LOG_CHAIN_INVALID, `partial trailing line in archive ${basename(file)}`);
    }
    // Root chain order: GEN-1 files may precede GEN-2 files (rotation
    // order); a GEN-1 file appearing after a GEN-2 file fails closed.
    if (chunk.generation === 1 && lastGeneration === 2) {
      fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "GEN-1 file after GEN-2 file in root chain");
    }
    if (chunk.generation != null) lastGeneration = chunk.generation;
    filesMeta.push({ path: file, generation: chunk.generation, isActive });
    for (const event of chunk.events) {
      generationBySequence.set(event.journal_sequence, chunk.generation);
      events.push(event);
      const existing = idempotencyIndex.get(event.idempotency_key);
      if (existing && existing.payload_digest !== event.payload_digest) {
        fail(TRANSFER_CODES.LOG_CHAIN_INVALID, "idempotency key collision in durable log");
      }
      if (!existing) idempotencyIndex.set(event.idempotency_key, event);
    }
    expectedSequence = chunk.expectedSequence;
    previousDigest = chunk.previousDigest ?? previousDigest;
    if (isActive) {
      partialTrailingLine = chunk.partialTrailingLine;
      lastValidOffset = chunk.lastValidOffset;
      activePath = file;
      activeGeneration = chunk.generation;
    }
  }

  return {
    events,
    state: {
      lastSequence: events.length === 0 ? 0 : events[events.length - 1].journal_sequence,
      previousDigest: events.length === 0 ? GENESIS_DIGEST : events[events.length - 1].event_digest,
    },
    partialTrailingLine,
    lastValidOffset,
    activePath,
    idempotencyIndex,
    generationBySequence,
    files: filesMeta,
    activeGeneration,
    path: activePath,
  };
}

export function lastCompleteEvent(root) {
  const log = readLog(root);
  return {
    event: log.events.length ? log.events[log.events.length - 1] : null,
    partialTrailingLine: log.partialTrailingLine,
    lastValidOffset: log.lastValidOffset,
    state: log.state,
  };
}

/**
 * Generation of the ACTIVE log file header (or 2 when no active file exists:
 * first creation always stamps the current generation, GEN-2). Used by the
 * writer to stamp measurement events from the active file header generation
 * [A63] and to gate authority mutations on legacy roots.
 */
export function readActiveLogGeneration(root) {
  const active = join(root, LOG_FILE_NAME);
  if (!existsSync(active)) return 2;
  const st = lstatSync(active);
  if (st.isSymbolicLink() || !st.isFile()) {
    fail(TRANSFER_CODES.PATH_UNSAFE, `log target is not a regular file: ${active}`);
  }
  if (st.size === 0) return 2;
  const raw = readFileSync(active);
  const nl = raw.indexOf(10);
  const headerLine = (nl === -1 ? raw : raw.subarray(0, nl)).toString("utf8");
  return parseHeader(headerLine).generation;
}
