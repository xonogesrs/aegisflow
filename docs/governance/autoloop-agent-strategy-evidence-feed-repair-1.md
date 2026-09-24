# AUTOLOOP AGENT-STRATEGY EVIDENCE FEED REPAIR — IMPLEMENTATION RECORD

Card: `AUTOLOOP_AGENT_STRATEGY_EVIDENCE_FEED_REPAIR_1`
Date: 2026-09-24
Baseline HEAD: `bde34fb`
Predecessors:
- `AUTOLOOP_AGENT_STRATEGY_EVOLUTION_PRODUCTION_ACTIVATION_1` (measured `REPAIR_REQUIRED`)
- `AUTOLOOP_AGENT_STRATEGY_EVOLUTION_COMPLETION_1` (attribution / strategy memory /
  fitness / cross-agent transfer)
- `AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_WIRING_REPAIR_1` (production consumer)

Method: move the attribution boundary in the EXISTING production post-result
path. No second loop, no second scheduler, no second memory, no second fitness
engine.

---

## The defect (measured, not hypothesised)

`consumeEvolutionObservationForProduction` returned `NO_QUALIFIED_TRIGGER`
**before** any attribution ran, and the attribution + strategy-memory write
lived inside `scheduleCycle` — i.e. strictly downstream of

```
NO_QUALIFIED_TRIGGER → POLICY_UNAVAILABLE → GATED → SINGLEFLIGHT → SCHEDULE_FAILED
```

Consequence: only runs that crossed a signal threshold AND won a scheduling
slot were ever attributed. The strategy memory therefore held a pure
**deficient-run sample**:

- a healthy run (`PASS`, no repairs) could never appear in the memory;
- the baseline (incumbent-strategy) arm could never reach
  `MIN_SAMPLES_FOR_SUFFICIENCY` for a healthy deployment;
- `evaluateStrategyFitness` was structurally unreachable outside tests, because
  a genuine baseline-vs-candidate comparison needs both arms from real runs.

That is a selection bias in the learning input, not a wiring gap.

---

## Section-by-section landing

