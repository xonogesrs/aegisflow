#!/usr/bin/env node
// scripts/gov-push-gate.mjs
//
// Feature-branch push gate (§8/§13) — PGMA1 canonical authority migration.
// Push is only allowed when the CANONICAL promotion authority holds:
//
//   review-job ACCEPTED
//   + delivery verdict PASS bound to the delivered bundle digest
//   + recomputed candidate identity == review-job candidate identity
//   + reviewed HEAD == local HEAD == remote HEAD
//     (or remote behind → pure fast-forward)
//
// The RC1A-retired `external-review-result.json` is NEVER read; its presence
// grants nothing (RC1A §7.2). Dry-run by default; pass --apply to push.
// Never force-pushes; never auto-rebases; diverged remote → HOLD.
//
// `--external-review-status PASS` / `--reviewed-artifact-identity` are
// REJECTED (self-declared / caller-supplied authority).
//
// Remote authorization (round 4 finding 2): production accepts ONLY the
// three canonical GitHub forms for the authorized repository (see
// productionRemoteMatch). Local bare remotes are allowed ONLY through a
// test-only adapter injected via the library API (runPushGate's
// `remotePolicy`) — never through a production CLI flag.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, asBool } from "./shared/gov-args.mjs";
import { git, loadRecord, rejectSelfDeclaredFlags, assertLiveBindings, assertScopeCoversInventory, productionRemoteMatch } from "./shared/gov-args.mjs";
import { normalizeAuthority } from "../src/governance/lifecycle-authorization.mjs";
import { buildChangeInventory } from "../src/governance/change-inventory.mjs";
import { candidateDomain } from "../src/governance/candidate-domain-policy.mjs";
import { readReviewJobEvidence, readDeliveryEvidence, verifyDeliveryBundleDigest, evaluatePromotionAuthority } from "../src/governance/promotion-authority.mjs";

/** Fail-closed: throw a hold-coded error. The CLI main converts it to exit(1);
 * library callers (tests) catch it and read `e.code` / `e.message`. */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

function defaultSurfaceDir() {
  return join(homedir(), "Desktop", "AutoLoop-Review", "Current");
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
 * @param {string} [opts.surfaceDir] — external review surface (defaults to
 *   --surface / AEGISFLOW_REVIEW_SURFACE).
 * @param {string} [opts.remote] — remote name (defaults to --remote / origin).
 * @param {Function} [opts.remotePolicy] — remote-URL authorizer
 *   (url, repoId) => boolean. Production ALWAYS uses productionRemoteMatch
 *   (strict GitHub-only). Tests inject a test-only adapter (local bare
 *   remotes) through this parameter — internal dependency injection only.
 * @returns {object} the push report (also printed to stdout for the CLI).
 */
export function runPushGate({ argv, flags: flagsIn, cwd, surfaceDir, remote, remotePolicy = productionRemoteMatch } = {}) {
  const { flags } = flagsIn ? { flags: flagsIn } : parseArgs(argv ?? process.argv.slice(2));
  const apply = asBool(flags.apply, false);
  const cwdActual = cwd || flags.cwd || process.cwd();
  const remoteName = remote || flags.remote || "origin";
  const surface = surfaceDir || flags.surface || defaultSurfaceDir();

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

  // Candidate-domain inventory (E1-A): harness-owned governance outputs under
  // docs/pi-graph-output/ are excluded, so the recomputed identity covers the
  // SAME path set the review-job bound — never the post-review lifecycle
  // artifacts. Writable-scope enforcement uses this same candidate domain.
  const inventory = buildChangeInventory({ git: (args) => git(args, cwdActual), cwd: cwdActual, baseBranch, candidateDomain });
  assertLiveBindings({ record, cwd: cwdActual, inventory, baseBranch, cardId, runId, flags });

  // ── Canonical promotion authority (PGMA1) — fail-closed evidence chain. ──
  const rj = readReviewJobEvidence(cardId, { cwd: cwdActual });
  if (!rj.ok) fail(rj.code, rj.errors.join("; "));
  const dl = readDeliveryEvidence(surface);
  if (!dl.ok) fail(dl.code, dl.errors.join("; "));
  const bd = verifyDeliveryBundleDigest(surface, {
    expectedSha256: dl.record.delivery.reviewBundleSha256,
    expectedIdentity: dl.record.delivery.reviewBundleIdentity,
  });
  if (!bd.ok) fail(bd.code, bd.errors.join("; "));

  // Remote probe (read-only).
  let remoteReachable = false;
  let remoteHead = null;
  try {
    const out = git(["ls-remote", remoteName, `refs/heads/${inventory.branch}`], cwdActual);
    remoteReachable = true;
    if (out.trim()) remoteHead = out.split("\t")[0];
  } catch {
    remoteReachable = false;
  }

  let fastForwardOnly = false;
  if (remoteHead === null) {
    fastForwardOnly = true;
  } else if (remoteHead) {
    try {
      git(["merge-base", "--is-ancestor", remoteHead, inventory.head], cwdActual);
      fastForwardOnly = true;
    } catch {
      fastForwardOnly = false;
    }
  }

  const evalResult = evaluatePromotionAuthority({
    reviewJob: rj.record,
    delivery: dl.record,
    bundleSha256: bd.sha256,
    inventory,
    localHead: inventory.head,
    remoteHead,
    remoteReachable,
    fastForwardOnly,
  });
  if (!evalResult.allowed) {
    const code = evalResult.violations[0]?.split(":")[0] ?? "HOLD / PROMOTION_AUTHORITY_DENIED";
    fail(code, evalResult.violations.join("; "));
  }

  // Idempotent read-only outcome: the remote already holds exactly the
  // reviewed head. No push, no writable-scope gate (nothing is mutated).
  if (evalResult.status === "PROMOTION_ALREADY_SATISFIED") {
    const report = {
      allowed: true,
      alreadySatisfied: true,
      status: evalResult.status,
      identity: evalResult.identity,
      branch: inventory.branch,
      head: inventory.head,
      remoteHead,
    };
    console.log(JSON.stringify(report, null, 1));
    return report;
  }

  // AUTHORIZED: a real (fast-forward) push is required — the writable-scope
  // gate runs over the candidate domain before any mutation.
  assertScopeCoversInventory(inventory, record.authorized_paths || []);
  if (!fastForwardOnly) {
    fail("HOLD / REMOTE_BRANCH_DIVERGED", `remote ${remoteName}/${inventory.branch} ${remoteHead} is not an ancestor of ${inventory.head}`);
  }

  if (!apply) {
    const report = {
      allowed: true,
      dryRun: true,
      status: evalResult.status,
      identity: evalResult.identity,
      branch: inventory.branch,
      head: inventory.head,
      remoteHead,
      verified: true,
    };
    console.log(JSON.stringify(report, null, 1));
    return report;
  }

  execFileSync("git", ["push", remoteName, `HEAD:${inventory.branch}`], { cwd: cwdActual, encoding: "utf8" });
  const report = { allowed: true, pushed: true, status: evalResult.status, identity: evalResult.identity, branch: inventory.branch, head: inventory.head };
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
