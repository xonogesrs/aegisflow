#!/usr/bin/env node
// scripts/gov-push-gate.mjs
//
// Feature-branch push gate CLI (§8). Dry-run by default; pass --apply to push.
// Never force-pushes; never auto-rebases; diverged remote → HOLD.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs, asBool } from "./shared/gov-args.mjs";
import { evaluatePushGate, pushViolationsToHold } from "../src/governance/feature-branch-push-gate.mjs";
import { normalizeAuthority, readLifecycleAuthorization } from "../src/governance/lifecycle-authorization.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const { flags } = parseArgs(process.argv.slice(2));
const apply = asBool(flags.apply, false);
const cwd = flags.cwd || process.cwd();
const remote = flags.remote || "origin";

const authority = flags.execDir
  ? readLifecycleAuthorization(flags.execDir).lifecycle_authorization
  : normalizeAuthority(JSON.parse(readFileSync(flags.authorityFile, "utf8")).lifecycle_authorization);

const branch = git(["branch", "--show-current"], cwd);
const head = git(["rev-parse", "HEAD"], cwd);

// remote probe (read-only)
let remoteReachable = false;
let remoteBranchKnown = false;
let remoteHead = null;
try {
  const out = git(["ls-remote", remote, `refs/heads/${branch}`], cwd);
  remoteReachable = true;
  if (out.trim()) { remoteHead = out.split("\t")[0]; remoteBranchKnown = true; }
  else { remoteHead = null; remoteBranchKnown = true; } // branch absent remotely
} catch {
  remoteReachable = false;
}

// fast-forward check: local must be ancestor of remote (or remote empty)
let fastForwardOnly = false;
if (remoteHead === null) {
  fastForwardOnly = true; // new branch — nothing to diverge from
} else if (remoteHead) {
  try {
    const isAncestor = git(["merge-base", "--is-ancestor", remoteHead, head], cwd);
    fastForwardOnly = isAncestor === "" || isAncestor === undefined; // exit 0
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
  commitIdentity: head,
  reviewedArtifactIdentity: flags.reviewedArtifactIdentity || head,
});

if (!gate.allowed) {
  const err = pushViolationsToHold(gate.violations, !fastForwardOnly || !remoteReachable);
  console.error(err.code);
  for (const v of gate.violations) console.error(`  - ${v}`);
  process.exit(1);
}

if (!apply) {
  console.log(JSON.stringify({ allowed: true, dryRun: true, branch, head, remoteHead }, null, 1));
  process.exit(0);
}

git(["push", remote, `HEAD:${branch}`], cwd);
console.log(JSON.stringify({ allowed: true, pushed: true, branch, head }, null, 1));
