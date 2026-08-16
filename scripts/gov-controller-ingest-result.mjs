#!/usr/bin/env node
// scripts/gov-controller-ingest-result.mjs
//
// CONTROLLER-ONLY entry (round 3 finding 5): the single writer of the
// external-review result artifact. The Controller runs this after the
// external reviewer delivers a verdict; the artifact is created with
// exclusive-create (never overwritten) at
// <bundle-dir>/governance/external-review-result.json — OUTSIDE the executor
// writable scope. All identities are COMPUTED from the actual bundle file
// (bundle digest) and parsed from the bundle text (patch / changed-tree);
// none are accepted from the executor.
//
// Honest limitation (finding 5): this guards against NON-DELIBERATE
// self-declaration by the executor. Full provenance still requires the
// Controller to guard this ingestion entry (reviewer_identity and
// authorization_source are Controller-supplied).

import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs, git, loadRecord, assertLiveBindings, productionRemoteMatch } from "./shared/gov-args.mjs";
import { bundleDigestFromFile } from "../src/governance/review-context.mjs";
import { sha256Text } from "../src/evidence/run-evidence-store.mjs";
import { validateExternalReviewResult, externalReviewResultPath, RESULT_ARTIFACT_SCHEMA } from "../src/governance/external-review.mjs";
import { readReviewHistory, deriveRoundContext } from "../src/governance/review-history.mjs";
import { acceptReviewJob, reviewJobRoot } from "../src/governance/review-job.mjs";
import { deriveReviewJobContext } from "../src/governance/review-job-context.mjs";
import { GOV_HOLD } from "../src/governance/holds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const { flags } = parseArgs(process.argv.slice(2));

// ── IMPL1 review-job acceptance mode (controller-only) ──────────────────
// The successor of the external-review-result.json acceptance output: mints
// ACCEPTED for a bound, STAGED review-job by recomputing the full
// findings/verdict chain. Rejects self-declared / stale / unstaged / missing
// artifacts. The reviewer never invokes this.
if (flags.acceptReviewJob) {
  const rjCard = flags.acceptReviewJob;
  const root = flags.piGraphOutput ? resolve(flags.piGraphOutput) : undefined;
  const opts = root ? { root } : {};
  const implementer = flags.implementer || flags.agent || "";
  const rjReviewer = flags.reviewerIdentity || "";
  const rjAuth = flags.authorizationSource || "";
  if (!rjReviewer || !rjAuth) {
    console.error("--reviewer-identity and --authorization-source required (Controller-supplied)");
    process.exit(2);
  }
  // RC2 — derive authoritative context, verify live bindings/repository,
  // normalize the staged set, then hand the recomputed facts to acceptance.
  const cwd = process.cwd();
  const gitRunner = (args) => git(args, cwd);
  let recomputed;
  try {
    const record = loadRecord(flags);
    const authority = record.lifecycle_authorization ?? record;
    const repository = record.repository ?? "";
    const base = record.base || authority.base || "main";
    const specId = flags.specId || rjCard;
    // S1 (Freeze-R2): the canonical spec path is authority-owned.
    const boundSpecPath = record.spec_path ?? "";
    if (!boundSpecPath) {
      console.error(GOV_HOLD.EXTERNAL_REVIEW_RESULT_INVALID);
      console.error("  - authority record spec_path binding required (S1)");
      process.exit(1);
    }
    const specPath = resolve(cwd, boundSpecPath);
    if (flags.specPath && resolve(flags.specPath) !== specPath) {
      console.error(GOV_HOLD.EXTERNAL_REVIEW_RESULT_INVALID);
      console.error("  - --spec-path does not match authority spec_path (redirect rejected)");
      process.exit(1);
    }
    const ctx = deriveReviewJobContext({ git: gitRunner, cwd, baseBranch: base, specId, specPath, authority: { repository, spec_path: boundSpecPath } });
    // Live binding (worktree/branch/base/card) — fail closed.
    assertLiveBindings({ record, cwd, inventory: ctx.inventory, baseBranch: base, cardId: rjCard, runId: record.run_id ?? "", flags });
    // Repository remote verification (D2).
    const repositoryVerified = productionRemoteMatch(ctx.repositoryRemote, repository);
    // Staged-set normalization to canonical relative form.
    const artifactRelRoot = relative(cwd, reviewJobRoot(opts));
    const prefix = artifactRelRoot ? `${artifactRelRoot}/` : "";
    const stagedSet = gitRunner(["diff", "--cached", "--name-only"])
      .split("\n").filter(Boolean)
      .map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p))
      .sort();
    recomputed = {
      candidateIdentity: ctx.candidateIdentity,
      specIdentity: ctx.specIdentity,
      stagedSet,
      repositoryVerified,
    };
  } catch (e) {
    console.error(GOV_HOLD.EXTERNAL_REVIEW_RESULT_INVALID);
    console.error(`  - context: ${e?.code ?? e?.name ?? "error"}: ${e?.message ?? e}`);
    process.exit(1);
  }
  const r = acceptReviewJob(
    { cardId: rjCard, implementerIdentity: implementer, authorizationSource: rjAuth, trustedReviewerIdentity: rjReviewer, recomputed },
    opts,
  );
  if (!r.ok) {
    console.error(GOV_HOLD.EXTERNAL_REVIEW_RESULT_INVALID);
    console.error(`  - ${r.code}${r.actual !== undefined ? ` (state=${r.actual})` : ""}`);
    if (r.drift && r.drift.length) console.error(`    drift: ${r.drift.join(",")}`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    accepted: true,
    jobId: r.job.jobId,
    generation: r.job.generation,
    state: r.job.state,
    acceptedAt: r.job.acceptedAt,
    acceptanceAuthority: r.job.acceptanceAuthority,
    findingsDigest: r.job.findingsDigest,
    verdictDigest: r.job.verdictDigest,
  }, null, 1));
  process.exit(0);
}

