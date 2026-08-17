# REVIEW-SERIES-INVENTORY-AND-CURRENT-DELIVERY-RECONCILIATION-1

Card: full inventory of every review-series card / source / test that touches
`TASK_COMPLETED → REVIEW_GENERATED → CURRENT`, classification of every R0
conflict, and the reconciliation performed so that

```text
Current/ = latest generated formal review artifact
```

with no verdict / queue / rotation / promotion / previous-review-resolution
gate on publication.

Repo: `/private/tmp/autoloop` (canonical-autoloop checkout), branch
`governance/decomp-opt1-design-freeze`, HEAD `e55da27` + this card's repair.

---

## A. R0 (frozen, non-negotiable)

```text
R0_REVIEW_DELIVERY:
1. review-required task completes → generate its review
2. remove/replace the previous Current artifact
3. publish the new review into Current immediately
```

Acceptance question: after the latest review-required task completes, is
Current that task's own review? Anything else (Queue / unresolved-review /
governance rules) is FAIL.

---

## B. REVIEW-SERIES CARD INVENTORY

Every card in the series that affects review delivery, with its landing
commit, purpose, source/tests touched, invariants introduced, and R0
classification.

### Recent series (affect the R0 path)

| CARD / COMMIT | PURPOSE | SOURCE_CHANGED | TESTS_ADDED | INVARIANTS_INTRODUCED | AFFECTS_R0 | R0_CLASSIFICATION |
|---|---|---|---|---|---|---|
| REVART-LC1-B1 `665070b` (08-16) | admission-driven review lifecycle: review-required admission binding, runAdmittedGraph | admission-gate.mjs, policy-projection.mjs, closeout-state.mjs, lifecycle-authorization.mjs, review-lifecycle.mjs, lifecycle-authorization.schema.json | test-review-closeout-binding, review-lifecycle-fixture, test-lifecycle-authorization, test-review-lifecycle | review-required tasks MUST route through the governed lifecycle; closeout not required → never forced to bundle | YES (task-completion → review trigger) | KEEP |
| REVART-LC1-B2 `421739a` (08-16) | review-job materialization + controller ingest convergence | review-job.mjs, review-lifecycle.mjs, control-plane/coordinator.mjs, admission-gate.mjs, review-job.schema.json | test-review-job-convergence, test-review-required-coordinator, test-review-lifecycle, test-v3-gov-scripts | ACCEPTED review-job = the sole acceptance mint | YES (generation authority) | KEEP |
| REVART-LC1 dogfood `d36d016` (08-16) | live dogfood closeout evidence | evidence only | — | — | NO | KEEP |
| AUTOLOOP-CBM-LIVE-INTEGRATION-1 `251d9ae` (08-16) | harness memory CBM live integration | admission-gate.mjs, scripts/autoloop-memory-query.mjs | test-cbm-live-query-cli, test-admission-memory-provider | memory retrieval is a read path, never a review gate | NO | KEEP |
| CBM dogfood `48b479d` / reseal `2e8a093` / external PASS `faa4e26` (08-16) | CBM dogfood evidence; surface-reseal generation; external review PASS | evidence + closeout-state; reseal introduced supersession-of-generation | — | surface-reseal = new generation superseding, keeps original baseline | NO (delivery untouched) | KEEP |
| REVART-LC1-CANDIDATE-PROVENANCE-AND-ACCEPTANCE-ORDERING-REPAIR `baa987e` (08-16) | candidate provenance model v2; final closeout gate reads the AUTHORITATIVE external-review record; REMOVE CALLER AUTHORITY | review-bundle.mjs, review-job-context.mjs, closeout-state.mjs, external-review.mjs, change-inventory.mjs, lifecycle-authorization.mjs, review-artifact-gate.mjs, feature-branch-push-gate.mjs, review-job.mjs, review-lifecycle.mjs, gov-controller-ingest-result.mjs | test-candidate-provenance-repair | final closeout requires bound PASS from the authoritative record; caller-supplied review data can never mint acceptance | YES (verdict source of truth) | REINTERPRET — the authoritative record moved surface-first (this card) → ledger-first (e55da27); the gate itself stays |
| CBM chain migration `c031395` + final closeout `16987af` (08-16) | CBM ledger chain migration; descriptive closeout block reconciled from the authoritative record | closeout-state.json evidence | — | descriptive closeout block is evidence, never authority | NO | KEEP |
| REVART-LC1-REVIEW-QUEUE-AUTOMATIC-HANDOFF-REPAIR `2aca99e` (08-17 00:12) | review queue + automatic Current handoff: QUEUED/CURRENT states, single-slot queue-front model | review-queue.mjs, review-bundle.mjs, gov-external-review-surface.mjs | test-review-queue-handoff(+dogfood), test-closeout-lifecycle, test-external-review-surface, test-rld2-stale-delivery | Current occupied + different card → QUEUED behind occupant (occupancy gate!) | YES — CONFLICTS with R0 (occupancy gate: "different-card delivery → QUEUED only") | REMOVE (gate) / KEEP (durable ledger) — the occupancy gate is gone since e55da27; the durable queue + surface-scoped entries remain |
| REVIEW-LATEST-HUMAN-HANDOFF-1 `a8abdbf` (08-17 06:56) | Latest Human Report decoupled from Current | human-report.mjs, review-bundle.mjs, gov-external-review-surface.mjs | test-human-report-handoff | LatestHuman = newest generated report, independent of review scheduling | NO (supporting) | KEEP |
| REVIEW-BUNDLE-REVIEW-SECTION-CONVERGENCE-1 `7f94496` (08-17 17:28) | review bundle converges into a single External Review Decision section | review-bundle.mjs, closeout-state.mjs | test-review-bundle.mjs, test-review-bundle-decision-section, test-review-bundle-closeout-enforcement, test-external-review-delivery, test-graph-closeout | bundle format converges on one decision section | NO | KEEP |
| EXTERNAL-REVIEW-VERDICT-HANDOFF-1 `e68a382` (08-17 17:47) | external verdict handoff with AUTOMATIC CURRENT ADVANCEMENT | external-verdict-ingest.mjs, review-bundle.mjs, gov-closeout-bundle.mjs | test-external-verdict-ingest | verdict drives Current advancement (verdict → presentation gate!) | YES — CONFLICTS with R0 (verdict/promotion gating presentation) | REPAIR — reinterpreted by e55da27: verdicts bind the durable ledger only, never the presentation pointer |
| DECOMP-OPT1-PC1 `8a16cb4` (08-17 18:29) | parent→child context & evidence inheritance (PC1) | v2/decomposition-inheritance.mjs, memory/inheritance-cbm.mjs, v2/durable-execution.mjs, v2/execution-orchestrator.mjs, v2/harness-evidence.mjs, v2/review-evidence.mjs, v2/system-delta.mjs, lifecycle-runner.mjs, colima-graph-runner.mjs | test/v2/test-decomposition-inheritance.mjs | inheritance manifest deterministic; CBM-first retrieval is read-only | NO (feature card) | KEEP — its closeout is the latest review-required completed task (card K) |
| CURRENT-LATEST-REVIEW-PRESENTATION-SEMANTICS-1 `e55da27` (08-17 19:15) | THE semantic reconciliation: Current = latest completed formal review; publish-always; verdicts never control presentation; ledger states PENDING/REVIEWED/REPAIR/HOLD/ARCHIVED; independent isLatestPresented pointer; deterministic legacy-state migration | review-bundle.mjs, review-queue.mjs, external-verdict-ingest.mjs, gov-external-review-surface.mjs | test-current-latest-presentation-semantics.mjs (+ re-based existing suites) | Current/ is a PRESENTATION slot, never a review-authority lock; publication ordering = monotonic completion order; stale replay never regresses Current | YES — R0-ALIGNED base | KEEP |
| THIS CARD (REVIEW-SERIES-INVENTORY-AND-CURRENT-DELIVERY-RECONCILIATION-1, uncommitted) | inventory + reconciliation + verification: removed stale occupancy comments, per-surface lock, queue single-writer lock, fixed 8 stale/path-drift tests, live A/B/C dogfood | review-bundle.mjs (lock path, staging cleanup, comments), review-queue.mjs (queue lock), external-verdict-ingest.mjs (queue lock), gov-external-review-surface.mjs (stale output) | test-candidate-provenance-repair.mjs (T15/T16/T18 → ledger-verdict semantics), test-external-review-surface.mjs (lock path), test-verification-scope-guard/test-verification-timing/test-vca1-phase0b-enforcement/test-git-status-parsing (location-independent) | per-surface presentation lock; queue file single-writer lock (surface → queue order, no deadlock) | YES | REPAIR (this card) |

