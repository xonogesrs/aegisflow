# AUTOLOOP AGENT-STRATEGY EVOLUTION — PRODUCTION ACTIVATION RERUN 1

Card: `AUTOLOOP_AGENT_STRATEGY_EVOLUTION_PRODUCTION_ACTIVATION_RERUN_1`
Date: 2026-09-24
Baseline HEAD: `bde34fb`
Predecessors:
- `AUTOLOOP_AGENT_STRATEGY_EVIDENCE_FEED_REPAIR_1` (PASS — repair_commit `6cefe1a`)
- `AUTOLOOP_AGENT_STRATEGY_EVOLUTION_PRODUCTION_ACTIVATION_1` (measured `REPAIR_REQUIRED`)

Verdict: **PASS** (`PRODUCTION_ACCEPTED_WITH_CROSS_AGENT_EVOLUTION`).

---

## A — repair landing

The repair landed as ONE commit containing exactly the repair scope:

```
REPAIR_COMMIT = 6cefe1a780320af02e3eedba942ff6b2c8edd7d8
```

| In the commit | Out of the commit (unrelated WIP, preserved) |
|---|---|
| `src/evolution/attribution-feed.mjs` (new) | `docs/pi-graph-output/**` working-tree edits |
| `src/evolution/production-declaration.mjs` (new) | untracked `docs/pi-graph-output/pre-wp1-probe-*.json` |
| `src/evolution/{policy,strategy-memory,production-consumer,production-observer,operator-view}.mjs` | untracked `docs/pi-graph-output/wp1-f-continuity-*.json` |
| `src/admission/admission-gate.mjs`, `src/schema/evolution-policy.schema.json` | |
| `scripts/{evolution-issue-policy,evolution-declare-production}.mjs` | |
| `test/evolution/test-agent-strategy-evidence-feed-repair.mjs` (new) | |
| `AGENTS.md`, `docs/governance/{…evidence-feed-repair-1, …evolution-completion-1, …autonomous-evolution-production-activation-1}.md` | |

Nothing was pushed. `NORMAL_OPERATION` semantics are untouched by the diff
(the feed is wired inside admission, post-result; the runner, budget, closeout
and verdict paths are byte-identical).

## B — policy state

`readEvolutionPolicy(<production store>, { allowExpired: true })` +
`validatePolicyShape` + digest recomputation:

| Field | Value |
|---|---|
| generation | **1** (ACTIVE) |
| `strategy_dimensions_allowed` | `MODEL_ROUTING`, `RETRY_REPAIR` |
| `policy_digest` | `964fb18a7aa6948bdabcebfa5e8fa4985040396580cb9ed64c401dadbadc89fe` (recompute MATCHES) |
| `policy_id` | `c011379902971d346cd5f1dff94196d35c358632757acc3deb5a81242e0741cf` (recompute MATCHES) |
| `issued_by` / `authorization_ref` | `operator:autoloop-agent-strategy-evolution-production-activation-1` / `autoloop://governance/AUTOLOOP_AGENT_STRATEGY_EVOLUTION_PRODUCTION_ACTIVATION_1` |
| shape validation | no errors |
| archive lineage | gen 0 preserved at `<store>/evolution-policy.gen0.json` (shape-valid, digest recompute MATCHES, `strategy_dimensions_allowed: null`) |

No successor was issued: gen 1 is valid, digest- and authority-correct, and
preauthorizes exactly the two LOW agent-strategy dimensions this card activates.
The successor path (`--successor`, history under
`<store>/evolution-policy-history/`) exists and is exercised by F9 but was not
needed — re-issuing without a reason is what the card forbids. gen 0 predates
that path, so it lives under its legacy file name; no manual re-archiving was
performed (manual archiving is not a supported operation).

## C — production declaration

Authored with `scripts/evolution-declare-production.mjs` (exclusive-create,
validated), read back through `resolveEvolutionProductionConfig`:

```
/Volumes/NVM2T/Development/evidence/autoloop-evolution/production-declaration.json
```

| Input | Declared value |
|---|---|
| storeRoot | `/Volumes/NVM2T/Development/evidence/autoloop-evolution` |
| checkpointRoot | `/Volumes/NVM2T/Development/evidence/autoloop-evolution/checkpoints` |
| repoRoot | `/Volumes/NVM2T/Development/repos/autoloop` |
| taskClass | `AUTOLOOP_CARD` |
| strategyBaselineValues | `MODEL_ROUTING=deepseek/deepseek-v4-flash`, `RETRY_REPAIR=max_attempt_1` |
| strategyDimensions | `MODEL_ROUTING`, `RETRY_REPAIR` |
| reviewerIdentity | `reviewer:evolution-fitness-gate` |

