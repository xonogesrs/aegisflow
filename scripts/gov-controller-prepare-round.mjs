#!/usr/bin/env node
// scripts/gov-controller-prepare-round.mjs
//
// CONTROLLER-ONLY entry (round 3 finding 4/5): starts a new external review
// round by writing the persistent review-history artifact. The review round,
// accumulated repair round, prior bundle digest (computed from the archived
// previous bundle) and prior findings (Controller-provided) are recorded
// HERE — the agent production path has no writer for this artifact.
//
//   --bundle-dir      fixed bundle directory (default ~/Desktop/AutoLoop-Review)
//   --card-id         parent card id
//   --findings-file   the PREVIOUS round's findings text (Controller input)
//   --review-round    the round being prepared (e.g. 3)
//   --repair-round    accumulated repair rounds (e.g. 2)
//   --max-repair-rounds  review-unit cap (default 2)
//
// Derives prior_bundle_sha256 from the latest archived bundle for the card.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./shared/gov-args.mjs";
import { bundleDigestFromFile } from "../src/governance/review-context.mjs";
import { sha256Text } from "../src/evidence/run-evidence-store.mjs";
import { validateReviewHistory, reviewHistoryPath } from "../src/governance/review-history.mjs";
import { GOV_HOLD } from "../src/governance/holds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const { flags } = parseArgs(process.argv.slice(2));
const bundleDir = flags.bundleDir ? resolve(flags.bundleDir) : join(homedir(), "Desktop", "AutoLoop-Review");
const cardId = flags.cardId || "UNKNOWN-CARD";
const reviewRound = Number.isInteger(Number(flags.reviewRound)) ? Number(flags.reviewRound) : 1;
const repairRound = Number.isInteger(Number(flags.repairRound)) ? Number(flags.repairRound) : 0;
const maxRepair = Number.isInteger(Number(flags.maxRepairRounds)) ? Number(flags.maxRepairRounds) : 2;

if (!flags.findingsFile) {
  console.error("--findings-file required (previous round findings text)");
  process.exit(2);
}
const priorFindingsText = readFileSync(flags.findingsFile, "utf8");
const priorFindingsDigest = sha256Text(priorFindingsText);

// Derive prior bundle digest from the latest archived bundle for this card.
const archiveDir = join(bundleDir, "archive");
let priorBundleSha256 = "";
try {
  const files = readdirSync(archiveDir).filter((f) => f.includes(cardId) && f.endsWith(".txt")).sort();
  if (files.length > 0) {
    priorBundleSha256 = bundleDigestFromFile(readFileSync(join(archiveDir, files[files.length - 1]), "utf8"));
  }
} catch { /* archive unreadable → empty prior */ }
if (reviewRound > 1 && !priorBundleSha256) {
  console.error(GOV_HOLD.REVIEW_HISTORY_INVALID);
  console.error(`  - cannot derive prior bundle digest for round ${reviewRound} (no archived bundle for ${cardId})`);
  process.exit(1);
}

const remainingBudget = Math.max(0, maxRepair - repairRound);
const history = {
  schema: "autoloop.review-history/v1",
  card_id: cardId,
  review_round: reviewRound,
  repair_round: repairRound,
  prior_bundle_sha256: priorBundleSha256,
  prior_findings_digest: priorFindingsDigest,
  prior_findings_text: priorFindingsText,
  remaining_budget: remainingBudget,
  updated_at: new Date().toISOString(),
};
const check = validateReviewHistory(history);
if (!check.valid) {
  console.error(GOV_HOLD.REVIEW_HISTORY_INVALID);
  for (const e of check.errors) console.error(`  - ${e}`);
  process.exit(1);
}

mkdirSync(join(bundleDir, "governance"), { recursive: true });
writeFileSync(reviewHistoryPath(bundleDir), JSON.stringify(history, null, 2));
console.log(JSON.stringify({ history_written: reviewHistoryPath(bundleDir), review_round: reviewRound, repair_round: repairRound, prior_bundle_sha256: priorBundleSha256, prior_findings_digest: priorFindingsDigest, remaining_budget: remainingBudget }, null, 1));