### Older foundation (context, non-conflicting)

| CARD / COMMIT | PURPOSE | R0_CLASSIFICATION |
|---|---|---|
| mandatory review artifact routing `6857186` / `7cde0ba` (08-16) | a review-required task MUST route its review artifact | KEEP (R0-required: review generation is mandatory) |
| TC1 successor generation + terminal review ordering `a06124c` (08-16) | successor generation + terminal ordering foundation | KEEP |
| RB2/RB2R1/RB2R2 closeout enforcement `fa93f3e` (08-16) | mandatory review-bundle closeout enforcement | KEEP |
| RB-1H atomic-publication / surface lock (`rb1h`, 08-07) | atomic trio publication (staging + rename), surface lock | KEEP (atomicity is R0-required) — occupancy fail-closed PART REMOVED |
| RLD2 stale-delivery root cause + currentReviewDelivery selector (08-09) | identity-verified delivery selector, fail-closed NO_NEW_REVIEW_BUNDLE / STALE_* codes | KEEP (read-side selector; never gates presentation) |
| R-R3-RB1 canonical bundle path `ecb8b78` | canonical review-bundle path reconciliation | KEEP |
| Phase R protocol `3ab1ebf` / authority+execution truth invariants `d91e2b5` / CP-1 `d1a3363`+`4958739` / RB-SSG4+RR1 `56bb281` / DECOMP-OPT1 freeze `fe07244` | governance protocol + design freeze | KEEP (non-delivery governance) |

