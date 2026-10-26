# Evolution production path audit

**Card:** `AEGISFLOW_EVOLUTION_PRODUCTION_ADMISSION_1`
**Type:** PRODUCTION ADMISSION / READ-ONLY FIRST
**Baseline:** `da3a251` (`feat/omp-cbm-recovery`), prior audit measured at `1301bb1`
**Date:** 2026-10-19
**Mode:** READ-ONLY. No source, config, store, EKM, CBM or OMP file was modified.

`src/evolution`, `src/admission` and `test/evolution` are **byte-identical** to
the prior audit's baseline `1301bb1` (`git diff --stat 1301bb1 da3a251 -- src/evolution src/admission test/evolution`
is empty). The prior audit's code-level findings therefore still apply; what
this card adds is a reachability/authority judgement for admission, not a
re-measurement of the same code drift.

Every classification below is tied to a call site that exists at `da3a251`.
A stage that exists in source but has no production caller is marked
`IMPLEMENTED_NOT_REACHABLE`; a stage that runs in the production path but does
not prove what it claims is marked `PARTIAL`.

---

## 1. The one production chain

```
caller
 → runAdmittedGraph                      src/admission/admission-gate.mjs:227
 → runner result                          (semantics untouched)
 → POST-RESULT evolution block            admission-gate.mjs:397-441
     resolveEvolutionProductionConfig     :398 → production-consumer.mjs:162
     readObservationJournal (once)        :405 → production-observer.mjs:81
     feedStrategyObservationForProduction :408 → attribution-feed.mjs:293
     observeRunForEvolutionTriggers       :420 → production-observer.mjs:137
     consumeEvolutionObservationForProduction :430 → production-consumer.mjs:267
 → (qualified, un-gated trigger only)
     scheduleCycle                        production-consumer.mjs:409
     dynamic import("./loop.mjs")         :495
     runEvolutionCycle                    :496 → loop.mjs:141
 → candidate → authorization → mutation → fitness → review → promotion → canary
```

Two properties are structural and were re-verified:

- **The cycle is scheduled, never awaited** (`production-consumer.mjs:409-430`;
  the task yields via `setImmediate` before doing any work). The production run
  returns its own result first.
- **Every failure in the block is swallowed** (`admission-gate.mjs:438-441`,
  and `consumeEvolutionObservationForProduction` catches internally). An
  evolution failure cannot turn a PASS into HOLD/FAIL.

There is **no in-repository production driver** for `runAdmittedGraph`: no
script, launchd job, cron entry or OMP extension calls it
(`scripts/*.mjs`, `integrations/omp/**`, `~/Library/LaunchAgents` all checked).
The one in-repo dispatcher, `executeSequentially`
(`src/control-plane/coordinator.mjs:429` → `:508`), is itself called only from
tests. The entry is a library API whose production caller lives outside this
repository. That is a deployment fact, not a defect, but it means the reachable
part of this path is only as reachable as that external caller.

---

## 2. Stage-by-stage classification

