# Evolution effectiveness assessment

**Card:** `AEGISFLOW_SELF_EVOLUTION_EFFECTIVENESS_AUDIT_1`
**Mode:** READ-ONLY. **Baseline:** `1301bb1`.

This document answers the questions the card requires, using only measured
artefacts. Where the answer is "no evidence", it says so.

---

## 1. How many demonstrable autonomous evolutions exist?

**Zero.**

| Requirement | Measurement | Result |
|---|---|---|
| Autonomous trigger fired | `triggers.count = 0`; no `evolution-trigger-state.json` | fail |
| Candidate derived | `generation.derivations = 0`; `candidates = []` | fail |
| Mutation performed | no `evolution/<id>` ref; no candidate tree | fail |
| Validated by the loop | no fitness/review artifacts | fail |
| Persisted | no `strategy-policy.json`, no `canary/`, no branch | fail |

Counter-check: the controlled acceptance run in the archived governance record
did produce `PROMOTED` for `MODEL_ROUTING` and `RETRY_REPAIR`, but in a
temporary store, driven by an operator-constructed scenario. It is recorded in
`EVOLUTION_LEDGER.md` as `CONFIRMED_ASSISTED_CHANGE` (EV-08), not as evolution.

---

## 2. Which capabilities did the system actually improve?

| Capability | Improvement | Evidence | Grade |
|---|---|---|---|
| Read-only codebase memory visible to the interactive agent | `cbm_query` tool added after `NO_SUCH_TOOL` was measured | `16638d6` body; deployed sha256 match | `CONFIRMED_ASSISTED_CHANGE` |
| Memory reachability after checkout move / remote rename | declared lineage aliases; 8/8 records reachable with lineage, 0 without | `fb8ce6a` body; `memory:lineage list`; live query | `CONFIRMED_ASSISTED_CHANGE` |
| Memory store openability after an in-place migration edit | forward-only `cbm2-v1-pattern-type` migration | `16638d6`; `memory_migrations` rows | `CONFIRMED_ASSISTED_CHANGE` |
| Terminal-fence ordering parity between repo and deployment | reconciled extension bytes + acceptance suite | `fb8ce6a` | `CONFIRMED_ASSISTED_CHANGE` |
| The evolution machinery itself | implemented and test-proven end to end | 69/69 evolution tests (this audit) | `CONFIRMED_ASSISTED_CHANGE` (implementation, not evolution) |

No capability was improved **by the evolution loop**. Every improvement above
was an operator-assigned engineering card.

---

## 3. Which results are still in effect?

| Result | Still in effect | Evidence |
|---|---|---|
| Evolution policy gen 1 | yes — until `2026-10-24T10:56:29Z` | policy file; operator report `state: ACTIVE` |
| Deployment declaration | exists, **not consumed** by any process | operator report `deployment.provided: false` |
| CBM store + lineage registry | yes | query returns `AVAILABLE` |
| `cbm_query` deployment | yes, byte-identical | `shasum` match |
| Transfer-metrics disablement | yes | `TRANSFER_METRICS_ENABLED = false` |
| Learning lifecycle wiring | present, unreachable in normal operation | no caller sets `provenance.lifecycle` |
| Benchmark learned store | present as committed data, not active anywhere | `benchmarks/results/learned-strategy-store/` |

After 2026-10-24 the policy expires. Unless a successor is issued,
`readEvolutionPolicy` throws `EVOLUTION_POLICY_EXPIRED` (`policy.mjs:208-209`)
and the consumer would report `POLICY_UNAVAILABLE` — with no production effect,
because the consumer is already inert on this host.

---

## 4. Which are only human-assigned automation?

Everything in the repository's evolution/memory history:

- 5 evolution cards (loop completion, wiring repair, production activation,
  strategy completion, evidence-feed repair) — all operator-assigned, all
  committed by the operator identity.
- 2 CBM/OMP repair cards (`16638d6`, `fb8ce6a`).
- 1 learning landing (`14a0deb`) — implementation, seam hard-disabled.
- 1 Stage-F re-admission record — governance text, explicitly "authorizes NO
  pipeline implementation".

