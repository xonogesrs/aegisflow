#!/usr/bin/env node
// scripts/gov-review-job-orchestrator.mjs
//
// AUTOLOOP-REVART-IMPL1-RC2 — production review-job lifecycle orchestrator.
//
// The single production entry that owns the complete pre-acceptance lifecycle:
//
//   load authority record
//   → assertLiveBindings
//   → productionRemoteMatch
//   → derive authoritative context (candidate + spec + live repo facts)
//   → createReviewJob (DERIVED identity — never caller-fed)
//   → persistFindings
//   → persistVerdict
//   → finalizePersisted
//   → real Git stageArtifacts (exact staged set)
//   → controller acceptance handoff
//
// It coordinates authoritative primitives; it is NOT a second lifecycle
// state store and does NOT mint ACCEPTED (acceptance is controller-owned via
// scripts/gov-controller-ingest-result.mjs --accept-review-job).

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, git, loadRecord, assertLiveBindings, productionRemoteMatch } from "./shared/gov-args.mjs";
import { deriveReviewJobContext } from "../src/governance/review-job-context.mjs";
import { createReviewJob, advanceState } from "../src/governance/review-job.mjs";
import { persistFindings, persistVerdict, finalizePersisted, stageArtifacts } from "../src/governance/review-job-writeback.mjs";
import { GOV_HOLD } from "../src/governance/holds.mjs";

export class OrchestratorError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OrchestratorError(code, message);
}

export function runReviewJobOrchestrator({ argv = process.argv.slice(2), cwd = process.cwd() } = {}) {
  const { flags } = parseArgs(argv);

  const cardId = flags.cardId || "";
  if (!cardId) throw new OrchestratorError("ORCHESTRATOR_ARGS_CARD_MISSING", "--card-id required");
  const reviewerIdentity = flags.reviewerIdentity || "";
  const verdict = flags.verdict || "";
  if (!reviewerIdentity || !["PASS", "REPAIR", "HOLD"].includes(verdict)) {
    throw new OrchestratorError("ORCHESTRATOR_ARGS_REVIEWER_MISSING", "--reviewer-identity and --verdict (PASS|REPAIR|HOLD) required");
  }

  const root = flags.piGraphOutput ? resolve(flags.piGraphOutput) : undefined;
  const opts = root ? { root } : {};
  const gitRunner = (args) => git(args, cwd);

  const record = loadRecord(flags);
  const authority = record.lifecycle_authorization ?? record;
  const repository = record.repository ?? "";
  const base = record.base || authority.base || "main";
  const specId = flags.specId || cardId;
  // S1 (Freeze-R2): the canonical spec path is authority-owned (record.spec_path).
  // --spec-path is a creation-time locator only; it may not redirect authority.
  const boundSpecPath = record.spec_path ?? "";
  if (!boundSpecPath) {
    fail("AUTHORITY_SPEC_PATH_MISSING", "authority record spec_path binding required (S1)");
  }
  const specPath = resolve(cwd, boundSpecPath);
  if (flags.specPath && resolve(flags.specPath) !== specPath) {
    fail("SPEC_PATH_REDIRECT_REJECTED", `--spec-path ${resolve(flags.specPath)} does not match authority spec_path ${specPath}`);
  }
  const generation = Number.isInteger(Number(flags.generation)) ? Number(flags.generation) : 1;

  // Derive authoritative context from live git + canonical spec (never caller-fed).
  const ctx = deriveReviewJobContext({ git: gitRunner, cwd, baseBranch: base, specId, specPath, authority: { repository, spec_path: boundSpecPath } });
  assertLiveBindings({ record, cwd, inventory: ctx.inventory, baseBranch: base, cardId, runId: record.run_id ?? "", flags });
  if (!productionRemoteMatch(ctx.repositoryRemote, repository)) {
    fail("REVIEW_REPOSITORY_UNVERIFIED", `live remote ${ctx.repositoryRemote || "(none)"} does not match authority.repository ${repository}`);
  }

  const created = createReviewJob({
    cardId,
    generation,
    candidateIdentity: ctx.candidateIdentity,
    specId: ctx.specIdentity.specId,
    specDigest: ctx.specIdentity.specDigest,
    repoIdentity: repository,
    worktreeIdentity: ctx.worktreeIdentity,
  }, opts);
  if (!created.ok) fail(created.code, "createReviewJob failed");

  const a1 = advanceState(cardId, "REQUIRED", "PREPARED", opts);
  if (!a1.ok) fail(a1.code, "advance REQUIRED→PREPARED failed");
  const a2 = advanceState(cardId, "PREPARED", "RUNNING", opts);
  if (!a2.ok) fail(a2.code, "advance PREPARED→RUNNING failed");

  const findings = flags.findingsFile ? JSON.parse(readFileSync(resolve(flags.findingsFile), "utf8")) : [];
  const summary = flags.summary || "";
  const recommendedNextAction = flags.recommendedNextAction || "";

  const f = persistFindings({ cardId, reviewerIdentity, findings, summary }, opts);
  if (!f.ok) fail(f.code, "persistFindings failed");
  const v = persistVerdict({ cardId, reviewerIdentity, verdict, summary, recommendedNextAction }, opts);
  if (!v.ok) fail(v.code, "persistVerdict failed");
  const fin = finalizePersisted({ cardId }, opts);
  if (!fin.ok) fail(fin.code, "finalizePersisted failed");
  const st = stageArtifacts({ cardId, git: gitRunner, repoRoot: cwd }, opts);
  if (!st.ok) fail(st.code, "stageArtifacts failed");

  return {
    ok: true,
    jobId: st.job.jobId,
    generation: st.job.generation,
    state: st.job.state,
    candidateIdentity: st.job.candidateIdentity,
    specId: st.job.specId,
    specDigest: st.job.specDigest,
    findingsDigest: st.job.findingsDigest,
    verdictDigest: st.job.verdictDigest,
    next: "gov-controller-ingest-result.mjs --accept-review-job <cardId> --reviewer-identity <trusted> --authorization-source <src> --authority-file <file> [--pi-graph-output <root>]",
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = runReviewJobOrchestrator();
    console.log(JSON.stringify(result, null, 1));
    process.exit(0);
  } catch (e) {
    console.error(GOV_HOLD.EXTERNAL_REVIEW_RESULT_INVALID);
    console.error(`  - ${e?.code ?? e?.name ?? "error"}: ${e?.message ?? e}`);
    process.exit(1);
  }
}