| § | Requirement | Landing | Evidence |
|---|---|---|---|
| A | move the attribution boundary | `src/evolution/attribution-feed.mjs` (NEW) — the every-run feed. Order is now `terminal result → durable evidence (ONE read) → strategy attribution → performance-memory write → trigger evaluation → optional cycle scheduling`, wired in `src/admission/admission-gate.mjs` (feed runs BEFORE `observeRunForEvolutionTriggers`/`consumeEvolutionObservationForProduction`). `scheduleCycle` no longer writes memory at all. | F1, F6 |
| B | every-run eligibility + explicit exclusions | `STRATEGY_FEED_DISPOSITIONS` (closed set): `RECORDED`, `EXISTING`, `DISABLED`, `SUSPENDED`, `NO_DURABLE_EVIDENCE`, `EMPTY_EVIDENCE`, `SYNTHETIC_RECORD`, `NOT_AGENT_RUN`, `NO_ATTRIBUTION_IDENTITY`, `OBSERVATION_REJECTED`, `FEED_FAILED`. Every exclusion names a reason; nothing is fabricated, nothing dropped silently. | F2 |
| C | attribution integrity | `attribution_identity` projection on each stored observation (run id, agent phase/stage identity, parent/graph relation, provider/model/adapter, task class, decomposition identity, terminal outcome + hold code, generation) plus the existing scalars (repair, retry, latency, occupancy, fan-out) and the dimension values. Secret-free by construction: the source attribution copies only bounded identifiers/digests/enums/numbers; no prompt text, no credential, no free text. | F1 |
| D | dedup / idempotency | `strategyObservationId` now binds the **authoritative run** (`execution_id` ‖ `graph_run_id`), not the attribution content digest — so resume (which appends journal rows and changes the digest) cannot mint a second sample. The memory boundary refuses a same-identity/different-content record as an identity conflict. | F3, F4, F6 |
| E | healthy-arm proof | 3 healthy production runs → healthy arm `sample_count = 3`, `evidence_sufficient = true`. A FOURTH, deficient yet non-firing run (1 repair, HOLD, carrying a credential-shaped value in its journal) is recorded on the same arm too — the `success_rate` / `hold_rate` move to 0.75 / 0.25 — and neither the memory nor the feed log contains the credential. | F1, F5 |
| F | fitness reachability | baseline (incumbent) arm and candidate arm both written by real production runs; `EVIDENCE_SUFFICIENT = YES`; candidate derivation → `evaluateStrategyFitness` → `decision = ACCEPT`. No memory fixture is written anywhere in the proof. | F5 |
| G | trigger independence | healthy non-firing run ⇒ `RECORDED` + `NO_QUALIFIED_TRIGGER` (no cycle); qualified deficient run ⇒ `RECORDED` + `CYCLE_STARTED`; deduped/cooldown-gated runs ⇒ `RECORDED` + `GATED` with exactly ONE durable trigger; a `SUSPENDED` deployment ⇒ `SUSPENDED` (explicit, no accumulation) and resume restores recording. Both trigger paths share one feed; trigger semantics unchanged. | F6 |
| H | normal operation | the feed is total: every failure is caught, the envelope disposition is `FEED_FAILED`, the durable feed log counts it, and the run's verdict/budget/envelope are untouched. `NORMAL_OPERATION_IMPACT = NONE`. | F7 |
| I | crash / resume / partial write | observations are durable (fresh-process read agrees); a duplicate resume is refused as a conflict (no double count, no rewrite); an orphaned `.tmp-*` file is invisible; a torn main file yields ZERO valid observations (fail-open read) and the next run restores a valid atomic file. | F4 |
| J.1 | policy succession | `issueSuccessorEvolutionPolicy` + `scripts/evolution-issue-policy.mjs --successor`: previous-digest binding, monotonic generation (exactly N+1), exclusive active policy (structured lock + re-verify before the atomic replace), outgoing generation archived durably under `<store>/evolution-policy-history/` and readable. Manual archiving is no longer required — or supported. | F9 |
| J.2 | production declaration | `src/evolution/production-declaration.mjs` (NEW): a durable declaration record supplying `storeRoot` / `checkpointRoot` / `repoRoot` / `taskClass` / `strategyBaselineValues` (+ optional dimensions, reviewer, prompt profile, canary window, thresholds, synthetic). Path comes from the deployment (`AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG` or `runnerOpts.evolution.deploymentConfig`) — no machine-specific absolute path in source. `strategyBaselineValues` is now a first-class production input (object, JSON env var, or declaration). Authored with `scripts/evolution-declare-production.mjs` (validated, exclusive-create, idempotent). A malformed declaration is ignored (fail-open) and surfaced in the resolved config and the operator report. | F10 |
| K | regression | see floors below | — |

## The order, precisely

```
runAdmittedGraph terminal result                      (semantics UNTOUCHED)
  → durable evidence journal                          ONE read, ONE snapshot
  → strategy attribution                              attribution.mjs
  → performance-memory write                          attribution-feed.mjs  ← NEW
  → trigger evaluation                                production-observer.mjs
  → optional cycle scheduling                         production-consumer.mjs
```

The observer and the feed receive the SAME journal snapshot and the SAME
kill-switch resolution, so a trigger evaluation and a strategy observation can
never disagree about what the run did (`observeRunForEvolutionTriggers` gained
the optional `journal` / `switchState` seam params; a direct caller without them
keeps the pre-existing behaviour of reading the journal itself).

The feed hands its attribution down to the scheduler, so the loop's plan inputs
come from the same derivation the observation was built from — one derivation,
two consumers, no re-write.

### Why SUSPENDED is an explicit exclusion

