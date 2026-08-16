// test/governance/test-candidate-provenance-repair.mjs
//
// REVART-LC1-CANDIDATE-PROVENANCE-AND-ACCEPTANCE-ORDERING-REPAIR — T1..T18
// test matrix (review-provenance-model-v2).
//
// Run: node --test test/governance/test-candidate-provenance-repair.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createTempRepo } from "./helpers.mjs";

import {
  writeAuthorityRecordValidated,
  validateAuthorityRecord,
  defaultDenyAuthority,
  authorityDigest,
  reviewCloseoutBindingDigest,
  projectReviewCloseout,
} from "../../src/governance/lifecycle-authorization.mjs";
import {
  canonicalOutDir,
  closeoutStateForBinding,
  verifyCloseoutStateAgainstBinding,
  materializeCloseoutContract,
  CLOSEOUT_STATE_SCHEMA,
  writeCloseoutState,
  readCloseoutState,
} from "../../src/governance/closeout-state.mjs";
import {
  validateJobLifecycleIdentityForIngest,
  buildLifecycleIdentity,
} from "../../src/governance/review-lifecycle.mjs";
import {
  createReviewJob,
  readReviewJob,
  advanceState,
  acceptReviewJob,
  canonicalArtifactRelativePaths,
  updateReviewJob,
} from "../../src/governance/review-job.mjs";
import {
  persistFindings,
  persistVerdict,
  finalizePersisted,
  stageArtifacts,
} from "../../src/governance/review-job-writeback.mjs";
import {
  deriveReviewJobContext,
  candidateDrift,
  candidateIntegrityDrift,
} from "../../src/governance/review-job-context.mjs";
import {
  collectRepoFacts,
  captureBaselineInventory,
  runStateDrivenCloseout,
  assertFinalCardCloseout,
  buildExternalReviewState,
  applyExternalReviewVerdict,
  writeExternalReviewDeliveryRecord,
  readExternalReviewDeliveryRecord,
  resolveCandidateRange,
} from "../../src/governance/review-bundle.mjs";
import { productionRemoteMatch } from "../../scripts/shared/gov-args.mjs";

const sha = (c, n) => c.repeat(n);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

function withOrigin(repo) {
  repo.git(["remote", "add", "origin", "git@github.com:xonogesrs/autoloop.git"]);
  return repo;
}

function writeCardState(repo, cardId, state) {
  const outDir = join(repo.dir, "docs", "pi-graph-output", cardId);
  mkdirSync(outDir, { recursive: true });
  const p = join(outDir, "closeout-state.json");
  writeCloseoutState({ path: p, state });
  return { outDir, statePath: p };
}

function makeV3Record(repo, cardId, { base, baseHead, branch } = {}) {
  const auth = defaultDenyAuthority();
  auth.independent_review = { allowed: true, require_fresh_session: true, require_same_artifact_digest: true };
  auth.feature_branch_push = { ...auth.feature_branch_push, branch_pattern: "governance/*" };
  auth.draft_pr = { ...auth.draft_pr, base_branch: "main" };
  auth.external_review = { ...auth.external_review, required: true, require_bundle: true, bundle_path: `docs/pi-graph-output/${cardId}/bundle.txt` };
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
    worktree: repo.dir,
    branch: (branch ?? repo.git(["branch", "--show-current"])).trim(),
    base: base ?? "main",
    base_head: (baseHead ?? repo.git(["rev-parse", "main"])).trim(),
    authorized_paths: [`docs/pi-graph-output/${cardId}/`, "src/impl.txt"],
    bundle_path: `docs/pi-graph-output/${cardId}/bundle.txt`,
    spec_path: `docs/pi-graph-output/${cardId}/card-spec.md`,
    closeout_metadata: {
      card_title: `${cardId} title`,
      card_type: "implementation",
      out_dir: `docs/pi-graph-output/${cardId}`,
    },
    lifecycle_authorization: auth,
  };
}

// ── T1 — schema-valid authority issuance ─────────────────────────────────
test("T1: writeAuthorityRecordValidated issues schema-valid records and rejects invalid ones", () => {
  const repo = createTempRepo(test);
  const dir = join(repo.dir, "governance");
  const record = makeV3Record(repo, "CARD-T1");
  const path = join(dir, "lifecycle-authorization.json");
  const w = writeAuthorityRecordValidated({ path, record });
  assert.equal(w.ok, true, w.errors?.join(","));
  assert.equal(w.digest, authorityDigest(JSON.parse(readFileSync(path, "utf8"))));
  // invalid record (short base_head) is rejected BEFORE write
  const bad = { ...record, base_head: "d36d016" };
  const w2 = writeAuthorityRecordValidated({ path: join(dir, "bad.json"), record: bad });
  assert.equal(w2.ok, false);
  assert.equal(existsSync(join(dir, "bad.json")), false, "invalid record must not be persisted");
});

