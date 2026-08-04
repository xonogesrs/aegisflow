// test/governance/test-lifecycle-authorization.mjs
// Schema-parity validation + correct intersection semantics (§6/§7):
//   - restrictive requirements (true=stricter): union, runtime cannot cancel
//   - capability fields (true=more power): AND, escalation on child request
//   - min caps, pattern containment, identity equality
//   - top-level bindings: repository/worktree/branch/base/scope/bundle path

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultDenyAuthority,
  normalizeAuthority,
  validateLifecycleAuthorization,
  validateAuthorityRecord,
  effectiveAuthority,
  matchesPattern,
  patternContained,
  scopeCovers,
  SCHEMA_ID,
} from "../../src/governance/lifecycle-authorization.mjs";
import { GOV_HOLD } from "../../src/governance/holds.mjs";
import { entryBlock, entryRecord, CARD_ID, BRANCH } from "./helpers.mjs";

const entry = entryRecord();
const block = entryBlock();

test("schema id is v2 (review-unit contract)", () => {
  assert.equal(SCHEMA_ID, "autoloop.lifecycle-authorization/v2");
});

test("default deny: absent block denies everything", () => {
  const d = defaultDenyAuthority();
  for (const cap of ["decomposition", "independent_review", "bounded_repair", "checkpoint_commit", "feature_branch_push", "draft_pr", "review_unit", "merge_main", "release", "seal"]) {
    assert.equal(d[cap].allowed, false, `${cap} must default to denied`);
  }
  assert.equal(d.merge_main.allowed, false);
  assert.equal(d.seal.allowed, false);
});

test("record + block validate against the v2 schema", () => {
  assert.equal(validateAuthorityRecord(entry).valid, true);
  assert.equal(validateLifecycleAuthorization(block).valid, true);
});

test("unknown capability / unknown field / loosened irreversible are rejected", () => {
  const unknown = { ...block, nuclear: { allowed: true } };
  assert.equal(validateLifecycleAuthorization(unknown).valid, false);
  const extraField = structuredClone(block);
  extraField.draft_pr.nuclear = true;
  assert.equal(validateLifecycleAuthorization(extraField).valid, false);
  const badMerge = { ...block, merge_main: { allowed: true } };
  assert.equal(validateLifecycleAuthorization(badMerge).valid, false);
  const badSeal = { ...block, seal: { allowed: true } };
  assert.equal(validateLifecycleAuthorization(badSeal).valid, false);
});

test("required fields, integer bounds and string length are enforced (schema parity)", () => {
  const missing = structuredClone(block);
  delete missing.external_review.require_bundle;
  assert.equal(validateLifecycleAuthorization(missing).valid, false);
  const tooManyMilestones = structuredClone(block);
  tooManyMilestones.review_unit.maximum_internal_milestones = 9;
  assert.equal(validateLifecycleAuthorization(tooManyMilestones).valid, false);
  const badBaseHead = { ...entry, base_head: "short" };
  assert.equal(validateAuthorityRecord(badBaseHead).valid, false);
  const notObject = { ...entry, lifecycle_authorization: "x" };
  assert.equal(validateAuthorityRecord(notObject).valid, false);
});

test("normalization keeps explicit capabilities, deny-first", () => {
  const n = normalizeAuthority(block);
  assert.equal(n.decomposition.max_depth, 1);
  assert.equal(n.feature_branch_push.branch_pattern, "governance/*");
  assert.equal(n.review_unit.maximum_internal_milestones, 3);
  assert.equal(n.merge_main.allowed, false);
});

test("neutral runtime is pass-through (undefined runtime does not zero caps)", () => {
  const eff = effectiveAuthority(entry, entry, undefined);
  assert.equal(eff.review_unit.maximum_internal_milestones, 3);
  assert.equal(eff.bounded_repair.max_rounds, 2);
  assert.equal(eff.checkpoint_commit.allowed, true);
  assert.equal(eff.draft_pr.create_if_missing, true);
  assert.equal(eff.feature_branch_push.force_push, false);
  assert.equal(eff.merge_main.allowed, false);
});