const bundleDir = flags.bundleDir ? resolve(flags.bundleDir) : join(homedir(), "Desktop", "AutoLoop-Review");
const cardId = flags.cardId || "UNKNOWN-CARD";
const runId = flags.runId || "run-1";
const verdict = flags.verdict || "";
if (!["PASS", "REPAIR", "HOLD"].includes(verdict)) {
  console.error("--verdict must be PASS|REPAIR|HOLD");
  process.exit(2);
}
const reviewerIdentity = flags.reviewerIdentity || "";
const authorizationSource = flags.authorizationSource || "";
if (!reviewerIdentity || !authorizationSource) {
  console.error("--reviewer-identity and --authorization-source required (Controller-supplied)");
  process.exit(2);
}

// The reviewed bundle must exist at the fixed location.
const bundlePath = join(bundleDir, "READY_FOR_REVIEW.txt");
if (!existsSync(bundlePath)) {
  console.error(GOV_HOLD.EXTERNAL_REVIEW_RESULT_INVALID);
  console.error(`  - bundle not found at ${bundlePath}`);
  process.exit(1);
}
const bundleText = readFileSync(bundlePath, "utf8");
const bundleSha256 = bundleDigestFromFile(bundleText);

// Parse patch / changed-tree identities from the bundle text (never trust
// executor-supplied values).
function parseBundleIdentity(label) {
  const re = new RegExp(`^[- ]*${label}:\\s*([0-9a-f]{64})`, "m");
  const m = bundleText.match(re);
  if (!m) {
    console.error(GOV_HOLD.EXTERNAL_REVIEW_RESULT_INVALID);
    console.error(`  - cannot parse ${label} from bundle`);
    process.exit(1);
  }
  return m[1];
}
const patchSha256 = parseBundleIdentity("patch SHA-256");
const changedTreeIdentity = parseBundleIdentity("changed-tree identity");
const headMatch = bundleText.match(/^CURRENT_HEAD:\s*([0-9a-f]{40})/m);
const baseHeadMatch = bundleText.match(/^BASE_HEAD:\s*([0-9a-f]{40})/m);
const repository = bundleText.match(/^REPOSITORY:\s*(.+)$/m)?.[1]?.trim() || "";
const branch = bundleText.match(/^BRANCH:\s*(.+)$/m)?.[1]?.trim() || "";
const baseBranch = bundleText.match(/^BASE_BRANCH:\s*(.+)$/m)?.[1]?.trim() || "";
const roundMatch = bundleText.match(/^REVIEW_ROUND:\s*(\d+)/m);
const reviewRound = roundMatch ? Number(roundMatch[1]) : 1;

const findingsText = flags.findingsFile ? readFileSync(flags.findingsFile, "utf8") : "";
const findingsDigest = findingsText ? sha256Text(findingsText) : sha256Text("(no findings text recorded)");

// Prior-round binding (round ≥ 2) from the review-history artifact.
const history = readReviewHistory(bundleDir);
const roundCtx = deriveRoundContext(history);
let priorBundleSha256 = roundCtx.prior_bundle_sha256 || "";
let priorFindingsDigest = roundCtx.prior_findings_digest || "";
if (reviewRound > 1) {
  if (!priorBundleSha256 || !priorFindingsDigest) {
    console.error(GOV_HOLD.EXTERNAL_REVIEW_RESULT_INVALID);
    console.error("  - round > 1 requires prior bundle/findings digests in review-history.json");
    process.exit(1);
  }
}

const result = {
  schema: RESULT_ARTIFACT_SCHEMA,
  card_id: cardId,
  run_id: runId,
  verdict,
  bundle_sha256: bundleSha256,
  patch_sha256: patchSha256,
  changed_tree_identity: changedTreeIdentity,
  reviewer_identity: reviewerIdentity,
  reviewed_at: new Date().toISOString(),
  review_round: reviewRound,
  findings_digest: findingsDigest,
  authorization_source: authorizationSource,
  current_head: headMatch?.[1] || "",
  base_head: baseHeadMatch?.[1] || "",
  repository,
  branch,
  base_branch: baseBranch,
  bundle_path: bundlePath,
};
// prior-round binding only for round ≥ 2 (round 1 has no prior)
if (reviewRound > 1) {
  result.prior_bundle_sha256 = priorBundleSha256;
  result.prior_findings_digest = priorFindingsDigest;
}
const check = validateExternalReviewResult(result);
if (!check.valid) {
  console.error(GOV_HOLD.EXTERNAL_REVIEW_RESULT_INVALID);
  for (const e of check.errors) console.error(`  - ${e}`);
  process.exit(1);
}

// Exclusive-create: the artifact can only be created ONCE, by the Controller.
const target = externalReviewResultPath(bundleDir);
mkdirSync(dirname(target), { recursive: true });
let fd;
try {
  fd = openSync(target, "wx");
} catch (e) {
  console.error(GOV_HOLD.EXTERNAL_REVIEW_RESULT_NOT_CONTROLLER_OWNED);
  console.error(`  - result artifact already exists (exclusive-create): ${target} (${e.code})`);
  process.exit(1);
}
try {
  writeSync(fd, JSON.stringify(result, null, 2));
} finally {
  closeSync(fd);
}
console.log(JSON.stringify({ result_written: target, verdict, bundle_sha256: bundleSha256, patch_sha256: patchSha256, changed_tree_identity: changedTreeIdentity, review_round: reviewRound }, null, 1));