// ── T2/T3 — digest reproducibility + tamper ───────────────────────────────
test("T2+T3: authority digest round-trips record→admission→binding→job→ingest; tamper drifts", () => {
  const repo = withOrigin(createTempRepo(test));
  const cardId = "CARD-T2";
  const root = join(repo.dir, "docs", "pi-graph-output");
  const outDir = join(root, cardId);
  mkdirSync(outDir, { recursive: true });
  const specPath = join(outDir, "card-spec.md");
  writeFileSync(specPath, "spec T2\n");

  const record = makeV3Record(repo, cardId, { base: "main", baseHead: repo.git(["rev-parse", "main"]) });
  const recordPath = join(repo.dir, "governance", "lifecycle-authorization.json");
  const issued = writeAuthorityRecordValidated({ path: recordPath, record });
  assert.equal(issued.ok, true);
  const D = issued.digest;

  const proj = projectReviewCloseout({ record, specBytes: readFileSync(specPath) });
  assert.equal(proj.ok, true, proj.errors?.join(","));
  const binding = proj.binding;
  assert.equal(binding.source_authority_digest, D);
  const bindingDigest = reviewCloseoutBindingDigest(binding);

  const baseline = captureBaselineInventory(repo.dir, { cardId });
  const state = closeoutStateForBinding({
    binding, bindingDigest, admissionId: sha("2", 64),
    resolvedOutDir: outDir, baseline,
  });
  assert.equal(state.outDir, `docs/pi-graph-output/${cardId}`, "state persists canonical relative out_dir");
  writeCloseoutState({ path: join(outDir, "closeout-state.json"), state });

  const ctx = deriveReviewJobContext({
    git: (a) => repo.git(a), cwd: repo.dir, baseBranch: binding.base,
    specId: cardId, specPath, authority: { repository: "xonogesrs/autoloop", spec_path: binding.spec_path },
  });
  const identity = buildLifecycleIdentity({
    admission: { admission_id: sha("2", 64) }, binding, resolvedOutDir: outDir,
    baselineContentDigest: baseline.contentDigest,
  });
  assert.equal(identity.outDir, `docs/pi-graph-output/${cardId}`, "job persists canonical relative out_dir");

  const job = createReviewJob({
    cardId, generation: 1, candidateIdentity: ctx.candidateIdentity,
    specId: cardId, specDigest: ctx.specIdentity.specDigest,
    lifecycleIdentity: identity, worktreeIdentity: repo.dir, repoIdentity: "xonogesrs/autoloop",
  }, { root });
  assert.equal(job.ok, true, job.errors?.join(","));

  // ingest-side validation — full chain must pass
  const st = readCloseoutState(join(outDir, "closeout-state.json"));
  const ingest = validateJobLifecycleIdentityForIngest({
    job: readReviewJob(cardId, { root }).job, record, state: st.state, repoRoot: repo.dir,
  });
  assert.equal(ingest.ok, true, `ingest chain drift: ${ingest.drift?.join(",")}`);

  // T3: tamper the persisted record → drift
  const tampered = { ...record, run_id: "tampered" };
  const ingest2 = validateJobLifecycleIdentityForIngest({
    job: readReviewJob(cardId, { root }).job, record: tampered, state: st.state, repoRoot: repo.dir,
  });
  assert.equal(ingest2.ok, false);
  assert.ok(ingest2.drift.includes("sourceAuthorityDigest"));
});

// ── T4/T5 — canonical out_dir ─────────────────────────────────────────────
test("T4: canonicalOutDir converts absolute to stable relative; stable across restart", () => {
  const root = "/work/repo";
  const abs = join(root, "docs", "pi-graph-output", "CARD-X");
  const rel1 = canonicalOutDir(abs, root);
  const rel2 = canonicalOutDir(abs, root);
  assert.equal(rel1, "docs/pi-graph-output/CARD-X");
  assert.equal(rel1, rel2);
  assert.equal(canonicalOutDir("docs/pi-graph-output/CARD-X"), "docs/pi-graph-output/CARD-X");
  assert.equal(canonicalOutDir("docs//pi-graph-output/CARD-X/"), "docs/pi-graph-output/CARD-X");
});

test("T5: abs/rel same path verifies; genuinely different path drifts", () => {
  const repo = createTempRepo(test);
  const baseline = { schema: "autoloop.card-inventory.baseline/v1", dirtyPaths: [], contentDigest: sha("0", 64) };
  const binding = {
    schema: "autoloop.review-closeout/v1", card_id: "CARD-5", card_title: "t", card_type: "implementation",
    out_dir: "docs/pi-graph-output/CARD-5", base: "main", base_head: sha("1", 40),
  };
  const digest = reviewCloseoutBindingDigest(binding);
  const abs = join(repo.dir, "docs", "pi-graph-output", "CARD-5");
  const stateAbs = closeoutStateForBinding({
    binding, bindingDigest: digest, admissionId: sha("a", 64), resolvedOutDir: abs, baseline,
  });
  const stateRel = { ...stateAbs, outDir: "docs/pi-graph-output/CARD-5" };
  // legacy absolute state verifies against the same resolved path
  const v1 = verifyCloseoutStateAgainstBinding(stateAbs, { binding, bindingDigest: digest, admissionId: sha("a", 64), resolvedOutDir: abs, repoRoot: repo.dir });
  assert.equal(v1.ok, true, v1.drift?.join(","));
  // relative state verifies too
  const v2 = verifyCloseoutStateAgainstBinding(stateRel, { binding, bindingDigest: digest, admissionId: sha("a", 64), resolvedOutDir: abs, repoRoot: repo.dir });
  assert.equal(v2.ok, true, v2.drift?.join(","));
  // genuinely different path drifts
  const other = { ...stateRel, outDir: "docs/pi-graph-output/OTHER" };
  const v3 = verifyCloseoutStateAgainstBinding(other, { binding, bindingDigest: digest, admissionId: sha("a", 64), resolvedOutDir: abs, repoRoot: repo.dir });
  assert.equal(v3.ok, false);
  assert.ok(v3.drift.includes("outDir"));
});

