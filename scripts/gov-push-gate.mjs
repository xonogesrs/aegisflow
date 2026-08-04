#!/usr/bin/env node
// scripts/gov-push-gate.mjs
//
// Feature-branch push gate CLI (§8/§13). Push is only allowed after a
// *verified* external review PASS backed by the harness-owned
// external-review-result.json. Dry-run by default; pass --apply to push.
// Never force-pushes; never auto-rebases; diverged remote → HOLD.
// `--external-review-status PASS` / `--reviewed-artifact-identity` are
// REJECTED (self-declared / caller-supplied authority).
//
// Remote authorization (round 4 finding 2): production accepts ONLY the
// three canonical GitHub forms for the authorized repository (see
// productionRemoteMatch). Local bare remotes are allowed ONLY through a
// test-only adapter injected via the library API (runPushGate's
// `remotePolicy`) — never through a production CLI flag.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, asBool } from "./shared/gov-args.mjs";
import { git, loadRecord, buildInventory, rejectSelfDeclaredFlags, contextFor, assertLiveBindings, assertScopeCoversInventory, productionRemoteMatch } from "./shared/gov-args.mjs";
import { normalizeAuthority } from "../src/governance/lifecycle-authorization.mjs";
import { readExternalReviewResult } from "../src/governance/external-review.mjs";
import { evaluatePushGate, pushViolationsToHold } from "../src/governance/feature-branch-push-gate.mjs";
import { expandPath } from "../src/governance/change-inventory.mjs";

/** Fail-closed: throw a hold-coded error. The CLI main converts it to exit(1);
 * library callers (tests) catch it and read `e.code` / `e.message`. */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

/**
 * Run the feature-branch push gate.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] — CLI-style argv (defaults to process.argv
 *   when run as the CLI).
 * @param {object} [opts.flags] — pre-parsed flags (alternative to argv).
 * @param {string} [opts.cwd] — repository worktree (defaults to --cwd /
 *   process.cwd()).
 * @param {string} [opts.remote] — remote name (defaults to --remote / origin).
 * @param {Function} [opts.remotePolicy] — remote-URL authorizer
 *   (url, repoId) => boolean. Production ALWAYS uses productionRemoteMatch
 *   (strict GitHub-only). Tests inject a test-only adapter (local bare
 *   remotes) through this parameter — internal dependency injection only.
 * @returns {object} the push report (also printed to stdout for the CLI).
 */
export function runPushGate({ argv, flags: flagsIn, cwd, remote, remotePolicy = productionRemoteMatch } = {}) {
  const { flags } = flagsIn ? { flags: flagsIn } : parseArgs(argv ?? process.argv.slice(2));
  const apply = asBool(flags.apply, false);
  const cwdActual = cwd || flags.cwd || process.cwd();
  const remoteName = remote || flags.remote || "origin";

  const selfDeclared = rejectSelfDeclaredFlags(flags);
  if (selfDeclared.length > 0) {
    fail("HOLD / RESULT_SELF_DECLARATION_REJECTED", selfDeclared.join("; "));
  }

  const record = loadRecord(flags);
  const authority = normalizeAuthority(record.lifecycle_authorization);
  const baseBranch = record.base || authority.base || "main";
  // card/run identity come ONLY from the record — flag overrides are rejected
  // by assertLiveBindings.
  const cardId = record.card_id || "";
  const runId = record.run_id || "";
  const agentIdentity = flags.agent || "pi-deepseek-v4-flash";

  // Remote identity check: the remote used for push must resolve to the
  // authorized repository under the ACTIVE remote policy. Production policy
  // is strict GitHub-only (substring/local-path matches are rejected).
  function remoteMatchesAuthorizedRepo(name) {
    let url = "";
    try {
      url = execFileSync("git", ["remote", "get-url", name], { cwd: cwdActual, encoding: "utf8" }).trim();
    } catch { return false; }
    return remotePolicy(url, record.repository);
  }
  if (!remoteMatchesAuthorizedRepo(remoteName)) {
    fail("HOLD / REMOTE_NOT_AUTHORIZED", `remote "${remoteName}" does not resolve to authorized repository ${record.repository}`);
  }

  // Recompute current identities + bind the live environment to the record.
  const inventory = buildInventory(cwdActual, baseBranch);
  assertLiveBindings({ record, cwd: cwdActual, inventory, baseBranch, cardId, runId, flags });
  assertScopeCoversInventory(inventory, record.authorized_paths || []);
  const bundlePath = flags.bundlePath
    ? expandPath(flags.bundlePath, cwdActual)
    : (record.bundle_path ? expandPath(record.bundle_path, cwdActual) : "");

  // Harness-owned result artifact — fixed controller path derived from the
  // bundle directory (outside the executor writable scope), never --result-file.
  const bundleDir = bundlePath ? dirname(bundlePath) : "";
  let result = null;
  try {
    result = bundleDir ? readExternalReviewResult(bundleDir) : null;
  } catch (e) {
    if (e.code === "HOLD / EXTERNAL_REVIEW_RESULT_MISSING" || e.code === "HOLD / EXTERNAL_REVIEW_RESULT_INVALID") {
      fail(e.code, e.message);
    }
    fail(e.code ?? e.message, e.message);
  }
  // review round comes from the verified artifact, never from CLI flags
  const reviewRound = result ? result.review_round : 1;
  const current = contextFor({ authority, inventory, bundlePath, cardId, runId, reviewRound, agentIdentity, record });

  const branch = inventory.branch;
  const head = inventory.head;

  // remote probe (read-only)
  let remoteReachable = false;
  let remoteBranchKnown = false;
  let remoteHead = null;
  try {
    const out = git(["ls-remote", remoteName, `refs/heads/${branch}`], cwdActual);
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
      git(["merge-base", "--is-ancestor", remoteHead, head], cwdActual);
      fastForwardOnly = true;
    } catch {
      fastForwardOnly = false;
    }
  }

  const upstream = `${remoteName}/${branch}`;
  const gate = evaluatePushGate({
    authority,
    branch,
    remoteBranch: remoteHead ? `${remoteName}/${branch}` : null,
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
    fail(err.code, gate.violations.join("; "));
  }

  if (!apply) {
    const report = { allowed: true, dryRun: true, branch, head, remoteHead, verified: true };
    console.log(JSON.stringify(report, null, 1));
    return report;
  }

  execFileSync("git", ["push", remoteName, `HEAD:${branch}`], { cwd: cwdActual, encoding: "utf8" });
  const report = { allowed: true, pushed: true, branch, head };
  console.log(JSON.stringify(report, null, 1));
  return report;
}

// ── CLI main: production ALWAYS uses the strict GitHub-only remote policy. ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    runPushGate({});
  } catch (e) {
    if (e && e.code) {
      console.error(e.code);
      console.error(`  - ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
