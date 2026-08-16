#!/usr/bin/env node
// scripts/gov-draft-pr.mjs
//
// Draft PR lifecycle CLI (§13) — PGMA1 canonical authority migration.
// Draft PR is integration record + CI carrier ONLY — allowed only when the
// CANONICAL promotion authority holds (review-job ACCEPTED + delivery verdict
// PASS bound to the delivered bundle digest + recomputed candidate identity
// match + reviewed HEAD == local HEAD == remote HEAD). The RC1A-retired
// `external-review-result.json` is NEVER read; its presence grants nothing.
//
// Idempotent read-only reconciliation: when an existing PR on the reviewed
// branch already binds the canonical identity (card id, bundle identity +
// digest, changed-tree identity, reviewed head), the gate returns
// `PASS / DRAFT_PR_ALREADY_SATISFIED` without creating/updating anything.
//
// Dry-run by default; pass --apply to create/update via gh CLI. Never marks
// ready, never merges, never enables auto-merge. A non-draft PR on the same
// head is never directly updated.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, asBool } from "./shared/gov-args.mjs";
import { loadRecord, buildInventory, rejectSelfDeclaredFlags, assertLiveBindings, assertScopeCoversInventory } from "./shared/gov-args.mjs";
import { normalizeAuthority } from "../src/governance/lifecycle-authorization.mjs";
import { buildChangeInventory } from "../src/governance/change-inventory.mjs";
import { candidateDomain } from "../src/governance/candidate-domain-policy.mjs";
import { readReviewJobEvidence, readDeliveryEvidence, verifyDeliveryBundleDigest, evaluatePromotionAuthority } from "../src/governance/promotion-authority.mjs";
import { buildDraftPrBody, prBoundToParentCard } from "../src/governance/draft-pr-lifecycle.mjs";

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

function defaultSurfaceDir() {
  return join(homedir(), "Desktop", "AutoLoop-Review", "Current");
}

/**
 * Canonical PR binding check (PGMA1): the existing PR body must reference the
 * card id, the current bundle identity + sha256, the changed-tree identity
 * and the reviewed head — the same canonical identity the gates verify.
 */
export function prBoundToCanonicalIdentity({ body, reviewJob, delivery, bundleSha256 }) {
  const text = String(body ?? "");
  const ci = reviewJob.candidateIdentity;
  const d = delivery.delivery;
  return (
    text.includes(reviewJob.lineageId) &&
    text.includes(d.reviewBundleIdentity) &&
    text.includes(bundleSha256) &&
    text.includes(ci.changedTreeIdentity) &&
    text.includes(ci.currentHead)
  );
}

/**
 * Run the draft-PR lifecycle gate.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] — CLI-style argv.
 * @param {string} [opts.cwd] — repository worktree (--cwd / process.cwd()).
 * @param {string} [opts.surfaceDir] — external review surface
 *   (--surface / ~/Desktop/AutoLoop-Review/Current).
 * @returns {object} the report (also printed to stdout for the CLI).
 */
