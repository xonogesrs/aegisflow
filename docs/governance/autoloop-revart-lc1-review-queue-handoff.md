# REVART-LC1-REVIEW-QUEUE-AUTOMATIC-HANDOFF-REPAIR — Queue Authority & Routing

## Verdict

`PASS / REVIEW_QUEUE_AND_AUTOMATIC_HANDOFF_CONVERGED`

## Problem

The canonical external-review surface（`~/Desktop/AutoLoop-Review/Current/`）
was a **single occupied slot**: the first formal review published; every
subsequent review hit `surface_occupied` and required manual intervention.
The fail-closed no-overwrite invariant was correct; the missing capability
was a pending queue + deterministic Current promotion + a Latest pointer.

## Model（Domains A/B/C）

- **Domain A — Current**（`Current/`）: the review awaiting action now. Exactly
  one occupant; unresolved occupant is immutable except through sanctioned
  verdict/reseal operations; terminal verdict + rotation empties the slot.
- **Domain B — Pending Queue**（`Queue/queue.json`, schema
  `autoloop.review-queue/v1`）: every additional unresolved review. Durable
  across restart, FIFO-ordered（monotonic `order`）, one entry per card
  lineage（supersession replaces in place — an obsolete generation is never
  an independent entry）. Entry = references to immutable artifacts
  （cardId, generation/jobId, bundleIdentity, bundleSha256, bundlePath,
  evidencePath, supersedes, order, timestamps, state
  QUEUED|CURRENT|RESOLVED|ARCHIVED|HOLD）— findings/verdict content stays in
  the delivery record / Archive. Single writer/owner: the queue module,
  always under the surface lock.
- **Domain C — Latest**（`Queue/latest.json`, schema
  `autoloop.review-queue-latest/v1`）: navigation pointer to the NEWEST
  generated review — **never** verdict authority, **never** "what blocks the
  queue". The harness `Latest/review.txt` is Domain A of the execution-review
  lifecycle（separate authority, own lock, rsl2 branch）— this lifecycle uses
  an explicit bridge rather than merging the two authority domains.

## Behavior

- Current empty → publish directly; entry CURRENT; Latest updated.
- Current occupied, same identity → idempotent（one entry only）.
- Current occupied, different card → QUEUED; Latest updated; queued delivery
  is a SUCCESS（never `surface_occupied` failure）.
- Current occupied, sanctioned reseal（supersedes the occupant）→ Current
  updates in place; no queue duplicate.
- Same card, different identity, no supersession → HOLD（fail-closed）.
- Rotate（terminal verdict）→ archive; mark occupant ARCHIVED; auto-promote
  the oldest eligible pending review（bundle bytes copied verbatim — never
  regenerated）.
- Crash recovery: `reconcileReviewQueue` / `--promote` / `--reconcile`
  resume promotion when Current is empty and the queue is non-empty;
  queue corruption fails closed; a Latest failure never loses a review.

## Human routing（mechanically distinct answers）

| Question | Surface | CLI |
|---|---|---|
| "What review needs action now?" | `Current/delivery.json` | `--status` |
| "What other reviews are waiting?" | `Queue/queue.json` | `--queue` |
| "What is the newest formal review?" | `Queue/latest.json` | `--latest` |

## Code

- `src/governance/review-queue.mjs` — queue store（single writer）: schema,
  atomic persist, entry upsert（enqueue/idempotent/superseded/conflict）,
  surface-scoped FIFO selection, Latest pointer.
- `src/governance/review-bundle.mjs` — `deliverToExternalReviewSurface`
  （enqueue/reseal/HOLD/promote-on-rotate）, `rotateExternalReviewSurface`
  （archive + auto-promote）, `promoteNextPendingReview`,
  `reconcileReviewQueue`, `latestReviewPointer`.
- `scripts/gov-external-review-surface.mjs` — `--queue` / `--latest` /
  `--promote` / `--reconcile`; `--status`/`--deliver`/`--rotate` reflect
  queue semantics.
- Tests: `test/governance/test-review-queue-handoff.mjs`（T1–T19）,
  `test-review-queue-handoff-dogfood.mjs`（T20 real two-generation dogfood）;
  pinned single-slot tests updated to the queued contract（surface #8,
  rld2 occupied-different-card, closeout-lifecycle T5）.

## Invariants preserved

- unresolved Current never overwritten; authority digest reproducibility;
  canonical relative outDir; candidate content/range identity;
  committed-before-baseline attribution; reseal baseline inheritance;
  REVIEW_PENDING non-terminal; sole Controller ACCEPTED mint;
  final-closeout eligibility; immutable Archive lineage.

## Known limitation

- The live `~/Desktop/AutoLoop-Review/Current/` currently holds the
  pre-existing stale AUTOLOOP-CBM-LIVE-INTEGRATION-1 trio（AWAITING_EXTERNAL_
  REVIEW, feb69523 — a CBM-flow artifact, not created by this card）. It is
  left untouched; new formal reviews now queue behind it and auto-promote
  once it is resolved/rotated. Environment-bound debt, not a queue defect.
