// C3C controlled local commit side-effect boundary.
//
// Converts one already-reviewed, already-materialized candidate
// (CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE, produced by
// reviewed-commit-candidate.mjs) into exactly one local Git commit: a direct
// `git commit-tree` from the candidate tree object, followed by an atomic
// compare-and-swap `git update-ref`. Never runs `git commit`, never pushes,
// never seals, never reruns the executor, never mutates the candidate tree.
//
// Deliberately does not touch checkpoint-store.mjs CURRENT/KNOWN_CONTROL_STATES:
// operator-tick wiring is out of scope for this card, so nothing reads CURRENT
// for this transition yet. Source of truth is the C2D journal
// (side_effect_class: "commit") plus this module's own immutable
// commit-intents/commit-evidence/commit-completions artifacts, mirroring the
// candidate.json / review artifact pattern in reviewed-commit-candidate.mjs.
//
// Commit metadata (author/committer identity + dates, subject, body, signing
// mode) is fixed once in the immutable intent and never regenerated on
// retry. Combined with an unsigned commit-tree invocation, this makes
// commit-tree a pure function of the intent: crash recovery recomputes the
// same commit OID deterministically rather than guessing at an orphan object.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { digestOf } from "../canonical-digest.mjs";
import {
  C2dHoldError, ensureDir0700, writeJsonExclusiveCreate, assertNotSymlink,
  fireHook, sha256Hex,
} from "./fs-atomic.mjs";
import { assertWritePermit } from "./permit.mjs";
import { collectFingerprint } from "./fingerprint.mjs";
import { publishIntent, publishComplete, readIntent, readComplete, validateContinuity } from "./journal.mjs";
import { mintTransitionId } from "./execution-id.mjs";
import {
  validateCandidate, candidateManifestDigest, assertCandidateRef,
  validateReviewerCandidateBinding, requireReviewerArtifact,
} from "./reviewed-commit-candidate.mjs";
import { requireCommitAuthorization, CANONICAL_TARGET_REF } from "./commit-authorization.mjs";
import { assertRepositoryMutationLock } from "./repository-mutation-lock.mjs";

export const C3C_HOLD = Object.freeze({
  REVIEW_AUTHORITY_INVALID: "HOLD / C3C_REVIEW_AUTHORITY_INVALID",
  REVIEW_REVISION_STALE: "HOLD / C3C_REVIEW_REVISION_STALE",
  CANDIDATE_ARTIFACT_MISMATCH: "HOLD / C3C_CANDIDATE_ARTIFACT_MISMATCH",
  CANDIDATE_REF_TREE_MISMATCH: "HOLD / C3C_CANDIDATE_REF_TREE_MISMATCH",
  CANDIDATE_PARENT_STALE: "HOLD / C3C_CANDIDATE_PARENT_STALE",
  REPOSITORY_IDENTITY_MISMATCH: "HOLD / C3C_REPOSITORY_IDENTITY_MISMATCH",
  DETACHED_OR_WRONG_BRANCH: "HOLD / C3C_DETACHED_OR_WRONG_BRANCH",
  ACTIVE_GIT_OPERATION: "HOLD / C3C_ACTIVE_GIT_OPERATION",
  MATERIALIZATION_MISMATCH: "HOLD / C3C_MATERIALIZATION_MISMATCH",
  CONFLICTING_INTENT: "HOLD / C3C_CONFLICTING_INTENT",
  SIGNING_POLICY_UNSUPPORTED: "HOLD / C3C_SIGNING_POLICY_UNSUPPORTED",
  COMMIT_TREE_FAILED: "HOLD / C3C_COMMIT_TREE_FAILED",
  INVALID_COMMIT_OID: "HOLD / C3C_INVALID_COMMIT_OID",
  HEAD_DRIFT_AT_UPDATE: "HOLD / C3C_HEAD_DRIFT_AT_UPDATE",
  COMMIT_VERIFICATION_FAILED: "HOLD / C3C_COMMIT_VERIFICATION_FAILED",
  EXISTING_COMMIT_MISMATCH: "HOLD / C3C_EXISTING_COMMIT_MISMATCH",
  COMPLETION_PERSISTENCE_FAILED_RECOVERABLE: "HOLD / C3C_COMPLETION_PERSISTENCE_FAILED_RECOVERABLE",
  MALFORMED_INTENT: "HOLD / C3C_MALFORMED_INTENT",
  AMBIGUOUS_RECONCILIATION_STATE: "HOLD / C3C_AMBIGUOUS_RECONCILIATION_STATE",
  INLINE_COMMIT_AUTHORIZATION_FORBIDDEN: "HOLD / C3C_INLINE_COMMIT_AUTHORIZATION_FORBIDDEN",
});

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TARGET_REF_RE = /^refs\/heads\/[^\s~^:?*[\]\\]+$/;

