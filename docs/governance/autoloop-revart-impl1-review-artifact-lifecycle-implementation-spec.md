# AUTOLOOP-REVART-IMPL1 — Review Artifact Lifecycle Implementation Spec

## Status

`READY_TO_START` → **`SPEC_COMPLETE`** (this document)

## Type

Implementation Specification (SPEC ONLY — no source mutation authorized)

## Parent Architecture

`AUTOLOOP-REVART-RC1A` (`PASS / RC1A_ARCHITECTURE_READY_FOR_IMPL1_SPEC`)

## Context Prerequisite

`PASS / RC1B_REVIEW_EXECUTION_CONTEXT_AND_ARTIFACT_PROVENANCE_RECONCILED`

## Implementation Authorization

**NO.** This card defines the implementation contract. It does not authorize
source mutation until this spec itself passes independent Spec/Plan Review and
is frozen.

## Bound Context (frozen by RC1B)

```text
repo identity:  autoloop.git
worktree:       /Volumes/NVM2T/Development/autoloop
branch:         governance/reversible-lifecycle-draft-pr
expected HEAD:  56bb281fee0ac3735cdff08949e9d71997e6011c
AUTH1 candidate: 13 tracked modified files / +133 −33 / 1 untracked test
```

---

# 1. Core Objective

Implement the missing lifecycle that converts independent-review output from
session-local content into durable, provenance-bound, mechanically governed
review artifacts.

The implementation must make the following invariant unavoidable:

> **Required review artifacts are lifecycle-mandated outputs, not optional
> agent behavior. No artifact, no state advancement.**

The independent RC1A review confirmed that existing AutoLoop authority machinery
already treats reviewer session output as non-authoritative and requires
controller-side recomputation/binding before acceptance. IMPL1 extends that
enforcement to Flow 2 findings/verdict persistence itself.

---

# 2. Problem Being Implemented

Today the architecture already contains substantial Flow 1 authority machinery:

* candidate identity recomputation
* independent reviewer/self-review rejection
* controller-owned ingest
* review history ownership
* canonical delivery
* closeout downward reconciliation
* integration attestation

But Flow 2 still lacks a generic durable lifecycle for:

* review findings
* review verdict
* review attempt identity
* persistence
* digest binding
* retry/resume
* supersession
* staging

Historically this causes reviewer output to fall into one of two states:

```text
reviewer chooses to create artifact
→ artifact happens to exist
```

or:

```text
reviewer returns result in session
→ no durable artifact exists
```

IMPL1 must remove this choice from the reviewer.

---

# 3. Frozen Architecture Inputs

IMPL1 MUST conform to RC1A and RC1B. Implementation must not revisit or
redesign the following authority decisions:

1. first-party assertion and independent attestation are separate authorities
2. reviewer judgment is not acceptance authority
3. `ACCEPTED` is non-self-grantable
4. authority is derived/recomputed, not caller-declared
5. review-job is a binding identity, not a competing registry
6. candidate identity uses recomputed working-tree identity
7. repair/review lineage is durable
8. lifecycle persistence is generic/shared
9. per-card customization is content only
10. delivery remains the downstream canonical publication surface
11. integration admission consumes validated acceptance
12. context must be bound before review begins

The independent architecture review found all of these closed and judged that
IMPL1 does not need to invent new authority policy.

---

# 4. Scope

## 4.1 In scope

* review-job binding identity
* required artifact contract
* findings persistence
* verdict persistence
* artifact schema
* artifact digest binding
* generic canonical paths
* state transitions required for persistence
* replay/idempotency
* partial-write recovery
* generation/supersession enforcement
* context binding consumption
* review-history integration
* delivery binding integration
* staging ownership
* legacy production-path rejection where required by RC1A
* tests proving lifecycle enforcement

## 4.2 Out of scope

* redesign of review judgment semantics
* changing PASS/REPAIR/REPLAN/HOLD policy
* autonomous reviewer selection
* new product/business policy
* AUTH1 F1/F2/F3 implementation repair
* Phase D/E
* unrelated bundle refactor
* unrelated governance cleanup
* broad repository convergence
* final integration commit
* permanent removal of historical artifacts unless required to disable authority

---

