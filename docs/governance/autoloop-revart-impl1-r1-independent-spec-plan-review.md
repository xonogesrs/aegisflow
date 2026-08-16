# AUTOLOOP-REVART-IMPL1-R1 — Independent Spec / Plan Review

## Status

`READY_TO_START` → **`SPEC_AND_PLAN_REVIEWED`** (this document)

## Type

Independent Spec/Plan Review (READ-ONLY / ADVERSARIAL) + source reconnaissance

## Subject

`AUTOLOOP-REVART-IMPL1` (`PASS / IMPL1_REVIEW_ARTIFACT_LIFECYCLE_SPEC_COMPLETE`)

## Implementation Authorization

**NO.** This review authorizes nothing by itself. It produces a frozen
implementation authorization package. Source mutation requires a separate
freeze + implementation authorization after this PASS.

---

# 1. Verdict

```
PASS / IMPL1_SPEC_AND_PLAN_READY_FOR_IMPLEMENTATION
```

Bound context: `autoloop.git` @ `/Volumes/NVM2T/Development/autoloop`,
branch `governance/reversible-lifecycle-draft-pr`,
HEAD `56bb281fee0ac3735cdff08949e9d71997e6011c`.
Context gate: **10/10 PASS** (repo, worktree, branch, HEAD, spec digest
`c0dbe7ed…b2341`, AUTH1 13/+133−33, untracked AUTH1 test present, no staged
changes, RC1A digest still `fdf41313…c1c4`).

---

# 2. Primary Question Answer

> Can a competent implementer execute IMPL1 without inventing new authority,
> persistence, artifact, lifecycle, recovery, staging, or legacy-retirement
> policy?

**Yes**, provided the frozen package in §3–§9 is followed. The source
reconnaissance shows every load-bearing semantic is already owned by existing
machinery; IMPL1 adds Flow-2 findings/verdict persistence and reuses that
machinery. No authority policy remains to be invented.

---

# 3. Source Inventory & Classification

| Component | Classification | Basis |
|---|---|---|
| `src/c2d/fs-atomic.mjs` | **REUSE_AS_IS** | `writeExclusiveCreate` (link tmp→final, never overwrite), `writeAtomicReplaceUnderLock` (rename under lock), `writeJson*`, `assertNotSymlink`, `assertInsideRoot`, fsync+dir-fsync, `sha256Hex` |
| `src/evidence/run-evidence-store.mjs` | **REUSE_AS_IS** | `sha256Text` (SHA-256/UTF-8), `canonicalJson` (sorted keys), `scanForSecrets` |
| `src/governance/change-inventory.mjs` | **REUSE_AS_IS** | staging-independent `changedTreeIdentity` + `patchSha256`, covers committed+staged+tracked-dirty+untracked+renames+modes+symlinks+binaries |
| `src/governance/review-context.mjs` | **REUSE_AS_IS** | `computeReviewContext` recomputes all identities, never trust CLI values |
| `src/governance/review-history.mjs` | **EXTEND** | strict lineage schema (`additionalProperties:false`), controller-only writer; add `jobId`/`generation`/`findingsDigest`/`verdictDigest` |
| `src/governance/external-review.mjs` | **EXTEND** | strict `EXTERNAL_REVIEW_RESULT_SCHEMA`, `verifyExternalReviewResult` (self-declare rejection), `isExternalReviewPassed` |
| `src/governance/closeout-state.mjs` | **REUSE_AS_IS** | descriptive/authoritative split, atomic write pattern |
| `src/governance/review-bundle.mjs` | **EXTEND** | `resolveAuthoritativeExternalReviewRecord`, `assertFinalCardCloseout`, `deliverToExternalReviewSurface`, `buildExternalReviewState`, `recordDeliveryAttempt`, `currentReviewDelivery`, `supersedesFromBundleText` |
| `src/governance/integration-commit-gate.mjs` | **REUSE_AS_IS** | recomputes + rejects self-declare + worktree-dirty → HOLD |
| `src/governance/lifecycle-state.mjs` | **REUSE_AS_IS** | card review-unit machine; review-job maps onto it at ACCEPTED |
| `src/governance/lifecycle-authorization.mjs` | **REUSE_AS_IS** | `validateAgainstSchema`, `validateAuthorityRecord`, `authorityDigest`, `defaultDenyAuthority` |
| `scripts/gov-controller-ingest-result.mjs` | **EXTEND (successor)** | controller-only, exclusive-create (`wx`), recompute, reviewer/authorization 2nd-channel |
| `scripts/gov-controller-prepare-round.mjs` | **REUSE_AS_IS** | review-history writer, repair cap from authority |
| `scripts/gov-closeout-bundle.mjs` (25-section) | **EXTEND** | sole AUTHORITATIVE bundle generator; enumerate declared IR artifacts |
| `scripts/gov-review-bundle.mjs` (11-section) | **RETIRED** | RC1A §7.2 |
| `scripts/gov-external-review-surface.mjs` | **REUSE_AS_IS** | fixed delivery surface `Current/delivery.json` (atomic) |
| `src/schema/reviewer-verdict.schema.json` | **INTERNAL_ONLY** | loose (`additionalProperties:true`, no identity bindings) — must NOT be the authoritative verdict schema |