| Stage | Classification | Evidence | Notes |
|---|---|---|---|
| Task → terminal result | IMPLEMENTED_AND_REACHABLE | `runAdmittedGraph` `admission-gate.mjs:227`; admission/budget gates before dispatch | Not invoked by anything inside this repo |
| Durable evidence journal | IMPLEMENTED_AND_REACHABLE | runner-owned journal; single reader `readObservationJournal` `production-observer.mjs:81` | One read per run, shared by feed and observer (`:405`) |
| Evidence → attribution | IMPLEMENTED_AND_REACHABLE | `feedStrategyObservationForProduction` `attribution-feed.mjs:293` | Runs for every eligible run, independent of triggers |
| Evidence → trigger evaluation | PARTIAL | `observeRunForEvolutionTriggers` `production-observer.mjs:137`; signals `trigger.mjs:229` | Fires correctly, but **does not exclude synthetic evidence** (§3) |
| Trigger gating (dedup/cooldown/cap/breaker) | IMPLEMENTED_AND_REACHABLE | `applyTriggerGates` `trigger.mjs:457`; durable state `trigger.mjs:422-433` | Persisted by the consumer, `production-consumer.mjs:323-324` |
| Trigger → durable record | IMPLEMENTED_AND_REACHABLE | `buildTriggerEvent` `trigger.mjs:517`; `recordTrigger`; `writeTriggerState` | `evidence_refs` bound to journal event ids |
| Candidate proposal (source family) | IMPLEMENTED_AND_REACHABLE | `deriveImprovementCandidate` `candidate.mjs:202`; persisted `:294` | Requires an evidence-bound `patchPlan`; natural journals rarely carry one |
| Candidate proposal (strategy family) | PARTIAL | `deriveStrategyCandidate` `candidate-strategy.mjs:95`, returns at `:214` | **Never written to disk** — no proposal artifact exists for the operator or for recovery |
| Natural plan production | IMPLEMENTED_AND_REACHABLE | `produceImprovementPlan` `plan-producer.mjs:225`; deterministic diagnosis `:77` | Only fires with sufficient attributed samples (floor 3) |
| Risk classification + policy preauthorization | IMPLEMENTED_AND_REACHABLE | `classifyStrategyRisk` `candidate-strategy.mjs:55`; `authorizeUnderPolicy` `policy.mjs:482` | HIGH refused; strategy dimensions must be in the policy |
| Isolated mutation + validation | IMPLEMENTED_AND_REACHABLE | `runCandidateMutation` `mutation.mjs:108`; C3B worktree | Production checkout is only read |
| Fitness | IMPLEMENTED_AND_REACHABLE | `evaluateFitness` `fitness.mjs:131`; `evaluateStrategyFitness` `fitness-strategy.mjs:78` | REJECT on insufficient samples / unchanged / regressed |
| Independent review | PARTIAL | `bindEvolutionReview` `promotion.mjs:158`; independence check `:160` | Independence is a **string check** on a deployment-supplied identity; the verdict defaults to `PASS` (`production-consumer.mjs:223`). Same process writes the artifact it later reads. |
| Promotion gates | IMPLEMENTED_AND_REACHABLE | `evaluateAutonomousPromotion` `promotion.mjs:232` | All eight gates fail closed |
| Autonomous commit | IMPLEMENTED_AND_REACHABLE | `commitCandidateToEvolutionBranch` `promotion.mjs:98` | `refs/heads/evolution/<id>` only; main/master refused |
| Canary | IMPLEMENTED_AND_REACHABLE | `openCanaryWindow` `canary.mjs:99`; `evaluateCanary` `:153` | Bounded window, floor 30 min |
| Rollback / recovery | IMPLEMENTED_AND_REACHABLE | `rollbackCandidate` `canary.mjs:212`; `reconcileEvolutionState` `recovery.mjs:64` | Ref-only for source, deactivation for strategy |
| Circuit breaker | PARTIAL | trips in `recordCandidateOutcome` `canary.mjs:282`; gates in `trigger.mjs:461` | No reset call site outside tests/operator action (`clearCircuitBreaker` `trigger.mjs:508` has no caller in `src/`) |
| Budget enforcement inside the loop | PARTIAL | `authorizeUnderPolicy` `policy.mjs:528-533` reads `usage` | The production caller passes **no** `usage` (`loop.mjs:305` defaults `{}`; `production-consumer.mjs:496-518` omits it) — the mutation/window budgets never bind in production |
| Proposal-only stop | ABSENT | no mode/stop flag anywhere; `EVOLUTION_LOOP_VERDICTS` `loop.mjs:54` has no proposal verdict | The only reachable post-proposal path mutates and promotes |
| Durable cycle outcome log | PARTIAL | `OUTCOMES` is in-process, capped 64 (`production-consumer.mjs:121-130`); `evolutionConsumerState` `:566` | A cycle outcome is lost on process exit; durable truth is only whatever stage artifacts were written |

---

## 3. Two measured defects on the path

### 3.1 Synthetic evidence is excluded by the feed, not by the trigger

`attribution-feed.mjs:240` (used at `:333`) refuses test-only records with
`SYNTHETIC_RECORD`. The observer/consumer path has no equivalent gate:
`observeRunForEvolutionTriggers` (`production-observer.mjs:137-182`) calls
`extractTriggerObservations` and `evaluateSignals` with no synthetic check.

Measured, in an isolated fixture repo with a fixture policy and a declared
(deployment) evolution config:

```
evidence: 3 × PHASE_REPAIR_REQUESTED, payload { synthetic: true, test_only: true,
          patch_plan: …, affected_scope: ["lib/x.ts"] }
run final:            PASS
disposition:          CYCLE_STARTED
loop verdict:         PROMOTED
candidates written:   1
reviews/canary:       written
```

A fixture run therefore drove a full candidate → mutation → fitness → review →
promotion → canary cycle. Production state was not touched (separate store,
separate fixture repository), but this is exactly the condition the Admission
card's Evidence Gate forbids: a proposal can be produced from synthetic
evidence. The feed's exclusion is not sufficient because the trigger evaluates
the same journal independently.

### 3.2 A strategy proposal is not durable

`deriveStrategyCandidate` returns a digest-bound candidate object and writes
nothing (`candidate-strategy.mjs:95-214`). Measured directly:

```
deriveStrategyCandidate(...) → status CREATED, candidate ecand_a473389f…, digest bound
store entries after the call: []
evolution-candidates directory: absent
```

Consequences, all verified by inspection of the consumers:

- `listCandidates` (`candidate.mjs:306`) reads only `evolution-candidates/`, so
  the operator view (`operator-view.mjs:79`, candidate join at `:169`) cannot
  show a strategy proposal.