`AUTO_EVOLUTION=SUSPENDED` means "accumulate no new evolution state". A
suspended deployment records NOTHING into the memory — but the disposition is
`SUSPENDED`, visible on the envelope, in the in-process feed state and in the
durable feed log. It is never a silent drop, and resuming restores recording.

## Boundaries (stated, not hidden)

### The parent/subagent relation, precisely

The observation binds `attribution_identity.parent_identity`, and it is the
OWNING graph run (`graph_run_id`), plus the per-phase agent identity
(`phase_ids` / `stages`) — which is exactly the parentage the durable journal
records: a durable graph journals its own execution id, its phases and their
dependencies, and the checkpoint identity objects use that run id as the phases'
`parentExecutionId`. The JOURNAL DOES NOT carry a distinct parent execution id
for a graph launched by another graph, so a deeper sub-agent fan-in lineage
cannot be derived from durable evidence and is therefore NOT claimed. Reading
it out of a caller-supplied field would be caller-claimed attribution, which
`attribution.mjs` deliberately refuses (the same reason the provider comes only
from the ADMITTED binding).

| Boundary | State |
|---|---|
| Trigger semantics | UNCHANGED — signal floors, dedup, cooldown, window cap, circuit breaker, single-flight and the `NO_QUALIFIED_TRIGGER` / `GATED` / `CYCLE_STARTED` disposition set are untouched. The feed simply no longer sits behind them. |
| Evolution authority | UNCHANGED — policy preauthorization, risk classification, validation, fitness, review, promotion, canary and rollback all still gate. The feed mints NO authority; it writes advisory performance memory only. |
| Admitted `provider_binding` | UNCHANGED — still the only execution-time provider authority, and still the only provider the attribution reads. |
| `strategyBaselineValues` | UNCHANGED semantics (it declares the strategy currently in force); it now has a production surface (§J.2) instead of an internal config object only. |
| Strategy memory | UNCHANGED schema/cap, but `observation_id` semantics strengthened (run identity, not content digest) and `observation_digest` is now timestamp-independent so a resumed recompute is stably distinguishable. |
| Policy artifact | The record gains the OPTIONAL `previous_policy_digest`; absent for gen 0, required-shape-validated (64-hex + generation ≥ 1) when present. Every existing policy remains valid. |
| HIGH classes / governance paths | UNCHANGED. `src/evolution/**` stays forbidden to autonomous source mutation; the feed is wired inside admission, not through the policy scope. |

### Known limits recorded (NOT release blockers)

1. **`TOOL_SELECTION` remains non-derivable.** A selection digest cannot be
   turned back into tool ids without an evidence-bound tool set; the producer
   still refuses rather than guesses. Unchanged by this card.
2. **The feed writes per eligible run.** `MAX_STRATEGY_OBSERVATIONS = 2000` with
   oldest-dropped retention still bounds the store, but a large deployment will
   now cycle through that cap faster than before (the pre-repair behaviour
   recorded ~0 on healthy deployments). This is the intended trade — a bounded
   store is not a selection bias — and it is recorded because the store is
   correspondingly less hermetic across long studies.

## Verification

Acceptance suite: `test/evolution/test-agent-strategy-evidence-feed-repair.mjs`
(F1–F10 + F4b + F10b; 12 cases, all PASS). Every case enters through the
production entrypoint (`runAdmittedGraph`) or the real module surfaces; no
memory fixture is written as proof anywhere.

Floors (re-run on this tree):

