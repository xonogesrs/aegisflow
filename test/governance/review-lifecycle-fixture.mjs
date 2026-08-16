// test/governance/review-lifecycle-fixture.mjs
//
// AUTOLOOP-REVART-LC1-B1 — shared fixtures for the review-lifecycle tests:
// a real temp git repo, a v3 lifecycle-authorization record with
// closeout_metadata, the projected review_closeout binding, and frozen
// admissions (review-required HIGH / deterministic FAST_PATH).

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import {
  defaultDenyAuthority,
  projectReviewCloseout,
} from "../../src/governance/lifecycle-authorization.mjs";

export const CARD_ID = "AUTOLOOP-REVART-B1-TEST-CARD";
export const OUT_DIR_REL = "docs/pi-graph-output/revart-b1-test-card";
export const SPEC_PATH_REL = `${OUT_DIR_REL}/b1-card-spec.md`;
export const SPEC_TEXT = "# B1 spec\n\nMachine-authoritative spec bytes for the lifecycle test card.\n";

/** Create a real disposable git repo with one commit; returns its path. */
export function makeGitRepo(tag = "repo") {
  const dir = mkdtempSync(join(tmpdir(), `revart-b1-${tag}-`));
  const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@autoloop.local"]);
  run(["config", "user.name", "Lifecycle Test"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "base"]);
  return dir;
}

export function repoHead(repo) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

/** v3 lifecycle-authorization record with the additive closeout_metadata. */
export function makeAuthorityRecord({
  repo,
  cardId = CARD_ID,
  outDirRel = OUT_DIR_REL,
  specPathRel = SPEC_PATH_REL,
  bundlePathRel = `${outDirRel}/b1-bundle.txt`,
  baseHead = null,
} = {}) {
  const head = baseHead ?? repoHead(repo);
  const auth = defaultDenyAuthority();
  auth.independent_review = { allowed: true, require_fresh_session: true, require_same_artifact_digest: true };
  auth.feature_branch_push = { ...auth.feature_branch_push, branch_pattern: "governance/*" };
  auth.draft_pr = { ...auth.draft_pr, base_branch: "main" };
  auth.external_review = { ...auth.external_review, bundle_path: bundlePathRel };
  auth.review_unit = {
    allowed: true, repository_count: 1, worktree_count: 1, parent_card_count: 1,
    architecture_goal_count: 1, maximum_internal_milestones: 3, maximum_changed_paths: 64,
    maximum_patch_lines: 20000, maximum_repair_rounds: 1,
  };
  return {
    schema: "autoloop.lifecycle-authorization/v3",
    card_id: cardId,
    run_id: `${cardId}-r1`,
    issued_at: new Date().toISOString(),
    authorized_by: "controller",
    repository: "xonogesrs/autoloop",
    worktree: repo,
    branch: "governance/revart-b1",
    base: head,
    base_head: head,
    // Directory-scoped entries MUST end with "/" (FM-3 inventory convention)
    // so the closeout gate's own outputs inside outDir are authorized.
    authorized_paths: [`${outDirRel}/`, specPathRel],
    bundle_path: bundlePathRel,
    spec_path: specPathRel,
    closeout_metadata: {
      card_title: "Review Lifecycle B1 Test Card",
      card_type: "implementation",
      out_dir: outDirRel,
    },
    lifecycle_authorization: auth,
  };
}

/** Materialize the spec file inside the repo; returns its absolute path. */
export function writeSpec(repo, specPathRel = SPEC_PATH_REL) {
  const abs = resolve(repo, specPathRel);
  mkdirSync(resolve(repo, specPathRel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(abs, SPEC_TEXT, "utf8");
  return abs;
}

/** Project the frozen binding (single projection implementation). */
export function projectBinding(repo) {
  writeSpec(repo);
  const record = makeAuthorityRecord({ repo });
  const binding = projectReviewCloseout({
    record,
    specBytes: readFileSync(resolve(repo, SPEC_PATH_REL)),
  });
  if (!binding.ok) throw new Error(`fixture: projectReviewCloseout failed: ${binding.errors.join(";")}`);
  return { record, binding: binding.binding };
}

// size M + HIGH risk → profile HIGH → review_policy.strength "external".
const HIGH_DIMS = {
  affected_files: { score: 3, reasons: ["multi-file"] },
  affected_subsystems: { score: 3, reasons: ["multi-subsystem"] },
  dependency_depth: { score: 0, reasons: ["none"] },
  ambiguity: { score: 0, reasons: ["exact text"] },
  expected_execution_steps: { score: 0, reasons: ["one"] },
  verification_burden: { score: 2, reasons: ["verify"] },
  external_dependencies: { score: 2, reasons: ["network"] },
  concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 0, reasons: ["revert"] },
};
const HIGH_SIGNALS = [{ signal_id: "RS.NETWORK_REMOTE", class: "HIGH", triggered: true, reason: "remote fetch" }];

/** Frozen review-required (HIGH/external) admission carrying the binding. */
export function makeReviewRequiredAdmission({
  binding,
  taskId = "B1-TASK",
  mutationScope = [`${OUT_DIR_REL}/`],
  authorityRecordDigest = null,
} = {}) {
  const c = classify({ dimensionScores: HIGH_DIMS, riskSignals: HIGH_SIGNALS, evidenceSufficient: true });
  return freezeAdmission(buildAdmissionRecord({
    taskId,
    classification: c,
    mutationScope,
    authorityRecordDigest: authorityRecordDigest ?? binding.source_authority_digest,
    reviewCloseout: binding,
  }));
}

/** Frozen deterministic (FAST_PATH, non-review-required) admission. */
export function makeDeterministicAdmission({ taskId = "B1-DET", binding = null } = {}) {
  const c = classify({ dimensionScores: HIGH_DIMS, riskSignals: scanRiskSignals("fix one typo in README") });
  return freezeAdmission(buildAdmissionRecord({
    taskId,
    classification: c,
    mutationScope: ["docs/"],
    reviewCloseout: binding,
  }));
}

/** Budget-honoring spy runner (writes no card outputs of its own). */
export function makeSpyRunner(recorded) {
  return async (opts) => {
    recorded.push(opts);
    const enc = opts?.budget?.enforcement;
    if (enc) {
      const gate = enc.preDispatch({ executionId: "g", phase_id: "P1", nodeId: "P1", attempt: 0, runtime: { mode: "readonly", limits: { timeoutMs: 60000 } } });
      if (gate.ok) enc.recordConsumption({ opKey: gate.opKey, actualAmounts: { node_execution_count: 1 }, wallClockMs: 5 });
    }
    return {
      final: "PASS",
      holdCode: null,
      reason: null,
      executionId: "g",
      nodeResults: [{
        nodeId: "P1", final: "PASS", attempt: 0, taskType: "implementation",
        resultIdentity: { latencyMs: 5 },
        reviewResult: { recommendedAction: "PASS", blockingFindings: [], summary: "graph independent review PASS" },
      }],
      transitions: [],
      admission: opts?.admission ?? null,
    };
  };
}

export { rmSync };