# 5. First-Level Invariants (mandatory)

### I1 — No artifact, no advancement
A review cannot advance beyond the corresponding persistence boundary unless
its required artifact exists at the canonical lifecycle-owned location and
passes validation.

### I2 — Session output is content only
Terminal output, model response, JSONL, stdout, chat transcript, memory, or
session state are never authoritative review artifacts.

### I3 — Reviewer does not own persistence policy
Reviewer supplies semantic findings/verdict content. Reviewer does not decide:
whether persistence occurs; artifact path; artifact filename; schema; lifecycle
state; digest; acceptance; staging; downstream admission.

### I4 — Required artifacts are declared before execution
The lifecycle knows what findings/verdict artifacts must exist before reviewer
execution starts.

### I5 — Persistence is lifecycle-owned
The shared lifecycle owns: capture → validate → persist → digest → bind →
state transition → stage.

### I6 — Acceptance remains separate
Persistence does not equal `ACCEPTED`. A valid persisted PASS verdict remains
insufficient until the existing acceptance authority validates the complete
bound chain.

### I7 — No caller authority
No caller-supplied field may grant review authority.

### I8 — Exact candidate binding
Review artifacts must bind to the exact reviewed candidate/context.

### I9 — Exact spec binding
Review artifacts must bind to the exact review specification.

### I10 — Generation monotonicity
Superseded generations cannot return to current.

### I11 — Crash recoverability
Any interrupted mechanical step must resume or reject deterministically from
durable facts alone.

### I12 — Legacy paths cannot bypass lifecycle
Historical/custom paths may remain readable where necessary, but cannot
independently create production acceptance.

---

# 6. Review Execution Context Input

IMPL1 must consume the context contract frozen by RC1B.

Minimum review context:

```text
repoIdentity
repoAbsolutePath
worktreeAbsolutePath
expectedHead
candidateIdentity
targetArtifacts[]
specIdentity
reviewLineageIdentity
```

Candidate identity must include, as applicable:

```text
baseHead
currentHead
patchSha256
changedTreeIdentity
untrackedIdentity
```

Substantive review lifecycle may not start until the context gate has passed.
Required state: `REVIEW_CONTEXT_BOUND`. Wrong repo/worktree/HEAD/candidate must
HOLD before review execution.

---

# 7. Review Job Model

`review-job` is not a new general database. It is a durable binding object
connecting: review lineage; exact attempt/generation; candidate identity; spec
identity; required artifact contract; reviewer result identity; persistence
state; supersession.

Minimum conceptual structure:

```text
reviewJob:
  schemaVersion
  lineageId
  jobId
  generation
  repoIdentity
  worktreeIdentity
  candidateIdentity
  specId
  specDigest
  reviewRound
  repairRound
  priorJobId
  priorFindingsDigest
  priorVerdictDigest
  supersedes
  supersededBy
  requiredArtifacts
  state
  stateVersion
```

Exact serialization may be adjusted during implementation only if semantics
remain identical.

---

# 8. Stable Lineage vs Job Identity

Two levels of identity must be preserved.

### 8.1 Stable lineage
Persists across repair rounds, reviewer retries where policy retains lineage,
candidate revisions, review rounds.

### 8.2 Exact job/generation
Represents exactly: one candidate, one spec, one context, one generation, one
review execution attempt. A previous job must not be reused after
candidate/spec identity changes.

---

# 9. Spec Identity Contract

One RC1A residual item was that `specId + specDigest` existed architecturally
but exact digest semantics were not frozen. IMPL1 SHALL close this
implementation detail.

Minimum rule:

```text
specDigest = SHA-256(canonical bytes of the exact review spec used for execution)
```

The implementation must define: canonical byte representation; line-ending
behavior; encoding; path independence; schema/version contribution if
applicable. A changed spec digest requires a new job generation or supersession
according to lifecycle rules.

---

# 10. Required Artifact Contract

Before review execution, `requiredArtifacts` must be created mechanically.
Minimum artifacts: `findings`, `verdict`.

Each artifact contract must include:

```text
role
schemaVersion
canonicalPath
required
candidateIdentity
specIdentity
generation
writeMode
```

Recommended canonical directory: `docs/pi-graph-output/<card-id>/`
(accepted by the independent RC1A review).

