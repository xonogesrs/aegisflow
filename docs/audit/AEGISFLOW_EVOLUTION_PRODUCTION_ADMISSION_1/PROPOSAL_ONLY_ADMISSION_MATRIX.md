# Proposal-only admission matrix

**Card:** `AEGISFLOW_EVOLUTION_PRODUCTION_ADMISSION_1`
**Baseline:** `da3a251`
**Question:** is *Proposal-Only Evolution* — analyse results, propose a
concrete improvement with evidence, save it for review, change nothing —
admissible today?

Every row is a required capability for that mode. `MET` means the capability
exists, is reachable from the production path, and was verified. `GAP` means it
is missing or does not hold. `N/A` means proposal-only does not need it.

---

## 1. Scope of the mode under evaluation

| Allowed | Forbidden |
|---|---|
| Read terminal task results and durable evidence | Modify production source |
| Detect recurring problems / deficient strategy dimensions | Change OMP configuration |
| Produce a bounded, deterministic proposal with rationale, expected effect, risk | Install/upgrade tools, enable MCP servers |
| Save the proposal durably for review | Change agent permissions or authority |
| Report it on the operator surface | Commit, push, deploy, or change a running service |

The distinction that matters for admission: proposal-only must be able to
**stop after derivation**. Today it cannot — the loop's next stage is
authorization and mutation, and there is no mode flag, stage ceiling, or
proposal verdict in the closed verdict set (`loop.mjs:54`).

---

## 2. Capability matrix

| # | Capability required for Proposal-Only | Status | Evidence |
|---|---|---|---|
| P1 | Production runs reach the evolution path | GAP (deployment) | `runAdmittedGraph` is the only entry; nothing in this repo invokes it (`scripts/`, `integrations/omp/`, launchd all checked). On this host the config resolves `enabled:false`. |
| P2 | Real task evidence readable, integrity-checked | MET | `readObservationJournal` `production-observer.mjs:81`; `verifyJournal` before use |
| P3 | Evidence is attributed to a real run | MET | `feedStrategyObservationForProduction` `attribution-feed.mjs:293`; dedup by run identity |
| P4 | Synthetic/fixture evidence is excluded before a proposal is produced | GAP | feed excludes (`attribution-feed.mjs:240`); trigger path does not (`production-observer.mjs:137-182`). Measured: synthetic fixture → `PROMOTED` |
| P5 | Minimum-evidence floors prevent single-incident proposals | MET | floors `trigger.mjs` (≥3 per class); `MIN_SAMPLES_FOR_SUFFICIENCY = 3` `strategy-memory.mjs:49` |
| P6 | Proposal is deterministic and auditable | MET | `plan-producer.mjs:77,225` — declared rule table, no model in the path |
| P7 | Proposal carries evidence references | MET | `buildTriggerEvent` `trigger.mjs:517` binds `evidence_refs`; plan carries them |
| P8 | Proposal carries rationale + expected effect + risk | MET | `strategy_plan.rationale`, `measurement_plan`, `risk_class`/`risk_reasons` (`candidate-strategy.mjs:170-210`) |
| P9 | Proposal is persisted durably for review | GAP | source family persists (`candidate.mjs:294`); strategy family returns without writing (`candidate-strategy.mjs:214`). Measured: store unchanged after `CREATED` |
| P10 | Persisted proposal is visible on the operator surface | GAP | `operator-view.mjs:79,169` reads only `evolution-candidates/` → strategy proposals invisible |
| P11 | Derivation alone writes nothing outside the evolution store | MET | derivation is pure; the only store writes are under `storeRoot` |
| P12 | Derivation cannot mutate the repository | GAP (structural) | loop stage 4/7/8 run unconditionally after a PLAN unless an earlier stage HOLDs; no proposal-only ceiling |
| P13 | Cycle can be disabled without affecting normal runs | MET | kill switch `kill-switch.mjs:41,53`; verified `SUSPENDED` with a normal run still `PASS` |
| P14 | Normal operation is unaffected by an evolution failure | MET | `admission-gate.mjs:438-441` fail-open; `R7` PASS |
| P15 | Evolution cannot write EKM, CBM, or OMP state | MET | no EKM/CBM identifier anywhere in `src/evolution`; strategy store is its own file; verified sha256 of EKM db, CBM cache, OMP binary/config unchanged |
| P16 | Evolution cannot exceed the agent's own authority | MET | `src/admission/**` and `src/governance/**` are forbidden by policy schema (`policy.mjs:111-116`) and refused by the classifier (`policy.mjs:431-465`) |
| P17 | Human approval remains the boundary for any code change | MET (for autonomous path it is weaker) | MEDIUM stops at `AWAITING_OPERATOR_PROMOTION` `loop.mjs:446-456`; LOW is autonomous by design |
| P18 | Automatic rollback exists if anything is applied | N/A for proposal-only, MET if enforced | `rollbackCandidate` `canary.mjs:212`; strategy rollback deactivates |
| P19 | Budget/window caps bind in production | GAP | `authorizeUnderPolicy` checks `usage` (`policy.mjs:528-533`) but the production caller never supplies it (`production-consumer.mjs:496-518`, `loop.mjs:305`) |
| P20 | Policy trigger window / thresholds apply | PARTIAL | declaration `thresholds` reaches the observer; `policy.budget.window_ms` is validated and never applied (`policy.mjs:127`) |

---

## 3. Counting

| Status | Count | Items |
|---|---:|---|
| MET | 12 | P2, P3, P5, P6, P7, P8, P11, P13, P14, P15, P16, P18 |
| PARTIAL | 1 | P20 |
| GAP | 6 | P1, P4, P9, P10, P12, P19 |
| N/A | 0 | — |

P1 is a deployment condition, not a code defect: a proposal-only admission can
be granted for a deployment that *does* wire `runAdmittedGraph`, but admission
for *this* deployment cannot claim reachability it does not have. P4, P9, P10
and P12 are code-level gaps that block the mode regardless of deployment.

---

## 4. Three blocking gaps, stated precisely

**G1 — synthetic evidence reaches derivation (§P4).**
The feed refuses synthetic records; the trigger evaluator does not. A fixture
run with synthetic repair events produced a PLAN, a candidate, a mutation, a
fitness ACCEPT, a review PASS, a promotion and a canary record. In proposal-only
that becomes a fabricated proposal. *Evidence gate: FAIL.*

**G2 — a proposal is not durable (§P9, §P10).**
`deriveStrategyCandidate` returns a candidate object and writes nothing. The
operator view and crash recovery read the source-candidate directory only. A
proposal that is not persisted cannot be reviewed, and its disappearance is
silent. *Proposal gate: FAIL.*

**G3 — there is no proposal-only stop (§P12).**
After a PLAN the loop proceeds to authorization, mutation, fitness, review and
promotion. The only early exits are HOLD conditions. There is no declared
verdict meaning "proposal saved, nothing applied". *Isolation gate: FAIL for
the mode as specified, even though mutation is isolated.*

---

## 5. What the matrix permits today

A **manual, operator-driven research run** — execute `produceImprovementPlan`
against a copy of the strategy memory and read the result — is safe and is
already possible without touching evolution state. That is not production
Evolution; it is an analyst workflow.

No autonomous production mode is admissible until G1–G3 are closed. Once they
are, proposal-only remains admissible only with:

- the kill switch as the disable path (already present),
- the existing policy gate as the only authority (unchanged),
- no mutation authorization, no branch, no strategy activation, no commit.