test("[neg 9] runtime cannot cancel external_review.required (restrictive union)", () => {
  const runtime = entryRecord({
    lifecycle_authorization: {
      ...block,
      external_review: { required: false, require_bundle: false, bundle_path: "~/Desktop/AutoLoop-Review/READY_FOR_REVIEW.txt" },
    },
  });
  const eff = effectiveAuthority(entry, entry, runtime);
  assert.equal(eff.external_review.required, true);
  assert.equal(eff.external_review.require_bundle, true);
});

test("restrictive requirements accumulate across parent/child/runtime", () => {
  const parent = entryRecord();
  const child = entryRecord(); // re-affirms all requirements
  const eff = effectiveAuthority(parent, child, undefined);
  for (const f of ["require_fresh_session", "require_same_artifact_digest"]) {
    assert.equal(eff.independent_review[f], true);
  }
  for (const f of ["require_local_gates_pass", "require_clean_index_before_stage", "require_expected_paths_only"]) {
    assert.equal(eff.checkpoint_commit[f], true);
  }
  assert.equal(eff.feature_branch_push.require_remote_ancestor_check, true);
  assert.equal(eff.draft_pr.draft_only, true);
});

test("child loosening a parent requirement is escalation", () => {
  const parent = entryRecord();
  const child = entryRecord({
    lifecycle_authorization: { ...block, external_review: { required: false, require_bundle: true, bundle_path: "~/Desktop/AutoLoop-Review/READY_FOR_REVIEW.txt" } },
  });
  assert.throws(() => effectiveAuthority(parent, child, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
});

test("capability fields intersect by permission direction (AND)", () => {
  // force_push is a capability: effective requires ALL parties to allow.
  const eff = effectiveAuthority(entry, entry, undefined);
  assert.equal(eff.feature_branch_push.force_push, false);
  // runtime claiming force_push cannot grant it
  const runtime = entryRecord({
    lifecycle_authorization: { ...block, feature_branch_push: { allowed: true, branch_pattern: "governance/*", force_push: true, require_remote_ancestor_check: true } },
  });
  assert.equal(effectiveAuthority(entry, entry, runtime).feature_branch_push.force_push, false);
  // child requesting force_push the parent denied is escalation
  const child = entryRecord({
    lifecycle_authorization: { ...block, feature_branch_push: { allowed: true, branch_pattern: "governance/*", force_push: true, require_remote_ancestor_check: true } },
  });
  assert.throws(() => effectiveAuthority(entry, child, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
});

test("create_if_missing / update_if_present are capability AND", () => {
  const eff = effectiveAuthority(entry, entry, undefined);
  assert.equal(eff.draft_pr.create_if_missing, true);
  assert.equal(eff.draft_pr.update_if_present, true);
  const runtimeDeny = entryRecord({
    lifecycle_authorization: { ...block, draft_pr: { allowed: true, base_branch: "main", draft_only: true, create_if_missing: false, update_if_present: true } },
  });
  const eff2 = effectiveAuthority(entry, entry, runtimeDeny);
  assert.equal(eff2.draft_pr.create_if_missing, false);
});

test("min caps: effective is min; child exceeding parent is escalation", () => {
  const parent = entryRecord();
  // schema hard-caps bounded_repair.max_rounds at 2 — exceeding it is invalid
  const tooHigh = entryRecord({
    lifecycle_authorization: { ...block, bounded_repair: { allowed: true, max_rounds: 5, scope_expansion: false } },
  });
  assert.equal(validateAuthorityRecord(tooHigh).valid, false);
  // escalation within schema bounds: child raises max_depth above parent
  const child = entryRecord({
    lifecycle_authorization: { ...block, decomposition: { allowed: true, max_depth: 16, max_total_nodes: 16 } },
  });
  assert.throws(() => effectiveAuthority(parent, child, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
  const narrowChild = entryRecord({
    lifecycle_authorization: { ...block, bounded_repair: { allowed: true, max_rounds: 1, scope_expansion: false } },
  });
  assert.equal(effectiveAuthority(parent, narrowChild, undefined).bounded_repair.max_rounds, 1);
});

test("runtime deny overrides child allow (capability tighten)", () => {
  const runtime = entryRecord({
    lifecycle_authorization: { ...block, checkpoint_commit: { ...block.checkpoint_commit, allowed: false } },
  });
  const eff = effectiveAuthority(entry, entry, runtime);
  assert.equal(eff.checkpoint_commit.allowed, false);
});

test("pattern matching: governance/* matches governance branches only", () => {
  assert.equal(matchesPattern("governance/*", BRANCH), true);
  assert.equal(matchesPattern("governance/*", "main"), false);
  assert.equal(matchesPattern("governance/*", "governance/x/y"), false);
});

test("[neg 10] runtime pattern narrower → effective pattern narrows", () => {
  const runtime = entryRecord({
    lifecycle_authorization: { ...block, feature_branch_push: { allowed: true, branch_pattern: "governance/reversible-*", force_push: false, require_remote_ancestor_check: true } },
  });
  const eff = effectiveAuthority(entry, entry, runtime);
  assert.equal(eff.feature_branch_push.branch_pattern, "governance/reversible-*");
});

test("[neg 11] pattern with no safe intersection → fail-closed HOLD", () => {
  const child = entryRecord({
    lifecycle_authorization: { ...block, feature_branch_push: { allowed: true, branch_pattern: "feature/*", force_push: false, require_remote_ancestor_check: true } },
  });
  assert.throws(() => effectiveAuthority(entry, child, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
  // two incomparable declared patterns (child ⊆ parent required first)
  const childNarrow = entryRecord({
    lifecycle_authorization: { ...block, feature_branch_push: { allowed: true, branch_pattern: "governance/a-*", force_push: false, require_remote_ancestor_check: true } },
  });
  const runtime = entryRecord({
    lifecycle_authorization: { ...block, feature_branch_push: { allowed: true, branch_pattern: "governance/b-*", force_push: false, require_remote_ancestor_check: true } },
  });
  // child ⊆ parent, but child and runtime are incomparable → cannot intersect
  assert.throws(() => effectiveAuthority(entry, childNarrow, runtime), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
});

test("[neg 12] scope expansion by child is escalation", () => {
  const child = entryRecord({ authorized_paths: [...entry.authorized_paths, "src/nuclear/"] });
  assert.throws(() => effectiveAuthority(entry, child, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
});

test("[neg 13] repository / branch / base identity conflict is HOLD", () => {
  const child = entryRecord({ repository: "other/repo" });
  assert.throws(() => effectiveAuthority(entry, child, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
  const childBranch = entryRecord({ branch: "main" });
  assert.throws(() => effectiveAuthority(entry, childBranch, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
  const childBase = entryRecord({ base: "master" });
  assert.throws(() => effectiveAuthority(entry, childBase, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
});

test("[neg 14] bundle path identity conflict is HOLD", () => {
  const child = entryRecord({
    lifecycle_authorization: { ...block, external_review: { required: true, require_bundle: true, bundle_path: "/etc/passwd" } },
  });
  assert.throws(() => effectiveAuthority(entry, child, undefined), (e) => e.code === GOV_HOLD.AUTHORITY_ESCALATION_REJECTED);
});

test("top-level bindings survive intersection", () => {
  const eff = effectiveAuthority(entry, entry, undefined);
  assert.equal(eff.repository, entry.repository);
  assert.equal(eff.branch, entry.branch);
  assert.equal(eff.base, entry.base);
  assert.deepEqual(eff.authorized_paths, entry.authorized_paths);
});

test("scopeCovers handles files, dirs with slash, bare prefixes", () => {
  const scope = ["src/governance/", "src/schema/lifecycle-authorization.schema.json", "scripts", "package.json"];
  assert.equal(scopeCovers("src/governance/holds.mjs", scope), true);
  assert.equal(scopeCovers("src/schema/lifecycle-authorization.schema.json", scope), true);
  assert.equal(scopeCovers("scripts/gov-x.mjs", scope), true);
  assert.equal(scopeCovers("package.json", scope), true);
  assert.equal(scopeCovers("src/nuclear/boom.mjs", scope), false);
});

test("patternContained: child cannot escape parent pattern", () => {
  assert.equal(patternContained("governance/*", "governance/*"), true);
  assert.equal(patternContained("governance/x/*", "governance/*"), true);
  assert.equal(patternContained("*", "governance/*"), false);
  assert.equal(patternContained("main", "governance/*"), false);
});

test("irreversible sections never pass: merge/release/seal locked false", () => {
  const eff = effectiveAuthority(entry, entry, undefined);
  assert.equal(eff.merge_main.allowed, false);
  assert.equal(eff.release.allowed, false);
  assert.equal(eff.seal.allowed, false);
});