// ── T6/T7 — committed-before-baseline attribution ────────────────────────
test("T6+T7: clean worktree with committed candidate still attributes implementation via candidate range", () => {
  const repo = withOrigin(createTempRepo(test));
  // implementation committed BEFORE the formal baseline
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "impl.txt"), "impl v1\n");
  repo.git(["add", "src/impl.txt"]);
  commit(repo, "candidate");
  const candidate = repo.git(["rev-parse", "HEAD"]).trim();
  const base = repo.git(["rev-parse", "main"]).trim();
  assert.equal(repo.git(["status", "--porcelain"]), "", "worktree clean");

  const baseline = captureBaselineInventory(repo.dir, { cardId: "CARD-T6" });
  const range = { baseHead: base, candidateHead: candidate };
  const facts = collectRepoFacts(repo.dir, { baseline, candidateRange: range });
  assert.ok(facts.implementationDelta, "implementation delta derived");
  assert.ok(facts.implementationPaths.includes("src/impl.txt"), `impl missing: ${facts.implementationPaths}`);
  assert.ok(facts.implementationDelta.added.includes("src/impl.txt"), "impl classified ADDED");
  // porcelain-only view would attribute nothing (clean tree)
  assert.equal(facts.deltaPaths.length, 0, "porcelain delta empty on clean tree");
  // legacy view unchanged
  const legacy = collectRepoFacts(repo.dir, { baseline });
  assert.equal(legacy.implementationDelta, null);
});

function GIT_ENV_ARGS() {
  return ["-c", "user.name=t", "-c", "user.email=t@t"];
}

/** git commit with per-invocation identity (must precede the subcommand). */
function commit(repo, msg) {
  repo.git([...GIT_ENV_ARGS(), "commit", "-m", msg]);
}

// ── T8 — uncommitted implementation compatibility ────────────────────────
test("T8: dirty uncommitted implementation still attributed without a range (legacy porcelain path)", () => {
  const repo = createTempRepo(test);
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "dirty.txt"), "dirty\n");
  const baseline = captureBaselineInventory(repo.dir, { cardId: "CARD-T8" }); // before the dirty write
  writeFileSync(join(repo.dir, "src", "dirty.txt"), "dirty v2\n");
  const facts = collectRepoFacts(repo.dir, { baseline });
  assert.equal(facts.implementationDelta, null, "no range → legacy behavior");
  assert.ok(facts.deltaPaths.includes("src/dirty.txt"), "porcelain delta still works");
});

// ── T9 — reseal baseline inheritance ─────────────────────────────────────
test("T9: materialized closeout contract inherits the persisted baseline", () => {
  const repo = createTempRepo(test);
  const baseline = captureBaselineInventory(repo.dir, { cardId: "CARD-T9" });
  const state = {
    schema: CLOSEOUT_STATE_SCHEMA,
    task: { cardId: "CARD-T9", cardTitle: "t", cardType: "implementation" },
    requiresReview: true,
    outDir: "docs/pi-graph-output/CARD-T9",
    authorizedScope: ["docs/pi-graph-output/CARD-T9/"],
    baseline,
  };
  const materialized = materializeCloseoutContract(state);
  assert.equal(materialized.ok, true, materialized.errors?.join(","));
  assert.equal(materialized.contract.baseline.contentDigest, baseline.contentDigest, "baseline inherited, never replaced");
});

