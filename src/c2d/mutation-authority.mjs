// Durable C3B mutation authority. Only canonical execDir artifact is trusted.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { C2dHoldError, ensureDir0700, writeJsonExclusiveCreate, assertNotSymlink } from "./fs-atomic.mjs";
import { canonicalize, digestOf } from "../canonical-digest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(readFileSync(join(HERE, "..", "schema", "mutation-authorization.schema.json"), "utf8"));
export const C3B_HOLD = Object.freeze({
  MUTATION_AUTHORITY_INVALID: "HOLD / C3B_MUTATION_AUTHORITY_INVALID", MUTATION_AUTHORITY_REPLAYED: "HOLD / C3B_MUTATION_AUTHORITY_REPLAYED", MUTATION_AUTHORITY_EXPIRED: "HOLD / C3B_MUTATION_AUTHORITY_EXPIRED", MUTATION_AUTHORITY_IDENTITY_MISMATCH: "HOLD / C3B_MUTATION_AUTHORITY_IDENTITY_MISMATCH", MUTATION_AUTHORITY_BASELINE_MISMATCH: "HOLD / C3B_MUTATION_AUTHORITY_BASELINE_MISMATCH", SCOPE_VIOLATION: "HOLD / C3B_SCOPE_VIOLATION", MUTATION_FAILED: "HOLD / C3B_MUTATION_FAILED", VALIDATION_FAILED: "HOLD / C3B_VALIDATION_FAILED", VALIDATION_AUTHORITY_UNSAFE: "HOLD / C3B_VALIDATION_AUTHORITY_UNSAFE", ENVIRONMENT_FAILURE: "HOLD / C3B_ENVIRONMENT_FAILURE", EXECUTOR_ABANDONED: "HOLD / C3B_EXECUTOR_ABANDONED", RECOVERY_REQUIRED: "HOLD / C3B_RECOVERY_REQUIRED", REVIEW_HOLD: "HOLD / C3B_REVIEW_HOLD", ROLLBACK_FAILED: "HOLD / C3B_ROLLBACK_FAILED", REVIEWER_HANDOFF_IDENTITY_MISMATCH: "HOLD / C3B_REVIEWER_HANDOFF_IDENTITY_MISMATCH",
});
const fields = Object.keys(SCHEMA.properties); const required = SCHEMA.required;
export const mutationAuthorizationPath = (execDir) => join(execDir, "mutation-authorization.json");
export const authorityDigest = (a) => a.canonical_digest;
export function computeCanonicalDigest(a) { const { canonical_digest, ...rest } = a; return digestOf(rest); }
// Schema-required strings with minLength:1 (or equivalent identity strings) must be
// real non-blank strings. Empty "" and whitespace-only values fail closed. Values are
// never trimmed or rewritten — only rejected. Shared by producer and reader.
function requireNonBlankString(value, fieldName) {
  if (typeof value !== "string") return `${fieldName}_not_string`;
  if (value.length === 0) return `${fieldName}_empty`;
  if (/^\s*$/.test(value)) return `${fieldName}_blank`;
  return null;
}
// Derived from schema: every required string property with minLength:1 (pattern-only
// fields are covered by their regex; consts are covered separately).
const REQUIRED_NON_BLANK_STRING_FIELDS = Object.freeze([
  "repo_root", "repository_identity", "git_common_dir_identity", "target_ref",
  "card_id", "card_revision", "validation_plan_id", "authorized_by",
  "authorization_ref", "authorized_at", "expires_at",
]);
// Path-safety for authority path patterns. Glob patterns (e.g. "src/**") are
// legitimate here, so glob characters are NOT rejected; absolute paths, ".."
// traversal, backslashes, NUL, and blank/whitespace-only entries are rejected.
const pathBindingSafe = (p) => typeof p === "string" && p.length > 0 && !/^\s*$/.test(p) && !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && !p.split("/").includes("..");
// target_ref is a bare canonical ref token (production emits e.g. "master" or
// "HEAD", not a "refs/..." path). Require a non-empty token with no whitespace
// or control characters; do NOT impose a "refs/" prefix, which no real producer emits.
const targetRefValid = (r) => typeof r === "string" && r.length > 0 && !/[\s\x00-\x1f\x7f]/.test(r);
export function validateAuthorizationShape(a) {
  const errors = []; if (!a || typeof a !== "object" || Array.isArray(a)) return ["not_object"];
  for (const k of Object.keys(a)) if (!fields.includes(k)) errors.push(`unknown_${k}`);
  for (const k of required) if (!(k in a)) errors.push(`missing_${k}`);
  for (const k of REQUIRED_NON_BLANK_STRING_FIELDS) {
    const err = requireNonBlankString(a[k], k);
    if (err) errors.push(err);
  }
  if (a.schema !== "autoloop.mutation-authorization/v1" || a.authority_type !== "c3b_mutation") errors.push("schema_invalid");
  if (!/^[0-9a-f]{64}$/.test(a.authority_id || "") || !/^[0-9a-f]{64}$/.test(a.canonical_digest || "")) errors.push("digest_invalid");
  if (!/^exec_[0-9a-f]{32}$/.test(a.execution_id || "") || !/^[0-9a-f]{40}$/.test(a.baseline_head || "")) errors.push("identity_invalid");
  if (!targetRefValid(a.target_ref)) errors.push("target_ref_invalid");
  if (!Array.isArray(a.allowed_paths) || !a.allowed_paths.length || !Array.isArray(a.forbidden_paths)
      || canonicalize([...a.allowed_paths].sort()) !== canonicalize(a.allowed_paths)
      || canonicalize([...a.forbidden_paths].sort()) !== canonicalize(a.forbidden_paths)
      || new Set(a.allowed_paths).size !== a.allowed_paths.length
      || new Set(a.forbidden_paths).size !== a.forbidden_paths.length
      || ![...(a.allowed_paths || []), ...(a.forbidden_paths || [])].every(pathBindingSafe)) errors.push("paths_invalid");
  if (!a.authorized_at || Number.isNaN(Date.parse(a.authorized_at))) errors.push("authorized_at_invalid");
  if (!a.expires_at || Number.isNaN(Date.parse(a.expires_at))) errors.push("expiry_invalid");
  if (!errors.includes("authorized_at_invalid") && !errors.includes("expiry_invalid") && Date.parse(a.expires_at) <= Date.parse(a.authorized_at)) errors.push("expiry_ordering_invalid");
  if (!errors.length && a.authority_id !== digestOf({ ...a, authority_id: undefined, canonical_digest: undefined })) errors.push("authority_id_mismatch");
  if (!errors.length && computeCanonicalDigest(a) !== a.canonical_digest) errors.push("canonical_digest_mismatch");
  return errors;
}
export function readMutationAuthorization(execDir, { allowExpired = false } = {}) {
  const p = mutationAuthorizationPath(execDir); if (!existsSync(p)) throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_INVALID, "durable mutation authorization missing");
  assertNotSymlink(p); let a; try { a = JSON.parse(readFileSync(p, "utf8")); } catch { throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_INVALID, "durable mutation authorization unreadable"); }
  const errors = validateAuthorizationShape(a); if (errors.length) throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_INVALID, errors.join(","));
  if (!allowExpired && Date.parse(a.expires_at) <= Date.now()) throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_EXPIRED, "mutation authorization expired");
  return Object.freeze(a);
}
function sameIssuanceRequest(old, input, fp) {
  const expected = {
    schema: "autoloop.mutation-authorization/v1", authority_type: "c3b_mutation",
    execution_id: input.execution_id, repo_root: fp.repository_root_identity,
    repository_identity: fp.repository_root_identity, git_common_dir_identity: fp.git_common_dir_identity,
    baseline_head: fp.expected_head, target_ref: fp.expected_ref,
    card_id: input.card_id, card_revision: input.card_revision,
    allowed_paths: [...input.allowed_paths].sort(), forbidden_paths: [...input.forbidden_paths].sort(),
    validation_plan_id: input.validation_plan_id, authorized_by: input.authorized_by,
    authorization_ref: input.authorization_ref, expires_at: input.expires_at,
  };
  return canonicalize(expected) === canonicalize(Object.fromEntries(Object.keys(expected).map((k) => [k, old[k]])));
}
export function createMutationAuthorization(execDir, input, fp) {
  const now = new Date().toISOString(); const identity = { schema: "autoloop.mutation-authorization/v1", authority_type: "c3b_mutation", execution_id: input.execution_id, repo_root: fp.repository_root_identity, repository_identity: fp.repository_root_identity, git_common_dir_identity: fp.git_common_dir_identity, baseline_head: fp.expected_head, target_ref: fp.expected_ref, card_id: input.card_id, card_revision: input.card_revision, allowed_paths: [...input.allowed_paths].sort(), forbidden_paths: [...input.forbidden_paths].sort(), validation_plan_id: input.validation_plan_id, authorized_by: input.authorized_by, authorization_ref: input.authorization_ref, authorized_at: now, expires_at: input.expires_at };
  const authority_id = digestOf({ ...identity, authority_id: undefined, canonical_digest: undefined }); const draft = { ...identity, authority_id }; const record = { ...draft, canonical_digest: computeCanonicalDigest(draft) };
  const errors = validateAuthorizationShape(record); if (errors.length) throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_INVALID, errors.join(",")); ensureDir0700(execDir); const p = mutationAuthorizationPath(execDir);
  if (existsSync(p)) { const old = readMutationAuthorization(execDir, { allowExpired: true }); if (sameIssuanceRequest(old, input, fp)) return { status: "AUTHORIZED_EXISTING_IDENTICAL", authorization: old }; throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_INVALID, "conflicting mutation authorization"); }
  try { writeJsonExclusiveCreate(p, record); } catch { const old = readMutationAuthorization(execDir, { allowExpired: true }); if (sameIssuanceRequest(old, input, fp)) return { status: "AUTHORIZED_EXISTING_IDENTICAL", authorization: old }; throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_INVALID, "conflicting mutation authorization"); }
  return { status: "AUTHORIZED_CREATED", authorization: Object.freeze(record) };
}
export function authorizeMutation(execDir, ignoredInline, live) {
  if (ignoredInline !== undefined) throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_INVALID, "inline authorization forbidden");
  const a = readMutationAuthorization(execDir);
  // Live binding verification, evaluated before any mutation effect. Order:
  // execution/repository identity -> canonical Git common-directory -> target ref
  // -> baseline HEAD. The stored durable authority must match the *live* operation
  // context on every axis; authority for one common-directory or one target ref
  // can never authorize another. No fallback ever fabricates authority.
  if (a.execution_id !== live.executionId || a.repository_identity !== live.repositoryIdentity) throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_IDENTITY_MISMATCH, "authority execution/repository mismatch");
  if (a.git_common_dir_identity !== live.gitCommonDir) throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_IDENTITY_MISMATCH, "authority git common-directory mismatch");
  if (a.target_ref !== live.targetRef) throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_IDENTITY_MISMATCH, "authority target ref mismatch");
  if (a.baseline_head !== live.headSha) throw new C2dHoldError(C3B_HOLD.MUTATION_AUTHORITY_BASELINE_MISMATCH, "authority baseline mismatch");
  return { authority: a, authorityDigest: a.canonical_digest };
}
export function assertValidationPlan(a, id) { if (a.validation_plan_id !== id) throw new C2dHoldError(C3B_HOLD.VALIDATION_AUTHORITY_UNSAFE, "validation plan identity mismatch"); }
