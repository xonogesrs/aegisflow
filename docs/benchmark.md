# Benchmark: methodology and results

A reproducible effectiveness measurement of AutoLoop's strategy/evolution
features. The harness, task set, raw results and analysis code are all in
[`benchmarks/`](../benchmarks/README.md).

**Read the sample sizes before quoting any number below.** This is a pilot at
the minimum defensible scale, not a study.

---

## 1. What is being compared

Same tasks, same agent runtime (`pi`), same provider route, same acceptance
criteria, same allocation. Only the strategy/evolution features differ.

| Arm | Strategy features | Meaning |
|---|---|---|
| `CONTROL` | **off** | deployment-default route, fixed repair budget, full admitted tool subset |
| `AUTOLOOP_FRESH` | on, empty strategy store | T0: the machinery is live but has learned nothing |
| `AUTOLOOP_LEARNED` | on, populated store | T1: after a learning period |
| `LEARNING_PERIOD` | — | **not compared.** An exploration sample that runs an alternative strategy value so the store has evidence to learn from (§8). |

### Why a learning period is a separate sample

A strategy store can only propose a change to a value it has *observed*. If
every sample runs the same value, the memory sees only that value and no
candidate is possible — the autonomy has nothing to act on. The learning period
supplies the missing observation:

```bash
node benchmarks/runner/run-benchmark.mjs --arm LEARNING_PERIOD --runs 5 \
  --explore-repair 2 --out LEARNING_PERIOD
```

`--explore-repair 2` is the deployment-equivalent of an operator widening a
trial: every run in that sample uses `max_attempts=2`. The sample is recorded
under its own arm label and is analysed separately — it is **never** reported as
a treatment arm beside the others, because it is a data-collection step rather
than a condition under test.

`benchmarks/results/LEARNING_PERIOD.jsonl` is committed exactly like the arm
files, so a reader can see what the store learned from.

The three-arm design is deliberate. A two-arm comparison of CONTROL against a
*learned* treatment would fold the learning cost into the treatment and hide it,
so `AUTOLOOP_FRESH` isolates "features on, nothing learned yet".

### Resource parity

Enforced and recorded, not asserted:

- one `BENCH_ROUTE` pins the route for every arm, and the route actually used is
  written into each run record and into `results/manifest.json`;
- the tool selection is minted by the production selector from the admission,
  identically for every arm;
- classification scores, allocation dimensions, timeouts and the acceptance
  test are identical per task across arms;
- **no arm receives a model, tool or budget the others cannot reach.** If that
  were violated, the run records make it visible.

### What "strategy features on" concretely changes

| Dimension | Feature | CONTROL | Treatment | Consumed by the harness? |
|---|---|---|---|---|
| `RETRY_REPAIR` | repair budget preference | `0` | store preference when evidence is sufficient, else `0` | **yes** — this is the dimension this pilot measures |
| `MODEL_ROUTING` | route preference | deployment default | store preference when sufficient, else default | **no** — every arm is pinned to one route so no arm gets a model the others cannot reach (§6) |
| `TOOL_SELECTION` | tool subset preference | full admitted subset | store preference when sufficient, else full subset | **no** — narrowing one arm's tools would change its available resources, violating resource parity |

The store observes all three dimensions (so the memory is complete and
inspectable) but the runner consumes only `RETRY_REPAIR`. That is a deliberate
scope limit of this pilot, and it is the honest reason two of the three
dimensions show no separation: **they were not exercised.**

A class whose prior runs have not cleared the production evidence floor
(`MIN_SAMPLES_FOR_SUFFICIENCY = 3`) activates **nothing** — so for that class
`AUTOLOOP_LEARNED` is identical to `CONTROL`. That is reported, not worked
around.

---

## 2. What a run actually is

Every benchmark run is a **real AutoLoop execution**, not a simulation:

