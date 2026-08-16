# AUTOLOOP-REVART-RC1 — Review Artifact Lifecycle, Durability & Authority Root-Cause Reconciliation

## Status

`READY_TO_START` → **`INVESTIGATION_COMPLETE`** (read-only) → **`PLAN_FROZEN`** (this document)

## Type

Foundation Root-Cause Reconciliation / Plan Mode

## Mutation Authority

**READ-ONLY.**

No production/governance repair was performed during this reconciliation. No missing
review artifact was recreated. No AUTH1 mutation, no IR1-F1/F2 decision, no Phase D/E
start, no commit/push/promotion occurred. This document records findings and freezes a
solution architecture only.

## Verdict

`PASS / REVIEW_ARTIFACT_LIFECYCLE_ROOT_CAUSE_AND_DURABLE_AUTHORITY_MODEL_RECONCILED`

> This PASS means only: the problem and the authoritative solution are frozen.
> It does NOT authorize implementation until the follow-up implementation card is
> Spec/Plan-reviewed and frozen under the normal SOP.

---

# 0. Evidence Base (bounded, read-only)

- Repo: `/Volumes/NVM2T/Development/autoloop` — branch `governance/reversible-lifecycle-draft-pr` — HEAD `56bb281fee0ac3735cdff08949e9d71997e6011c`
- External review surface: `~/Desktop/AutoLoop-Review/` (canonical `Current/`, rotation `archive/`, per-card dirs)
- Pi session store: `~/.pi/agent/sessions/` (used only to prove session-only artifacts)
- Governance docs: `<repo>/docs/governance/`
- Per-card durable output convention: `<repo>/docs/pi-graph-output/<card>/`
- Source machinery: `<repo>/src/governance/{external-review,review-bundle,review-history,review-context,review-unit-gate,closeout-state,integration-commit-gate}.mjs`
- CLI scripts: `<repo>/scripts/gov-closeout-bundle.mjs`, `gov-review-bundle.mjs`, and per-card `*-independent-review.mjs` / `*-self-closeout.mjs`

---

# 1. Current Incident Preservation (AUTH1 — read-only facts)

All facts recorded **without** creating, repairing, or re-deriving any missing artifact.
Absence is recorded as evidence.

| # | Fact | Value | State |
|---|---|---|---|
| 1 | AUTH1 discovery artifact | `docs/governance/autoloop-p1-auth1-authority-graph-discovery.md` (5,435 B, 08-15 23:31) | **untracked** (`??`) |
| 2 | AUTH1 implementation card | `docs/governance/autoloop-p1-auth1-impl-canonical-production-authority-seam-convergence.md` (17,128 B, 08-15 23:36) | **untracked** (`??`) |
| 3 | AUTH1 IR1 review spec | `docs/governance/autoloop-p1-auth1-ir1-phase-a-c-plan-recovery-and-adversarial-review.md` (13,144 B, 08-15 23:59) | **untracked** (`??`) |
| 4 | A–C candidate diff | 13 tracked files modified, **unstaged**: `src/admission/policy-projection.mjs`, `src/autoloop.mjs`, `src/runtime/colima-graph-runner.mjs`, `src/v2/durable-execution.mjs`, 9 test files (133 insertions / 33 deletions) | `IMPLEMENTED / UNTRUSTED CANDIDATE` (per IR1 §1) |
| 5 | New A–C test | `test/admission/test-retrieval-authority.mjs` | **untracked** (`??`) |
| 6 | IR1 findings F1/F2/F3 | Only in pi session JSONL `~/.pi/agent/sessions/--Users-zhengfengqing--/2026-08-15T15-34-16-742Z_01a0060f-3ba6-7e94-a8cf-68d492346df7.jsonl` (816 KB) | **session-only, NOT persisted** |
| 7 | IR1 preliminary verdict | `REPAIR_REQUIRED` (F1 bounded) + F2 architectural decision | **session-only** |
| 8 | Durable IR output dir | `docs/pi-graph-output/auth1/` | **ABSENT** |
| 9 | IR script | `scripts/auth1-independent-review.mjs` (or equivalent) | **ABSENT** (contrast: `ta2r-`, `ta3-`, `rld2-independent-review.mjs` exist) |
| 10 | External review surface | `~/Desktop/AutoLoop-Review/Current/` still holds `RB-SSG4-R3` — `externalReviewStatus: AWAITING_EXTERNAL_REVIEW`, `reviewBundleValidated: false` | no AUTH1 entry |
| 11 | Git commit state | HEAD `56bb281`; AUTH1 docs + test **untracked**; candidate diff **unstaged** | no commit pins any AUTH1 artifact |
| 12 | Review bundle | no AUTH1 `card-closeout-bundle-*` exists in `Current/` or `docs/pi-graph-output/` | **ABSENT** |
| 13 | `Current/delivery.json` | `cardId: RB-SSG4-R3`, `reviewBundleGenerated: true`, `reviewBundleValidated: false`, validation "controller-owned and pending" | stale occupant, AUTH1 absent |

