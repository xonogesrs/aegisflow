// test/governance/helpers.mjs
// Shared fixtures for governance tests (schema v2 contract).

import { productionRemoteMatch } from "../../scripts/shared/gov-args.mjs";

export const CARD_ID = "AUTOLOOP-GOVERNANCE-REVIEW-UNIT-FINALIZATION-1";
export const RUN_ID = "run-final-1";
export const REPOSITORY = "xonogesrs/autoloop";
export const BRANCH = "governance/reversible-lifecycle-draft-pr";
export const BASE = "main";
export const BUNDLE_PATH = "~/Desktop/AutoLoop-Review/READY_FOR_REVIEW.txt";
export const AGENT_IDENTITY = "pi-deepseek-v4-flash";

export const AUTHORIZED_PATHS = [
  "src/governance/",
  "src/schema/lifecycle-authorization.schema.json",
  "scripts/",
  "scripts/shared/",
  "test/governance/",
  "docs/governance/",
  "package.json",
];

export function entryBlock() {
  return {
    decomposition: { allowed: true, max_depth: 1, max_total_nodes: 16 },
    independent_review: { allowed: true, require_fresh_session: true, require_same_artifact_digest: true },
    bounded_repair: { allowed: true, max_rounds: 2, scope_expansion: false },
    checkpoint_commit: { allowed: true, require_local_gates_pass: true, require_clean_index_before_stage: true, require_expected_paths_only: true },
    feature_branch_push: { allowed: true, branch_pattern: "governance/*", force_push: false, require_remote_ancestor_check: true },
    draft_pr: { allowed: true, base_branch: "main", draft_only: true, create_if_missing: true, update_if_present: true },
    external_review: { required: true, require_bundle: true, bundle_path: BUNDLE_PATH },
    review_unit: {
      allowed: true,
      repository_count: 1,
      worktree_count: 1,
      parent_card_count: 1,
      architecture_goal_count: 1,
      maximum_internal_milestones: 3,
      maximum_changed_paths: 25,
      maximum_patch_lines: 3000,
      maximum_repair_rounds: 2,
    },
    merge_main: { allowed: false },
    release: { allowed: false },
    seal: { allowed: false },
  };
}

export function entryRecord(overrides = {}) {
  return {
    schema: "autoloop.lifecycle-authorization/v2",
    card_id: CARD_ID,
    run_id: RUN_ID,
    issued_at: new Date().toISOString(),
    authorized_by: "controller",
    authorization_ref: "card",
    repository: REPOSITORY,
    worktree: fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, ""),
    branch: BRANCH,
    base: BASE,
    base_head: "2a9d5c1e010a3654b2f371ef41e8c50c32cc21e4",
    authorized_paths: [...AUTHORIZED_PATHS],
    bundle_path: BUNDLE_PATH,
    lifecycle_authorization: entryBlock(),
    ...overrides,
  };
}

export function validResult(overrides = {}) {
  return {
    schema: "autoloop.external-review-result/v1",
    card_id: CARD_ID,
    run_id: RUN_ID,
    verdict: "PASS",
    bundle_sha256: "b".repeat(64),
    patch_sha256: "a".repeat(64),
    changed_tree_identity: "c".repeat(64),
    reviewer_identity: "external-reviewer-1",
    reviewed_at: new Date().toISOString(),
    review_round: 1,
    findings_digest: "f".repeat(64),
    authorization_source: "controller-session:final-1",
    current_head: "1".repeat(40),
    base_head: "2".repeat(40),
    repository: REPOSITORY,
    branch: BRANCH,
    base_branch: BASE,
    bundle_path: BUNDLE_PATH,
    ...overrides,
  };
}

export function validResultRound2(overrides = {}) {
  return validResult({
    review_round: 2,
    prior_bundle_sha256: "9".repeat(64),
    prior_findings_digest: "8".repeat(64),
    ...overrides,
  });
}

export function currentContext(overrides = {}) {
  return {
    bundleSha256: "b".repeat(64),
    patchSha256: "a".repeat(64),
    changedTreeIdentity: "c".repeat(64),
    cardId: CARD_ID,
    runId: RUN_ID,
    reviewRound: 1,
    currentHead: "1".repeat(40),
    baseHead: "2".repeat(40),
    repository: REPOSITORY,
    branch: BRANCH,
    baseBranch: BASE,
    bundlePath: BUNDLE_PATH,
    agentIdentity: AGENT_IDENTITY,
    priorBundleSha256: "",
    priorFindingsDigest: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Temp-repo fixture for inventory / e2e tests
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test-only remote-URL adapter (round 4 finding 2). Production accepts ONLY
 * the three canonical GitHub forms (productionRemoteMatch). Tests need a
 * LOCAL bare remote to exercise the push path without network access, so
 * they inject this adapter through the library API (runPushGate's
 * `remotePolicy` / remoteUrlMatchesAuthorizedRepository's `matcher`) — it is
 * never reachable from a production CLI flag.
 */
export function testRemoteMatch(url, repoId) {
  if (productionRemoteMatch(url, repoId)) return true;
  const target = String(repoId || "").replace(/\.git$/, "");
  if (!target || !target.includes("/")) return false;
  const s = String(url || "").replace(/^file:\/\//, "").replace(/\.git$/, "");
  const segments = s.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  return segments.slice(-2).join("/") === target;
}

export function createTempRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-gov-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Governance Test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  git(["checkout", "-b", "governance/test-unit"]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, git };
}
