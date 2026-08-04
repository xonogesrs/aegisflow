#!/usr/bin/env node
// scripts/gov-push-gate.mjs
//
// Feature-branch push gate CLI (§8/§13). Push is only allowed after a
// *verified* external review PASS backed by the harness-owned
// external-review-result.json. Dry-run by default; pass --apply to push.
// Never force-pushes; never auto-rebases; diverged remote → HOLD.
// `--external-review-status PASS` / `--reviewed-artifact-identity` are
// REJECTED (self-declared / caller-supplied authority).

import { execFileSync } from "node:child_process";
import { parseArgs, asBool } from "./shared/gov-args.mjs";
import { git, loadRecord, buildInventory, rejectSelfDeclaredFlags, contextFor } from "./shared/gov-args.mjs";
import { normalizeAuthority } from "../src/governance/lifecycle-authorization.mjs";
import { readExternalReviewResult } from "../src/governance/external-review.mjs";
import { evaluatePushGate, pushViolationsToHold } from "../src/governance/feature-branch-push-gate.mjs";
import { expandPath } from "../src/governance/change-inventory.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const apply = asBool(flags.apply, false);
const cwd = flags.cwd || process.cwd();
const remote = flags.remote || "origin";

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

// Remote identity check: the remote used for push must resolve to the
// authorized repository. An arbitrary --remote that points elsewhere is
// rejected (fail-closed).
function remoteMatchesAuthorizedRepo(remoteName) {
  let url = "";
  try {
    url = execFileSync("git", ["remote", "get-url", remoteName], { cwd, encoding: "utf8" }).trim();
  } catch { return false; }
  const normalized = url.replace(/\.git$/, "").replace(/^[a-z]+:\/\//, "").replace(/^git@/, "").replace(/:/, "/");
  const repoId = (record.repository || "").replace(/\.git$/, "");
  return repoId.length > 0 && normalized.includes(repoId);
}
if (!remoteMatchesAuthorizedRepo(remote)) {
  console.error("HOLD / REMOTE_NOT_AUTHORIZED");
  console.error(`  - remote "${remote}" does not resolve to authorized repository ${record.repository}`);
  process.exit(1);
}

// Harness-owned result artifact — fixed controller path only.
let result = null;
try {
  result = readExternalReviewResult(cwd);
} catch (e) {
  if (e.code === "HOLD / EXTERNAL_REVIEW_RESULT_MISSING" || e.code === "HOLD / EXTERNAL_REVIEW_RESULT_INVALID") {
    console.error(e.code);
    console.error("  - push requires a verified external-review-result artifact; PENDING is not enough");
    process.exit(1);
  }
  console.error(e.code ?? e.message);
  process.exit(1);
}

const branch = git(["branch", "--show-current"], cwd);
const head = git(["rev-parse", "HEAD"], cwd);

// Recompute current identities.
const inventory = buildInventory(cwd, baseBranch);
const bundlePath = flags.bundlePath
  ? expandPath(flags.bundlePath, cwd)
  : (record.bundle_path ? expandPath(record.bundle_path, cwd) : "");
const current = contextFor({ authority, inventory, bundlePath, cardId, runId, reviewRound, agentIdentity, record });

// remote probe (read-only)
let remoteReachable = false;
let remoteBranchKnown = false;
let remoteHead = null;
try {
  const out = git(["ls-remote", remote, `refs/heads/${branch}`], cwd);
  remoteReachable = true;
  if (out.trim()) { remoteHead = out.split("\t")[0]; remoteBranchKnown = true; }
  else { remoteHead = null; remoteBranchKnown = true; }
} catch {
  remoteReachable = false;
}

let fastForwardOnly = false;
if (remoteHead === null) {
  fastForwardOnly = true;
} else if (remoteHead) {
  try {
    git(["merge-base", "--is-ancestor", remoteHead, head], cwd);
    fastForwardOnly = true;
  } catch {
    fastForwardOnly = false;
  }
}

const upstream = `${remote}/${branch}`;
const gate = evaluatePushGate({
  authority,
  branch,
  remoteBranch: remoteHead ? `${remote}/${branch}` : null,
  remoteReachable,
  remoteBranchKnown,
  upstream,
  fastForwardOnly,
  force: asBool(flags.force, false),
  result,
  current,
  lifecycleState: flags.lifecycleState || "EXTERNAL_REVIEW_PASS",
});

if (!gate.allowed) {
  const err = pushViolationsToHold(gate.violations, !fastForwardOnly || !remoteReachable);
  console.error(err.code);
  for (const v of gate.violations) console.error(`  - ${v}`);
  process.exit(1);
}

if (!apply) {
  console.log(JSON.stringify({ allowed: true, dryRun: true, branch, head, remoteHead, verified: true }, null, 1));
  process.exit(0);
}

execFileSync("git", ["push", remote, `HEAD:${branch}`], { cwd, encoding: "utf8" });
console.log(JSON.stringify({ allowed: true, pushed: true, branch, head }, null, 1));