* `checkpointRoot` is the C2D checkpoint root for evolution executions; the
  directory does not need to pre-exist — `initExecutionDir` creates it (mode
  0700) on the first mutation cycle, and the alias/symlink fence applies.
* `MODEL_ROUTING` baseline = the deployment's **pinned** transport
  (`src/v2/pi-transport-adapter.mjs`: provider=deepseek, model=deepseek-v4-flash,
  no fallback) — not the "most-observed" heuristic.
* `RETRY_REPAIR` baseline = the deployment's **pinned** repair budget
  (`maxRepairAttempts = 1`, `src/autoloop.mjs`).
* `reviewerIdentity` is the operator-designated independent review identity for
  evolution promotions. It is NOT the implementing pipeline identity: the
  SELF-APPROVAL fence still refuses `agent:*` and `autoloop-evolution`
  (`promotion.mjs`). Declaring it is the operator act that makes the
  policy-preauthorized LOW promotion path reachable in production; without it
  the loop stops at `PROMOTION_HELD` ("no independent review PASS bound").

Re-declaring the identical record returns `UNCHANGED_IDENTICAL`; a conflicting
one fails closed (`EVOLUTION_DECLARATION_CONFLICT`). A malformed declaration is
fail-open but surfaces in the resolved config and the operator report
(`DEPLOYMENT_DECLARATION_INVALID`).

## D — every-run attribution (live, through `runAdmittedGraph`)

Controlled production-like acceptance (`runAdmittedGraph` only, configured from
the declaration above through `AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG`; no memory
fixture written anywhere):

| Run | Feed disposition | Consumer disposition |
|---|---|---|
| 3 × healthy, non-firing | `RECORDED` (1 observation each) | `NO_QUALIFIED_TRIGGER` |
| 3 × deficient (repairs, HOLD) | `RECORDED` | third ⇒ `CYCLE_STARTED` (trigger eligibility) |

The memory holds exactly one observation per production run (6/6), each bound
to the admitted provider/model and the run identity. `HOLD` verdicts were
unchanged by the feed.

## E — MODEL_ROUTING = AUTONOMOUS

Policy gen 1 preauthorizes `MODEL_ROUTING`; `classifyCandidateRisk` gives a
`strategy://` surface LOW, and `authorizeUnderPolicy` sets
`promotionRequiresOperator: false` only for MEDIUM — so a LOW strategy candidate
has no operator promotion step.

Through the production entrypoint (agent A = GLM deficient arm, agent B =
deepseek healthy arm, both written by real runs): performance comparison →
candidate → fitness `ACCEPT`/`IMPROVED` → **`PROMOTED`** → the task class
resolves the promoted route (`source: STRATEGY`, `deepseek/deepseek-v4-flash`)
for future executions.

Authority precedence holds: `resolveProductionRoute(..., explicitBinding: GLM)`
returns `source: EXPLICIT` — the admitted `provider_binding` remains the only
execution-time provider authority and a strategy preference can only choose
inside the supported route registry. An unrelated task class stays `DEFAULT`.

## F — RETRY_REPAIR = AUTONOMOUS

Same lane, same evidence rules: repeated repair evidence (baseline arm
`max_attempt_3`, candidate arm `max_attempt_4`, both written by production runs)
→ bounded candidate → fitness `ACCEPT` → **`PROMOTED`** → the value is ACTIVE
in the strategy store for the task class.

The existing retry/repair hard bounds are not breached: the promoted value stays
inside `BOUNDED_STRATEGY_PARAMS.RETRY_REPAIR` (`0..5`), and
`validateStrategyValue("RETRY_REPAIR", { max_attempts: 99 })` is refused.

## G — PROMPT_EVOLUTION boundary = MEDIUM

`PROMPT_EVOLUTION` has risk floor MEDIUM in `BOUNDED_STRATEGY_PARAMS` and
`classifyStrategyRisk` returns MEDIUM for it, so a candidate over it is
representable, derivable and evaluable — but never autonomously promotable.
Verified live over production-run evidence (declared prompt profiles A/B):

