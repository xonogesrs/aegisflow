// C3B/C2D reviewed candidate handoff. Tree objects, never patches, are source of truth.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalize, digestOf } from "../canonical-digest.mjs";
import { C2dHoldError, HOLD, ensureDir0700, writeJsonExclusiveCreate, assertNotSymlink, fireHook, sha256Hex } from "./fs-atomic.mjs";
import { assertWritePermit } from "./permit.mjs";
import { collectFingerprint } from "./fingerprint.mjs";
import { readCurrent, publishCurrent } from "./checkpoint-store.mjs";
import { publishIntent, publishComplete, readIntent, readComplete, validateContinuity } from "./journal.mjs";
import { mintTransitionId } from "./execution-id.mjs";
import { readMaterializationAuthorization } from "./materialization-authorization.mjs";
import { assertRepositoryMutationLock } from "./repository-mutation-lock.mjs";

export const CANDIDATE_HOLD = Object.freeze({
  CAPTURE_PRECONDITION_FAILED: "HOLD / CANDIDATE_CAPTURE_PRECONDITION_FAILED",
  TREE_IDENTITY_NOT_PROVEN: "HOLD / CANDIDATE_TREE_IDENTITY_NOT_PROVEN",
  RETENTION_INCOMPLETE: "HOLD / GIT_OBJECT_RETENTION_INCOMPLETE",
  REVIEW_IDENTITY_MISSING: "HOLD / REVIEWED_CANDIDATE_IDENTITY_MISSING",
  REVIEW_IDENTITY_MISMATCH: "HOLD / REVIEWED_CANDIDATE_IDENTITY_MISMATCH",
  MATERIALIZATION_AUTHORITY: "HOLD / MATERIALIZATION_AUTHORITY_BOUNDARY_BROKEN",
  MATERIALIZATION_MISMATCH: "HOLD / CANDIDATE_MATERIALIZATION_MISMATCH",
  PARTIAL_MATERIALIZATION: "HOLD / PARTIAL_MATERIALIZATION_REALITY_MISMATCH",
  CLEANUP_ISOLATION: "HOLD / CLEANUP_ISOLATION_INCOMPLETE",
  CAPTURE_SOURCE_MISSING: "HOLD / CANDIDATE_CAPTURE_SOURCE_MISSING",
  CAPTURE_REALITY_MISMATCH: "HOLD / CANDIDATE_CAPTURE_REALITY_MISMATCH",
  RETENTION_REALITY_MISMATCH: "HOLD / CANDIDATE_RETENTION_REALITY_MISMATCH",
  MATERIALIZATION_INTENT_ORDER: "HOLD / MATERIALIZATION_INTENT_ORDER_BROKEN",
  STAGED_REALITY_MISMATCH: "HOLD / CANDIDATE_CAPTURE_STAGED_REALITY_MISMATCH",
});

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STATUS = new Set(["CAPTURE_INTENT", "CAPTURED", "VERIFIED", "READY_FOR_COMMIT_AUTHORIZATION", "MATERIALIZATION_INTENT", "MATERIALIZED_VERIFIED", "EXPIRED", "HOLD"]);
const ZERO = "0".repeat(40);

function fail(code, message, details) { throw new C2dHoldError(code, message, details); }
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), error: r.error };
}
function gitOk(cwd, args, code, message) {
  const r = git(cwd, args);
  if (r.status !== 0) fail(code, message || `git ${args.join(" ")} failed`, { stderr: r.stderr });
  return r.stdout;
}
function commonDir(cwd) { return realpathSync(resolve(cwd, gitOk(cwd, ["rev-parse", "--git-common-dir"], CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED))); }
function pathSafe(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && !path.split("/").includes("..") && !/[?*\[\]{}]/.test(path);
}
function allowedPath(path, patterns) { return (patterns || []).some((pattern) => pattern === "**" || pattern === path || (typeof pattern === "string" && pattern.endsWith("/**") && path.startsWith(pattern.slice(0, -3)))); }
function candidateId(executionId, sourceRevision) { return `cand_${executionId}_r${sourceRevision + 1}`; }
function retentionRef(id) { return `refs/autoloop/candidates/${id}`; }
function candidateDir(execDir) { return join(execDir, "candidates"); }
export function candidatePath(execDir, id) { return join(candidateDir(execDir), `${id}.json`); }