---

## C. SOURCE / TEST INVENTORY (Current publication path)

### Sources that can affect what Current/ displays

| Source | Role | R0-relevant behavior |
|---|---|---|
| `src/governance/review-bundle.mjs` | publication + ledger + final gate | `deliverToExternalReviewSurface` — fresh completion ALWAYS publishes (atomic staging → ONE directory rename; overwrites occupant); identical generation idempotent; OLDER completion replay → ledger durable, presentation NOT regressed (N4). `publishTrioToSurface` — atomic trio. `rotateExternalReviewSurface` — verdict binds the LEDGER + archives; Current files untouched. `promoteNextPendingReview(Locked)` / `reconcileReviewQueue` — presentation RECOVERY to the newest eligible (crash repair), never an older review. `verifyExternalReviewSurface` — trio identity+sha+record verification. `currentReviewDelivery` — ledger-first authoritative selector. `resolveAuthoritativeExternalReviewRecord` — ledger-first record (surface fallback for legacy). `assertFinalCardCloseout` — final acceptance gate (bundle verified + PASS verdict bound with independent reviewer). `externalReviewSurfaceLockPath`/`acquireExternalReviewSurfaceLock`/`releaseExternalReviewSurfaceLock` — per-surface presentation lock. `acquireQueueLock`/`releaseQueueLock` — queue single-writer (shared across surfaces of a root). |
| `src/governance/review-queue.mjs` | durable review ledger | `readReviewQueue`/`writeReviewQueue` (tmp+rename atomic), `upsertQueueEntry` (supersession), `migrateReviewQueue` (QUEUED/CURRENT→PENDING, RESOLVED→ARCHIVED), `markPresented` (presentation pointer — the ONLY presentation fact), `reviewQueueLockPath`/`acquireQueueLock`/`releaseQueueLock` (single-writer, bounded spin), `writeLatestPointer` (navigation only). |
| `src/governance/external-verdict-ingest.mjs` | verdict ingress | `ingestExternalVerdict` — exact ledger lookup (cardId+identity+sha), verdict → ledger entry (identity-bound); PASS archives; Current untouched; idempotent resume. |
| `src/governance/human-report.mjs` | LatestHuman surface | newest generated report, decoupled from Current. |
| `scripts/gov-external-review-surface.mjs` | CLI | `--deliver` (publish-always), `--rotate` (verdict → ledger + archive; Current untouched), `--promote`/`--reconcile` (recovery), `--migrate` (deterministic legacy migration), `--queue`/`--latest`/`--status` (read-only). |

### Searched semantic patterns (card C)

```text
Current / CURRENT / QUEUED / surface occupied / unresolved / rotate /
promote / deliverToExternalReviewSurface / latest review / review bundle
delivery
```

Equivalents of:

```text
if Current occupied → do not replace Current
previous review must be resolved before new review becomes Current
```

were located and REMOVED (see D). Live-source grep result:
`surface_occupied` count in `src/governance/` = **0**. The only
occupancy-adjacent logic remaining is stale-replay (older ORDER never
regresses) and idempotent (same generation) — both R0-compliant: they
preserve the newest publication and never block a fresh one.

### Tests covering Current publication