| Step | Result |
|---|---|
| DETECT + DERIVE | a prompt-profile plan IS produced from the production-written arms (`prompt_PROF_A` → `prompt_PROF_B`) |
| classify | the derived candidate is `MEDIUM` |
| EVALUATE | `evaluateStrategyFitness` computes a full verdict/evidence record |
| PROMOTE (production policy) | **refused**: `HOLD / EVOLUTION_RISK_CLASS_REFUSED` at the `authorization` stage ("risk class MEDIUM not allowed by policy (allowed: LOW)"), no candidate identity minted, nothing activated |
| PROMOTE (operator-widened MEDIUM policy) | stops at `AWAITING_OPERATOR_PROMOTION`, strategy generation stays 0, no active value |

Two independent fences, therefore: the production policy artifact cannot allow
MEDIUM at all (the issuance lane is LOW-only and
`risk_classes_allowed: ["LOW"]` is what gen 1 carries), and even a deliberately
operator-widened MEDIUM policy stops at the operator promotion boundary. Plus
S13 (candidate-level) and P14 (policy-level).

## H — cross-agent transfer

Agent A/B production observations → performance memory → promoted strategy →
future execution resolution, proven **from the production entrypoint**
(`runAdmittedGraph`), not by direct internal invocation standing in for the
execution:

1. agent A (GLM) and agent B (deepseek) evidence is written by real
   `runAdmittedGraph` runs — no fixture;
2. the comparison → candidate → fitness `ACCEPT` → `PROMOTED` cycle runs on that
   evidence and the task class resolves the promoted route;
3. a **new Agent C production run** is then executed: its admission binding is
   resolved by the deployment's admission-construction seam
   (`resolveProductionRoute`, which returns `source: STRATEGY` for the promoted
   route), and the run itself goes through `runAdmittedGraph`. Agent C's **own**
   production attribution — derived from the ADMITTED `provider_binding` —
   reports `strategy.MODEL_ROUTING = deepseek/deepseek-v4-flash` and provider/
   model `deepseek/deepseek-v4-flash`, i.e. agent C really executed under the
   strategy learned from agents A/B.

The durable canary record for the promoted candidate binds
`promotion_kind: AGENT_STRATEGY`, the promoted value and the `fitness_digest`
that authorized it.

Boundaries (stated, not hidden):

* The route resolution seam (`resolveProductionRoute` /
  `selectRouteForTaskClass`) has **no in-repo production caller** — it is the
  deployment-facing API a deployment calls when it constructs an admission with
  an OPEN provider binding. It is therefore exercised here as the deployment
  would call it; the execution half is proven through `runAdmittedGraph`.
* Routing only chooses; it never overrides. A run whose admission already
  carries an explicit `provider_binding` keeps it
  (`source: EXPLICIT`, verified), and a preference outside
  `SPAWN_RUNTIME_CAPABILITIES` is refused. The admitted `provider_binding`
  remains the sole execution-time provider authority.

## I — natural operation

No production failure was manufactured. The acceptance above is a controlled
production-like acceptance (explicitly allowed) against temporary stores; the
real production store was read only.

```
FIRST_NATURAL_CROSS_AGENT_EVOLUTION = NOT_YET_TRIGGERED
```

(Read from the production store through the operator surface: 0 strategy
observations, 0 triggers, 0 derivations, strategy generation 0 — no natural
cross-agent evidence has accumulated yet. This is not a HOLD.)

## J — failure semantics

