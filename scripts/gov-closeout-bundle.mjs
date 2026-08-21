#!/usr/bin/env node
// scripts/gov-closeout-bundle.mjs
//
// Official CLI for the RB-1 card-closeout review bundle gate.
//
//   --generate <source.json> --repo <path> --out <dir> [--timeout-ms 30000] [--file <name>]
//       Generates the 25-section review bundle from a STRUCTURED source file
//       (autoloop.review-bundle.source/v1), recomputes repo facts from git
//       (authoritative — never trusts source repo claims), atomically writes
//       the .txt bundle, and runs the independent validator. Prints the
//       final closeout verdict + bundle identity/sha256. Exit 0 iff PASS.
//
//   --validate <bundle.txt> --context <ctx.json> [--authorized-dir <dir>]
//       Validates an EXISTING bundle against a context file:
//       { taskId?, cardTitle?, repository?, branch?, head?, treeSha?,
//         graphRunId?, reviewResultIdentity?, evidenceManifestDigest? }
//       Exit 0 iff ok.
//
//   --record-delivery-attempt <bundle.txt> --out <dir> [--card <id>] [--method <m>]
//       [--attempted-at <ISO>]
//       RB-1G: validates the bundle and records a NON-AUTHORITATIVE delivery
//       attempt（DELIVERY_ATTEMPTED — the sender can never confirm receipt）.
//       RECEIVED is proven solely by the external reviewer's verdict. Writes
//       external-review-delivery-<identity8>.json in <dir>. Exit 0 iff
//       recorded.
//
//   --apply-verdict <delivery-record.json> --verdict PASS|REPAIR|HOLD
//       --reviewer <identity> [--reviewed-at <ISO>] [--agent <identity>] [--findings-digest <sha256>]
//       RB-1G: the verdict IS the receipt acknowledgment. Requires a verdict
//       bound to the CURRENT bundle identity/sha256, a real reviewer identity
//       and a reviewed-at timestamp; then updates externalReviewStatus and
//       prints whether external review is complete. Exit 0 iff applied.
//
//   --state-driven-closeout <closeout-state.json> [--graph-evidence <evidence.json>]
//       [--repo <path>] [--out <dir>] [--surface <dir>]
//       AUTOLOOP_REPORT_LIFECYCLE_REPAIR_1: the state-driven mandatory
//       closeout entry — reads the persisted closeout-state record
//       (requiresReview + identity + scope), materializes the contract
//       (fail-closed CLOSEOUT_METADATA_INCOMPLETE when incomplete), loads the
//       graph result from the evidence snapshot when not supplied, drives
//       runStateDrivenCloseout, and records the disposition back into the
//       state. No card-specific closeout script required.
//
// Local-only, deterministic, no network. Never commits/pushes/seals.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCloseoutGate,
  runStateDrivenCloseout,
  validateReviewBundle,
  collectRepoFacts,
  bundleContentSha256,
  REVIEW_BUNDLE_SOURCE_SCHEMA,
  buildExternalReviewState,
  recordDeliveryAttempt,
  applyExternalReviewVerdict,
  externalReviewComplete,
  cardExternalReviewStatus,
  writeExternalReviewDeliveryRecord,
  readExternalReviewDeliveryRecord,
  supersedesFromBundleText,
  assertFinalCardCloseout,
  deriveAuthoritativeCloseoutStage,
} from "../src/governance/review-bundle.mjs";
import { readCloseoutState } from "../src/governance/closeout-state.mjs";
import { readReviewJob, findingsPath, verdictPath } from "../src/governance/review-job.mjs";
import { sha256Text } from "../src/evidence/run-evidence-store.mjs";
import { readFileSync as _readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const mode = process.argv.includes("--enumerate-review-job") ? "enumerate-review-job" : process.argv.includes("--generate") ? "generate" : process.argv.includes("--validate") ? "validate" : process.argv.includes("--record-delivery-attempt") ? "record-delivery-attempt" : process.argv.includes("--apply-verdict") ? "apply-verdict" : process.argv.includes("--state-driven-closeout") ? "state-driven-closeout" : process.argv.includes("--final-closeout") ? "final-closeout" : null;
if (!mode) {
  console.error("usage: node scripts/gov-closeout-bundle.mjs --generate <source.json> --repo <path> --out <dir> [--timeout-ms 30000] [--file <name>]");
  console.error("       node scripts/gov-closeout-bundle.mjs --validate <bundle.txt> --context <ctx.json> [--authorized-dir <dir>]");
  console.error("       node scripts/gov-closeout-bundle.mjs --record-delivery-attempt <bundle.txt> --out <dir> [--card <id>] [--method <m>] [--attempted-at <ISO>]");
  console.error("       node scripts/gov-closeout-bundle.mjs --apply-verdict <delivery-record.json> --verdict PASS|REPAIR|HOLD --reviewer <identity> [--reviewed-at <ISO>] [--agent <identity>] [--findings-digest <sha256>]");
  console.error("       node scripts/gov-closeout-bundle.mjs --state-driven-closeout <closeout-state.json> [--graph-evidence <evidence.json>] [--repo <path>] [--out <dir>] [--surface <dir>]");
  console.error("       node scripts/gov-closeout-bundle.mjs --final-closeout <closeout-state.json> [--repo <path>] [--out <dir>] [--surface <dir>] [--agent <identity>]");
  process.exit(2);
}

// enumerate-review-job mode（IMPL1）: the sole authoritative closeout bundle
// generator enumerates the Flow 2 review-job evidence — identity, state,
// candidate/spec bindings, findings/verdict canonical paths and RECOMPUTED
// digests, supersession/currentness, acceptance record. Never trusts bound
// digests alone; never trusts arbitrary reviewer-authored paths.
if (mode === "enumerate-review-job") {
  const cardId = arg("--enumerate-review-job", null);
  const root = arg("--pi-graph-output", null);
  if (!cardId) {
    console.error("usage: node scripts/gov-closeout-bundle.mjs --enumerate-review-job <cardId> [--pi-graph-output <root>]");
    process.exit(2);
  }
  const opts = root ? { root } : {};
  const r = readReviewJob(cardId, opts);
  if (!r.ok) {
    console.error(`review_job_unavailable: ${r.code}`);
    process.exit(1);
  }
  const job = r.job;
  const out = {
    cardId: job.lineageId,
    jobId: job.jobId,
    generation: job.generation,
    state: job.state,
    stateVersion: job.stateVersion,
    candidateIdentity: job.candidateIdentity,
    specId: job.specId,
    specDigest: job.specDigest,
    supersedes: job.supersedes ?? null,
    supersededBy: job.supersededBy ?? null,
  };
  if (job.findingsDigest) {
    const fp = findingsPath(cardId, job.generation, opts);
    try {
      const bytes = _readFileSync(fp, "utf8");
      out.findingsPath = fp;
      out.findingsDigest = job.findingsDigest;
      out.findingsDigestMatch = job.findingsDigest === sha256Text(bytes);
    } catch { out.findingsMissing = true; }
  }
  if (job.verdictDigest) {
    const vp = verdictPath(cardId, job.generation, opts);
    try {
      const bytes = _readFileSync(vp, "utf8");
      out.verdictPath = vp;
      out.verdictDigest = job.verdictDigest;
      out.verdictDigestMatch = job.verdictDigest === sha256Text(bytes);
    } catch { out.verdictMissing = true; }
  }
  if (job.acceptedAt) out.acceptedAt = job.acceptedAt;
  if (job.acceptanceAuthority) out.acceptanceAuthority = job.acceptanceAuthority;
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

// generate mode
if (mode === "generate") {
  const sourcePath = arg("--generate", null);
  const repoPath = arg("--repo", "/Volumes/NVM2T/Development/repos/autoloop");
  const outDir = arg("--out", `${process.env.HOME}/Desktop/AutoLoop-Review`);
  const timeoutMs = Number(arg("--timeout-ms", "30000"));
  const fileName = arg("--file", null);

  let source;
  try {
    source = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (e) {
    console.error(`cannot read/parse --generate ${sourcePath}: ${e.message}`);
    process.exit(2);
  }
  if (source.schema !== REVIEW_BUNDLE_SOURCE_SCHEMA) {
    console.error(`source schema mismatch: ${source.schema} (expected ${REVIEW_BUNDLE_SOURCE_SCHEMA})`);
    process.exit(2);
  }

  const facts = collectRepoFacts(repoPath);
  // RB2-B2: the CLI --generate path is a FORMAL Review closeout entry —
  // delivery to the fixed review surface is mandatory regardless of whether
  // the source JSON carries externalReview.deliveryRequired（the flag is
  // informational; absence / false / malformed can never skip publication）.
  const result = await runCloseoutGate({ source, repoPath, outDir, timeoutMs, fileName, repoFacts: facts, formal: true });
  console.log(`final=${result.final} holdCode=${result.holdCode ?? "null"}`);
  if (result.reason) console.log(`reason: ${result.reason}`);
  if (result.bundlePath) console.log(`bundle: ${result.bundlePath}`);
  if (result.bundle) {
    console.log(`reviewBundleIdentity: ${result.bundle.identity}`);
    console.log(`reviewBundleSha256: ${result.bundle.sha256}`);
    console.log(`evidenceManifestDigest: ${result.bundle.evidenceManifestDigest}`);
  }
  console.log(`repo: ${facts.repository ?? "(no remote)"} branch=${facts.branch} head=${facts.head} tree=${facts.treeSha} dirty=${facts.dirtyPaths.length}`);
  process.exit(result.final === "PASS" ? 0 : 1);
}

// validate mode
if (mode === "validate") {
  const bundlePath = arg("--validate", null);
  const ctxPath = arg("--context", null);
  const authorizedDir = arg("--authorized-dir", null);
  let ctx = {};
  if (ctxPath) {
    try {
      ctx = JSON.parse(readFileSync(ctxPath, "utf8"));
    } catch (e) {
      console.error(`cannot read/parse --context ${ctxPath}: ${e.message}`);
      process.exit(2);
    }
  }
  const v = validateReviewBundle(bundlePath, { authorizedDir, expected: ctx });
  console.log(`valid=${v.ok} holdCode=${v.holdCode ?? "null"}`);
  for (const e of v.errors ?? []) console.log(`  error: ${e}`);
  process.exit(v.ok ? 0 : 1);
}

// record-delivery-attempt mode（RB-1G）: NON-AUTHORITATIVE sender-side record.
// The execution side can never confirm receipt — the external reviewer's
// verdict is the sole receipt acknowledgment. This only records that the
// sender provided the artifact（method + timestamp）.
if (mode === "record-delivery-attempt") {
  const bp = arg("--record-delivery-attempt", null);
  const out = arg("--out", null);
  const card = arg("--card", null);
  const method = arg("--method", "sender-provided");
  const attemptedAt = arg("--attempted-at", new Date().toISOString());
  if (!bp || !out) {
    console.error("usage: node scripts/gov-closeout-bundle.mjs --record-delivery-attempt <bundle.txt> --out <dir> [--card <id>] [--method <m>] [--attempted-at <ISO>]");
    process.exit(2);
  }
  const check = validateReviewBundle(bp, { authorizedDir: out });
  if (!check.ok) {
    console.error(`attempt_blocked valid=false holdCode=${check.holdCode ?? "null"}`);
    for (const e of check.errors ?? []) console.error(`  error: ${e}`);
    process.exit(1);
  }
  const txt = readFileSync(bp, "utf8");
  const identity = txt.match(/^REVIEW_BUNDLE_IDENTITY: ([0-9a-f]{64})$/m)?.[1] ?? null;
  const shaLines = txt.split("\n");
  const shaLine = [...shaLines].reverse().find((l) => l.startsWith("REVIEW_BUNDLE_SHA256:"));
  const sha = shaLine ? shaLine.split(":")[1]?.trim() : null;
  if (!identity || !sha) {
    console.error("attempt_blocked: bundle identity/sha256 unreadable");
    process.exit(1);
  }
  // RB-1G repair: a repair-generation bundle carries its SUPERSEDES_* binding
  // in section 14 — the delivery record must carry the same binding so the
  // evidence chain（supersedes -> superseded）never diverges between the
  // artifact and its delivery record. Fail-closed on a partial binding.
  const parsedSup = supersedesFromBundleText(txt);
  if (parsedSup.error) {
    console.error(`attempt_blocked: ${parsedSup.error}`);
    process.exit(1);
  }
  const state = buildExternalReviewState({ bundle: { identity, sha256: sha }, bundlePath: bp, supersedes: parsedSup.supersedes });
  const attempted = recordDeliveryAttempt(state, { method, attemptedAt });
  const rec = writeExternalReviewDeliveryRecord({ outDir: out, state: attempted, cardId: card });
  if (!rec.ok) {
    console.error(`attempt_record_failed: ${rec.reason}`);
    process.exit(1);
  }
  console.log(`delivery=attempted(non-authoritative) record=${rec.path}`);
  console.log(`reviewBundleIdentity: ${identity}`);
  console.log(`reviewBundleSha256: ${sha}`);
  if (parsedSup.supersedes) {
    console.log(`supersedes: ${parsedSup.supersedes.reviewBundleIdentity}`);
    console.log(`supersedes sha256: ${parsedSup.supersedes.reviewBundleSha256}`);
  }
  console.log(`externalReviewStatus: ${attempted.externalReviewStatus} deliveryRequired=${attempted.reviewBundleDeliveryRequired} deliveryAttempted=${attempted.delivery.attempted}`);
  console.log(`externalReviewComplete: ${externalReviewComplete(attempted)}`);
  console.log("note: RECEIVED is proven solely by the external reviewer's verdict (--apply-verdict)");
  process.exit(0);
}

// apply-verdict mode（RB-1G）: the external reviewer read the delivered bundle
// and returns PASS / REPAIR / HOLD bound to the CURRENT bundle. The verdict
// itself is the receipt acknowledgment（RECEIVED + REVIEWED proven in one
// step）; no sender-side delivery flag participates. Rejects stale and
// self-declared verdicts.
if (mode === "apply-verdict") {
  const recPath = arg("--apply-verdict", null);
  const verdict = arg("--verdict", null);
  const reviewer = arg("--reviewer", null);
  const reviewedAt = arg("--reviewed-at", new Date().toISOString());
  const agent = arg("--agent", null);
  const findingsDigest = arg("--findings-digest", null);
  if (!recPath || !verdict || !reviewer) {
    console.error("usage: node scripts/gov-closeout-bundle.mjs --apply-verdict <delivery-record.json> --verdict PASS|REPAIR|HOLD --reviewer <identity> [--reviewed-at <ISO>] [--agent <identity>] [--findings-digest <sha256>]");
    process.exit(2);
  }
  const rec = readExternalReviewDeliveryRecord(recPath);
  if (!rec.ok) {
    console.error(`verdict_blocked: ${rec.errors.join(";")}`);
    process.exit(1);
  }
  // R-13（RSL2-06）: the verdict must bind the ACTUAL delivered bytes — never
  // the delivery record's self-claim. Re-read the authoritative surface bundle
  //（the review-bundle.txt next to this delivery record）, recompute identity +
  // content sha, and require them to match the record; a stale or divergent
  // bundle can never mint a verdict（fail-closed）.
  const surfaceBundle = join(dirname(recPath), "review-bundle.txt");
  if (!existsSync(surfaceBundle)) {
    console.error(`verdict_blocked: surface_bundle_missing:${surfaceBundle}`);
    process.exit(1);
  }
  const bundleText = readFileSync(surfaceBundle, "utf8");
  const actualIdentity = bundleText.match(/^REVIEW_BUNDLE_IDENTITY:\s*([0-9a-f]{64})$/m)?.[1] ?? null;
  const actualSha = bundleContentSha256(surfaceBundle);
  const recordIdentity = rec.state?.delivery?.reviewBundleIdentity ?? null;
  const recordSha = rec.state?.delivery?.reviewBundleSha256 ?? null;
  if (!actualIdentity || actualIdentity !== recordIdentity) {
    console.error(`verdict_blocked: surface_bundle_identity_diverges_from_record:${actualIdentity ? actualIdentity.slice(0, 8) : "none"}!=${recordIdentity ? recordIdentity.slice(0, 8) : "none"}`);
    process.exit(1);
  }
  if (!actualSha || actualSha !== recordSha) {
    console.error(`verdict_blocked: surface_bundle_sha_diverges_from_record:${actualSha ? actualSha.slice(0, 12) : "none"}!=${recordSha ? recordSha.slice(0, 12) : "none"}`);
    process.exit(1);
  }
  const applied = applyExternalReviewVerdict(rec.state, {
    verdict,
    reviewerIdentity: reviewer,
    reviewedAt,
    bundleIdentity: actualIdentity,
    bundleSha256: actualSha,
    agentIdentity: agent,
    findingsDigest: findingsDigest ?? undefined,
  });
  if (!applied.ok) {
    console.error(`verdict_rejected: ${applied.errors.join(";")}`);
    process.exit(1);
  }
  const written = writeExternalReviewDeliveryRecord({ outDir: dirname(recPath), state: applied.state, cardId: rec.cardId, fileName: rec.fileName });
  if (!written.ok) {
    console.error(`verdict_record_failed: ${written.reason}`);
    process.exit(1);
  }
  const guard = cardExternalReviewStatus(applied.state);
  console.log(`verdict=${applied.state.externalReviewStatus} reviewer=${reviewer} reviewedAt=${reviewedAt}`);
  console.log(`externalReviewStatus: ${applied.state.externalReviewStatus}`);
  console.log(`externalReviewComplete: ${guard.complete}`);
  if (guard.holdCode) console.log(`holdCode: ${guard.holdCode}`);
  process.exit(guard.complete ? 0 : 1);
}

// final-closeout mode（RB2R1）: the PRODUCTION final-closeout / commit / seal
// eligibility gate. Consumes the AUTHORITATIVE external-review record（never
// caller-supplied verdict JSON）and returns CLOSEOUT_ELIGIBLE / REVIEW_ACCEPTED
// only when the full final-authority predicate is true. Exit 0 iff ok.
if (mode === "final-closeout") {
  const statePath = arg("--final-closeout", null);
  const repo = arg("--repo", null);
  const outDir = arg("--out", null);
  const surfaceDir = arg("--surface", null);
  const agent = arg("--agent", null);
  if (!statePath || !existsSync(statePath)) {
    console.error(`state_path_missing: ${statePath ?? "(none)"}`);
    process.exit(2);
  }
  const st = readCloseoutState(statePath);
  if (!st.ok) {
    console.error(`closeout_state_unreadable: ${st.errors.join(";")}`);
    process.exit(1);
  }
  const closeout = st.state.closeout ?? null;
  const cardId = st.state.task?.cardId ?? null;
  const dir = outDir ?? st.state.outDir ?? null;
  const authority = deriveAuthoritativeCloseoutStage({
    closeout,
    outDir: dir,
    cardId,
    repoPath: repo ?? null,
    surfaceDir: surfaceDir ?? null,
    agentIdentity: agent ?? st.state.agentIdentity ?? null,
  });
  console.log(`stage=${authority.stage} ok=${authority.ok} holdCode=${authority.holdCode ?? "null"}`);
  if (authority.reason) console.log(`reason: ${authority.reason}`);
  if (authority.bundle) console.log(`bundle: ${authority.bundle.path} identity=${authority.bundle.identity} sha256=${authority.bundle.sha256}`);
  if (authority.review?.reviewerIdentity) console.log(`reviewerIdentity: ${authority.review.reviewerIdentity}`);
  process.exit(authority.ok ? 0 : 1);
}

// state-driven-closeout mode（AUTOLOOP_REPORT_LIFECYCLE_REPAIR_1）: the
// generic, script-free production closeout entry. Reads the persisted
// closeout-state record + (optionally) a graph-closeout evidence snapshot,
// materializes the mandatory closeout contract（fail-closed when incomplete）
// and drives runStateDrivenCloseout → runMandatoryGraphCloseout →
// runCloseoutGate → Current/ delivery. Exit 0 iff final PASS.
if (mode === "state-driven-closeout") {
  const statePath = arg("--state-driven-closeout", null);
  const evidencePath = arg("--graph-evidence", null);
  const repo = arg("--repo", "/Volumes/NVM2T/Development/repos/autoloop");
  const outDir = arg("--out", null);
  const surfaceDir = arg("--surface", null);
  const timeoutMs = Number(arg("--timeout-ms", "30000"));
  if (!statePath || !existsSync(statePath)) {
    console.error(`state_path_missing: ${statePath ?? "(none)"}`);
    process.exit(2);
  }
  const r = await runStateDrivenCloseout({
    statePath,
    graphResultPath: evidencePath ?? null,
    repoPath: repo,
    cwd: repo,
    outDir: outDir ?? undefined,
    timeoutMs,
    surfaceDir: surfaceDir ?? null,
  });
  console.log(`applied=${r.applied} final=${r.final ?? "null"} holdCode=${r.holdCode ?? "null"}`);
  if (r.alreadyApplied) console.log("idempotent: already-applied PASS closeout（skipped）");
  if (r.reason) console.log(`reason: ${r.reason}`);
  if (r.bundlePath) console.log(`bundle: ${r.bundlePath}`);
  if (r.bundle) {
    console.log(`reviewBundleIdentity: ${r.bundle.identity ?? "null"}`);
    console.log(`reviewBundleSha256: ${r.bundle.sha256 ?? "null"}`);
  }
  if (r.externalReview) {
    console.log(`externalReviewStatus: ${r.externalReview.externalReviewStatus ?? "null"}`);
  }
  process.exit(r.final === "PASS" ? 0 : 1);
}
