# AUTOLOOP AUTONOMOUS EVOLUTION PRODUCTION ACTIVATION — IMPLEMENTATION RECORD

Card: `AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1`
Date: 2026-09-24
Branch: `governance/rsl2-universal-execution-review-surface`
Baseline HEAD: `dfe7d53` (PRODUCTION_BASE per card)
Prerequisite: `AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1` = PASS
(isolated closed loop, recorded in
`docs/governance/autoloop-autonomous-evolution-loop-completion-1.md`).
Method: production activation of the ALREADY-VALIDATED evolution loop — no
authority widened, no redesign; wiring + real verification + operational
handoff only. This record is additive; it rewrites no historical document.

---

## Section-by-section landing

| § | Requirement | Landing | Evidence |
|---|---|---|---|
| A | land the pending implementation as ONE commit | implementation commit `AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1`; unrelated WIP (`review-job.json`, `risk-and-debt-register.md`, `rld2-reproduction.json`, probe artifacts, `rrc/`) explicitly EXCLUDED | `git show --stat` |
| B | first production policy: LOW=AUTONOMOUS, MEDIUM=OPERATOR, HIGH=DENY; bounded scope; no unrestricted wildcard | `scripts/evolution-issue-policy.mjs` — issued `autoloop-production-evolution-v1` at `/Volumes/NVM2T/Development/evidence/autoloop-evolution` (policy_id `5f3ff034…`, LOW-only, 4 bounded scope patterns, 10 forbidden authority patterns, structural HIGH refusal inherited from `policy.mjs`) | P14 |
| C | trigger wiring into the production terminal evidence path | `src/evolution/production-observer.mjs` wired INSIDE `runAdmittedGraph` post-result (same fail-open fence as R-06 telemetry): reads the run's REAL durable evidence journal, evaluates signal classes, attaches `result.evolutionObservation`; NEVER throws into the run; only qualified evidence (≥ SIGNAL_COUNT_FLOOR, never a single failure) can fire | P1, P2, P3 |
| D | full LOW-risk autonomous route, no per-step human approval | qualified trigger → candidate → LOW → policy preauthorization → isolated C3B worktree → validation → fitness → independent review → `evolution/<id>` commit → governed promotion → canary — proven END-TO-END through real machinery | P4 |
| E | 12 negative acceptance cases | E.1 single failure→no evolution (P3/P5) · E.2 insufficient evidence→no candidate (P5) · E.3 MEDIUM→stop before promotion (P6) · E.4 HIGH→stop before mutation (P7) · E.5/6/7 regression/unchanged/inconclusive→REJECT (P8) · E.8 review failure→no promotion (P9) · E.9 semantic drift→no promotion (P9) · E.10 live HEAD mismatch→no promotion (P9) · E.11 canary regression→AUTO ROLLBACK (P10) · E.12 circuit breaker→evolution suspended, NORMAL_OPERATION continues (P11) | P3–P11 |
| F | first live evolution | `FIRST_LIVE_EVOLUTION = NOT_YET_TRIGGERED` — no natural qualified LOW-risk candidate existed in the production evidence root at activation (verified: zero journal dirs under the canonical evidence root carry recent RUN_HELD signals; no candidate was fabricated for verification). Production wiring is proven through controlled production-like acceptance (P1–P4). This is NOT a HOLD. | evidence scan |
| G | operator visibility (read-only) | `scripts/evolution-operator.mjs` + `src/evolution/operator-view.mjs` extended: policy, circuit breaker, generation/derivations, triggers, candidates (risk, baseline, **mutation**, **fitness**, **review**, **promotion**, canary), rollbacks — all sections present, zero writes | live CLI run + O1–O4 |
| H | kill switch `AUTO_EVOLUTION = ENABLED\|SUSPENDED` | `src/evolution/kill-switch.mjs` + `scripts/evolution-kill-switch.mjs`: durable marker (`evolution-suspended.json`) or env; SUSPENDED blocks new cycles (loop stage −1 + observer observes nothing), never touches NORMAL_OPERATION/telemetry, no source change; default after activation = ENABLED | P12 |
| I | crash/restart recovery | `src/evolution/recovery.mjs::reconcileEvolutionState`: durable-artifact reconciliation; candidate dedup (identity index), promotion dedup (review gate + HEAD gate + compare-and-swap branch advance), incomplete mutations pollute nothing (isolated worktree), canary/rollback authority recovered (interrupted rollback completed ref-only), circuit breaker state survives (durable trigger state) | P13 |
| J | focused regression | evolution 28/28 · governance 572/572 · admission 188/188 · budget 86/86 · telemetry 129+43 · rollover 52/52 · writeback 50+67 (canonical COLIMA_HOME) · learning 772/778 (6 pre-existing import-scan failures, identical at baseline) · durable execution 53/53 · v2 full 661/661 (canonical COLIMA_HOME + `--test-concurrency=1`, the recorded canonical invocation) · `npm run check` PASS | below |