function fail(code, message, details) { throw new C2dHoldError(code, message, details); }

function git(cwd, args, input) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), error: r.error };
}
function gitOk(cwd, args, code, message, input) {
  const r = git(cwd, args, input);
  if (r.status !== 0) fail(code, message || `git ${args.join(" ")} failed`, { stderr: r.stderr });
  return r.stdout;
}
function gitEnv(cwd, args, env, input) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input, env: { ...process.env, ...env } });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), error: r.error };
}

function commitIntentDir(execDir) { return join(execDir, "commit-intents"); }
export function commitIntentPath(execDir, key) { return join(commitIntentDir(execDir), `${key}.json`); }
function commitEvidenceDir(execDir) { return join(execDir, "commit-evidence"); }
export function commitEvidencePath(execDir, key) { return join(commitEvidenceDir(execDir), `${key}.json`); }
function commitCompletionDir(execDir) { return join(execDir, "commit-completions"); }
export function commitCompletionPath(execDir, key) { return join(commitCompletionDir(execDir), `${key}.json`); }

export function assembleCommitMessage(subject, body) {
  const s = String(subject).trim();
  const b = String(body || "").trim();
  return b ? `${s}\n\n${b}\n` : `${s}\n`;
}

export function buildCommitBody(humanBody, trailers) {
  const trailerBlock = trailers.map(([k, v]) => `${k}: ${v}`).join("\n");
  const h = String(humanBody || "").trim();
  return h ? `${h}\n\n${trailerBlock}` : trailerBlock;
}

const INTENT_REQUIRED = ["schema", "idempotency_key", "execution_id", "card_id", "card_revision", "candidate_id", "candidate_revision", "candidate_tree", "candidate_manifest_digest", "expected_head", "retention_reference", "review_artifact_digest", "review_verdict", "repository_identity", "git_common_dir_identity", "target_ref", "commit_subject", "commit_body", "author_name", "author_email", "author_date", "committer_name", "committer_email", "committer_date", "signing_mode", "authorization_id", "authorization_canonical_digest", "created_at"];

export function validateCommitIntentFields(intent) {
  const errors = [];
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return { valid: false, errors: ["intent_not_object"] };
  for (const key of Object.keys(intent)) if (!INTENT_REQUIRED.includes(key)) errors.push(`unknown_${key}`);
  for (const k of INTENT_REQUIRED) if (!(k in intent)) errors.push(`missing_${k}`);
  if (intent.schema !== "autoloop.commit-intent/v1") errors.push("schema_invalid");
  if (!SHA256.test(intent.idempotency_key || "")) errors.push("idempotency_key_invalid");
  if (!/^exec_[0-9a-f]{32}$/.test(intent.execution_id || "")) errors.push("execution_id_invalid");
  if (!/^cand_exec_[0-9a-f]{32}_r[1-9][0-9]*$/.test(intent.candidate_id || "")) errors.push("candidate_id_invalid");
  if (!Number.isInteger(intent.candidate_revision) || intent.candidate_revision < 1) errors.push("candidate_revision_invalid");
  for (const k of ["candidate_tree", "expected_head"]) if (!SHA.test(intent[k] || "")) errors.push(`${k}_invalid`);
  for (const k of ["candidate_manifest_digest", "review_artifact_digest"]) if (!SHA256.test(intent[k] || "")) errors.push(`${k}_invalid`);
  if (intent.review_verdict !== "PASS") errors.push("review_verdict_invalid");
  if (!TARGET_REF_RE.test(intent.target_ref || "")) errors.push("target_ref_invalid");
  if (intent.signing_mode !== "none") errors.push("signing_mode_invalid");
  if (typeof intent.commit_subject !== "string" || intent.commit_subject.length === 0) errors.push("commit_subject_invalid");
  if (typeof intent.commit_body !== "string") errors.push("commit_body_invalid");
  for (const k of ["author_name", "author_email", "committer_name", "committer_email"]) if (typeof intent[k] !== "string" || intent[k].length === 0) errors.push(`${k}_invalid`);
  for (const k of ["author_date", "committer_date"]) if (typeof intent[k] !== "string" || Number.isNaN(Date.parse(intent[k]))) errors.push(`${k}_invalid`);
  for (const k of ["authorization_id", "authorization_canonical_digest"]) if (!SHA256.test(intent[k] || "")) errors.push(`${k}_invalid`);
  if (errors.length === 0 && computeIdempotencyKey(intent) !== intent.idempotency_key) errors.push("idempotency_key_mismatch");
  return { valid: errors.length === 0, errors };
}

