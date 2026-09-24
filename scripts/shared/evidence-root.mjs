// scripts/shared/evidence-root.mjs
//
// Canonical durable-evidence routing (single source of truth).
//
// PORTABLE BY DEFAULT: the evidence root is <AUTOLOOP_HOME>/evidence/autoloop
// (see src/shared/autoloop-paths.mjs; AUTOLOOP_HOME defaults to ~/.autoloop).
// Set AUTOLOOP_EVIDENCE_ROOT to place it elsewhere.
//
// OPTIONAL VOLUME-IDENTITY GATE: deployments that require durable evidence to
// live on one specific mount (so a mis-mounted shadow volume can never silently
// absorb evidence) configure:
//
//   AUTOLOOP_EVIDENCE_MOUNT        absolute mount root the evidence root must sit under
//   AUTOLOOP_EVIDENCE_MOUNT_UUID   that mount's volume UUID
//
// With BOTH set, import enforces: the mount is present, its UUID matches, and
// no shadow mount of the same name exists alongside it. Fail-closed: any
// violation throws before evidence is written, and there is no fallback.
// Unconfigured, no mount gate runs — a plain checkout works everywhere.
//
// Importing this module is side-effecting ONLY in the sense that the
// (optional) gate runs; it never creates directories.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVIDENCE_ROOT_ENV, resolveEvidenceRoot } from "../../src/shared/autoloop-paths.mjs";

export const EVIDENCE_MOUNT_ENV = "AUTOLOOP_EVIDENCE_MOUNT";
export const EVIDENCE_MOUNT_UUID_ENV = "AUTOLOOP_EVIDENCE_MOUNT_UUID";

/** Shadow names of `name` in a /Volumes-style listing ("NVM2T 1", "data 2", …). */
export function shadowVolumeNames(names, base) {
  return names.filter((n) => n !== base && new RegExp(`^${base} \\d+$`).test(n));
}

/**
 * Enforce the configured volume-identity gate. No configuration ⇒ no gate.
 * Returns the mount that was verified, or null when the gate is disabled.
 */
export function assertEvidenceMountExact({
  env = process.env,
  volume = env[EVIDENCE_MOUNT_ENV],
  uuid = env[EVIDENCE_MOUNT_UUID_ENV],
  readdirOf = readdirSync,
  uuidOf = defaultUuidOf,
  existsOf = existsSync,
} = {}) {
  if (typeof volume !== "string" || volume.trim().length === 0) return null;
  if (typeof uuid !== "string" || uuid.trim().length === 0) {
    throw new Error(
      `FAIL / EVIDENCE_MOUNT_GATE: ${EVIDENCE_MOUNT_ENV} is set but ${EVIDENCE_MOUNT_UUID_ENV} is not; ` +
      `set both or neither (no partial gate)`,
    );
  }
  if (!existsOf(volume)) {
    throw new Error(
      `FAIL / EVIDENCE_MOUNT_GATE: ${volume} is not mounted; refusing to write durable evidence (no fallback permitted)`,
    );
  }
  const shadows = shadowVolumeNames(readdirOf(dirname(volume)), volume.split("/").filter(Boolean).pop());
  if (shadows.length > 0) {
    throw new Error(
      `FAIL / EVIDENCE_MOUNT_GATE: shadow mount rejected: ${shadows.map((n) => join(dirname(volume), n)).join(", ")}`,
    );
  }
  const actual = uuidOf(volume);
  if (actual !== uuid.trim()) {
    throw new Error(
      `FAIL / EVIDENCE_MOUNT_GATE: ${volume} is not the expected volume (UUID ${uuid.trim()} mismatch, got ${actual ?? "none"})`,
    );
  }
  return volume;
}

function defaultUuidOf(mount) {
  const r = execFileSync("/usr/sbin/diskutil", ["info", "-plist", mount], { encoding: "utf8" });
  const m = String(r).match(/<key>VolumeUUID<\/key>\s*<string>([0-9A-Fa-f-]+)<\/string>/);
  return m ? m[1] : null;
}

export const EVIDENCE_ROOT = resolveEvidenceRoot();

// The gate is enforced at import for deployments that configure it. The
// evidence root is also checked against the mount so a misconfigured pair
// (root outside the gated mount) fails closed instead of silently writing
// evidence off-volume.
const VERIFIED_MOUNT = assertEvidenceMountExact();
if (VERIFIED_MOUNT !== null && !EVIDENCE_ROOT.startsWith(VERIFIED_MOUNT)) {
  throw new Error(
    `FAIL / EVIDENCE_MOUNT_GATE: ${EVIDENCE_ROOT_ENV} (${EVIDENCE_ROOT}) is outside the gated mount ${VERIFIED_MOUNT}`,
  );
}
