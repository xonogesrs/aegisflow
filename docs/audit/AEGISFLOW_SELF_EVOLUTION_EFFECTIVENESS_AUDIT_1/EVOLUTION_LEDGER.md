# Evolution ledger

**Card:** `AEGISFLOW_SELF_EVOLUTION_EFFECTIVENESS_AUDIT_1`
**Mode:** READ-ONLY. **Baseline:** `1301bb1`.

Every row below is an event or a mechanism for which evidence exists. Ordinary
engineering cards, operator-assigned repairs, and bare memory writes are **not**
counted as autonomous evolution; where they appear they are labelled
`CONFIRMED_ASSISTED_CHANGE` or `MEMORY_ONLY`.

Grades (fixed vocabulary, not widened):

- `CONFIRMED_EVOLUTION` — autonomous trigger + actual mutation + validation + persistence.
- `CONFIRMED_ASSISTED_CHANGE` — user/operator-assigned or human-approved agent change.
- `PROPOSAL_ONLY` — a proposal or a demonstration, no landed effect.
- `MEMORY_ONLY` — knowledge saved, no demonstrable improvement.
- `UNUSED_BUT_AVAILABLE` — usable, no observed use.
- `UNKNOWN` — insufficient evidence.

---

## 1. Ledger

| ID | Trigger | Initiator | Proposal | Mutation | Validation | Persistence | Effect | Current status | Grade | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| **EV-01** | Operator card `AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1` | Operator-assigned | Build a policy-preauthorized autonomous loop over existing C3B machinery | `src/evolution/{policy,candidate,mutation,fitness,promotion,canary,operator-view}.mjs` added | `test/evolution/test-evolution-loop.mjs` N1–N9; 28/28 in that suite at the time | Commit `3e827b5` ancestry; code present at `1301bb1` | Machinery exists; no cycle fired | Still present, unused in production | `CONFIRMED_ASSISTED_CHANGE` | archived `autoloop-autonomous-evolution-loop-completion-1.md` §B; `git log -- src/evolution` |
| **EV-02** | Audit finding "zero production callers" | Operator-assigned repair | Wire the loop to `runAdmittedGraph` post-result | `src/evolution/production-consumer.mjs`; gate wiring `admission-gate.mjs:397-441` | `test-evolution-production-wiring-repair.mjs` R1–R11 | Commit `e56f894` | A cycle *would* be scheduled if declared | Present; inert without declaration | `CONFIRMED_ASSISTED_CHANGE` | `e56f894` body; `production-consumer.mjs:495` |
| **EV-03** | First production activation claimed closed route | Operator-assigned | Activate production evolution | `3e827b5` + policy issuance | 12 negative cases P3–P11; route later found NOT closed and repaired | Commit `3e827b5`; policy gen 0 | Claim corrected by audit addendum | Superseded by EV-02 | `CONFIRMED_ASSISTED_CHANGE` | archived `…production-activation-1.md` §"PRODUCTION_EVOLUTION_ROUTE_PREVIOUS = NOT_ACTUALLY_CLOSED" |
| **EV-04** | Cross-agent audit: agent-level attribution absent | Operator-assigned | Add attribution, plan producer, strategy fitness, transfer | `attribution.mjs`, `plan-producer.mjs`, `strategy-memory.mjs`, `fitness-strategy.mjs`, `candidate-strategy.mjs` | `test-agent-strategy-evolution.mjs` S0–S17 | Commit `5c4ef6d` | Strategy dimension representable and evaluable | Present; no natural activation | `CONFIRMED_ASSISTED_CHANGE` | `5c4ef6d` body; archived completion record |
| **EV-05** | Measured selection bias: memory only saw deficient runs | Operator-assigned | Move attribution ahead of trigger evaluation; every-run feed | `attribution-feed.mjs` new; `strategy-memory` identity by run | `test-agent-strategy-evidence-feed-repair.mjs` F1–F10b | Commit `6cefe1a` | Healthy runs now recorded when configured | Present; not configured | `CONFIRMED_ASSISTED_CHANGE` | `6cefe1a` body; `attribution-feed.mjs:293` |
| **EV-06** | Operator act (policy issuance) | Operator | Authorise `MODEL_ROUTING`, `RETRY_REPAIR` at LOW | `evolution-policy.json` gen 1 | Digest/shape validation in acceptance rerun | `/Volumes/NVM2T/Development/evidence/autoloop-evolution/evolution-policy.json` (sha256 `1a8d6d57…`) | Authorisation exists | **ACTIVE** until `2026-10-24T10:56:29Z`, then HOLD | `CONFIRMED_ASSISTED_CHANGE` | policy file; `policy.mjs:200-215` |
| **EV-07** | Operator act (deployment declaration) | Operator | Declare store/checkpoint/repo, baselines, reviewer | `production-declaration.json` | Read back through `resolveEvolutionProductionConfig` (verified: `enabled:true` when exported) | sha256 `63dfa6ff…` | Makes production evolution reachable *if exported* | Present; not exported by any live process | `CONFIRMED_ASSISTED_CHANGE` | declaration file; `production-consumer.mjs:161-211` |
| **EV-08** | Controlled acceptance (agents A/B) | Operator-assigned acceptance | Prove cross-agent strategy transfer | Temporary strategy activation + a new run resolving the route | Governance rerun §E/§H | **Temporary store only** — production store has no `strategy-policy.json` | Demonstrated mechanism, no retained effect | Not in effect | `CONFIRMED_ASSISTED_CHANGE` (demonstration; persistence absent) | archived `…activation-rerun-1.md` §E/§H; store listing (3 files only) |
| **EV-09** | Benchmark pilot | Operator-assigned | Measure learning machinery | `benchmarks/results/learned-strategy-store/strategy-policy.json` gen 42, 21 active values | `analysis.json`; docs reject success claims as variance | Commit `924b797` | A benchmark artifact, gates bypassed by the builder | Present as data | `PROPOSAL_ONLY` | `build-learned-store.mjs:137`; `docs/benchmark.md:362,442` |
| **EV-10** | Learning landing card | Operator-assigned | Governed learning lifecycle, pattern consolidation, writeback lineage | `src/learning/**`, `src/memory/writeback/**` | 1,095-test floor recorded | Commit `14a0deb` | Measurement plane; seam hard-disabled | **DISABLED** | `CONFIRMED_ASSISTED_CHANGE` (not evolution) | `seam.mjs:7`; `14a0deb` |
| **EV-11** | Live store could not open; agent had no memory tool | Operator-assigned repair | Forward-only migration + `cbm_query` | `sqlite-schema` migration; `integrations/omp/extensions/cbm-query.js` | 10 tests + live byte-copy verification | Commits `16638d6`, `fb8ce6a` | Memory readable inside OMP sessions | Deployed byte-identical; **1** observed call | `CONFIRMED_ASSISTED_CHANGE` (tooling, not evolution) | `16638d6`/`fb8ce6a` bodies; sha256 match |
| **EV-12** | Repository identity drift | Operator-assigned repair | Declared lineage aliases | `src/memory/repository-aliases.mjs` + CLI | 10 lineage tests; live query returns 1 of 8 records (5 excluded by validity) | Commit `fb8ce6a`; `~/.autoloop/memory/repository-aliases.json` | Records reachable again | **In effect** | `CONFIRMED_ASSISTED_CHANGE` (repair) | `memory:lineage` output; query `selected:1,totalCandidates:8` |
| **EV-13** | Governance re-admission card (Stage-F N-2d) | Human mint | Re-admit self-evolution into the admission track | Document only — "authorizes NO pipeline implementation" | Recorded regressions; zero code paths | Evidence bundle `AUTOLOOP-V1-STAGE-F-SELF-EVOLUTION-RE-ADMISSION-1-20260911T172110Z` | Admission state changed on paper | Track admitted; no capability added | `PROPOSAL_ONLY` | `RE-ADMISSION-RECORD.md` §21 + boundary note |
| **EV-14** | — | — | Skill auto-creation / skill improvement | **None** | — | — | — | Not implemented | `UNKNOWN` (absent) | repo-wide: no skill writer, no `SKILL.md`; `manage_skill` = 0 calls |
| **EV-15** | — | — | Prompt self-editing | `PROMPT_EVOLUTION` declared as a bounded token only; MEDIUM, operator promotion required | Unit tests S-series | `strategy-store.mjs:86-99` | Cannot read or emit prompt text | Inert | `UNUSED_BUT_AVAILABLE` | `candidate-strategy.mjs:34`; issuance lane refuses it |
| **EV-16** | — | — | Automatic error analysis → repair proposal from natural evidence | `plan-producer.mjs` requires an evidence-bound `patchPlan`; natural runs don't carry one | R9: qualified signal without plan → `UNSUPPORTED` | — | No natural candidate ever derived | Never fired | `UNUSED_BUT_AVAILABLE` | `production-activation` R9; `plan-producer.mjs:233-241` |
| **EV-17** | — | — | Autonomous promotion of a source candidate | `promotion.mjs` + `mutation.mjs` | N2/P4/R1 in isolated fixtures | No `evolution/<id>` refs exist anywhere | Nothing promoted | Never fired | `UNUSED_BUT_AVAILABLE` | `git for-each-ref` → no evolution refs; store has no `candidates/` |
| **EV-18** | — | — | Canary + rollback | `canary.mjs` | P10/P13 | No `canary/` in store | Nothing canaried | Never fired | `UNUSED_BUT_AVAILABLE` | store listing |
| **EV-19** | — | — | Kill switch + circuit breaker | `kill-switch.mjs`, `trigger.mjs` | P11/P12/R6 | No `evolution-suspended.json`; no trigger state | Idle | Never engaged | `UNUSED_BUT_AVAILABLE` | store listing; `clearCircuitBreaker` has 0 call sites |
| **EV-20** | — | — | OMP native memory/learn | OMP built-ins, backend default off | — | `~/.omp/agent/config.yml` (no memory/autolearn keys) | — | Never used | `UNUSED_BUT_AVAILABLE` | 0 calls in 1,740 sessions |
| **EV-21** | — | — | CBM knowledge retention | 8 records written by 4 graph runs (2026-08-07…16) | Records read back; retrieval returns 1 | `~/.autoloop/memory/memory.db`, `journal.jsonl` | Knowledge saved | **In effect** (read-only) | `MEMORY_ONLY` | `memory_records` query; journal |
| **EV-22** | — | Third party | Jev skill recommendation | none | prior audit: suggestions uncallable (`/skill:skill:`) | — | — | Defect recorded, not repaired | `UNUSED_BUT_AVAILABLE` | prior audit `ROOT_CAUSE_CANDIDATES.md` §A |

