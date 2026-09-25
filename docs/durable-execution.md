# Durable execution

AegisFlow's durability is in-process plus local filesystem. There is no external
workflow server, no database tier, and no consensus protocol — and that is a
deliberate choice, not a missing feature.

## Why not a workflow engine

AegisFlow's graph model is a bounded DAG of phases with no durable timers, no
signals, and no cross-restart sleeps. A workflow engine would add a server
process, a database, network listeners, a worker lifecycle, and workflow
versioning — in exchange for automatic re-dispatch that AegisFlow does not
currently need.

That trade was measured rather than assumed. A live bake-off ran a candidate
external engine against AegisFlow's own durable layer under the same SIGKILL
failure classes. The external engine recovered automatically, which is a real
advantage — but it re-executed the whole writer activity after a mid-activity
kill and duplicated a committed side effect unless the application added an
idempotency pattern. AegisFlow's already-fail-closed writer (zero duplicates
under the tests) had no such gap. The conclusion recorded was to harden the
in-process layer rather than adopt a server.

You can re-run that evaluation yourself if your workload differs — see
"Evaluation lane" below.

## The four durable primitives

### 1. Append-only journal

Every state transition appends a row to a per-execution journal, chained by
digest. Reading it validates the chain:

- a tampered row fails validation (`JOURNAL_CHAIN_INVALID`);
- a reordered or truncated chain fails;
- a gap is reported, never silently repaired.

The journal is the tie-breaker whenever a checkpoint and reality disagree.

### 2. Checkpoints

State is published to a checkpoint atomically (write-temp + rename), digest-bound
to the journal head it reflects. A checkpoint that does not correspond to the
journal head is rejected on load — so a crash *between* journal and checkpoint
produces a detectable, named condition rather than a silent skip.

### 3. Evidence artifacts

Artifacts (implementation evidence, review bundles, system deltas, manifests)
are written **exclusive-create**, secret-scanned, and size-bounded. A scanner
hit or an oversize payload is a HOLD, not a warning. Artifact identity is
content-addressed: the digest is the name.

### 4. Resume

`resumeDurableGraph` / `resumeSubagentGraph` re-derive state and re-verify
every artifact digest before continuing. Any mismatch is a specific HOLD:

| Condition | Result |
|---|---|
| checkpoint digests disagree with journal | `RESUME_FINGERPRINT_MISMATCH` |
| artifact bytes differ from their recorded digest | HOLD naming the artifact |
| identity in the artifact is not this run's | `HARNESS_EVIDENCE_IDENTITY_MISMATCH` |
| journal chain broken | HOLD (no gap repair) |
| permitted-dirty set drifted | HOLD (never guess) |

Resume never "proceeds anyway". If AegisFlow cannot prove it is resuming the
same work, it stops.

## Crash recovery at a writer boundary

The hardest case: the process dies mid-write, after a side effect is committed
but before the successor phase is scheduled. AegisFlow handles it by classifying
from durable truth rather than guessing:

- a **writer side-effect identity** is deterministic and per-phase, so a
  re-execution can be recognised as the same logical effect;
- an **interrupted writer** is classified from the journal and checkpoint
  (`classifyInterruptedWriter`) — never inferred from a missing file;
- a duplicate commit is prevented by that identity, not by hoping the write was
  idempotent.

## Generation identity and rollover

A run can outlive one agent session. Rollover gives the successor session an
explicit **generation**, and generation identity fences stale actors:

- a stale generation's result is not a consumption event;
- an in-flight handover produces
  `CROSS_SESSION_ROLLOVER_IN_PROGRESS_*`, which is a HOLD, not a wait;
- the successor reconstructs state from artifacts, never from the
  predecessor's transcript.

Rollover is `EXPERIMENTAL` — it is the newest part of the system, and its
behaviour under adversarial timing is what the sandbox suite probes hardest.

## Retention and GC

Every persistent surface has exactly one retention class (R0–R4):

| Class | Meaning |
|---|---|
| R0 | scratch; reclaimable |
| R1 | active stream |
| R2 | rotated / secondary |
| R3 | authority — GC-protected |
| R4 | archive — GC-protected |

Authority artifacts are R3/R4 and are never GC'd by telemetry retention.
Retention classes separate *observability* from *authority*, and the namespace
separation is enforced: a telemetry root inside the evidence namespace is
rejected outright.

## What this model does not survive

Being explicit, because durability claims are easy to overstate:

- **disk loss** — there is no replication. Back up your evidence root.
- **multi-machine splits** — durability is local. A second machine is a second
  independent store, not a replica.
- **concurrent writers on one execution** — a single-writer lease is assumed
  and enforced; a second writer is a HOLD, not a merge. The primitives are
  `src/c2d/repository-mutation-lock.mjs` (repository-level mutation) and
  `src/c2d/lock.mjs` (the structured-lock primitive it and the sandbox profile
  lock both use). Cross-machine contention is `NOT_PROVEN_SAFE`: a lock held by
  a different host is never reclaimed, it is escalated to an operator.
- **wall-clock correctness** — ordering comes from the journal, not from
  timestamps. A clock that moves backwards does not corrupt ordering, but it
  does make latency telemetry misleading.

## Reproducing the evaluation

The bake-off used the Temporal TypeScript SDK. That harness is internal
operational tooling and is **not** part of this repository: no source file
imports `@temporalio/*`, and it appears in neither `package.json` nor the
lockfile. It is mentioned here only so the design decision is auditable.

If your workload differs, reproduce it yourself:

1. install the SDK in a scratch directory of your own;
2. drive the same failure classes against both implementations — kill the
   process inside a phase, between a committed side effect and the successor
   being scheduled, and during state publication;
3. measure what actually matters to you: lost results, duplicated side
   effects, and the operational surface you have to run.

The honest summary of the recorded run: the external engine was **better at
automatic recovery** (re-dispatch plus deterministic replay, zero lost results)
and **worse at exactly-once side effects** (a mid-activity kill re-executed the
whole writer activity unless the application added an idempotency pattern),
while adding a server process, a database, three network listeners and a worker
lifecycle. Your trade-off may differ; the measurement is what should decide it.

## Where to go next

- [architecture.md](architecture.md) — where durability sits in the flow
- [operations.md](operations.md) — inspecting and recovering a real run
- [troubleshooting.md](troubleshooting.md) — the HOLD codes you will meet
