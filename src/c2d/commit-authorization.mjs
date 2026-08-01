// C3C durable commit authorization. Fills the gap between C3B terminal
// completion (CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE) and C3C commit
// intent: today commit-materialized-candidate.mjs accepts `commitAuthorization`
// as a caller-supplied in-memory object with no durable backing at all. This
// module adds an immutable, schema-backed, candidate-specific artifact
// (<execDir>/commit-authorization.json) created only by an explicit
// operator/Controller producer step, plus a strict existing-only reader.
//
// Does not perform a commit, does not update any ref, does not push or seal,
// and is not wired into commit-materialized-candidate.mjs or operator-tick.mjs
// in this card (see report: C3C consumer integration intentionally deferred).
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  C2dHoldError, ensureDir0700, writeJsonExclusiveCreate, assertNotSymlink, HOLD as FS_HOLD,
} from "./fs-atomic.mjs";
import { readCurrent } from "./checkpoint-store.mjs";
import { readCandidate, requireReviewerArtifact } from "./reviewed-commit-candidate.mjs";
import { canonicalize, digestOf } from "../canonical-digest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(readFileSync(join(HERE, "..", "schema", "commit-authorization.schema.json"), "utf8"));
export const SCHEMA_ID = "autoloop.commit-authorization/v1";
export const REQUIRED_FIELDS = Object.freeze([...SCHEMA.required]);
export const ALLOWED_FIELDS = Object.freeze(Object.keys(SCHEMA.properties));

export const TERMINAL_STATE = "CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE";

// Only master is ever a valid commit target in this repository's baseline
// protocol (every AutoLoop card in this lineage pins BASELINE_SHA against
// master). Extend explicitly, never wildcard, if a future card needs another
// branch. CANONICAL_TARGET_REF is the single sealed policy value a C3C
// consumer derives its expectedBindings.target_ref from — never a caller
// input — so it can never drift from ALLOWED_TARGET_REFS.
export const CANONICAL_TARGET_REF = "refs/heads/master";
export const ALLOWED_TARGET_REFS = Object.freeze(new Set([CANONICAL_TARGET_REF]));

export const AUTHZ_HOLD = Object.freeze({
  TERMINAL_STATE_MISSING: "HOLD / COMMIT_AUTHORIZATION_TERMINAL_STATE_MISSING",
  TERMINAL_STATE_MISMATCH: "HOLD / COMMIT_AUTHORIZATION_TERMINAL_STATE_MISMATCH",
  MISSING_CANDIDATE: "HOLD / COMMIT_AUTHORIZATION_MISSING_CANDIDATE",
  MISSING_REVIEWER_ARTIFACT: "HOLD / COMMIT_AUTHORIZATION_MISSING_REVIEWER_ARTIFACT",
  REVIEW_NOT_PASS: "HOLD / COMMIT_AUTHORIZATION_REVIEW_NOT_PASS",
  CANDIDATE_BINDING_MISMATCH: "HOLD / COMMIT_AUTHORIZATION_CANDIDATE_BINDING_MISMATCH",
  TARGET_REF_NOT_ALLOWED: "HOLD / COMMIT_AUTHORIZATION_TARGET_REF_NOT_ALLOWED",
  MISSING_SUBJECT: "HOLD / COMMIT_AUTHORIZATION_MISSING_SUBJECT",
  MISSING_IDENTITY: "HOLD / COMMIT_AUTHORIZATION_MISSING_IDENTITY",
  MISSING_APPROVAL: "HOLD / COMMIT_AUTHORIZATION_MISSING_APPROVAL",
  MALFORMED_AUTHORIZATION: "HOLD / COMMIT_AUTHORIZATION_MALFORMED",
  CONFLICTING_AUTHORIZATION: "HOLD / COMMIT_AUTHORIZATION_CONFLICTING",
  AUTHORIZATION_MISSING: "HOLD / COMMIT_AUTHORIZATION_MISSING",
  BINDING_MISMATCH: "HOLD / COMMIT_AUTHORIZATION_BINDING_MISMATCH",
});

function fail(code, message, details) { throw new C2dHoldError(code, message, details); }

export function authorizationPath(execDir) {
  return join(execDir, "commit-authorization.json");
}

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXEC_RE = /^exec_[0-9a-f]{32}$/;
const CANDIDATE_RE = /^cand_exec_[0-9a-f]{32}_r[1-9][0-9]*$/;
const TARGET_REF_RE = /^refs\/heads\/[^\s~^:?*[\]\\]+$/;
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const EMAIL_RE = /^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+$/;

