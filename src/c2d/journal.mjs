import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  C2dHoldError, HOLD, ensureDir0700, listDirSafe, sha256Hex, isSha256Hex,
  fireHook, assertNotSymlink, writeJsonExclusiveCreate,
} from "./fs-atomic.mjs";
import { assertWritePermit } from "./permit.mjs";

export function journalDir(execDir) {
  return join(execDir, "journal");
}

export function padRevision(rev) {
  if (!Number.isInteger(rev) || rev < 1 || rev > Number.MAX_SAFE_INTEGER) {
    throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, `unsafe revision: ${rev}`);
  }
  return String(rev).padStart(12, "0");
}

export function intentPath(execDir, rev) {
  return join(journalDir(execDir), `${padRevision(rev)}.intent.json`);
}

export function completePath(execDir, rev) {
  return join(journalDir(execDir), `${padRevision(rev)}.complete.json`);
}

export function listJournal(execDir) {
  const dir = journalDir(execDir);
  const names = listDirSafe(dir).filter((n) => !n.includes(".tmp."));
  const revs = new Map();
  for (const n of names) {
    if (!/^\d{12}\.(intent|complete)\.json$/.test(n)) {
      throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, `noncanonical journal name: ${n}`);
    }
    const m = n.match(/^(\d{12})\.(intent|complete)\.json$/);
    const rev = parseInt(m[1], 10);
    if (String(rev).padStart(12, "0") !== m[1]) {
      throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, `noncanonical padding: ${n}`);
    }
    const kind = m[2];
    if (!revs.has(rev)) revs.set(rev, {});
    if (revs.get(rev)[kind]) {
      throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, `duplicate journal entry: ${n}`);
    }
    revs.get(rev)[kind] = n;
  }
  return revs;
}

export function validateContinuity(execDir) {
  const revs = listJournal(execDir);
  const keys = [...revs.keys()].sort((a, b) => a - b);
  if (keys.length === 0) return { lastComplete: 0, incompleteTail: null };
  if (keys[0] !== 1) {
    throw new C2dHoldError(HOLD.JOURNAL_GAP, `first revision must be 1, got ${keys[0]}`);
  }
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] !== keys[i - 1] + 1) {
      throw new C2dHoldError(HOLD.JOURNAL_GAP, `journal gap at ${keys[i]}`);
    }
  }
  for (let i = 0; i < keys.length; i++) {
    const r = keys[i];
    const entry = revs.get(r);
    if (!entry.intent) {
      throw new C2dHoldError(HOLD.UNEXPECTED_COMPLETION_WITHOUT_INTENT, `complete without intent at ${r}`);
    }
    if (!entry.complete && i !== keys.length - 1) {
      throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, `incomplete non-tail revision ${r}`);
    }
  }
  const last = keys[keys.length - 1];
  const lastEntry = revs.get(last);
  if (lastEntry.complete) return { lastComplete: last, incompleteTail: null };
  const lastComplete = keys.filter((r) => revs.get(r).complete).pop() || 0;
  return { lastComplete, incompleteTail: last };
}

export function publishIntent(execDir, record, permit) {
  assertWritePermit(execDir, permit);
  ensureDir0700(journalDir(execDir));
  const rev = record.revision;
  if (!Number.isInteger(rev) || rev < 1) {
    throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, `invalid intent revision ${rev}`);
  }
  if (record.record_kind !== "intent") {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "record_kind must be intent");
  }
  if (record.execution_id !== permit.execution_id ||
      record.checkpoint_id !== permit.checkpoint_id ||
      record.chain_id !== permit.chain_id) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REQUIRED, "intent identity does not match permit");
  }
  const path = intentPath(execDir, rev);
  fireHook("before_intent_create");
  let published;
  try {
    published = writeJsonExclusiveCreate(path, record, {
      hookBeforeCreate: "before_intent_temp_write",
      hookAfterCreate: "after_intent_create",
    });
  } catch (e) {
    if (e instanceof C2dHoldError && e.code === HOLD.JOURNAL_OUT_OF_ORDER) {
      throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, `duplicate intent revision ${rev}`);
    }
    throw e;
  }
  fireHook("after_intent_rename"); // name retained for tests: after exclusive create
  return {
    path,
    bytes: published.bytes,
    digest: sha256Hex(published.bytes),
    durability_capability: published.durability_capability,
    durability_reason: published.reason,
  };
}

export function publishComplete(execDir, record, intentDigest, permit) {
  assertWritePermit(execDir, permit);
  const rev = record.revision;
  const iPath = intentPath(execDir, rev);
  const cPath = completePath(execDir, rev);
  if (!existsSync(iPath)) {
    throw new C2dHoldError(HOLD.UNEXPECTED_COMPLETION_WITHOUT_INTENT, `no intent for ${rev}`);
  }
  const intent = JSON.parse(readFileSync(iPath, "utf8"));
  const actualIntentDigest = sha256Hex(readFileSync(iPath));
  if (intentDigest && intentDigest !== actualIntentDigest) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "intent_digest mismatch with published intent");
  }
  const pairFields = [
    "revision", "transition_id", "execution_id", "checkpoint_id", "chain_id",
    "from_stage", "to_stage", "from_state", "to_state", "expected_revision_before",
    "side_effect_class",
  ];
  for (const f of pairFields) {
    if (record[f] !== intent[f]) {
      throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, `pair field mismatch: ${f}`);
    }
  }
  if (record.execution_id !== permit.execution_id) {
    throw new C2dHoldError(HOLD.WRITE_PERMIT_REQUIRED, "complete identity does not match permit");
  }
  const full = {
    ...record,
    record_kind: "verified_complete",
    intent_digest: actualIntentDigest,
  };
  if (!isSha256Hex(full.intent_digest)) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "intent_digest not sha256 hex");
  }
  fireHook("before_complete_create");
  let published;
  try {
    published = writeJsonExclusiveCreate(cPath, full, {
      hookBeforeCreate: "before_complete_temp_write",
      hookAfterCreate: "after_complete_create",
    });
  } catch (e) {
    if (e instanceof C2dHoldError && e.code === HOLD.JOURNAL_OUT_OF_ORDER) {
      throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, `duplicate complete revision ${rev}`);
    }
    throw e;
  }
  fireHook("after_complete_rename");
  return {
    path: cPath,
    bytes: published.bytes,
    digest: sha256Hex(published.bytes),
    intent_digest: actualIntentDigest,
    durability_capability: published.durability_capability,
  };
}

export function readIntent(execDir, rev) {
  const p = intentPath(execDir, rev);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  return JSON.parse(readFileSync(p, "utf8"));
}

export function readComplete(execDir, rev) {
  const p = completePath(execDir, rev);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  return JSON.parse(readFileSync(p, "utf8"));
}
