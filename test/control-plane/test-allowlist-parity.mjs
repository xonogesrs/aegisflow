// test/control-plane/test-allowlist-parity.mjs
//
// CP-2R2 — configuration-truth single-source guard (Finding 4): the
// control-plane executor model allowlist is READ from the single authoritative
// R9 transport freeze — it is not a second copy. The parity assertion here is
// documentation of that derivation, NOT a substitute for runtime single
// ownership (which lives in contract.mjs's import of TRANSPORT_FREEZE).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EXECUTOR_MODEL_ALLOWLIST } from "../../src/control-plane/contract.mjs";
import { TRANSPORT_FREEZE } from "../../src/v2/pi-transport-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("control-plane allowlist is derived from the R9 transport freeze (single source)", () => {
  assert.equal(EXECUTOR_MODEL_ALLOWLIST.length, 1);
  assert.equal(EXECUTOR_MODEL_ALLOWLIST[0].provider, TRANSPORT_FREEZE.provider);
  assert.equal(EXECUTOR_MODEL_ALLOWLIST[0].model, TRANSPORT_FREEZE.model);
  assert.deepEqual(EXECUTOR_MODEL_ALLOWLIST, [{ provider: TRANSPORT_FREEZE.provider, model: TRANSPORT_FREEZE.model }]);
});

test("CP contains no second allowlist truth (no hardcoded model literal in contract.mjs)", () => {
  const src = readFileSync(join(HERE, "..", "..", "src", "control-plane", "contract.mjs"), "utf8");
  // The authoritative model literal must live ONLY in pi-transport-adapter.mjs;
  // contract.mjs must read TRANSPORT_FREEZE, never hardcode the value again.
  assert.ok(!src.includes("deepseek-v4-flash"), "contract.mjs must not hardcode the R9 model value");
  assert.ok(src.includes("TRANSPORT_FREEZE"), "contract.mjs must import the authoritative TRANSPORT_FREEZE");
});
