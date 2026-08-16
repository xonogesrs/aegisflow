// src/memory/jsonl-journal.mjs
//
// CBM-2 — Memory Contract v1: append-only JSONL journal + hash chain.
//
//   eventDigest =
//     sha256(recursiveCanonical({
//       journalSequence, eventId, recordId, operation,
//       payloadDigest, previousDigest
//     }))
//   first event uses the FIXED genesis digest（module constant）.
//
// Guarantees（all tested）:
//   - append-only; each append fsyncs before returning
//   - partial trailing line（crash during append）is DETECTED and excluded
//   - corrupted middle line -> fail-closed JOURNAL_CHAIN_INVALID
//   - duplicate sequence -> rejected; sequence gap -> rejected（or flagged）
//   - SQLite can be rebuilt from a valid journal（replay is pure local
//     mutations — no external side effects）
//   - nothing is appended unless the payload passes the secret scan

import { existsSync, openSync, writeSync, fsyncSync, closeSync, readFileSync } from "node:fs";
import { recursiveCanonicalJson, utcNowIso } from "./canonical.mjs";
import { MEMORY_JOURNAL_EVENT_SCHEMA } from "./contract.mjs";
import { MEMORY_ERRORS, validateJournalEvent, JOURNAL_OPERATIONS, scanFreeTextFields } from "./validation.mjs";
import { upsertRecord, applyLifecycleEvent, insertRelationship, recordConflictGroup } from "./sqlite-schema.mjs";
import { sha256Text, scanForSecrets } from "../evidence/run-evidence-store.mjs";
import { deriveEventId } from "./identity.mjs";

export const JOURNAL_GENESIS_DIGEST = sha256Text("autoloop.memory-journal/genesis/v1");
export const JOURNAL_LINE_ENCODING = "utf8";

export class JournalError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "JournalError";
    this.code = code;
  }
}

function canonical(text) {
  return recursiveCanonicalJson(text);
}

/** Append one line with an fsync before returning（durability contract）. */
export function appendLineFsync(path, line) {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line + "\n", null, JOURNAL_LINE_ENCODING);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Append a journal event. `state` = { lastSequence, previousDigest }（0/"" for
 * an empty journal）. Fails closed（SECRET_DETECTED）before anything touches
 * disk when the payload matches a secret pattern.
 */
export function appendJournalEvent({ journalPath, state = { lastSequence: 0, previousDigest: null }, operation, recordId, payload, timestamp = utcNowIso() }) {
  if (!JOURNAL_OPERATIONS.includes(operation)) {
    throw new JournalError(MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, `unknown operation ${String(operation)}`);
  }
  const scan = scanFreeTextFields(payload ?? {});
  if (!scan.safe) {
    throw new JournalError(MEMORY_ERRORS.SECRET_DETECTED, `journal payload: ${scan.matches.join(",")}`);
  }
  const journalSequence = state.lastSequence + 1;
  const previousDigest = state.previousDigest ?? JOURNAL_GENESIS_DIGEST;
  const eventId = deriveEventId("jrnl", journalSequence, operation, recordId);
  const payloadDigest = sha256Text(canonical(payload));
  const chainPayload = { journalSequence, eventId, recordId, operation, payloadDigest, previousDigest };
  const eventDigest = sha256Text(canonical(chainPayload));
  const event = {
    schema: MEMORY_JOURNAL_EVENT_SCHEMA,
    journalSequence,
    eventId,
    recordId,
    operation,
    payload,
    payloadDigest,
    previousDigest,
    eventDigest,
    timestamp,
  };
  appendLineFsync(journalPath, JSON.stringify(event));
  return {
    event,
    state: { lastSequence: journalSequence, previousDigest: eventDigest },
  };
}

/**
 * Read + chain-validate a journal. A partial TRAILING line（crash mid-append）
 * is detected and excluded（reported, not fatal）; a corrupted MIDDLE line is
 * fail-closed（JOURNAL_CHAIN_INVALID）. Duplicate sequences / gaps are fatal.
 */