### 1.1 IR1 findings (recovered read-only from session state, for the record only)

- **IR1-F1** (R-09, Stage D1): incomplete caller classification + two broken script callers
  (`de1-bakeoff` pair). Classified `REPAIR_REQUIRED`.
- **IR1-F2** (R-09, Stage D3): `internal: true` is a self-grantable boolean with no
  authority provenance. Classified as an **architectural decision** the independent
  reviewer must make (accept contract-marker boundary vs. escalate to REPLAN/RETIRE).
- **IR1-F3** (R-09, Stage D4): family-wide demotion of `runAutoLoop`+`resumeAutoLoop`+
  `runDurableAutoLoop` is defensible, contingent on F1 being fixed first.
- Preliminary verdict: `REPAIR_REQUIRED` (bounded: fix F1); F2 = explicit decision.

These findings exist **only** in conversation/session state. That is the incident.

---

# 2. Deliverable A — Historical Incident Matrix

Authoritative history only (`~/Desktop/AutoLoop-Review/archive`, `~/Desktop/AutoLoop-Review/*`,
`<repo>/docs/governance`, `<repo>/docs/pi-graph-output`, `~/.autoloop`).

| # | Incident | Expected artifact | What actually existed | Detection time | Immediate repair | Recurred? |
|---|---|---|---|---|---|---|
| H1 | `cbm3/cbm4/cost1/de1` self-closeout | durable closeout bundle in `~/Desktop/AutoLoop-Review` | **empty** `autoloop-*-self-closeout/` dirs in `$HOME` | post-hoc | none | yes (4×) |
| H2 | graph closeout "PASS" recorded in `~/.autoloop/memory/journal.jsonl` | evidence items bound | `evidence.items: []` (empty), `trust: UNVERIFIED` | post-hoc | none (journal still empty) | yes (3 records) |
| H3 | R-R3-RB1 (documented in `review-bundle-reconciliation.md`) | ONE authoritative reviewer-facing file | two generators (25-section `gov-closeout-bundle.mjs` vs 11-section `gov-review-bundle.mjs`) → "single-file handoff contract ambiguous" | reconciliation | frozen canonical path (25-section) | residual (see H4) |
| H4 | `Current/delivery.json` `reviewBundleValidated: false` | mechanically validated bundle before delivery | renderer computes identity/sha but "strict closeout-gate validation is controller-owned and pending" | this reconciliation | none | open |
| H5 | `review-history.json` "no writer" | Controller-maintained findings history | source comment: "outside production path has no writer" | source read | none | open |
| H6 | `external-review-result.json` stores `findings_digest` (hash) only | full findings text durably bound | findings text exists only in bundle §7 / review-history, not in result artifact | source read | none | open |
| H7 | per-card IR implemented as ad-hoc scripts (`ta2r-`, `ta3-`, `rld2-independent-review.mjs`) | one shared governed review-job state machine | N bespoke scripts, each writing its own JSON path | source read | none | open (design) |
| H8 | AUTH1-IR1 (this incident) | durable IR findings + verdict + tracked artifact | findings/verdict only in pi session; `docs/pi-graph-output/auth1/` absent; docs untracked | **this reconciliation** | none (frozen) | **the trigger** |
| H9 | archive rotation shows many `SUPERSEDED`/`REPAIR`/`HOLD` generations | single authoritative generation | multiple competing generations retained as `SUPERSEDED` | archive read | supersede records | recurring |

