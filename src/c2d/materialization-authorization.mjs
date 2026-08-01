// Durable C3B materialization authority. Producer only writes artifact; reader only reads it.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { C2dHoldError, ensureDir0700, writeJsonExclusiveCreate, assertNotSymlink } from "./fs-atomic.mjs";
import { canonicalize, digestOf } from "../canonical-digest.mjs";
import { collectFingerprint } from "./fingerprint.mjs";
import { readCandidate, requireReviewerArtifact } from "./reviewed-commit-candidate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); const schema = JSON.parse(readFileSync(join(HERE, "..", "schema", "materialization-authorization.schema.json"), "utf8"));
const FIELDS = Object.keys(schema.properties);
export const MATERIALIZATION_HOLD = Object.freeze({ INVALID: "HOLD / MATERIALIZATION_AUTHORITY_BOUNDARY_BROKEN", EXPIRED: "HOLD / MATERIALIZATION_AUTHORITY_EXPIRED", CONFLICT: "HOLD / MATERIALIZATION_AUTHORITY_CONFLICT" });
const fail = (code, message) => { throw new C2dHoldError(code, message); };
export const materializationAuthorizationPath = (execDir) => join(execDir, "materialization-authorization.json");
export const computeMaterializationCanonicalDigest = (a) => { const { canonical_digest, ...rest } = a; return digestOf(rest); };
function git(repoRoot, args) { const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" }); return { status: r.status, stdout: (r.stdout || "").trim() }; }
// allowed_paths for materialization are concrete relative repository paths (the
// candidate's exact changed paths). Reject absolute paths, ".." traversal,
// backslashes and NUL as path-safety violations.
const materializationPathSafe = (p) => typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && !p.split("/").includes("..");
// target_ref is a bare canonical ref token (production emits e.g. "master"), not
// a "refs/..." path. Require a non-empty token with no whitespace/control chars.
const materializationTargetRefValid = (r) => typeof r === "string" && r.length > 0 && !/[\s\x00-\x1f\x7f]/.test(r);
function check(a) {
  const e = []; if (!a || typeof a !== "object" || Array.isArray(a)) return ["not_object"]; for (const k of Object.keys(a)) if (!FIELDS.includes(k)) e.push(`unknown_${k}`); for (const k of schema.required) if (!(k in a)) e.push(`missing_${k}`);
  if (a.schema !== "autoloop.materialization-authorization/v1" || a.authority_type !== "candidate_materialization" || a.materialization_mode !== "main_worktree_index_exact_tree_reset" || a.single_use !== true) e.push("fixed_policy_invalid");
  if (!/^exec_[0-9a-f]{32}$/.test(a.execution_id || "") || !/^[0-9a-f]{64}$/.test(a.authority_id || "") || !/^[0-9a-f]{64}$/.test(a.canonical_digest || "") || !/^[0-9a-f]{64}$/.test(a.candidate_record_digest || "") || !/^[0-9a-f]{64}$/.test(a.review_artifact_digest || "")) e.push("identity_invalid");
  // Required non-empty string identity/binding fields (schema minLength:1) enforced
  // by the production reader so an alternate identity cannot be smuggled in.
  for (const k of ["candidate_id", "review_id", "repository_identity", "git_common_dir_identity", "target_worktree_identity", "authorized_by", "authorization_ref"]) if (typeof a[k] !== "string" || a[k].length === 0) e.push("identity_string_invalid");
  if (!Number.isInteger(a.review_revision) || a.review_revision < 1) e.push("review_revision_invalid");
  if (!/^[0-9a-f]{40}$/.test(a.candidate_tree || "") || !/^[0-9a-f]{40}$/.test(a.baseline_head || "") || !Array.isArray(a.allowed_paths) || !a.allowed_paths.length
      || canonicalize([...a.allowed_paths].sort()) !== canonicalize(a.allowed_paths)
      || new Set(a.allowed_paths).size !== a.allowed_paths.length
      || !a.allowed_paths.every(materializationPathSafe)
      || !materializationTargetRefValid(a.target_ref)) e.push("binding_invalid");
  if (!a.authorized_at || Number.isNaN(Date.parse(a.authorized_at))) e.push("authorized_at_invalid");
  if (!a.expires_at || Number.isNaN(Date.parse(a.expires_at))) e.push("expiry_invalid");
  if (!e.includes("authorized_at_invalid") && !e.includes("expiry_invalid") && Date.parse(a.expires_at) <= Date.parse(a.authorized_at)) e.push("expiry_ordering_invalid");
  if (!e.length && a.authority_id !== digestOf({ ...a, authority_id: undefined, canonical_digest: undefined })) e.push("authority_id_mismatch"); if (!e.length && a.canonical_digest !== computeMaterializationCanonicalDigest(a)) e.push("canonical_digest_mismatch"); return e;
}
export function readMaterializationAuthorization(execDir, bindings, { recovery = false } = {}) {
  const p = materializationAuthorizationPath(execDir); if (!existsSync(p)) fail(MATERIALIZATION_HOLD.INVALID, "materialization authorization missing"); assertNotSymlink(p); let a; try { a = JSON.parse(readFileSync(p, "utf8")); } catch { fail(MATERIALIZATION_HOLD.INVALID, "materialization authorization unreadable"); }
  const e = check(a); if (e.length) fail(MATERIALIZATION_HOLD.INVALID, e.join(",")); if (!recovery && Date.parse(a.expires_at) <= Date.now()) fail(MATERIALIZATION_HOLD.EXPIRED, "materialization authorization expired");
  for (const [k, v] of Object.entries(bindings || {})) if (a[k] !== v && canonicalize(a[k]) !== canonicalize(v)) fail(MATERIALIZATION_HOLD.INVALID, `${k} mismatch`); return Object.freeze(a);
}
export function createMaterializationAuthorization({ execDir, repoRoot, candidateId, authorizedBy, authorizationRef, expiresAt }) {
  const candidate = readCandidate(execDir, candidateId); if (!candidate || Date.parse(candidate.expires_at) <= Date.now()) fail(MATERIALIZATION_HOLD.INVALID, "candidate missing or expired");
  const review = JSON.parse(readFileSync(join(execDir, "reviews", `${candidateId}.json`), "utf8")); const artifact = requireReviewerArtifact(execDir, candidate, review); if (artifact.review_verdict !== "PASS") fail(MATERIALIZATION_HOLD.INVALID, "PASS review required");
  const fp = collectFingerprint(repoRoot); const index = git(repoRoot, ["write-tree"]); const headTree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]); const untracked = git(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  if (fp.dirty || untracked.stdout || fp.expected_head !== candidate.expected_head || index.stdout !== headTree.stdout || fp.repository_root_identity !== candidate.repository_identity || fp.git_common_dir_identity !== candidate.git_common_dir_identity) fail(MATERIALIZATION_HOLD.INVALID, "target baseline not exact");
  const base = { schema: "autoloop.materialization-authorization/v1", authority_type: "candidate_materialization", execution_id: candidate.execution_id, candidate_id: candidate.candidate_id, candidate_record_digest: candidate.candidate_manifest_digest, candidate_tree: candidate.candidate_tree, review_id: candidate.candidate_id, review_revision: candidate.candidate_revision, review_artifact_digest: artifact.review_artifact_digest, repository_identity: fp.repository_root_identity, git_common_dir_identity: fp.git_common_dir_identity, target_worktree_identity: fp.worktree_identity, baseline_head: candidate.expected_head, target_ref: fp.expected_ref, allowed_paths: [...candidate.exact_changed_paths], materialization_mode: "main_worktree_index_exact_tree_reset", authorized_by: authorizedBy, authorization_ref: authorizationRef, authorized_at: new Date().toISOString(), expires_at: expiresAt, single_use: true };
  const authority_id = digestOf({ ...base, authority_id: undefined, canonical_digest: undefined }); const draft = { ...base, authority_id }; const record = { ...draft, canonical_digest: computeMaterializationCanonicalDigest(draft) }; const e = check(record); if (e.length) fail(MATERIALIZATION_HOLD.INVALID, e.join(",")); const p = materializationAuthorizationPath(execDir);
  if (existsSync(p)) { const old = readMaterializationAuthorization(execDir, {}, { recovery: true }); if (old.authority_id === record.authority_id) return { status: "AUTHORIZED_EXISTING_IDENTICAL", authorization: old }; fail(MATERIALIZATION_HOLD.CONFLICT, "conflicting materialization authorization"); }
  ensureDir0700(execDir); try { writeJsonExclusiveCreate(p, record); } catch { const old = readMaterializationAuthorization(execDir, {}, { recovery: true }); if (old.authority_id === record.authority_id) return { status: "AUTHORIZED_EXISTING_IDENTICAL", authorization: old }; fail(MATERIALIZATION_HOLD.CONFLICT, "conflicting materialization authorization"); } return { status: "AUTHORIZED_CREATED", authorization: Object.freeze(record) };
}