export function readJournal(journalPath) {
  if (!existsSync(journalPath)) return { events: [], state: { lastSequence: 0, previousDigest: null }, partialTrailingLine: false, path: journalPath };
  const raw = readFileSync(journalPath, "utf8");
  const lines = raw.split("\n");
  const events = [];
  let partialTrailingLine = false;
  let expectedSequence = 1;
  let previousDigest = null;
  let lastEventDigest = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // last line only may be a partial write（crash during append）
      if (i === lines.length - 1 && line.trim().length > 0) {
        partialTrailingLine = true;
        continue;
      }
      throw new JournalError(MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, `line ${i + 1} is not valid JSON (corrupted middle line)`);
    }
    if (previousDigest === null) previousDigest = JOURNAL_GENESIS_DIGEST;
    const v = validateJournalEvent(event, { previousDigest, expectedSequence });
    if (!v.valid) {
      const dup = event.journalSequence < expectedSequence;
      throw new JournalError(MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, `line ${i + 1}: ${v.errors.join(";")}${dup ? " (duplicate sequence)" : ""}`);
    }
    events.push(event);
    expectedSequence += 1;
    lastEventDigest = event.eventDigest;
    previousDigest = event.eventDigest;
  }
  return {
    events,
    state: { lastSequence: events.length, previousDigest: lastEventDigest ?? null },
    partialTrailingLine,
    path: journalPath,
  };
}

/** Reject a journal with an explicit duplicate/gap check（readJournal does this inline）. */
export function assertChainIntegrity(journalPath) {
  const r = readJournal(journalPath);
  const seqs = r.events.map((e) => e.journalSequence);
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i + 1) {
      throw new JournalError(MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, `sequence gap at index ${i}: expected ${i + 1}, got ${seqs[i]}`);
    }
  }
  return r;
}

/**
 * Replay a journal into a store context（db + helpers）. Replay is PURE local
 * mutation — it never triggers external side effects（no agents, no network,
 * no git writes）. Idempotent for duplicate recordIds（upsert semantics）.
 */
export function replayJournal({ db, journalPath, recordValidator = null, authorizedDirs = [] } = {}) {
  const { events, partialTrailingLine } = readJournal(journalPath);
  const applied = [];
  for (const ev of events) {
    const payload = ev.payload ?? {};
    switch (ev.operation) {
      case "UPSERT_RECORD": {
        const rec = payload.record;
        if (recordValidator) {
          const v = recordValidator(rec, { authorizedDirs });
          if (!v.valid) throw new JournalError(MEMORY_ERRORS.SCHEMA_INVALID, `replay upsert invalid: ${v.errors.join(";")}`);
        }
        upsertRecord(db, rec);
        applied.push({ sequence: ev.journalSequence, operation: ev.operation, recordId: rec.recordId });
        break;
      }
      case "LIFECYCLE_EVENT": {
        applyLifecycleEvent(db, payload.event);
        applied.push({ sequence: ev.journalSequence, operation: ev.operation, recordId: payload.event?.recordId });
        break;
      }
      case "RELATIONSHIP": {
        insertRelationship(db, payload.relationship);
        applied.push({ sequence: ev.journalSequence, operation: ev.operation, recordId: payload.relationship?.recordId });
        break;
      }
      case "CONFLICT": {
        recordConflictGroup(db, payload.conflict);
        applied.push({ sequence: ev.journalSequence, operation: ev.operation, recordId: payload.conflict?.recordId });
        break;
      }
      case "MIGRATION": {
        applied.push({ sequence: ev.journalSequence, operation: ev.operation, recordId: null }); // schema already applied
        break;
      }
      default:
        throw new JournalError(MEMORY_ERRORS.JOURNAL_CHAIN_INVALID, `unknown replay operation ${String(ev.operation)}`);
    }
  }
  return { applied, count: applied.length, partialTrailingLine };
}

export { validateJournalEvent, MEMORY_JOURNAL_EVENT_SCHEMA };