**Pattern across H1–H9:** every incident is the same shape — *the review/closeout event is
logically recorded or performed, but the expected durable artifact either was never written,
was written only to a session, was written to an empty/non-authoritative location, or was
written but never tracked/bound — and nothing downstream failed closed.*

---

# 3. Deliverable B — Live Review Lifecycle Graph

Two **distinct** flows exist in source, and they are the core of the failure.

### Flow 1 — Card-closeout external review (has machinery)

```
impl → closeout bundle (25-section, review-bundle.mjs)
     → writeReviewBundle (atomic write, MECHANICAL)
     → validateReviewBundle (fail-closed, MECHANICAL)
     → external-review-result.json (verdict + findings_digest, MECHANICAL schema)
     → integration-commit-gate / push-gate / draft-pr (fail-closed, MECHANICAL)
```

### Flow 2 — Independent review (IR) (no machinery)

```
impl card §24 prose "run independent review"        (PROMPT_ONLY)
→ IR card markdown written by hand                  (CONVENTION_ONLY)
→ "hand to independent session" prose               (PROMPT_ONLY)
→ reviewer produces findings/verdict in session     (EPHEMERAL)
→ [no mechanical writeback]                         (MISSING)
→ [no git add/commit]                               (MISSING)
→ [no downstream gate reads findings]               (MISSING)
```

### State-by-state classification

| State | Exists mechanically? | Classification |
|---|---|---|
| `REVIEW_REQUIRED` | closeout: yes (`external_review.required`); IR: prose only | SPLIT_OWNERSHIP |
| `REVIEW_SPEC_CREATED` | manual markdown | CONVENTION_ONLY |
| `REVIEW_ASSIGNED` | prose | PROMPT_ONLY |
| `REVIEW_STARTED` | nothing | MISSING |
| `FINDINGS_CAPTURED` | nothing (session / bespoke script) | MISSING / CONVENTION_ONLY |
| `VERDICT_PRODUCED` | closeout: result artifact; IR: prose | SPLIT_OWNERSHIP |
| `ARTIFACT_PERSISTED` | bespoke `writeFileSync` only | CONVENTION_ONLY |
| `ARTIFACT_TRACKED` | nothing (AUTH1 docs untracked) | MISSING |
| `ARTIFACT_BOUND_TO_EXECUTION` | closeout bundle identity+SHA only | PARTIAL (IR: MISSING) |
| `ARTIFACT_INCLUDED_IN_BUNDLE` | bundle §7 embeds *prior* findings only | PARTIAL |
| `DELIVERY_BOUND` | `delivery.json` (manual renderer; `validated:false`) | CONVENTION_ONLY |
| `REVIEW_ACCEPTED` | Controller manual ingest | PROMPT_ONLY |
| `DOWNSTREAM_AUTHORIZED` | closeout gates only; IR has no gate | PARTIAL |

**Conclusion:** Flow 1 has a real state machine; Flow 2 has none. The "review artifact" the
governance card asks for (independent findings + verdict) lives in Flow 2, outside every
mechanical gate.

---

# 4. Deliverable C — Ownership Matrix

| Responsibility | Current owner | Mechanical? | Gap |
|---|---|---|---|
| Review requirement | impl card author (prose) / `external_review.required` (closeout only) | split | IR requirement not mechanical |
| Review spec owner | whoever writes the IR card | no | no identity, no schema |
| Reviewer assignment | "hand to independent session" prose | no | no durable assignment record |
| Findings owner | reviewer session (ephemeral) | no | **no persistence owner** |
| Verdict owner | `external-review-result.json` (closeout) vs prose (IR) | split | two verdict surfaces |
| Artifact persistence | bespoke per-card script | no | no shared writeback gate |
| Git ownership | nobody | no | AUTH1 docs untracked |
| Evidence binding | `reviewBundleIdentity`/sha256 (closeout only) | closeout only | IR findings never bound to candidate SHA |
| Bundle owner | `gov-closeout-bundle.mjs` (closeout only) | closeout only | IR has no bundle |
| Downstream admission | `integration-commit-gate` et al. (closeout only) | closeout only | IR findings/verdict never gated |