| Test | Coverage |
|---|---|
| `test/governance/test-current-latest-presentation-semantics.mjs` | R0 acceptance: A→Current A, B→Current B while A PENDING, C→Current C while A/B PENDING, verdicts never change Current, reseal, idempotent, stale replay, atomicity, crash recovery, migration, single ACCEPTED mint (T1–T20) |
| `test/governance/test-external-review-surface.mjs` | atomic trio publication, stale lock break, live lock block, crash residue cleanup, per-surface lock path |
| `test/governance/test-external-verdict-ingest.mjs` | ledger-bound verdict; Current unchanged; idempotent; conflicting verdict fail-closed |
| `test/governance/test-review-queue-handoff.mjs` (+dogfood) | ledger ordering, PENDING durability, supersession |
| `test/governance/test-closeout-lifecycle.mjs` | closeout→bundle→delivery; second card publishes over unresolved first (T5) |
| `test/governance/test-review-lifecycle.mjs` | admission→closeout; delivery failure → AWAITING_BUNDLE_DELIVERY; resume same identity |
| `test/governance/test-candidate-provenance-repair.mjs` | final closeout gate reads the ledger PASS (T15/T16/T18 re-based to ledger-verdict semantics THIS card) |
| `test/governance/test-rld2-stale-delivery.mjs` | stale generation never re-selected |
| `test/governance/test-human-report-handoff.mjs` | LatestHuman decoupled from Current |
| `test/governance/test-verification-scope-guard.mjs` / `test-verification-timing.mjs` / `test-vca1-phase0b-enforcement.mjs` / `test-git-status-parsing.mjs` | location-independent after repo relocation (fixed THIS card) |

---

## D. CONFLICT CLASSIFICATION

Every rule that ever caused `Task B completed → Review B generated → Current
still shows A`:

| Gate (introduced by) | Old behavior | R0 conflict | Disposition |
|---|---|---|---|
| occupancy fail-closed `surface_occupied` (RB-1H) | delivery REFUSED when Current held any non-dot entry | YES — unresolved Current cannot be overwritten | REMOVED: publish-always (e55da27); stale comments removed + `surface_occupied` = 0 in live source (this card) |
| queue-front handoff (REVART-LC1-QUEUE `2aca99e`) | different card while occupied → QUEUED only | YES — different-card delivery → QUEUED only | REMOVED: fresh completion publishes regardless of occupant (e55da27) |
| verdict-driven Current advancement (EXTERNAL-REVIEW-VERDICT-HANDOFF-1 `e68a382`) | PASS/REPAIR/HOLD advanced the presentation | YES — verdict required before new review becomes Current | REINTERPRETED: verdicts bind the durable ledger entry only; presentation pointer independent (e55da27); rotate/ingest never touch Current |
| PASS-before-rotate / rotation as presentation path (RB-1H era) | rotate cleared Current and promoted next pending | YES — PASS required before rotate; rotation dependency | REMOVED: rotate = verdict archive only, Current untouched; promote = recovery to newest eligible, never a gate |
| previous-review-resolution requirement | unresolved occupant blocked the next publication | YES — previous review must be resolved before new review becomes Current | REMOVED: no resolution requirement anywhere in the publication path |
| `currentReviewDelivery` STALE_GENERATION_ALREADY_REVIEWED (RLD2) | already-reviewed generation never re-delivered as NEW | NO — read-side selector for delivery decisions, not a presentation gate | KEEP (data-governance function retained; never controls Current presentation) |

Data-governance functions that remain but are DECOUPLED from Current
presentation (card F): Queue/ledger (durable pending/verdict history),
Archive (reviewed bundles), LatestHuman (human-facing latest report),
verdict ledger (PASS/REPAIR/HOLD receipts). None can block Current
replacement.

---

## E–I. DESIGN + FAILURE SAFETY (verified, not re-designed)

- **Current semantics**: `Current/` = latest generated formal review artifact
  (bundle + delivery.json + evidence.json trio).
- **Publication**: generate bundle → atomic replace (invisible staging dir →
  ONE directory rename; old Current removed in the same step). No
  half-written state observable.
- **I1 generation failure**: invalid bundle → delivery refused
  (`deliver_blocked`), existing Current untouched (fail closed).
- **I2 publication crash**: staging is invisible; `--promote`/`--reconcile`
  re-publish the newest eligible from the immutable ledger artifact
  (idempotent); queue+surface locks + stale-owner recovery.
- **I3 stale replay**: ordering is deterministic by monotonic completion
  order; a late replay of an older completion never regresses Current
  (verified live in the dogfood: PC1 order-9 replay after C order-12 was
  correctly refused).

## N. PROCESS FINDING

```text
ROOT_CAUSE:
Simple review-delivery requirement was over-engineered into review lifecycle
governance. The single-slot Current surface accumulated occupancy gates,
queue-front handoff, verdict-driven advancement, rotation/promotion
prerequisites — each locally "reasonable", collectively blocking
TASK_COMPLETED → REVIEW_GENERATED → CURRENT.

OVER_ENGINEERING = YES
OVER_DECOMPOSITION = YES
LOCAL_INVARIANT_OVERRULED_REQUIREMENT = YES
DUPLICATE_REPAIR_CARDS = YES
```

New process rule (frozen):

```text
For simple requirements, freeze the shortest observable success path first.
Supporting governance may not add prerequisites to that path unless
explicitly required.
```

STOP: no further review-series decomposition cards.