// ── T10 — evidence generation does not change candidate identity ─────────
test("T10: governance commits advance HEAD without content drift (T17 HEAD divergence)", () => {
  const repo = withOrigin(createTempRepo(test));
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "impl.txt"), "impl\n");
  repo.git(["add", "src/impl.txt"]);
  commit(repo, "candidate");
  const specPath = join(repo.dir, "docs", "spec.md");
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, "spec\n");
  repo.git(["add", "docs/spec.md"]);
  commit(repo, "spec");

  const ctx1 = deriveReviewJobContext({
    git: (a) => repo.git(a), cwd: repo.dir, baseBranch: "main", specId: "CARD-T10",
    specPath, authority: { repository: "xonogesrs/autoloop", spec_path: "docs/spec.md" },
  });
  // governance/evidence commit on top
  mkdirSync(join(repo.dir, "docs", "pi-graph-output"), { recursive: true });
  writeFileSync(join(repo.dir, "docs", "pi-graph-output", "evidence.json"), "{}\n");
  repo.git(["add", "docs/pi-graph-output/evidence.json"]);
  commit(repo, "evidence");
  assert.notEqual(repo.git(["rev-parse", "HEAD"]).trim(), ctx1.candidateIdentity.currentHead, "HEAD advanced");

  const ctx2 = deriveReviewJobContext({
    git: (a) => repo.git(a), cwd: repo.dir, baseBranch: "main", specId: "CARD-T10",
    specPath, authority: { repository: "xonogesrs/autoloop", spec_path: "docs/spec.md" },
  });
  assert.equal(candidateIntegrityDrift(ctx1.candidateIdentity, ctx2.candidateIdentity).length, 0, "content integrity intact");
  assert.ok(candidateDrift(ctx1.candidateIdentity, ctx2.candidateIdentity).includes("currentHead"), "full-field drift is only currentHead");
});

