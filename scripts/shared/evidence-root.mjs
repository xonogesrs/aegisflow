// Canonical durable-evidence routing (Migration Step 3).
// Single source of truth for the AutoLoop evidence root. Importing this module
// enforces the NVM2T mount gate: exact volume, exact UUID, no shadow mounts.
// Fail-closed: any violation throws before evidence is written. No fallbacks.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

export const CANONICAL_VOLUME = "/Volumes/NVM2T";
const CANONICAL_VOLUME_UUID = "971A7EA8-5108-4B8E-B9A8-5141F0C04A8A";

export function shadowVolumeNames(names) {
  return names.filter((n) => n !== "NVM2T" && /^NVM2T( \d+)?$/.test(n));
}

export function assertNvm2tExactMount(volume = CANONICAL_VOLUME) {
  if (!existsSync(volume)) {
    throw new Error(
      `FAIL / NVM2T_MOUNT_GATE: ${volume} is not mounted; refusing to write durable evidence (no fallback permitted)`,
    );
  }
  const shadows = shadowVolumeNames(readdirSync(dirname(volume)));
  if (shadows.length > 0) {
    throw new Error(
      `FAIL / NVM2T_MOUNT_GATE: shadow mount rejected: ${shadows.map((n) => `/Volumes/${n}`).join(", ")}`,
    );
  }
  const info = execFileSync("diskutil", ["info", "-plist", volume], { encoding: "utf8" });
  if (!info.includes(CANONICAL_VOLUME_UUID)) {
    throw new Error(
      `FAIL / NVM2T_MOUNT_GATE: ${volume} is not the canonical NVM2T volume (UUID ${CANONICAL_VOLUME_UUID} mismatch)`,
    );
  }
}

assertNvm2tExactMount();

export const EVIDENCE_ROOT = "/Volumes/NVM2T/Development/evidence/autoloop";
