// src/governance/review-job.mjs
//
// AUTOLOOP-REVART-IMPL1 — Flow 2 review-job binding identity + state machine.
//
// Sole owner of the Flow 2 review-job record: a durable binding object that
// connects review lineage, exact attempt/generation, candidate identity, spec
// identity, required-artifact contract, reviewer result identity, persistence
// state, and supersession.
//
// It is NOT another review history, candidate database, delivery database, or
// ACCEPTED authority. Candidate identity is recomputed by change-inventory;
// lineage by review-history; delivery by delivery.json; acceptance by the
// acceptance authority (gov-controller-ingest-result.mjs).
//
// Artifact model (frozen by IMPL1-FREEZE):
//   docs/pi-graph-output/<card-id>/
//     review-findings.gNNNN.json    immutable per generation — exclusive-create
//     review-verdict.gNNNN.json     immutable per generation — exclusive-create
//     review-job.json               current binding — CAS atomic-replace
//
// Generation is monotonic and never reused; current generation is resolved by
// the explicit review-job.json current pointer, never by timestamp scan.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Text } from "../evidence/run-evidence-store.mjs";
import { validateAgainstSchema } from "./lifecycle-authorization.mjs";
import {
  writeJsonExclusiveCreate,
  writeJsonAtomicReplaceUnderLock,
  assertNotSymlink,
} from "../c2d/fs-atomic.mjs";
import { candidateDrift, specDrift } from "./review-job-context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadSchema(name) {
  return JSON.parse(readFileSync(join(HERE, "..", "schema", name), "utf8"));
}

export const REVIEW_JOB_SCHEMA = loadSchema("review-job.schema.json");
export const REVIEW_FINDINGS_SCHEMA = loadSchema("review-findings.schema.json");
export const REVIEW_VERDICT_SCHEMA = loadSchema("review-verdict.schema.json");

export const REVIEW_JOB_SCHEMA_ID = "autoloop.review-job/v1";
export const REVIEW_FINDINGS_SCHEMA_ID = "autoloop.review-findings/v1";
export const REVIEW_VERDICT_SCHEMA_ID = "autoloop.review-verdict/v1";

export const REVIEW_JOB_STATES = Object.freeze([
  "REQUIRED",
  "PREPARED",
  "RUNNING",
  "FINDINGS_CAPTURED",
  "VERDICT_PRODUCED",
  "PERSISTED",
  "STAGED",
  "ACCEPTED",
  "DOWNSTREAM_AUTHORIZED",
  "SUPERSEDED",
  "HOLD",
]);

// Forward transitions (RC1A §4 T1–T8). SUPERSEDED/HOLD are added per T9/T10.
const FORWARD = Object.freeze({
  REQUIRED: ["PREPARED"],
  PREPARED: ["RUNNING"],
  RUNNING: ["FINDINGS_CAPTURED"],
  FINDINGS_CAPTURED: ["VERDICT_PRODUCED"],
  VERDICT_PRODUCED: ["PERSISTED"],
  PERSISTED: ["STAGED"],
  STAGED: ["ACCEPTED"],
  ACCEPTED: ["DOWNSTREAM_AUTHORIZED"],
  DOWNSTREAM_AUTHORIZED: [],
});

export function allowedTransitions(from) {
  const out = new Set([from]); // idempotent resume
  for (const t of FORWARD[from] ?? []) out.add(t);
  if (from !== "SUPERSEDED") out.add("SUPERSEDED"); // T9
  if (from !== "SUPERSEDED" && from !== "HOLD") out.add("HOLD"); // T10
  return [...out];
}

export class ReviewJobError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "ReviewJobError";
    this.code = code;
  }
}

export function assertReviewJobTransition(from, to) {
  if (!REVIEW_JOB_STATES.includes(from) || !REVIEW_JOB_STATES.includes(to)) {
    throw new ReviewJobError("REVIEW_JOB_UNKNOWN_STATE", `unknown state: ${from} -> ${to}`);
  }
  if (!allowedTransitions(from).includes(to)) {
    throw new ReviewJobError("REVIEW_JOB_ILLEGAL_TRANSITION", `illegal transition: ${from} -> ${to}`);
  }
  return to;
}

// ── Path derivation ──────────────────────────────────────────────────────

export function reviewJobRoot(opts = {}) {
  const root = opts.root ?? process.env.AUTOLOOP_PI_GRAPH_OUTPUT ?? null;
  if (root) return root;
  return join(process.cwd(), "docs", "pi-graph-output");
}

