#!/usr/bin/env node
// scripts/gov-commit-integration.mjs
//
// Integration-approved commit CLI (§8.2). Only usable after a *verified*
// external review PASS. Reads the harness-owned external-review-result.json,
// RECOMPUTES current identities (bundle / patch / changed-tree / head / base
// / repo / branch / card / run / review round), evaluates the integration
// gate, then commits LOCALLY. Push still requires its own post-gate
// (scripts/gov-push-gate.mjs).
//
// Rejects --external-review-status PASS and --reviewed-artifact-identity
// (self-declared / caller-supplied authority) — the gate reads the artifact.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs, asBool, splitList } from "./shared/gov-args.mjs";
import { git, gitOk, loadRecord, buildInventory, rejectSelfDeclaredFlags, scanChangedFilesForSecrets, contextFor } from "./shared/gov-args.mjs";
import { normalizeAuthority } from "../src/governance/lifecycle-authorization.mjs";
import { readExternalReviewResult, validateExternalReviewResult } from "../src/governance/external-review.mjs";
import { evaluateIntegrationCommitGate, integrationViolationsToHold } from "../src/governance/integration-commit-gate.mjs";
import { expandPath } from "../src/governance/change-inventory.mjs";

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
const baseBranch = flags.baseBranch || record.base || authority.base || "main";
const cardId = flags.cardId || record.card_id || "";
const runId = flags.runId || record.run_id || "";
const reviewRound = Number.isInteger(Number(flags.reviewRound)) ? Number(flags.reviewRound) : 1;
const agentIdentity = flags.agent || "pi-deepseek-v4-flash";
const expectedPaths = splitList(flags.expectedPaths).length ? splitList(flags.expectedPaths) : (record.authorized_paths || []);

// Harness-owned result artifact (never caller-declared).
let result;
try {
  if (flags.resultFile) {
    const raw = JSON.parse(readFileSync(flags.resultFile, "utf8"));
    const check = validateExternalReviewResult(raw);
    if (!check.valid) {
      console.error("HOLD / EXTERNAL_REVIEW_RESULT_INVALID");
      for (const e of check.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    result = raw;
  } else {
    result = readExternalReviewResult(cwd);
  }
} catch (e) {
  console.error(e.code ?? e.message);
  process.exit(1);
}

// Recompute current identities (never trust the artifact for current state).
const inventory = buildInventory(cwd, baseBranch);
const bundlePath = flags.bundlePath
  ? expandPath(flags.bundlePath, cwd)
  : (record.bundle_path ? expandPath(record.bundle_path, cwd) : "");
const current = contextFor({
  authority, inventory, bundlePath, cardId, runId, reviewRound, agentIdentity,
  record,
});

const branch = inventory.branch;
const stagedPaths = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8" }).split("\n").filter(Boolean);
const diffCheckClean = gitOk(["diff", "--check"], cwd);
const scannedSecrets = scanChangedFilesForSecrets(cwd, inventory.changedPaths);
const repairRounds = Number.isInteger(Number(flags.repairRounds)) ? Number(flags.repairRounds) : 0;
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
  branch,
  expectedPaths,
  changedPaths: inventory.changedPaths,
  stagedPaths,
  diffCheckClean,
  artifactIdentity: flags.artifactIdentity || inventory.changedTreeIdentity,
  evidenceDigest: flags.evidenceDigest || "",
  reviewBlockingFindings: splitList(flags.reviewBlocking),
  repairConverged: asBool(flags.repairConverged, false),
  secretLikeValues: scannedSecrets.length > 0 ? scannedSecrets : splitList(flags.secretLikeValues),
  cardId,
  runId,
  milestoneId: flags.milestoneId || "integration",
  reviewUnitActual,
});

if (!gate.allowed) {
  const err = integrationViolationsToHold(gate.violations);
  console.error(err.code);
  for (const v of gate.violations) console.error(`  - ${v}`);
  process.exit(1);
}

const subject = flags.message || `integration: ${cardId} (external review PASS)`;
const full = subject + gate.footer;

if (!apply) {
  console.log(JSON.stringify({ allowed: true, dryRun: true, integrationCommit: true, branch, commitMessage: full, footer: gate.footer, verified: true }, null, 1));
  process.exit(0);
}

if (inventory.changedPaths.length === 0) {
  console.error("integration: no changed paths to commit");
  process.exit(2);
}
git(["add", "--", ...inventory.changedPaths], cwd);
git(["commit", "-m", full], cwd);
const head = git(["rev-parse", "HEAD"], cwd);
console.log(JSON.stringify({ allowed: true, committed: true, integrationCommit: true, head, commitMessage: full }, null, 1));