---

# 11. Canonical File Names

IMPL1 must close the residual filename ambiguity. Use deterministic generic
names. Recommended:

```text
review-findings.json
review-verdict.json
review-job.json
```

If round/generation-specific immutable files are required, use mechanically
derived names, e.g. `review-findings.g0003.json`. The implementation must
choose one model and test it. Reviewer must never select the filename.

---

# 12. Findings Schema

Create a strict schema. Minimum required semantic fields:

```text
schemaVersion
jobId
lineageId
generation
candidateIdentity
specIdentity
reviewerIdentity
findings[]
summary
createdAt
```

Each finding should support:

```text
findingId
severity/classification
subject
description
violatedInvariant
evidenceRefs
recommendedDisposition
```

Schema SHOULD default deny unknown authority-bearing fields. Avoid loose
`additionalProperties: true` for authority-critical structures.

---

# 13. Verdict Schema

Create a strict verdict schema. Minimum fields:

```text
schemaVersion
jobId
lineageId
generation
candidateIdentity
specIdentity
findingsDigest
reviewerIdentity
verdict
summary
recommendedNextAction
createdAt
```

Allowed verdict values must reuse existing governance semantics where available.
The verdict must bind the exact findings artifact through `findingsDigest`. A
verdict detached from findings cannot advance state.

---

# 14. Digest Rules

Every authoritative artifact must receive SHA-256 over canonical persisted
bytes. Required digests: `findingsDigest`, `verdictDigest`, `specDigest`,
candidate identity digests. Digest validation must recompute from bytes. Never
trust digest values supplied inside reviewer content without recomputation.

---

# 15. Artifact Persistence Pipeline

Required generic sequence:

```text
1. verify current review job
2. verify context still matches
3. capture reviewer semantic output
4. normalize into target schema
5. validate schema
6. write to temporary/exclusive location
7. fsync/durable-write as supported
8. compute digest from persisted bytes
9. atomically publish canonical artifact
10. re-read/revalidate if required
11. bind digest to review job
12. advance lifecycle state
13. stage only authorized lifecycle artifacts
14. verify staged identity
```

The implementation must use existing atomic/CAS primitives where possible
rather than introducing another persistence framework.

---

# 16. Findings State Transition

```text
REVIEW_EXECUTED → FINDINGS_PRODUCED → FINDINGS_PERSISTED
```

`FINDINGS_PRODUCED` may represent semantic content returned from reviewer
execution. `FINDINGS_PERSISTED` requires: canonical artifact exists; correct
schema; correct candidate/spec/job/generation binding; digest recomputed;
digest bound durably. Session-only findings cannot satisfy `FINDINGS_PERSISTED`.

---

# 17. Verdict State Transition

```text
FINDINGS_PERSISTED → VERDICT_PRODUCED → VERDICT_PERSISTED
```

`VERDICT_PRODUCED` remains a judgment boundary. `VERDICT_PERSISTED` is
mechanical. It requires: findings already persisted; verdict schema valid;
findings digest matches; candidate/spec/job/generation matches; persisted
verdict digest recomputed and bound.

---

# 18. ACCEPTED Boundary

IMPL1 MUST NOT allow the writeback machinery itself to self-mint acceptance.

```text
VERDICT_PERSISTED → acceptance authority verification → ACCEPTED
```

The existing acceptance authority must recompute and verify the full chain: at
minimum reviewer independence, review context, candidate identity, spec
identity, findings digest, verdict digest, generation/currentness, supersession
status, delivery binding requirements. Persisted PASS is descriptive until this
gate succeeds.

---

# 19. Same-Bytes Replay vs Conflicting Replay

RC1A review identified a wording ambiguity around duplicate writeback. IMPL1
SHALL define:

* Same identity + same bytes → `RESUME / IDEMPOTENT_SUCCESS` (no duplicate logical artifact)
* Same identity + different bytes → `REJECT / CONFLICTING_REPLAY` (never last-writer-wins)
* Older generation write → `REJECT / SUPERSEDED_GENERATION`

---

# 20. Exclusive Create / CAS

