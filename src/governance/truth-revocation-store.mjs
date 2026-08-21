// src/governance/truth-revocation-store.mjs
//
// AUTOLOOP POST-P4 — DURABLE TRUTH REVOCATION LEDGER.
//
// Persistence half of the Truth Revocation Cascade（the decision half is the
// PURE src/governance/truth-revocation.mjs）. Deliberately NOT a new durable
// engine（roadmap authority: reuse Stage E patterns）:
//   - one atomic JSON file per revocation under <outDir>/truth-revocations/
//   - commit = stage（exclusive-create tmp）→ link() onto the final name →
//     unlink tmp. link() FAILS on an existing destination（unlike rename,
//     which silently replaces）: concurrent same-id writers collide loudly —
//     first wins, loser re-reads and gets idempotent-duplicate or
//     ID_CONFLICT. Different ids never interact（each writer cleans ONLY its
//     own exact tmp path）.
//   - ledger reads RE-VALIDATE every record. Any unreadable or invalid
//     entry FAILS CLOSED（ok:false）: a torn file might BE a revocation, so
//     current-authority derivation must HOLD rather than
//     proceed without it（revoked truth can never resurrect through a
//     partially-read ledger）. A MISSING ledger directory is genuinely empty.
//
// History remains immutable: appending a revocation NEVER deletes or rewrites
// any historical bundle/journal/evidence artifact.

import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scanForSecrets } from "../evidence/run-evidence-store.mjs";
import {
  TRUTH_REVOCATION_SCHEMA,
  fenceRevocationAgainstTruth,
  validateRevocationEvent,
} from "./truth-revocation.mjs";

export const TRUTH_REVOCATION_LEDGER_DIRNAME = "truth-revocations";

export const REVOCATION_STORE_HOLDS = Object.freeze({
  LEDGER_INVALID: "TRUTH_REVOCATION_LEDGER_INVALID",
  WRITE_FAILED: "TRUTH_REVOCATION_WRITE_FAILED",
  SECRET_RISK: "TRUTH_REVOCATION_SECRET_RISK",
  FENCING_REJECTED: "TRUTH_REVOCATION_FENCING_REJECTED",
  ID_CONFLICT: "TRUTH_REVOCATION_ID_CONFLICT",
});

/** Canonical ledger location for a card output directory. */
export function revocationLedgerPath(outDir) {
  return join(resolve(outDir), TRUTH_REVOCATION_LEDGER_DIRNAME);
}

function eventFileName(revocationId) {
  // Strict id charset keeps the filename a faithful, collision-free mapping;
  // anything else was already rejected by validateRevocationEvent.
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(revocationId)) return null;
  return `${revocationId}.json`;
}

/**
 * Append one revocation durably.
 * Returns { ok: true, path, duplicate? } | { ok: false, holdCode, reason }.
 * A true duplicate（same revocationId, byte-identical event）is IDEMPOTENT
 * success（TR10）. Same id with different content fails closed（ID_CONFLICT）—
 * including under concurrency: link(2) never overwrites, so no racing writer
 * can lose a revocation silently. Fencing against the known truth record
 * happens BEFORE any write.
 */
