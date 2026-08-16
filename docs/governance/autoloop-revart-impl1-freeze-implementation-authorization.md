# AUTOLOOP-REVART-IMPL1-FREEZE — Implementation Authorization Gate

## Status

`READY_TO_START` → **`FROZEN_AND_AUTHORIZED`** (this document)

## Type

Freeze / Implementation Authorization Gate (verification only — no design, no
architecture work)

## Parent

`AUTOLOOP-REVART-IMPL1-R1A`

## Prerequisite Verdict

`PASS / IMPL1_R1_FROZEN_PACKAGE_CONSISTENT_AND_READY_TO_FREEZE`

---

# 1. Verdict

```
PASS / IMPL1_IMPLEMENTATION_PACKAGE_FROZEN_AND_AUTHORIZED
```

This is the final pre-implementation gate. Source mutation of the frozen
mutation set is now explicitly authorized. No additional architecture review
is required unless the frozen contract is invalidated during execution.

---

# 2. Freeze Gate Results (F1–F10) — ALL PASS

| Gate | Expected | Observed | Result |
|---|---|---|---|
| F1 repo | `autoloop.git` | `git@github.com:xonogesrs/autoloop.git` | **PASS** |
| F2 worktree | `/Volumes/NVM2T/Development/autoloop` | same | **PASS** |
| F3 branch | `governance/reversible-lifecycle-draft-pr` | same | **PASS** |
| F4 HEAD | `56bb281fee0ac3735cdff08949e9d71997e6011c` | same | **PASS** |
| F5 candidate | 13 tracked / +133 −33 / 1 untracked test | 13 dirty, +133 −33, test present | **PASS** |
| F6 staging | none | 0 staged | **PASS** |
| F7 IMPL1 spec | `c0dbe7ed…b2341` | `c0dbe7ed8449b050fff6e445f3781140ce0cf5221e1dd50b4718361e283b2341` | **PASS** |
| F8 RC1A | `fdf41313…c1c4` | `fdf41313c3d2f1e1fb1cdf8d7ba8480a9e3ff746a111344d411c7c028237c1c4` | **PASS** |
| F9 R1 package | exists | present | **PASS** |
| F10 R1A | contains PASS verdict | present (2×) | **PASS** |

---

# 3. Frozen Candidate Identity (recomputed via repo's own change-inventory.mjs)

```text
head:                56bb281fee0ac3735cdff08949e9d71997e6011c
branch:              governance/reversible-lifecycle-draft-pr
dirtyCount:          13
stagedCount:         0
changedTreeIdentity: 3b31f6abb721584a698ded295aad4577327fed28dc621a03e09588242752df29
patchSha256:         e7f1df9d522ef99e873afa5233531beafb163d3bf991bec9cb251c2c1b06a73b
untracked AUTH1 test: test/admission/test-retrieval-authority.mjs (present)
```

The 13 dirty paths match the frozen AUTH1 candidate exactly (policy-projection,
autoloop, colima-graph-runner, durable-execution, + 9 test files). This is the
identity the implementation must preserve; any drift invalidates the freeze.

---

# 4. Authoritative Lifecycle Ordering (frozen)

```text
PERSISTED → STAGED → ACCEPTED → DOWNSTREAM_AUTHORIZED
```

`STAGED` is a prerequisite to `ACCEPTED`. No `post-ACCEPTED pre-stage` state.

---

# 5. Frozen Artifact Model

```text
docs/pi-graph-output/<card-id>/
  review-findings.gNNNN.json   immutable per generation — exclusive-create
  review-verdict.gNNNN.json    immutable per generation — exclusive-create
  review-job.json              current binding — CAS/atomic-replace-under-lock
```

No overwrite of generation artifacts; current generation never inferred from
timestamps.

---

# 6. Frozen Schema Set (NEW)

```text
src/schema/review-job.schema.json
src/schema/review-findings.schema.json
src/schema/review-verdict.schema.json
```

Strict/default-deny. Authoritative verdict enum: `PASS | REPAIR | HOLD`.
`src/schema/reviewer-verdict.schema.json` remains INTERNAL_ONLY.