function worktreeChanges(cwd, parent) {
  const tracked = gitOk(cwd, ["diff", "--name-only", "-z", parent], CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED).split("\0").filter(Boolean);
  const untracked = gitOk(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED).split("\0").filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function parseRawEntries(raw) {
  const bits = raw.split("\0").filter(Boolean);
  const entries = [];
  for (let i = 0; i < bits.length; i += 2) {
    const header = bits[i]; const path = bits[i + 1];
    const m = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/.exec(header || "");
    if (!m || !pathSafe(path)) fail(CANDIDATE_HOLD.TREE_IDENTITY_NOT_PROVEN, "noncanonical diff-tree entry");
    const [, oldMode, newMode, oldBlob, newBlob, status] = m;
    entries.push({
      path,
      change_kind: status === "A" ? "added" : status === "D" ? "deleted" : status === "T" ? "typechange" : "modified",
      mode_before: oldMode === "000000" ? null : oldMode,
      mode_after: newMode === "000000" ? null : newMode,
      blob_before: oldBlob === ZERO ? null : oldBlob,
      blob_after: newBlob === ZERO ? null : newBlob,
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function immutableCandidateFacts(candidate) {
  return {
    candidate_id: candidate.candidate_id, candidate_revision: candidate.candidate_revision,
    execution_id: candidate.execution_id, card_id: candidate.card_id, card_revision: candidate.card_revision,
    source_checkpoint_revision: candidate.source_checkpoint_revision,
    expected_head: candidate.expected_head, candidate_tree: candidate.candidate_tree,
    exact_changed_paths: candidate.exact_changed_paths, tree_entries: candidate.tree_entries,
  };
}

export function candidateManifestDigest(candidate) { return digestOf(immutableCandidateFacts(candidate)); }

export function validateCandidate(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { valid: false, errors: ["candidate_not_object"] };
  const req = ["schema", "candidate_id", "candidate_revision", "status", "execution_id", "card_id", "card_revision", "source_checkpoint_revision", "authority_record_digest", "execution_context_digest", "mutation_authority_digest", "review_artifact_digest", "review_verdict", "repository_identity", "git_common_dir_identity", "source_worktree_identity", "expected_head", "expected_origin_master", "candidate_tree", "candidate_parent", "exact_changed_paths", "tree_entries", "candidate_manifest_digest", "retention_kind", "retention_reference", "created_at", "expires_at"];
  for (const key of Object.keys(candidate)) if (!req.includes(key)) errors.push(`unknown_${key}`);
  for (const k of req) if (!(k in candidate)) errors.push(`missing_${k}`);
  if (candidate.schema !== "autoloop.reviewed-commit-candidate/v1") errors.push("schema_invalid");
  if (!STATUS.has(candidate.status)) errors.push("status_invalid");
  if (!/^cand_exec_[0-9a-f]{32}_r[1-9][0-9]*$/.test(candidate.candidate_id || "")) errors.push("candidate_id_invalid");
  if (!Number.isInteger(candidate.candidate_revision) || candidate.candidate_revision < 1) errors.push("candidate_revision_invalid");
  if (!Number.isInteger(candidate.source_checkpoint_revision) || candidate.source_checkpoint_revision < 0) errors.push("source_checkpoint_revision_invalid");
  for (const k of ["expected_head", "candidate_tree", "candidate_parent"]) if (!SHA.test(candidate[k] || "")) errors.push(`${k}_invalid`);
  for (const k of ["authority_record_digest", "execution_context_digest", "mutation_authority_digest", "candidate_manifest_digest"]) if (!SHA256.test(candidate[k] || "")) errors.push(`${k}_invalid`);
  if (candidate.review_artifact_digest !== null && !SHA256.test(candidate.review_artifact_digest || "")) errors.push("review_artifact_digest_invalid");
  if (candidate.candidate_parent !== candidate.expected_head) errors.push("candidate_parent_mismatch");
  if (candidate.retention_kind !== "git_tree_ref" || candidate.retention_reference !== retentionRef(candidate.candidate_id)) errors.push("retention_reference_invalid");
  if (!Array.isArray(candidate.exact_changed_paths) || candidate.exact_changed_paths.length === 0) errors.push("paths_invalid");
  else {
    const sorted = [...candidate.exact_changed_paths].sort();
    if (canonicalize(sorted) !== canonicalize(candidate.exact_changed_paths)) errors.push("paths_unsorted");
    if (new Set(candidate.exact_changed_paths).size !== candidate.exact_changed_paths.length) errors.push("paths_duplicate");
    if (!candidate.exact_changed_paths.every(pathSafe)) errors.push("paths_unsafe");
  }
  if (!Array.isArray(candidate.tree_entries) || candidate.tree_entries.length !== candidate.exact_changed_paths?.length) errors.push("entries_invalid");
  else {
    if (canonicalize(candidate.tree_entries.map((x) => x.path).sort()) !== canonicalize(candidate.exact_changed_paths)) errors.push("entries_paths_mismatch");
    for (const entry of candidate.tree_entries) {
      if (!entry || typeof entry !== "object" || !pathSafe(entry.path) || !["added", "deleted", "modified", "typechange"].includes(entry.change_kind)) errors.push("entry_invalid");
      for (const key of ["mode_before", "mode_after"]) if (entry?.[key] !== null && !/^[0-7]{6}$/.test(entry?.[key] || "")) errors.push(`entry_${key}_invalid`);
      for (const key of ["blob_before", "blob_after"]) if (entry?.[key] !== null && !SHA.test(entry?.[key] || "")) errors.push(`entry_${key}_invalid`);
      if (entry?.change_kind === "deleted" && (entry.mode_after !== null || entry.blob_after !== null)) errors.push("deletion_after_not_null");
    }
  }
  if (candidate.status === "READY_FOR_COMMIT_AUTHORIZATION" && (candidate.review_verdict !== "PASS" || !SHA256.test(candidate.review_artifact_digest || ""))) errors.push("ready_review_invalid");
  if (errors.length === 0 && candidateManifestDigest(candidate) !== candidate.candidate_manifest_digest) errors.push("manifest_digest_mismatch");
  return { valid: errors.length === 0, errors };
}

export function readCandidate(execDir, id) {
  const path = candidatePath(execDir, id); if (!existsSync(path)) return null; assertNotSymlink(path);
  const c = JSON.parse(readFileSync(path, "utf8")); const check = validateCandidate(c);
  if (!check.valid) fail(CANDIDATE_HOLD.TREE_IDENTITY_NOT_PROVEN, `candidate invalid: ${check.errors.join(",")}`);
  return c;
}

function assertCandidateRef(repoRoot, candidate) {
  const actual = git(repoRoot, ["rev-parse", candidate.retention_reference]);
  if (actual.status !== 0 || actual.stdout !== candidate.candidate_tree) fail(CANDIDATE_HOLD.RETENTION_INCOMPLETE, "candidate ref mismatch");
  if (gitOk(repoRoot, ["cat-file", "-t", candidate.retention_reference], CANDIDATE_HOLD.RETENTION_INCOMPLETE) !== "tree") fail(CANDIDATE_HOLD.RETENTION_INCOMPLETE, "candidate ref is not tree");
  gitOk(repoRoot, ["cat-file", "-e", `${candidate.candidate_tree}^{tree}`], CANDIDATE_HOLD.RETENTION_INCOMPLETE);
}

// Nonempty cached index on entry has exactly one recoverable explanation: a
// crash after this exact source was staged and its hidden ref created for
// the SAME incomplete capture intent. This proves that reality against the
// durable journal intent + hidden ref + current worktree, never resets or
// restages, and never mints a new candidate id. Any other nonempty index
// (wrong paths, no matching intent, drifted worktree, foreign ref) remains
// fail-closed with a distinct HOLD code.
function proveResumableStagedCandidate({ repoRoot, sourceWorktree, execDir, permit, authorization, knownId, paths }) {
  const continuity = validateContinuity(execDir);
  if (continuity.incompleteTail == null) fail(CANDIDATE_HOLD.STAGED_REALITY_MISMATCH, "nonempty source index without an incomplete capture intent");
  const intent = readIntent(execDir, continuity.incompleteTail);
  if (!intent || intent.side_effect_class !== "candidate_capture" || intent.candidate_id !== knownId) fail(CANDIDATE_HOLD.STAGED_REALITY_MISMATCH, "incomplete intent does not match this capture");
  if (intent.execution_id !== permit.execution_id || intent.checkpoint_id !== permit.checkpoint_id || intent.chain_id !== permit.chain_id) fail(CANDIDATE_HOLD.STAGED_REALITY_MISMATCH, "incomplete intent does not match permit");
  if (readComplete(execDir, continuity.incompleteTail)) fail(CANDIDATE_HOLD.STAGED_REALITY_MISMATCH, "capture already complete");
  const ref = retentionRef(knownId);
  const existingRef = git(repoRoot, ["rev-parse", ref]);
  if (existingRef.status !== 0) fail(CANDIDATE_HOLD.STAGED_REALITY_MISMATCH, "no hidden ref to resume from");
  if (gitOk(repoRoot, ["cat-file", "-t", ref], CANDIDATE_HOLD.STAGED_REALITY_MISMATCH) !== "tree") fail(CANDIDATE_HOLD.STAGED_REALITY_MISMATCH, "hidden ref is not a tree");
  const indexTree = gitOk(sourceWorktree, ["write-tree"], CANDIDATE_HOLD.STAGED_REALITY_MISMATCH);
  if (indexTree !== existingRef.stdout) fail(CANDIDATE_HOLD.STAGED_REALITY_MISMATCH, "staged index tree does not match hidden ref");
  if (git(sourceWorktree, ["diff", "--quiet"]).status !== 0) fail(CANDIDATE_HOLD.STAGED_REALITY_MISMATCH, "worktree does not match staged index");
  if (!Array.isArray(intent.expected_changed_paths) || canonicalize(paths) !== canonicalize(intent.expected_changed_paths)) fail(CANDIDATE_HOLD.STAGED_REALITY_MISMATCH, "staged paths do not match capture intent");
  return indexTree;
}

function captureCandidateEffect({ repoRoot, sourceWorktree, execDir, permit, authorization, sourceCheckpointRevision, authorityRecordDigest, executionContextDigest, mutationAuthorityDigest, expiresAt }) {
  assertWritePermit(execDir, permit);
  const knownId = candidateId(permit.execution_id, sourceCheckpointRevision);
  const prior = readCandidate(execDir, knownId);
  if (prior) { assertCandidateRef(repoRoot, prior); return prior; }
  const source = collectFingerprint(sourceWorktree); const repo = collectFingerprint(repoRoot);
  if (source.expected_head !== authorization.baseline_head || repo.expected_head !== authorization.baseline_head || commonDir(sourceWorktree) !== commonDir(repoRoot)) fail(CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED, `source/repository drift source=${source.expected_head} repo=${repo.expected_head} expected=${authorization.baseline_head} common=${commonDir(sourceWorktree)}::${commonDir(repoRoot)}`);
  if (![authorityRecordDigest, executionContextDigest, mutationAuthorityDigest].every((x) => SHA256.test(x || ""))) fail(CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED, "lineage digest missing");
  const paths = worktreeChanges(sourceWorktree, authorization.baseline_head);
  if (paths.length === 0 || !paths.every((p) => allowedPath(p, authorization.allowed_paths))) fail(CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED, "candidate path outside authority");
  let tree;
  if (git(sourceWorktree, ["diff", "--cached", "--quiet"]).status === 0) {
    const untracked = gitOk(sourceWorktree, ["ls-files", "--others", "--exclude-standard", "-z"], CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED).split("\0").filter(Boolean);
    if (!untracked.every((p) => paths.includes(p))) fail(CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED, "unauthorized untracked path");
    gitOk(sourceWorktree, ["add", "--", ...paths], CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED, "exact staging failed");
    tree = gitOk(sourceWorktree, ["write-tree"], CANDIDATE_HOLD.TREE_IDENTITY_NOT_PROVEN);
  } else {
    tree = proveResumableStagedCandidate({ repoRoot, sourceWorktree, execDir, permit, authorization, knownId, paths });
  }
  const entries = parseRawEntries(gitOk(sourceWorktree, ["diff-tree", "-r", "--raw", "-z", "--no-renames", authorization.baseline_head, tree], CANDIDATE_HOLD.TREE_IDENTITY_NOT_PROVEN));
  const exactPaths = entries.map((x) => x.path);
  if (canonicalize(exactPaths) !== canonicalize(paths) || git(sourceWorktree, ["diff", "--quiet"]).status !== 0) fail(CANDIDATE_HOLD.TREE_IDENTITY_NOT_PROVEN, "index/worktree/tree mismatch");
  const id = knownId; const ref = retentionRef(id);
  const existing = git(repoRoot, ["rev-parse", ref]);
  if (existing.status === 0 && existing.stdout !== tree) fail(CANDIDATE_HOLD.RETENTION_INCOMPLETE, "candidate ref conflicts");
  if (existing.status !== 0) {
    fireHook("before_candidate_capture_update_ref");
    gitOk(repoRoot, ["update-ref", ref, tree, ZERO], CANDIDATE_HOLD.RETENTION_INCOMPLETE, "candidate ref create failed");
    fireHook("after_candidate_capture_ref");
  }
  const candidate = {
    schema: "autoloop.reviewed-commit-candidate/v1", candidate_id: id, candidate_revision: sourceCheckpointRevision + 1, status: "VERIFIED",
    execution_id: permit.execution_id, card_id: authorization.card_id, card_revision: authorization.card_revision, source_checkpoint_revision: sourceCheckpointRevision,
    authority_record_digest: authorityRecordDigest, execution_context_digest: executionContextDigest, mutation_authority_digest: mutationAuthorityDigest,
    review_artifact_digest: null, review_verdict: null,
    repository_identity: repo.repository_root_identity, git_common_dir_identity: repo.git_common_dir_identity, source_worktree_identity: source.worktree_identity,
    expected_head: authorization.baseline_head, expected_origin_master: repo.origin_master || "", candidate_tree: tree, candidate_parent: authorization.baseline_head,
    exact_changed_paths: exactPaths, tree_entries: entries, candidate_manifest_digest: "", retention_kind: "git_tree_ref", retention_reference: ref,
    created_at: new Date().toISOString(), expires_at: expiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  candidate.candidate_manifest_digest = candidateManifestDigest(candidate); const check = validateCandidate(candidate);
  if (!check.valid) fail(CANDIDATE_HOLD.TREE_IDENTITY_NOT_PROVEN, `candidate invalid: ${check.errors.join(",")}`);
  assertCandidateRef(repoRoot, candidate); ensureDir0700(candidateDir(execDir));
  const p = candidatePath(execDir, id);
  if (existsSync(p)) { const existingCandidate = readCandidate(execDir, id); if (existingCandidate.candidate_manifest_digest !== candidate.candidate_manifest_digest) fail(CANDIDATE_HOLD.RETENTION_INCOMPLETE, "candidate artifact conflicts"); return existingCandidate; }
  writeJsonExclusiveCreate(p, candidate); fireHook("after_candidate_capture_artifact"); return candidate;
}

export function buildCandidateReviewerHandoff(candidate, evidence = {}) {
  return Object.freeze({ ...evidence, candidate_id: candidate.candidate_id, candidate_tree: candidate.candidate_tree, candidate_manifest_digest: candidate.candidate_manifest_digest, expected_head: candidate.expected_head, exact_changed_paths: candidate.exact_changed_paths, retention_reference: candidate.retention_reference });
}
export function validateReviewerCandidateBinding(candidate, review) {
  const required = ["candidate_id", "candidate_tree", "candidate_manifest_digest", "expected_head", "exact_changed_paths", "review_verdict"];
  if (!review || required.some((k) => !(k in review))) fail(CANDIDATE_HOLD.REVIEW_IDENTITY_MISSING, "review candidate identity missing");
  for (const k of ["candidate_id", "candidate_tree", "candidate_manifest_digest", "expected_head"]) if (review[k] !== candidate[k]) fail(CANDIDATE_HOLD.REVIEW_IDENTITY_MISMATCH, `${k} mismatch`);
  if (canonicalize(review.exact_changed_paths) !== canonicalize(candidate.exact_changed_paths)) fail(CANDIDATE_HOLD.REVIEW_IDENTITY_MISMATCH, "review paths mismatch");
  return true;
}

function materializeCandidateEffect({ repoRoot, execDir, permit, candidate, review, controllerAuthorization, repositoryLock, invocationCounters }) {
  assertWritePermit(execDir, permit); const check = validateCandidate(candidate); if (!check.valid) fail(CANDIDATE_HOLD.MATERIALIZATION_MISMATCH, check.errors.join(","));
  validateReviewerCandidateBinding(candidate, review);
  if (review.review_verdict !== "PASS") fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "review not PASS");
  assertRepositoryMutationLock(repositoryLock, collectFingerprint(repoRoot), "candidate_materialization");
  if (!controllerAuthorization || controllerAuthorization.candidate_id !== candidate.candidate_id || controllerAuthorization.candidate_record_digest !== candidate.candidate_manifest_digest || controllerAuthorization.candidate_tree !== candidate.candidate_tree) fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "durable authorization does not bind candidate");
  if (Date.parse(candidate.expires_at) <= Date.now()) fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "candidate expired");
  const fp = collectFingerprint(repoRoot);
  const targetFacts = ["repository_identity", "git_common_dir_identity", "worktree_identity", "branch", "expected_head"];
  const actualTarget = {
    repository_identity: fp.repository_root_identity,
    git_common_dir_identity: fp.git_common_dir_identity,
    worktree_identity: fp.worktree_identity,
    branch: fp.expected_ref,
    expected_head: fp.expected_head,
  };
  const authorityTarget = {
    repository_identity: controllerAuthorization.repository_identity,
    git_common_dir_identity: controllerAuthorization.git_common_dir_identity,
    worktree_identity: controllerAuthorization.target_worktree_identity,
    branch: controllerAuthorization.target_ref,
    expected_head: controllerAuthorization.baseline_head,
  };
  if (targetFacts.some((key) => authorityTarget[key] !== actualTarget[key])) fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "controller authorization does not bind target");
  if (fp.expected_head !== candidate.expected_head || fp.repository_root_identity !== candidate.repository_identity || fp.git_common_dir_identity !== candidate.git_common_dir_identity || fp.dirty) fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "target drift");
  if (gitOk(repoRoot, ["write-tree"], CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY) !== gitOk(repoRoot, ["rev-parse", "HEAD^{tree}"], CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY)) fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "target index not baseline");
  assertCandidateRef(repoRoot, candidate);
  if (invocationCounters) invocationCounters.production_materialization_invocations = (invocationCounters.production_materialization_invocations || 0) + 1;
  fireHook("before_candidate_materialization_read_tree");
  gitOk(repoRoot, ["read-tree", "--reset", "-u", candidate.candidate_tree], CANDIDATE_HOLD.MATERIALIZATION_MISMATCH, "read-tree materialization failed");
  fireHook("after_candidate_materialization_read_tree");
  const tree = gitOk(repoRoot, ["write-tree"], CANDIDATE_HOLD.MATERIALIZATION_MISMATCH);
  if (tree !== candidate.candidate_tree || git(repoRoot, ["diff", "--quiet"]).status !== 0 || gitOk(repoRoot, ["rev-parse", "HEAD"], CANDIDATE_HOLD.MATERIALIZATION_MISMATCH) !== candidate.expected_head) fail(CANDIDATE_HOLD.MATERIALIZATION_MISMATCH, "materialized tree truth mismatch");
  const entries = parseRawEntries(gitOk(repoRoot, ["diff-tree", "-r", "--raw", "-z", "--no-renames", candidate.expected_head, tree], CANDIDATE_HOLD.MATERIALIZATION_MISMATCH));
  if (canonicalize(entries) !== canonicalize(candidate.tree_entries)) fail(CANDIDATE_HOLD.MATERIALIZATION_MISMATCH, "materialized entries mismatch");
  return { state: "MATERIALIZED_VERIFIED", candidate_tree: tree, changed_paths: entries.map((x) => x.path) };
}