export function computeIdempotencyKey(f) {
  return digestOf({
    candidate_id: f.candidate_id,
    candidate_revision: f.candidate_revision,
    candidate_tree: f.candidate_tree,
    candidate_manifest_digest: f.candidate_manifest_digest,
    review_artifact_digest: f.review_artifact_digest,
    review_verdict: f.review_verdict,
    target_ref: f.target_ref,
    commit_subject: f.commit_subject,
    commit_body: f.commit_body,
    author_name: f.author_name,
    author_email: f.author_email,
    author_date: f.author_date,
    committer_name: f.committer_name,
    committer_email: f.committer_email,
    committer_date: f.committer_date,
    signing_mode: f.signing_mode,
  });
}

function readCommitIntent(execDir, key) {
  const p = commitIntentPath(execDir, key);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  return JSON.parse(readFileSync(p, "utf8"));
}
function readCommitEvidence(execDir, key) {
  const p = commitEvidencePath(execDir, key);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  return JSON.parse(readFileSync(p, "utf8"));
}
export function readCommitCompletion(execDir, key) {
  const p = commitCompletionPath(execDir, key);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  return JSON.parse(readFileSync(p, "utf8"));
}

function gitPath(repoRoot, code, name) {
  return gitOk(repoRoot, ["rev-parse", "--git-path", name], code, `git-path ${name} failed`);
}

function assertNoActiveGitOperation(repoRoot) {
  for (const name of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "BISECT_LOG"]) {
    const p = gitPath(repoRoot, C3C_HOLD.ACTIVE_GIT_OPERATION, name);
    if (existsSync(join(repoRoot, p)) || existsSync(p)) fail(C3C_HOLD.ACTIVE_GIT_OPERATION, `active git operation: ${name}`);
  }
}

function assertSigningPolicySatisfied(repoRoot) {
  const r = git(repoRoot, ["config", "--get", "commit.gpgsign"]);
  if (r.status === 0 && /^true$/i.test(r.stdout)) {
    fail(C3C_HOLD.SIGNING_POLICY_UNSUPPORTED, "commit.gpgsign=true requires signed commits; unsupported in C3C v1");
  }
}

/**
 * Repeat-cheap, live pre-effect safety checks. Never trusts the caller's
 * in-memory claims about prior stage state; re-observes Git and the durable
 * candidate/review artifacts. `authorization` is the frozen record already
 * returned by `requireCommitAuthorization` — every candidate/review binding
 * on it was already verified there, so this gate only re-checks expiry,
 * target-ref sanity, and live Git state.
 */
