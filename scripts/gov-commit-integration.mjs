#!/usr/bin/env node
// scripts/gov-commit-integration.mjs
//
// Integration attestation CLI (§8.2) — R-11 canonical authority migration.
// After the CANONICAL external review PASS (review-job ACCEPTED → delivery
// PASS bound to the delivered bundle digest → recomputed candidate identity
// == review-job candidate identity → live bindings), this verifies that the
// CURRENT HEAD and tree exactly match the reviewed identity (digest-bound)
// and records INTEGRATION_READY. It NEVER creates a new commit: creating a
// commit after review would change HEAD and invalidate the reviewed identity
// (external PASS authorizes pushing the reviewed checkpoint HEAD — push then
// re-verifies the same identity).
//
// Rejects --external-review-status PASS / --reviewed-artifact-identity and
// --result-file (self-declared / caller-supplied authority). The RC1A-
// retired `external-review-result.json` is NEVER read; its presence grants
// nothing (RC1A §7.2). The real remote leg belongs exclusively to the push
// gate (PGMA1); this attestation is remote-neutral.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, asBool, splitList } from "./shared/gov-args.mjs";
import { gitOk, loadRecord, buildInventory, rejectSelfDeclaredFlags, scanChangedFilesForSecrets, contextFor, assertLiveBindings, assertScopeCoversInventory } from "./shared/gov-args.mjs";
import { normalizeAuthority, scopeCovers } from "../src/governance/lifecycle-authorization.mjs";
import {
  readReviewJobEvidence,
  readDeliveryEvidence,
  verifyDeliveryBundleDigest,
  evaluatePromotionAuthority,
} from "../src/governance/promotion-authority.mjs";
import { evaluateIntegrationCommitGate, integrationViolationsToHold } from "../src/governance/integration-commit-gate.mjs";
import { expandPath } from "../src/governance/change-inventory.mjs";

const { flags: cliFlags } = parseArgs(process.argv.slice(2));
const cliCwd = cliFlags.cwd || process.cwd();

/**
 * Library entry (R-11): runs the same attestation with injected flags/surface
 * for test-only dependency injection — identical code path to the CLI main.
 * Production CLIs never pass `surfaceDir`; the surface comes from --surface
 * or the canonical default (AEGISFLOW_REVIEW_SURFACE).
 */
