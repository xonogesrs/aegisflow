# AUTOLOOP-REVART-RC1A — Durable Review Authority Architecture Closure

## Status

`READY_TO_START` → **`ARCHITECTURE_CLOSED`** (this document)

## Type

Architecture Closure / Foundation Repair (Plan Mode, read-only wrt implementation)

## Parent

`AUTOLOOP-REVART-RC1`

## Predecessor Verdict

`REPAIR_REQUIRED / RC1_ARCHITECTURE_NOT_READY_FOR_IMPL1_SPEC`

## Implementation Authorization

**NO.** This document closes architecture only. It does not authorize
`AUTOLOOP-REVART-IMPL1`, does not authorize source mutation, and does not
authorize any AUTH1 candidate change.

## Supersession

This document **supersedes RC1 §7.2 (root cause), §8 (alternatives), §9
(selected architecture), §10 (migration), §11 (verification), §12
(implementation scope), §13 (freeze gate)**. RC1 §0–§6 (evidence base,
incident preservation, historical matrix, live lifecycle graph, ownership
matrix, artifact taxonomy, failure matrix) remain valid historical record and
are **not** re-derived here. Where this document and RC1 conflict, this
document is authoritative.

---

# 1. Mutation Authority

**READ-ONLY wrt everything except this document.**

- AUTH1 A–C candidate (13 tracked + 1 untracked test) — **unchanged**.
- F1/F2/F3 implementation — **unchanged**.
- No review-artifact reconstruction.
- No `review-job` implementation, no writeback-gate implementation, no migration
  implementation, no new controller path, no new independent-review script.
- No Phase D/E.
- No commit / stage / promotion.

This document is the **only** artifact RC1A is authorized to produce.

---

# 2. Root-Cause Model (amended)

RC1 preserved H4/H8/H9 as symptoms. That stands.

The upstream cause is re-stated (per RC1A §5) as:

