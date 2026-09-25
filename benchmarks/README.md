# AegisFlow effectiveness benchmark

A reproducible measurement of what AegisFlow's strategy/evolution features
actually change, comparing the same tasks, the same agent runtime, the same
provider route and the same acceptance criteria across three arms.

**The purpose is not to show AegisFlow wins.** It is to produce an honest,
reproducible, publishable measurement — including where AegisFlow loses.

```
benchmarks/
  README.md                 this file: how to run it and what it measures
  tasks/*.json              7 task definitions (self-contained fixtures + acceptance tests)
  runner/
    run-benchmark.mjs       executes the arms, writes results/*.jsonl
    build-learned-store.mjs turns prior runs into the learned arm's strategy store
  analysis/analyze.mjs      statistics over the raw results
  results/                  raw output (manifest.json + one .jsonl per arm)
```

See [../docs/benchmark.md](../docs/benchmark.md) for the methodology write-up
and the published results.

## The three arms

| Arm | Strategy features | What it is |
|---|---|---|
| `CONTROL` | **off** | deployment-default route, fixed repair budget, full admitted tool subset |
| `AUTOLOOP_FRESH` | on, no accumulated memory | treatment at T0: the machinery is live but has learned nothing |
| `LEARNING_PERIOD` | — (exploration sample) | not an arm that is compared: a sample that *explores* an alternative strategy value so the store has evidence to learn from |
| `AUTOLOOP_LEARNED` | on, with a populated store | treatment at T1: after a learning period |

`AUTOLOOP_FRESH` exists so a "treatment is worse" result can be attributed
honestly. If the features need a learning period to help, comparing only
CONTROL against a *learned* arm would hide that cost.

**Resource parity is enforced.** Every arm uses the same route (pinned with
`BENCH_ROUTE`), the same allocation, the same classification, and the same
timeout. The route actually used is recorded per run and in the manifest, so a
reader can verify no arm received a better model.

## What each run actually does

A benchmark run is a **real AegisFlow execution**:

1. a frozen **admission record** is built from a classification;
2. the **tool selection** is minted by the production selector against that
   admission;
3. a real **`pi` subprocess** runs with `--tools <selected>` — the agent edits
   files on disk;
4. the **harness runs the acceptance test** on the resulting tree;
5. `task_success` is the **test exit code AND** the lifecycle verdict — never
   the agent's claim, never the reviewer's.

The reviewer role runs with `--no-tools` (hard-pinned), so a reviewer cannot
mutate anything.

## Running it

Prerequisites differ by route. For the gateway route used in the published
pilot:

```bash
export MERGE_GATEWAY_API_KEY=...                  # your own credential; never committed
export BENCH_ROUTE=merge-gateway/zai/glm-5.3-flash
export AEGISFLOW_PI_RUNTIME_PATH="$(command -v pi)"   # optional if pi is on PATH
```

Then:

```bash
# 1. Control arm — the baseline, strategy features OFF
node benchmarks/runner/run-benchmark.mjs --arm CONTROL --runs 5

# 2. Learning period — a SEPARATE sample that explores an alternative strategy
#    value, so the fitness gate has something to compare. Without this step a
#    store can only ever observe the value already in use, and no candidate can
#    ever be proposed (an honest outcome, but not an experiment).
node benchmarks/runner/run-benchmark.mjs --arm LEARNING_PERIOD --runs 5 \
  --explore-repair 2 --out LEARNING_PERIOD

# 3. Build the learned store from the other two samples
node benchmarks/runner/build-learned-store.mjs \
  --from benchmarks/results/LEARNING_PERIOD.jsonl \
  --store benchmarks/results/learned-strategy-store
node benchmarks/runner/build-learned-store.mjs \
  --from benchmarks/results/CONTROL.jsonl \
  --store benchmarks/results/learned-strategy-store

# 4. Treatment arms
node benchmarks/runner/run-benchmark.mjs --arm AUTOLOOP_FRESH --runs 5
node benchmarks/runner/run-benchmark.mjs --arm AUTOLOOP_LEARNED --runs 5 \
  --store benchmarks/results/learned-strategy-store

# 5. Analysis (regenerates results/analysis.json + provenance.json)
node benchmarks/analysis/append-analysis.mjs
```