**No responsibility is allowed to remain owned by "the Agent should remember."**

---

# 5. Deliverable D — Artifact Taxonomy

| # | Artifact | Purpose | Authority | Owner | Canonical naming / location | Binding |
|---|---|---|---|---|---|---|
| 1 | Review spec | instructions/card for the review | required input | card author | `<card>-ir1-*.md` in `docs/governance/` | card identity |
| 2 | Preliminary findings | interim reviewer notes | **non-authoritative**, provisional | reviewer | session or scratch | candidate SHA (provisional) |
| 3 | Independent review findings | durable findings artifact | **authoritative evidence** | review job writeback | `docs/pi-graph-output/<card>/<card>-independent-review-findings.json` (or `.txt`) | candidate SHA + spec identity + job identity |
| 4 | Independent review verdict | final PASS/REPAIR/REPLAN/HOLD | **authoritative decision** | review job writeback | same job dir, `<card>-independent-review-verdict.json` | findings digest + candidate SHA |
| 5 | Review bundle | 25-section self-report (closeout) | evidence carrier | `gov-closeout-bundle.mjs` | `~/Desktop/AutoLoop-Review/Current/…` | bundle identity + sha256 |
| 6 | Delivery record | delivery/verdict binding | authoritative delivery | renderer + controller | `Current/delivery.json` | bundle identity/sha |
| 7 | Closeout artifact | card closeout evidence | authoritative closeout | `closeout-state.mjs` | `<card>-closeout-state.json` | HEAD + bundle |
| 8 | Implementation report | self-report of implementation | untrusted candidate (until IR) | impl | card-closeout bundle | candidate SHA |

**Rules enforced by this taxonomy:**
- A review spec (1) is **not** a review result.
- Preliminary findings (2) are **not** a verdict (4).
- `delivery.json` (6) is **not** a substitute for source findings (3).
- Findings (3) and verdict (4) are **separate artifacts**, each with its own digest.

---

# 6. Deliverable E — Failure Matrix (current behavior)

| Case | Condition | Current behavior | Fail-closed? |
|---|---|---|---|
| A | review required, spec missing | nothing stops work | NO |
| B | spec exists, findings missing | nothing stops work | NO |
| C | findings exist, verdict missing | nothing stops work | NO |
| D | verdict exists, artifact file missing | closeout: result artifact missing → HOLD; IR: no gate | closeout only |
| E | artifact exists but untracked | AUTH1 docs untracked; nothing fails | NO |
| F | artifact belongs to wrong candidate SHA | closeout bundle identity checks catch; IR: no binding | closeout only |
| G | artifact changed after verdict | bundle sha256 re-check catches (closeout); IR: no digest | closeout only |
| H | delivery references unmaterializable identity | renderer validation deferred ("controller-owned") | NO (deferred) |
| I | impl reports "review PASS", no artifact | no IR gate exists | NO |
| J | next phase begins anyway | Phase D/E gate is prose in IR1 §13 only | NO (prose) |

**Expected principle:** `required review artifact not durably established → downstream authority denied`. Current source enforces this **only for the card-closeout flow**, never for the independent-review flow.

---

# 7. Deliverable F — Root-Cause Analysis

### 7.1 Hypothesis evaluation (evidence-based)

