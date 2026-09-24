# Cross-agent learning

AutoLoop can carry measured experience from one agent execution to the next.
This is the least mature capability in the project; this document states what it
does, what it refuses to do, and where it should not be trusted yet.

## The flow

```
Agent A / Agent B execution evidence
        │  attribution feed (every eligible run, always on)
        ▼
   performance memory
        │  per (task class × strategy dimension × value):
        │  success_rate, hold_rate, repair_rate, latency, occupancy, fan-out,
        │  sample count, confidence, evidence_sufficient
        ▼
   strategy fitness
        │
        ▼
   Agent C's effective strategy   — only when the evidence clears the floor
```

## 1. Attribution: what is observed

Every eligible run writes a performance row keyed by
`(task class, strategy dimension, value)`, recording whether the run succeeded,
whether it HOLD'd, how many repairs it needed, latency, token occupancy,
fan-out, and the instant.

The row is **secret-free by construction**: the projection copies only bounded
identifiers, digests, enums and numbers from the source. No prompt text, no
model output, no credential. This is a field-projection guarantee, not a filter
that might miss a pattern.

An observation that cannot be attributed — no run identity, no phase identity,
no task class — is not admitted. Unattributable observations are how folklore
enters a system.

## 2. Performance memory: what makes a number count

`src/evolution/strategy-memory.mjs` aggregates rows per
(task class × dimension × value):

| Field | Meaning |
|---|---|
| `samples` | how many observations back this row |
| `success_rate`, `hold_rate`, `repair_rate` | rates over those samples |
| `latency_avg_ms`, `occupancy_avg`, `fanout_avg` | means |
| `evidence_sufficient` | `samples >= MIN_SAMPLES_FOR_SUFFICIENCY` (3) |
| `min_samples_required` | reported alongside, so a consumer never has to know the constant |
| `confidence` | saturating function of sample count |
| `last_observed_at` | freshness |

**`evidence_sufficient` is the gate that matters.** Below it, the row is
recorded and visible, but it does not license a strategy change. One lucky run
changes nothing — that is the design intent, and it is why small deployments
will see little effect.

Memory is idempotent by run identity: replaying the same run does not
double-count it.

## 3. Fitness and transfer

Fitness compares strategy values for the same task class using the memory
above, and only considers values whose evidence is sufficient. A transfer is
the act of making a value that performed well for one class — or for one agent
instance — the starting strategy for a future run of that class.

The authority boundary is the crucial part:

- **the feed mints no authority.** It writes advisory performance memory;
- nothing consumes that memory without a *separate* policy authorization and a
  promotion gate (see [autonomous-evolution.md](autonomous-evolution.md));
- the memory can only influence dimensions the operator's issued policy
  declares, and only at LOW risk.

So "cross-agent learning" never means a run silently adopts another run's
behaviour. It means a measurement is available, and a governed decision may
later act on it.

## What is measured, exactly

| Dimension | What a value means |
|---|---|
| `MODEL_ROUTING` | which supported model route was selected for a task class |
| `DECOMPOSITION` | how the task was split into phases |
| `CONTEXT_ALLOCATION` | how much context budget went where |
| `RETRY_REPAIR` | retry and repair policy for a failure class |
| `FANOUT_PARALLELISM` | how wide the graph fanned out |
| `TOOL_SELECTION` | which tool subset a node was granted |
| `PROMPT_EVOLUTION` | prompt/instruction strategy (**MEDIUM — operator promotion only**) |

## Honest limitations

Read these before quoting anything from this subsystem:

- **EXPERIMENTAL.** The measurement plumbing is tested; the strategy layer's
  interfaces may change.
- **The evidence floor is 3 samples.** Statistically that is very thin. It is a
  floor against acting on a single run, not a confidence bound. Treat a
  transfer as a hypothesis.
- **Task classes are coarse.** `(task class × dimension × value)` can conflate
  materially different work. A better-performing route for a class may be an
  artefact of which tasks landed in it.
- **Correlation, not causation.** If a route wins, the win may be a property of
  the tasks assigned to it rather than of the route.
- **No cross-machine sharing.** Memory is local. Two machines learn separately.
- **Whatever you do, do not read it as a performance claim about AutoLoop.**
  That is what [benchmark.md](benchmark.md) is for, and it reports its own
  sample sizes and negative results.

## Inspecting it

The evolution operator view exposes the strategy performance memory and the
attribution feed, including feed failures:

```bash
node scripts/evolution-operator.mjs --json
```

Read-only, zero writes, no production authority consumes its output.

## Related

- [autonomous-evolution.md](autonomous-evolution.md) — the policy, trigger,
  promotion and rollback machinery that gates any use of this memory
- [telemetry-and-operator.md](telemetry-and-operator.md) — the observability
  surface this data comes from
- [benchmark.md](benchmark.md) — end-to-end effectiveness measurement