| Floor | Result |
|---|---|
| evolution (`test/evolution/*.mjs`, incl. this card) | 68/68 PASS |
| admission | 188/188 PASS |
| telemetry + evidence + budget | 228/228 PASS |
| governance | 573/573 PASS |
| control-plane + subagent + evidence | 128/128 PASS |
| v2 production pipeline / chain-r2 / pipeline / orchestrator | 55/55 PASS |
| v2 soak probes (E1 human-mutation, E2 reboot probes, E3 discrimination) | 35/35 PASS |
| v2 checkpoint-bridge + durable-execution + run-evidence-store + run-manifest | 41/41 PASS |
| writeback / learning lifecycle (subset, `--test-concurrency=1`) | 116/121 — the 5 R-15 write-back-authority failures reproduce identically on the PRISTINE tree (`HOLD COLIMA_HOME_NOT_CANONICAL`; the Colima daemon is not available in this environment). Pre-existing, environment-bound, untouched by this card. |
| v2 full floor (`--test-concurrency=1`, canonical `COLIMA_HOME`) | 660/661 — the single failure is `test/v2/test-e2-reboot-soak.mjs` `E2 R-NEG NEG-CONTROL`; run in isolation the E2 soak fails 5 of 9 (R2, R3, R6, R7, R-NEG) IDENTICALLY on a pristine `HEAD` worktree, because the worker runs need the real pi/Colima runtime, which is not available here. Pre-existing, environment-bound. |
| `npm run check` | PASS |

### Pre-existing failures observed (NOT regressions)

Reproduced on a pristine `HEAD` worktree with the canonical `COLIMA_HOME`:

- `test/v2/test-durable-graph.mjs` → `DE-2 production wiring: runSubagentGraph
  default durable …` (`GRAPH_EXCEPTION:ColimaRuntimeError`).
- `test/test-durable-subagent-resume.mjs` → `DE-2R resumeSubagentGraph:
  completed durable run …`.
- `test/memory/test-writeback-authority.mjs` → the 5 `R-15` cases
  (`HOLD / COLIMA_HOME_NOT_CANONICAL`).
- `test/v2/test-e2-reboot-soak.mjs` → 5 of 9 cases (R2, R3, R6, R7, R-NEG) when
  the file is run in isolation; the reboot workers need the real pi/Colima
  runtime to drive a resumed run to PASS, and HOLD instead.
- `test/test-subagent-graph.mjs` → all 5 cases (the real sub-agent nodes need
  the pi runtime). Identical before and after this card.

All are runtime-availability failures in this environment, identical before and
after this card. The v2 full-floor run additionally hits the same class:
`E2 R-NEG NEG-CONTROL` failed under the contended floor and again in isolation
on BOTH trees; `test-graph-closeout-integration.mjs` flaked once under the
contended floor and passes 3/3 when run alone on this tree.

## Operator surfaces (read-only)

```
node scripts/evolution-operator.mjs [--store <dir>] [--json]
```

now reports, in addition to the pre-existing sections:

- `policy.generation`, `policy.previousPolicyDigest`, `policy.history[]` — the
  active generation, its predecessor and every preserved generation (§J.1);
- `attributionFeed` — the every-run feed's disposition counters
  (`recorded`/`total`), recent records and failure tally (§A/§H);
- `deployment` — which production declaration record this deployment resolved,
  and its validation errors (§J.2);
- a `diagnostics` entry `ATTRIBUTION_FEED_FAILURE` whenever any feed/attribution
  failure has been recorded (fail-open, but never invisible), and
  `DEPLOYMENT_DECLARATION_INVALID` for a malformed declaration.

## Operator actions (the two issuance lanes)

```
# §J.1 — issue the SUCCESSOR of the active policy (archives the outgoing one):
node scripts/evolution-issue-policy.mjs --store <dir> --successor [--previous-digest <64hex>]

# §J.2 — declare the deployment's evolution inputs (one durable record):
node scripts/evolution-declare-production.mjs --out <path> \
  --store-root <dir> --checkpoint-root <dir> --repo-root <dir> \
  [--task-class <token>] [--strategy-baseline DIM=value ...] \
  [--strategy-dimension DIM ...] [--reviewer <identity>] [--json]
#   then export AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG=<path>
```

Both are exclusive-create: an identical re-issue is a no-op
(`AUTHORIZED_EXISTING_IDENTICAL` / `UNCHANGED_IDENTICAL`) and a conflicting one
fails closed (`EVOLUTION_POLICY_CONFLICT` / `EVOLUTION_DECLARATION_CONFLICT`).
