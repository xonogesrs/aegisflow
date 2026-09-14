# AUTOLOOP — RSL3 SURFACE ROTATION LIFECYCLE CLOSEOUT

Status: `PASS / RSL3_SURFACE_ROTATION_LIFECYCLE_CLOSED`
Established: 2026-08-22
Branch: `governance/rsl2-universal-execution-review-surface`
HEAD before: `eb2fac147821569dcfbbd177f304eb794de831ea` (unchanged — `COMMIT = NO`)
Method: 6 parallel read-only discovery tracks (canonical contract / state machine /
implementation surface / adversarial / durability-crash / evidence map) → primary
reconciliation → minimal repair → focused direct suite → broad regression →
independent adversarial gate.
This record is additive; it rewrites no historical document.

## 1. Canonical contract

RSL3's sole normative definition is the RSL2 closeout NEXT_ACTION (restated in
`docs/pi-graph-output/autoloop-rsl2-handoff-repair-closeout/
card-closeout-bundle-20260816-c0ef49d9.txt` §9):

> Real End-to-End Review Surface Lifecycle Acceptance: PGMA1 stays pending in
> the inbox while Task A -> Latest A, Task B -> A archived + Latest B,
> Task C HOLD -> B archived + Latest C; fail-closed on missing/invalid/
> unpublished reviews.

Inherited invariants: RSL2 matrix R2-01..R2-13 (byte-identical immutable
archive, single-owner lock, atomic staged publication, generation binding,
admission-derived requirement, barrier fail-closed). Domain A/B authority
table per `AGENTS.md` AUTHORITATIVE_SOURCE_FIRST: a pending inbox occupant
never blocks the Latest execution review, and vice versa.

## 2. Adversarial findings repaired this card

Discovery-phase hostile audit of `src/governance/execution-review.mjs` found
two credible bypasses; both repaired fail-closed and re-proven:

1. **Lock-takeover TOCTOU (`acquireLatestReviewLock`).** The old dead-pid
   recovery did an unconditional `rmSync` + recreate: two processes that both
   observed a dead owner could race, the loser deleting the winner's LIVE
   lock — dual ownership of every subsequent mutation. Repaired: takeover is
   serialized by a `.latest.lock.recover` claim marker (wx-create), and the
   stale lock is removed only after re-validating it still holds the EXACT
   dead-owner bytes; unreadable locks and live owners remain fail-closed busy.
2. **Stale-writer regression (no generation fence on rotation).** A delayed
   retry of an already-superseded execution fell past the same-execution
   idempotency check, archived the NEWER current review, and renamed the OLD
   review back onto Latest — silent regression of the human entrypoint.
   Repaired twice over:
   - **Stale-generation fence** — before any mutation, an incoming identity
     already present in the archive is rejected
     (`EXECUTION_REVIEW_STALE_ROTATION`).
   - **Commit-time continuity fence** — between staging write and rename, the
     surface must still be exactly the predecessor that was archived, else
     abort (`EXECUTION_REVIEW_SURFACE_CHANGED`) with no lost update even if a
     thief ever slipped past the lock.

Adjudicated NOT credible (established RSL2 authority separation):
hand-forged/manual-injected `review.txt` passes self-consistent verification
but confers zero formal authority (oracle ignores the surface — bypass-fence
A9); CLI `--publish` writes a human-facing projection only; revocation is
deliberately NOT consulted by the surface module — invalidation authority
stays solely with the truth-revocation store integrated through the PASS
oracle (adding a revocation check here would create a second revocation
engine).

## 2b. Independent adversarial gate (Phase 19) — found, repaired, re-verified

The Phase-19 hostile reviewer confirmed the lock/claim protocol, fence
ordering, crash replay, retry dedup, and seam rejection sound (no dual-owner,
stale-winner, or lost-update interleaving constructible through the APIs)
and found TWO credible bypasses, both rooted in rendered field values being
parsed back as authority without newline sanitation:

- **B1 — newline injection poisons the stale-fence identity set.** A field
  value containing `\nREVIEW_PUBLICATION_IDENTITY: <64hex>` forged body lines
  that `archivedIdentities` ingested once rotated, permanently banning a
  predictable victim execution (`STALE_ROTATION`) while attacker content
  stayed current. REPAIRED: every rendered scalar is control-char sanitized
  (`cell()` strips `\u0000-\u001f\u007f\u2028\u2029`), and footer parsing
  (`parseExecutionReviewText`, and therefore the fence scan) takes the LAST
  match — the trusted post-terminator footer region.
