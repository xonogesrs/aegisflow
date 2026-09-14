// test/v2/helpers/e1-runtime-isolation-preload.mjs
//
// E1 SOAK — runtime isolation preload (recovery lineage).
// RECOVERY_LINEAGE: E1_SOAK_HELPER_RECOVERY_V1
// RELATION_TO_ORIGINAL: behavioral reimplementation from the frozen surface +
//   the sealed decision-1 seam (module.registerHooks resolve redirect installed
//   BEFORE the static tree links) + the e1-preload-* residue exemplars banked
//   by Phase-1. NOT a continuation of, and NOT byte-identical to, the lost
//   sealed bytes (7174825d…).
//
// Usage (the sealed suites' frozen command lines):
//   node --import ./test/v2/helpers/e1-runtime-isolation-preload.mjs --test <suite>
// The crossproc suite also imports this module statically; the guard below
// makes that double entry a no-op (one shim, one hook registration per process).
//
// NEVER mutates repository bytes: the generated shim set lives in a per-run
// mkdtemp dir under the OS temp; registration is process-local.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { writeIsolatedShim, runtimeShimHooks } from "./e1-runtime-shim.mjs";

/** Per-process idempotence guard: the crossproc enters twice (CLI + static). */
const GUARD = Symbol.for("e1.runtime.isolation.preload.installed");

function install() {
  if (globalThis[GUARD]) return globalThis[GUARD];
  const dir = mkdtempSync(join(tmpdir(), "e1-preload-"));
  const shim = writeIsolatedShim(dir);
  // Env contract consumed by the generated worker bootstrap (spawned legs).
  process.env.E1_PRELOAD_DIR = dir;
  process.env.E1_SHIM_URL = shim.shimUrl;
  // Sealed decision 1: the hook MUST be registered before the static tree
  // links src/runtime/colima-runtime.mjs — a --import preload runs exactly
  // there; the static-import double entry hits the guard above.
  registerHooks(runtimeShimHooks({ shimUrl: shim.shimUrl }));
  globalThis[GUARD] = Object.freeze({ ...shim, registeredAt: Date.now() });
  return globalThis[GUARD];
}

const installed = install();

// Process-exit hygiene: the shim dir is disposable scratch, removed when this
// process ends (the suites' own attestation covers their spawned children).
process.on("exit", () => {
  try { rmSync(installed.dir, { recursive: true, force: true }); } catch { /* temp */ }
});

export default installed;
export { installed as isolation };