export function reviewJobDir(cardId, opts = {}) {
  return join(reviewJobRoot(opts), cardId);
}

export function generationLabel(generation) {
  return `g${String(generation).padStart(4, "0")}`;
}

export function reviewJobPath(cardId, opts = {}) {
  return join(reviewJobDir(cardId, opts), "review-job.json");
}

export function findingsPath(cardId, generation, opts = {}) {
  return join(reviewJobDir(cardId, opts), `review-findings.${generationLabel(generation)}.json`);
}

export function verdictPath(cardId, generation, opts = {}) {
  return join(reviewJobDir(cardId, opts), `review-verdict.${generationLabel(generation)}.json`);
}

export function jobIdFor(cardId, generation) {
  return `${cardId}.${generationLabel(generation)}`;
}

/**
 * Canonical review-job artifact paths relative to the pi-graph-output root.
 * The exact required staged set for a generation (RC2 freeze §4.2/§6).
 */
export function canonicalArtifactRelativePaths(cardId, generation) {
  return [
    `${cardId}/review-job.json`,
    `${cardId}/review-findings.${generationLabel(generation)}.json`,
    `${cardId}/review-verdict.${generationLabel(generation)}.json`,
  ];
}

// ── CRUD ─────────────────────────────────────────────────────────────────

export function createReviewJob({
  cardId,
  generation,
  candidateIdentity,
  specId,
  specDigest,
  reviewRound = 1,
  repairRound = 0,
  repoIdentity,
  worktreeIdentity,
  priorJobId,
  priorFindingsDigest,
  priorVerdictDigest,
  supersedes,
  requiredArtifacts = [
    { role: "findings", required: true, writeMode: "exclusive-create" },
    { role: "verdict", required: true, writeMode: "exclusive-create" },
  ],
}, opts = {}) {
  const job = {
    schemaVersion: REVIEW_JOB_SCHEMA_ID,
    lineageId: cardId,
    jobId: jobIdFor(cardId, generation),
    generation,
    candidateIdentity,
    specId,
    specDigest,
    reviewRound,
    repairRound,
    state: "REQUIRED",
    stateVersion: 1,
    requiredArtifacts,
  };
  if (repoIdentity !== undefined) job.repoIdentity = repoIdentity;
  if (worktreeIdentity !== undefined) job.worktreeIdentity = worktreeIdentity;
  if (priorJobId !== undefined) job.priorJobId = priorJobId;
  if (priorFindingsDigest !== undefined) job.priorFindingsDigest = priorFindingsDigest;
  if (priorVerdictDigest !== undefined) job.priorVerdictDigest = priorVerdictDigest;
  if (supersedes !== undefined) job.supersedes = supersedes;

  const errors = validateAgainstSchema(REVIEW_JOB_SCHEMA, job, "review-job");
  if (errors.length > 0) {
    throw new ReviewJobError("REVIEW_JOB_SCHEMA_INVALID", errors.join("; "));
  }
  const path = reviewJobPath(cardId, opts);
  writeJsonExclusiveCreate(path, job);
  return { ok: true, job, path };
}

// ── Successor generation (AUTH1-TC1 R-TC1-02) ──────────────────────────

/**
 * Create a successor review job (new generation) from the current job.
 *
 * This is the formal revalidation path for context drift (§29 / AC15): when
 * the reviewed context changes (e.g. the candidate is committed and HEAD
 * moves), the current ACCEPTED job is stale and MUST be superseded, then a
 * fresh generation bound to the NEW context is created.
 *
 * Transition (single caller-facing operation):
 *   current (non-terminal) → SUPERSEDED (supersededBy = new jobId)
 *     → current pointer converges atomically to the new REQUIRED generation
 *
 * Legal predecessor:
 *   - current.state ∉ {SUPERSEDED, HOLD}  → normal path (supersede + converge)
 *   - current.state == SUPERSEDED && current.supersededBy == new jobId
 *     → crash-resume (supersede completed, converge pending)
 *   - otherwise → fail closed (REVIEW_JOB_SUPERSEEDED_BY_OTHER /
 *     REVIEW_JOB_TERMINAL_HELD)
 *
 * Idempotency: when `predecessorJobId` is supplied and the current pointer is
 * already the successor of that predecessor (supersedes == predecessorJobId),
 * returns the existing successor (crash after converge).
 *
 * Invariants (R-TC1-02): generation monotonic; same lineageId; lineage links
 * priorJobId / priorFindingsDigest / priorVerdictDigest / supersedes carried;
 * predecessor findings/verdict artifacts untouched; current pointer converged
 * via atomic replace (never delete-and-recreate); the supersede CAS makes
 * concurrent successor creation fail closed; a stale predecessor can never
 * re-satisfy live enforcement (assertReviewArtifactEnforced requires the
 * current pointer to be ACCEPTED and reads only that pointer).
 */