Authority-sensitive persistence must use one or more of: exclusive-create;
compare-and-swap; immutable generation files; atomic rename; monotonic version
check. Implementation must not rely on ordinary overwrite behavior.

---

# 21. Crash Recovery

IMPL1 must explicitly implement and test recovery at these boundaries:

1. reviewer returns before findings persistence
2. findings temp file created
3. findings canonical publish complete
4. findings digest not yet bound
5. findings state bound, verdict absent
6. verdict temp file created
7. verdict canonical publish complete
8. verdict digest not yet bound
9. verdict persisted, state not advanced
10. pre-ACCEPTED crash
11. post-ACCEPTED/pre-stage crash
12. partial stage
13. post-stage/pre-delivery crash
14. post-delivery/pre-integration-gate crash

Recovery may never require session JSONL to determine authoritative state.

---

# 22. Staging Ownership

The review lifecycle owns staging of the exact lifecycle artifacts it created
(review-job binding artifact if filesystem-backed; findings artifact; verdict
artifact; required delivery projection if part of this scope). It must not
stage unrelated candidate changes. Staged set must be verified against
authorized set before completion.

---

# 23. Commit Ownership

IMPL1 must not make the writeback gate into an integration commit authority.
The independent review confirmed existing integration machinery is
attestation-only and does not itself create new commits. Preserve the existing
ownership boundaries. If a later card governs final commit creation/promotion,
that remains separate.

---

# 24. review-history Integration

Reuse existing controller-owned review-history semantics. IMPL1 must add Flow 2
lineage references without turning review-history into a second acceptance
surface. Where appropriate record: reviewRound, repairRound, jobId, generation,
findingsDigest, verdictDigest, priorFindingsDigest, priorVerdictDigest,
supersedes. Current acceptance remains determined by the canonical acceptance
chain, not history alone.

---

# 25. delivery.json Integration

The lifecycle must bind the accepted review record into the canonical delivery
surface. Delivery must reference exact: job ID, generation, candidate identity,
spec identity, findings digest, verdict digest, supersession/currentness. Stale
delivery cannot be consumed. Caller-supplied delivery authority remains
prohibited.

---

# 26. Legacy Path Treatment

RC1A classifies legacy competing surfaces for retirement/historical use. IMPL1
must enforce the production boundary. Search and classify existing paths such
as: old review bundle generators; card-specific independent-review scripts;
direct external-review result paths; legacy result-artifact PASS paths.

For each: `HISTORICAL` / `DERIVED_VIEW` / `RETIRED` / `SUPERSEDED`. A RETIRED
path must not advance current production lifecycle. Do not delete historical
evidence merely to achieve retirement.

---

# 27. Generic vs Per-Card Boundary

No card-specific lifecycle implementation. Per-card review files may provide
questions, objectives, expected invariants, domain-specific adversarial checks.
Shared machinery must own: review execution binding, result normalization,
persistence, schema, digest, state, staging, retry, supersession, delivery,
acceptance interaction. Adding a new review card must not require creating
another special `*-independent-review.mjs` writeback path.

---

# 28. Reviewer Replacement

Minimum semantics:

* Before any authoritative artifact persisted → retry/resume may be allowed
  under same job if architecture permits and reviewer identity is rebound by
  the authorized lifecycle.
* After findings persisted → a replacement reviewer must not silently overwrite
  reviewer A's findings; either create a new generation or explicitly supersede
  previous generation.
* After verdict persisted → new review judgment requires a new generation.

---

# 29. Context Drift

Before every authoritative writeback transition, revalidate the bound context.
If any of HEAD, patch, changed tree, relevant untracked bytes, spec bytes, or
generation/currentness changes, the current review cannot continue as if
unchanged. Required result: `HOLD` or `SUPERSEDE` according to frozen lifecycle
rules.

---

# 30. Security / Authority Negative Tests

Mandatory tests must prove the system rejects:

* reviewer claims `internal:true`
* reviewer claims `trusted:true`
* reviewer claims `accepted:true`
* reviewer identity equals implementing agent identity
* caller supplies fake candidate digest
* caller supplies fake spec digest
* reviewer writes direct canonical PASS file
* old PASS copied into current path
* stale generation attempts writeback
* conflicting duplicate writeback
* missing findings with verdict present
* findings digest mismatch
* verdict candidate mismatch
* delivery generation mismatch