// C2D candidate transitions deliberately wrap, rather than replace, exact-tree
// primitives above. Intent is durable before first Git mutation. COMPLETE is
// durable only after Git truth has been re-observed. CURRENT is a separate CAS.
function artifactDigest(value) { return digestOf(value); }
function pathDigest(paths) { return digestOf(paths); }
function entryDigest(entries) { return digestOf(entries); }
function requireCurrent(execDir) {
  const current = readCurrent(execDir);
  if (!current) fail(HOLD.CHECKPOINT_CORRUPT, "CURRENT missing for candidate transition");
  return current;
}
function transitionSetup(execDir, permit, kind, current) {
  assertWritePermit(execDir, permit);
  const continuity = validateContinuity(execDir);
  if (continuity.incompleteTail != null) fail(HOLD.INTENT_WITHOUT_COMPLETION, "candidate transition already incomplete");
  return { journalRevision: continuity.lastComplete + 1, operationId: mintTransitionId(), current };
}
function intentCurrent(current, permit, state, operationId, journalRevision, input) {
  return {
    ...current.snapshot,
    revision: current.snapshot.revision + 1,
    stage: state,
    state,
    c2d_control_state: state,
    current_owner_actor: permit.actor_id,
    lease_identity: { lease_id: permit.lease_id, lease_revision: permit.lease_revision },
    input_manifest: { ...current.snapshot.input_manifest, candidate_transition: { operation_id: operationId, journal_revision: journalRevision, state, ...input } },
    next_transition_candidate: { value: "NONE", advisory_only: true, not_authorization: true },
  };
}
function completeCurrent(current, permit, state, operationId, journalRevision, evidence) {
  return {
    ...current.snapshot,
    revision: current.snapshot.revision + 1,
    stage: state,
    state,
    c2d_control_state: state,
    last_completed_transition: operationId,
    current_owner_actor: permit.actor_id,
    lease_identity: { lease_id: permit.lease_id, lease_revision: permit.lease_revision },
    input_manifest: { ...current.snapshot.input_manifest, candidate_transition: { operation_id: operationId, journal_revision: journalRevision, state, evidence } },
    next_transition_candidate: { value: "NONE", advisory_only: true, not_authorization: true },
  };
}
function captureFacts({ repoRoot, sourceWorktree, permit, authorization, sourceCheckpointRevision, authorityRecordDigest, executionContextDigest, mutationAuthorityDigest }) {
  const source = collectFingerprint(sourceWorktree); const repo = collectFingerprint(repoRoot);
  const id = candidateId(permit.execution_id, sourceCheckpointRevision);
  if (source.expected_head !== authorization.baseline_head || repo.expected_head !== authorization.baseline_head || commonDir(sourceWorktree) !== commonDir(repoRoot)) fail(CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED, "capture source/repository baseline mismatch");
  if (![authorityRecordDigest, executionContextDigest, mutationAuthorityDigest].every((x) => SHA256.test(x || ""))) fail(CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED, "capture lineage missing");
  const paths = worktreeChanges(sourceWorktree, authorization.baseline_head);
  if (!paths.length || !paths.every((p) => allowedPath(p, authorization.allowed_paths))) fail(CANDIDATE_HOLD.CAPTURE_PRECONDITION_FAILED, "capture paths outside authority");
  return { operation_id: "", candidate_id: id, candidate_revision: sourceCheckpointRevision + 1, execution_id: permit.execution_id, card_id: authorization.card_id, card_revision: authorization.card_revision, source_checkpoint_revision: sourceCheckpointRevision, expected_head: authorization.baseline_head, expected_origin_master: repo.origin_master || "", repository_identity: repo.repository_root_identity, git_common_dir_identity: repo.git_common_dir_identity, source_worktree_identity: source.worktree_identity, authority_record_digest: authorityRecordDigest, execution_context_digest: executionContextDigest, mutation_authority_digest: mutationAuthorityDigest, allowed_paths: authorization.allowed_paths, forbidden_paths: authorization.forbidden_paths || [], expected_changed_paths: paths, expected_candidate_ref: retentionRef(id), lease_identity: { lease_id: permit.lease_id, lease_revision: permit.lease_revision }, permit_digest: digestOf({ execution_id: permit.execution_id, lease_id: permit.lease_id, lease_revision: permit.lease_revision }) };
}
function captureCompleteRecord(intent, candidate, verification) {
  return { format_version: "1.0.0", revision: intent.revision, transition_id: intent.transition_id, execution_id: intent.execution_id, checkpoint_id: intent.checkpoint_id, chain_id: intent.chain_id, record_kind: "verified_complete", from_stage: intent.from_stage, to_stage: intent.to_stage, from_state: intent.from_state, to_state: intent.to_state, actor_id: intent.actor_id, timestamp: new Date().toISOString(), side_effect_class: intent.side_effect_class, expected_revision_before: intent.expected_revision_before, operation_id: intent.operation_id, candidate_id: candidate.candidate_id, candidate_revision: candidate.candidate_revision, candidate_tree: candidate.candidate_tree, candidate_manifest_digest: candidate.candidate_manifest_digest, retention_reference: candidate.retention_reference, retention_object_type: "tree", exact_changed_paths_digest: pathDigest(candidate.exact_changed_paths), tree_entries_digest: entryDigest(candidate.tree_entries), candidate_artifact_digest: artifactDigest(candidate), verification_evidence_digest: artifactDigest(verification) };
}
function assertCaptureReality(repoRoot, candidate) {
  assertCandidateRef(repoRoot, candidate);
  const entries = parseRawEntries(gitOk(repoRoot, ["diff-tree", "-r", "--raw", "-z", "--no-renames", candidate.expected_head, candidate.candidate_tree], CANDIDATE_HOLD.CAPTURE_REALITY_MISMATCH));
  if (canonicalize(entries) !== canonicalize(candidate.tree_entries)) fail(CANDIDATE_HOLD.CAPTURE_REALITY_MISMATCH, "candidate tree entries mismatch");
  return { ref: candidate.retention_reference, tree: candidate.candidate_tree, entries_digest: entryDigest(entries), manifest_digest: candidate.candidate_manifest_digest };
}
export function captureReviewedCandidate(args) {
  const current = requireCurrent(args.execDir); const setup = transitionSetup(args.execDir, args.permit, "candidate_capture", current);
  const facts = captureFacts(args); facts.operation_id = setup.operationId;
  const intent = { format_version: "1.0.0", revision: setup.journalRevision, transition_id: setup.operationId, operation_id: setup.operationId, execution_id: current.snapshot.execution_id, checkpoint_id: current.snapshot.checkpoint_id, chain_id: current.snapshot.chain_id, record_kind: "intent", from_stage: current.snapshot.stage, to_stage: "CANDIDATE_CAPTURE_VERIFIED_COMPLETE", from_state: current.snapshot.state, to_state: "CANDIDATE_CAPTURE_VERIFIED_COMPLETE", actor_id: args.permit.actor_id, timestamp: new Date().toISOString(), side_effect_class: "candidate_capture", expected_revision_before: current.snapshot.revision, ...facts };
  const publishedIntent = publishIntent(args.execDir, intent, args.permit);
  const intentSnapshot = intentCurrent(current, args.permit, "CANDIDATE_CAPTURE_INTENT", setup.operationId, setup.journalRevision, { candidate_id: facts.candidate_id });
  publishCurrent(args.execDir, intentSnapshot, { expectedRevision: current.snapshot.revision, permit: args.permit });
  fireHook("after_candidate_capture_intent_current");
  const candidate = captureCandidateEffect(args); const verification = assertCaptureReality(args.repoRoot, candidate);
  const complete = captureCompleteRecord(intent, candidate, verification); const publishedComplete = publishComplete(args.execDir, complete, publishedIntent.digest, args.permit);
  fireHook("after_candidate_capture_complete_before_current");
  const afterIntent = requireCurrent(args.execDir); const snapshot = completeCurrent(afterIntent, args.permit, "CANDIDATE_CAPTURE_VERIFIED_COMPLETE", setup.operationId, setup.journalRevision, { candidate_id: candidate.candidate_id, candidate_tree: candidate.candidate_tree, candidate_manifest_digest: candidate.candidate_manifest_digest, complete_digest: publishedComplete.digest });
  const publishedCurrent = publishCurrent(args.execDir, snapshot, { expectedRevision: afterIntent.snapshot.revision, permit: args.permit });
  Object.defineProperty(candidate, "transition", { value: { intent: publishedIntent, complete: publishedComplete, current: publishedCurrent }, enumerable: false });
  return candidate;
}