No commit in the repository carries an agent-authorship trailer; every commit
in every reflog is authored by `zhengfengqing <xonogears@gmail.com>` (prior
audit's forensics, re-verified for the evolution paths).

---

## 5. Which mechanisms never worked?

| Mechanism | Status | Kind of failure |
|---|---|---|
| Natural trigger → candidate → promotion in production | never fired | never configured (`missing: storeRoot, checkpointRoot, repoRoot`) |
| Attribution feed in production | 0 records | same configuration gate |
| Strategy memory in production | 0 observations | same |
| Strategy candidate persistence | not implemented — `deriveStrategyCandidate` returns without writing | code gap (`candidate-strategy.mjs:214`) |
| Strategy consumption | no production caller of `resolveProductionRoute` | code reachability gap |
| Natural error-analysis → repair plan | requires an evidence-bound `patchPlan` that natural journals don't carry; R9 records `UNSUPPORTED` | evidence-shape gap |
| Three of seven trigger classes | `LATENCY_REGRESSION`, `TOKEN_INEFFICIENCY`, `QUALIFIED_PATTERN_EVIDENCE` receive `null` baselines | wiring gap |
| Policy-supplied trigger window | computed, never applied | wiring gap |
| Circuit-breaker recovery | `clearCircuitBreaker` has no call site | operator gap |
| Transfer metrics | `TRANSFER_METRICS_ENABLED = false` | deliberate disablement |
| Incident projection / lifecycle adapter | no production emitter | deliberate boundary |
| OMP native memory/learn | 0 calls, backend off | never enabled |
| Skill auto-creation | not implemented anywhere | absent |
| Prompt evolution | bounded token only | design boundary |

---

## 6. Effect evidence — benchmarks

The only quantitative effectiveness data in the repository is the September 2026
pilot: 105 runs, 3 arms × 7 tasks × 5 runs.

| Arm | n | task_success | hold | repairs (mean) | wall (mean) |
|---|---:|---:|---:|---:|---:|
| `CONTROL` (repair 0) | 35 | 0.8286 | 0.1714 | 0 | 69,835 ms |
| `AUTOLOOP_FRESH` (repair 0, empty store) | 35 | 0.9714 | 0.0286 | 0 | 39,551 ms |
| `LEARNING_PERIOD` (repair 2) | 35 | 1.0000 | 0 | 0.0286 | 51,655 ms |
| `AUTOLOOP_LEARNED` | — | **not run** | — | — | — |

`CONTROL` and `AUTOLOOP_FRESH` are mechanically identical except for the store
root; they differ by 5 of 35 runs, and the project's own documentation treats
that as noise (`docs/benchmark.md:70-79`, §9.1: "any two-arm comparison …
smaller than roughly 5 runs is reporting noise"; §11 forbids the claim
"AegisFlow improves agent performance").

The learned arm was never executed (`docs/benchmark.md:362`: "**NOT MEASURED IN
THE PILOT.**"). Therefore:

- **No measured effect of learning on outcomes exists.**
- The learned strategy store is a builder artifact whose activations bypass
  policy, fitness, review and canary (`build-learned-store.mjs:137`), with
  `evidence_digest: null` on all 21 active values and generation 42.

The only effect with a mechanism-level explanation is structural: a zero repair
budget produces `REPAIR_BUDGET_EXHAUSTED` holds (5/35), which explains the
`CONTROL`/`FRESH` hold gap without invoking learning.

---

## 7. Effect evidence — memory

| Question | Answer |
|---|---|
| Does the memory change agent behaviour? | No measurable evidence. 8 records, 1 retrieval in an OMP session. |
| Does retrieval change outcomes? | Unmeasured. No A/B exists. |
| Is the memory current? | `freshness.stale = true` — indexed tree differs from HEAD. |
| Is the memory trusted? | 6 `REVIEWED`, 2 `UNVERIFIED`; 0 `CONFIRMED`. |
| Does the writeback path run? | Not since 2026-08-16; no production caller supplies a store. |

---

## 8. Cost-benefit

| Item | Cost | Benefit observed |
|---|---|---|
| Evolution subsystem | 6,684 lines, 4,383 test lines, 1 policy + 1 declaration | zero production cycles |
| Learning subsystem | 11,873 lines, 34 test files, 47 MB scratch residue | zero production events |
| Memory subsystem | 5,364 lines, 8 records | memory readable; 1 agent call |
| OMP native memory | 0 config, default off | none |

The evolution and learning subsystems are, today, **maintained capability with no
production utilisation**. That is a legitimate engineering position (the gates
exist before the capability is switched on), but it must not be reported as
demonstrated self-improvement.

---

## 9. Risk notes for any future activation

1. **Configuration is the whole activation switch.** Exporting
   `AEGISFLOW_EVOLUTION_DEPLOYMENT_CONFIG` immediately enables the every-run
   attribution write and the trigger observer. There is no separate "dry-run"
   flag.
2. **Policy expiry is imminent** (2026-10-24). An expired policy yields
   `POLICY_UNAVAILABLE` rather than an error the operator sees in normal runs.
3. **Three trigger classes are structurally silent**, so an activation would
   only ever act on four of the seven declared classes.
4. **Strategy candidates are not persisted**, so a strategy promotion cannot be
   audited from a candidate file the way a source promotion can.
5. **No breaker reset path** exists; a tripped breaker would require manual file
   editing of `evolution-trigger-state.json`, which the operator CLI does not
   support.
6. **The memory provider is not wired at HEAD.** Any activation of evolution
   does not also give the agent memory retrieval; that is a separate,
   currently-unconnected seam.