- `reconcileEvolutionState` (`recovery.mjs:64`) iterates the same source-only
  list, so a strategy proposal has no crash-recovery path.

A cycle that ends at fitness rejection therefore leaves **no proposal at all**;
the diagnosis exists only in the in-process trace.

---

## 4. What actually runs on this host

| Input | Measured |
|---|---|
| `AEGISFLOW_EVOLUTION_*` env | none set |
| `AUTO_EVOLUTION` env | unset; durable marker absent → `AUTO_EVOLUTION = ENABLED` |
| `AEGISFLOW_EVOLUTION_DEPLOYMENT_CONFIG` | unset |
| Operator view `deployment` | `provided: false` |
| `resolveEvolutionProductionConfig({env:{}})` | `enabled: false`, `missing: [storeRoot, checkpointRoot, repoRoot]` |
| `resolveEvolutionProductionConfig` with the existing declaration | `enabled: true`, task class `AUTOLOOP_CARD`, dimensions `MODEL_ROUTING,RETRY_REPAIR`, reviewer identity present |
| Production store contents | 3 files: policy gen 0, policy gen 1, declaration — mtimes 2026-09-24 |
| Policy | `ACTIVE`, generation 1, expires `2026-10-24T10:56:29.996Z`, LOW only, dimensions `MODEL_ROUTING,RETRY_REPAIR` |
| Triggers / candidates / reviews / canary / rollbacks | 0 / 0 / 0 / 0 / 0 |
| Strategy policy / memory / attribution feed | generation 0 / 0 observations / 0 dispositions |

So the path is **inert by configuration**: the same state the prior audit
recorded. Nothing has been enabled since.

---

## 5. Answers to the card's five questions

1. **What genuinely works?** Evidence journaling, the every-run attribution
   feed, trigger evaluation with minimum-evidence floors and durable gating,
   deterministic plan production, policy preauthorization, isolated mutation,
   both fitness evaluators, the eight promotion gates, canary with automatic
   rollback, crash reconciliation, and the kill switch. All are exercised by
   the suite (§6).
2. **What exists only as code with no execution path?** Proposal-only
   operation (no such mode exists), a production strategy consumer
   (`resolveProductionRoute` `strategy-store.mjs:299` has no caller outside
   `src/evolution` and tests), budget counters inside the loop, breaker reset,
   and the policy's own trigger window (`window_ms` is validated at
   `policy.mjs:127` and never applied to `applyTriggerGates`).
3. **Is autonomous improvement proposal feasible?** Derivation is feasible and
   evidence-gated, but there is no way today to persist a proposal and stop.
   The reachable continuation mutates and can promote.
4. **Are verification / approval / rollback protections sufficient?** For
   autonomous mutation, no: the review artifact is bound by the same process
   from a deployment-supplied identity and a verdict that defaults to `PASS`,
   and the budget counters are unbound. For proposal-only with human review,
   the rollback requirement is the ability to disable proposal generation,
   which the existing kill switch already provides.
5. **How far should minimal production evolution open?** Exactly to persisting
   a reviewable proposal: no mutation authorization, no branch, no strategy
   activation, no commit, no push.

---

## 6. Verification performed

| Check | Command | Result |
|---|---|---|
| Evolution suite | `node --test test/evolution/*.mjs` | 69/69 PASS, 9.9 s |
| Real production trace | `--test-name-pattern='R1 real production trace'` | 1/1 PASS |
| Isolation / kill switch / fail-open | `R6`, `R7`, `R8`, `P12` | 4/4 PASS |
| Undeclared deployment | real `runAdmittedGraph` | `PASS`, `DISABLED`, reason names the three missing inputs |
| Declared + synthetic deployment | real `runAdmittedGraph` | `PASS`, `NO_QUALIFIED_TRIGGER`; store gained only `attribution-feed.json` |
| Suspended + declared | real `runAdmittedGraph` | `PASS`, `SUSPENDED`, feed counter `{"SUSPENDED":1}` |
| Synthetic evidence through the full cycle | fixture repo + fixture policy | `PROMOTED` (§3.1) |
| Strategy candidate persistence | direct call + store listing | not persisted (§3.2) |
| Post-test state | `git status`, store listing, worktrees | clean; store still 3 files; both worktrees clean |

Suite size at this baseline: 22 modules / 6,684 lines under `src/evolution`,
6 test files / 69 tests under `test/evolution`.

---

## 7. Non-claims

- This audit does not claim the evolution machinery is broken. It is
  implemented and test-proven; two specific properties do not hold.
- It does not claim a production cycle has ever run. Zero is measured, and the
  measured configuration proves why.
- It does not authorize enabling anything. The verdict in `FINAL_VERDICT.md`
  is HOLD.