export function runDraftPr({ argv, cwd, surfaceDir } = {}) {
  const { flags } = parseArgs(argv ?? process.argv.slice(2));
  const apply = asBool(flags.apply, false);
  const cwdActual = cwd || flags.cwd || process.cwd();
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

  // Candidate-domain inventory (E1-A) — same path set the review-job bound.
  const inventory = buildChangeInventory({ git: (args) => execFileSync("git", args, { cwd: cwdActual, encoding: "utf8" }), cwd: cwdActual, baseBranch, candidateDomain });
  try {
    assertLiveBindings({ record, cwd: cwdActual, inventory, baseBranch, cardId, runId, flags });
  } catch (e) {
    console.error(e.code ?? e.message);
    console.error(`  - ${e.message}`);
    process.exit(1);
  }

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

  const remoteName = flags.remote || "origin";
  let remoteReachable = false;
  let remoteHead = null;
  try {
    const out = execFileSync("git", ["ls-remote", remoteName, `refs/heads/${inventory.branch}`], { cwd: cwdActual, encoding: "utf8" });
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
      execFileSync("git", ["merge-base", "--is-ancestor", remoteHead, inventory.head], { cwd: cwdActual, encoding: "utf8" });
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
  // Draft PR is a post-push integration record: the reviewed head must be on
  // the remote (already satisfied) — a PR against a not-yet-pushed head would
  // bind the wrong remote state.
  if (evalResult.status !== "PROMOTION_ALREADY_SATISFIED") {
    fail("HOLD / PR_REQUIRES_REMOTE_EXACT_HEAD", `draft PR requires reviewed HEAD on the remote; push first (status ${evalResult.status})`);
  }

  // Repository/branch identity comes ONLY from the canonical evidence.
  const repo = rj.record.candidateIdentity.repository || "";
  if (flags.repo && flags.repo !== repo) {
    console.error("HOLD / CLI_OVERRIDE_REJECTED");
    console.error(`  - --repo ${flags.repo} != reviewed repository ${repo}`);
    process.exit(1);
  }
  if (authority.repository && repo && authority.repository !== repo) {
    console.error("HOLD / CLI_OVERRIDE_REJECTED");
    console.error(`  - reviewed repository ${repo} != authority ${authority.repository}`);
    process.exit(1);
  }
  const head = rj.record.candidateIdentity.branch || "";
  const base = authority.draft_pr?.base_branch || baseBranch;
  const title = flags.title || `Draft: ${cardId || "checkpoint"}`;

  // Find existing PR for this head branch (read-only).
  let existingPr = null;
  let prIsDraft = null;
  let existingPrBound = false;
  let ghAvailable = false;
  try {
    const list = execFileSync("gh", ["pr", "list", "--repo", repo, "--head", head, "--state", "open", "--json", "number,title,isDraft,body", "--limit", "10"], { encoding: "utf8" });
    ghAvailable = true;
    const prs = JSON.parse(list || "[]");
    if (prs.length > 0) {
      existingPr = prs[0];
      prIsDraft = existingPr.isDraft === true;
      existingPrBound = prBoundToCanonicalIdentity({ body: existingPr.body, reviewJob: rj.record, delivery: dl.record, bundleSha256: bd.sha256 });
    }
  } catch {
    ghAvailable = false;
  }

  // Idempotent read-only reconciliation: existing PR already binds the full
  // canonical identity → nothing to create/update.
  if (existingPr !== null && existingPrBound) {
    const report = {
      allowed: true,
      alreadySatisfied: true,
      status: "DRAFT_PR_ALREADY_SATISFIED",
      identity: evalResult.identity,
      repo,
      number: existingPr.number,
      url: `https://github.com/${repo}/pull/${existingPr.number}`,
      head,
    };
    console.log(JSON.stringify(report, null, 1));
    return report;
  }
  if (existingPr !== null && !existingPrBound) {
    console.error("HOLD / PR_NOT_BOUND_TO_PARENT_CARD");
    console.error(`  - existing PR #${existingPr.number} on head ${head} is not bound to the canonical identity (card id / bundle identity+digest / changed-tree identity / reviewed head)`);
    process.exit(1);
  }

  // Writable path (CREATE only — an existing bound PR never reaches here):
  // writable-scope gate over the candidate domain.
  try {
    assertScopeCoversInventory(inventory, record.authorized_paths || []);
  } catch (e) {
    console.error(e.code ?? e.message);
    console.error(`  - ${e.message}`);
    process.exit(1);
  }

  const body = flags.bodyFile
    ? readFileSync(flags.bodyFile, "utf8")
    : buildDraftPrBody({
        cardId,
        runId,
        parentGoal: flags.parentGoal || "",
        currentMilestone: flags.milestone || "",
        completed: (flags.completed || "").split(",").filter(Boolean),
        pending: (flags.pending || "").split(",").filter(Boolean),
        limitations: (flags.limitations || "").split(",").filter(Boolean),
        verificationSummary: flags.verificationSummary || "",
        commitEvidence: (flags.commitEvidence || "").split(",").filter(Boolean),
        evidenceDigests: (flags.evidenceDigests || "").split(",").filter(Boolean),
        irreversibleStatement: flags.irreversibleStatement || "",
        reviewResultDigest: rj.record.candidateIdentity.changedTreeIdentity,
        bundlePath: flags.bundlePath || "",
      });

  // The FINAL body must be bound to the parent card for CREATE (round 3
  // finding 6).
  if (!prBoundToParentCard({ body, cardId, reviewResultDigest: rj.record.candidateIdentity.changedTreeIdentity })) {
    console.error("HOLD / PR_NOT_BOUND_TO_PARENT_CARD");
    console.error(`  - final PR body is not bound to card ${cardId} (missing card id / review-result digest)`);
    process.exit(1);
  }

  // Canonical draft-PR decision (PGMA1). The promotion authority has already
  // verified the full chain (review-job ACCEPTED + delivery PASS + recomputed
  // candidate identity + exact remote head); the decision here is ONLY the
  // authority caps + existing-PR state. The legacy decideDraftPrAction (built
  // for the retired external-review-result artifact) is not used — an
  // existing PR is either fully bound (already satisfied) or unbound (HOLD,
  // controller reconciliation — never silent auto-update).
  const cap = authority.draft_pr ?? { allowed: false };
  const decisionViolations = [];
  if (cap.allowed !== true) decisionViolations.push("draft_pr.allowed is false (fail-closed)");
  if (cap.draft_only !== true) decisionViolations.push("draft_pr.draft_only must be true");
  if (asBool(flags.readyForReview, false)) decisionViolations.push("draft_pr: ready-for-review must not be requested automatically");
  if (!["EXTERNAL_REVIEW_PASS", "INTEGRATION_READY"].includes(flags.lifecycleState || "EXTERNAL_REVIEW_PASS")) {
    decisionViolations.push(`lifecycle_state: Draft PR requires EXTERNAL_REVIEW_PASS/INTEGRATION_READY, state is ${flags.lifecycleState || "EXTERNAL_REVIEW_PASS"}`);
  }
  const authorizedBase = cap.base_branch ?? "";
  if (authorizedBase && base !== authorizedBase) decisionViolations.push(`draft_pr.base_branch mismatch: ${base} != ${authorizedBase}`);
  if (!head) decisionViolations.push("draft_pr.head_branch missing");
  if (decisionViolations.length > 0) {
    console.error("HOLD / DRAFT_PR_VIOLATION");
    for (const v of decisionViolations) console.error(`  - ${v}`);
    process.exit(1);
  }
  if (cap.create_if_missing !== true) {
    console.error("HOLD / DRAFT_PR_CREATE_NOT_AUTHORIZED");
    console.error("  - draft_pr.create_if_missing must be true to create (existing PRs are only ever reconciled by the controller)");
    process.exit(1);
  }
  const action = "CREATE";

  if (!apply) {
    console.log(JSON.stringify({
      action,
      dryRun: true,
      repo, head, base,
      existingPrNumber: existingPr?.number ?? null,
      ghAvailable,
      verified: true,
      identity: evalResult.identity,
      bodyPreview: body.slice(0, 400),
    }, null, 1));
    process.exit(0);
  }

  if (!ghAvailable) {
    console.error("draft_pr: gh CLI unavailable — abort (fail-closed)");
    process.exit(1);
  }

  let number = existingPr?.number ?? null;
  if (action === "CREATE") {
    const out = execFileSync("gh", ["pr", "create", "--repo", repo, "--head", head, "--base", base, "--title", title, "--body", body, "--draft"], { encoding: "utf8" }).trim();
    number = out.split("/").pop();
  }

  const url = `https://github.com/${repo}/pull/${number}`;
  console.log(JSON.stringify({ action: decision.action, applied: true, repo, number, url }, null, 1));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    runDraftPr({});
  } catch (e) {
    if (e && e.code) {
      console.error(e.code);
      console.error(`  - ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
