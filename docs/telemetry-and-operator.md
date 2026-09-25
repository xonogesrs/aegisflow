# Telemetry and the operator surface

Telemetry answers "what happened during this run". It is **observability**, and
the codebase keeps that strictly separate from **authority** — the separation is
a fence, not tidiness.

## The separation rule

Everything under the telemetry namespace is observability (retention classes
R1/R2). Everything under the evidence namespace is authority (R3/R4). They are
disjoint by construction, and the resolver enforces it:

- the default telemetry root is a **sibling** of the evidence root, never
  inside it;
- configuring a telemetry root *inside* the evidence root fails with
  `AUTOLOOP_TELEMETRY_INSIDE_EVIDENCE`;
- the GC planner refuses an evidence-root-crossing namespace
  (`GC_ARBITRARY_ROOT_DELETE`).

Why it matters: telemetry can be disabled, truncated, or GC'd without touching
authority. If telemetry were the same namespace, a retention sweep could delete
the record a review depended on.

## Telemetry is never a task authority

A resolution failure is an ordinary error the caller surfaces as
`TELEMETRY_UNAVAILABLE`. It cannot change any task semantic, block a phase, or
alter a verdict. Losing telemetry degrades *your ability to inspect*, never the
run's correctness.

## The event stream

`src/telemetry/store.mjs` is an append-only chunked store:

| Property | Behaviour |
|---|---|
| Rotation | the active chunk rotates at a byte/event cap; rotated chunks are kept as `telemetry-N.jsonl` |
| Validation on read | every recorded event is re-validated; a corrupt or contract-invalid row **fails the store closed** rather than being skipped |
| Secret scanning | every event is scanned before it is written; a hit is a HOLD |
| Bounded reads | the operator report stops at chunk and byte limits and degrades availability to `PARTIAL` rather than reading without bound |
| Append cost | rotation accounting is O(1) per append — the store does not re-read the active chunk to decide when to rotate |

### Retention classes

Every persistent surface is assigned exactly one class, and the assignment is
total (a test asserts no surface is unassigned):

| Class | Meaning | GC |
|---|---|---|
| R0 | scratch, reclaimable | eligible |
| R1 | active stream | eligible after rotation |
| R2 | rotated / secondary | eligible |
| R3 | **authority** | protected |
| R4 | **archive** | protected |

The per-surface assignment lives in `TELEMETRY_RETENTION_ASSIGNMENT`
(`src/telemetry/location.mjs`) as a code mirror of the frozen contract.
`retentionClassFor` fails closed on an unknown surface — a new persistent
surface cannot be silently unclassified.

## GC

`src/telemetry/gc.mjs` plans and executes sweeps with an explicit namespace
admission:

1. the canonical run-scoped root for a `graphRunId`, or
2. the telemetry root itself (namespace-wide, each child still validated), or
3. an explicitly admitted temporary namespace.

Anything else fails closed. Deletion is idempotent: re-executing a plan after a
partial run is safe, and an already-missing candidate replays without error.
Prior-snapshot sweeps inside a durable execution directory only touch snapshots
beyond the bounded keep window, and only after a terminal verdict.

## The operator surface

Two read-only CLIs. Both perform **zero writes**, and no production authority
consumes their output.

### Run inspection

```bash
node scripts/aegisflow-operator.mjs --run <graphRunId>
node scripts/aegisflow-operator.mjs --run <graphRunId> --json
```

Reports:

| Section | Contents |
|---|---|
| status | the run's observed lifecycle status, or `UNKNOWN` |
| phases | per-phase outcomes and ordering |
| rollover | generation transitions and successor linkage |
| provider usage | model calls and token occupancy |
| diagnostics | explicit codes for anything missing or degraded |

Diagnostics worth knowing:

| Code | Meaning |
|---|---|
| `NO_TELEMETRY_ROOT` | no telemetry namespace exists for this run (e.g. telemetry was disabled) |
| `READ_BOUNDS_EXCEEDED` | the report hit its read limits and stopped |
| retention gaps | GC'd rotated chunks are reported as gaps, never as "no events" |
| torn / malformed rows | surfaced explicitly, never silently dropped |

The governing rule: **absence is never fabricated as failure, and presence is
never fabricated as success.** An unknown run reports `UNKNOWN`.

The human and machine views come from the same aggregate
(`aggregateGraphRun`), so `--json` and the console output cannot disagree.

### Evolution inspection

```bash
node scripts/evolution-operator.mjs --json
node scripts/evolution-kill-switch.mjs --store <dir> --status
```

See [autonomous-evolution.md](autonomous-evolution.md).

## The execution review surface

Separate from telemetry: a human-facing entrypoint for the latest **formal
execution**'s review.

```bash
node scripts/gov-execution-review.mjs --status
```

It reads a fixed surface (`AEGISFLOW_EXECUTION_REVIEW_SURFACE`) where the most
recent execution review is published and previous ones rotate into an archive.
This is a different question from "is a card awaiting external review" — a
pending external-review inbox occupant never blocks the latest execution
review, and vice versa. Conflating the two was a real defect class; they are
distinct domains in the code.

## Reading telemetry safely

Three hazards, and what the code does about them:

1. **Unbounded reads.** A retained stream can be large. Bounded chunk/byte
   limits apply, and exceeding them degrades to `PARTIAL` with an explicit code
   rather than reading everything.
2. **Symlink escape.** A symlinked chunk is not followed
   (`L3` in the security suite).
3. **Secrets in events.** Events are scanned on write and on read; a hit is a
   HOLD naming the pattern class, never a warning.

The frozen contract for all of this is
[governance/autoloop-s16-telemetry-authority-location-and-retention-contract.md](governance/autoloop-s16-telemetry-authority-location-and-retention-contract.md).