function assertPreCommitGate({ repoRoot, execDir, candidate, review, authorization }) {
  const candCheck = validateCandidate(candidate);
  if (!candCheck.valid) fail(C3C_HOLD.CANDIDATE_ARTIFACT_MISMATCH, candCheck.errors.join(","));
  validateReviewerCandidateBinding(candidate, review);
  if (review.review_verdict !== "PASS") fail(C3C_HOLD.REVIEW_AUTHORITY_INVALID, "review not PASS");
  // Strict read: the durable reviewer artifact must already exist. C3C is
  // never its first writer — requireReviewerArtifact only reads, validates
  // digest/binding against `candidate` and the caller-supplied `review`, and
  // fails closed (CANDIDATE_HOLD.REVIEW_IDENTITY_MISSING/_MISMATCH) rather
  // than creating or substituting one.
  requireReviewerArtifact(execDir, candidate, review);
  if (Date.parse(candidate.expires_at) <= Date.now()) fail(C3C_HOLD.CANDIDATE_PARENT_STALE, "candidate expired");
  if (!TARGET_REF_RE.test(authorization.target_ref || "")) fail(C3C_HOLD.DETACHED_OR_WRONG_BRANCH, "target_ref invalid");

  assertNoActiveGitOperation(repoRoot);
  assertSigningPolicySatisfied(repoRoot);
  assertCandidateRef(repoRoot, candidate);

  const branchName = authorization.target_ref.slice("refs/heads/".length);
  const symbolic = git(repoRoot, ["symbolic-ref", "-q", "HEAD"]);
  if (symbolic.status !== 0 || symbolic.stdout !== authorization.target_ref) {
    fail(C3C_HOLD.DETACHED_OR_WRONG_BRANCH, "detached HEAD or wrong branch checked out");
  }
  // Note: the materialized-but-uncommitted target is expected to read as
  // "dirty" relative to HEAD (worktree holds candidate_tree, HEAD is still
  // expected_head) — that is the exact state this stage exists to commit, so
  // fp.dirty is NOT checked here. Worktree/index exactness against
  // candidate_tree is checked separately below.
  const fp = collectFingerprint(repoRoot);
  if (fp.repository_root_identity !== candidate.repository_identity
    || fp.git_common_dir_identity !== candidate.git_common_dir_identity
    || fp.expected_ref !== branchName) {
    fail(C3C_HOLD.REPOSITORY_IDENTITY_MISMATCH, "live repository identity/branch mismatch");
  }
  if (fp.expected_head !== candidate.expected_head) fail(C3C_HOLD.CANDIDATE_PARENT_STALE, "live HEAD no longer matches candidate expected_head");
  const refResolved = git(repoRoot, ["rev-parse", authorization.target_ref]);
  if (refResolved.status !== 0 || refResolved.stdout !== candidate.expected_head) {
    fail(C3C_HOLD.CANDIDATE_PARENT_STALE, "target ref does not resolve to expected_head");
  }
  const indexTree = gitOk(repoRoot, ["write-tree"], C3C_HOLD.MATERIALIZATION_MISMATCH);
  if (indexTree !== candidate.candidate_tree) fail(C3C_HOLD.MATERIALIZATION_MISMATCH, "index tree does not equal candidate tree");
  if (git(repoRoot, ["diff", "--quiet"]).status !== 0) fail(C3C_HOLD.MATERIALIZATION_MISMATCH, "worktree not clean relative to index");
  if (git(repoRoot, ["ls-files", "--others", "--exclude-standard"]).stdout) fail(C3C_HOLD.MATERIALIZATION_MISMATCH, "untracked files present");

  return { branchName };
}

function commitTreeEffect(repoRoot, intent) {
  const message = assembleCommitMessage(intent.commit_subject, intent.commit_body);
  const env = {
    GIT_AUTHOR_NAME: intent.author_name, GIT_AUTHOR_EMAIL: intent.author_email, GIT_AUTHOR_DATE: intent.author_date,
    GIT_COMMITTER_NAME: intent.committer_name, GIT_COMMITTER_EMAIL: intent.committer_email, GIT_COMMITTER_DATE: intent.committer_date,
  };
  const r = gitEnv(repoRoot, ["-c", "commit.gpgsign=false", "commit-tree", intent.candidate_tree, "-p", intent.expected_head], env, message);
  if (r.status !== 0) fail(C3C_HOLD.COMMIT_TREE_FAILED, "commit-tree failed", { stderr: r.stderr });
  if (!SHA.test(r.stdout)) fail(C3C_HOLD.INVALID_COMMIT_OID, "commit-tree did not return a valid OID");
  return r.stdout;
}

function authorshipDigest(intent) {
  return digestOf({
    author_name: intent.author_name, author_email: intent.author_email, author_date: intent.author_date,
    committer_name: intent.committer_name, committer_email: intent.committer_email, committer_date: intent.committer_date,
    signing_mode: intent.signing_mode,
  });
}