---

# 31. Artifact-Optional Regression Tests

First-class acceptance tests.

* **T-A1 Session-only PASS** — reviewer output contains complete PASS verdict;
  no canonical artifact created → `NOT ACCEPTED`.
* **T-A2 Session-only findings** — full findings exist in captured model/session
  output → `NON_AUTHORITATIVE`.
* **T-A3 Reviewer omits file output intentionally** — lifecycle persists
  normalized required artifact itself or remains incomplete; omission must not
  alter contract.
* **T-A4 Reviewer invents path** — invented artifact is ignored for authority.
* **T-A5 Reviewer crashes after output** — resume from lifecycle-owned durable
  state; do not parse prior session transcript as authority.

---

# 32. Adversarial Acceptance Tests

At minimum:

1. correct happy path
2. findings only
3. verdict only
4. wrong findings digest
5. wrong candidate
6. wrong spec
7. context drift
8. same-byte replay
9. conflicting replay
10. stale generation
11. duplicate reviewer
12. crash before findings write
13. crash after findings canonical publish
14. crash before verdict write
15. crash after verdict canonical publish
16. partial staging
17. stale delivery
18. legacy bypass
19. direct PASS injection
20. missing canonical artifact after ACCEPTED attempt
21. mutation of artifact after digest
22. superseded generation promotion attempt

---

# 33. Required Source Reconnaissance Before Mutation

Before implementation begins, the implementer must perform bounded inspection of
the actual reusable machinery confirmed by RC1A-R2, including as applicable:

```text
src/governance/closeout-state.mjs
src/governance/review-context.mjs
src/governance/review-history.mjs
src/governance/external-review.mjs
src/governance/review-bundle.mjs
scripts/gov-controller-ingest-result.mjs
scripts/gov-controller-prepare-round.mjs
scripts/gov-closeout-bundle.mjs
scripts/gov-review-bundle.mjs
integration/commit gate machinery
delivery publication machinery
```

The purpose is to reuse existing authority primitives rather than create
competing machinery.

---

# 34. Implementation Planning Requirement

Before source mutation, produce an implementation plan that maps:

```text
requirement → existing owner → reuse/extend/new → exact file(s)
→ state transition affected → tests
```

The plan must explicitly identify any proposed new file. No new lifecycle
registry may be added without proving why existing machinery cannot own the
responsibility.

---

# 35. Scope Control

Implementation grouped around a small number of shared seams:

* **Group A — schemas / durable identity**: review-job binding; findings/verdict
  schema; spec identity.
* **Group B — writeback lifecycle**: capture; persistence; digest; state
  transition; replay/recovery.
* **Group C — authority integration**: review-history; acceptance verification;
  delivery binding; legacy-path rejection.
* **Group D — tests**: lifecycle; adversarial; artifact-optional; crash/replay.

Do not scatter lifecycle policy across unrelated scripts.

---

# 36. Implementation Readiness Gate

Implementation may start only after the independent Spec/Plan Review confirms:

1. every mutation file is identified
2. every new file has a clear owner
3. existing machinery is reused where appropriate
4. no competing source of truth is introduced
5. exact schemas are frozen
6. exact artifact paths/names are frozen
7. spec digest semantics are frozen
8. duplicate replay semantics are frozen
9. context contract is consumed
10. artifact-optional tests are explicit
11. crash recovery plan is explicit
12. legacy production bypass closure is explicit

---

# 37. Implementation Acceptance Criteria

Implementation cannot PASS unless:

* AC1 — review context is bound before execution
* AC2 — required artifacts are predeclared
* AC3 — reviewer output alone cannot advance lifecycle
* AC4 — findings are lifecycle-persisted
* AC5 — verdict is lifecycle-persisted
* AC6 — both artifacts are strict-schema validated
* AC7 — both artifacts bind exact job/candidate/spec/generation
* AC8 — digests are recomputed from persisted bytes
* AC9 — verdict binds findings digest
* AC10 — missing artifact prevents ACCEPTED
* AC11 — ACCEPTED cannot be self-granted
* AC12 — duplicate same-byte replay is idempotent/resumable
* AC13 — conflicting replay is rejected
* AC14 — stale generation is rejected
* AC15 — context drift prevents continued acceptance
* AC16 — partial/crashed writeback is recoverable
* AC17 — session JSONL is never needed as authoritative recovery state
* AC18 — legacy direct PASS paths cannot bypass lifecycle
* AC19 — writeback stages only authorized lifecycle artifacts
* AC20 — no competing review truth store is introduced
* AC21 — generic machinery serves multiple cards without bespoke persistence scripts
* AC22 — all required adversarial tests pass

