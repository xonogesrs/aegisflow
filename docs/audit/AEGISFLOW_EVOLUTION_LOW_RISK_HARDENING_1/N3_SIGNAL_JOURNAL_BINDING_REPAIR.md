# N3 — signal ↔ journal binding repair

**Card:** `AEGISFLOW_EVOLUTION_N3_SIGNAL_JOURNAL_BINDING_REPAIR_1`
**Baseline:** `6f08577` (unchanged, not amended)
**Branch:** `feat/omp-cbm-recovery`
**Mode:** TARGETED REPAIR. One finding. No production activation, no EKM/CBM, no
pipeline refactor, no new store, no authority change.

This document records the defect, the repair, and the proof. It does **not**
claim PASS — that disposition belongs to a reviewer session that did not write
this code.

---

## 1. Previous landing gate (card §0)

Checked BEFORE any edit.

| Check | Value |
|---|---|
| Prior independent review | **HOLD** on N3 (N1/N2/N4 PASS) — preserved, not rewritten |
| `git fetch origin` | clean |
| `git rev-parse HEAD` (pre-edit) | `6f08577c82edcda3cad299e471cdfbfb3d707042` |
| `git rev-parse origin/feat/omp-cbm-recovery` | same |
| `git ls-remote origin refs/heads/feat/omp-cbm-recovery` | same |
| `git log origin/...HEAD --oneline` | empty (0 unpushed) |
| `git status --porcelain` | empty |
| `git stash list` | empty |
| other worktree | `/Volumes/NVM2T/Development/repos/autoloop` @ `8bb72a5`, branch `audit/omp-native-capability-dispatch-1`, clean |

The prior card's FAIL/HOLD provenance is left in place: this card adds a report,
it does not revise the earlier one.

---

## 2. The defect, stated precisely

The previous guard (`signalEvidenceRefusal`) proved that a fired signal **cited
a row the journal held**. It did not prove that the row **supported the claim**.

Consequence, reproducible at `6f08577`: over a genuine repair journal, a caller
supplying `REPEATED_REPAIR_REQUIREMENT` with the journal's real `event_id`s but

- an invented `signature` (the cooldown key),
- an invented `count`,
- a class the evidence does not derive, or
- an invented `patchPlan`/`affectedScope`,

reached `CYCLE_STARTED`: a durable trigger record was written, the signature's
cooldown was spent, and the patch travelled into the candidate's mutation plan.
A second, real signal for the same signature was then suppressed by the cooldown
the forgery had consumed.

---

## 3. The repair

`src/evolution/production-consumer.mjs`.

**Journal-derived signal authority.** After the journal is re-read and its
provenance re-established, the consumer **re-derives** the eligible signals from
that journal with the SAME two functions the observer used —
`extractTriggerObservations` + `evaluateSignals` — and the same policy
thresholds (`config.thresholds`). This is not a second evaluator and not a
second evidence store: it is the existing derivation, run once more over the
journal the consumer already holds.

**Exact comparison, both directions.** `verifyFiredSignals` accepts a caller
claim only when it is canonically identical to a derived signal:
`signalClass`, `signature`, `count`, `minCount`, `evidenceRefs` (order-
normalised) and `observation` (where a bounded patch travels). The comparison
also refuses a caller that reports **fewer** signals than the journal derives,
so the caller cannot select which qualifying evidence is allowed to act. A
mismatch names the exact field (`signature`, `count`, `patchPlan`, …) so the
operator can tell a forged fact from an invented signal.

**The derived records are what runs.** From the guard onward — trigger gate,
durable trigger record, plan producer, candidate — the consumer uses
`verified.signals`, never the caller's objects. A patch therefore reaches a
candidate only when the journal itself carries it.

**Classes that cannot be re-derived are refused.** `QUALIFIED_PATTERN_EVIDENCE`
(pattern qualification lives in the learning store) and `LATENCY_REGRESSION` /
`TOKEN_INEFFICIENCY` (both fire only against a caller-supplied baseline) are
refused by name. No production path supplies those inputs to the observer
today, so this narrows an unreachable path rather than changing live behaviour.

**Window anchored to the observation.** The re-derivation uses the observation's
own `at` timestamp as its clock when that timestamp is within
`OBSERVATION_AT_TOLERANCE_MS` (5 min) of the consumer's clock, and the consumer's
clock otherwise. Without the anchor an event sitting on the window cutoff could
be counted by the observer and dropped by the consumer, refusing a **genuine**
signal; without the tolerance a caller could select a stale or future window by
editing one field.