export function runCommitIntegration({ flags: flagsIn, cwd: cwdIn, surfaceDir } = {}) {
  const f = { ...(flagsIn ?? cliFlags), ...(surfaceDir ? { surface: surfaceDir } : {}) };
  return attestationMain(f, cwdIn ?? cliCwd);
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

function attestationMain(flags, cwd) {
  const apply = asBool(flags.apply, false);

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
  // Scope is authoritative from the record; a CLI --expected-paths override is
  // only accepted when strictly contained in the authorized scope (else HOLD).
  const recordScope = record.authorized_paths || [];
  const cliScope = splitList(flags.expectedPaths);
  const expectedPaths = cliScope.length ? cliScope : recordScope;
  if (cliScope.length) {
    for (const p of cliScope) {
      if (!scopeCovers(p, recordScope)) {
        fail("HOLD / CLI_OVERRIDE_REJECTED", `--expected-paths expands scope: ${p} not covered by authority record`);
      }
    }
  }

  // Recompute current identities + bind the live environment to the record.
  const inventory = buildInventory(cwd, baseBranch);
  try {
    assertLiveBindings({ record, cwd, inventory, baseBranch, cardId, runId, flags });
    assertScopeCoversInventory(inventory, recordScope);
  } catch (e) {
    fail(e.code ?? "HOLD / LIVE_BINDING_VIOLATION", e.message);
  }
  const bundlePath = record.bundle_path ? expandPath(record.bundle_path, cwd) : "";

  // ── Canonical promotion authority (R-11 migration; PGMA1 chain) ─────────
  // The RC1A-retired external-review-result.json is NEVER read and its
  // presence grants nothing. Commit-integration authority derives from the
  // SAME canonical evidence chain as the push gate:
  //   review-job ACCEPTED → delivery PASS bound to the delivered bundle
  //   digest → recomputed candidate identity == review-job candidate.
  // Remote state is integration-neutral (the push gate owns the remote leg):
  // remoteReachable=true / remoteHead=null keeps evaluatePromotionAuthority's
  // full identity comparison while skipping remote-only checks.
  const surface = flags.surface || null;
  const rj = readReviewJobEvidence(cardId, { cwd });
  if (!rj.ok) {
    fail(rj.code, rj.errors.join("; "));
  }
  if (!surface) {
    fail("HOLD / DELIVERY_MISSING", "commit integration requires the canonical external-review delivery surface (--surface, default AEGISFLOW_REVIEW_SURFACE)");
  }
  const dl = readDeliveryEvidence(surface);
  if (!dl.ok) {
    fail(dl.code, dl.errors.join("; "));
  }
  const bd = verifyDeliveryBundleDigest(surface, {
    expectedSha256: dl.record.delivery.reviewBundleSha256,
    expectedIdentity: dl.record.delivery.reviewBundleIdentity,
  });
  if (!bd.ok) {
    fail(bd.code, bd.errors.join("; "));
  }
  const promotion = evaluatePromotionAuthority({
    reviewJob: rj.record,
    delivery: dl.record,
    bundleSha256: bd.sha256,
    inventory,
    localHead: inventory.head,
    remoteHead: null,
    remoteReachable: true,
  });
  if (!promotion.allowed) {
    fail(promotion.violations[0]?.split(":")[0] ?? "HOLD / PROMOTION_AUTHORITY_DENIED", promotion.violations.join("; "));
  }
  const reviewRound = Number.isInteger(rj.record?.reviewRound) ? rj.record.reviewRound : 1;
  const current = contextFor({ authority, inventory, bundlePath, cardId, runId, reviewRound, agentIdentity, record });

  // The integration gate must never leave the tree uncommitted or the HEAD
  // drifted: the reviewed HEAD is the pushable HEAD.
  const worktreeDirty = inventory.dirtyCount > 0 || inventory.untrackedCount > 0;
  const stagedPaths = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8" }).split("\n").filter(Boolean);

  const diffCheckClean = gitOk(["diff", "--check"], cwd);
  const scannedSecrets = scanChangedFilesForSecrets(cwd, inventory.changedPaths);
  const repairRounds = Number.isInteger(Number(flags.repairRounds)) ? Number(flags.repairRounds) : 1;
  const reviewUnitActual = {
    repository_count: 1,
    worktree_count: 1,
    parent_card_count: 1,
    architecture_goal_count: 1,
    internal_milestones: Number.isInteger(Number(flags.milestones)) ? Number(flags.milestones) : 1,
    changed_paths: inventory.changedPaths.length,
    patch_lines: inventory.patchLines,
    repair_rounds: repairRounds,
  };

  const gate = evaluateIntegrationCommitGate({
    authority,
    promotion,
    deliveryCardId: dl.record.cardId,
    current,
    lifecycleState: flags.lifecycleState || "EXTERNAL_REVIEW_PASS",
    verificationPassed: asBool(flags.verificationPassed, false),
    branch: inventory.branch,
    expectedPaths,
    changedPaths: inventory.changedPaths,
    stagedPaths,
    diffCheckClean,
    artifactIdentity: inventory.changedTreeIdentity,
    evidenceDigest: flags.evidenceDigest || "",
    reviewBlockingFindings: splitList(flags.reviewBlocking),
    repairConverged: asBool(flags.repairConverged, false),
    secretLikeValues: scannedSecrets.length > 0 ? scannedSecrets : splitList(flags.secretLikeValues),
    cardId,
    runId,
    milestoneId: flags.milestoneId || "integration",
    reviewUnitActual,
  });

  if (worktreeDirty) {
    const err = integrationViolationsToHold([...gate.violations, "worktree_dirty: reviewed tree drifted — no new commit is permitted after review"]);
    fail(err.code, (err.details ?? gate.violations).join("; "));
  }

  if (!gate.allowed) {
    const err = integrationViolationsToHold(gate.violations);
    fail(err.code, gate.violations.join("; "));
  }

  // Attestation only — no git mutation. HEAD stays the reviewed checkpoint HEAD.
  const head = inventory.head;
  const report = {
    allowed: true,
    integration_ready: true,
    attestation_only: true,
    no_commit_created: true,
    head,
    reviewed_head: rj.record.candidateIdentity.currentHead,
    authority_identity: promotion.identity,
    identity_verified: true,
    lifecycleState: flags.lifecycleState || "EXTERNAL_REVIEW_PASS",
    apply_requested: apply,
  };
  console.log(JSON.stringify(report, null, 1));
  return report;
}

// ── CLI main ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    attestationMain(cliFlags, cliCwd);
  } catch (e) {
    if (e && e.code) {
      console.error(e.code);
      console.error(`  - ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
