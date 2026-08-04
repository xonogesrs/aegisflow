// test/governance/test-lifecycle-authorization.mjs
// §13.1 default deny · §13.2 explicit allow · §13.3 no escalation

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultDenyAuthority,
  normalizeAuthority,
  validateLifecycleAuthorization,
  effectiveAuthority,
  matchesPattern,
  patternContained,
  SCHEMA_ID,
} from "../../src/governance/lifecycle-authorization.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";

const entryAuthority = {
  decomposition: { allowed: true, max_depth: 1, max_total_nodes: 16 },
  independent_review: { allowed: true, require_fresh_session: true, require_same_artifact_digest: true },
  bounded_repair: { allowed: true, max_rounds: 2, scope_expansion: false },
  checkpoint_commit: { allowed: true, require_local_gates_pass: true, require_clean_index_before_stage: true, require_expected_paths_only: true },
  feature_branch_push: { allowed: true, branch_pattern: "governance/*", force_push: false, require_remote_ancestor_check: true },
  draft_pr: { allowed: true, base_branch: "main", draft_only: true, create_if_missing: true, update_if_present: true },
  merge_main: { allowed: false },
  release: { allowed: false },
  seal: { allowed: false },
};

test("13.1 default deny: absent block denies everything", () => {
  const d = defaultDenyAuthority();
  for (const cap of ["decomposition", "independent_review", "bounded_repair", "checkpoint_commit", "feature_branch_push", "draft_pr", "merge_main", "release", "seal"]) {
    assert.equal(d[cap].allowed, false, `${cap} must default to denied`);
  }
  // no implicit override of existing commit=NO / push=NO / seal=NO
  assert.equal(d.checkpoint_commit.allowed, false);
  assert.equal(d.feature_branch_push.allowed, false);
  assert.equal(d.seal.allowed, false);
});

test("13.1 validation rejects unknown capabilities and loosened irreversible sections", () => {
  const bad = { ...entryAuthority, merge_main: { allowed: true } };
  assert.equal(validateLifecycleAuthorization(bad).valid, false);
  const unknown = { ...entryAuthority, nuclear: { allowed: true } };
  assert.equal(validateLifecycleAuthorization(unknown).valid, false);
  const good = validateLifecycleAuthorization(entryAuthority);
  assert.equal(good.valid, true);
});

test("13.2 explicit allow: valid entry authorization normalizes and keeps capabilities", () => {
  const n = normalizeAuthority(entryAuthority);
  assert.equal(n.decomposition.allowed, true);
  assert.equal(n.decomposition.max_depth, 1);
  assert.equal(n.feature_branch_push.branch_pattern, "governance/*");
  assert.equal(n.merge_main.allowed, false);
});

test("13.3 escalation: child cannot open what parent denied", () => {
  const parent = normalizeAuthority({
    ...entryAuthority,
    feature_branch_push: { allowed: false, branch_pattern: "", force_push: false, require_remote_ancestor_check: false },
  });
  const child = normalizeAuthority(entryAuthority); // child allows feature_branch_push
  assert.throws(() => effectiveAuthority(parent, child, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
});

test("13.3 child declaring merge allowed is rejected at schema level (fail-closed)", () => {
  const bad = { ...entryAuthority, merge_main: { allowed: true } };
  assert.equal(validateLifecycleAuthorization(bad).valid, false);
  assert.throws(() => normalizeAuthority(bad), (e) => e.code === GOV_HOLD.AUTHORIZATION_INVALID);
});

test("13.3 escalation: child cannot raise repair rounds above parent", () => {
  const parent = normalizeAuthority(entryAuthority); // max_rounds 2
  const child = normalizeAuthority({ ...entryAuthority, bounded_repair: { allowed: true, max_rounds: 5, scope_expansion: false } });
  assert.throws(() => effectiveAuthority(parent, child, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
});

test("13.3 escalation: child cannot expand writable scope or branch pattern", () => {
  const parent = normalizeAuthority(entryAuthority);
  const child = normalizeAuthority({ ...entryAuthority, feature_branch_push: { allowed: true, branch_pattern: "*", force_push: false, require_remote_ancestor_check: true } });
  assert.throws(() => effectiveAuthority(parent, child, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
});

test("13.3 intersection: effective = parent ∩ child ∩ runtime (min caps, AND flags)", () => {
  const parent = normalizeAuthority(entryAuthority);
  const child = normalizeAuthority({ ...entryAuthority, bounded_repair: { allowed: true, max_rounds: 1, scope_expansion: false } });
  const runtime = normalizeAuthority({ ...entryAuthority, decomposition: { allowed: true, max_depth: 0, max_total_nodes: 0 } });
  const eff = effectiveAuthority(parent, child, runtime);
  assert.equal(eff.bounded_repair.max_rounds, 1); // min(2,1,2)
  assert.equal(eff.decomposition.max_depth, 0);   // runtime caps to 0
  assert.equal(eff.feature_branch_push.force_push, false);
  assert.equal(eff.merge_main.allowed, false);
});

test("13.3 runtime deny overrides child allow", () => {
  const parent = normalizeAuthority(entryAuthority);
  const child = normalizeAuthority(entryAuthority);
  const runtime = normalizeAuthority({ ...entryAuthority, checkpoint_commit: { allowed: false, require_local_gates_pass: true, require_clean_index_before_stage: true, require_expected_paths_only: true } });
  const eff = effectiveAuthority(parent, child, runtime);
  assert.equal(eff.checkpoint_commit.allowed, false);
});

test("pattern matching: governance/* matches governance branches only", () => {
  assert.equal(matchesPattern("governance/*", "governance/reversible-lifecycle-draft-pr"), true);
  assert.equal(matchesPattern("governance/*", "main"), false);
  assert.equal(matchesPattern("governance/*", "governance/x/y"), false);
});

test("pattern containment: child cannot escape parent pattern", () => {
  assert.equal(patternContained("governance/*", "governance/*"), true);
  assert.equal(patternContained("governance/x/*", "governance/*"), true);
  assert.equal(patternContained("*", "governance/*"), false);
  assert.equal(patternContained("main", "governance/*"), false);
});

test("schema id is pinned", () => {
  assert.equal(SCHEMA_ID, "autoloop.lifecycle-authorization/v1");
});