| Requirement | Evidence |
|---|---|
| memory/feed failure ⇒ run unaffected | **live fault injection**: with the durable store made unwritable the run's feed disposition is `FEED_FAILED` (marked as a failure), the run's verdict/nodeResults/closeout are byte-identical to a control run, the trigger path still runs independently, no observation is fabricated, and the unwritable store is reported (`feed_log_written: false`) rather than claimed; with only the memory path blocked the durable feed log carries the failure (`failures.total ≥ 1`, `failures.last.disposition = FEED_FAILED`). Plus F7 |
| strategy-evolution failure ⇒ run unaffected | R7, R11 (run PASS, consumer disposition recorded) |
| kill switch suspended ⇒ no new strategy cycle | **live CLI check**: `evolution-kill-switch.mjs --suspend` ⇒ the run's feed disposition is `SUSPENDED`, the memory stays empty (even for a QUALIFIED deficient run), the consumer reports `SUSPENDED`, and the run's own verdict is untouched; `--resume` restores recording. Plus R6, P12 |
| duplicate / resume ⇒ no duplicate sample | F3, F4, F4b. **live**: re-observing the same authoritative run with the identical admission yields `EXISTING` with the SAME `observation_id` and no new sample; a resume whose durable evidence was EXTENDED is refused as an identity conflict (`OBSERVATION_REJECTED`, `conflict: true`) and still does not double count |
| policy mismatch ⇒ fail closed | S16 (a dimension the policy does not preauthorize ⇒ the strategy candidate is refused). **live**: a successor issuance whose `--previous-digest` does not match the active generation exits 1 with `HOLD / EVOLUTION_POLICY_SUCCESSION_MISMATCH`, the active policy is unchanged and no archive entry is written |
| HIGH risk ⇒ deny before mutation/promotion | S6, P14 (HIGH classes structurally denied; wildcard scope refused) |

## K — operator surface (read-only)

`node scripts/evolution-operator.mjs --store <dir> [--json]` reports policy
generation/history, the resolved production declaration, the strategy memory
(sample counts per task class), the active strategy per task class/dimension
(with candidate id + generation), the attribution feed counters + failures,
candidates, reviews (promotion), canary, rollbacks and the circuit breaker.
Verified over a populated store (candidate → review PASS → activation → canary →
rollback, genuine modules): the strategy candidate (id + value + generation),
its `PASS` review binding, its canary window, its pre-rollback `promoted: true`,
its active-strategy entry, the activation history, the rollbacks list, the
circuit-breaker state and the text surface are all visible — 14/14 checks. After
the rollback the report truthfully shows the candidate as no longer promoted,
the canary as rolled back, and the pre-promotion baseline restored.

Boundary: the report's `canary` section summarizes verdict/rollback; the
`fitness_digest` that authorized a strategy promotion is bound durably in
`<store>/canary/<candidate>.json` rather than printed. No repair required — the
gate set is visible and the fitness binding is durable and readable.

## L — regression

| Floor | Result |
|---|---|
| evolution (`test/evolution/*.mjs`) | **68/68 PASS** |
| controlled production-like acceptance (throwaway probe, not committed) | **130/130 PASS** |
| admission + governance + telemetry + evidence + budget + control-plane + rollover (1100 tests) | **1100/1100 PASS** |
| memory + learning + learning-lifecycle (1095 tests) | 1089/1095 — 6 failures, all the same pre-existing `current-verification.mjs` reachability-scan family, reproduced identically on a pristine `bde34fb` worktree (see below) |
| v2 relevant: production-pipeline + pipeline + orchestrator + production-chain-r2 + checkpoint-bridge + durable-execution + run-evidence-store + run-manifest | **96/96 PASS** (33 + 63) |
| v2 full floor (`--test-concurrency=1`, canonical `COLIMA_HOME`) | **661/661 PASS** (no failure; the pre-repair baseline recorded 660/661 with the E2 marker race) |
| `npm run check` | PASS |

### Pre-existing failures (NOT regressions)

All six are the *same* structural family: a "production reachability must be
zero" scan whose expectation was invalidated by the earlier learning landing
(`14a0deb feat(learning): land governed learning lifecycle, pattern
consolidation, and R2 memory/writeback lineage`), which introduced
`src/learning/incidents/current-verification.mjs` (a module that imports the
transfer-metrics stack) and added
`import { TRANSFER_CODES } from "../../learning/transfer-metrics/schema.mjs"`
to `src/learning/lifecycle/state-machine.mjs`.

| Test | File | Offenders (identical at `bde34fb`) |
|---|---|---|
| T82 | `test/learning/test-incident-current-verification.mjs` | 4 files, all carrying the literal `learning/` from the **pre-existing** `src/learning/lifecycle/**` forbidden-pattern literal: `src/evolution/policy.mjs`, `src/memory/contract.mjs`, `src/memory/retrieval.mjs`, `src/memory/writeback/gate.mjs` |
| T43, T44 | `test/learning/test-incident-observation-profile.mjs` | `src/learning/lifecycle/state-machine.mjs` (`learning/transfer-metrics` needle) |
| 1R reachability | `test/learning/test-incident-observation-profile-1r.mjs` | same file |
| R57, R58 | `test/learning/test-learning-authority-durability-1r.mjs` | `src/learning/incidents/current-verification.mjs` imports `transfer-metrics/authority-state` and calls `readCurrentLearningAuthorityState` |