| H | Hypothesis | Verdict |
|---|---|---|
| H1 | Prompt/convention ownership | **CONFIRMED** — IR findings/verdict are prose instructions with no mechanical writeback |
| H2 | Split ownership | **CONFIRMED** — reviewer session produces, nobody persists, controller manually ingests |
| H3 | Missing artifact state machine | **CONFIRMED** — Flow 2 has no states; Flow 1 state machine does not cover IR output |
| H4 | Late validation | **CONFIRMED** — `reviewBundleValidated:false`, validation "controller-owned and pending" |
| H5 | Path/naming coupling | **CONFIRMED** — discovery by filename convention (`<card>-independent-review-findings.*`) |
| H6 | Git ownership gap | **CONFIRMED** — AUTH1 docs + test untracked |
| H7 | Ephemeral reviewer state | **CONFIRMED** — F1/F2/F3 only in session JSONL |
| H8 | Bundle blind spot | **CONFIRMED** — bundle proves known files, not that every required review stage produced artifacts |
| H9 | Competing review surfaces | **CONFIRMED** — 25 vs 11-section bundles; `Current/delivery.json` vs `external-review-result.json`; result stores hash not text |
| H10 | Resume gap | **CONFIRMED** — no durable pending-review state |

### 7.2 Highest common root cause

> **The independent-review event is not a first-class governed workflow object.**
>
> The machinery that exists (`external-review.mjs` state machine, 25-section
> `review-bundle.mjs`, `review-history.json`) is bound to the implementation's
> **self-reported closeout bundle** and its digest-bound result. The independent
> reviewer's **findings and verdict** have no durable identity, no pre-declared
> output artifact contract, no mechanical persistence owner, no Git owner, and no
> fail-closed downstream gate. Consequently review output can reach `GENERATED`
> (in a session) without ever reaching `PERSISTED → OWNED → TRACKED → BOUND →
> ACCEPTED`, and nothing downstream fails.
>
> H4 (late validation), H8 (bundle blind spot), and H9 (competing surfaces) are
> **symptoms** of the same missing lifecycle, not independent defects. H1, H2, H3,
> H5, H6, H7, H10 are all facets of the one upstream cause.

---

# 8. Deliverable G — Alternatives Analysis

| Option | Description | Assessment |
|---|---|---|
| A | Patch missing file creation (`write review.md`) | **REJECTED** — proven insufficient by recurrence (H1–H9); does not change any mechanical invariant |
| B | Review artifact manifest | declares expected outputs + completion gate; addresses P2/P6/P7 but not durable identity (P1) or resume (P10) alone |
| C | Durable review job state machine | gives identity + state + restart (P1/P10); needs an output contract to enforce P2/P6/P13 |
| D | Bundle-driven review contract | predeclared outputs, cannot close until bound (P2/P6/P13); needs a durable job identity to attach to (P1) |
| **E** | **Hybrid: durable review job + predeclared artifact contract + fail-closed bundle/delivery validation** | **SELECTED** — satisfies all P1–P13 with the smallest single mechanism |

Option E = C (identity + state + resume) as the *skeleton*, B (manifest/contract) as the
*output declaration*, D (fail-closed bundle/delivery consumption) as the *enforcement*.

---

# 9. Deliverable H — Selected Architecture (frozen)

### 9.1 Core object: `review-job`

A required review is **not** prose. It is a durable object created **before** reviewer launch:

```
review-job := {
  jobId,                 // durable identity (digest of card + candidate + spec)
  cardId, candidateSha,  // candidate binding (P5)
  specId,                // review spec identity (P9)
  declaredArtifacts: [   // predeclared before execution (P2)
    { kind: "findings",  path, schema, digest },
    { kind: "verdict",   path, schema, digest },
  ],
  state,                 // REVIEW_REQUIRED → SPEC_CREATED → ASSIGNED → STARTED
                         // → FINDINGS_CAPTURED → VERDICT_PRODUCED → ARTIFACT_PERSISTED
                         // → ARTIFACT_TRACKED → ARTIFACT_BOUND → ACCEPTED
                         // → DOWNSTREAM_AUTHORIZED
  owner,                 // single persistence owner (P4)
  resumeState,           // reconstructible without chat (P10)
}
```

### 9.2 State machine (mechanical)

