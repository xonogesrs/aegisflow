# AUTOLOOP-REVART-LC1-B2 — Review-Job Materialization + Controller Ingest Convergence

## Purpose

Close the architectural seam between admitted review-required execution
(REVIEW_PENDING) and the review-job lifecycle: the review job must be part of
the governed runtime lifecycle, not a manual orchestration chain, and
Controller ingestion must independently validate the job against the
authoritative lifecycle identity.

## Scope (authorized mutation set)

- `src/schema/review-job.schema.json` — additive `lifecycleIdentity` block
- `src/governance/review-job.mjs` — lifecycleIdentity pass-through (create +
  successor)
- `src/governance/review-lifecycle.mjs` — ensureCurrentReviewJob,
  resolveReviewJobRoot, identity chain, ingest validation helper
- `src/admission/admission-gate.mjs` — state-driven terminal + job
  materialization wiring
- `src/control-plane/coordinator.mjs` — consumer gate reads governed job root
- `scripts/gov-controller-ingest-result.mjs` — governed root + chain
  validation (B2-5)
- tests: test/governance/test-review-job-convergence.mjs,
  test/control-plane/test-review-required-coordinator.mjs,
  test/governance/test-v3-gov-scripts.mjs,
  test/governance/test-review-lifecycle.mjs (updated B1 negative)

## Requirements

B2-1 ensureCurrentReviewJob: create-or-verify-or-HOLD, idempotent, exactly
one job, never silently replace a conflicting job.
B2-2 review-job root derived from authority-bound out_dir — never
process.cwd(); persisted-state verification; REVIEW_JOB_ROOT_BINDING_DRIFT.
B2-3 job bound to the lifecycle identity chain (admission_id, binding digest,
source authority digest, out_dir, baseline content digest) + lineage/spec/
candidate.
B2-4 runtime delivery governed; CLI manual/tooling-only.
B2-5 Controller ingest independently validates job + result vs the
authoritative identity; sole ACCEPTED mint preserved.
B2-6 REVIEW_PENDING while review unresolved; PASS only via acceptance
authority.
B2-7 resume matrix A–E; identity drift at any stage HOLDs.

## Acceptance

T1 coordinator + review-required binding E2E. T2 durable checkpoint/resume
identity. T3 v3 through gov-* validators. T4 frozen binding tamper →
ADMISSION_DRIFT. N1–N12 negative matrix. Exactly one ACCEPTED mint site.
No second identity owner, no cwd-derived authority, no runner-supplied
fallback metadata, no new PASS mint site.
