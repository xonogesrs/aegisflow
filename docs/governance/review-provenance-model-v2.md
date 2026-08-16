# Review Provenance Model v2 — candidate/baseline/authority/acceptance ordering

Card: `REVART-LC1-CANDIDATE-PROVENANCE-AND-ACCEPTANCE-ORDERING-REPAIR`
Date: 2026-08-16. Frozen before implementation. Supersedes the implicit model
that produced the CBM final-closeout HOLD
(`CBM_FINAL_CLOSEOUT_AUTHORITY_NOT_CONVERGED`).

## 0. Failure summary (evidence-bound)

The CBM card's Controller acceptance and final closeout cannot converge:

1. persisted authority record is schema-invalid (`base_head` short SHA;
   `feature_branch_push.branch_pattern` / `draft_pr.base_branch` empty) — the
   record on disk differs from the record minted at issuance
   (`projectReviewCloseout` fail-closes on schema-invalid records, so the
   minted record was valid; the persisted file was rewritten afterwards);
2. `sourceAuthorityDigest` (34d5f0b0) is not reproducible from any persisted
   serialization — the mint-time bytes are lost;
3. `outDir` persisted absolute in the review-job (`lifecycleIdentity`), relative
   in `closeout-state.json` (reseal rewrite) — `validateJobLifecycleIdentityForIngest`
   compares raw strings;
4. reseal replaced the card-start baseline (`baselineContentDigest` 203ee0e8 →
   44136fa3) in closeout-state while the job still binds the original;
5. acceptance candidate check compares live `currentHead` (`faa4e26`) against
   the frozen candidate (`251d9ae`); the review/evidence commits advanced HEAD
   before acceptance — `REVIEW_CANDIDATE_DRIFT` on a state that is impossible
   to recreate;
6. canonical review artifacts were committed before acceptance, so the staged
   set is empty at ingest — `REVIEW_STAGED_SET_DRIFT`;
7. final closeout compares the bundle's bound `HEAD`/`TREE_SHA`/`FINAL_DIRTY_DIGEST`
   against live repo facts — `stale_implementation_head` / `working_tree_mutated`.

Root cause: the model equated "live repository HEAD" with "implementation
candidate HEAD" and let governance/evidence commits advance the live position
before acceptance. That state is unreachable by construction.

## 1. Five identities (frozen)

### 1.1 Authority identity
- Source: the single persisted lifecycle-authorization record file.
- Invariant: `sourceAuthorityDigest == authorityDigest(persisted_record)` —
  digest of the canonical JSON of the persisted bytes; reproducible at any
  later time; any mutation after freeze → `HOLD / ADMISSION_DRIFT`.
- Issuance MUST validate the record against its own schema before persisting;
  no downstream tool is the first place schema invalidity is discovered.
- Chain equality (Phase 3):
  `authorityDigest(record) == admission.authority_binding.authority_record_digest`
  `== admission.review_closeout.source_authority_digest`
  `== closeout-state.reviewCloseout.bindingDigest` (derived)
  `== review-job.lifecycleIdentity.sourceAuthorityDigest`.

### 1.2 Admission identity
- `admissionId` + `reviewCloseoutBindingDigest` (whole frozen binding,
  containing the relative `out_dir` and `source_authority_digest`).
- Unchanged semantics. No weakening of ADMISSION_DRIFT.

### 1.3 Candidate identity (frozen at review-job creation)
- Persisted: `{ repository, worktree, baseHead, currentHead (candidate commit),
  changedTreeIdentity, patchSha256, branch }`.
- `currentHead` is a RECORDED FACT (the candidate commit), not a live-HEAD
  requirement.
- Candidate integrity = CONTENT equality: `changedTreeIdentity` + `patchSha256`
  recomputed from the authority-bound range (`baseHead..live HEAD`, candidate
  domain filtered) equal the frozen values, plus `baseHead` / `repository` /
  `branch` match. Governance-only commits must never trigger candidate drift
  (empirically: at HEAD faa4e26 all content fields still match the frozen
  CBM job; only `currentHead` differs).