---

# 4. Frozen Implementation Authorization Package

## 4.1 Frozen artifact path/name model (closes §11 / Area B)

```text
docs/pi-graph-output/<card-id>/
  review-findings.gNNNN.json    immutable per generation — exclusive-create
  review-verdict.gNNNN.json     immutable per generation — exclusive-create
  review-job.json               mutable current binding — CAS atomic-replace-under-lock
```

- `NNNN` = zero-padded monotonic generation. Current generation is resolved by
  `review-job.json` (the explicit current pointer), **never** by newest-timestamp
  scan (spec §42 forbids this).
- Findings/verdict are publish-once (exclusive-create); replacement bytes under
  the same name require a new generation (RC1A §15.1).
- `review-job.json` carries `jobId`, `generation`, candidate/spec identity,
  `supersedes`/`supersededBy`, `requiredArtifacts`, digests, `state`, `stateVersion`.

## 4.2 Frozen schemas (closes §12/§13 / Area C)

New strict schema files (default-deny, `additionalProperties:false`), modeled on
`EXTERNAL_REVIEW_RESULT_SCHEMA`:

- `src/schema/review-job.schema.json`
- `src/schema/review-findings.schema.json`
- `src/schema/review-verdict.schema.json`

**Verdict enum frozen to `PASS | REPAIR | HOLD`** (matches
`external-review.mjs` `EXTERNAL_REVIEW_STATUSES` + result verdict enum). The
loose `reviewer-verdict.schema.json` (`PASS|HOLD|NEEDS_SUPPLEMENT|REJECT`,
`additionalProperties:true`) is **INTERNAL_ONLY** and must not be used for the
authoritative independent verdict. RC1A §4 T4's `REPLAN` token is NOT a durable
verdict value; it is a routing label mapped to REPAIR/HOLD at persistence.

Verdict schema must bind `findingsDigest` (verdict detached from findings cannot
advance state). Both schemas must bind `jobId`, `generation`, `candidateIdentity`,
`specIdentity`, `reviewerIdentity`, `createdAt`.

## 4.3 Frozen spec digest contract (closes §9 / Area D)

```text
specDigest = sha256Text(utf8Bytes(specText))
```

where `specText` is the exact review spec content used for execution, with:
UTF-8 encoding; BOM stripped; `\r\n` normalized to `\n`; no path contribution.
Uses the existing `sha256Text` convention (SHA-256 over UTF-8). A changed
specDigest requires a new generation or supersession.

## 4.4 Frozen replay semantics (closes §19 / Area I)

- same jobId + same bytes → `RESUME / IDEMPOTENT_SUCCESS`
- same jobId + different bytes → `REJECT / CONFLICTING_REPLAY`
- older generation write → `REJECT / SUPERSEDED_GENERATION`

Mapped to primitives: findings/verdict use `writeExclusiveCreate` (2nd write →
`EEXIST` → REJECT, re-read same bytes → idempotent); `review-job.json` uses
`writeAtomicReplaceUnderLock` with monotonic `stateVersion`/`generation` CAS.

## 4.5 Frozen review-job representation (closes §7 / Area F)

- Storage owner: `src/governance/review-job.mjs` (new, sole owner).
- Representation: `review-job.json` (current, CAS) + immutable generation files.
- Truth role: **binding identity only** — it stores jobId/generation/candidate
  identity/spec identity/requiredArtifacts/digests/state/supersedes. It does NOT
  store candidate identity bytes (recomputed via `change-inventory`), lineage
  (owned by `review-history`), delivery (owned by `delivery.json`), or acceptance
  (owned by acceptance record). It is not a competing registry.