**Refusal is total, and happens before any write.** `NO_QUALIFIED_TRIGGER` with
`evidence_qualified:false`, `evidence_reverified:true` and
`signals_rederived`. Zero durable trigger records, zero cooldown consumption,
zero candidate artifacts, zero mutation, zero cycle activation.

---

## 4. Proof

`test/evolution/test-evolution-low-risk-hardening-1.mjs` — the N3 section was
rewritten. The old cases asserted the weaker rule ("the cited row exists"); they
now assert journal-derived authority and durable side effects.

`assertNoDurableTrace` checks, for every refusal: no
`evolution-trigger-state.json` (⇒ no trigger record AND no cooldown slot), no
candidate store, no `evolution-cycles/` lock directory.

| Case | Asserts |
|---|---|
| `N3 the real journal derives the signal the consumer accepts` | baseline: the observer's own list over a real journal reaches `CYCLE_STARTED` |
| **A** `real journal row + FORGED signature` | refused (`signature`), zero durable trace |
| **B** `real journal row + FORGED count` | refused (`count`), zero durable trace |
| **C** `real journal row + FORGED class` | refused (`was not derived`), zero durable trace |
| **D** `real journal row + FORGED patchPlan` | refused (`patchPlan`); no candidate artifact exists and no artifact contains the forged patch; repo untouched |
| **D2** `a patch the JOURNAL carries travels into the candidate` | the durable trigger carries the journal's patch; a caller that swaps only the patch on an otherwise-correct signal is refused |
| **E** `forgery then real` | the forgery spends no cooldown: the real signal over the same store still reaches `CYCLE_STARTED`, exactly one durable trigger |
| **F** `real journal + correctly derived signal` | fires normally; the durable trigger cites the journal's own rows (no over-fencing) |
| **G** `non-re-derivable classes` | `QUALIFIED_PATTERN_EVIDENCE`, `LATENCY_REGRESSION`, `TOKEN_INEFFICIENCY` refused |
| **G2** `caller reports fewer signals than derived` | refused; zero durable trace |
| **N1 / N2 (unchanged)** | still pass |

### 4.1 Fix-direction proof

The rewritten N3 cases were run against the **baseline** consumer
(`git show 6f08577:src/evolution/production-consumer.mjs`) and against the
repair:

| Consumer | N3 baseline | A | B | C | D | D2 | E | F | G | G2 |
|---|---|---|---|---|---|---|---|---|---|---|
| `6f08577` (pre-repair) | PASS | **FAIL** | **FAIL** | **FAIL** | **FAIL** | **FAIL** | **FAIL** | PASS | **FAIL** | **FAIL** |
| repair | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |

Pre-repair totals for the file: **9 pass / 8 fail**. Post-repair: **17 / 17**.
The pre-repair failures are the exploit itself — `CYCLE_STARTED` where a refusal
is required — not assertion drift.

---

## 5. Verification

| Suite | Result |
|---|---|
| `test/evolution/` (9 files) | **121 / 121 PASS** (was 117; +4 net from the rewritten N3 section) |
| Host-only suite | recorded in §5.1 |
| Production evolution | **inactive** — no declaration, no policy, `DISABLED` |
| Production data integrity | unchanged — no production store, config or declaration was read for write, created or migrated |

### 5.1 Host-only comparison

| Run | Totals | Failing names |
|---|---|---|
| this repair | 3216 tests, 3200 pass, **14 fail**, 2 skipped | the 14 below |
| prior card head `6f08577` (recorded) | 3212 tests, 3196 pass, 14 fail, 2 skipped | the same 14 |

```
test/budget/test-reviewer-atomic-reservation-r3.mjs
test/budget/test-reviewer-attempt-meter-unit.mjs
test/control-plane/test-allowlist-parity.mjs
test/control-plane/test-coordinator.mjs
test/control-plane/test-execution-sink.mjs
test/control-plane/test-optimizer.mjs
test/governance/test-execution-review-bypass-fence.mjs
test/test-sop-scale-bind.mjs
test/v2/test-e3-discrimination-probes.mjs
test/v2/test-e3-lease-outage-soak-crossproc.mjs
test/v2/test-e3-lease-outage-soak.mjs
test/v2/test-pipeline.mjs
test/v2/test-pi-transport-adapter.mjs
WP2 T2 the fence is a frozen list member (both sinks)
```

