#!/usr/bin/env node
// scripts/gov-commit-checkpoint.mjs
//
// Internal checkpoint commit CLI (§8.1). Dry-run by default; pass --apply to
// actually commit LOCALLY. A checkpoint commit is a local rollback point /
// milestone boundary: it does NOT require external review PASS and is never
// pushed. Push has its own gate (scripts/gov-push-gate.mjs), post-PASS.

import { execFileSync } from "node:child_process";
import { parseArgs, asBool, splitList } from "./shared/gov-args.mjs";
import { git, gitOk, loadRecord, loadAuthority, buildInventory, rejectSelfDeclaredFlags, scanChangedFilesForSecrets } from "./shared/gov-args.mjs";
import { evaluateCheckpointCommitGate, checkpointCommitViolationsToHold } from "../src/governance/checkpoint-commit-gate.mjs";function gitLines(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).split("\n")
    .filter((l) => l.trim().length > 0);
}

const { flags } = parseArgs(process.argv.slice(2));
const apply = asBool(flags.apply, false);
const cwd = flags.cwd || process.cwd();

// Fail-closed: self-declared PASS / caller-supplied identity are rejected.
const selfDeclared = rejectSelfDeclaredFlags(flags);
if (selfDeclared.length > 0) {
  console.error("HOLD / RESULT_SELF_DECLARATION_REJECTED");
  for (const s of selfDeclared) console.error(`  - ${s}`);
  process.exit(1);
}

const authority = loadAuthority(flags);
const record = loadRecord(flags);
const baseBranch = flags.baseBranch || authority.base || record.base || "main";
const expectedPaths = splitList(flags.expectedPaths).length ? splitList(flags.expectedPaths) : (record.authorized_paths || []);
const branch = git(["branch", "--show-current"], cwd);
const stagedPaths = gitLines(["diff", "--cached", "--name-only"], cwd);
const changedPaths = flags.commitPaths
  ? splitList(flags.commitPaths)
  : gitLines(["status", "--porcelain"], cwd)
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .map((p) => p.split(" -> ").pop());
const diffCheckClean = gitOk(["diff", "--check"], cwd);

// Condition 11: real secret scan over changed file contents.
const scannedSecrets = scanChangedFilesForSecrets(cwd, changedPaths);

// Review-unit boundary (§5): measured counts at runtime.
let inventory = null;
try {
  inventory = buildInventory(cwd, baseBranch);
} catch { /* inventory unavailable — review-unit check skipped, other gates still apply */ }
const reviewUnitActual = inventory ? {
  repository_count: 1,
  worktree_count: 1,
  parent_card_count: 1,
  architecture_goal_count: 1,
  internal_milestones: Number.isInteger(Number(flags.milestones)) ? Number(flags.milestones) : 1,
  changed_paths: changedPaths.length,
  patch_lines: inventory.patchLines,
  repair_rounds: Number.isInteger(Number(flags.repairRounds)) ? Number(flags.repairRounds) : 0,
} : undefined;

const gate = evaluateCheckpointCommitGate({
  authority,
  branch,
  expectedPaths,
  changedPaths,
  stagedPaths,
  diffCheckClean,
  verificationPassed: asBool(flags.verificationPassed, false),
  artifactIdentity: flags.artifactIdentity || "",
  evidenceDigest: flags.evidenceDigest || "",
  reviewBlockingFindings: splitList(flags.reviewBlocking),
  repairConverged: asBool(flags.repairConverged, false),
  secretLikeValues: scannedSecrets.length > 0 ? scannedSecrets : splitList(flags.secretLikeValues),
  cardId: flags.cardId || "",
  runId: flags.runId || "",
  milestoneId: flags.milestoneId || "",
  reviewUnitActual,
});

if (!gate.allowed) {
  const err = checkpointCommitViolationsToHold(gate.violations);
  console.error(err.code);
  for (const v of gate.violations) console.error(`  - ${v}`);
  process.exit(1);
}

const subject = flags.message || `checkpoint: ${flags.cardId || "card"}`;
const full = subject + gate.footer;

if (!apply) {
  console.log(JSON.stringify({ allowed: true, dryRun: true, localOnly: true, branch, commitMessage: full, footer: gate.footer, reviewUnit: reviewUnitActual }, null, 1));
  process.exit(0);
}

const expected = flags.commitPaths ? splitList(flags.commitPaths) : expectedPaths;
if (expected.length === 0) {
  console.error("--commit-paths or --expected-paths required for --apply");
  process.exit(2);
}
git(["add", "--", ...expected], cwd);
git(["commit", "-m", full], cwd);
const head = git(["rev-parse", "HEAD"], cwd);
console.log(JSON.stringify({ allowed: true, committed: true, localCheckpoint: true, head, commitMessage: full }, null, 1));