## 4.6 Frozen state mapping (closes §16/§17 / Area G)

Canonical review-job.state ∈ RC1A §3 eleven-state set:

`REQUIRED | PREPARED | RUNNING | FINDINGS_CAPTURED | VERDICT_PRODUCED |
PERSISTED | STAGED | ACCEPTED | DOWNSTREAM_AUTHORIZED | SUPERSEDED | HOLD`

**Reconciliation (resolves spec §16/§17 naming divergence):** IMPL1 §16/§17
"FINDINGS_PRODUCED" and "VERDICT_PERSISTED" are **descriptive sub-phases, not
durable states**. `FINDINGS_PRODUCED` (content-only, session-local) is
NON-AUTHORITATIVE and has NO durable state (reviewer returns content → job
remains `RUNNING` until the writeback gate persists findings → `FINDINGS_CAPTURED`).
`VERDICT_PERSISTED` maps to RC1A `PERSISTED`. Mapping:

- `REVIEW_CONTEXT_BOUND` → pre-flight gate (RC1B contract), not a review-job state
- `REVIEW_EXECUTED` ≈ `RUNNING`
- `FINDINGS_PERSISTED` ≈ `FINDINGS_CAPTURED`
- `VERDICT_PRODUCED` = `VERDICT_PRODUCED` (JUDGMENT)
- `VERDICT_PERSISTED` ≈ `PERSISTED`
- `ACCEPTED` = `ACCEPTED` (→ closeout `REVIEW_ACCEPTED` via acceptance authority)

`VERDICT_PRODUCED` is the only judgment state; all persistence transitions are
mechanical and owned by the writeback gate (not the reviewer).

---

# 5. Frozen Mutation Set (closes §36 gate 1–2)

```text
MODIFY:
- src/governance/review-history.mjs
  owner: review-history schema
  responsibility: add jobId/generation/findingsDigest/verdictDigest lineage fields
  why: Flow-2 lineage continuity (spec §24)

- src/governance/review-bundle.mjs
  owner: delivery/acceptance surface
  responsibility: enumerate declared IR artifacts in the authoritative bundle;
    bind accepted review-job (jobId/generation/digests) into delivery state
  why: RC1A §7.1 gov-closeout-bundle enumerates declared IR artifacts (spec §26)

- scripts/gov-closeout-bundle.mjs
  owner: sole bundle generator
  responsibility: include review-job + findings/verdict digest binding in the
    25-section bundle
  why: RC1A §7.2 single generator

ADD:
- src/governance/review-job.mjs
  owner: review-job binding identity + state machine
  responsibility: sole owner of review-job record (current + supersedes chain),
    canonical 11-state machine, requiredArtifacts materialization
  why existing machinery cannot own it: no existing module owns Flow-2
    findings/verdict execution state (lifecycle-state.mjs is card-level only)

- src/governance/review-job-writeback.mjs
  owner: writeback gate
  responsibility: capture→validate→persist→digest→bind→state→stage (spec §15/§5 I5)
  why existing machinery cannot own it: no existing module owns the reviewer
    content → durable artifact capture step (gov-controller-ingest is controller-
    side second-channel, not the reviewer-side writeback)

- src/schema/review-job.schema.json
- src/schema/review-findings.schema.json
- src/schema/review-verdict.schema.json
  owner: strict schemas (default-deny)
  responsibility: §4.2 frozen schema contracts

- test/v2/test-review-job-lifecycle.mjs
- test/v2/test-review-job-writeback.mjs
- test/v2/test-review-artifact-optional.mjs
  owner: tests
  responsibility: lifecycle/replay/crash/artifact-optional coverage

RETIRE AUTHORITY:
- scripts/gov-review-bundle.mjs
  current behavior: 11-section review bundle generator (competing generator)
  post-IMPL1 behavior: RETIRED (RC1A §7.2); not consumed for production acceptance

- src/schema/reviewer-verdict.schema.json
  current behavior: loose internal verdict schema (additionalProperties:true)
  post-IMPL1 behavior: INTERNAL_ONLY; never authoritative for independent verdict

NO wildcard authorization. No files outside this set may be mutated without REPLAN.
```