// ── T11/T12 — staged vs committed canonical representation ───────────────
function makeStagedChain(repo, cardId, root) {
  const specPath = join(repo.dir, "docs", "spec.md");
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, "spec\n");
  repo.git(["add", "docs/spec.md"]);
  commit(repo, "spec");
  const ctx = deriveReviewJobContext({
    git: (a) => repo.git(a), cwd: repo.dir, baseBranch: "main", specId: cardId,
    specPath, authority: { repository: "xonogesrs/autoloop", spec_path: "docs/spec.md" },
  });
  const j = createReviewJob({
    cardId, generation: 1, candidateIdentity: ctx.candidateIdentity,
    specId: cardId, specDigest: ctx.specIdentity.specDigest, worktreeIdentity: repo.dir,
    repoIdentity: "xonogesrs/autoloop",
  }, { root });
  assert.equal(j.ok, true, j.errors?.join(","));
  advanceState(cardId, "REQUIRED", "PREPARED", { root });
  advanceState(cardId, "PREPARED", "RUNNING", { root });
  persistFindings({ cardId, reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
  persistVerdict({ cardId, reviewerIdentity: "reviewer:ext", verdict: "PASS", summary: "v", recommendedNextAction: "STOP" }, { root });
  finalizePersisted({ cardId }, { root });
  return { ctx, specPath };
}

test("T11: stageArtifacts stages exactly the 3 canonical artifacts (staged representation)", () => {
  const repo = createTempRepo(test);
  const root = join(repo.dir, "docs", "pi-graph-output");
  const cardId = "CARD-T11";
  makeStagedChain(repo, cardId, root);
  const s = stageArtifacts({ cardId, git: (a) => repo.git(a), repoRoot: repo.dir }, { root });
  assert.equal(s.ok, true, s.errors?.join(","));
  const staged = repo.git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  const expected = canonicalArtifactRelativePaths(cardId, 1).map((p) => `docs/pi-graph-output/${p}`);
  assert.deepEqual(staged.sort(), expected.sort(), "exactly the canonical 3 staged");
});

test("T12: committed representation is accepted by the ingest staged-set derivation", () => {
  const repo = createTempRepo(test);
  const root = join(repo.dir, "docs", "pi-graph-output");
  const cardId = "CARD-T12";
  makeStagedChain(repo, cardId, root);
  stageArtifacts({ cardId, git: (a) => repo.git(a), repoRoot: repo.dir }, { root });
  // commit the artifacts (committed-before-acceptance — T12 option B)
  commit(repo, "review artifacts");
  assert.equal(repo.git(["diff", "--cached", "--name-only"]), "", "index clean");
  // replicate the ingest CLI derivation: index empty → committed-canonical set
  const expected3 = canonicalArtifactRelativePaths(cardId, 1);
  const prefix = "docs/pi-graph-output/";
  const committed = expected3.filter((p) => {
    try { repo.git(["cat-file", "-e", `HEAD:${prefix}${p}`]); return true; } catch { return false; }
  });
  assert.equal(committed.length, expected3.length, "all 3 canonical artifacts exist at HEAD");
  const job = readReviewJob(cardId, { root }).job;
  assert.equal(job.state, "STAGED");
});

// ── T13/T14 — ACCEPTED mint + idempotency ────────────────────────────────
test("T13+T14: acceptReviewJob mints ACCEPTED with content integrity; duplicate ingest idempotent", () => {
  const repo = withOrigin(createTempRepo(test));
  const root = join(repo.dir, "docs", "pi-graph-output");
  const cardId = "CARD-T13";
  const { ctx } = makeStagedChain(repo, cardId, root);
  const s = stageArtifacts({ cardId, git: (a) => repo.git(a), repoRoot: repo.dir }, { root });
  assert.equal(s.ok, true);

  const stagedSet = repo.git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean)
    .map((p) => p.replace(/^docs\/pi-graph-output\//, ""))
    .sort();
  const recomputed = {
    candidateIdentity: ctx.candidateIdentity,
    specIdentity: ctx.specIdentity,
    stagedSet,
    repositoryVerified: true,
  };
  const r = acceptReviewJob({
    cardId, implementerIdentity: "executor:impl", authorizationSource: "controller:test",
    trustedReviewerIdentity: "reviewer:ext", recomputed,
  }, { root });
  assert.equal(r.ok, true, r.code ?? r.drift?.join(","));
  const job = readReviewJob(cardId, { root }).job;
  assert.equal(job.state, "ACCEPTED");
  assert.equal(job.acceptanceAuthority, "controller:test");
  const v1 = job.stateVersion;
  // duplicate ingest → idempotent, no second mint
  const r2 = acceptReviewJob({
    cardId, implementerIdentity: "executor:impl", authorizationSource: "controller:test",
    trustedReviewerIdentity: "reviewer:ext", recomputed,
  }, { root });
  assert.equal(r2.ok, true);
  assert.equal(r2.idempotent, true);
  assert.equal(readReviewJob(cardId, { root }).job.stateVersion, v1, "no second mint");
});

// ── T15/T17 — final closeout at advanced governance HEAD ─────────────────
test("T15+T17: final closeout succeeds after evidence commits advance HEAD (candidate intact)", async () => {
  const repo = withOrigin(createTempRepo(test));
  const cardId = "CARD-T15";
  const root = join(repo.dir, "docs", "pi-graph-output");
  const outDir = join(root, cardId);
  mkdirSync(outDir, { recursive: true });
  process.env.AUTOLOOP_REVIEW_SURFACE = join(tmpdir(), `t15-surface-${process.pid}`);
  process.env.AUTOLOOP_REVIEW_ARCHIVE = join(repo.dir, "archive");

  // candidate committed first (committed-before-baseline)
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "impl.txt"), "impl\n");
  repo.git(["add", "src/impl.txt"]);
  commit(repo, "candidate");
  const candidate = repo.git(["rev-parse", "HEAD"]).trim();
  const base = repo.git(["rev-parse", "main"]).trim();

  const specPath = join(outDir, "card-spec.md");
  writeFileSync(specPath, "spec\n");
  repo.git(["add", `docs/pi-graph-output/${cardId}/card-spec.md`]);
  commit(repo, "spec");

  const baseline = captureBaselineInventory(repo.dir, { cardId });
  const ctx = deriveReviewJobContext({
    git: (a) => repo.git(a), cwd: repo.dir, baseBranch: base, specId: cardId,
    specPath, authority: { repository: "xonogesrs/autoloop", spec_path: `docs/pi-graph-output/${cardId}/card-spec.md` },
  });
  const freezeHead = ctx.candidateIdentity.currentHead; // frozen candidate = freeze-time HEAD (impl+spec)
  const state = {
    schema: CLOSEOUT_STATE_SCHEMA,
    task: { cardId, cardTitle: `${cardId} title`, cardType: "implementation" },
    requiresReview: true,
    outDir: `docs/pi-graph-output/${cardId}`,
    authorizedScope: [`docs/pi-graph-output/${cardId}/`, "src/impl.txt"],
    objective: `${cardId} closeout`,
    baseline,
    reviewCloseout: { schema: "autoloop.review-closeout/v1", bindingDigest: sha("b", 64), admissionId: sha("1", 64) },
  };
  const { statePath } = writeCardState(repo, cardId, state);
  const job = createReviewJob({
    cardId, generation: 1, candidateIdentity: ctx.candidateIdentity,
    specId: cardId, specDigest: ctx.specIdentity.specDigest, worktreeIdentity: repo.dir,
    repoIdentity: "xonogesrs/autoloop",
  }, { root });
  assert.equal(job.ok, true);

  const passGraph = {
    executionId: "t15", final: "PASS", holdCode: null, reason: null,
    scheduler: { verdict: "PASS", order: ["W1"], statuses: { W1: "passed" }, skipped: [] },
    nodeResults: [
      { nodeId: "W1", phaseExecutionId: "e1", taskType: "write", dependencies: [], final: "PASS", attempt: 0, cleanup: { worktreeRevoked: false }, reviewResult: { status: "PASS", findings: [], blockingFindings: [], recommendedAction: "PASS" } },
    ],
    transitions: [],
  };
  const r1 = await runStateDrivenCloseout({
    statePath, graphResult: passGraph, repoPath: repo.dir, cwd: repo.dir,
    outDir, surfaceDir: process.env.AUTOLOOP_REVIEW_SURFACE,
  });
  assert.equal(r1.final, "PASS", r1.reason ?? "");
  assert.ok(r1.bundle?.identity, "bundle minted");
  const bundleId = r1.bundle.identity;
  const bundleSha = r1.bundle.sha256;

  // review verdict applied to the delivered surface record
  const rec = readExternalReviewDeliveryRecord(join(process.env.AUTOLOOP_REVIEW_SURFACE, "delivery.json"));
  assert.equal(rec.ok, true);
  const applied = applyExternalReviewVerdict(rec.state, {
    verdict: "PASS", reviewerIdentity: "reviewer:ext",
    reviewedAt: new Date().toISOString(), bundleIdentity: bundleId, bundleSha256: bundleSha,
    findingsDigest: sha("f", 64),
  });
  assert.equal(applied.ok, true, applied.errors?.join(","));
  const written = writeExternalReviewDeliveryRecord({ outDir: process.env.AUTOLOOP_REVIEW_SURFACE, state: applied.state, cardId, fileName: "delivery.json" });
  assert.equal(written.ok, true, written.reason ?? "");

  // evidence commits advance HEAD after the bundle
  writeFileSync(join(outDir, "evidence.json"), "{}\n");
  repo.git(["add", "."]);
  commit(repo, "evidence");
  assert.notEqual(repo.git(["rev-parse", "HEAD"]).trim(), freezeHead, "HEAD advanced past candidate");
  assert.equal(repo.git(["status", "--porcelain"]), "", "clean tree at final closeout");

  // final closeout re-entry — candidate intact at advanced HEAD
  const r2 = await runStateDrivenCloseout({
    statePath, graphResult: passGraph, repoPath: repo.dir, cwd: repo.dir,
    outDir, surfaceDir: process.env.AUTOLOOP_REVIEW_SURFACE,
  });
  assert.equal(r2.final, "PASS", r2.reason ?? r2.holdCode ?? "");
  assert.equal(r2.stage, "REVIEW_ACCEPTED");
  assert.ok(r2.alreadyApplied);
  // descriptive closeout block reconciled
  const st2 = readCloseoutState(statePath);
  assert.equal(st2.state.closeout.externalReviewStatus, "PASS");
  assert.equal(st2.state.closeout.verdict, "PASS");
  // candidate range still resolves
  const range = resolveCandidateRange({ outDir, cardId });
  assert.equal(range.baseHead, base);
  assert.equal(range.candidateHead, freezeHead);

  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
});

