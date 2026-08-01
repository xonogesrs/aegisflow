import { existsSync, readFileSync } from "node:fs";
import {
  C2dHoldError, HOLD, sha256Hex, isSha256Hex, assertNotSymlink,
} from "./fs-atomic.mjs";
import {
  readCurrent, validateSnapshotStructure, checksumPath, currentPath,
} from "./checkpoint-store.mjs";
import {
  validateContinuity, intentPath, completePath, listJournal, readIntent,
} from "./journal.mjs";
import { basename } from "node:path";

export function validateExecutionCheckpoint(execDir) {
  const cur = readCurrent(execDir);
  if (!cur) {
    return { ok: false, reason: "no CURRENT.json" };
  }
  validateSnapshotStructure(cur.snapshot);
  // directory execution id must match embedded
  const dirId = basename(execDir);
  if (dirId !== cur.snapshot.execution_id) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "directory execution_id mismatch");
  }
  const cont = validateContinuity(execDir);
  if (cur.snapshot.revision !== cont.lastComplete) {
    throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "snapshot revision != journal last complete", {
      snapshot: cur.snapshot.revision,
      lastComplete: cont.lastComplete,
    });
  }
  const revs = listJournal(execDir);
  for (const [rev, entry] of revs) {
    if (!entry.complete) continue;
    const intent = readIntent(execDir, rev);
    const complete = JSON.parse(readFileSync(completePath(execDir, rev), "utf8"));
    const dig = sha256Hex(readFileSync(intentPath(execDir, rev)));
    if (complete.intent_digest !== dig || !isSha256Hex(complete.intent_digest)) {
      throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, `intent_digest mismatch at rev ${rev}`);
    }
    const pairFields = [
      "revision", "transition_id", "execution_id", "checkpoint_id", "chain_id",
      "from_stage", "to_stage", "from_state", "to_state", "expected_revision_before",
      "side_effect_class",
    ];
    for (const f of pairFields) {
      if (complete[f] !== intent[f]) {
        throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, `pair field mismatch ${f} at rev ${rev}`);
      }
    }
    if (complete.revision !== rev) {
      throw new C2dHoldError(HOLD.JOURNAL_OUT_OF_ORDER, `payload revision mismatch at ${rev}`);
    }
  }
  if (cur.snapshot.last_completed_transition && cont.lastComplete >= 1) {
    const lastComplete = JSON.parse(readFileSync(completePath(execDir, cont.lastComplete), "utf8"));
    if (lastComplete.transition_id !== cur.snapshot.last_completed_transition) {
      throw new C2dHoldError(HOLD.CHECKPOINT_CORRUPT, "last_completed_transition mismatch");
    }
  }
  return { ok: true, snapshot: cur.snapshot, continuity: cont, digest: cur.digest };
}

export function assertNoChecksumAutoHeal(execDir) {
  if (!existsSync(currentPath(execDir))) return;
  if (!existsSync(checksumPath(execDir))) {
    throw new C2dHoldError(HOLD.SNAPSHOT_CHECKSUM_MISMATCH, "missing checksum (no auto-heal)");
  }
  assertNotSymlink(checksumPath(execDir));
  const bytes = readFileSync(currentPath(execDir));
  const expected = readFileSync(checksumPath(execDir), "utf8").trim();
  if (sha256Hex(bytes) !== expected) {
    throw new C2dHoldError(HOLD.SNAPSHOT_CHECKSUM_MISMATCH, "mismatched checksum (no auto-heal)");
  }
}