---

# 7. Frozen Spec Identity

```text
specDigest = SHA-256(UTF-8 exact spec content after BOM removal + CRLF→LF)
```

Path does not contribute.

---

# 8. Frozen Replay Rules

```text
same identity + same bytes     → RESUME / IDEMPOTENT_SUCCESS
same identity + different bytes → REJECT / CONFLICTING_REPLAY
older generation               → REJECT / SUPERSEDED_GENERATION
```

No last-writer-wins.

---

# 9. Frozen Mutation Authorization (exact, no wildcards)

## MODIFY

```text
src/governance/review-history.mjs         — add jobId/generation/findingsDigest/verdictDigest
src/governance/review-bundle.mjs          — bind accepted review-job, enumerate IR artifacts
src/governance/external-review.mjs        — recompute findings digest + job/generation/spec
scripts/gov-closeout-bundle.mjs           — include review-job + digest bindings
scripts/gov-controller-ingest-result.mjs  — acceptance entrypoint; exclusive-create acceptance record
```

## ADD (production)

```text
src/governance/review-job.mjs
src/governance/review-job-writeback.mjs
src/schema/review-job.schema.json
src/schema/review-findings.schema.json
src/schema/review-verdict.schema.json
```

## ADD (tests)

```text
test/v2/test-review-job-lifecycle.mjs
test/v2/test-review-job-writeback.mjs
test/v2/test-review-artifact-optional.mjs
```

## REUSE_AS_IS (do not modify — REPLAN if a change is discovered)

```text
src/c2d/fs-atomic.mjs
src/evidence/run-evidence-store.mjs
src/governance/change-inventory.mjs
src/governance/review-context.mjs
src/governance/closeout-state.mjs
src/governance/integration-commit-gate.mjs
src/governance/lifecycle-state.mjs
src/governance/lifecycle-authorization.mjs
scripts/gov-controller-prepare-round.mjs
scripts/gov-external-review-surface.mjs
```

---

# 10. Legacy Authority Disposition

```text
scripts/gov-review-bundle.mjs              → RETIRED (not consumed for acceptance)
external-review-result.json                → SUPERSEDED (acceptance record replaces it)
src/schema/reviewer-verdict.schema.json    → INTERNAL_ONLY
per-card independent-review/self-closeout  → HISTORICAL
Current/delivery.json                      → AUTHORITATIVE (downstream surface)
scripts/gov-closeout-bundle.mjs            → AUTHORITATIVE (sole bundle generator)
```

---

# 11. Implementation Invariant

> **Required review artifacts are lifecycle-mandated outputs, not optional
> agent behavior. No artifact, no state advancement.**

```text
reviewer produces content ≠ artifact persisted ≠ review accepted
```

Mandatory chain: bound context → judgment/content → lifecycle writeback →
findings persisted → verdict persisted → digest/binding verified → STAGED →
acceptance recomputes → ACCEPTED → delivery → downstream authorization.

---

# 12. Mandatory First Implementation Step

Before any source mutation, capture a pre-mutation evidence record (§3 identity
above) and verify `observed state == frozen state`. Only then begin mutation.

---

# 13. Authorization

After this `PASS / IMPL1_IMPLEMENTATION_PACKAGE_FROZEN_AND_AUTHORIZED`, the
implementation Agent is authorized to mutate **only** the files in §9, using
**only** the frozen semantics in §4–§8, §10–§11.

Any discovery of a new production file requirement, a REUSE_AS_IS file needing
change, a state-ordering change, an acceptance-owner change, a new authoritative
store, an insufficient candidate-identity owner, or a legacy path that cannot be
retired under frozen semantics → **STOP** and return
`REPLAN_REQUIRED / IMPL1_FROZEN_IMPLEMENTATION_CONTRACT_INVALIDATED`.

---

# 14. Next Step

```text
IMPL1 IMPLEMENTATION (frozen mutation set only)
→ targeted + adversarial verification (T-A1…T-A5, §20/§21 negatives + crash)
→ local implementation closeout
→ fresh independent implementation review
```