---

## 2. Counts

| Grade | Rows |
|---|---:|
| `CONFIRMED_EVOLUTION` | **0** |
| `CONFIRMED_ASSISTED_CHANGE` | 10 (EV-01…EV-08, EV-10…EV-12) |
| `PROPOSAL_ONLY` | 2 (EV-09, EV-13) |
| `MEMORY_ONLY` | 1 (EV-21) |
| `UNUSED_BUT_AVAILABLE` | 8 (EV-15…EV-20, EV-22, minus EV-14) |
| `UNKNOWN` / absent | 1 (EV-14) |

Note on EV-08: it is the strongest evidence the *machinery* can transfer a
strategy between agents, but it is an operator-constructed acceptance run whose
artifacts live in a temporary store. It is not counted as autonomous evolution.

---

## 3. Why no row is `CONFIRMED_EVOLUTION`

`CONFIRMED_EVOLUTION` requires **all four**: an autonomous (non-operator) trigger,
an actual mutation, validation, and persistence.

- **Trigger:** the production store contains zero trigger records
  (`evolution-trigger-state.json` absent), zero derivations, generation `null`.
  The operator surface reports `triggers.count = 0`, `candidates = []`,
  `strategy.generation = 0`, `attributionFeed.total = 0`.
- **Mutation:** no `evolution/<candidate>` branch or commit exists in any ref
  (`git for-each-ref | grep evolution/` → empty).
