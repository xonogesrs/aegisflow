// test/governance/test-verification-scope-guard.mjs
//
// VCA-1 Phase 0 — negative tests for VCA1-F1 (UNBOUNDED_VERIFICATION_SCOPE).
// Subset of the VCA-1 card's required negative tests that are in scope for
// the bootstrap guard itself (NEG1, NEG2, NEG3, NEG8, NEG9, NEG10). The
// remaining NEG cases (fast-path/regression-tier/evidence-reuse) belong to
// later VCA-1 phases, not this bootstrap.
//
// Run: node --test test/governance/test-verification-scope-guard.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkVerificationRoot,
  assertVerificationRoot,
  defaultAuthorizedRoots,
  VERIFICATION_SCOPE_HOLDS,
} from "../../src/governance/verification-scope-guard.mjs";

const REPO = "/Volumes/NVM2T/Development/repos/autoloop";

test("NEG1: recursive scan of /Users/zhengfengqing is rejected before traversal", () => {
  const result = checkVerificationRoot("/Users/zhengfengqing");
  assert.equal(result.ok, false);
  assert.equal(result.hold, VERIFICATION_SCOPE_HOLDS.UNBOUNDED);
});

test("NEG2: recursive scan of $HOME is rejected", () => {
  const result = checkVerificationRoot(homedir());
  assert.equal(result.ok, false);
  assert.equal(result.hold, VERIFICATION_SCOPE_HOLDS.UNBOUNDED);
});

test("NEG2b: recursive scan of '~' shorthand is rejected", () => {
  const result = checkVerificationRoot("~");
  assert.equal(result.ok, false);
});

test("NEG2c: recursive scan of filesystem root '/' is rejected", () => {
  const result = checkVerificationRoot("/");
  assert.equal(result.ok, false);
});

test("NEG3: dynamically-resolved parent path that lands on home is rejected", () => {
  const dynamic = join(homedir(), "Desktop", "..");
  const result = checkVerificationRoot(dynamic);
  assert.equal(result.ok, false);
  assert.equal(resolve(dynamic), homedir());
});

test("NEG8: bounded authorized repo scan is allowed", () => {
  const result = checkVerificationRoot(join(REPO, "src", "governance"));
  assert.equal(result.ok, true);
  assert.equal(result.resolved, resolve(REPO, "src", "governance"));
});

test("NEG8b: authorized external-review surface dir is allowed", () => {
  const surface = resolve(homedir(), "Desktop", "AutoLoop-Review", "Current");
  const result = checkVerificationRoot(surface, { authorizedRoots: defaultAuthorizedRoots() });
  assert.equal(result.ok, true);
});

test("NEG9: forensic broad scan without explicit authorization is rejected", () => {
  const result = checkVerificationRoot("/Volumes");
  assert.equal(result.ok, false);
  assert.equal(result.hold, VERIFICATION_SCOPE_HOLDS.UNBOUNDED);
});

test("NEG9b: sibling directory outside authorized roots is rejected even though it exists on disk", () => {
  const result = checkVerificationRoot(resolve(REPO, "..", "some-other-project"));
  assert.equal(result.ok, false);
});

test("NEG10: empty/unknown verification root produces HOLD, not a default expansion", () => {
  const result = checkVerificationRoot("");
  assert.equal(result.ok, false);
  assert.equal(result.hold, VERIFICATION_SCOPE_HOLDS.UNBOUNDED);
});

test("assertVerificationRoot throws with hold code attached on rejection", () => {
  assert.throws(
    () => assertVerificationRoot(homedir()),
    (err) => err.hold === VERIFICATION_SCOPE_HOLDS.UNBOUNDED,
  );
});

test("assertVerificationRoot returns resolved path on acceptance", () => {
  const resolved = assertVerificationRoot(join(REPO, "test"));
  assert.equal(resolved, resolve(REPO, "test"));
});

test("caller-supplied additional authorized root is respected", () => {
  const extra = resolve(REPO, "..", "some-other-authorized-project");
  const result = checkVerificationRoot(extra, { authorizedRoots: [extra] });
  assert.equal(result.ok, true);
});