- **B2 — idempotent short-circuit trusted parsed surface bytes.** A poisoned
  surface claiming a predicted successor's executionId/identity could be
  "confirmed" as an idempotent hit without the legitimate review ever being
  written. REPAIRED: the short-circuit additionally requires
  `executionReviewContentSha256(current) === claimed sha`; self-inconsistent
  forgeries fall through and are overwritten by the legitimate publication.

Direct proofs: L12 (injection neutralized; exactly one identity line; chain
continues) and L13 (forged current not accepted as idempotent; legit bytes
land; verify clean). Gate re-verification verdict:
`REPAIRED_VERIFIED = YES`; remaining credible bypasses through
publishExecutionReview inputs: **0**.

Documented residuals (bounded, fail-closed or out-of-model): corrupt claim
marker can stall dead-lock takeover until manual removal (availability only);
pid reuse delays takeover; archive `.tmp-*` leak; identity excludes narrative
fields by spec design (a full-field predictor could pre-publish with chosen
narrative while true header facts are kept — closing requires an identity-
spec change, explicitly out of scope).

## 3. Requirements matrix (final)

`RSL3_REQUIREMENTS_TOTAL = 11` — all `PROVEN` or `OUT_OF_SCOPE`; none PARTIAL/MISSING.

| ID | Requirement | Canonical source | Implementation seam | Direct proof | Status |
|---|---|---|---|---|---|
| R3-01 | End-to-end chain: A -> Latest A; B -> A archived + Latest B; C HOLD -> B archived + Latest C; ordered byte-identical archive history | RSL2 NEXT_ACTION §9 | publishExecutionReview + archivePreviousLatest | L1 | PROVEN |
| R3-02 | Domain independence: PGMA1 inbox byte-untouched across all rotations; occupant recorded honestly in each publication record | AGENTS.md + Domain authority table | read-only currentSurfaceReviewStatus consumption | L2 (+ predecessor T6/T14) | PROVEN |
| R3-03 | Stale/wrong-generation rejected: superseded review can never republish onto Latest | G2/G6 + RSL2 R2-12 | stale-generation fence; verifyLatestExecutionReview expected-binding | L3 + bypass-fence G1/G2/G3b/G4 | PROVEN |
| R3-04 | Same-execution retry idempotent inside a chain (no duplicate records/side effects) | RSL2 R2-06 lineage | idempotency short-circuit | L4 | PROVEN |
| R3-05 | Barrier fail-closed on missing/invalid/unpublished required review; previous valid Latest never destroyed | canonical NEXT_ACTION fail-closed clause | applyExecutionReviewBarrier + publisher hold codes | L5 (+ T8/T9/T10) | PROVEN |
| R3-06 | Concurrent rotation fail-closed: no lost update, no dual-current, no identity regression | card Phase 7 C1/C2/C5 | single-owner lock + commit-time continuity fence | L6 (6-process stress) | PROVEN |
| R3-07 | Lock safety: live lock never destroyed by contenders; dead lock recovered exactly once; corrupt lock fails closed | card Phase 6 G5 + finding E1 | acquireLatestReviewLock claim-marker protocol | L7/L8 | PROVEN |
| R3-08 | Crash-point matrix deterministic: every mutation boundary recovers on fresh process without dual authority or data loss | card Phases 9-10 | copy-before-replace ordering + staging sweep + skip-if-exists | L9 (+ T13) | PROVEN |
| R3-09 | Path adversarial: traversal sanitized, symlink targets never written through, entries stay inside archive | card Phase 15 | sanitizeName + skip-if-exists + rename-over-link semantics | L10 | PROVEN |
| R3-10 | Revocation single owner: revoked truth leaves surface as retained history; successor judged on own evidence; rotation module contains zero revocation logic | card Phase 11 + RSL2 R2-13 | truth-revocation store via PASS oracle only | L11 + test-truth-revocation 29/29 + test-pass-oracle 30/30 | PROVEN |
| R3-11 | Retention/cleanup of old archives | not defined canonically; archive is flat/immutable/unbounded BY DESIGN | none exists; none added | — | OUT_OF_SCOPE |