- Candidate commit reachability: frozen `currentHead` must be an ancestor of
  live HEAD at acceptance and final closeout.

### 1.4 Baseline identity
- Captured ONCE at card start (`captureBaselineInventory` in
  `prepareReviewLifecycle`); persisted in closeout-state `baseline`.
- A reseal INHERITS the original baseline; it never replaces
  `baselineContentDigest` / baseline `head` / `treeSha` with its own later
  working-tree snapshot. New implementation generation = new card.

### 1.5 Governance artifact identity
- Findings, verdict, review-job state, closeout evidence, reseal artifacts.
- May advance repository HEAD after candidate freeze; must not redefine the
  candidate. Never equated with the candidate identity.

## 2. out_dir canonical form (Phase 4)

- Persistence form: repo-relative normalized path (forward slashes, no leading
  `/`, no `..`). `authority.closeout_metadata.out_dir`, binding `out_dir`,
  closeout-state `outDir`, job `lifecycleIdentity.outDir`.
- Runtime resolution: `resolvedOutDir = resolve(authoritativeWorktree,
  canonicalOutDir)`; the absolute value is operational, never an identity
  owner. Every operational consumer (runStateDrivenCloseout idempotent
  re-entry, contract materialization, runMandatoryGraphCloseout, source
  builder) resolves the canonical form against `cwd ?? repoPath` before use —
  absolute values pass through untouched.
- Comparisons normalize both sides (resolve relative against the worktree root,
  or convert absolute → relative) before equality. Legacy absolute persisted
  values remain valid; representation drift → `HOLD / REVIEW_JOB_ROOT_BINDING_DRIFT`
  only when the paths genuinely differ.
- New writes persist the canonical relative form.

## 3. currentHead check classification (Phase 7)

| Site | Classification | Repair |
|---|---|---|
| `acceptReviewJob` candidateDrift (review-job.mjs) | candidate integrity | content fields only; currentHead recorded fact |
| `review-artifact-gate.mjs` candidateDrift | candidate integrity | content fields only (binds review to candidate, not live HEAD) |
| `review-lifecycle.mjs` ensureCurrentReviewJob | creation/resume | keep full-field — at ensure time live HEAD IS the candidate (no governance commits yet), and the full-field comparison catches a tampered `currentHead` field that content checks cannot see |
| `external-review.mjs` / `feature-branch-push-gate.mjs` current_head checks | candidate integrity | compare against frozen candidate commit (result binding), not live HEAD |
| `verifyAppliedCloseoutBundle` boundHead/boundTree/boundDirty | live-worktree safety | candidate integrity + implementation-scoped dirty check (below) |

No invariant may require both `HEAD == candidateCommit` AND committed
governance/review artifacts before ACCEPTED.

## 4. Acceptance ordering (Phase 6)

1. valid authority issued (schema-validated) → 2. admission frozen →
3. baseline frozen (card start) → 4. implementation performed →
5. candidate frozen (review-job created with live HEAD == candidate) →
6. candidate commit may exist → 7. review bundle/evidence generated →
8. review job created → 9. findings/verdict produced →
10. three canonical artifacts staged (stageArtifacts) OR maintained committed
    at HEAD in the sanctioned pre-acceptance representation →
11. Controller validates candidate (content) + review identity →
12. sole `acceptReviewJob` mint STAGED → ACCEPTED →
13. final closeout → 14. governance/evidence commit → 15. publication.

Between 5 and 12: candidate identity must not change; governance commits must
not redefine the candidate; acceptance must NOT require live HEAD == candidate
HEAD.

## 5. Staged-set contract (Phase 6 / T11-T12)

The staged-set check keeps its exact-set property (bidirectionally equal to the
three canonical artifacts) and accepts two representations:

- `staged`: `git diff --cached --name-only` (prefix-normalized) == the 3
  canonical paths, nothing else staged;
- `committed`: index clean AND the 3 canonical artifacts exist at HEAD
  (verified by digest recompute from persisted bytes + `git ls-tree HEAD`).