`REVIEW_REQUIRED → SPEC_CREATED → ASSIGNED → STARTED → FINDINGS_CAPTURED → VERDICT_PRODUCED → ARTIFACT_PERSISTED → ARTIFACT_TRACKED → ARTIFACT_BOUND → ACCEPTED → DOWNSTREAM_AUTHORIZED`

Every transition has: owner, trigger, code path, filesystem path, artifact schema,
execution identity, expected digest, Git responsibility, bundle responsibility, failure
behavior, and restart/resume behavior. All transitions are **MECHANICAL** (no PROMPT_ONLY,
no CONVENTION_ONLY, no SPLIT_OWNERSHIP).

### 9.3 Creation vs persistence separation (mandatory)

| State | Meaning | Implied by |
|---|---|---|
| `GENERATED` | content exists somewhere | nothing |
| `PERSISTED` | at durable canonical path | writeback gate |
| `OWNED` | correct execution/review identity | job.owner |
| `TRACKED / PINNED` | bytes in authoritative evidence ownership | git add/commit (or pin) |
| `BOUND` | digest connected to reviewed candidate | job.candidateSha + digest |
| `ACCEPTED` | authority chain recognizes it | downstream gate |

No earlier state implies a later state. A session that "did the review" reaches only
`GENERATED`; it must mechanically advance through `PERSISTED → … → ACCEPTED`.

### 9.4 Single ownership assignments

- **Requirement owner:** lifecycle authorization (`external_review.required`), extended to IR jobs.
- **Spec owner:** job creation writes the spec identity + declared artifact contract.
- **Findings/verdict persistence owner:** a shared `review-job-writeback` gate (one code path, digest-computed, atomic write to `docs/pi-graph-output/<card>/`).
- **Git owner:** the writeback gate (or an immediately-following commit gate) stages/commits the artifacts — never "the agent remembers".
- **Evidence binding owner:** job record binds `candidateSha ↔ findings digest ↔ verdict digest`.
- **Bundle owner:** `gov-closeout-bundle.mjs` enumerates required IR artifacts explicitly; missing → bundle construction fails (P6).
- **Downstream admission owner:** `integration-commit-gate`/phase-gate refuses when any required review job state ≠ `ACCEPTED`.

### 9.5 Reviewer isolation contract (P11)

For Docker/subagent reviewers, the review container is **never** the sole durable owner.
Across the boundary, mechanically: candidate identity, baseline SHA, spec identity, expected
output path/schema, findings, verdict, evidence digest, reviewer identity/type, timestamps,
return status. Output is written to a host-owned canonical store, not the container's scratch.

### 9.6 Fail-closed invariants (P6–P9, P12, P13)

- Required review job absent/unaccepted → downstream denied.
- Findings ≠ verdict (separate artifacts + digests). Spec ≠ output.
- Only the canonical `docs/pi-graph-output/<card>/` path is authority for IR output.
- Bundle/delivery/verdict chain consumes the **same** `review-job` identity.

---

# 10. Deliverable I — Migration Plan

Converge without split authority, no destructive cleanup:

1. **Freeze** the ad-hoc IR scripts (`ta2r-`, `ta3-`, `rld2-independent-review.mjs`) as historical; do not delete.
2. Introduce `review-job` + `review-job-writeback` as the **single** IR persistence path.
3. Register a `review-job` record for **AUTH1-IR1** (backfill: candidate SHA `56bb281`-based candidate, spec identity, declared artifacts) and re-run the review through the new mechanical writeback — this is the *only* way IR1-F1/F2 become authoritative; it is implementation-scope, not this reconciliation.
4. Extend `gov-closeout-bundle.mjs` bundle validation to require every declared IR artifact (findings + verdict) present and digest-bound.
5. Extend `integration-commit-gate` (and any phase-gate) to require IR job state = `ACCEPTED`.
6. Converge `external-review-result.json` to reference the `review-job` identity (findings text lives in the job dir; result stores digest → job).
7. Adopt `git add` ownership in the writeback gate so `PERSISTED` ⇒ `TRACKED`.

---

# 11. Deliverable J — Verification Plan

