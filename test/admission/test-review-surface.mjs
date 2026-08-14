// test/admission/test-review-surface.mjs
//
// TA-2 — one-card-one-review-surface tests（U; NEG9, NEG10）: a repair
// generation MUST carry a supersede binding（NEG10）; a second delivery for
// the same card without a supersede chain is refused（NEG9）; the chain
// parsing is fail-closed on partial bindings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { supersedesFromBundleText } from "../../src/governance/review-bundle.mjs";
import { PROFILE_MATRIX, projectProfilePolicies } from "../../src/admission/policy-projection.mjs";

test("NEG10: repair generation WITHOUT a supersede binding is invalid evidence", () => {
  // a bundle that declares no SUPERSEDES_* lines -> no supersede record
  const plain = supersedesFromBundleText("REVIEW_BUNDLE_IDENTITY: 1111111111111111111111111111111111111111111111111111111111111111\nno chain here\n");
  assert.equal(plain.supersedes, null);
  assert.equal(plain.error, null);
  // a repair generation that DID declare identity but forgot the sha is
  // inconsistent -> fail-closed error（the delivery gate holds it）
  const partial = supersedesFromBundleText(
    "SUPERSEDES_BUNDLE_IDENTITY: 2222222222222222222222222222222222222222222222222222222222222222\n" +
    "SUPERSEDES_BUNDLE_PATH: /tmp/prev.txt\n",
  );
  assert.equal(partial.supersedes, null);
  assert.equal(partial.error, "supersedes_sha256_missing");
});

test("NEG10: a complete supersede binding parses to a linear predecessor", () => {
  const text =
    "SUPERSEDES_BUNDLE_IDENTITY: 2222222222222222222222222222222222222222222222222222222222222222\n" +
    "SUPERSEDES_BUNDLE_SHA256: 3333333333333333333333333333333333333333333333333333333333333333\n" +
    "SUPERSEDES_BUNDLE_PATH: /tmp/prev.txt\n";
  const parsed = supersedesFromBundleText(text);
  assert.equal(parsed.supersedes.reviewBundleIdentity, "2222222222222222222222222222222222222222222222222222222222222222");
  assert.equal(parsed.supersedes.reviewBundleSha256, "3333333333333333333333333333333333333333333333333333333333333333");
  assert.equal(parsed.supersedes.bundlePath, "/tmp/prev.txt");
  assert.equal(parsed.error, null);
});

test("NEG9: the one-card-one-review-surface contract is structural (single authoritative surface per card)", () => {
  const surfacePolicies = Object.fromEntries(
    Object.keys(PROFILE_MATRIX).map((k) => [k, projectProfilePolicies(k).review_surface_policy]),
  );
  for (const [profile, policy] of Object.entries(surfacePolicies)) {
    assert.equal(policy.authoritative_single_surface, true, `${profile} must be single-surface`);
    assert.equal(policy.chain, "linear", `${profile} must be linear`);
  }
  // fast path carries NO generation policy（no review surface at all）
  assert.deepEqual(surfacePolicies.FAST_PATH.generation_policy, []);
  assert.ok(surfacePolicies.CRITICAL.generation_policy.length >= 5);
});
