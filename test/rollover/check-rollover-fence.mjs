#!/usr/bin/env node
// test/rollover/check-rollover-fence.mjs — Phase-2 BUILD-TIME self-check
// (recovery lineage: E1_SOAK_HELPER_RECOVERY_V1). Deleted after build
// validation; never part of the acceptance surface.
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const here = new URL(".", import.meta.url).pathname;
const src = await readFile(join(here, "test-e1-rollover-window-fence.mjs"), "utf8");

const IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*"\.\.\/v2\/helpers\/e1-soak-fixtures\.mjs"/s;
const m = src.match(IMPORT_RE);
if (!m) throw new Error("self-check: fixture import block not found");
const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);

const FIXTURE_SURFACE = new Set([
  "C2dHoldError", "C3B_HOLD", "HOLD", "RunEvidenceStore", "acquireLease",
  "captureResumeVerdict", "childResultFoldGate", "cleanupAttestation",
  "copyFileSync", "existsSync", "externalMutate", "fileDigest", "git",
  "isolatedHome", "join", "journalRows", "makeAdmission",
  "makeGraphStoreFixture", "makeNonTerminalRunFixture",
  "makeOpenTailC2DFixture", "makeProductionRunFixture",
  "makeTerminalPassFixture", "mkdtempSync", "readCheckpoint", "readCurrent",
  "readFileSync", "readLease", "reconcileMutationIntent", "resumeFixture",
  "rmSync", "runMutation", "runWorker", "symlinkSync", "tmpdir",
  "validateContinuity", "workerLine", "writeFileSync",
  "makeRolloverWindowFixture",
]);

const unknown = names.filter((n) => !FIXTURE_SURFACE.has(n));
if (unknown.length > 0) throw new Error(`self-check: names outside the frozen union + C21 extension: ${unknown.join(", ")}`);
console.log("fence-test import names OK:", names.join(", "));

// Byte-untouched proof for the two sealed consumers, straight from git.
for (const f of ["test/v2/test-e1-human-mutation-soak.mjs", "test/v2/test-e1-human-mutation-soak-crossproc.mjs"]) {
  const head = execFileSync("git", ["show", `HEAD:${f}`], { maxBuffer: 1 << 24 });
  const wt = await readFile(f);
  if (Buffer.compare(head, wt) !== 0) throw new Error(`self-check: sealed consumer mutated: ${f}`);
}
console.log("sealed consumers byte-identical to HEAD: OK");

// Scratch dir cleanup proof for this checker itself.
const scratch = await mkdtemp(join(tmpdir(), "e1-fence-check-"));
await rm(scratch, { recursive: true, force: true });
console.log("self-check scratch removed: OK");