**A run refuses to overwrite an existing `<ARM>.jsonl`.** A re-run of the same
arm is a different sample; use `--append` to add to it or `--out <name>` to
write elsewhere. This is why the learning period is a named arm rather than a
second CONTROL run.

Useful flags:

| Flag | Effect |
|---|---|
| `--all` | run every arm in one invocation |
| `--runs N` | runs per arm per task (default 5) |
| `--task 03` | restrict to task ids matching a prefix |
| `--store DIR` | strategy store the treatment arms read |
| `--explore-repair N` | run this arm as a learning period with repair budget N |
| `--out NAME` | write to `results/NAME.jsonl` |
| `--append` | add to an existing arm file instead of refusing |
| `--help` | print usage |

## Task set

Seven task classes, chosen so that different capabilities are stressed and so
that AegisFlow is **not** only measured on things it is good at:

| Task | Class | What it stresses |
|---|---|---|
| `01-straightforward-implementation` | `STRAIGHTFORWARD_IMPLEMENTATION` | baseline: one function, clear contract |
| `02-bug-diagnosis-and-repair` | `BUG_DIAGNOSIS_AND_REPAIR` | read the code, find the defect, fix it |
| `03-multi-file-change` | `MULTI_FILE_CHANGE` | thread one option through three modules |
| `04-decomposition-required` | `DECOMPOSITION_REQUIRED` | three coupled requirements at once |
| `05-failure-recovery` | `FAILURE_AND_RECOVERY` | repair a first attempt that violates the contract |
| `06-context-pressure` | `CONTEXT_PRESSURE` | find one defect inside a large module without disturbing the rest |
| `07-route-sensitive-reasoning` | `MODEL_ROUTE_SENSITIVE` | under-specified requirement; state the assumption, satisfy the tests |

Each task ships its own git-less fixture (files are materialised into a fresh
temp repo per run) and its own acceptance test. Nothing in a task definition
names a private path, endpoint, or credential.

## Metrics collected per run

`task_success`, `first_pass`, `hold`, `repairs`, `executor_attempts`,
`reviewer_attempts`, `wall_clock_ms`, `input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_write_tokens`, `total_tokens`,
`context_occupancy`, `model_call_count`, `estimated_provider_cost_usd`,
`changed_paths`, `scope_clean`, plus the tool selection and the raw adapter
trace (status, terminal reason, argv tools, provider usage).

`estimated_provider_cost_usd` is provider-reported and is `0` for routes whose
gateway does not report cost. That is recorded rather than estimated.

## Interpreting the results

Read [../docs/benchmark.md](../docs/benchmark.md). Two things matter most:

- **Sample size is stated for every number.** The analysis tool refuses to
  produce a confidence interval below n=10 rather than approximating one, so a
  thin sample looks thin in the report.
- **Negative results are published.** If the treatment is slower, spends more
  tokens, or succeeds less often, that appears in the report and in the README
  summary. Removing an unfavourable task class would invalidate the whole
  exercise.

## Reproducing the published run

The published pilot's raw records and manifest are committed under
`benchmarks/results/`. Reproduce with:

```bash
export BENCH_ROUTE=<the route named in results/manifest.json>
node benchmarks/runner/run-benchmark.mjs --arm CONTROL --runs <n from manifest>
# …and the other arms, then:
node benchmarks/analysis/analyze.mjs
```

Expect **different absolute numbers**: the model served by a provider is not
byte-identical run to run, and a different date may mean a different model
revision. The manifest records the node version, platform, route and sample
size so a divergence can at least be attributed.
