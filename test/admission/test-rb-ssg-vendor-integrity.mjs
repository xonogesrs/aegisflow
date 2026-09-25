// test/admission/test-rb-ssg-vendor-integrity.mjs
//
// The bundled extension must be self-contained: the vendored copies of the
// governor and the command-admission bridge must be BYTE-IDENTICAL to the
// authoritative AutoLoop source, so the runtime artifact can never silently
// diverge into a second competing implementation.
//
// Two DISTINCT properties are checked here:
//
//   1. REPO INVARIANT (always checked): repo vendor copy == repo source.
//      This is a property of this repository and must hold in every checkout.
//
//   2. DEPLOYMENT CHECK (opt-in): the copy INSTALLED into an agent runtime
//      also matches the source-of-record. That depends on a machine-local
//      installation outside this repository, so it cannot be a repo invariant:
//      a fresh clone has no extension installed, and failing the suite for that
//      would be reporting an environment fact as a code defect.
//
//      Set AEGISFLOW_PI_EXTENSION_DIR to the installed extension directory to
//      enable it. It is strictly opt-in: a repo suite must not depend on
//      whether this machine happens to have an extension installed. A
//      configured-but-diverged or incomplete installation FAILS — never skipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Where the extension is installed for an agent runtime.
 *
 * STRICTLY OPT-IN: only AEGISFLOW_PI_EXTENSION_DIR enables the deployment
 * check. Autodetecting a conventional install location would make this
 * repository's suite depend on machine-local state — an operator who happens
 * to have a stale extension installed would get a red `npm test` for something
 * that is not a defect in this checkout. Set the variable to verify a real
 * deployment; leaving it unset means the deployment check is skipped with an
 * explicit reason.
 */
export function installedExtensionDir({ env = process.env } = {}) {
  const configured = env.AEGISFLOW_PI_EXTENSION_DIR;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }
  return null;
}

const PAIRS = [
  ["src/admission/search-scope-governor.mjs", "pi-extensions/search-scope-governor/vendor/search-scope-governor.mjs"],
  ["src/admission/pi-command-admission.mjs", "pi-extensions/search-scope-governor/vendor/pi-command-admission.mjs"],
];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ── 1. REPO INVARIANT ───────────────────────────────────────────────────────
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

// ── 2. DEPLOYMENT CHECK (skipped when no installation is present) ───────────
const extensionDir = installedExtensionDir();
const installedVendor = extensionDir === null ? null : join(extensionDir, "vendor");

for (const [sourceRel, _vendorRel] of PAIRS) {
  const base = sourceRel.split("/").pop();
  test(`installed runtime copy matches authoritative source: ${base}`, (t) => {
    if (installedVendor === null) {
      t.skip("deployment check disabled: set AEGISFLOW_PI_EXTENSION_DIR to the installed extension directory to verify it");
      return;
    }
    const installedPath = join(installedVendor, base);
    if (!existsSync(installedPath)) {
      // Configured but incomplete: that IS a defect in the deployment, so it
      // fails rather than skipping.
      assert.fail(`AEGISFLOW_PI_EXTENSION_DIR is set but ${installedPath} is missing`);
    }
    const source = readFileSync(join(repoRoot, sourceRel));
    const installed = readFileSync(installedPath);
    assert.equal(
      sha256(installed), sha256(source),
      `${installedPath} diverged from ${sourceRel} — redeploy the extension so the runtime copy does not drift from the source-of-record`,
    );
  });
}