---

# 6. Requirement → Source Mapping (closes §7)

| Requirement | Current owner | Action | File | Transition | Tests |
|---|---|---|---|---|---|
| context binding | RC1B contract (not yet code) | NEW (gate) | review-job.mjs | → `RUNNING` gate | wrong-repo/wrong-HEAD |
| candidate identity | change-inventory.mjs + review-context.mjs | REUSE | (none) | bind at job creation | candidate-drift |
| spec identity | (none) | NEW | review-job.mjs | bind at `PREPARED` | spec-drift |
| findings persistence | (gap) | NEW | review-job-writeback.mjs | `RUNNING`→`FINDINGS_CAPTURED` | session-only/omission |
| verdict persistence | external-review.mjs schema pattern | EXTEND/NEW | review-job-writeback.mjs + review-verdict.schema.json | `FINDINGS_CAPTURED`→`VERDICT_PRODUCED`→`PERSISTED` | verdict-without-findings |
| digest binding | sha256Text + canonicalJson | REUSE | run-evidence-store.mjs | after each persist | digest-mismatch |
| atomic persist | fs-atomic.mjs | REUSE | (none) | each persist | crash/replay |
| staging | (gap) | NEW | review-job-writeback.mjs | `PERSISTED`→`STAGED` | partial-stage |
| acceptance | external-review.mjs + review-bundle.mjs assertFinalCardCloseout | REUSE | (none) | `STAGED`→`ACCEPTED` | self-grant/no-artifact |
| delivery | review-bundle.mjs deliverToExternalReviewSurface | EXTEND | review-bundle.mjs | `ACCEPTED`→delivery | stale-delivery |
| integration admission | integration-commit-gate.mjs | REUSE | (none) | after `ACCEPTED` | legacy-bypass |
| lineage | review-history.mjs | EXTEND | review-history.mjs | round continuity | wrong-round |

---

# 7. Crash / Retry Matrix (closes §21 / Area J)

Primitive: `writeExclusiveCreate` (immutable) + `writeAtomicReplaceUnderLock`
(current CAS). Recovery is always re-derivation from durable facts; session
JSONL is never authoritative.

| # | Crash window | Durable facts after crash | Detected state | Legal recovery | Primitive | Outcome |
|---|---|---|---|---|---|---|
| 1 | reviewer returns, no findings persisted | job `RUNNING` | RUNNING | reviewer re-delivers or HOLD | — | RESUME/HOLD |
| 2 | findings tmp write | tmp file present, canonical absent | RUNNING | ignore tmp, retry | exclusive-create | RESUME |
| 3 | findings canonical publish | findings.gN present | FINDINGS_CAPTURED | re-derive, bind digest | re-read+sha256 | RESUME |
| 4 | findings digest unbound | findings present, job digest empty | FINDINGS_CAPTURED | recompute+persist binding | CAS job | RESUME |
| 5 | findings bound, verdict absent | job FINDINGS_CAPTURED | FINDINGS_CAPTURED | reviewer produces verdict | — | RESUME |
| 6 | verdict tmp write | tmp present, canonical absent | FINDINGS_CAPTURED | ignore tmp | exclusive-create | RESUME |
| 7 | verdict canonical publish | verdict.gN present | VERDICT_PRODUCED | re-derive, bind | re-read+sha256 | RESUME |
| 8 | verdict digest unbound | verdict present, job digest empty | VERDICT_PRODUCED | recompute+persist | CAS job | RESUME |
| 9 | verdict persisted, state not advanced | verdict+digest present | PERSISTED | re-derive PERSISTED | re-read | RESUME |
| 10 | pre-ACCEPTED | PERSISTED/STAGED | PERSISTED/STAGED | acceptance entrypoint re-runs | — | RESUME |
| 11 | post-ACCEPTED pre-stage | ACCEPTED | ACCEPTED | stage idempotently | git add exact | RESUME |
| 12 | partial stage | some paths staged | STAGED(partial) | re-stage exact set, verify identity | git diff --cached | RESUME/HOLD |
| 13 | pre-delivery | ACCEPTED/STAGED | ACCEPTED | delivery publish idempotent | atomic replace | RESUME |
| 14 | post-delivery pre-integration | delivery published | DOWNSTREAM_AUTHORIZED | integration gate re-verifies | recompute | RESUME |

