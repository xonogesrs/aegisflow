#!/usr/bin/env node
// scripts/gov-controller-prepare-round.mjs
//
// CONTROLLER-ONLY entry (round 3 finding 4/5): starts a new external review
// round by writing the persistent review-history artifact. The review round,
// accumulated repair round, prior bundle digest (computed from the archived
// previous bundle) and prior findings (Controller-provided) are recorded
// HERE — the agent production path has no writer for this artifact.
//
// Round 5 finding: the repair budget is NOT a free input. The canonical
// repair cap is derived from the authority record:
//
//   effective_repair_cap = min(
//     bounded_repair.max_rounds,
//     review_unit.maximum_repair_rounds
//   )
//
// prepare-round reads and validates the authority record
// (--authority-file), rejects any --max-repair-rounds override, rejects a
// self-contradictory record (finite caps that differ), and refuses to write
// history whose repair round exceeds the effective cap.
//
//   --bundle-dir      fixed bundle directory (default: the review surface)
//   --authority-file  the card's authority record (REQUIRED; source of the cap)
//   --card-id         parent card id
//   --findings-file   the PREVIOUS round's findings text (Controller input)
//   --review-round    the round being prepared (e.g. 3)
//   --repair-round    accumulated repair rounds (e.g. 2)
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
import { effectiveRepairCap, repairCapConflict, validateAuthorityRecord } from "../src/governance/lifecycle-authorization.mjs";
import { GOV_HOLD } from "../src/governance/holds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

const { flags } = parseArgs(process.argv.slice(2));
const bundleDir = flags.bundleDir ? resolve(flags.bundleDir) : join(homedir(), "Desktop", "AutoLoop-Review");
const cardId = flags.cardId || "UNKNOWN-CARD";
const reviewRound = Number.isInteger(Number(flags.reviewRound)) ? Number(flags.reviewRound) : 1;
const repairRound = Number.isInteger(Number(flags.repairRound)) ? Number(flags.repairRound) : 0;

// Round 5 finding: the repair cap must come from the actual authority
// record — a free --max-repair-rounds input cannot expand authorization.
if (flags.maxRepairRounds !== undefined) {
  fail(GOV_HOLD.REVIEW_HISTORY_INVALID,
    "--max-repair-rounds is NOT accepted: the repair cap is derived from the authority record (effective_repair_cap = min(bounded_repair.max_rounds, review_unit.maximum_repair_rounds))");
}
if (!flags.authorityFile) {
  fail(GOV_HOLD.REVIEW_HISTORY_INVALID, "--authority-file required: the repair cap must be derived from the authority record");
}
const raw = JSON.parse(readFileSync(flags.authorityFile, "utf8"));
const check = validateAuthorityRecord(raw);
if (!check.valid) {
  fail(GOV_HOLD.AUTHORIZATION_INVALID, check.errors.join("; "));
}
const authorityBlock = raw.lifecycle_authorization ?? raw;
const effectiveCap = effectiveRepairCap(authorityBlock);
const conflict = repairCapConflict(authorityBlock);
if (conflict) {
  fail(GOV_HOLD.REVIEW_HISTORY_INVALID, `repair_cap_authority_conflict: ${conflict}`);
}
if (repairRound > effectiveCap) {
  fail(GOV_HOLD.REVIEW_HISTORY_INVALID,
    `repair round ${repairRound} exceeds effective repair cap ${effectiveCap} (min of bounded_repair.max_rounds ${authorityBlock?.bounded_repair?.max_rounds ?? "∞"} and review_unit.maximum_repair_rounds ${authorityBlock?.review_unit?.maximum_repair_rounds ?? "∞"})`);
}

if (!flags.findingsFile) {
  console.error("--findings-file required (previous round findings text)");
  process.exit(2);
}
const priorFindingsText = readFileSync(flags.findingsFile, "utf8");
const priorFindingsDigest = sha256Text(priorFindingsText);

// Derive prior bundle digest from the archived bundle for this card.
// R-14: selection is DIGEST-VERIFIED, never filename order — the archived
// artifact must recompute to a self-consistent REVIEW_BUNDLE_SHA256 footer
// (bundleDigestFromFile recomputes over the footer-excluded content), and
// the newest VALID candidate wins. A stale/tampered earlier filename can
// never bind merely because it sorts last.
const archiveDir = join(bundleDir, "archive");
let priorBundleSha256 = "";
try {
  const files = readdirSync(archiveDir).filter((f) => f.includes(cardId) && f.endsWith(".txt")).sort();
  const candidates = [];
  for (const f of files) {
    try {
      const text = readFileSync(join(archiveDir, f), "utf8");
      const stated = text.split("\n").reverse().find((l) => l.startsWith("BUNDLE_SHA256"))?.split(":").slice(1).join(":").trim() ?? null;
      const recomputed = bundleDigestFromFile(text);
      // a self-consistent artifact only: the footer must match the recompute
      if (stated && stated === recomputed) candidates.push({ f, digest: recomputed });
    } catch { /* unreadable candidate — never selected */ }
  }
  if (candidates.length > 0) {
    // newest valid representation by filename (dates sort chronologically);
    // the digest itself is verified, so ordering only breaks ties between
    // distinct valid generations.
    priorBundleSha256 = candidates[candidates.length - 1].digest;
  }
} catch { /* archive unreadable → empty prior */ }
if (reviewRound > 1 && !priorBundleSha256) {
  fail(GOV_HOLD.REVIEW_HISTORY_INVALID, `cannot derive prior bundle digest for round ${reviewRound} (no archived bundle for ${cardId})`);
}

const remainingBudget = Math.max(0, effectiveCap - repairRound);
const history = {
  schema: "autoloop.review-history/v1",
  card_id: cardId,
  review_round: reviewRound,
  repair_round: repairRound,
  prior_bundle_sha256: priorBundleSha256,
  prior_findings_digest: priorFindingsDigest,
  prior_findings_text: priorFindingsText,
  effective_repair_cap: effectiveCap,
  remaining_budget: remainingBudget,
  updated_at: new Date().toISOString(),
};
const historyCheck = validateReviewHistory(history);
if (!historyCheck.valid) {
  fail(GOV_HOLD.REVIEW_HISTORY_INVALID, historyCheck.errors.join(","));
}

mkdirSync(join(bundleDir, "governance"), { recursive: true });
writeFileSync(reviewHistoryPath(bundleDir), JSON.stringify(history, null, 2));
console.log(JSON.stringify({ history_written: reviewHistoryPath(bundleDir), review_round: reviewRound, repair_round: repairRound, effective_repair_cap: effectiveCap, prior_bundle_sha256: priorBundleSha256, prior_findings_digest: priorFindingsDigest, remaining_budget: remainingBudget }, null, 1));