// ── T16 — resealed bundle final closeout ─────────────────────────────────
test("T16: reseal generation closes with original baseline + candidate intact", async () => {
  const repo = withOrigin(createTempRepo(test));
  const cardId = "CARD-T16";
  const root = join(repo.dir, "docs", "pi-graph-output");
  const outDir = join(root, cardId);
  mkdirSync(outDir, { recursive: true });
  process.env.AUTOLOOP_REVIEW_SURFACE = join(tmpdir(), `t16-surface-${process.pid}`);
  process.env.AUTOLOOP_REVIEW_ARCHIVE = join(repo.dir, "archive-16");

  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "impl.txt"), "impl\n");
  repo.git(["add", "src/impl.txt"]);
  commit(repo, "candidate");
  const base = repo.git(["rev-parse", "main"]).trim();
  const specPath = join(outDir, "card-spec.md");
  writeFileSync(specPath, "spec\n");
  repo.git(["add", `docs/pi-graph-output/${cardId}/card-spec.md`]);
  commit(repo, "spec");

  const baseline = captureBaselineInventory(repo.dir, { cardId });
  const ctx = deriveReviewJobContext({
    git: (a) => repo.git(a), cwd: repo.dir, baseBranch: base, specId: cardId,
    specPath, authority: { repository: "xonogesrs/autoloop", spec_path: `docs/pi-graph-output/${cardId}/card-spec.md` },
  });
  const freezeHead = ctx.candidateIdentity.currentHead; // frozen candidate = freeze-time HEAD (impl+spec)
  const state = {
    schema: CLOSEOUT_STATE_SCHEMA,
    task: { cardId, cardTitle: `${cardId} title`, cardType: "implementation" },
    requiresReview: true,
    outDir: `docs/pi-graph-output/${cardId}`,
    authorizedScope: [`docs/pi-graph-output/${cardId}/`, "src/impl.txt"],
    objective: `${cardId} closeout`,
    baseline,
    reviewCloseout: { schema: "autoloop.review-closeout/v1", bindingDigest: sha("b", 64), admissionId: sha("1", 64) },
  };
  const { statePath } = writeCardState(repo, cardId, state);
  createReviewJob({
    cardId, generation: 1, candidateIdentity: ctx.candidateIdentity,
    specId: cardId, specDigest: ctx.specIdentity.specDigest, worktreeIdentity: repo.dir,
    repoIdentity: "xonogesrs/autoloop",
  }, { root });

  const passGraph = {
    executionId: "t16", final: "PASS", holdCode: null, reason: null,
    scheduler: { verdict: "PASS", order: ["W1"], statuses: { W1: "passed" }, skipped: [] },
    nodeResults: [
      { nodeId: "W1", phaseExecutionId: "e1", taskType: "write", dependencies: [], final: "PASS", attempt: 0, cleanup: { worktreeRevoked: false }, reviewResult: { status: "PASS", findings: [], blockingFindings: [], recommendedAction: "PASS" } },
    ],
    transitions: [],
  };
  const r1 = await runStateDrivenCloseout({
    statePath, graphResult: passGraph, repoPath: repo.dir, cwd: repo.dir,
    outDir, surfaceDir: process.env.AUTOLOOP_REVIEW_SURFACE,
  });
  assert.equal(r1.final, "PASS", r1.reason ?? "");
  const bundleId1 = r1.bundle.identity;
  const bundleSha1 = r1.bundle.sha256;

  // reseal generation: supersedes the first bundle, keeps the ORIGINAL baseline
  const resealState = {
    ...state,
    supersedes: { reviewBundleIdentity: bundleId1, reviewBundleSha256: bundleSha1, bundlePath: join(outDir, "card-closeout-bundle-r1.txt"), verdict: null },
    generationType: "surface-reseal",
  };
  const resealPath = writeCardState(repo, cardId, resealState).statePath;
  // The reseal generation delivers to the CARD'S OWN surface dir (the shared
  // external surface is occupied by the first generation's trio — the
  // governed deliverer fail-closes on an unresolved occupant by design).
  const resealSurface = join(outDir, "surface");
  const rReseal = await runStateDrivenCloseout({
    statePath: resealPath, graphResult: passGraph, repoPath: repo.dir, cwd: repo.dir,
    outDir, surfaceDir: resealSurface,
  });
  assert.equal(rReseal.final, "PASS", rReseal.reason ?? "");
  assert.notEqual(rReseal.bundle.identity, bundleId1, "reseal = new bundle identity");
  const bundleId2 = rReseal.bundle.identity;
  const bundleSha2 = rReseal.bundle.sha256;

  // verdict on the resealed bundle (same substantive review, re-bound)
  const rec = readExternalReviewDeliveryRecord(join(resealSurface, "delivery.json"));
  const applied = applyExternalReviewVerdict(rec.state, {
    verdict: "PASS", reviewerIdentity: "reviewer:ext",
    reviewedAt: new Date().toISOString(), bundleIdentity: bundleId2, bundleSha256: bundleSha2,
    findingsDigest: sha("f", 64),
  });
  assert.equal(applied.ok, true, applied.errors?.join(","));
  writeExternalReviewDeliveryRecord({ outDir: resealSurface, state: applied.state, cardId, fileName: "delivery.json" });

  // reseal did NOT replace the baseline
  const stAfter = readCloseoutState(resealPath);
  assert.equal(stAfter.state.baseline.contentDigest, baseline.contentDigest, "baseline inherited across reseal");

  // final closeout of the resealed generation
  const rFinal = await runStateDrivenCloseout({
    statePath: resealPath, graphResult: passGraph, repoPath: repo.dir, cwd: repo.dir,
    outDir, surfaceDir: resealSurface,
  });
  assert.equal(rFinal.final, "PASS", rFinal.reason ?? rFinal.holdCode ?? "");
  assert.equal(rFinal.stage, "REVIEW_ACCEPTED");

  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
});