export function appendRevocation({ ledgerDir, event, truth = null }) {
  if (!ledgerDir || typeof ledgerDir !== "string") {
    return { ok: false, holdCode: REVOCATION_STORE_HOLDS.LEDGER_INVALID, reason: "ledger_dir_absent" };
  }
  const v = validateRevocationEvent(event);
  if (!v.ok) {
    return { ok: false, holdCode: REVOCATION_STORE_HOLDS.LEDGER_INVALID, reason: `malformed_revocation:${v.errors.join(",")}` };
  }
  const fencing = fenceRevocationAgainstTruth(v.event, truth);
  if (!fencing.ok) {
    return { ok: false, holdCode: REVOCATION_STORE_HOLDS.FENCING_REJECTED, reason: `${fencing.code}:${fencing.detail ?? ""}` };
  }
  const fname = eventFileName(v.event.revocationId);
  if (!fname) {
    return { ok: false, holdCode: REVOCATION_STORE_HOLDS.LEDGER_INVALID, reason: "revocation_id_unsafe_for_ledger" };
  }
  const dir = resolve(ledgerDir);
  const target = join(dir, fname);
  const text = JSON.stringify(v.event, null, 2) + "\n";
  const scan = scanForSecrets(text);
  if (!scan.safe) {
    return { ok: false, holdCode: REVOCATION_STORE_HOLDS.SECRET_RISK, reason: `secret_patterns:${scan.matches.join(",")}` };
  }
  let tmp = null;
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(target)) {
      return finishDuplicate(target, v.event.revocationId, text);
    }
    tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmp, text, { flag: "wx" });
    try {
      // link() refuses to overwrite：the atomic first-wins commit.
      linkSync(tmp, target);
    } catch (e) {
      if (e?.code === "EEXIST") {
        return finishDuplicate(target, v.event.revocationId, text);
      }
      throw e;
    }
  } catch (e) {
    // Clean up ONLY this writer's own staging file — never sweep the ledger
    // directory（other entries may be durable revocations or concurrent
    // writers' in-flight staging）.
    if (tmp) { try { unlinkSync(tmp); } catch { /* best effort */ } }
    return { ok: false, holdCode: REVOCATION_STORE_HOLDS.WRITE_FAILED, reason: `ledger_write:${String(e?.message ?? e).slice(0, 200)}` };
  }
  try { unlinkSync(tmp); } catch { /* best effort */ }
  return { ok: true, path: target };

  function finishDuplicate(path, id, expectedText) {
    let existing = null;
    try { existing = readFileSync(path, "utf8"); } catch (e) {
      return { ok: false, holdCode: REVOCATION_STORE_HOLDS.WRITE_FAILED, reason: `ledger_read:${String(e?.message ?? e).slice(0, 200)}` };
    }
    if (existing === expectedText) return { ok: true, path, duplicate: true };
    return { ok: false, holdCode: REVOCATION_STORE_HOLDS.ID_CONFLICT, reason: `revocation_id_reused_with_different_content:${id}` };
  }
}

/**
 * Read + re-validate the whole ledger. FAIL-CLOSED:
 *   - directory absent（proven ENOENT）→ { ok: true, events: [] } — genuinely
 *     no revocation recorded yet;
 *   - directory unreadable / not a directory / ANY unparseable or
 *     schema-invalid entry → { ok: false } — callers MUST HOLD: a damaged
 *     file may be a revocation whose loss would resurrect revoked truth.
 */
export function readRevocationLedger(ledgerDir) {
  const dir = ledgerDir ? resolve(ledgerDir) : null;
  if (!dir) return { ok: true, events: [], malformed: [], path: null };
  let st = null;
  try { st = statSync(dir); } catch (e) {
    if (e?.code === "ENOENT") return { ok: true, events: [], malformed: [], path: dir };
    return { ok: false, holdCode: REVOCATION_STORE_HOLDS.LEDGER_INVALID, reason: `ledger_stat:${String(e?.message ?? e).slice(0, 200)}`, events: [], malformed: [] };
  }
  if (!st.isDirectory()) {
    return { ok: false, holdCode: REVOCATION_STORE_HOLDS.LEDGER_INVALID, reason: "ledger_not_a_directory", events: [], malformed: [] };
  }
  let names = [];
  try { names = readdirSync(dir).sort(); } catch (e) {
    return { ok: false, holdCode: REVOCATION_STORE_HOLDS.LEDGER_INVALID, reason: `ledger_readdir:${String(e?.message ?? e).slice(0, 200)}`, events: [], malformed: [] };
  }
  const events = [];
  const malformed = [];
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    let raw = null;
    try { raw = JSON.parse(readFileSync(p, "utf8")); } catch (e) {
      malformed.push({ file: f, detail: `unreadable_or_unparseable:${String(e?.message ?? e).slice(0, 120)}` });
      continue;
    }
    const v = validateRevocationEvent(raw);
    if (!v.ok || v.event.schema !== TRUTH_REVOCATION_SCHEMA) {
      malformed.push({ file: f, detail: `invalid:${v.ok ? "schema" : v.errors.join(",")}` });
      continue;
    }
    events.push(v.event);
  }
  if (malformed.length > 0) {
    // Fail closed: damaged entries are indistinguishable from lost
    // revocations. Never derive CURRENT-AUTHORITY from a partial ledger.
    return { ok: false, holdCode: REVOCATION_STORE_HOLDS.LEDGER_INVALID, reason: `ledger_corrupt_entries:${malformed.map((m) => m.file).join(",").slice(0, 200)}`, events, malformed };
  }
  return { ok: true, events, malformed, path: dir };
}