export function createSuccessorReviewJob({
  cardId,
  candidateIdentity,
  specId,
  specDigest,
  predecessorJobId = null,
  reviewRound = 1,
  repairRound = 0,
  repoIdentity,
  worktreeIdentity,
} = {}, opts = {}) {
  const current = readReviewJob(cardId, opts);
  if (!current.ok) return current;
  const job = current.job;

  // Idempotent resume: current pointer already IS the successor of the
  // intended predecessor (crash after converge).
  if (predecessorJobId && job.supersedes === predecessorJobId) {
    return { ok: true, idempotent: true, job, path: current.path, predecessor: predecessorJobId };
  }

  const newGeneration = job.generation + 1;
  const newJobId = jobIdFor(cardId, newGeneration);

  // Legal predecessor checks (fail closed).
  if (job.state === "HOLD") {
    return { ok: false, code: "REVIEW_JOB_TERMINAL_HELD", job, path: current.path };
  }
  if (job.state === "SUPERSEDED") {
    if (job.supersededBy !== newJobId) {
      return { ok: false, code: "REVIEW_JOB_SUPERSEEDED_BY_OTHER", supersededBy: job.supersededBy, job, path: current.path };
    }
    // crash-resume: supersede already persisted; fall through to converge.
  } else {
    // Normal path: mark the predecessor SUPERSEDED first (CAS). A concurrent
    // successor creator loses this CAS → fail closed (never two g0002).
    const s = updateReviewJob(cardId, {
      expectedStateVersion: job.stateVersion,
      patch: { state: "SUPERSEDED", supersededBy: newJobId },
    }, opts);
    if (!s.ok) return s;
  }

  // Re-read: the predecessor must now be SUPERSEDED by exactly this successor.
  const predRead = readReviewJob(cardId, opts);
  if (!predRead.ok) return predRead;
  const pred = predRead.job;
  if (pred.state !== "SUPERSEDED" || pred.supersededBy !== newJobId) {
    return { ok: false, code: "REVIEW_JOB_PREDECESSOR_NOT_SUPERSEDED", state: pred.state, supersededBy: pred.supersededBy ?? null, path: current.path };
  }

  // Build the successor job (same lineage, monotonic generation, lineage
  // links). State REQUIRED — it runs the full lifecycle like a fresh job.
  const successor = {
    schemaVersion: REVIEW_JOB_SCHEMA_ID,
    lineageId: cardId,
    jobId: newJobId,
    generation: newGeneration,
    candidateIdentity,
    specId,
    specDigest,
    reviewRound,
    repairRound,
    priorJobId: pred.jobId,
    supersedes: pred.jobId,
    state: "REQUIRED",
    stateVersion: 1,
    requiredArtifacts: [
      { role: "findings", required: true, writeMode: "exclusive-create" },
      { role: "verdict", required: true, writeMode: "exclusive-create" },
    ],
  };
  if (pred.findingsDigest !== undefined) successor.priorFindingsDigest = pred.findingsDigest;
  if (pred.verdictDigest !== undefined) successor.priorVerdictDigest = pred.verdictDigest;
  if (repoIdentity !== undefined) successor.repoIdentity = repoIdentity;
  if (worktreeIdentity !== undefined) successor.worktreeIdentity = worktreeIdentity;

  const errors = validateAgainstSchema(REVIEW_JOB_SCHEMA, successor, "review-job");
  if (errors.length > 0) {
    return { ok: false, code: "REVIEW_JOB_SCHEMA_INVALID", errors, path: current.path };
  }

  // Converge the current pointer atomically (replace under lock; never
  // delete-and-recreate).
  const path = reviewJobPath(cardId, opts);
  try {
    writeJsonAtomicReplaceUnderLock(path, successor);
  } catch (e) {
    return { ok: false, code: "REVIEW_JOB_POINTER_CONVERGE_FAILED", error: e?.message ?? String(e), path };
  }
  return { ok: true, job: successor, predecessor: pred.jobId, path, superseded: true };
}