---

# 8. Legacy Retirement Table (closes §26 / Area O)

| Path | Current | Post-IMPL1 | Enforcement |
|---|---|---|---|
| `scripts/gov-review-bundle.mjs` (11-section) | competing generator | **RETIRED** | not consumed for production acceptance |
| `external-review-result.json` | controller-ingested result | **SUPERSEDED** (absorbed by acceptance record + review-job verdict) | read → HOLD |
| `src/schema/reviewer-verdict.schema.json` | loose internal verdict | **INTERNAL_ONLY** | never authoritative for independent verdict |
| per-card `*-independent-review.mjs` / `*-self-closeout.mjs` | card-specific scripts | **HISTORICAL** | fixtures only |
| `Current/delivery.json` | canonical surface | **AUTHORITATIVE** (unchanged) | sole downstream publication |
| `gov-closeout-bundle.mjs` (25-section) | authoritative generator | **AUTHORITATIVE** (extended) | sole bundle generator |

---

# 9. Test Matrix (closes §28)

| Requirement | Test |
|---|---|
| session-only PASS → NOT ACCEPTED | test-review-artifact-optional.mjs (T-A1) |
| session-only findings → NON_AUTHORITATIVE | T-A2 |
| reviewer omits file → lifecycle persists or incomplete | T-A3 |
| reviewer arbitrary path → ignored | T-A4 |
| crash after output → resume from durable only | T-A5 |
| missing artifact → no ACCEPTED | AC10 test |
| self-grant flags rejected | §30 negatives |
| duplicate same-bytes → idempotent | replay test |
| conflicting bytes → REJECT | replay test |
| stale generation → REJECT | supersession test |
| candidate/spec drift → HOLD/SUPERSEDE | drift test |
| partial staging → recover/HOLD | crash test |
| stale delivery → rejected | delivery test |
| legacy bypass → rejected | legacy test |
| wrong context → HOLD | context test |

---

# 10. Findings (resolved in package, non-blocking)

- **F-1 (spec §16/§17 vs RC1A §3 state names)**: resolved — RC1A canonical
  11-state set is authoritative; IMPL1 finer names are descriptive sub-phases
  (§4.6). No durable "FINDINGS_PRODUCED" state (content-only is non-authoritative).
- **F-2 (verdict vocabulary)**: resolved — authoritative enum frozen to
  `PASS|REPAIR|HOLD`; `REPLAN`/`NEEDS_SUPPLEMENT` are non-durable routing labels (§4.2).
- **F-3 (loose reviewer-verdict.schema.json)**: resolved — INTERNAL_ONLY, never
  authoritative (§4.2).
- **F-4 (artifact naming "implementation may choose")**: resolved — frozen stable
  + generation-immutable model (§4.1).
- **F-5 (spec digest encoding)**: resolved — `sha256Text`/UTF-8/BOM-strip/LF (§4.3).

No authority, persistence, lifecycle, recovery, staging, or legacy-retirement
policy remains for the implementer to invent.

---

# 11. Implementation Readiness Gate (12/12)

1. every mutation file identified — §5
2. every new file has clear owner — §5
3. existing machinery reused — §3, §6
4. no competing truth introduced — review-job = binding identity only (§4.5)
5. exact schemas frozen — §4.2
6. exact artifact paths/names frozen — §4.1
7. spec digest semantics frozen — §4.3
8. duplicate replay semantics frozen — §4.4
9. context contract consumed — §6 (context binding → gate)
10. artifact-optional tests explicit — §9 (T-A1…T-A5)
11. crash recovery plan explicit — §7
12. legacy production bypass closure explicit — §8

All 12 closed.

---

# 12. Final Verdict

```
PASS / IMPL1_SPEC_AND_PLAN_READY_FOR_IMPLEMENTATION
```

The frozen implementation authorization package (§4–§9) is the ONLY authority
for implementation. No broad "implement IMPL1 as specified" permission exists.

## Self-application note

This review verdict is currently session-only. Per the architecture's own
invariant, it is NON-AUTHORITATIVE until persisted and bound by the lifecycle
that IMPL1 itself will build. The next step (implementation freeze + mutation)
must treat this package as the frozen input, but the durable persistence of the
package into `docs/governance/` is the first concrete demonstration that the
artifact it authorizes will follow the same rule.