function reviewerArtifactPath(execDir, id) { return join(execDir, "reviews", `${id}.json`); }
export function bindReviewerArtifact(execDir, candidate, review) {
  validateReviewerCandidateBinding(candidate, review);
  const artifact = { schema: "autoloop.reviewed-candidate-review/v1", candidate_id: candidate.candidate_id, candidate_revision: candidate.candidate_revision, candidate_tree: candidate.candidate_tree, candidate_manifest_digest: candidate.candidate_manifest_digest, expected_head: candidate.expected_head, exact_changed_paths: candidate.exact_changed_paths, review_verdict: review.review_verdict };
  artifact.review_artifact_digest = digestOf(artifact); ensureDir0700(join(execDir, "reviews")); const p = reviewerArtifactPath(execDir, candidate.candidate_id);
  if (existsSync(p)) { const old = JSON.parse(readFileSync(p, "utf8")); if (old.review_artifact_digest !== artifact.review_artifact_digest) fail(CANDIDATE_HOLD.REVIEW_IDENTITY_MISMATCH, "durable review artifact conflict"); return old; }
  writeJsonExclusiveCreate(p, artifact); return artifact;
}
export function requireReviewerArtifact(execDir, candidate, review) {
  const p = reviewerArtifactPath(execDir, candidate.candidate_id); if (!existsSync(p)) fail(CANDIDATE_HOLD.REVIEW_IDENTITY_MISSING, "durable reviewer artifact missing"); assertNotSymlink(p); const artifact = JSON.parse(readFileSync(p, "utf8"));
  if (artifact.review_artifact_digest !== digestOf({ schema: artifact.schema, candidate_id: artifact.candidate_id, candidate_revision: artifact.candidate_revision, candidate_tree: artifact.candidate_tree, candidate_manifest_digest: artifact.candidate_manifest_digest, expected_head: artifact.expected_head, exact_changed_paths: artifact.exact_changed_paths, review_verdict: artifact.review_verdict })) fail(CANDIDATE_HOLD.REVIEW_IDENTITY_MISMATCH, "review artifact digest mismatch");
  validateReviewerCandidateBinding(candidate, artifact); validateReviewerCandidateBinding(candidate, review);
  if (canonicalize(artifact) !== canonicalize({ ...artifact, review_artifact_digest: artifact.review_artifact_digest }) || artifact.review_artifact_digest !== review.review_artifact_digest || artifact.review_verdict !== review.review_verdict) fail(CANDIDATE_HOLD.REVIEW_IDENTITY_MISMATCH, "review artifact exact binding mismatch");
  return artifact;
}
function assertBaselineTarget(repoRoot, candidate, controllerAuthorization) {
  const fp = collectFingerprint(repoRoot); const target = { repository_identity: fp.repository_root_identity, git_common_dir_identity: fp.git_common_dir_identity, worktree_identity: fp.worktree_identity, branch: fp.expected_ref, expected_head: fp.expected_head };
  const authorityTarget = { repository_identity: controllerAuthorization.repository_identity, git_common_dir_identity: controllerAuthorization.git_common_dir_identity, worktree_identity: controllerAuthorization.target_worktree_identity, branch: controllerAuthorization.target_ref, expected_head: controllerAuthorization.baseline_head };
  for (const key of Object.keys(target)) if (authorityTarget[key] !== target[key]) fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "durable authority target binding mismatch");
  if (fp.expected_head !== candidate.expected_head || fp.dirty || gitOk(repoRoot, ["write-tree"], CANDIDATE_HOLD.PARTIAL_MATERIALIZATION) !== gitOk(repoRoot, ["rev-parse", "HEAD^{tree}"], CANDIDATE_HOLD.PARTIAL_MATERIALIZATION)) fail(CANDIDATE_HOLD.PARTIAL_MATERIALIZATION, "target not exact baseline");
  return target;
}
function materializationEvidence(repoRoot, candidate, counters) {
  const indexTree = gitOk(repoRoot, ["write-tree"], CANDIDATE_HOLD.MATERIALIZATION_MISMATCH); const head = gitOk(repoRoot, ["rev-parse", "HEAD"], CANDIDATE_HOLD.MATERIALIZATION_MISMATCH); const entries = parseRawEntries(gitOk(repoRoot, ["diff-tree", "-r", "--raw", "-z", "--no-renames", candidate.expected_head, indexTree], CANDIDATE_HOLD.MATERIALIZATION_MISMATCH));
  if (indexTree !== candidate.candidate_tree || head !== candidate.expected_head || git(repoRoot, ["diff", "--quiet"]).status !== 0 || git(repoRoot, ["ls-files", "--others", "--exclude-standard"]).stdout) fail(CANDIDATE_HOLD.PARTIAL_MATERIALIZATION, "materialized target not exact candidate");
  if (canonicalize(entries) !== canonicalize(candidate.tree_entries)) fail(CANDIDATE_HOLD.MATERIALIZATION_MISMATCH, "materialized entries mismatch");
  return { candidate_tree: candidate.candidate_tree, materialized_index_tree: indexTree, materialized_worktree_tree: indexTree, verified_changed_paths_digest: pathDigest(entries.map((x) => x.path)), verified_tree_entries_digest: entryDigest(entries), head_after_effect: head, production_commit_invocations: counters?.production_commit_invocations || 0, production_push_invocations: counters?.production_push_invocations || 0, production_llm_or_executor_invocations: counters?.production_llm_or_executor_invocations || 0, production_materialization_invocations: counters?.production_materialization_invocations || 0 };
}
export function materializeReviewedCandidate(args) {
  const { repoRoot, execDir, permit, candidate, review, repositoryLock, invocationCounters } = args; if ("controllerAuthorization" in args) fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "inline materialization authorization forbidden"); assertWritePermit(execDir, permit); const check = validateCandidate(candidate); if (!check.valid) fail(CANDIDATE_HOLD.MATERIALIZATION_MISMATCH, check.errors.join(",")); const artifact = requireReviewerArtifact(execDir, candidate, review); const fp = collectFingerprint(repoRoot); assertRepositoryMutationLock(repositoryLock, fp, "candidate_materialization");
  const controllerAuthorization = readMaterializationAuthorization(execDir, { execution_id: candidate.execution_id, candidate_id: candidate.candidate_id, candidate_record_digest: candidate.candidate_manifest_digest, candidate_tree: candidate.candidate_tree, review_id: candidate.candidate_id, review_revision: candidate.candidate_revision, review_artifact_digest: artifact.review_artifact_digest, repository_identity: fp.repository_root_identity, git_common_dir_identity: fp.git_common_dir_identity, target_worktree_identity: fp.worktree_identity, baseline_head: candidate.expected_head, target_ref: fp.expected_ref, allowed_paths: candidate.exact_changed_paths });
  if (review.review_verdict !== "PASS") fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "review not PASS"); if (Date.parse(candidate.expires_at) <= Date.now()) fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "candidate expired");
  const current = requireCurrent(execDir); const setup = transitionSetup(execDir, permit, "candidate_materialization", current); const target = assertBaselineTarget(repoRoot, candidate, controllerAuthorization);
  const intent = { format_version: "1.0.0", revision: setup.journalRevision, transition_id: setup.operationId, operation_id: setup.operationId, execution_id: current.snapshot.execution_id, checkpoint_id: current.snapshot.checkpoint_id, chain_id: current.snapshot.chain_id, record_kind: "intent", from_stage: current.snapshot.stage, to_stage: "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE", from_state: current.snapshot.state, to_state: "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE", actor_id: permit.actor_id, timestamp: new Date().toISOString(), side_effect_class: "candidate_materialization", expected_revision_before: current.snapshot.revision, candidate_id: candidate.candidate_id, candidate_revision: candidate.candidate_revision, candidate_tree: candidate.candidate_tree, candidate_manifest_digest: candidate.candidate_manifest_digest, review_artifact_digest: artifact.review_artifact_digest, controller_authorization_digest: digestOf(controllerAuthorization), materialization_authorization_id: controllerAuthorization.authority_id, materialization_authorization_canonical_digest: controllerAuthorization.canonical_digest, source_checkpoint_revision: candidate.source_checkpoint_revision, target_repository_identity: target.repository_identity, target_git_common_dir_identity: target.git_common_dir_identity, target_worktree_identity: target.worktree_identity, target_branch: target.branch, expected_head: candidate.expected_head, lease_identity: { lease_id: permit.lease_id, lease_revision: permit.lease_revision }, permit_digest: digestOf({ execution_id: permit.execution_id, lease_id: permit.lease_id, lease_revision: permit.lease_revision }) };
  const publishedIntent = publishIntent(execDir, intent, permit); publishCurrent(execDir, intentCurrent(current, permit, "MATERIALIZATION_INTENT", setup.operationId, setup.journalRevision, { candidate_id: candidate.candidate_id }), { expectedRevision: current.snapshot.revision, permit }); fireHook("after_candidate_materialization_intent_current");
  assertBaselineTarget(repoRoot, candidate, controllerAuthorization); assertCandidateRef(repoRoot, candidate); materializeCandidateEffect({ ...args, controllerAuthorization, repositoryLock, invocationCounters }); const evidence = materializationEvidence(repoRoot, candidate, invocationCounters); const complete = { format_version: "1.0.0", revision: intent.revision, transition_id: intent.transition_id, execution_id: intent.execution_id, checkpoint_id: intent.checkpoint_id, chain_id: intent.chain_id, record_kind: "verified_complete", from_stage: intent.from_stage, to_stage: intent.to_stage, from_state: intent.from_state, to_state: intent.to_state, actor_id: permit.actor_id, timestamp: new Date().toISOString(), side_effect_class: intent.side_effect_class, expected_revision_before: intent.expected_revision_before, operation_id: intent.operation_id, ...evidence, verification_evidence_digest: artifactDigest(evidence) }; const publishedComplete = publishComplete(execDir, complete, publishedIntent.digest, permit); fireHook("after_candidate_materialization_complete_before_current"); const afterIntent = requireCurrent(execDir); const publishedCurrent = publishCurrent(execDir, completeCurrent(afterIntent, permit, "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE", setup.operationId, setup.journalRevision, { candidate_id: candidate.candidate_id, complete_digest: publishedComplete.digest }), { expectedRevision: afterIntent.snapshot.revision, permit }); return { state: "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE", candidate_tree: candidate.candidate_tree, evidence, transition: { intent: publishedIntent, complete: publishedComplete, current: publishedCurrent } };
}