1. a frozen **admission record** is built from a deterministic classification;
2. the **tool selection** is minted by the production selector against that
   admission (`projectToolSelection`), and the adapter re-validates it against
   the same lifecycle authority before any tool name reaches argv;
3. a real **`pi` subprocess** runs with `--tools <selected names>` and edits
   files on disk;
4. the **reviewer** runs as a separate role with `--no-tools` (hard-pinned), so
   it holds no mutation authority;
5. the **harness runs the acceptance test** on the resulting tree and records
   its exit code;
6. `task_success` = acceptance exit code matches the expectation **AND** the
   lifecycle verdict is `PASS`.

The agent's own claim of success is never used. Neither is the reviewer's.

### Quality control

- Acceptance is a deterministic test suite committed with each task, not a
  judgement.
- Every task's fixture is verified to **fail before** the change is made, so a
  task cannot be "passed" by doing nothing.
- No blind evaluator is used, because grading is a test exit code rather than a
  quality judgement — there is nothing for an evaluator to be biased about. The
  one exception is task `07`, where the requirement is deliberately ambiguous;
  its grading is still the test suite, so the *interpretation* is free but the
  *outcome* is not.

---

## 3. Environment

Recorded per run in `benchmarks/results/manifest.json`; re-printed with the
analysis.

| Field | Value |
|---|---|
| Node | see `manifest.json` (`node_version`) |
| Platform | see `manifest.json` (`platform`) |
| Agent runtime | `pi` (path and digest pinned by the admission contract) |
| Provider route | see `manifest.json` (`route_<ARM>`) |
| Provider cost reported | the gateway used does not report per-call cost, so `estimated_provider_cost_usd` is `0` throughout — **recorded, not estimated** |
| Sandbox | host-process isolation (Colima was **not** used for these runs; see limitations) |
| Runs per arm per task | see `manifest.json` (`runs_per_arm_per_task`) |

---

## 4. Tasks

Seven classes, each with its own fixture and acceptance suite. Full definitions:
[`benchmarks/tasks/`](../benchmarks/tasks/).

| Task | Class | Stresses |
|---|---|---|
| `01-straightforward-implementation` | `STRAIGHTFORWARD_IMPLEMENTATION` | a clear, single-function baseline |
| `02-bug-diagnosis-and-repair` | `BUG_DIAGNOSIS_AND_REPAIR` | locate a defect from a failing suite |
| `03-multi-file-change` | `MULTI_FILE_CHANGE` | thread one option through three modules |
| `04-decomposition-required` | `DECOMPOSITION_REQUIRED` | three coupled requirements simultaneously |
| `05-failure-recovery` | `FAILURE_AND_RECOVERY` | repair a first attempt that violates its contract |
| `06-context-pressure` | `CONTEXT_PRESSURE` | one defect inside a 40-export module |
| `07-route-sensitive-reasoning` | `MODEL_ROUTE_SENSITIVE` | under-specified requirement, explicit assumption |

The set is not curated toward AutoLoop's strengths: `06` and `07` in particular
are the kinds of tasks where a single-phase agent harness has no structural
advantage, and `01` is a task any competent agent should pass — so it mostly
measures noise.

---

## 5. Results

**Raw data: `benchmarks/results/*.jsonl`. Computed statistics:
`benchmarks/results/analysis.json` (regenerate with
`node benchmarks/analysis/append-analysis.mjs`).**

### Pilot run — what the committed data shows

| Sample | Repair budget | Runs | `task_success` | `hold` | median wall clock | median total tokens |
|---|---|---|---|---|---|---|
| `CONTROL` | 0 | 35 | **82.9%** (29/35) | 17.1% | 42.6 s | 20 478 |
| `AUTOLOOP_FRESH` | **0** | 35 | **97.1%** (34/35) | 2.9% | 34.3 s | 20 090 |
| `LEARNING_PERIOD` | 2 | 35 | **100%** (35/35) | 0% | 38.2 s | 20 160 |

### The control result that dominates everything else