function verifyCommittedState(repoRoot, intent, commitOid) {
  const type = gitOk(repoRoot, ["cat-file", "-t", commitOid], C3C_HOLD.COMMIT_VERIFICATION_FAILED);
  if (type !== "commit") fail(C3C_HOLD.COMMIT_VERIFICATION_FAILED, "commit oid is not a commit object");
  const parents = gitOk(repoRoot, ["show", "-s", "--format=%P", commitOid], C3C_HOLD.COMMIT_VERIFICATION_FAILED).split(" ").filter(Boolean);
  if (parents.length !== 1 || parents[0] !== intent.expected_head) fail(C3C_HOLD.COMMIT_VERIFICATION_FAILED, "commit parent mismatch");
  const treeOid = gitOk(repoRoot, ["rev-parse", `${commitOid}^{tree}`], C3C_HOLD.COMMIT_VERIFICATION_FAILED);
  if (treeOid !== intent.candidate_tree) fail(C3C_HOLD.COMMIT_VERIFICATION_FAILED, "commit tree mismatch");
  const rawMessage = gitOk(repoRoot, ["show", "-s", "--format=%B", commitOid], C3C_HOLD.COMMIT_VERIFICATION_FAILED);
  const expectedMessage = assembleCommitMessage(intent.commit_subject, intent.commit_body);
  if (rawMessage.replace(/\s+$/, "") !== expectedMessage.replace(/\s+$/, "")) fail(C3C_HOLD.COMMIT_VERIFICATION_FAILED, "commit message mismatch");
  const authorName = gitOk(repoRoot, ["show", "-s", "--format=%an", commitOid], C3C_HOLD.COMMIT_VERIFICATION_FAILED);
  const authorEmail = gitOk(repoRoot, ["show", "-s", "--format=%ae", commitOid], C3C_HOLD.COMMIT_VERIFICATION_FAILED);
  const committerName = gitOk(repoRoot, ["show", "-s", "--format=%cn", commitOid], C3C_HOLD.COMMIT_VERIFICATION_FAILED);
  const committerEmail = gitOk(repoRoot, ["show", "-s", "--format=%ce", commitOid], C3C_HOLD.COMMIT_VERIFICATION_FAILED);
  if (authorName !== intent.author_name || authorEmail !== intent.author_email
    || committerName !== intent.committer_name || committerEmail !== intent.committer_email) {
    fail(C3C_HOLD.COMMIT_VERIFICATION_FAILED, "commit author/committer identity mismatch");
  }
  const branchResolved = gitOk(repoRoot, ["rev-parse", intent.target_ref], C3C_HOLD.COMMIT_VERIFICATION_FAILED);
  if (branchResolved !== commitOid) fail(C3C_HOLD.COMMIT_VERIFICATION_FAILED, "target ref does not resolve to commit oid");
  const changedPaths = gitOk(repoRoot, ["diff", "--name-only", "-z", intent.expected_head, commitOid], C3C_HOLD.COMMIT_VERIFICATION_FAILED)
    .split("\0").filter(Boolean).sort();
  if (git(repoRoot, ["diff", "--quiet"]).status !== 0) fail(C3C_HOLD.COMMIT_VERIFICATION_FAILED, "worktree not clean after commit");
  if (git(repoRoot, ["diff", "--cached", "--quiet"]).status !== 0) fail(C3C_HOLD.COMMIT_VERIFICATION_FAILED, "staged index not clean after commit");
  let ahead = 0, behind = 0;
  const originRef = git(repoRoot, ["rev-parse", `origin/${intent.target_ref.slice("refs/heads/".length)}`]);
  if (originRef.status === 0) {
    const counts = git(repoRoot, ["rev-list", "--left-right", "--count", `${commitOid}...${originRef.stdout}`]);
    if (counts.status === 0) { const [a, b] = counts.stdout.split(/\s+/).map(Number); ahead = a; behind = b; }
  }
  return { commit_sha: commitOid, parent_sha: intent.expected_head, tree_sha: treeOid, changed_paths: changedPaths, ahead, behind };
}

function buildCompletion(intent, verification) {
  return {
    schema: "autoloop.commit-completion/v1",
    idempotency_key: intent.idempotency_key,
    candidate_id: intent.candidate_id,
    candidate_manifest_digest: intent.candidate_manifest_digest,
    review_artifact_digest: intent.review_artifact_digest,
    commit_sha: verification.commit_sha,
    parent_sha: verification.parent_sha,
    tree_sha: verification.tree_sha,
    target_ref: intent.target_ref,
    commit_message_digest: sha256Hex(Buffer.from(assembleCommitMessage(intent.commit_subject, intent.commit_body), "utf8")),
    authorship_digest: authorshipDigest(intent),
    changed_paths: verification.changed_paths,
    verified: true,
    ahead: verification.ahead,
    behind: verification.behind,
    completed_at: new Date().toISOString(),
  };
}

function writeCommitCompletionIfAbsent(execDir, completion) {
  const p = commitCompletionPath(execDir, completion.idempotency_key);
  if (existsSync(p)) {
    const existing = JSON.parse(readFileSync(p, "utf8"));
    if (existing.commit_sha !== completion.commit_sha) fail(C3C_HOLD.EXISTING_COMMIT_MISMATCH, "durable completion conflict");
    return existing;
  }
  ensureDir0700(commitCompletionDir(execDir));
  writeJsonExclusiveCreate(p, completion, {
    hookBeforeCreate: "before_c3c_completion_temp_write",
    hookBeforeLink: "before_c3c_completion_link",
    hookAfterCreate: "after_c3c_completion_create",
  });
  return completion;
}

