#!/usr/bin/env node
// scripts/gov-draft-pr.mjs
//
// Draft PR lifecycle CLI (§13). Draft PR is integration record + CI carrier
// ONLY — allowed only in EXTERNAL_REVIEW_PASS / INTEGRATION_READY with a
// verified digest-bound external-review-result artifact. Dry-run by default;
// pass --apply to create/update via gh CLI. Never marks ready, never merges,
// never enables auto-merge. A non-draft PR on the same head is never
// directly updated.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs, asBool } from "./shared/gov-args.mjs";
import { loadRecord, buildInventory, rejectSelfDeclaredFlags, contextFor } from "./shared/gov-args.mjs";
import { normalizeAuthority } from "../src/governance/lifecycle-authorization.mjs";
import { readExternalReviewResult, validateExternalReviewResult } from "../src/governance/external-review.mjs";
import { decideDraftPrAction, buildDraftPrBody, prViolationsToHold } from "../src/governance/draft-pr-lifecycle.mjs";
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

let result = null;
try {
  if (flags.resultFile) {
    const raw = JSON.parse(readFileSync(flags.resultFile, "utf8"));
    if (!validateExternalReviewResult(raw).valid) {
      console.error("HOLD / EXTERNAL_REVIEW_RESULT_INVALID");
      process.exit(1);
    }
    result = raw;
  } else {
    result = readExternalReviewResult(cwd);
  }
} catch (e) {
  if (e.code === "HOLD / EXTERNAL_REVIEW_RESULT_MISSING" || e.code === "HOLD / EXTERNAL_REVIEW_RESULT_INVALID") {
    console.error(e.code);
    console.error("  - Draft PR requires a verified external-review-result artifact; PENDING is not enough");
    process.exit(1);
  }
  console.error(e.code ?? e.message);
  process.exit(1);
}

const repo = flags.repo || result.repository || record.repository || "";
const head = flags.head || result.branch || "";
const base = flags.base || result.base_branch || baseBranch;
const title = flags.title || `Draft: ${cardId || "checkpoint"}`;

// Recompute current identities.
const inventory = buildInventory(cwd, baseBranch);
const bundlePath = flags.bundlePath
  ? expandPath(flags.bundlePath, cwd)
  : (record.bundle_path ? expandPath(record.bundle_path, cwd) : "");
const current = contextFor({ authority, inventory, bundlePath, cardId, runId, reviewRound, agentIdentity, record });

// Find existing PR for this head branch + its draft state (read-only).
let existingPr = null;
let ghAvailable = false;
let prIsDraft = null;
try {
  const list = execFileSync("gh", ["pr", "list", "--repo", repo, "--head", head, "--state", "open", "--json", "number,title,isDraft", "--limit", "10"], { encoding: "utf8" });
  ghAvailable = true;
  const prs = JSON.parse(list || "[]");
  if (prs.length > 0) {
    existingPr = prs[0];
    prIsDraft = existingPr.isDraft === true;
  }
} catch {
  ghAvailable = false;
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
      reviewResultDigest: result.changed_tree_identity,
      bundlePath: bundlePath || flags.bundlePath || "",
    });

const decision = decideDraftPrAction({
  authority,
  result,
  current,
  existingPrForParent: existingPr !== null,
  existingPrDraft: prIsDraft,
  headBranch: head,
  baseBranch: base,
  cardId,
  readyForReviewRequested: asBool(flags.readyForReview, false),
  lifecycleState: flags.lifecycleState || "EXTERNAL_REVIEW_PASS",
});

if (decision.action === "NONE") {
  const err = prViolationsToHold(decision.violations);
  console.error(err ? err.code : "draft_pr: no action");
  for (const v of decision.violations) console.error(`  - ${v}`);
  process.exit(1);
}

if (!apply) {
  console.log(JSON.stringify({
    action: decision.action,
    dryRun: true,
    repo, head, base,
    existingPrNumber: existingPr?.number ?? null,
    existingPrDraft: prIsDraft,
    ghAvailable,
    verified: true,
    bodyPreview: body.slice(0, 400),
  }, null, 1));
  process.exit(0);
}

if (!ghAvailable) {
  console.error("draft_pr: gh CLI unavailable — abort (fail-closed)");
  process.exit(1);
}

let number = existingPr?.number ?? null;
if (decision.action === "CREATE") {
  const out = execFileSync("gh", ["pr", "create", "--repo", repo, "--head", head, "--base", base, "--title", title, "--body", body, "--draft"], { encoding: "utf8" }).trim();
  number = out.split("/").pop();
} else if (decision.action === "UPDATE") {
  execFileSync("gh", ["pr", "edit", String(existingPr.number), "--repo", repo, "--title", title, "--body", body], { encoding: "utf8" });
}

const url = `https://github.com/${repo}/pull/${number}`;
console.log(JSON.stringify({ action: decision.action, applied: true, repo, number, url }, null, 1));