- **Validation:** only test suites and controlled acceptance runs executed the
  validation stage.
- **Persistence:** the only durable evolution artifacts are the policy and the
  declaration — both operator acts, not evolution outcomes.

The closest approximation is EV-08, and it fails the autonomy and persistence
tests.

---

## 4. Non-ledger evidence that must not be misread

| Artifact | Why it is not an evolution | Evidence |
|---|---|---|
| `benchmarks/results/learned-strategy-store/*` | builder calls `activateStrategyValue` directly, no policy/fitness/review/canary; `evidence_digest: null` | `build-learned-store.mjs:137-150` |
| `~/.autoloop/learning/scratch/**` (1,676 dirs, 11,210 files, 47 MB) | test-fixture roots produced by `createTestRoot`; all events carry `authority.role: fixture`, `applicability_decision: UNKNOWN` | `fixtures.mjs:95-113`; measured 3769 events, 0 production producers |
| `~/.autoloop/memory/memory.db` (8 records) | writeback gate output from 4 graph runs in Aug 2026; no learning loop | `memory_records` timestamps 2026-08-07 → 2026-08-16 |
| Archived governance records | describe implementation and acceptance, not autonomous outcomes | `…production-activation-1.md` §F `FIRST_LIVE_EVOLUTION = NOT_YET_TRIGGERED`; rerun §I `FIRST_NATURAL_CROSS_AGENT_EVOLUTION = NOT_YET_TRIGGERED` |

---

## 5. Open questions carried forward

| ID | Question | Why unresolved |
|---|---|---|
| Q1 | Would a declared deployment produce a natural trigger? | Requires a dynamic run; this card forbids one. P-series/R-series prove the path synthetically. |
| Q2 | Do natural HOLD runs carry a bounded `patchPlan`? | The producer consumes `triggerEvent.observation.patchPlan`; no production journal was observed carrying one. |
| Q3 | Is the missing production memory provider intended? | `251d9ae` (provider construction) is on an unmerged branch; the current lineage has none. |
| Q4 | Who clears a tripped circuit breaker? | `clearCircuitBreaker` is exported but never called. |
| Q5 | Why is `windowMs` from policy thresholds unused? | Computed at `trigger.mjs:263`, never applied by `extractTriggerObservations`. |