export function readReviewJob(cardId, opts = {}) {
  const path = reviewJobPath(cardId, opts);
  if (!existsSync(path)) {
    return { ok: false, code: "REVIEW_JOB_MISSING", job: null, path };
  }
  assertNotSymlink(path);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, code: "REVIEW_JOB_UNREADABLE", job: null, path };
  }
  const errors = validateAgainstSchema(REVIEW_JOB_SCHEMA, raw, "review-job");
  if (errors.length > 0) {
    return { ok: false, code: "REVIEW_JOB_INVALID", errors, job: null, path };
  }
  return { ok: true, job: raw, path };
}

/**
 * CAS update of the current review-job record. Rejects when the observed
 * state / stateVersion / generation does not match the expected value.
 * Bumps stateVersion monotonically. Uses atomic replace-under-lock.
 */
export function updateReviewJob(cardId, {
  expectedState = null,
  expectedStateVersion = null,
  expectedGeneration = null,
  patch = {},
}, opts = {}) {
  const current = readReviewJob(cardId, opts);
  if (!current.ok) return current;
  const job = current.job;
  if (expectedState !== null && job.state !== expectedState) {
    return { ok: false, code: "REVIEW_JOB_STATE_MISMATCH", expected: expectedState, actual: job.state, job, path: current.path };
  }
  if (expectedStateVersion !== null && job.stateVersion !== expectedStateVersion) {
    return { ok: false, code: "REVIEW_JOB_STATE_VERSION_MISMATCH", expected: expectedStateVersion, actual: job.stateVersion, job, path: current.path };
  }
  if (expectedGeneration !== null && job.generation !== expectedGeneration) {
    return { ok: false, code: "REVIEW_JOB_GENERATION_MISMATCH", expected: expectedGeneration, actual: job.generation, job, path: current.path };
  }
  const next = { ...job, ...patch, stateVersion: job.stateVersion + 1 };
  const errors = validateAgainstSchema(REVIEW_JOB_SCHEMA, next, "review-job");
  if (errors.length > 0) {
    return { ok: false, code: "REVIEW_JOB_SCHEMA_INVALID", errors, job, path: current.path };
  }
  writeJsonAtomicReplaceUnderLock(current.path, next);
  return { ok: true, job: next, path: current.path };
}

/**
 * Advance the review-job state. Idempotent when already in the target state
 * (resume); otherwise requires the job to be in the expected `from` state.
 */
export function advanceState(cardId, from, to, opts = {}) {
  assertReviewJobTransition(from, to);
  const current = readReviewJob(cardId, opts);
  if (!current.ok) return current;
  if (current.job.state === to) {
    return { ok: true, job: current.job, path: current.path, alreadyInState: true };
  }
  if (current.job.state !== from) {
    return { ok: false, code: "REVIEW_JOB_STATE_MISMATCH", expected: from, actual: current.job.state, job: current.job, path: current.path };
  }
  return updateReviewJob(cardId, { expectedStateVersion: current.job.stateVersion, patch: { state: to } }, opts);
}

/** Supersede the current job (T9). Terminal; never reusable. */
export function supersede(cardId, supersededBy, opts = {}) {
  const current = readReviewJob(cardId, opts);
  if (!current.ok) return current;
  if (current.job.state === "SUPERSEDED") {
    return { ok: true, job: current.job, path: current.path, alreadySuperseded: true };
  }
  return updateReviewJob(cardId, {
    expectedStateVersion: current.job.stateVersion,
    patch: { state: "SUPERSEDED", supersededBy },
  }, opts);
}

/**
 * Acceptance authority: mint ACCEPTED (STAGED → ACCEPTED).
 *
 * This is the ONLY path to ACCEPTED. It recomputes the full chain from
 * durable artifacts and is never self-grantable:
 *   - job must be STAGED (STAGED is a prerequisite to ACCEPTED)
 *   - findings + verdict artifacts must exist and their digests recompute
 *   - verdict must be PASS
 *   - reviewer identity must not be the implementer and must not be agent:self
 *   - CAS stateVersion ensures ACCEPTED is minted at most once
 *
 * The reviewer never calls this; it is controller-operator-owned.
 */