> **The review system lacks a durable, governed distinction between
> first-party assertion (the implementer's self-reported closeout bundle) and
> independent attestation (the independent reviewer's findings + verdict),
> together with a single authoritative lifecycle for creating, persisting,
> accepting, resuming, superseding, and consuming that attestation.**

This distinction is load-bearing and is **already partially present** in the
live source, which RC1 under-read:

- `closeout-state.mjs` (RB2R1) already enforces the descriptive/authoritative
  split: a persisted `stage:REVIEW_ACCEPTED` / `externalReviewStatus:"PASS"`
  is demoted to `INDEPENDENT_REVIEW_PENDING` — authority for `REVIEW_ACCEPTED`
  "requires a verified bound review record", never a caller-controlled field.
- `review-context.mjs` already recomputes candidate identity
  (`changedTreeIdentity`, `patchSha256`, heads, repo/branch) rather than
  trusting a SHA.
- `review-history.mjs` already carries cross-round continuity
  (`review_round`, `repair_round`, `prior_bundle_sha256`,
  `prior_findings_digest`, `effective_repair_cap`), written only by a
  controller entrypoint.
- `Current/delivery.json` already carries a `supersedes` chain and atomic
  publish/rotate.

Therefore the correct closure is **convergence onto these existing primitives**,
not a new parallel registry. `review-job` (below) is the *coordination and
binding identity* that extends the existing machinery to cover the
independent-review (IR) findings/verdict artifacts — the one gap in Flow 2.

### H3 / H7 de-aggregation

- **H3** (25-section vs 11-section generators) = a *competing surface* defect.
  Resolved by retiring one generator (§9.2), not merely by "converging later".
- **H7** (per-card IR scripts) = a *bespoke lifecycle/writeback* defect.
  Resolved by the generic/custom boundary (§11): the per-card part shrinks to
  spec content only.

---

# 3. Canonical State Set

**Exactly one** state set exists. RC1's 13-state listing (its §6) and its
11-state listing (its §9.2) are both withdrawn. The canonical set is:

| # | State | Meaning | Terminal? |
|---|---|---|---|
| 1 | `REQUIRED` | review mandatory per authority; job record created (lineage + candidate + spec identity); no reviewer bound | no |
| 2 | `PREPARED` | spec content bound (`specId`+`specDigest`); reviewer execution identity derived and bound | no |
| 3 | `RUNNING` | reviewer launched; durable started marker written | no |
| 4 | `FINDINGS_CAPTURED` | findings artifact persisted at canonical path, schema-validated, digested, bound to job | no |
| 5 | `VERDICT_PRODUCED` | verdict artifact persisted, schema-validated, digested, bound to findings digest | no |
| 6 | `PERSISTED` | both artifacts verified present + immutable at canonical path; digests bound to candidate identity | no |
| 7 | `STAGED` | both artifacts git-staged by the writeback gate; staging identity verified | no |
| 8 | `ACCEPTED` | acceptance authority validated the full chain and minted acceptance (verdict `PASS` required) | no |
| 9 | `DOWNSTREAM_AUTHORIZED` | integration/bundle gates verified `ACCEPTED` + clean worktree + fresh verification | no |
| 10 | `SUPERSEDED` | a strictly newer generation displaced this job | **yes** |
| 11 | `HOLD` | a gate/authority detected invalid/mismatched state; fail-closed | **yes** (until superseded) |

Mapping to the existing closeout machine (one truth chain, §9):

- `review-job.ACCEPTED` → closeout `REVIEW_ACCEPTED`
- `review-job.DOWNSTREAM_AUTHORIZED` → closeout `CLOSEOUT_ELIGIBLE` → `CLOSED`

`FINDINGS_CAPTURED`/`VERDICT_PRODUCED`/`PERSISTED`/`STAGED` are the IR
execution half that Flow 2 currently lacks; `REQUIRED`/`PREPARED`/`RUNNING`
replace the prose "hand to independent session" with durable state.

---

# 4. Transition Ownership Matrix

Every legal transition has exactly one owner. `MECHANICAL` = no human/policy
judgment in the transition itself. `JUDGMENT` = the transition *produces or
commits to a human/expert decision*; only the decision is judgment, its
durable writeback is always mechanical.

| ID | From → To | Owner | Trigger | Class |
|---|---|---|---|---|
| T1 | `REQUIRED` → `PREPARED` | job-preparation gate (spec author + reviewer-assignment entrypoint) | spec content file written with digest; reviewer identity derived | MECHANICAL |
| T2 | `PREPARED` → `RUNNING` | reviewer-launch entrypoint | reviewer starts; durable started marker written via writeback gate | MECHANICAL |
| T3 | `RUNNING` → `FINDINGS_CAPTURED` | writeback gate | findings artifact atomically persisted + digested + bound | MECHANICAL |
| T4 | `FINDINGS_CAPTURED` → `VERDICT_PRODUCED` | decision: independent reviewer; write: writeback gate | reviewer issues PASS/REPAIR/REPLAN/HOLD; writeback persists verdict + digest + findings-digest binding | **JUDGMENT** (decision) / MECHANICAL (write) |
| T5 | `VERDICT_PRODUCED` → `PERSISTED` | writeback gate | both artifacts re-verified (schema + digest + canonical path + immutability) | MECHANICAL |
| T6 | `PERSISTED` → `STAGED` | writeback gate | `git add` of the two artifacts (exact paths); staging identity verified | MECHANICAL |
| T7 | `STAGED` → `ACCEPTED` | acceptance authority (controller-operator via controller-only acceptance entrypoint) | acceptance entrypoint recomputes full chain and mints acceptance (exclusive-create) | **JUDGMENT** (acceptance) / MECHANICAL (validation) |
| T8 | `ACCEPTED` → `DOWNSTREAM_AUTHORIZED` | integration-commit-gate / bundle gate | gate recomputes + verifies acceptance record + candidate identity + clean worktree + fresh verification | MECHANICAL |
| T9 | any non-terminal → `SUPERSEDED` | supersession authority (job-preparation gate of the newer generation) | a job for the same lineage with strictly higher generation is durably created | MECHANICAL |
| T10 | any non-terminal → `HOLD` | the gate/authority that detected the violation | any validation fails (missing/corrupt/mismatch/stale/self-declared) | MECHANICAL (fail-closed) |

### 4.1 Per-transition detail (preconditions / outputs / recovery)

**T1** — pre: `authority.requiresReview == true`; spec file exists with computable
digest; reviewer identity derivable; candidate identity computable (§8). output:
job fields `specId`, `specDigest`, `reviewerIdentity`, `candidateIdentity`.
recovery: crash-before → stays `REQUIRED` (re-run prep, idempotent); crash-after →
`PREPARED`.

**T2** — pre: `PREPARED`. output: started marker (attempt timestamp + reviewer
identity). recovery: crash-before → `PREPARED`; crash-after → `RUNNING` (marker
idempotent; resume reads marker, never chat).

**T3** — pre: `RUNNING`. output: findings artifact (atomic tmp+rename) + digest
binding. recovery: crash-during-write → tmp ignored, still `RUNNING`;
crash-after-write-before-state → re-derived `FINDINGS_CAPTURED` from the observed
durable artifact (idempotent).

**T4** — pre: `FINDINGS_CAPTURED`. output: verdict artifact + digest + findings-digest
binding. The *verdict value* (PASS/REPAIR/REPLAN/HOLD) is the reviewer's judgment;
nothing mechanical may infer it. recovery: crash-before → `FINDINGS_CAPTURED`;
crash-after → `VERDICT_PRODUCED`.

**T5** — pre: `VERDICT_PRODUCED`. output: `PERSISTED` (both artifacts verified).
recovery: re-verification idempotent; any missing/corrupt → `HOLD` (T10).

**T6** — pre: `PERSISTED`. output: git index contains the two artifacts; staging
identity recorded. recovery: crash-during-stage → re-stage idempotent; staging
identity mismatch → `HOLD`.

**T7** — pre: `STAGED` + verdict `PASS`. owner supplies `reviewer_identity` +
`authorization_source`; entrypoint recomputes candidate identity, findings digest,
verdict digest, round continuity, generation currency, worktree cleanliness; then
exclusive-create acceptance record. recovery: crash-before → `STAGED` (no record);
crash-after → `ACCEPTED`; record present but invalid → `HOLD`. The acceptance
authority is **not** the reviewer and **not** derivable from any review-job field.

**T8** — pre: `ACCEPTED`. output: downstream authorized; feeds closeout
`REVIEW_ACCEPTED`/`CLOSEOUT_ELIGIBLE`. recovery: any mismatch → `HOLD`; re-verify
idempotent.

**T9** — pre: newer generation durably created. output: old job `SUPERSEDED`
(write-once, monotonic). recovery: crash during supersede → either old still
current (new not yet persisted) or new has higher generation (old re-derivable as
`SUPERSEDED`); never ambiguous.

**T10** — pre: any failed validation. output: `HOLD` (persistent). recovery:
`HOLD` ends only by a new generation superseding it or by an explicitly authorized
repair creating a new attempt — **never** by mutating the held job.

### 4.2 Mechanical vs judgment split (normative)

- **Judgment:** (a) the reviewer's verdict value (T4); (b) the acceptance
  decision (T7). Both are human/expert decisions.
- **Mechanical:** persistence, digest computation, identity validation,
  canonical-path verification, staging, round/generation checks, supersession,
  and downstream gate verification.

`VERDICT_PRODUCED` is **not** a purely mechanical transition. RC1's claim that
"all transitions are mechanical" is rejected and superseded.

---

# 5. ACCEPTED Authority

Exactly one authority may mint `ACCEPTED`: the **acceptance authority**,
instantiated as the **controller-operator acceptance entrypoint**
(the successor of `gov-controller-ingest-result.mjs`).

It MUST satisfy all of:

1. not reviewer self-grantable;
2. not caller-supplied;
3. not derived from mutable review-job fields alone;
4. grounded in an authoritative execution entrypoint;
5. mechanically validates the complete accepted evidence chain (candidate
   identity + findings digest + verdict digest + round continuity + generation
   currency + worktree cleanliness);
6. rejects stale candidate / spec / job / generation;
7. remains valid across process restart (the acceptance record is durable and
   re-verifiable, not in-memory);
8. auditable after the originating session disappears.

The trigger that converts a persisted independent verdict into `ACCEPTED` is:
the acceptance entrypoint runs with `verdict == PASS`, recomputes every binding,
and **exclusive-creates** the acceptance record. `REPAIR`/`REPLAN`/`HOLD`
verdicts cannot reach `ACCEPTED`; they route to `HOLD`/supersession.

---

# 6. Authority Provenance Model (F2 resolved at architecture layer)

F2 (`internal:true` self-grantable) is resolved by one invariant:

> **Authority is derived from an authoritative execution path and recomputed
> evidence — never asserted by a caller, reviewer session, job field, boolean,
> environment flag, or self-declared owner.**

The following are **never** proof of authority: `internal:true`, `owner:self`,
caller-provided reviewer type, caller-provided trusted flag, caller-provided
`ACCEPTED` state, caller-provided controller identity.

### 6.1 Derivation rule (frozen)

- `review-job.owner`, `state`, and the writeback gate's writer identity are
  assigned **only** by named entrypoints, each of which recomputes its
  authority from durable evidence (§6.2) — never from a field the caller
  supplies.
- The reviewer session writes **content only** (findings/verdict) into a
  host-owned canonical store through the writeback gate. It cannot set `owner`,
  `state`, or any acceptance field.
- `reviewer_identity` and `authorization_source` are **controller-supplied
  second-channel inputs** at the acceptance entrypoint (exactly as
  `gov-controller-ingest-result.mjs` already requires), and self-declared
  `agent:`-prefixed identities are rejected (exactly as
  `verifyExternalReviewResult` already rejects).

### 6.2 Honest boundary (frozen, not hand-waved)

Full mechanical provenance against a same-account *deliberately malicious*
executor requires an external trust anchor (separate identity/secret) that does
not exist today. The frozen contract is therefore:

- the executor is **mechanically unable** to *silently or accidentally* mint
  authority (writeback gate + acceptance entrypoint are distinct entrypoints,
  exclusive-create, recomputed digests);
- any **deliberate** forgery is **detectable** (digest recomputation +
  exclusive-create + separate acceptance record ownership + monotonic
  generation);
- the acceptance authority is a **controller-operator (human-in-the-loop)
  boundary**, not a machine-inferable one.

This is the same boundary the existing closeout flow already relies on; RC1A
freezes it explicitly instead of leaving it as an "honest limitation" comment.
It is **not** a "controller should ensure" shortcut: the mechanical invariants
(listed above) are enforceable and are required; the human step is only the
final acceptance judgment, which by definition cannot be mechanical.

---

# 7. Single Authoritative Review Truth

One and only one production-authoritative acceptance chain:

```
independent attestation (findings + verdict)
→ review-job durable evidence (canonical docs/pi-graph-output/<card>/)
→ review-job ACCEPTED (acceptance record, controller-owned)
→ Current/delivery.json (delivery/verdict surface, references review-job identity)
→ integration-commit-gate (recomputes; requires ACCEPTED + clean + verified)
→ closeout REVIEW_ACCEPTED / CLOSEOUT_ELIGIBLE / CLOSED
→ downstream bundle / integration admission
```

No alternate production path exists.

## 7.1 Surface classification (exactly one AUTHORITATIVE)

| Surface | Future role |
|---|---|
| `review-job` record + findings/verdict artifacts (`docs/pi-graph-output/<card>/`) | **AUTHORITATIVE** (IR evidence) |
| acceptance record (successor of `external-review-result.json`) | **AUTHORITATIVE** (the `ACCEPTED` mint) |
| `Current/delivery.json` | **AUTHORITATIVE** (downstream publication surface) |
| `review-history.json` | **DERIVED_VIEW** (stable lineage: round/repair/prior digests) — see §14 |
| `external-review-result.json` (legacy) | **RETIRED** (absorbed by acceptance record + review-job verdict artifact) |
| 25-section `gov-closeout-bundle.mjs` | **AUTHORITATIVE** (sole bundle generator) |
| 11-section `gov-review-bundle.mjs` | **RETIRED** |
| per-card `*-independent-review.mjs` scripts | **HISTORICAL** (fixtures only) |
| per-card `*-self-closeout.mjs` scripts | **HISTORICAL** (fixtures only) |
| `external-review-delivery-*.json` | **DERIVED_VIEW** (immutable delivery log) |

## 7.2 Legacy path retirement (explicit, not "converge later")

- `external-review-result.json` **ceases to be an independent acceptance
  authority.** Its identity/verdict/findings-digest role is carried by the
  review-job verdict artifact + acceptance record. Any read of it for
  production acceptance is a violation.
- The 11-section `gov-review-bundle.mjs` is retired; the 25-section
  `gov-closeout-bundle.mjs` is the single generator and is extended to
  enumerate declared IR artifacts (§12).
- Per-card IR/self-closeout scripts become runnable historical fixtures only;
  no production acceptance may consume them.
- "Migration later converges it" is **not** a permitted disposition. Each
  surface above has a fixed role at freeze time.

---

# 8. Candidate Identity Contract

`candidateSha` is **withdrawn** as the identity primitive (it cannot address an
unstaged working-tree diff — the exact state of the AUTH1 candidate).

**Model B is selected** (durable working-tree identity), reusing the existing
`review-context.mjs` recomputation rather than inventing a new one. The frozen
candidate identity is, at minimum:

- repository identity;
- base commit (`base_head`);
- current head (`current_head`);
- patch digest (`patchSha256`);
- changed-tree identity (`changedTreeIdentity`);
- relevant untracked-file identity;
- dirty-state contract (a job is bound to a *clean-pinned* candidate; drift is a
  violation).

All are **recomputed from the live tree** at bind time and at every downstream
gate — never trusted from a caller-supplied SHA. This is the same identity the
existing `integration-commit-gate`/`verifyExternalReviewResult` already consume,
so the review-job candidate identity is the *same* identity the gate checks
(no second identity contract).

---

# 9. Review-Job Identity

Two distinct identities, both frozen:

### 9.1 Stable lineage identity (survives repair rounds)

`lineageId = cardId` (the review lifecycle of one card). All rounds/repairs of
that card's review share the lineage.

### 9.2 Attempt identity (one exact candidate/spec/generation execution)

```
jobId = lineageId + "." + generation   (generation strictly monotonic)
```

Required fields (where applicable):

- `cardId` (lineage)
- `jobId`
- `specId` + `specDigest`
- candidate identity (§8)
- `review_round`
- `repair_round`
- `generation` (monotonic, never reused)
- `priorJobId`
- `priorFindingsDigest`
- `priorVerdictDigest`
- `supersedes` / `supersededBy`
- `createdAt`
- `reviewerIdentity` (derived, §10)
- `authorizationSource` (acceptance record only)

### 9.3 ABA / stale defense

- `generation` is monotonic and never reused.
- A `SUPERSEDED` job cannot return to current, cannot mint `ACCEPTED`, cannot
  update delivery, cannot stage artifacts, cannot satisfy gates (§15).
- Every gate recomputes candidate identity + generation + digests; any mismatch
  → `HOLD`/`REJECT`. Stale resume, stale ACCEPTED, wrong-round promotion,
  superseded resurrection, and duplicate current generations are all rejected
  by the same recomputation.

---

# 10. Reviewer Identity (derived, not self-declared)

- What constitutes an independent reviewer: an execution identity that is not
  the implementer, established by the reviewer-assignment entrypoint.
- Who establishes reviewer execution identity: the reviewer-assignment
  entrypoint (controller-side), mirroring `gov-controller-*`.
- How it binds to the job: `reviewerIdentity` is written into the job record at
  `PREPARED` by the preparation gate, and re-checked at acceptance.
- What persists after reviewer-session death: the findings/verdict artifacts +
  job record + digests (canonical store), never the session.
- Different reviewer resuming the same job: **rejected** — the job is bound to
  its reviewer; a different reviewer requires a new attempt/generation.
- Retry creates a new attempt/generation when: the candidate or spec changed,
  or the previous job is `HOLD`/`SUPERSEDED`, or a new repair round begins.

A reviewer cannot make itself trusted by writing a field into the job.

---

# 11. Generic vs Per-Card Boundary

### Per-card / custom (the only thing a card may bespoke)

- review questions;
- review objectives;
- expected invariants;
- card-specific adversarial checks;
- subject-specific reasoning requirements.

### Shared / generic (always, no exceptions)

- review-job lifecycle and state machine;
- reviewer authority binding;
- persistence and canonical artifact paths;
- digest computation;
- writeback;
- recovery;
- staging;
- supersession;
- acceptance;
- delivery binding;
- bundle admission;
- integration admission.

A per-card review script **must not** own lifecycle, writeback, or admission.
This is what retires H7.

---

# 12. Writeback / Commit Ownership (single owner each)

### 12.1 `review-job-writeback` gate owns

- canonical artifact persistence (atomic tmp+rename, exactly like
  `writeCloseoutState`);
- artifact schema validation;
- digest computation;
- job binding (findings digest ↔ verdict digest ↔ candidate identity);
- state-safe persistence (`FINDINGS_CAPTURED`/`VERDICT_PRODUCED`/`PERSISTED`);
- **git staging** (`git add` of the two artifacts, then verify staging identity).

### 12.2 `integration-commit-gate` owns

- final git **commit** authorization;
- final integration admission.

The writeback gate **is not** a commit authority. The commit gate **is not** a
review-artifact writer. This resolves RC1's "writeback gate or an
immediately-following commit gate" ambiguity (RC1 §9.4, §10.7).

---

# 13. Write Ordering / Crash Semantics (frozen)

One authoritative sequence (implementation must follow, not choose):

1. validate current job `generation` is current (not `SUPERSEDED`);
2. validate candidate identity + spec identity + reviewer identity bindings;
3. write artifact to a temporary/new location (never in-place);
4. validate bytes against schema;
5. compute digest;
6. atomically publish to the canonical artifact path (rename);
7. durably bind digest to the job record;
8. transition the persisted lifecycle state (same atomic record);
9. `git add` the authorized files (exact paths only);
10. verify staging identity against job bindings;
11. only later (a separate authority) allow integration commit.

For every step boundary, recovery is defined for: crash-before-action,
crash-during-action, crash-immediately-after-action, and duplicate replay.
Recovery is always by **observing durable state and re-deriving** — never by
trusting in-memory `resumeState` (§16, §17).

---

# 14. `review-history.json` Role

`review-history.json` is the **stable lineage store** for `review-job`: it owns
`review_round`, `repair_round`, `prior_bundle_sha256`,
`prior_findings_digest`, and `effective_repair_cap` (all already in its schema).

It is a **DERIVED_VIEW**, not an acceptance authority. It does not compete with
`review-job` for current acceptance truth; it supplies the cross-round
continuity dimension that a per-attempt `jobId` alone cannot carry.

---

# 15. Artifact Mutation / Supersession Rules

### 15.1 Mutation

After a digest-bound artifact contributes to `ACCEPTED`:
- in-place mutation **invalidates acceptance** (recomputation detects it);
- artifacts are immutable-by-construction (publish-once at canonical path);
- replacement bytes under the same filename never silently inherit prior
  acceptance — a new attempt/generation is required.

### 15.2 Supersession

- Only one generation is current.
- A `SUPERSEDED` job cannot: return to current, mint `ACCEPTED`, update
  delivery, stage review artifacts, or satisfy bundle/integration gates.
- Supersession is durable and monotonic (`supersedes`/`supersededBy` chain,
  consistent with `delivery.json`'s existing `supersedes` block).

---

# 16. Idempotency Rules

Every mechanical transition is exactly one of:

- safely idempotent (re-apply yields the same durable truth);
- exclusive-create (second apply rejected);
- compare-and-swap (apply only if current value matches);
- reject-if-already-applied;
- resume-by-observed-durable-state.

No transition may rely on "the previous process probably completed this."
Duplicate execution yields the same durable truth or a deterministic rejection.

---

# 17. Delivery Binding

`Current/delivery.json` is the **canonical downstream publication surface**.

Frozen role:

- it references the `review-job` identity (`jobId`, `generation`, candidate
  identity, findings digest, verdict digest);
- update is atomic publish/rotate with exclusive lock (existing behavior) —
  **replace/CAS**, never in-place partial write;
- stale delivery state is detected by recomputation against the current job
  (`jobId`/`generation`/candidate identity mismatch → stale);
- delivery referencing missing/corrupt artifacts → `HOLD`;
- only the delivery owner (closeout layer, successor of the current
  delivery/rotate entrypoint) may update it;
- crash during publication → lock + idempotent re-publish (existing
  crash-after-publish retry behavior).

---

# 18. Adversarial Determinism Gate

The architecture itself produces **one** deterministic outcome per scenario.
Allowed outcomes: `RESUME` / `REJECT` / `REPAIR_REQUIRED` / `SUPERSEDE` / `HOLD`.

| # | Scenario | Deterministic outcome |
|---|---|---|
| 1 | findings written, verdict missing, crash | `RESUME` (state re-derived `FINDINGS_CAPTURED`; a reviewer must produce the verdict) |
| 2 | verdict bytes written, digest not bound | `RESUME` (digest recomputed from durable verdict; state re-derived `VERDICT_PRODUCED`) |
| 3 | crash immediately before `ACCEPTED` | `RESUME` (job at `STAGED`; acceptance not yet minted; acceptance entrypoint re-runs) |
| 4 | artifact mutated after `ACCEPTED` | `REJECT` (`HOLD` — recomputation detects mismatch; acceptance invalidated; downstream denied) |
| 5 | candidate identity changes | `SUPERSEDE` (job bound to old identity; a new generation is required) |
| 6 | spec identity changes | `REJECT` (`HOLD` — `specDigest` mismatch) |
| 7 | reviewer B re-runs reviewer A's job | `REJECT` (job bound to reviewer A; B must get a new attempt/generation) |
| 8 | controller restart with stale `resumeState` | `RESUME` (state re-derived from durable canonical store; in-memory `resumeState` never trusted) |
| 9 | canonical artifact missing | `HOLD` |
| 10 | canonical artifact corrupt | `HOLD` (schema/digest mismatch) |
| 11 | staging partially complete | `HOLD` (staging identity mismatch; re-stage via writeback gate is the repair path) |
| 12 | legacy script attempts direct review writeback | `REJECT` (legacy scripts are HISTORICAL; writeback only via the writeback gate) |
| 13 | superseded generation attempts promotion | `REJECT` (superseded job cannot mint `ACCEPTED`/update delivery) |
| 14 | duplicate writeback | `RESUME` (idempotent / exclusive-create / CAS) |
| 15 | bundle generator attempts review-job bypass | `REJECT` (bundle gate enumerates declared artifacts + requires `ACCEPTED`; missing → fail) |

IMPLEMENTATION (IMPL1) MUST encode these as executable tests. RC1A only
requires that the *architecture* already determines each outcome, which it now
does.

---

# 19. IMPL1 Scope Boundary (not authorized here)

For reference only — the follow-up card `AUTOLOOP-REVART-IMPL1` will implement,
**after** its own independent Spec/Plan review + freeze:

1. `review-job` record schema + the 11-state machine (§3, §4) — extending, not
   replacing, `closeout-state.mjs`/`review-history.mjs`/`review-context.mjs`.
2. `review-job-writeback` gate: atomic, digest-computed, canonical-path,
   git-staging owner (§12.1).
3. Bundle integration: `gov-closeout-bundle.mjs` enumerates declared IR
   artifacts; missing → fail (§7.1).
4. Downstream gate: `integration-commit-gate` requires `ACCEPTED` (§7).
5. Acceptance entrypoint (successor of `gov-controller-ingest-result.mjs`)
   mints `ACCEPTED` per §5/§6.
6. Legacy retirement wiring: 11-section generator + legacy result path retired
   (§7.2).
7. Migration: backfill an AUTH1-IR1 job; mark ad-hoc scripts historical.
8. Verification: §18 scenarios encoded as tests + crash/restart + isolation.

**Explicitly out of scope:** AUTH1 A–C repair, F1/F2/F3 mutation-decisions,
Phase D/E start. Those remain frozen.

---

# 20. Forbidden Shortcuts (rejected at architecture level)

The following are **not** acceptable closure and are rejected wherever they
would have appeared:

- "implementation will decide"
- "controller should ensure"
- "reviewer is assumed trusted"
- "internal caller only"
- "same session"
- "normally no duplicate invocation"
- "migration later converges it"
- "existing script can temporarily remain authoritative"
- "candidate SHA approximately represents the current diff"
- "all states are mechanical"
- "commit gate or writeback gate may own this"
- "resume from whichever artifact exists"

---

# 21. Acceptance Criteria Mapping (RC1A §22)

| AC | Requirement | Satisfied by |
|---|---|---|
| AC1 | root cause (assertion vs attestation) modeled | §2 |
| AC2 | exactly one state set | §3 |
| AC3 | every transition has owner/preconditions/outputs/recovery/retry/classification | §4 |
| AC4 | judgment transitions not mislabeled mechanical | §4.2, T4/T7 |
| AC5 | one non-self-grantable ACCEPTED authority | §5 |
| AC6 | authority provenance frozen | §6 |
| AC7 | exactly one acceptance chain | §7 |
| AC8 | legacy paths cannot satisfy admission | §7.2 |
| AC9 | unstaged candidates uniquely bindable | §8 |
| AC10 | round continuity durably linked | §9, §14 |
| AC11 | ABA/stale defense | §9.3, §15 |
| AC12 | one writer owns persist/digest/stage | §12.1 |
| AC13 | separate commit authority | §12.2 |
| AC14 | every adversarial scenario deterministic | §18 |
| AC15 | per-card custom cannot regain lifecycle/writeback | §11 |
| AC16 | no source/candidate implementation occurred | §1 (true for this document) |

---

# 22. Local Verdict

`PASS / RC1A_DURABLE_REVIEW_AUTHORITY_ARCHITECTURE_CLOSED`

This local PASS does **not** authorize `AUTOLOOP-REVART-IMPL1`.

## Next Step (mandatory)

A new **independent read-only review** of this document. The reviewer must
actively attempt to break: authority provenance, `ACCEPTED` minting,
stale/replayed jobs, wrong candidate/spec binding, repair-round lineage,
supersession, artifact mutation, crash recovery, partial staging, duplicate
writeback, legacy direct acceptance, bundle bypass, and direct integration
bypass.

Independent verdict:

```
PASS / RC1A_ARCHITECTURE_READY_FOR_IMPL1_SPEC
```
or
```
REPAIR_REQUIRED / RC1A_ARCHITECTURE_NOT_READY_FOR_IMPL1_SPEC
```

Only the independent `PASS` permits creating `AUTOLOOP-REVART-IMPL1`.

---

# 23. Execution Order (unchanged)

```
RC1 → Independent RC1 Review (REPAIR_REQUIRED) → RC1A Architecture Closure
→ Independent RC1A Review → PASS → AUTOLOOP-REVART-IMPL1 Spec
→ Independent IMPL1 Spec/Plan Review → Freeze → Implementation → Adversarial verification
```

No stage may be skipped.