function pathSafe(p) {
  return typeof p === "string" && p.length > 0 && p.length <= 4096
    && !p.startsWith("/") && !p.includes("\\") && !p.includes("\0")
    && p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function noInjection(s) {
  return typeof s === "string" && s.length > 0 && !CONTROL_CHAR_RE.test(s);
}

/** Fields that determine authorization identity. Excludes authorized_at
 * (bookkeeping creation time — same exclusion authority-record makes for
 * captured_at) and the two digest fields themselves. */
export function authorizationIdentityFields(a) {
  return {
    schema: a.schema,
    card_id: a.card_id,
    card_revision: a.card_revision,
    execution_id: a.execution_id,
    candidate_id: a.candidate_id,
    candidate_revision: a.candidate_revision,
    review_artifact_digest: a.review_artifact_digest,
    review_verdict: a.review_verdict,
    expected_head: a.expected_head,
    target_ref: a.target_ref,
    candidate_tree: a.candidate_tree,
    candidate_manifest_digest: a.candidate_manifest_digest,
    exact_changed_paths: a.exact_changed_paths,
    commit_subject: a.commit_subject,
    commit_body: a.commit_body,
    author_name: a.author_name,
    author_email: a.author_email,
    author_date: a.author_date,
    committer_name: a.committer_name,
    committer_email: a.committer_email,
    committer_date: a.committer_date,
    commit_allowed: a.commit_allowed,
    authorized_by: a.authorized_by,
    authorization_source: a.authorization_source,
    authorization_ref: a.authorization_ref,
  };
}

export function computeAuthorizationId(a) {
  return digestOf(authorizationIdentityFields(a));
}

/** Full envelope digest: everything except canonical_digest itself. Includes
 * authorization_id and authorized_at, so it also catches tampering with the
 * identity digest or the creation timestamp — non-redundant with
 * authorization_id, which deliberately excludes authorized_at so identical
 * requests replayed later are still recognized as the same authorization. */
export function computeCanonicalDigest(a) {
  const { canonical_digest, ...rest } = a;
  return digestOf(rest);
}

export function validateCommitAuthorization(a) {
  const errors = [];
  if (!a || typeof a !== "object" || Array.isArray(a)) return { valid: false, errors: ["not_object"] };
  for (const key of Object.keys(a)) if (!ALLOWED_FIELDS.includes(key)) errors.push(`unknown_${key}`);
  for (const key of REQUIRED_FIELDS) if (!(key in a)) errors.push(`missing_${key}`);
  if (errors.length) return { valid: false, errors };

  if (a.schema !== SCHEMA_ID) errors.push("schema_invalid");
  if (!SHA256.test(a.authorization_id || "")) errors.push("authorization_id_invalid");
  if (typeof a.card_id !== "string" || a.card_id.length === 0 || a.card_id.length > 128) errors.push("card_id_invalid");
  if (typeof a.card_revision !== "string" || a.card_revision.length === 0 || a.card_revision.length > 64) errors.push("card_revision_invalid");
  if (!EXEC_RE.test(a.execution_id || "")) errors.push("execution_id_invalid");
  if (!CANDIDATE_RE.test(a.candidate_id || "")) errors.push("candidate_id_invalid");
  if (!Number.isInteger(a.candidate_revision) || a.candidate_revision < 1) errors.push("candidate_revision_invalid");
  if (!SHA256.test(a.review_artifact_digest || "")) errors.push("review_artifact_digest_invalid");
  if (a.review_verdict !== "PASS") errors.push("review_verdict_invalid");
  if (!SHA.test(a.expected_head || "")) errors.push("expected_head_invalid");
  if (!TARGET_REF_RE.test(a.target_ref || "")) errors.push("target_ref_invalid");
  else if (!ALLOWED_TARGET_REFS.has(a.target_ref)) errors.push("target_ref_not_allowlisted");
  if (!SHA.test(a.candidate_tree || "")) errors.push("candidate_tree_invalid");
  if (!SHA256.test(a.candidate_manifest_digest || "")) errors.push("candidate_manifest_digest_invalid");
  if (!Array.isArray(a.exact_changed_paths) || a.exact_changed_paths.length === 0) errors.push("exact_changed_paths_invalid");
  else {
    if (!a.exact_changed_paths.every(pathSafe)) errors.push("exact_changed_paths_unsafe");
    const sorted = [...a.exact_changed_paths].sort();
    if (canonicalize(sorted) !== canonicalize(a.exact_changed_paths)) errors.push("exact_changed_paths_unsorted");
    if (new Set(a.exact_changed_paths).size !== a.exact_changed_paths.length) errors.push("exact_changed_paths_duplicate");
  }
  if (typeof a.commit_subject !== "string" || a.commit_subject.trim().length === 0 || a.commit_subject.length > 200 || CONTROL_CHAR_RE.test(a.commit_subject)) errors.push("commit_subject_invalid");
  if (typeof a.commit_body !== "string" || a.commit_body.length > 10000 || a.commit_body.includes("\0")) errors.push("commit_body_invalid");
  for (const k of ["author_name", "committer_name"]) if (!noInjection(a[k])) errors.push(`${k}_invalid`);
  for (const k of ["author_email", "committer_email"]) if (!noInjection(a[k]) || !EMAIL_RE.test(a[k])) errors.push(`${k}_invalid`);
  for (const k of ["author_date", "committer_date"]) if (typeof a[k] !== "string" || a[k].length === 0 || Number.isNaN(Date.parse(a[k]))) errors.push(`${k}_invalid`);
  if (a.commit_allowed !== true) errors.push("commit_allowed_invalid");
  if (typeof a.authorized_by !== "string" || a.authorized_by.length === 0) errors.push("authorized_by_invalid");
  if (a.authorization_source !== "controller_operator") errors.push("authorization_source_invalid");
  if (typeof a.authorization_ref !== "string" || a.authorization_ref.length === 0) errors.push("authorization_ref_invalid");
  if (!ISO_RE.test(a.authorized_at || "")) errors.push("authorized_at_invalid");
  if (!SHA256.test(a.canonical_digest || "")) errors.push("canonical_digest_invalid");
  // Runtime maxLength must equal schema maxLength — sourced from SCHEMA.properties
  // itself (not a hand-copied second set of numbers) so the two can never drift.
  for (const k of ["author_name", "committer_name", "author_email", "committer_email", "authorized_by", "authorization_ref"]) {
    const max = SCHEMA.properties[k].maxLength;
    if (typeof a[k] === "string" && a[k].length > max) errors.push(`${k}_too_long`);
  }

  if (errors.length === 0) {
    if (computeAuthorizationId(a) !== a.authorization_id) errors.push("authorization_id_mismatch");
    if (computeCanonicalDigest(a) !== a.canonical_digest) errors.push("canonical_digest_mismatch");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Explicit operator/Controller producer. Only succeeds when the C3B terminal
 * completion for this exact candidate is durable (CURRENT snapshot at
 * CANDIDATE_MATERIALIZED_VERIFIED_COMPLETE, bound to candidateId), the durable
 * reviewer artifact strictly validates against it, and the caller supplies
 * every element of explicit commit approval (target ref, subject/body,
 * frozen author/committer identity + dates, authorized_by, authorization_ref).
 * Never commits, never touches Git refs, never pushes or seals, never creates
 * the reviewer artifact or the candidate, never called from operator-tick.
 */
export function createCommitAuthorization({
  execDir, candidateId,
  targetRef, commitSubject, commitBody,
  authorName, authorEmail, authorDate,
  committerName, committerEmail, committerDate,
  authorizedBy, authorizationRef,
  commitAllowed,
}) {
  const current = readCurrent(execDir);
  if (!current) fail(AUTHZ_HOLD.TERMINAL_STATE_MISSING, "CURRENT snapshot missing for this execution");
  const st = current.snapshot;
  if (st.state !== TERMINAL_STATE || st.c2d_control_state !== TERMINAL_STATE) {
    fail(AUTHZ_HOLD.TERMINAL_STATE_MISMATCH, `expected ${TERMINAL_STATE}, got ${st.state}`);
  }
  const transitionInput = st.input_manifest?.candidate_transition;
  const transitionEvidence = transitionInput?.evidence;
  if (!transitionInput || transitionInput.state !== TERMINAL_STATE || !transitionEvidence || transitionEvidence.candidate_id !== candidateId) {
    fail(AUTHZ_HOLD.TERMINAL_STATE_MISMATCH, "CURRENT candidate_transition does not bind candidateId at terminal state");
  }

  const candidate = readCandidate(execDir, candidateId);
  if (!candidate) fail(AUTHZ_HOLD.MISSING_CANDIDATE, "candidate artifact missing");

  const reviewPath = join(execDir, "reviews", `${candidateId}.json`);
  if (!existsSync(reviewPath)) fail(AUTHZ_HOLD.MISSING_REVIEWER_ARTIFACT, "durable reviewer artifact missing");
  assertNotSymlink(reviewPath);
  let reviewRaw;
  try { reviewRaw = JSON.parse(readFileSync(reviewPath, "utf8")); } catch (e) { fail(AUTHZ_HOLD.MISSING_REVIEWER_ARTIFACT, `reviewer artifact unreadable: ${e.message}`); }
  const artifact = requireReviewerArtifact(execDir, candidate, reviewRaw);
  if (artifact.review_verdict !== "PASS") fail(AUTHZ_HOLD.REVIEW_NOT_PASS, "review verdict not PASS");

  if (typeof targetRef !== "string" || !ALLOWED_TARGET_REFS.has(targetRef)) {
    fail(AUTHZ_HOLD.TARGET_REF_NOT_ALLOWED, `target_ref not allowlisted: ${targetRef}`);
  }
  if (typeof commitSubject !== "string" || commitSubject.trim().length === 0) {
    fail(AUTHZ_HOLD.MISSING_SUBJECT, "commit_subject required");
  }
  for (const [label, v] of [["author_name", authorName], ["committer_name", committerName]]) {
    if (typeof v !== "string" || v.length === 0) fail(AUTHZ_HOLD.MISSING_IDENTITY, `${label} required`);
  }
  for (const [label, v] of [["author_email", authorEmail], ["committer_email", committerEmail]]) {
    if (typeof v !== "string" || !EMAIL_RE.test(v)) fail(AUTHZ_HOLD.MISSING_IDENTITY, `${label} invalid or missing`);
  }
  for (const [label, v] of [["author_date", authorDate], ["committer_date", committerDate]]) {
    if (typeof v !== "string" || v.length === 0 || Number.isNaN(Date.parse(v))) fail(AUTHZ_HOLD.MISSING_IDENTITY, `${label} required`);
  }
  if (typeof authorizedBy !== "string" || authorizedBy.length === 0) fail(AUTHZ_HOLD.MISSING_APPROVAL, "authorized_by required");
  if (typeof authorizationRef !== "string" || authorizationRef.length === 0) fail(AUTHZ_HOLD.MISSING_APPROVAL, "authorization_ref required");
  // Strict boolean-true gate on the producer itself, not just the CLI: no
  // default, no truthy coercion, no environment/authority-record fallback.
  // Any future caller that invokes this library function directly (bypassing
  // create-commit-authorization.mjs) must still pass explicit true.
  if (commitAllowed !== true) fail(AUTHZ_HOLD.MISSING_APPROVAL, "commitAllowed must be exactly boolean true (explicit operator approval; no default, no coercion)");

  const exactChangedPaths = [...candidate.exact_changed_paths].sort();
  const identityFields = {
    schema: SCHEMA_ID,
    card_id: candidate.card_id,
    card_revision: candidate.card_revision,
    execution_id: candidate.execution_id,
    candidate_id: candidate.candidate_id,
    candidate_revision: candidate.candidate_revision,
    review_artifact_digest: artifact.review_artifact_digest,
    review_verdict: artifact.review_verdict,
    expected_head: candidate.expected_head,
    target_ref: targetRef,
    candidate_tree: candidate.candidate_tree,
    candidate_manifest_digest: candidate.candidate_manifest_digest,
    exact_changed_paths: exactChangedPaths,
    commit_subject: commitSubject.trim(),
    commit_body: commitBody || "",
    author_name: authorName,
    author_email: authorEmail,
    author_date: authorDate,
    committer_name: committerName,
    committer_email: committerEmail,
    committer_date: committerDate,
    commit_allowed: true,
    authorized_by: authorizedBy,
    authorization_source: "controller_operator",
    authorization_ref: authorizationRef,
  };

  const authorizationId = computeAuthorizationId(identityFields);
  const draft = { ...identityFields, authorization_id: authorizationId, authorized_at: new Date().toISOString() };
  const record = { ...draft, canonical_digest: computeCanonicalDigest(draft) };

  const check = validateCommitAuthorization(record);
  if (!check.valid) fail(AUTHZ_HOLD.MALFORMED_AUTHORIZATION, check.errors.join(","));

  const p = authorizationPath(execDir);
  if (existsSync(p)) {
    assertNotSymlink(p);
    const existing = JSON.parse(readFileSync(p, "utf8"));
    if (existing.authorization_id === authorizationId) return { status: "AUTHORIZED_EXISTING_IDENTICAL", authorization: existing };
    fail(AUTHZ_HOLD.CONFLICTING_AUTHORIZATION, "a different commit authorization already exists for this execution");
  }

  ensureDir0700(execDir);
  try {
    writeJsonExclusiveCreate(p, record);
  } catch (e) {
    if (e && e.code === FS_HOLD.JOURNAL_OUT_OF_ORDER) {
      const existing = JSON.parse(readFileSync(p, "utf8"));
      if (existing.authorization_id === authorizationId) return { status: "AUTHORIZED_EXISTING_IDENTICAL", authorization: existing };
      fail(AUTHZ_HOLD.CONFLICTING_AUTHORIZATION, "a different commit authorization was created concurrently");
    }
    throw e;
  }
  return { status: "AUTHORIZED_CREATED", authorization: record };
}

/** Full security-critical binding set a public caller must supply to
 * `requireCommitAuthorization` — every field the durable artifact is
 * contextually bound to (card, execution, candidate, review, tree, HEAD,
 * target ref, exact changed paths). Not optional: a caller that omits any of
 * these has not verified the artifact belongs to its current candidate. */
export const REQUIRED_BINDING_FIELDS = Object.freeze([
  "card_id", "card_revision", "execution_id",
  "candidate_id", "candidate_revision",
  "review_artifact_digest", "expected_head", "target_ref",
  "candidate_tree", "candidate_manifest_digest", "exact_changed_paths",
]);

/**
 * Strict existing-only reader. Never creates the artifact. Never trusts a
 * caller-claimed digest or a caller-assembled authorization object — always
 * re-reads from disk and recomputes both digests. `expectedBindings` is
 * mandatory: the caller must supply its own already-verified candidate/
 * review/tree/HEAD context, and every REQUIRED_BINDING_FIELDS entry is
 * checked against the durable record with exact equality. A caller that
 * wants to know only whether the on-disk artifact is internally
 * self-consistent (no contextual binding) is not this function's contract.
 */
export function requireCommitAuthorization(execDir, expectedBindings) {
  if (!expectedBindings || typeof expectedBindings !== "object" || Array.isArray(expectedBindings)) {
    fail(AUTHZ_HOLD.BINDING_MISMATCH, "expectedBindings is required (full contextual binding, not optional)");
  }
  for (const key of REQUIRED_BINDING_FIELDS) {
    if (!(key in expectedBindings)) fail(AUTHZ_HOLD.BINDING_MISMATCH, `expectedBindings missing ${key}`);
  }
  if (!Array.isArray(expectedBindings.exact_changed_paths) || expectedBindings.exact_changed_paths.length === 0) {
    fail(AUTHZ_HOLD.BINDING_MISMATCH, "expectedBindings.exact_changed_paths must be a non-empty array");
  }
  if (new Set(expectedBindings.exact_changed_paths).size !== expectedBindings.exact_changed_paths.length) {
    fail(AUTHZ_HOLD.BINDING_MISMATCH, "expectedBindings.exact_changed_paths contains a duplicate path");
  }

  const p = authorizationPath(execDir);
  if (!existsSync(p)) fail(AUTHZ_HOLD.AUTHORIZATION_MISSING, "commit authorization artifact missing");
  assertNotSymlink(p);
  let record;
  try { record = JSON.parse(readFileSync(p, "utf8")); } catch (e) { fail(AUTHZ_HOLD.MALFORMED_AUTHORIZATION, `parse error: ${e.message}`); }
  const check = validateCommitAuthorization(record);
  if (!check.valid) fail(AUTHZ_HOLD.MALFORMED_AUTHORIZATION, check.errors.join(","));

  const scalarKeys = ["card_id", "card_revision", "execution_id", "candidate_id", "candidate_revision", "candidate_tree", "candidate_manifest_digest", "review_artifact_digest", "expected_head", "target_ref"];
  for (const key of scalarKeys) {
    if (expectedBindings[key] !== record[key]) fail(AUTHZ_HOLD.BINDING_MISMATCH, `${key} mismatch`);
  }
  const sorted = [...expectedBindings.exact_changed_paths].sort();
  if (canonicalize(sorted) !== canonicalize(record.exact_changed_paths)) fail(AUTHZ_HOLD.BINDING_MISMATCH, "exact_changed_paths mismatch");

  return Object.freeze({ ...record });
}