Every one is the SAME class — `ERR_MODULE_NOT_FOUND: Cannot find package
'@earendil-works/pi-ai'` raised from `src/v2/pi-transport-adapter.mjs` (the
optional peer dependency is absent from this checkout). `grep -c` over the run
log returns exactly 14 occurrences, i.e. one per failing case and no other
error class. The failure set is identical to the baseline's, so this card adds
no regression; the +4 test count is the rewritten N3 section.

---

## 6. Scope check

| Area | Touched? |
|---|---|
| `src/evolution/production-consumer.mjs` | yes — N3 guard only |
| `src/evolution/trigger.mjs` | **no** (its two derivation functions are consumed, not changed) |
| `src/evolution/loop.mjs` | **no** |
| `src/evolution/candidate.mjs`, `plan-producer.mjs` | **no** |
| `src/evolution/production-observer.mjs`, `production-declaration.mjs` | **no** |
| production declaration / config / store | **no** |
| EKM / CBM / OMP | **no** |
| new dependency / store / schema / proxy layer | **no** |
| authorization / promotion / mutation policy | **no** |

The other LOW findings the reviewer listed (conflict telemetry, corrupt index,
documentation wording, synthetic precedence asymmetry) are **not** touched.

---

## 7. Remaining risks

1. **The loop's direct entry is a trusted-caller API.** `runEvolutionCycle`
   accepts an injected `triggerEvent` after checking its schema, by contract
   "pre-gated and already durably recorded". A caller inside the process can
   therefore hand the loop a trigger event with a patch the journal does not
   carry. This is unchanged by this card: the production seam is the consumer,
   and the consumer now derives everything it passes down. Hardening the loop's
   injection point would require binding an injected trigger to the durable
   trigger state, which changes the semantics every existing direct-entry test
   relies on — a different card, not this one.
2. **`fired: []` with a non-empty journal.** The consumer returns
   `NO_QUALIFIED_TRIGGER` before re-derivation, so an empty claim never reaches
   the durable path. It is not an error; it is also not verified. Nothing is
   written either way.
3. **Threshold drift.** The consumer re-derives with `config.thresholds`, the
   same object the gate hands the observer. A deployment that changes policy
   between the observation and the consumer call would refuse a signal the
   observer derived. That is fail-closed and the two calls are adjacent in the
   production path.
4. **`OBSERVATION_AT_TOLERANCE_MS`** is a bounded constant (5 min). A production
   run whose post-result evolution block is delayed by more than that falls back
   to the consumer's clock; the window then differs from the observer's by the
   delay. No evidence is invented — only a cutoff-straddling event could differ,
   and the fallback is the stricter side.

---

## 8. Durable landing

Pre-edit gate: §1 — the prior card's landing was complete, no WIP, no stash, no
unpushed commit, and no other worktree mutation.

Post-push verification, performed on the **content** commit (a later
report-only commit cannot name its own hash):

| Check | Value |
|---|---|
| local `HEAD` at verification | `b02131d454db4caa4326dea9bb209e8f79899517` |
| `origin/feat/omp-cbm-recovery` (post-fetch) | `b02131d454db4caa4326dea9bb209e8f79899517` |
| `git ls-remote origin refs/heads/feat/omp-cbm-recovery` | `b02131d454db4caa4326dea9bb209e8f79899517` |
| unpushed commits | `0` |
| `git status --porcelain` | empty |
| `git stash list` | empty |
| baseline `6f08577` | reachable, unamended, published |

`b02131d` contains exactly 5 files:

```
docs/audit/AEGISFLOW_EVOLUTION_LOW_RISK_HARDENING_1/HARDENING_REPORT.md   (N3 marked superseded)
docs/audit/AEGISFLOW_EVOLUTION_LOW_RISK_HARDENING_1/N3_SIGNAL_JOURNAL_BINDING_REPAIR.md (new)
docs/autonomous-evolution.md
src/evolution/production-consumer.mjs
test/evolution/test-evolution-low-risk-hardening-1.mjs
```

Only `production-consumer.mjs` and the test file change behaviour. No scratch
file, probe or temporary worktree was committed.

## 9. Handoff

Disposition of this card: **REPAIR READY FOR INDEPENDENT RE-REVIEW**, not PASS.

The reviewer should reproduce the original N3 exploit at `6f08577` (it succeeds
there) and against this repair (it does not), then confirm:

1. A–G above with the durable side effects, not only the verdict;
2. that a genuine journal still fires (no over-fencing);
3. that a refused forgery leaves no cooldown behind;
4. `test/evolution` totals and the host-only failure set;
5. production evolution remains inactive and no production data was written.