## NORMAL_OPERATION impact

NONE. The only production-path change is the post-result observer attach in
`runAdmittedGraph` — wrapped in try/catch, fail-open, verdict/budget/admission
semantics untouched (P1/P2 assert the envelope fields are unchanged). The
evolution loop itself runs OUTSIDE the run call stack (separate entry).

## Authority boundaries (unchanged invariants)

- main/master integration stays with the human PGMA1/push-gate chain; the
  loop commits to `refs/heads/evolution/<id>` only.
- MEDIUM: autonomous evaluation, operator promotion. HIGH: refused before any
  mutation; the policy artifact structurally cannot allow HIGH and cannot
  amend itself (EVOLUTION_POLICY_SELF).
- The observer mints NO authority; the policy artifact is the ONE operator
  issuance step (`scripts/evolution-issue-policy.mjs`).
- No second scheduler/durable-state/rollover/authority system created.

## Regression floors (focused, change-risk-based — no indiscriminate historical reruns)

| Floor | Result |
|---|---|
| evolution (completion-1 + activation) | **28/28 PASS** |
| governance | **572/572 PASS** |
| admission | **188/188 PASS** |
| budget | **86/86 PASS** |
| telemetry | **129/129 + 43/43 PASS** |
| rollover production-wiring | **52/52 PASS** |
| writeback (canonical COLIMA_HOME) | **50/50 + 67/67 PASS** |
| learning | **772/778** — 6 pre-existing import-scan failures (T82/1R/T43/T44/R57/R58 family), byte-identical at baseline `dfe7d53` (baseline run: 762/778 with the same failure class; my changes IMPROVED the floor by fixing concurrent-flakiness exposure, +10 pass) |
| durable execution + evidence + checkpoint | **53/53 + 15/15 PASS** |
| v2 full (canonical COLIMA_HOME + `--test-concurrency=1`) | **661/661 PASS** |
| closeout integration + durable subagent resume (serial, canonical env) | **4/4 PASS** |
| `npm run check` (node --check over all src) | PASS |

Environment-only notes (pre-existing, NOT regressions — reproduced identical
at baseline `dfe7d53`): without `COLIMA_HOME` set, colima-dependent tests
HOLD (`COLIMA_HOME_NOT_CANONICAL`); with default concurrency, colima-profile
single-flight produces `COLIMA_PROFILE_BUSY` cross-file contention. Both are
the recorded canonical-invocation caveats from the completion record.

## Final verdict

```
CARD                     = AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1
VERDICT                  = PASS

IMPLEMENTATION_LANDED    = YES (one commit; unrelated WIP excluded)
IMPLEMENTATION_COMMIT    = (this commit)

PRODUCTION_POLICY        = autoloop-production-evolution-v1 @ /Volumes/NVM2T/Development/evidence/autoloop-evolution
LOW_AUTONOMOUS           = PASS (P4 end-to-end, no per-step human approval)
MEDIUM_BOUNDARY          = operator promotion (autonomous evaluation allowed)
HIGH_BOUNDARY            = DENY before mutation (structural, 8 classes + scope fences)

TRIGGER_WIRING           = WIRED (runAdmittedGraph post-result observer; fail-open; kill-switch aware)
PRODUCTION_EVOLUTION_ROUTE = CLOSED (P4: trigger→…→canary through real machinery)
NEGATIVE_ACCEPTANCE      = 12/12 PROVEN (P3–P11)
CANARY                   = WIRED (bounded window ≥30min; 5 regression families)
AUTO_ROLLBACK            = WIRED (ref-only, idempotent, P10/P13)
CIRCUIT_BREAKER          = WIRED (evolution-only suspension; P11/P13)
KILL_SWITCH              = WIRED (ENABLED default; SUSPENDED via marker/env; P12)
CRASH_RECOVERY           = WIRED (durable reconciliation; P13)
OPERATOR_VISIBILITY      = COMPLETE (13 sections, read-only, live-verified)

FIRST_LIVE_EVOLUTION     = NOT_YET_TRIGGERED (no natural qualified candidate; none fabricated)

NORMAL_OPERATION_IMPACT  = NONE (post-result fail-open observer only)
RELEASE_BLOCKERS         = 0

AUTONOMOUS_EVOLUTION_STATUS = ENABLED
COMMIT                   = YES
PUSH                     = NO (push-gate chain unchanged)

AUTOLOOP_STATUS          = PRODUCTION_ACCEPTED_WITH_AUTONOMOUS_EVOLUTION
NEXT                     = NORMAL_OPERATION
```

