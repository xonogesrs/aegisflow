// test/admission/test-rb-ssg-vendor-integrity.mjs
//
// RB-SSG3 (Phase C) — the installed extension must be self-contained: the
// bundled ./vendor copies of the governor and the admission bridge must be
// BYTE-IDENTICAL to the authoritative AutoLoop source, so the runtime artifact
// never silently diverges from the source-of-record (no two competing
// implementations).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PAIRS = [
  ["src/admission/search-scope-governor.mjs", "pi-extensions/search-scope-governor/vendor/search-scope-governor.mjs"],
  ["src/admission/pi-command-admission.mjs", "pi-extensions/search-scope-governor/vendor/pi-command-admission.mjs"],
];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

for (const [sourceRel, vendorRel] of PAIRS) {
  test(`vendor copy is byte-identical to authoritative source: ${sourceRel}`, () => {
    const source = readFileSync(join(repoRoot, sourceRel));
    const vendor = readFileSync(join(repoRoot, vendorRel));
    assert.equal(sha256(vendor), sha256(source), `${vendorRel} diverged from ${sourceRel}`);
  });
}

test("vendored admission bridge exports a governPiCommand function", async () => {
  const mod = await import(`file://${join(repoRoot, "pi-extensions/search-scope-governor/vendor/pi-command-admission.mjs")}`);
  assert.equal(typeof mod.governPiCommand, "function");
});
