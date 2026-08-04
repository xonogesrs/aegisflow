#!/usr/bin/env node
// scripts/gov-commit-checkpoint.mjs
//
// Checkpoint commit CLI. Dry-run by default; pass --apply to actually commit.
// Runs the checkpoint commit gate (§7) against live git state, then stages
// only the authorized expected paths and commits with the AutoLoop footer.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, asBool, splitList } from "./shared/gov-args.mjs";
import { evaluateCheckpointCommitGate } from "../src/governance/checkpoint-commit-gate.mjs";
import { normalizeAuthority, readLifecycleAuthorization } from "../src/governance/lifecycle-authorization.mjs";
import { checkpointCommitViolationsToHold } from "../src/governance/checkpoint-commit-gate.mjs";
import { scanForSecrets } from "../src/evidence/run-evidence-store.mjs";

// Real secret scan over changed file contents (fail-closed; no trust-input).
function scanChangedFilesForSecrets(cwd, changedPaths) {
  const found = [];
  const walk = (rel) => {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs)) walk(join(rel, entry));
      return;
    }
    if (!statSync(abs).isFile()) return;
    if (/^node_modules\//.test(rel)) return;
    const text = readFileSync(abs, "utf8");
    const result = scanForSecrets(text);
    for (const hit of (result?.matches ?? [])) found.push(`${rel}: ${hit}`);
  };
  for (const p of changedPaths) walk(p.replace(/\/$/, ""));
  return found;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitLines(args, cwd) {
  // raw output split into lines; only empties dropped so porcelain leading
  // status-column chars (" M package.json") survive for later slice(3).
  return execFileSync("git", args, { cwd, encoding: "utf8" }).split("\n")
    .filter((l) => l.trim().length > 0);
}

const { flags } = parseArgs(process.argv.slice(2));
const apply = asBool(flags.apply, false);
const cwd = flags.cwd || process.cwd();

const execDir = flags.execDir;
const authority = execDir
  ? readLifecycleAuthorization(execDir).lifecycle_authorization
  : normalizeAuthority(JSON.parse(readFileSync(flags.authorityFile, "utf8")).lifecycle_authorization);

const branch = git(["branch", "--show-current"], cwd);
const stagedPaths = gitLines(["diff", "--cached", "--name-only"], cwd);
// Commit set: explicit --commit-paths (milestone subset) or whole worktree.
const changedPaths = flags.commitPaths
  ? splitList(flags.commitPaths)
  : gitLines(["status", "--porcelain"], cwd)
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .map((p) => p.split(" -> ").pop());
const diffCheckClean = (() => {
  try { git(["diff", "--check"], cwd); return true; } catch { return false; }
})();

// Condition 11: real secret scan over changed file contents (never trust the
// caller-supplied list for the actual gate).
const scannedSecrets = scanChangedFilesForSecrets(cwd, changedPaths);

const gate = evaluateCheckpointCommitGate({
  authority,
  branch,
  expectedPaths: splitList(flags.expectedPaths),
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
  console.log(JSON.stringify({ allowed: true, dryRun: true, branch, commitMessage: full, footer: gate.footer }, null, 1));
  process.exit(0);
}

const expected = flags.commitPaths ? splitList(flags.commitPaths) : splitList(flags.expectedPaths);
if (expected.length === 0) {
  console.error("--commit-paths or --expected-paths required for --apply");
  process.exit(2);
}
git(["add", "--", ...expected], cwd);
git(["commit", "-m", full], cwd);
const head = git(["rev-parse", "HEAD"], cwd);
console.log(JSON.stringify({ allowed: true, committed: true, head, commitMessage: full }, null, 1));
