#!/usr/bin/env node
// scripts/gov-commit-integration.mjs
//
// Integration attestation CLI (§8.2). After a *verified* external review
// PASS, this verifies that the CURRENT HEAD and tree exactly match the
// reviewed artifact (digest-bound) and records INTEGRATION_READY. It NEVER
// creates a new commit: creating a commit after review would change HEAD and
// invalidate the reviewed identity (external PASS authorizes pushing the
// reviewed checkpoint HEAD — push then re-verifies the same identity).
//
// Rejects --external-review-status PASS / --reviewed-artifact-identity and
// --result-file (self-declared / caller-supplied authority). The result
// artifact is read from the fixed controller path only.

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { parseArgs, asBool, splitList } from "./shared/gov-args.mjs";
import { gitOk, loadRecord, buildInventory, rejectSelfDeclaredFlags, scanChangedFilesForSecrets, contextFor, assertLiveBindings, assertScopeCoversInventory } from "./shared/gov-args.mjs";
import { normalizeAuthority, scopeCovers } from "../src/governance/lifecycle-authorization.mjs";
import { readExternalReviewResult } from "../src/governance/external-review.mjs";
import { evaluateIntegrationCommitGate, integrationViolationsToHold } from "../src/governance/integration-commit-gate.mjs";
import { expandPath } from "../src/governance/change-inventory.mjs";
import { GOV_HOLD } from "../src/governance/holds.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const apply = asBool(flags.apply, false);
const cwd = flags.cwd || process.cwd();

const selfDeclared = rejectSelfDeclaredFlags(flags);
if (selfDeclared.length > 0) {
  console.error("HOLD / RESULT_SELF_DECLARATION_REJECTED");
  for (const s of selfDeclared) console.error(`  - ${s}`);
  process.exit(1);
}

const record = loadRecord(flags);
const authority = normalizeAuthority(record.lifecycle_authorization);
const baseBranch = record.base || authority.base || "main";
// card/run identity come ONLY from the record — flag overrides are rejected
// by assertLiveBindings.
const cardId = record.card_id || "";
const runId = record.run_id || "";
const agentIdentity = flags.agent || "pi-deepseek-v4-flash";
// Scope is authoritative from the record; a CLI --expected-paths override is
// only accepted when strictly contained in the authorized scope (else HOLD).
const recordScope = record.authorized_paths || [];
const cliScope = splitList(flags.expectedPaths);
const expectedPaths = cliScope.length ? cliScope : recordScope;
if (cliScope.length) {
  for (const p of cliScope) {
    if (!scopeCovers(p, recordScope)) {
      console.error("HOLD / CLI_OVERRIDE_REJECTED");
      console.error(`  - --expected-paths expands scope: ${p} not covered by authority record`);
      process.exit(1);
    }
  }
}

// Recompute current identities + bind the live environment to the record.
const inventory = buildInventory(cwd, baseBranch);
try {
  assertLiveBindings({ record, cwd, inventory, baseBranch, cardId, runId, flags });
  assertScopeCoversInventory(inventory, recordScope);
} catch (e) {
  console.error(e.code ?? e.message);
  console.error(`  - ${e.message}`);
  process.exit(1);
}
const bundlePath = record.bundle_path ? expandPath(record.bundle_path, cwd) : "";

// Harness-owned result artifact — fixed controller path derived from the
// bundle directory (outside the executor writable scope), never --result-file.
const bundleDir = bundlePath ? dirname(bundlePath) : "";
let result;
try {
  result = bundleDir ? readExternalReviewResult(bundleDir) : null;
} catch (e) {
  console.error(e.code ?? e.message);
  if (e.code === GOV_HOLD.EXTERNAL_REVIEW_RESULT_MISSING) {
    console.error("  - integration requires a verified external-review-result artifact; PENDING is not enough");
  }
  process.exit(1);
}
const reviewRound = result ? result.review_round : 1;
const current = contextFor({ authority, inventory, bundlePath, cardId, runId, reviewRound, agentIdentity, record });

// The integration gate must never leave the tree uncommitted or the HEAD
// drifted: the reviewed HEAD is the pushable HEAD.
const worktreeDirty = inventory.dirtyCount > 0 || inventory.untrackedCount > 0;
const stagedPaths = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8" }).split("\n").filter(Boolean);

const diffCheckClean = gitOk(["diff", "--check"], cwd);
const scannedSecrets = scanChangedFilesForSecrets(cwd, inventory.changedPaths);
const repairRounds = Number.isInteger(Number(flags.repairRounds)) ? Number(flags.repairRounds) : 1;
const reviewUnitActual = {
  repository_count: 1,
  worktree_count: 1,
  parent_card_count: 1,
  architecture_goal_count: 1,
  internal_milestones: Number.isInteger(Number(flags.milestones)) ? Number(flags.milestones) : 1,
  changed_paths: inventory.changedPaths.length,
  patch_lines: inventory.patchLines,
  repair_rounds: repairRounds,
};

const gate = evaluateIntegrationCommitGate({
  authority,
  result,
  current,
  lifecycleState: flags.lifecycleState || "EXTERNAL_REVIEW_PASS",
  verificationPassed: asBool(flags.verificationPassed, false),
  branch: inventory.branch,
  expectedPaths,
  changedPaths: inventory.changedPaths,
  stagedPaths,
  diffCheckClean,
  artifactIdentity: inventory.changedTreeIdentity,
  evidenceDigest: flags.evidenceDigest || "",
  reviewBlockingFindings: splitList(flags.reviewBlocking),
  repairConverged: asBool(flags.repairConverged, false),
  secretLikeValues: scannedSecrets.length > 0 ? scannedSecrets : splitList(flags.secretLikeValues),
  cardId,
  runId,
  milestoneId: flags.milestoneId || "integration",
  reviewUnitActual,
});

if (worktreeDirty) {
  const err = integrationViolationsToHold([...gate.violations, "worktree_dirty: reviewed tree drifted — no new commit is permitted after review"]);
  console.error(err.code);
  for (const v of err.details?.join?.("; ") ?? [...gate.violations, "worktree_dirty"]) console.error(`  - ${v}`);
  process.exit(1);
}

if (!gate.allowed) {
  const err = integrationViolationsToHold(gate.violations);
  console.error(err.code);
  for (const v of gate.violations) console.error(`  - ${v}`);
  process.exit(1);
}

// Attestation only — no git mutation. HEAD stays the reviewed checkpoint HEAD.
const head = inventory.head;
const report = {
  allowed: true,
  integration_ready: true,
  attestation_only: true,
  no_commit_created: true,
  head,
  reviewed_head: result.current_head,
  identity_verified: true,
  lifecycleState: flags.lifecycleState || "EXTERNAL_REVIEW_PASS",
  apply_requested: apply,
};
console.log(JSON.stringify(report, null, 1));
