// src/evolution/kill-switch.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1 — Section H: the
// operational kill switch.
//
//   AUTO_EVOLUTION = ENABLED | SUSPENDED
//
// SUSPENDED must (card §H):
//   - prevent NEW evolution cycles (the trigger gate returns empty; the loop
//     entry refuses before the trigger stage),
//   - NOT affect NORMAL_OPERATION (nothing in the run path consults this
//     except the post-result observer, which then observes nothing),
//   - NOT damage existing telemetry (no telemetry file is touched),
//   - NOT cancel normal graph execution (the observer runs post-result),
//   - require NO source modification (a durable marker file or one env var).
//
// Default after production activation: ENABLED (no marker exists).
// The marker lives INSIDE the evolution store root (operator-writable,
// outside the repo worktree), so suspension is a one-file operator action:
//
//   node scripts/evolution-kill-switch.mjs --suspend  [--reason "..."]
//   node scripts/evolution-kill-switch.mjs --resume
//   node scripts/evolution-kill-switch.mjs --status
//
// Precedence: env AUTO_EVOLUTION=SUSPENDED > durable marker > ENABLED.
// The circuit breaker (Section K) is a separate, automatic suspension of
// the SAME effect; the kill switch is the explicit operator surface.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { assertNotSymlink } from "../c2d/fs-atomic.mjs";

export const EVOLUTION_SUSPENSION_SCHEMA = "autoloop.evolution-suspension/v1";

export function evolutionSuspensionPath(storeRoot) {
  return join(storeRoot, "evolution-suspended.json");
}

/** Read the durable suspension marker; absent/corrupt → null (not suspended). */
export function readEvolutionSuspension(storeRoot) {
  const p = evolutionSuspensionPath(storeRoot);
  if (!existsSync(p)) return null;
  try {
    assertNotSymlink(p);
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (raw?.schema !== EVOLUTION_SUSPENSION_SCHEMA) return null;
    return raw;
  } catch { return null; }
}

/** Suspend: write the durable marker atomically. Idempotent (overwrites). */
export function suspendEvolution(storeRoot, { reason = "operator suspension", at = new Date().toISOString() } = {}) {
  mkdirSync(storeRoot, { recursive: true });
  const p = evolutionSuspensionPath(storeRoot);
  const record = {
    schema: EVOLUTION_SUSPENSION_SCHEMA,
    version: 1,
    suspended: true,
    reason: String(reason).slice(0, 200),
    suspended_at: at,
  };
  const tmp = `${p}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
  return record;
}

/** Resume: remove the marker. Idempotent (absent → already enabled). */
export function resumeEvolution(storeRoot) {
  const p = evolutionSuspensionPath(storeRoot);
  if (!existsSync(p)) return { resumed: true, already_enabled: true };
  assertNotSymlink(p);
  unlinkSync(p);
  return { resumed: true, already_enabled: false };
}