## 4. Surface lifecycle state machine (Domain A)

```
EMPTY --publish--> CURRENT(n)
CURRENT(n) --publish(m!=n)--> ARCHIVED(n) + CURRENT(m)   [rotation]
CURRENT(n) --publish(same n)--> CURRENT(n)               [idempotent]
ARCHIVED --> (terminal; reactivation blocked by STALE_ROTATION fence)
All mutations require the single-owner .latest.lock; takeover of a dead
owner's lock is claim-serialized; unreadable lock = permanent fail-closed
busy (manual intervention, by design).
CURRENT_INVALID arises only from external tampering; every reader
(status/verify/oracle path) recomputes and fails closed.
ROTATING (staging/.tmp artifacts) is invisible to all readers by
construction (staging lives in the parent; readers touch only review.txt).
```

`SURFACE_LIFECYCLE_SINGLE_SOURCE_OF_TRUTH = YES` — durable authority is the
Latest surface file + its content-hash footer; archive is retained history;
no projection is treated as authority.

## 5. Regression evidence (2026-08-22)

Focused:

- NEW `test/governance/test-execution-review-rotation-lifecycle.mjs` 13/13
  (L1-L11 canonical lifecycle + L12/L13 adversarial-gate repair proofs)
- `test/governance` full lane **532/532** (final run, post-gate repairs),
  including the RSL2 bypass-fence suite B1/B2/C1/G/A9 →
  `RSL2_BYPASS_FENCE_REGRESSION = PASS`
- admission + control-plane + budget lanes 283/285

Broad (failures classified against live evidence, not inherited):

| Lane | Result | Classification |
|---|---|---|
| v2 | 465/468 | 3 PRE_EXISTING ENVIRONMENTAL — identical ColimaRuntimeError docker-socket class reproduced live this run |
| memory+telemetry | 265/266 | 1 PRE_EXISTING ENVIRONMENTAL (same socket class, error shown live) |
| root-level | not rerun | ZERO import exposure to `execution-review.mjs` (grep-verified); known failures are the same environmental class freshly reproduced in v2/memtel |

`NEW_REGRESSIONS = 0`. `VENDOR_INSTALL_DRIFT`: 2 (~/.pi installed-copy
integrity vs repo — deployment step, non-blocking, unchanged since RSL2).

Known residual (documented, bounded): orphan `.tmp-*` files in the archive
from a crash mid-archive-copy are never garbage-collected (benign leak,
never readable as a review); cross-day replay of a pre-publish crash would
duplicate an archive row under a new date prefix (now additionally prevented
for already-superseded identities by the stale fence); pid reuse can delay
dead-lock takeover until the recycled pid exits (fail-closed busy, not
corruption).

## 6. Files changed by this card

- `src/governance/execution-review.mjs` — two new hold codes; claim-marker
  lock takeover; stale-generation fence; commit-time continuity fence;
  `archivedIdentities()` helper; adversarial-gate repairs: renderer
  control-char sanitation (`cell()`), footer-trusting parser, sha-consistent
  idempotent short-circuit
- `test/governance/test-execution-review-rotation-lifecycle.mjs` — NEW
  13-test acceptance/adversarial suite
- `docs/governance/autoloop-rsl3-surface-rotation-lifecycle-closeout.md` —
  this record

User dirty changes and RSL2-attributable uncommitted changes untouched
(attribution manifest held separately).

## 7. Commit disposition

No standing auto-commit authority (`COMMIT = NO`). Worktree preserved.

## 8. Verdict

`VERDICT = PASS / RSL3_SURFACE_ROTATION_LIFECYCLE_CLOSED`
`RSL3 = CLOSED`
`NEXT_CANONICAL_TASK = per program direction; open environmental items:
colima autoloop-graph docker socket restoration, ~/.pi vendor redeployment.`

`ADVERSARIAL_REVIEW = PASS (REPAIRED_VERIFIED = YES)`
`CREDIBLE_BYPASSES_FOUND = 2` (B1 newline-injection fence poisoning,
B2 forged-surface idempotent spoof — both repaired and re-verified)
`CREDIBLE_BYPASSES_REPAIRED = 2`
`REMAINING_CREDIBLE_BYPASSES = 0`
`NEW_REGRESSIONS = 0`
`COMMIT = NO`