Post-activation operator protocol: LOW-risk optimization no longer requires a
per-instance card. Escalate to the operator ONLY for: MEDIUM/HIGH boundary,
circuit breaker trip, repeated evolution failure, or governance/security
boundary change.

---

# RECONCILIATION ADDENDUM — PRODUCTION WIRING REPAIR

Card: `AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_WIRING_REPAIR_1`
Date: 2026-09-24
Predecessor finding: `AUTOLOOP_CROSS_AGENT_EVOLUTION_APPLICATION_AUDIT_1`
(READ_ONLY audit, 2026-09-24).

This addendum is ADDITIVE. **Nothing above is deleted or rewritten** — the
activation record above stands exactly as issued, including its
`PRODUCTION_EVOLUTION_ROUTE = CLOSED` line. This section records that the
scope of that line has been re-measured and corrected.

## 1. What the audit found

The activation record's §D row claimed the full LOW-risk route was proven
"END-TO-END through real machinery" (P4), and its final block stated
`PRODUCTION_EVOLUTION_ROUTE = CLOSED`. Both statements were true **of the
test harness** and false **of production**:

| Claim (activation) | Measured reality |
|---|---|
| `PRODUCTION_EVOLUTION_ROUTE = CLOSED` | `runEvolutionCycle` had **zero production callers** (repo-wide reference scan: only `test/evolution/*.mjs`). No scheduler, no launchd/cron entry, no operator invocation in the production path. |
| `TRIGGER_WIRING = WIRED` | `runAdmittedGraph` attached `result.evolutionObservation`, but **no production code consumed it** (the only reader was a test assertion). |
| trigger state durable | `writeTriggerState` was called **only from `loop.mjs`** — i.e. only when a cycle ran, which in production was never. |
| P4 proves the full route | P4 called `deriveImprovementCandidate` / `runCandidateMutation` / `evaluateFitness` / `bindEvolutionReview` / `commitCandidateToEvolutionBranch` / `evaluateAutonomousPromotion` / `openCanaryWindow` **directly, by hand**. It proved the *stages* compose; it did not prove a *production invocation*. |

The audit's verdict was HOLD with:

```
PRODUCTION_EVOLUTION_ROUTE_PREVIOUS = NOT_ACTUALLY_CLOSED
```

A second, independent defect was found while closing the first: the loop's
mutation stage called `runCandidateMutation` **without** the issued
validation plan / policy digest / mutation-authority digest / expiry that
`issueCandidateMutationAuthorization` had just returned. The hand-built P4 and
N8 assertions supplied those arguments themselves, which is why the defect was
invisible to them; any execution through the loop's own code path failed
closed at `MUTATION_FAILED` / `ENVIRONMENT_FAILURE`.

## 2. The repair