Property tests, crash/restart, isolation, negative paths:

- **P-test (all P1–P13):** each property asserted against the job state machine.
- **Crash/restart:** kill session after `FINDINGS_CAPTURED`; new session reconstructs job, findings digest, pending verdict, canonical path — **without chat history** (P10).
- **Isolation:** teardown reviewer container; canonical store still holds findings+verdict (P11).
- **Negative paths:** Cases A–J from §6 must all fail closed.
- **Bypass attempts:** reviewer tries to (a) leave output in session only, (b) write to non-canonical path, (c) self-grant `internal:true`-style authority, (d) skip git tracking, (e) mutate artifact after verdict, (f) reuse stale digest. Each must be denied.
- **Reproduction of prior incidents:** H1 (empty closeout dir), H2 (empty evidence items), H4 (`validated:false`), H6 (hash-only result), H8 (session-only findings) re-run against the new gate and asserted `DENIED`.
- **Regression:** existing card-closeout bundle flow (25-section) must keep passing; ad-hoc IR scripts must remain runnable as historical fixtures.

---

# 12. Deliverable K — Implementation Scope (bounded follow-up card)

One follow-up card: **`AUTOLOOP-REVART-IMPL1 — Review-Job Lifecycle & Writeback Gate`**

Scope (frozen here, implemented only after Spec/Plan review + freeze):

1. `review-job` record schema + state machine (`src/governance/review-job.mjs`).
2. `review-job-writeback` gate: atomic, digest-computed, canonical-path, git-staging owner.
3. Bundle integration: `gov-closeout-bundle.mjs` enumerates declared IR artifacts; missing → fail.
4. Downstream gate: `integration-commit-gate` / phase-gate require `ACCEPTED`.
5. Isolation contract: host-owned canonical store + boundary fields.
6. Migration: backfill AUTH1-IR1 job; mark ad-hoc scripts historical.
7. Verification: full §11 plan.

**Explicitly out of scope:** any AUTH1 A–C code repair, any IR1-F1/F2 mutation-decision, any Phase D/E start. Those remain frozen until their own plan/review cycle.

---

# 13. Plan Freeze Gate

| Condition | Status |
|---|---|
| repeated incidents reconciled | ✅ (H1–H9, one upstream cause) |
| common root cause established | ✅ (§7.2) |
| review lifecycle state machine understood | ✅ (§3, §9.2) |
| owner for every transition established | ✅ (§4, §9.4) |
| artifact taxonomy frozen | ✅ (§5) |
| canonical storage/identity model selected | ✅ (`review-job` + `docs/pi-graph-output/<card>/`) |
| Git/persistence ownership selected | ✅ (writeback gate owns staging/commit) |
| bundle integration selected | ✅ (§9.4) |
| downstream fail-closed gate selected | ✅ (job state = ACCEPTED required) |
| restart/resume behavior selected | ✅ (resumeState, no chat dependency) |
| Docker/subagent handoff contract selected | ✅ (§9.5) |
| migration strategy selected | ✅ (§10) |
| implementation can proceed without unresolved architecture decisions | ✅ (via §12 card, after its own review) |

---

# 14. Verdict

`PASS / REVIEW_ARTIFACT_LIFECYCLE_ROOT_CAUSE_AND_DURABLE_AUTHORITY_MODEL_RECONCILED`

This PASS freezes the problem and the authoritative solution only. Implementation is
**not** authorized until `AUTOLOOP-REVART-IMPL1` is written, independently Spec/Plan
reviewed, and frozen under the normal SOP (§25 of the originating card).

---

# 15. SOP Rule (restated, enforced)

`problem discovery → Plan Mode → root-cause reconstruction → solution alternatives →
solution selection → Plan Review → Plan Freeze → implementation → verification →
independent review → closeout`

A missing review artifact is evidence that this workflow **itself requires mechanical
enforcement** — not another reminder for the Agent. Review is complete only when the
required independent review has a durable identity, authoritative evidence, persisted
artifacts, candidate binding, and a fail-closed path into downstream acceptance.