---

# 38. Verification Requirements

At minimum run: targeted schema tests; review-context identity tests;
external-review authority tests; review-history tests; writeback lifecycle
tests; replay/idempotency tests; crash recovery tests; delivery binding tests;
integration admission tests; artifact-optional regression tests; relevant
existing governance suite; `git diff --check`. Existing tests must remain green
unless an intentionally retired legacy behavior has an explicitly updated
expectation.

---

# 39. Required Evidence

Implementation closeout evidence must contain: bound repo/worktree/HEAD;
pre-implementation candidate identity; authorized mutation set; actual mutation
set; new/changed schemas; lifecycle transition implementation mapping; exact
artifact paths; test commands/results; adversarial result matrix; legacy-path
disposition; final git diff summary; proof AUTH1 frozen candidate boundaries
were respected unless separately authorized.

---

# 40. Independent Implementation Review

After implementation local PASS, a fresh independent reviewer must actively
attempt: session-only PASS; no-artifact completion; direct verdict injection;
reviewer self-grant; candidate drift; spec drift; replay; duplicate writeback;
ABA; superseded promotion; partial artifact write; partial staging; stale
delivery; legacy bypass; wrong-context review. The reviewer must verify actual
source behavior, not only tests.

---

# 41. Current Residual Risks Carried Forward

The RC1A independent review identified five non-blocking details to close in
IMPL1:

1. exact findings/verdict filenames and schemas
2. exact spec identity hashing contract
3. same-byte duplicate writeback = RESUME vs conflicting bytes = REJECT
4. explicit worktree binding from RC1B
5. human-in-the-loop trust boundary remains an honest external trust limitation
   rather than pretending same-account compromise can be mechanically solved

IMPL1 addresses items 1–4 directly. Item 5 must remain explicit and must not be
disguised as a solved cryptographic/software identity guarantee.

---

# 42. Forbidden Implementation Shortcuts

Do not:

* add another per-card writeback script
* parse old session JSONL as canonical review evidence
* treat reviewer-created arbitrary files as authoritative
* let reviewer set lifecycle state
* let caller pass authority flags
* overwrite existing canonical artifacts silently
* infer current generation from newest timestamp
* use branch name alone as candidate identity
* use HEAD alone for dirty candidate
* allow PASS without findings digest
* allow ACCEPTED without canonical findings/verdict
* make delivery.json an independent authority
* create another review-history/current-state registry
* defer crash semantics to operational convention

---

# 43. Local Spec Verdict

`PASS / IMPL1_REVIEW_ARTIFACT_LIFECYCLE_SPEC_COMPLETE`

Local PASS does **not** authorize implementation.

---

# 44. Mandatory Next Step

```text
AUTOLOOP-REVART-IMPL1
↓
Independent Spec/Plan Review (+ actual source reconnaissance)
↓
PASS / IMPL1_SPEC_AND_PLAN_READY_FOR_IMPLEMENTATION
↓
Freeze
↓
Implementation authorization
```

Only the independent Spec/Plan PASS may unlock source mutation.

---

# 45. Final Implementation Principle

The resulting system must make this flow mandatory:

```text
bound review context
→ reviewer supplies judgment/content
→ shared lifecycle captures result
→ required artifacts are persisted
→ schema validated
→ digest bound
→ generation/currentness validated
→ state advances
→ acceptance authority verifies
→ canonical delivery publishes
→ downstream admission becomes possible
```

And make this flow impossible:

```text
reviewer says PASS
→ reviewer happens to save something somewhere
→ system assumes review completed
```

The intended ownership rule is:

> **The reviewer owns judgment.
> The lifecycle owns evidence durability.
> The acceptance authority owns trust advancement.**