// ── T18 — complete real lifecycle ────────────────────────────────────────
test("T18: complete lifecycle authority→admission→candidate→review→STAGED→ACCEPTED→closeout→commit", async () => {
  const repo = withOrigin(createTempRepo(test));
  const cardId = "CARD-T18";
  const root = join(repo.dir, "docs", "pi-graph-output");
  const outDir = join(root, cardId);
  mkdirSync(outDir, { recursive: true });
  process.env.AUTOLOOP_REVIEW_SURFACE = join(tmpdir(), `t18-surface-${process.pid}`);
  process.env.AUTOLOOP_REVIEW_ARCHIVE = join(repo.dir, "archive-18");

  // 1. authority issued (schema-valid) inside the card outDir — the
  // candidate-domain excludes docs/pi-graph-output, so the record never
  // enters the implementation delta.
  const record = makeV3Record(repo, cardId);
  const issued = writeAuthorityRecordValidated({ path: join(outDir, "lifecycle-authorization.json"), record });
  assert.equal(issued.ok, true);
  // 2. admission binding projected
  const specPath = join(outDir, "card-spec.md");
  writeFileSync(specPath, "spec\n");
  const proj = projectReviewCloseout({ record, specBytes: readFileSync(specPath) });
  assert.equal(proj.ok, true, proj.errors?.join(","));
  const binding = proj.binding;
  // governance inputs committed before the baseline capture (clean baseline)
  repo.git(["add", "."]);
  commit(repo, "governance inputs");
  // 3. baseline frozen
  const baseline = captureBaselineInventory(repo.dir, { cardId });
  // 4. implementation committed
  mkdirSync(join(repo.dir, "src"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "impl.txt"), "impl\n");
  repo.git(["add", "src/impl.txt"]);
  commit(repo, "candidate");
  // 5. candidate frozen via review-job
  const ctx = deriveReviewJobContext({
    git: (a) => repo.git(a), cwd: repo.dir, baseBranch: binding.base, specId: cardId,
    specPath, authority: { repository: "xonogesrs/autoloop", spec_path: binding.spec_path },
  });
  const state = closeoutStateForBinding({
    binding, bindingDigest: reviewCloseoutBindingDigest(binding), admissionId: sha("1", 64),
    resolvedOutDir: outDir, baseline,
  });
  const { statePath } = writeCardState(repo, cardId, state);
  const identity = buildLifecycleIdentity({
    admission: { admission_id: sha("1", 64) }, binding, resolvedOutDir: outDir,
    baselineContentDigest: baseline.contentDigest,
  });
  const j = createReviewJob({
    cardId, generation: 1, candidateIdentity: ctx.candidateIdentity,
    specId: cardId, specDigest: ctx.specIdentity.specDigest, lifecycleIdentity: identity,
    worktreeIdentity: repo.dir, repoIdentity: "xonogesrs/autoloop",
  }, { root });
  assert.equal(j.ok, true);
  // 6. review artifacts
  advanceState(cardId, "REQUIRED", "PREPARED", { root });
  advanceState(cardId, "PREPARED", "RUNNING", { root });
  persistFindings({ cardId, reviewerIdentity: "reviewer:ext", findings: [], summary: "f" }, { root });
  persistVerdict({ cardId, reviewerIdentity: "reviewer:ext", verdict: "PASS", summary: "v", recommendedNextAction: "STOP" }, { root });
  finalizePersisted({ cardId }, { root });
  stageArtifacts({ cardId, git: (a) => repo.git(a), repoRoot: repo.dir }, { root });
  // 7. Controller ACCEPTED (content integrity + staged set + repo verified)
  const stagedSet = repo.git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean)
    .map((p) => p.replace(/^docs\/pi-graph-output\//, ""))
    .sort();
  const acc = acceptReviewJob({
    cardId, implementerIdentity: "executor:impl", authorizationSource: "controller:test",
    trustedReviewerIdentity: "reviewer:ext",
    recomputed: {
      candidateIdentity: ctx.candidateIdentity,
      specIdentity: ctx.specIdentity,
      stagedSet,
      repositoryVerified: productionRemoteMatch(ctx.repositoryRemote, "xonogesrs/autoloop"),
    },
  }, { root });
  assert.equal(acc.ok, true, acc.code ?? acc.drift?.join(","));
  assert.equal(readReviewJob(cardId, { root }).job.state, "ACCEPTED");
  // ingest-side chain validation passes on the real chain
  const st2 = readCloseoutState(statePath);
  const ingest = validateJobLifecycleIdentityForIngest({
    job: readReviewJob(cardId, { root }).job, record, state: st2.state, repoRoot: repo.dir,
  });
  assert.equal(ingest.ok, true, ingest.drift?.join(","));

  // 8. bundle + external review
  const passGraph = {
    executionId: "t18", final: "PASS", holdCode: null, reason: null,
    scheduler: { verdict: "PASS", order: ["W1"], statuses: { W1: "passed" }, skipped: [] },
    nodeResults: [
      { nodeId: "W1", phaseExecutionId: "e1", taskType: "write", dependencies: [], final: "PASS", attempt: 0, cleanup: { worktreeRevoked: false }, reviewResult: { status: "PASS", findings: [], blockingFindings: [], recommendedAction: "PASS" } },
    ],
    transitions: [],
  };
  const r1 = await runStateDrivenCloseout({
    statePath, graphResult: passGraph, repoPath: repo.dir, cwd: repo.dir,
    outDir, surfaceDir: process.env.AUTOLOOP_REVIEW_SURFACE,
  });
  assert.equal(r1.final, "PASS", r1.reason ?? "");
  const rec = readExternalReviewDeliveryRecord(join(process.env.AUTOLOOP_REVIEW_SURFACE, "delivery.json"));
  const applied = applyExternalReviewVerdict(rec.state, {
    verdict: "PASS", reviewerIdentity: "reviewer:ext",
    reviewedAt: new Date().toISOString(), bundleIdentity: r1.bundle.identity, bundleSha256: r1.bundle.sha256,
    findingsDigest: sha("f", 64),
  });
  assert.equal(applied.ok, true, applied.errors?.join(","));
  writeExternalReviewDeliveryRecord({ outDir: process.env.AUTOLOOP_REVIEW_SURFACE, state: applied.state, cardId, fileName: "delivery.json" });

  // 9. final closeout
  const rFinal = await runStateDrivenCloseout({
    statePath, graphResult: passGraph, repoPath: repo.dir, cwd: repo.dir,
    outDir, surfaceDir: process.env.AUTOLOOP_REVIEW_SURFACE,
  });
  assert.equal(rFinal.final, "PASS", rFinal.reason ?? rFinal.holdCode ?? "");
  assert.equal(rFinal.stage, "REVIEW_ACCEPTED");

  // 10. governance commit of everything
  repo.git(["add", "."]);
  commit(repo, "governance evidence");
  assert.equal(repo.git(["status", "--porcelain"]), "");
  // candidate bytes still intact at the new HEAD
  const after = deriveReviewJobContext({
    git: (a) => repo.git(a), cwd: repo.dir, baseBranch: binding.base, specId: cardId,
    specPath, authority: { repository: "xonogesrs/autoloop", spec_path: binding.spec_path },
  });
  assert.equal(candidateIntegrityDrift(ctx.candidateIdentity, after.candidateIdentity).length, 0, "candidate intact after governance commit");

  delete process.env.AUTOLOOP_REVIEW_SURFACE;
  delete process.env.AUTOLOOP_REVIEW_ARCHIVE;
});
