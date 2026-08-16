# AUTH1-TC1 — Terminal Review Ordering + Successor Generation Contract

## 1. Terminal Review Ordering Contract (R-TC1-01)

**Terminal ACCEPTED review MUST bind the final local commit HEAD that will be
pushed / opened as a PR. Pre-commit working-tree review may exist at earlier
stages, but MUST NOT serve as terminal promotion acceptance.**

Rationale (proven by AUTH1-TA1 transition proof): `candidateIdentity.currentHead`
is an authoritative binding field (`review-job-context.mjs` CANDIDATE_FIELDS).
Committing changes HEAD → `assertReviewArtifactEnforced` reports
`candidate drift [currentHead]` → the pre-commit ACCEPTED artifact is stale.

The mechanical enforcement already exists and MUST be preserved (do not remove
or weaken `currentHead` binding): live currentHead == job currentHead, else
HOLD. This contract makes the ordering rule explicit:

```text
candidate implementation complete
→ final authority/grants freeze
→ exact scoped local commit
→ terminal independent review against final HEAD
→ ACCEPTED
→ enforcement
→ push
→ PR
```

## 2. checkpoint_commit Semantics Classification (R-TC1-03 first read-only gate)

### 2.1 Evidence (source of truth)

- `src/governance/checkpoint-commit-gate.mjs` — internal checkpoint commit gate
  (§8.1). A checkpoint commit is a *local* rollback point / milestone boundary;
  it does NOT require external review PASS and must NEVER be pushed. The gate
  fails closed when `checkpoint_commit.allowed !== true` ("push_allowed_by_authority"
  style check: `checkpoint_commit.allowed is false (fail-closed)"`).
- `scripts/gov-commit-checkpoint.mjs --apply` — the ONLY governance-authorized
  path that actually creates a local commit (`git add` + `git commit` with the
  gate footer). Dry-run by default.
- `src/governance/integration-commit-gate.mjs` — integration attestation (§8.2).
  It NEVER creates a commit: it verifies current HEAD + tree exactly match the
  reviewed artifact and records INTEGRATION_READY. Header comment: "creating a
  commit after review would change HEAD and invalidate the reviewed identity
  (external PASS authorizes pushing the reviewed checkpoint HEAD — push then
  re-verifies the same identity)".
- `evaluateIntegrationCommitGate` COMPOSES `evaluateCheckpointCommitGate`
  (local conditions) — therefore `checkpoint_commit.allowed===true` is a
  prerequisite of BOTH commit classes.

### 2.2 Classification

| Question | Answer |
|---|---|
| Is `checkpoint_commit` merely a promotion/push gate? | **No.** It authorizes *creating* the local (checkpoint) commit itself. Push has its own gate (`feature_branch_push`). |
| Is it a prerequisite of the integration attestation? | **Yes.** `evaluateIntegrationCommitGate` composes the checkpoint gate's local conditions → `checkpoint_commit.allowed===true` required there too. |
| Does `allowed=false` prohibit the local commit itself? | **Yes, it blocks the governance-authorized commit creation path** (checkpoint gate rejects). It does not retroactively delete a raw git commit; the gates are forward-evaluating. |
| So the design intent? | **Commit BEFORE review.** The checkpoint commit is the reviewed HEAD; review binds it; integration attests HEAD == reviewed HEAD; push re-verifies the same identity. |

### 2.3 Formal impact on the existing local commit `dc51b4a` (AUTH1)

- `dc51b4a` was created by a plain `git commit`, NOT through
  `gov-commit-checkpoint.mjs --apply` (which would have rejected:
  `checkpoint_commit.allowed=false`).
- Per the gate semantics it is **not a governance-authorized commit** → it is
  NOT directly usable as the authoritative final candidate.
- Its content, however, is byte-identical to the frozen AUTH1 candidate
  (`changedTreeIdentity=bd289d67…` unchanged; candidate transport moved to
  committed, no content drift). It is local-only, unpushed, and clean.
- Recovery (follow-on card): freeze the authority grants
  (`checkpoint_commit.allowed=true` required — see §3 — plus
  `feature_branch_push`/`draft_pr`), then REBUILD the authorized final local
  commit (reset --soft to preserve the exact tree, then re-run
  `gov-commit-checkpoint.mjs --apply` so the commit is created through the gate
  with the proper footer), then run the terminal review generation against that
  final HEAD. Do NOT reuse the stale pre-commit g0001 as terminal acceptance.

## 3. Authority Grants Freeze Order (R-TC1-03)

- Grants MUST be frozen into the authority record BEFORE the terminal review
  generation is created — the reviewed content includes the final promotion
  authorization.
- AUTH1 target = push feature branch + open draft PR:
  - `feature_branch_push.allowed = true`
  - `draft_pr.allowed = true`
  - `checkpoint_commit.allowed = true` (required by §2.2: both commit classes
    need it; the final local commit must be gate-authorized)
- Grant amendments after ACCEPTED are forbidden for this card.

## 4. Successor Generation Contract (R-TC1-02)

Required transition and invariants are defined in the card spec
(`docs/pi-graph-output/autoloop-auth1-tc1/autoloop-auth1-tc1-card-spec.md`
R-TC1-02). Implementation summary:

```text
createSuccessorReviewJob(cardId, candidateIdentity, specId, specDigest, ...)
  1. read current review-job.json (must exist)
  2. legal predecessor check:
       - state == SUPERSEDED && supersededBy == new jobId  → crash-resume path
       - state not in {SUPERSEDED, HOLD}                   → normal path
       - else                                              → fail closed
  3. newGeneration = current.generation + 1 (monotonic, never reused)
  4. new job carries priorJobId / priorFindingsDigest / priorVerdictDigest /
     supersedes (= predecessor jobId)
  5. atomically replace current pointer (CAS on stateVersion) — never
     delete-and-recreate
  6. g0001 findings/verdict artifacts are untouched (immutable)
```

Concurrency: the CAS on the current pointer makes concurrent successor
creation fail closed (only one g0002). A superseded predecessor can never
satisfy live enforcement (`assertReviewArtifactEnforced` reads only the current
pointer; a SUPERSEDED current → HOLD).

## 5. SC / verification commands

See card spec Success Criteria. Adversarial tests live in
`test/governance/test-successor-generation.mjs`.