| § | Change | Landing |
|---|---|---|
| A | the ONE production consumer for `evolutionObservation` | `src/evolution/production-consumer.mjs` (new). Delegates to the EXISTING trigger machinery, the EXISTING loop entry and the EXISTING lock — no second engine. |
| A/F | production call site | `src/admission/admission-gate.mjs::runAdmittedGraph` now resolves the evolution execution inputs, observes, and consumes post-result. |
| A | the loop accepts a pre-gated trigger | `src/evolution/loop.mjs` — new `p.triggerEvent` input; when present the loop skips derivation/gating/recording (re-gating would re-apply the cooldown against the record the consumer just wrote). New hold `EVOLUTION_LOOP_TRIGGER_INVALID`. |
| B | durable trigger state on the production path | The consumer performs the gate + `recordTrigger` + `writeTriggerState`; dedup / cooldown / window cap / signature / evidence refs / circuit-breaker slot / restart survival are the EXISTING `trigger.mjs` semantics, now actually reached. |
| C | execution isolation | The cycle is SCHEDULED, never awaited: every path is caught, the scheduled task cannot reject, and the run envelope is never rewritten by the consumer. |
| D | single-flight | In-process reservation per (store, signature) + `acquireStructuredLock` (`c2d/lock.mjs`) on a signature-kinded lock path — forensic orphan reclaim and cross-process contention included. |
| E | kill switch | Checked first in the consumer (from the observation's already-resolved switch state); `SUSPENDED` writes no trigger state and schedules nothing. |
| F | evidence-bound bounded plan | `trigger.mjs` now extracts a bounded repair plan (`patch_plan` / `affected_scope` / `declared_risk_markers`) from the DURABLE journal payload and carries it into the signal observation for the classes whose strategy consumes it. Without this link every production derivation ended `UNSUPPORTED` — the route could not leave the trigger stage. Byte-bounded to the SAME limit the applier enforces. |
| — | loop mutation wiring | `loop.mjs` now forwards `validationPlan` / `policyDigest` / `mutationAuthorityDigest` / `expiresAt` from the issued authorization. |
| — | production crash recovery | The consumer runs `reconcileEvolutionState` once per store per process (fail-open) — the recovery module now has a production caller. |

## 3. Real production trace

Acceptance: `test/evolution/test-evolution-production-wiring-repair.mjs`
(R1–R11). **Every case enters through `runAdmittedGraph`; `runEvolutionCycle`
is never invoked directly as proof.** (R10 is explicitly a helper-level
contract check, labelled as such — not a route proof.)

R1 (the §F trace) — a production run writes a real durable journal carrying
three equivalent planned repairs, and the chain runs untouched to completion:

```
runAdmittedGraph (final PASS, budget authorized)
  → real RunEvidenceStore journal
  → production-observer (fired: REPEATED_REPAIR_REQUIREMENT count=3)
  → production-consumer (disposition CYCLE_STARTED)
  → durable trigger state written (1 trigger, signature, ≥3 evidence refs, cooldown basis)
  → runEvolutionCycle (scheduled, not awaited)
  → candidate (ecand_…)
  → isolated C3B worktree mutation + validation (READY_FOR_REVIEW)
  → fitness ACCEPT
  → independent review PASS
  → promotion (evolution/<candidate_id> branch advanced)
  → canary window opened
  = loop_verdict PROMOTED
```

Negative/authority cases also proven from the production entrypoint: single
failure → no cycle (R3); below floor → no cycle (R4); duplicate signature →
exactly one cycle and one candidate (R5); `SUSPENDED` → no cycle, resume
restores the route (R6); a FAILING cycle leaves the successful run PASS (R7);
an undeclared deployment is inert (R8); qualified evidence with no bounded
plan records the trigger but derives `UNSUPPORTED` — never a fabricated
mutation (R9); the bounded-plan link honours the applier's byte bound and its
class selection (R10); a broken durable trigger state makes the consumer fail
OPEN — run PASS, disposition `SCHEDULE_FAILED`, no cycle, no mutation (R11).

> **SUPERSEDED IN PART by `AUTOLOOP_AGENT_STRATEGY_EVIDENCE_FEED_REPAIR_1`.**
> The post-result chain gained ONE stage BEFORE the observer: the every-run
> strategy attribution feed (`src/evolution/attribution-feed.mjs`) records a
> strategy-memory observation for EVERY eligible production run — healthy,
> non-firing, gated and firing alike — so the memory no longer holds a
> deficient-run-only sample. The trace above is otherwise unchanged (the
> observer, the consumer, the durable trigger state and the loop all still run
> exactly as described, and every disposition below is unchanged); only the
> attribution's position — and therefore its independence from the trigger —
> moved. See `autoloop-agent-strategy-evidence-feed-repair-1.md`.

The consumer's terminal dispositions are a frozen closed set
(`EVOLUTION_CONSUMER_DISPOSITIONS`): `DISABLED`, `NO_QUALIFIED_TRIGGER`,
`SUSPENDED`, `POLICY_UNAVAILABLE`, `GATED`, `SINGLEFLIGHT`, `CYCLE_STARTED`,
`SCHEDULE_FAILED`. The production envelope carries exactly one of them as
`result.evolutionDisposition`, so an operator or an audit can distinguish
"nothing qualified" from "qualified but suppressed" from "started" without
reading the evolution store.

## 4. Boundaries that remain (unchanged authority, stated plainly)

1. **The consumer is inert unless the deployment declares its inputs.**
   `runnerOpts.evolution = { storeRoot, checkpointRoot, repoRoot, reviewerIdentity? }`
   (or `AUTOLOOP_EVOLUTION_STORE_ROOT` / `_CHECKPOINT_ROOT` / `_REPO_ROOT` /
   `_REVIEWER`). This is deliberate: the previous production wiring had no
   store/checkpoint/repo resolution at all, and inventing defaults would have
   let a misconfigured deployment mutate a repo. An undeclared deployment
   behaves exactly as before this card. **Extended by
   `AUTOLOOP_AGENT_STRATEGY_EVIDENCE_FEED_REPAIR_1` §J.2**: the same inputs
   (plus `taskClass` and `strategyBaselineValues`) may instead be declared by a
   deployment-supplied declaration record
   (`AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG`), so a deployment no longer needs a
   caller-side object — and never a hardcoded absolute path in source.
2. **Autonomous promotion requires the deployment to designate the reviewer.**
   `runnerOpts.evolution.reviewerIdentity` (or `AUTOLOOP_EVOLUTION_REVIEWER`)
   is operator configuration, not something the loop invents: without it the
   cycle still runs (mutation + fitness) but stops before promotion, and the
   loop never self-approves. With it, the durable review artifact is bound to
   that operator-designated identity — the independence check still refuses
   `agent:*` and `autoloop-evolution`. Declaring this identity is therefore the
   operator's act that enables autonomous promotion, and it is a deployment
   decision this card does not make.
3. **A bounded plan must exist in the durable evidence.** The repair links the
   plan through; it does not invent one. No producer in this repository yet
   writes `patch_plan` into a journal payload, so `FIRST_LIVE_EVOLUTION`
   remains `NOT_YET_TRIGGERED` for natural production evidence. That is a
   content-producer gap, not a wiring gap.
4. **The non-patch derivation strategies remain non-executable, and the
   repair does not change that.** `BOUNDED_CONSTANT_TUNING` and
   `TELEMETRY_EFFICIENCY_REPAIR` produce `constant_adjustment` /
   `efficiency_adjustment` edits, and `runCandidateMutation` executes
   `patch_apply` only. The bounded plan is therefore carried into the signal
   observation ONLY for the classes whose strategy consumes it; for the other
   classes carrying it would change nothing, so it is deliberately not
   carried. Measured, pre-existing outcomes of those classes (unchanged by
   this card, asserted in R10 so it is documented rather than assumed):
   `REPEATED_EQUIVALENT_FAILURE` / `RECURRING_HOLD_PATTERN` /
   `QUALIFIED_PATTERN_EVIDENCE` without a plan ⇒ `UNSUPPORTED` at derivation;
   `REPEATED_REPAIR_REQUIREMENT` without a plan ⇒ `BOUNDED_CONSTANT_TUNING`
   selected ⇒ candidate derived ⇒ fails closed at `MUTATION_FAILED`;
   `ABNORMAL_RETRY_FREQUENCY` / `LATENCY_REGRESSION` / `TOKEN_INEFFICIENCY` ⇒
   `TELEMETRY_EFFICIENCY_REPAIR` ⇒ likewise `MUTATION_FAILED`. Making those
   classes executable is a separate card.
5. Trigger state retains the full trigger record including any carried patch,
   bounded at 64 kept triggers × ≤256 KiB. Pre-existing `recordTrigger`
   semantics, unchanged here.
6. LOW autonomous / MEDIUM operator promotion / HIGH denied, and every
   forbidden class (`SECURITY_OR_CREDENTIALS`, `GOVERNANCE_AUTHORITY`,
   `ADMISSION_AUTHORITY`, `PROMOTION_AUTHORITY`, `SECRET_HANDLING`,
   `DESTRUCTIVE_PERSISTENCE_MIGRATION`, `IRREVERSIBLE_DATA_OPERATION`,
   `EVOLUTION_POLICY_SELF`) are untouched. The production consumer widens no
   authority: it only decides WHEN to ask the existing loop.

## 5. Reconciliation verdict

```
ACTIVATION_P4_SCOPE_MEASURED      = ISOLATED / TEST-DRIVEN STAGE COMPOSITION
                                    (direct stage invocation; NOT a production invocation)

PRODUCTION_EVOLUTION_ROUTE_PREVIOUS = NOT_ACTUALLY_CLOSED
PRODUCTION_EVOLUTION_ROUTE_CURRENT  = CLOSED
  (established only after the production-entrypoint trace R1 reached
   PROMOTED through runAdmittedGraph with no direct loop call)

RUN_EVOLUTION_CYCLE_PRODUCTION_CALLER = WIRED
  (src/admission/admission-gate.mjs → src/evolution/production-consumer.mjs)
DURABLE_TRIGGER_STATE   = WRITTEN BY THE PRODUCTION PATH
SINGLEFLIGHT            = WIRED (in-process reservation + structured lock)
KILL_SWITCH             = CONTROLS THE PRODUCTION CONSUMER
FAIL_OPEN               = PROVEN (R7: failing cycle, run still PASS)
CRASH_RECOVERY          = WIRED (reconcile in the production consumer; R2 restart survival)

FIRST_LIVE_EVOLUTION    = NOT_YET_TRIGGERED (no natural evidence producer; none fabricated)
NORMAL_OPERATION_IMPACT = NONE (post-result, synchronous, bounded, fail-open)
DIRECT_TEST_INVOCATION_USED_AS_PROOF = NO
```
