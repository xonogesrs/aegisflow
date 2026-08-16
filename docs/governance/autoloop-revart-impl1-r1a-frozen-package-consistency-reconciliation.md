# AUTOLOOP-REVART-IMPL1-R1A — Frozen Package Consistency Reconciliation

## Status

`READY_TO_START` → **`RECONCILED`** (this document)

## Type

Narrow Spec/Plan Consistency Repair (READ-ONLY)

## Parent

`AUTOLOOP-REVART-IMPL1-R1`

## Effective Status Before This Card

`REPAIR_REQUIRED / IMPL1_R1_FROZEN_PACKAGE_INTERNAL_INCONSISTENCY`

## Implementation Authorization

**NO.** This card reconciles the frozen package only.

## Scope Note

This document contains ONLY the amended sections of the IMPL1-R1 frozen
package. Where this document conflicts with IMPL1-R1, this document is
authoritative. All non-conflicting IMPL1-R1 sections remain frozen unchanged.

---

# 1. Verdict

```
PASS / IMPL1_R1_FROZEN_PACKAGE_CONSISTENT_AND_READY_TO_FREEZE
```

Two mechanical inconsistencies were repaired. No architecture or authority
decision was changed. No human decision was required.

---

# 2. Finding A Resolution — Single STAGED/ACCEPTED Ordering

Frozen authoritative ordering (adopts IMPL1-R1's own state mapping and
RC1A §4 T6→T8):

```text
PERSISTED → STAGED → ACCEPTED → DOWNSTREAM_AUTHORIZED
```

- `STAGED` is a **prerequisite** to `ACCEPTED`.
- `ACCEPTED` can never exist while artifacts are unstaged.
- Crash recovery seeing `ACCEPTED` implies staging already completed; a crash
  window of the form "post-ACCEPTED pre-stage" is **removed** (it cannot exist).

The IMPL1-R1 crash matrix window 11 ("post-ACCEPTED pre-stage") was an error.
It is deleted and replaced by the corrected windows below.

---

# 3. Finding A — Corrected Crash Matrix (replaces IMPL1-R1 §7 windows 9–14)

Ordering-consistent sequence (findings/verdict persistence is unchanged;
only the staging/acceptance tail is corrected):

| # | Crash window | Durable facts | Detected state | Legal recovery | Primitive | Outcome |
|---|---|---|---|---|---|---|
| 9 | verdict persisted, state not advanced | verdict+digest present, job `VERDICT_PRODUCED` | `PERSISTED` | re-derive `PERSISTED` | re-read+sha256 | RESUME |
| 10 | pre-stage | both artifacts `PERSISTED`, index empty | `PERSISTED` | writeback gate stages exact set | `git add` exact paths | RESUME |
| 11 | partial stage | subset of the two artifacts staged | `PERSISTED` (staging identity mismatch) | re-stage exact set, verify staged identity | `git diff --cached` | RESUME/HOLD |
| 12 | staged | both artifacts staged, identity verified | `STAGED` | (idle — acceptance eligible) | — | RESUME |
| 13 | pre-ACCEPTED | `STAGED`, no acceptance record | `STAGED` | acceptance entrypoint re-runs (exclusive-create) | recompute + `wx` | RESUME |
| 14 | post-ACCEPTED pre-delivery | acceptance record present | `ACCEPTED` | delivery publish idempotent | atomic replace | RESUME |
| 15 | post-delivery pre-integration | delivery published | `DOWNSTREAM_AUTHORIZED` | integration gate re-verifies | recompute | RESUME |

No window implies acceptance before its declared prerequisite (`STAGED`) exists.

---

# 4. Finding B Resolution — Source Inventory == Mutation Set

## 4.1 `src/governance/external-review.mjs` → **MODIFY** (added to mutation set)

Reason (verified against source): `findings_digest` is schema-required
(`EXTERNAL_REVIEW_RESULT_SCHEMA`), but `verifyExternalReviewResult` only
checks `prior_findings_digest` (round > 1); it **never recomputes and verifies
the current findings digest**, and it knows nothing about `jobId`/`generation`/
`specDigest`. IMPL1 §18 mandates findings-digest + generation verification in
the acceptance chain. That gap is closed here.

Exact change:
- extend `verifyExternalReviewResult` (or add `verifyReviewJobAcceptance`
  beside it) to recompute-verify: `findings_digest` (against persisted
  findings bytes), `jobId`, `generation` (monotonic + current), `specDigest`.
- verdict enum stays `PASS|REPAIR|HOLD`.

Affected transition: `STAGED → ACCEPTED` (acceptance recompute).
Tests: findings-digest-mismatch, generation-stale, spec-digest-mismatch.

## 4.2 `scripts/gov-controller-ingest-result.mjs` → **MODIFY** (added to mutation set)

Reason: RC1A §5 defines the acceptance authority as "the controller-operator
acceptance entrypoint (the successor of `gov-controller-ingest-result.mjs`)".
It must now consume the review-job verdict, verify the full chain, and
exclusive-create the **acceptance record** (successor of
`external-review-result.json`), retiring the legacy result path.

Exact change:
- input: review-job verdict + findings (jobId/generation/findingsDigest/
  verdictDigest) instead of raw bundle parse as sole identity source;
- output: acceptance record (exclusive-create) instead of
  `external-review-result.json`;
- keep: controller-only, exclusive-create (`wx`), recompute, self-declare
  rejection, `reviewer_identity`/`authorization_source` second-channel.