/**
 * Entry point. Converts an already-reviewed, already-materialized candidate
 * into exactly one local commit. Idempotent: a repeated call with the same
 * logical commit request (same candidate + review + durable authorization)
 * returns the existing completion without invoking Git again.
 *
 * Never accepts caller-supplied commit authority: the caller may not pass a
 * `commitAuthorization` property at all (rejected closed, see
 * INLINE_COMMIT_AUTHORIZATION_FORBIDDEN below), and every field that
 * determines the commit (target ref, subject, body, author/committer
 * identity and dates) is sourced exclusively from the durable
 * `commit-authorization.json` artifact, strict-read via
 * `requireCommitAuthorization` and bound with the full 11-field
 * expectedBindings contract. There is no environment/current-time/ambient-
 * identity fallback anywhere in this path.
 */
export function commitMaterializedCandidate(opts) {
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) {
    fail(C3C_HOLD.MALFORMED_INTENT, "options object required");
  }
  if ("commitAuthorization" in opts) {
    fail(C3C_HOLD.INLINE_COMMIT_AUTHORIZATION_FORBIDDEN, "caller-supplied commitAuthorization is forbidden; commit authority is strict-read only from the durable commit-authorization.json artifact");
  }
  const { repoRoot, execDir, permit, candidate, review, repositoryLock, invocationCounters } = opts;

  assertRepositoryMutationLock(repositoryLock, collectFingerprint(repoRoot), "commit");

  assertWritePermit(execDir, permit);
  const candCheck = validateCandidate(candidate);
  if (!candCheck.valid) fail(C3C_HOLD.CANDIDATE_ARTIFACT_MISMATCH, candCheck.errors.join(","));
  validateReviewerCandidateBinding(candidate, review);
  if (review.review_verdict !== "PASS") fail(C3C_HOLD.REVIEW_AUTHORITY_INVALID, "review not PASS");
  // Strict read: durable reviewer artifact must already exist; C3C is never
  // its first writer (see requireReviewerArtifact contract note below).
  const artifact = requireReviewerArtifact(execDir, candidate, review);

  // Full 11-field contextual binding. Every value here comes from an
  // already-verified durable fact (the candidate artifact or the strict-read
  // reviewer artifact) or from the sealed target-ref policy — never from the
  // caller — so requireCommitAuthorization can prove the on-disk
  // authorization belongs to exactly this candidate/review/execution/HEAD/
  // tree/paths, not merely that some authorization file exists.
  const expectedBindings = {
    card_id: candidate.card_id,
    card_revision: candidate.card_revision,
    execution_id: candidate.execution_id,
    candidate_id: candidate.candidate_id,
    candidate_revision: candidate.candidate_revision,
    review_artifact_digest: artifact.review_artifact_digest,
    expected_head: candidate.expected_head,
    target_ref: CANONICAL_TARGET_REF,
    candidate_tree: candidate.candidate_tree,
    candidate_manifest_digest: candidate.candidate_manifest_digest,
    exact_changed_paths: candidate.exact_changed_paths,
  };
  const authorization = requireCommitAuthorization(execDir, expectedBindings);

  const now = new Date().toISOString();
  const intentFields = {
    schema: "autoloop.commit-intent/v1",
    execution_id: permit.execution_id,
    card_id: authorization.card_id,
    card_revision: authorization.card_revision,
    candidate_id: candidate.candidate_id,
    candidate_revision: candidate.candidate_revision,
    candidate_tree: candidate.candidate_tree,
    candidate_manifest_digest: candidate.candidate_manifest_digest,
    expected_head: candidate.expected_head,
    retention_reference: candidate.retention_reference,
    review_artifact_digest: artifact.review_artifact_digest,
    review_verdict: artifact.review_verdict,
    repository_identity: candidate.repository_identity,
    git_common_dir_identity: candidate.git_common_dir_identity,
    target_ref: authorization.target_ref,
    commit_subject: authorization.commit_subject,
    commit_body: authorization.commit_body,
    author_name: authorization.author_name,
    author_email: authorization.author_email,
    author_date: authorization.author_date,
    committer_name: authorization.committer_name,
    committer_email: authorization.committer_email,
    committer_date: authorization.committer_date,
    signing_mode: "none",
    authorization_id: authorization.authorization_id,
    authorization_canonical_digest: authorization.canonical_digest,
    created_at: now,
  };
  const idempotencyKey = computeIdempotencyKey(intentFields);
  intentFields.idempotency_key = idempotencyKey;

  const existingCompletion = readCommitCompletion(execDir, idempotencyKey);
  if (existingCompletion) return existingCompletion;

  const check = validateCommitIntentFields(intentFields);
  if (!check.valid) fail(C3C_HOLD.MALFORMED_INTENT, check.errors.join(","));

  assertPreCommitGate({ repoRoot, execDir, candidate, review, authorization });

  const continuity = validateContinuity(execDir);
  if (continuity.incompleteTail != null) fail(C3C_HOLD.CONFLICTING_INTENT, "another journal transition is incomplete");

  const existingIntent = readCommitIntent(execDir, idempotencyKey);
  if (existingIntent) fail(C3C_HOLD.AMBIGUOUS_RECONCILIATION_STATE, "commit intent artifact exists without completion and without an incomplete journal tail");

  const journalRevision = continuity.lastComplete + 1;
  const operationId = mintTransitionId();
  const journalRecord = {
    format_version: "1.0.0",
    revision: journalRevision,
    transition_id: operationId,
    operation_id: operationId,
    execution_id: permit.execution_id,
    checkpoint_id: permit.checkpoint_id,
    chain_id: permit.chain_id,
    record_kind: "intent",
    from_stage: "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE",
    to_stage: "COMMITTED_LOCAL_VERIFIED",
    from_state: "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE",
    to_state: "COMMITTED_LOCAL_VERIFIED",
    actor_id: permit.actor_id,
    timestamp: now,
    side_effect_class: "commit",
    expected_revision_before: continuity.lastComplete,
    idempotency_key: idempotencyKey,
    candidate_id: candidate.candidate_id,
  };
  const publishedIntent = publishIntent(execDir, journalRecord, permit);

  ensureDir0700(commitIntentDir(execDir));
  writeJsonExclusiveCreate(commitIntentPath(execDir, idempotencyKey), intentFields, {
    hookBeforeCreate: "before_c3c_intent_temp_write",
    hookBeforeLink: "before_c3c_intent_link",
    hookAfterCreate: "after_c3c_intent_create",
  });

  fireHook("before_c3c_commit_tree");
  const commitOid = commitTreeEffect(repoRoot, intentFields);
  if (invocationCounters) invocationCounters.production_commit_invocations = (invocationCounters.production_commit_invocations || 0) + 1;
  fireHook("after_c3c_commit_tree");

  ensureDir0700(commitEvidenceDir(execDir));
  const evidencePath = commitEvidencePath(execDir, idempotencyKey);
  if (!existsSync(evidencePath)) {
    writeJsonExclusiveCreate(evidencePath, { idempotency_key: idempotencyKey, commit_oid: commitOid, created_at: new Date().toISOString() }, {
      hookBeforeCreate: "before_c3c_evidence_temp_write",
      hookBeforeLink: "before_c3c_evidence_link",
      hookAfterCreate: "after_c3c_evidence_create",
    });
  }
  // The evidence file, not the in-memory commitOid, is the durable fact from
  // here on (matches this codebase's re-read-from-disk convention elsewhere)
  // so a crash-recovery path and the initial path always advance/verify
  // against the identical authoritative value.
  const authoritativeOid = readCommitEvidence(execDir, idempotencyKey).commit_oid;

  fireHook("before_c3c_update_ref");
  const updateRef = git(repoRoot, ["update-ref", intentFields.target_ref, authoritativeOid, intentFields.expected_head]);
  if (updateRef.status !== 0) fail(C3C_HOLD.HEAD_DRIFT_AT_UPDATE, "atomic branch update failed (expected-old CAS rejected)", { stderr: updateRef.stderr });
  fireHook("after_c3c_update_ref");

  const verification = verifyCommittedState(repoRoot, intentFields, authoritativeOid);
  const completion = buildCompletion(intentFields, verification);

  fireHook("before_c3c_completion_write");
  let published;
  try {
    published = writeCommitCompletionIfAbsent(execDir, completion);
  } catch (e) {
    fail(C3C_HOLD.COMPLETION_PERSISTENCE_FAILED_RECOVERABLE, "completion persistence failed after successful commit", { cause: e.message });
  }

  const completeRecord = {
    ...journalRecord,
    record_kind: "verified_complete",
    commit_sha: verification.commit_sha,
    tree_sha: verification.tree_sha,
    completion_digest: digestOf(published),
  };
  fireHook("before_c3c_journal_complete");
  publishComplete(execDir, completeRecord, publishedIntent.digest, permit);

  return published;
}