// Crash recovery consumes persisted intent, re-observes Git, then only fills
// missing COMPLETE/CURRENT. It never creates another candidate ID and never
// resets, cleans, or compensates partial target state.
export function reconcileCandidateTransition(args) {
  const { execDir, permit } = args; assertWritePermit(execDir, permit); const continuity = validateContinuity(execDir); const current = requireCurrent(execDir);
  const revision = continuity.incompleteTail ?? continuity.lastComplete; if (!revision) return { state: "NO_CANDIDATE_TRANSITION" };
  const intent = readIntent(execDir, revision); if (!intent || !["candidate_capture", "candidate_materialization"].includes(intent.side_effect_class)) return { state: "NO_CANDIDATE_TRANSITION" };
  if (intent.execution_id !== permit.execution_id || intent.checkpoint_id !== permit.checkpoint_id || intent.chain_id !== permit.chain_id) fail(HOLD.WRITE_PERMIT_REQUIRED, "candidate intent/permit mismatch");
  const alreadyComplete = readComplete(execDir, revision);
  if (alreadyComplete) {
    if (current.snapshot.last_completed_transition === intent.operation_id) return { state: "CURRENT_ALREADY_PUBLISHED" };
    let evidence;
    if (intent.side_effect_class === "candidate_capture") evidence = assertCaptureReality(args.repoRoot, readCandidate(execDir, intent.candidate_id));
    else { const candidate = readCandidate(execDir, intent.candidate_id); assertCandidateRef(args.repoRoot, candidate); evidence = materializationEvidence(args.repoRoot, candidate, args.invocationCounters); }
    const state = intent.side_effect_class === "candidate_capture" ? "CANDIDATE_CAPTURE_VERIFIED_COMPLETE" : "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE";
    const publishedCurrent = publishCurrent(execDir, completeCurrent(current, permit, state, intent.operation_id, intent.revision, { recovered_current_only: true, complete_digest: sha256Hex(JSON.stringify(alreadyComplete)), evidence }), { expectedRevision: current.snapshot.revision, permit });
    return { state, current: publishedCurrent, evidence, current_only: true };
  }
  if (continuity.incompleteTail == null) return { state: "NO_CANDIDATE_TRANSITION" };
  let complete; let evidence;
  if (intent.side_effect_class === "candidate_capture") {
    let candidate = readCandidate(execDir, intent.candidate_id);
    if (!candidate) {
      if (!args.sourceWorktree || !existsSync(args.sourceWorktree)) fail(CANDIDATE_HOLD.CAPTURE_SOURCE_MISSING, "capture source worktree missing");
      const authorization = { card_id: intent.card_id, card_revision: intent.card_revision, baseline_head: intent.expected_head, allowed_paths: intent.allowed_paths, forbidden_paths: intent.forbidden_paths };
      candidate = captureCandidateEffect({ repoRoot: args.repoRoot, sourceWorktree: args.sourceWorktree, execDir, permit, authorization, sourceCheckpointRevision: intent.source_checkpoint_revision, authorityRecordDigest: intent.authority_record_digest, executionContextDigest: intent.execution_context_digest, mutationAuthorityDigest: intent.mutation_authority_digest });
    }
    evidence = assertCaptureReality(args.repoRoot, candidate); complete = captureCompleteRecord(intent, candidate, evidence);
  } else {
    const candidate = readCandidate(execDir, intent.candidate_id); if (!candidate) fail(CANDIDATE_HOLD.PARTIAL_MATERIALIZATION, "candidate artifact missing during materialization recovery");
    if (!intent.materialization_authorization_id || !intent.materialization_authorization_canonical_digest) fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "LEGACY_INCOMPLETE_MATERIALIZATION_LACKS_DURABLE_AUTHORITY");
    const recoveryFp = collectFingerprint(args.repoRoot); assertRepositoryMutationLock(args.repositoryLock, recoveryFp, "candidate_materialization");
    const artifact = requireReviewerArtifact(execDir, candidate, args.review); if (artifact.review_artifact_digest !== intent.review_artifact_digest) fail(CANDIDATE_HOLD.REVIEW_IDENTITY_MISMATCH, "review artifact drift during recovery"); const recoveryAuthority = readMaterializationAuthorization(execDir, { candidate_id: candidate.candidate_id, candidate_tree: candidate.candidate_tree, review_artifact_digest: artifact.review_artifact_digest }, { recovery: true }); if (recoveryAuthority.authority_id !== intent.materialization_authorization_id || recoveryAuthority.canonical_digest !== intent.materialization_authorization_canonical_digest) fail(CANDIDATE_HOLD.MATERIALIZATION_AUTHORITY, "durable materialization authority changed during recovery"); assertCandidateRef(args.repoRoot, candidate);
    const head = gitOk(args.repoRoot, ["rev-parse", "HEAD"], CANDIDATE_HOLD.PARTIAL_MATERIALIZATION); const index = gitOk(args.repoRoot, ["write-tree"], CANDIDATE_HOLD.PARTIAL_MATERIALIZATION); const clean = git(args.repoRoot, ["diff", "--quiet"]).status === 0 && !git(args.repoRoot, ["ls-files", "--others", "--exclude-standard"]).stdout;
    if (head !== candidate.expected_head || !clean) fail(CANDIDATE_HOLD.PARTIAL_MATERIALIZATION, "partial materialization reality mismatch");
    if (index === gitOk(args.repoRoot, ["rev-parse", "HEAD^{tree}"], CANDIDATE_HOLD.PARTIAL_MATERIALIZATION)) {
      assertBaselineTarget(args.repoRoot, candidate, recoveryAuthority); materializeCandidateEffect({ ...args, candidate, controllerAuthorization: recoveryAuthority, invocationCounters: args.invocationCounters });
    } else if (index !== candidate.candidate_tree) fail(CANDIDATE_HOLD.PARTIAL_MATERIALIZATION, "partial materialization reality mismatch");
    evidence = materializationEvidence(args.repoRoot, candidate, args.invocationCounters); complete = { format_version: "1.0.0", revision: intent.revision, transition_id: intent.transition_id, execution_id: intent.execution_id, checkpoint_id: intent.checkpoint_id, chain_id: intent.chain_id, record_kind: "verified_complete", from_stage: intent.from_stage, to_stage: intent.to_stage, from_state: intent.from_state, to_state: intent.to_state, actor_id: permit.actor_id, timestamp: new Date().toISOString(), side_effect_class: intent.side_effect_class, expected_revision_before: intent.expected_revision_before, operation_id: intent.operation_id, ...evidence, verification_evidence_digest: artifactDigest(evidence) };
  }
  const publishedComplete = publishComplete(execDir, complete, null, permit); const finalState = intent.side_effect_class === "candidate_capture" ? "CANDIDATE_CAPTURE_VERIFIED_COMPLETE" : "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE"; const publishedCurrent = publishCurrent(execDir, completeCurrent(current, permit, finalState, intent.operation_id, intent.revision, { recovered: true, complete_digest: publishedComplete.digest }), { expectedRevision: current.snapshot.revision, permit }); return { state: finalState, complete: publishedComplete, current: publishedCurrent, evidence };
}

export function cleanupCandidateRef({ repoRoot, candidate, cleanupAuthorization }) {
  if (!cleanupAuthorization || cleanupAuthorization.cleanup !== true || cleanupAuthorization.candidate_id !== candidate.candidate_id || cleanupAuthorization.candidate_tree !== candidate.candidate_tree) fail(CANDIDATE_HOLD.CLEANUP_ISOLATION, "cleanup authority invalid");
  gitOk(repoRoot, ["update-ref", "-d", candidate.retention_reference, candidate.candidate_tree], CANDIDATE_HOLD.CLEANUP_ISOLATION, "candidate ref cleanup failed");
  return true;
}

export { candidateId, retentionRef, assertCandidateRef, captureCandidateEffect, materializeCandidateEffect };