**`CONTROL` and `AUTOLOOP_FRESH` are mechanically identical in this pilot.** The
`AUTOLOOP_FRESH` arm has the strategy machinery live, but its store is empty, so
every preference resolves to the same defaults `CONTROL` uses. Verified field by
field across all 70 runs:

| Arm-dependent field | CONTROL | AUTOLOOP_FRESH |
|---|---|---|
| `max_repair_attempts` | `0` | `0` |
| route | `merge-gateway/zai/glm-5.3-flash` | same |
| `risk` | `LOW` | same |
| `admission_id` (both tasks' scopes) | identical pair | identical pair |
| `tool_selection` / `adapter_tools` | identical | identical |
| `selection_basis` | `DERIVED_SELECTION` | same |

They differ by **5 runs**: 29/35 vs 34/35, and their medians differ by 8 s.

**Therefore a 5-run spread (≈15 percentage points) exists between two arms that
ran the same configuration.** That is the run-to-run variance of this model under
this harness, and it is the same order of magnitude as every difference reported
below. This is why the `AUTOLOOP_FRESH` arm exists, and it is the single most
important number in this document:

> **Any two-arm comparison in this pilot that reports a difference smaller than
> roughly 5 runs is reporting noise.** The published figures are not evidence of
> a treatment effect unless the mechanism is separately identified (as it is for
> the repair budget below).

Per task class:

| Task | CONTROL (b=0) | AUTOLOOP_FRESH (b=0) | LEARNING_PERIOD (b=2) |
|---|---|---|---|
| `01-straightforward-implementation` | 5/5 | 5/5 | 5/5 |
| `02-bug-diagnosis-and-repair` | 5/5 | **4/5** | 5/5 |
| `03-multi-file-change` | 5/5 | 5/5 | 5/5 |
| `04-decomposition-required` | 4/5 | 5/5 | 5/5 |
| `05-failure-recovery` | 5/5 | 5/5 | 5/5 |
| `06-context-pressure` | **1/5** | **5/5** | 5/5 |
| `07-route-sensitive-reasoning` | 4/5 | 5/5 | 5/5 |

Note how the same task moves without any treatment: `06-context-pressure` is
1/5 under `CONTROL` and **5/5 under the identical `AUTOLOOP_FRESH`
configuration**, and `02` moves the other way. Task-level differences of this
size are the variance described above, not capability differences."

### The one effect that IS identified

| Evidence | CONTROL | AUTOLOOP_FRESH | LEARNING_PERIOD |
|---|---|---|---|
| Repair budget | 0 | 0 | 2 |
| Runs the budget **refused** (`REPAIR_BUDGET_EXHAUSTED`) | 5 | 0 | 0 |
| Runs that actually **used** a repair | 0 | 0 | 1 |
| Runs that failed for a non-repairable reason (`MUTATION_SCOPE_VIOLATION`) | 1 | 1 | 0 |

`AUTOLOOP_FRESH` shows the mechanism cleanly: with the budget still `0`, it had
**5 fewer `REPAIR_BUDGET_EXHAUSTED` refusals than `CONTROL`** — because those 5
runs happened to pass on the first attempt. The budget did not change; the model
did.

The identified effect is therefore about *capability*, not outcome: **a repair
budget of 0 converts "the reviewer asked for a repair" into a hard refusal.**
A budget of 2 permits the retry. Whether the retry succeeds is up to the work —
in this pilot exactly one run needed it, and it succeeded.

### The honest attribution — read this before quoting the table

The `LEARNING_PERIOD` sample shows a 17-point gap over `CONTROL`. **Most of it is
not attributable to the higher repair budget** — the mechanically-identical
`AUTOLOOP_FRESH` arm already spans most of that gap with budget 0.

**Conclusion: the only mechanism this pilot identifies is that a repair budget
of 0 is a hard refusal. Every success-rate comparison in the table above is
dominated by model variance, and the `AUTOLOOP_FRESH` arm demonstrates that
empirically rather than asserting it.**

This is precisely the case §12 warns about. The arm that was added to guard
against it is what produced the finding.

Reported per arm and per task class:

| Quantity | Reported as |
|---|---|
| `task_success`, `first_pass`, `hold` | proportion with sample size, plus absolute and relative difference vs baseline |
| `wall_clock_ms`, `input_tokens`, `output_tokens`, `total_tokens`, `context_occupancy`, `model_call_count`, `repairs`, `executor_attempts`, `reviewer_attempts` | count, mean, median, standard deviation, p25, p75, min, max |
| `estimated_provider_cost_usd` | sum, with the caveat that this route reports none |

The analysis deliberately computes **no composite score**. A single synthetic
number would let an unfavourable metric be averaged away.

### Confidence intervals

A 95% CI is reported only where it is defensible:

- proportion: Wald interval, reported only for **n ≥ 10**;
- mean difference: Welch interval, reported only when **both** arms have n ≥ 10.

Below those thresholds the tool emits an explicit
`interval omitted (… not defensible)` note instead of approximating. **At the
pilot's sample size most intervals are omitted.** That is the honest state of
the evidence, and it is why this document does not make claims of the form
"AutoLoop improves X by Y%".

### Negative results

Published with the same prominence as positive ones. The analysis tool prints
an explicit list of adverse deltas (lower success rate, higher latency, more
tokens) for every arm. If a class regressed under treatment, it appears in that
list and is not removed from the task set.

No result from a class has been excluded for being unflattering.

---

## 6. Model routing effect

> **NOT MEASURABLE IN THE PILOT.** Recorded so the gap is explicit, not so it
> can be inferred around.

Task class × selected route × outcome × tokens × latency × repair rate.

**In the environment this pilot ran in, only one of the two supported routes
was reachable** (the other requires a credential this environment did not
have). Therefore:

- both arms ran on the same route by construction;
- the routing dimension has a single observable value, so
  `evidence_sufficient` per value is trivially reached (3+ samples of the same
  value) and the learned preference selects that same value;
- **the model-routing effect is NOT measurable in this pilot.** Any claim that
  AutoLoop "routes better" would be unsupported by this data.

To measure routing you need two reachable routes and enough runs per
(task class × route) to compare them. The harness supports it: set
`BENCH_ROUTE` per arm, and record it — the manifest and the per-run records
make the route identity explicit precisely so such a comparison stays honest.

---

## 7. Retry/repair effect

**The effect identified by this pilot is about capability, not outcome**: a
repair budget of `0` is a hard refusal (`REPAIR_BUDGET_EXHAUSTED`), and a
non-zero budget permits the retry. Measured:

| | CONTROL (b=0) | AUTOLOOP_FRESH (b=0) | LEARNING_PERIOD (b=2) |
|---|---|---|---|
| budget-refused runs | 5/35 | 0/35 | 0/35 |
| runs that used a repair | 0 | 0 | 1 |
| task_success | 29/35 | 34/35 | 35/35 |

The `AUTOLOOP_FRESH` column is what makes this readable: facing the *same*
budget of 0, it recorded 0 refusals because its runs happened to pass — the
model differed, not the policy. So the refusal count is not a treatment effect
either; it is downstream of the same variance.

**What IS firmly established: with budget 0, a reviewer repair request cannot be
actioned.** Across both budget-0 samples (70 runs), exactly 5 runs reached a
repair request and all 5 were refused — `AUTOLOOP_FRESH` recorded 0 refusals
because 0 of its runs reached one. The determinism here is structural: the code
path returns `REPAIR_BUDGET_EXHAUSTED` whenever `attempt >= maxRepairAttempts`
with `maxRepairAttempts = 0`. It is independent of the model, which is why this
is the one claim in this document that does not depend on sample size.

What the pilot could NOT establish, because it never happened enough:

- whether repair attempts recover a failing first pass (n=1);
- wasted retries (repairs with no success change);
- the latency and token cost of those retries;
- whether HOLD-rate falls.

How the dimension is exercised:

| Sample | Repair budget | Role |
|---|---|---|
| `CONTROL` | 0 | baseline |
| `LEARNING_PERIOD` | 2 | explores an alternative so the memory observes both values |
| `AUTOLOOP_FRESH` | store empty → 0 | treatment with nothing learned |
| `AUTOLOOP_LEARNED` | store preference | treatment reading what the memory selected |

The store selects per task class by success rate, then fewest repairs. In the
pilot the control's `0` budget outperformed the learning period's `2` on repair
count and latency where both were observed, so the honest reading is that the
memory chose to KEEP the cheaper setting — a null effect for this dimension,
produced by the mechanism rather than imposed on it.

**This pilot does not establish that learned retry/repair improves outcomes.**
It shows the machinery selecting between two observed values and preferring the
one with better measured outcomes.

---

## 8. Learning effect

> **NOT MEASURED IN THE PILOT.** `AUTOLOOP_LEARNED` was not run — see §10 for
> why, and what is committed instead. The section below describes the design and
> the machinery, both of which are implemented and tested; it is not a report of
> a measurement.

The learning effect is `AUTOLOOP_LEARNED` vs `AUTOLOOP_FRESH` — both have the
machinery live; only accumulated memory differs.

How the learned store was built (`benchmarks/runner/build-learned-store.mjs`),
which is exactly what the production attribution feed does:

1. prior run records → attribution records (bounded, secret-free projection);
2. attribution → strategy observations, idempotent by run identity;
3. observations → per (task class × dimension × value) summaries;
4. a preference is activated **only** where `evidence_sufficient` is true;
5. the activation is recorded with its sample count and success rate.

The builder consumed BOTH the control sample and the learning-period sample,
because a deployment's memory sees all eligible runs, not one arm's.

Bounded parameters come from `BOUNDED_STRATEGY_PARAMS`
(`src/evolution/strategy-store.mjs`): `MODEL_ROUTING` takes a supported route,
`RETRY_REPAIR` takes an integer `max_attempts` in 0..5, `TOOL_SELECTION` takes
a canonical tool-id set. An out-of-schema value is refused
(`EVOLUTION_STRATEGY_OUT_OF_BOUNDS`) rather than clamped.

Because the evidence floor is 3 samples and the pilot supplies a small number
of prior runs per class, **some classes activate nothing and the learned arm is
identical to fresh for them.** The builder reports which classes those are
(`refused_activation` in its output) rather than lowering the floor.

---

## 9. Limitations

Stated plainly. These bound what the numbers can support.

1. **Sample size — and the variance it exposes.** Single-digit runs per arm per
   task class. Confidence intervals are therefore omitted. More importantly,
   the `CONTROL` vs `AUTOLOOP_FRESH` comparison MEASURED the variance: two
   mechanically identical configurations differed by 5 of 35 runs (~15 points).
   Treat any smaller difference as noise.
2. **One route.** Only one supported provider route was reachable, so the
   model-routing dimension is unmeasured (§6).
3. **No sandbox.** These runs used host-process isolation, not Colima. AutoLoop's
   sandboxed path has extra latency and different failure modes that this pilot
   does not capture.
4. **One provider, one model family.** Results are not transferable to another
   model.
5. **Provider nondeterminism.** The served model is not byte-identical run to
   run, and may change between dates. A rerun will not reproduce identical
   numbers; the manifest records the identity so divergence can be attributed.
6. **Task set breadth.** Seven synthetic tasks in one language, each small
   enough to fit comfortably in context. Real work is larger and messier.
7. **`01` is noise-dominated.** A task any competent agent passes measures
   variance more than capability.
8. **Single-phase execution.** These tasks run one phase, so the fan-out,
   decomposition and rollover machinery is **not exercised**. A result here says
   nothing about multi-phase work, where the structural argument for AutoLoop is
   strongest — and which this pilot therefore does not test.
9. **No cost signal.** The gateway reports no per-call cost, so
   `estimated_provider_cost_usd` is 0 and cost cannot be compared.
10. **The learned arm is a heuristic.** Selecting the best value by
    success-rate-then-repairs is a heuristic, not a statistically justified
    choice.

---

## 10. Reproduction

Raw data and the exact configuration are committed:

```
benchmarks/results/manifest.json           environment, routes, sample sizes, run history
benchmarks/results/<ARM>.jsonl             one JSON object per run, all metrics + adapter trace
benchmarks/results/analysis.json           the computed statistics
benchmarks/results/provenance.json         which raw file contributed how many runs
benchmarks/results/learned-strategy-store/ the strategy store the learned arm read
```

`AUTOLOOP_LEARNED` was **not** run in the pilot: the two treatment-adjacent
samples (`AUTOLOOP_FRESH` with an empty store, `LEARNING_PERIOD` with an
exploration value) already separate the mechanism from the variance, and the
store can only activate a preference it has observed — which at 5 runs per class
means `AUTOLOOP_LEARNED` behaves like one of the two samples already measured.
Running it is the obvious next step; the command above is ready.

To reproduce:

```bash
export BENCH_ROUTE=<route from manifest.json>       # your own credential
export AUTOLOOP_PI_RUNTIME_PATH="$(command -v pi)"

# 1. CONTROL — the baseline (repair budget 0)
node benchmarks/runner/run-benchmark.mjs --arm CONTROL --runs <n from manifest>

# 2. LEARNING_PERIOD — an exploration sample that observes an alternative value
node benchmarks/runner/run-benchmark.mjs --arm LEARNING_PERIOD --runs <n> \
  --explore-repair 2 --out LEARNING_PERIOD

# 3. AUTOLOOP_FRESH — the variance control: identical to CONTROL by construction
node benchmarks/runner/run-benchmark.mjs --arm AUTOLOOP_FRESH --runs <n> \
  --store /tmp/empty-strategy-store --out AUTOLOOP_FRESH

# 4. AUTOLOOP_LEARNED — treatment reading the learned store
node benchmarks/runner/build-learned-store.mjs --from benchmarks/results/LEARNING_PERIOD.jsonl \
  --store benchmarks/results/learned-strategy-store
node benchmarks/runner/build-learned-store.mjs --from benchmarks/results/CONTROL.jsonl \
  --store benchmarks/results/learned-strategy-store
node benchmarks/runner/run-benchmark.mjs --arm AUTOLOOP_LEARNED --runs <n> \
  --store benchmarks/results/learned-strategy-store

# 5. analysis (regenerates results/analysis.json + provenance.json)
node benchmarks/analysis/append-analysis.mjs
```

Measurement definitions:

| Metric | Definition |
|---|---|
| `task_success` | acceptance test exit code == expected **and** lifecycle verdict == PASS |
| `first_pass` | `task_success` with zero repair transitions |
| `hold` | lifecycle verdict == HOLD |
| `repairs` | count of repair-phase transitions |
| `wall_clock_ms` | process wall clock for the whole run, fixture setup included |
| `input_tokens` / `output_tokens` | provider-reported, summed over both roles |
| `context_occupancy` | provider-reported total tokens per call |
| `model_call_count` | number of completed adapter invocations reporting usage |
| `scope_clean` | every changed path is inside the admitted mutation scope |

Analysis method: `benchmarks/analysis/analyze.mjs` — descriptive statistics and
proportions; Welch CI for mean differences; Wald CI for proportions; both only
above n ≥ 10. No composite score, no p-hacking surface, no task-class removal.

---

## 11. Claim discipline

The README summarises this benchmark only in the form the data supports:

> In our benchmark under the recorded configuration, … across N runs.

Any sentence of the form "AutoLoop improves agent performance" is **not**
supported by this pilot and does not appear in this repository.