export function acceptReviewJob({
  cardId,
  implementerIdentity = null,
  authorizationSource = null,
  trustedReviewerIdentity = null,
  recomputed = null,
}, opts = {}) {
  const current = readReviewJob(cardId, opts);
  if (!current.ok) return current;
  const job = current.job;
  if (job.state === "ACCEPTED" || job.state === "DOWNSTREAM_AUTHORIZED") {
    return { ok: true, idempotent: true, job, path: current.path };
  }
  if (job.state !== "STAGED") {
    return { ok: false, code: "REVIEW_JOB_STATE_MISMATCH", expected: "STAGED", actual: job.state, job, path: current.path };
  }
  if (!job.findingsDigest || !job.verdictDigest) {
    return { ok: false, code: "REVIEW_JOB_DIGESTS_UNBOUND", job, path: current.path };
  }
  // Acceptance authority must be controller-supplied (second-channel).
  if (!authorizationSource) {
    return { ok: false, code: "REVIEW_ACCEPTANCE_AUTHORITY_MISSING", job, path: current.path };
  }

  let fbytes, vbytes, verdictArtifact;
  try {
    fbytes = readFileSync(findingsPath(cardId, job.generation, opts), "utf8");
    vbytes = readFileSync(verdictPath(cardId, job.generation, opts), "utf8");
    verdictArtifact = JSON.parse(vbytes);
  } catch {
    return { ok: false, code: "REVIEW_ARTIFACT_MISSING", job, path: current.path };
  }
  // Recompute digests from persisted bytes — never trust bound fields alone.
  if (sha256Text(fbytes) !== job.findingsDigest) {
    return { ok: false, code: "REVIEW_FINDINGS_DIGEST_MISMATCH", job, path: current.path };
  }
  if (sha256Text(vbytes) !== job.verdictDigest) {
    return { ok: false, code: "REVIEW_VERDICT_DIGEST_MISMATCH", job, path: current.path };
  }
  if (verdictArtifact.verdict !== "PASS") {
    return { ok: false, code: "REVIEW_VERDICT_NOT_PASS", verdict: verdictArtifact.verdict, job, path: current.path };
  }
  // Independence: reviewer must not be self/agent/implementer.
  const reviewer = verdictArtifact.reviewerIdentity ?? "";
  if (!reviewer || /^agent:/i.test(reviewer)) {
    return { ok: false, code: "REVIEW_SELF_DECLARED_REVIEWER", reviewer, job, path: current.path };
  }
  if (implementerIdentity && reviewer === implementerIdentity) {
    return { ok: false, code: "REVIEW_SELF_DECLARED_REVIEWER", reviewer, job, path: current.path };
  }

  // RC2 D4 — trusted reviewer identity binding (controller second channel).
  // A full-recompute (production) acceptance must bind a trusted identity;
  // a supplied trusted identity must equal the persisted verdict identity.
  if (trustedReviewerIdentity) {
    if (reviewer !== trustedReviewerIdentity) {
      return { ok: false, code: "REVIEWER_IDENTITY_MISMATCH", reviewer, trustedReviewerIdentity, job, path: current.path };
    }
  } else if (recomputed) {
    return { ok: false, code: "REVIEWER_IDENTITY_MISSING", reviewer, job, path: current.path };
  }

  // RC2 freeze §6/§8 — full recompute + field comparison at acceptance.
  if (recomputed) {
    const drift = candidateDrift(job.candidateIdentity, recomputed.candidateIdentity);
    if (drift.length > 0) {
      return { ok: false, code: "REVIEW_CANDIDATE_DRIFT", drift, job, path: current.path };
    }
    if (specDrift(job.specDigest, recomputed.specIdentity?.specDigest)) {
      return { ok: false, code: "REVIEW_SPEC_DRIFT", bound: job.specDigest, recomputed: recomputed.specIdentity?.specDigest ?? null, job, path: current.path };
    }
    const expectedStaged = [...canonicalArtifactRelativePaths(cardId, job.generation)].sort();
    const actualStaged = [...(recomputed.stagedSet ?? [])].sort();
    if (expectedStaged.length !== actualStaged.length || expectedStaged.some((p, i) => p !== actualStaged[i])) {
      return { ok: false, code: "REVIEW_STAGED_SET_DRIFT", expected: expectedStaged, actual: actualStaged, job, path: current.path };
    }
    if (recomputed.repositoryVerified !== true) {
      return { ok: false, code: "REVIEW_REPOSITORY_UNVERIFIED", job, path: current.path };
    }
  }

  return updateReviewJob(cardId, {
    expectedStateVersion: job.stateVersion,
    patch: { state: "ACCEPTED", acceptedAt: new Date().toISOString(), acceptanceAuthority: authorizationSource },
  }, opts);
}

export { sha256Text };