Affected transition: `STAGED → ACCEPTED` (the ACCEPTED mint).
Tests: self-grant rejection, no-artifact → no-ACCEPTED, exclusive-create
duplicate rejection.

---

# 5. Corrected Source Inventory (supersedes IMPL1-R1 §3 for these two rows)

| Component | Classification |
|---|---|
| `src/governance/external-review.mjs` | **MODIFY** (extend verification to findingsDigest + jobId/generation/specDigest) |
| `scripts/gov-controller-ingest-result.mjs` | **MODIFY** (becomes acceptance entrypoint; write acceptance record; retire external-review-result.json) |

All other inventory classifications in IMPL1-R1 §3 are unchanged.

---

# 6. Corrected Frozen Mutation Set (adds two files to IMPL1-R1 §5 MODIFY)

```text
MODIFY (additions):
- src/governance/external-review.mjs
  owner: acceptance recompute
  responsibility: extend verifyExternalReviewResult to recompute-verify
    findings_digest + jobId + generation + specDigest (§4.1)
  why: findings_digest is currently schema-required but not recompute-verified

- scripts/gov-controller-ingest-result.mjs
  owner: acceptance authority (controller-operator entrypoint)
  responsibility: ingest review-job verdict + findings; exclusive-create the
    acceptance record (successor of external-review-result.json); retire legacy
    result path (§4.2)
  why: RC1A §5 successor of the acceptance entrypoint
```

All other MODIFY/ADD/RETIRE entries in IMPL1-R1 §5 are unchanged.

---

# 7. Legacy Retirement Enforcement Ownership (closes R1A §9)

| Legacy surface | Enforcing owner | Exact behavior | Test |
|---|---|---|---|
| `scripts/gov-review-bundle.mjs` (11-section) | acceptance chain (sole generator = `gov-closeout-bundle.mjs`) | never consumed for production acceptance | assert no production entrypoint imports it for acceptance |
| `external-review-result.json` | `gov-controller-ingest-result.mjs` (MODIFY) | no longer written; acceptance record replaces it | assert acceptance reads acceptance record, not legacy result |
| `src/schema/reviewer-verdict.schema.json` | `review-verdict.schema.json` (new) + acceptance chain | loose schema never used for authoritative verdict | assert acceptance validates against review-verdict.schema.json |
| per-card `*-independent-review.mjs` / `*-self-closeout.mjs` | acceptance chain | fixtures only; not consumed | assert no production acceptance imports them |

---

# 8. Consistency Matrix (R1A §11)

| Item | Source Inventory | Mutation Set | Lifecycle Owner | Test | Consistent |
|---|---|---|---|---|---|
| STAGED/ACCEPTED ordering | PERSISTED→STAGED→ACCEPTED→DOWNSTREAM_AUTHORIZED | (n/a) | writeback (stage) → acceptance (ACCEPTED) → integration (downstream) | pre-ACCEPTED crash, partial-stage | **YES** |
| `external-review.mjs` | MODIFY | MODIFY (in set) | acceptance recompute (`STAGED→ACCEPTED`) | findings-digest-mismatch | **YES** |
| `gov-controller-ingest-result.mjs` | MODIFY | MODIFY (in set) | ACCEPTED mint (`STAGED→ACCEPTED`) | self-grant/no-artifact | **YES** |
| `review-history.mjs` | EXTEND | MODIFY (in set) | lineage | wrong-round | **YES** |
| `review-bundle.mjs` | EXTEND | MODIFY (in set) | delivery/acceptance surface | stale-delivery | **YES** |
| `gov-closeout-bundle.mjs` | EXTEND | MODIFY (in set) | sole bundle generator | IR-artifact enumeration | **YES** |
| `gov-review-bundle.mjs` | RETIRED | RETIRE (in set) | not consumed | legacy-bypass | **YES** |
| `reviewer-verdict.schema.json` | INTERNAL_ONLY | RETIRE (in set) | never authoritative | loose-schema-rejected | **YES** |

`files classified MODIFY/EXTEND == files in MODIFY set`: **TRUE**.
`files classified REUSE_AS_IS ∩ mutation set == empty`: **TRUE** (verified —
fs-atomic, run-evidence-store, change-inventory, review-context, closeout-state,
integration-commit-gate, lifecycle-state, lifecycle-authorization,
gov-controller-prepare-round, gov-external-review-surface are all REUSE_AS_IS
and absent from the mutation set).

---

# 9. Acceptance Criteria (R1A §13)

1. exactly one STAGED/ACCEPTED ordering — **YES** (§2)
2. crash matrix follows that ordering — **YES** (§3)
3. every EXTEND/MODIFY component in mutation set — **YES** (§6, §8)
4. every REUSE_AS_IS component outside mutation set — **YES** (§8)
5. every legacy retirement has an enforcing owner — **YES** (§7)
6. tests cover corrected seams — **YES** (§4, §7)
7. no IMPL1 scope expansion — **YES** (only the two files added; both already
   in RC1A §5/§7 frozen authority)
8. no source mutation occurred — **YES** (read-only)
9. no user policy decision invented — **YES** (mechanical, within frozen rules)

---

# 10. Final Verdict

```
PASS / IMPL1_R1_FROZEN_PACKAGE_CONSISTENT_AND_READY_TO_FREEZE
```

---

# 11. Next Step

```text
Freeze corrected implementation authorization package
→ verify bound HEAD / candidate identity unchanged
→ issue explicit implementation authorization
→ begin IMPL1 source mutation (only the frozen mutation set)
```

No additional broad architecture review is required.