/**
 * Crash recovery. Consumes the incomplete journal tail (side_effect_class
 * "commit"), deterministically recomputes the intended commit object (pure
 * given fixed tree/parent/message/identities/dates/signing_mode), then
 * proves which crash boundary was reached from live Git state before taking
 * any further action. Never creates a second commit. Never advances the
 * branch a second time. Fails closed on any drift it cannot explain.
 */
export function reconcileCommitTransition({ repoRoot, execDir, permit, repositoryLock }) {
  assertRepositoryMutationLock(repositoryLock, collectFingerprint(repoRoot), "commit");
  assertWritePermit(execDir, permit);
  const continuity = validateContinuity(execDir);
  const revision = continuity.incompleteTail;
  if (revision == null) return { state: "NO_COMMIT_TRANSITION" };
  const intent = readIntent(execDir, revision);
  if (!intent || intent.side_effect_class !== "commit") return { state: "NO_COMMIT_TRANSITION" };
  if (intent.execution_id !== permit.execution_id || intent.checkpoint_id !== permit.checkpoint_id || intent.chain_id !== permit.chain_id) {
    fail(C3C_HOLD.MALFORMED_INTENT, "commit journal intent/permit mismatch");
  }
  const key = intent.idempotency_key;
  const intentFields = readCommitIntent(execDir, key);
  if (!intentFields) fail(C3C_HOLD.MALFORMED_INTENT, "commit-intent artifact missing during recovery");
  const fieldsCheck = validateCommitIntentFields(intentFields);
  if (!fieldsCheck.valid) fail(C3C_HOLD.MALFORMED_INTENT, fieldsCheck.errors.join(","));

  const alreadyComplete = readComplete(execDir, revision);
  const existingCompletion = readCommitCompletion(execDir, key);

  const liveRef = git(repoRoot, ["rev-parse", intentFields.target_ref]);
  const expectedOid = commitTreeEffect(repoRoot, intentFields); // pure/idempotent given fixed inputs

  let verification;
  if (liveRef.status === 0 && liveRef.stdout === intentFields.expected_head) {
    // Case A: branch untouched since capture. Attempt the CAS now.
    ensureDir0700(commitEvidenceDir(execDir));
    const evidencePath = commitEvidencePath(execDir, key);
    if (!existsSync(evidencePath)) {
      writeJsonExclusiveCreate(evidencePath, { idempotency_key: key, commit_oid: expectedOid, created_at: new Date().toISOString() }, {
        hookBeforeCreate: "before_c3c_evidence_temp_write",
        hookBeforeLink: "before_c3c_evidence_link",
        hookAfterCreate: "after_c3c_evidence_create",
      });
    }
    const authoritativeOid = readCommitEvidence(execDir, key).commit_oid;
    fireHook("before_c3c_update_ref");
    const updateRef = git(repoRoot, ["update-ref", intentFields.target_ref, authoritativeOid, intentFields.expected_head]);
    if (updateRef.status !== 0) fail(C3C_HOLD.HEAD_DRIFT_AT_UPDATE, "atomic branch update failed during recovery", { stderr: updateRef.stderr });
    fireHook("after_c3c_update_ref");
    verification = verifyCommittedState(repoRoot, intentFields, authoritativeOid);
  } else if (liveRef.status === 0 && liveRef.stdout === expectedOid) {
    // Case B: branch already advanced by this exact intent. Verify only.
    verification = verifyCommittedState(repoRoot, intentFields, expectedOid);
  } else {
    // Case C: branch points somewhere else entirely. Fail closed, never touch.
    fail(C3C_HOLD.EXISTING_COMMIT_MISMATCH, "branch does not match expected parent nor the intended commit", {
      live: liveRef.status === 0 ? liveRef.stdout : null, expected_parent: intentFields.expected_head, expected_commit: expectedOid,
    });
  }

  const completion = existingCompletion || buildCompletion(intentFields, verification);
  fireHook("before_c3c_completion_write");
  const published = writeCommitCompletionIfAbsent(execDir, completion);

  if (!alreadyComplete) {
    const completeRecord = {
      ...intent,
      record_kind: "verified_complete",
      commit_sha: verification.commit_sha,
      tree_sha: verification.tree_sha,
      completion_digest: digestOf(published),
    };
    fireHook("before_c3c_journal_complete");
    publishComplete(execDir, completeRecord, null, permit);
  }

  return { state: "COMMITTED_LOCAL_VERIFIED", completion: published };
}