Anything else → `REVIEW_STAGED_SET_DRIFT` with a diagnostic naming both
representations. Committing artifacts before ACCEPTED is thereby SUPPORTED
(T12 option B) — no history surgery, no candidate unreachability.

## 6. Final-closeout bundle verification (Phase 7/8)

`verifyAppliedCloseoutBundle` with `repoPath`:

- bundle identity/sha/validation checks unchanged;
- live repo facts must be readable (fail closed);
- when a review-job exists at `dirname(outDir)`: candidate integrity —
  frozen candidate commit is an ancestor of live HEAD; recomputed
  `changedTreeIdentity`/`patchSha256` (authority range, candidate-domain
  filtered) equal the job's bound values;
- working-tree safety: candidate-domain-filtered dirty set must be empty
  (no implementation-path mutation); governance/evidence dirty state is not
  authority-bearing;
- no job present (legacy): fall back to the recorded HEAD/TREE_SHA equality.

## 7. Reseal semantics (Phase 8)

A reseal inherits: original authority identity, admission identity, candidate
identity, baseline identity (closeout-state `baseline` block, card-start
values). It may change only review-generation identities (bundle identity/SHA,
supersession pointer, generation metadata, evidence manifest). It must not
replace candidate HEAD/tree, `baselineContentDigest`, `sourceAuthorityDigest`,
canonical `out_dir`.

## 8. Closeout-state synchronization (Phase 9)

- `closeout-state.json` `closeout` block is DESCRIPTIVE, not authority.
- The authoritative review record is the surface `delivery.json`.
- On idempotent final-PASS re-entry, `runStateDrivenCloseout` reconciles the
  descriptive `closeout` block from the authoritative surface record
  (externalReviewStatus PASS / verdict PASS / stage REVIEW_ACCEPTED) — one
  sanctioned write point; no new authority owner.
- The final-closeout gate never consumes the descriptive block as authority.

## 9. Committed-before-baseline attribution (Phase 5)

- Card inventory delta gains an optional authority-bound implementation range
  (from the review-job: `baseHead → currentHead`).
- With a range: `CARD_IMPLEMENTATION_FILES` / ADDED / MODIFIED / DELETED =
  range diff (candidate-domain filtered) merged with the porcelain dirty delta
  (implementation-scoped). Clean worktree with committed candidate still
  attributes the full implementation set.
- Without a range (legacy): unchanged porcelain-only behavior.
- Baseline stays the card-start snapshot; the range is provenance, not baseline.

## 10. Migration for the blocked CBM card (Phase 11)

Minimal governed reconstruction, no CBM production bytes touched, no external
review re-done:

1. Re-issue the authority record to its minted, schema-valid content (full
   `base`/`base_head` = d36d016..., `branch_pattern: "governance/*"`,
   `base_branch: "main"`); `validateAuthorityRecord` must pass; digest D' from
   persisted bytes.
2. admission.json: `authority_binding.authority_record_digest := D'`;
   `review_closeout.source_authority_digest := D'`; re-derive
   `reviewCloseoutBindingDigest` B' over the updated binding.
3. closeout-state.json: `reviewCloseout.bindingDigest := B'`; restore
   card-start `baseline` (from the original bootstrap, head 251d9ae /
   contentDigest 203ee0e8); `outDir` stays canonical relative.
4. review-job.json `lifecycleIdentity`: `sourceAuthorityDigest := D'`,
   `bindingDigest := B'`, `outDir` := canonical relative; candidate identity,
   findings/verdict digests untouched; stateVersion 7 → 8 (governed write).
5. Controller ingest (existing sole ACCEPTED path) → ACCEPTED.
6. Final closeout (repaired gate) → PASS.
7. Governance commit of the migrated chain + acceptance.

## 11. Non-negotiable invariants

- exactly one ACCEPTED mint site (`acceptReviewJob`, CAS stateVersion);
- `authorityDigest(persisted record)` reproducible at any time;
- candidate content identity survives governance evidence progression;
- no live-HEAD equality for candidate checks;
- reseal never changes candidate/baseline/authority identity;
- no CBM production behavior change.
