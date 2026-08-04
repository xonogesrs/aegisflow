#!/usr/bin/env node
// scripts/gov-draft-pr.mjs
//
// Draft PR lifecycle CLI (§9). One Draft PR per parent card on the same head
// branch. Dry-run by default; pass --apply to create/update via gh CLI.
// Never marks ready; never merges.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs, asBool } from "./shared/gov-args.mjs";
import { decideDraftPrAction, buildDraftPrBody, prViolationsToHold } from "../src/governance/draft-pr-lifecycle.mjs";
import { normalizeAuthority, readLifecycleAuthorization } from "../src/governance/lifecycle-authorization.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const apply = asBool(flags.apply, false);

const authority = flags.execDir
  ? readLifecycleAuthorization(flags.execDir).lifecycle_authorization
  : normalizeAuthority(JSON.parse(readFileSync(flags.authorityFile, "utf8")).lifecycle_authorization);

const repo = flags.repo; // owner/name
const head = flags.head;
const base = flags.base || "main";
const title = flags.title || `Draft: ${flags.cardId || "checkpoint"}`;

// Find existing PR for this head branch (read-only).
let existingPr = null;
let ghAvailable = false;
try {
  const list = execFileSync("gh", ["pr", "list", "--repo", repo, "--head", head, "--state", "open", "--json", "number,title", "--limit", "10"], { encoding: "utf8" });
  ghAvailable = true;
  const prs = JSON.parse(list || "[]");
  existingPr = prs.length > 0 ? prs[0] : null;
} catch {
  ghAvailable = false;
}

const body = flags.bodyFile
  ? readFileSync(flags.bodyFile, "utf8")
  : buildDraftPrBody({
      cardId: flags.cardId || "",
      parentGoal: flags.parentGoal || "",
      currentMilestone: flags.milestone || "",
      completed: (flags.completed || "").split(",").filter(Boolean),
      pending: (flags.pending || "").split(",").filter(Boolean),
      limitations: (flags.limitations || "").split(",").filter(Boolean),
      verificationSummary: flags.verificationSummary || "",
      commitEvidence: (flags.commitEvidence || "").split(",").filter(Boolean),
      evidenceDigests: (flags.evidenceDigests || "").split(",").filter(Boolean),
      irreversibleStatement: flags.irreversibleStatement || "",
    });

const decision = decideDraftPrAction({
  authority,
  existingPrForParent: existingPr !== null,
  headBranch: head,
  baseBranch: base,
  readyForReviewRequested: asBool(flags.readyForReview, false),
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
    ghAvailable,
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