`git diff --name-only bde34fb..HEAD -- src/learning` is **empty** — the repair
touches nothing in the learning tree, and `git show bde34fb:src/learning/lifecycle/state-machine.mjs`
contains the same line 63 at the baseline.

**Reproduced on a pristine `bde34fb` worktree** (`git worktree add --detach …`,
canonical `COLIMA_HOME`): the SAME six tests fail there — 281/287 in the
targeted learning files. The T82 offender set was additionally compared
**item-for-item** on both trees: 4 offenders on each, the same four files
(`src/evolution/policy.mjs` included, from the pre-existing forbidden-pattern
literal at baseline). Every repair-changed file was also swept against the five
scanners' needles (`learning/transfer-metrics`, `getTransferMetricsWriter`,
`recordTransferEvent`, `appendTransferEvent`, `INCIDENT_OBSERVED`,
`readCurrentLearningAuthorityState`, `current-verification`,
`incidents/projection`, `lifecycle-terminal-adapter`, `source_identity_key`,
`deriveSourceIdentityKey`): **zero** hits. The repair therefore adds no
reachability offender; these tests were failing before this card. Fixing them
would mean editing the learning landings' expectations, which is out of this
card's scope. They are environment/history-bound and NOT release blockers: the
v2 full floor is 661/661 and every floor that touches this card's surfaces is
fully green.

Note: in this environment the R-15 write-back-authority cases
(`HOLD / COLIMA_HOME_NOT_CANONICAL`) PASS once the canonical `COLIMA_HOME` is
set — the Colima daemon is running here — so they are not in the list above.

## Card result

```
CARD = AUTOLOOP_AGENT_STRATEGY_EVOLUTION_PRODUCTION_ACTIVATION_RERUN_1
VERDICT = PASS
REPAIR_LANDED = YES
REPAIR_COMMIT = 6cefe1a780320af02e3eedba942ff6b2c8edd7d8

POLICY_STATE = GEN_1_ACTIVE (MODEL_ROUTING, RETRY_REPAIR; digest+authority verified; gen 0 archived)
PRODUCTION_DECLARATION = DECLARED (storeRoot/checkpointRoot/repoRoot/taskClass/strategyBaselineValues read via AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG)

EVERY_RUN_ATTRIBUTION = PASS
HEALTHY_MEMORY_FEED = PASS (healthy non-firing run → RECORDED + NO_QUALIFIED_TRIGGER)
DEFICIENT_MEMORY_FEED = PASS (deficient run → RECORDED + trigger eligibility)

MODEL_ROUTING_AUTONOMOUS = ENABLED
RETRY_REPAIR_AUTONOMOUS = ENABLED
PROMPT_EVOLUTION_BOUNDARY = MEDIUM

CROSS_AGENT_TRANSFER = PASS
AGENT_STRATEGY_FITNESS = PASS (ACCEPT on production-written A/B arms; guards PASS)
OPERATOR_VISIBILITY = PASS
FAIL_OPEN = PASS
KILL_SWITCH = PASS
CRASH_RESUME = PASS

FIRST_NATURAL_CROSS_AGENT_EVOLUTION = NOT_YET_TRIGGERED

NORMAL_OPERATION_IMPACT = NONE
RELEASE_BLOCKERS = 0

COMMIT = 6cefe1a780320af02e3eedba942ff6b2c8edd7d8 (repair)
RECORD_COMMIT = the commit carrying this record (its own id is omitted: it is not fixed-point stable)
PUSH = NO

AUTOLOOP_STATUS = PRODUCTION_ACCEPTED_WITH_CROSS_AGENT_EVOLUTION
NEXT = NORMAL_OPERATION
```

## Operator actions

```
# read-only
node scripts/evolution-operator.mjs --store /Volumes/NVM2T/Development/evidence/autoloop-evolution [--json]
# kill switch
node scripts/evolution-kill-switch.mjs --store <dir> --suspend|--resume|--status
# successor policy generation (not needed for gen 1)
node scripts/evolution-issue-policy.mjs --store <dir> --successor [--previous-digest <64hex>]
# the production declaration (already authored; idempotent)
export AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG=/Volumes/NVM2T/Development/evidence/autoloop-evolution/production-declaration.json
```
